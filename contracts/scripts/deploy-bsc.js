// 部署到 BSC：电路市场（官方 sell-side Market 或 MockCircuitMarket）+ ERC721 电路白名单
// （官方 TapeOut / Behemoth 电路，或 MockCircuitNft）→ CampaignFactory → 可选开一期。
//
// 工厂 immutable 地绑定 circuitMarket，构造 2 参：(circuitMarket, allowedCircuits[])。
// 工厂没有「默认电路」：每期开期时由调用方显式选择白名单内的 ERC721 电路合约
// （createCampaign 第 4 参必选，零地址 revert）。
//
// 地址写回 contracts/deployments/<network>.json 与 frontend/src/chain/deployments.json。
// 运行：npx hardhat run scripts/deploy-bsc.js --network bscTestnet
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { collectLegacyFactories, writeDeploymentRecords } = require("./_records");
const { deployContract: safeDeploy } = require("./_deploy");

/// @notice 官方 Circuit Market（BSC 主网，EIP-1967 代理，只有卖单侧）。
const OFFICIAL_CIRCUIT_MARKET = "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f";

/**
 * 官方 ERC721 电路合约（两个官方处理器各自发行的电路）。
 *
 * 主网必须**两个都在白名单里**：只放一个，那个处理器的期次在主网上根本开不了
 * （createCampaign 会 revert CircuitsNotAllowed）。
 *
 * ⚠️ 白名单是**安全边界**不是运营开关：不在名单里的 ERC721 会被工厂直接拒绝，
 * 目的是防止把期次指向 MockCircuitNft（其 mint 无访问控制，任何人能无限造电路，
 * 「电路已到账」的检查会形同虚设）。部署后不可增删。
 */
const OFFICIAL_CIRCUITS = [
  "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C", // TapeOut
  "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c", // Behemoth
];

