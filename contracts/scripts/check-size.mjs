// 部署前体积闸门：任何合约（以及内嵌创建码的 CampaignFactory）超过 EIP-170 上限就失败退出。
// 用法：npm run size  （先 npm run compile）
import { readFileSync, existsSync } from "node:fs";

const LIMIT = 24_576;
// 预警线：低于上限这么多字节就提示，避免下一次改动把工厂顶爆。
const WARN_MARGIN = 300;

const artifacts = [
  ["CampaignFactory", "artifacts/contracts/CampaignFactory.sol/CampaignFactory.json"],
  ["Campaign", "artifacts/contracts/Campaign.sol/Campaign.json"],
  ["CampaignDeployer", "artifacts/contracts/CampaignDeployer.sol/CampaignDeployer.json"],
];

let failed = false;
for (const [name, path] of artifacts) {
  if (!existsSync(path)) {
    console.error(`缺少 ${path}，先运行 npm run compile`);
    failed = true;
    continue;
  }
  const art = JSON.parse(readFileSync(path, "utf8"));
  const deployed = (art.deployedBytecode.length - 2) / 2;
  const creation = (art.bytecode.length - 2) / 2;
  const margin = LIMIT - deployed;
  const ok = margin >= 0;
  if (!ok) failed = true;
  const line = `${name.padEnd(18)} deployed ${deployed} / ${LIMIT}  creation ${creation}  margin ${margin}`;
  if (!ok) console.error(`FAIL ${line}`);
  else if (margin < WARN_MARGIN) console.warn(`WARN ${line}`);
  else console.log(`ok   ${line}`);
}

if (failed) {
  console.error("超过 24576 字节：Campaign 的创建码直接算进 CampaignFactory，先精简再部署。");
}

process.exit(failed ? 1 : 0);
