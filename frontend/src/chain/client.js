// 链上对接客户端（ethers v6）。读取 Campaign 实时状态、发送写交易。
// 无钱包时用公共 RPC 只读；有钱包（window.ethereum）时签名发送。
import { AbiCoder, BrowserProvider, FetchRequest, JsonRpcProvider, Network, Contract, Interface, formatEther, parseEther, ZeroAddress, getAddress, id, keccak256 } from "ethers";
import { CAMPAIGN_ABI, FACTORY_ABI, MATERIAL_MARKET_ABI, MOCK_PARTS_ABI } from "./abis.js";
import {
  CAMPAIGN_ADDRESS,
  FACTORY_ADDRESS,
  CHAIN_ID,
  CHAIN_ID_HEX,
  NETWORK,
  IS_CONFIGURED,
} from "./config.js";
import { discoverWallets, explainConnectError, inAppWalletName, rememberWallet, rememberedWalletId } from "./wallets.js";
import deployments from "./deployments.json";

export { formatEther, parseEther, ZeroAddress };

const STORAGE_KEY = "miner.activeCampaign";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** 与 Campaign.FAIL_GRACE 保持一致：非 Owner 须在售罄满 3 天后才能 markFailed。 */
export const FAIL_GRACE_SECONDS = 3 * 86_400;

let _browser = null;
let _rawProvider = null;
let _readProvider = null;
let _campaignAddress = CAMPAIGN_ADDRESS;

try {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (isAddr(saved)) _campaignAddress = saved;
} catch {
  /* SSR / 隐私模式 */
}

export function getCampaignAddress() {
  return _campaignAddress || CAMPAIGN_ADDRESS;
}

export function setCampaignAddress(addr) {
  if (!isAddr(addr)) return;
  _campaignAddress = addr;
  try {
    localStorage.setItem(STORAGE_KEY, addr);
  } catch {
    /* ignore */
  }
}

export function clearCampaignAddress() {
  _campaignAddress = "";
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function hasInjected() {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.ethereum
    || window.tokenpocket?.ethereum
    || window.okxwallet
    || window.trustwallet
    || window.bitkeep?.ethereum
    || window.BinanceChain
  );
}

export function getRawProvider() {
  return _rawProvider;
}

function makeStaticProvider(url) {
  const network = Network.from(CHAIN_ID);
  const request = new FetchRequest(url);
  // 公共节点有时不返回也不报错。不设超时的话，开页会一直停在「正在读取」。
  request.timeout = 8_000;
  // ethers 默认把同 tick 的调用打包成一次 JSON 数组请求（batchMaxCount=100）。
  // 备用节点 drpc 免费档只收 ≤3 个的批量，超了直接 500 —— 这里统一压到 3，
  // 既保留批量（省请求数），又保证换到 drpc 时不炸。
  return new JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 3 });
}

/** 读链用公共 RPC；某个节点额度/403 时换下一个，避免前端卡在单一节点。 */
export function getReadProvider() {
  if (!_readProvider) {
    _readProvider = makeStaticProvider(NETWORK.rpcUrls[0]);
    _readProviderIndex = 0;
  }
  return _readProvider;
}

let _readProviderIndex = 0;

export async function withReadProvider(run) {
  const urls = NETWORK.rpcUrls;
  let lastErr;
  for (let offset = 0; offset < urls.length; offset++) {
    const index = (_readProviderIndex + offset) % urls.length;
    const provider = index === _readProviderIndex && _readProvider
      ? _readProvider
      : makeStaticProvider(urls[index]);
    try {
      const result = await run(provider);
      _readProvider = provider;
      _readProviderIndex = index;
      return result;
    } catch (err) {
      lastErr = err;
      const text = String(err?.shortMessage || err?.message || err || "");
      const contractRevert = /execution reverted/i.test(text) && !/missing revert|coalesce/i.test(text);
      const rotatable = !contractRevert;
      if (!rotatable || offset === urls.length - 1) throw err;
    }
  }
  throw lastErr;
}

async function injectedChoices() {
  const choices = await discoverWallets();
  return choices.filter((item) => item.kind === "injected");
}

function pickInjected(injected, { allowPrompt } = { allowPrompt: false }) {
  const inApp = inAppWalletName();
  if (inApp) {
    const named = injected.find((item) => item.name === inApp);
    if (named) return named.provider;
  }
  const saved = rememberedWalletId();
  if (saved) {
    const remembered = injected.find((item) => item.walletId === saved);
    if (remembered) return remembered.provider;
  }
  if (injected.length === 1) return injected[0].provider;
  if (!allowPrompt) return null;
  if (injected.length > 1) {
    const err = new Error("检测到多个钱包，请先选择要连接的钱包");
    err.code = "NEED_CHOICE";
    throw err;
  }
  const err = new Error(inApp
    ? `${inApp} 还没有准备好，请稍后重试`
    : "未检测到钱包。手机请用 TokenPocket 打开本页");
  err.code = "NO_WALLET";
  throw err;
}

async function resolveInjected(preferred) {
  if (preferred && typeof preferred.request === "function") return preferred;
  return pickInjected(await injectedChoices(), { allowPrompt: true });
}

function chainAddParams() {
  return [
    {
      chainId: CHAIN_ID_HEX,
      chainName: NETWORK.name,
      rpcUrls: NETWORK.rpcUrls,
      nativeCurrency: NETWORK.currency,
      blockExplorerUrls: NETWORK.explorer ? [NETWORK.explorer] : [],
    },
  ];
}

function isRpcQuotaError(err) {
  const text = String(err?.shortMessage || err?.message || err || "");
  return /usage limit|1rpc|#pricing|-32001|missing response|BAD_DATA|could not coalesce/i.test(text);
}

function markRpcUpdated() {
  try {
    sessionStorage.setItem("miner.rpcUpdated.v4", "1");
  } catch {
    /* 隐私模式 */
  }
}

function rpcAlreadyUpdated() {
  try {
    return sessionStorage.getItem("miner.rpcUpdated.v4") === "1";
  } catch {
    return false;
  }
}

async function readWalletChainId(raw) {
  if (!raw?.request) return "";
  try {
    const id = await raw.request({ method: "eth_chainId" });
    return id ? String(id).toLowerCase() : "";
  } catch (err) {
    if (isRpcQuotaError(err)) return "";
    throw err;
  }
}

function isWalletSimError(err) {
  const text = String(err?.shortMessage || err?.message || err || "");
  return /missing revert data|could not coalesce|usage limit|1rpc|#pricing|-32001|missing response|403|archive|personal token|exceeded maximum retry/i.test(text);
}

function holdAccount(on) {
  try {
    if (on) sessionStorage.setItem("miner.holdAccount", "1");
    else sessionStorage.removeItem("miner.holdAccount");
  } catch {
    /* 隐私模式 */
  }
}

/** 估 gas / eth_call 走公共节点。钱包自带的 1rpc 超额时会回空数据，ethers 显示 missing revert data。 */
function hardenSigner(signer, raw) {
  if (!signer || signer.__publicRpc) return signer;
  const sendTransaction = signer.sendTransaction.bind(signer);
  const fromOf = () => signer.getAddress();

  signer.estimateGas = async (tx) => {
    const from = tx.from || await fromOf();
    try {
      return await withReadProvider((provider) => provider.estimateGas({ ...tx, from }));
    } catch (err) {
      // 节点没带回回退数据时，不要让钱包再用坏 RPC 估一次。给足 gas，实际只扣消耗的部分。
      if (isWalletSimError(err)) return 8_000_000n;
      throw err;
    }
  };
  signer.call = async (tx) => {
    const from = tx.from || await fromOf();
    return withReadProvider((provider) => provider.call({ ...tx, from }));
  };
  signer.sendTransaction = async (tx) => {
    let next = tx;
    if (next.gasLimit == null) {
      try {
        const gas = await signer.estimateGas(next);
        next = { ...next, gasLimit: (gas * 120n) / 100n };
      } catch (err) {
        if (!isWalletSimError(err)) throw err;
        next = { ...next, gasLimit: 8_000_000n };
      }
    }
    try {
      return await sendTransaction(next);
    } catch (err) {
      if (!isWalletSimError(err) || !raw?.request) throw err;
      // 钱包仍用自己的 BSC 节点模拟。改成公共节点后再发一次。
      holdAccount(true);
      try {
        await raw.request({ method: "wallet_addEthereumChain", params: chainAddParams() });
        markRpcUpdated();
        return await sendTransaction(next);
      } finally {
        holdAccount(false);
      }
    }
  };
  signer.__publicRpc = true;
  return signer;
}

function browserProvider(raw) {
  // staticNetwork 让 ethers 不再为了探测网络去打钱包的 eth_chainId。
  // OKX 会把 eth_chainId 转到当前 RPC；1rpc 超额时这条请求会失败，但账户其实已经授权。
  const network = Network.from(CHAIN_ID);
  return new BrowserProvider(raw, network, { staticNetwork: network });
}

async function bindWallet(raw, { request = true, updateRpc = false } = {}) {
  let accounts;
  if (request) {
    accounts = await raw.request({ method: "eth_requestAccounts" });
  } else {
    accounts = await raw.request({ method: "eth_accounts" });
    if (!accounts?.length) return null;
  }
  const account = String(accounts[0] || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return null;

  // 账户已经拿到。切链失败（含坏 RPC）不能把「已连接」清掉。
  if (updateRpc) {
    try {
      await ensureChain(raw, { updateRpc: true });
    } catch {
      /* 签名前再提示链或节点 */
    }
  }

  const provider = browserProvider(raw);
  let signer = null;
  try {
    signer = hardenSigner(await provider.getSigner(account), raw);
  } catch {
    signer = null;
  }

  rememberWallet(raw);
  _browser = provider;
  _rawProvider = raw;
  return { provider, signer, account, raw };
}

/** 连接指定钱包并切到目标链。未指定时仅在只有一个注入钱包时自动连接。 */
export async function connectWallet(preferred) {
  const raw = await resolveInjected(preferred);
  try {
    return await bindWallet(raw, { request: true, updateRpc: true });
  } catch (error) {
    const wrapped = new Error(explainConnectError(error));
    wrapped.code = error?.code;
    throw wrapped;
  }
}

/**
 * 静默恢复：钱包已授权过本站时，用 eth_accounts 取回地址，不弹窗。
 * 用于页面刷新 / 链切换后，避免顶栏仍显示「尚未连接」。
 */
export async function restoreWallet(preferred) {
  try {
    const raw = preferred && typeof preferred.request === "function"
      ? preferred
      : pickInjected(await injectedChoices(), { allowPrompt: false });
    if (!raw) return null;
    return await bindWallet(raw, { request: false, updateRpc: false });
  } catch {
    return null;
  }
}

/** 切换到目标链；若钱包没有该链则添加后再切一次。TokenPocket 有时把未知链报成 -32603。 */
export async function ensureChain(raw, { updateRpc = true } = {}) {
  const eip1193 = raw?.request ? raw : _rawProvider;
  if (!eip1193?.request) return;

  const target = CHAIN_ID_HEX.toLowerCase();
  const addParams = chainAddParams();
  const add = () => eip1193.request({ method: "wallet_addEthereumChain", params: addParams });
  const switchChain = () => eip1193.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: CHAIN_ID_HEX }],
  });

  let current = "";
  try {
    current = await readWalletChainId(eip1193);
  } catch (err) {
    // 节点超额时 eth_chainId 会失败。不要因此 wallet_addEthereumChain，否则 OKX 会弹窗并把连接状态冲掉。
    if (isRpcQuotaError(err)) return;
    throw err;
  }
  if (!current) return;

  if (String(current).toLowerCase() === target) {
    if (updateRpc && !rpcAlreadyUpdated()) markRpcUpdated();
    return;
  }

  try {
    await switchChain();
  } catch (err) {
    const code = err?.code ?? err?.data?.originalError?.code;
    const message = err?.message || "";
    if (code === 4001) throw err;
    if (
      code === 4902
      || code === -32603
      || /Unrecognized chain|unknown chain|not been added/i.test(message)
      || isRpcQuotaError(err)
    ) {
      await add();
      markRpcUpdated();
      await switchChain();
      return;
    }
    throw err;
  }
}

export function campaignContract(runner, address = getCampaignAddress()) {
  if (!isAddr(address)) throw new Error("尚未配置 Campaign 地址（请先部署）");
  return new Contract(address, CAMPAIGN_ABI, runner);
}
export function factoryContract(runner, address = FACTORY_ADDRESS) {
  if (!isAddr(address)) throw new Error("尚未配置 Factory 地址");
  return new Contract(address, FACTORY_ABI, runner);
}

/** 读取 Campaign 全量状态（含当前账户的分账）。account 为空则跳过账户相关字段。 */
export async function readState(account, campaignAddr = getCampaignAddress()) {
  if (!IS_CONFIGURED && !isAddr(campaignAddr)) throw new Error("尚未配置 Campaign 地址（请先部署）");
  // 读状态走公共节点。钱包自带的 BSC 节点（例如超额的 1rpc）会让整页读失败，看起来像工厂没有期次。
  return withReadProvider((runner) => readStateOn(runner, account, campaignAddr));
}

