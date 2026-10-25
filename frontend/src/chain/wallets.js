// 钱包发现与唤起。桌面用注入的 EIP-1193；手机无注入时用深链打开钱包内置浏览器。
// TokenPocket 会同时伪装成 MetaMask，必须先认 isTokenPocket / window.tokenpocket。

const KNOWN = [
  { id: "tokenpocket", name: "TokenPocket", match: (p) => Boolean(p?.isTokenPocket) },
  { id: "okx", name: "OKX Wallet", match: (p) => Boolean(p?.isOkxWallet || p?.isOKExWallet) },
  { id: "trust", name: "Trust Wallet", match: (p) => Boolean(p?.isTrust || p?.isTrustWallet) },
  { id: "binance", name: "Binance Wallet", match: (p) => Boolean(p?.isBinance) },
  { id: "coinbase", name: "Coinbase Wallet", match: (p) => Boolean(p?.isCoinbaseWallet) },
  { id: "bitget", name: "Bitget Wallet", match: (p) => Boolean(p?.isBitKeep || p?.isBitget) },
  { id: "imtoken", name: "imToken", match: (p) => Boolean(p?.isImToken) },
  {
    id: "metamask",
    name: "MetaMask",
    match: (p) => Boolean(
      p?.isMetaMask
      && !p?.isTokenPocket
      && !p?.isOkxWallet
      && !p?.isTrust
      && !p?.isBinance
      && !p?.isBitKeep
      && !p?.isCoinbaseWallet
    ),
  },
];

export function isMobile() {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}

export function inAppWalletName() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  if (/TokenPocket/i.test(ua)) return "TokenPocket";
  if (/MetaMask/i.test(ua)) return "MetaMask";
  if (/Trust/i.test(ua)) return "Trust Wallet";
  if (/OKApp|OKEx|\bOKX\b/i.test(ua)) return "OKX Wallet";
  if (/imToken/i.test(ua)) return "imToken";
  if (/BitKeep|Bitget/i.test(ua)) return "Bitget Wallet";
  if (/Coinbase/i.test(ua)) return "Coinbase Wallet";
  if (/Binance/i.test(ua)) return "Binance Wallet";
  return "";
}

function pageUrl() {
  return window.location.href.split("#")[0];
}

function labelOf(provider, fallbackName) {
  for (const item of KNOWN) {
    if (item.match(provider)) return item;
  }
  return { id: "injected", name: fallbackName || "浏览器钱包" };
}

function addProvider(list, provider, fallbackName) {
  if (!provider || typeof provider.request !== "function") return;
  if (list.some((item) => item.provider === provider)) return;
  const named = labelOf(provider, fallbackName);
  list.push({
    id: `${named.id}-${list.length}`,
    walletId: named.id,
    name: fallbackName || named.name,
    provider,
    kind: "injected",
  });
}

function discoverEip6963(timeout = 350) {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve([]);
      return;
    }
    const found = [];
    const onAnnounce = (event) => {
      const detail = event?.detail;
      if (!detail?.provider) return;
      found.push({
        provider: detail.provider,
        name: detail.info?.name || "",
      });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve(found);
    }, timeout);
  });
}

function waitForInjection(ms) {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false);
      return;
    }
    if (window.ethereum || window.tokenpocket?.ethereum) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      window.removeEventListener("ethereum#initialized", done);
      resolve(Boolean(window.ethereum || window.tokenpocket?.ethereum));
    }, ms);
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("ethereum#initialized", done);
      resolve(true);
    };
    window.addEventListener("ethereum#initialized", done, { once: true });
  });
}

