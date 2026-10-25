const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const SHARE_PRICE = ethers.parseEther("0.01");
const TOTAL_SHARES = 100n;
const FUNDING_SECONDS = 7 * 24 * 60 * 60;
const UNIT = ethers.parseEther("0.005");
const SHORT_PRICE = ethers.parseEther("0.6");
const FEE_BPS = 100;

const SCENE = { Funding: 0n, Executing: 1n, Mining: 2n };
const PHASE = { None: 0n, Buying: 1n, Ready: 2n };

let tokenSeq = 10_000;

/// Mint one circuit to `seller`, approve the market and list it. Returns its ids.
async function listOne(ctx, price, seller = ctx.seller) {
  const { nft, market } = ctx;
  const tokenId = BigInt(tokenSeq++);
  const nftAddr = await nft.getAddress();
  const marketAddr = await market.getAddress();
  await nft.mint(seller.address, tokenId);
  await nft.connect(seller).approve(marketAddr, tokenId);
  const listingId = await market.connect(seller).list.staticCall(nftAddr, tokenId, price);
  await market.connect(seller).list(nftAddr, tokenId, price);
  return { listingId, tokenId, price };
}

async function listMany(ctx, count, price, seller = ctx.seller) {
  const ids = [];
  const tokens = [];
  const prices = [];
  for (let i = 0; i < count; i++) {
    const l = await listOne(ctx, price, seller);
    ids.push(l.listingId);
    tokens.push(l.tokenId);
    prices.push(l.price);
  }
  return { ids, tokens, prices };
}

/// List `count` circuits and buy them as the owner. Returns the purchased ids.
async function buy(ctx, count = 1, price = UNIT) {
  const l = await listMany(ctx, count, price);
  await ctx.campaign.connect(ctx.owner).buyCircuits(l.ids, l.tokens, l.prices);
  return l;
}

async function deployFixture() {
  const [owner, alice, bob, carol, feeRecipient, pool, seller, buyer] = await ethers.getSigners();
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
  return { market, nft, bem, pod, deployer, factory, campaign, owner, alice, bob, carol, feeRecipient, pool, seller, buyer };
}

/// Sell out, buy one circuit and enter Mining through the official mining contract.
async function pooledFixture() {
  const ctx = await loadFixture(deployFixture);
  const { campaign, owner, alice, bob } = ctx;
  await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
  await campaign.connect(owner).setPlan(408n);
  const { tokens } = await buy(ctx, 1, UNIT);
  await campaign.confirmCircuits();
  await campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []);
  return { ...ctx, tokenId: tokens[0] };
}

/// Same as pooledFixture, with the service fee frozen before the first subscription.
async function feeFixture() {
  const ctx = await loadFixture(deployFixture);
  const { campaign, owner, alice, bob, feeRecipient } = ctx;
  await campaign.connect(owner).setServiceFee(500, [feeRecipient.address], [10000]);
  await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
  await campaign.connect(owner).setPlan(408n);
  const { tokens } = await buy(ctx, 1, UNIT);
  await campaign.confirmCircuits();
  await campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []);
  return { ...ctx, tokenId: tokens[0] };
}

/// Mining round where a BNB-rejecting contract holds 40 shares.
async function rejectorPooledFixture() {
  const ctx = await loadFixture(deployFixture);
  const { campaign, owner, alice } = ctx;
  const rejector = await ethers.deployContract("Rejector");
  await rejector.subscribe(await campaign.getAddress(), 40n, { value: 40n * SHARE_PRICE });
  await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(owner).setPlan(408n);
  const { tokens } = await buy(ctx, 1, UNIT);
  await campaign.confirmCircuits();
  await campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []);
  return { ...ctx, rejector, tokenId: tokens[0] };
}

