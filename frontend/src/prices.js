/**
 * 电路目录与本地区块报价。
 *
 * ══════════════════════════════════════════════════════════════
 * 这里**只做数据**，不做取价。
 * ══════════════════════════════════════════════════════════════
 *
 * 前端不再直接读取价格：实时取价、跨域代理、轮询、涨跌高亮这一整套
 * 已经全部删除。页面上的电路单价只有两个来源：
 *
 *   1. 链上实读：Campaign 记录了 Owner 实际买入的电路成本（priceLock），
 *      这是权威值，由 chain/adapter 写进 book。
 *   2. 本文件的 NOMINAL_QUOTE：开期测算用的**静态基准价**，
 *      仅当链上还没有任何单价时兜底，用来把「募资总额能买多少电路」
 *      这类预估算出来。它不是行情，不会自己变动。
 *
 * 需要看真实行情时，去电路市场页或区块浏览器，本项目前端不再代拉。
 */

import { MINE_GATE_LIMIT } from "./emission.js";

/* ────────────────────────── 品类定义 ────────────────────────── */

/**
 * 官方处理器（电路市场支持的处理器）。
 *
 * ⚠️ **「在售」与「可挖矿」是两件事，不要混在一起**：
 *   TapeOut(P=1) / Behemoth(P=6)  有挖矿产出资格。
 *
 * T-59：官方创世基线 **Genesis CPU**（官方 mining 合约 processorMultiplier = 0，
 * 永远不出矿）已从本项目**整体移除**（安全 + 容量考虑：不能出矿的处理器
 * 一旦开期，用户花钱买的电路既不产生收益、又没有官方挖矿背书）。
 * 移除后官方只剩**两个**可挖矿处理器。
 *
 * `mineable` 字段保留为**声明式防御**：它与 MINEABLE_PROCESSORS 白名单一起，
 * 保证「将来再加一个官方处理器」时不会重演 T-57 修掉的那类 bug
 * （用「在 PROCESSORS 里存在」推断挖矿资格 → 误判）。
 */
export const PROCESSORS = {
  TapeOut: {
    id: "TapeOut",
    name: "TapeOut",
    scale: 1,
    mineable: true,
    desc: "供应量大，成本低",
  },
  Behemoth: {
    id: "Behemoth",
    name: "Behemoth",
    scale: 6,
    mineable: true,
    desc: "4 位链上 CPU，早期支持者溢价",
  },
};

/**
 * 有挖矿产出资格的处理器白名单（官方 mining 合约 processorMultiplier > 0）。
 * `isMineable()` 只查这张表，别处不要用 PROCESSORS 的 key 来判断资格。
 */
export const MINEABLE_PROCESSORS = Object.freeze(
  Object.keys(PROCESSORS).filter((id) => PROCESSORS[id].mineable),
);

/**
 * 电路单价的显示格式化（BNB/张）。
 *
 * ⚠️ **不能统一用 toFixed(5)**：官方处理器的价差跨了数量级——
 *   Behemoth 电路 ≈ 0.42
 *   TapeOut 电路 ≈ 0.056
 * 固定 5 位小数会在更低价量级上把差别抹平。
 *
 * 这里按量级自适应小数位，且用「去掉尾随零」的方式输出，
 * 避免 0.0530000 这种噪声。
 */
export function formatUnitPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !(n > 0)) return "—";
  const digits = n >= 0.01 ? 5 : n >= 0.0001 ? 6 : n >= 0.000001 ? 8 : 10;
  return n.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * 两个「处理器 × 电路集合」组合，对应官方电路市场的两个 ERC721 集合。
 *
 * 电路市场按「集合 + tokenId」交易，每张 NFT 就是一张电路；
 * 同一集合内的 tokenId 不同，但都属于同一个处理器，不再分腿。
 *
 * ⚠️ **能买到 ≠ 能挖矿**：这二条都具备挖矿资格。
 * T-59：Genesis CPU 的记录已删除（multiplier = 0，不能出矿）。
 *
 * priceBnb 是**名义采购价**（BNB 计价），只用于链上没有单价时做开期测算，
 * 不代表市场现价；真实成本以 Campaign 记录的买入单价为准。
 */
export const CIRCUITS = [
  {
    id: "TAPE_OUT_CIRCUIT",
    processor: "TapeOut",
    name: "TapeOut 电路",
    contract: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
    priceBnb: 0.0561,
  },
  {
    id: "BEHEMOTH_CIRCUIT",
    processor: "Behemoth",
    name: "Behemoth 电路",
    contract: "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c",
    priceBnb: 0.42011,
  },
];

export const DEFAULT_CIRCUIT = "BEHEMOTH_CIRCUIT";

