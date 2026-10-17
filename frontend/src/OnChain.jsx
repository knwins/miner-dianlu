import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IS_CONFIGURED, CHAIN_ID, NETWORK, CAMPAIGN_ADDRESS, BEM_ADDRESS, EXPLORER,
  SCENE_LABEL, PHASE_LABEL, explorerAddress, explorerTx,
} from "./chain/config.js";
import {
  hasInjected, connectWallet, readState, send, tx, formatEther, parseEther,
} from "./chain/client.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const fmt = (v, d = 4) => {
  try { return Number(formatEther(v)).toFixed(d).replace(/\.?0+$/, "") || "0"; }
  catch { return String(v); }
};
const fmtTime = (sec) => (sec > 0 ? new Date(sec * 1000).toLocaleString("zh-CN") : "—");

export default function OnChainPage() {
  const [wallet, setWallet] = useState(null); // { signer, account }
  const [state, setState] = useState(null);
  const [bnb, setBnb] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [logs, setLogs] = useState([]);
  const [form, setForm] = useState({ buyCount: 1, listCount: 1, listPrice: "0.02", takeId: 0, takeCount: 1, est: "408", capped: false, trCount: 100, trPrice: "0.005", tapeout: "netlist-v1" });

  const account = wallet?.account || null;
  const isOwner = useMemo(() => state && account && state.owner?.toLowerCase() === account.toLowerCase(), [state, account]);

  const refresh = useCallback(async () => {
    if (!IS_CONFIGURED) return;
    try {
      const s = await readState(account);
      setState(s);
      if (account && window.ethereum) {
        const { BrowserProvider } = await import("ethers");
        const p = new BrowserProvider(window.ethereum);
        setBnb(await p.getBalance(account));
      }
      setErr("");
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, [account]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 12000); return () => clearInterval(t); }, [refresh]);

  async function onConnect() {
    setErr("");
    try {
      const w = await connectWallet();
      setWallet(w);
    } catch (e) { setErr(e.message || String(e)); }
  }

  async function run(label, fn) {
    if (!wallet) { setErr("请先连接钱包"); return; }
    setBusy(label); setErr("");
    try {
      const { hash } = await send(fn(wallet.signer));
      setLogs((l) => [{ label, hash, ok: true }, ...l]);
      await refresh();
    } catch (e) {
      setErr(e.message || String(e));
      setLogs((l) => [{ label, hash: "", ok: false, msg: e.message }, ...l]);
    } finally { setBusy(""); }
  }

  if (!IS_CONFIGURED) {
    return (
      <section>
        <header className="page-header"><div><h1>链上调试</h1><p className="page-subtitle">对接 BSC 测试网已部署的 Campaign 合约。</p></div></header>
        <div className="empty">
          <p>尚未配置 Campaign 地址。</p>
          <p className="fine">先在 <code>contracts/</code> 部署：填写 <code>.env</code> 的 <code>DEPLOYER_PRIVATE_KEY</code>，运行部署脚本，地址会自动写入 <code>frontend/src/chain/deployments.json</code>。</p>
        </div>
      </section>
    );
  }

  const s = state;
  return (
    <section>
      <header className="page-header">
        <div><h1>链上调试</h1><p className="page-subtitle">{NETWORK.name} · chainId {CHAIN_ID} · 实时读写 Campaign</p></div>
        <span className={`badge tone-live`}>{s ? SCENE_LABEL[s.scene] : "加载中"}</span>
      </header>

      <article className="card">
        <div className="card-header">合约与钱包</div>
        <div className="card-body">
          <ul className="bill">
            <li><span>Campaign</span><strong><a href={explorerAddress(CAMPAIGN_ADDRESS)} target="_blank" rel="noreferrer">{short(CAMPAIGN_ADDRESS)}</a></strong></li>
            <li><span>BEM 代币</span><strong><a href={explorerAddress(BEM_ADDRESS)} target="_blank" rel="noreferrer">{short(BEM_ADDRESS)}</a></strong></li>
            <li><span>Owner</span><strong>{short(s?.owner)}</strong></li>
            <li><span>我的钱包</span><strong>{account ? `${short(account)}${isOwner ? " · Owner" : ""}` : "未连接"}</strong></li>
            <li><span>我的 tBNB</span><strong>{bnb !== null ? `${fmt(bnb)} tBNB` : "—"}</strong></li>
          </ul>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {!account && <button className="btn btn-primary" type="button" onClick={onConnect} disabled={!hasInjected()}>{hasInjected() ? "连接钱包" : "未检测到钱包"}</button>}
            <button className="btn btn-inline" type="button" onClick={refresh}>刷新</button>
          </div>
          {err && <div className="issues" style={{ marginTop: 10 }}><p>{err}</p></div>}
        </div>
      </article>

      {s && (
        <>
          <div className="stat-grid">
            <article className="stat-card accent"><div className="stat-label">已售 / 总份</div><div className="stat-value">{String(s.sold)} / {String(s.totalShares)}</div></article>
            <article className="stat-card"><div className="stat-label">每份价格</div><div className="stat-value">{fmt(s.sharePriceBnb)} BNB</div></article>
            <article className="stat-card"><div className="stat-label">合约托管 BNB</div><div className="stat-value">{fmt(s.raisedBnb)}</div></article>
            <article className="stat-card"><div className="stat-label">实际日产</div><div className="stat-value">{fmt(s.dailyBem, 6)} BEM</div></article>
            <article className="stat-card"><div className="stat-label">已分发轮数</div><div className="stat-value">{String(s.harvestCount)}</div></article>
            <article className="stat-card"><div className="stat-label">执行子态</div><div className="stat-value">{PHASE_LABEL[s.phase]}</div></article>
          </div>

          {s.self && (
            <article className="card">
              <div className="card-header">我的持仓</div>
              <div className="card-body">
                <ul className="bill">
                  <li><span>可用份额</span><strong>{String(s.self.shares)}</strong></li>
                  <li><span>挂单锁定</span><strong>{String(s.self.escrow)}</strong></li>
                  <li><span>可领 BEM</span><strong>{fmt(s.self.pending, 6)}</strong></li>
                  <li><span>已领 BEM</span><strong>{fmt(s.self.claimed, 6)}</strong></li>
                  <li><span>我的 BEM 余额</span><strong>{fmt(s.self.bemBalance, 6)}</strong></li>
                  <li><span>已退 BNB</span><strong>{fmt(s.self.refunded)}</strong></li>
                </ul>
              </div>
            </article>
          )}

          {/* 操作区：按场景/子态/身份显示 */}
          <article className="card">
            <div className="card-header">操作</div>
            <div className="card-body">
              {s.scene === 0 && (
                <div className="form-grid cols-2">
                  <label className="field"><span>认购份数</span><input inputMode="numeric" value={form.buyCount} onChange={(e) => setForm({ ...form, buyCount: e.target.value })} /></label>
                  <div className="field"><span>&nbsp;</span>
                    <button className="btn btn-primary" type="button" disabled={busy || !account}
                      onClick={() => run("认购", (sg) => tx.buy(sg, BigInt(form.buyCount), parseEther(fmt(s.sharePriceBnb)) * BigInt(form.buyCount)))}>
                      {busy === "认购" ? "认购中…" : `认购 ${form.buyCount} 份（${fmt(s.sharePriceBnb) * Number(form.buyCount)} BNB）`}
                    </button>
                  </div>
                  {Date.now() / 1000 > s.fundingDeadline && s.sold < s.totalShares && (
                    <div className="field wide"><button className="btn btn-inline" type="button" disabled={busy || !account} onClick={() => run("退款", (sg) => tx.refund(sg))}>募集超时·原路退款</button></div>
                  )}
                </div>
              )}

              {s.scene === 1 && (
                <div>
                  <p className="fine">待执行 · {PHASE_LABEL[s.phase]} · 售罄于 {fmtTime(s.soldOutAt)} · 观察期 {s.executeDelay / 3600}h · 锁价 {s.priceLock > 0 ? `${fmt(s.priceLock)} BNB/颗 × ${s.transistorCount}` : "未锁"}</p>
                  {s.executionFailed && <p className="fine" style={{ color: "var(--color-danger)" }}>本期已判流片失败，可原路退款或待降价由 Owner 重试。</p>}
                  {isOwner && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      {s.phase === 1 && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("setPlan", (sg) => tx.setPlan(sg, BigInt(form.est), form.capped, BigInt(form.trCount)))}>setPlan</button>}
                      {s.phase === 1 && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("挂单", (sg) => tx.placeTransistorOrder(sg, BigInt(form.trCount), parseEther(form.trPrice)))}>挂单买晶体管</button>}
                      {s.phase === 2 && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("确认到账", (sg) => tx.confirmTransistors(sg))}>确认成交到账</button>}
                      {s.phase === 2 && <button className="btn btn-inline" type="button" disabled={busy} onClick={() => run("取消挂单", (sg) => tx.cancelTransistorOrder(sg))}>取消挂单</button>}
                      {s.phase === 3 && Date.now() / 1000 >= s.soldOutAt + s.executeDelay && (
                        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("execute", (sg) => tx.execute(sg, new TextEncoder().encode(form.tapeout), "0x12345678"))}>execute 流片开矿</button>
                      )}
                      {s.phase === 3 && Date.now() / 1000 < s.soldOutAt + s.executeDelay && <span className="fine">观察期未满，{(s.soldOutAt + s.executeDelay) - Math.floor(Date.now() / 1000)}s 后可执行</span>}
                    </div>
                  )}
                  {s.executionFailed && s.self && s.self.shares > 0 && (
                    <button className="btn btn-inline" type="button" style={{ marginTop: 8 }} disabled={busy || !account} onClick={() => run("退款", (sg) => tx.refund(sg))}>流片失败·原路退款</button>
                  )}
                </div>
              )}

              {s.scene === 2 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-primary" type="button" disabled={busy || !account} onClick={() => run("harvest", (sg) => tx.harvest(sg))}>全网分发 harvest</button>
                  <button className="btn btn-primary" type="button" disabled={busy || !account} onClick={() => run("claim", (sg) => tx.claim(sg))}>领取我的 BEM</button>
                </div>
              )}
            </div>
          </article>

          {s.scene === 2 && (
            <>
              <article className="card">
                <div className="card-header">发布转让挂单</div>
                <div className="card-body">
                  <div className="form-grid cols-2">
                    <label className="field"><span>份数</span><input inputMode="numeric" value={form.listCount} onChange={(e) => setForm({ ...form, listCount: e.target.value })} /></label>
                    <label className="field"><span>单价 BNB/份</span><input inputMode="decimal" value={form.listPrice} onChange={(e) => setForm({ ...form, listPrice: e.target.value })} /></label>
                  </div>
                  <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} disabled={busy || !account} onClick={() => run("挂牌", (sg) => tx.listShares(sg, BigInt(form.listCount), parseEther(form.listPrice)))}>挂牌</button>
                </div>
              </article>

              <article className="card">
                <div className="card-header">转让市场 · {s.listings.filter((l) => l.open).length} 个开放挂单</div>
                <div className="card-body table-wrap">
                  <table>
                    <thead><tr><th>ID</th><th>卖方</th><th>份数</th><th>单价 BNB</th><th>状态</th><th></th></tr></thead>
                    <tbody>
                      {s.listings.map((l) => (
                        <tr key={l.id}>
                          <td>L{l.id}</td><td>{short(l.seller)}</td><td>{String(l.shares)}</td><td>{fmt(l.priceBnbPerShare)}</td>
                          <td>{l.open ? "开放" : "已成交/撤单"}</td>
                          <td>
                            {l.open && account && l.seller.toLowerCase() !== account.toLowerCase() && (
                              <button className="btn btn-inline" type="button" disabled={busy} onClick={() => run("接收", (sg) => tx.takeListing(sg, l.id, BigInt(form.takeCount), l.priceBnbPerShare * BigInt(form.takeCount)))}>接收 {form.takeCount} 份</button>
                            )}
                            {l.open && account && l.seller.toLowerCase() === account.toLowerCase() && (
                              <button className="btn btn-inline" type="button" disabled={busy} onClick={() => run("撤单", (sg) => tx.cancelListing(sg, l.id))}>撤单</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </>
          )}

          <article className="card">
            <div className="card-header">交易记录 · {logs.length}</div>
            <div className="card-body table-wrap">
              <table>
                <thead><tr><th>操作</th><th>结果</th><th>交易</th></tr></thead>
                <tbody>
                  {logs.map((l, i) => (
                    <tr key={i}>
                      <td>{l.label}</td>
                      <td><span className={`badge ${l.ok ? "tone-live" : "tone-back"}`}>{l.ok ? "成功" : "失败"}</span> {l.msg || ""}</td>
                      <td>{l.hash ? <a href={explorerTx(l.hash)} target="_blank" rel="noreferrer">{short(l.hash)}</a> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </>
      )}
    </section>
  );
}
