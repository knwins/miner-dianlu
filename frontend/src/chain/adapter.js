// 把链上 readState 的结果适配成前端页面已在消费的 book / round 形状，
// 使主页面（认购/份数/转让/概览）无需改动即可展示真实测试网数据。
import { formatEther, formatUnits } from "ethers";
import { ROUND } from "../fixtures.js";
import { circuitIdFor } from "../prices.js";
import { processorFromCircuitContract } from "../tapeout.js";
import { getCampaignAddress } from "./client.js";
import { BEM_DECIMALS } from "./config.js";
import { rowState } from "../roundState.js";

const SCENE_NAME = ["funding", "executing", "mining"];
/** 与 Campaign.Phase 枚举对齐：0 None / 1 Buying / 2 Ready。挂市场单不是独立 phase。 */
const PHASE_NAME = [undefined, "buying", "ready"];

/** BNB wei → Number（18 位）。历史函数名 bem，实际只用于 BNB。 */
const bem = (v) => {
  try { return Number(formatEther(v)); } catch { return 0; }
};

/** BEM 最小单位 → Number（主网 8 位）。 */
const bemToken = (v) => {
  try { return Number(formatUnits(v ?? 0n, BEM_DECIMALS)); } catch { return 0; }
};

/** 由 deployments.campaignParams 生成页面使用的 round（未上链字段用 ROUND 兜底）。 */
export function roundFromDeployment(dep) {
  const p = dep.campaignParams || {};
  const sharePriceBnb = Number(p.sharePriceBnb ?? ROUND.sharePriceBnb);
  const totalShares = Number(p.totalShares ?? ROUND.totalShares);
  return {
    ...ROUND,
    id: 1,
    sharePriceBnb,
    totalShares,
    hardCapBnb: Number((sharePriceBnb * totalShares).toFixed(8)),
    /**
     * 服务费：链上有这个字段了（口径反转：服务费真正上链）。
     * 读部署记录里的 serviceFeeBps；没有记录时是 0。
     *
     * 注意：这里**不能**引用 state —— roundFromDeployment 没有 state 参数
     * （它只吃 deployments.json）。之前误写成 state.serviceFeeBps，
     * 一进页面初始化就 ReferenceError 崩白屏。
     */
    feePercent: Number(dep.serviceFeeBps ?? 0) / 100,
    serviceFeeBps: Number(dep.serviceFeeBps ?? 0),
    serviceFeeSet: Boolean(dep.serviceFeeSet),
    fundingDays: p.fundingDays ?? ROUND.fundingDays,
    executeDelayHours: 0,
    contract: dep.campaign || getCampaignAddress() || ROUND.contract,
    /** 链上不存在单一服务费收款地址 —— 用分成表 */
    feeRecipient: "",
    /** 分成表：链上有就优先用链上的 */
    feeShares: Array.isArray(dep.feeShares) ? dep.feeShares : [],
    netlistHash: null,
    /** 同 roundFromState：链上期次的电路数不从 fixtures 继承，链上真值走 book.circuitHeldCount */
    partCount: 0,
  };
}

/** 用链上权威字段覆盖 / 补齐 round（切换期次或刷新后调用）。 */
export function roundFromState(state, baseRound = ROUND, campaignIndex = 1) {
  const sharePriceBnb = bem(state.sharePriceBnb);
  const totalShares = Number(state.totalShares);
  return {
    ...baseRound,
    id: campaignIndex,
    sharePriceBnb,
    totalShares,
    hardCapBnb: Number((sharePriceBnb * totalShares).toFixed(8)),
    /**
     * 服务费：链上有这个字段了（口径反转：服务费真正上链，不再是前端本地记录）。
     * 读链上 serviceFeeBps（基点）；链上没设时是 0。
     */
    feePercent: Number(state.serviceFeeBps ?? 0) / 100,
    serviceFeeBps: Number(state.serviceFeeBps ?? 0),
    serviceFeeSet: Boolean(state.serviceFeeSet),
    executeDelayHours: 0,
    contract: state.campaign || getCampaignAddress() || baseRound.contract,
    /** 链上不存在单一服务费收款地址 —— 用分成表 */
    feeRecipient: "",
    feeShares: Array.isArray(state.feeShares) ? state.feeShares : [],
    netlistHash: null,
    /**
     * 电路数：链上模式**不能**继承 fixtures 的默认值。
     *
     * `...baseRound` 把本地演示期次（ROUND.partCount = 68）一起带进来了，
     * 于是链上每一期的估算都用 68 张算——链上根本没这个数。
     * 链上的电路数权威来源是 circuitHeldCount（买入并确认到账量），
     * 由 book.circuitHeldCount 承载；round 上这个字段只作测算种子，
     * 链上模式一律归零（planTask 会兜底到 1），不拿演示数据冒充链上事实。
     */
    partCount: 0,
    // 开期写入的 circuits 地址 = 官方 ERC721 电路集合（TapeOut / Behemoth）；不能沿用 ROUND 默认 Behemoth。
    processorId: processorFromCircuitContract(state.circuits) || null,
    circuitModelId: processorFromCircuitContract(state.circuits)
      ? circuitIdFor(processorFromCircuitContract(state.circuits))
      : null,
  };
}

