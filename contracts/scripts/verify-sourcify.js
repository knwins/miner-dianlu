// 开源验证：走 Sourcify v2 API 直提（不依赖 hardhat-verify 插件）。
//
// 为什么不用 `hardhat verify`：
//   - hardhat-verify@2.1.3 的 Sourcify 路径打的是 /server/check-all-by-addresses，
//     而 Sourcify 已下线 API v1（返回 404 "API v1 is removed"）。
//   - Etherscan/BscScan 路径在本机会走 HTTPS_PROXY，本机代理对 api.etherscan.io 不通
//     （curl 返回 000），hardhat 会报成 "Proxy response (502)"。
//
// 为什么走 metadata 端点而不是 standard-json 端点：
//   Sourcify 服务器拉不到 solc 0.8.24（该版本已从 solc-bin 下架），
//   standard-json 端点会失败在 "Failed fetching solc v0.8.24 for platform bin"。
//   metadata 端点用编译产物里的 metadata.json 走比对，不需要重新下载编译器。
//
// 顺带：metadata 端点验证成功后 Sourcify 会自动把源码转发提交给 BscScan，
//   所以不必在本机再单独打 Etherscan 接口（那条路被代理挡着）。
//
// 运行：node scripts/verify-sourcify.js --network bsc
//      node scripts/verify-sourcify.js --network bscTestnet
const { ethers, network } = require("hardhat");
const { readFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const SOURCIFY_V2 = "https://sourcify.dev/server/v2";

/** 读部署记录。 */
function readDeployment() {
  const file = join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * 找出与链上 runtime 字节数一致的那份编译产物。
 * 仓库里 build-info 会有多份（源码改过就会新增），字节数对不上的那份提交必然失败。
 * 注意按「本次要验证的合约」取字节码——验证 Campaign 时不能拿 CampaignFactory 的比。
 *
 * ⚠️ 先认 artifact 自己指向的 build-info（<Contract>.dbg.json 的 buildInfo 字段）：
 * 只按字节数挑的话，多份 build-info 的 runtime 长度会撞在一起（改注释不改体积），
 * 提交错那份 → metadata hash 不同 → Sourcify 只能给 match（归一化后匹配），拿不到 exact_match。
 */
function pickBuildInfo(targetBytes, sourceName, contractName) {
  const dir = join(__dirname, "..", "artifacts", "build-info");
  if (!existsSync(dir)) throw new Error("找不到 artifacts/build-info，请先 compile");

  const load = (file) => {
    const bi = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const cf = bi.output?.contracts?.[sourceName]?.[contractName];
    if (!cf?.evm?.deployedBytecode?.object) return null;
    return { file, bi, bytes: cf.evm.deployedBytecode.object.length / 2 };
  };

  // 1) artifact 的 dbg.json 指向哪份 build-info，就是它生成了本次部署用的字节码。
  const dbgFile = join(
    __dirname, "..", "artifacts", sourceName, `${contractName}.dbg.json`
  );
  if (existsSync(dbgFile)) {
    const dbg = JSON.parse(readFileSync(dbgFile, "utf8"));
    const linked = dbg.buildInfo ? dbg.buildInfo.split(/[\\/]/).pop() : null;
    if (linked) {
      const hit = load(linked);
      if (hit && hit.bytes === targetBytes) return hit;
    }
  }

  // 2) 退回按字节数扫描（多份命中时取文件名序最后一份，仅作兜底）。
  const cands = [];
  for (const f of readdirSync(dir)) {
    const c = load(f);
    if (c) cands.push(c);
  }
  const exact = cands.filter((c) => c.bytes === targetBytes);
  if (exact.length === 0) {
    throw new Error(
      `没有编译产物的 runtime 字节数等于链上的 ${targetBytes}。现有：${cands.map((c) => `${c.file.slice(0, 8)}=${c.bytes}`).join(", ")}`
    );
  }
  return exact[exact.length - 1];
}

/** Campaign 的构造参数：6 个（sharePrice, totalShares, fundingDeadline, circuitMarket, owner, circuits）。 */
async function campaignConstructorArgs(campaignAddr, dep) {
  const abi = require("../artifacts/contracts/CampaignFactory.sol/CampaignFactory.json").abi;
  const iface = new ethers.Interface(abi);
  const logs = await ethers.provider.getLogs({
    address: dep.factory,
    // publicnode 等公共节点拒「越过 archive 截止点」的查询（fromBlock: 0 必 403
    // "Archive requests require a personal token"）。CampaignCreated 只可能出现在
    // 工厂部署块之后，从那儿起查；记录里没有块号时退回 0（全archive 节点可用）。
    fromBlock: dep.factoryDeploymentBlock ?? 0,
    toBlock: "latest",
    topics: [iface.getEvent("CampaignCreated").topicHash],
  });
  for (const log of logs) {
    const parsed = iface.parseLog(log);
    if (String(parsed.args.campaign).toLowerCase() !== String(campaignAddr).toLowerCase()) continue;
    const c = await ethers.getContractAt("Campaign", campaignAddr);
    // 构造参数里的市场地址：Campaign.circuitMarket()。
    const marketAddr = await c.circuitMarket();
    return [
      parsed.args.sharePriceBnb,
      parsed.args.totalShares,
      parsed.args.fundingDeadline,
      marketAddr,
      dep.deployer,
      await c.circuits(),
    ];
  }
  return [];
}

/** 构造参数 ABI 编码（不带 0x）。 */
function encodeCtorArgs(contractName, args) {
  const abi = require(`../artifacts/contracts/${contractName}.sol/${contractName}.json`).abi;
  const fragment = new ethers.Interface(abi).deploy;
  if (!fragment) throw new Error(`${contractName} artifact 里没有构造器 ABI`);
  return ethers.AbiCoder.defaultAbiCoder()
    .encode(fragment.inputs.map((i) => i.type), args).slice(2);
}

/** 读链上 runtime 字节数。 */
async function runtimeBytesOf(address) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${address} 上没有代码`);
  return (code.length - 2) / 2;
}

/** 轮询直到任务结束，返回结果对象。 */
async function pollVerification(verificationId, attempts = 30, intervalMs = 5000) {
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${SOURCIFY_V2}/verify/${verificationId}`);
    if (r.ok) {
      const j = await r.json();
      // v2 的完成标志是 isJobCompleted，判断结果要看 contract.match —— 不是 status 字段。
      if (j.isJobCompleted) return j;
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`Sourcify 验证超时（${attempts} 次轮询仍未完成）`);
}

