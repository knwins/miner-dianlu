/**
 * 官方电路市场。
 *
 * ══════════════════════════════════════════════════════════════
 * 这一页回答一个问题：**官方电路市场里到底有什么。**
 * ══════════════════════════════════════════════════════════════
 *
 * 官方电路市场只交易 **ERC721 电路 NFT**：TapeOut / Behemoth 各一个电路集合，
 * 每个处理器一张卡，卡身是该集合的当前最低挂单价（BNB/张）。
 *
 *   1. 官方电路市价（行情看板）—— 每个处理器一张卡：
 *      卡头 = 处理器名 / 每张算力 P（本期高亮）
 *      卡身 = 当前最低挂单价（大字号，页面的重点数据）
 *      卡脚 = 电路集合地址 / 工厂白名单状态
 *   2. 各期锁定的电路集合 —— 市场合约地址，以及每一期实际锁定的是哪个集合
 *
 * ── 两个容易混的概念，这里分开写清楚 ──
 *
 *   「可采购」= 有官方电路集合，能在电路市场挂单买到
 *   「可挖矿」= 官方 mining 合约 processorMultiplier > 0，投入矿池后有产出
 *
 * T-59：官方 Genesis CPU（可采购但 multiplier = 0、永远不出矿）已整体移除，
 * 本页现在只列**两个**都有挖矿产出资格的处理器。挖矿资格仍按数据驱动展示，
 * 将来官方新增无产出处理器时，页面会自动标注「无挖矿产出」而不是静默展示。
 *
 * ── 链上电路市场的作用范围 ──
 *
 * 市场合约（deployments.circuitMarket）接受任意 ERC721 电路集合的挂单，
 * 所以**市场层面本来就同时支持多套官方电路集合**。
 * 限制在**期次**层面：Campaign.circuits 开期后不可更换，
 * 一期只能锁定一个集合（= 一个处理器），开期时由工厂白名单把关。
 */
import { OfficialPricePanel } from "./OfficialPricePanel.jsx";
import { PROCESSORS, CIRCUITS, isMineable } from "./prices.js";
import { OFFICIAL_CIRCUIT_COLLECTIONS, OFFICIAL_CIRCUIT_FOR_PROCESSOR, processorFromCircuitContract } from "./tapeout.js";
import deployments from "./chain/deployments.json";
import { explorerAddress } from "./chain/config.js";

/** 紧凑地址（0x1234…abcd） */
function shortAddr(addr) {
  const a = String(addr || "");
  if (!a || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** 该处理器的电路集合 */
function circuitsOf(processor) {
  return CIRCUITS.filter((c) => c.processor === processor);
}

/**
 * @param {object} props
 * @param {object} props.official      电路市场快照（useOfficialPrices 的返回值）
 * @param {string} [props.processorId] 当前期次的处理器，用于标「本期」
 * @param {string[]} [props.allowedCircuits] 链上工厂电路白名单（地址数组）
 * @param {Array}  [props.campaigns]   链上期次摘要（新→旧）
 */
export function MarketPage({ official, processorId = null, allowedCircuits = [], campaigns = [] }) {
  const whitelist = new Set((allowedCircuits || []).map((a) => String(a).toLowerCase()));
  const marketAddr = deployments.circuitMarket || "";
  const rows = Array.isArray(campaigns) ? campaigns : [];

  /**
   * 注入到市价面板每个处理器分组下方的补充事实。
   * 面板本身不知道链上白名单，所以事实由本页提供。
   */
  const renderFacts = (pid) => {
    const partsAddr = OFFICIAL_CIRCUIT_FOR_PROCESSOR[pid]?.contract || circuitsOf(pid)[0]?.contract || "";
    const allowed = whitelist.size
      ? whitelist.has(String(partsAddr).toLowerCase())
      : null;
    /*
     * 只保留标题区没有的信息：电路集合地址 + 白名单状态。
     * 「挖矿资格」不再单独一项 —— 处理器标题旁已经显示 P = 6 或「无挖矿产出」，
     * 下面再写一遍「有（P = 6）」就是同一事实画两遍。
     */
    return (
      <ul className="market-page-facts">
        <li>
          <span>电路集合</span>
          <a className="mono" href={explorerAddress(partsAddr)} target="_blank" rel="noreferrer">
            {shortAddr(partsAddr)}
          </a>
        </li>
        <li>
          <span>官方集合</span>
          <a className="mono" href={explorerAddress(OFFICIAL_CIRCUIT_COLLECTIONS[pid])} target="_blank" rel="noreferrer">
            {shortAddr(OFFICIAL_CIRCUIT_COLLECTIONS[pid])}
          </a>
        </li>
        <li>
          <span>工厂白名单</span>
          <strong>
            {allowed === null
              ? "未读到"
              : allowed
                ? "已收录"
                : "未收录（开期不可选）"}
          </strong>
        </li>
      </ul>
    );
  };

  return (
    <section className="market-page">
      <header className="round-hero">
        <div className="round-hero-row">
          <div className="round-title">
            <span className="round-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <path d="M4 8h16M4 16h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="9" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="15" cy="16" r="2" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
            <h1>电路市场</h1>
          </div>
        </div>
        <p className="round-hero-lead">
          两个官方处理器的电路在同一个市场买卖，下面是各自当前最低挂单价（BNB / 张）。
          官方市场只有卖单侧，最低挂单价就是当前可成交价。每期在开期时锁定其中一套电路集合，不可更换。
        </p>
      </header>

      {/*
        唯一的市价模块：行情看板。
        每个处理器一张卡，价格是主角；地址 / 白名单由本页通过 renderFacts 注入到卡脚。
      */}
      <OfficialPricePanel
        official={official}
        processorId={processorId}
        full
        title="官方电路市价"
        renderFacts={renderFacts}
      />

      <article className="card market-page-card">
        <div className="card-header">
          <span>各期锁定的电路集合</span>
          {marketAddr ? (
            <a className="market-link" href={explorerAddress(marketAddr)} target="_blank" rel="noreferrer">
              电路市场合约 {shortAddr(marketAddr)} ↗
            </a>
          ) : null}
        </div>
        <div className="card-body">
          {rows.length ? (
            <table className="official-price-table market-page-table">
              <thead>
                <tr>
                  <th>期次</th>
                  <th>处理器</th>
                  <th>电路集合</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item, index) => {
                  const addr = item?.circuits || "";
                  // 期次摘要里已经带了 processor（由 adapter 从 circuits 反查），
                  // 这里直接用，不要自己再写一份反查表 —— 两份逻辑必然走偏。
                  const proc = item?.processor || processorFromCircuitContract(addr);
                  return (
                    <tr key={`${addr}-${index}`}>
                      <td><strong>第 {item?.id ?? index + 1} 期</strong></td>
                      <td>
                        {proc ? PROCESSORS[proc]?.name || proc : "—"}
                        {/*
                          按挖矿资格标注，不按处理器名硬编码。
                          T-59 之前开出去的期次可能锁在已移除的电路合约上，
                          那类期次仍在链上，必须照样明示「无产出」，
                          否则用户看到期次表却不知道它不出矿。
                        */}
                        {proc && !isMineable(proc) ? <em className="est-tag warn-tag">无产出</em> : null}
                      </td>
                      <td className="mono">{shortAddr(addr)}</td>
                      <td>{item?.status || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="fine">还没有期次。发布后才会在这里列出各期锁定的电路合约。</p>
          )}
          <p className="fine">
            每期用开期时锁定的电路集合，各期互不混同。
          </p>
        </div>
      </article>
    </section>
  );
}
