const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const SHARE_PRICE = ethers.parseEther("0.01");
const TOTAL_SHARES = 100n;
const FUNDING_DAYS = 7;
// createCampaign 收 seconds，不是 days：单位换算由调用方做，工厂不再乘 1 days。
const FUNDING_SECONDS = FUNDING_DAYS * 24 * 60 * 60;
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

// 工厂构造只传 [materialMarket, allowedParts]，两者都是 immutable；开期只传 sharePriceBnb / totalShares / fundingSeconds / transistors(必选)。
// 流片 / PoD / BEM 挖矿已移除：元件合约由开期显式指定，相关 mock（MockBEM / MockPoD / MockMinter / MockERC721）已删除。
async function deployFixture() {
  const [owner, alice, bob, carol, feeRecipient] = await ethers.getSigners();
  const minter = await ethers.deployContract("MockMaterialMarket");
  const parts = await ethers.deployContract("MockERC1155");
  // 工厂构造：[materialMarket, allowedParts 白名单]。
  // 白名单是安全边界：主网上只放官方两件套（TapeOut / Behemoth）的元件合约，测试网放 mock。
  // 工厂不再有「默认元件」：开期时 createCampaign 第 4 参 transistors_ 必须显式传入且非零。
  const factory = await ethers.deployContract("CampaignFactory", [
    await minter.getAddress(),
    [await parts.getAddress()],
  ]);
  await factory.connect(owner).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await parts.getAddress());
  const campaign = await ethers.getContractAt("Campaign", await factory.campaigns(0));
  return { minter, parts, factory, campaign, owner, alice, bob, carol, feeRecipient };
}

// 进入 Mining：认购 → 设计划 → 下单 → 成交确认 → 设矿池 → 打入矿池（不可逆）。
// 取代旧的 miningFixture（原靠 execute() 到达 Mining，execute 已删除）。
async function pooledFixture() {
  const ctx = await loadFixture(deployFixture);
  const { campaign, alice, bob, owner, minter } = ctx;
  await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
  await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
  expect(await campaign.scene()).to.equal(SCENE.Executing);
  await campaign.connect(owner).setPlan(408n);
  await place(campaign, owner, 100n, UNIT);
  await fillAndConfirm(campaign, minter);
  const pool = await ethers.deployContract("MockERC1155");
  await pool.waitForDeployment();
  await campaign.connect(owner).setMiningPool(await pool.getAddress());
  await campaign.connect(owner).depositToPool();
  expect(await campaign.scene()).to.equal(SCENE.Mining);
  expect(await campaign.pooled()).to.equal(true);
  return ctx;
}

describe("escrow can never be stranded", () => {
  it("abandonOrder hands the parts over only once every holder is settled", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    const rejector = await ethers.deployContract("Rejector");
    const rAddr = await rejector.getAddress();
    await rejector.subscribe(await campaign.getAddress(), 40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);

    // 拒收方退款失败、份额保留 → 元件是他们的抵押，不能先给 Owner。
    await rejector.reject();
    await campaign.connect(owner).abandonOrder();
    expect(await campaign.outstandingShares()).to.equal(40n);
    expect(await parts.balanceOf(owner.address, 0)).to.equal(0n);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(1n);

    // 拒收方自己 pull 领回本金后，再跑一次才把剩余元件交出去。
    await rejector.accept();
    await rejector.refundFrom(await campaign.getAddress());
    expect(await campaign.outstandingShares()).to.equal(0n);
    await campaign.connect(owner).abandonOrder();
    expect(await parts.balanceOf(owner.address, 0)).to.equal(1n);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(0n);
  });

  it("Ready cannot be turned into a refund state, so the parts stay with the holders", async () => {
    // Ready 不是失败态：晶体管已经买回来了。若能 markFailed → refund，持份人只拿回剩余 BNB
    // 就丢掉元件申索，owner 拿走元件 = 掏空。
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);

    await expect(campaign.connect(owner).markFailed()).to.be.revertedWithCustomError(campaign, "UseReturnSurplus");
    // 超过宽限期，第三方也不能把 Ready 期次标成失败。
    await time.increase(4 * 24 * 60 * 60);
    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(campaign, "UseReturnSurplus");
    // 持份人的申索没被抹掉。
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
    expect(await campaign.sharesOf(alice.address)).to.equal(100n);
  });

  it("abandonOrder pays the refund and hands the leftover parts to the owner", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);

    await campaign.connect(owner).abandonOrder();
    expect(await parts.balanceOf(owner.address, 0)).to.equal(1n);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(0n);
    // Sale 99/100 pro-rata: the holder gets 0.99 back and keeps nothing on the book.
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    // outstandingShares（已售未退）归零 = 没有待退份额了。
    // sold 是单调的历史事实，退款不会让它变小（H-1 后半：退款不能剥夺 owner 的下单资格）。
    expect(await campaign.outstandingShares()).to.equal(0n);
    expect(await campaign.sold()).to.equal(100n);
    expect(await campaign.raisedBnb()).to.equal(0n);
  });

  it("markFailed opens refund() when a short pool has no owner around", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await campaign.connect(alice).cancelTransistorOrder();

    // Non-owner markFailed is locked for FAIL_GRACE (3 days) after the sell-out.
    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
    await time.increase(3 * 24 * 3600);
    await campaign.connect(alice).markFailed();
    await expect(campaign.connect(alice).refund()).to.emit(campaign, "Refunded");
    expect(await campaign.raisedBnb()).to.equal(0n);
  });

  it("non-owner markFailed cancels the untouched bid so the escrow returns", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);

    const bidId = await campaign.nandBidId();
    expect(await campaign.phase()).to.equal(PHASE.Listed);
    // 买单托管已从 raisedBnb 扣走，此时池子是「不足」的。
    expect(await campaign.raisedBnb()).to.be.lessThan(100n * SHARE_PRICE);

    // 宽限期内非 Owner 仍然不能杀期，也不能撤单。
    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
    await expect(campaign.connect(alice).cancelTransistorOrder()).to.be.revertedWithCustomError(campaign, "NotOwner");

    await time.increase(3 * 24 * 3600);
    // 逃生口：markFailed 先把未成交的买单撤掉，押金退回 raisedBnb，退款口径不变。
    await expect(campaign.connect(alice).markFailed()).to.emit(campaign, "TransistorOrderCancelled");
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE);
    expect(await campaign.nandQty()).to.equal(0n);
    await expect(campaign.connect(alice).refund()).to.emit(campaign, "Refunded");
  });

  it("markFailed leaves the round failed and retryable when the market refuses the cancel", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);

    // 市场拒绝撤单：整笔回滚，期次不会被判失败，恢复后可以重试，避免托管被永远留在市场里。
    await minter.setBlockCancel(true);
    await time.increase(3 * 24 * 3600);
    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(minter, "BadBid");
    expect(await campaign.executionFailed()).to.equal(false);
    expect(await campaign.phase()).to.equal(PHASE.Listed);

    await minter.setBlockCancel(false);
    await campaign.connect(alice).markFailed();
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE);
    await expect(campaign.connect(alice).refund()).to.emit(campaign, "Refunded");
  });

  it("a single holder cannot kill a healthy round inside the grace window", async () => {
    const { campaign, owner, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    await campaign.connect(bob).subscribe(99n, { value: 99n * SHARE_PRICE });

    await expect(campaign.connect(alice).markFailed()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
    expect(await campaign.sold()).to.equal(TOTAL_SHARES);

    // The owner may still mark at any time (this is how openRefund / abandonOrder work).
    await campaign.connect(owner).markFailed();
    expect(await campaign.executionFailed()).to.equal(true);
  });

  it("anyone may cancel an untouched bid once the factory drops the round", async () => {
    const { campaign, factory, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);

    await expect(campaign.connect(alice).cancelTransistorOrder()).to.be.revertedWithCustomError(
      campaign,
      "NotOwner",
    );
    expect(await factory.isRegistered(await campaign.getAddress())).to.equal(true);
    await factory.connect(owner).removeCampaign(0);
    expect(await factory.isRegistered(await campaign.getAddress())).to.equal(false);

    await campaign.connect(alice).cancelTransistorOrder();
    expect(await campaign.raisedBnb()).to.equal(100n * SHARE_PRICE);
    expect(await campaign.phase()).to.equal(1n); // Buying
  });
});

