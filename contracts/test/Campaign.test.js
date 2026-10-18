const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const SHARE_PRICE = ethers.parseEther("0.01");
const TOTAL_SHARES = 100n;
const FEE_PERCENT = 5;
const FUNDING_DAYS = 7;
const TASK_ID = 54n;
const HASHPOWER = 408n;
const NETLIST = ethers.keccak256(ethers.toUtf8Bytes("netlist-v1"));
const RAW_NETLIST = ethers.toUtf8Bytes("netlist-v1");
const START = "0x12345678";

const SCENE = { Funding: 0n, Executing: 1n, Mining: 2n };
const PHASE = { None: 0n, Buying: 1n, Listed: 2n, Ready: 3n };
const DAILY_BEM = (HASHPOWER * 7200n * 10n ** 18n * 9900n) / (10000n * 1_579_178n);
const TT = "0xCC42ba5De07f01B472a5b14cF45aBcCA79Eb8087";
const UNIT = ethers.parseEther("0.005");

function place(campaign, signer, qty, price) {
  return campaign.transistors().then((tt) => campaign.connect(signer).placeTransistorOrder(tt, qty, price, 0, 0));
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
  const [owner, alice, bob, carol, feeRecipient] = await ethers.getSigners();
  const bem = await ethers.deployContract("MockBEM");
  const pod = await ethers.deployContract("MockPoD", [await bem.getAddress(), HASHPOWER]);
  const minter = await ethers.deployContract("MockMaterialMarket");
  const parts = await ethers.deployContract("MockERC1155");
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
      [feeRecipient.address],
      [10_000],
      TASK_ID,
      ethers.ZeroAddress,
      NETLIST,
      await parts.getAddress()
    );
  const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(0));
  return { bem, pod, minter, parts, factory, campaign, owner, alice, bob, carol, feeRecipient };
}

async function miningFixture() {
  const ctx = await loadFixture(deployFixture);
  const { campaign, alice, bob, owner, pod, bem } = ctx;
  await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
  expect(await campaign.scene()).to.equal(SCENE.Executing);
  await campaign.connect(owner).setPlan(408n, false, 100n);
  await place(campaign, owner, 100n, UNIT);
  await fillAndConfirm(campaign, ctx.minter);
  await campaign.connect(owner).execute(RAW_NETLIST, START);
  expect(await campaign.scene()).to.equal(SCENE.Mining);
  await bem.mint(await pod.getAddress(), DAILY_BEM * 10n);
  await pod.setDailyAmount(DAILY_BEM);
  return ctx;
}

