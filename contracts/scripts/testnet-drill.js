// 测试网端到端演练：在 BSC 测试网（或本地 Hardhat）跑通一期完整生命周期。
//
// 目的：主网部署前，先在真链上验证「电路市场」形态能走通全程：
//   工厂部署 → 开期（显式指定 ERC721 电路） → 认购售罄 → 从市场买入电路 →
//   确认到账 → 挂回市场卖出并提取货款 → 撤单清账 → 官方 PoD 开矿（start） →
//   领取挖矿奖励（BEM）→ 挖矿份额挂单与转让 → 余款 / BEM 领取 → 停矿
//
// 测试网没有官方电路市场与官方电路合约（那些地址在 chainId 97 上没有代码），
// 所以用 MockCircuitMarket + MockCircuitNft 替身；两者都有 chainId 56 部署即 revert 的护栏。
// 官方 PoD 挖矿同样用 MockPodMining + MockBem 替身（同样禁止上主网）。
//
// 运行：node scripts/testnet-drill.js
const { ethers, network } = require("hardhat");

// 金额规模压到最小：测试网余额有限，演练只需要证明流程通，不需要真实金额。
const SHARE_PRICE = ethers.parseEther("0.00001");
const TOTAL_SHARES = 100n;
const FUNDING_SECONDS = 7n * 86400n;
const CIRCUIT_PRICE = ethers.parseEther("0.000005");
const RESALE_PRICE = ethers.parseEther("0.00002");
// 演练用 BEM 产出：不追求真实产出规模，够验证「领奖 → 按份额记账 → 持份人自领」即可。
const BEM_PER_CIRCUIT = ethers.parseEther("100");
const FUNDING = ethers.parseEther("0.02");

const SCENE = { Funding: 0, Executing: 1, Mining: 2 };
const PHASE = { None: 0, Buying: 1, Ready: 2 };

