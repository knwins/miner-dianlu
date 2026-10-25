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
          signature: "createCampaign(uint256 sharePriceBnb,uint256 totalShares,uint64 fundingSeconds,address transistors) returns (address)",
          summary: "开一期众筹。四个参数：每份 BNB、总份数、募集天数、本期晶体管合约（必须来自工厂白名单）。",
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
          name: "allowedPartsCount",
          kind: "read",
          caller: "任何人",
          signature: "allowedPartsCount() view",
          summary: "白名单条数。白名单部署时写入，之后不可增删；开期时只能从这里选。",
          fields: [],
        },
        {
          name: "allowedPartsAt",
          kind: "read",
          caller: "任何人",
          signature: "allowedPartsAt(uint256) view",
          summary: "白名单第 index 项的晶体管合约地址（主网为 TapeOut / Behemoth）。",
          fields: [["index", "索引", "0"]],
        },
        {
          name: "isAllowedParts",
          kind: "read",
          caller: "任何人",
          signature: "isAllowedParts(address) view",
          summary: "该晶体管合约是否在名单内。不在名单里不能开期。",
          fields: [["parts", "晶体管合约地址", "0x"]],
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
        { name: "transistors", kind: "read", caller: "任何人", signature: "transistors() view", summary: "开期锁定的晶体管合约。NAND 为 0，LATCH 为 1。", fields: [] },
        { name: "materialMarket", kind: "read", caller: "任何人", signature: "materialMarket() view", summary: "本期使用的晶体管市场地址。", fields: [] },
        { name: "executionFailed", kind: "read", caller: "任何人", signature: "executionFailed() view", summary: "是否已判执行失败；为真时持份人可退款。", fields: [] },
        { name: "halted", kind: "read", caller: "任何人", signature: "halted() view", summary: "熔断中：认筹、挂单、卖出、入池、份额交易全停；退款、领款、撤单不受影响。", fields: [] },
        { name: "soldOutAt", kind: "read", caller: "任何人", signature: "soldOutAt() view", summary: "售罄时间。非 Owner 判失败须等售罄满 3 天。", fields: [] },
        { name: "priceLock", kind: "read", caller: "任何人", signature: "priceLock() view", summary: "本次挂单锁定的晶体管成本与数量。", fields: [] },
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
        { name: "refund", kind: "write", caller: "持份用户 / Owner", signature: "refund()", summary: "退回本金并清零份额。只有募集超时、已判失败、或池子不足以按原价兑付时可用；晶体管已到账则不可退，只能退余款。", fields: [] },
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
        { name: "markFailed", kind: "write", caller: "Owner 随时；其他人须售罄满 3 天", signature: "markFailed()", summary: "把本期判为执行失败，为所有持份人打开退款。Owner 随时可调，其他人须售罄满 3 天；晶体管已到账则不可用。", fields: [] },
        { name: "claim", kind: "write", caller: "用户", signature: "claim()", summary: "占位实现，当前不产出发放。", fields: [] },
        {
          name: "depositToPool",
          kind: "write",
          caller: "仅 Owner",
          signature: "depositToPool()",
          summary: "把晶体管投入矿池，本期进入挖矿（不可逆）。没花完的募集款会先按份记账给持份人。",
          fields: [],
        },
        {
          name: "confirmTransistors",
          kind: "write",
          caller: "任何人",
          signature: "confirmTransistors()",
          summary: "确认买单已成交、晶体管已到账。之后才能卖出或入池。任何人可调。",
          fields: [],
        },
        {
          name: "placeTransistorOrder",
          kind: "write",
          caller: "仅 Owner",
          signature: "placeTransistorOrder(uint256 nandQty, uint96 nandPrice, uint256 latchQty, uint96 latchPrice)",
          summary: "挂单买入 NAND / LATCH，保证金从募集款里出。只在待挂单时可调，一次只能有一张挂单。",
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
          caller: "未成交仅 Owner；已有成交或已移除时任何人",
          signature: "cancelTransistorOrder()",
          summary: "撤掉未成交部分，保证金退回募集池。已成交的不能撤。",
          fields: [],
        },
        {
          name: "sellTransistors",
          kind: "write",
          caller: "Owner",
          signature: "sellTransistors(uint256 bidId, uint8 tokenId, uint256 quantity)",
          summary: "吃一张市场买单，把手里的晶体管按该单单价卖掉，成交款立即回本期。只在已到账后可用，单价不能低于本期买入成本。",
          fields: [
            ["bidId", "要吃的买单 ID", "1"],
            ["tokenId", "0 = NAND，1 = LATCH", "0"],
            ["quantity", "卖出数量（颗）", "1"],
          ],
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
          summary: "把没花完的募集款按份退回持份人（各自领取）。不结束本期，之后仍可入池。要求市场不欠款。",
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
          summary: "打开退款：本期判为执行失败，持份人各自领回本金。只在待挂单可用；晶体管已到账请改用 returnSurplus。",
          fields: [],
        },
        {
          name: "abandonOrder",
          kind: "write",
          caller: "仅 Owner",
          signature: "abandonOrder()",
          summary: "放弃本期：撤未成交买单、提取卖出款、打开退款。份额全清并退完后，剩余晶体管才退回 Owner。",
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
          name: "setMiningPool",
          kind: "write",
          caller: "仅 Owner",
          signature: "setMiningPool(address)",
          summary: "设定矿池地址，入池时晶体管转到这里。",
          fields: [["pool", "矿池地址", ""]],
        },
        {
          name: "harvest",
          kind: "write",
          caller: "任何人",
          signature: "harvest()",
          summary: "占位实现，当前不产出发放。",
          fields: [],
        },
        {
          name: "setMaterialMarket",
          kind: "write",
          caller: "仅 Owner",
          signature: "Campaign.setMaterialMarket(address)",
          summary: "更换本期晶体管市场。挂单中不能换。",
          fields: [["materialMarket", "晶体管市场地址", ""]],
        },
        {
          name: "recoverBnb",
          kind: "write",
          caller: "仅 Owner",
          signature: "recoverBnb()",
          summary: "把本期多余的 BNB 转给 Owner：认筹本金留在池里，只转多余部分；入池后或全部退完后整池剩余转出。",
          fields: [],
        },
        {
          name: "recoverTransistors",
          kind: "write",
          caller: "仅 Owner",
          signature: "recoverTransistors(address,uint256,uint256)",
          summary: "把本期持有的晶体管转给 Owner。挂单中不可转。",
          fields: [
            ["token", "晶体管合约", book.transistors || ""],
            ["id", "tokenId", "0"],
            ["amount", "数量", "1"],
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
          summary: "熔断：暂停认筹、挂单、卖出、入池与份额交易。退款、领款、撤单不受影响，不会锁住任何人的资产。",
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
      name: "晶体管市场（只读 / 测试网模拟）",
      address: book.market || "由本期合约 materialMarket() 读取",
      methods: [
        {
          name: "marketOpenOrders",
          kind: "read",
          caller: "任何人",
          signature: "nextBidId() / bids(id)",
          summary: "列出市场里所有未成交的买单。",
          fields: [],
        },
        {
          name: "marketBids",
          kind: "read",
          caller: "任何人",
          signature: "bids(uint256) view",
          summary: "单张买单详情：买家、晶体管、单价、剩余量。",
          fields: [["id", "买单 ID", "1"]],
        },
        {
          name: "marketSellable",
          kind: "read",
          caller: "任何人",
          signature: "nextBidId() / bids(id)（筛本期晶体管）",
          summary: "列出本期能吃的外部买单，按单价从高到低。",
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
          name: "simulateFillBid",
          kind: "write",
          caller: "任意调试钱包",
          signature: "bids(id) → fillBid(id, quantity) → MockERC1155.mint(buyer)",
          summary: "测试网模拟卖方成交，并把同数量测试晶体管铸给买家。",
          fields: [["id", "买单 ID", "1"], ["quantity", "成交数量（留空 = 全部剩余）", ""]],
        },
        {
          name: "simulateFillCampaignBids",
          kind: "write",
          caller: "任意调试钱包",
          signature: "nandBidId() / latchBidId() → fillBid + mint",
          summary: "测试网一键撮合本期两张买单并补齐晶体管。",
          fields: [],
        },
        {
          name: "simulateExternalBid",
          kind: "write",
          caller: "任意调试钱包",
          signature: "placeBid(transistors, tokenId, price, quantity) payable",
          summary: "测试网模拟外部买家挂一张本期晶体管的买单。",
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
  const fields = method ? method.fields.map(([key, label, fallback]) => [key, label, args[key] ?? String(fallback)]) : [];
  // 表单默认值也要参与 gate：listingId 这类参数不能只看静态 fields 定义。
  const values = Object.fromEntries(fields.map(([key, , value]) => [key, value]));
  const gate = method ? callGate(method, book, round, connected, actor, values) : { ok: false, reason: "未选择函数" };
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
 * subscribe / placeTransistorOrder / sellTransistors / depositToPool / listShares / takeListing。
 * refund / claimSurplus / claimFee / cancelListing / cancelTransistorOrder / withdrawMarketProceeds
 * 以及各类管理取回都不在表内：熔断永远不能锁住退出与撤单。
 */
const HALTED_BLOCKED = new Set([
  "subscribe",
  "placeTransistorOrder",
  "sellTransistors",
  "depositToPool",
  "listShares",
  "takeListing",
]);

export function callGate(method, book, round, connected, actor = { role: "user", shares: 0 }, values = {}) {
  if (method.kind === "internal") return { ok: false, reason: "这个函数只允许本期合约内部调用。" };
  if (method.kind === "read") return { ok: true, reason: "" };
  if (method.name.startsWith("simulateFill") || method.name === "simulateExternalBid") {
    if (!connected) return { ok: false, reason: "模拟撮合需要连接钱包（任意测试网钱包都可以）。" };
    // 这套入口靠 MockMaterialMarket.fillBid + MockERC1155.mint 才成立；主网官方合约没有公开 mint。
    if (CHAIN_ID !== 97 && CHAIN_ID !== 31337) {
      return { ok: false, reason: "模拟撮合只在 BSC 测试网 / 本地可用：主网晶体管合约不能凭空铸币。" };
    }
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不再有晶体管挂单可撮合。" };
    if (method.name === "simulateFillCampaignBids" && book.orderFilled) {
      return { ok: false, reason: "本期买单已全部成交，直接「确认到账」即可。" };
    }
    if (method.name === "simulateExternalBid") {
      return { ok: true, reason: "会以当前钱包在 Mock 市场挂一张本期晶体管的买单，托管价 × 数量。" };
    }
    return { ok: true, reason: "测试网 Mock 撮合：会真实发交易；买单成交时额外 mint 测试晶体管给买家。" };
  }
  if (book.halted && HALTED_BLOCKED.has(method.name)) {
    return {
      ok: false,
      reason: "本期已熔断：认筹、挂单、卖出、入池与份额交易暂停；退款与撤单不受影响。等 Owner 抬闸后再试。",
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
  if (method.name === "recoverTransistors") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可以把晶体管转给自己。" };
    // 合约四道闸：已入池（AlreadyPooled）、挂单中（AlreadyListed）、
    // 本期晶体管还有份额未结清（SharesOutstanding）/ 持份人没按原价收回本金（HoldersNotMadeWhole）。
    if (book.pooled) {
      return { ok: false, reason: "本期已入池（AlreadyPooled）：晶体管已转给矿池，合约里没有可转出的余额。" };
    }
    if (book.executePhase === "listed") {
      return { ok: false, reason: "挂单中不能转出晶体管（AlreadyListed），先撤单或确认到账。" };
    }
    // 只在本期自己的晶体管上判抵押；转别的 ERC1155 不受这条限制。
    if (sameAddr(values?.token, book.transistors)) {
      if (outstandingOf(book) > 0) {
        return {
          ok: false,
          reason: "还有持份人没结清（SharesOutstanding）：本期晶体管是他们的抵押，不能取回。先退款或入池。",
        };
      }
      if (Number(book.refundedTotal || 0) < Number(book.sold || 0) * Number(round.sharePriceBnb || 0)) {
        return {
          ok: false,
          reason: "持份人还没按原价收回本金（HoldersNotMadeWhole），本期晶体管不能交给 Owner。先 topUpShortfall 补齐缺口。",
        };
      }
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
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可更换外部依赖或转让所有权。" };
    // 在途买单会把托管款留在旧市场：合约以 AlreadyListed 拒绝换市场。
    if (method.name === "setMaterialMarket" && book.executePhase === "listed") {
      return { ok: false, reason: "挂单中不能更换晶体管市场（AlreadyListed）：先撤单或确认到账。" };
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
    return { ok: true, reason: "恢复认筹、挂买单、卖出、入池与份额市场；这是唯一能解除熔断的入口。" };
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
      return { ok: false, reason: "余款已按份退回，本金已在你手里。此时退款会用 0 BNB 清掉份额，请留着等入池。" };
    }
    // 合约先挡「晶体管还在合约手里、池子又不够按原价退完」：否则清零份额会把晶体管变成死资产。
    if (book.scene === "executing") {
      const partsHeld = (Number(book.partsNand) || 0) + (Number(book.partsLatch) || 0) > 0;
      const poolCovers = Number(book.bnbPool || 0)
        >= outstandingOf(book) * Number(round.sharePriceBnb || 0);
      if (partsHeld && !poolCovers) {
        return { ok: false, reason: "晶体管还在合约手里，池子不够按原价退完。先让 Owner 补齐缺口，持份人才能退款。" };
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
      return { ok: false, reason: "晶体管已到账，不能判失败。出口是退余款 + 入池。" };
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
  if (method.name === "claim") {
    return { ok: false, reason: "claim 是占位实现（no-op）：不产出发放，前端不提供调用入口。" };
  }
  if (method.name === "claimSurplus") {
    const pending = Number(book.pendingSurplusSelf || 0);
    if (!book._chain) return { ok: false, reason: "仅链上模式可用。" };
    if (pending <= 0) return { ok: false, reason: "当前钱包没有待领余款：还没退余款，也还没入池。" };
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
  if (method.name === "sellTransistors") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能把本期晶体管卖出去。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态才有晶体管可卖。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "要先确认买单到账（Ready），才能吃外部买单卖出。" };
    if (!(Number(book.partsNand) > 0 || Number(book.partsLatch) > 0)) {
      return { ok: false, reason: "本期合约手上没有晶体管余额，没有可卖的东西。" };
    }
    if (!(book.sellBids || []).length) {
      return { ok: false, reason: "市场里还没有标的是本期晶体管的买单。等外部买家挂单，或直接入池。" };
    }
    return { ok: true, reason: "按所选买单的单价成交，成交款立即回本期。单价低于本期成本会被拒绝。" };
  }
  if (method.name === "placeTransistorOrder") {
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能挂单。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要挂单买晶体管。" };
    // 合约只允许 Buying：Listed / Ready / None 都会 revert WrongScene。
    if (book.executePhase !== "buying") {
      return { ok: false, reason: "只有待挂单（Buying）可挂买单；挂单中请先成交或撤单，已到账请直接入池。" };
    }
    // 合约要求 sold == totalShares（NotSoldOutYet）：已退款清零份额不会撤销这道闸。
    if (Number(book.sold || 0) < Number(round.totalShares || 0)) {
      return { ok: false, reason: "份数还没售完（sold < totalShares），链上会以 NotSoldOutYet 回滚。" };
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
    if (!anyone && !canOperate(actor)) {
      return { ok: false, reason: "未成交时只有 Owner 能撤；有成交或该期已移除后，任何人都能撤剩余。" };
    }
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态有挂单可取消。" };
    // 合约 cancelTransistorOrder 只接受 phase == Listed；Ready 的出口是 returnSurplus + depositToPool。
    if (book.executePhase !== "listed") {
      return { ok: false, reason: "只有挂单中（Listed）才能撤单；已到账（Ready）请直接退余款并入池，或卖入市场买单。" };
    }
    return { ok: true, reason: "只撤未成交部分；已成交的留在本期合约，随后确认到账或按比例退款。" };
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
    if (!canOperate(actor)) return { ok: false, reason: "仅 Owner 可改子状态。" };
    if (book.scene === "mining" || book.scene === "funding") return { ok: false, reason: "只有待执行可以改子状态。" };
    if (book.executePhase === "listed") return { ok: false, reason: "挂单中不能改子状态（AlreadyListed）：先撤单或确认到账，否则托管款会留在市场。" };
    const nextPhase = Number(values?.next ?? 1);
    if (![1, 2, 3].includes(nextPhase)) return { ok: false, reason: "子状态只能是 1 待挂单 / 2 挂单中 / 3 已到账（0 与非法值链上回滚）。" };
    if (nextPhase === 2 && !book.orderFilled
      && !(Number(book.nandRemaining) > 0 || Number(book.latchRemaining) > 0)) {
      return { ok: false, reason: "改成「挂单中」需要市场里真有未成交买单（WrongScene）。" };
    }
    const settledPurchase = Number(book.priceLock) > 0 && book.orderFilled;
    const heldParts = Number(book.partsNand) > 0 || Number(book.partsLatch) > 0;
    if (nextPhase === 3 && !settledPurchase && !heldParts) {
      return { ok: false, reason: "改成「已到账」需要买单已成交或手上有晶体管（TransistorsNotReady）。" };
    }
    if (Number(book.surplusBase) > 0 && nextPhase !== 3 && !settledPurchase && !heldParts) {
      return { ok: false, reason: "余款已按份退回后，只有改回「已到账」还能继续（WrongScene）：否则本期会卡在所有出口都回滚的待挂单。" };
    }
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
    return { ok: true, reason: "确认后即可入池或卖入市场买单。任何人可调，不需要 Owner 签名。" };
  }
  if (method.name === "depositToPool") {
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以 depositToPool。" };
    if (book.executePhase !== "ready") return { ok: false, reason: "晶体管尚未到账，请先由 Owner 买入晶体管并确认成交到账。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 可以 depositToPool 入池（不可逆操作）。" };
    // 合约硬门槛：未入池、矿池地址已设置、有到位依据、仍有未退份额、手里真的有晶体管。
    if (book.pooled) return { ok: false, reason: "本期已入池（AlreadyPooled），不能重复入池。" };
    if (book._chain && (!book.miningPool || /^0x0{40}$/i.test(String(book.miningPool)))) {
      return { ok: false, reason: "还没设置矿池地址（PoolNotSet）：先 setMiningPool，再 depositToPool。" };
    }
    if (book._chain && String(book.miningPool).toLowerCase() === String(book.campaign || "").toLowerCase()) {
      return { ok: false, reason: "矿池地址是本期合约自己（ZeroAddress）：先在 setMiningPool 里改成真实的矿池地址。" };
    }
    if (!(outstandingOf(book) > 0)) {
      return { ok: false, reason: "份额已全部退完（outstandingShares = 0），没有持有人可分产出，链上会以 ZeroShares 拒绝入池。" };
    }
    if (!(Number(book.partsNand) > 0 || Number(book.partsLatch) > 0)) {
      return { ok: false, reason: "本期合约手上没有晶体管（InsufficientParts）：先挂单买入并确认到账再入池。" };
    }
    /**
     * 合约在 depositToPool 内部就把没花完的募集款按份记账（_returnSurplus），
     * 并先尽力提取市场欠款（_pullOwedSoft）——两步都不需要前端先单独做一遍。
     * 这里只提示，不再挡路（多一步 returnSurplus 只会多花一笔 gas）。
     */
    const notes = [];
    if (Number(book.marketOwed) > 0) {
      notes.push("市场还欠本期卖出款：入池时会先尽力提取，提不动的部分之后进账仍会按份记账给持份人");
    }
    if (Number(book.bnbPool) > 0 && !(Number(book.surplusBase) > 0)) {
      notes.push("没花完的募集款会在同一笔交易里按份记账给持份人");
    }
    return {
      ok: true,
      reason: `晶体管转入矿池，本期进入挖矿（不可逆）。${notes.length ? `注意：${notes.join("；")}。` : ""}`,
    };
  }
  if (method.name === "returnSurplus") {
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以退余款。" };
    if (book.executePhase !== "ready") {
      return { ok: false, reason: "晶体管还没确认到账，合约 _requireReady 会以 WrongScene 回滚。" };
    }
    if (Number(book.bnbPool) <= 0) return { ok: false, reason: "募集款已全部用于买晶体管，没有可退的余款（ZeroShares）。" };
    if (Number(book.marketOwed) > 0) return { ok: false, reason: "晶体管市场还有欠款没提取，先 withdrawMarketProceeds。" };
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
      reason: "按份退回没花完的募集款：份额不变、晶体管留在合约，之后照样能入池。持份人各自领取。",
    };
  }
  if (method.name === "openRefund") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能 openRefund。" };
    if (Number(book.surplusBase) > 0) {
      return { ok: false, reason: "余款已退过、本金已回持份人手里。再退款只会清零份额、把晶体管交给 Owner，之后只能入池。" };
    }
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以打开退款。" };
    if (book.executePhase === "ready") {
      return { ok: false, reason: "晶体管已到账，不能原路退款。只能退余款、把晶体管投入矿池；确要结束本期须先改回待挂单。" };
    }
    if (book.executePhase === "listed") {
      return { ok: false, reason: "买单未确认，不能退款。" };
    }
    if (book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "请先取消挂单，再 openRefund。" };
    }
    if (!(outstandingOf(book) > 0)) {
      return { ok: false, reason: "份额已全部退完，没有可退对象（合约会以 ZeroShares 回滚）。尾差用 recoverBnb 取回。" };
    }
    // 合约 openRefund 的两道附加闸：市场欠款未提取（ProceedsPending）、
    // 晶体管还在合约里而池子不够按原价退完（PartsAreCollateral）。
    if (Number(book.marketOwed) > 0) {
      return { ok: false, reason: "市场还有未提取的卖出款（ProceedsPending），先 withdrawMarketProceeds 再打开退款。" };
    }
    const partsHeld = (Number(book.partsNand) || 0) + (Number(book.partsLatch) || 0) > 0;
    const poolCovers = Number(book.bnbPool || 0) >= outstandingOf(book) * Number(round.sharePriceBnb || 0);
    if (partsHeld && !poolCovers) {
      return { ok: false, reason: "晶体管还在合约里、池子不够按原价退完（PartsAreCollateral）：先 topUpShortfall 补齐缺口。" };
    }
    return { ok: true, reason: "打开退款：本期判为执行失败，持份人各自领回本金。若已买过晶体管且池子不够，先补齐缺口。" };
  }
  if (method.name === "topUpShortfall") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能补齐缺口。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态可以补齐（入池后份额与晶体管都已经定局）。" };
    const need = outstandingOf(book) * Number(round.sharePriceBnb || 0) - Number(book.bnbPool || 0);
    const hint = need > 0 ? `按当前份额与池子，缺口约 ${need.toFixed(6)} BNB。` : "当前池子已能按原价覆盖全部份额，无需补齐（补齐的钱之后可用 recoverBnb 扫回）。";
    return {
      ok: true,
      reason: `${hint}补齐后持份人能按原价退完，Owner 才能取走晶体管。多补的部分在份额清零后用 recoverBnb 取回。`,
    };
  }
  if (method.name === "abandonOrder") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "只有 Owner 能 abandonOrder。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以放弃挂单并退款。" };
    if (book.executePhase === "ready") {
      return { ok: false, reason: "晶体管已到账，不能放弃挂单（会退回 Owner）。只能退余款 + 入池。" };
    }
    return {
      ok: true,
      reason: "撤未成交买单、提取卖出款、打开退款；份额全清并退完后，剩余晶体管才退回 Owner。池子不够时先补齐。",
    };
  }
  if (method.name === "setMiningPool") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (!canOperate(actor)) return { ok: false, reason: "仅本期 Owner 可设定矿池地址。" };
    if (book.pooled) return { ok: false, reason: "本期已入池（不可逆），矿池地址不能再改。" };
    const pool = String(values?.pool || "").trim();
    if (pool && !/^0x[0-9a-fA-F]{40}$/.test(pool)) return { ok: false, reason: "矿池地址必须是 20 字节地址。" };
    if (pool && /^0x0{40}$/i.test(pool)) return { ok: false, reason: "矿池地址不能是零地址（ZeroAddress）。" };
    if (pool && String(book.campaign || "").toLowerCase() === pool.toLowerCase()) {
      return { ok: false, reason: "矿池地址不能是本期合约自己（ZeroAddress）。" };
    }
    return { ok: true, reason: "写入本期矿池地址；入池前可反复改，depositToPool 之后锁死。" };
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
  if (method === "halted") {
    return book.halted
      ? "已熔断：认筹、挂单、卖出、入池与份额交易已停"
      : "运行中";
  }
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
