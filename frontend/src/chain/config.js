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
 * 电路市场地址。合约侧字段名就是 circuitMarket，部署记录随之统一。
 */
export const CIRCUIT_MARKET_ADDRESS = deployments.circuitMarket || "";
/**
 * 官方 PoD Lens（只读辅助合约）：`refsEligible(circuits, circuitId)` 在链上判断
 * 一张电路是否真有挖矿资格（processorMultiplier > 0 且网表没有 REF 引用）。
 * 主网地址固定；测试网没有官方 Lens，留空表示跳过资格过滤。
 */
export const POD_LENS_ADDRESS = deployments.podLens
  || (CHAIN_ID === 56 ? "0xdd20b9537b9f5db9d2a23e6b11ad863cf81930d8" : "");

/**
 * 官方 PoD 挖矿合约。用于判定一张电路的矿工状态（0 无 / 1 挖矿中 / 2 已撤销 / 3 冷却中）。
 *
 * 「已撤销（status = 2）」的电路**不能重新开矿**：官方页面把它标成「不可挖矿」，
 * 但 Lens 的 `refsEligible` 只检查算力倍率与网表引用，对撤销返回的仍是 true。
 * 所以买入前的资格判定必须叠加这一条，否则会把砖头当矿机卖给人。
 */
export const POD_MINING_ADDRESS = deployments.podMining
  || (CHAIN_ID === 56 ? "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46" : "");

/**
 * 官方停挖冷却：`block.number > stopBlock + 1200` 才能再 start。
 * BSC ≈ 3s/块 → 约 1 小时；与官网 / TapeMine 口径一致。
 */
export const POD_MINING_COOLDOWN_BLOCKS = 1200;

/** 官方 BEM ERC20；工厂 immutable 写入，每期用它支付挖矿产出。 */
export const BEM_ADDRESS = deployments.bem
  || (CHAIN_ID === 56 ? "0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a" : "");

/**
 * 主网官方 BEM 的 decimals（链上 `decimals() == 8`）。
 * 勿用 formatEther（按 18 位）：会把待领缩小 10^10，钱包显示 0.000173 而页面像灰尘。
 */
export const BEM_DECIMALS = 8;

/** 无状态 Campaign 部署器；工厂 createCampaign 时调它 new 一期。 */
export const CAMPAIGN_DEPLOYER_ADDRESS = deployments.campaignDeployer || "";

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
    // 第三个节点是专门为 eth_getLogs 加的：publicnode 把历史日志当 archive 请求
    // （要 token，403）、blastapi 的公共 Alchemy 端点限流（429），两者读不到事件；
    // nodereal 公共网关允许 5 万块区间的 getLogs，交易记录的链上事件靠它。
    rpcUrls: [
      "https://bsc-rpc.publicnode.com",
      "https://bsc-mainnet.public.blastapi.io",
      "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
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

/*
 * 状态词表统一在 ../roundState.js —— 这里只做转发，不再自己维护一份。
 * 之前 config.js 有一套、adapter.js 有一份 note、App.jsx 又写一套，
 * 同一个子状态在不同页面显示成四种写法。
 */
export { SCENE_LABEL, PHASE_LABEL } from "../roundState.js";

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
