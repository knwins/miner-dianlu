// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMaterialMarket} from "../interfaces/IMaterialMarket.sol";
import {IERC1155} from "../interfaces/IERC1155.sol";

/// @dev Test-only mint hook exposed by MockERC1155. The real market delivers parts by transfer.
interface IMockPartsMint {
    function mint(address to, uint256 id, uint256 amount) external;
}

/// @notice Testnet stand-in with the official bid + ask ABI.
///         placeBid escrows BNB. cancelBid refunds the unfilled part to the buyer.
///         fillBid only decreases remaining (simulates a seller fill; tests mint parts separately).
///         deliverBid / deliverBidAll also hand the parts to the buyer, so a debug session can walk
///         Buying -> Listed -> Ready -> depositToPool without a separate mint transaction.
///         placeAsk pulls ERC1155 from the seller. fillAsk pays the seller and moves parts to the buyer.
///         cancelAsk returns unsold parts. owed + withdraw cover ask proceeds that land after fill.
contract MockMaterialMarket is IMaterialMarket {
    struct Bid {
        address buyer;
        address transistors;
        uint96 price;
        uint8 tokenId;
        uint16 feeBps;
        uint256 remaining;
    }

    struct Ask {
        address seller;
        address transistors;
        uint96 price;
        uint8 tokenId;
        uint256 remaining;
    }

    uint256 public nextBidId = 1;
    uint256 public nextAskId = 1;

    // ── Trade log: the frontend replays these events into the order history (qty, time, tx) ──
    event BidPlaced(uint256 indexed id, address indexed buyer, address indexed transistors, uint8 tokenId, uint96 price, uint256 quantity);
    event BidFilled(uint256 indexed id, uint256 quantity, uint256 remaining);
    event BidCancelled(uint256 indexed id, uint256 refund);
    event AskPlaced(uint256 indexed id, address indexed seller, address indexed transistors, uint8 tokenId, uint96 price, uint256 quantity);
    event AskFilled(uint256 indexed id, address indexed buyer, uint256 quantity, uint256 paid);
    event AskCancelled(uint256 indexed id, uint256 quantity);
    event ProceedsWithdrawn(address indexed account, uint256 amount);

    /// @dev Test switch. When set, placeBid returns 0 and keeps the escrow, matching a market that fails to assign an id.
    bool public returnZeroId;
    /// @dev Test switch. When set, placeAsk returns 0 (the parts were already pulled).
    bool public returnZeroAsk;
    mapping(uint256 => Bid) private _bids;
    mapping(uint256 => Ask) private _asks;
    mapping(address => uint256) private _owed;

    error BadBid();
    error BadAsk();
    error NotBuyer();
    error NotSeller();
    error NothingOwed();
    error MockOnMainnet();

    constructor() {
        // Last line of defence: this test double must never exist on BSC mainnet (chainId 56).
        // It exposes unauthenticated test switches (setBlockCancel / setReturnZeroId / setOrderVault):
        // as a round's market, anyone could make cancelBid revert forever and strand that round's
        // escrow. Reverting here burns gas but is the safe failure mode.
        if (block.chainid == 56) revert MockOnMainnet();
    }

    /// @dev Test switch: when off, seller-side calls (fillBid / fillAsk) see BadBid.
    bool public orderVault = true;

    function setOrderVault(bool on) external {
        orderVault = on;
    }

    /// @dev Test switch: makes cancelBid revert so the Campaign escape hatch's best-effort path can be tested.
    bool public blockCancel;

    function setBlockCancel(bool on) external {
        blockCancel = on;
    }

    function setReturnZeroId(bool on) external {
        returnZeroId = on;
    }

    function setReturnZeroAsk(bool on) external {
        returnZeroAsk = on;
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

    /// @dev Test helper that simulates a seller fill. Proceeds stay in the market.
    function fillBid(uint256 id, uint256 quantity) external {
        Bid storage b = _bids[id];
        if (quantity == 0 || quantity > b.remaining) revert BadBid();
        b.remaining -= quantity;
        emit BidFilled(id, quantity, b.remaining);
    }

    /// @dev Test helper: seller fills the bid and the parts land in the buyer's ERC1155 balance,
    ///      which is what the official market does with safeTransferFrom. The mock mints them
    ///      (MockERC1155.mint is public); if the token cannot mint, it falls back to moving
    ///      whatever inventory this market holds.
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

    function placeAsk(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        returns (uint256 id)
    {
        if (transistors == address(0) || price == 0 || quantity == 0) revert BadAsk();
        IERC1155(transistors).safeTransferFrom(msg.sender, address(this), tokenId, quantity, "");
        if (returnZeroAsk) return 0;
        id = nextAskId++;
        _asks[id] = Ask({
            seller: msg.sender,
            transistors: transistors,
            price: price,
            tokenId: tokenId,
            remaining: quantity
        });
        emit AskPlaced(id, msg.sender, transistors, tokenId, price, quantity);
    }

    function cancelAsk(uint256 id) external {
        Ask storage a = _asks[id];
        if (a.seller != msg.sender || a.remaining == 0) revert NotSeller();
        uint256 qty = a.remaining;
        a.remaining = 0;
        emit AskCancelled(id, qty);
        IERC1155(a.transistors).safeTransferFrom(address(this), a.seller, a.tokenId, qty, "");
    }

    /// @dev Buyer pays price × quantity. Seller proceeds go to owed (official market style).
    function fillAsk(uint256 id, uint256 quantity) external payable {
        Ask storage a = _asks[id];
        if (quantity == 0 || quantity > a.remaining) revert BadAsk();
        uint256 pay = quantity * uint256(a.price);
        if (msg.value != pay) revert BadAsk();
        a.remaining -= quantity;
        _owed[a.seller] += pay;
        emit AskFilled(id, msg.sender, quantity, pay);
        IERC1155(a.transistors).safeTransferFrom(address(this), msg.sender, a.tokenId, quantity, "");
    }

    function asks(uint256 id)
        external
        view
        returns (
            address seller,
            uint96 price,
            address transistors,
            uint8 tokenId,
            uint256 remaining
        )
    {
        Ask storage a = _asks[id];
        return (a.seller, a.price, a.transistors, a.tokenId, a.remaining);
    }

    function owed(address account) external view returns (uint256) {
        return _owed[account];
    }

    /// @dev Test hook: credit `account` with proceeds this market already holds, so a Campaign can be
    ///      exercised against a settlement that only lands after pooling.
    function creditOwed(address account, uint256 amount) external payable {
        if (msg.value != amount) revert BadAsk();
        _owed[account] += amount;
    }

    /// @dev Test switch: makes withdraw() revert, so the Campaign's "drain before swapping" path can be
    ///      exercised against a market that owes BNB but cannot release it.
    bool public blockWithdraw;

    function setBlockWithdraw(bool on) external {
        blockWithdraw = on;
    }

    function withdraw() external {
        if (blockWithdraw) revert BadAsk();
        uint256 amount = _owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        _owed[msg.sender] = 0;
        emit ProceedsWithdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert BadAsk();
    }
}
