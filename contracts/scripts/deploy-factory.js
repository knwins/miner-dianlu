// 只部署 CampaignFactory（不部署替身、不开期）。用于换工厂：circuitMarket 是 immutable，
// 换电路市场必须重部署一个工厂。电路 NFT 合约不再有默认（每期开期时显式选），
// 现有期次由旧工厂创建仍可调用，但旧期次用的是旧 ABI，本版前端不再展示。
// 运行：npx hardhat run scripts/deploy-factory.js --network bscTestnet
//       DRY_RUN=1 只打印参数与预估费用，不发交易。
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { collectLegacyFactories, writeDeploymentRecords } = require("./_records");
const { deployContract: safeDeploy, createAddress } = require("./_deploy");

/// @notice 官方 Circuit Market（BSC 主网，EIP-1967 代理）。
const OFFICIAL_CIRCUIT_MARKET = "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f";

/**
 * 官方电路 NFT（ERC721）白名单。
 *
 * 白名单必须包含**两个官方处理器**的电路合约：少一个，那个处理器的期次在主网上开不了。
 * 白名单是部署期安全边界：不在名单里的合约会被工厂直接拒绝，防止把期次指向
 * 可无限 mint 的 MockCircuitNft（那样「电路已到账」的检查就形同虚设）。
 */
const OFFICIAL_CIRCUITS = [
  "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C", // TapeOut
  "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c", // Behemoth
];