describe("CampaignFactory", () => {
  it("only the factory owner can create", async () => {
    const { factory, nft, alice } = await loadFixture(deployFixture);
    await expect(
      factory.connect(alice).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await nft.getAddress()),
    ).to.be.revertedWithCustomError(factory, "NotOwner");
  });

  it("stores campaigns and increments count", async () => {
    const { factory, nft, owner } = await loadFixture(deployFixture);
    expect(await factory.campaignCount()).to.equal(1n);
    await factory.connect(owner).createCampaign(SHARE_PRICE, 10n, 60n, await nft.getAddress());
    expect(await factory.campaignCount()).to.equal(2n);
    expect(await factory.campaigns(1)).to.not.equal(ethers.ZeroAddress);
  });

  it("rejects a zero circuit address", async () => {
    const { factory, owner } = await loadFixture(deployFixture);
    await expect(
      factory.connect(owner).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("rejects a circuit collection that is not whitelisted", async () => {
    const { factory, owner } = await loadFixture(deployFixture);
    const other = await ethers.deployContract("MockCircuitNft");
    await expect(
      factory.connect(owner).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await other.getAddress()),
    ).to.be.revertedWithCustomError(factory, "CircuitsNotAllowed");
  });

  it("adds fundingSeconds verbatim and reports the deadline", async () => {
    const { factory, nft, owner } = await loadFixture(deployFixture);
    const before = await time.latest();
    const tx = await factory.connect(owner).createCampaign(SHARE_PRICE, 10n, 1234n, await nft.getAddress());
    const rc = await tx.wait();
    const block = await ethers.provider.getBlock(rc.blockNumber);
    const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(1));
    expect(await campaign.fundingDeadline()).to.equal(BigInt(block.timestamp) + 1234n);
    expect(BigInt(block.timestamp)).to.be.greaterThanOrEqual(BigInt(before));
  });

  it("exposes the whitelist and keeps the market immutable", async () => {
    const { factory, market, nft } = await loadFixture(deployFixture);
    expect(await factory.circuitMarket()).to.equal(await market.getAddress());
    expect(await factory.allowedCircuitsCount()).to.equal(1n);
    expect(await factory.allowedCircuitsAt(0)).to.equal(await nft.getAddress());
    expect(await factory.isAllowedCircuits(await nft.getAddress())).to.equal(true);
    await expect(factory.allowedCircuitsAt(1)).to.be.revertedWithCustomError(factory, "IndexOutOfBounds");
  });

  it("removing a round only edits the registry", async () => {
    const { factory, campaign, owner } = await loadFixture(deployFixture);
    await factory.connect(owner).removeCampaign(0);
    expect(await factory.campaignCount()).to.equal(0n);
    expect(await campaign.scene()).to.equal(SCENE.Funding);
    await expect(factory.connect(owner).removeCampaign(0)).to.be.revertedWithCustomError(
      factory,
      "IndexOutOfBounds",
    );
  });
});

describe("funding subscribe", () => {
  it("requires exact payment and no oversell", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).subscribe(1n, { value: 0n })).to.be.revertedWithCustomError(
      campaign,
      "WrongPayment",
    );
    await expect(
      campaign.connect(alice).subscribe(101n, { value: 101n * SHARE_PRICE }),
    ).to.be.revertedWithCustomError(campaign, "ExceedsRemaining");
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    expect(await campaign.sharesOf(alice.address)).to.equal(1n);
  });

  it("a sell-out moves to Executing/Buying", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    expect(await campaign.scene()).to.equal(SCENE.Executing);
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.soldOutAt()).to.be.greaterThan(0n);
  });

  it("rejects a direct BNB transfer", async () => {
    const { campaign, owner } = await loadFixture(deployFixture);
    await expect(
      owner.sendTransaction({ to: await campaign.getAddress(), value: 1n }),
    ).to.be.revertedWithCustomError(campaign, "DirectTransferNotAllowed");
  });
});

