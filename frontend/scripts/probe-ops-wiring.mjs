/**
 * 探针：Owner 工作台写操作按钮的**接线完整性**（T-67）。
 *
 * 背景：截图报「setMiningPool / depositToPool 点了没反应」。根因不是合约、不是按钮
 * 样式，而是 `App.jsx` 的 `OwnerDesk` 漏把 `onSetMiningPool` / `onDepositToPool`
 * 传给 `OwnerOverview`，而 Owner.jsx 里写的是 `onXxx?.()` 可选调用 ——
 * 回调不存在时**静默跳过**，按钮点击毫无反馈、连控制台报错都没有。
 *
 * 这类bug 用 UI 探针很难稳定复现（要看链上状态是否正好停在「待执行」），
 * 所以这里做**静态源码断言**：只要三个环节（App 调用处 → OwnerDesk 形参 →
 * OwnerOverview 形参 + 渲染处）任一处漏掉，立即报错。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const app = fs.readFileSync(path.join(SRC, "App.jsx"), "utf8");
const owner = fs.readFileSync(path.join(SRC, "Owner.jsx"), "utf8");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

// 1. App.jsx：<OwnerDesk> 调用处必须传这两个回调
const deskCall = app.slice(app.indexOf("<OwnerDesk"), app.indexOf("onCreate={handleCreate}"));
check(
  "App.jsx：<OwnerDesk> 传入 onSetMiningPool / onDepositToPool",
  /onSetMiningPool=\{\(args\) => act\("setMiningPool", args\)\}/.test(deskCall)
    && /onDepositToPool=\{\(\) => act\("depositToPool"\)\}/.test(deskCall),
  deskCall.slice(0, 200),
);

// 2. App.jsx：OwnerDesk 形参解构里必须有这两个（否则传了也被丢掉）
const deskSig = app.slice(app.indexOf("function OwnerDesk("), app.indexOf("function OwnerDesk(") + 700);
check(
  "App.jsx：OwnerDesk 形参解构含 onSetMiningPool / onDepositToPool",
  /onSetMiningPool/.test(deskSig) && /onDepositToPool/.test(deskSig),
);

// 3. App.jsx：<OwnerOverview> 渲染处必须往下传
const ovCall = app.slice(app.indexOf("<OwnerOverview"), app.indexOf("<OwnerOverview") + 1400);
check(
  "App.jsx：<OwnerOverview> 透传 onSetMiningPool / onDepositToPool",
  /onSetMiningPool=\{onSetMiningPool\}/.test(ovCall) && /onDepositToPool=\{onDepositToPool\}/.test(ovCall),
);

// 4. Owner.jsx：OwnerOverview 形参里必须有这两个
const ovSig = owner.slice(owner.indexOf("export function OwnerOverview("), owner.indexOf("export function OwnerOverview(") + 700);
check(
  "Owner.jsx：OwnerOverview 形参含 onSetMiningPool / onDepositToPool",
  /onSetMiningPool/.test(ovSig) && /onDepositToPool/.test(ovSig),
);

// 5. Owner.jsx：按钮 onClick 不得再用 `?.()`（缺回调时静默跳过，正是本次的 bug）
const flowPanel = owner.slice(
  owner.indexOf("setMiningPool"),
  owner.indexOf("depositToPool 进入挖矿") + 100,
);
// 只扫代码行：注释里为了说明问题会故意写出 `onXxx?.()`，不能算命中
const ownerCode = owner
  .split("\n")
  .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
  .join("\n");
check(
  "Owner.jsx：入池按钮不用 `onXxx?.()`（缺回调须抛错而非静默跳过）",
  !/onSetMiningPool\?\./.test(ownerCode) && !/onDepositToPool\?\./.test(ownerCode)
    && /submitMiningPool\(/.test(ownerCode) && /submitDepositToPool\(/.test(ownerCode),
);
check(
  "Owner.jsx：requireOps 守卫已就位（漏传时报错而非静默）",
  /function requireOps/.test(owner) && /回调未接线/.test(owner),
);

// 6. 前置条件与链上一致：depositToPool 在 miningPool 为零时必须禁用
check(
  "Owner.jsx：depositToPool 按钮在链上未设矿池时禁用（链上 revert PoolNotSet）",
  /hasPoolOnChain/.test(owner) && /!hasPoolOnChain\}\s*title=\{hasPoolOnChain \? undefined : "请先设置矿池地址/.test(flowPanel),
);

// 7. 矿池地址回填：链上已设过就要显示，否则 Owner 无法判断是否已生效
check(
  "Owner.jsx：回填链上已写入的矿池地址（book.miningPool）",
  /book\.miningPool/.test(owner) && /本期矿池地址已写入/.test(owner),
);

const ok = results.every((r) => r.ok);
console.log(`\n${ok ? "全部通过" : "存在失败项"}（${results.filter((r) => r.ok).length}/${results.length}）`);
process.exit(ok ? 0 : 1);