describe("CampaignFactory", () => {
  it("only Factory Owner can create", async () => {
    const { factory, alice, feeRecipient } = await loadFixture(deployFixture);
    await expect(
      factory
        .connect(alice)
        .createCampaign(
          SHARE_PRICE,
          TOTAL_SHARES,
          FEE_PERCENT,
          FUNDING_DAYS,
          [feeRecipient.address],
          [10_000],
          TASK_ID,
          ethers.ZeroAddress,
          NETLIST,
          TT
        )
    ).to.be.revertedWithCustomError(factory, "NotOwner");
  });

  it("stores campaigns and increments count", async () => {
    const { factory, owner, feeRecipient } = await loadFixture(deployFixture);
    expect(await factory.campaignCount()).to.equal(1n);
    await factory
      .connect(owner)
      .createCampaign(SHARE_PRICE, 50n, FEE_PERCENT, FUNDING_DAYS, [feeRecipient.address], [10_000], 5n, ethers.ZeroAddress, NETLIST, TT);
    expect(await factory.campaignCount()).to.equal(2n);
    const all = await factory.allCampaigns();
    expect(all.length).to.equal(2);
  });

  it("Owner can update factory pod/bem/minter and ownership", async () => {
    const { factory, owner, alice, bem, pod, minter } = await loadFixture(deployFixture);
    const otherBem = await (await ethers.getContractFactory("MockBEM")).deploy();
    await otherBem.waitForDeployment();
    await expect(factory.connect(alice).setBem(await otherBem.getAddress())).to.be.revertedWithCustomError(factory, "NotOwner");
    await expect(factory.connect(owner).setBem(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    await expect(factory.connect(owner).setBem(await otherBem.getAddress()))
      .to.emit(factory, "BemUpdated");
    expect(await factory.bem()).to.equal(await otherBem.getAddress());
    await factory.connect(owner).setPod(await pod.getAddress());
    await factory.connect(owner).setMinter(await minter.getAddress());
    expect(await factory.pod()).to.equal(await pod.getAddress());
    expect(await factory.minter()).to.equal(await minter.getAddress());
    await factory.connect(owner).transferOwnership(alice.address);
    expect(await factory.owner()).to.equal(alice.address);
    // restore for isolation ? fixture is fresh per test anyway
    void bem;
  });

  it("Owner can update campaign pod/bem/minter", async () => {
    const { campaign, owner, alice, pod, minter } = await loadFixture(deployFixture);
    const otherBem = await (await ethers.getContractFactory("MockBEM")).deploy();
    await otherBem.waitForDeployment();
    await expect(campaign.connect(alice).setBem(await otherBem.getAddress())).to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(owner).setBem(await otherBem.getAddress()))
      .to.emit(campaign, "BemUpdated");
    expect(await campaign.bem()).to.equal(await otherBem.getAddress());
    await campaign.connect(owner).setPod(await pod.getAddress());
    await campaign.connect(owner).setMinter(await minter.getAddress());
  });

  it("Owner can remove campaign from registry without destroying it", async () => {
    const { factory, owner, alice, feeRecipient, campaign } = await loadFixture(deployFixture);
    const first = await factory.campaigns(0);
    await factory
      .connect(owner)
      .createCampaign(SHARE_PRICE, 50n, FEE_PERCENT, FUNDING_DAYS, [feeRecipient.address], [10_000], 5n, ethers.ZeroAddress, NETLIST, TT);
    const second = await factory.campaigns(1);
    expect(await factory.campaignCount()).to.equal(2n);

    await expect(factory.connect(alice)["removeCampaign(uint256)"](0)).to.be.revertedWithCustomError(factory, "NotOwner");
    await expect(factory.connect(owner)["removeCampaign(uint256)"](9)).to.be.revertedWithCustomError(factory, "IndexOutOfBounds");

    await expect(factory.connect(owner)["removeCampaign(address)"](first))
      .to.emit(factory, "CampaignRemoved");
    expect(await factory.campaignCount()).to.equal(1n);
    expect(await factory.campaigns(0)).to.equal(second);

    // Registry only: original Campaign bytecode remains
    expect(await ethers.provider.getCode(first)).to.not.equal("0x");
    expect(await campaign.getAddress()).to.equal(first);
    expect(await campaign.scene()).to.equal(0); // Funding

    await expect(factory.connect(owner)["removeCampaign(address)"](first))
      .to.be.revertedWithCustomError(factory, "CampaignNotFound");
  });
});

describe("funding subscribe", () => {
  it("requires exact payment and no oversell", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE - 1n })).to.be.revertedWithCustomError(campaign, "WrongPayment");
    await expect(campaign.connect(alice).subscribe(0n, { value: 0 })).to.be.revertedWithCustomError(campaign, "ZeroShares");
    await campaign.connect(alice).subscribe(10n, { value: SHARE_PRICE * 10n });
    await expect(campaign.connect(alice).subscribe(91n, { value: SHARE_PRICE * 91n })).to.be.revertedWithCustomError(campaign, "ExceedsRemaining");
  });

  it("sellout moves to executing/buying", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    expect(await campaign.scene()).to.equal(SCENE.Funding);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    expect(await campaign.scene()).to.equal(SCENE.Executing);
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.soldOutAt()).to.be.gt(0n);
  });

  it("rejects direct ETH transfer", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(alice.sendTransaction({ to: await campaign.getAddress(), value: 1n })).to.be.revertedWithCustomError(
      campaign,
      "DirectTransferNotAllowed"
    );
  });
});

