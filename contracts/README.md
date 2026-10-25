# TapeOut 众筹挖矿 · 合约文档

> **本文档是 `contracts/` 的唯一文档**，只描述**当前状态**与**未解决的问题**。
> 已修复的问题、变更史、废弃概念一律不记 —— 需要追溯看 git 历史。
>
> **本文档分工**：项目级记忆（用户偏好、踩坑、跨会话知识）在仓库根目录 `MEMORY.md`，本文档只管合约。

**一句话定位**：一个"众筹买芯片物料"的链上资管协议。认购人按份认购 BNB → 期次 Owner 用筹款在官方晶体管市场买该期锁定处理器的晶体管 → 确认到账 → 打入矿池 → 挖矿产出按份额分配。**退出唯一路径是挖矿份额转让（不赎回）。**

---

## 目录

1. [业务总览与状态机](#1-业务总览与状态机)
2. [合约拓扑](#2-合约拓扑)
3. [CampaignFactory 接口面](#3-campaignfactory-接口面)
4. [Campaign 接口面](#4-campaign-接口面)
5. [资金与份额流](#5-资金与份额流)
6. [角色 × 场景 → 前端入口](#6-角色--场景--前端入口)
7. [官方链上事实](#7-官方链上事实)
8. [不可违背的口径](#8-不可违背的口径勿回退)
9. [开发与部署](#9-开发与部署)
10. [未解决的问题](#10-未解决的问题)
11. [文件索引](#11-文件索引)

---

## 1. 业务总览与状态机

### 1.1 状态流转

```
funding（募集中）
    │ 自然售罄 sold == totalShares（记 soldOutAt）
    ▼
executing（待执行）  buying ──place──► listed ──confirm──► ready
    ▲                    │  ▲            │                │
    │                    │  └──cancel────┴────────────────┘
    │                    │                                │
    │                    └──── 买不起 → executionFailed    │
    │                                                     │
    │ 超时未售罄 ──► refund ◄──────────────────────────────┘
    │                openRefund / abandonOrder / markFailed / returnSurplus（仅退余款，本期继续）
    ▼
mining（矿池）  ready ──depositToPool──► mining（晶体管已打入，不可逆）
                                    harvest()/claim() 是占位空实现
```

`Scene`：`Funding`(0) / `Executing`(1) / `Mining`(2)
`Phase`（仅 Executing 内）：`None`(0) / `Buying`(1) / `Listed`(2) / `Ready`(3)

### 1.2 核心规则

| 规则 | 说明 |
|---|---|
| 退出路径 | **被动**：募集超时 / 买料失败时 `refund`；Owner 可 `openRefund` / `abandonOrder` 批量退（仅 `buying`/`listed`，`ready` 与入池后封锁）。**晶体管确认到账后不再有「晶体管退回 Owner」的退款**。**没有挖矿中赎回** |
| 矿池 | `Ready` 态必须先把没花完的募集款按份退回持份人（`returnSurplus()`；`depositToPool()` 内部也兜底、且排在晶体管转移之前），再把晶体管**不可逆**转入 `miningPool`（份额保留）。**不结束本期、不影响入池** |
| 份额转让 | **仅 Mining 开放**：持份人发布出售挂单（份额立即锁定）→ 他人接收（BNB 原子付卖方） |
| 不提供 | 挖矿中赎回；`harvest`/`claim` 接口仍是 no-op（产出净额改由 `claimSurplus` 领取，**不会锁死**） |
| 资金 | 认筹进 `raisedBnb`；份额转让 BNB 直付卖方；`receive()` 仅 `market` 可入账 |

---

## 2. 合约拓扑

```
CampaignFactory (Ownable, 单例)
  ├─ materialMarket : address  (immutable) ──► 官方晶体管市场 0xA6a80C19…16E4
  ├─ allowedParts[] : 晶体管白名单（部署时写入、不可增删）
  └─ createCampaign() ──new──► Campaign（每期一个独立部署实例）
                                  ├─ market      (immutable) 晶体管市场
                                  ├─ transistors (immutable) 本期晶体管合约 = 处理器
                                  └─ owner       = 建期瞬间的 factory owner（快照）
```

| 文件 | 职责 |
|---|---|
| `Campaign.sol` | 单期主合约：状态机、认筹、退款、份额转让、晶体管挂单、入池、余款、服务费 |
| `CampaignFactory.sol` | 开期工厂 + 晶体管白名单 + 期次登记册 |
| `interfaces/IMaterialMarket.sol` | 晶体管市场接口（买单侧） |
| `interfaces/IERC1155.sol` | 晶体管 ERC1155 接口 |
| `access/Ownable.sol` | 最小 Owner 基座（**自写，不用 OpenZeppelin**） |
| `security/ReentrancyGuard.sol` | 防重入（同上） |
| `mocks/MockMaterialMarket.sol` `mocks/MockERC1155.sol` | 测试替身（**开关无访问控制，禁止上主网**） |
| `test-helpers/Rejector.sol` | 测试用拒收合约 |

**不存在的东西**（引用这些会编译失败或白屏）：`OfficialPodAdapter` / `IPoD` / `IOfficialPoD` / `IERC20`(BEM) / `IERC721`(电路 NFT) / `ITransistorMinter` / `Emission` 库 / `MockPoD` / `MockOfficialPoD` / `MockBEM` / `MockMinter` / `MockERC721`；概念上「选题 / 题库 / taskId / 流片启动 / 网表 / PoD 挖矿 / 日产公式 / 退出赎回」一律不存在。

---

## 3. CampaignFactory 接口面

源码：`contracts/CampaignFactory.sol`

### 3.1 构造（2 参）

```solidity
constructor(address materialMarket_, address[] memory allowedParts_) Ownable(msg.sender)
```

| 参数 | 约束 | 作用 |
|---|---|---|
| `materialMarket_` | 非零 | 晶体管市场，写入 `materialMarket`（**immutable**） |
| `allowedParts_` | 非空、元素非零 | 晶体管白名单，**部署时写入、之后不可增删** |

错误：`ZeroAddress` / `EmptyWhitelist`(白名单为空) / `PartsNotAllowed(parts)`

> **`allowedParts` 是安全边界，不是运营开关。** 主网上防止 owner 把期次指向 `MockERC1155`（其 `mint` 无访问控制，任何人能无限造晶体管，「晶体管已到账」的检查会形同虚设）。主网白名单 = 官方两件套。
> 白名单**允许重复项**（构造时不去重），`allowedPartsCount()` 如实返回重复后长度 → 别填重复项。
> `_isAllowed` 是 O(n) 扫描（约 2,448 gas/项），白名单只 2 项可忽略。

### 3.2 `createCampaign` — onlyOwner

```solidity
createCampaign(uint256 sharePriceBnb, uint256 totalShares, uint64 fundingSeconds, address transistors_)
  returns (address campaign)
```

| 参数 | 语义 | 校验 |
|---|---|---|
| `sharePriceBnb` | 每份单价（**wei**，不是 BNB） | 仅 `!= 0`，无上限 |
| `totalShares` | 总份数 | 仅 `!= 0`，无上限 |
| `fundingSeconds` | 募集时长（**秒**，原样相加） | ⚠️ **无上下限**；`0` → 出生即过期 |
| `transistors_` | 本期晶体管合约（= 处理器） | **必选**：零地址 `revert ZeroAddress`；须在白名单内 |

- 前端/脚本负责 `天 × 86400 → 秒`；工厂不再做 `× 1 days`，因此不会出现乘完再窄化成 `uint64` 的截断。
- 部署成本约 430 万 gas。
- **开期不收集题目（taskId）与网表。**

### 3.3 视图与其它

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `campaignCount()` | 读 | 任何人 | 已开期次数 |
| `campaigns(uint256 i)` | 读 | 任何人 | 第 i 期地址 |
| `isRegistered(address)` | 读 | 任何人 | 是否仍在登记册（**O(1)**，`mapping` 实现） |
| `allowedPartsCount()` / `allowedPartsAt(uint256)` / `isAllowedParts(address)` | 读 | 任何人 | 晶体管白名单 |
| `materialMarket()` | 读 | 任何人 | 晶体管市场（immutable；语义对应 `Campaign.materialMarket()`） |
| `owner` | 读 | 任何人 | Factory Owner |
| `removeCampaign(uint256 index)` | 写 | 仅 Owner | swap-and-pop 从登记册移除。**不销毁链上 Campaign**、**索引不稳定**、**不可逆**（无恢复入口） |
| `transferOwnership(address)` | 写 | 仅 Owner | 转让所有权（**一步到位、无 pendingOwner**） |

**事件**：`CampaignCreated(index, campaign, sharePriceBnb, totalShares, fundingDeadline)` / `CampaignRemoved(index, campaign)`

> **`removeCampaign` ≠ 冻结期次**：移除后链上 Campaign 仍在、**仍可继续 `subscribe`**、原 owner 仍能 `setPlan`，认购款仍锁在 `raisedBnb`。前端不得据此显示「本期已终止」。
> 移除后撤单权从 owner 转给**任何人**（设计好的逃生舱：owner 失联时用户能拿回钱）。
> `CampaignCreated` 不含晶体管合约 —— 想知道本期锁了哪个处理器须额外调 `campaign.transistors()`。

---

## 4. Campaign 接口面

源码：`contracts/Campaign.sol` · 构造 6 参 `(sharePriceBnb, totalShares, deadline, materialMarket, owner, transistors)`

> **Campaign owner 是建期瞬间的快照。** 工厂 `transferOwnership` 之后，老期次仍归旧 owner（`setPlan` → `NotOwner`），但新 owner 能 `removeCampaign` 开逃生舱。

### 4.1 募集 / 退款

| 功能 | 类型 | 权限 / 场景 | 说明 |
|---|---|---|---|
| `subscribe(uint256 count)` | 写 payable | `funding`；截止前；`msg.value == count × sharePriceBnb` | 认筹整数份；售罄 → `executing` + `buying`，记 `soldOutAt` |
| `refund()` | 写 | ① `funding` 且超时未售罄；或 ② `executing` + **`buying`** + （`executionFailed` 或池子已不足以按原价兑付） | 本钱包本金原路退、份额清零；有 escrow 锁定时跳过。**`listed` / `ready` 一律拒绝**：`listed` 的押金还在市场里（此时按比例退是把还没回来的钱先分掉，市场回调还可能重入），`ready` 的晶体管已是持份人的资产（S-9）。**晶体管在手且池子不足时也拒绝（`PartsAreCollateral`）**：份额清零后晶体管既无人可领、owner 也拿不走，等于烧掉（S-14） |
| `topUpShortfall()` | 写 payable | 仅 Owner；仅 `executing`；`msg.value > 0` | 自掏腰包补齐「已被晶体管吃掉」的本金缺口，让池子重新覆盖**全部份额的原价**。这是**买入之后想放弃本期**的唯一公平前置：补齐 → `openRefund` / `abandonOrder`（持份人按原价全额退回）→ 晶体管才可归 owner / 交回。多补的部分在份额清零后由 `recoverBnb()` 扫回，不会锁死（S-14） |
| `markFailed()` | 写 | 任何人，但非 Owner 须在售罄满 `FAIL_GRACE`(3 天) 后；Owner 随时；**`ready` 一律拒绝（`UseReturnSurplus`）** | 先撤未成交买单（押金退回），再置 `executionFailed`，为所有持有人打开 `refund()`。撤单被市场拒绝时整笔回滚、可稍后重试。`ready` 不是失败态（晶体管已到账），标失败 + 退款会让持份人丢晶体管申索（S-9）。**晶体管在手且池子不足时标失败也不会打开退款**（`PartsAreCollateral`，见 S-14） |
| `openRefund()` | 写 | Owner；仅 `buying`；且 `sold > 0`；且还没 `returnSurplus`；且**晶体管在手时池子必须覆盖全部份额** | 批量退款（**不搬晶体管**）。`ready` 用 `UseReturnSurplus` 拒绝：晶体管已确认到账，只能 `returnSurplus` 退余款 + 入池（确要结束本期须先 `setPhase(1)`，属管理员逃生）。**晶体管在手时按比例退款等于把晶体管烧在合约里**，故先 `topUpShortfall` 补齐（`PartsAreCollateral`，S-14）。份额全退完后当期晶体管才可由 `recoverTransistors` 提给 Owner；`sold == 0` 时 `ZeroShares`；退过余款后 `SurplusAlreadyReturned` |
| `returnSurplus()` | 写 | **Owner 随时**；**其他任何人须在 `max(soldOutAt, lastOrderAt) + FAIL_GRACE` 之后**；`ready` 且无市场欠款（`owed == 0`）；`raisedBnb > 0` | **不结束本期**：把没花完的募集款按份记账退回持份人（各 `claimSurplus()` 自领）。份额不变、晶体管留在合约、`phase` 仍是 `ready`，之后照常 `depositToPool()`。非 owner 的宽限期兜底是 **Ready 的失联救援**：owner 消失时余款也能变成持份人可领，不再锁在 `raisedBnb` 里；它不搬任何晶体管、也不改变归属，无法被用来牟利（S-16） |
| `abandonOrder()` | 写 | Owner；仅 `executing` + `buying` / `listed`；且还没 `returnSurplus`；且**晶体管在手时池子必须覆盖全部份额** | 撤未成交买单、提取市场欠款、按池子退款，最后才把剩余晶体管退 Owner（要求 `outstandingShares == 0` **且** `_holdersMadeWhole()`）。晶体管在手而池子不足时整笔拒绝（`PartsAreCollateral`）：先 `topUpShortfall`（S-14）。`ready` 用 `UseReturnSurplus` 拒绝 |
| `depositToPool()` | 写 | Owner；`ready` + 晶体管在手 + 已设矿池 | **先把 `raisedBnb` 按份记账给持份人（`_returnSurplus`），再把晶体管转进矿池**，然后 `scene = mining`。顺序保证「钱先归持份人、晶体管才离开」，owner 无法扫走 |
| `claimSurplus()` | 写 | 有 pending 余款者 | 领取余款（pull 模式，见 §5.3） |

> ⚠️ **`neverSoldOut` 出口必须保留**：`refund()` 里「**一份未卖 + 已过募资截止**」这条路径是 Funding 超时期次**唯一的**退款出口。封掉会造成 Critical 级本金锁死。

### 4.2 挖矿份额转让（仅 `mining`）

> **术语口径**：前端统一称「**挖矿份额转让**」（导航项标签保留「资产转让」，副标题「挖矿份额转让」）。转让标的是**挖矿份额**，不是晶体管也不是 BEM。
> 份额转让用「发布出售挂单 / 接收 / 撤销」，**不用「挂牌 / 接单」** —— 「挂牌」在晶体管市场语境指挂买单，会撞车；**晶体管卖出没有挂单动作**（官方市场无卖单簿，只能吃已挂买单）。

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `listShares(uint256 count, uint256 priceBnbPerShare)` | 写 | **持份人**（`_shares[msg.sender] >= count`） | 发布出售挂单；份额从可用余额移入 escrow，立即锁定 |
| `cancelListing(uint256 id)` | 写 | **挂单方或 Owner** | 撤单，释放锁定。**Owner 可撤销任意挂单** |
| `takeListing(uint256 id, uint256 count)` | 写 payable | **非卖方**；精确付款 | 份额过户；BNB 原子付给卖方。**接单方不必是持份人**，接收后即成为持份人 |

### 4.3 晶体管（仅 Owner + `executing`）

| 功能 | 类型 | 子态流转 | 说明 |
|---|---|---|---|
| `setPlan(uint256 estHashpower)` | 写 | 仅 `funding` 或 `executing`+`buying` | 写入预估算力（**仅展示用**）。Listed/Ready/Mining 不可改。**不写晶体管数** |
| `placeTransistorOrder(uint256 nandQty, uint96 nandPrice, uint256 latchQty, uint96 latchPrice)` | 写 | `buying` → `listed` | 锁价并挂买单；晶体管合约在开期锁定，**不是参数**。仅 `buying` 可调（Listed/Ready 会 `WrongScene`）。一次只能有一张挂单。买不起则置 `executionFailed` 且不挂单（**不 revert**）。失败后仍售罄时可重挂并清 `executionFailed` |
| `cancelTransistorOrder()` | 写 | `listed`/`ready` → `buying` | 未成交仅 owner 可撤。已有成交时任何人可撤剩余买单。全部成交且晶体管到账则不能撤 |
| `confirmTransistors()` | 写 | `listed` → `ready` | 确认到账；保留 `priceLock`。**`ready` 是 Executing 终态**。**permissionless** 但前置客观条件 `priceLock != 0 && orderFilled() && _partsOnHand()`（真买过 + 已全部成交 + 晶体管已到货），结果相同无法滥用 |
| `setPhase(uint8)` | 写 | Owner；仅 `executing` 且当前不是 `listed` | 改子状态，**不搬代币**。**`3(ready)` 必须由数据成立**：`_readyBasis()` = 已成交买单，**或晶体管已在手**（部分成交后撤单 `priceLock` 已归零，但晶体管确实在这里，必须还能回 `ready` 退余款 / 入池，否则余款和晶体管一起锁死，S-10/S-17）；**`2(listed)` 必须有一条腿在市场上还有剩余量**（成交确认后残留的旧单号不算），否则 `WrongScene`。晶体管是否在手只由 `confirmTransistors` 要求（`_readyInvariant`）。⚠️ 仍是 god-mode 逃生函数 |
| `sellTransistors(uint256 bidId, uint8 tokenId, uint256 quantity)` | 写 | 仅 Owner；仅 `ready`；未入池 | **唯一的卖出路径**。官方晶体管市场**没有卖单簿**，所以不能挂卖，只能吃一张**已挂着的买单**：校验买单标的是本期 `transistors`、`tokenId` 一致、`remaining >= quantity`、单价不为 0（`ZeroPrice`）、买家不是本期自己（`SelfTrade`）、**成交单价 ≥ 本期买入成本（历史最高单价）**（`PriceBelowCost`，见 S-21/S-22），然后 `setApprovalForAll` → `market.fillBid(bidId, quantity)` → 立即 `withdraw()` 把净得款（扣 1% 市场费）提进 `raisedBnb`；一分钱都没进来则 `NoProceeds` 回滚。可分批、可重复；卖剩的仍可 `depositToPool()`。事件 `TransistorsSold(bidId, tokenId, quantity, proceeds)` |
| `withdrawMarketProceeds()` | 写 | 任何人 | 从市场提取欠款（走 `receive()`）；`owed == 0` 时静默 no-op。`sellTransistors` 已自动提款，这个入口只是兜底 |
| `setMaterialMarket(address)` | 写 | 仅 Owner；`listed` / **旧市场仍欠款（`owed > 0`）** 时拒绝 | 换本期晶体管市场（原 `setMinter`）。`owed()` 按市场记账，先换会把卖出款丢在旧市场；旧市场调不通时放行（那正是需要逃生的时候） |
| `setMiningPool(address)` | 写 | 仅 Owner；入池前 | 设矿池地址；入池后 `AlreadyPooled`、零地址 `ZeroAddress` |
| `depositToPool()` | 写 | 仅 Owner；`ready` + **已有成交买单或晶体管已在手**（`_readyBasis`）+ **还有份额** + **至少一件晶体管** + 已设矿池 | **不可逆**：先把余量 BNB（含卖出款）按份记账给持份人（`_returnSurplus`，份额保留），再把**当前持有的全部**晶体管转入 `miningPool`，置 `pooled=true` 进入 `Mining`。未设池 `PoolNotSet`；没有人持份 `ZeroShares`（池子会白拿）；一件晶体管都没有 `InsufficientParts`（纯现金期次不该进挖矿）。不要求「晶体管数量 == 订单数量」：部分卖出后入池剩余部分是合法出口（S-10） |
| `recoverBnb()` | 写 | 仅 Owner | 测试救援。一次扫走所有可动 BNB：募集/待执行只转出超过 `raisedBnb` 的多余余额；`sold == 0` 时转出整池剩余并清零。**`surplusPool - surplusPaid` 与 `totalPendingFee` 已预留，扫不走**；`revenuePool` 只是累计展示值（钱已经在 surplus 预留额里），**不可再加一次** |
| `recoverTransistors(address token, uint256 id, uint256 amount)` | 写 | 仅 Owner；禁止 `listed`；入池后禁止；**当期晶体管在 `outstandingShares > 0` 或持份人未按原价收回本金时禁止** | 把持有的 ERC1155 晶体管转给 Owner（救援，**不触发流片**）；当期晶体管（`token == transistors`）是持份人的抵押，只能走 `depositToPool`（入池）或 `sellTransistors`（吃买单卖出），或等份额结清**且** `totalRefunded >= sold × sharePriceBnb`（`HoldersNotMadeWhole`）后提取 —— 只结清份额但只退了半价（钱被晶体管吃掉）时仍然拿不走（S-14）；`pooled` 后 `AlreadyPooled` |
| `transferOwnership(address)` | 写 | 仅 Owner | 转让本期 Owner |

### 4.4 服务费（**挖矿产出**的服务费；认筹款不收）

> ⚠️ **口径勿回退**：这里的「服务费」**只从挖矿产出里计提**。**认筹款不收任何服务费** —— 全额进 `raisedBnb`，只用于买晶体管。链上**不存在**从认购款抽服务费的路径。
> `MAX_SERVICE_FEE_BPS = 1000`（10% 硬顶）约束的是「最多从挖矿产出抽走 10%」，**不是**「不能吃掉认购款」。

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `setServiceFee(uint16 bps, address[] recipients, uint16[] sharesBps)` | 写 | 仅 Owner；**且 `sold == 0`** | 费率 ≤ 1000；收款地址 ≤ **3** 个（`MAX_FEE_RECIPIENTS`）、非零、不重复；**份额合计必须恰为 10000**。费率 > 0 时分成表非空，= 0 时必须为空。**一旦设定永久锁定**，无人认购时也不能改 |
| `depositRevenue()` | 写 payable | **仅 `miningPool`** | **链上唯一收取服务费的地方**：计提 `gross × bps / 10000` 按表切给各收款方，**净额直接并入持份人可领余款（`surplusPool`，`claimSurplus` 领取）**，`revenuePool` 只做累计展示。没有份额时留在 `raisedBnb` 由 `recoverBnb` 扫走 |
| `claimFee()` | 写 | 收款方本人 | 收款方 **pull** 领取。刻意不用 push：入账时若要推给 3 个收款方，任一拒收合约就会让**整笔入账失败**、矿池收益全卡住。pull 把失败面从「矿池」缩小到「单个收款方自己」 |
| `serviceFeeBps` / `serviceFeeSet` | 读 | 任何人 | 费率 / 是否已设定（区分「未设过」与「设为 0」） |
| `feeRecipientCount()` / `feeRecipientAt(uint256)` / `feeSharesBpsAt(uint256)` | 读 | 任何人 | 分成表读取 |
| `pendingFee(address)` / `totalPendingFee()` | 读 | 任何人 | 已计提未领取。**这笔钱不属于 Owner**，`recoverBnb` 扫不走 |
| `revenuePool()` | 读 | 任何人 | **累计**挖矿净收益（已扣服务费），仅展示。真钱已并入 `surplusPool` 由持份人 pull 领取，owner 扫不走、也不会形成死池 |

### 4.5 产出领取（占位）

| 功能 | 说明 |
|---|---|
| `harvest()` | **占位 no-op**：仅在 `scene == Mining` 时不 revert，但无分发 |
| `claim()` | **占位**：返回 0 |

> ⚠️ **产品硬约束**：矿池分配合约接入前，**前端不得宣称「投矿池即见收益」**。前端不提供这两个入口。

### 4.6 状态 / 账本视图

| 功能 | 说明 |
|---|---|
| `scene()` / `phase()` | 场景 / 子态（public 自动 getter） |
| `sold` / `outstandingShares` / `totalShares` / `sharePriceBnb` | 已售 / 当前债务 / 总份 / 每份价 |
| `raisedBnb` | 合约代持 BNB 托管池 |
| `soldOutAt` / `fundingDeadline` | 售罄时刻 / 募集截止 |
| `executionFailed` / `priceLock` | 买料失败标记 / 锁价 |
| `estHashpower` / `nandPrice` / `latchPrice` / `nandCostBasis` / `latchCostBasis` | **仅展示用**，链上逻辑不读（`nandCostBasis` / `latchCostBasis` 例外：`sellTransistors` 用它们当卖出底价，见 S-21） |
| `totalRefunded` / `surplusPaid` | 累计退款本金 / 累计已发余款（**分开记账，互不混入**；`surplusPaid` 是唯一的余款累计量） |
| `market` / `owner` | 晶体管市场与 Owner |
| `miningPool` / `pooled` | 矿池地址 / 是否已入池（不可逆标志） |
| `sharesOf` / `escrowOf` / `refundedOf` / `surplusClaimedOf` | 可用份额 / 挂单锁定 / 已退本金 / 已领余款 |
| `holderCount()` / `holderAt(uint256)` | 持有人枚举（前端 fallback 槽位 `HOLDERS_SLOT = 30`） |
| `listingCount()` / `getListing(id)` | 挂单数量与详情 |
| `surplusPool` / `surplusBase` / `surplusOf(addr)` / `totalPendingSurplus` | 余款 pull 模式账本 |
| `orderFilled()` | 买单是否全成交 |

**双变量份额语义**（重要）：
- `sold` = **单调历史事实**，只在 `subscribe` 增、**退款不减**。owner 执行闸门只看它。
- `outstandingShares` = **当前债务**，退款时递减，是按比例退款的分母。

> ⚠️ 这两个变量**必须分开**：`sold` 供 owner 闸门用（退款不减它），`outstandingShares` 供退款分母用。若合并成一个变量，退款会让 owner 闸门永不成立。

### 4.7 资金与权限底座

| 功能 | 说明 |
|---|---|
| `receive()` | **仅 `market` 可入账**，否则 `DirectTransferNotAllowed`，禁止污染 `raisedBnb` |
| `onERC1155Received` / `onERC1155BatchReceived` | 接收晶体管 |

---

## 5. 资金与份额流

### 5.1 BNB 闭环

| 动作 | BNB 流向 | 账本 |
|---|---|---|
| `subscribe` | 买方 → 合约托管 | `raisedBnb += msg.value` |
| `placeTransistorOrder` | 合约 → 晶体管市场（押金） | `raisedBnb -= cost`，随 `market.placeBid{value}` 转出 |
| `refund` / `openRefund` | 合约 → 认筹地址 | `raisedBnb -=`；拒收地址跳过不阻断批量 |
| `takeListing` | 买方 → **实时付给卖方**（不进托管） | 卖方 `+pay` |
| `depositRevenue` | 矿池 → 合约 | 扣服务费后净额并入持份人可领余款（`surplusPool`） |
| `claimFee` / `claimSurplus` | 合约 → 收款方 / 持有人 | pull |
| `recoverBnb` | 合约 → Owner | 只扫走超出托管额与预留额的呆账 |

- **不变量**：合约 BNB 余额 == `raisedBnb`（托管池）。`receive()` 仅 `market` 可入账是这条不变量的守护。
- 二级市场 BNB **不进托管**，成交即过手，杜绝「只过户份额不结钱」。

### 5.2 退款公式

- 满池退：`份额 × 单价`
- 短池按比例退：`raisedBnb × shares / sold`
- `_shortfall()` 判定是否短池

> ⚠️ **不可改回按份 push**：链上持有人可达数千，一次遍历分发会 Gas DoS 触顶，且某个拒收地址会让整批余款永久锁死。

### 5.3 余款 pull 模式

| 字段 | 语义 |
|---|---|
| `surplusPool` | 已计提的余款总额（`_returnSurplus` 时按份计提） |
| `surplusBase` | 当前轮计提时的份额基数快照（轮内不变） |
| `surplusRound` / `surplusRoundPool` | 第几轮 / 本轮记账金额。旧轮数满后新钱另开一轮，保证反复入账都能领（S-7） |
| `surplusOf(addr)` / `totalPendingSurplus` | 某地址 / 全期待领余款 |
| `pendingSurplus` | 内部记账 |

> ⚠️ **余款必须保持 pull 模式**：持有人可达数千，一次遍历分发会 Gas DoS 触顶，且某个拒收地址会让整批余款永久锁死。
> `recoverBnb` 两个分支都必须为 `surplusPool - surplusPaid` 与 `totalPendingFee` 预留 —— `totalPendingSurplus` 是前者子集，**不可重复加**；`revenuePool` 已在其中，**也不可再加**。

**记提时机有三个，走同一套账本：**

| 触发 | 时机 | 结果 |
|---|---|---|
| `returnSurplus()` | `ready`（晶体管已确认到账），**不结束本期** | 余款立刻按份记提，持份人可立即 `claimSurplus()`；份额不变、晶体管在合约里，随后仍能 `depositToPool()` |
| `depositToPool()` 内部 `_returnSurplus()` | 入池瞬间 | 老合约/没提前退的期次走这条：入池时记提，入池后 `claimSurplus()` 随时领 |
| `depositRevenue()` | `mining`（矿池打款） | 扣完服务费的净额 `_bookSurplus` 进同一个池子：挖矿收益和剩余认筹款一样，持份人 `claimSurplus()` 自己领，**不会锁在合约里** |

> `_returnSurplus` / `_bookSurplus` 是**可累加**的：本轮还没数满时，新到的 BNB 直接加到本轮分子（例：提前退余款之后又有晶体管卖出款进池，再入池）。**轮内绝不能重置 `surplusClaimedShares` / `surplusAllocated`**，否则早期已领的人会被重复记账。
> **本轮份额数满后必须另开一轮**（`surplusRound++`）：老账本里 `surplusCounted[holder] == 持份数` 且游标 == 分母，再加钱的话所有人都算不出可领额，钱会永久留在合约里（S-7）。分母在首笔记账后不会漂移（退款已关闭、转让只在入池后且不改变总量），所以新一轮仍用当前 `outstandingShares`。
> 权益按 `sharesOf + escrowOf` 计：挂单只锁转让权，不锁余款（S-8）。
> 累加会带来一点排序效应：后补的那笔钱只由**尚未领取**的人分，最后一位领完的人拿走全部余数 —— 总额永远不多不少、不会重复发放，但先后领的人分到的比例会有微小差异。想要严格按最终池子比例，就等余款定型（不再有市场回款）后再统一记账。
> `outstandingShares == 0` 时 `_returnSurplus` 直接返回：没有人可以领，钱留在 `raisedBnb` 里由 `recoverBnb` 处理，而不是落进一个永远分不出去的池子。

### 5.4 份额与晶体管

- **份额**：`subscribe` 产生，不可分割记账，可经 `listShares`/`takeListing` 转让（BNB 直付卖方）。
- **晶体管**：`placeTransistorOrder` 在市场挂**买单** → 成交后 `safeTransfer` 到 Campaign（`onERC1155Received` 接收）→ `confirmTransistors` 推进到 `ready` → `depositToPool()` **不可逆**打入矿池。
- **卖出**：官方晶体管市场**没有卖单簿**，所以没有"挂卖"这一步。`sellTransistors(bidId, tokenId, qty)` 直接吃一张别人**已挂的买单**：市场把晶体管转给买单方，并把扣费后的 BNB 记到 `owed(Campaign)`，合约在同一笔交易里 `withdraw()` 提进 `raisedBnb`。价格不得低于本期买入成本（`nandCostBasis` / `latchCostBasis`）。
- 算力 `H = 晶体管数 × P`。链上晶体管数权威来源 = `nandQty + latchQty`（实买成交），**不是发布参数**。

---

## 6. 角色 × 场景 → 前端入口

| 角色 | 场景 | 写入口 |
|---|---|---|
| Factory Owner | 工厂 | `createCampaign`；`removeCampaign`；`transferOwnership` |
| Campaign Owner | 本期 | `setPlan` → `placeTransistorOrder` → `confirmTransistors` / `cancelTransistorOrder` → `sellTransistors`（可选，吃买单卖出部分晶体管）/ `returnSurplus`（可选，退余款不结束本期）/ `setMiningPool` → `depositToPool`；`openRefund` / `abandonOrder` / `markFailed` / `recoverBnb` / `recoverTransistors` / `setMaterialMarket` / `setServiceFee` / `setPhase` / `transferOwnership` |
| 任何人 | mining | `takeListing`（接收他人挂单，接收后成为持份人）；`markFailed`（3 天宽限期后）；`confirmTransistors`（permissionless）；`harvest`/`claim`（占位） |
| 认筹用户 | funding | `subscribe`；超时未售罄 `refund` |
| 持份用户 | mining | `listShares`；`cancelListing`（自己的）；`claimSurplus` / `claimFee` |

**前端导航**（`frontend/src/App.jsx`）：

| 导航 | 对应能力 |
|---|---|
| 认筹 | funding → `subscribe`；executing → 进度 |
| 我的资产 | 持仓、`refund` |
| 资产转让 | mining → 份额转让（**仅挖矿中开放**） |
| 规则与合约 | 说明页 |
| 晶体管市场 | 官方处理器与晶体管市价 + 链上市场 |
| Owner 工作台 | 开期 / 持有人 / 调用 / 调试（**仅 Owner 可见**） |

> ⚠️ **可见性 ≠ 权限**：Owner 工作台入口对「工厂 owner + 本期 Campaign owner」两路地址都显示，但链上执行权只认**本期 Campaign owner**。判成 owner 会让 UI 显示「可执行」而实际交易 revert。

**发布表单（`OwnerCreate`）四张卡**（顺序即业务依赖顺序，右侧**不显示「第 N 步」编号**）：

| 卡片 | 说明 |
|---|---|
| 发行规模 | 募资总额与总份数，**两项都必填**。每份 = 总额 ÷ 份数，只读派生 |
| 募集天数 | 1–3650 整数，链上按 `天 × 86400` 写绝对截止。填 0 会建出创建即已截止的僵尸期次 |
| 本期处理器 | **必选 `<select>`**，选项从链上 `allowedPartsAt` 生成。零地址链上直接 revert |
| 挖矿产出服务费与分成 | 建期后第二笔交易 `setServiceFee`，一次设定永久锁定。**分成比例默认 100**（首行），地址留空必填，最多 **3** 个 |

发布表单的产品口径：
- **不给建议方案**：晶体管数由募资总额反推、算力由执行阶段写入，发布期定不下来 → 给「建议规模」只会让开期人误以为那是承诺。
- **不给官方市价参考**：官方市价是链下 API 且只有买单侧，据此推「建议上限」既不权威也容易被当成承诺。
- **不给单件价格上限**：见 §8 口径 14。
- **开期在链上是两笔交易，但 UI 不讲**：第二笔失败**不影响已建好的期次**，可在 `sold == 0` 时补设。

---

## 7. 官方链上事实

> 以下是**实读链上/官方接口核对过的事实**，不是凭记忆。改代码前请重新核对，不要凭本文档猜。

### 7.1 官方晶体管市场 `0xA6a80C1919a8326022d7c601a488888C13aA16E4`（EIP-1967 代理）

**存在**：

| 接口 | 关键约束 |
|---|---|
| `placeBid(address transistors, uint8 tokenId, uint96 price, uint256 qty) payable` | **`msg.value` 必须精确等于 `price × quantity`**，多/少一分都 revert "wrong value" |
| `bids(uint256 id)` | 返回 **6 元组** `(buyer, transistors, price, tokenId, feeBps, remaining)` |
| `fillBid(uint256 id, uint256 qty)` | 第二参是 **qty**；传 `remaining` 会报 unknown custom error |
| `cancelBid(uint256 id)` | 撤销未成交部分，押金退回买家 |
| `nextBidId()` / `feeBps()` / `owed()` / `withdraw()` | `feeBps() = 100`（1%，**从卖家实收扣**） |

**不存在**：`placeAsk` / `asks` / `nextAskId` / `cancelAsk` / `fillAsk`
→ **官方市场只有买单侧，没有挂卖流程**。因此本章合约已**删除**旧的挂卖逻辑（`placeTransistorAsk` / `cancelTransistorAsk` / `confirmSale` 与 `nandAskId` 等状态），
卖出改为 `sellTransistors(bidId, tokenId, qty)`：吃一张**已挂买单** → `fillBid` → `withdraw()`。合约里不再有任何 `placeAsk` 调用，也不依赖 `marketHasAskSide()` 探测。

> **为什么用读字节码而不是 try/call**：代理 fallback 会让所有调用都 revert，无法区分「函数不存在」与「存在但报错」。
> 市场合约全网共用，`placeBid` 的 `transistors` 接受任意 ERC1155 → TapeOut / Behemoth 两套晶体管在同一个市场买卖；限制只在期次层面（`Campaign.transistors` immutable）。

**主流程（买入）**：`placeBid` → 卖家 `fillBid` → 晶体管到账 → `depositToPool`
**卖出（吃买单）**：`sellTransistors(bidId, tokenId, qty)` → 市场 `fillBid`（把本期晶体管转给买单方）→ `owed(Campaign)` → 同笔交易 `withdraw()` → `raisedBnb`

#### 7.1.1 市场事件（2026-10-23 实读主网日志解出）

> 之前前端写「这版市场合约没有事件，记录按订单状态推算」—— **错的**。市场一直在发事件，
> 是两个原因叠在一起读不到：节点不给历史 `eth_getLogs`，以及事件签名和 Mock 不一致。

| 事件（官方真实签名） | topic0 | 说明 |
|---|---|---|
| `BidPlaced(uint256 indexed id, address indexed buyer, address indexed transistors, uint8 tokenId, uint256 price, uint256 quantity)` | `0xcc402b0b…` | **价是 `uint256`**；Mock 是 `uint96` → 签名不同，拿 Mock ABI 解析必然失败 |
| `BidFilled(uint256 indexed id, address indexed seller, uint256 quantity, uint256 proceeds, uint256 fee)` | `0x8ba8eb46…` | 5 参；`proceeds + fee` = 买家为这批晶体管付出的托管额，`fee` 恒 1% |
| `BidCancelled(uint256 indexed id, uint256 refund)` | `0x434f4081…` | 与 Mock **同签名** |

- 官方市场**没有** `AskPlaced` / `AskFilled` / `AskCancelled` / `ProceedsWithdrawn`（没有卖单侧）。
- 前端 `MATERIAL_MARKET_ABI` 同时保留官方与 Mock 两套同名事件，ethers 按 topic0 选。
- **节点**：`bsc-rpc.publicnode.com` 把历史 `eth_getLogs` 当 archive 请求（403，要 token）、
  `blastapi` 公共端点限流（429），只有 `bsc-mainnet.nodereal.io/v1/<公开key>` 允许 5 万块区间。
  日志读取走 `getLogsWithFailover()` 逐节点试，不能靠 `withReadProvider`（后者只在整体抛错时轮换，
  而日志读取内部是把错误吞掉返回 null）。

### 7.2 官方处理器

| 处理器 | CPU 地址 | 晶体管 ERC1155 | P | 可采购 | 可挖矿 |
|---|---|---|---|---|---|
| TapeOut | `0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C` | `0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087` | 1 | ✅ | ✅ |
| Behemoth | `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | `0xE2DfD802081C7a05341E20b6582b04b908e8550c` | 6 | ✅ | ✅ |

- 官方 mining 合约 `0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46` 的 `processorMultiplier(address)`：TapeOut=1 / Behemoth=6。
- **NAND 与 LATCH 共用同一个 transistors 合约**，`tokenId` 0 / 1。
- ⚠️ **不要引入 Genesis CPU**（`0x50A994E7…` / 晶体管 `0x1d23Bf70…`）：官方 `processorMultiplier = 0`，永远不出矿 —— 让用户花钱买晶体管却换不来收益是最难事后发现的坑。它**不在白名单内**，传进 `createCampaign` 会被 `revert PartsNotAllowed` 拒绝。
- 挖矿资格**只查 `MINEABLE_PROCESSORS` 白名单**，绝不能用「在处理器表里存在」判断。这套防御机制（`mineable` 声明字段、`warnings` 管道、白名单安全边界）要保留。

### 7.3 基础设施

| 项 | 结论 |
|---|---|
| RPC | `bsc-dataseed.bnbchain.org` 可用且**不受 archive 限制**；`bsc-rpc.publicnode.com` 可用但 `eth_getTransactionReceipt` 一律返回 `Archive requests require a personal token`（改用 `eth_getTransactionByHash` + `eth_getBlockReceipts` 取回执）；Binance 官方 seed 全无响应 |
| **合约创建交易** | ⚠️ **`ethers.deployContract` / `factory.deploy()` 在本项目必崩** —— hardhat-ethers 的 `formatTransactionResponse` 把 `to` 格式化为 `allowNull(getAddress, null)`，只放行 `null`/`undefined`，而合约创建交易的 `to` 是**空字符串** → `invalid value for value.to`。注意崩溃点在 `signer.sendTransaction` 的**广播之后**（`checkTx` 回读），交易其实已经成功。**用 `scripts/_deploy.js` 的 `deployContract()`**：崩了会按 CREATE 地址在链上找回执继续，绝不重复部署 |
| 开源验证 | **`hardhat verify` 走不通**：Sourcify API v1 已下线（插件仍在打 v1）；BscScan 路径被本机 `HTTPS_PROXY` 挡着（`api.etherscan.io` 直连返回 000，hardhat 报成 502）。**用 `node scripts/verify-sourcify.js --network bsc`** —— 走 Sourcify v2 的 metadata 端点（standard-json 端点会失败，因为 Sourcify 服务器拉不到已下架的 solc 0.8.24） |
| `eth_getLogs` | 单窗口上限约 5 万块（10 万被拒），需分页；公共 RPC 普遍 403/限流 → 核对 ABI 只能用 `eth_call` |
| 行情 | `api.gateio.ws/api/v4/spot/tickers?currency_pair=BNB_USDT` 可直连；binance/mexc/coinbase 空响应，coinex 503 |
| ethers v6 | **`batchMaxCount` 必须压到 3** —— 默认把同 tick 调用打成 ≤100 的批量数组，drpc 免费档只收 ≤3 → 整批 500 |
| 官方市价 | **主源是链上官方市场的活跃买单**（`nextBidId()` + `bids(id)`，纯 `eth_call`，不扫日志；实测最近 60 笔即覆盖全部 4 个晶体管）。成交事件只作补位（挂单没凑齐时扫一个 20000 块窗口），`tapeout.net/market.json`（经 vite 代理 `/tt-api`）再兜底。**只有买单侧**：买价 = 最高出价，成交价 = 最近成交单价，**都不是本期挂单价** |
| 官方市场 `bids(uint256)` | 返回**六个独立 word**：`buyer / transistors / price / tokenId / feeBps / remaining`（2026-10-23 实测）。与 ABI 里声明的打包形态（`uint96 price` 参与打包）不同，前端是手工解码；`nextAskId()` 直接 revert（没有卖单侧） |

---

## 8. 不可违背的口径（勿回退）

1. **服务费 = 挖矿产出奖励的服务费**。`MAX_SERVICE_FEE_BPS = 1000` 约束的是「最多从挖矿产出抽走 10%」。**认筹款不收任何服务费** —— `subscribe` 付的 BNB 全额进 `raisedBnb`，链上不存在从认购款抽服务费的路径。UI 术语统一「**挖矿产出服务费**」（链上函数名 `setServiceFee`/`serviceFeeBps`/`claimFee` 不动，改名破 ABI）。
2. **`setPlan(uint256 estHashpower)` 只写算力，不写晶体管数**。链上晶体管数权威来源 = `nandQty + latchQty`（晶体管市场实买成交）。晶体管数由募资总额反推，**不是发布参数**。
3. 官方市价主源是**链上官方市场的活跃买单**，不是 `tapeout.net/market.json`（那个只是兜底）。**只有买单侧**，且都不是本期挂单价。
4. `harvest()` / `claim()` 是占位空实现（只为 ABI 稳定）。**产出净额并入 `surplusOf` / `claimSurplus`**，所以收益不会锁死；但**矿池真正接入前，UI 不得宣称「投矿池即见收益」**。
5. 官方市场**没有卖单簿** → **不要恢复任何挂卖/挂卖单接口**。卖出只能 `sellTransistors(bidId, tokenId, qty)` 吃已挂买单（`fillBid` → `withdraw`）。
6. **卖出不得低于本期买入成本**：`sellTransistors` 用 `nandCostBasis` / `latchCostBasis` 当硬底价（`PriceBelowCost`）。没有这条，owner 可以自挂 1 wei 买单再自己吃掉，把持份人的抵押按废价转走（S-21）。成本基准在 `_clearOrder()` 里**不清零**，而且只升不降（`_raiseCostBasis` 取**历史最高单价**）：后续只买另一条腿的单子、或更便宜的补单，都不能把底线清零或拉低（S-22）。0 价买单与「成交后一分钱都没进来」也一并拒掉（`ZeroPrice` / `NoProceeds`）。
7. **退款绝不减少 `sold`**。owner 执行闸门只看 `sold`，退款只减 `outstandingShares`。
8. 余款是 pull 模式：`surplusPool - surplusPaid` **必须**为 `recoverBnb` 预留（`totalPendingSurplus` 是其子集，**不可重复加**）。
9. `refund()` 必须保留「**一份未卖 + 已过募资截止**」的本金出口（`neverSoldOut`）—— Funding 超时期次唯一的退款路径，封掉 = Critical 本金锁死。
10. **官方处理器共两个**：TapeOut（P=1）/ Behemoth（P=6），都有挖矿产出资格。不要引入 Genesis CPU（`processorMultiplier = 0`，永不出矿）。
11. **`processorScale` 不能用 `|| 1`** —— 官方倍数可能是 `0`，`||` 会把它变成 1，算出「有产出」的假象。用 `??` 只兜「查不到」。同理任何「二元三元表达式 + 多处理器」的写法都会静默取错价，必须数据驱动查表。
12. **晶体管价格显示不能固定 `toFixed(5)`** —— 处理器价差可能跨数量级（Behemoth 0.601 / TapeOut 0.053），固定 5 位在低价量级会把 NAND 与 LATCH 显示成同一个价。一律用 `prices.js` 的 `formatUnitPrice(v)`。
13. **`removeCampaign` ≠ 冻结期次**：移除后链上 Campaign 仍在、仍能 `subscribe`、原 owner 仍能 `setPlan`。前端不得据此显示「本期已终止」。移除后第三方可撤单是**设计好的逃生舱**。
14. **工厂没有「默认晶体管」**。`createCampaign` 第 4 参**必选**（零地址 revert），开期人必须从前端显式选一个白名单内的处理器。`Campaign.transistors` 仍 immutable（每期锁定一个），但来源是开期人的选择。
15. **不给单件价格上限**。原因：晶体管市价浮动，链上写死绝对上限后市价涨破 → Owner 按市价挂单被拒 → 期次永久卡在「待挂单」→ 买不到料、进不了矿池、认筹人钱既退不了也产不出产出。**护栏本身变成了更大的风险源**。
16. **可见性 ≠ 权限**：Owner 工作台入口对两路地址都显示，但 `actor.role` 只认本期 Campaign owner。
17. **前端创建期次是链上两笔交易**（`createCampaign` + `setServiceFee`），第二笔失败不影响已建期次。
18. **晶体管是持份人的抵押**：只要合约手上还有本期晶体管、而 `raisedBnb` 不足以按原价覆盖全部未退份额，**所有退款出口必须关闭**（`refund` / `openRefund` / `abandonOrder` 一律 `PartsAreCollateral`）。理由：份额一旦清零，晶体管既没有持份人有资格领、owner 也拿不走（`HoldersNotMadeWhole`），等于烧掉。owner 真想收摊只能：`topUpShortfall()` 补齐 → 按原价退完 → 再取晶体管。
19. **当期晶体管离开合约，必须持份人已按原价收回本金**：`outstandingShares == 0` **且** `totalRefunded >= sold × sharePriceBnb`。只结清份额但只退了折价（钱被晶体管吃掉）时仍然拿不走 —— 这条是 S-14 的最后一道闸。
20. **`returnSurplus()` 是 Ready 的失联兜底**：owner 随时可调，其他人须满 `FAIL_GRACE`。它只把余款记到持份人名下，不搬晶体管、不改归属，因此没有作恶面；不得改回 `onlyOwner`（否则 owner 失联时余款永久锁死，S-16）。
21. **`depositToPool()` 要求「还有份额 + 至少一件晶体管」**：否则晶体管会进池而没有任何持份人分享产出。`setPhase(3)` / `depositToPool` 的前置是 `_readyBasis()`（已成交买单 **或** 晶体管已在手）——部分成交后撤单的期次必须还能进 `ready`，不可回退成只认 `priceLock`（S-17）。

---

## 9. 开发与部署

### 9.1 命令（都是踩过坑的）

```bash
# ⚠️ 必须用 bootstrap.js，npx hardhat 不可用（.bin 符号链接未建）
cd D:/Code/miner/contracts
node ./node_modules/hardhat/internal/cli/bootstrap.js compile
node ./node_modules/hardhat/internal/cli/bootstrap.js test
node scripts/check-size.mjs        # 体积检查；hardhat size 不存在(HH303)

# 前端
cd D:/Code/miner/frontend
npm run build
npm run dev -- --host             # ⚠️ 必须 --host 双栈！只绑 127.0.0.1 会让预览面板走 ::1 时 500

# 部署（⚠️ 必须走 bootstrap.js run——直接 node scripts/x.js --network 不生效，
#  hardhat 不会解析 --network，会静默跑到内置 hardhat 网 31337 上）
cd D:/Code/miner/contracts
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/deploy-bsc.js --network bsc          # 主网（默认只布工厂不开期）
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/deploy-bsc.js --network bscTestnet   # 测试网
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/verify-sourcify.js --network bsc     # 开源验证（**用这个**，hardhat verify 走不通，见 §7.3）
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/testnet-drill.js --network bscTestnet# 测试网完整生命周期演练（16 项断言）
```

> **部署脚本可能「崩在广播之后」**：hardhat-ethers 对合约创建交易的 `to=""` 回读必崩（详见 `scripts/_deploy.js` 头注释）。**交易其实已经广播成功** —— `_deploy.js` 会按 CREATE 地址在链上找回执继续；万一手动恢复，用 `eth_getTransactionByHash` + `eth_getBlockReceipts` 双路径（`eth_getTransactionReceipt` 在 publicnode 一律报 archive 限制）。**绝不重复部署。**

> **端口 5173 是用户自己的 dev server，勿占用。** 探针另起端口（如 5199）且必须先 fetch `/` 校验 title 再测。
> 测试覆盖：开期、认筹、退款、挂单、confirm、Ready 逃生、余款退回（含提前 returnSurplus）、白名单、状态伪造拦截、换市场先提款、显式零服务费、晶体管抵押不可提取、挖矿收益多轮可领、Ready 不可退款、**吃买单卖出（含成本底价/分批/部分卖出后入池）**。
> **不变式套件** `test/Invariants.test.js` 独立校验四条守恒：
> 1. `balance == raisedBnb + (surplusPool − surplusPaid) + totalPendingFee` —— 余额里没有第三种口袋；
> 2. `Σ(sharesOf + escrowOf) == outstandingShares` —— 份额不凭空产生/消失；
> 3. 结算后所有人领完 ⇒ `balance == 0` 且 `recoverBnb()` 必拒（没有该给持份人的钱被扫走）；
> 4. 尾差归最后一位领款人，任意领取顺序下 `surplusPaid == surplusPool`（一分不剩）。
> 另含 6 组固定种子的随机生命周期（随机份额拆分 / 金额零头 / 退出路径 / 领取顺序）与边界拒绝用例。**124 passing**。

### 9.2 主网部署前置

| 项 | 要求 |
|---|---|
| **owner 私钥余额** | **≥ 0.05 BNB**（工厂部署约需 0.024–0.03 BNB） |
| **owner 私钥保管** | **必须多签或硬件钱包**（H-7 接受的唯一硬前置） |
| `MINTER_ADDRESS` | 必须是官方市场 `0xA6a80C1919a8326022d7c601a488888C13aA16E4`（脚本硬断言 + `getCode` 非空） |
| `ALLOWED_PARTS_ADDRESSES` | **恰好覆盖官方两件套**。少一个 → 该处理器的期次开不了；多一个（尤其 Mock）→ 安全边界失效 |
| `CAMPAIGN_PARTS_ADDRESS` | **必填无默认**（本期晶体管合约，须在白名单内） |
| `SHARE_PRICE_BNB` / `TOTAL_SHARES` / `FUNDING_DAYS` | 主网务必显式给（脚本缺省 0.01 / 100 / 7） |
| `SERVICE_FEE_BPS` / `SERVICE_FEE_RECIPIENTS` / `SERVICE_FEE_SHARES_BPS` | 后者合计必须 = 10000；地址 ≤ 3 个、非零、无重复 |
| `OPEN_CAMPAIGN` | 主网开期必须显式设 `1`，否则**只布工厂不收款** |
| Nginx | 生产反代 `/tt-api` → `https://tapeout.net`（dev/preview 的 vite 代理在生产不生效） |
| 确认 | 主网**没有**部署 `MockERC1155` / `MockMaterialMarket`（脚本已硬断言，但需人工确认） |

**部署后核对**：
- `frontend/src/chain/deployments.json` 的 `chainId == 56`、`allowedParts` 含两件套、无废弃字段（`pod`/`bem`/`podIsAdapter`/`officialPod`/`pendingFactoryRedeploy`）
- 旧工厂地址追加进 `legacyFactories`
- 新合约 `holderCount()` 可读（否则前端走 `HOLDERS_SLOT = 30` 硬编码 fallback，而 storage 布局已变）

### 9.3 部署状态

| 网络 | 工厂 | 说明 |
|---|---|---|
| BSC 主网 | `0x6bf44c46b60d631b2ebee490d6ea6fba032be399` | **当前版本**（源码清理版：注释全英、删 `NotSoldOut`/`pendingFeeOf`、`Campaign.market` → `materialMarket`）。构造 `[0xA6a80C19…16E4, [0xCC42ba5D…8087, 0xE2DfD802…8550c]]`，runtime 22,811 字节。部署交易 `0x406d1159…457c`（块 129,239,494，gasUsed 5,078,205）。Sourcify `exact_match`（工厂与期次 #0 均已验证：`0xE92D2f94…3257` creation/runtime 双 exact，2026-10-23T03:06:45Z）。已开期 **#0 `0xE92D2f94…3257`**（Behemoth、0.001 BNB × 1 份、募集 1 天，开期交易 `0x4e53a49a…f27b` 块 129,241,768）：已售罄 1/1、`raisedBnb` 0.001、scene=Executing / phase=Buying、`serviceFeeSet = true`（5% / 2 个分成地址） |
| BSC 测试网 | `0x5edc8254f9533A6c2CD2Ec99D956b1FE0Fa3f56c` | 上一版源码（`Campaign.market()` 时代，脚本按旧名读它）。已完成完整生命周期演练（开期 → 认购售罄 → 挂单成交 → 确认入池 → 份额转让 → 余款领取 → 服务费计提与领取） |
| legacy | `0x2a27334b…` / `0x19a47311…` / `0x638744e7…` / `0xB4315F55…` / `0x29f4A375…`（共 5 个） | 记在 `deployments/bsc.json` 的 `legacyFactories`，其期次仍可调用但不出现在新列表。`0x2a27334b…` 是清理前的主网工厂（Sourcify `exact_match`），名下两期：**#0 `0xb38de12D…5164e`**（TapeOut、0.07 BNB × 1 份、Funding 0 份已售、`serviceFeeSet = false`）与 **`0xB3b9AA36…dfE8`**（Behemoth、0.00005 BNB × 2 份、已售罄 2/2、Executing/Buying、`serviceFeeSet = false`——已有人认购，服务费表永久锁定为不收） |

**源码版本 ↔ 链上的对应关系**：链上在跑的是 git tag `deployed-mainnet-v1`（commit `941906b`）的源码——那一版 `Campaign` 的 getter 是 `market()`、带 `pendingFeeOf()`。当前工作区源码（本次清理 + 改名）只被**新工厂** `0x6bf44c46…` 采用。solc 把源码内容哈希写进字节码尾部 metadata，**任何源码改动（哪怕只改注释）都会让新源码无法逐字节复现旧部署**——所以旧地址的 `exact_match` 与该 tag 绑定，不随仓库演进失效；前端 `abis.js` 同时保留 `materialMarket()` / `market()` 两个 getter，`client.js` 的 `readMaterialMarket()` 对新期次用新名、对 legacy 期次（主网两期 + 测试网全部）回退旧名。

**旧工厂为何不可用**：`0x29f4A375…` 无法响应当前接口，三处不兼容**互相独立、任何一处都足以否决**：

1. `createCampaign` 选择器不匹配 —— 旧工厂 dispatcher 里没有 4 参版本的任何变体。
2. `materialMarket()` getter 不存在（旧版是 `minter()`）。
3. `MAX_FEE_RECIPIENTS = 3` 写在 `Campaign` 内、由工厂 `new Campaign(...)` 传入 → 旧工厂造的期次永远是 8 地址上限。

**无兼容层、无升级路径。** 旧期次是各自独立部署的 `Campaign`，不受影响，但带旧逻辑。

---

## 10. 未解决的问题

> 工厂专项审查共 15 项（F-1~F-15）+ M/L 级条目。**未发现 Critical 级别用户资金损失风险。** 以下按「是否仍需处理」分组。

### 10.1 上线阻断

| 编号 | 问题 | 处理 |
|---|---|---|
| **M-7 / F-14** | `removeCampaign` **不可逆**（无 restore/reRegister） | 调 `removeCampaign` 前确认下标（swap-and-pop 会挪动末项） |

### 10.2 已接受为设计取舍（不修，但有硬前置）

| 编号 | 级别 | 问题 | 接受条件 |
|---|---|---|---|
| **H-7 / L-5** | High | `setPlan`/`setMiningPool`/`setPhase`/`recoverTransistors`/`recoverBnb`/`openRefund`/`abandonOrder`/`markFailed` 全部**即时生效，合约内无任何 timelock** | **owner 私钥必须多签/硬件钱包**；运营上不得单人持有热私钥 |
| **I-5** | Info | `harvest()`/`claim()` 仍是 no-op，但 `depositRevenue` 的净额已并入 `surplusOf` / `claimSurplus`，收益**不会锁死** | `harvest`/`claim` 保持占位仅为 ABI 稳定；产品口径仍不得宣称「投矿池即见收益」 |
| **C-1** | High | 单件价格上限不存在 → owner 可按任意价买空认购托管池 | 认购页强制提示「晶体管数不构成本期承诺」；链上不设上限 |
| **F-2** | Low | 移除后撤单权从 owner 转给公众（任何人可撤 owner 的活单） | 接受；这是 owner 失联时的逃生舱 |
| **F-3** | Medium | 工厂 owner 转移后，新 owner 对老期次 `setPlan` → `NotOwner`，但能 `removeCampaign` | 接受；老 owner 失联时新 owner 无法完全接管 |
| **F-8** | Low | `setPhase` god-mode：可在 `buying` / `ready` 间任意跳 | `ready` 已加数据不变量（`priceLock + orderFilled`），`listed` 需活单；晶体管到货证明只由 `confirmTransistors` 强制，仍越不过入池不可逆性 |
| **F-11** | Low | `sharePriceBnb`/`totalShares` 无上限/可达性校验（`2^200` 份 → 死期次） | 不构成用户资金损失（过截止可走 `neverSoldOut` 全额退）；owner 白花建期 gas |
| **F-15** | Low | `campaigns[]` 无 `MAX_CAMPAIGNS`，owner 可无限建期 | 部署成本自限，不在热路径 |

### 10.3 已知技术债（记册）

| 编号 | 级别 | 问题 | 建议 |
|---|---|---|---|
| **F-1** | Medium | `removeCampaign` 只划登记册、**不冻结期次**：合约仍在、仍可 `subscribe`、原 owner 仍能 `setPlan`、认购款仍锁在 `raisedBnb` | 前端**不得**显示「本期已终止」或隐藏认购入口 |
| **F-4** | Medium | 构造期与建期**均不查地址有无代码 / 是否 ERC1155**，错误推迟到 `confirmTransistors` 才炸（此时认购款已进市场 escrow） | 仅靠 `deploy-bsc.js` 硬断言兜底，**不要绕过脚本手填地址** |
| **M-2** | Medium | `/tt-api` 代理只在 dev/preview 生效，生产托管时官方市价永久失效并**静默回退静态基准** | 生产 Nginx 反代 |
| **M-3** | Medium | `client.js` 有 `HOLDERS_SLOT = 30` 硬编码 fallback；合约 storage 布局已变 | 部署新合约后确认 `holderCount()` 可读 |
| **M-4** | Medium | `useChain.js` 每 10s 全量重读 | 期次少时可接受 |
| **M-5 / L-3** | Medium/Low | Mock 合约全部开关无访问控制，**仍在仓库** | 主网不部署；部署时确认未误带 |
| **F-5** | Low | 白名单**不去重**，`allowedPartsCount()` 如实返回重复后长度 | 白名单别填重复项 |
| **F-6** | Low | `_isAllowed` 是 O(n) 线性扫描（约 2,448 gas/项） | 白名单只 2 项可忽略 |
| **F-9** | Low | `fundingSeconds` **无上下限**：`0` → 出生即过期期次 | 前端 `Math.max(1, days)` 兜底；链上直调可绕过 |
| **F-10** | Low | `transferOwnership` 一步到位、无 `pendingOwner`，转错 → 工厂控制权永久丢失（最坏 = 不能再开新期） | owner 操作时核对地址 |
| **F-12** | Low | `CampaignCreated` 事件不含晶体管合约 | 想知道本期锁了哪个晶体管须额外调 `campaign.transistors()` |
| **F-13** | Low | 报错风格不统一：`allowedPartsAt` 越界有 custom error，`campaigns(i)` 越界是空 revert data `0x` | 前端解码兜住空 revert data |
| **L-1** | Low | 前端 bundle ~820 kB（gzip ~267 kB），超 500 kB 警告线 | 不影响功能 |
| **L-2** | Low | 公共 RPC `eth_getLogs` 403/限流 | 需归档 RPC |
| **L-4** | Low | 挂单**无超时机制**（产品语义如此） | 不设超时 |
| **S-1** | ~~High~~ → 已修 | `revenuePool` 曾经没有出口（`harvest`/`claim` 是 no-op，`recoverBnb` 又整额预留）→ 矿池一打款就永久锁死 | ✅ 已修：`depositRevenue` 的净额直接 `_bookSurplus` 进持份人可领余款，`claimSurplus` 即可领取；`revenuePool` 降级为累计展示值，且从 `recoverBnb` 的预留额里移除（避免重复预留） |
| **S-2** | ~~High~~ → 已修 | `recoverTransistors` 在 `ready` 可把**当期全部晶体管**提给 Owner，而持份人份额仍在 → 晶体管价值等于白送 | ✅ 已修：当期晶体管（`token == transistors`）在 `outstandingShares > 0` 时一律 `SharesOutstanding`；出口只剩 `depositToPool`（入池）/ `sellTransistors`（吃买单卖出）/ 份额结清后提取。`abandonOrder` 也改为**先退款、份额归零后才把晶体管退 Owner** |
| **S-3** | Medium | 部分成交后 `abandonOrder`：已花掉的 escrow 变成了 Owner 手上的晶体管，持份人只按残余池退款 | ✅ 顺序已改为「先退款 → 份额归零 → 再退晶体管」（无法再拿晶体管换掉持份人的钱）；剩余价值差异仍属 H-7 信任前提 |
| **S-4** | Low | `_refundAll` 遍历全部持有人且每人一次外部转账：恶意持有人合约可烧光 63/64 gas，让 `openRefund` / `abandonOrder` 的**批量路径**超块 gas | 单人 `refund()` 是 pull 模式，**资金不会因此锁死**；持有人数上万时考虑分批 |
| **S-5** | Low | 入池后**迟到的市场退款**曾会永久卡在 `raisedBnb`（`recoverBnb` 在 `outstandingShares > 0` 时把 `raisedBnb` 全额预留） | ✅ 已修：`receive()` 在 `pooled` 时直接 `_returnSurplus()` 记入持份人可领余款 |
| **S-6** | Low | `returnSurplus` / `depositToPool` 里的 `pooled` 判断**实际不可达**（`pooled` 必然伴随 `scene == Mining`，前面 `_requireExecuting()` 已拒） | 保留为纵深防御，不是 bug |
| **S-7** | ~~High~~ → 已修 | 余款账本只有一份「已计份额游标」：一轮数满后**再入账**（第二笔挖矿收益、迟到回款）时 `surplusCounted[holder] == 持份数`、游标 == 分母 ⇒ 所有持份人算出的可领额都是 0，钱永久留在合约，`recoverBnb` 还把它当预留额 | ✅ 已修：加 `surplusRound` / `surplusRoundPool` / `surplusCountedRound`，本轮数满后新钱**另开一轮**，反复入账都能领（测试 `a second revenue deposit after everyone claimed is still claimable`） |
| **S-8** | ~~Medium~~ → 已修 | 余款权益只按 `sharesOf` 计：持份人一挂牌（份额进 escrow）可领额立刻变 0，必须撤单才能领；挂单被人买走后这笔余款**再也领不到** | ✅ 已修：权益改按 `sharesOf + escrowOf` 计。挂单只锁转让权，不锁余款；`surplusClaimedShares` 的总量封顶保证不会重复发放（测试 `a seller who lists every share can still claim the accrued surplus`） |
| **S-9** | ~~High~~ → 已修 | `markFailed()` 无相位闸门、`refund()` 又只认 `executionFailed` ⇒ **`ready` 期次**可被标成「执行失败」，持份人按剩余 BNB 退款并清零份额，owner 随后 `recoverTransistors` 拿走晶体管 = 晶体管白送 | ✅ 已修：`markFailed()` 在 `ready` 直接 `UseReturnSurplus`；`refund()` 在 `ready` 直接 `RefundNotAvailable`（双保险，也挡住历史残留的 `executionFailed` 标志）。`ready` 的出口只剩 returnSurplus + depositToPool（测试 `Ready cannot be turned into a refund state`） |
| **S-10** | ~~High~~ → 已修 | `ready` 部分卖出后（旧版 `confirmSale` 会退回 `buying`）手上晶体管少于订单量 ⇒ `_partsOnHand()` 永久为假，`setPhase(3)` / `depositToPool` 全被拒，而 `refund` / `openRefund` / `abandonOrder` / `markFailed` 又都被关掉 → 卖出款与剩余晶体管**双双锁死** | ✅ 已修：拆成两个不变量 —— `_purchaseSettled()`（`priceLock != 0 && orderFilled()`，用于 `setPhase(3)` / `depositToPool`）与 `_readyInvariant()`（再加 `_partsOnHand()`，只由 `confirmTransistors` 要求）。到货证明仍在正常路径上强制，恢复路径不再被「数量必须齐」卡死（测试 `a partly filled round can still return to Ready, sell into a bid and pool what is left`） |
| **S-11** | Medium | 上轮给 `setMaterialMarket` 加的「旧市场 `owed > 0` 就拒绝换市场」会形成环：市场报欠款却 `withdraw()` 失败时，既换不走也提不出，本期逃生全被堵住 | ✅ 改为「先尽力 `withdraw()` 提回托管池；提不出也放行换市场」。诚实的市场不留钱，坏市场不拖死本期（测试 `a market swap drains the proceeds...` / `a market that cannot pay does not block the swap`） |
| **S-12** | Low（残留信任） | 市场合约彻底失活（代理升级成全 revert）时，`listed` 期次无法退出：`setPhase` 拒绝从 `listed` 走、`cancelTransistorOrder` / `markFailed` 都要调市场。此时本金在**市场 escrow** 里，Campaign 本身也无从取回 | 接受：官方市场是信任前提（同 H-7）。资金不在 Campaign 手上，任何本地改动都救不回来；运营上盯市场代理的升级权限 |
| **S-13** | Low | `sellTransistors` / `placeTransistorOrder` 会给市场开 `setApprovalForAll`，卖出后**不回收**（只在换市场时 `_revokeApproval`）。市场若能越权拉走 ERC1155，Campaign 手上的晶体管可被直接转走 | 接受：官方市场为信任前提；若要收紧，可在 `sellTransistors` 后撤销授权（每次多一笔外部调用，按需再评估） |
| **S-14** | ~~High~~ → 已修 | **`ready` 的折价套现绕过**：S-9 只关了 `markFailed`/`refund`，但 owner 仍可 `setPhase(1)` → `openRefund()`（只按**剩余** BNB 退，晶体管价钱那部分不退）→ 份额清零 → `recoverTransistors()` 拿走全部晶体管。持份人拿回半价，晶体管白送 | ✅ 已修（三层）：① 晶体管在手且池子不足以按原价覆盖全部份额时，**一切退款出口关闭**（`refund` / `openRefund` / `abandonOrder` → `PartsAreCollateral`）——否则份额清零后晶体管既无人可领、owner 也拿不走，等于烧掉；② 当期晶体管离开合约要求 `outstandingShares == 0` **且** `totalRefunded >= sold × sharePriceBnb`（`HoldersNotMadeWhole`），只退半价拿不走；③ 新增 `topUpShortfall()` 作为**公平逃生**：owner 自掏腰包补齐缺口 → 持份人按原价全额退回 → 晶体管才归 owner（等于 owner 按成本买下），多补的钱 `recoverBnb` 可扫回。测试 `refund-after-purchase cannot be cashed out into the parts` / `the owner can top up the shortfall and then take the parts fairly` |
| **S-15** | Medium | `refund()` 的 `executionFailed` 分支没有相位限制：`listed` 时押金仍在市场 escrow 里，此时按比例退会把「还没回来的钱」先分掉；更糟的是 `markFailed()` → `_cancelLiveOrder()` → 市场 `cancelBid` 回调期间，市场可直接重入 `refund()`（`executionFailed` 已置位），在退款到账前按旧池子算比例 | ✅ 已修：`executing` 下 `refund()` **只接受 `buying`**（`listed` 的押金未回、`ready` 的晶体管已属持份人）。撤单完成后 `phase` 才是 `buying`，重入窗口关闭（测试 `refunds are closed outside Buying/Listed-cancelled state`） |
| **S-16** | Medium | Ready 里 owner 失联时，余款一直躺在 `raisedBnb`，而 `refund`/`openRefund` 全被关 → 持份人**没有任何出口**（钱和晶体管都锁住） | ✅ 已修：`returnSurplus()` 改为 **owner 随时 / 其他人满 `FAIL_GRACE` 后可调**。它只把余款记到各持份人名下（`claimSurplus` 自取），不搬晶体管、不改归属、无法牟利；owner 失联时资金不再锁死（测试 `anyone can book the leftover BNB after the grace period`） |
| **S-17** | Medium | 部分成交后 `cancelTransistorOrder()` 会 `_clearOrder()` 把 `priceLock` 归零，此时「已买过料」的证据消失：`setPhase(3)` / `depositToPool` 都要求 `_purchaseSettled()` → 永远回不到 `ready`，而退款出口又（因 S-14）关着 → 余款 + 晶体管死锁 | ✅ 已修：恢复路径改用 `_readyBasis()` = 已成交买单 **或 晶体管已在手**；正常到货证明仍由 `confirmTransistors` 的 `_readyInvariant()` 强制（测试 `partial fill can be cancelled, then the leftover is booked and the part is pooled`） |
| **S-18** | Low（残留信任） | `setMiningPool` 由 owner 任意指定：owner 可把池子设成自己地址（入池即拿走晶体管） | 接受（同 H-7）：Campaign owner 恒等于工厂 owner（`createCampaign` 是 `onlyOwner`，不存在第三方自建期次），这是平台权限而非隐藏后门；合约层已保证**无论 owner 怎么操作，持份人的本金不能被按折价清零**（S-14 的 `_holdersMadeWhole`），其余为运营信任。旧版「挂 1 wei 卖单自成交」已被 S-21 的卖出底价堵死 |
| **S-19** | Low | 构造函数 / `setMaterialMarket` / 工厂白名单曾接受**无代码地址**：`placeBid` / `owed()` 对 EOA 返回空数据 → ABI 解码 revert，`cancelTransistorOrder`、`refund`、`claimFee` 全部瘫痪 | ✅ 已修：三处都加 `code.length != 0` 校验（测试 `rejects a market address that has no code`） |
| **S-20** | Low | `depositToPool` 曾在 `outstandingShares == 0` 或持有的晶体管为 0 时也能执行：晶体管会转进矿池而**没有任何持份人**有资格领产出 | ✅ 已修：`ZeroShares` / `InsufficientParts` 双闸门（测试 `refuses to pool when no share or no part is left`） |
| **S-21** | ~~High~~ → 已修 | 改成「吃买单卖出」后，卖出价由**对方买单**决定：owner 可自挂 1 wei 买单再让 Campaign 卖进去，把持份人的抵押按废价转给自己 | ✅ 已修：`sellTransistors` 以 `nandCostBasis` / `latchCostBasis`（下单时锁定的单位买入成本，`_clearOrder` 不清零）为**硬底价**，低于成本直接 `PriceBelowCost`；同时拒绝买自家买单（`SelfTrade`）、拒绝别的晶体管合约/别的 tokenId/超量（`NotABid`）。测试 `sellTransistors refuses bids that are not a valid sale for this round` |
| **S-22** | ~~High~~ → 已修 | **S-21 的底价可被后续下单清零**：`nandCostBasis = nandQty_ == 0 ? 0 : nandPrice_`，第二单只买 LATCH 时 NAND 底价变 0，而第一单买回、仍在本期的 NAND 还在手上 → 折价倒卖的口子重新打开 | ✅ 已修：底价改成 `_raiseCostBasis()` 的**历史最高单价**（只在有量且更高时抬升，永不清零、永不因更便宜的补单被拉低）。测试 `a later order never clears a leg's cost floor` |
| **S-23** | ~~Medium~~ → 已修 | `_isKnownMarket` 线性遍历**无上限**的 `_marketHistory` 数组，而它在 `receive()` 里跑：owner 反复 `setMaterialMarket` 就能把撤单退款 / `withdraw()` 的 gas 撑爆 → 托管款锁死 | ✅ 已修：改成 `mapping(address => bool) _marketSeen`，`receive()` 变成 O(1) |
| **S-24** | Medium → 已修 | 市场结算可能是异步的（钱记在 `owed`，不直接打款）。`cancelTransistorOrder` / `markFailed` 撤单后不提取 `owed`，随后持份人按一个**偏小**的池子做比例退款；`depositToPool` 也可能把尚未提取的卖出款排除在余款记账之外 | ✅ 已修：`_pullOwedSoft()`（尽力提取，提不动也不阻断）接进 `_cancelLiveOrder` 与 `depositToPool` 起点；`openRefund` / `returnSurplus` / `abandonOrder` 仍用严格 `ProceedsPending` 守住「池子必须是最终值」。测试 `cancelling an order also pulls the proceeds the market still owes` |
| **S-25** | Low → 已修 | `sellTransistors` 曾接受**0 价买单**，或成交后市场一分钱都不记（`owed` 为 0）——两种情况都把晶体管白送出去 | ✅ 已修：`price == 0` → `ZeroPrice`；`_pullOwed()` 后 `raisedBnb` 没涨 → `NoProceeds`。测试 `refuses to fill a zero-price bid, so parts can never leave for free` |
| **S-26** | Low → 已修 | `setPhase(2)` 只判「单号 != 0」，而 `confirmTransistors` 不清理单号：`ready` 期次可被伪装成 `listed`（没有剩余量的死单），该状态没有撤销路径，且被 `AlreadyListed` 挡住后续每一次 `setPhase` | ✅ 已修：`setPhase(2)` 要求**至少一条腿在市场上还有剩余量**（`_remaining` 求和 > 0）。测试 `owner can set phase out of Ready...` 里的残留单号断言 |
| **S-27** | Low（接受） | `refund()` 不做 `_owed()` 检查：市场把结算记在 `owed` 且提不动时，单人退款会按偏小的池子比例分配（后来补提的钱只惠及还没退的人）；反过来给 `refund()` 加 `ProceedsPending` 又会让坏市场彻底堵死本金出口 | 接受这个取舍：`withdrawMarketProceeds()` 无权限，任何人随时可把 `owed` 提回；真要分账前应已提干净（`openRefund` / `returnSurplus` / `abandonOrder` 都强制）。单人 pull 保留为「市场坏掉时仍能拿到本金」的最后出口 |
| **S-28** | Low（接受） | `openRefund` / `abandonOrder` 的 `_refundAll()` 是 O(持份人数) 循环（含每人的 BNB 转账），持份人数极大时可能超出区块 gas → 批量出口不可用（单人 `refund()` 仍可用） | 接受：本期份额规模（百级）远低于上限；若未来做万级持份，改为分批 `refundMany(maxCount)`。README §8 已记录 |

---

## 11. 文件索引

| 文件 | 职责 |
|---|---|
| `contracts/Campaign.sol` | 单期主合约 |
| `contracts/CampaignFactory.sol` | 开期工厂 |
| `contracts/interfaces/IMaterialMarket.sol` / `IERC1155.sol` | 外部依赖 |
| `contracts/access/Ownable.sol` | Owner 权限（自写） |
| `contracts/security/ReentrancyGuard.sol` | 防重入（自写） |
| `contracts/mocks/MockMaterialMarket.sol` / `MockERC1155.sol` | 测试替身 |
| `contracts/test-helpers/Rejector.sol` | 拒收合约（测试 pull 模式） |
| `test/Campaign.test.js` | 业务/状态机测试（98 passing） |
| `test/Invariants.test.js` | 账本恒等式、份额守恒、晶体管抵押不变式、随机生命周期、边界拒绝（26 passing） |
| `scripts/deploy-bsc.js` | 主网/测试网部署（带硬断言） |
| `scripts/deploy-factory.js` | 只布工厂 |
| `scripts/deploy.js` | 本地部署 + 开一期示例 |
| `scripts/open-round.js` / `testnet-open-round.js` | 开期 |
| `scripts/verify-published.js` | Sourcify 开源验证（**已被 `verify-sourcify.js` 取代**：它走已下线的 v1 API，失败只留一行 warn） |
| `scripts/verify-sourcify.js` | **实际使用的开源验证**（Sourcify v2 metadata 端点，见 §7.3） |
| `scripts/_deploy.js` | **合约创建交易的安全封装**（绕开 hardhat-ethers 崩溃，见 §7.3） |
| `scripts/_records.js` | 部署记录按网络累积（`legacyFactories` 不被其它网络覆盖冲掉） |
| `scripts/testnet-drill.js` | 测试网完整生命周期演练（16 项断言） |
| `scripts/check-size.mjs` | 合约体积检查 |
| `scripts/_preflight.js` | 部署前只读预检 |
| `scripts/market-debug.js` / `find-source.cjs` | 市场 ABI 探测 |
| `scripts/solve-campaign.cjs` | 测试网模拟挖矿 |

> **业务逻辑变更时请同步更新本文档**与仓库根目录 `MEMORY.md`。
