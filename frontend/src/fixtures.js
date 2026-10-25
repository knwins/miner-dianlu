import {
  NETWORK_WEIGHT,
  poolDailyYield,
} from "./emission.js";
import { SCENE } from "./roundState.js";

import {
  DEFAULT_CIRCUIT,
  NOMINAL_QUOTE,
  NOMINAL_BNB_USDT,
  findCircuit,
  processorScale,
  isMineable,
  planTask,
  circuitIdFor,
  PROCESSOR_IDS,
  suggestPartRange,
} from "./prices.js";

export const WALLET = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

/**
 * 演示用钱包初始 BNB 流动性（仅预览，非真实余额）。
 * 多钱包账本下每个地址都给一份，用于二级转让市场与退款的 BNB 结算演示。
 */
export const DEMO_BNB = 100;

/**
 * 挖矿期投影窗口（天）—— 仅用于 ROI 预估的外推口径，不是领取次数上限。
 *
 * 领取次数**不设上限**：只要本期还在出矿（dailyBem > 0），持份人就可以一直领取，
 * 不存在「90 天/90 次封顶」的终态；挖矿也不设截止日（endsAt）。
 *
 * **界面上不展示这个数**（也不展示任何按它外推的整期累计产出）。
 * 用户关心的是「每次能领多少、是否已出矿」，不是这期要挖多久——
 * 显示出来反而误导：零和机制下全网权重涨了，挖再久日产也会同步下降，
 * 产出与天数并不成正比。
 */
export const MINING_DAYS = 90;

export const ROUND = {
  id: 3,
  /**
   * 每份价格，单位 BNB。
   *
   * 募集直接以 BNB 计价，不再经 USDT 中转：
   * 募资总额 BNB = 份数 × 每份BNB，
   * 而电路成本本来就是 BNB 计价，两者可直接比较，无需换算。
   *
   * 份数在开期时写死，用户只能买整数份。
   */
  sharePriceBnb: 0.685,
  /** 总份数 100 -> 募资总额 68.5 BNB */
  totalShares: 100,
  /**
   * 募资总额（BNB）：本期的权威发行规模。
   * 由「每份 BNB × 总份数」推导而来（0.685 × 100 = 68.5），
   * 这里显式存一份，避免下游再用 sharePriceBnb × totalShares 重算（新模型下每份由募资总额派生）。
   */
  hardCapBnb: 68.5,
  /**
   * 服务费百分比（1–20）。演示期次的样本值；真实期次一律由开期表单填入，
   * 不设任何代码级默认值——feePercentOf/feeBpsOf 是唯一读取口径。
   *
   * ⚠️ 口径：这是**挖矿产出奖励**的服务费（从挖矿收益里计提），
   * **与认筹款无关** —— 认购人付的 BNB 全额进认购托管池，不收任何服务费。
   */
  feePercent: 5,
  fundingDays: 15,
  /** 挖矿期天数，取自协议常量，不可通过开期参数修改 */
  miningDays: MINING_DAYS,
  /**
   * 售罄到可执行之间的观察期（小时）。
   * 换币流片会把全部募集款换成 BNB 并烧掉电路，不可逆。
   * 给用户这段时间核对网表哈希与报价快照。
   */
  executeDelayHours: 48,
  /** 挖矿用电路组合（处理器 × 电路），见 prices.js 的 CIRCUITS */
  circuitModelId: DEFAULT_CIRCUIT,
  /**
   * 本期要烧的电路总数，即链上 buyCircuits 买入的张数。
   *
   * 电路数由本期募资总额按理想成本占比派生，不由人工填写，
   * 权重 H = 电路数 × 处理器每张算力（默认 Behemoth P=6 → 68 × 6 = 408）。
   * 68 是基准期次规模下的示例值，实际开期一律由当期募资总额反推。
   */
  partCount: 68,
  contract: "0xA11cE9010000000000000000000000000000E901",
  feeRecipient: "0x0000000000000000000000000000000000000fee",
  /** 演示期次的分成样本；比例以百分比整数存，合计须 100 */
  feeShares: [{ address: "0x0000000000000000000000000000000000000fee", sharePercent: 100 }],
};

/**
 * 价格口径。前端不读行情，链上单价是权威来源；
 * 拿不到链上单价时才用 `prices.js` 的静态基准价做测算。
 */

/** BNB → USDT 的固定折算口径，仅用于等值展示，不参与链上计算。 */
export const MARKET = {
  bnbUsdt: NOMINAL_BNB_USDT,
};

/**
 * 静态基准报价。与 `NOMINAL_QUOTE` 是同一个对象——
 * 早期代码把它当成「开期锁定的实时快照」，现在它只是固定常量：
 * 不联网、不轮询、不会自己变。
 */
export const QUOTE = NOMINAL_QUOTE;

export const OWNER = "0x0a11eE0000000000000000000000000000000A11";

/**
 * 角色与权限模型。
 *
 * execute（换币+流片）会把全部募集款换成 BNB 并烧掉电路，**不可逆**，
 * 故权限收紧为**仅 Owner** 可触发——Owner 是实际执行 tape-out 的一方，
 * 持份用户不应能单方面把全期本金烧掉。为防 Owner 不作为，真实合约应再加
 * 时间锁 + 多签/投票兜底；本预览在「48h 观察期 + 价格快照锁定」基础上仅保留 Owner 门槛。
 * 其余写操作（harvest / 份额转让 / 退款）仍对持份用户开放。
 *
 * 退出只通过「份额转让」实现：持份用户把份额挂到转让市场卖给其他持份人，
 * 没有合约统一的退款/结算终态，也没有 exit 赎回操作。
 */
export const ROLE = { USER: "user", HOLDER: "holder", OWNER: "owner" };

/** 调用者身份。shares 是该地址在本期的份数。 */
/**
 * 判定某个地址的身份。
 *
 * 必须真的按传入地址查份数——早期版本直接用 book.mine（当前连接钱包的份数），
 * 会导致任何非 Owner 地址都被当成持份用户，从而获得 execute 权限。
 *
 * @param {string} address 待判定的地址
 * @param {object} book    当前期次状态
 * @param {object} [state] 期次全局持有人名册（可选，用于判断名册外地址）
 */
export function identify(address, book, state = null) {
  const addr = String(address || "").toLowerCase();
  if (addr && addr === OWNER.toLowerCase()) {
    return { role: ROLE.OWNER, label: "Owner", shares: 0, address };
  }
  // 优先用账本：任一地址都可查到自己的可用 + 锁定份额（挂出仍属自己，算持份）
  let shares = 0;
  if (book && book.wallets) {
    const wallet = book.wallets[addr];
    if (wallet) shares = wallet.mine + wallet.listingShares;
  }
  if (shares === 0 && state && Array.isArray(state.holders)) {
    shares = state.holders.find((h) => String(h.address).toLowerCase() === addr)?.shares || 0;
  }
  if (shares === 0 && book && addr && String(book.selfAddress || WALLET).toLowerCase() === addr) {
    shares = book.mine > 0 ? book.mine : 0;
  }
  return {
    role: shares > 0 ? ROLE.HOLDER : ROLE.USER,
    label: shares > 0 ? "持份用户" : "未持份地址",
    shares,
    address,
  };
}

/** 不再设观察期。保留函数是为了旧调用点，始终表示可以立即流片。 */
export function executeUnlockIn() {
  return 0;
}


/** 预览用的场景，用户可在顶栏切换观察各阶段表现。（标签取自 ./roundState.js，不另写一份） */
export const SCENES = [
  { id: "funding", label: SCENE.funding.label },
  { id: "executing", label: SCENE.executing.label },
  { id: "mining", label: SCENE.mining.label },
];

/**
 * 场景文案。
 * 退出只通过「份额转让」实现：持份人把份额挂到转让市场卖给其他持份人，
 * 没有合约统一的退款/结算终态，也没有 exit 赎回操作。
 *
 * 这里只保留**说明性正文**（lead）；badge / tone 一律引用 ./roundState.js。
 * 旧版这里还有一份 badge 表，与 adapter、App、Owner 的表各说各话
 * （例如 mining 的 tone 这里是 done、那边是 mine）。
 */
export const SCENE_COPY = {
  funding: {
    badge: SCENE.funding.label,
    tone: SCENE.funding.tone,
    lead: "本期开放认筹，份额售罄后由 Owner 买入电路并投入矿池。",
  },
  executing: {
    badge: SCENE.executing.label,
    tone: SCENE.executing.tone,
    lead: "份数已售完。Owner 挂单买入电路、确认到账后投入矿池；入池前本金不动，可原路退款或改价重挂。",
  },
  mining: {
    badge: SCENE.mining.label,
    tone: SCENE.mining.tone,
    lead: "电路已入池，本期进入挖矿（不可逆）。分配合约接入前不产出发放；退出只能转让份额。",
  },
};

