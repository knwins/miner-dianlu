/**
 * Read-only check: does official PoD treat "this contract holds transistors" as mining rights?
 *
 * Usage: node scripts/verify-pod-holder.js
 * Requires HTTPS access to a BSC RPC. Does not send a transaction.
 */
const { ethers } = require("ethers");

const POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const CPU = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";
const TT = "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087";
const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";

const startAbi = [
  "function start(address cpu, uint256 circuitId, uint32 taskId, uint256 anchor, bytes[] a, bytes[] b, bytes32[][] c, bytes32 salt) returns (bytes32)",
  "function circuitBurn(address,uint256) view returns (uint256)",
];

function selector(e) {
  const data = e.data || e.info?.error?.data || "";
  return String(data).slice(0, 10);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const latest = await provider.getBlockNumber();
  const logs = await provider.getLogs({ address: POD, fromBlock: latest - 4000, toBlock: latest });
  const startLog = logs.find(
    (log) => log.topics[0] === ethers.id("Started(bytes32,address,uint256,uint256,address)") || log.topics.length === 4
  );
  const mined = logs.filter((log) => log.topics.length === 4 && log.data.length >= 130);
  const sample = mined.find((log) => {
    const txSel = null;
    void txSel;
    return log.topics[2].toLowerCase().endsWith(CPU.slice(2).toLowerCase());
  });
  if (!sample) throw new Error("no recent start-like log");
  void startLog;

  const tx = await provider.getTransaction(sample.transactionHash);
  if (!tx.data.startsWith("0xa3494614")) throw new Error("sample tx is not start");
  const circuitId = BigInt(sample.topics[3]);
  const nft = new ethers.Contract(CPU, ["function ownerOf(uint256) view returns (address)"], provider);
  const parts = new ethers.Contract(TT, ["function balanceOf(address,uint256) view returns (uint256)"], provider);
  const owner = await nft.ownerOf(circuitId);
  const nand = await parts.balanceOf(owner, 0);
  const latch = await parts.balanceOf(owner, 1);
  const pod = new ethers.Contract(POD, startAbi, provider);
  const burn = await pod.circuitBurn(CPU, circuitId);
  const stranger = "0x1111111111111111111111111111111111111111";
  const args = [CPU, circuitId, 4, 0n, [], [], [], ethers.ZeroHash];

  let ownerSel = "ok";
  try {
    await pod.start.staticCall(...args, { from: owner });
  } catch (e) {
    ownerSel = selector(e);
  }
  let strangerSel = "ok";
  try {
    await pod.start.staticCall(...args, { from: stranger });
  } catch (e) {
    strangerSel = selector(e);
  }

  const ownr = ethers.id("Ownr()").slice(0, 10);
  const zeroCircuit = 1n;
  const zeroOwner = await nft.ownerOf(zeroCircuit);
  const zeroNand = await parts.balanceOf(zeroOwner, 0);
  const zeroLatch = await parts.balanceOf(zeroOwner, 1);
  let zeroOwnerSel = "ok";
  try {
    await pod.start.staticCall(CPU, zeroCircuit, 4, 0n, [], [], [], ethers.ZeroHash, { from: zeroOwner });
  } catch (e) {
    zeroOwnerSel = selector(e);
  }

  console.log(JSON.stringify({
    circuitId: circuitId.toString(),
    startCaller: tx.from,
    circuitOwner: owner,
    callerIsOwner: owner.toLowerCase() === tx.from.toLowerCase(),
    ownerNand: nand.toString(),
    ownerLatch: latch.toString(),
    circuitBurn: burn.toString(),
    ownerNextRevert: ownerSel,
    strangerRevert: strangerSel,
    ownrSelector: ownr,
    strangerIsOwnr: strangerSel === ownr,
    ownerPassedOwnr: ownerSel !== ownr,
    zeroBalanceCircuit: zeroCircuit.toString(),
    zeroBalanceOwner: zeroOwner,
    zeroBalanceNand: zeroNand.toString(),
    zeroBalanceLatch: zeroLatch.toString(),
    zeroBalanceOwnerPassedOwnr: zeroOwnerSel !== ownr,
    zeroBalanceOwnerRevert: zeroOwnerSel,
  }, null, 2));

  if (owner.toLowerCase() !== tx.from.toLowerCase()) process.exitCode = 1;
  if (strangerSel !== ownr) process.exitCode = 1;
  if (ownerSel === ownr) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
