// 把链上 readState 的结果适配成前端页面已在消费的 book / round 形状，
// 使主页面（认购/份数/转让/概览）无需改动即可展示真实测试网数据。
import { formatEther } from "ethers";
import { ROUND } from "../fixtures.js";
import { transistorIdFor } from "../prices.js";
import { processorFromPartsContract } from "../tapeout.js";
import { getCampaignAddress } from "./client.js";
import { SCENE_LABEL } from "./config.js";

const SCENE_NAME = ["funding", "executing", "mining"];
const PHASE_NAME = [undefined, "buying", "listed", "ready"];
const SCENE_TONE = ["live", "wait", "mine"];

const bem = (v) => {
  try { return Number(formatEther(v)); } catch { return 0; }
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
    /** 同 roundFromState：链上期次的元件数不从 fixtures 继承，链上真值走 book.transistorCount */
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
     * 元件数：链上模式**不能**继承 fixtures 的默认值。
     *
     * `...baseRound` 把本地演示期次（ROUND.partCount = 68）一起带进来了，
     * 于是链上每一期的估算都用 68 颗算——链上根本没这个数。
     * 链上的元件数权威来源是 nandQty + latchQty（成交到账量），
     * 由 book.transistorCount 承载；round 上这个字段只作测算种子，
     * 链上模式一律归零（planTask 会兜底到 1），不拿演示数据冒充链上事实。
     */
    partCount: 0,
    // 开期写入的 transistors 地址 = 官方处理器的元件合约（TapeOut / Behemoth）；不能沿用 ROUND 默认 Behemoth。
    processorId: processorFromPartsContract(state.transistors) || null,
    transistorId: processorFromPartsContract(state.transistors)
      ? transistorIdFor(processorFromPartsContract(state.transistors))
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
    const shares = remain;
    const totalWei = l.priceBnbPerShare * BigInt(shares);
    return {
      id: l.id,
      seller: l.seller,
      shares,
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
    executePhase: scene === "executing" ? (phase || "buying") : undefined,
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
     * 待领余款（wei）。C-4 之后余款改 pull 模式：入池时不再推给持有人，
     * 持份人自己调 claimSurplus() 领。claimableSurplus 含尚未计提的可领部分。
     */
    pendingSurplusSelf: bem(self.claimableSurplus ?? self.pendingSurplus),
    pendingSurplusTotal: bem(state.totalPendingSurplus),
    /**
     * 服务费是否已设定（链上）。
     * false = 还能改（只要还没人认购）；true = 已永久锁定。
     * 注意与「费率为 0」区分：serviceFeeSet == true 且 bps == 0 是「已锁定为不收费」。
     */
    serviceFeeSet: Boolean(state.serviceFeeSet),
    /** 本期服务费率（基点） */
    serviceFeeBps: Number(state.serviceFeeBps ?? 0),
    /** 挖矿收益池（已扣服务费的净额）。owner 扫不走。 */
    revenuePool: bem(state.revenuePool ?? 0),
    bemBalance: 0,
    bnb,
    capped: false,
    owner: state.owner,
    selfAddress: account,
    totalShares: Number(state.totalShares),
    /**
     * 已成交到账的元件数（各腿 挂单量 − 市场 remaining）。
     * 注意不是挂单量：nandQty/latchQty 是「下单要买多少」，成交前不等于已买到。
     */
    transistorCount: Number(state.transistorCount),
    nandFilled: Number(state.nandFilled ?? 0),
    latchFilled: Number(state.latchFilled ?? 0),
    estHashpower: Number(state.estHashpower),
    priceLock: bem(state.priceLock),
    marketOrders: Boolean(state.marketOrders),
    // 材料市场是否真有卖单侧。官方市场只有买单侧 → 挂卖单入口必须挡住。
    marketAskSide: Boolean(state.marketAskSide),
    orderFilled: Boolean(state.orderFilled),
    nandBidId: state.nandBidId != null ? String(state.nandBidId) : "0",
    latchBidId: state.latchBidId != null ? String(state.latchBidId) : "0",
    nandQty: Number(state.nandQty || 0),
    latchQty: Number(state.latchQty || 0),
    nandPrice: bem(state.nandPrice || 0),
    latchPrice: bem(state.latchPrice || 0),
    nandRemaining: state.nandRemaining == null ? null : Number(state.nandRemaining),
    latchRemaining: state.latchRemaining == null ? null : Number(state.latchRemaining),
    nandAskId: state.nandAskId != null ? String(state.nandAskId) : "0",
    latchAskId: state.latchAskId != null ? String(state.latchAskId) : "0",
    nandAskQty: Number(state.nandAskQty || 0),
    latchAskQty: Number(state.latchAskQty || 0),
    nandAskPrice: bem(state.nandAskPrice || 0),
    latchAskPrice: bem(state.latchAskPrice || 0),
    nandAskRemaining: state.nandAskRemaining == null ? null : Number(state.nandAskRemaining),
    latchAskRemaining: state.latchAskRemaining == null ? null : Number(state.latchAskRemaining),
    askOpen: Boolean(state.askOpen),
    marketAsks: Boolean(state.marketAsks),
    marketOwed: bem(state.marketOwed || 0),
    readyExit: state.readyExit !== false,
    partsNand: Number(state.partsNand || 0),
    partsLatch: Number(state.partsLatch || 0),
    /** 元件是否已投入矿池（不可逆）。入池后合约余额归 0，展示要用 transistorCount。 */
    pooled: Boolean(state.pooled),
    transistors: state.transistors || "",
    _sharePriceWei: state.sharePriceBnb,
    _netlistHash: null,
    netWeightVerified: 0,
    netWeightUnverified: 0,
    /** 非 Owner 可调 markFailed 的时间（售罄 + 3 天）；未售罄为 null */
    markFailedAt: state.markFailedAt ?? null,
    /** executing+buying 且池子已不足以按原价兑付 → 持有人可按比例退款 */
    refundShort: Boolean(state.refundShort),
    refundRatio: state.refundRatio ?? null,
    market: state.market || "",
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
      usedParts: Number(state.transistorCount) || 0,
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
  const scene = Number(summary?.scene) || 0;
  const sold = Number(summary?.sold) || 0;
  const outstanding = Number(summary?.outstandingShares ?? summary?.sold) || 0;
  const totalShares = Number(summary?.totalShares) || 0;
  const raised = Number(summary?.raisedBnb) || 0;
  const price = Number(summary?.sharePriceBnb) || 0;
  const phase = Number(summary?.phase) || 0;
  const failed = Boolean(summary?.executionFailed);
  const deadline = Number(summary?.fundingDeadline) || 0;

  const soldOut = totalShares > 0 && sold >= totalShares;
  const fundingExpired = scene === 0 && !soldOut && deadline > 0 && nowSec > deadline;
  const refundedOut = scene === 1 && failed && outstanding === 0;
  const ended = refundedOut || fundingExpired;
  // 与合约 refund() 的 short 口径一致：只有「待挂单」阶段池子cover不住全部份额才算缺口。
  // 已挂单/已到账时 raisedBnb 减少是买元件花掉的，不是缺口。
  const short = scene === 1 && phase === 1 && raised < outstanding * price;

  if (ended) {
    return {
      status: "已结束",
      tone: "done",
      note: refundedOut ? "认筹已全部原路退回" : "超时未售罄 · 可原路退款",
    };
  }
  if (scene === 1 && failed) {
    return { status: "执行失败", tone: "back", note: "持有人可原路退款 · Owner 可重挂" };
  }
  if (scene === 0) {
    return { status: "募集中", tone: "live", note: "" };
  }
  if (scene === 1) {
    return {
      status: "待执行",
      tone: "wait",
      note: short
        ? "池子不足 · 可按比例退款"
        : phase === 3 ? "元件到账 · 待入池" : phase === 2 ? "挂单中" : "待挂单买元件",
    };
  }
  if (scene === 2) {
    return { status: "挖矿中", tone: "mine", note: "元件已入池 · 不可逆" };
  }
  return { status: SCENE_LABEL[scene] || "—", tone: SCENE_TONE[scene] || "live", note: "" };
}

/** 历史期次行（替换 PAST_ROUNDS 假数据）。 */
export function historyRowFromSummary(summary, index) {
  const state = campaignStatusOf(summary);
  const tone = state.tone;
  const processor = processorFromPartsContract(summary.transistors);
  return {
    id: index,
    address: summary.address,
    status: state.status,
    statusNote: state.note,
    ended: state.status === "已结束",
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
    transistorCount: summary.transistorCount,
    transistors: summary.transistors || "",
    processor: processor || null,
    fundingDeadline: Number(summary.fundingDeadline) || 0,
    executionFailed: Boolean(summary.executionFailed),
    totalRefunded: Number(summary.totalRefunded) || 0,
  };
}
