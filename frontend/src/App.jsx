import { useEffect, useMemo, useRef, useState } from "react";
import { readCall } from "./Calls.jsx";
import { dealStatus } from "./dealStatus.js";
import { ENDED, FAILED, PHASE, SCENE, outstandingOf, rowState, roundState } from "./roundState.js";
import { OwnerCreate, OwnerOverview } from "./Owner.jsx";
import { IS_CONFIGURED as CHAIN_CONFIGURED, NETWORK, CHAIN_ID, explorerAddress, sourcifySource } from "./chain/config.js";
import { useChain } from "./chain/useChain.js";
import {
  send,
  tx as chainTx,
  parseEther,
  readHolders,
  hasInjected,
  setCampaignAddress,
  createCampaignOnChain,
  readFactoryOwner,
  readAllowedParts,
} from "./chain/client.js";
import { discoverWallets, isMobile } from "./chain/wallets.js";
import { useOfficialPrices } from "./useOfficialPrices.js";
import deployments from "./chain/deployments.json";
import { MarketTrades } from "./MarketTrades.jsx";
import { MarketPage } from "./MarketPage.jsx";
import { RefundRecords } from "./RefundRecords.jsx";
import { processorScale } from "./prices.js";
import {
  OWNER,
  QUOTE,
  ROSTER,
  ROUND,
  SCENES,
  SCENE_COPY,
  WALLET,
  recomputeSelf,
  applySubscribe,
  applyOpenRefund,
  applyConfirmTransistors,
  applyCreate,
  applyPlaceTransistorOrder,
  applyCancelTransistorOrder,
  applyListShares,
  applyCancelListing,
  applyTakeListing,
  applyRefund,
  buildHolders,
  createScene,
  estimateHashpower,
  executeUnlockIn,
  feePercentOf,
  formatClock,
  formatRemaining,
  identify,
  resolveCampaignDesign,
  shortAddress,
  round4,
} from "./fixtures.js";

/** 按生命周期收口导航（对照 contracts/README.md §6） */
const LIFE_PAGES = [
  { id: "round", label: "BEM挖矿认筹", hint: "募集 → 待执行 → 挖矿" },
  { id: "assets", label: "我的资产", hint: "认筹 / 持仓 / 领取" },
  { id: "transfer", label: "资产转让", hint: "挖矿份额转让" },
  { id: "rules", label: "规则与合约", hint: "资金路径 / 退出 / 合约" },
  { id: "owner", label: "Owner 工作台", hint: "开期 / 入池 / 调试" },
];
/**
 * 晶体管市场（不属于生命周期）：里面到底有哪些官方处理器与晶体管。
 * 单独分组是因为它跟「某一期走完哪一步」无关，是常驻的外部市场视图。
 */
