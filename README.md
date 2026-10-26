# miner-dianlu · 电路众筹挖矿

> 仓库：<https://github.com/knwins/miner-dianlu>

用 BNB **按份认筹**一期矿机。售罄后由 Owner 在官方电路市场买入 ERC721 电路，确认到账后合约调用官方 PoD 开矿。产出是 **BEM**：先扣开期写死的服务费，剩下的按份额分给持份人。

## 一句话流程

```text
认筹（BNB 托管）→ 买电路 → 确认到账 → 开矿 → 领 BEM
```

## 钱怎么走

| 钱 | 去向 |
|---|---|
| 认筹 BNB | 全部进托管，**不收服务费**；用来买电路 |
| 没花完的 BNB | Ready 后按份退回（余款） |
| 挖矿 BEM | 先扣服务费给分成地址，净值按份给持份人 |

## 怎么退出

| 阶段 | 做法 |
|---|---|
| 募集超时 / Buying 失败或池不够 | `refund` 退本金 |
| Ready（电路已到账） | `returnSurplus` 退未花完的募集款；**不能**再原路退本金 |
| Mining | `listShares` 把份额转让给别人 |

没有「本金+收益一键赎回」。电路 NFT 一直留在本期合约里（期次本身是矿工）。

## 开期必做

1. `createCampaign`
2. **立刻** `setServiceFee`（含「费率 0」也要写一次）  
   未设费时链上拒绝认筹（`ServiceFeeNotSet`），避免费率被抢先锁死。

## 目录

| 路径 | 内容 |
|---|---|
| [`contracts/`](contracts/) | 合约、测试、部署 |
| [`frontend/`](frontend/) | Vite + React 前端 |
| [`MEMORY.md`](MEMORY.md) | 部署地址与踩坑（给开发会话用） |

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
```

> 本仓库请用 `bootstrap.js`，不要用 `npx hardhat`。

## 文档

- 合约状态机 / 接口 / 部署：[`contracts/README.md`](contracts/README.md)
- 前端页面与字段：[`frontend/README.md`](frontend/README.md)
