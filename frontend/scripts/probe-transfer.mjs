/**
 * 探针：重新设计后的「资产转让（挖矿份额转让）」页
 * 验证：导航可进、连接钱包后零运行时报错、状态徽标/持仓卡/关闭横幅渲染正常。
 *
 * 主网 #0 当前是「待执行」(scene=executing)，不是挖矿中，所以发布/接收按钮处于关闭态，
 * 探针重点验证关闭态横幅与持仓展示不崩溃（开放态需挖矿中期次，主网暂无）。
 *
 * 外部公共 RPC 403/429 噪声统一放过，只盯真实 JS 报错。
 */
import { createRequire } from "module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const BASE = process.env.BASE || "http://127.0.0.1:5180";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
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

await installWallet(page, OWNER_ADDRESS);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const nav = page.locator(".nav-link-main", { hasText: "资产转让" });
console.log("资产转让 导航存在:", await nav.count() > 0);
if (await nav.count()) {
  await nav.first().click();
  await page.waitForTimeout(2500);
}

// 连接钱包（mock 注入后通常已連；仅当页面内出现「连接钱包」按钮时才需点）
const inPageConnect = page.locator("button", { hasText: "连接钱包" }).first();
if (await inPageConnect.count() && await inPageConnect.isVisible()) {
  await inPageConnect.click();
  await page.waitForTimeout(2000);
} else {
  console.log("（钱包已由 mock 自动连接，跳过连接步骤）");
}
await page.waitForTimeout(1500);

const heroTitle = page.locator("h1", { hasText: "挖矿份额转让" });
console.log("页内标题「挖矿份额转让」存在:", await heroTitle.count() > 0);

const gate = page.locator(".transfer-gate");
console.log("转让开放状态徽标存在:", await gate.count() > 0);
if (await gate.count()) {
  const cls = await gate.first().getAttribute("class");
  console.log("  徽标状态:", cls.includes("is-open") ? "开放" : "未开放");
}

const holdings = page.locator(".transfer-holdings .stat-card");
console.log("持仓卡数量:", await holdings.count());
for (const label of ["可用份额", "挂单锁定", "我的挂牌"]) {
  const card = page.locator(".transfer-holdings .stat-card", { hasText: label });
  console.log(`  持仓卡「${label}」存在:`, await card.count() > 0);
}

const banner = page.locator(".transfer-banner.is-closed");
console.log("未开放横幅存在:", await banner.count() > 0);
if (await banner.count()) {
  const txt = await banner.first().innerText();
  console.log("  横幅文案:", txt.slice(0, 48) + "…");
  const icon = await page.locator(".transfer-banner-icon").count();
  const head = await page.locator(".transfer-banner strong").innerText().catch(() => "");
  const hasMiningHint = /挖矿中/.test(head);
  console.log("  警示图标存在:", icon > 0, "| 标题含「挖矿中」:", hasMiningHint, "| 标题:", JSON.stringify(head.trim()));
  if (!icon || !hasMiningHint) {
    console.log("  [WARN] 横幅未达醒目要求（需图标 + 标题含挖矿中）");
  }
}

// 转让市场 + 发布出售 两张卡
const marketCard = page.locator(".card", { hasText: "转让市场" });
const publishCard = page.locator(".card", { hasText: "发布出售" });
console.log("转让市场卡存在:", await marketCard.count() > 0);
console.log("发布出售卡存在:", await publishCard.count() > 0);

console.log("\n运行时错误数:", errors.length);
for (const e of errors.slice(0, 10)) console.log("  •", e);
await browser.close();
process.exit(errors.length ? 1 : 0);
