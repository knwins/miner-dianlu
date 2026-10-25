/**
 * 官方晶体管市价。
 *
 * ════════════════════════════════════════════════════════════════
 * 主源：链上晶体管市场的**未成交买单**（`nextBidId()` + `bids(id)`，纯 eth_call）。
 * 兜底：链上成交事件（单窗口 getLogs）→ 官方站点 market.json（同源反代 /tt-api）
 *      → 静态基准。
 * ════════════════════════════════════════════════════════════════
 *
 * 为什么主源走链上、而不是只拉 market.json：
 *   - market.json 经 Vite 代理 /tt-api 转发，但 vite build 产物不含该代理，
 *     生产静态托管时若没配反代，/tt-api/* 直接 404（M-2 已知风险）。
 *   - 晶体管市场本身是公开的：买单挂在链上，`bids(id)` 就能读到「晶体管合约 +
 *     tokenId + 单价 + 剩余量」，不需要任何索引服务。
 *
 * 为什么读挂单、而不是扫成交事件（2026-10-23 改）：
 *   - 晶体管市场**只有买单侧**（`nextAskId()` 直接 revert），Owner 是卖方，
 *     他要卖就得吃别人的买单 —— 所以真正相关的价是「当前最高的未成交买价」，
 *     而不是稀疏的历史成交价。
 *   - 成交极稀疏：实测最近 2000 / 5000 块**一条成交都没有**，20000 块才有
 *     33 条。于是扫日志必须回看几万甚至十几万块，公共节点要不是按 archive
 *     请求 403（publicnode）、要不限制跨度（drpc 10000），只剩 nodereal 一个
 *     能用，量大就限流。
 *   - 而挂单是**当前状态**：`nextBidId()` 拿总数、往回读几十笔 `bids(id)` 即可
 *     覆盖全部四种晶体管（实测最近 60 笔全覆盖），一次 eth_getLogs 都不发。
 *     eth_call 读最新状态不需要 archive 数据，任何公共节点都能答。
 *
 * 晶体管市场 bids(uint256) 的返回布局（2026-10-23 实测，实现合约未开源）：
 *   word0 = buyer        word1 = transistors（晶体管合约）
 *   word2 = price(wei)   word3 = tokenId（0 = NAND, 1 = LATCH）
 *   word4 = feeBps(100)  word5 = remaining（剩余未成交量，> 0 才是活跃挂单）
 * 注意这与 ABI 里声明的打包形态不同（官方 price 是 uint256，不参与打包），
 * 所以这里**手工解码原始返回**，不走 ethers 的 ABI 解码。
 *
 * ── 边界 ──
 *   - 只回溯最近 120 笔买单。若某个晶体管刚好在这段里没有活跃挂单，就取不到价，
 *     交给成交事件 / market.json / 静态基准补。
 *   - 官方实现合约闭源，结构体布局是实测反推的；官方升级合约可能失效，
 *     解码函数带合理性校验，解出垃圾价就当没读到（不会显示错误数字）。
 *
 * ── CORS ──
 * market.json 直连 tapeout.net 会被 CORS 拦，走 /tt-api 反代（见 vite.config.js）。
 * 链上读取走公共 RPC（公共节点对浏览器 dApp 放开 CORS），不依赖反代。
 */

import { TRANSISTORS } from "./prices.js";
import { MATERIAL_MARKET_ADDRESS } from "./chain/config.js";
import {
  callBatchWithFailover,
  getLogsWithFailover,
  withReadProvider,
} from "./chain/client.js";

/** 晶体管市场快照（兜底来源，经 Vite 代理转发，绕开 tapeout.net 不发 CORS 头的问题） */
export const OFFICIAL_MARKET_URL = "/tt-api/market.json";

/** 链上成交事件的 topic0（反推，官方实现合约未开源）。 */
const TRADE_TOPIC = "0xcc402b0b2e84e03a81c9a55a11a5a69d5384a8d29c888c6867ecbc8c9ecd51c8";

/**
 * 成交事件的回看跨度。
 *
 * 只用在「挂单没凑齐」的补位上。以前它是主源，为了找稀疏成交要翻 8 × 20k ≈
 * 16 万块 —— 而公共节点里只有 nodereal 允许这种跨度，量大就限流。现在主源是
 * 挂单状态（不扫日志），这里只保留单窗口。nodereal 免费档跨度上限 50000。
 */
