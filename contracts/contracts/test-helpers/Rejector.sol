// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 仅用于测试的「拒收 BNB」钱包。
/// @dev 存在的唯一理由：验证 Campaign 在转账失败时不会把持份人的钱卡死。
///      - subscribe()  → 让这个合约能作为持份人认购份额；
///      - receive()     → 默认 revert，模拟硬件钱包/合约钱包拒收 BNB；
///      - accept()      → 测试里可以打开开关，让它恢复收钱。
///      生产部署不会引用这个文件（部署脚本里没有它）。
contract Rejector {
    bool public rejecting = true;

    error Rejected();

    /// @notice 作为持份人认购份额（把 ETH 转给 campaign）。
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

    /// @notice 关闭拒收，开始正常收 BNB。
    function accept() external {
        rejecting = false;
    }

    /// @notice 重新打开拒收。
    function reject() external {
        rejecting = true;
    }

    /// @notice 转发调用 campaign.claimSurplus()。
    /// @dev 合约地址不能直接发交易，测试需要一个中转入口。
    ///      失败时把 revert data 原样冒泡，测试才能匹配到 TransferFailed。
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

    receive() external payable {
        if (rejecting) revert Rejected();
    }
}
