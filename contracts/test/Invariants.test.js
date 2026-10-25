const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// 账本恒等式与状态不变的回归集：只断言「钱和份额守恒」，不重复 Campaign.test.js 的业务细节。
// 恒等式：balance == raisedBnb + (surplusPool − surplusPaid) + totalPendingFee
//        ⇒ 合约余额里的每一 wei 都有归属（托管池 / 待领余款 / 待领服务费），没有第三种口袋。

const SHARE_PRICE = ethers.parseEther("0.01");
const TOTAL_SHARES = 100n;
const FUNDING_SECONDS = 7 * 24 * 60 * 60;
const UNIT = ethers.parseEther("0.005");

const SCENE = { Funding: 0n, Executing: 1n, Mining: 2n };
const PHASE = { None: 0n, Buying: 1n, Listed: 2n, Ready: 3n };

function place(campaign, signer, qty, price) {
  return campaign.connect(signer).placeTransistorOrder(qty, price, 0, 0);
}

async function fillAndConfirm(campaign, market) {
  const qty = await campaign.nandQty();
  const latch = await campaign.latchQty();
  const parts = await ethers.getContractAt("MockERC1155", await campaign.transistors());
  if (qty > 0n) {
    await market.fillBid(await campaign.nandBidId(), qty);
    await parts.mint(await campaign.getAddress(), 0, qty);
  }
  if (latch > 0n) {
    await market.fillBid(await campaign.latchBidId(), latch);
    await parts.mint(await campaign.getAddress(), 1, latch);
  }
  await campaign.confirmTransistors();
}

async function deployFixture() {
  const [owner, alice, bob, carol, feeRecipient, pool] = await ethers.getSigners();
  const minter = await ethers.deployContract("MockMaterialMarket");
  const parts = await ethers.deployContract("MockERC1155");
  const factory = await ethers.deployContract("CampaignFactory", [
    await minter.getAddress(),
    [await parts.getAddress()],
  ]);
  await factory.connect(owner).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await parts.getAddress());
  const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(0));
  return { minter, parts, factory, campaign, owner, alice, bob, carol, feeRecipient, pool };
}

// 走到 Mining，且把矿池设成 EOA，便于用 depositRevenue 灌多轮收益。
async function pooledFixture() {
  const ctx = await loadFixture(deployFixture);
  const { campaign, alice, bob, owner, minter, pool } = ctx;
  await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
  await campaign.connect(owner).setPlan(408n);
  await place(campaign, owner, 100n, UNIT);
  await fillAndConfirm(campaign, minter);
  await campaign.connect(owner).setMiningPool(pool.address);
  await campaign.connect(owner).depositToPool();
  return ctx;
}

async function ledger(campaign) {
  const address = await campaign.getAddress();
  const [balance, raised, pool, paid, fee] = await Promise.all([
    ethers.provider.getBalance(address),
    campaign.raisedBnb(),
    campaign.surplusPool(),
    campaign.surplusPaid(),
    campaign.totalPendingFee(),
  ]);
  return { balance, raised, pool, paid, fee };
}

async function expectLedgerClosed(campaign) {
  const l = await ledger(campaign);
  const surplus = l.pool > l.paid ? l.pool - l.paid : 0n;
  expect(l.balance).to.equal(l.raised + surplus + l.fee);
  return l;
}

async function expectNoDustLeft(campaign) {
  const l = await expectLedgerClosed(campaign);
  expect(l.raised).to.equal(0n);
  expect(l.paid).to.equal(l.pool);
  expect(l.fee).to.equal(0n);
  expect(l.balance).to.equal(0n);
  // 一分钱都不剩 ⇒ owner 也扫不出东西。
  await expect(campaign.recoverBnb()).to.be.revertedWithCustomError(campaign, "ZeroShares");
}

async function expectSharesConserved(campaign) {
  const n = await campaign.holderCount();
  let sum = 0n;
  for (let i = 0; i < Number(n); i++) {
    const who = await campaign.holderAt(i);
    sum += (await campaign.sharesOf(who)) + (await campaign.escrowOf(who));
  }
  expect(sum).to.equal(await campaign.outstandingShares());
}

