// 只部署 CampaignFactory（不部署替身、不开期）。用于已确认 pod / bem / minter 全为线上真实地址时换工厂。
// 现有期次由旧工厂创建，仍可调用；新工厂只承载之后的期次。
// 运行：npx hardhat run scripts/deploy-factory.js --network bsc
//       DRY_RUN=1 只打印参数与预估费用，不发交易。
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const OFFICIAL_MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const OFFICIAL_POD_PROXY = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";

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

  const pod = required("POD_ADDRESS");
  const bem = required("BEM_TOKEN");
  const minter = (process.env.MINTER_ADDRESS || "").trim() || OFFICIAL_MARKET;

  for (const [label, addr] of [["POD_ADDRESS", pod], ["BEM_TOKEN", bem], ["MINTER_ADDRESS", minter]]) {
    if (!ethers.isAddress(addr)) throw new Error(`${label} 不是合法地址：${addr}`);
    if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`${label} ${addr} 在当前链上没有代码`);
  }
  if (pod.toLowerCase() === OFFICIAL_POD_PROXY.toLowerCase()) {
    throw new Error("POD_ADDRESS 不能直接填官方代理，应填 OfficialPodAdapter 地址（execute 需要 adapter 转发）");
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
  console.log(`pod  ：${pod}`);
  console.log(`bem  ：${bem}`);
  console.log(`minter：${minter}`);
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

  const factory = await factoryArtifact.deploy(pod, bem, minter);
  const tx = factory.deploymentTransaction();
  console.log(`已发送部署交易：${tx.hash}`);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`\n✓ CampaignFactory：${factoryAddr}`);
  const onchainSize = (await ethers.provider.getCode(factoryAddr)).length / 2 - 1;
  console.log(`链上运行时代码：${onchainSize} 字节`);
  if (onchainSize !== runtimeBytes) console.warn(`⚠ 链上长度与本地 artifact（${runtimeBytes}）不一致`);

  // 读回构造函数参数，确认链上配置与预期一致（不是替身地址）。
  const [podOnChain, bemOnChain, minterOnChain] = await Promise.all([factory.pod(), factory.bem(), factory.minter()]);
  if (podOnChain.toLowerCase() !== pod.toLowerCase()) throw new Error("链上 pod 与预期不一致");
  if (bemOnChain.toLowerCase() !== bem.toLowerCase()) throw new Error("链上 bem 与预期不一致");
  if (minterOnChain.toLowerCase() !== minter.toLowerCase()) throw new Error("链上 minter 与预期不一致");

  const fePath = join(__dirname, "..", "..", "frontend", "src", "chain", "deployments.json");
  let prev = {};
  if (existsSync(fePath)) prev = JSON.parse(readFileSync(fePath, "utf8"));
  const legacy = Array.isArray(prev.legacyFactories) ? prev.legacyFactories.slice() : [];
  if (Number(prev.chainId) === chainId && prev.factory && prev.factory.toLowerCase() !== factoryAddr.toLowerCase()) {
    legacy.unshift(prev.factory);
  }
  const out = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    bem,
    bemConfigured: bem,
    bemIsMock: false,
    pod,
    minter,
    factory: factoryAddr,
    legacyFactories: legacy,
    campaign: "",
    campaignParams: null,
    deployer: deployer.address,
    podIsAdapter: true,
    officialPod: OFFICIAL_POD_PROXY,
    notes: `工厂已换新（${tx.hash}），尚未开期。旧工厂的期次仍可调用，但不出现在新列表里。`,
  };
  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  writeFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));
  mkdirSync(join(__dirname, "..", "chain"), { recursive: true });
  writeFileSync(fePath, JSON.stringify(out, null, 2));
  console.log("地址已写入 deployments 与 frontend/src/chain/deployments.json");
  try {
    const { verifyPublished } = require("./verify-published");
    await verifyPublished();
  } catch (e) {
    console.warn(`开源验证未完成：${e.message || e}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
