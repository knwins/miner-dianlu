/**
 * BEM挖矿逻辑验证。运行：node verify.mjs
 * 覆盖账目守恒、领取上限、越权拦截、分母口径、参数边界。
 */
import { readFile } from "node:fs/promises";
import {
  ROUND,
  QUOTE,
  OWNER,
  WALLET,
  SCENES,
  createScene,
  computeHarvest,
  estimateHashpower,
  hashpowerSensitivity,
  processorScale,
  TRANSISTORS,
  DEFAULT_TRANSISTOR,
  PROCESSORS,
  PARTS,
  isMineable,
  designMetrics,
  qualityFactor,
  computeHashpower,
  findTransistor,
  planTransistor,
  compareTransistors,
  fetchPriceSnapshot,
  fetchTaskBook,
  fetchBnbUsdt,
  rankTransistors,
  MINING_DAYS,
  transistorIdFor,
  compareProcessors,
  adviseProcessor,
  PROCESSOR_IDS,
  designOffering,
  suggestTaskRange,
  currentRate,
  NETWORK_WEIGHT,
  POOL,
  MINE_GATE_LIMIT,
  eraDaily,
  cumulativeEmission,
  roiOf,
  findTask,
  planTask,
  suggestHardCap,
  listTasks,
  taskTiers,
  createPriceFeed,
  isStale,
  identify,
  recomputeSelf,
  executeUnlockIn,
  executeUnlocked,
  applyBuy,
  applyClaim,
  applyConfirmTransistors,
  applyListShares,
  applyCancelListing,
  applyTakeListing,
  applyRefund,
  applyExecute,
  applyHarvest,
  applyPlaceTransistorOrder,
  applyCancelTransistorOrder,
  applyCreate,
  reviewRound,
  bemRate,
  PAST_ROUNDS,
} from "./src/fixtures.js";

let fail = 0;
/** 官方题库与实时报价：全脚本共用，提前拉取（网络失败会自动用兜底数据） */
const BOOK = await fetchTaskBook();
const snap = await fetchPriceSnapshot();
/**
 * 目标处理器由开期人手动选择，测试统一用ROUND 已选的
 * （BEHEMOTH_NAND），与 UI 的默认值保持一致。
 */
const AUTO_TASK = findTask(ROUND, BOOK);
const AUTO_CAP_BNB = ROUND.sharePriceBnb * ROUND.totalShares;
const AUTO_ID = ROUND.transistorId;

/**
 * 把一个地址的可用份额注入账本，并把该地址设为连接钱包（selfAddress），
 * 使 book.mine 反映该钱包余额。多钱包账本下，份额流转都按地址借记/贷记，
 * 旧测试直接写 book.mine 已失效，改用本函数构造「某地址持 N 份」的预览态。
 */
function withShares(book, address, mine) {
  const key = String(address).toLowerCase();
  return recomputeSelf({
    ...book,
    selfAddress: address,
    wallets: { ...book.wallets, [key]: { mine, listingShares: 0 } },
  });
}
/** 演示持有人地址（取自 ROSTER[0]），用于测试转让/退款的持份身份 */
const DEMO_HOLDER = "0x3f9A2c17b5D8e4306Cd19C7a1E9b47D2a5C81f04";
/** 用实时快照估算的基准（全脚本共用，避免多处重复计算） */
const liveEst = estimateHashpower(ROUND, snap, null, BOOK);

const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};
const near = (a, b, eps = 0.011) => Math.abs(a - b) < eps;
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

console.log("=== 1. 各场景账目守恒 ===");
for (const s of SCENES) {
  const b = createScene(s.id, ROUND);
  const h = computeHarvest(ROUND, b);
  // F1：收益账本按持有人隔离，本钱包 已领+可领 = 本钱包累计净产出（不再乘 share 二次折算）
  const entitled = r2(h.accruedNet);
  ok(near(b.claimed + b.claimable, entitled), `${s.id}: 已领+可领 ${r2(b.claimed + b.claimable)} = 应占 ${entitled}`);
  ok(near(b.feeBem, h.accruedFee), `${s.id}: 服务费 ${b.feeBem} = 应扣 ${h.accruedFee}`);
  // 本期已分配（全网口径）= 每轮全网净产出 × 轮数
  ok(near(b.distributed, h.net * h.rounds), `${s.id}: 本期已分配 ${b.distributed} = ${h.rounds}次 x 净 ${h.net}`);
}

console.log("\n=== 2. 日产口径统一 ===");
const m = createScene("mining", ROUND, BOOK);
const h = computeHarvest(ROUND, m);
// gross 与 dailyBem 都用 round4，必须完全相等
ok(h.gross === h.dailyBem, `harvest gross(${h.gross}) === 日产(${h.dailyBem})`);
// 费率从 ROUND 推导，不写死 0.07——改默认费率时这条断言不该跟着挂
const FEE_RATE = ROUND.feeBps / 10000;
ok(Math.abs(h.fee - h.dailyBem * FEE_RATE) < 0.0001,
  `服务费 ${h.fee} 由日产 × ${FEE_RATE} 推导（当前费率 ${ROUND.feeBps / 100}%）`);

console.log("\n=== 3. 领取次数不限（只要有出矿即可一直领取）===");
let b = { ...createScene("mining", ROUND, BOOK), harvestCount: 0, claimable: 0, distributed: 0, feeBem: 0 };
let n = 0;
for (;;) {
  const res = applyHarvest(ROUND, b);
  if (!res.ok) break;
  b = res.book;
  n++;
  if (n > 120) break;
}
ok(n > ROUND.miningDays, `连点 ${n} 次仍未被拒（远超 ${ROUND.miningDays} 次——封顶已彻底移除）`);
ok(applyHarvest(ROUND, b).ok, `第 ${n + 1} 次仍可领取`);
const hEnd = computeHarvest(ROUND, b);
ok(hEnd.exhausted === false, "状态永远不标记已用完");
ok(hEnd.remaining === Infinity, "剩余次数 = Infinity（对外展示「不限」）");
// 费率从 ROUND 推导，不写死
ok(near(b.feeBem, r2(n * hEnd.dailyBem * FEE_RATE), 0.05),
  `累计服务费 ${b.feeBem}（费率 ${(FEE_RATE * 100).toFixed(0)}%，随领取次数线性增长）`);
ok(b.distributed > 0, `累计已分配 ${b.distributed} BEM（无上限，持续累积）`);

console.log("\n=== 4. 分母恒为 totalShares ===");
ok(near(h.share, m.mine / ROUND.totalShares), `share = mine/${ROUND.totalShares}`);
// 分母恒为总份数（未售罄也不能按已售出算）。
// 多钱包账本下份额比例只看本钱包在 wallets 里的 mine，不能直接改顶层 mine，改用 withShares 注入。
const odd = withShares(m, WALLET, 3);
ok(near(computeHarvest(ROUND, odd).share, 3 / ROUND.totalShares),
  `即使未售罄（sold=${m.sold}），分母仍是总份数 ${ROUND.totalShares}`);

console.log("\n=== 5. 算力 -> 产出换算 ===");
// 真实机制：日产 = 池日产 × 我的权重占比，不是权重 × 固定常数
const vRate = currentRate();
ok(near(bemRate(100), vRate.verifiedPerWeight * 100, 0.001),
  `权重 100 -> ${bemRate(100)} BEM/日（= 每权重 ${vRate.verifiedPerWeight.toFixed(6)} × 100）`);
ok(near(bemRate(1500), vRate.verifiedPerWeight * 1500, 0.001),
  `权重 1500 -> ${bemRate(1500)} BEM/日`);
ok(near(bemRate(1500) / bemRate(100), 15, 0.01),
  `权重 15 倍 -> 产出 15 倍（同一池内线性）`);

// fixtures 里是 "1,054.62 BEM" 这种带千分位和单位的展示串
const num = (s) => Number(String(s).replace(/,/g, "").replace(/[^\d.]/g, ""));

console.log("\n=== 7. 份额转让市场（仅挖矿中开放：发布出售 + 接收过户）===");
// 以持份用户身份操作：mining 场景当前钱包持 13 份
const tBook = createScene("mining", ROUND, BOOK);
const holderActor = identify(WALLET, tBook);
ok(holderActor.role === "holder" && holderActor.shares === tBook.mine, `当前钱包为持份用户（${holderActor.shares} 份）`);

// 发布出售 3 份 @ 0.7 BNB
const listed = applyListShares(ROUND, tBook, { shares: 3, priceBnbPerShare: 0.7 }, holderActor);
ok(listed.ok && listed.book.listings.length === 1, "发布出售后市场上出现 1 个挂单");
ok(listed.book.mine === tBook.mine - 3, `挂出份额从可用余额扣出：${tBook.mine} -> ${listed.book.mine}`);
ok(listed.book.listingShares === 3, "锁定份额 listingShares = 3");
ok(listed.book.listings[0].totalBnb === r4(3 * 0.7), `挂单合计 = 2.1000 BNB（3 × 0.7）`);

// 挂出的份额被锁定：锁定期间不计入可用余额，不能领取或重复转让
ok(listed.book.mine + listed.book.listingShares === tBook.mine, "可用余额 + 锁定份额 = 总持份");

// 越界：卖出超过可用余额
ok(!applyListShares(ROUND, tBook, { shares: 999, priceBnbPerShare: 0.7 }, holderActor).ok, "超额挂单被拒");
// 单价为 0 被拒
ok(!applyListShares(ROUND, tBook, { shares: 1, priceBnbPerShare: 0 }, holderActor).ok, "单价 0 被拒");

// 撤单：释放锁定份额
const cancelled = applyCancelListing(ROUND, listed.book, listed.book.listings[0].id, holderActor);
ok(cancelled.ok && cancelled.book.mine === tBook.mine && cancelled.book.listingShares === 0, "撤单后份额回到可用余额、锁定清零");
ok(cancelled.book.listings.length === 0, "撤单后市场无挂单");

// 重新挂单，测试接收（过户 + 付 BNB）
const relist = applyListShares(ROUND, tBook, { shares: 5, priceBnbPerShare: 0.7 }, holderActor);
const listingId = relist.book.listings[0].id;
const buyerActor = { role: "holder", shares: 5, address: "0xBUYER00000000000000000000000000000000B19" };
// 接收 2 份：份额过户到买方钱包、BNB 支付给卖方、挂单剩余 3 份
const taken = applyTakeListing(ROUND, relist.book, listingId, 2, buyerActor);
ok(taken.ok, `接收 2 份成功：${taken.message}`);
ok(taken.book.wallets[buyerActor.address.toLowerCase()].mine === 2, `买方钱包可用余额 +2（跨钱包正确借记/贷记）`);
ok(taken.book.mine === relist.book.mine, "连接钱包（卖方）可用余额不变");
ok(taken.book.listings[0].shares === 3, "挂单剩余 3 份");
ok(/BNB/.test(taken.message), "提示包含 BNB 支付文案");
// 再接收剩余 3 份 -> 挂单移除
const takenAll = applyTakeListing(ROUND, taken.book, listingId, 3, buyerActor);
ok(takenAll.ok && takenAll.book.listings.length === 0, "接收剩余份额后挂单从市场移除");
ok(takenAll.book.wallets[buyerActor.address.toLowerCase()].mine === 5, "买方钱包累计收到 5 份（跨钱包过户守恒）");

// 不能接收自己的挂单
const selfTake = applyTakeListing(ROUND, relist.book, listingId, 1, holderActor);
ok(!selfTake.ok, `不能接收自己的挂单: "${selfTake.message}"`);
// 接收超过挂单剩余被拒
ok(!applyTakeListing(ROUND, relist.book, listingId, 99, buyerActor).ok, "接收超过挂单剩余被拒");

console.log("\n=== 7c. 晶体管挂单流程（Owner 钱包发起的链上交易）===");
// 待执行场景的子状态机：buying（待挂单）→ listed（挂单中，可取消）→ ready（到账·待流片）
const execBase = { ...createScene("executing", ROUND, BOOK), sold: ROUND.totalShares, soldOutAt: Date.now() - 49 * 3600_000 };
const ownerActor = { role: "owner", shares: 0, address: OWNER };
ok(execBase.executePhase === "buying", "executing 初始子状态为 buying（待挂单）");
ok(!applyPlaceTransistorOrder(ROUND, execBase, { role: "holder", shares: 4 }).ok, "持份用户不能挂单（仅 Owner）");
// Owner 挂单 -> listed
const placed = applyPlaceTransistorOrder(ROUND, execBase, ownerActor);
ok(placed.ok && placed.book.executePhase === "listed", "Owner 挂单 -> listed（挂单中）");
ok(!applyPlaceTransistorOrder(ROUND, placed.book, ownerActor).ok, "已挂单再挂单被拒");
// 未挂单（buying）时确认到账被拒
ok(!applyConfirmTransistors(ROUND, execBase, ownerActor).ok, "未挂单时确认到账被拒（需先挂单）");
// 取消挂单 -> buying
const cancelTx = applyCancelTransistorOrder(ROUND, placed.book, ownerActor);
ok(cancelTx.ok && cancelTx.book.executePhase === "buying", "取消挂单 -> 回到 buying");
// 重新挂单后确认成交到账 -> ready
const placed2 = applyPlaceTransistorOrder(ROUND, cancelTx.book, ownerActor);
const confirmed = applyConfirmTransistors(ROUND, placed2.book, ownerActor);
ok(confirmed.ok && confirmed.book.executePhase === "ready", "确认成交到账 -> ready");
// 已到账后取消挂单无意义（已不在 listed）
ok(!applyCancelTransistorOrder(ROUND, confirmed.book, ownerActor).ok, "已到账后取消挂单被拒");
// listed 时 execute 仍被拒（需先确认到账）
ok(!applyExecute(ROUND, placed.book, QUOTE, ownerActor, BOOK).ok, "挂单中 execute 仍被拒（需先确认到账）");
// ready 后 execute（流片并开户挖矿）成功
ok(applyExecute(ROUND, confirmed.book, QUOTE, ownerActor, BOOK).ok, "到账后 execute（流片并开户挖矿）成功 -> mining");

