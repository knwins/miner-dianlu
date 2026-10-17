// 链上对接客户端（ethers v6）。读取 Campaign 实时状态、发送写交易。
// 无钱包时用公共 RPC 只读；有钱包（window.ethereum）时签名发送。
import { BrowserProvider, JsonRpcProvider, Contract, formatEther, parseEther } from "ethers";
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

export { formatEther, parseEther };

let _browser = null; // BrowserProvider 缓存
let _readProvider = null;

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

export function campaignContract(runner) {
  return new Contract(CAMPAIGN_ADDRESS, CAMPAIGN_ABI, runner);
}
export function bemContract(runner) {
  return new Contract(BEM_ADDRESS, ERC20_ABI, runner);
}
export function factoryContract(runner) {
  return new Contract(FACTORY_ADDRESS, FACTORY_ABI, runner);
}

/** 读取 Campaign 全量状态（含当前账户的分账）。account 为空则跳过账户相关字段。 */
export async function readState(account) {
  if (!IS_CONFIGURED) throw new Error("尚未配置 Campaign 地址（请先部署）");
  const runner = _browser ? await _browser.getSigner().catch(() => getReadProvider()) : getReadProvider();
  const c = campaignContract(runner);
  const [
    scene, phase, sold, totalShares, sharePriceBnb, feeBps, hashpower, estHashpower,
    dailyBem, harvestCount, totalDistributed, totalFeeCollected, totalClaimed, totalRefunded,
    raisedBnb, netlistHash, soldOutAt, executionFailed, priceLock, transistorCount, capped,
    owner, fundingDeadline, executeDelay, bemAddr, podAddr, minterAddr, listingCount,
  ] = await Promise.all([
    c.status(), c.executePhase(), c.sold(), c.totalShares(), c.sharePriceBnb(), c.feeBps(),
    c.hashpower(), c.estHashpower(), c.dailyBem(), c.harvestCount(), c.totalDistributed(),
    c.totalFeeCollected(), c.totalClaimed(), c.totalRefunded(), c.raisedBnb(), c.netlistHash(),
    c.soldOutAt(), c.executionFailed(), c.priceLock(), c.transistorCount(), c.capped(),
    c.owner(), c.fundingDeadline(), c.executeDelay(), c.bem(), c.pod(), c.minter(), c.listingCount(),
  ]);

  const listings = [];
  const n = Number(listingCount);
  for (let i = 0; i < n; i++) {
    const l = await c.getListing(i);
    listings.push({ id: i, seller: l.seller, shares: l.shares, priceBnbPerShare: l.priceBnbPerShare, open: l.open });
  }

  const state = {
    scene: Number(scene), phase: Number(phase),
    sold, totalShares, sharePriceBnb, feeBps: Number(feeBps),
    hashpower, estHashpower, dailyBem, harvestCount, totalDistributed,
    totalFeeCollected, totalClaimed, totalRefunded, raisedBnb, netlistHash,
    soldOutAt: Number(soldOutAt), executionFailed, priceLock, transistorCount, capped,
    owner, fundingDeadline: Number(fundingDeadline), executeDelay: Number(executeDelay),
    bem: bemAddr, pod: podAddr, minter: minterAddr, listings,
    account: account || null,
  };

  if (account) {
    const bem = bemContract(runner);
    const [shares, escrow, claimed, refunded, pending, bemBal] = await Promise.all([
      c.sharesOf(account), c.escrowOf(account), c.claimedOf(account),
      c.refundedOf(account), c.pendingBem(account), bem.balanceOf(account),
    ]);
    state.self = { shares, escrow, claimed, refunded, pending, bemBalance: bemBal };
  }
  return state;
}

/** 从链上事件重构当前持有人列表（合约无 holder 枚举，只能从 Bought/Refunded/ListingTaken 反推 + sharesOf 校准）。 */
const LOG_SPAN = 50000; // 公共 RPC 的 eth_getLogs 单次窗口上限（实测 5 万可用、10 万被拒）
const LOG_MAX_LOOKBACK = 500000; // 最多回看约 17 天（测试网 ~3s/块）

async function queryChunked(contract, filter, from, to) {
  const out = [];
  for (let start = from; start <= to; start += LOG_SPAN) {
    const end = Math.min(start + LOG_SPAN - 1, to);
    try {
      out.push(...(await contract.queryFilter(filter, start, end)));
    } catch {
      /* 单窗口失败（如节点限流）则跳过，尽量返回其余结果 */
    }
  }
  return out;
}

export async function readHolders() {
  if (!IS_CONFIGURED) return [];
  const runner = getReadProvider();
  const c = campaignContract(runner);
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

// ── 写操作：均返回 tx（调用方 await tx.wait()） ──
function signerOrThrow(signer) {
  if (!signer) throw new Error("请先连接钱包");
  return campaignContract(signer);
}

export const tx = {
  buy: (signer, count, valueWei) => signerOrThrow(signer).buy(count, { value: valueWei }),
  refund: (signer) => signerOrThrow(signer).refund(),
  claim: (signer) => signerOrThrow(signer).claim(),
  harvest: (signer) => signerOrThrow(signer).harvest(),
  listShares: (signer, count, price) => signerOrThrow(signer).listShares(count, price),
  cancelListing: (signer, id) => signerOrThrow(signer).cancelListing(id),
  takeListing: (signer, id, count, valueWei) => signerOrThrow(signer).takeListing(id, count, { value: valueWei }),
  placeTransistorOrder: (signer, count, unitPrice) => signerOrThrow(signer).placeTransistorOrder(count, unitPrice),
  cancelTransistorOrder: (signer) => signerOrThrow(signer).cancelTransistorOrder(),
  confirmTransistors: (signer) => signerOrThrow(signer).confirmTransistors(),
  execute: (signer, tapeoutData, startData) => signerOrThrow(signer).execute(tapeoutData, startData),
  setPlan: (signer, est, capped, count) => signerOrThrow(signer).setPlan(est, capped, count),
  updateNetworkWeight: (signer, ver, unver) => signerOrThrow(signer).updateNetworkWeight(ver, unver),
};

/** 统一发送并等待，返回 { hash, receipt }，出错抛出可读信息。 */
export async function send(promiseTx) {
  try {
    const t = await promiseTx;
    const receipt = await t.wait();
    return { hash: t.hash, receipt };
  } catch (err) {
    const msg = err?.info?.error?.message || err?.shortMessage || err?.message || "交易失败";
    throw new Error(msg);
  }
}
