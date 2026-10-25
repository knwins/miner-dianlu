/**
 * 众筹认购状态 —— 认购这一层的唯一口径（「阶段」与「子状态」见 ./roundState.js）。
 *
 * 语义：这一期的**认筹是否达成**，与「执行/挖矿是否顺利」是两件事。
 *  - 募集中（未截止 / 未满额）      = 认购中
 *  - 募集中但已截止且未售罄          = 已流标（认筹从未达成）
 *  - 已售罄（待执行 / 挖矿 / 执行失败）= 已售罄（认筹达成，执行成败由主状态徽标另说）
 *  - 执行失败且份额已全部退回        = 已结束
 *
 * 徽标只在**补充了阶段词没说的信息**时显示；阶段词已经说过的（已结束 / 挖矿中），
 * label 留空由调用方判空跳过 —— 否则同一个格子里会同时印出「已结束」和「已结束」。
 *
 * 用词：这一层**不用「成交」**。认购阶段没有成交动作，售出的是份额；
 * 「成交」在本项目里专指**电路在电路市场成交**与**挖矿份额转让成交**。
 * 之前这里写「等待成交 / 已成交」，在期次标题旁与「电路数 · 待成交」并排出现，
 * 被读成「本期电路已经买到了」——表述是错的，故改为「认购中 / 已售罄」。
 *
 * 之所以单独成模块：期次标题、历史列表、资产列表、Owner 卡片都用它。
 * 之前 App.jsx 只看 scene 数字、Owner.jsx 只看 status 文案，两条口径必然走偏。
 *
 * 兼容两种数据形状：
 *  - book / 持仓行：字符串 scene（funding/executing/mining）+ endsAt（毫秒）
 *  - 链上期次摘要行：数字 scene（0/1/2）+ fundingDeadline（秒），或只有 status 文案
 */

const SCENE_NUM = { funding: 0, executing: 1, mining: 2 };

/** 只有 status 文案时回推 scene；对不上就返回 -1（没有任何可用信息）。 */
const STATUS_SCENE = {
  // 阶段词与 roundState.js 的 SCENE / FAILED 保持一致
  募集中: 0,
  待执行: 1,
  执行失败: 1,
  挖矿中: 2,
  已结束: 1,
};

const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);

function sceneIndexOf(row) {
  if (typeof row?.scene === "number") return row.scene;
  const named = own(SCENE_NUM, row?.scene);
  if (named != null) return named;
  const byStatus = own(STATUS_SCENE, row?.status);
  return byStatus == null ? -1 : byStatus;
}

function endsAtOf(row) {
  if (row?.endsAt != null) return Number(row.endsAt) || 0;
  if (row?.fundingDeadline) return Number(row.fundingDeadline) * 1000;
  return 0;
}

/** 执行失败且已无未退份额 —— 期次真正结束（不是「执行失败但还能退款」）。 */
function settledAfterFailure(row) {
  if (row?.ended === true) return true;
  const failed = Boolean(row?.executionFailed);
  if (!failed) return false;
  if (row.outstandingShares == null) return true;
  return Number(row.outstandingShares) === 0;
}

export function dealStatus(row) {
  const none = { key: "none", label: "", cls: "deal-idle" };
  if (!row) return none;
  const scene = sceneIndexOf(row);
  if (scene < 0) return none;

  const sold = Number(row.sold || 0);
  const total = Number(row.totalShares || 0);
  const soldOut = total > 0 && sold >= total;
  const expired = endsAtOf(row) > 0 && Date.now() > endsAtOf(row);

  /**
   * 徽标只在「补充了阶段词没说的信息」时显示。
   * 阶段词已经说过的，label 留空 —— 调用方判空即可，不必各自再判一次。
   *
   *   募集中   ：认购中 / 已售罄 是新增信息 → 显示
   *   流标     ：阶段已显示「已结束」，原因写在子状态行 → 不显示（旧版这里还印一个「已流标」）
   *   待执行   ：已售罄说明「认筹这层已达成」，与子状态（待挂单/挂单中/已到账）不同层 → 显示
   *   挖矿中   ：开矿必然以售罄为前提，再标一个「已售罄」纯属复述 → 不显示
   *   已结束   ：阶段词就是「已结束」→ 不显示（旧版两处都是「已结束」，同一格印两遍）
   */
  if (scene === 0) {
    // 售罄即认筹达成（合约会立刻转 scene=1，这里兜住读到的中间态）
    if (soldOut) return { key: "done", label: "已售罄", cls: "deal-done" };
    if (expired) return { key: "failed", label: "", cls: "deal-failed" };
    return { key: "waiting", label: "认购中", cls: "deal-wait" };
  }
  if (settledAfterFailure(row)) return { key: "ended", label: "", cls: "deal-failed" };
  if (scene === 2) return { key: "done", label: "", cls: "deal-done" };
  return { key: "done", label: "已售罄", cls: "deal-done" };
}
