/**
 * 探针：官方 NAND / LATCH 最新价是否被正确取到并展示。
 *
 * 当前测试网第 1 期处于「已结束」，无法进入挂单表单。
 * 这里改验两件事：
 *   1. 官方价格面板在「材料市场」页渲染出来了，且 NAND/LATCH 价不同
 *      （T-62 起认购页已删除该模块，市价统一在材料市场页查）
 *   2. officialPartPrices 能按处理器分别取到两种元件的价
 */
import { createRequire } from "module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
// 外部公共 RPC（bsc-rpc.publicnode.com）在本机网络下会 403；浏览器对失败子资源
// 只报通用的「Failed to load resource」。记录外部 4xx，放过这类网络噪声，其余照旧。
const externalFailures = new Set();
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().startsWith("http://127.0.0.1")) externalFailures.add(r.url());
});
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (m.text().includes("Failed to load resource") && externalFailures.size > 0) return;
  errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// T-64：Owner 工作台只对 Owner 展示 → 注入 Owner 钱包。
await installWallet(page, OWNER_ADDRESS);

await page.goto(process.env.BASE || "http://127.0.0.1:4180", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

// T-62：认购页已删官方价面板，市价统一在「材料市场」页看
const marketLink = page.locator(".nav-link-main").filter({ hasText: "材料市场" });
if (await marketLink.count()) await marketLink.first().click();
// 链上成交价是异步取的，等久一点，避免把「读取中 / —」当成取价失败。
await page.waitForTimeout(4500);

// 材料市场页官方价
const card = page.locator(".market-page .official-price-card").first();
console.log("材料市场页官方价面板存在:", await card.count() > 0);
if (await card.count()) {
  const t = await card.innerText();
  // 表格现在只有「元件 / 成交价」；tokenId 以 #0 / #1 后缀并入元件名。
  // innerText 里 #0 与元件名之间没有空白（间距是 CSS margin），用 \s*。
  const nand = /NAND\s*#\d+\s*([\d.]+)/.exec(t);
  const latch = /LATCH\s*#\d+\s*([\d.]+)/.exec(t);
  console.log("  NAND  成交价:", nand ? nand[1] : "?");
  console.log("  LATCH 成交价:", latch ? latch[1] : "?");
  console.log("  NAND ≠ LATCH（分别取价）:", nand && latch ? nand[1] !== latch[1] : "无法判断");
}

// 切到 Behemoth 组
const groups = await page.locator(".market-page .official-price-group h4").allTextContents();
console.log("处理器分组:", groups.join(" | "));

// 弹窗里也要有
const link = page.locator(".nav-link-main").filter({ hasText: "Owner 工作台" });
if (await link.count()) await link.first().click();
await page.waitForTimeout(2500);
const openTool = page.getByRole("button", { name: "打开工具" }).first();
if (await openTool.count()) await openTool.click();
await page.waitForTimeout(2500);
console.log("弹窗内官方价面板存在:", await page.locator(".sheet .official-price-card").count() > 0);

// 发行记录（服务费）区
const params = await page.locator(".sheet .param-grid").first().innerText();
console.log("\n链上参数区:\n" + params);

console.log("\n控制台错误:", errors.length ? errors.join("\n") : "无");
await browser.close();
