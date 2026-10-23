/**
 * 探针：验证发布页（OwnerCreate）与材料市场页的结构约束，且各页签不白屏。
 *
 * 覆盖的业务事实：
 *   1. 「创建」页签不白屏 —— 自由变量 / TDZ / undefined 访问这三类运行时错误
 *      vite build 都抓不到，只有真跑页面才会暴露。
 *   2. 工厂无默认元件 → 发布表单必须有「本期处理器」必选下拉。
 *   3. 材料市场面板只剩 TapeOut / Behemoth 两个处理器分组，
 *      且**不得**出现 Genesis 或「无挖矿产出」误标。
 *
 * 运行：node scripts/probe-create-page.mjs [port]
 */
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWallet, OWNER_ADDRESS, STRANGER_ADDRESS } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT ||
    "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright",
);

const EXPECT_TITLE = "TapeOut 众筹挖矿";

/**
 * 截图输出目录。
 * ⚠️ 不要写进源码目录：探针跑一次就留一堆 shot-*.png 在 frontend/ 根下，
 * 污染工作区（git status 里全是未跟踪文件）。
 */
const SHOT_DIR = mkdtempSync(join(tmpdir(), "tapeout-probe-"));

async function probe(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
  const html = await res.text();
  if (!html.includes(EXPECT_TITLE)) {
    console.log(`SKIP 端口 ${port} 不是本应用（title 不匹配）`);
    return null;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));

  // T-64：Owner 工作台只对 Owner 展示 → 必须先注入 Owner 钱包，否则进不去。
  await installWallet(page, OWNER_ADDRESS);

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const bodyText = () => page.evaluate(() => document.body.innerText);

  // ── 0. 认购页（BEM众筹挖矿）不再有官方元件最新价模块 ──
  // T-62：认购页删除官方元件最新价模块。市价信息统一在「材料市场」页的
  // 「官方处理器与元件市价」单一模块里查，认购页只留认购本身需要的信息。
  const roundPanel = await page.evaluate(() => {
    const el = document.querySelector(".official-price-card");
    if (!el) return null;
    return {
      groups: el.querySelectorAll(".official-price-group").length,
      cols: el.querySelectorAll("thead th").length,
      rows: el.querySelectorAll("tbody tr").length,
      hasFacts: !!el.querySelector(".market-page-facts"),
    };
  });
  console.log("  认购页面板：", JSON.stringify(roundPanel));
  const roundPanelOk = roundPanel === null;
  console.log(
    `${roundPanelOk ? "ok  " : "FAIL"} 认购页已无官方元件最新价模块${roundPanelOk ? "" : ` （仍存在：${JSON.stringify(roundPanel)}）`}`,
  );

  // ── 1. 侧边栏能进 Owner 工作台 ──
  const navLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button, a")).map((el) => (el.textContent || "").trim()),
  );
  const ownerNav = navLabels.find((t) => t.includes("Owner 工作台"));
  if (!ownerNav) {
    console.log("FAIL 找不到「Owner 工作台」导航项");
    console.log("  可见按钮：", navLabels.slice(0, 30));
    await browser.close();
    return { ok: false, reason: "no-owner-nav" };
  }
  await page.getByText("Owner 工作台", { exact: false }).first().click();
  await page.waitForTimeout(900);

  // ── 2. 进「创建」页签（此前白屏的那条路径）──
  const tabLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".desk-tab, button")).map((el) => (el.textContent || "").trim()),
  );
  const createTab = tabLabels.find((t) => t.includes("创建") || t.includes("发布"));
  if (!createTab) {
    console.log("FAIL 找不到「创建」页签");
    console.log("  可见页签：", tabLabels.filter(Boolean).slice(0, 30));
    await browser.close();
    return { ok: false, reason: "no-create-tab" };
  }
  await page.getByText(createTab, { exact: false }).first().click();
  await page.waitForTimeout(1500);

  const afterCreate = await bodyText();
  const crashed =
    pageErrors.some((m) => /factoryParts|is not defined|Cannot read/i.test(m)) ||
    /Something went wrong|Internal Server Error/i.test(afterCreate);

  if (crashed) {
    console.log("FAIL 「创建」页签崩溃");
    console.log("  pageError:", pageErrors.slice(0, 5));
    await browser.close();
    return { ok: false, reason: "create-crash", pageErrors };
  }

  // ── 3. 工厂无默认元件：发布期**必须**显式选处理器，卡片要存在 ──
  const hasProcessorCard = /处理器（元件合约）/.test(afterCreate);
  console.log(`${hasProcessorCard ? "ok  " : "FAIL"} 「创建」页含处理器选择卡片（工厂无默认元件，开期必选）`);

  // ── 4. 服务费口径文案（挖矿产出）──
  const feeWording = /服务费（挖矿产出）|挖矿产出奖励的服务费|挖矿产出服务费/.test(afterCreate);
  console.log(`${feeWording ? "ok  " : "warn"} 服务费「挖矿产出」口径文案${feeWording ? "" : " 未在创建页出现"}`);

  await page.screenshot({ path: join(SHOT_DIR, "shot-create.png"), fullPage: false });

  // ── 5. 材料市场页：全部官方处理器必须同时出现（合并后的单一模块）──
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const marketNav = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button, a")).map((el) => (el.textContent || "").trim()),
  );
  const marketEntry = marketNav.find((t) => t.includes("材料市场"));
  if (!marketEntry) {
    console.log("FAIL 未找到「材料市场」导航项");
    console.log("  可见导航：", marketNav.filter(Boolean).slice(0, 30));
    await browser.close();
    return { ok: false, reason: "no-market-nav" };
  }
  await page.getByText("材料市场", { exact: false }).first().click();
  // 链上成交价是异步取的：等太短会把「读取中 / —」当成取价失败。
  await page.waitForTimeout(4500);
  const marketText = await bodyText();

  const marketCrashed = pageErrors.some((m) => /is not defined|Cannot read/i.test(m));
  if (marketCrashed) {
    console.log("FAIL 「材料市场」页崩溃");
    console.log("  pageError:", pageErrors.slice(0, 5));
    await browser.close();
    return { ok: false, reason: "market-crash", pageErrors };
  }

  const tapeout = /TapeOut/.test(marketText);
  const behemoth = /Behemoth/.test(marketText);
  console.log(`${tapeout ? "ok  " : "FAIL"} 材料市场 TapeOut${tapeout ? "" : " 缺失"}`);
  console.log(`${behemoth ? "ok  " : "FAIL"} 材料市场 Behemoth${behemoth ? "" : " 缺失"}`);

  // T-59：Genesis CPU 已整体移除，材料市场页**不得**再出现它
  const genesis = /Genesis/.test(marketText);
  console.log(`${genesis ? "FAIL" : "ok  "} 材料市场已无 Genesis${genesis ? " 仍残留" : ""}`);

  // 当前只剩两个处理器，且都有挖矿产出资格，页面上不应出现「无挖矿产出」标记
  const noMineWarn = /无挖矿产出|无产出/.test(marketText);
  console.log(`${noMineWarn ? "FAIL" : "ok  "} 无「无挖矿产出」误标${noMineWarn ? " 误标残留" : ""}`);

  // 两个处理器各自的 NAND / LATCH 单价都应渲染成行情卡里的价格格。
  // ⚠️ 选择器必须精确到「官方元件市价」卡片（.official-price-card）：
  //   - 「各期锁定的元件合约」卡片里也有表格；
  //   - compact 模式的市价面板（开期表单 / Owner 弹窗）也是同一个 class 前缀。
  const priceRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".market-page .official-price-card .official-price-group")).map(
      (g) => ({
        head: (g.querySelector("h4")?.textContent || "").trim(),
        cells: Array.from(g.querySelectorAll(".price-cell")).map((c) => ({
          label: (c.querySelector(".price-cell-label")?.textContent || "").trim(),
          value: (c.querySelector(".price-cell-value")?.textContent || "").trim(),
        })),
        facts: g.querySelectorAll(".market-page-facts li").length,
      }),
    ),
  );
  console.log("  处理器分组：", JSON.stringify(priceRows));
  console.log("  截图目录：", SHOT_DIR);
  // 行情看板形态：每个处理器一张卡 = NAND / LATCH 两个价格格 + 3 条事实（CPU / 元件合约 / 白名单）。
  // 价格必须是有值的数字，不能被兜底成「—」—— 那说明市价没取到。
  const groupsOk =
    priceRows.length === 2 &&
    priceRows.every(
      (g) =>
        g.cells.length === 2 &&
        g.cells.every((c) => /NAND|LATCH/.test(c.label) && /\d/.test(c.value)) &&
        g.facts === 3,
    );
  console.log(`${groupsOk ? "ok  " : "FAIL"} 行情看板：两个处理器 × (NAND/LATCH 单价 + 3 条事实)`);

  // 整合后必须**只剩一个**市价卡片（原先有「官方元件最新价」+「官方处理器对照」两个）
  const cardCount = await page.evaluate(
    () => document.querySelectorAll(".market-page .official-price-card").length,
  );
  const oneCard = cardCount === 1;
  console.log(`${oneCard ? "ok  " : "FAIL"} 材料市场页只有 1 个市价卡片${oneCard ? "" : ` （实际 ${cardCount} 个）`}`);

  await page.screenshot({ path: join(SHOT_DIR, "shot-market.png"), fullPage: true });

  // ── 6. T-64：非 Owner 身份看不到「Owner 工作台」 ──
  // 用一个未持份、非 owner 的地址重新开页，侧边栏必须没有 Owner 工作台。
  const guestPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await installWallet(guestPage, STRANGER_ADDRESS);
  await guestPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await guestPage.waitForTimeout(2000);
  const guestOwnerNav = await guestPage.evaluate(() =>
    Array.from(document.querySelectorAll(".nav-link-main")).some((el) =>
      (el.textContent || "").includes("Owner 工作台"),
    ),
  );
  console.log(
    `${guestOwnerNav ? "FAIL" : "ok  "} 非 Owner 侧边栏不显示「Owner 工作台」${guestOwnerNav ? " 仍显示" : ""}`,
  );
  await guestPage.close();

  // ── 7. 「发布众筹挖矿」表单的业务流程与 UI 约束 ──
  // 这一段锁的是 OwnerCreate 的结构与业务事实，改 UI 时容易被无意破坏：
  //   a) 表单**含**处理器必选下拉（工厂无默认元件，开期人必须显式选）；
  //   b) 表单**不含**建议方案（元件数/算力要到执行阶段才定，发布期给建议值会误导）；
  //   c) 表单**不含**官方市价参考模块（链下 API、只有买单侧，不是承诺）；
  //   d) 步骤编号唯一、顺序 = 真实业务顺序；
  //   e) 底部提交条不能吸底（sticky 会遮住分成地址行——那是要签名的参数）；
  //   f) 提交区**不再**出现「两笔交易」的长说明。
  const formPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await installWallet(formPage, OWNER_ADDRESS);
  await formPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30; i += 1) {
    await formPage.waitForTimeout(1000);
    const txt = await formPage.locator("body").innerText();
    if (!txt.includes("读取中…") && !txt.includes("request timeout")) break;
  }
  await formPage.locator(".nav-sub", { hasText: "发布众筹挖矿" }).first().click();
  await formPage.waitForTimeout(1500);

  const formTextEarly = await formPage.locator(".publish-form").innerText();
  // 处理器必选：断言看**控件**（select 数量 + 选项文本），不只看文案。
  const partsSelectCount = await formPage.locator(".publish-form select").count();
  const hasProcessor =
    partsSelectCount >= 1 &&
    formTextEarly.includes("本期处理器") &&
    formTextEarly.includes("开期必选");
  console.log(`${hasProcessor ? "ok  " : "FAIL"} 表单含处理器必选下拉（工厂无默认元件）`);
  const noSuggestion =
    !formTextEarly.includes("建议方案") &&
    !formTextEarly.includes("恢复建议") &&
    !formTextEarly.includes("已跟随") &&
    !formTextEarly.includes("预计元件数") &&
    !formTextEarly.includes("预计权重");
  console.log(`${noSuggestion ? "ok  " : "FAIL"} 表单不含建议方案（无元件数/算力预估）`);
  const noOfficialPrice =
    !formTextEarly.includes("官方市价参考") &&
    !formTextEarly.includes("报价快照") &&
    // 单件上限卡里不再有「NAND x.xx · LATCH x.xx」这种市价行
    !/NAND \d+\.\d+ · LATCH/.test(formTextEarly);
  console.log(`${noOfficialPrice ? "ok  " : "FAIL"} 表单不含官方市价参考模块`);

  const stepLabels = await formPage.evaluate(() =>
    Array.from(document.querySelectorAll(".publish-grid > .card .card-header")).map((el) => ({
      title: (el.children[0]?.textContent || "").trim(),
      step: (el.children[1]?.textContent || "").trim(),
    })),
  );
  // T-69：删掉「单件价格上限」整卡后，表单收敛为三张卡：
  // 发行规模 → 募集天数 → 本期处理器 → 挖矿产出服务费与分成（顺序即业务依赖顺序）。
  // 卡片右侧标签**不带**「第N 步」编号（用户要求简化表述），这里只锚定业务事实：卡的顺序与标题。
  const orderOk =
    stepLabels.length === 4 &&
    stepLabels[0]?.title.includes("发行规模") &&
    stepLabels[1]?.title.includes("募集天数") &&
    stepLabels[2]?.title.includes("本期处理器") &&
    stepLabels[3]?.title.includes("挖矿产出服务费");
  console.log(
    `${orderOk ? "ok  " : "FAIL"} 四卡顺序：发行规模 → 募集天数 → 本期处理器 → 挖矿产出服务费`,
  );
  if (!orderOk) console.log("实际：", JSON.stringify(stepLabels));

  // 步骤编号必须已从 UI 移除
  const noStepLabels = stepLabels.every((c) => !/^第[一二三四五六七八九十]步/.test(c.step || ""));
  console.log(`${noStepLabels ? "ok  " : "FAIL"} 卡片标签无「第 N 步」编号`);

  const submitPos = await formPage
    .locator(".publish-submit")
    .evaluate((el) => getComputedStyle(el).position);
  const stickyOk = submitPos !== "sticky" && submitPos !== "fixed";
  console.log(
    `${stickyOk ? "ok  " : "FAIL"} 提交条不吸底（当前 ${submitPos}），不会遮挡分成地址行`,
  );

  // 分成地址行必须完整可见：取最后一个地址输入框的底边，与提交条顶边比较
  const lastAddrBox = await formPage
    .locator(".fee-share-block .fee-share-row:not(.is-head) .mono")
    .last()
    .boundingBox();
  const submitBox = await formPage.locator(".publish-submit").boundingBox();
  const addrVisible = Boolean(lastAddrBox && submitBox && lastAddrBox.y + lastAddrBox.height <= submitBox.y + 1);
  console.log(`${addrVisible ? "ok  " : "FAIL"} 分成地址行未被提交条遮挡`);

  const formText = await formPage.locator(".publish-form").innerText();
  const noTwoTxNote =
    !formText.includes("两笔交易") &&
    !formText.includes("createCampaign") &&
    !formText.includes("setServiceFee");
  console.log(`${noTwoTxNote ? "ok  " : "FAIL"} 提交区已无「两笔交易」说明`);
  // T-69：单件价格上限整卡已从合约与前端彻底移除（限制单件价格会导致买不到元件）。
  const noPriceCap =
    !formText.includes("单件价格上限") &&
    !formText.includes("每件上限") &&
    !formText.includes("单件上限") &&
    !formText.includes("单件不限价");
  console.log(`${noPriceCap ? "ok  " : "FAIL"} 表单不含单件价格上限（已整体移除）`);

  // T-69 子任务 2：术语改为「挖矿产出服务费」，且那段解释性文字不得再出现在 UI 上。
  const feeTermOk = formText.includes("挖矿产出服务费");
  console.log(`${feeTermOk ? "ok  " : "FAIL"} 使用术语「挖矿产出服务费」`);
  const noFeeNote =
    !formText.includes("从矿池收益里计提") &&
    !formText.includes("收款方自己") &&
    !formText.includes("费率与分成表上链后任何人可读");
  console.log(`${noFeeNote ? "ok  " : "FAIL"} 已删除服务费解释性那段文字`);

  await formPage.screenshot({ path: join(SHOT_DIR, "shot-create-form.png"), fullPage: true });
  await formPage.close();

  console.log("\n--- console error ---");
  console.log(errors.length ? errors.slice(0, 10).join("\n") : "（无）");
  console.log("--- pageerror ---");
  console.log(pageErrors.length ? pageErrors.slice(0, 10).join("\n") : "（无）");

  await browser.close();
  return {
    ok:
      hasProcessorCard &&
      !crashed &&
      tapeout &&
      behemoth &&
      !genesis &&
      !noMineWarn &&
      groupsOk &&
      oneCard &&
      roundPanelOk &&
      !guestOwnerNav &&
      hasProcessor &&
      noSuggestion &&
      noOfficialPrice &&
      orderOk &&
      noStepLabels &&
      stickyOk &&
      addrVisible &&
      noTwoTxNote &&
      noPriceCap &&
      feeTermOk &&
      noFeeNote,
    pageErrors,
    errors,
  };
}

const port = Number(process.argv[2] || 5173);
probe(port)
  .then((r) => {
    if (!r) process.exit(0);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
