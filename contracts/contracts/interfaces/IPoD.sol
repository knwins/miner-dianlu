// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Mining interface used by Campaign.
///         Official PoD uses different start/claim arguments. OfficialPodAdapter exposes this
///         ABI and, when podUsesDelegatecall() is true, Campaign delegatecalls it so the
///         official caller stays the campaign. Official start still requires that caller to
///         own the circuit NFT. Holding ERC1155 transistors is not the check.
///         execute passes startData to start and stores the returned weight as hashpower.
interface IPoD {
    /// @notice Pull the currently claimable daily BEM to the caller (the Campaign). Returns wei.
    function claim() external returns (uint256);

    /// @notice execute passes startData. The return value is stored as this round's hashpower.
    ///         Campaign checks the netlist itself, via keccak256(tapeoutData), before this call.
    function start(bytes calldata startData) external returns (uint256 hashpower);
}
