// 部署辅助：绕开 hardhat-ethers 在「合约创建交易」上的格式化崩溃。
//
// ⚠️ 背景（必读，不要改成 ethers.deployContract / factory.deploy()）：
// @nomicfoundation/hardhat-ethers@3.1.3 的 HardhatEthersSigner.sendTransaction() 分两步：
//   1. _sendUncheckedTransaction() → provider.send("eth_sendTransaction") —— 广播成功；
//   2. checkTx() → provider.getTransaction(hash) 回读 —— HardhatEthersProvider.getTransaction()
//      把 RPC 返回值交给 formatTransactionResponse()，其中 `to` 的格式化是
//      allowNull(getAddress, null)（只放行 null / undefined）。hardhat 对**合约创建交易**返回的
//      to 是**空字符串 ""**（不是 null），于是 getAddress("") 抛
//      `invalid value for value.to (invalid address, value="")`。
// 交易本身已经广播成功，只是回读失败 —— 极易误判成「部署失败」而重复部署。
// signTransaction() 在该类里是 NotImplementedError，没法本地签名绕开。
// 本模块的对策：sendTransaction 崩了之后，按 CREATE 地址（部署前就能算出来）在最近若干个块里
// 找回执，找到就当作广播成功继续；找不到才真的抛错。绝不重复部署。
const { ethers } = require("hardhat");

/** 按 CREATE 地址规则推导合约地址（keccak(rlp([sender, nonce]))[12:]）。 */
function createAddress(sender, nonce) {
  return ethers.getCreateAddress({ from: sender, nonce: Number(nonce) });
}

/**
 * 上面那个 bug 在部分节点上不是「抛出被 catch」而是「detached 的未处理拒绝」——
 * checkTx 是 fire-and-forget，rejection 直接冒到进程顶层，try/catch 拦不住，
 * 进程在「交易其实已广播」之后崩掉（2026-10-25 主网换工厂就踩了：工厂上链了但记录没写）。
 * 这里在部署窗口内临时吞掉这一条已知错误，让流程继续走 CREATE 地址找回执。
 */
const CREATE_TX_READBACK_BUG = /invalid value for value\.to/;

/**
 * 全局安装一次，**不随单个 Promise 结束而摘掉**。
 *
 * 2026-10-25 主网实测：`sent` 已经带着 hash 正常返回，checkTx 的 rejection 却在其后
 * 才冒出来；原先在 `.finally` 里摘 handler 的做法已经太晚，进程被未处理拒绝打死
 * （工厂上链成功、脚本却静默退出、记录也没写盘）。这里只在进程整个生命周期内
 * 忽略这一条已知错误，其它未处理拒绝照旧抛。
 */
let readbackGuardInstalled = false;
function installReadbackGuard() {
  if (readbackGuardInstalled) return;
  readbackGuardInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const msg = String((reason && reason.message) || reason || "");
    if (CREATE_TX_READBACK_BUG.test(msg)) return; // 已知：广播成功，只是回读崩溃
    throw reason; // 其他未处理拒绝照旧炸
  });
}

/** 轮询等 CREATE 地址长出代码（交易可能还在打包中，回执按块扫需要它先落块）。 */
async function waitForCode(address, attempts = 60, intervalMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    const code = await ethers.provider.getCode(address);
    if (code && code !== "0x") return code;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return "0x";
}

/**
 * 部署合约并等待链上确认。
 * @param {string} contractName
 * @param {any[]} args 构造参数
 * @param {object} [opts] { signer, confirmations, quiet }
 * @returns {Promise<{ address: string, hash: string, blockNumber: number, gasUsed: bigint }>}
 */
