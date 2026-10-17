// 把链上 readState 的结果适配成前端页面已在消费的 book / round 形状，
// 使主页面（认购/份数/转让/概览）无需改动即可展示真实测试网数据。
import { formatEther } from "ethers";
import { ROUND } from "../fixtures.js";

const SCENE_NAME = ["funding", "executing", "mining"];
const PHASE_NAME = [undefined, "buying", "listed", "ready"];
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
    executeDelayHours: Math.round((p.executeDelay ?? 172800) / 3600),
    contract: dep.campaign || ROUND.contract,
    feeRecipient: dep.deployer || ROUND.feeRecipient,
  };
}

/** 由链上状态生成 book。account 为当前连接地址（分账用）。 */
export function bookFromState(state, account, extra = {}) {
  const scene = SCENE_NAME[state.scene] || "funding";
  const phase = PHASE_NAME[state.phase];
  const self = state.self || { shares: 0n, escrow: 0n, claimed: 0n, refunded: 0n, pending: 0n, bemBalance: 0n };
  const addr = String(account || "").toLowerCase();
  const listings = (state.listings || []).map((l) => ({
    id: l.id,
    seller: l.seller,
    shares: Number(l.shares),
    priceBnbPerShare: bem(l.priceBnbPerShare),
    _priceWei: l.priceBnbPerShare, // 精确 wei，供 takeListing 付款
    totalBnb: bem(l.priceBnbPerShare * l.shares),
    open: l.open,
  }));

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
    refundedSelf: bem(self.refunded),
    bemBalance: bem(self.bemBalance),
    capped: state.capped,
    owner: state.owner,
    selfAddress: account,
    totalShares: Number(state.totalShares),
    transistorCount: Number(state.transistorCount),
    priceLock: bem(state.priceLock),
    _sharePriceWei: state.sharePriceBnb,
    picked: 1,
    approved: true,
    wallets: addr ? { [addr]: { mine: Number(self.shares), listingShares: Number(self.escrow), claimed: bem(self.claimed), refunded: bem(self.refunded), bnb: 0 } } : {},
    circuitId: Number(state.hashpower) > 0 ? `H${Number(state.hashpower)}` : "—",
    actualQuote: null,
    estimate: extra.estimate || { hashpower: Number(state.estHashpower), usedParts: Number(state.transistorCount) || 0 },
  };
}