describe("ledger identity", () => {
  it("holds at every stage of a full lifecycle and ends with nothing unowned", async () => {
    const { campaign, owner, alice, bob, minter, pool } = await loadFixture(deployFixture);

    await expectLedgerClosed(campaign);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await expectLedgerClosed(campaign);

    // 托管款打到市场：余额与 raisedBnb 同步下降。
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await expectLedgerClosed(campaign);

    await fillAndConfirm(campaign, minter);
    await expectLedgerClosed(campaign);

    await campaign.connect(owner).setMiningPool(pool.address);
    await campaign.connect(owner).depositToPool();
    await expectLedgerClosed(campaign);

    await campaign.connect(pool).depositRevenue({ value: ethers.parseEther("0.05") });
    await expectLedgerClosed(campaign);

    await campaign.connect(alice).claimSurplus();
    await expectLedgerClosed(campaign);

    // 零头也要有归属：7 wei 不能飘在账外。
    await campaign.connect(pool).depositRevenue({ value: 7n });
    await expectLedgerClosed(campaign);

    await campaign.connect(bob).claimSurplus();
    await expectNoDustLeft(campaign);
  });

  it("pays the surplus pool out to the last wei in either claim order", async () => {
    for (const order of [["alice", "bob"], ["bob", "alice"]]) {
      const ctx = await loadFixture(pooledFixture);
      const { campaign, pool } = ctx;
      // 0.5 BNB 入池余款 + 7 wei：60/40 一定除不尽，必须由最后一位领款人收掉尾差。
      await campaign.connect(pool).depositRevenue({ value: 7n });
      const poolTotal = await campaign.surplusPool();
      for (const who of order) {
        await campaign.connect(ctx[who]).claimSurplus();
      }
      expect(await campaign.surplusPaid()).to.equal(poolTotal);
      expect(await campaign.surplusOf(ctx.alice.address)).to.equal(0n);
      expect(await campaign.surplusOf(ctx.bob.address)).to.equal(0n);
      await expectNoDustLeft(campaign);
    }
  });

  it("keeps every later revenue deposit claimable after an earlier round was fully claimed", async () => {
    // S-7 回归：轮内数满后必须另开一轮，否则第二笔收益谁都领不到。
    const { campaign, alice, bob, pool } = await loadFixture(pooledFixture);

    await campaign.connect(alice).claimSurplus();
    await campaign.connect(pool).depositRevenue({ value: ethers.parseEther("0.07") });
    await campaign.connect(bob).claimSurplus();
    expect(await campaign.surplusPaid()).to.equal(await campaign.surplusPool());

    // 第二轮：两个人都应该重新有可领额。
    await campaign.connect(pool).depositRevenue({ value: ethers.parseEther("0.11") });
    expect(await campaign.surplusOf(alice.address)).to.be.greaterThan(0n);
    expect(await campaign.surplusOf(bob.address)).to.be.greaterThan(0n);
    await campaign.connect(alice).claimSurplus();
    await campaign.connect(bob).claimSurplus();
    await expectNoDustLeft(campaign);
  });

  it("holds when a holder rejects the payout: the accrual is retryable and stays reserved", async () => {
    const { campaign, owner, minter, pool } = await loadFixture(deployFixture);
    const rejector = await ethers.deployContract("Rejector");
    const rAddr = await rejector.getAddress();
    await campaign.connect(owner).setPlan(408n);
    // 90 + 10 份，拒收合约也是持份人。
    await rejector.subscribe(await campaign.getAddress(), 10n, { value: 10n * SHARE_PRICE });
    const [, , , , , , , , holder] = await ethers.getSigners();
    await campaign.connect(holder).subscribe(90n, { value: 90n * SHARE_PRICE });
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    await campaign.connect(owner).setMiningPool(pool.address);
    await campaign.connect(owner).depositToPool();
    await expectLedgerClosed(campaign);

    const before = await campaign.surplusOf(rAddr);
    expect(before).to.be.greaterThan(0n);
    // 拒收 ⇒ 整笔回滚，账不留痕，钱仍在合约里为它留着。
    await expect(rejector.claimSurplusFrom(await campaign.getAddress()))
      .to.be.revertedWithCustomError(campaign, "TransferFailed");
    expect(await campaign.surplusOf(rAddr)).to.equal(before);
    await expectLedgerClosed(campaign);
    await expect(campaign.connect(owner).recoverBnb()).to.be.revertedWithCustomError(campaign, "ZeroShares");

    // 换成能收钱的地址后照样能领。
    await rejector.accept();
    await rejector.claimSurplusFrom(await campaign.getAddress());
    expect(await campaign.surplusOf(rAddr)).to.equal(0n);
    await expectLedgerClosed(campaign);
  });
});

