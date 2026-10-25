// 与 contracts/contracts/Campaign.sol 对齐的最小 ABI（human-readable，ethers v6 直接可用）。
// materialMarket() 是新代码的晶体管市场 getter；market() 保留给旧工厂造出来的期次
// （含主网期次 #0 与测试网期次）—— 读取处的双名回退见 client.js 的 readMaterialMarket()。
export const CAMPAIGN_ABI = [
  // ── 自动 getter（public 状态变量） ──
  "function scene() view returns (uint8)",
  "function phase() view returns (uint8)",
  "function sold() view returns (uint256)",
  "function outstandingShares() view returns (uint256)",
  "function serviceFeeBps() view returns (uint16)",
  "function serviceFeeSet() view returns (bool)",
  "function feeRecipientCount() view returns (uint256)",
  "function feeRecipientAt(uint256) view returns (address)",
  "function feeSharesBpsAt(uint256) view returns (uint16)",
  "function pendingFee(address) view returns (uint256)",
  "function totalPendingFee() view returns (uint256)",
  "function revenuePool() view returns (uint256)",
  "function surplusPool() view returns (uint256)",
  "function surplusBase() view returns (uint256)",
  "function surplusPaid() view returns (uint256)",
  "function surplusOf(address) view returns (uint256)",
  "function soldOutAt() view returns (uint64)",
  "function lastOrderAt() view returns (uint64)",
  "function executionFailed() view returns (bool)",
  "function pooled() view returns (bool)",
  "function raisedBnb() view returns (uint256)",
  "function totalRefunded() view returns (uint256)",
  "function priceLock() view returns (uint256)",
  "function nandBidId() view returns (uint256)",
  "function latchBidId() view returns (uint256)",
  "function nandQty() view returns (uint256)",
  "function latchQty() view returns (uint256)",
  "function nandPrice() view returns (uint96)",
  "function latchPrice() view returns (uint96)",
  "function nandAskId() view returns (uint256)",
  "function latchAskId() view returns (uint256)",
  "function nandAskQty() view returns (uint256)",
  "function latchAskQty() view returns (uint256)",
  "function nandAskPrice() view returns (uint96)",
  "function latchAskPrice() view returns (uint96)",
  "function estHashpower() view returns (uint256)",
  "function sharePriceBnb() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function fundingDeadline() view returns (uint64)",
  "function transistors() view returns (address)",
  "function materialMarket() view returns (address)",
  "function market() view returns (address)", // 旧工厂期次专用 getter（主网期次 #0 / 测试网期次）
  "function miningPool() view returns (address)",
  "function factory() view returns (address)",
  "function owner() view returns (address)",
  // ── 显式 view ──
  "function sharesOf(address) view returns (uint256)",
  "function holderCount() view returns (uint256)",
  "function holderAt(uint256) view returns (address)",
  "function escrowOf(address) view returns (uint256)",
  "function refundedOf(address) view returns (uint256)",
  "function surplusClaimedOf(address) view returns (uint256)",
  "function pendingSurplus(address) view returns (uint256)",
  "function totalPendingSurplus() view returns (uint256)",
  "function listingCount() view returns (uint256)",
  "function getListing(uint256) view returns (tuple(address seller, uint256 shares, uint256 priceBnbPerShare, bool open))",
  "function orderFilled() view returns (bool)",
  // ── 写 ──
  "function subscribe(uint256 count) payable",
  "function refund()",
  "function claimSurplus()",
  "function claimFee()",
  "function setServiceFee(uint16 bps, address[] recipients, uint16[] sharesBps)",
  "function listShares(uint256 count, uint256 priceBnbPerShare)",
  "function cancelListing(uint256 id)",
  "function takeListing(uint256 id, uint256 count) payable",
  "function placeTransistorOrder(uint256 nandQty, uint96 nandPrice, uint256 latchQty, uint96 latchPrice)",
  "function placeTransistorAsk(uint256 nandQty, uint96 nandPrice, uint256 latchQty, uint96 latchPrice)",
  "function cancelTransistorAsk()",
  "function withdrawMarketProceeds()",
  "function returnSurplus()",
  "function openRefund()",
  "function abandonOrder()",
  "function cancelTransistorOrder()",
  "function markFailed()",
  "function confirmTransistors()",
  "function confirmSale()",
  "function setPhase(uint8 next)",
  "function setMaterialMarket(address materialMarket_)",
  "function setMiningPool(address pool_)",
  "function setPlan(uint256 estHashpower)",
  "function depositToPool()",
  "function harvest()",
  "function claim() returns (uint256)",
  "function recoverBnb()",
  "function recoverTransistors(address token, uint256 id, uint256 amount)",
  "function transferOwnership(address newOwner)",
  // ── 事件 ──
  "event Subscribed(address indexed subscriber, uint256 count, uint256 paidBnb)",
  "event Refunded(address indexed holder, uint256 amountBnb)",
  "event SurplusClaimed(address indexed holder, uint256 amountBnb)",
  "event RefundSendFailed(address indexed holder, uint256 amountBnb)",
  "event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare)",
  "event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb)",
  "event ListingCancelled(uint256 indexed id, address indexed seller, uint256 count)",
  "event ExecutionFailed(uint256 needBnb, uint256 raisedBnb)",
  "event TransistorOrderPlaced(uint256 count, uint256 escrowBnb)",
  "event TransistorOrderCancelled()",
  "event TransistorAskPlaced(uint256 nandQty, uint256 latchQty, uint256 nandAskId, uint256 latchAskId)",
  "event TransistorAskCancelled()",
  "event TransistorsConfirmed()",
  "event MiningPoolSet(address indexed previous, address indexed next)",
  "event DepositedToPool(address indexed pool, uint256 nandAmount, uint256 latchAmount)",
  "event MaterialMarketUpdated(address indexed previous, address indexed next)",
  "event BnbRecovered(uint256 amount, address indexed to)",
  "event TransistorsRecovered(address indexed token, uint256 indexed id, uint256 amount, address indexed to)",
  "event PlanUpdated(uint256 estHashpower)",
];

