// Temporary probe: enumerate the official "mining lens" read surface.
const { ethers } = require("ethers");

const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const TARGETS = {
  lens: "0xdd20b9537b9f5db9d2a23e6b11ad863cf81930d8",
};

function selectorsFromCode(code) {
  const hex = code.toLowerCase().replace(/^0x/, "");
  const found = new Set();
  const re = /63([0-9a-f]{8})/g;
  let m;
  while ((m = re.exec(hex))) found.add("0x" + m[1]);
  return [...found];
}

async function lookup(sels) {
  const out = {};
  for (let i = 0; i < sels.length; i += 40) {
    const batch = sels.slice(i, i + 40);
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${batch.join(",")}&filter=true`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`openchain ${r.status}`);
    const j = await r.json();
    const fn = (j.result && j.result.function) || {};
    for (const sel of batch) out[sel] = (fn[sel] || [])[0]?.name || "(unknown)";
  }
  return out;
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  for (const [label, addr] of Object.entries(TARGETS)) {
    console.log("\n=== " + label + " " + addr);
    const code = await p.getCode(addr);
    console.log("code bytes:", (code.length - 2) / 2);
    const sels = selectorsFromCode(code);
    const names = await lookup(sels);
    for (const [sel, name] of Object.entries(names)) console.log(sel + " " + name);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
