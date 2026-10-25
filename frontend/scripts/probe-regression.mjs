/**
 * 回归探针：验证本轮改动（client.js 死分支清理 / podStart.js 删除 / 合约错误解码）在页面上无回归。
 *
 * 关键点：5173 端口可能是用户自己开的 dev server，端口通不代表是我们的应用，
 * 所以先 fetch "/" 校验 title 是不是「TapeOut 众筹挖矿」，再决定用哪个端口。
 * 本前端是点击式导航（无 URL 路由），所以按侧边栏导航项逐个点击检查。
 *
 * 运行：node scripts/probe-regression.mjs [port]
 * 注：playwright 装在托管 workspace 里，ESM 不认 NODE_PATH，这里用绝对路径导入。
 */
import { createRequire } from "node:module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const EXPECT_TITLE = "TapeOut 众筹挖矿";
const NAV_LABELS = ["BEM挖矿认筹", "我的资产", "资产转让", "规则与合约", "Owner 工作台"];

async function probe(port) {
  // 1. 端口必须真的是本应用
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
  const html = await res.text();
  if (!html.includes(EXPECT_TITLE)) {
    console.log(`SKIP 端口 ${port} 不是本应用（title 不匹配）`);
    return null;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  /**
   * 外部子资源失败噪声：公共 RPC（bsc-rpc.publicnode.com）本机常返 403 / 429，
   * 浏览器只报「Failed to load resource: … (429)」且不带 URL，会被当成应用错误。
   * 只有确实观察到**外部主机** 4xx/5xx 时才放过这类通用资源错误；
   * pageerror 与其它 console.error 照旧严格断言。
   */
  const origin = `http://127.0.0.1:${port}`;
  const externalFailures = new Set();
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().startsWith(origin)) externalFailures.add(r.url());
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (text.includes("Failed to load resource") && externalFailures.size > 0) return;
    errors.push(text);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  // T-64：Owner 工作台只对 Owner 展示 → 注入 Owner 钱包，否则导航项不存在。
  await installWallet(page, OWNER_ADDRESS);

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  for (const label of NAV_LABELS) {
    const link = page.locator(".nav-link-main", { hasText: label }).first();
    if (await link.count()) {
      await link.click();
      await page.waitForTimeout(1000);
    }
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
    const hit = await link.count() ? "点击" : "未找到";
    console.log(`OK   ${label.padEnd(12)} ${hit}  文本 ${String(body.length).padStart(5)} 字符`);
    if (body.length < 20) errors.push(`${label} 页面几乎空白（${body.length} 字符）`);
  }

  // 3. 检查页面上不该出现的陈旧概念
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  for (const [word, why] of [
    ["tapeout.net", "旧市场外链措辞"],
    ["可领", "BEM 可领取（已下线）"],
    ["全网日产", "日产指标（合约无此逻辑）"],
    ["待流片", "流片残留措辞"],
  ]) {
    if (text.includes(word)) errors.push(`首页仍出现「${word}」（${why}）`);
  }

  // 4. 规则页「谁能做什么」必须与链上权限一致（T-63）
  //  - 发布出售挂单：只有持份人（listShares 要求 _shares[msg.sender] >= count）
  //  - 撤销挂单：挂单方或 Owner（cancelListing）
  //  - 接收挂单：任何非卖方地址都能，接了才成为持份人（takeListing）
  // 术语统一用「发布出售挂单 / 接收 / 撤销」，不再用「挂牌 / 接单」。
  const rulesLink = page.locator(".nav-link-main").filter({ hasText: "规则与合约" }).first();
  if (await rulesLink.count()) {
    await rulesLink.click();
    await page.waitForTimeout(1000);
    const roles = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".rules-roles article")).map((a) => ({
        role: (a.querySelector("strong")?.textContent || "").trim(),
        text: (a.querySelector("p")?.textContent || "").trim(),
      })),
    );
    const byRole = Object.fromEntries(roles.map((r) => [r.role, r.text]));
    console.log("  规则页角色：", JSON.stringify(roles));
    if (!byRole["持份用户"]?.includes("发布出售挂单")) {
      errors.push("规则页：持份用户应写「发布出售挂单」");
    }
    if (byRole["持份用户"]?.includes("接收他人挂单")) {
      errors.push("规则页：接收挂单不属于持份用户专属（任何非卖方地址都能接）");
    }
    if (!byRole["任何人"]?.includes("接收他人挂单")) {
      errors.push("规则页：任何人应写明挖矿中可接收他人挂单");
    }
    if (!byRole["Factory Owner"]?.includes("撤销任意挂单")) {
      errors.push("规则页：Owner 可撤销任意挂单（cancelListing 允许 owner）");
    }
    // 术语：退出路径统一叫「挖矿份额转让」
    const rulesText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    if (!rulesText.includes("挖矿份额转让")) {
      errors.push("规则页：退出路径应写「挖矿份额转让」");
    }
    if (/挖矿中挂牌|接单、撤销|走资产转让/.test(rulesText)) {
      errors.push("规则页：仍残留「挂牌 / 接单 / 走资产转让」旧措辞");
    }
  } else {
    errors.push("找不到「规则与合约」导航项");
  }

  await browser.close();
  return errors;
}

const port = Number(process.argv[2] || 5173);
const errors = await probe(port);
if (errors === null) {
  console.log("没有可用的探针端口");
  process.exit(2);
}
if (errors.length) {
  console.log(`\n发现 ${errors.length} 个问题：`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log("\n零控制台错误，零空白页，无陈旧概念");
