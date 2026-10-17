/**
 * BEM 产出机制 —— 独立模块，避免 fixtures ↔ prices 循环依赖。
 *
 * ══════════════════════════════════════════════════════════════
 * 数据来源：TapeOut 官网 + 链上实读（2026-10-16）
 * ══════════════════════════════════════════════════════
 *
 * 官方原文：「已验证池 {v}% 按 H 分，未验证池 {u}% 按 b* × P 分」
 *
 * 真实机制不是「权重 × 固定系数」，而是：
 *   我的日产 = 池日产 × (我的权重 / 全池总权重)
 *
 * 关键推论：
 *   1. 产出零和——全网权重增加，所有人产出同步下降
 *   2. 系数 = 池日产 / 全池权重，会持续变化，不是常数
 *   3. 官网明确提示「实际产出随全网算力变化」，不是承诺
 *
 * 链上实读（mining 合约 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46）：
 *   totalVerifWeight()   = 1,575,427
 *   totalUnverWeight()   = 40,823
 */

/** 全网理论日产 BEM（官网口径，对应第 1 纪元） */
export const NETWORK_DAILY_EMISSION = 7200;

/** BEM 总量上限 2,100 万（协议常量，与募资总额无关） */
export const BEM_HARD_CAP = 21_000_000;

/** 减半周期（天）。约 4 年 */
export const HALVING_PERIOD_DAYS = 1460;

/**
 * 挖矿池划分。
 * 官网：「已验证池 99% 按 H 分，未验证池 1% 按 b* × P 分」
 * 未验证池只能靠工本权重，拿不到设计溢价。
 */
export const POOL = {
  verified: { share: 0.99, basis: "h", label: "已验证池" },
  unverified: { share: 0.01, basis: "bstarP", label: "未验证池" },
};

/**
 * 全网权重。链上实读值。
 * 保守起见：若实读失败，用偏大的分母（让产出估算偏低，不高估收益）。
 */
export const NETWORK_WEIGHT = {
  verified: 1_575_427,
  unverified: 40_823,
  source: "chain",
  /** 区块时间戳口径 */
  updatedAt: 1792157941,
  /** mining 合约地址，供 UI 展示与人工核对 */
  contract: "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46",
};

/**
 * 挖矿闸门：门数超过抽检上限，链上跑不完官方向量，
 * 认领不了任何题目，只能进未验证池（分 1%）。
 * 官网原文：「{n} 门超过开挖抽检上限（约 {limit} 门），流片后只能进未验证池（分 1%）。」
 */
export const MINE_GATE_LIMIT = 1200;

/**
 * 计算某台矿机的日产 BEM。
 *
 * @param {number} hashpower 本矿机权重
 * @param {object} opts
 * @param {"verified"|"unverified"} opts.pool所在池
 * @param {number} opts.networkWeight 全池总权重（默认取实读值）
 * @param {number} opts.daily全网日产（默认 7,200）
 * @param {boolean} opts.capped 是否被挖矿闸门拦住（被拦住只能进未验证池）
 * @returns {number} BEM / 天
 */
export function poolDailyYield(hashpower, opts = {}) {
  const {
    pool = "verified",
    networkWeight,
    daily = NETWORK_DAILY_EMISSION,
    capped = false,
  } = opts;

  const target = capped ? "unverified" : pool;
  const total = networkWeight ?? NETWORK_WEIGHT[target] ?? 1;
  if (total <= 0 || hashpower <= 0) return 0;
  const poolDaily = daily * POOL[target].share;
  return (hashpower / total) * poolDaily;
}

/** 当前每权重日产（两池各一），供 UI 展示「当前系数」 */
export function currentRate(network = NETWORK_WEIGHT) {
  return {
    verifiedPerWeight: poolDailyYield(1, { pool: "verified", networkWeight: network.verified }),
    unverifiedPerWeight: poolDailyYield(1, { pool: "unverified", networkWeight: network.unverified }),
    networkWeight: network,
    dailyEmission: NETWORK_DAILY_EMISSION,
    hardCap: BEM_HARD_CAP,
    halvingDays: HALVING_PERIOD_DAYS,
    source: network.source,
  };
}

/** 第 N 纪元的日产（每纪元减半） */
export function eraDaily(eraIndex) {
  return NETWORK_DAILY_EMISSION / Math.pow(2, Math.max(0, eraIndex));
}

/**
 * 挖矿期内累计可分 BEM（考虑纪元减半，逐纪元折半累加）。
 * 90 天 << 一个纪元（1460 天），所以实际几乎不会跨纪元。
 */
export function cumulativeEmission(miningDays, startEra = 0) {
  let total = 0;
  let era = startEra;
  let remain = miningDays;
  while (remain > 0) {
    const span = Math.min(remain, HALVING_PERIOD_DAYS);
    total += eraDaily(era) * span;
    remain -= span;
    era += 1;
  }
  return total;
}

/**
 * 投资回报测算——官网没有直接给，但用户最需要。
 *
 * 真实成本不只是元件：还有服务费（我们收的）、BEM 价格波动、减半。
 * BEM 需按市价折算成 BNB 才可比；未给 BEM 价格时只返回 BEM 侧数字。
 *
 * @param {object} params
 * @param {number} params.costBnb      流片成本（BNB）
 * @param {number} params.dailyBem     日产（BEM）
 * @param {number} params.days         挖矿天数
 * @param {number} params.feeRate      服务费率（如 0.07）
 * @param {number} [params.bemUsdt]    BEM 市价（USDT）。给了才能算真实 ROI
 * @param {number} [params.bnbUsdt]    BNB 市价（USDT）
 */
export function roiOf({ costBnb, dailyBem, days, feeRate = 0, bemUsdt = 0, bnbUsdt = 0 }) {
  const grossBem = dailyBem * days;
  const feeBem = grossBem * feeRate;
  const netBem = grossBem - feeBem;
  const out = {
    costBnb,
    grossBem,
    feeBem,
    netBem,
    /** 净产出可覆盖多少比例的成本（需BEM 价格） */
    coverage: null,
    /** 回本天数（需 BEM 价格） */
    paybackDays: null,
    /** 扣服务费后是否覆盖成本 */
    netVsCost: null,
  };
  if (bemUsdt > 0 && bnbUsdt > 0) {
    const costUsdt = costBnb * bnbUsdt;
    const netUsdt = netBem * bemUsdt;
    out.coverage = costUsdt > 0 ? netUsdt / costUsdt : null;
    out.netVsCost = netUsdt - costUsdt;
    out.paybackDays = dailyBem > 0 ? costUsdt / (dailyBem * (1 - feeRate) * bemUsdt) : null;
  }
  return out;
}