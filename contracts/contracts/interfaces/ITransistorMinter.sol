// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Legacy mint entry. Campaign no longer calls it. After minting ended, buys go through IMaterialMarket.placeBid.
interface ITransistorMinter {
    /// @notice Legacy. The current round contract does not call this.
    function mint(uint256 count) external payable;

    /// @notice Legacy quote. The material market has no such function, and the frontend no longer reads it.
    function quote(uint256 count) external view returns (uint256);
}