/** 由链上状态生成 book。account 为当前连接地址（分账用）。 */
export function bookFromState(state, account, extra = {}) {
  const scene = SCENE_NAME[state.scene] || "funding";
  const phase = PHASE_NAME[state.phase];
  const self = state.self || {
    shares: 0n, escrow: 0n, claimed: 0n, refunded: 0n, pending: 0n, bemBalance: 0n, bnb: 0n,
  };
  const addr = String(account || "").toLowerCase();
  const bnb = bem(self.bnb);
  const listings = (state.listings || []).map((l) => {
    const remain = Number(l.shares);
    // 成交会把剩余份数减到 0 并关单；撤单则留下未成交份数。用合约字段区分，不扫 ListingTaken 日志。
    const status = l.open ? "open" : (remain === 0 ? "done" : "cancelled");
    /**
     * `shares` 是**剩余可买**份数（takeListing 的额度），合约里就这一份数据。
     * 展示「挂了多少份」必须用 Listed 事件还原的原始份数：
     * 全部成交后剩余会被减到 0，只看它就会把「挂了 1 份」显示成「— / 合计 0」。
     * listedShares 读不到（节点不给历史事件）时为 null，展示层退回剩余份数。
     */
    const listed = Number.isFinite(Number(l.listedShares)) && Number(l.listedShares) > 0
      ? Number(l.listedShares)
      : null;
    const taken = Number(l.takenShares) || 0;
    const shownShares = listed ?? remain;
    const totalWei = l.priceBnbPerShare * BigInt(shownShares);
    return {
      id: l.id,
      seller: l.seller,
      shares: remain,
      listedShares: listed,
      takenShares: taken,
      remainingShares: remain,
      priceBnbPerShare: bem(l.priceBnbPerShare),
      _priceWei: l.priceBnbPerShare,
      totalBnb: bem(totalWei),
      open: Boolean(l.open),
      status,
    };
  });

  return {
    _chain: true,
    scene,
    /**
     * Mining 时链上 phase 仍为 Ready。必须保留 executePhase，否则 phaseKeyOf 会回落成
     * buying，持仓页误显「确认到账」→ confirmCircuits 打出 WrongScene。
     */
    executePhase: scene === "executing" || scene === "mining"
      ? (phase || (scene === "mining" ? "ready" : "buying"))
      : undefined,
    sold: Number(state.sold),
    /**
     * 已售未退（当前债务）。「已售 X/Y」应该用这个，而不是 sold：
     * sold 是单调的历史事实，退款不会让它变小，用它展示会让已退款的期次
     * 一直显示「已售满」但实际没人可退。
     */
    outstandingShares: Number(state.outstandingShares ?? state.sold),
    mine: Number(self.shares),
    listingShares: Number(self.escrow),
    claimable: bem(self.pending),
    claimed: bem(self.claimed),
    listings,
    // 新版合约不再有实时 hashpower getter，统一用预估 estHashpower 展示。
    hashpower: Number(state.estHashpower),
    dailyBem: 0,
    harvestCount: 0,
    distributed: 0,
    feeBem: 0,
    executionFailed: state.executionFailed,
    soldOutAt: state.soldOutAt > 0 ? state.soldOutAt * 1000 : null,
    endsAt: scene === "funding" ? state.fundingDeadline * 1000 : undefined,
    bnbPool: bem(state.raisedBnb),
    refundedTotal: bem(state.totalRefunded),
    refundedSelf: bem(self.refunded),
    /**
     * 待领余款（wei）。余款改 pull 模式：不再推给持有人，
     * 持份人自己调 claimSurplus() 领。claimableSurplus 含尚未计提的可领部分。
     */
    pendingSurplusSelf: bem(self.claimableSurplus ?? self.pendingSurplus),
    pendingSurplusTotal: bem(state.totalPendingSurplus),
    /** 持有人可领的 BEM（官方挖矿产出按份额记账，claimBem 领取；8 位小数）。 */
    bemClaimable: bemToken(self.bemClaimable ?? 0n),
    /** 本期未领取的挖矿产出（BEM，按官方合约 pending 汇总；8 位小数）。 */
    miningPendingBem: bemToken(state.miningPendingBem ?? 0n),
    /**
     * 服务费是否已设定（链上）。
     * false = 还能改（只要还没人认购）；true = 已永久锁定。
     * 注意与「费率为 0」区分：serviceFeeSet == true 且 bps == 0 是「已锁定为不收费」。
     */
    serviceFeeSet: Boolean(state.serviceFeeSet),
    /** 本期服务费率（基点） */
    serviceFeeBps: Number(state.serviceFeeBps ?? 0),
    /** 累计挖矿净收益（已扣服务费）。真钱已并入持份人可领余款，owner 扫不走。 */
    revenuePool: bem(state.revenuePool ?? 0),
    bemBalance: 0,
    bnb,
    capped: false,
    owner: state.owner,
    /** 熔断中：入口（认筹/挂单/卖出/开矿/份额市场）全停，pull 与撤单仍可用。 */
    halted: Boolean(state.halted),
    selfAddress: account,
    totalShares: Number(state.totalShares),
    /** 累计买入张数（历史）；卖出后不变。 */
    circuitCount: Number(state.boughtCount ?? 0),
    circuitHeldCount: Number(state.circuitHeldCount ?? 0),
    estHashpower: Number(state.estHashpower),
    priceLock: bem(state.priceLock),
    /** 卖出侧读数：本期持有哪些电路、已挂单的有哪些、市场欠款。 */
    sellSide: Boolean(state.sellSide),
    listedCircuits: Array.isArray(state.listedCircuits) ? state.listedCircuits.map((c) => ({
      tokenId: String(c.tokenId),
      listingId: String(c.listingId),
      price: bem(c.price),
      cost: bem(c.cost || 0),
      miningStatus: Number(c.miningStatus) || 0,
      miningPending: c.miningPending || 0n,
      miningStopBlock: Number(c.miningStopBlock) || 0,
    })) : [],
    sellBids: Array.isArray(state.sellBids) ? state.sellBids.map((b) => ({
      id: String(b.id),
      tokenId: Number(b.tokenId),
      circuitTokenId: String(b.circuitTokenId ?? b.id),
      price: bem(b.price),
      remaining: Number(b.remaining),
      feeBps: Number(b.feeBps),
      buyer: b.buyer,
      miningStatus: Number(b.miningStatus) || 0,
      miningPending: b.miningPending || 0n,
      miningStopBlock: Number(b.miningStopBlock) || 0,
    })) : [],
    /** 官方挖矿读数：挖矿中的张数。 */
    miningActiveCount: Number(state.miningActiveCount ?? 0),
    miningCoolingCount: Number(state.miningCoolingCount ?? 0),
    /** 读状态时的块高；用于官方 1200 块冷却倒计时。 */
    blockNumber: Number(state.blockNumber ?? 0),
    miningCooldownBlocks: Number(state.miningCooldownBlocks ?? 1200),
    /** 订单已成交（本期至少持有过一张电路）。 */
    orderFilled: Boolean(state.orderFilled),
    /** 市场欠本期的 BNB（可 withdrawMarketProceeds）。 */
    marketOwed: bem(state.marketOwed || 0),
    /** 已记账、尚未发到持有人手里的余款（BNB）。 */
    surplusOutstanding: bem(state.surplusOutstanding || 0),
    surplusBase: Number(state.surplusBase || 0),
    /** 电路是否已在官方挖矿（由 miningStatus 汇总，不再有「入池」这个不可逆状态）。 */
    /** 本期锁定的 ERC721 电路集合。 */
    circuits: state.circuits || "",
    _sharePriceWei: state.sharePriceBnb,
    _netlistHash: null,
    netWeightVerified: 0,
    netWeightUnverified: 0,
    /** 非 Owner 可调 markFailed 的时间（售罄 + 3 天）；未售罄为 null */
    markFailedAt: state.markFailedAt ?? null,
    /** executing+buying 且池子已不足以按原价兑付 → 持有人可按比例退款 */
    refundShort: Boolean(state.refundShort),
    refundRatio: state.refundRatio ?? null,
    circuitMarket: state.circuitMarket || "",
    /** 工厂已移除该期：任何人可撤剩余买单 */
    retired: Boolean(state.retired),
    picked: extra.picked ?? 1,
    approved: true, // 原生 BNB 支付，无需 ERC20 approve
    wallets: addr
      ? {
          [addr]: {
            mine: Number(self.shares),
            listingShares: Number(self.escrow),
            claimed: bem(self.claimed),
            refunded: bem(self.refunded),
            bnb,
          },
        }
      : {},
    // 电路编号随 PoD/流片一起移除；链上没有这个字段，统一展示「—」。
    circuitId: "—",
    actualQuote: null,
    estimate: extra.estimate || {
      hashpower: Number(state.estHashpower),
      usedParts: Number(state.circuitHeldCount) || 0,
    },
  };
}

