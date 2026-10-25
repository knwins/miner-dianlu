// 部署到 BSC：晶体管市场（官方 placeBid 或 MockMaterialMarket）+ 晶体管白名单（官方两件套或 MockERC1155）→ CampaignFactory → 开一期。
// 流片 / PoD / BEM 挖矿已移除，工厂只需 materialMarket（晶体管市场，immutable）与**晶体管白名单**两个东西。
// 晶体管合约**不再有默认**：每期开期时由前端显式选择（createCampaign 第 4 参 transistors_ 必选，
// 零地址一律 revert），所以一个工厂可以同时承载 TapeOut / Behemoth 的期次。
// 工厂构造 2 参：(materialMarket, allowedParts[])。开期只传 sharePriceBnb / totalShares / fundingSeconds / transistors（必选）。
// 地址写回 contracts/deployments/bscTestnet.json 与 frontend/src/chain/deployments.json 供前端对接。
// 运行：npx hardhat run scripts/deploy-bsc.js --network bscTestnet
const { ethers, network } = require("hardhat");
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { collectLegacyFactories, writeDeploymentRecords } = require("./_records");
const { deployContract: safeDeploy } = require("./_deploy");

const OFFICIAL_MARKET = "0xA6a80C1919a8326022d7c601a488888C13aA16E4";

/**
 * 官方晶体管市场的两个晶体管合约（两个官方处理器各自的晶体管）。
 *
 * 主网必须**两个都在白名单里**：只放一个，那个处理器的期次在主网上根本开不了
 * （createCampaign 会 revert PartsNotAllowed）。
 *
 * ⚠️ T-59：官方 Genesis CPU（processorMultiplier = 0、永远不出矿）已从项目整体移除，
 * 它的晶体管合约不在白名单里 —— 既不采购、也不开期，避免用户花钱买到不出矿的晶体管。
 *
 * ⚠️ 这层白名单是**安全边界**不是运营开关：不在名单里的 ERC1155 会被工厂直接拒绝，
 * 目的是防止把期次指向 MockERC1155（其 mint 无访问控制，任何人能无限造晶体管，
 * 「晶体管已到账」的检查会形同虚设）。部署后不可增删。
 */
