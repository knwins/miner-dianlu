import {
  MINE_GATE_LIMIT,
  NETWORK_DAILY_EMISSION,
  NETWORK_WEIGHT,
  POOL,
  currentRate,
  cumulativeEmission,
  eraDaily,
  poolDailyYield,
  roiOf,
} from "./emission.js";

import {
  DEFAULT_TRANSISTOR,
  TRANSISTORS,
  findTransistor,
  processorScale,
  computeHashpower,
  designMetrics,
  qualityFactor,
  isMineable,
  PROCESSORS,
  PARTS,
  planTask,
  rankTransistors,
  transistorIdFor,
  compareProcessors,
  adviseProcessor,
  PROCESSOR_IDS,
  suggestTaskRange,
  suggestHardCap,
  designOffering,
  listTasks,
  taskTiers,
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
   * 而元件成本本来就是 BNB 计价，两者可直接比较，无需换算。
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
  feeBps: 500,
  fundingDays: 15,
  /** 挖矿期天数，取自协议常量，不可通过开期参数修改 */
  miningDays: MINING_DAYS,
  /**
   * 售罄到可执行之间的观察期（小时）。
   * 换币流片会把全部募集款换成 BNB 并烧掉元件，不可逆。
   * 给用户这段时间核对网表哈希与报价快照。
   */
  executeDelayHours: 48,
  /** 挖矿用元件组合（处理器 × 元件），见 prices.js 的 TRANSISTORS */
  transistorId: DEFAULT_TRANSISTOR,
  /**
   * 本期选题（官方题库 ID）。题目决定元件数与深度，进而决定流片成本与权重。
   *
   * 原按 USDT 计为 50,000。按 BNB 实时价 730 USDT ≈ 68 BNB，
   * 选 #54「8位桶形左移」：g=68、d=7（深度浅，成本惩罚小），
   * 按 Behemoth NAND 实时价约 29 BNB，占募资总额约 43%。
   *
   * **选题必须随BNB 价与元件价一起校准**——
   * BNB 涨价同样会压缩募资总额的 BNB 购买力，成本占比随之上升、
   * 触发退款的阈值下降。BNB 600 时 #96 合适，730 时就该换成更轻的题。
   * 权重 H = 68 × 6 = 408（非最优，只有工本无设计溢价）。
   */
  taskId: "54",
  /** 图纸是否该题最优首创。项目方统一图纸默认复制参考，故为 false（无设计溢价）*/
  optimal: false,
  contract: "0xA11cE9010000000000000000000000000000E901",
  feeRecipient: "0x0000000000000000000000000000000000000fee",
};

/**
 * 价格源。募集期只能读到「当前」价格，所以权重只能是预估；
 * 真正决定权重的是 execute 那一刻的报价。
 * 元件目录与实时取价逻辑见 `prices.js`。
 */
export const MARKET = {
  bnbUsdt: 600,
};

/** 开期时锁定的报价快照，作为预估基准；execute 时会被实际报价覆盖。 */
export const QUOTE = {
  bnbUsdt: MARKET.bnbUsdt,
  /** 各元件组合的 BNB 单价，与 prices.js 的 TRANSISTORS 对应 */
  prices: Object.fromEntries(TRANSISTORS.map((t) => [t.id, t.priceBnb])),
};

export const OWNER = "0x0a11eE0000000000000000000000000000000A11";

/**
 * 角色与权限模型。
 *
 * execute（换币+流片）会把全部募集款换成 BNB 并烧掉晶体管，**不可逆**，
 * 故权限收紧为**仅工厂 Owner** 可触发——Owner 是实际执行 tape-out 的一方，
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
    return { role: ROLE.OWNER, label: "工厂Owner", shares: 0, address };
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

/** 观察期剩余毫秒。未售罄返回 0。 */
export function executeUnlockIn(round, book, now = Date.now()) {
  if (book.scene !== "executing") return 0;
  const unlockedAt = (book.soldOutAt || 0) + round.executeDelayHours * 3600_000;
  return Math.max(0, unlockedAt - now);
}

export function executeUnlocked(round, book, now = Date.now()) {
  return executeUnlockIn(round, book, now) === 0;
}

/** 预览用的场景，用户可在顶栏切换观察各阶段表现。 */
export const SCENES = [
  { id: "funding", label: "募集中" },
  { id: "executing", label: "待执行" },
  { id: "mining", label: "挖矿中" },
];

/**
 * 场景文案。
 * 退出只通过「份额转让」实现：持份人把份额挂到转让市场卖给其他持份人，
 * 没有合约统一的退款/结算终态，也没有 exit 赎回操作。
 */
export const SCENE_COPY = {
  funding: {
    badge: "募集中",
    tone: "live",
    lead: "本期开放认购，份额售罄后进入换币流片。募集期内只能按当前报价预估。份额转让（唯一的退出途径）仅在售罄并进入挖矿中后才开放，募集期与待执行期不可挂牌。",
  },
  executing: {
    badge: "待执行",
    tone: "wait",
    lead: "本期份数已售完。晶体管须由 Owner 钱包在合约侧调用 tapeout.net 挂单逻辑、成交后再调用确认到账，才能触发 execute 流片开矿；若元件涨价导致募资总额买不起，则判失败并全额退款。合约无法替人工操作 tapeout.net，但 Owner 可手动发起链上交易完成这两步。",
  },
  mining: {
    badge: "挖矿中",
    tone: "done",
    lead: "矿机已开矿，按权重占比分得全网日产。产出随全网算力变化，不是固定值。",
  },
};

