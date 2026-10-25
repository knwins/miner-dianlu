// 本地开发部署：MockCircuitMarket + MockCircuitNft → CampaignFactory → 开一期。
// 电路市场只有卖单侧；本地用 MockCircuitMarket 模拟 list/buy/delist/owed/withdraw。
// 工厂构造 2 参：(circuitMarket, allowedCircuits[])；开期时显式传一个白名单内的 ERC721 电路合约。
// 运行：npx hardhat run scripts/deploy.js --network <net>
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("部署者：", deployer.address);

  // 市场费 2.5%（与官方 sell-side 市场一致的费用模型：从卖方所得里扣）。
  const market = await ethers.deployContract("MockCircuitMarket", [250]);
  await market.waitForDeployment();
  const circuits = await ethers.deployContract("MockCircuitNft");
  await circuits.waitForDeployment();

  const marketAddr = await market.getAddress();
  const circuitsAddr = await circuits.getAddress();

  // 工厂构造传 [circuitMarket, allowedCircuits]（2 参，无默认电路合约）；白名单写入后不可增删。
  const factory = await ethers.deployContract("CampaignFactory", [marketAddr, [circuitsAddr]]);
  await factory.waitForDeployment();

  console.log("MockCircuitMarket :", marketAddr);
  console.log("MockCircuitNft    :", circuitsAddr);
  console.log("电路白名单         :", Number(await factory.allowedCircuitsCount()), "项");
  console.log("CampaignFactory   :", await factory.getAddress());

  // 开一期：份额价 / 总份数 / 募集秒数 / 电路合约（必选，零地址会 revert）。
  const fundingSeconds = 7n * 86400n;
  const tx = await factory.createCampaign(
    ethers.parseEther("0.01"), // 每份 BNB
    100, // 总份数
    fundingSeconds, // 募集 7 天（合约收秒）
    circuitsAddr, // 电路合约：必选，从白名单里选
  );
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  const campaign = await ethers.getContractAt("Campaign", campaignAddr);
  console.log("第 1 期 Campaign  :", campaignAddr);
  console.log("锁定电路合约      :", await campaign.circuits());

  // 给部署者（Owner）mint 几张电路，并挂到 Mock 市场上，方便本地走「买入」流程。
  for (let tokenId = 1; tokenId <= 5; tokenId++) {
    await (await circuits.mint(deployer.address, tokenId)).wait();
    await (await circuits.approve(marketAddr, tokenId)).wait();
    await (await market.list(circuitsAddr, tokenId, ethers.parseEther("0.002"))).wait();
  }
  console.log("Mock 市场已挂 5 张电路（单价 0.002 BNB），tokenId 1..5");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