describe("circuit purchases", () => {
  it("buys a listed circuit at the exact price and confirms Ready", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, nft } = ctx;
    await campaign.connect(owner).subscribe(100n, { value: 100n * SHARE_PRICE });
    const l = await buy(ctx, 1, UNIT);

    expect(await campaign.circuitCount()).to.equal(1n);
    expect(await campaign.circuitIds(0)).to.equal(l.tokens[0]);
    expect(await nft.ownerOf(l.tokens[0])).to.equal(await campaign.getAddress());
    expect(await campaign.circuitCostBasis(l.tokens[0])).to.equal(UNIT);
    expect(await campaign.priceLock()).to.equal(UNIT);
    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE - UNIT);

    await campaign.confirmCircuits();
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    expect(await campaign.circuitHeldCount()).to.equal(1n);
  });

  it("buys several circuits in one batch and again in a later batch", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 2, UNIT);
    expect(await campaign.circuitCount()).to.equal(2n);
    await buy(ctx, 1, UNIT);
    expect(await campaign.circuitCount()).to.equal(3n);
    expect(await campaign.circuitHeldCount()).to.equal(3n);
  });

  it("an unaffordable batch sets executionFailed without reverting or buying", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const price = ethers.parseEther("1.5");
    const l = await listMany(ctx, 1, price);
    await expect(campaign.connect(owner).buyCircuits(l.ids, l.tokens, l.prices))
      .to.emit(campaign, "ExecutionFailed")
      .withArgs(price, 100n * SHARE_PRICE);
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await campaign.circuitCount()).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE);
  });

  it("refuses a stale listing id, a wrong price, or a seller that no longer owns the token", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner, market, nft, buyer } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });

    const a = await listOne(ctx, UNIT);
    await expect(
      campaign.connect(owner).buyCircuits([a.listingId + 1n], [a.tokenId], [a.price]),
    ).to.be.revertedWithCustomError(campaign, "NotACircuit");
    await expect(
      campaign.connect(owner).buyCircuits([a.listingId], [a.tokenId], [a.price + 1n]),
    ).to.be.revertedWithCustomError(campaign, "NotACircuit");

    // No custody: the seller moves the NFT away and can no longer deliver.
    await nft.connect(ctx.seller).transferFrom(ctx.seller.address, buyer.address, a.tokenId);
    await expect(
      campaign.connect(owner).buyCircuits([a.listingId], [a.tokenId], [a.price]),
    ).to.be.revertedWithCustomError(campaign, "NotACircuit");

    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE);
    expect(await market.owed(await campaign.getAddress())).to.equal(0n);
  });

  it("reverts the whole batch when the market refuses one buy", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner, market } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const l = await listMany(ctx, 2, UNIT);
    await market.setBlockBuy(true);
    await expect(campaign.connect(owner).buyCircuits(l.ids, l.tokens, l.prices)).to.be.reverted;
    expect(await campaign.circuitCount()).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE);
  });

  it("refuses delivery when the market takes the money but not the NFT", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner, market } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const l = await listMany(ctx, 1, UNIT);
    await market.setSkipTransfer(true);
    await expect(
      campaign.connect(owner).buyCircuits(l.ids, l.tokens, l.prices),
    ).to.be.revertedWithCustomError(campaign, "CircuitNotDelivered");
    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE);
  });

  it("caps a round at MAX_CIRCUITS", async () => {
    const { campaign, alice, owner } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const ids = Array.from({ length: 101 }, () => 1n);
    const tokens = Array.from({ length: 101 }, () => 1n);
    const prices = Array.from({ length: 101 }, () => 1n);
    await expect(
      campaign.connect(owner).buyCircuits(ids, tokens, prices),
    ).to.be.revertedWithCustomError(campaign, "TooManyCircuits");
  });

  it("cannot buy before the sell-out, with mismatched arrays, or outside Buying", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner } = ctx;
    const l = await listMany(ctx, 1, UNIT);
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    await expect(
      campaign.connect(owner).buyCircuits(l.ids, l.tokens, l.prices),
    ).to.be.revertedWithCustomError(campaign, "WrongScene");

    await campaign.connect(alice).subscribe(99n, { value: 99n * SHARE_PRICE });
    await expect(campaign.connect(owner).buyCircuits([1n], [], [1n])).to.be.revertedWithCustomError(
      campaign,
      "BadCount",
    );
    await expect(campaign.connect(owner).buyCircuits([], [], [])).to.be.revertedWithCustomError(
      campaign,
      "ZeroShares",
    );
  });

  it("a purchase that arrives after Ready is refused", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    const l = await listMany(ctx, 1, UNIT);
    await expect(
      campaign.connect(owner).buyCircuits(l.ids, l.tokens, l.prices),
    ).to.be.revertedWithCustomError(campaign, "WrongScene");
  });

  it("a market swap drains proceeds the old market still owes", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, market, buyer } = ctx;
    await campaign.connect(ctx.alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();

    const tokenId = await campaign.circuitIds(0);
    const price = ethers.parseEther("0.02");
    await campaign.connect(owner).listCircuit(tokenId, price);
    const listingId = await campaign.circuitListingId(tokenId);
    await market.connect(buyer).buy(listingId, price, { value: price });
    const owed = await market.owed(await campaign.getAddress());
    expect(owed).to.be.greaterThan(0n);

    const next = await ethers.deployContract("MockCircuitMarket", [FEE_BPS]);
    await campaign.connect(owner).cancelCircuitListing(tokenId);
    await campaign.connect(owner).setCircuitMarket(await next.getAddress());
    expect(await market.owed(await campaign.getAddress())).to.equal(0n);
    expect(await campaign.raisedBnb()).to.be.greaterThan(0n);
  });

  it("a market that cannot pay does not block the swap", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, market, buyer } = ctx;
    await campaign.connect(ctx.alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();

    const tokenId = await campaign.circuitIds(0);
    const price = ethers.parseEther("0.02");
    await campaign.connect(owner).listCircuit(tokenId, price);
    const listingId = await campaign.circuitListingId(tokenId);
    await market.connect(buyer).buy(listingId, price, { value: price });
    await market.setBlockWithdraw(true);

    const next = await ethers.deployContract("MockCircuitMarket", [FEE_BPS]);
    await campaign.connect(owner).cancelCircuitListing(tokenId);
    await campaign.connect(owner).setCircuitMarket(await next.getAddress());
    expect(await campaign.circuitMarket()).to.equal(await next.getAddress());
  });

  it("refuses a codeless market", async () => {
    const { campaign, owner } = await loadFixture(deployFixture);
    await expect(
      campaign.connect(owner).setCircuitMarket(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(campaign, "ZeroAddress");
    await expect(campaign.connect(owner).setCircuitMarket(owner.address)).to.be.revertedWithCustomError(
      campaign,
      "ZeroAddress",
    );
  });
});

