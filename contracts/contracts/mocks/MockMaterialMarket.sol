// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMaterialMarket} from "../interfaces/IMaterialMarket.sol";
import {IERC1155} from "../interfaces/IERC1155.sol";

/// @notice Testnet stand-in with the official bid + ask ABI.
///         placeBid escrows BNB. cancelBid refunds the unfilled part to the buyer.
///         fillBid only decreases remaining (simulates a seller fill; tests mint parts separately).
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

    /// @dev Test switch: when off, callers that need seller-side market calls (the OrderVault) see BadBid.
    bool public orderVault = true;

    function setOrderVault(bool on) external {
        orderVault = on;
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
    }

    function cancelBid(uint256 id) external {
        Bid storage b = _bids[id];
        if (b.buyer != msg.sender || b.remaining == 0) revert NotBuyer();
        uint256 refund = b.remaining * uint256(b.price);
        b.remaining = 0;
        (bool ok, ) = b.buyer.call{value: refund}("");
        if (!ok) revert BadBid();
    }

    /// @dev Test helper that simulates a seller fill. Proceeds stay in the market.
    function fillBid(uint256 id, uint256 quantity) external {
        Bid storage b = _bids[id];
        if (quantity == 0 || quantity > b.remaining) revert BadBid();
        b.remaining -= quantity;
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
    }

    function cancelAsk(uint256 id) external {
        Ask storage a = _asks[id];
        if (a.seller != msg.sender || a.remaining == 0) revert NotSeller();
        uint256 qty = a.remaining;
        a.remaining = 0;
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

    function withdraw() external {
        uint256 amount = _owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        _owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert BadAsk();
    }
}
