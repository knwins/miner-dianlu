// 链上对接客户端（ethers v6）。读取 Campaign 实时状态、发送写交易。
// 无钱包时用公共 RPC 只读；有钱包（window.ethereum）时签名发送。
import { BrowserProvider, JsonRpcProvider, Contract, Interface, formatEther, parseEther, ZeroAddress } from "ethers";
import { CAMPAIGN_ABI, ERC20_ABI, FACTORY_ABI } from "./abis.js";
import {
  CAMPAIGN_ADDRESS,
  FACTORY_ADDRESS,
  BEM_ADDRESS,
  CHAIN_ID,
  CHAIN_ID_HEX,
  RPC_URL,
  NETWORK,
  IS_CONFIGURED,
} from "./config.js";

export { formatEther, parseEther, ZeroAddress };

const STORAGE_KEY = "miner.activeCampaign";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

let _browser = null;
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

export function hasInjected() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

export function getReadProvider() {
  if (!_readProvider) _readProvider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  return _readProvider;
}

/** 连接钱包并确保切到目标链。返回 { provider, signer, account } */
export async function connectWallet() {
  if (!hasInjected()) throw new Error("未检测到钱包插件（请安装 MetaMask 等）");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  await ensureChain(provider);
  const signer = await provider.getSigner();
  const account = await signer.getAddress();
  _browser = provider;
  return { provider, signer, account };
}

/** 切换到目标链；若钱包没有该链则添加。 */
export async function ensureChain(provider) {
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: CHAIN_ID_HEX }]);
  } catch (err) {
    if (err && (err.code === 4902 || /Unrecognized chain/i.test(err.message || ""))) {
      await provider.send("wallet_addEthereumChain", [
        {
          chainId: CHAIN_ID_HEX,
          chainName: NETWORK.name,
          rpcUrls: NETWORK.rpcUrls,
          nativeCurrency: NETWORK.currency,
          blockExplorerUrls: NETWORK.explorer ? [NETWORK.explorer] : [],
        },
      ]);
    } else {
      throw err;
    }
  }
}

export function campaignContract(runner, address = getCampaignAddress()) {
  if (!isAddr(address)) throw new Error("尚未配置 Campaign 地址（请先部署）");
  return new Contract(address, CAMPAIGN_ABI, runner);
}
export function bemContract(runner) {
  return new Contract(BEM_ADDRESS, ERC20_ABI, runner);
}
export function factoryContract(runner) {
  if (!isAddr(FACTORY_ADDRESS)) throw new Error("尚未配置 Factory 地址");
  return new Contract(FACTORY_ADDRESS, FACTORY_ABI, runner);
}

