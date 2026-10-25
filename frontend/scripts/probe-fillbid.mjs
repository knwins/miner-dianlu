/**
 * 官方晶体管市场 fillBid 的真实签名与交付语义。
 *
 * 已知（probe-market-surface.mjs）：官方市场存在 fillBid(uint256,uint256)，且**只有买单侧**。
 * 合约注释假设：owner placeBid（托管 BNB）→ 卖家 fillBid → ERC1155 晶体管直接进 Campaign。
 * 待确认：
 *   1. fillBid 的两个参数各是什么（bidId + ?）—— 合约不直接调它，但要确认流程成立。
 *   2. 成交后晶体管是否真的转进买家地址（Campaign 的 onERC1155Received 钩子才有意义）。
 *   3. 手续费：feeBps=100（1%），成交额里扣掉后，卖家实收多少；Campaign 锁价是否够付。
 *
 * 全部 eth_call 模拟，不花真钱。
 * 用法：node scripts/probe-fillbid.mjs
 */
import { JsonRpcProvider, Network, id, formatEther } from "ethers";

const RPC = process.env.RPC || "https://bsc-rpc.publicnode.com";
const MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const PARTS = "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087";

const provider = new JsonRpcProvider(RPC, Network.from(56), { staticNetwork: Network.from(56), batchMaxCount: 1 });
const enc = (v) => BigInt(v).toString(16).padStart(64, "0");

async function call(sig, args = [], value = 0n) {
  const data = id(sig).slice(0, 10) + args.map(enc).join("");
  try {
    const res = await provider.send("eth_call", [{ to: MARKET, data, value: "0x" + value.toString(16) }, "latest"]);
    return { kind: "ok", data: res };
  } catch (e) {
    const m = String(e?.shortMessage || e?.message || e);
    if (m.includes("missing revert data")) return { kind: "absent" };
    return { kind: "revert", msg: m.replace(/^.*?revert/, "revert").slice(0, 120) };
  }
}

// 取一个真实的、官方晶体管（TapeOut）的买单
const nb = await call("nextBidId()");
const bidId = BigInt(nb.data) - 1n;
const b = await call("bids(uint256)", [bidId]);
const words = b.data.replace(/^0x/, "").match(/.{64}/g) || [];
const buyer = "0x" + words[0].slice(24);
const price = BigInt("0x" + words[2]);
const tokenId = BigInt("0x" + words[3]);
const feeBps = BigInt("0x" + words[4]);
const remaining = BigInt("0x" + words[5]);
console.log(`bids(${bidId}) = buyer=${buyer} price=${formatEther(price)} BNB tokenId=${tokenId} feeBps=${feeBps} remaining=${remaining}`);

console.log("\n=== fillBid 候选签名 × 参数组合 ===");
const CAND = ["fillBid(uint256,uint256)", "fillBid(uint256,uint256,uint256)", "fillBid(uint256,address,uint256)"];
for (const sig of CAND) {
  const nArgs = (sig.match(/,/g) || []).length + 1;
  const combos = [];
  combos.push({ label: `(${bidId}, ${remaining})`, args: [bidId, remaining] });
  combos.push({ label: `(${bidId}, ${price})`, args: [bidId, price] });
  combos.push({ label: `(${bidId}, 0)`, args: [bidId, 0n] });
  combos.push({ label: `(${bidId}, ${bidId})`, args: [bidId, bidId] });
  for (const c of combos) {
    if (c.args.length !== nArgs) continue;
    const r = await call(sig, c.args);
    console.log(`  ${sig} ${c.label} → ${r.kind === "ok" ? "OK " + r.data.slice(0, 20) + "…" : r.kind === "absent" ? "不存在" : r.msg}`);
  }
}

console.log("\n=== 语义推断辅助：市场是否暴露 owner 侧 / 事件面 ===");
for (const sig of ["owner()", "paused()", "fillCount()", "filled(uint256)"]) {
  const r = await call(sig, []);
  console.log(`  ${sig} → ${r.kind === "ok" ? "OK " + r.data.slice(0, 20) + "…" : r.kind === "absent" ? "不存在" : r.msg}`);
}

console.log("\n=== 手续费换算 ===");
const gross = price * remaining;
const fee = gross * feeBps / 10000n;
console.log(`  成交总额 ${formatEther(gross)} BNB，市场抽 ${feeBps} bps = ${formatEther(fee)} BNB，卖家实收 ${formatEther(gross - fee)} BNB`);
console.log(`  Campaign 锁价 priceLock = qty×price = ${formatEther(gross)} BNB（与托管一致，够付）`);
