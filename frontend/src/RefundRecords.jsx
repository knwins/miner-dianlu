import { useEffect, useMemo, useState } from "react";
import { readRefundRecords } from "./chain/client.js";
import { explorerAddress, explorerTx } from "./chain/config.js";
import { round4, shortAddress } from "./fixtures.js";

/**
 * 原路退款记录：读 Campaign 的 Refunded / RefundSendFailed 事件。
 * 读取失败（旧节点 / 旧合约）时退回调用方传入的汇总值，并注明只能看到累计数。
 */
export function RefundRecords({ campaignAddr, refreshKey, account, compact = false, fallback }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!campaignAddr) return () => { alive = false; };
    setFailed(false);
    readRefundRecords(campaignAddr)
      .then((next) => { if (alive) setData(next); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [campaignAddr, refreshKey]);

  const me = String(account || "").toLowerCase();
  const events = data?.events || [];
  const mine = me ? events.filter((row) => String(row.holder).toLowerCase() === me) : [];
  const totals = data?.totals || {
    totalRefunded: Number(fallback?.totalRefunded || 0),
    pool: Number(fallback?.pool || 0),
    count: 0,
    holders: 0,
    failed: 0,
  };
  const rows = useMemo(
    () => (mineOnly && me ? events.filter((row) => String(row.holder).toLowerCase() === me) : events),
    [events, mineOnly, me],
  );

  const eventMineSum = mine.reduce((acc, row) => acc + (row.failed ? 0 : row.amount), 0);
  // 合约的 refundedOf 是权威值；事件窗口没覆盖到的旧退款用 fallback 补足。
  const mineSum = Math.max(eventMineSum, Number(fallback?.mine || 0));
  const pool = Number(totals.pool) || 0;
  const listed = Number(totals.listedSum || 0);
  const consistent = Math.abs(listed - Number(totals.totalRefunded || 0)) < 0.0000001;

  return (
    <article className={compact ? "card refund-panel" : "card refund-card"}>
      <div className="card-header">
        <span>原路退款记录</span>
        {campaignAddr ? (
          <a className="market-link" href={explorerAddress(campaignAddr)} target="_blank" rel="noreferrer">
            {shortAddress(campaignAddr)} ↗
          </a>
        ) : null}
      </div>
      <div className="card-body">
        {!compact && (
          <ul className="trade-totals refund-totals">
            <li>
              <span>累计已退</span>
              <strong>{round4(totals.totalRefunded || 0)} BNB</strong>
              <small>{totals.count ? `${totals.count} 笔 · ${totals.holders} 个地址` : "尚无退款"}</small>
            </li>
            <li>
              <span>我的已退</span>
              <strong style={mineSum > 0 ? { color: "var(--color-success)" } : undefined}>
                {round4(mineSum)} BNB
              </strong>
              <small>{me ? (mine.length ? `${mine.length} 笔` : "本钱包还没有退款") : "未连接钱包"}</small>
            </li>
            <li>
              <span>合约剩余池</span>
              <strong>{round4(pool)} BNB</strong>
              <small>{pool > 0 ? "还有未退完的募集款" : "已全部退完"}</small>
            </li>
            <li>
              <span>核对</span>
              <strong className={consistent ? undefined : "refund-mismatch"}>
                {events.length ? (consistent ? "明细一致" : "明细待补") : "暂无明细"}
              </strong>
              <small>{totals.failed ? `${totals.failed} 笔转账失败` : "按认筹地址原路退回"}</small>
            </li>
          </ul>
        )}

        {compact && (
          <p className="refund-compact-line">
            累计已退 <strong>{round4(totals.totalRefunded || 0)} BNB</strong>
            {totals.count ? ` · ${totals.count} 笔 / ${totals.holders} 个地址` : ""}
            {mineSum > 0 ? ` · 我 ${round4(mineSum)} BNB` : ""}
          </p>
        )}

        {events.length > 0 && me && mine.length !== events.length && (
          <div className="refund-filter">
            <button
              type="button"
              className={mineOnly ? "desk-tab is-on" : "desk-tab"}
              onClick={() => setMineOnly((value) => !value)}
            >
              {mineOnly ? "显示全部" : "只看我的"}
            </button>
          </div>
        )}

        {failed || (data && !data.scanned) ? (
          <p className="fine">
            节点不支持查询这期的事件日志，只能看到累计已退 {round4(totals.totalRefunded || 0)} BNB。
            换用支持 `eth_getLogs` 历史区间的节点后可显示逐笔记录。
          </p>
        ) : rows.length > 0 ? (
          <ul className="refund-list">
            {rows.map((row) => {
              const isMine = me && String(row.holder).toLowerCase() === me;
              return (
                <li key={`${row.txHash}-${row.blockNumber}-${row.holder}`} className={isMine ? "is-mine" : undefined}>
                  <span className="refund-holder">
                    {isMine ? <b>你</b> : null}
                    <em className="mono">{shortAddress(row.holder)}</em>
                    {row.failed ? <i className="refund-failed">转账失败</i> : null}
                  </span>
                  <strong className="refund-amount">{round4(row.amount)} BNB</strong>
                  <span className="refund-time">{row.ts ? new Date(row.ts).toLocaleString("zh-CN") : `区块 ${row.blockNumber}`}</span>
                  {explorerTx(row.txHash) ? (
                    <a href={explorerTx(row.txHash)} target="_blank" rel="noreferrer">tx ↗</a>
                  ) : <span />}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="fine">
            {data ? "还没有原路退款记录。持份人在「我的资产」发起退款后，这里会按时间列出每一笔。" : "正在读取退款记录…"}
          </p>
        )}

        {!compact && (
          <p className="fine">
            退款直接读 Campaign 的 `Refunded` 事件，与「我的资产」里的原路退款是同一份链上记录；
            `RefundSendFailed` 会单独标出，合约仍保留这笔待退金额。
          </p>
        )}
      </div>
    </article>
  );
}
