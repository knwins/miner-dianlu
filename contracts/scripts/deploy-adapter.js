/**
 * Deploy OfficialPodAdapter on BSC mainnet and point the existing factory at it.
 * Does not open a campaign.
 *
 *   npx hardhat run scripts/deploy-adapter.js --network bsc
 */
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const OFFICIAL_POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const BEM = "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a";
const FACTORY = "0xB4315F55CD614d09092f0Fcf75ef34C5ee252c3b";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 56) throw new Error(`需要 BSC 主网，当前 chainId=${net.chainId}`);

  console.log(`网络：${network.name} (chainId ${net.chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);

  const factory = await ethers.getContractAt("CampaignFactory", FACTORY);
  const owner = await factory.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`部署者不是工厂 Owner。owner=${owner}`);
  }

  const adapter = await ethers.deployContract("OfficialPodAdapter", [OFFICIAL_POD, BEM]);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log(`OfficialPodAdapter ：${adapterAddr}`);
  console.log(`  → official ${OFFICIAL_POD}`);

  const tx = await factory.setPod(adapterAddr);
  console.log(`factory.setPod tx ：${tx.hash}`);
  await tx.wait();
  console.log(`factory.pod()     ：${await factory.pod()}`);

  const fePath = join(__dirname, "..", "..", "frontend", "src", "chain", "deployments.json");
  const prev = existsSync(fePath) ? JSON.parse(readFileSync(fePath, "utf8")) : {};
  const out = {
    ...prev,
    network: "bsc",
    chainId: 56,
    deployedAt: new Date().toISOString(),
    bem: BEM,
    bemConfigured: BEM,
    bemIsMock: false,
    pod: adapterAddr,
    podIsAdapter: true,
    officialPod: OFFICIAL_POD,
    factory: FACTORY,
    minter: prev.minter || "0xA6a80C1919a8326022d7c601a488888C13aA16E4",
    deployer: deployer.address,
    notes:
      "PoD 已换成 OfficialPodAdapter。新开期会写入适配器。execute 前当期须持有电路 NFT，startData 须带官方证明，才能 harvest 官方 BEM。",
  };

  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  writeFileSync(join(__dirname, "..", "deployments", "bsc.json"), JSON.stringify(out, null, 2));
  mkdirSync(join(__dirname, "..", "..", "frontend", "src", "chain"), { recursive: true });
  writeFileSync(fePath, JSON.stringify(out, null, 2));

  console.log("\n✓ 已写入 deployments/bsc.json 与 frontend/src/chain/deployments.json");
  console.log("  尚未开期。新开期才会带上适配器；旧期次若有，需单独 setPod。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
