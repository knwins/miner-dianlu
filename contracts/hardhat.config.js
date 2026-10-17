require("@nomicfoundation/hardhat-toolbox");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

// 极简 .env 解析（避免额外依赖；键=值，忽略注释/空行）
function loadEnv() {
  const p = join(__dirname, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const PK = process.env.DEPLOYER_PRIVATE_KEY || "";
const accounts = PK ? [PK] : [];

/** BEM 众筹挖矿合约 Hardhat 配置 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    hardhat: { chainId: 31337 },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts,
    },
    bsc: {
      url: process.env.BSC_RPC || "https://bsc-rpc.publicnode.com",
      chainId: 56,
      accounts,
    },
  },
};
