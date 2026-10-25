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
///             the market pulls the ERC1155 parts from the seller, sends them to the bid's buyer and
///             credits price × qty minus feeBps to owed(seller). This is the ONLY sell path: Campaign
///             calls it from sellTransistors() and then withdraw()s the proceeds.
///
///         Absent (swallowed by the proxy fallback → missing revert data):
///           placeAsk / asks / nextAskId / cancelAsk / fillAsk
///         There is no ask book at all, so a seller can never list; it can only take a resting bid.
///
///         Mainnet consequences:
///         1. feeBps = 100 (1%) is deducted from the seller's proceeds, not added to the buyer's escrow:
///            the buyer pays price × quantity and the seller receives 99%. Campaign's priceLock =
///            qty × price therefore matches the escrow exactly.
///         2. Because there is no ask book, Campaign must not expose any place-ask call (it used to);
///            selling is sellTransistors → fillBid → withdraw.
///         3. Cancellation and sale proceeds return via receive() (or owed() + withdraw()), which
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

    /// @notice Fill a resting bid as the seller: pulls `quantity` parts from the caller, sends them to
    ///         the bid's buyer and credits the net proceeds to owed(caller).
    /// @param id Market bid id.
    /// @param quantity Units to sell; must be > 0 and <= the bid's remaining.
    function fillBid(uint256 id, uint256 quantity) external;

    /// @notice Bid detail. Campaign reads the buyer, parts contract, price, token id and remaining.
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

    /// @notice Proceeds accrued to `account` that have not been withdrawn yet.
    /// @param account Seller whose proceeds are queried.
    /// @return BNB withdrawable by `account`.
    function owed(address account) external view returns (uint256);

    /// @notice Pull the caller's accrued proceeds.
    function withdraw() external;
}
