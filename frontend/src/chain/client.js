// 链上对接客户端（ethers v6）。读取 Campaign 实时状态、发送写交易。
// 无钱包时用公共 RPC 只读；有钱包（window.ethereum）时签名发送。
import { BrowserProvider, FetchRequest, JsonRpcProvider, Network, Contract, Interface, formatEther, parseEther, ZeroAddress, keccak256, solidityPacked } from "ethers";
import { CAMPAIGN_ABI, FACTORY_ABI, CIRCUIT_MARKET_ABI, MOCK_CIRCUIT_ABI, POD_MINING_ABI } from "./abis.js";
import {
  CAMPAIGN_ADDRESS,
  FACTORY_ADDRESS,
  CHAIN_ID,
  CHAIN_ID_HEX,
  NETWORK,
  IS_CONFIGURED,
  SCENE_LABEL,
  PHASE_LABEL,
  POD_LENS_ADDRESS,
  POD_MINING_ADDRESS,
} from "./config.js";
import { discoverWallets, explainConnectError, inAppWalletName, rememberWallet, rememberedWalletId } from "./wallets.js";

export { formatEther, parseEther, ZeroAddress };

const STORAGE_KEY = "miner.activeCampaign";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** 与 Campaign.FAIL_GRACE 保持一致：非 Owner 须在售罄满 3 天后才能 markFailed。 */
export const FAIL_GRACE_SECONDS = 3 * 86_400;

/**
 * 非 Owner 能 markFailed 的时间戳（毫秒）。
 *
 * 合约口径是 `max(soldOutAt, lastOrderAt) + FAIL_GRACE`（Campaign.sol:757-758），
 * 不是「售罄满 3 天」：每次挂单都会把宽限期往前推，防止 Owner 用
 * 售罄后立刻重挂单把逃生口按回去，也让「售罄后一直没挂单」的期次不被瞬间判死。
 * 只按 soldOutAt 算会读早（本期实际 10-27 10:15，少算 25 小时），
 * 页面就会显示一个还没到的「逃生口打开」时间。
 */
export function graceEndsAtMs(soldOutAt, lastOrderAt) {
  const base = Math.max(Number(soldOutAt) || 0, Number(lastOrderAt) || 0);
  return base > 0 ? (base + FAIL_GRACE_SECONDS) * 1000 : null;
}

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

/**
 * 读事件日志专用：按节点顺序试，哪个能读就用哪个。
 *
 * 为什么不直接用 withReadProvider 的轮换：日志读取内部是「失败就当做没有事件」
 * （返回 null 让 UI 退回状态展示），错误被吞掉，轮换永远不会触发。而公共节点里
 * 恰好只有 eth_getLogs 限制最严 —— publicnode 把历史日志当 archive 请求（要 token，
 * 403）、blastapi 的公共端点限流（429），只有 nodereal 允许 5 万块区间。
 * 于是「市场没有事件」看起来像合约事实，其实是节点读不到。
 */
let _logProvider = null;
let _logProviderIndex = 0;