async function readStateOn(runner, account, campaignAddr) {
  const c = campaignContract(runner, campaignAddr);
  // 旧版已部署的 Campaign 没有 pooled / miningPool（这两个随矿池功能新增）。
  // Promise.all 里任何一项 revert 都会让整次读链失败、页面报「链上读取失败」，
  // 所以新增 getter 一律用 withDefault 降级，缺失时按「未入池」处理。
  const withDefault = (p, fallback) => p.catch(() => fallback);
  /**
   * `sold` 单独先取一次（不放在下面的解构数组里）。
   *
   * ⚠️ 旧期次合约没有 `outstandingShares` getter，需要拿 `sold` 当降级值。
   * 但如果写成 `withDefault(c.outstandingShares ? c.outstandingShares() : Promise.resolve(sold), sold)`，
   * 那个 `sold` 指的是**下面解构出来的 const** —— 解构赋值完成前它处于暂时性死区，
   * 于是每次链上读取都抛 `Cannot access 'sold' before initialization`，整页读链失败。
   * （vite build 抓不到，只有运行时才暴露。）
   *
   * 所以这里先建 promise，数组里与降级分支共用同一个。
   */
  const soldPromise = c.sold();
  const [
    scene, phase, sold, totalShares, sharePriceBnb, estHashpower,
    nandQty, latchQty, priceLock, soldOutAt, executionFailed, raisedBnb, totalRefunded,
    fundingDeadline, transistorsAddr, marketAddr, factoryAddr, owner, pooled, miningPool,
    listingCount, totalPendingSurplus, orderFilled,
    outstandingShares, serviceFeeBps, serviceFeeSet, feeRecipientCount,
    revenuePool, surplusPool,
  ] = await Promise.all([
    c.scene(), c.phase(), soldPromise, c.totalShares(), c.sharePriceBnb(),
    withDefault(c.estHashpower(), 0n),
    withDefault(c.nandQty(), 0n), withDefault(c.latchQty(), 0n),
    withDefault(c.priceLock(), 0n),
    withDefault(c.soldOutAt(), 0n),
    withDefault(c.executionFailed(), false),
    c.raisedBnb(),
    withDefault(c.totalRefunded(), 0n),
    c.fundingDeadline(), c.transistors(), readMaterialMarket(c), c.factory(),
    c.owner(),
    withDefault(c.pooled(), false),
    withDefault(c.miningPool(), ZeroAddress),
    withDefault(c.listingCount(), 0n),
    withDefault(c.totalPendingSurplus ? c.totalPendingSurplus() : Promise.resolve(0n), 0n),
    withDefault(c.orderFilled(), false),
    // 旧期次合约没有这些 getter → 降级。
    // 注意降级值用 soldPromise（不是解构出来的 sold —— 那是暂时性死区）。
    withDefault(c.outstandingShares ? c.outstandingShares() : soldPromise, 0n),
    withDefault(c.serviceFeeBps ? c.serviceFeeBps() : Promise.resolve(0), 0),
    withDefault(c.serviceFeeSet ? c.serviceFeeSet() : Promise.resolve(false), false),
    withDefault(c.feeRecipientCount ? c.feeRecipientCount() : Promise.resolve(0n), 0n),
    withDefault(c.revenuePool ? c.revenuePool() : Promise.resolve(0n), 0n),
    withDefault(c.surplusPool ? c.surplusPool() : Promise.resolve(0n), 0n),
  ]);
  const order = await readMarketOrder(c);

  const n = Number(listingCount);
  // 逐条降级：单条挂单读失败不应让整期状态读不出来。
  const rawListings = n > 0
    ? await Promise.all(
        Array.from({ length: n }, (_, i) => c.getListing(i).catch(() => null)),
      )
    : [];
  const listings = rawListings
    .map((l, i) => l && ({
      id: i,
      seller: l.seller,
      shares: l.shares,
      priceBnbPerShare: l.priceBnbPerShare,
      open: l.open,
    }))
    .filter(Boolean);

  // 服务费分成表：读链上（口径：服务费真正上链，不再是前端本地记录）。
  // 旧期次合约没有这些 getter → 空表。
  const feeShares = [];
  {
    const fn = Number(feeRecipientCount);
    for (let i = 0; i < fn; i++) {
      const [addr, bps] = await Promise.all([
        c.feeRecipientAt(i).catch(() => null),
        c.feeSharesBpsAt(i).catch(() => null),
      ]);
      if (!addr || !bps) continue;
      feeShares.push({ address: addr, sharePercent: Number(bps) / 100 });
    }
  }

  // 新逻辑：markFailed 打开持有人退款逃生口；executing+buying 且池子不足以按原价兑付时也可退款。
  const markFailedAt = Number(soldOutAt) > 0
    ? (Number(soldOutAt) + FAIL_GRACE_SECONDS) * 1000
    : null;
  const refundShort = Number(scene) === 1
    && Number(phase) === 1
    && raisedBnb < outstandingShares * sharePriceBnb;
  // 工厂已移除该期时，cancelTransistorOrder 允许任何人撤剩余单（工厂合约里的 _retired 口径）。
  let retired = false;
  try {
    if (factoryAddr && factoryAddr !== ZeroAddress) {
      retired = !(await factoryContract(runner, factoryAddr).isRegistered(campaignAddr));
    }
  } catch {
    /* 旧期次没有 factory() */
  }

  const state = {
    campaign: campaignAddr,
    scene: Number(scene), phase: Number(phase),
    sold, totalShares, sharePriceBnb,
    /**
     * 服务费**真正上链**了：费率与分成表都存在链上，任何人可读。
     * 之前这里是写死的 0（口径：合约里没有 fee 字段），现在读链上。
     */
    feePercent: Number(serviceFeeBps) / 100,
    feeBps: Number(serviceFeeBps),
    serviceFeeBps: Number(serviceFeeBps),
    serviceFeeSet: Boolean(serviceFeeSet),
    hashpower: 0n, estHashpower, dailyBem: 0n, harvestCount: 0,
    totalDistributed: 0n, totalFeeCollected: 0n, totalClaimed: 0n,
    totalRefunded, totalPendingSurplus, raisedBnb, netlistHash: null,
    soldOutAt: Number(soldOutAt), executionFailed, priceLock,
    /** 元件数不是链上参数：由实际下单的 NAND + LATCH 数量现算 */
    transistorCount: Number(nandQty) + Number(latchQty), capped: false,
    owner, fundingDeadline: Number(fundingDeadline),
    minter: marketAddr, listings,
    ...order,
    pooled, miningPool,
    // 开期即写入的元件合约优先；挂单后的 market 字段若为空也不要盖掉
    transistors: order.transistors && order.transistors !== ZeroAddress ? order.transistors : transistorsAddr,
    feeRecipient: "",
    market: marketAddr,
    markFailedAt,
    refundShort,
    /**
     * sold 是单调的历史事实（本期卖出去过多少），退款不会让它变小；
     * outstandingShares 是当前债务（已售未退）——「已售 X/Y」和退款分母都用它。
     */
    outstandingShares,
    /** 入池后未发出去的余款池：surplusPool 是分子，surplusBase 是分母。 */
    surplusPool,
    revenuePool,
    refundRatio: refundShort && outstandingShares > 0n
      ? Number(formatEther(raisedBnb)) / Number(outstandingShares)
      : null,
    retired,
    readyExit: (await runner.getCode(campaignAddr)).toLowerCase().includes(id("confirmSale()").slice(2, 10)),
    feeShares,
    netWeightVerified: 0, netWeightUnverified: 0,
    account: account || null,
  };

  if (account) {
    const [shares, escrow, refunded, bnbBal, pendingSurplus, surplusOfRaw] = await Promise.all([
      c.sharesOf(account), c.escrowOf(account),
      c.refundedOf(account), runner.getBalance(account),
      // 旧期次合约没有这个 getter → 按 0 处理。
      c.pendingSurplus ? c.pendingSurplus(account).catch(() => 0n) : Promise.resolve(0n),
      // 入池后的余款改 pull 模式：surplusOf 会把「还没计提但已可领」的部分也算进来。
      c.surplusOf ? c.surplusOf(account).catch(() => 0n) : Promise.resolve(0n),
    ]);
    /**
     * 可领余款 = max(surplusOf, pendingSurplus)。
     *
     * 旧期次合约没有 surplusOf（调用 revert → 0n），但有 pendingSurplus；
     * 新期次 surplusOf ≥ pendingSurplus（它把未计提部分也算进去）。
     * 所以取两者较大值，两种期次都能正确显示，且不会出现「旧期次显示 0」的漏账。
     */
    const claimableSurplus = surplusOfRaw > pendingSurplus ? surplusOfRaw : pendingSurplus;
    state.self = {
      shares, escrow, claimed: 0n, refunded, pending: 0n, bemBalance: 0n, bnb: bnbBal,
      /**
       * 待领余款（wei）。C-4 之后余款改 pull 模式：不再在入池时推给持有人，
       * 而是持份人自己调 claimSurplus() 领。claimableSurplus 含尚未计提的可领部分。
       */
      pendingSurplus,
      claimableSurplus,
    };
  }
  return state;
}

/** 份额转让的成交份数留在挂单剩余字段里，不扫 ListingTaken。认筹名单走 holderCount / 存储槽，不扫 Subscribed。 */

/** 链上只读某个视图（合约调用页用），返回人类可读字符串。 */
export async function liveReadView(method, args = {}, account = null, campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) throw new Error("未配置 Campaign");
  const state = await readState(account || args.account || null, campaignAddr);
  const SCENE = ["募集中", "待执行", "挖矿中"];
  switch (method) {
    case "status":
    case "scene":
      return SCENE[state.scene] || String(state.scene);
    case "phase":
    case "executePhase": {
      const PHASE = ["无", "待挂单", "挂单中", "已到账"];
      return PHASE[state.phase] || String(state.phase);
    }
    case "sold":
      return String(state.sold);
    case "outstandingShares":
      return String(state.outstandingShares);
    case "serviceFeeBps":
      return state.serviceFeeSet
        ? `${state.serviceFeeBps} bps（${state.serviceFeeBps / 100}%）`
        : "未设定";
    case "feeRecipientCount":
      return `${state.feeShares.length} 个收款地址`;
    case "revenuePool":
      return `${Number(formatEther(state.revenuePool || 0n)).toFixed(4)} BNB`;
    case "surplusOf": {
      const a = args.account || account;
      if (!a) return "请填地址";
      const c = campaignContract(getReadProvider(), campaignAddr);
      const v = c.surplusOf ? await c.surplusOf(a) : 0n;
      return `${Number(formatEther(v)).toFixed(4)} BNB`;
    }
    case "sharePriceBnb":
      return `${formatEther(state.sharePriceBnb)} BNB`;
    case "totalShares":
      return String(state.totalShares);
    case "hashpower":
      return Number(state.estHashpower) > 0
        ? `${Number(state.estHashpower).toLocaleString("zh-CN")} H（预估）`
        : "—";
    case "estHashpower":
      return `${Number(state.estHashpower).toLocaleString("zh-CN")} H`;
    case "totalRefunded":
      return `${Number(formatEther(state.totalRefunded)).toFixed(4)} BNB`;
    case "raisedBnb":
      return `${Number(formatEther(state.raisedBnb)).toFixed(4)} BNB`;
    case "transistors":
      return state.transistors || "—";
    case "market":
    case "materialMarket":
      return state.market || "—";
    case "marketOpenOrders":
      return readMarketBook(campaignAddr);
    case "marketBids":
      return withReadProvider((runner) => readMarketBidView(runner, campaignAddr, args.id || 1));
    case "marketAsks":
      return withReadProvider((runner) => readMarketAskView(runner, campaignAddr, args.id || 1));
    case "marketOwed":
      return withReadProvider((runner) => readMarketOwedView(runner, campaignAddr, args.account));
    case "executionFailed":
      return state.executionFailed ? "是（已判执行失败）" : "否";
    case "soldOutAt":
      return Number(state.soldOutAt) > 0
        ? new Date(Number(state.soldOutAt) * 1000).toLocaleString("zh-CN")
        : "—";
    case "priceLock":
      return Number(state.priceLock) > 0
        ? `${Number(formatEther(state.priceLock)).toFixed(4)} BNB（${state.transistorCount} 颗）`
        : "未锁价";
    case "holderCount":
      return `${await campaignContract(getReadProvider(), campaignAddr).holderCount()} 个地址`;
    case "sharesOf": {
      const a = args.account || account;
      if (!a) return "请填地址";
      const c = campaignContract(getReadProvider(), campaignAddr);
      return `${await c.sharesOf(a)} 份`;
    }
    default:
      return "";
  }
}

// 已部署的 Campaign 还没有 holderCount。_holders 在存储槽 30（链上长度读出来是 1，首个元素即认筹地址）。
const HOLDERS_SLOT = 30n;