describe("confirm / Ready", () => {
  it("cannot confirm without a circuit in hand", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await expect(campaign.confirmCircuits()).to.be.revertedWithCustomError(campaign, "CircuitsNotReady");
  });

  it("cannot fake Ready without a purchase", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await expect(campaign.connect(owner).setPhase(2)).to.be.revertedWithCustomError(
      campaign,
      "CircuitsNotReady",
    );
    await expect(campaign.connect(owner).setPhase(0)).to.be.revertedWithCustomError(campaign, "WrongScene");
  });

  it("setPlan is refused once Ready, and in Mining", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    await expect(campaign.connect(owner).setPlan(1n)).to.be.revertedWithCustomError(campaign, "WrongScene");
  });
});

describe("startMining", () => {
  it("requires Ready and at least one held circuit", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await expect(campaign.connect(owner).startMining(1n, 0, 0, [], [], [])).to.be.revertedWithCustomError(
      campaign,
      "CircuitsNotReady",
    );

    const { tokens } = await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    await expect(campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []))
      .to.emit(campaign, "MiningStarted")
      .withArgs(tokens[0], await campaign.miningKey(tokens[0]), 0n);
    expect(await campaign.scene()).to.equal(SCENE.Mining);
    expect(await campaign.miningStatus(tokens[0])).to.equal(1n);
  });

  it("keeps the circuit and refuses to start it twice", async () => {
    const { campaign, owner, alice, tokenId } = await loadFixture(pooledFixture);
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
    await expect(
      campaign.connect(owner).recoverCircuits(await campaign.circuits(), tokenId),
    ).to.be.revertedWithCustomError(campaign, "MiningActive");
    await expect(campaign.connect(owner).abandonOrder()).to.be.revertedWithCustomError(campaign, "WrongScene");
    await expect(
      campaign.connect(owner).startMining(tokenId, 0, 0, [], [], []),
    ).to.be.revertedWithCustomError(campaign, "AlreadyMining");
  });

  it("refuses to start while a circuit is listed", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const { tokens } = await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    await campaign.connect(owner).listCircuit(tokens[0], UNIT);
    await expect(
      campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []),
    ).to.be.revertedWithCustomError(campaign, "CircuitStillListed");
  });

  it("a late market credit after mining starts is booked as surplus", async () => {
    const { campaign, owner, market } = await loadFixture(pooledFixture);
    const campaignAddr = await campaign.getAddress();
    await market.creditOwed(campaignAddr, ethers.parseEther("0.02"), { value: ethers.parseEther("0.02") });
    await campaign.connect(owner).withdrawMarketProceeds();
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.surplusPool()).to.be.greaterThan(0n);
  });

  it("books the leftover BNB as surplus and lets holders pull it", async () => {
    const { campaign, alice, bob } = await loadFixture(pooledFixture);
    const surplus = await campaign.surplusPool();
    expect(surplus).to.be.greaterThan(0n);
    await campaign.connect(alice).claimSurplus();
    await campaign.connect(bob).claimSurplus();
    expect(await campaign.surplusPaid()).to.equal(surplus);
    expect(await campaign.surplusOf(alice.address)).to.equal(0n);
    expect(await campaign.surplusOf(bob.address)).to.equal(0n);
  });

  it("returns leftover BNB pro-rata while staying Ready, without blocking mining", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const { tokens } = await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    expect(await campaign.phase()).to.equal(PHASE.Ready);

    await campaign.connect(owner).returnSurplus();
    expect(await campaign.surplusPool()).to.be.greaterThan(0n);
    expect(await campaign.raisedBnb()).to.equal(0n);

    await campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []);
    expect(await campaign.scene()).to.equal(SCENE.Mining);

    await campaign.connect(alice).claimSurplus();
    expect(await campaign.surplusOf(alice.address)).to.equal(0n);
  });

  it("a second returnSurplus cannot re-book the same money", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    await campaign.connect(owner).returnSurplus();
    await expect(campaign.connect(owner).returnSurplus()).to.be.revertedWithCustomError(campaign, "ZeroShares");
  });
});

