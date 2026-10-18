// 把当前源码与链上字节码一致的工厂、每一期合约提交到 Sourcify。
// 有 BSCSCAN_API_KEY 时再提交 BscScan。
// 运行：npx hardhat run scripts/verify-published.js --network bscTestnet
const { ethers, run, network } = require("hardhat");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const META = "a2646970667358221220";
const SOURCIFY = "https://sourcify.dev/server";

function metaHash(bytecode) {
  const code = String(bytecode || "").toLowerCase();
  const i = code.lastIndexOf(META);
  if (i < 0) return "";
  return code.slice(i + META.length, i + META.length + 64);
}

function artifactOf(file) {
  return JSON.parse(readFileSync(join(__dirname, "..", "artifacts", "contracts", file), "utf8"));
}

function bundleFromInfo(info) {
  return {
    compilerVersion: info.solcLongVersion,
    stdJsonInput: {
      language: info.input.language,
      sources: info.input.sources,
      settings: info.input.settings,
    },
  };
}

function compilerBundle() {
  const dir = join(__dirname, "..", "artifacts", "build-info");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const newest = files
    .map((name) => ({ name, mtime: require("node:fs").statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return bundleFromInfo(JSON.parse(readFileSync(join(dir, newest.name), "utf8")));
}

function bundleMatching(contractFile, contractName, chainMeta) {
  const dir = join(__dirname, "..", "artifacts", "build-info");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const info = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const deployed = info.output?.contracts?.[contractFile]?.[contractName]?.evm?.deployedBytecode?.object;
    if (!deployed) continue;
    const hex = String(deployed).startsWith("0x") ? deployed : `0x${deployed}`;
    if (metaHash(hex) === chainMeta) return bundleFromInfo(info);
  }
  return null;
}

async function sourcifyVerify(chainId, address, contractIdentifier, compilerVersion, bundle = compilerBundle()) {
  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "TapeOut-miner/0.1 (https://github.com/knwins/tapeout)",
    },
    body: JSON.stringify({
      stdJsonInput: bundle.stdJsonInput,
      compilerVersion: compilerVersion || bundle.compilerVersion,
      contractIdentifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 || body.customCode === "already_verified") {
    console.log(`${address} 已在 Sourcify 开源验证（exact_match）`);
    console.log(`开源验证：https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/`);
    return;
  }
  if (!res.ok) {
    throw new Error(`Sourcify ${res.status} ${address} ${JSON.stringify(body).slice(0, 500)}`);
  }
  const id = body.verificationId;
  if (!id) {
    console.log(`已提交 ${address}`, JSON.stringify(body).slice(0, 300));
    return;
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${SOURCIFY}/v2/verify/${id}`, {
      headers: { "user-agent": "TapeOut-miner/0.1 (https://github.com/knwins/tapeout)" },
    });
    const status = await poll.json().catch(() => ({}));
    if (!status.isJobCompleted) continue;
    if (status.error) {
      const code = status.error.customCode || "";
      const message = status.error.message || "";
      if (code === "already_verified" || /already verified/i.test(message)) {
        console.log(`${address} 已在 Sourcify 开源验证（exact_match）`);
        console.log(`开源验证：https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/`);
        return;
      }
      throw new Error(`${address} ${code} ${message}`);
    }
    const match = status.contract?.runtimeMatch || status.contract?.match;
    console.log(`${address} Sourcify ${match || "verified"}`);
    console.log(`开源验证：https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/`);
    return;
  }
  throw new Error(`Sourcify 仍在处理 ${address} ${id}`);
}

async function verifyOne(chainId, address, contract, compilerVersion, constructorArguments) {
  await sourcifyVerify(chainId, address, contract, compilerVersion);
  if (process.env.BSCSCAN_API_KEY) {
    await run("verify:verify", { address, contract, constructorArguments });
  }
}

async function verifyPublished() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (!chainId || network.name === "hardhat") {
    console.log("本地网络跳过开源验证");
    return;
  }
  const depPath = join(__dirname, "..", "..", "frontend", "src", "chain", "deployments.json");
  const dep = JSON.parse(readFileSync(depPath, "utf8"));
  if (dep.podIsAdapter && dep.pod) {
    const adapterCode = await ethers.provider.getCode(dep.pod);
    const adapterBundle = bundleMatching(
      "contracts/OfficialPodAdapter.sol",
      "OfficialPodAdapter",
      metaHash(adapterCode)
    );
    if (!adapterBundle) {
      console.log(`跳过适配器 ${dep.pod}：没有与链上字节码一致的编译记录`);
    } else {
      await sourcifyVerify(
        chainId,
        dep.pod,
        "contracts/OfficialPodAdapter.sol:OfficialPodAdapter",
        adapterBundle.compilerVersion,
        adapterBundle
      );
    }
  }

  const factories = [dep.factory, ...(dep.legacyFactories || [])].filter(Boolean);
  const campaignArt = artifactOf("Campaign.sol/Campaign.json");
  const factoryArt = artifactOf("CampaignFactory.sol/CampaignFactory.json");
  const campaignMeta = metaHash(campaignArt.deployedBytecode);
  const factoryMeta = metaHash(factoryArt.deployedBytecode);
  const compilerVersion = campaignArt.metadata ? JSON.parse(campaignArt.metadata).compiler.version : "0.8.24";
  const factoryAbi = [
    "function allCampaigns() view returns (address[])",
    "function pod() view returns (address)",
    "function bem() view returns (address)",
    "function minter() view returns (address)",
  ];
  const campaignAbi = [
    "function sharePriceBnb() view returns (uint256)",
    "function totalShares() view returns (uint256)",
    "function feeBps() view returns (uint16)",
    "function fundingDeadline() view returns (uint64)",
    "function feeShareCount() view returns (uint256)",
    "function feeShareAt(uint256) view returns (address,uint16)",
    "function taskId() view returns (uint256)",
    "function pod() view returns (address)",
    "function bem() view returns (address)",
    "function minter() view returns (address)",
    "function netlistHash() view returns (bytes32)",
    "function owner() view returns (address)",
    "function netWeightVerified() view returns (uint256)",
    "function netWeightUnverified() view returns (uint256)",
  ];

  for (const factoryAddr of factories) {
    const code = await ethers.provider.getCode(factoryAddr);
    const f = new ethers.Contract(factoryAddr, factoryAbi, ethers.provider);
    if (metaHash(code) === factoryMeta) {
      await verifyOne(chainId, factoryAddr, "contracts/CampaignFactory.sol:CampaignFactory", compilerVersion, [
        await f.pod(),
        await f.bem(),
        await f.minter(),
      ]);
    } else {
      console.log(`跳过工厂 ${factoryAddr}：链上字节码与当前源码不一致`);
    }
    let campaigns = [];
    try {
      campaigns = await f.allCampaigns();
    } catch (e) {
      console.log(`读工厂期次失败 ${factoryAddr}：${e.message || e}`);
      continue;
    }
    for (const addr of campaigns) {
      const campCode = await ethers.provider.getCode(addr);
      if (metaHash(campCode) !== campaignMeta) {
        console.log(`跳过 ${addr}：链上字节码与当前源码不一致`);
        continue;
      }
      const c = new ethers.Contract(addr, campaignAbi, ethers.provider);
      const n = Number(await c.feeShareCount());
      const recipients = [];
      const shares = [];
      for (let i = 0; i < n; i++) {
        const [recipient, shareBps] = await c.feeShareAt(i);
        recipients.push(recipient);
        shares.push(shareBps);
      }
      await verifyOne(chainId, addr, "contracts/Campaign.sol:Campaign", compilerVersion, [
        await c.sharePriceBnb(),
        await c.totalShares(),
        await c.feeBps(),
        await c.fundingDeadline(),
        recipients,
        shares,
        await c.taskId(),
        await c.pod(),
        await c.bem(),
        await c.minter(),
        await c.netlistHash(),
        await c.owner(),
        await c.netWeightVerified(),
        await c.netWeightUnverified(),
      ]);
    }
  }
}

const invoked = process.argv.some((arg) => String(arg).replace(/\\/g, "/").endsWith("scripts/verify-published.js"));
if (invoked) {
  verifyPublished().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { verifyPublished };
