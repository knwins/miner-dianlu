import { useState } from "react";
import {
  MARKET,
  OWNER,
  PAST_ROUNDS,
  QUOTE,
  TRANSISTORS,
  bemRate,
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
  estimateHashpower,
  formatBem,
  formatClock,
  reviewRound,
  shortAddress,
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

export function OwnerOverview({ round, book, copy, pending, actor, executeWait, onPlaceTransistorOrder, onCancelTransistorOrder, onConfirmTransistors, onExecute, onHarvest }) {
  const raised = book.sold * round.sharePriceBnb;
  const harvest = computeHarvest(round, book);
  const isOwner = actor?.role === "owner";
  // F3：execute 不可逆（把全期募集款烧成晶体管），权限收紧为仅工厂 Owner
  const canExecute = isOwner && executeWait === 0;
  const waitHours = Math.ceil(executeWait / 3600_000);
  const actions = [
    {
      id: "execute",
      label: executeWait > 0 ? `观察期未满（剩 ${waitHours} 小时）` : "流片并开户挖矿",
      enabled: book.scene === "executing" && book.executePhase === "ready" && canExecute,
      hint:
        book.scene !== "executing"
          ? "仅在份数售罄且观察期满后可用。"
          : book.executePhase !== "ready"
            ? "晶体管尚未到位：请先调用 tapeout.net 挂单逻辑并确认成交到账，再流片开矿。"
            : executeWait > 0
              ? `售罄后 ${round.executeDelayHours} 小时观察期，让持份用户核对网表哈希与报价快照。Owner 也不能提前执行。`
              : !isOwner
                ? "需要工厂 Owner 身份（execute 不可逆，仅 Owner 可触发）。"
                : `流片会把募集到的全部 BNB 换成元件并烧掉、铸造电路，不可逆；流片成功即自动开户挖矿进入挖矿中。仅工厂 Owner 可触发。`,
      run: onExecute,
    },
    {
      id: "harvest",
      label: "领取并分配",
      enabled: book.scene === "mining",
      hint: `向挖矿合约领取当日 BEM，先扣服务费，再按份记入持有人。领取次数不限，只要还在出矿即可领取；本次可分得 ${formatBem(harvest.userPart)} BEM。`,
      run: onHarvest,
    },
  ];

  return (
    <section>
      <header className="page-header">
        <div>
          <h1>第 {round.id} 期概览</h1>
          <p className="page-subtitle">Owner 只能开期和查看，并负责流片（execute 不可逆，会把募集款烧成晶体管，但不转给 Owner）。领取、份额转让不把用户的 BNB 转给 Owner。</p>
        </div>
        <span className={`badge tone-${copy.tone}`}>{copy.badge}</span>
      </header>

      <div className="stat-grid">
        <article className="stat-card accent">
          <div className="stat-label">已募集</div>
          <div className="stat-value">{formatBem(raised)} BNB</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">已售份数</div>
          <div className="stat-value">
            {book.sold}/{round.totalShares}
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-label">已扣服务费</div>
          <div className="stat-value">{formatBem(book.feeBem)} BEM</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">本期已分配</div>
          <div className="stat-value">{formatBem(book.distributed || 0)} BEM</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">当前日产</div>
          <div className="stat-value">{formatBem(harvest.dailyBem)} BEM</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">本次可分得</div>
          <div className="stat-value">{formatBem(harvest.userPart)} BEM</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">已领次数（不限）</div>
          <div className="stat-value">
            {harvest.rounds} 次
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-label">收费地址</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{shortAddress(round.feeRecipient)}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">本期合约</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{shortAddress(round.contract)}</div>
        </article>
      </div>

      <article className="card">
        <div className="card-header">权限与时间锁</div>
        <div className="card-body">
          <ul className="bill">
            <li>
              <span>当前身份</span>
              <strong>{actor?.label || "未连接"}</strong>
            </li>
            <li>
              <span>execute 权限</span>
              <strong>仅工厂 Owner</strong>
            </li>
            <li>
              <span>转让 权限</span>
              <strong>持份用户 / Owner</strong>
            </li>
            <li>
              <span>晶体管挂单 权限</span>
              <strong>仅工厂 Owner</strong>
            </li>
            <li>
              <span>观察期</span>
              <strong>售罄后 {round.executeDelayHours} 小时</strong>
            </li>
            <li className="due">
              <span>当前状态</span>
              <strong>
                {book.scene !== "executing"
                  ? "不处于待执行状态"
                  : book.executePhase === "ready"
                    ? executeWait > 0
                      ? `还需等待 ${waitHours} 小时`
                      : "已解锁，可流片开矿"
                    : book.executePhase === "listed"
                      ? "已调用 tapeout.net 挂单逻辑，待成交"
                      : "待调用 tapeout.net 挂单逻辑"}
              </strong>
            </li>
          </ul>
          <p className="fine">
            execute 会把全部募集款换成元件并烧掉晶体管，不可逆。权限收紧为**仅工厂 Owner** 可触发，避免任一持份用户单方面把全期本金烧掉。
            为防止 Owner 不作为导致资金卡死，真实合约应再加**时间锁 + 多签/投票**兜底——本预览在「{round.executeDelayHours} 小时观察期 + 报价快照锁定」基础上仅保留 Owner 门槛。
            观察期则给持份用户时间核对网表哈希与报价快照。
          </p>
          <p className="fine">
            退出只通过「份额转让」实现：持份用户把份额挂到转让市场卖给其他持份人，合约不提供本金或收益赎回。
          </p>
        </div>
      </article>

      {/* 待执行拆成「待挂单 → 挂单中（可取消） → 晶体管到账·待流片」三子状态。
          晶体管来自二级市场，由 Owner 钱包发起链上交易买入并确认成交（合约无法替人工去网站下单）。 */}
      {book.scene === "executing" && (() => {
        const est = book.estimate || {};
        const need = est.usedParts || 0;
        const phaseLabel =
          book.executePhase === "ready" ? "已到账 · 待流片"
            : book.executePhase === "listed" ? "挂单中 · 待成交"
              : "待挂单";
        return (
          <article className="card">
            <div className="card-header"><span>晶体管（二级市场）</span><span className="stat-label">Owner 链上交易</span></div>
            <div className="card-body">
              <ul className="bill">
                <li>
                  <span>目标处理器</span>
                  <strong>{est.processor || "—"}</strong>
                </li>
                <li>
                  <span>需买入并到账</span>
                  <strong>{need} 颗 {est.transistorName || ""}</strong>
                </li>
                <li>
                  <span>配比</span>
                  <strong>{est.nand || 0} NAND + {est.latch || 0} LATCH</strong>
                </li>
                <li className="due">
                  <span>状态</span>
                  <strong>{phaseLabel}</strong>
                </li>
              </ul>
              <p className="fine">
                晶体管来自 tapeout.net 二级市场，但合约无法替人工去平台操作。
                Owner 需手动调用链上交易：先 placeTransistorOrder（调用 tapeout.net 挂单逻辑）进入「挂单中」，
                成交后再 confirmTransistors（确认成交到账）。两步都通过链上交易完成，无需离开 dApp 去网站点鼠标。
              </p>
              {book.executePhase === "buying" && (
                <button className="btn btn-primary" type="button" disabled={!isOwner || Boolean(pending)} onClick={onPlaceTransistorOrder}>
                  {pending || "调用 tapeout.net 挂单逻辑"}
                </button>
              )}
              {book.executePhase === "listed" && (
                <>
                  <button className="btn btn-primary" type="button" disabled={!isOwner || Boolean(pending)} onClick={onConfirmTransistors}>
                    {pending || "确认 tapeout.net 成交到账"}
                  </button>
                  <button className="btn btn-inline" type="button" disabled={!isOwner || Boolean(pending)} onClick={onCancelTransistorOrder}>
                    {pending || "取消 tapeout.net 挂单"}
                  </button>
                </>
              )}
              {book.executePhase === "ready" && (
                <p className="fine">晶体管已确认到账，可执行流片并开户挖矿（见下方「可调用的操作」）。</p>
              )}
              {!isOwner && book.executePhase !== "ready" && (
                <p className="fine warn-text">仅工厂 Owner 可调用 / 取消 / 确认 tapeout.net 挂单。</p>
              )}
            </div>
          </article>
        );
      })()}

      <article className="card">
        <div className="card-header">可调用的操作</div>
        <div className="card-body">
          <div className="actions">
            {actions.map((action) => (
              <button
                key={action.id}
                className="btn btn-primary btn-inline"
                type="button"
                disabled={!action.enabled || Boolean(pending)}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          </div>
          {actions.map((action) => (
            <p key={`${action.id}-hint`} className="fine">
              {action.label}：{action.hint}
            </p>
          ))}
        </div>
      </article>

      <article className="card">
        <div className="card-header">历史期次</div>
        <div className="card-body table-wrap">
          <table>
            <thead>
              <tr>
                <th>期次</th>
                <th>状态</th>
                <th>份数</th>
                <th>募集</th>
                <th>算力</th>
                <th>已分配</th>
                <th>服务费</th>
              </tr>
            </thead>
            <tbody>
              {PAST_ROUNDS.map((item) => (
                <tr key={item.id}>
                  <td>第 {item.id} 期</td>
                  <td><span className={`badge tone-${item.tone}`}>{item.status}</span></td>
                  <td>{item.shares}</td>
                  <td>{item.raised}</td>
                  <td>{item.hashpower || item.hash || "—"}</td>
                  <td>{item.bem}</td>
                  <td>{item.fee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}

export function OwnerCreate({ onCreate, pending, snapshot, taskbook, now }) {
  const [draft, setDraft] = useState(EMPTY_FORM);
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

  function update(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <section>
      {/* 实时报价全页只显示这一处；页头吸顶，改下面的参数时随时能核对价格 */}
      <header className="page-header sticky-price">
        <div>
          <h1>开新一期</h1>
          <p className="page-subtitle">
            自己选目标处理器，系统按实时报价把成本与权重算清楚。参数写入后不能改。
          </p>
        </div>
        <LivePriceTag snapshot={quote} now={now} />
      </header>

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
                      <strong>{plan.dailyBem} BEM</strong>
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
              {tplan.dailyBem} BEM
            </div>
            <ul className="bill">
              <li className="due">
                <span>实际日产</span>
                <strong>{tplan.dailyBem} BEM</strong>
              </li>
              <li>
                <span>扣费后日产（{draft.feePercent}%）</span>
                <strong>{dailyNetBem.toFixed(4)} BEM</strong>
              </li>
              <li>
                <span>服务费（{draft.feePercent}%）</span>
                <strong>−{dailyFeeBem.toFixed(4)} BEM/天</strong>
              </li>
              <li>
                <span>投入成本（买元件）</span>
                <strong>{tplan.partsCost.toFixed(4)} BNB</strong>
              </li>
            </ul>
            <p className="fine">
              这里只给日产。产出是<b>零和</b>的：当前全网已验证权重{" "}
              {rate.networkWeight.verified.toLocaleString()}，每权重日产{" "}
              {rate.verifiedPerWeight.toFixed(6)} BEM。
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
            流片成本 {tplan.partsCost.toFixed(4)} BNB，占当前募资总额的{" "}
            {(tplan.costRatio * 100).toFixed(1)}%（健康区间 20%-75%：太低说明保护厚但募资没用起来，
            太高则抗涨价能力薄）。元件涨价 {((tplan.priceTolerance - 1) * 100).toFixed(0)}% 触发全额退款。
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
                <span>收费地址</span>
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
            {review.ok && <p className="check-ok">参数检查通过，可以开期。</p>}
            <button className="btn btn-primary" type="submit" disabled={!review.ok || Boolean(pending) || quote.loading}>
              {pending || quote.loading ? "取价中…" : "创建本期"}
            </button>
          </form>
        </article>
        <article className="card">
          <div className="card-header">
            <span>开期检查</span>
          </div>
          <div className="card-body">
            <ul className="bill">
              <li>
                <span>募资总额</span>
                <strong>{review.hardCapBnb > 0 ? `${review.hardCapBnb.toFixed(4)} BNB` : "—"}</strong>
              </li>
              <li>
                <span>流片成本（NAND + LATCH）</span>
                <strong>{(review.needBnb || 0).toFixed(4)} BNB</strong>
              </li>
              <li>
                <span>成本占募资总额</span>
                <strong>
                  {review.hardCapBnb > 0
                    ? `${((review.needBnb / review.hardCapBnb) * 100).toFixed(1)}%`
                    : "—"}
                </strong>
              </li>
              <li className="due">
                <span>元件涨价多少触发退款</span>
                <strong>
                  {review.needBnb > 0
                    ? `+${(((review.hardCapBnb / review.needBnb) - 1) * 100).toFixed(0)}%`
                    : "—"}
                </strong>
              </li>
              <li className={review.hardCapBnb > review.needBnb ? "" : "is-short"}>
                <span>流片后余量</span>
                <strong>
                  {review.hardCapBnb > review.needBnb
                    ? `${(review.hardCapBnb - review.needBnb).toFixed(4)} BNB`
                    : "不足，本期会退款"}
                </strong>
              </li>
              <li>
                <span>本期矿机权重</span>
                <strong>{review.hashpower}</strong>
              </li>
              <li>
                <span>日产（已验证池）</span>
                <strong>{formatBem(bemRate(review.hashpower || 0))} BEM</strong>
              </li>
              <li>
                <span>扣费后日产（{draft.feePercent}%）</span>
                <strong>{formatBem(bemRate(review.hashpower || 0) * (1 - feeRateDraft / 100))} BEM</strong>
              </li>
            </ul>

            <p className="fine">
              这三项决定本期成败：<b>成本占募资总额</b>决定抗涨价能力，
              低于 20% 说明保护很厚但募资总额没被用起来；
              高于 75% 则元件涨 {(((review.hardCapBnb / (review.needBnb || 1)) - 1) * 100).toFixed(0)}% 就会全额退款。
              权重由题目 {review.needParts} 个元件 × P={review.processorScale} 决定，
              {review.optimal ? `含设计溢价（q=${review.q}）` : "非最优设计无溢价"}。
            </p>
            <p className="fine">
              若执行时元件涨价导致募资总额买不起所需元件，本期判失败并全额退款。
              开期会锁定当前报价快照，供持份用户在观察期内核对。
            </p>
            <p className="fine">工厂 Owner：{shortAddress(OWNER)}</p>
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

export function OwnerHolders({ round, book, account = "", holders = null }) {
  // 链上模式：用从事件重构的真实持有人；模拟模式：用 buildHolders 生成的演示名册
  const rows = holders
    ? holders.map((h) => ({
        address: h.address,
        shares: h.shares,
        at: "链上记录",
        self: String(h.address).toLowerCase() === String(account || "").toLowerCase(),
      }))
    : buildHolders(book.sold, book.mine);
  const subtitle = holders
    ? "从链上购买/退款/转让事件重构的当前持有人（实时）。"
    : "只记录通过购买记上的份数。直接转入的 BNB 不会出现在这里。";
  return (
    <section>
      <header className="page-header">
        <div>
          <h1>份额明细</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
      </header>
      <article className="card">
        <div className="card-header">第 {round.id} 期 · {rows.length} 个地址 · 已售 {book.sold} 份</div>
        <div className="card-body table-wrap">
          {rows.length === 0 ? (
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
