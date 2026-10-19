// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice tapeout.net material-market interface (mainnet 0xA6a80C1919a8326022d7c601a488888C13aA16E4).
///         Bids: buyer escrows price × quantity in BNB; a seller fillBid; cancelBid reclaims the unfilled part.
///         Asks: seller lists ERC1155 parts; a buyer fillAsk pays BNB; cancelAsk returns unsold parts.
///         Fill status is remaining on bids(id) / asks(id). Proceeds may land via direct send or owed + withdraw.
interface IMaterialMarket {
    /// @dev Not part of the official ABI: only a market that acts for the message sender implements it.
    ///      Lets the OrderVault place and withdraw on behalf of its campaign, so ask proceeds go straight there.
    function orderVault() external view returns (bool);

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

    function placeAsk(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        returns (uint256 id);

    function cancelAsk(uint256 id) external;

    function asks(uint256 id)
        external
        view
        returns (
            address seller,
            uint96 price,
            address transistors,
            uint8 tokenId,
            uint256 remaining
        );

    function owed(address account) external view returns (uint256);

    function withdraw() external;
}