describe("official mining rewards", () => {
  it("harvests BEM and splits it pro-rata by shares", async () => {
    const { campaign, owner, alice, bob, pod, tokenId } = await loadFixture(pooledFixture);
    const key = await campaign.miningKey(tokenId);
    const gross = ethers.parseEther("1000");
    await pod.accrue(key, gross);
    expect(await campaign.miningPending(tokenId)).to.equal(gross);

    await expect(campaign.connect(owner).claimMiningRewards())
      .to.emit(campaign, "MiningRewardsClaimed")
      .withArgs(1n, gross);
    expect(await campaign.bemPendingOf(alice.address)).to.equal((gross * 60n) / 100n);
    expect(await campaign.bemPendingOf(bob.address)).to.equal((gross * 40n) / 100n);
  });

  it("stopMining settles the reward before the miner goes cooling", async () => {
    const { campaign, owner, alice, pod, tokenId } = await loadFixture(pooledFixture);
    await pod.accrue(await campaign.miningKey(tokenId), ethers.parseEther("50"));
    await expect(campaign.connect(owner).stopMining(tokenId)).to.emit(campaign, "MiningStopped");
    expect(await campaign.miningStatus(tokenId)).to.equal(3n);
    expect(await campaign.bemPendingOf(alice.address)).to.equal(ethers.parseEther("30"));
  });

  it("claimBem pays the holder and cannot pay twice", async () => {
    const { campaign, owner, alice, pod, tokenId } = await loadFixture(pooledFixture);
    await pod.accrue(await campaign.miningKey(tokenId), ethers.parseEther("100"));
    await campaign.connect(owner).claimMiningRewards();
    await expect(campaign.connect(alice).claimBem())
      .to.emit(campaign, "BemPaid")
      .withArgs(alice.address, ethers.parseEther("60"));
    expect(await campaign.bemPendingOf(alice.address)).to.equal(0n);
    await expect(campaign.connect(alice).claimBem()).to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("settles the seller before shares move, so resale cannot steal earned BEM", async () => {
    const { campaign, owner, alice, bob, pod, tokenId } = await loadFixture(pooledFixture);
    await pod.accrue(await campaign.miningKey(tokenId), ethers.parseEther("100"));
    await campaign.connect(owner).claimMiningRewards();
    await campaign.connect(alice).listShares(60n, ethers.parseEther("0.02"));
    await campaign.connect(bob).takeListing(0n, 60n, { value: ethers.parseEther("1.2") });
    expect(await campaign.bemPendingOf(alice.address)).to.equal(ethers.parseEther("60"));
    expect(await campaign.bemPendingOf(bob.address)).to.equal(ethers.parseEther("40"));
  });
});

describe("refund / abort", () => {
  it("funding timeout refund clears shares", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(10n, { value: 10n * SHARE_PRICE });
    await time.increase(FUNDING_SECONDS + 1);
    await expect(campaign.connect(alice).refund())
      .to.emit(campaign, "Refunded")
      .withArgs(alice.address, 10n * SHARE_PRICE);
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
  });

  it("Ready cannot be turned into a refund state, so circuits stay with the holders", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    await expect(campaign.connect(owner).markFailed()).to.be.revertedWithCustomError(
      campaign,
      "UseReturnSurplus",
    );
    await time.increase(4 * 24 * 60 * 60);
    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(
      campaign,
      "UseReturnSurplus",
    );
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(
      campaign,
      "RefundNotAvailable",
    );
    expect(await campaign.sharesOf(alice.address)).to.equal(100n);
  });

  it("a short pool with circuits held closes every refund exit", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, owner } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, SHORT_PRICE);
    expect(await campaign.raisedBnb()).to.be.lessThan(100n * SHARE_PRICE);
    await expect(campaign.connect(owner).openRefund()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    await expect(campaign.connect(owner).abandonOrder()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(
      campaign,
      "CircuitsAreCollateral",
    );
  });

  it("openRefund opens the gate and holders pull their principal", async () => {
    const { campaign, alice, bob, owner } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await expect(campaign.connect(owner).openRefund()).to.emit(campaign, "RefundsOpened");
    expect(await campaign.executionFailed()).to.equal(true);
    await campaign.connect(alice).refund();
    await campaign.connect(bob).refund();
    expect(await campaign.outstandingShares()).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(0n);
  });

  it("abandonOrder hands circuits over only once every holder is settled and repaid", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice, nft } = ctx;
    const rejector = await ethers.deployContract("Rejector");
    await rejector.subscribe(await campaign.getAddress(), 40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await buy(ctx, 1, SHORT_PRICE);
    // Top up so every share can be repaid at the subscription price.
    await campaign.connect(owner).topUpShortfall({ value: SHORT_PRICE });

    await rejector.reject();
    await campaign.connect(owner).abandonOrder();
    expect(await campaign.outstandingShares()).to.equal(100n);
    const tokenId = await campaign.circuitIds(0);
    expect(await nft.ownerOf(tokenId)).to.equal(await campaign.getAddress());

    await campaign.connect(alice).refund();
    expect(await campaign.outstandingShares()).to.equal(40n);
    await expect(rejector.refundFrom(await campaign.getAddress())).to.be.revertedWithCustomError(
      campaign,
      "TransferFailed",
    );
    await campaign.connect(owner).abandonOrder();
    expect(await nft.ownerOf(tokenId)).to.equal(await campaign.getAddress());

    await rejector.accept();
    await rejector.refundFrom(await campaign.getAddress());
    expect(await campaign.outstandingShares()).to.equal(0n);
    await campaign.connect(owner).abandonOrder();
    expect(await nft.ownerOf(tokenId)).to.equal(owner.address);
  });

  it("a holder that rejects BNB keeps a claimable surplus", async () => {
    const { campaign, owner, rejector } = await loadFixture(rejectorPooledFixture);
    await campaign.connect(owner).depositRevenue({ value: ethers.parseEther("0.05") });
    await expect(rejector.claimSurplusFrom(await campaign.getAddress())).to.be.revertedWithCustomError(
      campaign,
      "TransferFailed",
    );
    await rejector.accept();
    await rejector.claimSurplusFrom(await campaign.getAddress());
    expect(await campaign.surplusOf(await rejector.getAddress())).to.equal(0n);
  });

  it("non-owner markFailed is locked for the grace window, then opens refunds", async () => {
    const { campaign, alice, owner } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(1n);
    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(
      campaign,
      "RefundNotAvailable",
    );
    await time.increase(3 * 24 * 3600);
    await campaign.connect(alice).markFailed();
    expect(await campaign.executionFailed()).to.equal(true);
    await expect(campaign.connect(alice).refund()).to.emit(campaign, "Refunded");
  });

  it("a single holder cannot kill a healthy round inside the grace window", async () => {
    const { campaign, alice, owner } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(1n);
    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(
      campaign,
      "RefundNotAvailable",
    );
    expect(await campaign.executionFailed()).to.equal(false);
  });

  it("a pro-rata refund that rounds to 0 still settles the holder", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice, bob, market, buyer } = ctx;
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    await campaign.connect(bob).subscribe(99n, { value: 99n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(1n);
    await buy(ctx, 1, SHORT_PRICE);

    // Sell the circuit back for 99% of its cost, leaving a pool that is 0.6% short of full repayment.
    await campaign.confirmCircuits();
    const tokenId = await campaign.circuitIds(0);
    await campaign.connect(owner).listCircuit(tokenId, SHORT_PRICE);
    const listingId = await campaign.circuitListingId(tokenId);
    await market.connect(buyer).buy(listingId, SHORT_PRICE, { value: SHORT_PRICE });
    await campaign.connect(owner).cancelCircuitListing(tokenId);
    await campaign.connect(owner).withdrawMarketProceeds();
    expect(await campaign.raisedBnb()).to.equal(ethers.parseEther("0.994"));

    // Ready → Buying recovery path, then open the pro-rata gate.
    await campaign.connect(owner).setPhase(1);
    await campaign.connect(owner).openRefund();
    await campaign.connect(alice).refund();
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.outstandingShares()).to.equal(99n);
  });
});

