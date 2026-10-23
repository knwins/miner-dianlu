/**
 * 探针：Owner 工作台内嵌的「链上调试（OnChainPage）」与「合约调用（ContractCalls）」面板
 * 渲染是否正常、有无运行时报错。本次改动动了 OnChain.jsx 的挂买单表单与 Calls.jsx 文案，
 * 这两个面板都随本期状态重渲染，必须零 pageerror。
 *
 * 入口路径（与真实用户一致）：
 *   众筹挖矿列表 → 某期卡片的「打开工具」按钮 → 弹窗（portal 到 body）→ .sheet-tab 切换
 *   「链上调试」/「合约调用」。卡片本身点开是跳 Round 页，不会显示这两个 tab，所以探针只点
 *   卡片内的「打开工具」按钮（.row-actions 已 stopPropagation，不会触发卡片跳转）。
 *
 * 外部公共 RPC（bsc-rpc.publicnode.com）在本机网络下可能 403/429，浏览器只对失败子资源
 * 报通用的「Failed to load resource」，这类网络噪声统一放过，只盯真实 JS 报错。
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

// 进 Owner 工作台
const ownerNav = page.locator(".nav-link-main", { hasText: "Owner 工作台" });
console.log("Owner 工作台导航存在:", await ownerNav.count() > 0);
if (await ownerNav.count()) {
  await ownerNav.first().click();
  await page.waitForTimeout(2500);
}

// 找一张有「打开工具」按钮的期次卡片（卡片需有链上地址 + Owner 身份才渲染该按钮）
const toolBtn = page.locator(".campaign-card .campaign-link", { hasText: "打开工具" }).first();
console.log("「打开工具」按钮存在:", await toolBtn.count() > 0);
if (await toolBtn.count() === 0) {
  console.log("  [跳过] 当前没有可打开工具的期次（可能链上未读到期次或不是 Owner）");
} else {
  await toolBtn.click();
  await page.waitForTimeout(2000);
}

async function openTab(label) {
  // 弹窗用 portal 挂 body，.sheet-tab 在顶层
  const tab = page.locator(".sheet-tab", { hasText: label });
  if (await tab.count() === 0) {
    console.log(`  [跳过] 找不到「${label}」标签`);
    return false;
  }
  await tab.first().click();
  await page.waitForTimeout(2000);
  return true;
}

console.log("打开 链上调试 面板…");
const okOnchain = await openTab("链上调试");
if (okOnchain) {
  // 内嵌面板复用工作台连接；若本会话尚未连接（探针场景），点一次「连接钱包」。
  const connectBtn = page.locator(".chain-debug button", { hasText: "连接钱包" }).first();
  if (await connectBtn.count()) {
    await connectBtn.click();
    await page.waitForTimeout(1500);
  }
  const buyBtn = page.locator("button", { hasText: "挂买单" });
  console.log("  「挂买单」按钮存在:", await buyBtn.count() > 0);
  // 在 NAND 数量 / 买价 输入，验证成本预览不报错、超余额时按钮禁用
  const nandQty = page.locator('input[inputmode="numeric"]').first();
  if (await nandQty.count()) {
    try {
      await nandQty.fill("1");
      await page.waitForTimeout(300);
      const price = page.locator('input[inputmode="decimal"]').first();
      if (await price.count()) await price.fill("0.001");
      await page.waitForTimeout(300);
      // 成本预览文本：托管合计 X BNB · 募集余额 Y BNB
      const preview = page.locator(".chain-debug .buy-debug p", { hasText: "托管合计" });
      console.log("  挂买单成本预览存在:", await preview.count() > 0);
      // 超余额场景：把买价填到天文数字，按钮应被禁用
      const price2 = page.locator('input[inputmode="decimal"]').first();
      if (await price2.count()) {
        await price2.fill("999999");
        await page.waitForTimeout(300);
        const disabled = await buyBtn.first().isDisabled();
        console.log("  超余额时「挂买单」禁用:", disabled);
        await price2.fill("0.001");
        await page.waitForTimeout(300);
        const enabled = !(await buyBtn.first().isDisabled());
        console.log("  合理价格时「挂买单」可用:", enabled);
      }
      console.log("  挂买单表单可输入，无报错");
    } catch (e) {
      console.log("  表单输入异常:", e.message);
    }
  }
}

console.log("打开 合约调用 面板…");
const okCalls = await openTab("合约调用");
if (okCalls) {
  const methodItem = page.locator(".method-item").first();
  console.log("  合约调用函数列表存在:", await methodItem.count() > 0);
  // 点开一个写函数，验证签名/摘要渲染不报错
  const writeItem = page.locator(".method-item", { hasText: "placeTransistorOrder" }).first();
  if (await writeItem.count()) {
    try {
      await writeItem.click();
      await page.waitForTimeout(500);
      const sig = page.locator(".mono", { hasText: "placeTransistorOrder" });
      console.log("  placeTransistorOrder 签名渲染:", await sig.count() > 0);
    } catch (e) {
      console.log("  合约调用点选异常:", e.message);
    }
  }
}

console.log("\n运行时错误数:", errors.length);
for (const e of errors.slice(0, 10)) console.log("  •", e);
await browser.close();
process.exit(errors.length ? 1 : 0);