export async function getLogsWithFailover(query) {
  const urls = NETWORK.rpcUrls;
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const index = (_logProviderIndex + i) % urls.length;
    const provider = index === _logProviderIndex && _logProvider
      ? _logProvider
      : makeStaticProvider(urls[index]);
    try {
      const logs = await withTimeout(provider.getLogs(query), 8_000, "getLogs");
      _logProvider = provider;
      _logProviderIndex = index;
      return logs;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * 批量 eth_call 专用：按节点顺序试，哪个肯收整批就用哪个。
 *
 * 与 getLogsWithFailover 同理，但限制正好反过来 —— eth_call 读的是最新状态，
 * 不需要 archive 数据，几乎所有公共节点都支持；差别只在「一次肯收几个」：
 * drpc 免费档只收 ≤3（超了 500），publicnode 实测能收 150。所以 makeStaticProvider
 * 为了兼容 drpc 把批量压到 3，而批量读几十个挂单时那会变成几十个 HTTP 请求。
 * 这里单独用 8 个一批（保守值，三个主网节点都收得下），按节点顺序试。
 */
let _batchProvider = null;
let _batchProviderIndex = 0;
const BATCH_MAX = 8;

function makeBatchProvider(url) {
  const network = Network.from(CHAIN_ID);
  const request = new FetchRequest(url);
  request.timeout = 12_000;
  return new JsonRpcProvider(request, network, {
    staticNetwork: network,
    batchMaxCount: BATCH_MAX,
  });
}

/**
 * @param {{to: string, data: string}[]} calls
 * @returns {Promise<string[]>} 与 calls 同序的原始返回（0x 开头的 hex）
 */
export async function callBatchWithFailover(calls) {
  const urls = NETWORK.rpcUrls;
  if (!calls.length) return [];
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const index = (_batchProviderIndex + i) % urls.length;
    const provider =
      index === _batchProviderIndex && _batchProvider
        ? _batchProvider
        : makeBatchProvider(urls[index]);
    try {
      const out = await withTimeout(
        Promise.all(calls.map((c) => provider.call(c))),
        15_000,
        "batchCall",
      );
      _batchProvider = provider;
      _batchProviderIndex = index;
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function injectedChoices() {  const choices = await discoverWallets();
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
  /**
   * 逐项降级只用于「展示层可容错」的字段：单个 getter 读失败不应让整页报
   * 「链上读取失败」。新合约的 getter 全部存在，因此这里不再按名字/字节码做能力探测。
   */
  const withDefault = (p, fallback) => p.catch(() => fallback);
  const [
    scene, phase, sold, totalShares, sharePriceBnb, estHashpower,
    priceLock, soldOutAt, executionFailed, raisedBnb, totalRefunded,
    fundingDeadline, circuitsAddr, marketAddr, factoryAddr, owner, halted, podMiningAddr, bemAddr,
    listingCount, totalPendingSurplus,
    outstandingShares, serviceFeeBps, serviceFeeSet, feeRecipientCount,
    revenuePool, surplusPool, lastOrderAt, surplusBase, surplusPaid,
  ] = await Promise.all([
    c.scene(), c.phase(), c.sold(), c.totalShares(), c.sharePriceBnb(),
    withDefault(c.estHashpower(), 0n),
    withDefault(c.priceLock(), 0n),
    withDefault(c.soldOutAt(), 0n),
    withDefault(c.executionFailed(), false),
    c.raisedBnb(),
    withDefault(c.totalRefunded(), 0n),
    c.fundingDeadline(), c.circuits(), c.circuitMarket(), c.factory(),
    c.owner(),
    withDefault(c.halted(), false),
    withDefault(c.podMining(), ZeroAddress),
    withDefault(c.bem(), ZeroAddress),
    withDefault(c.listingCount(), 0n),
    withDefault(c.totalPendingSurplus(), 0n),
    withDefault(c.outstandingShares(), 0n),
    withDefault(c.serviceFeeBps(), 0),
    withDefault(c.serviceFeeSet(), false),
    withDefault(c.feeRecipientCount(), 0n),
    withDefault(c.revenuePool(), 0n),
    withDefault(c.surplusPool(), 0n),
    withDefault(c.lastOrderAt(), 0n),
    // 余款的分子/分母与「已实付」：surplusPool − surplusPaid 才是还没发到持有人手里的部分。
    withDefault(c.surplusBase(), 0n),
    withDefault(c.surplusPaid(), 0n),
  ]);
  const order = await readCircuitOrder(c);

  const n = Number(listingCount);
  // 逐条降级：单条挂单读失败不应让整期状态读不出来。
  const rawListings = n > 0
    ? await Promise.all(
        Array.from({ length: n }, (_, i) => c.getListing(i).catch(() => null)),
      )
    : [];
  /**
   * 挂单的「原始份数 / 已成交份数」不在 storage 里：takeListing 直接把
   * `Listing.shares` 减到 0，全成交后只剩 0 + open=false（Campaign.sol:637-638）。
   * 单看 getListing 无法区分「挂了 1 份并成交」和「挂了 0 份」，于是列表里
   * 已成交的挂单会显示「份数 —、合计 0.0000 BNB」——链上明明付过钱。
   * 这里用事件把原始份数补回来：Listed 给挂单量，ListingTaken 累计成交，
   * ListingCancelled 给撤单时释放的量。读不到事件（节点限制）就留空，
   * 展示层退回「剩余份数」，绝不把「未知」画成 0。
   */
  const listingMeta = n > 0 ? await readListingMeta(runner, campaignAddr).catch(() => null) : null;
  const listings = rawListings
    .map((l, i) => l && ({
      id: i,
      seller: l.seller,
      shares: l.shares,
      priceBnbPerShare: l.priceBnbPerShare,
      open: l.open,
      ...(listingMeta?.get(i) || {}),
    }))
    .filter(Boolean);

  // 服务费分成表：读链上（费率与分成表都写在 Campaign 里）。
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
  // 宽限期基准是 max(soldOutAt, lastOrderAt)：每次挂单都会把它往后推（合约 Campaign.sol:757）。
  const markFailedAt = graceEndsAtMs(soldOutAt, lastOrderAt);
  const refundShort = Number(scene) === 1
    && Number(phase) === 1
    && raisedBnb < outstandingShares * sharePriceBnb;
  // 工厂已移除该期时，cancelCircuitListing 允许任何人撤剩余挂卖（合约里的 _retired 口径）。
  let retired = false;
  try {
    if (factoryAddr && factoryAddr !== ZeroAddress) {
      retired = !(await factoryContract(runner, factoryAddr).isRegistered(campaignAddr));
    }
  } catch {
    /* 工厂暂不可读：按「仍在册」处理 */
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
    /**
     * 电路数 = **本期仍持有的 ERC721 电路张数**（circuitHeldCount）。
     * 买入是原子交割，成交后立刻到账；卖出后持仓下降。
     */
    circuitHeldCount: Number(order.heldCount ?? 0n), capped: false,
    owner, fundingDeadline: Number(fundingDeadline),
    /** 熔断状态：true 时认筹/挂单/卖电路/开矿/份额挂单与接单全部停，pulls 与撤单不受影响。 */
    halted: Boolean(halted),
    listings,
    ...order,
    podMining: podMiningAddr,
    bem: bemAddr,
    circuits: order.circuits && order.circuits !== ZeroAddress ? order.circuits : circuitsAddr,
    feeRecipient: "",
    market: marketAddr,
    circuitMarket: marketAddr,
    markFailedAt,
    refundShort,
    /**
     * sold 是单调的历史事实（本期卖出去过多少），退款不会让它变小；
     * outstandingShares 是当前债务（已售未退）——「已售 X/Y」和退款分母都用它。
     */
    outstandingShares,
    /** 开矿后未发出去的余款池：surplusPool 是累计已记账，surplusBase 是本轮的分母。 */
    surplusPool,
    revenuePool,
    refundRatio: refundShort && outstandingShares > 0n
      ? Number(formatEther(raisedBnb)) / Number(outstandingShares)
      : null,
    retired,
    /** 已记账、还没发到持有人手里的余款（wei 换算成 BNB 由适配层做）。 */
    surplusOutstanding: surplusPool > surplusPaid ? surplusPool - surplusPaid : 0n,
    surplusBase,
    feeShares,
    netWeightVerified: 0, netWeightUnverified: 0,
    account: account || null,
  };

  if (account) {
    const [shares, escrow, refunded, bnbBal, pendingSurplus, surplusOfRaw, bemClaimable] = await Promise.all([
      c.sharesOf(account), c.escrowOf(account),
      c.refundedOf(account), runner.getBalance(account),
      c.pendingSurplus(account).catch(() => 0n),
      // 挖矿后的余款改 pull 模式：surplusOf 会把「还没计提但已可领」的部分也算进来。
      c.surplusOf(account).catch(() => 0n),
      // 官方 PoD 奖励按份额记账，持有人用 claimBem() 领取。
      c.bemPendingOf(account).catch(() => 0n),
    ]);
    /** 可领余款 = max(surplusOf, pendingSurplus)：surplusOf 含尚未计提的部分。 */
    const claimableSurplus = surplusOfRaw > pendingSurplus ? surplusOfRaw : pendingSurplus;
    state.self = {
      shares, escrow, claimed: 0n, refunded, pending: 0n, bemBalance: bemClaimable, bnb: bnbBal,
      /**
       * 待领余款（wei）。挖矿后余款改 pull 模式：不再在开矿时推给持有人，
       * 而是持份人自己调 claimSurplus() 领。claimableSurplus 含尚未计提的可领部分。
       */
      pendingSurplus,
      claimableSurplus,
      bemClaimable,
    };
  }
  return state;
}

/** 份额转让的成交份数留在挂单剩余字段里，不扫 ListingTaken。认筹名单走 holderCount / holderAt，不扫 Subscribed。 */

/** 链上只读某个视图（合约调用页用），返回人类可读字符串。 */
export async function liveReadView(method, args = {}, account = null, campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) throw new Error("未配置 Campaign");
  const state = await readState(account || args.account || null, campaignAddr);
  switch (method) {
    case "status":
    case "scene":
      return SCENE_LABEL[state.scene] || String(state.scene);
    case "phase":
    case "executePhase":
      return PHASE_LABEL[state.phase] || String(state.phase);
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
      const v = await c.surplusOf(a);
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
    case "circuits":
      return state.circuits || "—";
    case "market":
    case "circuitMarket":
      return state.circuitMarket || state.market || "—";
    case "circuitHeldCount":
      return `${state.circuitHeldCount ?? 0} 张`;
    case "circuitCount":
      return withReadProvider(async (runner) => `${await campaignContract(runner, campaignAddr).circuitCount()} 张（历史买入）`);
    case "marketOpenOrders":
      return readMarketBook(campaignAddr);
    case "marketListing":
      return readListingView(args.id || 1, campaignAddr);
    case "marketSellable":
      return withReadProvider(async (runner) => {
        const campaign = campaignContract(runner, campaignAddr);
        const marketAddr = await readCircuitMarket(campaign);
        if (!isAddr(marketAddr) || marketAddr === ZeroAddress) return "本期没有配置电路市场";
        const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, runner);
        const rows = await scanCircuitListings(campaign, market);
        if (!rows.length) return "市场里还没有本期电路的卖单";
        return rows
          .map((l) => `挂单 #${l.id} · 电路 #${l.tokenId} · 单价 ${formatEther(l.price)} BNB · 卖家 ${shortAddr(l.seller)}`)
          .join("\n");
      });
    case "marketOwed":
      return withReadProvider((runner) => readMarketOwedView(runner, campaignAddr, args.account));
    case "executionFailed":
      return state.executionFailed ? "是（已判执行失败）" : "否";
    case "halted":
      return state.halted
        ? "已熔断：认筹、挂单、卖出、开矿与份额交易已停"
        : "运行中";
    case "soldOutAt":
      return Number(state.soldOutAt) > 0
        ? new Date(Number(state.soldOutAt) * 1000).toLocaleString("zh-CN")
        : "—";
    case "priceLock":
      return Number(state.priceLock) > 0
        ? `${Number(formatEther(state.priceLock)).toFixed(4)} BNB（${state.circuitHeldCount} 张电路）`
        : "未锁价";
    case "holderCount":
      return `${await campaignContract(getReadProvider(), campaignAddr).holderCount()} 个地址`;
    case "miningStatus": {
      const tokenId = args.tokenId ?? args.id ?? "0";
      return withReadProvider(async (runner) => {
        const c = campaignContract(runner, campaignAddr);
        const status = Number(await c.miningStatus(tokenId));
        const labels = ["未开矿", "挖矿中", "已撤销", "冷却中"];
        return labels[status] || String(status);
      });
    }
    case "bemPendingOf": {
      const a = args.account || account;
      if (!a) return "请填地址";
      const c = campaignContract(getReadProvider(), campaignAddr);
      const v = await c.bemPendingOf(a);
      return `${Number(formatEther(v)).toFixed(4)} BEM`;
    }
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

/** 认筹名单直接读链上 holderCount / holderAt（新合约始终提供这两个视图）。 */
async function readHolderAddresses(runner, c) {
  const n = Number(await c.holderCount());
  if (!Number.isFinite(n) || n <= 0) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(await c.holderAt(i));
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
      // 单个 getter 失败时按默认值降级，不让整行退化成「读取失败」。
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
        // 已售未退（当前债务）：退款后变小，sold 不会。
        zb(c.outstandingShares(), 0n),
      ];
      if (account) {
        base.push(
          zb(c.sharesOf(account), 0n),
          zb(c.escrowOf(account), 0n),
          zb(c.refundedOf(account), 0n),
          // 余款 pull 模式：surplusOf 含尚未计提的可领部分。
          zb(c.surplusOf(account), 0n),
          zb(c.pendingSurplus(account), 0n),
        );
      }
      const res = await Promise.all(base);
      const soldOutAt = await c.soldOutAt().catch(() => 0n);
      const lastOrderAt = await c.lastOrderAt().catch(() => 0n);
      const scene = Number(res[0]);
      const phaseN = Number(res[6]);
      rows.push({
        id,
        address,
        scene: POSITION_SCENE[scene] || "funding",
        sceneLabel: SCENE_LABEL[scene] || "—",
        phase: ["", "buying", "listed", "ready"][phaseN] || "buying",
        sold: Number(res[1]),
        outstandingShares: Number(res[8]),
        totalShares: Number(res[2]),
        sharePriceBnb: Number(formatEther(res[3])),
        executionFailed: Boolean(res[4]),
        fundingDeadline: Number(res[5]),
        raisedBnb: Number(formatEther(res[7])),
        soldOutAt: Number(soldOutAt),
        markFailedAt: graceEndsAtMs(soldOutAt, lastOrderAt),
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

/** 读本期接的电路市场地址；读不到按零地址处理（展示层显示「未配置」）。 */
async function readCircuitMarket(c) {
  try {
    const a = await c.circuitMarket();
    return isAddr(a) && a !== ZeroAddress ? a : ZeroAddress;
  } catch {
    return ZeroAddress;
  }
}

const ERC721_READ_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * 本期电路持仓 / 市场读数，映射成页面长期使用的那套 book 字段。
 *
 * 电路市场只有卖单侧且无托管：
 *   - 采购是 buyCircuits 原子吃单，成交后 NFT 立刻到期次合约（没有「等成交」的挂单）；
 *   - 卖出是 listCircuit 把某张 NFT 挂回市场，成交前 NFT 仍在期次合约里；
 *   - 卖家货款进 owed(address)，需要 withdrawMarketProceeds 提回。
 *
 * 字段说明：
 *   heldCount = 本期持有的电路张数（circuitHeldCount）；
 *   sellBids = 尚未挂单的持仓，每张一行（id = tokenId），点击卖出 = 以成本价挂回市场；
 *   listedCircuits = 已挂单的持仓，供 Owner 撤单（开矿前必须全部撤单）。
 */
async function readCircuitOrder(c) {
  const empty = {
    circuits: ZeroAddress, orderFilled: false,
    marketOwed: 0n, sellBids: [], listedCircuits: [], sellSide: false,
    heldCount: 0n, boughtCount: 0n, circuitHeldCount: 0n,
    miningActiveCount: 0, miningPendingBem: 0n,
  };
  try {
    const holder = c.target;
    const circuits = await c.circuits();
    const marketAddr = await readCircuitMarket(c);
    const [boughtCount, heldCount] = await Promise.all([
      c.circuitCount().catch(() => 0n),
      c.circuitHeldCount().catch(() => 0n),
    ]);
    const token = isAddr(circuits) && circuits !== ZeroAddress
      ? new Contract(circuits, ERC721_READ_ABI, c.runner)
      : null;
    const market = isAddr(marketAddr) && marketAddr !== ZeroAddress
      ? new Contract(marketAddr, CIRCUIT_MARKET_ABI, c.runner)
      : null;

    const n = Number(boughtCount);
    const ids = n > 0
      ? await Promise.all(Array.from({ length: n }, (_, i) => c.circuitIds(i).catch(() => null)))
      : [];
    const rows = await Promise.all(ids.filter((v) => v != null).map(async (tokenId) => {
      const [cost, listingId, status, pending] = await Promise.all([
        c.circuitCostBasis(tokenId).catch(() => 0n),
        c.circuitListingId(tokenId).catch(() => 0n),
        c.miningStatus(tokenId).then(Number).catch(() => 0),
        c.miningPending(tokenId).catch(() => 0n),
      ]);
      let owned = false;
      if (token) {
        try {
          owned = String(await token.ownerOf(tokenId)).toLowerCase() === String(holder).toLowerCase();
        } catch {
          owned = false;
        }
      }
      let listed = false;
      let listingPrice = 0n;
      if (owned && listingId !== 0n && market) {
        try {
          const live = await market.listingFor(circuits, tokenId);
          listed = Boolean(live.valid) && live.id === listingId;
          listingPrice = live.price;
        } catch {
          listed = false;
        }
      }
      return { tokenId, cost, listingId, owned, listed, listingPrice, miningStatus: status, miningPending: pending };
    }));

    const held = rows.filter((r) => r.owned);
    const unlisted = held.filter((r) => !r.listed);
    const listed = held.filter((r) => r.listed);
    // 成本基准取最高的一张：挂单底价必须覆盖每一张的买入成本，避免低价烧抵押。
    const floor = held.reduce((m, r) => (r.cost > m ? r.cost : m), 0n);
    const marketOwed = market ? await market.owed(holder).catch(() => 0n) : 0n;
    const feeBps = market ? Number(await market.feeBps().catch(() => 0)) : 0;

    return {
      circuits,
      orderFilled: heldCount > 0n,
      heldCount,
      boughtCount,
      circuitHeldCount: heldCount,
      miningActiveCount: held.filter((r) => r.miningStatus === 1).length,
      miningPendingBem: held.reduce((acc, r) => acc + (r.miningPending || 0n), 0n),
      marketOwed,
      sellSide: Boolean(market),
      // 每张未挂单的持仓一行；价格预填成本价（>= 成本才允许挂）。
      sellBids: unlisted.map((r) => ({
        id: r.tokenId,
        tokenId: 0,
        price: r.cost,
        remaining: 1n,
        feeBps,
        buyer: marketAddr,
        circuitTokenId: r.tokenId,
        miningStatus: r.miningStatus,
        miningPending: r.miningPending,
      })),
      listedCircuits: listed.map((r) => ({
        tokenId: r.tokenId,
        listingId: r.listingId,
        price: r.listingPrice || r.cost,
        cost: r.cost,
        miningStatus: r.miningStatus,
        miningPending: r.miningPending,
      })),
    };
  } catch {
    return empty;
  }
}

async function readMarketOwed(runner, marketAddr, account) {
  if (!marketAddr || marketAddr === ZeroAddress || !account) return 0n;
  try {
    const market = new Contract(marketAddr, ["function owed(address) view returns (uint256)"], runner);
    return await market.owed(account);
  } catch {
    return 0n;
  }
}

// ── 电路市场（sell-side）调试：查看挂单 + 市场欠款 ──
const shortAddr = (a) => (isAddr(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || "—"));

/** 本期合约接的电路市场。官方市场与 Mock 都提供 sell-side ABI。 */
async function marketHandle(runner, campaignAddr = getCampaignAddress()) {
  const campaign = campaignContract(runner, campaignAddr);
  const marketAddr = await readCircuitMarket(campaign);
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) {
    throw new Error("本期合约没有配置电路市场（circuitMarket 为 0）。");
  }
  const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, runner);
  try {
    await market.nextListingId();
  } catch {
    throw new Error("这期接的电路市场不提供 nextListingId，无法读取挂单。");
  }
  return { campaign, market, marketAddr };
}

/** 列出市场里属于本期电路合约、仍未成交的卖单。 */
export async function readMarketBook(campaignAddr = getCampaignAddress()) {
  return withReadProvider(async (runner) => {
    const { campaign, market, marketAddr } = await marketHandle(runner, campaignAddr);
    const circuits = String(await campaign.circuits());
    const feeBps = Number(await market.feeBps().catch(() => 0));
    const rows = await readCircuitListingsFor(marketAddr, circuits);
    const lines = [`市场 ${shortAddr(marketAddr)}（卖家付 ${feeBps / 100}% 费）`];
    if (!rows.length) {
      lines.push("市场里没有本期电路的卖单");
      return lines.join("\n");
    }
    for (const l of rows) {
      lines.push(`挂单 #${l.id} · token #${l.tokenId} · 单价 ${formatEther(l.price)} BNB · 卖家 ${shortAddr(l.seller)}`);
    }
    return lines.join("\n");
  });
}

async function readListingView(id, campaignAddr) {
  return withReadProvider(async (runner) => {
    const { market } = await marketHandle(runner, campaignAddr);
    const listingId = parseUintField(id, "挂单 ID");
    const l = await market.listings(listingId);
    return `挂单 #${listingId} · 电路 #${l.tokenId} · 卖家 ${shortAddr(l.seller)} · 单价 ${formatEther(l.price)} BNB · 卖家费 ${l.feeBps} bps`;
  });
}

async function readMarketOwedView(runner, campaignAddr, account) {
  const { market } = await marketHandle(runner, campaignAddr);
  return `${formatEther(await market.owed(account || campaignAddr))} BNB`;
}

// ── 待执行状态的电路市场成交记录 ──
const MARKET_LOG_WINDOWS = 6; // 最多回看 6 × 50k 块（约 10 天）；凑满条数会提前停
const MARKET_LOG_SPAN = 50_000;
/** 历史交易记录只保留最近这么多条（窄栏放不下更多，也不该翻旧账）。 */
export const MARKET_TRADE_LIMIT = 5;
/** 成交记录缓存（按期次分期次存 lastBlock + rows），避免每次刷新重扫。 */
const TRADE_MARKS_KEY = "tapeout.circuitMarket.tradeMarks.v1";
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
    "CircuitsBought",
    "CircuitBought",
    "CircuitListed",
    "CircuitListingCancelled",
    "CircuitsConfirmed",
    "MarketProceedsWithdrawn",
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
        const logs = await getLogsWithFailover({
          address: campaignAddr,
          fromBlock: from,
          toBlock: Math.min(latest, from + 49_999),
          topics: [hashes],
        });
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
    // 带上参数：撤单 / 确认到账会清空 bid 字段，历史只能靠事件里的订单号回放。
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

/**
 * 电路市场事件 → 历史交易记录行。只收本期自己的挂单 / 成交 / 撤单 / 提款：
 *   Listed(id, seller, circuits, tokenId, price)   seller == 本期 → 挂出
 *   Bought(id, buyer, seller, tokenId, price, feeBps)
 *     buyer == 本期 → 买入；seller == 本期 → 卖出（净得 price − fee）
 *   Delisted(id) → 撤回自己的挂单
 *   ProceedsWithdrawn(account, amount) → 本期提款
 */
function buildMarketRows(parsed, me) {
  const myListings = new Set();
  const rows = [];
  const bnb = (wei) => Number(formatEther(BigInt(wei || 0)));
  for (const e of parsed) {
    const id = e.args?.id != null ? String(e.args.id) : "";
    const tokenId = e.args?.tokenId != null ? Number(e.args.tokenId) : null;
    const base = { id, tokenId, txHash: e.hash || null, blockNumber: e.blockNumber ?? null };
    if (e.name === "Listed") {
      if (String(e.args.seller).toLowerCase() !== me) continue;
      myListings.add(id);
      rows.push({ ...base, kind: "list", side: "sell", qty: 1, price: bnb(e.args.price), amount: null });
    } else if (e.name === "Bought") {
      const buyer = String(e.args.buyer).toLowerCase();
      const seller = String(e.args.seller).toLowerCase();
      if (buyer !== me && seller !== me) continue;
      let amount = BigInt(e.args.price);
      if (seller === me) {
        const fee = (BigInt(e.args.price) * BigInt(e.args.feeBps || 0)) / 10000n;
        amount -= fee;
      }
      rows.push({
        ...base,
        kind: "fill",
        side: buyer === me ? "buy" : "sell",
        qty: 1,
        price: bnb(e.args.price),
        amount: bnb(amount),
      });
    } else if (e.name === "Delisted") {
      if (!myListings.has(id)) continue;
      rows.push({ ...base, kind: "cancel", side: "sell", amount: null });
    } else if (e.name === "ProceedsWithdrawn") {
      if (String(e.args.account).toLowerCase() !== me) continue;
      rows.push({ ...base, kind: "withdraw", side: "sell", id: "", amount: bnb(e.args.amount) });
    }
  }
  return rows.map((row) => ({ ...row, ts: null }));
}

/**
 * 历史交易记录只需最近 MARKET_TRADE_LIMIT 条，所以从最新窗口往旧翻，够数就停。
 */
async function readMarketLogs(runner, marketAddr, campaignAddr, limit = MARKET_TRADE_LIMIT) {
  const iface = new Interface(CIRCUIT_MARKET_ABI);
  const cacheKey = String(marketAddr).toLowerCase();
  const knownNoEvents = marketHasNoEvents(marketAddr);
  let latest;
  try {
    latest = await runner.getBlockNumber();
  } catch {
    return null;
  }

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

  const me = String(campaignAddr).toLowerCase();
  const raw = cursor ? [...cursor.logs] : [];
  const parsed = [];
  const ingest = (logs) => {
    for (const log of logs) {
      let evt;
      try {
        evt = iface.parseLog(log);
      } catch {
        continue;
      }
      if (!evt) continue;
      parsed.push({ ...evt, hash: log.transactionHash, blockNumber: log.blockNumber });
    }
  };
  if (cursor) ingest(cursor.logs);

  for (const [fromBlock, toBlock] of ranges) {
    try {
      const logs = await getLogsWithFailover({ address: marketAddr, fromBlock, toBlock });
      raw.push(...logs);
      ingest(logs);
    } catch {
      if (cursor == null && raw.length === 0) return null;
      marketScanCursor.set(cacheKey, { lastBlock: latest, logs: raw });
      return buildMarketRows(parsed, me);
    }
    if (limit > 0 && buildMarketRows(parsed, me).length >= limit) break;
  }
  marketScanCursor.set(cacheKey, { lastBlock: cursor ? Math.max(cursor.lastBlock, latest) : latest, logs: raw });
  if (!raw.length && cursor == null) {
    if (!knownNoEvents) markMarketNoEvents(marketAddr);
    return [];
  }
  if (!raw.length) return [];
  if (knownNoEvents) clearMarketNoEvents(marketAddr);

  const rows = buildMarketRows(parsed, me);
  const times = await Promise.all([...new Set(rows.map((r) => r.blockNumber))].map((bn) => blockTime(runner, bn)));
  const byBlock = new Map([...new Set(rows.map((r) => r.blockNumber))].map((bn, i) => [bn, times[i]]));
  for (const row of rows) row.ts = byBlock.get(row.blockNumber) ?? null;
  return rows.sort((a, b) => (a.blockNumber - b.blockNumber) || String(a.kind).localeCompare(String(b.kind)));
}

/**
 * 待执行 / Ready 的电路市场成交记录：本期买入 + 挂回卖出 + 市场欠款。
 */
export async function readMarketTrades(campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) return null;
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
    const marketAddr = await readCircuitMarket(c);
    if (!isAddr(marketAddr) || marketAddr === ZeroAddress) return null;
    const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, runner);
    const circuits = await c.circuits().catch(() => ZeroAddress);

    const [boughtCount, heldCount, activeListings] = await Promise.all([
      c.circuitCount().catch(() => 0n),
      c.circuitHeldCount().catch(() => 0n),
      c.activeListingCount().catch(() => 0n),
    ]);
    const owed = await market.owed(campaignAddr).catch(() => 0n);

    const n = Number(boughtCount);
    const ids = n > 0
      ? await Promise.all(Array.from({ length: n }, (_, i) => c.circuitIds(i).catch(() => null)))
      : [];
    const rows = await Promise.all(ids.filter((v) => v != null).map(async (tokenId) => {
      const [cost, listingId] = await Promise.all([
        c.circuitCostBasis(tokenId).catch(() => 0n),
        c.circuitListingId(tokenId).catch(() => 0n),
      ]);
      let listingPrice = 0n;
      if (listingId !== 0n && isAddr(circuits) && circuits !== ZeroAddress) {
        try {
          const live = await market.listingFor(circuits, tokenId);
          if (live.valid && live.id === listingId) listingPrice = live.price;
        } catch {
          listingPrice = 0n;
        }
      }
      return { tokenId, cost, listingId, listingPrice };
    }));

    const spent = rows.reduce((acc, r) => acc + Number(formatEther(r.cost)), 0);
    const buyLegs = boughtCount > 0n ? [{
      side: "buy",
      part: "电路",
      orderId: "—",
      orderQty: Number(boughtCount),
      price: Number(boughtCount) > 0 ? Number(formatEther(rows.reduce((acc, r) => acc + r.cost, 0n) / boughtCount)) : null,
      filled: Number(boughtCount),
      remaining: 0,
      amount: spent,
      status: "settled",
      live: false,
      placedAt: null,
      filledAt: null,
      cancelAt: null,
      confirmedAt: null,
    }] : [];

    const sellLegs = rows
      .filter((r) => r.listingId !== 0n)
      .map((r) => ({
        side: "sell",
        part: "电路",
        orderId: String(r.listingId),
        orderQty: 1,
        price: Number(formatEther(r.listingPrice || r.cost)),
        filled: 0,
        remaining: 1,
        amount: null,
        status: "open",
        live: true,
        placedAt: null,
        filledAt: null,
        cancelAt: null,
        confirmedAt: null,
        tokenId: Number(r.tokenId),
      }));

    const events = await readMarketLogs(runner, marketAddr, campaignAddr).catch(() => null);
    const feed = Array.isArray(events) ? [...events] : [];
    /** 卖出回款取链上事件（卖家实收 = 成交价 − 手续费）；读不到事件就留 0。 */
    const soldFills = feed.filter((row) => row.kind === "fill" && row.side === "sell");
    const sellProceeds = soldFills.reduce((acc, row) => acc + (Number(row.amount) || 0), 0);

    const totals = {
      buyQty: Number(boughtCount),
      buyFilled: Number(boughtCount),
      buySpent: spent,
      sellQty: Number(activeListings) + soldFills.length,
      sellFilled: soldFills.length,
      sellProceeds,
      owed: Number(formatEther(owed)),
      partsHeld: Number(heldCount),
      listed: Number(activeListings),
    };

    return {
      market: marketAddr,
      circuits,
      orderFilled: heldCount > 0n,
      legs: [...buyLegs, ...sellLegs],
      totals,
      events: feed,
      marks: null,
      supportsEvents: feed.length > 0,
    };
  });
}

