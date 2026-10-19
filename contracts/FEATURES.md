# 合约功能清单（BEM 众筹挖矿）

> 本文档是 **Campaign / CampaignFactory** 及外部依赖接口的完整功能对照表。  
> 权限与状态约束与前端 `frontend/src/fixtures.js` 的 `apply*` 对齐。  
> **用途**：前后端联调与页面信息架构调整时按场景/角色收纳入口，而不是按文件名平铺。  
> **范围**：只描述已部署合约能力；不改合约逻辑。

---

## 1. 业务总览

```
funding（募集）──售罄──► executing（待执行）──execute 成功──► mining（挖矿）
     │ 超时未售罄              │ 买不起 → Buying + executionFailed
     └──── refund ◄───────────┘     ├─ refund / openRefund
                                    └─ 降价 place 重试

executing 子态：buying → listed → ready → execute
              ready / listed ──cancel──► buying（逃生）
mining 主动退出：份额转让；被动：仅超时/失败可 refund（挖矿中不可退本金）
```

| 规则 | 说明 |
|---|---|
| 退出路径 | 主动：`mining` 份额转让；被动：募集超时 / 流片失败时 `refund` |
| 不提供 | 挖矿中本金赎回、任意时刻退出 |
| execute | 仅 Owner；按 `priceLock` 锁价；成功后余量按份退回；买不起回到 `buying` |
| 资金 | 认筹进 `raisedBnb`；转让 BNB 直付卖方；`receive()` revert；无观察期 |

---

## 2. CampaignFactory（开期工厂）

源码：[`contracts/CampaignFactory.sol`](contracts/CampaignFactory.sol)

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `createCampaign(sharePriceBnb, totalShares, feePercent, fundingDays, feeRecipients, feeShareBps, taskId, pod_, netlistHash)` | 写 | 仅 Factory Owner | 创建一期；服务费多地址分成（比例之和 10000）；`pod_=0` 用工厂默认；服务费 1–20% |
| `setPod` / `setBem` / `setMinter` | 写 | 仅 Factory Owner | 更换工厂默认外部依赖；**仅影响之后新开期** |
| `removeCampaign(uint256 index)` | 写 | 仅 Factory Owner | 按索引从工厂列表移除；不销毁链上 Campaign；swap-and-pop |
| `indexOf(address campaign)` | 读 | 任何人 | 返回该期在列表中的索引；不在列表则返回 `campaigns.length`（再调 `removeCampaign` 会 revert `IndexOutOfBounds`） |
| `campaignCount()` | 读 | 任何人 | 已开期次数 |
| `campaigns(uint256 i)` | 读 | 任何人 | 第 i 期地址 |
| `allCampaigns()` | 读 | 任何人 | 全部期次地址（已移除的不再出现） |
| `owner` | 读 | 任何人 | Factory Owner |
| `pod` / `bem` / `minter` | 读 | 任何人 | 当前默认 PoD / BEM / 材料市场（可改） |
| `DEFAULT_NET_WEIGHT_VERIFIED` / `UNVERIFIED` | 常量 | — | 开期写入各期的默认全网权重 |
| `transferOwnership(address)` | 写 | 仅 Owner | 转让工厂所有权（= 改 owner） |

**事件**：`CampaignCreated`；`CampaignRemoved`；`PodUpdated` / `BemUpdated` / `MinterUpdated`

---

## 3. Campaign（单期主合约）

源码：[`contracts/Campaign.sol`](contracts/Campaign.sol)

### 3.1 募集 / 退款

| 功能 | 类型 | 权限 / 场景 | 说明 |
|---|---|---|---|
| `subscribe(uint256 count)` | 写 payable | `funding`；截止前；`msg.value == count × sharePriceBnb` | 认筹整数份；售罄 → `executing` + `buying`，记录 `soldOutAt` |
| `refund()` | 写 | ① `funding` 且超时未售罄；或 ② `executing` 且 `executionFailed` | 本钱包本金原路退、份额清零；有 escrow 锁定时跳过 |
| `openRefund()` | 写 | Owner；`executing` + `buying` | 批量原路退回各认筹地址；拒收地址跳过不阻断整笔。要求没有挂着的卖单、市场 `owed == 0` |
| `abandonOrder()` | 写 | Owner；`executing`（`ready` 除外） | 放弃挂单一步到底：撤买单剩余 + 撤卖单 + 提取市场 `owed` + 按当前池子退款。已买入的元件留在合约里，不会自动卖 |

### 3.2 份额转让（仅 `mining`）

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `listShares(uint256 count, uint256 priceBnbPerShare)` | 写 | 持份人 | 挂单；份额立即进入 escrow |
| `cancelListing(uint256 id)` | 写 | 挂单方或 Owner | 撤单，释放锁定回可用份额 |
| `takeListing(uint256 id, uint256 count)` | 写 payable | 非卖方；精确付款 | 份额过户；BNB 原子付给卖方；**按卖方持仓比例转移 `_claimed`** |

