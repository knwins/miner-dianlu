// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {IERC1155} from "./interfaces/IERC1155.sol";
import {IMaterialMarket} from "./interfaces/IMaterialMarket.sol";

/// @title Campaign — one BEM crowdfunding round
/// @notice Scenes: Funding → Executing → Mining. Executing phases: Buying → Listed → Ready.
///
/// Funds:
///  - Subscription BNB sits in raisedBnb. Subscribe is still allowed at the exact deadline.
///    After the deadline, if the round is not sold out, each subscriber calls refund.
///  - The owner spends raisedBnb on material-market placeBid. Sellers fillBid and parts arrive
///    as ERC1155. If the bid is unaffordable the tx succeeds, sets executionFailed, and does not
///    place. Only the market may refund escrow via receive.
///  - Share transfer (listShares / takeListing / cancelListing) is Mining-only. Buyer BNB is paid
///    straight to the seller, not into raisedBnb.
///
///  NOTE: tape-out and PoD mining have been REMOVED. In their place, an owner commits the
///  round's transistors into a mining pool via depositToPool() — an IRREVERSIBLE action that transfers
///  the held ERC1155 parts to `miningPool`, returns any unspent subscription BNB to holders (shares kept),
///  and moves the round into the Mining scene. harvest() / claim() remain placeholders: the Mining scene is
///  now reachable, but no BEM distribution is implemented yet, so they no-op / return 0.
///  Business rules (fee = mining-output fee only, `sold` monotonic, refund denominators, refund exit
///  paths, ...) live in contracts/README.md §8; comments here only point there.
interface IFactory {
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
        None, // not Executing
        Buying, // ready to place transistor bids
        Listed, // bids live; cancel still allowed
        Ready // parts filled; waiting for execute
    }

    struct Listing {
        address seller;
        uint256 shares;
        uint256 priceBnbPerShare;
        bool open;
    }

    uint256 internal constant FAIL_GRACE = 3 days;
    /// @notice Service-fee hard ceiling (bps). 1000 = 10%. The fee is charged on mining output
    ///         only, never on subscription BNB — see README §8 rule 1.
    uint16 internal constant MAX_SERVICE_FEE_BPS = 1000;
    /// @notice Max service-fee recipients. 3 covers "solo" / "platform + founder" and keeps the
    ///         accrual loop and storage cost down.
    uint256 internal constant MAX_FEE_RECIPIENTS = 3;

    // ─────────────────────── immutable config (fixed at creation) ───────────────────────
    uint256 public immutable sharePriceBnb; // price per share (wei)
    uint256 public immutable totalShares; // share cap
    uint64 public immutable fundingDeadline; // funding deadline (unix seconds)
    /// @notice Official ERC1155 parts contract for this round (TapeOut or Behemoth processor parts).
    ///         Locked at create; placeBid uses it. The processor model is fixed here, not chosen per order.
    address public immutable transistors;
    /// @notice Material market (placeBid / cancelBid / bids). Testnets may use a matching mock.
    ///         The owner may swap it via setMaterialMarket; every market that ever served this round
    ///         stays an accepted sender in receive() (async settlements).
    IMaterialMarket public materialMarket;
    /// @notice Mining pool address. Owner-set before depositToPool(); the held transistors are sent here
    ///         irreversibly. May be any ERC1155-receiving contract (must implement onERC1155Received).
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
    /// @notice Service-fee rate (bps, 1/10000). 0 = none. Settable once while nobody has
    ///         subscribed (sold == 0), then frozen forever. Mining-output fee only — see
    ///         README §8 rule 1.
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
    uint64 public soldOutAt;
    /// @notice Timestamp of the last placeTransistorOrder. The non-owner markFailed grace
    ///         period is measured from it.
    uint64 public lastOrderAt;
    bool public executionFailed;
    /// @notice True once the held transistors have been committed to the mining pool. Irreversible:
    ///         no function pulls them back, and refund / abandon / recover escape hatches are closed.
    bool public pooled;

    uint256 public raisedBnb; // subscription escrow. Bids debit it; market refunds credit it via receive
    uint256 public totalRefunded; // cumulative refunded BNB (all wallets)
    /// @notice Cumulative service fee paid out (wei).
    uint256 public totalFeesPaid;
    /// @notice Mining revenue pool: revenue net of the service fee. Holder distribution lands
    ///         with harvest()/claim() once the mining-pool interface is ready (placeholders today).
    ///         Holds mining output, not subscription funds.
    uint256 public revenuePool;

    uint256 public priceLock; // total bid escrow (wei), not a unit price. 0 = no live order
    uint256 public nandBidId;
    uint256 public latchBidId;
    uint256 public nandQty;
    uint256 public latchQty;
    uint96 public nandPrice; // locked NAND bid price. display-only: read off-chain via getter; never read in on-chain logic
    uint96 public latchPrice; // locked LATCH bid price. display-only: read off-chain via getter; never read in on-chain logic
    /// @notice Sell-side ask ids after a partial buy. Used to cash out parts already on hand before refund.
    uint256 public nandAskId;
    uint256 public latchAskId;
    uint256 public nandAskQty;
    uint256 public latchAskQty;
    uint96 public nandAskPrice; // live NAND ask price. display-only: read off-chain via getter; never read in on-chain logic
    uint96 public latchAskPrice; // live LATCH ask price. display-only: read off-chain via getter; never read in on-chain logic
    uint256 public estHashpower; // design estimate. display-only: read off-chain via getter; never read in on-chain logic

    // ─────────────────────── per-wallet ledger ───────────────────────
    mapping(address => uint256) private _shares; // available shares
    mapping(address => uint256) private _escrow; // shares locked in a listing
    mapping(address => uint256) private _refunded; // BNB already refunded to this wallet
    /// @notice Surplus accrued at pool time but not yet transferred; claimable via claimSurplus().
    mapping(address => uint256) public pendingSurplus;

    /// @notice Sum of pendingSurplus. recoverBnb sweeps the balance in the "sold == 0" branch and
    ///         must reserve this, or the owner would swallow holders' unclaimed surplus.
    uint256 public totalPendingSurplus;
    /// @notice Surplus bookable at pool time (= raisedBnb at that instant). It is the numerator base
    ///         for the per-share math and does not move when holders later exit.
    uint256 public surplusPool;
    /// @notice Surplus denominator (= outstandingShares at pool time). Later holder churn does not
    ///         move an already-fixed base.
    uint256 public surplusBase;
    /// @notice Shares already counted toward the surplus split (the rounding dust goes to the last
    ///         claimant, so the pool is paid out to the last wei).
    uint256 public surplusClaimedShares;
    /// @notice Total surplus already allocated (accrued to holders, transferred or not). Allocation
    ///         (accrue) and payout (claim) are deliberately separate ledgers.
    uint256 public surplusAllocated;
    /// @notice Surplus actually transferred to holders. recoverBnb uses surplusPool − surplusPaid
    ///         for "still owed".
    uint256 public surplusPaid;
    /// @notice Shares already counted into the surplus split per holder; prevents double claims.
    mapping(address => uint256) public surplusCounted;
    address[] private _holders; // subscribers and listing buyers; openRefund / _refundAll walks it
    // Append-only (refunded / fully-claimed addresses stay): _holders indexes are exposed to the
    // frontend via holderAt(). The cost is that _refundAll walks the whole array — ~2.1k gas per
    // cold SLOAD, i.e. ~2.1M gas for 1,000 holders, ~21M for 10,000, nearing the block gas limit.
    // A round's holder count is naturally bounded by totalShares (set by the opener), which is enough
    // today; owner-triggered refunds for tens of thousands of addresses would need a batched pull
    // refund (segment cursor) instead of growing this array.
    mapping(address => bool) private _holderSeen;

    Listing[] private _listings;
    /// @dev Addresses that ever served as this round's market. receive() accepts BNB from any of
    ///      them: market settlement / bid cancellation is asynchronous, and recognizing only the
    ///      current market would permanently reject late-arriving funds.
    address[] private _marketHistory;

    // ─────────────────────── events ───────────────────────
    event Subscribed(address indexed subscriber, uint256 count, uint256 paidBnb);
    event Refunded(address indexed holder, uint256 amountBnb);
    event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare);
    event ListingCancelled(uint256 indexed id, address indexed seller, uint256 shares);
    event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb);
    /// @notice The second argument is total escrowed BNB, not a unit price. The name is kept for the old ABI.
    event TransistorOrderPlaced(uint256 count, uint256 unitPriceBnb);
    event TransistorOrderCancelled();
    event TransistorAskPlaced(uint256 nandQty, uint256 latchQty, uint256 nandAskId, uint256 latchAskId);
    event TransistorAskCancelled();
    event TransistorsConfirmed();
    /// @notice needBnb is the bid escrow that could not be paid. openRefund emits 0. The tx does not revert.
    event ExecutionFailed(uint256 needBnb, uint256 raisedBnb);
    event RefundSendFailed(address indexed holder, uint256 amountBnb);
    event PlanUpdated(uint256 estHashpower);
    event MaterialMarketUpdated(address indexed previous, address indexed next);
    /// @notice The operator approval granted to a former material market was revoked.
    event MaterialMarketApprovalRevoked(address indexed market);
    /// @notice Owner escape hatch: BNB pulled out of the campaign. `to` is the owner.
    event BnbRecovered(uint256 amount, address indexed to);
    /// @notice Owner escape hatch: ERC1155 parts pulled out so they are not left in the campaign. `to` is the owner.
    event TransistorsRecovered(address indexed token, uint256 indexed id, uint256 amount, address indexed to);
    /// @notice Mining pool address was set / changed by the owner.
    event MiningPoolSet(address indexed previous, address indexed next);
    /// @notice The round's transistors were committed to the mining pool. IRREVERSIBLE.
    event DepositedToPool(address indexed pool, uint256 nandAmount, uint256 latchAmount);
    /// @notice The Executing sub-phase changed. Emitted by every path that writes `phase`.
    /// @dev The frontend must not drive state from events alone — but emitting beats silence:
    ///      before _setPhase existed, some phase writes emitted nothing and off-chain monitors
    ///      could not see the transition at all.
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
    error ZeroShares();
    error ZeroPrice();
    error BadCount();
    error InsufficientShares();
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
    /// @notice returnSurplus() already booked the unspent principal for pro-rata return. refund / abandon
    ///         would zero the shares for 0 BNB while the parts went back to the owner, so they are closed.
    error SurplusAlreadyReturned();
    /// @notice The parts are confirmed (Ready): the only refund there is the unspent BNB, and it must not
    ///         touch the parts. Use returnSurplus() instead of openRefund / abandonOrder.
    error UseReturnSurplus();
    /// @notice The transistors argument does not match the parts contract locked at creation.
    error WrongTransistors();
    /// @notice Service-fee configuration is invalid (bps over the hard ceiling, mismatched table
    ///         lengths, duplicate recipients, zero address, or shares that do not sum to 10000).
    error BadFeeConfig();
    /// @notice The service-fee table was already set. It is frozen forever once written.
    error ServiceFeeAlreadySet();
    /// @notice The service fee can no longer be changed because somebody already subscribed.
    error ServiceFeeLocked();
    /// @notice The round has not sold out. Owner may not place a parts order for a round that is
    ///         still funding.
    error NotSoldOutYet();

    /// @param materialMarket_ Material-market address. Stored in the `materialMarket` state var; read it via materialMarket().
    /// @param transistors_ Official ERC1155 parts contract for this round (TapeOut or Behemoth processor parts).
    ///        Locked at create; placeBid uses it. The processor model is fixed here, not chosen per order.
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

    /// @dev Only the material market may push BNB into this contract, and every legitimate inbound transfer comes
    ///      from it:
    ///      - an unfilled bid leg is cancelled (placeTransistorOrder / abandonOrder / cancelTransistorOrder / markFailed
    ///        call market.cancelBid), whose escrow refund returns here and is credited to raisedBnb;
    ///      - the market settles an ask or pays an owed balance (market.withdraw / fill settlement).
    ///      No other address may send BNB. An arbitrary deposit would inflate raisedBnb and break the
    ///      "contract BNB balance == escrow pool" invariant that refund() depends on,
    ///      letting a stranger over-claim from the pool. A retired round's cancelBid refund still originates from
    ///      the market, so it is accepted here the same way — the factory registry state changes nothing.
    receive() external payable {
        // Accept BNB from any address that ever served as this round's market, not just the current one.
        //
        // Why history: market settlement / cancellation / withdrawal are asynchronous. If the owner calls
        // setMaterialMarket before a payment lands, the funds would be rejected by DirectTransferNotAllowed —
        // unrecoverable on BSC, with the subscribers' principal permanently stuck in the old market (no
        // function can pull it back).
        if (!_isKnownMarket(msg.sender)) revert DirectTransferNotAllowed();
        raisedBnb += msg.value;
    }

    /// @dev The factory registry is this round's only source of writes. A reverting call counts as retired.
    function _retired() internal view returns (bool) {
        try IFactory(factory).isRegistered(address(this)) returns (bool live) {
            return !live;
        } catch {
            return true;
        }
    }

    /// @dev True when `who` ever served as this round's material market.
    function _isKnownMarket(address who) internal view returns (bool) {
        if (who == address(materialMarket)) return true;
        for (uint256 i = 0; i < _marketHistory.length; i++) {
            if (_marketHistory[i] == who) return true;
        }
        return false;
    }

    /// @notice Replace the material market (official placeBid contract, or a matching test mock).
    ///         Blocked while a bid or an ask is live — their escrow would be stranded on the old
    ///         market, unrecoverable on-chain. The old market's ERC1155 operator approval is revoked
    ///         on the way out, so it can no longer pull this round's parts.
    function setMaterialMarket(address materialMarket_) external onlyOwner {
        if (materialMarket_ == address(0)) revert ZeroAddress();
        // Swapping markets with a live order/ask strands the escrow on the old market. Cancel first.
        if (phase == Phase.Listed) revert AlreadyListed();
        if (_askOpen()) revert AlreadyAsked();
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

    /// @dev Revoke a market's operator approval. Silent on failure — an old market may not implement it.
    function _revokeApproval(address operator) internal {
        if (operator == address(0)) return;
        try IERC1155(transistors).setApprovalForAll(operator, false) {
            emit MaterialMarketApprovalRevoked(operator);
        } catch {
            // Ignore: an old / deprecated parts contract may not implement setApprovalForAll.
        }
    }

    /// @notice Set the mining pool destination. Owner only, and only before the transistors are pooled.
    ///         depositToPool() reverts with PoolNotSet() until this is a non-zero address.
    function setMiningPool(address pool_) external onlyOwner {
        if (pooled) revert AlreadyPooled();
        if (pool_ == address(0) || pool_ == address(this)) revert ZeroAddress();
        emit MiningPoolSet(miningPool, pool_);
        miningPool = pool_;
    }

    /// @notice Set the display estimate. Writable in Funding, and in Executing only while Buying.
    ///         Not writable in Listed, Ready, or Mining.
    ///         Part count is not a parameter: the live order quantity is whatever placeTransistorOrder writes.
    ///         This function does not place a bid.
    function setPlan(uint256 estHashpower_) external onlyOwner {
        if (scene == Scene.Mining) revert WrongScene();
        if (scene == Scene.Executing && phase != Phase.Buying) revert WrongScene();
        estHashpower = estHashpower_;
        emit PlanUpdated(estHashpower_);
    }

    // ─────────────────────────── subscribe ───────────────────────────

    /// @notice Buy an integer number of shares. msg.value must equal count × sharePriceBnb.
    ///         Subscribe is still allowed when timestamp == fundingDeadline. A sell-out moves the round to Executing / Buying.
    ///         Subscription BNB is never charged a service fee — it lands in raisedBnb in full and
    ///         only funds the parts purchase. The service fee applies to mining output only
    ///         (README §8 rule 1).
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

    /// @notice Set this round's service fee and its multi-recipient split table. Owner only.
    ///         Only allowed while **nobody has subscribed yet** (sold == 0). After that it is frozen
    ///         forever — subscribers must be able to trust the numbers they saw when they subscribed.
    ///         0 bps with an empty table = no fee (the default for a round nobody configures).
    ///         The fee is charged on mining output only, at depositRevenue() — never on subscription
    ///         BNB (README §8 rule 1). Rate and table live on-chain so anyone can verify them.
    ///
    ///         @param bps_ Fee rate in basis points (1/10000). Hard-capped at MAX_SERVICE_FEE_BPS (10%).
    ///         @param recipients_ Fee recipients. Max MAX_FEE_RECIPIENTS. May be empty only if bps_ == 0.
    ///         @param sharesBps_ Per-recipient share in bps. Must sum to 10000. Same length as recipients_.
    function setServiceFee(uint16 bps_, address[] calldata recipients_, uint16[] calldata sharesBps_) external onlyOwner {
        if (serviceFeeSet) revert ServiceFeeAlreadySet();
        if (sold != 0) revert ServiceFeeLocked();
        if (bps_ > MAX_SERVICE_FEE_BPS) revert BadFeeConfig();
        if (recipients_.length != sharesBps_.length) revert BadFeeConfig();
        if (recipients_.length > MAX_FEE_RECIPIENTS) revert BadFeeConfig();
        if (bps_ == 0 && recipients_.length != 0) revert BadFeeConfig();
        if (bps_ != 0 && recipients_.length == 0) revert BadFeeConfig();

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

    function feeRecipientAt(uint256 index) external view returns (address) {
        if (index >= _feeRecipients.length) revert BadFeeConfig();
        return _feeRecipients[index];
    }

    function feeSharesBpsAt(uint256 index) external view returns (uint16) {
        if (index >= _feeSharesBps.length) revert BadFeeConfig();
        return _feeSharesBps[index];
    }

    /// @notice A fee recipient pulls its accrued service fee. Recipients may be contracts that reject
    ///         plain BNB, so the payment is push-with-fallback: on failure the amount stays in
    ///         pendingFee and the recipient can retry (or move to another address).
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

    /// @dev Split `gross` between the fee table and the revenue pool, and book each recipient's cut.
    ///      Returns the amount actually withheld as fee. Rounding dust (the sub-wei remainder of the
    ///      bps math) stays in the revenue pool, never in the fee — the fee is never over-charged.
    ///      Called when mining revenue lands in the round. No-op when no fee is configured.
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

    /// @notice The subscriber pulls their principal. Nothing runs automatically at the deadline.
    ///         Allowed when the round never sold out and Funding is past its deadline, when Executing and
    ///         executionFailed, or when Executing/Buying and raisedBnb can no longer cover every share
    ///         (a partial fill was settled, with or without asking the leftover parts).
    ///         A full pool pays count × sharePriceBnb. A short pool pays pro-rata of raisedBnb.
    ///         A sold-out round cannot use the deadline path: buyers funded the parts purchase, not a refund.
    ///         Reverts if this wallet still has escrowed shares.
    ///         The never-sold-out deadline path is the only principal exit for such rounds and must stay
    ///         open (README §8 rule 6); the owner's ordering gate reads the monotonic `sold` instead
    ///         (rule 5), so refunds never revoke it.
    function refund() external nonReentrant {
        // Principal already returned early (returnSurplus in Ready): the pool is 0, so this call would
        // zero the shares for 0 BNB and burn the holder's mining entitlement. Refuse instead.
        // Mining keeps its own RefundNotAvailable (pooled is irreversible), so the message stays accurate.
        if (scene == Scene.Executing && surplusBase != 0) revert SurplusAlreadyReturned();
        bool execFailed = scene == Scene.Executing && executionFailed;
        bool short = scene == Scene.Executing && phase == Phase.Buying && _shortfall();
        // Never-sold-out rounds keep exactly one principal exit: Funding past its deadline.
        // soldOutAt == 0 ⇔ never sold out (it is written the moment the scene turns Executing).
        bool neverSoldOut = scene == Scene.Funding && soldOutAt == 0 && block.timestamp > fundingDeadline;
        if (!neverSoldOut && !execFailed && !short) revert RefundNotAvailable();

        // A failed send must revert the whole tx. Soft-fail would surface as ZeroShares.
        // Shares are cleared even when the pro-rata amount rounds to 0: a pool too small for the
        // share count must not trap a holder forever (unsettled shares keep `outstandingShares`
        // above 0 and lock the rounding dust).
        uint256 before = _shares[msg.sender];
        uint256 amount = _refundHolder(msg.sender, false);
        if (amount == 0 && _shares[msg.sender] == before) revert ZeroShares();
    }

    function _trackHolder(address who) internal {
        if (_holderSeen[who]) return;
        _holderSeen[who] = true;
        _holders.push(who);
    }

    /// @dev Single writer for `phase`; emits PhaseChanged. Every phase write goes through here
    ///      so off-chain state derived from events never misses a transition.
    function _setPhase(Phase next) internal {
        uint8 previous = uint8(phase);
        phase = next;
        if (previous != uint8(next)) emit PhaseChanged(previous, uint8(next));
    }

    /// @dev Refund this wallet. Returns 0 if shares are 0, any shares are escrowed, or the pro-rata share rounds to 0.
    ///      A full pool pays count × price. A short pool pays raisedBnb × shares / outstandingShares pro-rata.
    ///      soft=true (openRefund): a failed send restores this wallet and is skipped.
    ///      soft=false: a failed send reverts the whole transaction.
    ///      Shares are cleared even when the amount rounds to 0, so a holder in a short pool can never be
    ///      stuck: their shares would otherwise keep `sold` above 0 forever, recoverBnb could not sweep
    ///      the dust, and the BNB would be locked with nobody able to take it. The pool keeps the dust
    ///      for the remaining holders (their pro-rata grows as `outstandingShares` shrinks) and the last
    ///      holder takes it by proportion.
    ///      The denominator is `outstandingShares`, not `sold`: counting exited holders in the base
    ///      would leave the pool permanently unpayable for the last few holders.
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

    /// @notice Mining only. Moves shares into escrow. They stop being transferable until sold or cancelled.
    ///         Mining becomes reachable once the owner commits the parts via depositToPool().
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

    /// @notice Cancel your listing and unlock the shares. Seller or owner only.
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

    /// @notice Mining only. Moves shares from the seller's escrow to the buyer's _shares.
    ///         msg.value must equal count × price and is paid straight to the seller.
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

    /// @notice Place bids on the material market. NAND tokenId is 0, LATCH is 1. Owner only, phase must be Buying.
    ///         Uses the transistors address locked at create. `transistors_` must be address(0) or equal that address.
    ///         Escrow is debited from raisedBnb and sent with placeBid. A zero-qty leg is skipped and its bid id stays 0.
    ///         If cost > raisedBnb, sets executionFailed and returns. The tx does not revert and no bid is placed.
    ///         Only one market order at a time: an open ask must be cancelled first. A fully filled ask slot is cleared here.
    function placeTransistorOrder(
        address transistors_,
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase == Phase.Listed) revert AlreadyListed();
        _purgeFilledAsk();
        if (_askOpen()) revert AlreadyAsked();
        if (transistors_ != address(0) && transistors_ != transistors) revert WrongTransistors();
        _requireLegParams(nandQty_, nandPrice_, latchQty_, latchPrice_);
        // The round must have sold out at least once. `sold` is monotonic, so refunds cannot
        // make this gate fail (README §8 rule 5).
        if (sold < totalShares) revert NotSoldOutYet();
        // `sold` is a monotonic historical fact: the gate means "this round sold out", not
        // "nobody has refunded" (README §8 rule 5).
        if (executionFailed && (sold < totalShares || raisedBnb == 0)) revert RefundNotAvailable();

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

    /// @notice Return the unspent subscription BNB to holders as soon as the parts are confirmed, WITHOUT
    ///         ending the round. Parts stay in the campaign, `phase` stays Ready and `depositToPool()` is
    ///         still available afterwards — the money and the mining path are independent.
    ///         The amount is booked into the same pull ledger the pool-time surplus uses: no holder loop,
    ///         no push transfer. Each holder takes their cut with claimSurplus() (pro-rata by shares).
    ///         Requires a settled market (no open ask / no ask pending confirmation / nothing owed), so
    ///         sale proceeds can never be mixed into a principal return.
    ///         After this call openRefund / abandonOrder are closed: holders already got their principal
    ///         back, so the parts must follow the mining path instead of being swept to the owner.
    function returnSurplus() external onlyOwner nonReentrant {
        _requireExecuting();
        if (pooled) revert AlreadyPooled();
        if (phase != Phase.Ready) revert TransistorsNotReady();
        if (_askOpen() || _askRecorded() || _owed() > 0) revert AlreadyAsked();
        if (outstandingShares == 0) revert ZeroShares();
        if (raisedBnb == 0) revert ZeroShares();
        _returnSurplus();
        emit SurplusReturned(surplusPool, surplusBase);
    }

    /// @notice Owner refunds every holder. Only from Buying: once the parts are confirmed (Ready) the
    ///         refund is the leftover money alone and the parts must follow the mining path, so
    ///         returnSurplus() replaces this call there and openRefund reverts with UseReturnSurplus().
    ///         Ready → Buying is still possible via setPhase for an admin recovery (that is an explicit
    ///         "this round goes back to Buying" statement, not the normal exit).
    ///         Closed once returnSurplus() already paid the principal out: refunding then would zero the
    ///         shares at 0 BNB each while the parts stayed in the campaign.
    function openRefund() external onlyOwner nonReentrant {
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        // outstandingShares == 0 means every share already left: there is nobody left to refund. Revert instead of
        // mining a no-op transaction that emits nothing (the leftover dust is swept with recoverBnb).
        if (outstandingShares == 0) revert ZeroShares();
        if (phase == Phase.Listed) revert AlreadyListed();
        if (phase != Phase.Buying) revert WrongScene();
        _purgeFilledAsk();
        if (_askOpen() || _owed() > 0) revert AlreadyAsked();
        markFailed();
        _refundAll();
    }

    /// @notice Owner only. Give up on this round from Buying or Listed: cancel the rest of the bid,
    ///         cancel open asks, return parts still held here, withdraw what the market owes, and refund holders.
    ///         Refused in Ready: there the parts must not go back to the owner, only the unspent BNB goes to
    ///         holders (returnSurplus) and the parts go to the pool.
    ///         Closed once returnSurplus() already paid the principal out (same reason as openRefund).
    function abandonOrder() external onlyOwner nonReentrant {
        _requireExecuting();
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        if (phase == Phase.Ready) revert UseReturnSurplus();
        if (phase == Phase.Listed) {
            _cancelOpenLeg(nandBidId, nandQty);
            _cancelOpenLeg(latchBidId, latchQty);
            _clearOrder();
        }
        _setPhase(Phase.Buying);
        _cancelOpenAsk();
        _returnHeldParts();
        if (_owed() > 0) materialMarket.withdraw();
        markFailed();
        _refundAll();
    }

    function _refundAll() internal {
        uint256 n = _holders.length;
        for (uint256 i = 0; i < n; i++) {
            _refundHolder(_holders[i], true);
        }
    }

    /// @notice Cancel whatever is still open on the market, then return to Buying.
    ///         Owner only while nothing filled. Once any quantity filled, anyone may cancel the rest.
    ///         A fully filled order whose parts are already here cannot be cancelled.
    ///         cancelBid refunds the unfilled escrow into receive. Filled quantity stays spent.
    ///         Escrow must never be stranded, so anyone may also cancel a round removed from the factory registry
    ///         (its owner may no longer be around).
    function cancelTransistorOrder() external nonReentrant {
        if (phase != Phase.Listed) revert NotListed();
        bool touched = _filledSome(nandBidId, nandQty) || _filledSome(latchBidId, latchQty);
        if (orderFilled() && _partsOnHand()) revert OrderFilled();
        if (!touched && msg.sender != owner && !_retired()) revert NotOwner(msg.sender);
        _cancelOpenLeg(nandBidId, nandQty);
        _cancelOpenLeg(latchBidId, latchQty);
        _clearOrder();
        _setPhase(Phase.Buying);
        emit TransistorOrderCancelled();
    }

    /// @notice Anyone may call after FAIL_GRACE; the owner may call at any time.
    ///         Lets holders refund even when no owner is around: the live bid's escrow would otherwise stay
    ///         in the market, so a non-owner call first cancels the unfilled legs (escrow returns here via
    ///         receive() and is credited to raisedBnb). Only the bid is touched; the refund formula is unchanged.
    ///         The grace base is the later of soldOutAt and lastOrderAt: basing it on soldOutAt alone let a
    ///         bystander grief a healthy round each time the owner re-ordered (the reset revived the grace,
    ///         so the attack could repeat forever), while lastOrderAt alone made the grace void before the
    ///         first order. With the later of the two, every order pushes the grace forward and a round that
    ///         never orders after selling out is not killed instantly.
    function markFailed() public {
        if (scene != Scene.Executing || executionFailed) return;
        // Principal already went back to holders (returnSurplus): there is nothing left to refund, and
        // flagging the round as failed would advertise a refund that would burn shares for 0 BNB.
        if (surplusBase != 0) revert SurplusAlreadyReturned();
        uint256 graceBase = uint256(lastOrderAt) > uint256(soldOutAt) ? uint256(lastOrderAt) : uint256(soldOutAt);
        if (msg.sender != owner && block.timestamp < graceBase + FAIL_GRACE) {
            revert RefundNotAvailable();
        }
        executionFailed = true; // CEI: set before the market callback; a revert below rolls it back with the tx.
        // Escape hatch: an untouched bid keeps its escrow in the market. Cancelling it puts the BNB back into
        // raisedBnb so holders refund against the real pool instead of a short one. If the market refuses the
        // cancel the tx reverts and markFailed can be retried later, rather than leaving escrow behind.
        if (phase == Phase.Listed) {
            _cancelOpenLeg(nandBidId, nandQty);
            _cancelOpenLeg(latchBidId, latchQty);
            _clearOrder();
            _setPhase(Phase.Buying);
            emit TransistorOrderCancelled();
        }
        emit ExecutionFailed(0, raisedBnb);
    }

    /// @notice List parts already held after the buy was confirmed (Ready).
    ///         Not available in Buying: a partial fill has to be cancelled or filled, then confirmed.
    ///         Reverts if any ask leg is still open. Approves the market once, then placeAsk for each non-zero leg.
    function placeTransistorAsk(
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase != Phase.Ready) revert TransistorsNotReady();
        _requireLegParams(nandQty_, nandPrice_, latchQty_, latchPrice_);
        _purgeFilledAsk();
        if (_askOpen()) revert AlreadyAsked();

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

    /// @notice Owner only. Cancel unsold ask remainder so parts return to this campaign.
    ///         Fully filled legs (remaining == 0) are skipped. Call withdrawMarketProceeds after fills.
    ///         A fully filled ask (remaining == 0) can be cleared here without touching the market.
    function cancelTransistorAsk() external onlyOwner nonReentrant {
        if (!_askRecorded()) revert NotAsked();
        _cancelOpenAsk();
        emit TransistorAskCancelled();
    }

    /// @notice Ask is fully filled, or its remainder was cancelled. Pulls owed BNB and returns to Buying,
    ///         which is the only phase that can place another bid or refund after a sale.
    function confirmSale() external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase != Phase.Ready) revert WrongScene();
        if (_askOpen()) revert AlreadyAsked();
        uint256 owed = _owed();
        if (!_askRecorded() && owed == 0) revert NotAsked();
        if (owed > 0) materialMarket.withdraw();
        _clearAsk();
        _setPhase(Phase.Buying);
        emit AskSettled(owed);
    }

    /// @notice Pull ask / bid proceeds owed by the material market into raisedBnb (via receive).
    ///         Anyone may call. No-op when owed is 0.
    function withdrawMarketProceeds() external nonReentrant {
        if (_owed() == 0) return;
        materialMarket.withdraw();
    }

    /// @notice Anyone may call. Does not move tokens.
    ///         Moves Listed → Ready only when both legs have remaining == 0 and this contract holds the parts.
    ///         A zero-qty leg counts as filled.
    function confirmTransistors() external {
        _requireExecuting();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase != Phase.Listed) revert NotListed();
        if (!orderFilled() || !_partsOnHand()) revert TransistorsNotReady();
        _setPhase(Phase.Ready);
        emit TransistorsConfirmed();
    }

    /// @notice True when the official book has fully filled this round's bids.
    function orderFilled() public view returns (bool) {
        return _legFilled(nandBidId, nandQty) && _legFilled(latchBidId, latchQty);
    }

    /// @notice Owner escape hatch: pull held parts out of this campaign. Not for normal flow —
    ///         it exists so parts are not stranded in the contract. Blocked while a bid is live (Listed) and
    ///         once the transistors have been committed to the mining pool (irreversible).
    ///         Recipient is always `owner`. Does not change the order, price lock, or scene.
    function recoverTransistors(address token, uint256 id, uint256 amount) external onlyOwner nonReentrant {
        if (phase == Phase.Listed) revert AlreadyListed();
        if (pooled) revert AlreadyPooled();
        if (token == address(0)) revert ZeroAddress();
        IERC1155(token).safeTransferFrom(address(this), owner, id, amount, "");
        emit TransistorsRecovered(token, id, amount, owner);
    }

    // ─────────────────────────── mining pool (commit) ───────────────────────────

    /// @notice Commit the round's transistors to the mining pool. IRREVERSIBLE.
    ///         Owner only, callable once the order is filled and the parts are on hand (phase Ready).
    ///         1. Books any unspent subscription BNB as a pro-rata surplus pool (shares are kept) BEFORE the
    ///            parts leave, so the leftover money always belongs to the holders and the owner can never
    ///            sweep it via recoverBnb. Idempotent: `returnSurplus()` may already have booked it, in which
    ///            case only newly arrived BNB is added.
    ///         2. Transfers every held ERC1155 part (NAND id 0, LATCH id 1) to `miningPool`.
    ///         3. Sets `pooled = true` and moves the round into the Mining scene.
    ///         After this, recoverTransistors / refund / abandon / markFailed all revert (parts are gone and
    ///         the round is committed); the Mining scene is now reachable for the harvest() / claim() shells.
    ///         The pool contract must implement onERC1155Received; a failing receive reverts the whole tx.
    ///         Gas note: step 1 books two numbers (pool + base) and each holder pulls via claimSurplus(),
    ///         so the cost does not grow with the holder count.
    function depositToPool() external onlyOwner nonReentrant {
        if (pooled) revert AlreadyPooled();
        _requireExecuting();
        if (phase != Phase.Ready) revert TransistorsNotReady();
        if (miningPool == address(0)) revert PoolNotSet();
        if (!orderFilled() || !_partsOnHand()) revert TransistorsNotReady();

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

    /// @notice PLACEHOLDER — BEM distribution is not implemented. Reachable after depositToPool() moves the
    ///         round into Mining; currently a no-op so the Mining scene and ABI stay stable.
    function harvest() external nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
    }

    /// @notice PLACEHOLDER — BEM distribution is not implemented. Reachable after depositToPool() moves the
    ///         round into Mining; currently returns 0 so the Mining scene and ABI stay stable.
    function claim() external nonReentrant returns (uint256) {
        if (scene != Scene.Mining) revert WrongScene();
        return 0;
    }

    /// @notice The mining pool deposits this round's mining revenue. Only the mining pool may call it.
    ///         This is the **only** place the service fee is ever collected on-chain
    ///         (the fee is on mining output, never on subscription BNB — README §8 rule 1):
    ///           - fee = gross × serviceFeeBps / 10000, split across the on-chain recipient table;
    ///           - the rest goes to `revenuePool`, waiting for the distribution logic that lands with
    ///             the mining-pool interface (harvest()/claim() are still placeholders).
    ///         Subscription BNB never passes through here and is never charged a fee: it stays in raisedBnb
    ///         and only funds the parts purchase.
    ///         Rounding dust stays in revenuePool, so the fee is never over-charged.
    ///         The accrued fee is **pulled** by each recipient via claimFee(); it is never pushed, so a
    ///         recipient contract that rejects BNB cannot block the pool's revenue deposit.
    function depositRevenue() external payable nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (msg.sender != miningPool) revert NotOwner(msg.sender);
        if (msg.value == 0) revert ZeroPrice();

        uint256 fee = _accrueServiceFee(msg.value);
        uint256 net = msg.value - fee;
        revenuePool += net;
        emit RevenueDeposited(msg.value, fee, net);
    }

    // ─────────────────────────── views ───────────────────────────
    // scene and phase already have public getters. Do not wrap them again.

    function sharesOf(address account) external view returns (uint256) {
        return _shares[account];
    }

    /// @notice Subscribers and listing buyers, in first-seen order. Share counts stay on sharesOf.
    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    function holderAt(uint256 index) external view returns (address) {
        return _holders[index];
    }

    function escrowOf(address account) external view returns (uint256) {
        return _escrow[account];
    }

    function refundedOf(address account) external view returns (uint256) {
        return _refunded[account];
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    /// @notice Listing detail by id. The frontend reads each id up to listingCount().
    function getListing(uint256 id) external view returns (address seller, uint256 shares, uint256 priceBnbPerShare, bool open) {
        if (id >= _listings.length) revert NoListing();
        Listing storage l = _listings[id];
        return (l.seller, l.shares, l.priceBnbPerShare, l.open);
    }

    // ─────────────────────────── internal ───────────────────────────

    /// @dev Book the unspent principal at pool time as a pro-rata surplus pool. No holder loop and no
    ///      per-holder transfer: only two numbers are stored (numerator surplusPool, denominator
    ///      surplusBase) and each holder computes their cut in claimSurplus(). A full holder loop with
    ///      per-holder transfers (~35-45k gas each) would block the owner from pooling past a few
    ///      thousand holders against the BSC block gas limit.
    ///      Cumulative-share formula (order-independent; the last claimant takes the rounding dust):
    ///        target = surplusPool × (shares already counted + own shares) / surplusBase
    ///        own cut = target − total already allocated
    function _returnSurplus() internal {
        uint256 pool = raisedBnb;
        if (pool == 0) return;
        // Nobody left to pay: keep the money in raisedBnb so recoverBnb can still see it, instead of
        // booking a pool that no share can ever claim (surplusBase would be 0).
        if (outstandingShares == 0) return;
        if (surplusBase == 0) {
            surplusPool = pool;
            surplusBase = outstandingShares;
            surplusClaimedShares = 0;
            surplusAllocated = 0;
            surplusPaid = 0;
        } else {
            // Already booked by returnSurplus() in Ready and more BNB arrived afterwards (e.g. a sale
            // settlement): top the same pool up. Resetting the counters here would pay early claimants twice.
            surplusPool += pool;
        }
        // The principal pool is zeroed: the money is now tracked by surplusPool and distributed by
        // claimSurplus(). recoverBnb's reserved amount covers surplusPool − surplusPaid, so the owner
        // cannot sweep it.
        raisedBnb = 0;
    }

    /// @notice Claim the surplus booked for you at pool time.
    ///         Two sources: the lazily computed entitlement (normal path) and a previously accrued
    ///         amount whose transfer failed (pendingSurplus, retryable).
    ///         Required because refund() is closed forever after pooling: without it the money would
    ///         be stuck in the contract and not even the owner could sweep it.
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
        _refunded[msg.sender] += amt;
        totalRefunded += amt;
        emit Refunded(msg.sender, amt);
    }

    /// @dev Lazily compute a holder's surplus and book it into pendingSurplus.
    ///      Each holder is counted once (surplusCounted), so repeated calls never pay twice.
    ///      The rounding dust (pool minus the sum of per-share cuts) goes to the claimant who
    ///      completes the base, so surplusPool is paid out to the last wei.
    function _accrueSurplus(address who) internal returns (uint256 amt) {
        uint256 s = _shares[who];
        if (s == 0 || surplusBase == 0 || surplusPool == 0) return 0;
        uint256 already = surplusCounted[who];
        if (already >= s) return 0; // already counted
        uint256 newShares = s - already;
        // Defense: if shares grew past the base after pooling, the excess is not paid out.
        if (surplusClaimedShares + newShares > surplusBase) {
            newShares = surplusBase - surplusClaimedShares;
            if (newShares == 0) return 0;
        }
        surplusCounted[who] = already + newShares;
        surplusClaimedShares += newShares;

        amt = (surplusPool * newShares) / surplusBase;
        // The claimant who completes the base takes everything left (including earlier rounding dust),
        // so surplusPool is paid out exactly, never over-paid.
        if (surplusClaimedShares == surplusBase) {
            amt = surplusPool - surplusAllocated;
        }
        surplusAllocated += amt;
        pendingSurplus[who] += amt;
        totalPendingSurplus += amt;
        emit SurplusAccrued(who, amt);
    }

    /// @notice Surplus claimable by `who` right now (including the not-yet-booked lazy part). For display.
    function surplusOf(address who) external view returns (uint256) {
        uint256 amt = pendingSurplus[who];
        if (amt != 0) return amt;
        uint256 s = _shares[who];
        if (s == 0 || surplusBase == 0 || surplusPool == 0) return 0;
        uint256 already = surplusCounted[who];
        if (already >= s) return 0;
        uint256 newShares = s - already;
        if (surplusClaimedShares + newShares > surplusBase) {
            newShares = surplusBase - surplusClaimedShares;
            if (newShares == 0) return 0;
        }
        uint256 out = (surplusPool * newShares) / surplusBase;
        if (surplusClaimedShares + newShares == surplusBase) {
            out = surplusPool - surplusAllocated;
        }
        return out;
    }

    /// @dev cancelOrder/abandonOrder have both finished before this runs, so the campaign owns no live order.
    ///      A caller that cannot receive ERC1155 must not block the refund: skip it and leave the parts here.
    function _returnHeldParts() internal {
        IERC1155 token = IERC1155(transistors);
        for (uint256 id = 0; id < 2; id++) {
            uint256 amount = token.balanceOf(address(this), id);
            if (amount == 0) continue;
            try token.safeTransferFrom(address(this), owner, id, amount, "") {} catch {}
        }
    }

    function _owed() internal view returns (uint256) {
        return materialMarket.owed(address(this));
    }

    function _requireExecuting() internal view {
        if (scene != Scene.Executing) revert WrongScene();
    }

    function _requireLegParams(uint256 nandQty_, uint96 nandPrice_, uint256 latchQty_, uint96 latchPrice_) internal pure {
        if (nandQty_ == 0 && latchQty_ == 0) revert ZeroShares();
        if ((nandQty_ > 0 && nandPrice_ == 0) || (latchQty_ > 0 && latchPrice_ == 0)) revert ZeroPrice();
    }

    function _placeBidLeg(uint8 tokenId, uint256 qty, uint96 price, uint256 cost) internal returns (uint256 id) {
        if (qty == 0) return 0;
        id = materialMarket.placeBid{value: cost}(transistors, tokenId, price, qty);
        if (id == 0) revert BadBidId();
    }

    /// @dev A zero id would make _askOpen() read remaining 0 and silently unlock a second order.
    function _placeAskLeg(uint8 tokenId, uint256 qty, uint96 price) internal returns (uint256 id) {
        if (qty == 0) return 0;
        id = materialMarket.placeAsk(transistors, tokenId, price, qty);
        if (id == 0) revert BadAskId();
    }

    function _legFilled(uint256 id, uint256 qty) internal view returns (bool) {
        return qty == 0 || _remaining(id) == 0;
    }

    /// @dev True when the seller has taken at least one unit, including a leg whose remaining is already 0.
    function _filledSome(uint256 id, uint256 qty) internal view returns (bool) {
        return qty != 0 && _remaining(id) < qty;
    }

    /// @dev Cancel the unfilled remainder. A filled leg (remaining == 0) is left alone; cancelBid would revert.
    function _cancelOpenLeg(uint256 id, uint256 qty) internal {
        if (qty != 0 && id != 0 && _remaining(id) != 0) materialMarket.cancelBid(id);
    }

    /// @dev True when raised BNB can no longer repay every outstanding share at the subscription price.
    function _shortfall() internal view returns (bool) {
        // outstandingShares == 0 is the settled state: refund() must still go through to tell the caller it already left.
        return raisedBnb < outstandingShares * sharePriceBnb;
    }

    /// @dev Parts for the live order are in this contract. Token id 0 is NAND, 1 is LATCH.
    function _partsOnHand() internal view returns (bool) {
        IERC1155 token = IERC1155(transistors);
        return (nandQty <= token.balanceOf(address(this), 0)) && (latchQty <= token.balanceOf(address(this), 1));
    }

    function _remaining(uint256 id) internal view returns (uint256 remaining) {
        if (id == 0) return 0;
        (,,,,, remaining) = materialMarket.bids(id);
    }

    function _clearOrder() internal {
        // transistors stays: locked at create for this round's processor parts contract.
        // Bid ids and unit prices are only read back through the market; keeping them buys nothing but bytes.
        // The ids are zeroed too: a stale id must not look like a live order (readers gate on id != 0).
        nandBidId = latchBidId = 0;
        nandQty = latchQty = 0;
        priceLock = 0;
    }

    function _askRecorded() internal view returns (bool) {
        return (nandAskQty | latchAskQty) != 0;
    }

    /// @dev Drop ask storage once every leg has filled, so no ghost order shows up in the UI.
    function _purgeFilledAsk() internal {
        if (!_askOpen()) _clearAsk();
    }

    function _askOpen() internal view returns (bool) {
        return (nandAskQty > 0 && _askRemaining(nandAskId) > 0)
            || (latchAskQty > 0 && _askRemaining(latchAskId) > 0);
    }

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
    /// @dev If the official market delivers NAND + LATCH in one safeBatchTransferFrom, missing this
    ///      function reverts the whole delivery — the market may already have decremented `remaining`,
    ///      so _partsOnHand() would stay false and confirmTransistors / depositToPool would revert
    ///      forever while raisedBnb is already spent: the subscribers' principal and the delivered
    ///      parts would both be trapped.
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    /// @notice ERC165 interface declaration.
    /// @dev Without it, some standard implementations refuse to interact with this contract
    ///      (safeTransferFrom pre-check).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0xd9b67a26 || // ERC1155
            interfaceId == 0x4e2312e0 || // ERC1155MetadataURI
            interfaceId == 0x780e9d63; // ERC1155Batch
    }

    /// @notice Owner escape while Executing. Rewrites phase so a stuck round can reach refund or recover.
    ///         Does not move tokens and does not cancel a market order.
    ///         Listed is refused: cancel or abandon that bid first, or its escrow stays on the market.
    ///         0 None, 1 Buying, 2 Listed, 3 Ready.
    ///         Entering Ready requires the objective facts (orderFilled() && _partsOnHand()): Ready means
    ///         "parts are here", an invariant that must come from data, not from the owner's word — writing
    ///         it directly would let a round reach Mining with zero purchase and close refund / cancel /
    ///         recover forever. Every other direction stays open: Ready → Buying is the escape path for
    ///         part recovery and refund settlement, and closing it would turn a lost owner key into a
    ///         permanent loss for holders.
    function setPhase(uint8 next) external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Listed) revert AlreadyListed();
        if (next > uint8(Phase.Ready)) revert WrongScene();
        // Ready = parts are here. The invariant must come from data, not from the owner's word.
        // Other directions are unrestricted: Ready → Buying is the recovery / refund escape path.
        if (next == uint8(Phase.Ready) && !(orderFilled() && _partsOnHand())) {
            revert TransistorsNotReady();
        }
        uint8 previous = uint8(phase);
        phase = Phase(next);
        if (previous != next) emit PhaseChanged(previous, next);
    }

    /// @notice Owner escape hatch: sweep BNB that no share is entitled to. Not for normal flow —
    ///         it exists so dust is not stranded in the contract. Recipient is always `owner`.
    ///         No amount argument: one call moves everything that is safe to move.
    ///         While shares are still outstanding (Funding / Executing) only the excess over raisedBnb leaves,
    ///         so subscription escrow stays put. Once every share has left (outstandingShares == 0), the whole
    ///         balance leaves and raisedBnb is zeroed.
    function recoverBnb() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        // Three pots are never the owner's:
        //   - raisedBnb: the subscription escrow (while shares are outstanding)
        //   - unclaimed surplus: surplusPool − surplusPaid. totalPendingSurplus is a subset of that
        //     (accrued but not sent) — adding it again would double-reserve.
        //   - unclaimed service fee (totalPendingFee) and the mining revenue pool (revenuePool)
        // Missing any one would let the owner sweep holders' / recipients' money.
        uint256 reserved = totalPendingFee + revenuePool;
        // Unpaid surplus: surplusPool minus what was actually transferred. Note totalPendingSurplus is a
        // subset of surplusPool − surplusPaid (accrued but not sent) — adding it again would double-reserve.
        if (surplusPool > surplusPaid) reserved += surplusPool - surplusPaid;
        if (outstandingShares == 0) {
            // Every share settled → the escrow pool is released; the whole balance goes to the owner
            // (minus the reserved pots above).
            if (amount <= reserved) revert ZeroShares();
            amount -= reserved;
            raisedBnb = 0;
        } else {
            // Shares still outstanding → only the excess over the escrow pool (raisedBnb, which already
            // covers claimable surplus) may leave.
            uint256 keep = raisedBnb + reserved;
            if (amount <= keep) revert ZeroShares();
            amount -= keep;
        }
        if (amount == 0) revert ZeroShares();
        _send(owner, amount);
        emit BnbRecovered(amount, owner);
    }

    function _trySend(address to, uint256 amount) internal returns (bool ok) {
        (ok, ) = to.call{value: amount}("");
    }

    function _send(address to, uint256 amount) internal {
        if (!_trySend(to, amount)) revert TransferFailed();
    }
}
