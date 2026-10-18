// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC1155 surface Campaign needs to return stuck NAND / LATCH to the owner.
interface IERC1155 {
    function balanceOf(address account, uint256 id) external view returns (uint256);

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}
