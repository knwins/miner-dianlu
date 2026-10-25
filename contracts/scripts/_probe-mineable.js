// Temporary probe: what makes a circuit "mineable"?
//  - CPU factory isCPU(circuits)
//  - PoD processorMultiplier(circuits) (>0 = registered processor)
//  - PoD getMiner for a Behemoth token (is it armed?)
const { ethers } = require("ethers");

const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const CPU_FACTORY = "0x68224F668083c29e9800Be2a646d42d18cedF7e2";
const TAPEOUT = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";
const BEHEMOTH = "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c";
const coder = ethers.AbiCoder.defaultAbiCoder();

function data(sig, types = [], args = []) {
  return ethers.concat([ethers.id(sig).slice(0, 10), coder.encode(types, args)]);
}
async function call(p, to, sig, types, args) {
  return p.call({ to, data: data(sig, types, args) });
}
async function num(p, to, sig, types, args) {
  return BigInt(await call(p, to, sig, types, args));
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  for (const [label, addr] of [["TapeOut", TAPEOUT], ["Behemoth", BEHEMOTH], ["market", "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f"], ["random", "0x1111111111111111111111111111111111111111"]]) {
    console.log("\n---", label, addr);
    for (const [name, to, sig, sigTypes] of [
      ["factory.isCPU", CPU_FACTORY, "isCPU(address)", ["address"]],
      ["nft.isCPU", addr, "isCPU(address)", ["address"]],
      ["pod.processorMultiplier", POD, "processorMultiplier(address)", ["address"]],
    ]) {
      try {
        const out = await call(p, to, sig, sigTypes, [addr]);
        let v = out;
        try { v = BigInt(out); } catch { v = coder.decode(["bool"], out)[0]; }
        console.log(name + ":", v.toString());
      } catch (e) { console.log(name + " ERR:", e.shortMessage || e.message); }
    }
  }

  // cpuCount + cpuAt to see registered collections
  try {
    const n = Number(await num(p, CPU_FACTORY, "cpuCount()", [], []));
    console.log("\ncpuCount:", n);
    for (let i = 0; i < Math.min(n, 12); i++) {
      const out = await call(p, CPU_FACTORY, "cpuAt(uint256)", ["uint256"], [i]);
      console.log("cpuAt", i, coder.decode(["address"], out)[0]);
    }
  } catch (e) { console.log("cpu list ERR", e.shortMessage || e.message); }

  // Behemoth token miner
  const nft = new ethers.Contract(BEHEMOTH, ["function ownerOf(uint256) view returns (address)", "function nextId() view returns (uint256)"], p);
  try { console.log("\nbehemoth nextId:", String(await nft.nextId())); } catch (e) { console.log("nextId ERR", e.shortMessage || e.message); }
  for (const id of [1050, 406, 1080]) {
    try {
      const owner = await nft.ownerOf(id);
      const key = coder.decode(["bytes32"], await call(p, POD, "minerKey(address,uint256)", ["address", "uint256"], [BEHEMOTH, id]))[0];
      const pending = await num(p, POD, "pending(bytes32)", ["bytes32"], [key]);
      const miner = await call(p, POD, "getMiner(bytes32)", ["bytes32"], [key]);
      console.log("behemoth", id, "owner", owner, "key", key, "pending", pending, "miner", miner.slice(0, 2 + 64 * 11));
    } catch (e) { console.log("behemoth", id, "ERR", e.shortMessage || e.message); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