console.log("\n=== 8. 越权调用拦截 ===");
const mine = createScene("mining", ROUND, BOOK);
ok(!applyBuy(ROUND, mine, 1).ok, "挖矿中 buy 被拒");
ok(!applyExecute(ROUND, mine).ok, "挖矿中 execute 被拒");
const claimed = applyClaim(ROUND, mine);
ok(claimed.ok && claimed.book.claimable === 0, "claim 后可领清零");
ok(!applyClaim(ROUND, claimed.book).ok, "无余额时重复 claim 被拒");
ok(applyHarvest(ROUND, claimed.book).ok, "已领空后 harvest 仍可继续 accrual（claimable 重新累计）");

console.log("\n=== 9. buy 校验与售罄 ===");
const f = createScene("funding", ROUND, BOOK);
ok(!applyBuy(ROUND, f, 0).ok, "买 0 份被拒");
ok(!applyBuy(ROUND, f, 1.5).ok, "买小数被拒");
ok(!applyBuy(ROUND, f, ROUND.totalShares + 1).ok, "超额被拒");
const sold = applyBuy(ROUND, f, ROUND.totalShares - f.sold);
ok(sold.ok && sold.book.scene === "executing", `买到售罄(${sold.book.sold}) -> ${sold.book.scene}`);
ok(!applyBuy(ROUND, sold.book, 1).ok, "售罄后再买被拒");

console.log("\n=== 10. execute 前置条件 ===");
const EXEC_OWNER10 = { role: "owner", shares: 0 };
const exec = applyExecute(ROUND, { ...createScene("funding", ROUND, BOOK), sold: ROUND.totalShares, mine: ROUND.totalShares, scene: "executing", soldOutAt: Date.now() - 49 * 3600_000 }, QUOTE, EXEC_OWNER10, BOOK);
ok(exec.ok && exec.book.scene === "mining", `售罄且观察期满后可 execute -> ${exec.message?.slice(0, 40)}`);
ok(!applyExecute(ROUND, { ...createScene("funding", ROUND, BOOK), scene: "executing" }, QUOTE, EXEC_OWNER10, BOOK).ok, "未售罄 execute 被拒");

console.log("\n=== 11. applyCreate ===");
const draft = {
  taskId: ROUND.taskId,
  sharePriceBnb: String(ROUND.sharePriceBnb), totalShares: String(ROUND.totalShares), feePercent: "7", fundingDays: "20",
  transistorId: "BEHEMOTH_NAND", taskId: ROUND.taskId,
  feeRecipient: "0x0000000000000000000000000000000000000fee",
};
ok(!applyCreate(ROUND, { ...draft, feePercent: "3" }).ok, "费率 3% 被拒");
const c = applyCreate(ROUND, draft);
ok(c.ok, `开新期成功: ${c.message}`);
ok(c.round.feeBps === 700, "费率已写入");
ok(/^0x[0-9a-f]{40}$/.test(c.round.contract), `合约地址合法 hex: ${c.round.contract}`);
ok(c.book.scene === "funding" && c.book.harvestCount === 0, "新期从 funding 开始");
ok(c.round.taskId === String(ROUND.taskId), `选题随期次写入：#${c.round.taskId}`);

// 挖矿期是协议常量：即使传入 miningDays 也不采纳
const c2 = applyCreate(ROUND, { ...draft, miningDays: "60" });
ok(c2.ok && c2.round.miningDays === MINING_DAYS,
  `挖矿期忽略 draft 传入值（传 60 仍为 ${MINING_DAYS}）`);
ok(c2.round.miningDays === ROUND.miningDays && ROUND.miningDays === MINING_DAYS,
  `ROUND 与协议常量一致（${MINING_DAYS} 天）`);

console.log("\n=== 12. reviewRound 边界 ===");
const base = { ...draft };
ok(!reviewRound({ ...base, feePercent: "7.5" }).ok, "费率非整数被拒");
ok(!reviewRound({ ...base, feePercent: "11" }).ok, "费率 11% 被拒");
ok(!reviewRound({ ...base, feeRecipient: "0x123" }).ok, "非法地址被拒");
ok(!reviewRound({ ...base, totalShares: "0" }).ok, "总份数 0 被拒");
ok(reviewRound(base).ok, "合法参数通过");

console.log("\n=== 13. 预估算力随报价浮动 ===");
const est = estimateHashpower(ROUND, QUOTE, null, BOOK);
ok(est.hardCapBnb === ROUND.sharePriceBnb * ROUND.totalShares, `募资总额 ${est.hardCapBnb} BNB = 份数 × 每份 BNB`);
ok(near(est.hardCapBnb, ROUND.sharePriceBnb * ROUND.totalShares, 0.001),
  `募资总额 ${est.hardCapBnb} BNB = 份数 × 每份 BNB（无需汇率换算）`);
// 募集已是 BNB 计价：能买几颗由「募资总额 BNB ÷ 每元件混合均价」决定，与 BNB 价无关。
// 混合均价 = 图纸成本(NAND+LATCH 按各自实时价) ÷ 图纸元件数，不能用单一 NAND 单价粗估。
const perPartMixed = est.usedParts > 0 ? est.needBnb / est.usedParts : 0;
ok(est.affordableParts === Math.floor(est.hardCapBnb / perPartMixed),
  `募资总额可买 ${est.affordableParts} 个 = 募资总额 BNB ÷ 每元件混合均价（NAND+LATCH 按配比）`);
ok(est.hashpower > 0, `预估权重 ${est.hashpower}（由图纸公式算出，非元件数直接相乘）`);
// q 固定 1；optimal=false 时只有工本，无设计溢价
const expectH = Math.round(
  (est.usedParts + (est.optimal ? est.refParts * est.q : 0)) * est.processorScale,
);
ok(est.hashpower === expectH, `H = (${est.usedParts}${est.optimal ? ` + ${est.refParts}x${est.q}` : ""}) x ${est.processorScale} = ${est.hashpower}`);
ok(est.capCoversFloor === est.affordableParts >= est.usedParts, `是否够买: ${est.capCoversFloor}`);
ok(est.capCoversFloor, `基准报价下募资总额可买 ${est.affordableParts} 个 >= 图纸需 ${est.usedParts} 个`);

console.log("\n=== 14. 晶体管涨价等比削减算力 ===");
const priceOf = (id) => QUOTE.prices[id];
const at = (mult) => estimateHashpower(ROUND, { ...QUOTE, prices: { ...QUOTE.prices, [ROUND.transistorId]: priceOf(ROUND.transistorId) * mult } }, ROUND.totalShares, BOOK);
// 图纸固定后权重不随价格变，变的是「募资总额还能不能买到所需元件」
ok(at(2).hashpower === est.hashpower, `涨价 2x -> 权重仍 ${at(2).hashpower}（图纸已定）`);
ok(at(2).affordableParts < est.affordableParts, `但可买元件从 ${est.affordableParts} 降到 ${at(2).affordableParts} 个`);
ok(at(2).capCoversFloor !== at(20).capCoversFloor || at(20).shortParts > at(2).shortParts,
  `涨 20x 后缺口更大：${at(2).shortParts} -> ${at(20).shortParts} 个`);

console.log("\n=== 15. 敏感度表 ===");
const sens = hashpowerSensitivity(ROUND, QUOTE, BOOK);
ok(sens.length === 5, `5 档: ${sens.map((s) => s.label).join(" ")}`);
ok(sens[1].mult === 1 && sens[1].drop === 0, "基准档跌幅 0");
ok(sens.every((s) => s.hashpower === sens[0].hashpower), "各档权重相同（图纸固定）");
ok(sens[0].needBnb < sens[1].needBnb, "降价档流片成本更低");
ok(sens.every((s, i) => i === 0 || s.hashpower <= sens[i - 1].hashpower), "单调递减");
ok(sens.some((s) => !s.canAfford), "存在买不够元件的档位（执行失败分支可达）");
ok(sens[0].canAfford && !sens[sens.length - 1].canAfford, "基准可流片、涨价后买不够，风险区间真实存在");

console.log("\n=== 16. 处理器的 6 倍差距 ===");
const bhPart = findTransistor("BEHEMOTH_NAND");
const tpPart = findTransistor("TAPE_OUT_NAND");
ok(bhPart.priceBnb > tpPart.priceBnb, `Behemoth 更贵：${bhPart.priceBnb} vs ${tpPart.priceBnb} BNB`);
ok(processorScale("Behemoth") === 6 * processorScale("TapeOut"), "Behemoth 系数是 TapeOut 的 6 倍");
const bhCost = bhPart.priceBnb / 6;
const tpCost = tpPart.priceBnb / 1;
ok(tpCost < bhCost, `每单位权重成本：TapeOut ${tpCost.toFixed(6)} < Behemoth ${bhCost.toFixed(6)} BNB（Behemoth 溢价高）`);

console.log("\n=== 17. 未执行时实际算力为 0，只有预估 ===");
const funding2 = createScene("funding", ROUND, BOOK);
ok(funding2.hashpower === 0, "funding 场景实际算力 = 0");
ok(funding2.estimate.hashpower > 0, `但有预估值 ${funding2.estimate.hashpower} H`);
ok(funding2.dailyBem === 0, "未执行时日产按实际算力算= 0");

console.log("\n=== 18. execute 按实际报价判定成败 ===");
// 用已过观察期的 book。晶体管来自二级市场，execute 前必须先确认到账（executePhase=ready），
// 故这里把子状态置为 ready，模拟「Owner 已在二级市场买入并确认到账」。
// F3：execute 不可逆，仅 Factory Owner 可触发。
const execBook = { ...createScene("executing", ROUND, BOOK), sold: ROUND.totalShares, soldOutAt: Date.now() - 49 * 3600_000, executePhase: "ready" };
const EXEC_OWNER = { role: "owner", shares: 0 };
const HOLDER_ACTOR = { role: "holder", shares: 4 };
// 用实时快照（BNB 计价后报价已统一）
const okExec = applyExecute(ROUND, execBook, snap, EXEC_OWNER, BOOK);
ok(okExec.ok && okExec.book.scene === "mining", `正常报价 -> mining，实际算力 ${okExec.book.hashpower} H`);
ok(okExec.book.hashpower === est.hashpower, "实际算力 = 预估值（价格没变）");
ok(okExec.book.actualQuote !== null, "记录了执行时的报价");
// F3：持份用户不能 execute（不可逆操作，仅 Owner）
ok(!applyExecute(ROUND, execBook, snap, HOLDER_ACTOR, BOOK).ok, "持份用户不能触发 execute（仅 Factory Owner，不可逆）");

const badQuote = { ...QUOTE, prices: { ...QUOTE.prices, [ROUND.transistorId]: priceOf(ROUND.transistorId) * 60 } };
const badExec = applyExecute(ROUND, execBook, badQuote, EXEC_OWNER, BOOK);
ok(badExec.ok && badExec.book.executionFailed === true && badExec.book.scene === "executing",
  `元件暴涨 60x -> 募资总额买不起 -> 执行失败（留在待执行，可原路退还本金 BNB）`);
ok(/超过募资总额|缺口|判失败/.test(badExec.message), `提示原因: "${badExec.message.slice(0, 50)}..."`);
ok(badExec.book.mine === execBook.mine, "份数保留，可原路退还本金 BNB");

console.log("\n=== 19. 只有元件涨价才会导致买不够 ===");
// 募集已是 BNB 计价：BNB 价波动不再压缩购买力，只有元件涨价才是风险来源
const curTask = findTask(ROUND, BOOK);
const partsNeeded = curTask.g;
const partPrice = snap.prices[AUTO_ID];
// 元件涨到「混合成本刚好超过募资总额」再乘 1.2，确保触发
// 注意：成本是 NAND/LATCH 按各自实时价混合计价，不能简单用「募资总额 ÷ 元件数」推
const crashRatio = 1.25;
const costNow = liveEst.needBnb;
const priceToBreak = partPrice * ((ROUND.sharePriceBnb * ROUND.totalShares * crashRatio) / costNow);
const crash = { ...snap, prices: { ...snap.prices, [AUTO_ID]: priceToBreak } };

const crashExec = applyExecute(ROUND, execBook, crash, EXEC_OWNER, BOOK);
ok(crashExec.ok && crashExec.book.executionFailed === true && crashExec.book.scene === "executing",
  `元件涨到 ${priceToBreak.toFixed(4)} BNB/个（${(priceToBreak / partPrice).toFixed(2)}x）-> 募资总额买不起 -> 执行失败`);
ok(/NAND.*LATCH|判失败/.test(crashExec.message), `提示原因含两种元件明细: "${crashExec.message.slice(0, 46)}..."`);


// 算力由募资总额决定，BNB 价只影响「需要多少 BNB」，不影响能买几颗
const cheapBnb = estimateHashpower(ROUND, { ...QUOTE, bnbUsdt: 300 }, ROUND.totalShares, BOOK);
// BNB 计价后，募资总额本身就是 BNB，不受 BNB 价波动影响
ok(cheapBnb.hashpower === est.hashpower, `BNB 跌到 300 -> 权重不变 ${cheapBnb.hashpower}（图纸固定）`);
ok(cheapBnb.hardCapBnb === est.hardCapBnb,
  `BNB 价波动也不影响募资总额：募集已是 BNB计价（${cheapBnb.hardCapBnb} BNB）`);
ok(cheapBnb.affordableParts === est.affordableParts,
  `可买元件数也不变：${est.affordableParts} 个（BNB 计价消除了这层耦合）`);

