// 部署脚本：先布 MockBEM/PoD/Minter（测试网演示），再布 CampaignFactory 并开一期。
// 生产环境把 PoD/BEM/Minter 换成真实地址。运行：npx hardhat run scripts/deploy.js --network <net>
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("部署者：", deployer.address);

  const bem = await ethers.deployContract("MockBEM");
  await bem.waitForDeployment();
  const pod = await ethers.deployContract("MockPoD", [await bem.getAddress(), 408]);
  await pod.waitForDeployment();
  const minter = await ethers.deployContract("MockMinter", [ethers.parseEther("0.005")]);
  await minter.waitForDeployment();

  const factory = await ethers.deployContract("CampaignFactory", [
    await pod.getAddress(),
    await bem.getAddress(),
    await minter.getAddress(),
  ]);
  await factory.waitForDeployment();

  console.log("MockBEM           :", await bem.getAddress());
  console.log("MockPoD           :", await pod.getAddress());
  console.log("MockMinter        :", await minter.getAddress());
  console.log("CampaignFactory   :", await factory.getAddress());

  const netlist = ethers.keccak256(ethers.toUtf8Bytes("netlist-v1"));
  const tx = await factory.createCampaign(
    ethers.parseEther("0.01"), // 每份 BNB
    100, // 总份数
    5, // 服务费 5%
    7, // 募集 7 天
    deployer.address, // 收费地址
    54, // 官方题目
    ethers.ZeroAddress, // pod 用工厂默认
    48 * 3600, // 观察期 48h
    netlist
  );
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  console.log("第 1 期 Campaign  :", campaignAddr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
