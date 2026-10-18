// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";
import {IOfficialPoD} from "../interfaces/IOfficialPoD.sol";

/// @notice Official PoD stand-in for tests. start allows only addresses marked as the circuit owner.
///         transistorBalance is recorded and ignored, matching the mainnet holder check.
contract MockOfficialPoD is IOfficialPoD {
    IERC20 public immutable bem;
    address public lastCaller;
    uint256 public claimAmount;
    uint256 public burn = 3;
    uint256 public multiplier = 1;

    mapping(address => bool) public circuitOwner;
    mapping(address => uint256) public transistorBalance;

    error Ownr();

    constructor(IERC20 bem_) {
        bem = bem_;
    }

    function setCircuitOwner(address account, bool allowed) external {
        circuitOwner[account] = allowed;
    }

    function setTransistorBalance(address account, uint256 amount) external {
        transistorBalance[account] = amount;
    }

    function setClaimAmount(uint256 amount) external {
        claimAmount = amount;
    }

    function start(
        address,
        uint256 circuitId,
        uint32,
        uint256,
        bytes[] calldata,
        bytes[] calldata,
        bytes32[][] calldata,
        bytes32
    ) external returns (bytes32 key) {
        if (!circuitOwner[msg.sender]) revert Ownr();
        lastCaller = msg.sender;
        return keccak256(abi.encode(msg.sender, circuitId));
    }

    function claim(bytes32) external returns (uint256 amount) {
        lastCaller = msg.sender;
        amount = claimAmount;
        if (amount == 0) return 0;
        claimAmount = 0;
        bem.transfer(msg.sender, amount);
    }

    function circuitBurn(address, uint256) external view returns (uint256) {
        return burn;
    }

    function processorMultiplier(address) external view returns (uint256) {
        return multiplier;
    }
}
