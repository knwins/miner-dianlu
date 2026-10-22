/**
 * 官方处理器与元件合约地址。
 *
 * ══════════════════════════════════════════════════════════════
 * 这里只有离线常量，不含价格读取，也不含题库。
 * ══════════════════════════════════════════════════════════════
 *
 * 价格读取（订单簿拉取、BNB 汇率、跨域代理、轮询）已全部删除：
 * 元件单价以链上 Campaign 记录的挂单/成交价为准，
 * 开期测算的基准价见 `prices.js` 的 NOMINAL_QUOTE（静态，不联网）。
 *
 * 题库（题目 g / d / K / C、官方 tasks.json 拉取、本地兜底题表）已全部删除：
 * 链上从来没有题目参数，题目也不再参与任何测算。算力只由元件数量与处理器决定。
 */
import deployments from "./chain/deployments.json";

/**
 * 官方处理器（材料市场 / 元件市场支持的处理器）。
 *
 * TapeOut / Behemoth 取自 tapeout.net 前端 bundle 的 podCpus。
 * T-59：官方 Genesis CPU（创世基线，processorMultiplier = 0、永远不出矿）
 * 已从本项目整体移除，其 CPU / 元件地址一并清除。
 */
export const OFFICIAL_CPUS = {
  TapeOut: "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
  Behemoth: "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c",
};

/**
 * 处理器各自的元件合约（NAND 与 LATCH 共用同一合约，用 tokenId 区分）。
 *
 * ⚠️ 这两个元件合约都是**真实存在的独立合约**，不是彼此的别名 ——
 * 用它们开期时 Campaign.transistors 会写对应地址，
 * 工厂白名单也必须包含它们，否则 createCampaign 会 revert PartsNotAllowed。
 */
export const OFFICIAL_PARTS = {
  TAPE_OUT_NAND: { cpu: OFFICIAL_CPUS.TapeOut, contract: "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", tokenId: 0 },
  TAPE_OUT_LATCH: { cpu: OFFICIAL_CPUS.TapeOut, contract: "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", tokenId: 1 },
  BEHEMOTH_NAND: { cpu: OFFICIAL_CPUS.Behemoth, contract: "0xE2DfD802081C7a05341E20b6582b04b908e8550c", tokenId: 0 },
  BEHEMOTH_LATCH: { cpu: OFFICIAL_CPUS.Behemoth, contract: "0xE2DfD802081C7a05341E20b6582b04b908e8550c", tokenId: 1 },
};

/** CPU 地址（小写）→ 处理器名。由 OFFICIAL_CPUS 自动生成，避免手写反查表漏项。 */
const CPU_TO_PROCESSOR = Object.entries(OFFICIAL_CPUS).reduce(
  (acc, [name, addr]) => {
    acc[String(addr).toLowerCase()] = name;
    return acc;
  },
  {},
);

/** 元件合约地址（小写）→ 处理器名。同一元件合约内所有 tokenId 共用一个处理器。 */
const PARTS_CONTRACT_TO_PROCESSOR = Object.values(OFFICIAL_PARTS).reduce(
  (acc, p) => {
    acc[p.contract.toLowerCase()] = CPU_TO_PROCESSOR[String(p.cpu).toLowerCase()] || "";
    return acc;
  },
  {},
);

/**
 * 部署记录里**非官方**的元件合约（测试网替身）。
 *
 * T-79 起工厂不再有「默认元件」：白名单 allowedParts 里可以有多个地址，
 * 每期开期时由前端显式选一个。主网白名单 = 官方两件套 → 这里为空；
 * 测试网白名单 = MockERC1155 → 这里拿到那个 mock 地址。
 */
const LOCAL_PARTS = (() => {
  const list = Array.isArray(deployments.allowedParts) ? deployments.allowedParts : [];
  const official = new Set(Object.values(OFFICIAL_PARTS).map((p) => p.contract.toLowerCase()));
  return list.find((a) => !official.has(String(a).toLowerCase())) || "";
})();

/**
 * 处理器名 → 该处理器的元件 ERC1155 地址。
 * 由 OFFICIAL_PARTS 自动生成（NAND 与 LATCH 共用同一合约地址，取任一即可）。
 * 之所以要这张表：`partsContractForProcessor` 只认处理器名，得能一键查到地址。
 *
 * ⚠️ 声明顺序：必须在 `CPU_TO_PROCESSOR` **之后** —— 否则
 * `Cannot access 'CPU_TO_PROCESSOR' before initialization`，
 * 整个页面白屏（vite build 抓不到，只有运行时才暴露）。
 */
export const OFFICIAL_PARTS_FOR_PROCESSOR = Object.entries(OFFICIAL_PARTS).reduce(
  (acc, [id, p]) => {
    const name = CPU_TO_PROCESSOR[String(p.cpu).toLowerCase()] || "";
    if (name && !acc[name]) acc[name] = p;
    return acc;
  },
  {},
);

/**
 * 元件构成里 LATCH 的默认占比。
 * NAND / LATCH 是同一 ERC1155 的两个 tokenId，拆分只用于展示与成本估算：
 *   comb 组合逻辑：纯逻辑，少量状态 → 20%
 *   seq  时序逻辑：需要锁存状态 → 50%
 */
export const LATCH_RATIO = { comb: 0.2, seq: 0.5 };

/**
 * 处理器 → 元件 ERC1155 地址（挂单 placeBid 用同一个）。
 *
 * T-79 起工厂不再有「默认元件」：元件是**白名单**，每期开期时选其中一个锁定。
 * 所以这里必须只在「工厂白名单允许」的前提下返回地址：
 *   - 官方处理器 → 官方元件合约，但它得在白名单里，否则开期链上会 revert；
 *   - 白名单里的非官方合约（测试网 Mock 替身）→ 直接用它。
 *
 * ⚠️ 绝不返回「不在白名单里的官方地址」：那会让期次指向一个工厂不认的元件合约。
 */
export function partsContractForProcessor(processorId) {
  const allowed = new Set(
    (Array.isArray(deployments.allowedParts) ? deployments.allowedParts : []).map((a) => String(a).toLowerCase()),
  );
  const official = OFFICIAL_PARTS_FOR_PROCESSOR[processorId]?.contract || "";
  if (official && (!allowed.size || allowed.has(official.toLowerCase()))) return official;
  // 官方地址不在白名单 → 退到白名单里的本地替身（测试网场景）。
  if (LOCAL_PARTS) return LOCAL_PARTS;
  return "";
}

/** 链上 transistors 地址 → 处理器名。地址不在官方表也不在白名单里时返回空。 */
export function processorFromPartsContract(address) {
  const a = String(address || "").toLowerCase();
  if (!a || a === "0x0000000000000000000000000000000000000000") return "";
  const official = PARTS_CONTRACT_TO_PROCESSOR[a];
  if (official) return official;
  // 白名单里的本地替身（测试网 Mock）：没有官方处理器身份，按演示处理器标注。
  if (LOCAL_PARTS && a === LOCAL_PARTS.toLowerCase()) return "TapeOut";
  return "";
}
