// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "./Campaign.sol";
import {ICampaignDeployer} from "./interfaces/ICampaignDeployer.sol";

/// @title CampaignDeployer — deploys one Campaign at a time for the factory
/// @notice Campaign's creation code alone is close to the 24KB contract-size limit, and the factory used to
///         embed it. Keeping the creation code in this stateless deployer lets CampaignFactory stay tiny
///         (and deployable) while every round is still created atomically and registered by the factory.
/// @dev No access control: deploying an unregistered round costs the caller gas and confers no protocol
///      privilege. The Campaign records the factory address passed here, so the factory it reports to is
///      always the one that requested the deployment.
contract CampaignDeployer is ICampaignDeployer {
    event CampaignDeployed(address indexed campaign, address indexed factory);

    /// @inheritdoc ICampaignDeployer
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
    ) external returns (address campaign) {
        campaign = address(
            new Campaign(
                sharePriceBnb,
                totalShares,
                fundingDeadline,
                circuitMarket,
                owner,
                circuits,
                podMining,
                bem,
                factory
            )
        );
        emit CampaignDeployed(campaign, factory);
    }
}
