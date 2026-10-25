// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The BEM ERC20 surface the round needs to pay out official mining rewards.
/// @dev BSC mainnet BEM: 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a.
interface IBemToken {
    /// @param account Wallet to query.
    /// @return Balance in BEM wei.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Move BEM; returns false instead of reverting on a soft failure.
    function transfer(address to, uint256 amount) external returns (bool);
}
