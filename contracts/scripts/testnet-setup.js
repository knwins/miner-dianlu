// 测试网准备：部署 MockERC1155（晶体管合约，供工厂默认写入与卖方交割）。
// 电路 NFT / BEM / PoD 已随流片逻辑移除，不再部署。
// 运行：npx hardhat run scripts/testnet-setup.js --network bscTestnet
const { ethers } = require("hardhat");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network ${net.name} chainId ${net.chainId}`);
  console.log(`deployer ${deployer.address} ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);

  const parts = await ethers.deployContract("MockERC1155");
  await parts.waitForDeployment();

  const out = {
    chainId: Number(net.chainId),
    deployer: deployer.address,
    parts: await parts.getAddress(),
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
