const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// 与前端 fixtures.js 对齐的常量
const SHARE_PRICE = ethers.parseEther("0.01"); // 每份 0.01 BNB
const TOTAL_SHARES = 100n;
const FEE_PERCENT = 5; // 5% → 500 bps
const FUNDING_DAYS = 7;
const TASK_ID = 54n;
const EXECUTE_DELAY = 3600; // 观察期 1 小时（测试用，生产 48h）
const HASHPOWER = 408n; // MockPoD 返回权重
const NETLIST = ethers.keccak256(ethers.toUtf8Bytes("netlist-v1"));
const RAW_NETLIST = ethers.toUtf8Bytes("netlist-v1"); // 原始网表（execute 时传入，合约内 keccak 后应等于 NETLIST）
const START = "0x12345678"; // 开矿数据（任意合法 bytes）

const SCENE = { Funding: 0n, Executing: 1n, Mining: 2n };
const PHASE = { None: 0n, Buying: 1n, Listed: 2n, Ready: 3n };

// Emission.dailyBem 期望值（verified 池）：408 × 7200 × 1e18 × 9900 / (10000 × 1575427)
const DAILY_BEM = (HASHPOWER * 7200n * 10n ** 18n * 9900n) / (10000n * 1575427n);

async function deployFixture() {
  const [owner, alice, bob, carol, feeRecipient] = await ethers.getSigners();

  const bem = await ethers.deployContract("MockBEM");
  const pod = await ethers.deployContract("MockPoD", [await bem.getAddress(), HASHPOWER]);
  const minter = await ethers.deployContract("MockMinter", [ethers.parseEther("0.005")]); // 0.005 BNB/颗
  const factory = await ethers.deployContract("CampaignFactory", [
    await pod.getAddress(),
    await bem.getAddress(),
    await minter.getAddress(),
  ]);

  const tx = await factory
    .connect(owner)
    .createCampaign(
      SHARE_PRICE,
      TOTAL_SHARES,
      FEE_PERCENT,
      FUNDING_DAYS,
      feeRecipient.address,
      TASK_ID,
      ethers.ZeroAddress, // pod 用工厂默认
      0, // 观察期用默认（会被下面的 EXECUTE_DELAY 覆盖不到，改用显式）
      NETLIST
    );
  await tx.wait();
  const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(0));
  return { bem, pod, minter, factory, campaign, owner, alice, bob, carol, feeRecipient };
}

// 用显式 executeDelay 建的 fixture（观察期可控）
async function deployFixtureWithDelay() {
  const [owner, alice, bob, carol, feeRecipient] = await ethers.getSigners();
  const bem = await ethers.deployContract("MockBEM");
  const pod = await ethers.deployContract("MockPoD", [await bem.getAddress(), HASHPOWER]);
  const minter = await ethers.deployContract("MockMinter", [ethers.parseEther("0.005")]);
  const factory = await ethers.deployContract("CampaignFactory", [
    await pod.getAddress(),
    await bem.getAddress(),
    await minter.getAddress(),
  ]);
  await factory
    .connect(owner)
    .createCampaign(
      SHARE_PRICE,
      TOTAL_SHARES,
      FEE_PERCENT,
      FUNDING_DAYS,
      feeRecipient.address,
      TASK_ID,
      ethers.ZeroAddress,
      EXECUTE_DELAY,
      NETLIST
    );
  const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(0));
  return { bem, pod, minter, factory, campaign, owner, alice, bob, carol, feeRecipient };
}

