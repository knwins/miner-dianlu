// 测试网准备：部署 MockCircuitMarket + MockCircuitNft（电路 NFT，供工厂白名单与交割使用）。
// 两者都有 chainId 56 部署即 revert 的护栏，主网绝不能出现。
// 运行：npx hardhat run scripts/testnet-setup.js --network bscTestnet
const { ethers } = require("hardhat");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network ${net.name} chainId ${net.chainId}`);
  console.log(`deployer ${deployer.address} ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);

  const market = await ethers.deployContract("MockCircuitMarket", [250]);
  await market.waitForDeployment();
  const circuits = await ethers.deployContract("MockCircuitNft");
  await circuits.waitForDeployment();

  const out = {
    chainId: Number(net.chainId),
    deployer: deployer.address,
    circuitMarket: await market.getAddress(),
    circuits: await circuits.getAddress(),
    deployedAt: new Date().toISOString(),
  };
  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  const file = join(__dirname, "..", "deployments", `mocks-${net.chainId}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