const ONCHAIN_LOG_SPAN = 20_000;

/** 买单扫描：每批读多少笔、最多读几批（2 × 60 = 120 笔）。 */
const BID_BATCH = 60;
const BID_ROUNDS = 2;

const NEXT_BID_ID_SELECTOR = "0xdc269049"; // nextBidId()
const BIDS_SELECTOR = "0x4423c5f1"; // bids(uint256)

/** 价格合理性上限（100 万 BNB）：超过说明结构体布局变了，解出来的不是价格。 */
const MAX_PLAUSIBLE_WEI = 10n ** 24n;

/**
 * 解码一笔买单的原始返回。
 *
 * 晶体管市场返回六个独立 word，与 ABI 里声明的打包形态不同（官方 price 是
 * uint256，不参与打包），所以这里手工解码，不走 ethers 的 ABI 解码。
 *
 * @returns {{ parts: string, tokenId: number, price: bigint, remaining: number }|null}
 */
function decodeBid(raw) {
  const hex = typeof raw === "string" && raw.startsWith("0x") ? raw.slice(2) : "";
  if (hex.length < 64 * 4) return null; // 至少 4 个字
  const words = hex.length / 64;
  const w = (i) => BigInt("0x" + hex.slice(i * 64, (i + 1) * 64));
  const parts = "0x" + hex.slice(88, 128).toLowerCase(); // word1 的低 20 字节

  let price;
  let tokenId;
  let remaining;
  if (words >= 6) {
    // 晶体管市场（主网）：price / tokenId / feeBps / remaining 各占一个 word
    price = w(2);
    tokenId = Number(w(3));
    remaining = w(5);
  } else {
    // Mock 市场（测试网）：price(96) | tokenId(8) | feeBps(16) 打包在 word2
    const packed = w(2);
    price = packed >> 160n;
    tokenId = Number((packed >> 152n) & 0xffn);
    remaining = w(3);
  }

  // 布局万一变了就解出垃圾（比如把地址当价格）。宁可「读不到」也不能显示错价。
  if (!(price > 0n) || price > MAX_PLAUSIBLE_WEI) return null;
  if (!(remaining > 0n)) return null; // 已成交完的挂单不代表当前市价
  if (!Number.isInteger(tokenId) || tokenId > 3) return null;
  return { parts, tokenId, price, remaining: Number(remaining) };
}

/**
 * 主源：读晶体管市场最近若干笔买单，取本项目每种晶体管的「最高未成交买价」。
 *
 * 晶体管市场只有买单侧（`nextAskId()` 直接 revert），本项目 Owner 是卖方，要卖
 * 就得吃别人的买单 —— 所以真正相关的价是**当前最高出价**，不是稀疏的历史成交价。
 *
 * 全程 eth_call（读最新状态，不需要 archive 数据，任何公共节点都能答），
 * 一次 eth_getLogs 都不发。实测最近 60 笔即可覆盖四种官方晶体管。
 *
 * 返回形状与 parseOfficialMarket 一致，下游 officialQuote 无需改动。
 */
