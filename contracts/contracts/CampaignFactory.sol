// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {Campaign} from "./Campaign.sol";

/// @title CampaignFactory — opens each crowdfunding round
/// @notice Only the factory owner may create a round or drop one from the list. Economic params are
///         fixed at creation. The shared material-market address (materialMarket) is immutable; a
///         replacement market is set per round via Campaign.setMaterialMarket.
///         The parts contract (processor) is NOT fixed here: each round MUST name it explicitly at
///         createCampaign time, so one factory can open rounds for any whitelisted processor
///         (TapeOut / Behemoth) and carries no "default parts".
///         Allowed parts are a deploy-time security boundary, not an operational switch: the official
///         market circulates the parts of several processors, each a separate ERC1155 contract. Without
///         the whitelist the owner could point a round at a permissionless mock (anyone can mint
///         unlimited parts), which would make the "parts arrived" checks meaningless. The whitelist is
///         written at construction and can never be edited afterwards.
///         removeCampaign only edits the registry list; the Campaign itself stays callable.
contract CampaignFactory is Ownable {
    /// @notice Material-market address (the placeBid target). Immutable.
    address public immutable materialMarket;

    /// @notice Whitelist of parts contracts a round may lock. Written at construction and never
    ///         editable afterwards (security boundary, not an operational switch).
    address[] private _allowedParts;

    address[] public campaigns;

    /// @notice O(1) membership set. Mirrors `campaigns[]` for registry lookups so that
    ///         `isRegistered` (and thus Campaign._retired / the third-party escape hatch in
    ///         cancelTransistorOrder) stays constant-gas instead of scanning the array.
    ///         Set true on createCampaign, cleared on removeCampaign.
    mapping(address campaign => bool) private _registered;

    event CampaignCreated(
        uint256 indexed index,
        address indexed campaign,
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint64 fundingDeadline
    );
    /// @notice Removed from the factory registry only. The Campaign stays callable at its address.
    event CampaignRemoved(uint256 indexed index, address indexed campaign);

    error ZeroCampaignParam();
    error IndexOutOfBounds();
    /// @notice The whitelist (allowedParts_) was empty at construction.
    error EmptyWhitelist();
    /// @notice The parts contract requested for the round is not in the factory's whitelist.
    error PartsNotAllowed(address parts);

    /// @param materialMarket_ Material market. Immutable: a replacement market is set per round via Campaign.setMaterialMarket.
    /// @param allowedParts_ Whitelist of parts contracts a round may lock. Must contain at least one
    ///        official processor part. On mainnet this is the two official processor part contracts
    ///        (TapeOut / Behemoth). On testnets it is the mock parts contract.
    constructor(address materialMarket_, address[] memory allowedParts_) Ownable(msg.sender) {
        if (materialMarket_ == address(0)) revert ZeroAddress();
        // A codeless market or parts contract would make every external call revert with empty
        // returndata, bricking cancels / refunds for every round. Reject it at deploy time.
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

    /// @notice The index-th whitelisted parts contract. Feeds the frontend's processor picker.
    /// @param index Position in the whitelist.
    /// @return Parts contract at `index`; reverts IndexOutOfBounds when out of range.
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

    /// @dev Linear scan of the whitelist; it is written once at construction and is tiny.
    /// @param parts Parts contract to test.
    /// @return Whether `parts` is whitelisted.
    function _isAllowed(address parts) internal view returns (bool) {
        for (uint256 i = 0; i < _allowedParts.length; i++) {
            if (_allowedParts[i] == parts) return true;
        }
        return false;
    }

    /// @notice Create one round. Share price, supply, and the parts contract are then immutable.
    ///         The material market comes from the factory's immutable; the parts contract MUST be named
    ///         explicitly here — there is no factory default. The round owner may replace the material
    ///         market later via Campaign.setMaterialMarket.
    /// @param sharePriceBnb Price of one share in wei; 0 reverts ZeroCampaignParam.
    /// @param totalShares Share cap and sell-out threshold; 0 reverts ZeroCampaignParam.
    /// @param fundingSeconds Funding length in seconds; deadline = block.timestamp + fundingSeconds.
    ///        Seconds, not days: the deadline is packed into uint64 at creation, so the caller does the
    ///        unit conversion and no `× 1 days` can overflow before the narrowing cast.
    /// @param transistors_ Parts contract (processor). REQUIRED: address(0) reverts (no factory default)
    ///        and it must be in the whitelist. On mainnet that is the TapeOut / Behemoth parts contract.
    /// @return campaign Address of the newly deployed round.
    function createCampaign(
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint64 fundingSeconds,
        address transistors_
    ) external onlyOwner returns (address campaign) {
        // The parts contract (processor) is required: no factory default, otherwise every round would
        // be locked to the same processor.
        if (transistors_ == address(0)) revert ZeroAddress();
        if (!_isAllowed(transistors_)) revert PartsNotAllowed(transistors_);
        if (totalShares == 0 || sharePriceBnb == 0) revert ZeroCampaignParam();

        address mi = materialMarket;
        address ow = owner;
        // Explicit uint64 arithmetic: both operands already fit, and the sum is checked before packing.
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

    /// @notice True while `campaign` is in the registry. A retired Campaign lets anyone reclaim a stuck order.
    ///         O(1): membership is tracked in `_registered`, so gas does not grow with the number of campaigns.
    /// @param campaign Round to look up.
    /// @return Whether the round is still registered.
    function isRegistered(address campaign) external view returns (bool) {
        return _registered[campaign];
    }

    /// @notice Remove a round by index. Factory owner only.
    ///         Does not selfdestruct the Campaign. Holders can still use the original address.
    ///         Swap-and-pop: the last address may move into the removed index. Do not cache indexes —
    ///         look a campaign up by scanning campaigns(0..campaignCount()), not by a stored index.
    /// @param index Position in `campaigns`; reverts IndexOutOfBounds when out of range.
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
