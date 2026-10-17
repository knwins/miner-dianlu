// 链上对接配置：地址来自 deployments.json（部署后自动写入），网络元数据按 chainId 查表。
import deployments from "./deployments.json";

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export const CHAIN_ID = Number(deployments.chainId) || 97;
export const CHAIN_ID_HEX = "0x" + CHAIN_ID.toString(16);

export const CAMPAIGN_ADDRESS = deployments.campaign || "";
export const FACTORY_ADDRESS = deployments.factory || "";
export const BEM_ADDRESS = deployments.bem || "";
export const POD_ADDRESS = deployments.pod || "";
export const MINTER_ADDRESS = deployments.minter || "";
export const DEPLOYER = deployments.deployer || "";

// 是否已配置可对接的 Campaign（未部署时为 false，前端回退到本地模拟）
export const IS_CONFIGURED = isAddr(CAMPAIGN_ADDRESS);

const NETWORKS = {
  97: {
    name: "BSC 测试网",
    rpcUrls: ["https://bsc-testnet-rpc.publicnode.com"],
    explorer: "https://testnet.bscscan.com",
    currency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  },
  56: {
    name: "BSC 主网",
    rpcUrls: ["https://bsc-rpc.publicnode.com"],
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
