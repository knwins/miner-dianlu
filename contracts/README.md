# contracts · 电路众筹挖矿合约

> 仓库：<https://github.com/knwins/miner-dianlu>
>
> 本文档只描述**当前代码**。链上会随部署变化，地址以 `deployments/<network>.json` 与
> `frontend/src/chain/deployments.json` 为准。

## 0. 目录

| 路径 | 作用 |
|---|---|
| `contracts/CampaignFactory.sol` | 期次工厂：电路白名单、创建/移除期次 |
| `contracts/Campaign.sol` | 单期主合约：认筹、买电路、份额转让、入池、退款、收益 |
| `contracts/interfaces/ICircuitMarket.sol` | 官方电路市场（卖单侧）接口 |
| `contracts/interfaces/IERC721.sol` | 电路 NFT 接口 |
| `contracts/mocks/` | 测试替身（MockCircuitMarket / MockCircuitNft），**禁止上主网** |
| `scripts/` | 部署、开源验证、测试网演练、链上探针 |
| `test/` | Hardhat 测试（当前 76 passing） |

## 1. 官方电路市场

| 项 | 值 |
|---|---|
| 市场地址（BSC 主网） | `0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f` |
| 代理形态 | ERC1967 UUPS |
| 交易标的 | ERC721 电路 NFT（一笔成交一张） |
| 挂单 | `list(circuits, tokenId, price)` |
| 撤单 | `delist(id)` |
| 买入 | `buy(id, expectedPrice)`，`msg.value` 必须等于挂单价 |
| 查询 | `listingFor(circuits, tokenId)` / `listingOf(...)` / `listings(id)` / `nextListingId()` |
| 卖家收款 | `owed(seller)` + `withdraw()`（pull） |

- **只有卖单侧**：没有买单簿、没有 `placeBid` / `fillBid`。
- **非托管**：成交前 NFT 仍在卖家手里；`buy` 当笔完成付款与 NFT 交割。
- 官方电路集合：
  - TapeOut `0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C`
  - Behemoth `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c`

## 2. 工厂

```solidity
constructor(address circuitMarket_, address[] allowedCircuits_)
```

- `circuitMarket_`：非零、有代码。
- `allowedCircuits_`：至少一项、每项非零且有代码；部署后**不可增删**。
- 主网白名单必须是上面两个官方集合；测试网可用 `MockCircuitNft`。
- 白名单是安全边界：防止把期次指向可无限 mint 的 Mock，从而伪造「电路已到账」。

```solidity
function createCampaign(
    uint256 sharePriceBnb,
    uint256 totalShares,
    uint64 fundingSeconds,
    address circuits_
) external onlyOwner returns (address campaign)
```

- `circuits_` 必选，必须在白名单内；一期只锁定一个集合。
- `sharePriceBnb == 0` / `totalShares == 0` 直接拒绝。
- Campaign 的 owner 初始化为工厂 owner。

其它：`campaignCount()` / `campaigns(i)` / `isRegistered(addr)` /
`allowedCircuitsCount()` / `allowedCircuitsAt(i)` / `isAllowedCircuits(addr)` /
`removeCampaign(index)`（onlyOwner，swap-and-pop）。

> `removeCampaign` 不等于冻结期次：Campaign 仍可调用，只是从前端主列表消失；
> 工厂移除后对公众只开放**可逆**的电路撤单权。

## 3. Campaign 状态机

```text
Funding ──售罄──► Executing/None ──(setPhase 1)──► Executing/Buying
                                                   │
                                                   │ buyCircuits() 买入
                                                   │ confirmCircuits()
                                                   ▼
                                              Executing/Ready
                                                   │ depositToPool()
                                                   ▼
                                                Mining
```

- `Scene`：`Funding` / `Executing` / `Mining`
- `Phase`：`None` / `Buying` / `Ready`
- `circuits` 与份额价、总份数、截止时间一样，开期后不可更换。
- `circuitMarket` 可由 owner 通过 `setCircuitMarket` 更换（会先提取旧市场欠款并撤销旧授权）。

## 4. 权限

**单钥匙**：没有 operator/admin 等二级角色。所有管理入口 `onlyOwner`，
owner 应当是**多签 / 硬件钱包**。

