import { useEffect, useMemo, useRef, useState } from "react";
import { readCall } from "./Calls.jsx";
import { OwnerCreate, OwnerOverview } from "./Owner.jsx";
import { IS_CONFIGURED as CHAIN_CONFIGURED, NETWORK, CHAIN_ID } from "./chain/config.js";
import { useChain } from "./chain/useChain.js";
import {
  send,
  tx as chainTx,
  parseEther,
  parseBnb,
  readHolders,
  readRecentBuys,
  hasInjected,
  setCampaignAddress,
  createCampaignOnChain,
  readFactoryOwner,
  connectWallet,
} from "./chain/client.js";
import deployments from "./chain/deployments.json";
import { keccak256, toUtf8Bytes } from "ethers";

// 演示网表：execute 时传入原始字节，合约内 keccak 后须等于开期承诺的 netlistHash
const RAW_NETLIST = toUtf8Bytes("netlist-v1");
const RAW_NETLIST_HASH = keccak256(RAW_NETLIST);
const START_DATA = "0x12345678";
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
  applyAbortUnaffordable,
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
  NETWORK_WEIGHT,
  NETWORK_DAILY_EMISSION,
  MINE_GATE_LIMIT,
  fetchTaskBook,
  estimateHashpower,
  executeUnlockIn,
  feeRate,
  formatBem,
  formatUsdt,
  identify,
  resolveCampaignDesign,
  shortAddress,
  round4,
} from "./fixtures.js";

/** 按生命周期收口导航（对照 contracts/FEATURES.md §6） */
const LIFE_PAGES = [
  { id: "round", label: "BEM挖矿认购", hint: "募集 → 待执行 → 挖矿" },
  { id: "assets", label: "我的资产", hint: "持仓 / 领取 / 转让" },
  { id: "rules", label: "规则", hint: "资金路径与退出" },
  { id: "owner", label: "Owner 工作台", hint: "开期 / 流片 / 调试" },
];
const OWNER_TABS = [
  { id: "overview", label: "BEM众筹挖矿列表" },
];