/**
 * 契约状态 → 列表状态。
 * 链上 scene 只有 募集/待执行/挖矿 三段，结束不会改 scene，所以必须用 executionFailed + 份数判断：
 *   - 执行失败且份额已全部退回（outstandingShares == 0）→ 已结束
 *   - 募集到期仍未售罄 → 已结束（只能原路退回，不会再进入执行）
 *   - 执行失败但还有人没退 → 执行失败（可退款）
 *
 * 注意用 outstandingShares（已售未退）而不是 sold：
 * sold 是单调的历史事实，退款不会让它变小，用它判断「是否已全部退回」会永远为假。
 */
export function campaignStatusOf(summary, nowSec = Math.floor(Date.now() / 1000)) {
  /*
   * 状态词一律从 roundState.js 取，本函数只负责把「链上摘要」翻译成那一层需要的字段。
   * note 不再是自由文案：它就是子状态行（与「我的资产」表、Owner 卡片同一份实现），
   * 否则列表卡片上一句「待挂单买电路」、资产表上一句「待挂单」，同一期两个说法。
   */
  const scene = Number(summary?.scene) || 0;
  const state = rowState({
    scene,
    phase: Number(summary?.phase) || 0,
    sold: Number(summary?.sold) || 0,
    totalShares: Number(summary?.totalShares) || 0,
    outstandingShares: summary?.outstandingShares,
    raisedBnb: Number(summary?.raisedBnb) || 0,
    sharePriceBnb: Number(summary?.sharePriceBnb) || 0,
    executionFailed: Boolean(summary?.executionFailed),
    fundingDeadline: Number(summary?.fundingDeadline) || 0,
  }, nowSec);

  return {
    status: state.label,
    tone: state.tone,
    note: state.substate,
    ended: state.key === "ended",
  };
}