// ── 原路退款记录（Campaign.Refunded 事件） ──
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
      const logs = await getLogsWithFailover({ address: campaignAddr, fromBlock: from, toBlock, topics });
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
 * 挂单的原始份数 / 已成交份数（Map<id, {listedShares, takenShares, cancelledShares}>）。
 *
 * `getListing` 只给剩余份数：takeListing 成交后把它减到 0 并关单
 * （Campaign.sol:637-638），所以「挂 1 份、成交 1 份」和「挂 0 份」在 storage 里
 * 长得一模一样。事件是唯一能还原原始挂单量的来源：
 *   Listed(id, seller, count, price)            挂单时的份数
 *   ListingTaken(id, buyer, seller, count, paid) 每次成交的份数
 *   ListingCancelled(id, seller, count)          撤单释放的份数
 * 读不到事件时返回空 Map，展示层退回剩余份数（不把未知画成 0）。
 */
async function readListingMeta(runner, campaignAddr) {
  const iface = new Interface(CAMPAIGN_ABI);
  const latest = await runner.getBlockNumber();
  const raw = await readCampaignLogs(
    runner,
    campaignAddr,
    latest,
    [[
      iface.getEvent("Listed").topicHash,
      iface.getEvent("ListingTaken").topicHash,
      iface.getEvent("ListingCancelled").topicHash,
    ]],
    "listing",
  );
  const meta = new Map();
  const slot = (id) => {
    const key = Number(id);
    if (!meta.has(key)) meta.set(key, { listedShares: 0, takenShares: 0, cancelledShares: 0 });
    return meta.get(key);
  };
  for (const log of raw || []) {
    let evt;
    try {
      evt = iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!evt) continue;
    if (evt.name === "Listed") {
      slot(evt.args.id).listedShares += Number(evt.args.count);
    } else if (evt.name === "ListingTaken") {
      slot(evt.args.id).takenShares += Number(evt.args.count);
    } else if (evt.name === "ListingCancelled") {
      slot(evt.args.id).cancelledShares += Number(evt.args.count);
    }
  }
  return meta;
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
      if (evt.name !== "Refunded") continue;
      rows.push({
        holder: String(evt.args.holder),
        amount: Number(formatEther(evt.args.amountBnb)),
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

    const holders = new Set(rows.map((r) => r.holder.toLowerCase()));
    return {
      campaign: campaignAddr,
      events: rows,
      totals: {
        totalRefunded: Number(formatEther(totalRefunded)),
        pool: Number(formatEther(raisedBnb)),
        sold: Number(sold),
        count: rows.length,
        holders: holders.size,
        executionFailed: Boolean(executionFailed),
        listedSum: rows.reduce((acc, r) => acc + r.amount, 0),
      },
      // null 表示扫不到日志（节点不支持历史区间），空数组表示确实还没有退款。
      scanned: Array.isArray(raw),
    };
  });
}