function env(...names) {
  for (const name of names) {
    const v = (process.env[name] || "").trim();
    if (v) return v;
  }
  return "";
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const dryRun = process.env.DRY_RUN === "1";

  // 只用新的 CIRCUIT_* 变量名。旧的 MINTER_ADDRESS / ALLOWED_PARTS_ADDRESSES 指向晶体管时代的
  // BEP-1155 合约，留作兜底会把工厂指向错误的电路市场 —— 主网部署绝不允许这种静默回退。
  const market = env("CIRCUIT_MARKET_ADDRESS") || OFFICIAL_CIRCUIT_MARKET;
  const allowedFromEnv = env("ALLOWED_CIRCUITS_ADDRESSES");
  const allowedCircuits = allowedFromEnv
    ? allowedFromEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : OFFICIAL_CIRCUITS;
  if (allowedCircuits.length === 0) throw new Error("电路 NFT 白名单不能为空");

  if (!ethers.isAddress(market)) throw new Error(`电路市场地址不合法：${market}`);
  if ((await ethers.provider.getCode(market)) === "0x") {
    throw new Error(`电路市场 ${market} 在当前链上没有代码`);
  }
  // 白名单里的每一项都必须是**真实部署的 ERC721 集合**（不是 EOA、不是别的标准）。
  const erc165 = new ethers.Interface(["function supportsInterface(bytes4) view returns (bool)"]);
  for (const addr of allowedCircuits) {
    if (!ethers.isAddress(addr)) throw new Error(`电路白名单含非法地址：${addr}`);
    if ((await ethers.provider.getCode(addr)) === "0x") {
      throw new Error(`电路白名单 ${addr} 在当前链上没有代码`);
    }
    const [is721, is165] = await Promise.all([
      ethers.provider.call({ to: addr, data: erc165.encodeFunctionData("supportsInterface", ["0x80ac58cd"]) }),
      ethers.provider.call({ to: addr, data: erc165.encodeFunctionData("supportsInterface", ["0x01ffc9a7"]) }),
    ]).then(([a, b]) => [
      erc165.decodeFunctionResult("supportsInterface", a)[0],
      erc165.decodeFunctionResult("supportsInterface", b)[0],
    ]).catch(() => [false, false]);
    if (!is721 || !is165) throw new Error(`电路白名单 ${addr} 不是 ERC721 合约`);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  const factoryArt = require("../artifacts/contracts/CampaignFactory.sol/CampaignFactory.json");
  const size = (factoryArt.bytecode.length - 2) / 2;
  const runtimeBytes = (factoryArt.deployedBytecode.length - 2) / 2;
  console.log(`网络：${network.name} (chainId ${chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(balance)} BNB`);
  console.log(`Factory 创建码：${size} 字节，运行时 ${runtimeBytes} 字节（上限 24,576）`);
  console.log(`电路市场：${market}`);
  console.log(`电路白名单：${allowedCircuits.length} 项`);
  allowedCircuits.forEach((a, i) => console.log(`   [${i}] ${a}`));
  if (runtimeBytes > 24_576) throw new Error("Factory 运行时代码已超限，先 npm run size 处理体积");

  if (dryRun) {
    const gas = await ethers.provider.estimateGas({ from: deployer.address, data: factoryArt.bytecode }).catch(() => null);
    if (gas) {
      const fee = await ethers.provider.getFeeData();
      const price = fee.maxFeePerGas || fee.gasPrice || 0n;
      console.log(`预估 gas：${gas}，按 ${ethers.formatUnits(price, "gwei")} gwei 约 ${ethers.formatEther(gas * price)} BNB`);
    }
    console.log("\nDRY_RUN=1，未发送交易。");
    return;
  }

  // 先把 CREATE 地址算出来打印：hardhat-ethers 的回读 bug 会让脚本在广播成功后静默退出，
  // 有这个地址就能直接去链上核对，不会误判成「没发出去」再发一次。
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const predicted = createAddress(deployer.address, nonce);
  console.log(`预计 CREATE 地址：${predicted}（nonce ${nonce}）`);

  const factoryDeployed = await safeDeploy("CampaignFactory", [market, allowedCircuits]);
  const factoryAddr = factoryDeployed.address;
  const factory = await ethers.getContractAt("CampaignFactory", factoryAddr);
  console.log(`\n✓ CampaignFactory：${factoryAddr}`);
  console.log(`  部署交易：${factoryDeployed.hash}（块 ${factoryDeployed.blockNumber}）`);
  const onchainSize = (await ethers.provider.getCode(factoryAddr)).length / 2 - 1;
  console.log(`链上运行时代码：${onchainSize} 字节`);
  if (onchainSize !== runtimeBytes) console.warn(`⚠ 链上长度与本地 artifact（${runtimeBytes}）不一致`);

  // 读回构造参数，确认链上配置与预期一致（不是替身地址）。
  const [marketOnChain, nAllowed] = await Promise.all([
    factory.circuitMarket(),
    factory.allowedCircuitsCount(),
  ]);
  if (marketOnChain.toLowerCase() !== market.toLowerCase()) throw new Error("链上 circuitMarket 与预期不一致");
  if (Number(nAllowed) !== allowedCircuits.length) {
    throw new Error(`链上电路白名单数量不一致：期望 ${allowedCircuits.length}，实际 ${nAllowed}`);
  }
  for (let i = 0; i < allowedCircuits.length; i++) {
    const onChain = await factory.allowedCircuitsAt(i);
    if (onChain.toLowerCase() !== allowedCircuits[i].toLowerCase()) {
      throw new Error(`链上电路白名单 [${i}] 与预期不一致：${onChain} ≠ ${allowedCircuits[i]}`);
    }
  }
  console.log(`✓ 电路白名单读回一致（${nAllowed} 项）`);

  const legacy = collectLegacyFactories(network.name, chainId, factoryAddr);
  const out = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    circuitMarket: market,
    /** 电路 NFT 白名单（= 这个工厂能创建的期次可选的电路合约）。 */
    allowedCircuits,
    factory: factoryAddr,
    legacyFactories: legacy,
    campaign: "",
    campaignParams: null,
    deployer: deployer.address,
    factoryDeploymentTx: factoryDeployed.hash,
    factoryDeploymentBlock: factoryDeployed.blockNumber,
    factoryRuntimeBytes: runtimeBytes,
    notes: "电路市场版工厂已部署，尚未开期。开期需显式指定白名单内的 ERC721 电路合约；旧工厂的期次使用旧 ABI，本版前端不再展示。",
  };
  writeDeploymentRecords(network.name, out);
  console.log("地址已写入 deployments 与 frontend/src/chain/deployments.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
