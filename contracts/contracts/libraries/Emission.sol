// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Emission（把前端 emission.js 的产出口径移植上链）
/// @dev 官网机制：「日产 = 池日产 × (我的权重 / 全池总权重)」。
///      - 已验证池分 99%，未验证池分 1%（被挖矿闸门拦住的只能进未验证池）。
///      - 全网权重会持续变化，故 networkWeight 由 owner 通过 oracle 更新，不写死。
library Emission {
    uint256 internal constant NETWORK_DAILY_EMISSION = 7200; // 全网理论日产 BEM（第 1 纪元）
    uint256 internal constant BPS = 10_000; // 基点分母
    uint256 internal constant WAD = 1e18; // BEM 18 位小数

    // 池分成（基点）：verified 99% / unverified 1%
    uint16 internal constant VERIFIED_SHARE_BPS = 9_900;
    uint16 internal constant UNVERIFIED_SHARE_BPS = 100;

    /// @notice 某权重的日产 BEM（wei）。零和：权重涨、所有人日产同步降。
    /// @param hashpower 本矿机权重 H
    /// @param capped 是否被挖矿闸门拦住（true → 未验证池，只分 1%）
    /// @param networkWeightVerified 当前已验证池全网权重
    /// @param networkWeightUnverified 当前未验证池全网权重
    function dailyBem(
        uint256 hashpower,
        bool capped,
        uint256 networkWeightVerified,
        uint256 networkWeightUnverified
    ) internal pure returns (uint256) {
        if (hashpower == 0) return 0;
        uint16 shareBps = capped ? UNVERIFIED_SHARE_BPS : VERIFIED_SHARE_BPS;
        uint256 netWeight = capped ? networkWeightUnverified : networkWeightVerified;
        if (netWeight == 0) return 0;
        // dailyWei = H × 日产 × 池分成 / 全网权重
        return (hashpower * NETWORK_DAILY_EMISSION * WAD * shareBps) / (BPS * netWeight);
    }
}
