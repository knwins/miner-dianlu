// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC1155 surface Campaign needs for parts: balances, market approval, and rescue transfers.
interface IERC1155 {
    /// @param account Balance owner.
    /// @param id Token id (0 NAND, 1 LATCH for the round's parts).
    /// @return Units of `id` held by `account`.
    function balanceOf(address account, uint256 id) external view returns (uint256);

    /// @param operator Address allowed to move the caller's tokens (the market).
    /// @param approved Whether the approval is granted.
    function setApprovalForAll(address operator, bool approved) external;

    /// @param account Approval owner.
    /// @param operator Approved address.
    /// @return Whether `operator` may move `account`'s tokens.
    function isApprovedForAll(address account, address operator) external view returns (bool);

    /// @param from Current owner.
    /// @param to Recipient; its onERC1155Received hook must accept.
    /// @param id Token id.
    /// @param amount Units to move.
    /// @param data Forwarded to the receiver hook.
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;

    /// @notice Batch transfer; used when the market delivers NAND + LATCH in one call.
    /// @param from Current owner.
    /// @param to Recipient; its onERC1155BatchReceived hook must accept.
    /// @param ids Token ids.
    /// @param amounts Units per id; must be the same length as `ids`.
    /// @param data Forwarded to the receiver hook.
    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external;
}