describe("circuit listing (sell side)", () => {
  it("lists a held circuit at or above cost and pays the seller on withdraw", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, market, nft, buyer } = ctx;
    await campaign.connect(ctx.alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();

    const tokenId = await campaign.circuitIds(0);
    const price = ethers.parseEther("0.02");
    const tx = await campaign.connect(owner).listCircuit(tokenId, price);
    const listingId = await campaign.circuitListingId(tokenId);
    await expect(tx).to.emit(campaign, "CircuitListed").withArgs(tokenId, listingId, price);
    expect(await campaign.activeListingCount()).to.equal(1n);

    await market.connect(buyer).buy(listingId, price, { value: price });
    expect(await nft.ownerOf(tokenId)).to.equal(buyer.address);
    const owed = await market.owed(await campaign.getAddress());
    expect(owed).to.equal((price * 9900n) / 10000n);

    const before = await campaign.raisedBnb();
    await campaign.connect(owner).withdrawMarketProceeds();
    expect(await campaign.raisedBnb()).to.equal(before + owed);
  });

  it("refuses a price below cost, a token it does not own, and a double listing", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    const tokenId = await campaign.circuitIds(0);
    await expect(campaign.connect(owner).listCircuit(tokenId, UNIT - 1n)).to.be.revertedWithCustomError(
      campaign,
      "PriceBelowCost",
    );
    await expect(campaign.connect(owner).listCircuit(999999n, UNIT)).to.be.revertedWithCustomError(
      campaign,
      "NotACircuitOwner",
    );
    await campaign.connect(owner).listCircuit(tokenId, UNIT);
    await expect(campaign.connect(owner).listCircuit(tokenId, UNIT)).to.be.revertedWithCustomError(
      campaign,
      "AlreadyListed",
    );
  });

  it("a stale local listing clears when the market already sold it", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, market, buyer } = ctx;
    await campaign.connect(ctx.alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();

    const tokenId = await campaign.circuitIds(0);
    await campaign.connect(owner).listCircuit(tokenId, UNIT);
    const listingId = await campaign.circuitListingId(tokenId);
    await market.connect(buyer).buy(listingId, UNIT, { value: UNIT });
    expect(await campaign.activeListingCount()).to.equal(1n);

    await expect(campaign.connect(owner).cancelCircuitListing(tokenId)).to.emit(
      campaign,
      "CircuitListingCancelled",
    );
    expect(await campaign.activeListingCount()).to.equal(0n);
    expect(await campaign.circuitListingId(tokenId)).to.equal(0n);
  });

  it("owner can cancel; a stranger only after the factory retires the round", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, factory, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();

    const tokenId = await campaign.circuitIds(0);
    await campaign.connect(owner).listCircuit(tokenId, UNIT);
    await expect(campaign.connect(alice).cancelCircuitListing(tokenId)).to.be.revertedWithCustomError(
      campaign,
      "NotOwner",
    );

    await factory.connect(owner).removeCampaign(0);
    await expect(campaign.connect(alice).cancelCircuitListing(tokenId)).to.emit(
      campaign,
      "CircuitListingCancelled",
    );
    expect(await campaign.activeListingCount()).to.equal(0n);
  });

  it("recovers a foreign token but not a circuit backing outstanding shares", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, nft, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();

    // A token from another collection can leave: only `circuits` backs the shares.
    const otherNft = await ethers.deployContract("MockCircuitNft");
    const foreign = BigInt(tokenSeq++);
    await otherNft.mint(await campaign.getAddress(), foreign);
    await campaign.connect(owner).recoverCircuits(await otherNft.getAddress(), foreign);
    expect(await otherNft.ownerOf(foreign)).to.equal(owner.address);

    const own = await campaign.circuitIds(0);
    await expect(
      campaign.connect(owner).recoverCircuits(await nft.getAddress(), own),
    ).to.be.revertedWithCustomError(campaign, "SharesOutstanding");
  });
});

