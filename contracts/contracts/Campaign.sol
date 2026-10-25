// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {IERC1155} from "./interfaces/IERC1155.sol";
import {IMaterialMarket} from "./interfaces/IMaterialMarket.sol";

/// @title Campaign — one BEM crowdfunding round
/// @notice Scenes: Funding → Executing → Mining; Executing phases: Buying → Listed → Ready.
///         Funding:   subscription BNB accumulates in `raisedBnb`.
///         Executing: `placeTransistorOrder` spends it on parts; an unaffordable order sets
///                    `executionFailed` without reverting.
///         Mining:    `depositToPool` sends the parts to `miningPool` (IRREVERSIBLE) after booking the
///                    leftover BNB as holder-claimable surplus. harvest / claim are placeholders.
///         Holder payouts are pulls (refund / claimSurplus / claimFee); share sales are Mining-only and
///         pay the seller directly. Only a market that served this round may send BNB in (see receive).
///         Rules: contracts/README.md §8.
interface IFactory {
    /// @param campaign Round to look up.
    /// @return True while the factory still lists the round.
    function isRegistered(address campaign) external view returns (bool);
}

contract Campaign is Ownable, ReentrancyGuard {
    /// @notice Factory that created this round; used for the registry check.
    address public immutable factory;

    // ─────────────────────────── state machine ───────────────────────────
    enum Scene {
        Funding,
        Executing,
        Mining
    }
    enum Phase {
        None, // unused; setPhase refuses it
        Buying, // may place bids
        Listed, // bids live
        Ready // parts received
    }

    struct Listing {
        address seller;
        uint256 shares;
        uint256 priceBnbPerShare;
        bool open;
    }

    /// @notice Grace period before a non-owner may flag the round as failed.
    uint256 internal constant FAIL_GRACE = 3 days;
    /// @notice Service-fee cap in bps (1000 = 10%). Charged on mining output only, never on subscriptions.
    uint16 internal constant MAX_SERVICE_FEE_BPS = 1000;
    /// @notice Max fee recipients; bounds the accrual loop and storage.
    uint256 internal constant MAX_FEE_RECIPIENTS = 3;

    // ─────────────────────── immutable config (fixed at creation) ───────────────────────
    uint256 public immutable sharePriceBnb; // price per share (wei)
    uint256 public immutable totalShares; // share cap
    uint64 public immutable fundingDeadline; // funding deadline (unix seconds)
    /// @notice Parts contract (ERC1155); every bid targets it.
    address public immutable transistors;
    /// @notice Market for bids. Replaceable via setMaterialMarket; past markets stay accepted BNB senders.
    IMaterialMarket public materialMarket;
    /// @notice Destination of depositToPool().
    address public miningPool;

    // ─────────────────────── mutable state ───────────────────────
    Scene public scene;
    Phase public phase;
    /// @notice Hot wallet for routine operations. Always a strict subset of the owner; 0 = disabled.
    address public operator;
    /// @notice Circuit breaker. Stops money-in and irreversible-out; NEVER stops a holder exit.
    bool public halted;
    /// @notice Cumulative shares ever sold; monotonic, so refunding cannot undo the sold-out gate.
    uint256 public sold;
    /// @notice Shares sold but not yet refunded: current debt, and the refund denominator.
    uint256 public outstandingShares;
    /// @notice Service-fee rate in bps. Writable once while `sold == 0`, then frozen.
    uint16 public serviceFeeBps;
    /// @notice Fee recipients, length = feeRecipientCount().
    address[] private _feeRecipients;
    /// @notice Per-recipient share in bps, sums to 10000; aligned with _feeRecipients.
    uint16[] private _feeSharesBps;
    /// @notice Accrued-but-unclaimed fee per recipient; pulled via claimFee().
    mapping(address => uint256) public pendingFee;
    /// @notice Sum of pendingFee; reserved by recoverBnb.
    uint256 public totalPendingFee;
    /// @notice Fee table already written; frozen forever after that (even at 0 bps).
    bool public serviceFeeSet;
    /// @notice When the round sold out; 0 = never sold out.
    uint64 public soldOutAt;
    /// @notice Timestamp of the last placeTransistorOrder; part of the markFailed grace base.
    uint64 public lastOrderAt;
    /// @notice Set by an unaffordable order or markFailed; cleared by a successful order.
    bool public executionFailed;
    /// @notice Parts were committed to the mining pool. Irreversible: refund / abandon / recover are closed.
    bool public pooled;

    /// @notice Subscription escrow. Bids debit it; receive credits market refunds and proceeds.
    uint256 public raisedBnb;
    /// @notice Cumulative principal refunded; surplus payouts move `surplusPaid` instead.
    uint256 public totalRefunded;
    /// @notice Cumulative service fee paid out.
    uint256 public totalFeesPaid;
    /// @notice Cumulative mining revenue net of fee. Display only; the money is booked into surplus.
    uint256 public revenuePool;

    /// @notice Escrow paid for the current order, not a unit price. 0 = no paid order, so Ready / Mining
    ///         cannot be faked without a purchase.
    uint256 public priceLock;
    /// @notice NAND bid id; 0 when there is no live order or the leg was skipped.
    uint256 public nandBidId;
    /// @notice LATCH bid id; 0 when the leg was skipped.
    uint256 public latchBidId;
    /// @notice NAND quantity ordered; 0 when the leg was skipped.
    uint256 public nandQty;
    /// @notice LATCH quantity ordered; 0 when the leg was skipped.
    uint256 public latchQty;
    /// @notice Locked NAND bid price. Display only.
    uint96 public nandPrice;
    /// @notice Locked LATCH bid price. Display only.
    uint96 public latchPrice;
    /// @notice Highest unit price ever paid for NAND; the sell floor, never cleared.
    uint96 public nandCostBasis;
    /// @notice Highest unit price ever paid for LATCH. See nandCostBasis.
    uint96 public latchCostBasis;
    /// @notice Design hashpower estimate. Display only.
    uint256 public estHashpower;

    // ─────────────────────── per-wallet ledger ───────────────────────
    mapping(address => uint256) private _shares; // available shares
    mapping(address => uint256) private _escrow; // shares locked in a listing
    /// @notice Principal refunded to this wallet; excludes surplus.
    mapping(address => uint256) private _refunded;
    /// @notice Surplus this wallet already claimed.
    mapping(address => uint256) private _surplusClaimed;
    /// @notice Surplus booked but not yet transferred; pulled via claimSurplus.
    mapping(address => uint256) public pendingSurplus;

    /// @notice Sum of pendingSurplus; already inside the surplus reserve, so never add it again.
    uint256 public totalPendingSurplus;
    /// @notice Cumulative surplus ever booked; unclaimed = surplusPool − surplusPaid.
    uint256 public surplusPool;
    /// @notice Surplus booked in the current round; the numerator of its split.
    uint256 public surplusRoundPool;
    /// @notice Surplus round index. A new round opens once every base share is counted, so fresh BNB
    ///         stays claimable instead of paying 0 to everyone.
    uint256 public surplusRound;
    /// @notice Denominator of the current round (outstandingShares at its first booking); fixed for it.
    uint256 public surplusBase;
    /// @notice Shares counted in the current round; the last claimant takes the rounding dust.
    uint256 public surplusClaimedShares;
    /// @notice Surplus allocated in the current round (booked, paid or not).
    uint256 public surplusAllocated;
    /// @notice Cumulative surplus transferred; still owed = surplusPool − surplusPaid.
    uint256 public surplusPaid;
    /// @notice Shares counted into the current round per holder; prevents double claims.
    mapping(address => uint256) public surplusCounted;
    /// @notice Round in which surplusCounted[holder] was written; a stale round counts as 0.
    mapping(address => uint256) public surplusCountedRound;
    /// @notice Subscribers and listing buyers, append-only. Frontend / tests only: no payout loops over it.
    address[] private _holders;
    mapping(address => bool) private _holderSeen;

    Listing[] private _listings;
    /// @dev Markets that ever served this round; receive accepts their BNB. Mapping keeps the check O(1).
    mapping(address => bool) private _marketSeen;

    // ─────────────────────── events ───────────────────────
    /// @notice Operator hot wallet replaced; the owner always keeps every operator right.
    event OperatorSet(address indexed previous, address indexed next);
    /// @notice Circuit breaker toggled. `by` is whoever halted or resumed.
    event HaltChanged(address indexed by, bool halted);
    event Subscribed(address indexed subscriber, uint256 count, uint256 paidBnb);
    event Refunded(address indexed holder, uint256 amountBnb);
    /// @notice Surplus paid by claimSurplus; not principal.
    event SurplusClaimed(address indexed holder, uint256 amountBnb);
    event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare);
    event ListingCancelled(uint256 indexed id, address indexed seller, uint256 shares);
    event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb);
    /// @param count Total units across both legs.
    /// @param escrowBnb Total escrow debited from raisedBnb (not a unit price).
    event TransistorOrderPlaced(uint256 count, uint256 escrowBnb);
    event TransistorOrderCancelled();
    /// @notice Parts sold into a resting market bid (the only sell path: no ask book exists).
    /// @param bidId Bid that was filled.
    /// @param tokenId 0 NAND, 1 LATCH.
    /// @param quantity Units sold.
    /// @param proceeds BNB credited to raisedBnb after the market fee.
    event TransistorsSold(uint256 indexed bidId, uint8 indexed tokenId, uint256 quantity, uint256 proceeds);
    event TransistorsConfirmed();
    /// @notice needBnb = unaffordable cost (0 for markFailed); raisedBnb = escrow then. Neither reverts.
    event ExecutionFailed(uint256 needBnb, uint256 raisedBnb);
    /// @notice Refunds are open; nothing was transferred, each holder pulls with refund.
    /// @param outstandingShares Shares still owed.
    /// @param escrowBnb Pool the pro-rata split divides.
    event RefundsOpened(uint256 outstandingShares, uint256 escrowBnb);
    event PlanUpdated(uint256 estHashpower);
    event MaterialMarketUpdated(address indexed previous, address indexed next);
    /// @notice Operator approval of a former material market was revoked.
    event MaterialMarketApprovalRevoked(address indexed market);
    /// @notice BNB swept by recoverBnb; `to` is always the owner.
    event BnbRecovered(uint256 amount, address indexed to);
    /// @notice ERC1155 tokens moved by recoverTransistors; `to` is always the owner.
    event TransistorsRecovered(address indexed token, uint256 indexed id, uint256 amount, address indexed to);
    /// @notice Mining pool address was set.
    event MiningPoolSet(address indexed previous, address indexed next);
    /// @notice Parts were committed to the mining pool. IRREVERSIBLE.
    event DepositedToPool(address indexed pool, uint256 nandAmount, uint256 latchAmount);
    /// @notice Executing sub-phase changed; _setPhase is the only writer.
    event PhaseChanged(uint8 indexed previous, uint8 indexed next);
    /// @notice Surplus booked for a holder; claimable via claimSurplus.
    event SurplusAccrued(address indexed holder, uint256 amountBnb);
    /// @notice Leftover subscription BNB booked for pro-rata return (returnSurplus); the round keeps going.
    event SurplusReturned(uint256 amountBnb, uint256 baseShares);
    /// @notice Fee table set; only possible while nobody has subscribed.
    event ServiceFeeSet(uint16 feeBps, address[] recipients, uint16[] sharesBps);
    /// @notice Fee share booked for a recipient; pulled via claimFee.
    event FeeAccrued(address indexed to, uint256 amount);
    /// @notice Mining revenue deposited; `fee` withheld, `net` booked for holders.
    event RevenueDeposited(uint256 gross, uint256 fee, uint256 net);
    /// @notice Fee share paid out by claimFee.
    event FeePaid(address indexed to, uint256 amount);
    /// @notice Owner added BNB so every outstanding share can be repaid at the subscription price.
    event ShortfallToppedUp(uint256 amount, uint256 raisedBnb);

    // ─────────────────────── errors ───────────────────────
    error DirectTransferNotAllowed();
    /// @notice Business entry refused by the circuit breaker. Holder exits are never halted.
    error Halted();
    /// @notice halt() on an already halted round.
    error AlreadyHalted();
    /// @notice resume() on a live round.
    error NotHalted();
    /// @notice Caller is neither the owner nor the current operator.
    error NotOperator(address caller);
    error WrongScene();
    error FundingEnded();
    error TransistorsNotReady();
    error RefundNotAvailable();
    /// @dev Reused as "nothing to settle": zero quantity, zero amount, or nothing left to pay.
    error ZeroShares();
    error ZeroPrice();
    error BadCount();
    error InsufficientShares();
    /// @notice Parts still back outstanding shares; settle the holders first.
    error SharesOutstanding();
    /// @notice Holders were not repaid at the subscription price, so the parts are still their collateral.
    error HoldersNotMadeWhole();
    /// @notice The pool cannot repay every share, so the parts in hand are their collateral. Refunding
    ///         would zero the shares and leave the parts with no claimant.
    error PartsAreCollateral();
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
    /// @notice Market proceeds are still in owed(); pull them first so the refund pool is final.
    error ProceedsPending();
    /// @notice sellTransistors: not a fillable bid for this round (closed, wrong parts, id or quantity).
    error NotABid();
    /// @notice sellTransistors: price below the unit price this round paid.
    error PriceBelowCost();
    /// @notice sellTransistors: the bid belongs to this contract; filling it would fake proceeds.
    error SelfTrade();
    /// @notice sellTransistors: the parts moved but no BNB arrived.
    error NoProceeds();
    error InsufficientParts();
    error PoolNotSet();
    error AlreadyPooled();
    /// @notice returnSurplus already booked the principal; refund / abandon would zero shares for 0 BNB.
    error SurplusAlreadyReturned();
    /// @notice Ready: use returnSurplus, which must not touch the parts.
    error UseReturnSurplus();
    /// @notice Invalid fee table (cap, length, duplicate / zero recipient, shares not summing to 10000).
    ///         Also raised by the fee getters for an out-of-range index.
    error BadFeeConfig();
    /// @notice The fee table is already set and frozen.
    error ServiceFeeAlreadySet();
    /// @notice The fee is frozen because somebody already subscribed.
    error ServiceFeeLocked();
    /// @notice The round never sold out; no parts order may be placed.
    error NotSoldOutYet();

    /// @param sharePriceBnb_ Price of one share in wei.
    /// @param totalShares_ Share cap; also the sell-out threshold.
    /// @param fundingDeadline_ Funding deadline in unix seconds (inclusive).
    /// @param materialMarket_ Initial market; replaceable via setMaterialMarket.
    /// @param owner_ Campaign owner (the factory owner in practice).
    /// @param transistors_ Parts contract; must be whitelisted by the factory.
    constructor(
        uint256 sharePriceBnb_,
        uint256 totalShares_,
        uint64 fundingDeadline_,
        address materialMarket_,
        address owner_,
        address transistors_
    ) Ownable(owner_) {
        if (materialMarket_ == address(0) || transistors_ == address(0)) revert ZeroAddress();
        // A codeless target would make every call revert with empty returndata, bricking the round.
        if (materialMarket_.code.length == 0 || transistors_.code.length == 0) revert ZeroAddress();
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

    // ─────────────────────────── roles and circuit breaker ───────────────────────────

    /// @notice Set the operator hot wallet. Owner only; address(0) disables the role.
    ///         The owner always keeps every operator right, so granting cannot be a one-way door.
    /// @param operator_ Hot wallet; the contract itself is refused (it cannot originate a call).
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(this)) revert ZeroAddress();
        emit OperatorSet(operator, operator_);
        operator = operator_;
    }

    /// @notice Trip the circuit breaker. Owner or operator.
    ///         Blocks money-in (`subscribe`), irreversible-out (`depositToPool`), parts-out
    ///         (`sellTransistors`), ordering, and the secondary market. Holder exits are never blocked.
    function halt() external {
        _requireOperator();
        if (halted) revert AlreadyHalted();
        halted = true;
        emit HaltChanged(msg.sender, true);
    }

    /// @notice Lift the circuit breaker. Owner only: a compromised operator must not undo its own brake.
    function resume() external onlyOwner {
        if (!halted) revert NotHalted();
        halted = false;
        emit HaltChanged(msg.sender, false);
    }

    /// @dev True for the owner and the current operator. Every onlyOperator entry point also accepts the
    ///      owner, so the operator is a strict subset and can never lock the owner out.
    /// @return Whether the caller may use operator-level entry points.
    function _isOperator() internal view returns (bool) {
        return msg.sender == owner || (operator != address(0) && msg.sender == operator);
    }

    /// @dev Revert unless the caller is the owner or the current operator.
    function _requireOperator() internal view {
        if (!_isOperator()) revert NotOperator(msg.sender);
    }

    /// @dev Circuit breaker for business entry points. Never applied to refund / surplus / fee pulls,
    ///      to cancelling a live bid or to the admin recovery exits, so a halt can never lock assets.
    modifier whenLive() {
        if (halted) revert Halted();
        _;
    }

    /// @dev Accept BNB only from a market that ever served this round (cancel refunds, proceeds,
    ///      withdraw). Any other sender could inflate the refund pool; past markets stay accepted because
    ///      settlement is asynchronous.
    receive() external payable {
        if (!_isKnownMarket(msg.sender)) revert DirectTransferNotAllowed();
        raisedBnb += msg.value;
        // After pooling there is no refund path, so a late credit would be unspendable: book it as surplus.
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
        return who == address(materialMarket) || _marketSeen[who];
    }

    /// @notice Replace the material market. Blocked while a bid is live. BNB the old market owes is pulled
    ///         first (best effort), its approval is revoked, and it stays an accepted BNB sender.
    /// @param materialMarket_ New market; must have code.
    function setMaterialMarket(address materialMarket_) external onlyOwner nonReentrant {
        if (materialMarket_ == address(0)) revert ZeroAddress();
        // A codeless market would revert every placeBid / cancelBid / owed call.
        if (materialMarket_.code.length == 0) revert ZeroAddress();
        // A live order would strand its escrow on the old market.
        if (phase == Phase.Listed) revert AlreadyListed();
        // owed() is per market, so leftovers become unreachable after a swap. Drain first, but never let
        // a market that refuses to pay block the escape hatch.
        if (_owed() > 0) {
            try materialMarket.withdraw() {} catch {}
        }
        // Drop the old approval, or it could still move this round's parts.
        address previous = address(materialMarket);
        if (previous != materialMarket_) {
            _revokeApproval(previous);
        }
        emit MaterialMarketUpdated(previous, materialMarket_);
        // Keep accepting late settlement from the market we leave.
        _marketSeen[previous] = true;
        materialMarket = IMaterialMarket(materialMarket_);
    }

    /// @dev Revoke a market's ERC1155 approval; silent on failure.
    /// @param market Former market whose approval is dropped.
    function _revokeApproval(address market) internal {
        if (market == address(0)) return;
        try IERC1155(transistors).setApprovalForAll(market, false) {
            emit MaterialMarketApprovalRevoked(market);
        } catch {
            // Ignore: a deprecated parts contract may not implement it.
        }
    }

    /// @notice Set the mining-pool destination. Only before pooling.
    /// @param pool_ Non-zero, and not this contract.
    function setMiningPool(address pool_) external onlyOwner {
        if (pooled) revert AlreadyPooled();
        if (pool_ == address(0) || pool_ == address(this)) revert ZeroAddress();
        emit MiningPoolSet(miningPool, pool_);
        miningPool = pool_;
    }

    /// @notice Store the display-only hashpower estimate. Funding and Executing/Buying only.
    /// @param estHashpower_ Read by the UI only.
    function setPlan(uint256 estHashpower_) external {
        _requireOperator();
        if (scene == Scene.Mining) revert WrongScene();
        if (scene == Scene.Executing && phase != Phase.Buying) revert WrongScene();
        estHashpower = estHashpower_;
        emit PlanUpdated(estHashpower_);
    }

    // ─────────────────────────── subscribe ───────────────────────────

    /// @notice Buy `count` shares for exactly count × sharePriceBnb, up to and including the deadline.
    ///         A sell-out moves the round to Executing/Buying. Subscription BNB pays no service fee.
    /// @param count Shares to buy; > 0 and within the remaining supply.
    function subscribe(uint256 count) external payable nonReentrant whenLive {
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

    /// @notice Set the service fee and its split table. Owner only, only while `sold == 0`, then frozen.
    ///         Charged on mining output only, never on subscriptions; 0 bps + empty table = no fee.
    /// @dev Recipients must be non-zero, unique, and not this contract (which could never pull its fee).
    /// @param bps_ Fee rate in bps, at most MAX_SERVICE_FEE_BPS.
    /// @param recipients_ Recipients, at most MAX_FEE_RECIPIENTS; empty only when bps_ == 0.
    /// @param sharesBps_ Per-recipient share in bps; aligned with recipients_ and summing to 10000.
    function setServiceFee(uint16 bps_, address[] calldata recipients_, uint16[] calldata sharesBps_) external onlyOwner {
        if (serviceFeeSet) revert ServiceFeeAlreadySet();
        if (sold != 0) revert ServiceFeeLocked();
        if (bps_ > MAX_SERVICE_FEE_BPS) revert BadFeeConfig();
        if (recipients_.length != sharesBps_.length) revert BadFeeConfig();
        if (recipients_.length > MAX_FEE_RECIPIENTS) revert BadFeeConfig();
        // Explicit "no fee": empty table, no 10000-bps sum to satisfy.
        if (bps_ == 0) {
            if (recipients_.length != 0) revert BadFeeConfig();
            serviceFeeSet = true;
            emit ServiceFeeSet(0, recipients_, sharesBps_);
            return;
        }
        if (recipients_.length == 0) revert BadFeeConfig();

        uint256 sum = 0;
        for (uint256 i = 0; i < recipients_.length; i++) {
            // This contract cannot call claimFee on itself, so its own address would lock the fee forever.
            if (recipients_[i] == address(0) || recipients_[i] == address(this)) revert BadFeeConfig();
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

    /// @notice Pull your principal; the only refund exit.
    ///         Allowed when Funding is past the deadline and never sold out, or in Executing/Buying with
    ///         `executionFailed` or a short pool. A full pool pays count × sharePriceBnb, a short one pays
    ///         pro-rata of `raisedBnb`. Refused in Listed (escrow still on the market) and Ready (the parts
    ///         are the holders' asset), while the pool cannot repay parts-backed shares (PartsAreCollateral),
    ///         and after returnSurplus booked the principal.
    function refund() external nonReentrant {
        if (scene == Scene.Funding) {
            // soldOutAt == 0 = never sold out.
            if (soldOutAt != 0 || block.timestamp <= fundingDeadline) revert RefundNotAvailable();
        } else if (scene == Scene.Executing) {
            // returnSurplus already paid the principal; refunding would zero shares for 0 BNB.
            if (surplusBase != 0) revert SurplusAlreadyReturned();
            if (phase != Phase.Buying) revert RefundNotAvailable();
            // Parts in hand are the shares' collateral: zeroing the shares would strand them.
            if (_partsHeld() && !_poolCoversEveryShare()) revert PartsAreCollateral();
            if (!executionFailed && !_shortfall()) revert RefundNotAvailable();
        } else {
            revert RefundNotAvailable(); // Mining: shares are transferable, principal is gone.
        }

        // Shares and BNB settle in one transaction; a failed send reverts everything.
        if (_shares[msg.sender] == 0 || _escrow[msg.sender] != 0) revert ZeroShares();
        _refundOne(msg.sender);
    }

    /// @notice Owner or operator tops the escrow up so every outstanding share can be repaid at the
    ///         subscription price. This is how the parts may leave after a partial purchase: holders are
    ///         repaid first, then the owner takes the parts at cost. Excess is sweepable with recoverBnb.
    function topUpShortfall() external payable nonReentrant {
        _requireOperator();
        if (scene != Scene.Executing) revert WrongScene();
        if (msg.value == 0) revert ZeroPrice();
        raisedBnb += msg.value;
        emit ShortfallToppedUp(msg.value, raisedBnb);
    }

    /// @dev Append `who` to the holder list once; later calls are no-ops.
    /// @param who Subscriber or listing buyer to record.
    function _trackHolder(address who) internal {
        if (_holderSeen[who]) return;
        _holderSeen[who] = true;
        _holders.push(who);
    }

    /// @dev Single writer for `phase`; emits PhaseChanged only on a real change.
    /// @param next Phase to store.
    function _setPhase(Phase next) internal {
        uint8 previous = uint8(phase);
        phase = next;
        if (previous != uint8(next)) emit PhaseChanged(previous, uint8(next));
    }

    /// @dev Pay `who` their principal and clear their shares. Pull-only, so no path loops over holders.
    ///      The denominator is `outstandingShares`, not `sold`, or the last holders would find it drained.
    ///      Shares are cleared even when the amount rounds to 0, so nobody is stuck.
    /// @param who Wallet to settle.
    /// @return amount BNB sent; 0 when it rounded to 0.
    function _refundOne(address who) internal returns (uint256 amount) {
        uint256 s = _shares[who];
        if (s == 0 || outstandingShares == 0) return 0;
        // Full pool: count × price. Short pool: pro-rata of raisedBnb.
        amount =
            raisedBnb >= outstandingShares * sharePriceBnb ? s * sharePriceBnb : (raisedBnb * s) / outstandingShares;
        _shares[who] = 0;
        outstandingShares -= s;
        raisedBnb -= amount;
        _refunded[who] += amount;
        totalRefunded += amount;
        // Amount 0 (rounding): the shares are still settled; the dust stays for the rest.
        if (amount != 0) _send(who, amount);
        emit Refunded(who, amount);
    }

    // ─────────────────────────── share transfer (Mining only) ───────────────────────────

    /// @notice Mining only. List `count` shares at `priceBnbPerShare`; they lock until sold or cancelled.
    /// @param count Shares to list; > 0 and unlocked.
    /// @param priceBnbPerShare Price per share in wei; > 0.
    function listShares(uint256 count, uint256 priceBnbPerShare) external whenLive {
        if (scene != Scene.Mining) revert WrongScene();
        if (count == 0) revert ZeroShares();
        if (priceBnbPerShare == 0) revert ZeroPrice();
        if (_shares[msg.sender] < count) revert InsufficientShares();

        _shares[msg.sender] -= count;
        _escrow[msg.sender] += count;
        _listings.push(Listing({seller: msg.sender, shares: count, priceBnbPerShare: priceBnbPerShare, open: true}));
        emit Listed(_listings.length - 1, msg.sender, count, priceBnbPerShare);
    }

    /// @notice Cancel a listing and unlock its shares. Seller or owner only; never halted (it is an exit).
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
    ///         paid to the seller atomically. Deliberately push (one seller, one payment): a failed send
    ///         reverts, so shares can never move without payment. Refunds and claims stay pull.
    /// @param id Listing id.
    /// @param count Shares to buy; > 0 and at most the listing's remaining shares.
    function takeListing(uint256 id, uint256 count) external payable nonReentrant whenLive {
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
        // The surplus counter travels with the shares, so reselling cannot let a fresh wallet re-claim
        // what the seller already counted in this round.
        _moveSurplusCount(l.seller, msg.sender, count);
        l.shares -= count;
        if (l.shares == 0) l.open = false;

        // Atomic settlement, deliberately push: one seller, one payment, and the shares must not move
        // without it. A failed send reverts, so "shares moved, BNB still owed" cannot happen.
        _send(l.seller, pay);
        emit ListingTaken(id, msg.sender, l.seller, count, pay);
    }

    // ─────────────────────────── secondary-market bids (owner) ───────────────────────────

    /// @notice Place both legs of a buy order. Owner or operator, Executing/Buying only. NAND is id 0,
    ///         LATCH is id 1. Each leg sends qty × price from `raisedBnb`; a zero-qty leg is skipped
    ///         (bid id 0). One order at a time. If the total cost exceeds `raisedBnb` it sets
    ///         `executionFailed` and places nothing — no revert.
    /// @dev Operator-level because ordering is the daily step that produces `Ready` (cancel / confirm /
    ///      sell are already operator-level); the spend is reversible via `cancelTransistorOrder`.
    ///      `depositToPool` stays owner-only — that one is irreversible.
    /// @param nandQty_ NAND quantity; 0 skips the leg.
    /// @param nandPrice_ NAND price per unit in wei; ignored when nandQty_ is 0.
    /// @param latchQty_ LATCH quantity; 0 skips the leg.
    /// @param latchPrice_ LATCH price per unit in wei; ignored when latchQty_ is 0.
    function placeTransistorOrder(
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external nonReentrant whenLive {
        _requireOperator();
        _requireExecuting();
        if (phase != Phase.Buying) revert WrongScene();
        _requireLegParams(nandQty_, nandPrice_, latchQty_, latchPrice_);
        // `sold` is monotonic, so refunds can never revoke this gate (README §8).
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
        // Cost basis survives _clearOrder: sellTransistors uses it as a hard price floor.
        nandCostBasis = _raiseCostBasis(nandCostBasis, nandQty_, nandPrice_);
        latchCostBasis = _raiseCostBasis(latchCostBasis, latchQty_, latchPrice_);
        priceLock = cost;
        nandBidId = _placeBidLeg(0, nandQty_, nandPrice_, nandCost);
        latchBidId = _placeBidLeg(1, latchQty_, latchPrice_, latchCost);
        _setPhase(Phase.Listed);
        // Each order pushes the non-owner grace period forward, so an active owner is never griefed.
        lastOrderAt = uint64(block.timestamp);
        emit TransistorOrderPlaced(nandQty_ + latchQty_, cost);
    }

    /// @notice Book the leftover subscription BNB as holder-claimable surplus without ending the round:
    ///         parts stay, `phase` stays Ready, depositToPool stays available. No holder loop — each holder
    ///         pulls with claimSurplus. Requires nothing owed by the market, and closes openRefund / abandon.
    ///         Owner or operator any time; anyone else after FAIL_GRACE, so a vanished team cannot lock BNB.
    function returnSurplus() external nonReentrant {
        _requireReady();
        if (pooled) revert AlreadyPooled();
        if (_owed() > 0) revert ProceedsPending();
        if (!_isOperator() && block.timestamp < _graceBase() + FAIL_GRACE) revert RefundNotAvailable();
        if (outstandingShares == 0) revert ZeroShares();
        if (raisedBnb == 0) revert ZeroShares();
        _returnSurplus();
        emit SurplusReturned(surplusPool, surplusBase);
    }

    /// @notice Open refunds. Buying only — in Ready the exit is returnSurplus. Closed once returnSurplus
    ///         booked the principal. Moves no BNB: it flags the round failed and every holder pulls with
    ///         refund, so gas stays flat and no holder can block the call.
    ///         Owner or operator: an abort switch, never a payout, and never halted.
    function openRefund() external nonReentrant {
        _requireOperator();
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        // Nobody left to refund; the dust is swept by recoverBnb.
        if (outstandingShares == 0) revert ZeroShares();
        if (phase != Phase.Buying) revert WrongScene();
        // Parts in hand are the shares' collateral; a short pool would burn them on refund.
        if (_partsHeld() && !_poolCoversEveryShare()) revert PartsAreCollateral();
        if (_owed() > 0) revert ProceedsPending();
        markFailed();
        emit RefundsOpened(outstandingShares, raisedBnb);
    }

    /// @notice Give up from Buying or Listed: cancel the remaining bid, pull what the market owes, open
    ///         refunds, and hand the parts to the owner only if every share is settled and repaid. Pull-only,
    ///         so gas stays flat. Refused in Ready (exit is returnSurplus + depositToPool).
    function abandonOrder() external onlyOwner nonReentrant {
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        // Cancel first: a holder can only pull while the phase is Buying.
        _cancelLiveOrder();
        _pullOwed();
        // The pool is final now; a short pool would burn the parts-backed shares.
        if (_partsHeld() && !_poolCoversEveryShare()) revert PartsAreCollateral();
        markFailed();
        emit RefundsOpened(outstandingShares, raisedBnb);
        // Parts leave only when no share is outstanding AND every share was repaid in full.
        if (outstandingShares == 0 && _holdersMadeWhole()) _returnHeldParts();
    }

    /// @notice Cancel the open remainder of the bid and return to Buying. Owner or operator while nothing
    ///         has filled; once anything filled, anyone may cancel the rest. Refused when fully filled and
    ///         delivered. Filled quantity stays spent; a round dropped from the registry is cancellable by
    ///         anyone. Never halted: this is the escape hatch that returns escrow to the pool.
    ///         This is the only right a retired round opens up: pooling and selling stay owner-only.
    function cancelTransistorOrder() external nonReentrant {
        if (phase != Phase.Listed) revert NotListed();
        bool touched = _filledSome(nandBidId, nandQty) || _filledSome(latchBidId, latchQty);
        if (orderFilled() && _partsOnHand()) revert OrderFilled();
        if (!touched && !_isOperator() && !_retired()) revert NotOperator(msg.sender);
        _cancelLiveOrder();
    }

    /// @notice Flag the round as failed so holders can refund. Owner or operator any time; anyone else after
    ///         FAIL_GRACE. Cancels the unfilled legs first so their escrow returns to `raisedBnb`. Refused in
    ///         Ready, where the parts are already the holders' asset. No-op when already failed or not
    ///         Executing. Never halted: it only opens the refund gate and moves no BNB.
    function markFailed() public {
        if (scene != Scene.Executing || executionFailed) return;
        // returnSurplus already returned the principal; flagging a refund would burn shares for 0 BNB.
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        if (!_isOperator() && block.timestamp < _graceBase() + FAIL_GRACE) {
            revert RefundNotAvailable();
        }
        executionFailed = true; // CEI: set before the market callback; a revert rolls it back.
        // Pull the live bid's escrow back so holders refund against the real pool. A refused cancel
        // reverts, so the call can simply be retried.
        _cancelLiveOrder();
        emit ExecutionFailed(0, raisedBnb);
    }

    /// @notice Sell held parts into a resting buy order. Owner or operator; Ready only — the market has no
    ///         ask book, so this is the only sell path. The market pulls the parts and pays this round
    ///         inside the fill: the official one sends BNB straight to receive(), the mock credits owed()
    ///         for a withdraw. Both paths end with the proceeds in `raisedBnb`.
    ///         Refused on a wrong parts contract / token id / quantity, a zero price, our own bid, or a
    ///         price below this round's unit cost (a cheap fill would burn the collateral). Reverts with
    ///         NoProceeds if the parts leave but no BNB arrives. Repeatable and partial. Halted stops it:
    ///         parts leaving the contract is exactly what a breaker should stop.
    /// @param bidId Bid to fill.
    /// @param tokenId 0 NAND, 1 LATCH.
    /// @param quantity Units to sell; at most the bid's remaining and this contract's balance.
    function sellTransistors(uint256 bidId, uint8 tokenId, uint256 quantity)
        external
        nonReentrant
        whenLive
    {
        _requireOperator();
        _requireReady();
        if (pooled) revert AlreadyPooled();
        if (bidId == 0 || quantity == 0) revert NotABid();
        if (tokenId > 1) revert NotABid();

        (address buyer, address parts, uint96 price, uint8 bidTokenId,, uint256 remaining) =
            materialMarket.bids(bidId);
        if (parts != transistors || bidTokenId != tokenId || remaining < quantity) revert NotABid();
        // A zero-price bid is a giveaway, never a sale.
        if (price == 0) revert ZeroPrice();
        // Filling our own bid would round-trip the parts and book fake proceeds.
        if (buyer == address(this)) revert SelfTrade();
        if (price < _costBasis(tokenId)) revert PriceBelowCost();
        if (IERC1155(transistors).balanceOf(address(this), tokenId) < quantity) revert InsufficientParts();

        // Idempotent; skips an extra isApprovedForAll call.
        IERC1155(transistors).setApprovalForAll(address(materialMarket), true);
        // Drain anything an older settlement left credited, so the delta below is this sale only.
        _pullOwed();
        uint256 before = raisedBnb;
        materialMarket.fillBid(bidId, quantity);
        // The official market pays the seller inside fillBid (its BNB hits receive(), which credits
        // raisedBnb); the mock credits owed() and waits for withdraw(). Pull, then insist that BNB
        // actually arrived — a fill that pays nothing would hand the parts away for free.
        _pullOwed();
        if (raisedBnb == before) revert NoProceeds();
        emit TransistorsSold(bidId, tokenId, quantity, raisedBnb - before);
    }

    /// @notice Pull market proceeds into `raisedBnb` (via receive). Anyone may call; no-op at 0.
    function withdrawMarketProceeds() external nonReentrant {
        _pullOwed();
    }

    /// @notice Move Listed → Ready once both legs have no remainder and the parts are here.
    ///         Moves no tokens; a zero-qty leg counts as filled.
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

    /// @notice Escape hatch: move ERC1155 tokens held here to the owner so nothing is stranded.
    ///         Blocked while a bid is live, after pooling, and — for this round's own parts — while shares
    ///         are outstanding or holders were not repaid at the subscription price.
    /// @param token ERC1155 contract; not limited to `transistors`.
    /// @param id Token id (0 NAND, 1 LATCH for this round's parts).
    /// @param amount Units to transfer.
    function recoverTransistors(address token, uint256 id, uint256 amount) external onlyOwner nonReentrant {
        if (phase == Phase.Listed) revert AlreadyListed();
        if (pooled) revert AlreadyPooled();
        if (token == address(0)) revert ZeroAddress();
        if (token == transistors) {
            // Our parts back the outstanding shares: they leave only via depositToPool / sellTransistors,
            // or once every holder is settled AND repaid in full.
            if (outstandingShares != 0) revert SharesOutstanding();
            if (!_holdersMadeWhole()) revert HoldersNotMadeWhole();
        }
        IERC1155(token).safeTransferFrom(address(this), owner, id, amount, "");
        emit TransistorsRecovered(token, id, amount, owner);
    }

    // ─────────────────────────── mining pool (commit) ───────────────────────────

    /// @notice Commit the round's parts to the mining pool. IRREVERSIBLE. Owner only, Ready only.
    ///         Never delegated: the factory dropping the round opens only the reversible cancel, because
    ///         pooling would let a third party decide "mine vs sell" for the holders.
    ///         Halted stops it: the breaker must be able to hold the irreversible step.
    ///         1. Book the leftover BNB as holder-claimable surplus, before the parts leave.
    ///         2. Send every held part (NAND id 0, LATCH id 1) to `miningPool`.
    ///         3. Set `pooled` and enter Mining.
    ///         Requires a ready basis (settled purchase or parts on hand) and at least one outstanding
    ///         share — with no shares or no parts nobody would own the output. The full ordered quantity is
    ///         not required: a round that sold some parts holds less, and those proceeds were booked above.
    function depositToPool() external onlyOwner nonReentrant whenLive {
        if (pooled) revert AlreadyPooled();
        _requireReady();
        if (miningPool == address(0)) revert PoolNotSet();
        if (!_readyBasis()) revert TransistorsNotReady();
        if (outstandingShares == 0) revert ZeroShares();

        // Leftover BNB becomes pull-claimable surplus. Proceeds are part of it, so pull them first —
        // best effort: a market that cannot pay must not block the irreversible step (receive books a
        // later settlement as a new surplus round).
        _pullOwedSoft();
        _returnSurplus();

        IERC1155 token = IERC1155(transistors);
        uint256 nandAmt = token.balanceOf(address(this), 0);
        uint256 latchAmt = token.balanceOf(address(this), 1);
        if (nandAmt + latchAmt == 0) revert InsufficientParts();
        if (nandAmt > 0) token.safeTransferFrom(address(this), miningPool, 0, nandAmt, "");
        if (latchAmt > 0) token.safeTransferFrom(address(this), miningPool, 1, latchAmt, "");

        pooled = true;
        scene = Scene.Mining;
        emit DepositedToPool(miningPool, nandAmt, latchAmt);
    }

    /// @notice PLACEHOLDER — BEM distribution not implemented; no-op to keep the Mining ABI stable.
    ///         BNB revenue is already claimable via claimSurplus.
    function harvest() external nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
    }

    /// @notice PLACEHOLDER — BEM distribution not implemented; BNB revenue is not withdrawn here.
    /// @return Always 0 until distribution lands.
    function claim() external nonReentrant returns (uint256) {
        if (scene != Scene.Mining) revert WrongScene();
        return 0;
    }

    /// @notice Deposit mining revenue. Only `miningPool` may call; the only on-chain fee point.
    ///         fee = msg.value × serviceFeeBps / 10000 split over the table; the net is booked into the
    ///         holders' pull-claimable surplus. Rounding dust stays with holders (fee never over-charged)
    ///         and recipients pull via claimFee, so a rejecting recipient cannot block this call.
    function depositRevenue() external payable nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (msg.sender != miningPool) revert NotOwner(msg.sender);
        if (msg.value == 0) revert ZeroPrice();

        uint256 fee = _accrueServiceFee(msg.value);
        uint256 net = msg.value - fee;
        // Display total only: the money is booked below, so never add this to recoverBnb's reserve.
        revenuePool += net;
        if (net != 0) {
            // With shares outstanding it is immediately claimable; with none left it stays in raisedBnb
            // so recoverBnb can sweep it.
            if (outstandingShares == 0) raisedBnb += net;
            else _bookSurplus(net);
        }
        emit RevenueDeposited(msg.value, fee, net);
    }

    // ─────────────────────────── views ───────────────────────────
    // `scene` and `phase` already have public getters.

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

    /// @notice Listing detail by id.
    /// @param id Listing id.
    /// @return seller Listing seller.
    /// @return shares Shares still listed.
    /// @return priceBnbPerShare Price per share in wei.
    /// @return open Whether the listing can still be taken.
    function getListing(uint256 id) external view returns (address seller, uint256 shares, uint256 priceBnbPerShare, bool open) {
        if (id >= _listings.length) revert NoListing();
        Listing storage l = _listings[id];
        return (l.seller, l.shares, l.priceBnbPerShare, l.open);
    }

    // ─────────────────────────── internal ───────────────────────────

    /// @dev Book `raisedBnb` as holder-claimable surplus. Stores only the pool / base; holders pull in
    ///      claimSurplus. No-op when it is 0 or no shares are outstanding.
    function _returnSurplus() internal {
        uint256 pool = raisedBnb;
        if (pool == 0) return;
        // Nobody left to pay: keep it in raisedBnb so recoverBnb sees it.
        if (outstandingShares == 0) return;
        _bookSurplus(pool);
        // The principal pool is zeroed; recoverBnb reserves surplusPool − surplusPaid, so it stays safe.
        raisedBnb = 0;
    }

    /// @dev Add `amount` to the pull-claimable surplus. The first booking of a round fixes the denominator
    ///      at the current outstandingShares; later top-ups share that base, which cannot drift because
    ///      shares only move after pooling. Counters are never reset mid-round, or early claimants would be
    ///      paid twice. Once every base share is counted the round cannot pay again, so fresh money opens a
    ///      new round. Callers guarantee outstandingShares != 0.
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

    /// @notice Claim your booked surplus. Covers the lazily computed entitlement plus any amount whose
    ///         earlier transfer failed. A failed send reverts, so the accrual stays claimable.
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
            // Reverts the whole call, keeping pendingSurplus intact so the holder can retry.
            revert TransferFailed();
        }
        _surplusClaimed[msg.sender] += amt;
        emit SurplusClaimed(msg.sender, amt);
    }

    /// @dev The single source of the surplus math: `who`'s uncounted shares this round and their value.
    ///      View-only, so the writer and the surplusOf view cannot diverge. Listed shares count too: they
    ///      are still the holder's, and excluding them would lock a seller out while the listing lives.
    /// @param who Wallet to evaluate.
    /// @return newShares Uncounted shares; 0 when nothing is left or they exceed the base.
    /// @return amt BNB they are worth (the last claimant also takes the dust).
    /// @return already Shares already counted for `who` this round.
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

    /// @dev Book a holder's entitlement into pendingSurplus; each share is counted once per round, so
    ///      repeated calls never pay twice.
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
    /// @return BNB `who` could take with claimSurplus.
    function surplusOf(address who) external view returns (uint256) {
        uint256 amt = pendingSurplus[who];
        if (amt != 0) return amt;
        (, amt, ) = _surplusEntitlement(who);
        return amt;
    }

    /// @dev Move the current round's counted shares from `from` to `to`, so a share is counted once per
    ///      round however often it is resold. Without this a seller could claim, resell, and let the buyer
    ///      claim the same shares again — draining the pool from the other holders.
    /// @param from Seller whose counter shrinks.
    /// @param to Buyer that inherits it.
    /// @param count Shares sold.
    function _moveSurplusCount(address from, address to, uint256 count) internal {
        if (surplusBase == 0 || surplusCountedRound[from] != surplusRound) return;
        uint256 counted = surplusCounted[from];
        if (counted == 0) return;
        uint256 moved = count < counted ? count : counted;
        surplusCounted[from] = counted - moved;
        if (surplusCountedRound[to] == surplusRound) {
            surplusCounted[to] += moved;
        } else {
            surplusCountedRound[to] = surplusRound;
            surplusCounted[to] = moved;
        }
    }

    /// @dev Hand held parts to the owner. Only abandonOrder calls this, after no share is outstanding and
    ///      every holder was repaid. A failing transfer is skipped so the owner cannot block the call.
    function _returnHeldParts() internal {
        IERC1155 token = IERC1155(transistors);
        for (uint256 id = 0; id < 2; id++) {
            uint256 amount = token.balanceOf(address(this), id);
            if (amount == 0) continue;
            try token.safeTransferFrom(address(this), owner, id, amount, "") {} catch {}
        }
    }

    /// @dev Thin wrapper so every caller reads the same `owed(address(this))`.
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

    /// @dev True when a real order was paid for (`priceLock`) and the market has nothing left to fill.
    ///      priceLock is essential: a never-ordered round has bid ids 0, so orderFilled would read true and
    ///      Ready → Mining could be faked with no purchase. Parts on hand are checked only in _readyInvariant.
    /// @return Whether a real, fully filled purchase backs the round.
    function _purchaseSettled() internal view returns (bool) {
        return priceLock != 0 && orderFilled();
    }

    /// @dev Delivery invariant for the normal path into Ready: the purchase is settled AND the ordered
    ///      quantity is on hand, so a market that burns the escrow without delivering cannot pass.
    /// @return Whether the round may be confirmed Ready.
    function _readyInvariant() internal view returns (bool) {
        return _purchaseSettled() && _partsOnHand();
    }

    /// @dev True when every share ever sold was repaid at the subscription price. A short pool means part
    ///      of the money sits in the parts, so releasing them for a pro-rata refund would be a discounted
    ///      sale. Callers only run at outstandingShares == 0.
    /// @return Whether holders were made whole.
    function _holdersMadeWhole() internal view returns (bool) {
        return totalRefunded >= sold * sharePriceBnb;
    }

    /// @dev True when the round holds any of its own parts; they back the outstanding shares, so the refund
    ///      exits stay closed while the pool cannot repay every share.
    /// @return Whether the contract holds NAND or LATCH parts of this round.
    function _partsHeld() internal view returns (bool) {
        IERC1155 token = IERC1155(transistors);
        return token.balanceOf(address(this), 0) != 0 || token.balanceOf(address(this), 1) != 0;
    }

    /// @dev True while `raisedBnb` alone can repay every outstanding share at the subscription price.
    /// @return Whether the escrow covers the whole debt.
    function _poolCoversEveryShare() internal view returns (bool) {
        return raisedBnb >= outstandingShares * sharePriceBnb;
    }

    /// @dev Basis for entering Ready on a recovery path (setPhase / depositToPool): a settled purchase OR
    ///      parts on hand. The second term matters because cancelling a partially filled order clears
    ///      `priceLock` while the delivered parts stay. The delivery proof still applies on the normal path.
    /// @return Whether the round may enter Ready through an admin / pooling path.
    function _readyBasis() internal view returns (bool) {
        return _purchaseSettled() || _partsHeld();
    }

    /// @dev Start of the non-owner grace window: the later of sell-out and last order, so an owner that
    ///      keeps ordering is never griefed.
    /// @return Unix timestamp the grace window is measured from.
    function _graceBase() internal view returns (uint256) {
        return uint256(lastOrderAt) > uint256(soldOutAt) ? uint256(lastOrderAt) : uint256(soldOutAt);
    }

    /// @dev Reject an empty order (ZeroShares) or a funded leg priced 0 (ZeroPrice).
    /// @param nandQty_ NAND quantity.
    /// @param nandPrice_ NAND price in wei; must be > 0 when nandQty_ > 0.
    /// @param latchQty_ LATCH quantity.
    /// @param latchPrice_ LATCH price in wei; must be > 0 when latchQty_ > 0.
    function _requireLegParams(uint256 nandQty_, uint96 nandPrice_, uint256 latchQty_, uint96 latchPrice_) internal pure {
        if (nandQty_ == 0 && latchQty_ == 0) revert ZeroShares();
        if ((nandQty_ > 0 && nandPrice_ == 0) || (latchQty_ > 0 && latchPrice_ == 0)) revert ZeroPrice();
    }

    /// @dev Place one bid leg. Returns 0 for a zero quantity; reverts BadBidId if the market returns 0.
    /// @param tokenId 0 NAND, 1 LATCH.
    /// @param qty Units to bid for.
    /// @param price Price per unit in wei.
    /// @param cost Escrow sent (qty × price).
    /// @return id Market bid id, or 0 when the leg is skipped.
    function _placeBidLeg(uint8 tokenId, uint256 qty, uint96 price, uint256 cost) internal returns (uint256 id) {
        if (qty == 0) return 0;
        id = materialMarket.placeBid{value: cost}(transistors, tokenId, price, qty);
        if (id == 0) revert BadBidId();
    }

    /// @dev Highest unit price this round paid for a token id; the sell floor. 0 when never bought.
    /// @param tokenId 0 NAND, 1 LATCH.
    /// @return Unit cost basis in wei.
    function _costBasis(uint8 tokenId) internal view returns (uint256) {
        return tokenId == 0 ? uint256(nandCostBasis) : uint256(latchCostBasis);
    }

    /// @dev Raise (never lower) the cost basis: the highest unit price ever paid. Skipping the leg later
    ///      must not wipe the floor for parts still held, and a cheaper re-buy must not license a dump of
    ///      the earlier parts.
    /// @param current Basis stored so far.
    /// @param qty Quantity bought on this leg; 0 leaves it untouched.
    /// @param price Unit price paid on this leg.
    /// @return Updated basis.
    function _raiseCostBasis(uint96 current, uint256 qty, uint96 price) internal pure returns (uint96) {
        if (qty == 0 || price <= current) return current;
        return price;
    }

    /// @dev A skipped leg has id 0 and _remaining(0) reads 0, so "empty leg counts as filled" falls out.
    /// @param id Market bid id; 0 reads as filled.
    /// @return Whether the leg has no market remainder.
    function _legFilled(uint256 id) internal view returns (bool) {
        return _remaining(id) == 0;
    }

    /// @dev True when at least one unit was taken, including a leg already down to 0.
    /// @param id Market bid id; 0 reads as 0.
    /// @param qty Quantity ordered on that leg; a skipped leg leaves both at 0, so 0 < 0 is false.
    /// @return Whether remaining < qty, i.e. somebody filled part of it.
    function _filledSome(uint256 id, uint256 qty) internal view returns (bool) {
        return _remaining(id) < qty;
    }

    /// @dev Cancel the unfilled remainder: a filled leg would revert, a skipped leg reads 0.
    /// @param id Market bid id.
    function _cancelOpenLeg(uint256 id) internal {
        if (_remaining(id) != 0) materialMarket.cancelBid(id);
    }

    /// @dev True when `raisedBnb` can no longer repay every outstanding share at the subscription price.
    /// @return Whether refund would pay pro-rata instead of in full.
    function _shortfall() internal view returns (bool) {
        return raisedBnb < outstandingShares * sharePriceBnb;
    }

    /// @dev True when every ordered leg is already delivered (id 0 = NAND, 1 = LATCH).
    /// @return Whether the ordered quantity is on hand.
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

    /// @dev Drop the live bid so no reader sees a stale order (readers gate on id != 0).
    function _clearOrder() internal {
        nandBidId = latchBidId = nandQty = latchQty = 0;
        nandPrice = 0;
        latchPrice = 0;
        priceLock = 0;
    }

    /// @dev Cancel both open legs, pull what the market owes, drop the record and return to Buying.
    ///      No-op unless Listed.
    function _cancelLiveOrder() internal {
        if (phase != Phase.Listed) return;
        _cancelOpenLeg(nandBidId);
        _cancelOpenLeg(latchBidId);
        // Without this the pool would stay short while the money sits claimable in the market.
        _pullOwedSoft();
        _clearOrder();
        _setPhase(Phase.Buying);
        emit TransistorOrderCancelled();
    }

    /// @dev Withdraw what the market owes, ignoring one that cannot pay: the cancel path must not be blocked
    ///      by a reverting withdraw. Pool-dividing callers keep their own `_owed() > 0` guard.
    function _pullOwedSoft() internal {
        if (_owed() == 0) return;
        try materialMarket.withdraw() {} catch {}
    }

    /// @dev Withdraw what the market owes; receive credits `raisedBnb`. No-op at 0.
    function _pullOwed() internal {
        if (_owed() > 0) materialMarket.withdraw();
    }

    /// @dev ERC1155 single-token receive hook; the market delivers parts with safeTransferFrom.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    /// @notice Batch delivery hook.
    /// @dev Required when the market delivers both legs in one safeBatchTransferFrom; without it the
    ///      delivery reverts after `remaining` was already decremented, trapping principal and parts.
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
    ///         recovery. Moves no tokens and does not cancel the market order — cancel or abandon the live
    ///         bid first, or its escrow stays on the market.
    ///         Listed needs a live bid with unfilled quantity; Ready needs a settled purchase or parts on
    ///         hand. Ready → Buying is the recovery path.
    /// @param next 1 Buying, 2 Listed, 3 Ready. None (0) is refused — it would close ordering and every
    ///        refund path except abandonOrder.
    function setPhase(uint8 next) external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Listed) revert AlreadyListed();
        // Listed must mean a bid with unfilled quantity is really on the market; a stale id (already filled
        // and confirmed Ready) would otherwise fake it, block every later setPhase, and have no cancel path.
        if (next == uint8(Phase.Listed) && _remaining(nandBidId) + _remaining(latchBidId) == 0) revert WrongScene();
        if (next == uint8(Phase.None) || next > uint8(Phase.Ready)) revert WrongScene();
        if (next == uint8(Phase.Ready) && !_readyBasis()) revert TransistorsNotReady();
        // Once the principal is booked as surplus, refunds are closed: leaving Ready pays nothing and only
        // a return to Ready can move the round on. Refuse when that way back is already gone (no parts and
        // no settled purchase), or the round would sit in Buying with every exit reverting.
        if (surplusBase != 0 && next != uint8(Phase.Ready) && !_readyBasis()) revert WrongScene();
        _setPhase(Phase(next));
    }

    /// @notice Sweep BNB no share is entitled to; the recipient is always the owner. While shares are
    ///         outstanding only the excess over escrow leaves; once all are settled the whole balance leaves
    ///         and `raisedBnb` is zeroed. Unclaimed fees and surplus are never touched.
    function recoverBnb() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        // Reserved: unclaimed fees + unclaimed surplus (which already includes booked revenue and
        // totalPendingSurplus, so never add those again). revenuePool is display only.
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

    /// @dev Low-level send; false instead of reverting on a rejecting recipient.
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
