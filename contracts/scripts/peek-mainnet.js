const { ethers } = require("ethers");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const env = {};
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const provider = new ethers.JsonRpcProvider("https://bsc-rpc.publicnode.com");
const wallet = new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY, provider);
const market = new ethers.Contract(
  "0xA6a80C1919a8326022d7c601a488888C13aA16E4",
  ["function nextBidId() view returns (uint256)", "function feeBps() view returns (uint16)"],
  provider
);
const bem = new ethers.Contract(
  "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a",
  [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function name() view returns (string)",
  ],
  provider
);
const pod = new ethers.Contract(
  "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46",
  [
    "function claim() returns (uint256)",
    "function start(bytes) returns (uint256)",
  ],
  provider
);

async function main() {
  console.log("deployer", wallet.address);
  console.log("bnb", ethers.formatEther(await provider.getBalance(wallet.address)));
  try {
    console.log("bem", await bem.name(), await bem.symbol(), Number(await bem.decimals()));
  } catch (e) {
    console.log("bem err", e.shortMessage || e.message);
  }
  try {
    console.log("nextBidId", (await market.nextBidId()).toString(), "feeBps", Number(await market.feeBps()));
  } catch (e) {
    console.log("market err", e.shortMessage || e.message);
  }
  try {
    await pod.start.staticCall("0x");
    console.log("pod start ok");
  } catch (e) {
    console.log("pod start", (e.shortMessage || e.message || "").slice(0, 180));
  }
}

main();
