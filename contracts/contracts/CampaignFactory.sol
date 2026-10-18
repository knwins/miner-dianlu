// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {Campaign} from "./Campaign.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title CampaignFactory — opens each crowdfunding round
/// @notice Only the factory owner may create a round, change default deps, or drop a round from the list.
///         Economic params are fixed after creation. pod / bem / minter are defaults for later rounds;
///         an existing Campaign is updated on that contract. minter stores the material market (placeBid),
///         not a minter. removeCampaign only edits this list and does not destroy the campaign.
contract CampaignFactory is Ownable {
    /// @dev New rounds read the current value. Existing rounds do not follow later changes.
    address public pod;
    IERC20 public bem;
    /// @notice Material-market address. The name stays minter. Campaign uses it as the placeBid target.
    address public minter;
    // Default network weights (on-chain read 2026-10-18: totalVerifWeight / totalUnverWeight).
    // dailyBem() is an estimate. harvest credits whatever PoD actually pays, so a stale snapshot cannot brick claims.
    // The round owner should still refresh these through updateNetworkWeight.
    uint256 public constant DEFAULT_NET_WEIGHT_VERIFIED = 1_579_178;
    uint256 public constant DEFAULT_NET_WEIGHT_UNVERIFIED = 40_680;

    address[] public campaigns;

    event CampaignCreated(
        uint256 indexed index,
        address indexed campaign,
        address feeRecipient,
        uint256 taskId,
        bytes32 netlistHash,
        uint256 sharePriceBnb,
        uint256 totalShares
    );
    /// @notice Removed from the factory registry only. The Campaign stays callable at its address.
    event CampaignRemoved(uint256 indexed index, address indexed campaign);
    event PodUpdated(address indexed previous, address indexed next);
    event BemUpdated(address indexed previous, address indexed next);
    event MinterUpdated(address indexed previous, address indexed next);

    error ZeroCampaignParam();
    error BadFee();
    error IndexOutOfBounds();
    error CampaignNotFound();

    constructor(address pod_, address bem_, address minter_) Ownable(msg.sender) {
        if (pod_ == address(0) || bem_ == address(0) || minter_ == address(0)) revert ZeroAddress();
        pod = pod_;
        bem = IERC20(bem_);
        minter = minter_;
    }

    /// @notice Replace the default PoD. Affects later createCampaign calls only. Existing rounds use Campaign.setPod.
    function setPod(address pod_) external onlyOwner {
        if (pod_ == address(0)) revert ZeroAddress();
        emit PodUpdated(pod, pod_);
        pod = pod_;
    }

    /// @notice Replace the default BEM. Affects later rounds only.
    function setBem(address bem_) external onlyOwner {
        if (bem_ == address(0)) revert ZeroAddress();
        emit BemUpdated(address(bem), bem_);
        bem = IERC20(bem_);
    }

    /// @notice Replace the default material market (official secondary-market placeBid). Minting has ended.
    function setMinter(address minter_) external onlyOwner {
        if (minter_ == address(0)) revert ZeroAddress();
        emit MinterUpdated(minter, minter_);
        minter = minter_;
    }

    /// @notice Create one round. Share price, supply, fee, deadline, task, and netlist hash are then immutable.
    ///         BEM and the material market are copied from the factory. The fee-share table is stored on the round
    ///         and the round owner may replace it later.
    /// @param feePercent Service fee percent, 1 to 20. Stored as feePercent × 100 bps.
    /// @param fundingDays Funding length in days. Deadline = block.timestamp + fundingDays × 1 days.
    /// @param feeRecipients Service-fee recipient list.
    /// @param feeShareBps Each recipient's share of the fee, in bps. Must sum to 10000. Dust goes to the owner.
    /// @param pod_ Mining contract. address(0) uses the factory default.
    /// @param transistors_ Official ERC1155 parts contract (TapeOut or Behemoth). Written into the new Campaign.
    function createCampaign(
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint16 feePercent,
        uint64 fundingDays,
        address[] calldata feeRecipients,
        uint16[] calldata feeShareBps,
        uint256 taskId,
        address pod_,
        bytes32 netlistHash,
        address transistors_
    ) external onlyOwner returns (address campaign) {
        if (feeRecipients.length == 0 || transistors_ == address(0)) revert ZeroAddress();
        if (totalShares == 0 || sharePriceBnb == 0) revert ZeroCampaignParam();
        if (feePercent < 1 || feePercent > 20) revert BadFee();

        address podAddr = pod_ == address(0) ? pod : pod_;

        Campaign c = new Campaign(
            sharePriceBnb,
            totalShares,
            feePercent * 100, // percent → bps
            uint64(block.timestamp) + fundingDays * 1 days,
            feeRecipients,
            feeShareBps,
            taskId,
            podAddr,
            address(bem),
            minter,
            netlistHash,
            owner, // Campaign owner = factory owner
            DEFAULT_NET_WEIGHT_VERIFIED,
            DEFAULT_NET_WEIGHT_UNVERIFIED,
            transistors_
        );
        campaign = address(c);
        campaigns.push(campaign);
        emit CampaignCreated(
            campaigns.length - 1,
            campaign,
            feeRecipients[0],
            taskId,
            netlistHash,
            sharePriceBnb,
            totalShares
        );
    }

    function campaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    function allCampaigns() external view returns (address[] memory) {
        return campaigns;
    }

    /// @notice Remove a round by index. Factory owner only.
    ///         Does not selfdestruct the Campaign. Holders can still use the original address.
    ///         Swap-and-pop: the last address may move into the removed index. Do not cache indexes.
    function removeCampaign(uint256 index) external onlyOwner {
        uint256 len = campaigns.length;
        if (index >= len) revert IndexOutOfBounds();
        address campaign = campaigns[index];
        uint256 last = len - 1;
        if (index != last) {
            campaigns[index] = campaigns[last];
        }
        campaigns.pop();
        emit CampaignRemoved(index, campaign);
    }

    /// @notice Remove a round by address (overload of removeCampaign(uint256)). Reverts if it is not in the list.
    function removeCampaign(address campaign) external onlyOwner {
        if (campaign == address(0)) revert ZeroAddress();
        uint256 len = campaigns.length;
        for (uint256 i = 0; i < len; i++) {
            if (campaigns[i] == campaign) {
                uint256 last = len - 1;
                if (i != last) {
                    campaigns[i] = campaigns[last];
                }
                campaigns.pop();
                emit CampaignRemoved(i, campaign);
                return;
            }
        }
        revert CampaignNotFound();
    }
}