async function fetchOnChainBids() {
  const market = MATERIAL_MARKET_ADDRESS;
  if (!market || !/^0x[0-9a-fA-F]{40}$/.test(market)) {
    return { prices: {}, error: "未配置晶体管市场地址" };
  }

  let nextId;
  let latest = 0;
  try {
    const got = await withReadProvider(async (provider) => ({
      raw: await provider.call({ to: market, data: NEXT_BID_ID_SELECTOR }),
      height: await provider.getBlockNumber(),
    }));
    nextId = Number(BigInt(got.raw));
    latest = got.height;
  } catch {
    return { prices: {}, error: "市场订单总数读取失败" };
  }
  if (!Number.isFinite(nextId) || nextId <= 0) {
    return { prices: {}, error: "市场订单总数异常" };
  }

  const best = new Map(); // 晶体管 id → { bid, bidQty }
  let scanned = 0;
  let roundsDone = 0;

  for (let round = 0; round < BID_ROUNDS; round++) {
    const ids = [];
    for (let k = 0; k < BID_BATCH; k++) {
      const id = nextId - 1 - scanned - k;
      if (id < 0) break;
      ids.push(id);
    }
    if (!ids.length) break;

    let raws;
    try {
      raws = await callBatchWithFailover(
        ids.map((id) => ({
          to: market,
          data: BIDS_SELECTOR + id.toString(16).padStart(64, "0"),
        })),
      );
    } catch {
      // 第一批就全挂 = 节点都读不了；之后的批失败则沿用已拿到的部分
      if (!roundsDone) return { prices: {}, error: "所有 RPC 节点都无法读取市场挂单" };
      break;
    }
    roundsDone += 1;
    scanned += ids.length;

    for (const raw of raws) {
      const bid = decodeBid(raw);
      if (!bid) continue;
      const id = OFFICIAL_KEY_MAP.get(`${bid.parts}-${bid.tokenId}`);
      if (!id) continue; // 不是本项目的官方晶体管
      const price = Number(bid.price) / 1e18;
      if (!(price > 0)) continue;
      const row = best.get(id);
      if (!row) {
        best.set(id, { bid: price, bidQty: bid.remaining });
      } else {
        if (price > row.bid) row.bid = price;
        row.bidQty += bid.remaining;
      }
    }
    if (best.size >= OFFICIAL_KEY_MAP.size) break;
  }

  if (!best.size) {
    return {
      prices: {},
      lastBlock: latest,
      error: `回看最近 ${scanned} 笔买单，无本项目晶体管的活跃挂单`,
    };
  }

  const prices = {};
  for (const [id, row] of best) {
    prices[id] = { bid: row.bid, last: null, bidQty: row.bidQty, lastTs: 0 };
  }
  return { prices, generatedAt: "onchain", lastBlock: latest, scanned };
}

/**
 * 把一批成交日志里的单价归位到晶体管 id（同晶体管取区块最高的那笔 = 最近成交）。
 * 只写链上成交价，bid 恒为 null —— 买价由 fetchOnChainBids 从挂单读。
 */
function collectTradePrices(prices, logs) {
  for (const log of logs) {
    // topics[3] = 晶体管合约地址（零填充的 32 字节 topic，低 20 字节是地址）
    const t3 = log.topics && log.topics[3];
    if (!t3) continue;
    const comp = t3.startsWith("0x000000000000000000000000")
      ? "0x" + t3.slice(26)
      : null;
    if (!comp) continue;

    const hex = log.data && log.data.startsWith("0x") ? log.data.slice(2) : "";
    if (hex.length < 128) continue; // 至少需 tokenId + price 两个字
    const tokenId = Number(BigInt("0x" + hex.slice(0, 64))); // data 字 0
    const priceWei = BigInt("0x" + hex.slice(64, 128)); // data 字 1
    const id = OFFICIAL_KEY_MAP.get(`${comp.toLowerCase()}-${tokenId}`);
    if (!id) continue;

    const price = Number(priceWei) / 1e18;
    if (!(price > 0)) continue;
    const blockNum = Number(BigInt(log.blockNumber));
    const existing = prices[id];
    if (!existing || blockNum > existing.lastTs) {
      prices[id] = { bid: null, last: price, bidQty: 0, lastTs: blockNum };
    }
  }
}

/**
 * 补位源：扫最近一个窗口的成交事件，给挂单没覆盖到的晶体管补「最近成交价」。
 *
 * 只在挂单没收齐时才跑。成交极稀疏（实测 2000 / 5000 块窗口一条都没有），
 * 为此翻十几万块不值当；主源已经是挂单状态，这里只做一次单窗口尝试。
 */
async function fetchOnChainTrades() {
  const market = MATERIAL_MARKET_ADDRESS;
  if (!market || !/^0x[0-9a-fA-F]{40}$/.test(market)) return { prices: {}, error: "未配置晶体管市场地址" };

  let latest;
  try {
    latest = await withReadProvider((provider) => provider.getBlockNumber());
  } catch {
    return { prices: {}, error: "链上最新区块读取失败" };
  }

  let logs;
  try {
    // 必须走 failover：单节点拿到 publicnode 时大窗口直接 403，
    // 而「读不到」和「没有成交」在这里都表现为空，单节点无法区分。
    logs = await getLogsWithFailover({
      address: market,
      topics: [TRADE_TOPIC],
      fromBlock: Math.max(0, latest - ONCHAIN_LOG_SPAN + 1),
      toBlock: latest,
    });
  } catch {
    return { prices: {}, error: "所有 RPC 节点都无法读取市场成交日志" };
  }

  const prices = {};
  if (logs.length) collectTradePrices(prices, logs);
  if (!Object.keys(prices).length) {
    return { prices: {}, error: `回看 ${ONCHAIN_LOG_SPAN} 块内无晶体管市场成交` };
  }
  return { prices, generatedAt: "onchain", lastBlock: latest };
}

