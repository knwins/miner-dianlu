/**
 * 版式度量探针：不判断对错，只输出盒模型数字，供对齐/行距修正定位。
 *
 * 量什么：
 *   1. 弹窗是否有横向溢出（scrollWidth > clientWidth）
 *   2. 卡片左右内边距是否被内容顶穿（内容右边界 vs 卡片右边界）
 *   3. 顶部概览条 5 列 dt/dd/small 的 offsetTop 是否一致
 *   4. 左栏 bill / flow-steps / flow-next 的间距与字号
 *   5. 历史交易记录 stats 各列高度是否一致（换行会导致高低不齐）
 *   6. 右栏 param-grid 两列行基线
 */
import { createRequire } from "module";
import { installWallet, OWNER_ADDRESS } from "./mock-wallet.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");

const BASE = process.env.BASE || "http://127.0.0.1:5180";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await installWallet(page, OWNER_ADDRESS);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await page.locator(".nav-link-main", { hasText: "Owner 工作台" }).first().click();
await page.waitForTimeout(2000);
await page.locator(".campaign-card .campaign-link", { hasText: "打开工具" }).first().click();
await page.waitForTimeout(1200);
await page.locator(".sheet-tab", { hasText: "合约操作" }).first().click();
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1) };
  };
  const cs = (el, props) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, s[p]]));
  };
  const res = {};

  const sheet = document.querySelector(".sheet");
  const body = document.querySelector(".sheet-body");
  res.sheet = { box: box(sheet), scrollW: sheet?.scrollWidth, clientW: sheet?.clientWidth };
  res.sheetBody = { box: box(body), scrollW: body?.scrollWidth, clientW: body?.clientWidth };

  // 顶部概览条
  const metrics = document.querySelector(".detail-summary .campaign-metrics");
  res.metrics = {
    box: box(metrics),
    css: cs(metrics, ["paddingLeft", "paddingRight", "gap", "gridTemplateColumns"]),
    cells: [...(metrics?.children || [])].map((d) => {
      const dt = d.querySelector("dt");
      const dd = d.querySelector("dd");
      const sm = d.querySelector("small");
      return {
        label: dt?.textContent?.trim(),
        cell: box(d),
        dt: { ...box(dt), ...cs(dt, ["fontSize", "lineHeight"]) },
        dd: { ...box(dd), ...cs(dd, ["fontSize", "lineHeight", "fontWeight"]) },
        small: sm ? { ...box(sm), ...cs(sm, ["fontSize", "lineHeight"]) } : null,
      };
    }),
  };

  // 左栏卡片
  const card = document.querySelector(".detail-split > .card");
  const cardBody = card?.querySelector(".card-body");
  const cardHead = card?.querySelector(".card-header");
  const bill = card?.querySelector(".bill");
  const billRows = [...(bill?.children || [])];
  res.opsCard = {
    card: box(card),
    css: cs(card, ["padding", "borderWidth"]),
    head: { ...box(cardHead), ...cs(cardHead, ["padding", "borderBottomWidth", "marginBottom"]) },
    body: { ...box(cardBody), ...cs(cardBody, ["padding"]) },
    bill: { ...box(bill), ...cs(bill, ["marginTop", "marginBottom"]) },
    billRows: billRows.map((li) => {
      const label = li.querySelector("span");
      const val = li.querySelector("strong");
      return {
        li: box(li),
        label: { text: label?.textContent?.trim(), ...box(label) },
        value: { text: val?.textContent?.trim(), ...box(val) },
        overRight: card ? +(val ? val.getBoundingClientRect().right - card.getBoundingClientRect().right : 0).toFixed(1) : null,
      };
    }),
    headToBill: cardHead && bill ? +(bill.getBoundingClientRect().top - cardHead.getBoundingClientRect().bottom).toFixed(1) : null,
  };

  // 步骤条 / 下一步 / 面板
  const steps = card?.querySelector(".flow-steps");
  const next = card?.querySelector(".flow-next");
  res.flow = {
    steps: { box: box(steps), ...cs(steps, ["marginTop", "marginBottom", "fontSize"]) },
    stepItems: [...(steps?.children || [])].map((li) => ({ text: li.textContent.trim(), ...box(li), ...cs(li, ["fontSize", "lineHeight", "padding"]) })),
    next: { box: box(next), ...cs(next, ["marginTop", "marginBottom", "fontSize", "lineHeight", "padding"]) },
  };

  const panel = card?.querySelector(".flow-panel");
  const panelHead = panel?.querySelector(".flow-panel-head");
  const table = panel?.querySelector(".flow-table");
  const bar = panel?.querySelector(".flow-form-bar");
  res.panel = {
    panel: { ...box(panel), ...cs(panel, ["padding", "marginTop"]) },
    head: { ...box(panelHead), ...cs(panelHead, ["padding", "marginBottom"]) },
    headH3: (() => { const h = panelHead?.querySelector("h3"); return h ? { ...box(h), ...cs(h, ["fontSize", "lineHeight", "marginTop", "marginBottom"]) } : null; })(),
    table: box(table),
    th: [...(table?.querySelectorAll("th") || [])].map((th) => ({ text: th.textContent.trim(), ...box(th), ...cs(th, ["fontSize", "padding", "textAlign"]) })),
    td: [...(table?.querySelectorAll("tbody tr:first-child td") || [])].map((td) => ({ ...box(td), ...cs(td, ["fontSize", "padding", "textAlign", "verticalAlign"]) })),
    inputs: [...(table?.querySelectorAll("input") || [])].map((i) => ({ ...box(i), ...cs(i, ["fontSize", "padding", "height"]) })),
    quote: [...(table?.querySelectorAll(".flow-quote") || [])].map((q) => ({ ...box(q), ...cs(q, ["fontSize", "lineHeight", "padding"]) })),
    bar: { ...box(bar), ...cs(bar, ["padding", "gap", "marginTop", "flexWrap"]) },
    barSpan: (() => { const s = bar?.querySelector("span"); return s ? { text: s.textContent.trim(), ...box(s), ...cs(s, ["fontSize", "lineHeight"]) } : null; })(),
    panelToBar: panel && bar ? +(bar.getBoundingClientRect().top - table.getBoundingClientRect().bottom).toFixed(1) : null,
  };

  // 右栏
  const right = document.querySelector(".detail-col");
  const rightCards = [...(right?.children || [])];
  res.right = {
    col: { ...box(right), ...cs(right, ["gap"]) },
    cards: rightCards.map((c) => ({ ...box(c), header: c.querySelector(".card-header")?.textContent?.trim() })),
  };
  const params = right?.querySelector(".param-grid");
  res.params = {
    box: box(params),
    css: cs(params, ["gridTemplateColumns", "gap", "rowGap", "columnGap"]),
    rows: [...(params?.children || [])].map((d) => {
      const dt = d.querySelector("dt");
      const dd = d.querySelector("dd");
      return {
        dt: { text: dt?.textContent?.trim(), ...box(dt), ...cs(dt, ["fontSize", "lineHeight"]) },
        dd: { ...box(dd), ...cs(dd, ["fontSize", "lineHeight", "textAlign"]) },
      };
    }),
  };
  const stats = right?.querySelector(".trade-panel-stats");
  res.tradeStats = {
    box: box(stats),
    css: cs(stats, ["gridTemplateColumns", "gap", "alignItems"]),
    cells: [...(stats?.children || [])].map((d) => ({
      label: d.querySelector("span")?.textContent?.trim(),
      cell: box(d),
      span: box(d.querySelector("span")),
      strong: box(d.querySelector("strong")),
      small: box(d.querySelector("small")),
    })),
  };
  const feedEmpty = right?.querySelector(".trade-feed, .flow-empty");
  res.tradeFeed = { box: box(feedEmpty), text: feedEmpty?.textContent?.trim()?.slice(0, 60) };
  const note = right?.querySelector(".trade-panel-note");
  res.tradeNote = note ? { box: box(note), text: note.textContent.trim() } : null;

  return res;
});

console.log(JSON.stringify(out, null, 2));
console.log("运行时错误:", errors.length ? errors : 0);
await browser.close();