async function campaignsOf(factoryAddr) {
  return withReadProvider(async (provider) => {
    const f = factoryContract(provider, factoryAddr);
    const n = Number(await f.campaignCount());
    const out = await Promise.all(Array.from({ length: n }, (_, i) => f.campaigns(i)));
    return out.reverse();
  });
}

/** 列出当前工厂期次（新→旧）。只读当前工厂，旧工厂不再并入。 */
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
  /**
   * 每项单独 catch：历史期次可能由旧版合约部署，缺 getter 不能让整行变成「—」。
   * 电路数量用 circuitHeldCount()（本期仍持有的 ERC721 张数），不再猜挂单剩余。
   */
  const [scene, sold, totalShares, sharePriceBnb, estHashpower, raisedBnb, circuits, circuitCount, circuitHeldCount] = await Promise.all([
    c.scene().then(Number).catch(() => 0),
    c.sold().then(Number).catch(() => 0),
    c.totalShares().then(Number).catch(() => 0),
    c.sharePriceBnb().then((v) => Number(formatEther(v))).catch(() => 0),
    c.estHashpower().then(Number).catch(() => 0),
    c.raisedBnb().then((v) => Number(formatEther(v))).catch(() => 0),
    c.circuits().catch(() => ZeroAddress),
    c.circuitCount().then(Number).catch(() => 0),
    c.circuitHeldCount().then(Number).catch(() => 0),
  ]);
  // 结束状态不在 scene 里：执行失败与募集到期必须靠这几项判断。旧期次缺 getter 时按未结束处理。
  const [phase, executionFailed, fundingDeadline, totalRefunded, outstandingShares] = await Promise.all([
    c.phase().then(Number).catch(() => 0),
    c.executionFailed().then(Boolean).catch(() => false),
    c.fundingDeadline().then(Number).catch(() => 0),
    c.totalRefunded().then((v) => Number(formatEther(v))).catch(() => 0),
    // 已售未退（当前债务）。退款后变小，sold 不会 —— 判断「是否已全部退回」只能用它。
    c.outstandingShares().then(Number).catch(() => null),
  ]);
  return {
    address,
    scene: Number(scene),
    phase,
    executionFailed,
    fundingDeadline,
    totalRefunded,
    outstandingShares,
    sold: Number(sold),
    totalShares: Number(totalShares),
    sharePriceBnb: Number(sharePriceBnb),
    hashpower: Number(estHashpower),
    estHashpower: Number(estHashpower),
    distributed: 0,
    feeBem: 0,
    raisedBnb: Number(raisedBnb),
    circuitCount,
    circuitHeldCount,
    circuits,
  };
}

// ── 电路市场操作（含测试网 Mock 调试） ──
function parseUintField(raw, label, fallback = null) {
  const text = String(raw ?? "").trim();
  if (!text) {
    if (fallback != null) return fallback;
    throw new Error(`请填写${label}`);
  }
  if (!/^\d+$/.test(text)) throw new Error(`${label}必须是非负整数：${text}`);
  return BigInt(text);
}

// ═══════════════════ 电路市场挂单（官方快照 + 链上复核） ═══════════════════

/**
 * 为什么不能只回看「最近 N 笔挂单」。
 *
 * 官方电路市场的 listing id 是**全市场共用**的一本账。2026-10-26 实测
 * `nextListingId` 已到 26,525：本期集合当时有 257 条有效挂单，落在「最近 200 笔」
 * 里的可挖矿单只有 8 条；最便宜的几张（0.03499 / 0.035）比窗口下沿还老几千个 id，
 * 面板就会显示成「假最低价」。
 *
 * 官方站点已经索引好了全市场挂单：`https://tapeout.net/circuit-market.json`
 * （浏览器走同源 `/tt-api/circuit-market.json`，由 vite / nginx 反代）。我们拿它当
 * **候选名单**，再逐条上链复核 `listingFor` + Lens/撤销状态 —— 秒级出结果，
 * 价格与可买资格仍以链上为准。快照拿不到时才回退窗口扫描，并标明可能漏单。
 */
