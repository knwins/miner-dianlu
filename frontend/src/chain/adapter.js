// 把链上 readState 的结果适配成前端页面已在消费的 book / round 形状，
// 使主页面（认购/份数/转让/概览）无需改动即可展示真实测试网数据。
import { formatEther } from "ethers";
import { ROUND } from "../fixtures.js";
import { getCampaignAddress } from "./client.js";

const SCENE_NAME = ["funding", "executing", "mining"];
const PHASE_NAME = [undefined, "buying", "listed", "ready"];
const SCENE_TONE = ["live", "wait", "mine"];
const SCENE_STATUS = ["募集中", "待执行", "挖矿中"];

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
    feeBps: Math.round((p.feePercent ?? 5) * 100),
    taskId: p.taskId ?? ROUND.taskId,
    fundingDays: p.fundingDays ?? ROUND.fundingDays,
    executeDelayHours: 0,
    contract: dep.campaign || getCampaignAddress() || ROUND.contract,
    feeRecipient: dep.deployer || ROUND.feeRecipient,
    feeShares: [{ address: dep.deployer || ROUND.feeRecipient, shareBps: 10_000 }],
    netlistHash: p.netlistHash || null,
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
    feeBps: state.feeBps,
    taskId: state.taskId ?? baseRound.taskId,
    executeDelayHours: 0,
    contract: state.campaign || getCampaignAddress() || baseRound.contract,
    feeRecipient: state.feeRecipient || baseRound.feeRecipient,
    feeShares:
      Array.isArray(state.feeShares) && state.feeShares.length
        ? state.feeShares
        : [{ address: state.feeRecipient || baseRound.feeRecipient, shareBps: 10_000 }],
    netlistHash: state.netlistHash || baseRound.netlistHash || null,
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
    const taken = Number(l.takenShares || 0);
    // 关单后剩余份额仍写在 listing.shares：剩 0 且有成交 → 完成；否则是撤单（含部分成交后再撤）
    const status = l.open ? "open" : (remain === 0 && taken > 0 ? "done" : "cancelled");
    const shares = status === "done" ? (taken || remain) : remain;
    const totalWei = status === "done" && l.takenPaid != null ? l.takenPaid : l.priceBnbPerShare * BigInt(shares);
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
    mine: Number(self.shares),
    listingShares: Number(self.escrow),
    claimable: bem(self.pending),
    claimed: bem(self.claimed),
    listings,
    hashpower: Number(state.hashpower),
    dailyBem: bem(state.dailyBem),
    harvestCount: Number(state.harvestCount),
    distributed: bem(state.totalDistributed),
    feeBem: bem(state.totalFeeCollected),
    executionFailed: state.executionFailed,
    soldOutAt: state.soldOutAt > 0 ? state.soldOutAt * 1000 : null,
    endsAt: scene === "funding" ? state.fundingDeadline * 1000 : undefined,
    bnbPool: bem(state.raisedBnb),
    refundedTotal: bem(state.totalRefunded),
    refundedSelf: bem(self.refunded),
    bemBalance: bem(self.bemBalance),
    bnb,
    capped: state.capped,
    owner: state.owner,
    selfAddress: account,
    totalShares: Number(state.totalShares),
    transistorCount: Number(state.transistorCount),
    estHashpower: Number(state.estHashpower),
    taskId: state.taskId,
    priceLock: bem(state.priceLock),
    marketOrders: Boolean(state.marketOrders),
    orderFilled: Boolean(state.orderFilled),
    nandBidId: state.nandBidId != null ? String(state.nandBidId) : "0",
    latchBidId: state.latchBidId != null ? String(state.latchBidId) : "0",
    nandQty: Number(state.nandQty || 0),
    latchQty: Number(state.latchQty || 0),
    nandPrice: bem(state.nandPrice || 0),
    latchPrice: bem(state.latchPrice || 0),
    transistors: state.transistors || "",
    _sharePriceWei: state.sharePriceBnb,
    _netlistHash: state.netlistHash,
    netWeightVerified: state.netWeightVerified,
    netWeightUnverified: state.netWeightUnverified,
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
    circuitId: Number(state.hashpower) > 0 ? `H${Number(state.hashpower)}` : "—",
    actualQuote: null,
    estimate: extra.estimate || {
      hashpower: Number(state.estHashpower),
      usedParts: Number(state.transistorCount) || 0,
    },
  };
}

/** 历史期次行（替换 PAST_ROUNDS 假数据）。 */
export function historyRowFromSummary(summary, index) {
  const tone = SCENE_TONE[summary.scene] || "live";
  return {
    id: index,
    address: summary.address,
    status: SCENE_STATUS[summary.scene] || "—",
    tone,
    shares: `${summary.sold}/${summary.totalShares}`,
    sold: summary.sold,
    totalShares: summary.totalShares,
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
    bem: `${Number(summary.distributed).toFixed(4)} BEM`,
    fee: `${Number(summary.feeBem).toFixed(4)} BEM`,
    taskId: summary.taskId,
    estHashpower: summary.estHashpower,
    transistorCount: summary.transistorCount,
  };
}
