/**
 * 官方晶体管市场（主网 0xA6a8…）的完整接口面探测。
 *
 * 背景：
 *   Campaign 的晶体管取得路径是 placeBid（买）→ fillBid（成交）→ ERC1155 直接转进 Campaign。
 *   但上一轮探测发现：placeAsk / cancelAsk / fillAsk / fillBid 全部 "missing revert data"。
 *   如果 fillBid 真的不存在，那「owner 下单买晶体管」永远成交不了 —— 主网直接死路。
 *   也有可能是官方用了别的函数名（accept / sell / match / take …）。
 *
 * 做法：批量 eth_call 候选函数名，看哪些 selector 在代理上真实存在。
 *   - "missing revert data" + 非常规长度：通常是代理 fallback 吃掉了调用 → 该 selector 不存在
 *   - 有具体 revert 字符串（如 "not your bid"）：函数存在
 *   - 返回 32 字节 0：函数存在且返回 0
 *
 * 用法：node scripts/probe-market-surface.mjs
 */
import { JsonRpcProvider, Network, id } from "ethers";

const RPC = process.env.RPC || "https://bsc-rpc.publicnode.com";
const MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const PARTS = "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087";

const provider = new JsonRpcProvider(RPC, Network.from(56), { staticNetwork: Network.from(56), batchMaxCount: 1 });

const ARG0 = [PARTS.slice(2).toLowerCase().padStart(64, "0")];
const ARG1 = ["1".padStart(64, "0")];
const enc = (v) => BigInt(v).toString(16).padStart(64, "0");

/** 按函数签名的参数类型正确编码 calldata —— 参数个数/类型错会导致「假不存在」。 */
function encodeArgs(sig) {
  const m = sig.match(/\((.*)\)/);
  const types = (m?.[1] || "").split(",").filter(Boolean);
  return types.map((t) => {
    if (t === "address") return PARTS.slice(2).toLowerCase().padStart(64, "0");
    if (t === "bytes") return "0".padStart(64, "0");
    if (t === "bytes32[]" || t === "uint256[]") return enc(0) + enc(0);
    return enc(1); // uintN / bool
  });
}

async function probe(sig, args = []) {
  const data = id(sig).slice(0, 10) + args.join("");
  try {
    const res = await provider.send("eth_call", [{ to: MARKET, data }, "latest"]);
    return { kind: "ok", data: res };
  } catch (e) {
    const m = String(e?.shortMessage || e?.message || e);
    if (m.includes("missing revert data")) return { kind: "absent" };
    return { kind: "revert", msg: m.replace(/^.*?revert/, "revert").slice(0, 90) };
  }
}

const SELLERSIDE = [
  "fillBid(uint256)", "fill(uint256)", "acceptBid(uint256)", "accept(uint256)",
  "takeBid(uint256)", "matchBid(uint256)", "sell(uint256,uint256)", "match(uint256)",
  "settleBid(uint256)", "fillBid(uint256,uint256)", "fillOrder(uint256)",
  "placeAsk(address,uint8,uint96,uint256)", "createAsk(address,uint8,uint96,uint256)",
  "listParts(address,uint8,uint96,uint256)", "asks(uint256)", "nextAskId()",
  "cancelAsk(uint256)", "fillAsk(uint256)", "ask(uint256)", "order(uint256)",
  "orders(uint256)", "nextOrderId()", "openOrders(uint256,uint256)", "ordersCount()",
];
const READS = [
  "nextBidId()", "feeBps()", "owed(address)", "withdraw()", "bids(uint256)",
  "market()", "parts()", "treasury()", "feeTo()", "feeCollector()", "admin()",
  "paused()", "nonce()", "DOMAIN_SEPARATOR()", "version()", "name()", "symbol()",
  "totalBids()", "bidCount()", "minPrice()", "maxPrice()", "minQuantity()",
  "getBid(uint256)", "bidOf(uint256)", "getBids(address,uint256)",
  "filledBids(uint256)", "canceledBids(uint256)", "bidStatus(uint256)",
];
const WRITE_MISC = [
  "cancelBid(uint256)", "placeBid(address,uint8,uint96,uint256)",
  "setFeeBps(uint16)", "setTreasury(address)", "pause()", "unpause()",
  "withdraw(address)", "claim(address)", "sweep()", "rescue(address,uint256)",
  "fillBid(uint256,uint256,bytes)", "fillBids(uint256[],uint256[])",
];

async function run(title, sigs) {
  console.log(`\n=== ${title} ===`);
  const absent = [];
  const present = [];
  for (const sig of sigs) {
    const r = await probe(sig, encodeArgs(sig));
    if (r.kind === "absent") absent.push(sig);
    else present.push(`${sig} → ${r.kind === "ok" ? "OK " + r.data.slice(0, 18) + "…" : r.msg}`);
  }
  console.log("  存在/可调用:");
  present.forEach((p) => console.log("    " + p));
  console.log(`  不存在 (${absent.length}): ${absent.join(", ")}`);
}

await run("卖单侧候选", SELLERSIDE);
await run("只读接口", READS);
await run("其他写接口", WRITE_MISC);