async function readHolderAddresses(runner, c) {
  try {
    const n = Number(await c.holderCount());
    const out = [];
    for (let i = 0; i < n; i++) out.push(await c.holderAt(i));
    return out;
  } catch (err) {
    const text = String(err?.shortMessage || err?.message || "");
    // 旧字节码没有这两个视图，调用会 revert。改读同一条 _holders 数组，不扫日志。
    if (!/revert|CALL_EXCEPTION|could not decode/i.test(text)) throw err;
  }
  const len = BigInt(await runner.getStorage(c.target, HOLDERS_SLOT));
  if (len === 0n || len > 10000n) return [];
  const base = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint256"], [HOLDERS_SLOT])));
  const out = [];
  for (let i = 0n; i < len; i++) {
    const raw = await runner.getStorage(c.target, base + i);
    if (BigInt(raw) === 0n) continue;
    out.push(getAddress(`0x${raw.slice(-40)}`));
  }
  return out;
}

export async function readHolders(campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) return [];
  return withReadProvider(async (runner) => {
    const c = campaignContract(runner, campaignAddr);
    const addresses = await readHolderAddresses(runner, c);
    const out = [];
    for (const address of addresses) {
      const [shares, escrow] = await Promise.all([c.sharesOf(address), c.escrowOf(address)]);
      const total = shares + escrow;
      if (total > 0n) out.push({ address: address.toLowerCase(), shares: Number(total) });
    }
    out.sort((x, y) => y.shares - x.shares);
    return out;
  });
}

const POSITION_SCENE = ["funding", "executing", "mining"];
const POSITION_LABEL = ["募集中", "待执行", "挖矿中"];

/** 资产页：逐期读取公开状态，以及当前钱包在每一期的份数 / 可领 / 已退。addrs 为新→旧。 */
export async function readAccountAcrossCampaigns(account, addrs) {
  if (!addrs?.length) return [];
  const runner = getReadProvider();
  const rows = [];
  for (let i = 0; i < addrs.length; i++) {
    const address = addrs[i];
    const id = addrs.length - i;
    try {
      const c = campaignContract(runner, address);
      // 逐字段降级：旧期次可能缺个别 getter，缺一项不该让整行退化成「读取失败」。
      const zb = (pr, d) => pr.catch(() => d);
      const base = [
        zb(c.scene(), 0n),
        zb(c.sold(), 0n),
        zb(c.totalShares(), 0n),
        zb(c.sharePriceBnb(), 0n),
        zb(c.executionFailed(), false),
        zb(c.fundingDeadline(), 0n),
        zb(c.phase(), 1n),
        zb(c.raisedBnb(), 0n),
        // 已售未退（当前债务）。旧期次没有这个 getter → 退回 sold。
        zb(c.outstandingShares ? c.outstandingShares() : zb(c.sold(), 0n), 0n),
      ];
      if (account) {
        base.push(
          zb(c.sharesOf(account), 0n),
          zb(c.escrowOf(account), 0n),
          zb(c.refundedOf(account), 0n),
          /**
           * C-4：余款改 pull 模式 → 用 surplusOf（含未计提的可领部分）。
           * 旧期次没有 surplusOf（revert → 0n）但有 pendingSurplus，
           * 所以两个都读，取较大值 —— 否则旧期次明明有欠款却显示 0。
           */
          zb(
            c.surplusOf ? c.surplusOf(account) : Promise.resolve(0n),
            0n
          ),
          zb(
            c.pendingSurplus ? c.pendingSurplus(account) : Promise.resolve(0n),
            0n
          ),
        );
      }
      const res = await Promise.all(base);
      const soldOutAt = await c.soldOutAt().catch(() => 0n);
      const scene = Number(res[0]);
      const phaseN = Number(res[6]);
      rows.push({
        id,
        address,
        scene: POSITION_SCENE[scene] || "funding",
        sceneLabel: POSITION_LABEL[scene] || "—",
        phase: ["", "buying", "listed", "ready"][phaseN] || "buying",
        sold: Number(res[1]),
        outstandingShares: Number(res[8]),
        totalShares: Number(res[2]),
        sharePriceBnb: Number(formatEther(res[3])),
        executionFailed: Boolean(res[4]),
        fundingDeadline: Number(res[5]),
        raisedBnb: Number(formatEther(res[7])),
        soldOutAt: Number(soldOutAt),
        markFailedAt: Number(soldOutAt) > 0 ? (Number(soldOutAt) + FAIL_GRACE_SECONDS) * 1000 : null,
        shares: account ? Number(res[9]) : null,
        escrow: account ? Number(res[10]) : 0,
        refundedBnb: account ? Number(formatEther(res[11])) : 0,
        pendingSurplusBnb: account
          ? Number(formatEther(res[12] > res[13] ? res[12] : res[13]))
          : 0,
      });
    } catch {
      rows.push({
        id,
        address,
        scene: "",
        sceneLabel: "—",
        phase: "",
        sold: 0,
        totalShares: 0,
        sharePriceBnb: 0,
        executionFailed: false,
        fundingDeadline: 0,
        soldOutAt: 0,
        markFailedAt: null,
        shares: account ? 0 : null,
        escrow: 0,
        refundedBnb: 0,
        pendingSurplusBnb: 0,
        raisedBnb: 0,
        error: true,
      });
    }
  }
  return rows;
}

/**
 * 读本期接的材料市场地址。
 * 新代码 getter 是 materialMarket()；旧工厂造出来的期次（主网期次 #0、测试网期次、
 * legacyFactories 里的期次）只有 market()。两个都试，新的优先，都失败回 ZeroAddress。
 */
async function readMaterialMarket(c) {
  try {
    const a = await c.materialMarket();
    if (isAddr(a) && a !== ZeroAddress) return a;
  } catch {
    /* 旧合约没有这个 getter，走 market() */
  }
  try {
    const a = await c.market();
    if (isAddr(a) && a !== ZeroAddress) return a;
  } catch {
    return ZeroAddress;
  }
  return ZeroAddress;
}

/** 新期次才有官方买单字段。旧合约调用会 revert，按「尚未对接市场」处理。 */
async function readMarketOrder(c) {
  const empty = {
    nandBidId: 0n, latchBidId: 0n, nandQty: 0n, latchQty: 0n,
    nandPrice: 0n, latchPrice: 0n, transistors: ZeroAddress, orderFilled: false, marketOrders: false,
    nandAskId: 0n, latchAskId: 0n, nandAskQty: 0n, latchAskQty: 0n,
    nandAskPrice: 0n, latchAskPrice: 0n, askOpen: false,
    nandAskRemaining: null, latchAskRemaining: null,
    partsNand: 0n, partsLatch: 0n, marketAsks: false,
  };
  try {
    const [nandBidId, latchBidId, nandQty, latchQty, nandPrice, latchPrice, transistors, orderFilled] = await Promise.all([
      c.nandBidId(), c.latchBidId(), c.nandQty(), c.latchQty(), c.nandPrice(), c.latchPrice(),
      c.transistors(), c.orderFilled(),
    ]);
    const marketAddr = await readMaterialMarket(c);
    const [nandRemaining, latchRemaining] = await Promise.all([
      readLegRemaining(c.runner, marketAddr, nandBidId, nandQty),
      readLegRemaining(c.runner, marketAddr, latchBidId, latchQty),
    ]);
    const asks = await readMarketAsk(c, marketAddr, transistors);
    return {
      nandBidId, latchBidId, nandQty, latchQty, nandPrice, latchPrice, transistors, orderFilled,
      marketOrders: true, nandRemaining, latchRemaining, ...asks,
    };
  } catch {
    return empty;
  }
}

async function readMarketAsk(c, marketAddr, transistors) {
  const blank = {
    nandAskId: 0n, latchAskId: 0n, nandAskQty: 0n, latchAskQty: 0n,
    nandAskPrice: 0n, latchAskPrice: 0n, askOpen: false,
    nandAskRemaining: null, latchAskRemaining: null,
    partsNand: 0n, partsLatch: 0n, marketAsks: false, marketOwed: 0n,
    marketAskSide: false,
  };
  try {
    const [nandAskId, latchAskId, nandAskQty, latchAskQty, nandAskPrice, latchAskPrice] = await Promise.all([
      c.nandAskId(), c.latchAskId(), c.nandAskQty(), c.latchAskQty(),
      c.nandAskPrice(), c.latchAskPrice(),
    ]);
    const holder = c.target;
    const [nandAskRemaining, latchAskRemaining, partsNand, partsLatch, marketOwed, hasAskSide] = await Promise.all([
      readAskRemaining(c.runner, marketAddr, nandAskId, nandAskQty),
      readAskRemaining(c.runner, marketAddr, latchAskId, latchAskQty),
      readPartBalance(c.runner, transistors, holder, 0),
      readPartBalance(c.runner, transistors, holder, 1),
      readMarketOwed(c.runner, marketAddr, holder),
      marketHasAskSide(c.runner, marketAddr),
    ]);
    const askOpen = (nandAskRemaining != null && nandAskRemaining > 0n)
      || (latchAskRemaining != null && latchAskRemaining > 0n)
      || ((nandAskQty > 0n || latchAskQty > 0n) && nandAskRemaining == null && latchAskRemaining == null);
    return {
      nandAskId, latchAskId, nandAskQty, latchAskQty, nandAskPrice, latchAskPrice, askOpen,
      nandAskRemaining, latchAskRemaining, partsNand, partsLatch, marketAsks: true, marketOwed,
      // 市场没有卖单侧 → 本期不能挂卖单（链上必然 revert），前端要挡住入口。
      marketAskSide: hasAskSide,
    };
  } catch {
    return blank;
  }
}

/**
 * 探测材料市场**到底有没有卖单侧**。
 *
 * 官方市场（主网 0xA6a8…16E4）经 eth_call 核实：只有买单侧
 * （placeBid / cancelBid / bids / fillBid(uint256,uint256) / owed / withdraw / nextBidId / feeBps），
 * placeAsk / asks / nextAskId / cancelAsk / fillAsk 全部不存在。
 * 合约的 placeTransistorAsk / cancelTransistorAsk / confirmSale 在主网上必然 revert。
 *
 * 判定方式：直接读市场合约字节码里有没有 placeAsk 的 4 字节 selector。
 * 比 try/call 更可靠——代理合约的 fallback 会让所有调用都 revert，无法区分「不存在」与「存在但报错」。
 */
async function marketHasAskSide(runner, marketAddr) {
  if (!marketAddr || marketAddr === ZeroAddress) return false;
  try {
    const code = (await runner.getCode(marketAddr)).toLowerCase();
    if (!code || code === "0x") return false;
    // placeAsk(address,uint96,address,uint8,uint256) —— 官方接口注释里记的签名
    const sel = id("placeAsk(address,uint96,address,uint8,uint256)").slice(2, 10);
    if (code.includes(sel)) return true;
    // 兜底：只要有 asks(uint256) 也算有卖单侧
    const selAsks = id("asks(uint256)").slice(2, 10);
    return code.includes(selAsks);
  } catch {
    return false;
  }
}

async function readPartBalance(runner, transistors, holder, tokenId) {  if (!transistors || transistors === ZeroAddress || !holder) return 0n;
  try {
    const token = new Contract(transistors, ["function balanceOf(address,uint256) view returns (uint256)"], runner);
    return await token.balanceOf(holder, tokenId);
  } catch {
    return 0n;
  }
}

async function readLegRemaining(runner, marketAddr, id, qty) {
  if (marketAddr == null) return null;
  if (marketAddr === ZeroAddress || id === 0n || qty === 0n) return 0n;
  try {
    const market = new Contract(marketAddr, [
      "function bids(uint256) view returns (address buyer, address transistors, uint96 price, uint8 tokenId, uint16 feeBps, uint256 remaining)",
    ], runner);
    const bid = await market.bids(id);
    return bid.remaining;
  } catch {
    return null;
  }
}

/** 卖单成交款先落在市场 owed，不提取的话 openRefund 会被合约拒绝。 */
async function readMarketOwed(runner, marketAddr, account) {
  if (!marketAddr || marketAddr === ZeroAddress || !account) return 0n;
  try {
    const market = new Contract(marketAddr, ["function owed(address) view returns (uint256)"], runner);
    return await market.owed(account);
  } catch {
    return 0n;
  }
}

async function readAskRemaining(runner, marketAddr, id, qty) {
  if (marketAddr == null) return null;
  if (marketAddr === ZeroAddress || id === 0n || qty === 0n) return 0n;
  try {
    const market = new Contract(marketAddr, [
      "function asks(uint256) view returns (address seller, uint96 price, address transistors, uint8 tokenId, uint256 remaining)",
    ], runner);
    const ask = await market.asks(id);
    return ask.remaining;
  } catch {
    return null;
  }
}

// ── 材料市场（Mock）调试：查看订单簿 + 模拟卖方/买方成交 ──
const TOKEN_LABEL = ["NAND", "LATCH"];
const shortAddr = (a) => (isAddr(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || "—"));

/** 本期合约接的材料市场，并确认它带 Mock 订单簿（nextBidId / bids）。 */
async function marketHandle(runner, campaignAddr = getCampaignAddress()) {
  const campaign = campaignContract(runner, campaignAddr);
  const marketAddr = await readMaterialMarket(campaign);
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) {
    throw new Error("本期合约没有配置材料市场（market 为 0）。");
  }
  const market = new Contract(marketAddr, MATERIAL_MARKET_ABI, runner);
  try {
    await market.nextBidId();
  } catch {
    throw new Error("这期接的材料市场没有 Mock 订单簿（nextBidId 调用失败），不能模拟撮合。");
  }
  return { campaign, market, marketAddr };
}

