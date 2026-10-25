// 测试网开一期新期次（不重新部署基础设施），用来在前端手动走募资流程。
// 开期只需份额价 / 总份数 / 募集秒数 / **晶体管合约（必选）**；晶体管合约从工厂白名单里选。
// 运行：npx hardhat run scripts/testnet-open-round.js --network bscTestnet
const { ethers } = require("hardhat");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

async function main() {
  const depPath = join(__dirname, "..", "deployments", "bscTestnet.json");
  const dep = JSON.parse(readFileSync(depPath, "utf8"));
  const [owner] = await ethers.getSigners();
  const factory = await ethers.getContractAt("CampaignFactory", dep.factory);

  const sharePrice = ethers.parseEther(process.env.SHARE_PRICE_BNB || "0.001");
  const totalShares = BigInt(process.env.TOTAL_SHARES || "2");
  const fundingDays = BigInt(process.env.FUNDING_DAYS || "1");
  // 链上收秒：单位换算在这里做，工厂不再乘 1 days。
  const fundingSeconds = fundingDays * 86400n;

  console.log(`factory ${dep.factory}`);
  /**
   * 本期晶体管合约（createCampaign 第 4 参）：**必选**。
   * 工厂不再有默认晶体管：零地址直接 revert（ZeroAddress），
   * 非零必须落在工厂白名单内，否则 revert PartsNotAllowed。
   */
  const allowedCount = Number(await factory.allowedPartsCount());
  if (allowedCount === 0) throw new Error("工厂晶体管白名单为空，无法指定晶体管合约");
  let campaignParts = (process.env.CAMPAIGN_PARTS_ADDRESS || "").trim();
  if (campaignParts) {
    if (!(await factory.isAllowedParts(campaignParts))) {
      const list = [];
      for (let i = 0; i < allowedCount; i++) list.push(await factory.allowedPartsAt(i));
      throw new Error(`CAMPAIGN_PARTS_ADDRESS ${campaignParts} 不在白名单内。白名单：${list.join(" / ")}`);
    }
  } else if (allowedCount === 1) {
    campaignParts = await factory.allowedPartsAt(0);
  } else {
    throw new Error("白名单有多项，必须用 CAMPAIGN_PARTS_ADDRESS 显式指定本期晶体管合约");
  }
  console.log(`parts ${campaignParts}`);
  console.log(`params price ${ethers.formatEther(sharePrice)} BNB shares ${totalShares} days ${fundingDays} (${fundingSeconds}s)`);

  const tx = await factory.createCampaign(
    sharePrice,
    totalShares,
    fundingSeconds,
    campaignParts
  );
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "CampaignCreated");
  const campaign = log.args.campaign;
  console.log(`campaign #${Number(await factory.campaignCount()) - 1} ${campaign}`);

  // 服务费：第二笔交易，只能在 sold == 0 时调一次，之后永久锁定。
  const feeBps = process.env.SERVICE_FEE_BPS ? BigInt(process.env.SERVICE_FEE_BPS) : 0n;
  let feeShares = [];
  if (feeBps > 0n) {
    const recipients = String(process.env.SERVICE_FEE_RECIPIENTS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const shares = String(process.env.SERVICE_FEE_SHARES_BPS || "")
      .split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
    if (recipients.length === 0 || recipients.length !== shares.length) {
      throw new Error("SERVICE_FEE_BPS requires equal-length SERVICE_FEE_RECIPIENTS and SERVICE_FEE_SHARES_BPS");
    }
    const c = await ethers.getContractAt("Campaign", campaign);
    await (await c.setServiceFee(feeBps, recipients, shares)).wait();
    feeShares = recipients.map((address, i) => ({ address, shareBps: Number(shares[i]) }));
    console.log(`service fee ${feeBps} bps on-chain, ${recipients.length} recipients`);
  }

  const record = {
    ...dep,
    campaign,
    campaignParams: {
      sharePriceBnb: ethers.formatEther(sharePrice),
      totalShares: Number(totalShares),
      fundingDays: Number(fundingDays),
      fundingSeconds: Number(fundingSeconds),
      /** 本期锁定的晶体管合约（= 处理器）；从白名单里选，必填。 */
      campaignParts,
    },
    serviceFeeBps: Number(feeBps),
    serviceFeeSet: feeBps > 0n,
    feeShares,
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(depPath, JSON.stringify(record, null, 2));
  const frontendPath = join(__dirname, "..", "..", "frontend", "src", "chain", "deployments.json");
  const frontend = JSON.parse(readFileSync(frontendPath, "utf8"));
  writeFileSync(frontendPath, JSON.stringify({ ...frontend, campaign, campaignParams: record.campaignParams }, null, 2));
  console.log(`updated ${depPath} and frontend/src/chain/deployments.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