describe("refund", () => {
  it("funding timeout refund clears shares", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(30n, { value: SHARE_PRICE * 30n });
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
    await time.increase(FUNDING_DAYS * 24 * 3600 + 1);
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const receipt = await tx.wait();
    const after = await ethers.provider.getBalance(alice.address);
    expect(after + receipt.gasUsed * receipt.gasPrice - before).to.equal(SHARE_PRICE * 30n);
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.refundedOf(alice.address)).to.equal(SHARE_PRICE * 30n);
  });

  it("mining cannot refund", async () => {
    const { campaign, alice } = await miningFixture();
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
  });
});

describe("transistor order + execute", () => {
  it("phase machine and auth", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await expect(place(campaign, alice, 100n, UNIT)).to.be.revertedWithCustomError(campaign, "NotOwner");
    await place(campaign, owner, 100n, UNIT);
    expect(await campaign.phase()).to.equal(PHASE.Listed);
    await expect(campaign.connect(alice).cancelTransistorOrder()).to.be.revertedWithCustomError(campaign, "NotOwner");
    expect(await campaign.nandBidId()).to.not.equal(0n);
    const raisedAfterBid = await campaign.raisedBnb();
    expect(raisedAfterBid).to.equal(SHARE_PRICE * 100n - 100n * UNIT);
    await campaign.connect(owner).cancelTransistorOrder();
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.raisedBnb()).to.equal(SHARE_PRICE * 100n);
    await place(campaign, owner, 100n, UNIT);
    await expect(campaign.connect(owner).confirmTransistors()).to.be.revertedWithCustomError(
      campaign,
      "TransistorsNotReady"
    );
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);
  });

  it("execute gates: not ready / not owner / netlist", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await expect(campaign.connect(owner).execute(RAW_NETLIST, START)).to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    await expect(campaign.connect(alice).execute(RAW_NETLIST, START)).to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(owner).execute(ethers.toUtf8Bytes("evil"), START)).to.be.revertedWithCustomError(
      campaign,
      "NetlistMismatch"
    );
  });

  it("execute success returns surplus pro-rata", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    const cost = 100n * UNIT;
    const surplus = SHARE_PRICE * 100n - cost;
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    await expect(campaign.connect(owner).execute(RAW_NETLIST, START))
      .to.emit(campaign, "Executed")
      .and.to.emit(campaign, "SurplusReturned")
      .withArgs(alice.address, surplus);
    expect(await campaign.scene()).to.equal(SCENE.Mining);
    expect(await campaign.phase()).to.equal(PHASE.None);
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await ethers.provider.getBalance(await minter.getAddress())).to.equal(cost);
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(surplus);
  });

  it("unaffordable place marks failed without escrowing", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await expect(place(campaign, owner, 100n, ethers.parseEther("0.02"))).to.emit(campaign, "ExecutionFailed");
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await campaign.raisedBnb()).to.equal(SHARE_PRICE * 100n);
    await expect(campaign.connect(owner).execute(RAW_NETLIST, START)).to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    await place(campaign, owner, 100n, UNIT);
    expect(await campaign.executionFailed()).to.equal(false);
    await fillAndConfirm(campaign, minter);
    await expect(campaign.connect(owner).execute(RAW_NETLIST, START)).to.emit(campaign, "Executed");
    expect(await campaign.scene()).to.equal(SCENE.Mining);
  });

  it("unaffordable then user refund", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await place(campaign, owner, 100n, ethers.parseEther("0.02"));
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const receipt = await tx.wait();
    const after = await ethers.provider.getBalance(alice.address);
    expect(after + receipt.gasUsed * receipt.gasPrice - before).to.equal(SHARE_PRICE * 100n);
  });

  it("partial fill can be cancelled and holders refund the remaining pool", async () => {
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: SHARE_PRICE * 60n });
    await campaign.connect(bob).subscribe(40n, { value: SHARE_PRICE * 40n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    const pool = SHARE_PRICE * 100n - UNIT;
    await expect(campaign.connect(alice).cancelTransistorOrder()).to.emit(campaign, "TransistorOrderCancelled");
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.raisedBnb()).to.equal(pool);
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const receipt = await tx.wait();
    expect(await ethers.provider.getBalance(alice.address) + receipt.gasUsed * receipt.gasPrice - aliceBefore).to.equal(
      (pool * 60n) / 100n
    );
    await campaign.connect(bob).refund();
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.sharesOf(bob.address)).to.equal(0n);
  });

  it("a filled order with parts on hand cannot be cancelled", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 100n);
    await parts.mint(await campaign.getAddress(), 0, 100n);
    await expect(campaign.connect(owner).cancelTransistorOrder()).to.be.revertedWithCustomError(campaign, "OrderFilled");
    await campaign.confirmTransistors();
    expect(await campaign.phase()).to.equal(PHASE.Ready);
  });

  it("filled book without parts does not confirm, and cancel lets holders take the leftover", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await place(campaign, owner, 50n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 50n);
    await expect(campaign.confirmTransistors()).to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    await campaign.connect(alice).cancelTransistorOrder();
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    const leftover = SHARE_PRICE * 100n - 50n * UNIT;
    expect(await campaign.raisedBnb()).to.equal(leftover);
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const receipt = await tx.wait();
    expect(await ethers.provider.getBalance(alice.address) + receipt.gasUsed * receipt.gasPrice - before).to.equal(leftover);
  });

  it("placeBid that returns id 0 reverts and keeps the pool", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await minter.setReturnZeroId(true);
    await expect(place(campaign, owner, 100n, UNIT)).to.be.revertedWithCustomError(campaign, "BadBidId");
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.raisedBnb()).to.equal(SHARE_PRICE * 100n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(SHARE_PRICE * 100n);
  });

  it("setPlan blocked after listed / mining; count cannot be 0", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await expect(campaign.connect(owner).setPlan(1n, false, 0n)).to.be.revertedWithCustomError(campaign, "ZeroShares");
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await place(campaign, owner, 100n, UNIT);
    await expect(campaign.connect(owner).setPlan(408n, false, 1n)).to.be.revertedWithCustomError(campaign, "WrongScene");
    await fillAndConfirm(campaign, minter);
    await expect(campaign.connect(owner).setPlan(408n, false, 1n)).to.be.revertedWithCustomError(campaign, "WrongScene");
    await campaign.connect(owner).execute(RAW_NETLIST, START);
    await expect(campaign.connect(owner).setPlan(408n, false, 1n)).to.be.revertedWithCustomError(campaign, "WrongScene");
  });

  it("openRefund batch refunds holders", async () => {
    const { campaign, owner, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: SHARE_PRICE * 60n });
    await campaign.connect(bob).subscribe(40n, { value: SHARE_PRICE * 40n });
    await expect(campaign.connect(alice).openRefund()).to.be.revertedWithCustomError(campaign, "NotOwner");
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const bobBefore = await ethers.provider.getBalance(bob.address);
    await expect(campaign.connect(owner).openRefund())
      .to.emit(campaign, "ExecutionFailed")
      .and.to.emit(campaign, "Refunded")
      .withArgs(alice.address, SHARE_PRICE * 60n)
      .and.to.emit(campaign, "Refunded")
      .withArgs(bob.address, SHARE_PRICE * 40n);
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(SHARE_PRICE * 60n);
    expect(await ethers.provider.getBalance(bob.address) - bobBefore).to.equal(SHARE_PRICE * 40n);
    await expect(place(campaign, owner, 100n, UNIT)).to.be.revertedWithCustomError(
      campaign,
      "RefundNotAvailable"
    );
  });
});