export function findCircuit(id) {
  return CIRCUITS.find((c) => c.id === id) || CIRCUITS.find((c) => c.id === DEFAULT_CIRCUIT);
}

/** 处理器下的电路集合。每个处理器只有一个集合。 */
export function circuitsOf(processor) {
  return CIRCUITS.filter((c) => c.processor === processor);
}

/**
 * 该处理器是否有挖矿产出资格。
 *
 * ⚠️ 只查 MINEABLE_PROCESSORS（官方 mining 合约 processorMultiplier > 0），
 * 不能用「PROCESSORS 里有这个 key」来判断——那会把「在售但不出矿」的处理器
 * 误判成可挖矿。
 */
export function isMineable(processor) {
  return MINEABLE_PROCESSORS.includes(processor);
}

/**
 * 每张电路的算力权重。
 * ⚠️ 不能用 `|| 1`：某处理器的官方倍数可能是 **0**，写成 `|| 1` 会把它
 * 悄悄变成 1，算出「有产出」的假象。用 ?? 只兜底「查不到」的情况。
 */
export function processorScale(name) {
  const p = PROCESSORS[name];
  return p ? p.scale : 1;
}

/* ───────────────────── 静态基准报价（非行情） ───────────────────── */

/** BNB 折算 USDT 的固定口径，仅用于「等值展示」，不参与任何链上计算。 */
export const NOMINAL_BNB_USDT = 600;

/**
 * 固定报价快照。
 *
 * 字段形状与旧版实时快照一致（prices / bnbUsdt / source），
 * 这样范围内所有测算函数（estimateHashpower / planTask / designOffering …）
 * 都不用改签名。差别只在：它**永远是同一组数**，不联网、不轮询、不漂移。
 *
 * 无论调用方传什么进来，取价时都只会落到这份常量上——
 * 见 `STATIC_SNAPSHOT`（冻结对象，误改会在严格模式下直接报错）。
 */
const BASE_PRICES = {
  TAPE_OUT_CIRCUIT: 0.0561,
  BEHEMOTH_CIRCUIT: 0.42011,
};

export const NOMINAL_QUOTE = Object.freeze({
  /** 静态基准没有「更新时间」，置 0 表示不参与新鲜度判断 */
  ts: 0,
  updatedAt: 0,
  bnbUsdt: NOMINAL_BNB_USDT,
  prices: Object.freeze({ ...BASE_PRICES }),
  /** 固定口径，不是实时行情 */
  source: "static",
  loading: false,
  error: null,
});

/**
 * 取报价对象。传进来的快照若已带 prices 就直接用（链上实读单价可以覆盖），
 * 否则一律回落到 static 基准。**不做任何网络请求**。
 */
export function quoteOf(snapshot) {
  const prices = snapshot?.prices;
  if (prices && typeof prices === "object" && Object.keys(prices).length > 0) {
    return {
      ...NOMINAL_QUOTE,
      ...snapshot,
      prices: { ...NOMINAL_QUOTE.prices, ...prices },
    };
  }
  return NOMINAL_QUOTE;
}

/** 单个电路的价格口径：快照价 → 目录基准价。 */
export function priceOf(circuitId, snapshot) {
  return quoteOf(snapshot).prices?.[circuitId] ?? findCircuit(circuitId).priceBnb;
}

/* ───────────────────────── 成本测算 ───────────────────────── */

/**
 * 按「电路数量 + 选定电路」算出这一期的全部参数。
 *
 * 电路数由开期人直接决定（就是链上 buyCircuits 买入的张数），
 * 电路单价决定真实采购成本，两者相乘才是这一期的实际支出。
 * 募资总额因此是电路数量的反向决定因素：要烧更多张，募集就得跟着涨。
 *
 * @param {object} params
 * @param {number} params.parts       电路总数。必须是正整数。
 * @param {string} params.circuitId 电路集合 id
 * @param {object} params.snapshot    报价（缺省 = 静态基准）
 */
