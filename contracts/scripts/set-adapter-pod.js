/**
 * Finish wiring after deploy-adapter: factory.setPod(adapter) + write deployments.
 *   npx hardhat run scripts/set-adapter-pod.js --network bsc
 */
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const OFFICIAL_POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
const BEM = "0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a";
const FACTORY = "0xB4315F55CD614d09092f0Fcf75ef34C5ee252c3b";
const ADAPTER = process.env.ADAPTER_ADDRESS || "0x3647c71F0B947fd3CFAcF480Ab5a723dF18Bb3c4";
const RPC = "https://1rpc.io/bnb";

async function waitReceipt(hash) {
  const p = new ethers.JsonRpcProvider(RPC, { chainId: 56, name: "bsc" }, { staticNetwork: true });
  for (let i = 0; i < 40; i++) {
    const r = await p.getTransactionReceipt(hash);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`receipt timeout ${hash}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`网络：${network.name}`);
  console.log(`部署者：${deployer.address}`);
  console.log(`适配器：${ADAPTER}`);

  const code = await ethers.provider.getCode(ADAPTER).catch(() => "0x");
  // prefer 1rpc if publicnode fails
  const probe = new ethers.JsonRpcProvider(RPC, { chainId: 56, name: "bsc" }, { staticNetwork: true });
  const liveCode = await probe.getCode(ADAPTER);
  if (liveCode === "0x") throw new Error("适配器地址没有代码");
  console.log(`适配器代码长度：${(liveCode.length - 2) / 2}`);

  const factory = await ethers.getContractAt("CampaignFactory", FACTORY);
  const current = await factory.pod();
  console.log(`当前 factory.pod：${current}`);
  if (current.toLowerCase() === ADAPTER.toLowerCase()) {
    console.log("工厂已指向适配器，跳过 setPod");
  } else {
    const tx = await factory.setPod(ADAPTER);
    console.log(`setPod tx：${tx.hash}`);
    try {
      await tx.wait();
    } catch {
      const r = await waitReceipt(tx.hash);
      if (r.status !== 1) throw new Error("setPod failed");
      console.log(`setPod confirmed in block ${r.blockNumber}`);
    }
  }

  const after = await probe.call({
    to: FACTORY,
    data: ethers.id("pod()").slice(0, 10),
  });
  const podAddr = ethers.getAddress("0x" + after.slice(-40));
  console.log(`factory.pod()：${podAddr}`);
  if (podAddr.toLowerCase() !== ADAPTER.toLowerCase()) {
    throw new Error("setPod 后工厂仍未指向适配器");
  }

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
    pod: ADAPTER,
    podIsAdapter: true,
    officialPod: OFFICIAL_POD,
    factory: FACTORY,
    minter: prev.minter || "0xA6a80C1919a8326022d7c601a488888C13aA16E4",
    campaign: prev.campaign || "",
    deployer: deployer.address,
    notes:
      "PoD 已换成 OfficialPodAdapter。新开期会写入适配器。execute 前当期须持有电路 NFT，startData 须带官方证明，才能 harvest 官方 BEM。",
  };
  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  writeFileSync(join(__dirname, "..", "deployments", "bsc.json"), JSON.stringify(out, null, 2));
  writeFileSync(fePath, JSON.stringify(out, null, 2));
  console.log("✓ deployments 已更新");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
