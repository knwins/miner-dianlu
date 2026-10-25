// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMaterialMarket} from "../interfaces/IMaterialMarket.sol";
import {IERC1155} from "../interfaces/IERC1155.sol";

/// @dev Test-only mint hook exposed by MockERC1155. The real market delivers parts by transfer.
interface IMockPartsMint {
    function mint(address to, uint256 id, uint256 amount) external;
}

/// @notice Testnet stand-in with the official BUY-side ABI. There is no ask book, exactly like mainnet.
///         placeBid escrows BNB. cancelBid refunds the unfilled part to the buyer.
///         fillBid is the seller path: it pulls the parts from msg.sender, hands them to the bid's buyer
///         and pays price × quantity minus feeBps — credited to owed(msg.sender) by default, or sent to
///         the seller inside the fill when setPushProceeds(true) (the mainnet shape).
///         simulateSellerFill only decreases remaining (test helper for "somebody delivered to our bid").
///         deliverBid / deliverBidAll also hand the parts to the buyer, so a debug session can walk
///         Buying -> Listed -> Ready -> depositToPool without a separate mint transaction.
contract MockMaterialMarket is IMaterialMarket {
    struct Bid {
        address buyer;
        address transistors;
        uint96 price;
        uint8 tokenId;
        uint16 feeBps;
        uint256 remaining;
    }

    uint256 public nextBidId = 1;

    // ── Trade log: the frontend replays these events into the order history (qty, time, tx) ──
    event BidPlaced(uint256 indexed id, address indexed buyer, address indexed transistors, uint8 tokenId, uint96 price, uint256 quantity);
    event BidFilled(uint256 indexed id, uint256 quantity, uint256 remaining);
    event BidCancelled(uint256 indexed id, uint256 refund);
    event ProceedsWithdrawn(address indexed account, uint256 amount);

    /// @dev Test switch. When set, placeBid returns 0 and keeps the escrow, matching a market that fails to assign an id.
    bool public returnZeroId;
    mapping(uint256 => Bid) private _bids;
    mapping(address => uint256) private _owed;

    error BadBid();
    error NotBuyer();
    error NothingOwed();
    error MockOnMainnet();

    constructor() {
        // Last line of defence: this test double must never exist on BSC mainnet (chainId 56).
        // It exposes unauthenticated test switches (setBlockCancel / setReturnZeroId / setOrderVault):
        // as a round's market, anyone could make cancelBid revert forever and strand that round's
        // escrow. Reverting here burns gas but is the safe failure mode.
        if (block.chainid == 56) revert MockOnMainnet();
    }

    /// @dev Test switch: when off, seller-side calls (fillBid) see BadBid.
    bool public orderVault = true;

    function setOrderVault(bool on) external {
        orderVault = on;
    }

    /// @dev Test switch: makes cancelBid revert so the Campaign escape hatch's best-effort path can be tested.
    bool public blockCancel;

    function setBlockCancel(bool on) external {
        blockCancel = on;
    }

    /// @dev Test switch: pay the seller inside fillBid (what the mainnet market does) instead of
    ///      crediting owed(). Campaign.sellTransistors must accept both shapes.
    bool public pushProceeds;

    function setPushProceeds(bool on) external {
        pushProceeds = on;
    }

    /// @dev Test switch: fillBid moves the parts but pays the seller nothing (a broken market).
    bool public payNothing;

    function setPayNothing(bool on) external {
        payNothing = on;
    }

    function setReturnZeroId(bool on) external {
        returnZeroId = on;
    }

    function placeBid(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        payable
        returns (uint256 id)
    {
        if (transistors == address(0) || price == 0 || quantity == 0) revert BadBid();
        if (msg.value != uint256(price) * quantity) revert BadBid();
        if (returnZeroId) return 0;
        id = nextBidId++;
        _bids[id] = Bid({
            buyer: msg.sender,
            transistors: transistors,
            price: price,
            tokenId: tokenId,
            feeBps: 100,
            remaining: quantity
        });
        emit BidPlaced(id, msg.sender, transistors, tokenId, price, quantity);
    }

    /// @dev Test hook: create a zero-price bid. The official market cannot produce one (placeBid needs
    ///      msg.value == price × qty), so this exists only to prove Campaign refuses to fill it.
    function placeZeroPriceBid(address transistors, uint8 tokenId, uint256 quantity) external returns (uint256 id) {
        if (transistors == address(0) || quantity == 0) revert BadBid();
        id = nextBidId++;
        _bids[id] = Bid({
            buyer: msg.sender,
            transistors: transistors,
            price: 0,
            tokenId: tokenId,
            feeBps: 100,
            remaining: quantity
        });
        emit BidPlaced(id, msg.sender, transistors, tokenId, 0, quantity);
    }

    function cancelBid(uint256 id) external {
        if (blockCancel) revert BadBid();
        Bid storage b = _bids[id];
        if (b.buyer != msg.sender || b.remaining == 0) revert NotBuyer();
        uint256 refund = b.remaining * uint256(b.price);
        b.remaining = 0;
        emit BidCancelled(id, refund);
        (bool ok, ) = b.buyer.call{value: refund}("");
        if (!ok) revert BadBid();
    }

    /// @notice Official seller path: pull the parts from the caller, send them to the buyer, pay out the
    ///         net proceeds (price × quantity − feeBps). Mainnet sends the BNB right away; the default
    ///         mock shape credits owed(caller) for withdraw().
    function fillBid(uint256 id, uint256 quantity) external {
        if (!orderVault) revert BadBid();
        Bid storage b = _bids[id];
        if (b.buyer == address(0) || quantity == 0 || quantity > b.remaining) revert BadBid();
        b.remaining -= quantity;
        uint256 gross = quantity * uint256(b.price);
        uint256 fee = (gross * b.feeBps) / 10_000;
        uint256 net = payNothing ? 0 : gross - fee;
        if (!pushProceeds && net != 0) _owed[msg.sender] = _owed[msg.sender] + net;
        emit BidFilled(id, quantity, b.remaining);
        // The real market moves the parts with safeTransferFrom from the seller to the buyer.
        IERC1155(b.transistors).safeTransferFrom(msg.sender, b.buyer, b.tokenId, quantity, "");
        if (pushProceeds && net != 0) {
            (bool ok, ) = msg.sender.call{value: net}("");
            if (!ok) revert BadBid();
        }
    }

    /// @dev Test helper that simulates "someone else delivered to this bid". Proceeds stay in the market
    ///      and no parts move; tests mint the parts to the buyer separately.
    function simulateSellerFill(uint256 id, uint256 quantity) external {
        Bid storage b = _bids[id];
        if (quantity == 0 || quantity > b.remaining) revert BadBid();
        b.remaining -= quantity;
        emit BidFilled(id, quantity, b.remaining);
    }

    /// @dev Test helper: the bid is filled and the parts land in the buyer's ERC1155 balance, which is
    ///      what the official market does with safeTransferFrom. The mock mints them (MockERC1155.mint is
    ///      public); if the token cannot mint, it falls back to moving whatever inventory this market holds.
    function deliverBid(uint256 id, uint256 quantity) external {
        Bid storage b = _bids[id];
        if (quantity == 0 || quantity > b.remaining) revert BadBid();
        b.remaining -= quantity;
        emit BidFilled(id, quantity, b.remaining);
        _deliverParts(b.transistors, b.buyer, b.tokenId, quantity);
    }

    /// @dev Test helper: fill every remaining unit of a bid and deliver the parts.
    function deliverBidAll(uint256 id) external {
        Bid storage b = _bids[id];
        uint256 quantity = b.remaining;
        if (quantity == 0) revert BadBid();
        b.remaining = 0;
        emit BidFilled(id, quantity, 0);
        _deliverParts(b.transistors, b.buyer, b.tokenId, quantity);
    }

    function _deliverParts(address transistors, address buyer, uint8 tokenId, uint256 quantity) internal {
        try IMockPartsMint(transistors).mint(buyer, tokenId, quantity) {}
        catch {
            IERC1155(transistors).safeTransferFrom(address(this), buyer, tokenId, quantity, "");
        }
    }

    function bids(uint256 id)
        external
        view
        returns (
            address buyer,
            address transistors,
            uint96 price,
            uint8 tokenId,
            uint16 feeBps,
            uint256 remaining
        )
    {
        Bid storage b = _bids[id];
        return (b.buyer, b.transistors, b.price, b.tokenId, b.feeBps, b.remaining);
    }

    function owed(address account) external view returns (uint256) {
        return _owed[account];
    }

    /// @dev Test hook: credit `account` with proceeds this market already holds, so a Campaign can be
    ///      exercised against a settlement that only lands after pooling.
    function creditOwed(address account, uint256 amount) external payable {
        if (msg.value != amount) revert BadBid();
        _owed[account] += amount;
    }

    /// @dev Test switch: makes withdraw() revert, so the Campaign's "drain before swapping" path can be
    ///      exercised against a market that owes BNB but cannot release it.
    bool public blockWithdraw;

    function setBlockWithdraw(bool on) external {
        blockWithdraw = on;
    }

    function withdraw() external {
        if (blockWithdraw) revert BadBid();
        uint256 amount = _owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        _owed[msg.sender] = 0;
        emit ProceedsWithdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert BadBid();
    }
}
