// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Emission — on-chain port of the frontend emission formula
/// @dev Site rule: daily = pool daily × (my weight / pool weight).
///      - Verified pool takes 99%. Unverified pool takes 1% (gated miners only).
///      - Network weight keeps moving, so the owner updates it through an oracle. It is not hardcoded.
library Emission {
    uint256 internal constant NETWORK_DAILY_EMISSION = 7200; // theoretical network daily BEM (epoch 1)
    uint256 internal constant BPS = 10_000; // basis-point denominator
    uint256 internal constant WAD = 1e18; // BEM decimals

    // Pool split (bps): verified 99% / unverified 1%
    uint16 internal constant VERIFIED_SHARE_BPS = 9_900;
    uint16 internal constant UNVERIFIED_SHARE_BPS = 100;

    /// @notice Daily BEM (wei) for a weight. Zero-sum: when weight rises, everyone's daily falls.
    /// @param hashpower This miner's weight H
    /// @param capped Mining gate. true → unverified pool, 1% only
    /// @param networkWeightVerified Current verified-pool network weight
    /// @param networkWeightUnverified Current unverified-pool network weight
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
        // dailyWei = H × daily × pool share / network weight
        return (hashpower * NETWORK_DAILY_EMISSION * WAD * shareBps) / (BPS * netWeight);
    }
}