let step = 0;
function ok(label, extra = "") {
  step += 1;
  console.log(`  ✓ [${step}] ${label}${extra ? ` — ${extra}` : ""}`);
}
function section(title) {
  console.log(`\n── ${title} ──`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`);
}

/** 断言某笔调用以指定 custom error 失败，并返回解码后的 error 名。 */
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
  assert(data === expectedName, `期望 ${expectedName}，实际 ${data || "（无解码错误）"}`);
  return data;
}

async function main() {
  const net = await ethers.provider.getNetwork();
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
  const feeRecipient = ethers.Wallet.createRandom().connect(ethers.provider);
  for (const w of [alice, bob, feeRecipient]) {
    await (await owner.sendTransaction({ to: w.address, value: FUNDING })).wait();
  }
  console.log(`  参与钱包已注资：alice / bob / 服务费收款方`);

  section("基础设施：Mock 电路市场 + Mock 电路 NFT + Mock 官方 PoD 挖矿 + 工厂");
  // 市场费 2.5%：从卖方所得里扣（官方市场收卖方费）。
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

  // 电路合约在官方挖矿里要有算力倍率，否则 start 会被拒（NotEligible）。
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
    "工厂 circuitMarket 与预期不一致",
  );
  assert(Number(await factory.allowedCircuitsCount()) === 1, "工厂电路白名单应为 1 项");
  assert(
    String(await factory.allowedCircuitsAt(0)).toLowerCase() === circuitsAddr.toLowerCase(),
    "工厂电路白名单内容与预期不一致",
  );
  ok("工厂读回一致", "circuitMarket + 白名单 1 项");

  section("开期：ERC721 电路合约必选");
  await expectRevert(
    factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, ethers.ZeroAddress),
    factory.interface,
    "ZeroAddress",
  );
  ok("零地址开期被拒", "ZeroAddress");

  const outsider = "0x00000000000000000000000000000000000000FF";
  await expectRevert(
    factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, outsider),
    factory.interface,
    "CircuitsNotAllowed",
  );
  ok("白名单外地址开期被拒", "CircuitsNotAllowed");

  await (await factory.createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, circuitsAddr)).wait();
  const campaignAddr = await factory.campaigns(0);
  const campaign = await ethers.getContractAt("Campaign", campaignAddr);
  console.log(`  Campaign ${campaignAddr}`);
  assert(
    String(await campaign.circuits()).toLowerCase() === circuitsAddr.toLowerCase(),
    "期次锁定的电路合约与开期指定的不一致",
  );
  assert(await factory.isRegistered(campaignAddr), "期次应已登记");
  ok("开期成功", `锁定电路 ${circuitsAddr}`);

  section("服务费：开期后第二笔交易设置（sold == 0 时才可设）");
  const feeBps = 100; // 1%
  await (await campaign.setServiceFee(feeBps, [feeRecipient.address], [10000])).wait();
  assert(Number(await campaign.serviceFeeBps()) === feeBps, "服务费费率未上链");
  ok("服务费已上链", `${feeBps} bps / 1 个收款方`);

  section("认购 → 售罄 → 市场卖单准备");
  await (await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE })).wait();
  await (await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE })).wait();
  assert(Number(await campaign.sold()) === 100, "售出份数不对");
  assert(Number(await campaign.scene()) === SCENE.Executing, "售罄后应进入 Executing");
  assert(Number(await campaign.phase()) === PHASE.Buying, "售罄后应进入 Buying");
  ok("售罄", "0.001 BNB 全额进 raisedBnb");

  // Owner 充当卖方：mint 3 张电路，逐张 approve 市场并挂卖单（不是 setApprovalForAll）。
  const listings = [];
  for (let tokenId = 1; tokenId <= 3; tokenId++) {
    await (await circuits.mint(owner.address, tokenId)).wait();
    await (await circuits.approve(marketAddr, tokenId)).wait();
    await (await market.list(circuitsAddr, tokenId, CIRCUIT_PRICE)).wait();
    const live = await market.listingFor(circuitsAddr, tokenId);
    listings.push({ id: live.id, tokenId: BigInt(tokenId), price: live.price });
  }
  assert(listings.every((l) => l.id !== 0n), "三张电路都应挂单成功");
  ok("市场已挂 3 张电路", `单价 ${ethers.formatEther(CIRCUIT_PRICE)} BNB`);

  section("Owner 买入电路 → 确认到账");
  // buyCircuits 是 non-payable：采购款从本期已募集的 raisedBnb 里出，不从 Owner 钱包另付。
  const buyTotal = listings.reduce((s, l) => s + l.price, 0n);
  const raisedBefore = await campaign.raisedBnb();
  await (
    await campaign.connect(owner).buyCircuits(
      listings.map((l) => l.id),
      listings.map((l) => l.tokenId),
      listings.map((l) => l.price),
    )
  ).wait();
  assert(raisedBefore - (await campaign.raisedBnb()) === buyTotal, "采购款应从 raisedBnb 扣除");
  assert(Number(await campaign.circuitCount()) === 3, "应买入 3 张电路");
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

  section("挂回市场卖出 → 提取货款");
  const resaleToken = listings[0].tokenId;
  // 低于成本价的挂单必须被拒（抵押不足会烧掉份额背书）。
  await expectRevert(
    campaign.connect(owner).listCircuit(resaleToken, CIRCUIT_PRICE - 1n),
    campaign.interface,
    "PriceBelowCost",
  );
  ok("低于成本价挂单被拒", "PriceBelowCost");

  await (await campaign.connect(owner).listCircuit(resaleToken, RESALE_PRICE)).wait();
  assert(Number(await campaign.activeListingCount()) === 1, "应有 1 张在挂");
  const resaleListingId = await campaign.circuitListingId(resaleToken);
  assert(resaleListingId !== 0n, "期次应记录挂单 id");
  ok("期次已挂回市场", `token #${resaleToken} @ ${ethers.formatEther(RESALE_PRICE)} BNB`);

  // 外部买家直接吃单：市场无托管，卖家（期次）仍持有 NFT。
  await (
    await market.connect(bob).buy(resaleListingId, RESALE_PRICE, { value: RESALE_PRICE })
  ).wait();
  assert(
    String(await circuits.ownerOf(resaleToken)).toLowerCase() === bob.address.toLowerCase(),
    "卖出后 token 应归买家",
  );
  const owed = await market.owed(campaignAddr);
  assert(owed > 0n, "市场应欠期次货款");
  const netExpected = RESALE_PRICE - (RESALE_PRICE * 250n) / 10000n;
  assert(owed === netExpected, "市场欠款应为扣除卖方费后的净额");
  ok("买家已吃单", `市场欠款 ${ethers.formatEther(owed)} BNB`);

  await (await campaign.withdrawMarketProceeds()).wait();
  assert(Number(await market.owed(campaignAddr)) === 0, "提取后市场欠款应为 0");
  ok("货款已提取", `+${ethers.formatEther(netExpected)} BNB 进 raisedBnb`);

  // 已成交的挂单仍需撤单清账：activeListingCount 不归零就无法开启挖矿。
  await (await campaign.cancelCircuitListing(resaleToken)).wait();
  assert(Number(await campaign.activeListingCount()) === 0, "撤单后挂单数应为 0");
  assert(Number(await campaign.circuitHeldCount()) === 2, "卖出 1 张后应持有 2 张");
  ok("已成交挂单已清账", "activeListingCount = 0，持有 2 张");

  section("官方 PoD 开矿：电路仍留在期次，由期次自己当矿工");
  // 期次持有 NFT 才能 start：电路永远不出期次，所以不设矿池、不转 NFT。
  const heldTokenIds = [];
  for (const l of listings) {
    if ((await circuits.ownerOf(l.tokenId)) === campaignAddr) heldTokenIds.push(l.tokenId);
  }
  assert(heldTokenIds.length === 2, "应有 2 张电路仍由期次持有");

  // taskId = 0：官方未验证池，一次调用即可开矿（不必先 arm）。
  for (const tokenId of heldTokenIds) {
    await (await campaign.connect(owner).startMining(tokenId, 0, 0, [], [], [])).wait();
    assert(Number(await campaign.miningStatus(tokenId)) === 1, `token #${tokenId} 应处于挖矿中`);
  }
  assert(Number(await campaign.scene()) === SCENE.Mining, "开矿后应进入 Mining");
  assert(Number(await campaign.circuitHeldCount()) === 2, "开矿后电路仍应由期次持有");
  ok("2 张电路已开矿", "Mining（电路不出期次）");

  section("挖矿奖励：官方结算到 BEM，按期次份额记账后持份人自领");
  for (const tokenId of heldTokenIds) {
    await (await pod.accrue(await campaign.miningKey(tokenId), BEM_PER_CIRCUIT)).wait();
  }
  assert(
    (await campaign.miningPending(heldTokenIds[0])) === BEM_PER_CIRCUIT,
    "官方待结算 BEM 应可读",
  );
  await (await campaign.claimMiningRewards()).wait();
  const bemInRound = await bem.balanceOf(campaignAddr);
  assert(bemInRound === BEM_PER_CIRCUIT * 2n, "领奖后 BEM 应全部进期次");
  ok("挖矿奖励已领取", `${ethers.formatEther(bemInRound)} BEM 进期次`);

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
  assert(Number(await campaign.sharesOf(alice.address)) === 40, "Alice 转让后应剩 40 份");
  assert(Number(await campaign.escrowOf(alice.address)) === 15, "Alice 托管应剩 15 份");
  ok("Bob 接收 5 份", "份额过户 + BNB 原子支付");

  section("余款与 BEM 领取：都是按份 pull");
  const surplusBefore = await campaign.surplusPaid();
  await (await campaign.connect(alice).claimSurplus()).wait();
  const surplusAfter = await campaign.surplusPaid();
  assert(surplusAfter > surplusBefore, "surplusPaid 应累计（余款已发放）");
  assert(Number(await campaign.pendingSurplus(alice.address)) === 0, "Alice 的 pendingSurplus 应清零");
  ok("余款已领取", `累计发放 ${ethers.formatEther(surplusAfter)} BNB`);

  // BEM 在转账之前就已按份记账：Alice 当时 60 份，所以这 200 BEM 里归她 60%（120），
  // Bob 的 5 份只从接收那一刻起计息（他的 debt 被抬到当前累计值），不会重复分走 Alice 的既往产出。
  const aliceBem = await campaign.bemPendingOf(alice.address);
  assert(aliceBem > 0n, "Alice 应有可领 BEM");
  assert(aliceBem === (bemInRound * 60n) / 100n, "Alice 的 BEM 应为转账前 60 份对应份额");
  assert(
    (await campaign.bemPendingOf(bob.address)) === (bemInRound * 40n) / 100n,
    "Bob 的 BEM 应为 40 份对应份额（既往产出不随份额转移）",
  );
  const aliceBemExpected = aliceBem;
  await (await campaign.connect(alice).claimBem()).wait();
  assert((await bem.balanceOf(alice.address)) === aliceBemExpected, "领取后 BEM 应到 Alice 钱包");
  assert((await campaign.bemPendingOf(alice.address)) === 0n, "领取后应无可领余额");
  ok("BEM 已领取", `${ethers.formatEther(aliceBemExpected)} BEM 到 Alice 钱包`);

  section("停矿：结算剩余奖励，NFT 仍留期次");
  await (await campaign.connect(owner).stopMining(heldTokenIds[0])).wait();
  assert(Number(await campaign.miningStatus(heldTokenIds[0])) === 3, "停矿后应进入冷却");
  assert(
    String(await circuits.ownerOf(heldTokenIds[0])).toLowerCase() === campaignAddr.toLowerCase(),
    "停矿后电路仍应由期次持有",
  );
  ok("已停矿", "status = 3（cooling），NFT 不出期次");

  section("挖矿产出服务费：只有 Owner 能打款，计提后收款方自行领取");
  const REVENUE = ethers.parseEther("0.01");
  await expectRevert(
    campaign.connect(alice).depositRevenue({ value: ethers.parseEther("0.001") }),
    campaign.interface,
    "NotOwner",
  );
  ok("非 Owner 调用被拒", "depositRevenue 权限边界正确");

  await (await campaign.connect(owner).depositRevenue({ value: REVENUE })).wait();
  const expectedFee = (REVENUE * BigInt(feeBps)) / 10000n;
  assert(
    ethers.formatEther(await campaign.pendingFee(feeRecipient.address)) === ethers.formatEther(expectedFee),
    "计提的服务费与预期不一致",
  );
  assert(
    ethers.formatEther(await campaign.revenuePool()) === ethers.formatEther(REVENUE - expectedFee),
    "revenuePool 净额不对",
  );
  ok("收益入账并计提", `服务费 ${ethers.formatEther(expectedFee)} BNB，净额进 revenuePool`);

  const feesPaidBefore = await campaign.totalFeesPaid();
  await (await campaign.connect(feeRecipient).claimFee()).wait();
  const feesPaidAfter = await campaign.totalFeesPaid();
  assert(feesPaidAfter > feesPaidBefore, "totalFeesPaid 应累计（服务费已发放）");
  assert(Number(await campaign.pendingFee(feeRecipient.address)) === 0, "领取后 pendingFee 应清零");
  ok("服务费已领取", `本次领取 ${ethers.formatEther(feesPaidAfter - feesPaidBefore)} BNB`);

  section("结果");
  console.log(`  工厂      ${factoryAddr}`);
  console.log(`  期次      ${campaignAddr}`);
  console.log(`  场景/子态 Mining / Ready，电路由期次持有 ${await campaign.circuitHeldCount()} 张`);
  console.log(`  售出      ${await campaign.sold()} 份，托管 ${ethers.formatEther(await campaign.raisedBnb())} BNB`);
  console.log(`  挖矿      1 张挖矿中 / 1 张冷却，累计产出 ${ethers.formatEther(await campaign.totalBemRewards())} BEM`);
  console.log(`  份额      Alice ${await campaign.sharesOf(alice.address)} / Bob ${await campaign.sharesOf(bob.address)}`);
  console.log(`  收益池    ${ethers.formatEther(await campaign.revenuePool())} BNB`);
  console.log(`\n✓ 测试网完整生命周期演练通过（${step} 项检查）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
