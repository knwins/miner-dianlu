// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {Campaign} from "./Campaign.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title CampaignFactory —— 开期工厂
/// @notice 仅 Factory Owner 可 createCampaign。参数写入后不可改（链上不可变）。
///         全局注入 PoD / BEM / 晶体管铸造器地址，每期可覆盖 pod 与观察期。
contract CampaignFactory is Ownable {
    address public immutable pod;
    IERC20 public immutable bem;
    address public immutable minter;
    uint64 public constant DEFAULT_EXECUTE_DELAY = 48 hours; // 默认观察期
    // 全网权重默认值（链上实读 2026-10-16），之后由各期 Owner 通过 oracle 更新
    uint256 public constant DEFAULT_NET_WEIGHT_VERIFIED = 1_575_427;
    uint256 public constant DEFAULT_NET_WEIGHT_UNVERIFIED = 40_823;

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

    error ZeroCampaignParam();
    error BadFee();

    constructor(address pod_, address bem_, address minter_) Ownable(msg.sender) {
        if (pod_ == address(0) || bem_ == address(0) || minter_ == address(0)) revert ZeroAddress();
        pod = pod_;
        bem = IERC20(bem_);
        minter = minter_;
    }

    /// @notice 创建一期。参数写入后不能改。
    /// @param sharePriceBnb 每份 BNB（wei）
    /// @param totalShares   总份数
    /// @param feePercent    服务费百分比（如 7 = 7% → 700 bps）
    /// @param fundingDays   募集天数
    /// @param feeRecipient  收费地址
    /// @param taskId        官方题目
    /// @param pod_          挖矿合约（传 0 用工厂默认）
    /// @param executeDelay  观察期秒数（传 0 用默认 48h）
    /// @param netlistHash   开期承诺的网表哈希
    function createCampaign(
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint16 feePercent,
        uint64 fundingDays,
        address feeRecipient,
        uint256 taskId,
        address pod_,
        uint64 executeDelay,
        bytes32 netlistHash
    ) external onlyOwner returns (address campaign) {
        if (feeRecipient == address(0)) revert ZeroAddress();
        if (totalShares == 0 || sharePriceBnb == 0) revert ZeroCampaignParam();
        if (feePercent < 1 || feePercent > 20) revert BadFee();

        address podAddr = pod_ == address(0) ? pod : pod_;
        uint64 delay = executeDelay == 0 ? DEFAULT_EXECUTE_DELAY : executeDelay;

        Campaign c = new Campaign(
            sharePriceBnb,
            totalShares,
            feePercent * 100, // % → bps
            uint64(block.timestamp) + fundingDays * 1 days,
            feeRecipient,
            taskId,
            podAddr,
            delay,
            address(bem),
            minter,
            netlistHash,
            owner, // Campaign Owner = Factory Owner
            DEFAULT_NET_WEIGHT_VERIFIED,
            DEFAULT_NET_WEIGHT_UNVERIFIED
        );
        campaign = address(c);
        campaigns.push(campaign);
        emit CampaignCreated(
            campaigns.length - 1, campaign, feeRecipient, taskId, netlistHash, sharePriceBnb, totalShares
        );
    }

    function campaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    function allCampaigns() external view returns (address[] memory) {
        return campaigns;
    }
}