export function feeRate(round) {
  return round.feeBps / 10000;
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

/** 两位小数：金额与份数口径 */
export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** 四位小数：单价与每权重日产口径（0.0045 这类系数必须保留精度） */
export function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

/**
 * 兜底题目：题库未加载时用，避免权重与成本算成 0。
 * 与官方题库 #17 参数对齐。
 *
 * nand / latch 必须一并带上：官方 tasks.json 没有这两个字段，
 * 它们是 normalizeTask 按题型比例推导的。兜底数据绕过这个环节，
 * 漏掉会导致 hasExact 判定为false，配比与成本在离线状态下算成另一套数。
 */
const FALLBACK_TASK = {
  id: "17",
  name: "八位全零检测",
  tier: "初级",
  group: "组合逻辑",
  kind: "comb",
  nIn: 8,
  nOut: 1,
  g: 22,
  /** 组合逻辑 LATCH 占 20% -> 4 个 LATCH + 18 个 NAND */
  latch: 4,
  nand: 18,
  d: 7,
  K: 22,
  C: 7546,
};

/**
 * 按 ID 取官方题目。
 * 找不到时回落到 FALLBACK_TASK，保证权重与成本始终有值——
 * 否则会出现「权重 0 -> 校验永远失败」的静默错误。
 */
export function findTask(round, book = null) {
  const id = String(round?.taskId ?? FALLBACK_TASK.id);
  const list = book?.tasks || book;
  const arr = Array.isArray(list) ? list : [];
  return arr.find((t) => String(t.id) === id) || FALLBACK_TASK;
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
    transistorId: "BEHEMOTH_NAND",
    quoteMult: 1.5,
    /** 权重 H = g81 × 6 = 486 */
    hashpower: "486",
    bem: "184.05 BEM",
    fee: "13.85 BEM",
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
 * 真实机制下权重来自项目方统一提供的图纸，不是「元件的物理算力」：
 *   募资总额 USDT → BNB → ÷ 元件单价 → 能买多少元件 → 按图纸算 H = (b*+K_task×q) × P
 *
 * 图纸由项目方统一提供且开期后不可改，所以权重是确定的。
 * 唯一会变的是「募资总额按当前报价能买到多少元件」——
 * 买不够图纸所需元件就流片失败并全额退款。
 *
 * 报价来自实时价格源（`prices.js`），同一期在不同时刻结果不同。
 * execute 之后 book.hashpower 才是实际值。
 */
export function estimateHashpower(round, quote = QUOTE, sold = null, taskbook = null) {
  const shares = sold === null ? round.totalShares : sold;
  // 募集以 BNB 计价，募资总额直接是 BNB，不需要 BNB 价换算
  const hardCapBnb = shares * round.sharePriceBnb;
  const bnbUsdt = quote.bnbUsdt || MARKET.bnbUsdt;

  const model = findTransistor(round.transistorId || DEFAULT_TRANSISTOR);
  const priceBnb = quote.prices?.[model.id] ?? model.priceBnb;
  const P = processorScale(model.processor);

  // 项目方统一图纸：按官方题目的 g / d / K 计算权重（q 固定 1）
  const task = findTask(round, taskbook);
  const actual = task
    ? planTask({
        task,
        transistorId: model.id,
        snapshot: quote,
        optimal: round.optimal === true,
        // 开期人写入的流片元件数（不写则按题目 g）
        partCount: round.partCount ?? null,
      })
    : null;

  // 图纸实际要烧的元件数与成本（这才是流片真正要花的钱）
  // usedParts 用实际流片数量（开期人改过则不是 task.g），
  // 否则会出现「改了数量、成本按新数算、元件数却显示旧数」的错位。
  const usedParts = actual ? actual.totalParts : 0;
  const needBnb = actual ? actual.partsCost : 0;

  // 募资总额按图纸 NAND+LATCH 混合配比的实时均价能买多少元件。
  // 不能用单一元件价粗估——LATCH 往往更便宜，会低估能买的元件数，
  // 与 capCoversFloor（needBnb <= hardCapBnb，混合成本）同源。
  // 图纸未知（actual 为空）时退回单一型号价做兜底。
  const perPartBnb = usedParts > 0 ? needBnb / usedParts : (priceBnb || 0);
  const affordableParts = perPartBnb > 0 ? Math.floor(hardCapBnb / perPartBnb) : 0;

  const dailyBem = bemRate(actual?.hashpower || 0);

  return {
    shares,
    /** 募资总额（BNB）——募集与流片成本同为 BNB，可直接相比 */
    hardCapBnb: round4(hardCapBnb),
    hardCap: round4(hardCapBnb),
    /** 仅供需要 USDT 折算时参考（如 ROI 展示），不影响业务计算 */
    bnbUsdt,
    hardCapUsdt: round4(hardCapBnb * bnbUsdt),
    transistorId: model.id,
    transistorName: model.name,
    processor: model.processor,
    processorScale: P,
    partType: model.part,
    priceBnb,
    /** 两种元件的实时单价，按种类归位（不依赖型号自身是 NAND 还是 LATCH）*/
    priceNand: actual?.priceNand ?? priceBnb,
    priceLatch: actual?.priceLatch ?? priceBnb,
    priceByPart: actual?.priceByPart ?? null,
    /** 两种元件各自的数量、单价与小计 */
    costBreakdown: actual?.costBreakdown ?? null,
    /** 募资总额能买的元件数 */
    affordableParts,
    /** 图纸实际烧掉的元件数 —— 流片真正要买的量 */
    usedParts,
    /** 选题详情 */
    task,
    taskName: task?.name || "—",
    taskTier: task?.tier || "—",
    /** 图纸算出的权重明细 */
    area: actual?.area || 0,
    depth: actual?.task.d || 0,
    cost: actual?.cost || 0,
    refCost: actual?.refCost || 0,
    q: actual?.q ?? 1,
    refParts: actual?.task.K || 0,
    latchRatio: actual?.latchRatio ?? 0,
    nand: actual?.nand || 0,
    latch: actual?.latch || 0,
    optimal: round.optimal === true,
    baseWeight: actual?.baseWeight || 0,
    designPremium: actual?.designPremium || 0,
    hashpower: actual?.hashpower || 0,
    /** 图纸流片成本（BNB）*/
    needBnb: round4(needBnb),
    dailyBem,
    totalNet: round2(dailyBem * round.miningDays * (1 - feeRate(round))),
    /** 募资总额是否够买到承诺权重的元件 */
    /**
     * 募资总额能否覆盖混合成本（NAND/LATCH 按各自实时价计价）。
     * 不用 affordableParts >= usedParts —— 那是按单一价粗估，混合配比下偏乐观。
     */
    capCoversFloor: needBnb <= hardCapBnb,
    quote,
  };
}

export function hashpowerSensitivity(round, quote = QUOTE, taskbook = null) {
  const model = findTransistor(round.transistorId || DEFAULT_TRANSISTOR);
  /**
   * 同一处理器的 NAND 与 LATCH 是一套东西，会同涨同跌。
   * 只放大型号自身的价格会让另一种元件留在原价，敏感度分析失真——
   * 比如传 NAND 时 LATCH 不涨，Behemoth 的成本涨幅会被系统性低估。
   */
  const siblings = TRANSISTORS.filter((t) => t.processor === model.processor);
  const basePrices = siblings.map((t) => quote.prices?.[t.id] ?? t.priceBnb);
  const base = estimateHashpower(round, quote, null, taskbook);

  // 真实机制：图纸固定后权重 H 不随价格变，
  // 变的是「募资总额还能不能买到图纸所需的元件」。买不够就流片失败 -> 退款。
  return [0.5, 1, 2, 5, 10].map((mult) => {
    const prices = { ...(quote.prices || {}) };
    siblings.forEach((t, i) => { prices[t.id] = basePrices[i] * mult; });
    const q = { ...quote, prices };
    const est = estimateHashpower(round, q, null, taskbook);
    const short = Math.max(0, est.usedParts - est.affordableParts);
    return {
      mult,
      label: `${mult}x`,
      /** 两种元件都按同一倍数变动后的实时价 */
      priceNand: est.priceNand,
      priceLatch: est.priceLatch,
      /** 兼容旧字段：等于 NAND 价 */
      priceBnb: est.priceBnb,
      /** 图纸所需元件成本 */
      needBnb: est.needBnb,
      /** 流片后募资总额剩余 */
      marginBnb: round4(est.hardCapBnb - est.needBnb),
      affordableParts: est.affordableParts,
      usedParts: est.usedParts,
      shortParts: short,
      /** 还够不够流片 */
      canAfford: est.capCoversFloor,
      hashpower: est.hashpower,
      dailyBem: est.dailyBem,
      totalNet: est.totalNet,
      drop: base.dailyBem > 0 ? Math.round((1 - est.dailyBem / base.dailyBem) * 100) : 0,
    };
  });
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
  const accrueNetFor = (mine) => round2(grossTo(rounds) * (1 - rate) * (round.totalShares > 0 ? mine / round.totalShares : 0));
  const claimed = wallet.claimed || 0;
  const pending = Math.max(0, round2(accrueNetFor(wallet.mine) - claimed));
  return {
    dailyBem: round4(dailyBem),
    // gross 与 dailyBem 同精度：日产只有 4 位小数
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
    accruedFee: round2(grossTo(rounds) * rate),
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
 * quoteMult 模拟执行时晶体管涨价，所以预估值与实际值会不一致。
 */
const SCENE_SEED = {
  // 募集中：22/100 份 = 11,000 USDT
  funding: { sold: 22, mine: 3, harvestCount: 0, claimed: 0, executed: false, circuitId: "—", offset: 0, soldOutAgoHours: null },
  // 售罄 12 小时前 —— 观察期未满，任何人都还不能 execute
  executing: { sold: 100, mine: 13, harvestCount: 0, claimed: 0, executed: false, circuitId: "待流片", offset: 0, soldOutAgoHours: 12 },
  // 执行时元件涨到 1.5x，募资总额仍够买（约占 61%），权重不变
  mining: { sold: 100, mine: 13, harvestCount: 12, claimedRatio: 0.72, executed: true, quoteMult: 1.5, circuitId: "#58241", offset: 1, soldOutAgoHours: 200 },
};


export function createScene(id, round = ROUND, taskbook = null, phase = null, expired = false, execFailed = false) {
  const seed = SCENE_SEED[id] || SCENE_SEED.funding;
  const fundingEnd = Date.now() + (6 * 24 * 60 * 60 + 14 * 60 * 60 + 22 * 60) * 1000;
  // 挖矿不设截止日（领取次数不限）；募集截止仅 funding 生效（演示超时可置为过去）；
  // executing 的 endsAt 不用于展示（倒计时显示「—」），保留 fundingEnd 占位无害。
  const endsAt = id === "mining" ? undefined : (expired && id === "funding" ? Date.now() - 86400_000 : fundingEnd);

  // 预估算力按当前报价；实际权重按执行时报价（元件涨价不影响权重，只影响买不买得起）
  const est = estimateHashpower(round, QUOTE, seed.sold, taskbook);
  const model = findTransistor(round.transistorId || DEFAULT_TRANSISTOR);
  const actualQuote = {
    ...QUOTE,
    prices: { ...QUOTE.prices, [model.id]: QUOTE.prices[model.id] * (seed.quoteMult || 1) },
  };
  const actual = estimateHashpower(round, actualQuote, seed.sold, taskbook);

  const hashpower = seed.executed ? actual.hashpower : 0;
  const dailyBem = bemRate(hashpower);
  const rate = feeRate(round);
  // 全局日净产出（扣费后），所有持有人共享同一日产系数
  const netPerRound = dailyBem * (1 - rate);
  // 主钱包（WALLET）的累计净产出与已领比例，用于初始化演示数据。
  // 收益账本按持有人隔离（F1）：accruedNetW 是「本钱包」的累计净产出，
  // 必须乘上本钱包份额占比 shareW，否则会与 computeHarvest 的 per-wallet 口径对不上。
  const shareW = round.totalShares > 0 ? seed.mine / round.totalShares : 0;
  const accruedNetW = round2(netPerRound * seed.harvestCount * shareW);
  const walletClaimed = seed.claimedRatio !== undefined ? round2(accruedNetW * seed.claimedRatio) : seed.claimed;

  const wallets = buildWallets(seed, round);
  // 演示：主钱包历史已领比例（其余持有人视为未领）
  const wKey = String(WALLET).toLowerCase();
  if (wallets[wKey]) wallets[wKey] = { ...wallets[wKey], claimed: walletClaimed };

  return {
    scene: id,
    /**
     * 待执行子状态：晶体管来自二级市场，须由 Owner 钱包发起链上交易去挂单买入并确认到账，
     * 不能指望合约自动去二级市场操作——合约无法替人工下单。
     * buying = 待挂单；listed = 挂单中（可取消）；ready = 晶体管已到账，待 execute 流片开矿。
     * 其他场景无意义，置 undefined。
     */
    executePhase: id === "executing" ? (phase || seed.executePhase || "buying") : undefined,
    sold: seed.sold,
    mine: seed.mine,
    /** 本期「当前钱包」的地址，identify() 用它判断调用者是否持份 */
    selfAddress: WALLET,
    harvestCount: seed.harvestCount,
    claimed: walletClaimed,
    claimable: round2(accruedNetW - walletClaimed),
    feeBem: round2(dailyBem * rate * seed.harvestCount),
    distributed: round2(netPerRound * seed.harvestCount),
    /** 实际算力。未执行时为 0，界面应改用 estimate.hashpower。 */
    hashpower,
    dailyBem,
    /** 费率基点：供 recomputeSelf 重算各钱包可领量，避免再传 round 依赖 */
    feeBps: round.feeBps,
    /** 总份数：供 recomputeSelf 按钱包份额占比折算 per-wallet 可领量（与 computeHarvest 同口径） */
    totalShares: round.totalShares,
    /**
     * 是否被挖矿闸门拦住（题目元件数超抽检上限）。
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
  const rate = (book.feeBps || 500) / 10000;
  const netPerRound = dailyBem * (1 - rate);
  // 本钱包累计净产出 = 全网日净 × 领取轮数 × 本钱包份额占比（与 computeHarvest 同口径）
  const totalShares = book.totalShares || 0;
  const shareW = totalShares > 0 ? wallet.mine / totalShares : 0;
  const accruedNet = netPerRound * (book.harvestCount || 0) * shareW;
  const claimable = Math.max(0, round2(accruedNet - (wallet.claimed || 0)));
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
    { time: now - 2 * 3600_000, method: "harvest", ok: true, message: `入账 ${formatBem(h.userPart)} BEM，服务费 ${formatBem(h.fee)} BEM` },
    { time: now - 26 * 3600_000, method: "harvest", ok: true, message: `入账 ${formatBem(h.userPart)} BEM，服务费 ${formatBem(h.fee)} BEM` },
    { time: now - 3 * 86400_000, method: "claim", ok: true, message: `${shortAddress(WALLET)} 领取 ${formatBem(book.claimable)} BEM` },
    { time: now - 5 * 86400_000, method: "claim", ok: true, message: "0x8b21…B21A 领取 18.60 BEM" },
    { time: now - 12 * 86400_000, method: "execute", ok: true, message: `购入元件完成流片，权重 ${book.hashpower}，电路 ${book.circuitId}` },
    { time: now - 13 * 86400_000, method: "buy", ok: true, message: `0x8b21…B21A 买入 6 份，支付 ${(6 * round.sharePriceBnb).toFixed(4)} BNB` },
    { time: now - 14 * 86400_000, method: "buy", ok: true, message: `${shortAddress(WALLET)} 买入 4 份，支付 ${(4 * round.sharePriceBnb).toFixed(4)} BNB` },
    { time: now - 14 * 86400_000 - 3600_000, method: "createCampaign", ok: true, message: `第 ${round.id} 期创建，${round.totalShares} 份 × ${round.sharePriceBnb} BNB，服务费 ${round.feeBps / 100}%` },
    { time: now - 20 * 86400_000, method: "swapExactTokensForETH", ok: false, message: "拒绝：仅本期合约可调用" },
  ];
}

/* ── 写操作：页面按钮和合约调用页共用同一套实现，避免两份逻辑漂移 ── */

export function applyBuy(round, book, shares) {
  if (book.scene !== "funding") return { ok: false, message: "只有募集中可以买入。" };
  if (Date.now() > (book.endsAt || Infinity)) return { ok: false, message: "募集已结束，不能继续认购；超时未售罄的份额可原路退还 BNB。" };
  const count = Number(shares);
  if (!Number.isInteger(count) || count < 1) return { ok: false, message: "份数必须是正整数" };
  if (book.sold + count > round.totalShares) return { ok: false, message: `超过剩余份数，本期只剩 ${round.totalShares - book.sold} 份` };
  const filled = book.sold + count >= round.totalShares;
  const buyer = String(book.selfAddress || WALLET).toLowerCase();
  const wallet = book.wallets[buyer] || { mine: 0, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
  const cost = round4(count * round.sharePriceBnb);
  if ((wallet.bnb || 0) < cost) {
    return { ok: false, message: `BNB 余额不足，无法支付 ${cost} BNB 认购款。` };
  }
  return {
    ok: true,
    message: filled ? `已买入 ${count} 份，本期售罄` : `已买入 ${count} 份`,
    book: recomputeSelf({
      ...book,
      sold: book.sold + count,
      wallets: { ...book.wallets, [buyer]: { ...wallet, mine: wallet.mine + count, bnb: round4((wallet.bnb || 0) - cost) } },
      bnbPool: round4((book.bnbPool || 0) + cost),
      picked: 1,
      scene: filled ? "executing" : book.scene,
      // 问题①修复：自然售罄进入 executing 也补 executePhase="buying"，
      // 迫使必须先去二级市场买入晶体管并确认到账，否则 applyExecute 会拒。
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
 * 把当前钱包认购的 BNB 原路退给认购地址、份额清零（已售份数相应回退）。
 * 这是保护认购人、避免资金卡死于募集失败的安全阀，不进入挖矿/转让流程。
 */
export function applyRefund(round, book, actor = null) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER && who.shares <= 0) {
    return { ok: false, message: "只有持份用户或工厂 Owner 可以退款。" };
  }
  const selfKey = String(book.selfAddress || WALLET).toLowerCase();
  const selfWallet = book.wallets[selfKey] || { mine: 0, listingShares: 0 };
  if (selfWallet.mine <= 0) return { ok: false, message: "当前钱包没有可退款的份额。" };
  if (selfWallet.listingShares > 0) return { ok: false, message: "挂单锁定的份额请先撤单再退款。" };

  // 募集失败：募集中 + 超过募集截止时间仍未售罄，本金从未动过，原路退还
  const fundingExpired = book.scene === "funding" && Date.now() > (book.endsAt || Infinity);
  // 流片失败：待执行 + 已判执行失败（元件暴涨买不起，本金尚未支出），原路退还
  const executeFailed = book.scene === "executing" && book.executionFailed === true;

  if (!fundingExpired && !executeFailed) {
    if (book.scene === "funding") return { ok: false, message: "募集尚未结束，不能退款。" };
    if (book.scene === "executing") return { ok: false, message: "本期尚未判执行失败，不能退款；若执行成功将进入挖矿。" };
    return { ok: false, message: "只有在「募集超时未售罄」或「流片失败」时才能原路退款。" };
  }

  const refundBnb = round4(selfWallet.mine * round.sharePriceBnb);
  return {
    ok: true,
    message: `已原路退还 ${refundBnb} BNB（${selfWallet.mine} 份 × ${round.sharePriceBnb} BNB）`,
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
    return { ok: false, message: "只有持份用户或工厂 Owner 可以发布出售。" };
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
  const nextListings = rest > 0
    ? listings.map((l) => (l.id === listingId ? { ...l, shares: rest, totalBnb: round4(rest * l.priceBnbPerShare) } : l))
    : listings.filter((l) => l.id !== listingId);

  const buyerKey = String(who.address).toLowerCase();
  const sellerKey = String(listing.seller).toLowerCase();
  const buyer = book.wallets[buyerKey] || { mine: 0, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
  const seller = book.wallets[sellerKey] || { mine: 0, listingShares: 0, claimed: 0, refunded: 0, bnb: DEMO_BNB };
  // F4：接收必须真实支付 BNB——先锁买方 BNB、份额过户后释放给卖方（原子 swap，杜绝白嫖）。
  if ((buyer.bnb || 0) < pay) {
    return { ok: false, message: `BNB 余额不足，无法支付 ${pay} BNB 接收款。` };
  }
  return {
    ok: true,
    message: `已接收 ${count} 份，支付 ${pay} BNB 给 ${shortAddress(listing.seller)}`,
    book: recomputeSelf({
      ...book,
      wallets: {
        ...book.wallets,
        [buyerKey]: { ...buyer, mine: buyer.mine + count, bnb: round4((buyer.bnb || 0) - pay) },
        [sellerKey]: { ...seller, listingShares: Math.max(0, seller.listingShares - count), bnb: round4((seller.bnb || 0) + pay) },
      },
      listings: nextListings,
    }),
  };
}

export function applyClaim(round, book) {
  if (book.scene !== "mining") {
    return { ok: false, message: "只有挖矿中才能领取。" };
  }
  // F1：领取只针对当前连接钱包的可领量（pending），不再抽走全局池
  const addr = String(book.selfAddress || WALLET).toLowerCase();
  const wallet = book.wallets[addr] || { mine: 0, listingShares: 0, claimed: 0 };
  const h = computeHarvest(round, book, addr);
  if (h.pending <= 0) return { ok: false, message: "当前没有可领取的 BEM。" };
  const amount = h.pending;
  return {
    ok: true,
    message: `已领取 ${formatBem(amount)} BEM`,
    book: recomputeSelf({
      ...book,
      wallets: { ...book.wallets, [addr]: { ...wallet, claimed: round2((wallet.claimed || 0) + amount) } },
    }),
  };
}

/**
 * Owner 调用 tapeout.net 晶体管挂单逻辑（链上交易）。
 *
 * 晶体管来自 tapeout.net 二级市场，但合约无法替人工去平台操作，所以由 Owner（或 keeper）
 * 手动调用本函数发起链上交易：先 placeTransistorOrder 进入「挂单中」，成交后 confirmTransistors 确认到账。
 * 仅工厂 Owner 可调，避免状态竞争；非 Owner 或已挂单/已到账均拒绝。
 */
export function applyPlaceTransistorOrder(round, book, actor = null) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有工厂 Owner 能调用 tapeout.net 挂单逻辑。" };
  }
  if (book.scene !== "executing") {
    return { ok: false, message: "只有待执行状态需要调用 tapeout.net 挂单逻辑。" };
  }
  if (book.executePhase === "ready") {
    return { ok: false, message: "晶体管已到账，无需再挂单。" };
  }
  if (book.executePhase === "listed") {
    return { ok: false, message: "已经调用挂单逻辑，待成交或取消。" };
  }
  return {
    ok: true,
    message: "已调用 tapeout.net 挂单逻辑，等待成交。",
    book: { ...book, executePhase: "listed" },
  };
}

/**
 * Owner 取消 tapeout.net 晶体管挂单，回到待挂单状态。仅工厂 Owner 可调。
 * 仅当处于 listed（挂单中）时有效；已到账或尚未挂单均拒绝。
 */
export function applyCancelTransistorOrder(round, book, actor = null) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有工厂 Owner 能取消 tapeout.net 晶体管挂单。" };
  }
  if (book.scene !== "executing") {
    return { ok: false, message: "只有待执行状态有 tapeout.net 晶体管挂单可取消。" };
  }
  if (book.executePhase !== "listed") {
    return { ok: false, message: "当前没有进行中的 tapeout.net 晶体管挂单。" };
  }
  return {
    ok: true,
    message: "已取消 tapeout.net 晶体管挂单，回到待挂单状态。",
    book: { ...book, executePhase: "buying" },
  };
}

/**
 * Owner 确认 tapeout.net 晶体管成交到账（链上确认交易）。
 *
 * 合约无法替人工确认平台成交，所以由 Owner（或 keeper）手动调用本函数发起链上交易确认成交到账。
 * 仅工厂 Owner 可调，且必须先调用挂单逻辑（listed）才能确认到账——未挂单时拒绝。
 */
export function applyConfirmTransistors(round, book, actor = null) {
  const who = actor || identify(WALLET, book);
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有工厂 Owner 能确认 tapeout.net 晶体管成交到账。" };
  }
  if (book.scene !== "executing") {
    return { ok: false, message: "只有待执行状态需要确认 tapeout.net 晶体管到账。" };
  }
  if (book.executePhase === "ready") {
    return { ok: false, message: "晶体管已确认到账，直接执行流片开矿即可。" };
  }
  if (book.executePhase !== "listed") {
    return { ok: false, message: "请先调用 tapeout.net 挂单逻辑，再确认成交到账。" };
  }
  return {
    ok: true,
    message: "已确认 tapeout.net 晶体管成交并到账，解锁流片开矿。",
    book: { ...book, executePhase: "ready" },
  };
}

/**
 * 执行换币 + 流片。这是「预估」变成「实际」的唯一地方。
 *
 * 权限：持份用户或 Owner 都可触发（Owner 只是先动手那一个，无独占权）。
 * 时间：售罄后必须等 executeDelayHours 观察期，让用户核对网表与报价。
 * 执行逻辑：按执行时的实时报价，自动判断募资总额是否买得起图纸所需元件。
 *          买得起 → 直接换币、买入晶体管、流片并开矿，进入 mining；
 *          买不起 → 判 executionFailed，本金尚未支出，持份人可原路退还 BNB。
 */
export function applyExecute(round, book, quote = MARKET, actor = null, taskbook = null) {
  if (book.scene !== "executing") return { ok: false, message: "只有售罄后的待执行状态可以 execute。" };
  if (book.sold < round.totalShares) return { ok: false, message: "份数尚未售罄，不能执行。" };
  /**
   * 晶体管须已通过调用 tapeout.net 挂单逻辑并确认到账（executePhase === "ready"）才能流片。
   * executePhase 缺失（旧数据/非 executing）按 ready 处理，避免误拦截；
   * 自然售罄进入 executing 时已补 executePhase="buying"（见 applyBuy），故此处会正确拦住。
   */
  if (book.executePhase && book.executePhase !== "ready") {
    return { ok: false, message: "晶体管尚未到位，请先由 Owner 调用 tapeout.net 挂单逻辑并确认成交到账后再执行流片。" };
  }

  const who = actor || identify(WALLET, book);
  const label = who.label || (who.role === ROLE.OWNER ? "工厂Owner" : who.shares > 0 ? "持份用户" : "未持份地址");
  // F3：execute 不可逆（把全期募集款烧掉），权限收紧为仅工厂 Owner
  if (who.role !== ROLE.OWNER) {
    return { ok: false, message: "只有工厂 Owner 可以执行换币流片（不可逆操作）。" };
  }

  const wait = executeUnlockIn(round, book);
  if (wait > 0) {
    const hours = Math.ceil(wait / 3600_000);
    return { ok: false, message: `观察期未满，还要等 ${hours} 小时。售罄后 ${round.executeDelayHours} 小时内不可执行换币。` };
  }

  // F3：价格快照锁价——以本次执行的报价（或首次进入时锁定的报价）结算，
  // 避免「按调用瞬间实时价」被抢跑/抬价导致机会损失。失败重试时清除锁价，重新按当时价评估。
  const lockUsed = book.priceLock || quote;
  const actual = estimateHashpower(round, lockUsed, book.sold, taskbook);
  /**
   * 图纸固定后权重不变，变的是「募资总额还买不买得起图纸所需元件」。
   *
   * 直接比**混合成本**（NAND 与 LATCH 按各自实时价分别计价），
   * 不用「募资总额 ÷ 主元件价 ≥ 元件数」——那是按单一价的粗估，
   * 混合配比下会偏乐观，导致实际买不起却判定为成功。
   */
  const partsOk = actual.needBnb <= actual.hardCapBnb;

  if (!partsOk) {
    const why =
      `按${actual.processor}当前报价（NAND ${actual.priceNand.toFixed(4)} × ${actual.nand} + LATCH ${actual.priceLatch.toFixed(4)} × ${actual.latch}` +
      ` = ${actual.needBnb} BNB）超过募资总额 ${actual.hardCapBnb} BNB，缺口 ${round4(actual.needBnb - actual.hardCapBnb)} BNB`;
    /**
     * 执行失败不转入任何「退款」终态：标记 executionFailed、留在待执行，
     * 本金尚未支出，持份用户可在「我的份额」页把 BNB 原路退还；
     * 也可等待元件降价后由 Owner 重试流片。
     */
    return {
      ok: true,
      message: `execute 后校验不通过：${why}。本期判失败，可原路退还本金 BNB，或待元件降价后由 Owner 重试流片。`,
      book: {
        ...book,
        executionFailed: true,
        actualBnb: actual.bnb,
        actualQuote: actual.quote,
        // 失败重试时清除锁价，下次执行按当时报价重新评估（F3）
        priceLock: undefined,
      },
    };
  }

  return {
    ok: true,
    scene: "mining",
    message: `${label}触发 execute：募集 ${actual.hardCapBnb} BNB，购入 ${actual.usedParts} 个${actual.transistorName}，` +
      `流片权重 ${actual.hashpower}（${actual.usedParts} 元件 ×${actual.processorScale}` +
      `${actual.optimal ? ` + 溢价 q=${actual.q}` : ""}）。`,
    book: recomputeSelf({
      ...book,
      scene: "mining",
      hashpower: actual.hashpower,
      dailyBem: actual.dailyBem,
      harvestCount: 0,
      feeBem: 0,
      distributed: 0,
      actualBnb: actual.bnb,
      actualQuote: actual.quote,
      executedBy: who.role,
      // F5：成功进入挖矿时清掉执行失败的脏状态，避免残留误导下游
      executionFailed: false,
      executePhase: undefined,
      // F3：锁定本次执行所用的报价快照
      priceLock: lockUsed,
      // F4：流片把募集款换成元件并烧掉，从合约代持 BNB 池支出
      bnbPool: round4(Math.max(0, (book.bnbPool || 0) - actual.needBnb)),
      // 挖矿不设截止日：领取次数不限，只要还在出矿就可一直领取
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
  // 领取次数不设上限：只要本期仍在出矿（日产 > 0）就可一直分发
  if (dailyBem <= 0) return { ok: false, message: "当前没有出矿，暂无可领取的 BEM。" };
  const addr = String(book.selfAddress || WALLET).toLowerCase();
  const wallet = book.wallets[addr] || { mine: 0, listingShares: 0, claimed: 0 };
  const hBefore = computeHarvest(round, book, addr);
  const nextCount = (book.harvestCount || 0) + 1;
  const rate = feeRate(round);
  // harvest 是**全网分发**：把第 nextCount 轮日产出计入每位持有人的 pending，
  // 所有地址按各自份额自动 accrual（pending = accruedNet − claimed 在 recomputeSelf 里按地址重算）。
  return {
    ok: true,
    message: `全网分发第 ${nextCount} 轮，本次你分得 ${formatBem(hBefore.userPart)} BEM（服务费 ${formatBem(hBefore.fee)} BEM，次数不限）`,
    book: recomputeSelf({
      ...book,
      harvestCount: nextCount,
      // 全局统计（全部持有人累计）
      feeBem: round2(dailyBem * rate * nextCount),
      distributed: round2(dailyBem * (1 - rate) * nextCount),
    }),
  };
}

export function applyCreate(round, draft, snapshot = QUOTE, taskbook = null) {
  const review = reviewRound(
    {
      sharePriceBnb: draft.sharePriceBnb,
      totalShares: draft.totalShares,
      feePercent: draft.feePercent,
      transistorId: draft.transistorId,
      taskId: draft.taskId,
      optimal: draft.optimal,
      feeRecipient: draft.feeRecipient,
      partCount: draft.partCount,
    },
    snapshot,
    round,
    taskbook,
  );
  if (!review.ok) return { ok: false, message: review.issues[0] };

  const nextId = round.id + 1;
  const model = findTransistor(draft.transistorId || DEFAULT_TRANSISTOR);
  const nextRound = {
    ...round,
    id: nextId,
    /** 本期选题（官方题库 ID），开期后不可改 */
    taskId: String(draft.taskId ?? round.taskId),
    optimal: (draft.optimal ?? round.optimal) === true,
    /**
     * 开期人手动指定的流片元件总数，写入后不可改。
     * 空值表示「按题目 g」，用 null 而不是存题目值——
     * 这样以后改题库的 g 不会让历史期次的语义跟着漂移。
     */
    partCount: Number.isFinite(Number(draft.partCount)) && Number(draft.partCount) >= 1
      ? Math.round(Number(draft.partCount))
      : null,
    sharePriceBnb: Number(draft.sharePriceBnb),
    totalShares: Number(draft.totalShares),
    fundingDays: Number(draft.fundingDays),
    /** 挖矿期是协议常量，即便 draft 传了也不采纳 */
    miningDays: MINING_DAYS,
    feeBps: Number(draft.feePercent) * 100,
    transistorId: model.id,
    processor: draft.processor,
    feeRecipient: draft.feeRecipient,
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
    message: `第 ${nextId} 期开始募集：${model.name}，图纸 ${review.needParts} 元件 / ${review.needBnb.toFixed(4)} BNB，权重 ${review.hashpower}`,
    round: nextRound,
    book: createScene("funding", nextRound),
  };
}

/**
 * 开期参数校验。`snapshot` 为实时报价，传入后校验结果随市场变化。
 *
 * 发行规模由开期人手动决定「募资总额」与「总份数」，每份 BNB 据此派生
 * （每份 = 募资总额 ÷ 总份数），不可单独手填——否则会破坏
 * 「募资总额 = 份数 × 每份」这一链上恒等式。
 *
 * 兼容旧调用：若不传 `hardCapBnb`，则沿用「每份 × 份数」推算募资总额。
 *
 * 无论哪种来源，最终都要校验：募资总额必须够买到图纸所需元件，
 * 否则流片失败并全额退款。
 */
export function reviewRound(draft, snapshot = QUOTE, base = ROUND, taskbook = null) {
  const totalShares = Number(draft.totalShares);
  const fee = Number(draft.feePercent);

  const model = findTransistor(draft.transistorId || DEFAULT_TRANSISTOR);
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

  // 项目方统一图纸：按官方题目的 g / d / K 计算（q 固定 1）
  const task = findTask({ taskId: draft.taskId ?? base.taskId }, taskbook);
  const actual = planTask({
    task,
    transistorId: model.id,
    snapshot,
    optimal: (draft.optimal ?? base.optimal) === true,
    // 开期人手动指定的流片元件数（未填 = 用题目 g）
    partCount: draft.partCount ?? null,
  });

  // 校验用实际流片数量，与 estimateHashpower 保持同源
  const needParts = actual.totalParts;
  const needBnb = actual.partsCost;
  /**
   * 募资总额按图纸 NAND+LATCH 混合配比的实时均价能买多少元件。
   * 不能用单一 NAND 单价（actual.priceNand）粗估——LATCH 往往更便宜，
   * 单一 NAND 价会把能买的元件数算少，混合配比下尤其失真（用户实测：
   * 20 BNB 按 NAND 0.44 只算到 45 个，实际混合均价约 0.346 应够 57 个）。
   * 每元件混合均价 = 图纸总成本 ÷ 图纸元件数，与 capCoversFloor 同源。
   * 仅供 UI 展示；能否买到的判定仍看 canAfford（needBnb <= hardCapBnb）。
   */
  const perPartBnb = needParts > 0 ? needBnb / needParts : 0;
  const affordableParts = perPartBnb > 0 ? Math.floor(hardCapBnb / perPartBnb) : 0;
  const canAfford = needBnb <= hardCapBnb;

  const issues = [];
  if (!Number.isFinite(hardCapBnb) || hardCapBnb <= 0) issues.push("募资总额必须是大于 0 的 BNB 数");
  if (!Number.isInteger(totalShares) || totalShares <= 0) issues.push("总份数必须是正整数");
  if (!Number.isInteger(fee) || fee < 5 || fee > 10) issues.push("服务费必须是 5 到 10 之间的整数");
  if (!isMineable(model.processor)) issues.push(`${model.processor} 不是创世处理器，电路无挖矿资格`);
  /**
   * 流片元件数校验。
   * planTask 已把非法值（0/负数/非数字）退回题目值，但要让开期人知道填错了，
   * 而不是静默按题目值通过——那会让人以为填了 0 却生效了。
   */
  if (draft.partCount !== undefined && draft.partCount !== null && draft.partCount !== "") {
    const pc = Number(draft.partCount);
    if (!Number.isFinite(pc) || pc < 1) {
      issues.push("流片元件数必须是 1 以上的整数");
    } else if (!Number.isInteger(pc)) {
      issues.push("流片元件数必须是整数（不支持小数颗元件）");
    }
  }
  if (affordableParts < needParts) {
    const latchTxt = actual.latch > 0 ? ` / LATCH ${actual.priceLatch.toFixed(4)}` : "";
    issues.push(
      `募资总额 ${hardCapBnb.toFixed(4)} BNB，按 ${model.processor} 当前报价（NAND ${actual.priceNand.toFixed(4)}${latchTxt} BNB，混合均价 ${perPartBnb.toFixed(4)} BNB/个）只够 ${affordableParts} 个元件，` +
        `不够图纸所需的 ${needParts} 个（需 ${needBnb.toFixed(4)} BNB，缺 ${needParts - affordableParts} 个）`,
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(draft.feeRecipient)) issues.push("收费地址格式不正确");

  return {
    hardCapBnb: round4(hardCapBnb),
    hardCap: round4(hardCapBnb),
    sharePriceBnb,
    model,
    /** 兼容旧字段：等于该型号自身的价 */
    priceBnb,
    /** 两种元件的实时单价，按种类归位 */
    priceNand: actual.priceNand,
    priceLatch: actual.priceLatch,
    priceByPart: actual.priceByPart,
    /** 两种元件各自的数量、单价与小计 */
    costBreakdown: actual.costBreakdown,
    nand: actual.nand,
    latch: actual.latch,
    /** 实际流片元件总数（开期人改过则不等于题目 g） */
    needParts,
    /** 题目原本给的元件数，供 UI 对照「已手改」 */
    baseParts: actual.baseParts,
    partCountOverridden: actual.partCountOverridden,
    /** 是否被挖矿闸门拦住（只能进未验证池，拿不到设计溢价） */
    capped: actual.capped,
    bnbUsdt,
    needBnb: round4(needBnb),
    affordableParts,
    /** 缺口（BNB）——基于混合成本计算，不是按单一价折算的元件个数 */
    shortBnb: round4(Math.max(0, needBnb - hardCapBnb)),
    shortParts: affordableParts >= needParts
      ? 0
      : Math.max(0, needParts - affordableParts),
    /** 选题 */
    task,
    taskName: task.name,
    taskTier: task.tier,
    /** 图纸算出的权重明细 */
    hashpower: actual.hashpower,
    area: actual.area,
    depth: task.d,
    cost: actual.cost,
    refCost: task.C,
    q: actual.q,
    refParts: task.K,
    nand: actual.nand,
    latch: actual.latch,
    latchRatio: actual.latchRatio,
    optimal: actual.optimal,
    processorScale: actual.processorScale,
    baseWeight: actual.baseWeight,
    designPremium: actual.designPremium,
    canAfford,
    issues,
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

export function formatUsdt(value) {
  return `${new Intl.NumberFormat("zh-CN").format(value)} USDT`;
}

export function formatBem(value) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/* ── 产出机制再导出（供 UI 直接引用）── */
export {
  NETWORK_DAILY_EMISSION,
  NETWORK_WEIGHT,
  BEM_HARD_CAP,
  HALVING_PERIOD_DAYS,
  MINE_GATE_LIMIT,
  POOL,
  poolDailyYield,
  currentRate,
  eraDaily,
  cumulativeEmission,
  roiOf,
} from "./emission.js";

/* ── 价格与题库模块再导出，供 UI 直接引用 ── */
export {
  TRANSISTORS,
  DEFAULT_TRANSISTOR,
  PROCESSORS,
  PARTS,
  findTransistor,
  isMineable,
  processorScale,
  computeHashpower,
  designMetrics,
  qualityFactor,
  createPriceFeed,
  fetchPriceSnapshot,
  compareTransistors,
  planTransistor,
  isStale,
  /* 选题相关（findTask 是本文件定义的，不在此再导出）*/
  planTask,
  rankTransistors,
  transistorIdFor,
  compareProcessors,
  adviseProcessor,
  PROCESSOR_IDS,
  suggestTaskRange,
  suggestHardCap,
  designOffering,
  listTasks,
  taskTiers,
  fetchTaskBook,
  fetchTapeOutData,
  fetchBnbUsdt,
  LATCH_RATIO,
} from "./prices.js";