/** 快照缓存有效期：官方站点自己也是分钟级刷新，前端跟着这个节奏即可 */
const TTL_MS = 60_000;

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

/** 官方晶体管合约 + tokenId → 本项目 TRANSISTORS 里的 id */
const OFFICIAL_KEY_MAP = (() => {
  const map = new Map();
  for (const t of TRANSISTORS) {
    map.set(`${t.contract.toLowerCase()}-${t.tokenId}`, t.id);
  }
  return map;
})();

/** wei → BNB 数值 */
function toBnb(wei) {
  const n = Number(wei);
  if (!Number.isFinite(n)) return null;
  return n / 1e18;
}

/**
 * 把官方 market.json 解析成「按晶体管 id 归位」的市价表。
 *
 * @returns {{
 *   prices: Record<string, { bid: number|null, last: number|null, bidQty: number, lastTs: number }>,
 *   generatedAt: string,
 *   lastBlock: number,
 * }}
 */
export function parseOfficialMarket(raw) {
  const prices = {};
  const ensure = (id) => {
    if (!prices[id]) prices[id] = { bid: null, last: null, bidQty: 0, lastTs: 0 };
    return prices[id];
  };

  // 1) 未成交买单 → 买价（最高出价）
  for (const b of raw?.openBids || []) {
    const id = OFFICIAL_KEY_MAP.get(`${String(b.transistors || "").toLowerCase()}-${b.tokenId}`);
    if (!id) continue;
    const remaining = Number(b.remaining || 0);
    if (remaining <= 0) continue;
    const p = toBnb(b.price);
    if (p == null) continue;
    const row = ensure(id);
    if (row.bid == null || p > row.bid) row.bid = p;
    row.bidQty += remaining;
  }

  // 2) 成交记录 → 最近成交价
  for (const [key, trades] of Object.entries(raw?.tradesByKey || {})) {
    const id = OFFICIAL_KEY_MAP.get(key);
    if (!id || !Array.isArray(trades) || trades.length === 0) continue;
    const last = trades[trades.length - 1];
    const p = toBnb(last?.price);
    if (p == null) continue;
    const row = ensure(id);
    row.last = p;
    row.lastTs = Number(last?.ts || 0);
  }

  return {
    prices,
    generatedAt: raw?.generatedAt || "",
    lastBlock: Number(raw?.lastBlock || 0),
  };
}

/**
 * 拉取官方市价（带 TTL 缓存与并发去重）。
 *
 * 失败时**不抛错**，返回 { ok: false, error }——市价是辅助信息，
 * 拉不到不该让页面崩掉，调用方自己决定怎么降级展示。
 */
