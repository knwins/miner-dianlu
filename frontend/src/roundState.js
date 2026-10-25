/**
 * 流程状态 / 子状态的**唯一词表**。
 *
 * 为什么单独成模块：状态词原来散在 8 个地方各写一套，同一个子状态最多有四种写法
 * （补不补买入动作、加不加「· 待入池」后缀、要不要空格，各写各的），
 * 同一个页面上下两处描述同一件事、措辞还不一样。改一次要翻 8 个文件，
 * 漏一个就出现「自相矛盾的两句话」。
 *
 * 现在：**任何地方要打印状态词，都从这里取，不写字面量**。
 * `scripts/probe-state-copy.mjs` 会静态检查 App.jsx / Owner.jsx 里不再出现这些字面量。
 *
 * 三层语义，互不重叠 —— 每一层只回答一个问题：
 *
 *   ┌─ 阶段 stage ── 本期走到哪一步？        募集中 / 待执行 / 挖矿中 / 执行失败 / 已结束
 *   ├─ 子状态 phase ─ 待执行里具体卡在哪？    待挂单 / 挂单中 / 已到账
 *   └─ 认购 deal ─── 认筹这一层达成了吗？    认购中 / 已售罄（已结束/挖矿中不显示，见 dealStatus.js）
 *
 * 渲染原则（避免重复表述）：**同一句话在同一个视图里只出现一次**。
 *  - 期次标题行：期号 + 阶段徽标（不再在期号后面重复阶段词）
 *  - 生命周期条：阶段 + 当前阶段的子状态（页面上唯一一处子状态）
 *  - 数据行 / 表格：只放数字，不放状态词
 *  - 卡片副文案：放「下一步」或「原因」，不放已经说过的状态词
 */

/** 大状态（链上 scene 只有这三段）。 */
export const SCENE = {
  funding: { key: "funding", label: "募集中", tone: "live" },
  executing: { key: "executing", label: "待执行", tone: "wait" },
  mining: { key: "mining", label: "挖矿中", tone: "mine" },
};

/** 终态：合约不改 scene，靠 executionFailed / 募集截止推出来。 */
export const ENDED = { key: "ended", label: "已结束", tone: "done" };

/** 执行已判失败但还有人没退（不是终态，还能退款）。 */
export const FAILED = { key: "failed", label: "执行失败", tone: "back" };

/**
 * 待执行下的子状态。
 *  label    状态词本身（表格、子状态行用）
 *  sub      下一步（当同一屏别处已经说过「到账」时用，避免重复）
 *  full     状态 + 下一步（只在生命周期条用）
 */
export const PHASE = {
  buying: { key: "buying", label: "待挂单", sub: "待挂单", full: "待挂单" },
  listed: { key: "listed", label: "挂单中", sub: "挂单中", full: "挂单中" },
  ready: { key: "ready", label: "已到账", sub: "待入池", full: "已到账 · 待入池" },
};

/** 链上 phase 是数字 1/2/3，前端 book.executePhase 是字符串。两种都要吃得下。 */
const PHASE_BY_NUM = { 1: "buying", 2: "listed", 3: "ready" };
const SCENE_BY_NUM = { 0: "funding", 1: "executing", 2: "mining" };

/** `config.js` 的数组口径（按链上枚举下标取值）也走这里，别再各写一份。 */
export const SCENE_LABEL = [SCENE.funding.label, SCENE.executing.label, SCENE.mining.label];
export const PHASE_LABEL = ["—", PHASE.buying.label, PHASE.listed.label, PHASE.ready.full];

export function sceneKeyOf(row) {
  if (typeof row?.scene === "number") return SCENE_BY_NUM[row.scene] || "";
  return SCENE[row?.scene] ? row.scene : "";
}

export function phaseKeyOf(row) {
  const raw = row?.executePhase != null ? row.executePhase : row?.phase;
  if (typeof raw === "number") return PHASE_BY_NUM[raw] || "buying";
  if (raw == null || raw === "") return "buying";
  return PHASE[raw] ? raw : "buying";
}

export const phaseOf = (row) => PHASE[phaseKeyOf(row)];

/** 「已售未退」份数：退款会让它变小，sold 不会。 */
export function outstandingOf(row) {
  const v = row?.outstandingShares;
  return v == null ? Number(row?.sold || 0) : Number(v);
}

