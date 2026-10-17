# TapeOut 众筹挖矿前端 — 业务逻辑说明文档

> 本文档用于**保存 / 复盘** BEM 众筹挖矿前端的业务规则与状态机设计。所有"链上交易"均为本地状态机模拟（预览/演示用途），不连接真实合约。

---

## 0. 项目定位与状态

- **类型**：BEM 挖矿合约的**预览前端**，用 React 状态机模拟合约业务，便于评审"资金路径"和"退出机制"。
- **技术栈**：React 19 + Vite 6；纯前端，无后端。
- **单一真相源**：页面按钮与"合约调用"页共用同一套 `apply*` 写函数（`src/fixtures.js`），保证"界面临摹点得到的"和"合约里能调到的"永远是同一套逻辑。
- **关键结论**：退出机制已收敛为**两条互不相交的路径**——份额转让（主动，仅挖矿中）+ 退款（被动安全阀，仅在募集超时 / 流片失败）；合约**不提供任何本金或收益赎回**。

---

## 1. 核心数据模型

| 概念 | 含义 | 落点 |
|---|---|---|
| `round`（期次参数） | 开期写死的全局参数：每份 BNB、总份数、募资总额、服务费、流片成本口径、选题、观察期 | `fixtures.js` 的 `ROUND` |
| `book`（期次状态） | 当前这一期的运行态：已售份数、各钱包余额、场景、转让挂单板、领取累计等 | `createScene()` 产出 |
| `scene` | 顶层状态机：`funding` / `executing` / `mining` | `book.scene` |
| `executePhase` | `executing` 专属子态：`buying` → `listed` → `ready` | `book.executePhase` |
| `wallets` | 多钱包余额账本，key=小写地址，`{mine, listingShares, claimed, refunded, bnb}` | `book.wallets` |
| `bnbPool` | 合约代持的 BNB 池：募集款入账、退款/流片支出，与钱包余额隔离结算 | `book.bnbPool` |

**恒等式（链上不可破）**：`募资总额 BNB = 总份数 × 每份 BNB`。每份由募资总额派生，用户只能买**整数份**，不能直接转账（直接转账不记份）。

---

## 2. 状态机

```
                  applyBuy 自然售罄
   ┌──────────┐ ───────────────────────► ┌────────────┐
   │ funding  │                          │ executing  │
   │ 募集中   │                          │ 待执行     │
   └──────────┘                          └─────┬──────┘
        │ 募集超时未售罄                            │ applyExecute
        │ (endsAt 过期)                            │ (晶体管到位 + 观察期满)
        ▼                                          ▼
   ┌──────────────────────────┐            ┌──────────┐
   │ refund（被动安全阀①）      │            │ mining   │
   │ 原路退 BNB，份额清零       │            │ 挖矿中   │
   └──────────────────────────┘            └─────┬────┘
                                                  │ 流片失败 (executionFailed)
                                                  │ 本金尚未支出
                                                  ▼
                                       ┌──────────────────────────┐
                                       │ refund（被动安全阀②）      │
                                       │ 原路退 BNB，份额清零       │
                                       └──────────────────────────┘

   mining 内唯一主动退出：份额转让环（挂单 → 接收 / 撤单）
```

### 2.1 `executing` 晶体管挂单子态

晶体管来自 **tapeout.net 二级市场**，但**合约无法替人工去平台操作**，必须由 **Owner 钱包手动发起链上交易**完成：

```
   buying  ──placeTransistorOrder──►  listed  ──confirmTransistors──►  ready  ──applyExecute──► mining
   (待挂单)                            (挂单中)                      (已到账)                    (流片开矿)
              ◄──cancelTransistorOrder──
```

- `placeTransistorOrder`：调用 tapeout.net 挂单逻辑，进入"挂单中"。
- `confirmTransistors`：确认成交到账，解锁流片。必须先挂单才能确认。
- `cancelTransistorOrder`：取消挂单，回到"待挂单"。
- **硬闸门**：`applyExecute` 在 `executePhase !== "ready"` 时**无条件拒绝**流片。自然售罄进入 `executing` 时 `applyBuy` 已写入 `executePhase="buying"`，所以**不可能绕过晶体管闸门直接流片**（问题①修复）。
- 三个动作**仅工厂 Owner** 可调用。

### 2.2 观察期

`executeUnlockIn()`：售罄后必须等 `executeDelayHours`（48h）才能 `execute`，让用户核对网表哈希与报价快照。Owner 也不能提前执行。

---

## 3. 退出机制（两条独立路径）

### 3.1 主动退出 —— 份额转让（唯一主动退出途径）