describe("share transfer (Mining only)", () => {
  it("list / cancel / take keeps shares and BNB conserved", async () => {
    const { campaign, alice, bob } = await loadFixture(pooledFixture);
    await campaign.connect(alice).listShares(10n, ethers.parseEther("0.02"));
    expect(await campaign.escrowOf(alice.address)).to.equal(10n);
    await expect(
      campaign.connect(alice).takeListing(0n, 1n, { value: ethers.parseEther("0.02") }),
    ).to.be.revertedWithCustomError(campaign, "CannotTakeOwnListing");
    await campaign.connect(bob).takeListing(0n, 4n, { value: ethers.parseEther("0.08") });
    expect(await campaign.sharesOf(bob.address)).to.equal(44n);
    expect(await campaign.escrowOf(alice.address)).to.equal(6n);
    await campaign.connect(alice).cancelListing(0n);
    expect(await campaign.sharesOf(alice.address)).to.equal(56n);
  });

  it("cannot list while funding", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).listShares(1n, 1n)).to.be.revertedWithCustomError(
      campaign,
      "WrongScene",
    );
  });
});

describe("service fee", () => {
  it("charges only mining revenue and lets each recipient pull", async () => {
    const { campaign, owner, feeRecipient } = await loadFixture(feeFixture);
    await campaign.connect(owner).depositRevenue({ value: ethers.parseEther("0.1") });
    const expected = (ethers.parseEther("0.1") * 500n) / 10000n;
    expect(await campaign.pendingFee(feeRecipient.address)).to.equal(expected);
    await campaign.connect(feeRecipient).claimFee();
    expect(await campaign.pendingFee(feeRecipient.address)).to.equal(0n);
  });

  it("cannot be set after somebody subscribed", async () => {
    const { campaign, owner, alice, feeRecipient } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    await expect(
      campaign.connect(owner).setServiceFee(500, [feeRecipient.address], [10000]),
    ).to.be.revertedWithCustomError(campaign, "ServiceFeeLocked");
  });

  it("rejects an invalid table", async () => {
    const { campaign, owner, alice, bob } = await loadFixture(deployFixture);
    await expect(
      campaign.connect(owner).setServiceFee(1001, [alice.address], [10000]),
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    await expect(
      campaign.connect(owner).setServiceFee(500, [alice.address, bob.address], [10000, 1]),
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    await expect(
      campaign.connect(owner).setServiceFee(500, [alice.address, alice.address], [5000, 5000]),
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
  });

  it("an explicit zero fee freezes at no fee", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    await campaign.connect(owner).setServiceFee(0, [], []);
    expect(await campaign.serviceFeeSet()).to.equal(true);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const { tokens } = await buy(ctx, 1, UNIT);
    await campaign.confirmCircuits();
    await campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []);
    await campaign.connect(owner).depositRevenue({ value: ethers.parseEther("0.01") });
    expect(await campaign.totalPendingFee()).to.equal(0n);
  });
});

describe("single owner key", () => {
  it("has no operator role left", async () => {
    const { campaign } = await loadFixture(deployFixture);
    const names = campaign.interface.fragments.map((f) => f.name);
    expect(names).to.not.include("operator");
    expect(names).to.not.include("setOperator");
  });

  it("a stranger cannot reach a single owner step", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, alice, market } = ctx;
    const marketAddr = await market.getAddress();
    const checks = [
      () => campaign.connect(alice).setPlan(1n),
      () => campaign.connect(alice).setCircuitMarket(marketAddr),
      () => campaign.connect(alice).setServiceFee(0, [], []),
      () => campaign.connect(alice).buyCircuits([ethers.ZeroAddress], [0n], [0n]),
      () => campaign.connect(alice).listCircuit(1n, 1n),
      () => campaign.connect(alice).topUpShortfall({ value: 1n }),
      () => campaign.connect(alice).openRefund(),
      () => campaign.connect(alice).abandonOrder(),
      () => campaign.connect(alice).startMining(1n, 0, 0, [], [], []),
      () => campaign.connect(alice).stopMining(1n),
      () => campaign.connect(alice).depositRevenue({ value: 1n }),
      () => campaign.connect(alice).recoverCircuits(alice.address, 1n),
      () => campaign.connect(alice).recoverBnb(),
      () => campaign.connect(alice).halt(),
      () => campaign.connect(alice).resume(),
      () => campaign.connect(alice).transferOwnership(alice.address),
    ];
    for (const check of checks) {
      await expect(check()).to.be.revertedWithCustomError(campaign, "NotOwner");
    }
  });

  it("the owner runs every routine step alone, end to end", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    await campaign.connect(owner).setPlan(408n);
    await campaign.connect(owner).subscribe(100n, { value: 100n * SHARE_PRICE });
    const { tokens } = await buy(ctx, 1, UNIT);
    await campaign.connect(owner).confirmCircuits();
    await campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []);
    expect(await campaign.scene()).to.equal(SCENE.Mining);
    await campaign.connect(owner).halt();
    await campaign.connect(owner).resume();
    await campaign.connect(owner).transferOwnership(alice.address);
    expect(await campaign.owner()).to.equal(alice.address);
  });
});

