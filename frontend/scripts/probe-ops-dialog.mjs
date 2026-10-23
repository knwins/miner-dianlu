/**
 * 探针：验证「合约操作」弹窗的新版 UI + 官方元件市价。
 *
 * 检查项：
 *   1. 弹窗能打开，顶部有四个标签页（合约操作 / 份额明细 / 合约调用 / 链上调试）
 *   2. 链上参数区不再出现假值：「服务费分成 … 100%」「本期元件 68 颗」「预估算力 0 H」
 *   3. 弹窗内**不再**出现官方元件最新价面板（市价统一在「材料市场」页，见 273aaf6）
 *   4. 切到其它标签页能正常渲染
 */
import { createRequire } from "module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const BASE = process.env.BASE || "http://127.0.0.1:4180";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// T-64：Owner 工作台只对 Owner 展示 → 注入 Owner 钱包。
await installWallet(page, OWNER_ADDRESS);

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 导航到 Owner 工作台
const nav = page.locator(".nav-link-main");
for (const name of ["Owner 工作台"]) {
  const link = nav.filter({ hasText: name });
  if (await link.count()) { await link.first().click(); break; }
}
await page.waitForTimeout(2500);

// 打开工具弹窗
const openTool = page.getByRole("button", { name: "打开工具" }).first();
if (await openTool.count()) {
  await openTool.click();
} else {
  console.log("!! 没找到「打开工具」按钮");
}
await page.waitForTimeout(3000);

const sheet = page.locator(".sheet");
if (!(await sheet.count())) {
  console.log("!! 弹窗没打开");
  await browser.close();
  process.exit(1);
}

// 1) 标签页
const tabs = await page.locator(".sheet-tab").allTextContents();
console.log("标签页:", tabs.join(" | "));

// 2) 链上参数区文本
const params = await page.locator(".sheet .param-grid").first().innerText().catch(() => "(没有 param-grid)");
console.log("\n=== 链上参数（本期）===\n" + params);

// 顶部 summary
const summary = await page.locator(".sheet .detail-summary").first().innerText().catch(() => "");
console.log("\n=== 顶部概览 ===\n" + summary);

// 3) 官方价格面板：已从弹窗移除（市价统一在材料市场页）
const priceCard = page.locator(".official-price-card").first();
const priceCardCount = await priceCard.count();
console.log(`${priceCardCount === 0 ? "ok  " : "FAIL"} 弹窗内无官方元件最新价面板${priceCardCount ? ` （仍有 ${priceCardCount} 个）` : ""}`);

// 4) 切标签
for (const t of ["份额明细", "合约调用", "链上调试", "合约操作"]) {
  await page.locator(".sheet-tab", { hasText: t }).first().click();
  await page.waitForTimeout(1200);
  const body = await page.locator(".sheet-body").innerText();
  console.log(`\n切到「${t}」→ 面板 ${body.length} 字符，头部：${body.slice(0, 90).replace(/\n/g, " / ")}`);
}

console.log("\n控制台错误:", errors.length ? errors.join("\n") : "无");
await browser.close();
