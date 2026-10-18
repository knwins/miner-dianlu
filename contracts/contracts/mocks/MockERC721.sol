// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC721 for testing Campaign.onERC721Received.
contract MockERC721 {
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    error NotOwner();
    error BadReceiver();

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
        balanceOf[to] += 1;
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external {
        if (ownerOf[id] != from || msg.sender != from) revert NotOwner();
        ownerOf[id] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        if (to.code.length > 0) {
            (bool ok, bytes memory ret) = to.call(
                abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", msg.sender, from, id, data)
            );
            if (!ok || ret.length < 4 || bytes4(ret) != bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"))) {
                revert BadReceiver();
            }
        }
    }
}
