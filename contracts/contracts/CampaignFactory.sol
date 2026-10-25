// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {Campaign} from "./Campaign.sol";

/// @title CampaignFactory — opens each crowdfunding round
/// @notice Owner-only creation and registry removal. Economic params are fixed at creation; the shared
///         materialMarket is immutable (a round may replace its own via setMaterialMarket).
///         The parts contract is NOT fixed here: every round must name a whitelisted one, so one factory
///         serves several processors and carries no "default parts". The whitelist is a deploy-time
///         security boundary — an open choice would allow a mock that mints unlimited parts — and can
///         never be edited.
///         removeCampaign only edits the registry; the Campaign itself stays callable.
contract CampaignFactory is Ownable {
    /// @notice Shared material market (the placeBid target). Immutable.
    address public immutable materialMarket;

    /// @notice Parts contracts a round may lock; written once at construction and never editable.
    address[] private _allowedParts;

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
    /// @notice The parts contract is not whitelisted.
    error PartsNotAllowed(address parts);

    /// @param materialMarket_ Shared market; immutable. Rounds may replace it individually.
    /// @param allowedParts_ Whitelisted parts contracts; at least one, all with code.
    constructor(address materialMarket_, address[] memory allowedParts_) Ownable(msg.sender) {
        if (materialMarket_ == address(0)) revert ZeroAddress();
        // A codeless target would revert every market call with empty returndata, bricking every round.
        if (materialMarket_.code.length == 0) revert ZeroAddress();
        if (allowedParts_.length == 0) revert EmptyWhitelist();
        materialMarket = materialMarket_;
        for (uint256 i = 0; i < allowedParts_.length; i++) {
            if (allowedParts_[i] == address(0) || allowedParts_[i].code.length == 0) revert ZeroAddress();
            _allowedParts.push(allowedParts_[i]);
        }
    }

    /// @notice Number of whitelisted parts contracts.
    function allowedPartsCount() external view returns (uint256) {
        return _allowedParts.length;
    }

    /// @notice The index-th whitelisted parts contract.
    /// @param index Position in the whitelist.
    /// @return Parts contract at `index`; reverts when out of range.
    function allowedPartsAt(uint256 index) external view returns (address) {
        if (index >= _allowedParts.length) revert IndexOutOfBounds();
        return _allowedParts[index];
    }

    /// @notice True when `parts` is in the whitelist.
    /// @param parts Parts contract to test.
    /// @return Whether a round may lock that contract.
    function isAllowedParts(address parts) external view returns (bool) {
        return _isAllowed(parts);
    }

    /// @dev Linear scan; the whitelist is tiny and fixed.
    /// @param parts Parts contract to test.
    /// @return Whether `parts` is whitelisted.
    function _isAllowed(address parts) internal view returns (bool) {
        for (uint256 i = 0; i < _allowedParts.length; i++) {
            if (_allowedParts[i] == parts) return true;
        }
        return false;
    }

    /// @notice Create one round. Share price, supply and the parts contract are then immutable.
    ///         The market comes from the factory; the parts contract must be named explicitly (no default).
    /// @param sharePriceBnb Price of one share in wei; 0 reverts.
    /// @param totalShares Share cap and sell-out threshold; 0 reverts.
    /// @param fundingSeconds Funding length in seconds; deadline = block.timestamp + fundingSeconds.
    /// @param transistors_ Parts contract; required, non-zero and whitelisted.
    /// @return campaign Address of the new round.
    function createCampaign(
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint64 fundingSeconds,
        address transistors_
    ) external onlyOwner returns (address campaign) {
        // A factory default would lock every round to the same processor.
        if (transistors_ == address(0)) revert ZeroAddress();
        if (!_isAllowed(transistors_)) revert PartsNotAllowed(transistors_);
        if (totalShares == 0 || sharePriceBnb == 0) revert ZeroCampaignParam();

        address mi = materialMarket;
        address ow = owner;
        // Both operands fit in uint64, and the checked sum is validated before the narrowing cast.
        uint64 deadline = uint64(block.timestamp) + fundingSeconds;

        Campaign c = new Campaign(
            sharePriceBnb,
            totalShares,
            deadline,
            mi,
            ow, // Campaign owner = factory owner
            transistors_
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

    /// @notice True while `campaign` is registered; a retired round lets anyone reclaim a stuck order.
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