const OFFICIAL_PARTS = [
  "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087", // TapeOut（CPU 0xb1024b89…）
  "0xE2DfD802081C7a05341E20b6582b04b908e8550c", // Behemoth（CPU 0x1f5cb4ae…）
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`网络：${network.name} (chainId ${net.chainId})`);
  console.log(`部署者：${deployer.address}`);
  console.log(`余额 ：${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);

  const mainnet = Number(net.chainId) === 56;

  // 主网只允许官方晶体管市场地址。
  // 之前只校验「地址上有代码」，于是把某个 mock 或测试网地址填进 MINTER_ADDRESS 也能过。
  // 主网分支在这里硬断言。
  if (mainnet) {
    if (process.env.MINTER_ADDRESS && process.env.MINTER_ADDRESS.toLowerCase() !== OFFICIAL_MARKET.toLowerCase()) {
      throw new Error(`主网只允许官方晶体管市场 ${OFFICIAL_MARKET}，收到 ${process.env.MINTER_ADDRESS}`);
    }
    // 主网白名单必须是官方两件套，且两个都得在。少一个则该处理器的期次开不了；
    // 反过来放替身则「晶体管已到账」的检查形同虚设。
    // 注意：TRANSISTORS_ADDRESS 已无意义（工厂不再有默认晶体管，开期时前端显式选），
    // 这里忽略它，只校验白名单。
    const wl = String(process.env.ALLOWED_PARTS_ADDRESSES || "").trim();
    if (wl) {
      const list = wl.split(",").map((s) => s.trim()).filter(Boolean);
      for (const a of list) {
        if (!OFFICIAL_PARTS.some((o) => o.toLowerCase() === a.toLowerCase())) {
          throw new Error(`主网晶体管白名单只允许官方两件套，收到 ${a}`);
        }
      }
      for (const o of OFFICIAL_PARTS) {
        if (!list.some((a) => a.toLowerCase() === o.toLowerCase())) {
          throw new Error(`主网晶体管白名单缺少官方晶体管 ${o}（否则它的期次开不了）`);
        }
      }
    }
  }

  // 1) 晶体管市场：主网默认官方合约；测试网无代码则布 MockMaterialMarket。
  let materialMarket = process.env.MINTER_ADDRESS || (mainnet ? OFFICIAL_MARKET : "");
  if (!materialMarket) {
    const m = await safeDeploy("MockMaterialMarket");
    materialMarket = m.address;
    console.log(`MaterialMarket ：${materialMarket}（placeBid 替身，主网换 ${OFFICIAL_MARKET}）`);
  } else if ((await ethers.provider.getCode(materialMarket)) === "0x") {
    throw new Error(`MINTER_ADDRESS ${materialMarket} 在当前链上没有代码`);
  }

  // 2) 晶体管白名单：主网 = 官方两件套；测试网 = ALLOWED_PARTS_ADDRESSES，或只放刚部署的 Mock。
  //    工厂不再有「默认晶体管」：每个期次开期时由前端显式选一个白名单内的晶体管合约。
  let mockParts = "";
  if (!mainnet) {
    const wlFromEnv = String(process.env.ALLOWED_PARTS_ADDRESSES || "").trim();
    if (!wlFromEnv) {
      const p = await safeDeploy("MockERC1155");
      mockParts = p.address;
      const pC = await ethers.getContractAt("MockERC1155", mockParts, deployer);
      console.log(`MockERC1155 ：${mockParts}（测试网晶体管替身，已给部署者 mint NAND/LATCH）`);
      await (await pC.mint(deployer.address, 0, 100n)).wait();
      await (await pC.mint(deployer.address, 1, 100n)).wait();
      const mockFile = join(__dirname, "..", "deployments", `mocks-${net.chainId}.json`);
      const mockPrev = existsSync(mockFile) ? JSON.parse(readFileSync(mockFile, "utf8")) : {};
      writeFileSync(mockFile, JSON.stringify({
        ...mockPrev,
        chainId: Number(net.chainId),
        deployer: deployer.address,
        parts: mockParts,
        deployedAt: new Date().toISOString(),
      }, null, 2));
    }
  }
  const allowedParts = mainnet
    ? OFFICIAL_PARTS
    : String(process.env.ALLOWED_PARTS_ADDRESSES || "").trim()
      .split(",").map((s) => s.trim()).filter(Boolean)
      .length
      ? String(process.env.ALLOWED_PARTS_ADDRESSES).split(",").map((s) => s.trim()).filter(Boolean)
      : [mockParts].filter(Boolean);
  if (allowedParts.length === 0) throw new Error("晶体管白名单不能为空（构造时会 revert）");
  // 白名单里每一项都必须在本链上有代码，否则期次开出来挂单必然失败。
  for (const a of allowedParts) {
    if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`晶体管白名单 ${a} 在当前链上没有代码`);
  }
  console.log(`晶体管白名单：${allowedParts.length} 项${mainnet ? "（官方两件套）" : ""}`);

  // 3) 工厂：构造传 [materialMarket, allowedParts]（2 参，无默认晶体管）。
  //    不用 ethers.deployContract —— hardhat-ethers 读合约创建交易时必崩（见 _deploy.js 顶部说明）。
  const factoryDeployed = await safeDeploy("CampaignFactory", [materialMarket, allowedParts]);
  const factoryAddr = factoryDeployed.address;
  const factory = await ethers.getContractAt("CampaignFactory", factoryAddr, deployer);
  console.log(`Factory    ：${factoryAddr}`);
  console.log(`             交易 ${factoryDeployed.hash}（块 ${factoryDeployed.blockNumber}，gasUsed ${Number(factoryDeployed.gasUsed).toLocaleString()}）`);

  // 5) 开一期。主网默认不开，避免未核对参数就收款。需要时设 OPEN_CAMPAIGN=1。
  const openCampaign = process.env.OPEN_CAMPAIGN === "1" || (!mainnet && process.env.OPEN_CAMPAIGN !== "0");
  if (!openCampaign) {
    const legacyFactories = collectLegacyFactories(network.name, net.chainId, factoryAddr);
    const out = {
      network: network.name,
      chainId: Number(net.chainId),
      deployedAt: new Date().toISOString(),
      materialMarket,
      /** 晶体管白名单：前端开期表单的可选处理器直接由这份链上事实生成（工厂不再有默认晶体管） */
      allowedParts,
      factory: factoryAddr,
      legacyFactories,
      campaign: "",
      campaignParams: null,
      deployer: deployer.address,
      notes: "BSC 工厂已部署，尚未开期。开期需份额价 / 总份数 / 募集天数 / **晶体管合约（必选，前端从白名单里选 TapeOut / Behemoth）**；工厂不再有默认晶体管。",
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
  // 链上收的是秒：换算在这里做，工厂不再乘 1 days。
  const fundingSeconds = BigInt(fundingDays) * 86400n;

  /**
   * 本期晶体管合约（= 处理器）。**必选**：工厂不再有默认晶体管，开期时必须显式指定一个白名单内的地址。
   * 主网必须由 CAMPAIGN_PARTS_ADDRESS 给出；测试网白名单若只有一个则自动用那个。
   *
   * T-59：官方 Genesis CPU 已整体移除，其晶体管地址不在白名单里，
   * 传进来会被白名单检查直接拒绝 —— 不再开得出「不出矿」的期次。
   */
  let campaignParts = (process.env.CAMPAIGN_PARTS_ADDRESS || "").trim();
  if (!campaignParts) {
    if (mainnet) {
      throw new Error("主网开期必须显式指定 CAMPAIGN_PARTS_ADDRESS（工厂不再有默认晶体管，开期时前端从白名单选 TapeOut / Behemoth）");
    }
    if (allowedParts.length === 1) campaignParts = allowedParts[0];
    else throw new Error("测试网开期需指定 CAMPAIGN_PARTS_ADDRESS，或把白名单只放一个晶体管合约");
  }
  if (!allowedParts.some((a) => a.toLowerCase() === campaignParts.toLowerCase())) {
    throw new Error(`CAMPAIGN_PARTS_ADDRESS ${campaignParts} 不在工厂晶体管白名单内`);
  }
  const partsArg = campaignParts;

  const tx = await factory.createCampaign(sharePrice, totalShares, fundingSeconds, partsArg);
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  const lockedParts = await (await ethers.getContractAt("Campaign", campaignAddr)).transistors();
  console.log(`Campaign   ：${campaignAddr}`);
  console.log(`锁定晶体管  ：${lockedParts}（显式指定 ${campaignParts}）`);

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
    // 链上 MAX_FEE_RECIPIENTS = 3（T-72 由 8 收紧），超了 setServiceFee 直接 revert。
    if (recipients.length > 3) {
      throw new Error(`SERVICE_FEE_RECIPIENTS 最多 3 个（链上 MAX_FEE_RECIPIENTS），当前 ${recipients.length} 个`);
    }
    const c = await ethers.getContractAt("Campaign", campaignAddr);
    await (await c.setServiceFee(feeBps, recipients, shares)).wait();
    feeShares = recipients.map((address, i) => ({ address, shareBps: Number(shares[i]) }));
    console.log(`服务费    ：${feeBps} bps（${Number(feeBps) / 100}%），${recipients.length} 个收款地址`);
  }

  const legacyFactories = collectLegacyFactories(network.name, net.chainId, factoryAddr);

  const out = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    materialMarket,
    /** 晶体管白名单：前端开期表单的可选处理器直接由这份链上事实生成（工厂不再有默认晶体管） */
    allowedParts,
    factory: factoryAddr,
    legacyFactories,
    campaign: campaignAddr,
    campaignParams: {
      sharePriceBnb: process.env.SHARE_PRICE_BNB || "0.01",
      totalShares: Number(totalShares),
      fundingDays,
      fundingSeconds: Number(fundingSeconds),
      /** 本期锁定的晶体管合约（= 处理器）。必选，从白名单里选。 */
      campaignParts,
    },
    serviceFeeBps: Number(feeBps),
    serviceFeeSet: feeBps > 0n,
    feeShares,
    deployer: deployer.address,
    notes: mainnet
      ? "BSC 主网已开期。晶体管市场为官方合约；晶体管合约（处理器）显式指定，落在官方两件套白名单内（TapeOut / Behemoth，均有挖矿产出资格）。"
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