// 认购到售罄 → executing → 晶体管到账 → 观察期满 → mining
async function miningFixture() {
  const ctx = await loadFixture(deployFixtureWithDelay);
  const { campaign, alice, bob, owner, pod, bem, minter } = ctx;
  await campaign.connect(alice).buy(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(bob).buy(40n, { value: 40n * SHARE_PRICE });
  expect(await campaign.status()).to.equal(SCENE.Executing);

  await campaign.connect(owner).setPlan(408n, false, 100n); // estHashpower, capped, transistorCount
  await campaign.connect(owner).placeTransistorOrder(100n, ethers.parseEther("0.005")); // cost=0.5 BNB ≤ 1 BNB
  await campaign.connect(owner).confirmTransistors();
  await time.increase(EXECUTE_DELAY + 1);
  await campaign.connect(owner).execute(RAW_NETLIST, START);
  expect(await campaign.status()).to.equal(SCENE.Mining);
  // 预置 PoD 每日可领 BEM
  await bem.mint(await pod.getAddress(), DAILY_BEM * 10n);
  await pod.setDailyAmount(DAILY_BEM);
  return ctx;
}

describe("CampaignFactory", () => {
  it("仅 Factory Owner 可开期", async () => {
    const { factory, alice, feeRecipient } = await loadFixture(deployFixture);
    await expect(
      factory
        .connect(alice)
        .createCampaign(SHARE_PRICE, TOTAL_SHARES, FEE_PERCENT, FUNDING_DAYS, feeRecipient.address, TASK_ID, ethers.ZeroAddress, 0, NETLIST)
    ).to.be.revertedWithCustomError(factory, "NotOwner");
  });

  it("开期写入参数且计数递增", async () => {
    const { campaign, factory } = await loadFixture(deployFixture);
    expect(await factory.campaignCount()).to.equal(1n);
    expect(await campaign.sharePriceBnb()).to.equal(SHARE_PRICE);
    expect(await campaign.totalShares()).to.equal(TOTAL_SHARES);
    expect(await campaign.feeBps()).to.equal(500n);
    expect(await campaign.netlistHash()).to.equal(NETLIST);
    expect(await campaign.status()).to.equal(SCENE.Funding);
  });
});

describe("认购 funding", () => {
  it("buy 需精确付款、整数份、不超剩余", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).buy(10n, { value: SHARE_PRICE * 9n })).to.be.revertedWithCustomError(campaign, "WrongPayment");
    await expect(campaign.connect(alice).buy(0n, { value: 0 })).to.be.revertedWithCustomError(campaign, "ZeroShares");
    await expect(campaign.connect(alice).buy(101n, { value: SHARE_PRICE * 101n })).to.be.revertedWithCustomError(campaign, "ExceedsRemaining");
    await campaign.connect(alice).buy(10n, { value: SHARE_PRICE * 10n });
    expect(await campaign.sharesOf(alice.address)).to.equal(10n);
    expect(await campaign.sold()).to.equal(10n);
    expect(await campaign.raisedBnb()).to.equal(SHARE_PRICE * 10n);
  });

  it("自然售罄 → executing + 启动观察期", async () => {
    const { campaign, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).buy(60n, { value: SHARE_PRICE * 60n });
    await campaign.connect(bob).buy(40n, { value: SHARE_PRICE * 40n });
    expect(await campaign.status()).to.equal(SCENE.Executing);
    expect(await campaign.executePhase()).to.equal(PHASE.Buying);
    expect(await campaign.soldOutAt()).to.be.gt(0n);
    await expect(campaign.connect(alice).buy(1n, { value: SHARE_PRICE })).to.be.revertedWithCustomError(campaign, "WrongScene");
  });

  it("拒绝直接转账（保证 raisedBnb 记账精确）", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(alice.sendTransaction({ to: await campaign.getAddress(), value: 1n })).to.be.revertedWithCustomError(campaign, "DirectTransferNotAllowed");
  });
});

describe("退款（被动安全阀）", () => {
  it("募集未超时不可退；超时可原路退还、份额清零、已售回退", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).buy(30n, { value: SHARE_PRICE * 30n });
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");

    await time.increase(FUNDING_DAYS * 86400 + 1);
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const receipt = await tx.wait();
    const gas = receipt.gasUsed * receipt.gasPrice;
    const after = await ethers.provider.getBalance(alice.address);
    expect(after + gas - before).to.equal(SHARE_PRICE * 30n); // 原路退回 30 份
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.sold()).to.equal(0n);
    expect(await campaign.refundedOf(alice.address)).to.equal(SHARE_PRICE * 30n);
    expect(await campaign.totalRefunded()).to.equal(SHARE_PRICE * 30n);
  });

  it("挖矿中不可退款", async () => {
    const { campaign, alice } = await miningFixture();
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
  });
});

