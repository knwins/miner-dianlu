import { useEffect, useMemo, useRef, useState } from "react";
import { readCall } from "./Calls.jsx";
import { OwnerCreate, OwnerOverview } from "./Owner.jsx";
import { IS_CONFIGURED as CHAIN_CONFIGURED, NETWORK, CHAIN_ID, explorerAddress, sourcifySource, BEM_MAINNET } from "./chain/config.js";
import { useChain } from "./chain/useChain.js";
import {
  send,
  tx as chainTx,
  parseEther,
  parseBnb,
  readHolders,
  readRecentSubscriptions,
  hasInjected,
  setCampaignAddress,
  createCampaignOnChain,
  readFactoryOwner,
} from "./chain/client.js";
import { discoverWallets, isMobile } from "./chain/wallets.js";
import deployments from "./chain/deployments.json";
import { OFFICIAL_PARTS, partsContractForProcessor } from "./tapeout.js";
import { buildExecuteStartData } from "./podStart.js";
import { keccak256, toUtf8Bytes } from "ethers";

// 演示网表：execute 时传入原始字节，合约内 keccak 后须等于开期承诺的 netlistHash
const RAW_NETLIST = toUtf8Bytes("netlist-v1");
const RAW_NETLIST_HASH = keccak256(RAW_NETLIST);
/** MockPoD 占位；接 OfficialPodAdapter 时必须换成打包后的官方 startData。 */
const MOCK_START_DATA = "0x12345678";
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
  applySubscribe,
  applyOpenRefund,
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
  NETWORK_WEIGHT,
  NETWORK_DAILY_EMISSION,
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
  { id: "round", label: "BEM挖矿认筹", hint: "募集 → 待执行 → 挖矿" },
  { id: "assets", label: "我的资产", hint: "认筹 / 持仓 / 领取" },
  { id: "transfer", label: "资产转让", hint: "挖矿份额转让" },
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
  /** 正在移除的期次地址；列表里只有这一条显示「移除中」 */
  const [pendingTarget, setPendingTarget] = useState("");
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
  const chainEmpty = chain.active && chain.empty && !chain.book;
  // 工厂已部署时，读失败不能退回本地演示数据，否则会把真期次盖成「还没有」或假的第 3 期。
  const chainBooting = chain.active && !chain.book && !chain.empty;
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
      "subscribe", "listShares", "cancelListing", "takeListing", "refund", "claim", "execute", "harvest",
      "placeTransistorOrder", "cancelTransistorOrder", "confirmTransistors", "setPlan", "updateNetworkWeight",
      "createCampaign", "openRefund", "removeCampaign", "removeCampaignAt",
      "setPod", "setBem", "setMinter", "setFeeShares", "recoverBnb", "recoverTransistors", "transferOwnership",
      "setFactoryPod", "setFactoryBem", "setFactoryMinter", "setFactoryOwner",
    ];
    if (chain.active && WRITE_METHODS.includes(method)) return chainInvoke(method, args);
    if (["scene", "phase", "sold", "sharePriceBnb", "totalShares", "hashpower", "estHashpower", "dailyBem", "harvestCount", "feeBps", "totalDistributed", "sharesOf", "pendingBem"].includes(method)) {
      return { ok: true, message: readCall(method, args, round, book, account, quote) };
    }

    let result;
    if (method === "subscribe") result = applySubscribe(round, book, args.shares);
    else if (method === "listShares") result = applyListShares(round, book, args, actor);
    else if (method === "cancelListing") result = applyCancelListing(round, book, args.listingId, actor);
    else if (method === "takeListing") result = applyTakeListing(round, book, args.listingId, args.shares, actor);
    else if (method === "claim") result = applyClaim(round, book);
    else if (method === "execute") result = applyExecute(round, book, quote, actor, taskbook);
    else if (method === "harvest") result = applyHarvest(round, book);
    else if (method === "placeTransistorOrder") result = applyPlaceTransistorOrder(round, book, actor, args);
    else if (method === "openRefund") result = applyOpenRefund(round, book, actor);
    else if (method === "cancelTransistorOrder") result = applyCancelTransistorOrder(round, book, actor);
    else if (method === "confirmTransistors") result = applyConfirmTransistors(round, book, actor);
    else if (method === "refund") result = applyRefund(round, book, actor);
    else if (method === "createCampaign") result = applyCreate(round, args, quote, taskbook);
    else if (method === "recoverBnb") result = { ok: true, message: "模拟：BNB 已转给 Owner" };
    else if (method === "recoverTransistors") result = { ok: true, message: "模拟：晶体管已转给 Owner" };
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
    setPendingTarget(
      method === "removeCampaign"
        ? String(args?.campaign || args?.address || "").toLowerCase()
        : ""
    );
    (async () => {
      try {
        let signer = chain.signer;
        if (!signer) {
          const w = await chain.connect();
          signer = w.signer;
        }
        if (method === "createCampaign") {
          await chainCreateCampaign(args, signer);
          return;
        }
        if (method === "removeCampaign" || method === "removeCampaignAt") {
          const removed = args?.campaign || args?.address;
          if (method === "removeCampaignAt") {
            const index = BigInt(Math.floor(Number(args?.index ?? -1)));
            if (index < 0n) throw new Error("请填写工厂列表索引");
            await send(chainTx.removeCampaignAt(signer, index));
          } else {
            if (!removed || !/^0x[0-9a-fA-F]{40}$/.test(String(removed))) {
              throw new Error("请填写要移除的期次地址");
            }
            await send(chainTx.removeCampaign(signer, removed));
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
            throw new Error("这期合约还是旧挂单接口，不会调用官方材料市场。重新部署并新开一期后才能 placeBid。");
          }
          const nandQty = BigInt(Math.floor(Number(args?.nandQty) || 0));
          const latchQty = BigInt(Math.floor(Number(args?.latchQty) || 0));
          if (nandQty === 0n && latchQty === 0n) throw new Error("NAND 与 LATCH 数量不能都为 0");
          const nandPrice = nandQty > 0n ? parseEther(String(args?.nandPrice ?? "0").trim()) : 0n;
          const latchPrice = latchQty > 0n ? parseEther(String(args?.latchPrice ?? "0").trim()) : 0n;
          if ((nandQty > 0n && nandPrice <= 0n) || (latchQty > 0n && latchPrice <= 0n)) {
            throw new Error("有数量的元件必须填写大于 0 的单价");
          }
          const transistors = args?.transistors
            || book.transistors
            || partsContractForProcessor(round.processorId)
            || OFFICIAL_PARTS.TAPE_OUT_NAND.contract;
          await send(chainTx.placeTransistorOrder(signer, transistors, nandQty, nandPrice, latchQty, latchPrice));
        } else if (method === "openRefund") {
          await send(chainTx.openRefund(signer));
        } else {
          const promise = buildChainTx(method, args, signer);
          await send(promise);
        }
        setNotice(method === "openRefund"
          ? "链上已退款。认筹 BNB 已按认筹地址原路退回。"
          : method === "placeTransistorOrder"
            ? "已向材料市场挂单。保证金从本期募集款托管。"
            : `已确认：${method} ✓`);
        await chain.refresh();
        if (
          method === "claim"
          || method === "refund"
          || method === "openRefund"
          || method === "listShares"
          || method === "takeListing"
          || method === "cancelListing"
          || method === "harvest"
          || method === "subscribe"
        ) await chain.refreshPositions?.();
        if (method === "createCampaign") await chain.refreshHistory?.();
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
    let feeShares = (Array.isArray(draft.feeShares) ? draft.feeShares : [])
      .map((row) => ({
        address: String(row.address || "").trim(),
        shareBps: Math.round(Number(row.shareBps)),
      }))
      .filter((row) => row.address || row.shareBps);
    if (feeShares.length === 0 && (draft.feeRecipients || draft.feeRecipient)) {
      const recipients = String(draft.feeRecipients || draft.feeRecipient || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const bps = String(draft.feeShareBps || (recipients.length === 1 ? "10000" : ""))
        .split(",")
        .map((s) => Math.round(Number(s.trim())));
      feeShares = recipients.map((address, i) => ({
        address,
        shareBps: bps[i] ?? 0,
      }));
    }
    if (feeShares.length === 0) {
      const fallback = String(draft.feeRecipient || chain.account || "").trim();
      feeShares.push({ address: fallback, shareBps: 10_000 });
    }
    for (const row of feeShares) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(row.address)) throw new Error("服务费收费地址格式不正确");
      const percent = row.shareBps / 100;
      if (!Number.isInteger(percent) || percent < 1 || percent > 100 || row.shareBps % 100 !== 0) {
        throw new Error("服务费分成比例须为 1 到 100 的整数");
      }
    }
    const feeShareSum = feeShares.reduce((sum, row) => sum + row.shareBps, 0);
    if (feeShareSum !== 10_000) {
      throw new Error(`所有分成地址比例之和必须等于 100，当前合计为 ${feeShareSum / 100}`);
    }
    const feeRecipient = feeShares[0].address;
    const taskId = BigInt(String(draft.taskId || 54));
    const netlistHash =
      draft.netlistHash && String(draft.netlistHash).startsWith("0x")
        ? draft.netlistHash
        : RAW_NETLIST_HASH;

    // signer 可能被 accountsChanged 清掉，尽量补签
    let activeSigner = signer;
    if (!activeSigner) {
      const w = await chain.connect();
      activeSigner = w.signer;
    }

    const transistors = partsContractForProcessor(draft.processorId);
    if (!transistors) throw new Error("请选择目标处理器 TapeOut 或 Behemoth");
    const { campaign: created, hash } = await createCampaignOnChain(activeSigner, {
      sharePriceWei,
      totalShares,
      feePercent,
      fundingDays,
      feeRecipient,
      feeShares,
      taskId,
      netlistHash,
      transistors,
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
      case "subscribe": return chainTx.subscribe(signer, BigInt(args.shares), BigInt(args.shares) * priceWei);
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
      case "confirmTransistors":
        if (book._chain && book.marketOrders === false) {
          throw new Error("这期合约不能读取官方订单簿。重新部署后，成交以 bids(id).remaining 为准。");
        }
        if (book._chain && !book.orderFilled) {
          throw new Error("官方市场买单还没吃完（remaining > 0），不能进入待流片。");
        }
        return chainTx.confirmTransistors(signer);
      case "setPlan": {
        const src = args || {};
        const count = BigInt(src.count || (chainEst && chainEst.usedParts) || book.transistorCount || 0);
        const estHp = BigInt(Math.round(
          src.hashpower ?? ((chainEst && chainEst.hashpower) || book.estimate?.hashpower || 0)
        ));
        if (count <= 0n) throw new Error("还没有元件数量，无法写入 setPlan");
        return chainTx.setPlan(signer, estHp, Boolean(src.capped ?? book.capped), count);
      }
      case "updateNetworkWeight":
        return chainTx.updateNetworkWeight(signer, BigInt(args.verified), BigInt(args.unverified));
      case "execute": {
        if (!netlistMatch) throw new Error("网表不匹配，无法 execute（检查 netlistHash）");
        if (book.executionFailed) throw new Error("本期已判流片失败，请先降价重挂或退款，不要直接再 execute");
        if (!(Number(book.priceLock) > 0 && Number(book.transistorCount) > 0)) {
          throw new Error("锁价或元件数无效，无法流片（禁止零成本 execute）");
        }
        const startData = buildExecuteStartData(args || {}) || MOCK_START_DATA;
        if (deployments.podIsAdapter && startData === MOCK_START_DATA) {
          throw new Error("当前 PoD 是官方适配器，请填写电路 ID 与证明，或粘贴打包好的 startData");
        }
        return chainTx.execute(signer, RAW_NETLIST, startData);
      }
      case "setPod": return chainTx.setPod(signer, args.pod);
      case "setBem": return chainTx.setBem(signer, args.bem);
      case "setMinter": return chainTx.setMinter(signer, args.minter);
      case "setFeeShares": {
        const recipients = String(args.feeRecipients || args.feeRecipient || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const shareBps = String(args.feeShareBps || "")
          .split(",")
          .map((s) => Math.round(Number(s.trim())));
        if (!recipients.length || recipients.length !== shareBps.length) {
          throw new Error("收费地址与分成基点数量须一致");
        }
        return chainTx.setFeeShares(signer, recipients, shareBps);
      }
      case "recoverBnb": {
        const amount = BigInt(args?.amountWei ?? args?.amount ?? 0);
        if (amount <= 0n) throw new Error("转出数量必须大于 0");
        return chainTx.recoverBnb(signer, amount);
      }
      case "recoverTransistors": {
        const token = String(args?.token || "").trim();
        const id = BigInt(args?.id ?? 0);
        const amount = BigInt(args?.amount ?? 0);
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("晶体管合约地址无效");
        if (amount <= 0n) throw new Error("转出数量必须大于 0");
        return chainTx.recoverTransistors(signer, token, id, amount);
      }
      case "transferOwnership": return chainTx.transferOwnership(signer, args.newOwner);
      case "setFactoryPod": return chainTx.setFactoryPod(signer, args.pod);
      case "setFactoryBem": return chainTx.setFactoryBem(signer, args.bem);
      case "setFactoryMinter": return chainTx.setFactoryMinter(signer, args.minter);
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
    run(method === "subscribe" ? "认筹中" : "处理中", () => invokeCall(method, args));
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
                              <div><dt>BEM</dt><dd>{formatBem(chain.book.bemBalance || 0)}</dd></div>
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
              <p>{chain.error ? `链上读取失败：${chain.error}` : `正在从 ${NETWORK.name} 读取 Campaign 状态…`}</p>
              {chain.error && (
                <button className="btn btn-primary" type="button" onClick={chain.refresh}>重试</button>
              )}
            </div>
          </section>
        )}
        {!chainBooting && chainEmpty && page !== "owner" && page !== "rules" && (
          <section>
            <div className="empty">
              <p>主网工厂已部署，还没有开期。认筹、资产和转让都会在开期后出现。</p>
              <button className="btn btn-primary" type="button" onClick={() => openPage("owner", "create")}>去发布众筹挖矿</button>
            </div>
          </section>
        )}
        {!chainBooting && !(chainEmpty && page !== "owner" && page !== "rules") && page === "round" && (
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
            onSubscribe={subscribeShares}
            onRefund={() => act("refund")}
            onAbort={() => act("openRefund")}
            onClaim={() => act("claim")}
            onHarvest={() => act("harvest")}
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
            onClaim={(address) => act("claim", { campaign: address })}
            onRefund={(address) => act("refund", { campaign: address })}
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
            title="资产转让"
            periods={usingChain ? chain.campaigns : []}
            onSwitchPeriod={usingChain ? chain.switchCampaign : null}
          />
        )}
        {!chainBooting && page === "owner" && chainEmpty && ownerTab !== "create" && (
          <section>
            <div className="empty">
              <p>工厂里还没有期次。发布后才会出现众筹列表。</p>
              <button className="btn btn-primary" type="button" onClick={() => openPage("owner", "create")}>发布众筹挖矿</button>
            </div>
          </section>
        )}
        {!chainBooting && page === "owner" && (!chainEmpty || ownerTab === "create") && (
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
            pendingTarget={pendingTarget}
            actor={actor}
            account={account}
            executeWait={executeWait}
            connected={connected}
            usingChain={usingChain}
            chain={chain}
            factoryOwner={factoryOwner}
            chainHolders={chainHolders}
            holdersCampaign={holdersCampaign}
            now={now}
            onPlaceTransistorOrder={(args) => act("placeTransistorOrder", args)}
            onOpenRefund={() => act("openRefund")}
            onCancelTransistorOrder={() => act("cancelTransistorOrder")}
            onConfirmTransistors={() => act("confirmTransistors")}
            onExecute={(args) => act("execute", args)}
            onHarvest={() => act("harvest")}
            onSetPlan={() => act("setPlan")}
            onRemoveCampaign={(address) => act("removeCampaign", { campaign: address })}
            onOpenRound={() => openPage("round")}
            onOpenAssets={() => openPage("assets")}
            onCreate={handleCreate}
            onConnect={handleConnect}
            onInvoke={invokeCall}
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

/** 流片失败且认筹已全部退回：大状态结束，不再停在待执行。 */
function refundSettled(row) {
  return Boolean(row?.executionFailed) && Number(row?.sold) === 0;
}

/** 生命周期进度条：募集 → 待执行 → 挖矿。全部退款后，待执行改为已结束。 */
function LifecycleStrip({ scene, phase, ended }) {
  const steps = [
    { id: "funding", label: "募集中" },
    { id: "executing", label: ended ? "已结束" : "待执行" },
    { id: "mining", label: "挖矿中" },
  ];
  const idx = Math.max(0, steps.findIndex((s) => s.id === scene));
  const phaseHint = ended
    ? "已失败原路退款"
    : scene === "executing"
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
          <div className={`life-step${i < idx ? " is-done" : ""}${i === idx ? " is-active" : ""}${ended && step.id === "executing" ? " is-ended" : ""}`}>
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
  pending, connected, actor, onChain, onPick, onSubscribe, onRefund, onAbort, onClaim, onHarvest, onOpenOwner, onOpenAssets, onOpenTransfer,
  usingChain = false, periods, onSwitchPeriod,
}) {
  const netW = book.capped ? book.netWeightUnverified : book.netWeightVerified;
  const harvest = computeHarvest(round, book, book.selfAddress, Number.isFinite(netW) ? netW : null);
  const dailyBem = book._chain && book.dailyBem != null ? book.dailyBem : harvest.dailyBem;
  const execEst = book.estimate || {};
  const isOwner = actor?.role === "owner";
  const ended = refundSettled(book);

  return (
    <>
      <LifecycleStrip scene={book.scene} phase={book.executePhase} ended={ended} />

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
            phase={ended ? "已结束" : "待执行"}
            lead={ended
              ? "本期已结束。流片失败，认筹 BNB 已按认筹地址原路退回。"
              : "份数已售罄。晶体管到账后即可流片。Owner 也可以直接发起退款，认筹 BNB 会按认筹地址原路退回。"}
            badge={ended ? "已结束" : copy.badge}
            tone={ended ? "done" : copy.tone}
            periods={periods}
            onSwitchPeriod={onSwitchPeriod}
            processor={round.processorId || "未记录"}
          />
          <RoundFacts round={round} book={book} quote={quote} taskbook={taskbook} />
          <article className="card progress-card">
            <div className="card-header">当前进度</div>
            <div className="card-body">
              <Pipeline scene={book.scene} phase={book.executePhase} ended={ended} />
              <ul className="bill">
                <li><span>已售</span><strong>{book.sold} / {round.totalShares} 份</strong></li>
                <li><span>托管 BNB</span><strong>{round4(book.bnbPool || 0)} BNB</strong></li>
                <li><span>{ended ? "状态" : "晶体管子态"}</span><strong>{
                  ended ? "已结束"
                    : book.executePhase === "ready" ? "已到账 · 待流片"
                    : book.executePhase === "listed" ? "挂单中"
                      : "待挂单"
                }</strong></li>
                <li><span>{ended ? "结果" : "退款"}</span><strong style={!ended && book.executionFailed ? { color: "var(--color-danger)" } : undefined}>{
                  ended
                    ? "已失败原路退款"
                    : book.executionFailed
                      ? "持份人可原路退还"
                      : book.executePhase !== "buying"
                        ? "请先取消挂单"
                        : "由 Owner 决定"
                }</strong></li>
              </ul>
              <p className="fine">
                {ended
                  ? "本期已结束。流片失败，认筹 BNB 已按认筹地址原路退回，合约里不再留有募集款。"
                  : book.executionFailed
                    ? "流片失败，本金未支出。可到「我的资产」原路退还；Owner 也可降价重挂或批量退款剩余。"
                    : "晶体管到账后即可流片。待挂单时 Owner 也可以直接发起退款。成功流片后未花完的募集款会按份退回。"}
              </p>
              <div className="actions">
                {isOwner && book.executePhase === "buying" && (
                  <>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={() => onOpenOwner()}
                    >
                      {book.executionFailed ? "去 Owner · 降价重挂" : "去 Owner 工作台 · 挂单"}
                    </button>
                    <button
                      className="btn btn-inline"
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={onAbort}
                    >
                      {pending || (book.executionFailed ? "退款剩余" : "退款")}
                    </button>
                  </>
                )}
                {isOwner && book.executePhase !== "buying" && !book.executionFailed && (
                  <button className="btn btn-primary" type="button" onClick={onOpenOwner}>
                    去 Owner 工作台 · 流片
                  </button>
                )}
                {isOwner && book.executePhase === "ready" && book.executionFailed && (
                  <button className="btn btn-primary" type="button" onClick={onOpenOwner}>
                    去 Owner · 撤回重挂
                  </button>
                )}
                {(book.executionFailed || (book.scene === "funding" && book.endsAt && Date.now() > book.endsAt)) && (
                  <button className="btn btn-inline" type="button" onClick={onOpenAssets}>
                    我的资产 · 退款
                  </button>
                )}
                {!(book.executionFailed || (book.scene === "funding" && book.endsAt && Date.now() > book.endsAt)) && (
                  <button className="btn btn-inline" type="button" onClick={onOpenAssets}>
                    我的资产
                  </button>
                )}
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
            lead="按份分发 BEM。主动退出请走「资产转让」；合约不提供本金赎回。"
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
          <article className="card claim-card">
            <div className="card-header">领取</div>
            <div className="card-body">
              <div className="claim-actions">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!connected || (!book._chain && !(dailyBem > 0)) || Boolean(pending)}
                  onClick={onHarvest}
                  title={book._chain || dailyBem > 0 ? undefined : "当前没有可分发数量"}
                >
                  {pending === "harvest" ? "分发中…" : "全网分发"}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!connected || book.claimable <= 0 || Boolean(pending)}
                  onClick={onClaim}
                >
                  {pending === "claim" ? "领取中…" : `领取 ${formatBem(book.claimable)} BEM`}
                </button>
                <button className="btn btn-inline" type="button" onClick={onOpenTransfer}>
                  资产转让
                </button>
              </div>
              <p className="fine claim-fine">
                分发会先把当天的 BEM 打进本期合约，扣服务费后再按份记账。领取只转你自己已经入账、并且合约里拿得出来的部分。
              </p>
            </div>
          </article>
        </section>
      )}
    </>
  );
}