/**
 * 服务费百分比的唯一读取口径：优先 feePercent，兼容只给了 bps 的老数据。
 * 全程不回落到任何写死的默认值——没有数据就是 0。
 *
 * 口径：服务费**真正上链**（Campaign.serviceFeeBps）。
 * 链上模式由 adapter.roundFromState 从合约读出 feePercent / serviceFeeBps，
 * 这里只做单位换算，不再负责「取值来源」。
 *
 * ⚠️ 这是**挖矿产出奖励**的服务费（depositRevenue 从挖矿收益里计提），
 * **与认筹款无关** —— 认筹款不收服务费。
 */
export function feePercentOf(round) {
  const p = Number(round?.feePercent);
  if (Number.isFinite(p) && p >= 0) return p;
  const bps = Number(round?.feeBps);
  return Number.isFinite(bps) ? bps / 100 : 0;
}

/** 基点口径，供需要 bps 的地方使用（同样由 feePercent 派生） */
export function feeBpsOf(round) {
  return Math.round(feePercentOf(round) * 100);
}

export function feeRate(round) {
  return feePercentOf(round) / 100;
}

/**
 * 电路数派生：按募资总额的理想成本占比反推能买多少张电路。
 * 电路数不再是开期参数，只由规模决定（权重 H = 电路数 × P 仍成立）。
 */
export function derivePartCount({ hardCapBnb, circuitId, snapshot }) {
  const cap = Number(hardCapBnb);
  if (!(Number.isFinite(cap) && cap > 0)) return 1;
  const ideal = suggestPartRange({ hardCapBnb: cap, snapshot, circuitId }).idealParts;
  return Math.max(1, Math.round(Number(ideal)) || 1);
}

/**
 * 权重 -> 日产 BEM。
 * 真实机制是「池日产 × 我的权重占比」，系数由全网总权重决定，会持续变化。
 * 这里保留 bemRate 作为便捷包装，默认按已验证池计算。
 */
export function bemRate(hashpower, opts = {}) {
  const v = poolDailyYield(hashpower, { pool: "verified", ...opts });
  return Math.round(v * 10000) / 10000;
}


