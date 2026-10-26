# contracts · 合约说明

只描述**当前代码**。地址以 `deployments/<network>.json` 与 `frontend/src/chain/deployments.json` 为准。

## 文件

| 路径 | 作用 |
|---|---|
| `CampaignFactory.sol` | 工厂：白名单、创建/移除期次 |
| `CampaignDeployer.sol` | 无状态 `new` Campaign（控工厂体积） |
| `Campaign.sol` | 单期：认筹 → 买电路 → 挖矿 → 退款 / BEM |
| `mocks/` | 测试替身，**禁止上主网** |
| `test/` | Hardhat 测试 |

## 状态机

```text
Funding ──subscribe 售罄──► Executing/Buying ──confirmCircuits──► Ready ──startMining──► Mining
                │                    │
                │ 超时未售罄          │ 判失败 / 池不足 → refund
                └─ refund            │ Ready → 只能 returnSurplus（不能退本金）
```

- **Scene**：`Funding` / `Executing` / `Mining`
- **Phase**（仅 Executing）：`Buying` → `Ready`
- 开期锁定：单价、总份数、募集截止、电路集合

## 权限

单钥匙 `onlyOwner`（主网须多签）。无 operator。

| 谁 | 能做什么 |
|---|---|
| Owner | 设费、买电路、挂卖、开/停矿、开退款、熔断、扫尾差… |
| 任何人 | 认筹、确认到账、领余款/BEM/服务费、领奖励入账、份额转让；宽限期后可 `markFailed` |

## 资金口径

### 认筹

- `subscribe(count)`：`msg.value = count × sharePriceBnb`
- **必须先** `setServiceFee`（含显式 0 费），否则 `ServiceFeeNotSet`
- 认筹 BNB **永不收服务费**，进 `raisedBnb`
- `sold` 只增；退款减 `outstandingShares`

### 服务费（只动 BEM）

- `setServiceFee`：认筹前写一次，永久锁定；费率 ≤ 10%；分成 ≤ 3 地址且合计 100%
- 计提：`claimMiningRewards` / `stopMining` 结算毛产出时
- 领取：分成地址 `claimFee()`（pull）

### 买电路 / 挂卖

- `buyCircuits`：Buying + 已售罄；款从托管扣；Buying 内可多次买
- `confirmCircuits`：持有 ≥1 张 → Ready（之后不能再买）
- `listCircuit`：Ready，或 Mining 且已停挖；`price > 0` 即可（可低于买入成本）
- 有电路挂卖时不能开矿

### 挖矿

- 电路始终在 Campaign；当前实现为**未验证池**一键 `startMining`
- 首张开矿会记账剩余募集款为余款，并进入 Mining
- `claimMiningRewards`：入账 → 扣费 → 按份记账 → 持份人 `claimBem`

### 退出

| 出口 | 何时 | 说明 |
|---|---|---|
| `refund` | 募集超时；或 Buying 且失败/池不足 | 退本金；有电路且池不够 → `CircuitsAreCollateral` |
| `returnSurplus` + `claimSurplus` | Ready | 退未花完的 BNB；期次可继续开矿 |
| `listShares` | Mining | 份额 P2P 转让 |
| `topUpShortfall` | Owner | 补托管，使能按原价退完 |

`openRefund` / `abandonOrder` 只开闸，不代持份人打款。

## 熔断

`halt` 关掉认筹/买入/挂卖/开矿/份额交易；**不挡**退款、领款、撤单、领奖、停挖。

## 不变量（摘要）

1. 电路是份额抵押：池不够按原价退时不能白送走电路  
2. `sold` 单调；债务看 `outstandingShares`  
3. 退款 / 领 BEM / 领费均为 **pull**  
4. 服务费只从 BEM 毛产出扣；认筹 BNB 不扣  

## 官方依赖（BSC）

| 项 | 地址 |
|---|---|
| Circuit Market | `0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f` |
| 工厂 | 见 `deployments.json` |
| TapeOut / Behemoth / PoD / BEM | 见 `deployments.json` |

市场仅卖单；一笔一张 NFT；成交前 NFT 在卖家。

## 命令

```bash
cd contracts
node ./node_modules/hardhat/internal/cli/bootstrap.js compile
node ./node_modules/hardhat/internal/cli/bootstrap.js test
node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/deploy-factory.js --network bsc
```

请用 `bootstrap.js`，不要用 `npx hardhat`。

## 边界

- Owner 单钥匙 → 主网多签  
- BEM 发放节奏由官方 PoD 决定，文档不承诺收益  
- 市场可升级；未挂卖电路仍可开矿或等待恢复  
