// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMaterialMarket} from "../interfaces/IMaterialMarket.sol";

/// @notice Testnet stand-in with the official bid ABI.
///         placeBid escrows BNB. cancelBid refunds the unfilled part to the buyer.
///         fillBid only decreases remaining (simulates a seller fill).
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
    mapping(uint256 => Bid) private _bids;

    error BadBid();
    error NotBuyer();

    function placeBid(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        payable
        returns (uint256 id)
    {
        if (transistors == address(0) || price == 0 || quantity == 0) revert BadBid();
        if (msg.value != uint256(price) * quantity) revert BadBid();
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
}
