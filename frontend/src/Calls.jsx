import { useMemo, useState } from "react";
import {
  QUOTE,
  SCENE_COPY,
  buildHolders,
  estimateHashpower,
  formatClock,
  seedCalls,
  shortAddress,
  clampPriceInput,
} from "./fixtures.js";
import { FACTORY_ADDRESS, CAMPAIGN_ADDRESS } from "./chain/config.js";
import { getCampaignAddress, liveReadView } from "./chain/client.js";

/**
 * 「已售未退」份数（当前债务）。
 * sold 是单调的历史事实（本期卖出去过多少），退款不会让它变小；
 * 判断「还有没有人可退」必须用 outstandingShares。
 */
function outstandingOf(book) {
  const v = book?.outstandingShares;
  return v == null ? Number(book?.sold || 0) : Number(v);
}

function contractCatalog(round, book = {}) {
  // 不填假地址。之前这里硬编码 0xF4c700…F4c，部署记录缺失时页面会显示一个
  // 看起来像真地址的假地址，用户可能照着它手动发交易。
  // 没配置就如实写「未配置」。
  const factoryAddr = FACTORY_ADDRESS || "";
  const campaignAddr = round?.contract || getCampaignAddress() || CAMPAIGN_ADDRESS;
  return [
    {
      id: "factory",
      name: "CampaignFactory",
      address: factoryAddr,
      methods: [
        {
          name: "createCampaign",
          kind: "write",
          caller: "Factory Owner",
          signature: "createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint64 fundingSeconds,address transistors) returns (address)",
          summary: "发布众筹挖矿。开期需 份额单价 / 总份数 / 募集天数 / 元件合约 四个参数。第三个参数是秒：前端把天数 × 86400 后传入。第四个参数是**元件合约（= 处理器）**：零地址会 revert（工厂不再有默认元件），必须从工厂白名单里选一个官方元件合约，否则 revert PartsNotAllowed。白名单是安全边界（防期次指向无访问控制的 MockERC1155），部署时写入、不可增删。",
          fields: [
            ["sharePriceBnb", "每份 BNB", round.sharePriceBnb],
            ["totalShares", "总份数", round.totalShares],
            ["fundingSeconds", "募集秒数", Number(round.fundingDays || 0) * 86400],
          ],
        },
        {
          name: "removeCampaign",
          kind: "write",
          caller: "Factory Owner",
          signature: "removeCampaign(address campaign) → 遍历 campaigns[] → removeCampaign(uint256)",
          summary: "按地址移除一期：前端遍历 campaigns(0..count) 查到索引，再调用 removeCampaign(index)。不销毁链上 Campaign。",
          fields: [["campaign", "期次地址", campaignAddr || "0x"]],
        },
        {
          name: "removeCampaignAt",
          kind: "write",
          caller: "Factory Owner",
          signature: "removeCampaign(uint256 index)",
          summary: "按工厂数组索引移除一期（链上重载 removeCampaign(uint256)）。仅 Factory Owner。",
          fields: [["index", "索引", "0"]],
        },
        {
          name: "allowedPartsCount",
          kind: "read",
          caller: "任何人",
          signature: "allowedPartsCount() view",
          summary: "工厂元件白名单的条目数。白名单在**部署时写入、之后不可增删** —— 它是安全边界（防期次指向无访问控制的 MockERC1155），不是运营开关。开期表单的可选处理器由它生成。",
          fields: [],
        },
        {
          name: "allowedPartsAt",
          kind: "read",
          caller: "任何人",
          signature: "allowedPartsAt(uint256) view",
          summary: "白名单第 index 项的元件合约地址。主网应为官方两件套：TapeOut 0xCC42ba5D… / Behemoth 0xE2DfD802…（两者均有挖矿产出资格）。",
          fields: [["index", "索引", "0"]],
        },
        {
          name: "isAllowedParts",
          kind: "read",
          caller: "任何人",
          signature: "isAllowedParts(address) view",
          summary: "某元件合约是否在白名单内。createCampaign 传白名单外的地址会 revert PartsNotAllowed。",
          fields: [["parts", "元件合约地址", "0x"]],
        },
        {
          name: "setFactoryOwner",
          kind: "write",
          caller: "Factory Owner",
          signature: "CampaignFactory.transferOwnership(address)",
          summary: "转让工厂 Owner（= 改 owner）。",
          fields: [["newOwner", "新 Owner", ""]],
        },
      ],
    },
    {
      id: "campaign",
      name: "Campaign",
      address: campaignAddr,
      methods: [
        { name: "scene", kind: "read", caller: "任何人", signature: "scene() view", summary: "当前场景：Funding / Executing / Mining。", fields: [] },
        { name: "phase", kind: "read", caller: "任何人", signature: "phase() view", summary: "待执行子态：None / Buying / Listed / Ready。", fields: [] },
        { name: "sold", kind: "read", caller: "任何人", signature: "sold() view", summary: "累计已售份数（历史事实，只增不减 —— 退款不会让它变小，所以 owner 的下单资格不受退款影响）。", fields: [] },
        { name: "outstandingShares", kind: "read", caller: "任何人", signature: "outstandingShares() view", summary: "已售未退份数（当前债务）。按比例退款的分母就是它。", fields: [] },
        { name: "serviceFeeBps", kind: "read", caller: "任何人", signature: "serviceFeeBps() view", summary: "本期挖矿产出服务费率（基点，1/10000）。0 = 不收。链上可读，不再是前端本地记录。认筹款不收服务费。", fields: [] },
        { name: "feeRecipientCount", kind: "read", caller: "任何人", signature: "feeRecipientCount() view", summary: "挖矿产出服务费分成地址数量。", fields: [] },
        { name: "revenuePool", kind: "read", caller: "任何人", signature: "revenuePool() view", summary: "挖矿收益池（已扣服务费的净额）。owner 扫不走。装的是挖矿产出，不是认筹款。", fields: [] },
        { name: "surplusOf", kind: "read", caller: "任何人", signature: "surplusOf(address) view", summary: "某地址当前可领取的入池余款（含尚未计提的部分）。", fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]] },
        { name: "sharePriceBnb", kind: "read", caller: "任何人", signature: "sharePriceBnb() view", summary: "每份价格（BNB）。", fields: [] },
        { name: "totalShares", kind: "read", caller: "任何人", signature: "totalShares() view", summary: "总份数。", fields: [] },
        { name: "estHashpower", kind: "read", caller: "任何人", signature: "estHashpower() view", summary: "预估算力（setPlan 写入；未进入挖矿时展示）。", fields: [] },
        { name: "totalRefunded", kind: "read", caller: "任何人", signature: "totalRefunded() view", summary: "累计已退本金（BNB）。", fields: [] },
        { name: "pendingSurplus", kind: "read", caller: "任何人", signature: "pendingSurplus(address) view", summary: "某地址已计提但尚未转出的入池余款（BNB）。C-4 之后余款改 pull 模式：入池时不再遍历推款，只记分配基准（surplusPool / surplusBase），持份人自己调 claimSurplus() 领。地址拒收导致领取失败时金额原样保留可重试。", fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]] },
        { name: "totalPendingSurplus", kind: "read", caller: "任何人", signature: "totalPendingSurplus() view", summary: "全期待领取余款总额（BNB）。这部分钱不属于 Owner，recoverBnb 不会扫走。", fields: [] },
        { name: "raisedBnb", kind: "read", caller: "任何人", signature: "raisedBnb() view", summary: "合约代持的 BNB 托管池。", fields: [] },
        { name: "transistors", kind: "read", caller: "任何人", signature: "transistors() view", summary: "开期锁定的元件 ERC1155 合约（TapeOut / Behemoth 或测试网 Mock）。", fields: [] },
        { name: "materialMarket", kind: "read", caller: "任何人", signature: "materialMarket() view", summary: "材料市场地址。旧工厂造出来的期次（主网期次 #0、测试网期次）该 getter 名为 market()，读取时双名回退。", fields: [] },
        { name: "executionFailed", kind: "read", caller: "任何人", signature: "executionFailed() view", summary: "是否已判执行失败；为真时持有人可 refund。", fields: [] },
        { name: "soldOutAt", kind: "read", caller: "任何人", signature: "soldOutAt() view", summary: "售罄时刻；非 Owner 的 markFailed 要等到售罄满 3 天。", fields: [] },
        { name: "priceLock", kind: "read", caller: "任何人", signature: "priceLock() view", summary: "挂单锁定的元件总成本（BNB）与颗粒数。", fields: [] },
        { name: "holderCount", kind: "read", caller: "任何人", signature: "holderCount() view", summary: "认筹地址数量。", fields: [] },
        {
          name: "sharesOf",
          kind: "read",
          caller: "任何人",
          signature: "sharesOf(address) view",
          summary: "某地址持有的份数。",
          fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]],
        },
        {
          name: "subscribe",
          kind: "write",
          caller: "用户",
          signature: "subscribe(uint256 count)",
          summary: "认筹（Subscribe）：按整数份支付 BNB。只在募集中、且不超过剩余份数时成功。",
          fields: [["shares", "份数", "1"]],
        },
        { name: "listShares", kind: "write", caller: "持份用户 / Owner", signature: "listShares(uint256,uint256)", summary: "在份额转让市场发布出售挂单：第 1 参份数、第 2 参每份 BNB 单价。挂出份额立即锁定，不能领取或转让，直到卖出或撤单。这是持份用户在挖矿中转出份额的唯一途径。", fields: [["shares", "份数", "3"], ["priceBnbPerShare", "每份 BNB", round.sharePriceBnb.toFixed(4)]] },
        { name: "cancelListing", kind: "write", caller: "挂单方 / Owner", signature: "cancelListing(uint256)", summary: "撤销自己发布的挂单，释放锁定份额回到可用余额。", fields: [["listingId", "挂单 ID", "L1"]] },
        { name: "takeListing", kind: "write", caller: "任一持份用户", signature: "takeListing(uint256,uint256)", summary: "按发布价接收（买入）挂单：第 1 参挂单 ID、第 2 参接收份数。份额过户到买方，BNB 支付给卖方。不能接收自己的挂单。", fields: [["listingId", "挂单 ID", "L1"], ["shares", "份数", "1"]] },
        { name: "refund", kind: "write", caller: "持份用户 / Owner", signature: "refund()", summary: "三种本金返还：① 募集超过截止时间仍未售罄；② 待执行阶段已判失败（本金尚未支出）；③ 待挂单且池子已不足以按原价兑付（按比例退）。份额清零。与挖矿中的份额转让无关。", fields: [] },
        { name: "claimSurplus", kind: "write", caller: "持份用户", signature: "claimSurplus()", summary: "领取入池时未花完的募集款余款（pull 模式）。入池时合约**不再遍历持份人推款**（那会因 gas 上限卡死 owner），只记录分配基准（surplusPool / surplusBase），持份人自己调这个函数按份领取。地址拒收导致领取失败时整笔回滚，金额原样保留可重试。", fields: [] },
        { name: "claimFee", kind: "write", caller: "服务费收款方", signature: "claimFee()", summary: "服务费收款方领取自己那笔**挖矿产出**服务费（pull 模式）。矿池把挖矿收益打进来时按链上分成表计提，Owner 扫不走。与认筹款无关。", fields: [] },
        {
          name: "setServiceFee",
          kind: "write",
          caller: "Owner",
          signature: "setServiceFee(uint16 bps,address[] recipients,uint16[] sharesBps)",
          summary: "设定本期服务费率与多地址分成表。**只能在尚无人认购时调用**（sold == 0），一旦有人认购即永久锁定。费率硬上限 10%，分成份额合计必须等于 10000。⚠️ 这是**挖矿产出奖励**的服务费（从 depositRevenue 的收益里计提），**认筹款不收服务费**。",
          fields: [
            ["bps", "费率（基点，1/10000）", "500"],
            ["recipients", "收款地址数组", '["0x..."]'],
            ["sharesBps", "各地址份额（基点，合计 10000）", "[10000]"],
          ],
        },
        { name: "markFailed", kind: "write", caller: "任何人（非 Owner 须售罄满 3 天）", signature: "markFailed()", summary: "把待执行期次标记为执行失败，从而为所有持有人打开 refund()。若买单还挂着，会先把未成交部分撤掉，托管退回募集池；撤单被市场拒绝时整笔回滚，可稍后重试。用于 Owner 失联时逃生；3 天宽限期防止单个持有人杀掉仍在买元件的健康期次。Owner 随时可调。", fields: [] },
        { name: "claim", kind: "write", caller: "用户", signature: "claim()", summary: "占位实现（no-op）：挖矿中调用只返回 0，不产出发放；分配合约接入后才会恢复领取。", fields: [] },
        {
          name: "depositToPool",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "depositToPool()",
          summary: "晶体管到账并确认后，Owner 调一次即可把元件投入矿池，本期进入挖矿（不可逆）。之前需先 setPlan 写入预估算力与元件数。",
          fields: [],
        },
        {
          name: "confirmTransistors",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "confirmTransistors()",
          summary: "读取官方材料市场 bids(id).remaining。两腿都成交且元件已到账才进入待入池。未成交会回退，不能靠网页手工确认。任何人可调。",
          fields: [],
        },
        {
          name: "placeTransistorOrder",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "placeTransistorOrder(address transistors, uint256 nandQty, uint96 nandPrice, uint256 latchQty, uint96 latchPrice)",
          summary: "调用材料市场 placeBid。NAND tokenId 0、LATCH tokenId 1，保证金从募集款托管。开期已锁定元件合约，地址只能填 0 或与本期 transistors 相同；一次只能有一张挂单（先撤卖单）。买不起则标 executionFailed 且不挂单，不 revert。",
          fields: [
            ["transistors", "元件合约（留空 = 用本期锁定的地址）", book.transistors || ""],
            ["nandQty", "NAND 数量（颗，可留空）", "100"],
            ["nandPrice", "NAND 买价 BNB（最多 5 位小数）", "0.05610"],
            ["latchQty", "LATCH 数量（颗，可留空）", "0"],
            ["latchPrice", "LATCH 买价 BNB（最多 5 位小数）", "0"],
          ],
        },
        {
          name: "cancelTransistorOrder",
          kind: "write",
          caller: "未成交仅 Factory Owner；已有成交时任何人",
          signature: "cancelTransistorOrder()",
          summary: "只撤未成交部分，保证金按剩余量退回本期并回到待挂单。已成交的元件上链即不可撤，会留在本期合约。全部成交且元件已到账时不能取消。",
          fields: [],
        },
        {
          name: "placeTransistorAsk",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "placeTransistorAsk(uint256,uint96,uint256,uint96)",
          summary: "仅买单确认到账（Ready）后可挂。把本期合约持有的 NAND/LATCH 挂到官方卖单。成交后必须 confirmSale，才能再挂买单或退款。",
          fields: [
            ["nandQty", "NAND 数量", "1"],
            ["nandPrice", "NAND 卖价 BNB（最多 5 位小数）", "0.05000"],
            ["latchQty", "LATCH 数量", "0"],
            ["latchPrice", "LATCH 卖价 BNB（最多 5 位小数）", "0"],
          ],
        },
        {
          name: "cancelTransistorAsk",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "cancelTransistorAsk()",
          summary: "取消未成交卖单，元件退回本期合约。全部成交后改点确认卖出。",
          fields: [],
        },
        {
          name: "setPhase",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "setPhase(uint8)",
          summary: "待执行时改子状态，防止元件或募集款卡在本期。不搬运代币，也不撤市场上的单。0 无，1 待挂单，2 挂单中，3 已到账。挂单中不能改，先取消或放弃。改成 1 之后才能取回元件。",
          fields: [["next", "子状态 0–3", "1"]],
        },
        {
          name: "confirmSale",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "confirmSale()",
          summary: "卖单已成交或剩余已取消后，提取卖出款并回到待挂单。之后才能再挂买单或退款。",
          fields: [],
        },
        {
          name: "withdrawMarketProceeds",
          kind: "write",
          caller: "任何人",
          signature: "withdrawMarketProceeds()",
          summary: "把材料市场 owed 里的卖出款提到本期 raisedBnb。",
          fields: [],
        },
        {
          name: "openRefund",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "openRefund()",
          summary: "待挂单，或买单已确认且没有未确认卖单时，批量原路退款。确认后的退款会把剩余元件退回 Owner。份额已全部退完（sold == 0）时没有可退对象，会以 ZeroShares 回滚；这种情况用 recoverBnb() 扫尾差。",
          fields: [],
        },
        {
          name: "abandonOrder",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "abandonOrder()",
          summary: "待执行任意子态下放弃本期：撤未成交买单、撤卖单、提取市场欠款、把元件退回 Owner，再按池子批量退款。用来解开卡住的单（openRefund 在挂单中会回滚）。",
          fields: [],
        },
        {
          name: "setPlan",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "setPlan(uint256)",
          summary: "写入预估算力。仅 funding 或 executing+buying。元件数不是参数，由实际下单数量决定。",
          fields: [
            ["hashpower", "预估算力", "0"],
          ],
        },
        {
          name: "setMiningPool",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "setMiningPool(address)",
          summary: "设定本期投入的矿池地址（depositToPool 时元件转入此处）。",
          fields: [["pool", "矿池地址", ""]],
        },
        {
          name: "harvest",
          kind: "write",
          caller: "任何人",
          signature: "harvest()",
          summary: "全网分发（占位实现：当前合约 harvest 为 no-op，不产出发放）。",
          fields: [],
        },
        {
          name: "setMaterialMarket",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "Campaign.setMaterialMarket(address)",
          summary: "更换本期材料市场。挂单、撤单都打到这个合约。",
          fields: [["materialMarket", "材料市场地址", ""]],
        },
        {
          name: "recoverBnb",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "recoverBnb()",
          summary: "测试救援。把卡在本期的 BNB 一次性转给当前 Owner，不用填数量：募集/待执行只转出超过 raisedBnb 的多余余额（保住认筹本金）；挖矿中或所有人都已退款后，整池剩余 BNB 全部转出。",
          fields: [],
        },
        {
          name: "recoverTransistors",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "recoverTransistors(address,uint256,uint256)",
          summary: "把本期持有的晶体管转给 Owner。挂单中不可转。已到账可以取，子状态不变：取出后元件不再锁在合约里，入池前需重新确认元件在手。NAND 的 id 为 0，LATCH 为 1。",
          fields: [
            ["token", "晶体管合约", book.transistors || ""],
            ["id", "tokenId", "0"],
            ["amount", "数量", "1"],
          ],
        },
        {
          name: "transferOwnership",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "Campaign.transferOwnership(address)",
          summary: "转让本期 Owner。",
          fields: [["newOwner", "新 Owner", ""]],
        },
      ],
    },
    {
      id: "market",
      name: "材料市场（Mock 调试）",
      address: book.market || "由本期合约 materialMarket() 读取（旧期次为 market()）",
      methods: [
        {
          name: "marketOpenOrders",
          kind: "read",
          caller: "任何人",
          signature: "nextBidId() / bids(id) / nextAskId() / asks(id)",
          summary: "列出材料市场所有未成交的买单和卖单（含单价、剩余、买卖方）。撮合前先看这张单。",
          fields: [],
        },
        {
          name: "marketBids",
          kind: "read",
          caller: "任何人",
          signature: "bids(uint256) view",
          summary: "单张买单详情：买家、元件合约、单价、tokenId、剩余数量。",
          fields: [["id", "买单 ID", "1"]],
        },
        {
          name: "marketAsks",
          kind: "read",
          caller: "任何人",
          signature: "asks(uint256) view",
          summary: "单张卖单详情：卖家、单价、元件合约、tokenId、剩余数量。",
          fields: [["id", "卖单 ID", "1"]],
        },
        {
          name: "marketOwed",
          kind: "read",
          caller: "任何人",
          signature: "owed(address) view",
          summary: "市场欠某地址的卖出款。地址留空时读本期合约；卖单成交后用它确认应该提取多少。",
          fields: [["account", "地址（留空 = 本期合约）", ""]],
        },
        {
          name: "simulateFillBid",
          kind: "write",
          caller: "任意调试钱包",
          signature: "bids(id) → fillBid(id, quantity) → MockERC1155.mint(buyer)",
          summary: "模拟卖方成交：扣减市场剩余，并把同数量元件铸给买单买家（本期合约）。两条腿都成交后即可「确认到账」。",
          fields: [["id", "买单 ID", "1"], ["quantity", "成交数量（留空 = 全部剩余）", ""]],
        },
        {
          name: "simulateFillCampaignBids",
          kind: "write",
          caller: "任意调试钱包",
          signature: "nandBidId() / latchBidId() → fillBid + mint",
          summary: "一键撮合本期两张买单并补齐元件。成功后点「确认到账」，接着就能挂卖单或 depositToPool 入池。",
          fields: [],
        },
        {
          name: "simulateFillAsk",
          kind: "write",
          caller: "任意调试钱包",
          signature: "asks(id) → fillAsk(id, quantity) payable",
          summary: "模拟买方吃单：按卖单价付 BNB，元件进入当前钱包，卖出款记入市场 owed。",
          fields: [["id", "卖单 ID", "1"], ["quantity", "吃单数量（留空 = 全部剩余）", ""]],
        },
        {
          name: "simulateFillCampaignAsks",
          kind: "write",
          caller: "任意调试钱包",
          signature: "nandAskId() / latchAskId() → fillAsk",
          summary: "一键吃掉本期两张卖单。卖出款进市场 owed，随后「提取卖出款」或「确认卖出」。",
          fields: [],
        },
      ],
    },
    {
      id: "upstream",
      name: "上游合约",
      address: "由本期合约调用",
      methods: [
        {
          name: "placeBid / placeAsk",
          kind: "internal",
          caller: "仅本期合约",
          signature: "placeBid / cancelBid / placeAsk / cancelAsk / withdraw",
          summary: "挂买成交并确认后才能挂卖。卖单成交后再确认，才能重新挂买或退款。",
          fields: [],
        },
      ],
    },
  ];
}