export async function fetchOfficialPrices({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < TTL_MS) return _cache;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    const prices = {};
    const sources = [];
    let lastBlock = 0;
    let generatedAt = "";
    let marketJsonError = null;
    let onchainError = null;

    // ① 主源：链上活跃买单（纯 eth_call，不扫日志）
    try {
      const bids = await fetchOnChainBids();
      if (bids?.prices && Object.keys(bids.prices).length) {
        Object.assign(prices, bids.prices);
        sources.push("onchain:openBids");
        lastBlock = bids.lastBlock || lastBlock;
        generatedAt = "onchain";
      } else {
        onchainError = bids?.error || "链上无活跃挂单";
      }
    } catch (e) {
      onchainError = e?.message || "链上读取异常";
    }

    // ② 补位：挂单没凑齐的晶体管，扫一个窗口的成交事件补「最近成交价」。
    //    常态下挂单就能凑齐，这一步不跑，也就不会去翻几万块日志。
    if (Object.keys(prices).length < OFFICIAL_KEY_MAP.size) {
      try {
        const trades = await fetchOnChainTrades();
        let added = 0;
        for (const [id, row] of Object.entries(trades.prices || {})) {
          const cur = prices[id];
          if (!cur) {
            prices[id] = row;
            added += 1;
          } else if (cur.last == null && row.last != null) {
            cur.last = row.last;
            cur.lastTs = row.lastTs;
            added += 1;
          }
        }
        if (added) sources.push("onchain:trades");
      } catch {
        /* 补位失败不致命 */
      }
    }

    // ② 兜底：官方 market.json（同源反代 /tt-api）。只补链上没覆盖到的晶体管，
    //    链上已拿到的不覆盖（链上更新鲜）。market.json 失败（含生产 404）只记错，
    //    不阻断——链上/静态仍能兜底。
    try {
      const res = await fetch(OFFICIAL_MARKET_URL, { headers: { accept: "application/json" } });
      if (!res.ok) {
        // OFFICIAL_MARKET_URL 是同源反代路径（/tt-api/...），不是官方站点直连。
        // 生产托管时若该路径 404，几乎一定是生产 Web 服务器没配 /tt-api → tapeout.net
        // 的反代（dev/preview 的 vite 代理不进 vite build 产物，见 MEMORY.md M-2）。
        // 不要把锅甩给「晶体管市场」，否则下次还会误判。
        const hint =
          res.status === 404
            ? "（同源 /tt-api 路径 404：生产环境未配置指向 tapeout.net 的反代，见部署文档 §9.2 / frontend/tt-api.nginx.conf）"
            : "";
        throw new Error(`市价接口返回 ${res.status}${hint}`);
      }
      const parsed = parseOfficialMarket(await res.json());
      for (const [id, row] of Object.entries(parsed.prices)) {
        if (!prices[id]) prices[id] = row; // 链上优先，market.json 只补缺
      }
      if (Object.keys(parsed.prices).length) {
        sources.push("tapeout.net/market.json");
        lastBlock = parsed.lastBlock || lastBlock;
        generatedAt = parsed.generatedAt || generatedAt;
      }
    } catch (e) {
      marketJsonError = e?.message || String(e);
    }

    const ok = Object.keys(prices).length > 0;
    const result = {
      ok,
      prices,
      generatedAt,
      lastBlock,
      // 只要任一来源给出价，就不报错误（链上部分覆盖也够用）；全空才报错。
      // 全空时把两个来源各自的失败原因都带上 —— 只报兜底的 404 会让人以为
      // 装个反代就好了，实际主因常常是链上没读到（见 fetchOnChainBids）。
      source: sources.join(" + ") || "none",
      fetchedAt: now,
      error: ok
        ? null
        : [onchainError && `链上：${onchainError}`, marketJsonError && `market.json：${marketJsonError}`]
            .filter(Boolean)
            .join("；") || "所有市价来源均无数据",
    };
    _cache = result;
    _cacheAt = now;
    _inflight = null;
    return result;
  })();

  return _inflight;
}


/**
 * 官方市价 → 本项目 quote 形状。
 *
 * 只覆盖**官方晶体管**（TapeOut / Behemoth 的 NAND 与 LATCH）的价格，
 * 其余晶体管保留静态基准价。`source` 标成 "official"，
 * 这样页面上能明确区分「官方市价」与「静态基准」。
 *
 * 键表由 TRANSISTORS 自动生成（合约地址 + tokenId → 晶体管 id），
 * 所以新增官方处理器后这里无需改动即可自动接入市价。
 */
export function officialQuote(baseQuote, official) {
  const prices = { ...(baseQuote?.prices || {}) };
  for (const [id, row] of Object.entries(official?.prices || {})) {
    // 买价与成交价都缺，才算没有价
    const p = row.last != null ? row.last : row.bid;
    if (p == null || !(p > 0)) continue;
    prices[id] = p;
  }
  return {
    ...baseQuote,
    prices,
    source: "official",
    updatedAt: official?.fetchedAt || 0,
    official: {
      generatedAt: official?.generatedAt || "",
      lastBlock: official?.lastBlock || 0,
      error: official?.error || null,
      rows: official?.prices || {},
    },
  };
}