/** 列出市场里所有未成交的买单/卖单，供调试页直接看。 */
export async function readMarketBook(campaignAddr = getCampaignAddress()) {
  return withReadProvider(async (runner) => {
    const { market, marketAddr } = await marketHandle(runner, campaignAddr);
    const [nextBid, nextAsk] = await Promise.all([market.nextBidId(), market.nextAskId()]);
    const lines = [`市场 ${shortAddr(marketAddr)}`];
    let open = 0;
    for (let i = 1n; i < nextBid && i <= 500n; i++) {
      const b = await market.bids(i);
      if (b.remaining === 0n) continue;
      open += 1;
      lines.push(`买单 #${i} · ${TOKEN_LABEL[Number(b.tokenId)] || b.tokenId} 剩余 ${b.remaining} · 单价 ${formatEther(b.price)} BNB · 买家 ${shortAddr(b.buyer)}`);
    }
    for (let i = 1n; i < nextAsk && i <= 500n; i++) {
      const a = await market.asks(i);
      if (a.remaining === 0n) continue;
      open += 1;
      lines.push(`卖单 #${i} · ${TOKEN_LABEL[Number(a.tokenId)] || a.tokenId} 剩余 ${a.remaining} · 单价 ${formatEther(a.price)} BNB · 卖家 ${shortAddr(a.seller)}`);
    }
    if (open === 0) lines.push("订单簿没有未成交挂单");
    return lines.join("\n");
  });
}

async function readMarketBidView(runner, campaignAddr, id) {
  const { market } = await marketHandle(runner, campaignAddr);
  const bidId = parseUintField(id, "买单 ID");
  const b = await market.bids(bidId);
  return `买单 #${bidId} · ${TOKEN_LABEL[Number(b.tokenId)] || b.tokenId} · 买家 ${shortAddr(b.buyer)} · 单价 ${formatEther(b.price)} BNB · 剩余 ${b.remaining} · 手续费 ${b.feeBps} bps`;
}

async function readMarketAskView(runner, campaignAddr, id) {
  const { market } = await marketHandle(runner, campaignAddr);
  const askId = parseUintField(id, "卖单 ID");
  const a = await market.asks(askId);
  return `卖单 #${askId} · ${TOKEN_LABEL[Number(a.tokenId)] || a.tokenId} · 卖家 ${shortAddr(a.seller)} · 单价 ${formatEther(a.price)} BNB · 剩余 ${a.remaining}`;
}

async function readMarketOwedView(runner, campaignAddr, account) {
  const { market } = await marketHandle(runner, campaignAddr);
  return `${formatEther(await market.owed(account || campaignAddr))} BNB`;
}

// ── 待执行状态的材料市场成交记录 ──
const MARKET_LOG_WINDOWS = 6; // 首次读取回看 6 × 50k 块，约 3.5 天（BSC 3s 出块）
const MARKET_LOG_SPAN = 50_000;
const blockTimeCache = new Map();
/** 每个市场已扫到哪个块，避免每次刷新都重扫历史区间（旧版 Mock 没有任何事件）。 */
const marketScanCursor = new Map();

async function blockTime(runner, blockNumber) {
  if (blockTimeCache.has(blockNumber)) return blockTimeCache.get(blockNumber);
  try {
    const block = await runner.getBlock(blockNumber);
    const ts = block ? Number(block.timestamp) * 1000 : null;
    blockTimeCache.set(blockNumber, ts);
    return ts;
  } catch {
    blockTimeCache.set(blockNumber, null);
    return null;
  }
}

/**
 * 卖单结束时间：旧版材料市场没有事件，用历史区块读 asks(id).remaining，
 * 二分出 remaining 从 >0 变成 0 的区块，再取该区块时间戳。
 * 节点不支持历史状态时返回 null（前端不显示时间）。结果按「市场|订单号」缓存。
 */
const askSettleCache = new Map();
const ASK_TIME_KEY = "tapeout.askSettleTimes.v1";

function readAskTimeStore() {
  if (typeof localStorage === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(ASK_TIME_KEY) || "{}") || {}; } catch { return {}; }
}
function writeAskTime(cacheKey, ts) {
  try {
    const all = readAskTimeStore();
    all[cacheKey] = ts;
    localStorage.setItem(ASK_TIME_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式或配额满：只保留内存缓存 */
  }
}

async function askSettledAt(runner, market, askId, fromBlock, latest) {
  if (fromBlock == null || latest == null || latest <= fromBlock) return null;
  const key = `${String(market.target).toLowerCase()}|${askId}`;
  if (askSettleCache.has(key)) return askSettleCache.get(key);
  const stored = readAskTimeStore()[key];
  if (stored) {
    askSettleCache.set(key, { ts: stored });
    return { ts: stored };
  }
  try {
    const remainingAt = async (bn) => Number((await market.asks(askId, { blockTag: bn })).remaining);
    if ((await remainingAt(latest)) !== 0 || (await remainingAt(fromBlock)) === 0) {
      askSettleCache.set(key, null);
      return null;
    }
    // 先按指数步长试探结束区间，成交通常就在挂单后不久，能把二分范围缩小。
    let lo = fromBlock;
    let hi = latest;
    for (let step = 64; step <= 8192; step *= 2) {
      const probe = fromBlock + step;
      if (probe >= latest) break;
      if ((await remainingAt(probe)) === 0) { hi = probe; break; }
      lo = probe;
    }
    let guard = 0;
    while (lo + 1 < hi && guard < 24) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await remainingAt(mid)) === 0) hi = mid;
      else lo = mid;
      guard += 1;
    }
    const ts = await blockTime(runner, hi);
    if (ts == null) return null;
    writeAskTime(key, ts);
    askSettleCache.set(key, { ts });
    return { ts };
  } catch {
    return null;
  }
}

/** 卖单成交 / 撤回时间（渲染后补）。legs 需带 placedBlock；返回 { [orderId]: ts }。 */
export async function readAskSettleTimes(campaignAddr, legs) {
  if (!isAddr(campaignAddr) || !Array.isArray(legs) || !legs.length) return {};
  const asks = legs.filter((l) => l.side === "sell" && l.placedBlock && l.remaining === 0);
  if (!asks.length) return {};
  return withReadProvider(async (runner) => {
    const c = campaignContract(runner, campaignAddr);
    const marketAddr = await readMaterialMarket(c);
    if (!isAddr(marketAddr) || marketAddr === ZeroAddress) return {};
    const market = new Contract(marketAddr, MATERIAL_MARKET_ABI, runner);
    const latest = await runner.getBlockNumber().catch(() => null);
    if (!latest) return {};
    const out = {};
    await Promise.all(asks.map(async (leg) => {
      const hit = await askSettledAt(runner, market, leg.orderId, leg.placedBlock, latest);
      if (hit) out[String(leg.orderId)] = hit.ts;
    }));
    return out;
  });
}

/**
 * 挂单 / 撤单 / 到账时间：旧版材料市场合约没有事件，用本期合约自己的事件补时间。
 * 返回按区块升序的标记，调用方取各类别最近一条。节点失败返回 null（前端不显示时间）。
 * 结果按「本期 + 水位区块」存 localStorage：刷新页面只补新区块，不再重扫历史。
 */
const TRADE_MARKS_KEY = "tapeout.tradeMarks.v1";

function loadTradeMarksCache(campaignAddr) {
  if (typeof localStorage === "undefined") return null;
  try {
    const all = JSON.parse(localStorage.getItem(TRADE_MARKS_KEY) || "{}") || {};
    const hit = all[String(campaignAddr).toLowerCase()];
    if (!hit || !Number.isFinite(hit.lastBlock) || !Array.isArray(hit.rows)) return null;
    return hit;
  } catch {
    return null;
  }
}

function saveTradeMarksCache(campaignAddr, lastBlock, rows) {
  if (typeof localStorage === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(TRADE_MARKS_KEY) || "{}") || {};
    all[String(campaignAddr).toLowerCase()] = { lastBlock, rows };
    localStorage.setItem(TRADE_MARKS_KEY, JSON.stringify(all));
  } catch {
    /* 配额不足时只保留内存结果 */
  }
}