export function planTask({ parts, circuitId, snapshot }) {
  const model = findCircuit(circuitId);
  const processor = model.processor;
  const P = processorScale(processor);

  /**
   * 电路总数。
   *
   * 只接受正整数；非法值（0/负数/小数/非数字）退回 1。
   * 不能让 0 变成免费矿机，也不能静默把 12.5 取整成 13——
   * 数据层不该依赖 UI 拦截，这里必须自己守住。
   */
  const rawParts = Number(parts);
  const partsOk = Number.isFinite(rawParts) && rawParts >= 1 && Number.isInteger(rawParts);
  const totalParts = partsOk ? rawParts : 1;

  /**
   * 电路市场按 ERC721 单张交割，每一张都属于同一个电路集合。
   * 只有一条腿，采购成本就是「张数 × 当前单价」。
   */
  const priceMain = priceOf(model.id, snapshot);
  const partsCost = totalParts * priceMain;

  /**
   * 权重：H = b* × P，P 为该处理器的每张电路算力。
   *
   * 工本权重 b* 就是电路数量——烧多少张就有多少算力，
   * 这是开期人调电路数能提高产出的原理。
   * 没有「设计溢价」：算力全部来自工本权重，没有可参照的外部难度系数。
   */
  const q = 1;
  const baseWeight = totalParts * P;
  const designPremium = 0;
  const hashpower = Math.round(baseWeight + designPremium);

  /** 面积：每张电路占 1；挖矿闸门按面积判定。 */
  const area = totalParts;

  /**
   * 挖矿闸门：面积超上限的期次只能进未验证池（分 1%）。
   */
  const capped = area > MINE_GATE_LIMIT;

  return {
    model,
    processor,
    processorScale: P,
    /** 兼容旧字段：全部电路同价，两个键都指向同一单价 */
    priceByPart: { CIRCUIT: priceMain },
    priceMain,
    priceOther: priceMain,
    priceSibling: priceMain,
    /** 造价小计：只有一类电路 */
    costBreakdown: {
      CIRCUIT: { count: totalParts, price: priceMain, cost: partsCost },
    },
    /** 实际电路总数 */
    totalParts,
    /** 电路总价（BNB）—— 真正的采购成本 */
    partsCost,
    q,
    baseWeight,
    designPremium,
    hashpower,
    area,
    /** 是否被挖矿闸门拦住（面积超限 → 只能进未验证池，分 1%） */
    capped,
    /** 每 BNB 买到多少权重 */
    hashPerBnb: partsCost > 0 ? hashpower / partsCost : 0,
  };
}

/* ───────────────────────── 发行方案设计 ───────────────────────── */

/** 常见的每份 BNB 档位。选档而不是算任意小数，让份价好记、也好在规则与合约页里说明。 */
const PRICE_TIERS = [0.05, 0.1, 0.25, 0.5, 0.685, 1, 2.5, 5, 10];

/**
 * ══════════════════════════════════════════════════════════════
 * 发行方案设计：一次性给出「每份 BNB」与「总份数」
 * ══════════════════════════════════════════════════════════════
 *
 * 之前只倒推份数、保留手填单价，导致每份 BNB 是一个没有依据的孤立数字——
 * 用户得自己猜「0.685 是怎么来的」。这里把两个参数当成一个整体来设计：
 *
 *   1. 目标募资总额 = 电路成本 / 理想占比（默认 45%，落在健康区间 20%-75% 的中部）
 *   2. 每份 BNB 从常见档位里选**不超过**目标募资总额除以最小份数的最大档，
 *      避免出现「份数只有 3 份」这种没法分的方案
 *   3. 总份数 = 目标募资总额 / 每份，向上取整到 5 的倍数（份数好数）
 *   4. 校验：份数 × 单价 必须仍 ≥ 电路成本，否则补份数
 *
 * 募资总额与成本同为 BNB 计价，全程不需要汇率换算。
 */