/**
 * 直接读 Sourcify 上该地址的验证档案（用于「已验证」场景的确认）。
 *
 * ⚠️ 必须带 `fields=all`：精简响应会被 CDN 缓存，同一地址先后有两次提交（先 match、后 exact_match）时，
 * 精简端点可能一直返回旧的 `match` —— 一度让人误判成「exact_match 没生效」。
 */
async function confirmVerified(chainId, address) {
  const r = await fetch(`${SOURCIFY_V2}/contract/${chainId}/${address}?fields=all`);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.match ? j : null;
}

async function verifyOne({ chainId, address, contractName, args, sourceName: srcName, creationTxHash }) {
  const sourceName = srcName || `contracts/${contractName}.sol`;
  const targetBytes = await runtimeBytesOf(address);
  const { bi, file } = pickBuildInfo(targetBytes, sourceName, contractName);
  const contractOutput = bi.output.contracts[sourceName]?.[contractName];
  if (!contractOutput?.metadata) throw new Error(`编译产物里没有 ${sourceName}:${contractName} 的 metadata`);

  // metadata 端点要 sources 为 {路径: 源码字符串}；build-info 里是 {content: "..."}，要拆开。
  const sources = {};
  for (const [p, v] of Object.entries(bi.input.sources)) sources[p] = v.content;

  const ctorArgs = encodeCtorArgs(contractName, args);
  const body = {
    metadata: JSON.parse(contractOutput.metadata),
    sources,
    constructorArguments: ctorArgs,
    compilerVersion: bi.solcVersion,
    creationTransactionHash: creationTxHash || undefined,
  };

  console.log(`\n提交 ${contractName} ${address}`);
  console.log(`  编译产物 ${file.slice(0, 8)}（runtime ${targetBytes} 字节，与链上一致）`);
  console.log(`  solc ${bi.solcVersion}  合约 ${sourceName}:${contractName}  构造参数 ${ctorArgs.length / 2} 字节`);

  const res = await fetch(`${SOURCIFY_V2}/verify/metadata/${chainId}/${address}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  // 409 already_verified = 之前已验证通过且匹配等级一致，重跑不算失败。
  if (res.status === 409 && text.includes("already_verified")) {
    const verified = await confirmVerified(chainId, address);
    if (verified) {
      console.log(`  ✓ 此前已验证通过：match=${verified.match}  runtimeMatch=${verified.runtimeMatch}`);
      return { contract: verified, externalVerifications: {} };
    }
  }
  if (!res.ok) throw new Error(`Sourcify 提交失败 HTTP ${res.status}：${text.slice(0, 500)}`);
  const submitted = JSON.parse(text);
  console.log(`  verificationId ${submitted.verificationId}，等待比对…`);

  const result = await pollVerification(submitted.verificationId);
  if (result.error) {
    throw new Error(`Sourcify 验证未通过：${result.error.customCode} — ${String(result.error.message).slice(0, 300)}`);
  }
  const m = result.contract?.match;
  if (m !== "exact_match") throw new Error(`Sourcify 匹配等级为 ${m}（未达exact_match）`);
  console.log(`  ✓ 验证通过：match=${m}  creationMatch=${result.contract.creationMatch}  runtimeMatch=${result.contract.runtimeMatch}`);

  // Sourcify 会自动转发 BscScan；这条本机打不通（代理），只提示状态查询地址。
  const ev = result.externalVerifications?.etherscan;
  if (ev) console.log(`  BscScan 同步状态查询：${ev.statusUrl}`);
  return result;
}

async function main() {
  const dep = readDeployment();
  if (!dep) throw new Error(`找不到 deployments/${network.name}.json`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (Number(dep.chainId) !== chainId) {
    throw new Error(`部署记录网络(${dep.chainId}) 与当前链(${chainId}) 不一致`);
  }

  const targets = [{
    address: dep.factory,
    contractName: "CampaignFactory",
    args: [dep.circuitMarket, dep.allowedCircuits],
    sourceName: "contracts/CampaignFactory.sol",
    creationTxHash: dep.factoryDeploymentTx,
  }];
  if (dep.campaign) {
    targets.push({
      address: dep.campaign,
      contractName: "Campaign",
      args: await campaignConstructorArgs(dep.campaign, dep),
      sourceName: "contracts/Campaign.sol",
    });
  }

  let ok = 0;
  for (const t of targets) {
    try {
      await verifyOne({ chainId, ...t });
      ok += 1;
    } catch (e) {
      console.log(`✗ ${t.contractName} ${t.address}：${e.message}`);
    }
  }
  console.log(ok === targets.length
    ? `\n✓ ${ok}/${targets.length} 个合约源码验证通过`
    : `\n${ok}/${targets.length} 个合约验证通过，其余需手动处理`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };