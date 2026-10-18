// 链上数据源钩子：CHAIN_CONFIGURED 时轮询 readState → 适配成 book/round。
// 无钱包时用公共 RPC 只读；连接钱包后可签名写操作。本地模拟作为回退保留在 App。
// BEM挖矿认筹默认展示工厂最新一期；顶栏可手动切到历史期。
import { useCallback, useEffect, useRef, useState } from "react";
import { IS_CONFIGURED as CHAIN_CONFIGURED, CAMPAIGN_ADDRESS } from "./config.js";
import {
  readState,
  connectWallet,
  restoreWallet,
  getCampaignAddress,
  setCampaignAddress,
  clearCampaignAddress,
  listCampaigns,
  readCampaignSummary,
  readAccountAcrossCampaigns,
} from "./client.js";
import { roundFromDeployment, roundFromState, bookFromState, historyRowFromSummary } from "./adapter.js";
import deployments from "./deployments.json";

function indexOfCampaign(addrs, addr) {
  if (!addr || !addrs?.length) return 1;
  const i = addrs.findIndex((a) => String(a).toLowerCase() === String(addr).toLowerCase());
  // listCampaigns 新→旧，第 0 项 = 最新一期 = 最大期号
  return i >= 0 ? addrs.length - i : 1;
}

export function useChain(extra = {}) {
  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const [book, setBook] = useState(null);
  const [round, setRound] = useState(() => (CHAIN_CONFIGURED ? roundFromDeployment(deployments) : null));
  const [campaignAddress, setCampaignAddr] = useState(() =>
    CHAIN_CONFIGURED ? getCampaignAddress() || CAMPAIGN_ADDRESS : ""
  );
  const [campaigns, setCampaigns] = useState([]); // 历史期次摘要（新→旧）
  const [campaignAddrs, setCampaignAddrs] = useState([]);
  const [positions, setPositions] = useState([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [loading, setLoading] = useState(CHAIN_CONFIGURED);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState(1);
  /** 是否已完成「默认最新一期」引导；之后用户手动切换不再被拉回 */
  const bootedRef = useRef(false);
  const extraRef = useRef(extra);
  extraRef.current = extra;
  /** 只采纳最新一次读取，避免慢请求把刚切换的期次盖回去 */
  const readGen = useRef(0);

  const applyState = useCallback(async (addr, acc, addrs = campaignAddrs) => {
    const gen = ++readGen.current;
    const state = await readState(acc, addr);
    if (gen !== readGen.current) return;
    const idx = indexOfCampaign(addrs, addr);
    setRound((prev) => roundFromState(state, prev || roundFromDeployment(deployments), idx));
    setBook(bookFromState(state, acc, extraRef.current));
    setCampaignAddr(addr);
    setError("");
  }, [campaignAddrs]);

  const refresh = useCallback(async () => {
    if (!CHAIN_CONFIGURED) return;
    const addr = getCampaignAddress();
    if (!addr) return;
    try {
      await applyState(addr, account);
    } catch (e) {
      setError(e.shortMessage || e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [account, applyState]);

  const refreshHistory = useCallback(async () => {
    if (!CHAIN_CONFIGURED) return [];
    try {
      const addrs = await listCampaigns();
      const rows = [];
      // 最多拉最近 12 期，避免公共 RPC 过载
      for (let i = 0; i < Math.min(addrs.length, 12); i++) {
        try {
          const s = await readCampaignSummary(addrs[i]);
          rows.push(historyRowFromSummary(s, addrs.length - i));
        } catch {
          rows.push({
            id: addrs.length - i,
            address: addrs[i],
            status: "—",
            tone: "live",
            shares: "—",
            raised: "—",
            hashpower: "—",
            bem: "—",
            fee: "—",
          });
        }
      }
      setCampaignAddrs(addrs);
      setCampaigns(rows);
      return addrs;
    } catch {
      /* 工厂未部署或 RPC 失败时保留空列表 */
      return [];
    }
  }, []);

  // 首次启动：拉工厂列表 → 默认切到最新一期 → 再读状态
  useEffect(() => {
    if (!CHAIN_CONFIGURED) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const addrs = await refreshHistory();
        if (cancelled) return;
        const saved = getCampaignAddress();
        const savedOk = addrs.some((a) => String(a).toLowerCase() === String(saved).toLowerCase());
        // 仅当前工厂期次有效；localStorage 若仍指向旧工厂期，强制切到最新一期
        const latest = addrs[0] || "";
        const target = savedOk ? saved : latest;
        if (!target) {
          clearCampaignAddress();
          setEmpty(true);
          setBook(null);
          bootedRef.current = true;
          return;
        }
        setEmpty(false);
        setCampaignAddress(target);
        bootedRef.current = true;
        await applyState(target, account, addrs);
      } catch (e) {
        if (!cancelled) setError(e.shortMessage || e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅挂载时引导一次；账户变化由下方 effect 补读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 账户变化后按当前选中期重读（补 self 分账）；不依赖 refresh，避免 boot 后 identity 变化连环请求
  useEffect(() => {
    if (!CHAIN_CONFIGURED || !bootedRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const addr = getCampaignAddress();
        if (addr) await applyState(addr, account);
      } catch (e) {
        if (!cancelled) setError(e.shortMessage || e.message || String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  useEffect(() => {
    if (!CHAIN_CONFIGURED) return undefined;
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const refreshPositions = useCallback(async () => {
    if (!CHAIN_CONFIGURED || campaignAddrs.length === 0) return;
    setPositionsLoading(true);
    try {
      setPositions(await readAccountAcrossCampaigns(account, campaignAddrs));
    } catch {
      /* 保留上一次结果 */
    } finally {
      setPositionsLoading(false);
    }
  }, [account, campaignAddrs]);

  useEffect(() => {
    if (!CHAIN_CONFIGURED || campaignAddrs.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      setPositionsLoading(true);
      try {
        const rows = await readAccountAcrossCampaigns(account, campaignAddrs);
        if (!cancelled) setPositions(rows);
      } catch {
        /* 单期失败已在读取函数里吞掉 */
      } finally {
        if (!cancelled) setPositionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, campaignAddrs]);

  const rawRef = useRef(null);
  const [rawProvider, setRawProvider] = useState(null);
  const connectBusy = useRef(0);

  const applyWallet = useCallback((w) => {
    if (!w) return null;
    rawRef.current = w.raw;
    setRawProvider(w.raw);
    setSigner(w.signer);
    setAccount(w.account);
    return w;
  }, []);

  const connect = useCallback(async (preferred) => {
    connectBusy.current += 1;
    try {
      const w = await connectWallet(preferred || rawRef.current || undefined);
      return applyWallet(w);
    } finally {
      window.setTimeout(() => {
        connectBusy.current = Math.max(0, connectBusy.current - 1);
      }, 1500);
    }
  }, [applyWallet]);

  const disconnect = useCallback(() => {
    rawRef.current = null;
    setRawProvider(null);
    setSigner(null);
    setAccount(null);
  }, []);

  // 页面加载时静默恢复已授权钱包，避免「钱包已连上、顶栏仍显示尚未连接」
  useEffect(() => {
    if (!CHAIN_CONFIGURED) return undefined;
    let cancelled = false;
    (async () => {
      const w = await restoreWallet();
      if (!cancelled && w) applyWallet(w);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyWallet]);

  const switchCampaign = useCallback(
    async (addr) => {
      setEmpty(false);
      setCampaignAddress(addr);
      setCampaignAddr(addr);
      setLoading(true);
      setPicked(1);
      try {
        await applyState(addr, account);
      } catch (e) {
        if (String(getCampaignAddress()).toLowerCase() === String(addr).toLowerCase()) {
          setError(e.shortMessage || e.message || String(e));
        }
      } finally {
        if (String(getCampaignAddress()).toLowerCase() === String(addr).toLowerCase()) {
          setLoading(false);
        }
      }
    },
    [account, applyState]
  );

  useEffect(() => {
    const target = rawProvider;
    if (!target?.on) return;
    const onAcc = async (accs) => {
      const next = accs && accs[0] ? accs[0] : null;
      if (!next) {
        if (connectBusy.current > 0) return;
        setSigner(null);
        setAccount(null);
        return;
      }
      try {
        const w = await restoreWallet(target) || await connectWallet(target);
        applyWallet(w);
      } catch {
        setAccount(next);
        setSigner(null);
      }
    };
    const onChain = async () => {
      try {
        const w = await restoreWallet(target);
        if (w) applyWallet(w);
      } catch {
        /* 切链期间 RPC 失败时保留已连接地址 */
      }
    };
    target.on("accountsChanged", onAcc);
    target.on("chainChanged", onChain);
    return () => {
      target.removeListener?.("accountsChanged", onAcc);
      target.removeListener?.("chainChanged", onChain);
    };
  }, [rawProvider, applyWallet]);

  return {
    active: CHAIN_CONFIGURED,
    empty,
    loading,
    account,
    signer,
    book,
    round,
    connect,
    disconnect,
    refresh,
    refreshHistory,
    error,
    transistorUnitPrice: null,
    owner: book?.owner || deployments.deployer || "",
    campaignAddress,
    campaigns,
    positions,
    positionsLoading,
    refreshPositions,
    switchCampaign,
    setCampaignAddress: switchCampaign,
    picked,
    setPicked,
  };
}
