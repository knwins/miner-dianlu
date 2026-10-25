import { useEffect, useState } from "react";
import { readMarketTrades, MARKET_TRADE_LIMIT } from "./chain/client.js";
import { explorerAddress, explorerTx } from "./chain/config.js";
import { round4, shortAddress } from "./fixtures.js";

const TRADE_STATUS = {
  open: "等待成交",
  partial: "部分成交",
  filled: "已成交 · 待结算",
  settled: "已成交 · 已结算",
  cancelled: "已撤回",
};

function tradeStatusLabel(leg) {
  if (leg.status === "filled") return leg.side === "buy" ? "已成交" : "已成交 · 待结算";
  return TRADE_STATUS[leg.status] || leg.status;
}

function tradeStatusOf(side, qty, remaining, owed) {
  if (!(qty > 0)) return "";
  if (remaining == null) return "open";
  if (remaining > 0) return remaining < qty ? "partial" : "open";
  if (side === "sell" && !(owed > 0)) return "settled";
  return "filled";
}

/** 挂单成交状态：用于「晶体管数」项（挂出 / 成交两列）的视觉区分。
 *  - wait     等待成交（挂单中 / 部分成交，仍未全部吃完）
 *  - done     已成交（全部成交 / 待结算）
 *  - partial  部分成交（仍属等待成交，但已吃了一部分）
 *  - cancel   已撤回（既非等待也非成交） */
function legTradeState(leg) {
  if (leg.status === "cancelled") return "cancel";
  if (leg.status === "filled" || leg.status === "settled") return "done";
  if (leg.status === "partial") return "partial";
  return "wait";
}

/** 紧凑时间：10-19 23:12。列表窄，只保留月日与时分。 */
function formatStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 完整时间：2026/10/19 23:12:35。 */
function formatStampFull(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** 链上读不到市场时，用 book 里已有的买单余额拼出同样的表（卖出只有事件，没有挂单可拼）。 */
export function fallbackTradeLegs(f) {
  const rows = [];
  const push = (side, part, qty, remaining, price, id) => {
    if (!(qty > 0) || !id || String(id) === "0") return;
    const rem = remaining == null ? null : Number(remaining);
    const filled = rem == null ? null : Math.max(0, qty - rem);
    rows.push({
      side,
      part,
      orderId: String(id),
      orderQty: qty,
      price: Number(price) || 0,
      filled,
      remaining: rem,
      amount: filled == null ? null : filled * (Number(price) || 0),
      status: tradeStatusOf(side, qty, rem, f.marketOwed),
      placedAt: null,
      cancelAt: null,
      confirmedAt: null,
      filledAt: null,
    });
  };
  push("buy", "NAND", f.nandQty, f.nandRemaining, f.nandPrice, f.nandBidId);
  push("buy", "LATCH", f.latchQty, f.latchRemaining, f.latchPrice, f.latchBidId);
  return rows;
}

/** 市场订单 + 结算状态。refreshKey 变化时重读（挂单/成交/确认后由父组件传入）。 */
export function useMarketTrades(campaignAddr, refreshKey) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!campaignAddr) return () => { alive = false; };
    setFailed(false);
    readMarketTrades(campaignAddr)
      .then((next) => { if (alive) setData(next); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [campaignAddr, refreshKey]);

  return { data, failed };
}

function totalsOf(data, legs, fallbackRows) {
  if (data?.totals) return data.totals;
  const sum = (rows, key) => rows.reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
  const buy = legs.filter((l) => l.side === "buy");
  const sell = legs.filter((l) => l.side === "sell");
  return {
    buyQty: sum(buy, "orderQty"),
    buyFilled: sum(buy, "filled"),
    buySpent: sum(buy, "amount"),
    sellQty: sum(sell, "orderQty"),
    sellFilled: sum(sell, "filled"),
    sellProceeds: sum(sell, "amount"),
    owed: fallbackRows.marketOwed,
    partsNand: fallbackRows.partsNand,
    partsLatch: fallbackRows.partsLatch,
  };
}

