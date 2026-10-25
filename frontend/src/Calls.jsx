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
          summary: "发布众筹挖矿。开期需 份额单价 / 总份数 / 募集天数 / 晶体管合约 四个参数。第三个参数是秒：前端把天数 × 86400 后传入。第四个参数是**晶体管合约（= 处理器）**：零地址会 revert（工厂不再有默认晶体管），必须从工厂白名单里选一个官方晶体管合约，否则 revert PartsNotAllowed。白名单是安全边界（防期次指向无访问控制的 MockERC1155），部署时写入、不可增删。",
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
          summary: "工厂晶体管白名单的条目数。白名单在**部署时写入、之后不可增删** —— 它是安全边界（防期次指向无访问控制的 MockERC1155），不是运营开关。开期表单的可选处理器由它生成。",
          fields: [],
        },
        {
          name: "allowedPartsAt",
          kind: "read",
          caller: "任何人",
          signature: "allowedPartsAt(uint256) view",
          summary: "白名单第 index 项的晶体管合约地址。主网应为官方两件套：TapeOut 0xCC42ba5D… / Behemoth 0xE2DfD802…（两者均有挖矿产出资格）。",
          fields: [["index", "索引", "0"]],
        },
        {
          name: "isAllowedParts",
          kind: "read",
          caller: "任何人",
          signature: "isAllowedParts(address) view",
          summary: "某晶体管合约是否在白名单内。createCampaign 传白名单外的地址会 revert PartsNotAllowed。",
          fields: [["parts", "晶体管合约地址", "0x"]],
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
        { name: "phase", kind: "read", caller: "任何人", signature: "phase() view", summary: "待执行子态：0 None / 1 待挂单 / 2 挂单中 / 3 已到账。页面上的子状态就是这四个值。", fields: [] },
        { name: "sold", kind: "read", caller: "任何人", signature: "sold() view", summary: "累计已售份数（历史事实，只增不减 —— 退款不会让它变小，所以 owner 的下单资格不受退款影响）。", fields: [] },
        { name: "outstandingShares", kind: "read", caller: "任何人", signature: "outstandingShares() view", summary: "已售未退份数（当前债务）。按比例退款的分母就是它。", fields: [] },
        { name: "serviceFeeBps", kind: "read", caller: "任何人", signature: "serviceFeeBps() view", summary: "本期挖矿产出服务费率（基点，1/10000）。0 = 不收。链上可读，不再是前端本地记录。认筹款不收服务费。", fields: [] },
        { name: "feeRecipientCount", kind: "read", caller: "任何人", signature: "feeRecipientCount() view", summary: "挖矿产出服务费分成地址数量。", fields: [] },
        { name: "revenuePool", kind: "read", caller: "任何人", signature: "revenuePool() view", summary: "累计挖矿净收益（已扣服务费）。真钱已并入持份人可领余款（claimSurplus），不是死池；owner 扫不走。", fields: [] },
        { name: "surplusOf", kind: "read", caller: "任何人", signature: "surplusOf(address) view", summary: "某地址当前可领取的募集款余款（含尚未计提的部分）。余款由 returnSurplus()（确认到账后提前退）或 depositToPool()（入池时自动记账）产生。", fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]] },
        { name: "sharePriceBnb", kind: "read", caller: "任何人", signature: "sharePriceBnb() view", summary: "每份价格（BNB）。", fields: [] },
        { name: "totalShares", kind: "read", caller: "任何人", signature: "totalShares() view", summary: "总份数。", fields: [] },
        { name: "estHashpower", kind: "read", caller: "任何人", signature: "estHashpower() view", summary: "预估算力（setPlan 写入；未进入挖矿时展示）。", fields: [] },
        { name: "totalRefunded", kind: "read", caller: "任何人", signature: "totalRefunded() view", summary: "累计退款本金（BNB）。不含 claimSurplus 领取的余款 —— 余款单独记账，不会抬高这个数。", fields: [] },
        { name: "pendingSurplus", kind: "read", caller: "任何人", signature: "pendingSurplus(address) view", summary: "某地址已计提但尚未转出的入池余款（BNB）。C-4 之后余款改 pull 模式：入池时不再遍历推款，只记分配基准（surplusPool / surplusBase），持份人自己调 claimSurplus() 领。地址拒收导致领取失败时金额原样保留可重试。", fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]] },
        { name: "totalPendingSurplus", kind: "read", caller: "任何人", signature: "totalPendingSurplus() view", summary: "全期待领取余款总额（BNB）。这部分钱不属于 Owner，recoverBnb 不会扫走。", fields: [] },
        { name: "raisedBnb", kind: "read", caller: "任何人", signature: "raisedBnb() view", summary: "合约代持的 BNB 托管池。", fields: [] },
        { name: "transistors", kind: "read", caller: "任何人", signature: "transistors() view", summary: "开期锁定的晶体管 ERC1155 合约（TapeOut / Behemoth 或测试网 Mock）。", fields: [] },
        { name: "materialMarket", kind: "read", caller: "任何人", signature: "materialMarket() view", summary: "晶体管市场地址。旧工厂造出来的期次（主网期次 #0、测试网期次）该 getter 名为 market()，读取时双名回退。", fields: [] },
        { name: "executionFailed", kind: "read", caller: "任何人", signature: "executionFailed() view", summary: "是否已判执行失败；为真时持有人可 refund。", fields: [] },
        { name: "soldOutAt", kind: "read", caller: "任何人", signature: "soldOutAt() view", summary: "售罄时刻；非 Owner 的 markFailed 要等到售罄满 3 天。", fields: [] },
        { name: "priceLock", kind: "read", caller: "任何人", signature: "priceLock() view", summary: "挂单锁定的晶体管总成本（BNB）与颗粒数。", fields: [] },
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
        { name: "refund", kind: "write", caller: "持份用户 / Owner", signature: "refund()", summary: "三种本金返还：① 募集超过截止时间仍未售罄；② 待执行阶段已判失败（本金尚未支出）；③ 待挂单且池子已不足以按原价兑付（按比例退）。份额清零。与挖矿中的份额转让无关。**已到账（晶体管已买回）一律拒绝**：那里晶体管已经是持份人的资产，按剩余 BNB 退等于白送晶体管。", fields: [] },
        { name: "claimSurplus", kind: "write", caller: "持份用户", signature: "claimSurplus()", summary: "领取你按份应得的募集款余款 + 挖矿净收益（pull 模式）。记账时点有三个：`returnSurplus()`（确认到账后提前退，本期继续）、`depositToPool()`（入池时自动记账）、`depositRevenue()`（矿池打款，扣完服务费的净额）。合约**不遍历持份人推款**（那会因 gas 上限卡死 owner），只记录分配基准（surplusPool / surplusBase），持份人自己调这个函数按份领取。同一笔钱只能领一次；老账本领完之后新到的钱会另开一轮，照样可领。地址拒收导致领取失败时整笔回滚，金额原样保留可重试。", fields: [] },
        { name: "claimFee", kind: "write", caller: "服务费收款方", signature: "claimFee()", summary: "服务费收款方领取自己那笔**挖矿产出**服务费（pull 模式）。矿池把挖矿收益打进来时按链上分成表计提，Owner 扫不走。与认筹款无关。", fields: [] },
        {
          name: "setServiceFee",
          kind: "write",
          caller: "Owner",
          signature: "setServiceFee(uint16 bps,address[] recipients,uint16[] sharesBps)",
          summary: "设定本期服务费率与多地址分成表。**只能在尚无人认购时调用**（sold == 0），一旦有人认购即永久锁定。费率硬上限 10%，分成份额合计必须等于 10000。费率为 0 时必须传空表（显式锁定「不收服务费」）。⚠️ 这是**挖矿产出奖励**的服务费（从 depositRevenue 的收益里计提），**认筹款不收服务费**。",
          fields: [
            ["bps", "费率（基点，1/10000）", "500"],
            ["recipients", "收款地址数组", '["0x..."]'],
            ["sharesBps", "各地址份额（基点，合计 10000）", "[10000]"],
          ],
        },
        { name: "markFailed", kind: "write", caller: "任何人（非 Owner 须售罄满 3 天）", signature: "markFailed()", summary: "把待执行期次标记为执行失败，从而为所有持有人打开 refund()。若买单还挂着，会先把未成交部分撤掉，托管退回募集池；撤单被市场拒绝时整笔回滚，可稍后重试。用于 Owner 失联时逃生；3 天宽限期防止单个持有人杀掉仍在买晶体管的健康期次。Owner 随时可调。**已到账期次拒绝**（`UseReturnSurplus`）：晶体管已经买回来了，不是失败态。", fields: [] },
        { name: "claim", kind: "write", caller: "用户", signature: "claim()", summary: "占位实现（no-op）：挖矿中调用只返回 0，不产出发放；分配合约接入后才会恢复领取。", fields: [] },
        {
          name: "depositToPool",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "depositToPool()",
          summary: "晶体管到账并确认后，Owner 调一次即可把晶体管投入矿池，本期进入挖矿（不可逆）。之前需先 setPlan 写入预估算力与晶体管数。会先把没花完的募集款（含卖出款）按份记账给持份人（各自 claimSurplus 领），再把当前持有的全部晶体管转进矿池；部分卖出后入池剩余部分是合法出口。",
          fields: [],
        },
        {
          name: "confirmTransistors",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "confirmTransistors()",
          summary: "读取官方晶体管市场 bids(id).remaining。两腿都成交且晶体管已到账才进入待入池。未成交会回退，不能靠网页手工确认。任何人可调。",
          fields: [],
        },
        {
          name: "placeTransistorOrder",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "placeTransistorOrder(uint256 nandQty, uint96 nandPrice, uint256 latchQty, uint96 latchPrice)",
          summary: "调用晶体管市场 placeBid。NAND tokenId 0、LATCH tokenId 1，保证金从募集款托管。晶体管合约在开期已锁定，不是参数。仅待挂单（Buying）可调；一次只能有一张挂单（先撤单）。买不起则标 executionFailed 且不挂单，不 revert。",
          fields: [
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
          summary: "只撤未成交部分，保证金按剩余量退回本期并回到待挂单。已成交的晶体管上链即不可撤，会留在本期合约。全部成交且晶体管已到账时不能取消。",
          fields: [],
        },
        {
          name: "sellTransistors",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "sellTransistors(uint256 bidId, uint8 tokenId, uint256 quantity)",
          summary: "官方晶体管市场只有买单侧，卖出 = 吃一张已挂买单。把本期合约持有的 NAND（tokenId 0）/ LATCH（tokenId 1）按该买单单价卖给它，成交款立即从市场提回本期。仅确认到账（Ready）后可调；买单标的必须是本期晶体管、剩余量足够、买家不是本期自己，且单价不得低于本期买入成本（否则会烧掉持份人的抵押）。",
          fields: [
            ["bidId", "要吃的买单 ID", "1"],
            ["tokenId", "0 = NAND，1 = LATCH", "0"],
            ["quantity", "卖出数量（颗）", "1"],
          ],
        },
        {
          name: "setPhase",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "setPhase(uint8)",
          summary: "待执行时改子状态。不搬运代币，也不撤市场上的单。1 待挂单，2 挂单中（必须有活单），3 已到账（必须 priceLock≠0 且买单全成交）；0 会被拒绝（它会让挂单和所有退款路径同时关闭）。挂单中不能改，先取消或放弃。Ready 之后唯一正常出口是 returnSurplus（退余款）+ depositToPool（晶体管进矿池）；要结束本期必须显式改回 1（管理员逃生），之后 openRefund 才会把晶体管退回 Owner。",
          fields: [["next", "子状态 1–3", "1"]],
        },
        {
          name: "withdrawMarketProceeds",
          kind: "write",
          caller: "任何人",
          signature: "withdrawMarketProceeds()",
          summary: "把晶体管市场 owed 里的卖出款提到本期 raisedBnb。",
          fields: [],
        },
        {
          name: "returnSurplus",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "returnSurplus()",
          summary: "晶体管确认到账后，把没花完的募集款按份记账退回持份人（各自 claimSurplus 领取）。不结束本期：晶体管留在合约、份额不变，之后仍然可以 depositToPool。要求市场没有欠款。Owner 随时可调；其他钱包须在售罄 / 最后一次下单满 3 天后 —— 这是 Owner 失联时把余款交回持份人的兜底。调用后 openRefund / abandonOrder 关闭（本金已经退过，晶体管只能走挖矿或卖入买单）。",
          fields: [],
        },
        {
          name: "topUpShortfall",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "topUpShortfall() payable",
          summary: "自掏腰包补齐「已被晶体管吃掉」的本金缺口，让募集池重新按原价覆盖全部未退份额。买了晶体管之后想收摊必须先走这一步：不补齐的话 openRefund / abandonOrder 会以 PartsAreCollateral 回滚（份额一旦清零，晶体管既没人能领、Owner 也拿不走）。补齐 → 按原价退完 → 晶体管才可由 recoverTransistors 取回；多补的钱在份额清零后用 recoverBnb() 扫回。",
          fields: [["value", "补齐金额", "0"]],
        },
        {
          name: "openRefund",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "openRefund()",
          summary: "只在待挂单（buying）时批量原路退款。晶体管确认到账（ready）后不可用：那个状态只能 returnSurplus 退余款、晶体管进矿池，不能转给 Owner（链上 UseReturnSurplus 回滚；确要结束本期得先 setPhase 改回 buying）。合约手上还有晶体管、而池子不足以按原价退完时以 PartsAreCollateral 回滚（先 topUpShortfall）。份额已全部退完时没有可退对象，会以 ZeroShares 回滚，用 recoverBnb() 扫尾差。退过余款之后会以 SurplusAlreadyReturned 回滚。",
          fields: [],
        },
        {
          name: "abandonOrder",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "abandonOrder()",
          summary: "待执行 buying / listed 时放弃本期：撤未成交买单、提取市场欠款、按池子批量退款，最后才把剩余晶体管退回 Owner（要求份额全清且持份人已按原价收回本金）。用来解开卡住的单（openRefund 在挂单中会回滚）。晶体管确认到账（ready）后不可用（UseReturnSurplus）。合约手上还有晶体管、池子又不足时以 PartsAreCollateral 回滚：先 topUpShortfall 补齐。",
          fields: [],
        },
        {
          name: "setPlan",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "setPlan(uint256)",
          summary: "写入预估算力。仅 funding 或 executing+buying。晶体管数不是参数，由实际下单数量决定。",
          fields: [
            ["hashpower", "预估算力", "0"],
          ],
        },
        {
          name: "setMiningPool",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "setMiningPool(address)",
          summary: "设定本期投入的矿池地址（depositToPool 时晶体管转入此处）。",
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
          summary: "更换本期晶体管市场。挂单、撤单都打到这个合约。挂单中拒绝；旧市场还欠本期卖出款时会先尽力提回托管池（旧市场付不出来也放行，不会把本期一起锁死）。",
          fields: [["materialMarket", "晶体管市场地址", ""]],
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
          summary: "把本期持有的晶体管转给 Owner。挂单中不可转。已到账可以取，子状态不变：取出后晶体管不再锁在合约里，入池前需重新确认晶体管在手。NAND 的 id 为 0，LATCH 为 1。",
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
      name: "晶体管市场（Mock 调试）",
      address: book.market || "由本期合约 materialMarket() 读取（旧期次为 market()）",
      methods: [
        {
          name: "marketOpenOrders",
          kind: "read",
          caller: "任何人",
          signature: "nextBidId() / bids(id)",
          summary: "列出晶体管市场所有未成交的买单（含单价、剩余、买家）。官方市场只有买单簿，卖出就是吃其中一张。",
          fields: [],
        },
        {
          name: "marketBids",
          kind: "read",
          caller: "任何人",
          signature: "bids(uint256) view",
          summary: "单张买单详情：买家、晶体管合约、单价、tokenId、剩余数量。",
          fields: [["id", "买单 ID", "1"]],
        },
        {
          name: "marketSellable",
          kind: "read",
          caller: "任何人",
          signature: "nextBidId() / bids(id)（筛本期晶体管）",
          summary: "列出本期能吃的外部买单：标的是本期晶体管、还有剩余量、买家不是本期自己，按单价从高到低。卖之前先看这张表。",
          fields: [],
        },
        {
          name: "marketOwed",
          kind: "read",
          caller: "任何人",
          signature: "owed(address) view",
          summary: "市场欠某地址的卖出款。地址留空时读本期合约；sellTransistors 会立刻提走，无需手工提取。",
          fields: [["account", "地址（留空 = 本期合约）", ""]],
        },
        {
          name: "simulateFillBid",
          kind: "write",
          caller: "任意调试钱包",
          signature: "bids(id) → fillBid(id, quantity) → MockERC1155.mint(buyer)",
          summary: "模拟卖方成交：扣减市场剩余，并把同数量晶体管铸给买单买家（本期合约）。两条腿都成交后即可「确认到账」。",
          fields: [["id", "买单 ID", "1"], ["quantity", "成交数量（留空 = 全部剩余）", ""]],
        },
        {
          name: "simulateFillCampaignBids",
          kind: "write",
          caller: "任意调试钱包",
          signature: "nandBidId() / latchBidId() → fillBid + mint",
          summary: "一键撮合本期两张买单并补齐晶体管。成功后点「确认到账」，接着就能卖入外部买单或 depositToPool 入池。",
          fields: [],
        },
        {
          name: "simulateExternalBid",
          kind: "write",
          caller: "任意调试钱包",
          signature: "placeBid(transistors, tokenId, price, quantity) payable",
          summary: "模拟外部买家挂一张买单：用当前钱包托管 BNB，标的是本期晶体管。挂好之后 Owner 就能用 sellTransistors 吃它。",
          fields: [
            ["tokenId", "0 = NAND，1 = LATCH", "0"],
            ["price", "单价 BNB（最多 5 位小数）", "0.05600"],
            ["quantity", "数量（颗）", "1"],
          ],
        },
      ],
    },
    {
      id: "upstream",
      name: "上游合约",
      address: "由本期合约调用",
      methods: [
        {
          name: "placeBid / fillBid",
          kind: "internal",
          caller: "仅本期合约",
          signature: "placeBid / cancelBid / fillBid / withdraw",
          summary: "官方晶体管市场只有买单侧：本期挂买单买晶体管，或吃别人的买单卖出。",
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
  // 晶体管挂单价按五位小数限制输入，避免用户填的 0.00456 被静默截成 0.0045
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
  if (method.name.startsWith("simulateFill") || method.name === "simulateExternalBid") {
    if (!connected) return { ok: false, reason: "模拟撮合需要连接钱包（任意测试网钱包都可以）。" };
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不再有晶体管挂单可撮合。" };
    if (method.name === "simulateFillCampaignBids" && book.orderFilled) {
      return { ok: false, reason: "本期买单已全部成交，直接「确认到账」即可。" };
    }
    if (method.name === "simulateExternalBid") {
      return { ok: true, reason: "会以当前钱包在 Mock 市场挂一张本期晶体管的买单，托管价 × 数量。" };
    }
    return { ok: true, reason: "测试网 Mock 撮合：会真实发交易；买单成交时额外 mint 测试晶体管给买家。" };
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
      return { ok: false, reason: "这期是旧合约。确认到账后晶体管取不出，官网也用不了它，入池和退出都走不通。" };
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
    // 余款已经提前按份退回（returnSurplus）：池子是 0，这时退款只会把份额清零、白送挖矿权益。
    if (book.scene === "executing" && Number(book.surplusBase) > 0) {
      return { ok: false, reason: "本期余款已按份退回，本金已经回到你手里。此时退款会以 0 BNB 清掉份额（链上 SurplusAlreadyReturned 回滚）；份额请留着等入池。" };
    }
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
    if (pending <= 0) return { ok: false, reason: "当前钱包没有待领取的余款：没花完的募集款还没记账（returnSurplus / depositToPool 二者都未发生）。" };
    return { ok: true, reason: `领取 ${pending.toFixed(4)} BNB：按份应得、还没转到你地址的募集款余款。` };
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
  if (method.name === "sellTransistors") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能把本期晶体管卖出去。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态才有晶体管可卖。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "要先确认买单到账（Ready），才能吃外部买单卖出。" };
    if (book.readyExit === false) return { ok: false, reason: "这期是旧合约，链上没有 sellTransistors。" };
    if (!(Number(book.partsNand) > 0 || Number(book.partsLatch) > 0)) {
      return { ok: false, reason: "本期合约手上没有晶体管余额，没有可卖的东西。" };
    }
    if (!(book.sellBids || []).length) {
      return { ok: false, reason: "市场里没有标的是本期晶体管的外部买单。等有人挂买单，或直接把晶体管投进矿池。" };
    }
    return { ok: true, reason: "按所选买单的单价成交，成交款立即提回本期。单价低于本期买入成本的买单会被合约拒绝。" };
  }
  if (method.name === "placeTransistorOrder") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能挂单。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要挂单买晶体管。" };
    // 合约只允许 Buying：Listed / Ready / None 都会 revert WrongScene。
    if (book.executePhase !== "buying") {
      return { ok: false, reason: "只有待挂单（Buying）可挂买单；挂单中请先成交或撤单，已到账请直接入池。" };
    }
    return { ok: true, reason: "填写数量与单价后锁价；进入「挂单中」可取消未成交部分或确认到账。" };
  }
  if (method.name === "cancelTransistorOrder") {
    // 与合约一致：orderFilled && _partsOnHand 时 revert OrderFilled，成交部分上链即不可撤。
    const nothingOpen = [book.nandRemaining, book.latchRemaining]
      .every((remaining) => remaining != null && Number(remaining) === 0);
    if (book.orderFilled && nothingOpen) {
      return { ok: false, reason: "已全部成交，晶体管已上链，不能取消。请点「确认到账」后入池。" };
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
    return { ok: true, reason: "只撤未成交部分；已成交的晶体管会留在本期合约，随后需确认到账或按比例退款。" };
  }
  if (method.name === "withdrawMarketProceeds") {
    if (!connected) return { ok: false, reason: "需要连接钱包（虽然任何人可调）。" };
    if (!(Number(book.marketOwed) > 0)) {
      return { ok: false, reason: "晶体管市场当前没有欠本期合约的款，调用是 no-op。" };
    }
    return { ok: true, reason: "把晶体管市场 owed 里的钱转进本期 raisedBnb，供退款或入池余量计算。" };
  }
  if (method.name === "setPhase") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可改子状态。" };
    if (book.scene === "mining" || book.scene === "funding") return { ok: false, reason: "只有待执行可以改子状态。" };
    if (book.executePhase === "listed") return { ok: false, reason: "挂单还在市场上。先取消或放弃挂单，再改子状态，否则托管款会留在市场。" };
    if (book.readyExit === false) return { ok: false, reason: "这期是旧合约，链上没有改子状态的入口。" };
    return { ok: true, reason: "只改 phase。改成 1（待挂单）后可以取回晶体管，再退款。" };
  }
  if (method.name === "confirmTransistors") {
    // 合约里 confirmTransistors() 是 external，任何人可调；前端只做状态校验。
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要确认到账。" };
    if (book.executePhase === "ready") return { ok: false, reason: "晶体管已确认到账，直接 depositToPool 入池，或 sellTransistors 卖入买单。" };
    if (book.executePhase !== "listed") return { ok: false, reason: "请先挂单，再确认成交到账。" };
    if (!book.orderFilled) return { ok: false, reason: "买单还没全部成交（bids.remaining > 0）。" };
    // 合约还要求本期合约真的持有晶体管；只成交不发货会以 TransistorsNotReady 回滚。
    const needNand = Number(book.nandQty) || 0;
    const needLatch = Number(book.latchQty) || 0;
    if ((Number(book.partsNand) || 0) < needNand || (Number(book.partsLatch) || 0) < needLatch) {
      return { ok: false, reason: "买单已成交，但晶体管还没进本期合约（NAND / LATCH 余额不足）。" };
    }
    return { ok: true, reason: "确认后解锁 depositToPool 入池开矿，或 sellTransistors 卖入外部买单。任何人可调，不需要 Owner 签名。" };
  }
  if (method.name === "depositToPool") {
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以 depositToPool。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "晶体管尚未到账，请先由 Owner 买入晶体管并确认成交到账。" };
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 可以 depositToPool 入池（不可逆操作）。" };
    if (Number(book.marketOwed) > 0) {
      return { ok: false, reason: "晶体管市场还有卖出款没提回本期，先 withdrawMarketProceeds 再入池。" };
    }
    if (book.surplusExit && Number(book.bnbPool) > 0 && !(Number(book.surplusBase) > 0)) {
      return { ok: false, reason: "入池前必须先把剩余募集款按份退回给持份人（returnSurplus）；否则持份人拿不到本金，只能看着晶体管进矿池。" };
    }
    return { ok: true, reason: "晶体管转入矿池，本期进入挖矿（不可逆）。没花完的募集款在入池前/入池时按份退回给持份人，晶体管不会转给 Owner。" };
  }
  if (method.name === "returnSurplus") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 returnSurplus。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以退余款。" };
    if (book.executePhase !== "ready") {
      return { ok: false, reason: "晶体管还没确认到账，合约会以 TransistorsNotReady 回滚。" };
    }
    if (book.surplusExit === false && book._chain) {
      return { ok: false, reason: "这期是旧合约，链上没有 returnSurplus。重新部署工厂后新开的期才有。" };
    }
    if (Number(book.bnbPool) <= 0) return { ok: false, reason: "募集款已全部用于买晶体管，没有可退的余款（ZeroShares）。" };
    if (Number(book.marketOwed) > 0) return { ok: false, reason: "晶体管市场还有欠款没提取，先 withdrawMarketProceeds。" };
    if (!(outstandingOf(book) > 0)) return { ok: false, reason: "份额已全部退完，没有可退对象。" };
    return {
      ok: true,
      reason: "按份退回没花完的募集款：份额不变、晶体管留在合约、phase 仍是 Ready，之后照样能 depositToPool。持份人各自 claimSurplus 领。",
    };
  }
  if (method.name === "openRefund") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 openRefund。" };
    if (Number(book.surplusBase) > 0) {
      return { ok: false, reason: "已经用 returnSurplus 退过余款；本金已退回，再退款会把份额清零、把晶体管交给 Owner，链上以 SurplusAlreadyReturned 回滚。之后只能 depositToPool。" };
    }
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以批量退款。" };
    if (book.executePhase === "ready" && book.surplusExit !== false) {
      return { ok: false, reason: "晶体管已到账，这个状态不能原路退款（链上 UseReturnSurplus 回滚）：退款只会把剩余募集款按份退给持份人，晶体管必须进矿池、不能转给 Owner。用 returnSurplus()；确实要结束本期得先把子状态改回 buying（setPhase）。" };
    }
    if (book.executePhase === "listed") {
      return { ok: false, reason: "买单未确认，不能退款。" };
    }
    if (book.executePhase === "ready" && book.readyExit === false) {
      return { ok: false, reason: "这期是旧合约。确认到账之后不能退款，也不能把晶体管单独转出，只能入池。" };
    }
    if (book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "请先取消挂单，再 openRefund。" };
    }
    if (!(outstandingOf(book) > 0)) {
      return { ok: false, reason: "份额已全部退完（已售未退 = 0），没有可退对象，链上会以 ZeroShares 回滚。尾差请用 recoverBnb() 取回。" };
    }
    return { ok: true, reason: "将批量原路退回各认筹地址本金。若本期已买过晶体管、募集池又不足以按原价退完，链上会以 PartsAreCollateral 拒绝：先 topUpShortfall 补齐。" };
  }
  if (method.name === "topUpShortfall") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能补齐缺口。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以补齐（入池后份额与晶体管都已经定局）。" };
    const need = outstandingOf(book) * Number(round.sharePriceBnb || 0) - Number(book.bnbPool || 0);
    const hint = need > 0 ? `按当前份额与池子，缺口约 ${need.toFixed(6)} BNB。` : "当前池子已能按原价覆盖全部份额，无需补齐（补齐的钱之后可用 recoverBnb 扫回）。";
    return {
      ok: true,
      reason: `${hint}补齐后被晶体管吃掉的本金就回到池子里：持份人能按原价退完，Owner 才取得走晶体管。多补的部分在份额清零后用 recoverBnb 扫回。`,
    };
  }
  if (method.name === "abandonOrder") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 abandonOrder。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以放弃挂单并退款。" };
    if (book.executePhase === "ready" && book.surplusExit !== false) {
      return { ok: false, reason: "晶体管已到账，abandonOrder 会把晶体管退回 Owner，链上以 UseReturnSurplus 回滚。这个状态只能 returnSurplus（退余款）+ depositToPool（晶体管进矿池）。" };
    }
    return {
      ok: true,
      reason: "撤未成交买单、提取市场欠款、按池子退款，最后才把剩余晶体管退回 Owner。若本期已买过晶体管、池子又不足以按原价退完，链上会以 PartsAreCollateral 拒绝：先 topUpShortfall 补齐。",
    };
  }
  if (method.name === "setPlan") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 setPlan。" };
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不可改计划。" };
    if (book.scene === "executing" && book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "挂单中或已到账时不可改 setPlan。" };
    }
    return { ok: true, reason: "写入本期预估算力（1 个参数）。晶体管数由募资总额决定，上链后不改。" };
  }
  if (method.name === "harvest") {
    return { ok: false, reason: "harvest 是占位实现（no-op）：不产出发放，前端不提供调用入口。" };
  }
  return { ok: false, reason: "未知函数。" };
}

export function readCall(method, args, round, book, quote = QUOTE) {
  if (/^market(OpenOrders|Bids|Sellable|Owed)$/.test(method) || method.startsWith("simulateFill") || method === "simulateExternalBid") {
    return "仅链上模式可用：连接测试网钱包后读取 Mock 晶体管市场。";
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
   * 工厂晶体管白名单读项（模拟模式）。
   *
   * 模拟模式下没有链上工厂，链上事实不可得 —— 这里如实说明，
   * 不用前端硬编码的处理器列表冒充白名单（那不是链上事实）。
   */
  if (method === "allowedPartsCount") return "仅链上模式可读（工厂晶体管白名单，部署时写入、不可增删）";
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
