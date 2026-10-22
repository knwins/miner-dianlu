// 材料市场（MockMaterialMarket）调试：模拟卖方成交买单 / 模拟买方吃掉卖单。
// 只依赖已部署的合约，不会再部署任何东西。
//
// 列出本期挂单：
//   npx hardhat run scripts/market-debug.js --network bscTestnet
// 一键撮合本期全部买单（fillBid + 把元件 mint 给本期合约，随后可 confirmTransistors）：
//   FILL_BIDS=1 npx hardhat run scripts/market-debug.js --network bscTestnet
// 一键吃掉本期全部卖单（用当前钱包付 BNB 买下元件，卖出款记入市场 owed）：
//   FILL_ASKS=1 npx hardhat run scripts/market-debug.js --network bscTestnet
// 指定单张挂单成交：
//   BID_ID=1 BID_QTY=1 npx hardhat run scripts/market-debug.js --network bscTestnet
//   ASK_ID=1 ASK_QTY=1 npx hardhat run scripts/market-debug.js --network bscTestnet
// 期次地址默认读 deployments/<network>.json，也可用 CAMPAIGN=0x... 覆盖。
const { ethers, network } = require("hardhat");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const TOKEN_NAME = ["NAND", "LATCH"];

const MARKET_ABI = [
  "function nextBidId() view returns (uint256)",
  "function nextAskId() view returns (uint256)",
  "function bids(uint256) view returns (address buyer, address transistors, uint96 price, uint8 tokenId, uint16 feeBps, uint256 remaining)",
  "function asks(uint256) view returns (address seller, uint96 price, address transistors, uint8 tokenId, uint256 remaining)",
  "function owed(address) view returns (uint256)",
  "function fillBid(uint256 id, uint256 quantity)",
  "function fillAsk(uint256 id, uint256 quantity) payable",
];

const CAMPAIGN_ABI = [
  "function phase() view returns (uint8)",
  "function scene() view returns (uint8)",
  "function market() view returns (address)",
  "function transistors() view returns (address)",
  "function orderFilled() view returns (bool)",
  "function nandBidId() view returns (uint256)",
  "function latchBidId() view returns (uint256)",
  "function nandQty() view returns (uint256)",
  "function latchQty() view returns (uint256)",
  "function nandAskId() view returns (uint256)",
  "function latchAskId() view returns (uint256)",
  "function nandAskQty() view returns (uint256)",
  "function latchAskQty() view returns (uint256)",
  "function confirmTransistors()",
  "function withdrawMarketProceeds()",
];

const PHASE = ["None", "Buying", "Listed", "Ready"];
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

