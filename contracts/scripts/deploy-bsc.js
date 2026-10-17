// 部署到 BSC 测试网：MockPoD/MockMinter（调试替身，除非提供真实地址）→ CampaignFactory → 开一期。
// 地址写回 contracts/deployments/bscTestnet.json 与 frontend/src/chain/deployments.json 供前端对接。
// 运行：npx hardhat run scripts/deploy-bsc.js --network bscTestnet
const { ethers, network } = require("hardhat");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const BEM_TOKEN = process.env.BEM_TOKEN || "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`网络：${network.name} (chainId ${net.chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
  if (!BEM_TOKEN || !ethers.isAddress(BEM_TOKEN)) throw new Error("BEM_TOKEN 地址非法");

  // BEM：若目标链上该地址无合约代码（真实 BEM 只在 BSC 主网，测试网无），自动改布 MockBEM 供调试
  let bem = BEM_TOKEN;
  let bemIsMock = false;
  if ((await ethers.provider.getCode(bem)) === "0x") {
    const mb = await ethers.deployContract("MockBEM");
    await mb.waitForDeployment();
    bem = await mb.getAddress();
    bemIsMock = true;
    await (await ethers.getContractAt("MockBEM", bem)).mint(deployer.address, ethers.parseUnits("1000000", 18));
    console.log(`⚠ 目标链上 BEM ${BEM_TOKEN} 无代码（真实 BEM 在 BSC 主网）。已改布 MockBEM：${bem}（仅供测试网调试）`);
  } else {
    console.log(`BEM       ：${bem}`);
  }

  // 1) PoD / Minter：优先用真实地址，否则部署 Mock 供调试
  let pod = process.env.POD_ADDRESS || "";
  let minter = process.env.MINTER_ADDRESS || "";
  if (!pod) {
    const m = await ethers.deployContract("MockPoD", [bem, 408]);
    await m.waitForDeployment();
    pod = await m.getAddress();
    console.log(`MockPoD    ：${pod}（调试替身，生产换真实 PoD）`);
  }
  if (!minter) {
    const m = await ethers.deployContract("MockMinter", [ethers.parseEther("0.005")]);
    await m.waitForDeployment();
    minter = await m.getAddress();
    console.log(`MockMinter ：${minter}（调试替身，生产换真实 tapeout.net 铸造器）`);
  }

  // 2) 工厂
  const factory = await ethers.deployContract("CampaignFactory", [pod, bem, minter]);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`Factory    ：${factoryAddr}`);

  // 3) 开一期
  const netlist = ethers.keccak256(ethers.toUtf8Bytes("netlist-v1"));
  const sharePrice = ethers.parseEther(process.env.SHARE_PRICE_BNB || "0.01");
  const totalShares = BigInt(process.env.TOTAL_SHARES || 100);
  const feePercent = Number(process.env.FEE_PERCENT || 5);
  const fundingDays = Number(process.env.FUNDING_DAYS || 7);
  const taskId = BigInt(process.env.TASK_ID || 54);
  const executeDelay = Number(process.env.EXECUTE_DELAY || 172800);

  const tx = await factory.createCampaign(
    sharePrice, totalShares, feePercent, fundingDays,
    deployer.address, taskId,
    ethers.ZeroAddress, // pod 用工厂默认
    executeDelay, netlist
  );
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  console.log(`Campaign   ：${campaignAddr}`);

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
    campaign: campaignAddr,
    campaignParams: {
      sharePriceBnb: process.env.SHARE_PRICE_BNB || "0.01",
      totalShares: Number(totalShares),
      feePercent,
      fundingDays,
      taskId: Number(taskId),
      executeDelay,
      netlistHash: netlist,
    },
    deployer: deployer.address,
  };

  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  writeFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));

  // 同步给前端
  const feDir = join(__dirname, "..", "..", "frontend", "src", "chain");
  mkdirSync(feDir, { recursive: true });
  writeFileSync(join(feDir, "deployments.json"), JSON.stringify(out, null, 2));

  console.log(`\n✓ 部署完成，地址已写入 deployments/${network.name}.json 与 frontend/src/chain/deployments.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