describe("shares and parts conservation", () => {
  it("keeps shares + escrow equal to outstandingShares across listing, taking and cancelling", async () => {
    const { campaign, alice, bob } = await loadFixture(pooledFixture);
    await expectSharesConserved(campaign);

    await campaign.connect(alice).listShares(20n, ethers.parseEther("0.02"));
    await expectSharesConserved(campaign);
    expect(await campaign.sharesOf(alice.address)).to.equal(40n);
    expect(await campaign.escrowOf(alice.address)).to.equal(20n);

    await campaign.connect(bob).takeListing(0n, 5n, { value: 5n * ethers.parseEther("0.02") });
    await expectSharesConserved(campaign);
    expect(await campaign.sharesOf(bob.address)).to.equal(45n);

    await campaign.connect(alice).cancelListing(0n);
    await expectSharesConserved(campaign);
    expect(await campaign.escrowOf(alice.address)).to.equal(0n);
    expect(await campaign.sharesOf(alice.address)).to.equal(55n);
  });

  it("zeroes every share on the refund exits, so outstandingShares never strands", async () => {
    const { campaign, owner, alice, bob, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await expectSharesConserved(campaign);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await campaign.connect(alice).cancelTransistorOrder();
    await expectSharesConserved(campaign);

    await campaign.connect(owner).abandonOrder();
    expect(await campaign.outstandingShares()).to.equal(0n);
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.sharesOf(bob.address)).to.equal(0n);
    await expectLedgerClosed(campaign);
  });
});

describe("no wei left behind", () => {
  it("closes the books on the never-sold-out exit", async () => {
    const { campaign, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(30n, { value: 30n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(20n, { value: 20n * SHARE_PRICE });
    await time.increaseTo((await campaign.fundingDeadline()) + 1n);
    await campaign.connect(alice).refund();
    await campaign.connect(bob).refund();
    expect(await campaign.scene()).to.equal(SCENE.Funding);
    await expectNoDustLeft(campaign);
  });

  it("closes the books when the order is unaffordable and everyone pulls out", async () => {
    const { campaign, owner, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    // 出价 × 数量超过募集池 ⇒ 先由 owner 判失败（不 revert、不挂单）。
    await campaign.connect(owner).markFailed();
    expect(await campaign.executionFailed()).to.equal(true);
    await campaign.connect(alice).refund();
    await campaign.connect(bob).refund();
    expect(await campaign.outstandingShares()).to.equal(0n);
    await expectNoDustLeft(campaign);
  });

  it("closes the books on abandonOrder and releases the parts afterwards", async () => {
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 40n);
    await parts.mint(await campaign.getAddress(), 0, 40n);
    await campaign.connect(owner).abandonOrder();
    expect(await campaign.outstandingShares()).to.equal(0n);
    // 份额全部结清后，剩余元件在同一个调用里就交给 owner 了。
    expect(await parts.balanceOf(owner.address, 0)).to.equal(40n);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(0n);
    await expectNoDustLeft(campaign);
  });
});

describe("randomized lifecycles", () => {
  // 固定种子的伪随机：测试可复现，但覆盖不同的份额拆分、金额零头、退出路径和领取顺序。
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function split(total, parts, rand) {
    const cuts = [];
    let left = total;
    for (let i = 0; i < parts - 1; i++) {
      const max = left - BigInt(parts - 1 - i);
      const take = 1n + BigInt(Math.floor(rand() * Number(max)));
      cuts.push(take);
      left -= take;
    }
    cuts.push(left);
    return cuts;
  }

  for (const seed of [1, 7, 42, 99, 2024, 31337]) {
    it(`seed ${seed}: ledger and shares stay conserved on a random exit path`, async () => {
      const rand = rng(seed);
      const { campaign, owner, alice, bob, carol, parts, minter, pool } = await loadFixture(deployFixture);
      const signers = [alice, bob, carol];
      const count = 2 + Math.floor(rand() * 2); // 2~3 个持份人
      const cuts = split(TOTAL_SHARES, count, rand);

      // 1) 认筹：金额与份额必须一一对上。
      for (let i = 0; i < count; i++) {
        await campaign.connect(signers[i]).subscribe(cuts[i], { value: cuts[i] * SHARE_PRICE });
        await expectLedgerClosed(campaign);
      }
      await expectSharesConserved(campaign);

      const path = Math.floor(rand() * 3);
      if (path === 0) {
        // 路径 A：未售罄 + 过截止 ⇒ 逐人 pull 本金。
        await time.increaseTo((await campaign.fundingDeadline()) + 1n);
        for (let i = 0; i < count; i++) {
          await campaign.connect(signers[i]).refund();
        }
        expect(await campaign.outstandingShares()).to.equal(0n);
        await expectNoDustLeft(campaign);
        return;
      }

      await campaign.connect(owner).setPlan(408n);

      if (path === 1) {
        // 路径 B：保守出价（买不起）⇒ 判失败后逐人退款，不挂单、不产生死钱。
        await campaign.connect(owner).placeTransistorOrder(BigInt(count * 10), ethers.parseEther("1"), 0, 0);
        expect(await campaign.executionFailed()).to.equal(true);
        // 之前可能已经退款过一部分，这里把剩下的都退掉。
        for (let i = 0; i < count; i++) {
          if ((await campaign.sharesOf(signers[i].address)) > 0n) {
            await campaign.connect(signers[i]).refund();
          }
        }
        expect(await campaign.outstandingShares()).to.equal(0n);
        await expectNoDustLeft(campaign);
        return;
      }

      // 路径 C/D：真实买入 1/4 的份额数量，成交后确认到账。
      const buyQty = TOTAL_SHARES / 4n;
      await place(campaign, owner, buyQty, UNIT);
      await fillAndConfirm(campaign, minter);
      expect(await campaign.phase()).to.equal(PHASE.Ready);

      // 路径 D：先提前退余款，再入池（路径 C 直接入池）。
      if (rand() < 0.5) {
        await campaign.connect(owner).returnSurplus();
        await expectLedgerClosed(campaign);
      }
      await campaign.connect(owner).setMiningPool(pool.address);
      await campaign.connect(owner).depositToPool();
      await expectLedgerClosed(campaign);

      // 随机灌几轮收益，金额带零头，制造除不尽的尾差。
      const rounds = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < rounds; i++) {
        const amount = BigInt(Math.floor(rand() * 1e15)) + 7n;
        await campaign.connect(pool).depositRevenue({ value: amount });
        await expectLedgerClosed(campaign);
      }

      // 随机顺序领取：谁有可领额谁领，允许某轮为 0（除不尽时可能落在别人头上）。
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < count; i++) {
          const who = signers[(i + pass) % count];
          if ((await campaign.surplusOf(who.address)) > 0n) {
            await campaign.connect(who).claimSurplus();
            await expectLedgerClosed(campaign);
          }
        }
      }

      // 全部可领额清零 ⇒ 余款 pool 已经一分不剩地发完，owner 也扫不动。
      for (let i = 0; i < count; i++) {
        expect(await campaign.surplusOf(signers[i].address)).to.equal(0n);
      }
      await expectSharesConserved(campaign);
      expect(await parts.balanceOf(pool.address, 0)).to.equal(buyQty);
      await expectNoDustLeft(campaign);
    });
  }
});

