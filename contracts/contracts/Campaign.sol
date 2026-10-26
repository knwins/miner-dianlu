// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {IERC721} from "./interfaces/IERC721.sol";
import {ICircuitMarket} from "./interfaces/ICircuitMarket.sol";
import {IPodMining} from "./interfaces/IPodMining.sol";
import {IBemToken} from "./interfaces/IBemToken.sol";

/// @title Campaign — one BEM crowdfunding round, backed by official circuit NFTs
/// @notice Scenes: Funding → Executing → Mining. Executing phases: Buying → Ready.
///         Funding:   subscription BNB accumulates in `raisedBnb`.
///         Executing: `buyCircuits` takes resting listings from the official Circuit Market (one NFT per
///                    listing, exact price). An unaffordable batch sets `executionFailed` without
///                    reverting. `confirmCircuits` moves to Ready once at least one NFT is held.
///         Mining:    `startMining` enters the official PoD mining contract in the round's own name
///                    (the round holds the NFT, so `start` / `claim` pay this contract), books the leftover
///                    BNB as holder-claimable surplus, and moves the scene to Mining. `stopMining` settles
///                    one circuit; `claimMiningRewards` harvests every active circuit. Claimed BEM is
///                    booked per share and each holder pulls with `claimBem`.
///         Holder payouts are pulls (refund / claimSurplus / claimBem); fee recipients pull BEM via
///         claimFee. Share sales are Mining-only and pay the seller directly. Only a market that served
///         this round may send BNB in (see receive). Rules: contracts/README.md §8.
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
        Buying, // may take circuit listings
        Ready // at least one circuit NFT is held
    }

    struct Listing {
        address seller;
        uint256 shares;
        uint256 priceBnbPerShare;
        bool open;
    }

    /// @notice Grace period before a non-owner may flag the round as failed.
    uint256 internal constant FAIL_GRACE = 3 days;
    /// @notice Service-fee cap in bps (1000 = 10%). Charged on official PoD BEM harvest only;
    ///         subscription BNB is never charged.
    uint16 internal constant MAX_SERVICE_FEE_BPS = 1000;
    /// @notice Max fee recipients; bounds the accrual loop and storage.
    uint256 internal constant MAX_FEE_RECIPIENTS = 3;
    /// @notice Max circuit NFTs a round may buy. Bounds the startMining / recovery loops.
    uint256 internal constant MAX_CIRCUITS = 100;

    // ─────────────────────── immutable config (fixed at creation) ───────────────────────
    uint256 public immutable sharePriceBnb; // price per share (wei)
    uint256 public immutable totalShares; // share cap
    uint64 public immutable fundingDeadline; // funding deadline (unix seconds)
    /// @notice Circuit NFT collection (ERC721) this round locks; every purchase and startMining uses it.
    address public immutable circuits;
    /// @notice Official PoD mining contract. Rewards are minted to the NFT holder = this round.
    address public immutable podMining;
    /// @notice Official BEM token, paid out to holders pro-rata from `claimMiningRewards`.
    address public immutable bem;
    /// @notice Circuit Market used for buys and listings. Replaceable via setCircuitMarket; past markets
    ///         stay accepted BNB senders.
    ICircuitMarket public circuitMarket;

    // ─────────────────────── mutable state ───────────────────────
    Scene public scene;
    Phase public phase;
    /// @notice Circuit breaker. Stops money-in and irreversible-out; NEVER stops a holder exit. Owner-only,
    ///         like every other entry point: the owner is expected to be a multisig, not a hot wallet.
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
    /// @notice Accrued-but-unclaimed BEM fee per recipient; pulled via claimFee().
    mapping(address => uint256) public pendingFee;
    /// @notice Sum of pendingFee (BEM wei still held for recipients).
    uint256 public totalPendingFee;
    /// @notice Fee table already written; frozen forever after that (even at 0 bps).
    bool public serviceFeeSet;
    /// @notice When the round sold out; 0 = never sold out.
    uint64 public soldOutAt;
    /// @notice Timestamp of the last buyCircuits; part of the markFailed grace base.
    uint64 public lastOrderAt;
    /// @notice Set by an unaffordable batch or markFailed; cleared by a successful purchase.
    bool public executionFailed;

    /// @notice Subscription escrow. Buys debit it; receive credits market proceeds.
    uint256 public raisedBnb;
    /// @notice Cumulative principal refunded; surplus payouts move `surplusPaid` instead.
    uint256 public totalRefunded;
    /// @notice Cumulative BEM service fee paid out via claimFee.
    uint256 public totalFeesPaid;

    /// @notice Cumulative BNB paid for circuit NFTs. 0 = no purchase, so Ready / Mining cannot be faked.
    uint256 public priceLock;
    /// @notice Every circuit tokenId ever bought, in purchase order. Some may have been sold since; use
    ///         ownerOf / circuitHeldCount() to distinguish what is still here.
    uint256[] public circuitIds;
    /// @notice Unit price paid per tokenId; the floor for listing it back on the market.
    mapping(uint256 => uint96) public circuitCostBasis;
    /// @notice Active market listing id per tokenId; 0 = not listed.
    mapping(uint256 => uint256) public circuitListingId;
    /// @notice Number of live listings; startMining requires zero.
    uint256 public activeListingCount;
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

    // ─────────────────────── BEM rewards (official mining output) ───────────────────────
    /// @notice BEM wei credited per 1e18 share, monotonic while Mining. Every claim/stop books its reward
    ///         here, so the split never needs a holder loop.
    uint256 public bemAccPerShare;
    /// @notice Cumulative BEM received from the official mining contract.
    uint256 public totalBemRewards;
    /// @notice BEM already settled for a wallet but not paid yet (pulled via claimBem).
    mapping(address => uint256) public pendingBem;
    /// @notice BEM already paid to a wallet.
    mapping(address => uint256) public bemClaimed;
    /// @notice High-water mark of `shares × bemAccPerShare` already settled per wallet.
    mapping(address => uint256) private _bemDebt;

    Listing[] private _listings;
    /// @dev Markets that ever served this round; receive accepts their BNB. Mapping keeps the check O(1).
    mapping(address => bool) private _marketSeen;

    // ─────────────────────── events ───────────────────────
    /// @notice Circuit breaker toggled. `by` is whoever halted or resumed.
    event HaltChanged(address indexed by, bool halted);
    event Subscribed(address indexed subscriber, uint256 count, uint256 paidBnb);
    event Refunded(address indexed holder, uint256 amountBnb);
    /// @notice Surplus paid by claimSurplus; not principal.
    event SurplusClaimed(address indexed holder, uint256 amountBnb);
    event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare);
    event ListingCancelled(uint256 indexed id, address indexed seller, uint256 shares);
    event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb);
    /// @notice One circuit NFT bought from a market listing.
    event CircuitBought(uint256 indexed tokenId, uint256 indexed listingId, uint256 price);
    /// @notice Summary of one buyCircuits batch.
    /// @param count NFTs taken in the batch.
    /// @param paidBnb Total price paid (not a unit price).
    event CircuitsBought(uint256 count, uint256 paidBnb);
    /// @notice The round holds at least one circuit NFT and moved to Ready.
    event CircuitsConfirmed();
    /// @notice One circuit NFT listed on the market for resale.
    event CircuitListed(uint256 indexed tokenId, uint256 indexed listingId, uint256 price);
    /// @notice A circuit listing was cancelled (or was already gone).
    event CircuitListingCancelled(uint256 indexed tokenId, uint256 indexed listingId);
    /// @notice needBnb = unaffordable cost (0 for markFailed); raisedBnb = escrow then. Neither reverts.
    event ExecutionFailed(uint256 needBnb, uint256 raisedBnb);
    /// @notice Refunds are open; nothing was transferred, each holder pulls with refund.
    /// @param outstandingShares Shares still owed.
    /// @param escrowBnb Pool the pro-rata split divides.
    event RefundsOpened(uint256 outstandingShares, uint256 escrowBnb);
    event PlanUpdated(uint256 estHashpower);
    event CircuitMarketUpdated(address indexed previous, address indexed next);
    /// @notice Per-token approval of a former circuit market was revoked.
    event CircuitApprovalRevoked(uint256 indexed tokenId, address indexed market);
    /// @notice Market proceeds pulled into the round by withdrawMarketProceeds.
    event MarketProceedsWithdrawn(uint256 amount);
    /// @notice BNB swept by recoverBnb; `to` is always the owner.
    event BnbRecovered(uint256 amount, address indexed to);
    /// @notice Official mining started for one circuit; the round is the miner and the NFT holder.
    event MiningStarted(uint256 indexed tokenId, bytes32 indexed key, uint32 taskId);
    /// @notice Official mining stopped for one circuit; `stop` settled its reward to the round.
    event MiningStopped(uint256 indexed tokenId, bytes32 indexed key);
    /// @notice Official rewards harvested; `grossBem` is what the mining contract minted to the round.
    event MiningRewardsClaimed(uint256 count, uint256 grossBem);
    /// @notice BEM paid out by claimBem.
    event BemPaid(address indexed holder, uint256 amount);
    /// @notice Executing sub-phase changed; _setPhase is the only writer.
    event PhaseChanged(uint8 indexed previous, uint8 indexed next);
    /// @notice Surplus booked for a holder; claimable via claimSurplus.
    event SurplusAccrued(address indexed holder, uint256 amountBnb);
    /// @notice Leftover subscription BNB booked for pro-rata return (returnSurplus); the round keeps going.
    event SurplusReturned(uint256 amountBnb, uint256 baseShares);
    /// @notice Fee table set; only possible while nobody has subscribed.
    event ServiceFeeSet(uint16 feeBps, address[] recipients, uint16[] sharesBps);
    /// @notice BEM fee share booked for a recipient; pulled via claimFee.
    event FeeAccrued(address indexed to, uint256 amount);
    /// @notice BEM fee share paid out by claimFee.
    event FeePaid(address indexed to, uint256 amount);
    /// @notice Owner added BNB so every outstanding share can be repaid at the subscription price.
    event ShortfallToppedUp(uint256 amount, uint256 raisedBnb);

    // ─────────────────────── errors ───────────────────────
    error DirectTransferNotAllowed();
    /// @notice Business entry refused by the circuit breaker. Holder exits are never halted.
    error Halted();
    error WrongScene();
    error FundingEnded();
    error CircuitsNotReady();
    error RefundNotAvailable();
    /// @dev Reused as "nothing to settle": zero quantity, zero amount, or nothing left to pay.
    error ZeroShares();
    error ZeroPrice();
    error BadCount();
    error InsufficientShares();
    /// @notice Circuits still back outstanding shares; settle the holders first.
    error SharesOutstanding();
    /// @notice Holders were not repaid at the subscription price, so the circuits are still their collateral.
    error HoldersNotMadeWhole();
    /// @notice The pool cannot repay every share, so the circuits in hand are their collateral. Refunding
    ///         would zero the shares and leave the circuits with no claimant.
    error CircuitsAreCollateral();
    error ExceedsRemaining();
    error WrongPayment();
    error NoListing();
    error NotSeller();
    error CannotTakeOwnListing();
    error AlreadyListed();
    error NotListed();
    error TransferFailed();
    /// @notice Market proceeds are still in owed(); pull them first so the refund pool is final.
    error ProceedsPending();
    /// @notice buyCircuits: the listing is gone, the price changed, or the token is no longer the seller's.
    error NotACircuit();
    /// @notice buyCircuits: the listing belongs to this contract.
    error SelfTrade();
    /// @notice The market returned listing id 0.
    error BadListingId();
    /// @notice buyCircuits: BNB left but the NFT did not arrive.
    error CircuitNotDelivered();
    /// @notice listCircuit: the token is not owned by this round.
    error NotACircuitOwner();
    /// @notice listCircuit / startMining: a circuit is still listed for sale.
    error CircuitStillListed();
    /// @notice startMining: the official mining contract already reports this circuit as active.
    error AlreadyMining();
    /// @notice claimMiningRewards: nothing was harvested.
    error NoRewards();
    /// @notice buyCircuits: the round would exceed MAX_CIRCUITS.
    error TooManyCircuits();
    /// @notice returnSurplus already booked the principal; refund / abandon would zero shares for 0 BNB.
    error SurplusAlreadyReturned();
    /// @notice Ready: use returnSurplus, which must not touch the circuits.
    error UseReturnSurplus();
    /// @notice Invalid fee table (cap, length, duplicate / zero recipient, shares not summing to 10000).
    ///         Also raised by the fee getters for an out-of-range index.
    error BadFeeConfig();
    /// @notice The fee table is already set and frozen.
    error ServiceFeeAlreadySet();
    /// @notice The fee is frozen because somebody already subscribed.
    error ServiceFeeLocked();
    /// @notice Funding is closed until the owner calls setServiceFee (including explicit 0).
    error ServiceFeeNotSet();
    /// @notice The round never sold out; no circuit purchase may be made.
    error NotSoldOutYet();

    /// @param sharePriceBnb_ Price of one share in wei.
    /// @param totalShares_ Share cap; also the sell-out threshold.
    /// @param fundingDeadline_ Funding deadline in unix seconds (inclusive).
    /// @param circuitMarket_ Initial market; replaceable via setCircuitMarket.
    /// @param owner_ Campaign owner (the factory owner in practice).
    /// @param circuits_ Circuit NFT collection; must be whitelisted by the factory.
    /// @param podMining_ Official PoD mining contract.
    /// @param bem_ Official BEM token paid out by official mining.
    /// @param factory_ Factory that requested this deployment; used for the registry check.
    constructor(
        uint256 sharePriceBnb_,
        uint256 totalShares_,
        uint64 fundingDeadline_,
        address circuitMarket_,
        address owner_,
        address circuits_,
        address podMining_,
        address bem_,
        address factory_
    ) Ownable(owner_) {
        if (circuitMarket_ == address(0) || circuits_ == address(0)) revert ZeroAddress();
        if (podMining_ == address(0) || bem_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        // A codeless target would make every call revert with empty returndata, bricking the round.
        if (circuitMarket_.code.length == 0 || circuits_.code.length == 0) revert ZeroAddress();
        if (podMining_.code.length == 0 || bem_.code.length == 0) revert ZeroAddress();
        factory = factory_;
        if (totalShares_ == 0 || sharePriceBnb_ == 0) revert ZeroShares();
        sharePriceBnb = sharePriceBnb_;
        totalShares = totalShares_;
        fundingDeadline = fundingDeadline_;
        circuitMarket = ICircuitMarket(circuitMarket_);
        circuits = circuits_;
        podMining = podMining_;
        bem = bem_;
        scene = Scene.Funding;
        phase = Phase.None;
    }

    // ─────────────────────────── circuit breaker ───────────────────────────

    /// @notice Trip the circuit breaker. Owner only — one role, one key (a multisig in practice).
    ///         Blocks money-in (`subscribe`), circuit buys / listings, starting mining, and the secondary
    ///         share market. Holder exits are never blocked.
    function halt() external onlyOwner {
        if (halted) revert Halted();
        halted = true;
        emit HaltChanged(msg.sender, true);
    }

    /// @notice Lift the circuit breaker. Owner only.
    function resume() external onlyOwner {
        if (!halted) revert WrongScene();
        halted = false;
        emit HaltChanged(msg.sender, false);
    }

    /// @dev Circuit breaker for business entry points. Never applied to refund / surplus / fee pulls,
    ///      to cancelling a listing or to the admin recovery exits, so a halt can never lock assets.
    modifier whenLive() {
        if (halted) revert Halted();
        _;
    }

    /// @dev Accept BNB only from a market that ever served this round (listing proceeds, withdraw). Any
    ///      other sender could inflate the refund pool; past markets stay accepted because settlement is
    ///      asynchronous.
    receive() external payable {
        if (!_isKnownMarket(msg.sender)) revert DirectTransferNotAllowed();
        raisedBnb += msg.value;
        // Once mining, there is no refund path: a late credit is booked as holder surplus instead.
        if (scene == Scene.Mining) _returnSurplus();
    }

    /// @notice IERC721Receiver hook. Official Circuit Market delivers NFTs via `safeTransferFrom`;
    ///         without this the buy reverts `ERC721InvalidReceiver(campaign)` and the round can never
    ///         take a listing. Only the locked `circuits` collection is accepted.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != circuits) revert NotACircuit();
        return this.onERC721Received.selector;
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
        return who == address(circuitMarket) || _marketSeen[who];
    }

    /// @notice Replace the circuit market. Blocked while a listing is live. BNB the old market owes is
    ///         pulled first (best effort), its per-token approvals are revoked, and it stays an accepted
    ///         BNB sender.
    /// @param circuitMarket_ New market; must have code.
    function setCircuitMarket(address circuitMarket_) external onlyOwner nonReentrant {
        if (circuitMarket_ == address(0)) revert ZeroAddress();
        // A codeless market would revert every list / buy / owed call.
        if (circuitMarket_.code.length == 0) revert ZeroAddress();
        // A live listing would be stranded on the old market.
        if (activeListingCount != 0) revert AlreadyListed();
        // owed() is per market, so leftovers become unreachable after a swap. Drain first, but never let
        // a market that refuses to pay block the escape hatch.
        if (_owed() > 0) {
            try circuitMarket.withdraw() {} catch {}
        }
        address previous = address(circuitMarket);
        if (previous != circuitMarket_) {
            _revokeCircuitApprovals(previous);
        }
        emit CircuitMarketUpdated(previous, circuitMarket_);
        // Keep accepting late settlement from the market we leave.
        _marketSeen[previous] = true;
        circuitMarket = ICircuitMarket(circuitMarket_);
    }

    /// @dev Revoke a market's per-token approvals; silent on failure.
    /// @param market Former market whose approvals are dropped.
    function _revokeCircuitApprovals(address market) internal {
        if (market == address(0)) return;
        for (uint256 i = 0; i < circuitIds.length; i++) {
            uint256 id = circuitIds[i];
            if (!_ownsCircuit(id)) continue;
            try IERC721(circuits).getApproved(id) returns (address approved) {
                if (approved != market) continue;
                try IERC721(circuits).approve(address(0), id) {
                    emit CircuitApprovalRevoked(id, market);
                } catch {}
            } catch {}
        }
    }

    /// @dev Clear this token's approval; silent on failure.
    /// @param tokenId Token whose approval is dropped.
    function _revokeCircuitApproval(uint256 tokenId) internal {
        try IERC721(circuits).approve(address(0), tokenId) {} catch {}
    }

    /// @notice Store the display-only hashpower estimate. Owner only; Funding and Executing/Buying only.
    ///         UI writes `heldCircuits × processorScale`, not a fundraising guess. Call before confirmCircuits:
    ///         Ready and Mining refuse (matches mainnet bytecode already deployed).
    /// @param estHashpower_ Read by the UI only.
    function setPlan(uint256 estHashpower_) external onlyOwner {
        if (scene == Scene.Mining) revert WrongScene();
        if (scene == Scene.Executing && phase != Phase.Buying) revert WrongScene();
        estHashpower = estHashpower_;
        emit PlanUpdated(estHashpower_);
    }

    // ─────────────────────────── subscribe ───────────────────────────

    /// @notice Buy `count` shares for exactly count × sharePriceBnb, up to and including the deadline.
    ///         A sell-out moves the round to Executing/Buying. Subscription BNB pays no service fee.
    ///         Requires `serviceFeeSet` so create→fee cannot be front-run into a permanent 0-fee lock.
    /// @param count Shares to buy; > 0 and within the remaining supply.
    function subscribe(uint256 count) external payable nonReentrant whenLive {
        if (scene != Scene.Funding) revert WrongScene();
        if (!serviceFeeSet) revert ServiceFeeNotSet();
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

    /// @notice Set the service fee and its split table. Owner only, only while unset and `sold == 0`, then frozen.
    ///         Must run before any subscribe (subscribe reverts ServiceFeeNotSet until then).
    ///         Charged on official PoD BEM harvest only; subscription BNB never. 0 bps + empty table = no fee.
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

    /// @notice Pull your accrued BEM service fee. A failed transfer reverts, so the accrual stays claimable.
    function claimFee() external nonReentrant {
        uint256 amt = pendingFee[msg.sender];
        if (amt == 0) revert ZeroShares();
        pendingFee[msg.sender] = 0;
        totalPendingFee -= amt;
        if (!IBemToken(bem).transfer(msg.sender, amt)) {
            pendingFee[msg.sender] = amt;
            totalPendingFee += amt;
            revert TransferFailed();
        }
        totalFeesPaid += amt;
        emit FeePaid(msg.sender, amt);
    }

    /// @dev Split harvested BEM into the fee table; return the sum of cuts actually booked.
    ///      Rounding dust stays with holders (fee never over-charged).
    /// @param gross BEM received from the official mining contract in this call.
    /// @return fee BEM withheld as service fee (0 when no fee is configured).
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
    ///         pro-rata of `raisedBnb`. Refused in Ready (the circuits are the holders' asset), while the
    ///         pool cannot repay circuit-backed shares (CircuitsAreCollateral), and after returnSurplus
    ///         booked the principal.
    function refund() external nonReentrant {
        if (scene == Scene.Funding) {
            // soldOutAt == 0 = never sold out.
            if (soldOutAt != 0 || block.timestamp <= fundingDeadline) revert RefundNotAvailable();
        } else if (scene == Scene.Executing) {
            // returnSurplus already paid the principal; refunding would zero shares for 0 BNB.
            if (surplusBase != 0) revert SurplusAlreadyReturned();
            if (phase != Phase.Buying) revert RefundNotAvailable();
            // Circuits in hand are the shares' collateral: zeroing the shares would strand them.
            if (_circuitsHeld() && !_poolCoversEveryShare()) revert CircuitsAreCollateral();
            if (!executionFailed && !_shortfall()) revert RefundNotAvailable();
        } else {
            revert RefundNotAvailable(); // Mining: shares are transferable, principal is gone.
        }

        // Shares and BNB settle in one transaction; a failed send reverts everything.
        if (_shares[msg.sender] == 0 || _escrow[msg.sender] != 0) revert ZeroShares();
        _refundOne(msg.sender);
    }

    /// @notice Owner tops the escrow up so every outstanding share can be repaid at the
    ///         subscription price. This is how the circuits may leave after a partial purchase: holders
    ///         are repaid first, then the owner takes the circuits at cost. Excess is sweepable with
    ///         recoverBnb.
    function topUpShortfall() external payable onlyOwner nonReentrant {
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

        // Settle both sides before shares move: already-earned BEM stays with the seller, and the buyer
        // starts accruing only from now on.
        _settleBem(l.seller);
        _settleBem(msg.sender);

        _escrow[l.seller] -= count;
        _shares[msg.sender] += count;
        // Reset debts to post-transfer entitlements. Buyer starts clean; seller must shrink debt
        // with remaining shares+escrow or later harvests stay stranded under the pre-sale debt.
        _bemDebt[msg.sender] = _bemEntitlement(msg.sender);
        _bemDebt[l.seller] = _bemEntitlement(l.seller);
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

    // ─────────────────────────── circuit purchases (owner) ───────────────────────────

    /// @notice Take resting Circuit Market listings. Owner only, Executing/Buying only. Every entry is
    ///         one NFT: `buy(listingId, price)` pays exactly `price`; the NFT must land here in the same
    ///         transaction. A batch costs `sum(prices)`; if that exceeds `raisedBnb` nothing is bought and
    ///         `executionFailed` is set (no revert). Repeatable until MAX_CIRCUITS.
    /// @dev The whole batch is atomic: one stale listing reverts every buy in it, so the owner retries with
    ///      fresh listings. There is no escrow left on the market between calls (unlike the old bid model).
    /// @param listingIds Market listing ids.
    /// @param tokenIds Circuit tokenIds to receive; must match the listings.
    /// @param prices Exact listing prices in wei; must match the live listing.
    function buyCircuits(
        uint256[] calldata listingIds,
        uint256[] calldata tokenIds,
        uint96[] calldata prices
    ) external onlyOwner nonReentrant whenLive {
        _requireExecuting();
        if (phase != Phase.Buying) revert WrongScene();
        // `sold` is monotonic, so refunds can never revoke this gate (README §8).
        if (sold < totalShares) revert NotSoldOutYet();

        uint256 n = listingIds.length;
        if (n == 0) revert ZeroShares();
        if (tokenIds.length != n || prices.length != n) revert BadCount();
        if (circuitIds.length + n > MAX_CIRCUITS) revert TooManyCircuits();

        uint256 cost;
        for (uint256 i = 0; i < n; i++) {
            if (prices[i] == 0) revert ZeroPrice();
            cost += uint256(prices[i]);
        }
        // Retrying a previously failed batch requires escrow that can still pay for it.
        if (cost > raisedBnb) {
            executionFailed = true;
            emit ExecutionFailed(cost, raisedBnb);
            return;
        }

        executionFailed = false;
        raisedBnb -= cost;
        for (uint256 i = 0; i < n; i++) {
            _buyOne(listingIds[i], tokenIds[i], prices[i]);
        }
        priceLock += cost;
        // Each purchase pushes the non-owner grace period forward, so an active owner is never griefed.
        lastOrderAt = uint64(block.timestamp);
        emit CircuitsBought(n, cost);
    }

    /// @dev Take one listing after re-checking it on-chain. No custody on the market side, so the seller
    ///      must still own the token; payment is exact; delivery is verified before returning.
    /// @param listingId Market listing id.
    /// @param tokenId Circuit token to buy.
    /// @param price Exact listing price.
    function _buyOne(uint256 listingId, uint256 tokenId, uint96 price) internal {
        (uint256 id, address seller, uint96 listedPrice, bool valid) =
            circuitMarket.listingFor(circuits, tokenId);
        if (!valid || id != listingId || listedPrice != price || seller == address(0)) revert NotACircuit();
        // Taking our own listing would round-trip the NFT and book fake movement.
        if (seller == address(this)) revert SelfTrade();
        // The market has no custody: a seller that moved the NFT away cannot deliver.
        if (IERC721(circuits).ownerOf(tokenId) != seller) revert NotACircuit();

        circuitMarket.buy{value: price}(listingId, price);
        if (IERC721(circuits).ownerOf(tokenId) != address(this)) revert CircuitNotDelivered();

        circuitIds.push(tokenId);
        circuitCostBasis[tokenId] = price;
        emit CircuitBought(tokenId, listingId, price);
    }

    /// @notice Move Buying → Ready once at least one circuit NFT is held. Moves no tokens; anyone may call
    ///         because it only confirms on-chain ownership.
    function confirmCircuits() external {
        _requireExecuting();
        if (phase != Phase.Buying) revert WrongScene();
        if (!_circuitsHeld()) revert CircuitsNotReady();
        _setPhase(Phase.Ready);
        emit CircuitsConfirmed();
    }

    /// @notice List a held circuit NFT for resale on the market. Owner only.
    ///         Allowed in Ready, or in Mining after this circuit has been stopped (official stop-then-sell).
    ///         Per-token approval (never setApprovalForAll). Price may be below cost (Owner discretion).
    ///         The NFT never leaves the contract until a buyer takes the listing; proceeds via owed + withdraw.
    /// @param tokenId Circuit token to list.
    /// @param price Listing price in wei.
    function listCircuit(uint256 tokenId, uint96 price) external onlyOwner nonReentrant whenLive {
        if (scene == Scene.Mining) {
            // Mining scene: sell only after stop (PoD status must not be active).
        } else {
            _requireReady();
        }
        if (price == 0) revert ZeroPrice();
        if (!_ownsCircuit(tokenId)) revert NotACircuitOwner();
        if (circuitListingId[tokenId] != 0) revert AlreadyListed();
        // Official path: stop mining before listing / transfer.
        if (IPodMining(podMining).getMiner(IPodMining(podMining).minerKey(circuits, tokenId)).status == 1) {
            revert AlreadyMining();
        }

        IERC721(circuits).approve(address(circuitMarket), tokenId);
        uint256 id = circuitMarket.list(circuits, tokenId, price);
        if (id == 0) revert BadListingId();
        circuitListingId[tokenId] = id;
        activeListingCount += 1;
        emit CircuitListed(tokenId, id, price);
    }

    /// @notice Cancel a circuit listing and clear its approval. Owner while the round is live; anyone once
    ///         the factory removed the round. Never halted: it is an exit.
    /// @param tokenId Circuit token whose listing is cancelled.
    function cancelCircuitListing(uint256 tokenId) external nonReentrant {
        uint256 id = circuitListingId[tokenId];
        if (id == 0) revert NotListed();
        if (msg.sender != owner && !_retired()) revert NotOwner(msg.sender);

        (uint256 liveId, address seller, , bool valid) = circuitMarket.listingFor(circuits, tokenId);
        // A listing already taken by a buyer is simply gone; otherwise delist it on the market.
        if (valid && liveId == id && seller == address(this)) {
            circuitMarket.delist(id);
        }
        circuitListingId[tokenId] = 0;
        activeListingCount -= 1;
        _revokeCircuitApproval(tokenId);
        emit CircuitListingCancelled(tokenId, id);
    }

    /// @notice Pull market proceeds into `raisedBnb` (via receive). Anyone may call; no-op at 0.
    function withdrawMarketProceeds() external nonReentrant {
        uint256 before = address(this).balance;
        _pullOwed();
        emit MarketProceedsWithdrawn(address(this).balance - before);
    }

    /// @notice Book the leftover subscription BNB as holder-claimable surplus without ending the round:
    ///         circuits stay, `phase` stays Ready, startMining stays available. No holder loop — each
    ///         holder pulls with claimSurplus. Requires nothing owed by the market, and closes
    ///         openRefund / abandon. Owner any time; anyone else after FAIL_GRACE, so a vanished team cannot
    ///         lock BNB.
    function returnSurplus() external nonReentrant {
        _requireReady();
        if (_owed() > 0) revert ProceedsPending();
        if (msg.sender != owner && block.timestamp < _graceBase() + FAIL_GRACE) revert RefundNotAvailable();
        if (outstandingShares == 0) revert ZeroShares();
        if (raisedBnb == 0) revert ZeroShares();
        _returnSurplus();
        emit SurplusReturned(surplusPool, surplusBase);
    }

    /// @notice Open refunds. Buying only — in Ready the exit is returnSurplus. Closed once returnSurplus
    ///         booked the principal. Moves no BNB: it flags the round failed and every holder pulls with
    ///         refund, so gas stays flat and no holder can block the call.
    ///         Owner: an abort switch, never a payout, and never halted.
    function openRefund() external onlyOwner nonReentrant {
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        // Nobody left to refund; the dust is swept by recoverBnb.
        if (outstandingShares == 0) revert ZeroShares();
        if (phase != Phase.Buying) revert WrongScene();
        // Circuits in hand are the shares' collateral; a short pool would burn them on refund.
        if (_circuitsHeld() && !_poolCoversEveryShare()) revert CircuitsAreCollateral();
        if (_owed() > 0) revert ProceedsPending();
        markFailed();
        emit RefundsOpened(outstandingShares, raisedBnb);
    }

    /// @notice Give up from Buying: pull what the market owes, open refunds, and hand the circuits to the
    ///         owner only if every share is settled and repaid. Pull-only, so gas stays flat. Refused in
    ///         Ready (exit is returnSurplus, then mining or resale).
    function abandonOrder() external onlyOwner nonReentrant {
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        _pullOwed();
        // The pool is final now; a short pool would burn the circuits-backed shares.
        if (_circuitsHeld() && !_poolCoversEveryShare()) revert CircuitsAreCollateral();
        markFailed();
        emit RefundsOpened(outstandingShares, raisedBnb);
        // Circuits leave only when no share is outstanding AND every share was repaid in full.
        if (outstandingShares == 0 && _holdersMadeWhole()) _returnHeldCircuits();
    }

    /// @notice Flag the round as failed so holders can refund. Owner any time; anyone else after FAIL_GRACE.
    ///         Refused in Ready, where the circuits are already the holders' asset. No-op when already
    ///         failed or not Executing. Never halted: it only opens the refund gate and moves no BNB.
    function markFailed() public {
        if (scene != Scene.Executing || executionFailed) return;
        // returnSurplus already returned the principal; flagging a refund would burn shares for 0 BNB.
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        if (msg.sender != owner && block.timestamp < _graceBase() + FAIL_GRACE) {
            revert RefundNotAvailable();
        }
        executionFailed = true;
        emit ExecutionFailed(0, raisedBnb);
    }

    // ─────────────────────────── official mining ───────────────────────────

    /// @dev Shared entry into the Mining scene. Books the leftover BNB as holder surplus before any circuit
    ///      starts producing, then flips the scene. No NFT leaves the round: the round itself is the miner
    ///      because it is the circuit NFT holder.
    ///      Owner-only callers; the factory dropping the round never opens this path.
    function _beginMining() internal {
        if (scene == Scene.Mining) return;
        _requireReady();
        if (activeListingCount != 0) revert CircuitStillListed();
        if (!_readyBasis()) revert CircuitsNotReady();
        if (outstandingShares == 0) revert ZeroShares();
        // Leftover BNB becomes pull-claimable surplus. Proceeds are part of it, so pull them first — best
        // effort: a market that cannot pay must not block starting the miners.
        _pullOwedSoft();
        _returnSurplus();
        scene = Scene.Mining;
    }

    /// @notice Start official PoD mining for one held circuit, in the round's own name.
    ///         `taskId == 0` (unverified pool) is the one-call path the UI uses: pass empty vectors and
    ///         anchor 0. For the verified pool, call `armMining` in an earlier block and pass that block as
    ///         `anchorBlock` plus the official task's sampled vectors and Merkle proofs.
    ///         The first call books the leftover BNB as holder surplus and moves the round to Mining.
    ///         Owner only, not halted, all listings cancelled first.
    ///         Unverified pool only (`taskId = 0`); verified-pool arm/sample path is out of scope to keep
    ///         CampaignDeployer under the 24KB limit.
    /// @param tokenId Circuit NFT held by the round.
    function startMining(uint256 tokenId) external onlyOwner nonReentrant whenLive {
        _beginMining();
        if (!_ownsCircuit(tokenId)) revert NotACircuitOwner();
        bytes32 key = IPodMining(podMining).minerKey(circuits, tokenId);
        // Bought an already-active miner (or second start): sync scene and return.
        if (IPodMining(podMining).getMiner(key).status == 1) {
            emit MiningStarted(tokenId, key, 0);
            return;
        }
        bytes[] memory none;
        bytes32[][] memory noneProofs;
        IPodMining(podMining).start(circuits, tokenId, 0, 0, none, none, noneProofs, bytes32(0));
        emit MiningStarted(tokenId, key, 0);
    }

    /// @notice Stop official mining for one held circuit. `stop` settles the reward to this round, which is
    ///         booked for holders immediately. The NFT stays here, so the circuit can be restarted after the
    ///         official cooldown (or listed back on the market while Ready). Owner only, never halted: the
    ///         stop is the exit from an active miner, not a new irreversible step.
    ///         If the round is still Ready but PoD already shows this circuit active (bought while mining),
    ///         enter Mining first so stop is reachable in one call.
    /// @param tokenId Circuit NFT held by the round.
    function stopMining(uint256 tokenId) external onlyOwner nonReentrant {
        if (!_ownsCircuit(tokenId)) revert NotACircuitOwner();
        bytes32 key = IPodMining(podMining).minerKey(circuits, tokenId);
        if (scene != Scene.Mining) {
            if (IPodMining(podMining).getMiner(key).status != 1) revert WrongScene();
            _beginMining();
        }
        uint256 before = IBemToken(bem).balanceOf(address(this));
        IPodMining(podMining).stop(key);
        _bookBem(IBemToken(bem).balanceOf(address(this)) - before);
        emit MiningStopped(tokenId, key);
    }

    /// @notice Harvest every active miner's reward. Anyone may call: the BEM is minted to this round and
    ///         booked per share, never to the caller. Holders then pull with `claimBem`.
    ///         If PoD already shows active miners while the round is still Ready (bought while mining),
    ///         enter Mining first so claim is reachable without a separate startMining.
    function claimMiningRewards() external nonReentrant {
        bytes32[] memory keys = _activeMiningKeys();
        if (scene != Scene.Mining) {
            if (keys.length == 0) revert WrongScene();
            _beginMining();
        } else if (keys.length == 0) {
            revert NoRewards();
        }
        uint256 before = IBemToken(bem).balanceOf(address(this));
        IPodMining(podMining).claimMany(keys);
        uint256 gross = IBemToken(bem).balanceOf(address(this)) - before;
        _bookBem(gross);
        emit MiningRewardsClaimed(keys.length, gross);
    }

    /// @notice Pull your share of the BEM harvested from official mining. A failed transfer reverts, so the
    ///         accrual stays claimable.
    function claimBem() external nonReentrant {
        _settleBem(msg.sender);
        uint256 amt = pendingBem[msg.sender];
        if (amt == 0) revert ZeroShares();
        pendingBem[msg.sender] = 0;
        if (!IBemToken(bem).transfer(msg.sender, amt)) revert TransferFailed();
        bemClaimed[msg.sender] += amt;
        emit BemPaid(msg.sender, amt);
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

    /// @notice Number of circuit NFTs ever bought (some may have been sold since).
    function circuitCount() external view returns (uint256) {
        return circuitIds.length;
    }

    /// @notice How many bought circuit NFTs this round still holds.
    function circuitHeldCount() public view returns (uint256 held) {
        for (uint256 i = 0; i < circuitIds.length; i++) {
            if (_ownsCircuit(circuitIds[i])) held += 1;
        }
    }

    /// @notice Official miner status: 0 none, 1 active, 2 revoked, 3 cooling.
    function miningStatus(uint256 tokenId) public view returns (uint8) {
        return IPodMining(podMining).getMiner(IPodMining(podMining).minerKey(circuits, tokenId)).status;
    }

    /// @notice Unsettled BEM for one circuit, straight from the official contract.
    function miningPending(uint256 tokenId) public view returns (uint256) {
        return IPodMining(podMining).pending(IPodMining(podMining).minerKey(circuits, tokenId));
    }

    /// @notice BEM a holder can pull right now, including accrual not yet settled into pendingBem.
    /// @param who Wallet to query.
    /// @return BEM wei.
    function bemPendingOf(address who) public view returns (uint256) {
        uint256 entitled = _bemEntitlement(who);
        uint256 debt = _bemDebt[who];
        return pendingBem[who] + (entitled > debt ? entitled - debt : 0);
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

    /// @dev Shares that count for BEM: unlocked plus escrowed (a listed share still belongs to the seller).
    /// @param who Wallet to evaluate.
    /// @return Entitlement at the current accumulator, scaled by 1e18.
    function _bemEntitlement(address who) internal view returns (uint256) {
        return ((_shares[who] + _escrow[who]) * bemAccPerShare) / 1e18;
    }

    /// @dev Move a wallet's live entitlement into pendingBem. Called before shares change hands and before
    ///      a pull, so an old holder never loses what was already earned.
    /// @param who Wallet to settle.
    function _settleBem(address who) internal {
        uint256 entitled = _bemEntitlement(who);
        uint256 debt = _bemDebt[who];
        if (entitled > debt) {
            pendingBem[who] += entitled - debt;
            _bemDebt[who] = entitled;
        }
    }

    /// @dev Book freshly harvested BEM: withhold service fee, then credit the net per share.
    ///      `outstandingShares` is fixed in Mining, so this is a pure accumulator (no holder loop);
    ///      fee rounding dust stays with holders.
    /// @param gross BEM minted by the official contract in this call.
    function _bookBem(uint256 gross) internal {
        if (gross == 0) return;
        totalBemRewards += gross;
        uint256 fee = _accrueServiceFee(gross);
        uint256 net = gross - fee;
        if (net == 0) return;
        uint256 base = outstandingShares;
        if (base == 0) {
            // No shares left to pay (cannot happen on the start path, but keeps BEM from being stranded).
            pendingBem[owner] += net;
            return;
        }
        bemAccPerShare += (net * 1e18) / base;
    }

    /// @dev Every key the official contract still reports as active for a circuit this round owns.
    /// @return keys Active miner keys, at most MAX_CIRCUITS.
    function _activeMiningKeys() internal view returns (bytes32[] memory keys) {
        bytes32[] memory tmp = new bytes32[](circuitIds.length);
        uint256 n;
        for (uint256 i = 0; i < circuitIds.length; i++) {
            uint256 id = circuitIds[i];
            if (!_ownsCircuit(id)) continue;
            bytes32 key = IPodMining(podMining).minerKey(circuits, id);
            if (IPodMining(podMining).getMiner(key).status == 1) {
                tmp[n] = key;
                n += 1;
            }
        }
        keys = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) keys[i] = tmp[i];
    }

    /// @dev Hand held circuit NFTs to the owner. Only abandonOrder calls this, after no share is
    ///      outstanding and every holder was repaid. Skips listed or already-sold tokens; a failing
    ///      transfer is skipped so the owner cannot block the call.
    function _returnHeldCircuits() internal {
        IERC721 token = IERC721(circuits);
        for (uint256 i = 0; i < circuitIds.length; i++) {
            uint256 id = circuitIds[i];
            if (circuitListingId[id] != 0) continue;
            if (!_ownsCircuit(id)) continue;
            try token.transferFrom(address(this), owner, id) {} catch {}
        }
    }

    /// @dev True when this contract owns the circuit token.
    /// @param tokenId Token to test.
    /// @return Whether the round holds it.
    function _ownsCircuit(uint256 tokenId) internal view returns (bool) {
        try IERC721(circuits).ownerOf(tokenId) returns (address holder) {
            return holder == address(this);
        } catch {
            return false;
        }
    }

    /// @dev True when the round holds any of its circuit NFTs; they back the outstanding shares, so the
    ///      refund exits stay closed while the pool cannot repay every share.
    /// @return Whether the contract holds at least one circuit NFT.
    function _circuitsHeld() internal view returns (bool) {
        for (uint256 i = 0; i < circuitIds.length; i++) {
            if (_ownsCircuit(circuitIds[i])) return true;
        }
        return false;
    }

    /// @dev Thin wrapper so every caller reads the same `owed(address(this))`.
    /// @return BNB the market still owes this round.
    function _owed() internal view returns (uint256) {
        return circuitMarket.owed(address(this));
    }

    /// @dev Revert unless the round is in the Executing scene.
    function _requireExecuting() internal view {
        if (scene != Scene.Executing) revert WrongScene();
    }

    /// @dev Revert unless the round is Executing/Ready, the only phase that lists or pools circuits.
    function _requireReady() internal view {
        _requireExecuting();
        if (phase != Phase.Ready) revert CircuitsNotReady();
    }

    /// @dev True when a real purchase happened (priceLock) or at least one circuit is on hand. The first
    ///      term keeps Ready reachable after a recovery path even if every circuit was sold back into the
    ///      market; the second is what startMining needs.
    /// @return Whether the round may enter Ready through an admin / mining path.
    function _readyBasis() internal view returns (bool) {
        return priceLock != 0 || _circuitsHeld();
    }

    /// @dev True when every share ever sold was repaid at the subscription price. A short pool means part
    ///      of the money sits in the circuits, so releasing them for a pro-rata refund would be a
    ///      discounted sale. Callers only run at outstandingShares == 0.
    /// @return Whether holders were made whole.
    function _holdersMadeWhole() internal view returns (bool) {
        return totalRefunded >= sold * sharePriceBnb;
    }

    /// @dev True while `raisedBnb` alone can repay every outstanding share at the subscription price.
    /// @return Whether the escrow covers the whole debt.
    function _poolCoversEveryShare() internal view returns (bool) {
        return raisedBnb >= outstandingShares * sharePriceBnb;
    }

    /// @dev Start of the non-owner grace window: the later of sell-out and last purchase, so an owner that
    ///      keeps buying is never griefed.
    /// @return Unix timestamp the grace window is measured from.
    function _graceBase() internal view returns (uint256) {
        return uint256(lastOrderAt) > uint256(soldOutAt) ? uint256(lastOrderAt) : uint256(soldOutAt);
    }

    /// @dev True when `raisedBnb` can no longer repay every outstanding share at the subscription price.
    /// @return Whether refund would pay pro-rata instead of in full.
    function _shortfall() internal view returns (bool) {
        return raisedBnb < outstandingShares * sharePriceBnb;
    }

    /// @notice Owner escape while Executing: rewrite the sub-phase so a stuck round can reach refund or
    ///         recovery. Moves no tokens.
    ///         Ready needs a settled purchase or a circuit on hand. Ready → Buying is the recovery path.
    /// @param next 1 Buying, 2 Ready. None (0) is refused — it would close ordering and every refund path
    ///        except abandonOrder.
    function setPhase(uint8 next) external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (next == uint8(Phase.None) || next > uint8(Phase.Ready)) revert WrongScene();
        if (next == uint8(Phase.Ready) && !_readyBasis()) revert CircuitsNotReady();
        // Once the principal is booked as surplus, refunds are closed: leaving Ready pays nothing and only
        // a return to Ready can move the round on. Refuse when that way back is already gone.
        if (surplusBase != 0 && next != uint8(Phase.Ready) && !_readyBasis()) revert WrongScene();
        _setPhase(Phase(next));
    }

    /// @notice Sweep BNB no share is entitled to; the recipient is always the owner. While shares are
    ///         outstanding only the excess over escrow leaves; once all are settled the whole balance leaves
    ///         and `raisedBnb` is zeroed. Unclaimed fees and surplus are never touched.
    function recoverBnb() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        // Reserved: unclaimed surplus only (BEM fees sit in the BEM token balance, not here).
        uint256 reserved = 0;
        if (surplusPool > surplusPaid) reserved = surplusPool - surplusPaid;
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

    /// @dev Pull market proceeds into `raisedBnb` (via receive). No-op at 0.
    function _pullOwed() internal {
        if (_owed() > 0) circuitMarket.withdraw();
    }

    /// @dev Withdraw what the market owes, ignoring one that cannot pay: the cancel path must not be blocked
    ///      by a reverting withdraw. Pool-dividing callers keep their own `_owed() > 0` guard.
    function _pullOwedSoft() internal {
        if (_owed() == 0) return;
        try circuitMarket.withdraw() {} catch {}
    }
}
