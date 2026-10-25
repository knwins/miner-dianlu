// 在当前工厂上开一期（不重新部署工厂）。读取 deployments 里的 factory，调用 createCampaign，
// 并把新的 campaign 地址写回 deployments 与前端配置。
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

async function main() {
  const depPath = join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(depPath)) throw new Error(`找不到部署记录 ${depPath}，请先运行 deploy-bsc.js`);
  const dep = JSON.parse(readFileSync(depPath, "utf8"));
  const factoryAddr = dep.factory;
  if (!factoryAddr) throw new Error("部署记录里没有 factory 地址");

  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("CampaignFactory", factoryAddr);
  const owner = await factory.owner();
  console.log(`工厂     ：${factoryAddr}`);
  console.log(`工厂 Owner：${owner}`);
  console.log(`部署者    ：${deployer.address}`);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("当前部署者不是工厂 Owner，无法开期");
  }

  const sharePrice = ethers.parseEther(process.env.SHARE_PRICE_BNB || "0.08");
  const totalShares = BigInt(process.env.TOTAL_SHARES || 2);
  const fundingDays = Number(process.env.FUNDING_DAYS || 1);
  // 链上收秒：单位换算在这里做。
  const fundingSeconds = BigInt(fundingDays) * 86400n;
  console.log(`\n开期参数：份额价 ${ethers.formatEther(sharePrice)} BNB · 总份数 ${totalShares} · 募集 ${fundingDays} 天（${fundingSeconds} 秒）`);

  /**
   * 本期 ERC721 电路合约（= 处理器），createCampaign 第 4 参。**必选**。
   *
   * 工厂没有「默认电路」：零地址一律 revert（ZeroAddress），
   * 非零也必须在工厂白名单内，否则 revert CircuitsNotAllowed。
   * 白名单若只有一项，留空则自动用它；多项则必须显式指定。
   */
  const campaignCircuits = (
    process.env.CAMPAIGN_CIRCUITS_ADDRESS ||
    process.env.CAMPAIGN_PARTS_ADDRESS ||
    ""
  ).trim();
  const allowedCount = Number(await factory.allowedCircuitsCount());
  if (allowedCount === 0) throw new Error("工厂电路白名单为空，无法指定电路合约");
  if (campaignCircuits) {
    const ok = await factory.isAllowedCircuits(campaignCircuits);
    if (!ok) {
      const list = [];
      for (let i = 0; i < allowedCount; i++) list.push(await factory.allowedCircuitsAt(i));
      throw new Error(
        `CAMPAIGN_CIRCUITS_ADDRESS ${campaignCircuits} 不在工厂白名单内。白名单：${list.join(" / ")}`,
      );
    }
  } else if (allowedCount === 1) {
    campaignCircuits = await factory.allowedCircuitsAt(0);
  } else {
    throw new Error("白名单有多项，必须用 CAMPAIGN_CIRCUITS_ADDRESS 显式指定本期电路合约");
  }
  console.log(`电路合约    ：${campaignCircuits}`);

  const before = await factory.campaignCount();
  const tx = await factory.createCampaign(
    sharePrice,
    totalShares,
    fundingSeconds,
    campaignCircuits,
  );
  console.log(`交易已发出：${tx.hash}`);
  await tx.wait();
  const after = await factory.campaignCount();
  const idx = Number(after) - 1;
  const campaignAddr = await factory.campaigns(idx);
  const campaign = await ethers.getContractAt("Campaign", campaignAddr);
  console.log(`\n✓ 已开新期 #${idx}：${campaignAddr}`);
  console.log(`  工厂期次数：${before} → ${after}`);
  console.log(`  已注册    ：${await factory.isRegistered(campaignAddr)}`);
  console.log(`  锁定电路    ：${await campaign.circuits()}`);

  /**
   * 服务费与分成表：**第二笔交易**（setServiceFee）。
   * 只能在 sold == 0（刚建期，一定满足）时调一次，之后永久锁定。
   * 环境变量：
   *   SERVICE_FEE_BPS      费率（基点，1/10000），上限 1000 = 10%。不给 = 不设服务费。
   *   SERVICE_FEE_RECIPIENTS  收款地址，逗号分隔。
   *   SERVICE_FEE_SHARES_BPS   各地址份额（基点），逗号分隔，合计必须 = 10000。
   */
  const feeBps = process.env.SERVICE_FEE_BPS ? BigInt(process.env.SERVICE_FEE_BPS) : 0n;
  let feeShares = [];
  if (feeBps > 0n) {
    const recipients = String(process.env.SERVICE_FEE_RECIPIENTS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const shares = String(process.env.SERVICE_FEE_SHARES_BPS || "")
      .split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
    if (recipients.length === 0 || recipients.length !== shares.length) {
      throw new Error("设了 SERVICE_FEE_BPS 就必须给等长的 SERVICE_FEE_RECIPIENTS 与 SERVICE_FEE_SHARES_BPS");
    }
    // 复用上面已取的 campaign 实例（外层 const campaign），不再重复 getContractAt
    const feeTx = await campaign.setServiceFee(feeBps, recipients, shares);
    await feeTx.wait();
    feeShares = recipients.map((address, i) => ({ address, shareBps: Number(shares[i]) }));
    console.log(`  服务费已上链：${feeBps} bps（${Number(feeBps) / 100}%），${recipients.length} 个收款地址`);
  }

  dep.campaign = campaignAddr;
  dep.campaignIndex = idx;
  dep.campaignParams = {
    sharePriceBnb: ethers.formatEther(sharePrice),
    totalShares: Number(totalShares),
    fundingDays,
    fundingSeconds: Number(fundingSeconds),
    /** 本期锁定的 ERC721 电路合约（= 处理器）；从白名单里显式选，必填。 */
    campaignCircuits,
  };
  dep.serviceFeeBps = Number(feeBps);
  dep.serviceFeeSet = feeBps > 0n;
  dep.feeShares = feeShares;
  dep.notes = "测试网部署并已开期。";
  dep.openedAt = new Date().toISOString();
  writeFileSync(depPath, JSON.stringify(dep, null, 2));

  const fePath = join(__dirname, "..", "..", "frontend", "src", "chain", "deployments.json");
  mkdirSync(join(fePath, ".."), { recursive: true });
  writeFileSync(fePath, JSON.stringify(dep, null, 2));
  console.log(`\n地址已写回：deployments/${network.name}.json 与 frontend/src/chain/deployments.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
