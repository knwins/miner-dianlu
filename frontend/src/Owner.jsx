import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContractCalls } from "./Calls.jsx";
import { dealStatus } from "./dealStatus.js";
import { escrowNote } from "./escrowNote.js";
import { ENDED, FAILED, SCENE, nextActionOf, phaseOf, roundState, rowState } from "./roundState.js";
import OnChainPage from "./OnChain.jsx";
import { formatEther } from "./chain/client.js";
import { MarketTradePanel } from "./MarketTrades.jsx";
import { officialPartPrices } from "./OfficialPricePanel.jsx";
import { RefundRecords } from "./RefundRecords.jsx";
import { processorFromPartsContract } from "./tapeout.js";
import PeriodNav from "./PeriodNav.jsx";
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
   * ⚠️不再有「留空= 跟随建议方案」这回事：建议方案依赖处理器与晶体管报价，
   * 而发布期**处理器必须显式选择**（链上模式从工厂白名单选，见 transistors 字段；
   * 演示模式由系统按默认型号派生）。建议值只在选好处理器后才有意义。
   * 现在发行参数（总额/份数/天数）都是必填，由开期人自己定。
   *
   * 开期人可调的旋钮：募资总额、总份数、募集天数、本期处理器（链上必选）、挖矿产出服务费与分成表。
   * 晶体管合约不再由工厂默认写入：开期时从白名单显式选一个处理器，发布后该期锁定其晶体管合约。
   */
  /** 募资总额（BNB）：必填 */
  hardCapBnb: "",
  /** 总份数：必填正整数 */
  totalShares: "",
  fundingDays: "15",
  /**
   * 本期处理器（晶体管合约地址）：链上模式**必选**，从工厂白名单里选，开期后不可改；
   * 演示模式留空，由模拟引擎按默认型号派生（不写链上）。
   * T-79 核心改动：工厂不再有默认晶体管，开期人必须显式选。
   */
  transistors: "",
  /**
   * 服务费与分成（**链上参数**，口径：服务费真正上链）。
   *
   * ⚠️ **服务费是什么（口径澄清）**：
   *   本期的「服务费」是**挖矿产出奖励的服务费** —— 从矿池打进来的挖矿收益里按比例计提，
   *   分给下面的分成地址。**认筹款不收服务费**：认购人付的 BNB 全额进认购托管池，
   *   只用于买晶体管，链上不存在从认筹款抽服务费的路径。
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
  onSellTransistors, onWithdrawMarketProceeds,
  onDepositToPool, onSetMiningPool, onSetPlan, onReturnSurplus,   onRemoveCampaign, onOpenRound, onOpenAssets,
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
  // 池子够不够按份全额退款由 escrowNote 内部判定（同一口径只写一处）。
  const escrowNoteInfo = escrowNote(book, round);
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
   * 熔断闸门（链上事实）。
   * 拉闸 Owner / 操作员都能做，抬闸只有 Owner（合约 onlyOwner）——所以「解除熔断」
   * 收在「高级配置」里，这里只保留日常运营需要的拉闸与状态提示。
   */
  const halted = Boolean(book.halted);
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
   *   1. 链上晶体管市场单价（transistorUnitPrice，Owner 实际挂单/成交价）—— 最权威
   *   2. 晶体管市场最新价（tapeout.net market.json）—— NAND / LATCH 分别取价
   *   3. 都没有 → 0（表单不预填价格，Owner 自己填）
   *
   * 之前只有一个 suggestedUnit，NAND 与 LATCH 共用同一个价——
   * 但这两种晶体管市价差得很远（官方 TapeOut NAND 0.0501 / LATCH 0.0455，
   * Behemoth 差距更大），共用一个价必然有一边挂错价。这里按晶体管分开。
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
  /** 每种晶体管的参考价（BNB/颗）：链上优先，官方市价其次 */
  const refPrice = {
    NAND: minterUnit > 0 ? minterUnit : officialParts.NAND,
    LATCH: minterUnit > 0 ? minterUnit : officialParts.LATCH,
  };
  const [nandQty, setNandQty] = useState("1");
  const [latchQty, setLatchQty] = useState("1");
  const [nandPrice, setNandPrice] = useState("0");
  const [latchPrice, setLatchPrice] = useState("0");
  /** 卖出：按买单 ID 记每张单要卖多少颗（不填时默认取可卖上限，见 bidCap）。 */
  const [sellQty, setSellQty] = useState({});
  const priceTouched = useRef(false);
  useEffect(() => {
    priceTouched.current = false;
    // 切期次时把挂买单数量也复位成默认各 1 颗，避免沿用上一期填过的数量
    setNandQty("1");
    setLatchQty("1");
    setSellQty({});
  }, [book.address]);
  /**
   * 挂买单：数量默认各 1 颗（NAND / LATCH），单价预填成当前市场参考价
   * （用户改过就不再覆盖）。
   *
   * 数量只是「默认各买一颗」的便利值，不是按募资额或配比反推的结果——
   * 买多少仍由 Owner 自己改；某条腿改成 0 即不下该腿。
   *
   * NAND 与 LATCH 各用各的参考价：市价差得远，共用一个价必然有一边挂错。
   */
  useEffect(() => {
    if (book.executePhase !== "buying" || priceTouched.current) return;
    if (refPrice.NAND > 0) setNandPrice(priceText(round5(refPrice.NAND)));
    if (refPrice.LATCH > 0) setLatchPrice(priceText(round5(refPrice.LATCH)));
  }, [book.address, book.executePhase, refPrice.NAND, refPrice.LATCH]);
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
  const STATUS_ORDER = ["全部", SCENE.funding.label, SCENE.executing.label, SCENE.mining.label, ENDED.label, FAILED.label];
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
  /**
   * 操作员权限（合约 `_isOperator()`）：owner 天然拥有，operator 热钱包也有。
   * 日常运营入口用它判定；入池 / 改子态 / 取回资产 / 抬闸 / 换操作员仍然只认 isOwner。
   */
  const canOperate = isOwner || actor?.role === "operator";
  // 取消挂单后合约回到待挂单；未重新挂单前不可 execute（priceLock/晶体管数已清）
  const canExecute = isOwner && !book.executionFailed && Number(book.priceLock || 0) > 0 && Number(book.transistorCount || 0) > 0;
  const planWritten = Number(book.estHashpower) > 0 || Number(book.transistorCount) > 0;
  /**
   * 本期阶段 / 子状态 / 认购徽标 —— 全部取 ./roundState.js + ./dealStatus.js。
   *
   * 旧版这里自己拼了三套：
   *   sceneTitle（募集中/待执行/挖矿中）+ liveEnded/liveFundingExpired 推「已结束」
   *   + liveStatus 再推一次「执行失败」
   *   + 卡片 statusNote 用 adapter 的第四套文案
   * 同一个「已结束」在标题、徽标、子状态行各出现一次。
   */
  const liveState = rowState(book, Date.now() / 1000, dealStatus);
  const liveStatus = { badge: liveState.label, tone: liveState.tone };

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
  /** 退余款也必须显式接线：可选调用会让按钮点了没反应。 */
  const submitReturnSurplus = requireOps("returnSurplus", onReturnSurplus);

  function renderOps() {
    // 订单/结算状态一变就重读市场流水（挂单、成交、确认到账、提取卖出款）。
    const marketRefreshKey = [
      book.executePhase, book.nandBidId, book.latchBidId,
      book.nandRemaining, book.latchRemaining, book.marketOwed,
      book.partsNand, book.partsLatch, book.orderFilled,
      (book.sellBids || []).map((b) => `${b.id}:${b.remaining}:${b.price}`).join(","),
    ].join("|");
    return (
      <div className="detail-split">
        <article className="card">
              <div className="card-header">
                <span>本期操作 · {liveState.label}</span>
                <span className="stat-label">身份：{actor?.label || "未连接"}</span>
              </div>
              <div className="card-body">
                {halted && (
                  <p className="fine warn-text">
                    本期已熔断：认筹、挂单、卖出、入池与份额交易暂停；
                    退款、领款、撤单不受影响。解除只有 Owner 能做。
                  </p>
                )}
                {book.scene === "funding" && (
                  <>
                    <ul className="bill">
                      <li><span>募集进度</span><strong>{book.sold}/{round.totalShares} 份 · {round4(raised)} BNB</strong></li>
                      <li><span>setPlan</span><strong>{planWritten ? "已写入" : "尚未写入"}</strong></li>
                      <li className="due"><span>本阶段 Owner 可做</span><strong>写入预估算力 / 晶体管数；等待售罄</strong></li>
                    </ul>
                    <div className="actions">
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={!canOperate || Boolean(pending) || !onSetPlan}
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
                      认筹入口在「BEM挖矿认筹」；算力计划写在链上，认购前可核对。
                      {!canOperate && " 当前钱包不是 Owner / 操作员，无法写 setPlan。"}
                    </p>
                  </>
                )}

                {book.scene === "executing" && (() => {
                  /** 子状态词表见 ./roundState.js（`已到账 · 待入池` 这一种写法，全站统一）。 */
                  const phaseLabel = phaseOf(book).full;
                  // 买多少由 Owner 自己填：晶体管在晶体管市场自由买卖，不按任何推算配比限制，两条腿都可用。
                  const nandN = Math.max(0, Math.floor(Number(nandQty) || 0));
                  const latchN = Math.max(0, Math.floor(Number(latchQty) || 0));
                  const nandP = Number(nandPrice) || 0;
                  const latchP = Number(latchPrice) || 0;
                  const orderCostRaw = nandN * nandP + latchN * latchP;
                  const orderCost = round5(orderCostRaw);
                  const heldNand = Number(book.partsNand) || 0;
                  const heldLatch = Number(book.partsLatch) || 0;
                  const buyOpen = book.executePhase === "listed";
                  const idle = !buyOpen;
                  // Ready：买单已确认。这里才能把晶体管卖入市场买单、入池或退余款。
                  const ready = book.executePhase === "ready";
                  const marketOwedEarly = Number(book.marketOwed) || 0;
                  // 测试网 MockMaterialMarket：可直接在当前买单卡片上模拟卖方成交。
                  const mockMarket = Boolean(
                    book._chain
                    && Number(deployments.chainId) === 97
                    && deployments.materialMarket
                    && book.market
                    && String(book.market).toLowerCase() === String(deployments.materialMarket).toLowerCase()
                  );
                  const canBuy = raised > 0 && idle && book.executePhase === "buying"
                    && Number(book.sold || 0) >= Number(round.totalShares || 0);
                  /**
                   * 官方晶体管市场只有买单侧，卖出 = 吃一张已挂买单。
                   * 这里列出「标的是本期晶体管、买家不是本期、还有剩余量」的外部买单。
                   *
                   * 只展示前 SELL_BID_LIMIT 张：读取侧按单价从高到低排好序（见 client.js
                   * `readSellableBids`），前几张就是最值得吃的。市场里可能躺着几十张买单，
                   * 全铺出来会把这个弹窗撑得很长，而且排在后面的低价单基本不会被选中。
                   */
                  const SELL_BID_LIMIT = 5;
                  const sellBidsAll = Array.isArray(book.sellBids) ? book.sellBids : [];
                  const sellBids = sellBidsAll.slice(0, SELL_BID_LIMIT);
                  const bidHeld = (bid) => (Number(bid.tokenId) === 0 ? heldNand : heldLatch);
                  /**
                   * 一张买单最多能卖多少 = min(买单剩余, 本期手上这颗 − 上方同型号行已占用的数量)。
                   * 三个上限缺一不可：
                   *   - 超买单剩余 → 链上 BadBidId / 超量回滚；
                   *   - 超持仓 → 拿不出来的数字（图上就是剩余 15、只持有 1 却显示 15）；
                   *   - 两张 LATCH 买单各填 1 而手上只有 1 → 第二笔必 revert。
                   * 同型号按列表顺序分配持仓：排前面的行先占，后面的行只能用剩下的，
                   * 所以把上面一行改小，下面那行的可用上限会跟着变大。
                   * 这也是输入框的上限（`max`）与默认值。
                   */
                  const bidCap = (bid) => {
                    const tokenId = Number(bid.tokenId);
                    const held = bidHeld(bid);
                    let used = 0;
                    for (const other of sellBids) {
                      if (Number(other.tokenId) !== tokenId) continue;
                      if (other.id === bid.id) break;
                      const otherCap = Math.max(0, Math.min(Number(other.remaining) || 0, bidHeld(other) - used));
                      const otherRaw = sellQty[other.id];
                      const otherQty = otherRaw == null
                        ? otherCap
                        : Math.max(0, Math.min(otherCap, Math.floor(Number(otherRaw) || 0)));
                      used += otherQty;
                    }
                    return Math.max(0, Math.min(Number(bid.remaining) || 0, held - used));
                  };
                  const bidQtyOf = (bid) => {
                    const raw = sellQty[bid.id];
                    // 没碰过 = 默认卖满上限；手动清空 = 0（按钮置灰并说明「要大于 0」），不偷偷改回上限。
                    const want = raw == null ? bidCap(bid) : Math.floor(Number(raw) || 0);
                    return Math.max(0, Math.min(bidCap(bid), want));
                  };
                  /** 输入时就夹住：只留数字，超上限立刻压回上限；空串保留给用户改写。 */
                  const clampBidQty = (value, cap) => {
                    const digits = String(value).replace(/\D/g, "");
                    if (digits === "") return "";
                    return String(Math.min(cap, Number(digits)));
                  };
                  const bidFloor = (bid) => Number(Number(bid.tokenId) === 0 ? book.nandCostBasis : book.latchCostBasis) || 0;
                  const bidSellable = (bid) => bidQtyOf(bid) > 0 && Number(bid.price) >= bidFloor(bid);
                  /** 入池只要求手里有晶体管，不再比对推算出来的配比 */
                  const partsEnough = heldNand + heldLatch > 0;
                  // 合约 confirmTransistors() 要求两条腿 remaining 全为 0 **并且** 本期真的持有对应数量的晶体管。
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
                  // 合约 placeTransistorOrder 是 operator 级：Owner 与操作员都能挂，入池才是 owner 专属。
                  const canPlaceBuy = canOperate && canBuy && !overBudget && !halted
                    && (nandN > 0 || latchN > 0)
                    && (nandN === 0 || nandP > 0)
                    && (latchN === 0 || latchP > 0);
                  const bidRows = [
                    Number(book.nandQty) > 0
                      ? { side: "buy", part: "NAND", id: book.nandBidId || "—", qty: book.nandQty, price: book.nandPrice, remaining: book.nandRemaining }
                      : null,
                    Number(book.latchQty) > 0
                      ? { side: "buy", part: "LATCH", id: book.latchBidId || "—", qty: book.latchQty, price: book.latchPrice, remaining: book.latchRemaining }
                      : null,
                  ].filter(Boolean);
                  const legOpen = (row) => {
                    if (book.executePhase !== "listed") return false;
                    if (row.remaining == null) return !book.orderFilled;
                    return Number(row.remaining) > 0;
                  };
                  const liveRows = buyOpen ? bidRows : [];
                  {/*
                   * 步骤条要落在真实阶段上：
                   * 旧版 buyOpen 一律算第 2 步「确认到账」，但挂单还在等成交时
                   * 根本不能确认（合约要求 remaining 全 0），高亮会指错下一步。
                   * 只有买单全部成交（orderFilled）才进「确认到账」。
                   */}
                  const flowStep = book.executePhase === "ready" ? 3 : book.orderFilled ? 2 : 1;
                  // 卖出款由 sellTransistors 立即提回；市场还欠款时可手工提取（入池/退余款前必须清零）。
                  const marketOwed = marketOwedEarly;
                  const canWithdraw = canOperate && marketOwed > 0;
                  const canRefund = canOperate && marketOwed <= 0
                    && outstanding > 0
                    && book.executePhase === "buying";
                  const dustOnly = isOwner && outstanding === 0 && Number(book.bnbPool || 0) > 0;
                  /**
                   * 确认到账后把没花完的募集款按份退回：不结束本期、晶体管留在合约、之后仍能入池。
                   */
                  const canReturnSurplus = canOperate && ready
                    && raised > 0 && marketOwed <= 0 && outstanding > 0;
                  const surplusBooked = Number(book.surplusOutstanding || 0) > 0;
                  /**
                   * 入池前必须先把余款按份退回（余额=0 时无需退）。
                   * 已记账（surplusBase > 0）即算满足。
                   */
                  const surplusBeforePool = raised <= 0 || Number(book.surplusBase || 0) > 0;
                  const surplusReturnHint = marketOwed > 0
                    ? "晶体管市场还有卖出款没提回本期，先提取再退剩余募集款"
                    : raised <= 0
                      ? "募集款已全部用于买晶体管，没有可退的余款"
                      : undefined;
                  const refundHint = ready
                    ? "晶体管已到账，不能打开退款。用「退回剩余募集款」把没花完的 BNB 按份退给持份人；确要结束本期，先把子状态改回待挂单。"
                    : outstanding === 0
                      ? "份额已全部退完，没有可退对象；池子里的尾差用「取回剩余 BNB」扫出"
                      : "标记执行失败，持份人各自领回本金。重复点击安全。";
                  // 放弃挂单：一次撤销买单剩余 + 提取卖出款 + 打开退款闸门，不需要逐项操作；
                  // 退款本身是 pull，各持份人自己去领。
                  // 成交的部分已上链不可撤；只有还剩未成交时才允许放弃。
                  const hasOpenLeg = [book.nandRemaining, book.latchRemaining]
                    .some((remaining) => remaining == null || Number(remaining) > 0);
                  // 晶体管事先确认到账（Ready）后 abandonOrder 会以 UseReturnSurplus 回滚：
                  // 那个状态只允许「退余款 + 入池 / 卖入买单」，晶体管不能被退回 Owner。
                  const canAbandon = isOwner && !ready && buyOpen && hasOpenLeg;
                  const nextHint = ready
                    ? (partsEnough
                      ? "买单已确认，晶体管在合约里。可卖入市场买单（款立即提回），或先「退回剩余募集款」按份退给持份人；之后设矿池并入池（不可逆）。"
                      : "手里还没有晶体管，不能入池。先挂买单买入并确认到账。")
                    : outstanding === 0
                      ? "已全部退款（份数归零），池子里若还有多余 BNB，Owner 可用「取回 BNB」扫出。"
                      : buyOpen
                        ? (book.orderFilled
                          ? (partsForOrderEnough
                            ? "买单已成交齐，点「确认到账」。确认后才能卖入市场买单、入池或退余款。"
                            : `买单已成交，但晶体管还没进本期合约（还缺 ${partsShortLabel || "晶体管"}）。` +
                              (mockMarket
                                ? "点「补发晶体管」按缺额 mint 后再确认；链上 confirmTransistors 要求晶体管余额到位。"
                                : "等卖家把晶体管转到本期合约后，再点「确认到账」。"))
                          : "等待市场成交。未成交部分可以取消；成交的不能撤销。")
                        : canBuy
                          ? "挂买单买入晶体管，成交并确认到账后才能卖出、入池或退余款。"
                          : book.executionFailed
                            ? "上次挂单超余额未挂出，改低单价重试或退款。"
                            : "当前不能挂单。";
                  /**
                   * 撤单权限与合约一致：未成交时只有 Owner / 操作员；
                   * 已有成交或该期已从工厂移除后，任何人都能撤剩余（托管款不能卡死）。
                   */
                  const canCancelOrder = canOperate
                    || book.retired
                    || (Number(book.nandQty) > 0 && Number(book.nandRemaining) < Number(book.nandQty))
                    || (Number(book.latchQty) > 0 && Number(book.latchRemaining) < Number(book.latchQty));
                  const canConfirm = connected && buyOpen && book.orderFilled && partsForOrderEnough;
                  const confirmHint = !buyOpen
                    ? undefined
                    : !book.orderFilled
                      ? "买单还没全部成交"
                      : !partsForOrderEnough
                        ? `晶体管还没到账：还缺 ${partsShortLabel || "晶体管"}` + (mockMarket ? "。点「补发晶体管」补齐后再确认。" : "。等卖家把晶体管转到本期合约后再确认。")
                        : undefined;

                  const renderBuyForm = () => {
                    /**
                     * 市价列来源：链上单价优先（mock / 测试网），官方市价其次（主网）。
                     * 列头直接写来源，单元格只留数字 —— 数字本身就是可点填的按钮
                     * （主色 + 下划线 + title 提示），不再挂「官方市价 · 点填」小字。
                     */
                    const quoteLabel = minterUnit > 0 ? "链上市场单价" : "官方市价";
                    const legs = [
                      { key: "nand", label: "NAND", qty: nandQty, setQty: setNandQty, price: nandPrice, setPrice: setNandPrice, touch: priceTouched, quote: refPrice.NAND, source: quoteLabel },
                      { key: "latch", label: "LATCH", qty: latchQty, setQty: setLatchQty, price: latchPrice, setPrice: setLatchPrice, touch: priceTouched, quote: refPrice.LATCH, source: quoteLabel },
                    ];
                    return (
                      <div className="flow-form">
                        {/*
                         * 列宽不再由 table-layout: fixed 四等分决定 ——
                         * 四等分会让「晶体管」白占 130px、让「官方市价」的 40px 内容
                         * 贴在列左端而右侧空出 90px。这里给死前四列的最小需求，
                         * 余量留给「官方市价」，数字列统一右对齐（见 .flow-table-order）。
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
                              <th>晶体管</th>
                              <th>数量</th>
                              <th>买价 BNB</th>
                              <th>{quoteLabel}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {legs.map((leg) => (
                              <tr key={leg.key}>
                                <td>
                                  <strong>{leg.label}</strong>
                                </td>
                                <td>
                                  <input inputMode="numeric" value={leg.qty} disabled={!canOperate || Boolean(pending)} onChange={(e) => leg.setQty(e.target.value)} />
                                </td>
                                <td>
                                  <input
                                    inputMode="decimal"
                                    step="0.00001"
                                    placeholder="0.00000"
                                    title="单价最多五位小数（0.00001 BNB/颗）"
                                    value={leg.price}
                                    disabled={!canOperate || Boolean(pending)}
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
                                    </button>
                                  ) : <span className="muted-value">无市价</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="flow-form-bar">
                          <span className={overBudget ? "is-warn" : undefined}>
                            {`托管 ${orderCost} BNB · 可用 ${round4(raised)}${overBudget ? " · 超余额不会挂出" : ""}`}
                          </span>
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={!canPlaceBuy || Boolean(pending)}
                            title={
                              !canOperate
                                ? "只有 Owner / 操作员能挂买单"
                                : halted
                                  ? "本期已熔断：挂单暂停，等 Owner 解除"
                                  : !canBuy
                                    ? "只有「待执行 · 待挂单」且募满后能下单"
                                    : overBudget
                                      ? "托管额超过可用 BNB，链上会以 ExecutionFailed 空跑"
                                      : nandN + latchN === 0
                                        ? "至少一条腿要填数量"
                                        : (nandN > 0 && !(nandP > 0)) || (latchN > 0 && !(latchP > 0))
                                          ? "填了数量的腿必须有机价（> 0）"
                                          : undefined
                            }
                            onClick={() => onPlaceTransistorOrder?.({
                              nandQty: nandN,
                              latchQty: latchN,
                              nandPrice: nandN > 0 ? String(nandP) : "0",
                              latchPrice: latchN > 0 ? String(latchP) : "0",
                            })}
                          >
                            {pending === "placeTransistorOrder" ? "提交中…" : "提交买单"}
                          </button>
                        </div>
                      </div>
                    );
                  };

                  /**
                   * Ready 的卖出：官方晶体管市场没有卖单簿，卖出 = 吃一张已挂买单。
                   * 每张买单一个数量输入（默认填满可卖上限 = min(买单剩余, 持仓)，可改小），
                   * 单价由买单决定，本期不能自己喊价。
                   * 合约侧还会校验：标的必须是本期晶体管、买家不能是本期自己、单价不得低于本期买入成本。
                   */
                  const renderSellPanel = () => {
                    if (book._chain && !book.sellSide) {
                      return <p className="flow-empty">读不到晶体管市场，暂时列不出可吃的买单。刷新重试，或直接入池。</p>;
                    }
                    if (!book._chain) {
                      return <p className="flow-empty">模拟模式不列出外部买单：确认到账后可直接入池。</p>;
                    }
                    if (heldNand + heldLatch === 0) {
                      return <p className="flow-empty">手里没有可卖的晶体管，先挂买单买入并确认到账。</p>;
                    }
                    if (sellBids.length === 0) {
                      return <p className="flow-empty">市场里还没有标的本期晶体管的买单。等外部买家挂单，或直接入池。</p>;
                    }
                    return (
                      <div className="flow-form">
                        <table className="flow-table">
                          <thead>
                            <tr>
                              <th>晶体管</th>
                              <th>单价 BNB</th>
                              <th>剩余</th>
                              <th>卖出</th>
                              <th>买家</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {sellBids.map((bid) => {
                              const part = Number(bid.tokenId) === 0 ? "NAND" : "LATCH";
                              const floor = bidFloor(bid);
                              const belowCost = Number(bid.price) < floor;
                              const cap = bidCap(bid);
                              const qty = bidQtyOf(bid);
                              const ok = canOperate && !halted && !pending && bidSellable(bid);
                              return (
                                <tr key={bid.id}>
                                  <td>
                                    <strong>{part}</strong>
                                    <span className="flow-max">持有 {bidHeld(bid)}</span>
                                  </td>
                                  <td
                                    className={belowCost ? "is-warn" : undefined}
                                    title={belowCost ? `低于本期买入成本 ${formatUnitPrice(floor)} BNB/颗，链上会以 PriceBelowCost 回滚` : undefined}
                                  >
                                    {formatUnitPrice(round5(Number(bid.price)))}
                                  </td>
                                  <td>{Number(bid.remaining)}</td>
                                  <td>
                                    {/*
                                     * 卖出数量：默认 = 上限（min(买单剩余, 持仓 − 同型号其它行)），可直接改小。
                                     * 输入时就把超上限的数字压回上限，显示层再夹一次（成交后持仓变小、
                                     * 旧输入值还没重置时，框里也不会显示一个卖不出去的数字）。
                                     */}
                                    <input
                                      inputMode="numeric"
                                      aria-label={`${part} 卖出数量`}
                                      value={(() => {
                                        const raw = sellQty[bid.id];
                                        if (raw == null) return String(cap);
                                        if (raw === "") return "";
                                        return String(Math.min(cap, Math.floor(Number(raw) || 0)));
                                      })()}
                                      max={cap}
                                      min={0}
                                      disabled={!canOperate || Boolean(pending) || cap === 0}
                                      title={
                                        cap === 0
                                          ? "本期手上没有这颗晶体管可卖（或已被上方同型号买单分配完）"
                                          : `最多可卖 ${cap} 颗（买单剩余、持仓、同型号其它买单三者取小）`
                                      }
                                      onChange={(e) =>
                                        setSellQty((prev) => ({ ...prev, [bid.id]: clampBidQty(e.target.value, cap) }))
                                      }
                                    />
                                  </td>
                                  <td className="mono">{shortAddress(bid.buyer)}</td>
                                  <td>
                                    <button
                                      className="btn btn-inline"
                                      type="button"
                                      disabled={!ok}
                                      title={belowCost
                                        ? `买单单价低于本期买入成本（${formatUnitPrice(floor)} BNB/颗），合约会拒绝`
                                        : halted
                                          ? "本期已熔断：卖出暂停，等 Owner 解除"
                                          : cap === 0
                                            ? "本期没有可卖的这颗晶体管（手上没有，或已被上方同型号买单分配完）"
                                            : qty === 0
                                              ? "卖出数量要大于 0"
                                              : undefined}
                                      onClick={() => onSellTransistors?.({
                                        bidId: String(bid.id),
                                        tokenId: Number(bid.tokenId),
                                        quantity: qty,
                                      })}
                                    >
                                      {pending === "sellTransistors" ? "卖出中…" : "卖出"}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <p className="fine">
                          单价由买单决定，成交款扣 1% 市场费后立即提回本期。低于本期买入成本的买单不能卖（会烧掉持份人的抵押）。
                          {sellBidsAll.length > sellBids.length
                            ? ` 可吃买单共 ${sellBidsAll.length} 张，这里按单价从高到低只列前 ${sellBids.length} 张。`
                            : ""}
                        </p>
                      </div>
                    );
                  };

                  return (
                    <div className="ops-exec">
                      {/*
                       * 只留「子状态 / 处理器」。
                       * 资金与晶体管不在这里报：弹窗顶部概览条已经有份数、募资、
                       * 算力、已买入晶体管、已入矿池五项，这里再写一遍就是同一数据
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
                      {(book.executePhase === "buying" || book.executePhase === "listed" || ready || marketOwed > 0) && (
                        <div className="flow-panel">
                          <div className="flow-panel-head">
                            <div>
                              {/*
                               * 只留标题：这段原本每个分支都有一句说明，但和正上方
                               * 「下一步」的 nextHint 逐字重复。
                               * 说明归 nextHint 一处，这里只交代这是哪张单。
                               */}
                              <h3>{buyOpen ? "当前买单" : ready ? "卖入市场买单" : "挂买中"}</h3>
                            </div>
                          </div>

                          <div className="flow-panel-body">
                            {buyOpen ? (
                              <>
                                <table className="flow-table">
                                  <thead>
                                    <tr>
                                      <th>晶体管</th>
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
                                            {/*
                                             * 「进度」列：不写「挂单中」——那是生命周期条上的**子状态**词，
                                             * 这里的语义是「这笔单还没成交」，用「等成交」区分开。
                                             */}
                                            {open
                                              ? (row.remaining == null ? "等成交" : `剩 ${Number(row.remaining)} · 成 ${Math.max(0, filled)}`)
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
                                            ? (partsForOrderEnough ? "确认到账" : "等待晶体管到账…")
                                            : "等待成交…"}
                                      </button>
                                      {!book.orderFilled && (
                                        <button
                                          className="btn btn-inline"
                                          type="button"
                                          disabled={!canCancelOrder || Boolean(pending)}
                                          title={canCancelOrder ? undefined : "未成交时仅 Owner / 操作员能撤单"}
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
                                            ? "测试网 Mock：买单已成交但晶体管没进本期合约，按缺额补发后再确认到账"
                                            : "测试网 Mock 市场：代替卖方成交这两张买单，并把测试晶体管铸给本期合约"}
                                        >
                                          {pending === "simulateFillCampaignBids"
                                            ? "撮合中…"
                                            : book.orderFilled ? "补发晶体管" : "模拟成交"}
                                        </button>
                                      )}
                                    </>
                                  )}
                                  {canWithdraw && (
                                    <button
                                      className="btn btn-inline"
                                      type="button"
                                      disabled={!canWithdraw || Boolean(pending)}
                                      onClick={onWithdrawMarketProceeds}
                                    >
                                      {pending === "withdrawMarketProceeds" ? "提取中…" : "提取卖出款"}
                                    </button>
                                  )}
                                </div>
                              </>
                            ) : (
                              <>
                                {!ready && (canBuy ? renderBuyForm() : (
                                  <p className="flow-empty">
                                    {raised <= 0 ? "募集余额为 0，无法挂买单。" : "当前不能挂买单。"}
                                  </p>
                                ))}
                                {marketOwed > 0 && (
                                  <div className="flow-panel-actions">
                                    <button
                                      className="btn btn-inline"
                                      type="button"
                                      disabled={!canWithdraw || Boolean(pending)}
                                      onClick={onWithdrawMarketProceeds}
                                    >
                                      {pending === "withdrawMarketProceeds" ? "提取中…" : "提取卖出款"}
                                    </button>
                                    <span className="flow-note">市场还欠本期 {round4(marketOwed)} BNB，入池或退余款前先提回。</span>
                                  </div>
                                )}
                                {ready && renderSellPanel()}
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      {(book.executePhase === "buying" || book.executePhase === "listed" || ready) && (
                        <div className="flow-tools">
                          {/*
                           * 退余款不是退款：钱按份退回持份人（pull，各自 claimSurplus 领），
                           * 晶体管留在合约、份额不变、phase 仍是 Ready，之后照样能 depositToPool。
                           * 所以它独立成一个按钮，和「原路退款」（结束本期、晶体管归 Owner）并排说清区别。
                           */}
                          {ready && (
                            <button
                              className="btn btn-inline"
                              type="button"
                              disabled={!canReturnSurplus || Boolean(pending)}
                              onClick={submitReturnSurplus}
                              title={surplusReturnHint}
                            >
                              {pending === "returnSurplus"
                                ? "记账中…"
                                : surplusBooked
                                  ? `已按份退回 ${round4(Number(book.surplusOutstanding || 0))} BNB（持份人自领）`
                                  : `退回剩余募集款 ${round4(raised)} BNB`}
                            </button>
                          )}
                          {!ready && (
                            <button
                              className="btn btn-inline"
                              type="button"
                              disabled={!canRefund || Boolean(pending)}
                              onClick={onOpenRefund}
                              title={refundHint}
                            >
                              {pending === "openRefund" ? "打开中…" : "打开退款"}
                            </button>
                          )}
                          {dustOnly && (
                            <button
                              className="btn btn-inline"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={onRecoverBnb}
                              title="份额已全部退完，池子里的尾差没有归属。用 recoverBnb 一次转给 Owner。"
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
                                ? "买单已全部成交，晶体管已上链，无法撤销"
                                : "撤未成交买单、提取卖出款，然后打开退款（持份人各自领回本金）。"}
                            >
                              {pending === "abandonOrder" ? "撤回中…" : "放弃挂单并开退款"}
                            </button>
                          )}
                        </div>
                      )}

                      {ready && !book.executionFailed && (
                        <div className="flow-panel">
                          <div className="flow-panel-head">
                            <div>
                              <h3>进入挖矿</h3>
                              {/*
                               * 只写这一格独有的信息：入池不可逆。
                               * 「先退余款再入池」的顺序已经写在正上方的「下一步」里，
                               * 这里整段复述一遍等于同一句话在同一个弹窗里出现两次。
                               */}
                              <p>
                                入池不可逆：晶体管转入矿池后，合约无法再取回。
                              </p>
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
                                一旦 <code>depositToPool</code> 执行，晶体管不可逆地转入该矿池。
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
                                disabled={!isOwner || Boolean(pending) || halted || !hasPoolOnChain || !surplusBeforePool || marketOwed > 0 || !partsEnough}
                                title={
                                  halted
                                    ? "本期已熔断：入池已暂停，等 Owner 解除"
                                    : !partsEnough
                                      ? "本期合约手上没有晶体管（InsufficientParts）：先挂单买入并确认到账"
                                      : !hasPoolOnChain
                                      ? "请先设置矿池地址（链上 depositToPool 要求 miningPool 非零）"
                                      : marketOwed > 0
                                        ? "市场还欠本期卖出款，先点上面的「提取卖出款」再入池"
                                        : !surplusBeforePool
                                          ? "入池前先把剩余募集款按份退回持份人：点上面的「退回剩余募集款」"
                                          : undefined
                                }
                                onClick={() => submitDepositToPool()}
                              >
                                {pending === "depositToPool" ? "投入中…" : "depositToPool 进入挖矿"}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {(book.executionFailed && idle) || !canOperate ? (
                        <p className="fine ops-note">
                          {book.executionFailed && idle && "上次挂单托管超过募集余额，交易上链但没真正挂出。请降低数量或单价重挂，或直接退款。"}
                          {!canOperate && " 当前钱包不是 Owner / 操作员，无法执行写操作。"}
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
                      晶体管已投入矿池，不可撤出。BEM 分配合约接入前 harvest / claim 是占位空实现，不产出发放。
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
                     * 算力与晶体管数不在这里报。
                     * 旧版是「预估算力」+「链上算力 / 晶体管」两行，两行的数字同源
                     * （链上没有实时算力 getter，book.hashpower 就是 setPlan 写进去的
                     * estHashpower），加上顶部概览条的「算力」「已买入晶体管」，同一个值
                     * 会在一个弹窗里出现三次。
                     * 晶体管数的权威口径不变：链上**已成交到账量**（挂单量 − 市场 remaining），
                     * 不是 nandQty + latchQty 本身 —— 那只是下单量，成交前不代表已买到。
                     */}
                    <div>
                      <dt>托管 BNB</dt>
                      <dd>
                        {round4(book.bnbPool || 0)} BNB
                        {/* 副文案随阶段变（预算 / 余款 / 退款能力 / 已结清），口径见 ./escrowNote.js */}
                        <span className={`param-hint is-${escrowNoteInfo.tone}`}>{escrowNoteInfo.text}</span>
                      </dd>
                    </div>
                    <div><dt>锁价</dt><dd>{book.priceLock ? `${round4(book.priceLock)} BNB` : "未锁"}</dd></div>
                  </dl>
                  </div>
                </article>

                {/*
                 * 熔断卡已移除：halt / resume 都收进「合约工作台 · 高级配置」，
                 * 「本期操作」只留推进本期的正常步骤（挂单 / 确认 / 入池 / 退款）。
                 * 页头仍有「本期已熔断」横幅，状态不缺，缺的只是重复的入口。
                 */}
                {/*
                 * 历史交易记录常驻右栏。
                 * 之前只在 scene === "executing" 时渲染，募资阶段整栏直接消失，
                 * 右栏只剩「链上参数」，跟设计稿的「历史交易记录」栏对不上。
                 *
                 * 排序：链上参数 → 历史交易记录。
                 * 官方晶体管最新价不再单独成卡 —— 挂买单表单的「市价」列已经给出
                 * 同源单价（officialPartPrices，点一下即填入），同一数据不出现第二次。
                 */}
                <MarketTradePanel
                  campaignAddr={round.contract || book.address}
                  refreshKey={marketRefreshKey}
                  fallbackRows={{
                    nandBidId: book.nandBidId, latchBidId: book.latchBidId,
                    nandQty: Number(book.nandQty) || 0, latchQty: Number(book.latchQty) || 0,
                    nandRemaining: book.nandRemaining, latchRemaining: book.latchRemaining,
                    nandPrice: Number(book.nandPrice) || 0, latchPrice: Number(book.latchPrice) || 0,
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
                <p>按状态筛选。详情进入该期认筹；合约操作在弹框里完成。</p>
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
                ? "发布后会出现这里，可按状态筛选。"
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
              /*
               * 阶段 / 认购徽标 / 子状态一次算完，全部来自 ./roundState.js。
               * `substateCompact` 在 ready 时只给「待入池」——hero 已经写了「成交晶体管已到账」，
               * 子状态再写「已到账 · 待入池」就是同一句话印两遍。
               */
              const state = rowState(item, Date.now() / 1000, dealStatus);
              const sub = state.substateCompact;
              // 认购徽标的 key：state.deal 可能为空（阶段词已经说明时），不能直接读未定义的 deal。
              const dealKey = state.deal?.key || "none";
              const transistorCount = item.transistorCount != null ? Number(item.transistorCount) : null;
              const deadline = item.fundingDeadline ? Number(item.fundingDeadline) * 1000 : 0;
              const remainMs = deadline > 0 ? deadline - Date.now() : 0;
              const remainText = deadline > 0
                ? (remainMs > 0 ? `剩余募集 ${formatRemain(remainMs)}` : "募集已截止")
                : "";
              return (
                <article key={rowKey(item)} className={`campaign-card ${dealKey === "none" ? "deal-idle" : `deal-${dealKey}`}`} onClick={() => openRound(item)}>
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
                      {/*
                       * 三层各印一次，且互不重复：
                       *   deal 徽标（认购中 / 已售罄，阶段词已说过时为空）
                       *   阶段徽标
                       *   子状态（待挂单 / 挂单中 / 待入池 / 失败原因）
                       * 旧版这里多印一句「本期已结束」之类的 statusNote 兜底文案，
                       * 与左侧徽标撞词。
                       */}
                      {state.deal && state.deal.label ? (
                        <span className={`deal-badge ${state.deal.cls}`}>{state.deal.label}</span>
                      ) : null}
                      <span className={`badge tone-${state.tone}`}>{state.label}</span>
                      {sub ? <small>{sub}</small> : null}
                    </div>
                  </header>

                  {state.deal?.key === "waiting" ? (
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
                  ) : state.deal?.key === "done" ? (
                    <div className="campaign-hero deal-done">
                      {/*
                       * 已售罄 ≠ 晶体管已买到：售罄后 Owner 可能还没挂单。
                       * 「已售罄」由卡片头的状态徽标表达，hero 只讲晶体管这一维：
                       * 晶体管数 > 0 说「N 颗 / 成交晶体管已到账」，为 0 就说「0 颗 / 等待买入」，
                       * 不再出现「已售罄 / 已售罄」或「0 颗 · 成交晶体管已到账」这种自相矛盾。
                       */}
                      <div className="hero-pct">
                        {transistorCount != null && transistorCount > 0 ? `${transistorCount} 颗` : "0 颗"}
                      </div>
                      <div className="hero-sub">
                        {transistorCount != null && transistorCount > 0
                          ? "成交晶体管已到账"
                          : "等待 Owner 买入晶体管"}
                      </div>
                    </div>
                  ) : (
                    <div className="campaign-hero deal-failed">
                      {/* 失败 / 结束的原因就是子状态那一句，不再另配一句同义文案 */}
                      <div className="hero-note">{state.substate}</div>
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
                    <span>{nextActionOf(item)}</span>
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
                              `从工厂列表移除第 ${item.id} 期？\n${item.address}\n\n链上合约仍在，有份额可继续直连该地址。`
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
                         * 这里只留「晶体管」一行，晶体管数才是链上另一个独立事实。
                         */}
                        <dt>已买入晶体管</dt>
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
            <p>晶体管数、募集和可执行操作稍后会出现在这里。</p>
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
              <p>{opened.processor ? `处理器 ${opened.processor} · ` : ""}这一期没有可操作的链上状态</p>
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
              {Number(round.partCount) > 0 ? ` · ${round.partCount} 晶体管` : ""}
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

/**
 * 高级配置：只收**只有 Owner 能调**的入口（权限 / 熔断 / 参数 / 子状态 / 资产取回）。
 *
 * 与「本期操作」分工：
 *   - 本期操作 = 日常运营（Owner 与操作员都能做：setPlan、挂买单、撤单、卖出、退款…；入池只有 Owner）
 *   - 高级配置 = 改权限、换市场、改子状态、取回资产、抬闸 —— 合约里全是 onlyOwner
 *
 * 页头与「挖矿份额转让」同构：左边标题、右边期次切换（PeriodNav），
 * 下面一行说明 + 一个可写/只读徽标。主体是「左标签、右控件」的设置行：
 * 每张卡只管一件事，行与行之间用同一条分隔线对齐。
 *
 * 每个按钮都先核对角色、场景与链上前置条件：宁可禁用并写明原因，也不发注定 revert 的交易。
 */
export function OwnerAdvanced({ round, book, pending, actor, periods, onSwitchPeriod, onInvoke }) {
  const isOwner = actor?.role === "owner";
  const chainMode = Boolean(book._chain);
  const busy = Boolean(pending);
  const canWrite = isOwner && chainMode && !busy;
  const validAddr = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
  const ZERO = /^0x0{40}$/i;

  const ownerOnChain = String(book.owner || "");
  const operatorOnChain = String(book.operator || "");
  const hasOperatorOnChain = validAddr(operatorOnChain) && !ZERO.test(operatorOnChain);
  const marketOnChain = String(book.market || "");
  const halted = Boolean(book.halted);
  const executing = book.scene === "executing";
  const phaseLabel = phaseOf(book)?.full || "—";
  const feeLocked = Boolean(book.serviceFeeSet);
  const feePercent = Number(book.serviceFeeBps ?? 0) / 100;
  const feeRows = Array.isArray(round.feeShares) ? round.feeShares : [];

  /** 操作员：零地址 = 撤销，写回读到的链上值方便直接改。 */
  const [operatorAddr, setOperatorAddr] = useState("");
  useEffect(() => {
    if (!hasOperatorOnChain) return;
    setOperatorAddr((cur) => (cur ? cur : operatorOnChain));
  }, [hasOperatorOnChain, operatorOnChain]);

  /** 本期 Owner 转移与市场地址：一律留空手填，避免误点把所有权发出去。 */
  const [newOwnerAddr, setNewOwnerAddr] = useState("");
  const [marketAddr, setMarketAddr] = useState("");
  useEffect(() => {
    setMarketAddr((cur) => (cur ? cur : (validAddr(marketOnChain) ? marketOnChain : "")));
  }, [marketOnChain]);

  /** 服务费（只在还没人认购时能写，写完永久锁定）。 */
  const [feeBps, setFeeBps] = useState("");
  const [feeRecipients, setFeeRecipients] = useState("");
  const [feeSharesText, setFeeSharesText] = useState("");

  const [nextPhase, setNextPhase] = useState("1");
  useEffect(() => {
    // 打开面板时把下拉对齐到链上当前子状态，避免「看起来没变却写了一次」。
    setNextPhase(String({ buying: 1, listed: 2, ready: 3 }[book.executePhase] || 1));
  }, [book.executePhase]);

  /** 取回晶体管：默认填本期锁定的晶体管合约。 */
  const [tokenAddr, setTokenAddr] = useState("");
  useEffect(() => {
    setTokenAddr((cur) => (cur ? cur : String(book.transistors || "")));
  }, [book.transistors]);
  const [tokenId, setTokenId] = useState("0");
  const [tokenAmount, setTokenAmount] = useState("1");

  const write = (method, args) => onInvoke?.(method, args);

  /** 可写性徽标：先判身份，再判模式 —— 两种「只读」的原因不同，不能合并成一句话。 */
  const gate = !isOwner
    ? { text: "只读 · 当前钱包不是本期 Owner", tone: "is-closed" }
    : !chainMode
      ? { text: "只读 · 仅链上模式可写", tone: "is-closed" }
      : { text: "Owner 可写", tone: "is-open" };

  /** 每张卡右上角的「当前值」，与卡片内的动作一一对应，正文里不再复述一遍。 */
  const ownerLabel = validAddr(ownerOnChain) ? shortAddress(ownerOnChain) : "—";
  const operatorLabel = hasOperatorOnChain ? shortAddress(operatorOnChain) : "未设置";
  const marketLabel = validAddr(marketOnChain) ? shortAddress(marketOnChain) : "—";
  const feeLabel = feeLocked ? `${feePercent}%` : "未设定";

  return (
    <section className="adv-desk">
      <header className="round-hero">
        <div className="round-hero-row">
          <div className="round-title">
            <span className="round-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <path
                  d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M12 3.4v2.1M12 18.5v2.1M3.4 12h2.1M18.5 12h2.1M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <h1>高级配置</h1>
          </div>
          {Array.isArray(periods) && periods.length > 0 && onSwitchPeriod ? (
            <PeriodNav periods={periods} currentId={round.id} onSwitch={onSwitchPeriod} />
          ) : (
            <span className="round-period">第 {round.id} 期</span>
          )}
        </div>
        <p className="round-hero-lead">
          只有本期 Owner 能写的治理与安全入口：改权限、抬闸、改子状态、换市场、取回资产。
          日常运营（挂买单 / 卖出 / 退款）在「众筹挖矿列表」；入池只有 Owner。
        </p>
        <span className={`adv-gate ${gate.tone}`}>{gate.text}</span>
      </header>

      <div className="adv-groups">
        <article className="card">
          <div className="card-header">
            <span>权限</span>
            <span className="stat-label adv-addr">Owner {ownerLabel}</span>
          </div>
          <div className="card-body adv-rows">
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>操作员</strong>
                <span>
                  {hasOperatorOnChain ? `当前 ${operatorLabel}。` : "未设置。"}
                  热钱包可做日常运营：改计划、挂买单、撤单、卖出晶体管、退余款、开退款、熔断。
                  入池、改子状态、取回资产、抬闸与换操作员仍归 Owner。
                </span>
              </div>
              <div className="adv-control">
                <input
                  className="adv-addr"
                  aria-label="操作员地址"
                  placeholder={hasOperatorOnChain ? operatorOnChain : "0x…（填零地址 = 撤销）"}
                  value={operatorAddr}
                  onChange={(e) => setOperatorAddr(e.target.value)}
                />
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={!canWrite || !validAddr(operatorAddr)}
                  title={
                    !chainMode
                      ? "仅链上模式可用"
                      : !isOwner
                        ? "只有 Owner 能分配操作员"
                        : !validAddr(operatorAddr)
                          ? "请填写有效的 20 字节地址"
                          : undefined
                  }
                  onClick={() => write("setOperator", { operator: operatorAddr.trim() })}
                >
                  {pending === "setOperator" ? "写入中…" : "写入"}
                </button>
              </div>
            </div>
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>转移本期 Owner</strong>
                <span>转出后当前钱包立即失去本期全部 Owner 权限，且不可撤销。</span>
              </div>
              <div className="adv-control">
                <input
                  className="adv-addr"
                  aria-label="新 Owner 地址"
                  placeholder="0x…（新 Owner，不可撤回）"
                  value={newOwnerAddr}
                  onChange={(e) => setNewOwnerAddr(e.target.value)}
                />
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={!canWrite || !validAddr(newOwnerAddr) || ZERO.test(newOwnerAddr.trim())}
                  title={
                    !chainMode
                      ? "仅链上模式可用"
                      : !isOwner
                        ? "只有本期 Owner 能转移所有权"
                        : !validAddr(newOwnerAddr)
                          ? "请填写有效的 20 字节地址"
                          : ZERO.test(newOwnerAddr.trim())
                            ? "不能转给零地址"
                            : undefined
                  }
                  onClick={() => {
                    const next = newOwnerAddr.trim();
                    if (!window.confirm(`确认把本期 Owner 转给 ${next}？转出后你将失去本期全部 Owner 权限。`)) return;
                    write("transferOwnership", { newOwner: next });
                  }}
                >
                  {pending === "transferOwnership" ? "转移中…" : "转移"}
                </button>
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <span>熔断</span>
            <span className={`adv-chip ${halted ? "is-warn" : "is-ok"}`}>{halted ? "已熔断" : "运行中"}</span>
          </div>
          <div className="card-body adv-rows">
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>{halted ? "解除熔断" : "拉闸"}</strong>
                <span>
                  熔断只挡入口（认筹 / 挂单 / 卖出 / 入池 / 份额市场）；退款、领余款、撤单始终可用。
                </span>
              </div>
              <div className="adv-control">
                {halted ? (
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!canWrite}
                    title={!canWrite ? "解除熔断只有 Owner 能做" : "恢复认筹、挂单、卖出、入池与份额市场"}
                    onClick={() => write("resume", {})}
                  >
                    {pending === "resume" ? "解除中…" : "解除熔断"}
                  </button>
                ) : (
                  <button
                    className="btn btn-outline"
                    type="button"
                    disabled={!canWrite}
                    title={!canWrite ? "需要链上 Owner 身份" : "停掉认筹、挂单、卖出、入池与份额市场"}
                    onClick={() => write("halt", {})}
                  >
                    {pending === "halt" ? "熔断中…" : "熔断"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <span>执行子状态</span>
            <span className="stat-label">当前 {phaseLabel}</span>
          </div>
          <div className="card-body adv-rows">
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>改写子状态</strong>
                <span>只在「待执行」里可改，是卡死时的回退开关。改之前先撤掉在途买单，否则托管留在市场。</span>
              </div>
              <div className="adv-control">
                <select aria-label="子状态" value={nextPhase} onChange={(e) => setNextPhase(e.target.value)}>
                  <option value="1">1 · 待挂单</option>
                  <option value="2">2 · 挂单中</option>
                  <option value="3">3 · 已到账待入池</option>
                </select>
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={!canWrite || !executing}
                  title={
                    !chainMode
                      ? "仅链上模式可用"
                      : !isOwner
                        ? "只有 Owner 能改子状态"
                        : !executing
                          ? "只有「待执行」阶段能改子状态"
                          : nextPhase === "2"
                            ? "挂单中必须真的有未成交买单，否则合约拒绝"
                            : nextPhase === "3"
                              ? "已到账需要已成交或手上有晶体管"
                              : undefined
                  }
                  onClick={() => write("setPhase", { next: nextPhase })}
                >
                  {pending === "setPhase" ? "写入中…" : "写入"}
                </button>
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <span>合约参数</span>
            <span className="stat-label adv-addr">市场 {marketLabel}</span>
          </div>
          <div className="card-body adv-rows">
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>晶体管市场</strong>
                <span>挂单中不可换。换市场前会先取回旧市场欠款，并撤销旧市场的晶体管授权。</span>
              </div>
              <div className="adv-control">
                <input
                  className="adv-addr"
                  aria-label="晶体管市场地址"
                  placeholder={validAddr(marketOnChain) ? marketOnChain : "0x…"}
                  value={marketAddr}
                  onChange={(e) => setMarketAddr(e.target.value)}
                />
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={
                    !canWrite
                    || !validAddr(marketAddr)
                    || (validAddr(marketOnChain) && marketAddr.trim().toLowerCase() === marketOnChain.toLowerCase())
                  }
                  title={
                    !chainMode
                      ? "仅链上模式可用"
                      : !isOwner
                        ? "只有 Owner 能换市场"
                        : !validAddr(marketAddr)
                          ? "请填写有效的 20 字节地址"
                          : validAddr(marketOnChain) && marketAddr.trim().toLowerCase() === marketOnChain.toLowerCase()
                            ? "与当前市场相同，无需更换"
                            : "在途买单会挡下这次更换"
                  }
                  onClick={() => write("setMaterialMarket", { materialMarket: marketAddr.trim() })}
                >
                  {pending === "setMaterialMarket" ? "更换中…" : "更换"}
                </button>
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <span>挖矿产出服务费</span>
            <span className="stat-label">当前 {feeLabel}</span>
          </div>
          <div className="card-body adv-rows">
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>{feeLocked ? "已锁定" : "写入服务费"}</strong>
                <span>
                  {feeLocked
                    ? `锁定为 ${feePercent}%${
                      feeRows.length
                        ? `：${feeRows.map((row) => `${shortAddress(row.address)} ${Math.round(Number(row.sharePercent))}%`).join(" · ")}`
                        : ""
                    }，不可再改。`
                    : "从挖矿产出里计提，认筹款不收服务费；还没人认购时可写，写完永久锁定。"}
                </span>
              </div>
              <div className="adv-control adv-control-stack">
                {feeLocked ? (
                  <p className="adv-locked">已锁定，无需再写。</p>
                ) : (
                  <>
                    <div className="adv-control-grid">
                      <input
                        inputMode="numeric"
                        aria-label="费率 bps"
                        placeholder="费率 bps（≤ 1000）"
                        value={feeBps}
                        onChange={(e) => setFeeBps(e.target.value)}
                      />
                      <input
                        className="adv-addr"
                        aria-label="分成地址"
                        placeholder="分成地址，逗号分隔（≤ 3）"
                        value={feeRecipients}
                        onChange={(e) => setFeeRecipients(e.target.value)}
                      />
                    </div>
                    <div className="adv-control">
                      <input
                        className="adv-addr"
                        aria-label="分成份额 bps"
                        placeholder="各自份额 bps（合计 10000，如 10000）"
                        value={feeSharesText}
                        onChange={(e) => setFeeSharesText(e.target.value)}
                      />
                      <button
                        className="btn btn-outline"
                        type="button"
                        disabled={!canWrite || !feeBps.trim()}
                        title={!canWrite ? "需要链上 Owner 身份" : "费率为 0 时分成表必须留空"}
                        onClick={() =>
                          write("setServiceFee", { bps: feeBps, recipients: feeRecipients, sharesBps: feeSharesText })
                        }
                      >
                        {pending === "setServiceFee" ? "写入中…" : "写入"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <span>取回资产</span>
            <span className="stat-label">只扫无人可索的部分</span>
          </div>
          <div className="card-body adv-rows">
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>多余 BNB</strong>
                <span>只扫走份额无权索取的余额；托管池、未领服务费与未领余款不动。没有可动余额时合约会拒绝。</span>
              </div>
              <div className="adv-control">
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={!canWrite}
                  title={!canWrite ? "需要链上 Owner 身份" : "一次转走全部可动 BNB 给 Owner"}
                  onClick={() => write("recoverBnb", {})}
                >
                  {pending === "recoverBnb" ? "取回中…" : "取回 BNB"}
                </button>
              </div>
            </div>
            <div className="adv-row">
              <div className="adv-row-label">
                <strong>晶体管</strong>
                <span>挂单中、已入池，或本期份额未结清时合约会拒绝。默认填本期锁定的晶体管合约。</span>
              </div>
              <div className="adv-control adv-control-stack">
                <input
                  className="adv-addr"
                  aria-label="晶体管合约地址"
                  placeholder="0x…（晶体管合约）"
                  value={tokenAddr}
                  onChange={(e) => setTokenAddr(e.target.value)}
                />
                <div className="adv-control">
                  <input
                    inputMode="numeric"
                    aria-label="晶体管 ID"
                    placeholder="ID（0 NAND / 1 LATCH）"
                    value={tokenId}
                    onChange={(e) => setTokenId(e.target.value)}
                  />
                  <input
                    inputMode="numeric"
                    aria-label="取回数量"
                    placeholder="数量"
                    value={tokenAmount}
                    onChange={(e) => setTokenAmount(e.target.value)}
                  />
                  <button
                    className="btn btn-outline"
                    type="button"
                    disabled={
                      !canWrite
                      || !validAddr(tokenAddr)
                      || !/^\d+$/.test(tokenId.trim())
                      || !/^\d+$/.test(tokenAmount.trim())
                    }
                    title={
                      !chainMode
                        ? "仅链上模式可用"
                        : !isOwner
                          ? "只有 Owner 能取回晶体管"
                          : !validAddr(tokenAddr)
                            ? "请填写有效的 20 字节地址"
                            : "数量必须大于 0，且合约手上要有这么多晶体管"
                    }
                    onClick={() =>
                      write("recoverTransistors", {
                        token: tokenAddr.trim(),
                        id: tokenId.trim(),
                        amount: tokenAmount.trim(),
                      })
                    }
                  >
                    {pending === "recoverTransistors" ? "取回中…" : "取回"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </article>
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
   * ⚠️ 这里**没有**「留空 = 跟随建议」：建议方案依赖处理器与晶体管报价，
   * 而发布期不选处理器，建议值就成了来源不明的数字。宁可直接要求开期人自己填。
   */
  /**
   * 本期晶体管合约（= 处理器）：**开期人必须显式选择**（T-79 核心改动）。
   *
   * 工厂不再有「默认晶体管」：`createCampaign` 第 4 参 transistors 由前端从链上白名单里选，
   * 零地址一律 revert（主网白名单 = 官方两件套 TapeOut / Behemoth 各自的晶体管合约）。
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
  /** 处理器（晶体管合约）：链上模式必选，且必须是合法地址（白名单在链上校验） */
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
   * 链上 createCampaign 收 单价 / 份数 / 天数 / 晶体管合约；
   * 服务费与分成是**建期后的第二笔交易**（setServiceFee，只能在 sold == 0 时调），由 App 侧串联。
   *
   * 晶体管合约（处理器）由开期人显式选（effectiveDraft.transistors）；
   * 链上模式必填，零地址会被工厂 revert。演示模式留空，由模拟引擎派生。
   */

  const effectiveDraft = {
    ...draft,
    /**
     * 晶体管合约：开期人从白名单显式选的处理器地址（链上模式必填；
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
                  ? "四项参数上链后不可改：每份单价、总份数、募集天数、本期晶体管合约。"
                  : "四项参数上链后不可改：每份单价、总份数、募集天数、本期晶体管合约。"}
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
          {/*
           * 发行规模独占一整行：募资总额 / 总份数 / 每份价格（派生）三格并排。
           * 旧版是两列布局 + 下面一行 bill 显示单价：两列时右边那列空着，
           * 派生单价又和输入框分成上下两段，读起来要来回找。
           */}
          <article className="card is-wide">
            <div className="card-header">
              <span>发行规模</span>
              <span className="stat-label">两项都必填</span>
            </div>
            <div className="card-body">
              <div className="form-grid cols-3">
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
                <div className="field">
                  <span>每份价格</span>
                  {/* 派生值：总额 ÷ 份数，不可单独填 */}
                  <div className="field-static" title="由募资总额 ÷ 总份数算出，不可单独填">
                    {priceInput ? `${priceInput} BNB` : "—"}
                  </div>
                </div>
              </div>
              <p className="fine">
                两项必填，上链后不可改。晶体管数与算力要到执行阶段才确定，发布期不给建议值。
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

          {/* ── 本期晶体管合约 ── */}
          {chainMode && (
            <article className="card">
              <div className="card-header">
                <span>本期晶体管合约</span>
                <span className="stat-label">开期必选 · 锁定后不可改</span>
              </div>
              <div className="card-body">
                <label className="field">
                  <span>晶体管合约（处理器）</span>
                  <select
                    value={selectedProcessor}
                    className={transistorsInvalid ? "is-invalid" : undefined}
                    title="从工厂白名单选一个晶体管合约；开期后锁定，不可改"
                    onChange={(event) => update("transistors", event.target.value)}
                    onBlur={() => touch("transistors")}
                  >
                    <option value="">— 请选择 —</option>
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
                    无法读取工厂晶体管白名单，请确认链上工厂已部署且白名单非空。
                  </p>
                )}
                {transistorsInvalid && (
                  <p className="fine warn-text">请选择本期晶体管合约，不能留空。</p>
                )}
              </div>
            </article>
          )}
          {/* ── 挖矿产出服务费与分成（链上参数，setServiceFee） ── */}
          <article className="card is-wide">
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
              {effShares > 0
                ? `${effShares} 份 · 每份 ${priceInput ? `${priceInput} BNB` : "—"} · 募集 ${daysValid ? `${daysNum} 天` : `${draft.fundingDays || "—"} 天（待修正）`}`
                : "填写募资总额与总份数后，这里给出本期摘要"}
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
