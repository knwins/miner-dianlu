/**
 * H-5 关单探针：核对官方材料市场（主网 0xA6a8…）的真实 ABI 形状。
 *
 * 背景：
 *   Campaign.sol 按固定元组解包市场返回值：
 *     - bids(id)  → 7 元组 (buyer, transistors, price, tokenId, feeBps, remaining, ???)
 *     - asks(id)  → 5 元组 (seller, price, transistors, tokenId, remaining)
 *     - owed(address) → uint256
 *     - withdraw()      → 无参
 *   这些签名从来没被 eth_call 核对过。若官方代理的元组顺序/长度不同，
 *   合约会静默解出错误的 price / tokenId / remaining，
 *   表现为「买到的元件数量对不上」或「priceLock 算错」——主网上才发现就太晚了。
 *
 * 本探针只做 eth_call（不碰 getLogs，公共 RPC 会对 getLogs 返 403）。
 * 逐个候选签名试调，能解出来的就是真实签名。
 *
 * 用法：node scripts/probe-market-abi.mjs
 */
import { JsonRpcProvider, Network, Contract, id } from "ethers";

const RPC = process.env.RPC || "https://bsc-rpc.publicnode.com";
const MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const OFFICIAL_PARTS = {
  TAPE_OUT: "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087",
  BEHEMOTH: "0xE2DfD802081C7a05341E20b6582b04b908e8550c",
};

const provider = new JsonRpcProvider(RPC, Network.from(56), { staticNetwork: Network.from(56), batchMaxCount: 1 });

/** 用原始 calldata 调 eth_call，返回 hex 或错误信息。 */
async function rawCall(sig, args = []) {
  const data = id(sig).slice(0, 10) + args
    .map((a) => a.replace(/^0x/, "").padStart(64, "0"))
    .join("");
  try {
    const res = await provider.send("eth_call", [{ to: MARKET, data }, "latest"]);
    return { ok: true, data: res };
  } catch (e) {
    return { ok: false, err: String(e?.shortMessage || e?.message || e).slice(0, 120) };
  }
}

/** 把 32 字节切片按候选类型解码。 */
function decodeWords(hex, types) {
  const body = hex.replace(/^0x/, "");
  const words = [];
  for (let i = 0; i < body.length; i += 64) words.push(body.slice(i, i + 64));
  return types.map((t, i) => {
    const w = words[i];
    if (w === undefined) return { t, v: "MISSING" };
    if (t === "address") return { t, v: "0x" + w.slice(24) };
    if (t === "uint256" || t === "uint96" || t === "uint16" || t === "uint8") {
      const bi = BigInt("0x" + w);
      return { t, v: bi.toString() };
    }
    if (t === "bool") return { t, v: BigInt("0x" + w) !== 0n };
    return { t, v: "0x" + w };
  });
}

const results = [];

// ── 1. bids 元组形状 ────────────────────────────────────────────────
const BID_CANDIDATES = [
  { sig: "bids(uint256)", types: ["address", "address", "uint96", "uint8", "uint16", "uint256", "uint256"] },
  { sig: "bids(uint256)", types: ["address", "address", "uint96", "uint8", "uint16", "uint256"] },
  { sig: "bids(uint256)", types: ["address", "address", "uint96", "uint8", "uint256", "uint256"] },
  { sig: "bids(uint256)", types: ["address", "address", "uint96", "uint8", "uint16", "uint256", "bool"] },
];
const ASK_CANDIDATES = [
  { sig: "asks(uint256)", types: ["address", "uint96", "address", "uint8", "uint256"] },
  { sig: "asks(uint256)", types: ["address", "uint96", "address", "uint8", "uint256", "uint256"] },
];

async function shapeProbe(name, idHex, candidates) {
  console.log(`\n=== ${name} ===`);
  for (const c of candidates) {
    const r = await rawCall(c.sig, [idHex]);
    if (!r.ok) {
      console.log(`  [${c.sig}] → revert: ${r.err}`);
      continue;
    }
    const words = (r.data.replace(/^0x/, "").length) / 64;
    const dec = decodeWords(r.data, c.types);
    console.log(`  [${c.sig}] 返回 ${words} 个字 → ${c.types.length} 期望`);
    console.log(`    ${dec.map((d) => `${d.t}=${d.v}`).join(" | ")}`);
    results.push({ name, sig: c.sig, words, types: c.types.length });
  }
}

// 先拿到一个存在的 bidId / askId
const nextBid = await rawCall("nextBidId()");
const nextAsk = await rawCall("nextAskId()");
const bidId = BigInt(nextBid.data) - 1n;
const askId = nextAsk.ok ? BigInt(nextAsk.data) - 1n : 0n;
console.log(`nextBidId=${BigInt(nextBid.data)}（试 bidId=${bidId}）`);
console.log(`nextAskId=${nextAsk.ok ? BigInt(nextAsk.data) : "REVERT"}（试 askId=${askId}）`);

await shapeProbe("bids(id)", "0x" + bidId.toString(16).padStart(64, "0"), BID_CANDIDATES);
if (nextAsk.ok && BigInt(nextAsk.data) > 0n) {
  await shapeProbe("asks(id)", "0x" + askId.toString(16).padStart(64, "0"), ASK_CANDIDATES);
} else {
  console.log("\n=== asks(id) ===\n  nextAskId 不可读，官方市场无卖单簿（与已知结论一致）");
}

// ── 2. 关键单值接口 ────────────────────────────────────────────────
console.log("\n=== 关键接口 ===");
for (const sig of ["owed(address)", "withdraw()", "feeBps()", "nextBidId()", "nextAskId()"]) {
  const args = sig === "owed(address)" ? [OFFICIAL_PARTS.TAPE_OUT] : [];
  const r = await rawCall(sig, args);
  console.log(`  ${sig} → ${r.ok ? "OK " + r.data : "revert: " + r.err}`);
}

// ── 3. 结论 ────────────────────────────────────────────────────────
console.log("\n=== 结论 ===");
for (const r of results) {
  console.log(`  ${r.name}: 官方返回 ${r.words} 个字；合约当前假设 ${r.types} 个字 → ${r.words === r.types ? "一致" : "不一致 ⚠"}`);
}