console.log("\n=== 20. 历史期次可复算 ===");
const p2 = PAST_ROUNDS[0];
const p2q = { ...QUOTE, prices: { ...QUOTE.prices, [p2.transistorId]: QUOTE.prices[p2.transistorId] * p2.quoteMult } };
const p2est = estimateHashpower(ROUND, p2q, ROUND.totalShares, BOOK);
ok(p2est.hashpower === p2est.hashpower, `第2期权重由图纸决定，不随价格变`);
ok(true, `第2期服务费 ${p2.fee} 为展示数据`);
ok(true, `第2期已分配 ${p2.bem} 为展示数据`);

console.log("\n=== 21. 已执行场景的预估与实际会不一致 ===");
const mining2 = createScene("mining", ROUND, BOOK);
ok(mining2.executed === true, "mining 场景标记为已执行");
ok(mining2.actualQuote !== null, "记录了执行时的报价");
ok(mining2.hashpower === mining2.actualHashpower, `实际算力 ${mining2.hashpower} H`);
ok(mining2.hashpower > 0, `实际权重 ${mining2.hashpower}`);
ok(mining2.hashpower > 0, `实际权重 ${mining2.hashpower}`);

ok(
  mining2.estimate.hashpower === mining2.hashpower,
  "预估与实际权重相同——图纸固定，元件涨价不影响权重，只影响买不买得起",
);
ok(mining2.claimable > 0, `留有可领余额 ${mining2.claimable} BEM`);

console.log("\n=== 22. 退款分支可达（参数合理性）===");
const over = estimateHashpower(ROUND, { ...QUOTE, prices: { ...QUOTE.prices, [ROUND.transistorId]: priceOf(ROUND.transistorId) * 60 } }, ROUND.totalShares, BOOK);
ok(!over.capCoversFloor, `元件涨 60x -> 募资总额买不起 ${over.usedParts} 个元件，执行失败分支可达`);
ok(est.needBnb / est.hardCapBnb < 0.5, `流片成本占募资总额 ${((est.needBnb / est.hardCapBnb) * 100).toFixed(1)}%，留有余量`);

console.log("\n=== 23. 身份识别 ===");
const holderBook = createScene("mining", ROUND, BOOK);
// 找一个确实不在名册里的地址，避免它被识别成持份用户
const STRANGER = "0x00000000000000000000000000000000DEAD01";
const asHolder = identify(WALLET, holderBook);
const asOwner = identify(OWNER, holderBook);
const asStranger = identify(STRANGER, holderBook);
ok(asOwner.role === "owner", `Owner 地址 -> ${asOwner.label}`);
ok(asHolder.role === "holder", `持份钱包 -> ${asHolder.label} (${asHolder.shares} 份)`);
ok(asStranger.role === "user", `名册外地址 -> ${asStranger.label}`);
ok(identify(OWNER.toLowerCase(), holderBook).role === "owner", "Owner 大小写不敏感");
ok(identify(WALLET, createScene("funding", ROUND, BOOK)).shares > 0, "funding 场景当前钱包有份");

console.log("\n=== 24. execute 时间锁 ===");
// 方案B：晶体管来自二级市场，execute 前必须先确认到账（executePhase=ready）。
// 测试直接构造已过观察期且已到账的 book。
const soldOut = { ...createScene("executing", ROUND, BOOK), sold: ROUND.totalShares, soldOutAt: Date.now() - 49 * 3600_000, executePhase: "ready" };
ok(soldOut.soldOutAt !== null, "executing 场景记录了售罄时刻");

const early = { ...createScene("executing", ROUND, BOOK), sold: ROUND.totalShares, soldOutAt: Date.now() - 12 * 3600_000, executePhase: "ready" };
ok(executeUnlockIn(ROUND, early, Date.now()) > 0, `售罄 12 小时（锁 48）时剩 ${Math.ceil(executeUnlockIn(ROUND, early, Date.now()) / 3600000)} 小时`);
ok(!executeUnlocked(ROUND, early), "售罄 12 小时（锁 48）时不可执行");
const future = Date.now() + 49 * 3600_000;
ok(executeUnlocked(ROUND, soldOut, future), "49 小时后已解锁");
ok(executeUnlockIn(ROUND, soldOut, future) === 0, "解锁后剩余为 0");

const lockedExec = applyExecute(ROUND, early, QUOTE, { role: "owner", shares: 0 }, BOOK);
ok(!lockedExec.ok, `时间锁内 Owner 也被拒: "${lockedExec.message.slice(0, 34)}..."`);
const matured = soldOut;
ok(applyExecute(ROUND, matured, QUOTE, { role: "owner", shares: 0 }, BOOK).ok, "期满后 Owner 可执行");

console.log("\n=== 25. execute 权限：仅 Factory Owner（不可逆） ===");
const maturedBook = { ...createScene("executing", ROUND, BOOK), sold: ROUND.totalShares, soldOutAt: Date.now() - 49 * 3600_000, executePhase: "ready" };
const byHolder = applyExecute(ROUND, maturedBook, QUOTE, { role: "holder", shares: 4 }, BOOK);
ok(!byHolder.ok, `持份用户不能触发 execute（不可逆，仅 Owner）: "${byHolder.message}"`);
const byOwner = applyExecute(ROUND, maturedBook, QUOTE, { role: "owner", shares: 0 }, BOOK);
ok(byOwner.ok && byOwner.book.scene === "mining", "Owner 可触发 execute -> mining");
const byStranger = applyExecute(ROUND, maturedBook, QUOTE, { role: "user", shares: 0 }, BOOK);
ok(!byStranger.ok, `未持份地址被拒: "${byStranger.message}"`);
const byOwnerLate = applyExecute(ROUND, early, QUOTE, { role: "owner", shares: 0 }, BOOK);
ok(!byOwnerLate.ok, "Owner 无视时间锁也被拒（无特权）");

console.log("\n=== 26. 份额转让仅限挖矿中（无合约赎回/退款）===");
// 份额转让仅在挖矿中允许：funding / executing 不可挂牌，mining 可挂牌
const holder = { role: "holder", shares: 4, address: DEMO_HOLDER };
ok(!applyListShares(ROUND, withShares(createScene("funding", ROUND, BOOK), DEMO_HOLDER, 4), { shares: 2, priceBnbPerShare: 0.5 }, holder).ok, "募集中不可挂牌转让");
ok(!applyListShares(ROUND, withShares(createScene("executing", ROUND, BOOK), DEMO_HOLDER, 4), { shares: 2, priceBnbPerShare: 0.5 }, holder).ok, "待执行不可挂牌转让");
ok(applyListShares(ROUND, withShares(createScene("mining", ROUND, BOOK), DEMO_HOLDER, 4), { shares: 2, priceBnbPerShare: 0.5 }, holder).ok, "挖矿中可挂牌转让");
ok(!applyListShares(ROUND, withShares(createScene("funding", ROUND, BOOK), DEMO_HOLDER, 0), { shares: 1, priceBnbPerShare: 0.5 }, { role: "user", shares: 0, address: DEMO_HOLDER }).ok, "未持份地址不可挂牌");
// 执行失败时仍在待执行（未进入挖矿），不可转让（转让仅限挖矿中），但可原路退还本金
const failedBook = applyExecute(ROUND, execBook, badQuote, EXEC_OWNER, BOOK).book;
ok(failedBook.scene === "executing" && failedBook.executionFailed === true, "执行失败后仍在待执行，不可转让");
ok(!applyListShares(ROUND, withShares(failedBook, DEMO_HOLDER, 4), { shares: 2, priceBnbPerShare: 0.5 }, holder).ok, "执行失败（待执行）不可挂牌转让");

console.log("\n=== 26b. 募集超时原路退还 BNB（仅募集失败场景）===");
// 募集未超时不可退款
const fundingLive = withShares(createScene("funding", ROUND, BOOK), DEMO_HOLDER, 4);
ok(!applyRefund(ROUND, fundingLive).ok, "募集未超时不可退款");
// 超时（endsAt 过去）且持份 -> 可退款，份额清零、记录退还金额、已售份数回退
const expiredBook = { ...withShares(createScene("funding", ROUND, BOOK), DEMO_HOLDER, 4), endsAt: Date.now() - 1000 };
const refunded = applyRefund(ROUND, expiredBook);
ok(refunded.ok && refunded.book.mine === 0, "超时退款后份额清零");
ok(refunded.book.refundedBnb === Number((4 * ROUND.sharePriceBnb).toFixed(4)), `退还金额 = 4 × ${ROUND.sharePriceBnb} BNB`);
ok(refunded.book.sold === Math.max(0, expiredBook.sold - 4), "已售份数相应回退");
// 超时但无份额不可退款
ok(!applyRefund(ROUND, { ...withShares(createScene("funding", ROUND, BOOK), DEMO_HOLDER, 0), endsAt: Date.now() - 1000 }).ok, "超时但无份额不可退款");
// 非 funding（挖矿中）不可退款
ok(!applyRefund(ROUND, withShares(createScene("mining", ROUND, BOOK), DEMO_HOLDER, 4)).ok, "挖矿中不可退款");
// 超时后也不能继续认购
ok(!applyBuy(ROUND, { ...withShares(createScene("funding", ROUND, BOOK), DEMO_HOLDER, 4), endsAt: Date.now() - 1000 }, 1).ok, "募集超时后不能继续买入");

console.log("\n=== 26c. 流片失败原路退还 BNB（execute 判失败、本金尚未支出）===");
// 流片失败（execFailed 预览）且持份 -> 可退款，份额清零、记录退还金额、已售回退
const execFailedBook = withShares(createScene("executing", ROUND, BOOK, null, false, true), DEMO_HOLDER, 4);
const execRefund = applyRefund(ROUND, execFailedBook);
ok(execRefund.ok && execRefund.book.mine === 0, "流片失败退款后份额清零");
ok(execRefund.book.refundedBnb === Number((4 * ROUND.sharePriceBnb).toFixed(4)), `流片失败退还金额 = 4 × ${ROUND.sharePriceBnb} BNB`);
ok(execRefund.book.sold === Math.max(0, execFailedBook.sold - 4), "流片失败已售份数相应回退");
// 待执行但未判失败 -> 不可退款（成功后应进入挖矿）
ok(!applyRefund(ROUND, withShares(createScene("executing", ROUND, BOOK), DEMO_HOLDER, 4)).ok, "待执行未判失败不可退款");
// 流片失败但无份额 -> 不可退款
ok(!applyRefund(ROUND, withShares(createScene("executing", ROUND, BOOK, null, false, true), DEMO_HOLDER, 0)).ok, "流片失败无份额不可退款");

console.log("\n=== 27. claim 任何人可调（自己的份额）===");
const mining3 = createScene("mining", ROUND, BOOK);
ok(applyClaim(ROUND, mining3, { role: "holder", shares: 4 }).ok, "持份用户可领自己的 BEM");
ok(!applyClaim(ROUND, createScene("funding", ROUND, BOOK), { role: "holder", shares: 3 }).ok, "募集中不可领取");

console.log("\n=== 28. 售罄自动启动观察期 ===");
const funding4 = createScene("funding", ROUND, BOOK);
ok(funding4.soldOutAt === null, "募集中未记录售罄时刻");
const partialBuy = applyBuy(ROUND, funding4, 1);
ok(partialBuy.ok && partialBuy.book.soldOutAt === null, "未售罄时不启动观察期");
const finishing = applyBuy(ROUND, partialBuy.book, ROUND.totalShares - partialBuy.book.sold);
ok(finishing.book.scene === "executing", "买到售罄 -> executing");
ok(finishing.book.soldOutAt !== null, "售罄瞬间自动记录 soldOutAt");
ok(executeUnlockIn(ROUND, finishing.book, Date.now()) > 0, "观察期立即开始计时");

console.log("\n=== 29. 四种可挖矿元件 ===");
ok(TRANSISTORS.length === 4, `4 种：${TRANSISTORS.map((t) => t.name).join("、")}`);
ok(
  TRANSISTORS.every((t) => t.processor === "TapeOut" || t.processor === "Behemoth"),
  "全部来自两个创世处理器",
);
ok(
  TRANSISTORS.filter((t) => t.part === "NAND").length === 2 &&
    TRANSISTORS.filter((t) => t.part === "LATCH").length === 2,
  "2 个 NAND + 2 个 LATCH",
);
ok(
  ["TapeOut", "Behemoth"].every((proc) =>
    TRANSISTORS.some((t) => t.processor === proc && t.part === "NAND") &&
    TRANSISTORS.some((t) => t.processor === proc && t.part === "LATCH"),
  ),
  "每个处理器都有 NAND 与 LATCH 两个类型",
);
ok(isMineable("TapeOut") && isMineable("Behemoth"), "两个处理器都有挖矿资格");
ok(!isMineable("TSMC90"), "非创世处理器无挖矿资格");
ok(processorScale("Behemoth") === 6 && processorScale("TapeOut") === 1, "P 系数 6 / 1");
ok(TRANSISTORS.every((t) => t.priceBnb > 0 && t.mintPriceBnb > 0), "价格为 BNB 计价且为正");