/** 四位小数：单价与每权重日产口径（0.0045 这类系数必须保留精度） */
export function round4(value) {
  // 守卫非有限数：Number(Infinity) || 0 仍是 Infinity（Infinity 是 truthy），
  // 之前 hardCapBnb=0 时 costRatio 会算出 Infinity 并显示成 "Infinity%"。
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

/**
 * 五位小数：电路挂单价。挂单允许填 0.00001 BNB 级别，
 * 用四位会把用户输入静默改小，所以输入框与挂单价展示统一走这里。
 */
export function round5(value) {
  return Math.round((Number(value) || 0) * 100000) / 100000;
}

/** 价格输入框的展示值：最多五位小数，去掉浮点尾巴。 */
export function priceText(value) {
  const n = Number(value) || 0;
  return Number.isFinite(n) ? String(Math.round(n * 100000) / 100000) : "";
}

/** 输入过程中限制为最多五位小数（允许空串与末尾小数点）。 */
export function clampPriceInput(raw) {
  const text = String(raw ?? "").replace(/[^\d.]/g, "");
  const dot = text.indexOf(".");
  if (dot < 0) return text;
  return `${text.slice(0, dot + 1)}${text.slice(dot + 1).replace(/\./g, "").slice(0, 5)}`;
}

/**
 * 从链上 / 本地期次字段解析「目标处理器」。
 * - 处理器：新工厂开期写入 circuits（电路合约地址）；旧期次可用 setPlan 的
 *   estHashpower / circuitHeldCount（或执行后 hashpower）反推 P≈H/电路数
 */
export function resolveCampaignDesign(round, book = null) {
  const chain = Boolean(book?._chain);
  // 链上只认合约字段。报价引擎的 estimate、以及 fixtures 里的默认 Behemoth，都不能当成本期处理器。
  const parts = chain
    ? Number(book?.circuitHeldCount) || 0
    : Number(book?.circuitHeldCount) || Number(book?.estimate?.usedParts) || Number(round?.circuitHeldCount) || 0;
  const hp = chain
    ? Number(book?.hashpower) || Number(book?.estHashpower) || 0
    : Number(book?.hashpower) || Number(book?.estHashpower) || Number(book?.estimate?.hashpower) || Number(round?.estHashpower) || 0;

  let processorId = null;
  if (!chain && round?.processorId && PROCESSOR_IDS.includes(round.processorId)) {
    processorId = round.processorId;
  } else if (!chain && round?.circuitModelId) {
    const fromCircuit = findCircuit(round.circuitModelId)?.processor;
    if (fromCircuit && PROCESSOR_IDS.includes(fromCircuit)) processorId = fromCircuit;
  }
  if (!processorId && hp > 0) {
    // 旧期次没记处理器地址：用 H ÷ 电路数反推规模（P≈H/电路数），取标度最接近的处理器。
    // 数据驱动：按标度查表匹配，不会把某个处理器误认成 Behemoth 或 TapeOut。
    if (parts > 0) {
      const scale = hp / parts;
      processorId =
        PROCESSOR_IDS.find((id) => processorScale(id) === scale) ||
        PROCESSOR_IDS.reduce((best, id) =>
          Math.abs(processorScale(id) - scale) < Math.abs(processorScale(best) - scale) ? id : best,
        PROCESSOR_IDS[0]);
    }
  }
  // 开期写入的 circuits → round.processorId（见 adapter.roundFromState）
  if (!processorId && PROCESSOR_IDS.includes(round?.processorId)) {
    processorId = round.processorId;
  }
  if (!processorId && !chain) processorId = PROCESSOR_IDS[0];

  const circuitId = processorId ? circuitIdFor(processorId) : null;
  return {
    processorId,
    processor: processorId,
    processorScale: processorId ? processorScale(processorId) : null,
    circuitModelId: circuitId,
    /** 链上 setPlan / execute 写入了算力，处理器由 H÷电路数反推 */
    processorInferred: chain ? hp > 0 && Boolean(processorId) : hp > 0,
    processorKnown: Boolean(processorId),
    chainHashpower: hp,
    chainParts: parts,
    knownFromChain: hp > 0 || parts > 0,
  };
}

/**
 * 历史期次（展示用）。
 * 数字按真实产出机制反推：`bem = H × 0.004524 × 天数 × 93%`
 * 系数 0.004524 = 7,200 × 99% ÷ 1,575,427（已验证池总权重，链上实读）。
 */
export const PAST_ROUNDS = [
  {
    id: 2,
    status: "已结算",
    tone: "done",
    shares: "100/100",
    raised: "68.5000 BNB",
    circuitModelId: DEFAULT_CIRCUIT,
    quoteMult: 1.5,
    /** 权重 H = g81 × 6 = 486 */
    hashpower: "486",
    bem: "184.0500 BEM",
    fee: "13.8500 BEM",
  },
  {
    id: 1,
    status: "未募满",
    tone: "back",
    shares: "37/100",
    raised: "25.3450 BNB",
    hashpower: "—",
    bem: "已退回",
    fee: "—",
  },
];


/**
 * 募集期的预估分配权重。
 *
 * 权重只由「本期烧多少电路」决定：
 *   募资总额 BNB → ÷ 电路实时单价 → 能买多少电路；H = 电路数 × P
 *
 * 电路数由本期募资总额派生（round.partCount），开期后不可改，所以权重是确定的。
 * 实际入池数量以 Owner 在电路市场买入并确认到账的电路为准（买多少算多少），
 * 不再推算「需要几个」「募资总额够买几个」。
 *
 * 报价来自实时价格源（`prices.js`），同一期在不同时刻结果不同。
 * execute 之后 book.hashpower 才是实际值。
 */
export function estimateHashpower(round, quote = QUOTE, sold = null) {
  const shares = sold === null ? round.totalShares : sold;
  // 募集以 BNB 计价，募资总额直接是 BNB，不需要 BNB 价换算
  const hardCapBnb = shares * round.sharePriceBnb;
  const bnbUsdt = quote.bnbUsdt || MARKET.bnbUsdt;

  /**
   * 选电路型号：优先用期次上直接记的 circuitModelId；
   * 否则按 processorId 查该处理器的代表型号。
   *
   * ⚠️ 必须查表，不能写成 `processorId === "TapeOut" ? ... : "BEHEMOTH"`：
   * 那种二元写法在处理器数量变化后会让新处理器落到 Behemoth 的型号上
   * （电路价差可达数千倍），且 processorScale 取错，算出「有产出」的假象。
   */
  const chosenCircuitModel =
    round.circuitModelId ||
    (round.processorId && PROCESSOR_IDS.includes(round.processorId)
      ? circuitIdFor(round.processorId)
      : "");
  const model = findCircuit(chosenCircuitModel || DEFAULT_CIRCUIT);
  const priceBnb = quote.prices?.[model.id] ?? model.priceBnb;
  const P = processorScale(model.processor);

  // 本期电路数：由募资总额反推，缺省按 1 个兜底
  const actual = planTask({
    parts: round.partCount ?? 1,
    circuitId: model.id,
    snapshot: quote,
  });

  // 电路数由募资总额反推，成本 = 电路数 × 报价（采购价随市场浮动，不反推需求）
  const usedParts = actual.totalParts;
  const needBnb = actual.partsCost;

  const dailyBem = bemRate(actual.hashpower || 0);

  return {
    shares,
    /** 募资总额（BNB）——募集与流片成本同为 BNB，可直接相比 */
    hardCapBnb: round4(hardCapBnb),
    hardCap: round4(hardCapBnb),
    /** 仅供需要 USDT 折算时参考（如 ROI 展示），不影响业务计算 */
    bnbUsdt,
    hardCapUsdt: round4(hardCapBnb * bnbUsdt),
    circuitModelId: model.id,
    circuitName: model.name,
    processor: chosenCircuitModel ? model.processor : null,
    processorScale: chosenCircuitModel ? P : null,
    partType: "CIRCUIT",
    priceBnb,
    /** 本期电路数 —— 由募资总额反推 */
    usedParts,
    hashpower: actual.hashpower || 0,
    /**
     * 挖矿闸门：面积超抽检上限则只能进未验证池（分 1%）。
     * createScene 靠它决定 pool 归属，缺了会让超限期次按已验证池算收益，必须带上。
     */
    capped: actual.capped === true,
    /** 预估采购成本（BNB）= 电路数 × 报价 */
    needBnb: round4(needBnb),
    dailyBem,
    totalNet: round4(dailyBem * round.miningDays * (1 - feeRate(round))),
    quote,
  };
}


/** 预览用合约地址：保证是合法 hex 长度，不是真实部署地址。 */
export function previewAddress(id) {
  return `0x${Number(id).toString(16).padStart(40, "0")}`;
}

/**
 * 单次 harvest 的全部中间量。
 * gross 用 dailyBem（即「日产」），所以「日产」和「每次 harvest 产出」永远是同一个口径。
 *
 * 领取次数**不设上限**：只要本期还在出矿（dailyBem > 0），持份人就可以一直领取，
 * 不存在「90 天/90 次封顶」的终态。miningDays 只作为 ROI 预估的投影窗口，不再约束领取。
 *
 * 累计量一律用未舍入的 dailyBem/feeRate 重算，不累加已舍入的中间值，
 * 否则多轮 harvest 的舍入误差会累积。
 */
export function computeHarvest(round, book, address = book.selfAddress, network = null) {
  /**
   * 真实机制：日产 = 池日产 × 我的权重占比，不是权重 × 固定系数。
   *
   * 这里始终按 book.hashpower 重算，不读 book.dailyBem 缓存——
   * 否则改了权重（日产随之变化）而缓存没同步，UI 会显示过期数字。
   * execute 后的实际权重已写进 book.hashpower，重算结果就是正确的实际日产。
   *
   * 收益账本**按持有人隔离**（修复 F1）：每个地址独立记 claimed，pending =
   * accruedNet(该地址) − claimed(该地址)。份额转让时 pending 随 mine 自动过户，
   * 不再有「A 的产出被 B 领走」「转让不带收益」这类错配。
   */
  const addr = String(address || book.selfAddress || WALLET).toLowerCase();
  const wallet = book.wallets?.[addr] || { mine: 0, listingShares: 0, claimed: 0 };
  const dailyBem = bemRate(book.hashpower, {
    pool: book.capped ? "unverified" : "verified",
    networkWeight: network,
  });
  const rate = feeRate(round);
  const rounds = book.harvestCount || 0;
  const maxRounds = Infinity;
  const share = round.totalShares > 0 ? wallet.mine / round.totalShares : 0;
  // 逐日复利式累加会漂移，用精确乘法 + 末尾舍入
  const grossTo = (n) => dailyBem * n;
  const accrueNetFor = (mine) => round4(grossTo(rounds) * (1 - rate) * (round.totalShares > 0 ? mine / round.totalShares : 0));
  const claimed = wallet.claimed || 0;
  const pending = Math.max(0, round4(accrueNetFor(wallet.mine) - claimed));
  return {
    dailyBem: round4(dailyBem),
    // gross 与 dailyBem 同精度：日产精确到 4 位小数
    gross: round4(dailyBem),
    fee: round4(dailyBem * rate),
    net: round4(dailyBem * (1 - rate)),
    share,
    userPart: round4(dailyBem * (1 - rate) * share),
    rounds,
    maxRounds,
    remaining: Infinity,
    exhausted: false,
    /**
     * 领取次数不设上限，因此不存在「整期总产出」的封顶值。
     * totalGross / totalNet 置空；如需量级参考，用 estimate 的 miningDays 投影（UI 须标注为外推预估）。
     */
    totalGross: null,
    totalNet: null,
    /** 累计口径：从 0 重算到第 rounds 次，避免累加舍入误差。 */
    accruedFee: round4(grossTo(rounds) * rate),
    /** 当前地址累计净产出（按本钱包份额计） */
    accruedNet: accrueNetFor(wallet.mine),
    /** 当前地址已领（claimed） */
    claimed,
    /** 当前地址可领（pending） */
    pending,
    /**
     * 风险提示：我的产出占全网的比例。占比越小，别人涌入时受影响越小。
     * poolShare = 我的权重 / 全池权重；dailyShare = 我的日产 / 全网日产。
     */
    poolShare: NETWORK_WEIGHT.verified > 0 ? book.hashpower / NETWORK_WEIGHT.verified : 0,
  };
}

/**
 * 场景种子。harvestCount 是「已领取次数」，
 * claimable = accruedNet × 占比 − claimed，claimed 是用户已手动领走的部分，
 * 所以 claimed + claimable 恒等于 accruedNet × 占比，账目永远守恒。
 *
 * executed 标记本期是否已执行换币流片：
 *   - false（funding / executing）：实际算力未知，界面显示预估值
 *   - true（mining）：实际算力 =按 quoteMult 涨过价的报价算出
 * quoteMult 模拟执行时电路涨价，所以预估值与实际值会不一致。
 */
const SCENE_SEED = {
  // 募集中：22/100 份 = 11,000 USDT
  funding: { sold: 22, mine: 3, harvestCount: 0, claimed: 0, executed: false, circuitId: "—", offset: 0, soldOutAgoHours: null },
  // 售罄 12 小时前 —— 观察期未满，任何人都还不能 execute
  executing: { sold: 100, mine: 13, harvestCount: 0, claimed: 0, executed: false, circuitId: "—", offset: 0, soldOutAgoHours: 12 },
  // 执行时电路涨到 1.5x：权重由实际买入的电路数决定，与报价无关
  mining: { sold: 100, mine: 13, harvestCount: 12, claimedRatio: 0.72, executed: true, quoteMult: 1.5, circuitId: "#58241", offset: 1, soldOutAgoHours: 200 },
};


export function createScene(id, round = ROUND, phase = null, expired = false, execFailed = false) {
  const seed = SCENE_SEED[id] || SCENE_SEED.funding;
  const fundingEnd = Date.now() + (6 * 24 * 60 * 60 + 14 * 60 * 60 + 22 * 60) * 1000;
  // 挖矿不设截止日（领取次数不限）；募集截止仅 funding 生效（演示超时可置为过去）；
  // executing 的 endsAt 不用于展示（倒计时显示「—」），保留 fundingEnd 占位无害。
  const endsAt = id === "mining" ? undefined : (expired && id === "funding" ? Date.now() - 86400_000 : fundingEnd);

  // 预估算力按基准单价；实际权重按执行时成交价（电路涨价不影响权重，只影响买不买得起）
  const est = estimateHashpower(round, QUOTE, seed.sold);
  const model = findCircuit(round.circuitModelId || DEFAULT_CIRCUIT);
  const actualQuote = {
    ...QUOTE,
    prices: { ...QUOTE.prices, [model.id]: QUOTE.prices[model.id] * (seed.quoteMult || 1) },
  };
  const actual = estimateHashpower(round, actualQuote, seed.sold);

  const hashpower = seed.executed ? actual.hashpower : 0;
  const dailyBem = bemRate(hashpower);
  const rate = feeRate(round);
  // 全局日净产出（扣费后），所有持有人共享同一日产系数
  const netPerRound = dailyBem * (1 - rate);
  // 主钱包（WALLET）的累计净产出与已领比例，用于初始化演示数据。
  // 收益账本按持有人隔离（F1）：accruedNetW 是「本钱包」的累计净产出，
  // 必须乘上本钱包份额占比 shareW，否则会与 computeHarvest 的 per-wallet 口径对不上。
  const shareW = round.totalShares > 0 ? seed.mine / round.totalShares : 0;
  const accruedNetW = round4(netPerRound * seed.harvestCount * shareW);
  const walletClaimed = seed.claimedRatio !== undefined ? round4(accruedNetW * seed.claimedRatio) : seed.claimed;

  const wallets = buildWallets(seed, round);
  // 演示：主钱包历史已领比例（其余持有人视为未领）
  const wKey = String(WALLET).toLowerCase();
  if (wallets[wKey]) wallets[wKey] = { ...wallets[wKey], claimed: walletClaimed };

  return {
    scene: id,
    /**
     * 待执行子状态：电路来自电路市场，须由 Owner 钱包发起链上交易去挂单买入并确认到账，
     * 不能指望合约自动去电路市场操作——合约无法替人工下单。
     * buying = 待挂单；listed = 挂单中（可取消）；ready = 电路已到账，待 execute 流片开矿。
     * 其他场景无意义，置 undefined。
     */
    executePhase: id === "executing" ? (phase || seed.executePhase || "buying") : undefined,
    sold: seed.sold,
    mine: seed.mine,
    /** 本期「当前钱包」的地址，identify() 用它判断调用者是否持份 */
    selfAddress: WALLET,
    harvestCount: seed.harvestCount,
    claimed: walletClaimed,
    claimable: round4(accruedNetW - walletClaimed),
    feeBem: round4(dailyBem * rate * seed.harvestCount),
    distributed: round4(netPerRound * seed.harvestCount),
    /** 实际算力。未执行时为 0，界面应改用 estimate.hashpower。 */
    hashpower,
    dailyBem,
    /** 费率基点：供 recomputeSelf 重算各钱包可领量，避免再传 round 依赖 */
    feeBps: feeBpsOf(round),
    /** 总份数：供 recomputeSelf 按钱包份额占比折算 per-wallet 可领量（与 computeHarvest 同口径） */
    totalShares: round.totalShares,
    /**
     * 是否被挖矿闸门拦住（面积超抽检上限）。
     * 被拦住只能进未验证池（分 1%），且拿不到设计溢价。
     */
    capped: Boolean(actual?.capped),
    /** 所在挖矿池：verified 分 99% / unverified 分 1% */
    pool: actual?.capped ? "unverified" : "verified",
    /** 募集期展示的预估值，随报价变化 */
    estimate: est,
    executed: seed.executed,
    /** 售罄时刻，execute 观察期从此刻起算。未售罄为 null。 */
    soldOutAt: seed.soldOutAgoHours === null ? null : Date.now() - seed.soldOutAgoHours * 3600_000,
    /** 执行时锁定的报价与实际算力，仅在已执行场景有值 */
    actualQuote: seed.executed ? actualQuote : null,
    actualHashpower: seed.executed ? actual.hashpower : null,
    circuitId: seed.circuitId,
    endsAt,
    _expiredPreview: Boolean(expired),
    _execFailedPreview: Boolean(execFailed),
    approved: id !== "funding",
    /** 执行失败时置位：本期判失败，本金尚未支出，持份人可原路退还 BNB，或待降价后重试 execute */
    executionFailed: Boolean(seed.executionFailed) || (id === "executing" && execFailed),
    /** 份额转让市场（唯一的退出途径）：全市场挂单板。
     *  仅挖矿中可挂牌——转让是持份人之间的 P2P 退出，必须在矿机已开矿后才开放，
     *  scene 切换时由 App 负责保留此数组。 */
    listings: [],
    /** 本钱包当前因挂单而锁定的份额（escrow）。挂单时从可用余额扣出、撤单/成交后释放，
     *  故 claim 只作用于「可用余额」，已挂出的份额不会被重复领取或转让。 */
    listingShares: 0,
    /** 多钱包余额账本：每个地址独立记录可用份额、锁定份额、已领 BEM、已退 BNB 与 BNB 余额。
     *  收益账本（claimed）也按地址隔离，不同身份各自的总持有与可领量不再共享一本账。key 为小写地址。 */
    wallets,
    /** 合约代持的 BNB 池：募集款入账、退款/流片支出都从这里走，与钱包余额隔离结算（F4）。*/
    bnbPool: round4(seed.sold * round.sharePriceBnb),
    picked: 1,
  };
}

/**
 * 构建演示用的多钱包余额账本。
 * 连接钱包（WALLET）持有 seed.mine 份；剩余份数按 ROSTER 权重分配给若干演示持有人。
 * 每个钱包记录 { mine: 可用份额, listingShares: 挂单锁定份额 }。
 */
function buildWallets(seed, round) {
  const wallets = {};
  wallets[String(WALLET).toLowerCase()] = { mine: seed.mine, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
  let left = Math.max(0, seed.sold - seed.mine);
  const weightSum = ROSTER.reduce((sum, person) => sum + person.weight, 0);
  ROSTER.forEach((person, index) => {
    const shares = index === ROSTER.length - 1 ? left : Math.min(left, Math.round((left * person.weight) / weightSum));
    left -= shares;
    if (shares > 0) {
      wallets[String(person.address).toLowerCase()] = { mine: shares, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
    }
  });
  return wallets;
}

/**
 * 让 book 上的「当前钱包」标量字段（mine / listingShares / claimed / claimable /
 * bnb / refundedSelf）始终反映当前连接钱包（selfAddress）的余额。
 * 任何改变 wallets 的操作末尾都调一次，保证界面读到的视图与本钱包账本一致。
 *
 * claimable 按本钱包的 accruedNet − claimed 重算，从而修复 F1：可领量随切换的钱包变化，
 * 不再是一份全局池被子钱包任意抽走。
 */
export function recomputeSelf(book) {
  const addr = String(book.selfAddress || WALLET).toLowerCase();
  const wallet = book.wallets[addr] || { mine: 0, listingShares: 0, claimed: 0, refunded: 0, bnb: 0 };
  // 日净按当前算力 + 池归属实时折算，与 computeHarvest / applyHarvest 同口径。
  // 不能直接读 book.dailyBem——它是开期/执行时写入的「已验证池」值，
  // 被挖矿闸门拦住（capped→未验证池、只分 1%）的期次会用错系数，导致 claimable 虚高、
  // 领空后仍显示余额残影。
  const dailyBem = bemRate(book.hashpower || 0, {
    pool: book.capped ? "unverified" : "verified",
  });
  const rate = feeRate(book);
  const netPerRound = dailyBem * (1 - rate);
  // 本钱包累计净产出 = 全网日净 × 领取轮数 × 本钱包份额占比（与 computeHarvest 同口径）
  const totalShares = book.totalShares || 0;
  const shareW = totalShares > 0 ? wallet.mine / totalShares : 0;
  const accruedNet = netPerRound * (book.harvestCount || 0) * shareW;
  const claimable = Math.max(0, round4(accruedNet - (wallet.claimed || 0)));
  return {
    ...book,
    mine: wallet.mine,
    listingShares: wallet.listingShares,
    claimed: wallet.claimed || 0,
    claimable,
    bnb: wallet.bnb || 0,
    refundedSelf: wallet.refunded || 0,
  };
}

/**
 * 演示用持有人名册。
 * 真实环境应从 buy 事件里读，这里按权重分配剩余份数用于预览。
 * weight 决定它分到多少份（尾差由最后一人兜底，见 buildHolders）。
 */
export const ROSTER = [
  { address: "0x3f9A2c17b5D8e4306Cd19C7a1E9b47D2a5C81f04", weight: 34, at: "10-08 09:52" },
  { address: "0x9C41fA7e2B6058D3a1F47E9b2C6d84A0F3E5b71", weight: 26, at: "10-08 10:34" },
  { address: "0x5b2E8c4A6d1F7B903e5C4A2f8D6b1E3A9C7f260", weight: 18, at: "10-08 11:20" },
  { address: "0xe7A3f5B9c2D8461E0f3A5b7C9d1E2f4A6B8c035", weight: 12, at: "10-08 13:05" },
  { address: "0x1c9D4e7F2a5B8036cD1E4f6A8b2C5d9E0f3A714", weight: 10, at: "10-09 09:18" },
];

export function buildHolders(sold, mine) {
  const rest = Math.max(0, sold - mine);
  const weightSum = ROSTER.reduce((sum, person) => sum + person.weight, 0);
  let left = rest;
  const rows = mine > 0 ? [{ address: WALLET, shares: mine, self: true, at: "10-08 09:41" }] : [];
  ROSTER.forEach((person, index) => {
    const shares = index === ROSTER.length - 1 ? left : Math.min(left, Math.round((rest * person.weight) / weightSum));
    left -= shares;
    if (shares > 0) rows.push({ ...person, shares });
  });
  return rows.sort((leftRow, rightRow) => rightRow.shares - leftRow.shares);
}

export function seedCalls(round = ROUND) {
  const now = Date.now();
  const book = createScene("mining", round);
  const h = computeHarvest(round, book);
  return [
    { time: now - 2 * 3600_000, method: "harvest", ok: true, message: `入账 ${formatBem(h.userPart)} BEM，挖矿产出服务费 ${formatBem(h.fee)} BEM` },
    { time: now - 26 * 3600_000, method: "harvest", ok: true, message: `入账 ${formatBem(h.userPart)} BEM，挖矿产出服务费 ${formatBem(h.fee)} BEM` },
    { time: now - 3 * 86400_000, method: "claim", ok: true, message: `${shortAddress(WALLET)} 领取 ${formatBem(book.claimable)} BEM` },
    { time: now - 5 * 86400_000, method: "claim", ok: true, message: "0x8b21…B21A 领取 18.60 BEM" },
    { time: now - 12 * 86400_000, method: "execute", ok: true, message: `已买入电路并转入矿池，算力 ${book.hashpower}` },
    { time: now - 13 * 86400_000, method: "subscribe", ok: true, message: `0x8b21…B21A 认筹 6 份，支付 ${(6 * round.sharePriceBnb).toFixed(4)} BNB` },
    { time: now - 14 * 86400_000, method: "subscribe", ok: true, message: `${shortAddress(WALLET)} 认筹 4 份，支付 ${(4 * round.sharePriceBnb).toFixed(4)} BNB` },
    { time: now - 14 * 86400_000 - 3600_000, method: "createCampaign", ok: true, message: `第 ${round.id} 期创建，${round.totalShares} 份 × ${round.sharePriceBnb} BNB，挖矿产出服务费 ${feePercentOf(round)}%` },
    { time: now - 20 * 86400_000, method: "swapExactTokensForETH", ok: false, message: "拒绝：仅本期合约可调用" },
  ];
}

/* ── 写操作：页面按钮和合约调用页共用同一套实现，避免两份逻辑漂移 ── */

export function applySubscribe(round, book, shares) {
  if (book.scene !== "funding") return { ok: false, message: "只有募集中可以认筹。" };
  if (Date.now() > (book.endsAt || Infinity)) return { ok: false, message: "募集已结束，不能继续认筹；超时未售罄的份额可原路退还 BNB。" };
  const count = Number(shares);
  if (!Number.isInteger(count) || count < 1) return { ok: false, message: "份数必须是正整数" };
  if (book.sold + count > round.totalShares) return { ok: false, message: `超过剩余份数，本期只剩 ${round.totalShares - book.sold} 份` };
  const filled = book.sold + count >= round.totalShares;
  const buyer = String(book.selfAddress || WALLET).toLowerCase();
  const wallet = book.wallets[buyer] || { mine: 0, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
  const cost = round4(count * round.sharePriceBnb);
  if ((wallet.bnb || 0) < cost) {
    return { ok: false, message: `BNB 余额不足，无法支付 ${cost} BNB 认筹款。` };
  }
  return {
    ok: true,
    message: filled ? `已认筹 ${count} 份，本期售罄` : `已认筹 ${count} 份`,
    book: recomputeSelf({
      ...book,
      sold: book.sold + count,
      wallets: { ...book.wallets, [buyer]: { ...wallet, mine: wallet.mine + count, bnb: round4((wallet.bnb || 0) - cost) } },
      bnbPool: round4((book.bnbPool || 0) + cost),
      picked: 1,
      scene: filled ? "executing" : book.scene,
      // 问题①修复：自然售罄进入 executing 也补 executePhase="buying"，
      // 迫使必须先去电路市场买入电路并确认到账，否则 applyExecute 会拒。
      executePhase: filled ? "buying" : book.executePhase,
      approved: true,
      // 售罄即启动 execute 观察期倒计时
      soldOutAt: filled ? Date.now() : book.soldOutAt,
    }),
  };
}

/**
 * 募集超时原路退还（仅募集失败场景）。
 *
 * 与已删除的「exit 赎回」不同：exit 是流片前/后主动退出（已移除），
 * 这里只在「募集中 + 已超过募集截止时间 endsAt + 仍未售罄」时，
 * 把当前钱包认筹的 BNB 原路退给认筹地址、份额清零（已售份数相应回退）。
 * 这是保护认筹人、避免资金卡死于募集失败的安全阀，不进入挖矿/转让流程。
 */
export function applyRefund(round, book, actor = null) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER && who.shares <= 0) {
    return { ok: false, message: "只有持份用户 Owner 可以退款。" };
  }
  const selfKey = String(book.selfAddress || WALLET).toLowerCase();
  const selfWallet = book.wallets[selfKey] || { mine: 0, listingShares: 0 };
  if (selfWallet.mine <= 0) return { ok: false, message: "当前钱包没有可退款的份额。" };
  if (selfWallet.listingShares > 0) return { ok: false, message: "挂单锁定的份额请先撤单再退款。" };

  // 募集失败：募集中 + 超过募集截止时间仍未售罄，本金从未动过，原路退还
  const fundingExpired = book.scene === "funding" && Date.now() > (book.endsAt || Infinity);
  // 流片失败：待执行 + Owner 已发起退款（本金尚未支出），原路退还
  const executeFailed = book.scene === "executing" && book.executionFailed === true;
  // 池子不足：待挂单且 raisedBnb 已不够按原价兑付（部分成交后撤单/卖出），按比例退
  const poolShort = book.scene === "executing"
    && book.executePhase === "buying"
    && Number(book.sold || 0) * round.sharePriceBnb > Number(book.bnbPool || 0);

  if (!fundingExpired && !executeFailed && !poolShort) {
    if (book.scene === "funding") return { ok: false, message: "募集尚未结束，不能退款。" };
    if (book.scene === "executing") return { ok: false, message: "本期尚未判执行失败，且池子仍够按原价兑付，不能退款。" };
    return { ok: false, message: "只有在「募集超时未售罄」「执行失败」或「池子不足以按原价兑付」时才能原路退款。" };
  }

  const refundBnb = poolShort
    ? round4((Number(book.bnbPool || 0) * selfWallet.mine) / Math.max(1, Number(book.sold || 1)))
    : round4(selfWallet.mine * round.sharePriceBnb);
  return {
    ok: true,
    message: poolShort
      ? `池子不足，已按比例退还 ${refundBnb} BNB（${selfWallet.mine} 份）`
      : `已原路退还 ${refundBnb} BNB（${selfWallet.mine} 份 × ${round.sharePriceBnb} BNB）`,
    book: recomputeSelf({
      ...book,
      sold: Math.max(0, book.sold - selfWallet.mine),
      wallets: {
        ...book.wallets,
        [selfKey]: {
          mine: 0,
          listingShares: selfWallet.listingShares,
          claimed: selfWallet.claimed || 0,
          refunded: round4((selfWallet.refunded || 0) + refundBnb),
          bnb: round4((selfWallet.bnb || 0) + refundBnb),
        },
      },
      // 全局累计保留用于 Owner 概览（全部持有人退款总额），与「你的」退款区分
      refundedBnb: round4((book.refundedBnb || 0) + refundBnb),
      bnbPool: round4(Math.max(0, (book.bnbPool || 0) - refundBnb)),
    }),
  };
}

/**
 * 份额转让：发布出售挂单（唯一的退出途径）。
 *
 * 持份人把一部分份额挂到转让市场，按「每份 BNB」标价。
 * 挂出的份额立即从本钱包可用余额扣出并计入本钱包 listingShares 锁定，
 * 不能领取，直到卖出或撤单——避免一币多卖的竞态。
 * 挂单记入 book.listings（全市场可见，即「接收发布的出售价额」的源头）。
 *
 * 多钱包账本：每笔份额流转都借记/贷记对应钱包的 mine / listingShares，
 * 不再共享一本账（修复「单钱包视图下 takeListing 不跨钱包追减」）。
 * 买方「接收」时只是把份额加进买方钱包可用余额并支付 BNB 给卖方（仅记账文案），
 * 不真的扣除买方 BNB 余额。语义完整、可演示，但不是真实链上撮合。
 */
let LISTING_SEQ = 1;

export function applyListShares(round, book, { shares, priceBnbPerShare }, actor = null) {
  if (book.scene !== "mining") return { ok: false, message: "只有在挖矿中才能进行份额转让。" };
  const who = actor || identify(WALLET, book);
  const sellerKey = String(who.address).toLowerCase();
  const wallet = book.wallets[sellerKey] || { mine: 0, listingShares: 0 };
  if (wallet.mine <= 0) return { ok: false, message: "当前钱包没有可用份额可挂牌。" };
  const count = Number(shares);
  if (!Number.isInteger(count) || count < 1) return { ok: false, message: "出售份数必须是正整数" };
  if (count > wallet.mine) return { ok: false, message: `可挂牌份额不足，当前可用 ${wallet.mine} 份` };
  const price = Number(priceBnbPerShare);
  if (!(price > 0)) return { ok: false, message: "单价必须大于 0 BNB" };
  if (who.role !== ROLE.OWNER && who.shares <= 0) {
    return { ok: false, message: "只有持份用户 Owner 可以发布出售。" };
  }
  const total = round4(count * price);
  const listing = {
    id: `L${LISTING_SEQ++}`,
    seller: who.address,
    shares: count,
    priceBnbPerShare: round4(price),
    totalBnb: total,
    postedAt: Date.now(),
  };
  return {
    ok: true,
    message: `已发布出售 ${count} 份 @ ${round4(price)} BNB/份，合计 ${total} BNB`,
    book: recomputeSelf({
      ...book,
      wallets: { ...book.wallets, [sellerKey]: { mine: wallet.mine - count, listingShares: wallet.listingShares + count } },
      listings: [...(book.listings || []), listing],
    }),
  };
}

/** 撤销自己的挂单，释放锁定份额回到可用余额。仅挂单方或 Owner 可调。 */
export function applyCancelListing(round, book, listingId, actor = null) {
  if (book.scene !== "mining") return { ok: false, message: "只有在挖矿中才能进行份额转让。" };
  const who = actor || identify(WALLET, book);
  const listings = book.listings || [];
  const idx = listings.findIndex((l) => l.id === listingId);
  if (idx < 0) return { ok: false, message: "挂单不存在或已成交。" };
  const listing = listings[idx];
  if (who.role !== ROLE.OWNER && String(who.address).toLowerCase() !== String(listing.seller).toLowerCase()) {
    return { ok: false, message: "只能撤销自己发布的挂单。" };
  }
  const sellerKey = String(listing.seller).toLowerCase();
  const wallet = book.wallets[sellerKey] || { mine: 0, listingShares: 0 };
  return {
    ok: true,
    message: `已撤销挂单，释放 ${listing.shares} 份回到可用余额`,
    book: recomputeSelf({
      ...book,
      wallets: { ...book.wallets, [sellerKey]: { mine: wallet.mine + listing.shares, listingShares: Math.max(0, wallet.listingShares - listing.shares) } },
      listings: listings.filter((l) => l.id !== listingId),
    }),
  };
}

/**
 * 接收（买入）挂单：按发布价把份额过户到买方钱包，并支付 BNB 给卖方。
 * 不能买自己的挂单；份数不得超过挂单剩余；部分成交后挂单份额相应扣减，售罄则移除。
 * 多钱包账本：借记卖方 listingShares、贷记买方 mine，份额真正过户。
 */
export function applyTakeListing(round, book, listingId, shares, actor = null) {
  if (book.scene !== "mining") return { ok: false, message: "只有在挖矿中才能进行份额转让。" };
  const who = actor || identify(WALLET, book);
  const listings = book.listings || [];
  const idx = listings.findIndex((l) => l.id === listingId);
  if (idx < 0) return { ok: false, message: "挂单不存在或已成交。" };
  const listing = listings[idx];
  if (String(who.address).toLowerCase() === String(listing.seller).toLowerCase()) {
    return { ok: false, message: "不能接收自己发布的挂单。" };
  }
  const count = Number(shares);
  if (!Number.isInteger(count) || count < 1) return { ok: false, message: "接收份数必须是正整数" };
  if (count > listing.shares) return { ok: false, message: `挂单仅剩 ${listing.shares} 份` };
  const pay = round4(count * listing.priceBnbPerShare);
  const rest = listing.shares - count;
  const nextListings = listings.map((l) => {
    if (l.id !== listingId) return l;
    if (rest > 0) return { ...l, shares: rest, totalBnb: round4(rest * l.priceBnbPerShare), status: "open", open: true };
    return { ...l, shares: count, totalBnb: pay, status: "done", open: false };
  });

  const buyerKey = String(who.address).toLowerCase();
  const sellerKey = String(listing.seller).toLowerCase();
  const buyer = book.wallets[buyerKey] || { mine: 0, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
  const seller = book.wallets[sellerKey] || { mine: 0, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
  // F4：接收必须真实支付 BNB——先锁买方 BNB、份额过户后释放给卖方（原子 swap，杜绝白嫖）。
  if ((buyer.bnb || 0) < pay) {
    return { ok: false, message: `BNB 余额不足，无法支付 ${pay} BNB 接收款。` };
  }
  // 与合约一致：按卖方当前持仓（可用+托管）比例转移已领 BEM 债，避免买方重领历史轮次
  const sellerHeld = Number(seller.mine || 0) + Number(seller.listingShares || 0);
  const moveClaimed = sellerHeld > 0
    ? round4((Number(seller.claimed || 0) * count) / sellerHeld)
    : 0;
  return {
    ok: true,
    message: `已接收 ${count} 份，支付 ${pay} BNB 给 ${shortAddress(listing.seller)}`,
    book: recomputeSelf({
      ...book,
      wallets: {
        ...book.wallets,
        [buyerKey]: {
          ...buyer,
          mine: buyer.mine + count,
          claimed: round4((buyer.claimed || 0) + moveClaimed),
          bnb: round4((buyer.bnb || 0) - pay),
        },
        [sellerKey]: {
          ...seller,
          listingShares: Math.max(0, seller.listingShares - count),
          claimed: round4(Math.max(0, (seller.claimed || 0) - moveClaimed)),
          bnb: round4((seller.bnb || 0) + pay),
        },
      },
      listings: nextListings,
    }),
  };
}


/**
 * Owner 从官方电路市场买入电路（模拟）。
 *
 * 链上 buyCircuits 是原子交割：一笔交易从募集余额付钱、ERC721 立刻到本期合约，
 * 没有「挂单等成交」的中间态。这里按同一口径记账：
 *   - 买入张数累加 circuitCount（历史）与 circuitHeldCount（当前持有）；
 *   - 采购款直接从 bnbPool 扣掉；钱不够就置 executionFailed，不产生持仓。
 */
export function applyBuyCircuits(round, book, actor = null, args = {}) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有 Owner 能从电路市场买入。" };
  }
  if (book.scene !== "executing") {
    return { ok: false, message: "只有待执行状态可以买入电路。" };
  }
  if (book.executePhase === "ready") {
    return { ok: false, message: "电路已确认到账，直接入池或挂回市场卖出。" };
  }
  if (book.executionFailed && (book.bnbPool || 0) <= 0) {
    return { ok: false, message: "本金已退光，不能再买入。" };
  }
  const count = Math.floor(Number(args.qty) || 0);
  const unit = Number(args.maxPriceBnb ?? args.unitPriceBnb ?? quoteUnitFallback(book));
  if (!Number.isFinite(count) || count <= 0) {
    return { ok: false, message: "买入张数须为正整数。" };
  }
  if (!Number.isFinite(unit) || unit <= 0) {
    return { ok: false, message: "最高单价须大于 0。" };
  }
  const cost = round4(count * unit);
  const pool = Number(book.bnbPool || 0);
  if (cost > pool) {
    return {
      ok: true,
      message: `采购 ${count} 张 × ${round4(unit)} BNB 超过可用 ${round4(pool)} BNB，链上会置执行失败。`,
      book: { ...book, executionFailed: true },
    };
  }
  const held = (Number(book.circuitHeldCount) || 0) + count;
  const bought = (Number(book.circuitCount) || 0) + count;
  return {
    ok: true,
    message: `已从电路市场买入 ${count} 张 × ${round4(unit)} BNB（模拟），持仓 ${held} 张。`,
    book: {
      ...book,
      executionFailed: false,
      executePhase: "buying",
      circuitCount: bought,
      circuitHeldCount: held,
      orderFilled: true,
      priceLock: round4(unit),
      bnbPool: round4(pool - cost),
    },
  };
}

/**
 * 挂单价缺省值：取报价里的电路单价，不写死常数。
 * 报价缺失时返回 0 —— 由调用方报「挂单单价须大于 0」，让用户自己填。
 */
function quoteUnitFallback(book) {
  const unit = Number((book.estimate || {}).priceBnb);
  return Number.isFinite(unit) && unit > 0 ? round5(unit) : 0;
}

/**
 * 待挂单时由 Owner 决定开放退款，不判断当前报价买不买得起。
 * 持份人再到「我的资产」原路退还。已挂单、非 Owner 均拒绝。
 */

export function applyOpenRefund(round, book, actor = null) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有 Owner 能发起退款。" };
  }
  if (book.scene !== "executing") {
    return { ok: false, message: "只有待执行可以由 Owner 发起退款。" };
  }
  if (book.executePhase === "ready") {
    return { ok: false, message: "电路已到账，不能退款结束本期。用「退回剩余募集款」把没花完的 BNB 按份退给持份人。" };
  }
  if (book.executePhase && book.executePhase !== "buying") {
    return { ok: false, message: "请先取消挂单，再发起退款。" };
  }
  // 对齐链上 openRefund：只开闸（标记执行失败），一分钱都不推送；
  // 各钱包随后在自己的「我的资产」里 pull 领取，和真实合约一样。
  const next = recomputeSelf({ ...book, executionFailed: true });
  return {
    ok: true,
    message: "已打开退款：本期判为执行失败，持份人各自「原路退款」领回本金。",
    book: next,
  };
}

