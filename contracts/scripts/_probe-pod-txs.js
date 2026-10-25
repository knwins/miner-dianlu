// Temporary probe: recover real calldata for PoD entrypoints via logs -> tx hashes.
// Cheap: one getLogs window per range, then fetch only the matching transactions.
const { ethers } = require("ethers");

const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const NAMES = {
  "0x2a24c84b": "arm(address,uint256)",
  "0x2d33823a": "challenge(bytes32,uint32,bytes,bytes,bytes32[])",
  "0x63c4f031": "stop(bytes32)",
  "0xbd66528a": "claim(bytes32)",
  "0x7ed51748": "claimMany(bytes32[])",
  "0x96afb365": "reclaim(bytes32)",
  "0x18178358": "poke()",
  "0x3fb27b85": "seal()",
  "0x2a7eba1b": "raiseMaxRunGas(uint256)",
  "0x7129e7c7": "invalidateEligibilityCache()",
};

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  const latest = await p.getBlockNumber();
  const found = new Map();
  const hashes = new Set();

  // Pull logs in 4000-block windows; public nodes usually accept this range.
  for (let window = 0; window < 20 && found.size < 7; window++) {
    const to = latest - window * 4000;
    const from = to - 3999;
    let logs;
    try { logs = await p.getLogs({ address: POD, fromBlock: from, toBlock: to }); }
    catch (e) { console.log("logs ERR", from, to, e.shortMessage || e.message); continue; }
    console.log("window", from, to, "logs", logs.length);
    for (const l of logs) hashes.add(l.transactionHash);
    // Fetch txs for this window and classify.
    const list = [...hashes];
    for (const h of list) {
      if (found.size >= 7) break;
      try {
        const tx = await p.getTransaction(h);
        if (!tx || !tx.to || tx.to.toLowerCase() !== POD.toLowerCase()) continue;
        const sel = tx.data.slice(0, 10).toLowerCase();
        const name = NAMES[sel] || sel;
        if (!found.has(name)) {
          found.set(name, { hash: h, data: tx.data, from: tx.from, block: tx.blockNumber });
          console.log("FOUND", name, "block", tx.blockNumber, "hash", h, "bytes", (tx.data.length - 2) / 2);
        }
      } catch { /* ignore */ }
    }
  }

  for (const [name, info] of found) {
    console.log("\n===", name, info.hash, "block", info.block, "from", info.from, "bytes", (info.data.length - 2) / 2);
    console.log(info.data.slice(0, 2 + 64 * 14));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
