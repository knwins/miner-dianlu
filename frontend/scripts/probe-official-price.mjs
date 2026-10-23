/**
 * 探针：官方市价在「兜底 404」时仍要由链上主源撑住。
 *
 * 为什么要有它：生产环境（静态托管）没有 vite 的 /tt-api 代理，那条路必然 404。
 * 官方市价的主源是**链上官方市场的成交事件**，兜底才是 market.json ——
 * 只要主源能读到价，404 就不该让页面报错、价格也不该空。
 *
 * 曾经坏过一次（2026-10-23）：主源只查最近 5000/2000 块，而官方市场成交很稀疏
 * （实测 5000 块窗口 0 条、20000 块才有 32 条），于是主源恒为空，
 * 生产一 404 就弹「官方市价读取失败」—— 看着像反代没配，根因其实是窗口太小。
 *
 * 这里用路由拦截把 /tt-api 打成 404，精确复现生产那一幕。
 *
 * 运行：node scripts/probe-official-price.mjs [port]（默认 5180）
 */
import { createRequire } from "node:module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright",
);

const PORT = process.argv[2] || "5180";
const BASE = `http://127.0.0.1:${PORT}/`;

const html = await (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).text();
if (!html.includes("TapeOut 众筹挖矿")) {
  console.log(`SKIP 端口 ${PORT} 不是本应用`);
  process.exit(0);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await installWallet(ctx, OWNER_ADDRESS);
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// 生产那一幕：同源 /tt-api 直接 404
await page.route("**/tt-api/**", (route) =>
  route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
);

// 记录链上读取：确认主源真的走了 RPC，而不是碰巧有缓存价
let rpcHits = 0;
page.on("request", (r) => {
  if (r.method() !== "POST") return;
  let body = "";
  try {
    body = r.postData() || "";
  } catch {
    body = "";
  }
  if (body.includes("eth_getLogs")) rpcHits += 1;
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
// 官方价面板（全量卡片形态）在市场页
await page.locator(".nav-link-main").filter({ hasText: "材料市场" }).first().click().catch(() => {});
await page.waitForTimeout(1500);
await page.waitForSelector(".official-price-group", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(9000);

const view = await page.evaluate(() => {
  const groups = [...document.querySelectorAll(".official-price-group")];
  const text = groups.map((g) => g.innerText).join("\n");
  const body = document.body.innerText;
  return {
    groups: groups.length,
    // 单价至少 4 位小数才像链上成交价，占位「—」不算
    prices: (text.match(/\d+\.\d{3,}/g) || []).slice(0, 8),
    hasPlaceholder: /—/.test(text),
    failNotice: (body.match(/官方市价读取失败[^\n]*/) || [null])[0],
    firstText: text,
    has404Text: /市价接口返回 404/.test(body),
  };
});

const fail = [];
if (!view.groups) fail.push("市场页没有官方价面板（.official-price-group）");
if (!view.prices.length) fail.push("价格面板里没有单价（链上主源没读到，兜底又是 404）");
if (view.failNotice) fail.push(`弹出了失败提示：${view.failNotice}`);
if (view.has404Text) fail.push("页面上出现「市价接口返回 404」——链上主源没撑住");
// 占位「—」不算失败：链上只给成交价，买价列本来就是空；某个元件长期无成交
// 且兜底 404 时也会空一格。这里只把它打出来，便于分辨「全空」和「缺一格」。
if (rpcHits === 0) fail.push("没有发出 eth_getLogs，页面根本没去读链上");

console.log(
  `价面板=${view.groups} 单价=${JSON.stringify(view.prices)} eth_getLogs=${rpcHits}` +
    ` 占位=${view.hasPlaceholder ? "有" : "无"} 失败提示=${view.failNotice ? "有" : "无"}`,
);
console.log("面板文本：" + view.firstText.replace(/\n+/g, " | ").slice(0, 260));
fail.push(...errors);
await browser.close();

if (fail.length) {
  console.log("\nFAIL\n" + fail.map((x) => ` - ${x}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("\nPASS  /tt-api 404（等同生产未配反代）下，官方市价仍由链上成交事件给出，页面不报错");
}
