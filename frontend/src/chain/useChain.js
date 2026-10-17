// 链上数据源钩子：CHAIN_CONFIGURED 时轮询 readState → 适配成 book/round。
// 无钱包时用公共 RPC 只读；连接钱包后可签名写操作。本地模拟作为回退保留在 App。
// BEM挖矿认购默认展示工厂最新一期；顶栏可手动切到历史期。
import { useCallback, useEffect, useRef, useState } from "react";
import { Contract } from "ethers";
import { IS_CONFIGURED as CHAIN_CONFIGURED, CAMPAIGN_ADDRESS } from "./config.js";
import {
  readState,
  connectWallet,
  getReadProvider,
  getCampaignAddress,
  setCampaignAddress,
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
  const [transistorUnitPrice, setTransistorUnitPrice] = useState(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState(1);
  /** 是否已完成「默认最新一期」引导；之后用户手动切换不再被拉回 */
  const bootedRef = useRef(false);
  const extraRef = useRef(extra);
  extraRef.current = extra;

  const applyState = useCallback(async (addr, acc, addrs = campaignAddrs) => {
    const state = await readState(acc, addr);
    const idx = indexOfCampaign(addrs, addr);
    setRound((prev) => roundFromState(state, prev || roundFromDeployment(deployments), idx));
    setBook(bookFromState(state, acc, extraRef.current));
    setCampaignAddr(addr);
    setError("");
  }, [campaignAddrs]);

  const refresh = useCallback(async () => {
    if (!CHAIN_CONFIGURED) return;
    const addr = getCampaignAddress();
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
        const latest = addrs[0] || getCampaignAddress() || CAMPAIGN_ADDRESS;
        if (addrs[0]) setCampaignAddress(addrs[0]);
        bootedRef.current = true;
        await applyState(latest, account, addrs);
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
        await applyState(getCampaignAddress(), account);
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

  // 读取晶体管铸造器单价（execute 锁价用）
  useEffect(() => {
    if (!CHAIN_CONFIGURED || !deployments.minter) return;
    (async () => {
      try {
        const c = new Contract(
          deployments.minter,
          ["function quote(uint256) view returns (uint256)"],
          getReadProvider()
        );
        setTransistorUnitPrice(await c.quote(1));
      } catch {
        /* 忽略：非 Owner 也用不到 */
      }
    })();
  }, []);

  const connect = useCallback(async () => {
    const w = await connectWallet();
    setSigner(w.signer);
    setAccount(w.account);
    return w;
  }, []);

  const disconnect = useCallback(() => {
    setSigner(null);
    setAccount(null);
  }, []);

  const switchCampaign = useCallback(
    async (addr) => {
      setCampaignAddress(addr);
      setCampaignAddr(addr);
      setLoading(true);
      setPicked(1);
      try {
        await applyState(addr, account);
      } catch (e) {
        setError(e.shortMessage || e.message || String(e));
      } finally {
        setLoading(false);
      }
    },
    [account, applyState]
  );

  useEffect(() => {
    if (!window.ethereum) return;
    const onAcc = async (accs) => {
      const next = accs && accs[0] ? accs[0] : null;
      setAccount(next);
      if (!next) {
        setSigner(null);
        return;
      }
      // 切账户后重新拿 signer，避免开期时 signer 为空
      try {
        const w = await connectWallet();
        setSigner(w.signer);
        setAccount(w.account);
      } catch {
        setSigner(null);
      }
    };
    const onChain = () => window.location.reload();
    window.ethereum.on?.("accountsChanged", onAcc);
    window.ethereum.on?.("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAcc);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, []);

  return {
    active: CHAIN_CONFIGURED,
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
    transistorUnitPrice,
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
