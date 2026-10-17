import { useEffect, useState } from "react";
import { ContractCalls } from "./Calls.jsx";
import OnChainPage from "./OnChain.jsx";
import {
  MARKET,
  OWNER,
  PAST_ROUNDS,
  QUOTE,
  TRANSISTORS,
  buildHolders,
  computeHarvest,
  findTask,
  designOffering,
  transistorIdFor,
  compareProcessors,
  adviseProcessor,
  PROCESSOR_IDS,
  suggestTaskRange,
  listTasks,
  taskTiers,
  currentRate,
  NETWORK_WEIGHT,
  NETWORK_DAILY_EMISSION,
  BEM_HARD_CAP,
  HALVING_PERIOD_DAYS,
  MINE_GATE_LIMIT,
  MINING_DAYS,
  COST_RATIO_MIN,
  COST_RATIO_MAX,
  estimateHashpower,
  formatBem,
  formatClock,
  resolveCampaignDesign,
  reviewRound,
  shortAddress,
  round4,
} from "./fixtures.js";

const EMPTY_FORM = {
  /** 官方题库 ID。选题决定元件数与深度，进而决定成本与权重。 */
  taskId: "54",
  /**
   * 目标处理器：由开期人手动选择，不自动推导。
   * Behemoth 权重系数 P=6、元件贵约 7.5 倍；TapeOut P=1、元件便宜。
   */
  processorId: "Behemoth",
  /**
   * 募资总额与总份数：开期人**手动填写**的两个发行参数（默认留空 = 跟随建议方案）。
   * 每份 BNB 由两者派生（每份 = 募资总额 ÷ 总份数），是只读展示值，不可单独手填——
   * 否则会破坏「募资总额 = 份数 × 每份」这一链上恒等式。
   *
   * 留空哨兵沿用 #2 的约定：draft.x === "" 表示跟随 designOffering 的建议值，
   * 渲染与校验时再取 offering 的对应字段。
   *
   * 开期人可调的旋钮是 募资总额 / 总份数（定规模）、processorId（换处理器）、
   * fundingDays、feePercent。
   */
  /** 募资总额（BNB）：留空 = 跟随建议方案 */
  hardCapBnb: "",
  /** 总份数：留空 = 跟随建议方案 */
  totalShares: "",
  fundingDays: "15",
  feePercent: "5",
  feeRecipient: "0x0000000000000000000000000000000000000fee",
};

