# miner-dianlu · 电路众筹挖矿

> 仓库：<https://github.com/knwins/miner-dianlu>

用户用 BNB 认购一期矿机的份额；募满后，Owner 到**官方电路市场**买入该期锁定的
ERC721 电路 NFT，确认到账后打入矿池；挖矿产出按份额分配。退出路径只有**挖矿份额转让**，
不存在本金/收益赎回。

## 目录

| 目录 | 内容 |
|---|---|
| `contracts/` | Hardhat 合约、部署脚本、开源验证脚本、测试 |
| `frontend/` | Vite 6 + React 19 前端（`frontend/src/chain/` 是链上数据层） |
| `MEMORY.md` | 项目记忆（当前状态、部署地址、工程踩坑、用户偏好） |

## 电路市场

- **官方 Circuit Market（BSC 主网）**：`0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f`（ERC1967 UUPS 代理）
- **只有卖单侧**：`list(circuits, tokenId, price)` / `delist(id)` / `buy(id, expectedPrice)` / `withdraw()`
- 交易标的是 **ERC721 电路 NFT**，一笔成交一张；卖家在成交前仍持有 NFT（非托管）
- 官方电路集合：TapeOut `0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C`、
  Behemoth `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c`

项目合约只做**买方**：`Campaign.buyCircuits()` 用募集款按挂单价买入，确认持有后
`confirmCircuits()` 进入 `Ready`；需要变现时可把持有的电路按不低于成本价重新挂回市场。

## 快速开始

```bash
# 合约
cd contracts
node ./node_modules/hardhat/internal/cli/bootstrap.js compile
node ./node_modules/hardhat/internal/cli/bootstrap.js test

# 前端
cd frontend
npm install
npm run dev -- --host
npm run build
```

> `npx hardhat` 在本仓库不可用，必须走 `bootstrap.js`（见 `contracts/README.md`）。

## 文档

- 合约接口、状态机、业务口径、部署与验证：[`contracts/README.md`](contracts/README.md)
- 前端结构、链上数据流、页面与工具模块：[`frontend/README.md`](frontend/README.md)
- 项目记忆：[`MEMORY.md`](MEMORY.md)