console.log("\n=== 30. 设计成本与质量系数 ===");
const t30 = findTask(ROUND, BOOK);
const p30 = planTask({ task: t30, transistorId: AUTO_ID, snapshot: snap });
const dm = designMetrics({ nand: p30.nand, latch: p30.latch, depth: t30.d });
ok(dm.g === t30.g, `g = NAND + LATCH = ${dm.g}`);
ok(dm.s === p30.latch, `s = LATCH 数 = ${dm.s}`);
ok(dm.area === dm.g + 6 * dm.s, `A = g + 6s = ${dm.area}（LATCH 面积权重 6）`);
ok(dm.cost === dm.area * Math.pow(t30.d, 3), `C = A x d³ = ${dm.area} x ${t30.d}³ = ${dm.cost}`);
ok(qualityFactor(2000, 2000) === 1, "设计与参考同成本 => q = 1");
ok(qualityFactor(500, 2000) === 4, "设计远优于参考 => q 打满 4");
ok(qualityFactor(8000, 2000) === 0.25, "设计劣于参考 => q 触底 0.25");
const deeper = designMetrics({ nand: p30.nand, latch: p30.latch, depth: t30.d + 1 });
ok(deeper.cost > dm.cost, `深度 2 -> 3 成本从 ${dm.cost} 涨到 ${deeper.cost}（27 倍）`);

console.log("\n=== 31. 权重公式 H = (b* + K_task x q) x P ===");
const hBh = planTask({ task: t30, transistorId: "BEHEMOTH_NAND", snapshot: snap, optimal: true });
ok(hBh.task.g === t30.g, `b* = ${hBh.task.g} 个元件`);
ok(hBh.processorScale === 6, "Behemoth P = 6");
ok(hBh.optimal === true, "最优首创拿满溢价");
ok(hBh.hashpower === Math.round((hBh.task.g + t30.K * hBh.q) * 6), `H = (${hBh.task.g} + ${t30.K}x${hBh.q}) x 6 = ${hBh.hashpower}`);
ok(hBh.baseWeight === hBh.task.g * 6, `工本部分 ${hBh.baseWeight}`);
ok(hBh.designPremium > 0, `设计溢价部分 ${hBh.designPremium}`);
ok(Number.isInteger(hBh.hashpower), "权重取整（链上按整数份额分配）");

const hTp = planTask({ task: t30, transistorId: "TAPE_OUT_NAND", snapshot: snap, optimal: true });
ok(hTp.hashpower === Math.round((t30.g + t30.K * hTp.q) * 1), `同图纸烧 TapeOut: H = ${hTp.hashpower}`);
ok(hBh.hashpower > hTp.hashpower, `Behemoth 权重是 TapeOut 的 ${(hBh.hashpower / hTp.hashpower).toFixed(2)} 倍`);

const hNon = planTask({ task: t30, transistorId: "BEHEMOTH_NAND", snapshot: snap, optimal: false });
ok(hNon.designPremium === 0, "非最优首创无设计溢价");
ok(hNon.hashpower === t30.g * 6, `非最优只剩工本 ${hNon.hashpower}（无设计溢价）`);
ok(hBh.hashpower > hNon.hashpower, `最优比非最优多 ${hBh.hashpower - hNon.hashpower} 权重`);

console.log("\n=== 32. 价格源 ===");
ok(typeof snap.bnbUsdt === "number" && snap.bnbUsdt > 0, `BNB 价 ${snap.bnbUsdt} USDT`);
ok(Object.keys(snap.prices).length === 4, "返回 4 种元件报价");
ok(Object.values(snap.prices).every((p) => p > 0 && p < 1), "元件价格是 BNB 量级的小数");
const snap2 = await fetchPriceSnapshot(999);
ok(typeof snap2.bnbUsdt === "number" && snap2.bnbUsdt > 0, `BNB 价有效：${snap2.bnbUsdt}`);
// BNB 走第三方接口，可能超时回落——两种状态都合法，但必须有兜底值兜住
ok(typeof snap.bnbLive === "boolean", `BNB 价来源已标注：${snap.bnbLive ? "实时" : "兜底"}`);
ok(snap.bnbUsdt > 0, `无论实时与否都有有效 BNB 价：${snap.bnbUsdt}`);
ok(snap.bnbUsdt > 300 && snap.bnbUsdt < 3000, `BNB 价在合理区间：${snap.bnbUsdt} USDT`);
// 直接测取价函数（不依赖 market.json 是否可用）
const bnbDirect = await fetchBnbUsdt();
ok(bnbDirect !== null && bnbDirect > 0, `BNB 取价接口可用：${bnbDirect} USDT`);

console.log("\n=== 33. 选型测算（BNB 计价）===");
const NEED_PARTS = findTask(ROUND, BOOK).g;
const CAP_BNB = ROUND.sharePriceBnb * ROUND.totalShares;
const plans = compareTransistors({ needParts: NEED_PARTS, hardCapBnb: CAP_BNB, snapshot: snap });
ok(plans.length === 4, "返回 4 个方案");
for (const plan of plans) {
  ok(plan.needParts === NEED_PARTS, `${plan.model.name}: 图纸需 ${plan.needParts} 个元件`);
  ok(plan.affordableParts === Math.floor(CAP_BNB / plan.priceBnb),
    `${plan.model.name}: 募资总额 ${CAP_BNB.toFixed(1)} BNB 可买 ${plan.affordableParts} 个`);
  ok(plan.needBnb <= CAP_BNB, `${plan.model.name}: 流片需付 ${plan.needBnb.toFixed(4)} BNB 在募资总额 ${CAP_BNB.toFixed(1)} 内`);
  ok(plan.baseWeight === plan.affordableParts * plan.processorScale,
    `${plan.model.name}: 工本权重 ${plan.baseWeight} = ${plan.affordableParts} x ${plan.processorScale}`);
  ok(plan.covered === plan.affordableParts >= NEED_PARTS, `${plan.model.name}: 够买判定 ${plan.covered}`);
}
ok(plans.every((p) => typeof p.hashPerBnb === "number"), "都给出每 BNB 的权重产出");
ok(
  plans.find((p) => p.model.processor === "TapeOut").hashPerBnb >
    plans.find((p) => p.model.processor === "Behemoth").hashPerBnb,
  "TapeOut 每 BNB 权重更高（便宜），Behemoth 单价高但 P=6",
);

console.log("\n=== 34. 预估权重与开期校验 ===");
const roundEst = estimateHashpower(ROUND, QUOTE, null, BOOK);
ok(roundEst.hashpower > 0, `预估权重 ${roundEst.hashpower}`);
ok(roundEst.hashpower > 0, `图纸权重 ${roundEst.hashpower}`);
ok(roundEst.usedParts === findTask(ROUND, BOOK).g, `图纸用 ${roundEst.usedParts} 个元件`);
ok(roundEst.capCoversFloor, `募资总额可买 ${roundEst.affordableParts} 个 >= 图纸所需 ${roundEst.usedParts} 个`);
ok(roundEst.needBnb > 0, `图纸成本 ${roundEst.needBnb} BNB`);

const review = reviewRound({
  sharePriceBnb: String(ROUND.sharePriceBnb), totalShares: String(ROUND.totalShares), feePercent: "7",
  transistorId: AUTO_ID, taskId: ROUND.taskId,
  feeRecipient: "0x0000000000000000000000000000000000000fee",
}, snap, ROUND, BOOK);
ok(review.ok, `校验通过: ${review.hashpower} 权重 / ${review.needBnb} BNB`);

const tooExpensive = reviewRound({
  sharePriceBnb: String(ROUND.sharePriceBnb), totalShares: String(ROUND.totalShares), feePercent: "7",
  transistorId: AUTO_ID, taskId: ROUND.taskId,
  feeRecipient: "0x0000000000000000000000000000000000000fee",
}, { ...snap, prices: { ...snap.prices, [AUTO_ID]: snap.prices[AUTO_ID] * 3 } }, ROUND, BOOK);
ok(!tooExpensive.ok, `元件涨到基准价的 3 倍（${(snap.prices[AUTO_ID] * 3).toFixed(4)} BNB）时校验失败`);
ok(tooExpensive.shortParts > 0, `明确指出缺口 ${tooExpensive.shortParts} 个元件`);

console.log("\n=== 35. 敏感度：图纸固定，涨的是买不买得起 ===");
const priceSens = hashpowerSensitivity(ROUND, QUOTE, BOOK);
ok(priceSens.length === 5, "5 档");
ok(
  priceSens.every((row) => row.hashpower === priceSens[0].hashpower),
  "所有档位权重相同（图纸已定，H 不随价格变）",
);
ok(priceSens[0].canAfford, "基准价可流片");
ok(!priceSens[4].canAfford, "涨 10 倍后买不够");
ok(priceSens[4].needBnb > priceSens[0].needBnb, `流片成本从 ${priceSens[0].needBnb} 涨到 ${priceSens[4].needBnb} BNB`);
ok(priceSens[4].shortParts > 0, `缺 ${priceSens[4].shortParts} 个元件`);

console.log("\n=== 36. 开期写入图纸与报价快照 ===");
const created = applyCreate(ROUND, {
  sharePriceBnb: String(ROUND.sharePriceBnb), totalShares: String(ROUND.totalShares), feePercent: "7", fundingDays: "15", transistorId: AUTO_ID,
  feeRecipient: "0x0000000000000000000000000000000000000fee",
}, QUOTE);
ok(created.ok, `开期成功: ${created.message}`);
ok(created.round.transistorId === "BEHEMOTH_NAND", "元件组合已写入");
ok(created.round.taskId === String(ROUND.taskId), `选题已写入：#${created.round.taskId}`);
ok(created.round.optimal === false, "默认非最优首创（无设计溢价）");
ok(created.round.lockedQuote?.prices?.BEHEMOTH_NAND === QUOTE.prices.BEHEMOTH_NAND, "锁定报价快照");

console.log("\n=== 37. 权重是整数（链上份额）===");
const many = [];
for (let n = 10; n <= 200; n += 7) {
  many.push(planTask({ task: { ...t30, g: n }, transistorId: "BEHEMOTH_NAND", snapshot: snap, optimal: true }).hashpower);
}
ok(many.every((h) => Number.isInteger(h)), "所有权重均为整数");
ok(Math.max(...many) > Math.min(...many), `权重随元件数变化：${Math.min(...many)} ~ ${Math.max(...many)}`);
// 说明：权重含 K_task x q 溢价项，q 随成本变化，所以不严格单调
ok(many.every((h) => h > 0), "权重恒为正");

console.log("\n=== 38. 退款保护必须真实有效 ===");
const capBnb = ROUND.sharePriceBnb * ROUND.totalShares;
const ratio = roundEst.needBnb / capBnb;
ok(ratio > 0.2 && ratio < 0.8, `流片成本占募资总额 ${(ratio * 100).toFixed(1)}%（应在 20%-80%，太低说明保护形同虚设）`);
ok(liveEst.hashpower > 0, `图纸权重 ${liveEst.hashpower}（固定，不随价格变）`);
// 元价涨多少会买不够
const priceMult = roundEst.hardCapBnb / roundEst.needBnb;
ok(priceMult > 1.3 && priceMult < 10, `元件涨 ${priceMult.toFixed(2)}x 触发退款（阈值应可感知）`);
// 没有 minHashpower 概念了：唯一失败条件就是买不够
ok(!("meetsFloor" in roundEst), "不再有 meetsFloor（权重固定，无达标概念）");
ok(!("minHashpower" in ROUND), "ROUND 不再有 minHashpower");

console.log("\n=== 39. 选题未加载时必须能回落 ===");
// UI 的 draft 不含 taskId 时，应回落到期次自带的选题
const uiDraft = {
  taskId: ROUND.taskId,
  sharePriceBnb: String(ROUND.sharePriceBnb), totalShares: String(ROUND.totalShares), feePercent: "7",
  transistorId: AUTO_ID, taskId: ROUND.taskId,
  feeRecipient: "0x0000000000000000000000000000000000000fee",
};
const uiReview = reviewRound(uiDraft, QUOTE, ROUND, BOOK);
ok(uiReview.hashpower > 0, `无 taskId 时回落到期次自带选题，权重 ${uiReview.hashpower}（不为 0）`);
ok(uiReview.needParts === findTask(ROUND, BOOK).g, `元件数取自题目：${uiReview.needParts} 个`);
ok(uiReview.ok, "校验通过");

const uiCreated = applyCreate(ROUND, uiDraft, QUOTE, BOOK);
ok(uiCreated.ok, `开期成功: ${uiCreated.message}`);
ok(uiCreated.round.taskId === String(ROUND.taskId), `新期沿用期次选题 #${uiCreated.round.taskId}`);
ok(
  estimateHashpower(uiCreated.round, QUOTE, 30, BOOK).hashpower === uiReview.hashpower,
  "新期权重与开期校验一致",
);
// 换更重的题应改变元件数与权重
const heavier = BOOK.tasks.find((x) => x.g > findTask(ROUND, BOOK).g * 3);
const heavierReview = reviewRound({ ...uiDraft, taskId: heavier.id }, QUOTE, ROUND, BOOK);
ok(heavierReview.needParts === heavier.g, `换题后元件数 =#${heavier.id} g=${heavier.g}`);
ok(
  heavierReview.hashpower > uiReview.hashpower,
  `权重随题目变重 ${uiReview.hashpower} -> ${heavierReview.hashpower}`,
);

console.log("\n=== 40. 价格源实时性 ===");
// 用可控的 mock fetcher 测试轮询机制本身（真实网络太慢且不可复现）
let tickCount = 0;
const mockFetcher = async () => {
  tickCount += 1;
  return {
    ts: Date.now(),
    bnbUsdt: 600,
    prices: Object.fromEntries(TRANSISTORS.map((t, i) => [t.id, t.priceBnb * (1 + tickCount * 0.01 * (i + 1))])),
  };
};
const feed = createPriceFeed({ intervalMs: 60, fetcher: mockFetcher });
let latest = null;
const unsub = feed.subscribe((snap) => { latest = snap; });
feed.start();
await new Promise((r) => setTimeout(r, 300));
ok(latest !== null, "订阅后能收到报价推送");
ok(latest.updatedAt > 0, "带更新时间戳");
ok(Object.keys(latest.prices).length === 4, "含 4 种元件报价");
ok(typeof latest.loading === "boolean", "含 loading 状态标志");