### 3.3 晶体管与流片（仅 Owner + `executing`）

| 功能 | 类型 | 子态流转 | 说明 |
|---|---|---|---|
| `setPlan(uint256 estHashpower, bool capped, uint256 transistorCount)` | 写 | 仅 `funding` 或 `executing`+`buying`；`transistorCount > 0` | 写入预估算力、闸门、需买晶体管数；Listed/Ready/Mining 不可改 |
| `placeTransistorOrder(uint256 count, uint256 unitPriceBnb)` | 写 | `buying` → `listed` | 锁价；失败后仍售罄时可重挂并清 `executionFailed` |
| `cancelTransistorOrder()` | 写 | `listed` → `buying` | 未成交仅 owner 可撤。已有成交时任何人可撤剩余买单。全部成交且元件到账则不能撤 |
| `confirmTransistors()` | 写 | `listed` → `ready` | 确认二级市场成交到账；保留 `priceLock` |
| `execute(bytes tapeoutData, bytes startData)` | 写 | 须 `ready` + 有效锁价/元件数 + 网表匹配 | 买不起 → 失败回 `buying`；买得起 → mint、**余量按份退回**、开矿；禁 cost=0 |
| `rescueUnsentBnb(address to)` | 写 | Owner；`mining` | 测试救援。流片余量被拒收后，把滞留的 `raisedBnb` 转到指定地址，避免卡在本期 |
| `recoverBnb(uint256 amount)` | 写 | 仅 Owner | 测试救援。把卡在本期的 BNB 转给当前 Owner，并记 `BnbRecovered`。募集/待执行只可转出超过 `raisedBnb` 的多余余额；挖矿中还可转出剩余 `raisedBnb` |
| `recoverTransistors(address token, uint256 id, uint256 amount)` | 写 | 仅 Owner；禁止 `listed` / `ready` | 测试救援。把卡在本期的 ERC1155 晶体管转给当前 Owner，并记 `TransistorsRecovered`。挂单中或待流片不可转。不改挂单和场景 |
| `setPod` / `setBem` / `setMinter` | 写 | 仅 Owner | 更换本期外部依赖（主网替换 Mock）；不改经济参数 |
| `setFeeShares(recipients, shareBps)` | 写 | 仅 Owner | 重写服务费分成表；比例之和须为 10000；最多 20 项 |
| `transferOwnership(address)` | 写 | 仅 Owner | 转让本期 Owner |

### 3.4 产出领取（仅 `mining`）

| 功能 | 类型 | 权限 | 说明 |
|---|---|---|---|
| `harvest()` | 写 | 任何人 | 从 PoD `claim` 拉**实际到账**的 BEM（不要求 ≥ `dailyBem` 估算）；服务费按分成表拆分，整除余数转 Owner；净额累加进 `totalDistributed` |
| `claim()` | 写 | 本钱包 | 领取 `pendingBem(msg.sender)`；按地址隔离（F1） |
| `updateNetworkWeight(uint256 verified, uint256 unverified)` | 写 | 仅 Owner | oracle 刷新全网权重（零和产出口径） |

### 3.5 产出视图

| 功能 | 类型 | 说明 |
|---|---|---|
| `dailyBem()` | 读 | 本矿机日产 BEM（wei）；execute 前为 0；口径见 `Emission` 库 |
| `pendingBem(address account)` | 读 | 该地址可领 = `totalDistributed` × 可用份额占比 − 已领 |

### 3.6 状态 / 账本视图

| 功能 | 说明 |
|---|---|
| `scene()` | 场景：`Funding` / `Executing` / `Mining`（public 自动 getter） |
| `phase()` | 子态：`None` / `Buying` / `Listed` / `Ready`（public 自动 getter） |
| `sold` / `totalShares` / `sharePriceBnb` | 已售 / 总份 / 每份价格 |
| `raisedBnb` | 合约代持 BNB 托管池 |
| `soldOutAt` / `fundingDeadline` | 售罄时刻 / 募集截止（无观察期） |
| `executionFailed` / `priceLock` / `transistorCount` | 流片失败标记 / 锁价 / 晶体管数 |
| `hashpower` / `estHashpower` / `capped` | 实际算力 / 预估 / 是否未验证池 |
| `harvestCount` / `totalDistributed` / `totalFeeCollected` / `totalClaimed` / `totalRefunded` | 分发与累计统计 |
| `feeBps` / `feeShares` / `taskId` / `netlistHash` | 服务费总比例、分成表、题目、网表承诺。`feeRecipient()` 兼容返回第一项 |
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
| `start(bytes startData)` | 流片开户，返回权重（`execute` 调用） |
| `claim()` | 拉取可领 BEM 到调用方（`harvest` 调用）；到账为 0 则回退。入账金额是实收，不是 `dailyBem()` 估算 |

