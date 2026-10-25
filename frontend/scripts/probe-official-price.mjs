/**
 * 探针：官方市价在「兜底 404」时仍要由链上主源撑住，且不靠扫日志。
 *
 * 为什么要有它：生产环境（静态托管）没有 vite 的 /tt-api 代理，那条路必然 404。
 * 官方市价的主源是**链上官方市场的活跃买单**（`nextBidId()` + `bids(id)`，
 * 纯 eth_call，不扫日志），兜底才是 market.json —— 只要主源能读到价，
 * 404 就不该让页面报错、价格也不该空。
 *
 * 坏过两次（都发生在 2026-10-23，值得记住）：
 *   1. 主源只查最近 5000/2000 块的成交事件，而官方市场成交极稀疏（实测 5000 块
 *      窗口 0 条、20000 块才有 32 条），主源恒空 → 生产一 404 就报错。
 *      看着像反代没配，根因其实是窗口太小。
 *   2. 修法是「窗口放大到 20000 × 8 档 ≈ 16 万块」，能取到价，但代价是节点：
 *      publicnode 把历史日志当 archive 请求（403）、drpc 限跨度、只剩 nodereal
 *      一个能用，量大就限流。
 *   于是主源换成读挂单状态 —— 挂单是当前状态，eth_call 读最新状态不需要 archive
 *      数据，任何公共节点都能答，一次 eth_getLogs 都不用发。
 *
 * 这里用路由拦截把 /tt-api 打成 404，精确复现生产那一幕；并直接调用应用的
 * fetchOfficialPrices 看它报的 source，确认走的确实是挂单而不是成交日志。
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

// 记录链上读取：确认主源真的走了 RPC，而不是碰巧有缓存价。
// eth_call 与 eth_getLogs 分开数 —— 主源读挂单只会发 eth_call；
// eth_getLogs 只应来自历史交易记录（市场页自己要读市场事件）。
let logCalls = 0;
let ethCalls = 0;
page.on("request", (r) => {
  if (r.method() !== "POST") return;
  let body = "";
  try {
    body = r.postData() || "";
  } catch {
    body = "";
  }
  logCalls += (body.match(/eth_getLogs/g) || []).length;
  ethCalls += (body.match(/eth_call/g) || []).length;
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
// 官方价面板（全量卡片形态）在市场页
await page.locator(".nav-link-main").filter({ hasText: "晶体管市场" }).first().click().catch(() => {});
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
if (ethCalls === 0) fail.push("没有发出 eth_call，主源没去读市场挂单");

// 直接调应用模块，看它自己报的来源 —— DOM 只能看到「有没有价」，看不出走哪条路
const direct = await page.evaluate(async () => {
  try {
    const mod = await import("/src/officialPrices.js");
    const r = await mod.fetchOfficialPrices({ force: true });
    const rows = {};
    for (const [id, row] of Object.entries(r.prices || {})) {
      rows[id] = row.bid != null ? `bid=${row.bid}` : `last=${row.last}`;
    }
    return { ok: r.ok, source: r.source, error: r.error, rows };
  } catch (e) {
    return { err: String(e) };
  }
});
if (direct.err) fail.push(`直接调用 fetchOfficialPrices 失败：${direct.err}`);
else {
  if (!direct.ok) fail.push(`fetchOfficialPrices ok=false：${direct.error}`);
  // 来源必须含 openBids —— 那是「读挂单」的标记；只剩 trades 说明挂单没读到、退回扫日志了
  if (!String(direct.source).includes("openBids")) {
    fail.push(`市价来源不是挂单（source=${direct.source}）—— 退回扫成交日志了`);
  }
  if (Object.keys(direct.rows || {}).length < 4) {
    fail.push(`只拿到 ${Object.keys(direct.rows || {}).length} 个晶体管的价（应为 4）`);
  }
}

console.log(
  `价面板=${view.groups} 单价=${JSON.stringify(view.prices)} eth_call=${ethCalls}` +
    ` eth_getLogs=${logCalls} 占位=${view.hasPlaceholder ? "有" : "无"} 失败提示=${view.failNotice ? "有" : "无"}`,
);
console.log(`模块直调：source=${direct.source} 晶体管=${JSON.stringify(direct.rows)}`);
console.log("面板文本：" + view.firstText.replace(/\n+/g, " | ").slice(0, 260));
fail.push(...errors);
await browser.close();

if (fail.length) {
  console.log("\nFAIL\n" + fail.map((x) => ` - ${x}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("\nPASS  /tt-api 404（等同生产未配反代）下，官方市价仍由链上活跃买单给出，页面不报错，且没扫日志");
}
