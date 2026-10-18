import { useMemo, useState } from "react";
import {
  MARKET,
  QUOTE,
  ROUND,
  SCENE_COPY,
  bemRate,
  buildHolders,
  computeHarvest,
  estimateHashpower,
  formatBem,
  formatClock,
  formatUsdt,
  reviewRound,
  seedCalls,
  shortAddress,
} from "./fixtures.js";
import { FACTORY_ADDRESS, POD_ADDRESS, CAMPAIGN_ADDRESS } from "./chain/config.js";
import { getCampaignAddress, liveReadView } from "./chain/client.js";

export function contractCatalog(round) {
  const factoryAddr = FACTORY_ADDRESS || "0xF4c7000000000000000000000000000000000F4c";
  const campaignAddr = round?.contract || getCampaignAddress() || CAMPAIGN_ADDRESS;
  const podAddr = POD_ADDRESS || "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
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
          signature: "createCampaign(uint256,uint256,uint16,uint64,address[],uint16[],uint256,address,bytes32,address)",
          summary: "发布众筹挖矿。末参为晶体管合约（TapeOut / Behemoth）。服务费可多地址分成，之和须为 100%；网表默认 netlist-v1。",
          fields: [
            ["sharePriceBnb", "每份 BNB", round.sharePriceBnb],
            ["totalShares", "总份数", round.totalShares],
            ["feePercent", "服务费 %", round.feeBps / 100],
            ["fundingDays", "募集天数", round.fundingDays],
            ["taskId", "官方题目", round.taskId],
            ["feeRecipient", "服务费地址（单地址兼容）", round.feeRecipient],
            ["feeShareBps", "分成基点（整百分点×100），合计 10000", "10000"],
          ],
        },
        {
          name: "removeCampaign",
          kind: "write",
          caller: "Factory Owner",
          signature: "removeCampaign(address campaign)",
          summary: "按地址从工厂列表移除一期。不销毁链上 Campaign；有份额仍可用原地址直连。swap-and-pop 后序号可能变化。",
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
          name: "setFactoryPod",
          kind: "write",
          caller: "Factory Owner",
          signature: "CampaignFactory.setPod(address)",
          summary: "更换工厂默认 PoD；仅影响之后新开期。已开期请在 Campaign 上 setPod。",
          fields: [["pod", "PoD 地址", podAddr]],
        },
        {
          name: "setFactoryBem",
          kind: "write",
          caller: "Factory Owner",
          signature: "CampaignFactory.setBem(address)",
          summary: "更换工厂默认 BEM；仅影响之后新开期。",
          fields: [["bem", "BEM 地址", ""]],
        },
        {
          name: "setFactoryMinter",
          kind: "write",
          caller: "Factory Owner",
          signature: "CampaignFactory.setMinter(address)",
          summary: "更换工厂默认材料市场；仅影响之后新开期。铸造已结束，这里应是官方买单市场。",
          fields: [["minter", "材料市场地址", ""]],
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
        { name: "sold", kind: "read", caller: "任何人", signature: "sold() view", summary: "已售份数。", fields: [] },
        { name: "sharePriceBnb", kind: "read", caller: "任何人", signature: "sharePriceBnb() view", summary: "每份价格（BNB）。", fields: [] },
        { name: "totalShares", kind: "read", caller: "任何人", signature: "totalShares() view", summary: "总份数。", fields: [] },
        { name: "hashpower", kind: "read", caller: "任何人", signature: "hashpower() view", summary: "实际算力。未执行时为 0。", fields: [] },
        { name: "estHashpower", kind: "read", caller: "任何人", signature: "estHashpower() view", summary: "预估算力（setPlan 写入；未流片时展示）。", fields: [] },
        { name: "dailyBem", kind: "read", caller: "任何人", signature: "dailyBem() view", summary: "当前日产 BEM，由实际算力换算。", fields: [] },
        { name: "harvestCount", kind: "read", caller: "任何人", signature: "harvestCount() view", summary: "已领取次数与剩余可领次数。", fields: [] },
        { name: "feeBps", kind: "read", caller: "任何人", signature: "feeBps() view", summary: "服务费基点（占日产）。", fields: [] },
        {
          name: "feeShares",
          kind: "read",
          caller: "任何人",
          signature: "feeShares() view",
          summary: "服务费分成表。每项为整百分点（100=1%），之和为 10000；harvest 整除余数进 Owner。",
          fields: [],
        },
        { name: "totalDistributed", kind: "read", caller: "任何人", signature: "totalDistributed() view", summary: "本期已分配给全部持有人的净 BEM。", fields: [] },
        {
          name: "sharesOf",
          kind: "read",
          caller: "任何人",
          signature: "sharesOf(address) view",
          summary: "某地址持有的份数。",
          fields: [["account", "地址", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"]],
        },
        {
          name: "pendingBem",
          kind: "read",
          caller: "任何人",
          signature: "pendingBem(address) view",
          summary: "某地址可领取的 BEM。",
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
        { name: "refund", kind: "write", caller: "持份用户 / Owner", signature: "refund()", summary: "两种本金返还：① 募集超过截止时间仍未售罄；② 流片执行失败（元件暴涨买不起，本金尚未支出）。两种情况下都把认筹的 BNB 原路退还给认筹地址，份额清零。与挖矿中的份额转让无关。", fields: [] },
        { name: "claim", kind: "write", caller: "用户", signature: "claim()", summary: "领取已入账的 BEM。", fields: [] },
        {
          name: "execute",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "execute(bytes,bytes)",
          summary: "晶体管到账后，仅 Factory Owner 可触发。退还剩余募集款后调 pod.start。官方适配器路径须填 startData（或 circuitId+证明），且当期须已持有电路 NFT。",
          fields: [
            ["startData", "官方 startData（已打包，优先）", ""],
            ["cpu", "处理器", "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C"],
            ["circuitId", "电路 ID", ""],
            ["taskId", "题目 ID", "54"],
            ["anchor", "anchor", "0"],
            ["proofs", "proofs hex，逗号分隔", ""],
            ["circuits", "circuits hex，逗号分隔", ""],
            ["pubs", "pubs JSON", ""],
            ["salt", "salt bytes32", ""],
          ],
        },
        {
          name: "confirmTransistors",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "confirmTransistors()",
          summary: "读取官方材料市场 bids(id).remaining。两腿都成交才进入待流片。未成交会回退，不能靠网页手工确认。",
          fields: [],
        },
        {
          name: "placeTransistorOrder",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "placeTransistorOrder(address transistors, uint256 nandQty, uint96 nandPrice, uint256 latchQty, uint96 latchPrice)",
          summary: "调用材料市场 placeBid。NAND tokenId 0、LATCH tokenId 1，保证金从募集款托管。买不起则标失败且不挂单。",
          fields: [
            ["count", "挂单数量（颗）", "100"],
            ["unitPriceBnb", "挂单单价（BNB/颗）", "0.005"],
          ],
        },
        {
          name: "cancelTransistorOrder",
          kind: "write",
          caller: "未成交仅 Factory Owner；已有成交时任何人",
          signature: "cancelTransistorOrder()",
          summary: "撤销市场上还没成交的部分，保证金退回本期并回到待挂单。全部成交且元件已到账时不能取消。",
          fields: [],
        },
        {
          name: "openRefund",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "openRefund()",
          summary: "待挂单时批量原路退回各认筹地址本金（对齐合约 openRefund，非 abortUnaffordable）。",
          fields: [],
        },
        {
          name: "setPlan",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "setPlan(uint256,bool,uint256)",
          summary: "写入预估算力、是否撞闸门、晶体管数量。仅 funding 或 executing+buying。",
          fields: [
            ["hashpower", "预估算力", "0"],
            ["capped", "撞闸门", "false"],
            ["count", "晶体管数", "100"],
          ],
        },
        {
          name: "harvest",
          kind: "write",
          caller: "任何人",
          signature: "harvest()",
          summary: "从 PoD 拉本轮实际到账的 BEM（不要求 ≥ dailyBem 估算）、扣服务费、按份入账。测试网 bemIsMock 时前端可先注资 MockPoD；主网无此捷径。",
          fields: [],
        },
        {
          name: "setPod",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "Campaign.setPod(address)",
          summary: "更换本期 PoD（主网替换 Mock）。挖矿中途更换须谨慎。",
          fields: [["pod", "PoD 地址", podAddr]],
        },
        {
          name: "setBem",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "Campaign.setBem(address)",
          summary: "更换本期 BEM。已有 pending/余额时换币种前请核对账本。",
          fields: [["bem", "BEM 地址", ""]],
        },
        {
          name: "setMinter",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "Campaign.setMinter(address)",
          summary: "更换本期材料市场。挂单、撤单都打到这个合约。",
          fields: [["minter", "材料市场地址", ""]],
        },
        {
          name: "setFeeShares",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "Campaign.setFeeShares(address[],uint16[])",
          summary: "重写服务费分成表。地址与基点一一对应；每项须为整百分点（100=1%），之和须为 10000。整除余数转 Owner。",
          fields: [
            ["feeRecipients", "收费地址，逗号分隔", round.feeRecipient],
            ["feeShareBps", "分成基点（整百分点×100），逗号分隔", "10000"],
          ],
        },
        {
          name: "recoverBnb",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "recoverBnb(uint256)",
          summary: "测试救援。把卡在本期的 BNB 转给当前 Owner。募集/待执行只可转出超过 raisedBnb 的多余余额；挖矿中还可转出剩余 raisedBnb。",
          fields: [["amountWei", "数量（wei）", "0"]],
        },
        {
          name: "recoverTransistors",
          kind: "write",
          caller: "仅 Factory Owner",
          signature: "recoverTransistors(address,uint256,uint256)",
          summary: "测试救援。把卡在本期的晶体管转给当前 Owner。挂单中（listed）或待流片（ready）不可转。NAND 的 id 为 0，LATCH 为 1。",
          fields: [
            ["token", "晶体管合约", "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087"],
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
      id: "upstream",
      name: "上游合约",
      address: "由本期合约调用",
      methods: [
        {
          name: "placeBid / cancelBid",
          kind: "internal",
          caller: "仅本期合约",
          signature: "placeBid(address,uint8,uint96,uint256) payable / cancelBid(uint256)",
          summary: "晶体管铸造已结束。placeTransistorOrder 向材料市场挂买单并托管 BNB；cancelTransistorOrder 撤销未成交买单。成交由卖方 fillBid，不经过 mint。",
          fields: [],
        },
        {
          name: "start / claim",
          kind: "internal",
          caller: "仅本期合约",
          signature: "PoD.start / PoD.claim",
          summary: `挖矿合约 ${shortAddress(podAddr)}。OfficialPodAdapter 把 IPoD 转成官方 start/claim。execute 前当期须是电路 NFT owner；证明用 encode-start-data / 页面表单打包。站外 arm、commitDesign 仍在 PoD 侧完成。`,
          fields: [],
        },
      ],
    },
  ];
}

export function ContractCalls({ round, book, connected, wallet, pending, onInvoke, actor, quote, chainMode = false, embedded = false }) {
  const catalog = useMemo(() => contractCatalog(round), [round]);
  const [selected, setSelected] = useState("campaign.scene");
  const [args, setArgs] = useState({});
  const [result, setResult] = useState(null);
  const [logs, setLogs] = useState(() => (chainMode ? [] : seedCalls(round)));
  const [reading, setReading] = useState(false);
  const method = findMethod(catalog, selected);
  const gate = method ? callGate(method, book, round, connected, actor) : { ok: false, reason: "未选择函数" };
  const fields = method ? method.fields.map(([key, label, fallback]) => [key, label, args[key] ?? String(fallback)]) : [];

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
                  <input value={value} onChange={(event) => setArgs((current) => ({ ...current, [key]: event.target.value }))} />
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
    return { ok: true, reason: "测试救援：把卡住的 BNB 转给当前 Owner。募集中不能动认筹本金。" };
  }
  if (method.name === "recoverTransistors") {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可以把晶体管转给自己。" };
    if (book.phase === "listed") return { ok: false, reason: "挂单中不能转出晶体管，先撤单或等流片。" };
    if (book.phase === "ready") return { ok: false, reason: "待流片不能转出晶体管，流片完成后再转。" };
    return { ok: true, reason: "测试救援：把卡住的晶体管转给当前 Owner。" };
  }
  if (
    method.name === "setPod" || method.name === "setBem" || method.name === "setMinter"
    || method.name === "setFeeShares"
    || method.name === "transferOwnership"
    || method.name === "setFactoryPod" || method.name === "setFactoryBem"
    || method.name === "setFactoryMinter" || method.name === "setFactoryOwner"
  ) {
    if (!connected) return { ok: false, reason: "需要连接 Owner 钱包。" };
    if (actor.role !== "owner") return { ok: false, reason: "仅 Owner 可更换外部依赖或转让所有权。" };
    return { ok: true, reason: "写入新地址后立即生效（工厂项仅影响后续新开期）。" };
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
    if (!fundingExpired && !executeFailed) {
      if (book.scene === "funding") return { ok: false, reason: "募集尚未结束，不能退款。" };
      if (book.scene === "executing") return { ok: false, reason: "本期尚未判执行失败，不能退款；若执行成功将进入挖矿。" };
      return { ok: false, reason: "只有在「募集超时未售罄」或「流片失败」时才能原路退款。" };
    }
    if (book.mine <= 0) return { ok: false, reason: "当前钱包没有可退款的份额。" };
    return { ok: true, reason: "退款后份额清零，BNB 原路退回认筹地址。" };
  }
  if (method.name === "claim") {
    if (book.scene !== "mining") return { ok: false, reason: "只有挖矿中可以 claim。" };
    if (book.claimable <= 0) return { ok: false, reason: "当前没有可领取的 BEM。" };
    return { ok: true, reason: "" };
  }
  if (method.name === "placeTransistorOrder") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能调用 tapeout.net 挂单逻辑。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要调用 tapeout.net 挂单逻辑。" };
    if (book.executePhase === "ready") return { ok: false, reason: "晶体管已到账，无需再挂单。" };
    if (book.executePhase === "listed") return { ok: false, reason: "已经调用 tapeout.net 挂单逻辑，待成交或取消。" };
    return { ok: true, reason: "填写与 tapeout.net 一致的数量与单价后锁价；进入「挂单中」可取消或确认到账。" };
  }
  if (method.name === "cancelTransistorOrder") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能取消 tapeout.net 晶体管挂单。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态有 tapeout.net 挂单可取消。" };
    if (book.executePhase !== "listed" && book.executePhase !== "ready") {
      return { ok: false, reason: "仅挂单中或已到账（Ready）时可取消/撤回。" };
    }
    return { ok: true, reason: book.executePhase === "ready" ? "撤回后回到待挂单，可重挂或退款。" : "取消后回到待挂单状态。" };
  }
  if (method.name === "confirmTransistors") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能确认 tapeout.net 晶体管成交到账。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要确认 tapeout.net 到账。" };
    if (book.executePhase === "ready") return { ok: false, reason: "晶体管已确认到账，直接执行流片开矿即可。" };
    if (book.executePhase !== "listed") return { ok: false, reason: "请先调用 tapeout.net 挂单逻辑，再确认成交到账。" };
    return { ok: true, reason: "确认后解锁 execute 流片开矿。" };
  }
  if (method.name === "execute") {
    if (book.scene !== "executing") return { ok: false, reason: "只有售罄后的待执行状态可以 execute。" };
    if (book.executePhase && book.executePhase !== "ready") {
      return { ok: false, reason: "晶体管尚未到位，请先由 Owner 调用 tapeout.net 挂单逻辑并确认成交到账后再执行流片。" };
    }
    // F3：execute 不可逆（把全期募集款换成元件并烧掉），权限收紧为仅 Factory Owner
    if (actor.role !== "owner") {
      return { ok: false, reason: "只 Factory Owner 可以执行换币流片（不可逆操作）。" };
    }
    const est = estimateHashpower(round, quote || QUOTE, round.totalShares);
    return { ok: true, reason: `晶体管已到账，可以立即流片。预估 ${est.hashpower.toLocaleString("zh-CN")} H，执行时按锁定报价快照结算（不可逆）。` };
  }
  if (method.name === "openRefund") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 openRefund。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行可以批量退款。" };
    if (book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "请先取消挂单，再 openRefund。" };
    }
    return { ok: true, reason: "将批量原路退回各认筹地址本金。" };
  }
  if (method.name === "setPlan") {
    if (actor.role !== "owner") return { ok: false, reason: "只 Factory Owner 能 setPlan。" };
    if (book.scene === "mining") return { ok: false, reason: "挖矿中不可改计划。" };
    if (book.scene === "executing" && book.executePhase && book.executePhase !== "buying") {
      return { ok: false, reason: "挂单中或已到账时不可改 setPlan。" };
    }
    return { ok: true, reason: "写入预估算力 / capped / 晶体管数。" };
  }
  if (method.name === "harvest") {
    if (book.scene !== "mining") return { ok: false, reason: "只有挖矿中可以 harvest。" };
    const harvest = computeHarvest(round, book);
    const daily = book._chain && book.dailyBem != null ? Number(book.dailyBem) : harvest.dailyBem;
    if (!book._chain && !(daily > 0)) return { ok: false, reason: "当前没有可分发数量（日产为 0），无法 harvest。" };
    return {
      ok: true,
      reason: book._chain
        ? `按 PoD 实收入账（估算日产 ${formatBem(daily)} BEM）；次数不限。测试网 mock 可自动注资 PoD。`
        : `第 ${harvest.rounds + 1} 次，本次可分得 ${formatBem(harvest.userPart)} BEM（次数不限）。`,
    };
  }
  return { ok: false, reason: "未知函数。" };
}

