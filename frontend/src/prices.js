import { fetchBnbUsdt, fetchMarketPrices, fetchTaskBook, fetchTapeOutData, LATCH_RATIO } from "./tapeout.js";
import { MINE_GATE_LIMIT, NETWORK_DAILY_EMISSION, NETWORK_WEIGHT, POOL, poolDailyYield } from "./emission.js";

export { fetchTaskBook, fetchTapeOutData, fetchBnbUsdt, LATCH_RATIO };

/**
 * TapeOut 挖矿机制模型。
 *
 * 依据公开资料的真实机制，而非虚构的制程节点：
 *   - 只有 TapeOut 和 Behemoth 两个创世处理器上的电路具备挖矿资格
 *   - 元件只有 NAND（与非门）与 LATCH（锁存器）两种，权重相同（都算 1）
 *   - 处理器系数 P：Behemoth = 6，TapeOut = 1
 *   - 分配权重 H = (b* + K_task × q) × P
 *   - 元件价格以 BNB 计价（mint 价 0.0005 BNB，二级市场 Behemoth NAND 已涨至约 0.0085 BNB）
 *
 * 术语对照：
 *   g     总元件数（NAND + LATCH）
 *   s     LATCH 数量（面积权重是普通门的 6 倍）
 *   A     设计面积 = g + 6s
 *   d     最长组合路径深度
 *   C     设计成本 = A × max(d,1)³（深度被三次方惩罚）
 *   C_ref 官方参考实现成本（出题时冻结）
 *   q     质量系数 = clamp(C_ref / C, 0.25, 4)
 *   b*    工本 = 实际烧掉的元件数
 *   K_task 题目参考工本
 *   P     处理器系数
 *   H     分配权重，直接决定 BEM 分配份额
 */

/** 处理器（创世处理器，只有这两个有挖矿资格） */
export const PROCESSORS = {
  TapeOut: { id: "TapeOut", name: "TapeOut", scale: 1, desc: "供应量大，成本低" },
  Behemoth: { id: "Behemoth", name: "Behemoth", scale: 6, desc: "4 位链上 CPU，早期支持者溢价" },
};

/** 元件类型。NAND 与 LATCH 权重相同（都是 1），区别在面积与市场价格。 */
export const PARTS = {
  NAND: { id: "NAND", name: "NAND", areaWeight: 1, desc: "与非门，负责逻辑运算" },
  LATCH: { id: "LATCH", name: "LATCH", areaWeight: 6, desc: "锁存器，负责保存状态" },
};

/**
 * 四种可挖矿的「处理器 × 元件」组合。
 * 只有这四种能挖矿——其他处理器创建的电路没有挖矿资格。
 *
 * priceBnb 是二级市场参考价（BNB 计价）。
 * Behemoth NAND 已从 mint 价 0.0005涨到约 0.0085 BNB（约 17 倍）。
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

/** 只有创世处理器上的元件具备挖矿资格 */
export function isMineable(processor) {
  return Object.prototype.hasOwnProperty.call(PROCESSORS, processor);
}

export function processorScale(name) {
  return PROCESSORS[name]?.scale || 1;
}

/* ────────────────────────── 价格源 ────────────────────────── */

/**
 * 价格源。元件价格以 BNB 计价，与真实市场一致。
 * 真实接入时替换 `fetchPriceSnapshot`（DEX 订单簿 / 合约报价）。
 */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function baseSnapshot() {
  return {
    ts: Date.now(),
    bnbUsdt: 600,
    /** 各元件的 BNB 单价 */
    prices: Object.fromEntries(TRANSISTORS.map((t) => [t.id, t.priceBnb])),
  };
}

function drift(from, pct, rand) {
  const shock = (rand() - 0.5) * 2 * pct;
  return Math.max(from * (1 + shock), from * 0.2);
}

/**
 * 取一次实时报价。走 tapeout.net 的市场订单簿快照。
 * 网络失败时由 fetchMarketPrices 内部回落到本地兜底价。
 */
export async function fetchPriceSnapshot() {
  const market = await fetchMarketPrices();
  const prevBase = baseSnapshot();
  return {
    ts: market.ts,
    bnbUsdt: market.bnbUsdt,
    /** BNB 价是否来自实时行情（false = 用兜底价） */
    bnbLive: market.bnbLive,
    prices: market.prices,
    /** 合约地址、买盘、成交笔数等明细，供 UI 展示 */
    meta: market.meta,
    block: market.block,
    source: market.source,
    /** 兜底价与真实价的差异，供 UI 标注 */
    fallback: Object.fromEntries(
      TRANSISTORS.map((t) => [t.id, market.prices[t.id] !== prevBase.prices[t.id]]),
    ),
  };
}