const CIRCUIT_MARKET_SNAPSHOT_URL = "/tt-api/circuit-market.json";
/**
 * 快照约 3 MB：公共网络实测下载就要 6～15 秒。超时设太短会 abort → 退回窗口扫描 →
 * 面板一直「读取中」。给足余量；真正卡住由 AbortController 收掉。
 */
const SNAPSHOT_FETCH_MS = 60_000;
/** 面板 / 自动买入只需最便宜的一小撮；展示用快照价，买入前再链上复核。 */
const DISPLAY_TOP = 20;
/** 快照失败时的回退窗口（笔）。故意压小：兜底不能再拖成「一直读取中」。 */
const FALLBACK_LOOKBACK = 200;
const _marketIface = new Interface(CIRCUIT_MARKET_ABI);

/** 官方 PoD Lens：`refsEligible` = 倍率 > 0 且网表无 REF（官方 start 前置条件）。 */
const POD_LENS_ABI = [
  "function refsEligible(address circuits, uint256 circuitId) view returns (bool)",
];

function decodeListingFor(raw) {
  if (typeof raw !== "string" || raw.length < 2 + 64 * 4) return null;
  try {
    const v = _marketIface.decodeFunctionResult("listingFor", raw);
    return {
      id: Number(v.id),
      seller: String(v.seller || ""),
      price: BigInt(v.price ?? 0),
      valid: Boolean(v.valid),
    };
  } catch {
    return null;
  }
}

function decodeListingRecord(raw) {
  if (typeof raw !== "string" || raw.length < 2 + 64 * 5) return null;
  try {
    const l = _marketIface.decodeFunctionResult("listings", raw);
    const seller = String(l.seller || "");
    const circuits = String(l.circuits || "").toLowerCase();
    if (!isAddr(seller) || seller === ZeroAddress) return null;
    if (!isAddr(circuits) || circuits === ZeroAddress) return null;
    const price = BigInt(l.price ?? 0);
    if (price <= 0n) return null;
    return { circuits, tokenId: Number(l.tokenId), price, seller };
  } catch {
    return null;
  }
}

/**
 * 拉官方电路市场快照。同源 `/tt-api` 反代到 tapeout.net（见 vite.config.js /
 * tt-api.nginx.conf）。
 *
 * 生产注意：`vite build` 产物不含代理；托管机必须配 `tt-api.nginx.conf`，
 * 否则本函数返回 null，买入面板会退回窗口扫描（能开、但可能漏更早的低价单）。
 * 官方站点不发 CORS，浏览器不能直连 tapeout.net。
 *
 * @returns {Promise<{marketAddr:string, listings:object[]}|null>}
 */
async function fetchOfficialCircuitMarketSnapshot() {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), SNAPSHOT_FETCH_MS) : null;
  try {
    const res = await fetch(CIRCUIT_MARKET_SNAPSHOT_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: ctrl?.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.listings)) return null;
    return {
      marketAddr: String(json.marketAddr || "").toLowerCase(),
      listings: json.listings,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 从官方快照筛出某个集合的**可挖**挂单，按快照价从低到高，带上价格供直接展示。
 *
 * 快照字段口径（与官方页面一致）：
 *   · `valid`：挂单仍在售
 *   · `eligible === true`：可挖；null/false 不进表
 *   · `revoked`：已撤销，不进表
 *
 * 面板展示直接用快照价（官方页同款数据源）；真正付钱前 `buyCircuitsListings`
 * 会再读 `listingFor`，撤单/改价不会按旧价成交。这里再扫一遍链只会把 UI 拖死。
 */
function listingsFromSnapshot(snapshot, marketAddr, circuitsAddr) {
  const wantMarket = String(marketAddr).toLowerCase();
  const want = String(circuitsAddr).toLowerCase();
  if (snapshot.marketAddr && snapshot.marketAddr !== wantMarket) return null;
  const out = [];
  for (const row of snapshot.listings) {
    if (String(row.circuits || "").toLowerCase() !== want) continue;
    if (row.valid === false) continue;
    if (row.revoked === true) continue;
    if (row.eligible !== true) continue;
    const id = Number(row.id);
    const tokenId = Number(row.circuitId ?? row.tokenId);
    const price = BigInt(row.price || 0);
    const seller = String(row.seller || "");
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(tokenId) || price <= 0n) continue;
    out.push({ id, tokenId, price, seller });
  }
  out.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  return out.slice(0, DISPLAY_TOP).map((r) => ({
    ...r,
    priceBnb: Number(formatEther(r.price)),
  }));
}

/**
 * 逐条上链复核候选挂单：撤单、成交、改价、换集合都在这里被链上事实纠正。
 * 复核失败不静默跳过 —— 少一条就可能让 Owner 以为「没有更便宜的」。
 */
async function verifyListings(runner, marketAddr, circuitsAddr, candidates) {
  if (!candidates.length) return [];
  const calls = candidates.map((c) => ({
    to: marketAddr,
    data: _marketIface.encodeFunctionData("listingFor", [circuitsAddr, c.tokenId]),
  }));
  const raws = [];
  for (let i = 0; i < calls.length; i += 8) {
    const slice = calls.slice(i, i + 8);
    let chunk;
    try {
      chunk = await callBatchWithFailover(slice);
    } catch {
      chunk = await Promise.all(slice.map((c) => runner.call(c).catch(() => null)));
      if (chunk.every((r) => r == null)) {
        throw new Error("复核电路市场挂单失败（公共节点限流或超时），请稍后重试");
      }
    }
    raws.push(...chunk);
  }
  const rows = [];
  raws.forEach((raw, i) => {
    const live = decodeListingFor(raw);
    if (!live || !live.valid) return;
    if (live.id !== candidates[i].id) return; // 该 token 已被重新挂过，旧 id 作废
    if (live.price <= 0n) return;
    rows.push({
      id: candidates[i].id,
      tokenId: candidates[i].tokenId,
      price: live.price,
      seller: live.seller,
    });
  });
  return rows;
}

/**
 * 读「能不能挖」的官方判据，一次批量算完。
 *
 * 两条规则叠加，缺一条就会把砖头当矿机卖：
 *   1. Lens `refsEligible`：processorMultiplier > 0 且网表没有 REF 引用；
 *   2. 矿工状态 `status != 2`：2 = 被官方撤销，这张电路永远不能再开矿。
 *      （实测 token 13945：refsEligible = true、getMiner.status = 2）
 *
 * 读不到时返回 null（未知），不静默隐藏；只有链上明确返回不可挖的才过滤。
 *
 * @returns {Promise<Map<number, boolean|null>>}
 */
async function readMineableMap(runner, circuitsAddr, tokenIds) {
  const out = new Map();
  if (!tokenIds.length) return out;
  const lensOn = isAddr(POD_LENS_ADDRESS);
  const miningOn = isAddr(POD_MINING_ADDRESS);
  if (!lensOn && !miningOn) return out;

  const lensIface = new Interface(POD_LENS_ABI);
  const miningIface = new Interface(POD_MINING_ABI);
  const calls = [];
  const plan = [];
  for (const tokenId of tokenIds) {
    if (lensOn) {
      calls.push({
        to: POD_LENS_ADDRESS,
        data: lensIface.encodeFunctionData("refsEligible", [circuitsAddr, tokenId]),
      });
      plan.push({ tokenId, kind: "lens" });
    }
    if (miningOn) {
      const key = keccak256(solidityPacked(["address", "uint256"], [circuitsAddr, tokenId]));
      calls.push({ to: POD_MINING_ADDRESS, data: miningIface.encodeFunctionData("getMiner", [key]) });
      plan.push({ tokenId, kind: "miner" });
    }
  }

  const raws = [];
  for (let i = 0; i < calls.length; i += 40) {
    const slice = calls.slice(i, i + 40);
    let chunk;
    try {
      chunk = await callBatchWithFailover(slice);
    } catch {
      chunk = await Promise.all(slice.map((c) => runner.call(c).catch(() => null)));
    }
    raws.push(...chunk);
  }

  plan.forEach(({ tokenId, kind }, i) => {
    const raw = raws[i];
    if (typeof raw !== "string" || raw.length <= 2) return;
    try {
      if (kind === "lens") {
        const ok = Boolean(lensIface.decodeFunctionResult("refsEligible", raw)[0]);
        if (!ok) out.set(tokenId, false);
        else if (!out.has(tokenId)) out.set(tokenId, true);
      } else {
        const miner = miningIface.decodeFunctionResult("getMiner", raw)[0];
        if (Number(miner.circuitId) !== Number(tokenId)) return;
        if (Number(miner.status) === 2) out.set(tokenId, false);
        else if (!out.has(tokenId)) out.set(tokenId, null);
      }
    } catch {
      /* 解码失败 = 未知 */
    }
  });
  return out;
}

/**
 * 快照拿不到时的兜底：回看最近 FALLBACK_LOOKBACK 笔挂单 id。
 * 可能漏掉更早的低价单，调用方应在 UI 标明。
 */
async function scanRecentListingCandidates(runner, marketAddr, circuitsAddr, lookback = FALLBACK_LOOKBACK) {
  const want = String(circuitsAddr).toLowerCase();
  const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, runner);
  const next = await market.nextListingId();
  const latest = Number(next) - 1;
  if (latest <= 0) return [];
  const first = Math.max(1, latest - lookback + 1);
  const ids = [];
  for (let id = latest; id >= first; id--) ids.push(id);

  const found = [];
  // 每批 8 个（与 callBatchWithFailover 的 BATCH_MAX 对齐），避免一次塞 40 个在公共节点上排队超时。
  for (let i = 0; i < ids.length; i += 8) {
    const slice = ids.slice(i, i + 8);
    const calls = slice.map((id) => ({
      to: marketAddr,
      data: _marketIface.encodeFunctionData("listings", [id]),
    }));
    let raws;
    try {
      raws = await callBatchWithFailover(calls);
    } catch {
      raws = await Promise.all(calls.map((c) => runner.call(c).catch(() => null)));
    }
    raws.forEach((raw, k) => {
      const rec = decodeListingRecord(raw);
      if (!rec || rec.circuits !== want) return;
      found.push({ id: slice[k], tokenId: rec.tokenId, price: rec.price });
    });
  }
  found.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  return found.slice(0, DISPLAY_TOP).map(({ id, tokenId }) => ({ id, tokenId }));
}

/**
 * 把窗口扫描候选变成「可买、可挖、已按价排序」的最终列表（仅快照失败时走这里）。
 */
