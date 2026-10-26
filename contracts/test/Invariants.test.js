const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Book identity: balance == raisedBnb + (surplusPool - surplusPaid).
// BEM service fees sit in the BEM token balance (pendingFee), not in the BNB ledger.
// Circuit collateral: while this round holds a circuit, either shares are outstanding or every share
// was repaid at the subscription price.
// Share conservation: sum(sharesOf + escrowOf) == outstandingShares.

const SHARE_PRICE = ethers.parseEther("0.01");
const TOTAL_SHARES = 100n;
const FUNDING_SECONDS = 7 * 24 * 60 * 60;
const UNIT = ethers.parseEther("0.005");
const SHORT_PRICE = ethers.parseEther("0.6");
const FEE_BPS = 100;

const SCENE = { Funding: 0n, Executing: 1n, Mining: 2n };
const PHASE = { None: 0n, Buying: 1n, Ready: 2n };

let tokenSeq = 50_000;

async function listOne(ctx, price, seller = ctx.seller) {
  const { nft, market } = ctx;
  const tokenId = BigInt(tokenSeq++);
  const nftAddr = await nft.getAddress();
  const marketAddr = await market.getAddress();
  await nft.mint(seller.address, tokenId);
  await nft.connect(seller).approve(marketAddr, tokenId);
  const listingId = await market.connect(seller).list.staticCall(nftAddr, tokenId, price);
  await market.connect(seller).list(nftAddr, tokenId, price);
  return { listingId, tokenId };
}

async function buy(ctx, price = UNIT, count = 1) {
  const ids = [];
  const tokens = [];
  const prices = [];
  for (let i = 0; i < count; i++) {
    const l = await listOne(ctx, price);
    ids.push(l.listingId);
    tokens.push(l.tokenId);
    prices.push(price);
  }
  await ctx.campaign.connect(ctx.owner).buyCircuits(ids, tokens, prices);
  return tokens;
}

async function deployFixture() {
  const [owner, alice, bob, carol, feeRecipient, pool, seller] = await ethers.getSigners();
  const market = await ethers.deployContract("MockCircuitMarket", [FEE_BPS]);
  const nft = await ethers.deployContract("MockCircuitNft");
  const bem = await ethers.deployContract("MockBem");
  const pod = await ethers.deployContract("MockPodMining", [await bem.getAddress()]);
  const deployer = await ethers.deployContract("CampaignDeployer");
  const factory = await ethers.deployContract("CampaignFactory", [
    await market.getAddress(),
    [await nft.getAddress()],
    await pod.getAddress(),
    await bem.getAddress(),
    await deployer.getAddress(),
  ]);
  await pod.setProcessor(await nft.getAddress(), 1);
  await factory
    .connect(owner)
    .createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await nft.getAddress());
  const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(0));
  await campaign.connect(owner).setServiceFee(0, [], []);
  return { market, nft, bem, pod, deployer, factory, campaign, owner, alice, bob, carol, feeRecipient, pool, seller };
}

/// Campaign with fee still unset (lifecycle tests that set a non-zero table first).
async function unsetFeeFixture() {
  const [owner, alice, bob, carol, feeRecipient, pool, seller] = await ethers.getSigners();
  const market = await ethers.deployContract("MockCircuitMarket", [FEE_BPS]);
  const nft = await ethers.deployContract("MockCircuitNft");
  const bem = await ethers.deployContract("MockBem");
  const pod = await ethers.deployContract("MockPodMining", [await bem.getAddress()]);
  const deployer = await ethers.deployContract("CampaignDeployer");
  const factory = await ethers.deployContract("CampaignFactory", [
    await market.getAddress(),
    [await nft.getAddress()],
    await pod.getAddress(),
    await bem.getAddress(),
    await deployer.getAddress(),
  ]);
  await pod.setProcessor(await nft.getAddress(), 1);
  await factory
    .connect(owner)
    .createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await nft.getAddress());
  const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(0));
  return { market, nft, bem, pod, deployer, factory, campaign, owner, alice, bob, carol, feeRecipient, pool, seller };
}

async function miningFixture() {
  const ctx = await loadFixture(deployFixture);
  const { campaign, owner, alice, bob } = ctx;
  await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
  await campaign.connect(owner).setPlan(408n);
  const tokens = await buy(ctx, UNIT);
  await campaign.confirmCircuits();
  await campaign.connect(owner).startMining(tokens[0]);
  return { ...ctx, tokenId: tokens[0] };
}

async function ledger(campaign) {
  const [balance, raised, pool, paid] = await Promise.all([
    ethers.provider.getBalance(await campaign.getAddress()),
    campaign.raisedBnb(),
    campaign.surplusPool(),
    campaign.surplusPaid(),
  ]);
  return { balance, raised, pool, paid };
}

