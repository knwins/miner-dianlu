// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {IERC1155} from "./interfaces/IERC1155.sol";
import {IMaterialMarket} from "./interfaces/IMaterialMarket.sol";

/// @title Campaign — one BEM crowdfunding round
/// @notice Scenes: Funding → Executing → Mining. Executing phases: Buying → Listed → Ready.
///
/// Money flow:
///  - Subscription BNB is held in `raisedBnb`; subscribing is allowed up to and including the deadline.
///  - `placeTransistorOrder` spends it on the material market. Filled legs arrive as ERC1155; an
///    unaffordable order sets `executionFailed` and places no bid (it does not revert).
///  - Only a market that ever served this round may send BNB in (see receive()).
///  - Share transfer (listShares / takeListing / cancelListing) is Mining-only and pays the seller
///    directly, never through `raisedBnb`.
///
/// Mining: `depositToPool` commits the held parts to `miningPool` and is IRREVERSIBLE; unspent BNB is
/// booked as holder-claimable surplus first (shares are kept). harvest() / claim() are placeholders.
/// Business rules (fee scope, monotonic `sold`, refund denominators, exit paths) live in
/// contracts/README.md §8.
interface IFactory {
    /// @param campaign Round to look up.
    /// @return True while the factory still lists the round.
    function isRegistered(address campaign) external view returns (bool);
}