describe("CampaignFactory", () => {
  it("only Factory Owner can create", async () => {
    const { factory, alice, parts } = await loadFixture(deployFixture);
    await expect(
      factory.connect(alice).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await parts.getAddress()),
    ).to.be.revertedWithCustomError(factory, "NotOwner");
  });

  it("stores campaigns and increments count", async () => {
    const { factory, owner, parts } = await loadFixture(deployFixture);
    expect(await factory.campaignCount()).to.equal(1n);
    const tx = factory
      .connect(owner)
      .createCampaign(SHARE_PRICE, 50n, FUNDING_SECONDS, await parts.getAddress());
    await tx;
    expect(await factory.campaignCount()).to.equal(2n);
    const first = await factory.campaigns(0);
    const second = await factory.campaigns(1);
    expect(second).to.not.equal(first);
    // 事件带上 fundingDeadline，索引器不必回读 Campaign。
    const deadline = await (await ethers.getContractAt("Campaign", second)).fundingDeadline();
    await expect(tx)
      .to.emit(factory, "CampaignCreated")
      .withArgs(1n, second, SHARE_PRICE, 50n, deadline);
    // 元件合约由开期显式指定，写入后不可改（Campaign.transistors 是 immutable）。
    expect(await (await ethers.getContractAt("Campaign", second)).transistors()).to.equal(
      await parts.getAddress(),
    );
  });

  it("createCampaign reverts on a zero transistors address", async () => {
    const { factory, owner } = await loadFixture(deployFixture);
    await expect(
      factory.connect(owner).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("fundingSeconds is added verbatim, and the deadline is reported in the event", async () => {
    const { factory, owner, parts } = await loadFixture(deployFixture);
    const now = BigInt(await time.latest());
    // 90 秒：若工厂还在乘 1 days，截止时间会落在 90 天后，这里会立刻暴露。
    await factory.connect(owner).createCampaign(SHARE_PRICE, 10n, 90n, await parts.getAddress());
    const c = await ethers.getContractAt("Campaign", await factory.campaigns(1));
    const deadline = await c.fundingDeadline();
    expect(deadline).to.be.greaterThan(now + 80n);
    expect(deadline).to.be.lessThan(now + 200n);
  });

  it("factory materialMarket is immutable; ownership still transfers", async () => {
    const { factory, owner, alice, minter } = await loadFixture(deployFixture);
    expect(await factory.materialMarket()).to.equal(await minter.getAddress());
    // 工厂没有 setter：materialMarket 是 immutable，白名单部署时写入不可改。
    const names = factory.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    expect(names).to.not.include("setMinter");
    expect(names).to.not.include("setMaterialMarket");
    expect(names).to.not.include("setDefaultTransistors");
    await factory.connect(owner).transferOwnership(alice.address);
    expect(await factory.owner()).to.equal(alice.address);
  });

  it("Owner can update campaign material market", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    const otherMinter = await (await ethers.deployContract("MockMaterialMarket")).getAddress();
    await expect(campaign.connect(alice).setMaterialMarket(otherMinter)).to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(owner).setMaterialMarket(otherMinter))
      .to.emit(campaign, "MaterialMarketUpdated");
    expect(await campaign.materialMarket()).to.equal(otherMinter);
    await campaign.connect(owner).setMaterialMarket(await minter.getAddress());
    expect(await campaign.materialMarket()).to.equal(await minter.getAddress());
  });

  it("a market swap drains the proceeds the old market still owes", async () => {
    // owed() 是按市场记账的：不先提走，换市场后那笔钱就再也取不回来了。
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.confirmTransistors();
    const askPrice = ethers.parseEther("0.02");
    await campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0);
    await minter.connect(bob).fillAsk(await campaign.nandAskId(), 1n, { value: askPrice });
    expect(await minter.owed(await campaign.getAddress())).to.equal(askPrice);
    const escrowBefore = await campaign.raisedBnb();

    const otherMarket = await (await ethers.deployContract("MockMaterialMarket")).getAddress();
    await expect(campaign.connect(owner).setMaterialMarket(otherMarket))
      .to.emit(campaign, "MaterialMarketUpdated");
    // 卖出款先被提回托管池，没有留在旧市场。
    expect(await minter.owed(await campaign.getAddress())).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(escrowBefore + askPrice);
    expect(await campaign.materialMarket()).to.equal(otherMarket);
  });

  it("a market that cannot pay does not block the swap", async () => {
    // 旧市场报欠款却付不出来时，禁止换市场 = 把本期一起锁死。放行才是逃生。
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.confirmTransistors();
    const askPrice = ethers.parseEther("0.02");
    await campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0);
    await minter.connect(bob).fillAsk(await campaign.nandAskId(), 1n, { value: askPrice });

    // 把市场的 withdraw 打瘫（测试开关）：它仍报欠款，但付不出来。
    await minter.setBlockWithdraw(true);
    expect(await minter.owed(await campaign.getAddress())).to.equal(askPrice);
    const otherMarket = await (await ethers.deployContract("MockMaterialMarket")).getAddress();
    // 禁止换市场就等于把本期一起锁死；必须放行，欠款留在旧市场。
    await expect(campaign.connect(owner).setMaterialMarket(otherMarket))
      .to.emit(campaign, "MaterialMarketUpdated");
    expect(await campaign.materialMarket()).to.equal(otherMarket);
    expect(await minter.owed(await campaign.getAddress())).to.equal(askPrice);
  });

  it("Owner can remove campaign from registry without destroying it", async () => {
    const { factory, owner, alice, feeRecipient, campaign, parts } = await loadFixture(deployFixture);
    const first = await factory.campaigns(0);
    await factory
      .connect(owner)
      .createCampaign(SHARE_PRICE, 50n, FUNDING_SECONDS, await parts.getAddress());
    const second = await factory.campaigns(1);
    expect(await factory.campaignCount()).to.equal(2n);

    await expect(factory.connect(alice).removeCampaign(0)).to.be.revertedWithCustomError(factory, "NotOwner");
    await expect(factory.connect(owner).removeCampaign(9)).to.be.revertedWithCustomError(factory, "IndexOutOfBounds");

    // indexOf 已删除：按地址查索引改为遍历 campaigns(0..count)，这也正是前端的做法。
    const indexOf = async (addr) => {
      const n = Number(await factory.campaignCount());
      for (let i = 0; i < n; i++) if ((await factory.campaigns(i)) === addr) return i;
      return -1;
    };
    expect(await indexOf(second)).to.equal(1);
    await expect(factory.connect(owner).removeCampaign(0))
      .to.emit(factory, "CampaignRemoved");
    expect(await factory.campaignCount()).to.equal(1n);
    expect(await factory.campaigns(0)).to.equal(second);

    // Registry only: original Campaign bytecode remains
    expect(await ethers.provider.getCode(first)).to.not.equal("0x");
    expect(await campaign.getAddress()).to.equal(first);
    expect(await campaign.scene()).to.equal(0); // Funding
    // 已移除的地址遍历不到，返回 -1。
    expect(await indexOf(first)).to.equal(-1);
  });
});

describe("funding subscribe", () => {
  it("requires exact payment and no oversell", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE - 1n })).to.be.revertedWithCustomError(campaign, "WrongPayment");
    await expect(campaign.connect(alice).subscribe(0n, { value: 0 })).to.be.revertedWithCustomError(campaign, "ZeroShares");
    await campaign.connect(alice).subscribe(10n, { value: SHARE_PRICE * 10n });
    expect(await campaign.holderCount()).to.equal(1n);
    expect(await campaign.holderAt(0)).to.equal(alice.address);
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
      "DirectTransferNotAllowed",
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

  it("mining cannot refund (pooled is irreversible)", async () => {
    const { campaign, alice } = await pooledFixture();
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
  });
});

