// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITransistorMinter} from "../interfaces/ITransistorMinter.sol";

/// @notice Legacy mint mock. Campaign tests use MockMaterialMarket. This contract is not used when opening a round.
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
