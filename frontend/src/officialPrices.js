/**
 * 官方电路市价。
 *
 * ════════════════════════════════════════════════════════════════
 * 官方电路市场（0x6feE…B46f）只有**卖单侧**：
 *   - 挂单：`list(circuits, tokenId, price)`
 *   - 买入：`buy(id, expectedPrice)`，一笔成交一张 ERC721 电路
 *   - 撤单：`delist(id)`
 * 没有买单簿，所以「市价」只能是**当前最低挂单价（floor）**。
 * ════════════════════════════════════════════════════════════════
 *
 * 数据源：链上 `nextListingId()` + `listings(id)`，纯 eth_call，
 * 不扫日志、不依赖 tapeout.net 反代。挂单状态是最新状态，普通公共节点即可回答。
 *
 * 边界：
 *   - 从最新的挂单往回读，最多 `LISTING_MAX` 笔。更早的挂单如果仍在售，
 *     本快照可能漏掉它（价格只会偏高，不会偏低）。要绝对 floor 需要索引服务。
 *   - 官方市场实现合约升级后结构体布局可能变化；解码带合理性校验，
 *     解出垃圾价就当没读到，宁可显示「暂无挂单」也不显示错价。
 */

import { Interface } from "ethers";
import { CIRCUITS } from "./prices.js";
import { CIRCUIT_MARKET_ADDRESS } from "./chain/config.js";
import { CIRCUIT_MARKET_ABI } from "./chain/abis.js";
import { callBatchWithFailover, withReadProvider } from "./chain/client.js";

const iface = new Interface(CIRCUIT_MARKET_ABI);

/** 每批读多少笔挂单、最多回看多少笔。 */
const LISTING_BATCH = 60;
const LISTING_MAX = 600;

/** 价格合理性上限（100 万 BNB）：超过说明结构体布局变了。 */
const MAX_PLAUSIBLE_WEI = 10n ** 24n;

const ZERO = "0x0000000000000000000000000000000000000000";

