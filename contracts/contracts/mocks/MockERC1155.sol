// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC1155 used to test Campaign recover / placeAsk flows.
contract MockERC1155 {
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    error Insufficient();
    error NotApproved();

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApproval[msg.sender][operator] = approved;
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApproval[account][operator];
    }

    function mint(address to, uint256 id, uint256 amount) external {
        _balances[id][to] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        if (msg.sender != from && !_operatorApproval[from][msg.sender]) revert NotApproved();
        uint256 bal = _balances[id][from];
        if (amount == 0 || amount > bal) revert Insufficient();
        _balances[id][from] = bal - amount;
        _balances[id][to] += amount;
    }
}
