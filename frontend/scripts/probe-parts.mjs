/**
 * 探针：验证认筹页「晶体管数 / 算力」口径已改成真实成交数据。
 *
 * 背景：截图里显示「晶体管数 60 颗 / 权重 68」，那是募资额反推的计划值
 * （链上模式根本没有 partCount，落到 fixtures 默认值），与真实买入的晶体管无关。
 * 期望：链上模式下未买入 → 显示「未买入」；已买入 → 显示 book.transistorCount。
 *
 * 运行：node scripts/probe-parts.mjs [port]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const EXPECT_TITLE = "TapeOut 众筹挖矿";

async function probe(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
  const html = await res.text();
  if (!html.includes(EXPECT_TITLE)) {
    console.log(`SKIP 端口 ${port} 不是本应用`);
    return null;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // 抓取事实卡片区的文本
  const facts = await page.locator(".stat-grid.facts").first().innerText().catch(() => "");
  console.log("── 事实卡片区 ──");
  console.log(facts.replace(/\n{2,}/g, "\n"));

  // 抓下方算力说明卡
  const notes = await page.locator(".note-card").first().innerText().catch(() => "");
  console.log("\n── 算力说明卡 ──");
  console.log(notes.replace(/\n{2,}/g, "\n"));

  // 抓当前进度区
  const bill = await page.locator(".bill").first().innerText().catch(() => "");
  console.log("\n── 当前进度 ──");
  console.log(bill.replace(/\n{2,}/g, "\n"));

  await browser.close();
  return { errors, facts, notes, bill };
}

const port = Number(process.argv[2] || 5173);
const out = await probe(port);
if (!out) process.exit(2);
console.log(`\n── 控制台错误 ${out.errors.length} 条 ──`);
for (const e of out.errors) console.log(`  - ${e}`);
