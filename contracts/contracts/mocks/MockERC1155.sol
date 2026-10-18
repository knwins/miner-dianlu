// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC1155 used to test Campaign.recoverTransistors.
contract MockERC1155 {
    mapping(uint256 => mapping(address => uint256)) private _balances;

    error Insufficient();

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function mint(address to, uint256 id, uint256 amount) external {
        _balances[id][to] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        if (msg.sender != from) revert Insufficient();
        uint256 bal = _balances[id][from];
        if (amount == 0 || amount > bal) revert Insufficient();
        _balances[id][from] = bal - amount;
        _balances[id][to] += amount;
    }
}
