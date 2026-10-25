/**
 * H-5 续：官方晶体管市场的 placeBid 计价语义 + 卖单侧可用性。
 *
 * 已知（probe-market-abi.mjs 结论）：
 *   - bids(id) 返回 6 元组 (buyer, transistors, price, tokenId, feeBps, remaining)  ← 与合约假设一致
 *   - asks(id) / nextAskId() 不可读 → 官方市场只暴露买单侧
 *   - feeBps() = 100 → 市场抽 1% 手续费
 *   - owed(address) / withdraw() 签名有效（withdraw 无参，owed 为 uint256）
 *
 * 待验证（决定主网能否跑通）：
 *   1. placeBid 的 msg.value 到底是 price×quantity，还是 price×quantity×(1+feeBps/10000)？
 *      若需含手续费，Campaign 现在的 `raisedBnb -= qty*price` 就会少付 → placeBid revert。
 *   2. 官方市场是否暴露 placeAsk / cancelAsk / fillAsk？
 *      Campaign 的「晶体管到账后回市场挂卖单」路径（placeTransistorAsk）依赖它们。
 *   3. 官方市场是否有 fillBid（由卖家主动成交）？Campaign 依赖它把晶体管买回来。
 *
 * 全部用 eth_call（只读模拟，不落链、不花真钱）。
 *
 * 用法：node scripts/probe-market-bid.mjs
 */
import { JsonRpcProvider, Network, id, formatEther } from "ethers";

const RPC = process.env.RPC || "https://bsc-rpc.publicnode.com";
const MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const PARTS = "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087";
// 随便一个真实买价（bids(123614) 的 price = 0.05088 BNB/颗）
const PRICE = 50880000000000000n;
const QTY = 1n;
const FEE_BPS = 100n;

const provider = new JsonRpcProvider(RPC, Network.from(56), { staticNetwork: Network.from(56), batchMaxCount: 1 });

async function call(to, sig, args = [], value = 0n) {
  const data =
    id(sig).slice(0, 10) +
    args.map((a) => BigInt(a).toString(16).padStart(64, "0")).join("");
  try {
    const res = await provider.send("eth_call", [{ to, data, value: "0x" + value.toString(16) }, "latest"]);
    return { ok: true, data: res };
  } catch (e) {
    return { ok: false, err: String(e?.shortMessage || e?.message || e).slice(0, 160) };
  }
}

console.log("=== 1. placeBid 计价语义 ===");
const base = PRICE * QTY;
const withFee = base * (10000n + FEE_BPS) / 10000n;
for (const [label, v] of [
  [`price×qty = ${formatEther(base)} BNB`, base],
  [`price×qty×1.01 = ${formatEther(withFee)} BNB`, withFee],
  [`price×qty×1.02 = ${formatEther(base * 102n / 100n)} BNB`, base * 102n / 100n],
  [`0 BNB`, 0n],
]) {
  const r = await call(MARKET, "placeBid(address,uint8,uint96,uint256)", [PARTS, 0n, PRICE, QTY], v);
  console.log(`  ${label} → ${r.ok ? "OK (可接受) id=" + BigInt(r.data) : "revert: " + r.err}`);
}

console.log("\n=== 2. 卖单侧可用性（Campaign.placeTransistorAsk 依赖）===");
for (const sig of ["placeAsk(address,uint8,uint96,uint256)", "cancelAsk(uint256)", "fillAsk(uint256)", "fillBid(uint256)", "cancelBid(uint256)"]) {
  const args = sig.includes("address") ? [PARTS, 0n, PRICE, QTY] : [1n];
  const r = await call(MARKET, sig, args);
  console.log(`  ${sig} → ${r.ok ? "OK (存在)" : "revert: " + r.err}`);
}

console.log("\n=== 3. 其他接口 ===");
for (const sig of ["feeBps()", "nextBidId()", "owner()", "treasury()", "feeRecipient()", "version()"]) {
  const r = await call(MARKET, sig, []);
  console.log(`  ${sig} → ${r.ok ? "OK " + r.data : "revert: " + r.err}`);
}
