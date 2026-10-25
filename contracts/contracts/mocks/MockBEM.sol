// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal BEM ERC20 double for Campaign tests. Mint is open on purpose; test-only.
contract MockBem {
    string public name = "Mock BEM";
    string public symbol = "mBEM";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 amount);

    error MockOnMainnet();

    constructor() {
        if (block.chainid == 56) revert MockOnMainnet();
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) return false;
        unchecked {
            balanceOf[msg.sender] = bal - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
