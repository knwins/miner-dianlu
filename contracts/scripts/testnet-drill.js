// 测试网端到端演练：在 BSC 测试网跑通一期完整生命周期。
//
// 目的：主网部署前，先在真链上验证 T-79 形态（工厂 2 参 / 开期必选晶体管）能走通全程：
//   工厂部署 → 开期（显式指定晶体管） → 认购售罄 → Owner 下单 → 市场成交交割 →
//   确认到账 → 设矿池入池（不可逆） → 挖矿份额挂单与转让 → 余款领取 →
//   挖矿产出服务费计提与领取
//
// 测试网没有官方晶体管市场与官方晶体管合约（那些地址在 chainId 97 上没有代码），
// 所以用 MockMaterialMarket + MockERC1155 替身；它们都有 chainId 56 部署即 revert 的护栏。
//
// 运行：node scripts/testnet-drill.js
const { ethers, network } = require("hardhat");

// 金额规模压到最小：测试网余额有限，演练只需要证明流程通，不需要真实金额。
// 100 份 × 0.00001 BNB = 0.001 BNB 募资总额；晶体管总成本 0.0005 BNB，剩 0.0005 作余款。
const SHARE_PRICE = ethers.parseEther("0.00001");
const TOTAL_SHARES = 100n;
const FUNDING_SECONDS = 7n * 86400n;
const UNIT_PRICE = ethers.parseEther("0.000005");
const NAND_QTY = 60n;
const LATCH_QTY = 40n;
const LIST_PRICE = ethers.parseEther("0.00002");
const REVENUE = ethers.parseEther("0.01");
/** 每个参与钱包的注资额：够付认购/操作 + gas 即可。矿池钱包还要付得起挖矿收益。 */
const FUNDING = ethers.parseEther("0.02");

// 注意：枚举 getter 返回 bigint，比较时统一转成 number（JS 里 1 === 1n 是 false）。
const SCENE = { Funding: 0, Executing: 1, Mining: 2 };
const PHASE = { None: 0, Buying: 1, Listed: 2, Ready: 3 };

