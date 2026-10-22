// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC1155 used to test Campaign recover / placeAsk flows.
contract MockERC1155 {
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    error Insufficient();
    error NotApproved();
    error MockOnMainnet();

    constructor() {
        // 最后一道防线：测试替身绝不能出现在 BSC 主网（chainId 56）。
        //
        // 这个 mock 的 mint 没有任何访问控制——一旦它成为某期的 transistors，
        // 任何地址都能无限造 NAND / LATCH，「元件已到账」的检查随之失效，
        // 期次可以在零真实采购的情况下被推进到挖矿。
        // 部署到主网时直接失败并烧掉 gas，比留下一个「看起来正常」的假市场安全得多。
        if (block.chainid == 56) revert MockOnMainnet();
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApproval[msg.sender][operator] = approved;
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operatorApproval[account][operator];
    }

    function mint(address to, uint256 id, uint256 amount) external {
        _balances[id][to] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        if (msg.sender != from && !_operatorApproval[from][msg.sender]) revert NotApproved();
        uint256 bal = _balances[id][from];
        if (amount == 0 || amount > bal) revert Insufficient();
        _balances[id][from] = bal - amount;
        _balances[id][to] += amount;
    }
}