/** 大状态下面的细分：募集超时、待挂单 / 挂单中 / 待流片、流片失败。 */
function assetSubstatus(row, nowSec) {
  if (row.scene === "funding") {
    if (row.fundingDeadline > 0 && nowSec > row.fundingDeadline && row.sold < row.totalShares) return "超时未售罄";
    return "认筹中";
  }
  if (row.scene === "executing") {
    if (refundSettled(row)) return "已失败原路退款";
    if (row.executionFailed) return "流片失败 · 可退款";
    if (row.phase === "ready") return "已到账 · 待流片";
    if (row.phase === "listed") return "挂单中";
    return "待挂单";
  }
  if (row.scene === "mining") return "按份出矿";
  return "";
}

/** 当前钱包买过、退过、领过，或仍有挂单锁定的期。 */
function participated(row) {
  return Number(row.shares) > 0
    || Number(row.escrow) > 0
    || Number(row.pendingBem) > 0
    || Number(row.claimedBem) > 0
    || Number(row.refundedBnb) > 0;
}

/** 与合约 refund() 对齐：募集超时未售罄，或待执行且已判流片失败；须有可用份额且无挂单锁定。 */
function assetCanRefund(row, nowSec) {
  const free = Number(row.shares || 0);
  if (free <= 0 || Number(row.escrow || 0) > 0) return false;
  if (row.scene === "funding") {
    return row.fundingDeadline > 0
      && nowSec > row.fundingDeadline
      && Number(row.sold) < Number(row.totalShares);
  }
  return row.scene === "executing" && Boolean(row.executionFailed);
}

