// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Official TapeOut PoD surface used by OfficialPodAdapter.
///         start reverts Ownr() unless msg.sender is the circuit NFT owner.
///         It does not read the caller's ERC1155 transistor balance.
interface IOfficialPoD {
    function start(
        address cpu,
        uint256 circuitId,
        uint32 taskId,
        uint256 anchor,
        bytes[] calldata circuits,
        bytes[] calldata proofs,
        bytes32[][] calldata pubs,
        bytes32 salt
    ) external returns (bytes32 key);

    function claim(bytes32 key) external returns (uint256 amount);

    /// @notice Transistors already burned into this circuit. Not the caller's current balance.
    function circuitBurn(address cpu, uint256 circuitId) external view returns (uint256);

    /// @notice Processor multiplier P. TapeOut is 1, Behemoth is 6.
    function processorMultiplier(address cpu) external view returns (uint256);
}
