// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice tapeout.net transistor-market interface (mainnet 0xA6a80C1919a8326022d7c601a488888C13aA16E4).
///
///         ABI verified by mainnet eth_call (2026-08, scripts/probe-market-surface.mjs / probe-market-bid.mjs).
///         The market is an EIP-1967 proxy and exposes the BUY side only.
///
///         Present:
///           - placeBid(address,uint8,uint96,uint256) payable returns (uint256 id)
///             msg.value must equal price × quantity exactly; anything else reverts "wrong value".
///           - bids(uint256) → (buyer, transistors, price, tokenId, feeBps, remaining)
///           - cancelBid(uint256), nextBidId(), feeBps(), owed(address), withdraw()
///           - fillBid(uint256,uint256) = fillBid(bidId, qty), called by a seller holding the parts;
///             the market then transfers the ERC1155 parts to the buyer (this Campaign). Campaign never
///             calls fillBid — it only receives the parts via onERC1155Received / BatchReceived.
///
///         Absent (swallowed by the proxy fallback → missing revert data):
///           placeAsk / asks / nextAskId / cancelAsk / fillAsk
///
///         Mainnet consequences:
///         1. feeBps = 100 (1%) is deducted from the seller's proceeds, not added to the buyer's escrow:
///            the buyer pays price × quantity and the seller receives 99%. Campaign's priceLock =
///            qty × price therefore matches the escrow exactly.
///         2. With no ask book, placeTransistorAsk / cancelTransistorAsk / confirmSale always revert on
///            mainnet (no such selector). They are secondary "sell parts back" paths and do not affect
///            the main flow placeBid → seller fillBid → parts arrive → depositToPool. _askOpen() short-
///            circuits on askQty == 0 and never calls market.asks(), so mainnet does not revert here.
///         3. Cancellation and settlement proceeds return via receive() (or owed() + withdraw()), which
///            is why receive() only accepts a known market (see Campaign._isKnownMarket).
interface IMaterialMarket {
    /// @notice Place a buy order; msg.value must equal price × quantity exactly.
    /// @param transistors Parts contract the bid targets.
    /// @param tokenId Part id (0 NAND, 1 LATCH).
    /// @param price Bid price in wei per unit.
    /// @param quantity Units to bid for; must be > 0.
    /// @return id Market bid id.
    function placeBid(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        payable
        returns (uint256 id);

    /// @notice Cancel a bid; the unfilled escrow is refunded to the buyer.
    /// @param id Market bid id.
    function cancelBid(uint256 id) external;

    /// @notice Bid detail. Campaign reads `remaining` only.
    /// @param id Market bid id.
    /// @return buyer Bid owner.
    /// @return transistors Parts contract the bid targets.
    /// @return price Bid price in wei per unit.
    /// @return tokenId Part id.
    /// @return feeBps Market fee in bps, charged to the seller.
    /// @return remaining Unfilled quantity.
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

    /// @notice List parts for sale; the market pulls them from the seller.
    /// @dev Absent on mainnet (buy side only), so Campaign's ask path reverts there.
    /// @param transistors Parts contract being sold.
    /// @param tokenId Part id (0 NAND, 1 LATCH).
    /// @param price Ask price in wei per unit.
    /// @param quantity Units to list; must be > 0.
    /// @return id Market ask id.
    function placeAsk(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        returns (uint256 id);

    /// @notice Cancel an ask; the unsold parts return to the seller.
    /// @dev Absent on mainnet.
    /// @param id Market ask id.
    function cancelAsk(uint256 id) external;

    /// @notice Ask detail. Campaign reads `remaining` only.
    /// @dev Absent on mainnet.
    /// @param id Market ask id.
    /// @return seller Ask owner.
    /// @return price Ask price in wei per unit.
    /// @return transistors Parts contract being sold.
    /// @return tokenId Part id.
    /// @return remaining Unsold quantity.
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

    /// @notice Proceeds accrued to `account` that have not been withdrawn yet.
    /// @param account Seller whose proceeds are queried.
    /// @return BNB withdrawable by `account`.
    function owed(address account) external view returns (uint256);

    /// @notice Pull the caller's accrued proceeds.
    function withdraw() external;
}
