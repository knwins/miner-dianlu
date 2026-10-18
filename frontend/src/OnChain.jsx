import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IS_CONFIGURED, CHAIN_ID, NETWORK, BEM_ADDRESS, EXPLORER,
  SCENE_LABEL, PHASE_LABEL, explorerAddress, explorerTx,
} from "./chain/config.js";
import {
  hasInjected, connectWallet, readState, send, tx, formatEther, parseEther,
  getCampaignAddress, getRawProvider,
} from "./chain/client.js";
import { discoverWallets } from "./chain/wallets.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const fmt = (v, d = 4) => {
  try { return Number(formatEther(v)).toFixed(d); }
  catch { return String(v); }
};
/** BEM 金额统一 4 位小数 */
const fmtBem = (v) => fmt(v, 4);
const fmtTime = (sec) => (sec > 0 ? new Date(sec * 1000).toLocaleString("zh-CN") : "—");

export default function OnChainPage({ embedded = false }) {
  const [wallet, setWallet] = useState(null); // { signer, account }
  const [state, setState] = useState(null);
  const [bnb, setBnb] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [hint, setHint] = useState("");
  useEffect(() => {
    if (!hint) return undefined;
    const timer = setTimeout(() => setHint(""), 3000);
    return () => clearTimeout(timer);
  }, [hint]);
  const [logs, setLogs] = useState([]);
  const [form, setForm] = useState({ buyCount: 1, listCount: 1, listPrice: "0.02", takeId: 0, takeCount: 1, est: "408", capped: false, trCount: 100, trPrice: "0.005", tapeout: "netlist-v1" });

  const account = wallet?.account || null;
  const isOwner = useMemo(() => state && account && state.owner?.toLowerCase() === account.toLowerCase(), [state, account]);

  const refresh = useCallback(async () => {
    if (!IS_CONFIGURED) return;
    try {
      const s = await readState(account);
      setState(s);
      const raw = getRawProvider();
      if (account && raw) {
        const { BrowserProvider } = await import("ethers");
        const p = new BrowserProvider(raw);
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
      const choices = await discoverWallets();
      const injected = choices.filter((item) => item.kind === "injected");
      const pick = injected.find((item) => item.walletId === "tokenpocket") || injected[0];
      if (!pick) throw new Error("未检测到钱包。手机请用 TokenPocket 打开本页");
      const w = await connectWallet(pick.provider);
      setWallet(w);
    } catch (e) { setErr(e.message || String(e)); }
  }

  async function run(label, fn) {
    if (!wallet) { setErr("请先连接钱包"); return; }
    setBusy(label);
    setErr("");
    setHint(`请在钱包中确认「${label}」。弹出窗口后点确认，不要关闭本页。`);
    try {
      const { hash } = await send(fn(wallet.signer), () => {
        setHint(`钱包已确认「${label}」，正在等待链上入块。`);
      });
      setHint("");
      setLogs((l) => [{ label, hash, ok: true }, ...l]);
      await refresh();
    } catch (e) {
      setHint("");
      setErr(e.message || String(e));
      setLogs((l) => [{ label, hash: "", ok: false, msg: e.message }, ...l]);
    } finally { setBusy(""); }
  }

  if (!IS_CONFIGURED) {
    return (
      <section>
        {!embedded && <header className="page-header"><div><h1>链上调试</h1><p className="page-subtitle">对接 BSC 测试网已部署的 Campaign 合约。</p></div></header>}
        <div className="empty">
          <p>尚未配置 Campaign 地址。</p>
          <p className="fine">先在 <code>contracts/</code> 部署：填写 <code>.env</code> 的 <code>DEPLOYER_PRIVATE_KEY</code>，运行部署脚本，地址会自动写入 <code>frontend/src/chain/deployments.json</code>。</p>
        </div>
      </section>
    );
  }

  const s = state;
  return (
    <section className="chain-debug">
      {!embedded && (
        <header className="page-header">
          <div><h1>链上调试</h1><p className="page-subtitle">{NETWORK.name} · chainId {CHAIN_ID} · 实时读写 Campaign</p></div>
          <span className="badge tone-live">{s ? SCENE_LABEL[s.scene] : "加载中"}</span>
        </header>
      )}

      <article className="card">
        <div className="card-header"><span>合约与钱包</span></div>
        <div className="card-body">
          <dl className="chain-kv">
            <div><dt>Campaign</dt><dd><a href={explorerAddress(getCampaignAddress())} target="_blank" rel="noreferrer">{short(getCampaignAddress())}</a></dd></div>
            <div><dt>BEM 代币</dt><dd><a href={explorerAddress(BEM_ADDRESS)} target="_blank" rel="noreferrer">{short(BEM_ADDRESS)}</a></dd></div>
            <div><dt>Owner</dt><dd>{short(s?.owner)}</dd></div>
            <div><dt>我的钱包</dt><dd>{account ? `${short(account)}${isOwner ? " · Owner" : ""}` : "未连接"}</dd></div>
            <div><dt>我的 tBNB</dt><dd>{bnb !== null ? `${fmt(bnb)} tBNB` : "—"}</dd></div>
          </dl>
          <div className="chain-actions">
            {!account && <button className="btn btn-primary" type="button" onClick={onConnect} disabled={!hasInjected()}>{hasInjected() ? "连接钱包" : "未检测到钱包"}</button>}
            <button className="btn btn-inline" type="button" onClick={refresh}>刷新</button>
          </div>
          {hint && <p className="fine">{hint}</p>}
          {err && <div className="issues"><p>{err}</p></div>}
        </div>
      </article>

      {s && (
        <>
          <article className="card">
            <div className="card-header">
              <span>本期状态</span>
              <span className="badge tone-live">{SCENE_LABEL[s.scene]}</span>
            </div>
            <div className="card-body">
              <dl className="chain-metrics">
                <div><dt>已售 / 总份</dt><dd>{String(s.sold)} / {String(s.totalShares)}</dd></div>
                <div><dt>每份价格</dt><dd>{fmt(s.sharePriceBnb)} BNB</dd></div>
                <div><dt>合约托管 BNB</dt><dd>{fmt(s.raisedBnb)}</dd></div>
                <div><dt>实际日产</dt><dd>{fmtBem(s.dailyBem)} BEM</dd></div>
                <div><dt>已分发轮数</dt><dd>{String(s.harvestCount)}</dd></div>
                <div><dt>执行子态</dt><dd>{PHASE_LABEL[s.phase]}</dd></div>
              </dl>
            </div>
          </article>

          {s.self && (
            <article className="card">
              <div className="card-header"><span>我的持仓</span></div>
              <div className="card-body">
                <dl className="chain-metrics">
                  <div><dt>可用份额</dt><dd>{String(s.self.shares)}</dd></div>
                  <div><dt>挂单锁定</dt><dd>{String(s.self.escrow)}</dd></div>
                  <div><dt>可领 BEM</dt><dd>{fmtBem(s.self.pending)}</dd></div>
                  <div><dt>已领 BEM</dt><dd>{fmtBem(s.self.claimed)}</dd></div>
                  <div><dt>我的 BEM 余额</dt><dd>{fmtBem(s.self.bemBalance)}</dd></div>
                  <div><dt>已退 BNB</dt><dd>{fmt(s.self.refunded)}</dd></div>
                </dl>
              </div>
            </article>
          )}

          <article className="card">
            <div className="card-header"><span>操作</span></div>
            <div className="card-body">
              {s.scene === 0 && (
                <div className="form-grid cols-2">
                  <label className="field"><span>认筹份数</span><input inputMode="numeric" value={form.buyCount} onChange={(e) => setForm({ ...form, buyCount: e.target.value })} /></label>
                  <div className="field"><span>应付</span>
                    <button className="btn btn-primary" type="button" disabled={busy || !account}
                      onClick={() => run("认筹", (sg) => tx.subscribe(sg, BigInt(form.buyCount), parseEther(fmt(s.sharePriceBnb)) * BigInt(form.buyCount)))}>
                      {busy === "认筹" ? "认筹中…" : `认筹 ${form.buyCount} 份（${(Number(fmt(s.sharePriceBnb)) * Number(form.buyCount)).toFixed(4)} BNB）`}
                    </button>
                  </div>
                  {Date.now() / 1000 > s.fundingDeadline && s.sold < s.totalShares && (
                    <div className="field wide"><button className="btn btn-inline" type="button" disabled={busy || !account} onClick={() => run("退款", (sg) => tx.refund(sg))}>募集超时 · 原路退款</button></div>
                  )}
                </div>
              )}

              {s.scene === 1 && (
                <div>
                  <p className="fine">待执行 · {PHASE_LABEL[s.phase]} · 售罄于 {fmtTime(s.soldOutAt)} · 锁价 {s.priceLock > 0 ? `${fmt(s.priceLock)} BNB/颗 × ${s.transistorCount}` : "未锁"}</p>
                  {s.executionFailed && <p className="fine chain-warn">本期已判流片失败并回到待挂单。可降价重挂，或原路退款；勿在锁价/元件数为 0 时 execute。</p>}
                  {isOwner && (
                    <div className="chain-actions">
                      {s.phase === 1 && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("setPlan", (sg) => tx.setPlan(sg, BigInt(form.est), form.capped, BigInt(form.trCount)))}>setPlan</button>}
                      {s.phase === 1 && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("挂单", (sg) => tx.placeTransistorOrder(sg, "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", BigInt(form.trCount), parseEther(form.trPrice), 0n, 0n))}>placeBid</button>}
                      {s.phase === 1 && <button className="btn btn-inline" type="button" disabled={busy} onClick={() => run("退款", (sg) => tx.openRefund(sg))}>发起退款</button>}
                      {s.phase === 2 && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("同步成交", (sg) => tx.confirmTransistors(sg))}>同步官方成交</button>}
                      {s.phase === 2 && <button className="btn btn-inline" type="button" disabled={busy} onClick={() => run("取消挂单", (sg) => tx.cancelTransistorOrder(sg))}>取消挂单</button>}
                      {s.phase === 3 && !s.executionFailed && (
                        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => run("execute", (sg) => tx.execute(sg, new TextEncoder().encode(form.tapeout), "0x12345678"))}>execute 流片开矿</button>
                      )}
                    </div>
                  )}
                  {s.executionFailed && s.self && s.self.shares > 0 && (
                    <div className="chain-actions">
                      <button className="btn btn-inline" type="button" disabled={busy || !account} onClick={() => run("退款", (sg) => tx.refund(sg))}>流片失败 · 原路退款</button>
                    </div>
                  )}
                </div>
              )}

              {s.scene === 2 && (
                <div className="chain-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={busy || !account}
                    onClick={() => run("harvest", (sg) => tx.harvest(sg))}
                  >
                    全网分发 harvest
                  </button>
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
                  <div className="chain-actions">
                    <button className="btn btn-primary" type="button" disabled={busy || !account} onClick={() => run("挂牌", (sg) => tx.listShares(sg, BigInt(form.listCount), parseEther(form.listPrice)))}>挂牌</button>
                  </div>
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
            <div className="card-header"><span>交易记录</span><span className="stat-label">{logs.length} 笔</span></div>
            <div className="card-body table-wrap">
              {logs.length === 0 ? <p className="chain-empty">还没有交易。</p> : (
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
              )}
            </div>
          </article>
        </>
      )}
    </section>
  );
}
