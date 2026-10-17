// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";
import {IPoD} from "../interfaces/IPoD.sol";

/// @notice 测试用 PoD：每日 claim 把 amount BEM 打给调用方；start 返回固定权重。
contract MockPoD is IPoD {
    IERC20 public immutable bem;
    uint256 public immutable hashpower;
    uint256 public dailyAmount;

    constructor(IERC20 bem_, uint256 hashpower_) {
        bem = bem_;
        hashpower = hashpower_;
    }

    function setDailyAmount(uint256 amount) external {
        dailyAmount = amount;
    }

    /// @dev 预先 mint 给本合约，claim 时转给调用方（Campaign）。
    function claim() external returns (uint256) {
        uint256 amt = dailyAmount;
        if (amt == 0) return 0;
        dailyAmount = 0;
        bem.transfer(msg.sender, amt);
        return amt;
    }

    function start(bytes calldata) external returns (uint256) {
        return hashpower;
    }

    function arm() external {}
}
