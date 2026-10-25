/**
 * 「托管 BNB」（链上 raisedBnb）这一格的副文案 —— 全站唯一口径。
 *
 * 同一个池子在每个阶段代表的东西完全不同，副文案必须跟着换：
 *
 *   | 阶段              | 池子是什么        | 比较对象 / 该提示什么          |
 *   |-------------------|-------------------|-------------------------------|
 *   | 募集中            | 已募集的认筹款    | 募集目标；截止未售罄才告警退款 |
 *   | 待执行 · 待挂单/挂单中 | 买电路的采购预算 | 池子不够按份全退才告警         |
 *   | 待执行 · 已到账待开矿 | 没花完的余款     | 按份退回或开矿后记账，不是告警 |
 *   | 挖矿中            | 已结清（≈0）      | 有余款没发到持份人手上才提示   |
 *   | 执行失败          | 剩余可退款的钱    | 够不够按份全退                 |
 *
 * 旧写法不分阶段一律输出「距按份全退还差 X BNB」并标红。在挖矿中这是误导：
 * 池子归零是**正常**的（募集款已经换成电路并进入官方挖矿），那个阶段根本没有退款通道，
 * 红色告警只会让人以为钱丢了。
 *
 * 单独成模块：5 个阶段 × 2~3 个分支写在 JSX 里既没法单独验证，
 * 也容易在下次改版时漏掉某个阶段（本文件就是为了「漏」这件事而存在）。
 */

const round4 = (v) => Math.round(Number(v || 0) * 1e4) / 1e4;

/**
 * @param {object} book  持仓/期次读数（_chain 版由 adapter 生成；截止时间在 book.endsAt）
 * @param {object} round 期次参数（sharePriceBnb / totalShares）
 * @param {number} [now] 当前时间（毫秒），便于测试
 * @returns {{ text: string, tone: "warn" | "ok" | "muted" }}
 */
export function escrowNote(book, round, now = Date.now()) {
  const price = Number(round?.sharePriceBnb || 0);
  const totalShares = Number(round?.totalShares || 0);
  const target = price * totalShares;
  const raised = Number(book?.bnbPool || 0);
  const sold = Number(book?.sold || 0);
  const outstanding = book?.outstandingShares != null
    ? Number(book.outstandingShares)
    : sold;
  // 池子够不够按份全额退款。缺额时持份人仍可按比例自取，但那是「退而求其次」。
  const gap = Math.max(0, outstanding * price - raised);

  if (book?.scene === "mining") {
    const pending = Number(book.surplusOutstanding || 0);
    return pending > 0
      ? { text: `已结清 · 还有 ${round4(pending)} BNB 余款待持份人领取`, tone: "ok" }
      : { text: "已结清 · 募集款已全部换成电路并开矿", tone: "ok" };
  }

  if (book?.scene === "funding") {
    // 截止时间在 book 上（readState 读链上 fundingDeadline，已是毫秒），round.endsAt 只是兜底。
    const endsAt = Number(book?.endsAt || round?.endsAt || 0);
    const expired = endsAt > 0 && now > endsAt;
    const soldOut = totalShares > 0 && sold >= totalShares;
    if (expired && !soldOut) {
      return { text: `已截止且未售罄 · 目标 ${round4(target)} BNB，可发起退款`, tone: "warn" };
    }
    return { text: `募集目标 ${round4(target)} BNB`, tone: "muted" };
  }

  // scene === executing（含执行失败）
  if (book?.executionFailed) {
    // 份额已经全部退完（outstanding 归零）时，说「够不够全额退」没有意义。
    if (outstanding <= 0) return { text: "已无可退份额 · 认筹款已全部退回", tone: "muted" };
    return gap > 0
      ? { text: `池子不足 · 只能按比例退（差 ${round4(gap)} BNB）`, tone: "warn" }
      : { text: "足够按份全额退款", tone: "ok" };
  }
  if (book?.executePhase === "ready") {
    // 新合约可提前 returnSurplus；旧路径在 startMining 时自动记账。两种都不影响开矿。
    return raised > 0
      ? { text: "没花完 · 可按份退回，或开矿后自动记账", tone: "muted" }
      : { text: "已全部用于买电路，无余款可退", tone: "muted" };
  }
  // 待执行 · 待挂单 / 挂单中
  if (raised <= 0 && sold <= 0) return { text: "还没有人认筹", tone: "muted" };
  return gap > 0
    ? { text: `采购预算 · 已不够按份全退（差 ${round4(gap)} BNB）`, tone: "warn" }
    : { text: "采购预算 · 未花完的部分开矿前按份退回", tone: "muted" };
}
