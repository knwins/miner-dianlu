// Temporary probe: discover the official "start/stop mining + claim rewards" surface.
//
// The official contracts publish no ABI. We read the implementation bytecode behind each
// proxy, pull every PUSH4 dispatcher selector, and resolve names through OpenChain's
// signature database. Output = the minimal ABI we need to hand-write.
const { ethers } = require("ethers");

const RPC = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const TARGETS = {
  podMining: "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46",
  cpuFactory: "0x68224F668083c29e9800Be2a646d42d18cedF7e2",
  tapeout: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
  behemoth: "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c",
  market: "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f",
  bemHub: "0x2D2f8D87f6Db449A61Eef8Dd61daF9Cc3a165C35",
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
    for (const sel of batch) {
      const hit = (fn[sel] || [])[0];
      out[sel] = hit ? hit.name : "(unknown)";
    }
  }
  return out;
}

async function resolveProxy(p, addr) {
  let impl = null;
  try {
    const raw = await p.getStorage(addr, SLOT_IMPL);
    if (raw && raw !== ethers.ZeroHash) impl = ethers.getAddress("0x" + raw.slice(26));
  } catch { /* ignore */ }
  if (!impl) {
    try {
      const raw = await p.getStorage(addr, SLOT_BEACON);
      if (raw && raw !== ethers.ZeroHash) {
        const beacon = ethers.getAddress("0x" + raw.slice(26));
        const b = new ethers.Contract(beacon, ["function implementation() view returns (address)"], p);
        impl = await b.implementation();
      }
    } catch { /* ignore */ }
  }
  return { impl, beacon: null };
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  for (const [label, addr] of Object.entries(TARGETS)) {
    console.log("\n=== " + label + " " + addr);
    let codeAddr = addr;
    try {
      const { impl } = await resolveProxy(p, addr);
      if (impl) { console.log("impl: " + impl); codeAddr = impl; }
    } catch (e) { console.log("proxy read err: " + e.message); }
    const code = await p.getCode(codeAddr);
    const sels = selectorsFromCode(code);
    console.log("code bytes: " + (code.length - 2) / 2 + " selectors: " + sels.length);
    const names = await lookup(sels);
    for (const [sel, name] of Object.entries(names)) console.log(sel + " " + name);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
