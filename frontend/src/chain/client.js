// 链上对接客户端（ethers v6）。读取 Campaign 实时状态、发送写交易。
// 无钱包时用公共 RPC 只读；有钱包（window.ethereum）时签名发送。
import { BrowserProvider, FetchRequest, JsonRpcProvider, Network, Contract, Interface, formatEther, parseEther, ZeroAddress } from "ethers";
import { CAMPAIGN_ABI, FACTORY_ABI, MATERIAL_MARKET_ABI, MOCK_PARTS_ABI } from "./abis.js";
import {
  CAMPAIGN_ADDRESS,
  FACTORY_ADDRESS,
  CHAIN_ID,
  CHAIN_ID_HEX,
  NETWORK,
  IS_CONFIGURED,
  SCENE_LABEL,
  PHASE_LABEL,
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
    nandQty, latchQty, priceLock, soldOutAt, executionFailed, raisedBnb, totalRefunded,
    fundingDeadline, transistorsAddr, marketAddr, factoryAddr, owner, halted, pooled, miningPool,
    listingCount, totalPendingSurplus, orderFilled,
    outstandingShares, serviceFeeBps, serviceFeeSet, feeRecipientCount,
    revenuePool, surplusPool, lastOrderAt, surplusBase, surplusPaid,
  ] = await Promise.all([
    c.scene(), c.phase(), c.sold(), c.totalShares(), c.sharePriceBnb(),
    withDefault(c.estHashpower(), 0n),
    withDefault(c.nandQty(), 0n), withDefault(c.latchQty(), 0n),
    withDefault(c.priceLock(), 0n),
    withDefault(c.soldOutAt(), 0n),
    withDefault(c.executionFailed(), false),
    c.raisedBnb(),
    withDefault(c.totalRefunded(), 0n),
    c.fundingDeadline(), c.transistors(), c.materialMarket(), c.factory(),
    c.owner(),
    withDefault(c.halted(), false),
    withDefault(c.pooled(), false),
    withDefault(c.miningPool(), ZeroAddress),
    withDefault(c.listingCount(), 0n),
    withDefault(c.totalPendingSurplus(), 0n),
    withDefault(c.orderFilled(), false),
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
  const order = await readMarketOrder(c);

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
  // 工厂已移除该期时，cancelTransistorOrder 允许任何人撤剩余单（合约里的 _retired 口径）。
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
     * 晶体管数 = **已成交到账量**（各腿 挂单量 − 市场 remaining），不是挂单量。
     * 合约在 placeTransistorOrder 就把 nandQty/latchQty 写成下单量，
     * 拿它当「已买入」会让「等待成交」的期次显示已买到晶体管（数据自相矛盾）。
     * 挂单量本身仍通过 nandQty/latchQty 暴露，供挂单进度展示。
     */
    transistorCount: Number(order.nandFilled ?? 0n) + Number(order.latchFilled ?? 0n), capped: false,
    owner, fundingDeadline: Number(fundingDeadline),
    /** 熔断状态：true 时认筹/挂单/卖晶体管/入池/份额挂单与接单全部停，pulls 与撤单不受影响。 */
    halted: Boolean(halted),
    listings,
    ...order,
    pooled, miningPool,
    // 开期即写入的晶体管合约优先；挂单后的 market 字段若为空也不要盖掉
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
    /** 入池后未发出去的余款池：surplusPool 是累计已记账，surplusBase 是本轮的分母。 */
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
    const [shares, escrow, refunded, bnbBal, pendingSurplus, surplusOfRaw] = await Promise.all([
      c.sharesOf(account), c.escrowOf(account),
      c.refundedOf(account), runner.getBalance(account),
      c.pendingSurplus(account).catch(() => 0n),
      // 入池后的余款改 pull 模式：surplusOf 会把「还没计提但已可领」的部分也算进来。
      c.surplusOf(account).catch(() => 0n),
    ]);
    /** 可领余款 = max(surplusOf, pendingSurplus)：surplusOf 含尚未计提的部分。 */
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
    case "transistors":
      return state.transistors || "—";
    case "market":
    case "materialMarket":
      return state.market || "—";
    case "marketOpenOrders":
      return readMarketBook(campaignAddr);
    case "marketBids":
      return withReadProvider((runner) => readMarketBidView(runner, campaignAddr, args.id || 1));
    case "marketSellable":
      return withReadProvider(async (runner) => {
        const c = campaignContract(runner, campaignAddr);
        const marketAddr = await readMaterialMarket(c);
        const transistors = await c.transistors().catch(() => ZeroAddress);
        const bids = await readSellableBids(runner, marketAddr, transistors, campaignAddr);
        if (!bids.length) return "没有可吃的买单（标的是本期晶体管且有剩余量）";
        return bids
          .map((b) => `买单 #${b.id} · ${TOKEN_LABEL[b.tokenId]} 剩余 ${b.remaining} · 单价 ${formatEther(b.price)} BNB · 买家 ${shortAddr(b.buyer)}`)
          .join("\n");
      });
    case "marketOwed":
      return withReadProvider((runner) => readMarketOwedView(runner, campaignAddr, args.account));
    case "executionFailed":
      return state.executionFailed ? "是（已判执行失败）" : "否";
    case "halted":
      return state.halted
        ? "已熔断：认筹、挂单、卖出、入池与份额交易已停"
        : "运行中";
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

/** 读本期接的晶体管市场地址；读不到按零地址处理（展示层显示「未配置」）。 */
async function readMaterialMarket(c) {
  try {
    const a = await c.materialMarket();
    return isAddr(a) && a !== ZeroAddress ? a : ZeroAddress;
  } catch {
    return ZeroAddress;
  }
}

/**
 * 本期挂单 / 卖出席位读数。
 *
 * 本期合约的买单与成本基准 getter 一定存在，读失败属于 RPC 异常，直接返回空值让
 * 页面显示「未挂单」，不把它伪装成「旧合约」；市场侧读数（remaining / owed / 可吃买单）
 * 单独降级，缺一项不影响其余字段。
 */
async function readMarketOrder(c) {
  const empty = {
    nandBidId: 0n, latchBidId: 0n, nandQty: 0n, latchQty: 0n,
    nandPrice: 0n, latchPrice: 0n, transistors: ZeroAddress, orderFilled: false,
    nandCostBasis: 0n, latchCostBasis: 0n,
    partsNand: 0n, partsLatch: 0n, marketOwed: 0n, sellBids: [], sellSide: false,
    nandFilled: 0n, latchFilled: 0n,
  };
  try {
    const [
      nandBidId, latchBidId, nandQty, latchQty, nandPrice, latchPrice, transistors, orderFilled,
      nandCostBasis, latchCostBasis,
    ] = await Promise.all([
      c.nandBidId(), c.latchBidId(), c.nandQty(), c.latchQty(), c.nandPrice(), c.latchPrice(),
      c.transistors(), c.orderFilled(),
      c.nandCostBasis().catch(() => 0n), c.latchCostBasis().catch(() => 0n),
    ]);
    const marketAddr = await readMaterialMarket(c);
    const [nandRemaining, latchRemaining] = await Promise.all([
      readLegRemaining(c.runner, marketAddr, nandBidId, nandQty),
      readLegRemaining(c.runner, marketAddr, latchBidId, latchQty),
    ]);
    const sell = await readMarketSell(c, marketAddr, transistors);
    /**
     * 成交到账量 —— 与「挂单量」是两个不同的东西，不能混用。
     * 合约在 placeTransistorOrder 时就把 nandQty/latchQty 写成**下单量**，
     * 只有撤单 _clearOrder 才清零。所以「已经买到几颗」必须用市场剩余量反推：
     *   filled = 挂单量 − bids(id).remaining
     * 挂单还在等成交时 remaining == qty → filled = 0。
     * 撤单后 bid id 归零、qty 也被清，此时手里还留着的晶体管（余额）就是当初成交到的量。
     */
    const filledOf = (qty, remaining, bidId, held) => {
      if (bidId !== 0n) {
        const rem = remaining == null ? qty : remaining;
        return qty > rem ? qty - rem : 0n;
      }
      return held || 0n;
    };
    const nandFilled = filledOf(nandQty, nandRemaining, nandBidId, sell.partsNand);
    const latchFilled = filledOf(latchQty, latchRemaining, latchBidId, sell.partsLatch);
    return {
      nandBidId, latchBidId, nandQty, latchQty, nandPrice, latchPrice, transistors, orderFilled,
      nandCostBasis, latchCostBasis,
      nandRemaining, latchRemaining, nandFilled, latchFilled, ...sell,
    };
  } catch {
    return empty;
  }
}

/**
 * 卖出侧读数。官方晶体管市场**没有卖单簿**，所以这里不存在"本期挂着的卖单"，
 * 只有三样东西：合约手里的晶体管余额、市场欠本期的款、以及**可以吃的外部买单**。
 */
async function readMarketSell(c, marketAddr, transistors) {
  const blank = { partsNand: 0n, partsLatch: 0n, marketOwed: 0n, sellBids: [], sellSide: false };
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) return blank;
  const holder = c.target;
  try {
    const [partsNand, partsLatch, marketOwed, sellBids] = await Promise.all([
      readPartBalance(c.runner, transistors, holder, 0),
      readPartBalance(c.runner, transistors, holder, 1),
      readMarketOwed(c.runner, marketAddr, holder),
      readSellableBids(c.runner, marketAddr, transistors, holder),
    ]);
    return { partsNand, partsLatch, marketOwed, sellBids, sellSide: true };
  } catch {
    return blank;
  }
}

/**
 * 挑出本期能吃的外部买单：标的是本期晶体管合约、还有剩余量、买家不是本期自己。
 * 全部读 `bids(id)`，不扫日志；只回看最近 500 张，按单价从高到低（同价新单在前）。
 */
async function readSellableBids(runner, marketAddr, transistors, holder) {
  const market = new Contract(marketAddr, MATERIAL_MARKET_ABI, runner);
  let next = 1n;
  try {
    next = await market.nextBidId();
  } catch {
    return [];
  }
  const first = next > 500n ? next - 500n : 1n;
  const ids = [];
  for (let i = next - 1n; i >= first && ids.length < 20; i--) ids.push(i);
  const rows = await Promise.all(ids.map(async (bidId) => {
    try {
      const b = await market.bids(bidId);
      if (b.remaining === 0n) return null;
      if (!isAddr(b.transistors) || b.transistors.toLowerCase() !== String(transistors).toLowerCase()) return null;
      if (String(b.buyer).toLowerCase() === String(holder).toLowerCase()) return null;
      return {
        id: bidId,
        tokenId: Number(b.tokenId),
        price: BigInt(b.price),
        remaining: BigInt(b.remaining),
        feeBps: Number(b.feeBps),
        buyer: b.buyer,
      };
    } catch {
      return null;
    }
  }));
  return rows
    .filter(Boolean)
    .sort((a, b) => (a.price === b.price ? Number(b.id - a.id) : a.price > b.price ? -1 : 1));
}

async function readPartBalance(runner, transistors, holder, tokenId) {
  if (!transistors || transistors === ZeroAddress || !holder) return 0n;
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

/** 卖出成交款先落在市场 owed，不提取的话 openRefund / depositToPool 会被合约拒绝。 */
async function readMarketOwed(runner, marketAddr, account) {
  if (!marketAddr || marketAddr === ZeroAddress || !account) return 0n;
  try {
    const market = new Contract(marketAddr, ["function owed(address) view returns (uint256)"], runner);
    return await market.owed(account);
  } catch {
    return 0n;
  }
}

// ── 晶体管市场（Mock）调试：查看订单簿 + 模拟卖方/买方成交 ──
const TOKEN_LABEL = ["NAND", "LATCH"];
const shortAddr = (a) => (isAddr(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || "—"));

/** 本期合约接的晶体管市场，并确认它带 Mock 订单簿（nextBidId / bids）。 */
async function marketHandle(runner, campaignAddr = getCampaignAddress()) {
  const campaign = campaignContract(runner, campaignAddr);
  const marketAddr = await readMaterialMarket(campaign);
  if (!isAddr(marketAddr) || marketAddr === ZeroAddress) {
    throw new Error("本期合约没有配置晶体管市场（market 为 0）。");
  }
  const market = new Contract(marketAddr, MATERIAL_MARKET_ABI, runner);
  try {
    await market.nextBidId();
  } catch {
    throw new Error("这期接的晶体管市场没有 Mock 订单簿（nextBidId 调用失败），不能模拟撮合。");
  }
  return { campaign, market, marketAddr };
}

/** 列出市场里所有未成交的买单，供调试页直接看。市场没有卖单侧，所以只有买单。 */
export async function readMarketBook(campaignAddr = getCampaignAddress()) {
  return withReadProvider(async (runner) => {
    const { market, marketAddr } = await marketHandle(runner, campaignAddr);
    const nextBid = await market.nextBidId();
    const lines = [`市场 ${shortAddr(marketAddr)}`];
    // 上限 500 张，并发读：串行 500 次 RPC 会让调试页转十几秒。
    const top = nextBid - 1n > 500n ? 500n : nextBid - 1n;
    const ids = [];
    for (let i = 1n; i <= top; i++) ids.push(i);
    const bids = await Promise.all(ids.map((id) => market.bids(id).catch(() => null)));
    let open = 0;
    bids.forEach((b, idx) => {
      if (!b || b.remaining === 0n) return;
      open += 1;
      lines.push(`买单 #${ids[idx]} · ${TOKEN_LABEL[Number(b.tokenId)] || b.tokenId} 剩余 ${b.remaining} · 单价 ${formatEther(b.price)} BNB · 买家 ${shortAddr(b.buyer)}`);
    });
    if (open === 0) lines.push("订单簿没有未成交买单");
    return lines.join("\n");
  });
}

async function readMarketBidView(runner, campaignAddr, id) {
  const { market } = await marketHandle(runner, campaignAddr);
  const bidId = parseUintField(id, "买单 ID");
  const b = await market.bids(bidId);
  return `买单 #${bidId} · ${TOKEN_LABEL[Number(b.tokenId)] || b.tokenId} · 买家 ${shortAddr(b.buyer)} · 单价 ${formatEther(b.price)} BNB · 剩余 ${b.remaining} · 手续费 ${b.feeBps} bps`;
}

async function readMarketOwedView(runner, campaignAddr, account) {
  const { market } = await marketHandle(runner, campaignAddr);
  return `${formatEther(await market.owed(account || campaignAddr))} BNB`;
}

// ── 待执行状态的晶体管市场成交记录 ──
const MARKET_LOG_WINDOWS = 6; // 最多回看 6 × 50k 块（约 10 天）；凑满条数会提前停
const MARKET_LOG_SPAN = 50_000;
/** 历史交易记录只保留最近这么多条（窄栏放不下更多，也不该翻旧账）。 */
export const MARKET_TRADE_LIMIT = 5;
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
    "TransistorOrderPlaced",
    "TransistorOrderCancelled",
    "TransistorsSold",
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
 * 市场事件 → 历史交易记录行。只认「先出现 BidPlaced 且买方是本期」的订单号，
 * 再按订单号收该单的成交与撤回 —— 否则把别人的成交也画进来。
 * 卖出是原子吃单（没有 AskPlaced），记录由 readMarketTradesOnce 用 TransistorsSold 补齐。
 */
function buildMarketRows(parsed, me) {
  const bidIds = new Set();
  const bidMeta = new Map();
  for (const e of parsed) {
    if (e.name === "BidPlaced" && String(e.args.buyer).toLowerCase() === me) {
      bidIds.add(String(e.args.id));
      bidMeta.set(String(e.args.id), { price: e.args.price, part: TOKEN_LABEL[Number(e.args.tokenId)] || String(e.args.tokenId) });
    }
  }

  const rows = [];
  for (const e of parsed) {
    const id = e.args?.id != null ? String(e.args.id) : "";
    const isBid = e.name.startsWith("Bid");
    if (isBid && !bidIds.has(id)) continue;
    if (e.name === "ProceedsWithdrawn" && String(e.args.account).toLowerCase() !== me) continue;
    let row;
    if (e.name === "BidPlaced") {
      row = { kind: "place", side: "buy", id, qty: e.args.quantity, price: e.args.price, amount: null, part: TOKEN_LABEL[Number(e.args.tokenId)] || String(e.args.tokenId) };
    } else if (e.name === "BidFilled") {
      const meta = bidMeta.get(id) || {};
      /**
       * 晶体管市场：BidFilled(id, seller, quantity, proceeds, fee) —— fee 恒 1%，
       * 买家为这批晶体管付出的托管额 = proceeds + fee。
       * Mock：BidFilled(id, quantity, remaining) —— 没有金额，留空。
       */
      let amount = null;
      if (e.args.proceeds != null && e.args.fee != null) {
        try { amount = (BigInt(e.args.proceeds) + BigInt(e.args.fee)).toString(); } catch { amount = null; }
      }
      row = { kind: "fill", side: "buy", id, qty: e.args.quantity, remaining: e.args.remaining, price: meta.price ?? null, part: meta.part || "—", amount };
    } else if (e.name === "BidCancelled") {
      row = { kind: "cancel", side: "buy", id, amount: e.args.refund };
    } else if (e.name === "ProceedsWithdrawn") {
      row = { kind: "withdraw", side: "sell", id: "", amount: e.args.amount };
    } else {
      continue;
    }
    rows.push({ ...row, txHash: e.hash, blockNumber: e.blockNumber, ts: null });
  }
  return rows;
}

/**
 * 历史交易记录只需最近 MARKET_TRADE_LIMIT 条，所以从最新窗口往旧翻，
 * 够数就停 —— 不再固定扫满 6 个窗口（6 × 5 万块 ≈ 10 天，光等节点就要好几秒）。
 */
async function readMarketLogs(runner, marketAddr, campaignAddr, limit = MARKET_TRADE_LIMIT) {
  const iface = new Interface(MATERIAL_MARKET_ABI);
  const cacheKey = String(marketAddr).toLowerCase();
  // 曾判过「没有事件」的市场：不再整段跳过，只探最新一个窗口 —— 判错（早先节点读不到）
  // 时能自己恢复，不用等 10 分钟 TTL。
  const knownNoEvents = marketHasNoEvents(marketAddr);
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
      // 节点限制区间：首次探测失败就当旧版市场（没有事件）；增量失败下次再补。
      if (cursor == null && raw.length === 0) return null;
      marketScanCursor.set(cacheKey, { lastBlock: latest, logs: raw });
      return buildMarketRows(parsed, me);
    }
    // 最新窗口往往就够了：凑满 limit 条即停，不再往更早的窗口翻。
    if (limit > 0 && buildMarketRows(parsed, me).length >= limit) break;
  }
  marketScanCursor.set(cacheKey, { lastBlock: cursor ? Math.max(cursor.lastBlock, latest) : latest, logs: raw });
  // 扫完整个回看区间仍然一条事件都没有：记下「没有事件」，之后每次只探最新窗口。
  if (!raw.length && cursor == null) {
    if (!knownNoEvents) markMarketNoEvents(marketAddr);
    return [];
  }
  if (!raw.length) return [];
  if (knownNoEvents) clearMarketNoEvents(marketAddr);

  const rows = buildMarketRows(parsed, me);
  const needsTime = rows;
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

/**
 * 待执行状态的晶体管市场成交记录：本期买单 + 卖出记录 + 市场欠款。
 * 官方市场没有卖单簿，卖出是原子吃单，所以卖出的每一笔都来自本期的 TransistorsSold 事件。
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
      transistors, ordered,
    ] = await Promise.all([
      c.nandBidId().catch(() => 0n), c.latchBidId().catch(() => 0n),
      c.nandQty().catch(() => 0n), c.latchQty().catch(() => 0n),
      c.nandPrice().catch(() => 0n), c.latchPrice().catch(() => 0n),
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
        /* 晶体管合约不可读时按 0 处理 */
      }
    }

    // 市场事件只覆盖买单侧（挂单 / 成交 / 撤回 / 提取）；卖出记录来自本期的 TransistorsSold。
    const events = await readMarketLogs(runner, marketAddr, campaignAddr).catch(() => null);

    let marks = null;
    try {
      const latest = await runner.getBlockNumber();
      marks = await readTradeMarks(runner, campaignAddr, latest);
    } catch {
      marks = null;
    }
    const bidPlaced = lastMark(marks, "TransistorOrderPlaced");
    const bidCancel = lastMark(marks, "TransistorOrderCancelled");
    const confirmed = lastMark(marks, "TransistorsConfirmed");

    /**
     * 卖出腿：官方市场没有卖单簿，卖出是"吃一张已挂买单"的原子动作，不存在挂着的卖单。
     * 每笔卖出都来自本期的 TransistorsSold(bidId, tokenId, quantity, proceeds)；
     * proceeds 已扣 1% 市场费，所以这里的单价是**净得款单价**，不假装是挂价。
     */
    const sellEvents = [];
    if (Array.isArray(marks)) {
      for (const m of marks) {
        if (m.name !== "TransistorsSold") continue;
        const qty = Number(m.args?.quantity || 0);
        let proceeds = 0n;
        try { proceeds = BigInt(m.args?.proceeds || "0"); } catch { proceeds = 0n; }
        const tokenId = Number(m.args?.tokenId || 0);
        const part = TOKEN_LABEL[tokenId] || String(tokenId);
        const netPrice = qty > 0 ? formatEther(proceeds / BigInt(qty)) : null;
        legs.push({
          side: "sell",
          part,
          orderId: String(m.args?.bidId || ""),
          orderQty: qty || null,
          price: netPrice,
          filled: qty || null,
          remaining: 0,
          amount: formatEther(proceeds),
          status: "settled",
          live: false,
          placedAt: null,
          filledAt: m.ts ?? null,
          cancelAt: null,
          confirmedAt: null,
        });
        sellEvents.push({
          kind: "fill",
          side: "sell",
          id: String(m.args?.bidId || ""),
          qty: qty || null,
          price: null,
          amount: String(proceeds),
          part,
          txHash: m.txHash,
          blockNumber: m.blockNumber,
          ts: m.ts ?? null,
        });
      }
    }

    for (const leg of legs) {
      if (leg.side !== "buy") continue;
      leg.placedAt = bidPlaced?.ts ?? null;
      leg.cancelAt = bidCancel && bidPlaced && bidCancel.blockNumber >= bidPlaced.blockNumber
        ? bidCancel.ts ?? null
        : null;
      // 只有确认发生在本次挂单之后，才算这一单到账，避免把上一轮的时间贴到新单上。
      leg.confirmedAt = confirmed && bidPlaced && confirmed.blockNumber >= bidPlaced.blockNumber
        ? confirmed.ts ?? null
        : null;
    }

    /**
     * 时间优先取市场事件本身：给的是**这一单**（按订单号）的挂出 / 成交 / 撤回时刻，
     * 比本期合约的「最近一次挂单」更准。
     */
    if (Array.isArray(events) && events.length) {
      const byId = new Map();
      for (const evt of events) {
        if (!evt.id) continue;
        const row = byId.get(String(evt.id)) || {};
        if (evt.kind === "place" && row.placedAt == null) row.placedAt = evt.ts ?? null;
        if (evt.kind === "fill" && row.filledAt == null) row.filledAt = evt.ts ?? null;
        if (evt.kind === "cancel" && row.cancelAt == null) row.cancelAt = evt.ts ?? null;
        byId.set(String(evt.id), row);
      }
      for (const leg of legs) {
        const ts = byId.get(String(leg.orderId));
        if (!ts) continue;
        if (leg.placedAt == null) leg.placedAt = ts.placedAt ?? null;
        if (leg.filledAt == null) leg.filledAt = ts.filledAt ?? null;
        if (leg.cancelAt == null) leg.cancelAt = ts.cancelAt ?? null;
      }
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

    const feed = Array.isArray(events) ? [...events, ...sellEvents] : sellEvents;
    feed.sort((a, b) => (a.blockNumber || 0) - (b.blockNumber || 0));

    return {
      market: marketAddr,
      orderFilled: Boolean(ordered),
      legs,
      totals,
      events: feed,
      marks,
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
  const [nandQtyBn, latchQtyBn, nandBidId, latchBidId, marketAddr] = await Promise.all([
    c.nandQty().catch(() => 0n),
    c.latchQty().catch(() => 0n),
    c.nandBidId().catch(() => 0n),
    c.latchBidId().catch(() => 0n),
    readMaterialMarket(c).catch(() => ZeroAddress),
  ]);
  const [nandRemaining, latchRemaining] = await Promise.all([
    readLegRemaining(runner, marketAddr, nandBidId, nandQtyBn).catch(() => null),
    readLegRemaining(runner, marketAddr, latchBidId, latchQtyBn).catch(() => null),
  ]);
  /**
   * 晶体管数 = 已成交到账量（挂单量 − 市场剩余），不是挂单量。
   * 挂单未成交时 remaining == qty → 0；撤单后 ids/qty 归零，也就没有在途采购。
   * 拿 nandQty + latchQty 当「已买入」会让等待成交的期次显示已买到晶体管。
   */
  const filledOf = (qty, remaining) => (remaining == null ? 0 : Math.max(0, Number(qty) - Number(remaining)));
  const transistorCount = filledOf(nandQtyBn, nandRemaining) + filledOf(latchQtyBn, latchRemaining);
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
    transistorCount: Number(transistorCount),
    transistors,
  };
}