let step = 0;
function ok(label, extra = "") {
  step += 1;
  console.log(`  ✓ [${step}] ${label}${extra ? ` — ${extra}` : ""}`);
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

/** 断言：条件不成立就直接抛错，脚本非零退出。 */
function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`);
}

/**
 * 断言某笔调用以指定 custom error 失败，并返回解码后的 error 名。
 *
 * ⚠️ 为什么不能直接看 e.revert：
 * 走 estimateGas / eth_call 时，ethers 把错误包成 ProviderError，
 * 原因数据只在 `e.data` 里（十六进制 revert data），不会自动解码成 e.revert。
 * 这里自己用接口的 parseError 解，才能确认真实报错名而不是笼统的 "execution reverted"。
 */
async function expectRevert(promise, iface, expectedName) {
  let data = null;
  try {
    await promise;
  } catch (e) {
    if (e && e.revert && e.revert.name) data = e.revert.name;
    else if (e && typeof e.data === "string" && e.data.length >= 10) {
      try {
        data = iface.parseError(e.data)?.name || null;
      } catch {
        data = null;
      }
    } else if (e && e.data && typeof e.data === "object" && e.data.data) {
      try {
        data = iface.parseError(e.data.data)?.name || null;
      } catch {
        data = null;
      }
    }
  }
  assert(data === expectedName, `期望 ${expectedName}，实际 ${data || "（无解码错误）"}`);
  return data;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  // 97 = BSC 测试网；31337 = 本地 Hardhat（余额无限，用于先验证脚本本身没写错）。
  assert(
    Number(net.chainId) === 97 || Number(net.chainId) === 31337,
    `本脚本只在 BSC 测试网(97)或本地 Hardhat(31337) 跑，当前是 ${net.chainId}`,
  );

  const [owner] = await ethers.getSigners();
  const ownerBal = await ethers.provider.getBalance(owner.address);
  console.log(`网络 ${network.name} (chainId ${net.chainId})`);
  console.log(`部署者 ${owner.address} 余额 ${ethers.formatEther(ownerBal)} BNB`);

  // 测试网只配了一个私钥账户，其余角色用随机钱包，由部署者转测试币过去。
  const alice = ethers.Wallet.createRandom().connect(ethers.provider);
  const bob = ethers.Wallet.createRandom().connect(ethers.provider);
  const poolWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  const feeRecipient = ethers.Wallet.createRandom().connect(ethers.provider);
  for (const w of [alice, bob, poolWallet, feeRecipient]) {
    await (await owner.sendTransaction({ to: w.address, value: FUNDING })).wait();
  }
  console.log(`  参与钱包已注资：alice ${alice.address.slice(0, 10)}… / bob ${bob.address.slice(0, 10)}… / 矿池 ${poolWallet.address.slice(0, 10)}…`);

  section("基础设施：mock 晶体管市场 + mock 晶体管 + 工厂");
  const market = await ethers.deployContract("MockMaterialMarket");
  await market.waitForDeployment();
  const parts = await ethers.deployContract("MockERC1155");
  await parts.waitForDeployment();
  const marketAddr = await market.getAddress();
  const partsAddr = await parts.getAddress();
  console.log(`  MockMaterialMarket ${marketAddr}`);
  console.log(`  MockERC1155       ${partsAddr}`);

  const factory = await ethers.deployContract("CampaignFactory", [marketAddr, [partsAddr]]);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`  CampaignFactory   ${factoryAddr}`);

  // 读回构造参数，确认链上事实与预期一致（immutable 不可事后改）。
  assert(
    String(await factory.materialMarket()).toLowerCase() === marketAddr.toLowerCase(),
    "工厂 materialMarket 与预期不一致",
  );
  assert(Number(await factory.allowedPartsCount()) === 1, "工厂晶体管白名单应为 1 项");
  assert(
    String(await factory.allowedPartsAt(0)).toLowerCase() === partsAddr.toLowerCase(),
    "工厂晶体管白名单内容与预期不一致",
  );
  ok("工厂读回一致", "materialMarket + 白名单 1 项");

  section("开期：晶体管合约必选");
  // 零地址必须被拒（ZeroAddress）。
  await expectRevert(
    factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, ethers.ZeroAddress),
    factory.interface,
    "ZeroAddress",
  );
  ok("零地址开期被拒", "ZeroAddress");

  // 白名单外的地址必须被拒（PartsNotAllowed）。
  const outsider = "0x00000000000000000000000000000000000000FF";
  await expectRevert(
    factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, outsider),
    factory.interface,
    "PartsNotAllowed",
  );
  ok("白名单外地址开期被拒", "PartsNotAllowed");

  const tx = await factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, partsAddr);
  await tx.wait();
  const campaignAddr = await factory.campaigns(0);
  const campaign = await ethers.getContractAt("Campaign", campaignAddr);
  console.log(`  Campaign ${campaignAddr}`);
  assert(
    String(await campaign.transistors()).toLowerCase() === partsAddr.toLowerCase(),
    "期次锁定的晶体管合约与开期指定的不一致",
  );
  assert(await factory.isRegistered(campaignAddr), "期次应已登记");
  ok("开期成功", `锁定晶体管 ${partsAddr}`);

  section("服务费：开期后第二笔交易设置（sold == 0 时才可设）");
  const feeBps = 100; // 1%
  await (
    await campaign.setServiceFee(feeBps, [feeRecipient.address], [10000])
  ).wait();
  assert(Number(await campaign.serviceFeeBps()) === feeBps, "服务费费率未上链");
  assert(Number(await campaign.feeRecipientCount()) === 1, "服务费收款方数量不对");
  ok("服务费已上链", `${feeBps} bps / 1 个收款方`);

  section("认购 → 售罄");
  await (await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE })).wait();
  await (await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE })).wait();
  assert(Number(await campaign.sold()) === 100, "售出份数不对");
  assert(Number(await campaign.scene()) === SCENE.Executing, "售罄后应进入 Executing");
  assert(Number(await campaign.phase()) === PHASE.Buying, "售罄后应进入 Buying");
  assert(
    ethers.formatEther(await campaign.raisedBnb()) === "0.001",
    "托管金额应为 0.001 BNB（认筹款不收服务费）",
  );
  ok("售罄", "0.001 BNB 全额进 raisedBnb");

  section("Owner 下单 → 市场成交交割");
  await (await campaign.connect(owner).setPlan(408n)).wait();
  await (
    await campaign
      .connect(owner)
      .placeTransistorOrder(NAND_QTY, UNIT_PRICE, LATCH_QTY, UNIT_PRICE)
  ).wait();
  assert(Number(await campaign.phase()) === PHASE.Listed, "下单后应进入 Listed");
  const nandBidId = await campaign.nandBidId();
  const latchBidId = await campaign.latchBidId();
  assert(Number(nandBidId) > 0 && Number(latchBidId) > 0, "两条腿都应产生挂单 id");
  ok("买单已挂", `nand#${nandBidId} / latch#${latchBidId}`);

  // 模拟市场成交：fillBid 把 remaining 清零，并 mint 晶体管到期次合约。
  await (await market.fillBid(nandBidId, NAND_QTY)).wait();
  await (await market.fillBid(latchBidId, LATCH_QTY)).wait();
  await (await parts.mint(campaignAddr, 0, NAND_QTY)).wait();
  await (await parts.mint(campaignAddr, 1, LATCH_QTY)).wait();
  assert(await campaign.orderFilled(), "两条腿都应已成交");
  ok("市场成交并交割晶体管", "NAND 60 / LATCH 40 已到账");

  section("确认到账 → 设矿池 → 入池（不可逆）");
  await (await campaign.confirmTransistors()).wait();
  assert(Number(await campaign.phase()) === PHASE.Ready, "确认后应进入 Ready");
  ok("确认到账", "Ready");

  // 矿池地址必须能接收 ERC1155，且必须是能发交易的钱包（后面它要打挖矿收益）。
  // MockERC1155 的 safeTransferFrom 不检查 receiver 钩子，用普通钱包地址即可收晶体管。
  const poolAddr = poolWallet.address;
  await (await campaign.connect(owner).setMiningPool(poolAddr)).wait();
  await (await campaign.connect(owner).depositToPool()).wait();
  assert(await campaign.pooled(), "入池后 pooled 应为 true");
  assert(Number(await campaign.scene()) === SCENE.Mining, "入池后应进入 Mining");
  assert(
    Number(await parts.balanceOf(poolAddr, 0)) === Number(NAND_QTY) &&
      Number(await parts.balanceOf(poolAddr, 1)) === Number(LATCH_QTY),
    "晶体管未全部转入矿池",
  );
  ok("入池完成", "Mining（不可逆）");

  section("挖矿份额转让（仅 Mining 开放）");
  await (await campaign.connect(alice).listShares(20n, LIST_PRICE)).wait();
  const listing = await campaign.getListing(0);
  assert(String(listing.seller).toLowerCase() === alice.address.toLowerCase(), "挂单方不对");
  assert(Number(listing.shares) === 20, "挂单份数不对");
  ok("Alice 挂单 20 份", `${ethers.formatEther(LIST_PRICE)} BNB/份`);

  const bobBefore = await ethers.provider.getBalance(bob.address);
  await (
    await campaign.connect(bob).takeListing(0n, 5n, { value: 5n * LIST_PRICE })
  ).wait();
  const bobAfter = await ethers.provider.getBalance(bob.address);
  assert(Number(await campaign.sharesOf(bob.address)) === 45, "Bob 应为 40（认购）+ 5（受让）= 45 份");
  assert(Number(await campaign.sharesOf(alice.address)) === 40, "Alice 转让后应剩 40 份");
  assert(Number(await campaign.escrowOf(alice.address)) === 15, "Alice 托管应剩 15 份");
  assert(
    bobAfter < bobBefore,
    "Bob 支付了份额款，余额应净减少（付款已发生）",
  );
  ok("Bob 接收 5 份", "份额过户 + BNB 原子支付");

  section("余款领取（入池后按份 pull）");
  const surplusBefore = await campaign.surplusPaid();
  await (await campaign.connect(alice).claimSurplus()).wait();
  const surplusAfter = await campaign.surplusPaid();
  assert(surplusAfter > surplusBefore, "surplusPaid 应累计（余款已发放）");
  assert(
    Number(await campaign.pendingSurplus(alice.address)) === 0,
    "Alice 的 pendingSurplus 应清零",
  );
  ok("余款已领取", `累计发放 ${ethers.formatEther(surplusAfter)} BNB`);

  section("挖矿产出服务费：只有矿池能打款，计提后收款方自行领取");
  // 非矿池调用必须被拒（金额要够付 gas，但不必大 —— 权限检查在转账之前）。
  await expectRevert(
    campaign.connect(alice).depositRevenue({ value: ethers.parseEther("0.001") }),
    campaign.interface,
    "NotOwner",
  );
  ok("非矿池调用被拒", "depositRevenue 权限边界正确");

  // 矿池打 0.05 BNB 挖矿收益 → 按 1% 计提服务费，剩余进 revenuePool。
  const revenue = REVENUE;
  await (await campaign.connect(poolWallet).depositRevenue({ value: revenue })).wait();
  const expectedFee = (revenue * BigInt(feeBps)) / 10000n;
  assert(
    ethers.formatEther(await campaign.pendingFeeOf(feeRecipient.address)) ===
      ethers.formatEther(expectedFee),
    "计提的服务费与预期不一致",
  );
  assert(
    ethers.formatEther(await campaign.revenuePool()) ===
      ethers.formatEther(revenue - expectedFee),
    "revenuePool 净额不对",
  );
  ok("收益入账并计提", `服务费 ${ethers.formatEther(expectedFee)} BNB，净额进 revenuePool`);

  // 收款方自行领取。
  // ⚠️ 断言用链上账务（totalFeesPaid / pendingFee），不用钱包余额：
  // 领取到账的金额可能小于这笔交易的 gas 成本，余额净额不可靠。
  const feesPaidBefore = await campaign.totalFeesPaid();
  await (await campaign.connect(feeRecipient).claimFee()).wait();
  const feesPaidAfter = await campaign.totalFeesPaid();
  assert(
    feesPaidAfter > feesPaidBefore,
    "totalFeesPaid 应累计（服务费已发放）",
  );
  assert(Number(await campaign.pendingFeeOf(feeRecipient.address)) === 0, "领取后 pendingFee 应清零");
  ok(
    "服务费已领取",
    `本次领取 ${ethers.formatEther(feesPaidAfter - feesPaidBefore)} BNB`,
  );

  section("结果");
  console.log(`  工厂      ${factoryAddr}`);
  console.log(`  期次      ${campaignAddr}`);
  console.log(`  场景/子态 Mining / Ready，pooled=${await campaign.pooled()}`);
  console.log(`  售出      ${await campaign.sold()} 份，托管 ${ethers.formatEther(await campaign.raisedBnb())} BNB`);
  console.log(`  晶体管      矿池持有 NAND ${await parts.balanceOf(poolAddr, 0)} / LATCH ${await parts.balanceOf(poolAddr, 1)}`);
  console.log(`  份额      Alice ${await campaign.sharesOf(alice.address)} / Bob ${await campaign.sharesOf(bob.address)}`);
  console.log(`  收益池    ${ethers.formatEther(await campaign.revenuePool())} BNB`);
  console.log(`\n✓ 测试网完整生命周期演练通过（${step} 项检查）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
