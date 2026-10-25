import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IS_CONFIGURED, CHAIN_ID, NETWORK,
  SCENE_LABEL, PHASE_LABEL, explorerAddress, explorerTx,
} from "./chain/config.js";
import {
  hasInjected, connectWallet, readState, send, tx, formatEther, parseBnb,
  getCampaignAddress, getRawProvider,
} from "./chain/client.js";
import { discoverWallets } from "./chain/wallets.js";
import { formatRemaining } from "./fixtures.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const fmt = (v, d = 4) => {
  try { return Number(formatEther(v)).toFixed(d); }
  catch { return String(v); }
};
const fmtTime = (sec) => (sec > 0 ? new Date(sec * 1000).toLocaleString("zh-CN") : "—");

export default function OnChainPage({ embedded = false, embeddedAccount = "", embeddedConnected = false, embeddedSigner = null }) {
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
  /*
   * 表单初值一律留空 / 0。
   * 之前这里硬编码了 est:"408"、buyQty:100、maxPrice:"0.005"、listPrice:"0.02"
   * 这些演示数字——在链上模式下点「发送」会拿这组值真的发交易，
   * 等于用演示参数下真单。调试页的所有输入都必须由人自己填。
   */
  const [form, setForm] = useState({ buyCount: 1, listCount: 1, listPrice: "", takeId: 0, takeCount: 1, est: "", buyQty: 1, maxPrice: "" });

  // 内嵌模式下复用工作台已有的连接（account / connected / signer 由 App 透传），
  // 避免 Owner 在「链上调试」里再点一次「连接钱包」才能挂买单。
  // 未连接时退回本页面自己的 wallet 状态（非内嵌或连接丢失后的兜底）。
  const account = embedded && embeddedConnected ? embeddedAccount : (wallet?.account || null);
  const activeSigner = embeddedSigner || wallet?.signer || null;
  const isOwner = useMemo(() => state && account && state.owner?.toLowerCase() === account.toLowerCase(), [state, account]);
  /** 只有一把钥匙：所有写入口都只认 Owner（合约里没有操作员角色）。 */
  const canOperate = isOwner;
  const halted = Boolean(state?.halted);

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
    const useSigner = activeSigner || (wallet?.signer);
    if (!useSigner) { setErr("请先连接钱包"); return; }
    setBusy(label);
    setErr("");
    setHint(`请在钱包中确认「${label}」。弹出窗口后点确认，不要关闭本页。`);
    try {
      const { hash } = await send(fn(useSigner), () => {
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
        {!embedded && <header className="page-header"><div><h1>链上调试</h1><p className="page-subtitle">读写已部署的 Campaign 合约。</p></div></header>}
        <div className="empty">
          <p>尚未配置 Campaign 地址。</p>
          <p className="fine">先在 <code>contracts/</code> 部署：填写 <code>.env</code> 的 <code>DEPLOYER_PRIVATE_KEY</code>，运行部署脚本，地址会自动写入 <code>frontend/src/chain/deployments.json</code>。</p>
        </div>
      </section>
    );
  }

  const s = state;
  const heldNum = Number(s?.circuitHeldCount ?? 0) || 0;
  const listedNum = Number(s?.listedCircuits?.length || 0) || 0;
  // openRefund / depositToPool 的链上门槛，逐条对应合约里的 revert（挡在签名之前，省 gas）。
  const marketOwedNum = s ? Number(formatEther(s.marketOwed || 0n)) : 0;
  const surplusBooked = Number(s?.surplusBase || 0) > 0;
  const outstandingNum = s ? Number(s.outstandingShares || 0n) : 0;
  const partsHeld = heldNum;
  const raisedBnbNum = s ? Number(formatEther(s.raisedBnb)) : 0;
  const poolSet = s
    ? /^0x[0-9a-fA-F]{40}$/.test(String(s.miningPool || "")) && !/^0x0{40}$/i.test(String(s.miningPool || ""))
    : false;
  const poolCoversShares = s
    ? raisedBnbNum + 1e-12 >= outstandingNum * Number(formatEther(s.sharePriceBnb))
    : false;
  const refundGate = !s ? ""
    : surplusBooked ? "余款已按份退回，本金已在持份人手里（SurplusAlreadyReturned）"
    : s.phase !== 1 ? "只有待挂单（Buying）能打开退款（WrongScene）"
    : outstandingNum <= 0 ? "份额已全部退完，没有可退对象（ZeroShares）"
    : marketOwedNum > 0 ? "电路市场还欠本期卖出款（ProceedsPending）：先提取"
    : partsHeld > 0 && !poolCoversShares ? "电路还在合约里、池子不够按原价退完（CircuitsAreCollateral）：先 topUpShortfall"
    : "";
  const poolGate = !s ? ""
    : s.pooled ? "本期已入池（AlreadyPooled）"
    : s.phase !== 3 ? "先确认电路到账（Ready）再入池"
    : !poolSet ? "还没写矿池地址（PoolNotSet）：在「合约工作台」里先 setMiningPool"
    : outstandingNum <= 0 ? "份额已全部退完（ZeroShares），没有持有人可分产出"
    : listedNum > 0 ? "还有电路挂在市场（CircuitStillListed）：先撤单"
    : partsHeld <= 0 ? "合约手上没有电路（InsufficientCircuits）"
    : halted ? "本期已熔断，入池已暂停"
    : "";
  // 买入参数与成本预览。buyCircuits 是 non-payable，采购款直接从募集余额扣；
  // 前端先把超余额挡在签名之外，避免用一次失败把整期标记为执行失败。
  const buyQty = Math.max(0, Math.floor(Number(form.buyQty) || 0));
  const buyUnit = Number(form.maxPrice) || 0;
  const buyCost = buyQty * buyUnit;
  const buyOverBudget = buyCost > raisedBnbNum;
  const canBuy = isOwner && s?.phase === 1 && buyQty > 0 && !buyOverBudget;
  return (
    <section className="chain-debug">
      {!embedded && (
          <header className="page-header">
          <div><h1>链上调试</h1><p className="page-subtitle">{NETWORK.name} · 实时读写本期 Campaign 合约</p></div>
          <span className="badge tone-live">{s ? SCENE_LABEL[s.scene] : "加载中"}</span>
        </header>
      )}

      <article className="card">
        <div className="card-header"><span>合约与钱包</span></div>
        <div className="card-body">
          <dl className="chain-kv">
            <div><dt>Campaign</dt><dd><a href={explorerAddress(getCampaignAddress())} target="_blank" rel="noreferrer">{short(getCampaignAddress())}</a></dd></div>
            <div><dt>Owner</dt><dd>{short(s?.owner)}</dd></div>
            <div><dt>熔断</dt><dd>{halted ? "已熔断（halted）" : "运行中"}</dd></div>
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
                <div><dt>预估算力</dt><dd>{Number(s.estHashpower) > 0 ? `${Number(s.estHashpower).toLocaleString("zh-CN")} H` : "—"}</dd></div>
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
                    <button className="btn btn-primary" type="button" disabled={busy || !account || halted}
                      title={halted ? "本期已熔断：认筹已暂停" : undefined}
                      onClick={() => run("认筹", (sg) => tx.subscribe(sg, BigInt(form.buyCount), s.sharePriceBnb * BigInt(form.buyCount)))}>
                      {busy === "认筹" ? "认筹中…" : halted ? "已熔断 · 认筹暂停" : `认筹 ${form.buyCount} 份（${(Number(fmt(s.sharePriceBnb)) * Number(form.buyCount)).toFixed(4)} BNB）`}
                    </button>
                  </div>
                  {Date.now() / 1000 > s.fundingDeadline && s.sold < s.totalShares && (
                    <div className="field wide"><button className="btn btn-inline" type="button" disabled={busy || !account} onClick={() => run("退款", (sg) => tx.refund(sg))}>募集超时 · 原路退款</button></div>
                  )}
                </div>
              )}

              {s.scene === 1 && (
                <div>
                  <p className="fine">待执行 · {PHASE_LABEL[s.phase]} · 售罄于 {fmtTime(s.soldOutAt)} · 累计采购 {s.priceLock > 0 ? `${fmt(s.priceLock)} BNB / ${heldNum} 张在手` : "未买入"}</p>
                  {s.phase === 1 && Number(s.raisedBnb) < Number(s.sold) * Number(s.sharePriceBnb) && (
                    <p className="fine chain-warn">池子已低于按份全退所需，持份人可按比例退款；把电路挂回市场卖出可以补回一部分。</p>
                  )}
                  {s.executionFailed && <p className="fine chain-warn">本期已判执行失败并回到待挂单。可降低单价重试或退款；没有电路时不要入池。</p>}
                  {canOperate && (
                    <div className="chain-actions">
                      {s.phase === 1 && <button className="btn btn-inline" type="button" disabled={busy} onClick={() => run("setPlan", (sg) => tx.setPlan(sg, BigInt(form.est || "0")))}>写入预估算力</button>}
                      {s.phase === 1 && isOwner && (
                        <div className="buy-debug">
                          <p className="fine">从官方电路市场买入：电路集合开期已锁定（{short(s.circuits)}）。按市场卖单从低到高挑单，采购款直接从募集余额扣；最高单价留 0 表示不设上限。</p>
                          <div className="form-grid cols-2">
                            <label className="field"><span>买入张数</span><input inputMode="numeric" value={form.buyQty} onChange={(e) => setForm({ ...form, buyQty: e.target.value })} /></label>
                            <label className="field"><span>最高单价 BNB</span><input inputMode="decimal" step="0.00001" value={form.maxPrice} onChange={(e) => setForm({ ...form, maxPrice: e.target.value })} /></label>
                          </div>
                          <p className={buyOverBudget ? "chain-warn" : "fine"}>
                            预计支出 {buyCost.toFixed(4)} BNB · 募集余额 {raisedBnbNum.toFixed(4)} BNB
                            {buyOverBudget ? " · 超余额，链上会以 ExecutionFailed 空跑" : ""}
                          </p>
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={busy || !canBuy}
                            title={!isOwner ? "仅 Owner 可买入" : buyQty <= 0 ? "买入张数须大于 0" : buyOverBudget ? "支出超过募集余额，链上会空跑" : undefined}
                            onClick={() => run("买入电路", (sg) => tx.buyCircuitsFromMarket(
                              sg,
                              buyQty,
                              buyUnit > 0 ? parseBnb(form.maxPrice) : 0n,
                            ))}>买入电路</button>
                        </div>
                      )}
                      {s.phase === 1 && (
                        <button
                          className="btn btn-inline"
                          type="button"
                          disabled={busy || Boolean(refundGate)}
                          title={refundGate || undefined}
                          onClick={() => run("打开退款", (sg) => tx.openRefund(sg))}
                        >
                          打开退款
                        </button>
                      )}
                      {!s.executionFailed && Number(s.surplusBase || 0) === 0 && s.phase !== 3 && (() => {
                        // 合约 FAIL_GRACE = 3 天：非 Owner 只能等售罄满 3 天；Owner 随时可判。
                        const waitMs = !canOperate && s.markFailedAt ? Number(s.markFailedAt) - Date.now() : 0;
                        const locked = waitMs > 0;
                        return (
                          <button
                            className="btn btn-inline"
                            type="button"
                            disabled={busy || locked}
                            title={locked
                              ? `非 Owner 须等售罄满 3 天（约 ${new Date(Number(s.markFailedAt)).toLocaleString("zh-CN")} 后）；Owner 现在就能用「发起退款 / 放弃挂单」立即退款。`
                              : canOperate
                                ? "Owner 可随时判失败，为持份人开放退款。"
                                : "已过 3 天宽限期：任何地址都可判失败并开放退款。"}
                            onClick={() => run("判失败", (sg) => tx.markFailed(sg))}
                          >
                            {locked
                              ? `markFailed · 还需 ${formatRemaining(waitMs)}`
                              : canOperate ? "markFailed（Owner 随时）" : "markFailed（已过 3 天）"}
                          </button>
                        );
                      })()}
                      {s.phase === 2 && heldNum > 0 && (
                        <button
                          className="btn btn-primary"
                          type="button"
                          disabled={busy}
                          title="confirmCircuits 要求本期合约真的持有 ERC721 电路。"
                          onClick={() => run("确认到账", (sg) => tx.confirmCircuits(sg))}
                        >
                          确认 {heldNum} 张电路到账
                        </button>
                      )}
                      {s.phase === 2 && heldNum <= 0 && (
                        <p className="fine">本期合约还没有电路：先在「买入电路」里从市场买入，再确认到账。</p>
                      )}
                      {s.phase === 3 && !s.executionFailed && isOwner && (
                        <button
                          className="btn btn-primary"
                          type="button"
                          disabled={busy || Boolean(poolGate)}
                          title={poolGate || undefined}
                          onClick={() => run("depositToPool", (sg) => tx.depositToPool(sg))}
                        >
                          depositToPool 进入挖矿
                        </button>
                      )}
                    </div>
                  )}
                  {s.executionFailed && s.self && s.self.shares > 0 && (
                    <div className="chain-actions">
                      <button className="btn btn-inline" type="button" disabled={busy || !account} onClick={() => run("退款", (sg) => tx.refund(sg))}>执行失败 · 原路退款</button>
                    </div>
                  )}
                </div>
              )}

              {s.scene === 2 && (
                <div>
                  <p className="fine">
                    电路已入池，本期进入挖矿（不可逆）。harvest / claim 为占位空实现，不产出发放；
                    持份用户退出只能通过「发布转让挂单」走份额转让。
                  </p>
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
                    <button className="btn btn-primary" type="button" disabled={busy || !account || halted} title={halted ? "本期已熔断：份额挂单已暂停" : undefined} onClick={() => run("挂牌", (sg) => tx.listShares(sg, BigInt(form.listCount), parseEther(form.listPrice)))}>{halted ? "已熔断 · 挂牌暂停" : "挂牌"}</button>
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
                              <button className="btn btn-inline" type="button" disabled={busy || halted} title={halted ? "本期已熔断：接单已暂停" : undefined} onClick={() => run("接收", (sg) => tx.takeListing(sg, l.id, BigInt(form.takeCount), l.priceBnbPerShare * BigInt(form.takeCount)))}>接收 {form.takeCount} 份</button>
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
