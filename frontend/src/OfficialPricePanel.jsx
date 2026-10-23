/**
 * 官方处理器 · 元件市价面板。
 *
 * 展示 TapeOut / Behemoth 各自的 NAND 与 LATCH 最新成交价（BNB/颗），
 * 数据优先读链上官方市场成交事件，官方 market.json 作兜底，静态基准再兜底。
 *
 * 口径说明（面板里也写清楚了，避免被当成链上结算价）：
 *   - 成交价 = 最近一笔链上成交单价，由官方市场成交事件读出。
 *   - 这不是**本期**的挂单价；本期真实成本以链上 Campaign 记录为准。
 *
 * ── 为什么只有一个模块 ──
 * 材料市场页原先有两个卡片：①「官方元件最新价」②「官方处理器对照」。
 * 两者都按处理器分组、都渲染同一张 NAND/LATCH 价格表 —— 同一份数据画两遍，
 * 用户要在一页里上下滚动才能把「价格」和「这个处理器的地址/资格/白名单」对上。
 * 现在合并成**一个**卡片：每个处理器一节，表下面是该处理器的补充事实
 * （CPU / 元件合约 / 挖矿资格 / 工厂白名单），由调用方通过 `renderFacts` 注入。
 *
 * 三种用法：
 *   - compact（认购页 / 产品页 / 开期表单）：只显示当前期次那一组，不带 tokenId 与事实
 *   - full（材料市场页）：全部处理器 + tokenId 列 + 处理器简介 + 注入事实
 *
 * T-59：Genesis CPU 已整体移除（官方 multiplier = 0、永远不出矿）。
 * 「无挖矿产出」标记按挖矿资格数据驱动渲染，将来官方新增无产出处理器时
 * 会自动标注，而不是静默展示成产期。
 */
import {
  TRANSISTORS,
  PROCESSOR_IDS,
  PROCESSORS,
  isMineable,
  processorScale,
  formatUnitPrice,
} from "./prices.js";

/** 按处理器分组展示：NAND / LATCH 各一行。顺序与 PROCESSOR_IDS 一致，新增处理器自动进表。 */
const BY_PROCESSOR = PROCESSOR_IDS;

function formatPrice(v) {
  return formatUnitPrice(v);
}

/**
 * @param {object} props
 * @param {object} props.official   fetchOfficialPrices 的返回值
 * @param {string} props.processorId 当前期次的处理器（TapeOut / Behemoth），可空
 * @param {boolean} [props.compact] 紧凑模式（只显示当前处理器那一组）
 * @param {boolean} [props.full]    完整对照模式：全部处理器 + tokenId 列 + 处理器简介
 * @param {string} [props.title]    卡片标题
 * @param {React.ReactNode} [props.badge] 卡片标题右侧的附加标记
 * @param {(processorId: string) => React.ReactNode} [props.renderFacts]
 *        注入每个处理器分组下方的补充事实（地址、资格、白名单状态…）。
 *        返回 null 则不渲染。事实由调用方提供 —— 面板本身不知道链上白名单。
 */
