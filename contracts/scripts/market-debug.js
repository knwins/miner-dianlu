// 晶体管市场（MockMaterialMarket）调试：模拟卖方成交买单 / 让本期吃买单卖出。
// 只依赖已部署的合约，不会再部署任何东西。
//
// 官方晶体管市场只有**买单侧**（没有 placeAsk / asks / fillAsk），
// 所以「卖出」在本脚本里是两种不同的动作，别混：
//   - FILL_BIDS=1：模拟**卖方**成交本期的买单（fillBid + 把晶体管 mint 给本期合约），
//     用于把期次从 Listed 推到 Ready。
//   - SELL_BID=<id>：**本期合约**调用 sellTransistors 吃一张已挂买单（真实的链上卖出）。
//
// 列出本期挂单与可吃的买单：
//   npx hardhat run scripts/market-debug.js --network bscTestnet
// 一键撮合本期全部买单（随后可 confirmTransistors / CONFIRM=1）：
//   FILL_BIDS=1 npx hardhat run scripts/market-debug.js --network bscTestnet
// 指定单张买单成交（模拟卖方）：
//   BID_ID=1 BID_QTY=1 npx hardhat run scripts/market-debug.js --network bscTestnet
// 本期合约吃买单卖出（source: deployer 私钥持有的 Owner 钱包）：
//   SELL_BID=1 SELL_TOKEN=0 SELL_QTY=1 npx hardhat run scripts/market-debug.js --network bscTestnet
// 期次地址默认读 deployments/<network>.json，也可用 CAMPAIGN=0x... 覆盖。
const { ethers, network } = require("hardhat");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const TOKEN_NAME = ["NAND", "LATCH"];

const MARKET_ABI = [
  "function nextBidId() view returns (uint256)",
  "function bids(uint256) view returns (address buyer, address transistors, uint96 price, uint8 tokenId, uint16 feeBps, uint256 remaining)",
  "function owed(address) view returns (uint256)",
  "function fillBid(uint256 id, uint256 quantity)",
];

const CAMPAIGN_ABI = [
  "function phase() view returns (uint8)",
  "function scene() view returns (uint8)",
  "function materialMarket() view returns (address)",
  "function transistors() view returns (address)",
  "function orderFilled() view returns (bool)",
  "function nandBidId() view returns (uint256)",
  "function latchBidId() view returns (uint256)",
  "function nandQty() view returns (uint256)",
  "function latchQty() view returns (uint256)",
  "function nandCostBasis() view returns (uint256)",
  "function latchCostBasis() view returns (uint256)",
  "function confirmTransistors()",
  "function sellTransistors(uint256 bidId, uint8 tokenId, uint256 quantity)",
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
  const marketAddr = await campaign.materialMarket();
  const market = new ethers.Contract(marketAddr, MARKET_ABI, signer);
  const transistors = await campaign.transistors();

  console.log(`网络      ：${network.name}`);
  console.log(`操作钱包  ：${signer.address}（${ethers.formatEther(await ethers.provider.getBalance(signer.address))} BNB）`);
  console.log(`Campaign  ：${campaignAddr}  场景 ${SCENE[Number(await campaign.scene())] || "?"} / 阶段 ${PHASE[Number(await campaign.phase())] || "?"}`);
  console.log(`市场      ：${marketAddr}`);
  console.log(`晶体管    ：${transistors}`);
  console.log("");

  /** 打印所有未成交买单；标的是本期晶体管的额外标注「可吃」。 */
  async function printBids() {
    const next = Number(await market.nextBidId());
    const rows = [];
    for (let id = 1; id < next; id++) {
      const b = await market.bids(id);
      if (b.remaining === 0n) continue;
      const mine = String(b.transistors).toLowerCase() === String(transistors).toLowerCase();
      rows.push(
        `  bid #${id} ${TOKEN_NAME[Number(b.tokenId)] || b.tokenId} 剩余 ${b.remaining} 颗 单价 ${ethers.formatEther(b.price)} BNB 买家 ${b.buyer}${mine ? "  ← 本期可吃" : ""}`
      );
    }
    console.log(rows.length ? `买单（${rows.length}）：\n${rows.join("\n")}` : "买单：无未成交挂单");
  }

  /** 模拟卖方成交：fillBid 后把晶体管 mint 给买家（本期合约）。 */
  async function fillBid(id, quantity, label) {
    const b = await market.bids(id);
    if (b.remaining === 0n) return console.log(`${label}：已全部成交，跳过`);
    const qty = quantity == null || quantity > b.remaining ? b.remaining : quantity;
    console.log(`${label}：fillBid(${id}, ${qty}) + mint ${TOKEN_NAME[Number(b.tokenId)] || b.tokenId} → ${b.buyer}`);
    await (await market.fillBid(id, qty)).wait();
    const parts = new ethers.Contract(b.transistors, ["function mint(address,uint256,uint256)"], signer);
    await (await parts.mint(b.buyer, b.tokenId, qty)).wait();
  }

  const bidId = envBig("BID_ID");
  const bidQty = envBig("BID_QTY");
  const sellBid = envBig("SELL_BID");
  const sellToken = envBig("SELL_TOKEN");
  const sellQty = envBig("SELL_QTY");

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

  if (bidId != null) await fillBid(bidId, bidQty, `指定买单 #${bidId}`);

  if (sellBid != null) {
    const b = await market.bids(sellBid);
    const tokenId = sellToken == null ? Number(b.tokenId) : Number(sellToken);
    const qty = sellQty == null ? b.remaining : sellQty;
    console.log(
      `sellTransistors(${sellBid}, ${tokenId}, ${qty}) · 单价 ${ethers.formatEther(b.price)} BNB` +
      ` · 本期成本 ${ethers.formatEther(tokenId === 0 ? await campaign.nandCostBasis() : await campaign.latchCostBasis())} BNB`
    );
    await (await campaign.sellTransistors(sellBid, tokenId, qty)).wait();
  }

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
  const partsReader = new ethers.Contract(transistors, ["function balanceOf(address,uint256) view returns (uint256)"], signer);
  console.log(`市场欠本期合约：${ethers.formatEther(await market.owed(campaignAddr))} BNB`);
  console.log(`本期持有晶体管：NAND ${await partsReader.balanceOf(campaignAddr, 0)} / LATCH ${await partsReader.balanceOf(campaignAddr, 1)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