export function ContractCalls({ round, book, connected, wallet, pending, onInvoke, actor, quote, chainMode = false, embedded = false }) {
  const catalog = useMemo(() => contractCatalog(round, book), [round, book]);
  const [selected, setSelected] = useState("campaign.scene");
  const [args, setArgs] = useState({});
  const [result, setResult] = useState(null);
  const [logs, setLogs] = useState(() => (chainMode ? [] : seedCalls(round)));
  const [reading, setReading] = useState(false);
  const method = findMethod(catalog, selected);
  const gate = method ? callGate(method, book, round, connected, actor) : { ok: false, reason: "未选择函数" };
  const fields = method ? method.fields.map(([key, label, fallback]) => [key, label, args[key] ?? String(fallback)]) : [];
  // 元件挂单价按五位小数限制输入，避免用户填的 0.00456 被静默截成 0.0045
  const isPriceField = (key) => /price/i.test(key);

  function choose(id) {
    setSelected(id);
    setArgs({});
    setResult(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (!method || !gate.ok) return;
    const payload = Object.fromEntries(fields.map(([key, , value]) => [key, value]));
    // 链上模式：读操作实时 eth_call，不读本地缓存
    if (chainMode && method.kind === "read") {
      setReading(true);
      try {
        const message = await liveReadView(method.name, payload, wallet);
        const outcome = { ok: true, message: message || "（空）" };
        setResult(outcome);
        setLogs((current) => [{ time: Date.now(), method: method.name, ok: true, message: outcome.message }, ...current]);
      } catch (e) {
        const outcome = { ok: false, message: e.message || String(e) };
        setResult(outcome);
        setLogs((current) => [{ time: Date.now(), method: method.name, ok: false, message: outcome.message }, ...current]);
      } finally {
        setReading(false);
      }
      return;
    }
    const outcome = onInvoke(method.name, payload);
    setResult(outcome);
    setLogs((current) => [{ time: Date.now(), method: method.name, ok: outcome.ok, message: outcome.message }, ...current]);
  }

  return (
    <section>
      {!embedded && (
        <header className="page-header">
          <div>
            <h1>合约调用</h1>
            <p className="page-subtitle">
              {chainMode
                ? "链上模式：写操作会发起真实交易；读操作展示 BEM挖矿认筹 状态。"
                : "从这里读取和发送本期会用到的函数。上游合约只能由本期合约内部调用。"}
            </p>
          </div>
        </header>
      )}

      <div className="layout">
        <article className="card">
          <div className="card-header">函数</div>
          <div className="card-body method-list">
            {catalog.map((group) => (
              <div key={group.id}>
                <div className="menu-group-title">
                  {group.name} · {typeof group.address === "string" && group.address.startsWith("0x") ? shortAddress(group.address) : group.address}
                </div>
                {group.methods.map((item) => {
                  const id = `${group.id}.${item.name}`;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={selected === id ? "method-item active" : "method-item"}
                      onClick={() => choose(id)}
                    >
                      <span>{item.name}</span>
                      <em className={`tag tag-${item.kind}`}>{kindLabel(item.kind)}</em>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </article>

        <article className="card">
          <div className="card-header">
            <span>{method?.name}</span>
            <em className={`tag tag-${method?.kind}`}>{method ? kindLabel(method.kind) : ""}</em>
          </div>
          <form className="card-body" onSubmit={submit}>
            <p className="mono">{method?.signature}</p>
            <p className="fine">{method?.summary}</p>
            <p className="fine">调用方：{method?.caller}</p>
            <div className="form-grid">
              {fields.map(([key, label, value]) => (
                <label key={key} className="field wide">
                  <span>{label}</span>
                  <input
                    value={value}
                    inputMode={isPriceField(key) ? "decimal" : undefined}
                    step={isPriceField(key) ? "0.00001" : undefined}
                    onChange={(event) => {
                      const next = isPriceField(key) ? clampPriceInput(event.target.value) : event.target.value;
                      setArgs((current) => ({ ...current, [key]: next }));
                    }}
                  />
                </label>
              ))}
            </div>
            {gate.ok ? <p className="check-ok">当前状态可以调用。</p> : <div className="issues"><p>{gate.reason}</p></div>}
            <button className="btn btn-primary" type="submit" disabled={!gate.ok || Boolean(pending) || reading}>
              {reading ? "链上读取中…" : pending || (method?.kind === "read" ? (chainMode ? "链上读取" : "读取") : "发送交易")}
            </button>
            {result && (
              <div className={result.ok ? "result-box ok" : "result-box fail"}>
                {result.ok ? "成功" : "失败"} · {result.message}
              </div>
            )}
            <p className="fine">发送账户：{connected ? shortAddress(wallet) : "未连接"}</p>
          </form>
        </article>
      </div>

      <article className="card">
        <div className="card-header">调用记录 · {logs.length} 笔</div>
        <div className="card-body table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>函数</th>
                <th>结果</th>
                <th>返回</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={`${log.time}-${log.method}-${log.message}`}>
                  <td>{formatClock(log.time)}</td>
                  <td>{log.method}</td>
                  <td><span className={`badge ${log.ok ? "tone-live" : "tone-back"}`}>{log.ok ? "成功" : "失败"}</span></td>
                  <td>{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}

function findMethod(catalog, id) {
  for (const group of catalog) {
    const method = group.methods.find((item) => `${group.id}.${item.name}` === id);
    if (method) return method;
  }
  return null;
}

function kindLabel(kind) {
  if (kind === "read") return "读取";
  if (kind === "write") return "写入";
  return "内部";
}

export function callGate(method, book, round, connected, actor = { role: "user", shares: 0 }) {
  if (method.kind === "internal") return { ok: false, reason: "这个函数只允许本期合约内部调用。" };
  if (method.kind === "read") return { ok: true, reason: "" };
  if (method.name.startsWith("simulateFill")) {
    if (!connected) return { ok: false, reason: "模拟撮合需要连接钱包（任意测试网钱包都可以）。" };
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不再有元件挂单可撮合。" };
    if (method.name === "simulateFillCampaignBids" && book.orderFilled) {
      return { ok: false, reason: "本期买单已全部成交，直接「确认到账」即可。" };
    }
    if (
      method.name === "simulateFillCampaignAsks"
      && !book.askOpen
      && !(Number(book.nandAskQty) > 0 || Number(book.latchAskQty) > 0)
    ) {
      return { ok: false, reason: "本期还没有卖单，先「挂卖单」再模拟吃单。" };
    }
    return { ok: true, reason: "测试网 Mock 撮合：会真实发交易；买单成交时额外 mint 测试元件给买家。" };
  }
  if (method.name === "createCampaign") {
    if (!connected) return { ok: false, reason: "createCampaign 需要连 Factory Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Factory Owner 可发布众筹挖矿。" };
    return { ok: true, reason: "将发布众筹挖矿，成功后切换到新合约。" };
  }
  if (method.name === "removeCampaign" || method.name === "removeCampaignAt") {
    if (!connected) return { ok: false, reason: "移除期次需要连接 Factory Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Factory Owner 可从工厂列表移除期次。" };
    return { ok: true, reason: "仅从列表摘除，不销毁链上 Campaign。" };
  }
  if (method.name === "recoverBnb") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可以把 BNB 转给自己。" };
    if (book.scene !== "mining" && outstandingOf(book) > 0) {
      return { ok: true, reason: "一次取走超过 raisedBnb 的多余余额；认筹本金留在本期。不用填数量。" };
    }
    return { ok: true, reason: "本期已无人可退：一次取走整池剩余 BNB。不用填数量。" };
  }
  if (method.name === "recoverTransistors") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可以把晶体管转给自己。" };
    if (book.executePhase === "listed") return { ok: false, reason: "挂单中不能转出晶体管，先撤单或等确认到账。" };
    if (book.executePhase === "ready" && book.readyExit === false) {
      return { ok: false, reason: "这期是旧合约。确认到账后元件取不出，官网也用不了它，入池和退出都走不通。" };
    }
    if (book.executePhase === "ready") {
      return { ok: true, reason: "取出后子状态仍是已到账。重新放回本期并确认后，才能 depositToPool 入池。" };
    }
    return { ok: true, reason: "把本期持有的晶体管转给当前 Owner。" };
  }
  if (
    method.name === "setMaterialMarket" || method.name === "transferOwnership"
    || method.name === "setFactoryOwner"
  ) {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可更换外部依赖或转让所有权。" };
    return { ok: true, reason: "写入新地址后立即生效。" };
  }
  if (method.name === "subscribe") {
    if (!connected) return { ok: false, reason: "subscribe 需要已连接的用户钱包。" };
    if (book.scene !== "funding") return { ok: false, reason: "只有募集中可以认筹（subscribe）。" };
    if (book.sold >= round.totalShares) return { ok: false, reason: "份数已售完。" };
    return { ok: true, reason: "" };
  }
  if (method.name === "listShares") {
    if (book.scene !== "mining") return { ok: false, reason: "只有在挖矿中才能进行份额转让。" };
    if (book.mine <= 0) return { ok: false, reason: "当前钱包没有可用份额可挂牌。" };
    if (actor.role !== "owner" && actor.shares <= 0) {
      return { ok: false, reason: "只有持份用户 Factory Owner 可以发布出售。" };
    }
    return { ok: true, reason: "挂单后份额锁定，不能领取或转让，直到成交或撤单。" };
  }
  if (method.name === "cancelListing") {
    if (book.scene !== "mining") return { ok: false, reason: "只有在挖矿中才能进行份额转让。" };
    const listing = (book.listings || []).find((l) => l.id === method.fields?.find?.((f) => f[0] === "listingId")?.[1] || "");
    if (!listing) return { ok: false, reason: "挂单不存在或已成交。" };
    if (actor.role !== "owner" && String(actor.address || "").toLowerCase() !== String(listing.seller).toLowerCase()) {
      return { ok: false, reason: "只能撤销自己发布的挂单。" };
    }
    return { ok: true, reason: "撤单后锁定份额回到可用余额。" };
  }
  if (method.name === "takeListing") {
    if (book.scene !== "mining") return { ok: false, reason: "只有在挖矿中才能进行份额转让。" };
    const listing = (book.listings || []).find((l) => l.id === method.fields?.find?.((f) => f[0] === "listingId")?.[1] || "");
    if (!listing) return { ok: false, reason: "挂单不存在或已成交。" };
    if (String(actor.address || "").toLowerCase() === String(listing.seller).toLowerCase()) {
      return { ok: false, reason: "不能接收自己发布的挂单。" };
    }
    return { ok: true, reason: `按 ${listing.priceBnbPerShare} BNB/份接收，份额过户、BNB 支付给卖方。` };
  }
  if (method.name === "refund") {
    const fundingExpired = book.scene === "funding" && Date.now() > (book.endsAt || Infinity);
    const executeFailed = book.scene === "executing" && book.executionFailed;
    // 新逻辑：待挂单且池子不足以按原价兑付时，也可按比例退款。
    const shortPool = book.scene === "executing" && Boolean(book.refundShort);
    if (!fundingExpired && !executeFailed && !shortPool) {
      if (book.scene === "funding") return { ok: false, reason: "募集尚未结束，不能退款。" };
      if (book.scene === "executing") return { ok: false, reason: "本期尚未判执行失败，且池子仍够按原价兑付，不能退款。Owner 失联可等售罄满 3 天后调 markFailed。" };
      return { ok: false, reason: "只有在「募集超时未售罄」「执行失败」或「池子不足以按原价兑付」时才能原路退款。" };
    }
    if (book.mine <= 0) return { ok: false, reason: "当前钱包没有可退款的份额。" };
    return {
      ok: true,
      reason: shortPool
        ? `池子不足，按比例退款（约 ${Number(book.refundRatio || 0).toFixed(4)} BNB/份，以合约计算为准）。`
        : "退款后份额清零，BNB 原路退回认筹地址。",
    };
  }
  if (method.name === "markFailed") {
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行期次可以 markFailed。" };
    if (book.executionFailed) return { ok: false, reason: "本期已判执行失败，持有人直接 refund 即可。" };
    if (actor.role === "owner") {
      return { ok: true, reason: "Owner 可随时标记失败，为所有持有人打开 refund。挂着的买单会先被撤掉，押金退回募集池。这是不可逆操作。" };
    }
    if (!book.markFailedAt) return { ok: false, reason: "还没售罄，没有 3 天宽限期的起算点。" };
    const waitMs = Number(book.markFailedAt) - Date.now();
    if (waitMs > 0) {
      const hours = Math.ceil(waitMs / 3_600_000);
      return { ok: false, reason: `非 Owner 须在售罄满 3 天后才能调；还需约 ${hours} 小时。` };
    }
    return { ok: true, reason: "已过 3 天宽限期：先撤掉未成交的买单，再判失败并为所有持有人打开 refund。" };
  }
  if (method.name === "claim") {
    return { ok: false, reason: "claim 是占位实现（no-op）：不产出发放，前端不提供调用入口。" };
  }
  if (method.name === "claimSurplus") {
    const pending = Number(book.pendingSurplusSelf || 0);
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (pending <= 0) return { ok: false, reason: "当前钱包没有待领取的余款。入池时推送成功就没有余款可领。" };
    return { ok: true, reason: `领取 ${pending.toFixed(4)} BNB：入池时因你的地址拒收而未发出的余款。` };
  }
  if (method.name === "claimFee") {
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (!connected) return { ok: false, reason: "需要连接收款方钱包。" };
    return { ok: true, reason: "领取属于你自己的那笔挖矿产出服务费。没有可领金额时调用是 no-op（不扣 gas 之外无副作用）。" };
  }
  if (method.name === "setServiceFee") {
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅本期 Owner 可设定挖矿产出服务费。" };
    if (book.serviceFeeSet) {
      return { ok: false, reason: "本期挖矿产出服务费已设定并永久锁定（serviceFeeSet == true），改不了了。" };
    }
    if (Number(book.sold || 0) > 0) {
      return { ok: false, reason: "已有人认购，挖矿产出服务费已锁定。合约只允许在 sold == 0 时设定。" };
    }
    return { ok: true, reason: "费率上限 1000 bps（10%），分成地址最多 3 个，份额合计必须等于 10000 bps。设定后永久不可改。" };
  }
  if (method.name === "placeTransistorAsk") {
    // 官方材料市场只有买单侧：placeAsk / asks / nextAskId / cancelAsk / fillAsk 在主网都不存在。
    // 挂卖单在主网必然 revert，先在前端挡住，不让用户白付 gas。
    if (book._chain && book.marketAskSide === false) {
      return { ok: false, reason: "当前材料市场没有卖单侧（官方市场只有买单），挂卖单链上会直接 revert。可用路径：确认到账后直接 depositToPool 入池。" };
    }
  }
  if (method.name === "cancelTransistorAsk" || method.name === "confirmSale") {
    if (book._chain && book.marketAskSide === false) {
      return { ok: false, reason: "当前材料市场没有卖单侧，没有可撤/可确认的卖单。" };
    }
  }
  if (method.name === "placeTransistorOrder") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能挂单。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要挂单买元件。" };
    if (book.executePhase === "ready") return { ok: false, reason: "元件已到账，无需再挂单。" };
    if (book.executePhase === "listed") return { ok: false, reason: "已经在挂单中，待成交或取消。" };
    return { ok: true, reason: "填写数量与单价后锁价；进入「挂单中」可取消未成交部分或确认到账。" };
  }
  if (method.name === "cancelTransistorOrder") {
    // 与合约一致：orderFilled && _partsOnHand 时 revert OrderFilled，成交部分上链即不可撤。
    const nothingOpen = [
      book.nandRemaining, book.latchRemaining,
      book.nandAskRemaining, book.latchAskRemaining,
    ].every((remaining) => remaining != null && Number(remaining) === 0);
    if (book.orderFilled && nothingOpen) {
      return { ok: false, reason: "已全部成交，元件已上链，不能取消。请点「确认到账」后入池。" };
    }
    // 新逻辑：已有成交，或该期已从工厂移除时，任何人可撤剩余买单（防止托管款卡死）。
    const partial = (Number(book.nandQty) > 0 && Number(book.nandRemaining) < Number(book.nandQty))
      || (Number(book.latchQty) > 0 && Number(book.latchRemaining) < Number(book.latchQty));
    const anyone = partial || book.retired || book.orderFilled;
    if (!anyone && actor.role !== "owner") {
      return { ok: false, reason: "未成交时仅 Factory Owner 能撤单；已有成交或该期已从工厂移除后任何人都能撤剩余。" };
    }
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态有挂单可取消。" };
    if (book.executePhase !== "listed" && book.executePhase !== "ready") {
      return { ok: false, reason: "仅挂单中或已到账（Ready）时可取消/撤回。" };
    }
    return { ok: true, reason: "只撤未成交部分；已成交的元件会留在本期合约，随后需确认到账或按比例退款。" };
  }
  if (method.name === "placeTransistorAsk") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能挂卖单。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "要先确认买单到账，才能挂卖单。" };
    if (book.readyExit === false) return { ok: false, reason: "这期是旧合约。确认到账之后只能入池，不能挂卖。" };
    if (book.askOpen) return { ok: false, reason: "已经有一张卖单。" };
    return { ok: true, reason: "挂出后等待成交，再点确认卖出。" };
  }
  if (method.name === "cancelTransistorAsk") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可撤卖单。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态有卖单可撤。" };
    if (!book.askOpen && !(Number(book.nandAskQty) > 0 || Number(book.latchAskQty) > 0)) {
      return { ok: false, reason: "本期没有卖单记录，合约会以 NotAsked 回滚。" };
    }
    return { ok: true, reason: "未成交部分退回本期合约；已成交部分保留，之后点确认卖出提款。" };
  }
  if (method.name === "withdrawMarketProceeds") {
    if (!connected) return { ok: false, reason: "需要连接钱包（虽然任何人可调）。" };
    if (!(Number(book.marketOwed) > 0)) {
      return { ok: false, reason: "材料市场当前没有欠本期合约的款，调用是 no-op。" };
    }
    return { ok: true, reason: "把材料市场 owed 里的钱转进本期 raisedBnb，供退款或入池余量计算。" };
  }
  if (method.name === "setPhase") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可改子状态。" };
    if (book.scene === "mining" || book.scene === "funding") return { ok: false, reason: "只有待执行可以改子状态。" };
    if (book.executePhase === "listed") return { ok: false, reason: "挂单还在市场上。先取消或放弃挂单，再改子状态，否则托管款会留在市场。" };
    if (book.readyExit === false) return { ok: false, reason: "这期是旧合约，链上没有改子状态的入口。" };
    return { ok: true, reason: "只改 phase。改成 1（待挂单）后可以取回元件，再退款。" };
  }
  if (method.name === "confirmSale") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能确认卖出。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "只有买单确认后的卖单需要再确认。" };
    if (book.askOpen) return { ok: false, reason: "卖单还没全部成交，不能确认。" };
    return { ok: true, reason: "确认后回到待挂单，可以再挂买单或退款。" };
  }
  if (method.name === "confirmTransistors") {
    // 合约里 confirmTransistors() 是 external，任何人可调；前端只做状态校验。
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要确认到账。" };
    if (book.executePhase === "ready") return { ok: false, reason: "元件已确认到账，直接 depositToPool 入池开矿即可。" };
    if (book.executePhase !== "listed") return { ok: false, reason: "请先挂单，再确认成交到账。" };
    if (!book.orderFilled) return { ok: false, reason: "买单还没全部成交（bids.remaining > 0）。" };
    // 合约还要求本期合约真的持有元件；只成交不发货会以 TransistorsNotReady 回滚。
    const needNand = Number(book.nandQty) || 0;
    const needLatch = Number(book.latchQty) || 0;
    if ((Number(book.partsNand) || 0) < needNand || (Number(book.partsLatch) || 0) < needLatch) {
      return { ok: false, reason: "买单已成交，但元件还没进本期合约（NAND / LATCH 余额不足）。" };
    }
    return { ok: true, reason: "确认后解锁 depositToPool 入池开矿。任何人可调，不需要 Owner 签名。" };
  }
  if (method.name === "depositToPool") {
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以 depositToPool。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "元件尚未到账，请先由 Owner 买入元件并确认成交到账。" };
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 可以 depositToPool 入池（不可逆操作）。" };
    if (book.askOpen || Number(book.nandAskQty) > 0 || Number(book.latchAskQty) > 0 || Number(book.marketOwed) > 0) {
      return { ok: false, reason: "卖单还没确认，不能入池。" };
    }
    return { ok: true, reason: "元件转入矿池，本期进入挖矿（不可逆）。" };
  }
  if (method.name === "openRefund") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 openRefund。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以批量退款。" };
    if (book.executePhase === "listed" || book.askOpen || Number(book.nandAskQty) > 0 || Number(book.latchAskQty) > 0) {
      return { ok: false, reason: "买单未确认，或卖单还没确认，不能退款。" };
    }
    if (book.executePhase === "ready" && book.readyExit === false) {
      return { ok: false, reason: "这期是旧合约。确认到账之后不能退款，也不能把元件单独转出，只能入池。" };
    }
    if (book.executePhase && book.executePhase !== "buying" && book.executePhase !== "ready") {
      return { ok: false, reason: "请先取消挂单，再 openRefund。" };
    }
    if (!(outstandingOf(book) > 0)) {
      return { ok: false, reason: "份额已全部退完（已售未退 = 0），没有可退对象，链上会以 ZeroShares 回滚。尾差请用 recoverBnb() 取回。" };
    }
    return { ok: true, reason: "将批量原路退回各认筹地址本金。" };
  }
  if (method.name === "abandonOrder") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 abandonOrder。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以放弃挂单并退款。" };
    return {
      ok: true,
      reason: "撤未成交买单、撤卖单、提取市场欠款、把元件退回 Owner，再按池子退款。挂单中也能用（openRefund 会回滚）。",
    };
  }
  if (method.name === "setPlan") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 setPlan。" };
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不可改计划。" };
    if (book.scene === "executing" && book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "挂单中或已到账时不可改 setPlan。" };
    }
    return { ok: true, reason: "写入本期预估算力（1 个参数）。元件数由募资总额决定，上链后不改。" };
  }
  if (method.name === "harvest") {
    return { ok: false, reason: "harvest 是占位实现（no-op）：不产出发放，前端不提供调用入口。" };
  }
  return { ok: false, reason: "未知函数。" };
}