describe("transistor order + deposit to pool", () => {
  it("phase machine and auth", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
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
      "TransistorsNotReady",
    );
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);
  });

  it("depositToPool requires Ready, a set pool, and returns surplus pro-rata", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);

    const cost = 100n * UNIT;
    const surplus = SHARE_PRICE * 100n - cost;
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();

    // 未设矿池：PoolNotSet
    await expect(campaign.connect(owner).depositToPool()).to.be.revertedWithCustomError(campaign, "PoolNotSet");
    await campaign.connect(owner).setMiningPool(await pool.getAddress());

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    // C-4：余款改 pull 模式 —— 入池时不再遍历持份人转账，只记录基准（surplusPool / surplusBase）。
    // 所以入池这一步没有 Refunded 事件，持份人自己调 claimSurplus() 才拿得到钱。
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await campaign.scene()).to.equal(SCENE.Mining);
    expect(await campaign.pooled()).to.equal(true);
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.surplusPool()).to.equal(surplus);
    expect(await campaign.surplusBase()).to.equal(100n);
    // 入池时没有钱到账，余额不变；领取时才到账。
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(0n);
    await expect(campaign.connect(alice).claimSurplus())
      .to.emit(campaign, "SurplusClaimed")
      .withArgs(alice.address, surplus);
    // 领取时 alice 自己付 gas，所以余额差 = 到账额 − gas。用 gas 还原真实到账额。
    const aliceAfter = await ethers.provider.getBalance(alice.address);
    expect(aliceAfter).to.be.lt(aliceBefore + surplus);
    expect(aliceAfter).to.be.gt(aliceBefore + surplus - ethers.parseEther("0.01"));
    // 元件已转入矿池：余额记录在 transistors 合约上、归 miningPool 所有。
    const partsC = await ethers.getContractAt("MockERC1155", await campaign.transistors());
    expect(await partsC.balanceOf(await pool.getAddress(), 0)).to.equal(100n);
    expect(await partsC.balanceOf(await campaign.getAddress(), 0)).to.equal(0n);
  });

  it("depositToPool is irreversible: refund / recover / abandon are all closed", async () => {
    const { campaign, owner, minter, alice } = await pooledFixture();
    await expect(campaign.connect(owner).recoverTransistors(await campaign.transistors(), 0, 1n))
      .to.be.revertedWithCustomError(campaign, "AlreadyPooled");
    await expect(campaign.connect(alice).refund()).to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
  });

  it("a late market credit after pooling is booked as surplus instead of being stranded", async () => {
    const { campaign, alice, minter } = await loadFixture(pooledFixture);
    const late = ethers.parseEther("0.02");
    await minter.creditOwed(await campaign.getAddress(), late, { value: late });
    expect(await minter.owed(await campaign.getAddress())).to.equal(late);
    const poolBefore = await campaign.surplusPool();

    // Anyone may pull it; receive() books it for holders because pooling closed the refund paths.
    await campaign.connect(alice).withdrawMarketProceeds();
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.surplusPool()).to.equal(poolBefore + late);
    expect(await campaign.surplusOf(alice.address)).to.be.greaterThan(0n);
    await expect(campaign.connect(alice).claimSurplus()).to.emit(campaign, "SurplusClaimed");
  });

  it("a holder that rejects BNB keeps a claimable surplus instead of losing it forever", async () => {
    // H-2 回归 + C-4：入池时 _returnSurplus 不再遍历持份人推款（改 pull 模式），
    // 所以「转账失败」的场景从入池时转移到了**持份人自己领取时**。
    // 现在：领取失败 → 整笔交易回滚，金额原样留在 pendingSurplus 里，持份人可重试；
    // owner 也扫不走（recoverBnb 会预留 surplusPool − surplusPaid）。
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    const rejector = await ethers.deployContract("Rejector");
    const rAddr = await rejector.getAddress();

    // alice 认购 60 份，rejector 认购 40 份。
    await campaign.connect(alice).subscribe(60n, { value: SHARE_PRICE * 60n });
    await rejector.subscribe(await campaign.getAddress(), 40n, { value: SHARE_PRICE * 40n });
    expect(await campaign.sharesOf(rAddr)).to.equal(40n);

    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);

    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());

    const cost = 100n * UNIT;
    const totalRaised = SHARE_PRICE * 100n;
    const surplus = totalRaised - cost;

    // 入池：不再遍历持份人，只记录余款基准。
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await campaign.surplusPool()).to.equal(surplus);
    expect(await campaign.surplusBase()).to.equal(100n);

    // rejector 的应得余款 = surplus × 40/100
    const rShare = (surplus * 40n) / 100n;
    expect(await campaign.surplusOf(rAddr)).to.equal(rShare);
    // 这笔钱不能被 owner 扫走
    await expect(campaign.connect(owner).recoverBnb())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");

    // 还在拒收 → claimSurplus 回滚，金额未发出、可重试
    await expect(rejector.claimSurplusFrom(await campaign.getAddress()))
      .to.be.revertedWithCustomError(campaign, "TransferFailed");
    expect(await campaign.surplusOf(rAddr)).to.equal(rShare);
    expect(await campaign.pendingSurplus(rAddr)).to.equal(0n);

    // 打开接收 → 领取成功
    await rejector.accept();
    const before = await ethers.provider.getBalance(rAddr);
    await expect(rejector.claimSurplusFrom(await campaign.getAddress())).to.emit(campaign, "SurplusClaimed");
    expect(await ethers.provider.getBalance(rAddr) - before).to.equal(rShare);
    expect(await campaign.pendingSurplus(rAddr)).to.equal(0n);
    expect(await campaign.totalPendingSurplus()).to.equal(0n);

    // 没有余款可领时 revert
    await expect(rejector.claimSurplusFrom(await campaign.getAddress()))
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("unaffordable place marks failed without escrowing", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await expect(place(campaign, owner, 100n, ethers.parseEther("0.02"))).to.emit(campaign, "ExecutionFailed");
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.executionFailed()).to.equal(true);
    expect(await campaign.raisedBnb()).to.equal(SHARE_PRICE * 100n);
    // Buying 态不能 confirm
    await expect(campaign.connect(owner).confirmTransistors()).to.be.revertedWithCustomError(campaign, "NotListed");
    // 正常下单进入 Listed，未成交时 confirm 才报 TransistorsNotReady
    await place(campaign, owner, 100n, UNIT);
    await expect(campaign.connect(owner).confirmTransistors()).to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    expect(await campaign.executionFailed()).to.equal(false);
    await fillAndConfirm(campaign, minter);
    // fillAndConfirm 已经 confirm 过一次：in Require(Ready) 保证此时 phase 已是 Ready。
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    await expect(campaign.connect(owner).confirmTransistors()).to.be.revertedWithCustomError(campaign, "AlreadyReady");
  });

  it("unaffordable then user refund", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
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
    await campaign.connect(owner).setPlan(408n);
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
      (pool * 60n) / 100n,
    );
    await campaign.connect(bob).refund();
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.sharesOf(bob.address)).to.equal(0n);
  });

  it("deliverBidAll fills the bid and mints the parts to the buyer", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);

    await expect(minter.deliverBidAll(await campaign.nandBidId()))
      .to.emit(minter, "BidFilled");

    expect(await campaign.nandQty()).to.equal(1n);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(1n);
    await expect(campaign.connect(owner).confirmTransistors()).to.emit(campaign, "TransistorsConfirmed");
    expect(await campaign.phase()).to.equal(PHASE.Ready);
  });

  it("emits bid and ask events so the frontend can rebuild the trade log", async () => {
    const { campaign, owner, alice, bob, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);

    await expect(place(campaign, owner, 1n, UNIT)).to.emit(minter, "BidPlaced");
    await minter.deliverBidAll(await campaign.nandBidId());
    await campaign.confirmTransistors();

    const askPrice = ethers.parseEther("0.03");
    await expect(campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0)).to.emit(minter, "AskPlaced");
    await expect(minter.connect(bob).fillAsk(await campaign.nandAskId(), 1n, { value: askPrice }))
      .to.emit(minter, "AskFilled");
    await expect(campaign.connect(owner).confirmSale()).to.emit(minter, "ProceedsWithdrawn");
  });

  it("asks are refused until the buy is confirmed, then a sale must be confirmed before the next bid", async () => {
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: SHARE_PRICE * 60n });
    await campaign.connect(bob).subscribe(40n, { value: SHARE_PRICE * 40n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    const askPrice = ethers.parseEther("0.03");
    await expect(campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");

    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.connect(alice).cancelTransistorOrder();
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    await expect(campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");

    await place(campaign, owner, 1n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.confirmTransistors();
    await expect(campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0))
      .to.emit(campaign, "TransistorAskPlaced");
    // 未设矿池时先撞 PoolNotSet；设好后可以入池（合约自持的 parts 未动，只是挂单在市场上）。
    await expect(campaign.connect(owner).depositToPool()).to.be.revertedWithCustomError(campaign, "PoolNotSet");
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await campaign.scene()).to.equal(SCENE.Mining);
  });

  it("buy can be placed again after a prior ask fully sold", async () => {
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.confirmTransistors();
    const askPrice = ethers.parseEther("0.02");
    await campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0);
    await minter.connect(bob).fillAsk(await campaign.nandAskId(), 1n, { value: askPrice });
    await expect(campaign.connect(owner).placeTransistorOrder(1n, UNIT, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "WrongScene");
    await campaign.connect(owner).confirmSale();
    await place(campaign, owner, 1n, UNIT);
    expect(await campaign.phase()).to.equal(PHASE.Listed);
  });

  it("placeAsk returning id 0 reverts instead of unlocking a second order", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.confirmTransistors();
    await minter.setReturnZeroAsk(true);
    await expect(campaign.connect(owner).placeTransistorAsk(1n, UNIT, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "BadAskId");
    expect(await campaign.phase()).to.equal(PHASE.Ready);
  });

  it("fully filled ask can be cleared without touching the market", async () => {
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.confirmTransistors();
    const askPrice = ethers.parseEther("0.02");
    await campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0);
    await minter.connect(bob).fillAsk(await campaign.nandAskId(), 1n, { value: askPrice });
    await campaign.connect(owner).confirmSale();
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.nandAskQty()).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(SHARE_PRICE * 100n - UNIT + askPrice);
  });

  it("withdrawMarketProceeds pulls ask proceeds into the raise; anyone may call, owed=0 is a no-op", async () => {
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.confirmTransistors();
    const askPrice = ethers.parseEther("0.02");
    await campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0);
    await minter.connect(bob).fillAsk(await campaign.nandAskId(), 1n, { value: askPrice });
    // The market owes the campaign the sale proceeds; they are not in raisedBnb yet.
    expect(await minter.owed(await campaign.getAddress())).to.equal(askPrice);
    const before = await campaign.raisedBnb();
    // Anyone may pull the proceeds, and the money lands in the raise via receive().
    await expect(campaign.connect(bob).withdrawMarketProceeds()).to.emit(minter, "ProceedsWithdrawn");
    expect(await campaign.raisedBnb()).to.equal(before + askPrice);
    expect(await minter.owed(await campaign.getAddress())).to.equal(0n);
    // Nothing owed: the call is a silent no-op, not a revert.
    await expect(campaign.connect(bob).withdrawMarketProceeds()).to.not.be.reverted;
    expect(await campaign.raisedBnb()).to.equal(before + askPrice);
  });

  it("placeTransistorOrder takes no parts address; the locked transistors is always used", async () => {
    // The parts contract is the immutable `transistors`, so it is not an argument any more: a round
    // can never be told to place a bid against a different ERC1155 contract.
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await expect(campaign.connect(owner).placeTransistorOrder(1n, UNIT, 0n, 0))
      .to.be.revertedWithCustomError(campaign, "WrongScene");
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await expect(campaign.connect(owner).placeTransistorOrder(1n, UNIT, 0n, 0))
      .to.emit(campaign, "TransistorOrderPlaced");
    expect(await campaign.phase()).to.equal(PHASE.Listed);
    const bid = await minter.bids(await campaign.nandBidId());
    expect(bid.transistors).to.equal(await campaign.transistors());
  });

  it("leftover parts plus short raise refund pro-rata and leave no stranded BNB", async () => {
    // Bid 100 @ UNIT buy only 1 unit; sell 1 unit but raise is short of 100 × 0.01.
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: SHARE_PRICE * 60n });
    await campaign.connect(bob).subscribe(40n, { value: SHARE_PRICE * 40n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);
    await campaign.connect(alice).cancelTransistorOrder();
    // Raise is 0.995 but principal is 1.0. A partial fill cannot be sold until a later buy is confirmed.
    const pool = SHARE_PRICE * 100n - UNIT;
    expect(await campaign.raisedBnb()).to.equal(pool);
    expect(await campaign.totalRefunded()).to.equal(0n);
    // Short pool: no owner switch needed, each holder pulls pro-rata.
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const r = await tx.wait();
    expect(await ethers.provider.getBalance(alice.address) + r.gasUsed * r.gasPrice - aliceBefore).to.equal((pool * 60n) / 100n);
    await campaign.connect(bob).refund();
    // Pool fully drained: no stranded BNB behind zeroed shares.
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.outstandingShares()).to.equal(0n);
    expect(await campaign.sold()).to.equal(100n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
  });

  it("a pro-rata refund that rounds to 0 still settles the holder instead of locking the dust forever", async () => {
    // 短池下按比例取整可能为 0 wei。原来这时 refund() 直接 revert、份额不清、sold 不减，
    // 于是 sold 永远不归零 → recoverBnb 不敢扫尾差 → 这笔 BNB 被永久锁在合约里。
    // 现在：份额照清、sold 照减，余量留给后面的持份人。
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    // alice 持 1 份、bob 持 99 份。owner 买走 1 颗元件，单价几乎吃掉全部募资款，只剩 1 wei 可分。
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    await campaign.connect(bob).subscribe(99n, { value: SHARE_PRICE * 99n });
    await campaign.connect(owner).setPlan(408n);
    // 单价 0.999999999999999999 BNB：cost = 1e18-1 ≤ 募资 1e18，够下单。
    const nearlyAll = ethers.parseEther("0.999999999999999999");
    await place(campaign, owner, 1n, nearlyAll);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    // 不 mint 元件 → _partsOnHand() 为 false，撤单不会被 OrderFilled 拦。
    await campaign.connect(alice).cancelTransistorOrder();
    // 池子里只剩 1 wei：alice 的 1/100 份额按比例取整为 0。
    const pool = await campaign.raisedBnb();
    expect(pool).to.equal(1n);
    expect(pool / 100n).to.equal(0n);

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const atx = await campaign.connect(alice).refund();
    const ar = await atx.wait();
    await expect(atx).to.emit(campaign, "Refunded").withArgs(alice.address, 0n);
    // 份额被清掉、outstandingShares 减 1 —— 不再是「永远退不出来」的状态。
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.outstandingShares()).to.equal(99n);
    expect(await campaign.sold()).to.equal(100n);
    // alice 没拿到 BNB（比例取整为 0），但她的份额已结清。
    expect(await ethers.provider.getBalance(alice.address) + ar.gasUsed * ar.gasPrice - aliceBefore).to.equal(0n);
    // 余量随 sold 变小而变大：bob 现在能按 1/99 全额拿走这 1 wei。
    const bobBefore = await ethers.provider.getBalance(bob.address);
    const tx = await campaign.connect(bob).refund();
    const r = await tx.wait();
    expect(await ethers.provider.getBalance(bob.address) + r.gasUsed * r.gasPrice - bobBefore).to.equal(1n);
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.outstandingShares()).to.equal(0n);
    expect(await campaign.sold()).to.equal(100n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
  });

  it("refund after fundingDeadline can still drain a sold-out pool", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, ethers.parseEther("0.02")); // over budget: soft-fail, no order
    await time.increase(FUNDING_DAYS * 24 * 3600 + 1);
    await campaign.connect(owner).openRefund();
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(0n);
  });

  it("openRefund pays principal, leaves the excess sweepable, and burns any residual", async () => {
    // 100 shares, bid 10 × UNIT, fill 2, cancel the bid, sell the 2 filled parts at 0.02 each.
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 2n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 2n);
    await parts.mint(await campaign.getAddress(), 0, 2n);
    await campaign.confirmTransistors();
    const askPrice = ethers.parseEther("0.02");
    await campaign.connect(owner).placeTransistorAsk(2n, askPrice, 0n, 0);
    await minter.connect(bob).fillAsk(await campaign.nandAskId(), 2n, { value: askPrice * 2n });
    await campaign.connect(owner).confirmSale();

    const pool = SHARE_PRICE * 100n - UNIT * 2n + askPrice * 2n;
    const needed = SHARE_PRICE * 100n;
    expect(pool).to.be.gt(needed);

    await campaign.connect(owner).openRefund();
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    // Holders only get principal back; the sale premium stays for the owner as excess over raisedBnb.
    expect(await campaign.raisedBnb()).to.equal(pool - needed);
    // After a full refund sold == 0, so the whole balance is entitled to nobody and the premium can be swept.
    await campaign.connect(owner).recoverBnb();
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
    // Every share already left: a second openRefund would refund nobody, so it reverts instead of
    // mining an empty transaction (the UI now offers recoverBnb in that state).
    await expect(campaign.connect(owner).openRefund()).to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("abandonOrder reclaims a cancelable bid and refunds every holder in one call", async () => {
    // Bid 100 @ UNIT, fill 1, then abandon: cancelBid returns 99 × UNIT, the holder gets principal back,
    // and the spent 1 × UNIT is a realised loss for the holders (short pool, pro-rata).
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: SHARE_PRICE * 60n });
    await campaign.connect(bob).subscribe(40n, { value: SHARE_PRICE * 40n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await parts.mint(await campaign.getAddress(), 0, 1n);

    await expect(campaign.connect(alice).abandonOrder()).to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(owner).abandonOrder()).to.emit(campaign, "ExecutionFailed");
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.sharesOf(bob.address)).to.equal(0n);
    expect(await campaign.executionFailed()).to.equal(true);
    // _clearOrder drops ids, quantities and prices together (see Campaign._clearOrder).
    expect(await campaign.nandQty()).to.equal(0n);
    expect(await campaign.nandPrice()).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
    // 1 × UNIT spent on a part nobody needs is not recoverable.
    expect(await campaign.totalRefunded()).to.equal(SHARE_PRICE * 100n - UNIT);
  });

  it("abandonOrder also works straight from a live bid and blocks once Ready", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 10n, UNIT);
    expect(await campaign.phase()).to.equal(PHASE.Listed);
    await campaign.connect(owner).abandonOrder();
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.nandQty()).to.equal(0n);
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);

    // Nothing was spent, so the full pool came back to the holder.
    expect(await campaign.totalRefunded()).to.equal(SHARE_PRICE * 100n);
  });

  it("a filled order with parts on hand cannot be cancelled", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 100n);
    await parts.mint(await campaign.getAddress(), 0, 100n);
    await expect(campaign.connect(owner).cancelTransistorOrder()).to.be.revertedWithCustomError(campaign, "OrderFilled");
    await campaign.confirmTransistors();
    expect(await campaign.phase()).to.equal(PHASE.Ready);
  });

  it("cancelling an order clears the bid ids so no stale order looks live", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 50n, UNIT);
    expect(await campaign.nandBidId()).to.not.equal(0n);
    expect(await campaign.nandQty()).to.equal(50n);
    await campaign.connect(owner).cancelTransistorOrder();
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    // A stale id must not survive: readers gate on id != 0 to show a live order.
    expect(await campaign.nandBidId()).to.equal(0n);
    expect(await campaign.nandQty()).to.equal(0n);
    expect(await campaign.priceLock()).to.equal(0n);
  });

  it("filled book without parts does not confirm, and cancel lets holders take the leftover", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
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
    await campaign.connect(owner).setPlan(408n);
    await minter.setReturnZeroId(true);
    await expect(place(campaign, owner, 100n, UNIT)).to.be.revertedWithCustomError(campaign, "BadBidId");
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await campaign.raisedBnb()).to.equal(SHARE_PRICE * 100n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(SHARE_PRICE * 100n);
  });

  it("Ready: confirmed parts can be listed, and depositToPool enters Mining", async () => {
    const { campaign, owner, alice, bob, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);

    // Before this change Ready could only execute / refund / recover: the sell path was unreachable.
    const askPrice = ethers.parseEther("0.03");
    await expect(campaign.connect(owner).placeTransistorAsk(1n, askPrice, 0n, 0))
      .to.emit(campaign, "TransistorAskPlaced");

    // execute 已删除；进入 Mining 的唯一路径是 depositToPool。
    // 挂过卖单后「全部持仓都在手上」不再成立，所以先撤单把 1 份 NAND 拿回来再入池。
    await campaign.connect(owner).cancelTransistorAsk();
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await campaign.scene()).to.equal(SCENE.Mining);
  });

  it("Ready refund never hands the parts to the owner: only the leftover BNB goes to holders", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 4n, UNIT);
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);

    // 元件已确认到账：退款不再允许（那会把元件转给 Owner、份额清零、结束本期）
    await expect(campaign.connect(owner).openRefund())
      .to.be.revertedWithCustomError(campaign, "UseReturnSurplus");
    await expect(campaign.connect(owner).abandonOrder())
      .to.be.revertedWithCustomError(campaign, "UseReturnSurplus");

    // 正确的出口：只把没花完的募集款按份退给持份人
    const leftover = SHARE_PRICE * 100n - UNIT * 4n;
    await expect(campaign.connect(owner).returnSurplus()).to.emit(campaign, "SurplusReturned");
    expect(await campaign.surplusPool()).to.equal(leftover);
    expect(await campaign.surplusBase()).to.equal(100n);
    // 份额、元件、阶段都不动
    expect(await campaign.sharesOf(alice.address)).to.equal(100n);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(4n);
    expect(await parts.balanceOf(owner.address, 0)).to.equal(0n);
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    expect(await campaign.executionFailed()).to.equal(false);

    // 持份人自己领
    await expect(campaign.connect(alice).claimSurplus()).to.emit(campaign, "SurplusClaimed");
    // 盈余领取单独记账：totalRefunded 只记本金，不能被 claimSurplus 抬高。
    expect(await campaign.totalRefunded()).to.equal(0n);
    expect(await campaign.surplusPaid()).to.equal(leftover);
    expect(await campaign.surplusClaimedOf(alice.address)).to.equal(leftover);
    expect(await campaign.refundedOf(alice.address)).to.equal(0n);
    // 领完余款后元件和份额仍然要能入池
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await parts.balanceOf(await pool.getAddress(), 0)).to.equal(4n);
    expect(await parts.balanceOf(owner.address, 0)).to.equal(0n);
  });

  it("setPlan blocked after listed / mining", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(owner).setPlan(408n);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await place(campaign, owner, 100n, UNIT);
    await expect(campaign.connect(owner).setPlan(408n)).to.be.revertedWithCustomError(campaign, "WrongScene");
    await fillAndConfirm(campaign, minter);
    await expect(campaign.connect(owner).setPlan(408n)).to.be.revertedWithCustomError(campaign, "WrongScene");
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await campaign.connect(owner).depositToPool();
    expect(await campaign.scene()).to.equal(SCENE.Mining);
    await expect(campaign.connect(owner).setPlan(408n)).to.be.revertedWithCustomError(campaign, "WrongScene");
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
      "RefundNotAvailable",
    );
  });
});

