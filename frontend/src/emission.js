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
 * 链上实读（mining 合约 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46，2026-10-18）：
 *   totalVerifWeight()   = 1,579,178
 *   totalUnverWeight()   = 40,680
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
  verified: 1_579_178,
  unverified: 40_680,
  source: "chain",
  /** 区块时间戳口径 */
  updatedAt: 1792157941,
  /** mining 合约地址，供 UI 展示与人工核对 */
  contract: "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46",
};

/**
 * 挖矿闸门：门数超过抽检上限，链上跑不完官方向量，
 * 进不了已验证池，只能进未验证池（分 1%）。
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


/** 第 N 纪元的日产（每纪元减半） */
export function eraDaily(eraIndex) {
  return NETWORK_DAILY_EMISSION / Math.pow(2, Math.max(0, eraIndex));
}