function endsAtOf(row) {
  if (row?.endsAt != null) return Number(row.endsAt) || 0;
  if (row?.fundingDeadline) return Number(row.fundingDeadline) * 1000;
  return 0;
}

/**
 * 阶段判定。顺序即优先级 —— 终态优先于执行失败，执行失败优先于 scene。
 *
 * @param {object} row   book（字符串 scene）或链上期次摘要行（数字 scene）
 * @param {number} [now] 毫秒，便于测试
 */
export function roundState(row, now = Date.now()) {
  const sceneKey = sceneKeyOf(row);
  const scene = SCENE[sceneKey] || null;
  const outstanding = outstandingOf(row);
  const failed = Boolean(row?.executionFailed);
  const sold = Number(row?.sold || 0);
  const total = Number(row?.totalShares || 0);
  const endsAt = endsAtOf(row);
  const phase = PHASE[phaseKeyOf(row)];

  if (sceneKey === "funding" && endsAt > 0 && now > endsAt && sold < total) {
    return {
      ...ENDED,
      sceneKey,
      failed: false,
      reason: "已流标 · 认筹款可原路退回",
      phase,
      phaseKey: "",
    };
  }
  if (sceneKey === "executing" && failed && outstanding === 0) {
    return {
      ...ENDED,
      sceneKey,
      failed: true,
      reason: "执行失败 · 认筹款已全部退回",
      phase,
      phaseKey: "",
    };
  }
  if (failed) {
    return {
      ...FAILED,
      sceneKey,
      failed: true,
      reason: "本金未支出 · 可全额退",
      phase,
      phaseKey: phase.key,
    };
  }
  return {
    ...(scene || ENDED),
    sceneKey,
    failed: false,
    reason: "",
    phase,
    phaseKey: sceneKey === "executing" ? phase.key : "",
  };
}

/**
 * 列表行 / 卡片要显示的三段文字，保证三段各不相同、不互相复述：
 *
 *   stage     阶段词（已结束 / 执行失败 / 募集中 / 待执行 / 挖矿中）
 *   deal      认购徽标（认购中 / 已售罄 / 空）
 *   substate  当前卡点或原因（待挂单 / 挂单中 / 已到账 · 待入池 / 原因）
 */
export function rowState(row, nowSec = Math.floor(Date.now() / 1000), dealOf) {
  const state = roundState(row, nowSec * 1000);
  const price = Number(row?.sharePriceBnb || 0);
  const raised = Number(row?.raisedBnb ?? row?.bnbPool ?? 0);
  const need = outstandingOf(row) * price;
  // 与合约 refund() 的 short 口径一致：只有「待挂单」池子 cover 不住全部份额才叫缺口。
  // 已挂单 / 已到账时池子变小是买晶体管花掉的，不是缺口。
  const short = state.sceneKey === "executing"
    && state.phaseKey === "buying"
    && need > 0
    && raised < need;

  let substate = "";
  if (state.key === "ended") {
    substate = state.reason;
  } else if (state.key === "failed") {
    substate = short ? "池子不足 · 按比例退" : state.reason;
  } else if (state.sceneKey === "executing") {
    substate = short ? "池子不足 · 按比例退" : state.phase.full;
  } else if (state.sceneKey === "mining") {
    substate = "晶体管已入池 · 不可逆";
  }

  return {
    ...state,
    short,
    substate,
    /**
     * 同屏别处已经说过「到账」时用（Owner 卡片 hero 就是「成交晶体管已到账」），
     * 这里只留下一步，不再重复「已到账」。
     */
    substateCompact: state.phaseKey === "ready" ? state.phase.sub : substate,
    deal: dealOf ? dealOf(row) : null,
  };
}

/** 期次卡脚注的「下一步」。按阶段给一句，不和卡片上的状态词重复。 */
export function nextActionOf(row) {
  const state = roundState(row);
  if (state.key === "ended") return "查看退款记录";
  if (state.key === "failed") return "原路退款 / 降价重挂";
  if (state.sceneKey === "funding") return "补 setPlan / 等待售罄";
  if (state.sceneKey === "executing") {
    if (state.phaseKey === "listed") return "等成交 → 确认到账 → 入池";
    if (state.phaseKey === "ready") return "退余款 → 入池";
    return "挂单 → 确认到账 → 入池";
  }
  if (state.sceneKey === "mining") return "份额转让";
  return "查看详情";
}
