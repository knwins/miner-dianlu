// 本地开发部署：MockMaterialMarket + MockERC1155 → CampaignFactory → 开一期。
// 流片 / PoD / BEM 挖矿已移除，工厂只需 materialMarket（晶体管市场，immutable）与晶体管白名单（构造第 2 参）。
// 工厂不再有默认晶体管：开期时显式传一个白名单内的晶体管合约。
// 本地只有一个 MockERC1155，所以白名单只有它自己。
// 运行：npx hardhat run scripts/deploy.js --network <net>
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("部署者：", deployer.address);

  const minter = await ethers.deployContract("MockMaterialMarket");
  await minter.waitForDeployment();
  const parts = await ethers.deployContract("MockERC1155");
  await parts.waitForDeployment();

  // 工厂构造传 [materialMarket, allowedParts]（2 参，无默认晶体管）；白名单写入后不可增删。
  const factory = await ethers.deployContract("CampaignFactory", [
    await minter.getAddress(),
    [await parts.getAddress()],
  ]);
  await factory.waitForDeployment();

  console.log("MockMaterialMarket :", await minter.getAddress());
  console.log("MockERC1155       :", await parts.getAddress());
  console.log("晶体管白名单         :", Number(await factory.allowedPartsCount()), "项");
  console.log("CampaignFactory    :", await factory.getAddress());

  // 开一期：份额价 / 总份数 / 募集秒数 / 晶体管合约（必选，零地址会 revert）。
  const fundingSeconds = 7n * 86400n;
  const tx = await factory.createCampaign(
    ethers.parseEther("0.01"), // 每份 BNB
    100, // 总份数
    fundingSeconds, // 募集 7 天（合约收秒）
    await parts.getAddress() // 晶体管合约：必选，从白名单里选
  );
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  console.log("第 1 期 Campaign  :", campaignAddr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
