// 测试网端到端演练：在 BSC 测试网（或本�?Hardhat）跑通一期完整生命周期�?
//
// 目的：主网部署前，先在真链上验证「电路市场」形态能走通全程：
//   工厂部署 �?开期（显式指定 ERC721 电路�?�?认购售罄 �?从市场买入电�?�?
//   确认到账 �?挂回市场卖出并提取货�?�?撤单清账 �?官方 PoD 开矿（start�?�?
//   领取挖矿奖励（BEM）→ 挖矿份额挂单与转�?�?余款 / BEM 领取 �?停矿
//
// 测试网没有官方电路市场与官方电路合约（那些地址�?chainId 97 上没有代码）�?
// 所以用 MockCircuitMarket + MockCircuitNft 替身；两者都�?chainId 56 部署�?revert 的护栏�?
// 官方 PoD 挖矿同样�?MockPodMining + MockBem 替身（同样禁止上主网）�?
//
// 运行：node scripts/testnet-drill.js
const { ethers, network } = require("hardhat");

// 金额规模压到最小：测试网余额有限，演练只需要证明流程通，不需要真实金额�?
const SHARE_PRICE = ethers.parseEther("0.00001");
const TOTAL_SHARES = 100n;
const FUNDING_SECONDS = 7n * 86400n;
const CIRCUIT_PRICE = ethers.parseEther("0.000005");
const RESALE_PRICE = ethers.parseEther("0.00002");
// 演练�?BEM 产出：不追求真实产出规模，够验证「领�?�?按份额记�?�?持份人自领」即可�?
const BEM_PER_CIRCUIT = ethers.parseEther("100");
const FUNDING = ethers.parseEther("0.02");

const SCENE = { Funding: 0, Executing: 1, Mining: 2 };
const PHASE = { None: 0, Buying: 1, Ready: 2 };

let step = 0;
function ok(label, extra = "") {
  step += 1;
  console.log(`  �?[${step}] ${label}${extra ? ` �?${extra}` : ""}`);
}
function section(title) {
  console.log(`\n── ${title} ──`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`断言失败�?{message}`);
}

