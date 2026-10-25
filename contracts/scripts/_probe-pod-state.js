// Temporary probe: read the official PoD Mining state for real circuit tokens so we can
// derive the exact ABI (struct layouts) for arm / stop / claim and the "can mine" filter.
const { ethers } = require("ethers");

const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const TAPEOUT = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";
const coder = ethers.AbiCoder.defaultAbiCoder();

function calldata(sig, types = [], args = []) {
  return ethers.concat([ethers.id(sig).slice(0, 10), coder.encode(types, args)]);
}

async function raw(p, sig, types, args) {
  return p.call({ to: POD, data: calldata(sig, types, args) });
}

function word(hex) {
  return BigInt(hex.slice(0, 66));
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  const nft = new ethers.Contract(TAPEOUT, ["function ownerOf(uint256) view returns (address)"], p);

  const ids = [842, 13945, 5859, 7837, 7946, 18015];
  for (const id of ids) {
    console.log("\n--- token", id);
    try { console.log("owner:", await nft.ownerOf(id)); } catch (e) { console.log("owner ERR", e.shortMessage || e.message); }
    let key = null;
    try {
      const out = await raw(p, "minerKey(address,uint256)", ["address", "uint256"], [TAPEOUT, id]);
      key = coder.decode(["bytes32"], out)[0];
      console.log("minerKey:", key);
    } catch (e) { console.log("minerKey ERR", e.shortMessage || e.message); }

    if (key) {
      for (const fn of ["miners", "getMiner"]) {
        try {
          const out = await raw(p, `${fn}(bytes32)`, ["bytes32"], [key]);
          console.log(fn, "bytes:", (out.length - 2) / 2, out.slice(0, 2 + 64 * 10));
        } catch (e) { console.log(fn, "ERR", e.shortMessage || e.message); }
      }
      for (const fn of ["pending", "armedAt"]) {
        try {
          const out = await raw(p, `${fn}(bytes32)`, ["bytes32"], [key]);
          console.log(fn, "word:", word(out), "hex:", out.slice(0, 66));
        } catch (e) { console.log(fn, "ERR", e.shortMessage || e.message); }
      }
    }

    try {
      const out = await raw(p, "circuitInfo(uint256)", ["uint256"], [id]);
      console.log("circuitInfo bytes:", (out.length - 2) / 2, out.slice(0, 2 + 64 * 8));
    } catch (e) { console.log("circuitInfo ERR", e.shortMessage || e.message); }

    for (const fn of ["circuitDepth", "circuitBurn", "cachedBurn", "warmBurn", "warmDepth", "warmEligible"]) {
      try {
        const out = await raw(p, `${fn}(address,uint256)`, ["address", "uint256"], [TAPEOUT, id]);
        console.log(fn, "word:", word(out), "hex:", out.slice(0, 66));
      } catch (e) { console.log(fn, "ERR", e.shortMessage || e.message); }
    }
  }

  console.log("\n=== globals");
  for (const fn of ["totalMined()", "currentRate()", "STOP_COOLDOWN()", "minerCount()", "verifMinerCount()", "eligibleEpoch()", "totalSupply()", "startTime()"]) {
    try {
      const out = await raw(p, fn, [], []);
      console.log(fn + ":", word(out));
    } catch (e) { console.log(fn + " ERR", e.shortMessage || e.message); }
  }
  for (const fn of ["token()", "owner()", "pause()"]) {
    if (!fn.endsWith("()")) continue;
    try {
      const out = await raw(p, fn, [], []);
      console.log(fn + ":", coder.decode(["address"], out)[0]);
    } catch (e) { console.log(fn + " ERR", e.shortMessage || e.message); }
  }
  try {
    const out = await raw(p, "processorMultiplier(address)", ["address"], [TAPEOUT]);
    console.log("processorMultiplier(tapeout):", word(out));
  } catch (e) { console.log("mult ERR", e.shortMessage || e.message); }
}

main().catch((e) => { console.error(e); process.exit(1); });