async function readTradeMarks(runner, campaignAddr, latest) {
  const iface = new Interface(CAMPAIGN_ABI);
  const names = [
    "TransistorOrderPlaced",
    "TransistorOrderCancelled",
    "TransistorAskPlaced",
    "TransistorAskCancelled",
    "TransistorsConfirmed",
  ];
  // topics 是「每个位置可选的取值集合」：五个事件都是 topic0，必须塞进同一个位置数组才是 OR。
  const hashes = [];
  for (const name of names) {
    let ev = null;
    try { ev = iface.getEvent(name); } catch { ev = null; }
    if (ev) hashes.push(ev.topicHash);
  }

  const cached = loadTradeMarksCache(campaignAddr);
  let raw;
  if (cached && cached.lastBlock >= latest) {
    return cached.rows;
  }
  if (cached) {
    // 只补水位之后的新块；节点拒绝时退回缓存里的历史（旧时间仍然正确）。
    const fresh = [];
    for (let from = cached.lastBlock + 1; from <= latest; from += 50_000) {
      try {
        const logs = await withTimeout(
          runner.getLogs({ address: campaignAddr, fromBlock: from, toBlock: Math.min(latest, from + 49_999), topics: [hashes] }),
          8_000,
          "getLogs",
        );
        fresh.push(...logs);
      } catch {
        return cached.rows;
      }
    }
    raw = fresh;
  } else {
    raw = await readCampaignLogs(runner, campaignAddr, latest, [hashes], "trade");
    if (!raw) return null;
  }
  const rows = cached ? [...cached.rows] : [];
  const seen = new Set(rows.map((r) => `${r.txHash}:${r.blockNumber}:${r.name}`));
  for (const log of raw) {
    let evt;
    try { evt = iface.parseLog(log); } catch { continue; }
    if (!evt || !names.includes(evt.name)) continue;
    const key = `${log.transactionHash}:${log.blockNumber}:${evt.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 带上参数：确认卖出 / 取消订单会清空 bid/ask 字段，历史只能靠事件里的订单号回放。
    const args = {};
    evt.fragment.inputs.forEach((input, i) => {
      const value = evt.args[i];
      args[input.name] = typeof value === "bigint" ? value.toString() : value;
    });
    rows.push({ name: evt.name, args, blockNumber: log.blockNumber, txHash: log.transactionHash, ts: null });
  }
  const missing = rows.filter((r) => r.ts == null);
  const blocks = [...new Set(missing.map((r) => r.blockNumber))];
  const times = await Promise.all(blocks.map((bn) => blockTime(runner, bn)));
  const byBlock = new Map(blocks.map((bn, i) => [bn, times[i]]));
  for (const row of missing) row.ts = byBlock.get(row.blockNumber) ?? null;
  rows.sort((a, b) => a.blockNumber - b.blockNumber);
  saveTradeMarksCache(campaignAddr, latest, rows);
  return rows;
}

/** 取某类标记最近一条（整个对象，含 blockNumber），没有则 null。 */
function lastMark(marks, name) {
  if (!Array.isArray(marks)) return null;
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].name === name) return marks[i];
  }
  return null;
}

/** 读取当前市场合约的事件日志。旧版 Mock 没有事件，返回 null 让调用方退回状态推导。 */
const NO_EVENT_MARKET_KEY = "tapeout.marketNoEvents.v1";

/** 已知「没有事件」的市场：TTL 内连最新窗口都不探，过期后再探一次最新窗口。 */
const NO_EVENT_TTL_MS = 10 * 60 * 1000;

function marketHasNoEvents(addr) {
  if (typeof localStorage === "undefined") return false;
  try {
    const all = JSON.parse(localStorage.getItem(NO_EVENT_MARKET_KEY) || "{}") || {};
    const at = all[String(addr).toLowerCase()];
    return Boolean(at) && Date.now() - Number(at) < NO_EVENT_TTL_MS;
  } catch {
    return false;
  }
}

function markMarketNoEvents(addr) {
  if (typeof localStorage === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(NO_EVENT_MARKET_KEY) || "{}") || {};
    all[String(addr).toLowerCase()] = Date.now();
    localStorage.setItem(NO_EVENT_MARKET_KEY, JSON.stringify(all));
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

function clearMarketNoEvents(addr) {
  if (typeof localStorage === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(NO_EVENT_MARKET_KEY) || "{}") || {};
    if (all[String(addr).toLowerCase()]) {
      delete all[String(addr).toLowerCase()];
      localStorage.setItem(NO_EVENT_MARKET_KEY, JSON.stringify(all));
    }
  } catch {
    /* 忽略 */
  }
}

async function readMarketLogs(runner, marketAddr, campaignAddr) {
  const iface = new Interface(MATERIAL_MARKET_ABI);
  const cacheKey = String(marketAddr).toLowerCase();
  // 已知没有事件的市场：TTL 内直接跳过，过期后再探最新一个窗口。
  const knownNoEvents = marketHasNoEvents(marketAddr);
  if (knownNoEvents) return [];
  let latest;
  try {
    latest = await runner.getBlockNumber();
  } catch {
    return null;
  }

  // 首次回看固定窗口；之后只扫上次水位之后的新块，并把历史日志留在缓存里。
  const cursor = marketScanCursor.get(cacheKey);
  const ranges = [];
  if (cursor == null) {
    const windows = knownNoEvents ? 1 : MARKET_LOG_WINDOWS;
    for (let i = 0; i < windows; i++) {
      const toBlock = latest - i * MARKET_LOG_SPAN;
      const fromBlock = Math.max(0, toBlock - MARKET_LOG_SPAN + 1);
      if (toBlock > 0) ranges.push([fromBlock, toBlock]);
    }
  } else if (cursor.lastBlock < latest) {
    for (let from = cursor.lastBlock + 1; from <= latest; from += MARKET_LOG_SPAN) {
      ranges.push([from, Math.min(latest, from + MARKET_LOG_SPAN - 1)]);
    }
  }

  const raw = cursor ? [...cursor.logs] : [];
  for (const [fromBlock, toBlock] of ranges) {
    try {
      const logs = await withTimeout(
        runner.getLogs({ address: marketAddr, fromBlock, toBlock }),
        8_000,
        "getLogs",
      );
      raw.push(...logs);
    } catch {
      // 节点限制区间：首次探测失败就当旧版市场（没有事件）；增量失败下次再补。
      if (cursor == null && raw.length === 0) return null;
      return raw;
    }
  }
  marketScanCursor.set(cacheKey, { lastBlock: cursor ? Math.max(cursor.lastBlock, latest) : latest, logs: raw });
  // 扫完整个回看区间仍然一条事件都没有：记下「没有事件」，之后每次只探最新窗口。
  if (!raw.length && cursor == null) {
    if (!knownNoEvents) markMarketNoEvents(marketAddr);
    return [];
  }
  if (!raw.length) return [];
  if (knownNoEvents) clearMarketNoEvents(marketAddr);

  const me = String(campaignAddr).toLowerCase();
  const parsed = [];
  for (const log of raw) {
    let evt;
    try {
      evt = iface.parseLog(log);
    } catch {
      continue;
    }
    if (!evt) continue;
    parsed.push({ ...evt, hash: log.transactionHash, blockNumber: log.blockNumber });
  }

  // 先认领属于本期的订单号，再按订单号筛事件。
  const bidIds = new Set();
  const askIds = new Set();
  const bidMeta = new Map();
  const askMeta = new Map();
  for (const e of parsed) {
    if (e.name === "BidPlaced" && String(e.args.buyer).toLowerCase() === me) {
      bidIds.add(String(e.args.id));
      bidMeta.set(String(e.args.id), { price: e.args.price, part: TOKEN_LABEL[Number(e.args.tokenId)] || String(e.args.tokenId) });
    }
    if (e.name === "AskPlaced" && String(e.args.seller).toLowerCase() === me) {
      askIds.add(String(e.args.id));
      askMeta.set(String(e.args.id), { price: e.args.price, part: TOKEN_LABEL[Number(e.args.tokenId)] || String(e.args.tokenId) });
    }
  }

  const rows = [];
  const needsTime = [];
  for (const e of parsed) {
    const id = e.args?.id != null ? String(e.args.id) : "";
    const isBid = e.name.startsWith("Bid");
    const isAsk = e.name.startsWith("Ask");
    if (isBid && !bidIds.has(id)) continue;
    if (isAsk && !askIds.has(id)) continue;
    if (e.name === "ProceedsWithdrawn" && String(e.args.account).toLowerCase() !== me) continue;
    let row;
    if (e.name === "BidPlaced") {
      row = { kind: "place", side: "buy", id, qty: e.args.quantity, price: e.args.price, amount: null, part: TOKEN_LABEL[Number(e.args.tokenId)] || String(e.args.tokenId) };
    } else if (e.name === "BidFilled") {
      const meta = bidMeta.get(id) || {};
      row = { kind: "fill", side: "buy", id, qty: e.args.quantity, remaining: e.args.remaining, price: meta.price ?? null, part: meta.part || "—", amount: null };
    } else if (e.name === "BidCancelled") {
      row = { kind: "cancel", side: "buy", id, amount: e.args.refund };
    } else if (e.name === "AskPlaced") {
      row = { kind: "place", side: "sell", id, qty: e.args.quantity, price: e.args.price, amount: null, part: TOKEN_LABEL[Number(e.args.tokenId)] || String(e.args.tokenId) };
    } else if (e.name === "AskFilled") {
      const meta = askMeta.get(id) || {};
      row = { kind: "fill", side: "sell", id, qty: e.args.quantity, amount: e.args.paid, price: meta.price ?? null, part: meta.part || "—" };
    } else if (e.name === "AskCancelled") {
      row = { kind: "cancel", side: "sell", id, qty: e.args.quantity, amount: null };
    } else if (e.name === "ProceedsWithdrawn") {
      row = { kind: "withdraw", side: "sell", id: "", amount: e.args.amount };
    } else {
      continue;
    }
    rows.push({ ...row, txHash: e.hash, blockNumber: e.blockNumber, ts: null });
    needsTime.push(rows[rows.length - 1]);
  }

  const times = await Promise.all([...new Set(needsTime.map((r) => r.blockNumber))].map((bn) => blockTime(runner, bn)));
  const byBlock = new Map([...new Set(needsTime.map((r) => r.blockNumber))].map((bn, i) => [bn, times[i]]));
  for (const row of rows) row.ts = byBlock.get(row.blockNumber) ?? null;
  return rows.sort((a, b) => (a.blockNumber - b.blockNumber) || String(a.kind).localeCompare(String(b.kind)));
}

function legStatus(side, qty, remaining) {
  if (qty <= 0) return "empty";
  if (remaining == null) return "open";
  if (remaining > 0) return remaining < qty ? "partial" : "open";
  return "filled";
}

/** 卖单 remaining 归零后，靠「元件是否已回到本期」区分成交与撤回。 */
function settleAskStatus(leg, owed, partsHeld) {
  if (leg.remaining == null || leg.remaining > 0) return leg.status;
  if (owed > 0) return "filled";
  if (leg.orderQty == null) return "settled";
  if (partsHeld >= leg.orderQty) return "cancelled";
  return "settled";
}

/**
 * 待执行状态的材料市场成交记录：本期买单/卖单 + 成交进度 + 市场欠款。
 * 新版 Mock 有事件时同时返回链上流水；旧版无事件时退回按 bids/asks/owed 推导。
 */
export async function readMarketTrades(campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) return null;
  // 同一页可能同时挂大卡片和 Owner 侧栏两个面板：共用一次读取，别把请求翻倍。
  const key = String(campaignAddr).toLowerCase();
  if (marketTradesInflight.has(key)) return marketTradesInflight.get(key);
  const task = readMarketTradesOnce(campaignAddr).finally(() => {
    setTimeout(() => marketTradesInflight.delete(key), 0);
  });
  marketTradesInflight.set(key, task);
  return task;
}

const marketTradesInflight = new Map();

async function readMarketTradesOnce(campaignAddr) {
  return withReadProvider(async (runner) => {
    const c = campaignContract(runner, campaignAddr);
    const marketAddr = await readMaterialMarket(c);
    if (!isAddr(marketAddr) || marketAddr === ZeroAddress) return null;
    const market = new Contract(marketAddr, MATERIAL_MARKET_ABI, runner);

    const [
      nandBidId, latchBidId, nandQty, latchQty, nandPrice, latchPrice,
      nandAskId, latchAskId, nandAskQty, latchAskQty, nandAskPrice, latchAskPrice,
      transistors, ordered,
    ] = await Promise.all([
      c.nandBidId().catch(() => 0n), c.latchBidId().catch(() => 0n),
      c.nandQty().catch(() => 0n), c.latchQty().catch(() => 0n),
      c.nandPrice().catch(() => 0n), c.latchPrice().catch(() => 0n),
      c.nandAskId().catch(() => 0n), c.latchAskId().catch(() => 0n),
      c.nandAskQty().catch(() => 0n), c.latchAskQty().catch(() => 0n),
      c.nandAskPrice().catch(() => 0n), c.latchAskPrice().catch(() => 0n),
      c.transistors().catch(() => ZeroAddress),
      c.orderFilled().catch(() => false),
    ]);

    let owed = 0n;
    try {
      owed = await market.owed(campaignAddr);
    } catch {
      owed = 0n;
    }

    const legs = [];
    const bidLegs = [
      { part: "NAND", id: nandBidId, qty: nandQty, price: nandPrice },
      { part: "LATCH", id: latchBidId, qty: latchQty, price: latchPrice },
    ];
    for (const leg of bidLegs) {
      if (leg.id === 0n || leg.qty === 0n) continue;
      const bid = await market.bids(leg.id).catch(() => null);
      const remaining = bid ? Number(bid.remaining) : null;
      const filled = remaining == null ? null : Math.max(0, Number(leg.qty) - remaining);
      legs.push({
        side: "buy",
        part: leg.part,
        orderId: String(leg.id),
        orderQty: Number(leg.qty),
        price: formatEther(leg.price),
        filled,
        remaining,
        amount: filled == null ? null : formatEther(BigInt(filled) * leg.price),
        status: legStatus("buy", Number(leg.qty), remaining),
        live: true,
      });
    }

    let partsNand = 0;
    let partsLatch = 0;
    if (isAddr(transistors) && transistors !== ZeroAddress) {
      try {
        const token = new Contract(transistors, [
          "function balanceOf(address,uint256) view returns (uint256)",
        ], runner);
        const [n, l] = await Promise.all([token.balanceOf(campaignAddr, 0), token.balanceOf(campaignAddr, 1)]);
        partsNand = Number(n);
        partsLatch = Number(l);
      } catch {
        /* 元件合约不可读时按 0 处理 */
      }
    }

    const events = await readMarketLogs(runner, marketAddr, campaignAddr).catch(() => null);

    // 市场合约没有事件时，挂单/撤单/到账时间从本期合约自己的事件补。
    let marks = null;
    if (!Array.isArray(events) || events.length === 0) {
      try {
        const latest = await runner.getBlockNumber();
        marks = await readTradeMarks(runner, campaignAddr, latest);
      } catch {
        marks = null;
      }
    }
    const bidPlaced = lastMark(marks, "TransistorOrderPlaced");
    const bidCancel = lastMark(marks, "TransistorOrderCancelled");
    const askPlaced = lastMark(marks, "TransistorAskPlaced");
    const askCancel = lastMark(marks, "TransistorAskCancelled");
    const confirmed = lastMark(marks, "TransistorsConfirmed");

    // 卖单历史：confirmSale / cancelTransistorAsk 会把 nandAskId / nandAskQty 清零，
    // Mock 材料市场又没有事件，所以用本期合约的「挂卖」事件回放订单号与数量，
    // 价格 / 剩余量仍以材料市场 asks(id) 为准。
    const askHistory = new Map();
    const askPlacedEvents = [];
    const askCancelBlocks = [];
    if (Array.isArray(marks)) {
      for (const m of marks) {
        if (m.name === "TransistorAskPlaced") askPlacedEvents.push(m);
        else if (m.name === "TransistorAskCancelled") askCancelBlocks.push(m.blockNumber);
      }
    }
    askPlacedEvents.sort((a, b) => a.blockNumber - b.blockNumber);
    for (let i = 0; i < askPlacedEvents.length; i++) {
      const m = askPlacedEvents[i];
      const boundary = i + 1 < askPlacedEvents.length ? askPlacedEvents[i + 1].blockNumber : Infinity;
      const cancelled = askCancelBlocks.some((bn) => bn > m.blockNumber && bn < boundary);
      const placedLegs = [
        { id: Number(m.args?.nandAskId || 0), qty: Number(m.args?.nandQty || 0), part: "NAND" },
        { id: Number(m.args?.latchAskId || 0), qty: Number(m.args?.latchQty || 0), part: "LATCH" },
      ];
      for (const p of placedLegs) {
        if (!(p.id > 0)) continue;
        askHistory.set(String(p.id), {
          part: p.part,
          qty: p.qty > 0 ? p.qty : null,
          placedAt: m.ts ?? null,
          placedBlock: m.blockNumber,
          cancelled,
        });
      }
    }
    // 事件读不到时，至少按订单簿把「本期挂过、已结束」的卖单捞回来（数量未知）。
    // 顺手把读到的 asks(id) 存下来，后面拼卖单腿时不再重复请求。
    const askStructs = new Map();
    let nextAskId = null;
    try { nextAskId = Number(await market.nextAskId()); } catch { nextAskId = null; }
    if (nextAskId != null && nextAskId > 1) {
      const ids = [];
      for (let i = 1; i < nextAskId; i++) ids.push(i);
      const rows = await Promise.all(ids.map((i) => market.asks(i).catch(() => null)));
      rows.forEach((a, index) => {
        if (!a) return;
        const id = String(index + 1);
        askStructs.set(id, a);
        if (askHistory.has(id)) return;
        if (String(a.seller).toLowerCase() !== String(campaignAddr).toLowerCase()) return;
        askHistory.set(id, {
          part: TOKEN_LABEL[Number(a.tokenId)] || String(a.tokenId),
          qty: null,
          placedAt: null,
          placedBlock: null,
          cancelled: false,
        });
      });
    }

    const liveSell = new Map();
    for (const leg of [
      { part: "NAND", id: nandAskId, qty: nandAskQty, price: nandAskPrice },
      { part: "LATCH", id: latchAskId, qty: latchAskQty, price: latchAskPrice },
    ]) {
      if (leg.id === 0n || leg.qty === 0n) continue;
      liveSell.set(String(leg.id), { part: leg.part, qty: Number(leg.qty), priceWei: leg.price });
    }

    for (const id of new Set([...liveSell.keys(), ...askHistory.keys()])) {
      const live = liveSell.get(id);
      const hist = askHistory.get(id);
      const ask = askStructs.get(id) || await market.asks(id).catch(() => null);
      askStructs.set(id, ask);
      if (!ask && !live) continue;
      const priceWei = ask && ask.price != null ? ask.price : live?.priceWei ?? null;
      const qty = live?.qty ?? hist?.qty ?? null;
      const remaining = ask ? Number(ask.remaining) : null;
      const part = ask
        ? (TOKEN_LABEL[Number(ask.tokenId)] || live?.part || hist?.part || "—")
        : (live?.part || hist?.part || "—");
      const filled = remaining == null || qty == null ? null : Math.max(0, qty - remaining);
      let status;
      if (remaining == null) status = "open";
      else if (remaining > 0) status = qty != null && remaining < qty ? "partial" : "open";
      else if (hist?.cancelled) status = "cancelled";
      else status = live && owed > 0 ? "filled" : "settled";
      legs.push({
        side: "sell",
        part,
        orderId: id,
        orderQty: qty,
        price: priceWei == null ? null : formatEther(priceWei),
        filled,
        remaining,
        amount: filled == null || priceWei == null ? null : formatEther(BigInt(filled) * priceWei),
        status,
        live: Boolean(live),
        placedAt: live ? null : hist?.placedAt ?? null,
        cancelAt: null,
        confirmedAt: null,
      });
    }

    for (const leg of legs) {
      if (leg.side === "buy") {
        leg.placedAt = bidPlaced?.ts ?? null;
        leg.cancelAt = bidCancel && bidPlaced && bidCancel.blockNumber >= bidPlaced.blockNumber
          ? bidCancel.ts ?? null
          : null;
        // 只有确认发生在本次挂单之后，才算这一单到账，避免把上一轮的时间贴到新单上。
        leg.confirmedAt = confirmed && bidPlaced && confirmed.blockNumber >= bidPlaced.blockNumber
          ? confirmed.ts ?? null
          : null;
      } else if (leg.live) {
        leg.placedAt = askPlaced?.ts ?? null;
        leg.cancelAt = askCancel && askPlaced && askCancel.blockNumber >= askPlaced.blockNumber
          ? askCancel.ts ?? null
          : null;
        leg.confirmedAt = null;
      }
    }

    for (const leg of legs) {
      if (leg.side !== "sell" || !leg.live) continue;
      leg.status = settleAskStatus(leg, owed, leg.part === "NAND" ? partsNand : partsLatch);
    }

    // 卖单成交 / 撤回时间要二分历史区块，比较慢：这里只挂 placedBlock，
    // 由 readAskSettleTimes 在渲染后补，避免整块记录等十几秒。
    for (const leg of legs) {
      if (leg.side !== "sell") continue;
      const hist = askHistory.get(String(leg.orderId));
      leg.placedBlock = hist?.placedBlock ?? null;
    }

    const buyLegs = legs.filter((l) => l.side === "buy");
    const sellLegs = legs.filter((l) => l.side === "sell");
    const sum = (rows, key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    const totals = {
      buyQty: sum(buyLegs, "orderQty"),
      buyFilled: sum(buyLegs, "filled"),
      buySpent: buyLegs.reduce((acc, r) => acc + (Number(r.amount) || 0), 0),
      sellQty: sum(sellLegs, "orderQty"),
      sellFilled: sum(sellLegs, "filled"),
      sellProceeds: sellLegs.reduce((acc, r) => acc + (Number(r.amount) || 0), 0),
      owed: Number(formatEther(owed)),
      partsNand,
      partsLatch,
    };

    return {
      market: marketAddr,
      isMock: Boolean(deployments.materialMarket || deployments.minter)
        && String(deployments.materialMarket || deployments.minter).toLowerCase() === String(marketAddr).toLowerCase(),
      orderFilled: Boolean(ordered),
      legs,
      totals,
      events,
      marks,
      supportsEvents: Array.isArray(events) && events.length > 0,
    };
  });
}

// ── 原路退款记录（Campaign.Refunded / RefundSendFailed） ──
const CAMPAIGN_LOG_SPAN = 50_000;
/** 回溯上限：约 34 天（BSC 3s 出块）。更老的期次只显示最近的明细，汇总仍走合约读数。 */
const CAMPAIGN_SCAN_MAX_BLOCKS = 1_000_000;
const campaignScanCache = new Map();

/** 公共节点偶尔不返回：给单次请求加上限，避免整块记录一直停在「读取中」。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label || "rpc"} timeout`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * 找扫描起点：从最新区块按 5 万块倍增回看，直到该区块还没有合约代码。
 * 比二分找创建区块省很多次 eth_getCode，起点略早于部署也无害（多扫几个空窗口）。
 */
async function scanStartBlock(runner, addr, latest) {
  const hasCode = async (bn) => {
    try {
      const code = await withTimeout(runner.getCode(addr, bn), 4_000, "getCode");
      return Boolean(code && code !== "0x");
    } catch {
      return null;
    }
  };
  if ((await hasCode(latest)) !== true) return null;
  for (let depth = CAMPAIGN_LOG_SPAN; depth <= CAMPAIGN_SCAN_MAX_BLOCKS; depth *= 2) {
    const bn = latest - depth;
    if (bn <= 0) return 0;
    const code = await hasCode(bn);
    // 节点不支持历史状态：退回最近 6 个窗口。
    if (code == null) return Math.max(0, latest - CAMPAIGN_LOG_SPAN * 6);
    if (code === false) return bn;
  }
  return Math.max(0, latest - CAMPAIGN_SCAN_MAX_BLOCKS);
}

/**
 * 扫这期合约的事件日志，只扫到创建区块，刷新时只补新区块。
 * 节点不给历史状态时退回最近 6 个窗口（约 3.5 天）。
 */
async function readCampaignLogs(runner, campaignAddr, latest, topics, kind = "refund") {
  // 同一期可能按不同事件组各扫一遍（退款 / 挂单时间），缓存必须按用途分开，否则会互相污染。
  const key = `${String(campaignAddr).toLowerCase()}|${kind}`;
  const cached = campaignScanCache.get(key);
  let start = cached ? cached.start : null;
  if (start == null) {
    start = await scanStartBlock(runner, campaignAddr, latest);
    if (start == null) start = Math.max(0, latest - CAMPAIGN_LOG_SPAN * 6);
  }
  const raw = cached ? [...cached.logs] : [];
  let lastBlock = cached ? cached.lastBlock : start - 1;
  const deadline = Date.now() + 20_000;
  let partial = false;
  for (let from = lastBlock + 1; from <= latest; from += CAMPAIGN_LOG_SPAN) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const toBlock = Math.min(latest, from + CAMPAIGN_LOG_SPAN - 1);
    try {
      const logs = await withTimeout(
        runner.getLogs({ address: campaignAddr, fromBlock: from, toBlock, topics }),
        8_000,
        "getLogs",
      );
      raw.push(...logs);
      lastBlock = toBlock;
    } catch {
      // 首次就失败：当作节点不支持事件查询，调用方退回状态展示。
      if (!cached && raw.length === 0) return null;
      partial = true;
      break;
    }
  }
  campaignScanCache.set(key, { start, lastBlock: partial ? lastBlock : latest, logs: raw });
  return raw;
}

/**
 * 原路退款记录：本期 Refunded 事件（谁、退了多少、时间、tx）+ 汇总。
 * 合约剩余池与累计已退从链上读，不信任列表里的缓存。
 */
export async function readRefundRecords(campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) return null;
  return withReadProvider(async (runner) => {
    const c = campaignContract(runner, campaignAddr);
    const iface = new Interface(CAMPAIGN_ABI);
    let latest;
    try {
      latest = await runner.getBlockNumber();
    } catch {
      return null;
    }

    const [raw, totalRefunded, raisedBnb, sold, executionFailed] = await Promise.all([
      readCampaignLogs(runner, campaignAddr, latest, [[
        iface.getEvent("Refunded").topicHash,
        iface.getEvent("RefundSendFailed").topicHash,
      ]]).catch(() => null),
      c.totalRefunded().catch(() => 0n),
      c.raisedBnb().catch(() => 0n),
      c.sold().catch(() => 0n),
      c.executionFailed().catch(() => false),
    ]);

    const rows = [];
    for (const log of raw || []) {
      let evt;
      try {
        evt = iface.parseLog(log);
      } catch {
        continue;
      }
      if (!evt) continue;
      if (evt.name !== "Refunded" && evt.name !== "RefundSendFailed") continue;
      rows.push({
        holder: String(evt.args.holder),
        amount: Number(formatEther(evt.args.amountBnb)),
        failed: evt.name === "RefundSendFailed",
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        ts: null,
      });
    }

    const blocks = [...new Set(rows.map((r) => r.blockNumber))];
    const times = await Promise.all(blocks.map((bn) => blockTime(runner, bn)));
    const byBlock = new Map(blocks.map((bn, i) => [bn, times[i]]));
    for (const row of rows) row.ts = byBlock.get(row.blockNumber) ?? null;
    rows.sort((a, b) => b.blockNumber - a.blockNumber);

    const holders = new Set(rows.filter((r) => !r.failed).map((r) => r.holder.toLowerCase()));
    return {
      campaign: campaignAddr,
      events: rows,
      totals: {
        totalRefunded: Number(formatEther(totalRefunded)),
        pool: Number(formatEther(raisedBnb)),
        sold: Number(sold),
        count: rows.filter((r) => !r.failed).length,
        holders: holders.size,
        failed: rows.filter((r) => r.failed).length,
        executionFailed: Boolean(executionFailed),
        listedSum: rows.reduce((acc, r) => acc + (r.failed ? 0 : r.amount), 0),
      },
      // null 表示扫不到日志（旧节点 / 旧合约），空数组表示确实还没有退款。
      scanned: Array.isArray(raw),
    };
  });
}


