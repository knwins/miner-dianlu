// 链上数据源钩子：CHAIN_CONFIGURED 时轮询 readState → 适配成 book/round。
// 无钱包时用公共 RPC 只读；连接钱包后可签名写操作。本地模拟作为回退保留在 App。
import { useCallback, useEffect, useState } from "react";
import { Contract } from "ethers";
import { IS_CONFIGURED as CHAIN_CONFIGURED } from "./config.js";
import { readState, connectWallet, getReadProvider } from "./client.js";
import { roundFromDeployment, bookFromState } from "./adapter.js";
import deployments from "./deployments.json";

export function useChain(extra = {}) {
  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const [book, setBook] = useState(null);
  const [round, setRound] = useState(() => (CHAIN_CONFIGURED ? roundFromDeployment(deployments) : null));
  const [transistorUnitPrice, setTransistorUnitPrice] = useState(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!CHAIN_CONFIGURED) return;
    try {
      const state = await readState(account);
      setBook(bookFromState(state, account, extra));
      setError("");
    } catch (e) {
      setError(e.shortMessage || e.message || String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, extra.estimate]);

  useEffect(() => {
    if (!CHAIN_CONFIGURED) return;
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  // 读取晶体管铸造器单价（execute 锁价用）
  useEffect(() => {
    if (!CHAIN_CONFIGURED || !deployments.minter) return;
    (async () => {
      try {
        const c = new Contract(deployments.minter, ["function quote(uint256) view returns (uint256)"], getReadProvider());
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

  useEffect(() => {
    if (!window.ethereum) return;
    const onAcc = (accs) => {
      setAccount(accs && accs[0] ? accs[0] : null);
      setSigner(null);
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
    account,
    signer,
    book,
    round,
    connect,
    refresh,
    error,
    transistorUnitPrice,
    owner: book?.owner || deployments.deployer || "",
  };
}