/**
 * Owner 确认电路已经到账：本期合约持有 ERC721 → 进入 Ready。
 * 链上对应 confirmCircuits()。
 */
export function applyConfirmCircuits(round, book, actor = null) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有 Owner 能确认到账。" };
  }
  if (book.scene !== "executing") {
    return { ok: false, message: "只有待执行状态可以确认到账。" };
  }
  if (book.executePhase === "ready") {
    return { ok: false, message: "电路已确认到账，可直接入池。" };
  }
  const held = Number(book.circuitHeldCount ?? 0) || 0;
  if (held <= 0) {
    return { ok: false, message: "本期合约还没有电路（CircuitsNotReady）：先买入电路。" };
  }
  return {
    ok: true,
    message: `已确认 ${held} 张电路到账，可以入池。`,
    book: {
      ...book,
      executePhase: "ready",
      circuitHeldCount: held,
    },
  };
}

/**
 * 把电路投入矿池：预估变成实际的唯一地方。
 *
 * 权限：仅 Owner。电路到账后即可执行，不再等待观察期。
 * 执行逻辑：直接按 Owner 在电路市场实际买入并确认到账的电路数量入池开矿。
 *          电路数不再由图纸推算、也不与募资总额做「买不买得起」的比较——
 *          买多少算多少，H = 实买电路数 × P。采购款之外的余量按份退回。
 */
