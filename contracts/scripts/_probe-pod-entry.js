// Temporary probe: classify PoD state-changing entrypoints by their revert selectors.
const { ethers } = require("ethers");

const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const LENS = "0xdd20b9537b9f5db9d2a23e6b11ad863cf81930d8";
const TAPEOUT = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";
const coder = ethers.AbiCoder.defaultAbiCoder();

function data(sig, types = [], args = []) {
  return ethers.concat([ethers.id(sig).slice(0, 10), coder.encode(types, args)]);
}

async function call(p, from, to, sig, types, args) {
  try {
    const out = await p.call({ from, to, data: data(sig, types, args) });
    console.log("OK   ", sig, "->", out === "0x" ? "(no return)" : out.slice(0, 200));
    return { ok: true, out };
  } catch (e) {
    const raw = e.data || e.info?.error?.data || null;
    console.log("FAIL ", sig, "->", e.shortMessage || e.message, "raw:", raw ? String(raw).slice(0, 74) : "(none)");
    return { ok: false, raw };
  }
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  const nft = new ethers.Contract(TAPEOUT, ["function ownerOf(uint256) view returns (address)"], p);
  const id = 13945;
  const owner = await nft.ownerOf(id);
  const key = coder.decode(["bytes32"], await p.call({ to: POD, data: data("minerKey(address,uint256)", ["address", "uint256"], [TAPEOUT, id]) }))[0];
  console.log("owner", owner, "key", key);

  // read lens for this token
  for (const [sig, types, args] of [
    ["circuitInfo(uint256)", ["uint256"], [id]],
    ["refsEligible(address,uint256)", ["address", "uint256"], [TAPEOUT, id]],
    ["previewScore(address,uint256,uint32)", ["address", "uint256", "uint32"], [TAPEOUT, id, 0]],
    ["pendingLive(bytes32)", ["bytes32"], [key]],
    ["poolInfo()", [], []],
    ["dailyEmission()", [], []],
    ["mining()", [], []],
  ]) {
    const r = await call(p, owner, LENS, sig, types, args);
    if (r.ok && r.out && r.out !== "0x") {
      // try decode a single word / address
      if (r.out.length === 66) {
        try { console.log("   word:", BigInt(r.out), "addr:", coder.decode(["address"], r.out)[0]); } catch { /* */ }
      }
    }
  }

  console.log("\n-- state changing entrypoints");
  await call(p, owner, POD, "arm(address,uint256)", ["address", "uint256"], [TAPEOUT, id]);
  await call(p, owner, POD, "stop(bytes32)", ["bytes32"], [key]);
  await call(p, owner, POD, "claim(bytes32)", ["bytes32"], [key]);
  await call(p, owner, POD, "reclaim(bytes32)", ["bytes32"], [key]);
  await call(p, owner, POD, "poke()", [], []);
  await call(p, owner, POD, "seal()", [], []);
  await call(p, owner, POD, "challenge(bytes32,uint32,bytes,bytes,bytes32[])", ["bytes32", "uint32", "bytes", "bytes", "bytes32[]"], [key, 0, "0x", "0x", []]);
  await call(p, owner, POD, "warmEligible(address,uint256)", ["address", "uint256"], [TAPEOUT, id]);
  await call(p, owner, POD, "warmBurn(address,uint256)", ["address", "uint256"], [TAPEOUT, id]);
}

main().catch((e) => { console.error(e); process.exit(1); });
