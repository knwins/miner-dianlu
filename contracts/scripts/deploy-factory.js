// 只部署 CampaignFactory（不部署替身、不开期）。用于换工厂：materialMarket 是 immutable，
// 换材料市场必须重部署一个工厂。元件合约不再有默认（每期开期时显式选），现有期次由旧工厂创建仍可调用。
// 运行：npx hardhat run scripts/deploy-factory.js --network bscTestnet
//       DRY_RUN=1 只打印参数与预估费用，不发交易。
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { collectLegacyFactories, writeDeploymentRecords } = require("./_records");
const { deployContract: safeDeploy } = require("./_deploy");

const OFFICIAL_MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";

/**
 * 官方材料市场的两个元件合约（= 两个官方处理器的元件）。
 *
 * 白名单必须包含**全部两个**：少一个的话，那个处理器的期次在主网上根本开不了。
 *
 * ⚠️ T-59：官方 Genesis CPU（processorMultiplier = 0、永远不出矿）已从项目整体移除，
 * 它的元件合约不在白名单里 —— 既不采购、也不开期。
 *
 * ⚠️ 白名单是**安全边界**不是运营开关：不在白名单里的 ERC1155 会被工厂直接拒绝，
 * 目的是防止 owner 把期次指向 MockERC1155（其 mint 无访问控制，任何人能无限造元件）。
 */
const OFFICIAL_PARTS = [
  "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", // TapeOut（CPU 0xb1024b89…）
  "0xE2DfD802081C7a05341E20b6582b04b908e8550c", // Behemoth（CPU 0x1f5cb4ae…）
];

function required(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`缺少 ${name}（部署前请写入 .env）`);
  return v;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const dryRun = process.env.DRY_RUN === "1";

  const minter = (process.env.MINTER_ADDRESS || "").trim() || OFFICIAL_MARKET;
  /**
   * 元件白名单：部署时写入、之后不可增删（安全边界）。
   *
   * 来源优先级：
   *   1. ALLOWED_PARTS_ADDRESSES —— 逗号分隔的完整覆盖（测试网要用 Mock 等）
   *   2. 官方两件套（主网默认）
   *
   * 工厂不再有「默认元件」：每个期次开期时由前端从白名单里显式选一个处理器，
   * 所以白名单必须是官方两件套（主网）或测试网替身，且不能少。
   */
  const allowedFromEnv = (process.env.ALLOWED_PARTS_ADDRESSES || "").trim();
  const allowedParts = allowedFromEnv
    ? allowedFromEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : OFFICIAL_PARTS;
  if (allowedParts.length === 0) throw new Error("元件白名单不能为空");

  if (!ethers.isAddress(minter)) throw new Error(`MINTER_ADDRESS 不是合法地址：${minter}`);
  if ((await ethers.provider.getCode(minter)) === "0x") throw new Error(`MINTER_ADDRESS ${minter} 在当前链上没有代码`);
  for (const addr of allowedParts) {
    if (!ethers.isAddress(addr)) throw new Error(`元件白名单含非法地址：${addr}`);
    if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`元件白名单 ${addr} 在当前链上没有代码`);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  const factoryArtifact = await ethers.getContractFactory("CampaignFactory");
  const bytecode = factoryArtifact.bytecode;
  const size = (bytecode.length - 2) / 2;
  console.log(`网络：${network.name} (chainId ${chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(balance)} BNB`);
  // 创建码含 Campaign 的初始化代码 + 构造函数，天然可以超过 24,576（EIP-170 只管运行时代码）。
  // 真正的闸门是部署后的运行时代码大小；先按运行时代码预检，部署后再复核链上代码长度。
  const factoryArt = require("../artifacts/contracts/CampaignFactory.sol/CampaignFactory.json");
  const runtimeBytes = (factoryArt.deployedBytecode.length - 2) / 2;
  console.log(`Factory 创建码：${size} 字节，运行时 ${runtimeBytes} 字节（上限 24,576）`);
  console.log(`materialMarket ：${minter}`);
  console.log(`元件白名单  ：${allowedParts.length} 项`);
  allowedParts.forEach((a, i) => console.log(`   [${i}] ${a}`));
  if (runtimeBytes > 24_576) throw new Error("Factory 运行时代码已超限，先 npm run size 处理体积");

  if (dryRun) {
    const gas = await ethers.provider.estimateGas({ from: deployer.address, data: bytecode }).catch(() => null);
    if (gas) {
      const fee = await ethers.provider.getFeeData();
      const price = fee.maxFeePerGas || fee.gasPrice || 0n;
      console.log(`预估 gas：${gas} ，按 ${ethers.formatUnits(price, "gwei")} gwei 约 ${ethers.formatEther(gas * price)} BNB`);
    }
    console.log("\nDRY_RUN=1，未发送交易。");
    return;
  }

  // 不用 factory.deploy() + waitForDeployment() —— hardhat-ethers 读合约创建交易时
  // 会在 getTransaction → formatTransactionResponse 上抛 invalid value for value.to（to 是空字符串）。
  // 见 scripts/_deploy.js 顶部说明。
  const factoryDeployed = await safeDeploy("CampaignFactory", [minter, allowedParts]);
  const factoryAddr = factoryDeployed.address;
  const factory = await ethers.getContractAt("CampaignFactory", factoryAddr);
  console.log(`\n✓ CampaignFactory：${factoryAddr}`);
  console.log(`  部署交易：${factoryDeployed.hash}（块 ${factoryDeployed.blockNumber}）`);
  const onchainSize = (await ethers.provider.getCode(factoryAddr)).length / 2 - 1;
  console.log(`链上运行时代码：${onchainSize} 字节`);
  if (onchainSize !== runtimeBytes) console.warn(`⚠ 链上长度与本地 artifact（${runtimeBytes}）不一致`);

  // 读回构造函数参数，确认链上配置与预期一致（不是替身地址）。
  const [mmOnChain, nAllowed] = await Promise.all([
    factory.materialMarket(),
    factory.allowedPartsCount(),
  ]);
  if (mmOnChain.toLowerCase() !== minter.toLowerCase()) throw new Error("链上 materialMarket 与预期不一致");
  if (Number(nAllowed) !== allowedParts.length) {
    throw new Error(`链上元件白名单数量不一致：期望 ${allowedParts.length}，实际 ${nAllowed}`);
  }
  for (let i = 0; i < allowedParts.length; i++) {
    const onChain = await factory.allowedPartsAt(i);
    if (onChain.toLowerCase() !== allowedParts[i].toLowerCase()) {
      throw new Error(`链上元件白名单 [${i}] 与预期不一致：${onChain} ≠ ${allowedParts[i]}`);
    }
  }
  console.log(`✓ 元件白名单读回一致（${nAllowed} 项）`);

  const legacy = collectLegacyFactories(network.name, chainId, factoryAddr);
  const out = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    materialMarket: minter,
    /**
     * 元件白名单（= 这个工厂能创建的期次可选的处理器）。
     * 前端开期表单直接从这份链上事实生成可选项，不硬编码处理器列表。
     * 工厂不再有默认元件——每期开期时由前端显式选一个白名单内的地址。
     */
    allowedParts,
    factory: factoryAddr,
    legacyFactories: legacy,
    campaign: "",
    campaignParams: null,
    deployer: deployer.address,
    notes: `工厂已换新（${tx.hash}），尚未开期。旧工厂的期次仍可调用，但不出现在新列表里。`,
  };
  writeDeploymentRecords(network.name, out);
  console.log("地址已写入 deployments 与 frontend/src/chain/deployments.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
