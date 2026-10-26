/**
 * Official PoD mining flow helpers (TapeOut / Behemoth):
 * claim while mining → stop → cool (stopBlock + 1200) → start again.
 */
import { POD_MINING_COOLDOWN_BLOCKS } from "./chain/config.js";

/** Blocks left until restart is allowed; 0 = ready to start. */
export function coolingBlocksLeft(row, blockNumber, cooldown = POD_MINING_COOLDOWN_BLOCKS) {
  if (Number(row?.miningStatus) !== 3) return 0;
  const until = Number(row.miningStopBlock || 0) + Number(cooldown || POD_MINING_COOLDOWN_BLOCKS);
  return Math.max(0, until - Number(blockNumber || 0));
}

/** Unlisted, not mining, not revoked; cooling rows need full official 1200 blocks. */
export function canStartPodRow(row, blockNumber, cooldown = POD_MINING_COOLDOWN_BLOCKS) {
  if (row?.listed) return false;
  const s = Number(row?.miningStatus) || 0;
  if (s === 1 || s === 2) return false;
  if (s === 3) return coolingBlocksLeft(row, blockNumber, cooldown) === 0;
  return true;
}

export function rowPendingBem(row) {
  try {
    const v = row?.miningPending ?? 0n;
    return typeof v === "bigint" ? v : BigInt(v || 0);
  } catch {
    return 0n;
  }
}

/** True when campaign still has PoD pending that should be claimed before stop. */
export function hasClaimableMiningReward(book, holdings = []) {
  const pending = book?.miningPendingBem ?? 0n;
  try {
    if (typeof pending === "bigint" ? pending > 0n : Number(pending) > 0) return true;
  } catch { /* ignore */ }
  const rows = holdings.length
    ? holdings
    : [
        ...(Array.isArray(book?.sellBids) ? book.sellBids : []),
        ...(Array.isArray(book?.listedCircuits) ? book.listedCircuits : []),
      ];
  return rows.some((row) => rowPendingBem(row) > 0n);
}

/** Find a held circuit row by tokenId (unlisted sellBids or listedCircuits). */
export function findCircuitRow(book, tokenId) {
  const id = String(tokenId);
  const bids = Array.isArray(book?.sellBids) ? book.sellBids : [];
  const listed = Array.isArray(book?.listedCircuits) ? book.listedCircuits : [];
  return (
    bids.find((b) => String(b.circuitTokenId ?? b.id) === id)
    || listed.find((c) => String(c.tokenId) === id)
    || null
  );
}

/** BSC ~3s/block → short human ETA. */
export function formatCoolingEta(blocksLeft) {
  const n = Math.max(0, Number(blocksLeft) || 0);
  if (n <= 0) return "可开矿";
  const mins = Math.max(1, Math.ceil((n * 3) / 60));
  return `剩 ${n} 块 · 约 ${mins} 分`;
}

export { POD_MINING_COOLDOWN_BLOCKS };
