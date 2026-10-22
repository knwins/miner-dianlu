// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {Campaign} from "./Campaign.sol";

/// @title CampaignFactory — opens each crowdfunding round
/// @notice Only the factory owner may create a round or drop a round from the list.
///         Economic params are fixed after creation. The shared material-market address
///         (materialMarket, the placeBid target) is immutable; a replacement market is set
///         per round via Campaign.setMaterialMarket. The parts contract (processor) is NOT
///         fixed here — each round MUST name it explicitly at createCampaign time, so the
///         factory carries no "default parts" and a single factory can open rounds for any
///         whitelisted processor (TapeOut / Behemoth). removeCampaign only edits this list
///         and does not destroy the campaign.
///         NOTE: tape-out (流片) and PoD mining have been removed, so the factory no longer carries
///         pod / bem / netlist / fee-share defaults.
///
///         ── 元件白名单（多处理器支持）──
///         官方材料市场同一个合约上流通着**多个处理器**的元件（主网官方两件套：
///         TapeOut / Behemoth，各自有独立的 ERC1155 元件合约）。
///         每一期锁定一个元件合约（Campaign.transistors 是 immutable），但**由开期时显式选择**，
///         工厂不预设默认——否则所有期次会被锁定到同一个处理器。
///         工厂只知道「哪些元件合约是允许的」：owner 若能把期次指向任意 ERC1155，
///         主网上就意味着期次可能买到 MockERC1155（mint 无访问控制，任何人能无限造元件），
///         「元件已到账」的检查会形同虚设。
///         白名单在**部署时**写入（构造参数），owner 之后不能增删：
///         白名单是安全边界，不是一个运营开关。
contract CampaignFactory is Ownable {
    /// @notice Material-market address (the placeBid target). Immutable.
    address public immutable materialMarket;

    /// @notice 允许的元件合约白名单。createCampaign 传入的元件地址必须落在里面。
    ///         部署时写入，之后不可增删（安全边界，不是运营开关）。
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
        if (allowedParts_.length == 0) revert EmptyWhitelist();
        materialMarket = materialMarket_;
        for (uint256 i = 0; i < allowedParts_.length; i++) {
            if (allowedParts_[i] == address(0)) revert ZeroAddress();
            _allowedParts.push(allowedParts_[i]);
        }
    }

    /// @notice 白名单里的元件合约数量。
    function allowedPartsCount() external view returns (uint256) {
        return _allowedParts.length;
    }

    /// @notice 白名单里的第 index 个元件合约。供前端渲染「本期用哪个处理器」的选项。
    function allowedPartsAt(uint256 index) external view returns (address) {
        if (index >= _allowedParts.length) revert IndexOutOfBounds();
        return _allowedParts[index];
    }

    /// @notice 该元件合约是否在白名单里。
    function isAllowedParts(address parts) external view returns (bool) {
        return _isAllowed(parts);
    }

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
    /// @param fundingSeconds Funding length in seconds. Deadline = block.timestamp + fundingSeconds.
    ///        Seconds, not days: the deadline is packed into uint64 at creation, so the caller does the
    ///        unit conversion and no `× 1 days` can overflow before the narrowing cast.
    /// @param transistors_ 元件合约（处理器）。**必选**，零地址一律 revert（工厂不再有默认元件），
    ///        且必须在白名单内。主网上即 TapeOut / Behemoth 各自的元件合约。
    function createCampaign(
        uint256 sharePriceBnb,
        uint256 totalShares,
        uint64 fundingSeconds,
        address transistors_
    ) external onlyOwner returns (address campaign) {
        // 元件合约（处理器）必选：工厂不再有「默认元件」，否则所有期次被锁定到同一处理器。
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

    function campaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    /// @notice True while `campaign` is in the registry. A retired Campaign lets anyone reclaim a stuck order.
    ///         O(1): membership is tracked in `_registered`, so gas no longer grows with the number of campaigns.
    function isRegistered(address campaign) external view returns (bool) {
        return _registered[campaign];
    }

    /// @notice Remove a round by index. Factory owner only.
    ///         Does not selfdestruct the Campaign. Holders can still use the original address.
    ///         Swap-and-pop: the last address may move into the removed index. Do not cache indexes —
    ///         look a campaign up by scanning campaigns(0..campaignCount()), not by a stored index.
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
