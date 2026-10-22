// 部署记录读写：旧工厂列表（legacyFactories）必须**按网络**累积。
//
// ⚠️ 为什么不能从前端那份 deployments.json 读：
// 前端只有一份 deployments.json，每次部署都会被覆盖。
// 测试网部署会把主网记录冲掉 → 主网的旧工厂列表（legacyFactories）随之丢失，
// 前端就再也看不到主网上那些仍可调用的旧工厂期次。
//
// 所以来源有两个，按链号过滤后合并去重：
//   1. contracts/deployments/<network>.json —— 该网络自己的记录（权威）
//   2. frontend/src/chain/deployments.json  —— 只在 chainId 相同才采信
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const CONTRACTS_DIR = join(__dirname, "..");
const DEPLOY_DIR = join(CONTRACTS_DIR, "deployments");
const FRONTEND_DIR = join(CONTRACTS_DIR, "..", "frontend", "src", "chain");
const FE_DEPLOYMENTS = join(FRONTEND_DIR, "deployments.json");

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 收集该链的旧工厂列表：既有 legacyFactories + 被本次部署取代的旧 factory。
 * 按地址小写去重，保留原有顺序（新的在前）。
 */
function collectLegacyFactories(networkName, chainId, newFactoryAddr) {
  const out = [];
  const seen = new Set();
  const push = (a) => {
    const s = String(a || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    if (newFactoryAddr && k === String(newFactoryAddr).toLowerCase()) return;
    seen.add(k);
    out.push(s);
  };

  for (const file of [join(DEPLOY_DIR, `${networkName}.json`), FE_DEPLOYMENTS]) {
    const rec = readJson(file);
    if (!rec || Number(rec.chainId) !== Number(chainId)) continue;
    if (Array.isArray(rec.legacyFactories)) rec.legacyFactories.forEach(push);
    push(rec.factory);
  }
  return out;
}

/** 写该网络的部署记录 + 前端配置（前端那份始终指向最后一次部署的网络）。 */
function writeDeploymentRecords(networkName, record) {
  mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(join(DEPLOY_DIR, `${networkName}.json`), JSON.stringify(record, null, 2));
  mkdirSync(FRONTEND_DIR, { recursive: true });
  writeFileSync(FE_DEPLOYMENTS, JSON.stringify(record, null, 2));
}

module.exports = { collectLegacyFactories, writeDeploymentRecords, DEPLOY_DIR, FE_DEPLOYMENTS, readJson };
