// Temporary probe: simulate arm / stop / claim / reclaim from the real token owner to
// confirm which call "opens" and "closes" mining and which one pays rewards.
const { ethers } = require("ethers");

const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const TAPEOUT = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";
const coder = ethers.AbiCoder.defaultAbiCoder();

function data(sig, types = [], args = []) {
  return ethers.concat([ethers.id(sig).slice(0, 10), coder.encode(types, args)]);
}

async function tryCall(p, label, from, to, sig, types, args) {
  try {
    const out = await p.call({ from, to, data: data(sig, types, args) });
    console.log("OK  ", label, "->", out === "0x" ? "(no return)" : out.slice(0, 130));
  } catch (e) {
    console.log("FAIL", label, "->", e.shortMessage || e.message);
  }
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  const nft = new ethers.Contract(TAPEOUT, ["function ownerOf(uint256) view returns (address)"], p);

  for (const id of [13945, 842, 18015, 5859]) {
    const owner = await nft.ownerOf(id);
    let key;
    try {
      key = coder.decode(["bytes32"], await p.call({ to: POD, data: data("minerKey(address,uint256)", ["address", "uint256"], [TAPEOUT, id]) }))[0];
    } catch (e) { console.log("key ERR", id, e.shortMessage); continue; }
    console.log("\n--- token", id, "owner", owner, "key", key);
    await tryCall(p, `arm(${id}) from owner`, owner, POD, "arm(address,uint256)", ["address", "uint256"], [TAPEOUT, id]);
    await tryCall(p, `stop(key) from owner`, owner, POD, "stop(bytes32)", ["bytes32"], [key]);
    await tryCall(p, `claim(key) from owner`, owner, POD, "claim(bytes32)", ["bytes32"], [key]);
    await tryCall(p, `reclaim(key) from owner`, owner, POD, "reclaim(bytes32)", ["bytes32"], [key]);
    await tryCall(p, `poke() from owner`, owner, POD, "poke()", [], []);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
