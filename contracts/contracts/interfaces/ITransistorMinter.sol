// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 晶体管二级市场铸造器（对应 tapeout.net 挂单成交后的链上买入入口）。
///         合约无法替人工去平台下单，由 Owner 手动发起；成交按「锁定报价快照」结算，
///         避免 execute 瞬间被抢跑/抬价。mint 为 payable，收取的 BNB 即锁定报价成本。
interface ITransistorMinter {
    /// @notice 按锁定报价买入 count 颗晶体管。调用方随 msg.value 支付 BNB。
    /// @dev 必须校验 msg.value 与锁定单价一致，否则 revert（由实现方保证报价快照生效）。
    function mint(uint256 count) external payable;

    /// @notice 当前挂单/成交报价：买入 count 颗所需 BNB。仅 Owner 前端展示与锁价参考。
    function quote(uint256 count) external view returns (uint256);
}
