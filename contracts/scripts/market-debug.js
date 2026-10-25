// 电路市场（官方 sell-side Circuit Market / MockCircuitMarket）调试：查看挂单、买入电路、挂回卖出。
// 只依赖已部署的合约，不会再部署工厂或期次。
//
// 官方电路市场只有**卖单侧**：list / delist / buy / listingFor / listings / owed / withdraw。
// 因此本期「采购」= 吃市场上的卖单（buyCircuits），「卖出」= 把持有的电路挂回市场（listCircuit）。
//
// 列出本期状态与市场挂单：
//   npx hardhat run scripts/market-debug.js --network bscTestnet
// 买入市场上属于本期电路合约的卖单（按 LISTING_ID）：
//   BUY_LISTING=12 npx hardhat run scripts/market-debug.js --network bscTestnet
// 一次买入前 N 张（按价格从低到高）：
//   BUY_COUNT=3 npx hardhat run scripts/market-debug.js --network bscTestnet
// 把本期持有的一张电路挂回市场（价格不得低于成本价）：
//   LIST_TOKEN=1 LIST_PRICE_BNB=0.002 npx hardhat run scripts/market-debug.js --network bscTestnet
// 撤单 / 确认到账 / 提取市场货款：
//   CANCEL_TOKEN=1 ... / CONFIRM=1 ... / WITHDRAW=1 ...
// 期次地址默认读 deployments/<network>.json，也可用 CAMPAIGN=0x... 覆盖。
const { ethers, network } = require("hardhat");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const MARKET_ABI = [
  "function nextListingId() view returns (uint256)",
  "function listings(uint256) view returns (address seller, address circuits, uint96 price, uint16 feeBps, uint256 tokenId)",
  "function listingFor(address circuits, uint256 tokenId) view returns (uint256 id, address seller, uint96 price, bool valid)",
  "function owed(address) view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function withdraw()",
];

const CAMPAIGN_ABI = [
  "function phase() view returns (uint8)",
  "function scene() view returns (uint8)",
  "function circuitMarket() view returns (address)",
  "function circuits() view returns (address)",
  "function circuitCount() view returns (uint256)",
  "function circuitHeldCount() view returns (uint256)",
  "function circuitIds(uint256) view returns (uint256)",
  "function circuitCostBasis(uint256) view returns (uint96)",
  "function circuitListingId(uint256) view returns (uint256)",
  "function activeListingCount() view returns (uint256)",
  "function buyCircuits(uint256[] listingIds, uint256[] tokenIds, uint96[] prices)",
  "function confirmCircuits()",
  "function listCircuit(uint256 tokenId, uint96 price)",
  "function cancelCircuitListing(uint256 tokenId)",
  "function withdrawMarketProceeds()",
  "function miningStatus(uint256) view returns (uint8)",
];

const PHASE = ["None", "Buying", "Ready"];
const SCENE = ["Funding", "Executing", "Mining"];

