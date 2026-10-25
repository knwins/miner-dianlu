/**
 * 晶体管目录与本地区块报价。
 *
 * ══════════════════════════════════════════════════════════════
 * 这里**只做数据**，不做取价。
 * ══════════════════════════════════════════════════════════════
 *
 * 前端不再直接读取价格：实时取价、跨域代理、轮询、涨跌高亮这一整套
 * 已经全部删除。页面上的晶体管单价只有两个来源：
 *
 *   1. 链上实读：Campaign 记录了 Owner 实际买单的单价
 *      （nandPrice / latchPrice），这是权威值，由 chain/adapter 写进 book。
 *   2. 本文件的 NOMINAL_QUOTE：开期测算用的**静态基准价**，
 *      仅当链上还没有任何单价时兜底，用来把「募资总额能买多少晶体管」
 *      这类预估算出来。它不是行情，不会自己变动。
 *
 * 需要看真实行情时，去晶体管市场页或区块浏览器，本项目前端不再代拉。
 */

import { MINE_GATE_LIMIT } from "./emission.js";

/* ────────────────────────── 品类定义 ────────────────────────── */

/**
 * 官方处理器（晶体管市场支持的处理器）。
 *
 * ⚠️ **「在售」与「可挖矿」是两件事，不要混在一起**：
 *   TapeOut(P=1) / Behemoth(P=6)  有挖矿产出资格。
 *
 * T-59：官方创世基线 **Genesis CPU**（官方 mining 合约 processorMultiplier = 0，
 * 永远不出矿）已从本项目**整体移除**（安全 + 容量考虑：不能出矿的处理器
 * 一旦开期，用户花钱买的晶体管既不产生收益、又没有官方挖矿背书）。
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

/** 晶体管类型。NAND 与 LATCH 权重相同（都是 1），区别在面积与市场价格。 */
export const PARTS = {
  NAND: { id: "NAND", name: "NAND", areaWeight: 1, desc: "与非门，负责逻辑运算" },
  LATCH: { id: "LATCH", name: "LATCH", areaWeight: 6, desc: "锁存器，负责保存状态" },
};

/**
 * 晶体管单价的显示格式化（BNB/颗）。
 *
 * ⚠️ **不能统一用 toFixed(5)**：官方处理器的价差跨了数量级——
 *   Behemoth NAND  ≈ 0.601
 *   TapeOut NAND   ≈ 0.053
 * 固定 5 位小数在更低价量级上会把差别抹平（NAND 与 LATCH 之间的
 * 价差直接消失，看起来是同一个价）。
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
 * 四种「处理器 × 晶体管」组合，对应官方晶体管市场的两个晶体管合约。
 *
 * ⚠️ **能买到 ≠ 能挖矿**。这四条（两个可挖矿处理器 × NAND/LATCH）都具备挖矿资格。
 * T-59：Genesis CPU 的两条晶体管记录已删除（不能出矿，不再作为可开期的晶体管来源）。
 *
 * priceBnb 是**名义采购价**（BNB 计价），只用于链上没有单价时做开期测算，
 * 不代表市场现价；真实成本以 Campaign 记录的挂单/成交单价为准。
 */
export const TRANSISTORS = [
  {
    id: "TAPE_OUT_NAND",
    processor: "TapeOut",
    part: "NAND",
    name: "TapeOut NAND",
    contract: "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087",
    tokenId: 0,
    priceBnb: 0.0561,
    mintPriceBnb: 0.0005,
  },
  {
    id: "TAPE_OUT_LATCH",
    processor: "TapeOut",
    part: "LATCH",
    name: "TapeOut LATCH",
    contract: "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087",
    tokenId: 1,
    priceBnb: 0.0525,
    mintPriceBnb: 0.0005,
  },
  {
    id: "BEHEMOTH_NAND",
    processor: "Behemoth",
    part: "NAND",
    name: "Behemoth NAND",
    contract: "0xE2DfD802081C7a05341E20b6582b04b908e8550c",
    tokenId: 0,
    priceBnb: 0.42011,
    mintPriceBnb: 0.0005,
  },
  {
    id: "BEHEMOTH_LATCH",
    processor: "Behemoth",
    part: "LATCH",
    name: "Behemoth LATCH",
    contract: "0xE2DfD802081C7a05341E20b6582b04b908e8550c",
    tokenId: 1,
    priceBnb: 0.23131,
    mintPriceBnb: 0.0005,
  },
];