export function applyExecute(round, book, quote = MARKET, actor = null) {
  if (book.scene !== "executing") return { ok: false, message: "只有售罄后的待执行状态可以 execute。" };
  if (book.sold < round.totalShares) return { ok: false, message: "份数尚未售罄，不能执行。" };
  /**
   * 电路须已通过调用 tapeout.net 挂单逻辑并确认到账（executePhase === "ready"）才能流片。
   * executePhase 缺失（旧数据/非 executing）按 ready 处理，避免误拦截；
   * 自然售罄进入 executing 时已补 executePhase="buying"（见 applySubscribe），故此处会正确拦住。
   */
  if (book.executePhase && book.executePhase !== "ready") {
    return { ok: false, message: "电路还没到账。先挂买单并确认到账，再入池。" };
  }

  const who = actor || identify(WALLET, book);
  const label = who.label || (who.role === ROLE.OWNER ? "Owner" : who.shares > 0 ? "持份用户" : "未持份地址");
  // F3：execute 不可逆（把全期募集款烧掉），权限收紧为仅 Owner
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有 Owner 能把电路投入矿池（不可逆）。" };
  }

  // 价格快照锁价——以本次执行的报价（或挂单时锁定的报价）结算，
  // 避免「按调用瞬间实时价」被抢跑/抬价导致机会损失。
  const lockUsed = book.priceLock || quote;
  const est = estimateHashpower(round, lockUsed, book.sold);
  /**
   * 入池电路数 = Owner 从电路市场实际买入并确认到账的张数（circuitHeldCount）。
   * 不再拿它跟任何推算出来的需求配比或「募资总额能买几个」比较——买多少算多少。
   */
  const bought = Math.max(0, Math.floor(Number(book.circuitHeldCount ?? 0) || 0));
  const parts = bought > 0 ? bought : est.usedParts;
  const unit = Number(book.priceLock) > 0 ? Number(book.priceLock) : Number(est.priceBnb) || 0;
  const actual = planTask({ parts, circuitId: est.circuitModelId, snapshot: est.quote });
  const hashpower = actual.hashpower;
  const dailyBem = bemRate(hashpower);

  // 流片：支出实际采购款，余量按份退回各钱包（对齐 _returnSurplus）
  const cost = round4(parts * unit);
  const poolBefore = Number(book.bnbPool || 0);
  const surplus = round4(Math.max(0, poolBefore - cost));
  let wallets = { ...book.wallets };
  let refundedExtra = 0;
  if (surplus > 0 && book.sold > 0) {
    for (const [addr, wallet] of Object.entries(wallets)) {
      const free = Number(wallet.mine || 0);
      if (free <= 0) continue;
      const part = round4((surplus * free) / book.sold);
      if (part <= 0) continue;
      refundedExtra = round4(refundedExtra + part);
      wallets[addr] = {
        ...wallet,
        refunded: round4((wallet.refunded || 0) + part),
        bnb: round4((wallet.bnb || 0) + part),
      };
    }
  }

  return {
    ok: true,
    scene: "mining",
    message: `${label}触发 execute：募集 ${est.hardCapBnb} BNB，购入 ${parts} 张${est.circuitName}，` +
      `入池算力 ${hashpower}` +
      (surplus > 0 ? `；余量 ${surplus} BNB 已按份退回` : "") +
      `。`,
    book: recomputeSelf({
      ...book,
      wallets,
      scene: "mining",
      hashpower,
      dailyBem,
      harvestCount: 0,
      feeBem: 0,
      distributed: 0,
      actualBnb: est.bnb,
      actualQuote: est.quote,
      executedBy: who.role,
      executionFailed: false,
      executePhase: undefined,
      priceLock: unit > 0 ? round5(unit) : undefined,
      circuitCount: parts,
      circuitHeldCount: 0,
      bnbPool: 0,
      refundedBnb: round4((book.refundedBnb || 0) + refundedExtra),
      endsAt: undefined,
    }),
  };
}

