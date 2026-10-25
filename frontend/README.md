# frontend · 电路众筹挖矿前端

> 仓库：<https://github.com/knwins/miner-dianlu>
>
> React 19 + Vite 6 + ethers v6。纯前端，无后端、无数据库。

## 1. 运行

```bash
cd frontend
npm install
npm run dev -- --host     # 必须 --host；只绑 127.0.0.1 时预览面板走 ::1 会 500
npm run build             # 生产构建
```

链上配置从 `src/chain/deployments.json` 读取：

```json
{
  "chainId": 56,
  "circuitMarket": "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f",
  "allowedCircuits": ["0xb1024…14C", "0x1f5c…12c"],
  "factory": "",
  "campaign": ""
}
```

`factory` 为空表示尚未部署新工厂：页面只展示模拟数据，不伪造链上事实。

## 2. 目录

| 路径 | 作用 |
|---|---|
| `src/App.jsx` | 主壳、导航、认购/详情页、唯一动作入口 `invokeCall` |
| `src/Owner.jsx` | Owner 工作台：开期、买电路、挂卖、确认、入池、退款 |
| `src/OnChain.jsx` | 链上明细调试面板（读合约状态、逐张买电路） |
| `src/MarketPage.jsx` | 电路市场页：官方处理器市价 + 各期锁定集合 |
| `src/MarketTrades.jsx` | 成交记录 / 市场欠款 / 在售电路 |
| `src/OfficialPricePanel.jsx` | 市价看板（full / compact 两种形态） |
| `src/Calls.jsx` | 合约调用目录 + `callGate` 权限/状态闸门 |
| `src/chain/` | 链上数据层（ABI、client、adapter、config、deployments） |
| `src/prices.js` | 电路目录、静态基准价、成本/算力测算 |
| `src/tapeout.js` | 官方处理器 → 电路集合地址、白名单解析 |
| `src/officialPrices.js` | 官方市场最低挂单价读取 |
| `src/fixtures.js` | 本地模拟引擎（`apply*`）与演示数据 |
| `src/emission.js` | BEM 产出常量与估算 |
| `src/roundState.js` / `dealStatus.js` | 状态文案唯一口径 |

## 3. 链上数据流

```text
deployments.json
      │
      ▼
chain/config.js ──► chain/client.js ──► chain/adapter.js ──► App/Owner/MarketPage
      │                  │                     │
      │                  │                     └─ state → 视图模型（book/round/summary）
      │                  └─ ethers 读写、RPC failover、事件解析
      └─ chainId / 地址 / 浏览器链接
```

- **读**：`client.js` 用 `Promise.all` 批量读 Campaign/Factory/Market，任一旧期次缺 getter 要做降级。
- **写**：`App.invokeCall` 是唯一入口；`fixtures.js` 的 `apply*` 是模拟模式唯一真相源。
- **链上/模拟同构**：按钮文案与校验尽量共用 `Calls.jsx` 的 `callGate` 与 `book` 字段。

## 4. 电路市场页面

### 4.1 官方市价（`officialPrices.js`）

官方市场**只有卖单侧**，所以市价 = **当前最低挂单价（floor）**：

1. `nextListingId()` 读挂单总数；
2. 从最新 id 往回批量 `listings(id)`（每批 60，最多 600）；
3. 过滤 `seller != 0`、`price > 0`，按 `circuits` 集合归位；
4. 每个集合取最低价，写入 `prices[电路 id] = { ask, floor, listed }`；
5. 60 秒 TTL 缓存，同一时刻并发请求去重；
6. 读不到就返回 `{ok:false,error}`，页面退回静态基准价，不崩。

> 不扫 `eth_getLogs`：公共节点对历史日志限制多，而挂单是当前状态，`eth_call` 即可。

### 4.2 市价面板（`OfficialPricePanel.jsx`）

- `full`：每个处理器一张卡，价格 28px，突出「当前最低挂单价」。
- `compact`：开期表单 / Owner 弹窗里的紧凑表格。
- 单位统一 **BNB / 张**。
- 数据来源统一写在卡片底部，不在每个价格格重复标注。