- **仅 `mining` 可操作**（`applyListShares / applyCancelListing / applyTakeListing` 首行即 `if (book.scene !== "mining") return 拒绝`）。
- 流程：持份人挂单（按"每份 BNB"标价）→ 其他持份人按发布价**接收**（份额过户 + BNB 付给卖方，F4 原子结算：扣买方 `bnb`、贷记卖方 `bnb`）。
- **份额锁定（escrow）**：挂单时立即从可用余额 `mine` 扣出、贷记 `listingShares`；撤单/成交才释放 → 杜绝一币多卖。
- **不能买自己挂单**；部分成交后挂单份额相应扣减，售罄则移除。
- 募集期、待执行期**不可挂牌**（文案见 `SCENE_COPY.funding.lead`）。

### 3.2 被动安全阀 —— 退款（原路退 BNB）

| 触发 | 条件 | 代码 |
|---|---|---|
| 募集超时 | `funding` + `now > endsAt` + 未售罄 | `applyRefund` |
| 流片失败 | `executing` + `executionFailed === true`（元件涨价买不起，本金尚未支出） | `applyRefund` |

- 退款只退**当前钱包**认购的 BNB，份额清零；`mining` **不可退款**。
- 与已删除的 "exit 赎回" 完全不同：exit 是流片前/后主动赎回（已移除），退款是保护认购人、避免资金卡死的安全阀。

---

## 4. tapeout.net 交互边界（重要澄清）

- **不是**"人工去 tapeout.net 网站点鼠标手动买"。非钱包地址无法在平台操作。
- **而是**：Owner（或 keeper）**手动调用本项目的挂单逻辑，发起链上交易**（即 `applyPlaceTransistorOrder` 等），由 Owner 钱包完成二级市场的挂单/取消/确认到账。
- 合约侧只负责在晶体管 `ready` 后执行换币流片，**不替人工操作平台**。
- 所有 UI 文案（`Calls.jsx` 摘要、`Owner.jsx` 晶体管卡片、`App.jsx` 认购页说明）已统一为"Owner 手动调用挂单逻辑（链上交易）"，外链按钮已删除。

---

## 5. 多钱包账本（问题④修复 + F1 收益隔离 + F4 BNB 结算）

引入 `book.wallets` 前，单钱包视图下 `takeListing` 不跨钱包追减，导致"卖出方份额没扣、买方也没加"的错账。

- `buildWallets(seed, round)`：开期时按 `ROSTER` 权重分配演示持有人余额，连接钱包 `WALLET` 持有 `seed.mine` 份。**每个钱包独立维护五本账**：可用份额 `mine`、锁定份额 `listingShares`、已领 BEM `claimed`、已退 BNB `refunded`、BNB 余额 `bnb`（初始 `DEMO_BNB`）。
- 所有份额流转**真正借记/贷记对应钱包**的 `mine / listingShares`：
  - `applyBuy` / `applyRefund`：操作 `selfAddress` 钱包。
  - `applyListShares` / `applyCancelListing`：借记/贷记卖方钱包。
  - `applyTakeListing`：借记卖方 `listingShares`、贷记买方 `mine`，份额真正过户。
- `recomputeSelf(book)`：**每次改写账本后**调用，让 `book.mine / book.listingShares / book.claimed / book.claimable / book.bnb / book.refundedSelf` 始终反映**当前连接钱包**（`selfAddress`）的余额，保证界面读到的"我的份额/可领/余额"与账本一致。`claimable = 全网日净 × 领取轮数 × 本钱包份额占比 − 本钱包已领`，与 `computeHarvest` 同口径（F1）。

### 5.1 收益账本按持有人隔离（F1，顺带修复问题⑤）

- `computeHarvest(round, book, address)`：收益累计按**传入地址**的 `wallets[address].mine` 与 `claimed` 计算，`pending = accruedNet(该地址) − claimed(该地址)`；默认地址为 `selfAddress`。harvest 是**全网分发**（所有地址按份额自动 accrual），claim/harvest 只领**本钱包** pending。
- 已彻底废弃"一份全局 `claimable` 冒充所有持份人"的旧口径。切换钱包后"可领"随本钱包正确重算（原问题⑤的错位消失）。

### 5.2 BNB 原子结算（F4）

二级转让不再是"只过户份额、不碰 BNB"的账面演示，而是带 BNB 收付的闭环：

