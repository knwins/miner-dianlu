/**
 * TapeOut 官方数据源。
 *
 * 官方没有 REST API，前端价格直接读链上合约；但站点提供两个聚合 JSON 快照，
 * 是我们自己后端（或本地预览）拉取价格与题库的最直接来源：
 *
 *   https://tapeout.net/tasks.json    官方题库，267 道题，含 g / d / K / C
 *   https://tapeout.net/market.json   市场订单簿，含成交价与买盘
 *
 * 两者都是公开只读、无需鉴权。若不可用（离线、限流、站点改版），
 * 自动回落到本地兜底数据，保证 UI 不至于空白。
 */

/**
 * tapeout.net 不返回任何 CORS 头（实测连 Access-Control-Allow-Origin 都没有），
 * 浏览器直连必然被拦，报net::ERR_FAILED。
 *
 * 浏览器环境走 Vite dev server 代理（见 vite.config.js 的 /tt-api），
 * 把跨域变成同源；Node 环境（verify.mjs）直连即可。
 */
const isBrowser = typeof window !== "undefined";
const BASE = isBrowser ? "/tt-api" : "https://tapeout.net";
const MARKET_URL = `${BASE}/market.json`;
const TASKS_URL = `${BASE}/tasks.json`;

/**
 * BNB 兑 USDT 实时价。
 *
 * tapeout.net 的 market.json 只含元件订单簿，**没有 BNB 价格**，
 * 之前是写死的 600 USDT —— 与真实行情脱节，
 * 会让「募资总额换多少 BNB」「涨多少触发退款」全部算错。
 *
 * Gate.io 的公开行情接口返回 `Access-Control-Allow-Origin: *`，浏览器可直连；
 * 不可用时回落 FALLBACK_BNB_USDT。
 */
const BNB_TICKER_URL = "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BNB_USDT";
const FALLBACK_BNB_USDT = 600;