describe("share transfer", () => {
  it("list escrow / cancel / no self-take", async () => {
    const { campaign, alice } = await miningFixture();
    await expect(campaign.connect(alice).listShares(100n, SHARE_PRICE)).to.be.revertedWithCustomError(campaign, "InsufficientShares");
    await campaign.connect(alice).listShares(20n, ethers.parseEther("0.02"));
    expect(await campaign.sharesOf(alice.address)).to.equal(40n);
    expect(await campaign.escrowOf(alice.address)).to.equal(20n);
    await expect(campaign.connect(alice).takeListing(0n, 1n, { value: ethers.parseEther("0.02") })).to.be.revertedWithCustomError(
      campaign,
      "CannotTakeOwnListing"
    );
    await campaign.connect(alice).cancelListing(0n);
    expect(await campaign.sharesOf(alice.address)).to.equal(60n);
  });

  it("takeListing transfers shares and BNB", async () => {
    const { campaign, alice, bob } = await miningFixture();
    await campaign.connect(alice).listShares(20n, ethers.parseEther("0.03"));
    const pay = 5n * ethers.parseEther("0.03");
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const bobSharesBefore = await campaign.sharesOf(bob.address);
    await expect(campaign.connect(bob).takeListing(0n, 5n, { value: pay - 1n })).to.be.revertedWithCustomError(campaign, "WrongPayment");
    await campaign.connect(bob).takeListing(0n, 5n, { value: pay });
    expect(await campaign.sharesOf(bob.address)).to.equal(bobSharesBefore + 5n);
    expect(await campaign.escrowOf(alice.address)).to.equal(15n);
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(pay);
  });

  it("takeListing moves claimed pro-rata", async () => {
    const { campaign, alice, bob, bem, pod } = await miningFixture();
    await campaign.connect(alice).harvest();
    const alicePending = await campaign.pendingBem(alice.address);
    await campaign.connect(alice).claim();
    const bobPendingBefore = await campaign.pendingBem(bob.address);
    await campaign.connect(alice).listShares(30n, ethers.parseEther("0.02"));
    await campaign.connect(bob).takeListing(0n, 30n, { value: 30n * ethers.parseEther("0.02") });
    const moved = (alicePending * 30n) / 60n;
    expect(await campaign.claimedOf(alice.address)).to.equal(alicePending - moved);
    expect(await campaign.claimedOf(bob.address)).to.equal(moved);
    const bobPendingAfterTake = await campaign.pendingBem(bob.address);
    expect(bobPendingAfterTake).to.be.closeTo(bobPendingBefore, 1n);
    await campaign.connect(bob).claim();
    expect(await bem.balanceOf(bob.address)).to.equal(bobPendingAfterTake);
    await bem.mint(await pod.getAddress(), DAILY_BEM);
    await pod.setDailyAmount(DAILY_BEM);
    await campaign.connect(alice).harvest();
    const net = (DAILY_BEM * 9500n) / 10000n;
    expect(await campaign.pendingBem(alice.address)).to.be.closeTo((net * 30n) / 100n, 1n);
    expect(await campaign.pendingBem(bob.address)).to.be.closeTo((net * 70n) / 100n, 1n);
  });

  it("cannot list while funding", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(10n, { value: SHARE_PRICE * 10n });
    await expect(campaign.connect(alice).listShares(1n, SHARE_PRICE)).to.be.revertedWithCustomError(campaign, "WrongScene");
  });
});

