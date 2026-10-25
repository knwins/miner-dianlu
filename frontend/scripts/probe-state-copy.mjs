/**
 * 探针：流程状态 / 子状态**词表唯一性**。
 *
 * 背景：状态词原来散在 8 个地方各写一套，同一个子状态最多四种写法
 * （补不补买入动作、加不加「· 待入池」后缀、中间要不要空格，各写各的；
 * 旧文案里还混用过「元件」这个同义词），
 * 同一屏上下两处描述同一件事、措辞还不一样。改一次要翻 8 个文件，漏一个就自相矛盾。
 *
 * 这个探针做两件事：
 *   1. 静态：App / Owner / MarketTrades 里不许再出现状态词字面量（只能从 roundState.js 取）；
 *   2. 行为：把 12 种状态跑一遍，断言「阶段 / 认购徽标 / 子状态」三段文字互不相同，
 *      即同一格里不会把同一个词印两遍。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const read = (name) => fs.readFileSync(path.join(SRC, name), "utf8");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

/** 去掉整行注释，只扫真正会被渲染的代码（注释里为了解释问题会故意引用旧写法）。 */
function codeOnly(text) {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("{/*"));
    })
    .join("\n");
}

const app = codeOnly(read("App.jsx"));
const owner = codeOnly(read("Owner.jsx"));
const trades = codeOnly(read("MarketTrades.jsx"));
const adapter = codeOnly(read("chain/adapter.js"));

// ── 1. 字面量：只能出现在 roundState.js / dealStatus.js ─────────────────────
const FORBIDDEN = [
  "待挂单买",
  "挂单中 · 待成交",
  "已挂单 · 待成交",
  "元件到账 · 待入池",
  "元件已到账",
  "已到账 · 待入池",
  "已到账·待入池",
  "已失败原路退款",
];
for (const [file, text] of [["App.jsx", app], ["Owner.jsx", owner], ["MarketTrades.jsx", trades], ["chain/adapter.js", adapter]]) {
  const hits = FORBIDDEN.filter((word) => text.includes(word));
  check(`${file}：不再写重复 / 变体的状态文案`, hits.length === 0, hits.join("、"));
}

/** 阶段词与子状态词本身也不许在页面里硬编码（必须来自 roundState.js）。 */
const STATE_WORDS = ["募集中", "待执行", "挖矿中", "已结束", "执行失败", "待挂单", "挂单中", "已到账", "认购中", "已售罄", "认筹中"];
for (const [file, text] of [["App.jsx", app], ["Owner.jsx", owner]]) {
  const hits = STATE_WORDS.filter((word) => text.includes(`"${word}"`) || text.includes(`>${word}<`));
  check(`${file}：阶段 / 子状态词不写死（改从 roundState.js 取）`, hits.length === 0, hits.join("、"));
}

// ── 2. 结构：只剩一条进度条、一个标题来源 ────────────────────────────────────
check(
  "RoundTitle：期号后不再跟阶段词（避免「第 2 期 · 待执行」+ 徽标「待执行」）",
  !/round-period[^<]*\{[^}]*phase/.test(app) && !/· \$\{phase\}/.test(app),
);
check(
  "App.jsx：旧的三步 Pipeline 已删除（与生命周期条重复）",
  !/function Pipeline\(/.test(app) && !/<Pipeline/.test(app),
);
check(
  "MarketTrades.jsx：不再输出独立的 stage 行（子状态归生命周期条）",
  !/trade-panel-stage/.test(trades) && !/const stage =/.test(trades),
);
check(
  "lifecycle：子状态只挂在当前步（一处），不逐格挂",
  /i === idx && hint/.test(app),
);

// ── 3. 行为：12 种状态，三段文字互不重复 ─────────────────────────────────────
const { roundState, rowState, PHASE, ENDED, FAILED, SCENE } = await import("../src/roundState.js");
const { dealStatus } = await import("../src/dealStatus.js");

const now = Date.now();
const base = {
  totalShares: 100,
  sharePriceBnb: 1,
  raisedBnb: 100,
  sold: 100,
  outstandingShares: 100,
};

const cases = [
  ["募集中 · 认购中", { ...base, scene: "funding", sold: 22, raisedBnb: 22, endsAt: now + 86400e3 }],
  ["募集中 · 已截止未售罄", { ...base, scene: "funding", sold: 22, raisedBnb: 22, endsAt: now - 1000 }],
  ["待执行 · 待挂单", { ...base, scene: "executing", executePhase: "buying" }],
  ["待执行 · 挂单中", { ...base, scene: "executing", executePhase: "listed" }],
  ["待执行 · 已到账", { ...base, scene: "executing", executePhase: "ready" }],
  ["待执行 · 池子不足", { ...base, scene: "executing", executePhase: "buying", raisedBnb: 60 }],
  ["执行失败 · 可退款", { ...base, scene: "executing", executePhase: "buying", executionFailed: true }],
  ["已结束 · 退款完成", { ...base, scene: "executing", executionFailed: true, outstandingShares: 0 }],
  ["挖矿中", { ...base, scene: "mining", executionFailed: false }],
];

for (const [name, row] of cases) {
  const state = rowState(row, now / 1000, dealStatus);
  const deal = state.deal?.label || "";
  // 同一格里三段文字不能有重复词
  const words = [state.label, deal, state.substate].filter(Boolean);
  check(
    `${name}：阶段/徽标/子状态互不复述`,
    new Set(words).size === words.length,
    words.join(" | "),
  );
}

// 终态与失败态的标签必须来自词表，且不再出现「已流标 + 已结束」两个徽标
const ended = rowState(cases[1][1], now / 1000, dealStatus);
check("流标：阶段=已结束，认购徽标为空（原因写在子状态）", ended.label === ENDED.label && !ended.deal.label, `${ended.label} / ${ended.deal.label}`);
check("流标：原因只有一处「已流标 · 认筹款可原路退回」", ended.substate === "已流标 · 认筹款可原路退回", ended.substate);

const settled = rowState(cases[7][1], now / 1000, dealStatus);
check("退款完成：阶段=已结束，徽标为空", settled.label === ENDED.label && !settled.deal.label);

const mining = rowState(cases[8][1], now / 1000, dealStatus);
check("挖矿中：不再重复「已售罄」徽标（入池必然售罄）", mining.label === SCENE.mining.label && !mining.deal.label);

const ready = rowState(cases[4][1], now / 1000, dealStatus);
check("已到账：表格用全称、卡片用下一步（两种口径都来自同一张表）", ready.substate === PHASE.ready.full && ready.substateCompact === "待入池", `${ready.substate} / ${ready.substateCompact}`);

const failed = rowState(cases[6][1], now / 1000, dealStatus);
check("执行失败：阶段词是「执行失败」而不是「待执行」", failed.label === FAILED.label, failed.label);

// ── 4. 术语：产品统一叫「晶体管」，市场统一叫「晶体管市场」 ──────────────────
// 注释里可能引用被删掉的旧写法当反例，但真正渲染的代码必须干净，
// 所以扫之前统一过一遍 codeOnly()。
const files = fs.readdirSync(SRC, { withFileTypes: true });
const termFiles = files
  .filter((d) => d.isFile() && /\.jsx?$/.test(d.name))
  .map((d) => d.name)
  .concat(["chain/adapter.js", "chain/client.js", "chain/config.js", "chain/useChain.js"])
  .filter((name) => fs.existsSync(path.join(SRC, name)));

const legacyPart = termFiles.filter((name) => codeOnly(read(name)).includes("元件"));
check("全站统一叫「晶体管」（不再出现「元件」）", legacyPart.length === 0, legacyPart.join("、"));

const legacyMarket = termFiles.filter((name) => /材料市场|元件市场/.test(codeOnly(read(name))));
check("市场统一叫「晶体管市场」（不再出现「材料市场」/「元件市场」）", legacyMarket.length === 0, legacyMarket.join("、"));

const ok = results.every((r) => r.ok);
console.log(`\n${ok ? "全部通过" : "存在失败项"}（${results.filter((r) => r.ok).length}/${results.length}）`);
process.exit(ok ? 0 : 1);