export function applyHarvest(round, book) {
  if (book.scene !== "mining") {
    return { ok: false, message: "只有挖矿中才能 harvest。" };
  }
  const dailyBem = bemRate(book.hashpower, {
    pool: book.capped ? "unverified" : "verified",
  });
  // 领取次数不设上限：须有可分发日产，且扣费后净额 > 0
  if (dailyBem <= 0) return { ok: false, message: "当前没有可分发数量（日产为 0），无法 harvest。" };
  const rate = feeRate(round);
  if (dailyBem * (1 - rate) <= 0) return { ok: false, message: "扣除挖矿产出服务费后没有可分发净额，无法 harvest。" };
  const addr = String(book.selfAddress || WALLET).toLowerCase();
  const wallet = book.wallets[addr] || { mine: 0, listingShares: 0, claimed: 0 };
  const hBefore = computeHarvest(round, book, addr);
  const nextCount = (book.harvestCount || 0) + 1;
  // harvest 是**全网分发**：把第 nextCount 轮日产出计入每位持有人的 pending，
  // 所有地址按各自份额自动 accrual（pending = accruedNet − claimed 在 recomputeSelf 里按地址重算）。
  return {
    ok: true,
    message: `全网分发第 ${nextCount} 轮，本次你分得 ${formatBem(hBefore.userPart)} BEM（挖矿产出服务费 ${formatBem(hBefore.fee)} BEM，次数不限）`,
    book: recomputeSelf({
      ...book,
      harvestCount: nextCount,
      // 全局统计（全部持有人累计）
      feeBem: round4(dailyBem * rate * nextCount),
      distributed: round4(dailyBem * (1 - rate) * nextCount),
    }),
  };
}

