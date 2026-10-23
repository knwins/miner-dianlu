/**
 * 官方元件市价。
 *
 * ════════════════════════════════════════════════════════════════
 * 主源：链上官方市场的最新成交事件（getLogs 读代理合约 0xA6a80…）。
 * 兜底：官方站点 market.json（同源反代 /tt-api）。再不行回退静态基准。
 * ════════════════════════════════════════════════════════════════
 *
 * 为什么主源走链上、而不是只拉 market.json：
 *   - market.json 经 Vite 代理 /tt-api 转发，但 vite build 产物不含该代理，
 *     生产静态托管时若没配反代，/tt-api/* 直接 404（M-2 已知风险）。
 *   - 官方市场是代理合约，成交时 emit 事件，单价就在事件 data 里。
 *     按元件合约地址 + tokenId 过滤即可取出本项目的 NAND/LATCH 成交价，
 *     且实测与官方 market.json 的「最近成交价」逐位一致。
 *
 * 链上成交事件的布局（反推，官方实现合约未开源）：
 *   topic0    = 0xcc402b0b…（成交 / Fill 事件）
 *   topics[1] = 自增成交 ID
 *   topics[2] = 对手方地址
 *   topics[3] = 元件合约地址（识别处理器：Behemoth / TapeOut）
 *   data 字 0 = tokenId（0 = NAND, 1 = LATCH）
 *   data 字 1 = 单价（wei）
 *   data 字 2 = 数量
 *
 * ── 边界（决定它不能 100% 取代 market.json）──
 *   - 公共 RPC 对超过约 5000 块的 getLogs 返回 "Archive requests require a
 *     personal token"，只能读最近窗口内的成交；某元件几小时没成交就取不到，
 *     此时回退 market.json / 静态基准。
 *   - 只拿到「成交价」，拿不到「买价」（未成交买单最高出价）；
 *     买价仍需扫 bids(1..12万+) —— 那条路仍是 open 问题，本项目不依赖它。
 *   - 官方实现合约闭源，事件布局是反推的；官方升级合约可能失效。
 *
 * ── CORS ──
 * market.json 直连 tapeout.net 会被 CORS 拦，走 /tt-api 反代（见 vite.config.js）。
 * 链上读取走公共 RPC（公共节点对浏览器 dApp 放开 CORS），不依赖反代。
 */

import { TRANSISTORS } from "./prices.js";
import { MATERIAL_MARKET_ADDRESS } from "./chain/config.js";
import { getReadProvider } from "./chain/client.js";

/** 官方市场快照（兜底来源，经 Vite 代理转发，绕开 tapeout.net 不发 CORS 头的问题） */
export const OFFICIAL_MARKET_URL = "/tt-api/market.json";

/**
 * 链上成交事件的 topic0（反推，官方实现合约未开源）。
 * 仅这个事件带「元件合约地址 + tokenId + 单价」，是取本项目市价的正确来源；
 * 市场上另外两个 topic0（自增 ID + 价格的全局事件等）不含元件信息，忽略。
 */
const TRADE_TOPIC = "0xcc402b0b2e84e03a81c9a55a11a5a69d5384a8d29c888c6867ecbc8c9ecd51c8";

/**
 * 主源：读链上官方市场的最新成交事件，取本项目四种元件（处理器 × NAND/LATCH）的成交价。
 *
 * 返回形状与 parseOfficialMarket 一致：{ prices: { id: { bid, last, bidQty, lastTs } }, ... }，
 * 这样下游 officialQuote 无需改动即可消费。成交事件只有成交价，故 bid 恒为 null。
 *
 * 取不到（无近期成交 / RPC 失败 / 非主网市场）时返回 { prices: {} }，交由调用方回退。
 */
async function fetchOnChainPrices() {
  const market = MATERIAL_MARKET_ADDRESS;
  if (!market || !/^0x[0-9a-fA-F]{40}$/.test(market)) return { prices: {} };
  const provider = getReadProvider();

  let latest;
  try {
    latest = await provider.getBlockNumber();
  } catch {
    return { prices: {} };
  }

  // 公共 RPC（publicnode 等）对超过约 5000 块的 getLogs 返回
  // "Archive requests require a personal token"。先用安全窗口，失败再缩到更小窗口。
  const spans = [5000, 2000];
  let logs = [];
  for (const span of spans) {
    try {
      logs = await provider.getLogs({
        address: market,
        topics: [TRADE_TOPIC],
        fromBlock: Math.max(0, latest - span),
        toBlock: latest,
      });
      break;
    } catch {
      logs = [];
    }
  }
  if (!logs.length) return { prices: {} };

  const prices = {};
  for (const log of logs) {
    // topics[3] = 元件合约地址（零填充的 32 字节 topic，低 20 字节是地址）
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
    // 同一元件可能有多笔成交，取区块最高的那笔（= 最近成交）
    if (!existing || blockNum > existing.lastTs) {
      prices[id] = { bid: null, last: price, bidQty: 0, lastTs: blockNum };
    }
  }

  return { prices, generatedAt: "onchain", lastBlock: latest };
}

/** 快照缓存有效期：官方站点自己也是分钟级刷新，前端跟着这个节奏即可 */
const TTL_MS = 60_000;

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

/** 官方元件合约 + tokenId → 本项目 TRANSISTORS 里的 id */
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
 * 把官方 market.json 解析成「按元件 id 归位」的市价表。
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

    // ① 主源：链上官方市场最新成交事件（按元件逐个优先）
    try {
      const onchain = await fetchOnChainPrices();
      if (onchain?.prices && Object.keys(onchain.prices).length) {
        Object.assign(prices, onchain.prices);
        sources.push("onchain:officialMarket");
        lastBlock = onchain.lastBlock || lastBlock;
        generatedAt = "onchain";
      }
    } catch {
      /* 链上失败不致命，继续走兜底 */
    }

    // ② 兜底：官方 market.json（同源反代 /tt-api）。只补链上没覆盖到的元件，
    //    链上已拿到的不覆盖（链上更新鲜）。market.json 失败（含生产 404）只记错，
    //    不阻断——链上/静态仍能兜底。
    try {
      const res = await fetch(OFFICIAL_MARKET_URL, { headers: { accept: "application/json" } });
      if (!res.ok) {
        // OFFICIAL_MARKET_URL 是同源反代路径（/tt-api/...），不是官方站点直连。
        // 生产托管时若该路径 404，几乎一定是生产 Web 服务器没配 /tt-api → tapeout.net
        // 的反代（dev/preview 的 vite 代理不进 vite build 产物，见 MEMORY.md M-2）。
        // 不要把锅甩给「官方市场」，否则下次还会误判。
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
      source: sources.join(" + ") || "none",
      fetchedAt: now,
      error: ok ? null : (marketJsonError || "所有市价来源均无数据"),
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
 * 只覆盖**官方元件**（TapeOut / Behemoth 的 NAND 与 LATCH）的价格，
 * 其余元件保留静态基准价。`source` 标成 "official"，
 * 这样页面上能明确区分「官方市价」与「静态基准」。
 *
 * 键表由 TRANSISTORS 自动生成（合约地址 + tokenId → 元件 id），
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
