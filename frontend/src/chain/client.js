// 链上对接客户端（ethers v6）。读取 Campaign 实时状态、发送写交易。
// 无钱包时用公共 RPC 只读；有钱包（window.ethereum）时签名发送。
import { AbiCoder, BrowserProvider, FetchRequest, JsonRpcProvider, Network, Contract, Interface, formatEther, parseEther, ZeroAddress, getAddress, id, keccak256 } from "ethers";
import { CAMPAIGN_ABI, ERC20_ABI, FACTORY_ABI } from "./abis.js";
import {
  CAMPAIGN_ADDRESS,
  FACTORY_ADDRESS,
  BEM_ADDRESS,
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
  return new JsonRpcProvider(request, network, { staticNetwork: network });
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
export function bemContract(runner) {
  return new Contract(BEM_ADDRESS, ERC20_ABI, runner);
}
export function factoryContract(runner, address = FACTORY_ADDRESS) {
  if (!isAddr(address)) throw new Error("尚未配置 Factory 地址");
  return new Contract(address, FACTORY_ABI, runner);
}

async function readFeeShares(c, fallbackRecipient) {
  try {
    const rows = await c.feeShares();
    return (rows || []).map((row) => ({
      address: row.recipient ?? row[0],
      shareBps: Number(row.shareBps ?? row[1]),
    }));
  } catch {
    /* 旧期次没有 feeShares */
  }
  try {
    const n = Number(await c.feeShareCount());
    const out = [];
    for (let i = 0; i < n; i++) {
      const [recipient, shareBps] = await c.feeShareAt(i);
      out.push({ address: recipient, shareBps: Number(shareBps) });
    }
    if (out.length) return out;
  } catch {
    /* ignore */
  }
  if (fallbackRecipient) {
    return [{ address: fallbackRecipient, shareBps: 10_000 }];
  }
  return [];
}

/** 读取 Campaign 全量状态（含当前账户的分账）。account 为空则跳过账户相关字段。 */
export async function readState(account, campaignAddr = getCampaignAddress()) {
  if (!IS_CONFIGURED && !isAddr(campaignAddr)) throw new Error("尚未配置 Campaign 地址（请先部署）");
  // 读状态走公共节点。钱包自带的 BSC 节点（例如超额的 1rpc）会让整页读失败，看起来像工厂没有期次。
  return withReadProvider((runner) => readStateOn(runner, account, campaignAddr));
}

async function readStateOn(runner, account, campaignAddr) {
  const c = campaignContract(runner, campaignAddr);
  const [
    scene, phase, sold, totalShares, sharePriceBnb, feeBps, hashpower, estHashpower,
    dailyBem, harvestCount, totalDistributed, totalFeeCollected, totalClaimed, totalRefunded,
    raisedBnb, netlistHash, soldOutAt, executionFailed, priceLock, transistorCount, capped,
    owner, fundingDeadline, bemAddr, podAddr, minterAddr, listingCount,
    taskId, feeRecipient, netWeightVerified, netWeightUnverified, transistorsAddr,
  ] = await Promise.all([
    c.scene(), c.phase(), c.sold(), c.totalShares(), c.sharePriceBnb(), c.feeBps(),
    c.hashpower(), c.estHashpower(), c.dailyBem(), c.harvestCount(), c.totalDistributed(),
    c.totalFeeCollected(), c.totalClaimed(), c.totalRefunded(), c.raisedBnb(), c.netlistHash(),
    c.soldOutAt(), c.executionFailed(), c.priceLock(), c.transistorCount(), c.capped(),
    c.owner(), c.fundingDeadline(), c.bem(), c.pod(), c.minter(), c.listingCount(),
    c.taskId(), c.feeRecipient(), c.netWeightVerified(), c.netWeightUnverified(), c.transistors(),
  ]);
  const order = await readMarketOrder(c);

  const n = Number(listingCount);
  const rawListings = n > 0
    ? await Promise.all(Array.from({ length: n }, (_, i) => c.getListing(i)))
    : [];
  const listings = rawListings.map((l, i) => ({
    id: i,
    seller: l.seller,
    shares: l.shares,
    priceBnbPerShare: l.priceBnbPerShare,
    open: l.open,
  }));

  const state = {
    campaign: campaignAddr,
    scene: Number(scene), phase: Number(phase),
    sold, totalShares, sharePriceBnb, feeBps: Number(feeBps),
    hashpower, estHashpower, dailyBem, harvestCount, totalDistributed,
    totalFeeCollected, totalClaimed, totalRefunded, raisedBnb, netlistHash,
    soldOutAt: Number(soldOutAt), executionFailed, priceLock, transistorCount, capped,
    owner, fundingDeadline: Number(fundingDeadline),
    bem: bemAddr, pod: podAddr, minter: minterAddr, listings,
    ...order,
    // 开期即写入的元件合约优先；挂单后的 market 字段若为空也不要盖掉
    transistors: order.transistors && order.transistors !== ZeroAddress ? order.transistors : transistorsAddr,
    taskId: Number(taskId), feeRecipient,
    feeShares: await readFeeShares(c, feeRecipient),
    netWeightVerified: Number(netWeightVerified), netWeightUnverified: Number(netWeightUnverified),
    account: account || null,
  };

  if (account) {
    const bem = bemContract(runner);
    const [shares, escrow, claimed, refunded, pending, bemBal, bnbBal] = await Promise.all([
      c.sharesOf(account), c.escrowOf(account), c.claimedOf(account),
      c.refundedOf(account), c.pendingBem(account), bem.balanceOf(account),
      runner.getBalance(account),
    ]);
    state.self = { shares, escrow, claimed, refunded, pending, bemBalance: bemBal, bnb: bnbBal };
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
    case "sharePriceBnb":
      return `${formatEther(state.sharePriceBnb)} BNB`;
    case "totalShares":
      return String(state.totalShares);
    case "hashpower":
      return Number(state.hashpower) > 0
        ? `${Number(state.hashpower).toLocaleString("zh-CN")} H`
        : `预估 ${Number(state.estHashpower).toLocaleString("zh-CN")} H（未执行）`;
    case "estHashpower":
      return `${Number(state.estHashpower).toLocaleString("zh-CN")} H`;
    case "dailyBem":
      return `${Number(formatEther(state.dailyBem)).toFixed(4)} BEM`;
    case "harvestCount":
      return `${state.harvestCount} 次已领（次数不限）`;
    case "feeBps":
      return `${(Number(state.feeBps) / 100).toFixed(2)}%`;
    case "totalDistributed":
      return `${Number(formatEther(state.totalDistributed)).toFixed(4)} BEM`;
    case "sharesOf": {
      const a = args.account || account;
      if (!a) return "请填地址";
      const c = campaignContract(getReadProvider(), campaignAddr);
      return `${await c.sharesOf(a)} 份`;
    }
    case "pendingBem": {
      const a = args.account || account;
      if (!a) return "请填地址";
      const c = campaignContract(getReadProvider(), campaignAddr);
      return `${Number(formatEther(await c.pendingBem(a))).toFixed(4)} BEM`;
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
      const base = [
        c.scene(),
        c.sold(),
        c.totalShares(),
        c.sharePriceBnb(),
        c.executionFailed(),
        c.fundingDeadline(),
        c.phase(),
      ];
      if (account) {
        base.push(c.sharesOf(account), c.escrowOf(account), c.pendingBem(account), c.claimedOf(account), c.refundedOf(account));
      }
      const res = await Promise.all(base);
      const scene = Number(res[0]);
      const phaseN = Number(res[6]);
      rows.push({
        id,
        address,
        scene: POSITION_SCENE[scene] || "funding",
        sceneLabel: POSITION_LABEL[scene] || "—",
        phase: ["", "buying", "listed", "ready"][phaseN] || "buying",
        sold: Number(res[1]),
        totalShares: Number(res[2]),
        sharePriceBnb: Number(formatEther(res[3])),
        executionFailed: Boolean(res[4]),
        fundingDeadline: Number(res[5]),
        shares: account ? Number(res[7]) : null,
        escrow: account ? Number(res[8]) : 0,
        pendingBem: account ? Number(formatEther(res[9])) : 0,
        claimedBem: account ? Number(formatEther(res[10])) : 0,
        refundedBnb: account ? Number(formatEther(res[11])) : 0,
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
        shares: account ? 0 : null,
        escrow: 0,
        pendingBem: 0,
        claimedBem: 0,
        refundedBnb: 0,
        error: true,
      });
    }
  }
  return rows;
}

/** 新期次才有官方买单字段。旧合约调用会 revert，按「尚未对接市场」处理。 */
async function readMarketOrder(c) {
  const empty = {
    nandBidId: 0n, latchBidId: 0n, nandQty: 0n, latchQty: 0n,
    nandPrice: 0n, latchPrice: 0n, transistors: ZeroAddress, orderFilled: false, marketOrders: false,
  };
  try {
    const [nandBidId, latchBidId, nandQty, latchQty, nandPrice, latchPrice, transistors, orderFilled] = await Promise.all([
      c.nandBidId(), c.latchBidId(), c.nandQty(), c.latchQty(), c.nandPrice(), c.latchPrice(),
      c.transistors(), c.orderFilled(),
    ]);
    const marketAddr = await c.market().catch(() => null);
    const [nandRemaining, latchRemaining] = await Promise.all([
      readLegRemaining(c.runner, marketAddr, nandBidId, nandQty),
      readLegRemaining(c.runner, marketAddr, latchBidId, latchQty),
    ]);
    return { nandBidId, latchBidId, nandQty, latchQty, nandPrice, latchPrice, transistors, orderFilled, marketOrders: true, nandRemaining, latchRemaining };
  } catch {
    return empty;
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

async function campaignsOf(factoryAddr) {
  return withReadProvider(async (provider) => {
    const f = factoryContract(provider, factoryAddr);
    try {
      return [...await f.allCampaigns()].reverse();
    } catch {
      const n = Number(await f.campaignCount());
      const out = [];
      for (let i = 0; i < n; i++) out.push(await f.campaigns(i));
      return out.reverse();
    }
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
  const [
    scene, sold, totalShares, sharePriceBnb, hashpower, estHashpower,
    totalDistributed, totalFeeCollected, raisedBnb, taskId, transistorCount, transistors,
  ] = await Promise.all([
    c.scene(), c.sold(), c.totalShares(), c.sharePriceBnb(),
    c.hashpower(), c.estHashpower(),
    c.totalDistributed(), c.totalFeeCollected(), c.raisedBnb(),
    c.taskId(), c.transistorCount(), c.transistors(),
  ]);
  return {
    address,
    scene: Number(scene),
    sold: Number(sold),
    totalShares: Number(totalShares),
    sharePriceBnb: Number(formatEther(sharePriceBnb)),
    hashpower: Number(hashpower),
    estHashpower: Number(estHashpower),
    distributed: Number(formatEther(totalDistributed)),
    feeBem: Number(formatEther(totalFeeCollected)),
    raisedBnb: Number(formatEther(raisedBnb)),
    taskId: Number(taskId),
    transistorCount: Number(transistorCount),
    transistors,
  };
}

// ── 写操作：均返回 tx（调用方 await tx.wait()） ──
function signerOrThrow(signer, address = getCampaignAddress()) {
  if (!signer) throw new Error("请先连接钱包");
  return campaignContract(signer, address);
}

export const tx = {
  subscribe: (signer, count, valueWei) => signerOrThrow(signer).subscribe(count, { value: valueWei }),
  refund: (signer, address) => signerOrThrow(signer, address).refund(),
  claim: (signer, address) => signerOrThrow(signer, address).claim(),
  harvest: async (signer) => {
    const c = signerOrThrow(signer);
    const daily = await c.dailyBem();
    const bemAddr = await c.bem();
    const podAddr = await c.pod();
    if (deployments.bemIsMock && String(bemAddr).toLowerCase() === String(deployments.bem).toLowerCase()) {
      const bem = new Contract(bemAddr, [
        "function balanceOf(address) view returns (uint256)",
        "function mint(address,uint256)",
      ], signer);
      const pod = new Contract(podAddr, [
        "function dailyAmount() view returns (uint256)",
        "function setDailyAmount(uint256)",
      ], signer);
      const [podBal, armed] = await Promise.all([bem.balanceOf(podAddr), pod.dailyAmount()]);
      if (podBal < daily) {
        const fund = await bem.mint(podAddr, daily - podBal);
        await fund.wait();
      }
      if (armed < daily) {
        const arm = await pod.setDailyAmount(daily);
        await arm.wait();
      }
    }
    return c.harvest();
  },
  listShares: (signer, count, price) => signerOrThrow(signer).listShares(count, price),
  cancelListing: (signer, id) => signerOrThrow(signer).cancelListing(id),
  takeListing: (signer, id, count, valueWei) => signerOrThrow(signer).takeListing(id, count, { value: valueWei }),
  placeTransistorOrder: (signer, transistors, nandQty, nandPrice, latchQty, latchPrice) =>
    signerOrThrow(signer).placeTransistorOrder(transistors, nandQty, nandPrice, latchQty, latchPrice),
  openRefund: async (signer) => {
    const c = signerOrThrow(signer);
    const code = (await signer.provider.getCode(await c.getAddress())).toLowerCase();
    if (code.includes(id("openRefund()").slice(2, 10))) return c.openRefund();
    throw new Error("这期是旧合约，链上没有 Owner 直接退款。重新部署工厂后，新开的期才能退款。");
  },
  cancelTransistorOrder: (signer) => signerOrThrow(signer).cancelTransistorOrder(),
  confirmTransistors: (signer) => signerOrThrow(signer).confirmTransistors(),
  execute: (signer, tapeoutData, startData) => signerOrThrow(signer).execute(tapeoutData, startData),
  setPlan: (signer, est, capped, count) => signerOrThrow(signer).setPlan(est, capped, count),
  updateNetworkWeight: (signer, ver, unver) => signerOrThrow(signer).updateNetworkWeight(ver, unver),
  createCampaign: (signer, params) => createCampaignTx(signer, params),
  removeCampaignAt: (signer, index) => factoryContract(signer).getFunction("removeCampaign(uint256)")(index),
  removeCampaign: (signer, campaign) => factoryContract(signer).getFunction("removeCampaign(address)")(campaign),
  setFactoryPod: (signer, pod) => factoryContract(signer).setPod(pod),
  setFactoryBem: (signer, bem) => factoryContract(signer).setBem(bem),
  setFactoryMinter: (signer, minter) => factoryContract(signer).setMinter(minter),
  setFactoryOwner: (signer, newOwner) => factoryContract(signer).transferOwnership(newOwner),
  setPod: (signer, pod) => signerOrThrow(signer).setPod(pod),
  setBem: (signer, bem) => signerOrThrow(signer).setBem(bem),
  setMinter: (signer, minter) => signerOrThrow(signer).setMinter(minter),
  setFeeShares: (signer, recipients, shareBps) => signerOrThrow(signer).setFeeShares(recipients, shareBps),
  recoverBnb: (signer, amount) => signerOrThrow(signer).recoverBnb(amount),
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
 * 开期：预检 Owner → staticCall → 发交易 → 解析新地址（事件失败则读 campaigns[n-1]）。
 * 返回 { hash, receipt, campaign }。
 */
// 工厂开期签名演进：V1 多 executeDelay；V2 单收费地址；V3 多地址分成；V4 写入晶体管合约（处理器）。
const CREATE_V1 =
  "function createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint16 feePercent,uint64 fundingDays,address feeRecipient,uint256 taskId,address pod_,uint64 executeDelay,bytes32 netlistHash) returns (address)";
const CREATE_V2 =
  "function createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint16 feePercent,uint64 fundingDays,address feeRecipient,uint256 taskId,address pod_,bytes32 netlistHash) returns (address)";
const CREATE_V3 =
  "function createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint16 feePercent,uint64 fundingDays,address[] feeRecipients,uint16[] feeShareBps,uint256 taskId,address pod_,bytes32 netlistHash) returns (address)";
const CREATE_V4_SELECTOR = id(
  "createCampaign(uint256,uint256,uint16,uint64,address[],uint16[],uint256,address,bytes32,address)"
).slice(2, 10);
const CREATE_V3_SELECTOR = id(
  "createCampaign(uint256,uint256,uint16,uint64,address[],uint16[],uint256,address,bytes32)"
).slice(2, 10);
const CREATE_V2_SELECTOR = id("createCampaign(uint256,uint256,uint16,uint64,address,uint256,address,bytes32)").slice(
  2,
  10
);

function normalizeFeeShares(params) {
  const rows =
    Array.isArray(params.feeShares) && params.feeShares.length > 0
      ? params.feeShares
      : [{ address: params.feeRecipient, shareBps: 10_000 }];
  const recipients = [];
  const shareBps = [];
  for (const row of rows) {
    const address = String(row.address || row.recipient || "").trim();
    const bps = Math.round(Number(row.shareBps ?? row.bps ?? 0));
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error("服务费收费地址格式不正确");
    }
    if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000 || bps % 100 !== 0) {
      throw new Error("服务费分成比例须为 1 到 100 的整数");
    }
    recipients.push(address);
    shareBps.push(bps);
  }
  const sum = shareBps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) {
    throw new Error(`所有分成地址比例之和必须等于 100，当前合计为 ${sum / 100}`);
  }
  return { recipients, shareBps };
}

async function factoryCreateVersion(runner) {
  const provider = runner?.provider || runner;
  const code = String(await provider.getCode(FACTORY_ADDRESS)).toLowerCase();
  if (code.includes(CREATE_V4_SELECTOR)) return 4;
  if (code.includes(CREATE_V3_SELECTOR)) return 3;
  if (code.includes(CREATE_V2_SELECTOR)) return 2;
  return 1;
}

function createArgs(params, version) {
  const { recipients, shareBps } = normalizeFeeShares(params);
  const commonHead = [params.sharePriceWei, params.totalShares, params.feePercent, params.fundingDays];
  const transistors = params.transistors || ZeroAddress;
  const tail = [params.taskId, params.pod || ZeroAddress, params.netlistHash];
  if (version === 4) {
    if (!isAddr(transistors) || transistors === ZeroAddress) {
      throw new Error("请选择目标处理器（TapeOut / Behemoth），开期会把对应晶体管合约写入链上");
    }
    return [...commonHead, recipients, shareBps, ...tail, transistors];
  }
  if (version === 3) return [...commonHead, recipients, shareBps, ...tail];
  if (version === 2) return [...commonHead, recipients[0], ...tail];
  return [...commonHead, recipients[0], params.taskId, params.pod || ZeroAddress, 1n, params.netlistHash];
}

function createCampaignAbi(version) {
  if (version === 4) return FACTORY_ABI;
  if (version === 3) {
    return FACTORY_ABI.map((item) => (item.startsWith("function createCampaign") ? CREATE_V3 : item));
  }
  return FACTORY_ABI.map((item) =>
    item.startsWith("function createCampaign") ? (version === 2 ? CREATE_V2 : CREATE_V1) : item
  );
}

function factoryWriter(signer, version) {
  if (version === 4) return factoryContract(signer);
  return new Contract(
    FACTORY_ADDRESS,
    [
      version === 3 ? CREATE_V3 : version === 2 ? CREATE_V2 : CREATE_V1,
      ...FACTORY_ABI.filter((item) => !item.startsWith("function createCampaign")),
    ],
    signer
  );
}

async function createCampaignTx(signer, params) {
  if (!signer) throw new Error("请先连接钱包");
  const version = await factoryCreateVersion(signer);
  const f = new Contract(FACTORY_ADDRESS, createCampaignAbi(version), signer);
  return f.createCampaign(...createArgs(params, version));
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

  const version = await withReadProvider((provider) => factoryCreateVersion(provider));
  if (version < 4) {
    throw new Error("当前工厂开期不会把目标处理器写进期次合约。请先部署带晶体管地址参数的新工厂，再开期。");
  }
  const args = createArgs(params, version);
  const writer = factoryWriter(signer, version);
  const iface = writer.interface;

  // 用前端公共 RPC 预检 + 估 gas，避开钱包节点对大创建交易估 gas 时的 coalesce / 403。
  let gasLimit;
  try {
    gasLimit = await withReadProvider(async (provider) => {
      const reader = factoryWriter(provider, version);
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

function decodeRevert(err, iface) {
  const data = nestedErrorData(err);
  if (data && iface) {
    try {
      const parsed = iface.parseError(data);
      if (parsed?.name === "NotOwner") {
        const caller = parsed.args?.caller || parsed.args?.[0];
        return `非 Factory Owner（${caller ? String(caller).slice(0, 10) + "…" : "当前钱包"}），无法开期`;
      }
      if (parsed?.name === "BadFee") return "服务费须在 1–20%";
      if (parsed?.name === "BadFeeShares") return "服务费分成表不合法：地址非空、比例为 1–100 的整数，且之和为 100";
      if (parsed?.name === "ZeroCampaignParam") return "每份价格或总份数不能为 0";
      if (parsed?.name === "ObservationPeriodActive") {
        return "这期是旧版合约，流片时间锁尚未到期。可稍后再试，或换到已去掉时间锁的新工厂开期。";
      }
      if (parsed?.name === "TransistorsNotReady") return "晶体管还没到账，不能流片";
      if (parsed?.name === "AlreadyListed") return "请先取消挂单，再发起退款";
      if (parsed?.name === "CanStillAfford") return "按当前报价还能买得起晶体管，旧合约不允许退款";
      if (parsed?.name === "NothingToClaim") return "当前没有可转出的 BEM。先做一次全网分发；若分发后仍失败，是这一轮 PoD 没有把代币打进合约。";
      if (parsed?.name === "NoEmission") return "这一轮 PoD 没有打出 BEM，分发没有入账。";
      if (parsed?.name === "ZeroAddress") return "服务费收费地址不能为零地址";
      if (parsed?.name) return `合约拒绝：${parsed.name}`;
    } catch {
      /* fall through */
    }
  }
  const revert = err?.revert?.name;
  if (revert === "NotOwner") return "非 Factory Owner，无法开期";
  const raw = nestedErrorText(err) || "交易失败";
  const selector = String(raw).match(/0x[0-9a-fA-F]{8}/);
  if (selector && iface) {
    try {
      const parsed = iface.parseError(selector[0]);
      if (parsed?.name === "NothingToClaim") return "当前没有可转出的 BEM。先做一次全网分发；若分发后仍失败，是这一轮 PoD 没有把代币打进合约。";
      if (parsed?.name === "NoEmission") return "这一轮 PoD 没有打出 BEM，分发没有入账。";
      if (parsed?.name === "BadFeeShares") return "服务费分成表不合法：地址非空、比例为 1–100 的整数，且之和为 100";
      if (parsed?.name) return `合约拒绝：${parsed.name}`;
    } catch {
      /* 不是本合约的错误选择子 */
    }
  }
  if (/no data present/i.test(raw)) {
    return "合约拒绝了这笔交易，钱包没有带回具体原因。若是发布或流片，请确认当前钱包权限与晶体管子态后再试。";
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
      "error CanStillAfford()",
      "error WrongScene()",
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
