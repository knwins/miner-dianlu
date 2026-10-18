// 验证单期 Campaign 开源。用法：
// CAMPAIGN=0x... BSC_RPC=https://bsc-rpc.publicnode.com npx hardhat run scripts/verify-one-campaign.js --network bsc
const { ethers, run } = require("hardhat");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const META = "a2646970667358221220";
const SOURCIFY = "https://sourcify.dev/server";
const ADDRESS = process.env.CAMPAIGN || "0x1422465447807675Fdaae57aEffb38eaa918f0Cf";
const CONTRACT = "contracts/Campaign.sol:Campaign";

function metaHash(bytecode) {
  const code = String(bytecode || "").toLowerCase();
  const i = code.lastIndexOf(META);
  if (i < 0) return "";
  return code.slice(i + META.length, i + META.length + 64);
}

function bundleMatching(chainMeta) {
  const dir = join(__dirname, "..", "artifacts", "build-info");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const info = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const deployed = info.output?.contracts?.["contracts/Campaign.sol"]?.Campaign?.evm?.deployedBytecode?.object;
    if (!deployed) continue;
    const hex = String(deployed).startsWith("0x") ? deployed : `0x${deployed}`;
    if (metaHash(hex) !== chainMeta) continue;
    return {
      compilerVersion: info.solcLongVersion,
      stdJsonInput: {
        language: info.input.language,
        sources: info.input.sources,
        settings: info.input.settings,
      },
    };
  }
  return null;
}

async function sourcifyVerify(chainId, address, bundle) {
  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "TapeOut-miner/0.1 (https://github.com/knwins/tapeout)",
    },
    body: JSON.stringify({
      stdJsonInput: bundle.stdJsonInput,
      compilerVersion: bundle.compilerVersion,
      contractIdentifier: CONTRACT,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 || body.customCode === "already_verified") {
    console.log(`${address} 已在 Sourcify 开源验证（exact_match）`);
    console.log(`开源验证：https://repo.sourcify.dev/${chainId}/${address}`);
    return;
  }
  if (!res.ok) throw new Error(`Sourcify ${res.status} ${JSON.stringify(body).slice(0, 500)}`);
  const id = body.verificationId;
  if (!id) {
    console.log("已提交", JSON.stringify(body).slice(0, 300));
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
        console.log(`开源验证：https://repo.sourcify.dev/${chainId}/${address}`);
        return;
      }
      throw new Error(`${code} ${message}`);
    }
    const match = status.contract?.runtimeMatch || status.contract?.match;
    console.log(`${address} Sourcify ${match || "verified"}`);
    console.log(`开源验证：https://repo.sourcify.dev/${chainId}/${address}`);
    return;
  }
  throw new Error(`Sourcify 仍在处理 ${id}`);
}

async function constructorArgs(address) {
  const c = await ethers.getContractAt("Campaign", address);
  const n = Number(await c.feeShareCount());
  const recipients = [];
  const shares = [];
  for (let i = 0; i < n; i++) {
    const [recipient, shareBps] = await c.feeShareAt(i);
    recipients.push(recipient);
    shares.push(shareBps);
  }
  return [
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
    await c.transistors(),
  ];
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const code = await ethers.provider.getCode(ADDRESS);
  if (!code || code === "0x") throw new Error(`${ADDRESS} 链上没有代码`);
  const bundle = bundleMatching(metaHash(code));
  if (!bundle) throw new Error(`${ADDRESS} 找不到与链上字节码一致的编译记录`);
  console.log(`编译器 ${bundle.compilerVersion}`);
  await sourcifyVerify(chainId, ADDRESS, bundle);
  if (process.env.BSCSCAN_API_KEY) {
    try {
      await run("verify:verify", {
        address: ADDRESS,
        contract: CONTRACT,
        constructorArguments: await constructorArgs(ADDRESS),
      });
      console.log(`BscScan 已提交：https://bscscan.com/address/${ADDRESS}#code`);
    } catch (e) {
      console.log(`BscScan 跳过：${e.message || e}`);
    }
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
