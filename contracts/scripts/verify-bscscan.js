// 开源验证（BscScan / Etherscan V2）：把工厂（及有期次时的 Campaign）源码提交到区块浏览器。
//
// 为什么不用 `hardhat verify`：
//   - api.bscscan.com 现在一律 308 跳到 Etherscan V2 多链端点（api.etherscan.io/v2/api?chainid=56），
//     hardhat-verify 的 bscscan 自定义链配置走的是旧路径，容易被跳转/代理挡住。
//   - 本文件直接打 V2 端点，standard-json 提交，与 Sourcify 那条路互补：
//     Sourcify = 去中心化验证（exact_match），BscScan = 浏览器上能直接读源码。
//
// 与 verify-sourcify.js 共用「认对 build-info」的规则：优先用 artifact 的 <Contract>.dbg.json
// 指向的那份，否则按 runtime 字节数兜底 —— 多份 build-info 的 runtime 长度会撞在一起。
//
// 运行：node ./node_modules/hardhat/internal/cli/bootstrap.js run scripts/verify-bscscan.js --network bsc
const { ethers, network } = require("hardhat");
const { readFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const API = "https://api.etherscan.io/v2/api";
const VERIFY_TIMEOUT_MS = 6 * 60 * 1000;

function readEnv() {
  const out = {};
  const p = join(__dirname, "..", ".env");
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function readDeployment() {
  const file = join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 取链上 runtime 字节数一致的编译产物（优先 dbg.json 指认的那份）。 */
function pickBuildInfo(targetBytes, sourceName, contractName) {
  const dir = join(__dirname, "..", "artifacts", "build-info");
  if (!existsSync(dir)) throw new Error("找不到 artifacts/build-info，请先 compile");

  const load = (file) => {
    const bi = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const cf = bi.output?.contracts?.[sourceName]?.[contractName];
    if (!cf?.evm?.deployedBytecode?.object) return null;
    return { file, bi, bytes: cf.evm.deployedBytecode.object.length / 2 };
  };

  const dbgFile = join(__dirname, "..", "artifacts", sourceName, `${contractName}.dbg.json`);
  if (existsSync(dbgFile)) {
    const dbg = JSON.parse(readFileSync(dbgFile, "utf8"));
    const linked = dbg.buildInfo ? dbg.buildInfo.split(/[\\/]/).pop() : null;
    if (linked) {
      const hit = load(linked);
      if (hit && hit.bytes === targetBytes) return hit;
    }
  }

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

/** 构造参数（不带 0x）。 */
function encodeCtorArgs(contractName, args) {
  const abi = require(`../artifacts/contracts/${contractName}.sol/${contractName}.json`).abi;
  const fragment = new ethers.Interface(abi).deploy;
  if (!fragment) throw new Error(`${contractName} artifact 里没有构造器 ABI`);
  return ethers.AbiCoder.defaultAbiCoder()
    .encode(fragment.inputs.map((i) => i.type), args).slice(2);
}

async function runtimeBytesOf(address) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${address} 上没有代码`);
  return (code.length - 2) / 2;
}

/** 已开源的合约，getsourcecode 会带回非空 SourceCode。 */
async function isVerified(chainId, address, apiKey) {
  const url = `${API}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
  const r = await fetch(url);
  const j = await r.json();
  const rec = Array.isArray(j.result) ? j.result[0] : null;
  if (!rec) return null;
  const src = String(rec.SourceCode || "");
  return { verified: src.length > 0, rec };
}

async function submit(chainId, address, contractName, sourceName, args, apiKey) {
  const targetBytes = await runtimeBytesOf(address);
  const { bi, file } = pickBuildInfo(targetBytes, sourceName, contractName);
  const contractPath = `${sourceName}:${contractName}`;
  if (!bi.output.contracts[sourceName]?.[contractName]) {
    throw new Error(`编译产物里没有 ${contractPath}`);
  }
  const ctorArgs = encodeCtorArgs(contractName, args);
  console.log(`\n提交 ${contractName} ${address}`);
  console.log(`  编译产物 ${file.slice(0, 8)}（runtime ${targetBytes} 字节，与链上一致）`);
  console.log(`  solc ${bi.solcLongVersion}  合约 ${contractPath}  构造参数 ${ctorArgs.length / 2} 字节`);

  const body = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    apikey: apiKey,
    codeformat: "solidity-standard-json-input",
    sourceCode: JSON.stringify(bi.input),
    contractaddress: address,
    contractname: contractPath,
    // Etherscan 要求带前导 "v"（v0.8.24+commit.e11b9ed9），build-info 里没有。
    compilerversion: bi.solcLongVersion.startsWith("v") ? bi.solcLongVersion : `v${bi.solcLongVersion}`,
    // Etherscan 的参数名就是这个拼写（Arguements），不能改成 Arguments。
    constructorArguements: ctorArgs,
    licenseType: "3", // MIT
  });

  // V2 的 chainid 必须放在 **query string**（放 body 会报 "Missing or unsupported chainid"）。
  const res = await fetch(`${API}?chainid=${chainId}`, { method: "POST", body });
  const j = await res.json();
  if (String(j.status) !== "1" || !j.result) {
    const msg = String(j.result || j.message || "");
    if (/already verified/i.test(msg)) return { already: true };
    throw new Error(`BscScan 提交失败：${j.message} / ${msg}`);
  }
  console.log(`  guid ${j.result}，等待编译比对…`);
  return { guid: j.result };
}

async function poll(chainId, guid, apiKey) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = `${API}?chainid=${chainId}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${apiKey}`;
    const r = await fetch(url);
    const j = await r.json();
    const result = String(j.result || "");
    if (/Pass|Already Verified/i.test(result) || String(j.status) === "1") {
      return result || "Pass";
    }
    if (/Fail|Error|Unable/i.test(result)) {
      throw new Error(`BscScan 比对失败：${result}`);
    }
    await new Promise((res) => setTimeout(res, 6000));
  }
  throw new Error("BscScan 验证超时（6 分钟仍未完成）");
}