function deployment() {
  const file = join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

function envBig(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return null;
  return BigInt(String(raw).trim());
}

function envStr(name) {
  const raw = process.env[name];
  return raw == null ? "" : String(raw).trim();
}

async function main() {
  const dep = deployment();
  const campaignAddr = process.env.CAMPAIGN || dep.campaign;
  if (!campaignAddr || !ethers.isAddress(campaignAddr)) {
    throw new Error("找不到期次地址：设置 CAMPAIGN=0x... 或先跑部署脚本写入 deployments/");
  }

  const [signer] = await ethers.getSigners();
  const campaign = new ethers.Contract(campaignAddr, CAMPAIGN_ABI, signer);
  const marketAddr = await campaign.circuitMarket();
  const market = new ethers.Contract(marketAddr, MARKET_ABI, signer);
  const circuits = await campaign.circuits();
  const phase = Number(await campaign.phase());
  const scene = Number(await campaign.scene());

  console.log(`网络      ：${network.name}`);
  console.log(`操作钱包  ：${signer.address}（${ethers.formatEther(await ethers.provider.getBalance(signer.address))} BNB）`);
  console.log(`Campaign  ：${campaignAddr}  场景 ${SCENE[scene] || "?"} / 阶段 ${PHASE[phase] || "?"}`);
  console.log(`市场      ：${marketAddr}（费率 ${Number(await market.feeBps()) / 100}%）`);
  console.log(`电路合约  ：${circuits}`);
  console.log(`持有电路  ：${await campaign.circuitHeldCount()} / 买入过 ${await campaign.circuitCount()} 张`);
  console.log("");

  /** 打印市场上属于本期电路合约、仍未成交的卖单。 */
  async function printListings() {
    const next = Number(await market.nextListingId());
    const rows = [];
    for (let id = 1; id < next; id++) {
      const l = await market.listings(id);
      const live = await market.listingFor(l.circuits, l.tokenId);
      if (!live.valid) continue;
      const mine = String(l.circuits).toLowerCase() === String(circuits).toLowerCase();
      rows.push(
        `  listing #${id} token #${l.tokenId} 单价 ${ethers.formatEther(l.price)} BNB 卖家 ${l.seller}${mine ? "  ← 本期可买" : ""}`,
      );
    }
    console.log(rows.length ? `市场卖单（${rows.length}）：\n${rows.join("\n")}` : "市场卖单：无");
  }

  async function printHeld() {
    const n = Number(await campaign.circuitCount());
    if (n === 0) return console.log("本期未买过电路");
    const rows = [];
    const token = new ethers.Contract(circuits, [
      "function ownerOf(uint256) view returns (address)",
      "function balanceOf(address) view returns (uint256)",
    ], ethers.provider);
    for (let i = 0; i < n; i++) {
      const id = await campaign.circuitIds(i);
      let owner = "";
      try { owner = await token.ownerOf(id); } catch { owner = "(已销毁?)"; }
      const held = String(owner).toLowerCase() === campaignAddr.toLowerCase();
      const listingId = await campaign.circuitListingId(id);
      rows.push(
        `  token #${id} 成本 ${ethers.formatEther(await campaign.circuitCostBasis(id))} BNB` +
        `${held ? " 持有中" : " 已卖出"}${listingId !== 0n ? ` 已挂单 #${listingId}` : ""}`,
      );
    }
    console.log(`本期电路（${n}）：\n${rows.join("\n")}`);
  }

  // 买入：显式 listing id，或按价格从低到高买 N 张。
  const buyListing = envBig("BUY_LISTING");
  const buyCount = envBig("BUY_COUNT");
  if (buyListing != null || buyCount != null) {
    const next = Number(await market.nextListingId());
    const candidates = [];
    for (let id = 1; id < next; id++) {
      const l = await market.listings(id);
      if (String(l.circuits).toLowerCase() !== String(circuits).toLowerCase()) continue;
      const live = await market.listingFor(l.circuits, l.tokenId);
      if (!live.valid) continue;
      candidates.push({ id: BigInt(id), tokenId: l.tokenId, price: l.price });
    }
    let picks;
    if (buyListing != null) {
      picks = candidates.filter((c) => c.id === buyListing);
      if (picks.length === 0) throw new Error(`listing #${buyListing} 不存在、已成交或不属于本期电路合约`);
    } else {
      candidates.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
      picks = candidates.slice(0, Number(buyCount));
      if (picks.length === 0) throw new Error("市场上没有属于本期电路合约的卖单");
    }
    const total = picks.reduce((s, c) => s + c.price, 0n);
    console.log(`buyCircuits(${picks.map((c) => c.id).join(",")}) 合计 ${ethers.formatEther(total)} BNB（从 raisedBnb 扣）…`);
    const tx = await campaign.buyCircuits(
      picks.map((c) => c.id),
      picks.map((c) => c.tokenId),
      picks.map((c) => c.price),
    );
    await tx.wait();
    console.log(`✓ 已买入 ${picks.length} 张（${tx.hash}）`);
  }

  const listToken = envBig("LIST_TOKEN");
  if (listToken != null) {
    const rawPrice = envStr("LIST_PRICE_BNB");
    if (!rawPrice) throw new Error("挂单需要 LIST_PRICE_BNB（不得低于该 token 的成本价）");
    const price = ethers.parseEther(rawPrice);
    console.log(`listCircuit(${listToken}, ${ethers.formatEther(price)} BNB) …`);
    await (await campaign.listCircuit(listToken, price)).wait();
  }

  const cancelToken = envBig("CANCEL_TOKEN");
  if (cancelToken != null) {
    console.log(`cancelCircuitListing(${cancelToken}) …`);
    await (await campaign.cancelCircuitListing(cancelToken)).wait();
  }

  if (process.env.CONFIRM === "1") {
    console.log("confirmCircuits() …");
    await (await campaign.confirmCircuits()).wait();
    console.log(`阶段：${PHASE[Number(await campaign.phase())]}`);
  }
  if (process.env.WITHDRAW === "1") {
    console.log("withdrawMarketProceeds() …");
    await (await campaign.withdrawMarketProceeds()).wait();
  }
  if (process.env.MARKET_WITHDRAW === "1") {
    // 卖家侧货款是 pull 模式：本脚本的 signer 若是卖家，可自行提取。
    console.log("market.withdraw() …");
    await (await market.withdraw()).wait();
  }

  console.log("");
  await printHeld();
  await printListings();
  console.log(`市场欠本期合约：${ethers.formatEther(await market.owed(campaignAddr))} BNB`);
  console.log(`本期挂单数：${await campaign.activeListingCount()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