function AssetsHub({
  round, book, copy, pending, connected, usingChain,
  positions, positionsLoading,
  onClaim, onRefund, onOpenPeriod, onConnect,
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
        totalShares: round.totalShares,
        sharePriceBnb: round.sharePriceBnb,
        executionFailed: Boolean(book.executionFailed),
        fundingDeadline: book.endsAt ? Math.floor(book.endsAt / 1000) : 0,
        shares: connected ? book.mine : null,
        escrow: connected ? book.listingShares || 0 : 0,
        pendingBem: book.claimable || 0,
        claimedBem: book.claimed || 0,
        refundedBnb: book.refundedSelf || 0,
      }];
  const mineRows = rows.filter(participated);
  const held = mineRows.filter((row) => Number(row.shares) + Number(row.escrow) > 0);
  const shareSum = held.reduce((sum, row) => sum + Number(row.shares || 0) + Number(row.escrow || 0), 0);
  const bemSum = mineRows.reduce((sum, row) => sum + Number(row.pendingBem || 0), 0);
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
          只列出当前钱包参与过的期次。没买过、没退过、也没领过的期不显示。
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
        <article className="stat-card">
          <div className="stat-label">合计可领</div>
          <div className="stat-value">{connected ? `${formatBem(bemSum)} BEM` : "—"}</div>
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
                  <th>可领</th>
                  <th>已退</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mineRows.map((row) => {
                  const canClaim = connected && row.scene === "mining" && row.pendingBem > 0;
                  const canRefund = connected && assetCanRefund(row, nowSec);
                  const refundBnb = round4(Number(row.shares || 0) * Number(row.sharePriceBnb || 0));
                  const ended = refundSettled(row);
                  const tone = ended ? "done" : row.executionFailed ? "back" : row.scene === "mining" ? "mine" : row.scene === "executing" ? "wait" : "live";
                  const sub = assetSubstatus(row, nowSec);
                  return (
                    <tr key={row.address || row.id}>
                      <td>第 {row.id} 期</td>
                      <td className="asset-status-cell">
                        <div className={`asset-status tone-${tone}`}>
                          <strong>{ended ? "已结束" : row.sceneLabel}</strong>
                          {sub ? <span>{sub}</span> : null}
                        </div>
                      </td>
                      <td>{row.totalShares ? `${row.sold}/${row.totalShares}` : "—"}</td>
                      <td>{`${Number(row.shares || 0) + Number(row.escrow || 0)} 份`}</td>
                      <td>{connected ? `${formatBem(row.pendingBem || 0)} BEM` : "—"}</td>
                      <td>{connected ? `${round4(row.refundedBnb || 0)} BNB` : "—"}</td>
                      <td>
                        <div className="actions assets-actions">
                          <button className="btn btn-inline" type="button" onClick={() => onOpenPeriod(row.address)}>
                            打开
                          </button>
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
                          {canClaim && (
                            <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={() => onClaim(row.address)}>
                              {pending || "领取"}
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

/** Owner 工作台：开期 / 流片 / 持有人 / 调用 / 调试 */
function OwnerDesk({
  tab, onTab, tabs, round, book, copy, quote, taskbook, pending, pendingTarget, actor, account,
  executeWait, connected, usingChain, chain, factoryOwner, chainHolders, holdersCampaign, now,
  onPlaceTransistorOrder, onOpenRefund, onCancelTransistorOrder, onConfirmTransistors, onExecute, onHarvest, onSetPlan,
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
          taskbook={taskbook}
          pending={pending}
          pendingTarget={pendingTarget}
          actor={actor}
          executeWait={executeWait}
          history={chain.active ? chain.campaigns : null}
          onSwitchCampaign={usingChain ? chain.switchCampaign : null}
          onPlaceTransistorOrder={onPlaceTransistorOrder}
          onOpenRefund={onOpenRefund}
          onCancelTransistorOrder={onCancelTransistorOrder}
          onConfirmTransistors={onConfirmTransistors}
          onExecute={onExecute}
          onHarvest={onHarvest}
          onSetPlan={onSetPlan}
          onRemoveCampaign={onRemoveCampaign}
          onOpenRound={onOpenRound}
          onOpenAssets={onOpenAssets}
          account={account}
          connected={connected}
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
  const namedProcessor = Boolean(round.processorId);
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
            <span>{round.processorId || est.processor || "未记录"}</span>
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
            <div className="stat-value">{namedProcessor ? `${est.hashpower.toLocaleString("zh-CN")} H` : "—"}</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">预估日产</div>
            <div className="stat-value">{namedProcessor ? `${formatBem(est.dailyBem)} BEM` : "—"}</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">募资总额可买元件</div>
            <div className="stat-value">{namedProcessor ? `${est.affordableParts.toLocaleString("zh-CN")} 个` : "—"}</div>
          </article>
          <article className="stat-card">
            <div className="stat-label">{book.executionFailed ? "合约剩余" : "报价余量"}</div>
            <div className="stat-value" style={!book.executionFailed && namedProcessor && !est.capCoversFloor ? { color: "var(--color-danger)" } : undefined}>
              {book.executionFailed
                ? `${round4(book.bnbPool || 0)} BNB`
                : !namedProcessor
                  ? "—"
                  : est.capCoversFloor
                  ? `${(est.hardCapBnb - est.needBnb).toFixed(4)} BNB`
                  : `缺 ${(est.needBnb - est.hardCapBnb).toFixed(4)} BNB`}
            </div>
            {book.executionFailed ? (
              <div className="stat-note">已退回 {round4(book.refundedTotal || 0)} BNB</div>
            ) : null}
          </article>
          <article className="stat-card">
            <div className="stat-label">预估日产（已扣服务费）</div>
            <div className="stat-value">{namedProcessor ? `${formatBem(est.dailyBem * (1 - feeRate(round)))} BEM` : "—"}</div>
          </article>
          <article className="stat-card wide-stat note-card">
            <div className="stat-label">预估随报价浮动，不是承诺</div>
            <p className="note-copy">
              {book.executionFailed
                ? `本期已退款。合约里剩余 ${round4(book.bnbPool || 0)} BNB，累计已退回 ${round4(book.refundedTotal || 0)} BNB。上面的算力和元件个数仍按募资总额与当前报价估算，不是合约余额。`
                : round.processorId ? <>
                  募资总额 {est.hardCapBnb.toFixed(4)} BNB，按 {round.processorId} 当前报价（NAND {est.priceNand.toFixed(4)}{est.latch > 0 ? ` / LATCH ${est.priceLatch.toFixed(4)}` : ""} BNB，混合均价{" "}
                  {est.usedParts > 0 ? (est.needBnb / est.usedParts).toFixed(4) : "0.0000"} BNB/个）可买 {est.affordableParts} 个；本期题目 {est.usedParts} 个元件（
                  {est.nand} NAND + {est.latch} LATCH{est.latch === 0 ? "，纯组合逻辑" : ""}），权重 H ={" "}
                  {est.hashpower} = {est.usedParts} ×{est.processorScale}
                  {est.optimal ? ` + 溢价 ${est.refParts}×${est.q}` : "（非最优，无设计溢价）"}。
                  报价余量是募资总额减去当前元件成本，不是合约里还剩多少 BNB。
                </> : <>
                  募资总额 {est.hardCapBnb.toFixed(4)} BNB。本期合约没有写入目标处理器，名称是未记录，P 留空。
                </>}
            </p>
          </article>
        </div>
      )}
    </>
  );
}

function ProductPage({ round, book, copy, quote, taskbook, remaining, pay, countdown, executeWait, pending, connected, onPick, onSubscribe, onRefund, onChain = false, usingChain = false, periods, onSwitchPeriod }) {
  const progress = Math.round((book.sold / round.totalShares) * 100);
  const fundingOpen = book.scene === "funding" && (!book.endsAt || Date.now() <= book.endsAt);
  const fundingExpired = book.scene === "funding" && book.endsAt && Date.now() > book.endsAt;
  const canSubscribe = fundingOpen && remaining > 0;
  const refundBnb = round4((book.mine || 0) * round.sharePriceBnb);
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
        processor={round.processorId || est.processor || "未记录"}
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
                <li>未售罄：到期后由认筹地址自己点退回，只退该钱包的本金。</li>
                <li>售罄：按当前报价买入 NAND / LATCH 元件，流片成为矿机。</li>
                <li>挖矿：BEM 按份分配，先扣 {round.feeBps / 100}% 服务费。</li>
              </ol>
              {book.scene === "executing" && (
                <p className="fine">
                  {book.executePhase === "ready"
                    ? "晶体管已到位，Owner 可以立即流片。流片不可逆。"
                    : "本期份数已售完。Factory Owner 需手动调用 tapeout.net 挂单逻辑买入晶体管，到账后即可确认并流片。"}
                </p>
              )}
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
            <p className="remain">{canSubscribe ? `剩余 ${remaining} 份，不能自填金额` : "本期已停止认筹"}</p>
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
            去认筹
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
              <div className="stat-label">认筹金额</div>
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
              <div className="stat-note">认筹/转让后剩余可用流动性</div>
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
                  <span>我的认筹已付</span>
                  <strong>{round4(book.mine * round.sharePriceBnb + (book.refundedSelf || 0))} BNB</strong>
                </li>
              </ul>
              <p className="fine">
                募集款与转让结算都走合约代持 BNB 池，与钱包余额隔离。
                认筹时扣你的 BNB 进池；转让接收时买方 BNB 实时付给卖方；
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
                  <p className="fine">募集已超过截止时间仍未售罄，可把认筹的 BNB 原路退还。退款后份额清零，本期视为募集失败。</p>
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
                  <p className="fine">本期流片执行失败（元件报价超过募资总额，本金尚未支出）。可把认筹的 BNB 原路退还，退款后份额清零。也可由 Owner 待元件降价后重试流片。</p>
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
  const principal = (held + locked) * round.sharePriceBnb;
  const netW = book.capped ? book.netWeightUnverified : book.netWeightVerified;
  const harvest = computeHarvest(round, book, book.selfAddress, Number.isFinite(netW) ? netW : null);
  const dailyBem = book._chain && book.dailyBem != null ? book.dailyBem : harvest.dailyBem;
  const mining = book.scene === "mining" && Number(book.hashpower) > 0;

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
            把挖矿份额挂到转让市场。挂出后立即锁定，卖出或撤单后才回到可用份数。
          </p>
        </header>
      )}
      {embedded && <h2 className="embedded-title">份额转让</h2>}

      {!embedded && (
        <>
          <div className="holding-grid transfer-self">
            <article className="stat-card accent">
              <div className="stat-label">我的份数</div>
              <div className="stat-value">{connected ? `${held} 份` : "—"}</div>
              <div className="stat-note">第 {round.id} 期 · 可挂牌 {connected ? held : "—"} 份</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">挂单锁定</div>
              <div className="stat-value">{connected ? `${locked} 份` : "—"}</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">认筹本金</div>
              <div className="stat-value">{connected ? `${principal.toFixed(4)} BNB` : "—"}</div>
              <div className="stat-note">每份 {round.sharePriceBnb.toFixed(4)} BNB</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">可领取</div>
              <div className="stat-value">{connected ? `${formatBem(book.claimable)} BEM` : "—"}</div>
              <div className="stat-note">已领取 {connected ? `${formatBem(book.claimed)} BEM` : "—"}</div>
            </article>
          </div>
          <div className="holding-grid transfer-mine">
            <article className="stat-card accent">
              <div className="stat-label">实际算力</div>
              <div className="stat-value">{mining ? `${Number(book.hashpower).toLocaleString("zh-CN")} H` : "—"}</div>
              <div className="stat-note">{mining ? "挖矿中" : copy.badge}</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">日产{book._chain ? "（链上）" : ""}</div>
              <div className="stat-value">{mining ? `${formatBem(dailyBem)} BEM` : "—"}</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">已分发轮数</div>
              <div className="stat-value">{mining ? (book.harvestCount || harvest.rounds || 0) : "—"}</div>
              <div className="stat-note">已分配 {mining ? `${formatBem(book.distributed || 0)} BEM` : "—"}</div>
            </article>
            <article className="stat-card">
              <div className="stat-label">已售份数</div>
              <div className="stat-value">{book.sold}/{round.totalShares}</div>
            </article>
          </div>
        </>
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
        <div className="layout transfer-desk">
          <article className="card">
            <div className="card-header">
              <span>转让市场 · 接收发布的出售价额</span>
              <span className="stat-label">开放 {openCount} · 完成 {doneCount}</span>
            </div>
            <div className="card-body">
              {marketRows.length === 0 ? (
                <p className="fine">还没有人挂单。发布出售后，挂单会显示在这里供其他持份人接收。</p>
              ) : (
                <div className="listing-board">
                  <div className="listing-head">
                    <span>卖方</span>
                    <span>份数</span>
                    <span>单价</span>
                    <span>合计</span>
                    <span>状态</span>
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
              <p className="fine">挂单后这部分份额从可用余额扣出并锁定，不能领取或转让，直到成交或撤单。</p>
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

        </div>
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
  return (
    <li className={`listing-row is-${status}`}>
      <span className="listing-seller">
        {shortAddress(listing.seller)}
        {isMine ? <em>我的</em> : null}
      </span>
      <span className="listing-shares">{listing.shares > 0 ? `${listing.shares} 份` : "—"}</span>
      <span className="listing-price">{listing.priceBnbPerShare.toFixed(4)} BNB / 份</span>
      <span className="listing-sum">{listing.totalBnb.toFixed(4)} BNB</span>
      <div className="listing-actions">
        {status === "done" && <span className="listing-status is-done">完成</span>}
        {status === "cancelled" && <span className="listing-status is-cancelled">已撤单</span>}
        {status === "open" && isMine && (
          <button className="btn btn-inline" type="button" disabled={disabled || Boolean(pending)} onClick={() => onCancel(listing.id)}>
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
    readRecentSubscriptions(8)
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

  if (rows == null) return <p className="fine">加载最近认筹…</p>;
  if (!rows.length) return <p className="fine">链上暂无认筹记录。</p>;
  return (
    <div className="recent">
      <p className="fine">最近认筹{usingChain ? "（链上事件 · Subscribed）" : ""}</p>
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
    { n: "1", title: "募集", body: "按份认筹，BNB 进托管池" },
    { n: "2", title: "待执行", body: "晶体管到账后流片" },
    { n: "3", title: "挖矿", body: "按份分发 BEM，可转让" },
  ];
  const exits = [
    { title: "被动 · 退款", body: "募集超时未售罄，或流片失败且本金未支出。按认筹价原路退回，份额清零。" },
    { title: "主动 · 资产转让", body: "仅挖矿中。挂单立刻锁定份额，成交时买方 BNB 直接付给卖方。" },
  ];
  const roles = [
    ["任何人", "查看状态；挖矿中可分发并领取自己的收益"],
    ["认筹用户", "募集中认筹；超时或流片失败时原路退款"],
    ["持份用户", "挖矿中挂牌、接单、撤销自己的挂单"],
    ["Factory Owner", "开期、晶体管三步、流片、更新全网权重"],
  ];
  const sameAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const bemIsMainnet = sameAddr(deployments.bem, BEM_MAINNET);
  const officialPod = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
  const podIsOfficial = sameAddr(deployments.pod, officialPod);
  const podIsAdapter = Boolean(deployments.podIsAdapter);
  const sharedContracts = [
    {
      name: "开期工厂",
      address: deployments.factory,
      verify: true,
      use: "各期共用。开期时把 PoD、BEM、材料市场写入新期次。服务费分成表写在每一期里，不是共用合约。",
    },
    {
      name: "BEM",
      address: BEM_MAINNET,
      href: `https://bscscan.com/address/${BEM_MAINNET}`,
      use: bemIsMainnet
        ? "主网奖励代币，各期共用。harvest 扣下的服务费按当期分成表从这里转出，整除余数进 Owner。"
        : "主网奖励代币。当前网络还没有用这个地址。",
    },
    ...(!bemIsMainnet && deployments.bem
      ? [{
          name: "BEM（当前替身）",
          address: deployments.bem,
          use: "当前期次实际使用的代币。主网应改为上面的 BEM。",
        }]
      : []),
    {
      name: podIsAdapter ? "PoD 适配器" : podIsOfficial ? "PoD 挖矿合约" : "PoD（替身）",
      address: deployments.pod,
      verify: podIsAdapter,
      use: podIsAdapter
        ? `各期共用。对外仍是 IPoD，对内调官方 ${officialPod}。execute 前当期须持有电路 NFT，startData 须带官方证明。`
        : podIsOfficial
          ? "各期共用。流片调 start，harvest 调 claim，入账金额是实收。"
          : "官方 PoD 认的是电路 NFT 持有人：调用 start 的地址必须是 ownerOf。手里还有晶体管不算。主网这一期仍接同接口替身。流片调 start，分发调 claim。",
    },
    {
      name: "材料市场",
      address: deployments.minter,
      use: "各期共用的官方二级市场。晶体管不再铸造。NAND 的 tokenId 为 0，LATCH 为 1。挂单 placeBid，撤单 cancelBid，成交看 bids(id).remaining。",
    },
  ];
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
            <h1>规则</h1>
          </div>
        </div>
        <p className="round-hero-lead">
          认筹款先托管，售罄后才流片。没有本金赎回，退出只有退款和挖矿中的资产转让。
          {deployments.bemIsMock
            ? " 当前为 BSC 测试网。主网晶体管只能在材料市场买卖，harvest 依赖 PoD 真实排放。"
            : ""}
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
            <p>两条路径互不交叉。募集中和待执行不能挂牌。</p>
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
            <h2>流片</h2>
            <p>晶体管到位后才能流片，由 Owner 钱包发起。</p>
          </div>
          <ol className="rules-steps">
            <li><span>1</span>挂单并锁价</li>
            <li><span>2</span>确认到账</li>
            <li><span>3</span>立即流片开矿</li>
          </ol>
          <p className="rules-note">买得起就开矿；买不起则判失败，本金不动，用户可退款，Owner 可降价重试。</p>
        </section>
      </div>

      <section className="rules-block">
        <div className="rules-block-head">
          <h2>挖矿与领取</h2>
          <p>全网分发一轮，各领各的。分发次数不限，入账按 PoD 实收，日产估算只作参考。</p>
        </div>
        <div className="rules-formula">
          <span>个人可领</span>
          <strong>日产 × 已分发轮数 × (1 − 服务费) × 我的份数 / 总份数 − 已领</strong>
        </div>
        <div className="rules-metrics">
          <div><span>全网日产</span><strong>{NETWORK_DAILY_EMISSION.toLocaleString()} BEM</strong></div>
          <div><span>已验证池</span><strong>99%</strong></div>
          <div><span>未验证池</span><strong>1%</strong></div>
          <div><span>权重基准</span><strong>{Number(NETWORK_WEIGHT.verified).toLocaleString()} / {Number(NETWORK_WEIGHT.unverified).toLocaleString()}</strong></div>
        </div>
        <p className="rules-note">日产按本期算力占全网权重折算。权重上涨则日产下降。流片后以实际算力为准。</p>
      </section>

      <div className="rules-contracts-split">
        <section className="rules-block">
          <div className="rules-block-head">
            <h2>共用合约</h2>
            <p>
              {NETWORK.name}上工厂、BEM 与材料市场各期共用。
              {podIsAdapter
                ? "PoD 已接官方适配器：流片前把电路 NFT 转给当期，execute 带证明。"
                : podIsOfficial
                  ? "PoD 也各期共用。"
                  : "PoD 仍是替身。官方挖矿不认当期合约持有的晶体管，只认电路 NFT 的主人。"}
              服务费分成地址写在每一期里。
            </p>
          </div>
          <ul className="rules-contracts">{renderContractRows(sharedContracts)}</ul>
        </section>
        <section className="rules-block">
          <div className="rules-block-head">
            <h2>期次合约</h2>
            <p>每一期有独立 Campaign，认筹、托管、退款、流片和领取都走它。</p>
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

function Pipeline({ scene, phase, ended }) {
  const steps = ["募集", "买晶体管", "流片开矿"];
  const active = ended
    ? -1
    : {
        funding: 0,
        executing: phase === "ready" ? 2 : 1,
        mining: 2,
      }[scene];
  return (
    <ol className="pipeline">
      {steps.map((label, index) => (
        <li
          key={label}
          className={
            ended
              ? index === 0 ? "is-done" : index === 1 ? "is-stop" : ""
              : index === active ? "is-on" : index < active ? "is-done" : ""
          }
        >
          {label}
        </li>
      ))}
    </ol>
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
