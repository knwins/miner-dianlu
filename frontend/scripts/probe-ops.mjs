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

// 6. 挂买单表单仍可用（这是删卡后「市价」列必须自己扛住的地方）
const quoteCells = await page.locator(".ops-exec .flow-quote").count().catch(() => 0);
console.log("「市价」可点填单元格数:", quoteCells);
const nextHint = await page.locator(".flow-next").first().innerText().catch(() => "");
console.log("下一步:", JSON.stringify(nextHint.trim().slice(0, 80)));

await page.screenshot({ path: "scripts/_ops.png", fullPage: false }).catch(() => {});

console.log("\n运行时错误数:", errors.length);
for (const e of errors.slice(0, 10)) console.log("  •", e);

const pass = ok.noOfficialPriceCard && ok.billMinimal && ok.paramNoDup
  && ok.noDupPanelNote && errors.length === 0;
console.log(pass ? "\n[PASS] 合约操作页简化断言全部通过" : "\n[FAIL] 见上方 false 项");
await browser.close();
process.exit(pass ? 0 : 1);
