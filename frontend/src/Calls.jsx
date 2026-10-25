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
import { FACTORY_ADDRESS, CAMPAIGN_ADDRESS, CHAIN_ID } from "./chain/config.js";
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
  // 链上挂单 ID 是数字，默认填第一张未成交挂单；没有挂单时给 0，由 gate 提示「挂单不存在」。
  const openListing = (book.listings || []).find((l) => l.open) || null;
  const listingIdHint = openListing ? String(openListing.id) : "0";
  return [
    {
      id: "factory",
      name: "CampaignFactory",
      address: factoryAddr,
      methods: [
        {
          name: "createCampaign",
          kind: "write",
          caller: "Owner",
          signature: "createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint64 fundingSeconds,address circuits) returns (address)",
          summary: "开一期众筹。四个参数：每份 BNB、总份数、募集天数、本期电路合约（必须来自工厂白名单）。",
          fields: [
            ["sharePriceBnb", "每份 BNB", round.sharePriceBnb],
            ["totalShares", "总份数", round.totalShares],
            ["fundingSeconds", "募集秒数", Number(round.fundingDays || 0) * 86400],
          ],
        },
        {
          name: "removeCampaign",
          kind: "write",
          caller: "Owner",
          signature: "removeCampaign(address campaign) → 遍历 campaigns[] → removeCampaign(uint256)",
          summary: "按地址把一期从工厂列表移除。链上合约仍在，只是不再列出。",
          fields: [["campaign", "期次地址", campaignAddr || "0x"]],
        },
        {
          name: "removeCampaignAt",
          kind: "write",
          caller: "Owner",
          signature: "removeCampaign(uint256 index)",
          summary: "按数组索引移除一期，等价于按地址移除。",
          fields: [["index", "索引", "0"]],
        },
        {
          name: "allowedCircuitsCount",
          kind: "read",
          caller: "任何人",
          signature: "allowedCircuitsCount() view",
          summary: "白名单条数。白名单部署时写入，之后不可增删；开期时只能从这里选。",
          fields: [],
        },
        {
          name: "allowedCircuitsAt",
          kind: "read",
          caller: "任何人",
          signature: "allowedCircuitsAt(uint256) view",
          summary: "白名单第 index 项的电路合约地址（主网为 TapeOut / Behemoth）。",
          fields: [["index", "索引", "0"]],
        },
        {
          name: "isAllowedParts",
          kind: "read",
          caller: "任何人",
          signature: "isAllowedParts(address) view",
          summary: "该电路合约是否在名单内。不在名单里不能开期。",
          fields: [["parts", "电路合约地址", "0x"]],
        },
        {
          name: "setFactoryOwner",
          kind: "write",
          caller: "Owner",
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
        { name: "phase", kind: "read", caller: "任何人", signature: "phase() view", summary: "待执行子状态：1 待挂单 / 2 挂单中 / 3 已到账。", fields: [] },
        { name: "sold", kind: "read", caller: "任何人", signature: "sold() view", summary: "累计售出份数。只增不减，退款不会让它变小。", fields: [] },
        { name: "outstandingShares", kind: "read", caller: "任何人", signature: "outstandingShares() view", summary: "已售未退份数，也就是当前还欠持份人的份数。", fields: [] },
        { name: "serviceFeeBps", kind: "read", caller: "任何人", signature: "serviceFeeBps() view", summary: "挖矿产出服务费率（基点，10000 = 100%）。认筹款不收服务费。", fields: [] },
        { name: "feeRecipientCount", kind: "read", caller: "任何人", signature: "feeRecipientCount() view", summary: "服务费分成地址数量。", fields: [] },
        { name: "revenuePool", kind: "read", caller: "任何人", signature: "revenuePool() view", summary: "累计挖矿净收益（已扣服务费），按份分给持份人，Owner 扫不走。", fields: [] },
        { name: "surplusOf", kind: "read", caller: "任何人", signature: "surplusOf(address) view", summary: "该地址可领的募集款余款（含还没计提的部分）。", fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]] },
        { name: "sharePriceBnb", kind: "read", caller: "任何人", signature: "sharePriceBnb() view", summary: "每份价格（BNB）。", fields: [] },
        { name: "totalShares", kind: "read", caller: "任何人", signature: "totalShares() view", summary: "总份数。", fields: [] },
        { name: "estHashpower", kind: "read", caller: "任何人", signature: "estHashpower() view", summary: "预估算力（setPlan 写入；未进入挖矿时展示）。", fields: [] },
        { name: "totalRefunded", kind: "read", caller: "任何人", signature: "totalRefunded() view", summary: "累计已退本金（BNB），不含领取的余款。", fields: [] },
        { name: "pendingSurplus", kind: "read", caller: "任何人", signature: "pendingSurplus(address) view", summary: "该地址已记账、还没领的余款（BNB）。持份人自己调 claimSurplus 领取。", fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]] },
        { name: "totalPendingSurplus", kind: "read", caller: "任何人", signature: "totalPendingSurplus() view", summary: "全期待领余款总额，这部分不属于 Owner。", fields: [] },
        { name: "raisedBnb", kind: "read", caller: "任何人", signature: "raisedBnb() view", summary: "合约托管中的 BNB（募集款 + 卖出款 − 已支出）。", fields: [] },
        { name: "circuits", kind: "read", caller: "任何人", signature: "circuits() view", summary: "开期锁定的 ERC721 电路集合。每张电路是该集合里的一个 tokenId。", fields: [] },
        { name: "circuitMarket", kind: "read", caller: "任何人", signature: "circuitMarket() view", summary: "本期使用的官方电路市场地址（只有卖单侧）。", fields: [] },
        { name: "circuitCount", kind: "read", caller: "任何人", signature: "circuitCount() view", summary: "累计买入的电路张数（历史事实，卖出后不变）。", fields: [] },
        { name: "circuitHeldCount", kind: "read", caller: "任何人", signature: "circuitHeldCount() view", summary: "本期合约当前持有的电路张数。卖出后下降。", fields: [] },
        { name: "executionFailed", kind: "read", caller: "任何人", signature: "executionFailed() view", summary: "是否已判执行失败；为真时持份人可退款。", fields: [] },
        { name: "halted", kind: "read", caller: "任何人", signature: "halted() view", summary: "熔断中：认筹、挂单、卖出、开矿、份额交易全停；退款、领款、撤单不受影响。", fields: [] },
        { name: "miningStatus", kind: "read", caller: "任何人", signature: "miningStatus(uint256) view", summary: "某张电路的官方 PoD 状态：0 未开矿 / 1 挖矿中 / 2 已撤销 / 3 冷却中。", fields: [["tokenId", "电路 tokenId", "0"]] },
        { name: "bemPendingOf", kind: "read", caller: "任何人", signature: "bemPendingOf(address) view", summary: "该地址现在可领的 BEM（含还没结算进 pendingBem 的部分）。", fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]] },
        { name: "soldOutAt", kind: "read", caller: "任何人", signature: "soldOutAt() view", summary: "售罄时间。非 Owner 判失败须等售罄满 3 天。", fields: [] },
        { name: "priceLock", kind: "read", caller: "任何人", signature: "priceLock() view", summary: "累计采购成本（BNB，所有已买入电路的成本之和）。", fields: [] },
        { name: "holderCount", kind: "read", caller: "任何人", signature: "holderCount() view", summary: "持份地址数量。", fields: [] },
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
          summary: "按份认筹，支付「份数 × 每份单价」。只在募集中且不超剩余份数时成功。",
          fields: [["shares", "份数", "1"]],
        },
        { name: "listShares", kind: "write", caller: "持份用户 / Owner", signature: "listShares(uint256,uint256)", summary: "发布份额出售挂单：份数与每份 BNB。挂出即锁定份额，成交或撤单后释放。", fields: [["shares", "份数", "3"], ["priceBnbPerShare", "每份 BNB", round.sharePriceBnb.toFixed(4)]] },
        { name: "cancelListing", kind: "write", caller: "挂单方 / Owner", signature: "cancelListing(uint256)", summary: "撤销自己发布的挂单，释放锁定份额回到可用余额。", fields: [["listingId", "挂单 ID", listingIdHint]] },
        { name: "takeListing", kind: "write", caller: "任一持份用户", signature: "takeListing(uint256,uint256)", summary: "按挂单价买入份额，BNB 当场付给卖方。不能买自己的挂单。", fields: [["listingId", "挂单 ID", listingIdHint], ["shares", "份数", "1"]] },
        { name: "refund", kind: "write", caller: "持份用户 / Owner", signature: "refund()", summary: "退回本金并清零份额。只有募集超时、已判失败、或池子不足以按原价兑付时可用；电路已到账则不可退，只能退余款。", fields: [] },
        { name: "claimSurplus", kind: "write", caller: "持份用户", signature: "claimSurplus()", summary: "领取你按份应得的余款与挖矿收益。钱已记账，随时可领，同一笔只能领一次。", fields: [] },
        { name: "claimFee", kind: "write", caller: "服务费收款方", signature: "claimFee()", summary: "服务费收款方领取属于自己那部分挖矿产出服务费。与认筹款无关。", fields: [] },
        {
          name: "setServiceFee",
          kind: "write",
          caller: "Owner",
          signature: "setServiceFee(uint16 bps,address[] recipients,uint16[] sharesBps)",
          summary: "设定挖矿产出服务费率与分成表。只能在无人认购时调一次，之后永久锁定；费率上限 10%，分成合计 10000。",
          fields: [
            ["bps", "费率（基点，1/10000）", "500"],
            ["recipients", "收款地址数组", '["0x..."]'],
            ["sharesBps", "各地址份额（基点，合计 10000）", "[10000]"],
          ],
        },
        { name: "markFailed", kind: "write", caller: "Owner 随时；其他人须售罄满 3 天", signature: "markFailed()", summary: "把本期判为执行失败，为所有持份人打开退款。Owner 随时可调，其他人须售罄满 3 天；电路已到账则不可用。", fields: [] },
        { name: "claimBem", kind: "write", caller: "持份用户", signature: "claimBem()", summary: "领取你按份额应得的 BEM（官方挖矿产出）。同一笔只能领一次。", fields: [] },
        { name: "claimMiningRewards", kind: "write", caller: "任何人", signature: "claimMiningRewards()", summary: "把官方挖矿合约里的奖励领回本期合约，再按份额记账给持份人（BEM 不会进调用者口袋）。", fields: [] },
        {
          name: "startMining",
          kind: "write",
          caller: "仅 Owner",
          signature: "startMining(uint256 tokenId,uint32 taskId,uint256 anchorBlock,bytes[] inputs,bytes[] expectedOuts,bytes32[][] proofs)",
          summary: "用官方 PoD 挖矿合约开启某张电路的挖矿。taskId = 0 是未验证池（一次调用即可）；已验证池要先 armMining 再在后面的块传 anchor 与抽样向量。",
          fields: [
            ["tokenId", "电路 tokenId", "0"],
            ["taskId", "官方任务 ID（0 = 未验证池）", "0"],
          ],
        },
        {
          name: "armMining",
          kind: "write",
          caller: "仅 Owner",
          signature: "armMining(uint256 tokenId)",
          summary: "为已验证池预约：记录当前块作为抽样锚点。必须在 startMining 之前的块调用。",
          fields: [["tokenId", "电路 tokenId", "0"]],
        },
        {
          name: "stopMining",
          kind: "write",
          caller: "仅 Owner",
          signature: "stopMining(uint256 tokenId)",
          summary: "停止某张电路的挖矿，产出当场结算并按份额记账。NFT 仍留在本期，冷静期后可重新开矿。",
          fields: [["tokenId", "电路 tokenId", "0"]],
        },
        {
          name: "confirmCircuits",
          kind: "write",
          caller: "任何人",
          signature: "confirmCircuits()",
          summary: "确认本期已持有电路并进入 Ready。要求 circuitHeldCount > 0；之后才能挂回市场或开矿。",
          fields: [],
        },
        {
          name: "buyCircuits",
          kind: "write",
          caller: "仅 Owner",
          signature: "buyCircuits(uint256[] listingIds,uint256[] tokenIds,uint96[] prices)",
          summary: "按市场卖单原子买入电路：采购款直接从募集余额扣，ERC721 成交即到本期合约。一次最多买到 100 张。",
          fields: [
            ["listingIds", "市场挂单 ID 数组", "[1]"],
            ["tokenIds", "电路 tokenId 数组", "[0]"],
            ["prices", "每张的成交价（wei）", "[0]"],
          ],
        },
        {
          name: "listCircuit",
          kind: "write",
          caller: "Owner",
          signature: "listCircuit(uint256 tokenId,uint96 price)",
          summary: "把手里的一张电路挂回市场卖出。只做单张 ERC721 授权（不 setApprovalForAll），挂单价不得低于该张买入成本。",
          fields: [
            ["tokenId", "电路 tokenId", "0"],
            ["priceBnb", "挂单价 BNB（最多 5 位小数）", "0.05610"],
          ],
        },
        {
          name: "cancelCircuitListing",
          kind: "write",
          caller: "Owner / 已移除期次任何人",
          signature: "cancelCircuitListing(uint256 tokenId)",
          summary: "撤销某张电路的挂单。开矿前必须把所有挂单撤掉。",
          fields: [["tokenId", "电路 tokenId", "0"]],
        },
        {
          name: "setPhase",
          kind: "write",
          caller: "仅 Owner",
          signature: "setPhase(uint8)",
          summary: "改子状态：1 待挂单 / 2 挂单中 / 3 已到账。不搬资产。要退款结束本期，须先改回 1。",
          fields: [["next", "子状态 1–3", "1"]],
        },
        {
          name: "withdrawMarketProceeds",
          kind: "write",
          caller: "任何人",
          signature: "withdrawMarketProceeds()",
          summary: "把市场欠本期的卖出款提回募集池。",
          fields: [],
        },
        {
          name: "returnSurplus",
          kind: "write",
          caller: "Owner（其他人须满 3 天）",
          signature: "returnSurplus()",
          summary: "把没花完的募集款按份退回持份人（各自领取）。不结束本期，之后仍可开矿。要求市场不欠款。",
          fields: [],
        },
        {
          name: "topUpShortfall",
          kind: "write",
          caller: "Owner",
          signature: "topUpShortfall() payable",
          summary: "自掏腰包补齐本金缺口，让池子重新够按原价退完所有份额。不补齐就不能退款收摊。",
          fields: [["value", "补齐金额", "0"]],
        },
        {
          name: "openRefund",
          kind: "write",
          caller: "Owner",
          signature: "openRefund()",
          summary: "打开退款：本期判为执行失败，持份人各自领回本金。只在待挂单可用；电路已到账请改用 returnSurplus。",
          fields: [],
        },
        {
          name: "abandonOrder",
          kind: "write",
          caller: "仅 Owner",
          signature: "abandonOrder()",
          summary: "放弃本期：撤未成交买单、提取卖出款、打开退款。份额全清并退完后，剩余电路才退回 Owner。",
          fields: [],
        },
        {
          name: "setPlan",
          kind: "write",
          caller: "Owner",
          signature: "setPlan(uint256)",
          summary: "写入预估算力（仅展示）。只在募集或待挂单时可改。",
          fields: [
            ["hashpower", "预估算力", "0"],
          ],
        },
        {
          name: "setCircuitMarket",
          kind: "write",
          caller: "仅 Owner",
          signature: "Campaign.setCircuitMarket(address)",
          summary: "更换本期电路市场。还有电路挂在旧市场时拒绝（AlreadyListed），换市场会先取回旧市场欠款。",
          fields: [["circuitMarket", "电路市场地址", ""]],
        },
        {
          name: "recoverBnb",
          kind: "write",
          caller: "仅 Owner",
          signature: "recoverBnb()",
          summary: "把本期多余的 BNB 转给 Owner：认筹本金留在池里，只转多余部分；全部退完后整池剩余转出。",
          fields: [],
        },
        {
          name: "recoverCircuits",
          kind: "write",
          caller: "仅 Owner",
          signature: "recoverCircuits(address,uint256)",
          summary: "把当期持有的某一张 ERC721 电路转给 Owner。挂单中或份额未结清时拒绝。",
          fields: [
            ["token", "电路合约", book.circuits || ""],
            ["id", "tokenId", "0"],
          ],
        },
        {
          name: "transferOwnership",
          kind: "write",
          caller: "仅 Owner",
          signature: "Campaign.transferOwnership(address)",
          summary: "转让本期 Owner。",
          fields: [["newOwner", "新 Owner", ""]],
        },
        {
          name: "halt",
          kind: "write",
          caller: "Owner",
          signature: "halt()",
          summary: "熔断：暂停认筹、挂单、卖出、开矿与份额交易。退款、领款、撤单不受影响，不会锁住任何人的资产。",
          fields: [],
        },
        {
          name: "resume",
          kind: "write",
          caller: "仅 Owner",
          signature: "resume()",
          summary: "解除熔断，恢复被停掉的入口。只有 Owner 能调。",
          fields: [],
        },
      ],
    },
    {
      id: "market",
      name: "官方电路市场（ERC721 卖单侧）",
      address: book.circuitMarket || "由本期合约 circuitMarket() 读取",
      methods: [
        {
          name: "marketOpenOrders",
          kind: "read",
          caller: "任何人",
          signature: "nextListingId() / listings(id)",
          summary: "列出市场里属于本期电路的未成交卖单。",
          fields: [],
        },
        {
          name: "marketListing",
          kind: "read",
          caller: "任何人",
          signature: "listings(uint256) view",
          summary: "单张卖单详情：卖家、电路合约、tokenId、单价、手续费快照。",
          fields: [["id", "挂单 ID", "1"]],
        },
        {
          name: "marketSellable",
          kind: "read",
          caller: "任何人",
          signature: "scan listings（筛本期电路）",
          summary: "列出本期电路当前可买的卖单，按单价从低到高。",
          fields: [],
        },
        {
          name: "marketOwed",
          kind: "read",
          caller: "任何人",
          signature: "owed(address) view",
          summary: "市场欠某地址的卖出款；地址留空读本期合约。",
          fields: [["account", "地址（留空 = 本期合约）", ""]],
        },
        {
          name: "simulateBuyListing",
          kind: "write",
          caller: "任意调试钱包",
          signature: "listings(id) → buy(id, price) payable",
          summary: "测试网模拟外部买家吃单：按挂单价真实付款，ERC721 立刻转给买家家。",
          fields: [["id", "挂单 ID", "1"]],
        },
        {
          name: "simulateExternalListing",
          kind: "write",
          caller: "任意调试钱包",
          signature: "MockCircuitNft.mint → approve → list(circuits, tokenId, price)",
          summary: "测试网模拟外部卖家：mint 一张测试电路并挂出卖单，供 buyCircuits 买入。",
          fields: [
            ["tokenId", "电路 tokenId", "1"],
            ["price", "单价 BNB（最多 5 位小数）", "0.05600"],
          ],
        },
      ],
    },
    {
      id: "upstream",
      name: "上游合约（由本期合约调用）",
      address: "由本期合约调用",
      methods: [
        {
          name: "list / delist / buy",
          kind: "internal",
          caller: "仅本期合约",
          signature: "list(circuits,tokenId,price) / delist(id) / buy(id,expectedPrice) payable",
          summary: "官方电路市场只有卖单侧：买入 = buy 吃卖单；卖出 = list 挂单、delist 撤单、withdraw 提款。",
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
  const fields = method ? method.fields.map(([key, label, fallback]) => [key, label, args[key] ?? String(fallback)]) : [];
  // 表单默认值也要参与 gate：listingId 这类参数不能只看静态 fields 定义。
  const values = Object.fromEntries(fields.map(([key, , value]) => [key, value]));
  const gate = method ? callGate(method, book, round, connected, actor, values) : { ok: false, reason: "未选择函数" };
  // 电路挂单价按五位小数限制输入，避免用户填的 0.00456 被静默截成 0.0045
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
                ? "链上模式：读操作实时读链，写操作会发起真实交易。"
                : "读取或调用本期用到的函数。上游合约只能由本期合约内部调用。"}
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

/**
 * 唯一的管理身份就是 Owner（合约里没有操作员 / 管理员之类的二级角色）。
 * actor.canOperate 由 App.jsx 对链上与本地两种模式统一算好，这里只认这一个口径。
 */
function canOperate(actor) {
  return Boolean(actor?.canOperate);
}

/** 两个地址是否是同一个（大小写无关）；任一为空一律 false。 */
function sameAddr(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * 被熔断（halted）挡住的写入口 —— 与合约 `whenLive` 完全对应：
 * subscribe / buyCircuits / listCircuit / startMining / listShares / takeListing。
 * refund / claimSurplus / claimBem / claimMiningRewards / cancelListing / cancelCircuitListing
 * / withdrawMarketProceeds 以及各类管理取回都不在表内：熔断永远不能锁住退出与撤单。
 */
const HALTED_BLOCKED = new Set([
  "subscribe",
  "buyCircuits",
  "listCircuit",
  "startMining",
  "listShares",
  "takeListing",
]);

export function callGate(method, book, round, connected, actor = { role: "user", shares: 0 }, values = {}) {
  if (method.kind === "internal") return { ok: false, reason: "这个函数只允许本期合约内部调用。" };
  if (method.kind === "read") return { ok: true, reason: "" };
  if (method.name === "simulateExternalListing" || method.name === "simulateBuyListing") {
    if (!connected) return { ok: false, reason: "模拟需要连接钱包（任意测试网钱包都可以）。" };
    // 这套入口靠 MockCircuitNft.mint + MockCircuitMarket 才成立；主网官方电路不能凭空铸币。
    if (CHAIN_ID !== 97 && CHAIN_ID !== 31337) {
      return { ok: false, reason: "模拟只在 BSC 测试网 / 本地可用：主网电路合约不能凭空铸币。" };
    }
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不再有电路可撮合。" };
    if (method.name === "simulateExternalListing") {
      return { ok: true, reason: "会以当前钱包 mint 一张测试电路、授权市场并挂出卖单。" };
    }
    return { ok: true, reason: "测试网 Mock 撮合：当前钱包作为外部买家，按挂单价真实付款吃单。" };
  }
  if (book.halted && HALTED_BLOCKED.has(method.name)) {
    return {
      ok: false,
      reason: "本期已熔断：认筹、挂单、卖出、开矿与份额交易暂停；退款与撤单不受影响。等 Owner 抬闸后再试。",
    };
  }
  if (method.name === "createCampaign") {
    if (!connected) return { ok: false, reason: "createCampaign 需要连 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可发布众筹挖矿。" };
    return { ok: true, reason: "将发布众筹挖矿，成功后切换到新合约。" };
  }
  if (method.name === "removeCampaign" || method.name === "removeCampaignAt") {
    if (!connected) return { ok: false, reason: "移除期次需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可从工厂列表移除期次。" };
    return { ok: true, reason: "仅从列表摘除，不销毁链上 Campaign。" };
  }
  if (method.name === "recoverBnb") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可以把 BNB 转给自己。" };
    if (book.scene !== "mining" && outstandingOf(book) > 0) {
      return { ok: true, reason: "一次取走超过 raisedBnb 的多余余额；认筹本金留在本期。不用填数量。" };
    }
    return { ok: true, reason: "本期已无人可退：一次取走整池剩余 BNB。不用填数量。" };
  }
  if (method.name === "recoverCircuits") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可以把电路转给自己。" };
    // 合约三道闸：挂单中（AlreadyListed）、
    // 本期电路还有份额未结清（SharesOutstanding）/ 持份人没按原价收回本金（HoldersNotMadeWhole）。
    if (Number(book.listedCircuits?.length || 0) > 0) {
      return { ok: false, reason: "还有电路挂在市场（AlreadyListed）：先撤单才能转出。" };
    }
    // 只在本期自己的电路上判抵押；转别的 ERC721 不受这条限制。
    if (sameAddr(values?.token, book.circuits)) {
      if (outstandingOf(book) > 0) {
        return {
          ok: false,
          reason: "还有持份人没结清（SharesOutstanding）：本期电路是他们的抵押，不能取回。先退款或卖出。",
        };
      }
      if (Number(book.refundedTotal || 0) < Number(book.sold || 0) * Number(round.sharePriceBnb || 0)) {
        return {
          ok: false,
          reason: "持份人还没按原价收回本金（HoldersNotMadeWhole），本期电路不能交给 Owner。先 topUpShortfall 补齐缺口。",
        };
      }
    }
    if (book.executePhase === "ready") {
      return { ok: true, reason: "取出后子状态仍是已到账。重新放回本期并确认后，才能 startMining 开矿。" };
    }
    return { ok: true, reason: "把本期持有的电路转给当前 Owner。" };
  }
  if (
    method.name === "setCircuitMarket" || method.name === "transferOwnership"
    || method.name === "setFactoryOwner"
  ) {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可更换外部依赖或转让所有权。" };
    // 还有电路挂在旧市场时合约以 AlreadyListed 拒绝换市场。
    if (method.name === "setCircuitMarket" && Number(book.listedCircuits?.length || 0) > 0) {
      return { ok: false, reason: "还有电路挂在市场（AlreadyListed）：先撤单才能更换电路市场。" };
    }
    return { ok: true, reason: "写入新地址后立即生效。" };
  }
  if (method.name === "halt") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能拉闸。" };
    if (book.halted) return { ok: false, reason: "本期已熔断，无需重复操作。" };
    return {
      ok: true,
      reason: "熔断后上述入口全部暂停；退款与撤单不受影响。解除只有 Owner 能做。",
    };
  }
  if (method.name === "resume") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "解除熔断只有 Owner 能做。" };
    if (!book.halted) return { ok: false, reason: "本期未熔断，无需解除。" };
    return { ok: true, reason: "恢复认筹、挂买单、卖出、开矿与份额市场；这是唯一能解除熔断的入口。" };
  }
  if (method.name === "subscribe") {
    if (!connected) return { ok: false, reason: "subscribe 需要已连接的用户钱包。" };
    if (book.scene !== "funding") return { ok: false, reason: "只有募集中可以认筹（subscribe）。" };
    if (book.sold >= round.totalShares) return { ok: false, reason: "份数已售完。" };
    const count = Number(values.shares ?? 0);
    if (!Number.isInteger(count) || count <= 0) return { ok: false, reason: "认筹份数必须是正整数。" };
    if (book.sold + count > round.totalShares) return { ok: false, reason: "认筹份数超过剩余可售份数。" };
    return { ok: true, reason: "" };
  }
  if (method.name === "listShares") {
    if (book.scene !== "mining") return { ok: false, reason: "只有在挖矿中才能进行份额转让。" };
    // 合约从 msg.sender 自己名下扣份额（InsufficientShares）：Owner 没有份额一样挂不出去。
    if (book.mine <= 0) return { ok: false, reason: "当前钱包没有可用份额可挂牌。" };
    const count = Number(values.shares ?? 0);
    if (!Number.isInteger(count) || count <= 0) return { ok: false, reason: "挂出份数必须是正整数。" };
    if (count > book.mine) return { ok: false, reason: `可用份额只有 ${book.mine} 份，挂出份数不能超过可用余额。` };
    if (!(Number(values.priceBnbPerShare ?? 0) > 0)) return { ok: false, reason: "每份单价必须大于 0。" };
    return { ok: true, reason: "挂单后份额锁定，不能领取或转让，直到成交或撤单。" };
  }
  if (method.name === "cancelListing") {
    if (book.scene !== "mining") return { ok: false, reason: "只有在挖矿中才能进行份额转让。" };
    const listing = (book.listings || []).find((l) => String(l.id) === String(values.listingId ?? ""));
    if (!listing || !listing.open) return { ok: false, reason: "挂单不存在或已成交/已撤单，刷新后再试。" };
    if (!canOperate(actor) && String(actor.address || "").toLowerCase() !== String(listing.seller).toLowerCase()) {
      return { ok: false, reason: "只能撤销自己发布的挂单。" };
    }
    return { ok: true, reason: "撤单后锁定份额回到可用余额。" };
  }
  if (method.name === "takeListing") {
    if (book.scene !== "mining") return { ok: false, reason: "只有在挖矿中才能进行份额转让。" };
    const listing = (book.listings || []).find((l) => String(l.id) === String(values.listingId ?? ""));
    if (!listing || !listing.open) return { ok: false, reason: "挂单不存在或已成交/已撤单，刷新后再试。" };
    if (String(actor.address || "").toLowerCase() === String(listing.seller).toLowerCase()) {
      return { ok: false, reason: "不能接收自己发布的挂单。" };
    }
    const count = Number(values.shares ?? 0);
    if (!Number.isInteger(count) || count <= 0) return { ok: false, reason: "接收份数必须是正整数。" };
    if (count > Number(listing.shares)) {
      return { ok: false, reason: `挂单只剩 ${Number(listing.shares)} 份，接收份数不能超过剩余量。` };
    }
    return { ok: true, reason: `按 ${listing.priceBnbPerShare} BNB/份接收，份额过户、BNB 支付给卖方。` };
  }
  if (method.name === "refund") {
    // 余款已经提前按份退回（returnSurplus）：池子是 0，这时退款只会把份额清零、白送挖矿权益。
    if (book.scene === "executing" && Number(book.surplusBase) > 0) {
      return { ok: false, reason: "余款已按份退回，本金已在你手里。此时退款会用 0 BNB 清掉份额，请留着等开矿。" };
    }
    // 合约先挡「电路还在合约手里、池子又不够按原价退完」：否则清零份额会把电路变成死资产。
    if (book.scene === "executing") {
      const partsHeld = Number(book.circuitHeldCount) > 0;
      const poolCovers = Number(book.bnbPool || 0)
        >= outstandingOf(book) * Number(round.sharePriceBnb || 0);
      if (partsHeld && !poolCovers) {
        return { ok: false, reason: "电路还在合约手里，池子不够按原价退完。先让 Owner 补齐缺口，持份人才能退款。" };
      }
    }
    const fundingExpired = book.scene === "funding" && Date.now() > (book.endsAt || Infinity);
    const executeFailed = book.scene === "executing" && book.executionFailed;
    // 新逻辑：待挂单且池子不足以按原价兑付时，也可按比例退款。
    const shortPool = book.scene === "executing" && Boolean(book.refundShort);
    if (!fundingExpired && !executeFailed && !shortPool) {
      if (book.scene === "funding") return { ok: false, reason: "募集尚未结束，不能退款。" };
      if (book.scene === "executing") return { ok: false, reason: "本期还没判失败，池子也够按原价兑付，不能退款。Owner 失联可等售罄满 3 天后判失败。" };
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
    // 合约先挡这两种状态：退过余款（SurplusAlreadyReturned）或已到账（UseReturnSurplus）都不能再判失败。
    if (Number(book.surplusBase) > 0) {
      return { ok: false, reason: "余款已经按份退回（returnSurplus），本金已回到持份人手里，链上会以 SurplusAlreadyReturned 拒绝 markFailed。" };
    }
    if (book.executePhase === "ready") {
      return { ok: false, reason: "电路已到账，不能判失败。出口是退余款 + 开矿。" };
    }
    if (canOperate(actor)) {
      return { ok: true, reason: "Owner 可随时判失败，为所有持份人打开退款。未成交买单会先撤掉。不可逆。" };
    }
    if (!book.markFailedAt) return { ok: false, reason: "还没售罄，没有 3 天宽限期的起算点。" };
    const waitMs = Number(book.markFailedAt) - Date.now();
    if (waitMs > 0) {
      const hours = Math.ceil(waitMs / 3_600_000);
      return { ok: false, reason: `非 Owner 须在售罄或最后一次下单满 3 天后才能调；还需约 ${hours} 小时。` };
    }
    return { ok: true, reason: "已过 3 天宽限期：先撤未成交买单，再判失败并开放退款。" };
  }
  if (method.name === "claimSurplus") {
    const pending = Number(book.pendingSurplusSelf || 0);
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (pending <= 0) return { ok: false, reason: "当前钱包没有待领余款：还没退余款，也还没开始挖矿。" };
    return { ok: true, reason: `领取 ${pending.toFixed(4)} BNB：按份应得、还没转到你地址的募集款余款。` };
  }
  if (method.name === "claimFee") {
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (!connected) return { ok: false, reason: "需要连接收款方钱包。" };
    return { ok: true, reason: "领取属于你自己的挖矿产出服务费。没有可领金额时调用无副作用。" };
  }
  if (method.name === "setServiceFee") {
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅本期 Owner 可设定挖矿产出服务费。" };
    if (book.serviceFeeSet) {
      return { ok: false, reason: "本期挖矿产出服务费已设定并永久锁定（serviceFeeSet == true），改不了了。" };
    }
    if (Number(book.sold || 0) > 0) {
      return { ok: false, reason: "已有人认购，挖矿产出服务费已锁定。合约只允许在 sold == 0 时设定。" };
    }
    return { ok: true, reason: "费率上限 1000 bps（10%），分成地址最多 3 个，份额合计必须等于 10000 bps。设定后永久不可改。" };
  }
  if (method.name === "listCircuit") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能把本期电路挂回市场。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态才有电路可卖。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "要先确认电路到账（Ready），才能挂回市场卖出。" };
    if (!(Number(book.circuitHeldCount) > 0)) {
      return { ok: false, reason: "本期合约手上没有电路，没有可挂单的东西。" };
    }
    if (Number(book.listedCircuits?.length || 0) >= Number(book.circuitHeldCount)) {
      return { ok: false, reason: "手里的电路已经全部挂在市场了，等成交或先撤单。" };
    }
    return { ok: true, reason: "单张 ERC721 授权后挂回市场；成交款进 market owed，需 withdrawMarketProceeds 提回。" };
  }
  if (method.name === "buyCircuits") {
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能从电路市场买入。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要买入电路。" };
    // 合约只允许 Buying：Ready / None 都会 revert WrongScene。
    if (book.executePhase !== "buying") {
      return { ok: false, reason: "只有待挂单（Buying）可买入；已到账请直接开矿或先 setPhase 回 1。" };
    }
    // 合约要求 sold == totalShares（NotSoldOutYet）：已退款清零份额不会撤销这道闸。
    if (Number(book.sold || 0) < Number(round.totalShares || 0)) {
      return { ok: false, reason: "份数还没售完（sold < totalShares），链上会以 NotSoldOutYet 回滚。" };
    }
    if (!(Number(book.raisedBnb ?? book.bnbPool ?? 0) > 0)) {
      return { ok: false, reason: "募集余额为 0，没有钱可以买入电路。" };
    }
    return { ok: true, reason: "按市场最低价挑单、单价不超过上限；一笔交易原子交割，买完可直接确认到账。" };
  }
  if (method.name === "cancelCircuitListing") {
    if (!connected) return { ok: false, reason: "需要连接钱包。" };
    if (book.scene === "mining") return { ok: false, reason: "挖矿中，合约里没有可撤的挂单。" };
    if (!(Number(book.listedCircuits?.length || 0) > 0)) {
      return { ok: false, reason: "当前没有电路挂在市场（activeListingCount = 0），调用会回滚。" };
    }
    if (!canOperate(actor) && !book.retired) {
      return { ok: false, reason: "在册期次只有 Owner 能撤单；工厂移除该期后任何人才可撤。" };
    }
    return { ok: true, reason: "撤单后 NFT 仍在本期合约，随后可重新挂单或开矿。" };
  }
  if (method.name === "withdrawMarketProceeds") {
    if (!connected) return { ok: false, reason: "需要连接钱包（虽然任何人可调）。" };
    if (!(Number(book.marketOwed) > 0)) {
      return { ok: false, reason: "电路市场当前没有欠本期合约的款，调用是 no-op。" };
    }
    return { ok: true, reason: "把电路市场 owed 里的钱转进本期 raisedBnb，供退款或退余款计算。" };
  }
  if (method.name === "setPhase") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可改子状态。" };
    if (book.scene === "mining" || book.scene === "funding") return { ok: false, reason: "只有待执行可以改子状态。" };
    if (Number(book.listedCircuits?.length || 0) > 0) {
      return { ok: false, reason: "还有电路挂在市场（AlreadyListed）：先撤单，否则挂单会和开矿/退款交错。" };
    }
    const nextPhase = Number(values?.next ?? 1);
    if (![1, 2, 3].includes(nextPhase)) return { ok: false, reason: "子状态只能是 1 待挂单 / 2 Ready / 3 已到账（0 与非法值链上回滚）。" };
    if (nextPhase === 3 && !(Number(book.circuitHeldCount) > 0)) {
      return { ok: false, reason: "改成「已到账」需要本期合约真的持有电路（CircuitsNotReady）。" };
    }
    if (Number(book.surplusBase) > 0 && nextPhase !== 3) {
      return { ok: false, reason: "余款已按份退回后，只有改回「已到账」还能继续（WrongScene）。" };
    }
    return { ok: true, reason: "只改 phase。Ready → Buying 是取回电路、重新挂单的恢复路径。" };
  }
  if (method.name === "confirmCircuits") {
    // 合约里 confirmCircuits() 是 external，任何人可调；前端只做状态校验。
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要确认到账。" };
    if (book.executePhase === "ready") return { ok: false, reason: "电路已确认到账，直接 startMining 开矿，或 listCircuit 挂回市场。" };
    if (!(Number(book.circuitHeldCount) > 0)) {
      return { ok: false, reason: "本期合约还没持有电路（CircuitsNotReady）：先用 buyCircuits 买入。" };
    }
    return { ok: true, reason: "确认后即可开矿或挂回市场卖出。任何人可调，不需要 Owner 签名。" };
  }
  if (method.name === "startMining") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能用官方挖矿合约开矿。" };
    const minable = book.scene === "mining" || (book.scene === "executing" && book.executePhase === "ready");
    if (!minable) return { ok: false, reason: "电路还没确认到账（WrongScene）：先买入并确认到账。" };
    if (!(Number(book.circuitHeldCount) > 0)) {
      return { ok: false, reason: "本期合约手上没有电路（NotACircuitOwner）：开矿会被官方合约拒绝。" };
    }
    if (Number(book.listedCircuits?.length || 0) > 0) {
      return { ok: false, reason: "还有电路挂在市场（CircuitStillListed）：先撤单才能开矿。" };
    }
    return {
      ok: true,
      reason: "调用官方 PoD 挖矿合约开矿：电路留在本期合约名下，产出由官方铸给本期再按份额分配。taskId=0 是未验证池。",
    };
  }
  if (method.name === "armMining") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能 armMining。" };
    if (!(Number(book.circuitHeldCount) > 0)) return { ok: false, reason: "本期合约手上没有电路。" };
    return { ok: true, reason: "记录抽样锚点块。已验证池必须在 arm 之后的块（anchor 必须小于当前块）再调 startMining。" };
  }
  if (method.name === "stopMining") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能停止挖矿。" };
    if (!(Number(book.miningActiveCount || 0) > 0)) {
      return { ok: false, reason: "当前没有挖矿中的电路（NothingToStop），调用会回滚。" };
    }
    return { ok: true, reason: "停止后产出当场结算并按份额记账，NFT 仍在本期；官方冷静期后才能重新开矿。" };
  }
  if (method.name === "claimMiningRewards") {
    if (!connected) return { ok: false, reason: "需要连接钱包。" };
    if (!(Number(book.miningActiveCount || 0) > 0) && !(Number(book.miningPendingBem || 0) > 0)) {
      return { ok: false, reason: "没有挖矿中的电路，也没有未领产出（NoRewards）。" };
    }
    return { ok: true, reason: "把官方挖矿合约里已产出的 BEM 领回本期合约，再按份额记账；BEM 不会进调用者口袋。" };
  }
  if (method.name === "claimBem") {
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (!connected) return { ok: false, reason: "需要连接持份人钱包。" };
    if (!(Number(book.bemClaimable || 0) > 0)) return { ok: false, reason: "当前钱包没有可领 BEM（NoRewards）：先等 Owner 领取挖矿奖励。" };
    return { ok: true, reason: `领取 ${Number(book.bemClaimable).toFixed(4)} BEM：按份额应得的挖矿产出。` };
  }
  if (method.name === "returnSurplus") {
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以退余款。" };
    if (book.executePhase !== "ready") {
      return { ok: false, reason: "电路还没确认到账，合约 _requireReady 会以 WrongScene 回滚。" };
    }
    if (Number(book.bnbPool) <= 0) return { ok: false, reason: "募集款已全部用于买电路，没有可退的余款（ZeroShares）。" };
    if (Number(book.marketOwed) > 0) return { ok: false, reason: "电路市场还有欠款没提取，先 withdrawMarketProceeds。" };
    if (!(outstandingOf(book) > 0)) return { ok: false, reason: "份额已全部退完，没有可退对象。" };
    // 合约允许任何人在宽限期（售罄 / 最后一次下单满 3 天）后调用，不只 Owner：团队失联的兜底。
    if (!canOperate(actor)) {
      if (!book.markFailedAt) return { ok: false, reason: "还没售罄，没有 3 天宽限期的起算点；Owner 可随时退余款。" };
      const waitMs = Number(book.markFailedAt) - Date.now();
      if (waitMs > 0) {
        return { ok: false, reason: `非 Owner 须在售罄或最后一次下单满 3 天后才能退余款；还需约 ${Math.ceil(waitMs / 3_600_000)} 小时。` };
      }
    }
    return {
      ok: true,
      reason: "按份退回没花完的募集款：份额不变、电路留在合约，之后照样能开矿。持份人各自领取。",
    };
  }
  if (method.name === "openRefund") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能 openRefund。" };
    if (Number(book.surplusBase) > 0) {
      return { ok: false, reason: "余款已退过、本金已回持份人手里。再退款只会清零份额、把电路交给 Owner，之后只能开矿。" };
    }
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以打开退款。" };
    if (book.executePhase === "ready") {
      return { ok: false, reason: "电路已到账，不能原路退款。只能退余款、用 startMining 直接开矿；确要结束本期须先 setPhase 回待挂单并取回电路。" };
    }
    if (book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "请先撤掉市场挂单，再 openRefund。" };
    }
    if (!(outstandingOf(book) > 0)) {
      return { ok: false, reason: "份额已全部退完，没有可退对象（合约会以 ZeroShares 回滚）。尾差用 recoverBnb 取回。" };
    }
    // 合约 openRefund 的两道附加闸：市场欠款未提取（ProceedsPending）、
    // 电路还在合约里而池子不够按原价退完（PartsAreCollateral）。
    if (Number(book.marketOwed) > 0) {
      return { ok: false, reason: "市场还有未提取的卖出款（ProceedsPending），先 withdrawMarketProceeds 再打开退款。" };
    }
    const partsHeld = Number(book.circuitHeldCount) > 0;
    const poolCovers = Number(book.bnbPool || 0) >= outstandingOf(book) * Number(round.sharePriceBnb || 0);
    if (partsHeld && !poolCovers) {
      return { ok: false, reason: "电路还在合约里、池子不够按原价退完（PartsAreCollateral）：先 topUpShortfall 补齐缺口。" };
    }
    return { ok: true, reason: "打开退款：本期判为执行失败，持份人各自领回本金。若已买过电路且池子不够，先补齐缺口。" };
  }
  if (method.name === "topUpShortfall") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能补齐缺口。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以补齐（开矿后份额与电路都已经定局）。" };
    const need = outstandingOf(book) * Number(round.sharePriceBnb || 0) - Number(book.bnbPool || 0);
    const hint = need > 0 ? `按当前份额与池子，缺口约 ${need.toFixed(6)} BNB。` : "当前池子已能按原价覆盖全部份额，无需补齐（补齐的钱之后可用 recoverBnb 扫回）。";
    return {
      ok: true,
      reason: `${hint}补齐后持份人能按原价退完，Owner 才能取走电路。多补的部分在份额清零后用 recoverBnb 取回。`,
    };
  }
  if (method.name === "abandonOrder") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能 abandonOrder。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以放弃挂单并退款。" };
    if (book.executePhase === "ready") {
      return { ok: false, reason: "电路已到账，不能放弃挂单（会退回 Owner）。只能退余款 + 开矿。" };
    }
    return {
      ok: true,
      reason: "撤未成交买单、提取卖出款、打开退款；份额全清并退完后，剩余电路才退回 Owner。池子不够时先补齐。",
    };
  }
  if (method.name === "setPlan") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能 setPlan。" };
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不可改计划。" };
    if (book.scene === "executing" && book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "挂单中或已到账时不可改 setPlan。" };
    }
    return { ok: true, reason: "写入预估算力，上链后不改。" };
  }
  return { ok: false, reason: "未知函数。" };
}