async function finalizeListings(runner, marketAddr, circuitsAddr, candidates) {
  const capped = candidates.length > DISPLAY_TOP ? candidates.slice(0, DISPLAY_TOP) : candidates;
  const live = await verifyListings(runner, marketAddr, circuitsAddr, capped);
  const mineable = await readMineableMap(runner, circuitsAddr, live.map((r) => r.tokenId));
  return live
    .filter((row) => mineable.get(row.tokenId) !== false)
    .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0))
    .map((r) => ({ ...r, priceBnb: Number(formatEther(r.price)) }));
}

/**
 * 读某个集合的在售卖单（Owner 买入面板 + 自动挑单）。
 *
 * 主路径：拉官方 `circuit-market.json`，筛可挖后按价取前 DISPLAY_TOP —— **不再逐条 eth_call**，
 * 否则 3 MB 快照 + 几十次 RPC 会让面板卡在「读取中」。付钱前仍有链上复核。
 * 兜底：快照失败才扫最近 FALLBACK_LOOKBACK 笔（小窗口，避免再拖死）。
 *
 * @returns {Promise<Array<{id:number,tokenId:number,price:bigint,seller:string,priceBnb:number}>>}
 */
export async function readCircuitListingsFor(marketAddr, circuitsAddr) {
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) return [];
  if (!isAddr(circuitsAddr) || circuitsAddr === ZeroAddress) return [];
  const want = String(circuitsAddr).toLowerCase();

  // 快照不需要 eth_call，先拉；成功则立刻返回，不进 withReadProvider。
  const snap = await fetchOfficialCircuitMarketSnapshot();
  if (snap) {
    const rows = listingsFromSnapshot(snap, marketAddr, want);
    if (rows) {
      rows.source = "snapshot";
      return rows;
    }
  }

  return withReadProvider(async (runner) => {
    const candidates = await scanRecentListingCandidates(runner, marketAddr, want);
    const rows = await finalizeListings(runner, marketAddr, want, candidates);
    rows.source = "fallback";
    return rows;
  });
}

/**
 * 全局读电路市场卖单（多集合）。同样走官方快照 + 链上复核。
 */
export async function readCircuitMarketSnapshot(marketAddr, collections = []) {
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) return null;
  return withReadProvider(async (runner) => {
    const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, runner);
    const [feeBps, next] = await Promise.all([market.feeBps(), market.nextListingId()]);
    const allow = [...new Set((collections || []).filter(isAddr).map((a) => String(a).toLowerCase()))];
    const snap = await fetchOfficialCircuitMarketSnapshot();

    const rows = [];
    const targets = allow.length ? allow : [];
    if (!targets.length && snap) {
      for (const row of snap.listings) {
        const c = String(row.circuits || "").toLowerCase();
        if (isAddr(c) && !targets.includes(c)) targets.push(c);
      }
    }
    for (const circuit of targets) {
      let live = snap ? listingsFromSnapshot(snap, marketAddr, circuit) : null;
      if (!live) {
        const candidates = await scanRecentListingCandidates(runner, marketAddr, circuit);
        live = await finalizeListings(runner, marketAddr, circuit, candidates);
      }
      for (const row of live) rows.push({ ...row, circuits: circuit });
    }

    rows.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    const floors = {};
    for (const row of rows) {
      const key = String(row.circuits).toLowerCase();
      const unit = Number(formatEther(row.price));
      if (!(key in floors) || unit < floors[key]) floors[key] = unit;
    }
    return {
      market: marketAddr,
      circuitMarket: marketAddr,
      feeBps: Number(feeBps),
      nextListingId: Number(next - 1n),
      listings: rows.map((r) => ({ ...r, price: Number(formatEther(r.price)) })),
      floors,
    };
  });
}

/** 自动挑单走同一套读取，保证「最便宜」与买入面板同口径。 */
async function scanCircuitListings(campaign, market) {
  const marketAddr = await market.getAddress();
  const circuits = String(await campaign.circuits());
  return readCircuitListingsFor(marketAddr, circuits);
}

/**
 * 本期从市场买入电路：按价格从低到高挑 maxQty 张，且单价不超过 maxPriceWei。
 * 采购款从本期 raisedBnb 出（buyCircuits 是 non-payable），不需要 msg.value。
 */
async function buyCircuitsFromMarket(signer, maxQty, maxPriceWei) {
  const campaign = signerOrThrow(signer);
  const marketAddr = await campaign.circuitMarket();
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) throw new Error("本期没有配置电路市场");
  const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, signer);
  const all = await scanCircuitListings(campaign, market);
  if (all.length === 0) throw new Error("市场里还没有本期电路的卖单，等卖方挂单后再试");
  const qty = Math.max(1, Math.floor(Number(maxQty) || 1));
  const budget = BigInt(maxPriceWei ?? 0);
  const affordable = budget > 0n ? all.filter((l) => BigInt(l.price) <= budget) : all;
  if (affordable.length === 0) {
    throw new Error(`没有单价 ≤ ${formatEther(budget)} BNB 的卖单（市场最低 ${formatEther(all[0].price)} BNB）`);
  }
  const picks = affordable.slice(0, qty);
  return campaign.buyCircuits(
    picks.map((l) => l.id),
    picks.map((l) => l.tokenId),
    picks.map((l) => l.price),
  );
}

/**
 * 买入**指定的**市场挂单（Owner 面板勾选模式）。
 *
 * 与按数量自动挑单的区别：这里按 listingId 精确吃单，UI 勾哪几张就买哪几张。
 * 价格与归属**不采信前端缓存**：每笔都在链上重读 `listings(id)` 和
 * `listingFor(circuits, tokenId)`，挂单被撤、被成交、换了集合、改了价，
 * 都在签名前就拒掉 —— 否则整批买会在链上 revert，白付 gas。
 *
 * @param {object} signer ethers Signer
 * @param {Array<{id:number|string, tokenId:number|string}>} picks
 */
async function buyCircuitsListings(signer, picks) {
  const campaign = signerOrThrow(signer);
  const marketAddr = await campaign.circuitMarket();
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) throw new Error("本期没有配置电路市场");
  const circuitsAddr = String(await campaign.circuits());
  if (!isAddr(circuitsAddr) || circuitsAddr === ZeroAddress) throw new Error("本期没有锁定电路合约（ERC721）");
  const list = Array.isArray(picks) ? picks : [];
  if (list.length === 0) throw new Error("请先勾选要买入的电路挂单");

  const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, signer);
  const ids = [];
  const tokenIds = [];
  const prices = [];
  const seen = new Set();
  for (const pick of list) {
    const id = BigInt(Math.floor(Number(pick?.id ?? -1)));
    const tokenId = BigInt(Math.floor(Number(pick?.tokenId ?? -1)));
    if (id <= 0n || tokenId < 0n) throw new Error("勾选的挂单无效，请刷新市场卖单后重选");
    if (seen.has(String(id))) continue; // 同一挂单只吃一次
    seen.add(String(id));
    const l = await market.listings(id);
    if (String(l.circuits).toLowerCase() !== circuitsAddr.toLowerCase()) {
      throw new Error(`挂单 #${id} 不属于本期锁定的电路合约，请刷新市场卖单`);
    }
    if (BigInt(l.tokenId) !== tokenId) {
      throw new Error(`挂单 #${id} 的 tokenId 已变化，请刷新市场卖单`);
    }
    const live = await market.listingFor(l.circuits, l.tokenId);
    if (!live.valid || BigInt(live.id) !== id) {
      throw new Error(`挂单 #${id} 已被撤单或成交，请刷新市场卖单`);
    }
    if (BigInt(live.price) !== BigInt(l.price)) {
      throw new Error(`挂单 #${id} 的单价已变化，请刷新市场卖单`);
    }
    ids.push(id);
    tokenIds.push(tokenId);
    prices.push(l.price);
  }
  if (ids.length === 0) throw new Error("没有可买入的挂单");
  return campaign.buyCircuits(ids, tokenIds, prices);
}

/** 把本期持有的一张电路挂回市场；价格缺省 = 该 token 的买入成本（合约下限）。 */
async function listHeldCircuit(signer, tokenId, priceWei) {
  const campaign = signerOrThrow(signer);
  const id = parseUintField(tokenId, "电路 tokenId");
  let price = priceWei != null ? BigInt(priceWei) : 0n;
  if (price <= 0n) price = await campaign.circuitCostBasis(id);
  if (price <= 0n) throw new Error("读不到该电路的买入成本，请显式给出挂单价");
  return campaign.listCircuit(id, price);
}

/** 测试网 Mock：mint 一张电路给当前钱包，approve 市场并挂出卖单。 */
async function simulateExternalListing(signer, tokenId, price) {
  const campaign = signerOrThrow(signer);
  const circuitsAddr = await campaign.circuits();
  const marketAddr = await campaign.circuitMarket();
  if (!isAddr(circuitsAddr) || circuitsAddr === ZeroAddress) throw new Error("本期没有配置电路合约");
  const circuits = new Contract(circuitsAddr, MOCK_CIRCUIT_ABI, signer);
  const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, signer);
  const id = parseUintField(tokenId, "电路 tokenId", 1n);
  const unit = parseEther(String(price || "0"));
  if (unit <= 0n) throw new Error("挂单价必须大于 0");
  const me = await signer.getAddress();
  await (await circuits.mint(me, id)).wait();
  await (await circuits.approve(marketAddr, id)).wait();
  return market.list(circuitsAddr, id, unit);
}

