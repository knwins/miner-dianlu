/**
 * 模拟 OKX：eth_chainId 被 1rpc 超额打回，但账户已授权。
 * 连接和刷新恢复都必须拿到地址，且不能调用 wallet_addEthereumChain。
 */
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

const calls = [];
const ACCOUNT = "0xeba1b24d36487a75c533233a07d6899a268bb9aa";
const quota = () => {
  const err = new Error("You've reached the usage limit for your current plan. https://www.1rpc.io/#pricing");
  err.code = -32001;
  throw err;
};

function provider(flags) {
  return {
    ...flags,
    request: async ({ method }) => {
      calls.push(method);
      if (method === "eth_chainId") quota();
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      if (method === "wallet_addEthereumChain" || method === "wallet_switchEthereumChain") {
        throw new Error(`should not call ${method}`);
      }
      return null;
    },
    on() {},
    removeListener() {},
  };
}

const okx = provider({ isOkxWallet: true });
const metamask = provider({ isMetaMask: true });
globalThis.window = {
  ethereum: okx,
  okxwallet: okx,
  navigator: { userAgent: "Mozilla/5.0 OKX" },
  location: { href: "http://127.0.0.1:5173/" },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

const { connectWallet, restoreWallet } = await import("../src/chain/client.js");

calls.length = 0;
const connected = await connectWallet(okx);
if (connected.account.toLowerCase() !== ACCOUNT) throw new Error("connect account " + connected.account);
if (!connected.signer) throw new Error("signer missing despite bad eth_chainId: " + calls.join(","));
if (calls.includes("wallet_addEthereumChain") || calls.includes("wallet_switchEthereumChain")) {
  throw new Error("connect rewrote chain: " + calls.join(","));
}

calls.length = 0;
window.ethereum = metamask;
window.okxwallet = okx;
const restored = await restoreWallet();
if (!restored || restored.account.toLowerCase() !== ACCOUNT) throw new Error("restore failed " + restored?.account);
if (calls.includes("eth_requestAccounts")) throw new Error("restore prompted");
if (calls.includes("wallet_addEthereumChain") || calls.includes("eth_chainId")) {
  throw new Error("restore touched chain RPC: " + calls.join(","));
}
console.log("okx connect+restore ok", calls.join(","));