// ── 模拟晶体管市场对手方成交（测试网调试） ──
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
    throw new Error(`已成交，但补发晶体管失败：${msg}。可能不是 MockERC1155，请手动 mint。`);
  }
}

/** 卖方成交一张买单：fillBid 扣减剩余，再把晶体管 mint 给买家（MockERC1155.mint 公开）。 */
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

/** 一键撮合本期全部买单：两条腿都 fillBid 并补齐晶体管，随后可直接 confirmTransistors。 */
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
    // 晶体管按「本期还缺多少」补，不按买单剩余量补。
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
  if (!last) throw new Error("本期买单已全部成交且晶体管已到账，直接点「确认到账」即可");
  return last;
}

/** 模拟一个外部买家：用当前钱包挂一张买单，供本期 Owner 吃单卖出（仅测试网 Mock）。 */
async function placeExternalBid(signer, tokenId, price, quantity) {
  const c = signerOrThrow(signer);
  const { market } = await marketHandle(signer);
  const part = parseUintField(tokenId, "晶体管编号", 0n);
  if (part > 1n) throw new Error("晶体管编号只能是 0（NAND）或 1（LATCH）");
  const unit = parseEther(String(price));
  if (!(unit > 0n)) throw new Error("单价必须大于 0");
  const qty = parseUintField(quantity, "数量", 1n);
  if (qty <= 0n) throw new Error("数量必须大于 0");
  return market.placeBid(await c.transistors(), part, unit, qty, { value: unit * qty });
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
  placeTransistorOrder: (signer, nandQty, nandPrice, latchQty, latchPrice) =>
    signerOrThrow(signer).placeTransistorOrder(nandQty, nandPrice, latchQty, latchPrice),
  sellTransistors: (signer, bidId, tokenId, quantity) =>
    signerOrThrow(signer).sellTransistors(bidId, tokenId, quantity),
  withdrawMarketProceeds: (signer) => signerOrThrow(signer).withdrawMarketProceeds(),
  simulateFillBid: (signer, id, quantity) => fillBidWithParts(signer, id, quantity),
  simulateExternalBid: (signer, tokenId, price, quantity) => placeExternalBid(signer, tokenId, price, quantity),
  simulateFillCampaignBids: (signer) => fillCampaignBids(signer),
  openRefund: (signer) => signerOrThrow(signer).openRefund(),
  /**
   * 确认到账后立刻把没花完的募集款按份退回（不结束本期、晶体管留在合约、之后仍可 depositToPool）。
   * 合约在 depositToPool 里也会自动做同一件事，所以这一步是可选的「提前退」。
   */
  returnSurplus: (signer) => signerOrThrow(signer).returnSurplus(),
  /**
   * Owner 自掏腰包补齐「被晶体管吃掉」的本金缺口，让池子重新能按原价退完所有份额。
   * 买入之后想收摊（openRefund / abandonOrder）必须先走这一步，否则链上 PartsAreCollateral。
   */
  topUpShortfall: (signer, value) => signerOrThrow(signer).topUpShortfall({ value }),
  abandonOrder: (signer) => signerOrThrow(signer).abandonOrder(),
  cancelTransistorOrder: (signer) => signerOrThrow(signer).cancelTransistorOrder(),
  markFailed: (signer, address) => signerOrThrow(signer, address).markFailed(),
  confirmTransistors: (signer) => signerOrThrow(signer).confirmTransistors(),
  setPhase: (signer, next) => signerOrThrow(signer).setPhase(next),
  setPlan: (signer, est) => signerOrThrow(signer).setPlan(est),
  halt: (signer) => signerOrThrow(signer).halt(),
  resume: (signer) => signerOrThrow(signer).resume(),
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
  // 无参：一次扫走所有可动 BNB（多余余额，或已无人可退时的整池）。
  recoverBnb: (signer, address) => signerOrThrow(signer, address).recoverBnb(),
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

/** 读 Owner。 */
export async function readFactoryOwner() {
  if (!isAddr(FACTORY_ADDRESS)) return "";
  const f = factoryContract(getReadProvider());
  return await f.owner();
}


/**
 * 读工厂的晶体管合约白名单（部署时写入、之后不可增删）。
 *
 * 这是安全边界，不是运营开关：主网上防止 owner 把期次指向
 * MockERC1155（其 mint 无访问控制，任何人能无限造晶体管，
 * 「晶体管已到账」的检查形同虚设）。所以开期表单的可选处理器
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
 * 当前工厂开期需 份额单价 / 总份数 / 募集天数 / 晶体管合约 四个参数；
 * 晶体管市场由工厂默认写入（不可变）。
 *
 * 晶体管合约（第 4 参 transistors）是**必选的处理器**：零地址一律 revert（工厂不再有默认晶体管），
 * 且必须在工厂白名单内（主网白名单 = 官方两件套 TapeOut / Behemoth 的晶体管合约）。
 * 白名单是安全边界：不在白名单里的 ERC1155 会被工厂直接拒绝。
 * 开期人必须在前端从白名单里显式选一个——前端不允许留空（见 App.chainCreateCampaign 的预校验）。
 */
const CREATE_CURRENT =
  "function createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint64 fundingSeconds,address transistors) returns (address)";

const SECONDS_PER_DAY = 86400;

function createArgs(params) {
  // 开期需 份额单价 / 总份数 / 募集天数 / 晶体管合约。
  // 单价以 BNB（十进制）传入，这里转 wei；
  // 天数在这里换成秒——工厂收 fundingSeconds，不再自己做 × 1 days。
  const sharePriceWei = params.sharePriceWei != null
    ? BigInt(params.sharePriceWei)
    : parseBnb(String(params.sharePriceBnb ?? "0"));
  const days = Number(params.fundingDays ?? 0);
  const fundingSeconds = params.fundingSeconds != null
    ? BigInt(params.fundingSeconds)
    : BigInt(Math.max(1, Math.trunc(days)) * SECONDS_PER_DAY);
  // 晶体管合约（处理器）：必选，原样透传。空串/零地址会触发工厂 revert（前端已预校验必选）。
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
    return "本期已熔断：认筹、挂单、卖出、入池与份额交易暂停；退款、领款、撤单不受影响。等 Owner 解除后再试。";
  }
  if (parsed?.name === "AlreadyHalted") return "本期已熔断，无需重复操作。";
  if (parsed?.name === "NotHalted") return "本期未熔断，无需解除。";
  if (parsed?.name === "NotSoldOutYet") return "份数还没售完，不能挂买单（placeTransistorOrder 要求 sold == totalShares）。";
  if (parsed?.name === "UseReturnSurplus") {
    return "晶体管已到账：不能退款或放弃挂单。可退余款 + 入池或卖入买单；确要结束本期，先改回待挂单。";
  }
  if (parsed?.name === "SurplusAlreadyReturned") {
    return "余款已按份退回，本金已在持份人手里。再退款会清零份额（合约拒绝），留着等入池即可。";
  }
  if (parsed?.name === "AlreadyPooled") return "本期已入池（不可逆），不能重复入池，也不能再卖晶体管或退余款。";
  if (parsed?.name === "NotListed") return "当前没有挂着的买单，无需撤单。";
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
  if (parsed?.name === "PoolNotSet") return "还没设置矿池地址：先 setMiningPool，再 depositToPool。";
  if (parsed?.name === "DirectTransferNotAllowed") {
    return "不能直接向本期合约转 BNB，请用页面按钮操作。";
  }
  if (parsed?.name === "BadBidId") return "买单 ID 无效（不存在或不属于本期晶体管）。";
  if (parsed?.name === "TransferFailed") return "BNB 转账失败（收款地址拒收或 gas 不足），整笔回滚，可重试。";
  // 注：BadFee / BadFeeShares 已从合约移除（合约没有服务费字段），不再解码——
  // 留着会让用户看到「服务费须在 1–20%」，误以为链上有服务费机制。
  if (parsed?.name === "ZeroCampaignParam") return "每份价格或总份数不能为 0";
  if (parsed?.name === "TransistorsNotReady") {
    return "晶体管还没到账，不能确认或入池：买单需全部成交，晶体管要真在本期合约里。";
  }
  if (parsed?.name === "AlreadyListed") return "当前子状态不允许这一步：挂单中请先取消；已到账的期次不能再下单或退款。";
  if (parsed?.name === "AlreadyReady") return "本期已到账，晶体管锁在合约里。只能入池或卖入买单。";
  if (parsed?.name === "ProceedsPending") return "市场还有未提取的卖出款，先提取（withdrawMarketProceeds）再继续。";
  if (parsed?.name === "NotABid") return "这张买单不能卖：已成交或撤回、标的不是本期晶体管、或剩余量不够。";
  if (parsed?.name === "PriceBelowCost") return "这张买单单价低于本期买入成本，不能亏本卖出。";
  if (parsed?.name === "SelfTrade") return "不能把本期晶体管卖给本期自己挂的买单。";
  if (parsed?.name === "OrderFilled") return "买单已全部成交，不能再取消。";
  if (parsed?.name === "NoProceeds") return "这张买单成交后没有款项进本期，合约拒绝白送晶体管。";
  if (parsed?.name === "InsufficientParts") return "合约里的晶体管数量不够。";
  if (parsed?.name === "SharesOutstanding") {
    return "还有持份人没结清，晶体管是他们的抵押，不能取出。先退款 / 领完，或入池。";
  }
  if (parsed?.name === "HoldersNotMadeWhole") {
    return "持份人还没按原价收回本金，晶体管不能交给 Owner。先补齐缺口再退款，或入池 / 卖出。";
  }
  if (parsed?.name === "PartsAreCollateral") {
    return "晶体管还在合约里，池子不够按原价退完。先补齐本金，或入池 / 卖出。";
  }
  if (parsed?.name === "RefundNotAvailable") {
    return "当前状态不能退款：只有募集超时或待挂单可退。";
  }
  if (parsed?.name === "ZeroAddress") return "地址不能为零地址（晶体管市场 / 晶体管合约 / 矿池 / 收款地址）";
  if (parsed?.name === "IndexOutOfBounds") return "索引越界：列表 / 页数超出范围，刷新后再试。";
  if (parsed?.name === "EmptyWhitelist") return "白名单不能为空：至少填一个允许的晶体管合约地址。";
  if (parsed?.name === "PartsNotAllowed") {
    const p = parsed.args?.parts || parsed.args?.[0];
    // 白名单在工厂部署时写死，链上没有增删入口 —— 只能换用白名单内的晶体管合约重新开期。
    return `晶体管合约不在工厂白名单：${p ? `${String(p).slice(0, 10)}… ` : ""}白名单部署时已固化，请改选白名单内的处理器。`;
  }
  if (parsed?.name === "WrongScene") {
    return "当前阶段不允许这一步（WrongScene）：按页面提示的下一步操作，或先撤单 / 确认到账。";
  }
  if (parsed?.name === "Reentrancy") {
    return "重入保护触发（Reentrancy）：上一笔还在处理中，等确认后再试。";
  }
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
    const iface = new Interface([
      ...FACTORY_ABI,
      ...CAMPAIGN_ABI,
      "error NotOwner(address caller)",
      "error ZeroAddress()",
      "error ZeroCampaignParam()",
      "error IndexOutOfBounds()",
      "error EmptyWhitelist()",
      "error PartsNotAllowed(address parts)",
      "error Halted()",
      "error AlreadyHalted()",
      "error NotHalted()",
      "error WrongScene()",
      "error FundingEnded()",
      "error TransistorsNotReady()",
      "error RefundNotAvailable()",
      "error ZeroShares()",
      "error ZeroPrice()",
      "error BadCount()",
      "error InsufficientShares()",
      "error SharesOutstanding()",
      "error HoldersNotMadeWhole()",
      "error PartsAreCollateral()",
      "error ExceedsRemaining()",
      "error WrongPayment()",
      "error NoListing()",
      "error NotSeller()",
      "error CannotTakeOwnListing()",
      "error AlreadyListed()",
      "error NotListed()",
      "error AlreadyReady()",
      "error TransferFailed()",
      "error OrderFilled()",
      "error BadBidId()",
      "error ProceedsPending()",
      "error NotABid()",
      "error PriceBelowCost()",
      "error SelfTrade()",
      "error NoProceeds()",
      "error InsufficientParts()",
      "error PoolNotSet()",
      "error AlreadyPooled()",
      "error SurplusAlreadyReturned()",
      "error UseReturnSurplus()",
      "error BadFeeConfig()",
      "error ServiceFeeAlreadySet()",
      "error ServiceFeeLocked()",
      "error NotSoldOutYet()",
      "error DirectTransferNotAllowed()",
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
