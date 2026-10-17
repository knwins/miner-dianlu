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
  executeUnlockIn,
  formatBem,
  formatClock,
  formatUsdt,
  reviewRound,
  seedCalls,
  shortAddress,
} from "./fixtures.js";

const FACTORY = "0xF4c7000000000000000000000000000000000F4c";
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";

export function contractCatalog(round) {
  return [
    {
      id: "factory",
      name: "CampaignFactory",
      address: FACTORY,
      methods: [
        {
          name: "createCampaign",
          kind: "write",
          caller: "工厂 Owner",
          signature: "createCampaign(uint256,uint256,uint256,uint256,address,uint256,address,uint256,bytes32)",
          summary: "创建一期。参数写入后不能改。",
          fields: [
            ["sharePriceBnb", "每份 BNB", round.sharePriceBnb],
            ["totalShares", "总份数", round.totalShares],
            ["feePercent", "服务费 %", round.feeBps / 100],
            ["fundingDays", "募集天数", round.fundingDays],
            ["taskId", "官方题目", round.taskId],
            ["feeRecipient", "收费地址", round.feeRecipient],
          ],
        },
      ],
    },
    {
      id: "campaign",
      name: "Campaign",
      address: round.contract,
      methods: [
        { name: "status", kind: "read", caller: "任何人", signature: "status() view", summary: "当前状态。", fields: [] },
        { name: "sold", kind: "read", caller: "任何人", signature: "sold() view", summary: "已售份数。", fields: [] },
        { name: "sharePriceBnb", kind: "read", caller: "任何人", signature: "sharePriceBnb() view", summary: "每份价格（BNB）。", fields: [] },
        { name: "totalShares", kind: "read", caller: "任何人", signature: "totalShares() view", summary: "总份数。", fields: [] },
        { name: "hashpower", kind: "read", caller: "任何人", signature: "hashpower() view", summary: "实际算力。未执行时为 0。", fields: [] },
        { name: "estHashpower", kind: "read", caller: "任何人", signature: "estimateHashpower() view", summary: "按当前报价的预估算力，随晶体管价格变动。", fields: [] },
        { name: "dailyBem", kind: "read", caller: "任何人", signature: "dailyBem() view", summary: "当前日产 BEM，由实际算力换算。", fields: [] },
        { name: "harvestCount", kind: "read", caller: "任何人", signature: "harvestCount() view", summary: "已领取次数与剩余可领次数。", fields: [] },
        { name: "feeBps", kind: "read", caller: "任何人", signature: "feeBps() view", summary: "服务费基点。", fields: [] },
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
          name: "buy",
          kind: "write",
          caller: "用户",
          signature: "buy(uint256)",
          summary: "按整数份扣 BNB。只在募集中、且不超过剩余份数时成功。",
          fields: [["shares", "份数", "1"]],
        },
        { name: "listShares", kind: "write", caller: "持份用户 / Owner", signature: "listShares(uint256,uint256)", summary: "在份额转让市场发布出售挂单：第 1 参份数、第 2 参每份 BNB 单价。挂出份额立即锁定，不能领取或转让，直到卖出或撤单。这是持份用户在挖矿中转出份额的唯一途径。", fields: [["shares", "份数", "3"], ["priceBnbPerShare", "每份 BNB", round.sharePriceBnb.toFixed(4)]] },
        { name: "cancelListing", kind: "write", caller: "挂单方 / Owner", signature: "cancelListing(uint256)", summary: "撤销自己发布的挂单，释放锁定份额回到可用余额。", fields: [["listingId", "挂单 ID", "L1"]] },
        { name: "takeListing", kind: "write", caller: "任一持份用户", signature: "takeListing(uint256,uint256)", summary: "按发布价接收（买入）挂单：第 1 参挂单 ID、第 2 参接收份数。份额过户到买方，BNB 支付给卖方。不能接收自己的挂单。", fields: [["listingId", "挂单 ID", "L1"], ["shares", "份数", "1"]] },
        { name: "refund", kind: "write", caller: "持份用户 / Owner", signature: "refund()", summary: "两种本金返还：① 募集超过截止时间仍未售罄；② 流片执行失败（元件暴涨买不起，本金尚未支出）。两种情况下都把认购的 BNB 原路退还给认购地址，份额清零。与挖矿中的份额转让无关。", fields: [] },
        { name: "claim", kind: "write", caller: "用户", signature: "claim()", summary: "领取已入账的 BEM。", fields: [] },
        {
          name: "execute",
          kind: "write",
          caller: "仅工厂 Owner",
          signature: "execute(bytes,bytes)",
          summary: `售罄满 ${ROUND.executeDelayHours} 小时后，仅工厂 Owner 可触发（不可逆：把全期募集款换成元件并烧掉）。按**锁定报价快照**结算，避免被抢跑/抬价。实际算力低于下限则判本期失败并全额退款。网表必须匹配开期时的哈希。晶体管须已由 Owner 调用 tapeout.net 挂单逻辑并确认成交到账（executePhase=ready）。`,
          fields: [
            ["tapeoutData", "流片数据", "0xnetlist"],
            ["startData", "开矿数据", "0xstart"],
          ],
        },
        {
          name: "confirmTransistors",
          kind: "write",
          caller: "仅工厂 Owner",
          signature: "confirmTransistors()",
          summary: "Owner 确认已调用 tapeout.net 挂单逻辑买入的晶体管成交并到账，解锁 execute 流片开矿。须先 placeTransistorOrder 进入挂单中，再调用本函数确认到账；合约无法替人工操作 tapeout.net，由 Owner 手动发起链上交易完成。",
          fields: [],
        },
        {
          name: "placeTransistorOrder",
          kind: "write",
          caller: "仅工厂 Owner",
          signature: "placeTransistorOrder()",
          summary: "Owner 手动调用 tapeout.net 挂单逻辑，为本期买入所需晶体管（链上交易）。挂单后进入「挂单中」，可 cancelTransistorOrder 取消，或成交后 confirmTransistors 确认到账。合约无法替人工操作 tapeout.net，由 Owner 手动发起链上交易完成。",
          fields: [],
        },
        {
          name: "cancelTransistorOrder",
          kind: "write",
          caller: "仅工厂 Owner",
          signature: "cancelTransistorOrder()",
          summary: "取消正在进行的 tapeout.net 晶体管挂单，回到待挂单状态。仅工厂 Owner，且仅当处于「挂单中」时有效。",
          fields: [],
        },
        { name: "harvest", kind: "write", caller: "任何人", signature: "harvest()", summary: "领取 BEM，先扣服务费，再按份入账。", fields: [] },
      ],
    },
    {
      id: "upstream",
      name: "上游合约",
      address: "由本期合约调用",
      methods: [
        {
          name: "swapExactTokensForETH",
          kind: "internal",
          caller: "仅本期合约",
          signature: "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
          summary: `Pancake 路由 ${shortAddress(ROUTER)}。用户按份数支付 BNB，本合约直接买入元件，不经换币路由。`,
          fields: [],
        },
        {
          name: "mint",
          kind: "internal",
          caller: "仅本期合约",
          signature: "mint(uint256) payable",
          summary: "只允许开期时写死的处理器铸造晶体管。",
          fields: [],
        },
        {
          name: "tapeOut",
          kind: "internal",
          caller: "仅本期合约",
          signature: "tapeOut(bytes)",
          summary: "流片数据必须等于开期承诺的网表哈希。",
          fields: [],
        },
        {
          name: "arm / start / claim",
          kind: "internal",
          caller: "仅本期合约",
          signature: "PoD.arm / start / claim",
          summary: `挖矿合约 ${shortAddress(POD)}。管理页不能绕过本期合约直接领取到别的地址。`,
          fields: [],
        },
      ],
    },
  ];
}

