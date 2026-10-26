import { useEffect, useMemo, useRef, useState } from "react";
import { readCall } from "./Calls.jsx";
import { dealStatus } from "./dealStatus.js";
import { ENDED, FAILED, PHASE, SCENE, outstandingOf, rowState, roundState } from "./roundState.js";
import { OwnerAdvanced, OwnerCreate, OwnerOverview } from "./Owner.jsx";
import FeeClaims from "./FeeClaims.jsx";
import PeriodNav from "./PeriodNav.jsx";
import {
  IS_CONFIGURED as CHAIN_CONFIGURED,
  NETWORK,
  CHAIN_ID,
  explorerAddress,
  sourcifySource,
  POD_MINING_ADDRESS,
  POD_LENS_ADDRESS,
  BEM_ADDRESS,
  CAMPAIGN_DEPLOYER_ADDRESS,
} from "./chain/config.js";
import { processorFromCircuitContract } from "./tapeout.js";
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
  readAllowedCircuits,
} from "./chain/client.js";
import { discoverWallets, isMobile } from "./chain/wallets.js";
import { useOfficialPrices } from "./useOfficialPrices.js";
import deployments from "./chain/deployments.json";
import { MarketTrades } from "./MarketTrades.jsx";
import { MarketPage } from "./MarketPage.jsx";
import { RefundRecords } from "./RefundRecords.jsx";
import { processorScale } from "./prices.js";
import {
  canStartPodRow,
  coolingBlocksLeft,
  findCircuitRow,
  POD_MINING_COOLDOWN_BLOCKS,
} from "./miningFlow.js";
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
  applyConfirmCircuits,
  applyCreate,
  applyBuyCircuits,
  applyListShares,
  applyCancelListing,
  applyTakeListing,
  applyRefund,
  buildHolders,
  createScene,
  estimateHashpower,
  feePercentOf,
  formatClock,
  formatRemaining,
  identify,
  planHashpowerFromHoldings,
  resolveCampaignDesign,
  shortAddress,
  round4,
  formatBemClaimable,
} from "./fixtures.js";

/** 按生命周期收口导航（对照 contracts/README.md §6） */
const LIFE_PAGES = [
  { id: "round", label: "BEM挖矿认筹", hint: "募集 → 待执行 → 挖矿" },
  { id: "assets", label: "我的资产", hint: "认筹 / 持仓 / 领取" },
  { id: "fees", label: "领取服务费", hint: "分成地址自领 BEM" },
  { id: "transfer", label: "资产转让", hint: "挖矿份额转让" },
  { id: "rules", label: "规则与合约", hint: "资金路径 / 退出 / 合约" },
  { id: "owner", label: "合约工作台", hint: "开期 / 开矿 / 调试" },
];
/**
 * 电路市场（不属于生命周期）：里面到底有哪些官方处理器与电路。
 * 单独分组是因为它跟「某一期走完哪一步」无关，是常驻的外部市场视图。
 */