/** 官方电路集合地址（小写）→ 本项目 CIRCUITS 里的 id。 */
const OFFICIAL_KEY_MAP = (() => {
  const map = new Map();
  for (const c of CIRCUITS) {
    map.set(String(c.contract).toLowerCase(), c.id);
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
 * 解码一笔挂单。
 *
 * `listings(uint256)` 返回 (seller, circuits, price, feeBps, tokenId)。
 * 只接受仍然有效的挂单：卖家非零、价格合理。
 *
 * @returns {{ circuits: string, tokenId: bigint, price: bigint }|null}
 */
function decodeListing(raw) {
  if (typeof raw !== "string" || !raw.startsWith("0x") || raw.length < 10) return null;
  let decoded;
  try {
    decoded = iface.decodeFunctionResult("listings", raw);
  } catch {
    return null;
  }
  const seller = String(decoded.seller || ZERO).toLowerCase();
  const circuits = String(decoded.circuits || ZERO).toLowerCase();
  const price = BigInt(decoded.price ?? 0);
  const tokenId = BigInt(decoded.tokenId ?? 0);
  if (seller === ZERO || circuits === ZERO) return null; // 已撤销 / 不存在
  if (!(price > 0n) || price > MAX_PLAUSIBLE_WEI) return null;
  return { circuits, tokenId, price };
}

/**
 * 主源：读电路市场最近的活跃挂单，取本项目每种电路集合的**最低挂单价**。
 *
 * 全程 eth_call（读最新状态，不需要 archive 数据），一次 eth_getLogs 都不发。
 * 返回形状与旧版保持一致，下游 officialQuote / OfficialPricePanel 无需感知来源。
 */
async function fetchOnChainListings() {
  const market = CIRCUIT_MARKET_ADDRESS;
  if (!market || !/^0x[0-9a-fA-F]{40}$/.test(market)) {
    return { prices: {}, error: "未配置电路市场地址" };
  }

  let nextId;
  let latest = 0;
  try {
    const got = await withReadProvider(async (provider) => ({
      raw: await provider.call({
        to: market,
        data: iface.encodeFunctionData("nextListingId"),
      }),
      height: await provider.getBlockNumber(),
    }));
    nextId = Number(BigInt(got.raw));
    latest = got.height;
  } catch {
    return { prices: {}, error: "市场挂单总数读取失败" };
  }
  if (!Number.isFinite(nextId) || nextId <= 1) {
    return { prices: {}, lastBlock: latest, error: "电路市场没有挂单" };
  }

  const best = new Map(); // 电路 id → { ask, listed }
  let scanned = 0;
  let roundsDone = 0;

  while (scanned < LISTING_MAX) {
    const ids = [];
    for (let k = 0; k < LISTING_BATCH && scanned + k < LISTING_MAX; k++) {
      // nextListingId 是「下一个可用 id」，已发出的 id 是 1 .. nextId-1。
      const id = nextId - 1 - scanned - k;
      if (id < 1) break;
      ids.push(id);
    }
    if (!ids.length) break;

    let raws;
    try {
      raws = await callBatchWithFailover(
        ids.map((id) => ({
          to: market,
          data: iface.encodeFunctionData("listings", [id]),
        })),
      );
    } catch {
      // 第一批就全挂 = 节点都读不了；之后的批失败则沿用已拿到的部分。
      if (!roundsDone) return { prices: {}, error: "所有 RPC 节点都无法读取市场挂单" };
      break;
    }
    roundsDone += 1;
    scanned += ids.length;

    for (const raw of raws) {
      const listing = decodeListing(raw);
      if (!listing) continue;
      const id = OFFICIAL_KEY_MAP.get(listing.circuits);
      if (!id) continue; // 不是本项目的官方电路集合
      const price = toBnb(listing.price);
      if (price == null || !(price > 0)) continue;
      const row = best.get(id);
      if (!row) {
        best.set(id, { ask: price, listed: 1 });
      } else {
        if (price < row.ask) row.ask = price;
        row.listed += 1;
      }
    }
  }

  if (!best.size) {
    return {
      prices: {},
      lastBlock: latest,
      error: `回看最近 ${scanned} 笔挂单，没有本项目电路在售`,
    };
  }

  const prices = {};
  for (const [id, row] of best) {
    prices[id] = { ask: row.ask, floor: row.ask, last: null, listed: row.listed, lastTs: 0 };
  }
  return { prices, generatedAt: "onchain", lastBlock: latest, scanned };
}

/** 快照缓存有效期：市场挂单是分钟级变化，前端跟着这个节奏即可。 */
const TTL_MS = 60_000;

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

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
    let prices = {};
    let lastBlock = 0;
    let onchainError = null;

    try {
      const onchain = await fetchOnChainListings();
      if (onchain?.prices && Object.keys(onchain.prices).length) {
        prices = onchain.prices;
        lastBlock = onchain.lastBlock || 0;
      } else {
        onchainError = onchain?.error || "链上无活跃挂单";
      }
    } catch (e) {
      onchainError = e?.message || "链上读取异常";
    }

    const ok = Object.keys(prices).length > 0;
    const result = {
      ok,
      prices,
      generatedAt: ok ? "onchain" : "",
      lastBlock,
      source: ok ? "onchain:listings" : "none",
      fetchedAt: now,
      error: ok ? null : onchainError || "电路市场暂无挂单",
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
 * 只覆盖官方电路集合的**最低挂单价**，其余保留静态基准价。
 * `source` 标成 "official"，页面上能明确区分「官方市价」与「静态基准」。
 *
 * 键表由 CIRCUITS 自动生成（集合地址 → 电路 id），
 * 新增官方处理器后这里无需改动即可自动接入市价。
 */
export function officialQuote(baseQuote, official) {
  const prices = { ...(baseQuote?.prices || {}) };
  for (const [id, row] of Object.entries(official?.prices || {})) {
    const p = row.ask != null ? row.ask : row.last != null ? row.last : row.bid;
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