/** 读取 Campaign 全量状态（含当前账户的分账）。account 为空则跳过账户相关字段。 */
export async function readState(account, campaignAddr = getCampaignAddress()) {
  if (!IS_CONFIGURED && !isAddr(campaignAddr)) throw new Error("尚未配置 Campaign 地址（请先部署）");
  const runner = _browser ? await _browser.getSigner().catch(() => getReadProvider()) : getReadProvider();
  const c = campaignContract(runner, campaignAddr);
  const [
    scene, phase, sold, totalShares, sharePriceBnb, feeBps, hashpower, estHashpower,
    dailyBem, harvestCount, totalDistributed, totalFeeCollected, totalClaimed, totalRefunded,
    raisedBnb, netlistHash, soldOutAt, executionFailed, priceLock, transistorCount, capped,
    owner, fundingDeadline, executeDelay, bemAddr, podAddr, minterAddr, listingCount,
    taskId, feeRecipient, netWeightVerified, netWeightUnverified,
  ] = await Promise.all([
    c.status(), c.executePhase(), c.sold(), c.totalShares(), c.sharePriceBnb(), c.feeBps(),
    c.hashpower(), c.estHashpower(), c.dailyBem(), c.harvestCount(), c.totalDistributed(),
    c.totalFeeCollected(), c.totalClaimed(), c.totalRefunded(), c.raisedBnb(), c.netlistHash(),
    c.soldOutAt(), c.executionFailed(), c.priceLock(), c.transistorCount(), c.capped(),
    c.owner(), c.fundingDeadline(), c.executeDelay(), c.bem(), c.pod(), c.minter(), c.listingCount(),
    c.taskId(), c.feeRecipient(), c.netWeightVerified(), c.netWeightUnverified(),
  ]);

  const listings = [];
  const n = Number(listingCount);
  for (let i = 0; i < n; i++) {
    const l = await c.getListing(i);
    listings.push({ id: i, seller: l.seller, shares: l.shares, priceBnbPerShare: l.priceBnbPerShare, open: l.open });
  }

  const state = {
    campaign: campaignAddr,
    scene: Number(scene), phase: Number(phase),
    sold, totalShares, sharePriceBnb, feeBps: Number(feeBps),
    hashpower, estHashpower, dailyBem, harvestCount, totalDistributed,
    totalFeeCollected, totalClaimed, totalRefunded, raisedBnb, netlistHash,
    soldOutAt: Number(soldOutAt), executionFailed, priceLock, transistorCount, capped,
    owner, fundingDeadline: Number(fundingDeadline), executeDelay: Number(executeDelay),
    bem: bemAddr, pod: podAddr, minter: minterAddr, listings,
    taskId: Number(taskId), feeRecipient,
    netWeightVerified: Number(netWeightVerified), netWeightUnverified: Number(netWeightUnverified),
    account: account || null,
  };

  if (account) {
    const bem = bemContract(runner);
    const provider = getReadProvider();
    const [shares, escrow, claimed, refunded, pending, bemBal, bnbBal] = await Promise.all([
      c.sharesOf(account), c.escrowOf(account), c.claimedOf(account),
      c.refundedOf(account), c.pendingBem(account), bem.balanceOf(account),
      provider.getBalance(account),
    ]);
    state.self = { shares, escrow, claimed, refunded, pending, bemBalance: bemBal, bnb: bnbBal };
  }
  return state;
}

/** 从链上事件重构当前持有人列表（合约无 holder 枚举）。 */
const LOG_SPAN = 50000;
const LOG_MAX_LOOKBACK = 500000;

async function queryChunked(contract, filter, from, to) {
  const out = [];
  for (let start = from; start <= to; start += LOG_SPAN) {
    const end = Math.min(start + LOG_SPAN - 1, to);
    try {
      out.push(...(await contract.queryFilter(filter, start, end)));
    } catch {
      /* 单窗口失败则跳过 */
    }
  }
  return out;
}

/** 最近认购（Bought 事件），新→旧。 */
export async function readRecentBuys(limit = 8, campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) return [];
  const runner = getReadProvider();
  const c = campaignContract(runner, campaignAddr);
  const latest = await runner.getBlockNumber();
  const from = Math.max(0, latest - LOG_MAX_LOOKBACK);
  const events = await queryChunked(c, c.filters.Bought(), from, latest);
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    out.push({
      address: String(e.args.buyer).toLowerCase(),
      shares: Number(e.args.count),
      paidBnb: Number(formatEther(e.args.paidBnb)),
      blockNumber: e.blockNumber,
      txHash: e.transactionHash,
    });
  }
  return out;
}