async function campaignsOf(factoryAddr) {
  return withReadProvider(async (provider) => {
    const f = factoryContract(provider, factoryAddr);
    const n = Number(await f.campaignCount());
    // Older factories also expose allCampaigns(); campaignCount + campaigns works on both and
    // avoids one deliberately failing eth_call on factories that dropped it.
    const out = await Promise.all(Array.from({ length: n }, (_, i) => f.campaigns(i)));
    return out.reverse();
  });
}

/** 列出当前工厂期次（新→旧）。旧工厂地址仅保留在 deployments.legacyFactories，不再并入主列表。 */
export async function listCampaigns() {
  if (!isAddr(FACTORY_ADDRESS)) return [];
  return campaignsOf(FACTORY_ADDRESS);
}

/** 读某期轻量摘要（历史列表用）。 */
export async function readCampaignSummary(address) {
  return withReadProvider((runner) => readCampaignSummaryOn(runner, address));
}

async function readCampaignSummaryOn(runner, address) {
  const c = campaignContract(runner, address);
  // 元件数权威来源 = nandQty + latchQty（成交到账的元件数）。
  // 合约**没有** transistorCount() 这个 getter——之前这里调它，
  // 整行 Promise.all 直接 reject，历史期次列表全军覆没（还被 useChain 的 catch
  // 兜底成「—」，页面不报错但数据全假）。
  // 每个可选 getter 单独 catch，单个缺失只降级那一个字段，不拖垮整行。
  const [scene, sold, totalShares, sharePriceBnb, estHashpower, raisedBnb, transistors] = await Promise.all([
    c.scene().then(Number).catch(() => 0),
    c.sold().then(Number).catch(() => 0),
    c.totalShares().then(Number).catch(() => 0),
    c.sharePriceBnb().then((v) => Number(formatEther(v))).catch(() => 0),
    c.estHashpower().then(Number).catch(() => 0),
    c.raisedBnb().then((v) => Number(formatEther(v))).catch(() => 0),
    c.transistors().catch(() => "0x0000000000000000000000000000000000000000"),
  ]);
  const nandQty = await c.nandQty().then(Number).catch(() => 0);
  const latchQty = await c.latchQty().then(Number).catch(() => 0);
  const transistorCount = nandQty + latchQty;
  // 结束状态不在 scene 里：执行失败与募集到期必须靠这几项判断。旧期次缺 getter 时按未结束处理。
  const [phase, executionFailed, fundingDeadline, totalRefunded] = await Promise.all([
    c.phase().then(Number).catch(() => 0),
    c.executionFailed().then(Boolean).catch(() => false),
    c.fundingDeadline().then(Number).catch(() => 0),
    c.totalRefunded().then((v) => Number(formatEther(v))).catch(() => 0),
  ]);
  return {
    address,
    scene: Number(scene),
    phase,
    executionFailed,
    fundingDeadline,
    totalRefunded,
    sold: Number(sold),
    totalShares: Number(totalShares),
    sharePriceBnb: Number(sharePriceBnb),
    hashpower: Number(estHashpower),
    estHashpower: Number(estHashpower),
    distributed: 0,
    feeBem: 0,
    raisedBnb: Number(raisedBnb),
    transistorCount: Number(transistorCount),
    transistors,
  };
}

