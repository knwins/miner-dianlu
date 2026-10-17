# 合约功能清单（BEM 众筹挖矿）

> 本文档是 **Campaign / CampaignFactory** 及外部依赖接口的完整功能对照表。  
> 权限与状态约束与前端 `frontend/src/fixtures.js` 的 `apply*` 对齐。  
> **用途**：前后端联调与页面信息架构调整时按场景/角色收纳入口，而不是按文件名平铺。  
> **范围**：只描述已部署合约能力；不改合约逻辑。

---

## 1. 业务总览

```
funding（募集）──售罄──► executing（待执行）──execute──► mining（挖矿）
     │ 超时未售罄              │ 流片失败
     └──── refund ◄───────────┘

executing 子态：buying → listed → ready → execute
mining 唯一主动退出：份额转让（list / take / cancel）
```

| 规则 | 说明 |
|---|---|
| 退出路径 | 主动：`mining` 份额转让；被动：募集超时 / 流片失败时 `refund` |
| 不提供 | 本金赎回、收益赎回、任意时刻退出 |
| execute | 不可逆、仅 Owner；按 `priceLock` 锁价结算 |
| 资金 | 认购进 `raisedBnb` 托管；转让 BNB 直付卖方；`receive()` revert |

---

## 2. CampaignFactory（开期工厂）

源码：[`contracts/CampaignFactory.sol`](contracts/CampaignFactory.sol)

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `createCampaign(sharePriceBnb, totalShares, feePercent, fundingDays, feeRecipient, taskId, pod_, executeDelay, netlistHash)` | 写 | 仅 Factory Owner | 创建一期 Campaign；参数上链后不可改；`pod_=0` 用工厂默认；`executeDelay=0` 默认 48h；服务费 1–20% |
| `campaignCount()` | 读 | 任何人 | 已开期次数 |
| `campaigns(uint256 i)` | 读 | 任何人 | 第 i 期地址 |
| `allCampaigns()` | 读 | 任何人 | 全部期次地址 |
| `owner` | 读 | 任何人 | Factory Owner（= 各期 Campaign Owner） |
| `pod` / `bem` / `minter` | 读 | 任何人 | 全局注入的 PoD / BEM / 晶体管铸造器 |
| `DEFAULT_EXECUTE_DELAY` | 常量 | — | 默认观察期 48 hours |
| `DEFAULT_NET_WEIGHT_VERIFIED` / `UNVERIFIED` | 常量 | — | 开期写入各期的默认全网权重 |
| `transferOwnership(address)` | 写 | 仅 Owner | 转让工厂所有权（Ownable） |

**事件**：`CampaignCreated(index, campaign, feeRecipient, taskId, netlistHash, sharePriceBnb, totalShares)`

---

## 3. Campaign（单期主合约）

源码：[`contracts/Campaign.sol`](contracts/Campaign.sol)

### 3.1 募集 / 退款

| 功能 | 类型 | 权限 / 场景 | 说明 |
|---|---|---|---|
| `buy(uint256 count)` | 写 payable | `funding`；截止前；`msg.value == count × sharePriceBnb` | 认购整数份；售罄 → `executing` + `buying`，记录 `soldOutAt` |
| `refund()` | 写 | ① `funding` 且超时未售罄；或 ② `executing` 且 `executionFailed` | 本钱包本金原路退、份额清零；有 escrow 锁定时拒绝 |

### 3.2 份额转让（仅 `mining`）

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `listShares(uint256 count, uint256 priceBnbPerShare)` | 写 | 持份人 | 挂单；份额立即进入 escrow，不可重复挂/领 |
| `cancelListing(uint256 id)` | 写 | 挂单方或 Owner | 撤单，释放锁定回可用份额 |
| `takeListing(uint256 id, uint256 count)` | 写 payable | 非卖方；精确付款 | 份额过户；BNB **原子付给卖方**（不进托管） |

### 3.3 晶体管与流片（仅 Owner + `executing`）

| 功能 | 类型 | 子态流转 | 说明 |
|---|---|---|---|
| `setPlan(uint256 estHashpower, bool capped, uint256 transistorCount)` | 写 | Owner 任意（通常 execute 前） | 写入预估算力、是否被挖矿闸门拦住、需买晶体管数 |
| `placeTransistorOrder(uint256 count, uint256 unitPriceBnb)` | 写 | `buying` → `listed` | 锁价快照 `priceLock`，进入挂单中 |
| `cancelTransistorOrder()` | 写 | `listed` → `buying` | 取消挂单、清锁价与晶体管数 |
| `confirmTransistors()` | 写 | `listed` → `ready` | 确认二级市场成交到账；保留 `priceLock` |
| `execute(bytes tapeoutData, bytes startData)` | 写 | 须 `ready` + 观察期满 + `keccak256(tapeoutData)==netlistHash` | 按锁价 `mint` 晶体管；`PoD.start` 开矿入 `mining`；买不起 → `executionFailed` 可退（清锁价可重试） |

### 3.4 产出领取（仅 `mining`）

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `harvest()` | 写 | 任何人 | 从 PoD `claim` 拉日产 BEM；扣服务费打给 `feeRecipient`；`harvestCount++`；次数不限（日产 > 0 即可） |
| `claim()` | 写 | 本钱包 | 领取 `pendingBem(msg.sender)`；按地址隔离（F1） |
| `updateNetworkWeight(uint256 verified, uint256 unverified)` | 写 | 仅 Owner | oracle 刷新全网权重（零和产出口径） |

### 3.5 产出视图

