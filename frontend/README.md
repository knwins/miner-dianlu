# frontend · 前端说明

React 19 + Vite 6 + ethers v6。无后端。业务规则以 [`contracts/README.md`](../contracts/README.md) 为准。

## 运行

```bash
cd frontend
npm install
npm run dev -- --host
npm run build
```

链上地址：`src/chain/deployments.json`。

## 页面怎么对应合约

```text
认筹页          subscribe · 本期全景（RoundFacts）
我的资产        refund / claimSurplus / claimBem / 领奖励
领取服务费      claimFee（仅分成地址可见）
资产转让        listShares / takeListing（仅 Mining）
合约工作台      Owner：开期、设费、买电路、确认、开矿、挂卖、开退款
电路市场        官方市价与集合（外链 tapeout.net 挑单）
```

## Owner 最短路径

```text
createCampaign → setServiceFee →（募集售罄）
  → buyCircuits → setPlan → confirmCircuits
  → returnSurplus? → startMining
  → claimMiningRewards
```

- 未 `setServiceFee`：认筹按钮关闭，链上也会 `ServiceFeeNotSet`
- Buying 可多次买入；`confirmCircuits` 后不能再买
- 挂卖电路须 Ready，或 Mining 且已停挖；有挂卖不能开矿

## 用户怎么退钱

| 情况 | 在哪点 | 链上 |
|---|---|---|
| 募集超时未售罄 | 认筹页 / 我的资产 | `refund` |
| Buying 失败或池不足 | 资产「退款」（Owner 可能先开闸） | `markFailed` + `refund` |
| 有电路且池不够原价退 | 按钮关闭 | 先 `topUpShortfall` |
| Ready 有剩余募集款 / 卖电路货款 | Owner 退余款或开矿记账 → 资产领取 | `returnSurplus` + `claimSurplus` |
| 已在挖矿 | 资产转让 | `listShares` |

Ready **不能** `refund` 本金。卖电路货款进托管后按份记余款，持份人 **pull** 自领。

## 易混字段

| 界面上说 | 含义 |
|---|---|
| 已售 `sold` | 历史累计售出，只增不减 |
| 未退 `outstandingShares` | 已售未退，退款分母用这个 |
| 托管池 | `raisedBnb`，买电路扣减；市场货款可再进池 |
| 待领余款 | 已 `returnSurplus` 记账、尚未 `claimSurplus` 的 BNB |
| 未入账产出 | PoD 里还没 `claimMiningRewards` 进本期 |
| 可领 BEM | 已记账、可 `claimBem` 的净值份额 |
| 挖矿产出服务费 | 只从 BEM 毛产出扣；分成地址 `claimFee` 自领 |

## 认筹页本期摘要（RoundFacts）

全阶段常驻：电路 / 处理器 / 发行参数 / 服务费率；下方身份（Owner·合约）、已售/未退·托管·余款。  
服务费分成表不在认筹页展示（Owner 工作台设定，分成地址自领）。挖矿态另加产出指标；操作分流到资产页。

## 认筹记录

全阶段卡片「认筹记录」：读 `holderCount` / `holderAt` + `sharesOf` / `refundedOf`，**不扫** `Subscribed` 日志。  
列：地址、持份（含挂单锁仓）、约合 BNB、已退本金。无认筹时间戳；转让后的买家也会入列。

## 代码入口

| 路径 | 作用 |
|---|---|
| `App.jsx` | 导航；写操作唯一入口 `invokeCall`；`RoundFacts` / `RoundHub` |
| `Owner.jsx` | Owner 工作台 |
| `FeeClaims.jsx` | 服务费领取 |
| `Calls.jsx` | 合约目录 + `callGate` |
| `chain/` | ABI、读写、适配、部署配置 |
| `roundState.js` | 阶段文案唯一来源 |

数据流：`deployments.json` → `client` → `adapter` → 页面。

## 注意

1. 真机打开页面验证；`vite build` 抓不到运行时错误  
2. 公共 RPC 限流时优先 `eth_call`，少扫日志  
3. 勿恢复旧买单市场接口（`placeBid` / `fillBid`）  