export default function App() {
  const [page, setPage] = useState("round");
  const [ownerTab, setOwnerTab] = useState("overview");
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
  const [factoryOwner, setFactoryOwner] = useState(deployments.deployer || "");
  useEffect(() => {
    if (!CHAIN_CONFIGURED) return;
    readFactoryOwner()
      .then((o) => o && setFactoryOwner(o))
      .catch(() => {});
  }, []);

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

  // ── 数据源切换：已部署则只用链上；未部署才走本地模拟 ──
  const usingChain = chain.active && chain.book != null;
  const chainBooting = chain.active && !chain.book;
  /** 从链上 taskId + setPlan 算力反推题目与目标处理器，写入 round 供全页消费 */
  const design = useMemo(() => {
    const baseRound = usingChain ? chain.round : simRound;
    const baseBook = usingChain ? chain.book : simBook;
    if (!baseRound) return null;
    return resolveCampaignDesign(baseRound, baseBook, taskbook);
  }, [usingChain, chain.round, chain.book, simRound, simBook, taskbook]);
  const round = useMemo(() => {
    const base = usingChain ? chain.round : simRound;
    if (!base || !design) return base;
    return {
      ...base,
      taskId: base.taskId != null && base.taskId !== "" ? base.taskId : design.taskId,
      taskName: design.taskName,
      // 链上未 setPlan 时不要把 fixtures 默认处理器写回 round，否则整页估算都会偏到 Behemoth
      processorId: design.processorKnown ? design.processorId : (usingChain ? null : base.processorId),
      transistorId: design.processorKnown ? design.transistorId : (usingChain ? null : base.transistorId),
    };
  }, [usingChain, chain.round, simRound, design]);
  const chainEst = useMemo(
    () => (round ? estimateHashpower(round, quote, round.totalShares, taskbook) : null),
    [round, quote, taskbook]
  );
  const book = usingChain
    ? { ...chain.book, estimate: chainEst || chain.book.estimate, picked: chain.picked }
    : simBook;
  const account = usingChain ? chain.account || "" : simAccount;
  const connected = usingChain ? Boolean(chain.account) : simConnected;
  const netlistMatch = usingChain
    ? Boolean(
        (round?.netlistHash || book?._netlistHash) &&
          String(round?.netlistHash || book?._netlistHash).toLowerCase() === RAW_NETLIST_HASH.toLowerCase()
      )
    : true;

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
        ? { role: "owner", label: "Factory Owner", shares, address: account }
        : shares > 0
          ? { role: "holder", label: "持份用户", shares, address: account }
          : { role: "user", label: "未持份地址", shares: 0, address: account };
    })()
    : identify(account, book);
  /** execute 观察期剩余毫秒 */
  const executeWait = executeUnlockIn(round, book, now);

  // 份额明细 / 历史：进入 Owner 工作台即拉链上数据
  const [chainHolders, setChainHolders] = useState(null);
  useEffect(() => {
    if (!(usingChain && page === "owner")) return undefined;
    let alive = true;
    chain.refreshHistory?.();
    readHolders()
      .then((h) => alive && setChainHolders(h))
      .catch(() => alive && setChainHolders([]));
    return () => {
      alive = false;
    };
  }, [usingChain, page, book.sold, chain.refreshHistory]);

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
    const WRITE_METHODS = [
      "buy", "listShares", "cancelListing", "takeListing", "refund", "claim", "execute", "harvest",
      "placeTransistorOrder", "cancelTransistorOrder", "confirmTransistors", "setPlan", "updateNetworkWeight",
      "createCampaign",
    ];
    if (chain.active && WRITE_METHODS.includes(method)) return chainInvoke(method, args);
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
    else if (method === "abortUnaffordable") result = applyAbortUnaffordable(round, book, actor);
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
    setPending(method);
    (async () => {
      try {
        let signer = chain.signer;
        if (!signer) {
          const w = await connectWallet();
          signer = w.signer;
        }
        if (method === "createCampaign") {
          await chainCreateCampaign(args, signer);
          return;
        }
        // 挂单前先 setPlan，写入预估算力 / capped / 晶体管数
        if (method === "placeTransistorOrder") {
          const count = BigInt((chainEst && chainEst.usedParts) || book.transistorCount || 100);
          const estHp = BigInt(Math.round((chainEst && chainEst.hashpower) || book.estimate?.hashpower || 0));
          const capped =
            Boolean(chainEst && chainEst.usedParts > MINE_GATE_LIMIT) || Boolean(book.capped);
          await send(chainTx.setPlan(signer, estHp, capped, count));
          const unit = chain.transistorUnitPrice || parseEther("0.005");
          await send(chainTx.placeTransistorOrder(signer, count, unit));
        } else if (method === "abortUnaffordable") {
          const est = chainEst || book.estimate || {};
          if (est.capCoversFloor !== false) throw new Error("募资总额买得起晶体管，不能退款");
          const count = BigInt(est.usedParts || 0);
          if (count === 0n) throw new Error("没有元件数量，不能判断是否买得起");
          const needWei = parseEther(Number(est.needBnb).toFixed(8));
          let unit = needWei / count;
          if (unit === 0n) unit = 1n;
          if (unit * count <= needWei) unit += 1n;
          await send(chainTx.abortUnaffordable(signer, count, unit));
        } else {
          const promise = buildChainTx(method, args, signer);
          await send(promise);
        }
        setNotice(`已确认：${method} ✓`);
        await chain.refresh();
        if (method === "claim" || method === "refund") await chain.refreshPositions?.();
        if (method === "createCampaign") await chain.refreshHistory?.();
      } catch (e) {
        setNotice(`失败：${e.message}`);
      } finally {
        setPending("");
      }
    })();
    return { ok: true, message: "交易已提交，等待链上确认…" };
  }

  /** 开期：开新一期页（完整 draft+_review）与合约调用页（表单字段）共用。 */
  async function chainCreateCampaign(draft, signer) {
    const review = draft._review;
    // 份额单价：优先用 toFixed(8) 去掉浮点尾巴，再 parseBnb
    const shareNum = Number(draft.sharePriceBnb);
    if (!Number.isFinite(shareNum) || shareNum <= 0) throw new Error("每份 BNB 无效");
    const sharePriceWei = parseBnb(shareNum.toFixed(8));
    const totalShares = BigInt(Math.round(Number(draft.totalShares || 0)));
    if (totalShares <= 0n) throw new Error("总份数必须为正整数");
    const feePercent = Math.round(Number(draft.feePercent));
    if (!Number.isFinite(feePercent) || feePercent < 1 || feePercent > 20) {
      throw new Error("服务费须在 1–20%");
    }
    const fundingDays = BigInt(Math.round(Number(draft.fundingDays || 7)));
    if (fundingDays <= 0n) throw new Error("募集天数须为正整数");
    const feeRecipient = String(draft.feeRecipient || chain.account || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(feeRecipient)) throw new Error("服务费收费地址格式不正确");
    const taskId = BigInt(String(draft.taskId || 54));
    let executeDelay = 0n;
    if (draft.executeDelay != null && draft.executeDelay !== "") {
      executeDelay = BigInt(String(draft.executeDelay));
    } else if (draft.executeDelayHours != null && draft.executeDelayHours !== "") {
      executeDelay = BigInt(Math.round(Number(draft.executeDelayHours) * 3600));
    }
    const netlistHash =
      draft.netlistHash && String(draft.netlistHash).startsWith("0x")
        ? draft.netlistHash
        : RAW_NETLIST_HASH;

    // signer 可能被 accountsChanged 清掉，尽量补签
    let activeSigner = signer;
    if (!activeSigner) {
      const w = await connectWallet();
      activeSigner = w.signer;
    }

    const { campaign: created, hash } = await createCampaignOnChain(activeSigner, {
      sharePriceWei,
      totalShares,
      feePercent,
      fundingDays,
      feeRecipient,
      taskId,
      executeDelay,
      netlistHash,
    });

    setCampaignAddress(created);
    if (review) {
      try {
        await send(
          chainTx.setPlan(
            activeSigner,
            BigInt(Math.round(review.hashpower || 0)),
            Boolean(review.capped),
            BigInt(review.needParts || 0)
          )
        );
      } catch {
        /* setPlan 可稍后由 Owner 补 */
      }
    }
    await chain.setCampaignAddress(created);
    await chain.refreshHistory?.();
    setOwnerTab("overview");
    setPage("owner");
    setNotice(`已发布：${shortAddress(created)} · tx ${shortAddress(hash)}`);
  }

  function buildChainTx(method, args, signer) {
    const priceWei = book._sharePriceWei || 0n;
    switch (method) {
      case "buy": return chainTx.buy(signer, BigInt(args.shares), BigInt(args.shares) * priceWei);
      case "claim": return chainTx.claim(signer, args?.campaign);
      case "harvest": return chainTx.harvest(signer);
      case "refund": return chainTx.refund(signer, args?.campaign);
      case "listShares": return chainTx.listShares(signer, BigInt(args.shares), parseEther(String(args.priceBnbPerShare)));
      case "cancelListing": return chainTx.cancelListing(signer, Number(args.listingId));
      case "takeListing": {
        const l = (book.listings || []).find((x) => String(x.id) === String(args.listingId));
        const wei = l && l._priceWei ? l._priceWei : 0n;
        return chainTx.takeListing(signer, Number(args.listingId), BigInt(args.shares), BigInt(args.shares) * wei);
      }
      case "cancelTransistorOrder": return chainTx.cancelTransistorOrder(signer);
      case "confirmTransistors": return chainTx.confirmTransistors(signer);
      case "setPlan": {
        const count = BigInt(args.count || (chainEst && chainEst.usedParts) || book.transistorCount || 0);
        const estHp = BigInt(Math.round(args.hashpower ?? ((chainEst && chainEst.hashpower) || 0)));
        return chainTx.setPlan(signer, estHp, Boolean(args.capped), count);
      }
      case "updateNetworkWeight":
        return chainTx.updateNetworkWeight(signer, BigInt(args.verified), BigInt(args.unverified));
      case "execute":
        if (!netlistMatch) throw new Error("网表不匹配，无法 execute（检查 netlistHash）");
        return chainTx.execute(signer, RAW_NETLIST, START_DATA);
      default: throw new Error("链上模式暂不支持：" + method);
    }
  }

  /** 页面按钮：包一层 loading 动画再调 invokeCall。链上写操作自管 pending，不套 run()。 */
  function act(method, args) {
    if (chain.active) {
      invokeCall(method, args);
      return;
    }
    run(method === "buy" ? "购买中" : "处理中", () => invokeCall(method, args));
  }

  function approve() {
    if (chain.active) {
      // 原生 BNB，无需 ERC20 approve
      act("buy", { shares: book.picked });
      return;
    }
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
    if (chain.active) {
      act("buy", { shares: book.picked });
      return;
    }
    if (!book.approved) {
      approve();
      return;
    }
    act("buy", { shares: book.picked });
  }

  function handlePick(picked) {
    if (chain.active) {
      chain.setPicked(picked);
      return;
    }
    setSimBook((current) => ({ ...current, picked }));
  }

  /** 连接钱包：链上模式拉起注入式钱包并切到目标链；模拟模式直接置已连接。 */
  function handleConnect() {
    if (chain.active) {
      chain.connect().catch((e) => setNotice(e.message || "连接失败"));
      return;
    }
    setSimConnected(true);
    setNotice("已连接钱包");
  }

  function handleCreate(draft, review) {
    if (chain.active) {
      if (!chain.account && !chain.signer) {
        setNotice("请先连 Factory Owner 钱包再发布");
        handleConnect();
        return;
      }
      if (
        factoryOwner &&
        chain.account &&
        String(chain.account).toLowerCase() !== String(factoryOwner).toLowerCase()
      ) {
        setNotice(`发布须 Factory Owner 签名：${shortAddress(factoryOwner)}（当前 ${shortAddress(chain.account)}）`);
        return;
      }
      invokeCall("createCampaign", { ...draft, _review: review });
      return;
    }
    const result = applyCreate(round, draft, quote, taskbook);
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    setSimRound(result.round);
    setSimBook(result.book);
    setOwnerTab("overview");
    setPage("owner");
    setNotice(result.message);
  }

  function openPage(id, ownerSub) {
    setPage(id);
    if (id === "owner") setOwnerTab(ownerSub || "overview");
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
          <div className="menu-group-title">生命周期</div>
          {LIFE_PAGES.map((item) => {
            if (item.id === "owner") {
              const onOwner = page === "owner";
              const onOverview = onOwner && ownerTab === "overview";
              const onCreate = onOwner && ownerTab === "create";
              return (
                <div key={item.id} className="nav-group">
                  <button
                    className={onOwner ? "nav-link nav-parent-on" : "nav-link"}
                    onClick={() => openPage("owner", "overview")}
                    type="button"
                    title={item.hint}
                  >
                    <span className="nav-link-main">{item.label}</span>
                    <span className="nav-link-hint">{item.hint}</span>
                  </button>
                  <div className="nav-children">
                    <button
                      className={onOverview ? "nav-sub active" : "nav-sub"}
                      onClick={() => openPage("owner", "overview")}
                      type="button"
                    >
                      众筹挖矿列表
                    </button>
                    <button
                      className={onCreate ? "nav-sub active" : "nav-sub"}
                      onClick={() => openPage("owner", "create")}
                      type="button"
                    >
                      发布众筹挖矿
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <button
                key={item.id}
                className={page === item.id ? "nav-link active" : "nav-link"}
                onClick={() => openPage(item.id)}
                type="button"
                title={item.hint}
              >
                <span className="nav-link-main">{item.label}</span>
                <span className="nav-link-hint">{item.hint}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <p className="sidebar-copy">© 2026 TapeOut 众筹挖矿</p>
        </div>
      </aside>

      <main className="main-content">
        {chain.active ? (
          <>
            <header className="app-topbar">
              <div className="topbar-left">
                {chainBooting && <span className="topbar-muted">读取中…</span>}
              </div>
              <div className="topbar-wallet">
                <div className="wallet-menu">
                  {usingChain && chain.account ? (
                    <button className="wallet-chip" type="button">
                      <span className="topbar-role">{actor.label}</span>
                      {shortAddress(account)}
                    </button>
                  ) : (
                    <button className="btn btn-primary" type="button" onClick={handleConnect} disabled={!hasInjected()}>
                      连接钱包
                    </button>
                  )}
                  <div className="wallet-pop" role="dialog" aria-label="钱包详情">
                    <div className="wallet-pop-head">
                      <span className="topbar-net">{NETWORK.name} · {CHAIN_ID}</span>
                      <button className="wallet-refresh" type="button" onClick={chain.refresh}>刷新</button>
                    </div>
                    <div className="wallet-pop-body">
                      {usingChain && chain.account ? (
                        <>
                          <div className="wallet-addr">
                            <div className="wallet-addr-top">
                              <div>
                                <span>当前钱包 · {actor.label}</span>
                                <strong>{shortAddress(account)}</strong>
                              </div>
                              <button
                                className="wallet-copy"
                                type="button"
                                onClick={() => {
                                  const done = () => setNotice("已复制钱包地址");
                                  if (navigator.clipboard?.writeText) {
                                    navigator.clipboard.writeText(account).then(done).catch(() => setNotice("复制失败"));
                                  } else {
                                    setNotice("复制失败");
                                  }
                                }}
                              >
                                复制地址
                              </button>
                            </div>
                            <code>{account}</code>
                          </div>
                          <dl className="wallet-stats">
                            <div><dt>BNB</dt><dd>{Number(book.bnb || 0).toFixed(4)}</dd></div>
                            <div><dt>BEM</dt><dd>{formatBem(book.bemBalance || 0)}</dd></div>
                            <div><dt>本期份额</dt><dd>{(book.mine || 0) + (book.listingShares || 0)} 份</dd></div>
                          </dl>
                          <button
                            className="wallet-disconnect"
                            type="button"
                            onClick={() => { chain.disconnect(); setNotice("已断开钱包"); }}
                          >
                            断开连接
                          </button>
                        </>
                      ) : (
                        <p className="wallet-pop-label">尚未连接。连接后可查看余额并签名。</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </header>
            {!hasInjected() && !chain.account && (
              <p className="topbar-alert">未检测到钱包插件。请用安装了 MetaMask 的浏览器打开，并切换到 BSC 测试网。当前只能查看链上数据。</p>
            )}
            {chain.error && <p className="topbar-alert">{chain.error}</p>}
          </>
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
                <option value={OWNER}>Factory Owner</option>
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
        {chainBooting && (
          <section>
            <div className="empty">
              <p>{chain.error ? `链上读取失败：${chain.error}` : "正在从 BSC 测试网读取 Campaign 状态…"}</p>
              {chain.error && (
                <button className="btn btn-primary" type="button" onClick={chain.refresh}>重试</button>
              )}
            </div>
          </section>
        )}
        {!chainBooting && page === "round" && (
          <RoundHub
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
            actor={actor}
            onChain={usingChain}
            onPick={handlePick}
            onBuy={buy}
            onAbort={() => act("abortUnaffordable")}
            onClaim={() => act("claim")}
            onHarvest={() => act("harvest")}
            onOpenOwner={() => openPage("owner", "overview")}
            onOpenAssets={() => openPage("assets")}
            usingChain={usingChain}
            periods={usingChain ? chain.campaigns : []}
            onSwitchPeriod={usingChain ? chain.switchCampaign : null}
          />
        )}
        {!chainBooting && page === "assets" && (
          <AssetsHub
            round={round}
            book={book}
            copy={copy}
            actor={actor}
            account={account}
            pending={pending}
            connected={connected}
            usingChain={usingChain}
            positions={usingChain ? chain.positions : null}
            positionsLoading={usingChain ? chain.positionsLoading : false}
            onClaim={(address) => act("claim", { campaign: address })}
            onRefund={(address) => act("refund", { campaign: address })}
            onBrowse={() => openPage("round")}
            onOpenPeriod={async (address) => {
              if (usingChain && address) await chain.switchCampaign(address);
              openPage("round");
            }}
            onConnect={handleConnect}
            onList={(args) => act("listShares", args)}
            onCancel={(id) => act("cancelListing", { listingId: id })}
            onTake={(args) => act("takeListing", args)}
          />
        )}
        {!chainBooting && page === "owner" && (
          <OwnerDesk
            tab={ownerTab}
            onTab={setOwnerTab}
            tabs={OWNER_TABS}
            round={round}
            book={book}
            copy={copy}
            quote={quote}
            taskbook={taskbook}
            pending={pending}
            actor={actor}
            account={account}
            executeWait={executeWait}
            connected={connected}
            usingChain={usingChain}
            chain={chain}
            factoryOwner={factoryOwner}
            chainHolders={chainHolders}
            now={now}
            onPlaceTransistorOrder={() => act("placeTransistorOrder")}
            onAbortUnaffordable={() => act("abortUnaffordable")}
            onCancelTransistorOrder={() => act("cancelTransistorOrder")}
            onConfirmTransistors={() => act("confirmTransistors")}
            onExecute={() => act("execute")}
            onHarvest={() => act("harvest")}
            onSetPlan={() => act("setPlan")}
            onOpenRound={() => openPage("round")}
            onOpenAssets={() => openPage("assets")}
            onCreate={handleCreate}
            onConnect={handleConnect}
            onInvoke={invokeCall}
          />
        )}
        {!chainBooting && page === "rules" && <RulesPage round={round} book={book} quote={quote} taskbook={taskbook} />}
      </main>

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function PeriodNav({ periods, currentId, onSwitch }) {
  const ordered = [...(periods || [])]
    .filter((item) => item && item.address)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!ordered.length || !onSwitch) return null;
  const index = ordered.findIndex((item) => String(item.id) === String(currentId));
  const current = index >= 0 ? ordered[index] : null;
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
  const go = (row) => {
    setOpen(false);
    if (row && String(row.id) !== String(currentId)) onSwitch(row.address);
  };
  return (
    <div className={`period-nav${open ? " is-open" : ""}`} ref={rootRef} aria-label="切换期次">
      <button className="period-nav-btn" type="button" aria-label="上一期" disabled={!prev} onClick={() => go(prev)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M14.5 6.5 9 12l5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        className="period-nav-current"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        第 {current ? current.id : "—"} 期
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button className="period-nav-btn" type="button" aria-label="下一期" disabled={!next} onClick={() => go(next)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M9.5 6.5 15 12l-5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul className="period-menu" role="listbox">
          {ordered.map((item) => {
            const on = String(item.id) === String(currentId);
            return (
              <li key={item.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={on ? "is-on" : ""}
                  onClick={() => go(item)}
                >
                  第 {item.id} 期
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function RoundTitle({ id, lead, badge, tone, phase, periods, onSwitchPeriod, processor }) {
  const hasNav = Array.isArray(periods) && periods.length > 0 && onSwitchPeriod;
  return (
    <header className="round-hero">
      <div className="round-hero-row">
        <div className="round-title">
          <span className="round-mark" title={processor || "挖矿类型"}>
            <ProcessorGlyph name={processor} size={18} />
          </span>
          <h1>BEM众筹挖矿</h1>
          {!hasNav && <span className="round-period">第 {id} 期{phase ? ` · ${phase}` : ""}</span>}
          <span className={`badge tone-${tone}`}>{badge}</span>
        </div>
        {hasNav ? <PeriodNav periods={periods} currentId={id} onSwitch={onSwitchPeriod} /> : null}
      </div>
      {lead ? <p className="round-hero-lead">{lead}</p> : null}
    </header>
  );
}

/** 生命周期进度条：募集 → 待执行 → 挖矿 */
function LifecycleStrip({ scene, phase }) {
  const steps = [
    { id: "funding", label: "募集中" },
    { id: "executing", label: "待执行" },
    { id: "mining", label: "挖矿中" },
  ];
  const idx = Math.max(0, steps.findIndex((s) => s.id === scene));
  const phaseHint =
    scene === "executing"
      ? phase === "ready"
        ? "晶体管已到账 · 待流片"
        : phase === "listed"
          ? "挂单中"
          : "待挂单买晶体管"
      : null;
  return (
    <div className="life-strip" aria-label="本期生命周期">
      {steps.map((step, i) => (
        <div key={step.id} className="life-step-wrap">
          <div className={`life-step${i < idx ? " is-done" : ""}${i === idx ? " is-active" : ""}`}>
            <span className="life-dot">{i + 1}</span>
            <span className="life-text">
              <span className="life-label">{step.label}</span>
              {step.id === "executing" && phaseHint ? <span className="life-phase">{phaseHint}</span> : null}
            </span>
          </div>
          {i < steps.length - 1 && <span className={`life-line${i < idx ? " is-done" : ""}`} aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}

/** 本期：随 funding / executing / mining 切换主内容 */
function RoundHub({
  round, book, copy, quote, taskbook, remaining, pay, countdown, executeWait,
  pending, connected, actor, onChain, onPick, onBuy, onAbort, onClaim, onHarvest, onOpenOwner, onOpenAssets,
  usingChain = false, periods, onSwitchPeriod,
}) {
  const netW = book.capped ? book.netWeightUnverified : book.netWeightVerified;
  const harvest = computeHarvest(round, book, book.selfAddress, Number.isFinite(netW) ? netW : null);
  const dailyBem = book._chain && book.dailyBem != null ? book.dailyBem : harvest.dailyBem;
  const waitHours = Math.ceil((executeWait || 0) / 3600_000);
  const execEst = book.estimate || {};
  const isOwner = actor?.role === "owner";

  return (
    <>
      <LifecycleStrip scene={book.scene} phase={book.executePhase} />

      {book.scene === "funding" && (
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
            onChain={onChain}
            onPick={onPick}
            onBuy={onBuy}
            usingChain={usingChain}
            periods={periods}
            onSwitchPeriod={onSwitchPeriod}
          />
        )}

      {book.scene === "executing" && (
        <section>
          <RoundTitle
            id={round.id}
            phase="待执行"
            lead="份数已售罄。买得起晶体管就挂单；买不起时 Factory Owner 可发起退款，持份人再到「我的资产」原路退还。"
            badge={copy.badge}
            tone={copy.tone}
            periods={periods}
            onSwitchPeriod={onSwitchPeriod}
            processor={estimateHashpower(round, quote, round.totalShares, taskbook).processor || round.processorId}
          />
          <RoundFacts round={round} book={book} quote={quote} taskbook={taskbook} />
          <article className="card progress-card">
            <div className="card-header">当前进度</div>
            <div className="card-body">
              <Pipeline scene={book.scene} phase={book.executePhase} />
              <ul className="bill">
                <li><span>已售</span><strong>{book.sold} / {round.totalShares} 份</strong></li>
                <li><span>托管 BNB</span><strong>{round4(book.bnbPool || 0)} BNB</strong></li>
                <li><span>晶体管子态</span><strong>{
                  book.executePhase === "ready" ? "已到账 · 待流片"
                    : book.executePhase === "listed" ? "挂单中"
                      : "待挂单"
                }</strong></li>
                <li><span>退款</span><strong style={book.executionFailed || (execEst.usedParts > 0 && execEst.capCoversFloor === false) ? { color: "var(--color-danger)" } : undefined}>{
                  book.executionFailed
                    ? "已开放 · 持份人可原路退还"
                    : book.executePhase !== "buying"
                      ? "请先取消挂单"
                      : execEst.usedParts > 0 && execEst.capCoversFloor === false
                        ? "买不起晶体管 · Owner 可发起"
                        : "买得起，不需要退款"
                }</strong></li>
                <li className="wait"><span>观察期</span><strong>{
                  executeWait > 0 ? `还剩约 ${waitHours} 小时` : "已满，可流片"
                }</strong></li>
                {book.executionFailed && (
                  <li className="due"><span>流片</span><strong style={{ color: "var(--color-danger)" }}>已失败 · 可原路退款</strong></li>
                )}
              </ul>
              <p className="fine">
                {book.executionFailed
                  ? "退款已开放。持份人到「我的资产」原路退还 BNB。"
                  : execEst.capCoversFloor === false && book.executePhase === "buying"
                    ? "当前报价买不起晶体管。Factory Owner 可发起退款；买得起时只能挂单。"
                    : "用户侧等待流片。失败后到「我的资产」退款。流片操作在 Owner 工作台。"}
              </p>
              <div className="actions">
                {isOwner && book.executePhase === "buying" && !book.executionFailed && (
                  <>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={Boolean(pending) || execEst.capCoversFloor === false}
                      onClick={() => onOpenOwner()}
                    >
                      去 Owner 工作台 · 挂单
                    </button>
                    <button
                      className="btn btn-inline"
                      type="button"
                      disabled={Boolean(pending) || execEst.capCoversFloor !== false}
                      onClick={onAbort}
                    >
                      {pending || "退款"}
                    </button>
                  </>
                )}
                {isOwner && book.executePhase !== "buying" && (
                  <button className="btn btn-primary" type="button" onClick={onOpenOwner}>
                    去 Owner 工作台 · 流片
                  </button>
                )}
                <button className="btn btn-inline" type="button" onClick={onOpenAssets}>
                  我的资产
                </button>
              </div>
            </div>
          </article>
        </section>
      )}

      {book.scene === "mining" && (
        <section>
          <RoundTitle
            id={round.id}
            phase="挖矿中"
            lead="按份分发 BEM。主动退出请走「我的资产」份额转让；合约不提供本金赎回。"
            badge={copy.badge}
            tone={copy.tone}
            periods={periods}
            onSwitchPeriod={onSwitchPeriod}
            processor={round.processorId}
          />
          <div className="stat-grid">
            <article className="stat-card accent">
              <div className="stat-label">实际算力</div>
              <div className="stat-value">{(book.hashpower || 0).toLocaleString("zh-CN")} H</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">日产{book._chain ? "（链上）" : ""}</div>
              <div className="stat-value">{formatBem(dailyBem)} BEM</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">我的可领</div>
              <div className="stat-value">{formatBem(book.claimable)} BEM</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">已分发轮数</div>
              <div className="stat-value">{book.harvestCount || harvest.rounds || 0}</div>
            </article>
          </div>
          <article className="card">
            <div className="card-header">领取</div>
            <div className="card-body">
              <div className="actions">
                <button className="btn btn-primary" type="button" disabled={!connected || Boolean(pending)} onClick={onHarvest}>
                  {pending === "harvest" ? "分发中…" : "全网分发 harvest"}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!connected || book.claimable <= 0 || Boolean(pending)}
                  onClick={onClaim}
                >
                  {pending === "claim" ? "领取中…" : `领取 ${formatBem(book.claimable)} BEM`}
                </button>
                <button className="btn btn-inline" type="button" onClick={onOpenAssets}>
                  份额转让
                </button>
              </div>
              <p className="fine" style={{ marginTop: 10 }}>
                harvest 累计全网一轮净产出；claim 只领本钱包 pending。次数不限，只要还在出矿。
              </p>
            </div>
          </article>
        </section>
      )}
    </>
  );
}

/** 我的资产：工厂里每一期各读一次，不跟顶栏当前期走。 */
function AssetsHub({
  round, book, copy, actor, account, pending, connected, usingChain,
  positions, positionsLoading,
  onClaim, onRefund, onBrowse, onOpenPeriod, onConnect, onList, onCancel, onTake,
}) {
  const rows = usingChain
    ? (positions || [])
    : [{
        id: round.id,
        address: round.contract,
        scene: book.scene,
        sceneLabel: copy.badge,
        sold: book.sold,
        totalShares: round.totalShares,
        sharePriceBnb: round.sharePriceBnb,
        executionFailed: Boolean(book.executionFailed),
        fundingDeadline: book.endsAt ? Math.floor(book.endsAt / 1000) : 0,
        shares: connected ? book.mine : null,
        pendingBem: book.claimable || 0,
        refundedBnb: book.refundedSelf || 0,
      }];
  const held = rows.filter((row) => Number(row.shares) > 0);
  const shareSum = held.reduce((sum, row) => sum + Number(row.shares || 0), 0);
  const bemSum = rows.reduce((sum, row) => sum + Number(row.pendingBem || 0), 0);
  const nowSec = Date.now() / 1000;

  return (
    <section>
      <header className="round-hero">
        <div className="round-hero-row">
          <div className="round-title">
            <span className="round-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <rect x="3.5" y="6" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.5" />
                <path d="M16 14.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
            <h1>我的资产</h1>
          </div>
        </div>
        <p className="round-hero-lead">
          列出工厂中的每一期。连接钱包后显示你在各期的份数、可领和可退，不跟随当前选中的那一期。
        </p>
      </header>

      {!connected && (
        <div className="empty">
          <p>连接钱包后才能读取你在每一期的份数。</p>
          <button className="btn btn-primary" type="button" onClick={onConnect}>
            连接钱包
          </button>
        </div>
      )}

      <div className="holding-grid">
        <article className="stat-card accent">
          <div className="stat-label">期次</div>
          <div className="stat-value">{rows.length} 期</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">我持有的期</div>
          <div className="stat-value">{connected ? `${held.length} 期` : "—"}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">合计份数</div>
          <div className="stat-value">{connected ? `${shareSum} 份` : "—"}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">合计可领</div>
          <div className="stat-value">{connected ? `${formatBem(bemSum)} BEM` : "—"}</div>
        </article>
      </div>

      <article className="card">
        <div className="card-header">全部期次</div>
        <div className="card-body table-wrap">
          {positionsLoading && rows.length === 0 ? (
            <p className="fine">正在读取全部期次…</p>
          ) : rows.length === 0 ? (
            <p className="fine">工厂里还没有期次。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>期次</th>
                  <th>状态</th>
                  <th>募集</th>
                  <th>我的份数</th>
                  <th>可领</th>
                  <th>已退</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const canRefund = connected && row.shares > 0 && (
                    (row.scene === "funding" && row.fundingDeadline > 0 && nowSec > row.fundingDeadline && row.sold < row.totalShares)
                    || (row.scene === "executing" && row.executionFailed)
                  );
                  const canClaim = connected && row.scene === "mining" && row.pendingBem > 0;
                  const tone = row.scene === "mining" ? "mine" : row.scene === "executing" ? "wait" : "live";
                  return (
                    <tr key={row.address || row.id}>
                      <td>第 {row.id} 期</td>
                      <td><span className={`badge tone-${tone}`}>{row.sceneLabel}</span></td>
                      <td>{row.totalShares ? `${row.sold}/${row.totalShares}` : "—"}</td>
                      <td>{row.shares == null ? "—" : `${row.shares} 份`}</td>
                      <td>{connected ? `${formatBem(row.pendingBem || 0)} BEM` : "—"}</td>
                      <td>{connected ? `${round4(row.refundedBnb || 0)} BNB` : "—"}</td>
                      <td>
                        <div className="actions assets-actions">
                          <button className="btn btn-inline" type="button" onClick={() => onOpenPeriod(row.address)}>
                            打开
                          </button>
                          {canClaim && (
                            <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={() => onClaim(row.address)}>
                              {pending || "领取"}
                            </button>
                          )}
                          {canRefund && (
                            <button className="btn btn-inline" type="button" disabled={Boolean(pending)} onClick={() => onRefund(row.address)}>
                              {pending || "退款"}
                            </button>
                          )}
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

      {book.scene === "mining" ? (
        <TransferPage
          round={round}
          book={book}
          copy={copy}
          actor={actor}
          account={account}
          pending={pending}
          connected={connected}
          onList={onList}
          onCancel={onCancel}
          onTake={onTake}
          onBrowse={onBrowse}
          onConnect={onConnect}
          embedded
        />
      ) : (
        <article className="card">
          <div className="card-header">份额转让</div>
          <div className="card-body">
            <p className="fine">份额转让只在挖矿中的期次开放。先在上表打开那一期，再回来挂牌。</p>
          </div>
        </article>
      )}
    </section>
  );
}

/** Owner 工作台：开期 / 流片 / 持有人 / 调用 / 调试 */
function OwnerDesk({
  tab, onTab, tabs, round, book, copy, quote, taskbook, pending, actor, account,
  executeWait, connected, usingChain, chain, factoryOwner, chainHolders, now,
  onPlaceTransistorOrder, onAbortUnaffordable, onCancelTransistorOrder, onConfirmTransistors, onExecute, onHarvest, onSetPlan,
  onOpenRound, onOpenAssets,
  onCreate, onConnect, onInvoke,
}) {
  return (
    <section>
      {tab !== "create" && tab !== "overview" && (
        <header className="desk-page">
          <p className="desk-kicker">工作台</p>
          <h1>Owner 工作台</h1>
          <p>发布与管理各期 BEM 众筹挖矿。份额、调用和链上调试在对应一期的详情里。</p>
        </header>
      )}
      {tabs.length > 1 && (
        <div className="desk-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "desk-tab is-on" : "desk-tab"}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {tab === "overview" && (
        <OwnerOverview
          round={round}
          book={book}
          copy={copy}
          quote={quote}
          taskbook={taskbook}
          pending={pending}
          actor={actor}
          executeWait={executeWait}
          history={usingChain ? chain.campaigns : null}
          onSwitchCampaign={usingChain ? chain.switchCampaign : null}
          onPlaceTransistorOrder={onPlaceTransistorOrder}
          onAbortUnaffordable={onAbortUnaffordable}
          onCancelTransistorOrder={onCancelTransistorOrder}
          onConfirmTransistors={onConfirmTransistors}
          onExecute={onExecute}
          onHarvest={onHarvest}
          onSetPlan={onSetPlan}
          onOpenRound={onOpenRound}
          onOpenAssets={onOpenAssets}
          account={account}
          connected={connected}
          chainHolders={chainHolders}
          onInvoke={onInvoke}
        />
      )}
      {tab === "create" && (
        <OwnerCreate
          pending={pending}
          snapshot={quote}
          taskbook={taskbook}
          now={now}
          chainMode={Boolean(chain?.active)}
          factoryOwner={factoryOwner}
          connectedAccount={chain?.account || ""}
          defaultFeeRecipient={chain?.account || factoryOwner || deployments.deployer || ""}
          onCreate={onCreate}
          onConnect={onConnect}
        />
      )}
    </section>
  );
}

function ProcessorGlyph({ name, size = 18 }) {
  const behemoth = name === "Behemoth";
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M12 3.2 19.2 9 12 20.8 4.8 9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M4.8 9h14.4" stroke="currentColor" strokeWidth="1.5" />
      {behemoth
        ? <path d="M12 3.2 9.4 9 12 20.8 14.6 9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        : <path d="M12 3.2v17.6" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

function RoundFacts({ round, book, quote, taskbook }) {
  const est = estimateHashpower(round, quote, round.totalShares, taskbook);
  const executed = book.hashpower > 0;
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  const harvest = computeHarvest(round, book);
  return (
    <>
      <div className="stat-grid facts">
        <article className="stat-card">
          <div className="stat-label">题目</div>
          <div className="stat-value">
            #{round.taskId ?? est.task?.id ?? "—"} {est.task?.missing ? "题库未收录" : (est.taskName || round.taskName || "—")}
          </div>
          <div className="stat-note">
            {est.taskTier || ""}
            {est.usedParts ? ` · ${est.usedParts} 元件` : ""}
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-label">目标处理器</div>
          <div className="stat-value processor-value">
            <span>{est.processor || round.processorId || "—"}</span>
            <span className="processor-scale">P={est.processorScale || "—"}</span>
          </div>
        </article>
        <article className="stat-card">
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
            <div className="stat-value">{formatBem(harvest.dailyBem)} BEM</div>
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
            <div className="stat-value">已领 {harvest.rounds} 次 · 次数不限</div>
          </article>
        </div>
      ) : (
        <div className="stat-grid">
          <article className="stat-card">
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
            <div className="stat-value">{formatBem(est.dailyBem * (1 - feeRate(round)))} BEM</div>
          </article>
          <article className="stat-card wide-stat note-card">
            <div className="stat-label">预估随报价浮动，不是承诺</div>
            <p className="note-copy">
              募资总额 {est.hardCapBnb.toFixed(4)} BNB，按 {est.processor} 当前报价（NAND {est.priceNand.toFixed(4)}{est.latch > 0 ? ` / LATCH ${est.priceLatch.toFixed(4)}` : ""} BNB，混合均价{" "}
              {est.usedParts > 0 ? (est.needBnb / est.usedParts).toFixed(4) : "0.0000"} BNB/个）可买 {est.affordableParts} 个；本期题目 {est.usedParts} 个元件（
              {est.nand} NAND + {est.latch} LATCH{est.latch === 0 ? "，纯组合逻辑" : ""}），权重 H ={" "}
              {est.hashpower} = {est.usedParts} ×{est.processorScale}
              {est.optimal ? ` + 溢价 ${est.refParts}×${est.q}` : "（非最优，无设计溢价）"}。
              若执行时元件涨价导致募资总额买不够所需元件，本期全额退款。
            </p>
          </article>
        </div>
      )}
    </>
  );
}

function ProductPage({ round, book, copy, quote, taskbook, remaining, pay, countdown, executeWait, pending, connected, onPick, onBuy, onChain = false, usingChain = false, periods, onSwitchPeriod }) {
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
      <RoundTitle
        id={round.id}
        lead={copy.lead}
        badge={copy.badge}
        tone={copy.tone}
        periods={periods}
        onSwitchPeriod={onSwitchPeriod}
        processor={est.processor || round.processorId}
      />

      <RoundFacts round={round} book={book} quote={quote} taskbook={taskbook} />

      <div className="layout">
        <article className="card">
          <div className="card-header">募集进度</div>
          <div className="card-body">
            <div className="raise-progress">
              <div className="progress-label">
                <span>已售 {book.sold} / {round.totalShares} 份</span>
                <strong>{progress}%</strong>
              </div>
              <div className="track track-raise" aria-hidden="true">
                <i style={{ width: `${progress}%` }} />
              </div>
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
                      : "晶体管已到位。观察期已满后，持份用户 Factory Owner 均可触发 execute，一旦执行资金即转为 BNB 并烧掉晶体管。"
                    : "本期份数已售完。Factory Owner 需手动调用 tapeout.net 挂单逻辑买入晶体管，到账后再确认成交并触发流片开矿——合约无法替人工操作 tapeout.net，需由 Owner 发起链上交易完成。"}
                </p>
              )}
              <p className="mono">{shortAddress(round.contract)} · {onChain ? "链上合约" : "预览地址"}</p>
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
            <RecentBuys round={round} book={book} usingChain={usingChain || onChain} account={book.selfAddress} />
          </div>
        </article>
      </div>
    </section>
  );
}

function PortfolioPage({ round, book, copy, actor, pending, connected, onClaim, onRefund, onBrowse, onConnect, embedded = false }) {
  const cost = book.mine * round.sharePriceBnb;
  const harvest = computeHarvest(round, book);
  const showClaim = book.scene === "mining" && book.claimable > 0;
  const isOwner = actor?.role === "owner";

  return (
    <section className={embedded ? "embedded-block" : undefined}>
      {!embedded && (
        <header className="page-header">
          <div>
            <h1>我的份数</h1>
            <p className="page-subtitle">{connected ? copy.lead : "连接钱包后查看这一期的份数和可领收益。"}</p>
          </div>
          <span className={`badge tone-${copy.tone}`}>{copy.badge}</span>
        </header>
      )}
      {embedded && <h2 className="embedded-title">持仓与领取</h2>}

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
                      {book.mine}/{round.totalShares} = {((harvest.share || 0) * 100).toFixed(2)}%
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

function TransferPage({ round, book, copy, actor, account, pending, connected, onList, onCancel, onTake, onBrowse, onConnect, embedded = false }) {
  const [pickShares, setPickShares] = useState(1);
  const [price, setPrice] = useState(String(round.sharePriceBnb));
  const available = book.mine;
  const canTransfer = book.scene === "mining";
  const canPublish = available > 0 && canTransfer;
  const myListings = (book.listings || []).filter(
    (l) => String(l.seller).toLowerCase() === String(account).toLowerCase(),
  );

  return (
    <section className={embedded ? "embedded-block" : undefined}>
      {!embedded && (
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
      )}
      {embedded && <h2 className="embedded-title">份额转让</h2>}

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

function RecentBuys({ round, book, usingChain = false, account = "" }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!usingChain) {
      setRows(buildHolders(book.sold, book.mine).slice(0, 5));
      return undefined;
    }
    let alive = true;
    readRecentBuys(8)
      .then((list) => {
        if (!alive) return;
        const me = String(account || "").toLowerCase();
        setRows(
          list.map((r) => ({
            address: r.address,
            shares: r.shares,
            paid: r.paidBnb,
            self: me && r.address === me,
          }))
        );
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [usingChain, book.sold, account]);

  if (rows == null) return <p className="fine">加载最近认购…</p>;
  if (!rows.length) return <p className="fine">链上暂无认购记录。</p>;
  return (
    <div className="recent">
      <p className="fine">最近认购{usingChain ? "（链上事件）" : ""}</p>
      <ul className="bill">
        {rows.map((row) => (
          <li key={`${row.address}-${row.shares}-${row.paid ?? row.shares}`}>
            <span>{row.self ? "当前钱包" : shortAddress(row.address)}</span>
            <strong>
              {row.shares} 份 · {(row.paid != null ? row.paid : row.shares * round.sharePriceBnb).toFixed(4)} BNB
            </strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RulesPage({ round, book, quote, taskbook }) {
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  const netW = book.capped ? book.netWeightUnverified : book.netWeightVerified;
  const harvest = computeHarvest(round, book, book.selfAddress, Number.isFinite(netW) ? netW : null);
  const dailyBem = book._chain && book.dailyBem != null ? book.dailyBem : harvest.dailyBem;
  const weightVerified = Number.isFinite(book.netWeightVerified) ? book.netWeightVerified : NETWORK_WEIGHT.verified;
  const weightUnverified = Number.isFinite(book.netWeightUnverified) ? book.netWeightUnverified : NETWORK_WEIGHT.unverified;
  const est = estimateHashpower(round, quote, round.totalShares, taskbook);
  const delayH = round.executeDelayHours ?? 48;
  const sceneLabel = { funding: "募集中", executing: "待执行", mining: "挖矿中" }[book.scene] || book.scene;
  const phaseLabel =
    book.scene !== "executing"
      ? "—"
      : book.executePhase === "ready"
        ? "已到账 · 待流片"
        : book.executePhase === "listed"
          ? "挂单中"
          : "待挂单";

  const flow = [
    { id: "funding", kicker: "01", title: "募集", body: "整数份认购，BNB 进托管池" },
    { id: "executing", kicker: "02", title: "待执行", body: "晶体管到位并过观察期" },
    { id: "mining", kicker: "03", title: "挖矿", body: "按份分发 BEM，可转让退出" },
  ];
  const flowIdx = Math.max(0, flow.findIndex((s) => s.id === book.scene));

  return (
    <section className="rules-page">
      <header className="rules-hero">
        <div>
          <p className="rules-kicker">资金路径 · 退出规则</p>
          <h1>这一期怎么走</h1>
          <p>
            认购款先托管。售罄后才流片。没有本金赎回，退出只有退款和挖矿中的份额转让。
          </p>
        </div>
        <div className="rules-hero-side">
          <span className={`badge tone-${SCENE_COPY[book.scene]?.tone || "live"}`}>{sceneLabel}</span>
          <span className="rules-contract mono">{shortAddress(round.contract)}</span>
          {book.scene === "executing" && <span className="rules-phase">{phaseLabel}</span>}
        </div>
      </header>

      <div className="rules-kpi">
        {[
          ["每份", `${round.sharePriceBnb.toFixed(4)} BNB`],
          ["总份 / 已售", `${round.totalShares} / ${book.sold}`],
          ["募资总额", `${hardCap.toFixed(4)} BNB`],
          ["托管池", `${round4(book.bnbPool || 0)} BNB`],
          ["服务费", `${round.feeBps / 100}%`],
          ["募集 / 观察", `${round.fundingDays} 天 · ${delayH}h`],
        ].map(([label, value]) => (
          <div className="rules-kpi-item" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="rules-flow" aria-label="生命周期">
        {flow.map((step, i) => (
          <div
            key={step.id}
            className={`rules-flow-step${i < flowIdx ? " is-done" : ""}${i === flowIdx ? " is-active" : ""}`}
          >
            <span className="rules-flow-kicker">{step.kicker}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </div>
        ))}
      </div>
      <p className="rules-note">
        题目 #{round.taskId}。直接转账不会记份，只能按份认购。售罄后进入待执行并开始观察期。
      </p>

      <div className="rules-grid">
        <article className="rules-panel">
          <header>
            <span>退出</span>
            <h2>两条路径，互不交叉</h2>
          </header>
          <div className="rules-path is-safe">
            <em>被动 · 退款</em>
            <p>募集超时未售罄，或流片失败且本金未支出。按认购价原路退回，份额清零。</p>
          </div>
          <div className="rules-path is-exit">
            <em>主动 · 份额转让</em>
            <p>仅挖矿中。挂单立刻锁定份额，成交时买方 BNB 直接付给卖方，不进托管池。</p>
          </div>
          <p className="rules-note">募集中和待执行不能挂牌，也不能赎回本金或收益。</p>
        </article>

        <article className="rules-panel">
          <header>
            <span>待执行</span>
            <h2>晶体管到位后才能流片</h2>
          </header>
          <ol className="rules-steps">
            <li className={book.scene === "executing" && book.executePhase === "buying" ? "is-on" : ""}>挂单并锁价</li>
            <li className={book.scene === "executing" && book.executePhase === "listed" ? "is-on" : ""}>确认到账</li>
            <li>观察 {delayH} 小时</li>
            <li className={book.scene === "executing" && book.executePhase === "ready" ? "is-on" : ""}>Owner 流片开矿</li>
          </ol>
          <p>
            流片不可逆，按锁定报价结算。买得起就开矿；买不起则判失败，本金不动，用户可退款，Owner 可降价重试。
          </p>
          <p className="rules-note">
            二级市场无法由合约自动下单，须 Owner 钱包发起交易。
            {book.scene === "executing" ? `当前：${phaseLabel}。` : ""}
          </p>
        </article>

        <article className="rules-panel rules-panel-wide">
          <header>
            <span>挖矿与产出</span>
            <h2>全网分发一轮，各领各的</h2>
          </header>
          <div className="rules-formula">
            <span>个人可领</span>
            <strong>
              日产 × 已分发轮数 × (1 − {round.feeBps / 100}%) × 我的份数 / {round.totalShares} − 已领
            </strong>
          </div>
          <div className="rules-metrics">
            <div><span>权重 H</span><strong>{(book.hashpower || 0).toLocaleString("zh-CN")}</strong></div>
            <div><span>当前日产</span><strong>{formatBem(dailyBem)} BEM</strong></div>
            <div><span>全网权重</span><strong>{Number(weightVerified).toLocaleString()} / {Number(weightUnverified).toLocaleString()}</strong></div>
            <div><span>池</span><strong>{book.capped ? "未验证 1%" : "已验证 99%"}</strong></div>
            <div><span>我的占比</span><strong>{Math.round(harvest.share * 10000) / 100}%</strong></div>
            <div><span>图纸预估</span><strong>{est.hashpower.toLocaleString("zh-CN")} H · {est.usedParts} 颗</strong></div>
          </div>
          <p className="rules-note">
            全网日产 {NETWORK_DAILY_EMISSION.toLocaleString()} BEM，已验证池 99%、未验证池 1%。权重上涨则所有人日产下降。
            分发次数不限，只要还在出矿。流片后以实际算力为准。
          </p>
        </article>
      </div>

      <div className="rules-roles">
        {[
          ["任何人", "查看状态；挖矿中可触发全网分发并领取自己的收益"],
          ["认购用户", "募集中买入；超时或流片失败时原路退款"],
          ["持份用户", "挖矿中挂牌、接单、撤销自己的挂单"],
          ["Factory Owner", "开期、晶体管三步、流片、设定计划、更新全网权重"],
        ].map(([role, text]) => (
          <article key={role}>
            <strong>{role}</strong>
            <p>{text}</p>
          </article>
        ))}
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
