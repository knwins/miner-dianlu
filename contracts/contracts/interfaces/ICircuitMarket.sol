// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Official TapeOut Circuit Market (BSC mainnet 0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f).
///
///         The market is an EIP-1967 UUPS proxy and exposes the SELL side only: every trade is one
///         circuit NFT per transaction, taken from a resting listing. There is no bid book, no partial
///         fill and no auto-matching. A buyer must pay exactly the listing price.
///
///         Present (verified on mainnet, 2026-10-25):
///           - list(address circuits, uint256 tokenId, uint96 price) returns (uint256 id)
///           - delist(uint256 id)
///           - buy(uint256 id, uint96 expectedPrice) payable  — msg.value must equal the listing price
///           - listingFor(address circuits, uint256 tokenId) -> (id, seller, price, valid)
///           - listingOf(address circuits, uint256 tokenId) -> id
///           - listings(uint256 id) -> (seller, circuits, price, feeBps, tokenId)
///           - feeBps(), nextListingId(), owed(address), withdraw()
///
///         Model consequences for Campaign:
///           1. There is NO custody: the seller keeps the NFT until `buy`, so a buyer must re-check
///              `ownerOf(tokenId) == seller` before paying.
///           2. Seller proceeds are pull-based: `buy` credits `owed[seller]`, and `withdraw()` sends the
///              BNB to the seller (which is why Campaign.receive accepts a known market only). The market
///              takes feeBps from the seller, not from the buyer.
///           3. Selling a circuit means `list` (per-token approval, never setApprovalForAll), then
///              `withdraw()` once somebody takes it.
interface ICircuitMarket {
    /// @notice List one circuit NFT for sale. The seller keeps custody and must approve this market.
    /// @param circuits Circuit NFT contract.
    /// @param tokenId Token to list.
    /// @param price Listing price in wei; must be > 0.
    /// @return id Market listing id.
    function list(address circuits, uint256 tokenId, uint96 price) external returns (uint256 id);

    /// @notice Cancel a listing. Only the seller may call it; the NFT never left the seller.
    /// @param id Listing id.
    function delist(uint256 id) external;

    /// @notice Take a listing. `msg.value` must equal `expectedPrice`, which must equal the live price.
    /// @param id Listing id.
    /// @param expectedPrice Exact price the caller agrees to pay (front-running guard).
    function buy(uint256 id, uint96 expectedPrice) external payable;

    /// @notice Live listing for one NFT.
    /// @param circuits Circuit NFT contract.
    /// @param tokenId Token to query.
    /// @return id Listing id; 0 when none.
    /// @return seller Listing seller.
    /// @return price Listing price in wei.
    /// @return valid Whether the listing can still be taken.
    function listingFor(address circuits, uint256 tokenId)
        external
        view
        returns (uint256 id, address seller, uint96 price, bool valid);

    /// @notice Listing id for one NFT (0 when none).
    /// @param circuits Circuit NFT contract.
    /// @param tokenId Token to query.
    /// @return id Listing id.
    function listingOf(address circuits, uint256 tokenId) external view returns (uint256 id);

    /// @notice Listing detail by id.
    /// @param id Listing id.
    /// @return seller Listing seller.
    /// @return circuits Circuit NFT contract.
    /// @return price Listing price in wei.
    /// @return feeBps Fee snapshot taken when the listing was created (charged to the seller).
    /// @return tokenId Listed token.
    function listings(uint256 id)
        external
        view
        returns (address seller, address circuits, uint96 price, uint16 feeBps, uint256 tokenId);

    /// @notice Current market fee in bps. Charged to the seller on a fill.
    /// @return Current fee.
    function feeBps() external view returns (uint16);

    /// @notice Seller proceeds that have not been withdrawn yet.
    /// @param account Seller to query.
    /// @return BNB withdrawable by `account`.
    function owed(address account) external view returns (uint256);

    /// @notice Pull the caller's accrued proceeds.
    function withdraw() external;
}