/** 历史期次行（替换 PAST_ROUNDS 假数据）。 */
export function historyRowFromSummary(summary, index) {
  const state = campaignStatusOf(summary);
  const tone = state.tone;
  const processor = processorFromCircuitContract(summary.circuits);
  return {
    id: index,
    address: summary.address,
    status: state.status,
    statusNote: state.note,
    ended: state.ended,
    tone,
    shares: `${summary.sold}/${summary.totalShares}`,
    sold: summary.sold,
    totalShares: summary.totalShares,
    /**
     * 生命周期位：下拉/列表的「成交状态」判定要用 scene（+phase）。
     * 之前这里只给 status 文案，dealStatus 拿不到 scene 就一律兜底成「—」，
     * 期次下拉里每期都显示「● —」，像数据丢了。
     */
    scene: Number(summary.scene) || 0,
    phase: Number(summary.phase) || 0,
    /** 已售未退（当前债务）：退款会让它变小，sold 不会 */
    outstandingShares: Number(summary.outstandingShares ?? summary.sold) || 0,
    sharePriceBnb: summary.sharePriceBnb,
    hardCapBnb: summary.sharePriceBnb * summary.totalShares,
    raisedBnb: summary.raisedBnb,
    raised: `${summary.raisedBnb.toFixed(4)} BNB`,
    hashpower: summary.hashpower > 0
      ? String(summary.hashpower)
      : summary.estHashpower > 0
        ? `${summary.estHashpower}（预估）`
        : "—",
    hashpowerRaw: Number(summary.hashpower) || 0,
    bem: "—",
    fee: "—",
    estHashpower: summary.estHashpower,
    circuitCount: summary.circuitCount,
    circuitHeldCount: summary.circuitHeldCount,
    circuits: summary.circuits || "",
    processor: processor || null,
    fundingDeadline: Number(summary.fundingDeadline) || 0,
    executionFailed: Boolean(summary.executionFailed),
    totalRefunded: Number(summary.totalRefunded) || 0,
  };
}