export const DEFAULT_TRANSISTOR = "BEHEMOTH_NAND";

export function findTransistor(id) {
  return TRANSISTORS.find((t) => t.id === id) || TRANSISTORS.find((t) => t.id === DEFAULT_TRANSISTOR);
}

/**
 * 找到同一处理器下的**另一类**晶体管型号（NAND ↔ LATCH）。
 *
 * ⚠️ 这里必须是按数据查表，不能写成
 * `processor === "Behemoth" ? "BEHEMOTH_LATCH" : "TAPE_OUT_LATCH"`
 * ——那种二元写法在处理器数量变化后会**静默取错价**：
 * 新处理器的 sibling 会被当成 TapeOut 的，采购成本直接算错一个数量级。
 *
 * 找不到时退回自身（调用方随后会拿到同一个型号的两份价，属可察觉的降级）。
 */
export function siblingTransistor(model) {
  const other = Object.values(PARTS).find((p) => p.id !== model.part);
  return (
    TRANSISTORS.find((t) => t.processor === model.processor && t.part === other?.id) || model
  );
}

/** 该处理器下的全部晶体管型号（NAND + LATCH），用于 UI 展示与遍历 */
export function transistorsOf(processor) {
  return TRANSISTORS.filter((t) => t.processor === processor);
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
 * 每颗晶体管的算力权重。
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
  TAPE_OUT_NAND: 0.0561,
  TAPE_OUT_LATCH: 0.0525,
  BEHEMOTH_NAND: 0.42011,
  BEHEMOTH_LATCH: 0.23131,
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

/** 单个晶体管的价格口径：快照价 → 目录基准价。 */
export function priceOf(transistorId, snapshot) {
  return quoteOf(snapshot).prices?.[transistorId] ?? findTransistor(transistorId).priceBnb;
}

/* ───────────────────────── 成本测算 ───────────────────────── */

/**
 * 按「晶体管数量 + 选定晶体管」算出这一期的全部参数。
 *
 * 晶体管数由开期人直接决定（就是链上 placeTransistorOrder 的数量），
 * 晶体管单价决定真实采购成本，两者相乘才是这一期的实际支出。
 * 募资总额因此是晶体管数量的反向决定因素：要烧更多颗，募集就得跟着涨。
 *
 * @param {object} params
 * @param {number} params.parts       晶体管总数（NAND + LATCH）。必须是正整数。
 * @param {string} params.transistorId 晶体管组合
 * @param {object} params.snapshot    报价（缺省 = 静态基准）
 * @param {number} [params.latchRatio] LATCH 占比（默认 0.2；时序构成可传 0.5）
 */
export function planTask({ parts, transistorId, snapshot, latchRatio }) {
  const model = findTransistor(transistorId);
  const processor = model.processor;
  const P = processorScale(processor);

  /**
   * 晶体管总数。
   *
   * 只接受正整数；非法值（0/负数/小数/非数字）退回 1。
   * 不能让 0 变成免费矿机，也不能静默把 12.5 取整成 13——
   * 数据层不该依赖 UI 拦截，这里必须自己守住。
   */
  const rawParts = Number(parts);
  const partsOk = Number.isFinite(rawParts) && rawParts >= 1 && Number.isInteger(rawParts);
  const totalParts = partsOk ? rawParts : 1;

  /**
   * NAND / LATCH 按比例拆分。
   * 同处理器的 NAND 与 LATCH 共用同一个合约地址，只差 tokenId，
   * 所以「选哪种晶体管」不是二选一，而是**按配比分别采购**。
   * NAND 吸收四舍五入的差值，保证两类之和恰好等于总数。
   */
  const ratio = latchRatio ?? 0.2;
  const latch = Math.round(totalParts * ratio);
  const nand = totalParts - latch;

  const sibling = siblingTransistor(model);
  /**
   * 两种晶体管分别按各自单价计价（NAND 与 LATCH 市价不同，Behemoth 差距尤其大）。
   *
   * 这里刻意按 part 归位而不是按「型号自身 / 另一类」——
   * 后者会让 priceNand 在传入 LATCH 型号时变成 LATCH 的价，字段名与内容对不上。
   */
  const priceMain = priceOf(model.id, snapshot);
  const priceOther = priceOf(sibling.id, snapshot);
  /** 按晶体管种类归位的单价，键就是 PARTS 的 id */
  const priceByPart = {
    NAND: model.part === "NAND" ? priceMain : priceOther,
    LATCH: model.part === "LATCH" ? priceMain : priceOther,
  };
  const costNand = nand * priceByPart.NAND;
  const costLatch = latch * priceByPart.LATCH;
  const partsCost = costNand + costLatch;

  /**
   * 权重：H = b* × P，P 为该处理器的每颗晶体管算力。
   *
   * 工本权重 b* 就是晶体管数量——烧多少颗就有多少算力，
   * 这是开期人调晶体管数能提高产出的原理。
   * 没有「设计溢价」：算力全部来自工本权重，没有可参照的外部难度系数。
   */
  const q = 1;
  const baseWeight = totalParts * P;
  const designPremium = 0;
  const hashpower = Math.round(baseWeight + designPremium);

  // 面积：NAND 一颗占 1，LATCH 一颗占 6（锁存单元面积更大）
  const area = totalParts + 6 * latch;

  /**
   * 挖矿闸门：面积超上限的期次只能进未验证池（分 1%）。
   * 闸门按面积而不是按晶体管数判定——LATCH 占 6 倍面积，同为 100 颗也可能一个过一个不过。
   */
  const capped = area > MINE_GATE_LIMIT;

  return {
    model,
    processor,
    processorScale: P,
    /** 按晶体管种类归位的单价（BNB/个）—— 键就是 PARTS 的 id */
    priceByPart,
    /** NAND 单价（BNB/个）。与型号无关，传 LATCH 型号时也是 NAND 的价 */
    priceNand: priceByPart.NAND,
    /** LATCH 单价（BNB/个） */
    priceLatch: priceByPart.LATCH,
    /** 另一类晶体管的单价 —— 兼容旧字段，等于 priceLatch */
    priceSibling: priceOther,
    /** 型号自身那一类的单价 */
    priceMain,
    priceOther,
    /** 两种晶体管各自的造价小计（BNB），相加等于 partsCost */
    costBreakdown: {
      NAND: { count: nand, price: priceByPart.NAND, cost: costNand },
      LATCH: { count: latch, price: priceByPart.LATCH, cost: costLatch },
    },
    nand,
    latch,
    latchRatio: ratio,
    /** 实际晶体管总数（= nand + latch） */
    totalParts,
    /** 晶体管总价（BNB）—— 真正的采购成本 */
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
 *   1. 目标募资总额 = 晶体管成本 / 理想占比（默认 45%，落在健康区间 20%-75% 的中部）
 *   2. 每份 BNB 从常见档位里选**不超过**目标募资总额除以最小份数的最大档，
 *      避免出现「份数只有 3 份」这种没法分的方案
 *   3. 总份数 = 目标募资总额 / 每份，向上取整到 5 的倍数（份数好数）
 *   4. 校验：份数 × 单价 必须仍 ≥ 晶体管成本，否则补份数
 *
 * 募资总额与成本同为 BNB 计价，全程不需要汇率换算。
 */
export function designOffering({ parts, transistorId, snapshot, targetRatio = COST_RATIO_IDEAL, latchRatio = null }) {
  const plan = planTask({ parts, transistorId, snapshot, latchRatio });
  const cost = plan.partsCost;
  // 目标募资总额：让晶体管成本正好落在理想占比上
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
   *   - 晶体管数由开期人选定，不能靠选型调高成本
   *   - 募资总额有下限（minShares × 最低档单价）
   * 两者一夹，晶体管数太少就必然落在健康区间下方。这不是算法的缺陷，
   * 而是「这个晶体管数不该开一期」的事实，必须如实报出来而不是掩盖。
   */
  const floorCap = minShares * PRICE_TIERS[0];
  const bestRatio = floorCap > 0 ? cost / floorCap : Infinity;
  const cappedByTiers = bestRatio < COST_RATIO_MIN;

  return {
    plan,
    /** 实际生效的晶体管数（非法输入时已退回 1，与 plan.totalParts 同源） */
    parts: plan.totalParts,
    /** 每份 BNB（取自常见档位） */
    sharePriceBnb,
    /** 总份数（5 的倍数） */
    totalShares,
    /** 实际募资总额 = 份数 × 单价 */
    hardCapBnb: round4(hardCapBnb),
    /** 目标募资总额：晶体管成本 ÷ 理想占比，用于手动改份数后倒推单价 */
    targetCapBnb: round4(targetCap),
    /** 晶体管采购成本（BNB） */
    costBnb: round4(cost),
    /** 成本占募资总额比例 */
    costRatio: round4(actualRatio),
    /** 晶体管涨价多少倍就不再够买 */
    priceTolerance: cost > 0 ? round4(hardCapBnb / cost) : 0,
    /** 采购后余量 */
    marginBnb: round4(hardCapBnb - cost),
    /** 是否落在健康区间 */
    healthy: actualRatio >= COST_RATIO_MIN && actualRatio <= COST_RATIO_MAX,
    /** 占比过高（风险薄） */
    tooRisky: actualRatio > COST_RATIO_MAX,
    /** 晶体管太少：即使压到最低募资总额，成本占比也够不到健康下限 */
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
 * 先厘清一件事：**NAND 与 LATCH 不是二选一**。
 * 同处理器的 NAND 与 LATCH 共用同一个 `transistors` 合约，
 * 只差 tokenId（0=NAND, 1=LATCH），两者按配比分别采购。
 *
 * 所以真正的选择维度只有一个：**用哪个处理器烧**。
 *
 *   Behemoth(P=6)：权重是 TapeOut 的 6 倍，但晶体管贵约 7.5 倍
 *   TapeOut (P=1)：晶体管便宜，权重低
 *
 * T-59：官方 Genesis CPU（P=0，永远不出矿）已整体移除，不再作为可选处理器。
 */

/**
 * 处理器 -> 代表性晶体管id。
 * 只取 NAND 作代表：成本/权重在 planTask 里按 NAND:LATCH 配比混合计算，选谁当代表都不影响结果。
 *
 * ⚠️ 查表而不是三元表达式：写死 `processor === "TapeOut" ? ... : "BEHEMOTH_NAND"`
 * 会在处理器数量变化后把新处理器错认成 Behemoth（晶体管价差可达数千倍）。
 */
export function transistorIdFor(processor) {
  return transistorsOf(processor)[0]?.id || DEFAULT_TRANSISTOR;
}

/**
 * 全部可选的官方处理器 id，顺序即 UI 展示顺序。
 * T-59：Genesis 已移除（无挖矿产出资格）。
 */
export const PROCESSOR_IDS = ["Behemoth", "TapeOut"];



/**
 * 反向：给定募资总额，推荐能负担的晶体管数量区间。
 * 用于开期页在募资总额固定时给出「大概能烧多少颗」的范围。
 */
export function suggestPartRange({ hardCapBnb, snapshot, transistorId }) {
  const model = findTransistor(transistorId);
  const priceMain = priceOf(model.id, snapshot);
  const sib = siblingTransistor(model);
  const priceOther = priceOf(sib.id, snapshot);

  // 按 NAND/LATCH 两类均价的混合价粗估（actual 配比在 planTask 里精算）
  const avgPrice = (priceMain + priceOther) / 2;
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

