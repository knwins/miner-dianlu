import { createRequire } from "module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const BASE = process.env.BASE || "http://127.0.0.1:5180";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await installWallet(page, OWNER_ADDRESS);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// Owner 工作台
const ownerNav = page.locator(".nav-link-main", { hasText: "Owner 工作台" });
await ownerNav.first().click();
await page.waitForTimeout(2500);

// 打开工具弹窗
const toolBtn = page.locator(".campaign-card .campaign-link", { hasText: "打开工具" }).first();
await toolBtn.click();
await page.waitForTimeout(1500);

const tabs = ["合约操作", "份额明细", "合约调用", "链上调试"];
const widths = {};
for (const label of tabs) {
  const tab = page.locator(".sheet-tab", { hasText: label }).first();
  if (await tab.count() === 0) {
    console.log(`[跳过] 找不到 tab: ${label}`);
    continue;
  }
  await tab.click();
  await page.waitForTimeout(900);
  const w = await page.locator(".sheet").evaluate((el) => Math.round(el.getBoundingClientRect().width));
  widths[label] = w;
  console.log(`  ${label}: ${w}px`);
}

const vals = Object.values(widths);
const consistent = vals.length > 1 && vals.every((v) => v === vals[0]);
console.log("\n宽度集合:", JSON.stringify(widths));
console.log("四个 tab 宽度一致:", consistent, " | 运行时错误数:", errors.length);

await page.screenshot({ path: "scripts/_width.png" });
await browser.close();
process.exit(consistent && errors.length === 0 ? 0 : 1);