describe("boundary guards", () => {
  it("rejects zero / over-cap / mispriced subscriptions", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).subscribe(0n, { value: 0n }))
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
    await expect(campaign.connect(alice).subscribe(TOTAL_SHARES + 1n, { value: TOTAL_SHARES * SHARE_PRICE + SHARE_PRICE }))
      .to.be.revertedWithCustomError(campaign, "ExceedsRemaining");
    await expect(campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE - 1n }))
      .to.be.revertedWithCustomError(campaign, "WrongPayment");
    // 截止后才认购。
    await time.increaseTo((await campaign.fundingDeadline()) + 1n);
    await expect(campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE }))
      .to.be.revertedWithCustomError(campaign, "FundingEnded");
  });

  it("rejects zero / bad orders and asks", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await expect(campaign.connect(owner).placeTransistorOrder(0n, 0, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
    await expect(campaign.connect(owner).placeTransistorOrder(1n, 0, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "ZeroPrice");
    await expect(campaign.connect(owner).placeTransistorAsk(0n, 0, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    await expect(campaign.connect(owner).cancelTransistorAsk())
      .to.be.revertedWithCustomError(campaign, "NotAsked");
    await expect(campaign.connect(owner).confirmSale())
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    await expect(campaign.connect(owner).cancelTransistorOrder())
      .to.be.revertedWithCustomError(campaign, "NotListed");
  });

  it("rejects bad listing parameters and foreign sellers", async () => {
    const { campaign, owner, alice, bob } = await loadFixture(pooledFixture);
    await expect(campaign.connect(alice).listShares(0n, 1n))
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
    await expect(campaign.connect(alice).listShares(1n, 0n))
      .to.be.revertedWithCustomError(campaign, "ZeroPrice");
    await expect(campaign.connect(alice).listShares(61n, 1n))
      .to.be.revertedWithCustomError(campaign, "InsufficientShares");

    await campaign.connect(alice).listShares(10n, ethers.parseEther("0.02"));
    const id = 0n;
    await expect(campaign.connect(alice).takeListing(id, 1n, { value: ethers.parseEther("0.02") }))
      .to.be.revertedWithCustomError(campaign, "CannotTakeOwnListing");
    await expect(campaign.connect(bob).takeListing(id, 0n, { value: 0n }))
      .to.be.revertedWithCustomError(campaign, "BadCount");
    await expect(campaign.connect(bob).takeListing(id, 11n, { value: 11n * ethers.parseEther("0.02") }))
      .to.be.revertedWithCustomError(campaign, "BadCount");
    await expect(campaign.connect(bob).takeListing(id, 1n, { value: 1n }))
      .to.be.revertedWithCustomError(campaign, "WrongPayment");
    // 只有卖家或 owner 能撤。
    const [, , carol] = await ethers.getSigners();
    await expect(campaign.connect(carol).cancelListing(id))
      .to.be.revertedWithCustomError(campaign, "NotSeller");
    // owner 可以代撤。
    await campaign.connect(owner).cancelListing(id);
    await expect(campaign.connect(owner).cancelListing(id))
      .to.be.revertedWithCustomError(campaign, "NoListing");
  });

  it("rejects zero addresses in every setter", async () => {
    const { campaign, owner } = await loadFixture(deployFixture);
    await expect(campaign.connect(owner).setMaterialMarket(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(campaign, "ZeroAddress");
    await expect(campaign.connect(owner).setMiningPool(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(campaign, "ZeroAddress");
    await expect(campaign.connect(owner).setMiningPool(await campaign.getAddress()))
      .to.be.revertedWithCustomError(campaign, "ZeroAddress");
    await expect(campaign.connect(owner).recoverTransistors(ethers.ZeroAddress, 0n, 1n))
      .to.be.revertedWithCustomError(campaign, "ZeroAddress");
  });

  it("rejects every invalid fee table shape", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    const bad = [
      [10001, [alice.address], [10000]], // 超过 10% 上限
      [100, [alice.address], [9999]], // 分不成 10000
      [100, [alice.address, alice.address], [5000, 5000]], // 重复收款方
      [100, [], []], // 有费率却没有收款方
      [100, [ethers.ZeroAddress], [10000]], // 零地址
      [100, [alice.address], [10000, 0]], // 长度不一致
      [0, [alice.address], [10000]], // 0 费率却给了表
    ];
    for (const [bps, recipients, shares] of bad) {
      await expect(campaign.connect(owner).setServiceFee(bps, recipients, shares))
        .to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    }
    await expect(campaign.connect(owner).feeRecipientAt(0))
      .to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    await expect(campaign.connect(owner).feeSharesBpsAt(0))
      .to.be.revertedWithCustomError(campaign, "BadFeeConfig");
  });

  it("rejects bad phase targets and double pooling", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await expect(campaign.connect(owner).setPhase(PHASE.None))
      .to.be.revertedWithCustomError(campaign, "WrongScene");
    await expect(campaign.connect(owner).setPhase(4n))
      .to.be.revertedWithCustomError(campaign, "WrongScene");
    // 没有活单不能自称挂单中。
    await expect(campaign.connect(owner).setPhase(PHASE.Listed))
      .to.be.revertedWithCustomError(campaign, "WrongScene");
    // 没买过料不能自称已到账。
    await expect(campaign.connect(owner).setPhase(PHASE.Ready))
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
  });

  it("rejects revenue from anyone but the pool and zero-value revenue", async () => {
    const { campaign, pool, owner } = await loadFixture(pooledFixture);
    await expect(campaign.connect(owner).depositRevenue({ value: 1n }))
      .to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(pool).depositRevenue({ value: 0n }))
      .to.be.revertedWithCustomError(campaign, "ZeroPrice");
  });

  it("refuses a second pooling and blocks transistor recovery afterwards", async () => {
    const { campaign, owner, parts } = await loadFixture(pooledFixture);
    await expect(campaign.connect(owner).depositToPool())
      .to.be.revertedWithCustomError(campaign, "AlreadyPooled");
    await expect(campaign.connect(owner).recoverTransistors(await parts.getAddress(), 0, 1n))
      .to.be.revertedWithCustomError(campaign, "AlreadyPooled");
    await expect(campaign.connect(owner).returnSurplus())
      .to.be.revertedWithCustomError(campaign, "WrongScene");
  });

  it("refuses harvest / claim outside mining and refunds in mining", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).harvest())
      .to.be.revertedWithCustomError(campaign, "WrongScene");
    await expect(campaign.connect(alice).claim())
      .to.be.revertedWithCustomError(campaign, "WrongScene");
    await expect(campaign.connect(alice).claimSurplus())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
    await expect(campaign.connect(alice).refund())
      .to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
  });
});
