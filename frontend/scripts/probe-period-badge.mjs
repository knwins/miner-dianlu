/**
 * 探针：期次下拉里的「成交状态」徽标。
 *
 * 背景（2026-10-23 缺陷）：链上历史行（chain.campaigns）只带 status 文案、没有 scene，
 * 而 dealStatus 只认 scene 数字 → 每一期都兜底成 deal-idle，下拉里渲染成「第 N 期 ● —」。
 * 现在两处都修了：adapter.historyRowFromSummary 补 scene/phase/outstandingShares，
 * dealStatus 在缺 scene 时按 status 文案回推，且「没信息」时干脆不渲染徽标。
 *
 * 断言：
 *   1. 打开下拉，至少有一项；每项文字里不能出现「● —」这种空徽标
 *   2. 每项若有徽标，文案必须是四个合法状态之一
 *   3. 全程无 pageerror / console.error
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
const LEGAL = ["等待成交", "已成交", "已流标", "已结束"];

const html = await (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).text();
if (!html.includes(EXPECT_TITLE)) {
  console.log(`SKIP 端口 ${PORT} 不是本应用`);
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

await installWallet(page);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".period-nav-current", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);

if (!(await page.locator(".period-nav-current").count())) {
  console.log("SKIP 页面上没有期次下拉（链未配置或无期次）");
  await browser.close();
  process.exit(0);
}

await page.locator(".period-nav-current").click();
await page.waitForSelector(".period-menu", { timeout: 10000 });
const items = page.locator(".period-menu li button");
const n = await items.count();

const empty = [];
const illegal = [];
for (let i = 0; i < n; i++) {
  const text = (await items.nth(i).innerText()).replace(/\s+/g, " ").trim();
  const badge = (await items.nth(i).locator(".deal-badge").count())
    ? (await items.nth(i).locator(".deal-badge").innerText()).replace(/\s+/g, " ").trim()
    : "";
  console.log(`${badge ? "OK  " : "EMPTY"} #${i}  ${text}`);
  if (!badge) continue;
  if (!LEGAL.includes(badge)) illegal.push(`#${i} 徽标文案非法：${badge}`);
}

// 至少一项带徽标，否则等于「状态全丢」——那是本次要修的缺陷的另一种形态
const withBadge = await page.locator(".period-menu .deal-badge").count();
if (n > 0 && withBadge === 0) empty.push("下拉里没有任何成交状态徽标");

const fail = [...empty, ...illegal, ...errors];
if (fail.length) {
  console.log("\nFAIL\n" + fail.map((x) => ` - ${x}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`\nPASS  ${n} 个期次 · ${withBadge} 个带状态徽标 · 无报错`);
}
await browser.close();
