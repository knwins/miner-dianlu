/**
 * 探针：手机屏（≤430px）全页面适配体检。
 *
 * 为什么要有它：`vite build` 只证明能打包，证明不了 390px 下版式是否成立。
 * 桌面截图肉眼看、手机端却会被挤断，所以这里把「看得见的问题」量化成硬指标：
 *
 *   A 横向溢出：文档 scrollWidth > 视口，或元素 rect 越出视口
 *   B 字号：叶子文本 < 11px（11px 已是最小的说明文字）
 *   C 触控目标：可点控件（button/a/input/select/role=button）边长 < 36px
 *   D 固定层：两个 position:fixed 元素互相遮挡
 *   E 文字截断：overflow:hidden 且 scrollHeight/Width 超出（内容被切掉）
 *   F 横向滚动容器：scrollWidth > clientWidth（表格允许，其余要留意）
 *   G 生命周期条：三个圆点必须落在同一水平线，副提示必须是单行且不出视口
 *     （这一条是回归保护：曾经在 390px 下 wrap 成三行、圆圈左右错位，
 *      数值审计全绿但肉眼一看就是坏的）
 *
 * 已知合法例外（写进来是为了不每次手改脚本）：
 *   - 侧边栏 .sidebar / 遮罩 .backdrop 收起时本就在视口左侧外，不算溢出
 *   - 规则页的合约地址链接是 312×17 的整行链接，横向远宽于 36，
 *     纵向窄但整行可点，不算触控不达标
 *
 * 运行：node scripts/probe-mobile.mjs [port]（默认 5180）
 *      OUT=<目录> 可指定截图目录；不设则写系统临时目录
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright",
);

const PORT = process.argv[2] || "5180";
const BASE = `http://127.0.0.1:${PORT}/`;
const VW = 390;
const VH = 844;
const SHOT_DIR = process.env.OUT || mkdtempSync(join(tmpdir(), "tapeout-mobile-"));
mkdirSync(SHOT_DIR, { recursive: true });

/** 手机端抽屉里的导航：点 ☰ 展开后点这一项 */
const PAGES = [
  ["资产", "我的资产"],
  ["转让", "资产转让"],
  ["规则", "规则与合约"],
  ["市场", "晶体管市场"],
  ["Owner", "Owner 工作台"],
];

/** 触控目标豁免：整行宽的链接纵向虽窄，但横向远超 36px，手指点得到 */
const TOUCH_EXEMPT = [".rules-contract-addr"];

const html = await (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).text();
if (!html.includes("TapeOut 众筹挖矿")) {
  console.log(`SKIP 端口 ${PORT} 不是本应用`);
  process.exit(0);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
const page = await ctx.newPage();

const errors = [];
const externalFailures = new Set();
const origin = new URL(BASE).origin;
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().startsWith(origin)) externalFailures.add(r.url());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  // 公共 RPC 在浏览器侧 403/429 是环境噪声，不是应用错误
  if (text.includes("Failed to load resource") && externalFailures.size > 0) return;
  errors.push(`console: ${text}`);
});

await installWallet(page, OWNER_ADDRESS);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
/**
 * 必须等链上数据落位再检。`.life-strip` 只在期次数据读到后才渲染，
 * 拿它当「首屏已就位」的信号；否则截到的是「正在从 BSC 主网读取…」骨架，
 * 布局虽然也是真的，但量不到真实内容的密度与折行。
 */
await page.waitForSelector(".life-strip", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);

const MEASURE = ([vw, exempt]) => {
  const de = document.documentElement;
  const res = { overflow: [], tiny: [], touch: [], fixed: [], clipped: [], hscroll: [] };
  const label = (el) => {
    const c = (el.className || "").toString().trim().split(/\s+/).slice(0, 2).join(".");
    return el.tagName.toLowerCase() + (c ? "." + c : "");
  };
  const txt = (el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
  const all = [...document.querySelectorAll("body *")];

  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (el.closest(".sidebar") || el.closest(".backdrop")) continue;

    if (r.right > vw + 1 || r.left < -1) {
      res.overflow.push({ el: label(el), left: Math.round(r.left), right: Math.round(r.right) });
    }
    const fs = parseFloat(cs.fontSize);
    if (fs && fs < 11 && el.children.length === 0 && txt(el)) {
      res.tiny.push({ el: label(el), fs, text: txt(el) });
    }
    // 只统计真正的控件：button/a/input/select/[role=button]，
    // 带 cursor:pointer 的 span、图标 svg 不是独立控件，不纳入
    const isControl =
      ["BUTTON", "A", "INPUT", "SELECT"].includes(el.tagName) || el.getAttribute("role") === "button";
    const exempted = exempt.some((s) => el.matches && el.matches(s));
    if (isControl && !exempted && (r.height < 36 || r.width < 36)) {
      res.touch.push({ el: label(el), w: Math.round(r.width), h: Math.round(r.height), text: txt(el) });
    }
    if (
      (cs.overflow === "hidden" || cs.overflowY === "hidden") &&
      el.scrollHeight > el.clientHeight + 2 &&
      el.clientHeight > 0
    ) {
      res.clipped.push({ el: label(el), ch: el.clientHeight, sh: el.scrollHeight, text: txt(el) });
    }
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== "visible" && el.clientWidth > 0) {
      res.hscroll.push({ el: label(el), cw: el.clientWidth, sw: el.scrollWidth });
    }
  }

  const fixeds = all
    .filter((el) => getComputedStyle(el).position === "fixed")
    .map((el) => ({ el, r: el.getBoundingClientRect(), cs: getComputedStyle(el) }))
    .filter((x) => x.r.width > 0 && x.r.height > 0 && x.cs.visibility !== "hidden");
  for (let i = 0; i < fixeds.length; i++) {
    for (let j = i + 1; j < fixeds.length; j++) {
      const a = fixeds[i], b = fixeds[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox > 4 && oy > 4) res.fixed.push({ a: label(a.el), b: label(b.el) });
    }
  }

  return {
    vw,
    docScroll: de.scrollWidth,
    hScroll: de.scrollWidth > vw + 1,
    ...res,
  };
};