export function OfficialPricePanel({
  official,
  processorId = null,
  compact = false,
  full = false,
  title = "官方元件最新价",
  badge = null,
  renderFacts = null,
}) {
  const rows = official?.prices || {};
  const groups = compact && processorId ? [processorId] : BY_PROCESSOR;

  const shown = groups
    .map((p) => ({
      processor: p,
      name: PROCESSORS[p]?.name || p,
      desc: PROCESSORS[p]?.desc || "",
      mineable: isMineable(p),
      scale: processorScale(p),
      items: TRANSISTORS.filter((t) => t.processor === p).map((model) => ({
        model,
        row: rows[model.id] || null,
      })),
    }))
    .filter((g) => g.items.length > 0);
  if (shown.length === 0) return null;

  const generated = official?.generatedAt ? new Date(official.generatedAt) : null;
  const genText = generated
    ? `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, "0")}-${String(generated.getDate()).padStart(2, "0")} ${String(generated.getHours()).padStart(2, "0")}:${String(generated.getMinutes()).padStart(2, "0")}`
    : "";

  return (
    <article className="card official-price-card">
      <div className="card-header">
        <span>{title}</span>
        {/*
          右侧信息合成一组。card-header 是 space-between 布局，
          如果标题、badge、快照状态是三个平级子元素，它们会被均匀撑开
          （标题在左、badge 居中、状态在右）—— 合成一组才能一起靠右。
        */}
        <span className="official-price-card-side">
          {badge}
          <span className="stat-label">
            {official?.ok ? "官方市场快照" : official?.error ? "读取失败" : "读取中…"}
          </span>
        </span>
      </div>
      <div className="card-body">
        {official?.error && (
          <p className="fine warn-text">
            官方市价读取失败（{official.error}）。下方价格可能为空；本期真实挂单价以链上 Campaign 记录为准。
          </p>
        )}
        <div className="official-price-groups">
          {shown.map((g) => (
            <section key={g.processor} className="official-price-group">
              <h4>
                {g.name}
                {processorId === g.processor && <em className="est-tag">本期</em>}
                {/*
                  算力 P 只在完整对照模式显示。紧凑模式（认购页 / 产品页 / 开期表单）
                  保持原样 —— 那里标题旁只有「本期」与「无挖矿产出」两种标记，
                  塞进 P 会挤占紧凑版面的宽度。
                */}
                {full
                  ? (g.mineable
                    ? <em className="est-tag">P = {g.scale}</em>
                    : <em className="est-tag warn-tag">无挖矿产出</em>)
                  : (!g.mineable && <em className="est-tag warn-tag">无挖矿产出</em>)}
              </h4>
              {full && g.desc ? <p className="fine">{g.desc}</p> : null}
              <table className="official-price-table">
                <thead>
                  <tr>
                    <th>元件</th>
                    <th>成交价</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map(({ model, row }) => (
                    <tr key={model.id}>
                      {/*
                       * tokenId 只有固定两值（NAND=0 / LATCH=1），单独占一列既占宽又
                       * 每行都重复「0 / 1」。并进元件名后缀，信息不丢、少一列。
                       */}
                      <td>
                        <strong>{model.part}</strong>
                        {full && <em className="part-id">#{model.tokenId}</em>}
                      </td>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {row?.last != null ? formatPrice(row.last) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {renderFacts ? renderFacts(g.processor) : null}
            </section>
          ))}
        </div>
        <p className="fine">
          成交价 = 最近一笔链上成交单价（BNB/颗），由官方市场成交事件读出。
          {genText ? ` 快照时间 ${genText}` : ""}
          {official?.lastBlock ? ` · 区块 ${official.lastBlock.toLocaleString("zh-CN")}` : ""}
        </p>
        <p className="fine">本期实际成本以链上 Campaign 挂单 / 成交记录为准，这里只作市价参考。</p>
      </div>
    </article>
  );
}

/**
 * 单个元件的官方价（BNB/颗），没有则 null。
 * 供表单做「填入市价」按钮用。
 */
export function officialUnitPrice(official, transistorId) {
  const row = official?.prices?.[transistorId];
  if (!row) return null;
  const p = row.last != null ? row.last : row.bid;
  return p != null && p > 0 ? p : null;
}

/**
 * 处理器下 NAND / LATCH 的官方价对。
 *
 * ⚠️ 按 TRANSISTORS 查表，不能写
 * `processorId === "Behemoth" ? "BEHEMOTH_*" : "TAPE_OUT_*"`：
 * 那种二元写法在处理器数量变化后会落到 TapeOut 的 id 上，取不到新处理器的市价。
 */
export function officialPartPrices(official, processorId) {
  const out = {};
  for (const part of ["NAND", "LATCH"]) {
    const model = TRANSISTORS.find((t) => t.processor === processorId && t.part === part);
    // 取不到时给 0 而不是 null：调用方会拿它做算术与比较（`> 0` / `× 1.5`），
    // null 会让 `null > 0` 依赖隐式转换、也让乘法结果变 null，UI 容易显示成 "null BNB"。
    if (!model) {
      out[part] = 0;
      continue;
    }
    const p = officialUnitPrice(official, model.id);
    out[part] = p != null && p > 0 ? p : 0;
  }
  return out;
}