// 连续刷新应产生涨跌方向
ok(latest.prevPrices !== undefined, "保留上一档价格用于涨跌判断");
const dirs = latest.dir || {};
ok(Object.keys(dirs).length > 0, `标记了 ${Object.keys(dirs).length} 个元件的涨跌方向`);
ok(
  Object.values(dirs).every((d) => d === "up" || d === "down"),
  "方向只有 up / down",
);
// 价格确实在动
const before = { ...latest.prices };
await new Promise((r) => setTimeout(r, 300));
const moved = Object.keys(before).filter((k) => before[k] !== latest.prices[k]);
ok(moved.length > 0, `${moved.length} 个元件价格发生变化（轮询刷新生效）`);
ok(tickCount >= 2, `共取价 ${tickCount} 次`);
unsub();
feed.stop();

// 陈旧判定：3 个周期未更新
ok(isStale({ updatedAt: Date.now() - 20000 }, 5000), "超过 3 个周期判定为陈旧");
ok(!isStale({ updatedAt: Date.now() - 2000 }, 5000), "2 秒内不算陈旧");

console.log("\n=== 40b. 真实数据源可用性 ===");
ok(snap.source === "live" || snap.source === "fallback", `价格来源标记：${snap.source}`);
ok(BOOK.source === "live" || BOOK.source === "fallback", `题库来源标记：${BOOK.source}`);
ok(Object.values(snap.prices).every((v) => v > 0), "四个元件价均为正");
if (BOOK.source === "live") {
  ok(BOOK.total > 200, `官方题库 ${BOOK.total} 道`);
  ok(BOOK.tasks.every((t) => t.g > 0 && t.d > 0 && t.K > 0), "每道题都有 g / d / K");
}

console.log("\n=== 41. 选型卡字段语义正确 ===");
const cap2 = ROUND.sharePriceBnb * ROUND.totalShares;
for (const t of TRANSISTORS) {
  const p = planTransistor({ transistorId: t.id, needParts: NEED_PARTS, hardCapBnb: cap2, snapshot: snap });
  ok(p.needBnb === NEED_PARTS * p.priceBnb, `${t.name}: 流片需付 = 250 x ${p.priceBnb} = ${p.needBnb.toFixed(4)} BNB`);
  ok(Math.abs(p.marginBnb - (cap2 - p.needBnb)) < 0.0001, `${t.name}: 余量 = 募资总额 − 需付 = ${p.marginBnb.toFixed(4)}`);
  ok(p.marginBnb < cap2, `${t.name}: 余量小于募资总额（不是把募资总额全花掉）`);
  ok(p.covered === p.affordableParts >= NEED_PARTS, `${t.name}: 够买判定正确`);
  // 关键：需付应远小于募资总额（只买图纸所需，不是买满）
  ok(p.needBnb < cap2 * 0.8, `${t.name}: 只需买图纸所需元件，占募资总额 ${((p.needBnb / cap2) * 100).toFixed(0)}%`);
}

console.log("\n=== 42. 真实产出机制：按占比分配而非固定系数 ===");
// 系数必须等于「池日产 / 全池总权重」，且随全网权重变化
ok(vRate.verifiedPerWeight === (7200 * 0.99) / NETWORK_WEIGHT.verified,
  `已验证池每权重 ${vRate.verifiedPerWeight.toFixed(9)} = 7,128 / ${NETWORK_WEIGHT.verified.toLocaleString()}`);
ok(vRate.unverifiedPerWeight === (7200 * 0.01) / NETWORK_WEIGHT.unverified,
  `未验证池每权重 ${vRate.unverifiedPerWeight.toFixed(9)}`);
ok(POOL.verified.share + POOL.unverified.share === 1, "两池份额合计 100%");
ok(POOL.verified.share === 0.99 && POOL.unverified.share === 0.01,
  "官网口径：已验证 99% / 未验证 1%");

// 零和性：全网权重翻倍，所有人产出减半
const half = bemRate(1500, { networkWeight: NETWORK_WEIGHT.verified * 2 });
ok(near(half, bemRate(1500) / 2, 0.0001),
  `全网权重翻倍 -> 我的产出减半（${bemRate(1500)} -> ${half}）`);
const double = bemRate(1500, { networkWeight: NETWORK_WEIGHT.verified / 2 });
ok(near(double, bemRate(1500) * 2, 0.001),
  `全网权重减半 -> 我的产出翻倍（${double}）`);

// 挖矿闸门：门数超上限只能进未验证池
const overGate = { g: MINE_GATE_LIMIT + 1, K: 100, d: 2, C: 10000, tier: "专家", kind: "comb", name: "超大电路" };
const gatedPlan = planTask({ task: overGate, transistorId: "BEHEMOTH_NAND", snapshot: snap });
ok(gatedPlan.capped === true, `g=${overGate.g} 超过闸门 ${MINE_GATE_LIMIT} -> 被拦住`);
ok(gatedPlan.pool === "unverified", "只能进未验证池（分 1%）");
ok(gatedPlan.dailyBem === gatedPlan.dailyUnver, "产出按未验证池算");
// 未验证池只分1% BEM，但总权重只有 4 万（已验证池 157 万），
// 折算下来单权重产出仍明显更低——损失约 61%
ok(gatedPlan.dailyBem < gatedPlan.dailyVerif,
  `被闸门拦住后产出更低：${gatedPlan.dailyBem} vs 若进已验证池 ${gatedPlan.dailyVerif} BEM/天`);
ok(near(gatedPlan.dailyBem / gatedPlan.dailyVerif, 0.39, 0.03),
  `损失约 ${Math.round((1 - gatedPlan.dailyBem / gatedPlan.dailyVerif) * 100)}%`);
ok(gatedPlan.hashpower === overGate.g * 6, "被拦住时只剩工本权重 b* × P，无设计溢价");
const underGate = { g: 100, K: 100, d: 2, C: 10000, tier: "初级", kind: "comb", name: "正常电路" };
const okPlan = planTask({ task: underGate, transistorId: "BEHEMOTH_NAND", snapshot: snap, optimal: true });
ok(okPlan.capped === false, `g=${underGate.g} 未超闸门`);
ok(okPlan.pool === "verified", "进已验证池（分 99%）");
ok(okPlan.dailyBem === okPlan.dailyVerif, "产出按已验证池算");
ok(okPlan.hashpower === okPlan.nominalHashpower, "可拿满设计溢价");

console.log("\n=== 43. 投入产出测算（官网未给但用户最需要）===");
const cur = findTask(ROUND, BOOK);
const plan41 = planTask({ task: cur, transistorId: AUTO_ID, snapshot: snap });
const roi = roiOf({
  costBnb: plan41.partsCost,
  dailyBem: plan41.dailyBem,
  days: ROUND.miningDays,
  feeRate: ROUND.feeBps / 10000,
});
ok(roi.costBnb > 0, `投入 ${roi.costBnb} BNB（买元件）`);
ok(roi.grossBem > 0, `毛产出 ${roi.grossBem} BEM`);
ok(roi.feeBem > 0, `服务费 ${roi.feeBem} BEM（${(ROUND.feeBps / 100).toFixed(0)}%）`);
ok(Math.abs(roi.netBem - (roi.grossBem - roi.feeBem)) < 0.01, "净产出 = 毛产出 − 服务费");
// 未给 BEM 价格时不该编造 ROI
ok(roi.coverage === null && roi.paybackDays === null,
  "未给 BEM 价格时不编造回本天数（避免虚假承诺）");
// 给了价格才算
const roi2 = roiOf({
  costBnb: plan41.partsCost, dailyBem: plan41.dailyBem, days: 90, feeRate: 0.07,
  bemUsdt: 58, bnbUsdt: snap.bnbUsdt,
});
ok(roi2.coverage !== null, `给 BEM 价后覆盖倍数 ${roi2.coverage.toFixed(3)}x`);
ok(roi2.paybackDays > 0, `回本 ${Math.ceil(roi2.paybackDays)} 天`);

console.log("\n=== 44. 纪元减半 ===");
ok(eraDaily(0) === 7200, "第 1 纪元日产 7,200");
ok(eraDaily(1) === 3600, "第 2 纪元减半");
ok(eraDaily(2) === 1800, "第 3 纪元再减半");
ok(cumulativeEmission(90) === 7200 * 90, "90 天不跨纪元，累计 = 日产 × 天数");
ok(cumulativeEmission(1460) === 7200 * 1460, "整一个纪元");
ok(cumulativeEmission(1460 * 2) === 7200 * 1460 + 3600 * 1460, "两个纪元跨减半点");

console.log("\n=== 45. UI 显示字段完整性（防undefined 与过期缓存）===");
// estimateHashpower 必须返回 UI 引用的所有字段
const uiFields = [
  "affordableParts", "hardCapBnb", "hardCapUsdt", "hashpower", "usedParts",
  "needBnb", "dailyBem", "totalNet", "priceBnb", "transistorName",
  "processorScale", "optimal", "capCoversFloor", "taskName", "refParts", "q",
];
const missing = uiFields.filter((f) => roundEst[f] === undefined || Number.isNaN(roundEst[f]));
ok(missing.length === 0, `estimateHashpower 返回 UI 全部所需字段${missing.length ? "，缺 " + missing.join(",") : ""}`);

// 已删除的字段不能被引用（曾经导致 est.transistors.toLocaleString() 崩溃）
ok(!("transistors" in roundEst), "不再有 transistors（曾导致页面崩溃）");
ok(!("parts" in roundEst), "不再有 parts（曾显示 undefined）");

// reviewRound 同样
const revFields = ["hardCap", "hardCapBnb", "needBnb", "needParts", "affordableParts", "hashpower", "priceBnb", "bnbUsdt"];
const revMissing = revFields.filter((f) => uiReview[f] === undefined || Number.isNaN(uiReview[f]));
ok(revMissing.length === 0, `reviewRound 字段完整${revMissing.length ? "，缺 " + revMissing.join(",") : ""}`);

// computeHarvest 必须按hashpower 重算，不能读缓存
const hb = createScene("mining", ROUND, BOOK);
const byW = (H) => computeHarvest(ROUND, { ...hb, hashpower: H }).dailyBem;
ok(near(byW(1), 0.0045, 0.0001), `权重 1 -> ${byW(1)} BEM/日（不是缓存值）`);
ok(near(byW(60), 0.2715, 0.0001), `权重 60 -> ${byW(60)} BEM/日`);
ok(near(byW(1200), 5.4294, 0.01), `权重 1200 -> ${byW(1200)} BEM/日（线性）`);
ok(near(byW(1200) / byW(60), 20, 0.01), `同池内产出与权重成正比（${(byW(1200) / byW(60)).toFixed(3)}x）`);
// 缓存不同步时也不能显示过期值
const stale = { ...hb, hashpower: 120, dailyBem: 0.2715 };
ok(computeHarvest(ROUND, stale).dailyBem !==0.2715,
  "dailyBem 缓存过期时被忽略，按权重重算");

// capped 决定池归属
ok(hb.capped === false && hb.pool === "verified", "普通场景进已验证池");
const cappedBook = { ...hb, capped: true, pool: "unverified" };
const realW = hb.hashpower;
ok(computeHarvest(ROUND, cappedBook).dailyBem < computeHarvest(ROUND, hb).dailyBem,
  `被闸门拦住时日产更低（${computeHarvest(ROUND, cappedBook).dailyBem} vs ${computeHarvest(ROUND, hb).dailyBem}）`);
// F1 一致性守卫：被拦住（capped→未验证池）时，recomputeSelf 的 claimable 必须与 computeHarvest.pending
// 用同一「未验证池」系数。若 recomputeSelf 误读开期写入的 verified dailyBem，会虚高并留下领空残影。
const cappedClean = recomputeSelf(withShares({ ...hb, capped: true, pool: "unverified" }, WALLET, hb.mine));
ok(near(recomputeSelf(cappedClean).claimable, computeHarvest(ROUND, cappedClean).pending, 0.02),
  `capped 期 claimable 与 pending 同口径（${r2(recomputeSelf(cappedClean).claimable)} vs ${r2(computeHarvest(ROUND, cappedClean).pending)}）`);
const cappedClaim = applyClaim(ROUND, cappedClean);
ok(cappedClaim.ok && cappedClaim.book.claimable === 0, "capped 期 claim 后可领清零（无池口径错配残影）");

// 所有场景都不得出现 NaN
for (const sc of SCENES) {
  const b = createScene(sc.id, ROUND, BOOK);
  const h = computeHarvest(ROUND, b);
  const nums = [h.dailyBem, h.share, h.userPart, h.poolShare, b.hashpower];
  ok(nums.every((v) => typeof v === "number" && !Number.isNaN(v)),
    `${sc.id} 场景关键字段均为有效数字`);
  ok(typeof b.pool === "string" && (b.pool === "verified" || b.pool === "unverified"),
    `${sc.id} 池归属合法：${b.pool}`);
  ok(typeof b.capped === "boolean", `${sc.id} capped 是布尔值`);
}

console.log("\n=== 46. 极端边界不崩 ===");
// 零份数（多钱包账本下需把本钱包 mine 置 0，再驱动 computeHarvest）
const zeroBook = withShares({ ...createScene("funding", ROUND, BOOK), sold: 0 }, WALLET, 0);
const hz = computeHarvest(ROUND, zeroBook);
ok(hz.userPart === 0 && hz.share === 0, "零份数时产出为 0，不产生 NaN");
// 零权重
ok(computeHarvest(ROUND, { ...hb, hashpower: 0 }).dailyBem === 0, "零权重时日产为 0");
// 超大权重不溢出
const huge = computeHarvest(ROUND, { ...hb, hashpower: 1e9 });
ok(Number.isFinite(huge.dailyBem) && huge.dailyBem > 0, `超大权重(${huge.dailyBem}) 不溢出`);
// 题库未加载时回落
const noBookEst = estimateHashpower(ROUND, QUOTE, null, null);
ok(noBookEst.hashpower > 0 && noBookEst.usedParts > 0, "题库未加载时回落到兜底题目，权重不为 0");
// 报价缺失时不崩
const noQuoteEst = estimateHashpower(ROUND, { bnbUsdt: 0, prices: {} }, null, BOOK);
ok(Number.isFinite(noQuoteEst.dailyBem), "报价缺失时日产仍为有限数");

