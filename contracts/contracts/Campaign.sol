// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IERC1155} from "./interfaces/IERC1155.sol";
import {IPoD} from "./interfaces/IPoD.sol";
import {IMaterialMarket} from "./interfaces/IMaterialMarket.sol";
import {Emission} from "./libraries/Emission.sol";

/// @title Campaign — one BEM crowdfunding-mining round
/// @notice Scenes: Funding → Executing → Mining. Executing phases: Buying → Listed → Ready.
///
/// Funds:
///  - Subscription BNB sits in raisedBnb. Subscribe is still allowed at the exact deadline.
///    After the deadline, if the round is not sold out, each subscriber calls refund.
///  - Transistor minting has ended. The owner spends raisedBnb on material-market placeBid.
///    Sellers fillBid and parts arrive as ERC1155. If the bid is unaffordable the tx succeeds,
///    sets executionFailed, and does not place. Only the market may refund escrow via receive.
///  - execute does not pay the market. Part cost was already escrowed. It checks the netlist
///    hash and fills, returns leftover BNB, then calls pod.start.
///  - Share transfer is Mining-only. Buyer BNB is paid straight to the seller, not into raisedBnb.
///  - pendingBem uses available _shares only. Escrowed shares do not accrue.
contract Campaign is Ownable, ReentrancyGuard {
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

    /// @notice One service-fee share. shareBps is a whole-percent slice (100 = 1%). The table must sum to 10000.
    struct FeeShare {
        address recipient;
        uint16 shareBps;
    }

    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_FEE_SHARES = 20;

    // ─────────────────────── immutable config (fixed at creation) ───────────────────────
    uint256 public immutable sharePriceBnb; // price per share (wei)
    uint256 public immutable totalShares; // share cap
    uint16 public immutable feeBps; // service fee in bps of daily emission
    uint64 public immutable fundingDeadline; // funding deadline (unix seconds)
    uint256 public immutable taskId; // official task id
    bytes32 public immutable netlistHash; // netlist hash committed at creation
    // Owner may replace external deps (material market / PoD). Ownership via transferOwnership.
    IPoD public pod;
    IERC20 public bem;
    /// @notice Material market (placeBid / cancelBid / bids). Testnets may use a matching mock.
    IMaterialMarket public market;

    // ─────────────────────── mutable state ───────────────────────
    Scene public scene;
    Phase public phase;
    uint256 public sold;
    uint64 public soldOutAt;
    bool public executionFailed;

    uint256 public raisedBnb; // subscription escrow. Bids debit it; market refunds credit it via receive
    uint256 public harvestCount;
    uint256 public totalDistributed; // net BEM allocated to holders this round (wei)
    uint256 public totalFeeCollected; // cumulative service-fee BEM
    uint256 public totalClaimed; // cumulative claimed BEM
    uint256 public totalRefunded; // cumulative refunded BNB (all wallets)

    uint256 public hashpower; // live weight H returned by PoD.start
    uint256 public estHashpower; // design estimate shown before execute
    bool public capped; // mining gate (true → unverified pool)
    uint256 public transistorCount; // NAND qty + LATCH qty for the live order
    uint256 public priceLock; // total bid escrow (wei), not a unit price. 0 = no live order
    address public transistors;
    uint256 public nandBidId;
    uint256 public latchBidId;
    uint256 public nandQty;
    uint256 public latchQty;
    uint96 public nandPrice;
    uint96 public latchPrice;

    // network weights (oracle). Defaults are the on-chain snapshot at deploy.
    uint256 public netWeightVerified;
    uint256 public netWeightUnverified;

    // ─────────────────────── per-wallet ledger ───────────────────────
    mapping(address => uint256) private _shares; // available shares
    mapping(address => uint256) private _escrow; // shares locked in a listing
    mapping(address => uint256) private _claimed; // BEM already claimed by this wallet
    mapping(address => uint256) private _refunded; // BNB already refunded to this wallet
    address[] private _holders; // subscribers and listing buyers. openRefund and surplus use this list
    mapping(address => bool) private _holderSeen;

    Listing[] private _listings;
    FeeShare[] private _feeShares;

    // ─────────────────────── events ───────────────────────
    event Subscribed(address indexed subscriber, uint256 count, uint256 paidBnb);
    event Refunded(address indexed holder, uint256 amountBnb);
    event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare);
    event ListingCancelled(uint256 indexed id, address indexed seller, uint256 shares);
    event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb);
    /// @notice The second argument is total escrowed BNB, not a unit price. The name is kept for the old ABI.
    event TransistorOrderPlaced(uint256 count, uint256 unitPriceBnb);
    event TransistorOrderCancelled();
    event TransistorsConfirmed();
    /// @notice needBnb is the bid escrow that could not be paid. openRefund emits 0. The tx does not revert.
    event ExecutionFailed(uint256 needBnb, uint256 raisedBnb);
    event Executed(uint256 spentBnb, uint256 hashpower);
    event SurplusReturned(address indexed holder, uint256 amountBnb);
    event SurplusSendFailed(address indexed holder, uint256 amountBnb);
    event RefundSendFailed(address indexed holder, uint256 amountBnb);
    event Harvested(uint256 round, uint256 grossBem, uint256 feeBem, uint256 netBem);
    event Claimed(address indexed holder, uint256 amountBem);
    event NetworkWeightUpdated(uint256 verified, uint256 unverified);
    event PlanUpdated(uint256 estHashpower, bool capped, uint256 transistorCount);
    event PodUpdated(address indexed previous, address indexed next);
    event BemUpdated(address indexed previous, address indexed next);
    event MinterUpdated(address indexed previous, address indexed next);
    event FeeSharesUpdated(uint256 count);
    /// @notice One fee split. remainder is the rounding dust sent to the owner.
    event FeeDistributed(uint256 totalFee, uint256 remainder);
    /// @notice Test rescue: Owner pulled ERC1155 parts out so they are not left in the campaign. `to` is the owner.
    event TransistorsRecovered(address indexed token, uint256 indexed id, uint256 amount, address indexed to);
    /// @notice Test rescue: Owner pulled BNB that was stuck in the campaign. `to` is the owner.
    event BnbRecovered(uint256 amount, address indexed to);

    // ─────────────────────── errors ───────────────────────
    error DirectTransferNotAllowed();
    error WrongScene();
    error FundingEnded();
    error NotSoldOut();
    error NetlistMismatch();
    error TransistorsNotReady();
    error RefundNotAvailable();
    error NothingToClaim();
    error NoEmission();
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
    error BadFeeShares();
    error PodCallFailed();

    /// @param minter_ Material-market address. The storage name stays minter; read it via minter().
    /// @param feeRecipients_ / feeShareBps_ Fee-share table. Shares must sum to 10000.
    /// @param netlistHash_ Compared with keccak256(tapeoutData) inside execute.
    /// @param transistors_ Official ERC1155 parts contract for this round (TapeOut or Behemoth). Locked at create; placeBid uses it.
    constructor(
        uint256 sharePriceBnb_,
        uint256 totalShares_,
        uint16 feeBps_,
        uint64 fundingDeadline_,
        address[] memory feeRecipients_,
        uint16[] memory feeShareBps_,
        uint256 taskId_,
        address pod_,
        address bem_,
        address minter_,
        bytes32 netlistHash_,
        address owner_,
        uint256 netWeightVerified_,
        uint256 netWeightUnverified_,
        address transistors_
    ) Ownable(owner_) {
        if (pod_ == address(0) || bem_ == address(0) || minter_ == address(0) || transistors_ == address(0)) {
            revert ZeroAddress();
        }
        if (totalShares_ == 0 || sharePriceBnb_ == 0) revert ZeroShares();
        sharePriceBnb = sharePriceBnb_;
        totalShares = totalShares_;
        feeBps = feeBps_;
        fundingDeadline = fundingDeadline_;
        taskId = taskId_;
        pod = IPoD(pod_);
        bem = IERC20(bem_);
        market = IMaterialMarket(minter_);
        netlistHash = netlistHash_;
        transistors = transistors_;
        scene = Scene.Funding;
        phase = Phase.None;
        netWeightVerified = netWeightVerified_;
        netWeightUnverified = netWeightUnverified_;
        _writeFeeShares(feeRecipients_, feeShareBps_);
    }

    /// @dev Subscribe and share sales do not use receive. Only unfilled bid escrow from the market is accepted and credited to raisedBnb.
    receive() external payable {
        if (msg.sender != address(market)) revert DirectTransferNotAllowed();
        raisedBnb += msg.value;
    }

    /// @notice Legacy reader. Returns the material-market address.
    function minter() external view returns (address) {
        return address(market);
    }

    /// @notice Legacy reader. Returns the first fee-share recipient. Use feeShares or feeShareAt for the full table.
    function feeRecipient() external view returns (address) {
        return _feeShares.length == 0 ? address(0) : _feeShares[0].recipient;
    }

    function feeShareCount() external view returns (uint256) {
        return _feeShares.length;
    }

    function feeShareAt(uint256 index) external view returns (address recipient, uint16 shareBps) {
        if (index >= _feeShares.length) revert BadFeeShares();
        FeeShare storage item = _feeShares[index];
        return (item.recipient, item.shareBps);
    }

    function feeShares() external view returns (FeeShare[] memory) {
        return _feeShares;
    }

    // ─────────────────────────── external deps (owner) ───────────────────────────

    /// @notice Replace PoD. Swapping it mid-mining can change claim/start. Trust the owner.
    function setPod(address pod_) external onlyOwner {
        if (pod_ == address(0)) revert ZeroAddress();
        emit PodUpdated(address(pod), pod_);
        pod = IPoD(pod_);
    }

    /// @notice Replace BEM. Pending is still claimed from this contract's balance. Check the ledger before switching tokens.
    function setBem(address bem_) external onlyOwner {
        if (bem_ == address(0)) revert ZeroAddress();
        emit BemUpdated(address(bem), bem_);
        bem = IERC20(bem_);
    }

    /// @notice Replace the material market (official placeBid contract, or a matching test mock).
    function setMinter(address minter_) external onlyOwner {
        if (minter_ == address(0)) revert ZeroAddress();
        emit MinterUpdated(address(market), minter_);
        market = IMaterialMarket(minter_);
    }

    /// @notice Replace the fee-share table. Shares must sum to 10000. Rounding dust is paid to the owner on harvest.
    function setFeeShares(address[] calldata recipients, uint16[] calldata shareBps) external onlyOwner {
        _writeFeeShares(recipients, shareBps);
    }

    // ─────────────────────────── emission ───────────────────────────

    /// @notice This round's daily BEM (wei). Zero before execute.
    function dailyBem() public view returns (uint256) {
        return Emission.dailyBem(hashpower, capped, netWeightVerified, netWeightUnverified);
    }

    /// @notice Claimable = totalDistributed × available shares / totalShares − claimed.
    ///         totalDistributed is the sum of nets actually pulled from PoD, not dailyBem × rounds.
    ///         Uses _shares only. Escrowed shares do not accrue. takeListing moves the seller's claimed pro-rata.
    function pendingBem(address account) public view returns (uint256) {
        if (scene != Scene.Mining || totalDistributed == 0) return 0;
        uint256 accrued = (totalDistributed * _shares[account]) / totalShares;
        uint256 done = _claimed[account];
        return accrued > done ? accrued - done : 0;
    }

    /// @notice Update network weights (oracle). Weights keep moving, so refresh them.
    function updateNetworkWeight(uint256 verified, uint256 unverified) external onlyOwner {
        netWeightVerified = verified;
        netWeightUnverified = unverified;
        emit NetworkWeightUpdated(verified, unverified);
    }

    /// @notice Set the estimate, unverified-pool flag, and display part count. Zero count reverts.
    ///         Writable in Funding, and in Executing only while Buying. Not writable in Listed, Ready, or Mining.
    ///         The live order quantity is whatever placeTransistorOrder writes. This function does not place a bid.
    function setPlan(uint256 estHashpower_, bool capped_, uint256 transistorCount_) external onlyOwner {
        if (scene == Scene.Mining) revert WrongScene();
        if (scene == Scene.Executing && phase != Phase.Buying) revert WrongScene();
        if (transistorCount_ == 0) revert ZeroShares();
        estHashpower = estHashpower_;
        capped = capped_;
        transistorCount = transistorCount_;
        emit PlanUpdated(estHashpower_, capped_, transistorCount_);
    }

    // ─────────────────────────── subscribe ───────────────────────────

    /// @notice Buy an integer number of shares. msg.value must equal count × sharePriceBnb.
    ///         Subscribe is still allowed when timestamp == fundingDeadline. A sell-out moves the round to Executing / Buying.
    function subscribe(uint256 count) external payable nonReentrant {
        if (scene != Scene.Funding) revert WrongScene();
        if (block.timestamp > fundingDeadline) revert FundingEnded();
        if (count == 0) revert ZeroShares();
        if (sold + count > totalShares) revert ExceedsRemaining();
        if (msg.value != count * sharePriceBnb) revert WrongPayment();

        _shares[msg.sender] += count;
        sold += count;
        raisedBnb += msg.value;
        _trackHolder(msg.sender);

        if (sold == totalShares) {
            scene = Scene.Executing;
            phase = Phase.Buying;
            soldOutAt = uint64(block.timestamp);
        }
        emit Subscribed(msg.sender, count, msg.value);
    }

    // ─────────────────────────── refund (pull) ───────────────────────────

    /// @notice The subscriber pulls their principal. Nothing runs automatically at the deadline.
    ///         Allowed when Funding and timestamp > fundingDeadline, Executing and executionFailed,
    ///         or Executing/Buying when raisedBnb can no longer cover every share (a partial fill was settled).
    ///         A full pool pays count × sharePriceBnb. A short pool pays pro-rata of raisedBnb.
    ///         Reverts if this wallet still has escrowed shares.
    function refund() external nonReentrant {
        bool fundingExpired = scene == Scene.Funding && block.timestamp > fundingDeadline;
        bool execFailed = scene == Scene.Executing && executionFailed;
        bool short = scene == Scene.Executing && phase == Phase.Buying && _shortfall();
        if (!fundingExpired && !execFailed && !short) revert RefundNotAvailable();

        // A failed send must revert the whole tx. Soft-fail would surface as ZeroShares.
        if (_refundHolder(msg.sender, false) == 0) revert ZeroShares();
    }

    function _trackHolder(address who) internal {
        if (_holderSeen[who]) return;
        _holderSeen[who] = true;
        _holders.push(who);
    }

    /// @dev Refund this wallet. Returns 0 if shares are 0, any shares are escrowed, or the pro-rata share rounds to 0.
    ///      A full pool pays count × sharePriceBnb. A short pool pays raisedBnb × shares / sold.
    ///      soft=true (openRefund): a failed send restores this wallet and is skipped.
    ///      soft=false: a failed send reverts the whole transaction.
    function _refundHolder(address who, bool soft) internal returns (uint256 amount) {
        uint256 s = _shares[who];
        if (s == 0 || _escrow[who] != 0 || sold == 0) return 0;
        uint256 owed = s * sharePriceBnb;
        uint256 poolOwed = sold * sharePriceBnb;
        amount = raisedBnb >= poolOwed ? owed : (raisedBnb * s) / sold;
        if (amount == 0) return 0;
        _shares[who] = 0;
        sold -= s;
        raisedBnb -= amount;
        if (!_trySend(who, amount)) {
            _shares[who] = s;
            sold += s;
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

    /// @notice Mining only. Moves shares into escrow. They stop accruing pendingBem until sold or cancelled.
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
    ///         Moves _claimed pro-rata to the buyer's share of the seller's available plus escrowed shares,
    ///         so the buyer cannot reclaim rounds the seller already claimed.
    function takeListing(uint256 id, uint256 count) external payable nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (id >= _listings.length || !_listings[id].open) revert NoListing();
        Listing storage l = _listings[id];
        if (msg.sender == l.seller) revert CannotTakeOwnListing();
        if (count == 0 || count > l.shares) revert BadCount();

        uint256 pay = count * l.priceBnbPerShare;
        if (msg.value != pay) revert WrongPayment();

        uint256 sellerHeld = _shares[l.seller] + _escrow[l.seller];
        if (sellerHeld > 0) {
            uint256 moveClaimed = (_claimed[l.seller] * count) / sellerHeld;
            if (moveClaimed > 0) {
                _claimed[l.seller] -= moveClaimed;
                _claimed[msg.sender] += moveClaimed;
            }
        }

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
    ///         Reverts if already failed and (not sold out or raisedBnb is 0). A sold-out round with BNB left clears the flag and places.
    function placeTransistorOrder(
        address transistors_,
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external onlyOwner nonReentrant {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase == Phase.Listed) revert AlreadyListed();
        if (transistors == address(0)) revert ZeroAddress();
        if (transistors_ != address(0) && transistors_ != transistors) revert ZeroAddress();
        if (nandQty_ == 0 && latchQty_ == 0) revert ZeroShares();
        if ((nandQty_ > 0 && nandPrice_ == 0) || (latchQty_ > 0 && latchPrice_ == 0)) revert ZeroPrice();
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
        transistorCount = nandQty_ + latchQty_;
        priceLock = cost;
        if (nandQty_ > 0) {
            nandBidId = market.placeBid{value: nandCost}(transistors, 0, nandPrice_, nandQty_);
            if (nandBidId == 0) revert BadBidId();
        }
        if (latchQty_ > 0) {
            latchBidId = market.placeBid{value: latchCost}(transistors, 1, latchPrice_, latchQty_);
            if (latchBidId == 0) revert BadBidId();
        }
        phase = Phase.Listed;
        emit TransistorOrderPlaced(transistorCount, cost);
    }

    /// @notice Buying only. The owner sets executionFailed if needed, then refunds each holder.
    ///         Quotes are ignored. A rejecting address is skipped. Already Listed must be cancelled first.
    function openRefund() external onlyOwner nonReentrant {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase != Phase.Buying) revert AlreadyListed();
        if (!executionFailed) {
            executionFailed = true;
            emit ExecutionFailed(0, raisedBnb);
        }
        uint256 n = _holders.length;
        for (uint256 i = 0; i < n; i++) {
            _refundHolder(_holders[i], true);
        }
    }

    /// @notice Cancel whatever is still open on the market, then return to Buying.
    ///         An untouched order can be cancelled by the owner only.
    ///         Once any quantity has filled, anyone may cancel the remainder so the escrow comes back.
    ///         A fully filled order whose parts are already in this contract cannot be cancelled.
    ///         cancelBid refunds the unfilled escrow into receive. Filled quantity stays spent.
    function cancelTransistorOrder() external nonReentrant {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase != Phase.Listed) revert NotListed();
        bool touched = _filledSome(nandBidId, nandQty) || _filledSome(latchBidId, latchQty);
        if (orderFilled() && _partsOnHand()) revert OrderFilled();
        if (!touched && msg.sender != owner) revert NotOwner(msg.sender);
        _cancelOpenLeg(nandBidId, nandQty);
        _cancelOpenLeg(latchBidId, latchQty);
        _clearOrder();
        phase = Phase.Buying;
        emit TransistorOrderCancelled();
    }

    /// @notice Anyone may call. Does not move tokens.
    ///         Moves Listed → Ready only when both legs have remaining == 0 and this contract holds the parts.
    ///         A zero-qty leg counts as filled.
    function confirmTransistors() external {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase != Phase.Listed) revert NotListed();
        if (!orderFilled() || !_partsOnHand()) revert TransistorsNotReady();
        phase = Phase.Ready;
        emit TransistorsConfirmed();
    }

    /// @notice True when the official book has fully filled this round's bids.
    function orderFilled() public view returns (bool) {
        return _legFilled(nandBidId, nandQty) && _legFilled(latchBidId, latchQty);
    }

    // ─────────────────────────── tape-out (irreversible, owner) ───────────────────────────

    /// @notice Owner only. Requires a sell-out, phase Ready, keccak256(tapeoutData) == netlistHash, and a still-filled order.
    ///         Does not pay the market. Returns leftover raisedBnb pro-rata, then pod.start(startData), and enters Mining.
    ///         Rejected surplus stays in raisedBnb.
    function execute(bytes calldata tapeoutData, bytes calldata startData) external onlyOwner nonReentrant {
        if (scene != Scene.Executing) revert WrongScene();
        if (sold < totalShares) revert NotSoldOut();
        if (phase != Phase.Ready) revert TransistorsNotReady();
        if (keccak256(tapeoutData) != netlistHash) revert NetlistMismatch();
        if (transistorCount == 0 || priceLock == 0) revert ZeroPrice();
        if (!orderFilled() || !_partsOnHand()) revert TransistorsNotReady();

        uint256 spent = priceLock;
        // Part cost was already escrowed in placeBid. Return leftover BNB, then start mining.
        _returnSurplus();
        hashpower = _podStart(startData); // weight returned by PoD, or burn weight from the official adapter
        scene = Scene.Mining;
        phase = Phase.None;
        executionFailed = false;
        emit Executed(spent, hashpower);
    }

    // ─────────────────────────── harvest / claim ───────────────────────────

    /// @notice Anyone may call. Credits the BEM PoD actually paid, not the dailyBem estimate.
    ///         A short pull is still distributed. A larger pull (verified-pool premium over b*×P) is distributed too.
    ///         The fee is split by the share table; rounding dust goes to the owner.
    ///         Net BEM is not credited per wallet — only totalDistributed and harvestCount increase.
    function harvest() external nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();

        uint256 pulled = _podClaim();
        if (pulled == 0) revert NoEmission();
        uint256 fee = (pulled * feeBps) / BPS;
        uint256 net = pulled - fee;
        if (net == 0) revert NoEmission();

        harvestCount += 1;
        totalFeeCollected += fee;
        totalDistributed += net;

        if (fee > 0) {
            _distributeFee(fee);
        }
        emit Harvested(harvestCount, pulled, fee, net);
    }

    /// @notice Claim msg.sender's pending. If the contract's BEM is short, only the balance is sent and claimed is increased by that amount.
    function claim() external nonReentrant returns (uint256) {
        if (scene != Scene.Mining) revert WrongScene();
        uint256 pending = pendingBem(msg.sender);
        if (pending == 0) revert NothingToClaim();
        uint256 bal = bem.balanceOf(address(this));
        uint256 amount = pending <= bal ? pending : bal;
        if (amount == 0) revert NothingToClaim();

        _claimed[msg.sender] += amount;
        totalClaimed += amount;
        if (!bem.transfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(msg.sender, amount);
        return amount;
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

    function claimedOf(address account) external view returns (uint256) {
        return _claimed[account];
    }

    function refundedOf(address account) external view returns (uint256) {
        return _refunded[account];
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function getListing(uint256 id) external view returns (Listing memory) {
        if (id >= _listings.length) revert NoListing();
        return _listings[id];
    }

    // ─────────────────────────── internal ───────────────────────────

    /// @dev After a successful tape-out, return unused raisedBnb pro-rata. Rounding dust goes to the owner.
    ///      A rejecting address leaves that slice in raisedBnb and does not abort execute. During tests, rescueUnsentBnb can pull it out.
    function _returnSurplus() internal {
        uint256 leftover = raisedBnb;
        if (leftover == 0 || sold == 0) return;
        raisedBnb = 0;
        uint256 distributed;
        uint256 n = _holders.length;
        for (uint256 i = 0; i < n; i++) {
            address who = _holders[i];
            uint256 s = _shares[who];
            if (s == 0) continue;
            uint256 part = (leftover * s) / sold;
            if (part == 0) continue;
            if (!_trySend(who, part)) {
                raisedBnb += part;
                emit SurplusSendFailed(who, part);
                continue;
            }
            distributed += part;
            _refunded[who] += part;
            totalRefunded += part;
            emit SurplusReturned(who, part);
        }
        uint256 dust = leftover - distributed - raisedBnb;
        if (dust > 0) {
            if (!_trySend(owner, dust)) {
                raisedBnb += dust;
                emit SurplusSendFailed(owner, dust);
            }
        }
    }

    /// @dev Split the fee by the share table. Rounding dust goes to the owner. Any failed transfer reverts the whole call.
    function _distributeFee(uint256 fee) internal {
        uint256 paid;
        uint256 n = _feeShares.length;
        for (uint256 i = 0; i < n; i++) {
            FeeShare storage item = _feeShares[i];
            uint256 part = (fee * uint256(item.shareBps)) / BPS;
            if (part == 0) continue;
            if (!bem.transfer(item.recipient, part)) revert TransferFailed();
            paid += part;
        }
        uint256 rem = fee - paid;
        if (rem > 0) {
            if (!bem.transfer(owner, rem)) revert TransferFailed();
        }
        emit FeeDistributed(fee, rem);
    }

    /// @dev Replace the fee-share table. Length 1..MAX_FEE_SHARES, non-zero addresses,
    ///      each share is a whole percent (multiple of 100 bps, 1..100), sum == 10000.
    function _writeFeeShares(address[] memory recipients, uint16[] memory shareBps) internal {
        uint256 n = recipients.length;
        if (n == 0 || n > MAX_FEE_SHARES || n != shareBps.length) revert BadFeeShares();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            uint16 bps = shareBps[i];
            // Whole percent only: 100, 200, …, 10000. No fractional percents.
            if (recipients[i] == address(0) || bps == 0 || bps > BPS || bps % 100 != 0) revert BadFeeShares();
            sum += bps;
        }
        if (sum != BPS) revert BadFeeShares();
        while (_feeShares.length > 0) {
            _feeShares.pop();
        }
        for (uint256 i = 0; i < n; i++) {
            _feeShares.push(FeeShare({recipient: recipients[i], shareBps: shareBps[i]}));
        }
        emit FeeSharesUpdated(n);
    }

    /// @notice Test rescue. Sends ERC1155 parts held by this campaign to the current owner so a test transfer is not lost.
    ///         Blocked while an order is live (Listed) or waiting for tape-out (Ready).
    ///         Does not change the order, price lock, or scene. Recipient is always `owner`.
    function recoverTransistors(address token, uint256 id, uint256 amount) external onlyOwner nonReentrant {
        if (phase == Phase.Listed) revert AlreadyListed();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroShares();
        IERC1155(token).safeTransferFrom(address(this), owner, id, amount, "");
        emit TransistorsRecovered(token, id, amount, owner);
    }

    /// @notice Test rescue. Sends BNB stuck in this campaign to the current owner and emits BnbRecovered.
    ///         Funding / Executing: only the excess over raisedBnb, so subscription escrow stays put.
    ///         Mining: can also take remaining raisedBnb left after a rejected surplus transfer.
    ///         Recipient is always `owner`.
    function recoverBnb(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroShares();
        uint256 bal = address(this).balance;
        if (amount > bal) revert ExceedsRemaining();

        uint256 reserved = raisedBnb;
        uint256 excess = bal > reserved ? bal - reserved : 0;
        if (amount > excess) {
            if (scene != Scene.Mining) revert WrongScene();
            raisedBnb = reserved - (amount - excess);
        }
        _send(owner, amount);
        emit BnbRecovered(amount, owner);
    }

    /// @notice Test rescue. Mining only. Sends the remaining raisedBnb to `to` when a holder rejected the surplus
    ///         and the BNB would otherwise sit in this campaign. `to` may be the rejected address or the owner.
    function rescueUnsentBnb(address to) external onlyOwner nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (to == address(0)) revert ZeroAddress();
        uint256 amt = raisedBnb;
        if (amt == 0) revert ZeroShares();
        raisedBnb = 0;
        _send(to, amt);
    }

    function _legFilled(uint256 id, uint256 qty) internal view returns (bool) {
        if (qty == 0) return true;
        return _remaining(id) == 0;
    }

    /// @dev True when the seller has taken at least one unit, including a leg whose remaining is already 0.
    function _filledSome(uint256 id, uint256 qty) internal view returns (bool) {
        if (qty == 0) return false;
        return _remaining(id) < qty;
    }

    /// @dev Cancel the unfilled remainder. A filled leg (remaining == 0) is left alone; cancelBid would revert.
    function _cancelOpenLeg(uint256 id, uint256 qty) internal {
        if (qty == 0 || id == 0) return;
        if (_remaining(id) == 0) return;
        market.cancelBid(id);
    }

    /// @dev True when raised BNB can no longer repay every outstanding share at the subscription price.
    function _shortfall() internal view returns (bool) {
        if (sold == 0) return false;
        return raisedBnb < sold * sharePriceBnb;
    }

    /// @dev Parts for the live order are in this contract. Token id 0 is NAND, 1 is LATCH.
    function _partsOnHand() internal view returns (bool) {
        IERC1155 token = IERC1155(transistors);
        if (nandQty > 0 && token.balanceOf(address(this), 0) < nandQty) return false;
        if (latchQty > 0 && token.balanceOf(address(this), 1) < latchQty) return false;
        return true;
    }

    function _remaining(uint256 id) internal view returns (uint256 remaining) {
        if (id == 0) return 0;
        (,,,,, remaining) = market.bids(id);
    }

    function _clearOrder() internal {
        nandBidId = 0;
        latchBidId = 0;
        nandQty = 0;
        latchQty = 0;
        nandPrice = 0;
        latchPrice = 0;
        // transistors stays: locked at create for this round's TapeOut / Behemoth parts contract
        transistorCount = 0;
        priceLock = 0;
    }

    /// @dev Official fillBid uses ERC1155 safeTransfer. The caller is not checked; the hook only returns the receiver selector.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// @dev Official PoD start requires this campaign to own the circuit NFT. Accept safeTransferFrom so the
    ///      owner can move a taped-out circuit in before execute. No accounting change.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev OfficialPodAdapter reports podUsesDelegatecall() == true. Delegatecall keeps
    ///      msg.sender of the inner official call equal to this campaign, which is what Ownr() checks.
    ///      A normal IPoD (the test mock) is called directly. A malicious pod can be delegatecalled
    ///      only after the owner points setPod at it.
    function _podStart(bytes calldata startData) internal returns (uint256) {
        if (_podDelegatecall()) {
            (bool ok, bytes memory ret) = address(pod).delegatecall(abi.encodeCall(IPoD.start, (startData)));
            if (!ok) _bubble(ret);
            return abi.decode(ret, (uint256));
        }
        return IPoD(pod).start(startData);
    }

    function _podClaim() internal returns (uint256) {
        if (_podDelegatecall()) {
            (bool ok, bytes memory ret) = address(pod).delegatecall(abi.encodeCall(IPoD.claim, ()));
            if (!ok) _bubble(ret);
            return abi.decode(ret, (uint256));
        }
        return IPoD(pod).claim();
    }

    function _podDelegatecall() internal view returns (bool) {
        (bool ok, bytes memory ret) = address(pod).staticcall(abi.encodeWithSelector(bytes4(keccak256("podUsesDelegatecall()"))));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _bubble(bytes memory ret) private pure {
        if (ret.length == 0) revert PodCallFailed();
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }

    function _trySend(address to, uint256 amount) internal returns (bool ok) {
        (ok, ) = to.call{value: amount}("");
    }

    function _send(address to, uint256 amount) internal {
        if (!_trySend(to, amount)) revert TransferFailed();
    }
}
