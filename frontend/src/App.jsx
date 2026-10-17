import { useEffect, useMemo, useState } from "react";
import { ContractCalls, readCall } from "./Calls.jsx";
import { OwnerCreate, OwnerHolders, OwnerOverview } from "./Owner.jsx";
import OnChainPage from "./OnChain.jsx";
import { IS_CONFIGURED as CHAIN_CONFIGURED, NETWORK, CHAIN_ID } from "./chain/config.js";
import { useChain } from "./chain/useChain.js";
import { send, tx as chainTx, parseEther, readHolders, hasInjected } from "./chain/client.js";
import deployments from "./chain/deployments.json";
import { keccak256, toUtf8Bytes } from "ethers";

// 演示网表：execute 时传入原始字节，合约内 keccak 后须等于开期承诺的 netlistHash
const RAW_NETLIST = toUtf8Bytes("netlist-v1");
const START_DATA = "0x12345678";
const NETLIST_MATCH =
  deployments.campaignParams?.netlistHash &&
  keccak256(RAW_NETLIST).toLowerCase() === String(deployments.campaignParams.netlistHash).toLowerCase();
import {
  MARKET,
  OWNER,
  QUOTE,
  ROSTER,
  ROUND,
  SCENES,
  SCENE_COPY,
  WALLET,
  recomputeSelf,
  applyBuy,
  applyClaim,
  applyConfirmTransistors,
  applyCreate,
  applyExecute,
  applyHarvest,
  applyPlaceTransistorOrder,
  applyCancelTransistorOrder,
  applyListShares,
  applyCancelListing,
  applyTakeListing,
  applyRefund,
  bemRate,
  buildHolders,
  computeHarvest,
  createScene,
  createPriceFeed,
  currentRate,
  NETWORK_WEIGHT,
  NETWORK_DAILY_EMISSION,
  MINE_GATE_LIMIT,
  fetchTaskBook,
  estimateHashpower,
  executeUnlockIn,
  feeRate,
  formatBem,
  formatUsdt,
  hashpowerSensitivity,
  identify,
  shortAddress,
  round4,
} from "./fixtures.js";

const USER_PAGES = [
  { id: "product", label: "本期认购" },
  { id: "portfolio", label: "我的份数" },
  { id: "transfer", label: "份额转让" },
  { id: "onchain", label: CHAIN_CONFIGURED ? "链上调试" : "链上调试(未部署)" },
  { id: "rules", label: "规则" },
];
const OWNER_PAGES = [
  { id: "admin", label: "期次概览" },
  { id: "create", label: "开新一期" },
  { id: "holders", label: "份额明细" },
  { id: "calls", label: "合约调用" },
];