describe("晶体管挂单 + execute（F3 仅 Owner / 锁价 / 硬闸门）", () => {
  it("挂单三态与越权拦截", async () => {
    const { campaign, alice, owner } = await loadFixture(deployFixtureWithDelay);
    await campaign.connect(alice).buy(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);

    await expect(campaign.connect(alice).placeTransistorOrder(100n, 1n)).to.be.revertedWithCustomError(campaign, "NotOwner");
    await campaign.connect(owner).placeTransistorOrder(100n, ethers.parseEther("0.005"));
    expect(await campaign.executePhase()).to.equal(PHASE.Listed);
    await expect(campaign.connect(owner).placeTransistorOrder(100n, 1n)).to.be.revertedWithCustomError(campaign, "AlreadyListed");
    await campaign.connect(owner).cancelTransistorOrder();
    expect(await campaign.executePhase()).to.equal(PHASE.Buying);
    await campaign.connect(owner).placeTransistorOrder(100n, ethers.parseEther("0.005"));
    await campaign.connect(owner).confirmTransistors();
    expect(await campaign.executePhase()).to.equal(PHASE.Ready);
    await expect(campaign.connect(owner).confirmTransistors()).to.be.revertedWithCustomError(campaign, "AlreadyReady");
  });

  it("execute 硬闸门：未到账 / 观察期 / 非 Owner / 网表不匹配 全拒", async () => {
    const { campaign, alice, owner } = await loadFixture(deployFixtureWithDelay);
    await campaign.connect(alice).buy(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);

    // 未确认到账（ Buying ）
    await expect(campaign.connect(owner).execute(RAW_NETLIST, START)).to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    await campaign.connect(owner).placeTransistorOrder(100n, ethers.parseEther("0.005"));
    await campaign.connect(owner).confirmTransistors();

    // 观察期未满
    await expect(campaign.connect(owner).execute(RAW_NETLIST, START)).to.be.revertedWithCustomError(campaign, "ObservationPeriodActive");
    await time.increase(EXECUTE_DELAY + 1);

    // 非 Owner
    await expect(campaign.connect(alice).execute(RAW_NETLIST, START)).to.be.revertedWithCustomError(campaign, "NotOwner");
    // 网表不匹配
    await expect(campaign.connect(owner).execute(ethers.keccak256(ethers.toUtf8Bytes("evil")), START)).to.be.revertedWithCustomError(campaign, "NetlistMismatch");
  });

  it("execute 成功 → mining、清脏状态、按锁价支出", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixtureWithDelay);
    await campaign.connect(alice).buy(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await campaign.connect(owner).placeTransistorOrder(100n, ethers.parseEther("0.005"));
    await campaign.connect(owner).confirmTransistors();
    await time.increase(EXECUTE_DELAY + 1);

    const raisedBefore = await campaign.raisedBnb();
    await expect(campaign.connect(owner).execute(RAW_NETLIST, START)).to.emit(campaign, "Executed");
    expect(await campaign.status()).to.equal(SCENE.Mining);
    expect(await campaign.executePhase()).to.equal(PHASE.None);
    expect(await campaign.executionFailed()).to.equal(false);
    expect(await campaign.hashpower()).to.equal(HASHPOWER);
    expect(await campaign.raisedBnb()).to.equal(raisedBefore - 100n * ethers.parseEther("0.005"));
    expect(await minter.mintedCount()).to.equal(100n);
  });

  it("execute 买不起 → 判失败留待执行、清锁价、可原路退还", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixtureWithDelay);
    await campaign.connect(alice).buy(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    // 锁价 0.02 BNB/颗 → 成本 2 BNB > 募集 1 BNB
    await campaign.connect(owner).placeTransistorOrder(100n, ethers.parseEther("0.02"));
    await campaign.connect(owner).confirmTransistors();
    await time.increase(EXECUTE_DELAY + 1);

    await expect(campaign.connect(owner).execute(RAW_NETLIST, START)).to.emit(campaign, "ExecutionFailed");
    expect(await campaign.status()).to.equal(SCENE.Executing);
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await campaign.priceLock()).to.equal(0n); // 清锁价，允许降价重试

    // 失败后可原路退还
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const receipt = await tx.wait();
    const after = await ethers.provider.getBalance(alice.address);
    expect(after + receipt.gasUsed * receipt.gasPrice - before).to.equal(SHARE_PRICE * 100n);
  });

  it("待挂单买不起 → Owner 发起退款，持份人可原路退还", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).buy(100n, { value: SHARE_PRICE * 100n });
    expect(await campaign.status()).to.equal(SCENE.Executing);
    expect(await campaign.executePhase()).to.equal(PHASE.Buying);

    await expect(campaign.connect(alice).abortUnaffordable(100n, ethers.parseEther("0.02")))
      .to.be.revertedWithCustomError(campaign, "NotOwner");
    // 0.005 × 100 = 0.5 ≤ 募集 1 BNB
    await expect(campaign.connect(owner).abortUnaffordable(100n, ethers.parseEther("0.005")))
      .to.be.revertedWithCustomError(campaign, "CanStillAfford");
    await expect(campaign.connect(owner).abortUnaffordable(100n, ethers.parseEther("0.02")))
      .to.emit(campaign, "ExecutionFailed");
    expect(await campaign.executionFailed()).to.equal(true);
    await expect(campaign.connect(owner).placeTransistorOrder(100n, ethers.parseEther("0.005")))
      .to.be.revertedWithCustomError(campaign, "RefundNotAvailable");

    const before = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const receipt = await tx.wait();
    const after = await ethers.provider.getBalance(alice.address);
    expect(after + receipt.gasUsed * receipt.gasPrice - before).to.equal(SHARE_PRICE * 100n);
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
  });
});