function env(...names) {
  for (const name of names) {
    const v = (process.env[name] || "").trim();
    if (v) return v;
  }
  return "";
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const mainnet = chainId === 56;
  console.log(`网络：${network.name} (chainId ${chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);

  // 主网只允许官方电路市场地址：地址上「有代码」不够，mock / 测试网地址也有代码。
  const marketFromEnv = env("CIRCUIT_MARKET_ADDRESS", "MINTER_ADDRESS");
  if (mainnet) {
    if (marketFromEnv && marketFromEnv.toLowerCase() !== OFFICIAL_CIRCUIT_MARKET.toLowerCase()) {
      throw new Error(`主网只允许官方电路市场 ${OFFICIAL_CIRCUIT_MARKET}，收到 ${marketFromEnv}`);
    }
    const wl = env("ALLOWED_CIRCUITS_ADDRESSES", "ALLOWED_PARTS_ADDRESSES");
    if (wl) {
      const list = wl.split(",").map((s) => s.trim()).filter(Boolean);
      for (const a of list) {
        if (!OFFICIAL_CIRCUITS.some((o) => o.toLowerCase() === a.toLowerCase())) {
          throw new Error(`主网电路白名单只允许官方两件套，收到 ${a}`);
        }
      }
      for (const o of OFFICIAL_CIRCUITS) {
        if (!list.some((a) => a.toLowerCase() === o.toLowerCase())) {
          throw new Error(`主网电路白名单缺少官方电路 ${o}（否则它的期次开不了）`);
        }
      }
    }
  }

  // 1) 电路市场：主网官方合约；测试网可给地址，否则部署 MockCircuitMarket。
  let circuitMarket = marketFromEnv || (mainnet ? OFFICIAL_CIRCUIT_MARKET : "");
  if (!circuitMarket) {
    const m = await safeDeploy("MockCircuitMarket", [250]);
    circuitMarket = m.address;
    console.log(`CircuitMarket ：${circuitMarket}（Mock sell-side，主网为 ${OFFICIAL_CIRCUIT_MARKET}）`);
  } else if ((await ethers.provider.getCode(circuitMarket)) === "0x") {
    throw new Error(`CIRCUIT_MARKET_ADDRESS ${circuitMarket} 在当前链上没有代码`);
  }

  // 2) 电路白名单：主网官方两件套；测试网 ALLOWED_CIRCUITS_ADDRESSES，或部署 MockCircuitNft。
  let mockCircuits = "";
  if (!mainnet && !env("ALLOWED_CIRCUITS_ADDRESSES", "ALLOWED_PARTS_ADDRESSES")) {
    const c = await safeDeploy("MockCircuitNft");
    mockCircuits = c.address;
    const cC = await ethers.getContractAt("MockCircuitNft", mockCircuits, deployer);
    console.log(`MockCircuitNft：${mockCircuits}（测试网电路替身，已给部署者 mint 5 张）`);
    for (let tokenId = 1; tokenId <= 5; tokenId++) {
      await (await cC.mint(deployer.address, tokenId)).wait();
    }
    const mockFile = join(__dirname, "..", "deployments", `mocks-${chainId}.json`);
    const mockPrev = existsSync(mockFile) ? JSON.parse(readFileSync(mockFile, "utf8")) : {};
    writeFileSync(mockFile, JSON.stringify({
      ...mockPrev,
      chainId,
      deployer: deployer.address,
      circuitMarket,
      circuits: mockCircuits,
      deployedAt: new Date().toISOString(),
    }, null, 2));
  }
  const allowedCircuits = mainnet
    ? OFFICIAL_CIRCUITS
    : env("ALLOWED_CIRCUITS_ADDRESSES", "ALLOWED_PARTS_ADDRESSES")
      ? env("ALLOWED_CIRCUITS_ADDRESSES", "ALLOWED_PARTS_ADDRESSES")
        .split(",").map((s) => s.trim()).filter(Boolean)
      : [mockCircuits].filter(Boolean);
  if (allowedCircuits.length === 0) throw new Error("电路白名单不能为空（构造时会 revert）");
  for (const a of allowedCircuits) {
    if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`电路白名单 ${a} 在当前链上没有代码`);
  }
  console.log(`电路白名单：${allowedCircuits.length} 项${mainnet ? "（官方两件套）" : ""}`);

  // 3) 工厂：构造 [circuitMarket, allowedCircuits]。
  const factoryDeployed = await safeDeploy("CampaignFactory", [circuitMarket, allowedCircuits]);
  const factoryAddr = factoryDeployed.address;
  const factory = await ethers.getContractAt("CampaignFactory", factoryAddr, deployer);
  console.log(`Factory    ：${factoryAddr}`);
  console.log(`             交易 ${factoryDeployed.hash}（块 ${factoryDeployed.blockNumber}，gasUsed ${Number(factoryDeployed.gasUsed).toLocaleString()}）`);

  // 读回构造参数，确认 immutable 配置。
  if (String(await factory.circuitMarket()).toLowerCase() !== circuitMarket.toLowerCase()) {
    throw new Error("链上 circuitMarket 与预期不一致");
  }
  if (Number(await factory.allowedCircuitsCount()) !== allowedCircuits.length) {
    throw new Error("链上电路白名单数量与预期不一致");
  }

  // 4) 开期。主网默认不开，避免未核对参数就收款。需要时设 OPEN_CAMPAIGN=1。
  const openCampaign = process.env.OPEN_CAMPAIGN === "1" || (!mainnet && process.env.OPEN_CAMPAIGN !== "0");
  if (!openCampaign) {
    const legacyFactories = collectLegacyFactories(network.name, chainId, factoryAddr);
    const out = {
      network: network.name,
      chainId,
      deployedAt: new Date().toISOString(),
      circuitMarket,
      /** 电路 NFT 白名单：前端开期表单的可选处理器直接由这份链上事实生成。 */
      allowedCircuits,
      factory: factoryAddr,
      legacyFactories,
      campaign: "",
      campaignParams: null,
      deployer: deployer.address,
      notes: "BSC 工厂已部署，尚未开期。开期需份额价 / 总份数 / 募集天数 / ERC721 电路合约（必选，从白名单选 TapeOut / Behemoth）。",
    };
    writeDeploymentRecords(network.name, out);
    console.log("\n✓ 工厂已部署，未开期。地址已写入 deployments 与前端配置。");
    try {
      await require("./verify-published").main();
    } catch (e) {
      console.warn(`开源验证未完成：${e.message || e}`);
    }
    return;
  }

  const sharePrice = ethers.parseEther(process.env.SHARE_PRICE_BNB || "0.01");
  const totalShares = BigInt(process.env.TOTAL_SHARES || 100);
  const fundingDays = Number(process.env.FUNDING_DAYS || 7);
  const fundingSeconds = BigInt(fundingDays) * 86400n;

  /**
   * 本期 ERC721 电路合约（= 处理器）。**必选**。
   * 主网必须由 CAMPAIGN_CIRCUITS_ADDRESS 给出；测试网白名单若只有一个则自动用那个。
   */
  let campaignCircuits = env("CAMPAIGN_CIRCUITS_ADDRESS", "CAMPAIGN_PARTS_ADDRESS");
  if (!campaignCircuits) {
    if (mainnet) {
      throw new Error("主网开期必须显式指定 CAMPAIGN_CIRCUITS_ADDRESS（从白名单选 TapeOut / Behemoth）");
    }
    if (allowedCircuits.length === 1) campaignCircuits = allowedCircuits[0];
    else throw new Error("测试网开期需指定 CAMPAIGN_CIRCUITS_ADDRESS，或把白名单只放一个电路合约");
  }
  if (!allowedCircuits.some((a) => a.toLowerCase() === campaignCircuits.toLowerCase())) {
    throw new Error(`CAMPAIGN_CIRCUITS_ADDRESS ${campaignCircuits} 不在工厂电路白名单内`);
  }

  const tx = await factory.createCampaign(sharePrice, totalShares, fundingSeconds, campaignCircuits);
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  const lockedCircuits = await (await ethers.getContractAt("Campaign", campaignAddr)).circuits();
  console.log(`Campaign   ：${campaignAddr}`);
  console.log(`锁定电路    ：${lockedCircuits}（显式指定 ${campaignCircuits}）`);

  // 服务费：第二笔交易（setServiceFee），只能在 sold == 0 时调一次。
  const feeBps = process.env.SERVICE_FEE_BPS ? BigInt(process.env.SERVICE_FEE_BPS) : 0n;
  let feeShares = [];
  if (feeBps > 0n) {
    const recipients = String(process.env.SERVICE_FEE_RECIPIENTS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const shares = String(process.env.SERVICE_FEE_SHARES_BPS || "")
      .split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
    if (recipients.length === 0 || recipients.length !== shares.length) {
      throw new Error("设了 SERVICE_FEE_BPS 就必须给等长的 SERVICE_FEE_RECIPIENTS 与 SERVICE_FEE_SHARES_BPS");
    }
    if (recipients.length > 3) {
      throw new Error(`SERVICE_FEE_RECIPIENTS 最多 3 个（链上 MAX_FEE_RECIPIENTS），当前 ${recipients.length} 个`);
    }
    const c = await ethers.getContractAt("Campaign", campaignAddr);
    await (await c.setServiceFee(feeBps, recipients, shares)).wait();
    feeShares = recipients.map((address, i) => ({ address, shareBps: Number(shares[i]) }));
    console.log(`服务费    ：${feeBps} bps（${Number(feeBps) / 100}%），${recipients.length} 个收款地址`);
  }

  const legacyFactories = collectLegacyFactories(network.name, chainId, factoryAddr);

  const out = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    circuitMarket,
    /** 电路 NFT 白名单：前端开期表单的可选处理器直接由这份链上事实生成。 */
    allowedCircuits,
    factory: factoryAddr,
    legacyFactories,
    campaign: campaignAddr,
    campaignParams: {
      sharePriceBnb: process.env.SHARE_PRICE_BNB || "0.01",
      totalShares: Number(totalShares),
      fundingDays,
      fundingSeconds: Number(fundingSeconds),
      /** 本期锁定的 ERC721 电路合约（= 处理器）。必选，从白名单里选。 */
      campaignCircuits,
    },
    serviceFeeBps: Number(feeBps),
    serviceFeeSet: feeBps > 0n,
    feeShares,
    deployer: deployer.address,
    notes: mainnet
      ? "BSC 主网已开期。电路市场为官方 sell-side 合约；ERC721 电路合约显式指定，落在官方两件套白名单内（TapeOut / Behemoth）。"
      : "测试网部署并已开期。",
  };

  writeDeploymentRecords(network.name, out);

  console.log(`\n✓ 部署完成，地址已写入 deployments/${network.name}.json 与 frontend/src/chain/deployments.json`);
  try {
    await require("./verify-published").main();
  } catch (e) {
    console.warn(`开源验证未完成：${e.message || e}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