async function deployContract(contractName, args = [], opts = {}) {
  const signer = opts.signer || (await ethers.getSigners())[0];
  const from = await signer.getAddress();

  const factory = await ethers.getContractFactory(contractName, signer);
  const deployTx = await factory.getDeployTransaction(...args);

  const nonce = await ethers.provider.getTransactionCount(from, "pending");
  const address = createAddress(from, nonce);

  let hash;
  try {
    installReadbackGuard();
    const sent = await signer.sendTransaction(deployTx);
    hash = sent.hash;
  } catch (e) {
    // 已知 bug：广播已成功、回读崩溃（见文件头）。先等 CREATE 地址长出代码（交易可能还在打包），
    // 再按 CREATE 地址在最近块里找回执——那个地址只可能由这笔部署交易获得代码，匹配上就是它。
    await waitForCode(address);
    const found = await findReceiptByContractAddress(address, 4000);
    if (!found) {
      throw new Error(`部署 ${contractName} 广播失败（链上未找到 ${address} 的创建回执）：${e.message}`);
    }
    hash = found.transactionHash;
    console.log(`   ↳ sendTransaction 回读崩溃（已知 hardhat-ethers bug），按 CREATE 地址找回执：${hash}`);
  }

  // 直接用原始 RPC 拿回执，绕开 getTransaction 的格式化。
  const receipt = await waitReceiptRaw(hash);
  if (!receipt) throw new Error(`部署 ${contractName} 交易已广播但查不到回执：${hash}`);

  const status = Number(BigInt(receipt.status));
  if (status !== 1) throw new Error(`部署 ${contractName} 交易失败（status=${status}），地址 ${address}`);

  // 二次确认：地址上必须有代码，否则说明地址推算错了。
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`部署 ${contractName} 交易成功但地址 ${address} 上没有代码，CREATE 地址推算可能不正确`);
  }

  if (!opts.quiet) {
    console.log(`   ↳ ${contractName} 部署完成：${address}（块 ${receipt.blockNumber}，gasUsed ${Number(BigInt(receipt.gasUsed)).toLocaleString()}）`);
  }

  return {
    address,
    hash,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: BigInt(receipt.gasUsed),
  };
}

/**
 * 拿回执。**两路径**，因为公共 RPC 节点的限制各不相同：
 *   1. `eth_getTransactionReceipt` —— 最直接，但 allnodes/publicnode 对它一律返回
 *      "Archive requests require a personal token"（链上明明有）。
 *   2. `eth_getTransactionByHash` 查块号 → `eth_getBlockReceipts(blockNumber)` → 按交易索引对齐。
 *      这条在 publicnode 上可用（BSC 支持 eth_getBlockReceipts）。
 * 两条都失败才算真的没回执。
 */
async function fetchReceipt(hash) {
  try {
    const direct = await ethers.provider.send("eth_getTransactionReceipt", [hash]);
    if (direct) return direct;
  } catch {
    /* 节点限制，走路径 2 */
  }
  try {
    const tx = await ethers.provider.send("eth_getTransactionByHash", [hash]);
    if (!tx || !tx.blockNumber) return null;
    const receipts = await ethers.provider.send("eth_getBlockReceipts", [tx.blockNumber]);
    if (!Array.isArray(receipts) || receipts.length === 0) return null;
    const idx = typeof tx.transactionIndex === "number"
      ? parseInt(tx.transactionIndex, 16)
      : Number(BigInt(tx.transactionIndex));
    const idxHex = "0x" + idx.toString(16);
    const r = receipts[idx] || receipts.find((x) => x && x.transactionHash && x.transactionHash.toLowerCase() === hash.toLowerCase());
    if (!r) return null;
    return {
      ...r,
      blockNumber: tx.blockNumber,
      transactionHash: hash,
      transactionIndex: idxHex,
    };
  } catch {
    return null;
  }
}

/** 按 CREATE 地址在最近若干个块里找回执（回读崩溃时的恢复路径）。 */
async function findReceiptByContractAddress(address, maxBlocks = 40) {
  const latest = await ethers.provider.getBlockNumber();
  const lower = String(address).toLowerCase();
  for (let b = latest; b > latest - maxBlocks && b >= 0; b--) {
    let receipts;
    try {
      receipts = await ethers.provider.send("eth_getBlockReceipts", ["0x" + b.toString(16)]);
    } catch {
      continue;
    }
    if (!Array.isArray(receipts)) continue;
    const hit = receipts.find(
      (r) => r && r.contractAddress && String(r.contractAddress).toLowerCase() === lower
    );
    if (hit) return hit;
  }
  return null;
}

/** 轮询直到拿到回执。 */
async function waitReceiptRaw(hash, attempts = 24, intervalMs = 2500) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await fetchReceipt(hash);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

module.exports = { deployContract, createAddress, waitReceiptRaw, fetchReceipt };