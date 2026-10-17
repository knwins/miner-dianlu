// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 挖矿合约 PoD（对应前端 emission.js 实读的 0x7E2E…7b46）。
///         Campaign 持有晶体管算力，靠 PoD 每日 claim 拉取 BEM，再按份分发给持有人。
interface IPoD {
    /// @notice 把当前可领日产 BEM 打给调用方（Campaign）。返回实际拉取的 BEM 数量（wei）。
    function claim() external returns (uint256);

    /// @notice 流片成功后开户：登记网表/启动挖矿，返回本矿机权重 H。
    ///         tapeOut 数据必须等于开期承诺的 netlistHash（由 Campaign 侧校验后转发）。
    function start(bytes calldata startData) external returns (uint256 hashpower);

    /// @notice 预注册（可选）：开期时占位，execute 后再 start。
    function arm() external;
}