/** 完整版：待执行页面的大卡片（汇总 + 明细表 + 链上流水）。 */
export function MarketTrades({ campaignAddr, refreshKey, fallbackRows }) {
  const { data, failed } = useMarketTrades(campaignAddr, refreshKey);
  const legs = data?.legs?.length ? data.legs : fallbackTradeLegs(fallbackRows);
  if (!legs.length && !data) return null;

  const totals = totalsOf(data, legs, fallbackRows);
  const events = Array.isArray(data?.events) ? data.events : null;
  const marketAddr = data?.market || "";
  const partsOnHand = data ? totals.partsNand + totals.partsLatch : Number(fallbackRows.partsOnHand) || 0;

  return (
    <article className="card market-card">
      <div className="card-header">
        <span>晶体管市场交易记录</span>
        {marketAddr ? (
          <a className="market-link" href={explorerAddress(marketAddr)} target="_blank" rel="noreferrer">
            {shortAddress(marketAddr)} ↗
          </a>
        ) : (
          <em className="fine">读取中…</em>
        )}
      </div>
      <div className="card-body">
        <ul className="trade-totals">
          <li>
            <span>买单成交</span>
            <strong>{totals.buyFilled} / {totals.buyQty} 颗</strong>
            <small>支出 {round4(totals.buySpent)} BNB</small>
          </li>
          <li>
            <span>卖出成交</span>
            <strong>{totals.sellFilled} 颗</strong>
            <small>回款 {round4(totals.sellProceeds)} BNB</small>
          </li>
          <li>
            <span>晶体管在手</span>
            <strong>{partsOnHand} 颗</strong>
            <small>{data ? `NAND ${totals.partsNand} · LATCH ${totals.partsLatch}` : "读取中…"}</small>
          </li>
          <li>
            <span>市场欠款</span>
            <strong style={Number(totals.owed) > 0 ? { color: "var(--color-primary)" } : undefined}>
              {round4(totals.owed)} BNB
            </strong>
            <small>{Number(totals.owed) > 0 ? "可提取到募集池" : "已结清"}</small>
          </li>
        </ul>

        {legs.length ? (
          <table className="trade-table">
            <thead>
              <tr>
                <th>方向</th>
                <th>晶体管</th>
                <th>单号</th>
                <th>挂价</th>
                <th>挂出</th>
                <th>成交</th>
                <th>金额</th>
                <th>时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <tr key={`${leg.side}-${leg.orderId}`}>
                  <td>
                    <b className={leg.side === "buy" ? "trade-side buy" : "trade-side sell"}>
                      {leg.side === "buy" ? "买入" : "卖出"}
                    </b>
                  </td>
                  <td>{leg.part}</td>
                  <td className="mono">#{leg.orderId}</td>
                  <td>{round4(leg.price)} BNB</td>
                  <td className={`qty-cell qty-${legTradeState(leg)}`} title="挂出晶体管数">
                    <span className="qty-dot" aria-hidden="true" />
                    {leg.orderQty == null ? "—" : `${leg.orderQty} 颗`}
                  </td>
                  <td className={`qty-cell qty-${legTradeState(leg)}`} title="成交晶体管数">
                    <span className="qty-dot" aria-hidden="true" />
                    {leg.filled == null ? "—" : `${leg.filled} 颗`}
                  </td>
                  <td>{leg.amount == null ? "—" : `${round4(leg.amount)} BNB`}</td>
                  <td
                    className="trade-time"
                    title={[
                      leg.placedAt ? `挂单 ${formatStampFull(leg.placedAt)}` : "",
                      leg.filledAt ? `成交 ${formatStampFull(leg.filledAt)}` : "",
                      leg.cancelAt ? `撤单 ${formatStampFull(leg.cancelAt)}` : "",
                    ].filter(Boolean).join(" · ") || undefined}
                  >
                    {leg.placedAt ? formatStamp(leg.placedAt) : "—"}
                  </td>
                  <td>
                    <em className={`trade-status is-${leg.status}`}>
                      {tradeStatusLabel(leg)}
                    </em>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="fine">还没有向晶体管市场挂过单。Owner 挂出买单后，这里会显示挂价与成交进度。</p>
        )}

        {events && events.length > 0 && (
          <details className="trade-log">
            <summary>链上事件 · 最近 {events.length} 条</summary>
            <ul>
              {events.map((evt, index) => (
                <li key={`${evt.txHash}-${index}`}>
                  <time>{evt.ts ? formatStampFull(evt.ts) : `区块 ${evt.blockNumber}`}</time>
                  <span>{eventText(evt)}</span>
                  {evt.txHash && explorerTx(evt.txHash) && (
                    <a href={explorerTx(evt.txHash)} target="_blank" rel="noreferrer">tx ↗</a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="fine">
          {failed
            ? "读取市场失败：节点暂不可用，先按本地状态展示。"
            : "成交进度读晶体管市场的 bids / owed；买单挂出、成交与撤回时间取市场合约的链上事件，卖出记录取本期的 TransistorsSold。"}
        </p>
      </div>
    </article>
  );
}

function eventText(evt) {
  const bnb = (wei) => `${round4(Number(wei) / 1e18)} BNB`;
  const at = evt.price ? ` @ ${bnb(evt.price)}` : "";
  if (evt.kind === "place") return `挂买单 #${evt.id} · ${evt.part || ""} ${evt.qty} 颗${at}`.replace("  ", " ");
  if (evt.kind === "fill") return `${evt.side === "buy" ? "买单" : "卖出"} #${evt.id} 成交 ${evt.qty} 颗${at}${evt.amount ? ` · ${bnb(evt.amount)}` : ""}`;
  if (evt.kind === "cancel") return `买单 #${evt.id} 撤回${evt.amount ? ` · 退回 ${bnb(evt.amount)}` : ""}`;
  if (evt.kind === "withdraw") return `提取市场款 ${bnb(evt.amount)}`;
  return "";
}

/**
 * 紧凑版：Owner 合约操作弹窗右栏的历史交易记录。
 * 记录**只来自市场合约的链上事件**（挂单 / 成交 / 撤单），不再按订单状态反推：
 * 状态能说「现在成交了几颗」，说不出「什么时候挂的、哪一笔成交的」。
 */
export function MarketTradePanel({ campaignAddr, refreshKey, fallbackRows, title = "历史交易记录" }) {
  const { data, failed } = useMarketTrades(campaignAddr, refreshKey);
  const legs = data?.legs?.length ? data.legs : fallbackTradeLegs(fallbackRows);
  const totals = totalsOf(data, legs, fallbackRows);
  const events = Array.isArray(data?.events) ? data.events : null;
  const marketAddr = data?.market || "";

  const allRecords = events && events.length
    ? [...events].reverse().map((evt, index) => ({
        key: `${evt.txHash || "evt"}-${index}`,
        side: evt.side,
        badge: evt.kind === "withdraw" ? "结算" : evt.side === "buy" ? "买入" : "卖出",
        title: eventText(evt),
        note: [
          evt.id ? `#${evt.id}` : "",
          evt.part || "",
          evt.ts ? "" : `区块 ${evt.blockNumber}`,
        ].filter(Boolean).join(" · "),
        ts: evt.ts || null,
        tsLabel: evt.kind === "fill" ? "成交" : evt.kind === "cancel" ? "撤单" : evt.kind === "withdraw" ? "提取" : "挂单",
        txHash: evt.txHash,
        tone: evt.kind === "fill" ? "fill" : evt.kind === "cancel" ? "cancelled" : evt.kind === "withdraw" ? "settled" : "open",
      }))
    : [];

  /** 窄栏只放最近几条：再往前翻是翻旧账，对当前决策没用（条数见 MARKET_TRADE_LIMIT） */
  const records = allRecords.slice(0, MARKET_TRADE_LIMIT);

  const partsOnHand = Number(fallbackRows.partsNand || 0) + Number(fallbackRows.partsLatch || 0);
  /*
   * 这里原本还有一行 stage（「挂单中 · 待成交」/「已到账 · 待入池」/「未挂单」）。
   * 那是子状态，生命周期条已经在当前步下面写过一次；同一屏两处讲同一件事，
   * 措辞还不一样（这里写「挂单中 · 待成交」，那边写「挂单中」）。
   * 面板自己的数字（买单 filled/qty、卖出、欠款）已经能说明进度，这一行删掉。
   */

  return (
    <article className="card trade-panel">
      <div className="card-header">
        <span>{title}<em className="fine trade-panel-sub">· 晶体管市场</em></span>
        {marketAddr ? (
          <a className="market-link" href={explorerAddress(marketAddr)} target="_blank" rel="noreferrer">
            {shortAddress(marketAddr)} ↗
          </a>
        ) : (
          <em className="fine">读取中…</em>
        )}
      </div>
      <div className="card-body">
        <div className="trade-panel-stats">
          <div>
            <span>买单</span>
            <strong>{totals.buyFilled}/{totals.buyQty}</strong>
            <small>{round4(totals.buySpent)} BNB</small>
          </div>
          <div>
            <span>卖出</span>
            <strong>{totals.sellFilled}/{totals.sellQty}</strong>
            <small>{round4(totals.sellProceeds)} BNB</small>
          </div>
          <div>
            <span>晶体管</span>
            <strong>{partsOnHand}</strong>
            <small>颗在手</small>
          </div>
          <div>
            <span>欠款</span>
            <strong style={Number(totals.owed) > 0 ? { color: "var(--color-primary)" } : undefined}>
              {round4(totals.owed)}
            </strong>
            <small>BNB</small>
          </div>
        </div>

        {records.length ? (
          <ol className="trade-feed">
            {records.map((row) => (
              <li key={row.key} className={`trade-feed-item is-${row.tone}`}>
                <b className={row.side === "buy" ? "trade-feed-badge buy" : row.side === "sell" ? "trade-feed-badge sell" : "trade-feed-badge"}>
                  {row.badge}
                </b>
                <div className="trade-feed-body">
                  <p>{row.title}</p>
                  <div className="trade-feed-meta">
                    <span>
                      {row.note}
                      {row.txHash && explorerTx(row.txHash) && (
                        <>
                          {row.note ? " · " : ""}
                          <a href={explorerTx(row.txHash)} target="_blank" rel="noreferrer">tx ↗</a>
                        </>
                      )}
                    </span>
                    {row.ts ? (
                      <time
                        className="trade-feed-time"
                        dateTime={new Date(row.ts).toISOString()}
                        title={row.tsLabel ? `${row.tsLabel}时间 ${formatStampFull(row.ts)}` : formatStampFull(row.ts)}
                      >
                        {formatStamp(row.ts)}
                      </time>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="flow-empty">
            {totals.buyQty > 0 || totals.sellQty > 0
              ? "链上事件暂未读取到；挂单进度见上方统计。"
              : "提交买单后，这里会按链上事件记录挂单与成交。"}
          </p>
        )}

        {allRecords.length > records.length && (
          <p className="trade-panel-more">仅显示最近 {MARKET_TRADE_LIMIT} 条</p>
        )}

        {/*
         * 只在真的异常时说话。
         * 正常态原本还有一句「读晶体管市场 bids / asks / owed，与确认到账、提取卖出款
         * 同一份状态」—— 那是实现说明，对 Owner 没有任何可操作信息，删掉。
         */}
        {failed ? (
          <p className="fine trade-panel-note">读取市场失败，先按合约已读状态展示。</p>
        ) : null}
      </div>
    </article>
  );
}
