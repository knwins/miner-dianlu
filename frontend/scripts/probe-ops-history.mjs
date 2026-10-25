/**
 * 探针：合约操作弹窗的三条规则
 *   1. 历史交易记录**只来自晶体管市场合约事件**（挂单 / 成交 / 撤回），
 *      不得再出现「这版市场合约没有事件，记录按订单状态推算」。
 *   2. 挂买单数量默认各 1 颗；市价列头写来源（官方市价 / 链上市场单价），
 *      单元格只留数字，不再挂「官方市价 · 点填」小字。
 *   3. 本期已有活单时表单会换成「当前买单」，此时跳过表单字段断言（不是页面坏了）。
 *
 * 运行：node scripts/probe-ops-history.mjs [port]（默认 5180）
 */
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT ||
    "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright",
);
const port = process.argv[2] || "5180";
const SHOT_DIR = mkdtempSync(join(tmpdir(), "tapeout-ops-"));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
// 公共 RPC 的 4xx 是节点限制，不是应用错误（nodereal 之外的两个节点在这里会 403/429）
page.on("response", (r) => {
  const u = r.url();
  if (/bsc-rpc\.publicnode\.com|blastapi|nodereal/.test(u) && r.status() >= 400) {
    consoleErrors.push(`[rpc ${r.status()}] ${u}`);
  }
});

await installWallet(page, OWNER_ADDRESS);
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.locator(".nav-link-main").filter({ hasText: "Owner 工作台" }).first().click();
await page.waitForTimeout(2000);
const openTool = page.getByRole("button", { name: "打开工具" }).first();
const t0 = Date.now();
if (await openTool.count()) await openTool.click();
else console.log("!! 没有「打开工具」按钮");
await page.waitForTimeout(2000);

const sheetOk = await page.locator(".sheet").count();
console.log(sheetOk ? "ok   弹窗已打开" : "FAIL 弹窗未打开");

// 等历史交易记录出现事件条目（链上事件读取要几秒）
let feed = [];
let firstMs = null;
for (let i = 0; i < 40; i++) {
  feed = await page.locator(".trade-feed-item").allInnerTexts().catch(() => []);
  if (feed.length) { firstMs = Date.now() - t0; break; }
  await page.waitForTimeout(250);
}
console.log("首条记录耗时:", firstMs == null ? "超时" : `${(firstMs / 1000).toFixed(1)}s`);
const panelText = await page.locator(".trade-panel").first().innerText().catch(() => "");
console.log("\n=== 历史交易记录 ===\n" + panelText);
// 折叠标题「链上事件 · 最近 N 条」里的 N 是**截断前**的总条数。
// 只有 N > 3 才该出现「仅显示最近 3 条」；只看已渲染的 feed.length 判断不了
// 「正好 3 条」和「从更多条截断到 3 条」，会把没截断的情况误判成缺提示。
// 总条数写在 .trade-log 的 <summary> 里，不在 .trade-panel 的 innerText 范围内。
// details 折叠时 summary 仍可见，但保险起见从整个弹窗文本里找。
const sheetText = await page.locator(".sheet").first().innerText().catch(() => "");
const totalMatch = /链上事件 · 最近\s*(\d+)\s*条/.exec(sheetText);
const total = totalMatch ? Number(totalMatch[1]) : null;
console.log("事件条目数:", feed.length, "链上事件总数:", total);
console.log(feed.slice(0, 6).map((t, i) => `  ${i + 1}. ${t.replace(/\n/g, " | ")}`).join("\n"));

// 挂买单：默认数量 + 市价列
const hasForm = (await page.locator(".flow-table-order").count()) > 0;
const qtyVals = hasForm ? await page.locator(".flow-table-order tbody tr td:nth-child(2) input").evaluateAll((els) => els.map((e) => e.value)) : [];
const quoteHeads = hasForm ? await page.locator(".flow-table-order thead th").allTextContents() : [];
const quoteCell = hasForm ? await page.locator(".flow-table-order .flow-quote").first().innerText().catch(() => "") : "";
const hasHint = hasForm ? /点填/.test(await page.locator(".flow-table-order").innerText().catch(() => "")) : false;
console.log("\n挂买单表单存在:", hasForm);
console.log("挂买单数量:", JSON.stringify(qtyVals));
console.log("表头:", JSON.stringify(quoteHeads));
console.log("市价单元格:", JSON.stringify(quoteCell), hasHint ? "（仍含「点填」）" : "（无「点填」）");

const checks = [
  ["弹窗打开", Boolean(sheetOk)],
  ["历史记录来自链上事件（有条目）", feed.length > 0],
  ["只显示最近 3 条", feed.length > 0 && feed.length <= 3],
  [
    "截断提示与总条数一致",
    total == null
      || (total > 3 ? /仅显示最近 3 条/.test(panelText) : !/仅显示最近 3 条/.test(panelText)),
  ],
  ["不再出现「这版市场合约没有事件」", !/这版市场合约没有事件|按订单状态推算/.test(panelText)],
  ["有成交/挂单事件文案", /挂买单|买单 #|成交/.test(feed.join(" "))],
  ["数量默认 1", !hasForm || (qtyVals.length > 0 && qtyVals.every((v) => v === "1"))],
  ["市价列头为官方市价", !hasForm || quoteHeads.includes("官方市价")],
  ["市价单元格无「点填」", !hasForm || !hasHint],
];
console.log("\n---- 断言 ----");
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
console.log("pageerror:", pageErrors.length ? pageErrors.slice(0, 5) : "none");
console.log("console.error:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");

await page.screenshot({ path: join(SHOT_DIR, "ops-history.png"), fullPage: false });
console.log("SHOT", join(SHOT_DIR, "ops-history.png"));
await browser.close();
