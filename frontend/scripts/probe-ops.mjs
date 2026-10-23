/**
 * 探针：Owner 弹窗默认 tab「合约操作」的信息层级是否已简化。
 *
 * 这一轮针对该页做了三件事，都要在这里钉住：
 *   1. 删掉「官方元件最新价」整张卡（同源单价已在挂买单表格的「市价」列，点一下即填入）；
 *   2. 操作卡与右栏不再重复弹窗顶部概览条已有的数据 ——
 *      资金 / 元件 / 算力原本在「库存」「资金 / 库存」「预估算力」「链上算力 / 元件」
 *      四行里各写一遍，raised 本身就是 bnbPool，与「托管 BNB」同一个变量；
 *   3. 删掉 flow-panel 头部与「下一步」逐字重复的说明段落。
 *
 * 入口：众筹挖矿列表 → 某期「打开工具」→ 弹窗默认就在「合约操作」。
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

const ownerNav = page.locator(".nav-link-main", { hasText: "Owner 工作台" });
if (await ownerNav.count()) {
  await ownerNav.first().click();
  await page.waitForTimeout(2500);
}

const toolBtn = page.locator(".campaign-card .campaign-link", { hasText: "打开工具" }).first();
console.log("「打开工具」按钮存在:", await toolBtn.count() > 0);
if (await toolBtn.count() === 0) {
  console.log("  [跳过] 没有可打开的期次");
  await browser.close();
  process.exit(1);
}
await toolBtn.click();
await page.waitForTimeout(2500);

// 弹窗默认 tab
const activeTab = await page.locator(".sheet-tab.is-on").first().innerText().catch(() => "");
console.log("默认 tab:", JSON.stringify(activeTab.trim()));

const body = page.locator(".sheet-body").first();
const bodyText = await body.innerText().catch(() => "");
const ok = {};

// 1. 红框模块已清除
ok.noOfficialPriceCard = !bodyText.includes("官方元件最新价") && !bodyText.includes("官方市场快照");
console.log("红框「官方元件最新价」已移除:", ok.noOfficialPriceCard);
console.log("  页内仍可出现「官方市价」列:", bodyText.includes("官方市价") || bodyText.includes("市价"));

// 2. 操作卡不再重复顶部概览条的资金 / 元件 / 算力
const billRows = await page.locator(".ops-bill li").allInnerTexts().catch(() => []);
console.log("操作卡信息行:", JSON.stringify(billRows));
ok.billMinimal = billRows.length <= 2
  && !billRows.some((r) => /库存|募集款|资金|元件/.test(r.split("\n")[0]));
console.log("  只保留子状态 / 处理器（无资金元件重复行）:", ok.billMinimal);

// 3. 右栏「链上参数」只放顶部概览条没有的项
const dts = await page.locator(".param-grid dt").allInnerTexts().catch(() => []);
console.log("链上参数键:", JSON.stringify(dts));
ok.paramNoDup = !dts.some((d) => /预估算力|算力|本期元件/.test(d));
console.log("  不再重复算力 / 元件:", ok.paramNoDup);

// 4. 挂单面板头部不再有重复说明段
const panelHeadP = await page.locator(".ops-exec .flow-panel-head p").count().catch(() => 0);
console.log("挂单面板头部说明段数（应为 0）:", panelHeadP);
ok.noDupPanelNote = panelHeadP === 0;
const panelTitle = await page.locator(".ops-exec .flow-panel-head h3").first().innerText().catch(() => "");
console.log("  面板标题:", JSON.stringify(panelTitle));

// 5. 步骤条存在
const steps = await page.locator(".flow-steps li").allInnerTexts().catch(() => []);
console.log("步骤条:", JSON.stringify(steps));

// 5b. 「材料市场 ↗」外链已移除（弹出框内不应再出现该外链）
const marketLink = await page.locator('.sheet a[href*="tapeout.net"]').count().catch(() => 0);
const marketLinkText = bodyText.includes("材料市场 ↗");
console.log("「材料市场 ↗」外链（应为 0）:", marketLink, "| 文案残留:", marketLinkText);
ok.noMarketExternalLink = marketLink === 0 && !marketLinkText;

// 6. 挂买单表单仍可用（这是删卡后「市价」列必须自己扛住的地方）
const quoteCells = await page.locator(".ops-exec .flow-quote").count().catch(() => 0);
console.log("「市价」可点填单元格数:", quoteCells);
const nextHint = await page.locator(".flow-next").first().innerText().catch(() => "");
console.log("下一步:", JSON.stringify(nextHint.trim().slice(0, 80)));

// 7. 挂单表格版式：数字列共用一条右基线、市价与输入框等高
const layout = await page.evaluate(() => {
  const t = document.querySelector(".ops-exec .flow-table-order");
  if (!t) return null;
  const right = (el) => +el.getBoundingClientRect().right.toFixed(1);
  const ths = [...t.querySelectorAll("th")];
  const inputs = [...t.querySelectorAll("input")];
  const quotes = [...t.querySelectorAll(".flow-quote")];
  const val = t.querySelector(".flow-quote-val");
  const btn = t.querySelector(".flow-quote");
  const cellRight = (i) => {
    const td = t.querySelectorAll("tbody tr:first-child td")[i];
    const s = getComputedStyle(td);
    return +(td.getBoundingClientRect().right - parseFloat(s.paddingRight)).toFixed(1);
  };
  return {
    thAlign: ths.map((th) => getComputedStyle(th).textAlign),
    // 表头文字右边界要减掉自身的右内边距（rect.right 是列右沿，不是文字右沿）
    thRight: ths.map((th) => +(right(th) - parseFloat(getComputedStyle(th).paddingRight)).toFixed(1)),
    inputAlign: inputs.map((i) => getComputedStyle(i).textAlign),
    inputRight: inputs.map(right),
    quoteRight: quotes.map(right),
    quoteH: quotes.map((q) => +q.getBoundingClientRect().height.toFixed(1)),
    inputH: inputs.map((i) => +i.getBoundingClientRect().height.toFixed(1)),
    // 右基线：数量列(td 1) / 买价列(td 2) / 市价列(td 3) 的 padding 内边界
    cellRight: [cellRight(1), cellRight(2), cellRight(3)],
    quoteValUnderlined: val ? getComputedStyle(val).textDecorationLine : null,
    quoteEmUnderlined: (() => {
      const em = t.querySelector(".flow-quote em");
      // 祖先若还有 underline，后代 text-decoration:none 也去不掉，所以查按钮本身
      return em ? getComputedStyle(btn).textDecorationLine : null;
    })(),
  };
});
if (!layout) {
  ok.orderLayout = false;
  console.log("挂单表格存在: false");
} else {
  const [qtyRight, priceRight, quoteCellRight] = layout.cellRight;
  ok.numHeadsRight = layout.thAlign.slice(1).every((a) => a === "right");
  ok.numInputsRight = layout.inputAlign.every((a) => a === "right");
  // 表头文字右边界落在同一列的内容内边界上（允许 0.6px 取整误差）
  ok.headOnInputBaseline = Math.abs(layout.thRight[1] - qtyRight) < 0.6 && Math.abs(layout.thRight[2] - priceRight) < 0.6;
  ok.inputsOnBaseline = Math.abs(layout.inputRight[0] - qtyRight) < 0.6 && Math.abs(layout.inputRight[1] - priceRight) < 0.6;
  ok.quoteOnBaseline = layout.quoteRight.every((r) => Math.abs(r - quoteCellRight) < 0.6);
  ok.quoteHeightMatch = layout.quoteH.every((h, i) => Math.abs(h - layout.inputH[i * 2]) < 0.6);
  ok.underlineOnlyValue = layout.quoteValUnderlined === "underline" && layout.quoteEmUnderlined === "none";
  ok.orderLayout = ok.numHeadsRight && ok.numInputsRight && ok.headOnInputBaseline
    && ok.inputsOnBaseline && ok.quoteOnBaseline && ok.quoteHeightMatch && ok.underlineOnlyValue;
  console.log("  数字列表头右对齐:", ok.numHeadsRight, "| 输入框右对齐:", ok.numInputsRight);
  console.log("  表头↔输入框同右基线:", ok.headOnInputBaseline, "| 输入框↔列内边界:", ok.inputsOnBaseline);
  console.log("  市价贴列内边界:", ok.quoteOnBaseline, "(quote", JSON.stringify(layout.quoteRight), "vs 列", quoteCellRight + ")");
  console.log("  市价与输入框等高:", ok.quoteHeightMatch, "(", JSON.stringify(layout.quoteH), "vs", JSON.stringify(layout.inputH[0]), ")");
  console.log("  下划线只划数字:", ok.underlineOnlyValue, "(value", layout.quoteValUnderlined, "/ button", layout.quoteEmUnderlined + ")");
}

await page.screenshot({ path: "scripts/_ops.png", fullPage: false }).catch(() => {});

console.log("\n运行时错误数:", errors.length);
for (const e of errors.slice(0, 10)) console.log("  •", e);

const pass = ok.noOfficialPriceCard && ok.billMinimal && ok.paramNoDup
  && ok.noDupPanelNote && ok.noMarketExternalLink && ok.orderLayout && errors.length === 0;
console.log(pass ? "\n[PASS] 合约操作页简化断言全部通过" : "\n[FAIL] 见上方 false 项");
await browser.close();
process.exit(pass ? 0 : 1);