// ── 模拟材料市场对手方成交（测试网调试） ──
function parseUintField(raw, label, fallback = null) {
  const text = String(raw ?? "").trim();
  if (!text) {
    if (fallback != null) return fallback;
    throw new Error(`请填写${label}`);
  }
  if (!/^\d+$/.test(text)) throw new Error(`${label}必须是非负整数：${text}`);
  return BigInt(text);
}

async function mintPartsOrThrow(parts, buyer, tokenId, amount) {
  try {
    return await parts.mint(buyer, tokenId, amount);
  } catch (e) {
    const msg = String(e?.shortMessage || e?.message || e).slice(0, 140);
    throw new Error(`市场已成交，但补发元件失败：${msg}。元件合约可能不是 MockERC1155，请手动 mint。`);
  }
}

/** 卖方成交一张买单：fillBid 扣减剩余，再把元件 mint 给买家（MockERC1155.mint 公开）。 */
async function fillBidWithParts(signer, bidId, quantity) {
  const { market } = await marketHandle(signer);
  const id = parseUintField(bidId, "买单 ID");
  const bid = await market.bids(id);
  const qty = parseUintField(quantity, "成交数量", bid.remaining);
  if (qty <= 0n) throw new Error("成交数量必须大于 0");
  if (qty > bid.remaining) throw new Error(`买单 #${id} 剩余 ${bid.remaining}，不能成交 ${qty}`);
  await (await market.fillBid(id, qty)).wait();
  const parts = new Contract(bid.transistors, MOCK_PARTS_ABI, signer);
  return mintPartsOrThrow(parts, bid.buyer, bid.tokenId, qty);
}

/** 一键撮合本期全部买单：两条腿都 fillBid 并补齐元件，随后可直接 confirmTransistors。 */
async function fillCampaignBids(signer) {
  const c = signerOrThrow(signer);
  const { market } = await marketHandle(signer);
  const legs = [
    [await c.nandBidId(), await c.nandQty()],
    [await c.latchBidId(), await c.latchQty()],
  ];
  let last = null;
  for (const [id, qty] of legs) {
    if (id === 0n || qty === 0n) continue;
    const bid = await market.bids(id);
    if (bid.remaining !== 0n) {
      const fill = await market.fillBid(id, bid.remaining);
      await fill.wait();
      last = fill;
    }
    // 元件按「本期还缺多少」补，不按买单剩余量补。
    // 买单可能已经被别的路径成交（remaining 已是 0）却没发货，此时仍要 mint 才能 confirmTransistors。
    const tokenAddr = bid.transistors && bid.transistors !== ZeroAddress ? bid.transistors : await c.transistors();
    const parts = new Contract(tokenAddr, MOCK_PARTS_ABI, signer);
    const held = await parts.balanceOf(bid.buyer, bid.tokenId);
    const missing = qty > held ? qty - held : 0n;
    if (missing > 0n) {
      const minted = await mintPartsOrThrow(parts, bid.buyer, bid.tokenId, missing);
      await minted.wait();
      last = minted;
    }
  }
  if (!last) throw new Error("本期买单已全部成交且元件已到账，直接点「确认到账」即可");
  return last;
}

/** 买方吃掉一张卖单：按卖单价付 BNB，元件进入当前钱包。 */
async function fillAskAsBuyer(signer, askId, quantity) {
  const { market } = await marketHandle(signer);
  const id = parseUintField(askId, "卖单 ID");
  const ask = await market.asks(id);
  const qty = parseUintField(quantity, "吃单数量", ask.remaining);
  if (qty <= 0n) throw new Error("吃单数量必须大于 0");
  if (qty > ask.remaining) throw new Error(`卖单 #${id} 剩余 ${ask.remaining}，不能成交 ${qty}`);
  return market.fillAsk(id, qty, { value: ask.price * qty });
}

/** 一键吃掉本期全部卖单：卖出款记入市场 owed，再 withdrawMarketProceeds / confirmSale。 */
async function fillCampaignAsks(signer) {
  const c = signerOrThrow(signer);
  const { market } = await marketHandle(signer);
  const legs = [
    [await c.nandAskId(), await c.nandAskQty()],
    [await c.latchAskId(), await c.latchAskQty()],
  ];
  let last = null;
  for (const [id, qty] of legs) {
    if (id === 0n || qty === 0n) continue;
    const ask = await market.asks(id);
    if (ask.remaining === 0n) continue;
    last = await market.fillAsk(id, ask.remaining, { value: ask.price * ask.remaining });
    await last.wait();
  }
  if (!last) throw new Error("本期没有未成交的卖单，先 placeTransistorAsk");
  return last;
}

// ── 写操作：均返回 tx（调用方 await tx.wait()） ──
function signerOrThrow(signer, address = getCampaignAddress()) {
  if (!signer) throw new Error("请先连接钱包");
  return campaignContract(signer, address);
}

export const tx = {
  subscribe: (signer, count, valueWei) => signerOrThrow(signer).subscribe(count, { value: valueWei }),
  refund: (signer, address) => signerOrThrow(signer, address).refund(),
  claimSurplus: (signer, address) => signerOrThrow(signer, address).claimSurplus(),
  claimFee: (signer, address) => signerOrThrow(signer, address).claimFee(),
  setServiceFee: (signer, bps, recipients, sharesBps) =>
    signerOrThrow(signer).setServiceFee(bps, recipients, sharesBps),
  claim: (signer, address) => signerOrThrow(signer, address).claim(),
  harvest: (signer) => signerOrThrow(signer).harvest(),
  listShares: (signer, count, price) => signerOrThrow(signer).listShares(count, price),
  cancelListing: (signer, id) => signerOrThrow(signer).cancelListing(id),
  takeListing: (signer, id, count, valueWei) => signerOrThrow(signer).takeListing(id, count, { value: valueWei }),
  placeTransistorOrder: (signer, transistors, nandQty, nandPrice, latchQty, latchPrice) =>
    signerOrThrow(signer).placeTransistorOrder(transistors, nandQty, nandPrice, latchQty, latchPrice),
  placeTransistorAsk: (signer, nandQty, nandPrice, latchQty, latchPrice) =>
    signerOrThrow(signer).placeTransistorAsk(nandQty, nandPrice, latchQty, latchPrice),
  cancelTransistorAsk: (signer) => signerOrThrow(signer).cancelTransistorAsk(),
  withdrawMarketProceeds: (signer) => signerOrThrow(signer).withdrawMarketProceeds(),
  simulateFillBid: (signer, id, quantity) => fillBidWithParts(signer, id, quantity),
  simulateFillAsk: (signer, id, quantity) => fillAskAsBuyer(signer, id, quantity),
  simulateFillCampaignBids: (signer) => fillCampaignBids(signer),
  simulateFillCampaignAsks: (signer) => fillCampaignAsks(signer),
  openRefund: async (signer) => {
    const c = signerOrThrow(signer);
    const code = (await signer.provider.getCode(await c.getAddress())).toLowerCase();
    if (code.includes(id("openRefund()").slice(2, 10))) return c.openRefund();
    throw new Error("这期是旧合约，链上没有 Owner 直接退款。重新部署工厂后，新开的期才能退款。");
  },
  abandonOrder: async (signer) => {
    const c = signerOrThrow(signer);
    const code = (await signer.provider.getCode(await c.getAddress())).toLowerCase();
    if (code.includes(id("abandonOrder()").slice(2, 10))) return c.abandonOrder();
    throw new Error("这期是旧合约，链上没有 abandonOrder。重新部署工厂后，新开的期才有这个入口。");
  },
  cancelTransistorOrder: (signer) => signerOrThrow(signer).cancelTransistorOrder(),
  markFailed: async (signer, address) => {
    const c = signerOrThrow(signer, address);
    const code = (await signer.provider.getCode(await c.getAddress())).toLowerCase();
    if (code.includes(id("markFailed()").slice(2, 10))) return c.markFailed();
    throw new Error("这期是旧合约，链上没有 markFailed。请让 Owner 调 openRefund。");
  },
  confirmTransistors: (signer) => signerOrThrow(signer).confirmTransistors(),
  confirmSale: (signer) => signerOrThrow(signer).confirmSale(),
  setPhase: async (signer, next) => {
    const c = signerOrThrow(signer);
    const code = (await signer.provider.getCode(await c.getAddress())).toLowerCase();
    if (code.includes(id("setPhase(uint8)").slice(2, 10))) return c.setPhase(next);
    throw new Error("这期是旧合约，链上不能改子状态。重新部署工厂后，新开的期才有这个出口。");
  },
  setPlan: (signer, est) => signerOrThrow(signer).setPlan(est),
  setMiningPool: (signer, pool) => signerOrThrow(signer).setMiningPool(pool),
  depositToPool: (signer) => signerOrThrow(signer).depositToPool(),
  createCampaign: (signer, params) => createCampaignTx(signer, params),
  removeCampaignAt: (signer, index) => factoryContract(signer).removeCampaign(index),
  // 链上只有按索引移除；工厂合约不再提供 indexOf，这里遍历 campaigns(0..count) 自己查。
  removeCampaign: async (signer, campaign) => {
    const factory = factoryContract(signer);
    const count = Number(await factory.campaignCount());
    const target = String(campaign).toLowerCase();
    let index = -1;
    for (let i = 0; i < count; i++) {
      if (String(await factory.campaigns(i)).toLowerCase() === target) {
        index = i;
        break;
      }
    }
    if (index < 0) throw new Error("该期不在工厂列表中");
    return factory.removeCampaign(index);
  },
  setFactoryOwner: (signer, newOwner) => factoryContract(signer).transferOwnership(newOwner),
  setMaterialMarket: (signer, materialMarket) => signerOrThrow(signer).setMaterialMarket(materialMarket),
  // 无参：一次扫走所有可动 BNB（多余余额，或已无人可退时的整池）。旧期次按老签名回退。
  recoverBnb: async (signer, address) => {
    const c = signerOrThrow(signer, address);
    const code = (await signer.provider.getCode(await c.getAddress())).toLowerCase();
    if (code.includes(id("recoverBnb()").slice(2, 10))) return c.recoverBnb();
    const [bal, raised, scene, sold] = await Promise.all([
      signer.provider.getBalance(await c.getAddress()),
      c.raisedBnb(),
      c.scene(),
      c.sold(),
    ]);
    const amount = scene === 2n || sold === 0n ? bal : bal > raised ? bal - raised : 0n;
    if (amount === 0n) throw new Error("本期没有可取的 BNB：池子里的钱都属于持有人。");
    // 旧期次只有 recoverBnb(uint256)，用独立 ABI，避免和当前无参版本产生重载歧义。
    const legacy = new Contract(await c.getAddress(), ["function recoverBnb(uint256 amount)"], signer);
    return legacy.recoverBnb(amount);
  },
  recoverTransistors: (signer, token, id, amount) => signerOrThrow(signer).recoverTransistors(token, id, amount),
  transferOwnership: (signer, newOwner) => signerOrThrow(signer).transferOwnership(newOwner),
};

/** BNB 数量 → wei（截断到最多 18 位小数，避免浮点脏字符串导致 parseEther 失败）。 */
export function parseBnb(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) throw new Error(`BNB 金额无效：${value}`);
  const [whole, frac = ""] = raw.split(".");
  const clipped = frac.slice(0, 18);
  return parseEther(clipped.length ? `${whole}.${clipped}` : whole);
}

/** 读 Factory Owner。 */
export async function readFactoryOwner() {
  if (!isAddr(FACTORY_ADDRESS)) return "";
  const f = factoryContract(getReadProvider());
  return await f.owner();
}

/**
 * 读工厂默认元件合约。
 *
 * ⚠️ T-79 之后工厂**不再有默认元件**：这一查询字段已废弃。保留函数仅作向前兼容，
 * 恒返回空串——开期时处理器必须由前端从白名单（readAllowedParts）里**显式选择**，
 * 不能用任何「默认」冒充。真正驱动表单的是 readAllowedParts，不是这里。
 */
export async function readFactoryParts() {
  return "";
}

/**
 * 读工厂的元件合约白名单（部署时写入、之后不可增删）。
 *
 * 这是安全边界，不是运营开关：主网上防止 owner 把期次指向
 * MockERC1155（其 mint 无访问控制，任何人能无限造元件，
 * 「元件已到账」的检查形同虚设）。所以开期表单的可选处理器
 * 应该**从链上白名单生成**，而不是硬编码前端列表。
 *
 * 读不到就返回空数组，UI 如实显示「未配置白名单」，不拿前端列表冒充链上事实。
 */
export async function readAllowedParts() {
  if (!isAddr(FACTORY_ADDRESS)) return [];
  try {
    return await withReadProvider(async (runner) => {
      const f = factoryContract(runner);
      const n = Number(await f.allowedPartsCount());
      if (!Number.isFinite(n) || n <= 0) return [];
      const out = [];
      for (let i = 0; i < n; i++) out.push(await f.allowedPartsAt(i));
      return out;
    });
  } catch {
    return [];
  }
}

