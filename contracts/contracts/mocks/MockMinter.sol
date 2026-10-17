// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITransistorMinter} from "../interfaces/ITransistorMinter.sol";

/// @notice 测试用晶体管铸造器：按固定单价计价，mint 要求 msg.value == count × unitPrice，
///         模拟「锁定报价快照」生效。收到的 BNB 留在合约内（= 元件款被市场收走）。
contract MockMinter is ITransistorMinter {
    uint256 public unitPriceBnb;
    uint256 public mintedCount;

    constructor(uint256 unitPriceBnb_) {
        unitPriceBnb = unitPriceBnb_;
    }

    function setUnitPrice(uint256 p) external {
        unitPriceBnb = p;
    }

    function mint(uint256 count) external payable {
        require(msg.value == count * unitPriceBnb, "Minter: price mismatch");
        mintedCount += count;
    }

    function quote(uint256 count) external view returns (uint256) {
        return count * unitPriceBnb;
    }
}
