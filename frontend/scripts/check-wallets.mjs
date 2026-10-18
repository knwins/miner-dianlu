import { discoverWallets } from "../src/chain/wallets.js";

function mock(win) {
  globalThis.window = win;
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
}

const provider = (flags) => ({ request() {}, ...flags });

mock({
  navigator: { userAgent: "Mozilla/5.0 (iPhone) Mobile" },
  ethereum: undefined,
  location: { href: "http://localhost:5173/" },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
});
const mobile = await discoverWallets();
const names = mobile.map((item) => `${item.kind}:${item.name}`);
if (!names.includes("deeplink:TokenPocket")) throw new Error("mobile missing TP " + names.join(","));
if (names[0] !== "deeplink:TokenPocket") throw new Error("TP not first " + names.join(","));

const tp = provider({ isTokenPocket: true, isMetaMask: true });
const mm = provider({ isMetaMask: true });
mock({
  navigator: { userAgent: "Mozilla/5.0" },
  ethereum: { ...mm, providers: [mm, tp], request() {} },
  tokenpocket: { ethereum: tp },
  location: { href: "http://localhost:5173/" },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
});
const desk = await discoverWallets();
if (desk[0].name !== "TokenPocket") throw new Error("desktop TP not preferred " + desk.map((d) => d.name).join(","));
if (desk.some((d) => d.name === "MetaMask" && d.provider?.isTokenPocket)) {
  throw new Error("TP labeled as MetaMask");
}
console.log("ok", names.join(" | "));
console.log("desk", desk.map((d) => d.name).join(" | "));
