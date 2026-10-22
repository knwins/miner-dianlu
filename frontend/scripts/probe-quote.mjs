/** 探针：官方价合并进 quote 后，测算函数（estimateHashpower / planTask）是否正常。 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright");
const BASE = process.env.BASE || "http://127.0.0.1:5173";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
const r = await page.evaluate(async () => {
  const m = await import("/src/officialPrices.js");
  const p = await import("/src/prices.js");
  const f = await import("/src/fixtures.js");
  const official = await m.fetchOfficialPrices({ force: true });
  const merged = m.officialQuote(p.NOMINAL_QUOTE, official);
  const round = { ...f.ROUND, hardCapBnb: 0.16, totalShares: 2, sharePriceBnb: 0.08, transistorId: "TAPE_OUT_NAND" };
  const est = f.estimateHashpower(round, merged, 2);
  const plan = p.planTask({ parts: 100, transistorId: "TAPE_OUT_NAND", snapshot: merged });
  return {
    ok: official.ok,
    rows: Object.fromEntries(Object.entries(official.prices).map(([k,v])=>[k, {bid:v.bid, last:v.last}])),
    mergedPrices: merged.prices,
    est: { hashpower: est.hashpower, usedParts: est.usedParts, priceBnb: est.priceBnb, priceNand: est.priceNand, priceLatch: est.priceLatch },
    plan: { cost: plan.partsCost, priceNand: plan.priceNand, priceLatch: plan.priceLatch },
    nanCount: Object.values(est).filter(v=>typeof v==="number"&&!Number.isFinite(v)).length,
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