Owner 可调用（非完整列表）：`setCircuitMarket` / `setMiningPool` / `setPlan` /
`setServiceFee` / `setPhase` / `buyCircuits` / `listCircuit` / `depositToPool` /
`openRefund` / `abandonOrder` / `topUpShortfall` / `halt` / `resume` /
`recoverBnb` / `recoverCircuits` / `transferOwnership`。

任何人可调用：`subscribe`（付 BNB）、`confirmCircuits`（只校验持有）、
`withdrawMarketProceeds`、`cancelCircuitListing`（工厂移除后）、`markFailed`
（宽限期后）、`refund` / `claimSurplus` / `claimFee`、`depositRevenue`（仅矿池）。

## 5. 资金与电路路径

### 5.1 认筹

- `subscribe(count)`：`msg.value == count × sharePriceBnb`，不可超卖。
- 售罄后进入 `Executing`；份额可退款前一直由 `outstandingShares` 记录。

### 5.2 买电路（卖方市场，买方是 Campaign）

```solidity
function buyCircuits(
    uint256[] listingIds,
    uint256[] tokenIds,
    uint96[] prices
) external onlyOwner
```

- 前置：`Executing` + `Phase.Buying` + 已售罄 + 未熔断。
- **不额外收 BNB**：采购款直接从 `raisedBnb` 扣，链上要保证 `cost <= raisedBnb`。
- 买不起：置 `executionFailed = true` 并返回，**不 revert、不滚整批**。
- 批量是原子的：任一挂单失效 / 价格不符 / 卖家已转走 NFT → 整批回滚。
- 每张买入记录 `circuitCostBasis[tokenId] = price`（后续卖出的成本底价）。
- 事件：`CircuitBought(tokenId, listingId, price)`、`CircuitsBought(n, cost)`、
  `ExecutionFailed(cost, raisedBnb)`。

`confirmCircuits()`：任何人可调，要求合约当前真的持有至少一张电路 NFT，
进入 `Ready`。不搬代币。

### 5.3 卖回市场

```solidity
function listCircuit(uint256 tokenId, uint96 price) external onlyOwner
function cancelCircuitListing(uint256 tokenId) external
```

- 仅 `Ready`、未入池、未熔断。
- `price >= circuitCostBasis[tokenId]`，否则 `PriceBelowCost`。
- 只做**单 token approve**，不用 `setApprovalForAll`。
- NFT 不离开 Campaign；成交后市场把净额记到 `owed(address(this))`，
  由 `withdrawMarketProceeds()` 提回 `raisedBnb`。
- 撤单：期次在册时仅 owner；工厂移除后任何人可撤（可逆逃生）。

### 5.4 入池（不可逆）

```solidity
function depositToPool() external onlyOwner
```

- 仅 `Ready`、未入池、未熔断；要求矿池地址已设置、无在售电路、至少一张电路、至少一份未清份额。
- 先把剩余 BNB 记为持份人可领余款（`surplusPool`），再把**全部持有的电路 NFT**
  转给 `miningPool`，最后置 `pooled = true`，进入 `Mining`。
- 入池后 `refund` / `recoverCircuits` / 再次入池全部关闭。

### 5.5 退款与余款

- `refund()`：唯一本金出口。售罄前超时、或 `executionFailed` 后，持份人自领。
  退款不减少 `sold`，只减少 `outstandingShares`。
- `returnSurplus()`：`Ready` 时把剩余 BNB 记成余款，不结束期次，之后仍可入池。
- `claimSurplus()`：持份人按份额领余款。
- 电路在手且池子不足以按原价覆盖全部份额时，退款出口返回 `CircuitsAreCollateral`；
  owner 可先 `topUpShortfall()` 补齐，再退款 / 取回电路。
- `openRefund()` / `abandonOrder()` 只置失败标志与开闸，**不遍历持份人转账**。

### 5.6 挖矿收益

- `depositRevenue()`：只有 `miningPool` 可调；扣服务费后净额进入余款池。
- `claimFee()`：服务费收款方自领。
- `harvest()` / `claim()` 目前是占位实现，不发放 BEM。

## 6. 份额转让

- `listShares(count, price)`：仅 `Mining`；份额进入 escrow。
- `cancelListing(id)`：挂单方或 owner；释放 escrow。
- `takeListing(id, count)`：接收方付 BNB，份额与 BNB 原子结算。
- 余款权益按 `sharesOf + escrowOf` 计，挂单不失去余款资格。

## 7. 熔断

`halt()` / `resume()` 均 `onlyOwner`。