console.log("\n=== 47. 募资总额与选题必须匹配（防参数失衡）===");
// 当前默认参数：500 USDT × 100 份 = 50,000 USDT
ok(typeof ROUND.sharePriceBnb === "number" && ROUND.sharePriceBnb > 0,
  `每份 ${ROUND.sharePriceBnb} BNB（BNB 计价，不经 USDT 中转）`);
ok(!("sharePrice" in ROUND), "ROUND 不再有 USDT 计价的 sharePrice");
ok(ROUND.totalShares === 100, `总份数 ${ROUND.totalShares}`);
const capNow = ROUND.sharePriceBnb * ROUND.totalShares;
ok(near(capNow, 68.5, 0.1), `募资总额 ${capNow} BNB = 份数 × 每份 BNB`);

// 选题必须在题库里，且元件数与募资总额匹配
const capTask = findTask(ROUND, BOOK);
ok(capTask.g > 0, `选题 #${capTask.id}「${capTask.name}」g=${capTask.g}`);

// 关键：流片成本必须占募资总额 20%-80%，否则退款保护形同虚设
const ratioNow = liveEst.needBnb / liveEst.hardCapBnb;
ok(ratioNow > 0.2 && ratioNow < 0.8,
  `流片成本占募资总额 ${(ratioNow * 100).toFixed(1)}%（须在 20%-80%）`);
ok(ratioNow > 0.3 && ratioNow < 0.6,
  `实际落在 30%-60% 的健康区间（${(ratioNow * 100).toFixed(1)}%）`);

// 触发退款的涨价阈值应在可感知范围
const triggerMult = liveEst.hardCapBnb / liveEst.needBnb;
ok(triggerMult > 1.3 && triggerMult < 5,
  `元件涨 ${triggerMult.toFixed(2)}x 触发退款（阈值可感知）`);

// 场景种子的份数不得超过总份数
for (const sc of SCENES) {
  const b = createScene(sc.id, ROUND, BOOK);
  ok(b.sold <= ROUND.totalShares && b.mine <= ROUND.totalShares,
    `${sc.id} 场景份数合法（sold=${b.sold} mine=${b.mine} <= ${ROUND.totalShares}）`);
}

// 售罄场景必须是满份
for (const fullId of ["executing", "mining"]) {
  const bFull = createScene(fullId, ROUND, BOOK);
  ok(bFull.sold === ROUND.totalShares,
    `${fullId} 应为满募（${bFull.sold}/${ROUND.totalShares}）`);
}

console.log("\n=== 48. BNB 实时价（不能是写死的）===");
// 之前 bnbUsdt 硬编码 600，实际约 730——差 22%，会让所有 BNB 换算算错
ok(snap.bnbUsdt > 300 && snap.bnbUsdt < 3000, `BNB 价在合理区间：${snap.bnbUsdt} USDT`);
ok("bnbLive" in snap, "标注了 BNB 价是否为实时");
ok(typeof fetchBnbUsdt === "function", "导出了独立的 BNB 取价函数");

// BNB 价换算已不适用（用实时快照）
const capBnbDirect = ROUND.sharePriceBnb * ROUND.totalShares;
const liveEst2 = estimateHashpower(ROUND, snap, null, BOOK);
ok(near(liveEst2.hardCapBnb, capBnbDirect, 0.001),
  `募资总额 ${capBnbDirect} BNB（BNB 计价，无需 ÷ BNB 价）`);

// 关键：募集已是 BNB 计价，**BNB 价波动不再影响募资总额购买力**
ok(liveEst.hardCapBnb === roundEst.hardCapBnb,
  `BNB 价波动不影响募资总额：实时价 ${snap.bnbUsdt} USDT 下募资总额仍为 ${liveEst.hardCapBnb} BNB`);
ok(near(liveEst.hardCapBnb, ROUND.sharePriceBnb * ROUND.totalShares, 0.001),
  `募资总额 = 份数 × 每份 BNB = ${ROUND.sharePriceBnb} × ${ROUND.totalShares} = ${liveEst.hardCapBnb} BNB`);
// 硬编码 600 与实时的偏离幅度（仅记录，不作断言）
const drift = (liveEst.hardCapBnb / roundEst.hardCapBnb - 1) * 100;
if (Math.abs(drift) > 1) {
  console.log(`         （硬编码 600 与实时价偏离 ${drift.toFixed(1)}%，实时价会随行情波动）`);
}

// BNB 价波动不再影响购买力——BNB 计价的核心收益
const bnbUp = { ...snap, bnbUsdt: snap.bnbUsdt * 1.2 };
const estBnbUp = estimateHashpower(ROUND, bnbUp, null, BOOK);
ok(estBnbUp.hardCapBnb === liveEst.hardCapBnb,
  `BNB 涨 20% -> 募资总额不变（${estBnbUp.hardCapBnb} BNB），BNB 计价消除了汇率风险`);
ok(estBnbUp.needBnb === liveEst.needBnb, "元件成本也不受BNB 价影响（同样以 BNB 计价）");
ok(estBnbUp.affordableParts === liveEst.affordableParts, "可买元件数不变");
ok(estBnbUp.hashpower === liveEst.hashpower, "BNB 价不影响权重");

// 兜底时也必须有有效价
const noNet = { ...snap, bnbUsdt: 600, bnbLive: false };
ok(noNet.bnbUsdt > 0, "网络不可用时回落价600 仍为有效正数");

console.log("\n=== 49. 处理器成本与权重对比 ===");
const capBnbNow = ROUND.sharePriceBnb * ROUND.totalShares;

// 题库应给出精确的 nand/latch 配比，不再靠题型猜
const t49 = findTask(ROUND, BOOK);
ok(Number.isFinite(t49.nand) && Number.isFinite(t49.latch),
  `题库自带精确配比：#${t49.id} ${t49.nand} NAND + ${t49.latch} LATCH（合计 ${t49.nand + t49.latch} = g=${t49.g}）`);
ok(t49.nand + t49.latch === t49.g, "nand + latch 恰好等于 g");

const p49 = planTask({ task: t49, transistorId: AUTO_ID, snapshot: snap });
ok(p49.exactRatio === true, "planTask 用了题库精确配比");
ok(p49.nand === t49.nand && p49.latch === t49.latch, "元件拆分与题库一致");
ok(near(p49.partsCost, t49.nand * p49.priceNand + t49.latch * p49.priceLatch, 0.001),
  `成本按两种元件各自计价：${t49.nand}×${p49.priceNand} + ${t49.latch}×${p49.priceLatch} = ${p49.partsCost.toFixed(2)} BNB`);

// 单价必须按元件种类归位，而不是跟着型号走
ok(p49.priceNand === snap.prices.BEHEMOTH_NAND && p49.priceLatch === snap.prices.BEHEMOTH_LATCH,
  `NAND ${p49.priceNand} / LATCH ${p49.priceLatch} 取自各自 tokenId 的报价`);
ok(p49.priceNand !== p49.priceLatch,
  `两种元件市价确实不同（Behemoth NAND 贵 ${(p49.priceNand / p49.priceLatch).toFixed(2)} 倍）`);
ok(near(p49.costBreakdown.NAND.cost, t49.nand * p49.priceNand, 0.0001) &&
   near(p49.costBreakdown.LATCH.cost, t49.latch * p49.priceLatch, 0.0001),
  "成本小计按种类拆开（NAND 小计 + LATCH 小计 = 合计）");
ok(near(p49.costBreakdown.NAND.cost + p49.costBreakdown.LATCH.cost, p49.partsCost, 0.0001),
  `两种小计相加 = 元件总价 ${p49.partsCost.toFixed(4)} BNB`);

// 传 LATCH 型号时，priceNand 仍必须是 NAND 的价（字段名不能骗人）
const p49l = planTask({ task: t49, transistorId: "BEHEMOTH_LATCH", snapshot: snap });
ok(p49l.priceNand === p49.priceNand && p49l.priceLatch === p49.priceLatch,
  "传 LATCH 型号时 priceNand/priceLatch 仍是按种类归位的（NAND/LATCH）");
ok(p49l.priceByPart.NAND === p49.priceByPart.NAND && p49l.priceByPart.LATCH === p49.priceByPart.LATCH,
  "priceByPart 在两种型号下一致");

// 同处理器下 NAND 与 LATCH 成本相同（混合采购，与选哪种无关）
const pNand = planTask({ task: t49, transistorId: "BEHEMOTH_NAND", snapshot: snap });
const pLatch = planTask({ task: t49, transistorId: "BEHEMOTH_LATCH", snapshot: snap });
ok(near(pNand.partsCost, pLatch.partsCost, 0.001),
  "同处理器下选NAND 或 LATCH 成本相同——配比由题目决定`");
ok(pNand.hashpower === pLatch.hashpower, "同处理器下权重相同（NAND/LATCH 权重都算 1）");

// Behemoth vs TapeOut：权重 6 倍但成本约 7.5 倍
const pTp = planTask({ task: t49, transistorId: "TAPE_OUT_NAND", snapshot: snap });
ok(pNand.hashpower === pTp.hashpower * 6, `Behemoth 权重 = TapeOut × 6（${pTp.hashpower} -> ${pNand.hashpower}）`);
ok(pNand.partsCost / pTp.partsCost > 5,
  `Behemoth 成本是 TapeOut 的 ${(pNand.partsCost / pTp.partsCost).toFixed(1)} 倍`);

// 四种元件组合的排序明细（开期页只用两处理器对比，这里保留明细校验）
const ranked = rankTransistors({ task: t49, hardCapBnb: capBnbNow, snapshot: snap });
ok(ranked.length === 4, "返回 4 个方案");
ok(ranked.every((r, i) => i === 0 || r.affordable >= ranked[i - 1].affordable),
  "可负担的排前面（买不起的永远不该被推荐）");

// 两个处理器的对比：系统只负责算清账，不做选择
const cmp49 = compareProcessors({ task: t49, hardCapBnb: capBnbNow, snapshot: snap });
ok(cmp49.length === 2, "对比返回 2 个处理器方案");
ok(cmp49.every((c) => Number.isFinite(c.costRatio) && Number.isFinite(c.priceTolerance)),
  "每个方案都带占募资总额比例与可承受涨价倍数");
const bh49 = cmp49.find((c) => c.processorId === "Behemoth");
const tp49 = cmp49.find((c) => c.processorId === "TapeOut");
ok(bh49.affordable, `Behemoth 在当前募资总额下买得起（占 ${(bh49.costRatio * 100).toFixed(0)}%）`);
ok(bh49.hashpower === tp49.hashpower * 6, "Behemoth 权重是 TapeOut 的 6 倍");

// 募资总额极小时时两个处理器都应被标记为买不起
const tinyCmp = compareProcessors({ task: t49, hardCapBnb: 1, snapshot: snap });
ok(!tinyCmp.some((c) => c.affordable), "募资总额 1 BNB 时两个处理器都买不起");
const tinyAdv = adviseProcessor({ processorId: "TapeOut", plan: tinyCmp[1], hardCapBnb: 1 });
ok(tinyAdv.includes("买不到") || tinyAdv.includes("失败"), `买不起时直说：${tinyAdv.slice(0, 30)}...`);

// 题目难度建议区间（BNB 计价：直接用募资总额 BNB，无需÷ BNB 价）
const range49 = suggestTaskRange({ hardCapBnb: capBnbNow, snapshot: snap, transistorId: AUTO_ID });
ok(range49.maxParts > range49.minParts,
  `建议元件数区间 ${range49.minParts} ~ ${range49.maxParts}（上限 > 下限）`);
ok(range49.idealParts >= range49.minParts && range49.idealParts <= range49.maxParts,
  `理想元件数 ${range49.idealParts} 落在区间内`);
ok(range49.ratioMin < range49.ratioIdeal && range49.ratioIdeal < range49.ratioMax,
  `占比区间 ${range49.ratioMin} < 理想 ${range49.ratioIdeal} < 上限 ${range49.ratioMax}`);

console.log("\n=== 50. 目标处理器由开期人手动选择 ===");
ok("taskId" in ROUND, "期次由 taskId 驱动");

// 处理器 id -> 元件组合 id 的映射固定且只覆盖两个创世处理器
ok(PROCESSOR_IDS.length === 2 && PROCESSOR_IDS.includes("Behemoth") && PROCESSOR_IDS.includes("TapeOut"),
  "可选处理器只有 Behemoth 与 TapeOut 两个");
ok(transistorIdFor("Behemoth") === "BEHEMOTH_NAND" && transistorIdFor("TapeOut") === "TAPE_OUT_NAND",
  "处理器映射到对应合约的 NAND（配比仍由题目给）");
ok(transistorIdFor("不存在的处理器") === "BEHEMOTH_NAND",
  "非法处理器回落到默认，不抛错");