function deepLinks() {
  const url = pageUrl();
  const tpParams = encodeURIComponent(JSON.stringify({
    url,
    chain: "BSC",
    source: "TapeOut",
  }));
  const hostPath = url.replace(/^https?:\/\//, "");
  return [
    {
      id: "deeplink-tokenpocket",
      walletId: "tokenpocket",
      name: "TokenPocket",
      kind: "deeplink",
      hint: "在 TokenPocket 中打开本页",
      href: `tpdapp://open?params=${tpParams}`,
    },
    {
      id: "deeplink-metamask",
      walletId: "metamask",
      name: "MetaMask",
      kind: "deeplink",
      hint: "在 MetaMask 内置浏览器打开",
      href: `https://metamask.app.link/dapp/${hostPath}`,
    },
    {
      id: "deeplink-trust",
      walletId: "trust",
      name: "Trust Wallet",
      kind: "deeplink",
      hint: "在 Trust 内置浏览器打开",
      href: `https://link.trustwallet.com/open_url?coin_id=20000714&url=${encodeURIComponent(url)}`,
    },
    {
      id: "deeplink-okx",
      walletId: "okx",
      name: "OKX Wallet",
      kind: "deeplink",
      hint: "在 OKX 内置浏览器打开",
      href: `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`,
    },
  ];
}

/** 当前环境能连接或唤起的钱包。TokenPocket 排在前面。 */
export async function discoverWallets() {
  const inApp = inAppWalletName();
  await waitForInjection(inApp ? 1500 : 250);
  const announced = await discoverEip6963(inApp ? 500 : 300);
  const list = [];
  for (const item of announced) addProvider(list, item.provider, item.name);
  if (typeof window !== "undefined") {
    addProvider(list, window.tokenpocket?.ethereum, "TokenPocket");
    addProvider(list, window.okxwallet, "OKX Wallet");
    addProvider(list, window.trustwallet, "Trust Wallet");
    addProvider(list, window.bitkeep?.ethereum, "Bitget Wallet");
    const eth = window.ethereum;
    if (eth?.providers?.length) {
      for (const provider of eth.providers) addProvider(list, provider);
    }
    addProvider(list, eth);
    addProvider(list, window.BinanceChain, "Binance Wallet");
  }
  const seen = new Set();
  const unique = [];
  for (const item of list) {
    if (item.walletId !== "injected" && seen.has(item.walletId)) continue;
    if (item.walletId !== "injected") seen.add(item.walletId);
    unique.push(item);
  }
  list.length = 0;
  list.push(...unique);
  list.sort((a, b) => Number(b.walletId === "tokenpocket") - Number(a.walletId === "tokenpocket"));

  if (isMobile() && !inApp) {
    for (const link of deepLinks()) {
      if (!list.some((item) => item.walletId === link.walletId && item.kind === "injected")) {
        list.push(link);
      }
    }
  }
  if (!isMobile() && list.length === 0) {
    list.push(
      {
        id: "install-tokenpocket",
        walletId: "tokenpocket",
        name: "安装 TokenPocket",
        kind: "install",
        hint: "手机用 App 打开本页，电脑可装浏览器插件",
        href: "https://www.tokenpocket.pro/",
      },
      {
        id: "install-metamask",
        walletId: "metamask",
        name: "安装 MetaMask",
        kind: "install",
        hint: "安装后刷新本页再连接",
        href: "https://metamask.io/download/",
      },
    );
  }
  return list;
}

const WALLET_ID_KEY = "miner.walletId";

export function walletIdOf(provider) {
  return labelOf(provider).id;
}

export function rememberWallet(provider) {
  try {
    sessionStorage.setItem(WALLET_ID_KEY, walletIdOf(provider));
  } catch {
    /* 隐私模式 */
  }
}

export function rememberedWalletId() {
  try {
    return sessionStorage.getItem(WALLET_ID_KEY) || "";
  } catch {
    return "";
  }
}

export function explainConnectError(error) {
  const code = error?.code ?? error?.data?.originalError?.code;
  if (code === 4001 || /user rejected|user denied/i.test(error?.message || "")) {
    return "已在钱包里取消";
  }
  if (code === "NO_WALLET" || code === "NEED_CHOICE") return error.message;
  const text = String(error?.shortMessage || error?.message || "连接失败");
  if (/usage limit|1rpc|#pricing|-32001|missing response|BAD_DATA/i.test(text)) {
    return "钱包节点额度用尽（常见是 1rpc）。请把 BSC 主网 RPC 改成 https://bsc-rpc.publicnode.com 后再连接。";
  }
  if (/403|网络连接失败|data-seed-prebsc|bnbchain\.org/i.test(text)) {
    return "钱包 RPC 连不上。请把 BSC 主网节点改成 https://bsc-rpc.publicnode.com，或断开重连。";
  }
  return text.replace(/^Error:\s*/, "");
}
