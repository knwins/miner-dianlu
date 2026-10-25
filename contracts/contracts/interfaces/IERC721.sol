// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC721 surface Campaign needs for circuit NFTs.
/// @dev The official Circuit Market moves the token with `transferFrom`, not `safeTransferFrom`, so the
///      round never has to implement IERC721Receiver. `approve` is per token (never setApprovalForAll).
interface IERC721 {
    /// @param owner Token owner query.
    /// @return Balance of `owner`.
    function balanceOf(address owner) external view returns (uint256);

    /// @param tokenId Token to query.
    /// @return owner Current owner; reverts for a non-existent token.
    function ownerOf(uint256 tokenId) external view returns (address owner);

    /// @notice Approve one token. `address(0)` clears the approval.
    /// @param to Approved address.
    /// @param tokenId Token to approve.
    function approve(address to, uint256 tokenId) external;

    /// @param tokenId Token to query.
    /// @return operator Currently approved address.
    function getApproved(uint256 tokenId) external view returns (address operator);

    /// @param from Current owner.
    /// @param to Recipient.
    /// @param tokenId Token to move.
    function transferFrom(address from, address to, uint256 tokenId) external;

    /// @param interfaceId ERC165 id.
    /// @return Whether the token claims `interfaceId`.
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