const MARKET_PAGES = [
  { id: "market", label: "晶体管市场", hint: "官方晶体管成交价与期次锁定" },
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
  /** 正在移除的期次地址；列表里只有这一条显示「移除中」 */
  const [pendingTarget, setPendingTarget] = useState("");
  const [now, setNow] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false);

  /** 链上数据源：CHAIN_CONFIGURED 时轮询测试网 Campaign，产出 book/round；否则回退本地模拟。 */
  const chain = useChain();
  const [factoryOwner, setFactoryOwner] = useState(deployments.deployer || "");
  /**
   * 工厂晶体管白名单（部署时写入、之后不可增删）。
   *
   * 这是**安全边界**不是运营开关：主网上防止 owner 把期次指向 MockERC1155
   * （其 mint 无访问控制，任何人能无限造晶体管）。开期表单的可选处理器必须
   * 从这里生成，不能用前端硬编码列表冒充链上事实。
   *
   * ⚠️ 工厂不再有「默认晶体管」：开期时前端必须**显式选择一个**白名单内的处理器，
   * 不能留空、也不能用工厂默认值代替。
   */
  const [allowedParts, setAllowedParts] = useState([]);
  useEffect(() => {
    if (!CHAIN_CONFIGURED) return;
    readFactoryOwner()
      .then((o) => o && setFactoryOwner(o))
      .catch(() => {});
    readAllowedParts()
      .then((list) => setAllowedParts(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  /**
   * 报价。
   *
   * 三个来源，优先级从高到低：
   *   1. 链上实读：Campaign 记录的 Owner 实际挂单/成交单价（由 adapter 写进 book）
   *   2. 官方市价：链上晶体管市场最新成交事件为主源（见 useOfficialPrices / officialPrices.js），
   *      tapeout.net 的 market.json 作按晶体管合并补齐的兜底，再无则静态基准
   *   3. 静态基准：prices.js 的 NOMINAL_QUOTE，只在链上与官方都没有价时兜底
   */
  const { quote, official } = useOfficialPrices(QUOTE);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  // ── 数据源切换：已部署则只用链上；未部署才走本地模拟 ──
  const usingChain = chain.active && chain.book != null;
  const chainEmpty = chain.active && chain.empty && !chain.book;
  // 工厂已部署时，读失败不能退回本地演示数据，否则会把真期次盖成「还没有」或假的第 3 期。
  const chainBooting = chain.active && !chain.book && !chain.empty;
  /** 从链上 setPlan 算力 + 晶体管数反推目标处理器，写入 round 供全页消费 */
  const design = useMemo(() => {
    const baseRound = usingChain ? chain.round : simRound;
    const baseBook = usingChain ? chain.book : simBook;
    if (!baseRound) return null;
    return resolveCampaignDesign(baseRound, baseBook);
  }, [usingChain, chain.round, chain.book, simRound, simBook]);
  const round = useMemo(() => {
    const base = usingChain ? chain.round : simRound;
    if (!base || !design) return base;
    return {
      ...base,
      // 链上未 setPlan 时不要把 fixtures 默认处理器写回 round，否则整页估算都会偏到 Behemoth
      processorId: design.processorKnown ? design.processorId : (usingChain ? null : base.processorId),
      transistorId: design.processorKnown ? design.transistorId : (usingChain ? null : base.transistorId),
    };
  }, [usingChain, chain.round, simRound, design]);
  const chainEst = useMemo(
    () => (round ? estimateHashpower(round, quote, round.totalShares) : null),
    [round, quote]
  );
  const book = usingChain
    ? { ...chain.book, estimate: chainEst || chain.book.estimate, picked: chain.picked }
    : simBook;
  // 链上已部署时身份只看真实钱包：即使还没开期（chainEmpty）也该认链上地址，
  // 否则 Owner 在空态下无法进入「发布众筹挖矿」。
  const account = chain.active ? chain.account || "" : simAccount;
  const connected = chain.active ? Boolean(chain.account) : simConnected;

  const copy = SCENE_COPY[book.scene];
  const remaining = round.totalShares - book.sold;
  const pay = book.picked * round.sharePriceBnb;
  const countdown = Number.isFinite(book.endsAt) ? splitCountdown(book.endsAt - now) : null;
  /**
   * Owner 地址集合 —— 「Owner 工作台」可见性的唯一口径。
   *
   * 链上：取「工厂 owner」+「本期 Campaign owner」两路。
   *  两者通常同址（CampaignFactory 把 factory owner 直接传给 Campaign），
   *  但老工厂开的期次 owner 是老工厂 owner，而工作台/开期权限属于当前工厂，
   *  所以两路都要留；链上还没开期时读不到本期 owner，必须保留工厂 owner 这一路，
   *  否则 Owner 在空态下就进不去「发布众筹挖矿」。
   * 本地演示没有链上地址，退回 fixtures 的 OWNER 常量。
   */
  const ownerAddresses = useMemo(() => {
    const list = [];
    if (CHAIN_CONFIGURED) {
      if (chain.book?.owner) list.push(String(chain.book.owner).toLowerCase());
      if (factoryOwner) list.push(String(factoryOwner).toLowerCase());
    } else {
      list.push(String(OWNER).toLowerCase());
    }
    return Array.from(new Set(list));
  }, [chain.book, factoryOwner]);
  /** 当前连接地址是不是 Owner（未连接钱包一律不是） */
  const isOwnerAddress = Boolean(account) && ownerAddresses.includes(String(account).toLowerCase());
  /**
   * 当前身份：Owner 走统一地址判定，其余按持份判定。
   *
   * ⚠️ owner 只认「本期 Campaign owner」（book.owner），不认工厂 owner：
   * 老工厂的期次归老工厂 owner 管，当前工厂 owner 对它没有链上权限，
   * 判成 owner 会让 UI 显示可执行/可撤单，实际交易会被合约 revert。
   * 工厂 owner 的身份只用于「Owner 工作台」这一层入口可见性。
   */
  const actor = useMemo(() => {
    const shares = (book.mine || 0) + (book.listingShares || 0);
    if (!chain.active) return identify(account, book);
    // ⚠️ 链上空态时 book 是本地 fixtures（simBook），owner 字段不可信，
    // 必须只认链上读到的 chain.book.owner。
    const campaignOwner = chain.book?.owner;
    const isCampaignOwner = Boolean(
      account
      && campaignOwner
      && String(account).toLowerCase() === String(campaignOwner).toLowerCase(),
    );
    if (isCampaignOwner) return { role: "owner", label: "Factory Owner", shares, address: account };
    return shares > 0
      ? { role: "holder", label: "持份用户", shares, address: account }
      : { role: "user", label: "未持份地址", shares: 0, address: account };
  }, [account, book, chain.active, chain.book]);
  const executeWait = executeUnlockIn(round, book, now);

  // 份额明细 / 历史：进入 Owner 工作台即拉链上数据
  const [chainHolders, setChainHolders] = useState(null);
  const [holdersCampaign, setHoldersCampaign] = useState("");
  useEffect(() => {
    if (!(usingChain && page === "owner")) return undefined;
    const addr = chain.campaignAddress;
    if (!addr) return undefined;
    let alive = true;
    setChainHolders(null);
    setHoldersCampaign(addr);
    chain.refreshHistory?.();
    readHolders(addr)
      .then((h) => alive && setChainHolders(h))
      .catch(() => alive && setChainHolders([]));
    return () => {
      alive = false;
    };
  }, [usingChain, page, chain.campaignAddress, chain.refreshHistory]);

  function switchScene(scene, expired = false, execFailed = false) {
    // 切换场景时保留当前 executePhase（如已确认到账的 ready），避免被重置回 buying；
    // 同时保留多钱包账本与转让市场的挂单，否则切换场景会丢失挂单与余额。
    setSimBook((current) => {
      const next = createScene(scene, round, current.executePhase, expired, execFailed);
      return recomputeSelf({
        ...next,
        wallets: current.wallets || next.wallets,
        listings: current.listings || [],
        selfAddress: current.selfAddress || next.selfAddress,
      });
    });
    setPending("");
    setPendingTarget("");
    setNotice("");
  }

  /** 切换连接钱包：同步账本里的 selfAddress，并把 mine/listingShares 重算为该钱包的余额。 */
  function switchAccount(address) {
    setSimAccount(address);
    setSimBook((current) => recomputeSelf({ ...current, selfAddress: address }));
  }

  function run(label, action) {
    setPending(label);
    setPendingTarget("");
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
      "subscribe", "listShares", "cancelListing", "takeListing", "refund", "claimSurplus",
      "placeTransistorOrder", "cancelTransistorOrder", "sellTransistors", "setPhase",
      "withdrawMarketProceeds", "confirmTransistors", "setPlan", "setMiningPool", "depositToPool", "returnSurplus", "topUpShortfall",
      "simulateFillBid", "simulateExternalBid", "simulateFillCampaignBids",
      "createCampaign", "openRefund", "abandonOrder", "markFailed", "removeCampaign", "removeCampaignAt",
      "setMaterialMarket", "recoverBnb", "recoverTransistors", "transferOwnership",
      "setFactoryOwner", "claimFee", "setServiceFee",
    ];
    // harvest / claim 在合约里是占位空实现（no-op / 返回 0），不产出发放：
    // 前端不再提供任何入口，也不发真实交易（白付 gas）。
    if (method === "claim" || method === "harvest") {
      return { ok: false, message: "harvest / claim 是占位实现（no-op），分配合约接入前不产出发放，前端不提供调用入口。" };
    }
    if (chain.active && WRITE_METHODS.includes(method)) return chainInvoke(method, args);
    if (["scene", "phase", "sold", "sharePriceBnb", "totalShares", "estHashpower", "totalRefunded", "raisedBnb", "transistors", "market", "materialMarket", "executionFailed", "soldOutAt", "priceLock", "holderCount", "sharesOf"].includes(method)) {
      return { ok: true, message: readCall(method, args, round, book, quote) };
    }
    if (/^market(OpenOrders|Bids|Sellable|Owed)$/.test(method) || method.startsWith("simulateFill") || method === "simulateExternalBid") {
      return { ok: false, message: "晶体管市场调试只在链上模式可用：先连接测试网钱包。" };
    }

    let result;
    if (method === "subscribe") result = applySubscribe(round, book, args.shares);
    else if (method === "listShares") result = applyListShares(round, book, args, actor);
    else if (method === "cancelListing") result = applyCancelListing(round, book, args.listingId, actor);
    else if (method === "takeListing") result = applyTakeListing(round, book, args.listingId, args.shares, actor);
    else if (method === "setMiningPool") result = { ok: true, message: "模拟：矿池地址已写入本期" };
    else if (method === "depositToPool") {
      result = {
        ok: true,
        message: "模拟：晶体管已投入矿池，本期进入挖矿（不可逆）",
        book: { ...book, scene: "mining", pooled: true },
      };
    }
    else if (method === "setPlan") result = { ok: true, message: "模拟：预估算力与晶体管数已写入" };
    else if (method === "placeTransistorOrder") result = applyPlaceTransistorOrder(round, book, actor, args);
    else if (method === "returnSurplus") {
      // 模拟模式：把钱从募集池挪到「待领余款」，期次、份额、晶体管都不动 —— 与链上 returnSurplus 同口径。
      result = book.executePhase === "ready" && Number(book.bnbPool) > 0
        ? {
            ok: true,
            message: `模拟：${round4(book.bnbPool)} BNB 余款已按份记账，持份人各自领取；本期继续，仍可入池`,
            book: {
              ...book,
              surplusOutstanding: Number(book.surplusOutstanding || 0) + Number(book.bnbPool || 0),
              surplusBase: book.outstandingShares ?? book.sold,
              bnbPool: 0,
            },
          }
        : { ok: false, message: "只有晶体管确认到账、且募集池还有余款时才能退" };
    }
    else if (method === "openRefund" || method === "abandonOrder") result = applyOpenRefund(round, book, actor);
    else if (method === "topUpShortfall") {
      result = { ok: true, message: "模拟：已补齐被晶体管吃掉的本金缺口，现在可以按原价退完持份人" };
    }
    else if (method === "markFailed") {
      result = book.executionFailed
        ? { ok: false, message: "本期已判执行失败，持有人直接退款即可" }
        : {
            ok: true,
            message: "模拟：已标记执行失败，持有人现在可以原路退款",
            book: { ...book, executionFailed: true },
          };
    }
    else if (method === "cancelTransistorOrder") result = applyCancelTransistorOrder(round, book, actor);
    else if (method === "confirmTransistors") result = applyConfirmTransistors(round, book, actor);
    else if (method === "refund") result = applyRefund(round, book, actor);
    else if (method === "createCampaign") result = applyCreate(round, args, quote);
    else if (method === "recoverBnb") result = { ok: true, message: "模拟：可动 BNB 已一次性转给 Owner（不用填数量）" };
    else if (method === "recoverTransistors") result = { ok: true, message: "模拟：晶体管已转给 Owner" };
    else if (method === "claimFee") {
      result = { ok: true, message: "模拟：已领取本期属于你的挖矿产出服务费（链上模式走 claimFee()，金额按链上分成表计提）" };
    } else if (method === "setServiceFee") {
      // 模拟模式：写进本地 round，服务费口径与链上一致（费率 + 分成表都在 round 上）。
      const bps = Number(args?.bps ?? 0);
      const rows = String(args?.sharesBps || "").split(",").map((s) => s.trim()).filter(Boolean);
      setSimRound((current) => ({
        ...current,
        serviceFeeBps: bps,
        serviceFeeSet: true,
        feePercent: bps / 100,
        feeShares: (current.feeShares || []).slice(0, rows.length),
      }));
      result = { ok: true, message: `模拟：挖矿产出服务费已设为 ${bps} bps（${bps / 100}%）` };
    }
    else return { ok: false, message: "不能从管理页调用这个函数" };

    if (result.ok) {
      if (result.book) setSimBook(result.book);
      if (result.round) setSimRound(result.round);
      setNotice(result.message);
    }
    return { ok: result.ok, message: result.message };
  }

  const WALLET_ACTION = {
    subscribe: "认筹",
    listShares: "发布转让",
    cancelListing: "取消转让",
    takeListing: "接收转让",
    refund: "退款",
    claimSurplus: "领取余款",
    claimFee: "领取挖矿产出服务费",
    setServiceFee: "设定挖矿产出服务费",
    placeTransistorOrder: "挂买单",
    cancelTransistorOrder: "取消买单",
    sellTransistors: "卖入买单",
    setPhase: "改子状态",
    withdrawMarketProceeds: "提取卖出款",
    simulateFillBid: "模拟卖方成交",
    simulateExternalBid: "模拟外部买单",
    simulateFillCampaignBids: "一键撮合买单",
    confirmTransistors: "确认成交",
    setPlan: "写入计划",
    setMiningPool: "设置矿池",
    depositToPool: "入池",
    createCampaign: "发布期次",
    openRefund: "退款",
    abandonOrder: "撤单退款",
    topUpShortfall: "补齐本金缺口",
    markFailed: "判执行失败",
    removeCampaign: "移除期次",
    removeCampaignAt: "移除期次",
    setMaterialMarket: "更换晶体管市场",
    recoverBnb: "取回 BNB",
    recoverTransistors: "取回晶体管",
    transferOwnership: "转移所有权",
    setFactoryOwner: "转移工厂所有权",
  };

  function walletAsk(method) {
    const name = WALLET_ACTION[method] || "这笔操作";
    setNotice(`请在钱包中确认「${name}」。弹出窗口后点确认，不要关闭本页。`);
  }

  function walletSigned(method) {
    const name = WALLET_ACTION[method] || "这笔操作";
    setNotice(`钱包已确认「${name}」，正在等待链上入块。`);
  }

  /** 链上写操作：构造交易 → 发送并等待 → 刷新。自带 pending/notice，不走 run() 的 700ms。 */
  function chainInvoke(method, args) {
    setPending(method);
    setPendingTarget(
      method === "removeCampaign"
        ? String(args?.campaign || args?.address || "").toLowerCase()
        : ""
    );
    walletAsk(method);
    const onSigned = () => walletSigned(method);
    (async () => {
      try {
        let signer = chain.signer;
        if (!signer) {
          const w = await chain.connect();
          signer = w.signer;
        }
        if (method === "createCampaign") {
          await chainCreateCampaign(args, signer, onSigned);
          return;
        }
        if (method === "removeCampaign" || method === "removeCampaignAt") {
          const removed = args?.campaign || args?.address;
          if (method === "removeCampaignAt") {
            const index = BigInt(Math.floor(Number(args?.index ?? -1)));
            if (index < 0n) throw new Error("请填写工厂列表索引");
            await send(chainTx.removeCampaignAt(signer, index), onSigned);
          } else {
            if (!removed || !/^0x[0-9a-fA-F]{40}$/.test(String(removed))) {
              throw new Error("请填写要移除的期次地址");
            }
            await send(chainTx.removeCampaign(signer, removed), onSigned);
          }
          setNotice("已从工厂列表移除该期（链上合约仍在，可用原地址直连）");
          const addrs = (await chain.refreshHistory?.()) || [];
          const list = Array.isArray(addrs) ? addrs : [];
          const current = String(book.address || "").toLowerCase();
          if (current && !list.some((a) => String(a).toLowerCase() === current)) {
            if (list.length) await chain.switchCampaign?.(list[0]);
          }
          await chain.refresh();
          return;
        }
        if (method === "placeTransistorOrder") {
          if (book._chain && book.marketOrders === false) {
            throw new Error("这期合约还是旧挂单接口，不会调用官方晶体管市场。重新部署并新开一期后才能 placeBid。");
          }
          const nandQty = BigInt(Math.floor(Number(args?.nandQty) || 0));
          const latchQty = BigInt(Math.floor(Number(args?.latchQty) || 0));
          if (nandQty === 0n && latchQty === 0n) throw new Error("NAND 与 LATCH 数量不能都为 0");
          const nandPrice = nandQty > 0n ? parseEther(String(args?.nandPrice ?? "0").trim()) : 0n;
          const latchPrice = latchQty > 0n ? parseEther(String(args?.latchPrice ?? "0").trim()) : 0n;
          if ((nandQty > 0n && nandPrice <= 0n) || (latchQty > 0n && latchPrice <= 0n)) {
            throw new Error("有数量的晶体管必须填写大于 0 的单价");
          }
          const cost = nandQty * nandPrice + latchQty * latchPrice;
          const pool = parseEther(String(book.bnbPool ?? 0));
          if (cost > pool) {
            throw new Error("托管金额超过募集余额，不会挂出。请降低数量或单价后再提交。");
          }
          await send(chainTx.placeTransistorOrder(signer, nandQty, nandPrice, latchQty, latchPrice), onSigned);
        } else if (method === "sellTransistors") {
          if (book._chain && book.readyExit === false) {
            throw new Error("这期合约没有 sellTransistors。重新部署并新开一期后才能卖入买单。");
          }
          const bidId = BigInt(Math.floor(Number(args?.bidId ?? 0)));
          const tokenId = Number(args?.tokenId ?? 0);
          const quantity = BigInt(Math.floor(Number(args?.quantity ?? 0)));
          if (bidId <= 0n) throw new Error("请选择一个有效的买单");
          if (tokenId !== 0 && tokenId !== 1) throw new Error("tokenId 只能是 0（NAND）或 1（LATCH）");
          if (quantity <= 0n) throw new Error("卖出数量必须大于 0");
          await send(chainTx.sellTransistors(signer, bidId, tokenId, quantity), onSigned);
        } else if (method === "openRefund") {
          await send(chainTx.openRefund(signer), onSigned);
        } else if (method === "abandonOrder") {
          await send(chainTx.abandonOrder(signer), onSigned);
        } else {
          const promise = buildChainTx(method, args, signer);
          await send(promise, onSigned);
        }
        setNotice(method === "openRefund"
          ? "链上已退款。认筹 BNB 已按认筹地址原路退回。"
          : method === "returnSurplus"
            ? "剩余募集款已按份记账：持份人各自 claimSurplus 领取，本期继续，晶体管仍在合约里、可以照常入池。"
          : method === "claimSurplus"
            ? "已领取你应得的余款（提前退回或入池记账），BNB 已到账。"
          : method === "recoverBnb"
            ? "已把本期可动 BNB 一次性转给 Owner（多余余额，或无人可退时的整池剩余）。"
          : method === "abandonOrder"
            ? "已撤单并退款：未成交保证金已收回，卖出款已提取，持份人按剩余池子原路退回。"
          : method === "placeTransistorOrder"
            ? "已向晶体管市场挂买单。保证金从本期募集款托管。"
            : method === "sellTransistors"
              ? "已吃单卖出：晶体管已交付买家，卖出款已提回本期。"
              : method === "withdrawMarketProceeds"
                ? "卖出款已转入本期募集余额。"
                : method === "markFailed"
                  ? "已标记执行失败：所有持有人现在可以按池子原路退款。"
                  : method === "simulateFillBid" || method === "simulateFillCampaignBids"
                    ? "已模拟卖方成交：市场剩余已扣减，晶体管已铸给买家（本期合约）。"
                    : method === "simulateExternalBid"
                      ? "已模拟外部买家挂单：BNB 已托管到 Mock 晶体管市场，本期可以吃这张买单。"
                      : `已确认：${method} ✓`);
        await chain.refresh();
        if (
          method === "refund"
          || method === "claimSurplus"
          || method === "openRefund"
          || method === "abandonOrder"
          || method === "markFailed"
          || method === "listShares"
          || method === "takeListing"
          || method === "cancelListing"
          || method === "subscribe"
        ) await chain.refreshPositions?.();
        // 退款会让份数归零、结束状态变化，列表必须重读，否则还停在「待执行」。
        if (["createCampaign", "refund", "openRefund", "abandonOrder", "markFailed"].includes(method)) {
          await chain.refreshHistory?.();
        }
      } catch (e) {
        setNotice(`失败：${e.message}`);
      } finally {
        setPending("");
        setPendingTarget("");
      }
    })();
    return { ok: true, message: "交易已提交，等待链上确认…" };
  }

  /** 开期：开新一期页（完整 draft+_review）与合约调用页（表单字段）共用。 */
  async function chainCreateCampaign(draft, signer, onSigned) {
    // 份额单价：优先用 toFixed(8) 去掉浮点尾巴
    const shareNum = Number(draft.sharePriceBnb);
    if (!Number.isFinite(shareNum) || shareNum <= 0) throw new Error("每份 BNB 无效");
    const totalShares = BigInt(Math.round(Number(draft.totalShares || 0)));
    if (totalShares <= 0n) throw new Error("总份数必须为正整数");
    const fundingDays = BigInt(Math.round(Number(draft.fundingDays || 7)));
    if (fundingDays <= 0n) throw new Error("募集天数须为正整数");

    // signer 可能被 accountsChanged 清掉，尽量补签
    let activeSigner = signer;
    if (!activeSigner) {
      const w = await chain.connect();
      activeSigner = w.signer;
    }

    /**
     * 开期参数：份额单价 / 总份数 / 募集天数 / **晶体管合约（处理器）**。
     *
     * ⚠️ 晶体管合约（第 4 参）是**必选**：开期人必须从白名单里显式选一个处理器，
     * 零地址一律 revert（工厂不再有默认晶体管）。这是 T-79 的核心改动：
     * 之前所有期次被工厂默认值锁死到同一处理器，现在单工厂可承载多处理器
     * （主网 TapeOut / Behemoth 各自的晶体管合约），由开期时显式选择。
     *
     * 晶体管**数量**同样不是开期参数：它在 Owner 买入晶体管（placeTransistorOrder）时确定。
     */
    const partsArg = String(draft.transistors || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(partsArg) || /^0x0{40}$/i.test(partsArg)) {
      throw new Error("请先选择本期使用的处理器（晶体管合约），不能留空。");
    }
    const { campaign: created, hash } = await createCampaignOnChain(
      activeSigner,
      { sharePriceBnb: shareNum, totalShares, fundingDays, transistors: partsArg },
      onSigned
    );

    setCampaignAddress(created);
    await chain.setCampaignAddress(created);

    /**
     * 服务费与分成表：**第二笔交易**，写进刚建好的 Campaign（setServiceFee）。
     *
     * 合约硬约束：只能在 sold == 0（此刻刚建期，一定满足）时调一次，
     * 之后 serviceFeeSet 永久为 true，任何人不可再改。费率 ≤ 10%，分成 ≤ 3 个地址，
     * 份额合计必须恰好 10000 bps。
     *
     * 这一步失败不影响建期本身（期次已经建好、可以开始募集），
     * 但服务费会停在「未设定」——Owner 之后仍可在无人认购时从合约操作页补设。
     */
    let feeNote = "挖矿产出服务费未设定";
    try {
      const feePercent = Number(draft.feePercent);
      /**
       * 分成表字段口径（必修的断链）：
       *
       * effectiveDraft.feeShares 来自 Owner.jsx 的 feeSharesForChain，
       * 字段是 `{ address, shareBps }` —— **shareBps 已是基点**（10000 = 100%）；
       * 旧路径可能是 `{ address, sharePercent }` —— 百分比，需 ×100。
       *
       * 曾经这里只读 sharePercent，而转换后的对象里该字段已不存在，
       * Number(undefined) → 0，导致发往链上的份额全是 0，
       * 被合约 `sharesBps_[i] == 0 → BadFeeConfig` 挡下、estimateGas 失败、
       * 交易从不广播，而 catch 只把 notice 改成一句「写入失败」——极易漏看。
       */
      const rows = (Array.isArray(draft.feeShares) ? draft.feeShares : [])
        .filter((row) => String(row?.address || "").trim())
        .map((row) => {
          const rawBps =
            row.shareBps != null && row.shareBps !== ""
              ? Number(row.shareBps)
              : Math.round(Number(row.sharePercent) || 0) * 100;
          return { address: String(row.address).trim(), bps: Math.round(rawBps) };
        });
      if (Number.isInteger(feePercent) && feePercent > 0 && rows.length > 0) {
        /**
         * 前置闸门：链上硬约束是「每项份额非 0 且合计恰为 10000」。
         * 不满足就明确抛错，不要发一笔注定 revert 的交易——
         * 既白耗一次钱包确认，错误还会被降级成 notice 文案。
         */
        if (rows.some((r) => !(r.bps > 0))) {
          throw new Error(`挖矿产出服务费分成份额必须大于 0（当前 ${rows.map((r) => r.bps).join(", ")}）`);
        }
        const sumBps = rows.reduce((total, r) => total + r.bps, 0);
        if (sumBps !== 10000) {
          throw new Error(`挖矿产出服务费分成份额合计必须等于 10000（100%），当前 ${sumBps}`);
        }
        await send(
          chainTx.setServiceFee(activeSigner, BigInt(feePercent * 100), rows.map((r) => r.address), rows.map((r) => r.bps)),
          onSigned
        );
        feeNote = `挖矿产出服务费 ${feePercent}% 已写入链上`;
      }
    } catch (e) {
      feeNote = `挖矿产出服务费写入失败（期次已建好，可稍后补设）：${e.shortMessage || e.message || e}`;
    }

    await chain.refreshHistory?.();
    setOwnerTab("overview");
    setPage("owner");
    setNotice(`已发布：${shortAddress(created)} · tx ${shortAddress(hash)} · ${feeNote}`);
  }

  function buildChainTx(method, args, signer) {
    const priceWei = book._sharePriceWei || 0n;
    // BigInt() 遇到 "abc" 会抛 SyntaxError（英文原语，用户看不懂），
    // 超大数则直接触发链上 overflow revert 白付 gas。先在前端拦。
    const uintField = (raw, label) => {
      const text = String(raw ?? "").trim();
      if (!/^\d+$/.test(text)) throw new Error(`${label}必须是非负整数`);
      return BigInt(text);
    };
    switch (method) {
      case "subscribe": {
        const shares = uintField(args.shares, "份数");
        if (shares <= 0n) throw new Error("认筹份数必须大于 0");
        const remaining = BigInt(Math.max(0, (Number(round.totalShares) || 0) - (Number(book.sold) || 0)));
        if (shares > remaining) throw new Error(`剩余可认筹 ${remaining} 份，你填了 ${shares} 份`);
        return chainTx.subscribe(signer, shares, shares * priceWei);
      }
      case "refund": return chainTx.refund(signer, args?.campaign);
      case "claimSurplus": return chainTx.claimSurplus(signer, args?.campaign);
      case "claimFee": return chainTx.claimFee(signer, args?.campaign);
      case "setServiceFee": {
        /**
         * 服务费与分成表（链上）。
         *
         * 表单里两个数组字段是文本，用户可能写：
         *   '["0xabc...", "0xdef..."]'  （JSON）
         *   '0xabc..., 0xdef...'        （逗号分隔）
         * 两种都接受，解析不出来就明确报错，不要把非法数组发给链上。
         */
        const bps = uintField(args?.bps, "费率（基点）");
        if (bps > 1000n) throw new Error("挖矿产出服务费硬上限是 1000 bps（10%）");
        const parseAddrList = (raw, label) => {
          const text = String(raw ?? "").trim();
          if (text === "") return [];
          let items = [];
          if (text.startsWith("[")) {
            try {
              items = JSON.parse(text);
            } catch {
              throw new Error(`${label} 格式不对：需要 JSON 数组或逗号分隔的地址`);
            }
          } else {
            items = text.split(",");
          }
          if (!Array.isArray(items) || items.length === 0) {
            throw new Error(`${label} 至少要有一个地址`);
          }
          if (items.length > 3) throw new Error(`${label} 最多 3 个（链上硬上限）`);
          return items.map((item) => {
            const a = String(item).trim();
            if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${label} 里含非法地址：${a || "(空)"}`);
            return a;
          });
        };
        const parseBpsList = (raw, label) => {
          const text = String(raw ?? "").trim();
          if (text === "") return [];
          let items = [];
          if (text.startsWith("[")) {
            try {
              items = JSON.parse(text);
            } catch {
              throw new Error(`${label} 格式不对：需要 JSON 数组或逗号分隔的基点数`);
            }
          } else {
            items = text.split(",");
          }
          return items.map((item) => {
            const n = Number(String(item).trim());
            if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} 必须是不小于 1 的整数基点`);
            return n;
          });
        };
        const recipients = parseAddrList(args?.recipients, "收款地址");
        const sharesBps = parseBpsList(args?.sharesBps, "份额");
        if (recipients.length !== sharesBps.length) {
          throw new Error(`收款地址 ${recipients.length} 个，份额 ${sharesBps.length} 个，数量必须一致`);
        }
        if (bps === 0n && recipients.length !== 0) throw new Error("费率为 0 时分成表必须为空");
        if (bps !== 0n && recipients.length === 0) throw new Error("费率不为 0 时必须填分成地址");
        const sum = sharesBps.reduce((a, b) => a + b, 0);
        if (recipients.length > 0 && sum !== 10000) {
          throw new Error(`份额合计必须等于 10000，当前 ${sum}`);
        }
        return chainTx.setServiceFee(signer, bps, recipients, sharesBps);
      }
      case "listShares": {
        const shares = uintField(args.shares, "转让份数");
        if (shares <= 0n) throw new Error("转让份数必须大于 0");
        const price = parseEther(String(args.priceBnbPerShare));
        if (price <= 0n) throw new Error("每份价格必须大于 0");
        return chainTx.listShares(signer, shares, price);
      }
      case "cancelListing": return chainTx.cancelListing(signer, uintField(args.listingId, "挂单 ID"));
      case "takeListing": {
        const id = uintField(args.listingId, "挂单 ID");
        const l = (book.listings || []).find((x) => String(x.id) === String(id));
        // 找不到就报错，不要拿 0 当单价发出去——那会以 WrongPayment 在链上 revert，白付 gas。
        if (!l) throw new Error(`挂单 #${id} 未在本地缓存中找到，请刷新后重试`);
        const wei = l._priceWei ?? 0n;
        if (wei <= 0n) throw new Error(`挂单 #${id} 的单价未读到，请刷新后重试`);
        const shares = uintField(args.shares, "买入份数");
        if (shares <= 0n) throw new Error("买入份数必须大于 0");
        return chainTx.takeListing(signer, Number(id), shares, shares * wei);
      }
      case "cancelTransistorOrder": return chainTx.cancelTransistorOrder(signer);
      case "markFailed": return chainTx.markFailed(signer, args?.campaign);
      case "withdrawMarketProceeds": return chainTx.withdrawMarketProceeds(signer);
      case "simulateFillBid": return chainTx.simulateFillBid(signer, args.id, args.quantity);
      case "simulateExternalBid": {
        const tokenId = Number(args?.tokenId ?? 0);
        if (tokenId !== 0 && tokenId !== 1) throw new Error("tokenId 只能是 0（NAND）或 1（LATCH）");
        const price = parseEther(String(args?.price ?? "0").trim());
        if (price <= 0n) throw new Error("单价必须大于 0");
        const quantity = uintField(args?.quantity, "数量");
        if (quantity <= 0n) throw new Error("数量必须大于 0");
        return chainTx.simulateExternalBid(signer, tokenId, price, quantity);
      }
      case "simulateFillCampaignBids": return chainTx.simulateFillCampaignBids(signer);
      case "confirmTransistors":
        if (book._chain && book.marketOrders === false) {
          throw new Error("这期合约不能读取官方订单簿。重新部署后，成交以 bids(id).remaining 为准。");
        }
        if (book._chain && !book.orderFilled) {
          throw new Error("晶体管市场买单还没吃完（remaining > 0），不能进入待入池。");
        }
        if (book._chain) {
          // 合约还要求本期合约真的持有晶体管；成交但卖家没发货时会以 TransistorsNotReady 回滚。
          const needNand = Number(book.nandQty) || 0;
          const needLatch = Number(book.latchQty) || 0;
          const haveNand = Number(book.partsNand) || 0;
          const haveLatch = Number(book.partsLatch) || 0;
          if (haveNand < needNand || haveLatch < needLatch) {
            const short = [
              needNand > haveNand ? `${needNand - haveNand} NAND` : null,
              needLatch > haveLatch ? `${needLatch - haveLatch} LATCH` : null,
            ].filter(Boolean).join(" + ");
            throw new Error(`晶体管还没到账：还缺 ${short}。测试网可在「合约操作」点「补发晶体管」补齐后再确认。`);
          }
        }
        return chainTx.confirmTransistors(signer);
      case "setPlan": {
        const src = args || {};
        const raw = src.hashpower ?? ((chainEst && chainEst.hashpower) || book.estimate?.hashpower || 0);
        const num = Number(raw);
        if (!Number.isFinite(num) || num <= 0) throw new Error("还没有预估算力，无法写入 setPlan");
        // Math.round 会把 12.7 悄悄变成 13。算力是链上写入值，取整前先如实拒绝小数。
        if (!Number.isInteger(num)) throw new Error(`预估算力必须是整数：${num}`);
        return chainTx.setPlan(signer, BigInt(num));
      }
      case "setMiningPool": {
        const pool = String(args?.pool || "").trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) throw new Error("矿池地址无效");
        // 零地址格式合法，但 depositToPool 会把晶体管转进黑洞且不可逆。
        if (/^0x0{40}$/i.test(pool)) throw new Error("矿池地址不能是零地址");
        return chainTx.setMiningPool(signer, pool);
      }
      case "depositToPool":
        return chainTx.depositToPool(signer);
      case "returnSurplus":
        // 无参：把当前 raisedBnb 按份记账退回持份人，期次继续、仍然可以入池。
        return chainTx.returnSurplus(signer);
      case "topUpShortfall": {
        // 自掏腰包补齐被晶体管吃掉的本金差额（payable，单位 BNB）。
        const raw = String(args?.value ?? "0").trim();
        const amount = raw ? parseEther(raw) : 0n;
        if (amount <= 0n) throw new Error("补齐金额必须大于 0");
        return chainTx.topUpShortfall(signer, amount);
      }
      case "setMaterialMarket": return chainTx.setMaterialMarket(signer, args.materialMarket);
      case "setPhase": {
        const next = Number(args?.next);
        // 0 (None) 只在开期前存在；Executing 里设它会同时关掉挂单与退款，合约直接拒绝。
        if (!Number.isInteger(next) || next < 1 || next > 3) throw new Error("子状态只能是 1、2、3");
        return chainTx.setPhase(signer, next);
      }
      case "recoverBnb": {
        // 无参：合约一次扫走所有可动 BNB（多余余额，或已无人可退时的整池剩余）。
        return chainTx.recoverBnb(signer, args?.campaign);
      }
      case "recoverTransistors": {
        const token = String(args?.token || "").trim();
        const id = uintField(args?.id ?? 0, "晶体管 ID");
        const amount = uintField(args?.amount ?? 0, "转出数量");
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("晶体管合约地址无效");
        if (amount <= 0n) throw new Error("转出数量必须大于 0");
        return chainTx.recoverTransistors(signer, token, id, amount);
      }
      case "transferOwnership": return chainTx.transferOwnership(signer, args.newOwner);
      case "setFactoryOwner": return chainTx.setFactoryOwner(signer, args.newOwner);
      default: throw new Error("链上模式暂不支持：" + method);
    }
  }

  /** 页面按钮：包一层 loading 动画再调 invokeCall。链上写操作自管 pending，不套 run()。 */
  function act(method, args) {
    if (chain.active) {
      invokeCall(method, args);
      return;
    }
    run(method === "subscribe" ? "认筹提交中" : "处理中", () => invokeCall(method, args));
  }

  function approve() {
    if (chain.active) {
      // 原生 BNB，无需 ERC20 approve
      act("subscribe", { shares: book.picked });
      return;
    }
    run("授权中", () => {
      setSimBook((current) => ({ ...current, approved: true }));
      setNotice(`已授权本期合约扣取 BNB`);
    });
  }

  function subscribeShares() {
    if (!connected) {
      handleConnect();
      return;
    }
    if (chain.active) {
      act("subscribe", { shares: book.picked });
      return;
    }
    if (!book.approved) {
      approve();
      return;
    }
    act("subscribe", { shares: book.picked });
  }

  function handlePick(picked) {
    if (chain.active) {
      chain.setPicked(picked);
      return;
    }
    setSimBook((current) => ({ ...current, picked }));
  }

  const [walletOpen, setWalletOpen] = useState(false);
  const [walletChoices, setWalletChoices] = useState([]);
  const [walletBusy, setWalletBusy] = useState(false);

  /** 只有一个已注入钱包时直接连；手机或有多家钱包时先让用户选，TokenPocket 用深链唤起。 */
  async function handleConnect() {
    if (!chain.active) {
      setSimConnected(true);
      setNotice("已连接钱包");
      return;
    }
    try {
      const choices = await discoverWallets();
      const injected = choices.filter((item) => item.kind === "injected");
      if (injected.length === 1 && choices.every((item) => item.kind === "injected")) {
        await chain.connect(injected[0].provider);
        setNotice(`已连接 ${injected[0].name}`);
        return;
      }
      setWalletChoices(choices);
      setWalletOpen(true);
    } catch (e) {
      setNotice(e.message || "连接失败");
    }
  }

  async function pickWallet(choice) {
    if (choice.kind === "deeplink" || choice.kind === "install") {
      window.location.assign(choice.href);
      return;
    }
    setWalletBusy(true);
    try {
      await chain.connect(choice.provider);
      setWalletOpen(false);
      setNotice(`已连接 ${choice.name}`);
    } catch (e) {
      setNotice(e.message || "连接失败");
    } finally {
      setWalletBusy(false);
    }
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
    const result = applyCreate(round, draft, quote);
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    setSimRound(result.round);
    setSimBook(result.book);
    // 演示模式：发布者即 Owner，把预览身份切到 Owner 常量，否则进不去工作台。
    setSimAccount(OWNER);
    setOwnerTab("overview");
    setPage("owner");
    setNotice(result.message);
  }

  function openPage(id, ownerSub) {
    // Owner 工作台只对 Owner 开放：其它身份连入口都不给（侧边栏已隐藏，这里再兜一层）。
    if (id === "owner" && !isOwnerAddress) {
      setNotice("Owner 工作台仅 Factory Owner 可见");
      return;
    }
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
            // Owner 工作台只对 Owner 展示：非 Owner 连入口都不给。
            if (item.id === "owner" && !isOwnerAddress) return null;
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
          <div className="menu-group-title">晶体管市场</div>
          {MARKET_PAGES.map((item) => (
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
          ))}
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
                  {chain.account ? (
                    <>
                      <button className="wallet-chip" type="button">
                        <span className="topbar-role">{chain.account && factoryOwner && String(chain.account).toLowerCase() === String(factoryOwner).toLowerCase() ? "Factory Owner" : "已连接"}</span>
                        {shortAddress(chain.account)}
                      </button>
                      <div className="wallet-pop" role="dialog" aria-label="钱包详情">
                        <div className="wallet-pop-head">
                          <span className="topbar-net">{NETWORK.name} · {CHAIN_ID}</span>
                          <button className="wallet-refresh" type="button" onClick={chain.refresh}>刷新</button>
                        </div>
                        <div className="wallet-pop-body">
                          <div className="wallet-addr">
                            <div className="wallet-addr-top">
                              <div>
                                <span>当前钱包 · {chain.account && factoryOwner && String(chain.account).toLowerCase() === String(factoryOwner).toLowerCase() ? "Factory Owner" : "已连接"}</span>
                                <strong>{shortAddress(chain.account)}</strong>
                              </div>
                              <button
                                className="wallet-copy"
                                type="button"
                                onClick={() => {
                                  const done = () => setNotice("已复制钱包地址");
                                  if (navigator.clipboard?.writeText) {
                                    navigator.clipboard.writeText(chain.account).then(done).catch(() => setNotice("复制失败"));
                                  } else {
                                    setNotice("复制失败");
                                  }
                                }}
                              >
                                复制地址
                              </button>
                            </div>
                            <code>{chain.account}</code>
                          </div>
                          {chain.book ? (
                            <dl className="wallet-stats">
                              <div><dt>BNB</dt><dd>{Number(chain.book.bnb || 0).toFixed(4)}</dd></div>
                              <div><dt>本期份额</dt><dd>{(chain.book.mine || 0) + (chain.book.listingShares || 0)} 份</dd></div>
                            </dl>
                          ) : (
                            <p className="wallet-pop-label">钱包已连接。当前工厂还没有期次，开期后这里会显示余额和份额。</p>
                          )}
                          <button
                            className="wallet-disconnect"
                            type="button"
                            onClick={() => { chain.disconnect(); setNotice("已断开钱包"); }}
                          >
                            断开连接
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <button className="btn btn-primary" type="button" onClick={handleConnect}>
                      连接钱包
                    </button>
                  )}
                </div>
              </div>
            </header>
            {!hasInjected() && !chain.account && (
              <p className="topbar-alert">
                {isMobile()
                  ? "手机浏览器里点「连接钱包」，用 TokenPocket 打开本页后再签名。当前只能查看链上数据。"
                  : "当前浏览器没有注入钱包。可安装 TokenPocket 或 MetaMask，手机也可直接用 TokenPocket 打开本页。当前只能查看链上数据。"}
              </p>
            )}
            {walletOpen && (
              <div className="wallet-sheet-mask" onClick={() => !walletBusy && setWalletOpen(false)}>
                <div className="wallet-sheet" role="dialog" aria-label="选择钱包" onClick={(event) => event.stopPropagation()}>
                  <div className="wallet-sheet-head">
                    <strong>选择钱包</strong>
                    <button type="button" onClick={() => setWalletOpen(false)} disabled={walletBusy}>关闭</button>
                  </div>
                  <p>连接后会切换到 {NETWORK.name}。手机上的 TokenPocket 会先打开本页，再在钱包里确认。</p>
                  {walletChoices.length === 0 ? (
                    <p className="wallet-sheet-empty">没有找到可用钱包，请用 TokenPocket 重新打开本页。</p>
                  ) : (
                    <ul className="wallet-choice-list">
                      {walletChoices.map((choice) => (
                        <li key={choice.id}>
                          <button type="button" disabled={walletBusy} onClick={() => pickWallet(choice)}>
                            <strong>{choice.name}</strong>
                            <span>
                              {choice.hint || (choice.kind === "injected" ? "已检测到，点击连接" : "打开")}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
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
                title="演示：执行失败（晶体管报价超过募资总额，本金尚未支出）"
              >
                执行失败（演示）
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
              <p>{chain.error ? `链上读取失败：${chain.error}` : `正在从 ${NETWORK.name} 读取 Campaign 状态…`}</p>
              {chain.error && (
                <button className="btn btn-primary" type="button" onClick={chain.refresh}>重试</button>
              )}
            </div>
          </section>
        )}
        {!chainBooting && chainEmpty && page !== "owner" && page !== "rules" && page !== "market" && (
          <section>
            <div className="empty">
              <p>主网工厂已部署，还没有开期。认筹、资产和转让都会在开期后出现。</p>
              {/* 发布是 Factory Owner 的专属动作，非 Owner 不给入口 */}
              {isOwnerAddress ? (
                <button className="btn btn-primary" type="button" onClick={() => openPage("owner", "create")}>去发布众筹挖矿</button>
              ) : (
                <p className="empty-muted">开期后这里会出现认筹入口。发布众筹挖矿由 Factory Owner 操作。</p>
              )}
            </div>
          </section>
        )}
        {!chainBooting && !(chainEmpty && page !== "owner" && page !== "rules" && page !== "market") && page === "round" && (
          <RoundHub
            round={round}
            book={book}
            copy={copy}
            quote={quote}
            remaining={remaining}
            pay={pay}
            countdown={countdown}
            executeWait={executeWait}
            pending={pending}
            connected={connected}
            actor={actor}
            onChain={usingChain}
            onPick={handlePick}
            onSubscribe={subscribeShares}
            onRefund={() => act("refund")}
            onAbort={() => act("openRefund")}
            onRecoverBnb={() => act("recoverBnb")}
            onMarkFailed={() => act("markFailed")}
            onOpenOwner={() => openPage("owner", "overview")}
            onOpenAssets={() => openPage("assets")}
            onOpenTransfer={() => openPage("transfer")}
            usingChain={usingChain}
            periods={usingChain ? chain.campaigns : []}
            onSwitchPeriod={usingChain ? chain.switchCampaign : null}
          />
        )}
        {!chainBooting && !chainEmpty && page === "assets" && (
          <AssetsHub
            round={round}
            book={book}
            copy={copy}
            pending={pending}
            connected={connected}
            usingChain={usingChain}
            positions={usingChain ? chain.positions : null}
            positionsLoading={usingChain ? chain.positionsLoading : false}
            onRefund={(address) => act("refund", { campaign: address })}
            onMarkFailed={(address) => act("markFailed", { campaign: address })}
            onClaimSurplus={(address) => act("claimSurplus", { campaign: address })}
            onOpenPeriod={async (address) => {
              if (usingChain && address) await chain.switchCampaign(address);
              openPage("round");
            }}
            onConnect={handleConnect}
          />
        )}
        {!chainBooting && !chainEmpty && page === "transfer" && (
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
            onBrowse={() => openPage("round")}
            onConnect={handleConnect}
            title="挖矿份额转让"
            periods={usingChain ? chain.campaigns : []}
            onSwitchPeriod={usingChain ? chain.switchCampaign : null}
          />
        )}
        {!chainBooting && page === "owner" && isOwnerAddress && chainEmpty && ownerTab !== "create" && (
          <section>
            <div className="empty">
              <p>工厂里还没有期次。发布后才会出现众筹列表。</p>
              <button className="btn btn-primary" type="button" onClick={() => openPage("owner", "create")}>发布众筹挖矿</button>
            </div>
          </section>
        )}
        {!chainBooting && page === "owner" && isOwnerAddress && (!chainEmpty || ownerTab === "create") && (
          <OwnerDesk
            tab={ownerTab}
            onTab={setOwnerTab}
            tabs={OWNER_TABS}
            round={round}
            book={book}
            copy={copy}
            quote={quote}
            official={official}
            pending={pending}
            pendingTarget={pendingTarget}
            actor={actor}
            account={account}
            executeWait={executeWait}
            connected={connected}
            usingChain={usingChain}
            chain={chain}
            factoryOwner={factoryOwner}
            allowedParts={allowedParts}
            chainHolders={chainHolders}
            holdersCampaign={holdersCampaign}
            now={now}
            onPlaceTransistorOrder={(args) => act("placeTransistorOrder", args)}
            onOpenRefund={() => act("openRefund")}
            onRecoverBnb={() => act("recoverBnb")}
            onAbandonOrder={() => act("abandonOrder")}
            onCancelTransistorOrder={() => act("cancelTransistorOrder")}
            onSellTransistors={(args) => act("sellTransistors", args)}
            onWithdrawMarketProceeds={() => act("withdrawMarketProceeds")}
            onConfirmTransistors={() => act("confirmTransistors")}
            onSetPlan={() => act("setPlan")}
            onSetMiningPool={(args) => act("setMiningPool", args)}
            onDepositToPool={() => act("depositToPool")}
            onReturnSurplus={() => act("returnSurplus")}
            onRemoveCampaign={(address) => act("removeCampaign", { campaign: address })}
            onOpenRound={() => openPage("round")}
            onOpenAssets={() => openPage("assets")}
            onCreate={handleCreate}
            onConnect={handleConnect}
            onInvoke={invokeCall}
          />
        )}
        {page === "market" && (
          <MarketPage
            official={official}
            processorId={round?.processorId || null}
            allowedParts={allowedParts}
            campaigns={usingChain ? chain.campaigns : []}
          />
        )}
        {page === "rules" && <RulesPage campaigns={usingChain ? chain.campaigns : []} />}
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
            /*
             * 下拉里不画认购状态徽标：一是与「第 N 期」同排太挤，
             * 二是「成交」在晶体管市场另有含义（晶体管成交），摆在期次旁容易被读成
             * 「本期晶体管已买到」。要看去期次本身的主状态徽标与资产列表。
             */
            return (
              <li key={item.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={on ? "is-on" : ""}
                  onClick={() => go(item)}
                >
                  <span>第 {item.id} 期</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 期次标题。
 *
 * 期号后面**不再跟阶段词**：右侧的徽标已经写着「待执行 / 挖矿中 / 已结束」，
 * 旧版 `第 2 期 · 待执行` + 徽标 `待执行` 会在同一行把同一个词印两遍。
 * 期号只负责「第几期」，状态归徽标，认购达成度归 deal 徽标 —— 三层各出现一次。
 */
function RoundTitle({ id, lead, badge, tone, periods, onSwitchPeriod, processor, deal }) {
  const hasNav = Array.isArray(periods) && periods.length > 0 && onSwitchPeriod;
  const dealBadge = deal && deal.label ? (
    <span className={`deal-badge ${deal.cls}`} title="认筹状态：认购中 / 已售罄">{deal.label}</span>
  ) : null;
  return (
    <header className="round-hero">
      <div className="round-hero-row">
        <div className="round-title">
          <span className="round-mark" title={processor || "挖矿类型"}>
            <ProcessorGlyph name={processor} size={18} />
          </span>
          <h1>BEM众筹挖矿</h1>
          {!hasNav && <span className="round-period">第 {id} 期</span>}
          {dealBadge}
          <span className={`badge tone-${tone}`}>{badge}</span>
        </div>
        {hasNav ? <PeriodNav periods={periods} currentId={id} onSwitch={onSwitchPeriod} /> : null}
      </div>
      {lead ? <p className="round-hero-lead">{lead}</p> : null}
    </header>
  );
}

/**
 * 执行失败且认筹已全部退回：大状态结束，不再停在待执行。
 * 判定与措辞都走 ./roundState.js（`roundState(row).key === "ended"`），这里不再各写一份。
 */
function refundSettled(row) {
  return roundState(row).key === "ended" && Boolean(row?.executionFailed);
}

/** 某期的「已售未退」份数（当前债务）。实现见 ./roundState.js，此处转出给历史调用点。 */
export { outstandingOf };

/**
 * 众筹认购「成交状态」的统一实现见 ./dealStatus.js；
 * 阶段 / 子状态词表见 ./roundState.js —— 期次标题、生命周期条、资产列表、
 * Owner 卡片共用那一份，这里只负责渲染，不再自己写字面量。
 */

/**
 * 生命周期进度条：募集 → 待执行 → 挖矿。
 *
 * 子状态只挂在**当前那一步**下面，全页仅此一处 —— 之前阶段词在这里出现一次、
 * 在「当前进度」的 bill 行里又出现一次、晶体管市场面板的 stage 行还出现一次，
 * 同一屏三处讲同一件事，措辞还各不相同。
 */
function LifecycleStrip({ book }) {
  const state = roundState(book);
  const steps = [
    { id: "funding", label: SCENE.funding.label },
    { id: "executing", label: SCENE.executing.label },
    { id: "mining", label: SCENE.mining.label },
  ];
  /** 终态停在哪一步：募集流标停在第 1 步，执行失败收尾停在第 2 步。 */
  const endedAt = state.key === "ended" ? (state.sceneKey === "funding" ? 0 : 1) : -1;
  const failed = state.key === "failed";
  const idx = endedAt >= 0
    ? endedAt
    : Math.max(0, steps.findIndex((s) => s.id === state.sceneKey));
  const hint = endedAt >= 0
    ? state.substate
    : failed
      ? state.substate
      : state.sceneKey === "executing"
        ? state.phase.full
        : null;
  const labelOf = (step) => {
    if (endedAt >= 0 && step.id === steps[endedAt].id) return ENDED.label;
    if (failed && step.id === "executing") return FAILED.label;
    return step.label;
  };
  return (
    <div className="life-strip" aria-label="本期生命周期">
      {steps.map((step, i) => (
        <div key={step.id} className="life-step-wrap">
          <div className={`life-step${i < idx ? " is-done" : ""}${i === idx ? " is-active" : ""}${i === endedAt ? " is-ended" : ""}`}>
            <span className="life-dot">{i + 1}</span>
            <span className="life-text">
              <span className="life-label">{labelOf(step)}</span>
              {i === idx && hint ? <span className="life-phase">{hint}</span> : null}
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
  round, book, copy, quote, remaining, pay, countdown, executeWait,
  pending, connected, actor, onChain, onPick, onSubscribe, onRefund, onAbort, onMarkFailed, onOpenOwner, onOpenAssets, onOpenTransfer, onRecoverBnb,
  usingChain = false, periods, onSwitchPeriod,
}) {
  const isOwner = actor?.role === "owner";
  const ended = refundSettled(book);
  /**
   * 阶段 / 子状态 / 认购徽标（见 ./roundState.js + ./dealStatus.js）。
   * 全页只算一次：标题徽标、生命周期条、进度卡、晶体管市场面板都用这一份，
   * 不再各写一套字面量。
   */
  const state = rowState(book, Date.now() / 1000, dealStatus);

  // 待执行：晶体管市场成交进度（官方市场只有买单簿，卖出是吃单）。
  const buyLegs = [
    { part: "NAND", qty: Number(book.nandQty) || 0, remaining: book.nandRemaining, price: Number(book.nandPrice) || 0 },
    { part: "LATCH", qty: Number(book.latchQty) || 0, remaining: book.latchRemaining, price: Number(book.latchPrice) || 0 },
  ].filter((leg) => leg.qty > 0);
  const buyQty = buyLegs.reduce((acc, leg) => acc + leg.qty, 0);
  /**
   * 已成交量 = 挂单量 − 市场剩余。
   * remaining 读不到（RPC 失败）时按「未成交」算，不能按 0 算——
   * 那会把一笔还在等的挂单显示成全部成交，与市场记录自相矛盾。
   */
  const filledOfLeg = (leg) => Math.max(0, leg.qty - (leg.remaining == null ? leg.qty : Number(leg.remaining)));
  const buyFilled = buyLegs.reduce((acc, leg) => acc + filledOfLeg(leg), 0);
  /** 卖出没有挂单量，这里不推算：成交明细由 MarketTrades 从 TransistorsSold 事件读取。 */
  const sellQty = 0;
  const sellFilled = 0;
  const marketOwed = Number(book.marketOwed) || 0;
  /**
   * 晶体管数量有几个不同口径，不能混用：
   *  - nandQty / latchQty：**挂单量**（下单要买多少）。合约在 placeTransistorOrder 就写入，
   *    成交前不代表已买到，不能拿它当「已买入晶体管」。
   *  - partsOnHand：合约 ERC1155 余额，只在晶体管还留在本期合约里时大于 0（入池后归 0）。
   *  - transistorCount：**已成交到账量**（各腿 挂单量 − 市场 remaining），入池后仍可展示。
   *  - buyFilled：买单成交进度，与 transistorCount 同口径。
   */
  const partsOnHand = (Number(book.partsNand) || 0) + (Number(book.partsLatch) || 0);
  const boughtParts = Number(book.transistorCount) || 0;
  const tradeKey = [
    book.executePhase, book.nandRemaining, book.latchRemaining, book.marketOwed,
    book.partsNand, book.partsLatch, book.orderFilled,
  ].join("|");

  return (
    <>
      <LifecycleStrip book={book} />

      {book.scene === "funding" && (
        <ProductPage
          round={round}
          book={book}
          copy={copy}
          quote={quote}
          remaining={remaining}
          pay={pay}
          countdown={countdown}
          executeWait={executeWait}
          pending={pending}
          connected={connected}
            onChain={onChain}
            onPick={onPick}
            onSubscribe={onSubscribe}
            onRefund={onRefund}
            usingChain={usingChain}
            periods={periods}
            onSwitchPeriod={onSwitchPeriod}
          />
        )}

      {book.scene === "executing" && (
        <section>
          <RoundTitle
            id={round.id}
            lead={state.key === "ended"
              ? "执行失败，认筹款已按认筹地址全部原路退回。"
              : state.key === "failed"
                ? "执行失败，本金未支出。持份人可原路退回，Owner 也可降价重挂。"
                : "份数已售完。Owner 买入晶体管、确认到账后投入矿池；入池前会先把没花完的募集款按份退回持份人。"}
            badge={state.label}
            tone={state.tone}
            deal={state.deal}
            periods={periods}
            onSwitchPeriod={onSwitchPeriod}
            processor={round.processorId || "未记录"}
          />
          <RoundFacts round={round} book={book} quote={quote} />
          <article className="card progress-card">
            <div className="card-header">当前进度</div>
            <div className="card-body">
              {/*
               * 这里只放**数字**。
               * 旧版在「买单成交」一格的值里写「挂单中 / 待挂单」——那是子状态，
               * 生命周期条已经在当前步下面说过一次，同一个词在一屏里出现两遍。
               */}
              <ul className="bill">
                <li><span>已募</span><strong>{book.sold} / {round.totalShares} 份</strong></li>
                <li><span>托管 BNB</span><strong>{round4(book.bnbPool || 0)} BNB</strong></li>
                <li>
                  <span>
                    {book.pooled ? "已入池晶体管" : book.executePhase === "ready" ? "晶体管库存" : "买单成交"}
                  </span>
                  <strong className={book.executePhase !== "ready" && buyQty > 0 && buyFilled < buyQty ? "is-wait" : undefined}>
                    {book.pooled && boughtParts > 0
                      ? `${boughtParts} 颗（已转入矿池）`
                      : book.executePhase === "ready" && partsOnHand > 0
                        ? `${partsOnHand} 颗在手`
                        : buyQty > 0
                          ? `${buyFilled} / ${buyQty} 颗`
                          : "—"}
                  </strong>
                </li>
                <li>
                  <span>{marketOwed > 0 ? "市场欠款" : "市场结算"}</span>
                  <strong style={marketOwed > 0 ? { color: "var(--color-primary)" } : undefined}>
                    {marketOwed > 0 ? `待提取 ${round4(marketOwed)} BNB` : "—"}
                  </strong>
                </li>
              </ul>
              {/*
               * 这一段只讲**上面没讲过的机制细节**：
               * 阶段词归徽标、子状态归生命周期条、失败后的动作归 hero lead，
               * 这里再说一遍就成了同一句话的第三次。
               */}
              {state.key === "ended" ? (
                <p className="fine">
                  {Number(book.bnbPool || 0) > 0
                    ? `认筹份额已全部退完，合约里只剩 ${round4(book.bnbPool)} BNB 尾差（卖出净额或除法取整）。点「取回剩余 BNB」一次性扫给 Owner；没有可退的人时，批量退款会直接回滚。`
                    : "合约已清空：没有可退对象，也没有可取余额。已终结的期次不能再挂单或入池，需要开新一期。"}
                </p>
              ) : state.key === "failed" ? (
                state.short ? (
                  <p className="fine">
                    托管池只够按 {round4(Number(book.bnbPool || 0) / Math.max(1, outstandingOf(book)))} BNB/份 兑付，合约允许持份人按比例退款。
                  </p>
                ) : null
              ) : (
                <p className="fine">
                  没花完的募集款按份退回持份人：入池前先记账（本期继续、晶体管留在合约、之后照样能入池），入池那一刻也会自动记账；两种都由持份人自己 claimSurplus 领取。
                </p>
              )}
              <div className="actions">
                {isOwner && book.executePhase === "buying" && (
                  <>
                    {outstandingOf(book) > 0 && (
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={Boolean(pending)}
                        onClick={() => onOpenOwner()}
                      >
                        {book.executionFailed ? "去 Owner · 降价重挂" : "去 Owner 工作台 · 挂单"}
                      </button>
                    )}
                    {outstandingOf(book) > 0 ? (
                      <button
                        className="btn btn-outline btn-inline"
                        type="button"
                        disabled={Boolean(pending)}
                        onClick={onAbort}
                      >
                        {pending || (book.executionFailed ? "退款剩余" : "退款")}
                      </button>
                    ) : Number(book.bnbPool || 0) > 0 ? (
                      // 份额已全部退完（sold == 0）：openRefund 没有可退对象，链上会 ZeroShares 回滚。
                      // 该状态下唯一能动的就是池子里的尾差/溢价，用 recoverBnb 一次扫给 Owner。
                      <button
                        className="btn btn-outline btn-inline"
                        type="button"
                        disabled={Boolean(pending)}
                        onClick={() => onRecoverBnb()}
                      >
                        {pending === "recoverBnb" ? "取回中…" : "取回剩余 BNB"}
                      </button>
                    ) : null}
                  </>
                )}
                {isOwner && book.executePhase !== "buying" && !book.executionFailed && (
                  <button className="btn btn-primary" type="button" onClick={onOpenOwner}>
                    去 Owner 工作台 · 入池
                  </button>
                )}
                {isOwner && book.executePhase === "ready" && book.executionFailed && (
                  <button className="btn btn-primary" type="button" onClick={onOpenOwner}>
                    去 Owner · 撤回重挂
                  </button>
                )}
                {!book.executionFailed && book.markFailedAt && Date.now() >= book.markFailedAt && (
                  <button
                    className="btn btn-outline btn-inline"
                    type="button"
                    disabled={Boolean(pending)}
                    onClick={onMarkFailed}
                    title="售罄满 3 天仍未入池：任何人都可把本期判为失败，为所有持有人打开退款"
                  >
                    {pending === "markFailed" ? "标记中…" : "Owner 长期未入池 · 判失败并开放退款"}
                  </button>
                )}
                {!book.executionFailed && book.markFailedAt && Date.now() < book.markFailedAt && (
                  <p className="fine">
                    Owner 还没入池。合约给 Owner 留了 3 天窗口买晶体管，
                    {isOwner
                      ? "你可以随时在 Owner 工作台「原路退款 / 放弃挂单」立即退款，不必等这 3 天。"
                      : `非 Owner 的判失败逃生口在 ${formatClock(book.markFailedAt)} 打开（还需 ${formatRemaining(book.markFailedAt - Date.now())}），届时会先撤掉未成交的买单、把托管退回募集池，再开放退款。`}
                  </p>
                )}
                {(book.executionFailed || (book.scene === "funding" && book.endsAt && Date.now() > book.endsAt)) && (
                  <button className="btn btn-outline btn-inline" type="button" onClick={onOpenAssets}>
                    我的资产 · 退款
                  </button>
                )}
                {!(book.executionFailed || (book.scene === "funding" && book.endsAt && Date.now() > book.endsAt)) && (
                  <button className="btn btn-outline btn-inline" type="button" onClick={onOpenAssets}>
                    我的资产
                  </button>
                )}
              </div>
            </div>
          </article>
          {book._chain && !ended && (
            <MarketTrades
              campaignAddr={book.address || round.contract}
              refreshKey={tradeKey}
              fallbackRows={{
                buyQty, buyFilled, sellQty, sellFilled, marketOwed,
                nandQty: Number(book.nandQty) || 0,
                latchQty: Number(book.latchQty) || 0,
                nandRemaining: book.nandRemaining,
                latchRemaining: book.latchRemaining,
                nandPrice: Number(book.nandPrice) || 0,
                latchPrice: Number(book.latchPrice) || 0,
                nandBidId: book.nandBidId, latchBidId: book.latchBidId,
                partsOnHand,
              }}
            />
          )}
          {book._chain && (ended || book.executionFailed || book.refundShort) && (
            <RefundRecords
              campaignAddr={book.address || round.contract}
              refreshKey={`${book.refundedTotal}|${book.sold}|${book.bnbPool}`}
              account={book.selfAddress}
              fallback={{ totalRefunded: book.refundedTotal, pool: book.bnbPool, mine: book.refundedSelf }}
            />
          )}
        </section>
      )}

      {book.scene === "mining" && (() => {
        /**
         * 挖矿中的四个指标共用一套版式：标签 / 数值 + 单位 / 说明。
         * 数值统一 20px、单位降级到 13px；「已入池 · 不可逆」这类长文案改用胶囊，
         * 不再和数字抢同一档字号。说明行贴底，四张卡的说明落在同一条基线上。
         */
        const pooledParts = Number(book.transistorCount) || 0;
        const hashpower = Number(book.estHashpower || 0);
        const mine = Number(book.mine || 0);
        const totalShares = Number(round.totalShares) || 0;
        const sharePercent = totalShares > 0 ? (mine / totalShares) * 100 : 0;
        return (
          <section className="mining-desk">
            <RoundTitle
              id={round.id}
              lead="本期晶体管已投入矿池，进入挖矿。"
              badge={state.label}
              tone={state.tone}
              deal={state.deal}
              periods={periods}
              onSwitchPeriod={onSwitchPeriod}
              processor={round.processorId || "未记录"}
            />
            <div className="mining-stats">
              <article className="mining-stat is-accent">
                <p className="mining-stat-label">入池晶体管</p>
                <p className="mining-stat-value">
                  {pooledParts.toLocaleString("zh-CN")}
                  <span className="mining-stat-unit">颗</span>
                </p>
                <p className="mining-stat-note">成交到账的 NAND + LATCH 数量</p>
              </article>
              <article className="mining-stat">
                <p className="mining-stat-label">预估算力</p>
                <p className="mining-stat-value">
                  {hashpower.toLocaleString("zh-CN")}
                  <span className="mining-stat-unit">H</span>
                </p>
                <p className="mining-stat-note">setPlan 写入的估算值，不是实测产出</p>
              </article>
              <article className="mining-stat">
                <p className="mining-stat-label">我的份数</p>
                <p className="mining-stat-value">
                  {mine.toLocaleString("zh-CN")}
                  <span className="mining-stat-unit">/ {totalShares.toLocaleString("zh-CN")} 份</span>
                </p>
                <p className="mining-stat-note">
                  {mine > 0 ? `占本期 ${sharePercent % 1 === 0 ? sharePercent : sharePercent.toFixed(2)}%` : "当前钱包未持有本期份额"}
                </p>
              </article>
              <article className="mining-stat">
                <p className="mining-stat-label">本期状态</p>
                <p className="mining-stat-value is-text">
                  <span className="mining-pill">已入池</span>
                </p>
                {/* 「不可逆」只在这里说一次：页面别处（lead / 卡片头 / 晶体管去向）不再复述 */}
                <p className="mining-stat-note">入池不可逆，合约无法再取回晶体管</p>
              </article>
            </div>
            <article className="card mining-card">
              <div className="card-header">
                <span>挖矿状态</span>
              </div>
              <div className="card-body">
                <dl className="mining-facts">
                  <div className="mining-fact">
                    <dt>产出发放</dt>
                    <dd>分配合约接入前，harvest / claim 为占位空实现，暂不发放</dd>
                  </div>
                  <div className="mining-fact">
                    <dt>退出方式</dt>
                    <dd>只能把份额挂到转让市场，由其他持份人接收；没有本金赎回</dd>
                  </div>
                </dl>
                <div className="mining-actions">
                  <button className="btn btn-primary" type="button" onClick={onOpenTransfer}>
                    资产转让
                  </button>
                  <button className="btn btn-outline" type="button" onClick={onOpenAssets}>
                    我的资产
                  </button>
                </div>
              </div>
            </article>
          </section>
        );
      })()}
    </>
  );
}

/**
 * 「我的资产」表格 / Owner 卡片的阶段、认购徽标、子状态。
 * 三层一次算完，措辞与链上摘要共用 ./roundState.js 那一份 —— 这里不再写字面量。
 * （旧版这里有 `超时未售罄 / 认筹中 / 已失败原路退款 / 执行失败 · 可退款 /
 *   池子不足 · 按比例退 / 已到账 · 待入池 / 挂单中 / 待挂单 / 已入池 · 不可逆` 九套词，
 *   与 adapter 的 note、Owner 的 statusNote 互不相同。）
 */
function assetState(row, nowSec) {
  const state = rowState(row, nowSec, dealStatus);
  // 「Owner 尚未入池、任何人可判失败」是操作性提示，不属于子状态，单独给。
  const canMarkFailed = assetCanMarkFailed(row, nowSec);
  return { ...state, hint: canMarkFailed ? "Owner 未入池 · 可判失败" : "" };
}

/** 当前钱包买过、退过，或仍有挂单锁定的期。 */
function participated(row) {
  return Number(row.shares) > 0
    || Number(row.escrow) > 0
    || Number(row.refundedBnb) > 0;
}

/** 与合约 refund() 对齐：募集超时未售罄，或待执行且已判执行失败；须有可用份额且无挂单锁定。 */
function assetCanRefund(row, nowSec) {
  const free = Number(row.shares || 0);
  if (free <= 0 || Number(row.escrow || 0) > 0) return false;
  if (row.scene === "funding") {
    return row.fundingDeadline > 0
      && nowSec > row.fundingDeadline
      && Number(row.sold) < Number(row.totalShares);
  }
  if (row.scene !== "executing") return false;
  if (row.executionFailed) return true;
  // 买单部分成交后撤单，池子可能已不够按份全退：合约允许持份人按比例自取。
  return row.phase === "buying" && refundShortfall(row) > 0;
}

/** 与合约 markFailed 对齐：售罄满 3 天后，任何地址都可把待执行期次判失败。 */
function assetCanMarkFailed(row, nowSec) {
  if (row.scene !== "executing" || row.executionFailed) return false;
  if (!row.markFailedAt) return false;
  return nowSec * 1000 >= Number(row.markFailedAt);
}

/** 合约口径：raisedBnb < sold × sharePriceBnb 时持份人可按比例退款。 */
function refundShortfall(row) {
  const need = Number(row.sold || 0) * Number(row.sharePriceBnb || 0);
  return Math.max(0, need - Number(row.raisedBnb || 0));
}

function AssetsHub({
  round, book, copy, pending, connected, usingChain,
  positions, positionsLoading,
  onRefund, onMarkFailed, onClaimSurplus, onOpenPeriod, onConnect,
}) {
  const rows = usingChain
    ? (positions || [])
    : [{
        id: round.id,
        address: round.contract,
        scene: book.scene,
        sceneLabel: copy.badge,
        phase: book.executePhase || "",
        sold: book.sold,
        outstandingShares: outstandingOf(book),
        totalShares: round.totalShares,
        sharePriceBnb: round.sharePriceBnb,
        executionFailed: Boolean(book.executionFailed),
        fundingDeadline: book.endsAt ? Math.floor(book.endsAt / 1000) : 0,
        shares: connected ? book.mine : null,
        escrow: connected ? book.listingShares || 0 : 0,
        refundedBnb: book.refundedSelf || 0,
        raisedBnb: book.bnbPool || 0,
      }];
  const mineRows = rows.filter(participated);
  const held = mineRows.filter((row) => Number(row.shares) + Number(row.escrow) > 0);
  const shareSum = held.reduce((sum, row) => sum + Number(row.shares || 0) + Number(row.escrow || 0), 0);
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
          只列出当前钱包参与过的期次。没买过也没退过的期不显示。
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
          <div className="stat-value">{connected ? `${mineRows.length} 期` : "—"}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">我持有的期</div>
          <div className="stat-value">{connected ? `${held.length} 期` : "—"}</div>
        </article>
        <article className="stat-card">
          <div className="stat-label">合计份数</div>
          <div className="stat-value">{connected ? `${shareSum} 份` : "—"}</div>
        </article>
      </div>

      <article className="card">
        <div className="card-header">我参与的期次</div>
        <div className="card-body table-wrap">
          {!connected ? (
            <p className="fine">连接钱包后，这里只显示你参与过的期。</p>
          ) : positionsLoading && mineRows.length === 0 ? (
            <p className="fine">正在读取你参与的期次…</p>
          ) : mineRows.length === 0 ? (
            <p className="fine">当前钱包还没有参与过的期次。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>期次</th>
                  <th>状态</th>
                  <th>募集</th>
                  <th>我的份数</th>
                  <th>已退</th>
                  <th>待领余款</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mineRows.map((row) => {
                  const canRefund = connected && assetCanRefund(row, nowSec);
                  const canMarkFailed = connected && assetCanMarkFailed(row, nowSec);
                  // 池子不足时合约按比例退，按钮金额必须与实际到账一致。
                  const need = outstandingOf(row) * Number(row.sharePriceBnb || 0);
                  const raised = Number(row.raisedBnb || 0);
                  const short = need > 0 && raised < need;
                  const refundBnb = short
                    ? round4((raised * Number(row.shares || 0)) / Math.max(1, outstandingOf(row)))
                    : round4(Number(row.shares || 0) * Number(row.sharePriceBnb || 0));
                  /*
                   * 三段文字全部来自 ./roundState.js：
                   *   stage    阶段（已结束 / 执行失败 / 募集中 / 待执行 / 挖矿中）
                   *   deal     认购徽标（空则不画，避免与阶段词重复）
                   *   substate 当前卡点 / 原因
                   * 旧写法在这里用 row.sceneLabel + 自写 tone + assetSubstatus 三套并行口径，
                   * 同一个「已结束」会在阶段与徽标上各印一次。
                   */
                  const state = assetState(row, nowSec);
                  const sub = state.hint || state.substate;
                  return (
                    <tr key={row.address || row.id}>
                      <td>第 {row.id} 期</td>
                      <td className="asset-status-cell">
                        <div className={`asset-status tone-${state.tone}`}>
                          <div className="asset-status-head">
                            <strong>{state.label}</strong>
                            {state.deal && state.deal.label ? (
                              <span className={`deal-badge ${state.deal.cls}`}>{state.deal.label}</span>
                            ) : null}
                          </div>
                          {sub ? <p className="asset-status-sub">{sub}</p> : null}
                        </div>
                      </td>
                      <td>{row.totalShares ? `${outstandingOf(row)}/${row.totalShares}` : "—"}</td>
                      <td>{`${Number(row.shares || 0) + Number(row.escrow || 0)} 份`}</td>
                      <td>{connected ? `${round4(row.refundedBnb || 0)} BNB` : "—"}</td>
                      <td>{connected && Number(row.pendingSurplusBnb || 0) > 0
                        ? `${round4(row.pendingSurplusBnb)} BNB`
                        : "—"}</td>
                      <td>
                        <div className="actions assets-actions">
                          <button className="btn btn-inline" type="button" onClick={() => onOpenPeriod(row.address)}>
                            打开
                          </button>
                          {canMarkFailed && (
                            <button
                              className="btn btn-inline"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={() => onMarkFailed(row.address)}
                              title="售罄满 3 天仍未入池：任何地址都可判失败，为持有人打开退款"
                            >
                              {pending === "markFailed" ? "标记中…" : "判失败并退款"}
                            </button>
                          )}
                          {canRefund && (
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={() => onRefund(row.address)}
                            >
                              {pending || `原路退还 ${refundBnb} BNB`}
                            </button>
                          )}
                          {connected && Number(row.pendingSurplusBnb || 0) > 0 && (
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={() => onClaimSurplus(row.address)}
                              title="按份应得、还没转到你地址的余款（提前退余款或入池记账后产生）；领取后到账"
                            >
                              {pending === "claimSurplus" ? "领取中…" : `领取 ${round4(row.pendingSurplusBnb)} BNB`}
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
    </section>
  );
}

/** Owner 工作台：开期 / 入池 / 持有人 / 调用 / 调试 */
function OwnerDesk({
  tab, onTab, tabs, round, book, copy, quote, official, pending, pendingTarget, actor, account,
  executeWait, connected, usingChain, chain, factoryOwner, allowedParts, chainHolders, holdersCampaign, now,
  onPlaceTransistorOrder, onOpenRefund, onAbandonOrder, onCancelTransistorOrder, onConfirmTransistors,
  onSellTransistors, onWithdrawMarketProceeds,
  onSetPlan,
  /**
   * 入池前两步的回调。必须由OwnerDesk 显式透传给 OwnerOverview——
   * 之前漏了这两个，OwnerOverview 里的按钮走 `onXxx?.()` 可选调用，
   * 于是点了**完全没有反应**（连报错都没有）：这种静默失败最难查。
   */
  onSetMiningPool, onDepositToPool, onReturnSurplus,
  onRemoveCampaign, onOpenRound, onOpenAssets,
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
          official={official}
          pending={pending}
          pendingTarget={pendingTarget}
          actor={actor}
          executeWait={executeWait}
          history={chain.active ? chain.campaigns : null}
          onSwitchCampaign={usingChain ? chain.switchCampaign : null}
          onPlaceTransistorOrder={onPlaceTransistorOrder}
          onOpenRefund={onOpenRefund}
          onAbandonOrder={onAbandonOrder}
          onCancelTransistorOrder={onCancelTransistorOrder}
          onSellTransistors={onSellTransistors}
          onWithdrawMarketProceeds={onWithdrawMarketProceeds}
          onConfirmTransistors={onConfirmTransistors}
          onSetPlan={onSetPlan}
          onSetMiningPool={onSetMiningPool}
          onDepositToPool={onDepositToPool}
          onReturnSurplus={onReturnSurplus}
          onRemoveCampaign={onRemoveCampaign}
          onOpenRound={onOpenRound}
          onOpenAssets={onOpenAssets}
          account={account}
          connected={connected}
          signer={chain.signer}
          chainHolders={chainHolders}
          holdersCampaign={holdersCampaign}
          onInvoke={onInvoke}
          transistorUnitPrice={usingChain ? chain.transistorUnitPrice : null}
        />
      )}
      {tab === "create" && (
        <OwnerCreate
          pending={pending}
          snapshot={quote}
          now={now}
          chainMode={Boolean(chain?.active)}
          factoryOwner={factoryOwner}
          connectedAccount={chain?.account || ""}
          defaultFeeRecipient={chain?.account || ""}
          allowedParts={allowedParts}
          onCreate={onCreate}
          onConnect={onConnect}
        />
      )}
    </section>
  );
}

function ProcessorGlyph({ name, size = 18 }) {
  /**
   * 官方处理器各一个记号：
   *   Behemoth —— 四位机，加中间竖线（早期支持者溢价）
   *   TapeOut —— 基础机，单竖线
   * T-59：Genesis CPU 记号已删除（该处理器已整体移除）。
   */
  const kind = name === "Behemoth" ? "behemoth" : "tapeout";
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M12 3.2 19.2 9 12 20.8 4.8 9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M4.8 9h14.4" stroke="currentColor" strokeWidth="1.5" />
      {kind === "behemoth" && <path d="M12 3.2 9.4 9 12 20.8 14.6 9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />}
      {kind === "tapeout" && <path d="M12 3.2v17.6" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

function RoundFacts({ round, book, quote }) {
  const est = estimateHashpower(round, quote, round.totalShares);
  const namedProcessor = Boolean(round.processorId);
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  /**
   * 晶体管数与算力的权威口径：链上以「实际成交到账的晶体管」为准。
   *  - transistorCount = 各腿（挂单量 − 市场 remaining），成交后才大于 0。
   *    ⚠️ 不能用 nandQty + latchQty —— 合约在 placeTransistorOrder 时就把这两个
   *    字段写成**下单量**，成交前拿它当「已买入」会让等待成交的期次显示已买到晶体管。
   *  - hashpower = estHashpower，是 Owner 用 setPlan 写入的预估算力。
   * 链下演示模式没有链上数据，仍用募资额反推的估算值。
   */
  const onChain = Boolean(book?._chain);
  const chainParts = Number(book?.transistorCount) || 0;
  /** 挂单量（下单要买多少）：用来区分「还没挂单」与「已挂单等待成交」。 */
  const bidParts = (Number(book?.nandQty) || 0) + (Number(book?.latchQty) || 0);
  const chainHashpower = Number(book?.hashpower) || Number(book?.estHashpower) || 0;
  /** 链上已有成交晶体管 → 展示真实值；否则展示募资反推的预期值并标注是预期。 */
  const hasBought = chainParts > 0;
  const partsValue = onChain ? (hasBought ? chainParts : null) : (est.usedParts || null);
  const weightValue = onChain ? (chainHashpower > 0 ? chainHashpower : null) : (est.hashpower || null);
  /** 晶体管数与算力是否来自链上真实数据 */
  const partsFromChain = onChain && hasBought;
  /**
   * 处理器与每颗算力 P：
   *  - 名称优先用合约里锁定的 transistors 地址反推出来的 processorId；
   *  - P 只在「有已成交晶体管」时才敢给——P 是每颗晶体管的算力标度，
   *    没有晶体管数时它无法对应到任何真实数量，链上模式一律留空。
   *  - 链上如果连处理器都没记录，可以从「已成交晶体管数 + setPlan 算力」反推标度（P ≈ H ÷ 晶体管数）。
   */
  const shownProcessor = round.processorId || (onChain ? null : est.processor) || null;
  const inferredScale = hasBought && chainHashpower > 0 ? chainHashpower / chainParts : null;
  const shownScale = onChain
    ? (hasBought ? (shownProcessor ? processorScale(shownProcessor) : inferredScale) : null)
    : (est.processorScale || null);
  /**
   * 服务费（链上口径）：serviceFeeBps 从 Campaign 读。
   * serviceFeeSet 区分「还没设过」与「已设为 0」——前者还能改，后者已永久锁定。
   *
   * ⚠️ 口径：这里的「服务费」是**挖矿产出奖励的服务费**（从矿池打进来的收益里计提），
   * **与认筹款无关** —— 认购人付的 BNB 全额进认购托管池，不收任何服务费。
   */
  const chainFeeSet = Boolean(round.serviceFeeSet);
  const chainFeePercent = Number(round.serviceFeeBps ?? 0) / 100;
  const shownScaleText = shownScale == null
    ? "—"
    : Number.isInteger(shownScale) ? String(shownScale) : shownScale.toFixed(2);
  return (
    <>
      <div className="stat-grid facts">
        <article className="stat-card">
          <div className="stat-label">{partsFromChain ? "已买入晶体管" : "晶体管数"}</div>
          <div className="stat-value">
            {partsValue != null
              ? `${partsValue} 颗`
              : onChain && bidParts > 0
                ? <span className="muted-value">待成交</span>
                : "未买入"}
          </div>
          <div className="stat-note">
            {partsFromChain ? (
              <>
                权重 {weightValue != null ? weightValue.toLocaleString("zh-CN") : "—"} H
                {" · "}NAND {Number(book.nandFilled ?? 0) || 0} · LATCH {Number(book.latchFilled ?? 0) || 0}
                <em className="est-tag">成交口径</em>
              </>
            ) : onChain ? (
              bidParts > 0
                ? `已挂单 ${bidParts} 颗（NAND ${Number(book.nandQty) || 0} · LATCH ${Number(book.latchQty) || 0}），等待成交`
                : "尚未挂单买入，晶体管与算力待成交后确定"
            ) : est.hashpower ? (
              `权重 ${est.hashpower}（按募资额预估）`
            ) : (
              ""
            )}
          </div>
        </article>
        <article className="stat-card">
          <div className="stat-label">目标处理器</div>
          <div className="stat-value processor-value">
            <span>{shownProcessor || "未记录"}</span>
            <span className="processor-scale">P={shownScaleText}</span>
          </div>
          {onChain && !shownProcessor ? (
            <div className="stat-note">合约未写入处理器地址，算力规模无法反推</div>
          ) : onChain && !hasBought ? (
            <div className="stat-note">每颗算力 P 待晶体管成交后才有意义</div>
          ) : null}
        </article>
        {/*
         * 每份 / 总份数 / 募资总额是同一组发行参数（募资总额 = 每份 × 总份数），
         * 拆成三张卡等于把一条恒等式摊开占三格。合并成一张三行小卡，
         * 指标卡从 6 张减到 4 张，首屏不再被发行参数占满。
         */}
        <article className="stat-card">
          <div className="stat-label">发行参数</div>
          <dl className="stat-rows">
            <div><dt>每份</dt><dd>{round.sharePriceBnb.toFixed(4)} BNB</dd></div>
            <div><dt>总份数</dt><dd>{round.totalShares}</dd></div>
            <div><dt>募资总额</dt><dd>{hardCap.toFixed(4)} BNB</dd></div>
          </dl>
        </article>
        <article className="stat-card">
          <div className="stat-label">挖矿产出服务费</div>
          {/*
           * 服务费**在链上**（口径：服务费真正上链）。
           * serviceFeeBps 从 Campaign 读，任何人都能看到，分成表也是链上地址表。
           *
           * 「未设定」与「设为 0%」是两回事：
           *  - 未设定（serviceFeeSet == false）：链上还没写过，还能改；
           *  - 设为 0：serviceFeeSet == true，已永久锁定，只是费率为零。
           * 所以这里按 serviceFeeSet 区分显示，不混为一谈。
           *
           * ⚠️ 这是**挖矿产出奖励**的服务费，不从认筹款里扣。
           */}
          {onChain ? (
            chainFeeSet ? (
              <>
                <div className="stat-value">{chainFeePercent}%</div>
                <div className="stat-note">链上设定 · 不可修改</div>
              </>
            ) : (
              <>
                <div className="stat-value"><span className="muted-value">未设定</span></div>
                <div className="stat-note">尚无人认购时可设定，此后永久锁定</div>
              </>
            )
          ) : (
            <div className="stat-value">{feePercentOf(round)}%</div>
          )}
        </article>
      </div>
      {/*
       * 第二排只在「有内容」时出现：
       *  - 演示模式：给出按报价反推的算力与估算口径；
       *  - 链上已成交：给出 setPlan 算力与锁价。
       * 链上尚未成交时，「未写入 / 成交后才出现」这两张空卡不画 —— 那句话已经在
       * 上面「晶体管数」卡的备注和下面的强制提示里各有一份，再画一排只会重复。
       */}
      {!onChain ? (
        <div className="stat-grid detail">
          <article className="stat-card span-3">
            <div className="stat-label">
              预估算力
              <em className="est-tag">按当前报价</em>
            </div>
            <div className="stat-value">
              {namedProcessor ? `${est.hashpower.toLocaleString("zh-CN")} H` : "—"}
            </div>
          </article>
          <article className="stat-card note-card half">
            <div className="stat-label">预估随报价浮动，不是承诺</div>
            <p className="note-copy">
              {round.processorId ? (
                <>
                  晶体管数由募资总额按当前报价反推：本期 {est.usedParts} 颗，
                  权重 H = {est.hashpower} = {est.usedParts} × {est.processorScale}（晶体管数 × 每颗算力）。
                  实际采购价随市场浮动，上面的算力只是估算。
                </>
              ) : (
                <>募资总额 {est.hardCapBnb.toFixed(4)} BNB。本期没有写入目标处理器，名称是未记录，P 留空。</>
              )}
            </p>
          </article>
        </div>
      ) : hasBought ? (
        <div className="stat-grid detail">
          <article className="stat-card accent span-3">
            <div className="stat-label">算力（setPlan 已上链）</div>
            <div className="stat-value">
              {chainHashpower > 0 ? `${chainHashpower.toLocaleString("zh-CN")} H` : "未写入"}
            </div>
            <div className="stat-note">预估，不是实测；harvest / claim 接入前不产出发放</div>
          </article>
          <article className="stat-card span-3">
            <div className="stat-label">锁价</div>
            <div className="stat-value">{Number(book.priceLock) > 0 ? `${round4(book.priceLock)} BNB` : "未锁"}</div>
            <div className="stat-note">挂单时锁定的晶体管总成本</div>
          </article>
        </div>
      ) : null}
      {/*
       * C-1 的强制提示（全局唯一一份，认购页按钮旁还有一份）。
       * 「晶体管数不构成本期承诺」必须一眼看到；正文压到一句，避免与上方卡片重复。
       */}
      <div className="commit-warning wide" role="note">
        <strong>晶体管数不构成本期承诺。</strong>
        <span>
          不约定买多少、也不约定买价，晶体管数与算力由 Owner 售罄后按市价买入决定，可能低于估值；
          BEM 分配合约接入前不产生实际发放。
        </span>
      </div>
    </>
  );
}

function ProductPage({ round, book, copy, quote, remaining, pay, countdown, executeWait, pending, connected, onPick, onSubscribe, onRefund, onChain = false, usingChain = false, periods, onSwitchPeriod }) {
  const progress = Math.round((book.sold / round.totalShares) * 100);
  const fundingOpen = book.scene === "funding" && (!book.endsAt || Date.now() <= book.endsAt);
  const fundingExpired = book.scene === "funding" && book.endsAt && Date.now() > book.endsAt;
  const canSubscribe = fundingOpen && remaining > 0;
  const refundBnb = round4((book.mine || 0) * round.sharePriceBnb);
  const maxPick = Math.max(remaining, 1);
  const hardCap = round.hardCapBnb ?? round.sharePriceBnb * round.totalShares;
  /** 预估算力随报价浮动；执行后 book.hashpower 才是实际值 */
  const est = estimateHashpower(round, quote, round.totalShares);
  /** 阶段 / 子状态 / 认购徽标（见 ./roundState.js + ./dealStatus.js）。募集截止未售罄已折算成「已结束」。 */
  const state = rowState(book, Date.now() / 1000, dealStatus);

  return (
    <section>
      <RoundTitle
        id={round.id}
        lead={fundingExpired ? "募集已截止且未售罄，本期不会进入执行。" : copy.lead}
        badge={state.label}
        tone={state.tone}
        deal={state.deal}
        periods={periods}
        onSwitchPeriod={onSwitchPeriod}
        processor={round.processorId || (book?._chain ? "未记录" : est.processor) || "未记录"}
      />

          <RoundFacts round={round} book={book} quote={quote} />

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
            <Countdown countdown={countdown} />
            {/*
             * 这里原本还有一条 Pipeline（募集 / 买晶体管 / 入池开矿），
             * 和页首的生命周期条是同一件事的两种画法，两条进度条并排出现。
             * 只留生命周期条（它带子状态），本卡只讲资金路径。
             *
             * 下方原有一段 `book.scene === "executing"` 的说明 —— 本组件只在募集中渲染，
             * 那段永远为假；同内容已在「待执行」页的 hero lead 里各说一次，故删除。
             */}
            <div className="path">
              <h2>资金只走这条路径</h2>
              <ol>
                <li>未售罄：到期后由认筹地址自己点退回，只退该钱包的本金。</li>
                <li>售罄：挂单买入 NAND / LATCH 晶体管，到账后投入矿池成为矿机。</li>
                <li>挖矿：晶体管入池后进入挖矿（不可逆），BEM 分配合约接入前不产出发放。</li>
              </ol>
              <p className="mono">{shortAddress(round.contract)} · {onChain ? "链上合约" : "预览地址"}</p>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header">{fundingExpired ? "退回认筹" : "选择份数"}</div>
          <div className="card-body">
            {fundingExpired ? (
              <>
                <p className="fine">
                  募集已截止且未满额。请用当时认筹的钱包点退回，合约只把这一份本金打回该地址。
                </p>
                <ul className="bill">
                  <li><span>我的份数</span><strong>{connected ? `${book.mine || 0} 份` : "—"}</strong></li>
                  <li className="due"><span>可退</span><strong>{connected ? `${refundBnb} BNB` : "—"}</strong></li>
                </ul>
                {connected && book.mine > 0 ? (
                  <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={onRefund}>
                    {pending === "refund" ? "退回中…" : pending || `退回 ${refundBnb} BNB`}
                  </button>
                ) : (
                  <p className="fine">{connected ? "当前钱包没有可退的份额。" : "连接认筹钱包后才能退回。"}</p>
                )}
              </>
            ) : (
              <>
            <Stepper
              value={book.picked}
              min={1}
              max={canSubscribe ? maxPick : book.picked}
              disabled={!canSubscribe}
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
            {/* 停止认筹时不再重复一句「本期已停止认筹」——下方按钮上就写着「已停止认筹」。 */}
            {canSubscribe ? <p className="remain">剩余 {remaining} 份，不能自填金额</p> : null}
            {/*
             * C-1 要求的**强制提示**（认购人点下去之前必须看到）：
             * 晶体管数不构成本期承诺。
             *
             * 之前只有一处小字说明「预估随报价浮动，不是承诺」，
             * 藏在页面上方的事实卡片里，认购按钮旁边什么都没有。
             * 认购是花钱动作，风险提示必须贴着按钮，且不能是折叠的、可跳过的。
             */}
            <div className="commit-warning" role="note">
              <strong>晶体管数不构成本期承诺。</strong>
              <span>
                本期募资额不指定买多少晶体管、也不指定买价。晶体管数与算力由 Owner 在售罄后按市价买入决定，
                随市场浮动，可能少于按当前报价反推的估值。
                {" "}挖矿收益 BEM 分配合约接入前不产生实际发放。
                {" "}本期挖矿产出服务费从矿池收益里计提，
                <strong>认筹款不收任何服务费</strong> —— 你付的 BNB 全额进认购托管池，只用于买晶体管。
              </span>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!canSubscribe || Boolean(pending)}
              onClick={onSubscribe}
              title={canSubscribe && connected && book.approved ? "Confirm subscription" : undefined}
            >
              {pending || subscribeLabel(book, connected, canSubscribe)}
            </button>
            <p className="fine">合约按「份数 × {round.sharePriceBnb} BNB」记账。直接转账不会记份。</p>
            <RecentBuys round={round} book={book} usingChain={usingChain || onChain} account={book.selfAddress} />
              </>
            )}
          </div>
        </article>
      </div>
      {book._chain && Number(book.refundedTotal) > 0 && (
        <RefundRecords
          campaignAddr={round.contract || book.address}
          refreshKey={`${book.refundedTotal}|${book.sold}|${book.bnbPool}`}
          account={book.selfAddress}
          fallback={{ totalRefunded: book.refundedTotal, pool: book.bnbPool, mine: book.refundedSelf }}
        />
      )}
    </section>
  );
}

function TransferPage({ round, book, copy, actor, account, pending, connected, onList, onCancel, onTake, onBrowse, onConnect, embedded = false, title = "份额转让", periods, onSwitchPeriod }) {
  const [pickShares, setPickShares] = useState(1);
  const [price, setPrice] = useState(String(round.sharePriceBnb));
  useEffect(() => {
    setPrice(String(round.sharePriceBnb));
    setPickShares(1);
  }, [round.id, round.sharePriceBnb]);
  const available = book.mine;
  const canTransfer = book.scene === "mining";
  const canPublish = available > 0 && canTransfer;
  /** 阶段词表见 ./roundState.js（转让页只在这里印一次阶段词）。 */
  const state = roundState(book);
  const shareCount = pickShares;
  const shareOk = shareCount >= 1 && (!canPublish || shareCount <= available);
  const marketRows = [...(book.listings || [])].sort((a, b) => {
    const rank = { open: 0, done: 1, cancelled: 2 };
    return (rank[a.status || "open"] ?? 0) - (rank[b.status || "open"] ?? 0);
  });
  const openCount = marketRows.filter((l) => (l.status || "open") === "open").length;
  const doneCount = marketRows.filter((l) => l.status === "done").length;
  const myListings = marketRows.filter(
    (l) => (l.status || "open") === "open" && String(l.seller).toLowerCase() === String(account).toLowerCase(),
  );
  const locked = Number(book.listingShares) || 0;
  const held = Number(book.mine) || 0;

  return (
    <section className={embedded ? "embedded-block" : undefined}>
      {!embedded && (
        <header className="round-hero">
          <div className="round-hero-row">
            <div className="round-title">
              <span className="round-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                  <path d="M7 8h11.5M15.5 5.5 18.5 8l-3 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M17 16H5.5M8.5 13.5 5.5 16l3 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <h1>{title}</h1>
            </div>
            {Array.isArray(periods) && periods.length > 0 && onSwitchPeriod ? (
              <PeriodNav periods={periods} currentId={round.id} onSwitch={onSwitchPeriod} />
            ) : (
              <span className="round-period">第 {round.id} 期</span>
            )}
          </div>
          <p className="round-hero-lead">
            唯一退出路径：把持有的挖矿份额挂到转让市场，由其他持份人接收。挂出后立即锁定，成交或撤单后释放。
          </p>
          <span className={`transfer-gate ${canTransfer ? "is-open" : "is-closed"}`}>
            {canTransfer ? "转让开放中" : `转让未开放 · 当前${state.label}`}
          </span>
        </header>
      )}
      {embedded && <h2 className="embedded-title">挖矿份额转让</h2>}

      {!embedded && (
        <div className="holding-grid transfer-holdings">
          <article className="stat-card accent">
            <div className="stat-label">可用份额</div>
            <div className="stat-value">{connected ? `${held} 份` : "—"}</div>
            <div className="stat-note">可发布挂单</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">挂单锁定</div>
            <div className="stat-value">{connected ? `${locked} 份` : "—"}</div>
            <div className="stat-note">已挂出 · 不可领取</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">我的挂牌</div>
            <div className="stat-value">{connected ? `${myListings.length} 笔` : "—"}</div>
            <div className="stat-note">开放中待成交</div>
          </article>
        </div>
      )}

      {!canTransfer && (
        <div className="transfer-banner is-closed" role="status">
          <span className="transfer-banner-icon" aria-hidden="true">!</span>
          <div>
            {/*
             * 上方 gate 已经写了「转让未开放 · 当前募集中」，这里不再复述一遍阶段词，
             * 也不重复「此前的募集 / 待执行阶段不支持转让」——那句就是 gate 的结论。
             * 横幅只回答 gate 回答不了的问题：什么时候开、开了之后能做什么。
             */}
            <strong>转入挖矿后才能转让份额</strong>
            <p>份额转让是挖矿阶段的退出通道：晶体管入池、本期进入挖矿后，才可以发布出售挂单或接收他人转让。</p>
          </div>
        </div>
      )}

      {!connected && (
        <div className="empty">
          <p>当前没有连接钱包。</p>
          <button className="btn btn-primary" type="button" onClick={onConnect}>
            连接钱包
          </button>
        </div>
      )}

      {connected && (
        <>
          <div className="layout transfer-desk">
          <article className="card">
            <div className="card-header">
              <span>转让市场</span>
              <span className="stat-label">开放 {openCount} · 完成 {doneCount}</span>
            </div>
            <div className="card-body">
              {marketRows.length === 0 ? (
                <p className="fine">还没有人挂单。你发布出售后，挂单会显示在这里，其他持份人可接收。</p>
              ) : (
                <div className="listing-board">
                  <div className="listing-head">
                    <span>卖方</span>
                    <span>份数</span>
                    <span>单价</span>
                    <span>合计</span>
                    <span>操作</span>
                  </div>
                  <ul>
                    {marketRows.map((l) => (
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
                </div>
              )}
              {myListings.length > 0 && (
                <p className="fine">撤单后锁定份额自动回到可用余额，可重新转让或领取。</p>
              )}
            </div>
          </article>

          <article className="card">
            <div className="card-header">
              <span>发布出售</span>
              <span className="stat-label">当前可用 {available} 份</span>
            </div>
            <div className="card-body">
              <p className="fine">挂单即锁定：这部分份额从可用余额扣出，成交或撤单后释放。成交时买方 BNB 直接付给你（卖方）。</p>
              <div className="form-grid publish-fields">
                <label className="field">
                  <span>出售份数</span>
                  <Stepper
                    value={pickShares}
                    min={1}
                    max={canPublish ? available : 1}
                    disabled={!canPublish}
                    onChange={setPickShares}
                  />
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
                    {round4((shareOk ? shareCount : 0) * Number(price) || 0).toFixed(4)} BNB
                  </strong>
                </li>
                <li className="due">
                  <span>挂单后可用余额</span>
                  <strong>{Math.max(0, available - (canPublish && shareOk ? shareCount : 0))} 份</strong>
                </li>
              </ul>
              <button
                className="btn btn-primary"
                type="button"
                disabled={!canPublish || !shareOk || !(Number(price) > 0) || Boolean(pending)}
                onClick={() => onList({ shares: shareCount, priceBnbPerShare: Number(price) })}
              >
                {pending || "发布出售挂单"}
              </button>
              {canTransfer && !canPublish && (
                <p className="fine">当前没有可用份额可发布挂单（份额为 0 或已全部挂出）。</p>
              )}
            </div>
          </article>

        </div>
        </>
      )}
    </section>
  );
}

function ListingRow({ listing, account, pending, disabled = false, onTake, onCancel }) {
  const [qty, setQty] = useState(1);
  const isMine = String(listing.seller).toLowerCase() === String(account).toLowerCase();
  const status = listing.status || (listing.open === false ? "cancelled" : "open");
  const maxQty = Math.max(1, listing.shares || 1);
  const take = Math.min(Math.max(1, qty), maxQty);
  /**
   * 合约只存剩余份数（成交后减到 0），所以「挂了 1 份并全部成交」这条在链上
   * 只剩 shares=0 —— 直接拿它当份数会显示成「— / 合计 0.0000 BNB」。
   * listedShares 来自 Listed 事件；读不到时退回剩余份数，宁可显示剩余也不编造 0。
   */
  const listed = Number(listing.listedShares) || 0;
  const remaining = Number(listing.shares) || 0;
  const taken = Number(listing.takenShares) || 0;
  const shown = listed > 0 ? listed : remaining;
  // 部分成交：开放中提示还能买多少；已撤单提示撤之前成交了多少
  const note = taken > 0 && listed > 0
    ? (status === "open" ? `剩 ${remaining} 份` : status === "cancelled" ? `成交 ${taken} 份` : "")
    : "";
  return (
    <li className={`listing-row is-${status}`}>
      <span className="listing-seller">
        {shortAddress(listing.seller)}
        {isMine ? <em>我的</em> : null}
      </span>
      <span className="listing-shares">
        <span className="listing-shares-main">{shown > 0 ? `${shown} 份` : "—"}</span>
        {note ? <span className="listing-shares-note">{note}</span> : null}
      </span>
      <span className="listing-price">{listing.priceBnbPerShare.toFixed(4)} BNB / 份</span>
      <span className="listing-sum">{shown > 0 ? `${listing.totalBnb.toFixed(4)} BNB` : "—"}</span>
      <div className="listing-actions">
        {status === "done" && <span className="listing-status is-done">完成</span>}
        {status === "cancelled" && <span className="listing-status is-cancelled">已撤单</span>}
        {status === "open" && isMine && (
          <button className="btn btn-outline btn-inline" type="button" disabled={disabled || Boolean(pending)} onClick={() => onCancel(listing.id)}>
            撤单
          </button>
        )}
        {status === "open" && !isMine && (
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
              接收
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
    readHolders()
      .then((list) => {
        if (!alive) return;
        const me = String(account || "").toLowerCase();
        setRows(
          list.slice(0, 8).map((r) => ({
            address: r.address,
            shares: r.shares,
            self: me && r.address === me,
          }))
        );
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [usingChain, book.sold, account]);

  if (rows == null) return <p className="fine">加载最近认筹…</p>;
  if (!rows.length) return <p className="fine">链上暂无认筹记录。</p>;
  return (
    <div className="recent">
      <p className="fine">认筹地址（合约记录，不扫公共日志）</p>
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

function RulesPage({ campaigns = [] }) {
  const flow = [
    { n: "1", title: SCENE.funding.label, body: "按份认筹，BNB 进托管池" },
    { n: "2", title: SCENE.executing.label, body: "晶体管到账后投入矿池" },
    { n: "3", title: SCENE.mining.label, body: "晶体管入池后不可撤出；退出走挖矿份额转让" },
  ];
  const exits = [
    { title: "被动 · 退款", body: "募集超时未售罄，或执行失败且本金未支出。按认筹价原路退回，份额清零。" },
    { title: "确认到账 · 退余款", body: "晶体管到账后，没花完的募集款按份退回认筹地址（各自领取）。不结束本期：晶体管留在合约，之后照常入池，不会转给 Owner。" },
    { title: "主动 · 挖矿份额转让", body: "仅挖矿中。在「资产转让」页发布出售挂单，份额立即锁定；成交时买方 BNB 直接付给卖方。" },
  ];
  const roles = [
    ["任何人", "查看状态；晶体管入池后（挖矿中）可读取当期进度；挖矿中可接收他人挂单，接收后成为持份人"],
    ["认筹用户", "募集中认筹；超时未售罄或执行失败时原路退款"],
    ["持份用户", "挖矿中发布出售挂单（份额立即锁定）、撤销自己的挂单"],
    ["Factory Owner", "开期、写 setPlan、买晶体管、depositToPool 入池；挖矿中可撤销任意挂单"],
  ];
  const sharedContracts = [
    {
      name: "开期工厂",
      address: deployments.factory,
      verify: true,
      use: "各期共用。开期写入 份额单价 / 总份数 / 募集天数 / 本期晶体管合约（必选，从工厂晶体管白名单里选）。",
    },
    {
      name: "晶体管市场",
      address: deployments.materialMarket || deployments.minter,
      use: "各期共用的官方晶体管市场。晶体管不再铸造。NAND 的 tokenId 为 0，LATCH 为 1。挂单 placeBid，撤单 cancelBid，成交看 bids(id).remaining。",
    },
  ];
  /**
   * 晶体管合约：工厂的**晶体管白名单**（部署时写入、不可增删），每期开期时选其中一个锁定。
   * 主网 = 官方两件套（TapeOut / Behemoth）。
   */
  const partsContracts = (Array.isArray(deployments.allowedParts) ? deployments.allowedParts : [])
    .map((address) => ({
      name: "晶体管合约（ERC1155）",
      address,
      verify: true,
      use: "工厂晶体管白名单内的一项，开期时选中它锁定为本期使用的晶体管合约。NAND 的 tokenId 为 0，LATCH 为 1。晶体管到账后由 depositToPool 转入矿池。",
    }));
  const periodContracts = (Array.isArray(campaigns) ? [...campaigns] : [])
    .filter((item) => item?.address)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((item) => ({
      name: `第 ${item.id} 期`,
      address: item.address,
      verify: true,
    }));
  const fallbackPeriod = !periodContracts.length && deployments.campaign
    ? [{
        name: "当期",
        address: deployments.campaign,
        verify: true,
      }]
    : [];
  const campaignRows = periodContracts.length ? periodContracts : fallbackPeriod;

  function renderContractRows(items) {
    return items.filter((item) => item.address).map((item) => {
      const href = item.href || explorerAddress(item.address);
      return (
        <li key={`${item.name}-${item.address}`}>
          <div className="rules-contract-head">
            <strong>{item.name}</strong>
            {item.verify ? (
              <a className="rules-verify" href={sourcifySource(item.address)} target="_blank" rel="noreferrer">开源验证</a>
            ) : null}
          </div>
          {item.use ? <p>{item.use}</p> : null}
          {href ? (
            <a className="mono rules-contract-addr" href={href} target="_blank" rel="noreferrer">{item.address}</a>
          ) : (
            <code className="mono rules-contract-addr">{item.address}</code>
          )}
        </li>
      );
    });
  }

  return (
    <section className="rules-page">
      <header className="round-hero">
        <div className="round-hero-row">
          <div className="round-title">
            <span className="round-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <path d="M7 5.5h10v13H7z" stroke="currentColor" strokeWidth="1.5" />
                <path d="M9.5 9h5M9.5 12.5h5M9.5 16h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
            <h1>规则与合约</h1>
          </div>
        </div>
        <p className="round-hero-lead">
          认筹款先托管，售罄后才买晶体管。没花完的本金会按份退回；没有挖矿中赎回，退出只有退款和挖矿份额转让。
          晶体管到账后由 Owner 投入矿池，本期进入挖矿（不可逆）。
        </p>
      </header>

      <section className="rules-block" aria-label="生命周期">
        <div className="rules-block-head">
          <h2>一期怎么走</h2>
          <p>只能按份认筹。开期参数写死，直接转账不会记份。</p>
        </div>
        <ol className="rules-flow">
          {flow.map((step) => (
            <li key={step.n} className="rules-flow-step">
              <span className="rules-flow-n">{step.n}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="rules-grid">
        <section className="rules-block">
          <div className="rules-block-head">
            <h2>退出</h2>
            <p>三条路径互不交叉。募集中和待执行不能发布转让挂单；退余款只动钱，不动晶体管。</p>
          </div>
          <div className="rules-exit-list">
            {exits.map((item) => (
              <article key={item.title} className="rules-exit">
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="rules-block">
          <div className="rules-block-head">
            <h2>入池</h2>
            <p>晶体管到账后，由 Owner 写入预估计划并把晶体管投入矿池（不可逆）。</p>
          </div>
          {/*
           * 这里不再重复「挂单 → 到账 → depositToPool」三步：
           * 完整调用顺序在下方「入池条件」里已经是权威的一处，再列一遍只是同一流程换个粒度。
           */}
          <p className="rules-note">
            余款怎么退见「退出 · 确认到账」；完整调用顺序见下方「入池条件」。
          </p>
        </section>
      </div>

      <section className="rules-block">
        <div className="rules-block-head">
          <h2>挖矿</h2>
          <p>本期晶体管入池后进入挖矿。分配合约尚在接入中：harvest / claim 目前是占位实现，暂不产出发放。</p>
        </div>
        <div className="rules-formula">
          <span>入池条件</span>
          <strong>份额售罄 → 买入 NAND / LATCH → 确认到账 → setPlan → returnSurplus（按份退余款）→ setMiningPool → depositToPool</strong>
        </div>
        {/*
         * 这里原本还有一句「晶体管入池后不可撤出；挖矿中的退出只有挖矿份额转让」——
         * 页首 lead 与上方第 3 步已经各说过一次，同一屏第三遍。删掉。
         */}
      </section>

      <div className="rules-contracts-split">
        <section className="rules-block">
          <div className="rules-block-head">
            <h2>共用合约</h2>
            <p>
              {NETWORK.name} 上工厂与晶体管市场各期共用；晶体管合约取工厂的晶体管白名单，开期时选一个锁定。
              晶体管到账后由 Owner 调 depositToPool 投入矿池，本期进入挖矿。
            </p>
          </div>
          <ul className="rules-contracts">{renderContractRows([...sharedContracts, ...partsContracts])}</ul>
        </section>
        <section className="rules-block">
          <div className="rules-block-head">
            <h2>期次合约</h2>
            <p>每一期有独立 Campaign，认筹、托管、买晶体管、入池和退款都走它。</p>
          </div>
          {campaignRows.length ? (
            <ul className="rules-contracts">{renderContractRows(campaignRows)}</ul>
          ) : (
            <p className="rules-note">尚未开期。工厂已部署，期次合约要等发布后才会出现。</p>
          )}
        </section>
      </div>

      <section className="rules-block">
        <div className="rules-block-head">
          <h2>谁能做什么</h2>
        </div>
        <div className="rules-roles">
          {roles.map(([role, text]) => (
            <article key={role}>
              <strong>{role}</strong>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

function Stepper({ value, min, max, disabled, onChange }) {
  return (
    <div className="stepper">
      <button type="button" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label="减少一份">
        −
      </button>
      <output>{String(value)}</output>
      <button type="button" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label="增加一份">
        +
      </button>
    </div>
  );
}

/**
 * 募集倒计时。只在募集中渲染（ProductPage），
 * 挖矿中 / 待执行不再有截止日，旧版那两个分支是死代码（同一个「持续出矿中」
 * 在挖矿页已经有专门的统计卡），这里一并去掉。
 */
function Countdown({ countdown }) {
  return (
    <div className="countdown">
      <span>距离募集截止</span>
      <div>
        {[
          [countdown?.days, "天"],
          [countdown?.hours, "时"],
          [countdown?.minutes, "分"],
          [countdown?.seconds, "秒"],
        ].map(([value, unit]) => (
          <b key={unit}>
            {value}
            <small>{unit}</small>
          </b>
        ))}
      </div>
    </div>
  );
}


function subscribeLabel(book, connected, canSubscribe) {
  if (!canSubscribe) return "已停止认筹";
  if (!connected) return "连接钱包";
  if (!book.approved) return "授权 BNB";
  return "确认认筹";
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