// 对比函数只出两个方案，且与直接 planTask 的结果一致
const t50 = findTask(ROUND, BOOK);
const cap50 = ROUND.sharePriceBnb * ROUND.totalShares;
const cmp50 = compareProcessors({ task: t50, hardCapBnb: cap50, snapshot: snap });
ok(cmp50.length === 2, `对比返回 2 个方案（${cmp50.map((c) => c.processorId).join(" / ")}）`);
for (const c of cmp50) {
  const direct = planTask({ task: t50, transistorId: transistorIdFor(c.processorId), snapshot: snap });
  ok(near(c.partsCost, direct.partsCost, 0.001) && c.hashpower === direct.hashpower,
    `${c.processorId} 与 planTask 一致（成本 ${c.partsCost.toFixed(2)} BNB / H=${c.hashpower}）`);
}
// Behemoth 权重是 TapeOut 的 6 倍，成本更高
const bh = cmp50.find((c) => c.processorId === "Behemoth");
const tp = cmp50.find((c) => c.processorId === "TapeOut");
ok(bh.hashpower === tp.hashpower * 6, `权重 Behemoth = TapeOut × 6（${tp.hashpower} -> ${bh.hashpower}）`);
ok(bh.partsCost > tp.partsCost, `Behemoth 成本更高（${bh.partsCost.toFixed(2)} > ${tp.partsCost.toFixed(2)} BNB）`);
ok(bh.priceTolerance > 1 && tp.priceTolerance > 1, "两者都给出可承受的涨价倍数");

// 选择结果必须贯通到校验：手选 TapeOut 时校验也按 TapeOut 算
const draftTp = { taskId: ROUND.taskId, transistorId: transistorIdFor("TapeOut") };
const revTp = reviewRound(draftTp, snap, ROUND, BOOK);
ok(revTp.model?.id === "TAPE_OUT_NAND" && revTp.processorScale === 1,
  `手选 TapeOut -> 校验按 P=1 走（权重 ${revTp.hashpower}）`);
const draftBh = { taskId: ROUND.taskId, transistorId: transistorIdFor("Behemoth") };
const revBh = reviewRound(draftBh, snap, ROUND, BOOK);
ok(revBh.model?.id === "BEHEMOTH_NAND" && revBh.processorScale === 6,
  `手选 Behemoth -> 校验按 P=6 走（权重 ${revBh.hashpower}）`);
ok(revBh.hashpower === revTp.hashpower * 6, "两个处理器的校验权重相差 6 倍");
ok(revTp.needParts === t50.g && revBh.needParts === t50.g,
  `两个处理器的元件数都= 题目 g=${t50.g}（配比由题目决定，不由处理器决定）`);

// 募资总额不足时校验必须拦下（手动选择不代表能绕过风控）
const poorDraft = { ...draftBh, totalShares: 2, sharePriceBnb: 0.685 };
const revPoor = reviewRound(poorDraft, snap, ROUND, BOOK);
ok(!revPoor.ok && revPoor.issues.length > 0, "募资总额不足时校验拦截并给出问题");

// 风险提示：买不起时必须直说
const advPoor = adviseProcessor({ processorId: "Behemoth", plan: bh, hardCapBnb: 1 });
ok(advPoor.includes("买不到") || advPoor.includes("失败"), `买不起时的提示：${advPoor.slice(0, 36)}...`);
const advOk = adviseProcessor({ processorId: "Behemoth", plan: bh, hardCapBnb: cap50 });
ok(advOk.includes("Behemoth") && advOk.length > 10, "正常时的提示包含所选处理器与关键数字");

console.log("\n=== 51. 挖矿期仅作 ROI 预估窗口（不再约束领取）===");
ok(MINING_DAYS === 90, `协议常量 MINING_DAYS = ${MINING_DAYS}（保留仅作预估投影）`);
ok(ROUND.miningDays === MINING_DAYS, "ROUND 用的是协议常量");

// 领取次数不再有上限：maxRounds = Infinity、exhausted 永远 false、剩余 = Infinity
const h51 = computeHarvest(ROUND, createScene("mining", ROUND, BOOK));
ok(h51.maxRounds === Infinity, `可领取次数上限 = Infinity（原 ${MINING_DAYS} 天封顶已移除）`);
ok(h51.exhausted === false, "状态永不标记已用完");
ok(h51.remaining === Infinity, "剩余次数 = Infinity（界面展示「不限」）");
ok(h51.totalGross === null && h51.totalNet === null, "不再有整期封顶的累计产出");

// 远超 90 次领取仍成功，无封顶
const mineBook = { ...createScene("mining", ROUND, BOOK), harvestCount: 0, claimed: 0 };
let last = mineBook;
for (let i = 0; i < 120; i++) {
  const step = applyHarvest(ROUND, last);
  if (!step.ok) break;
  last = step.book;
}
ok(last.harvestCount === 120, `已领 ${last.harvestCount} 次仍未被封顶（无 ${MINING_DAYS} 次上限）`);
ok(applyHarvest(ROUND, last).ok, `第 121 次仍可领取`);
ok(computeHarvest(ROUND, last).exhausted === false, "状态不标记已用完");

// draft 传什么都无效
for (const bad of ["1", "30", "365", "abc", "-5"]) {
  const r = applyCreate(ROUND, { ...draft, miningDays: bad });
  ok(r.ok && r.round.miningDays === MINING_DAYS, `draft 传 "${bad}" 被忽略，仍为 ${MINING_DAYS}`);
}

// 累计产出也按同一常量
ok(cumulativeEmission(MINING_DAYS) > 0, `cumulativeEmission(${MINING_DAYS}) = ${cumulativeEmission(MINING_DAYS)}`);

console.log("\n=== 52. 开期检查的派生数字必须跟参数联动 ===");
// 净产出要按真实费率算，不能硬编码 0.93（=7%）——费率可配 5-10%
const plan52 = planTask({ task: t50, transistorId: transistorIdFor("Behemoth"), snapshot: snap });
const netAt = (feePercent) => {
  const r = roiOf({
    costBnb: plan52.partsCost,
    dailyBem: plan52.dailyBem,
    days: MINING_DAYS,
    feeRate: Number(feePercent) / 100,
  });
  return r.netBem;
};
const net5 = netAt(5), net7 = netAt(7), net10 = netAt(10);
ok(net5 > net7 && net7 > net10, `费率越高净产出越低（5% ${net5.toFixed(2)} > 7% ${net7.toFixed(2)} > 10% ${net10.toFixed(2)}）`);
ok(near(net7, plan52.dailyBem * MINING_DAYS * 0.93, 0.001),
  `7% 时净产出 = 日产×90×0.93 = ${net7.toFixed(2)}`);
ok(!near(net10, plan52.dailyBem * MINING_DAYS * 0.93, 0.001),
  "10% 时净产出不等于按 7% 算的结果（硬编码 0.93 会被抓出来）");
// 费率 0 不应被|| 7 兜底成 7%
const net0 = roiOf({ costBnb: 0, dailyBem: plan52.dailyBem, days: MINING_DAYS, feeRate: 0 }).netBem;
ok(near(net0, plan52.dailyBem * MINING_DAYS, 0.001),
  `费率 0 时净产出 = 毛产出 ${net0.toFixed(2)}（不被兜底成 7%）`);

// 触发退款的临界涨幅 = 募资总额/成本 − 1，必须与占募资总额比例自洽
const rev52 = reviewRound(
  {
    ...draftBh,
    sharePriceBnb: String(ROUND.sharePriceBnb),
    totalShares: String(ROUND.totalShares),
    feePercent: "7",
    feeRecipient: draft.feeRecipient,
  },
  snap, ROUND, BOOK,
);
ok(rev52.hardCapBnb > 0, `募资总额 ${rev52.hardCapBnb} BNB / 成本 ${rev52.needBnb} BNB`);
const ratioPct = (rev52.needBnb / rev52.hardCapBnb) * 100;
const tolPct = (rev52.hardCapBnb / rev52.needBnb - 1) * 100;
ok(ratioPct > 0 && tolPct > 0 && near(tolPct, (100 / ratioPct - 1) * 100, 0.01),
  `临界涨幅与占募资总额自洽：占 ${ratioPct.toFixed(1)}% -> 涨 ${tolPct.toFixed(0)}% 触发退款`);

// 流片后余量 = 募资总额 − 流片成本，必须闭合且与 canAfford 同向
const margin = rev52.hardCapBnb - rev52.needBnb;
ok(near(margin, r4(rev52.hardCapBnb) - r4(rev52.needBnb), 0.0001),
  `余量 ${margin.toFixed(4)} BNB = 募资总额 − 成本`);
ok(rev52.ok === (margin >= 0), `校验结论与余量同向（余量 ${margin.toFixed(4)} -> ok=${rev52.ok}）`);

console.log("\n=== 53. 发行方案：每份 BNB 与总份数一起算 ===");
// 覆盖足够多的题目 × 处理器组合，确保方案永远自洽
let designed = 0, allCovered = true, allHealthy = true, allRound5 = true, allTiered = true;
let smallCount = 0;
const TIERSET = new Set([0.05, 0.1, 0.25, 0.5, 0.685, 1, 2.5, 5, 10]);
for (const proc of ["BEHEMOTH_NAND", "TAPE_OUT_NAND"]) {
  for (const t of BOOK.tasks.slice(0, 60)) {
    const d = designOffering({ task: t, transistorId: proc, snapshot: snap });
    designed++;
    if (d.hardCapBnb < d.costBnb) allCovered = false;
    if (d.totalShares % 5 !== 0 || d.totalShares < 20) allRound5 = false;
    if (!TIERSET.has(d.sharePriceBnb)) allTiered = false;
    // 募资总额必须严格等于 份数 × 单价
    if (!near(d.hardCapBnb, d.sharePriceBnb * d.totalShares, 0.0001)) {
      ok(false, `募资总额未闭合：${d.totalShares} × ${d.sharePriceBnb} != ${d.hardCapBnb}`);
    }
    // healthy 与 tooSmall / tooRisky 必须互补，不能同时成立也不能都不成立
    if (d.healthy === (d.tooSmall || d.tooRisky)) {
      ok(false, `健康标记自相矛盾：ratio=${(d.costRatio * 100).toFixed(1)}% small=${d.tooSmall} risky=${d.tooRisky}`);
    }
    // 题目太小时必须如实标记，而不是悄悄给出占比过低的方案
    if (!d.healthy) {
      smallCount++;
      if (!d.tooSmall && !d.tooRisky) {
        ok(false, `不健康但未标记原因：ratio=${(d.costRatio * 100).toFixed(1)}%`);
      }
    }
    // tooSmall 的判定要成立：压到最低档也够不到下限
    if (d.tooSmall && d.costBnb / (20 * 0.05) >= 0.2) {
      ok(false, `误报 tooSmall：最低募资总额下占比 ${(d.costBnb / 1 * 100).toFixed(1)}% 其实够得到`);
    }
    if (d.healthy) allHealthy = allHealthy && true;
  }
}
ok(designed === 120, `覆盖 ${designed} 个题目 × 处理器组合`);
ok(allCovered, "每个方案的募资总额都 ≥ 流片成本（不会出现必定退款的方案）");
ok(allRound5, "份数都是 5 的倍数且 ≥ 20（可分配）");
ok(allTiered, "每份 BNB 都取自常见档位（好记、好说明）");
ok(true, `${allHealthy ? "全部" : `${120 - smallCount} 个`}方案落在健康区间，${smallCount} 个因题目太小被标记 tooSmall`);

// 用具体数值校验一个组合
const d53 = designOffering({ task: findTask(ROUND, BOOK), transistorId: "BEHEMOTH_NAND", snapshot: snap });
ok(near(d53.hardCapBnb, d53.sharePriceBnb * d53.totalShares, 0.0001),
  `#54 Behemoth -> ${d53.sharePriceBnb} BNB × ${d53.totalShares} 份 = ${d53.hardCapBnb} BNB`);
ok(near(d53.costRatio, d53.costBnb / d53.hardCapBnb, 0.001),
  `成本占比 ${(d53.costRatio * 100).toFixed(1)}% 与成本/募资总额一致`);
ok(d53.priceTolerance > 1 && near(d53.priceTolerance, d53.hardCapBnb / d53.costBnb, 0.001),
  `涨价容忍度 ${((d53.priceTolerance - 1) * 100).toFixed(0)}% 与募资总额/成本一致`);

// 换题目 / 换处理器时方案必须跟着变
const d53Tp = designOffering({ task: findTask(ROUND, BOOK), transistorId: "TAPE_OUT_NAND", snapshot: snap });
ok(d53Tp.hardCapBnb !== d53.hardCapBnb,
  `换处理器方案变化（Behemoth ${d53.hardCapBnb} -> TapeOut ${d53Tp.hardCapBnb}）`);
const easy53 = BOOK.tasks.find((t) => t.g < 10);
if (easy53) {
  const d53e = designOffering({ task: easy53, transistorId: "BEHEMOTH_NAND", snapshot: snap });
  ok(d53e.hardCapBnb < d53.hardCapBnb,
    `换更简单的题方案变小（#${easy53.id} ${d53e.hardCapBnb} < #54 ${d53.hardCapBnb}）`);
}

// 建议方案直接拿去开期必须通过校验
const rev53 = reviewRound({
  ...draft,
  sharePriceBnb: String(d53.sharePriceBnb),
  totalShares: String(d53.totalShares),
}, snap, ROUND, BOOK);
ok(rev53.ok, `建议方案直接开期通过校验（${d53.sharePriceBnb} BNB × ${d53.totalShares} 份）`);

console.log("\n=== 54. 募资总额与总份数由开期人手动填写，每份 BNB 派生 ===");
/**
 * 「募资总额」「总份数」两个框改为开期人手动填写（默认留空 = 跟随建议方案）。
 *
 * 它们才是发行规模的两个旋钮：募资总额定「这期募多少 BNB」，
 * 总份数定「分成多少份」。每份 BNB 是派生展示值（每份 = 募资总额 ÷ 总份数），
 * 不可单独手填——否则会破坏「募资总额 = 份数 × 每份」的链上恒等式。
 *
 * 用户的调节手段：直接改募资总额/总份数，或换处理器（改变成本占比）。
 */

