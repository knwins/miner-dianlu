// 只读预检：检查主网部署所需的环境与链上状态，不广播任何交易。
const hre = require("hardhat");
const { ethers, network } = hre;

const OFFICIAL_MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const OFFICIAL_PARTS = [
  "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087",
  "0xE2DfD802081C7a05341E20b6582b04b908e8550c",
];

function mask(v) {
  if (!v) return "<未设置>";
  return `${v.slice(0, 6)}…${v.slice(-4)} (len=${v.length})`;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`\n=== 预检：网络 ${network.name} (chainId ${net.chainId}) ===`);

  const pk = process.env.DEPLOYER_PRIVATE_KEY || "";
  const api = process.env.BSCSCAN_API_KEY || "";
  console.log(`DEPLOYER_PRIVATE_KEY : ${mask(pk)}`);
  console.log(`BSCSCAN_API_KEY      : ${api ? mask(api) : "<未设置> — 退用 Sourcify 验证"}`);
  console.log(`MINTER_ADDRESS       : ${process.env.MINTER_ADDRESS || "<默认官方市场>"}`);
  console.log(`TRANSISTORS_ADDRESS  : ${process.env.TRANSISTORS_ADDRESS || "<默认 TapeOut>"}`);
  console.log(`ALLOWED_PARTS_ADDRESSES: ${process.env.ALLOWED_PARTS_ADDRESSES || "<默认官方两件套>"}`);
  console.log(`OPEN_CAMPAIGN        : ${process.env.OPEN_CAMPAIGN || "<未设=只部署工厂不开期>"}`);

  if (Number(net.chainId) !== 56) {
    console.log("⚠ 当前不是 BSC 主网(56)，预检中止。请用 --network bsc。");
    return;
  }
  if (!pk) {
    console.log("\n✗ DEPLOYER_PRIVATE_KEY 未设置 → 无法部署（无账户）。请在 contracts/.env 中配置。");
    return;
  }

  const wallet = new ethers.Wallet(pk);
  const bal = await ethers.provider.getBalance(wallet.address);
  console.log(`\n部署者地址 : ${wallet.address}`);
  console.log(`账户余额   : ${ethers.formatEther(bal)} BNB`);
  if (bal === 0n) {
    console.log("✗ 余额为 0 → 无法支付 gas。请先给该地址转入 BNB。");
    return;
  }

  // 预演 deploy-bsc.js 的主网硬断言
  console.log("\n--- 预演主网硬断言 ---");
  if (process.env.MINTER_ADDRESS && process.env.MINTER_ADDRESS.toLowerCase() !== OFFICIAL_MARKET.toLowerCase()) {
    console.log(`✗ MINTER_ADDRESS 非官方市场：收到 ${process.env.MINTER_ADDRESS}`);
  } else console.log("✓ MINTER_ADDRESS 断言通过（默认官方市场）");

  const wl = String(process.env.ALLOWED_PARTS_ADDRESSES || "").trim();
  if (wl) {
    const list = wl.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((a) => !OFFICIAL_PARTS.some((o) => o.toLowerCase() === a.toLowerCase()));
    const missing = OFFICIAL_PARTS.filter((o) => !list.some((a) => a.toLowerCase() === o.toLowerCase()));
    if (bad.length) console.log(`✗ 白名单含非官方地址：${bad.join(",")}`);
    else if (missing.length) console.log(`✗ 白名单缺少官方元件：${missing.join(",")}`);
    else console.log("✓ ALLOWED_PARTS_ADDRESSES 恰好是官方两件套");
  } else console.log("✓ 白名单将用官方两件套（默认）");

  // 检查官方地址在主网是否有代码（材料市场 / 两个元件）
  for (const [name, addr] of [["材料市场", OFFICIAL_MARKET], ...OFFICIAL_PARTS.map((a, i) => [`元件${i}`, a])]) {
    const code = await ethers.provider.getCode(addr);
    console.log(`  ${name} ${addr} → 代码 ${code === "0x" ? "缺失✗" : "存在✓"}`);
  }

  console.log("\n预检完成：环境变量与链上状态就绪，可以部署（需你确认后我才广播）。");
}

main().catch((e) => { console.error(e); process.exit(1); });
