// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "../interfaces/IERC721.sol";
import {IPodMining} from "../interfaces/IPodMining.sol";
import {MockBem} from "./MockBEM.sol";

/// @notice Minimal official PoD Mining double: start / stop / claim / claimMany, with the reward paid in
///         mock BEM to the circuit NFT holder. Test-only (constructor refuses BSC mainnet).
contract MockPodMining {
    MockBem public immutable bem;

    mapping(address => uint256) public processorMultiplier;
    mapping(bytes32 => IPodMining.Miner) private _miners;
    mapping(bytes32 => uint256) private _pending;
    mapping(bytes32 => uint64) public armedAt;

    /// @notice Official PodMining cooldown after stop: restart only when block.number > stopBlock + this.
    uint256 public constant COOLDOWN_BLOCKS = 1200;

    error MockOnMainnet();
    error NotCircuitOwner();
    error NotEligible();
    error NotActive();
    error Cooling();

    constructor(MockBem bem_) {
        if (block.chainid == 56) revert MockOnMainnet();
        bem = bem_;
    }

    /// @notice Test knob: register a processor collection with a mining multiplier.
    function setProcessor(address circuits, uint256 multiplier) external {
        processorMultiplier[circuits] = multiplier;
    }

    /// @notice Test knob: queue BEM to be minted on the next claim/stop of `key`.
    function accrue(bytes32 key, uint256 amount) external {
        _pending[key] += amount;
    }

    function minerKey(address circuits, uint256 circuitId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(circuits, circuitId));
    }

    function getMiner(bytes32 key) external view returns (IPodMining.Miner memory) {
        return _miners[key];
    }

    function pending(bytes32 key) external view returns (uint256) {
        return _miners[key].status == 1 ? _pending[key] : 0;
    }

    function arm(address circuits, uint256 circuitId) external {
        if (IERC721(circuits).ownerOf(circuitId) != msg.sender) revert NotCircuitOwner();
        armedAt[minerKey(circuits, circuitId)] = uint64(block.number);
    }

    function start(
        address circuits,
        uint256 circuitId,
        uint32 taskId,
        uint256 anchorBlock,
        bytes[] calldata,
        bytes[] calldata,
        bytes32[][] calldata,
        bytes32
    ) external returns (bytes32 key) {
        if (processorMultiplier[circuits] == 0) revert NotEligible();
        if (IERC721(circuits).ownerOf(circuitId) != msg.sender) revert NotCircuitOwner();
        key = minerKey(circuits, circuitId);
        if (taskId != 0 && armedAt[key] == 0) revert NotEligible();
        anchorBlock;
        IPodMining.Miner storage m = _miners[key];
        if (m.status == 3 && block.number <= uint256(m.stopBlock) + COOLDOWN_BLOCKS) revert Cooling();
        if (m.status == 2) revert NotEligible();
        m.circuits = circuits;
        m.circuitId = uint64(circuitId);
        m.taskId = taskId;
        m.since = uint64(block.timestamp);
        m.status = 1;
        m.registrant = msg.sender;
        m.stopBlock = 0;
    }

    function stop(bytes32 key) external {
        IPodMining.Miner storage m = _miners[key];
        if (m.status != 1) revert NotActive();
        if (IERC721(m.circuits).ownerOf(m.circuitId) != msg.sender) revert NotCircuitOwner();
        _harvest(key);
        m.status = 3;
        m.stopBlock = uint64(block.number);
    }

    function claim(bytes32 key) external {
        if (_miners[key].status != 1) revert NotActive();
        _harvest(key);
    }

    function claimMany(bytes32[] calldata keys) external {
        for (uint256 i = 0; i < keys.length; i++) {
            if (_miners[keys[i]].status == 1) _harvest(keys[i]);
        }
    }

    function _harvest(bytes32 key) internal {
        uint256 amt = _pending[key];
        if (amt == 0) return;
        _pending[key] = 0;
        IPodMining.Miner storage m = _miners[key];
        bem.mint(IERC721(m.circuits).ownerOf(m.circuitId), amt);
    }
}