export function readCall(method, args, round, book, quote = QUOTE) {
  if (/^market(OpenOrders|Bids|Asks|Owed)$/.test(method) || method.startsWith("simulateFill")) {
    return "仅链上模式可用：连接测试网钱包后读取 Mock 材料市场。";
  }
  if (method === "scene" || method === "status") return SCENE_COPY[book.scene].badge;
  if (method === "phase" || method === "executePhase") {
    return book.executePhase || "none";
  }
  if (method === "sold") return String(book.sold);
  if (method === "outstandingShares") return String(outstandingOf(book));
  if (method === "serviceFeeBps") {
    const bps = Number(round.serviceFeeBps ?? 0);
    return round.serviceFeeSet ? `${bps} bps（${bps / 100}%）` : "未设定";
  }
  if (method === "feeRecipientCount") {
    return `${(round.feeShares || []).length} 个收款地址`;
  }
  if (method === "revenuePool") {
    return `${Number(book.revenuePool || 0).toFixed(4)} BNB`;
  }
  if (method === "surplusOf") {
    const a = String(args.account || "").toLowerCase();
    if (a && String(book.selfAddress || "").toLowerCase() === a) {
      return `${Number(book.pendingSurplusSelf || 0).toFixed(4)} BNB`;
    }
    return "0 BNB（模拟模式只有当前钱包的余款）";
  }
  if (method === "sharePriceBnb") return `${round.sharePriceBnb} BNB`;
  if (method === "totalShares") return String(round.totalShares);
  if (method === "hashpower") {
    // 未执行时实际算力未知，只能给预估值
    return book.hashpower > 0
      ? `${book.hashpower.toLocaleString("zh-CN")} H`
      : `预估 ${estimateHashpower(round, quote, round.totalShares).hashpower.toLocaleString("zh-CN")} H（未执行，实际未知）`;
  }
  if (method === "estHashpower") return `${estimateHashpower(round, quote, round.totalShares).hashpower.toLocaleString("zh-CN")} H`;
  if (method === "totalRefunded") return `${Number(book.refundedTotal || 0).toFixed(4)} BNB`;
  if (method === "raisedBnb") return `${(book.bnbPool || 0).toFixed(4)} BNB`;
  if (method === "transistors") return book.transistors || "—";
  if (method === "market" || method === "materialMarket") return book.market || "—";
  /**
   * 工厂元件白名单读项（模拟模式）。
   *
   * 模拟模式下没有链上工厂，链上事实不可得 —— 这里如实说明，
   * 不用前端硬编码的处理器列表冒充白名单（那不是链上事实）。
   */
  if (method === "allowedPartsCount") return "仅链上模式可读（工厂元件白名单，部署时写入、不可增删）";
  if (method === "allowedPartsAt") return "仅链上模式可读";
  if (method === "isAllowedParts") return "仅链上模式可读";
  if (method === "executionFailed") return book.executionFailed ? "是（已判执行失败）" : "否";
  if (method === "soldOutAt") {
    return book.soldOutAt ? new Date(book.soldOutAt).toLocaleString("zh-CN") : "—";
  }
  if (method === "priceLock") {
    return Number(book.priceLock) > 0
      ? `${Number(book.priceLock).toFixed(4)} BNB（${book.transistorCount || 0} 颗）`
      : "未锁价";
  }
  if (method === "holderCount") return `${book.wallets ? Object.keys(book.wallets).length : 0} 个地址（模拟）`;
  const account = String(args.account || "").toLowerCase();
  const rows = buildHolders(book.sold, book.mine);
  const row = rows.find((item) => item.address.toLowerCase() === account);
  if (method === "sharesOf") {
    if (book._chain && account && String(book.selfAddress || "").toLowerCase() === account) {
      return `${book.mine || 0} 份`;
    }
    return row ? `${row.shares} 份` : "0 份";
  }
  if (method === "pendingSurplus") {
    if (book._chain && account && String(book.selfAddress || "").toLowerCase() === account) {
      return `${Number(book.pendingSurplusSelf || 0).toFixed(4)} BNB`;
    }
    return "仅当前钱包可查：连接钱包后查看自己可领取的余款。";
  }
  if (method === "totalPendingSurplus") {
    return `${Number(book.pendingSurplusTotal || 0).toFixed(4)} BNB`;
  }
  return "";
}