export function ContractCalls({ round, book, connected, wallet, pending, onInvoke, actor, quote }) {
  const catalog = useMemo(() => contractCatalog(round), [round]);
  const [selected, setSelected] = useState("campaign.status");
  const [args, setArgs] = useState({});
  const [result, setResult] = useState(null);
  const [logs, setLogs] = useState(() => seedCalls(round));
  const method = findMethod(catalog, selected);
  const gate = method ? callGate(method, book, round, connected, actor) : { ok: false, reason: "未选择函数" };
  const fields = method ? method.fields.map(([key, label, fallback]) => [key, label, args[key] ?? String(fallback)]) : [];

  function choose(id) {
    setSelected(id);
    setArgs({});
    setResult(null);
  }

  function submit(event) {
    event.preventDefault();
    if (!method || !gate.ok) return;
    const payload = Object.fromEntries(fields.map(([key, , value]) => [key, value]));
    const outcome = onInvoke(method.name, payload);
    setResult(outcome);
    setLogs((current) => [{ time: Date.now(), method: method.name, ok: outcome.ok, message: outcome.message }, ...current]);
  }

  return (
    <section>
      <header className="page-header">
        <div>
          <h1>合约调用</h1>
          <p className="page-subtitle">从这里读取和发送本期会用到的函数。上游合约只能由本期合约内部调用。</p>
        </div>
      </header>

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
            <button className="btn btn-primary" type="submit" disabled={!gate.ok || Boolean(pending)}>
              {pending || (method?.kind === "read" ? "读取" : "发送交易")}
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
  if (method.name === "createCampaign") return { ok: true, reason: "" };
  if (method.name === "buy") {
    if (!connected) return { ok: false, reason: "buy 需要已连接的用户钱包。" };
    if (book.scene !== "funding") return { ok: false, reason: "只有募集中可以 buy。" };
    if (book.sold >= round.totalShares) return { ok: false, reason: "份数已售完。" };
    return { ok: true, reason: "" };
  }
  if (method.name === "listShares") {
    if (book.scene !== "mining") return { ok: false, reason: "只有在挖矿中才能进行份额转让。" };
    if (book.mine <= 0) return { ok: false, reason: "当前钱包没有可用份额可挂牌。" };
    if (actor.role !== "owner" && actor.shares <= 0) {
      return { ok: false, reason: "只有持份用户或工厂 Owner 可以发布出售。" };
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
    return { ok: true, reason: "退款后份额清零，BNB 原路退回认购地址。" };
  }
  if (method.name === "claim") {
    if (book.scene !== "mining") return { ok: false, reason: "只有挖矿中可以 claim。" };
    if (book.claimable <= 0) return { ok: false, reason: "当前没有可领取的 BEM。" };
    return { ok: true, reason: "" };
  }
  if (method.name === "placeTransistorOrder") {
    if (actor.role !== "owner") return { ok: false, reason: "只有工厂 Owner 能调用 tapeout.net 挂单逻辑。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态需要调用 tapeout.net 挂单逻辑。" };
    if (book.executePhase === "ready") return { ok: false, reason: "晶体管已到账，无需再挂单。" };
    if (book.executePhase === "listed") return { ok: false, reason: "已经调用 tapeout.net 挂单逻辑，待成交或取消。" };
    return { ok: true, reason: "调用挂单逻辑后进入「挂单中」，可取消或成交后确认到账。" };
  }
  if (method.name === "cancelTransistorOrder") {
    if (actor.role !== "owner") return { ok: false, reason: "只有工厂 Owner 能取消 tapeout.net 晶体管挂单。" };
    if (book.scene !== "executing") return { ok: false, reason: "只有待执行状态有 tapeout.net 挂单可取消。" };
    if (book.executePhase !== "listed") return { ok: false, reason: "当前没有进行中的 tapeout.net 晶体管挂单。" };
    return { ok: true, reason: "取消后回到待挂单状态。" };
  }
  if (method.name === "confirmTransistors") {
    if (actor.role !== "owner") return { ok: false, reason: "只有工厂 Owner 能确认 tapeout.net 晶体管成交到账。" };
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
    // F3：execute 不可逆（把全期募集款换成元件并烧掉），权限收紧为仅工厂 Owner
    if (actor.role !== "owner") {
      return { ok: false, reason: "只有工厂 Owner 可以执行换币流片（不可逆操作）。" };
    }
    const wait = executeUnlockIn(round, book);
    if (wait > 0) {
      return { ok: false, reason: `观察期未满，还要等 ${Math.ceil(wait / 3600_000)} 小时（售罄后 ${round.executeDelayHours} 小时内不可执行）。` };
    }
    const est = estimateHashpower(round, quote || QUOTE, round.totalShares);
    return { ok: true, reason: `观察期已满。晶体管已到账。预估 ${est.hashpower.toLocaleString("zh-CN")} H，执行时按**锁定报价快照**结算（不可逆）。` };
  }
  if (method.name === "harvest") {
    if (book.scene !== "mining") return { ok: false, reason: "只有挖矿中可以 harvest。" };
    const harvest = computeHarvest(round, book);
    // 领取次数不设上限，只要还在出矿（userPart > 0）即可领取
    if (harvest.userPart <= 0) return { ok: false, reason: "当前没有出矿，暂无可领取的 BEM。" };
    return { ok: true, reason: `第 ${harvest.rounds + 1} 次，本次可分得 ${harvest.userPart} BEM（次数不限）。` };
  }
  return { ok: false, reason: "未知函数。" };
}

export function readCall(method, args, round, book, wallet, quote = QUOTE) {
  if (method === "status") return SCENE_COPY[book.scene].badge;
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
  if (method === "dailyBem") return `${formatBem(book.hashpower > 0 ? bemRate(book.hashpower) : estimateHashpower(round, quote, round.totalShares).dailyBem)} BEM`;
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
  if (method === "sharesOf") return row ? `${row.shares} 份` : "0 份";
  if (method === "pendingBem") {
    // F1：收益账本按持有人隔离，按传入地址各自算 pending，不再用一份全局池冒充
    const amount = computeHarvest(round, book, account).pending;
    return `${formatBem(amount)} BEM`;
  }
  return "";
}

export function validateCreate(args) {
  return reviewRound({
    sharePriceBnb: args.sharePriceBnb,
    totalShares: args.totalShares,
    feePercent: args.feePercent,
    processor: args.processor || "TapeOut",
    feeRecipient: args.feeRecipient,
  });
}