/** 测试网 Mock：当前钱包作为外部买家吃一张市场卖单。 */
async function simulateBuyListing(signer, listingId) {
  const campaign = signerOrThrow(signer);
  const marketAddr = await campaign.circuitMarket();
  const market = new Contract(marketAddr, CIRCUIT_MARKET_ABI, signer);
  const id = parseUintField(listingId, "挂单 ID");
  const l = await market.listings(id);
  const live = await market.listingFor(l.circuits, l.tokenId);
  if (!live.valid) throw new Error(`挂单 #${id} 已成交或已撤销`);
  return market.buy(id, l.price, { value: l.price });
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
  claimBem: (signer, address) => signerOrThrow(signer, address).claimBem(),
  claimMiningRewards: (signer, address) => signerOrThrow(signer, address).claimMiningRewards(),
  setServiceFee: (signer, bps, recipients, sharesBps) =>
    signerOrThrow(signer).setServiceFee(bps, recipients, sharesBps),
  listShares: (signer, count, price) => signerOrThrow(signer).listShares(count, price),
  cancelListing: (signer, id) => signerOrThrow(signer).cancelListing(id),
  takeListing: (signer, id, count, valueWei) => signerOrThrow(signer).takeListing(id, count, { value: valueWei }),

  // 电路市场：买入按「最多 N 张、单价不超过 P」自动挑单。
  confirmCircuits: (signer) => signerOrThrow(signer).confirmCircuits(),
  withdrawMarketProceeds: (signer) => signerOrThrow(signer).withdrawMarketProceeds(),
  listCircuit: (signer, tokenId, priceWei) => listHeldCircuit(signer, tokenId, priceWei),
  cancelCircuitListing: (signer, tokenId) =>
    signerOrThrow(signer).cancelCircuitListing(parseUintField(tokenId, "电路 tokenId")),
  // 原样批量买入（高级用法；UI 用 buyCircuitsFromMarket 自动挑单）。
  buyCircuits: (signer, listingIds, tokenIds, prices) =>
    signerOrThrow(signer).buyCircuits(listingIds, tokenIds, prices),
  buyCircuitsFromMarket: (signer, qty, maxPriceWei) => buyCircuitsFromMarket(signer, qty, maxPriceWei),
  /** 精确买入勾选的挂单（UI 用）。id/tokenId 来自市场实时读数，价格在链上重读。 */
  buyCircuitsListings: (signer, picks) => buyCircuitsListings(signer, picks),

  simulateBuyListing: (signer, id) => simulateBuyListing(signer, id),
  simulateExternalListing: (signer, tokenId, price) => simulateExternalListing(signer, tokenId, price),

  openRefund: (signer) => signerOrThrow(signer).openRefund(),
  /**
   * 确认到账后立刻把没花完的募集款按份退回（不结束本期、电路留在合约、之后仍可 startMining）。
   * 合约在 startMining 里也会自动做同一件事，所以这一步是可选的「提前退」。
   */
  returnSurplus: (signer) => signerOrThrow(signer).returnSurplus(),
  /**
   * Owner 自掏腰包补齐「被电路吃掉」的本金缺口，让池子重新能按原价退完所有份额。
   * 买入之后想收摊（openRefund / abandonOrder）必须先走这一步，否则链上 CircuitsAreCollateral。
   */
  topUpShortfall: (signer, value) => signerOrThrow(signer).topUpShortfall({ value }),
  abandonOrder: (signer) => signerOrThrow(signer).abandonOrder(),
  markFailed: (signer, address) => signerOrThrow(signer, address).markFailed(),
  setPhase: (signer, next) => signerOrThrow(signer).setPhase(next),
  setPlan: (signer, est) => signerOrThrow(signer).setPlan(est),
  halt: (signer) => signerOrThrow(signer).halt(),
  resume: (signer) => signerOrThrow(signer).resume(),
  // 官方 PoD 挖矿：taskId 0 = 未验证池（UI 默认），已验证池需先 armMining 再下一块 startMining。
  armMining: (signer, tokenId) => signerOrThrow(signer).armMining(tokenId),
  startMining: (signer, tokenId, taskId = 0, anchorBlock = 0, inputs = [], expectedOuts = [], proofs = []) =>
    signerOrThrow(signer).startMining(tokenId, taskId, anchorBlock, inputs, expectedOuts, proofs),
  stopMining: (signer, tokenId) => signerOrThrow(signer).stopMining(tokenId),
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
  setCircuitMarket: (signer, circuitMarket) => signerOrThrow(signer).setCircuitMarket(circuitMarket),
  // 无参：一次扫走所有可动 BNB（多余余额，或已无人可退时的整池）。
  recoverBnb: (signer, address) => signerOrThrow(signer, address).recoverBnb(),
  recoverCircuits: (signer, token, id) => signerOrThrow(signer).recoverCircuits(token, id),
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

/** 读 Owner。 */
export async function readFactoryOwner() {
  if (!isAddr(FACTORY_ADDRESS)) return "";
  const f = factoryContract(getReadProvider());
  return await f.owner();
}


/**
 * 读工厂的电路合约白名单（部署时写入、之后不可增删）。
 *
 * 这是安全边界，不是运营开关：主网上防止 owner 把期次指向
 * MockCircuitNft（其 mint 无访问控制，任何人能无限造电路，
 * 「电路已到账」的检查形同虚设）。所以开期表单的可选电路
 * 应该**从链上白名单生成**，而不是硬编码前端列表。
 *
 * 读不到就返回空数组，UI 如实显示「未配置白名单」，不拿前端列表冒充链上事实。
 */
export async function readAllowedCircuits() {
  if (!isAddr(FACTORY_ADDRESS)) return [];
  try {
    return await withReadProvider(async (runner) => {
      const f = factoryContract(runner);
      const n = Number(await f.allowedCircuitsCount());
      if (!Number.isFinite(n) || n <= 0) return [];
      const out = [];
      for (let i = 0; i < n; i++) out.push(await f.allowedCircuitsAt(i));
      return out;
    });
  } catch {
    return [];
  }
}

/** 兼容旧引用。 */
export const readAllowedParts = readAllowedCircuits;

/** ERC721 的 supportsInterface 标识（ERC-165）。 */
const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC165_INTERFACE_ID = "0x01ffc9a7";

/**
 * 校验一个地址能不能当「本期电路合约」。
 *
 * 开期第 4 参是**真实的 ERC721 电路集合**，不能只看地址格式：
 *   1. 有代码（不是 EOA / 写错的地址）；
 *   2. 实现 ERC-165 且声明 ERC721（`supportsInterface(0x80ac58cd)`）；
 *   3. 在工厂白名单内（工厂已部署时才读得到；读不到返回 null = 未知）。
 * 不满足 1/2 的地址发上链也只会 revert，所以前端必须先挡住。
 *
 * @param {string} address 候选 ERC721 合约
 * @returns {Promise<{address:string,hasCode:boolean,isErc721:boolean,whitelisted:boolean|null,name:string,totalSupply:number|null,reason:string}>}
 */
export async function readCircuitContractInfo(address) {
  const addr = String(address || "").trim();
  const info = {
    address: addr,
    hasCode: false,
    isErc721: false,
    whitelisted: null,
    name: "",
    totalSupply: null,
    reason: "",
  };
  if (!isAddr(addr) || addr === ZeroAddress) {
    info.reason = "地址格式不正确";
    return info;
  }
  try {
    info.hasCode = await withReadProvider(async (runner) => (await runner.getCode(addr)) !== "0x");
  } catch {
    info.hasCode = false;
  }
  if (!info.hasCode) {
    info.reason = "该地址没有合约代码";
    return info;
  }
  const nftInfo = await withReadProvider(async (runner) => {
    const nft = new Contract(
      addr,
      [
        "function supportsInterface(bytes4) view returns (bool)",
        "function name() view returns (string)",
        "function totalSupply() view returns (uint256)",
      ],
      runner,
    );
    const [erc721, erc165, name, supply] = await Promise.all([
      nft.supportsInterface(ERC721_INTERFACE_ID).catch(() => false),
      nft.supportsInterface(ERC165_INTERFACE_ID).catch(() => false),
      nft.name().catch(() => ""),
      nft.totalSupply().then((v) => Number(v)).catch(() => null),
    ]);
    return { erc721: Boolean(erc721), erc165: Boolean(erc165), name, supply };
  }).catch(() => ({ erc721: false, erc165: false, name: "", supply: null }));

  info.isErc721 = Boolean(nftInfo.erc721 && nftInfo.erc165);
  info.name = nftInfo.name;
  info.totalSupply = nftInfo.supply;

  if (isAddr(FACTORY_ADDRESS)) {
    info.whitelisted = await withReadProvider((runner) =>
      factoryContract(runner).isAllowedCircuits(addr).catch(() => null)
    ).catch(() => null);
  }

  if (!info.isErc721) info.reason = "该合约不是 ERC721";
  else if (info.whitelisted === false) info.reason = "该 ERC721 不在工厂白名单";
  else info.reason = "";
  return info;
}

/**
 * 开期：预检 Owner → staticCall → 发交易 → 解析新地址（事件失败则读 campaigns[n-1]）。
 * 当前工厂开期需 份额单价 / 总份数 / 募集天数 / 电路合约 四个参数；
 * 电路市场由工厂在部署时写入（不可变）。
 *
 * 电路合约（第 4 参 circuits）是**必选的 ERC721 集合**：零地址一律 revert，
 * 且必须在工厂白名单内（主网白名单 = 官方 TapeOut / Behemoth 电路合约）。
 * 白名单是安全边界：不在白名单里的 ERC721 会被工厂直接拒绝。
 */
const CREATE_CURRENT =
  "function createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint64 fundingSeconds,address circuits) returns (address)";

const SECONDS_PER_DAY = 86400;

function createArgs(params) {
  const sharePriceWei = params.sharePriceWei != null
    ? BigInt(params.sharePriceWei)
    : parseBnb(String(params.sharePriceBnb ?? "0"));
  const days = Number(params.fundingDays ?? 0);
  const fundingSeconds = params.fundingSeconds != null
    ? BigInt(params.fundingSeconds)
    : BigInt(Math.max(1, Math.trunc(days)) * SECONDS_PER_DAY);
  // 电路合约：必选，原样透传。空串/零地址会触发工厂 revert（前端已预校验必选）。
  const circuitsArg = String(params.circuits || "").trim();
  return [sharePriceWei, params.totalShares, fundingSeconds, circuitsArg];
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
      `需 Owner 钱包签名。当前 ${caller.slice(0, 6)}…${caller.slice(-4)}，Owner 为 ${owner.slice(0, 6)}…${owner.slice(-4)}`
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
    if (!campaign) throw new Error("开期已确认，但没解析到新 Campaign 地址，请刷新或从顶栏切换期次");
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
    // 同一个错误既可能来自工厂（开期/移除），也可能来自某期合约（本期 owner-only 入口），
    // 所以不能像旧文案那样写死「无法开期」。
    return `当前钱包${caller ? `（${String(caller).slice(0, 10)}…）` : ""}不是 Owner：工厂级操作只允许 Owner，本期操作只允许本期 owner。`;
  }
  if (parsed?.name === "Halted") {
    return "本期已熔断：认筹、挂单、卖出、开矿与份额交易暂停；退款、领款、撤单不受影响。等 Owner 解除后再试。";
  }
  if (parsed?.name === "AlreadyHalted") return "本期已熔断，无需重复操作。";
  if (parsed?.name === "NotHalted") return "本期未熔断，无需解除。";
  if (parsed?.name === "NotSoldOutYet") return "份数还没售完，不能开始执行（需 sold == totalShares）。";
  if (parsed?.name === "UseReturnSurplus") {
    return "电路已到账：不能退款或放弃采购。可退余款 + 开矿或挂回市场；确要结束本期，先改回待挂单。";
  }
  if (parsed?.name === "SurplusAlreadyReturned") {
    return "余款已按份退回，本金已在持份人手里。再退款会清零份额（合约拒绝），留着等开矿即可。";
  }
  if (parsed?.name === "AlreadyMining") return "这张电路已经在挖矿，无需重复开始。";
  if (parsed?.name === "NotListed") return "这张电路当前没有挂单，无需撤单。";
  if (parsed?.name === "ZeroShares") return "数量为 0：份数 / 份额 / 余款分母不能为 0。";
  if (parsed?.name === "ZeroPrice") return "金额或单价不能为 0。";
  if (parsed?.name === "FundingEnded") return "募集已过截止时间，不能再认筹。";
  if (parsed?.name === "ExceedsRemaining") return "认筹份数超过剩余可售份数。";
  if (parsed?.name === "WrongPayment") return "支付金额与「份数 × 每份价格」不一致。";
  if (parsed?.name === "ServiceFeeAlreadySet") return "挖矿产出服务费已设定并永久锁定，不能再改。";
  if (parsed?.name === "ServiceFeeLocked") return "已有人认购，挖矿产出服务费永久锁定，不能再改。";
  if (parsed?.name === "BadFeeConfig") {
    return "服务费配置不合法：费率上限 10%、分成地址最多 3 个、份额合计 10000 bps。";
  }
  if (parsed?.name === "NoListing") return "挂单不存在（可能已成交或已撤单），刷新后再试。";
  if (parsed?.name === "NotSeller") return "只能撤销自己发布的挂单。";
  if (parsed?.name === "CannotTakeOwnListing") return "不能接收自己发布的挂单。";
  if (parsed?.name === "InsufficientShares") return "可用份额不足：挂出的份额会立即锁定，不能重复使用。";
  if (parsed?.name === "BadCount") return "数量不合法：不能为 0，也不能超过可用数量。";
  if (parsed?.name === "NoRewards") return "当前没有正在挖矿的电路，暂无可领取奖励。";
  if (parsed?.name === "DirectTransferNotAllowed") {
    return "不能直接向本期合约转 BNB，请用页面按钮操作。";
  }
  if (parsed?.name === "BadListingId") return "挂单 ID 无效（不存在或不属于本期电路）。";
  if (parsed?.name === "BadListing") return "电路市场没有这张挂单（可能已成交或已撤销）。";
  if (parsed?.name === "PriceMismatch") return "挂单价已变化：市场要求按最新价支付，刷新后重试。";
  if (parsed?.name === "NothingOwed") return "电路市场没有可提取的卖出款。";
  if (parsed?.name === "TransferFailed") return "BNB 转账失败（收款地址拒收或 gas 不足），整笔回滚，可重试。";
  if (parsed?.name === "ZeroCampaignParam") return "每份价格或总份数不能为 0";
  if (parsed?.name === "CircuitsNotReady") {
    return "电路还没到账，不能确认或开矿：先买入电路并确认本期合约真的持有 NFT。";
  }
  if (parsed?.name === "AlreadyListed") return "当前子状态不允许这一步：有电路正在市场挂单，请先撤单。";
  if (parsed?.name === "AlreadyReady") return "本期已到账，电路锁在合约里。只能开矿或挂回市场。";
  if (parsed?.name === "ProceedsPending") return "市场还有未提取的卖出款，先提取（withdrawMarketProceeds）再继续。";
  if (parsed?.name === "NotACircuit") return "这张挂单的标的不是本期白名单电路合约。";
  if (parsed?.name === "NotACircuitOwner") return "本期合约不持有这张电路 NFT。";
  if (parsed?.name === "CircuitNotDelivered") return "市场成交了，但电路 NFT 没有转到本期合约（CircuitNotDelivered）。";
  if (parsed?.name === "TooManyCircuits") return "一次买入的电路张数超过合约上限（TooManyCircuits）。";
  if (parsed?.name === "CircuitStillListed") return "还有电路挂在市场：先全部撤单再开矿。";
  if (parsed?.name === "PriceBelowCost") return "挂单价低于本期买入成本，合约拒绝亏本挂出。";
  if (parsed?.name === "SelfTrade") return "不能买回本期自己挂出的电路。";
  if (parsed?.name === "InsufficientCircuits") return "合约里的电路数量不够。";
  if (parsed?.name === "SharesOutstanding") {
    return "还有持份人没结清，电路是他们的抵押，不能取出。先退款 / 领完，或开矿。";
  }
  if (parsed?.name === "HoldersNotMadeWhole") {
    return "持份人还没按原价收回本金，电路不能交给 Owner。先补齐缺口再退款，或开矿 / 卖出。";
  }
  if (parsed?.name === "CircuitsAreCollateral") {
    return "电路还在合约里，池子不够按原价退完。先补齐本金，或开矿 / 卖出。";
  }
  if (parsed?.name === "RefundNotAvailable") {
    return "当前状态不能退款：只有募集超时或待采购可退。";
  }
  if (parsed?.name === "ZeroAddress") return "地址不能为零地址（电路市场 / 电路合约 / 挖矿合约 / 收款地址）";
  if (parsed?.name === "IndexOutOfBounds") return "索引越界：列表 / 页数超出范围，刷新后再试。";
  if (parsed?.name === "EmptyWhitelist") return "白名单不能为空：至少填一个允许的电路合约地址。";
  if (parsed?.name === "CircuitsNotAllowed") {
    const p = parsed.args?.circuits || parsed.args?.[0];
    return `电路合约不在工厂白名单：${p ? `${String(p).slice(0, 10)}… ` : ""}白名单部署时已固化，请改选白名单内的 ERC721 电路合约。`;
  }
  if (parsed?.name === "WrongScene") {
    return "当前阶段不允许这一步（WrongScene）：按页面提示的下一步操作，或先撤单 / 确认到账。";
  }
  if (parsed?.name === "Reentrancy") {
    return "重入保护触发（Reentrancy）：上一笔还在处理中，等确认后再试。";
  }
  if (parsed?.name === "ERC721InvalidReceiver") {
    return "本期合约收不了电路 NFT（缺 onERC721Received）。当前已开的期次无法买入，需重新部署工厂并开新期。";
  }
  if (parsed?.name) return `合约拒绝：${parsed.name}`;
  return "";
}

