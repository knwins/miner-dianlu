// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReentrancyGuard（最小自包含实现）
/// @notice 所有涉及外部调用（转 BNB / 转 BEM / 调 minter·pod）的写函数都加 nonReentrant，
///         杜绝退款/领取时的重入双击。
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    error Reentrancy();

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
