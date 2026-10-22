// 部署后开源验证：把刚部署的 CampaignFactory / Campaign 提交到 Sourcify / BscScan。
//
// 之前 deploy-bsc.js 里 require("./verify-published").main() 指向一个**不存在的文件**，
// 整个 require 抛错被 try/catch 吞掉，只留下一行「开源验证未完成」的 warn——
// 主网上线后合约其实没验证过源码，没人看得出来。
//
// 现在这个脚本真实存在且会检查产物。运行：
//   npx hardhat run scripts/verify-published.js --network bsc
//
// 依赖 hardhat-toolbox 自带的 hardhat-verify（task 名 verify / verify:sourcify / verify:etherscan）。
const hre = require("hardhat");
const { ethers, network } = hre;
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const OFFICIAL_MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";
const OFFICIAL_PARTS = [
  "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", // TapeOut
  "0xE2DfD802081C7a05341E20b6582b04b908e8550c", // Behemoth
];

/** 读部署记录（部署脚本已写好）。 */
function readDeployment() {
  const file = join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * 构造参数：验证时必须与部署时完全一致，否则 Sourcify 匹配不上。
 * 工厂是 (materialMarket, allowedParts[])；Campaign 由工厂内部 CREATE 创建，
 * 其 6 个构造参数需要从工厂事件 + 链上 Campaign 状态还原：
 *   (sharePriceBnb, totalShares, fundingDeadline, materialMarket, owner, transistors)
 * 前三个来自 CampaignCreated 事件；materialMarket / transistors 直接读链上 Campaign
 * （它们是创建时写入的 immutable，开期人无法事后改），owner 是当时的 Factory Owner（= 部署者）。
 */
async function campaignConstructorArgs(campaignAddr, dep) {
  try {
    const abi = require("../artifacts/contracts/CampaignFactory.sol/CampaignFactory.json").abi;
    const iface = new ethers.Interface(abi);
    const logs = await ethers.provider.getLogs({
      address: dep.factory,
      fromBlock: 0,
      toBlock: "latest",
      topics: [iface.getEvent("CampaignCreated").topicHash],
    });
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (String(parsed.args.campaign).toLowerCase() !== String(campaignAddr).toLowerCase()) continue;
      const c = await ethers.getContractAt("Campaign", campaignAddr);
      const materialMarket = await c.market();
      const transistors = await c.transistors();
      return [
        parsed.args.sharePriceBnb,
        parsed.args.totalShares,
        parsed.args.fundingDeadline,
        materialMarket,
        dep.deployer,
        transistors,
      ];
    }
  } catch {
    // 事件读不到就返回空数组，让验证任务自己去报「参数不匹配」。
  }
  return [];
}

async function main() {
  const dep = readDeployment();
  if (!dep) {
    console.log(`找不到 deployments/${network.name}.json，跳过开源验证。`);
    return;
  }
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (Number(dep.chainId) !== chainId) {
    throw new Error(
      `部署记录的网络(${dep.chainId})与当前链(${chainId})不一致，拒绝验证——否则验证的是别的链上的地址。`
    );
  }

  // 主网额外核对：材料市场必须是官方地址；元件白名单必须是官方两件套。
  if (chainId === 56) {
    const market = String(dep.materialMarket || "").toLowerCase();
    if (market !== OFFICIAL_MARKET.toLowerCase()) {
      throw new Error(`主网材料市场应为 ${OFFICIAL_MARKET}，部署记录是 ${dep.materialMarket}`);
    }
    const wl = Array.isArray(dep.allowedParts) ? dep.allowedParts.map((a) => a.toLowerCase()) : [];
    for (const o of OFFICIAL_PARTS) {
      if (!wl.includes(o.toLowerCase())) {
        throw new Error(`主网元件白名单必须包含官方元件 ${o}（否则它的期次开不了）`);
      }
    }
  }

  const targets = [];
  if (dep.factory) {
    // 工厂构造是 2 参：(materialMarket, allowedParts[]) —— 两者缺一不可，否则验证对不上。
    targets.push({
      address: dep.factory,
      name: "CampaignFactory",
      args: [dep.materialMarket, dep.allowedParts],
    });
  }
  if (dep.campaign) {
    targets.push({
      address: dep.campaign,
      name: "Campaign",
      args: await campaignConstructorArgs(dep.campaign, dep),
    });
  }

  let ok = 0;
  for (const t of targets) {
    const code = await ethers.provider.getCode(t.address);
    if (code === "0x") {
      console.log(`✗ ${t.name} ${t.address} 在链上没有代码，跳过。`);
      continue;
    }
    // 优先用 verify（自动挑 etherscan / sourcify）；失败再退回 verify:sourcify。
    let done = false;
    for (const task of ["verify", "verify:sourcify"]) {
      try {
        await hre.run(task, { address: t.address, constructorArguments: t.args });
        console.log(`✓ ${t.name} ${t.address} 已通过 ${task} 验证。`);
        ok += 1;
        done = true;
        break;
      } catch (e) {
        const msg = (e?.message || String(e)).split("\n")[0];
        if (task === "verify") {
          // verify 会先派发到 etherscan，可能因为没配 API key 失败；这不算致命，继续试 sourcify。
          console.log(`  ${t.name}：${task} 未通过（${msg}），改试 verify:sourcify`);
          continue;
        }
        console.log(`✗ ${t.name} ${t.address} 验证未完成：${msg}`);
      }
    }
    if (!done && ok === 0) {
      // 全部失败时不算致命错误（可能是网络限流），但一定要说清楚。
      console.log(`  ⚠ ${t.name} ${t.address} 未验证成功，请手动跑 npx hardhat verify --network ${network.name} --address ${t.address}`);
    }
  }
  if (ok === 0 && targets.length > 0) {
    console.log("\n没有任何合约验证成功——源码在主网上仍是未验证状态。");
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
