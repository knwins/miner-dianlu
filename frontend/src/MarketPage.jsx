/**
 * 官方材料市场。
 *
 * ══════════════════════════════════════════════════════════════
 * 这一页回答一个问题：**官方材料市场里到底有什么。**
 * ══════════════════════════════════════════════════════════════
 *
 * 之前的布局有真实缺口：官方元件市价面板只有 compact 模式在用
 * （只显示「当前期次那一组」），所以官方处理器
 * （TapeOut / Behemoth）在 UI 上**从来没有同时出现过**。
 * 用户问「材料市场支持哪几个官方处理器」，页面上答不出来。
 *
 * 现在这一页给出完整视图：
 *
 *   1. 官方处理器与元件市价（合并模块）—— 每个处理器一节：
 *      处理器名 / 算力 P / 元件 tokenId 与买价、成交价、买量 / CPU 与元件合约地址 / 挖矿资格 / 工厂白名单状态
 *   2. 链上材料市场 —— 市场合约地址，以及每一期实际锁定的是哪个元件合约
 *
 * ── 关于「两个模块合并成一个」──
 * 之前这里有两个卡片：①「官方元件最新价」②「官方处理器对照」。
 * 两者都按处理器分组、都渲染同一张 NAND/LATCH 价格表 —— 同一份数据画两遍，
 * 用户得上下滚动才能把「价格」和「这个处理器的地址/资格/白名单」对上。
 * 现在合并成**一个**卡片，事实信息（地址、资格、白名单）直接挂在对应处理器的价格表下方。
 *
 * ── 两个容易混的概念，这里分开写清楚 ──
 *
 *   「可采购」= 有官方元件合约，能在材料市场挂单买到
 *   「可挖矿」= 官方 mining 合约 processorMultiplier > 0，投入矿池后有产出
 *
 * T-59：官方 Genesis CPU（可采购但 multiplier = 0、永远不出矿）已整体移除，
 * 本页现在只列**两个**都有挖矿产出资格的处理器。挖矿资格仍按数据驱动展示，
 * 将来官方新增无产出处理器时，页面会自动标注「无挖矿产出」而不是静默展示。
 *
 * ── 链上材料市场的作用范围 ──
 *
 * 市场合约（deployments.materialMarket）的 placeBid 接受任意 transistors 合约地址，
 * 所以**市场层面本来就同时支持多套官方元件合约**。
 * 限制在**期次**层面：Campaign.transistors 是 immutable，
 * 一期只能锁定一个元件合约（= 一个处理器），开期时由工厂白名单把关。
 */
import { OfficialPricePanel } from "./OfficialPricePanel.jsx";
import { PROCESSORS, PROCESSOR_IDS, TRANSISTORS, isMineable, processorScale } from "./prices.js";
import { OFFICIAL_CPUS, OFFICIAL_PARTS_FOR_PROCESSOR, processorFromPartsContract } from "./tapeout.js";
import deployments from "./chain/deployments.json";
import { explorerAddress } from "./chain/config.js";

