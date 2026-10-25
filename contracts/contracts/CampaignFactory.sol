// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {Campaign} from "./Campaign.sol";

/// @title CampaignFactory — opens each crowdfunding round
/// @notice Owner-only creation and registry removal. Economic params are fixed at creation; the shared
///         circuitMarket is immutable (a round may replace its own via setCircuitMarket).
///         The circuit NFT collection is NOT fixed here: every round must name a whitelisted one, so one
///         factory serves several processors and carries no "default circuit". The whitelist is a
///         deploy-time security boundary — an open choice would allow a mock that mints unlimited circuits
///         — and can never be edited.
///         removeCampaign only edits the registry; the Campaign itself stays callable.
contract CampaignFactory is Ownable {
    /// @notice Shared Circuit Market (the list / buy target). Immutable.
    address public immutable circuitMarket;

    /// @notice Circuit NFT collections a round may lock; written once at construction and never editable.
    address[] private _allowedCircuits;

    address[] public campaigns;

    /// @notice O(1) membership set mirroring `campaigns[]`, so isRegistered stays constant-gas.
    mapping(address campaign => bool) private _registered;

    event CampaignCreated(
        uint256 indexed index,
        address indexed campaign,
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint64 fundingDeadline
    );
    /// @notice Removed from the registry only; the Campaign stays callable.
    event CampaignRemoved(uint256 indexed index, address indexed campaign);

    error ZeroCampaignParam();
    error IndexOutOfBounds();
    /// @notice The whitelist was empty at construction.
    error EmptyWhitelist();
    /// @notice The circuit collection is not whitelisted.
    error CircuitsNotAllowed(address circuits);

    /// @param circuitMarket_ Shared market; immutable. Rounds may replace it individually.
    /// @param allowedCircuits_ Whitelisted circuit NFT contracts; at least one, all with code.
    constructor(address circuitMarket_, address[] memory allowedCircuits_) Ownable(msg.sender) {
        if (circuitMarket_ == address(0)) revert ZeroAddress();
        // A codeless target would revert every market call with empty returndata, bricking every round.
        if (circuitMarket_.code.length == 0) revert ZeroAddress();
        if (allowedCircuits_.length == 0) revert EmptyWhitelist();
        circuitMarket = circuitMarket_;
        for (uint256 i = 0; i < allowedCircuits_.length; i++) {
            if (allowedCircuits_[i] == address(0) || allowedCircuits_[i].code.length == 0) revert ZeroAddress();
            _allowedCircuits.push(allowedCircuits_[i]);
        }
    }

    /// @notice Number of whitelisted circuit collections.
    function allowedCircuitsCount() external view returns (uint256) {
        return _allowedCircuits.length;
    }

    /// @notice The index-th whitelisted circuit collection.
    /// @param index Position in the whitelist.
    /// @return Circuit NFT contract at `index`; reverts when out of range.
    function allowedCircuitsAt(uint256 index) external view returns (address) {
        if (index >= _allowedCircuits.length) revert IndexOutOfBounds();
        return _allowedCircuits[index];
    }

    /// @notice True when `circuits` is in the whitelist.
    /// @param circuits Circuit NFT contract to test.
    /// @return Whether a round may lock that contract.
    function isAllowedCircuits(address circuits) external view returns (bool) {
        return _isAllowed(circuits);
    }

    /// @dev Linear scan; the whitelist is tiny and fixed.
    /// @param circuits Circuit NFT contract to test.
    /// @return Whether `circuits` is whitelisted.
    function _isAllowed(address circuits) internal view returns (bool) {
        for (uint256 i = 0; i < _allowedCircuits.length; i++) {
            if (_allowedCircuits[i] == circuits) return true;
        }
        return false;
    }

    /// @notice Create one round. Share price, supply and the circuit collection are then immutable.
    ///         The market comes from the factory; the circuit collection must be named explicitly (no
    ///         default).
    /// @param sharePriceBnb Price of one share in wei; 0 reverts.
    /// @param totalShares Share cap and sell-out threshold; 0 reverts.
    /// @param fundingSeconds Funding length in seconds; deadline = block.timestamp + fundingSeconds.
    /// @param circuits_ Circuit NFT collection; required, non-zero and whitelisted.
    /// @return campaign Address of the new round.
    function createCampaign(
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint64 fundingSeconds,
        address circuits_
    ) external onlyOwner returns (address campaign) {
        // A factory default would lock every round to the same processor.
        if (circuits_ == address(0)) revert ZeroAddress();
        if (!_isAllowed(circuits_)) revert CircuitsNotAllowed(circuits_);
        if (totalShares == 0 || sharePriceBnb == 0) revert ZeroCampaignParam();

        address mi = circuitMarket;
        address ow = owner;
        // Both operands fit in uint64, and the checked sum is validated before the narrowing cast.
        uint64 deadline = uint64(block.timestamp) + fundingSeconds;

        Campaign c = new Campaign(
            sharePriceBnb,
            totalShares,
            deadline,
            mi,
            ow, // Campaign owner = factory owner
            circuits_
        );
        campaign = address(c);
        _registered[campaign] = true;
        uint256 index = campaigns.length;
        campaigns.push(campaign);
        emit CampaignCreated(index, campaign, sharePriceBnb, totalShares, deadline);
    }

    /// @notice Number of rounds in the registry; indexes run 0..campaignCount()-1.
    function campaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    /// @notice True while `campaign` is registered; a retired round lets anyone clean up its listings.
    /// @param campaign Round to look up.
    /// @return Whether the round is still registered.
    function isRegistered(address campaign) external view returns (bool) {
        return _registered[campaign];
    }

    /// @notice Remove a round by index. Factory owner only; the Campaign stays callable for holders.
    ///         Swap-and-pop moves the last address into the removed index, so never cache indexes —
    ///         scan campaigns(0..campaignCount()).
    /// @param index Position in `campaigns`; reverts when out of range.
    function removeCampaign(uint256 index) external onlyOwner {
        uint256 len = campaigns.length;
        if (index >= len) revert IndexOutOfBounds();
        address campaign = campaigns[index];
        _registered[campaign] = false;
        address lastAddr = campaigns[len - 1];
        if (index != len - 1) {
            campaigns[index] = lastAddr;
        }
        campaigns.pop();
        emit CampaignRemoved(index, campaign);
    }
}
