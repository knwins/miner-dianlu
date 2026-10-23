import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContractCalls } from "./Calls.jsx";
import { dealStatus } from "./dealStatus.js";
import OnChainPage from "./OnChain.jsx";
import { formatEther } from "./chain/client.js";
import { MarketTradePanel } from "./MarketTrades.jsx";
import { officialPartPrices } from "./OfficialPricePanel.jsx";
import { RefundRecords } from "./RefundRecords.jsx";
import { processorFromPartsContract } from "./tapeout.js";
import {
  formatUnitPrice,
} from "./prices.js";
import deployments from "./chain/deployments.json";
import {
  PAST_ROUNDS,
  QUOTE,
  ROUND,
  buildHolders,
  clampPriceInput,
  resolveCampaignDesign,
  reviewRound,
  shortAddress,
  round4,
  round5,
  priceText,
} from "./fixtures.js";

const EMPTY_FORM = {
  /**
   * 募资总额与总份数：开期人**手动填写**的两个发行参数。
   * 每份 BNB 由两者派生（每份 = 募资总额 ÷ 总份数），是只读展示值，不可单独手填——
   * 否则会破坏「募资总额 = 份数 × 每份」这一链上恒等式。
   *
   * ⚠️不再有「留空= 跟随建议方案」这回事：建议方案依赖处理器与元件报价，
   * 而发布期**处理器必须显式选择**（链上模式从工厂白名单选，见 transistors 字段；
   * 演示模式由系统按默认型号派生）。建议值只在选好处理器后才有意义。
   * 现在发行参数（总额/份数/天数）都是必填，由开期人自己定。
   *
   * 开期人可调的旋钮：募资总额、总份数、募集天数、本期处理器（链上必选）、挖矿产出服务费与分成表。
   * 元件合约不再由工厂默认写入：开期时从白名单显式选一个处理器，发布后该期锁定其元件合约。
   */
  /** 募资总额（BNB）：必填 */
  hardCapBnb: "",
  /** 总份数：必填正整数 */
  totalShares: "",
  fundingDays: "15",
  /**
   * 本期处理器（元件合约地址）：链上模式**必选**，从工厂白名单里选，开期后不可改；
   * 演示模式留空，由模拟引擎按默认型号派生（不写链上）。
   * T-79 核心改动：工厂不再有默认元件，开期人必须显式选。
   */
  transistors: "",
  /**
   * 服务费与分成（**链上参数**，口径：服务费真正上链）。
   *
   * ⚠️ **服务费是什么（口径澄清）**：
   *   本期的「服务费」是**挖矿产出奖励的服务费** —— 从矿池打进来的挖矿收益里按比例计提，
   *   分给下面的分成地址。**认筹款不收服务费**：认购人付的 BNB 全额进认购托管池，
   *   只用于买元件，链上不存在从认筹款抽服务费的路径。
   *
   * 流程：createCampaign 建期（sold == 0）→ 立刻调 Campaign.setServiceFee(bps, recipients, sharesBps)
   * 一次性写死，之后任何人可读、不可改。合约硬约束：费率 ≤ 10%，分成 ≤ 3 个地址，
   * 份额合计必须恰好 10000 bps，地址不能重复、不能是零地址。
   *
   * 服务费默认 5%（常见口径，开期人可改，1–10 整数）；
   * 分成**地址**一律留空：必须由开期人自己填，否则 reviewRound 会拦截
   * （地址格式、比例 1–100、合计恰为 100）。
   * 唯一例外是连接钱包后把地址回填成当前账户（运行时值，非默认值）。
   *
   * 分成**比例**默认 100（首行）：常见情形就是一个人独享全部挖矿产出服务费，
   * 少填一个字段。地址一填上就能直接提交。
   * 加第二个地址时新行仍留空——剩余比例怎么分是开期人的决定，不替他算。
   */
  feePercent: "5",
  feeRecipient: "",
  /** 分成表：首行比例默认 100（一人独享）。地址仍留空，必须由开期人填。 */
  feeShares: [{ address: "", sharePercent: "100" }],
};

/** 期次列表的「成交状态」与全站同一份口径（见 ./dealStatus.js） */


