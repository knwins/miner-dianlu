// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface the factory uses to deploy a round.
/// @dev Kept separate so CampaignFactory's runtime does not embed Campaign's creation code (24KB limit).
interface ICampaignDeployer {
    function deploy(
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint64 fundingDeadline,
        address circuitMarket,
        address owner,
        address circuits,
        address podMining,
        address bem,
        address factory
    ) external returns (address campaign);
}
