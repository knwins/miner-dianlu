// 已开过。再跑只会核对链上第 4 期参数，不会再发交易。
const { ethers } = require("hardhat");

const FACTORY = "0x638744e7308D8dCe3444d6991137f7405f5Ab2ED";
const CAMPAIGN = "0xB3352B3a725513fBfbDD3Faace28742C148F41F4";

async function main() {
  const factory = await ethers.getContractAt("CampaignFactory", FACTORY);
  const count = await factory.campaignCount();
  const last = await factory.campaigns(count - 1n);
  if (last.toLowerCase() !== CAMPAIGN.toLowerCase()) {
    throw new Error(`最新一期是 ${last}，与已发布的 ${CAMPAIGN} 不一致，脚本已停止`);
  }
  const c = await ethers.getContractAt("Campaign", CAMPAIGN);
  const [price, shares, feeBps, taskId, bps0] = await Promise.all([
    c.sharePriceBnb(),
    c.totalShares(),
    c.feeBps(),
    c.taskId(),
    c.feeShareAt(0),
  ]);
  console.log(`campaign ${CAMPAIGN}`);
  console.log(`price ${ethers.formatEther(price)} BNB  shares ${shares}  feeBps ${feeBps}  task ${taskId}`);
  console.log(`feeShare ${bps0[0]}:${bps0[1]}`);
}

main().catch((error) => {
  console.error(error.shortMessage || error.message || error);
  process.exit(1);
});