- `whenLive` 只挡**入口**：`subscribe` / `buyCircuits` / `listCircuit` /
  `depositToPool` / `listShares` / `takeListing`。
- `refund` / `claimSurplus` / `claimFee` / `cancelListing` /
  `cancelCircuitListing` / `markFailed` / `openRefund` / `returnSurplus` /
  `abandonOrder` / `depositRevenue` **永远不被熔断挡住**。

## 8. 关键不变量

1. **电路是份额的抵押**：份额未结清且未按原价退完时，当期电路不能离开合约
   （只能入池或按不低于成本的价卖回市场）。
2. **卖出底价 = 该 token 的买入价**：`circuitCostBasis[tokenId]`，低于它 `PriceBelowCost`。
3. **退款不减少 `sold`**：售罄闸门只看 `sold`，退款只减 `outstandingShares`。
4. **退款/开闸只 PULL 不 PUSH**：不遍历持份人，gas 恒定，拒收 BNB 的地址不能卡死整批。
5. **入池不可逆**：`depositToPool` 永远 `onlyOwner`，工厂移除后也不对公众开放。
6. **熔断只关入口，不关出口**。
7. **换市场先提旧账**：`setCircuitMarket` 对旧市场 `withdraw()`，并撤销旧授权。
8. **`price` 不允许为 0**：买入价格、挂卖价格都拒绝 0。

## 9. 部署与验证

```bash
cd contracts

# 编译 / 测试（必须走 bootstrap.js）
node ./node_modules/hardhat/internal/cli/bootstrap.js compile
node ./node_modules/hardhat/internal/cli/bootstrap.js test

# 只布工厂（主网推荐；不部署 Mock、不开期）
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/deploy-factory.js --network bsc

# 完整部署（测试网会部署 MockCircuitMarket + MockCircuitNft）
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/deploy-bsc.js --network bscTestnet

# 开源验证
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/verify-sourcify.js --network bsc
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/verify-bscscan.js --network bsc
```

环境变量（详见脚本头）：

- `CIRCUIT_MARKET_ADDRESS`（留空 = 官方主网电路市场；**不再兼容旧名 `MINTER_ADDRESS`**，旧地址指向已于废弃的晶体管市场）
- `ALLOWED_CIRCUITS_ADDRESSES`（留空 = 官方 TapeOut / Behemoth；脚本会逐个校验 `supportsInterface(0x80ac58cd)`，不是 ERC721 直接中止）
- `DEPLOYER_PRIVATE_KEY`、`DRY_RUN=1`

主网现状（chainId 56，2026-10-25）：

| 角色 | 地址 |
| --- | --- |
| 工厂 `CampaignFactory` | `0x6768039789439a9da2044926293d8cc46ee4225e` |
| 电路市场 | `0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f` |
| 电路合约 TapeOut（ERC721） | `0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C` |
| 电路合约 Behemoth（ERC721） | `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` |

工厂已部署但**尚未开期**（`campaignCount == 0`）。开期时必须显式指定白名单内的 ERC721 电路合约。

> 合约创建交易不要依赖 hardhat-ethers 的回读：`scripts/_deploy.js` 会先算出 CREATE 地址再广播，
> 回读崩溃时按 CREATE 地址找回执；`deploy-factory.js` 还会在发交易前打印预计地址，
> 避免「其实已上链、脚本却静默退出」被误判成失败而重复部署。

## 10. 测试

当前 `76 passing`，覆盖：

- 工厂白名单 / 创建 / 移除
- 认筹、售罄、退款
- 单张与批量买电路、价格/挂单失效回滚、买不起置失败
- `confirmCircuits` 持有校验
- 挂卖 / 撤单 / 成本底价 / 换市场提款
- 入池不可逆、余款、份额转让、服务费、熔断
- 账本不变量与随机生命周期

## 11. 已知边界

- **官方市场是信任前提**：市场代理若被升级成拒绝服务，挂单中的电路无法成交，
  但 Campaign 仍持有未挂单的电路，仍可入池或等待市场恢复。
- **`harvest` / `claim` 尚未实现**：BEM 分发不在本合约内；不要在前端承诺投池即见 BEM 收益。
- **owner 单钥匙**：必须使用多签；合约内没有 timelock。
- **旧工厂期次**：保留在 `legacyFactories`，ABI 可能有旧 getter（`market()` 等），
  前端读取时做降级，不要用新期次的假设套旧期次。