const MARKET_PAGES = [
  { id: "market", label: "电路市场", hint: "官方电路挂单与期次锁定" },
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
  /**
   * 工厂 Owner：只认链上 `factory.owner()`，不用 deployments.deployer 做种子。
   * 否则转移工厂 Owner 后，旧部署者地址仍会被当成 Owner，侧栏「合约工作台」关不掉。
   */
  const [factoryOwner, setFactoryOwner] = useState("");
  /**
   * 工厂电路白名单（部署时写入、之后不可增删）。
   *
   * 这是**安全边界**不是运营开关：主网上防止 owner 把期次指向任意可随意 mint 的
   * 测试 NFT。开期表单的可选处理器必须从这里生成，不能用前端硬编码列表冒充链上事实。
   *
   * ⚠️ 工厂不再有「默认电路」：开期时前端必须**显式选择一个**白名单内的处理器，
   * 不能留空、也不能用工厂默认值代替。
   */
  const [allowedCircuits, setAllowedCircuits] = useState([]);
  function reloadFactoryOwner() {
    if (!CHAIN_CONFIGURED) return Promise.resolve("");
    return readFactoryOwner()
      .then((o) => {
        setFactoryOwner(o || "");
        return o || "";
      })
      .catch(() => {
        setFactoryOwner("");
        return "";
      });
  }
  useEffect(() => {
    if (!CHAIN_CONFIGURED) return undefined;
    reloadFactoryOwner();
    readAllowedCircuits()
      .then((list) => setAllowedCircuits(Array.isArray(list) ? list : []))
      .catch(() => {});
    // 与期次轮询错开：工厂 Owner 变更少，30s 重读一次即可兜住外部多签/另一页转移。
    const t = setInterval(reloadFactoryOwner, 30_000);
    return () => clearInterval(t);
  }, []);

  /**
   * 报价。
   *
   * 三个来源，优先级从高到低：
   *   1. 链上实读：Campaign 记录的 Owner 实际挂单/成交单价（由 adapter 写进 book）
   *   2. 官方市价：链上电路市场的当前最低挂单价（见 useOfficialPrices / officialPrices.js），
   *      没有活跃挂单时退回静态基准
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
  /** 从链上 setPlan 算力 + 电路数反推目标处理器，写入 round 供全页消费 */
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
      circuitModelId: design.processorKnown ? design.circuitModelId : (usingChain ? null : base.circuitModelId),
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
   * 两把钥匙（均须链上读数，禁止 deployments.deployer 种子）：
   *   - 本期 Campaign owner：管买电路 / 开矿 / 熔断 / 转移本期
   *   - 工厂 owner：管开新期 / 转移工厂
   * 只转本期不会改工厂——旧地址若仍是工厂 Owner，以前会继续看到整块「合约工作台」。
   * 现口径：有期次时工作台只认本期 Owner；工厂 Owner 若已不是本期 Owner，
   * 只保留独立的「发布众筹挖矿」（不再占工作台）。
   */
  const isFactoryOwner = Boolean(
    account && factoryOwner && String(account).toLowerCase() === String(factoryOwner).toLowerCase(),
  );
  const isCampaignOwner = Boolean(
    account
    && chain.book?.owner
    && String(account).toLowerCase() === String(chain.book.owner).toLowerCase(),
  );
  /** 本地演示退回 fixtures；链上不用这集合做侧栏。 */
  const isOwnerAddress = !CHAIN_CONFIGURED
    ? Boolean(account) && String(account).toLowerCase() === String(OWNER).toLowerCase()
    : isCampaignOwner || isFactoryOwner;
  /**
   * 合约工作台：本期 Owner；或空工厂 / 读取中的工厂 Owner。
   * 读完后若只剩工厂钥匙 → 收起工作台（见 canPublishAsFactory）。
   */
  const canEnterOwnerDesk = CHAIN_CONFIGURED
    ? (isCampaignOwner || (isFactoryOwner && (chainEmpty || chainBooting)))
    : isOwnerAddress;
  /** 工厂 Owner 已把本期转走：侧栏只留「发布」，不再显示「合约工作台」。 */
  const canPublishAsFactory = CHAIN_CONFIGURED
    && isFactoryOwner
    && !isCampaignOwner
    && !chainEmpty
    && !chainBooting;
  /**
   * 「领取服务费」侧栏：仅分成地址可见。
   * 链上：feeClaims 已过滤「当前钱包在分成表」的期次；未连接或读空则隐藏。
   * 本地演示：对照本期 round.feeShares。
   */
  const canSeeFeeClaims = useMemo(() => {
    if (!account) return false;
    if (chain.active) return (chain.feeClaims || []).length > 0;
    const me = String(account).toLowerCase();
    return (round?.feeShares || []).some(
      (r) => String(r.address || "").toLowerCase() === me,
    );
  }, [account, chain.active, chain.feeClaims, round?.feeShares]);
  /**
   * 当前身份：Owner 走统一地址判定，其余按持份判定。
   *
   * ⚠️ owner 只认「本期 Campaign owner」（book.owner），不认工厂 owner：
   * 老工厂的期次归老工厂 owner 管，当前工厂 owner 对它没有链上权限，
   * 判成 owner 会让 UI 显示可执行/可撤单，实际交易会被合约 revert。
   * 工厂 owner 的身份只用于「合约工作台」这一层入口可见性。
   */
  const actor = useMemo(() => {
    const shares = (book.mine || 0) + (book.listingShares || 0);
    if (!chain.active) {
      const who = identify(account, book);
      // 本地演示同样只有一把钥匙。
      return { ...who, canOperate: who.role === "owner" };
    }
    // ⚠️ 链上空态时 book 是本地 fixtures（simBook），owner 字段不可信，
    // 必须只认链上读到的 chain.book.owner。
    const campaignOwner = chain.book?.owner;
    const isCampaignOwner = Boolean(
      account
      && campaignOwner
      && String(account).toLowerCase() === String(campaignOwner).toLowerCase(),
    );
    if (isCampaignOwner) return { role: "owner", label: "Owner", shares, address: account, canOperate: true };
    return shares > 0
      ? { role: "holder", label: "持份用户", shares, address: account, canOperate: false }
      : { role: "user", label: "未持份地址", shares: 0, address: account, canOperate: false };
  }, [account, book, chain.active, chain.book]);
  // 份额明细 / 历史：进入合约工作台即拉链上数据
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
      "buyCircuits", "confirmCircuits", "listCircuit", "cancelCircuitListing", "setPhase",
      "withdrawMarketProceeds", "setPlan", "startMining", "stopMining",
      "claimMiningRewards", "claimBem", "returnSurplus", "topUpShortfall",
      "simulateBuyListing", "simulateExternalListing",
      "createCampaign", "openRefund", "abandonOrder", "markFailed", "removeCampaign", "removeCampaignAt",
      "setCircuitMarket", "recoverBnb", "transferOwnership",
      "setFactoryOwner", "claimFee", "setServiceFee",
      // 熔断：拉闸 / 抬闸都只认 Owner
      "halt", "resume",
    ];
    // 旧版的 harvest / claim 占位实现已删除：奖励改由官方 PoD 合约产出，
    // 先 claimMiningRewards 把 BEM 收到本期合约，持有人再 claimBem 领取。
    if (method === "claim" || method === "harvest") {
      return { ok: false, message: "harvest / claim 已移除：请用「领取挖矿奖励」再「领取 BEM」。" };
    }
    if (chain.active && WRITE_METHODS.includes(method)) return chainInvoke(method, args);
    if (["scene", "phase", "sold", "sharePriceBnb", "totalShares", "estHashpower", "totalRefunded", "raisedBnb", "circuits", "circuitMarket", "circuitHeldCount", "circuitCount", "executionFailed", "soldOutAt", "priceLock", "holderCount", "sharesOf", "halted"].includes(method)) {
      return { ok: true, message: readCall(method, args, round, book, quote) };
    }
    if (/^market(OpenOrders|Listing|Sellable|Owed)$/.test(method) || method === "simulateExternalListing" || method === "simulateBuyListing") {
      return { ok: false, message: "电路市场调试只在链上模式可用：先连接测试网钱包。" };
    }

    let result;
    if (method === "subscribe") result = applySubscribe(round, book, args.shares);
    else if (method === "listShares") result = applyListShares(round, book, args, actor);
    else if (method === "cancelListing") result = applyCancelListing(round, book, args.listingId, actor);
    else if (method === "takeListing") result = applyTakeListing(round, book, args.listingId, args.shares, actor);
    else if (method === "claimBem") result = { ok: true, message: "模拟：已领取你按份额应得的 BEM（链上走 claimBem）" };
    else if (method === "startMining") {
      const minable = book.scene === "mining"
        || (book.scene === "executing" && book.executePhase === "ready");
      const cool = Number(book.miningCooldownBlocks || POD_MINING_COOLDOWN_BLOCKS);
      const bn = Number(book.blockNumber || 0);
      const startable = (Array.isArray(book.sellBids) ? book.sellBids : [])
        .filter((b) => canStartPodRow({
          listed: false,
          miningStatus: b.miningStatus,
          miningStopBlock: b.miningStopBlock,
        }, bn, cool));
      const stillCooling = (Array.isArray(book.sellBids) ? book.sellBids : [])
        .some((b) => Number(b.miningStatus) === 3 && coolingBlocksLeft(b, bn, cool) > 0);
      result = !minable || Number(book.circuitHeldCount) <= 0
        ? { ok: false, message: "电路还没确认到账（或已没有电路），不能开矿" }
        : startable.length === 0
          ? {
              ok: false,
              message: stillCooling
                ? "冷却未满（官方 stopBlock+1200），满后再开矿"
                : "没有可开矿的电路",
            }
          : {
              ok: true,
              message: "模拟：已调用官方挖矿合约开矿，产出按份额记账",
              book: {
                ...book,
                scene: "mining",
                miningActiveCount: Number(book.miningActiveCount || 0) + startable.length,
                miningCoolingCount: Math.max(0, Number(book.miningCoolingCount || 0) - startable.filter((b) => Number(b.miningStatus) === 3).length),
              },
            };
    }
    else if (method === "stopMining") {
      // 与链上一致：不硬挡「先领再停」，stop 会结算产出。
      result = Number(book.miningActiveCount) > 0
        ? {
            ok: true,
            message: "模拟：已停止该电路的挖矿，进入冷却（约 1200 块后可再开）",
            book: {
              ...book,
              miningActiveCount: Math.max(0, Number(book.miningActiveCount) - 1),
              miningCoolingCount: Number(book.miningCoolingCount || 0) + 1,
            },
          }
        : { ok: false, message: "当前没有挖矿中的电路" };
    }
    else if (method === "claimMiningRewards") {
      result = Number(book.miningActiveCount) > 0
        ? {
            ok: true,
            message: "模拟：已领取官方挖矿奖励，BEM 已按份额记账；可再停挖",
            book: { ...book, miningPendingBem: 0n },
          }
        : { ok: false, message: "当前没有挖矿中的电路，没有可领产出（NoRewards）" };
    }
    else if (method === "setPlan") result = { ok: true, message: "模拟：预估算力与电路数已写入" };
    else if (method === "buyCircuits") result = applyBuyCircuits(round, book, actor, {
      qty: args?.qty, maxPriceBnb: args?.maxPriceBnb,
    });
    else if (method === "listCircuit") result = { ok: true, message: "模拟：电路已挂回市场（链上走 listCircuit）" };
    else if (method === "cancelCircuitListing") result = { ok: true, message: "模拟：已撤销电路挂单" };
    else if (method === "returnSurplus") {
      // 模拟模式：把钱从募集池挪到「待领余款」，期次、份额、电路都不动 —— 与链上 returnSurplus 同口径。
      result = book.executePhase === "ready" && Number(book.bnbPool) > 0
        ? {
            ok: true,
            message: `模拟：${round4(book.bnbPool)} BNB 余款已按份记账，持份人各自领取；本期继续，仍可开矿`,
            book: {
              ...book,
              surplusOutstanding: Number(book.surplusOutstanding || 0) + Number(book.bnbPool || 0),
              surplusBase: book.outstandingShares ?? book.sold,
              bnbPool: 0,
            },
          }
        : { ok: false, message: "只有电路确认到账、且募集池还有余款时才能退" };
    }
    else if (method === "openRefund" || method === "abandonOrder") result = applyOpenRefund(round, book, actor);
    else if (method === "topUpShortfall") {
      result = { ok: true, message: "模拟：已补齐被电路吃掉的本金缺口，现在可以按原价退完持份人" };
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
    else if (method === "halt") {
      result = book.halted
        ? { ok: false, message: "本期已处于熔断状态" }
        : { ok: true, message: "模拟：已熔断。认筹、挂单、卖出、开矿与份额交易暂停；退款与撤单不受影响。", book: { ...book, halted: true } };
    }
    else if (method === "resume") {
      result = book.halted
        ? { ok: true, message: "模拟：已解除熔断，入口恢复", book: { ...book, halted: false } }
        : { ok: false, message: "本期未熔断，无需解除" };
    }
    else if (method === "confirmCircuits") result = applyConfirmCircuits(round, book, actor);
    else if (method === "refund") result = applyRefund(round, book, actor);
    else if (method === "createCampaign") result = applyCreate(round, args, quote);
    else if (method === "recoverBnb") result = { ok: true, message: "模拟：可动 BNB 已一次性转给 Owner（不用填数量）" };
    else if (method === "claimFee") {
      result = { ok: true, message: "模拟：已领取你的挖矿产出服务费（链上走 claimFee）" };
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
    buyCircuits: "买入电路",
    confirmCircuits: "确认到账",
    listCircuit: "挂回电路市场",
    cancelCircuitListing: "撤销电路挂单",
    setPhase: "改子状态",
    withdrawMarketProceeds: "提取卖出款",
    simulateBuyListing: "模拟外部买家吃单",
    simulateExternalListing: "模拟外部卖家挂单",
    setPlan: "写入计划",
    startMining: "开启挖矿",
    stopMining: "停止挖矿",
    claimMiningRewards: "领取挖矿奖励",
    claimBem: "领取 BEM",
    createCampaign: "发布期次",
    openRefund: "退款",
    abandonOrder: "撤单退款",
    topUpShortfall: "补齐本金缺口",
    markFailed: "判执行失败",
    removeCampaign: "移除期次",
    removeCampaignAt: "移除期次",
    setCircuitMarket: "更换电路市场",
    recoverBnb: "取回 BNB",
    transferOwnership: "转移所有权",
    setFactoryOwner: "转移工厂所有权",
    halt: "熔断（halt）",
    resume: "解除熔断（resume）",
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
      method === "removeCampaign" || method === "claimFee"
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
        /**
         * 与合约硬闸门对齐的前置校验：状态不合就别发一笔注定 revert 的交易。
         * 只做「合约一定会拒绝」的判断，不替合约决定业务策略。
         */
        if (book?._chain) {
          const outstanding = Number(book.outstandingShares ?? book.sold ?? 0);
          const pool = Number(book.bnbPool || 0);
          const need = outstanding * Number(round.sharePriceBnb || 0);
          const partsHeld = Number(book.circuitHeldCount || 0) > 0;
          if (method === "openRefund" || method === "abandonOrder") {
            if (Number(book.surplusBase) > 0) {
              throw new Error("余款已按份退回（SurplusAlreadyReturned）：本金已在持份人手里，不能再打开退款。");
            }
            if (book.executePhase === "ready") {
              throw new Error("电路已到账（UseReturnSurplus）：出口是退余款 + 开矿，不能放弃挂单。");
            }
            if (partsHeld && pool + 1e-12 < need) {
              throw new Error("电路还在合约里、池子不够按原价退完（CircuitsAreCollateral）：先 topUpShortfall 补齐缺口。");
            }
            if (method === "openRefund" && Number(book.marketOwed) > 0) {
              throw new Error("市场还有未提取的卖出款（ProceedsPending）：先 withdrawMarketProceeds 再打开退款。");
            }
            if (method === "openRefund" && outstanding <= 0) {
              throw new Error("份额已全部退完，没有可退对象（ZeroShares）：尾差用 recoverBnb 取回。");
            }
          }
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
        if (method === "buyCircuits") {
          /**
           * 两种买入口径：
           *   - picks：Owner 面板勾选的挂单（精确吃单，价格在 client 里链上重读）；
           *   - qty + maxPriceBnb：按最低价自动挑单（合约操作页 / 高级用法）。
           */
          const picks = Array.isArray(args?.picks) ? args.picks : [];
          if (picks.length > 0) {
            await send(chainTx.buyCircuitsListings(signer, picks), onSigned);
          } else {
            const qty = Math.floor(Number(args?.qty) || 0);
            if (qty <= 0) throw new Error("买入张数要大于 0");
            const maxPriceText = String(args?.maxPriceBnb ?? "0").trim() || "0";
            const maxPriceWei = parseEther(maxPriceText);
            if (maxPriceWei < 0n) throw new Error("最高单价不能为负");
            await send(chainTx.buyCircuitsFromMarket(signer, qty, maxPriceWei), onSigned);
          }
        } else if (method === "listCircuit") {
          const tokenId = BigInt(Math.floor(Number(args?.tokenId ?? -1)));
          if (tokenId < 0n) throw new Error("请选择要挂回市场的电路");
          const price = parseEther(String(args?.priceBnb ?? "").trim());
          if (price <= 0n) throw new Error("挂单价必须大于 0");
          await send(chainTx.listCircuit(signer, tokenId, price), onSigned);
        } else if (method === "cancelCircuitListing") {
          const tokenId = BigInt(Math.floor(Number(args?.tokenId ?? -1)));
          if (tokenId < 0n) throw new Error("请选择要撤单的电路");
          await send(chainTx.cancelCircuitListing(signer, tokenId), onSigned);
        } else if (method === "confirmCircuits") {
          if (book._chain && !(Number(book.circuitHeldCount) > 0)) {
            throw new Error("本期合约还没持有电路，不能确认到账（CircuitsNotReady）。");
          }
          await send(chainTx.confirmCircuits(signer), onSigned);
        } else if (method === "openRefund") {
          await send(chainTx.openRefund(signer), onSigned);
        } else if (method === "startMining" && !args?.tokenId) {
          /**
           * 「开启全部挖矿」：官方 start 一次只收一张电路，所以要逐张发交易。
           * 只开冷却已满 / 未开过的；冷却中（status=3 且未满 stopBlock+1200）跳过。
           * 每张都等上一张入块再发（avoid nonce 冲突，也让失败停在半路时账本清楚）。
           */
          const minable = book.scene === "mining"
            || (book.scene === "executing" && book.executePhase === "ready");
          if (!minable) throw new Error("电路还没确认到账，不能开矿（WrongScene）");
          const cool = Number(book.miningCooldownBlocks || POD_MINING_COOLDOWN_BLOCKS);
          const bn = Number(book.blockNumber || 0);
          const startable = (Array.isArray(book.sellBids) ? book.sellBids : [])
            .filter((b) => canStartPodRow({
              listed: false,
              miningStatus: b.miningStatus,
              miningStopBlock: b.miningStopBlock,
            }, bn, cool));
          const coolingLeft = (Array.isArray(book.sellBids) ? book.sellBids : [])
            .filter((b) => Number(b.miningStatus) === 3 && coolingBlocksLeft(b, bn, cool) > 0)
            .length;
          if (startable.length === 0) {
            throw new Error(
              coolingLeft > 0
                ? `冷却未满（${coolingLeft} 张，官方 stopBlock+1200），满后再开矿`
                : "没有可开矿的电路（都已在挖矿中或已撤销）",
            );
          }
          if (Number(book.listedCircuits?.length || 0) > 0) {
            throw new Error("还有电路挂在市场，先撤单才能开矿（CircuitStillListed）");
          }
          const targets = startable.map((b) => BigInt(b.circuitTokenId ?? b.id));
          let done = 0;
          let failed = null;
          for (const id of targets) {
            try {
              await send(chainTx.startMining(signer, id), onSigned);
              done += 1;
            } catch (e) {
              failed = e;
              break;
            }
          }
          setNotice(
            failed
              ? `已开矿 ${done}/${targets.length} 张，第 ${done + 1} 张失败：${failed.message}`
              : `已用官方挖矿合约开启 ${done} 张电路的挖矿。`,
          );
          await chain.refresh();
          return;
        } else if (method === "abandonOrder") {
          await send(chainTx.abandonOrder(signer), onSigned);
        } else {
          const promise = buildChainTx(method, args, signer);
          await send(promise, onSigned);
        }
        setNotice(method === "openRefund"
          ? "退款已打开：本期判为执行失败，持份人各自「原路退款」领回本金。"
          : method === "returnSurplus"
            ? "剩余募集款已按份记账，持份人各自领取。本期继续，仍可开矿。"
          : method === "claimSurplus"
            ? "已领取你应得的余款（提前退回或开矿记账），BNB 已到账。"
          : method === "claimBem"
            ? "已领取你的 BEM（挖矿产出按份额记账）。"
          : method === "claimMiningRewards"
            ? "已领取官方挖矿奖励：BEM 已收到本期合约，持份人各自 claimBem 领取。"
          : method === "stopMining"
            ? "已停挖：产出已结算；冷却约 1200 块后可再开矿。"
          : method === "recoverBnb"
            ? "已把本期可动 BNB 转给 Owner。"
          : method === "abandonOrder"
            ? "已撤未成交买单并打开退款：持份人各自领回本金，退完后剩余电路退回 Owner。"
          : method === "buyCircuits"
            ? "本批已买入：采购款已扣。Buying 内还可继续吃单；买够后再确认到账（确认后不能再买）。"
          : method === "confirmCircuits"
            ? "已确认到账，进入 Ready：不能再买入；可开矿或挂卖。"
            : method === "listCircuit"
              ? "已把电路挂回市场；成交后卖出款进入市场欠款，需提取。"
              : method === "cancelCircuitListing"
                ? "已撤销电路挂单，NFT 仍在本期合约。"
              : method === "withdrawMarketProceeds"
                ? "卖出款已转入本期募集余额。"
                : method === "markFailed"
                  ? "已标记执行失败：所有持有人现在可以按池子原路退款。"
                  : method === "simulateBuyListing"
                    ? "已模拟外部买家吃单：电路已转给买家，卖出款记入市场欠款。"
                    : method === "simulateExternalListing"
                      ? "已模拟外部卖家挂单：Mock 电路已 mint 并挂到市场，本期可以买入。"
                    : method === "halt"
                      ? "已熔断：认筹、挂单、卖出、开矿与份额交易暂停；退款与撤单仍可用。抬闸同样由 Owner 执行。"
                    : method === "resume"
                      ? "已解除熔断，相关入口恢复。"
                      : method === "claimFee"
                        ? "已领取挖矿产出服务费（BEM）。"
                        : `已确认：${method} ✓`);
        await chain.refresh();
        // 所有权转移后立刻重读：否则侧栏仍按旧地址放行「合约工作台」。
        if (method === "setFactoryOwner" || method === "transferOwnership") {
          await reloadFactoryOwner();
        }
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
        if (method === "claimFee" || method === "setServiceFee" || method === "createCampaign") {
          await chain.refreshFeeClaims?.();
        }
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
     * 开期参数：份额单价 / 总份数 / 募集天数 / **电路合约（处理器）**。
     *
     * ⚠️ 电路合约（第 4 参）是**必选**：开期人必须从白名单里显式选一个处理器，
     * 零地址一律 revert（工厂不再有默认电路）。这是 T-79 的核心改动：
     * 之前所有期次被工厂默认值锁死到同一处理器，现在单工厂可承载多处理器
     * （主网 TapeOut / Behemoth 各自的电路合约），由开期时显式选择。
     *
     * 电路**数量**同样不是开期参数：它在 Owner 用 buyCircuits 从电路市场买入时确定。
     */
    const partsArg = String(draft.circuits || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(partsArg) || /^0x0{40}$/i.test(partsArg)) {
      throw new Error("请先选择本期电路合约，不能留空。");
    }
    const { campaign: created, hash } = await createCampaignOnChain(
      activeSigner,
      { sharePriceBnb: shareNum, totalShares, fundingDays, circuits: partsArg },
      onSigned
    );

    /**
     * 只同步记下新地址，不要在写服务费之前 await 整页状态刷新。
     *
     * 曾经这里先 `await chain.setCampaignAddress(created)`（内部会跑完整 readState），
     * 公共 RPC 一慢就卡住十几秒，第二笔 setServiceFee 的钱包弹窗来得太晚——
     * 用户以为开期已结束关掉弹窗 / 拒签，notice 就变成「服务费写入失败」。
     * 链上证据：本期 create 与 setServiceFee 曾相差约 286 个块（后补设成功）。
     */
    const campaignAddr = String(created);
    setCampaignAddress(campaignAddr);

    /**
     * 服务费与分成表：**第二笔交易**，立刻写进刚建好的 Campaign（setServiceFee）。
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
        walletAsk("setServiceFee");
        await send(
          chainTx.setServiceFee(
            activeSigner,
            BigInt(feePercent * 100),
            rows.map((r) => r.address),
            rows.map((r) => r.bps),
            campaignAddr,
          ),
          () => walletSigned("setServiceFee"),
        );
        feeNote = `挖矿产出服务费 ${feePercent}% 已写入链上`;
      }
    } catch (e) {
      feeNote = `服务费写入失败（期次已建好，可稍后补设）：${e.shortMessage || e.message || e}`;
    }

    // 服务费写完（或明确失败）后再切到新期并拉列表，避免挡住第二笔签名。
    await chain.setCampaignAddress(campaignAddr);
    await chain.refreshHistory?.();
    setOwnerTab("overview");
    setPage("owner");
    setNotice(`已发布：${shortAddress(campaignAddr)} · tx ${shortAddress(hash)} · ${feeNote}`);
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
        if (!book.serviceFeeSet && !round.serviceFeeSet) {
          throw new Error("Owner 尚未设定服务费（ServiceFeeNotSet）：认筹暂未开放。");
        }
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
        return chainTx.setServiceFee(signer, bps, recipients, sharesBps, args?.campaign);
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
      case "buyCircuits": {
        const picks = Array.isArray(args?.picks) ? args.picks : [];
        if (picks.length > 0) return chainTx.buyCircuitsListings(signer, picks);
        const qty = Math.floor(Number(args?.qty) || 0);
        if (qty <= 0) throw new Error("买入张数要大于 0");
        return chainTx.buyCircuitsFromMarket(signer, qty, parseEther(String(args?.maxPriceBnb ?? "0")));
      }
      case "listCircuit": {
        const tokenId = uintField(args?.tokenId, "电路 tokenId");
        const price = parseEther(String(args?.priceBnb ?? "").trim());
        if (price <= 0n) throw new Error("挂单价必须大于 0");
        if (book._chain) {
          // Ready 或 Mining 均可挂；PoD 仍挖中（status=1）会 AlreadyMining。
          const inMining = book.scene === "mining";
          const ready = book.scene === "executing" && book.executePhase === "ready";
          if (!inMining && !ready) {
            throw new Error("只有确认到账后或挖矿场景才能挂卖。");
          }
        }
        return chainTx.listCircuit(signer, tokenId, price);
      }
      case "cancelCircuitListing":
        return chainTx.cancelCircuitListing(signer, uintField(args?.tokenId, "电路 tokenId"));
      case "markFailed": return chainTx.markFailed(signer, args?.campaign);
      case "withdrawMarketProceeds": return chainTx.withdrawMarketProceeds(signer);
      case "simulateBuyListing":
        return chainTx.simulateBuyListing(signer, args?.id);
      case "simulateExternalListing": {
        const price = parseEther(String(args?.price ?? "0").trim());
        if (price <= 0n) throw new Error("单价必须大于 0");
        return chainTx.simulateExternalListing(signer, args?.tokenId, args?.price);
      }
      case "confirmCircuits":
        if (book._chain) {
          if (book.scene === "mining" || Number(book.scene) === 2) {
            throw new Error("已在挖矿场景，无需再确认到账。冷却结束后可再开矿，或直接挂卖。");
          }
          if (book.executePhase === "ready") {
            throw new Error("电路已确认到账，可开矿或挂卖，不必再点确认。");
          }
          if (!(Number(book.circuitHeldCount) > 0)) {
            throw new Error("本期合约还没持有电路（CircuitsNotReady），不能确认到账。");
          }
        }
        return chainTx.confirmCircuits(signer);
      case "setPlan": {
        /**
         * 算力只认所持电路：H = 张数 × P。
         * 主网已部署 Campaign：Ready / Mining 会 WrongScene，必须在 Buying 写入。
         */
        if (book._chain) {
          if (book.scene === "mining" || Number(book.scene) === 2) {
            throw new Error("挖矿中不能改 setPlan。");
          }
          if (book.executePhase && book.executePhase !== "buying") {
            throw new Error("已确认到账后不能再改 setPlan。请在点「确认到账」之前写入预估算力。");
          }
        }
        const plan = planHashpowerFromHoldings(round, book);
        if (!plan.ok) throw new Error(plan.reason);
        const raw = args?.hashpower;
        if (raw != null && String(raw).trim() !== "") {
          const override = Number(raw);
          if (!Number.isInteger(override) || override <= 0) {
            throw new Error(`预估算力必须是正整数：${raw}`);
          }
          if (override !== plan.hashpower) {
            throw new Error(
              `setPlan 必须等于持有电路算力 ${plan.hashpower} H（${plan.reason}），不能写 ${override}`,
            );
          }
        }
        return chainTx.setPlan(signer, BigInt(plan.hashpower));
      }
      case "startMining": {
        /**
         * 开矿（单张）。批量开通走 chainInvoke 的 startMining 分支：
         * 每张电路是一笔独立交易（官方 start 一次只收一张），不能塞进一笔。
         * 门槛：Ready/Mining、无挂单、冷却已满（stopBlock+1200）。未验证池。
         */
        const tokenId = uintField(args?.tokenId, "电路 tokenId");
        if (book._chain) {
          // book.scene 是字符串 funding/executing/mining；首张开矿后 scene=mining，phase 仍为 Ready。
          const minable = book.scene === "mining"
            || (book.scene === "executing" && book.executePhase === "ready");
          if (!minable) {
            throw new Error("电路还没确认到账，不能开矿（WrongScene）");
          }
          if (Number(book.listedCircuits?.length || 0) > 0) {
            throw new Error("还有电路挂在市场，先撤单才能开矿（CircuitStillListed）");
          }
          if (!(Number(book.circuitHeldCount) > 0)) throw new Error("合约手上没有电路（NotACircuitOwner）");
          const cool = Number(book.miningCooldownBlocks || POD_MINING_COOLDOWN_BLOCKS);
          const bn = Number(book.blockNumber || 0);
          const row = findCircuitRow(book, tokenId);
          if (row && Number(row.miningStatus) === 3) {
            const left = coolingBlocksLeft(row, bn, cool);
            if (left > 0) {
              throw new Error(`冷却未满（剩 ${left} 块，官方 stopBlock+1200），满后再开矿`);
            }
          } else if (row && Number(row.miningStatus) === 2) {
            throw new Error("该电路挖矿已撤销，不能再开");
          }
          // status==1：合约会同步进 Mining 后 return；放行以便 Ready+已挖 对齐场景。
        }
        return chainTx.startMining(signer, tokenId);
      }
      case "stopMining": {
        const tokenId = uintField(args?.tokenId, "电路 tokenId");
        if (book._chain) {
          // 不硬挡「先领再停」：stop 会结算产出。Mining 直接停；
          // Ready + PoD active：先 _beginMining（不能带挂单）。
          const inMining = book.scene === "mining";
          const ready = book.scene === "executing" && book.executePhase === "ready";
          if (!inMining && !ready) {
            throw new Error("停挖需要本期已确认到账或已在挖矿场景（WrongScene）");
          }
          if (!inMining && Number(book.listedCircuits?.length || 0) > 0) {
            throw new Error("还有电路挂在市场，先撤单再停挖（CircuitStillListed）");
          }
        }
        return chainTx.stopMining(signer, tokenId);
      }
      case "claimMiningRewards": {
        // 资产页可对任意期次地址领奖；仅当目标=当前 book 时做前端闸门（合约仍是最终校验）。
        if (book._chain) {
          const target = String(args?.campaign || "").toLowerCase();
          const current = String(book.address || round.contract || "").toLowerCase();
          if (!target || target === current) {
            const inMining = book.scene === "mining";
            const ready = book.scene === "executing" && book.executePhase === "ready";
            const hasActive = Number(book.miningActiveCount || 0) > 0;
            const hasPod = Number(book.miningPendingBem || 0) > 0;
            if (!inMining) {
              if (Number(book.listedCircuits?.length || 0) > 0) {
                throw new Error("还有电路挂在市场，先撤单再领奖（CircuitStillListed）");
              }
              if (!(ready && (hasActive || hasPod))) {
                throw new Error("领奖需有挖矿中的电路：空闲的先开矿；已挖的在 Ready 也可直接领（会同步进 Mining）");
              }
            } else if (!hasActive && !hasPod) {
              throw new Error("没有挖矿中的电路，没有可领产出（NoRewards）");
            }
          }
        }
        return chainTx.claimMiningRewards(signer, args?.campaign);
      }
      case "claimBem": return chainTx.claimBem(signer, args?.campaign);
      case "returnSurplus":
        // 无参：把当前 raisedBnb 按份记账退回持份人，期次继续、仍然可以开矿。
        return chainTx.returnSurplus(signer);
      case "topUpShortfall": {
        // 自掏腰包补齐被电路吃掉的本金差额（payable，单位 BNB）。
        const raw = String(args?.value ?? "0").trim();
        const amount = raw ? parseEther(raw) : 0n;
        if (amount <= 0n) throw new Error("补齐金额必须大于 0");
        return chainTx.topUpShortfall(signer, amount);
      }
      case "setCircuitMarket": {
        const market = String(args?.circuitMarket || "").trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(market) || /^0x0{40}$/i.test(market)) {
          throw new Error("电路市场地址无效（不能是零地址）");
        }
        // 还有电路挂在旧市场：合约以 AlreadyListed 拒绝换市场。
        if (book._chain && Number(book.listedCircuits?.length || 0) > 0) {
          throw new Error("还有电路挂在市场，不能更换电路市场（AlreadyListed）：先撤单。");
        }
        return chainTx.setCircuitMarket(signer, market);
      }
      case "setPhase": {
        const next = Number(args?.next);
        // Campaign.Phase：1 Buying / 2 Ready。0 None 会关掉挂单与退款，合约直接拒绝。
        if (!Number.isInteger(next) || next < 1 || next > 2) throw new Error("子状态只能是 1（Buying）或 2（Ready）");
        if (book._chain) {
          // Ready 需要本期真的持有电路；余款已记账后只能回到 Ready。
          if (next === 2 && !(Number(book.circuitHeldCount) > 0)) {
            throw new Error("改成「已到账」需要本期合约持有电路（CircuitsNotReady）。");
          }
          if (Number(book.surplusBase || 0) > 0 && next !== 2) {
            throw new Error("余款已按份退回，只有改回「已到账」能继续（WrongScene）。");
          }
        }
        return chainTx.setPhase(signer, next);
      }
      case "recoverBnb": {
        // 无参：合约一次扫走所有可动 BNB（多余余额，或已无人可退时的整池剩余）。
        return chainTx.recoverBnb(signer, args?.campaign);
      }
      case "transferOwnership": return chainTx.transferOwnership(signer, args.newOwner);
      case "setFactoryOwner": return chainTx.setFactoryOwner(signer, args.newOwner);
      case "halt": return chainTx.halt(signer);
      case "resume": return chainTx.resume(signer);
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
    // 熔断只停「资金流入」这一侧：认筹被合约 whenLive 挡住，先给出口径再发交易。
    if (book.halted) {
      setNotice("本期已熔断，认筹暂停。等 Owner 抬闸后再认购；退款与领余款不受影响。");
      return;
    }
    if (!book.serviceFeeSet && !round.serviceFeeSet) {
      setNotice("Owner 尚未设定服务费，认筹暂未开放（链上 ServiceFeeNotSet）。等设费完成后再认购。");
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
        setNotice("请先连 Owner 钱包再发布");
        handleConnect();
        return;
      }
      if (
        factoryOwner &&
        chain.account &&
        String(chain.account).toLowerCase() !== String(factoryOwner).toLowerCase()
      ) {
        setNotice(`发布须 Owner 签名：${shortAddress(factoryOwner)}（当前 ${shortAddress(chain.account)}）`);
        return;
      }
      invokeCall("createCampaign", { ...draft, _review: review });
      return;
    }
    // 发布众筹挖矿不再有模拟路径：开期必须写进真实工厂（电路市场 + ERC721 白名单）。
    setNotice("发布众筹挖矿需要链上工厂：请先部署工厂并连接 Owner 钱包（不使用模拟数据）。");
  }

  // 转移本期 Owner 后：旧地址若只剩工厂钥匙，退出工作台（可去独立「发布」）。
  useEffect(() => {
    if (page !== "owner" || !CHAIN_CONFIGURED || !account) return;
    if (canEnterOwnerDesk) return;
    if (canPublishAsFactory && ownerTab === "create") return;
    if (canPublishAsFactory) {
      setOwnerTab("create");
      setNotice("本期 Owner 已转出；你仍是工厂 Owner，仅可发布新期或在发布页转移工厂");
      return;
    }
    setPage("round");
    setNotice("当前钱包已不是本期 Owner，已退出合约工作台");
  }, [page, account, canEnterOwnerDesk, canPublishAsFactory, ownerTab]);

  // 分成地址切走后：藏入口并退出领取页。
  useEffect(() => {
    if (page === "fees" && account && !canSeeFeeClaims) {
      setPage("round");
    }
  }, [page, account, canSeeFeeClaims]);

  function openPage(id, ownerSub) {
    // 合约工作台：本期 Owner，或空工厂的工厂 Owner。
    if (id === "owner") {
      const tab = ownerSub || "overview";
      if (canPublishAsFactory && tab === "create") {
        setPage("owner");
        setOwnerTab("create");
        setMenuOpen(false);
        return;
      }
      if (!canEnterOwnerDesk) {
        setNotice(
          canPublishAsFactory
            ? "本期 Owner 已转出：侧栏工作台已关闭。发布新期请点「发布众筹挖矿」，或在该页转移工厂 Owner。"
            : "合约工作台仅本期 Owner 可见",
        );
        return;
      }
      setPage("owner");
      setOwnerTab(tab);
      setMenuOpen(false);
      return;
    }
    if (id === "fees" && !canSeeFeeClaims) {
      setNotice("领取服务费仅分成地址可见");
      return;
    }
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
          <div className="menu-group-title">生命周期</div>
          {LIFE_PAGES.map((item) => {
            // 合约工作台：本期 Owner（或空工厂的工厂 Owner）。
            if (item.id === "owner" && !canEnterOwnerDesk) return null;
            // 领取服务费只对分成地址展示。
            if (item.id === "fees" && !canSeeFeeClaims) return null;
            if (item.id === "owner") {
              const onOwner = page === "owner";
              const onOverview = onOwner && ownerTab === "overview";
              const onCreate = onOwner && ownerTab === "create";
              const onAdvanced = onOwner && ownerTab === "advanced";
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
                    {isFactoryOwner && (
                      <button
                        className={onCreate ? "nav-sub active" : "nav-sub"}
                        onClick={() => openPage("owner", "create")}
                        type="button"
                      >
                        发布众筹挖矿
                      </button>
                    )}
                    {isCampaignOwner && (
                      <button
                        className={onAdvanced ? "nav-sub active" : "nav-sub"}
                        onClick={() => openPage("owner", "advanced")}
                        type="button"
                      >
                        高级配置
                      </button>
                    )}
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
          {/*
           * 电路市场只有一条，不再单独起分组标题：
           * 标题与导航项同名，会让侧栏连续出现两个「电路市场」，
           * 看着像两个入口（上面的还因为紧贴工作台卡片被读成子项）。
           */}
          {MARKET_PAGES.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "nav-link nav-standalone active" : "nav-link nav-standalone"}
              onClick={() => openPage(item.id)}
              type="button"
              title={item.hint}
            >
              <span className="nav-link-main">{item.label}</span>
              <span className="nav-link-hint">{item.hint}</span>
            </button>
          ))}
          {/* 工厂 Owner 已转出本期：不再占「合约工作台」，只留发布入口。 */}
          {canPublishAsFactory && (
            <button
              className={page === "owner" && ownerTab === "create" ? "nav-link nav-standalone active" : "nav-link nav-standalone"}
              onClick={() => openPage("owner", "create")}
              type="button"
              title="你仍是工厂 Owner，可开新期；彻底交出权限请在页内转移工厂 Owner"
            >
              <span className="nav-link-main">发布众筹挖矿</span>
              <span className="nav-link-hint">工厂钥匙 · 不含本期操作</span>
            </button>
          )}
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
                        <span className="topbar-role">{isCampaignOwner ? "本期 Owner" : isFactoryOwner ? "工厂 Owner" : "已连接"}</span>
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
                                <span>当前钱包 · {isCampaignOwner ? "本期 Owner" : isFactoryOwner ? "工厂 Owner" : "已连接"}</span>
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
                  ? "手机浏览器请点「连接钱包」，用 TokenPocket 打开本页后签名。现在只能查看链上数据。"
                  : "当前浏览器没有钱包插件。可安装 TokenPocket / MetaMask，手机可直接用 TokenPocket 打开本页。现在只能查看链上数据。"}
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
                title="演示：执行失败（电路报价超过募资总额，本金尚未支出）"
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
                <option value={OWNER}>Owner</option>
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
        {!chainBooting && chainEmpty && page !== "owner" && page !== "rules" && page !== "market" && page !== "fees" && (
          <section>
            <div className="empty">
              <p>主网工厂已部署，还没有开期。认筹、资产和转让都会在开期后出现。</p>
              {/* 发布是 Owner 的专属动作，非 Owner 不给入口 */}
              {isOwnerAddress ? (
                <button className="btn btn-primary" type="button" onClick={() => openPage("owner", "create")}>去发布众筹挖矿</button>
              ) : (
                <p className="empty-muted">开期后这里会出现认筹入口。发布众筹挖矿由 Owner 操作。</p>
              )}
            </div>
          </section>
        )}
        {!chainBooting && !(chainEmpty && page !== "owner" && page !== "rules" && page !== "market" && page !== "fees") && page === "round" && (
          <RoundHub
            round={round}
            book={book}
            copy={copy}
            quote={quote}
            remaining={remaining}
            pay={pay}
            countdown={countdown}
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
            onClaimMiningRewards={() => act("claimMiningRewards")}
            onClaimBem={() => act("claimBem")}
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
            onClaimBem={(address) => act("claimBem", { campaign: address })}
            onClaimMiningRewards={(address) => act("claimMiningRewards", { campaign: address })}
            onOpenPeriod={async (address) => {
              if (usingChain && address) await chain.switchCampaign(address);
              openPage("round");
            }}
            onConnect={handleConnect}
          />
        )}
        {!chainBooting && page === "fees" && canSeeFeeClaims && (
          <FeeClaims
            pending={pending}
            pendingTarget={pendingTarget}
            connected={connected}
            usingChain={usingChain}
            feeClaims={usingChain ? chain.feeClaims : null}
            feeClaimsLoading={usingChain ? chain.feeClaimsLoading : false}
            round={round}
            account={account}
            onClaimFee={(campaign) => act("claimFee", { campaign })}
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
        {!chainBooting && page === "owner" && canEnterOwnerDesk && chainEmpty && ownerTab !== "create" && (
          <section>
            <div className="empty">
              {ownerTab === "advanced" ? (
                <>
                  <p>高级配置作用于某一期合约。工厂里还没有期次，先发布一期。</p>
                  {isOwnerAddress ? (
                    <button className="btn btn-primary" type="button" onClick={() => openPage("owner", "create")}>发布众筹挖矿</button>
                  ) : (
                    <p className="empty-muted">只有 Owner 能开期：等 Owner 发布后再回来操作。</p>
                  )}
                </>
              ) : (
                <>
                  <p>工厂里还没有期次。发布后才会出现众筹列表。</p>
                  {isOwnerAddress ? (
                    <button className="btn btn-primary" type="button" onClick={() => openPage("owner", "create")}>发布众筹挖矿</button>
                  ) : (
                    <p className="empty-muted">只有 Owner 能开期：等 Owner 发布后再回来操作。</p>
                  )}
                </>
              )}
            </div>
          </section>
        )}
        {!chainBooting && page === "owner" && (canEnterOwnerDesk || (canPublishAsFactory && ownerTab === "create")) && (!chainEmpty || ownerTab === "create" || canPublishAsFactory) && (
          <OwnerDesk
            tab={ownerTab}
            round={round}
            book={book}
            copy={copy}
            quote={quote}
            pending={pending}
            pendingTarget={pendingTarget}
            actor={actor}
            account={account}
            connected={connected}
            usingChain={usingChain}
            chain={chain}
            factoryOwner={factoryOwner}
            allowedCircuits={allowedCircuits}
            chainHolders={chainHolders}
            holdersCampaign={holdersCampaign}
            now={now}
            onBuyCircuits={(args) => act("buyCircuits", args)}
            onOpenRefund={() => act("openRefund")}
            onRecoverBnb={() => act("recoverBnb")}
            onAbandonOrder={() => act("abandonOrder")}
            onCancelCircuitListing={(args) => act("cancelCircuitListing", args)}
            onListCircuit={(args) => act("listCircuit", args)}
            onWithdrawMarketProceeds={() => act("withdrawMarketProceeds")}
            onConfirmCircuits={() => act("confirmCircuits")}
            onSetPlan={() => act("setPlan")}
            onStartMining={(args) => act("startMining", args || {})}
            onStopMining={(args) => act("stopMining", args)}
            onClaimMiningRewards={() => act("claimMiningRewards")}
            onClaimBem={() => act("claimBem")}
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
            allowedCircuits={allowedCircuits}
            campaigns={usingChain ? chain.campaigns : []}
          />
        )}
        {page === "rules" && <RulesPage campaigns={usingChain ? chain.campaigns : []} />}
      </main>

      {notice && <div className="toast">{notice}</div>}
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
 * 在「当前进度」的 bill 行里又出现一次、电路市场面板的 stage 行还出现一次，
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
  round, book, copy, quote, remaining, pay, countdown,
  pending, connected, actor, onChain, onPick, onSubscribe, onRefund, onAbort, onMarkFailed, onOpenOwner, onOpenAssets, onOpenTransfer, onRecoverBnb,
  onClaimMiningRewards, onClaimBem,
  usingChain = false, periods, onSwitchPeriod,
}) {
  const isOwner = actor?.role === "owner";
  const ended = refundSettled(book);
  /**
   * 阶段 / 子状态 / 认购徽标（见 ./roundState.js + ./dealStatus.js）。
   * 全页只算一次：标题徽标、生命周期条、进度卡、电路市场面板都用这一份，
   * 不再各写一套字面量。
   */
  const state = rowState(book, Date.now() / 1000, dealStatus);

  // 待执行：电路市场成交进度（官方市场只有卖单；买入即原子到账）。
  const marketOwed = Number(book.marketOwed) || 0;
  /**
   * 电路数量两个口径：
   *  - circuitCount：**累计买入**张数（历史事实，卖出后不变）。
   *  - circuitHeldCount：**当前持有**张数（开出后仍持有，卖出后下降）。
   * 不要用挂单量反推 —— 官方市场买入是原子交割，成交即到账。
   */
  const boughtParts = Number(book.circuitCount ?? 0) || 0;
  const partsOnHand = Number(book.circuitHeldCount ?? 0) || 0;
  const tradeKey = [
    book.executePhase, book.marketOwed, boughtParts, partsOnHand,
    book.orderFilled,
    (book.listedCircuits || []).map((c) => `${c.tokenId}:${c.listingId}`).join(","),
  ].join("|");

  return (
    <>
      <LifecycleStrip book={book} />

      {book.halted && (
        <article className="card">
          <div className="card-body">
            <p className="fine warn-text">
              本期已熔断：认筹、挂单、卖出、开矿与份额交易暂停。
              退款、领款、撤单不受影响；等 Owner 解除后再试。
            </p>
          </div>
        </article>
      )}

      {book.scene === "funding" && (
        <ProductPage
          round={round}
          book={book}
          copy={copy}
          quote={quote}
          remaining={remaining}
          pay={pay}
          countdown={countdown}
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
                : "份数已售完。Owner 买入电路并确认到账后用官方挖矿合约开矿；开矿前会把没花完的募集款按份退回持份人。"}
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
                    {Number(book.miningActiveCount || 0) > 0 ? "挖矿中电路" : book.executePhase === "ready" ? "电路库存" : "已买入电路"}
                  </span>
                  <strong className={book.executePhase !== "ready" && boughtParts > 0 && partsOnHand === 0 ? "is-wait" : undefined}>
                    {Number(book.miningActiveCount || 0) > 0
                      ? `${partsOnHand} 张（${Number(book.miningActiveCount)} 张在挖）`
                      : partsOnHand > 0
                        ? `${partsOnHand} 张在手${boughtParts > partsOnHand ? ` · 累计买入 ${boughtParts} 张` : ""}`
                        : boughtParts > 0
                          ? `${boughtParts} 张（已卖出）`
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
                    ? `份额已全部退完，合约里只剩 ${round4(book.bnbPool)} BNB 尾差。点「取回剩余 BNB」转给 Owner；无人可退时「打开退款」会回滚。`
                    : "合约已清空：没有可退对象，也没有可取余额。已终结的期次不能再挂单或开矿。"}
                </p>
              ) : state.key === "failed" ? (
                state.short ? (
                  <p className="fine">
                    托管池只够按 {round4(Number(book.bnbPool || 0) / Math.max(1, outstandingOf(book)))} BNB/份 兑付，合约允许持份人按比例退款。
                  </p>
                ) : null
              ) : (
                <p className="fine">
                  没花完的募集款按份退回持份人（退余款或开矿时记账），各自领取；本期继续，电路留在合约。
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
                        {book.executionFailed ? "去合约工作台 · 降价重挂" : "去合约工作台 · 挂单"}
                      </button>
                    )}
                    {outstandingOf(book) > 0 ? (
                      <button
                        className="btn btn-outline btn-inline"
                        type="button"
                        disabled={Boolean(pending)}
                        onClick={onAbort}
                      >
                        {pending || "打开退款"}
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
                    去合约工作台 · 开矿
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
                    title="售罄满 3 天仍未开矿：任何地址都可判失败并开放退款"
                  >
                    {pending === "markFailed" ? "标记中…" : "Owner 长期未开矿 · 判失败并开放退款"}
                  </button>
                )}
                {!book.executionFailed && book.markFailedAt && Date.now() < book.markFailedAt && (
                  <p className="fine">
                    Owner 还没开矿。合约给了 3 天窗口买电路，
                    {isOwner
                      ? "你可以随时在合约工作台「原路退款 / 放弃挂单」立即退款，不必等这 3 天。"
                      : `非 Owner 可在 ${formatClock(book.markFailedAt)} 后判失败（还需 ${formatRemaining(book.markFailedAt - Date.now())}），届时先撤未成交买单，再开放退款。`}
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
                marketOwed,
                circuitCount: boughtParts,
                circuitHeldCount: partsOnHand,
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
         * 数值统一 20px、单位降级到 13px；「官方挖矿中」这类长文案改用胶囊，
         * 不再和数字抢同一档字号。说明行贴底，四张卡的说明落在同一条基线上。
         */
        const pooledParts = Number(book.circuitHeldCount ?? book.circuitCount) || 0;
        const hashpower = Number(book.estHashpower || 0);
        const mine = Number(book.mine || 0);
        const totalShares = Number(round.totalShares) || 0;
        const sharePercent = totalShares > 0 ? (mine / totalShares) * 100 : 0;
        const podPending = typeof book.miningPendingBem === "bigint"
          ? Number(book.miningPendingBem) / 1e8
          : Number(book.miningPendingBem || 0);
        const bemClaimable = Number(book.bemClaimable || 0);
        const pendingTotal = bemClaimable + podPending;
        const podLabel = formatBemClaimable(podPending) || "0";
        const pendingLabel = formatBemClaimable(pendingTotal) || "0";
        const claimLabel = formatBemClaimable(bemClaimable);
        const miningActive = Number(book.miningActiveCount || 0);
        const listedN = Array.isArray(book.listedCircuits) ? book.listedCircuits.length : 0;
        const canHarvest = connected && !pending && (miningActive > 0 || podPending > 0) && listedN === 0;
        return (
          <section className="mining-desk">
            <RoundTitle
              id={round.id}
              lead="本期电路已交给官方 PoD 挖矿合约，进入挖矿。"
              badge={state.label}
              tone={state.tone}
              deal={state.deal}
              periods={periods}
              onSwitchPeriod={onSwitchPeriod}
              processor={round.processorId || "未记录"}
            />
            <div className="mining-stats">
              <article className="mining-stat is-accent">
                <p className="mining-stat-label">在持电路</p>
                <p className="mining-stat-value">
                  {pooledParts.toLocaleString("zh-CN")}
                  <span className="mining-stat-unit">张</span>
                </p>
                <p className="mining-stat-note">合约名下的电路张数（挖矿中 {miningActive} 张）</p>
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
                <p className="mining-stat-label">产出</p>
                <p className="mining-stat-value">
                  {podLabel}
                  <span className="mining-stat-unit">BEM</span>
                </p>
                <p className="mining-stat-note">官方 PoD 尚未 harvest 的产出</p>
              </article>
              <article className="mining-stat">
                <p className="mining-stat-label">待领</p>
                <p className="mining-stat-value">
                  {pendingLabel}
                  <span className="mining-stat-unit">BEM</span>
                </p>
                <p className="mining-stat-note">已记账可领 + 未 harvest 产出</p>
              </article>
            </div>
            <article className="card mining-card">
              <div className="card-header">
                <span>挖矿奖励</span>
              </div>
              <div className="card-body">
                <dl className="mining-facts">
                  <div className="mining-fact">
                    <dt>我的份数</dt>
                    <dd>
                      {mine.toLocaleString("zh-CN")} / {totalShares.toLocaleString("zh-CN")} 份
                      {mine > 0
                        ? `（占 ${sharePercent % 1 === 0 ? sharePercent : sharePercent.toFixed(2)}%）`
                        : " · 当前钱包未持份"}
                    </dd>
                  </div>
                  <div className="mining-fact">
                    <dt>领取路径</dt>
                    <dd>先「领奖励」把产出记入本期；持份人再「领取 BEM」。领奖励任何人可点。</dd>
                  </div>
                </dl>
                <div className="mining-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!canHarvest}
                    title={
                      !connected ? "连接钱包后领取"
                        : listedN > 0 ? "先撤电路挂单再领奖"
                          : miningActive <= 0 && podPending <= 0 ? "暂无可领产出"
                            : "claimMiningRewards：任何人可调"
                    }
                    onClick={() => onClaimMiningRewards?.()}
                  >
                    {pending === "claimMiningRewards" ? "领取中…" : "领奖励"}
                  </button>
                  {claimLabel ? (
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={!connected || Boolean(pending)}
                      title="claimBem：按份额领取已记账 BEM"
                      onClick={() => onClaimBem?.()}
                    >
                      {pending === "claimBem" ? "领取中…" : `领取 BEM（${claimLabel}）`}
                    </button>
                  ) : null}
                  <button className="btn btn-outline" type="button" onClick={onOpenTransfer}>
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
 *   池子不足 · 按比例退 / 已到账 · 待开矿 / 挂单中 / 待挂单 / 官方挖矿中` 九套词，
 *   与 adapter 的 note、Owner 的 statusNote 互不相同。）
 */
function assetState(row, nowSec) {
  const state = rowState(row, nowSec, dealStatus);
  // 「Owner 尚未开矿、任何人可判失败」是操作性提示，不属于子状态，单独给。
  const canMarkFailed = assetCanMarkFailed(row, nowSec);
  return { ...state, hint: canMarkFailed ? "Owner 未开矿 · 可判失败" : "" };
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
  onRefund, onMarkFailed, onClaimSurplus, onClaimBem, onClaimMiningRewards, onOpenPeriod, onConnect,
}) {
  const simPod = typeof book.miningPendingBem === "bigint"
    ? Number(book.miningPendingBem) / 1e8
    : Number(book.miningPendingBem || 0);
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
        bemClaimable: connected ? Number(book.bemClaimable || 0) : 0,
        miningPendingBem: connected ? simPod : 0,
        miningActiveCount: Number(book.miningActiveCount || 0),
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
          <p className="empty-muted">连接钱包后才能读取你在每一期的份数。</p>
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
                  <th title="官方 PoD 尚未 harvest 的产出">产出</th>
                  <th title="已记账可领 + 未 harvest 产出">待领 BEM</th>
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
                  const bemRaw = connected ? Number(row.bemClaimable || 0) : 0;
                  const podRaw = connected ? Number(row.miningPendingBem || 0) : 0;
                  const bemLabel = bemRaw > 0 ? (formatBemClaimable(bemRaw) || "<0.000001") : "";
                  const podLabel = podRaw > 0 ? (formatBemClaimable(podRaw) || "<0.000001") : "";
                  const pendingLabel = (bemRaw + podRaw) > 0
                    ? (formatBemClaimable(bemRaw + podRaw) || "<0.000001")
                    : "";
                  const miningActive = Number(row.miningActiveCount || 0);
                  const canHarvest = connected && !pending
                    && (miningActive > 0 || podRaw > 0)
                    && (row.scene === "mining" || row.scene === "executing");
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
                      <td>{podLabel ? `${podLabel} BEM` : "—"}</td>
                      <td>{pendingLabel ? `${pendingLabel} BEM` : "—"}</td>
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
                              title="售罄满 3 天仍未开矿：任何地址都可判失败，为持有人打开退款"
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
                              title="按份应得的余款，由退余款或开矿记账产生；领取后到账"
                            >
                              {pending === "claimSurplus" ? "领取中…" : `领取 ${round4(row.pendingSurplusBnb)} BNB`}
                            </button>
                          )}
                          {canHarvest && (
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={() => onClaimMiningRewards?.(row.address)}
                              title="claimMiningRewards：任何人可调，把官方产出领回本期并按份记账"
                            >
                              {pending === "claimMiningRewards" ? "领取中…" : "领奖励"}
                            </button>
                          )}
                          {bemLabel ? (
                            <button
                              className="btn btn-primary"
                              type="button"
                              disabled={Boolean(pending)}
                              onClick={() => onClaimBem(row.address)}
                              title="claimBem：领取已记账的按份 BEM"
                            >
                              {pending === "claimBem" ? "领取中…" : `领取 ${bemLabel} BEM`}
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

/** 合约工作台：开期 / 开矿 / 持有人 / 调用 / 调试 */
function OwnerDesk({
  tab, round, book, copy, quote, pending, pendingTarget, actor, account,
  connected, usingChain, chain, factoryOwner, allowedCircuits, chainHolders, holdersCampaign, now,
  onBuyCircuits, onOpenRefund, onAbandonOrder, onCancelCircuitListing, onConfirmCircuits,
  onListCircuit, onWithdrawMarketProceeds,
  onSetPlan,
  onReturnSurplus,
  onStartMining, onStopMining, onClaimMiningRewards, onClaimBem,
  onRemoveCampaign, onOpenRound, onOpenAssets,
  onCreate, onConnect, onInvoke,
}) {
  /**
   * 子页面由左侧导航切换（众筹挖矿列表 / 发布众筹挖矿 / 高级配置），这里不再有横排页签。
   * 高级配置只给本期 Owner；工厂 Owner 已转出本期时只会停在 create。
   */
  const isCampaignOwner = actor?.role === "owner";
  const isFactoryOwner = Boolean(
    account && factoryOwner && String(account).toLowerCase() === String(factoryOwner).toLowerCase(),
  );
  const activeTab = tab === "advanced" && !isCampaignOwner
    ? (isFactoryOwner ? "create" : "overview")
    : tab;
  return (
    <section>
      {activeTab === "overview" && (
        <OwnerOverview
          round={round}
          book={book}
          copy={copy}
          quote={quote}
          pending={pending}
          pendingTarget={pendingTarget}
          actor={actor}
          history={chain.active ? chain.campaigns : null}
          onSwitchCampaign={usingChain ? chain.switchCampaign : null}
          onBuyCircuits={onBuyCircuits}
          onOpenRefund={onOpenRefund}
          onAbandonOrder={onAbandonOrder}
          onCancelCircuitListing={onCancelCircuitListing}
          onListCircuit={onListCircuit}
          onWithdrawMarketProceeds={onWithdrawMarketProceeds}
          onConfirmCircuits={onConfirmCircuits}
          onSetPlan={onSetPlan}
          onStartMining={onStartMining}
          onStopMining={onStopMining}
          onClaimMiningRewards={onClaimMiningRewards}
          onClaimBem={onClaimBem}
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
        />
      )}
      {activeTab === "advanced" && (
        <OwnerAdvanced
          round={round}
          book={book}
          pending={pending}
          actor={actor}
          factoryOwner={factoryOwner}
          connectedAccount={account}
          periods={usingChain ? chain.campaigns : []}
          onSwitchPeriod={usingChain ? chain.switchCampaign : null}
          onInvoke={onInvoke}
        />
      )}
      {activeTab === "create" && (
        <OwnerCreate
          pending={pending}
          snapshot={quote}
          now={now}
          chainMode={Boolean(chain?.active)}
          factoryOwner={factoryOwner}
          connectedAccount={chain?.account || ""}
          defaultFeeRecipient={chain?.account || ""}
          allowedCircuits={allowedCircuits}
          onCreate={onCreate}
          onConnect={onConnect}
          onInvoke={onInvoke}
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
   * 电路数与算力的权威口径：链上以 `circuitHeldCount` / `circuitCount` 为准。
   *  - circuitCount 是累计买入张数（历史事实）；circuitHeldCount 是当前持有张数。
   *    两者都不从市场挂单反推 —— 官方电路市场买入即交割，没有「等待成交」的挂单量。
   *  - hashpower = estHashpower，是 Owner 用 setPlan 写入的预估算力。
   * 链下演示模式没有链上数据，仍用募资额反推的估算值。
   */
  const onChain = Boolean(book?._chain);
  const chainParts = Number(book?.circuitHeldCount ?? 0) || 0;
  const boughtParts = Number(book?.circuitCount) || 0;
  const chainHashpower = Number(book?.hashpower) || Number(book?.estHashpower) || 0;
  /** 链上已有持有电路 → 展示真实值；否则展示募资反推的预期值并标注是预期。 */
  const hasBought = chainParts > 0;
  const partsValue = onChain ? (hasBought ? chainParts : null) : (est.usedParts || null);
  const weightValue = onChain ? (chainHashpower > 0 ? chainHashpower : null) : (est.hashpower || null);
  /** 电路数与算力是否来自链上真实数据 */
  const partsFromChain = onChain && hasBought;
  /**
   * 处理器与每张算力 P：
   *  - 名称只认合约锁定的 circuits → processorId；
   *  - P 只在「有已成交电路」且已知处理器时给出，不做 H÷电路数反推。
   */
  const shownProcessor = round.processorId || (onChain ? null : est.processor) || null;
  const shownScale = onChain
    ? (hasBought && shownProcessor ? processorScale(shownProcessor) : null)
    : (est.processorScale || null);
  /**
   * 服务费（链上口径）：serviceFeeBps 从 Campaign 读。
   * serviceFeeSet 区分「还没设过」与「已设为 0」——前者还能改，后者已永久锁定。
   *
   * ⚠️ 口径：这里的「服务费」是**挖矿产出奖励的服务费**（从官方 PoD 产出里计提），
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
          <div className="stat-label">{partsFromChain ? "已买入电路" : "电路数"}</div>
          <div className="stat-value">
            {partsValue != null
              ? `${partsValue} 张`
              : onChain && boughtParts > 0
                ? <span className="muted-value">已卖出</span>
                : "未买入"}
          </div>
          <div className="stat-note">
            {partsFromChain ? (
              <>
                权重 {weightValue != null ? weightValue.toLocaleString("zh-CN") : "—"} H
                {" · "}累计买入 {boughtParts} 张
                <em className="est-tag">持仓口径</em>
              </>
            ) : onChain ? (
              boughtParts > 0
                ? `累计买入 ${boughtParts} 张，当前持有 0 张（已卖出）`
                : "尚未买入，电路与算力待成交后确定"
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
            <div className="stat-note">每张算力 P 待电路成交后才有意义</div>
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
       * 上面「电路数」卡的备注和下面的强制提示里各有一份，再画一排只会重复。
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
                  电路数由募资总额按当前报价反推：本期 {est.usedParts} 张，
                  权重 H = {est.hashpower} = {est.usedParts} × {est.processorScale}（电路数 × 每张算力）。
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
            <div className="stat-note">挂单时锁定的电路总成本</div>
          </article>
        </div>
      ) : null}
      {/*
       * 强制提示：募集中只在认购按钮旁出现一次，避免同一屏两段相同的风险提示。
       */}
      {book.scene !== "funding" && (
        <div className="commit-warning wide" role="note">
          <strong>电路数不构成本期承诺。</strong>
          <span>不约定电路数量与买价，由 Owner 售罄后按市价决定，可能低于按当前报价的估值；分配合约接入前不发放收益。</span>
        </div>
      )}
    </>
  );
}

function ProductPage({ round, book, copy, quote, remaining, pay, countdown, pending, connected, onPick, onSubscribe, onRefund, onChain = false, usingChain = false, periods, onSwitchPeriod }) {
  const progress = Math.round((book.sold / round.totalShares) * 100);
  const fundingOpen = book.scene === "funding" && (!book.endsAt || Date.now() <= book.endsAt);
  const fundingExpired = book.scene === "funding" && book.endsAt && Date.now() > book.endsAt;
  const feeReady = Boolean(book.serviceFeeSet ?? round.serviceFeeSet);
  const canSubscribe = fundingOpen && remaining > 0 && !book.halted && feeReady;
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
             * 这里原本还有一条 Pipeline（募集 / 买电路 / 开矿），
             * 和页首的生命周期条是同一件事的两种画法，两条进度条并排出现。
             * 只留生命周期条（它带子状态），本卡只讲资金路径。
             *
             * 下方原有一段 `book.scene === "executing"` 的说明 —— 本组件只在募集中渲染，
             * 那段永远为假；同内容已在「待执行」页的 hero lead 里各说一次，故删除。
             */}
            <div className="path">
              <h2>资金只走这条路径</h2>
              <ol>
                <li>未售罄：到期后各自退回本金。</li>
                <li>售罄：挂单买入电路，到账后用官方 PoD 合约开矿。</li>
                <li>挖矿：官方合约产出 BEM 给本期，再按份额分给持份人。</li>
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
                  募集已截止且未满额。用认筹时的钱包退回，本金按原路打回。
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
            {fundingOpen && !feeReady ? (
              <p className="fine" role="status">Owner 尚未设定服务费，认筹暂未开放。</p>
            ) : null}
            <div className="commit-warning" role="note">
              <strong>电路数不构成本期承诺。</strong>
              <span>
                不指定电路数量与买价，由 Owner 售罄后按市价决定，可能少于按当前报价的估值。
                BEM 产出由官方 PoD 合约铸给本期，再按份额分给持份人。挖矿产出服务费从产出里计提，
                <strong>认筹款不收任何服务费</strong> —— 你付的 BNB 全额进托管池，只用于买电路。
              </span>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!canSubscribe || Boolean(pending)}
              onClick={onSubscribe}
              title={book.halted
                ? "本期已熔断：认筹暂停，等 Owner 解除后再认购"
                : !feeReady
                  ? "Owner 尚未设定服务费"
                  : canSubscribe && connected && book.approved ? "确认认筹" : undefined}
            >
              {pending === "subscribe"
                ? "认筹中…"
                : (book.halted
                  ? "已熔断 · 认筹暂停"
                  : !feeReady
                    ? "待设服务费"
                    : subscribeLabel(book, connected, canSubscribe))}
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
  /** 熔断只停份额市场的「挂出 / 接单」，撤单必须一直可用（否则份额会被挂单永久锁住）。 */
  const halted = Boolean(book.halted);
  const canPublish = available > 0 && canTransfer && !halted;
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
            <p>转入挖矿后才能转让份额：可发布出售挂单，也可接收他人挂单。</p>
          </div>
        </div>
      )}

      {canTransfer && halted && (
        <div className="transfer-banner is-closed" role="status">
          <span className="transfer-banner-icon" aria-hidden="true">!</span>
          <div>
            <strong>本期已熔断：份额挂单与接单暂停</strong>
            <p>挂单与接单已暂停，撤单不受影响；等 Owner 抬闸后再挂。</p>
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
                <p className="fine">还没有人挂单。你发布后，挂单会显示在这里。</p>
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
                        takeDisabled={halted}
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
              <p className="fine">挂单即锁定份额，成交或撤单后释放。成交款由买方直接付给你。</p>
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
              {canTransfer && !canPublish && !halted && (
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

function ListingRow({ listing, account, pending, disabled = false, takeDisabled = false, onTake, onCancel }) {
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
              disabled={disabled || takeDisabled || Boolean(pending)}
              title={takeDisabled ? "本期已熔断：接单暂停，撤单仍可用" : undefined}
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
    { n: "2", title: SCENE.executing.label, body: "电路到账后用官方合约开矿" },
    { n: "3", title: SCENE.mining.label, body: "官方 PoD 产出按份额分配；退出走挖矿份额转让" },
  ];
  const exits = [
    { title: "被动 · 退款", body: "募集超时、执行失败或池子不足时退回本金，份额清零。" },
    { title: "确认到账 · 退余款", body: "电路到账后，没花完的募集款按份退回认筹地址（各自领取）。本期继续，电路留在合约照常开矿。" },
    { title: "主动 · 挖矿份额转让", body: "仅挖矿中。在「资产转让」发布出售挂单，份额立即锁定，成交款直接付给你。" },
  ];
  const roles = [
    ["任何人", "查看状态；挖矿中可接收他人挂单、查看进度；售罄满 3 天可判失败或退余款；可代调 claimMiningRewards"],
    ["认筹用户", "认筹；超时或失败时退款；领取自己的募集款余款"],
    ["持份用户", "挖矿中发布 / 撤销份额挂单；领取余款、服务费与 BEM（claimBem）"],
    ["Owner（唯一管理角色）", "开期、改计划、买入 / 挂卖电路、退余款、开退款 / 补缺口、熔断与抬闸、开矿、取回资产、转移所有权；Owner 应当是多签"],
  ];
  const sharedContracts = [
    {
      name: "开期工厂 CampaignFactory",
      address: deployments.factory,
      verify: true,
      use: "各期共用。开期写入每份单价、总份数、募集天数、本期电路合约（从白名单选）；immutable 绑定市场、PoD、BEM 与部署器。",
    },
    {
      name: "期次部署器 CampaignDeployer",
      address: deployments.campaignDeployer || CAMPAIGN_DEPLOYER_ADDRESS,
      verify: true,
      use: "无状态辅助合约：工厂 createCampaign 时由它 new 出一期 Campaign，避免工厂字节码超限。",
    },
    {
      name: "电路市场",
      address: deployments.circuitMarket,
      use: "官方 ERC721 卖单市场（list / buy / delist）。期次合约用 safeTransferFrom 收 NFT，须实现 onERC721Received。",
    },
    {
      name: "官方 PoD 挖矿",
      address: deployments.podMining || POD_MINING_ADDRESS,
      use: "官方挖矿代理。期次持有电路后 startMining；产出铸给期次，再 claimMiningRewards 记账。",
    },
    {
      name: "官方 BEM",
      address: deployments.bem || BEM_ADDRESS,
      use: "挖矿产出代币。claimMiningRewards 后按份额记入 pendingBem，持份人 claimBem 自领。",
    },
    {
      name: "官方 PoD Lens",
      address: deployments.podLens || POD_LENS_ADDRESS,
      use: "只读资格判定：refsEligible（算力倍率 + 网表无 REF）。买入面板与市价过滤会用到。",
    },
  ];
  /**
   * 电路合约：工厂的**电路白名单**（部署时写入、不可增删），每期开期时选其中一个锁定。
   * 主网 = 官方两个集合（TapeOut / Behemoth）。
   */
  const partsContracts = (Array.isArray(deployments.allowedCircuits) ? deployments.allowedCircuits : [])
    .map((address) => {
      const processor = processorFromCircuitContract(address);
      return {
        name: processor ? `${processor} 电路（ERC721）` : "电路合约（ERC721）",
        address,
        verify: true,
        use: processor
          ? `官方 ${processor} 集合。开期锁定后，买入的电路都属于该集合，并由本期合约持有开矿。`
          : "工厂白名单内的 ERC721。开期锁定后，买入的电路都属于该集合。",
      };
    });
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
          认筹款先托管，售罄后才买电路。没花完的本金按份退回；退出只有退款和挖矿份额转让。
          电路到账后由 Owner 用官方 PoD 挖矿合约开矿。
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
            <p>三条路径互不交叉：募集中和待执行不能转让份额；退余款只动钱，不动电路。</p>
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
            <h2>开矿</h2>
            <p>电路到账后，Owner 写入预估计划并调用官方挖矿合约开矿。</p>
          </div>
          {/*
           * 这里不再重复「挂单 → 到账 → startMining」三步：
           * 完整调用顺序在下方「开矿条件」里已经是权威的一处，再列一遍只是同一流程换个粒度。
           */}
          <p className="rules-note">
            余款怎么退见「退出 · 确认到账」；完整调用顺序见下方「开矿条件」。
          </p>
        </section>
      </div>

      <section className="rules-block">
        <div className="rules-block-head">
          <h2>挖矿</h2>
          <p>电路由本期合约持有，通过官方 PoD 合约产出 BEM，再按份额分给持份人。</p>
        </div>
        <div className="rules-formula">
          <span>开矿条件</span>
          <strong>份额售罄 → buyCircuits 可多次买入 → setPlan（所持 × P）→ confirmCircuits（之后不能再买）→ returnSurplus → startMining → claimMiningRewards → claimBem</strong>
        </div>
        {/*
         * 这里原本还有一句「电路入池后不可撤出；挖矿中的退出只有挖矿份额转让」——
         * 页首 lead 与上方第 3 步已经各说过一次，同一屏第三遍。删掉。
         */}
      </section>

      <div className="rules-contracts-split">
        <section className="rules-block">
          <div className="rules-block-head">
            <h2>共用合约</h2>
            <p>
              {NETWORK.name}：工厂、部署器、市场、PoD、BEM 各期共用；电路从白名单选一个开期锁定。
            </p>
          </div>
          <ul className="rules-contracts">{renderContractRows([...sharedContracts, ...partsContracts])}</ul>
        </section>
        <section className="rules-block">
          <div className="rules-block-head">
            <h2>期次合约</h2>
            <p>每期一个独立 Campaign，认筹、托管、买电路、开矿和退款都走它。</p>
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
  if (!canSubscribe) {
    if (book.scene === "funding" && !book.serviceFeeSet) return "待设服务费";
    return "已停止认筹";
  }
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