### 4.3 市场页（`MarketPage.jsx`）

- 上：官方市价看板（TapeOut / Behemoth）。
- 下：各期锁定的电路集合、市场地址、工厂白名单状态。
- 工厂白名单来自 `deployments.allowedCircuits` / 链上 `allowedCircuitsCount()`。

## 5. 电路目录与测算（`prices.js`）

- `CIRCUITS`：两个官方处理器各一个 ERC721 集合。
- `DEFAULT_CIRCUIT = "BEHEMOTH_CIRCUIT"`。
- `planTask({parts, circuitId, snapshot})`：
  - 电路总数必须是正整数，否则退回 1；
  - 成本 = 张数 × 单价；
  - 算力 `H = 张数 × P`（TapeOut P=1，Behemoth P=6）；
  - 面积 = 张数，超过 `MINE_GATE_LIMIT` 只能进未验证池。
- 只按「张」计量，单一电路腿。

## 6. 关键页面字段

| 字段 | 含义 |
|---|---|
| `circuitCount` | 累计买入张数（历史，不随卖出下降） |
| `circuitHeldCount` | 当前持有张数（卖出/入池后下降） |
| `circuits` | 本期锁定的 ERC721 集合地址 |
| `listedCircuits` | 当前挂卖的电路（tokenId / listingId / price / cost） |
| `circuitCostBasis(tokenId)` | 该 token 的买入价，挂卖底价 |
| `marketOwed` | 市场欠本期的 BNB（可 `withdrawMarketProceeds`） |
| `priceLock` | 累计买入成本（BNB） |

## 7. Owner 工作流

```text
售罄 → buyCircuits（按挂单价批量买入，成本从 raisedBnb 扣）
     → confirmCircuits（确认持有，进入 Ready）
     → setPlan（算力估算）
     → returnSurplus（可选：先把剩余 BNB 记成余款）
     → setMiningPool
     → depositToPool（不可逆，电路转给矿池）
```

需要变现时（Ready、未入池）：

```text
listCircuit(tokenId, price)  → 等待成交 → withdrawMarketProceeds()
cancelCircuitListing(tokenId) → 撤回挂卖
```

- 挂卖价不得低于 `circuitCostBasis(tokenId)`。
- 先撤掉全部挂卖，才能 `depositToPool`。

## 8. 模拟模式

`fixtures.js` 提供 `applyBuyCircuits` / `applyConfirmCircuits` / `applyListCircuit` /
`applyCancelCircuitListing` 等写函数，用于无钱包预览。

- 模拟数据**不能冒充链上事实**：链上模式的 `partCount` 从 0 开始，不用演示值倒推。
- 链上读不到时，页面显示「—」或「读取中」，不编造数字。

## 9. 常见坑

1. **`vite build` 抓不到运行时错误**：自由变量、TDZ、`undefined.toLocaleString()` 都只在浏览器炸。
   改前端后必须真实打开页面 / 跑探针。
2. **跨组件改字段名要全局搜索消费方**；`Number(undefined)||0` 会把错误静默成 0。
3. **不要恢复已删除的市场接口**：`placeBid` / `fillBid` / `nextBidId` / `openBids` 都是旧模型。
4. **官方市场读取失败不是页面崩溃**：市价是辅助信息，失败要降级到静态基准。
5. **单位统一「张」**：电路是 ERC721 单张交割，不是「颗」。
6. **`deployments.circuitMarket` 是新字段**；旧文档里的 `materialMarket` 是历史名，代码不再引用。
7. **RPC 公共节点会 403/429**：这是节点限流，不是应用错误；不要为此改业务代码。

## 10. 验证

```bash
npm run build
# 开发时手动打开页面，或用 Playwright/无头 Chrome 抓 pageerror
```

探针脚本在 `frontend/scripts/`（Playwright）。它们依赖真实页面与模拟钱包，
改导航名、DOM 锚点或业务规则后要同步更新断言。