export function readCall(method, args, round, book, wallet, quote = QUOTE) {
  if (method === "scene" || method === "status") return SCENE_COPY[book.scene].badge;
  if (method === "phase" || method === "executePhase") {
    return book.executePhase || "none";
  }
  if (method === "sold") return String(book.sold);
  if (method === "sharePriceBnb") return `${round.sharePriceBnb} BNB`;
  if (method === "totalShares") return String(round.totalShares);
  if (method === "hashpower") {
    // 未执行时实际算力未知，只能给预估值
    return book.hashpower > 0
      ? `${book.hashpower.toLocaleString("zh-CN")} H`
      : `预估 ${estimateHashpower(round, quote, round.totalShares).hashpower.toLocaleString("zh-CN")} H（未执行，实际未知）`;
  }
  if (method === "estHashpower") return `${estimateHashpower(round, quote, round.totalShares).hashpower.toLocaleString("zh-CN")} H`;
  if (method === "dailyBem") {
    if (book._chain && book.dailyBem != null) return `${formatBem(book.dailyBem)} BEM`;
    return `${formatBem(book.hashpower > 0 ? bemRate(book.hashpower) : estimateHashpower(round, quote, round.totalShares).dailyBem)} BEM`;
  }
  if (method === "harvestCount") {
    const h = computeHarvest(round, book);
    // 只报已领次数，不暴露任何总次数上限——领取次数不限，只要还在出矿即可领取
    return `${book.harvestCount || 0} 次已领（次数不限）`;
  }
  if (method === "feeBps") return `${(round.feeBps / 100).toFixed(2)}%`;
  if (method === "totalDistributed") return `${formatBem(book.distributed || 0)} BEM`;
  const account = String(args.account || "").toLowerCase();
  const rows = buildHolders(book.sold, book.mine);
  const row = rows.find((item) => item.address.toLowerCase() === account);
  if (method === "sharesOf") {
    if (book._chain && account && String(book.selfAddress || "").toLowerCase() === account) {
      return `${book.mine || 0} 份`;
    }
    return row ? `${row.shares} 份` : "0 份";
  }
  if (method === "pendingBem") {
    if (book._chain && account && String(book.selfAddress || "").toLowerCase() === account) {
      return `${formatBem(book.claimable || 0)} BEM`;
    }
    const amount = computeHarvest(round, book, account).pending;
    return `${formatBem(amount)} BEM`;
  }
  return "";
}

export function validateCreate(args) {
  const recipients = String(args.feeRecipients || args.feeRecipient || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bps = String(args.feeShareBps || "10000")
    .split(",")
    .map((s) => Math.round(Number(s.trim())))
    .filter((n) => Number.isFinite(n));
  const feeShares =
    recipients.length > 0
      ? recipients.map((address, i) => ({
          address,
          shareBps: bps[i] ?? (recipients.length === 1 ? 10_000 : 0),
        }))
      : undefined;
  return reviewRound({
    sharePriceBnb: args.sharePriceBnb,
    totalShares: args.totalShares,
    feePercent: args.feePercent,
    processor: args.processor || "TapeOut",
    feeRecipient: recipients[0] || args.feeRecipient,
    feeShares,
  });
}