export function readCall(method, args, round, book, quote = QUOTE) {
  if (/^market(OpenOrders|Listing|Sellable|Owed)$/.test(method) || method === "simulateExternalListing" || method === "simulateBuyListing") {
    return "仅链上模式可用：连接测试网钱包后读取 Mock 电路市场。";
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
  if (method === "circuits") return book.circuits || "—";
  if (method === "circuitCount") return `${Number(book.circuitCount) || 0} 张（累计买入）`;
  if (method === "circuitHeldCount") return `${Number(book.circuitHeldCount) || 0} 张（当前持有）`;
  if (method === "market" || method === "circuitMarket") return book.circuitMarket || "—";
  /**
   * 工厂电路白名单读项（模拟模式）。
   *
   * 模拟模式下没有链上工厂，链上事实不可得 —— 这里如实说明，
   * 不用前端硬编码的处理器列表冒充白名单（那不是链上事实）。
   */
  if (method === "allowedCircuitsCount") return "仅链上模式可读（工厂电路白名单，部署时写入、不可增删）";
  if (method === "allowedCircuitsAt") return "仅链上模式可读";
  if (method === "isAllowedParts") return "仅链上模式可读";
  if (method === "executionFailed") return book.executionFailed ? "是（已判执行失败）" : "否";
  if (method === "halted") {
    return book.halted
      ? "已熔断：认筹、挂单、卖出、开矿与份额交易已停"
      : "运行中";
  }
  if (method === "soldOutAt") {
    return book.soldOutAt ? new Date(book.soldOutAt).toLocaleString("zh-CN") : "—";
  }
  if (method === "priceLock") {
    return Number(book.priceLock) > 0
      ? `${Number(book.priceLock).toFixed(4)} BNB（${book.circuitHeldCount || 0} 张）`
      : "未锁价";
  }
  if (method === "miningStatus") {
    const labels = ["未开矿", "挖矿中", "已撤销", "冷却中"];
    const row = (book.sellBids || []).find((b) => String(b.circuitTokenId ?? b.id) === String(args?.tokenId ?? ""));
    return row ? (labels[Number(row.miningStatus) || 0] || "未开矿") : "仅链上模式可读（官方 miningStatus）";
  }
  if (method === "bemPendingOf") {
    return `${Number(book.bemClaimable || 0).toFixed(4)} BEM（当前钱包）`;
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
