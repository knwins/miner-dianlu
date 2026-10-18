// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice tapeout.net material-market bid interface (mainnet 0xA6a80C1919a8326022d7c601a488888C13aA16E4).
///         The buyer escrows price × quantity in BNB. A seller calls fillBid. The buyer calls cancelBid
///         to reclaim the unfilled part. Fill status is bids(id).remaining, not a website confirmation.
interface IMaterialMarket {
    function placeBid(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        payable
        returns (uint256 id);

    function cancelBid(uint256 id) external;

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
        );
}