export function createPriceFeed({ intervalMs = 5000, fetcher = fetchPriceSnapshot } = {}) {
  const listeners = new Set();
  let snapshot = { ...baseSnapshot(), loading: true, error: null, updatedAt: null };
  let timer = null;
  let inflight = false;
  let tick = 0;

  function emit() {
    const next = { ...snapshot };
    listeners.forEach((fn) => fn(next));
  }

  async function refresh() {
    if (inflight) return;
    inflight = true;
    snapshot = { ...snapshot, loading: true };
    emit();
    try {
      const data = await fetcher(Date.now() + tick * 7919);
      // 保留上一档价格，UI 据此判断涨跌并做高亮
      const prev = snapshot.prices;
      const dir = {};
      if (prev) {
        for (const key of Object.keys(data.prices || {})) {
          if (typeof prev[key] === "number" && prev[key] !== data.prices[key]) {
            dir[key] = data.prices[key] > prev[key] ? "up" : "down";
          }
        }
      }
      snapshot = { ...data, prevPrices: prev, dir, loading: false, error: null, updatedAt: data.ts };
      tick += 1;
    } catch (error) {
      snapshot = { ...snapshot, loading: false, error: error?.message || "取价失败" };
    } finally {
      inflight = false;
      emit();
    }
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => snapshot,
    refresh,
    start() {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function isStale(snapshot, intervalMs = 5000) {
  if (!snapshot?.updatedAt) return true;
  return Date.now() - snapshot.updatedAt > intervalMs * 2;
}

/* ────────────────── 设计成本与分配权重（H 公式） ────────────────── */

/**
 * 计算设计的面积与成本。
 *
 * A = g + 6s   面积：LATCH 面积权重是普通门的 6 倍
 * C = A × max(d,1)³   成本：深度被三次方惩罚（防止用超长链堆元件）
 */
export function designMetrics({ nand = 0, latch = 0, depth = 1 }) {
  const g = nand + latch;
  const s = latch;
  const area = g + PARTS.LATCH.areaWeight * s;
  const d = Math.max(1, Number(depth) || 1);
  const cost = area * Math.pow(d, 3);
  return { g, s, area, depth: d, cost };
}

/**
 * 质量系数 q = clamp(C_ref / C, 0.25, 4)。
 * 你的设计成本越低（越优），q 越大，最多打满 4 倍。
 */
export function qualityFactor(cost, refCost) {
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(refCost) || refCost <= 0) return 1;
  return Math.min(4, Math.max(0.25, refCost / cost));
}

/**
 * 分配权重 H = (b* + K_task × q) × P
 *
 * @param {object} params
 * @param {number} params.nand实际烧掉的 NAND 数
 * @param {number} params.latch     实际烧掉的 LATCH 数
 * @param {number} params.depth     最长路径深度
 * @param {number} params.refCost   官方参考实现成本 C_ref（出题冻结）
 * @param {number} params.refParts  官方参考工本 K_task
 * @param {string} params.processor 处理器
 * @param {boolean} params.optimal  是否该题最优首创（决定能否拿满设计溢价）
 */
export function computeHashpower({ nand, latch, depth = 1, refCost, refParts, processor, optimal = true }) {
  const { g, area, cost } = designMetrics({ nand, latch, depth });
  const q = qualityFactor(cost, refCost);
  const P = processorScale(processor);
  const bStar = g;
  const K = Number(refParts) || 0;
  // 最优首创才有完整设计溢价；非最优只能拿工本
  const premium = optimal ? K * q : 0;
  // 权重取整：链上按整数份额分配
  const hashpower = Math.round((bStar + premium) * P);
  return {
    nand,
    latch,
    parts: g,
    area,
    depth: Math.max(1, Number(depth) || 1),
    cost,
    refCost,
    q: Math.round(q * 1000) / 1000,
    refParts: K,
    optimal,
    processor,
    processorScale: P,
    /** 工本部分 */
    baseWeight: Math.round(bStar * P),
    /** 设计溢价部分 */
    designPremium: Math.round(premium * P),
    hashpower,
  };
}

/* ────────────────────── 选型与 BNB 需求测算 ────────────────────── */

/**
 * 按选定元件与实时报价，测算募资总额的购买力。
 *
 * 项目方统一流片：用户不自己设计电路，权重由图纸决定。
 * 所以这里不反推「达标需要多少」，而是看「募资总额按当前报价能买多少元件」——
 * 买不够图纸所需元件就会流片失败并全额退款。
 *
 * @param {object} params
 * @param {string} params.transistorId 元件组合
 * @param {number} params.needParts    本期图纸所需的元件数
 * @param {number} params.hardCapBnb   募资总额（BNB）
 * @param {object} params.snapshot     实时报价
 */
export function planTransistor({ transistorId, needParts, hardCapBnb, snapshot }) {
  const model = findTransistor(transistorId);
  const priceBnb = snapshot?.prices?.[model.id] ?? model.priceBnb;
  const P = processorScale(model.processor);

  // 募资总额按当前报价能买多少元件
  const affordableParts = priceBnb > 0 ? Math.floor(hardCapBnb / priceBnb) : 0;
  // 工本口径能提供的权重（不含设计溢价，仅用于横向比较）
  const baseWeight = affordableParts * P;

  return {
    model,
    priceBnb,
    processor: model.processor,
    processorScale: P,
    partType: model.part,
    /** 本期图纸需要的元件数 */
    needParts,
    /** 募资总额能买的元件数 */
    affordableParts,
    /** 流片实际要花多少 BNB（图纸所需元件 × 当前单价）*/
    needBnb: needParts * priceBnb,
    /** 工本权重 = 募资总额可买元件数 × P（不含设计溢价，仅供横向比较）*/
    baseWeight,
    hardCapBnb,
    /** 每 BNB 能买到多少权重 —— 衡量性价比 */
    hashPerBnb: priceBnb > 0 ? P / priceBnb : 0,
    /** 流片后募资总额剩余（BNB）*/
    marginBnb: hardCapBnb - needParts * priceBnb,
    /** 募资总额买不买得起图纸所需元件 */
    covered: affordableParts >= needParts,
    shortParts: Math.max(0, needParts - affordableParts),
  };
}

/** 在给定募资总额下横向比较 4 种元件，供开期页选型参考 */
export function compareTransistors({ needParts, hardCapBnb, snapshot }) {
  return TRANSISTORS.map((t) =>
    planTransistor({ transistorId: t.id, needParts, hardCapBnb, snapshot }),
  );
}

/* ───────────────────────── 选题与成本测算 ───────────────────────── */

/**
 * 按官方题目 + 选定元件，算出这一期的全部参数。
 *
 * 题目决定了元件数 g 与深度 d，而元件单价随市场实时变动，
 * 两者相乘才是真正的流片成本。选题因此是募资总额的反向决定因素：
 * 选了中级题，募资总额就必须跟着涨。
 *
 * @param {object} params
 * @param {object} params.task       官方题目（fetchTaskBook 的一项）
 * @param {string} params.transistorId 元件组合
 * @param {object} params.snapshot   实时报价
 * @param {number} [params.latchRatio] 覆盖 LATCH 占比（默认按题型）
 * @param {boolean} [params.optimal] 是否最优首创（决定能否拿设计溢价）
 * @param {number|null} [params.partCount] 流片元件总数覆盖值。
 *   不传（null/undefined）= 用题目给的 g；传了则按题目原有配比等比缩放，
 *   用于开期人手动指定要烧多少颗元件。
 */
export function planTask({ task, transistorId, snapshot, latchRatio, optimal = false, partCount = null }) {
  const model = findTransistor(transistorId);
  const processor = model.processor;
  const P = processorScale(processor);

  /**
   * 流片元件总数。
   *
   * 题目给的 g 是「图纸要求的最少元件数」，也是设计溢价 K_task 的基准。
   * 开期人可以手动改：**多烧**增加工本权重（提高产出），
   * **少烧**省成本但权重下降，且低于 g 就拿不到对应的设计溢价。
   *
   * 只接受正整数；非法值（0/负数/小数/非数字）退回题目值。
   * 不能让 0 变成免费矿机，也不能静默把 12.5 取整成 13——
   * 数据层不该依赖 UI 拦截，这里必须自己守住。
   */
  const rawOverride = Number(partCount);
  const overrideOk = partCount !== null && partCount !== undefined && partCount !== "" &&
    Number.isFinite(rawOverride) && rawOverride >= 1 && Number.isInteger(rawOverride);
  const totalParts = overrideOk ? rawOverride : task.g;
  /** 用户是否真的改了数量——UI 要标明「已手改」还是「按题目」 */
  const partCountOverridden = overrideOk && totalParts !== task.g;

  /**
   * NAND / LATCH 数量：优先用题库给的精确值（tasks.json 里有 nand 与 latch 字段），
   * 缺失时才回落到按题型估算的比例。
   *
   * 同处理器的 NAND 与 LATCH 共用同一个合约地址，只差tokenId，
   * 所以「选哪种元件」不是二选一，而是**按题目配比分别采购**。
   */
  const hasExact = Number.isFinite(task.nand) && Number.isFinite(task.latch);
  const ratio = latchRatio ?? (hasExact
    ? task.latch / Math.max(1, task.g)
    : LATCH_RATIO[task.kind] ?? LATCH_RATIO.comb);
  /**
   * 手动改数量时按题目原有配比等比缩放，而不是直接套题型默认比例——
   * 否则 54 NAND + 14 LATCH 的题改成 68 个会变成 14 个 LATCH，配比面目全非。
   * 用四舍五入后由 NAND 吸收差值，保证两类之和恰好等于总数。
   */
  const latch = partCountOverridden
    ? Math.round(totalParts * ratio)
    : (hasExact ? Number(task.latch) : Math.round(task.g * ratio));
  const nand = partCountOverridden
    ? totalParts - latch
    : (hasExact ? Number(task.nand) : Math.max(0, task.g - latch));

  const sibling = findTransistor(
    model.part === "NAND"
      ? (processor === "Behemoth" ? "BEHEMOTH_LATCH" : "TAPE_OUT_LATCH")
      : (processor === "Behemoth" ? "BEHEMOTH_NAND" : "TAPE_OUT_NAND"),
  );
  /**
   * 两种元件分别按各自实时价计价（NAND 与 LATCH 市价不同，Behemoth 差距尤其大）。
   *
   * 这里刻意按 part 归位而不是按「型号自身 / 另一类」——
   * 后者会让 priceNand 在传入 LATCH 型号时变成 LATCH 的价，字段名与内容对不上。
   */
  const priceOf = (m) => snapshot?.prices?.[m.id] ?? m.priceBnb;
  const priceMain = priceOf(model);
  const priceOther = priceOf(sibling);
  /** 按元件种类归位的实时单价，键就是 PARTS 的 id */
  const priceByPart = {
    NAND: model.part === "NAND" ? priceMain : priceOther,
    LATCH: model.part === "LATCH" ? priceMain : priceOther,
  };
  const costNand = nand * priceByPart.NAND;
  const costLatch = latch * priceByPart.LATCH;
  const partsCost = costNand + costLatch;

  /**
   * 权重：H = (b* + K_task × q) × P，q 固定 1（项目方统一图纸 = 复制参考）。
   *
   * 工本权重 b* 按**实际流片数量**算——烧多少颗就有多少工本，
   * 这是开期人手动改数量能提高产出的原理。
   * 设计溢价 K_task 是题目给定的固定值，不随数量变化：
   * 少烧也不会把设计溢价按比例缩水（那会让「少烧」变成双重惩罚）。
   */
  const q = 1;
  const baseWeight = totalParts * P;
  const designPremium = optimal ? task.K * q * P : 0;
  const hashpower = Math.round(baseWeight + designPremium);

  // 面积与成本，用于校验设计是否优于参考
  const area = totalParts + 6 * latch;
  const cost = area * Math.pow(Math.max(1, task.d), 3);

  /**
   * 挖矿闸门：按**实际流片数量**判定，不是按题目 g。
   * 手动加了元件就可能顶到闸门，那必须如实标记为 capped，
   * 不能让开期人加到超过上限却还按已验证池算权重。
   */
  const capped = totalParts > MINE_GATE_LIMIT;
  // 被闸门拦住时只能靠工本权重 b* × P，拿不到设计溢价
  const effectiveH = capped ? totalParts * P : hashpower;
  // 已验证池取 H；未验证池取工本 b* × P
  const dailyVerif = poolDailyYield(effectiveH, { pool: "verified" });
  const dailyUnver = poolDailyYield(totalParts * P, { pool: "unverified" });
  const dailyBem = capped ? dailyUnver : dailyVerif;

  return {
    task,
    model,
    processor,
    processorScale: P,
    /** 按元件种类归位的实时单价（BNB/个）—— 键就是 PARTS 的 id */
    priceByPart,
    /** NAND 单价（BNB/个）。与型号无关，传 LATCH 型号时也是 NAND 的价 */
    priceNand: priceByPart.NAND,
    /** LATCH 单价（BNB/个） */
    priceLatch: priceByPart.LATCH,
    /** 另一类元件的单价 —— 兼容旧字段，等于 priceLatch */
    priceSibling: priceOther,
    /** 型号自身那一类的单价 */
    priceMain,
    priceOther,
    /** 两种元件各自的造价小计（BNB），相加等于 partsCost */
    costBreakdown: {
      NAND: { count: nand, price: priceByPart.NAND, cost: costNand },
      LATCH: { count: latch, price: priceByPart.LATCH, cost: costLatch },
    },
    nand,
    latch,
    latchRatio: ratio,
    /** 是否用了题库的精确配比 */
    exactRatio: hasExact,
    /** 实际流片元件总数（= nand + latch） */
    totalParts,
    /** 题目原本给的元件数（开期人没改时与之相等） */
    baseParts: task.g,
    /** 开期人是否手动改过元件数（UI 用来标「已手改」） */
    partCountOverridden,
    /** 元件总价（BNB）—— 真正的流片成本 */
    partsCost,
    q,
    baseWeight,
    designPremium,
    hashpower: effectiveH,
    /** 名义权重（含溢价）。被闸门拦住时实际拿不到。 */
    nominalHashpower: hashpower,
    area,
    cost,
    refCost: task.C,
    optimal,
    /** 是否被挖矿闸门拦住 */
    capped,
    /** 所在池 */
    pool: capped ? "unverified" : "verified",
    /** 两个池各能产多少 BEM/天 */
    dailyVerif: Math.round(dailyVerif * 10000) / 10000,
    dailyUnver: Math.round(dailyUnver * 10000) / 10000,
    dailyBem: Math.round(dailyBem * 10000) / 10000,
    /** 每 BNB 买到多少权重 */
    hashPerBnb: partsCost > 0 ? hashpower / partsCost : 0,
    /**
     * 投入产出比（按 BEM 计价）。
     * 这是官网没有直接给、但用户最需要的数字：
     *   花多少 BNB 买元件，90 天能产多少 BEM
     * 注意 BEM 需要按市价折算 BNB 才可比。
     */
    roi: {
      costBnb: Math.round(partsCost * 10000) / 10000,
      dailyBem: Math.round(dailyBem * 10000) / 10000,
      out90: Math.round(dailyBem * 90 * 100) / 100,
      /** 需按 BEM/USDT 折算，调用方补价格 */
    },
  };
}

/** 为一道题推荐能覆盖成本的最小募资总额（含 30% 安全垫） */
export function suggestHardCap({ task, transistorId, snapshot, cushion = 0.3 }) {
  const plan = planTask({ task, transistorId, snapshot });
  const bnb = plan.partsCost * (1 + cushion);
  return {
    plan,
    /** 建议募资总额（BNB） */
    bnb,
    /** 换算成USDT（按600 汇率，仅供填写参考） */
    usdt: bnb * 600,
  };
}

/** 常见的每份 BNB 档位。选档而不是算任意小数，让份价好记、也好在规则页里说明。 */
const PRICE_TIERS = [0.05, 0.1, 0.25, 0.5, 0.685, 1, 2.5, 5, 10];

/**
 * ══════════════════════════════════════════════════════════════
 * 发行方案设计：一次性给出「每份 BNB」与「总份数」
 * ══════════════════════════════════════════════════════════════
 *
 * 之前只倒推份数、保留手填单价，导致每份 BNB 是一个没有依据的孤立数字——
 * 用户得自己猜「0.685 是怎么来的」。这里把两个参数当成一个整体来设计：
 *
 *   1. 目标募资总额 = 流片成本 / 理想占比（默认 45%，落在健康区间 20%-75% 的中部）
 *      —— 低于这个数说明保护形同虚设，高于则抗涨价能力太薄
 *   2. 每份 BNB 从常见档位里选**不超过**目标募资总额除以最小份数的最大档，
 *      避免出现「份数只有 3 份」这种没法分的方案
 *   3. 总份数 = 目标募资总额 / 每份，向上取整到 5 的倍数（份数好数）
 *   4. 校验：份数 × 单价 必须仍≥ 流片成本，否则降一档单价重算
 *
 * 募资总额与成本同为 BNB 计价，全程不需要汇率换算。
 *
 * @param {object} params
 * @param {object} params.task       官方题目
 * @param {string} params.transistorId 元件组合
 * @param {object} params.snapshot   实时报价
 * @param {number} [params.targetRatio] 成本占募资总额的目标比例（默认 0.45）
 * @param {number} [params.partCount] 开期人手动指定的流片元件数（不传= 用题目 g）
 * @returns {object} { sharePriceBnb, totalShares, hardCapBnb, plan, ... }
 */
export function designOffering({ task, transistorId, snapshot, targetRatio = COST_RATIO_IDEAL, partCount = null }) {
  const plan = planTask({ task, transistorId, snapshot, partCount });
  const cost = plan.partsCost;
  // 目标募资总额：让流片成本正好落在理想占比上
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
  // 取整到 5 的倍数会向下截断，补回来；仍不够则降档重算
  while (sharePriceBnb * totalShares < cost && totalShares < 100000) {
    totalShares += 5;
  }

  const hardCapBnb = sharePriceBnb * totalShares;
  const actualRatio = hardCapBnb > 0 ? cost / hardCapBnb : Infinity;
  /**
   * 占比下限：受两个硬约束挤压——
   *   - 元件数由题目写死，不能靠选型调高成本
   *   - 募资总额有下限（minShares × 最低档单价）
   * 两者一夹，题目太小就必然落在健康区间下方。这不是算法的缺陷，
   * 而是「这道题不值得开一期」的事实，必须如实报出来而不是掩盖。
   */
  const floorCap = minShares * PRICE_TIERS[0];
  const bestRatio = floorCap > 0 ? cost / floorCap : Infinity;
  const cappedByTiers = bestRatio < COST_RATIO_MIN;

  return {
    plan,
    /** 每份 BNB（取自常见档位） */
    sharePriceBnb,
    /** 总份数（5 的倍数） */
    totalShares,
    /** 实际募资总额 = 份数 × 单价 */
    hardCapBnb: round4(hardCapBnb),
    /**
     * 目标募资总额：流片成本 ÷ 理想占比。
     *
     * 手动输入总份数后，用它倒推单价：`每份 = 目标募资总额 ÷ 份数`。
     * 这样用户只要定了份数，单价自动算出来，不用自己去凑。
     */
    targetCapBnb: round4(targetCap),
    /** 流片成本（BNB） */
    costBnb: round4(cost),
    /** 成本占募资总额比例 */
    costRatio: round4(actualRatio),
    /** 元件涨价多少触发退款 */
    priceTolerance: cost > 0 ? round4(hardCapBnb / cost) : 0,
    /** 流片后余量 */
    marginBnb: round4(hardCapBnb - cost),
    /** 是否落在健康区间 */
    healthy: actualRatio >= COST_RATIO_MIN && actualRatio <= COST_RATIO_MAX,
    /** 占比过高（风险薄） */
    tooRisky: actualRatio > COST_RATIO_MAX,
    /**
     * 题目太小：即使把募资总额压到最低（20 份 × 最低档单价），
     * 成本占比也够不到健康下限。这时应该换题目，不是调参数能救的。
     */
    tooSmall: cappedByTiers,
    /** 该题能达到的最好占比（上限），用于解释为什么够不到 */
    bestRatio: round4(bestRatio),
    /** 相对目标占比的偏差 */
    deviation: round4(Math.abs(actualRatio - targetRatio)),
    /** 本方案的权重与日产 */
    hashpower: plan.hashpower,
    dailyBem: plan.dailyBem,
  };
}

/** 列出所有题目，按元件数升序，便于Owner 由易到难挑选 */
export function listTasks(book, { tier, keyword, kind } = {}) {
  let list = book?.tasks || [];
  if (tier) list = list.filter((t) => t.tier === tier);
  if (kind) list = list.filter((t) => t.kind === kind);
  if (keyword) {
    const k = String(keyword).toLowerCase();
    list = list.filter(
      (t) =>
        String(t.name).toLowerCase().includes(k) ||
        String(t.group || "").toLowerCase().includes(k) ||
        String(t.id) === k,
    );
  }
  return list;
}

/** 题库里的难度分档，供 UI 做筛选按钮 */
export function taskTiers(book) {
  const set = new Set((book?.tasks || []).map((t) => t.tier));
  return [...set];
}

/**
 * ══════════════════════════════════════════════════════════════
 * 处理器选择：由用户在开期时手动指定，不再自动推导
 * ══════════════════════════════════════════════════════════════
 *
 * 先厘清一件事：**NAND 与 LATCH 不是二选一**。
 * 真实机制里同处理器的 NAND 与 LATCH 共用同一个 `transistors` 合约，
 * 只差 tokenId（0=NAND, 1=LATCH），且题目本身指定了各自的用量
 * （tasks.json 直接给了 `nand` 与 `latch`）。
 *
 * 所以真正的选择维度只有一个：**用哪个处理器烧**，这由开期人自己决定。
 *
 *   Behemoth(P=6)：权重是 TapeOut 的 6 倍，但元件贵约 7.5 倍
 *   TapeOut (P=1)：元件便宜，权重低
 */

/**
 * 处理器 -> 代表性元件 id。
 *
 * 只取 NAND 作代表：NAND 与 LATCH 同处理器的成本/权重在 planTask 里
 * 是按题目配比混合计算的，选谁当代表都不影响结果。
 */
export function transistorIdFor(processor) {
  return processor === "TapeOut" ? "TAPE_OUT_NAND" : "BEHEMOTH_NAND";
}

/** 全部可选的创世处理器 id，顺序即 UI 展示顺序 */
export const PROCESSOR_IDS = ["Behemoth", "TapeOut"];

/**
 * 横向比较两个可选处理器在「当前题目 + 当前募资总额 + 实时报价」下的表现。
 *
 * 只负责把账算清楚供开期人参考，**不做选择**——
 * 选哪个处理器是开期人的决定，系统不替他决定。
 *
 * @param {object} params
 * @param {object} params.task       官方题目
 * @param {number} params.hardCapBnb 募资总额（BNB）
 * @param {object} params.snapshot   实时报价
 * @param {boolean} [params.optimal] 是否最优首创（影响设计溢价）
 * @param {number} [params.partCount] 开期人手动指定的流片元件数
 * @returns {object[]} 两个处理器的方案，顺序同 PROCESSOR_IDS
 */
export function compareProcessors({ task, hardCapBnb, snapshot, optimal = false, partCount = null }) {
  const round4v = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
  return PROCESSOR_IDS.map((processorId) => {
    const p = planTask({ task, transistorId: transistorIdFor(processorId), snapshot, optimal, partCount });
    const ratio = hardCapBnb > 0 ? p.partsCost / hardCapBnb : Infinity;
    return {
      ...p,
      processorId,
      /** 元件组合 id（处理器的 NAND 代表） */
      transistorId: p.model.id,
      costRatio: round4v(ratio),
      affordable: hardCapBnb >= p.partsCost,
      /** 每 BNB 投入换到的权重 */
      weightPerBnb: p.partsCost > 0 ? round4v(p.hashpower / p.partsCost) : 0,
      /** 流片后剩余的 BNB */
      marginBnb: round4v(hardCapBnb - p.partsCost),
      /** 元件涨价多少倍就触发退款 */
      priceTolerance: p.partsCost > 0 ? round4v(hardCapBnb / p.partsCost) : 0,
    };
  });
}

/**
 * 针对某个已选处理器给一句风险提示。
 * 只描述事实与后果，不劝进也不劝退——选择权在开期人手里。
 *
 * 可负担性在这里按传入的 hardCapBnb 现场判断，不读plan.affordable——
 * 后者是算plan 时用另一个募资总额得出的，直接用会在募资总额变化后给出过期结论。
 */
export function adviseProcessor({ processorId, plan, hardCapBnb }) {
  const name = PROCESSORS[processorId]?.name || processorId;
  const cost = plan.partsCost;
  const affordable = hardCapBnb >= cost;
  const ratio = hardCapBnb > 0 ? cost / hardCapBnb : Infinity;
  const tolerance = cost > 0 ? hardCapBnb / cost : 0;
  const ratioPct = (ratio * 100).toFixed(1);
  if (!affordable) {
    return (
      `${name}：流片需 ${cost.toFixed(4)} BNB，募资总额只有 ${hardCapBnb.toFixed(4)} BNB，` +
      `执行时将买不到元件，本期判失败并全额退款`
    );
  }
  if (ratio < COST_RATIO_MIN) {
    return (
      `${name}：流片成本 ${cost.toFixed(4)} BNB 仅占募资总额 ${ratioPct}%，` +
      `执行时元件涨价 ${((tolerance - 1) * 100).toFixed(0)}% 才会触发退款，保护很厚但收益也低`
    );
  }
  if (ratio > COST_RATIO_MAX) {
    return (
      `${name}：流片成本占募资总额 ${ratioPct}%，偏高；元件涨价 ${((tolerance - 1) * 100).toFixed(0)}% 就触发退款，` +
      `缓冲较薄`
    );
  }
  return (
    `${name}：流片成本 ${cost.toFixed(4)} BNB 占募资总额 ${ratioPct}%，` +
    `权重 ${plan.hashpower}，元件涨价 ${((tolerance - 1) * 100).toFixed(0)}% 触发退款`
  );
}

/** 四位小数。与 fixtures.round4 同实现，此处独立定义以避免循环依赖。 */
const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/** 成本占募资总额的健康区间 */
export const COST_RATIO_MIN = 0.2;
export const COST_RATIO_MAX = 0.75;
/** 理想占比：越接近这个值，风险与收益越平衡 */
export const COST_RATIO_IDEAL = 0.45;

/**
 * 对单个题目，横向比较四种元件组合（NAND/LATCH × 两个处理器）。
 *
 * 开期页只用compareProcessors（两个处理器）；
 * 这个函数保留给需要看四种明细的场合。
 *
 * @param {object} params
 * @param {object} params.task    官方题目
 * @param {number} params.hardCapBnb 募资总额（BNB）
 * @param {object} params.snapshot 实时报价
 * @param {boolean} [params.optimal] 是否最优首创（影响设计溢价）
 * @returns {object[]} 按推荐度排序的方案列表
 */
export function rankTransistors({ task, hardCapBnb, snapshot, optimal = false }) {
  const plans = TRANSISTORS.map((t) =>
    planTask({ task, transistorId: t.id, snapshot, optimal }),
  ).map((p) => {
    const ratio = hardCapBnb > 0 ? p.partsCost / hardCapBnb : Infinity;
    const affordable = hardCapBnb >= p.partsCost;
    // 离理想占比的偏离度（0 = 完美）
    const deviation = Math.abs(ratio - COST_RATIO_IDEAL);
    return {
      ...p,
      costRatio: round4(ratio),
      affordable,
      deviation: round4(deviation),
      /** 每 BNB 投入换到的权重 —— 收益效率 */
      weightPerBnb: p.partsCost > 0 ? round4(p.hashpower / p.partsCost) : 0,
      /** 可买元件数（按主流元件价估） */
      affordableParts: p.priceMain > 0 ? Math.floor(hardCapBnb / p.priceMain) : 0,
      marginBnb: round4(hardCapBnb - p.partsCost),
    };
  });

  // 排序：可负担优先 > 占比更接近理想 > 权重更高
  plans.sort((a, b) => {
    if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
    if (Math.abs(a.deviation - b.deviation) > 0.001) return a.deviation - b.deviation;
    return b.hashpower - a.hashpower;
  });
  return plans;
}

/**
 * 反向：给定募资总额，推荐能负担的题目难度档位。
 * 用于「选题」页在募资总额固定时给出可选题目的范围。
 */
export function suggestTaskRange({ hardCapBnb, snapshot, transistorId, optimal = false }) {
  const model = findTransistor(transistorId);
  const priceMain = snapshot?.prices?.[model.id] ?? model.priceBnb;
  const priceOther = (() => {
    const sib = findTransistor(
      model.part === "NAND"
        ? (model.processor === "Behemoth" ? "BEHEMOTH_LATCH" : "TAPE_OUT_LATCH")
        : (model.processor === "Behemoth" ? "BEHEMOTH_NAND" : "TAPE_OUT_NAND"),
    );
    return snapshot?.prices?.[sib.id] ?? sib.priceBnb;
  })();

  // 先按 1:1 配比粗估，再用实际题目精算
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
