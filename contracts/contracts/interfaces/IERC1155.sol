// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC1155 surface Campaign needs for parts: balances, market approval, and rescue transfers.
interface IERC1155 {
    function balanceOf(address account, uint256 id) external view returns (uint256);

    function setApprovalForAll(address operator, bool approved) external;

    function isApprovedForAll(address account, address operator) external view returns (bool);

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}
