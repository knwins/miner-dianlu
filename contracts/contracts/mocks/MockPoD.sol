// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";
import {IPoD} from "../interfaces/IPoD.sol";

/// @notice Test PoD. claim sends `amount` BEM to the caller. start returns a fixed weight.
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

    /// @dev Pre-mint BEM to this contract. claim transfers it to the caller (the Campaign).
    function claim() external returns (uint256) {
        uint256 amt = dailyAmount;
        if (amt == 0) return 0;
        dailyAmount = 0;
        bem.transfer(msg.sender, amt);
        return amt;
    }

    function start(bytes calldata) external view returns (uint256) {
        return hashpower;
    }
}