/** 紧凑地址（0x1234…abcd） */
function shortAddr(addr) {
  const a = String(addr || "");
  if (!a || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** 该处理器的 NAND / LATCH 元件型号 */
function partsOf(processor) {
  return TRANSISTORS.filter((t) => t.processor === processor);
}

/**
 * @param {object} props
 * @param {object} props.official      官方市场快照（useOfficialPrices 的返回值）
 * @param {string} [props.processorId] 当前期次的处理器，用于标「本期」
 * @param {string[]} [props.allowedParts] 链上工厂元件白名单（地址数组）
 * @param {Array}  [props.campaigns]   链上期次摘要（新→旧）
 */
export function MarketPage({ official, processorId = null, allowedParts = [], campaigns = [] }) {
  const whitelist = new Set((allowedParts || []).map((a) => String(a).toLowerCase()));
  const marketAddr = deployments.materialMarket || deployments.minter || "";
  const rows = Array.isArray(campaigns) ? campaigns : [];

  /**
   * 注入到市价面板每个处理器分组下方的补充事实。
   * 面板本身不知道链上白名单，所以事实由本页提供。
   */
  const renderFacts = (pid) => {
    const partsAddr = OFFICIAL_PARTS_FOR_PROCESSOR[pid]?.contract || partsOf(pid)[0]?.contract || "";
    const allowed = whitelist.size
      ? whitelist.has(String(partsAddr).toLowerCase())
      : null;
    const mineable = isMineable(pid);
    return (
      <ul className="market-page-facts">
        <li>
          <span>CPU</span>
          <a className="mono" href={explorerAddress(OFFICIAL_CPUS[pid])} target="_blank" rel="noreferrer">
            {shortAddr(OFFICIAL_CPUS[pid])}
          </a>
        </li>
        <li>
          <span>元件合约</span>
          <a className="mono" href={explorerAddress(partsAddr)} target="_blank" rel="noreferrer">
            {shortAddr(partsAddr)}
          </a>
        </li>
        <li>
          <span>挖矿资格</span>
          <strong className={mineable ? "" : "market-page-nomine"}>
            {mineable ? `有（P = ${processorScale(pid)}）` : "无（官方 multiplier = 0）"}
          </strong>
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
            <h1>材料市场</h1>
          </div>
        </div>
        <p className="round-hero-lead">
          官方二级市场同时支持官方处理器：TapeOut、Behemoth（两者均有挖矿产出资格）。
          市场合约的挂单接受任意元件合约地址，所以两套元件都在同一个市场里买卖；
          每一期只锁定其中一套（开期时写入，不可更换）。
        </p>
      </header>

      {/*
        合并后的唯一模块：官方处理器 + 元件市价。
        完整对照模式（full）：全部处理器 + tokenId 列 + 处理器简介 + 下方事实。
      */}
      <OfficialPricePanel
        official={official}
        processorId={processorId}
        full
        title="官方处理器与元件市价"
        badge={<span className="stat-label">{PROCESSOR_IDS.length} 个</span>}
        renderFacts={renderFacts}
      />

      <article className="card market-page-card">
        <div className="card-header">
          <span>链上材料市场</span>
          {marketAddr ? (
            <a className="market-link" href={explorerAddress(marketAddr)} target="_blank" rel="noreferrer">
              {shortAddr(marketAddr)} ↗
            </a>
          ) : null}
        </div>
        <div className="card-body">
          {marketAddr ? (
            <p className="fine">
              市场合约 <a className="mono" href={explorerAddress(marketAddr)} target="_blank" rel="noreferrer">{marketAddr}</a>
              ：挂单 placeBid（买单）与挂卖单，撤单 cancelBid，成交看 bids(id).remaining。
              挂单时传入的是**期次锁定的那个元件合约地址**，所以市场里各套元件各走各的合约。
            </p>
          ) : (
            <p className="fine">未读到材料市场合约地址。</p>
          )}

          {rows.length ? (
            <table className="official-price-table">
              <thead>
                <tr>
                  <th>期次</th>
                  <th>元件合约</th>
                  <th>处理器</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item, index) => {
                  const addr = item?.transistors || "";
                  // 期次摘要里已经带了 processor（由 adapter 从 transistors 反查），
                  // 这里直接用，不要自己再写一份反查表 —— 两份逻辑必然走偏。
                  const proc = item?.processor || processorFromPartsContract(addr);
                  return (
                    <tr key={`${addr}-${index}`}>
                      <td><strong>第 {item?.id ?? index + 1} 期</strong></td>
                      <td className="mono">{shortAddr(addr)}</td>
                      <td>
                        {proc
                          ? PROCESSORS[proc]?.name || proc
                          : "—"}
                        {/*
                          按挖矿资格标注，不按处理器名硬编码。
                          T-59 之前开出去的期次可能锁在已移除的元件合约上，
                          那类期次仍在链上，必须照样明示「无产出」，
                          否则用户看到期次表却不知道它不出矿。
                        */}
                        {proc && !isMineable(proc) ? <em className="est-tag warn-tag">无产出</em> : null}
                      </td>
                      <td>{item?.status || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="fine">还没有期次。发布后才会在这里列出各期锁定的元件合约。</p>
          )}
        </div>
      </article>
    </section>
  );
}