/** 链上只读某个视图（合约调用页用），返回人类可读字符串。 */
export async function liveReadView(method, args = {}, account = null, campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) throw new Error("未配置 Campaign");
  const state = await readState(account || args.account || null, campaignAddr);
  const SCENE = ["募集中", "待执行", "挖矿中"];
  switch (method) {
    case "status":
      return SCENE[state.scene] || String(state.scene);
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

export async function readHolders(campaignAddr = getCampaignAddress()) {
  if (!isAddr(campaignAddr)) return [];
  const runner = getReadProvider();
  const c = campaignContract(runner, campaignAddr);
  const latest = await runner.getBlockNumber();
  const from = Math.max(0, latest - LOG_MAX_LOOKBACK);
  const [bought, refunded, taken] = await Promise.all([
    queryChunked(c, c.filters.Bought(), from, latest),
    queryChunked(c, c.filters.Refunded(), from, latest),
    queryChunked(c, c.filters.ListingTaken(), from, latest),
  ]);
  const addrs = new Set();
  for (const e of bought) addrs.add(String(e.args.buyer).toLowerCase());
  for (const e of refunded) addrs.add(String(e.args.holder).toLowerCase());
  for (const e of taken) {
    addrs.add(String(e.args.buyer).toLowerCase());
    addrs.add(String(e.args.seller).toLowerCase());
  }
  const out = [];
  for (const a of addrs) {
    try {
      const s = await c.sharesOf(a);
      if (s > 0n) out.push({ address: a, shares: Number(s) });
    } catch {
      /* 单地址查询失败忽略 */
    }
  }
  out.sort((x, y) => y.shares - x.shares);
  return out;
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
        c.status(),
        c.sold(),
        c.totalShares(),
        c.sharePriceBnb(),
        c.executionFailed(),
        c.fundingDeadline(),
      ];
      if (account) {
        base.push(c.sharesOf(account), c.pendingBem(account), c.refundedOf(account));
      }
      const res = await Promise.all(base);
      const scene = Number(res[0]);
      rows.push({
        id,
        address,
        scene: POSITION_SCENE[scene] || "funding",
        sceneLabel: POSITION_LABEL[scene] || "—",
        sold: Number(res[1]),
        totalShares: Number(res[2]),
        sharePriceBnb: Number(formatEther(res[3])),
        executionFailed: Boolean(res[4]),
        fundingDeadline: Number(res[5]),
        shares: account ? Number(res[6]) : null,
        pendingBem: account ? Number(formatEther(res[7])) : 0,
        refundedBnb: account ? Number(formatEther(res[8])) : 0,
      });
    } catch {
      rows.push({
        id,
        address,
        scene: "",
        sceneLabel: "—",
        sold: 0,
        totalShares: 0,
        sharePriceBnb: 0,
        executionFailed: false,
        fundingDeadline: 0,
        shares: account ? 0 : null,
        pendingBem: 0,
        refundedBnb: 0,
        error: true,
      });
    }
  }
  return rows;
}

/** 列出工厂下全部期次地址（新→旧）。 */
export async function listCampaigns() {
  if (!isAddr(FACTORY_ADDRESS)) return [];
  const runner = getReadProvider();
  const f = factoryContract(runner);
  try {
    const addrs = await f.allCampaigns();
    return [...addrs].reverse();
  } catch {
    const n = Number(await f.campaignCount());
    const out = [];
    for (let i = 0; i < n; i++) out.push(await f.campaigns(i));
    return out.reverse();
  }
}