/** 断言某笔调用以指�?custom error 失败，并返回解码后的 error 名�?*/
async function expectRevert(promise, iface, expectedName) {
  let data = null;
  try {
    await promise;
  } catch (e) {
    if (e && e.revert && e.revert.name) data = e.revert.name;
    else if (e && typeof e.data === "string" && e.data.length >= 10) {
      try { data = iface.parseError(e.data)?.name || null; } catch { data = null; }
    } else if (e && e.data && typeof e.data === "object" && e.data.data) {
      try { data = iface.parseError(e.data.data)?.name || null; } catch { data = null; }
    }
  }
  assert(data === expectedName, `期望 ${expectedName}，实�?${data || "（无解码错误�?}`);
  return data;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  assert(
    Number(net.chainId) === 97 || Number(net.chainId) === 31337,
    `本脚本只�?BSC 测试�?97)或本�?Hardhat(31337) 跑，当前�?${net.chainId}`,
  );

  const [owner] = await ethers.getSigners();
  const ownerBal = await ethers.provider.getBalance(owner.address);
  console.log(`网络 ${network.name} (chainId ${net.chainId})`);
  console.log(`部署�?${owner.address} 余额 ${ethers.formatEther(ownerBal)} BNB`);

  // 测试网只配了一个私钥账户，其余角色用随机钱包，由部署者转测试币过去�?
  const alice = ethers.Wallet.createRandom().connect(ethers.provider);
  const bob = ethers.Wallet.createRandom().connect(ethers.provider);
  const feeRecipient = ethers.Wallet.createRandom().connect(ethers.provider);
  for (const w of [alice, bob, feeRecipient]) {
    await (await owner.sendTransaction({ to: w.address, value: FUNDING })).wait();
  }
  console.log(`  参与钱包已注资：alice / bob / 服务费收款方`);

  section("基础设施：Mock 电路市场 + Mock 电路 NFT + Mock 官方 PoD 挖矿 + 工厂");
  // 市场�?2.5%：从卖方所得里扣（官方市场收卖方费）�?
  const market = await ethers.deployContract("MockCircuitMarket", [250]);
  await market.waitForDeployment();
  const circuits = await ethers.deployContract("MockCircuitNft");
  await circuits.waitForDeployment();
  const bem = await ethers.deployContract("MockBem");
  await bem.waitForDeployment();
  const pod = await ethers.deployContract("MockPodMining", [await bem.getAddress()]);
  await pod.waitForDeployment();
  const marketAddr = await market.getAddress();
  const circuitsAddr = await circuits.getAddress();
  console.log(`  MockCircuitMarket ${marketAddr}`);
  console.log(`  MockCircuitNft    ${circuitsAddr}`);
  console.log(`  MockBem           ${await bem.getAddress()}`);
  console.log(`  MockPodMining     ${await pod.getAddress()}`);

  // 电路合约在官方挖矿里要有算力倍率，否�?start 会被拒（NotEligible）�?
  await (await pod.setProcessor(circuitsAddr, 1)).wait();

  const campaignDeployer = await ethers.deployContract("CampaignDeployer");
  await campaignDeployer.waitForDeployment();

  const factory = await ethers.deployContract("CampaignFactory", [
    marketAddr,
    [circuitsAddr],
    await pod.getAddress(),
    await bem.getAddress(),
    await campaignDeployer.getAddress(),
  ]);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`  CampaignFactory   ${factoryAddr}`);

  assert(
    String(await factory.circuitMarket()).toLowerCase() === marketAddr.toLowerCase(),
    "工厂 circuitMarket 与预期不一�?,
  );
  assert(Number(await factory.allowedCircuitsCount()) === 1, "工厂电路白名单应�?1 �?);
  assert(
    String(await factory.allowedCircuitsAt(0)).toLowerCase() === circuitsAddr.toLowerCase(),
    "工厂电路白名单内容与预期不一�?,
  );
  ok("工厂读回一�?, "circuitMarket + 白名�?1 �?);

  section("开期：ERC721 电路合约必�?);
  await expectRevert(
    factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, ethers.ZeroAddress),
    factory.interface,
    "ZeroAddress",
  );
  ok("零地址开期被�?, "ZeroAddress");

  const outsider = "0x00000000000000000000000000000000000000FF";
  await expectRevert(
    factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, outsider),
    factory.interface,
    "CircuitsNotAllowed",
  );
  ok("白名单外地址开期被�?, "CircuitsNotAllowed");

  await (await factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, circuitsAddr)).wait();
  const campaignAddr = await factory.campaigns(0);
  const campaign = await ethers.getContractAt("Campaign", campaignAddr);
  console.log(`  Campaign ${campaignAddr}`);
  assert(
    String(await campaign.circuits()).toLowerCase() === circuitsAddr.toLowerCase(),
    "期次锁定的电路合约与开期指定的不一�?,
  );
  assert(await factory.isRegistered(campaignAddr), "期次应已登记");
  ok("开期成�?, `锁定电路 ${circuitsAddr}`);

  section("服务费：开期后第二笔交易设置（sold == 0 时才可设�?);
  const feeBps = 100; // 1%
  await (await campaign.setServiceFee(feeBps, [feeRecipient.address], [10000])).wait();
  assert(Number(await campaign.serviceFeeBps()) === feeBps, "服务费费率未上链");
  ok("服务费已上链", `${feeBps} bps / 1 个收款方`);

  section("认购 �?售罄 �?市场卖单准备");
  await (await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE })).wait();
  await (await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE })).wait();
  assert(Number(await campaign.sold()) === 100, "售出份数不对");
  assert(Number(await campaign.scene()) === SCENE.Executing, "售罄后应进入 Executing");
  assert(Number(await campaign.phase()) === PHASE.Buying, "售罄后应进入 Buying");
  ok("售罄", "0.001 BNB 全额�?raisedBnb");

  // Owner 充当卖方：mint 3 张电路，逐张 approve 市场并挂卖单（不�?setApprovalForAll）�?
  const listings = [];
  for (let tokenId = 1; tokenId <= 3; tokenId++) {
    await (await circuits.mint(owner.address, tokenId)).wait();
    await (await circuits.approve(marketAddr, tokenId)).wait();
    await (await market.list(circuitsAddr, tokenId, CIRCUIT_PRICE)).wait();
    const live = await market.listingFor(circuitsAddr, tokenId);
    listings.push({ id: live.id, tokenId: BigInt(tokenId), price: live.price });
  }
  assert(listings.every((l) => l.id !== 0n), "三张电路都应挂单成功");
  ok("市场已挂 3 张电�?, `单价 ${ethers.formatEther(CIRCUIT_PRICE)} BNB`);

  section("Owner 买入电路 �?确认到账");
  // buyCircuits �?non-payable：采购款从本期已募集�?raisedBnb 里出，不�?Owner 钱包另付�?
  const buyTotal = listings.reduce((s, l) => s + l.price, 0n);
  const raisedBefore = await campaign.raisedBnb();
  await (
    await campaign.connect(owner).buyCircuits(
      listings.map((l) => l.id),
      listings.map((l) => l.tokenId),
      listings.map((l) => l.price),
    )
  ).wait();
  assert(raisedBefore - (await campaign.raisedBnb()) === buyTotal, "采购款应�?raisedBnb 扣除");
  assert(Number(await campaign.circuitCount()) === 3, "应买�?3 张电�?);
  assert(Number(await campaign.circuitHeldCount()) === 3, "3 张电路都应在本期合约");
  assert(Number(await campaign.phase()) === PHASE.Buying, "买入后阶段应仍为 Buying");
  for (const l of listings) {
    assert(
      String(await circuits.ownerOf(l.tokenId)).toLowerCase() === campaignAddr.toLowerCase(),
      `token #${l.tokenId} 应由期次合约持有`,
    );
    assert(
      BigInt(await campaign.circuitCostBasis(l.tokenId)) === l.price,
      `token #${l.tokenId} 成本价应记录为成交价`,
    );
  }
  ok("buyCircuits 成功", `3 张，合计 ${ethers.formatEther(buyTotal)} BNB`);

  await (await campaign.confirmCircuits()).wait();
  assert(Number(await campaign.phase()) === PHASE.Ready, "确认后应进入 Ready");
  ok("确认到账", "Ready");

  section("挂回市场卖出 �?提取货款");
  const resaleToken = listings[0].tokenId;
  // 低于成本价也可挂（Owner 裁量）；先验证可挂，再撤掉，再按 RESALE_PRICE 正式挂�?
  await (await campaign.connect(owner).listCircuit(resaleToken, CIRCUIT_PRICE - 1n)).wait();
  ok("低于成本价挂单成�?, ethers.formatEther(CIRCUIT_PRICE - 1n) + " BNB");
  await (await campaign.connect(owner).cancelCircuitListing(resaleToken)).wait();

  await (await campaign.connect(owner).listCircuit(resaleToken, RESALE_PRICE)).wait();
  assert(Number(await campaign.activeListingCount()) === 1, "应有 1 张在�?);
  const resaleListingId = await campaign.circuitListingId(resaleToken);
  assert(resaleListingId !== 0n, "期次应记录挂�?id");
  ok("期次已挂回市�?, `token #${resaleToken} @ ${ethers.formatEther(RESALE_PRICE)} BNB`);

  // 外部买家直接吃单：市场无托管，卖家（期次）仍持有 NFT�?
  await (
    await market.connect(bob).buy(resaleListingId, RESALE_PRICE, { value: RESALE_PRICE })
  ).wait();
  assert(
    String(await circuits.ownerOf(resaleToken)).toLowerCase() === bob.address.toLowerCase(),
    "卖出�?token 应归买家",
  );
  const owed = await market.owed(campaignAddr);
  assert(owed > 0n, "市场应欠期次货款");
  const netExpected = RESALE_PRICE - (RESALE_PRICE * 250n) / 10000n;
  assert(owed === netExpected, "市场欠款应为扣除卖方费后的净�?);
  ok("买家已吃�?, `市场欠款 ${ethers.formatEther(owed)} BNB`);

  await (await campaign.withdrawMarketProceeds()).wait();
  assert(Number(await market.owed(campaignAddr)) === 0, "提取后市场欠款应�?0");
  ok("货款已提�?, `+${ethers.formatEther(netExpected)} BNB �?raisedBnb`);

  // 已成交的挂单仍需撤单清账：activeListingCount 不归零就无法开启挖矿�?
  await (await campaign.cancelCircuitListing(resaleToken)).wait();
  assert(Number(await campaign.activeListingCount()) === 0, "撤单后挂单数应为 0");
  assert(Number(await campaign.circuitHeldCount()) === 2, "卖出 1 张后应持�?2 �?);
  ok("已成交挂单已清账", "activeListingCount = 0，持�?2 �?);

  section("官方 PoD 开矿：电路仍留在期次，由期次自己当矿工");
  // 期次持有 NFT 才能 start：电路永远不出期次，所以不设矿池、不�?NFT�?
  const heldTokenIds = [];
  for (const l of listings) {
    if ((await circuits.ownerOf(l.tokenId)) === campaignAddr) heldTokenIds.push(l.tokenId);
  }
  assert(heldTokenIds.length === 2, "应有 2 张电路仍由期次持�?);

  // taskId = 0：官方未验证池，一次调用即可开矿（不必�?arm）�?
  for (const tokenId of heldTokenIds) {
    await (await campaign.connect(owner).startMining(tokenId)).wait();
    assert(Number(await campaign.miningStatus(tokenId)) === 1, `token #${tokenId} 应处于挖矿中`);
  }
  assert(Number(await campaign.scene()) === SCENE.Mining, "开矿后应进�?Mining");
  assert(Number(await campaign.circuitHeldCount()) === 2, "开矿后电路仍应由期次持�?);
  ok("2 张电路已开�?, "Mining（电路不出期次）");

  section("挖矿奖励：官方结算到 BEM，按期次份额记账后持份人自领");
  for (const tokenId of heldTokenIds) {
    await (await pod.accrue(await pod.minerKey(await nft.getAddress(), tokenId), BEM_PER_CIRCUIT)).wait();
  }
  assert(
    (await campaign.miningPending(heldTokenIds[0])) === BEM_PER_CIRCUIT,
    "官方待结�?BEM 应可�?,
  );
  await (await campaign.claimMiningRewards()).wait();
  const bemGross = BEM_PER_CIRCUIT * 2n;
  const bemFee = (bemGross * BigInt(feeBps)) / 10000n;
  const bemNet = bemGross - bemFee;
  const bemInRound = await bem.balanceOf(campaignAddr);
  assert(bemInRound === bemGross, "领奖后 BEM 毛额应全部进期次（含待领服务费）");
  assert((await campaign.pendingFee(feeRecipient.address)) === bemFee, "服务费应按费率计提给分成地址");
  ok("挖矿奖励已领取", `${ethers.formatEther(bemGross)} BEM 进期次 · 服务费 ${ethers.formatEther(bemFee)} BEM`);

  section("挖矿份额转让（Mining 才开放）");
  await (await campaign.connect(alice).listShares(20n, CIRCUIT_PRICE)).wait();
  const listing = await campaign.getListing(0);
  assert(String(listing.seller).toLowerCase() === alice.address.toLowerCase(), "挂单方不对");
  assert(Number(listing.shares) === 20, "挂单份数不对");
  ok("Alice 挂单 20 份", `${ethers.formatEther(CIRCUIT_PRICE)} BNB/份`);

  await (
    await campaign.connect(bob).takeListing(0n, 5n, { value: 5n * CIRCUIT_PRICE })
  ).wait();
  assert(Number(await campaign.sharesOf(bob.address)) === 45, "Bob 应为 40 + 5 = 45 份");
  assert(Number(await campaign.sharesOf(alice.address)) === 40, "Alice 转让后应为 40 份");
  assert(Number(await campaign.escrowOf(alice.address)) === 15, "Alice 托管应剩 15 份");
  ok("Bob 接收 5 份", "份额过户 + BNB 原子支付");

  section("余款 / BEM 领取：都是按份 pull");
  const surplusBefore = await campaign.surplusPaid();
  await (await campaign.connect(alice).claimSurplus()).wait();
  const surplusAfter = await campaign.surplusPaid();
  assert(surplusAfter > surplusBefore, "surplusPaid 应累计（余款已发放）");
  assert(Number(await campaign.pendingSurplus(alice.address)) === 0, "Alice 的 pendingSurplus 应清零");
  ok("余款已领取", `累计发放 ${ethers.formatEther(surplusAfter)} BNB`);

  // 净值按转账前份额记账：Alice 60%、Bob 40%；服务费不进持份人 pending。
  const aliceBem = await campaign.bemPendingOf(alice.address);
  assert(aliceBem > 0n, "Alice 应有可领 BEM");
  assert(aliceBem === (bemNet * 60n) / 100n, "Alice 的 BEM 应为扣费后净值的 60%");
  assert(
    (await campaign.bemPendingOf(bob.address)) === (bemNet * 40n) / 100n,
    "Bob 的 BEM 应为扣费后净值的 40%",
  );
  const aliceBemExpected = aliceBem;
  await (await campaign.connect(alice).claimBem()).wait();
  assert((await bem.balanceOf(alice.address)) === aliceBemExpected, "领取的 BEM 应到 Alice 钱包");
  assert((await campaign.bemPendingOf(alice.address)) === 0n, "领取后应无可领余额");
  ok("BEM 已领取", `${ethers.formatEther(aliceBemExpected)} BEM → Alice 钱包`);

  section("停矿：结算剩余奖励，NFT 仍留期次");
  await (await campaign.connect(owner).stopMining(heldTokenIds[0])).wait();
  assert(Number(await campaign.miningStatus(heldTokenIds[0])) === 3, "停矿后应进入冷却");
  assert(
    String(await circuits.ownerOf(heldTokenIds[0])).toLowerCase() === campaignAddr.toLowerCase(),
    "停矿后电路仍应由期次持有",
  );
  ok("已停矿", "status = 3（cooling），NFT 不出期次");

  section("挖矿产出服务费：分成地址领取 BEM");
  const feesPaidBefore = await campaign.totalFeesPaid();
  const feeDue = await campaign.pendingFee(feeRecipient.address);
  assert(feeDue === bemFee, "待领服务费应等于计提额");
  await (await campaign.connect(feeRecipient).claimFee()).wait();
  const feesPaidAfter = await campaign.totalFeesPaid();
  assert(feesPaidAfter > feesPaidBefore, "totalFeesPaid 应累计");
  assert(Number(await campaign.pendingFee(feeRecipient.address)) === 0, "领取后 pendingFee 应清零");
  assert((await bem.balanceOf(feeRecipient.address)) === feeDue, "服务费 BEM 应到收款方钱包");
  ok("服务费已领取", `本次领取 ${ethers.formatEther(feeDue)} BEM`);

  section("结果");
  console.log(`  工厂      ${factoryAddr}`);
  console.log(`  期次      ${campaignAddr}`);
  console.log(`  场景      Mining，电路由期次持有 ${await campaign.circuitHeldCount()} 张`);
  console.log(`  售出      ${await campaign.sold()} 份，托管 ${ethers.formatEther(await campaign.raisedBnb())} BNB`);
  console.log(`  挖矿      累计产出 ${ethers.formatEther(await campaign.totalBemRewards())} BEM`);
  console.log(`  份额      Alice ${await campaign.sharesOf(alice.address)} / Bob ${await campaign.sharesOf(bob.address)}`);
  console.log(`  服务费    已付 ${ethers.formatEther(await campaign.totalFeesPaid())} BEM`);
  console.log(`\n测试网完整生命周期演练通过（${step} 项检查）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