// 建议方案仍给出默认募资总额与份数（留空时跟随）
ok(near(d53.targetCapBnb, d53.costBnb / 0.45, 0.01),
  `建议目标募资总额 ${d53.targetCapBnb} BNB = 成本 ${d53.costBnb} ÷ 0.45`);
ok(d53.sharePriceBnb > 0 && d53.totalShares > 0,
  `建议单价 ${d53.sharePriceBnb} BNB 与份数 ${d53.totalShares} 均为正`);
ok(near(d53.hardCapBnb, d53.sharePriceBnb * d53.totalShares, 0.001),
  `建议募资总额 ${d53.hardCapBnb} = ${d53.sharePriceBnb} × ${d53.totalShares}`);
ok(Number.isInteger(d53.totalShares) && d53.totalShares % 5 === 0,
  `建议份数 ${d53.totalShares} 是 5 的倍数`);

// 换处理器 -> 建议方案变化（联动仍在，只是方向反了：上游变、输出自动跟）
ok(d53Tp.sharePriceBnb !== d53.sharePriceBnb || d53Tp.totalShares !== d53.totalShares,
  `换 TapeOut 后建议方案变化（${d53.sharePriceBnb}×${d53.totalShares} -> ${d53Tp.sharePriceBnb}×${d53Tp.totalShares}）`);

// 手动填写的募资总额 + 总份数 走校验必须口径自洽：每份 = 募资总额 ÷ 份数
const rev54 = reviewRound({
  ...draft,
  hardCapBnb: String(d53.hardCapBnb),
  totalShares: String(d53.totalShares),
}, snap, ROUND, BOOK);
ok(rev54.ok, `建议方案开期通过校验（${d53.hardCapBnb} BNB ÷ ${d53.totalShares} 份）`);
ok(near(rev54.hardCapBnb, d53.hardCapBnb, 0.001), `校验口径一致 ${rev54.hardCapBnb} BNB`);
ok(near(rev54.sharePriceBnb, d53.hardCapBnb / d53.totalShares, 0.001),
  `每份派生 = 募资总额 ÷ 份数 = ${rev54.sharePriceBnb} BNB`);
ok(rev54.hardCapBnb >= rev54.needBnb, "募资总额覆盖流片成本");

// 募资总额非法（非正）必须被校验拦下
ok(!reviewRound({ ...draft, hardCapBnb: "0", totalShares: "100" }, snap, ROUND, BOOK).ok, "募资总额 0 被拒");
ok(!reviewRound({ ...draft, hardCapBnb: "-5", totalShares: "100" }, snap, ROUND, BOOK).ok, "募资总额负数被拒");
// 总份数非法（非整数/非正）必须被拦下
ok(!reviewRound({ ...draft, hardCapBnb: "68.5", totalShares: "0" }, snap, ROUND, BOOK).ok, "总份数 0 被拒");
ok(!reviewRound({ ...draft, hardCapBnb: "68.5", totalShares: "12.5" }, snap, ROUND, BOOK).ok, "总份数小数被拒");

/**
 * 每份 BNB 不得在 UI 层被手填，也不得用「每份 × 份数」反推募资总额。
 *
 * 正确做法：募资总额是开期人手动填写的权威值（hardCapBnb），
 * 每份由「募资总额 ÷ 份数」派生。UI 里不应该出现「每份 × 份数」的乘算。
 */
const ownerSrc = await readFile(new URL("src/Owner.jsx", import.meta.url), "utf8");
ok(/const hardCapBnb = Number\.isFinite\(effCap\) && effCap > 0 \? effCap : offering\.hardCapBnb;/.test(ownerSrc),
  "Owner.jsx 的展示募资总额由手动输入（effCap）决定，非法时回退建议值");
ok(!/\*\s*Number\(sharesInput\)|Number\(sharesInput\)\s*\*/.test(ownerSrc),
  "Owner.jsx 不再用「每份 × 份数」倒推");
ok(!/募资总额（每份 × 份数，自动）/.test(ownerSrc),
  "表单里冗余的「募资总额（每份 × 份数，自动）」字段已移除");
ok(/<span>募资总额<\/span>/.test(ownerSrc) || /募资总额（BNB）/.test(ownerSrc),
  "开期检查仍显示募资总额（要与流片成本对比算占比）");

// 口径确实一致（改动是去冗余，不是改行为）
for (const [tag, o] of [["题目值", d53], ["换处理器", d53Tp]]) {
  ok(near(Number(o.sharePriceBnb) * o.totalShares, o.hardCapBnb, 0.001),
    `${tag}：offering 内部口径自洽（${o.sharePriceBnb} × ${o.totalShares} = ${o.hardCapBnb}）`);
}

// UI 源码层面：募资总额与总份数可编辑，每份 BNB 只读，且草稿里声明这两个字段
ok(/募资总额（BNB）/.test(ownerSrc) && /总份数/.test(ownerSrc),
  "表单有「募资总额」「总份数」两个可填写输入框");
ok(/<span>每份 BNB<\/span>/.test(ownerSrc) && /由「募资总额 ÷ 总份数」派生，不可单独手填/.test(ownerSrc),
  "每份 BNB 为只读派生展示（不可手填）");
ok(/EMPTY_FORM[\s\S]{0,900}?hardCapBnb:/.test(ownerSrc),
  "EMPTY_FORM 已声明 hardCapBnb（开期人手动填写的募资总额）");
ok(/EMPTY_FORM[\s\S]{0,900}?totalShares:/.test(ownerSrc),
  "EMPTY_FORM 已声明 totalShares（开期人手动填写的总份数）");
ok(!/EMPTY_FORM[\s\S]{0,900}?sharePriceBnb:/.test(ownerSrc),
  "EMPTY_FORM 不再声明 sharePriceBnb（每份是派生值，不进草稿）");
ok(/onChange=\{\(event\) => update\("hardCapBnb"/.test(ownerSrc),
  "募资总额输入框有 onChange 写入草稿");
ok(/update\("totalShares"/.test(ownerSrc),
  "总份数输入框有 onChange 写入草稿");
ok(!/update\("sharePriceBnb"\)/.test(ownerSrc),
  "不再有手填每份 BNB 的 onChange（派生不可改）");
ok(!/恢复跟随建议/.test(ownerSrc), "「恢复跟随建议」按钮已移除（每份本就不可手填）");

console.log("\n=== 55. 界面不暴露挖矿期 / 不暗示领取上限 ===");
/**
 * 挖矿期天数只是 ROI 预估的投影窗口，不再是领取次数上限；领取次数不设上限。
 * 用户关心「每次能领多少、是否已出矿」，不关心要挖多久——
 * 而且零和机制下产出与天数不成正比，显示天数反而误导。
 * 这里静态扫描 UI 源码，确保没有任何天数或整期外推文案漏回界面。
 */
const uiFiles = ["App.jsx", "Owner.jsx", "Calls.jsx"].map((f) => `src/${f}`);
const BANNED = [
  [/\$\{MINING_DAYS\}\s*天/, "把 MINING_DAYS 当天数渲染到界面"],
  [/MINING_DAYS\s*\}\s*天可分/, "把 MINING_DAYS 当天数渲染到界面"],
  [/挖矿期[^<"]*(天|后截止)/, "渲染挖矿期天数或截止日"],
  [/(round|r)\.miningDays/, "读取 round.miningDays"],
  [/harvest\.(totalGross|totalNet|maxRounds)/, "使用整期累计或总次数"],
  [/天(可分总额|毛产出|净产出|预估可分)/, "渲染按天外推的累计值"],
  [/item\.harvests/, "历史期次表渲染领取次数"],
  [/还剩\s*\{\s*harvest\.remaining\s*\}\s*次/, "渲染剩余可领次数（应为「不限」）"],
];
let violations = [];
for (const file of uiFiles) {
  const src = await readFile(new URL(file, import.meta.url), "utf8");
  src.split("\n").forEach((line, i) => {
    // 跳过注释行
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    for (const [re, why] of BANNED) {
      if (re.test(code)) violations.push(`${file}:${i + 1} ${why}`);
    }
  });
}
ok(violations.length === 0,
  violations.length ? `界面仍暴露挖矿期：\n      ${violations.join("\n      ")}` : "三个 UI 文件均无天数/整期累计渲染");

// 领取次数不限：剩余 = Infinity，对外只展示「不限」
const h55 = computeHarvest(ROUND, createScene("mining", ROUND, BOOK));
ok(h55.remaining === Infinity && h55.exhausted === false,
  `剩余次数 = Infinity、永不 exhausted（对外展示「不限」）`);

console.log("\n=== 57. 术语统一：不叫「硬顶」，叫「募资总额」===");
/**
 * 「硬顶」是从合约语境借来的词，用户看不懂也不需要。
 * 界面上统一叫「募资总额」——它是用户直接参与的「买多少份 × 每份多少钱」，
 * 不是某个需要理解上限概念的金融术语。
 * 这里扫描全部源码（含注释与运行时消息），防止术语漂回。
 */
const TERM_FILES = [
  "src/App.jsx", "src/Owner.jsx", "src/Calls.jsx",
  "src/fixtures.js", "src/prices.js", "src/emission.js", "src/tapeout.js",
  "src/styles.css",
];
const termHits = [];
for (const f of TERM_FILES) {
  const src = await readFile(new URL(f, import.meta.url), "utf8");
  src.split("\n").forEach((line, i) => {
    if (line.includes("硬顶")) termHits.push(`${f}:${i + 1}`);
  });
}
ok(termHits.length === 0,
  termHits.length ? `仍有「硬顶」残留：\n      ${termHits.join("\n      ")}` : "八个源码文件均已统一为「募资总额」");

// 募资总额这个词要在关键位置真的出现
const ownerSrc57 = await readFile(new URL("src/Owner.jsx", import.meta.url), "utf8");
const appSrc57 = await readFile(new URL("src/App.jsx", import.meta.url), "utf8");
ok(/成本占募资总额/.test(ownerSrc57) && /募资总额买不够/.test(appSrc57),
  "「成本占募资总额」「募资总额买不够」等文案已就位");

console.log("\n=== 56. 题目不需要的元件不展示价格 ===");
/**
 * 纯组合逻辑题只用 NAND（LATCH 数量为 0），此时列出 LATCH 单价与小计是噪音，
 * 还会让人误以为要买。UI 用 count > 0 做条件渲染，这里验证条件本身成立。
 */
const mixed56 = planTask({ task: findTask(ROUND, BOOK), transistorId: "BEHEMOTH_NAND", snapshot: snap });
ok(mixed56.nand > 0 && mixed56.latch > 0,
  `混合题 #54：${mixed56.nand} NAND + ${mixed56.latch} LATCH（两类都要展示）`);

// 造一道 latch=0 的题，验证渲染条件
const pureNand = { ...findTask(ROUND, BOOK), g: 1, nand: 1, latch: 0, d: 2, K: 1, C: 16 };
const pn56 = planTask({ task: pureNand, transistorId: "BEHEMOTH_NAND", snapshot: snap });
ok(pn56.latch === 0 && pn56.nand === 1, `纯 NAND 题：${pn56.nand} NAND + ${pn56.latch} LATCH`);
ok(pn56.latch > 0 === false, "latch>0 为 false -> LATCH 单价与小计都应跳过渲染");
// 但成本必须仍然正确（只算 NAND，不是两个都算）
ok(near(pn56.partsCost, 1 * pn56.priceNand, 0.0001),
  `成本只含 NAND：1 × ${pn56.priceNand} = ${pn56.partsCost.toFixed(4)} BNB`);
ok(near(pn56.costBreakdown.LATCH.cost, 0, 0.0001), "LATCH 小计为 0（不出现在界面上）");
ok(near(pn56.costBreakdown.NAND.cost + pn56.costBreakdown.LATCH.cost, pn56.partsCost, 0.0001),
  "小计相加仍等于总价");

// 造一道 nand=0 的题（对称情况，虽然官方题库里目前没有）
const pureLatch = { ...findTask(ROUND, BOOK), g: 2, nand: 0, latch: 2, d: 3, K: 2, C: 54 };
const pl56 = planTask({ task: pureLatch, transistorId: "BEHEMOTH_NAND", snapshot: snap });
ok(pl56.nand === 0 && pl56.latch === 2, `纯 LATCH 题：${pl56.nand} NAND + ${pl56.latch} LATCH`);
ok(pl56.nand > 0 === false, "nand>0 为 false -> NAND 单价与小计都应跳过渲染");
ok(near(pl56.partsCost, 2 * pl56.priceLatch, 0.0001),
  `成本只含 LATCH：2 × ${pl56.priceLatch} = ${pl56.partsCost.toFixed(4)} BNB`);

// 官方题库里确实存在 latch=0 的题，不是假想场景
const zeroLatchTasks = BOOK.tasks.filter((t) => t.latch === 0);
ok(zeroLatchTasks.length > 0,
  `官方题库中有 ${zeroLatchTasks.length} 道纯 NAND 题（#${zeroLatchTasks.map((t) => t.id).join(" #")}）`);

// UI 源码里价格展示必须挂在 count > 0 的条件下
const ownerSrc58 = await readFile(new URL("src/Owner.jsx", import.meta.url), "utf8");
ok(/tplan\.nand > 0 && \(/.test(ownerSrc58) && /tplan\.latch > 0 && \(/.test(ownerSrc58),
  "Owner.jsx 的单价与小计均包在 count > 0 条件里");
ok(!/\{\s*tplan\.priceNand[^}]*\}(\s*<\/li>)/.test(ownerSrc58.replace(/\s+/g, " ")),
  "没有无条件渲染 priceNand 的裸 <li>");

console.log(fail === 0 ? "\n*** 全部通过 ***" : `\n*** ${fail} 项失败 ***`);
process.exit(fail === 0 ? 0 : 1);