- `applyBuy`：扣买方 `bnb`，累加进 `bnbPool`；余额不足拒。
- `applyTakeListing`：先校验并锁定买方 `bnb`，成交时实时付给卖方（买方 `bnb` 减、卖方 `bnb` 加），份额同步过户。
- `applyRefund`：从 `bnbPool` 支出、BNB 退回本钱包，并记 `wallets[addr].refunded` + 全局 `refundedBnb`（F6：区分"你退的"与"全网退的"）。
- `applyExecute` 成功：从 `bnbPool` 支出实际流片所需 `actual.needBnb`。
- 界面在「我的份数」页展示「我的 BNB 余额」「合约代持 BNB 池」「我的已退 BNB」，让资金托管一目了然。

---

## 6. 产出 / 领取逻辑（无上限）

- **领取次数不设上限**：只要本期还在出矿（`dailyBem > 0`），持份人就能一直领取，不存在"90 天/90 次封顶"终态；挖矿也不设截止日（`endsAt` 置 `undefined`）。
- `computeHarvest()` 已 `maxRounds = Infinity / exhausted = false / totalGross = totalNet = null`，界面只展示"每次能领多少、是否已出矿"及"已领取次数"，**不展示任何整期总额外推**。
- 产出机制（零和）：`日产 = 池日产 × 我的权重占比`；全网权重涨，所有人产出同步降。
- `applyHarvest` 按 `userPart <= 0` 拒领（而非旧版按次数上限拒绝）；触发全网按份额分发，并把本钱包增量记入 accrual。
- `applyClaim` 领取**本钱包**已累计的 `pending`（存量领取，与 harvest 增量区分），写 `wallets[addr].claimed`；两者都只作用于「可用余额」，已挂出（escrow）份额不参与。

---

## 7. 关键业务约束与校验

1. **整数份**：`applyBuy` 要求 `count` 为正整数且不超过剩余份数。
2. **流片成本判定用混合均价**：`needBnb <= hardCapBnb`（NAND/LATCH 按各自实时价分别计价），不用"募资总额÷主元件价"粗估——混合配比下单一价会偏乐观（问题复盘已知）。
3. **晶体管闸门**：`applyExecute` 拒绝 `executePhase !== "ready"`；拒绝 `sold < totalShares`；拒绝观察期内。
4. **份额锁定**：挂单即 escrow，已挂出份额不可重复领取或转让。
5. **权限模型**：`identify(address, book)` 严格按传入地址查账本判身份。**`execute` 不可逆（把全期募集款烧成晶体管），权限收紧为仅工厂 Owner**（F3），避免任一持份用户单方面把全期本金烧掉；真实合约应再加"时间锁 + 多签/投票"兜底防止 Owner 不作为卡死资金，本预览以"48h 观察期 + 报价快照锁定 + Owner 门槛"组合替代。晶体管三步（挂单/取消/确认）同样仅 Owner。
6. **开期校验** `reviewRound`：每份/总份数/服务费(5–10%)/处理器资格/流片元件数/收费地址格式/成本可负担，任一不通过则拒绝开期。

---

## 8. `apply*` 写操作清单（单一真相源，见 `src/fixtures.js`）

| 函数 | 作用 | 关键约束 |
|---|---|---|
| `applyBuy` | 认购 | funding + 整数份 + 余量；售罄转 executing 并写 `executePhase="buying"` |
| `applyRefund` | 原路退 BNB | 仅 funding超时 / executing失败；退当前钱包并记 `refunded` |
| `applyListShares` | 发布转让挂单 | 仅 mining；余额足够；escrow 锁定 |
| `applyCancelListing` | 撤单 | 仅挂单方或 Owner；释放锁定 |
| `applyTakeListing` | 接收挂单 | 仅 mining；不能买自己；跨钱包过户 + BNB 原子结算 |
| `applyClaim` | 领取存量 `claimable` | 仅 mining；按本钱包 pending 领，写 `wallets[addr].claimed` |
| `applyHarvest` | 增量领取 | 仅 mining；`userPart>0`；次数不限；全网按份 accrual |
| `applyPlaceTransistorOrder` | 调用 tapeout.net 挂单 | 仅 Owner；executing |
| `applyCancelTransistorOrder` | 取消挂单 | 仅 Owner；须 listed |
| `applyConfirmTransistors` | 确认到账 | 仅 Owner；须 listed→ready |
| `applyExecute` | 换币+流片开矿 | **仅 Owner**（F3）+ 晶体管 ready + 观察期满 + 成本可负担；按**锁定报价快照**结算；成功清脏状态（F5）并从 `bnbPool` 支出 |
| `applyCreate` | 开新一期 | 经 `reviewRound` 校验 |

---

## 9. 设计缺陷专项修复记录（F1–F10，按优先级）

