import { SCENE } from "./roundState.js";
import { shortAddress, formatBemClaimable } from "./fixtures.js";

/**
 * 服务费领取页。
 *
 * 口径（与 Campaign 一致）：
 *   - 官方 PoD BEM 毛产出在 claimMiningRewards / stopMining 时按费率计提；
 *   - 分成地址连接钱包 → `claimFee()` 自领 BEM；
 *   - 认筹 BNB 永不收服务费。
 */
function formatFeeBem(n) {
  const s = formatBemClaimable(n);
  return s || "0";
}

export default function FeeClaims({
  pending,
  pendingTarget = "",
  connected,
  usingChain,
  feeClaims,
  feeClaimsLoading,
  round,
  account,
  onClaimFee,
  onOpenPeriod,
  onConnect,
}) {
  const simRows = (() => {
    if (usingChain || !connected || !account) return [];
    const shares = Array.isArray(round?.feeShares) ? round.feeShares : [];
    const me = String(account).toLowerCase();
    const hit = shares.find((r) => String(r.address || "").toLowerCase() === me);
    if (!hit) return [];
    const pct = Number(hit.sharePercent ?? hit.bps ?? 0);
    const shareBps = pct > 100 ? pct : Math.round(pct * 100);
    return [{
      id: round.id,
      address: round.contract || "",
      scene: "mining",
      sceneLabel: SCENE.mining.label,
      serviceFeeBps: Number(round.serviceFeeBps ?? (Number(round.feePercent) || 0) * 100) || 0,
      serviceFeeSet: Boolean(round.serviceFeeSet ?? round.feePercent),
      isRecipient: true,
      myShareBps: shareBps,
      pendingFeeBem: 0,
      _sim: true,
    }];
  })();

  const rows = usingChain ? (feeClaims || []) : simRows;
  const claimable = rows.filter((r) => Number(r.pendingFeeBem) > 0);
  const pendingSum = claimable.reduce((s, r) => s + Number(r.pendingFeeBem || 0), 0);

  return (
    <section>
      <header className="round-hero">
        <div className="round-hero-row">
          <div className="round-title">
            <span className="round-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <path d="M6 8h12M6 12h12M6 16h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
            <h1>领取服务费</h1>
          </div>
        </div>
        <p className="round-hero-lead">
          官方挖矿 BEM 计提的服务费，分成地址自领。认筹 BNB 不收。
        </p>
      </header>

      {!connected && (
        <div className="empty">
          <p>请连接分成地址钱包。</p>
          <button className="btn btn-primary" type="button" onClick={onConnect}>
            连接钱包
          </button>
        </div>
      )}

      <div className="holding-grid cols-3">
        <article className="stat-card accent">
          <div className="stat-label">相关期次</div>
          <div className="stat-value">{connected ? `${rows.length} 期` : "—"}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">可领期次</div>
          <div className="stat-value">{connected ? `${claimable.length} 期` : "—"}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">待领合计</div>
          <div className="stat-value">{connected ? `${formatFeeBem(pendingSum)} BEM` : "—"}</div>
        </article>
      </div>

      <article className="card">
        <div className="card-header">待领明细</div>
        <div className="card-body table-wrap">
          {!connected ? (
            <p className="fine">连接后只显示你参与分成的期次。</p>
          ) : feeClaimsLoading && rows.length === 0 ? (
            <p className="fine">正在读取…</p>
          ) : rows.length === 0 ? (
            <p className="fine">当前钱包不在分成表中。开期时写入的地址可在此领取。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>期次</th>
                  <th>状态</th>
                  <th>费率</th>
                  <th>我的分成</th>
                  <th>待领</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const feePct = Number(row.serviceFeeBps || 0) / 100;
                  const sharePct = Number(row.myShareBps || 0) / 100;
                  const due = Number(row.pendingFeeBem || 0);
                  // 必须带本期地址：claimFee 签到对应 Campaign，不能落到当前选中的别的期。
                  const canClaim = connected && due > 0 && Boolean(row.address) && !pending;
                  return (
                    <tr key={row.address || `fee-${row.id}`}>
                      <td>
                        第 {row.id} 期
                        {row.address ? (
                          <div className="fine mono">{shortAddress(row.address)}</div>
                        ) : null}
                      </td>
                      <td>{row.sceneLabel || "—"}</td>
                      <td>
                        {row.serviceFeeSet
                          ? (feePct > 0 ? `${feePct}%` : "0%（已锁定）")
                          : "未设定"}
                      </td>
                      <td>
                        {row.isRecipient
                          ? (sharePct > 0 ? `${sharePct}%` : "—")
                          : <span className="muted-value">非分成</span>}
                      </td>
                      <td>{due > 0 ? `${formatFeeBem(due)} BEM` : (row._sim ? "模拟无入账" : "—")}</td>
                      <td>
                        <div className="actions assets-actions">
                          {row.address ? (
                            <button
                              className="btn btn-inline"
                              type="button"
                              onClick={() => onOpenPeriod?.(row.address)}
                            >
                              打开
                            </button>
                          ) : null}
                          {canClaim ? (
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={() => onClaimFee(row.address)}
                              title="领取 BEM 服务费"
                            >
                              {pending === "claimFee"
                                && String(pendingTarget || "").toLowerCase() === String(row.address || "").toLowerCase()
                                ? "领取中…"
                                : `领取 ${formatFeeBem(due)}`}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </article>
    </section>
  );
}
