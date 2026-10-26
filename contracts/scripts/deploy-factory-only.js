// 仅部署 CampaignFactory，复用已上链的 CampaignDeployer。
// 用法：
//   CAMPAIGN_DEPLOYER=0x… node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/deploy-factory-only.js --network bsc
const { ethers, network } = require("hardhat");
const { collectLegacyFactories, writeDeploymentRecords } = require("./_records");
const { deployContract: safeDeploy } = require("./_deploy");

const OFFICIAL_CIRCUIT_MARKET = "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f";
const OFFICIAL_POD_MINING = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const OFFICIAL_BEM = "0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a";
const OFFICIAL_CIRCUITS = [
  "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
  "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c",
];

function env(...names) {
  for (const name of names) {
    const v = (process.env[name] || "").trim();
    if (v) return v;
  }
  return "";
}

async function requireCode(addr, label) {
  if (!ethers.isAddress(addr)) throw new Error(`${label} 地址不合法：${addr}`);
  if ((await ethers.provider.getCode(addr)) === "0x") {
    throw new Error(`${label} ${addr} 在当前链上没有代码`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const mainnet = chainId === 56;

  const campaignDeployer = env("CAMPAIGN_DEPLOYER");
  if (!campaignDeployer) throw new Error("必须设置 CAMPAIGN_DEPLOYER");

  const market = env("CIRCUIT_MARKET_ADDRESS") || OFFICIAL_CIRCUIT_MARKET;
  const podMining = env("POD_MINING_ADDRESS") || (mainnet ? OFFICIAL_POD_MINING : "");
  const bem = env("BEM_ADDRESS") || (mainnet ? OFFICIAL_BEM : "");
  const allowedFromEnv = env("ALLOWED_CIRCUITS_ADDRESSES");
  const allowedCircuits = allowedFromEnv
    ? allowedFromEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : OFFICIAL_CIRCUITS;

  if (!podMining || !bem) throw new Error("缺少 POD_MINING_ADDRESS / BEM_ADDRESS");
  if (allowedCircuits.length === 0) throw new Error("电路白名单不能为空");

  await requireCode(market, "电路市场");
  await requireCode(podMining, "PoD 挖矿");
  await requireCode(bem, "BEM");
  await requireCode(campaignDeployer, "CampaignDeployer");

  const balance = await ethers.provider.getBalance(deployer.address);
  const factoryArt = require("../artifacts/contracts/CampaignFactory.sol/CampaignFactory.json");
  const factoryRuntime = (factoryArt.deployedBytecode.length - 2) / 2;

  console.log(`网络：${network.name} (chainId ${chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(balance)} BNB`);
  console.log(`复用 CampaignDeployer：${campaignDeployer}`);
  console.log(`Factory 运行时：${factoryRuntime} 字节`);
  console.log(`电路市场：${market}`);
  console.log(`PoD / BEM：${podMining} / ${bem}`);
  allowedCircuits.forEach((a, i) => console.log(`  白名单[${i}] ${a}`));
  if (factoryRuntime > 24_576) throw new Error("Factory 运行时代码已超限");

  const factoryDeployed = await safeDeploy("CampaignFactory", [
    market,
    allowedCircuits,
    podMining,
    bem,
    campaignDeployer,
  ]);
  const factoryAddr = factoryDeployed.address;
  const factory = await ethers.getContractAt("CampaignFactory", factoryAddr);
  console.log(`\n✓ CampaignFactory：${factoryAddr}`);
  console.log(`  交易：${factoryDeployed.hash}（块 ${factoryDeployed.blockNumber}）`);

  const [marketOnChain, podOnChain, bemOnChain, deployerOnChain, nAllowed] = await Promise.all([
    factory.circuitMarket(),
    factory.podMining(),
    factory.bem(),
    factory.campaignDeployer(),
    factory.allowedCircuitsCount(),
  ]);
  if (marketOnChain.toLowerCase() !== market.toLowerCase()) throw new Error("链上 circuitMarket 不一致");
  if (podOnChain.toLowerCase() !== podMining.toLowerCase()) throw new Error("链上 podMining 不一致");
  if (bemOnChain.toLowerCase() !== bem.toLowerCase()) throw new Error("链上 bem 不一致");
  if (deployerOnChain.toLowerCase() !== campaignDeployer.toLowerCase()) {
    throw new Error("链上 campaignDeployer 不一致");
  }
  if (Number(nAllowed) !== allowedCircuits.length) {
    throw new Error(`白名单数量不一致：期望 ${allowedCircuits.length}，实际 ${nAllowed}`);
  }
  for (let i = 0; i < allowedCircuits.length; i++) {
    const onChain = await factory.allowedCircuitsAt(i);
    if (onChain.toLowerCase() !== allowedCircuits[i].toLowerCase()) {
      throw new Error(`白名单 [${i}] 不一致`);
    }
  }
  console.log("✓ 工厂读回一致");

  const legacyFactories = collectLegacyFactories(network.name, chainId, factoryAddr);
  writeDeploymentRecords(network.name, {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    circuitMarket: market,
    podMining,
    bem,
    campaignDeployer,
    allowedCircuits,
    factory: factoryAddr,
    campaign: "",
    campaignParams: null,
    deployer: deployer.address,
    factoryDeploymentTx: factoryDeployed.hash,
    factoryDeploymentBlock: factoryDeployed.blockNumber,
    factoryRuntimeBytes: factoryRuntime,
    notes: "复用已上链 CampaignDeployer 的工厂部署；尚未开期。",
    _legacyFactoriesBackup: legacyFactories,
  });
  console.log("地址已写入 deployments 与 frontend/src/chain/deployments.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
