// 部署到 BSC 测试网：MockPoD/MockMinter（调试替身，除非提供真实地址）→ CampaignFactory → 开一期。
// 地址写回 contracts/deployments/bscTestnet.json 与 frontend/src/chain/deployments.json 供前端对接。
// 运行：npx hardhat run scripts/deploy-bsc.js --network bscTestnet
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const BEM_TOKEN = process.env.BEM_TOKEN || "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a";
const OFFICIAL_MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const OFFICIAL_POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`网络：${network.name} (chainId ${net.chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
  if (!BEM_TOKEN || !ethers.isAddress(BEM_TOKEN)) throw new Error("BEM_TOKEN 地址非法");

  const mainnet = Number(net.chainId) === 56;
  // BEM：主网必须是真实代币。测试网该地址无代码时才改布 MockBEM。
  let bem = BEM_TOKEN;
  let bemIsMock = false;
  if ((await ethers.provider.getCode(bem)) === "0x") {
    if (mainnet) throw new Error(`主网 BEM ${BEM_TOKEN} 没有代码，停止部署`);
    const mb = await ethers.deployContract("MockBEM");
    await mb.waitForDeployment();
    bem = await mb.getAddress();
    bemIsMock = true;
    await (await ethers.getContractAt("MockBEM", bem)).mint(deployer.address, ethers.parseUnits("1000000", 18));
    console.log(`⚠ 目标链上 BEM ${BEM_TOKEN} 无代码（真实 BEM 在 BSC 主网）。已改布 MockBEM：${bem}（仅供测试网调试）`);
  } else {
    console.log(`BEM       ：${bem}`);
  }

  // 1) 材料市场：主网默认官方 placeBid 合约。
  //    不要把官方 PoD 代理直接写成 POD_ADDRESS。官方 start 要求调用者是电路 NFT 主人，
  //    且参数与 IPoD 不同。设 USE_OFFICIAL_POD=1 时部署 OfficialPodAdapter。
  let pod = process.env.POD_ADDRESS || "";
  let minter = process.env.MINTER_ADDRESS || (mainnet ? OFFICIAL_MARKET : "");
  let podIsAdapter = false;
  if (!pod && process.env.USE_OFFICIAL_POD === "1") {
    const adapter = await ethers.deployContract("OfficialPodAdapter", [OFFICIAL_POD, bem]);
    await adapter.waitForDeployment();
    pod = await adapter.getAddress();
    podIsAdapter = true;
    console.log(`OfficialPodAdapter ：${pod} → ${OFFICIAL_POD}`);
    console.log("  execute 前须让当期合约持有电路 NFT；startData 用 scripts/encode-start-data.js 打包证明。");
  } else if (mainnet && !process.env.POD_ADDRESS) {
    console.log(`PoD       ：不接 ${OFFICIAL_POD}。本次部署挖矿替身。接入官方请设 USE_OFFICIAL_POD=1。`);
  }
  if (!pod) {
    const m = await ethers.deployContract("MockPoD", [bem, 408]);
    await m.waitForDeployment();
    pod = await m.getAddress();
    console.log(`MockPoD    ：${pod}（调试替身，生产换 OfficialPodAdapter）`);
  }
  if (!podIsAdapter) {
    try {
      const probe = new ethers.Contract(pod, ["function podUsesDelegatecall() view returns (bool)"], ethers.provider);
      podIsAdapter = await probe.podUsesDelegatecall();
    } catch {
      podIsAdapter = false;
    }
  }
  if (!minter) {
    const m = await ethers.deployContract("MockMaterialMarket");
    await m.waitForDeployment();
    minter = await m.getAddress();
    console.log(`MaterialMarket ：${minter}（placeBid 替身，主网换 0xA6a80C1919a8326022d7c601a488888C13aA16E4）`);
  }

  // 2) 工厂
  const factory = await ethers.deployContract("CampaignFactory", [pod, bem, minter]);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`Factory    ：${factoryAddr}`);

  // 3) 开一期。主网默认不开，避免未核对参数就收款。需要时设 OPEN_CAMPAIGN=1。
  const openCampaign = process.env.OPEN_CAMPAIGN === "1" || (!mainnet && process.env.OPEN_CAMPAIGN !== "0");
  if (!openCampaign) {
    const feDir = join(__dirname, "..", "..", "frontend", "src", "chain");
    const fePath = join(feDir, "deployments.json");
    let legacyFactories = [];
    if (existsSync(fePath)) {
      const prev = JSON.parse(readFileSync(fePath, "utf8"));
      if (Number(prev.chainId) === Number(net.chainId)) {
        legacyFactories = Array.isArray(prev.legacyFactories) ? prev.legacyFactories.slice() : [];
        if (prev.factory && String(prev.factory).toLowerCase() !== factoryAddr.toLowerCase()) {
          legacyFactories.unshift(prev.factory);
        }
      }
    }
    const out = {
      network: network.name,
      chainId: Number(net.chainId),
      deployedAt: new Date().toISOString(),
      bem,
      bemConfigured: BEM_TOKEN,
      bemIsMock,
      pod,
      minter,
      factory: factoryAddr,
      legacyFactories,
      campaign: "",
      campaignParams: null,
      deployer: deployer.address,
      podIsAdapter,
      officialPod: OFFICIAL_POD,
      notes: podIsAdapter
        ? "BSC 工厂已部署，尚未开期。PoD 为 OfficialPodAdapter，指向官方挖矿代理。execute 前当期须持有电路 NFT，startData 须打包官方证明。"
        : "BSC 主网工厂已部署，尚未开期。BEM 与材料市场为官方合约。PoD 仍是替身；设 USE_OFFICIAL_POD=1 可部署适配器。",
    };
    mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
    writeFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));
    mkdirSync(feDir, { recursive: true });
    writeFileSync(join(feDir, "deployments.json"), JSON.stringify(out, null, 2));
    console.log("\n✓ 工厂已部署，未开期。地址已写入 deployments 与前端配置。");
    try {
      const { verifyPublished } = require("./verify-published");
      await verifyPublished();
    } catch (e) {
      console.warn(`开源验证未完成：${e.message || e}`);
    }
    return;
  }

  const netlist = ethers.keccak256(ethers.toUtf8Bytes("netlist-v1"));
  const sharePrice = ethers.parseEther(process.env.SHARE_PRICE_BNB || "0.01");
  const totalShares = BigInt(process.env.TOTAL_SHARES || 100);
  const feePercent = Number(process.env.FEE_PERCENT || 5);
  const fundingDays = Number(process.env.FUNDING_DAYS || 7);
  const taskId = BigInt(process.env.TASK_ID || 54);

  const tx = await factory.createCampaign(
    sharePrice,
    totalShares,
    feePercent,
    fundingDays,
    [deployer.address],
    [10_000],
    taskId,
    ethers.ZeroAddress, // pod 用工厂默认
    netlist
  );
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  console.log(`Campaign   ：${campaignAddr}`);

  const feDir = join(__dirname, "..", "..", "frontend", "src", "chain");
  const fePath = join(feDir, "deployments.json");
  let legacyFactories = [];
  if (existsSync(fePath)) {
    const prev = JSON.parse(readFileSync(fePath, "utf8"));
    if (Number(prev.chainId) === Number(net.chainId)) {
      legacyFactories = Array.isArray(prev.legacyFactories) ? prev.legacyFactories.slice() : [];
      if (prev.factory && String(prev.factory).toLowerCase() !== factoryAddr.toLowerCase()) {
        legacyFactories.unshift(prev.factory);
      }
      if (prev.bemIsMock && String(prev.bem).toLowerCase() === bem.toLowerCase()) bemIsMock = true;
    }
  }

  const out = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    bem,
    bemConfigured: BEM_TOKEN,
    bemIsMock,
    pod,
    podIsAdapter,
    officialPod: OFFICIAL_POD,
    minter,
    factory: factoryAddr,
    legacyFactories,
    campaign: campaignAddr,
    campaignParams: {
      sharePriceBnb: process.env.SHARE_PRICE_BNB || "0.01",
      totalShares: Number(totalShares),
      feePercent,
      fundingDays,
      taskId: Number(taskId),
      netlistHash: netlist,
    },
    deployer: deployer.address,
    notes: podIsAdapter
      ? "PoD 为 OfficialPodAdapter。execute 前当期须持有电路 NFT；startData 打包官方证明。"
      : mainnet
        ? "BSC 主网。BEM 与材料市场为官方合约。PoD 仍是替身；设 USE_OFFICIAL_POD=1 可部署适配器。"
        : "测试网部署。",
  };

  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  writeFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));

  mkdirSync(feDir, { recursive: true });
  writeFileSync(join(feDir, "deployments.json"), JSON.stringify(out, null, 2));

  console.log(`\n✓ 部署完成，地址已写入 deployments/${network.name}.json 与 frontend/src/chain/deployments.json`);
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