async function expectLedgerClosed(campaign) {
  const l = await ledger(campaign);
  const surplus = l.pool > l.paid ? l.pool - l.paid : 0n;
  expect(l.balance).to.equal(l.raised + surplus);
  return l;
}

async function expectNoDustLeft(campaign) {
  const l = await expectLedgerClosed(campaign);
  expect(l.raised).to.equal(0n);
  expect(l.paid).to.equal(l.pool);
  expect(await campaign.totalPendingFee()).to.equal(0n);
  expect(l.balance).to.equal(0n);
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

async function expectCollateralInvariant(campaign) {
  const held = await campaign.circuitHeldCount();
  if (held === 0n) return;
  const [outstanding, sold, price, refunded] = await Promise.all([
    campaign.outstandingShares(),
    campaign.sold(),
    campaign.sharePriceBnb(),
    campaign.totalRefunded(),
  ]);
  expect(outstanding > 0n || refunded >= sold * price).to.equal(true);
}

describe("ledger identity", () => {
  it("holds at every stage of a full lifecycle and ends with nothing unowned", async () => {
    const ctx = await loadFixture(unsetFeeFixture);
    const { campaign, owner, alice, bob, feeRecipient, pod, nft, bem } = ctx;
    await campaign.connect(owner).setServiceFee(500, [feeRecipient.address], [10000]);

    await expectLedgerClosed(campaign);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await expectLedgerClosed(campaign);

    await campaign.connect(owner).setPlan(408n);
    const tokens = await buy(ctx, UNIT);
    await expectLedgerClosed(campaign);

    await campaign.confirmCircuits();
    await expectLedgerClosed(campaign);
    await campaign.connect(owner).startMining(tokens[0]);
    await expectLedgerClosed(campaign);
    expect(await campaign.circuitHeldCount()).to.equal(1n);

    // Leftover raisedBnb was booked as surplus on startMining.
    await campaign.connect(alice).claimSurplus();
    await expectLedgerClosed(campaign);
    await campaign.connect(bob).claimSurplus();
    await expectNoDustLeft(campaign);

    // BEM harvest: fee to recipient, net to holders — BNB ledger unchanged.
    const gross = ethers.parseEther("100");
    await pod.accrue(await pod.minerKey(await nft.getAddress(), tokens[0]), gross);
    await campaign.connect(owner).claimMiningRewards();
    await expectLedgerClosed(campaign);
    const fee = (gross * 500n) / 10000n;
    expect(await campaign.pendingFee(feeRecipient.address)).to.equal(fee);
    await campaign.connect(feeRecipient).claimFee();
    expect(await bem.balanceOf(feeRecipient.address)).to.equal(fee);
    await campaign.connect(alice).claimBem();
    await campaign.connect(bob).claimBem();
    expect(await campaign.totalPendingFee()).to.equal(0n);
  });

  it("pays the surplus pool out to the last wei in either claim order", async () => {
    for (const order of [["alice", "bob"], ["bob", "alice"]]) {
      const ctx = await loadFixture(miningFixture);
      const { campaign } = ctx;
      // Surplus already booked from leftover raisedBnb at startMining.
      const total = await campaign.surplusPool();
      expect(total).to.be.greaterThan(0n);
      for (const who of order) {
        await campaign.connect(ctx[who]).claimSurplus();
      }
      expect(await campaign.surplusPaid()).to.equal(total);
      expect(await campaign.surplusOf(ctx.alice.address)).to.equal(0n);
      expect(await campaign.surplusOf(ctx.bob.address)).to.equal(0n);
      await expectNoDustLeft(campaign);
    }
  });

  it("keeps later BEM harvest claimable after an earlier round was fully claimed", async () => {
    const { campaign, alice, bob, owner, pod, nft, tokenId } = await loadFixture(miningFixture);
    await campaign.connect(alice).claimSurplus();
    await campaign.connect(bob).claimSurplus();
    expect(await campaign.surplusPaid()).to.equal(await campaign.surplusPool());

    const key = await pod.minerKey(await nft.getAddress(), tokenId);
    await pod.accrue(key, ethers.parseEther("70"));
    await campaign.connect(owner).claimMiningRewards();
    expect(await campaign.bemPendingOf(alice.address)).to.be.greaterThan(0n);
    expect(await campaign.bemPendingOf(bob.address)).to.be.greaterThan(0n);
    await campaign.connect(alice).claimBem();
    await campaign.connect(bob).claimBem();

    await pod.accrue(key, ethers.parseEther("110"));
    await campaign.connect(owner).claimMiningRewards();
    expect(await campaign.bemPendingOf(alice.address)).to.be.greaterThan(0n);
    expect(await campaign.bemPendingOf(bob.address)).to.be.greaterThan(0n);
    await campaign.connect(alice).claimBem();
    await campaign.connect(bob).claimBem();
    await expectNoDustLeft(campaign);
  });

  it("holds when a holder rejects the payout: the accrual stays retryable and reserved", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    const rejector = await ethers.deployContract("Rejector");
    await rejector.subscribe(await campaign.getAddress(), 10n, { value: 10n * SHARE_PRICE });
    await campaign.connect(alice).subscribe(90n, { value: 90n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    const tokens = await buy(ctx, UNIT);
    await campaign.confirmCircuits();
    await campaign.connect(owner).startMining(tokens[0]);
    await expectLedgerClosed(campaign);

    const before = await campaign.surplusOf(await rejector.getAddress());
    expect(before).to.be.greaterThan(0n);
    await expect(rejector.claimSurplusFrom(await campaign.getAddress())).to.be.revertedWithCustomError(
      campaign,
      "TransferFailed",
    );
    expect(await campaign.surplusOf(await rejector.getAddress())).to.equal(before);
    await expectLedgerClosed(campaign);
    await expect(campaign.connect(owner).recoverBnb()).to.be.revertedWithCustomError(
      campaign,
      "ZeroShares",
    );

    await rejector.accept();
    await rejector.claimSurplusFrom(await campaign.getAddress());
    expect(await campaign.surplusOf(await rejector.getAddress())).to.equal(0n);
    await campaign.connect(alice).claimSurplus();
    await expectNoDustLeft(campaign);
  });
});

describe("shares and circuit conservation", () => {
  it("keeps shares + escrow equal to outstandingShares across listing, taking and cancelling", async () => {
    const { campaign, alice, bob } = await loadFixture(miningFixture);
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

  it("zeroes every share on the funding-timeout exit", async () => {
    const { campaign, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(30n, { value: 30n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(20n, { value: 20n * SHARE_PRICE });
    await time.increaseTo((await campaign.fundingDeadline()) + 1n);
    await campaign.connect(alice).refund();
    await campaign.connect(bob).refund();
    expect(await campaign.scene()).to.equal(SCENE.Funding);
    expect(await campaign.outstandingShares()).to.equal(0n);
    await expectSharesConserved(campaign);
    await expectNoDustLeft(campaign);
  });

  it("closes the books when no listing is affordable and everyone pulls out", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, bob, owner } = ctx;
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await buy(ctx, ethers.parseEther("1.5"));
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await campaign.circuitCount()).to.equal(0n);
    await campaign.connect(alice).refund();
    await campaign.connect(bob).refund();
    expect(await campaign.outstandingShares()).to.equal(0n);
    await expectNoDustLeft(campaign);
  });

  it("releases the circuit only after every share is settled and repaid in full", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice, bob, nft } = ctx;
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    const [tokenId] = await buy(ctx, SHORT_PRICE);
    await expectCollateralInvariant(campaign);
    await expectSharesConserved(campaign);

    // A short pool with a circuit in hand closes all three refund exits.
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    await expect(campaign.connect(owner).openRefund()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    await expect(campaign.connect(owner).abandonOrder()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    await expectLedgerClosed(campaign);

    // Top up the 0.6 BNB the circuit consumed, then holders can take the full principal.
    await campaign.connect(owner).topUpShortfall({ value: SHORT_PRICE });
    await campaign.connect(owner).openRefund();
    await expectCollateralInvariant(campaign);
    await campaign.connect(alice).refund();
    await campaign.connect(bob).refund();
    expect(await campaign.outstandingShares()).to.equal(0n);
    expect(await campaign.totalRefunded()).to.equal(TOTAL_SHARES * SHARE_PRICE);
    await expectCollateralInvariant(campaign);
    await expectLedgerClosed(campaign);
    // Circuits stay with the round after full refund (recoverCircuits removed for size); list to exit.
    expect(await nft.ownerOf(tokenId)).to.equal(await campaign.getAddress());
    await expectNoDustLeft(campaign);
  });

  it("never zeroes shares while the pool is short and a circuit is held", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice, nft, pool } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    const [tokenId] = await buy(ctx, SHORT_PRICE);
    await campaign.confirmCircuits();
    await campaign.connect(owner).setPhase(PHASE.Buying);
    expect(await campaign.raisedBnb()).to.be.lessThan(100n * SHARE_PRICE);

    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    await expect(campaign.connect(owner).openRefund()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    await expect(campaign.connect(owner).abandonOrder()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    // Mining is still open: the shares keep their claim on the circuit's output.
    await campaign.connect(owner).setPhase(PHASE.Ready);
    await campaign.connect(owner).startMining(tokenId);
    expect(await campaign.outstandingShares()).to.equal(100n);
    expect(await nft.ownerOf(tokenId)).to.equal(await campaign.getAddress());
    await expectCollateralInvariant(campaign);
  });
});

describe("randomized lifecycles", () => {
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

  for (const seed of [7, 42, 2024]) {
    it(`seed ${seed}: ledger, shares and collateral stay conserved`, async () => {
      const rand = rng(seed);
      const ctx = await loadFixture(deployFixture);
      const { campaign, owner, alice, bob, carol, nft } = ctx;
      const signers = [alice, bob, carol];
      const count = 2 + Math.floor(rand() * 2);
      const cuts = split(TOTAL_SHARES, count, rand);

      for (let i = 0; i < count; i++) {
        await campaign.connect(signers[i]).subscribe(cuts[i], { value: cuts[i] * SHARE_PRICE });
        await expectLedgerClosed(campaign);
      }
      await expectSharesConserved(campaign);

      const path = Math.floor(rand() * 3);
      if (path === 0) {
        await time.increaseTo((await campaign.fundingDeadline()) + 1n);
        for (let i = 0; i < count; i++) await campaign.connect(signers[i]).refund();
        expect(await campaign.outstandingShares()).to.equal(0n);
        await expectNoDustLeft(campaign);
        return;
      }

      await campaign.connect(owner).setPlan(408n);

      if (path === 1) {
        await buy(ctx, ethers.parseEther("1.5"));
        expect(await campaign.executionFailed()).to.equal(true);
        for (let i = 0; i < count; i++) {
          if ((await campaign.sharesOf(signers[i].address)) > 0n) {
            await campaign.connect(signers[i]).refund();
          }
        }
        expect(await campaign.outstandingShares()).to.equal(0n);
        await expectNoDustLeft(campaign);
        return;
      }

      const [tokenId] = await buy(ctx, UNIT);
      await campaign.confirmCircuits();
      await expectCollateralInvariant(campaign);
      if (rand() < 0.5) {
        await campaign.connect(owner).returnSurplus();
        await expectLedgerClosed(campaign);
      }
      await campaign.connect(owner).startMining(tokenId);
      await expectLedgerClosed(campaign);

      // Harvest a few BEM rounds (fee stays in BEM balance; BNB ledger unchanged).
      const key = await ctx.pod.minerKey(await ctx.nft.getAddress(), tokenId);
      const rounds = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < rounds; i++) {
        const amount = BigInt(Math.floor(rand() * 1e15)) + 7n;
        await ctx.pod.accrue(key, amount);
        await campaign.connect(owner).claimMiningRewards();
        await expectLedgerClosed(campaign);
      }

      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < count; i++) {
          const who = signers[(i + pass) % count];
          if ((await campaign.surplusOf(who.address)) > 0n) {
            await campaign.connect(who).claimSurplus();
            await expectLedgerClosed(campaign);
          }
          if ((await campaign.bemPendingOf(who.address)) > 0n) {
            await campaign.connect(who).claimBem();
          }
        }
      }

      for (let i = 0; i < count; i++) {
        expect(await campaign.surplusOf(signers[i].address)).to.equal(0n);
      }
      await expectSharesConserved(campaign);
      expect(await nft.ownerOf(tokenId)).to.equal(await campaign.getAddress());
      await expectNoDustLeft(campaign);
    });
  }
});

describe("circuit breaker keeps the books closed", () => {
  it("a halted funding round still returns every wei after the deadline", async () => {
    const { campaign, owner, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(30n, { value: 30n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(20n, { value: 20n * SHARE_PRICE });
    await campaign.connect(owner).halt();
    await expectLedgerClosed(campaign);

    await time.increaseTo((await campaign.fundingDeadline()) + 1n);
    await campaign.connect(alice).refund();
    await campaign.connect(bob).refund();
    expect(await campaign.halted()).to.equal(true);
    expect(await campaign.outstandingShares()).to.equal(0n);
    await expectNoDustLeft(campaign);
  });

  it("a halted Ready round can still return surplus and pay it out", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice, bob, nft } = ctx;
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    const [tokenId] = await buy(ctx, UNIT);
    await campaign.confirmCircuits();
    await campaign.connect(owner).halt();

    await campaign.connect(owner).returnSurplus();
    await expectLedgerClosed(campaign);
    await expectCollateralInvariant(campaign);
    expect(await nft.ownerOf(tokenId)).to.equal(await campaign.getAddress());

    await campaign.connect(alice).claimSurplus();
    await campaign.connect(bob).claimSurplus();
    await expectLedgerClosed(campaign);
    await expectCollateralInvariant(campaign);
    expect(await campaign.circuitHeldCount()).to.equal(1n);
  });
});