describe("harvest / claim", () => {
  it("harvest distributes; claim is per-address", async () => {
    const { campaign, bem, alice, bob, feeRecipient } = await miningFixture();
    await expect(campaign.connect(alice).harvest()).to.emit(campaign, "Harvested");
    expect(await campaign.harvestCount()).to.equal(1n);
    const fee = (DAILY_BEM * 500n) / 10000n;
    const net = DAILY_BEM - fee;
    const alicePending = await campaign.pendingBem(alice.address);
    const bobPending = await campaign.pendingBem(bob.address);
    expect(alicePending).to.equal((net * 60n) / 100n);
    expect(bobPending).to.equal((net * 40n) / 100n);
    expect(alicePending + bobPending).to.be.closeTo(net, 10n);
    expect(await bem.balanceOf(feeRecipient.address)).to.equal(fee);
    await campaign.connect(alice).claim();
    expect(await bem.balanceOf(alice.address)).to.equal(alicePending);
    expect(await campaign.pendingBem(alice.address)).to.equal(0n);
    expect(await campaign.pendingBem(bob.address)).to.equal(bobPending);
    await expect(campaign.connect(alice).claim()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("splits service fee across recipients; remainder to owner", async () => {
    const { campaign, bem, alice, bob, carol, owner, feeRecipient } = await miningFixture();
    await campaign.connect(owner).setFeeShares(
      [feeRecipient.address, carol.address],
      [6000, 4000]
    );
    const feeBeforeOwner = await bem.balanceOf(owner.address);
    const feeBeforeA = await bem.balanceOf(feeRecipient.address);
    const feeBeforeC = await bem.balanceOf(carol.address);
    await expect(campaign.connect(alice).harvest()).to.emit(campaign, "FeeDistributed");
    const fee = (DAILY_BEM * 500n) / 10000n;
    const partA = (fee * 6000n) / 10000n;
    const partC = (fee * 4000n) / 10000n;
    const rem = fee - partA - partC;
    expect(await bem.balanceOf(feeRecipient.address)).to.equal(feeBeforeA + partA);
    expect(await bem.balanceOf(carol.address)).to.equal(feeBeforeC + partC);
    expect(await bem.balanceOf(owner.address)).to.equal(feeBeforeOwner + rem);
    void bob;
  });

  it("rejects fee shares that do not sum to 10000", async () => {
    const { campaign, owner, feeRecipient, carol } = await miningFixture();
    await expect(
      campaign.connect(owner).setFeeShares([feeRecipient.address, carol.address], [5000, 4000])
    ).to.be.revertedWithCustomError(campaign, "BadFeeShares");
  });

  it("rejects fee shares that are not whole percents", async () => {
    const { campaign, owner, feeRecipient, carol } = await miningFixture();
    await expect(
      campaign.connect(owner).setFeeShares([feeRecipient.address, carol.address], [3333, 6667])
    ).to.be.revertedWithCustomError(campaign, "BadFeeShares");
  });

  it("unlimited harvest rounds", async () => {
    const { campaign, alice, pod, bem } = await miningFixture();
    for (let i = 0; i < 5; i++) {
      await bem.mint(await pod.getAddress(), DAILY_BEM);
      await pod.setDailyAmount(DAILY_BEM);
      await campaign.connect(alice).harvest();
    }
    expect(await campaign.harvestCount()).to.equal(5n);
    const net = DAILY_BEM - (DAILY_BEM * 500n) / 10000n;
    expect(await campaign.pendingBem(alice.address)).to.equal((net * 5n * 60n) / 100n);
  });

  it("dailyBem matches Emission", async () => {
    const { campaign } = await miningFixture();
    expect(await campaign.dailyBem()).to.equal(DAILY_BEM);
  });

  it("accounts a smaller pull instead of reverting", async () => {
    const { campaign, alice, pod } = await miningFixture();
    const half = DAILY_BEM / 2n;
    await pod.setDailyAmount(half);
    await campaign.connect(alice).harvest();
    const fee = (half * 500n) / 10000n;
    expect(await campaign.totalDistributed()).to.equal(half - fee);
    expect(await campaign.pendingBem(alice.address)).to.equal(((half - fee) * 60n) / 100n);
  });

  it("credits surplus when PoD pays more than the daily estimate", async () => {
    const { campaign, alice, pod, bem } = await miningFixture();
    const extra = DAILY_BEM * 3n;
    await bem.mint(await pod.getAddress(), extra);
    await pod.setDailyAmount(extra);
    await campaign.connect(alice).harvest();
    const fee = (extra * 500n) / 10000n;
    const net = extra - fee;
    expect(await campaign.totalDistributed()).to.equal(net);
    expect(await campaign.pendingBem(alice.address)).to.equal((net * 60n) / 100n);
  });

  it("NoEmission when PoD pays nothing", async () => {
    const { campaign, alice, pod } = await miningFixture();
    await pod.setDailyAmount(0);
    await expect(campaign.connect(alice).harvest()).to.be.revertedWithCustomError(campaign, "NoEmission");
  });

  it("owner can recover transistors held by the campaign", async () => {
    const parts = await ethers.deployContract("MockERC1155");

    // Listed / Ready: order is live ? recovering would strip parts needed for confirm/execute.
    const live = await loadFixture(deployFixture);
    await live.campaign.connect(live.alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await live.campaign.connect(live.bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await live.campaign.connect(live.owner).setPlan(408n, false, 100n);
    await place(live.campaign, live.owner, 100n, UNIT);
    await parts.mint(await live.campaign.getAddress(), 0, 3n);
    await expect(live.campaign.connect(live.owner).recoverTransistors(await parts.getAddress(), 0, 1n))
      .to.be.revertedWithCustomError(live.campaign, "AlreadyListed");
    await live.minter.fillBid(await live.campaign.nandBidId(), await live.campaign.nandQty());
    await live.parts.mint(await live.campaign.getAddress(), 0, await live.campaign.nandQty());
    await live.campaign.confirmTransistors();
    await expect(live.campaign.connect(live.owner).recoverTransistors(await parts.getAddress(), 0, 1n))
      .to.be.revertedWithCustomError(live.campaign, "AlreadyReady");

    const { campaign, owner, alice } = await miningFixture();
    // miningFixture reverts to the deploy snapshot, so mint on a token deployed after it.
    const held = await ethers.deployContract("MockERC1155");
    await held.mint(await campaign.getAddress(), 0, 7n);
    await held.mint(await campaign.getAddress(), 1, 2n);

    await expect(campaign.connect(alice).recoverTransistors(await held.getAddress(), 0, 7n))
      .to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(owner).recoverTransistors(ethers.ZeroAddress, 0, 1n))
      .to.be.revertedWithCustomError(campaign, "ZeroAddress");
    await expect(campaign.connect(owner).recoverTransistors(await held.getAddress(), 0, 0))
      .to.be.revertedWithCustomError(campaign, "ZeroShares");

    const scene = await campaign.scene();
    await expect(campaign.connect(owner).recoverTransistors(await held.getAddress(), 0, 7n))
      .to.emit(campaign, "TransistorsRecovered")
      .withArgs(await held.getAddress(), 0, 7n, owner.address);
    await campaign.connect(owner).recoverTransistors(await held.getAddress(), 1, 2n);

    expect(await held.balanceOf(owner.address, 0)).to.equal(7n);
    expect(await held.balanceOf(owner.address, 1)).to.equal(2n);
    expect(await held.balanceOf(await campaign.getAddress(), 0)).to.equal(0n);
    expect(await campaign.scene()).to.equal(scene);
  });

  it("owner can recover leftover BNB in mining; funding keeps raised escrow", async () => {
    const leftover = ethers.parseEther("0.05");

    const funded = await loadFixture(deployFixture);
    await funded.campaign.connect(funded.alice).subscribe(10n, { value: 10n * SHARE_PRICE });
    expect(await funded.campaign.raisedBnb()).to.equal(10n * SHARE_PRICE);
    await expect(funded.campaign.connect(funded.owner).recoverBnb(SHARE_PRICE))
      .to.be.revertedWithCustomError(funded.campaign, "WrongScene");

    const { campaign, owner, alice } = await miningFixture();
    await expect(campaign.connect(alice).recoverBnb(1n)).to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(owner).recoverBnb(0)).to.be.revertedWithCustomError(campaign, "ZeroShares");

    // receive() only credits raisedBnb when msg.sender is the material market.
    await campaign.connect(owner).setMinter(alice.address);
    await alice.sendTransaction({ to: await campaign.getAddress(), value: leftover });
    expect(await campaign.raisedBnb()).to.equal(leftover);

    await expect(campaign.connect(owner).recoverBnb(leftover))
      .to.emit(campaign, "BnbRecovered")
      .withArgs(leftover, owner.address);
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
  });
});

const OFFICIAL_H = 3n;
const OFFICIAL_DAILY = (OFFICIAL_H * 7200n * 10n ** 18n * 9900n) / (10000n * 1_579_178n);

function officialStartData() {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint32", "uint256", "bytes[]", "bytes[]", "bytes32[][]", "bytes32"],
    [TT, 1, 4, 0, [], [], [], ethers.ZeroHash]
  );
}

describe("OfficialPodAdapter", () => {
  async function readyFixture() {
    const ctx = await deployFixture();
    const { campaign, alice, bob, owner, bem } = ctx;
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n, false, 100n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, ctx.minter);
    const official = await ethers.deployContract("MockOfficialPoD", [await bem.getAddress()]);
    const adapter = await ethers.deployContract("OfficialPodAdapter", [
      await official.getAddress(),
      await bem.getAddress(),
    ]);
    await campaign.connect(owner).setPod(await adapter.getAddress());
    return { ...ctx, official, adapter };
  }

  it("starts as the campaign when it owns the circuit, even with zero transistors", async () => {
    const { campaign, official, owner } = await loadFixture(readyFixture);
    expect(await official.transistorBalance(await campaign.getAddress())).to.equal(0n);
    await official.setCircuitOwner(await campaign.getAddress(), true);

    await campaign.connect(owner).execute(RAW_NETLIST, officialStartData());

    expect(await campaign.scene()).to.equal(SCENE.Mining);
    expect(await campaign.hashpower()).to.equal(OFFICIAL_H);
    expect(await official.lastCaller()).to.equal(await campaign.getAddress());
  });

  it("rejects the campaign when it only holds transistors and does not own the circuit", async () => {
    const { campaign, official, owner } = await loadFixture(readyFixture);
    await official.setTransistorBalance(await campaign.getAddress(), 1000n);
    await official.setCircuitOwner(await campaign.getAddress(), false);

    await expect(campaign.connect(owner).execute(RAW_NETLIST, officialStartData())).to.be.revertedWithCustomError(
      official,
      "Ownr"
    );
    expect(await campaign.scene()).to.equal(SCENE.Executing);
  });

  it("harvest pulls official rewards through the campaign", async () => {
    const { campaign, official, bem, owner, alice } = await loadFixture(readyFixture);
    await official.setCircuitOwner(await campaign.getAddress(), true);
    await campaign.connect(owner).execute(RAW_NETLIST, officialStartData());
    await bem.mint(await official.getAddress(), OFFICIAL_DAILY);
    await official.setClaimAmount(OFFICIAL_DAILY);

    await campaign.connect(alice).harvest();

    expect(await official.lastCaller()).to.equal(await campaign.getAddress());
    expect(await campaign.harvestCount()).to.equal(1n);
    expect(await bem.balanceOf(await campaign.getAddress())).to.equal(OFFICIAL_DAILY - (OFFICIAL_DAILY * 500n) / 10000n);
  });

  it("accepts a circuit NFT via onERC721Received", async () => {
    const { campaign, owner } = await loadFixture(readyFixture);
    const nft = await ethers.deployContract("MockERC721");
    await nft.mint(owner.address, 42n);
    await nft.connect(owner).safeTransferFrom(owner.address, await campaign.getAddress(), 42n, "0x");
    expect(await nft.ownerOf(42n)).to.equal(await campaign.getAddress());
  });
});
