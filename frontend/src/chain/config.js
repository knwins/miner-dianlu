// 链上对接配置：地址来自 deployments.json（部署后自动写入），网络元数据按 chainId 查表。
import deployments from "./deployments.json";

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

// 部署记录缺失时默认按主网处理：主网部署前前端就应该指向主网，
// 回退到测试网（97）会让钱包连错链、在假链上发交易。
export const CHAIN_ID = Number(deployments.chainId) || 56;
export const CHAIN_ID_HEX = "0x" + CHAIN_ID.toString(16);

export const CAMPAIGN_ADDRESS = deployments.campaign || "";
export const FACTORY_ADDRESS = deployments.factory || "";
/**
 * 材料市场地址。合约侧已改名 materialMarket（T-79），部署记录里的字段名随之统一；
 * minter 是旧记录里的字段名，只为读旧记录兜底。
 */
export const MATERIAL_MARKET_ADDRESS = deployments.materialMarket || deployments.minter || "";
/** 工厂元件白名单：开期时前端从链上读，这里是部署记录里的快照（离线兜底）。 */
export const ALLOWED_PARTS = Array.isArray(deployments.allowedParts) ? deployments.allowedParts : [];

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
      "https://bsc-mainnet.public.blastapi.io",
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

export const NETWORK = NETWORKS[CHAIN_ID] || NETWORKS[56];
export const EXPLORER = NETWORK.explorer;

export const SCENE_LABEL = ["募集中", "待执行", "挖矿中"];
export const PHASE_LABEL = ["—", "待挂单", "挂单中", "已到账·待入池"];

export function explorerTx(hash) {
  return EXPLORER ? `${EXPLORER}/tx/${hash}` : "";
}
export function explorerAddress(addr) {
  return EXPLORER ? `${EXPLORER}/address/${addr}` : "";
}
export function sourcifySource(addr) {
  // 新版仓库页：/56/0x…；旧路径 /contracts/full_match/… 已不再提供 metadata.json
  return addr ? `https://repo.sourcify.dev/${CHAIN_ID}/${addr}` : "";
}
