/**
 * 官方元件市价（官方 tapeout.net 市场快照）。
 *
 * ══════════════════════════════════════════════════════════════
 * 这里的「市价」只有一个来源：官方站点自己发布的 market.json。
 * ══════════════════════════════════════════════════════════════
 *
 * 为什么不直接读链：
 *   - 官方材料市场 0xA6a8… 是代理合约，公开 ABI 只有**买单**侧
 *     （nextBidId / bids / feeBps / placeBid / fillBid / cancelBid），
 *     卖单在另一套「电路市场」合约上，且 BSC 配置里 askMarket = null；
 *   - 买单簿 nextBidId 已到 12 万+，逐个 eth_call 扫全量在浏览器里不可接受；
 *   - 公共 RPC 的 eth_getLogs 在 BSC 上普遍 403 / 限流。
 *
 * 官方站点自己就在做这件事：它扫链 → 聚合成 market.json → 前端消费。
 * 我们直接用同一份数据，语义与官方页面完全一致：
 *
 *   openBids      未成交买单（买方愿意付的价 → 市场**买价** / 最高出价）
 *   tradesByKey   历史成交（最近成交价 → **成交价**）
 *   tokens        元件合约 + tokenId → 处理器名
 *
 * 键的格式是 `transistors地址小写-tokenId`，NAND=0、LATCH=1。
 *
 * 价格单位是 wei（BNB × 1e18）。
 *
 * ── CORS ──
 * tapeout.net 不返回 access-control-allow-origin，浏览器直连会被拦。
 * 因此走 Vite 代理 `/tt-api`（见 vite.config.js），开发与预览服同一路径。
 */

import { TRANSISTORS } from "./prices.js";

/** 官方市场快照（经 Vite 代理转发，绕开 tapeout.net 不发 CORS 头的问题） */
export const OFFICIAL_MARKET_URL = "/tt-api/market.json";

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
    try {
      const res = await fetch(OFFICIAL_MARKET_URL, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`官方市场返回 ${res.status}`);
      const raw = await res.json();
      const parsed = parseOfficialMarket(raw);
      _cache = {
        ok: true,
        ...parsed,
        source: "tapeout.net/market.json",
        fetchedAt: now,
        error: null,
      };
    } catch (e) {
      // 拉取失败时保留上一次成功的数据（可能已过期），只标注错误
      _cache = {
        ok: false,
        prices: _cache?.prices || {},
        generatedAt: _cache?.generatedAt || "",
        lastBlock: _cache?.lastBlock || 0,
        source: "tapeout.net/market.json",
        fetchedAt: now,
        error: e?.message || String(e),
      };
    } finally {
      _cacheAt = now;
      _inflight = null;
    }
    return _cache;
  })();

  return _inflight;
}

/** 同步读上一次缓存（不触发网络）。 */
export function peekOfficialPrices() {
  return _cache;
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
