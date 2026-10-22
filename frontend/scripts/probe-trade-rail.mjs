import { createRequire } from "module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
// T-64：Owner 工作台只对 Owner 展示 → 注入 Owner 钱包。
await installWallet(page, OWNER_ADDRESS);
await page.goto(process.env.BASE || "http://127.0.0.1:4180", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const link = page.locator(".nav-link-main").filter({ hasText: "Owner 工作台" });
if (await link.count()) await link.first().click();
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "打开工具" }).first().click();
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const sheet = document.querySelector(".sheet");
  const rail = sheet?.querySelector(".detail-col");
  return {
    hasRail: !!rail,
    cards: rail ? [...rail.children].map((c) => c.className) : [],
    tradePanel: !!rail?.querySelector(".trade-panel"),
    tradeTitle: rail?.querySelector(".trade-panel .card-header span")?.textContent?.trim() || null,
    tradeEmpty: rail?.querySelector(".trade-panel .flow-empty")?.textContent?.trim() || null,
    scrollH: sheet?.querySelector(".sheet-body")?.scrollHeight,
    clientH: sheet?.querySelector(".sheet-body")?.clientHeight,
  };
});
console.log(JSON.stringify({ info, errs }, null, 2));
await browser.close();
