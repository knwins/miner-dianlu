// 链上对接配置：地址来自 deployments.json（部署后自动写入），网络元数据按 chainId 查表。
import deployments from "./deployments.json";

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export const CHAIN_ID = Number(deployments.chainId) || 97;
export const CHAIN_ID_HEX = "0x" + CHAIN_ID.toString(16);

export const CAMPAIGN_ADDRESS = deployments.campaign || "";
export const FACTORY_ADDRESS = deployments.factory || "";
export const LEGACY_FACTORIES = Array.isArray(deployments.legacyFactories) ? deployments.legacyFactories : [];
export const BEM_ADDRESS = deployments.bem || "";
/** BSC 主网 BEM 代币。测试网该地址没有代码，当前期次用的是 deployments.bem 替身。 */
export const BEM_MAINNET = "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a";
export const POD_ADDRESS = deployments.pod || "";
export const MINTER_ADDRESS = deployments.minter || "";
export const DEPLOYER = deployments.deployer || "";

// 工厂已部署即可对接。campaign 为空表示尚未开期，页面不回退到本地模拟数据。
export const IS_CONFIGURED = isAddr(FACTORY_ADDRESS);

const NETWORKS = {
  97: {
    name: "BSC 测试网",
    // 官方 data-seed 在部分地区会 403；钱包若仍指向它需在连接时重新登记
    rpcUrls: [
      "https://bsc-testnet-rpc.publicnode.com",
      "https://bsc-testnet.drpc.org",
    ],
    explorer: "https://testnet.bscscan.com",
    currency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  },
  56: {
    name: "BSC 主网",
    // 不用 1rpc：免费额度用尽会回 -32001。读链会按顺序自动换节点。
    rpcUrls: [
      "https://bsc-rpc.publicnode.com",
      "https://bsc-dataseed.binance.org",
      "https://bsc-dataseed1.binance.org",
      "https://bsc-dataseed2.binance.org",
      "https://bsc-dataseed1.defibit.io",
    ],
    explorer: "https://bscscan.com",
    currency: { name: "BNB", symbol: "BNB", decimals: 18 },
  },
  31337: {
    name: "本地 Hardhat",
    rpcUrls: ["http://127.0.0.1:8545"],
    explorer: "",
    currency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
};

export const NETWORK = NETWORKS[CHAIN_ID] || NETWORKS[97];
export const RPC_URL = NETWORK.rpcUrls[0];
export const EXPLORER = NETWORK.explorer;

export const SCENE_LABEL = ["募集中", "待执行", "挖矿中"];
export const PHASE_LABEL = ["—", "待挂单", "挂单中", "已到账·待流片"];

export function explorerTx(hash) {
  return EXPLORER ? `${EXPLORER}/tx/${hash}` : "";
}
export function explorerAddress(addr) {
  return EXPLORER ? `${EXPLORER}/address/${addr}` : "";
}
export function explorerCode(addr) {
  const base = explorerAddress(addr);
  return base ? `${base}#code` : "";
}
export function sourcifySource(addr) {
  return addr ? `https://repo.sourcify.dev/contracts/full_match/${CHAIN_ID}/${addr}/` : "";
}
