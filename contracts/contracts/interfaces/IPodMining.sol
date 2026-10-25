// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of TapeOut's official PoD mining contract the round talks to.
/// @dev BSC mainnet proxy: 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46 (UUPS).
///      `start` mints BEM to the circuit NFT holder, so a round that holds the NFT mines in its own name
///      and every `claim` / `stop` pays the round, not an external pool.
interface IPodMining {
    /// @dev Mirrors PodMining.Miner exactly; only `status` is read by the round, but the whole tuple must
    ///      be declared or Solidity cannot decode the return value.
    struct Miner {
        address circuits;
        uint64 circuitId;
        uint32 taskId;
        uint32 gateCount;
        uint32 stateCount;
        uint32 depth;
        uint64 area;
        uint32 mult;
        uint64 since;
        uint8 status;
        address registrant;
        uint32 nandBurn;
        uint32 latchBurn;
        uint64 bstar;
        uint64 bonus;
        bool optimal;
        uint64 commitBlock;
        uint64 firstUnusedId;
        uint64 stopBlock;
        uint128 verifWeight;
        uint128 unverWeight;
        uint256 debt;
    }

    /// @notice Stable key for one (collection, tokenId) miner.
    function minerKey(address circuits, uint256 circuitId) external pure returns (bytes32);

    /// @notice Book the current block as the sampling anchor. Required before a task (verified-pool) start;
    ///         `start` must happen in a later block, so arm and start are always two transactions.
    function arm(address circuits, uint256 circuitId) external;

    /// @notice Start mining. `taskId == 0` joins the unverified pool; otherwise the caller must pass the
    ///         official task's sampled vectors and proofs.
    function start(
        address circuits,
        uint256 circuitId,
        uint32 taskId,
        uint256 anchorBlock,
        bytes[] calldata inputs,
        bytes[] calldata expectedOuts,
        bytes32[][] calldata proofs,
        bytes32 salt
    ) external returns (bytes32 key);

    /// @notice Stop mining and settle everything earned so far to the NFT holder.
    function stop(bytes32 key) external;

    /// @notice Settle one active miner; the reward is minted to the NFT holder.
    function claim(bytes32 key) external;

    /// @notice Settle several active miners in one transaction.
    function claimMany(bytes32[] calldata keys) external;

    /// @notice Unsettled BEM for one miner.
    function pending(bytes32 key) external view returns (uint256);

    /// @notice Full miner record; `status` is 0 none, 1 active, 2 revoked, 3 cooling.
    function getMiner(bytes32 key) external view returns (Miner memory);

    /// @notice Mining multiplier of a processor collection; 0 = not eligible.
    function processorMultiplier(address circuits) external view returns (uint256);
}
