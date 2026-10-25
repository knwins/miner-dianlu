// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only wallet that rejects BNB.
/// @dev Its only purpose is to prove Campaign never traps holder funds on a failed transfer:
///      - subscribe() lets it act as a subscriber;
///      - receive() reverts by default, simulating a hardware / contract wallet that rejects BNB;
///      - accept() flips the switch so it can receive again.
///      No production deployment references this file (it is absent from the deploy scripts).
contract Rejector {
    bool public rejecting = true;

    error Rejected();

    /// @notice Subscribe as a holder (forwards ETH to the campaign).
    /// @param campaign Campaign to subscribe to.
    /// @param count Shares to buy; msg.value must equal count × share price.
    function subscribe(address campaign, uint256 count) external payable {
        (bool ok, bytes memory ret) = campaign.call{value: msg.value}(abi.encodeWithSignature("subscribe(uint256)", count));
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert Rejected();
        }
    }

    /// @notice Stop rejecting and accept BNB again.
    function accept() external {
        rejecting = false;
    }

    /// @notice Reject BNB again.
    function reject() external {
        rejecting = true;
    }

    /// @notice Forward-call campaign.claimSurplus().
    /// @dev A contract cannot originate a transaction, so tests need this relay. Revert data is
    ///      bubbled up unchanged so a test can still match TransferFailed.
    /// @param campaign Campaign to claim from.
    function claimSurplusFrom(address campaign) external {
        (bool ok, bytes memory ret) = campaign.call(abi.encodeWithSignature("claimSurplus()"));
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert Rejected();
        }
    }

    /// @notice Forward-call campaign.refund().
    /// @dev Same relay pattern as claimSurplusFrom: a contract cannot originate a transaction.
    /// @param campaign Campaign to refund from.
    function refundFrom(address campaign) external {
        (bool ok, bytes memory ret) = campaign.call(abi.encodeWithSignature("refund()"));
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert Rejected();
        }
    }

    receive() external payable {
        if (rejecting) revert Rejected();
    }
}