export function applyCreate(round, draft, snapshot = QUOTE) {
  const review = reviewRound(
    {
      sharePriceBnb: draft.sharePriceBnb,
      totalShares: draft.totalShares,
      feePercent: draft.feePercent,
      circuitId: draft.circuitModelId,
      feeRecipient: draft.feeRecipient,
      feeShares: draft.feeShares,
    },
    snapshot,
    round,
  );
  if (!review.ok) return { ok: false, message: review.issues[0] };

  const nextId = round.id + 1;
  const model = findCircuit(draft.circuitModelId || DEFAULT_CIRCUIT);
  const feeShares = (Array.isArray(draft.feeShares) ? draft.feeShares : []).map((row) => {
    const percent =
      row.sharePercent != null && row.sharePercent !== ""
        ? Number(row.sharePercent)
        : Number(row.shareBps) / 100;
    return {
      address: String(row.address || "").trim(),
      sharePercent: Math.round(percent),
      shareBps: Math.round(percent) * 100,
    };
  });
  const nextRound = {
    ...round,
    id: nextId,
    /**
     * 本期要烧的电路总数，开期后不可改。
     * 权重 H = 电路数 × P，所以这就是算力的唯一来源。
     * 不再是开期参数：由本期募资总额按理想成本占比反推。
     */
    partCount: derivePartCount({
      hardCapBnb: Number(draft.sharePriceBnb) * Number(draft.totalShares),
      circuitId: draft.circuitModelId,
      snapshot,
    }),
    sharePriceBnb: Number(draft.sharePriceBnb),
    totalShares: Number(draft.totalShares),
    fundingDays: Number(draft.fundingDays),
    /** 挖矿期是协议常量，即便 draft 传了也不采纳 */
    miningDays: MINING_DAYS,
    /** 服务费：开期表单填多少就是多少，代码不给默认值 */
    feePercent: Number(draft.feePercent),
    circuitModelId: model.id,
    processor: draft.processor,
    feeRecipient: feeShares[0]?.address || String(draft.feeRecipient || "").trim(),
    feeShares,
    contract: previewAddress(nextId),
    /** 开期时锁定的报价快照，作为本期预估基准，用户可核对 */
    lockedQuote: {
      bnbUsdt: review.bnbUsdt,
      prices: { ...(snapshot.prices || QUOTE.prices) },
      ts: Date.now(),
    },
  };
  return {
    ok: true,
    message: `第 ${nextId} 期开始募集：${model.name}，募资 ${review.hardCapBnb} BNB，本期 ${review.needParts} 电路，权重 ${review.hashpower}`,
    round: nextRound,
    book: createScene("funding", nextRound),
  };
}

