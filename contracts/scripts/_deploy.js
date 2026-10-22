// 部署辅助：绕开 hardhat-ethers 在「合约创建交易」上的格式化崩溃。
//
// ⚠️ 背景（必读，不要改成 ethers.deployContract）：
// @nomicfoundation/hardhat-ethers@3.1.3 的 HardhatEthersProvider.getTransaction() 会把
// 原始 RPC 返回交给 formatTransactionResponse()，其中 `to` 的格式化是
// `allowNull(getAddress, null)` —— 只放行 null / undefined。
// 但 hardhat 对**合约创建交易**返回的 to 是**空字符串 ""**（不是 null），
// 于是 getAddress("") 抛 `invalid value for value.to (invalid address, value="")`，
// 栈落在 HardhatEthersSigner.sendTransaction → checkTx → provider.getTransaction。
//
// 交易本身已经广播成功，只是回读失败 —— 极易误判成「部署失败」而重复部署。
// 本模块自己算 CREATE 地址（getCreateAddress）、自己轮询回执，不碰那条格式化路径。
const { ethers } = require("hardhat");

/** 按 CREATE 地址规则推导合约地址（keccak(rlp([sender, nonce]))[12:]）。 */
function createAddress(sender, nonce) {
  return ethers.getCreateAddress({ from: sender, nonce: Number(nonce) });
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
  const sent = await signer.sendTransaction(deployTx);
  const hash = sent.hash;
  const address = createAddress(from, nonce);

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