> 由"多钱包账本"（问题④）顺带暴露并逐一定级。以下全部已修复并经 `node verify.mjs` + `vite build` 验证。

| 编号 | 缺陷 | 严重度 | 修复 |
|---|---|---|---|
| F1 | 收益账本不隔离：一份全局 `claimable` 冒充所有持份人，切换钱包后可领量与持份对不上、误差滚雪球（即原问题⑤） | 高 | `computeHarvest(round, book, address)` 按地址算 `pending = accruedNet − claimed`；`claimed` 改按钱包存 `wallets[addr].claimed`；harvest 全网按份 accrual、claim 只领本钱包；`recomputeSelf` 按本钱包份额占比重算 `claimable` |
| F2 | 切场景整体重建，丢失执行中途状态（晶体管子态、挂单、挖矿态） | 中 | `App.switchScene` 只改 `scene`，保留 `executePhase / wallets / listings / selfAddress` |
| F3 | execute 无锁价且权限过松（任一持份用户可把全期本金烧掉） | 高 | 权限收紧为**仅 Owner**；按 `book.priceLock` 锁定报价快照结算；UI/Calls/Owner 文案同步 |
| F4 | 二级转让只过户份额、不结算 BNB（账面演示） | 中 | `applyBuy / applyTakeListing / applyRefund / applyExecute` 均走 `bnbPool` 与钱包 `bnb` 原子收付；界面展示余额与托管 |
| F5 | execute 成功后残留脏状态（`executionFailed / executePhase` 未清） | 低 | 成功分支清 `executionFailed:false, executePhase:undefined`，仅留 `priceLock` |
| F6 | 退款总额误标为全局量，未区分"你退的" | 低 | 每钱包记 `wallets[addr].refunded` + 全局 `refundedBnb`；界面用 `refundedSelf` 显示"你的" |
| F7 | 挂单/转让场景边界不清 | 低 | `listShares/takeListing` 与文案统一为"仅挖矿中" |
| F8 | 募集超时缺自动终态提示 | 低 | 保持 `funding + now>endsAt` 即自动显示退款入口（被动安全阀自动可达），无需额外手动开关 |
| F9 | 挖矿期冗余 `endsAt` 终态 | 低 | 移除，领取不设次数/时间上限 |
| F10 | 文档滞后 | — | 本 README 已同步 |

> 迁移注意：F1 使 `computeHarvest` 新增 `address` 参数并改变 `applyClaim/applyHarvest` 语义（per-wallet）；`book` 新增 `totalShares / bnbPool`，`wallets[addr]` 新增 `claimed / refunded / bnb`；`Calls.readCall("pendingBem")` 改按地址算，`callGate("execute")` 与 `Owner` execute 权限改 Owner-only。相关断言已在 `verify.mjs` 同步更新。

---

## 10. 开发与验证

```bash
cd D:/Code/miner/frontend
npm install            # 安装依赖（React 19 / Vite 6）
npm run dev            # 本地预览（默认 127.0.0.1:5173）
npm run build          # 生产构建（vite build）
node verify.mjs        # 业务逻辑断言测试（55+ 组，全绿为通过）
```

- **预览交互**：顶栏"查看状态"可切换 `funding / executing / mining` 三个场景，以及"募集超时""流片失败"两个演示态；"身份"下拉可切换 Owner / 持份用户 / 未持份地址 / 各演示持有人，用于预览不同角色权限边界。
- `verify.mjs` 覆盖：晶体管挂单全流程、份额转让跨钱包过户、退款双触发、execute 硬闸门、领取无上限等核心路径。
- 构建与验证均需在 `D:/Code/miner/frontend` 目录下执行。

---

## 11. 文件地图

| 文件 | 职责 |
|---|---|
| `src/fixtures.js` | 业务真相源：模型、状态机、所有 `apply*` 写操作、预估/校验 |
| `src/App.jsx` | 顶层组件：场景切换、身份切换、唯一写入口 `invokeCall`、各页面 |
| `src/Calls.jsx` | "合约调用"页 + 调用闸门 `callGate`（按角色/场景/子态限制可见可调用项） |
| `src/Owner.jsx` | Owner 视图：期次概览、开新一期、份额明细、晶体管挂单卡片 |
| `src/prices.js` | 价格源、晶体管目录、选题/权重/成本计算（`estimateHashpower` 依赖） |
| `src/emission.js` | 全网日产、池权重、费率等产出常量 |
| `src/verify.mjs` | 业务逻辑断言测试 |

---

*文档基于 `frontend` 真实代码复盘整理；如业务逻辑再次调整，请同步更新本文件与 `verify.mjs`。*