/**
 * 开期：预检 Owner → staticCall → 发交易 → 解析新地址（事件失败则读 campaigns[n-1]）。
 * 返回 { hash, receipt, campaign }。
 */
/**
 * 开期：预检 Owner → staticCall → 发交易 → 解析新地址（事件失败则读 campaigns[n-1]）。
 * 当前工厂开期需 份额单价 / 总份数 / 募集天数 / 元件合约 四个参数；
 * 材料市场由工厂默认写入（不可变）。
 *
 * 元件合约（第 4 参 transistors）是**必选的处理器**：零地址一律 revert（工厂不再有默认元件），
 * 且必须在工厂白名单内（主网白名单 = 官方两件套 TapeOut / Behemoth 的元件合约）。
 * 白名单是安全边界：不在白名单里的 ERC1155 会被工厂直接拒绝。
 * 开期人必须在前端从白名单里显式选一个——前端不允许留空（见 App.chainCreateCampaign 的预校验）。
 */
const CREATE_CURRENT =
  "function createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint64 fundingSeconds,address transistors) returns (address)";

const SECONDS_PER_DAY = 86400;

function createArgs(params) {
  // 开期需 份额单价 / 总份数 / 募集天数 / 元件合约。
  // 单价以 BNB（十进制）传入，这里转 wei；
  // 天数在这里换成秒——工厂收 fundingSeconds，不再自己做 × 1 days。
  const sharePriceWei = params.sharePriceWei != null
    ? BigInt(params.sharePriceWei)
    : parseBnb(String(params.sharePriceBnb ?? "0"));
  const days = Number(params.fundingDays ?? 0);
  const fundingSeconds = params.fundingSeconds != null
    ? BigInt(params.fundingSeconds)
    : BigInt(Math.max(1, Math.trunc(days)) * SECONDS_PER_DAY);
  // 元件合约（处理器）：必选，原样透传。空串/零地址会触发工厂 revert（前端已预校验必选）。
  const transistorsArg = String(params.transistors || "").trim();
  return [sharePriceWei, params.totalShares, fundingSeconds, transistorsArg];
}

function createCampaignAbi() {
  return FACTORY_ABI.map((item) =>
    item.startsWith("function createCampaign") ? CREATE_CURRENT : item
  );
}

function factoryWriter(signer) {
  return factoryContract(signer);
}

async function createCampaignTx(signer, params) {
  if (!signer) throw new Error("请先连接钱包");
  const f = factoryContract(signer);
  return f.createCampaign(...createArgs(params));
}

export async function createCampaignOnChain(signer, params, onSigned) {
  if (!signer) throw new Error("请先连接钱包");
  const caller = await signer.getAddress();
  const owner = await withReadProvider((provider) => factoryContract(provider).owner());
  if (String(caller).toLowerCase() !== String(owner).toLowerCase()) {
    throw new Error(
      `需 Factory Owner 钱包签名。当前 ${caller.slice(0, 6)}…${caller.slice(-4)}，Owner 为 ${owner.slice(0, 6)}…${owner.slice(-4)}`
    );
  }

  const args = createArgs(params);
  const writer = factoryWriter(signer);
  const iface = writer.interface;

  // 用前端公共 RPC 预检 + 估 gas，避开钱包节点对大创建交易估 gas 时的 coalesce / 403。
  let gasLimit;
  try {
    gasLimit = await withReadProvider(async (provider) => {
      const reader = factoryWriter(provider);
      // 开期会在内部部署 Campaign。eth_call 默认 gas 不够时，节点只回空回退，ethers 显示 missing revert data。
      const call = { from: caller, gasLimit: 12_000_000n };
      await reader.createCampaign.staticCall(...args, call);
      const estimated = await reader.createCampaign.estimateGas(...args, { from: caller });
      return (estimated * 120n) / 100n;
    });
  } catch (err) {
    if (!isWalletSimError(err)) throw new Error(decodeRevert(err, iface));
    gasLimit = 6_000_000n;
  }

  try {
    const t = await writer.createCampaign(...args, { gasLimit });
    if (typeof onSigned === "function") onSigned(t.hash);
    const receipt = await waitForReceipt(t.hash);
    if (receipt.status === 0) throw new Error("交易上链失败（status=0）");
    let campaign = parseCreatedCampaign(receipt);
    if (!campaign) {
      campaign = await withReadProvider(async (provider) => {
        const factory = factoryContract(provider);
        const n = await factory.campaignCount();
        return n > 0n ? factory.campaigns(n - 1n) : null;
      });
    }
    if (!campaign) throw new Error("开期交易已确认，但未能解析新 Campaign 地址，请到顶栏切换期次或刷新");
    return { hash: t.hash, receipt, campaign };
  } catch (err) {
    if (err?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(err?.message || "")) {
      throw new Error("已取消签名");
    }
    throw new Error(decodeRevert(err, iface));
  }
}

/** 从 createCampaign 回执解析新 Campaign 地址。 */
export function parseCreatedCampaign(receipt) {
  const iface = new Interface(FACTORY_ABI);
  for (const log of receipt.logs || []) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "CampaignCreated") return parsed.args.campaign;
    } catch {
      /* 非本事件 */
    }
  }
  return null;
}

function nestedErrorData(err) {
  let cur = err;
  const seen = new Set();
  for (let i = 0; i < 8 && cur && !seen.has(cur); i++) {
    seen.add(cur);
    const candidates = [
      cur.data,
      cur.info?.error?.data,
      cur.error?.data,
      cur.cause?.data,
      cur.info?.error?.data?.data,
      typeof cur.info?.error?.data === "object" ? cur.info.error.data.data : null,
    ];
    for (const item of candidates) {
      if (typeof item === "string" && /^0x[0-9a-fA-F]+$/i.test(item) && item.length >= 10) return item;
      if (item && typeof item === "object" && typeof item.data === "string" && /^0x/i.test(item.data)) {
        return item.data;
      }
    }
    cur = cur.error || cur.cause || cur.info?.error;
  }
  return "";
}

function nestedErrorText(err) {
  const parts = [];
  let cur = err;
  const seen = new Set();
  for (let i = 0; i < 8 && cur && !seen.has(cur); i++) {
    seen.add(cur);
    for (const key of ["shortMessage", "reason", "message"]) {
      const text = cur[key];
      if (text && !parts.includes(String(text))) parts.push(String(text));
    }
    const nested = cur.info?.error?.message || cur.error?.message || cur.cause?.message;
    if (nested && !parts.includes(String(nested))) parts.push(String(nested));
    cur = cur.error || cur.cause || cur.info?.error;
  }
  return parts.join(" · ");
}

function explainParsed(parsed) {
  if (parsed?.name === "NotOwner") {
    const caller = parsed.args?.caller || parsed.args?.[0];
    return `非 Factory Owner（${caller ? String(caller).slice(0, 10) + "…" : "当前钱包"}），无法开期`;
  }
  // 注：BadFee / BadFeeShares 已从合约移除（合约没有服务费字段），不再解码——
  // 留着会让用户看到「服务费须在 1–20%」，误以为链上有服务费机制。
  if (parsed?.name === "ZeroCampaignParam") return "每份价格或总份数不能为 0";
  if (parsed?.name === "ObservationPeriodActive") {
    return "这期是旧版合约，时间锁尚未到期。可稍后再试，或换到已去掉时间锁的新工厂开期。";
  }
  if (parsed?.name === "TransistorsNotReady") {
    return "晶体管还没到账，不能确认/入池：买单需全部成交，且 NAND / LATCH 元件要真的在本期合约里（成交后卖家没发货也会这样）。";
  }
  if (parsed?.name === "AlreadyListed") return "当前子状态不允许这一步。挂单中请先取消；已确认到账的旧期不能再挂卖或退款。";
  if (parsed?.name === "AlreadyReady") return "本期已确认到账。元件锁在合约里，不能单独取出。这一期只能入池。";
  if (parsed?.name === "AlreadyAsked") return "还有未结算的卖单，先取消剩余或确认卖出。";
  if (parsed?.name === "NotAsked") return "当前没有可确认的卖单。";
  if (parsed?.name === "OrderFilled") return "买单已全部成交，不能再取消。";
  if (parsed?.name === "InsufficientParts") return "合约里的元件数量不够。";
  if (parsed?.name === "CanStillAfford") return "按当前报价还能买得起晶体管，旧合约不允许退款";
  if (parsed?.name === "WrongTransistors") {
    return "元件合约地址与本期锁定的元件合约不一致。用本期 transistors() 读到的地址重试。";
  }
  if (parsed?.name === "ZeroAddress") return "地址不能为零地址（材料市场 / 元件合约 / 矿池 / 收款地址）";
  if (parsed?.name) return `合约拒绝：${parsed.name}`;
  return "";
}

function decodeRevert(err, iface) {
  const data = nestedErrorData(err);
  const raw = nestedErrorText(err) || "交易失败";
  const selectors = [];
  if (data) selectors.push(data);
  for (const match of raw.matchAll(/"(0x[0-9a-fA-F]{8})"/g)) selectors.push(match[1]);
  if (iface) {
    for (const selector of selectors) {
      try {
        const text = explainParsed(iface.parseError(selector));
        if (text) return text;
      } catch {
        /* 不是本合约的错误选择子 */
      }
    }
  }
  const revert = err?.revert?.name;
  if (revert) {
    const text = explainParsed({ name: revert, args: err?.revert?.args });
    if (text) return text;
  }
  if (/no data present/i.test(raw)) {
    return "合约拒绝了这笔交易，钱包没有带回具体原因。若是发布或挂单/入池，请确认当前钱包权限与元件子态后再试。";
  }
  if (/missing revert data/i.test(raw)) {
    return "节点没有带回失败原因（missing revert data）。开期请确认钱包 BSC 节点是 https://bsc-rpc.publicnode.com，不要用已超额的 1rpc。";
  }
  if (/usage limit|1rpc\.io|#pricing|-32001/i.test(raw)) {
    return "当前 RPC 额度用尽。请硬刷新本页，并在钱包里把 BSC 主网节点改成 https://bsc-rpc.publicnode.com 后重试。";
  }
  if (/could not coalesce error|403|archive|personal token/i.test(raw)) {
    return "公共节点暂时拒绝了这笔模拟。请刷新后再试；若钱包弹出更新 BSC 网络，点确认，节点用 https://bsc-rpc.publicnode.com。";
  }
  if (/insufficient funds|exceeds the balance/i.test(raw)) {
    return "钱包 BNB 不够付部署期次合约的 gas。开一期大约需要约 0.0002 BNB（按当前 gas 价）。";
  }
  return raw;
}

/** 统一发送并等待，返回 { hash, receipt }，出错抛出可读信息。 */
async function waitForReceipt(hash) {
  return withReadProvider(async (provider) => {
    const receipt = await provider.waitForTransaction(hash, 1, 120_000);
    if (!receipt) throw new Error("timeout");
    return receipt;
  });
}

export async function send(promiseTx, onSigned) {
  try {
    const t = await promiseTx;
    if (typeof onSigned === "function") onSigned(t.hash);
    const receipt = await waitForReceipt(t.hash);
    return { hash: t.hash, receipt };
  } catch (err) {
    if (err?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(err?.message || "")) {
      throw new Error("已取消签名");
    }
    const rawMsg = String(err?.shortMessage || err?.message || "");
    if (/403|网络连接失败|data-seed-prebsc|bnbchain\.org/i.test(rawMsg)) {
      throw new Error("钱包 RPC 连不上（官方测试网节点常返回 403）。请把 BSC 测试网节点改成 https://bsc-testnet-rpc.publicnode.com 后重试。");
    }
    const iface = new Interface([
      ...FACTORY_ABI,
      ...CAMPAIGN_ABI,
      CREATE_V1,
      CREATE_V2,
      "error NotOwner(address caller)",
      "error ZeroAddress()",
      "error ObservationPeriodActive(uint64 unlockAt)",
      "error TransistorsNotReady()",
      "error AlreadyListed()",
      "error AlreadyReady()",
      "error AlreadyAsked()",
      "error NotAsked()",
      "error OrderFilled()",
      "error InsufficientParts()",
      "error CanStillAfford()",
      "error WrongScene()",
      "error WrongTransistors()",
      // 旧版合约的错误签名：留着只为解码链上已部署的旧期数，解出来走「合约拒绝：<名字>」兜底。
      "error NetlistMismatch()",
      "error NothingToClaim()",
      "error NoEmission()",
      "error BadFeeShares()",
    ]);
    let decoded = decodeRevert(err, iface);
    const txReq = err?.transaction;
    if (/钱包没有带回具体原因/.test(decoded) && txReq?.to && txReq?.data) {
      try {
        await getReadProvider().call({
          to: txReq.to,
          data: txReq.data,
          from: txReq.from,
          value: txReq.value && txReq.value !== "0x0" ? txReq.value : undefined,
        });
      } catch (replay) {
        decoded = decodeRevert(replay, iface);
      }
    }
    throw new Error(decoded);
  }
}