/** 取 BNB 兑 USDT 的最新成交价。失败返回 null 表示不可用。 */
export async function fetchBnbUsdt(timeoutMs = 8000) {
  try {
    const res = await fetchJson(BNB_TICKER_URL, timeoutMs);
    const row = Array.isArray(res) ? res[0] : res;
    const price = Number(row?.last);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

const WAD = 1e18;

/** 官方创世处理器（从 tapeout.net 前端 bundle 提取的 podCpus） */
export const OFFICIAL_CPUS = {
  TapeOut: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
  Behemoth: "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c",
};

/** 两个创世处理器各自的元件合约（NAND 与 LATCH 共用同一合约，用 tokenId 区分） */
export const OFFICIAL_PARTS = {
  TAPE_OUT_NAND: { cpu: OFFICIAL_CPUS.TapeOut, contract: "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", tokenId: 0 },
  TAPE_OUT_LATCH: { cpu: OFFICIAL_CPUS.TapeOut, contract: "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", tokenId: 1 },
  BEHEMOTH_NAND: { cpu: OFFICIAL_CPUS.Behemoth, contract: "0xE2DfD802081C7a05341E20b6582b04b908e8550c", tokenId: 0 },
  BEHEMOTH_LATCH: { cpu: OFFICIAL_CPUS.Behemoth, contract: "0xE2DfD802081C7a05341E20b6582b04b908e8550c", tokenId: 1 },
};

/** 开期选的处理器 → 官方晶体管 ERC1155 地址（挂单 placeBid 用同一个）。 */
export function partsContractForProcessor(processorId) {
  if (processorId === "TapeOut") return OFFICIAL_PARTS.TAPE_OUT_NAND.contract;
  if (processorId === "Behemoth") return OFFICIAL_PARTS.BEHEMOTH_NAND.contract;
  return "";
}

/** 链上 transistors 地址 → 处理器名。旧期次未写入时返回空。 */
export function processorFromPartsContract(address) {
  const a = String(address || "").toLowerCase();
  if (!a || a === "0x0000000000000000000000000000000000000000") return "";
  if (a === OFFICIAL_PARTS.TAPE_OUT_NAND.contract.toLowerCase()) return "TapeOut";
  if (a === OFFICIAL_PARTS.BEHEMOTH_NAND.contract.toLowerCase()) return "Behemoth";
  return "";
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────── 官方题库 ───────────────────────── */

/**
 * 题目按题型的 LATCH 默认占比。
 * 题库只给总元件数 g，不区分 NAND / LATCH，
 * 但面积公式 A = g + 6s 里 s（LATCH 数）影响成本，必须有个合理默认。
 *   comb 组合逻辑题：纯逻辑，少量状态 -> 20%
 *   seq  时序题：    需要锁存状态 -> 50%
 */
export const LATCH_RATIO = { comb: 0.2, seq: 0.5 };

/** 兜底题库（离线时用）。数值取自官方 tasks.json 的典型分布。 */
const FALLBACK_TASKS = [
  { id: 1, name: "与门 AND", tier: "入门", group: "单门", kind: "comb", nIn: 2, nOut: 1, g: 2, d: 2, K: 2, C: 16 },
  { id: 2, name: "或门 OR", tier: "入门", group: "单门", kind: "comb", nIn: 2, nOut: 1, g: 3, d: 2, K: 3, C: 24 },
  { id: 3, name: "异或门 XOR", tier: "入门", group: "单门", kind: "comb", nIn: 2, nOut: 1, g: 4, d: 3, K: 4, C: 108 },
  { id: 12, name: "半加器 Half Adder", tier: "初级", group: "算术", kind: "comb", nIn: 2, nOut: 2, g: 9, d: 4, K: 9, C: 576 },
  { id: 45, name: "4 位加法器", tier: "中级", group: "算术", kind: "comb", nIn: 8, nOut: 5, g: 48, d: 9, K: 48, C: 34992 },
  { id: 120, name: "移位寄存器", tier: "高级", group: "时序", kind: "seq", nIn: 1, nOut: 8, g: 210, d: 16, K: 210, C: 860160 },
];

/** 规范化题目，补齐前端要用的派生字段 */
function normalizeTask(t) {
  const ratio = LATCH_RATIO[t.kind] ?? LATCH_RATIO.comb;
  const latch = Math.round((t.g || 0) * ratio);
  const nand = Math.max(0, (t.g || 0) - latch);
  return {
    id: t.id,
    name: t.name,
    tier: t.tier,
    group: t.group,
    kind: t.kind,
    nIn: t.nIn,
    nOut: t.nOut,
    /** 总元件数 */
    g: t.g,
    /** LATCH 数量（按题型默认比例推导） */
    latch,
    /** NAND 数量 */
    nand,
    /** 深度 */
    d: t.d,
    /** K_task 题目参考工本 */
    K: t.K,
    /** C_ref 参考成本 */
    C: t.C,
    /** 难度排序用 */
    weight: t.g * 1000 + t.d,
  };
}

/**
 * 拉取官方题库。
 * @returns {Promise<{tasks:Array, source:'live'|'fallback', total:number}>}
 */
export async function fetchTaskBook() {
  try {
    const data = await fetchJson(TASKS_URL);
    const list = Array.isArray(data?.tasks) ? data.tasks : [];
    if (!list.length) throw new Error("题库为空");
    return {
      tasks: list.map(normalizeTask).sort((a, b) => a.weight - b.weight),
      source: "live",
      total: data.total ?? list.length,
    };
  } catch {
    return {
      tasks: FALLBACK_TASKS.map(normalizeTask).sort((a, b) => a.weight - b.weight),
      source: "fallback",
      total: FALLBACK_TASKS.length,
    };
  }
}

/** 兜底价格（离线时用）。取自 2026-10-16 实测的二级市场成交价量级。 */
const FALLBACK_PRICES = {
  TAPE_OUT_NAND: 0.056,
  TAPE_OUT_LATCH: 0.051,
  BEHEMOTH_NAND: 0.4,
  BEHEMOTH_LATCH: 0.22,
};

/**
 * 从市场订单簿里取某个元件的报价。
 * 只有买盘（openBids 全是 bid），没有卖一价，
 * 所以用「最高买价 + 最近成交价」两个参考，取最高买价作为可成交价。
 */
function quoteFromMarket(market, meta) {
  const contract = meta.contract.toLowerCase();
  let bestBid = 0;
  let lastTrade = 0;
  let lastTs = 0;
  let trades = 0;

  for (const bid of market.openBids || []) {
    if (String(bid.transistors).toLowerCase() !== contract) continue;
    if (Number(bid.tokenId) !== meta.tokenId) continue;
    const p = Number(bid.price) / WAD;
    if (p > bestBid) bestBid = p;
  }

  const key = `${contract}-${meta.tokenId}`;
  const list = market.tradesByKey?.[key];
  if (Array.isArray(list) && list.length) {
    trades = list.length;
    const last = list[list.length - 1];
    lastTrade = Number(last.price) / WAD;
    lastTs = Number(last.ts) * 1000;
  }

  return { bestBid, lastTrade, lastTs, trades };
}

/**
 * 拉取市场价格。
 * @returns {Promise<{ts:number, bnbUsdt:number, prices:object, meta:object, source:string}>}
 */
export async function fetchMarketPrices() {
  // 元件订单簿与 BNB 行情互不依赖，并行拉取缩短延迟
  const [market, bnbLive] = await Promise.all([
    fetchJson(MARKET_URL, 20000).catch(() => null),
    fetchBnbUsdt(),
  ]);
  const bnbUsdt = bnbLive || FALLBACK_BNB_USDT;
  const bnbLiveOk = bnbLive !== null;

  if (market) {
    const prices = {};
    const meta = {};
    for (const [id, m] of Object.entries(OFFICIAL_PARTS)) {
      const q = quoteFromMarket(market, m);
      // 优先用最高买价（真能成交），没有则退回最近成交价
      const price = q.bestBid > 0 ? q.bestBid : q.lastTrade;
      prices[id] = price > 0 ? Number(price.toFixed(8)) : FALLBACK_PRICES[id];
      meta[id] = { ...m, ...q, price, live: price > 0 };
    }
    return {
      ts: Date.parse(market.generatedAt) || Date.now(),
      block: market.lastBlock,
      bnbUsdt,
      bnbLive: bnbLiveOk,
      prices,
      meta,
      source: "live",
    };
  }

  // 元件订单簿拿不到，但 BNB 价可能可用——部分降级优于整体回落
  return {
    ts: Date.now(),
    bnbUsdt,
    bnbLive: bnbLiveOk,
    prices: { ...FALLBACK_PRICES },
    meta: Object.fromEntries(
      Object.entries(OFFICIAL_PARTS).map(([id, m]) => [id, { ...m, live: false }]),
    ),
    source: "fallback",
  };
}

/**
 * 同时拉取题库与价格。
 * 两条链路独立降级——一边挂了另一边仍可用。
 */
export async function fetchTapeOutData() {
  const [book, market] = await Promise.all([fetchTaskBook(), fetchMarketPrices()]);
  return { book, market };
}
