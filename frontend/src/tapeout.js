/**
 * 官方处理器与电路合约地址。
 *
 * ══════════════════════════════════════════════════════════════
 * 这里只有离线常量，不含价格读取，也不含题库。
 * ══════════════════════════════════════════════════════════════
 *
 * 电路市场（官方 0x6feE…B46f）交易的是 **ERC721 电路 NFT**：
 * 每个处理器对应一个电路合约，一期在开期时锁定其中一个，之后从市场买入的
 * 每张电路都属于该集合。合约与前端都按「张」计量，只有单一电路腿。
 *
 * 电路单价以官方电路市场挂单为准（Owner 面板：`readCircuitListingsFor`；
 * 市价条：`officialPrices.js`）。
 */
import deployments from "./chain/deployments.json";

/**
 * 官方处理器 → 电路合约（ERC721）。
 * TapeOut / Behemoth 取自官方电路市场在售的两个集合。
 */
export const OFFICIAL_CIRCUIT_COLLECTIONS = {
  TapeOut: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
  Behemoth: "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c",
};

/**
 * 官方新站首页。电路 NFT 市场在站内「电路市场」页（SPA，无独立深链）。
 * 注意：`/circuit-market` 是老官网路径，不要链过去。
 * Owner 在官网挑单后，回本站用挂单 ID 表单 → 链上预览 → buyCircuits。
 */
export const OFFICIAL_TAPEOUT_HOME = "https://tapeout.net/";

/**
 * 处理器各自的电路合约。
 *
 * ⚠️ 这两个合约都是**真实存在的独立 ERC721 集合**，不是彼此的别名 ——
 * 用它们开期时 Campaign.circuits 会写对应地址，
 * 工厂白名单也必须包含它们，否则 createCampaign 会 revert CircuitsNotAllowed。
 */
export const OFFICIAL_CIRCUIT_MODELS = {
  TAPE_OUT_CIRCUIT: { contract: OFFICIAL_CIRCUIT_COLLECTIONS.TapeOut },
  BEHEMOTH_CIRCUIT: { contract: OFFICIAL_CIRCUIT_COLLECTIONS.Behemoth },
};

/** 电路合约地址（小写）→ 处理器名。 */
const CIRCUIT_TO_PROCESSOR = Object.entries(OFFICIAL_CIRCUIT_COLLECTIONS).reduce(
  (acc, [name, addr]) => {
    acc[String(addr).toLowerCase()] = name;
    return acc;
  },
  {},
);

/**
 * 部署记录里**非官方**的电路合约（测试网 MockCircuitNft）。
 *
 * 工厂白名单在部署时固化：主网 = 官方两个集合 → 这里为空；
 * 测试网 = MockCircuitNft → 这里拿到那个 mock 地址。
 */
const LOCAL_CIRCUITS = (() => {
  const list = Array.isArray(deployments.allowedCircuits) ? deployments.allowedCircuits : [];
  const official = new Set(Object.values(OFFICIAL_CIRCUIT_MODELS).map((p) => p.contract.toLowerCase()));
  return list.find((a) => !official.has(String(a).toLowerCase())) || "";
})();

/** 处理器名 → 该处理器的电路合约地址。 */
export const OFFICIAL_CIRCUIT_FOR_PROCESSOR = Object.entries(OFFICIAL_CIRCUIT_MODELS).reduce(
  (acc, [, p]) => {
    const name = CIRCUIT_TO_PROCESSOR[String(p.contract).toLowerCase()] || "";
    if (name && !acc[name]) acc[name] = p;
    return acc;
  },
  {},
);

/**
 * 处理器 → 电路合约地址。
 *
 * 开期时从工厂白名单里选一个 ERC721 集合。这里必须只在「工厂白名单允许」的前提下返回：
 *   - 官方处理器 → 官方电路合约，但它得在白名单里，否则开期链上会 revert；
 *   - 白名单里的非官方合约（测试网 Mock 替身）→ 直接用它。
 */
export function circuitContractForProcessor(processorId) {
  const allowed = new Set(
    (Array.isArray(deployments.allowedCircuits) ? deployments.allowedCircuits : []).map((a) => String(a).toLowerCase()),
  );
  const official = OFFICIAL_CIRCUIT_FOR_PROCESSOR[processorId]?.contract || "";
  if (official && (!allowed.size || allowed.has(official.toLowerCase()))) return official;
  // 官方地址不在白名单 → 退到白名单里的本地替身（测试网场景）。
  if (LOCAL_CIRCUITS) return LOCAL_CIRCUITS;
  return "";
}

/** 链上 circuits 地址 → 处理器名。地址不在官方表也不在白名单里时返回空。 */
export function processorFromCircuitContract(address) {
  const a = String(address || "").toLowerCase();
  if (!a || a === "0x0000000000000000000000000000000000000000") return "";
  const official = CIRCUIT_TO_PROCESSOR[a];
  if (official) return official;
  // 白名单里的本地替身（测试网 Mock）：没有官方处理器身份，按演示处理器标注。
  if (LOCAL_CIRCUITS && a === LOCAL_CIRCUITS.toLowerCase()) return "TapeOut";
  return "";
}
