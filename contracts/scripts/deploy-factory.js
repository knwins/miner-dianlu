// 只部署 CampaignDeployer + CampaignFactory（不开期）。
// 工厂构造 5 参：circuitMarket / allowedCircuits / podMining / bem / campaignDeployer。
// 运行：node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/deploy-factory.js --network bsc
//       DRY_RUN=1 只打印参数，不发交易。
const { ethers, network } = require("hardhat");
const { collectLegacyFactories, writeDeploymentRecords } = require("./_records");
const { deployContract: safeDeploy, createAddress } = require("./_deploy");

const OFFICIAL_CIRCUIT_MARKET = "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f";
const OFFICIAL_POD_MINING = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const OFFICIAL_BEM = "0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a";
const OFFICIAL_CIRCUITS = [
  "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C", // TapeOut
  "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c", // Behemoth
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
  const dryRun = process.env.DRY_RUN === "1";
  const mainnet = chainId === 56;

  const market = env("CIRCUIT_MARKET_ADDRESS") || OFFICIAL_CIRCUIT_MARKET;
  const podMining = env("POD_MINING_ADDRESS") || (mainnet ? OFFICIAL_POD_MINING : "");
  const bem = env("BEM_ADDRESS") || (mainnet ? OFFICIAL_BEM : "");
  const allowedFromEnv = env("ALLOWED_CIRCUITS_ADDRESSES");
  const allowedCircuits = allowedFromEnv
    ? allowedFromEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : OFFICIAL_CIRCUITS;

  if (allowedCircuits.length === 0) throw new Error("电路 NFT 白名单不能为空");
  if (!podMining) throw new Error("必须指定 POD_MINING_ADDRESS（主网默认官方 PoD）");
  if (!bem) throw new Error("必须指定 BEM_ADDRESS（主网默认官方 BEM）");

  await requireCode(market, "电路市场");
  await requireCode(podMining, "PoD 挖矿");
  await requireCode(bem, "BEM");

  const erc165 = new ethers.Interface(["function supportsInterface(bytes4) view returns (bool)"]);
  for (const addr of allowedCircuits) {
    await requireCode(addr, "电路白名单");
    const [is721, is165] = await Promise.all([
      ethers.provider.call({ to: addr, data: erc165.encodeFunctionData("supportsInterface", ["0x80ac58cd"]) }),
      ethers.provider.call({ to: addr, data: erc165.encodeFunctionData("supportsInterface", ["0x01ffc9a7"]) }),
    ]).then(([a, b]) => [
      erc165.decodeFunctionResult("supportsInterface", a)[0],
      erc165.decodeFunctionResult("supportsInterface", b)[0],
    ]).catch(() => [false, false]);
    if (!is721 || !is165) throw new Error(`电路白名单 ${addr} 不是 ERC721 合约`);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  const factoryArt = require("../artifacts/contracts/CampaignFactory.sol/CampaignFactory.json");
  const deployerArt = require("../artifacts/contracts/CampaignDeployer.sol/CampaignDeployer.json");
  const factoryRuntime = (factoryArt.deployedBytecode.length - 2) / 2;
  const campaignRuntime = (require("../artifacts/contracts/Campaign.sol/Campaign.json").deployedBytecode.length - 2) / 2;
  const deployerRuntime = (deployerArt.deployedBytecode.length - 2) / 2;

  console.log(`网络：${network.name} (chainId ${chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(balance)} BNB`);
  console.log(`Campaign 运行时：${campaignRuntime} 字节`);
  console.log(`CampaignDeployer 运行时：${deployerRuntime} 字节`);
  console.log(`Factory 运行时：${factoryRuntime} 字节（上限 24,576）`);
  console.log(`电路市场：${market}`);
  console.log(`PoD 挖矿：${podMining}`);
  console.log(`BEM     ：${bem}`);
  console.log(`电路白名单：${allowedCircuits.length} 项`);
  allowedCircuits.forEach((a, i) => console.log(`   [${i}] ${a}`));
  if (factoryRuntime > 24_576) throw new Error("Factory 运行时代码已超限");
  if (campaignRuntime > 24_576) throw new Error("Campaign 运行时代码已超限");

  if (dryRun) {
    console.log("\nDRY_RUN=1，未发送交易。");
    return;
  }

  const nonce0 = await ethers.provider.getTransactionCount(deployer.address, "pending");
  console.log(`预计 CampaignDeployer：${createAddress(deployer.address, nonce0)}（nonce ${nonce0}）`);
  console.log(`预计 CampaignFactory ：${createAddress(deployer.address, nonce0 + 1)}（nonce ${nonce0 + 1}）`);

  // 先装回读 guard：hardhat-ethers 对 CREATE 的 to="" 会在广播成功后扔未处理拒绝。
  require("./_deploy"); // installReadbackGuard via deployContract's first call
  const deployerDeployed = await safeDeploy("CampaignDeployer", []);
  const campaignDeployer = deployerDeployed.address;
  console.log(`\n✓ CampaignDeployer：${campaignDeployer}`);
  console.log(`  交易：${deployerDeployed.hash}（块 ${deployerDeployed.blockNumber}）`);
  // 给公共 RPC 一点时间，并让上一笔 CREATE 的异步回读错误先被吞掉。
  await new Promise((r) => setTimeout(r, 3000));

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
    throw new Error(`链上电路白名单数量不一致：期望 ${allowedCircuits.length}，实际 ${nAllowed}`);
  }
  for (let i = 0; i < allowedCircuits.length; i++) {
    const onChain = await factory.allowedCircuitsAt(i);
    if (onChain.toLowerCase() !== allowedCircuits[i].toLowerCase()) {
      throw new Error(`链上电路白名单 [${i}] 不一致：${onChain} ≠ ${allowedCircuits[i]}`);
    }
  }
  console.log("✓ 工厂读回一致（市场 / PoD / BEM / Deployer / 白名单）");

  // 旧工厂地址仅写入 contracts/deployments 备份字段，前端不再消费。
  const legacyFactories = collectLegacyFactories(network.name, chainId, factoryAddr);
  const out = {
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
    notes: "含 onERC721Received + 官方 PoD/BEM 的工厂。尚未开期；开期须选白名单内 ERC721。",
    _legacyFactoriesBackup: legacyFactories,
  };
  writeDeploymentRecords(network.name, out);
  console.log("地址已写入 deployments 与 frontend/src/chain/deployments.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
