/**
 * 众筹认购「成交状态」—— 全站唯一口径。
 *
 * 语义：这一期的**认筹 deal 是否达成**，与「执行/挖矿是否顺利」是两件事。
 *  - 募集中（未截止 / 未满额）      = 等待成交
 *  - 募集中但已截止且未售罄          = 已流标（deal 从未达成）
 *  - 已售罄（待执行 / 挖矿 / 执行失败）= 已成交（deal 达成，执行成败由主状态徽标另说）
 *  - 执行失败且份额已全部退回        = 已结束
 *
 * 之所以单独成模块：期次下拉、历史列表、资产列表、Owner 卡片都用它。
 * 之前 App.jsx 只看 scene 数字、Owner.jsx 只看 status 文案，两条口径必然走偏 ——
 * `chain.campaigns` 的历史行只有 status 没有 scene，于是下拉里每期都渲染成
 * 「● —」（deal-idle 兜底），看起来像数据丢了。
 *
 * 兼容两种数据形状：
 *  - book / 持仓行：字符串 scene（funding/executing/mining）+ endsAt（毫秒）
 *  - 链上期次摘要行：数字 scene（0/1/2）+ fundingDeadline（秒），或只有 status 文案
 */

const SCENE_NUM = { funding: 0, executing: 1, mining: 2 };

/** 只有 status 文案时回推 scene；对不上就返回 -1（没有任何可用信息）。 */
const STATUS_SCENE = {
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

  if (scene === 0) {
    // 售罄即 deal 达成（合约会立刻转 scene=1，这里兜住读到的中间态）
    if (soldOut) return { key: "done", label: "已成交", cls: "deal-done" };
    if (expired) return { key: "failed", label: "已流标", cls: "deal-failed" };
    return { key: "waiting", label: "等待成交", cls: "deal-wait" };
  }
  if (settledAfterFailure(row)) return { key: "ended", label: "已结束", cls: "deal-failed" };
  return { key: "done", label: "已成交", cls: "deal-done" };
}