export function OwnerOverview({
  round, book, copy, pending, actor, executeWait, history, taskbook,
  onSwitchCampaign, onPlaceTransistorOrder, onAbortUnaffordable, onCancelTransistorOrder, onConfirmTransistors,
  onExecute, onHarvest, onSetPlan, onOpenRound, onOpenAssets,
  account = "", connected = false, chainHolders = null, quote, onInvoke,
}) {
  // 链上：托管池 raisedBnb 为权威；模拟：份数×单价
  const raised = book._chain ? Number(book.bnbPool || 0) : book.sold * round.sharePriceBnb;
  const netW = book.capped ? book.netWeightUnverified : book.netWeightVerified;
  const harvest = computeHarvest(
    round,
    book,
    book.selfAddress,
    Number.isFinite(netW) ? netW : null
  );
  const dailyBem = book._chain && book.dailyBem != null ? book.dailyBem : harvest.dailyBem;
  const design = resolveCampaignDesign(round, book, taskbook);
  const historyRows = (history != null ? history : PAST_ROUNDS).map((item) => {
    const onChainRow = history != null;
    const rowDesign = resolveCampaignDesign(
      { taskId: item.taskId, transistorId: onChainRow ? null : item.transistorId, processorId: onChainRow ? null : item.processor },
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
      taskbook
    );
    return {
      ...item,
      taskName: rowDesign.taskName,
      taskId: item.taskId != null && item.taskId !== "" ? item.taskId : rowDesign.taskId,
      processor: rowDesign.processorKnown ? rowDesign.processorId : "—",
      processorInferred: rowDesign.processorInferred,
    };
  });
  const [statusFilter, setStatusFilter] = useState("全部");
  const [pageIndex, setPageIndex] = useState(1);
  const [openKey, setOpenKey] = useState(null);
  const [detailPane, setDetailPane] = useState("ops");
  const [dialog, setDialog] = useState(null);
  const statusOptions = ["全部", "募集中", "待执行", "挖矿中", ...Array.from(new Set(
    historyRows.map((row) => row.status).filter((name) => name && !["募集中", "待执行", "挖矿中"].includes(name))
  ))];
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
  const canExecute = isOwner && executeWait === 0;
  const waitHours = Math.ceil(executeWait / 3600_000);
  const planWritten = Number(book.estHashpower) > 0 || Number(book.transistorCount) > 0;
  const sceneTitle =
    book.scene === "funding" ? "募集中"
      : book.scene === "executing" ? "待执行"
        : book.scene === "mining" ? "挖矿中"
          : "—";
  const nextActionByStatus = (status) => {
    if (status === "募集中") return "补 setPlan / 等待售罄";
    if (status === "待执行") return "挂单 → 确认 → 流片";
    if (status === "挖矿中") return "领取并分配";
    return "查看详情";
  };

  const PAGE_SIZE = 5;
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const page = Math.min(pageIndex, pageCount);
  const pageRows = visibleRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rangeFrom = visibleRows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeTo = Math.min(page * PAGE_SIZE, visibleRows.length);
  const dialogRow = dialog ? historyRows.find((row) => rowKey(row) === dialog.key) : null;
  const dialogLive = Boolean(
    dialogRow && (
      (dialogRow.address && String(round.contract || "").toLowerCase() === String(dialogRow.address).toLowerCase())
      || (!dialogRow.address && dialogRow.id === round.id)
    )
  );
  const dialogTitle = { ops: "合约操作", holders: "份额明细", calls: "合约调用", onchain: "链上调试" }[dialog?.pane] || "";
  const soldPct = round.totalShares > 0 ? Math.min(100, Math.round((book.sold / round.totalShares) * 100)) : 0;
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  const hashLabel = Number(book.hashpower) > 0
    ? `${Number(book.hashpower).toLocaleString()} H`
    : Number(book.estHashpower) > 0
      ? `${Number(book.estHashpower).toLocaleString()} H`
      : "未记录";
  const hashHint = Number(book.hashpower) > 0 ? "已执行" : Number(book.estHashpower) > 0 ? "setPlan 预估" : "尚未写入 setPlan";

  function renderOps() {
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
                          去 BEM挖矿认购
                        </button>
                      )}
                    </div>
                    <p className="fine">
                      募集期用户在「BEM挖矿认购」按份买入。Owner 可先 setPlan，把预估算力与需买元件数写上链，供用户核对。
                      {!isOwner && " 当前钱包不是 Factory Owner，无法写 setPlan。"}
                    </p>
                  </>
                )}

                {book.scene === "executing" && (() => {
                  const est = book.estimate || {};
                  const need = est.usedParts || book.transistorCount || 0;
                  const phaseLabel =
                    book.executePhase === "ready" ? "已到账 · 待流片"
                      : book.executePhase === "listed" ? "挂单中 · 待成交"
                        : "待挂单";
                  return (
                    <>
                      <ul className="bill">
                        <li><span>子状态</span><strong>{phaseLabel}</strong></li>
                        <li><span>目标处理器</span><strong>{est.processor || design.processorId || "—"}</strong></li>
                        <li><span>需买入</span><strong>{need} 颗 · {est.nand || 0} NAND + {est.latch || 0} LATCH</strong></li>
                        <li><span>观察期</span><strong>售罄后 {round.executeDelayHours} 小时{executeWait > 0 ? ` · 还剩约 ${waitHours} 小时` : " · 已满"}</strong></li>
                        <li className="due"><span>本阶段 Owner 可做</span><strong>买得起则挂单；买不起则退款</strong></li>
                      </ul>
                      <div className="actions">
                        {book.executePhase === "buying" && (
                          <>
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={!isOwner || Boolean(pending) || book.executionFailed || est.capCoversFloor === false}
                              onClick={onPlaceTransistorOrder}
                            >
                              {pending || "调用 tapeout.net 挂单"}
                            </button>
                            <button
                              className="btn btn-inline"
                              type="button"
                              disabled={!isOwner || Boolean(pending) || book.executionFailed || est.capCoversFloor !== false}
                              onClick={onAbortUnaffordable}
                            >
                              {book.executionFailed ? "已开放退款" : (pending || "退款")}
                            </button>
                          </>
                        )}
                        {book.executePhase === "listed" && (
                          <>
                            <button className="btn btn-primary" type="button" disabled={!isOwner || Boolean(pending)} onClick={onConfirmTransistors}>
                              {pending || "确认成交到账"}
                            </button>
                            <button className="btn btn-inline" type="button" disabled={!isOwner || Boolean(pending)} onClick={onCancelTransistorOrder}>
                              {pending || "取消挂单"}
                            </button>
                          </>
                        )}
                        {book.executePhase === "ready" && (
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={!canExecute || Boolean(pending)}
                            onClick={onExecute}
                          >
                            {pending === "execute"
                              ? "流片中…"
                              : executeWait > 0
                                ? `观察期未满（剩 ${waitHours} 小时）`
                                : "流片并开户挖矿"}
                          </button>
                        )}
                      </div>
                      <p className="fine">
                        {book.executePhase === "buying" && (
                          est.capCoversFloor === false
                            ? "当前报价买不起晶体管，可发起退款。持份人到「我的资产」原路退还。"
                            : "买得起晶体管，先挂单锁价，成交后再确认到账。"
                        )}
                        {book.executePhase === "listed" && "成交后点确认；也可取消挂单重新走。"}
                        {book.executePhase === "ready" && (
                          executeWait > 0
                            ? "晶体管已到位，观察期结束后才能流片。流片不可逆。"
                            : "晶体管已到位且观察期满，可流片开矿。流片不可逆，仅 Factory Owner。"
                        )}
                        {!isOwner && " 当前钱包不是 Factory Owner，无法执行本阶段写操作。"}
                      </p>
                    </>
                  );
                })()}

                {book.scene === "mining" && (
                  <>
                    <ul className="bill">
                      <li><span>当前日产</span><strong>{formatBem(dailyBem)} BEM</strong></li>
                      <li><span>已分发轮数</span><strong>{harvest.rounds} 次</strong></li>
                      <li><span>本次可分得（按你的份额）</span><strong>{formatBem(harvest.userPart)} BEM</strong></li>
                      <li className="due"><span>本阶段可做</span><strong>全网 harvest；个人 claim 在「我的资产」</strong></li>
                    </ul>
                    <div className="actions">
                      <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={onHarvest}>
                        {pending === "harvest" ? "分发中…" : "领取并分配（harvest）"}
                      </button>
                      {onOpenAssets && (
                        <button className="btn btn-inline" type="button" onClick={onOpenAssets}>
                          去我的资产领取
                        </button>
                      )}
                    </div>
                    <p className="fine">
                      harvest 任何人可调用：从 PoD 拉日产、扣服务费、按份入账。个人要把 pending 提到钱包，请到「我的资产」claim。
                    </p>
                  </>
                )}

                {book.executionFailed && (
                  <p className="fine warn-text">
                    本期流片失败。持份人可到「我的资产」退款；Owner 修正后可重新走待执行流程。
                  </p>
                )}
              </div>
            </article>

            {book._chain && (
              <article className="card">
                <div className="card-header">链上参数（本期）</div>
                <div className="card-body">
                  <dl className="param-grid">
                    <div><dt>合约</dt><dd className="mono">{shortAddress(round.contract)}</dd></div>
                    <div><dt>Owner</dt><dd className="mono">{shortAddress(book.owner)}</dd></div>
                    <div><dt>服务费收费地址</dt><dd className="mono">{shortAddress(round.feeRecipient)}</dd></div>
                    <div><dt>本次可分得</dt><dd>{formatBem(harvest.userPart)} BEM</dd></div>
                    <div><dt>已领次数</dt><dd>{harvest.rounds} 次</dd></div>
                    <div>
                      <dt>链上算力 / 元件</dt>
                      <dd>
                        {hashLabel}
                        {" · "}
                        {Number(book.transistorCount) > 0 ? `${book.transistorCount} 颗` : "元件未写入"}
                      </dd>
                    </div>
                    <div><dt>题目元件</dt><dd>{design.taskParts || "—"} 颗</dd></div>
                    <div><dt>托管 BNB</dt><dd>{round4(book.bnbPool || 0)} BNB</dd></div>
                    <div><dt>已验证权重</dt><dd>{Number(book.netWeightVerified || 0).toLocaleString()}</dd></div>
                    <div><dt>未验证权重</dt><dd>{Number(book.netWeightUnverified || 0).toLocaleString()}</dd></div>
                    <div><dt>锁价</dt><dd>{book.priceLock ? `${round4(book.priceLock)} BNB` : "未锁"}</dd></div>
                  </dl>
                </div>
              </article>
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
                <p>按状态筛选。详情进入该期 BEM挖矿认购；合约操作在弹出框里完成。</p>
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
                ? "发布一期之后，会出现在这里。可以按募集中、待执行、挖矿中筛选。"
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
              const task = item.taskId != null ? `#${item.taskId} ${item.taskName || ""}`.trim() : (item.taskName || "—");
              return (
                <article key={rowKey(item)} className="campaign-card" onClick={() => openRound(item)}>
                  <header className="campaign-card-head">
                    <div>
                      <div className="campaign-kicker">
                        <strong>第 {item.id} 期</strong>
                        {item.address ? <span className="mono">{shortAddress(item.address)}</span> : null}
                      </div>
                      <h2>{task}</h2>
                      <p>目标处理器 {item.processor || "—"}</p>
                    </div>
                    <span className={`badge tone-${item.tone}`}>{item.status}</span>
                  </header>
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
                      <dt>服务费</dt>
                      <dd>{item.fee}</dd>
                    </div>
                  </dl>
                  {pct != null && (
                    <div className="campaign-progress" aria-hidden="true">
                      <i style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  <footer className="campaign-card-foot">
                    <span>{nextActionByStatus(item.status)}</span>
                    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                      <button className="campaign-link" type="button" onClick={() => openTool(item, "holders")}>份额明细</button>
                      <button className="campaign-link" type="button" onClick={() => openTool(item, "calls")}>合约调用</button>
                      <button className="campaign-link" type="button" onClick={() => openTool(item, "onchain")}>链上调试</button>
                      <button className="campaign-link" type="button" onClick={() => openTool(item, "ops")}>合约操作</button>
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
      {dialogRow && (
        <div className="sheet-backdrop" onClick={() => setDialog(null)}>
          <div
            className={dialog.pane === "ops" || dialog.pane === "onchain" ? "sheet sheet-wide" : "sheet"}
            role="dialog"
            aria-modal="true"
            aria-label={`${dialogTitle} 第 ${dialogRow.id} 期`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="sheet-head">
              <div>
                <p className="sheet-kicker">第 {dialogRow.id} 期</p>
                <h2>{dialogTitle}</h2>
              </div>
              <button className="sheet-close" type="button" aria-label="关闭" onClick={() => setDialog(null)}>×</button>
            </header>
            <div className="sheet-body">
              {!dialogLive ? (
                <p className="fine">正在读取这一期…</p>
              ) : dialog.pane === "holders" ? (
                <OwnerHolders
                  embedded
                  round={round}
                  book={book}
                  account={account}
                  holders={book._chain ? chainHolders : null}
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
                <OnChainPage embedded />
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
                        <dt>日产</dt>
                        <dd>{formatBem(dailyBem)}</dd>
                        <small>BEM</small>
                      </div>
                      <div>
                        <dt>已分配</dt>
                        <dd>{formatBem(book.distributed || 0)}</dd>
                        <small>服务费 {formatBem(book.feeBem)} BEM</small>
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
        </div>
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
            <p>题目、募集和可执行操作稍后会出现在这里。</p>
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
              <h2>{opened.taskId != null ? `#${opened.taskId} ${opened.taskName || ""}` : (opened.taskName || "本期摘要")}</h2>
              <p>目标处理器 {opened.processor || "—"} · 这一期没有可操作的链上状态</p>
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
              <div><dt>服务费</dt><dd>{opened.fee}</dd></div>
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
            <h2>#{design.taskId} {design.taskName}</h2>
            <p>
              目标处理器 {design.processorKnown ? `${design.processorId} · P=${design.processorScale}` : "未记录"}
              {design.taskTier ? ` · ${design.taskTier}` : ""}
              {design.taskParts ? ` · ${design.taskParts} 元件` : ""}
              {round.contract ? ` · ${shortAddress(round.contract)}` : ""}
            </p>
          </div>
          <span className={`badge tone-${copy.tone}`}>{copy.badge}</span>
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
              <dt>日产</dt>
              <dd>{formatBem(dailyBem)}</dd>
              <small>BEM</small>
            </div>
            <div>
              <dt>已分配</dt>
              <dd>{formatBem(book.distributed || 0)}</dd>
              <small>服务费 {formatBem(book.feeBem)} BEM</small>
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
              holders={book._chain ? chainHolders : null}
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
            <OnChainPage embedded />
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
  taskbook,
  now,
  chainMode = false,
  defaultFeeRecipient = "",
  factoryOwner = "",
  connectedAccount = "",
  onConnect,
}) {
  const [draft, setDraft] = useState(() => ({
    ...EMPTY_FORM,
    feeRecipient: defaultFeeRecipient || EMPTY_FORM.feeRecipient,
  }));
  // 连接钱包后把服务费收费地址默认填成当前账户（尚未手改占位地址时）
  useEffect(() => {
    if (!defaultFeeRecipient) return;
    setDraft((cur) => {
      const isPlaceholder =
        !cur.feeRecipient ||
        cur.feeRecipient === EMPTY_FORM.feeRecipient ||
        /^0x0+fee$/i.test(cur.feeRecipient);
      return isPlaceholder ? { ...cur, feeRecipient: defaultFeeRecipient } : cur;
    });
  }, [defaultFeeRecipient]);
  const isFactoryOwner =
    !chainMode ||
    !factoryOwner ||
    (connectedAccount && String(connectedAccount).toLowerCase() === String(factoryOwner).toLowerCase());
  const quote = snapshot || QUOTE;

  /* ── 目标处理器：由开期人选择，系统只负责把两个选项的账算清楚 ── */
  const task = findTask({ taskId: draft.taskId }, taskbook);
  /** 手选的处理器 -> 元件组合 id（NAND/LATCH 配比仍由题目给定，不是二选一） */
  const processorId = PROCESSOR_IDS.includes(draft.processorId) ? draft.processorId : PROCESSOR_IDS[0];
  const transistorId = transistorIdFor(processorId);

  /**
   * 发行方案：每份 BNB 与总份数一起算出来。
   *
   * 必须排在处理器对比之前——对比要靠募资总额判断「买不买得起」。
   * 依赖顺序：题目元件数 -> offering -> 处理器对比。
   */
  const offering = designOffering({ task, transistorId, snapshot: quote });

  /**
   * 募资总额与总份数：开期人**手动填写**（默认留空 = 跟随建议方案）。
   *
   * 两者是这一期发行规模的两个旋钮：募资总额定「这期总共募多少 BNB」，
   * 总份数定「分成多少份」。每份 BNB 是派生展示值（每份 = 募资总额 ÷ 总份数），
   * 不可单独手填——填任何一个都会破坏「募资总额 = 份数 × 每份」的链上恒等式。
   *
   * 留空哨兵：draft.hardCapBnb / draft.totalShares 为 "" 时表示跟随建议，
   * 渲染与校验时取 offering 的对应字段；用户填了就用填的。
   *
   * 改 processorId（换处理器）会改变流片成本，
   * 进而改变「成本占募资总额」比例——但募资总额与份数本身由开期人决定。
   */
  const capRaw = draft.hardCapBnb;
  const sharesRaw = draft.totalShares;
  const capFollows = capRaw === "" || capRaw === undefined;
  const sharesFollows = sharesRaw === "" || sharesRaw === undefined;
  const capNum = Number(capRaw);
  const sharesNum = Number(sharesRaw);
  /** 募资总额合法性：留空跟随建议，或必须是正数 */
  const capValid = capFollows || (Number.isFinite(capNum) && capNum > 0);
  /** 总份数合法性：留空跟随建议，或必须是正整数 */
  const sharesValid = sharesFollows || (Number.isInteger(sharesNum) && sharesNum > 0);
  /** 有效口径（跟随建议时取方案值；非法值保留原数字交给校验拦截，不静默回退） */
  const effCap = capFollows ? offering.hardCapBnb : capNum;
  const effShares = sharesFollows ? offering.totalShares : sharesNum;
  /**
   * 派生每份：两者都跟随建议时直接取方案单价（避免 round4 误差），
   * 否则用「募资总额 ÷ 总份数」。非法输入时为 NaN，展示置空、由红框与校验提示。
   */
  const perShareBnb = effCap > 0 && effShares > 0
    ? (capFollows && sharesFollows ? offering.sharePriceBnb : effCap / effShares)
    : NaN;
  const priceInput = Number.isFinite(perShareBnb) && perShareBnb > 0 ? perShareBnb.toFixed(4) : "";
  const sharesInput = String(effShares);
  /**
   * 募资总额（展示与横向对比口径）：手动输入合法时用开期人填的数，
   * 非法输入时回退到建议方案值，避免处理器卡片/占比出现 NaN 或 Infinity。
   * 真正的权威值（含非法输入）见 effectiveDraft.hardCapBnb（effCap），交给 reviewRound 校验拦截。
   */
  const hardCapBnb = Number.isFinite(effCap) && effCap > 0 ? effCap : offering.hardCapBnb;
  /** 两个处理器的横向对比，供开期人参考，不代替他做决定 */
  const options = compareProcessors({ task, hardCapBnb, snapshot: quote });
  /** 当前所选处理器的方案 */
  const tplan = options.find((o) => o.processorId === processorId) || options[0];
  const advice = adviseProcessor({ processorId: tplan.processorId, plan: tplan, hardCapBnb });
  /**
   * 开期校验与预估值都用选定的处理器 + 解析后的单价/份数/元件数。
   * taskbook 必须传——不传会退回离线兜底题库，校验的权重就跟上面展示的对不上了。
   */
  /** 开期校验与预估值都用选定的处理器 + 解析后的单价/份数/元件数。 */
  const effectiveDraft = {
    ...draft,
    transistorId,
    /** 手动募资总额（权威口径），跟随建议时为方案值 */
    hardCapBnb: String(effCap),
    /** 派生每份：非法输入退为 0，避免下游 NaN 传播 */
    sharePriceBnb: Number.isFinite(perShareBnb) ? String(perShareBnb) : "0",
    totalShares: sharesInput,
  };
  const review = reviewRound(effectiveDraft, quote, undefined, taskbook);

  const est = estimateHashpower(
    {
      ...effectiveDraft,
      sharePriceBnb: Number(priceInput) || 0,
      totalShares: Number(sharesInput) || 0,
      miningDays: MINING_DAYS,
      feeBps: Number(draft.feePercent) * 100 || 0,
    },
    quote,
  );
  /* ── 选题 ── */
  const tiers = taskTiers(taskbook);
  const [tierFilter, setTierFilter] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const shown = listTasks(taskbook, {
    tier: tierFilter || undefined,
    keyword: taskQuery || undefined,
  });

  /** 真实产出机制：链上实读的全网权重与当前系数 */
  const rate = currentRate();
  /**
   * 只给日口径，不乘挖矿期天数。
   *
   * 天数不该出现在界面上：零和机制下全网权重涨了，挖再久日产也同步下降，
   * 产出与天数并不成正比。按天数外推的累计值会让人误判收益。
   * 费率直接取 draft，不做 || 7 兜底——否则输入 0 会被当成 7%。
   */
  const feeRateDraft = Number.isFinite(Number(draft.feePercent)) ? Number(draft.feePercent) : 0;
  const dailyFeeBem = (tplan.dailyBem * feeRateDraft) / 100;
  const dailyNetBem = tplan.dailyBem * (1 - feeRateDraft / 100);
  /**
   * 发布检查逐项核对：数值与 reviewRound 同源，并标出通过 / 警告 / 错误。
   * 日产用 review.dailyBem（含闸门 → 未验证池），不用 bemRate(hashpower) 硬套已验证池。
   */
  const publishChecks = (() => {
    const hardCap = Number(review.hardCapBnb) || 0;
    const need = Number(review.needBnb) || 0;
    const ratio = hardCap > 0 ? need / hardCap : 0;
    const margin = hardCap - need;
    const tolerancePct = need > 0 ? ((hardCap / need) - 1) * 100 : 0;
    const daily = Number(review.dailyBem ?? tplan.dailyBem) || 0;
    const dailyNet = daily * (1 - feeRateDraft / 100);
    const feeOk = Number.isInteger(feeRateDraft) && feeRateDraft >= 1 && feeRateDraft <= 20;
    return [
      {
        id: "hardCap",
        label: "募资总额",
        value: hardCap > 0 ? `${hardCap.toFixed(4)} BNB` : "—",
        status: hardCap > 0 ? "ok" : "err",
        note: hardCap > 0 ? "开期人手填或跟随建议方案" : "募资总额无效",
      },
      {
        id: "need",
        label: "流片成本（NAND + LATCH）",
        value: `${need.toFixed(4)} BNB`,
        status: need > 0 ? (margin >= 0 ? "ok" : "err") : "err",
        note: need > 0
          ? `${review.nand || 0} NAND + ${review.latch || 0} LATCH · 共 ${review.needParts || 0} 颗`
          : "流片成本未算出",
      },
      {
        id: "ratio",
        label: "成本占募资总额",
        value: hardCap > 0 ? `${(ratio * 100).toFixed(1)}%` : "—",
        status:
          hardCap <= 0 || need <= 0
            ? "err"
            : ratio > 1
              ? "err"
              : ratio < COST_RATIO_MIN || ratio > COST_RATIO_MAX
                ? "warn"
                : "ok",
        note:
          hardCap <= 0
            ? "无法计算占比"
            : ratio > 1
              ? "成本超过募资总额，执行将退款"
              : ratio < COST_RATIO_MIN
                ? `低于健康下限 ${(COST_RATIO_MIN * 100).toFixed(0)}%，保护厚但募资利用率低`
                : ratio > COST_RATIO_MAX
                  ? `高于健康上限 ${(COST_RATIO_MAX * 100).toFixed(0)}%，抗涨价缓冲薄`
                  : `健康区间 ${(COST_RATIO_MIN * 100).toFixed(0)}%–${(COST_RATIO_MAX * 100).toFixed(0)}%`,
      },
      {
        id: "tolerance",
        label: "元件涨价多少触发退款",
        value: need > 0 ? `+${tolerancePct.toFixed(0)}%` : "—",
        status: need > 0 ? (margin >= 0 ? (tolerancePct < 33 ? "warn" : "ok") : "err") : "err",
        note: need > 0
          ? margin >= 0
            ? `现价 × ${(hardCap / need).toFixed(2)} 触顶`
            : "现价已买不起"
          : "无成本基准",
      },
      {
        id: "margin",
        label: "流片后余量",
        value: margin >= 0 ? `${margin.toFixed(4)} BNB` : "不足，本期会退款",
        status: margin >= 0 ? "ok" : "err",
        note: margin >= 0 ? "募资总额覆盖流片成本后的剩余" : `缺口 ${(-margin).toFixed(4)} BNB`,
      },
      {
        id: "hashpower",
        label: "本期矿机权重",
        value: String(review.hashpower ?? "—"),
        status: Number(review.hashpower) > 0 ? "ok" : "err",
        note: Number(review.hashpower) > 0
          ? `${review.needParts} 元件 × P=${review.processorScale}${review.capped ? " · 闸门拦住" : ""}${review.optimal ? ` · 含溢价 q=${review.q}` : " · 无设计溢价"}`
          : "权重为 0",
      },
      {
        id: "daily",
        label: review.capped ? "日产（未验证池）" : "日产（已验证池）",
        value: `${formatBem(daily)} BEM`,
        status: daily > 0 ? (review.capped ? "warn" : "ok") : "err",
        note: review.capped
          ? `题目超过挖矿闸门 ${MINE_GATE_LIMIT} 门，只进未验证池分 1%`
          : "按全网已验证权重占比估算",
      },
      {
        id: "dailyNet",
        label: `扣费后日产（服务费 ${feeRateDraft}%）`,
        value: `${formatBem(dailyNet)} BEM`,
        status: !feeOk ? "err" : dailyNet > 0 ? "ok" : "err",
        note: feeOk
          ? `日产 × (1 − ${feeRateDraft}%) = ${formatBem(dailyNet)}`
          : "服务费须为 1–20 的整数",
      },
    ];
  })();
  const schemeRatioPct = review.hardCapBnb > 0 ? (review.needBnb / review.hardCapBnb) * 100 : 0;
  const schemeRisePct = review.needBnb > 0 ? ((review.hardCapBnb / review.needBnb) - 1) * 100 : 0;
  const schemeWeight = review.optimal
    ? `${review.needParts} × P=${review.processorScale} + 设计溢价 = ${review.hashpower}`
    : `${review.needParts} × P=${review.processorScale} = ${review.hashpower}`;

  function update(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <section>
      {/* 实时报价只在页头显示这一处，随页面一起滚走 */}
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
                  ? "写入测试网后参数不可改。仅 Factory Owner 可发布。"
                  : "选定处理器与发行规模。参数写入后不能改。"}
              </p>
            </div>
          </div>
          <LivePriceTag snapshot={quote} now={now} />
        </div>
      </header>

      {chainMode && (
        <article className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">发布权限</div>
          <div className="card-body">
            <ul className="bill">
              <li>
                <span>Factory Owner</span>
                <strong>{factoryOwner ? shortAddress(factoryOwner) : "—"}</strong>
              </li>
              <li>
                <span>当前钱包</span>
                <strong>
                  {connectedAccount ? shortAddress(connectedAccount) : "未连接"}
                  {isFactoryOwner && connectedAccount ? " · 可签名" : ""}
                </strong>
              </li>
            </ul>
            {!connectedAccount && (
              <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={onConnect}>
                连接 Owner 钱包
              </button>
            )}
            {connectedAccount && !isFactoryOwner && (
              <p className="fine warn-text" style={{ marginTop: 8 }}>
                当前钱包不是 Factory Owner。请在 MetaMask 切换到 {shortAddress(factoryOwner)} 后再发布。
              </p>
            )}
          </div>
        </article>
      )}

      {/* 发行规模：开期人先定这期总共募多少、分成多少份，再按募资总额选题目 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span>发行规模</span>
          <span className="stat-label">第一步 · 定募资总额与总份数</span>
        </div>
        <div className="card-body">
          <div className="form-grid cols-3">
            <label className="field">
              <span>募资总额（BNB）</span>
              <input
                value={draft.hardCapBnb}
                placeholder={offering.hardCapBnb.toFixed(4)}
                inputMode="decimal"
                className={capValid ? undefined : "is-invalid"}
                title="开期人手动填写：本期总共募集多少 BNB。留空 = 跟随建议方案"
                onChange={(event) => update("hardCapBnb", event.target.value)}
              />
            </label>
            <label className="field">
              <span>总份数</span>
              <input
                value={draft.totalShares}
                placeholder={String(offering.totalShares)}
                inputMode="numeric"
                className={sharesValid ? undefined : "is-invalid"}
                title="开期人手动填写：本期分成多少份。留空 = 跟随建议方案"
                onChange={(event) => update("totalShares", event.target.value)}
              />
            </label>
            <label className="field">
              <span>每份 BNB</span>
              <input
                value={priceInput || "—"}
                readOnly
                title="由「募资总额 ÷ 总份数」派生，不可单独手填"
              />
            </label>
          </div>
          <p className="fine">
            先定这期总共募多少 BNB、分成多少份，每份 BNB 自动算成「募资总额 ÷ 总份数」（只读）。
            募资总额决定你能选多大的题目——下方选题列表里标红的题目是流片成本超出募资总额的。
            总份数越多每份越便宜，但单份认购门槛更低、持有人更分散。
          </p>
        </div>
      </div>

      {/* 目标处理器：第二步，先于选题——权重与成本都按所选处理器算 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span>目标处理器</span>
          <span className="stat-label">
            第二步 · 题目 #{task.id} {task.name}（{task.g} 个元件）
          </span>
        </div>
        <div className="card-body">
          <div className="transistor-grid">
            {options.map((plan) => {
              const active = plan.processorId === processorId;
              return (
                <button
                  key={plan.processorId}
                  type="button"
                  className={
                    (active ? "transistor-card is-on" : "transistor-card") +
                    (plan.affordable ? "" : " is-short")
                  }
                  onClick={() => update("processorId", plan.processorId)}
                  title={`选择 ${plan.processorId} · P=${plan.processorScale} · ${plan.weightPerBnb} 权重/BNB`}
                >
                  <div className="transistor-head">
                    <strong>{plan.processorId}</strong>
                    {active ? (
                      <em className="badge tone-done">已选</em>
                    ) : (
                      <em className="badge tone-wait">P={plan.processorScale}</em>
                    )}
                  </div>
                  <div className="transistor-price">
                    {plan.priceNand.toFixed(4)} <small>BNB/NAND</small>
                  </div>
                  <ul className="transistor-specs">
                    <li>
                      <span>处理器系数 P</span>
                      <strong>P={plan.processorScale}</strong>
                    </li>
                    {/* 只列题目实际要用到的元件——纯组合逻辑题没有 LATCH */}
                    <li>
                      <span>
                        元件 {plan.costBreakdown.NAND.count} NAND
                        {plan.costBreakdown.LATCH.count > 0 ? ` + ${plan.costBreakdown.LATCH.count} LATCH` : ""}
                      </span>
                      <strong>{plan.priceNand.toFixed(4)} BNB 起</strong>
                    </li>
                    <li>
                      <span>权重 H</span>
                      <strong>{plan.hashpower}</strong>
                    </li>
                    <li>
                      <span>流片成本</span>
                      <strong>{plan.partsCost.toFixed(4)} BNB</strong>
                    </li>
                    <li>
                      <span>占募资总额</span>
                      <strong className={plan.affordable ? "" : "is-short"}>
                        {(plan.costRatio * 100).toFixed(0)}%
                      </strong>
                    </li>
                    <li>
                      <span>权重 / BNB</span>
                      <strong>{plan.weightPerBnb}</strong>
                    </li>
                    <li>
                      <span>日产</span>
                      <strong>{formatBem(plan.dailyBem)} BEM</strong>
                    </li>
                  </ul>
                  <div className={plan.affordable ? "transistor-foot ok" : "transistor-foot bad"}>
                    {plan.affordable
                      ? `涨价 ${((plan.priceTolerance - 1) * 100).toFixed(0)}% 退款`
                      : `缺 ${(plan.partsCost - hardCapBnb).toFixed(4)} BNB`}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="auto-pick-banner" style={{ marginTop: 14, marginBottom: 0 }}>
            <div className="auto-pick-head">
              <strong>已选 {tplan.processorId}</strong>
              <div className="auto-pick-tags">
                <em className={tplan.affordable ? "pool-tag" : "pool-tag is-capped"}>
                  {tplan.affordable
                    ? `成本占募资总额 ${(tplan.costRatio * 100).toFixed(0)}%`
                    : "募资总额买不起"}
                </em>
                <em className="auto-follow">由开期人选择</em>
              </div>
            </div>
            <p className="fine">{advice}</p>
          </div>

          <p className="fine">
            只有 TapeOut 与 Behemoth 两个创世处理器上的电路具备挖矿资格。Behemoth 权重系数 P=6
            但元件贵约 7.5 倍；TapeOut P=1 但便宜。系统只把两个选项的账算清楚，选哪个由你决定。
          </p>
          <p className="fine">
            {tplan.latch > 0 ? (
              <>
                注意：NAND 与 LATCH 不是二选一——配比由题目给定（本题 {task.nand} NAND +{" "}
                {task.latch} LATCH），同处理器下两者共用一个合约、只差 tokenId，两种都要买。
              </>
            ) : (
              <>
                本题是纯组合逻辑，只需要 {task.nand} 个 NAND、没有 LATCH，
                所以不列 LATCH 的价格——买了也用不上。
              </>
            )}
          </p>
        </div>
      </div>

      {/* 第三步：选题（题目决定元件数与深度，按所选处理器实时价估算成本） */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span>选题</span>
          <span className="stat-label">
            第三步 · 官方题库 {taskbook?.total || 0} 道
            {taskbook?.source === "live" ? "（实时）" : taskbook?.source === "loading" ? "（加载中…）" : "（离线兜底）"}
          </span>
        </div>
        <div className="card-body">
          <div className="task-toolbar">
            <input
              className="task-search"
              value={taskQuery}
              placeholder="搜索题名或分类，如 加法器 / 时序 / 42"
              onChange={(e) => setTaskQuery(e.target.value)}
            />
            <div className="tier-row">
              <button
                type="button"
                className={!tierFilter ? "is-on" : ""}
                onClick={() => setTierFilter("")}
              >
                全部
              </button>
              {tiers.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  className={tierFilter === tier ? "is-on" : ""}
                  onClick={() => setTierFilter(tier)}
                >
                  {tier}
                </button>
              ))}
            </div>
          </div>

          <div className="task-list">
            {shown.length === 0 && <p className="fine">没有匹配的题目。</p>}
            {shown.slice(0, 60).map((t) => {
              const active = String(t.id) === String(draft.taskId);
              // 按该题自己的 NAND/LATCH 配比与各自实时价估算，不用单一均价
              const tNand = Number.isFinite(t.nand) ? t.nand : Math.max(0, t.g - Math.round(t.g * tplan.latchRatio));
              const tLatch = Number.isFinite(t.latch) ? t.latch : t.g - tNand;
              const cost = tNand * tplan.priceNand + tLatch * tplan.priceLatch;
              const affordable = cost <= hardCapBnb;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`task-item${active ? " is-on" : ""}${affordable ? "" : " is-short"}`}
                  onClick={() => update("taskId", String(t.id))}
                  title={`${t.name} · ${t.g} 元件 · 深度 ${t.d}`}
                >
                  <div className="task-line1">
                    <strong>{t.name}</strong>
                    <em className="tier-tag">{t.tier}</em>
                  </div>
                  <div className="task-line2">
                    <span>#{t.id}</span>
                    <span>{t.g} 元件</span>
                    <span>d={t.d}</span>
                    {t.g > MINE_GATE_LIMIT && <span className="is-gated">超闸门</span>}
                    <span className={affordable ? "" : "is-short"}>{cost.toFixed(4)} BNB</span>
                  </div>
                </button>
              );
            })}
            {shown.length > 60 && (
              <p className="fine">仅显示前 60 道，共 {shown.length} 道，用搜索缩小范围。</p>
            )}
          </div>
        </div>
      </div>

      {/* 选中题目 + 所选处理器的成本与权重拆解 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span>本期题目与权重</span>
        </div>
        <div className="card-body">
          <div className="formula-inline">
            H = ( b* + K_task × q ) × P= ( {tplan.totalParts} + {task.K} × {tplan.q} ) ×{" "}
            {tplan.processorScale} = {tplan.hashpower}
          </div>
          <ul className="bill">
            <li>
              <span>题目</span>
              <strong>
                #{task.id} {task.name}
              </strong>
            </li>
            <li>
              <span>难度 / 题型</span>
              <strong>
                {task.tier} · {task.kind === "seq" ? "时序" : "组合"}
              </strong>
            </li>
            <li>
              <span>元件拆分</span>
              <strong>
                {tplan.nand > 0 && tplan.latch > 0
                  ? `${tplan.nand} NAND + ${tplan.latch} LATCH（LATCH 占 ${Math.round(tplan.latchRatio * 100)}%）`
                  : tplan.nand > 0
                    ? `${tplan.nand} NAND（纯组合逻辑，无需锁存器）`
                    : `${tplan.latch} LATCH`}
              </strong>
            </li>
            {/* 不显示元件单价（BNB/个）—— 那是价格信息，已在「目标处理器」卡片里给出，
                这里只讲这道题要烧多少、值多少钱。题目不需要的那一类更不该出现。 */}
            {tplan.nand > 0 && (
              <li>
                <span>NAND 小计</span>
                <strong>{tplan.costBreakdown.NAND.cost.toFixed(4)} BNB</strong>
              </li>
            )}
            {tplan.latch > 0 && (
              <li>
                <span>LATCH 小计</span>
                <strong>{tplan.costBreakdown.LATCH.cost.toFixed(4)} BNB</strong>
              </li>
            )}
            <li className="due">
              <span>流片成本合计</span>
              <strong>{tplan.partsCost.toFixed(4)} BNB</strong>
            </li>
            <li>
              <span>本期矿机权重</span>
              <strong>{tplan.hashpower}</strong>
            </li>
            <li>
              <span>成本占募资总额</span>
              <strong className={(tplan.costRatio >= 0.2 && tplan.costRatio <= 0.75) ? "" : "is-short"}>
                {(tplan.costRatio * 100).toFixed(1)}%
                {offering.tooSmall ? "（题目太小）" : tplan.costRatio > 0.75 ? "（偏高）" : ""}
              </strong>
            </li>
          </ul>

          {/* 真实产出机制：按权重占比分配，不是权重乘固定系数 */}
          <div className="emit-box">
            <div className="emit-head">
              <strong>这台矿机实际能产多少</strong>
              <em className={tplan.capped ? "pool-tag is-capped" : "pool-tag"}>
                {tplan.capped ? "未验证池 · 分 1%" : "已验证池 · 分 99%"}
              </em>
            </div>
            <div className="formula-inline">
              日产 = 池日产 × 我的权重 ÷ 全池权重 = {rate.dailyEmission.toLocaleString()} ×{" "}
              {tplan.hashpower.toLocaleString()} ÷{" "}
              {(tplan.capped ? rate.networkWeight.unverified : rate.networkWeight.verified).toLocaleString()} ={" "}
              {formatBem(tplan.dailyBem)} BEM
            </div>
            <ul className="bill">
              <li className="due">
                <span>实际日产</span>
                <strong>{formatBem(tplan.dailyBem)} BEM</strong>
              </li>
              <li>
                <span>扣费后日产（{draft.feePercent}%）</span>
                <strong>{formatBem(dailyNetBem)} BEM</strong>
              </li>
              <li>
                <span>服务费（{draft.feePercent}%）</span>
                <strong>−{formatBem(dailyFeeBem)} BEM/天</strong>
              </li>
              <li>
                <span>投入成本（买元件）</span>
                <strong>{tplan.partsCost.toFixed(4)} BNB</strong>
              </li>
            </ul>
            <p className="fine">
              这里只给日产。产出是<b>零和</b>的：当前全网已验证权重{" "}
              {rate.networkWeight.verified.toLocaleString()}，每权重日产{" "}
              {formatBem(rate.verifiedPerWeight)} BEM。
              全网权重一变，所有人都同步变——所以「日产」会浮动，
              而且不随挖多久而累加成一个可靠总数。
            </p>
            {tplan.capped && (
              <p className="fine warn-text">
                题目 {task.g} 门超过挖矿闸门 {MINE_GATE_LIMIT} 门
                —— 链上跑不完官方向量，认领不了任何题目，只能进未验证池分 1%，且拿不到设计溢价。
                撞上闸门会让权重拿不到溢价部分。
              </p>
            )}
          </div>
          <p className="fine">
            流片成本 {tplan.partsCost.toFixed(4)} BNB，占募资总额 {(tplan.costRatio * 100).toFixed(1)}%。
            参考区间 {(COST_RATIO_MIN * 100).toFixed(0)}%–{(COST_RATIO_MAX * 100).toFixed(0)}%。
            按当前报价，元件再涨 {((tplan.priceTolerance - 1) * 100).toFixed(0)}% 后刚好覆盖流片成本。
          </p>
          {offering.tooSmall && (
            <p className="fine warn-text">
              这道题太小：元件数由题目写死（只有 {task.g} 个），即使把募资总额压到最低
              （20 份 × 0.05 BNB = 1 BNB），成本占比也只有{" "}
              {(offering.bestRatio * 100).toFixed(1)}%，够不到 20% 的健康下限。
              调参数救不了——建议换元件数更多的题目，或改用更贵的处理器把预算用起来。
            </p>
          )}
          <p className="fine">
            题目由项目方从官方题库选定，用户不参与设计。q 固定为 1
            {tplan.optimal ? "（已声明最优首创，含设计溢价）" : "（等同复制官方参考，无设计溢价）"}。
            {tplan.latch > 0 && (
              <>
                {" "}LATCH 占比按题型默认：组合逻辑 20%、时序 50%，因 LATCH 面积为普通门的 6 倍。
              </>
            )}
          </p>
          <p className="fine">
            成本随元件实时价格变动。若执行时涨价导致募资总额买不起所需元件，本期全额退款。
          </p>
        </div>
      </div>

      <div className="layout">
        <article className="card">
          <div className="card-header"><span>期次参数</span></div>
          <form
            className="card-body"
            onSubmit={(event) => {
              event.preventDefault();
              if (review.ok) onCreate(effectiveDraft, review);
            }}
          >
            <div className="form-grid cols-3">
              <label className="field">
                <span>募集天数</span>
                <input value={draft.fundingDays} onChange={(event) => update("fundingDays", event.target.value)} />
              </label>
              <label className="field">
                <span>服务费 %</span>
                <input value={draft.feePercent} onChange={(event) => update("feePercent", event.target.value)} />
              </label>
              <label className="field">
                <span>目标处理器</span>
                <input
                  value={`${processorId} · P=${tplan.processorScale}`}
                  readOnly
                  title="在上方「目标处理器」卡片中点选"
                />
              </label>
              <label className="field wide">
                <span>服务费收费地址</span>
                <input value={draft.feeRecipient} onChange={(event) => update("feeRecipient", event.target.value)} />
              </label>
            </div>
            <p className="fine">
              发行规模、题目与目标处理器都在上方卡片里选定，本区块只汇总、不重复编辑。
              改「目标处理器」会改变流片成本，进而改变成本占募资总额比例。
            </p>
            {review.issues.length > 0 && (
              <div className="issues">
                {review.issues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            )}
            {review.ok && <p className="check-ok">参数检查通过，可以发布。</p>}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!review.ok || Boolean(pending) || quote.loading || (chainMode && !isFactoryOwner)}
            >
              {pending
                ? pending === "createCampaign" ? "发布中…" : String(pending)
                : quote.loading
                  ? "取价中…"
                  : chainMode && !connectedAccount
                    ? "请先连接 Owner 钱包"
                    : chainMode && !isFactoryOwner
                      ? "需 Factory Owner 钱包"
                      : "发布众筹挖矿"}
            </button>
          </form>
        </article>
        <article className="card">
          <div className="card-header">
            <span>发布检查</span>
            <span className="stat-label">
              {publishChecks.every((c) => c.status === "ok")
                ? "全部通过"
                : publishChecks.some((c) => c.status === "err")
                  ? "有错误项"
                  : "有警告项"}
            </span>
          </div>
          <div className="card-body">
            <ul className="bill publish-checks">
              {publishChecks.map((item) => (
                <li
                  key={item.id}
                  className={item.status === "err" ? "is-short" : item.id === "tolerance" ? "due" : undefined}
                >
                  <span>
                    <em className={`check-mark is-${item.status}`} aria-hidden="true">
                      {item.status === "ok" ? "✓" : item.status === "warn" ? "!" : "×"}
                    </em>
                    {item.label}
                  </span>
                  <strong title={item.note}>{item.value}</strong>
                </li>
              ))}
            </ul>
            <ul className="check-notes">
              {publishChecks
                .filter((c) => c.status !== "ok")
                .map((c) => (
                  <li key={`${c.id}-note`} className={c.status === "err" ? "is-err" : "is-warn"}>
                    {c.label}：{c.note}
                  </li>
                ))}
            </ul>
            {publishChecks.every((c) => c.status === "ok") && (
              <p className="check-ok">发布检查各项通过。</p>
            )}

            <p className="fine">
              成本占募资总额 <b>{schemeRatioPct.toFixed(1)}%</b>，参考区间 {(COST_RATIO_MIN * 100).toFixed(0)}%–{(COST_RATIO_MAX * 100).toFixed(0)}%。
              按当前报价，元件再涨 <b>{schemeRisePct.toFixed(0)}%</b> 后，募资总额刚好覆盖流片成本；超过这个幅度，执行时买不齐元件，本期失败并全额退款。
            </p>
            <p className="fine">
              权重 H = {schemeWeight}。发布后锁定当前报价快照，持份人可在观察期内核对。
            </p>
            <p className="fine">
              Factory Owner：{shortAddress(factoryOwner || OWNER)}
              {chainMode && factoryOwner ? "（链上）" : ""}
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

/** 实时价格标签：显示更新时间、刷新倒计时与陈旧状态 */
function LivePriceTag({ snapshot, intervalMs = 5000, now = Date.now() }) {
  if (!snapshot) return null;
  const age = snapshot.updatedAt ? now - snapshot.updatedAt : Infinity;
  // 超过 3 个周期未更新视为陈旧
  const stale = snapshot.error || age > intervalMs * 3;
  const secs = snapshot.updatedAt ? Math.max(0, Math.round((intervalMs - age) / 1000)) : 0;
  return (
    <span className={stale ? "live-tag is-stale" : "live-tag"} title={snapshot.updatedAt ? formatClock(snapshot.updatedAt) : ""}>
      <i className="live-dot" />
      {snapshot.loading && !snapshot.updatedAt
        ? "取价中…"
        : snapshot.error
          ? `取价失败：${snapshot.error}`
          : `${snapshot.bnbUsdt ? `BNB ${snapshot.bnbUsdt.toFixed(4)} · ` : ""}实时价 · ${formatClock(snapshot.updatedAt || Date.now())} · ${secs}s 后刷新`}
    </span>
  );
}

export function OwnerHolders({ round, book, account = "", holders = null, chainMode = false, embedded = false }) {
  // 链上模式：用从事件重构的真实持有人；模拟模式：用 buildHolders 生成的演示名册
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
    ? "从链上 Bought / Refunded / ListingTaken 事件重构的当前持有人。"
    : "只记录通过购买记上的份数。直接转入的 BNB 不会出现在这里。";
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
            <p className="fine">正在从链上事件加载持有人…</p>
          ) : rows.length === 0 ? (
            <p className="fine">这一期还没有人购买。</p>
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