contract Campaign is Ownable, ReentrancyGuard {
    /// @notice Factory that created this round. Read for registry membership (see receive / cancelTransistorOrder).
    address public immutable factory;

    // ─────────────────────────── state machine ───────────────────────────
    enum Scene {
        Funding,
        Executing,
        Mining
    }
    enum Phase {
        None, // creation-time value; setPhase() refuses it
        Buying, // ready to place transistor bids
        Listed, // bids live; cancel still allowed
        Ready // parts filled; waiting for returnSurplus / depositToPool
    }

    struct Listing {
        address seller;
        uint256 shares;
        uint256 priceBnbPerShare;
        bool open;
    }

    /// @notice Grace period before a non-owner may flag the round as failed.
    uint256 internal constant FAIL_GRACE = 3 days;
    /// @notice Service-fee hard ceiling in bps (1000 = 10%). Charged on mining output only,
    ///         never on subscription BNB (README §8 rule 1).
    uint16 internal constant MAX_SERVICE_FEE_BPS = 1000;
    /// @notice Max service-fee recipients; keeps the accrual loop and storage bounded.
    uint256 internal constant MAX_FEE_RECIPIENTS = 3;

    // ─────────────────────── immutable config (fixed at creation) ───────────────────────
    uint256 public immutable sharePriceBnb; // price per share (wei)
    uint256 public immutable totalShares; // share cap
    uint64 public immutable fundingDeadline; // funding deadline (unix seconds)
    /// @notice Parts contract (ERC1155) locked at create; every bid / ask of this round targets it.
    address public immutable transistors;
    /// @notice Market used for placeBid / cancelBid / bids. Replaceable via setMaterialMarket; every
    ///         market that ever served this round stays an accepted BNB sender (async settlement).
    IMaterialMarket public materialMarket;
    /// @notice Destination of depositToPool(). Must implement onERC1155Received. Irreversible once pooled.
    address public miningPool;

    // ─────────────────────── mutable state ───────────────────────
    Scene public scene;
    Phase public phase;
    /// @notice Cumulative shares ever sold. Monotonic: refunds never decrease it.
    ///         The owner's "must have sold out" gate reads this, so a refund can never
    ///         permanently revoke the owner's ordering right — see README §8 rule 5.
    uint256 public sold;
    /// @notice Shares sold and not yet refunded. Decreases on refund; it is the pro-rata
    ///         refund denominator. `sold` is history, `outstandingShares` is current debt.
    uint256 public outstandingShares;
    /// @notice Service-fee rate in bps (1/10000). Settable once while `sold == 0`, then frozen.
    ///         Mining-output fee only (README §8 rule 1).
    uint16 public serviceFeeBps;
    /// @notice Service-fee recipients (split table). Length = feeRecipientCount().
    address[] private _feeRecipients;
    /// @notice Per-recipient share (bps). Sums to 10000; index-aligned with _feeRecipients.
    uint16[] private _feeSharesBps;
    /// @notice Accrued-but-unclaimed service fee per recipient; pulled via claimFee().
    mapping(address => uint256) public pendingFee;
    /// @notice Sum of pendingFee. recoverBnb must reserve it, or the owner would swallow
    ///         the recipients' fees.
    uint256 public totalPendingFee;
    /// @notice True once the fee table was written. Frozen forever once set (even at 0 bps).
    bool public serviceFeeSet;
    /// @notice When the round sold out. 0 means it never did (it is set as the scene turns Executing).
    uint64 public soldOutAt;
    /// @notice Timestamp of the last placeTransistorOrder; part of the markFailed grace base.
    uint64 public lastOrderAt;
    /// @notice Set by an unaffordable order or markFailed(); cleared by a successful order.
    bool public executionFailed;
    /// @notice True once the held transistors have been committed to the mining pool. Irreversible:
    ///         no function pulls them back, and refund / abandon / recover escape hatches are closed.
    bool public pooled;

    /// @notice Subscription escrow. Bids debit it; market refunds credit it via receive().
    uint256 public raisedBnb;
    /// @notice Cumulative principal refunded to holders. Never mixed with surplus payouts, which
    ///         only move `surplusPaid`.
    uint256 public totalRefunded;
    /// @notice Cumulative service fee paid out (wei).
    uint256 public totalFeesPaid;
    /// @notice Cumulative mining revenue net of the service fee. Display only: the money is booked into
    ///         the holders' pull-claimable surplus (claimSurplus), never held in a separate locked pot.
    uint256 public revenuePool;

    /// @notice Total bid escrow paid for the order (wei), not a unit price. 0 means no paid order, which
    ///         is what stops Ready / Mining from being faked without a purchase (see _readyInvariant).
    uint256 public priceLock;
    /// @notice NAND bid id on the market; 0 when there is no live order or the leg was skipped.
    uint256 public nandBidId;
    /// @notice LATCH bid id on the market; 0 when the leg was skipped.
    uint256 public latchBidId;
    /// @notice NAND quantity of the live order; 0 when the leg was skipped.
    uint256 public nandQty;
    /// @notice LATCH quantity of the live order; 0 when the leg was skipped.
    uint256 public latchQty;
    /// @notice Locked NAND bid price. Display only: never read by on-chain logic.
    uint96 public nandPrice;
    /// @notice Locked LATCH bid price. Display only: never read by on-chain logic.
    uint96 public latchPrice;
    /// @notice NAND ask id on the market; 0 when no ask was placed or the leg was skipped.
    uint256 public nandAskId;
    /// @notice LATCH ask id on the market; 0 when the leg was skipped.
    uint256 public latchAskId;
    /// @notice NAND quantity listed; 0 when the leg was skipped.
    uint256 public nandAskQty;
    /// @notice LATCH quantity listed; 0 when the leg was skipped.
    uint256 public latchAskQty;
    /// @notice Live NAND ask price. Display only: never read by on-chain logic.
    uint96 public nandAskPrice;
    /// @notice Live LATCH ask price. Display only: never read by on-chain logic.
    uint96 public latchAskPrice;
    /// @notice Design hashpower estimate. Display only: never read by on-chain logic.
    uint256 public estHashpower;

    // ─────────────────────── per-wallet ledger ───────────────────────
    mapping(address => uint256) private _shares; // available shares
    mapping(address => uint256) private _escrow; // shares locked in a listing
    /// @notice Principal refunded to this wallet; excludes surplus claims.
    mapping(address => uint256) private _refunded;
    /// @notice Surplus this wallet has claimed through claimSurplus().
    mapping(address => uint256) private _surplusClaimed;
    /// @notice Surplus accrued at pool time but not yet transferred; claimable via claimSurplus().
    mapping(address => uint256) public pendingSurplus;

    /// @notice Sum of pendingSurplus. Covered by the (surplusPool − surplusPaid) reserve in recoverBnb,
    ///         which is a superset: adding it again there would double-reserve.
    uint256 public totalPendingSurplus;
    /// @notice Cumulative BNB ever booked for holders. Display / reserve total: unclaimed is
    ///         `surplusPool − surplusPaid`.
    uint256 public surplusPool;
    /// @notice BNB booked in the CURRENT round; the numerator of this round's split.
    ///         Only BNB can change it, never holder churn, so an entitlement never shrinks.
    uint256 public surplusRoundPool;
    /// @notice Round index of the surplus ledger. A new round starts when the previous one has counted
    ///         every base share and more BNB arrives (another revenue deposit, a late settlement).
    ///         Without it the fresh money would be unclaimable: the counted-shares cursor stays at the
    ///         base and `surplusCounted[holder]` already equals their shares, so every claim would pay 0.
    uint256 public surplusRound;
    /// @notice Surplus denominator (= outstandingShares at the first booking of the round). Later holder
    ///         churn does not move an already-fixed base.
    uint256 public surplusBase;
    /// @notice Shares already counted toward the current round's split (the rounding dust goes to the
    ///         last claimant, so the pool is paid out to the last wei).
    uint256 public surplusClaimedShares;
    /// @notice Total surplus already allocated in the CURRENT round (accrued to holders, transferred or
    ///         not). Allocation (accrue) and payout (claim) are deliberately separate ledgers.
    uint256 public surplusAllocated;
    /// @notice Cumulative surplus transferred to holders by claimSurplus(), written together with the
    ///         payout. Still owed = surplusPool − surplusPaid, which recoverBnb reserves.
    uint256 public surplusPaid;
    /// @notice Shares already counted into the current round's split per holder; prevents double claims.
    mapping(address => uint256) public surplusCounted;
    /// @notice Round in which surplusCounted[holder] was written. A stale round counts as 0.
    mapping(address => uint256) public surplusCountedRound;
    /// @notice Subscribers and listing buyers, append-only (indexes are exposed via holderAt).
    /// @dev `_refundAll` walks the whole array (~2.1k gas per cold SLOAD), so a round with tens of
    ///      thousands of holders would need a batched pull refund instead.
    address[] private _holders;
    mapping(address => bool) private _holderSeen;

    Listing[] private _listings;
    /// @dev Addresses that ever served as this round's market. receive() accepts BNB from any of
    ///      them: market settlement / bid cancellation is asynchronous, and recognizing only the
    ///      current market would permanently reject late-arriving funds.
    address[] private _marketHistory;

    // ─────────────────────── events ───────────────────────
    event Subscribed(address indexed subscriber, uint256 count, uint256 paidBnb);
    event Refunded(address indexed holder, uint256 amountBnb);
    /// @notice Surplus paid out by claimSurplus(). Kept apart from Refunded: surplus is not principal.
    event SurplusClaimed(address indexed holder, uint256 amountBnb);
    event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare);
    event ListingCancelled(uint256 indexed id, address indexed seller, uint256 shares);
    event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb);
    /// @notice `escrowBnb` is the total escrowed BNB for both legs, not a unit price.
    /// @param count Total units across both legs.
    /// @param escrowBnb Total escrow debited from raisedBnb.
    event TransistorOrderPlaced(uint256 count, uint256 escrowBnb);
    event TransistorOrderCancelled();
    /// @param nandQty NAND quantity listed (0 when the leg was skipped).
    /// @param latchQty LATCH quantity listed (0 when the leg was skipped).
    /// @param nandAskId NAND ask id, 0 when the leg was skipped.
    /// @param latchAskId LATCH ask id, 0 when the leg was skipped.
    event TransistorAskPlaced(uint256 nandQty, uint256 latchQty, uint256 nandAskId, uint256 latchAskId);
    event TransistorAskCancelled();
    event TransistorsConfirmed();
    /// @notice needBnb is the bid cost that could not be afforded (0 when markFailed flags the round).
    ///         raisedBnb is the escrow available at that point. Neither path reverts.
    event ExecutionFailed(uint256 needBnb, uint256 raisedBnb);
    event RefundSendFailed(address indexed holder, uint256 amountBnb);
    event PlanUpdated(uint256 estHashpower);
    event MaterialMarketUpdated(address indexed previous, address indexed next);
    /// @notice The operator approval granted to a former material market was revoked.
    event MaterialMarketApprovalRevoked(address indexed market);
    /// @notice BNB swept out of the round by recoverBnb(). `to` is always the owner.
    event BnbRecovered(uint256 amount, address indexed to);
    /// @notice ERC1155 tokens moved out by recoverTransistors(). `to` is always the owner.
    event TransistorsRecovered(address indexed token, uint256 indexed id, uint256 amount, address indexed to);
    /// @notice Mining pool address was set / changed by the owner.
    event MiningPoolSet(address indexed previous, address indexed next);
    /// @notice The round's transistors were committed to the mining pool. IRREVERSIBLE.
    event DepositedToPool(address indexed pool, uint256 nandAmount, uint256 latchAmount);
    /// @notice The Executing sub-phase changed. Emitted by _setPhase(), the only writer of `phase`.
    event PhaseChanged(uint8 indexed previous, uint8 indexed next);
    /// @notice The round's sale order was settled and the proceeds pulled. The phase returns to Buying.
    event AskSettled(uint256 proceeds);
    /// @notice Surplus was accrued to a holder. Amount is now claimable via claimSurplus().
    event SurplusAccrued(address indexed holder, uint256 amountBnb);
    /// @notice The unspent subscription BNB was booked for pro-rata return right after the parts were
    ///         confirmed (returnSurplus). Holders pull their cut via claimSurplus(); the round keeps going.
    event SurplusReturned(uint256 amountBnb, uint256 baseShares);
    /// @notice Service-fee configuration was set. Only settable while nobody has subscribed yet.
    event ServiceFeeSet(uint16 feeBps, address[] recipients, uint16[] sharesBps);
    /// @notice A service-fee share was accrued to a recipient. The recipient pulls it via claimFee().
    event FeeAccrued(address indexed to, uint256 amount);
    /// @notice Mining revenue was deposited into the round. `fee` was withheld, `net` went to the revenue pool.
    event RevenueDeposited(uint256 gross, uint256 fee, uint256 net);
    /// @notice A service-fee share was paid out at claimFee() time.
    event FeePaid(address indexed to, uint256 amount);

    // ─────────────────────── errors ───────────────────────
    error DirectTransferNotAllowed();
    error WrongScene();
    error FundingEnded();
    error TransistorsNotReady();
    error RefundNotAvailable();
    /// @dev Reused as "nothing to settle": zero quantity, zero amount, or nothing left to pay out.
    error ZeroShares();
    error ZeroPrice();
    error BadCount();
    error InsufficientShares();
    /// @notice The round's own parts still back outstanding shares; settle the holders first.
    error SharesOutstanding();
    error ExceedsRemaining();
    error WrongPayment();
    error NoListing();
    error NotSeller();
    error CannotTakeOwnListing();
    error AlreadyListed();
    error NotListed();
    error AlreadyReady();
    error TransferFailed();
    error OrderFilled();
    error BadBidId();
    error BadAskId();
    error AlreadyAsked();
    error NotAsked();
    error InsufficientParts();
    error PoolNotSet();
    error AlreadyPooled();
    /// @notice returnSurplus() already booked the principal for pro-rata return; refund / abandon would
    ///         zero the shares for 0 BNB, so both are closed.
    error SurplusAlreadyReturned();
    /// @notice Ready: the only refund is the unspent BNB, and it must not touch the parts. Use
    ///         returnSurplus() instead of openRefund / abandonOrder.
    error UseReturnSurplus();
    /// @notice Invalid fee table (bps over the cap, length mismatch, duplicate or zero recipient, or
    ///         shares not summing to 10000). Also raised by the fee getters for an out-of-range index.
    error BadFeeConfig();
    /// @notice The service-fee table was already set. It is frozen forever once written.
    error ServiceFeeAlreadySet();
    /// @notice The service fee can no longer be changed because somebody already subscribed.
    error ServiceFeeLocked();
    /// @notice The round never sold out; no parts order may be placed.
    error NotSoldOutYet();

    /// @param sharePriceBnb_ Price of one share in wei.
    /// @param totalShares_ Share cap; also the sell-out threshold.
    /// @param fundingDeadline_ Funding deadline in unix seconds (inclusive).
    /// @param materialMarket_ Initial market; replaceable later via setMaterialMarket.
    /// @param owner_ Campaign owner (the factory owner in practice).
    /// @param transistors_ Parts contract locked for this round; must be whitelisted by the factory.
    constructor(
        uint256 sharePriceBnb_,
        uint256 totalShares_,
        uint64 fundingDeadline_,
        address materialMarket_,
        address owner_,
        address transistors_
    ) Ownable(owner_) {
        if (materialMarket_ == address(0) || transistors_ == address(0)) revert ZeroAddress();
        factory = msg.sender;
        if (totalShares_ == 0 || sharePriceBnb_ == 0) revert ZeroShares();
        sharePriceBnb = sharePriceBnb_;
        totalShares = totalShares_;
        fundingDeadline = fundingDeadline_;
        materialMarket = IMaterialMarket(materialMarket_);
        transistors = transistors_;
        scene = Scene.Funding;
        phase = Phase.None;
    }

    /// @dev Accept BNB only from a market that ever served this round: bid-cancel refunds, ask settlement
    ///      and withdraw() all land here and are credited to `raisedBnb`. Any other sender could inflate
    ///      the pool that refund() divides. Past markets stay accepted because settlement is asynchronous;
    ///      rejecting them would strand the principal in a market nothing can pull from.
    receive() external payable {
        if (!_isKnownMarket(msg.sender)) revert DirectTransferNotAllowed();
        raisedBnb += msg.value;
        // After pooling there is no refund path left, so a late market credit would sit in raisedBnb
        // with nothing able to spend it (recoverBnb keeps `raisedBnb` while shares are outstanding).
        // Book it into the holder-claimable surplus instead.
        if (pooled) _returnSurplus();
    }

    /// @dev True when the factory no longer lists this round. A reverting call counts as retired.
    function _retired() internal view returns (bool) {
        try IFactory(factory).isRegistered(address(this)) returns (bool live) {
            return !live;
        } catch {
            return true;
        }
    }

    /// @param who Address to test.
    /// @return True when `who` is the current market or ever served as one.
    function _isKnownMarket(address who) internal view returns (bool) {
        if (who == address(materialMarket)) return true;
        for (uint256 i = 0; i < _marketHistory.length; i++) {
            if (_marketHistory[i] == who) return true;
        }
        return false;
    }

    /// @notice Replace the material market. Blocked while a bid or an ask is live. Any BNB the current
    ///         market still owes this round is pulled first (attempted best-effort, so a market that cannot
    ///         pay never traps the round). The old market's ERC1155 approval is revoked on the way out, and
    ///         it stays an accepted BNB sender because settlement is asynchronous.
    /// @param materialMarket_ New market address; must be non-zero.
    function setMaterialMarket(address materialMarket_) external onlyOwner nonReentrant {
        if (materialMarket_ == address(0)) revert ZeroAddress();
        // Swapping markets with a live order/ask strands the escrow on the old market. Cancel first.
        if (phase == Phase.Listed) revert AlreadyListed();
        if (_askOpen()) revert AlreadyAsked();
        // owed() is per market, so proceeds left behind after a swap are unreachable (withdraw() can only
        // be called on the current market). Drain them first; a market that will not pay must not block
        // the swap, because that is exactly when the escape hatch is needed — the round matters more than
        // proceeds the old market cannot release.
        if (_owed() > 0) {
            try materialMarket.withdraw() {} catch {}
        }
        // Revoke the old market's operator approval, else it could still pull this round's ERC1155.
        // A failed revoke does not block the swap (an old market may not implement it) but leaves a trace.
        address previous = address(materialMarket);
        if (previous != materialMarket_) {
            _revokeApproval(previous);
        }
        emit MaterialMarketUpdated(previous, materialMarket_);
        materialMarket = IMaterialMarket(materialMarket_);
        if (previous != materialMarket_) {
            _marketHistory.push(previous);
        }
    }

    /// @dev Revoke a market's ERC1155 operator approval. Silent on failure — an old market may not
    ///      implement it.
    /// @param operator Former market whose approval is dropped.
    function _revokeApproval(address operator) internal {
        if (operator == address(0)) return;
        try IERC1155(transistors).setApprovalForAll(operator, false) {
            emit MaterialMarketApprovalRevoked(operator);
        } catch {
            // Ignore: an old / deprecated parts contract may not implement setApprovalForAll.
        }
    }

    /// @notice Set the mining-pool destination. Only before pooling; depositToPool() reverts with
    ///         PoolNotSet() while this is unset.
    /// @param pool_ Pool address; non-zero and not this contract.
    function setMiningPool(address pool_) external onlyOwner {
        if (pooled) revert AlreadyPooled();
        if (pool_ == address(0) || pool_ == address(this)) revert ZeroAddress();
        emit MiningPoolSet(miningPool, pool_);
        miningPool = pool_;
    }

    /// @notice Store the display-only hashpower estimate. Writable in Funding and Executing/Buying;
    ///         refused in Listed, Ready and Mining. Moves no BNB, ERC1155 or order state.
    /// @param estHashpower_ Estimated hashpower; read back by the UI only.
    function setPlan(uint256 estHashpower_) external onlyOwner {
        if (scene == Scene.Mining) revert WrongScene();
        if (scene == Scene.Executing && phase != Phase.Buying) revert WrongScene();
        estHashpower = estHashpower_;
        emit PlanUpdated(estHashpower_);
    }

    // ─────────────────────────── subscribe ───────────────────────────

    /// @notice Buy `count` shares for exactly count × sharePriceBnb. Allowed up to and including the
    ///         deadline; a sell-out moves the round to Executing/Buying. Subscription BNB is never
    ///         charged a service fee (the fee applies to mining output only, README §8 rule 1).
    /// @param count Shares to buy; must be > 0 and fit the remaining supply.
    function subscribe(uint256 count) external payable nonReentrant {
        if (scene != Scene.Funding) revert WrongScene();
        if (block.timestamp > fundingDeadline) revert FundingEnded();
        if (count == 0) revert ZeroShares();
        if (sold + count > totalShares) revert ExceedsRemaining();
        if (msg.value != count * sharePriceBnb) revert WrongPayment();

        _shares[msg.sender] += count;
        sold += count;
        outstandingShares += count;
        raisedBnb += msg.value;
        _trackHolder(msg.sender);

        if (sold == totalShares) {
            scene = Scene.Executing;
            _setPhase(Phase.Buying);
            soldOutAt = uint64(block.timestamp);
        }
        emit Subscribed(msg.sender, count, msg.value);
    }

    // ─────────────────────────── service fee (on-chain) ───────────────────────────

    /// @notice Set the service fee and its split table. Owner only, and only while `sold == 0`; frozen
    ///         afterwards so subscribers can trust the numbers they saw. 0 bps with an empty table means
    ///         no fee. Charged on mining output at depositRevenue(), never on subscription BNB.
    /// @param bps_ Fee rate in bps (1/10000), at most MAX_SERVICE_FEE_BPS (10%); 0 freezes "no fee".
    /// @param recipients_ Fee recipients, at most MAX_FEE_RECIPIENTS; empty only when bps_ == 0.
    /// @param sharesBps_ Per-recipient share in bps, aligned with recipients_; must sum to 10000.
    function setServiceFee(uint16 bps_, address[] calldata recipients_, uint16[] calldata sharesBps_) external onlyOwner {
        if (serviceFeeSet) revert ServiceFeeAlreadySet();
        if (sold != 0) revert ServiceFeeLocked();
        if (bps_ > MAX_SERVICE_FEE_BPS) revert BadFeeConfig();
        if (recipients_.length != sharesBps_.length) revert BadFeeConfig();
        if (recipients_.length > MAX_FEE_RECIPIENTS) revert BadFeeConfig();
        // Explicit "no fee": the table must be empty and there is no 10000-bps sum to satisfy, so this
        // freezes the round at 0 without touching the split loop.
        if (bps_ == 0) {
            if (recipients_.length != 0) revert BadFeeConfig();
            serviceFeeSet = true;
            emit ServiceFeeSet(0, recipients_, sharesBps_);
            return;
        }
        if (recipients_.length == 0) revert BadFeeConfig();

        uint256 sum = 0;
        for (uint256 i = 0; i < recipients_.length; i++) {
            if (recipients_[i] == address(0)) revert BadFeeConfig();
            if (sharesBps_[i] == 0) revert BadFeeConfig();
            for (uint256 j = 0; j < i; j++) {
                if (recipients_[j] == recipients_[i]) revert BadFeeConfig();
            }
            sum += sharesBps_[i];
        }
        if (sum != 10000) revert BadFeeConfig();

        serviceFeeBps = bps_;
        for (uint256 i = 0; i < recipients_.length; i++) {
            _feeRecipients.push(recipients_[i]);
            _feeSharesBps.push(sharesBps_[i]);
        }
        serviceFeeSet = true;
        emit ServiceFeeSet(bps_, recipients_, sharesBps_);
    }

    /// @notice Number of service-fee recipients.
    function feeRecipientCount() external view returns (uint256) {
        return _feeRecipients.length;
    }

    /// @param index Position in the fee table.
    /// @return Fee recipient at `index`; reverts BadFeeConfig when out of range.
    function feeRecipientAt(uint256 index) external view returns (address) {
        if (index >= _feeRecipients.length) revert BadFeeConfig();
        return _feeRecipients[index];
    }

    /// @param index Position in the fee table.
    /// @return Fee share in bps at `index`; reverts BadFeeConfig when out of range.
    function feeSharesBpsAt(uint256 index) external view returns (uint16) {
        if (index >= _feeSharesBps.length) revert BadFeeConfig();
        return _feeSharesBps[index];
    }

    /// @notice Pull your accrued service fee. A failed send reverts, so the accrual stays claimable.
    function claimFee() external nonReentrant {
        uint256 amt = pendingFee[msg.sender];
        if (amt == 0) revert ZeroShares();
        pendingFee[msg.sender] = 0;
        totalPendingFee -= amt;
        if (!_trySend(msg.sender, amt)) {
            pendingFee[msg.sender] = amt;
            totalPendingFee += amt;
            revert TransferFailed();
        }
        totalFeesPaid += amt;
        emit FeePaid(msg.sender, amt);
    }

    /// @dev Split `gross` into the fee table and the revenue pool, booking each recipient's cut.
    ///      Rounding dust stays in the revenue pool, so the fee is never over-charged.
    /// @param gross Deposited mining revenue.
    /// @return fee Amount withheld as service fee (0 when no fee is configured).
    function _accrueServiceFee(uint256 gross) internal returns (uint256 fee) {
        if (serviceFeeBps == 0 || _feeRecipients.length == 0) return 0;
        uint256 grossFee = (gross * serviceFeeBps) / 10000;
        if (grossFee == 0) return 0;
        for (uint256 i = 0; i < _feeRecipients.length; i++) {
            uint256 cut = (grossFee * _feeSharesBps[i]) / 10000;
            if (cut == 0) continue;
            pendingFee[_feeRecipients[i]] += cut;
            totalPendingFee += cut;
            fee += cut;
            emit FeeAccrued(_feeRecipients[i], cut);
        }
    }

    // ─────────────────────────── refund (pull) ───────────────────────────

    /// @notice Pull your principal. Nothing runs automatically at the deadline.
    ///         Allowed when: Funding is past the deadline and the round never sold out; Executing and
    ///         `executionFailed`; or Executing/Buying with `raisedBnb` below every outstanding share.
    ///         A full pool pays count × sharePriceBnb, a short pool pays pro-rata of `raisedBnb`.
    ///         Reverts while this wallet has escrowed shares, in Mining, and after returnSurplus() booked
    ///         the principal. The deadline path is the only principal exit for a round that never sold
    ///         out (README §8 rule 6); the ordering gate reads monotonic `sold` (rule 5).
    function refund() external nonReentrant {
        // returnSurplus() already paid the principal: refunding would zero the shares for 0 BNB.
        if (scene == Scene.Executing && surplusBase != 0) revert SurplusAlreadyReturned();
        // Ready holds the bought parts as the holders' asset. Paying the leftover BNB there would zero the
        // shares and hand the parts to the owner (recoverTransistors opens once nobody holds shares), so
        // this exit is closed even when executionFailed was flagged earlier. Ready ends via returnSurplus
        // + depositToPool, or via an explicit setPhase(1) admin recovery.
        if (scene == Scene.Executing && phase == Phase.Ready) revert RefundNotAvailable();
        bool execFailed = scene == Scene.Executing && executionFailed;
        bool short = scene == Scene.Executing && phase == Phase.Buying && _shortfall();
        // soldOutAt == 0 means the round never sold out (it is written when the scene turns Executing).
        bool neverSoldOut = scene == Scene.Funding && soldOutAt == 0 && block.timestamp > fundingDeadline;
        if (!neverSoldOut && !execFailed && !short) revert RefundNotAvailable();

        // A failed send must revert. Shares are cleared even when the amount rounds to 0, so a holder in
        // a short pool is never trapped with outstandingShares above 0.
        uint256 before = _shares[msg.sender];
        uint256 amount = _refundHolder(msg.sender, false);
        if (amount == 0 && _shares[msg.sender] == before) revert ZeroShares();
    }

    /// @dev Append `who` to the holder list once; later calls are no-ops.
    /// @param who Subscriber or listing buyer to record.
    function _trackHolder(address who) internal {
        if (_holderSeen[who]) return;
        _holderSeen[who] = true;
        _holders.push(who);
    }

    /// @dev Single writer for `phase`; emits PhaseChanged only on a real change. Every phase write goes
    ///      through here so off-chain state derived from events never misses a transition.
    /// @param next Phase to store.
    function _setPhase(Phase next) internal {
        uint8 previous = uint8(phase);
        phase = next;
        if (previous != uint8(next)) emit PhaseChanged(previous, uint8(next));
    }

    /// @dev Pay `who` their principal and clear their shares. The denominator is `outstandingShares`,
    ///      not `sold`: counting exited holders would leave the pool unpayable for the last few.
    ///      Shares are cleared even when the amount rounds to 0, so nobody is trapped with dust.
    /// @param who Wallet to settle.
    /// @param soft True (openRefund): a failed send is restored and skipped. False: it reverts.
    /// @return amount BNB sent; 0 when nothing was owed or the send was skipped.
    function _refundHolder(address who, bool soft) internal returns (uint256 amount) {
        uint256 s = _shares[who];
        if (s == 0 || _escrow[who] != 0 || outstandingShares == 0) return 0;
        // A full pool pays count × price. A short pool pays raise × shares / outstanding pro-rata.
        amount =
            raisedBnb >= outstandingShares * sharePriceBnb ? s * sharePriceBnb : (raisedBnb * s) / outstandingShares;
        _shares[who] = 0;
        outstandingShares -= s;
        if (amount == 0) {
            // Nothing to send, but the shares are settled: the holder is done and the pool keeps the dust
            // for the remaining holders (their pro-rata share grows as `outstandingShares` shrinks).
            emit Refunded(who, 0);
            return 0;
        }
        raisedBnb -= amount;
        if (!_trySend(who, amount)) {
            _shares[who] = s;
            outstandingShares += s;
            raisedBnb += amount;
            if (!soft) revert TransferFailed();
            emit RefundSendFailed(who, amount);
            return 0;
        }
        _refunded[who] += amount;
        totalRefunded += amount;
        emit Refunded(who, amount);
    }

    // ─────────────────────────── share transfer (Mining only) ───────────────────────────

    /// @notice Mining only. List `count` shares at `priceBnbPerShare` each; listed shares are locked until
    ///         sold or cancelled.
    /// @param count Shares to list; must be > 0 and unlocked.
    /// @param priceBnbPerShare Ask price per share in wei; must be > 0.
    function listShares(uint256 count, uint256 priceBnbPerShare) external {
        if (scene != Scene.Mining) revert WrongScene();
        if (count == 0) revert ZeroShares();
        if (priceBnbPerShare == 0) revert ZeroPrice();
        if (_shares[msg.sender] < count) revert InsufficientShares();

        _shares[msg.sender] -= count;
        _escrow[msg.sender] += count;
        _listings.push(Listing({seller: msg.sender, shares: count, priceBnbPerShare: priceBnbPerShare, open: true}));
        emit Listed(_listings.length - 1, msg.sender, count, priceBnbPerShare);
    }

    /// @notice Cancel a listing and unlock its shares. Seller or owner only.
    /// @param id Listing id.
    function cancelListing(uint256 id) external {
        if (scene != Scene.Mining) revert WrongScene();
        if (id >= _listings.length || !_listings[id].open) revert NoListing();
        Listing storage l = _listings[id];
        if (msg.sender != l.seller && msg.sender != owner) revert NotSeller();

        l.open = false;
        _escrow[l.seller] -= l.shares;
        _shares[l.seller] += l.shares;
        emit ListingCancelled(id, l.seller, l.shares);
    }

    /// @notice Mining only. Buy `count` shares from a listing; msg.value must equal count × price and is
    ///         paid straight to the seller.
    /// @param id Listing id.
    /// @param count Shares to buy; must be > 0 and at most the listing's remaining shares.
    function takeListing(uint256 id, uint256 count) external payable nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (id >= _listings.length || !_listings[id].open) revert NoListing();
        Listing storage l = _listings[id];
        if (msg.sender == l.seller) revert CannotTakeOwnListing();
        if (count == 0 || count > l.shares) revert BadCount();

        uint256 pay = count * l.priceBnbPerShare;
        if (msg.value != pay) revert WrongPayment();

        _escrow[l.seller] -= count;
        _shares[msg.sender] += count;
        _trackHolder(msg.sender);
        l.shares -= count;
        if (l.shares == 0) l.open = false;

        _send(l.seller, pay); // BNB paid to the seller immediately
        emit ListingTaken(id, msg.sender, l.seller, count, pay);
    }

    // ─────────────────────────── secondary-market bids (owner) ───────────────────────────

    /// @notice Place both legs of a buy order on the material market. Owner only, and only while
    ///         Executing/Buying. NAND is tokenId 0, LATCH is 1; the parts contract is the immutable
    ///         `transistors`, so it is not a parameter. Escrow (qty × price per leg) leaves `raisedBnb`
    ///         with placeBid, and a zero-qty leg is skipped (its bid id stays 0).
    ///         If the total cost exceeds `raisedBnb` the call sets `executionFailed` and places nothing —
    ///         it does NOT revert. One order at a time: a live ask must be cancelled first (a fully
    ///         filled ask is cleared here).
    /// @param nandQty_ NAND quantity; 0 skips the leg.
    /// @param nandPrice_ NAND bid price in wei per unit; ignored when nandQty_ is 0.
    /// @param latchQty_ LATCH quantity; 0 skips the leg.
    /// @param latchPrice_ LATCH bid price in wei per unit; ignored when latchQty_ is 0.
    function placeTransistorOrder(
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase != Phase.Buying) revert WrongScene();
        _requireNoLiveAsk();
        _requireLegParams(nandQty_, nandPrice_, latchQty_, latchPrice_);
        // `sold` is monotonic, so refunds can never revoke this gate (README §8 rule 5).
        if (sold < totalShares) revert NotSoldOutYet();
        // Retrying a previously failed order requires escrow that can still pay for it.
        if (executionFailed && raisedBnb == 0) revert RefundNotAvailable();

        uint256 nandCost = nandQty_ * uint256(nandPrice_);
        uint256 latchCost = latchQty_ * uint256(latchPrice_);
        uint256 cost = nandCost + latchCost;
        if (cost > raisedBnb) {
            executionFailed = true;
            emit ExecutionFailed(cost, raisedBnb);
            return;
        }

        executionFailed = false;
        raisedBnb -= cost;
        nandQty = nandQty_;
        latchQty = latchQty_;
        nandPrice = nandPrice_;
        latchPrice = latchPrice_;
        priceLock = cost;
        nandBidId = _placeBidLeg(0, nandQty_, nandPrice_, nandCost);
        latchBidId = _placeBidLeg(1, latchQty_, latchPrice_, latchCost);
        _setPhase(Phase.Listed);
        // Each order pushes the non-owner markFailed grace period forward: an owner who keeps
        // making progress is never griefed by a bystander.
        lastOrderAt = uint64(block.timestamp);
        emit TransistorOrderPlaced(nandQty_ + latchQty_, cost);
    }

    /// @notice Book the unspent subscription BNB as holder-claimable surplus without ending the round:
    ///         parts stay here, `phase` stays Ready and depositToPool() stays available. No holder loop —
    ///         each holder pulls a pro-rata cut with claimSurplus().
    ///         Requires a settled market (no open ask, no ask awaiting confirmation, nothing owed) so sale
    ///         proceeds never mix into a principal return. Afterwards openRefund / abandonOrder are closed.
    function returnSurplus() external onlyOwner nonReentrant {
        _requireReady();
        if (pooled) revert AlreadyPooled();
        // _askRecorded() also covers a still-open ask, so _askOpen() would be redundant here.
        if (_askRecorded() || _owed() > 0) revert AlreadyAsked();
        if (outstandingShares == 0) revert ZeroShares();
        if (raisedBnb == 0) revert ZeroShares();
        _returnSurplus();
        emit SurplusReturned(surplusPool, surplusBase);
    }

    /// @notice Refund every holder. Only from Executing/Buying: in Ready the exit is returnSurplus()
    ///         (reverts with UseReturnSurplus) because the parts must follow the mining path. Ready →
    ///         Buying via setPhase is an explicit admin recovery, not a normal exit. Closed once
    ///         returnSurplus() already paid the principal out.
    function openRefund() external onlyOwner nonReentrant {
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        // outstandingShares == 0 means nobody is left to refund; the dust is swept by recoverBnb.
        if (outstandingShares == 0) revert ZeroShares();
        // Rejects Listed and None too: only Buying has a refundable bid-side state.
        if (phase != Phase.Buying) revert WrongScene();
        _requireNoLiveAsk();
        if (_owed() > 0) revert AlreadyAsked();
        markFailed();
        _refundAll();
    }

    /// @notice Give up from Buying or Listed: cancel the remaining bid and open asks, withdraw what the
    ///         market owes, refund every holder, and only then return the remaining parts to the owner
    ///         (skipped while a holder still holds shares). Refused in Ready (there the exit is
    ///         returnSurplus + depositToPool) and closed once returnSurplus() paid the principal out.
    function abandonOrder() external onlyOwner nonReentrant {
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        // Cancel before the ask/parts move: the phase must be Buying when the refund loop runs.
        // markFailed() below would repeat this, but only when it does not early-return.
        _cancelLiveOrder();
        _cancelOpenAsk();
        _pullOwed();
        markFailed();
        _refundAll();
        // Parts move to the owner only once every share is settled: while shares are outstanding they are
        // the holders' collateral (see recoverTransistors). A holder that rejected BNB keeps its shares,
        // so this is skipped and the owner can retry after that holder pulls its own refund.
        if (outstandingShares == 0) _returnHeldParts();
    }

    /// @dev Soft-fail refund loop over every recorded holder.
    function _refundAll() internal {
        uint256 n = _holders.length;
        for (uint256 i = 0; i < n; i++) {
            _refundHolder(_holders[i], true);
        }
    }

    /// @notice Cancel the open remainder of the bid and return to Buying. Owner only while nothing has
    ///         filled; once any quantity filled, anyone may cancel the rest. Refused when the order is
    ///         fully filled and the parts are already here. cancelBid refunds the unfilled escrow into
    ///         receive(); filled quantity stays spent. A round dropped from the factory registry is
    ///         cancellable by anyone, since its owner may be gone.
    function cancelTransistorOrder() external nonReentrant {
        if (phase != Phase.Listed) revert NotListed();
        bool touched = _filledSome(nandBidId, nandQty) || _filledSome(latchBidId, latchQty);
        if (orderFilled() && _partsOnHand()) revert OrderFilled();
        if (!touched && msg.sender != owner && !_retired()) revert NotOwner(msg.sender);
        _cancelLiveOrder();
    }

    /// @notice Flag the round as failed so holders can refund. The owner may call at any time; anyone else
    ///         only after FAIL_GRACE measured from max(soldOutAt, lastOrderAt), so every order pushes the
    ///         grace forward and a round that never orders after selling out is not killed instantly.
    ///         Cancels the unfilled bid legs first so their escrow returns to `raisedBnb`. Refused in Ready:
    ///         the parts are already here, so flagging failure would let holders take a pro-rata cash refund
    ///         and drop their claim on the parts (which the owner could then recover) — Ready exits through
    ///         returnSurplus + depositToPool instead. No-op when already failed or not Executing; reverts
    ///         after returnSurplus() booked the principal.
    function markFailed() public {
        if (scene != Scene.Executing || executionFailed) return;
        // returnSurplus() already returned the principal; flagging a refund would burn shares for 0 BNB.
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        uint256 graceBase = uint256(lastOrderAt) > uint256(soldOutAt) ? uint256(lastOrderAt) : uint256(soldOutAt);
        if (msg.sender != owner && block.timestamp < graceBase + FAIL_GRACE) {
            revert RefundNotAvailable();
        }
        executionFailed = true; // CEI: set before the market callback; a revert below rolls it back with the tx.
        // Pull the live bid's escrow back into raisedBnb so holders refund against the real pool.
        // A refused cancel reverts the tx, so markFailed can simply be retried.
        _cancelLiveOrder();
        emit ExecutionFailed(0, raisedBnb);
    }

    /// @notice List parts held after the buy was confirmed. Ready only — in Buying a partial fill must be
    ///         cancelled or filled and confirmed first. Reverts while any ask leg is live. Approves the
    ///         market once, then places one ask per non-zero leg.
    /// @param nandQty_ NAND quantity to sell; 0 skips the leg.
    /// @param nandPrice_ NAND ask price in wei per unit; ignored when nandQty_ is 0.
    /// @param latchQty_ LATCH quantity to sell; 0 skips the leg.
    /// @param latchPrice_ LATCH ask price in wei per unit; ignored when latchQty_ is 0.
    function placeTransistorAsk(
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external onlyOwner nonReentrant {
        _requireReady();
        _requireLegParams(nandQty_, nandPrice_, latchQty_, latchPrice_);
        _requireNoLiveAsk();

        IERC1155 token = IERC1155(transistors);
        if (nandQty_ > 0 && token.balanceOf(address(this), 0) < nandQty_) revert InsufficientParts();
        if (latchQty_ > 0 && token.balanceOf(address(this), 1) < latchQty_) revert InsufficientParts();
        // Idempotent; skips the extra isApprovedForAll SLOAD/external call.
        token.setApprovalForAll(address(materialMarket), true);

        nandAskQty = nandQty_;
        latchAskQty = latchQty_;
        nandAskPrice = nandPrice_;
        latchAskPrice = latchPrice_;
        nandAskId = _placeAskLeg(0, nandQty_, nandPrice_);
        latchAskId = _placeAskLeg(1, latchQty_, latchPrice_);
        emit TransistorAskPlaced(nandQty_, latchQty_, nandAskId, latchAskId);
    }

    /// @notice Cancel the unsold ask remainder so the parts return here; fully filled legs are skipped.
    ///         Pull proceeds with withdrawMarketProceeds() after fills.
    function cancelTransistorAsk() external onlyOwner nonReentrant {
        if (!_askRecorded()) revert NotAsked();
        _cancelOpenAsk();
        emit TransistorAskCancelled();
    }

    /// @notice Close a settled ask: pull owed BNB, clear the ask record and return to Buying (the only phase
    ///         that can place another bid or settle a refund after a sale). Ready only.
    function confirmSale() external onlyOwner nonReentrant {
        _requireReady();
        if (_askOpen()) revert AlreadyAsked();
        uint256 owed = _owed();
        if (!_askRecorded() && owed == 0) revert NotAsked();
        _pullOwed();
        _clearAsk();
        _setPhase(Phase.Buying);
        emit AskSettled(owed);
    }

    /// @notice Pull proceeds owed by the market into `raisedBnb` (via receive). Anyone may call; no-op
    ///         when nothing is owed.
    function withdrawMarketProceeds() external nonReentrant {
        _pullOwed();
    }

    /// @notice Move Listed → Ready once both legs have remaining == 0 and this contract holds the parts.
    ///         Does not move tokens; a zero-qty leg counts as filled.
    function confirmTransistors() external {
        _requireExecuting();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase != Phase.Listed) revert NotListed();
        if (!_readyInvariant()) revert TransistorsNotReady();
        _setPhase(Phase.Ready);
        emit TransistorsConfirmed();
    }

    /// @notice True when both bid legs have no market remainder; a skipped leg counts as filled.
    /// @return Whether the order is fully filled.
    function orderFilled() public view returns (bool) {
        return _legFilled(nandBidId) && _legFilled(latchBidId);
    }

    /// @notice Escape hatch: move ERC1155 tokens held here to the owner so nothing is stranded. Not for
    ///         normal flow. Blocked while a bid is live, after pooling, and for the round's own parts while
    ///         shares are outstanding (settle the holders first with openRefund/abandonOrder, or send the
    ///         parts to the pool/market instead). Does not touch the order, the price lock or the scene.
    /// @param token ERC1155 contract; not restricted to `transistors`, so foreign tokens can be moved too.
    /// @param id Token id (0 NAND, 1 LATCH for the round's parts).
    /// @param amount Units to transfer.
    function recoverTransistors(address token, uint256 id, uint256 amount) external onlyOwner nonReentrant {
        if (phase == Phase.Listed) revert AlreadyListed();
        if (pooled) revert AlreadyPooled();
        if (token == address(0)) revert ZeroAddress();
        // The round's own parts are the collateral behind the outstanding shares. They may only leave
        // through depositToPool() (to the pool) or the market (placeTransistorAsk), or after every holder
        // has been settled — otherwise the owner could take the asset and leave the shares unpaid.
        if (token == transistors && outstandingShares != 0) revert SharesOutstanding();
        IERC1155(token).safeTransferFrom(address(this), owner, id, amount, "");
        emit TransistorsRecovered(token, id, amount, owner);
    }

    // ─────────────────────────── mining pool (commit) ───────────────────────────

    /// @notice Commit the round's transistors to the mining pool. IRREVERSIBLE. Ready only.
    ///         1. Book the unspent subscription BNB as holder-claimable surplus before the parts leave
    ///            (idempotent: only newly arrived BNB is added if returnSurplus() already booked it).
    ///         2. Send every held part (NAND id 0, LATCH id 1) to `miningPool`.
    ///         3. Set `pooled` and enter Mining.
    ///         Requires a settled purchase, not the exact ordered quantity: a round that sold some parts
    ///         legitimately holds less, and the sale proceeds were booked for holders in step 1.
    ///         Afterwards recoverTransistors / refund / abandonOrder / markFailed revert. The pool must
    ///         implement onERC1155Received. Gas is O(1) in holder count (holders pull via claimSurplus).
    function depositToPool() external onlyOwner nonReentrant {
        if (pooled) revert AlreadyPooled();
        _requireReady();
        if (miningPool == address(0)) revert PoolNotSet();
        if (!_purchaseSettled()) revert TransistorsNotReady();

        // Before the parts go: the leftover subscription BNB becomes the holders' pull-claimable surplus.
        _returnSurplus();

        IERC1155 token = IERC1155(transistors);
        uint256 nandAmt = token.balanceOf(address(this), 0);
        uint256 latchAmt = token.balanceOf(address(this), 1);
        if (nandAmt > 0) token.safeTransferFrom(address(this), miningPool, 0, nandAmt, "");
        if (latchAmt > 0) token.safeTransferFrom(address(this), miningPool, 1, latchAmt, "");

        pooled = true;
        scene = Scene.Mining;
        emit DepositedToPool(miningPool, nandAmt, latchAmt);
    }

    /// @notice PLACEHOLDER — BEM distribution is not implemented; a no-op so the Mining ABI stays stable.
    ///         Mining revenue in BNB is already claimable by holders through claimSurplus().
    function harvest() external nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
    }

    /// @notice PLACEHOLDER — BEM distribution is not implemented. BNB revenue is not withdrawn here:
    ///         depositRevenue books it into the pull-claimable surplus (see claimSurplus).
    /// @return Always 0 until distribution lands.
    function claim() external nonReentrant returns (uint256) {
        if (scene != Scene.Mining) revert WrongScene();
        return 0;
    }

    /// @notice Deposit mining revenue. Only `miningPool` may call. The only on-chain fee collection point:
    ///         fee = msg.value × serviceFeeBps / 10000 split over the recipient table, and the net is added
    ///         to the holders' pull-claimable surplus (claimSurplus) so it is never parked in a pot with no
    ///         exit. Dust stays with the holders, so the fee is never over-charged; the fee is pulled via
    ///         claimFee() rather than pushed, so a rejecting recipient cannot block this call.
    function depositRevenue() external payable nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (msg.sender != miningPool) revert NotOwner(msg.sender);
        if (msg.value == 0) revert ZeroPrice();

        uint256 fee = _accrueServiceFee(msg.value);
        uint256 net = msg.value - fee;
        // Cumulative display total only: the money itself is booked below, so revenuePool must never be
        // added to recoverBnb's reserve (that would double-count it).
        revenuePool += net;
        if (net != 0) {
            // With shares outstanding the revenue is immediately claimable; with none left it stays in
            // raisedBnb so recoverBnb can sweep it to the owner.
            if (outstandingShares == 0) raisedBnb += net;
            else _bookSurplus(net);
        }
        emit RevenueDeposited(msg.value, fee, net);
    }

    // ─────────────────────────── views ───────────────────────────
    // scene and phase already have public getters. Do not wrap them again.

    /// @param account Wallet to query.
    /// @return Unlocked shares held by `account`.
    function sharesOf(address account) external view returns (uint256) {
        return _shares[account];
    }

    /// @notice Number of recorded holders, in first-seen order. Share counts are on sharesOf().
    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    /// @param index Position in the holder list.
    /// @return Holder address at `index`; reverts when out of range.
    function holderAt(uint256 index) external view returns (address) {
        return _holders[index];
    }

    /// @param account Wallet to query.
    /// @return Shares locked in an open listing.
    function escrowOf(address account) external view returns (uint256) {
        return _escrow[account];
    }

    /// @param account Wallet to query.
    /// @return Principal BNB refunded to the wallet; excludes surplus claims.
    function refundedOf(address account) external view returns (uint256) {
        return _refunded[account];
    }

    /// @param account Wallet to query.
    /// @return Surplus BNB the wallet claimed through claimSurplus().
    function surplusClaimedOf(address account) external view returns (uint256) {
        return _surplusClaimed[account];
    }

    /// @notice Number of listings ever created; ids run 0..listingCount()-1.
    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    /// @notice Listing detail by id. Callers read ids 0..listingCount()-1.
    /// @param id Listing id.
    /// @return seller Listing seller.
    /// @return shares Shares still on the listing.
    /// @return priceBnbPerShare Ask price per share in wei.
    /// @return open Whether the listing can still be taken.
    function getListing(uint256 id) external view returns (address seller, uint256 shares, uint256 priceBnbPerShare, bool open) {
        if (id >= _listings.length) revert NoListing();
        Listing storage l = _listings[id];
        return (l.seller, l.shares, l.priceBnbPerShare, l.open);
    }

    // ─────────────────────────── internal ───────────────────────────

    /// @dev Book `raisedBnb` as holder-claimable surplus. No holder loop: only surplusPool / surplusBase
    ///      are stored and holders pull in claimSurplus(). No-op when it is 0 or no shares are outstanding.
    function _returnSurplus() internal {
        uint256 pool = raisedBnb;
        if (pool == 0) return;
        // Nobody left to pay: keep the money in raisedBnb so recoverBnb can still see it, instead of
        // booking a pool that no share can ever claim (surplusBase would be 0).
        if (outstandingShares == 0) return;
        _bookSurplus(pool);
        // The principal pool is zeroed: the money is now tracked by surplusPool and distributed by
        // claimSurplus(). recoverBnb reserves surplusPool − surplusPaid, so the owner cannot sweep it.
        raisedBnb = 0;
    }

    /// @dev Add `amount` to the pull-claimable surplus. The first booking of a round fixes the denominator
    ///      at the current outstandingShares; later top-ups (a settlement after returnSurplus, a late
    ///      market credit after pooling, or mining revenue) share the same base, which cannot drift because
    ///      shares are only ever transferred after pooling. Counters are never reset inside a round, or
    ///      early claimants would be paid twice.
    ///      Once a round has counted every base share it cannot pay another wei, so fresh money opens a new
    ///      round. That is what keeps a second revenue deposit claimable instead of locked forever.
    ///      Callers guarantee outstandingShares != 0.
    /// @param amount Wei to book.
    function _bookSurplus(uint256 amount) internal {
        surplusPool += amount;
        if (surplusBase == 0 || surplusClaimedShares >= surplusBase) {
            surplusRound += 1;
            surplusRoundPool = amount;
            surplusBase = outstandingShares;
            surplusClaimedShares = 0;
            surplusAllocated = 0;
        } else {
            surplusRoundPool += amount;
        }
    }

    /// @notice Claim your booked surplus. Covers the lazily computed entitlement plus any accrued amount
    ///         whose earlier transfer failed. A failed send reverts, so the accrual stays claimable.
    function claimSurplus() external nonReentrant {
        uint256 amt = pendingSurplus[msg.sender];
        if (amt == 0) {
            amt = _accrueSurplus(msg.sender);
            if (amt == 0) revert ZeroShares();
        }
        pendingSurplus[msg.sender] = 0;
        totalPendingSurplus -= amt;
        surplusPaid += amt;
        if (!_trySend(msg.sender, amt)) {
            // Still undeliverable: the whole tx reverts and the money in pendingSurplus is kept as-is;
            // the holder can retry (or switch address / use a smart-contract wallet).
            revert TransferFailed();
        }
        _surplusClaimed[msg.sender] += amt;
        emit SurplusClaimed(msg.sender, amt);
    }

    /// @dev The single source of the surplus math: which shares of `who` are uncounted and what they are
    ///      worth, in the current round. View-only, so the writer (_accrueSurplus) and the view (surplusOf)
    ///      cannot diverge.
    ///      Listed shares count too: they are still the holder's until a buyer takes them, and excluding
    ///      them would lock a seller out of the claim for as long as the listing lives (cancel-only).
    /// @param who Wallet to evaluate.
    /// @return newShares Uncounted shares; 0 when nothing is left or the shares exceed the base.
    /// @return amt BNB those shares are worth (the last claimant also takes the rounding dust).
    /// @return already Shares already counted for `who` in this round.
    function _surplusEntitlement(address who) internal view returns (uint256 newShares, uint256 amt, uint256 already) {
        uint256 s = _shares[who] + _escrow[who];
        if (s == 0 || surplusBase == 0 || surplusRoundPool == 0) return (0, 0, 0);
        if (surplusCountedRound[who] == surplusRound) already = surplusCounted[who];
        if (already >= s) return (0, 0, already);
        newShares = s - already;
        // Shares that grew past the base after booking are not paid out.
        if (surplusClaimedShares + newShares > surplusBase) {
            newShares = surplusBase - surplusClaimedShares;
            if (newShares == 0) return (0, 0, already);
        }
        amt = (surplusRoundPool * newShares) / surplusBase;
        // The claimant who completes the base takes everything left (including earlier rounding dust).
        if (surplusClaimedShares + newShares == surplusBase) {
            amt = surplusRoundPool - surplusAllocated;
        }
    }

    /// @dev Book a holder's entitlement into pendingSurplus. Each share is counted once per round
    ///      (surplusCounted + surplusCountedRound), so repeated calls never pay twice.
    /// @param who Wallet to accrue for.
    /// @return amt Newly booked amount (0 when nothing is left to count).
    function _accrueSurplus(address who) internal returns (uint256 amt) {
        uint256 newShares;
        uint256 already;
        (newShares, amt, already) = _surplusEntitlement(who);
        if (newShares == 0) return 0;
        surplusCounted[who] = already + newShares;
        surplusCountedRound[who] = surplusRound;
        surplusClaimedShares += newShares;
        surplusAllocated += amt;
        pendingSurplus[who] += amt;
        totalPendingSurplus += amt;
        emit SurplusAccrued(who, amt);
    }

    /// @notice Surplus claimable by `who` right now, including the not-yet-booked part. Display only.
    /// @param who Wallet to query.
    /// @return BNB `who` could take with claimSurplus().
    function surplusOf(address who) external view returns (uint256) {
        uint256 amt = pendingSurplus[who];
        if (amt != 0) return amt;
        (, amt, ) = _surplusEntitlement(who);
        return amt;
    }

    /// @dev Only abandonOrder() calls this, after the bid is cancelled and every share is settled, so no
    ///      live order exists and the parts no longer back anyone's shares.
    ///      An owner that cannot receive ERC1155 must not block the refund: the transfer is skipped.
    function _returnHeldParts() internal {
        IERC1155 token = IERC1155(transistors);
        for (uint256 id = 0; id < 2; id++) {
            uint256 amount = token.balanceOf(address(this), id);
            if (amount == 0) continue;
            try token.safeTransferFrom(address(this), owner, id, amount, "") {} catch {}
        }
    }

    /// @dev Thin wrapper over the market getter, so every caller reads the same `owed(address(this))`.
    /// @return BNB the market still owes this round.
    function _owed() internal view returns (uint256) {
        return materialMarket.owed(address(this));
    }

    /// @dev Revert unless the round is in the Executing scene.
    function _requireExecuting() internal view {
        if (scene != Scene.Executing) revert WrongScene();
    }

    /// @dev Revert unless the round is Executing/Ready, the only phase that sells or pools parts.
    function _requireReady() internal view {
        _requireExecuting();
        if (phase != Phase.Ready) revert TransistorsNotReady();
    }

    /// @dev The purchase invariant: a real order was paid for (`priceLock`) and the market has nothing left
    ///      to fill. The priceLock term is essential: a never-ordered (or cancelled) round has bid ids 0, so
    ///      orderFilled() would read true and the round could otherwise reach Ready → Mining with no purchase.
    ///      `_partsOnHand()` is deliberately NOT part of this check: after a partial sale in Ready the round
    ///      legitimately holds fewer parts than it ordered, and requiring the full quantity would trap the
    ///      remainder and the sale proceeds with no exit (see confirmTransistors for the delivery proof).
    /// @return Whether a real, fully filled purchase backs the round.
    function _purchaseSettled() internal view returns (bool) {
        return priceLock != 0 && orderFilled();
    }

    /// @dev The delivery invariant, enforced when the round first becomes Ready: the purchase is settled
    ///      AND the ordered quantity is already on hand, so a market that burns the escrow without
    ///      delivering cannot masquerade as a finished round.
    /// @return Whether the round may be confirmed Ready.
    function _readyInvariant() internal view returns (bool) {
        return _purchaseSettled() && _partsOnHand();
    }

    /// @dev Reject an order with both legs empty (ZeroShares) or a funded leg priced 0 (ZeroPrice).
    /// @param nandQty_ NAND quantity.
    /// @param nandPrice_ NAND price in wei; must be > 0 when nandQty_ > 0.
    /// @param latchQty_ LATCH quantity.
    /// @param latchPrice_ LATCH price in wei; must be > 0 when latchQty_ > 0.
    function _requireLegParams(uint256 nandQty_, uint96 nandPrice_, uint256 latchQty_, uint96 latchPrice_) internal pure {
        if (nandQty_ == 0 && latchQty_ == 0) revert ZeroShares();
        if ((nandQty_ > 0 && nandPrice_ == 0) || (latchQty_ > 0 && latchPrice_ == 0)) revert ZeroPrice();
    }

    /// @dev Place one bid leg. Returns 0 for a zero quantity; reverts BadBidId when the market returns 0.
    /// @param tokenId 0 NAND, 1 LATCH.
    /// @param qty Units to bid for.
    /// @param price Bid price in wei per unit.
    /// @param cost Escrow sent with the bid (qty × price).
    /// @return id Market bid id, or 0 when the leg is skipped.
    function _placeBidLeg(uint8 tokenId, uint256 qty, uint96 price, uint256 cost) internal returns (uint256 id) {
        if (qty == 0) return 0;
        id = materialMarket.placeBid{value: cost}(transistors, tokenId, price, qty);
        if (id == 0) revert BadBidId();
    }

    /// @dev Place one ask leg. Returns 0 for a zero quantity. An id of 0 would make _askOpen() read
    ///      remaining 0 and silently unlock a second order, so it reverts with BadAskId.
    /// @param tokenId 0 NAND, 1 LATCH.
    /// @param qty Units to list.
    /// @param price Ask price in wei per unit.
    /// @return id Market ask id, or 0 when the leg is skipped.
    function _placeAskLeg(uint8 tokenId, uint256 qty, uint96 price) internal returns (uint256 id) {
        if (qty == 0) return 0;
        id = materialMarket.placeAsk(transistors, tokenId, price, qty);
        if (id == 0) revert BadAskId();
    }

    /// @dev No quantity argument is needed: a skipped leg has id 0, and _remaining(0) already reads 0,
    ///      so the "empty leg counts as filled" rule falls out of the id check.
    /// @param id Market bid id; 0 reads as filled.
    /// @return Whether the leg has no market remainder.
    function _legFilled(uint256 id) internal view returns (bool) {
        return _remaining(id) == 0;
    }

    /// @dev True when at least one unit was taken, including a leg already down to remaining 0.
    /// @param id Market bid id; 0 reads as remaining 0.
    /// @param qty Quantity the round ordered on that leg; a skipped leg leaves both at 0, so 0 < 0 is false.
    /// @return Whether remaining < qty, i.e. somebody filled part of it.
    function _filledSome(uint256 id, uint256 qty) internal view returns (bool) {
        return _remaining(id) < qty;
    }

    /// @dev Cancel the unfilled remainder. A filled leg is left alone because cancelBid would revert, and
    ///      a skipped leg has id 0, which _remaining() reports as 0 without calling the market.
    /// @param id Market bid id.
    function _cancelOpenLeg(uint256 id) internal {
        if (_remaining(id) != 0) materialMarket.cancelBid(id);
    }

    /// @dev True when `raisedBnb` can no longer repay every outstanding share at the subscription price.
    /// @return Whether refund() would pay pro-rata instead of in full.
    function _shortfall() internal view returns (bool) {
        return raisedBnb < outstandingShares * sharePriceBnb;
    }

    /// @dev Parts for the live order are already in this contract. Token id 0 is NAND, 1 is LATCH.
    /// @return Whether every ordered leg has been delivered.
    function _partsOnHand() internal view returns (bool) {
        IERC1155 token = IERC1155(transistors);
        return (nandQty <= token.balanceOf(address(this), 0)) && (latchQty <= token.balanceOf(address(this), 1));
    }

    /// @param id Bid id; 0 reads as fully filled.
    /// @return remaining Unfilled quantity on the bid.
    function _remaining(uint256 id) internal view returns (uint256 remaining) {
        if (id == 0) return 0;
        (,,,,, remaining) = materialMarket.bids(id);
    }

    /// @dev Drop the live bid: ids, quantities and prices go back to 0 so no reader sees a stale order
    ///      (readers gate on id != 0).
    function _clearOrder() internal {
        nandBidId = latchBidId = nandQty = latchQty = 0;
        nandPrice = 0;
        latchPrice = 0;
        priceLock = 0;
    }

    /// @dev Cancel both open bid legs, drop the record and return to Buying. No-op unless Listed.
    function _cancelLiveOrder() internal {
        if (phase != Phase.Listed) return;
        _cancelOpenLeg(nandBidId);
        _cancelOpenLeg(latchBidId);
        _clearOrder();
        _setPhase(Phase.Buying);
        emit TransistorOrderCancelled();
    }

    /// @dev Withdraw whatever the market owes this round; receive() credits `raisedBnb`. No-op at 0.
    function _pullOwed() internal {
        if (_owed() > 0) materialMarket.withdraw();
    }

    /// @dev True when an ask is recorded, whether still open or already filled.
    function _askRecorded() internal view returns (bool) {
        return (nandAskQty | latchAskQty) != 0;
    }

    /// @dev Revert while any ask leg still has a market remainder; otherwise drop a fully filled record so
    ///      no ghost order shows up in the UI. One _askOpen() call instead of purge-then-check.
    function _requireNoLiveAsk() internal {
        if (_askOpen()) revert AlreadyAsked();
        if (_askRecorded()) _clearAsk();
    }

    /// @dev True while any ask leg still has a market remainder. The `qty > 0` guards are unnecessary:
    ///      a skipped leg has id 0 and _askRemaining(0) returns 0 without a market call.
    function _askOpen() internal view returns (bool) {
        return _askRemaining(nandAskId) > 0 || _askRemaining(latchAskId) > 0;
    }

    /// @param id Ask id; 0 reads as fully filled.
    /// @return remaining Unfilled quantity on the ask.
    function _askRemaining(uint256 id) internal view returns (uint256 remaining) {
        if (id == 0) return 0;
        (,,,, remaining) = materialMarket.asks(id);
    }

    /// @dev Cancel both open ask legs and drop the record. Fully filled legs are skipped.
    function _cancelOpenAsk() internal {
        uint256 a = nandAskId;
        uint256 b = latchAskId;
        _clearAsk();
        if (_askRemaining(a) != 0) materialMarket.cancelAsk(a);
        if (_askRemaining(b) != 0) materialMarket.cancelAsk(b);
    }

    /// @dev Drop the ask record: ids, quantities and prices.
    function _clearAsk() internal {
        nandAskId = latchAskId = nandAskQty = latchAskQty = 0;
        nandAskPrice = 0;
        latchAskPrice = 0;
    }

    /// @dev Official fillBid uses ERC1155 safeTransfer. The caller is not checked; the hook only returns the receiver selector.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    /// @notice Batch delivery hook.
    /// @dev Required when the market delivers both legs in one safeBatchTransferFrom: without it the
    ///      delivery reverts after `remaining` was already decremented, trapping the principal and the
    ///      parts (confirmTransistors / depositToPool could never pass).
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    /// @notice ERC165 declaration; some implementations pre-check it before safeTransferFrom.
    /// @param interfaceId Interface to test.
    /// @return Whether this contract claims `interfaceId`.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0xd9b67a26 || // ERC1155
            interfaceId == 0x4e2312e0; // ERC1155TokenReceiver (onERC1155Received ^ onERC1155BatchReceived)
    }

    /// @notice Owner escape while Executing: rewrite the sub-phase so a stuck round can reach refund or
    ///         recovery. Moves no tokens and does not cancel a market order. Current Listed is refused —
    ///         cancel or abandon the live bid first, or its escrow stays on the market.
    ///         Entering Ready requires a settled purchase (`priceLock` + fully filled), so a round with no
    ///         paid order cannot reach Ready/Mining; the delivery proof is only required on the normal
    ///         Listed → Ready path, because a partly sold round legitimately holds fewer parts and must
    ///         still be able to book the proceeds (returnSurplus) and pool the remainder.
    ///         Entering Listed requires a live bid id. Every other direction stays open (Ready → Buying is
    ///         the recovery path).
    /// @param next Target phase: 1 Buying, 2 Listed (needs a live bid), 3 Ready (needs a settled purchase).
    ///        None (0) is refused: it would close ordering and every refund path except abandonOrder().
    function setPhase(uint8 next) external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Listed) revert AlreadyListed();
        // Listed means a live bid exists. Faking it would leave no cancel path and block every later
        // setPhase through the AlreadyListed guard above.
        if (next == uint8(Phase.Listed) && nandBidId == 0 && latchBidId == 0) revert WrongScene();
        if (next == uint8(Phase.None) || next > uint8(Phase.Ready)) revert WrongScene();
        if (next == uint8(Phase.Ready) && !_purchaseSettled()) revert TransistorsNotReady();
        _setPhase(Phase(next));
    }

    /// @notice Sweep BNB no share is entitled to; the recipient is always the owner. No amount argument:
    ///         one call moves everything safe to move. While shares are outstanding only the excess over
    ///         `raisedBnb` leaves; once every share has left the whole balance leaves and `raisedBnb` is
    ///         zeroed. Unclaimed fees and unclaimed surplus are never touched.
    function recoverBnb() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        // Reserved: unclaimed fees plus unclaimed surplus (surplusPool − surplusPaid, which already
        // contains the booked mining revenue and the not-yet-claimed totalPendingSurplus — neither may be
        // added again). revenuePool is a cumulative display total, not a separate pot.
        uint256 reserved = totalPendingFee;
        if (surplusPool > surplusPaid) reserved += surplusPool - surplusPaid;
        if (outstandingShares == 0) {
            // Every share settled: the escrow pool is released.
            if (amount <= reserved) revert ZeroShares();
            amount -= reserved;
            raisedBnb = 0;
        } else {
            // Shares outstanding: only the excess over escrow + reserves may leave.
            uint256 keep = raisedBnb + reserved;
            if (amount <= keep) revert ZeroShares();
            amount -= keep;
        }
        if (amount == 0) revert ZeroShares();
        _send(owner, amount);
        emit BnbRecovered(amount, owner);
    }

    /// @dev Low-level send; returns false instead of reverting on a rejecting recipient.
    /// @param to Recipient.
    /// @param amount Wei to send.
    /// @return ok Whether the recipient accepted the BNB.
    function _trySend(address to, uint256 amount) internal returns (bool ok) {
        (ok, ) = to.call{value: amount}("");
    }

    /// @dev Send or revert with TransferFailed.
    /// @param to Recipient.
    /// @param amount Wei to send.
    function _send(address to, uint256 amount) internal {
        if (!_trySend(to, amount)) revert TransferFailed();
    }
}