const fail = [];
let checked = 0;

const audit = async (name) => {
  checked++;
  const r = await page.evaluate(MEASURE, [VW, TOUCH_EXEMPT]);
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });

  const tag = (bad) => (bad ? "BAD " : "ok  ");
  const line =
    `${tag(r.hScroll || r.overflow.length)} ${name}: vw=${r.vw} scrollW=${r.docScroll}` +
    ` 越界=${r.overflow.length} 小字=${r.tiny.length} 触控<36=${r.touch.length}` +
    ` 固定层重叠=${r.fixed.length} 截断=${r.clipped.length} 横滚容器=${r.hscroll.length}`;
  console.log(line);

  if (r.hScroll) fail.push(`${name}: 文档横向溢出（scrollW=${r.docScroll} > vw=${r.vw}）`);
  if (r.overflow.length) fail.push(`${name}: ${r.overflow.length} 个元素越出视口 ${JSON.stringify(r.overflow.slice(0, 3))}`);
  if (r.tiny.length) fail.push(`${name}: ${r.tiny.length} 处文字小于 11px ${JSON.stringify(r.tiny.slice(0, 3))}`);
  if (r.touch.length) fail.push(`${name}: ${r.touch.length} 个控件边长 <36px ${JSON.stringify(r.touch.slice(0, 3))}`);
  if (r.fixed.length) fail.push(`${name}: 固定层互相遮挡 ${JSON.stringify(r.fixed.slice(0, 3))}`);
  if (r.clipped.length) fail.push(`${name}: ${r.clipped.length} 处文字被切掉 ${JSON.stringify(r.clipped.slice(0, 3))}`);
};

await audit("认筹");

/**
 * 生命周期条专项：三个圆点同一水平线、副提示单行。
 * 手机上 circle 尺寸、连接线、副提示都换过算法，任何一处回退都会让这条失败。
 */
const auditProgress = async () => {
  checked++;
  const g = await page.evaluate(() => {
    const dots = [...document.querySelectorAll(".life-strip .life-dot")];
    if (dots.length !== 3) return { dots: dots.length };
    const tops = dots.map((d) => Math.round(d.getBoundingClientRect().top));
    const phase = document.querySelector(".life-strip .life-phase");
    const pr = phase?.getBoundingClientRect();
    const lh = phase ? parseFloat(getComputedStyle(phase).lineHeight) : 0;
    return {
      dots: 3,
      tops,
      sameRow: new Set(tops).size === 1,
      phaseLines: phase ? Math.round(pr.height / lh) : 0,
      phaseInView: phase ? pr.left >= 8 && pr.right <= innerWidth - 8 : true,
      phaseText: phase?.textContent?.trim() || "",
    };
  });
  if (g.dots !== 3) {
    // 读不到链上数据时首屏是骨架，没有进度条，属环境问题不算版式回归
    console.log(`SKIP 生命周期条：页面上有 ${g.dots} 个圆点（期次数据未加载）`);
    return;
  }
  const bad = !g.sameRow || g.phaseLines > 1 || !g.phaseInView;
  console.log(
    `${bad ? "BAD " : "ok  "}生命周期条: 三圆点同行=${g.sameRow} 副提示行数=${g.phaseLines}` +
      ` 在视口内=${g.phaseInView}${g.phaseText ? ` 「${g.phaseText}」` : ""}`,
  );
  if (!g.sameRow) fail.push(`生命周期条：三个圆点不在同一水平线 tops=${JSON.stringify(g.tops)}`);
  if (g.phaseLines > 1) fail.push(`生命周期条：副提示折成 ${g.phaseLines} 行`);
  if (!g.phaseInView) fail.push("生命周期条：副提示超出视口");
};

await auditProgress();

for (const [name, nav] of PAGES) {
  const menuBtn = page.locator(".menu-btn");
  if (await menuBtn.count()) {
    await menuBtn.click();
    await page.waitForTimeout(450);
  }
  const link = page.locator(".nav-link-main").filter({ hasText: nav }).first();
  if (!(await link.count())) {
    fail.push(`找不到导航「${nav}」`);
    continue;
  }
  await link.click();
  await page.waitForTimeout(1600);
  await audit(name);
}

fail.push(...errors);
await browser.close();

console.log(`\n截图目录：${SHOT_DIR}`);
if (fail.length) {
  console.log("\nFAIL\n" + fail.map((x) => ` - ${x}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`\nPASS  ${checked} 个页面 · 390px 下无横向溢出 / 无小字 / 控点达标 / 无遮挡 / 无截断 · 无报错`);
}
