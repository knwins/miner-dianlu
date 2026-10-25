// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Ownable — minimal, no external dependency
/// @notice Single owner, transferable. The factory owner is also each Campaign's owner, holding its
///         ordering, config and escape-hatch privileges.
abstract contract Ownable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner(address caller);
    error ZeroAddress();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @notice Hand ownership to another address.
    /// @param newOwner Next owner; must be non-zero.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