describe("share transfer (Mining only)", () => {
  it("list escrow / cancel / no self-take", async () => {
    const { campaign, alice } = await pooledFixture();
    await expect(campaign.connect(alice).listShares(100n, SHARE_PRICE)).to.be.revertedWithCustomError(campaign, "InsufficientShares");
    await campaign.connect(alice).listShares(20n, ethers.parseEther("0.02"));
    expect(await campaign.sharesOf(alice.address)).to.equal(40n);
    expect(await campaign.escrowOf(alice.address)).to.equal(20n);
    await expect(campaign.connect(alice).takeListing(0n, 1n, { value: ethers.parseEther("0.02") })).to.be.revertedWithCustomError(
      campaign,
      "CannotTakeOwnListing",
    );
    await campaign.connect(alice).cancelListing(0n);
    expect(await campaign.sharesOf(alice.address)).to.equal(60n);
  });

  it("getListing returns the listing the frontend reads", async () => {
    const { campaign, alice } = await pooledFixture();
    await campaign.connect(alice).listShares(20n, ethers.parseEther("0.02"));
    const l = await campaign.getListing(0n);
    expect(l.seller).to.equal(alice.address);
    expect(l.shares).to.equal(20n);
    expect(l.priceBnbPerShare).to.equal(ethers.parseEther("0.02"));
    expect(l.open).to.equal(true);
    await expect(campaign.getListing(1n)).to.be.revertedWithCustomError(campaign, "NoListing");
  });

  it("takeListing transfers shares and BNB", async () => {
    const { campaign, alice, bob } = await pooledFixture();
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

  it("cannot list while funding", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(10n, { value: SHARE_PRICE * 10n });
    await expect(campaign.connect(alice).listShares(1n, SHARE_PRICE)).to.be.revertedWithCustomError(campaign, "WrongScene");
  });
});

describe("harvest / claim (placeholders)", () => {
  // 流片 / PoD 已移除，harvest / claim 仅作占位：Mining 外 revert WrongScene，Mining 内 no-op / 返回 0。
  it("harvest and claim are placeholders: revert outside Mining, no-op inside Mining", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await expect(campaign.connect(alice).harvest()).to.be.revertedWithCustomError(campaign, "WrongScene");
    await expect(campaign.connect(alice).claim()).to.be.revertedWithCustomError(campaign, "WrongScene");

    const { campaign: mc } = await pooledFixture();
    await expect(mc.connect(alice).harvest()).to.not.be.reverted;
    expect(await mc.connect(alice).claim.staticCall()).to.equal(0n);
  });
});