/** 钱包有时把整段 calldata / 超长 hex 塞进 message，不能当错误文案展示。 */
function isOpaqueHexBlob(text) {
  const t = String(text || "").trim();
  return /^0x[0-9a-fA-F]{24,}$/i.test(t);
}

function decodeRevert(err, iface) {
  const data = nestedErrorData(err);
  const raw = nestedErrorText(err) || "交易失败";
  const selectors = [];
  if (data) selectors.push(data);
  for (const match of raw.matchAll(/"(0x[0-9a-fA-F]{8,})"/g)) selectors.push(match[1]);
  // 有的钱包把整个 calldata 或 revert data 直接当 message。
  if (isOpaqueHexBlob(raw)) selectors.push(raw.trim());
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
  // OZ ERC721InvalidReceiver(address) 选择子，即便 ABI 未挂上也能认。
  for (const blob of selectors) {
    const hex = String(blob || "");
    if (/^0x64a0ae92/i.test(hex)) {
      return explainParsed({ name: "ERC721InvalidReceiver", args: [] });
    }
  }
  if (/no data present/i.test(raw)) {
    return "合约拒绝了这笔交易，钱包没带回原因。请确认钱包权限与当前子状态。";
  }
  if (/missing revert data/i.test(raw)) {
    return "节点没带回失败原因。请把钱包 BSC 节点改成 https://bsc-rpc.publicnode.com 后重试。";
  }
  if (/usage limit|1rpc\.io|#pricing|-32001/i.test(raw)) {
    return "RPC 额度用尽。请硬刷新本页，并把钱包 BSC 节点改成 https://bsc-rpc.publicnode.com。";
  }
  if (/could not coalesce error|403|archive|personal token/i.test(raw)) {
    return "公共节点拒绝了这次模拟。刷新重试；如钱包提示更新 BSC 网络，点确认。";
  }
  if (/insufficient funds|exceeds the balance/i.test(raw)) {
    return "钱包 BNB 不够付 gas（开一期约 0.0002 BNB）。";
  }
  if (isOpaqueHexBlob(raw) || /0x6038f07a/i.test(raw)) {
    return "买入模拟失败：本期合约收不了电路 NFT（缺 onERC721Received）。需重新部署并开新期后才能买入。";
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
      throw new Error("钱包 RPC 连不上。请把 BSC 测试网节点改成 https://bsc-testnet-rpc.publicnode.com 后重试。");
    }
    const iface = new Interface(Array.from(new Set([
      ...FACTORY_ABI,
      ...CAMPAIGN_ABI,
      ...CIRCUIT_MARKET_ABI,
      // ABI 里没有的补充错误（旧版本 / 钱包转发时只给选择子）。
      "error NotOwner(address caller)",
      "error AlreadyMinted()",
      "error NotApproved()",
      // OZ ERC721：官方市场 safeTransferFrom 时，收款合约缺 Receiver 会抛这个。
      "error ERC721InvalidReceiver(address receiver)",
    ])));
    let decoded = decodeRevert(err, iface);
    const txReq = err?.transaction;
    // 钱包常把 calldata / 空原因塞进 message；用公共节点 eth_call 重放拿真实 revert。
    const needReplay = txReq?.to && txReq?.data && (
      /钱包没有带回具体原因|missing revert|no data present|节点没带回/i.test(decoded)
      || isOpaqueHexBlob(decoded)
      || /0x6038f07a/i.test(decoded)
      || decoded === "交易失败"
    );
    if (needReplay) {
      try {
        await getReadProvider().call({
          to: txReq.to,
          data: txReq.data,
          from: txReq.from,
          value: txReq.value && txReq.value !== "0x0" ? txReq.value : undefined,
        });
      } catch (replay) {
        const again = decodeRevert(replay, iface);
        if (again && !isOpaqueHexBlob(again)) decoded = again;
      }
    }
    throw new Error(decoded);
  }
}