describe("circuit breaker", () => {
  it("only the owner can halt or resume", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).halt()).to.be.revertedWithCustomError(campaign, "NotOwner");
    await campaign.connect(owner).halt();
    await expect(campaign.connect(alice).resume()).to.be.revertedWithCustomError(campaign, "NotOwner");
    await campaign.connect(owner).resume();
  });

  it("halt stops money-in and startMining", async () => {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice } = ctx;
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    const { tokens } = await buy(ctx, 1, UNIT);
    await campaign.connect(owner).confirmCircuits();

    const l = await listMany(ctx, 1, UNIT);
    await campaign.connect(owner).halt();
    await expect(
      campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE }),
    ).to.be.revertedWithCustomError(campaign, "Halted");
    await expect(
      campaign.connect(owner).buyCircuits(l.ids, l.tokens, l.prices),
    ).to.be.revertedWithCustomError(campaign, "Halted");
    await expect(campaign.connect(owner).listCircuit(1n, 1n)).to.be.revertedWithCustomError(
      campaign,
      "Halted",
    );
    await expect(
      campaign.connect(owner).startMining(tokens[0], 0, 0, [], [], []),
    ).to.be.revertedWithCustomError(campaign, "Halted");
    await campaign.connect(owner).resume();
  });

  it("a halt never blocks markFailed / refund after the grace window", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).halt();
    await time.increase(3 * 24 * 3600);
    await campaign.connect(alice).markFailed();
    await campaign.connect(alice).refund();
    expect(await campaign.outstandingShares()).to.equal(0n);
  });

  it("a halt does not stop revenue or the fee pull", async () => {
    const { campaign, owner, feeRecipient } = await loadFixture(feeFixture);
    await campaign.connect(owner).halt();
    await campaign.connect(owner).depositRevenue({ value: ethers.parseEther("0.01") });
    const due = await campaign.pendingFee(feeRecipient.address);
    expect(due).to.be.greaterThan(0n);
    await campaign.connect(feeRecipient).claimFee();
    expect(await campaign.pendingFee(feeRecipient.address)).to.equal(0n);
  });

  it("a halted seller can still cancel a share listing", async () => {
    const { campaign, alice, owner } = await loadFixture(pooledFixture);
    await campaign.connect(alice).listShares(1n, ethers.parseEther("0.02"));
    await campaign.connect(owner).halt();
    await campaign.connect(alice).cancelListing(0n);
    expect(await campaign.escrowOf(alice.address)).to.equal(0n);
  });
});

describe("recover / sweep", () => {
  it("recoverBnb sweeps only the excess and never touches escrow", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    // Over-fund the round, then let the holder take the full principal: 0.5 BNB remains unowed.
    await campaign.connect(owner).topUpShortfall({ value: ethers.parseEther("0.5") });
    await campaign.connect(owner).markFailed();
    await campaign.connect(alice).refund();
    expect(await campaign.outstandingShares()).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(ethers.parseEther("0.5"));

    const before = await ethers.provider.getBalance(owner.address);
    const tx = await campaign.connect(owner).recoverBnb();
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect(await ethers.provider.getBalance(owner.address)).to.equal(
      before + ethers.parseEther("0.5") - gas,
    );
    expect(await campaign.raisedBnb()).to.equal(0n);
  });

  it("recoverBnb refuses when there is no excess", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await expect(campaign.connect(owner).recoverBnb()).to.be.revertedWithCustomError(
      campaign,
      "ZeroShares",
    );
  });
});