async function main() {
  const dep = deployment();
  const campaignAddr = process.env.CAMPAIGN || dep.campaign;
  if (!campaignAddr || !ethers.isAddress(campaignAddr)) {
    throw new Error("找不到期次地址：设置 CAMPAIGN=0x... 或先跑部署脚本写入 deployments/");
  }

  const [signer] = await ethers.getSigners();
  const campaign = new ethers.Contract(campaignAddr, CAMPAIGN_ABI, signer);
  const marketAddr = await campaign.market();
  const market = new ethers.Contract(marketAddr, MARKET_ABI, signer);
  const transistors = await campaign.transistors();

  console.log(`网络      ：${network.name}`);
  console.log(`操作钱包  ：${signer.address}（${ethers.formatEther(await ethers.provider.getBalance(signer.address))} BNB）`);
  console.log(`Campaign  ：${campaignAddr}  场景 ${SCENE[Number(await campaign.scene())] || "?"} / 阶段 ${PHASE[Number(await campaign.phase())] || "?"}`);
  console.log(`市场      ：${marketAddr}`);
  console.log(`元件      ：${transistors}`);
  console.log("");

  async function printBids() {
    const next = Number(await market.nextBidId());
    const rows = [];
    for (let id = 1; id < next; id++) {
      const b = await market.bids(id);
      if (b.remaining === 0n) continue;
      rows.push(`  bid #${id} ${TOKEN_NAME[Number(b.tokenId)] || b.tokenId} 剩余 ${b.remaining} 颗 单价 ${ethers.formatEther(b.price)} BNB 买家 ${b.buyer}`);
    }
    console.log(rows.length ? `买单（${rows.length}）：\n${rows.join("\n")}` : "买单：无未成交挂单");
  }

  async function printAsks() {
    const next = Number(await market.nextAskId());
    const rows = [];
    for (let id = 1; id < next; id++) {
      const a = await market.asks(id);
      if (a.remaining === 0n) continue;
      rows.push(`  ask #${id} ${TOKEN_NAME[Number(a.tokenId)] || a.tokenId} 剩余 ${a.remaining} 单价 ${ethers.formatEther(a.price)} BNB 卖家 ${a.seller}`);
    }
    console.log(rows.length ? `卖单（${rows.length}）：\n${rows.join("\n")}` : "卖单：无未成交挂单");
  }

  /** 模拟卖方成交：fillBid 后把元件 mint 给买家（本期合约）。 */
  async function fillBid(id, quantity, label) {
    const b = await market.bids(id);
    if (b.remaining === 0n) return console.log(`${label}：已全部成交，跳过`);
    const qty = quantity == null || quantity > b.remaining ? b.remaining : quantity;
    console.log(`${label}：fillBid(${id}, ${qty}) + mint ${TOKEN_NAME[Number(b.tokenId)] || b.tokenId} → ${b.buyer}`);
    await (await market.fillBid(id, qty)).wait();
    const parts = new ethers.Contract(b.transistors, ["function mint(address,uint256,uint256)"], signer);
    await (await parts.mint(b.buyer, b.tokenId, qty)).wait();
  }

  /** 模拟买方成交：付 BNB 吃掉卖单，元件进当前钱包。 */
  async function fillAsk(id, quantity, label) {
    const a = await market.asks(id);
    if (a.remaining === 0n) return console.log(`${label}：已全部成交，跳过`);
    const qty = quantity == null || quantity > a.remaining ? a.remaining : quantity;
    const value = a.price * qty;
    console.log(`${label}：fillAsk(${id}, ${qty}) 支付 ${ethers.formatEther(value)} BNB 给 ${a.seller}`);
    await (await market.fillAsk(id, qty, { value })).wait();
  }

  const bidId = envBig("BID_ID");
  const bidQty = envBig("BID_QTY");
  const askId = envBig("ASK_ID");
  const askQty = envBig("ASK_QTY");

  if (process.env.FILL_BIDS === "1") {
    const legs = [
      [await campaign.nandBidId(), await campaign.nandQty(), "NAND 买单"],
      [await campaign.latchBidId(), await campaign.latchQty(), "LATCH 买单"],
    ];
    for (const [id, qty, label] of legs) {
      if (id === 0n || qty === 0n) continue;
      await fillBid(id, null, label);
    }
    console.log(`orderFilled() = ${await campaign.orderFilled()}`);
  }

  if (process.env.FILL_ASKS === "1") {
    const legs = [
      [await campaign.nandAskId(), await campaign.nandAskQty(), "NAND 卖单"],
      [await campaign.latchAskId(), await campaign.latchAskQty(), "LATCH 卖单"],
    ];
    for (const [id, qty, label] of legs) {
      if (id === 0n || qty === 0n) continue;
      await fillAsk(id, null, label);
    }
  }

  if (bidId != null) await fillBid(bidId, bidQty, `指定买单 #${bidId}`);
  if (askId != null) await fillAsk(askId, askQty, `指定卖单 #${askId}`);

  if (process.env.CONFIRM === "1") {
    console.log("confirmTransistors() …");
    await (await campaign.confirmTransistors()).wait();
    console.log(`阶段：${PHASE[Number(await campaign.phase())]}`);
  }
  if (process.env.WITHDRAW === "1") {
    console.log("withdrawMarketProceeds() …");
    await (await campaign.withdrawMarketProceeds()).wait();
  }

  console.log("");
  await printBids();
  await printAsks();
  const partsReader = new ethers.Contract(transistors, ["function balanceOf(address,uint256) view returns (uint256)"], signer);
  console.log(`市场欠本期合约：${ethers.formatEther(await market.owed(campaignAddr))} BNB`);
  console.log(`本期持有元件：NAND ${await partsReader.balanceOf(campaignAddr, 0)} / LATCH ${await partsReader.balanceOf(campaignAddr, 1)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
