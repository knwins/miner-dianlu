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
 * ── 两种形态 ──
 *   - compact（开期表单 / Owner 弹窗）：只显示当前期次那一组，价格用紧凑表格。
 *   - full（材料市场页）：行情看板 —— 每个处理器一张卡，单价是卡里的主角
 *     （28px 数字 + 单位），处理器名 / 每颗算力 P 退到卡头，地址与白名单退到卡脚。
 *
 *   之前 full 形态和 compact 共用同一张 12px 表格：价格、地址、白名单全是同一号字，
 *   页面上「什么贵、贵多少」要逐字读才发现。行情页的重点本来就该是价格本身。
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

/** 按处理器分组展示：NAND / LATCH 各一格。顺序与 PROCESSOR_IDS 一致，新增处理器自动进表。 */
const BY_PROCESSOR = PROCESSOR_IDS;

function formatPrice(v) {
  return formatUnitPrice(v);
}

/**
 * 快照时间文案。
 *
 * `generatedAt` 有两个来源、两种格式：market.json 给 ISO 时间串，
 * 链上主源给字面量 "onchain"（没有时间戳，只有区块号）。
 * 直接 `new Date("onchain")` 得到 Invalid Date，页面上会印出
 * 「NaN-NaN-NaN NaN:NaN」—— 这里必须先判可解析，解析不了就不显示时间。
 */
function snapshotTimeText(generatedAt) {
  if (!generatedAt || generatedAt === "onchain") return "";
  const d = new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {object} props
 * @param {object} props.official   fetchOfficialPrices 的返回值
 * @param {string} props.processorId 当前期次的处理器（TapeOut / Behemoth），可空
 * @param {boolean} [props.compact] 紧凑模式（只显示当前处理器那一组）
 * @param {boolean} [props.full]    完整对照模式：全部处理器 + 行情看板 + 处理器简介
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

  const genText = snapshotTimeText(official?.generatedAt);
  const block = Number(official?.lastBlock) || 0;
  const statusText = official?.ok
    ? (genText ? `官方市场快照 · ${genText}` : "官方市场快照")
    : official?.error
      ? "读取失败"
      : "读取中…";

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
          <span className="stat-label">{statusText}</span>
        </span>
      </div>
      <div className="card-body">
        {official?.error && (
          <p className="fine warn-text">
            官方市价读取失败（{official.error}）。下方价格可能为空；本期真实挂单价以链上 Campaign 记录为准。
          </p>
        )}

        {full ? (
          /* ── 行情看板：价格是主角 ── */
          <div className="price-board">
            {shown.map((g) => {
              const current = processorId === g.processor;
              return (
                <section
                  key={g.processor}
                  className={`official-price-group price-board-card${current ? " is-current" : ""}`}
                >
                  <header className="price-board-head">
                    <div className="price-board-title">
                      <h4>{g.name}</h4>
                      {current && <em className="est-tag">本期</em>}
                    </div>
                    {g.mineable ? (
                      <span className="price-board-scale">每颗算力 P = {g.scale}</span>
                    ) : (
                      <em className="est-tag warn-tag">无挖矿产出</em>
                    )}
                  </header>
                  {g.desc ? <p className="price-board-desc">{g.desc}</p> : null}
                  <div className="price-board-prices">
                    {g.items.map(({ model, row }) => {
                      const price = row?.last != null ? row.last : null;
                      return (
                        <div className="price-cell" key={model.id}>
                          {/*
                            tokenId 只有固定两值（NAND=0 / LATCH=1），
                            作为元件名后缀带着走，不单独占一行。
                          */}
                          <span className="price-cell-label">
                            {model.part}
                            <em className="part-id">#{model.tokenId}</em>
                          </span>
                          <strong className="price-cell-value">
                            {price != null ? formatPrice(price) : "—"}
                          </strong>
                          <span className="price-cell-unit">
                            {price != null ? "BNB / 颗" : "暂无成交"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {renderFacts ? renderFacts(g.processor) : null}
                </section>
              );
            })}
          </div>
        ) : (
          /* ── 紧凑形态：开期表单 / Owner 弹窗里的一组表格 ── */
          <div className="official-price-groups">
            {shown.map((g) => (
              <section key={g.processor} className="official-price-group">
                <h4>
                  {g.name}
                  {processorId === g.processor && <em className="est-tag">本期</em>}
                  {!g.mineable && <em className="est-tag warn-tag">无挖矿产出</em>}
                </h4>
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
                        <td>
                          <strong>{model.part}</strong>
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
        )}

        {/*
          口径说明拆成两条完整句子：并成一条时在 1080px 内容宽下会折行，
          末行只剩「考。」两个字挂在下面，像排版事故。
        */}
        <p className="fine">
          成交价 = 最近一笔链上成交单价（BNB/颗），由官方市场成交事件读出。
          {block ? ` 区块 ${block.toLocaleString("zh-CN")}。` : ""}
        </p>
        {full && (
          <p className="fine">本期实际成本以链上 Campaign 挂单 / 成交记录为准，这里只作市价参考。</p>
        )}
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