/**
 * 开期参数校验。`snapshot` 为报价口径（缺省 = 静态基准），不联网。
 *
 * 发行规模由开期人手动决定「募资总额」与「总份数」，每份 BNB 据此派生
 * （每份 = 募资总额 ÷ 总份数），不可单独手填——否则会破坏
 * 「募资总额 = 份数 × 每份」这一链上恒等式。
 *
 * 兼容旧调用：若不传 `hardCapBnb`，则沿用「每份 × 份数」推算募资总额。
 *
 * 电路数只由募资总额反推，校验只管发行参数本身：
 * 募资总额、总份数、服务费与分成地址。电路在电路市场自由买卖，不再校验买不买得起。
 */
export function reviewRound(draft, snapshot = QUOTE, base = ROUND) {
  const totalShares = Number(draft.totalShares);

  const model = findCircuit(draft.circuitModelId || DEFAULT_CIRCUIT);
  const priceBnb = snapshot?.prices?.[model.id] ?? model.priceBnb;
  const bnbUsdt = snapshot?.bnbUsdt || MARKET.bnbUsdt;

  // 募资总额：优先采用开期人手动填写的 hardCapBnb；
  // 否则由「每份 × 份数」推算（兼容旧路径）。每份随之派生。
  let hardCapBnb;
  let sharePriceBnb;
  const capRaw = draft.hardCapBnb;
  if (capRaw !== undefined && capRaw !== null && capRaw !== "") {
    hardCapBnb = Number(capRaw);
    sharePriceBnb = totalShares > 0 ? hardCapBnb / totalShares : NaN;
  } else {
    sharePriceBnb = Number(draft.sharePriceBnb);
    hardCapBnb = sharePriceBnb * totalShares;
  }

  /**
   * 本期电路数由募资总额反推，权重 H = 电路数 × P。
   * 口径必须跟 applyCreate 一致（都用本次表单算出来的募资总额），
   * 否则「预览 567 张 / 实际写入 621 张」会对不上。
   */
  const capForParts =
    Number.isFinite(hardCapBnb) && hardCapBnb > 0 ? hardCapBnb : Number(base.hardCapBnb) || 0;
  const actual = planTask({
    parts: derivePartCount({
      hardCapBnb: capForParts,
      circuitId: draft.circuitModelId ?? base.circuitModelId,
      snapshot,
    }),
    circuitId: model.id,
    snapshot,
  });

  const fee = Number(draft.feePercent);

  const issues = [];
  if (!Number.isFinite(hardCapBnb) || hardCapBnb <= 0) issues.push("募资总额必须是大于 0 的 BNB 数");
  if (!Number.isInteger(totalShares) || totalShares <= 0) issues.push("总份数必须是正整数");
  /**
   * 服务费校验（口径：服务费**真正上链**，见 Campaign.setServiceFee）。
   *
   * 链上硬约束（合约里写死，前端必须与之一致，否则发了交易也会 revert）：
   *  - 费率上限 MAX_SERVICE_FEE_BPS = 1000 → 最高 10%；
   *  - 费率 > 0 时分成表不能为空，费率 = 0 时分成表必须为空；
   *  - 分成份额合计必须恰好 10000 bps（= 100%）；
   *  - 收款地址最多 MAX_FEE_RECIPIENTS = 8 个，且不能重复、不能是零地址。
   */
  if (!Number.isInteger(fee) || fee < 1 || fee > 10) issues.push("挖矿产出服务费必须是 1 到 10 之间的整数（链上硬上限 10%）");
  /**
   * 无挖矿产出资格的处理器：**不是错误**。
   *
   * 这是一条**数据驱动的通用防御**：若将来官方新增一个 processorMultiplier = 0 的处理器，
   * 选中它时「可采购、可开期，但本期算力与挖矿产出恒为 0」必须**明示**，
   * 因此这里进 warnings 而不进 issues —— 绝不能因为它就拦住提交。
   *
   * T-59：Genesis CPU（唯一的无产出处理器）已整体移除，当前表内两个处理器都有资格，
   * 下面的分支暂时不会命中，但机制保留。
   */
  const warnings = [];
  if (!isMineable(model.processor)) {
    warnings.push(
      `${model.processor} 没有挖矿产出资格（官方 processorMultiplier = 0）：` +
        `可正常采购开期，但本期算力与挖矿产出均为 0`,
    );
  }
  // 分成地址校验：至少一条、地址格式、比例 1–100 整数、合计恰为 100、最多 3 个。
  // 不设任何兜底值：开期人没填就是没填，直接进校验。
  const feeShareRows = Array.isArray(draft.feeShares) ? draft.feeShares : [];
  if (feeShareRows.length === 0) {
    issues.push("至少填写一个挖矿产出服务费收款地址");
  } else if (feeShareRows.length > 8) {
    issues.push("挖矿产出服务费分成地址最多 3 个（链上硬上限）");
  } else {
    let shareSum = 0;
    const seen = new Set();
    for (const row of feeShareRows) {
      const address = String(row.address || "").trim();
      // Accept whole-percent input (sharePercent) or on-chain bps (shareBps, multiples of 100).
      const rawPercent =
        row.sharePercent != null && row.sharePercent !== ""
          ? Number(row.sharePercent)
          : Number(row.shareBps) / 100;
      const percent = Math.round(rawPercent);
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        issues.push("挖矿产出服务费收款地址格式不正确");
        break;
      }
      if (/^0x0{40}$/i.test(address)) {
        issues.push("挖矿产出服务费收款地址不能是零地址");
        break;
      }
      const key = address.toLowerCase();
      if (seen.has(key)) {
        issues.push("挖矿产出服务费收款地址不能重复");
        break;
      }
      seen.add(key);
      if (!Number.isInteger(percent) || percent < 1 || percent > 100 || percent !== rawPercent) {
        issues.push("挖矿产出服务费分成比例须为 1 到 100 的整数");
        break;
      }
      shareSum += percent;
    }
    if (shareSum !== 100) {
      issues.push(`所有分成地址比例之和必须等于 100，当前合计为 ${shareSum}`);
    }
  }

  return {
    hardCapBnb: round4(hardCapBnb),
    hardCap: round4(hardCapBnb),
    sharePriceBnb,
    model,
    /** 兼容旧字段：等于该型号自身的价 */
    priceBnb,
    /** 电路数只由募资总额派生 */
    needParts: actual.totalParts,
    /** 是否被挖矿闸门拦住（只能进未验证池） */
    capped: actual.capped,
    bnbUsdt,
    /** 日产：已含闸门判定（capped → 未验证池） */
    dailyBem: bemRate(actual.hashpower, { pool: actual.capped ? "unverified" : "verified" }),
    /** 权重 H = 电路数 × 每张算力 */
    hashpower: actual.hashpower,
    processorScale: actual.processorScale,
    /** 阻断性问题：不改就不能提交 */
    issues,
    /** 提示性问题：明示事实但不阻止提交（如某处理器无挖矿产出资格） */
    warnings,
    ok: issues.length === 0,
  };
}

export function formatClock(time) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

/** 剩余时长文案：2 天 3 小时 / 3 小时 12 分 / 12 分。用于 3 天宽限期倒计时。 */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  if (total <= 0) return "已到期";
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.ceil((total % 3_600) / 60);
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ""}`;
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ""}`;
  return `${Math.max(1, minutes)} 分`;
}


/** BEM 展示统一精确到小数点后 4 位 */
export function formatBem(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.0000";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