describe("份额转让（唯一主动退出，仅 mining，BNB 原子结算）", () => {
  it("挂牌锁定 escrow、撤单释放、不能接收自己的单", async () => {
    const { campaign, alice } = await miningFixture();
    await expect(campaign.connect(alice).listShares(100n, SHARE_PRICE)).to.be.revertedWithCustomError(campaign, "InsufficientShares"); // alice 只有 60
    await campaign.connect(alice).listShares(20n, ethers.parseEther("0.02"));
    expect(await campaign.sharesOf(alice.address)).to.equal(40n);
    expect(await campaign.escrowOf(alice.address)).to.equal(20n);
    await expect(campaign.connect(alice).takeListing(0n, 1n, { value: ethers.parseEther("0.02") })).to.be.revertedWithCustomError(campaign, "CannotTakeOwnListing");
    await campaign.connect(alice).cancelListing(0n);
    expect(await campaign.sharesOf(alice.address)).to.equal(60n);
    expect(await campaign.escrowOf(alice.address)).to.equal(0n);
  });

  it("takeListing：份额过户 + BNB 实时付给卖方（原子）", async () => {
    const { campaign, alice, bob } = await miningFixture();
    await campaign.connect(alice).listShares(20n, ethers.parseEther("0.03"));
    const pay = 5n * ethers.parseEther("0.03");
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const bobSharesBefore = await campaign.sharesOf(bob.address);

    await expect(campaign.connect(bob).takeListing(0n, 5n, { value: pay - 1n })).to.be.revertedWithCustomError(campaign, "WrongPayment");
    await campaign.connect(bob).takeListing(0n, 5n, { value: pay });

    expect(await campaign.sharesOf(bob.address)).to.equal(bobSharesBefore + 5n);
    expect(await campaign.escrowOf(alice.address)).to.equal(15n);
    const aliceAfter = await ethers.provider.getBalance(alice.address);
    expect(aliceAfter - aliceBefore).to.equal(pay); // 卖方实时收到 BNB
    const listing = await campaign.getListing(0n);
    expect(listing.shares).to.equal(15n);
    expect(listing.open).to.equal(true);
  });

  it("募集中不可挂牌", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).buy(10n, { value: SHARE_PRICE * 10n });
    await expect(campaign.connect(alice).listShares(1n, SHARE_PRICE)).to.be.revertedWithCustomError(campaign, "WrongScene");
  });
});

describe("harvest / claim（F1 按地址隔离、无领取上限）", () => {
  it("harvest 全网分发，claim 按份额各自领取，服务费进收费地址", async () => {
    const { campaign, bem, alice, bob, feeRecipient } = await miningFixture();

    await expect(campaign.connect(alice).harvest()).to.emit(campaign, "Harvested");
    expect(await campaign.harvestCount()).to.equal(1n);

    // 与合约同口径：net = (daily × (BPS−feeBps)) / BPS 单次整除，fee = (daily × feeBps)/BPS
    const fee = (DAILY_BEM * 500n) / 10000n;
    const net = (DAILY_BEM * 9500n) / 10000n;
    const alicePending = await campaign.pendingBem(alice.address); // 60/100
    const bobPending = await campaign.pendingBem(bob.address); // 40/100
    expect(alicePending).to.equal((net * 60n) / 100n);
    expect(bobPending).to.equal((net * 40n) / 100n);
    // 隔离：两者之和 = 净分配
    expect(alicePending + bobPending).to.be.closeTo(net, 10n);

    // 收费地址收到服务费
    expect(await bem.balanceOf(feeRecipient.address)).to.equal(fee);

    // alice claim 自己的 pending
    await campaign.connect(alice).claim();
    expect(await bem.balanceOf(alice.address)).to.equal(alicePending);
    expect(await campaign.claimedOf(alice.address)).to.equal(alicePending);
    // claim 后 alice pending 清零，bob 不受影响
    expect(await campaign.pendingBem(alice.address)).to.equal(0n);
    expect(await campaign.pendingBem(bob.address)).to.equal(bobPending);
    // 重复 claim 被拒
    await expect(campaign.connect(alice).claim()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("领取次数不设上限：多轮 harvest 后 pending 持续累计", async () => {
    const { campaign, alice, pod, bem } = await miningFixture();
    for (let i = 0; i < 5; i++) {
      await bem.mint(await pod.getAddress(), DAILY_BEM);
      await pod.setDailyAmount(DAILY_BEM);
      await campaign.connect(alice).harvest();
    }
    expect(await campaign.harvestCount()).to.equal(5n);
    const net = (DAILY_BEM * 9500n) / 10000n;
    const alicePending = await campaign.pendingBem(alice.address);
    expect(alicePending).to.be.closeTo((net * 5n * 60n) / 100n, 100n);
  });

  it("日产 = Emission 口径（权重→产出）", async () => {
    const { campaign } = await miningFixture();
    expect(await campaign.dailyBem()).to.equal(DAILY_BEM);
  });
});