/** 读某期轻量摘要（历史列表用）。 */
export async function readCampaignSummary(address) {
  const runner = getReadProvider();
  const c = campaignContract(runner, address);
  const [
    scene, sold, totalShares, sharePriceBnb, hashpower, estHashpower,
    totalDistributed, totalFeeCollected, raisedBnb, taskId, transistorCount,
  ] = await Promise.all([
    c.status(), c.sold(), c.totalShares(), c.sharePriceBnb(),
    c.hashpower(), c.estHashpower(),
    c.totalDistributed(), c.totalFeeCollected(), c.raisedBnb(),
    c.taskId(), c.transistorCount(),
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
  };
}

// ── 写操作：均返回 tx（调用方 await tx.wait()） ──
function signerOrThrow(signer, address = getCampaignAddress()) {
  if (!signer) throw new Error("请先连接钱包");
  return campaignContract(signer, address);
}

export const tx = {
  buy: (signer, count, valueWei) => signerOrThrow(signer).buy(count, { value: valueWei }),
  refund: (signer, address) => signerOrThrow(signer, address).refund(),
  claim: (signer, address) => signerOrThrow(signer, address).claim(),
  harvest: (signer) => signerOrThrow(signer).harvest(),
  listShares: (signer, count, price) => signerOrThrow(signer).listShares(count, price),
  cancelListing: (signer, id) => signerOrThrow(signer).cancelListing(id),
  takeListing: (signer, id, count, valueWei) => signerOrThrow(signer).takeListing(id, count, { value: valueWei }),
  placeTransistorOrder: (signer, count, unitPrice) => signerOrThrow(signer).placeTransistorOrder(count, unitPrice),
  abortUnaffordable: (signer, count, unitPrice) => signerOrThrow(signer).abortUnaffordable(count, unitPrice),
  cancelTransistorOrder: (signer) => signerOrThrow(signer).cancelTransistorOrder(),
  confirmTransistors: (signer) => signerOrThrow(signer).confirmTransistors(),
  execute: (signer, tapeoutData, startData) => signerOrThrow(signer).execute(tapeoutData, startData),
  setPlan: (signer, est, capped, count) => signerOrThrow(signer).setPlan(est, capped, count),
  updateNetworkWeight: (signer, ver, unver) => signerOrThrow(signer).updateNetworkWeight(ver, unver),
  createCampaign: (signer, params) => {
    if (!signer) throw new Error("请先连接钱包");
    const f = factoryContract(signer);
    return f.createCampaign(
      params.sharePriceWei,
      params.totalShares,
      params.feePercent,
      params.fundingDays,
      params.feeRecipient,
      params.taskId,
      params.pod || ZeroAddress,
      params.executeDelay || 0n,
      params.netlistHash
    );
  },
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
export async function createCampaignOnChain(signer, params) {
  if (!signer) throw new Error("请先连接钱包");
  const f = factoryContract(signer);
  const caller = await signer.getAddress();
  const owner = await f.owner();
  if (String(caller).toLowerCase() !== String(owner).toLowerCase()) {
    throw new Error(
      `需 Factory Owner 钱包签名。当前 ${caller.slice(0, 6)}…${caller.slice(-4)}，Owner 为 ${owner.slice(0, 6)}…${owner.slice(-4)}`
    );
  }

  const args = [
    params.sharePriceWei,
    params.totalShares,
    params.feePercent,
    params.fundingDays,
    params.feeRecipient,
    params.taskId,
    params.pod || ZeroAddress,
    params.executeDelay || 0n,
    params.netlistHash,
  ];

  // 预演：把 BadFee / 参数错误在弹钱包前就报出来
  try {
    await f.createCampaign.staticCall(...args);
  } catch (err) {
    throw new Error(decodeRevert(err, f.interface));
  }

  try {
    const t = await f.createCampaign(...args);
    const receipt = await t.wait();
    if (receipt.status === 0) throw new Error("交易上链失败（status=0）");
    let campaign = parseCreatedCampaign(receipt);
    if (!campaign) {
      const n = await f.campaignCount();
      if (n > 0n) campaign = await f.campaigns(n - 1n);
    }
    if (!campaign) throw new Error("开期交易已确认，但未能解析新 Campaign 地址，请到顶栏切换期次或刷新");
    return { hash: t.hash, receipt, campaign };
  } catch (err) {
    if (err?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(err?.message || "")) {
      throw new Error("已取消签名");
    }
    throw new Error(decodeRevert(err, f.interface));
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

function decodeRevert(err, iface) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (data && iface) {
    try {
      const parsed = iface.parseError(data);
      if (parsed?.name === "NotOwner") {
        const caller = parsed.args?.caller || parsed.args?.[0];
        return `非 Factory Owner（${caller ? String(caller).slice(0, 10) + "…" : "当前钱包"}），无法开期`;
      }
      if (parsed?.name === "BadFee") return "服务费须在 1–20%";
      if (parsed?.name === "ZeroCampaignParam") return "每份价格或总份数不能为 0";
      if (parsed?.name === "ZeroAddress") return "服务费收费地址不能为零地址";
      if (parsed?.name) return `合约拒绝：${parsed.name}`;
    } catch {
      /* fall through */
    }
  }
  const revert = err?.revert?.name;
  if (revert === "NotOwner") return "非 Factory Owner，无法开期";
  if (revert) return `合约拒绝：${revert}`;
  return err?.info?.error?.message || err?.shortMessage || err?.reason || err?.message || "交易失败";
}

/** 统一发送并等待，返回 { hash, receipt }，出错抛出可读信息。 */
export async function send(promiseTx) {
  try {
    const t = await promiseTx;
    const receipt = await t.wait();
    return { hash: t.hash, receipt };
  } catch (err) {
    if (err?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(err?.message || "")) {
      throw new Error("已取消签名");
    }
    const iface = new Interface([...FACTORY_ABI, ...CAMPAIGN_ABI, "error NotOwner(address caller)", "error ZeroAddress()"]);
    throw new Error(decodeRevert(err, iface));
  }
}