| 功能 | 类型 | 说明 |
|---|---|---|
| `dailyBem()` | 读 | 本矿机日产 BEM（wei）；execute 前为 0；口径见 `Emission` 库 |
| `pendingBem(address account)` | 读 | 该地址可领 = 每轮净产 × harvestCount × 份额占比 − 已领 |

### 3.6 状态 / 账本视图

| 功能 | 说明 |
|---|---|
| `status()` | 场景：`Funding` / `Executing` / `Mining` |
| `executePhase()` | 子态：`None` / `Buying` / `Listed` / `Ready` |
| `sold` / `totalShares` / `sharePriceBnb` | 已售 / 总份 / 每份价格 |
| `raisedBnb` | 合约代持 BNB 托管池 |
| `soldOutAt` / `fundingDeadline` / `executeDelay` | 售罄时刻 / 募集截止 / 观察期秒数 |
| `executionFailed` / `priceLock` / `transistorCount` | 流片失败标记 / 锁价 / 晶体管数 |
| `hashpower` / `estHashpower` / `capped` | 实际算力 / 预估 / 是否未验证池 |
| `harvestCount` / `totalDistributed` / `totalFeeCollected` / `totalClaimed` / `totalRefunded` | 分发与累计统计 |
| `feeBps` / `feeRecipient` / `taskId` / `netlistHash` | 服务费、收费地址、题目、网表承诺 |
| `pod` / `bem` / `minter` / `owner` | 外部依赖与 Owner |
| `netWeightVerified` / `netWeightUnverified` | 全网权重 |
| `sharesOf(addr)` / `escrowOf(addr)` | 可用份额 / 挂单锁定 |
| `claimedOf(addr)` / `refundedOf(addr)` | 已领 BEM / 已退 BNB |
| `listingCount()` / `getListing(id)` | 挂单数量与详情 |

### 3.7 资金与权限底座

| 功能 | 说明 |
|---|---|
| `receive()` | **直接 revert**（`DirectTransferNotAllowed`），禁止污染 `raisedBnb` |
| `transferOwnership(address)` | 仅 Owner；转让本期所有权 |

---

## 4. Emission 库（产出口径）

源码：[`contracts/libraries/Emission.sol`](contracts/libraries/Emission.sol)

- 公式：`日产 = H × 全网日产 × 池分成 / 全网权重`
- 已验证池分成 99%；`capped=true`（闸门拦住）进未验证池，分成 1%
- 全网日产常量：`7200` BEM / 天（第 1 纪元）；权重由 Owner `updateNetworkWeight` 刷新

---

## 5. 外部依赖接口

### 5.1 IPoD（挖矿）

| 功能 | 说明 |
|---|---|
| `start(bytes startData)` | 流片开户，返回权重 H（`execute` 调用） |
| `claim()` | 拉取可领日产 BEM 到调用方（`harvest` 调用） |
| `arm()` | 可选预注册 |

### 5.2 ITransistorMinter（晶体管）

| 功能 | 说明 |
|---|---|
| `mint(uint256 count) payable` | 按锁价买入；须 `msg.value == count × 锁定单价` |
| `quote(uint256 count)` | 当前报价（前端锁价参考） |

### 5.3 IERC20（BEM）

| 功能 | 说明 |
|---|---|
| `balanceOf` / `transfer` | harvest 后合约持有 BEM；claim 转给用户；服务费转收费地址 |

---

## 6. 角色 × 场景 → 前端入口对照

按此表组织页面，避免「用户/Owner 平铺无关功能」。

| 角色 | 场景 | 应暴露的写入口 |
|---|---|---|
| Factory Owner | 任意（工厂） | `createCampaign` |
| 用户 | `funding` | `buy`；超时后 `refund` |
| 用户 | `executing` + 失败 | `refund` |
| Owner | `executing` | `setPlan` → `placeTransistorOrder` → `confirmTransistors` / `cancel` → `execute` |
| 用户 / 任何人 | `mining` | `harvest`、`claim` |
| 持份用户 | `mining` | `listShares`、`takeListing`、`cancelListing`（己单） |
| Owner | `mining` | `updateNetworkWeight`；可 `cancelListing` 任意单；`harvest` |

| 角色 | 常用只读 |
|---|---|
| 任何人 | `status`、`executePhase`、`sold`、`dailyBem`、`pendingBem`、`sharesOf`、挂单板 |
| Owner | 期次参数、`raisedBnb`、`priceLock`、持有人（需事件反推） |

前端导航已按生命周期收口（`frontend/src/App.jsx`）：

| 导航 | 对应能力 |
|---|---|
| **BEM挖矿认购** | funding→`buy`；executing→进度；mining→`harvest`/`claim` |
| **我的资产** | 持仓、`refund`；mining 下转让三件套 |
| **规则** | 说明页 |
| **Owner 工作台** | 开期 / 流片 / 持有人 / 调用 / 调试 |

---

## 7. 文件索引

| 文件 | 职责 |
|---|---|
| `Campaign.sol` | 单期：状态机、认购、退款、转让、晶体管、execute、harvest/claim |
| `CampaignFactory.sol` | 开期工厂 |
| `libraries/Emission.sol` | 日产公式 |
| `interfaces/IPoD.sol` / `ITransistorMinter.sol` / `IERC20.sol` | 外部依赖 |
| `access/Ownable.sol` | Owner 权限 |
| `security/ReentrancyGuard.sol` | 防重入 |
| `mocks/*` | 测试替身 |

---

*与 [`README.md`](README.md) 互补：README 偏设计叙事与开发命令；本文档偏「功能目录 + 前端收口对照」。业务逻辑变更时请同步更新二者。*