/** 毫秒 → 人类可读剩余时间（天/小时/分）。 */
function formatRemain(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

export function OwnerOverview({
  round, book, copy, pending, pendingTarget = "", actor, executeWait, history,
  onSwitchCampaign, onPlaceTransistorOrder, onOpenRefund, onRecoverBnb, onAbandonOrder, onCancelTransistorOrder, onConfirmTransistors,
  onPlaceTransistorAsk, onCancelTransistorAsk, onConfirmSale, onWithdrawMarketProceeds,
  onDepositToPool, onSetMiningPool, onSetPlan,   onRemoveCampaign, onOpenRound, onOpenAssets,
  account = "", connected = false, signer = null, chainHolders = null, holdersCampaign = "", quote, onInvoke,
  transistorUnitPrice = null,
  official = null,
}) {
  // 链上：托管池 raisedBnb 为权威；模拟：份数×单价
  const raised = book._chain ? Number(book.bnbPool || 0) : book.sold * round.sharePriceBnb;
  /**
   * 「已售未退」份数（当前债务）。sold 是单调的历史事实（本期卖出去过多少），
   * 退款不会让它变小；判断「还有没有人可退 / 池子够不够退」必须用 outstandingShares。
   */
  const outstanding = book.outstandingShares != null
    ? Number(book.outstandingShares)
    : Number(book.sold || 0);
  // 池子够不够按份全额退款。缺额时持份人仍可按比例自取，但卖单成交款要先进池子才有机会补上。
  const refundGap = Math.max(0, outstanding * Number(round.sharePriceBnb || 0) - raised);
  const design = resolveCampaignDesign(round, book);
  /**
   * 本期矿池地址（链上事实）。
   *
   * `book.miningPool` 由 readState 从 `Campaign.miningPool()` 读出：
   * 零地址 = 还没设过。之前这个面板只有一个空输入框，Owner 不知道链上是否已经设过，
   * 设完再回来看到的是同一个空框——容易重复设置或误以为没生效。
   */
  const poolOnChain = String(book.miningPool || "");
  const hasPoolOnChain = /^0x[0-9a-fA-F]{40}$/.test(poolOnChain) && !/^0x0{40}$/i.test(poolOnChain);
  const [miningPoolAddr, setMiningPoolAddr] = useState("");
  /**
   * 链上已设过矿池时回填输入框。
   *
   * 只在「链上有值且输入框还空」时回填，不覆盖用户正在输入的内容——
   * 用户改地址（入池前允许改）不会被刷新打断。
   */
  useEffect(() => {
    if (!hasPoolOnChain) return;
    setMiningPoolAddr((cur) => (cur ? cur : poolOnChain));
  }, [hasPoolOnChain, poolOnChain]);
  /**
   * 服务费与分成表：**读链上**（口径：服务费真正上链）。
   *
   * 之前这里读的是本地发行记录（localStorage），合约里根本没有这个字段，
   * 换台设备就看不到，还容易被误当成链上事实。现在 serviceFeeBps / feeShares
   * 都由 readState 从合约读出来，round 上带着，直接用。
   */
  const chainFeeShares = Array.isArray(round.feeShares) ? round.feeShares : [];
  const chainFeePercent = Number(round.serviceFeeBps ?? 0) / 100;
  const chainFeeSet = Boolean(round.serviceFeeSet);

  /**
   * 挂单参考价。
   *
   * 优先级：
   *   1. 链上材料市场单价（transistorUnitPrice，Owner 实际挂单/成交价）—— 最权威
   *   2. 官方市场最新价（tapeout.net market.json）—— NAND / LATCH 分别取价
   *   3. 都没有 → 0（表单不预填价格，Owner 自己填）
   *
   * 之前只有一个 suggestedUnit，NAND 与 LATCH 共用同一个价——
   * 但这两种元件市价差得很远（官方 TapeOut NAND 0.0501 / LATCH 0.0455，
   * Behemoth 差距更大），共用一个价必然有一边挂错价。这里按元件分开。
   */
  const minterUnit = (() => {
    if (transistorUnitPrice != null && transistorUnitPrice > 0n) {
      try { return Number(formatEther(transistorUnitPrice)); } catch { return 0; }
    }
    return 0;
  })();
  /** 官方市价：按当前处理器的 NAND / LATCH 分别取 */
  const officialParts = officialPartPrices(official, design.processorId || "TapeOut");
  const suggestedUnit = minterUnit > 0 ? minterUnit : 0;
  /** 每种元件的参考价（BNB/颗）：链上优先，官方市价其次 */
  const refPrice = {
    NAND: minterUnit > 0 ? minterUnit : officialParts.NAND,
    LATCH: minterUnit > 0 ? minterUnit : officialParts.LATCH,
  };
  const [nandQty, setNandQty] = useState("0");
  const [latchQty, setLatchQty] = useState("0");
  const [nandPrice, setNandPrice] = useState("0");
  const [latchPrice, setLatchPrice] = useState("0");
  const [sellNandQty, setSellNandQty] = useState("0");
  const [sellLatchQty, setSellLatchQty] = useState("0");
  const [sellNandPrice, setSellNandPrice] = useState("0");
  const [sellLatchPrice, setSellLatchPrice] = useState("0");
  /** 空闲时选挂买单还是卖单；有活单时由链上状态决定，不并存。 */
  const [orderSide, setOrderSide] = useState("buy");
  const priceTouched = useRef(false);
  const sellPriceTouched = useRef(false);
  useEffect(() => {
    priceTouched.current = false;
    sellPriceTouched.current = false;
  }, [book.address]);
  /**
   * 挂买单不再按任何推算预填数量：元件由材料市场买卖决定，买多少由 Owner 自己填。
   * 只把单价预填成当前市场参考价（用户改过就不再覆盖）。
   *
   * NAND 与 LATCH 各用各的参考价：市价差得远，共用一个价必然有一边挂错。
   */
  useEffect(() => {
    if (book.executePhase !== "buying" || priceTouched.current) return;
    if (refPrice.NAND > 0) setNandPrice(priceText(round5(refPrice.NAND)));
    if (refPrice.LATCH > 0) setLatchPrice(priceText(round5(refPrice.LATCH)));
  }, [book.address, book.executePhase, refPrice.NAND, refPrice.LATCH]);
  useEffect(() => {
    const heldNand = Number(book.partsNand) || 0;
    const heldLatch = Number(book.partsLatch) || 0;
    setSellNandQty(String(heldNand));
    setSellLatchQty(String(heldLatch));
    if (sellPriceTouched.current) return;
    if (heldNand > 0 && refPrice.NAND > 0) setSellNandPrice(priceText(round5(refPrice.NAND)));
    if (heldLatch > 0 && refPrice.LATCH > 0) setSellLatchPrice(priceText(round5(refPrice.LATCH)));
  }, [book.address, book.partsNand, book.partsLatch, refPrice.NAND, refPrice.LATCH]);
  const historyRows = (history != null ? history : PAST_ROUNDS).map((item) => {
    const onChainRow = history != null;
    const rowDesign = resolveCampaignDesign(
      { transistorId: onChainRow ? null : item.transistorId, processorId: onChainRow ? (item.processor || processorFromPartsContract(item.transistors) || null) : item.processor },
      onChainRow
        ? {
            _chain: true,
            hashpower: Number(item.hashpowerRaw) || 0,
            estHashpower: Number(item.estHashpower) || 0,
            transistorCount: Number(item.transistorCount) || 0,
          }
        : {
            hashpower: Number(item.hashpower) || 0,
            estHashpower: Number(item.estHashpower) || 0,
            transistorCount: Number(item.transistorCount) || 0,
          },
    );
    return {
      ...item,
      /** 处理器只作为链上事实展示；反推不出来就留空，由 UI 决定是否显示 */
      processor: rowDesign.processorKnown ? rowDesign.processorId : "",
      processorInferred: rowDesign.processorInferred,
    };
  });
  const [statusFilter, setStatusFilter] = useState("全部");
  const [pageIndex, setPageIndex] = useState(1);
  const [openKey, setOpenKey] = useState(null);
  const [detailPane, setDetailPane] = useState("ops");
  const [dialog, setDialog] = useState(null);
  const STATUS_ORDER = ["全部", "募集中", "待执行", "挖矿中", "已结束", "执行失败"];
  const presentStatuses = Array.from(new Set(
    historyRows.map((row) => row.status).filter((name) => name && name !== "—" && !STATUS_ORDER.includes(name))
  ));
  const statusOptions = [
    ...STATUS_ORDER.filter((name) => name === "全部" || historyRows.some((row) => row.status === name)),
    ...presentStatuses,
  ];
  const visibleRows = historyRows.filter((row) => statusFilter === "全部" || row.status === statusFilter);
  const rowKey = (item) => item.address || `sim-${item.id}`;
  const opened = historyRows.find((row) => rowKey(row) === openKey) || null;
  const isLive = Boolean(
    opened && (
      (opened.address && String(round.contract || "").toLowerCase() === String(opened.address).toLowerCase())
      || (!opened.address && opened.id === round.id)
    )
  );

  function openCampaign(item, pane = "ops") {
    setDetailPane(pane);
    setOpenKey(rowKey(item));
    if (item.address && onSwitchCampaign) onSwitchCampaign(item.address);
  }

  function openTool(item, pane) {
    setDialog({ key: rowKey(item), pane });
    if (item.address && onSwitchCampaign) onSwitchCampaign(item.address);
  }

  function openRound(item) {
    setDialog(null);
    if (item.address && onSwitchCampaign) onSwitchCampaign(item.address);
    if (onOpenRound) onOpenRound();
  }

  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setDialog(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialog]);

  const isOwner = actor?.role === "owner";
  // 取消挂单后合约回到待挂单；未重新挂单前不可 execute（priceLock/元件数已清）
  const canExecute = isOwner && !book.executionFailed && Number(book.priceLock || 0) > 0 && Number(book.transistorCount || 0) > 0;
  const planWritten = Number(book.estHashpower) > 0 || Number(book.transistorCount) > 0;
  const sceneTitle =
    book.scene === "funding" ? "募集中"
      : book.scene === "executing" ? "待执行"
        : book.scene === "mining" ? "挖矿中"
          : "—";
  // 结束状态不在 scene 里：执行失败且份额全部退回（sold 归零）才叫已结束；
  // 募集到期仍未售罄同样不会再进入执行，也按已结束展示。
  const liveEnded = Boolean(book.executionFailed) && outstanding === 0;
  const liveFundingExpired = book.scene === "funding"
    && Number(book.endsAt) > 0
    && Date.now() > Number(book.endsAt)
    && Number(book.sold || 0) < Number(round.totalShares || 0);
  const liveStatus = liveEnded || liveFundingExpired
    ? { badge: "已结束", tone: "done" }
    : book.executionFailed
      ? { badge: "执行失败", tone: "back" }
      : { badge: copy?.badge || "—", tone: copy?.tone || "live" };
  const nextActionByStatus = (status) => {
    if (status === "募集中") return "补 setPlan / 等待售罄";
    if (status === "待执行") return "挂单 → 确认 → 入池";
    if (status === "挖矿中") return "份额转让";
    if (status === "已结束") return "查看退款记录";
    if (status === "执行失败") return "原路退款 / 降价重挂";
    return "查看详情";
  };

  const PAGE_SIZE = 5;
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const page = Math.min(pageIndex, pageCount);
  const pageRows = visibleRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rangeFrom = visibleRows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeTo = Math.min(page * PAGE_SIZE, visibleRows.length);
  const dialogRow = dialog ? historyRows.find((row) => rowKey(row) === dialog.key) : null;
  const holdersForRound = book._chain
    && holdersCampaign
    && round.contract
    && String(holdersCampaign).toLowerCase() === String(round.contract).toLowerCase()
    ? chainHolders
    : null;
  const dialogLive = Boolean(
    dialogRow && (
      (dialogRow.address && String(round.contract || "").toLowerCase() === String(dialogRow.address).toLowerCase())
      || (!dialogRow.address && dialogRow.id === round.id)
    )
  );
  const dialogTitle = { ops: "合约操作", holders: "份额明细", calls: "合约调用", onchain: "链上调试" }[dialog?.pane] || "";
  /** 弹窗内的标签页：四个工具合到一个弹窗里切换，避免开四个不同的弹窗 */
  const DIALOG_TABS = [
    { id: "ops", label: "合约操作" },
    { id: "holders", label: "份额明细" },
    { id: "calls", label: "合约调用" },
    { id: "onchain", label: "链上调试" },
  ];
  const soldPct = round.totalShares > 0 ? Math.min(100, Math.round((book.sold / round.totalShares) * 100)) : 0;
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  const hashLabel = Number(book.hashpower) > 0
    ? `${Number(book.hashpower).toLocaleString()} H`
    : Number(book.estHashpower) > 0
      ? `${Number(book.estHashpower).toLocaleString()} H`
      : "未记录";
  // 链上没有实时算力 getter：book.hashpower 就是 setPlan 写入的 estHashpower，一律按「预估」展示。
  const hashHint = Number(book.hashpower) > 0 || Number(book.estHashpower) > 0 ? "setPlan 预估" : "尚未写入 setPlan";

  /**
   * 写操作回调：缺省即视为接线缺失，**直接抛错**，不给「点了没反应」的机会。
   *
   * 入池这两步之前写的是 `onSetMiningPool?.(...)` / `onDepositToPool?.()`：可选调用在
   * 回调没传进来时静默跳过，按钮点击毫无反馈、连控制台报错都没有——用户只看到按钮闪一下。
   * 排查这种问题的成本远高于省下的两个 `?.`。
   */
  function requireOps(name, fn) {
    return (...args) => {
      if (typeof fn !== "function") {
        throw new Error(`${name} 回调未接线：OwnerDesk → OwnerOverview 的 props 里漏传了它`);
      }
      return fn(...args);
    };
  }

  const submitMiningPool = requireOps("setMiningPool", onSetMiningPool);
  const submitDepositToPool = requireOps("depositToPool", onDepositToPool);

  function renderOps() {
    // 订单/结算状态一变就重读市场流水（挂单、成交、确认到账、提取卖出款）。
    const marketRefreshKey = [
      book.executePhase, book.nandBidId, book.latchBidId,
      book.nandRemaining, book.latchRemaining,
      book.nandAskRemaining, book.latchAskRemaining, book.marketOwed,
      book.partsNand, book.partsLatch, book.orderFilled,
    ].join("|");
    return (
      <div className="detail-split">
        <article className="card">
              <div className="card-header">
                <span>本期操作 · {sceneTitle}</span>
                <span className="stat-label">身份：{actor?.label || "未连接"}</span>
              </div>
              <div className="card-body">
                {book.scene === "funding" && (
                  <>
                    <ul className="bill">
                      <li><span>募集进度</span><strong>{book.sold}/{round.totalShares} 份 · {round4(raised)} BNB</strong></li>
                      <li><span>setPlan</span><strong>{planWritten ? "已写入" : "尚未写入"}</strong></li>
                      <li className="due"><span>本阶段 Owner 可做</span><strong>写入预估算力 / 元件数；等待售罄</strong></li>
                    </ul>
                    <div className="actions">
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={!isOwner || Boolean(pending) || !onSetPlan}
                        onClick={onSetPlan}
                      >
                        {pending === "setPlan" ? "写入中…" : planWritten ? "更新 setPlan" : "写入 setPlan"}
                      </button>
                      {onOpenRound && (
                        <button className="btn btn-inline" type="button" onClick={onOpenRound}>
                          去 BEM挖矿认筹
                        </button>
                      )}
                    </div>
                    <p className="fine">
                      募集期用户在「BEM挖矿认筹」按份认筹。Owner 可先 setPlan，把预估算力写上链，供用户核对。
                      {!isOwner && " 当前钱包不是 Factory Owner，无法写 setPlan。"}
                    </p>
                  </>
                )}

                {book.scene === "executing" && (() => {
                  const phaseLabel =
                    book.executePhase === "ready" ? "已到账 · 待入池"
                      : book.executePhase === "listed" ? "挂单中 · 待成交"
                        : "待挂单";
                  // 买多少由 Owner 自己填：元件在材料市场自由买卖，不按任何推算配比限制，两条腿都可用。
                  const nandN = Math.max(0, Math.floor(Number(nandQty) || 0));
                  const latchN = Math.max(0, Math.floor(Number(latchQty) || 0));
                  const nandP = Number(nandPrice) || 0;
                  const latchP = Number(latchPrice) || 0;
                  const orderCostRaw = nandN * nandP + latchN * latchP;
                  const orderCost = round5(orderCostRaw);
                  const heldNand = Number(book.partsNand) || 0;
                  const heldLatch = Number(book.partsLatch) || 0;
                  const sellNandN = Math.min(heldNand, Math.max(0, Math.floor(Number(sellNandQty) || 0)));
                  const sellLatchN = Math.min(heldLatch, Math.max(0, Math.floor(Number(sellLatchQty) || 0)));
                  const sellNandP = Number(sellNandPrice) || 0;
                  const sellLatchP = Number(sellLatchPrice) || 0;
                  const sellProceeds = round5(sellNandN * sellNandP + sellLatchN * sellLatchP);
                  const buyOpen = book.executePhase === "listed";
                  const askOpen = Boolean(book.askOpen);
                  const idle = !buyOpen && !askOpen;
                  // Ready：买单已确认。这里才能卖、入池或退款。卖单成交后必须再确认，才回到可卖、可退。
                  const ready = book.executePhase === "ready";
                  const askRecorded = (Number(book.nandAskQty) || 0) > 0 || (Number(book.latchAskQty) || 0) > 0;
                  const marketOwedEarly = Number(book.marketOwed) || 0;
                  // 测试网 MockMaterialMarket：可直接在当前买、卖单卡片上模拟对手方成交。
                  const mockMarket = Boolean(
                    book._chain
                    && Number(deployments.chainId) === 97
                    && (deployments.materialMarket || deployments.minter)
                    && book.market
                    && String(book.market).toLowerCase() === String(deployments.materialMarket || deployments.minter).toLowerCase()
                  );
                  const saleSettled = ready && !askOpen && (askRecorded || marketOwedEarly > 0);
                  const canBuy = raised > 0 && idle && book.executePhase === "buying";
                  const legacyReady = ready && book.readyExit === false;
                  // 挂卖单要求**市场真的有卖单侧**。官方材料市场只有买单侧
                  // （placeAsk / asks / nextAskId / cancelAsk / fillAsk 都不存在），
                  // 这时 placeTransistorAsk 在链上必然 revert，前端不能给入口。
                  const canSell = Boolean(book.marketAskSide) && (heldNand > 0 || heldLatch > 0) && ready && !legacyReady && !askOpen && !saleSettled;
                  const side = buyOpen ? "buy" : askOpen || canSell || saleSettled ? "sell" : "buy";
                  /** 入池只要求手里有元件，不再比对推算出来的配比 */
                  const partsEnough = heldNand + heldLatch > 0;
                  // 合约 confirmTransistors() 要求两条腿 remaining 全为 0 **并且** 本期真的持有对应数量的元件。
                  // 只看 orderFilled 就放行会让「已成交但没发货」的单在链上被 TransistorsNotReady 拒绝。
                  const needNandOnHand = Number(book.nandQty) || 0;
                  const needLatchOnHand = Number(book.latchQty) || 0;
                  const partsShortNand = Math.max(0, needNandOnHand - heldNand);
                  const partsShortLatch = Math.max(0, needLatchOnHand - heldLatch);
                  const partsForOrderEnough = partsShortNand === 0 && partsShortLatch === 0;
                  const partsShortLabel = [
                    partsShortNand > 0 ? `${partsShortNand} NAND` : null,
                    partsShortLatch > 0 ? `${partsShortLatch} LATCH` : null,
                  ].filter(Boolean).join(" + ");
                  // 托管额超过 raisedBnb 时不允许点提交（链上也不会真正挂出）。
                  const overBudget = orderCostRaw > raised;
                  const canPlaceBuy = isOwner && canBuy && side === "buy" && !overBudget
                    && (nandN > 0 || latchN > 0)
                    && (nandN === 0 || nandP > 0)
                    && (latchN === 0 || latchP > 0);
                  const canPlaceSell = isOwner && canSell && side === "sell" && (sellNandN > 0 || sellLatchN > 0)
                    && (sellNandN === 0 || sellNandP > 0) && (sellLatchN === 0 || sellLatchP > 0);
                  const bidRows = [
                    Number(book.nandQty) > 0
                      ? { side: "buy", part: "NAND", id: book.nandBidId || "—", qty: book.nandQty, price: book.nandPrice, remaining: book.nandRemaining }
                      : null,
                    Number(book.latchQty) > 0
                      ? { side: "buy", part: "LATCH", id: book.latchBidId || "—", qty: book.latchQty, price: book.latchPrice, remaining: book.latchRemaining }
                      : null,
                  ].filter(Boolean);
                  const askRows = book.marketAsks ? [
                    Number(book.nandAskQty) > 0
                      ? { side: "sell", part: "NAND", id: book.nandAskId || "—", qty: book.nandAskQty, price: book.nandAskPrice, remaining: book.nandAskRemaining }
                      : null,
                    Number(book.latchAskQty) > 0
                      ? { side: "sell", part: "LATCH", id: book.latchAskId || "—", qty: book.latchAskQty, price: book.latchAskPrice, remaining: book.latchAskRemaining }
                      : null,
                  ].filter(Boolean) : [];
                  const legOpen = (row) => {
                    if (row.side === "buy") {
                      if (book.executePhase !== "listed") return false;
                      if (row.remaining == null) return !book.orderFilled;
                      return Number(row.remaining) > 0;
                    }
                    if (row.remaining == null) return askOpen;
                    return Number(row.remaining) > 0;
                  };
                  const liveRows = buyOpen ? bidRows : askOpen ? askRows : [];
                  {/*
                   * 步骤条要落在真实阶段上：
                   * 旧版 buyOpen 一律算第 2 步「确认到账」，但挂单还在等成交时
                   * 根本不能确认（合约要求 remaining 全 0），高亮会指错下一步。
                   * 只有买单全部成交（orderFilled）才进「确认到账」。
                   */}
                  const flowStep = book.executePhase === "ready" ? 3 : book.orderFilled ? 2 : 1;
                  // 卖单成交款留在市场 owed 里，未提取时 openRefund 会被合约拒绝。
                  const marketOwed = marketOwedEarly;
                  const canWithdraw = isOwner && book.marketAsks && askOpen && marketOwed > 0;
                  const canConfirmSale = isOwner && saleSettled;
                  const canRefund = isOwner && !askOpen && !saleSettled && marketOwed <= 0
                    && outstanding > 0
                    && (book.executePhase === "buying" || (ready && !legacyReady));
                  const dustOnly = isOwner && outstanding === 0 && Number(book.bnbPool || 0) > 0;
                  const refundHint = askOpen
                    ? "卖单还挂着，不能退款"
                    : saleSettled
                      ? "先确认卖出，再退款"
                      : legacyReady
                        ? "这期确认到账后不能退款，只能入池"
                        : outstanding === 0
                          ? "份额已全部退完，没有可退对象；池子里的尾差用「取回剩余 BNB」扫出"
                          : undefined;
                  // 放弃挂单：一次撤销买单剩余 + 撤卖单 + 提取卖出款 + 按池子退款，不需要逐项操作。
                  // 成交的部分已上链不可撤；只有还剩未成交时才允许放弃。
                  const hasOpenLeg = [book.nandRemaining, book.latchRemaining, book.nandAskRemaining, book.latchAskRemaining]
                    .some((remaining) => remaining == null || Number(remaining) > 0);
                  const canAbandon = isOwner && ((buyOpen && hasOpenLeg) || askOpen);
                  const nextHint = saleSettled
                    ? "卖单已成交。点「确认卖出」收到 BNB 并回到待挂单，之后才能再挂买单或退款。"
                    : askOpen
                      ? "卖单挂着。全部成交后确认；还没卖完可以取消剩余。"
                    : legacyReady
                      ? "这期是已上线的旧合约。确认到账之后只能入池，不能单独取出元件，也不能挂卖或退款。"
                    : ready
                      ? (partsEnough
                        ? "买单已确认。可以挂卖、退款，或取出元件；也可直接 depositToPool 投入矿池。"
                        : "手里还没有元件，不能入池。先挂买单买入并确认到账，或退款。")
                      : outstanding === 0
                        ? "已全部退款（份数归零），池子里若还有卖单溢价，Owner 可用「取回 BNB」扫出。"
                        : buyOpen
                          ? (book.orderFilled
                            ? (partsForOrderEnough
                              ? "买单已成交齐，点「确认到账」。确认后才能卖、入池或退款。"
                              : `买单已成交，但元件还没进本期合约（还缺 ${partsShortLabel || "元件"}）。` +
                                (mockMarket
                                  ? "点「补发元件」按缺额 mint 后再确认；链上 confirmTransistors 要求元件余额到位。"
                                  : "等卖家把元件转到本期合约后，再点「确认到账」。"))
                            : "等待市场成交。未成交部分可以取消；成交的不能撤销。")
                          : canBuy
                            ? "挂买单买入元件，买多少自己定。成交并确认后，才能卖、入池或退款。"
                            : book.executionFailed
                              ? "上次挂单超余额未挂出，改低单价重试或退款。"
                              : "当前不能挂单。";
                  const canConfirm = isOwner && buyOpen && (!book.marketOrders || (book.orderFilled && partsForOrderEnough));
                  const confirmHint = !buyOpen
                    ? undefined
                    : !book.orderFilled
                      ? "买单还没全部成交"
                      : !partsForOrderEnough
                        ? `元件还没到账：还缺 ${partsShortLabel || "元件"}` + (mockMarket ? "。点「补发元件」补齐后再确认。" : "。等卖家把元件转到本期合约后再确认。")
                        : undefined;

                  const renderLegForm = (kind) => {
                    const isBuy = kind === "buy";
                    /** 每条腿的市价来源：链上单价优先，官方市价其次 */
                    const priceSource = (part) => (minterUnit > 0 ? "链上市场单价" : "官方市价");
                    const legs = isBuy
                      ? [
                          { key: "nand", label: "NAND", qty: nandQty, setQty: setNandQty, price: nandPrice, setPrice: setNandPrice, touch: priceTouched, quote: refPrice.NAND, source: priceSource("NAND") },
                          { key: "latch", label: "LATCH", qty: latchQty, setQty: setLatchQty, price: latchPrice, setPrice: setLatchPrice, touch: priceTouched, quote: refPrice.LATCH, source: priceSource("LATCH") },
                        ].filter(Boolean)
                      : [
                          heldNand > 0 && { key: "nand", label: "NAND", qty: sellNandQty, setQty: setSellNandQty, price: sellNandPrice, setPrice: setSellNandPrice, touch: sellPriceTouched, quote: refPrice.NAND, source: priceSource("NAND"), max: heldNand },
                          heldLatch > 0 && { key: "latch", label: "LATCH", qty: sellLatchQty, setQty: setSellLatchQty, price: sellLatchPrice, setPrice: setSellLatchPrice, touch: sellPriceTouched, quote: refPrice.LATCH, source: priceSource("LATCH"), max: heldLatch },
                        ].filter(Boolean);
                    if (legs.length === 0) {
                      return <p className="flow-empty">{isBuy ? "填写要买的 NAND / LATCH 数量与单价。" : "暂无库存可卖。"}</p>;
                    }
                    return (
                      <div className="flow-form">
                        {/*
                         * 列宽不再由 table-layout: fixed 四等分决定 ——
                         * 四等分会让「元件」白占 130px、让「市价」的 40px 内容
                         * 贴在列左端而右侧空出 90px。这里给死前四列的最小需求，
                         * 余量留给「市价」，数字列统一右对齐（见 .flow-table-order）。
                         */}
                        <table className="flow-table flow-table-order">
                          <colgroup>
                            <col className="col-part" />
                            <col className="col-qty" />
                            <col className="col-price" />
                            <col className="col-quote" />
                          </colgroup>
                          <thead>
                            <tr>
                              <th>元件</th>
                              <th>数量</th>
                              <th>{isBuy ? "买价 BNB" : "卖价 BNB"}</th>
                              <th>市价</th>
                            </tr>
                          </thead>
                          <tbody>
                            {legs.map((leg) => (
                              <tr key={leg.key}>
                                <td>
                                  <strong>{leg.label}</strong>
                                  {leg.max != null && <span className="flow-max">持有 {leg.max}</span>}
                                </td>
                                <td>
                                  <input inputMode="numeric" value={leg.qty} disabled={!isOwner || Boolean(pending)} onChange={(e) => leg.setQty(e.target.value)} />
                                </td>
                                <td>
                                  <input
                                    inputMode="decimal"
                                    step="0.00001"
                                    placeholder="0.00000"
                                    title="单价最多五位小数（0.00001 BNB/颗）"
                                    value={leg.price}
                                    disabled={!isOwner || Boolean(pending)}
                                    onChange={(e) => { leg.touch.current = true; leg.setPrice(clampPriceInput(e.target.value)); }}
                                  />
                                </td>
                                <td>
                                  {leg.quote > 0 ? (
                                    <button
                                      type="button"
                                      className="flow-quote"
                                      title={`点击填入市价（${leg.source}）`}
                                      onClick={() => { leg.touch.current = true; leg.setPrice(priceText(round5(leg.quote))); }}
                                    >
                                      <span className="flow-quote-val">{formatUnitPrice(round5(leg.quote))}</span>
                                      <em>
                                        {leg.source}
                                        <span className="flow-quote-hint"> · 点填</span>
                                      </em>
                                    </button>
                                  ) : <span className="muted-value">无市价</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="flow-form-bar">
                          <span className={overBudget && isBuy ? "is-warn" : undefined}>
                            {isBuy
                              ? `托管 ${orderCost} BNB · 可用 ${round4(raised)}${overBudget ? " · 超余额不会挂出" : ""}`
                              : `预估收入 ${sellProceeds} BNB`}
                          </span>
                          {isBuy ? (
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={!canPlaceBuy || Boolean(pending)}
                              onClick={() => onPlaceTransistorOrder?.({
                                nandQty: nandN,
                                latchQty: latchN,
                                nandPrice: nandN > 0 ? String(nandP) : "0",
                                latchPrice: latchN > 0 ? String(latchP) : "0",
                              })}
                            >
                              {pending === "placeTransistorOrder" ? "提交中…" : "提交买单"}
                            </button>
                          ) : (
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={!canPlaceSell || Boolean(pending)}
                              onClick={() => onPlaceTransistorAsk?.({
                                nandQty: sellNandN,
                                latchQty: sellLatchN,
                                nandPrice: sellNandN > 0 ? String(sellNandP) : "0",
                                latchPrice: sellLatchN > 0 ? String(sellLatchP) : "0",
                              })}
                            >
                              {pending === "placeTransistorAsk" ? "提交中…" : "提交卖单"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  };

                  return (
                    <div className="ops-exec">
                      {/*
                       * 只留「子状态 / 处理器」。
                       * 资金与元件不在这里报：弹窗顶部概览条已经有份数、募资、
                       * 算力、已买入元件、已入矿池五项，这里再写一遍就是同一数据
                       * 在同一个弹窗里出现三次（旧版「库存」+「资金 / 库存」就是这样，
                       * 而 raised 本身就是 bnbPool，与右栏「托管 BNB」同一个变量）。
                       * 挂买单能用多少 BNB，由表单栏的「可用 X BNB」现算现显示。
                       */}
                      <ul className="bill ops-bill">
                        <li><span>子状态</span><strong>{phaseLabel}</strong></li>
                        {design.processorKnown ? (
                          <li><span>处理器</span><strong>{design.processorId} · P={design.processorScale}</strong></li>
                        ) : null}
                      </ul>

                      <ol className="flow-steps" aria-label="待执行流程">
                        <li className={flowStep === 1 ? "is-current" : flowStep > 1 ? "is-done" : ""}>
                          <span>1</span>挂单
                        </li>
                        <li className={flowStep === 2 ? "is-current" : flowStep > 2 ? "is-done" : ""}>
                          <span>2</span>确认到账
                        </li>
                        <li className={flowStep === 3 ? "is-current" : ""}>
                          <span>3</span>入池
                        </li>
                      </ol>

                      <p className="flow-next"><strong>下一步</strong>{nextHint}</p>

                      {/* 上：当前挂单；下：操作表单 / 主按钮 */}
                      {!legacyReady && (book.executePhase === "buying" || book.executePhase === "listed" || ready || askOpen || marketOwed > 0) && (
                        <div className="flow-panel">
                          <div className="flow-panel-head">
                            <div>
                              {/*
                               * 只留标题：这段原本每个分支都有一句说明，但和正上方
                               * 「下一步」的 nextHint 逐字重复（例如买单两处都写
                               * 「买多少自己定，确认后才能卖、入池或退款」）。
                               * 说明归 nextHint 一处，这里只交代这是哪张单。
                               */}
                              <h3>
                                {buyOpen ? "当前买单"
                                  : askOpen ? "当前卖单"
                                    : saleSettled ? "卖单待确认"
                                      : side === "sell" ? "挂卖中" : "挂买中"}
                              </h3>
                            </div>
                          </div>

                          <div className="flow-panel-body">
                            {(buyOpen || askOpen) ? (
                              <>
                                <table className="flow-table">
                                  <thead>
                                    <tr>
                                      <th>元件</th>
                                      <th>挂出</th>
                                      <th>进度</th>
                                      <th>单号</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {liveRows.map((row) => {
                                      const filled = Number(row.qty) - (row.remaining == null ? 0 : Number(row.remaining));
                                      const open = legOpen(row);
                                      return (
                                        <tr key={`${row.side}-${row.part}`}>
                                          <td><strong>{row.part}</strong></td>
                                          <td>{row.qty} × {formatUnitPrice(round5(row.price || 0))} BNB</td>
                                          <td className={open ? "is-open" : "is-done"}>
                                            {open
                                              ? (row.remaining == null ? "挂单中" : `剩 ${Number(row.remaining)} · 成 ${Math.max(0, filled)}`)
                                              : "已成交"}
                                          </td>
                                          <td className="mono">#{String(row.id)}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                                <div className="flow-panel-actions">
                                  {buyOpen && (
                                    <>
                                      <button
                                        className="btn btn-primary"
                                        type="button"
                                        disabled={!canConfirm || Boolean(pending)}
                                        onClick={onConfirmTransistors}
                                        title={canConfirm ? undefined : confirmHint}
                                      >
                                        {pending === "confirmTransistors"
                                          ? "确认中…"
                                          : book.orderFilled
                                            ? (partsForOrderEnough ? "确认到账" : "等待元件到账…")
                                            : "等待成交…"}
                                      </button>
                                      {!book.orderFilled && (
                                        <button
                                          className="btn btn-inline"
                                          type="button"
                                          disabled={!isOwner || Boolean(pending)}
                                          onClick={onCancelTransistorOrder}
                                        >
                                          {pending === "cancelTransistorOrder" ? "取消中…" : "取消买单"}
                                        </button>
                                      )}
                                      {mockMarket && (!book.orderFilled || !partsForOrderEnough) && (
                                        <button
                                          className="btn btn-inline"
                                          type="button"
                                          disabled={!connected || Boolean(pending)}
                                          onClick={() => onInvoke("simulateFillCampaignBids", {})}
                                          title={book.orderFilled
                                            ? "测试网 Mock：买单已成交但元件没进本期合约，点这里按缺额补发元件（mint），之后即可确认到账"
                                            : "测试网 Mock 材料市场：代替卖方成交这两张买单，并把测试元件铸给本期合约"}
                                        >
                                          {pending === "simulateFillCampaignBids"
                                            ? "撮合中…"
                                            : book.orderFilled ? "补发元件" : "模拟成交"}
                                        </button>
                                      )}
                                    </>
                                  )}
                                  {canWithdraw && (
                                    <button
                                      className="btn btn-primary"
                                      type="button"
                                      disabled={!isOwner || Boolean(pending)}
                                      onClick={onWithdrawMarketProceeds}
                                    >
                                      {pending === "withdrawMarketProceeds" ? "提取中…" : "提取卖出款"}
                                    </button>
                                  )}
                                  {askOpen && (
                                    <button
                                      className="btn btn-inline"
                                      type="button"
                                      disabled={!isOwner || Boolean(pending)}
                                      onClick={onCancelTransistorAsk}
                                      title="只撤还没卖掉的部分"
                                    >
                                      {pending === "cancelTransistorAsk" ? "取消中…" : "取消卖单"}
                                    </button>
                                  )}
                                  {askOpen && mockMarket && (
                                    <button
                                      className="btn btn-inline"
                                      type="button"
                                      disabled={!connected || Boolean(pending)}
                                      onClick={() => onInvoke("simulateFillCampaignAsks", {})}
                                      title="测试网 Mock 材料市场：代替买方按挂单价吃掉这两张卖单，卖出款记入市场 owed"
                                    >
                                      {pending === "simulateFillCampaignAsks" ? "吃单中…" : "模拟吃单"}
                                    </button>
                                  )}
                                </div>
                              </>
                            ) : saleSettled ? (
                              <div className="flow-panel-actions">
                                <button
                                  className="btn btn-primary"
                                  type="button"
                                  disabled={!canConfirmSale || Boolean(pending)}
                                  onClick={onConfirmSale}
                                >
                                  {pending === "confirmSale" ? "确认中…" : "确认卖出"}
                                </button>
                                <span className="flow-note">确认后才能再挂买单或退款。</span>
                              </div>
                            ) : marketOwed > 0 && !canBuy ? (
                              <div className="flow-panel-actions">
                                <button
                                  className="btn btn-primary"
                                  type="button"
                                  disabled={!isOwner || Boolean(pending)}
                                  onClick={onWithdrawMarketProceeds}
                                >
                                  {pending === "withdrawMarketProceeds" ? "提取中…" : "提取卖出款"}
                                </button>
                                <span className="flow-note">从材料市场取回 BNB，之后可退款或重挂买单。</span>
                              </div>
                            ) : (
                              <>
                                {side === "buy" && (canBuy ? renderLegForm("buy") : (
                                  <p className="flow-empty">
                                    {raised <= 0 ? "募集余额为 0，无法挂买单。" : "当前不能挂买单。"}
                                  </p>
                                ))}
                                {side === "sell" && (canSell ? renderLegForm("sell") : (
                                  <p className="flow-empty">
                                    {book._chain && book.marketAskSide === false
                                      ? "当前材料市场没有卖单侧（官方市场只有买单），挂卖单链上会直接 revert。元件到账后直接入池即可。"
                                      : !book.marketAsks
                                        ? "这期合约无卖单接口，需重新部署后开新期。"
                                        : "确认买单到账后才能挂卖单。"}
                                  </p>
                                ))}
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      {(book.executePhase === "buying" || book.executePhase === "listed" || ready || askOpen) && (
                        <div className="flow-tools">
                          <button
                            className="btn btn-inline"
                            type="button"
                            disabled={!canRefund || Boolean(pending)}
                            onClick={onOpenRefund}
                            title={refundHint}
                          >
                            {pending === "openRefund" ? "退款中…" : (book.executionFailed ? "退款剩余" : "原路退款")}
                          </button>
                          {dustOnly && (
                            <button
                              className="btn btn-inline"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={onRecoverBnb}
                              title="份额已全部退完，池子里的尾差/卖单溢价没有归属。recoverBnb() 无参，一次扫给 Owner。"
                            >
                              {pending === "recoverBnb" ? "取回中…" : "取回剩余 BNB"}
                            </button>
                          )}
                          {canAbandon && (
                            <button
                              className="btn btn-inline"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={onAbandonOrder}
                              title={buyOpen && !hasOpenLeg
                                ? "买单已全部成交，元件已上链，无法撤销"
                                : "撤销未成交买单、撤卖单、提取卖出款，然后按当前池子给持份人退款。"}
                            >
                              {pending === "abandonOrder" ? "撤回中…" : "放弃挂单并退款"}
                            </button>
                          )}
                        </div>
                      )}

                      {ready && !book.executionFailed && !askOpen && !saleSettled && (
                        <div className="flow-panel">
                          <div className="flow-panel-head">
                            <div>
                              <h3>进入挖矿</h3>
                              <p>晶体管已确认到账。先设置矿池地址，再把晶体管投入矿池，进入挖矿阶段。入池不可逆，剩余募集款不再退回。</p>
                            </div>
                          </div>
                          <div className="flow-panel-body">
                            {/* 矿池地址：已写入过的回填显示，避免 Owner 每次都要重贴地址 */}
                            <label className="field">
                              <span>矿池地址（setMiningPool）</span>
                              <input
                                className="mono"
                                placeholder={hasPoolOnChain ? "" : "0x…"}
                                value={miningPoolAddr}
                                onChange={(e) => setMiningPoolAddr(e.target.value)}
                              />
                            </label>
                            {hasPoolOnChain && (
                              <p className="fine">
                                本期矿池地址已写入：
                                <strong className="mono">{poolOnChain}</strong>
                                <br />
                                链上 <code>setMiningPool</code> 在入池前可重复调用（改地址）；
                                一旦 <code>depositToPool</code> 执行，元件不可逆地转入该矿池。
                              </p>
                            )}
                            <div className="flow-panel-actions is-solo">
                              <button
                                className="btn btn-primary"
                                type="button"
                                disabled={!isOwner || Boolean(pending) || !/^0x[0-9a-fA-F]{40}$/.test(miningPoolAddr.trim())}
                                title={
                                  !/^0x[0-9a-fA-F]{40}$/.test(miningPoolAddr.trim())
                                    ? "请填写有效的 20 字节矿池地址"
                                    : hasPoolOnChain && miningPoolAddr.trim().toLowerCase() === poolOnChain.toLowerCase()
                                      ? "与链上已写入的地址相同，无需重复设置"
                                      : undefined
                                }
                                onClick={() => submitMiningPool({ pool: miningPoolAddr.trim() })}
                              >
                                {pending === "setMiningPool"
                                  ? "设置中…"
                                  : hasPoolOnChain && miningPoolAddr.trim().toLowerCase() === poolOnChain.toLowerCase()
                                    ? "已设置该地址"
                                    : "setMiningPool"}
                              </button>
                              <button
                                className="btn btn-primary"
                                type="button"
                                disabled={!isOwner || Boolean(pending) || !hasPoolOnChain}
                                title={hasPoolOnChain ? undefined : "请先设置矿池地址（链上 depositToPool 要求 miningPool 非零）"}
                                onClick={() => submitDepositToPool()}
                              >
                                {pending === "depositToPool" ? "投入中…" : "depositToPool 进入挖矿"}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {(book._chain && book.marketOrders === false) || (book.executionFailed && idle) || !isOwner ? (
                        <p className="fine ops-note">
                          {book._chain && book.marketOrders === false && "当前这期仍是旧合约，重新部署并开新期后才会真正调用市场。"}
                          {book.executionFailed && idle && " 上次买单托管额超过募集余额，交易虽上链但未真正挂出（未扣款）。请降低数量/单价重挂，或直接退款。"}
                          {!isOwner && " 当前钱包不是 Factory Owner，无法执行写操作。"}
                        </p>
                      ) : null}
                    </div>
                  );
                })()}

                {book.scene === "mining" && (
                  <>
                    <ul className="bill">
                      <li><span>预估算力（setPlan）</span><strong>{Number(book.estHashpower || 0).toLocaleString()} H</strong></li>
                      <li><span>已入矿池</span><strong>{book.pooled ? "是" : "否"}</strong></li>
                      <li className="due"><span>本阶段可做</span><strong>份额转让（listShares / takeListing）</strong></li>
                    </ul>
                    <p className="fine">
                      元件已投入矿池，不可撤出。BEM 分配合约接入前 harvest / claim 是占位空实现，
                      不产出发放；持份用户退出只能通过挖矿份额转让发布出售挂单，由他人接收。
                    </p>
                  </>
                )}

                {book.executionFailed && (
                  <p className="fine warn-text">
                    若 Owner 已发起退款，认筹 BNB 会按认筹地址原路退回。仍有可用份额的地址到「我的资产」点原路退还；有挂单锁定须先撤单。
                  </p>
                )}
              </div>
            </article>

            {book._chain && (
              <div className="detail-col">
                <article className="card">
                  <div className="card-header">链上参数（本期）</div>
                  <div className="card-body">
                    <dl className="param-grid">
                    <div><dt>合约</dt><dd className="mono">{shortAddress(round.contract)}</dd></div>
                    <div><dt>Owner</dt><dd className="mono">{shortAddress(book.owner)}</dd></div>
                    <div>
                      <dt>挖矿产出服务费分成</dt>
                      <dd>
                        {/*
                         * 读链上（口径：挖矿产出服务费真正上链）。
                         * serviceFeeBps / 分成表都在 Campaign 里，任何人可读。
                         * 还没设过（serviceFeeSet == false）就写「未设定」——
                         * 注意「未设定」和「设为 0%」是两回事，前者还能改，后者已锁定。
                         */}
                        {chainFeeSet ? (
                          <>
                            {/* dt 已写明「挖矿产出服务费分成」，这里不必再重复那五个字 */}
                            <div>费率 {chainFeePercent}%</div>
                            {chainFeeShares.map((row) => (
                              <div key={row.address} className="mono">
                                {shortAddress(row.address)} · {Math.round(Number(row.sharePercent))}%
                              </div>
                            ))}
                            <div className="param-note">链上设定 · 不可修改 · 从挖矿收益计提</div>
                          </>
                        ) : (
                          <>
                            <span className="muted-value">未设定</span>
                            <div className="param-note">尚无人认购时可调 setServiceFee 写入</div>
                          </>
                        )}
                      </dd>
                    </div>
                    {/*
                     * 算力与元件数不在这里报。
                     * 旧版是「预估算力」+「链上算力 / 元件」两行，两行的数字同源
                     * （链上没有实时算力 getter，book.hashpower 就是 setPlan 写进去的
                     * estHashpower），加上顶部概览条的「算力」「已买入元件」，同一个值
                     * 会在一个弹窗里出现三次。
                     * 元件数的权威口径不变：链上**已成交到账量**（挂单量 − 市场 remaining），
                     * 不是 nandQty + latchQty 本身 —— 那只是下单量，成交前不代表已买到。
                     */}
                    <div>
                      <dt>托管 BNB</dt>
                      <dd>
                        {round4(book.bnbPool || 0)} BNB
                        {refundGap > 0 && <span className="flow-gap"> · 距按份全退还差 {round4(refundGap)} BNB</span>}
                      </dd>
                    </div>
                    <div><dt>锁价</dt><dd>{book.priceLock ? `${round4(book.priceLock)} BNB` : "未锁"}</dd></div>
                  </dl>
                  </div>
                </article>
                {/*
                 * 历史交易记录常驻右栏。
                 * 之前只在 scene === "executing" 时渲染，募资阶段整栏直接消失，
                 * 右栏只剩「链上参数」，跟设计稿的「历史交易记录」栏对不上。
                 *
                 * 排序：链上参数 → 历史交易记录。
                 * 官方元件最新价不再单独成卡 —— 挂买单表单的「市价」列已经给出
                 * 同源单价（officialPartPrices，点一下即填入），同一数据不出现第二次。
                 */}
                <MarketTradePanel
                  campaignAddr={round.contract || book.address}
                  refreshKey={marketRefreshKey}
                  phase={book.executePhase}
                  fallbackRows={{
                    nandBidId: book.nandBidId, latchBidId: book.latchBidId,
                    nandQty: Number(book.nandQty) || 0, latchQty: Number(book.latchQty) || 0,
                    nandRemaining: book.nandRemaining, latchRemaining: book.latchRemaining,
                    nandPrice: Number(book.nandPrice) || 0, latchPrice: Number(book.latchPrice) || 0,
                    nandAskId: book.nandAskId, latchAskId: book.latchAskId,
                    nandAskQty: Number(book.nandAskQty) || 0, latchAskQty: Number(book.latchAskQty) || 0,
                    nandAskRemaining: book.nandAskRemaining, latchAskRemaining: book.latchAskRemaining,
                    nandAskPrice: Number(book.nandAskPrice) || 0, latchAskPrice: Number(book.latchAskPrice) || 0,
                    marketOwed: Number(book.marketOwed) || 0,
                    partsNand: Number(book.partsNand) || 0, partsLatch: Number(book.partsLatch) || 0,
                  }}
                />
                {book.scene === "executing" && (book.executionFailed || book.refundShort) && (
                  <RefundRecords
                    compact
                    campaignAddr={round.contract || book.address}
                    refreshKey={`${book.refundedTotal}|${book.sold}|${book.bnbPool}`}
                    account={actor?.address}
                    fallback={{ totalRefunded: book.refundedTotal, pool: book.bnbPool, mine: book.refundedSelf }}
                  />
                )}
              </div>
            )}
          </div>
    );
  }

  if (!opened) {
    return (
      <section>
        <header className="publish-head">
          <div className="publish-title-row">
            <div className="publish-title">
              <span className="publish-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                  <path d="M8 7h12M8 12h12M8 17h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              </span>
              <div>
                <h1>众筹挖矿列表</h1>
                <p>按状态筛选。详情进入该期 BEM挖矿认筹；合约操作在弹出框里完成。</p>
              </div>
            </div>
          </div>
        </header>
        <section className="list-panel">
          <header className="list-panel-head">
            <div className="campaign-filters" role="tablist">
            {statusOptions.map((name) => (
              <button
                key={name}
                type="button"
                className={statusFilter === name ? "desk-tab is-on" : "desk-tab"}
                onClick={() => { setStatusFilter(name); setPageIndex(1); }}
              >
                {name}
                <em>{name === "全部" ? historyRows.length : historyRows.filter((row) => row.status === name).length}</em>
              </button>
            ))}
          </div>
        </header>
        <div className="list-panel-body">
        {pageRows.length === 0 ? (
          <div className="list-empty">
            <strong>{statusFilter === "全部" ? "还没有期次" : `「${statusFilter}」下没有期次`}</strong>
            <p>
              {statusFilter === "全部"
                ? "发布一期之后，会出现在这里。可以按募集中、待执行、挖矿中、已结束筛选。"
                : "换一个状态查看，或等这一阶段有新的期次。"}
            </p>
          </div>
        ) : (
          <div className="campaign-list">
            {pageRows.map((item) => {
              const sold = item.sold != null ? Number(item.sold) : null;
              const total = item.totalShares != null ? Number(item.totalShares) : null;
              const pct = sold != null && total > 0 ? Math.min(100, Math.round((sold / total) * 100)) : null;
              const raised = item.raisedBnb != null ? Number(item.raisedBnb).toFixed(4) : item.raised;
              const cap = item.hardCapBnb != null ? Number(item.hardCapBnb).toFixed(4) : null;
              const headline = `第 ${item.id} 期`;
              const deal = dealStatus(item);
              const transistorCount = item.transistorCount != null ? Number(item.transistorCount) : null;
              const deadline = item.fundingDeadline ? Number(item.fundingDeadline) * 1000 : 0;
              const remainMs = deadline > 0 ? deadline - Date.now() : 0;
              const remainText = deadline > 0
                ? (remainMs > 0 ? `剩余募集 ${formatRemain(remainMs)}` : "募集已截止")
                : "";
              return (
                <article key={rowKey(item)} className={`campaign-card ${deal.key === "none" ? "deal-idle" : `deal-${deal.key}`}`} onClick={() => openRound(item)}>
                  <header className="campaign-card-head">
                    <div>
                      {/* 期号只在 h2 里出现一次；kicker 只放处理器与地址，不重复「第 N 期」。 */}
                      {(item.processor || item.address) ? (
                        <div className="campaign-kicker">
                          {item.processor ? <span className="campaign-processor">{item.processor}</span> : null}
                          {item.address ? <span className="mono">{shortAddress(item.address)}</span> : null}
                        </div>
                      ) : null}
                      <h2>{headline}</h2>
                    </div>
                    <div className="campaign-status">
                      {deal.key === "none" ? null : (
                        <span className={`deal-badge ${deal.cls}`}>{deal.label}</span>
                      )}
                      <span className={`badge tone-${item.tone}`}>{item.status}</span>
                      {item.statusNote ? <small>{item.statusNote}</small> : null}
                    </div>
                  </header>

                  {deal.key === "waiting" ? (
                    <div className="campaign-hero deal-wait">
                      <div className="hero-pct">{pct != null ? `${pct}` : "—"}<span className="hero-unit">%</span></div>
                      {/* 份数已在下方指标行显示，这里只给「还差多少 / 已售罄」，不重复 x/y。 */}
                      <div className="hero-sub">
                        {sold != null && total != null
                          ? (total - sold > 0 ? `还差 ${total - sold} 份售罄` : "已售罄 · 待执行")
                          : (item.shares ? `已认筹 ${item.shares} 份` : "—")}
                      </div>
                      {remainText ? <div className="hero-note">{remainText}</div> : null}
                      {pct != null && (
                        <div className="campaign-progress" aria-hidden="true">
                          <i style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                  ) : deal.key === "done" ? (
                    <div className="campaign-hero deal-done">
                      {/*
                       * 已售罄 ≠ 元件已买到：售罄后 Owner 可能还没挂单。
                       * 「已售罄」由卡片头的状态徽标表达，hero 只讲元件这一维：
                       * 元件数 > 0 说「N 颗 / 成交元件已到账」，为 0 就说「0 颗 / 等待买入」，
                       * 不再出现「已售罄 / 已售罄」或「0 颗 · 成交元件已到账」这种自相矛盾。
                       */}
                      <div className="hero-pct">
                        {transistorCount != null && transistorCount > 0 ? `${transistorCount} 颗` : "0 颗"}
                      </div>
                      <div className="hero-sub">
                        {transistorCount != null && transistorCount > 0
                          ? "成交元件已到账"
                          : "等待 Owner 买入元件"}
                      </div>
                    </div>
                  ) : (
                    <div className="campaign-hero deal-failed">
                      <div className="hero-note">{item.statusNote || (deal.key === "failed" ? "募集到期未售罄（流标）" : "本期已结束")}</div>
                    </div>
                  )}

                  <dl className="campaign-metrics">
                    <div>
                      <dt>份数</dt>
                      <dd>{sold != null && total != null ? `${sold}/${total}` : item.shares}</dd>
                      {item.sharePriceBnb != null && <small>每份 {Number(item.sharePriceBnb).toFixed(4)} BNB</small>}
                    </div>
                    <div className="metric-main">
                      <dt>募集</dt>
                      <dd>{raised} BNB</dd>
                      {cap != null && <small>目标 {cap} BNB</small>}
                    </div>
                    <div>
                      <dt>算力</dt>
                      <dd>{item.hashpower || item.hash || "—"}</dd>
                    </div>
                    <div>
                      <dt>已分配</dt>
                      <dd>{item.bem}</dd>
                    </div>
                    <div>
                      <dt>挖矿产出服务费</dt>
                      <dd>{item.fee}</dd>
                    </div>
                  </dl>
                  <footer className="campaign-card-foot">
                    <span>{nextActionByStatus(item.status)}</span>
                    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                      {/*
                       * 四个工具合并到一个弹窗里用标签页切换。
                       * 卡片上只留一个「打开工具」入口——四个平级按钮会让人以为
                       * 它们打开的是四个不同页面，而不是同一期数的四个视角。
                       */}
                      <button className="campaign-link" type="button" onClick={() => openTool(item, "ops")}>打开工具</button>
                      {item.address && isOwner && onRemoveCampaign && (
                        <button
                          className="campaign-link tone-danger"
                          type="button"
                          disabled={Boolean(pending)}
                          title="仅从工厂列表移除，不销毁链上合约"
                          onClick={() => {
                            const ok = window.confirm(
                              `从工厂列表移除第 ${item.id} 期？\n${item.address}\n\n不会销毁链上合约；有份额仍可用该地址直连。`
                            );
                            if (ok) onRemoveCampaign(item.address);
                          }}
                        >
                          {pending === "removeCampaign" && String(pendingTarget).toLowerCase() === String(item.address).toLowerCase() ? "移除中…" : "移除"}
                        </button>
                      )}
                      <button className="btn btn-primary btn-inline" type="button" onClick={() => openRound(item)}>详情</button>
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
        </div>
        <footer className="list-pager">
          <span>第 {rangeFrom}–{rangeTo} 条，共 {visibleRows.length} 条</span>
          <div className="list-pager-controls">
            <button className="btn btn-inline" type="button" disabled={page <= 1} onClick={() => setPageIndex(page - 1)}>上一页</button>
            <span>第 {page} / {pageCount} 页</span>
            <button className="btn btn-inline" type="button" disabled={page >= pageCount} onClick={() => setPageIndex(page + 1)}>下一页</button>
          </div>
        </footer>
      </section>
      {/*
       * 弹窗用 portal 挂到 body 上。
       *
       * 原因：`.main-content` 上有 `isolation: isolate`，它会**建立层叠上下文**，
       * 于是 .sheet-backdrop 的 z-index: 120 只在 main-content 内部有效，
       * 根本压不过根层的侧边栏（z-index: 100）——弹窗左半边会被侧边栏盖住，
       * 标签页点不动。挂到 body 后才是真正的顶层弹窗。
       */}
      {dialogRow && typeof document !== "undefined" && createPortal(
        <div className="sheet-backdrop" onClick={() => setDialog(null)}>
          <div
            className="sheet sheet-wide"
            role="dialog"
            aria-modal="true"
            aria-label={`${dialogTitle} 第 ${dialogRow.id} 期`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="sheet-head">
              <div>
                <p className="sheet-kicker">
                  第 {dialogRow.id} 期
                  {dialogRow.address ? <span className="mono sheet-addr"> · {shortAddress(dialogRow.address)}</span> : null}
                </p>
                <h2>{dialogTitle}</h2>
              </div>
              <button className="sheet-close" type="button" aria-label="关闭" onClick={() => setDialog(null)}>×</button>
            </header>
            <nav className="sheet-tabs" role="tablist" aria-label="工具切换">
              {DIALOG_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={dialog.pane === t.id}
                  className={dialog.pane === t.id ? "sheet-tab is-on" : "sheet-tab"}
                  onClick={() => setDialog((prev) => (prev ? { ...prev, pane: t.id } : prev))}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="sheet-body">
              {!dialogLive ? (
                <p className="fine">正在读取这一期…</p>
              ) : dialog.pane === "holders" ? (
                <OwnerHolders
                  embedded
                  round={round}
                  book={book}
                  account={account}
                  holders={holdersForRound}
                  chainMode={Boolean(book._chain)}
                />
              ) : dialog.pane === "calls" ? (
                <ContractCalls
                  embedded
                  round={round}
                  book={book}
                  connected={connected}
                  wallet={account}
                  actor={actor}
                  quote={quote}
                  pending={pending}
                  chainMode={Boolean(book._chain)}
                  onInvoke={onInvoke}
                />
              ) : dialog.pane === "onchain" ? (
                <OnChainPage embedded account={account} connected={connected} signer={signer} />
              ) : (
                <>
                  <article className="detail-summary">
                    <dl className="campaign-metrics">
                      <div>
                        <dt>份数</dt>
                        <dd>{book.sold}/{round.totalShares}</dd>
                        <small>每份 {Number(round.sharePriceBnb).toFixed(4)} BNB</small>
                      </div>
                      <div>
                        <dt>募集</dt>
                        <dd>{round4(raised)} BNB</dd>
                        <small>目标 {round4(hardCap)} BNB</small>
                      </div>
                      <div>
                        <dt>算力</dt>
                        <dd>{hashLabel}</dd>
                        <small>{hashHint}</small>
                      </div>
                      <div>
                        {/*
                         * 算力与预估算力是同一个数（book.hashpower = estHashpower），
                         * 之前并排显示两行、其中一行恒为 0，纯属重复。
                         * 这里只留「元件」一行，元件数才是链上另一个独立事实。
                         */}
                        <dt>已买入元件</dt>
                        <dd>
                          {Number(book.transistorCount) > 0
                            ? `${book.transistorCount} 颗`
                            : <span className="muted-value">未成交</span>}
                        </dd>
                        <small>成交到账的 NAND + LATCH</small>
                      </div>
                      <div>
                        <dt>已入矿池</dt>
                        <dd>{book.pooled ? "是" : "否"}</dd>
                        <small>{book.pooled ? "已开始分发" : "待 depositToPool"}</small>
                      </div>
                    </dl>
                    <div className="campaign-progress" aria-hidden="true">
                      <i style={{ width: `${soldPct}%` }} />
                    </div>
                    <p className="detail-progress-note">已售 {soldPct}%</p>
                  </article>
                  {renderOps()}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
      </section>
    );
  }

  const crumb = (periodLabel) => (
    <nav className="detail-crumb" aria-label="页面路径">
      <button className="campaign-link" type="button" onClick={() => setOpenKey(null)}>众筹挖矿列表</button>
      <span aria-hidden="true">/</span>
      <strong>{periodLabel}</strong>
    </nav>
  );

  if (opened.address && !isLive) {
    return (
      <section className="list-panel detail-panel">
        <header className="list-panel-head">
          {crumb(`第 ${opened.id} 期`)}
          <div className="list-panel-title">
            <div>
              <h2>正在读取这一期</h2>
              <p className="mono">{shortAddress(opened.address)}</p>
            </div>
          </div>
        </header>
        <div className="list-panel-body">
          <div className="list-empty">
            <strong>链上状态对齐中</strong>
            <p>元件数、募集和可执行操作稍后会出现在这里。</p>
          </div>
        </div>
      </section>
    );
  }

  if (!isLive) {
    return (
      <section className="list-panel detail-panel">
        <header className="list-panel-head">
          {crumb(`第 ${opened.id} 期`)}
          <div className="list-panel-title">
            <div>
              <h2>第 {opened.id} 期</h2>
              <p>{opened.processor ? `元件合约处理器 ${opened.processor} · ` : ""}这一期没有可操作的链上状态</p>
            </div>
            <span className={`badge tone-${opened.tone}`}>{opened.status}</span>
          </div>
        </header>
        <div className="list-panel-body">
          <article className="detail-summary">
            <dl className="campaign-metrics">
              <div><dt>份数</dt><dd>{opened.shares}</dd></div>
              <div><dt>募集</dt><dd>{opened.raised}</dd></div>
              <div><dt>算力</dt><dd>{opened.hashpower || "—"}</dd></div>
              <div><dt>已分配</dt><dd>{opened.bem}</dd></div>
              <div><dt>挖矿产出服务费</dt><dd>{opened.fee}</dd></div>
            </dl>
          </article>
        </div>
      </section>
    );
  }

  return (
    <section className="list-panel detail-panel">
      <header className="list-panel-head">
        {crumb(`第 ${round.id} 期`)}
        <div className="list-panel-title">
          <div>
            <h2>第 {round.id} 期</h2>
            <p>
              {design.processorKnown ? `处理器 ${design.processorId} · P=${design.processorScale}` : "处理器未记录"}
              {Number(round.partCount) > 0 ? ` · ${round.partCount} 元件` : ""}
              {round.contract ? ` · ${shortAddress(round.contract)}` : ""}
            </p>
          </div>
          <span className={`badge tone-${liveStatus.tone}`}>{liveStatus.badge}</span>
        </div>
        <div className="desk-tabs detail-tabs" role="tablist" aria-label="本期工具">
          {[
            ["ops", "本期操作"],
            ["holders", "份额明细"],
            ["calls", "合约调用"],
            ["onchain", "链上调试"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={detailPane === id}
              className={detailPane === id ? "desk-tab is-on" : "desk-tab"}
              onClick={() => setDetailPane(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="list-panel-body">
        <article className="detail-summary">
          <dl className="campaign-metrics">
            <div>
              <dt>份数</dt>
              <dd>{book.sold}/{round.totalShares}</dd>
              <small>每份 {Number(round.sharePriceBnb).toFixed(4)} BNB</small>
            </div>
            <div>
              <dt>募集</dt>
              <dd>{round4(raised)} BNB</dd>
              <small>目标 {round4(hardCap)} BNB</small>
            </div>
            <div>
              <dt>算力</dt>
              <dd>{hashLabel}</dd>
              <small>{hashHint}</small>
            </div>
            <div>
              <dt>预估算力</dt>
              <dd>{Number(book.estHashpower || 0).toLocaleString()}</dd>
              <small>H</small>
            </div>
            <div>
              <dt>已入矿池</dt>
              <dd>{book.pooled ? "是" : "否"}</dd>
              <small>{book.pooled ? "已开始分发" : "待 depositToPool"}</small>
            </div>
          </dl>
          <div className="campaign-progress" aria-hidden="true">
            <i style={{ width: `${soldPct}%` }} />
          </div>
          <p className="detail-progress-note">已售 {soldPct}%</p>
        </article>

        {detailPane === "holders" && (
          <div className="detail-section">
            <OwnerHolders
              embedded
              round={round}
              book={book}
              account={account}
              holders={holdersForRound}
              chainMode={Boolean(book._chain)}
            />
          </div>
        )}
        {detailPane === "calls" && (
          <div className="detail-section">
            <ContractCalls
              embedded
              round={round}
              book={book}
              connected={connected}
              wallet={account}
              actor={actor}
              quote={quote}
              pending={pending}
              chainMode={Boolean(book._chain)}
              onInvoke={onInvoke}
            />
          </div>
        )}
        {detailPane === "onchain" && (
          <div className="detail-section">
            <OnChainPage embedded account={account} connected={connected} signer={signer} />
          </div>
        )}
        {detailPane === "ops" && renderOps()}
      </div>
    </section>
  );
}

export function OwnerCreate({
  onCreate,
  pending,
  snapshot,
  chainMode = false,
  factoryOwner = "",
  connectedAccount = "",
  defaultFeeRecipient = "",
  allowedParts = [],
  onConnect,
}) {
  const [draft, setDraft] = useState(() => ({ ...EMPTY_FORM }));
  /**
   * 「碰过才校验」。
   *
   * 初始态就满屏红是最差的引导：用户还没填一项，先被三条错误围着，
   * 反而不知道该从哪开始。这里只在字段失焦过（或点过提交）之后才显示
   * 对应的红框与错误列表，表单一开始是干净的。
   */
  const [touched, setTouched] = useState({});
  const [submitTried, setSubmitTried] = useState(false);
  const touch = (key) => setTouched((cur) => (cur[key] ? cur : { ...cur, [key]: true }));
  const showIssues = submitTried || Object.keys(touched).length > 0;
  /**
   * 连接钱包后只回填「地址」这一项（运行时账户，不是预设值）。
   * 分成比例始终留空由用户填，不替他决定。
   */
  useEffect(() => {
    if (!defaultFeeRecipient) return;
    setDraft((cur) => {
      const rows = Array.isArray(cur.feeShares) ? cur.feeShares : [];
      const first = rows[0]?.address || cur.feeRecipient;
      if (first) return cur; // 已填过地址就不动，避免覆盖用户输入
      const nextShares =
        rows.length === 0
          ? [{ address: defaultFeeRecipient, sharePercent: "100" }]
          : rows.map((row, i) => (i === 0 ? { ...row, address: defaultFeeRecipient } : row));
      return { ...cur, feeRecipient: defaultFeeRecipient, feeShares: nextShares };
    });
  }, [defaultFeeRecipient]);

  const isFactoryOwner =
    !chainMode ||
    !factoryOwner ||
    (connectedAccount && String(connectedAccount).toLowerCase() === String(factoryOwner).toLowerCase());
  /** 开期测算用的报价：链上单价（若有）优先，否则静态基准 */
  const quote = snapshot || QUOTE;

  /**
   * 募资总额与总份数：开期人**手动填写**，两项都是必填。
   *
   * 总份数定「分成多少份」。每份 BNB 是派生展示值（每份 = 募资总额 ÷ 总份数），
   * 不可单独手填——填任何一个都会破坏「募资总额 = 份数 × 每份」的链上恒等式。
   *
   * ⚠️ 这里**没有**「留空 = 跟随建议」：建议方案依赖处理器与元件报价，
   * 而发布期不选处理器，建议值就成了来源不明的数字。宁可直接要求开期人自己填。
   */
  /**
   * 本期元件合约（= 处理器）：**开期人必须显式选择**（T-79 核心改动）。
   *
   * 工厂不再有「默认元件」：`createCampaign` 第 4 参 transistors 由前端从链上白名单里选，
   * 零地址一律 revert（主网白名单 = 官方两件套 TapeOut / Behemoth 各自的元件合约）。
   * 这样单工厂可承载多处理器，每期锁定一个，而不是所有期次被锁死到同一处理器。
   *
   * 演示（非链上）模式没有白名单可读，处理器由系统选定，表单不收集、也不校验。
   */
  const selectedProcessor = String(draft.transistors || "").trim();
  const processorOptions = (Array.isArray(allowedParts) ? allowedParts : []).filter(
    (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim())
  );
  const capNum = Number(draft.hardCapBnb);
  const sharesNum = Number(draft.totalShares);
  /** 募资总额合法性：必须是正数 */
  const capValid = Number.isFinite(capNum) && capNum > 0;
  /** 总份数合法性：必须是正整数 */
  const sharesValid = Number.isInteger(sharesNum) && sharesNum > 0;
  /** 服务费是否填了合法值（1–10 整数）——先声明再被下方红框判定引用，避免 TDZ 崩白屏 */
  const feeValid = (() => {
    const n = Number(draft.feePercent);
    return Number.isInteger(n) && n >= 1 && n <= 10;
  })();
  /** 红框只给「碰过还错」的字段，没碰过的保持干净 */
  const capInvalid = (touched.hardCapBnb || submitTried) && !capValid;
  /**
   * 募集天数校验：链上 createCampaign 直接把 `Number(fundingDays) * 86400`
   * 当 uint64 写进 deadline。填 0 会得到「已截止」的僵尸期次（建期即过期，
   * 认购入口永久关闭且无人能救），填非整数会被静默截断——所以前端必须拦。
   */
  const daysNum = Number(draft.fundingDays);
  const daysValid = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 3650;
  const daysInvalid = (touched.fundingDays || submitTried) && !daysValid;
  const sharesInvalid = (touched.totalShares || submitTried) && !sharesValid;
  const feeInvalid = (touched.feePercent || submitTried) && !feeValid;
  /** 处理器（元件合约）：链上模式必选，且必须是合法地址（白名单在链上校验） */
  const transistorsValid = chainMode
    ? /^0x[0-9a-fA-F]{40}$/.test(selectedProcessor)
    : true;
  const transistorsInvalid =
    (touched.transistors || submitTried) && chainMode && !transistorsValid;
  /** 有效口径：直接用手填值。非法值保留原数字交给校验拦截，不静默回退成"建议值" */
  const effCap = capNum;
  const effShares = sharesNum;
  /** 派生每份 = 募资总额 ÷ 总份数。非法输入时为 NaN，展示置空、由红框与校验提示 */
  const perShareBnb = effCap > 0 && effShares > 0 ? effCap / effShares : NaN;
  const priceInput = Number.isFinite(perShareBnb) && perShareBnb > 0 ? perShareBnb.toFixed(4) : "";
  const sharesInput = String(effShares);
  /** 分成表转链上 bps 口径（UI 收百分比，reviewRound/applyCreate 收 shareBps） */
  const feeSharesForChain = (Array.isArray(draft.feeShares) ? draft.feeShares : []).map((row) => {
    const percent = Math.round(Number(row.sharePercent ?? 0));
    return {
      address: String(row.address || "").trim(),
      shareBps: percent * 100,
    };
  });
  const feeSharePercentSum = (Array.isArray(draft.feeShares) ? draft.feeShares : []).reduce(
    (sum, row) => sum + (Math.round(Number(row.sharePercent)) || 0),
    0
  );
  /**
   * 开期校验与预估值都用解析后的单价/份数。
   * 链上 createCampaign 收 单价 / 份数 / 天数 / 元件合约；
   * 服务费与分成是**建期后的第二笔交易**（setServiceFee，只能在 sold == 0 时调），由 App 侧串联。
   *
   * 元件合约（处理器）由开期人显式选（effectiveDraft.transistors）；
   * 链上模式必填，零地址会被工厂 revert。演示模式留空，由模拟引擎派生。
   */

  const effectiveDraft = {
    ...draft,
    /**
     * 元件合约：开期人从白名单显式选的处理器地址（链上模式必填；
     * 演示模式留空，由模拟引擎按默认型号派生，不写链上）。
     */
    transistors: selectedProcessor,
    /** 手动募资总额（权威口径，必填） */
    hardCapBnb: String(effCap),
    /** 派生每份：非法输入退为 0，避免下游 NaN 传播 */
    sharePriceBnb: Number.isFinite(perShareBnb) ? String(perShareBnb) : "0",
    totalShares: sharesInput,
    feeShares: feeSharesForChain,
    feeRecipient: feeSharesForChain[0]?.address || draft.feeRecipient,
  };
  const review = reviewRound(effectiveDraft, quote);

  function update(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const updateFeeShare = (index, key, value) => {
    setDraft((cur) => {
      let nextValue = value;
      if (key === "sharePercent") {
        const digits = String(value).replace(/\D/g, "");
        if (digits === "") {
          nextValue = "";
        } else {
          const n = Math.min(100, Number(digits));
          nextValue = String(Number.isFinite(n) ? n : "");
        }
      }
      const rows = (Array.isArray(cur.feeShares) ? cur.feeShares : []).map((row, i) =>
        i === index ? { ...row, [key]: nextValue } : row
      );
      return {
        ...cur,
        feeShares: rows,
        feeRecipient: rows[0]?.address || cur.feeRecipient,
      };
    });
  };

  const addFeeShare = () => {
    setDraft((cur) => {
      const rows = [...(Array.isArray(cur.feeShares) ? cur.feeShares : [])];
      // 链上 MAX_FEE_RECIPIENTS = 3，超了 setServiceFee 直接 revert。
      if (rows.length >= 3) return cur;
      // 新行比例留空由用户填，不自动补「剩余 100 - 已用」——那是替用户做决定
      rows.push({ address: "", sharePercent: "" });
      return { ...cur, feeShares: rows };
    });
  };

  const removeFeeShare = (index) => {
    setDraft((cur) => {
      const rows = (Array.isArray(cur.feeShares) ? cur.feeShares : []).filter((_, i) => i !== index);
      const next = rows.length ? rows : [{ address: defaultFeeRecipient || "", sharePercent: "100" }];
      return { ...cur, feeShares: next, feeRecipient: next[0]?.address || "" };
    });
  };

  const canSubmit = review.ok && daysValid && transistorsValid && !pending && (chainMode ? isFactoryOwner : true);
  const submitLabel = pending
    ? (pending === "createCampaign" ? "发布中…" : String(pending))
    : chainMode && !connectedAccount
      ? "请先连接 Owner 钱包"
      : chainMode && !isFactoryOwner
        ? "需 Factory Owner 钱包"
        : "发布众筹挖矿";

  return (
    <section>
      <header className="publish-head">
        <div className="publish-title-row">
          <div className="publish-title">
            <span className="publish-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                <path d="M4.5 8.2 12 4.2l7.5 4-7.5 4-7.5-4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                <path d="M4.5 12.2 12 16.2l7.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                <path d="M4.5 16.2 12 20.2l7.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <h1>发布众筹挖矿</h1>
              <p>
                {chainMode
                  ? "四项参数上链后不可改。处理器由工厂统一决定，发布时不可选。"
                  : "四项参数上链后不可改。处理器由工厂统一决定。"}
              </p>
            </div>
          </div>
          <div className="publish-meta">
            {chainMode && (
              <span className="publish-signer">
                {isFactoryOwner && connectedAccount
                  ? `可签名 · ${shortAddress(connectedAccount)}`
                  : factoryOwner
                    ? `Owner ${shortAddress(factoryOwner)}`
                    : "—"}
              </span>
            )}
          </div>
        </div>
        {chainMode && (!connectedAccount || !isFactoryOwner) && (
          <div className="publish-auth">
            <p>
              {!connectedAccount
                ? "当前未连接钱包。发布需要 Factory Owner 签名。"
                : `当前钱包不是 Factory Owner（${shortAddress(factoryOwner)}）。`}
            </p>
            {!connectedAccount && (
              <button className="btn btn-primary btn-inline" type="button" onClick={onConnect}>
                连接 Owner 钱包
              </button>
            )}
          </div>
        )}
      </header>

      <form
        className="publish-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitTried(true);
          if (review.ok && daysValid && transistorsValid) onCreate(effectiveDraft, review);
        }}
      >
        <div className="publish-grid">
          {/* ── 发行规模 ── */}
          <article className="card">
            <div className="card-header">
              <span>发行规模</span>
              <span className="stat-label">两项都必填</span>
            </div>
            <div className="card-body">
              <div className="form-grid cols-2">
                <label className="field">
                  <span>募资总额（BNB）</span>
                  <input
                    value={draft.hardCapBnb}
                    placeholder="必填"
                    inputMode="decimal"
                    className={capInvalid ? "is-invalid" : undefined}
                    title="本期总共募集多少 BNB，必填，上链后不可改"
                    onChange={(event) => update("hardCapBnb", event.target.value)}
                    onBlur={() => touch("hardCapBnb")}
                  />
                </label>
                <label className="field">
                  <span>总份数</span>
                  <input
                    value={draft.totalShares}
                    placeholder="必填"
                    inputMode="numeric"
                    className={sharesInvalid ? "is-invalid" : undefined}
                    title="本期分成多少份，必填正整数。份数越多，单份门槛越低"
                    onChange={(event) => update("totalShares", event.target.value)}
                    onBlur={() => touch("totalShares")}
                  />
                </label>
              </div>
              <ul className="bill">
                <li>
                  <span>每份价格（= 总额 ÷ 份数，不可单独填）</span>
                  <strong>{priceInput ? `${priceInput} BNB` : "—"}</strong>
                </li>
              </ul>
              <p className="fine">
                两项必填，上链后不可改。元件数与算力要到执行阶段才确定，发布期不给建议值。
              </p>
            </div>
          </article>

          {/* ── 募集天数 ── */}
          <article className="card">
            <div className="card-header">
              <span>募集天数</span>
              <span className="stat-label">到期未售罄可原路退款</span>
            </div>
            <div className="card-body">
<label className="field">
                  <span>天数</span>
                  <input
                    value={draft.fundingDays}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className={daysInvalid ? "is-invalid" : undefined}
                    title="须为 1–3650 的整数"
                    onChange={(event) => update("fundingDays", event.target.value.replace(/\D/g, ""))}
                    onBlur={() => touch("fundingDays")}
                  />
                </label>
                <ul className="bill">
                  <li>
                    <span>截止时间</span>
                    <strong>
                      {daysValid
                        ? (() => {
                          const ms = Date.now() + daysNum * 86400000;
                          return new Date(ms).toLocaleString("zh-CN", { hour12: false });
                        })()
                        : "—"}
                    </strong>
                  </li>
                </ul>
                {daysInvalid && (
                  <p className="fine warn-text">
                    天数须为 1–3650 的整数（填 0 会建出创建即已截止的期次）。
                  </p>
                )}
                <p className="fine">
                  上链后不可改。到期未售罄可原路退款。
                </p>
            </div>
          </article>

          {/* ── 本期处理器（元件合约） ── */}
          {chainMode && (
            <article className="card">
              <div className="card-header">
                <span>本期处理器（元件合约）</span>
                <span className="stat-label">开期必选 · 锁定后不可改</span>
              </div>
              <div className="card-body">
                <label className="field">
                  <span>处理器</span>
                  <select
                    value={selectedProcessor}
                    className={transistorsInvalid ? "is-invalid" : undefined}
                    title="从工厂白名单里选一个处理器；该期锁定它的元件合约，开期后不可改"
                    onChange={(event) => update("transistors", event.target.value)}
                    onBlur={() => touch("transistors")}
                  >
                    <option value="">— 请选择处理器 —</option>
                    {processorOptions.map((addr) => {
                      const pid = processorFromPartsContract(addr);
                      const label = pid ? `${pid}` : "处理器";
                      return (
                        <option key={addr} value={addr}>
                          {`${label} · ${shortAddress(addr)}`}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {processorOptions.length === 0 && (
                  <p className="fine warn-text">
                    无法读取工厂元件白名单，请确认链上工厂已部署且白名单非空。
                  </p>
                )}
                {transistorsInvalid && (
                  <p className="fine warn-text">请选择本期使用的处理器（元件合约），不能留空。</p>
                )}
                <p className="fine">
                  工厂不再预设默认元件：每期必须显式选一个白名单内的处理器，发布后该期锁定其元件合约。
                </p>
              </div>
            </article>
          )}
          {/* ── 挖矿产出服务费与分成（链上参数，setServiceFee） ── */}
          <article className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="card-header">
              <span>挖矿产出服务费与分成</span>
              <span className="stat-label">写入链上 · 一次设定永久锁定</span>
            </div>
            <div className="card-body">
              <div className="fee-head">
                <label className="field fee-percent-field">
                  <span>挖矿产出服务费 %</span>
                  <input
                    value={draft.feePercent}
                    inputMode="numeric"
                    placeholder="1–10"
                    className={feeInvalid ? "is-invalid" : undefined}
                    title="1 到 10 的整数（链上硬上限 10%）。按挖矿产出计提，与认筹款无关"
                    onChange={(event) => update("feePercent", event.target.value.replace(/\D/g, ""))}
                    onBlur={() => touch("feePercent")}
                  />
                </label>
              </div>

              <div className="fee-share-block">
                <div className="fee-share-row is-head">
                  <span>分成地址</span>
                  <span>比例</span>
                </div>
                {(Array.isArray(draft.feeShares) ? draft.feeShares : []).map((row, index) => {
                  const addrOk = /^0x[a-fA-F0-9]{40}$/.test(String(row.address || "").trim());
                  const pct = Math.round(Number(row.sharePercent));
                  const pctOk = Number.isInteger(pct) && pct >= 1 && pct <= 100;
                  const addrTouched = touched[`feeAddr-${index}`] || submitTried;
                  const pctTouched = touched[`feePct-${index}`] || submitTried;
                  return (
                    <div className="fee-share-row" key={`fee-${index}`}>
                      <input
                        className={`mono${String(row.address || "") && addrTouched && !addrOk ? " is-invalid" : ""}`}
                        placeholder="0x…"
                        title="0x 开头的地址"
                        value={row.address}
                        onChange={(event) => updateFeeShare(index, "address", event.target.value)}
                        onBlur={() => touch(`feeAddr-${index}`)}
                      />
                      <div className="fee-share-percent">
                        <input
                          inputMode="numeric"
                          pattern="[0-9]*"
                          max={100}
                          placeholder="1–100"
                          className={`${String(row.sharePercent || "") && pctTouched && !pctOk ? " is-invalid" : ""}`}
                          title="1–100 的整数，所有地址之和须等于 100"
                          value={row.sharePercent}
                          onChange={(event) => updateFeeShare(index, "sharePercent", event.target.value)}
                          onBlur={() => touch(`feePct-${index}`)}
                        />
                        <span className="fee-share-unit">%</span>
                        <button
                          type="button"
                          className="btn fee-share-remove"
                          disabled={(draft.feeShares || []).length <= 1}
                          onClick={() => removeFeeShare(index)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
                <div className="fee-share-foot">
                  <button type="button" className="btn fee-share-add" onClick={addFeeShare} disabled={(draft.feeShares || []).length >= 3}>
                    添加地址
                  </button>
                  <span className={`fee-sum${feeSharePercentSum === 100 ? " is-ok" : " is-warn"}`}>
                    合计 {feeSharePercentSum} / 100
                  </span>
                </div>
                <p className="fine">
                  最多 3 个地址，比例之和须正好等于 100，不能重复或为零地址。
                </p>
              </div>
            </div>
          </article>


        </div>

        {showIssues && (review.issues.length > 0 || (submitTried && !daysValid)) && (
          <div className="issues">
            {showIssues && !daysValid && (
              <p>募集天数须为 1–3650 的整数（填 0 会建出创建即已截止的僵尸期次）</p>
            )}
            {review.issues.map((issue) => (
              <p key={issue}>{issue}</p>
            ))}
          </div>
        )}

        {/* 提示性问题（不阻断提交）：如某处理器无挖矿产出资格 */}
        {showIssues && (review.warnings || []).length > 0 && (
          <div className="issues issues-warn">
            {(review.warnings || []).map((warn) => (
              <p key={warn}>{warn}</p>
            ))}
          </div>
        )}

        <div className="publish-submit">
          <div className="publish-submit-text">
            {/* 显示**当前生效**的规模：用户填了就用填的，别拿建议方案糊弄 */}
            <strong>{effCap > 0 ? `${Number(effCap).toFixed(4)} BNB` : "—"}</strong>
            <span>
              {effShares > 0 ? `${effShares} 份` : "—"} · 每份 {priceInput ? `${priceInput} BNB` : "—"} · 募集 {daysValid ? `${daysNum} 天` : `${draft.fundingDays || "—"} 天（待修正）`}
              {feeValid ? ` · 挖矿产出服务费 ${Number(draft.feePercent)}%（写入链上）` : ""}
            </span>
          </div>
          <button
            className="btn btn-primary btn-inline"
            type="submit"
            disabled={!canSubmit}
            onClick={() => setSubmitTried(true)}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </section>
  );
}

export function OwnerHolders({ round, book, account = "", holders = null, chainMode = false, embedded = false }) {
  // 链上模式：读合约 _holders；模拟模式：用 buildHolders 生成的演示名册
  const loading = chainMode && holders == null;
  const rows = chainMode
    ? (holders || []).map((h) => ({
        address: h.address,
        shares: h.shares,
        at: "链上记录",
        self: String(h.address).toLowerCase() === String(account || "").toLowerCase(),
      }))
    : buildHolders(book.sold, book.mine);
  const subtitle = chainMode
    ? "合约里记下的认筹地址。份数是当前仍持有的份额。"
    : "只记录通过认筹记上的份数。直接转入的 BNB 不会出现在这里。";
  return (
    <section>
      {!embedded && (
        <header className="page-header">
          <div>
            <h1>份额明细</h1>
            <p className="page-subtitle">{subtitle}</p>
          </div>
        </header>
      )}
      <article className="card">
        <div className="card-header">第 {round.id} 期 · {loading ? "…" : rows.length} 个地址 · 已售 {book.sold} 份</div>
        <div className="card-body table-wrap">
          {loading ? (
            <p className="fine">正在从合约读取认筹地址…</p>
          ) : rows.length === 0 ? (
            <p className="fine">{book.sold > 0 ? "链上已有认筹份数，地址列表暂时没有读到。请稍后再开一次份额明细。" : "这一期还没有人认筹。"}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>地址</th>
                  <th>份数</th>
                  <th>金额</th>
                  <th>占比</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.address}>
                    <td>{row.self ? `${shortAddress(row.address)} 当前钱包` : shortAddress(row.address)}</td>
                    <td>{row.shares}</td>
                    <td>{(row.shares * round.sharePriceBnb).toFixed(4)} BNB</td>
                    <td>{book.sold ? `${Math.round((row.shares / book.sold) * 1000) / 10}%` : "—"}</td>
                    <td>{row.at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </article>
    </section>
  );
}