export default function App() {
  const [page, setPage] = useState("product");
  const [simConnected, setSimConnected] = useState(true);
  /** 当前连接地址。切换它即可预览不同角色的权限边界。 */
  const [simAccount, setSimAccount] = useState(WALLET);
  const [simRound, setSimRound] = useState(ROUND);
  const [simBook, setSimBook] = useState(() => createScene("mining", ROUND, null));
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const [now, setNow] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false);

  /** 链上数据源：CHAIN_CONFIGURED 时轮询测试网 Campaign，产出 book/round；否则回退本地模拟。 */
  const chain = useChain();

  /**
   * 实时价格源。晶体管单价与 BNB 价格都会变，
   * 开期测算与募集期预估算力都依赖它。15 秒轮询一次。
   */
  const feed = useMemo(() => createPriceFeed({ intervalMs: 5000 }), []);
  const [quote, setQuote] = useState(() => feed.getSnapshot());
  /** 官方题库：267 道题，含g / d / K / C */
  const [taskbook, setTaskbook] = useState({ tasks: [], total: 0, source: "loading" });

  useEffect(() => {
    const unsubscribe = feed.subscribe(setQuote);
    feed.start();
    /**
     * 题库是异步加载的。加载完成后必须重建 book，
     * 否则 book 会一直停留在「题库未加载」的兜底题目上——
     * 之前就是这样导致权重显示 132（兜底 #17）而非真实的 60（#21）。
     */
    fetchTaskBook()
      .then((book) => {
        setTaskbook(book);
        setSimBook((current) => createScene(current.scene, simRound, book));
      })
      .catch(() => setTaskbook({ tasks: [], total: 0, source: "error" }));
    return () => {
      unsubscribe();
      feed.stop();
    };
    // 模拟期次参数变化时也要重建模拟 book（开新期后 taskId 变了）
  }, [feed, simRound.taskId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 2800);
    return () => clearTimeout(timer);
  }, [notice]);

  // ── 数据源切换：链上优先，未配置/读取失败回退本地模拟 ──
  const usingChain = chain.active && chain.book != null;
  const chainEst = useMemo(
    () => (chain.round ? estimateHashpower(chain.round, quote, chain.round.totalShares, taskbook) : null),
    [chain.round, quote, taskbook]
  );
  const book = usingChain ? { ...chain.book, estimate: chainEst || chain.book.estimate } : simBook;
  const round = usingChain ? chain.round : simRound;
  const account = usingChain ? chain.account || "" : simAccount;
  const connected = usingChain ? Boolean(chain.account) : simConnected;

  const copy = SCENE_COPY[book.scene];
  const remaining = round.totalShares - book.sold;
  const pay = book.picked * round.sharePriceBnb;
  const countdown = Number.isFinite(book.endsAt) ? splitCountdown(book.endsAt - now) : null;
  /** 当前身份：链上模式按 owner/持份判定（identify 只认固定 OWNER 常量，不适用于测试网部署地址） */
  const actor = usingChain
    ? (() => {
      const isOwner = account && book.owner && String(account).toLowerCase() === String(book.owner).toLowerCase();
      const shares = (book.mine || 0) + (book.listingShares || 0);
      return isOwner
        ? { role: "owner", label: "工厂Owner", shares, address: account }
        : shares > 0
          ? { role: "holder", label: "持份用户", shares, address: account }
          : { role: "user", label: "未持份地址", shares: 0, address: account };
    })()
    : identify(account, book);
  /** execute 观察期剩余毫秒 */
  const executeWait = executeUnlockIn(round, book, now);

  // 份额明细：链上模式按 sold 变化从事件重构真实持有人（避免每 10s 轮询都拉日志）
  const [chainHolders, setChainHolders] = useState(null);
  useEffect(() => {
    if (!(usingChain && page === "holders")) return undefined;
    let alive = true;
    readHolders()
      .then((h) => alive && setChainHolders(h))
      .catch(() => alive && setChainHolders([]));
    return () => {
      alive = false;
    };
  }, [usingChain, page, book.sold]);

  function switchScene(scene, expired = false, execFailed = false) {
    // 切换场景时保留当前 executePhase（如已确认到账的 ready），避免被重置回 buying；
    // 同时保留多钱包账本与转让市场的挂单，否则切换场景会丢失挂牌与余额。
    setSimBook((current) => {
      const next = createScene(scene, round, taskbook, current.executePhase, expired, execFailed);
      return recomputeSelf({
        ...next,
        wallets: current.wallets || next.wallets,
        listings: current.listings || [],
        selfAddress: current.selfAddress || next.selfAddress,
      });
    });
    setPending("");
    setNotice("");
  }

  /** 切换连接钱包：同步账本里的 selfAddress，并把 mine/listingShares 重算为该钱包的余额。 */
  function switchAccount(address) {
    setSimAccount(address);
    setSimBook((current) => recomputeSelf({ ...current, selfAddress: address }));
  }

  function run(label, action) {
    setPending(label);
    window.setTimeout(() => {
      action();
      setPending("");
    }, 700);
  }

  /**
   * 唯一的写入口。页面按钮和合约调用页都走这里。
   * 链上模式：写操作走合约交易（chainInvoke）；本地模拟：走 apply*。
   */
  function invokeCall(method, args) {
    const WRITE_METHODS = ["buy", "listShares", "cancelListing", "takeListing", "refund", "claim", "execute", "harvest", "placeTransistorOrder", "cancelTransistorOrder", "confirmTransistors"];
    if (usingChain && WRITE_METHODS.includes(method)) return chainInvoke(method, args);
    if (usingChain && method === "createCampaign") {
      const msg = "链上模式：开新一期请用 contracts 部署脚本 deploy-bsc.js";
      setNotice(msg);
      return { ok: false, message: msg };
    }
    if (["status", "sold", "sharePriceBnb", "totalShares", "hashpower", "estHashpower", "dailyBem", "harvestCount", "feeBps", "totalDistributed", "sharesOf", "pendingBem"].includes(method)) {
      return { ok: true, message: readCall(method, args, round, book, account, quote) };
    }

    let result;
    if (method === "buy") result = applyBuy(round, book, args.shares);
    else if (method === "listShares") result = applyListShares(round, book, args, actor);
    else if (method === "cancelListing") result = applyCancelListing(round, book, args.listingId, actor);
    else if (method === "takeListing") result = applyTakeListing(round, book, args.listingId, args.shares, actor);
    else if (method === "claim") result = applyClaim(round, book);
    else if (method === "execute") result = applyExecute(round, book, quote, actor, taskbook);
    else if (method === "harvest") result = applyHarvest(round, book);
    else if (method === "placeTransistorOrder") result = applyPlaceTransistorOrder(round, book, actor);
    else if (method === "cancelTransistorOrder") result = applyCancelTransistorOrder(round, book, actor);
    else if (method === "confirmTransistors") result = applyConfirmTransistors(round, book, actor);
    else if (method === "refund") result = applyRefund(round, book, actor);
    else if (method === "createCampaign") result = applyCreate(round, args, quote, taskbook);
    else return { ok: false, message: "不能从管理页调用这个函数" };

    if (result.ok) {
      if (result.book) setSimBook(result.book);
      if (result.round) setSimRound(result.round);
      setNotice(result.message);
    }
    return { ok: result.ok, message: result.message };
  }

  /** 链上写操作：构造交易 → 发送并等待 → 刷新。自带 pending/notice，不走 run() 的 700ms。 */
  function chainInvoke(method, args) {
    const signer = chain.signer;
    if (!signer) {
      setNotice("请先连接钱包（链上写操作需要签名）");
      return { ok: false, message: "请先连接钱包" };
    }
    let promise;
    try {
      promise = buildChainTx(method, args, signer);
    } catch (e) {
      setNotice(e.message || "参数错误");
      return { ok: false, message: e.message || "参数错误" };
    }
    setPending(method);
    send(promise)
      .then(() => {
        setNotice(`已确认：${method} ✓`);
        setPending("");
        chain.refresh();
      })
      .catch((e) => {
        setNotice(`失败：${e.message}`);
        setPending("");
      });
    return { ok: true, message: "交易已提交，等待链上确认…" };
  }

  function buildChainTx(method, args, signer) {
    const priceWei = book._sharePriceWei || 0n;
    switch (method) {
      case "buy": return chainTx.buy(signer, BigInt(args.shares), BigInt(args.shares) * priceWei);
      case "claim": return chainTx.claim(signer);
      case "harvest": return chainTx.harvest(signer);
      case "refund": return chainTx.refund(signer);
      case "listShares": return chainTx.listShares(signer, BigInt(args.shares), parseEther(String(args.priceBnbPerShare)));
      case "cancelListing": return chainTx.cancelListing(signer, Number(args.listingId));
      case "takeListing": {
        const l = (book.listings || []).find((x) => String(x.id) === String(args.listingId));
        const wei = l && l._priceWei ? l._priceWei : 0n;
        return chainTx.takeListing(signer, Number(args.listingId), BigInt(args.shares), BigInt(args.shares) * wei);
      }
      case "placeTransistorOrder": {
        const count = BigInt((chainEst && chainEst.usedParts) || book.transistorCount || 100);
        const unit = chain.transistorUnitPrice || parseEther("0.005");
        return chainTx.placeTransistorOrder(signer, count, unit);
      }
      case "cancelTransistorOrder": return chainTx.cancelTransistorOrder(signer);
      case "confirmTransistors": return chainTx.confirmTransistors(signer);
      case "execute":
        if (!NETLIST_MATCH) throw new Error("网表不匹配，无法 execute（检查 netlistHash）");
        return chainTx.execute(signer, RAW_NETLIST, START_DATA);
      default: throw new Error("链上模式暂不支持：" + method);
    }
  }

  /** 页面按钮：包一层 loading 动画再调 invokeCall。链上写操作自管 pending，不套 run()。 */
  function act(method, args) {
    if (usingChain) {
      invokeCall(method, args);
      return;
    }
    run(method === "buy" ? "购买中" : "处理中", () => invokeCall(method, args));
  }

  function approve() {
    run("授权中", () => {
      setSimBook((current) => ({ ...current, approved: true }));
      setNotice(`已授权本期合约扣取 BNB`);
    });
  }

  function buy() {
    if (!connected) {
      handleConnect();
      return;
    }
    if (!book.approved) {
      approve();
      return;
    }
    act("buy", { shares: book.picked });
  }

  /** 连接钱包：链上模式拉起注入式钱包并切到目标链；模拟模式直接置已连接。 */
  function handleConnect() {
    if (usingChain) {
      chain.connect().catch((e) => setNotice(e.message || "连接失败"));
      return;
    }
    setSimConnected(true);
    setNotice("已连接钱包");
  }

  function openPage(id) {
    setPage(id);
    setMenuOpen(false);
  }

  return (
    <div className="app-layout">
      <header className="mobile-top">
        <button className="menu-btn" type="button" aria-label="打开菜单" onClick={() => setMenuOpen(true)}>
          ☰
        </button>
        <strong>TapeOut</strong>
        <button className="btn" type="button" onClick={handleConnect}>
          {connected ? shortAddress(account) : "连接"}
        </button>
      </header>
      <button
        className={menuOpen ? "backdrop show" : "backdrop"}
        type="button"
        aria-label="关闭菜单"
        onClick={() => setMenuOpen(false)}
      />
      <aside className={menuOpen ? "sidebar is-open" : "sidebar"}>
        <div className="sidebar-logo">
          <strong>TapeOut</strong>
          <span>众筹挖矿</span>
        </div>
        <nav className="sidebar-menu">
          <div className="menu-group-title">用户</div>
          {USER_PAGES.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "nav-link active" : "nav-link"}
              onClick={() => openPage(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
          <div className="menu-group-title">Owner</div>
          {OWNER_PAGES.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "nav-link active" : "nav-link"}
              onClick={() => openPage(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-user">{connected ? `${shortAddress(account)} · ${actor.label}` : "未连接钱包"}</div>
          <button className="btn btn-primary btn-block" type="button" onClick={handleConnect}>
            {connected && !usingChain ? "断开钱包" : connected ? "已连接" : "连接钱包"}
          </button>
        </div>
      </aside>

      <main className="main-content">
        {usingChain ? (
          <div className="preview-bar" style={{ flexWrap: "wrap", gap: "6px 14px" }}>
            <span>链上模式 · {NETWORK.name} · chainId {CHAIN_ID}</span>
            {chain.account ? (
              <span className="preview-note">身份：<strong>{actor.label}</strong> · {shortAddress(account)}</span>
            ) : hasInjected() ? (
              <>
                <span className="preview-note">未连接钱包（当前只读）</span>
                <button className="btn btn-inline" type="button" onClick={handleConnect}>连接钱包</button>
              </>
            ) : (
              <span className="preview-note" style={{ color: "var(--color-danger)" }}>
                ⚠ 未检测到钱包插件——请在安装 MetaMask 的浏览器中打开本页并切到 BSC 测试网；当前为只读。若在内置预览中打开，请点右上角「在浏览器打开」。
              </span>
            )}
            <button className="btn btn-inline" type="button" onClick={chain.refresh}>刷新</button>
            {chain.error && <span className="preview-note" style={{ color: "var(--color-danger)" }}>{chain.error}</span>}
          </div>
        ) : (
          <div className="preview-bar">
            <span>查看状态</span>
            <div>
              {SCENES.map((scene) => (
                <button
                  key={scene.id}
                  type="button"
                  className={book.scene === scene.id && !book._expiredPreview && !book._execFailedPreview ? "is-on" : ""}
                  onClick={() => switchScene(scene.id)}
                >
                  {scene.label}
                </button>
              ))}
              <button
                type="button"
                className={book._expiredPreview ? "is-on" : ""}
                onClick={() => switchScene("funding", true)}
                title="演示：募集超过截止时间仍未售罄"
              >
                募集超时（演示）
              </button>
              <button
                type="button"
                className={book._execFailedPreview ? "is-on" : ""}
                onClick={() => switchScene("executing", false, true)}
                title="演示：流片执行失败（元件报价超过募资总额，本金尚未支出）"
              >
                流片失败（演示）
              </button>
            </div>
            <span className="preview-note">
              身份：<strong>{actor.label}</strong>
              <select
                className="role-select"
                value={account}
                onChange={(event) => switchAccount(event.target.value)}
                aria-label="切换预览身份"
              >
                <option value={WALLET}>持份用户（当前钱包）</option>
                <option value={OWNER}>工厂 Owner</option>
                <option value="0x00000000000000000000000000000000DEAD01">未持份地址</option>
                {ROSTER.map((person) => (
                  <option key={person.address} value={person.address}>
                    持有人 {shortAddress(person.address)}（{book.wallets?.[String(person.address).toLowerCase()]?.mine ?? 0} 份）
                  </option>
                ))}
              </select>
            </span>
          </div>
        )}
        {page === "product" && (
          <ProductPage
            round={round}
            book={book}
            copy={copy}
            quote={quote}
            taskbook={taskbook}
            remaining={remaining}
            pay={pay}
            countdown={countdown}
            executeWait={executeWait}
            pending={pending}
            connected={connected}
            onPick={(picked) => setSimBook((current) => ({ ...current, picked }))}
            onBuy={buy}
          />
        )}
        {page === "portfolio" && (
          <PortfolioPage
            round={round}
            book={book}
            copy={copy}
            actor={actor}
            pending={pending}
            connected={connected}
            onClaim={() => act("claim")}
            onRefund={() => act("refund")}
            onBrowse={() => openPage("product")}
            onConnect={() => setSimConnected(true)}
          />
        )}
        {page === "transfer" && (
          <TransferPage
            round={round}
            book={book}
            copy={copy}
            actor={actor}
            account={account}
            pending={pending}
            connected={connected}
            onList={(args) => act("listShares", args)}
            onCancel={(id) => act("cancelListing", { listingId: id })}
            onTake={(args) => act("takeListing", args)}
            onBrowse={() => openPage("product")}
            onConnect={() => setSimConnected(true)}
          />
        )}
        {page === "rules" && <RulesPage round={round} book={book} quote={quote} taskbook={taskbook} />}
        {page === "onchain" && <OnChainPage />}
        {page === "admin" && (
          <OwnerOverview
            round={round}
            book={book}
            copy={copy}
            quote={quote}
            taskbook={taskbook}
            pending={pending}
            actor={actor}
            executeWait={executeWait}
            onPlaceTransistorOrder={() => act("placeTransistorOrder")}
            onCancelTransistorOrder={() => act("cancelTransistorOrder")}
            onConfirmTransistors={() => act("confirmTransistors")}
            onExecute={() => act("execute")}
            onHarvest={() => act("harvest")}
          />
        )}
        {page === "create" && (
          <OwnerCreate
            pending={pending}
            snapshot={quote}
            taskbook={taskbook}
            now={now}
            onCreate={(draft) => {
              const result = applyCreate(round, draft, quote, taskbook);
              if (!result.ok) {
                setNotice(result.message);
                return;
              }
              setSimRound(result.round);
              setSimBook(result.book);
              setPage("admin");
              setNotice(result.message);
            }}
          />
        )}
        {page === "holders" && <OwnerHolders round={round} book={book} account={account} holders={usingChain ? chainHolders : null} />}
        {page === "calls" && (
          <ContractCalls
            round={round}
            book={book}
            connected={connected}
            wallet={account}
            actor={actor}
            quote={quote}
            pending={pending}
            onInvoke={invokeCall}
          />
        )}
      </main>

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function ProductPage({ round, book, copy, quote, taskbook, remaining, pay, countdown, executeWait, pending, connected, onPick, onBuy }) {
  const progress = Math.round((book.sold / round.totalShares) * 100);
  const fundingOpen = book.scene === "funding" && (!book.endsAt || Date.now() <= book.endsAt);
  const canBuy = fundingOpen && remaining > 0;
  const maxPick = Math.max(remaining, 1);
  const harvest = computeHarvest(round, book);
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  /** 预估算力随报价浮动；执行后 book.hashpower 才是实际值 */
  const est = estimateHashpower(round, quote, round.totalShares, taskbook);
  const executed = book.hashpower > 0;

  return (
    <section>
      <header className="page-header">
        <div>
          <h1>第 {round.id} 期矿机认购</h1>
          <p className="page-subtitle">{copy.lead}</p>
        </div>
        <span className={`badge tone-${copy.tone}`}>{copy.badge}</span>
      </header>

      <div className="stat-grid">
        <article className="stat-card accent">
          <div className="stat-label">每份</div>
          <div className="stat-value">{round.sharePriceBnb.toFixed(4)} BNB</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">总份数</div>
          <div className="stat-value">{round.totalShares}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">募资总额</div>
          <div className="stat-value">{hardCap.toFixed(4)} BNB</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">服务费</div>
          <div className="stat-value">{round.feeBps / 100}%</div>
        </article>
      </div>

      {/* 算力：执行前只能预估，执行后才是实际值。两者可能因晶体管涨价而不一致。 */}
      {executed ? (
        <div className="stat-grid">
          <article className="stat-card accent">
            <div className="stat-label">实际算力</div>
            <div className="stat-value">{book.hashpower.toLocaleString("zh-CN")} H</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">预估算力</div>
            <div className="stat-value">{est.hashpower.toLocaleString("zh-CN")} H</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">实际日产</div>
            <div className="stat-value">{harvest.dailyBem} BEM</div>
            <div className="stat-note">
              按全网权重 {(book.capped ? NETWORK_WEIGHT.unverified : NETWORK_WEIGHT.verified).toLocaleString()} 实时折算
            </div>
          </article>
          <article className="stat-card">
            <div className="stat-label">电路</div>
            <div className="stat-value">{book.circuitId}</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">已扣服务费</div>
            <div className="stat-value">{formatBem(book.feeBem)} BEM</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">我的可领</div>
            <div className="stat-value">{formatBem(book.claimable)} BEM</div>
          </article>
          <article className="stat-card wide-stat">
            <div className="stat-label">领取进度 · 每次可分得 {formatBem(harvest.userPart)} BEM</div>
            <div className="stat-value">
              已领 {harvest.rounds} 次 · 次数不限
            </div>
          </article>
        </div>
      ) : (
        <div className="stat-grid">
          <article className="stat-card accent">
            <div className="stat-label">
              预估算力
              <em className="est-tag">按当前报价</em>
            </div>
            <div className="stat-value">{est.hashpower.toLocaleString("zh-CN")} H</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">预估日产</div>
            <div className="stat-value">{formatBem(est.dailyBem)} BEM</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">募资总额可买元件</div>
            <div className="stat-value">{est.affordableParts.toLocaleString("zh-CN")} 个</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">剩余 BNB</div>
            <div className="stat-value" style={est.capCoversFloor ? undefined : { color: "var(--color-danger)" }}>
              {est.capCoversFloor
                ? `${(est.hardCapBnb - est.needBnb).toFixed(4)} BNB`
                : `缺 ${(est.needBnb - est.hardCapBnb).toFixed(4)} BNB`}
            </div>
          </article>
          <article className="stat-card">
            <div className="stat-label">预估日产（已扣服务费）</div>
            <div className="stat-value">
              {formatBem(est.dailyBem * (1 - feeRate(round)))} BEM
            </div>
          </article>
          <article className="stat-card wide-stat warn">
            <div className="stat-label">预估随报价浮动，不是承诺</div>
            <div className="stat-value" style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.6 }}>
              募资总额 {est.hardCapBnb.toFixed(4)} BNB，按 {est.processor} 当前报价（NAND {est.priceNand.toFixed(4)}{est.latch > 0 ? ` / LATCH ${est.priceLatch.toFixed(4)}` : ""} BNB，混合均价 {" "}
              {est.usedParts > 0 ? (est.needBnb / est.usedParts).toFixed(4) : "0.0000"} BNB/个）可买 {est.affordableParts} 个；本期题目 {est.usedParts} 个元件（
              {est.nand} NAND + {est.latch} LATCH{est.latch === 0 ? "，纯组合逻辑" : ""}），权重 H ={" "}
              {est.hashpower} = {est.usedParts} ×{est.processorScale}
              {est.optimal ? ` + 溢价 ${est.refParts}×${est.q}` : "（非最优，无设计溢价）"}。
              若执行时元件涨价导致募资总额买不够所需元件，本期全额退款。
            </div>
          </article>
        </div>
      )}

      <div className="layout">
        <article className="card">
          <div className="card-header">募集进度</div>
          <div className="card-body">
            <div className="progress-label">
              <span>
                已售 {book.sold} / {round.totalShares} 份
              </span>
              <span>{progress}%</span>
            </div>
            <div className="track" aria-hidden="true">
              <i style={{ width: `${progress}%` }} />
            </div>
            <Countdown scene={book.scene} countdown={countdown} />
            <Pipeline scene={book.scene} phase={book.executePhase} />
            <div className="path">
              <h2>资金只走这条路径</h2>
              <ol>
                <li>未售罄：本期不会流片，进入挖矿后才可在份额转让市场挂牌。</li>
                <li>售罄：按当前报价买入 NAND / LATCH 元件，流片成为矿机。</li>
                <li>挖矿：BEM 按份分配，先扣 {round.feeBps / 100}% 服务费。</li>
              </ol>
              {book.scene === "executing" && (
                <p className="fine">
                  {book.executePhase === "ready"
                    ? executeWait > 0
                      ? `观察期还剩 ${Math.ceil(executeWait / 3600_000)} 小时。这段时间内任何人都不能执行换币，你可以核对网表哈希与报价。`
                      : "晶体管已到位。观察期已满后，持份用户或工厂 Owner 均可触发 execute，一旦执行资金即转为 BNB 并烧掉晶体管。"
                    : "本期份数已售完。工厂 Owner 需手动调用 tapeout.net 挂单逻辑买入晶体管，到账后再确认成交并触发流片开矿——合约无法替人工操作 tapeout.net，需由 Owner 发起链上交易完成。"}
                </p>
              )}
              <p className="mono">{shortAddress(round.contract)} · 预览地址</p>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">选择份数</div>
          <div className="card-body">
            <Stepper
              value={book.picked}
              min={1}
              max={canBuy ? maxPick : book.picked}
              disabled={!canBuy}
              onChange={onPick}
            />
            <ul className="bill">
              <li>
                <span>单价</span>
                <strong>{round.sharePriceBnb.toFixed(4)} BNB</strong>
              </li>
              <li>
                <span>份数</span>
                <strong>{book.picked}</strong>
              </li>
              <li className="due">
                <span>应付</span>
                <strong>{Number(pay).toFixed(4)} BNB</strong>
              </li>
              <li>
                <span>我的 BNB 余额</span>
                <strong>{round4(book.bnb || 0)} BNB</strong>
              </li>
            </ul>
            <p className="remain">{canBuy ? `剩余 ${remaining} 份，不能自填金额` : "本期已停止认购"}</p>
            <button className="btn btn-primary" type="button" disabled={!canBuy || Boolean(pending)} onClick={onBuy}>
              {pending || buyLabel(book, connected, canBuy)}
            </button>
            <p className="fine">合约按「份数 × {round.sharePriceBnb} BNB」记账。直接转账不会记份。</p>
            <RecentBuys round={round} book={book} />
          </div>
        </article>
      </div>
    </section>
  );
}

function PortfolioPage({ round, book, copy, actor, pending, connected, onClaim, onRefund, onBrowse, onConnect }) {
  const cost = book.mine * round.sharePriceBnb;
  const harvest = computeHarvest(round, book);
  const showClaim = book.scene === "mining" && book.claimable > 0;
  const isOwner = actor?.role === "owner";

  return (
    <section>
      <header className="page-header">
        <div>
          <h1>我的份数</h1>
          <p className="page-subtitle">{connected ? copy.lead : "连接钱包后查看这一期的份数和可领收益。"}</p>
        </div>
        <span className={`badge tone-${copy.tone}`}>{copy.badge}</span>
      </header>

      {!connected && (
        <div className="empty">
          <p>当前没有连接钱包。</p>
          <button className="btn btn-primary" type="button" onClick={onConnect}>
            连接钱包
          </button>
        </div>
      )}

      {connected && book.mine === 0 && (
        <div className="empty">
          <p>这一期还没有你的份数。</p>
          <button className="btn btn-primary" type="button" onClick={onBrowse}>
            去认购
          </button>
        </div>
      )}

      {connected && book.mine > 0 && (
        <>
          <div className="holding-grid">
            <article className="stat-card accent">
              <div className="stat-label">持有</div>
              <div className="stat-value">{book.mine} 份</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">认购金额</div>
              <div className="stat-value">{cost.toFixed(4)} BNB</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">占总份数</div>
              <div className="stat-value">
                {book.mine}/{round.totalShares}
              </div>
            </article>
            <article className="stat-card">
              <div className="stat-label">可领取</div>
              <div className="stat-value">{formatBem(book.claimable)} BEM</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">我的 BNB 余额</div>
              <div className="stat-value">{round4(book.bnb || 0)} BNB</div>
              <div className="stat-note">认购/转让后剩余可用流动性</div>
            </article>
          </div>
          <article className="card">
            <div className="card-header">资金托管（合约代持 BNB 池）</div>
            <div className="card-body">
              <ul className="bill">
                <li>
                  <span>合约代持 BNB 池</span>
                  <strong>{round4(book.bnbPool || 0)} BNB</strong>
                </li>
                <li>
                  <span>我的已退 BNB</span>
                  <strong>{round4(book.refundedSelf || 0)} BNB</strong>
                </li>
                <li className="due">
                  <span>我的认购已付</span>
                  <strong>{round4(book.mine * round.sharePriceBnb + (book.refundedSelf || 0))} BNB</strong>
                </li>
              </ul>
              <p className="fine">
                募集款与转让结算都走合约代持 BNB 池，与钱包余额隔离。
                认购时扣你的 BNB 进池；转让接收时买方 BNB 实时付给卖方；
                退款/流片从池中支出，退回的 BNB 回到你的钱包余额。
              </p>
            </div>
          </article>
          <article className="card">
            <div className="card-header">
              <span>收益</span>
              <span className="stat-label">已领取 {formatBem(book.claimed)} BEM</span>
            </div>
            <div className="card-body">
              {showClaim && (
                <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={onClaim}>
                  {pending || `领取 ${formatBem(book.claimable)} BEM`}
                </button>
              )}
              {!showClaim && book.scene === "funding" && Date.now() <= (book.endsAt || Infinity) && (
                <p className="fine">募集尚未结束。售罄并开始挖矿后，才能在份额转让市场挂牌。</p>
              )}
              {!showClaim && book.scene === "funding" && Date.now() > (book.endsAt || Infinity) && book.mine > 0 && (
                <div>
                  <p className="fine">募集已超过截止时间仍未售罄，可把认购的 BNB 原路退还。退款后份额清零，本期视为募集失败。</p>
                  <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={onRefund}>
                    {pending || `原路退还 ${round4(book.mine * round.sharePriceBnb)} BNB`}
                  </button>
                </div>
              )}
              {!showClaim && book.scene === "funding" && Date.now() > (book.endsAt || Infinity) && book.mine === 0 && (
                <p className="fine">本期募集已超时，你的份额已原路退还（共 {round4(book.refundedSelf || 0)} BNB）。</p>
              )}
              {!showClaim && book.scene === "executing" && !book.executionFailed && (
                <p className="fine">份数已确认。流片完成、进入挖矿后，才能在份额转让市场挂牌。</p>
              )}
              {!showClaim && book.scene === "executing" && book.executionFailed && book.mine > 0 && (
                <div>
                  <p className="fine">本期流片执行失败（元件报价超过募资总额，本金尚未支出）。可把认购的 BNB 原路退还，退款后份额清零。也可由 Owner 待元件降价后重试流片。</p>
                  <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={onRefund}>
                    {pending || `原路退还 ${round4(book.mine * round.sharePriceBnb)} BNB`}
                  </button>
                </div>
              )}
              {!showClaim && book.scene === "executing" && book.executionFailed && book.mine === 0 && (
                <p className="fine">本期流片已失败，你的份额已原路退还（共 {round4(book.refundedSelf || 0)} BNB）。</p>
              )}
              {!showClaim && book.scene === "mining" && (
                <p className="fine">
                  当前没有可领取的 BEM。已领取 {harvest.rounds} 次（次数不限，只要还在出矿即可领取），
                  本期共分配 {formatBem(book.distributed || 0)} BEM 给全部持有人。
                </p>
              )}
            </div>
          </article>
          {book.hashpower > 0 && (
            <article className="card">
              <div className="card-header">分配明细</div>
              <div className="card-body">
                <ul className="bill">
                  <li>
                    <span>我的占比</span>
                    <strong>
                      {book.mine}/{round.totalShares} = {formatBem(harvest.share * 100)}%
                    </strong>
                  </li>
                  <li>
                    <span>每次 harvest 净产出</span>
                    <strong>{formatBem(harvest.net)} BEM</strong>
                  </li>
                  <li>
                    <span>每次我可分得</span>
                    <strong>{formatBem(harvest.userPart)} BEM</strong>
                  </li>
                  <li>
                    <span>可领次数</span>
                    <strong>不限</strong>
                  </li>
                  <li className="due">
                    <span>本期已分配给全部持有人</span>
                    <strong>{formatBem(book.distributed || 0)} BEM</strong>
                  </li>
                </ul>
                <p className="fine">
                  分母是开期写死的 {round.totalShares} 份，不随实际售出份数变化。
                  这里只给「每次」和「已分配」——不预测本期总产出：
                  全网权重每天在变，任何按当前价外推的总额都不是承诺。
                </p>
              </div>
            </article>
          )}
        </>
      )}
    </section>
  );
}

function TransferPage({ round, book, copy, actor, account, pending, connected, onList, onCancel, onTake, onBrowse, onConnect }) {
  const [pickShares, setPickShares] = useState(1);
  const [price, setPrice] = useState(String(round.sharePriceBnb));
  const available = book.mine;
  const canTransfer = book.scene === "mining";
  const canPublish = available > 0 && canTransfer;
  const myListings = (book.listings || []).filter(
    (l) => String(l.seller).toLowerCase() === String(account).toLowerCase(),
  );

  return (
    <section>
      <header className="page-header">
        <div>
          <h1>份额转让</h1>
          <p className="page-subtitle">
            把份额挂到转让市场卖给其他持份人：发布出售时按每份 BNB 标价，挂出的份额立即锁定，
            直到卖出或撤单。其他持份人可按发布价直接接收（份额过户、BNB 付给卖方）。
          </p>
        </div>
        <span className={`badge tone-${copy.tone}`}>{copy.badge}</span>
      </header>

      {!connected && (
        <div className="empty">
          <p>当前没有连接钱包。</p>
          <button className="btn btn-primary" type="button" onClick={onConnect}>
            连接钱包
          </button>
        </div>
      )}

      {connected && (
        <div className="layout">
          <article className="card">
            <div className="card-header">
              <span>发布出售</span>
              <span className="stat-label">当前可用 {available} 份</span>
            </div>
            <div className="card-body">
              <p className="fine">挂单后这部分份额从可用余额扣出并锁定，不能领取或转让，直到成交或撤单。</p>
              <div className="form-grid cols-2">
                <label className="field">
                  <span>出售份数</span>
                  <div className="stepper-wrap">
                    <Stepper
                      value={pickShares}
                      min={1}
                      max={canPublish ? available : 1}
                      disabled={!canPublish}
                      onChange={setPickShares}
                    />
                  </div>
                </label>
                <label className="field">
                  <span>单价（BNB / 份）</span>
                  <input
                    value={price}
                    inputMode="decimal"
                    onChange={(event) => setPrice(event.target.value)}
                    className={Number(price) > 0 ? undefined : "is-invalid"}
                  />
                </label>
              </div>
              <ul className="bill">
                <li>
                  <span>合计</span>
                  <strong>
                    {round4(Number(pickShares) * Number(price) || 0).toFixed(4)} BNB
                  </strong>
                </li>
                <li className="due">
                  <span>挂单后可用余额</span>
                  <strong>{Math.max(0, available - (canPublish ? pickShares : 0))} 份</strong>
                </li>
              </ul>
              <button
                className="btn btn-primary"
                type="button"
                disabled={!canPublish || !(Number(price) > 0) || Boolean(pending)}
                onClick={() => onList({ shares: pickShares, priceBnbPerShare: Number(price) })}
              >
                {pending || "发布出售挂单"}
              </button>
              {!canTransfer && (
                <p className="fine">
                  份额转让仅在挖矿中开放。当前处于「{book.scene === "funding" ? "募集中" : book.scene === "executing" ? "待执行" : book.scene}」，进入挖矿后才可挂牌或接收。
                </p>
              )}
              {canTransfer && !canPublish && (
                <p className="fine">当前没有可用份额可挂牌（份额为 0 或已全部挂出）。</p>
              )}
            </div>
          </article>

          <article className="card">
            <div className="card-header">
              <span>转让市场 · 接收发布的出售价额</span>
              <span className="stat-label">{(book.listings || []).length} 个挂单</span>
            </div>
            <div className="card-body">
              {(book.listings || []).length === 0 ? (
                <p className="fine">还没有人挂单。发布出售后，挂单会显示在这里供其他持份人接收。</p>
              ) : (
                <ul className="listing-board">
                  {book.listings.map((l) => (
                    <ListingRow
                      key={l.id}
                      listing={l}
                      account={account}
                      pending={pending}
                      disabled={!canTransfer}
                      onTake={onTake}
                      onCancel={onCancel}
                    />
                  ))}
                </ul>
              )}
            </div>
          </article>

          {myListings.length > 0 && (
            <article className="card">
              <div className="card-header">我的挂单</div>
              <div className="card-body">
                <ul className="bill">
                  {myListings.map((l) => (
                    <li key={l.id}>
                      <span>
                        {l.shares} 份 @ {l.priceBnbPerShare.toFixed(4)} BNB · 合计 {l.totalBnb.toFixed(4)} BNB
                      </span>
                      <strong>
                        <button
                          className="btn btn-inline"
                          type="button"
                          disabled={!canTransfer || Boolean(pending)}
                          onClick={() => onCancel(l.id)}
                        >
                          撤单
                        </button>
                      </strong>
                    </li>
                  ))}
                </ul>
                <p className="fine">撤单后锁定份额自动回到可用余额，可重新转让或领取。</p>
              </div>
            </article>
          )}
        </div>
      )}
    </section>
  );
}

function ListingRow({ listing, account, pending, disabled = false, onTake, onCancel }) {
  const [qty, setQty] = useState(1);
  const isMine = String(listing.seller).toLowerCase() === String(account).toLowerCase();
  const maxQty = listing.shares;
  const take = Math.min(Math.max(1, qty), maxQty);
  return (
    <li className="listing-row">
      <div className="listing-main">
        <span className="listing-seller">{shortAddress(listing.seller)}{isMine ? "（我的）" : ""}</span>
        <span className="listing-shares">{listing.shares} 份</span>
        <span className="listing-price">{listing.priceBnbPerShare.toFixed(4)} BNB / 份</span>
        <span className="listing-total">合计 {listing.totalBnb.toFixed(4)} BNB</span>
      </div>
      <div className="listing-actions">
        {isMine ? (
          <button className="btn btn-inline" type="button" disabled={disabled || Boolean(pending)} onClick={() => onCancel(listing.id)}>
            撤单
          </button>
        ) : (
          <>
            <input
              className="qty-input"
              type="number"
              min={1}
              max={maxQty}
              value={take}
              onChange={(event) => setQty(Number(event.target.value))}
              aria-label="接收份数"
            />
            <button
              className="btn btn-primary btn-inline"
              type="button"
              disabled={disabled || Boolean(pending)}
              onClick={() => onTake({ listingId: listing.id, shares: take })}
            >
              接收（付 {round4(take * listing.priceBnbPerShare).toFixed(4)} BNB）
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function RecentBuys({ round, book }) {
  const rows = buildHolders(book.sold, book.mine).slice(0, 5);
  if (!rows.length) return null;
  return (
    <div className="recent">
      <p className="fine">最近认购</p>
      <ul className="bill">
        {rows.map((row) => (
          <li key={row.address}>
            <span>{row.self ? "当前钱包" : shortAddress(row.address)}</span>
            <strong>
              {row.shares} 份 · {(row.shares * round.sharePriceBnb).toFixed(4)} BNB
            </strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RulesPage({ round, book, quote, taskbook }) {
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  const harvest = computeHarvest(round, book);
  const est = estimateHashpower(round, quote, round.totalShares, taskbook);
  const sens = hashpowerSensitivity(round, quote, taskbook);
  return (
    <section>
      <header className="page-header">
        <div>
          <h1>这一期怎么退出</h1>
          <p className="page-subtitle">份数在开期时写死。用户只买整数份，收益按份计算。合约不提供本金或收益赎回。</p>
        </div>
      </header>
      <div className="rules">
        <article className="card">
          <div className="card-body">
            <div className="index">01</div>
            <h2>一份 {round.sharePriceBnb.toFixed(4)} BNB</h2>
            <p>
              本期 {round.totalShares} 份，募资总额 {hardCap.toFixed(4)} BNB。募集与元件成本都以 BNB 计价，无需换算。
            </p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="index">02</div>
            <h2>
              {round.fundingDays} 天募集，超时未售罄原路退还
            </h2>
            <p>
              募集超过截止时间（{round.fundingDays} 天）仍未售罄，视为募集失败：认购人可按 {round.sharePriceBnb} BNB/份 把本金原路退回，份额清零。退款是持份用户的主动操作，不依赖 Owner 统一处理，也不进入挖矿或份额转让流程。
            </p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="index">03</div>
            <h2>售罄后才动用资金</h2>
            <p>同一笔交易里换 BNB、买晶体管、流片并开矿。流片会烧掉晶体管，成功后本金不再退回 BNB。</p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="index">04</div>
            <h2>BEM 按份分配</h2>
            <p>
              服务费 {round.feeBps / 100}% 先从挖到的 BEM 里扣除。个人所得 = 本期净 BEM × 持有份数 / {round.totalShares}。
              分母是开期写死的总份数，不随实际售出份数变化。
            </p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="index">05</div>
            <h2>算力只能预估，会随晶体管价格变</h2>
            <p>
              真实权重公式 <strong>H = ( b* + K_task × q ) × P</strong>：b* 是实际烧掉的元件数，
              q 是设计质量系数（0.25~4），P 是处理器系数（Behemoth=6，TapeOut=1）。
              本期项目方统一图纸烧 {est.usedParts} 个元件（{est.nand} NAND + {est.latch} LATCH），
              面积 A={est.area}、深度 d={est.depth}、成本 C={est.cost}，
              对比参考 C_ref={est.refCost} 得 q={est.q}，
              最终权重 <strong>{est.hashpower}</strong>。
              这只是预估，执行交易时会按那一刻的报价重新买，实际算力可能低于此值。
            </p>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>晶体管价</th>
                  <th>预估算力</th>
                  <th>日产</th>
                  <th>vs 预估</th>
                  <th>达标</th>
                </tr>
              </thead>
              <tbody>
                {sens.map((s) => (
                  <tr key={s.mult}>
                    <td>{s.label}</td>
                    <td>{s.hashpower.toLocaleString("zh-CN")} H</td>
                    <td>{formatBem(s.dailyBem)}</td>
                    <td>{s.needBnb} BNB</td>
                    <td>
                      <span className={`badge ${s.canAfford ? "tone-live" : "tone-back"}`}>
                        {s.canAfford ? "可流片" : "本金退回"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine">
              执行时若募资总额按当时报价买不够图纸所需元件，本期直接判失败，持份用户可原路退还本金（BNB 按 {round.sharePriceBnb} 退回），不进入挖矿。这是被动安全阀，并非主动赎回；主动退出只能靠挖矿中的份额转让。
            </p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="index">06</div>
            <h2>产出按权重占比分配</h2>
            <p>
              每日全网发放 {NETWORK_DAILY_EMISSION.toLocaleString()} BEM，其中 99% 由已验证池按权重占比分配、
              1% 给未验证池。本期权重 {book.hashpower.toLocaleString("zh-CN")}，
              当前日产 {harvest.dailyBem} BEM。
            </p>
            <p>
              <b>产出是零和的</b>：全网权重增加，所有人产出同步下降。
              每次领取都按当日的全网权重重算，所以只有「日产」是当下确定的数——
              它不随挖多久而累加成一个可靠总额。
            </p>
          </div>
        </article>
        <article className="card">
          <div className="card-body">
            <div className="index">07</div>
            <h2>权重与题目、处理器相关</h2>
            <p>
              权重 H =（元件数 + K_task × q）× P。元件数由所选题目决定，
              P 为处理器系数（Behemoth=6，TapeOut=1），q 为设计质量系数。
              只有最优首创能拿满设计溢价，复制官方模板通常只有工本。
            </p>
            <p>
              当前每权重日产 {currentRate().verifiedPerWeight.toFixed(6)} BEM
              （= 已验证池日产 {Math.round(NETWORK_DAILY_EMISSION * 0.99)} ÷ 全池权重{" "}
              {NETWORK_WEIGHT.verified.toLocaleString("zh-CN")}）。
              每次 harvest 可分得净额的 {Math.round(harvest.share * 100)}%。
            </p>
          </div>
        </article>
      </div>
      <div className="formula">
        <span>个人 BEM</span>
        <strong>
          = （日产 × 次数 × (1 − {round.feeBps / 100}%） × 持有份数）/ {round.totalShares}
        </strong>
      </div>
    </section>
  );
}

function Stepper({ value, min, max, disabled, onChange }) {
  return (
    <div className="stepper">
      <button type="button" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label="减少一份">
        −
      </button>
      <output>{String(value).padStart(2, "0")}</output>
      <button type="button" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label="增加一份">
        +
      </button>
    </div>
  );
}

function Countdown({ scene, countdown }) {
  // 挖矿期不设截止日，且领取次数不限：展示「持续出矿中」，不再倒计时
  if (scene === "mining") {
    return (
      <div className="countdown">
        <span>持续出矿中 · 领取次数不限</span>
        <div>
          {[["∞", "天"], ["∞", "时"], ["∞", "分"], ["∞", "秒"]].map(([value, unit]) => (
            <b key={unit}>
              {value}
              <small>{unit}</small>
            </b>
          ))}
        </div>
      </div>
    );
  }
  const ended = scene === "executing";
  const label = {
    funding: "距离募集截止",
    executing: "募集已完成",
  }[scene];
  const cells = ended
    ? [
        ["—", "天"],
        ["—", "时"],
        ["—", "分"],
        ["—", "秒"],
      ]
    : [
        [countdown?.days, "天"],
        [countdown?.hours, "时"],
        [countdown?.minutes, "分"],
        [countdown?.seconds, "秒"],
      ];

  return (
    <div className="countdown">
      <span>{label}</span>
      <div>
        {cells.map(([value, unit]) => (
          <b key={unit}>
            {value}
            <small>{unit}</small>
          </b>
        ))}
      </div>
    </div>
  );
}

function Pipeline({ scene, phase }) {
  // 方案B：待执行拆为「买晶体管（手动）→ 流片开矿」；退出只通过份额转让实现
  const steps = ["募集", "买晶体管", "流片开矿"];
  const active = {
    funding: 0,
    // buying 高亮「买晶体管」；ready 高亮「流片开矿」（待执行）
    executing: phase === "ready" ? 2 : 1,
    mining: 2,
  }[scene];
  return (
    <ol className="pipeline">
      {steps.map((label, index) => (
        <li key={label} className={index === active ? "is-on" : index < active ? "is-done" : ""}>
          {label}
        </li>
      ))}
    </ol>
  );
}

function buyLabel(book, connected, canBuy) {
  if (!canBuy) return "已停止认购";
  if (!connected) return "连接钱包";
  if (!book.approved) return "授权 BNB";
  return "确认购买";
}

function splitCountdown(delta) {
  const total = Math.max(0, Math.floor(delta / 1000));
  return {
    days: String(Math.floor(total / 86400)).padStart(2, "0"),
    hours: String(Math.floor((total % 86400) / 3600)).padStart(2, "0"),
    minutes: String(Math.floor((total % 3600) / 60)).padStart(2, "0"),
    seconds: String(total % 60).padStart(2, "0"),
  };
}