export function designOffering({ parts, circuitId, snapshot, targetRatio = COST_RATIO_IDEAL }) {
  const plan = planTask({ parts, circuitId, snapshot });
  const cost = plan.partsCost;
  // 目标募资总额：让电路成本正好落在理想占比上
  const targetCap = cost > 0 ? cost / targetRatio : 0;
  const minShares = 20;

  // 从高档往低档挑第一个能凑够 minShares 份的
  let sharePriceBnb = PRICE_TIERS[0];
  for (const tier of [...PRICE_TIERS].reverse()) {
    if (tier > 0 && tier * minShares <= targetCap) {
      sharePriceBnb = tier;
      break;
    }
  }

  let totalShares = Math.max(
    minShares,
    Math.ceil(targetCap / sharePriceBnb / 5) * 5,
  );
  // 取整到 5 的倍数会向下截断，补回来
  while (sharePriceBnb * totalShares < cost && totalShares < 100000) {
    totalShares += 5;
  }

  const hardCapBnb = sharePriceBnb * totalShares;
  const actualRatio = hardCapBnb > 0 ? cost / hardCapBnb : Infinity;
  /**
   * 占比下限：受两个硬约束挤压——
   *   - 电路数由开期人选定，不能靠选型调高成本
   *   - 募资总额有下限（minShares × 最低档单价）
   * 两者一夹，电路数太少就必然落在健康区间下方。这不是算法的缺陷，
   * 而是「这个电路数不该开一期」的事实，必须如实报出来而不是掩盖。
   */
  const floorCap = minShares * PRICE_TIERS[0];
  const bestRatio = floorCap > 0 ? cost / floorCap : Infinity;
  const cappedByTiers = bestRatio < COST_RATIO_MIN;

  return {
    plan,
    /** 实际生效的电路数（非法输入时已退回 1，与 plan.totalParts 同源） */
    parts: plan.totalParts,
    /** 每份 BNB（取自常见档位） */
    sharePriceBnb,
    /** 总份数（5 的倍数） */
    totalShares,
    /** 实际募资总额 = 份数 × 单价 */
    hardCapBnb: round4(hardCapBnb),
    /** 目标募资总额：电路成本 ÷ 理想占比，用于手动改份数后倒推单价 */
    targetCapBnb: round4(targetCap),
    /** 电路采购成本（BNB） */
    costBnb: round4(cost),
    /** 成本占募资总额比例 */
    costRatio: round4(actualRatio),
    /** 电路涨价多少倍就不再够买 */
    priceTolerance: cost > 0 ? round4(hardCapBnb / cost) : 0,
    /** 采购后余量 */
    marginBnb: round4(hardCapBnb - cost),
    /** 是否落在健康区间 */
    healthy: actualRatio >= COST_RATIO_MIN && actualRatio <= COST_RATIO_MAX,
    /** 占比过高（风险薄） */
    tooRisky: actualRatio > COST_RATIO_MAX,
    /** 电路太少：即使压到最低募资总额，成本占比也够不到健康下限 */
    tooSmall: cappedByTiers,
    /** 该题能达到的最好占比（上限），用于解释为什么够不到 */
    bestRatio: round4(bestRatio),
    /** 相对目标占比的偏差 */
    deviation: round4(Math.abs(actualRatio - targetRatio)),
    /** 本方案的权重 */
    hashpower: plan.hashpower,
  };
}

/** 四位小数。与 fixtures.round4 同实现，此处独立定义以避免循环依赖。 */
const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/** 成本占募资总额的健康区间 */
export const COST_RATIO_MIN = 0.2;
export const COST_RATIO_MAX = 0.75;
/** 理想占比：越接近这个值，风险与收益越平衡 */
export const COST_RATIO_IDEAL = 0.45;

/* ─────────────────── 处理器选择（由开期人决定） ─────────────────── */

/**
 * 选择维度只有一个：**用哪个处理器的电路集合**。
 *
 * 每个处理器对应一个官方 ERC721 电路集合；同一期只能锁定其中一个集合，
 * 之后从市场买入的每张电路都属于该集合。
 *
 *   Behemoth(P=6)：权重是 TapeOut 的 6 倍，但电路贵约 7.5 倍
 *   TapeOut (P=1)：电路便宜，权重低
 *
 * T-59：官方 Genesis CPU（P=0，永远不出矿）已整体移除，不再作为可选处理器。
 */

/**
 * 处理器 -> 代表性电路集合 id。
 *
 * ⚠️ 查表而不是三元表达式：写死 `processor === "TapeOut" ? ... : "BEHEMOTH_CIRCUIT"`
 * 会在处理器数量变化后把新处理器错认成 Behemoth（电路价差可达数千倍）。
 */
export function circuitIdFor(processor) {
  return circuitsOf(processor)[0]?.id || DEFAULT_CIRCUIT;
}

/**
 * 全部可选的官方处理器 id，顺序即 UI 展示顺序。
 * T-59：Genesis 已移除（无挖矿产出资格）。
 */
export const PROCESSOR_IDS = ["Behemoth", "TapeOut"];



/**
 * 反向：给定募资总额，推荐能负担的电路数量区间。
 * 用于开期页在募资总额固定时给出「大概能烧多少张」的范围。
 */
export function suggestPartRange({ hardCapBnb, snapshot, circuitId }) {
  const model = findCircuit(circuitId);
  const avgPrice = priceOf(model.id, snapshot);

  const loG = Math.max(1, Math.floor((hardCapBnb * COST_RATIO_MIN) / avgPrice));
  const hiG = Math.floor((hardCapBnb * COST_RATIO_MAX) / avgPrice);
  const idealG = Math.floor((hardCapBnb * COST_RATIO_IDEAL) / avgPrice);
  return {
    minParts: loG,
    idealParts: idealG,
    maxParts: hiG,
    avgPrice: round4(avgPrice),
    ratioMin: COST_RATIO_MIN,
    ratioIdeal: COST_RATIO_IDEAL,
    ratioMax: COST_RATIO_MAX,
  };
}

