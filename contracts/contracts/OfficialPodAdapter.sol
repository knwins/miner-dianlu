// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IOfficialPoD} from "./interfaces/IOfficialPoD.sol";
import {IPoD} from "./interfaces/IPoD.sol";

/// @title OfficialPodAdapter — Campaign IPoD in front of the official PoD
/// @notice Campaign delegatecalls this contract (see podUsesDelegatecall).
///         Immutables live in this bytecode, so they stay valid under delegatecall.
///         The mining key is stored in the campaign, at KEY_SLOT, not in this contract.
///
///         Official start checks msg.sender == circuit owner (Ownr). Delegatecall keeps
///         that caller as the campaign. An ERC1155 balance on the campaign is not enough:
///         the campaign address itself must own the circuit NFT.
///
///         hashpower returned to Campaign is circuitBurn * processorMultiplier (b* × P).
///         That is an estimate for dailyBem(). Official claim often pays more (verified-pool H).
///         Campaign.harvest credits the BEM actually received, so the gap is not left stuck.
contract OfficialPodAdapter is IPoD {
    /// @dev Namespaced campaign storage. Do not reuse this slot in Campaign.
    bytes32 internal constant KEY_SLOT = keccak256("bem.campaign.officialPod.key");

    IOfficialPoD public immutable official;
    IERC20 public immutable bem;

    error ZeroAddress();
    error EmptyKey();
    error ZeroWeight();
    error PodCallFailed();

    constructor(address official_, address bem_) {
        if (official_ == address(0) || bem_ == address(0)) revert ZeroAddress();
        official = IOfficialPoD(official_);
        bem = IERC20(bem_);
    }

    /// @notice Campaign calls this with staticcall. true means execute/harvest must delegatecall.
    function podUsesDelegatecall() external pure returns (bool) {
        return true;
    }

    /// @notice Decode official start args from startData, call official start, store the key.
    ///         Returns burn weight b* × P. Reverts with the official error (Ownr, Wrm, Cpu, …).
    function start(bytes calldata startData) external returns (uint256 hashpower) {
        (
            address cpu,
            uint256 circuitId,
            uint32 taskId,
            uint256 anchor,
            bytes[] memory circuits,
            bytes[] memory proofs,
            bytes32[][] memory pubs,
            bytes32 salt
        ) = abi.decode(startData, (address, uint256, uint32, uint256, bytes[], bytes[], bytes32[][], bytes32));

        bytes memory ret = _call(
            address(official),
            abi.encodeCall(IOfficialPoD.start, (cpu, circuitId, taskId, anchor, circuits, proofs, pubs, salt))
        );
        bytes32 key = abi.decode(ret, (bytes32));
        if (key == bytes32(0)) revert EmptyKey();

        bytes32 slot = KEY_SLOT;
        assembly {
            sstore(slot, key)
        }

        uint256 burn = official.circuitBurn(cpu, circuitId);
        uint256 mult = official.processorMultiplier(cpu);
        hashpower = burn * mult;
        if (hashpower == 0) revert ZeroWeight();
    }

    /// @notice Pull official rewards to address(this). Under delegatecall that is the campaign.
    function claim() external returns (uint256 amount) {
        bytes32 slot = KEY_SLOT;
        bytes32 key;
        assembly {
            key := sload(slot)
        }
        if (key == bytes32(0)) revert EmptyKey();

        uint256 beforeBal = bem.balanceOf(address(this));
        _call(address(official), abi.encodeCall(IOfficialPoD.claim, (key)));
        return bem.balanceOf(address(this)) - beforeBal;
    }

    function _call(address target, bytes memory data) private returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (ok) return ret;
        if (ret.length == 0) revert PodCallFailed();
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}