describe("recover transistors / BNB", () => {
  it("owner can recover transistors held by the campaign (blocked once pooled)", async () => {
    // Listed still refuses. Ready allows the transfer and keeps the phase, so depositToPool can follow.
    const live = await loadFixture(deployFixture);
    // Deploy after the fixture snapshot: loadFixture reverts the chain, which wipes code deployed before it.
    const parts = await ethers.deployContract("MockERC1155");
    await live.campaign.connect(live.alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await live.campaign.connect(live.bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await live.campaign.connect(live.owner).setPlan(408n);
    await place(live.campaign, live.owner, 100n, UNIT);
    await parts.mint(await live.campaign.getAddress(), 0, 3n);
    await expect(live.campaign.connect(live.owner).recoverTransistors(await parts.getAddress(), 0, 1n))
      .to.be.revertedWithCustomError(live.campaign, "AlreadyListed");
    await live.minter.fillBid(await live.campaign.nandBidId(), await live.campaign.nandQty());
    await live.parts.mint(await live.campaign.getAddress(), 0, await live.campaign.nandQty());
    await live.campaign.confirmTransistors();
    await live.campaign.connect(live.owner).recoverTransistors(await parts.getAddress(), 0, 1n);
    expect(await live.campaign.phase()).to.equal(PHASE.Ready);
    expect(await parts.balanceOf(live.owner.address, 0)).to.equal(1n);
    expect(await parts.balanceOf(await live.campaign.getAddress(), 0)).to.equal(2n);

    // 打入矿池后不可逆：recoverTransistors 改回 AlreadyPooled。
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await live.campaign.connect(live.owner).setMiningPool(await pool.getAddress());
    await live.campaign.connect(live.owner).depositToPool();
    await expect(live.campaign.connect(live.owner).recoverTransistors(await parts.getAddress(), 0, 1n))
      .to.be.revertedWithCustomError(live.campaign, "AlreadyPooled");
  });

  it("the round's own parts cannot be pulled out while shares are outstanding", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await fillAndConfirm(campaign, minter);
    const held = await parts.balanceOf(await campaign.getAddress(), 0);
    // 当期元件是持份人的抵押：份额未结清时不能提给 Owner（只能入池 depositToPool 或挂卖消化的）。
    await expect(campaign.connect(owner).recoverTransistors(await parts.getAddress(), 0, held))
      .to.be.revertedWithCustomError(campaign, "SharesOutstanding");
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(held);
    // Ready 不能再下买单：要重新买入必须先用 setPhase 回到 Buying（或走 openRefund / confirmSale）。
    await expect(place(campaign, owner, 1n, UNIT)).to.be.revertedWithCustomError(campaign, "WrongScene");
    await campaign.connect(owner).setPhase(PHASE.Buying);
    await place(campaign, owner, 1n, UNIT);
    await fillAndConfirm(campaign, minter);
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await campaign.scene()).to.equal(SCENE.Mining);
  });

  it("a partly sold round can still book the sale proceeds and pool what is left", async () => {
    // Ready 卖出部分元件后 phase 回到 Buying，此时手上元件少于原订单数量。
    // 若 Ready 的入口只认「元件齐」，卖飞的那部分就把整期锁死：余款和剩余元件都出不去。
    const { campaign, owner, alice, bob, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);

    const askPrice = ethers.parseEther("0.01"); // 40 件 × 0.01 = 0.4 BNB
    await campaign.connect(owner).placeTransistorAsk(40n, askPrice, 0n, 0);
    await minter.connect(bob).fillAsk(await campaign.nandAskId(), 40n, { value: 40n * askPrice });
    await campaign.connect(owner).cancelTransistorAsk();
    await campaign.connect(owner).confirmSale();
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(60n);
    expect(await campaign.raisedBnb()).to.equal(100n * UNIT + 40n * askPrice);

    // 元件已经不齐（60 < 100），仍必须能回到 Ready 并把卖出款记给持份人。
    await campaign.connect(owner).setPhase(PHASE.Ready);
    await campaign.connect(owner).returnSurplus();
    expect(await campaign.surplusOf(alice.address)).to.be.greaterThan(0n);

    // 剩余元件照样能入池，不会因为「数量不足」卡住。
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await pool.balanceOf(await pool.getAddress(), 0)).to.equal(0n);
    expect(await parts.balanceOf(await pool.getAddress(), 0)).to.equal(60n);
    expect(await campaign.scene()).to.equal(SCENE.Mining);
  });

  it("Ready and Listed cannot be faked without a paid order", async () => {
    const { campaign, owner, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    // Sold out → Executing/Buying, but nothing has been ordered yet.
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    await expect(campaign.connect(owner).setPhase(PHASE.Ready))
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
    // Listed means a live bid exists: faking it would leave no cancel path.
    await expect(campaign.connect(owner).setPhase(PHASE.Listed))
      .to.be.revertedWithCustomError(campaign, "WrongScene");

    // A cancelled order zeroes priceLock, so Ready/Mining stays closed until a real purchase lands.
    await place(campaign, owner, 1n, UNIT);
    await campaign.connect(owner).cancelTransistorOrder();
    expect(await campaign.priceLock()).to.equal(0n);
    await expect(campaign.connect(owner).setPhase(PHASE.Ready))
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");
  });

  it("owner can set phase out of Ready, settle shares, then take the parts out", async () => {
    const { campaign, owner, alice, minter, parts } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: SHARE_PRICE * 100n });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 1n, UNIT);
    await expect(campaign.connect(owner).setPhase(PHASE.Buying)).to.be.revertedWithCustomError(campaign, "AlreadyListed");
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    await expect(campaign.connect(alice).setPhase(PHASE.Buying)).to.be.revertedWithCustomError(campaign, "NotOwner");
    await expect(campaign.connect(owner).setPhase(4)).to.be.revertedWithCustomError(campaign, "WrongScene");
    // None (0) is not a valid Executing sub-phase: it would close ordering and every refund path.
    await expect(campaign.connect(owner).setPhase(PHASE.None)).to.be.revertedWithCustomError(campaign, "WrongScene");
    await campaign.connect(owner).setPhase(PHASE.Buying);
    expect(await campaign.phase()).to.equal(PHASE.Buying);
    const held = await parts.balanceOf(await campaign.getAddress(), 0);
    // 份额还没结清：当期元件半步都出不去（S-2）。
    await expect(campaign.connect(owner).recoverTransistors(await parts.getAddress(), 0, held))
      .to.be.revertedWithCustomError(campaign, "SharesOutstanding");
    // 先结清持份人，元件才归 Owner。
    await campaign.connect(owner).openRefund();
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.outstandingShares()).to.equal(0n);
    await campaign.connect(owner).recoverTransistors(await parts.getAddress(), 0, held);
    expect(await parts.balanceOf(owner.address, 0)).to.equal(held);
    expect(await parts.balanceOf(await campaign.getAddress(), 0)).to.equal(0n);
  });

  it("recoverBnb sweeps excess; reverts when there is no excess over raisedBnb", async () => {
    const funded = await loadFixture(deployFixture);
    await funded.campaign.connect(funded.alice).subscribe(10n, { value: 10n * SHARE_PRICE });
    expect(await funded.campaign.raisedBnb()).to.equal(10n * SHARE_PRICE);
    // No argument: with nothing above raisedBnb there is nothing safe to sweep, so it reverts.
    await expect(funded.campaign.connect(funded.owner).recoverBnb())
      .to.be.revertedWithCustomError(funded.campaign, "ZeroShares");
    expect(await funded.campaign.raisedBnb()).to.equal(10n * SHARE_PRICE);

    // Mining: surplus already returned to holders, raisedBnb == 0, but shares still outstanding,
    // so there is no excess to sweep -> revert.
    const { campaign, owner } = await pooledFixture();
    expect(await campaign.raisedBnb()).to.equal(0n);
    await expect(campaign.connect(owner).recoverBnb()).to.be.revertedWithCustomError(campaign, "ZeroShares");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H-1 后半：退款后 owner 仍能下单（sold 单调化）
// ─────────────────────────────────────────────────────────────────────────────
describe("H-1b refund no longer locks the owner out", () => {
  it("a holder refunding does not revoke the owner's ability to order", async () => {
    const { campaign, owner, alice, bob, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });

    // 制造短池，让退款路径打开
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await minter.fillBid(await campaign.nandBidId(), 1n);
    await campaign.connect(alice).cancelTransistorOrder();

    // alice 退款（短池路径）
    await campaign.connect(alice).refund();
    // sold 是单调的历史事实：退款不会让它变小
    expect(await campaign.sold()).to.equal(100n);
    expect(await campaign.outstandingShares()).to.equal(40n);

    // owner 依然可以下单（原实现里 sold 变小 → 闸门永远拦死）
    await place(campaign, owner, 1n, UNIT);
    expect(await campaign.nandQty()).to.equal(1n);
  });

  it("an unsold round that passes its deadline still lets subscribers pull their principal back", async () => {
    // 「售罄前不允许退款」不能被照字面实现：否则未售罄 + Funding 过期的期次
    // 会失去唯一的本金出口，本金被永久锁死（比 H-1 更严重）。
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(10n, { value: 10n * SHARE_PRICE });
    await time.increaseTo((await campaign.fundingDeadline()) + 1n);
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await campaign.connect(alice).refund();
    const r = await tx.wait();
    expect(
      await ethers.provider.getBalance(alice.address) + r.gasUsed * r.gasPrice - before
    ).to.equal(10n * SHARE_PRICE);
    expect(await campaign.outstandingShares()).to.equal(0n);
  });

  it("a sold-out round does not allow the deadline refund path", async () => {
    const { campaign, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await time.increaseTo((await campaign.fundingDeadline()) + 1n);
    // 售罄的期次：钱已经用于买元件，不允许走「未售罄过期」那条退款路径。
    await expect(campaign.connect(alice).refund())
      .to.be.revertedWithCustomError(campaign, "RefundNotAvailable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C-4：余款 pull 模式
// ─────────────────────────────────────────────────────────────────────────────
describe("C-4 surplus is pulled, not pushed", () => {
  it("depositToPool does not iterate holders; each holder claims their own share", async () => {
    const { campaign, owner, minter, alice, bob } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);

    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());

    const surplus = 100n * SHARE_PRICE - 100n * UNIT;
    // 入池时没有任何转账事件：没有遍历、没有 push
    await expect(campaign.connect(owner).depositToPool())
      .to.emit(campaign, "DepositedToPool")
      .and.not.to.emit(campaign, "Refunded");
    expect(await campaign.surplusPool()).to.equal(surplus);
    expect(await campaign.surplusBase()).to.equal(100n);

    // alice 领 60%
    const aBefore = await ethers.provider.getBalance(alice.address);
    const atx = await campaign.connect(alice).claimSurplus();
    const ar = await atx.wait();
    expect(
      await ethers.provider.getBalance(alice.address) + ar.gasUsed * ar.gasPrice - aBefore
    ).to.equal((surplus * 60n) / 100n);

    // bob 领 40%
    const bBefore = await ethers.provider.getBalance(bob.address);
    const btx = await campaign.connect(bob).claimSurplus();
    const br = await btx.wait();
    expect(
      await ethers.provider.getBalance(bob.address) + br.gasUsed * br.gasPrice - bBefore
    ).to.equal((surplus * 40n) / 100n);

    // 分毫不差
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
    expect(await campaign.totalPendingSurplus()).to.equal(0n);
  });

  it("a seller who lists every share can still claim the accrued surplus", async () => {
    // 挂单只锁「转让权」，不锁余款：挂牌期间 sharesOf 归零，若按 sharesOf 算权益，
    // 卖家必须撤单才能领钱，挂单被人买走后这笔余款就永远领不到了。
    const { campaign, alice } = await loadFixture(pooledFixture);
    await campaign.connect(alice).listShares(60n, ethers.parseEther("0.02"));
    expect(await campaign.sharesOf(alice.address)).to.equal(0n);
    expect(await campaign.escrowOf(alice.address)).to.equal(60n);
    const claimable = await campaign.surplusOf(alice.address);
    expect(claimable).to.be.greaterThan(0n);
    const paidBefore = await campaign.surplusPaid();
    await expect(campaign.connect(alice).claimSurplus()).to.emit(campaign, "SurplusClaimed");
    expect(await campaign.surplusPaid()).to.equal(paidBefore + claimable);
    // 挂单本身不受影响。
    expect(await campaign.escrowOf(alice.address)).to.equal(60n);
  });

  it("a holder cannot claim the same surplus twice", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await campaign.connect(owner).depositToPool();

    await campaign.connect(alice).claimSurplus();
    // 再领一次没有可领的 → revert
    await expect(campaign.connect(alice).claimSurplus())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("the owner cannot sweep the unclaimed surplus away", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await campaign.connect(owner).depositToPool();

    // 一分钱都不能扫走
    await expect(campaign.connect(owner).recoverBnb())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.be.gt(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 确认到账后立刻退回剩余募集款（不入池、不退本期）
// ─────────────────────────────────────────────────────────────────────────────
describe("returnSurplus: unspent principal goes back right after confirmation", () => {
  /** 认购满 100 份 → 挂 100 颗 @ UNIT → 成交确认，停在 Ready，池子还剩 100 × (SHARE_PRICE − UNIT)。 */
  async function readyFixture() {
    const ctx = await loadFixture(deployFixture);
    const { campaign, owner, alice, bob, minter } = ctx;
    await campaign.connect(alice).subscribe(60n, { value: 60n * SHARE_PRICE });
    await campaign.connect(bob).subscribe(40n, { value: 40n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    return ctx;
  }

  it("returns the leftover pro-rata while the round stays in Ready", async () => {
    const { campaign, owner, alice, bob } = await readyFixture();
    const leftover = 100n * SHARE_PRICE - 100n * UNIT;
    expect(await campaign.raisedBnb()).to.equal(leftover);

    await expect(campaign.connect(owner).returnSurplus())
      .to.emit(campaign, "SurplusReturned")
      .withArgs(leftover, 100n);

    // 账本：本金池清零，改成 pull 的 surplus；期次没结束、阶段没变
    expect(await campaign.raisedBnb()).to.equal(0n);
    expect(await campaign.surplusPool()).to.equal(leftover);
    expect(await campaign.surplusBase()).to.equal(100n);
    expect(await campaign.scene()).to.equal(SCENE.Executing);
    expect(await campaign.phase()).to.equal(PHASE.Ready);
    expect(await campaign.executionFailed()).to.equal(false);
    // 元件没动，份额没动
    expect(await campaign.outstandingShares()).to.equal(100n);
    expect(await campaign.orderFilled()).to.equal(true);

    // 60 / 40 按份领
    const aBefore = await ethers.provider.getBalance(alice.address);
    const atx = await campaign.connect(alice).claimSurplus();
    const ar = await atx.wait();
    expect(await ethers.provider.getBalance(alice.address) + ar.gasUsed * ar.gasPrice - aBefore)
      .to.equal((leftover * 60n) / 100n);

    const bBefore = await ethers.provider.getBalance(bob.address);
    const btx = await campaign.connect(bob).claimSurplus();
    const br = await btx.wait();
    expect(await ethers.provider.getBalance(bob.address) + br.gasUsed * br.gasPrice - bBefore)
      .to.equal((leftover * 40n) / 100n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
  });

  it("does not block depositToPool, and pooling keeps the booked surplus claimable", async () => {
    const { campaign, owner, alice, bob } = await readyFixture();
    await campaign.connect(owner).returnSurplus();

    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    // 入池照样能进：入池时的 _returnSurplus 看到 raisedBnb == 0，不会覆盖已记账的余款
    await expect(campaign.connect(owner).depositToPool()).to.emit(campaign, "DepositedToPool");
    expect(await campaign.scene()).to.equal(SCENE.Mining);
    expect(await campaign.surplusBase()).to.equal(100n);

    // 入池后仍然能领（没被重复记账、也没被清零）
    await campaign.connect(alice).claimSurplus();
    await campaign.connect(bob).claimSurplus();
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(0n);
  });

  it("is owner-only and refuses to end the round by refund afterwards", async () => {
    const { campaign, owner, alice } = await readyFixture();
    await expect(campaign.connect(alice).returnSurplus())
      .to.be.revertedWithCustomError(campaign, "NotOwner");

    await campaign.connect(owner).returnSurplus();
    // 本金已经发回给持份人：再退款就是把份额清零、把元件交回 Owner
    await expect(campaign.connect(owner).openRefund())
      .to.be.revertedWithCustomError(campaign, "SurplusAlreadyReturned");
    await expect(campaign.connect(owner).abandonOrder())
      .to.be.revertedWithCustomError(campaign, "SurplusAlreadyReturned");
    // 持份人自己也不该能 0 BNB 清掉份额（那等于白送挖矿权益）
    await expect(campaign.connect(alice).refund())
      .to.be.revertedWithCustomError(campaign, "SurplusAlreadyReturned");
    // 也不该再把本期标成「执行失败」——那会给持份人一个注定失败的退款入口
    await expect(campaign.connect(owner).markFailed())
      .to.be.revertedWithCustomError(campaign, "SurplusAlreadyReturned");
  });

  it("cannot run before the parts are confirmed or with no leftover", async () => {
    const { campaign, owner, alice, minter } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);

    // Buying：元件还没到手
    await expect(campaign.connect(owner).returnSurplus())
      .to.be.revertedWithCustomError(campaign, "TransistorsNotReady");

    // 把全部募集款花在元件上 → 没有余数可退
    await place(campaign, owner, 100n, SHARE_PRICE);
    await fillAndConfirm(campaign, minter);
    expect(await campaign.raisedBnb()).to.equal(0n);
    await expect(campaign.connect(owner).returnSurplus())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("a second call cannot re-book the same money", async () => {
    const { campaign, owner } = await readyFixture();
    await campaign.connect(owner).returnSurplus();
    await expect(campaign.connect(owner).returnSurplus())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 服务费真正上链
// ─────────────────────────────────────────────────────────────────────────────
describe("service fee is on-chain", () => {
  it("owner sets the fee and a multi-recipient split table before anyone subscribes", async () => {
    const { campaign, owner, feeRecipient, carol } = await loadFixture(deployFixture);
    await expect(
      campaign
        .connect(owner)
        .setServiceFee(500, [feeRecipient.address, carol.address], [7000, 3000])
    )
      .to.emit(campaign, "ServiceFeeSet");
    expect(await campaign.serviceFeeBps()).to.equal(500);
    expect(await campaign.serviceFeeSet()).to.equal(true);
    expect(await campaign.feeRecipientCount()).to.equal(2);
    expect(await campaign.feeRecipientAt(0)).to.equal(feeRecipient.address);
    expect(await campaign.feeSharesBpsAt(1)).to.equal(3000);
  });

  it("an explicit zero fee freezes the round at no-fee", async () => {
    const { campaign, owner, feeRecipient } = await loadFixture(deployFixture);
    // 0 bps must come with an empty table; a split with 0 bps is contradictory.
    await expect(campaign.connect(owner).setServiceFee(0, [feeRecipient.address], [10000]))
      .to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    await expect(campaign.connect(owner).setServiceFee(0, [], [])).to.emit(campaign, "ServiceFeeSet");
    expect(await campaign.serviceFeeBps()).to.equal(0);
    expect(await campaign.serviceFeeSet()).to.equal(true);
    expect(await campaign.feeRecipientCount()).to.equal(0);
    // Frozen forever, including against a later real table.
    await expect(campaign.connect(owner).setServiceFee(0, [], []))
      .to.be.revertedWithCustomError(campaign, "ServiceFeeAlreadySet");
    await expect(campaign.connect(owner).setServiceFee(500, [feeRecipient.address], [10000]))
      .to.be.revertedWithCustomError(campaign, "ServiceFeeAlreadySet");
  });

  it("rejects an invalid table", async () => {
    const { campaign, owner, feeRecipient, carol, alice, bob } = await loadFixture(deployFixture);
    // 份额合计不等于 10000
    await expect(
      campaign.connect(owner).setServiceFee(500, [feeRecipient.address, carol.address], [7000, 2000])
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    // 超过硬上限 10%
    await expect(
      campaign.connect(owner).setServiceFee(1001, [feeRecipient.address], [10000])
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    // 重复地址
    await expect(
      campaign
        .connect(owner)
        .setServiceFee(500, [feeRecipient.address, feeRecipient.address], [5000, 5000])
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    // 零地址
    await expect(
      campaign
        .connect(owner)
        .setServiceFee(500, [ethers.ZeroAddress], [10000])
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
    // T-72：分成地址超过 3 个（MAX_FEE_RECIPIENTS = 3）
    await expect(
      campaign
        .connect(owner)
        .setServiceFee(500, [feeRecipient.address, carol.address, alice.address, bob.address], [2500, 2500, 2500, 2500])
    ).to.be.revertedWithCustomError(campaign, "BadFeeConfig");
  });

  it("accepts exactly three fee recipients", async () => {
    const { campaign, owner, feeRecipient, carol, alice } = await loadFixture(deployFixture);
    await campaign
      .connect(owner)
      .setServiceFee(500, [feeRecipient.address, carol.address, alice.address], [5000, 3000, 2000]);
    expect(await campaign.feeRecipientCount()).to.equal(3);
  });

  it("freezes the fee once somebody subscribed", async () => {
    const { campaign, owner, alice, feeRecipient } = await loadFixture(deployFixture);
    await campaign.connect(owner).setServiceFee(500, [feeRecipient.address], [10000]);
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    await expect(
      campaign.connect(owner).setServiceFee(900, [feeRecipient.address], [10000])
    ).to.be.revertedWithCustomError(campaign, "ServiceFeeAlreadySet");
  });

  it("cannot set the fee after someone subscribed but before it was set", async () => {
    const { campaign, owner, alice, feeRecipient } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(1n, { value: SHARE_PRICE });
    await expect(
      campaign.connect(owner).setServiceFee(500, [feeRecipient.address], [10000])
    ).to.be.revertedWithCustomError(campaign, "ServiceFeeLocked");
  });

  it("the mining pool's revenue is charged the fee and each recipient pulls its cut", async () => {
    const { campaign, owner, minter, alice, feeRecipient, carol } = await loadFixture(deployFixture);
    // 矿池用 EOA 模拟：这样它能自己发交易调用 depositRevenue()。
    const [, , , , , poolSigner] = await ethers.getSigners();
    await campaign
      .connect(owner)
      .setServiceFee(1000, [feeRecipient.address, carol.address], [6000, 4000]);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    await campaign.connect(owner).setMiningPool(poolSigner.address);
    await campaign.connect(owner).depositToPool();

    // 矿池打 1 BNB 收益进来 → 10% 服务费 = 0.1 BNB，分成 60% / 40%
    const gross = ethers.parseEther("1");
    const fee = ethers.parseEther("0.1");
    await expect(
      campaign.connect(poolSigner).depositRevenue({ value: gross })
    ).to.emit(campaign, "RevenueDeposited");
    expect(await campaign.revenuePool()).to.equal(gross - fee);
    expect(await campaign.totalPendingFee()).to.equal(fee);
    expect(await campaign.pendingFee(feeRecipient.address)).to.equal((fee * 6000n) / 10000n);
    expect(await campaign.pendingFee(carol.address)).to.equal((fee * 4000n) / 10000n);

    // 收款方自己来领（领取者自己付 gas，所以余额差要用 gas 还原）
    const fBefore = await ethers.provider.getBalance(feeRecipient.address);
    const ftx = await campaign.connect(feeRecipient).claimFee();
    const fr = await ftx.wait();
    await expect(ftx).to.emit(campaign, "FeePaid");
    expect(
      await ethers.provider.getBalance(feeRecipient.address) + fr.gasUsed * fr.gasPrice - fBefore
    ).to.equal((fee * 6000n) / 10000n);
    await campaign.connect(carol).claimFee();
    expect(await campaign.totalPendingFee()).to.equal(0n);

    // owner 扫不走收益池
    await expect(campaign.connect(owner).recoverBnb())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("only the mining pool may deposit revenue", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    const pool = await ethers.deployContract("MockERC1155");
    await pool.waitForDeployment();
    await campaign.connect(owner).setMiningPool(await pool.getAddress());
    await campaign.connect(owner).depositToPool();
    await expect(
      campaign.connect(alice).depositRevenue({ value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(campaign, "NotOwner");
  });

  // ── 口径锁定：服务费 = 挖矿产出奖励的服务费；认筹款不收任何服务费 ──
  it("never charges a service fee on subscription money", async () => {
    const { campaign, owner, alice, feeRecipient } = await loadFixture(deployFixture);
    // 费率拉满 10%，分成表填满 —— 如果实现里有任何「从认购款抽费」的路径，这里必然暴露。
    await campaign.connect(owner).setServiceFee(1000, [feeRecipient.address], [10000]);

    const paid = 10n * SHARE_PRICE;
    await campaign.connect(alice).subscribe(10n, { value: paid });

    // 认筹款全额进认购托管池，一分没少。
    expect(await campaign.raisedBnb()).to.equal(paid);
    // 服务费相关账本全是 0：没有计提、没有待领、收益池也是空的。
    expect(await campaign.totalPendingFee()).to.equal(0n);
    expect(await campaign.pendingFee(feeRecipient.address)).to.equal(0n);
    expect(await campaign.revenuePool()).to.equal(0n);
    // 收款方领不到任何东西（没有可领金额）。
    await expect(campaign.connect(feeRecipient).claimFee())
      .to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("charges the fee only on mining revenue, never on the subscription escrow", async () => {
    const { campaign, owner, minter, alice, feeRecipient } = await loadFixture(deployFixture);
    const [, , , , , poolSigner] = await ethers.getSigners();
    await campaign.connect(owner).setServiceFee(1000, [feeRecipient.address], [10000]);
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    await campaign.connect(owner).setMiningPool(poolSigner.address);
    await campaign.connect(owner).depositToPool();

    // 记下打收益之前的状态。
    const escrowBefore = await campaign.raisedBnb();
    const revenueBefore = await campaign.revenuePool();

    // 矿池打 1 BNB 挖矿收益 → 10% 提成服务费。
    const gross = ethers.parseEther("1");
    const fee = ethers.parseEther("0.1");
    await campaign.connect(poolSigner).depositRevenue({ value: gross });
    expect(await campaign.totalPendingFee()).to.equal(fee);
    // 关键：这笔服务费只从**挖矿收益**里出，认购托管池一分没动。
    expect(await campaign.raisedBnb()).to.equal(escrowBefore);
    // 收益池增加的是「挖矿收益 − 服务费」，与认购款无关。
    expect(await campaign.revenuePool()).to.equal(revenueBefore + gross - fee);
  });

  it("a second revenue deposit after everyone claimed is still claimable", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    const [, , , , , poolSigner] = await ethers.getSigners();
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    await campaign.connect(owner).setMiningPool(poolSigner.address);
    await campaign.connect(owner).depositToPool();

    const first = ethers.parseEther("0.05");
    await campaign.connect(poolSigner).depositRevenue({ value: first });
    await campaign.connect(alice).claimSurplus();
    expect(await campaign.surplusOf(alice.address)).to.equal(0n);
    expect(await campaign.surplusPaid()).to.equal(await campaign.surplusPool());

    // 第二轮收益：老账本已经把「份额基数」数完了，新钱必须还能领。
    const second = ethers.parseEther("0.07");
    await campaign.connect(poolSigner).depositRevenue({ value: second });
    expect(await campaign.surplusOf(alice.address)).to.equal(second);
    await campaign.connect(alice).claimSurplus();
    expect(await campaign.surplusPaid()).to.equal(await campaign.surplusPool());
    // 全部认领后合约里不留余款，owner 也扫不出东西。
    await expect(campaign.connect(owner).recoverBnb()).to.be.revertedWithCustomError(campaign, "ZeroShares");
  });

  it("mining revenue is pull-claimable by holders instead of locked in a pot", async () => {
    const { campaign, owner, minter, alice } = await loadFixture(deployFixture);
    const [, , , , , poolSigner] = await ethers.getSigners();
    await campaign.connect(alice).subscribe(100n, { value: 100n * SHARE_PRICE });
    await campaign.connect(owner).setPlan(408n);
    await place(campaign, owner, 100n, UNIT);
    await fillAndConfirm(campaign, minter);
    await campaign.connect(owner).setMiningPool(poolSigner.address);
    await campaign.connect(owner).depositToPool();

    const surplusBefore = await campaign.surplusPool();
    const gross = ethers.parseEther("0.05"); // 未设费率 ⇒ 净额 == 全额
    await campaign.connect(poolSigner).depositRevenue({ value: gross });
    // 累计展示值照旧；真钱直接并入持份人可领余款，不留死池。
    expect(await campaign.revenuePool()).to.equal(gross);
    expect(await campaign.surplusPool()).to.equal(surplusBefore + gross);
    expect(await campaign.raisedBnb()).to.equal(0n);

    // owner 扫不走（余额刚好只够预留额）。
    await expect(campaign.connect(owner).recoverBnb()).to.be.revertedWithCustomError(campaign, "ZeroShares");
    // 持份人自己 pull，谁都拦不住。
    expect(await campaign.surplusOf(alice.address)).to.be.greaterThan(0n);
    await expect(campaign.connect(alice).claimSurplus()).to.emit(campaign, "SurplusClaimed");
  });
});

describe("factory parts whitelist", () => {
  it("lets the owner pick a whitelisted parts contract per round", async () => {
    const { owner, factory, minter, parts } = await loadFixture(deployFixture);
    // 白名单里除了默认那件，再加第二件（模拟「官方两件套」里换一个处理器）。
    const partsB = await ethers.deployContract("MockERC1155");
    const partsBAddr = await partsB.getAddress();
    // 重新部署一个白名单含两件的工厂
    const factory2 = await ethers.deployContract("CampaignFactory", [
      await minter.getAddress(),
      [await parts.getAddress(), partsBAddr],
    ]);
    await factory2.connect(owner).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, partsBAddr);
    const c = await ethers.getContractAt("Campaign", await factory2.campaigns(0));
    expect(await c.transistors()).to.equal(partsBAddr);
  });

  it("refuses a parts contract that is not whitelisted", async () => {
    const { owner, factory, minter, parts } = await loadFixture(deployFixture);
    const rogue = await ethers.deployContract("MockERC1155");
    const factory2 = await ethers.deployContract("CampaignFactory", [
      await minter.getAddress(),
      [await parts.getAddress()],
    ]);
    await expect(
      factory2.connect(owner).createCampaign(SHARE_PRICE, TOTAL_SHARES, FUNDING_SECONDS, await rogue.getAddress())
    ).to.be.revertedWithCustomError(factory2, "PartsNotAllowed");
  });

  it("exposes the whitelist for the frontend", async () => {
    const { factory, parts } = await loadFixture(deployFixture);
    expect(await factory.allowedPartsCount()).to.equal(1n);
    expect(await factory.isAllowedParts(await parts.getAddress())).to.equal(true);
    const rogue = await ethers.deployContract("MockERC1155");
    expect(await factory.isAllowedParts(await rogue.getAddress())).to.equal(false);
  });
});
