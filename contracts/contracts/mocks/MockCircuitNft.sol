// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC721 used to test the Circuit Market integration.
/// @dev Test-only double: `mint` has no access control, so it must never exist on BSC mainnet.
contract MockCircuitNft {
    string public name = "Mock Circuit";
    string public symbol = "MCIRC";

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error NotOwner();
    error NotApproved();
    error AlreadyMinted();
    error MockOnMainnet();

    constructor() {
        // A public mint would let any round fake "the circuit arrived". Same guard as the old parts mock.
        if (block.chainid == 56) revert MockOnMainnet();
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balanceOf[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NotOwner();
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _approved[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApproval[owner][operator];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NotOwner();
        if (msg.sender != owner && !_operatorApproval[owner][msg.sender]) revert NotApproved();
        _approved[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApproval[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = _ownerOf[tokenId];
        if (owner != from) revert NotOwner();
        if (
            msg.sender != from && !_operatorApproval[from][msg.sender] && _approved[tokenId] != msg.sender
        ) revert NotApproved();
        if (to == address(0)) revert NotOwner();

        delete _approved[tokenId];
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    /// @notice Test mint. Reverts if the id is already taken.
    function mint(address to, uint256 tokenId) external {
        if (to == address(0) || _ownerOf[tokenId] != address(0)) revert AlreadyMinted();
        _ownerOf[tokenId] = to;
        _balanceOf[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0x80ac58cd; // ERC721
    }
}