官方 PoD 的 `start` / `claim` 参数不同。`OfficialPodAdapter` 对外仍是这套接口。Campaign 发现 `podUsesDelegatecall()` 为真时改用 delegatecall，这样官方看到的调用者是当期合约。

官方 `start` 会 `Ownr()`：调用者必须是该电路 NFT 的 `ownerOf`。不读 ERC1155 晶体管余额。晶体管已经烧掉、记在电路的 `circuitBurn` 上。适配器交回的权重是 `circuitBurn × processorMultiplier`（工本 b\* × P），不是已验证池的设计权重 H。

接入步骤：

1. 部署时设 `USE_OFFICIAL_POD=1`，工厂 `pod` 指向 `OfficialPodAdapter`（不要把 `0x7E2E…` 直接写成 pod）。
2. 市场买单成交后，在 tapeout.net 流片得到电路 NFT，再 `safeTransferFrom` 到当期 Campaign（合约已实现 `onERC721Received`）。
3. 用真实证明打包 `startData`：`node scripts/encode-start-data.js`，或前端流片表单 / `podStart.encodeOfficialStartData`。空证明只对 `MockOfficialPoD` 有效。
4. `execute(tapeoutData, startData)` → 适配器调官方 `start`；之后 `harvest` → 适配器调官方 `claim(key)`。

### 5.2 材料市场（二级市场）

晶体管铸造已结束。本期不调用 `mint`。买入只走官方买单接口：

| 功能 | 说明 |
|---|---|
| `placeBid(transistors, tokenId, price, quantity) payable` | 托管 `price × quantity` BNB，挂买单。NAND tokenId 0，LATCH tokenId 1 |
| `cancelBid(uint256 id)` | 撤销未成交部分，保证金退回买家 |
| `bids(uint256 id)` | 看 `remaining`。为 0 表示该腿已成交 |

### 5.3 IERC20（BEM）

| 功能 | 说明 |
|---|---|
| `balanceOf` / `transfer` | harvest 后合约持有 BEM；claim 转给用户；服务费按分成表转出，余数转 Owner |

---

## 6. 角色 × 场景 → 前端入口对照

按此表组织页面，避免「用户/Owner 平铺无关功能」。

| 角色 | 场景 | 应暴露的写入口 |
|---|---|---|
| Factory Owner | 任意（工厂） | `createCampaign`；`setPod/Bem/Minter`；`removeCampaign`；`transferOwnership` |
| Campaign Owner | 任意（本期） | `setPod/Bem/Minter`；`transferOwnership` |
| 用户 | `funding` | `subscribe`；超时后 `refund` |
| 用户 | `executing` + 失败 | `refund` |
| Owner | `executing` | `setPlan` → `placeTransistorOrder` → `confirmTransistors` / `cancel` → `execute` |
| 用户 / 任何人 | `mining` | `harvest`、`claim` |
| 持份用户 | `mining` | `listShares`、`takeListing`、`cancelListing`（己单） |
| Owner | `mining` | `updateNetworkWeight`；可 `cancelListing` 任意单；`harvest` |

| 角色 | 常用只读 |
|---|---|
| 任何人 | `scene`、`phase`、`sold`、`dailyBem`、`pendingBem`、`sharesOf`、挂单板 |
| Owner | 期次参数、`raisedBnb`、`priceLock`、持有人（需事件反推） |

前端导航已按生命周期收口（`frontend/src/App.jsx`）：

| 导航 | 对应能力 |
|---|---|
| **BEM挖矿认筹** | funding→`subscribe`；executing→进度；mining→`harvest`/`claim` |
| **我的资产** | 持仓、`refund`、`claim` |
| **资产转让** | mining 挂单 / 接单 / 撤单 |
| **规则** | 说明页 |
| **Owner 工作台** | 开期 / 流片 / 持有人 / 调用 / 调试 |

---

## 7. 文件索引

| 文件 | 职责 |
|---|---|
| `Campaign.sol` | 单期：状态机、认筹、退款、转让、晶体管、execute、harvest/claim |
| `CampaignFactory.sol` | 开期工厂 |
| `libraries/Emission.sol` | 日产公式 |
| `interfaces/IPoD.sol` / `IMaterialMarket.sol` / `IERC20.sol` | 外部依赖。晶体管只走材料市场买单 |
| `access/Ownable.sol` | Owner 权限 |
| `security/ReentrancyGuard.sol` | 防重入 |
| `mocks/*` | 测试替身 |

---

*与 [`README.md`](README.md) 互补：README 偏设计叙事与开发命令；本文档偏「功能目录 + 前端收口对照」。业务逻辑变更时请同步更新二者。*