/**
 * 本机要走系统代理才能连 api.etherscan.io（直连会 connect timeout / ECONNRESET）。
 * 顺序：HTTPS_PROXY 环境变量 → .env 里的 HTTPS_PROXY → Windows 系统代理（注册表）。
 * 有代理就挂上 undici 的 ProxyAgent；没装 undici 就提示改用 NODE_USE_ENV_PROXY=1。
 */
function systemProxy() {
  if (process.platform !== "win32") return "";
  try {
    const { execSync } = require("node:child_process");
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const out = execSync(`reg query "${key}"`, { encoding: "utf8" });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return "";
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!m) return "";
    const server = m[1].includes("=") ? (m[1].match(/https=([^;]+)/i)?.[1] || "") : m[1];
    if (!server) return "";
    return /^https?:\/\//i.test(server) ? server : `http://${server}`;
  } catch {
    return "";
  }
}

function setupProxy(env) {
  const proxy = (process.env.HTTPS_PROXY || process.env.https_proxy || env.HTTPS_PROXY || systemProxy() || "").trim();
  if (!proxy) return false;
  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.log(`（走代理 ${proxy}）`);
    return true;
  } catch {
    console.log("（检测到代理，但 undici 不可用：请用 NODE_USE_ENV_PROXY=1 运行）");
    return false;
  }
}

/** Campaign 构造 9 参：全部可从链上 immutable / 公开字段还原（不必扫事件）。 */
async function campaignConstructorArgs(campaignAddr) {
  const c = await ethers.getContractAt("Campaign", campaignAddr);
  return [
    await c.sharePriceBnb(),
    await c.totalShares(),
    await c.fundingDeadline(),
    await c.circuitMarket(),
    await c.owner(),
    await c.circuits(),
    await c.podMining(),
    await c.bem(),
    await c.factory(),
  ];
}

/** 工厂 registry 里的全部期次（旧→新）。 */
async function listFactoryCampaigns(factoryAddr) {
  const f = await ethers.getContractAt("CampaignFactory", factoryAddr);
  const n = Number(await f.campaignCount());
  const out = [];
  for (let i = 0; i < n; i++) out.push(await f.campaigns(i));
  return out;
}

async function main() {
  const env = readEnv();
  const apiKey = (process.env.BSCSCAN_API_KEY || env.BSCSCAN_API_KEY || "").trim();
  if (!apiKey) throw new Error("缺少 BSCSCAN_API_KEY（写在 contracts/.env）");
  setupProxy(env);

  const dep = readDeployment();
  if (!dep) throw new Error(`找不到 deployments/${network.name}.json`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (Number(dep.chainId) !== chainId) {
    throw new Error(`部署记录网络(${dep.chainId}) 与当前链(${chainId}) 不一致`);
  }

  const targets = [];
  if (dep.campaignDeployer) {
    targets.push({
      address: dep.campaignDeployer,
      contractName: "CampaignDeployer",
      sourceName: "contracts/CampaignDeployer.sol",
      args: [],
    });
  }
  targets.push({
    address: dep.factory,
    contractName: "CampaignFactory",
    sourceName: "contracts/CampaignFactory.sol",
    args: [
      dep.circuitMarket,
      dep.allowedCircuits,
      dep.podMining,
      dep.bem,
      dep.campaignDeployer,
    ],
  });
  const campaignAddrs = new Set();
  if (dep.campaign) campaignAddrs.add(String(dep.campaign));
  for (const a of await listFactoryCampaigns(dep.factory)) campaignAddrs.add(String(a));
  for (const addr of campaignAddrs) {
    targets.push({
      address: addr,
      contractName: "Campaign",
      sourceName: "contracts/Campaign.sol",
      args: await campaignConstructorArgs(addr),
    });
  }

  let ok = 0;
  for (const t of targets) {
    const current = await isVerified(chainId, t.address, apiKey);
    if (current?.verified) {
      console.log(`✓ ${t.contractName} ${t.address} 已在 BscScan 开源（${current.rec.ContractName}，solc ${current.rec.CompilerVersion}）`);
      ok += 1;
      continue;
    }
    console.log(`… ${t.contractName} ${t.address} 尚未在 BscScan 开源（SourceCode 为空）`);
    try {
      const sent = await submit(chainId, t.address, t.contractName, t.sourceName, t.args, apiKey);
      if (sent.already) {
        console.log(`  ✓ BscScan 返回「已开源」`);
        ok += 1;
        continue;
      }
      const result = await poll(chainId, sent.guid, apiKey);
      console.log(`  ✓ 验证通过：${result}`);
      ok += 1;
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
    }
  }
  console.log(ok === targets.length
    ? `\n✓ ${ok}/${targets.length} 个合约已在 BscScan 开源`
    : `\n${ok}/${targets.length} 个合约成功，其余需手动处理`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
