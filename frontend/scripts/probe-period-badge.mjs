/**
 * 探针：期次下拉与期次标题的「认筹状态」徽标。
 *
 * 规则（2026-10-23 用户两次纠偏后定稿）：
 *   1. **下拉里不画状态徽标**，每项只有「第 N 期」。徽标挤在期号旁，且
 *      「成交」在晶体管市场另有含义，摆在期次旁会被读成「本期晶体管已买到」。
 *   2. 期次标题上的徽标文案必须是四态之一：认购中 / 已售罄 / 已流标 / 已结束。
 *      这一层不许出现「成交」二字 —— 认购阶段没有成交动作。
 *   3. 全程无 pageerror / console.error。
 *
 * 历史缺陷（保留说明，避免回退）：
 *   - chain.campaigns 的历史行只带 status 文案、没有 scene，dealStatus 只认 scene，
 *     于是下拉每期渲染成「第 N 期 ● —」（空徽标）。
 *   - 售罄曾被标成「已成交」，与同页「晶体管数 · 待成交」直接打架。
 *
 * 运行：node scripts/probe-period-badge.mjs [port]（默认 5180）
 */
import { createRequire } from "node:module";
import { installWallet } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const PORT = process.argv[2] || process.env.PORT || "5180";
const BASE = `http://127.0.0.1:${PORT}/`;
const EXPECT_TITLE = "TapeOut 众筹挖矿";
/** 认筹四态。不含任何「成交」字样。 */
const LEGAL = ["认购中", "已售罄", "已流标", "已结束"];

const html = await (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).text();
if (!html.includes(EXPECT_TITLE)) {
  console.log(`SKIP 端口 ${PORT} 不是本应用`);
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
/**
 * 外部失败主机：浏览器对失败子资源统一报「Failed to load resource…」且不带 URL，
 * 只能靠 response 事件把 4xx 的**外部**主机记下来。本机网络下公共 RPC
 * （bsc-rpc.publicnode.com）会 403，那是环境噪声、不是应用错误；
 * 只有确实观察到外部 4xx 时，才放过这类通用资源错误。
 * pageerror 与其它 console.error 一律照旧严格断言。
 */
const externalFailures = new Set();
const origin = new URL(BASE).origin;
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().startsWith(origin)) externalFailures.add(r.url());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (text.includes("Failed to load resource") && externalFailures.size > 0) return;
  errors.push(`console: ${text}`);
});

await installWallet(page);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".period-nav-current", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);

if (!(await page.locator(".period-nav-current").count())) {
  console.log("SKIP 页面上没有期次下拉（链未配置或无期次）");
  await browser.close();
  process.exit(0);
}

const fail = [];

// --- 1. 期次标题上的徽标（打开下拉前先读，位置固定） ---
const heroBadges = page.locator(".round-hero .deal-badge");
const heroCount = await heroBadges.count();
if (heroCount > 1) fail.push(`期次标题上有 ${heroCount} 个状态徽标，只该有 1 个`);
for (let i = 0; i < heroCount; i++) {
  const label = (await heroBadges.nth(i).innerText()).replace(/\s+/g, " ").trim();
  if (!LEGAL.includes(label)) fail.push(`标题徽标文案非法：${label}`);
  console.log(`OK   标题徽标 = ${label}`);
}

// --- 2. 下拉里不允许有徽标 ---
await page.locator(".period-nav-current").click();
await page.waitForSelector(".period-menu", { timeout: 10000 });
const items = page.locator(".period-menu li button");
const n = await items.count();
for (let i = 0; i < n; i++) {
  const text = (await items.nth(i).innerText()).replace(/\s+/g, " ").trim();
  const badge = await items.nth(i).locator(".deal-badge").count();
  console.log(`${badge ? "BAD " : "OK  "} 下拉 #${i}  ${text}`);
  if (badge) fail.push(`下拉 #${i} 仍渲染状态徽标：${text}`);
  if (!/^第 \d+ 期$/.test(text)) fail.push(`下拉 #${i} 文案不是纯「第 N 期」：${text}`);
}

if (n === 0) fail.push("下拉里一个期次都没有");
fail.push(...errors);

if (fail.length) {
  console.log("\nFAIL\n" + fail.map((x) => ` - ${x}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`\nPASS  ${n} 个期次 · 下拉无徽标 · 标题徽标合法 · 无报错`);
}
await browser.close();