/**
 * 晶体管市场 ABI。
 *
 * ⚠️ 同名事件在主网晶体管市场与 Mock 里的**签名不同**（2026-10-23 用 nodereal 拉
 * 主网市场日志解出来的，topic0 已逐一核对）：
 *
 *   官方 BidPlaced(uint256,address,address,uint8,uint256,uint256)  0xcc402b0b…
 *     —— 价是 uint256；Mock 是 uint96，签名不同 → 用 Mock ABI 解析必然失败，
 *        看起来就像「市场没有事件」。两个变体都要留在 ABI 里，ethers 按 topic 选。
 *   官方 BidFilled(uint256 indexed id, address indexed seller, uint256 quantity,
 *                  uint256 proceeds, uint256 fee)                  0x8ba8eb46…
 *     —— 5 个参数；Mock 是 (id, quantity, remaining) 3 个。
 *        proceeds + fee = 买家为这批晶体管付出的托管额（fee 恒为 1%）。
 *   官方 BidCancelled(uint256,uint256) 与 Mock **同签名**（0x434f4081…），只写一份。
 *   晶体管市场没有卖单侧（placeAsk 不存在），所以 AskPlaced / AskFilled /
 *   AskCancelled / ProceedsWithdrawn 只有 Mock 会发。
 */
export const MATERIAL_MARKET_ABI = [
  "function nextBidId() view returns (uint256)",
  "function nextAskId() view returns (uint256)",
  "function bids(uint256) view returns (address buyer, address transistors, uint96 price, uint8 tokenId, uint16 feeBps, uint256 remaining)",
  "function asks(uint256) view returns (address seller, uint96 price, address transistors, uint8 tokenId, uint256 remaining)",
  "function owed(address) view returns (uint256)",
  "function fillBid(uint256 id, uint256 quantity)",
  "function fillAsk(uint256 id, uint256 quantity) payable",
  "function cancelBid(uint256 id)",
  "function cancelAsk(uint256 id)",
  "function withdraw()",
  // —— 晶体管市场（主网 0xA6a80C19…，EIP-1967 代理）——
  "event BidPlaced(uint256 indexed id, address indexed buyer, address indexed transistors, uint8 tokenId, uint256 price, uint256 quantity)",
  "event BidFilled(uint256 indexed id, address indexed seller, uint256 quantity, uint256 proceeds, uint256 fee)",
  "event BidCancelled(uint256 indexed id, uint256 refund)",
  // —— Mock 市场（测试网）——
  "event BidPlaced(uint256 indexed id, address indexed buyer, address indexed transistors, uint8 tokenId, uint96 price, uint256 quantity)",
  "event BidFilled(uint256 indexed id, uint256 quantity, uint256 remaining)",
  "event AskPlaced(uint256 indexed id, address indexed seller, address indexed transistors, uint8 tokenId, uint96 price, uint256 quantity)",
  "event AskFilled(uint256 indexed id, address indexed buyer, uint256 quantity, uint256 paid)",
  "event AskCancelled(uint256 indexed id, uint256 quantity)",
  "event ProceedsWithdrawn(address indexed account, uint256 amount)",
];

/** MockERC1155 的调试入口：测试网晶体管由任何人 mint，用来代替卖方交割。 */
export const MOCK_PARTS_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function mint(address to, uint256 id, uint256 amount)",
];

export const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function campaignCount() view returns (uint256)",
  "function campaigns(uint256) view returns (address)",
  "function isRegistered(address campaign) view returns (bool)",
  "function materialMarket() view returns (address)",
  // 晶体管白名单：工厂部署时写入，之后不可增删。白名单是安全边界 ——
  // 不在白名单里的 ERC1155 不允许开期（主网上防止把期次指向 MockERC1155）。
  "function allowedPartsCount() view returns (uint256)",
  "function allowedPartsAt(uint256) view returns (address)",
  "function isAllowedParts(address) view returns (bool)",
  // fundingSeconds 是秒，不是天：单位换算在前端做（days × 86400）。
  // transistors 是**必选的处理器**：零地址一律 revert（工厂不再有默认晶体管），
  // 且必须在白名单内。开期时前端必须显式选择一个处理器。
  "function createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint64 fundingSeconds,address transistors) returns (address)",
  "function removeCampaign(uint256 index)",
  "function transferOwnership(address newOwner)",
  "event CampaignCreated(uint256 indexed index, address indexed campaign, uint256 sharePriceBnb, uint256 totalShares, uint64 fundingDeadline)",
  "event CampaignRemoved(uint256 indexed index, address indexed campaign)",
  "error ZeroAddress()",
  "error ZeroCampaignParam()",
  "error EmptyWhitelist()",
  "error IndexOutOfBounds()",
  "error PartsNotAllowed(address parts)",
];
