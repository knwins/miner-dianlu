// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICircuitMarket} from "../interfaces/ICircuitMarket.sol";
import {IERC721} from "../interfaces/IERC721.sol";

/// @notice Test double with the official SELL-side Circuit Market ABI.
/// @dev Mirrors mainnet shapes that matter to Campaign:
///      - NO custody: `list` only records the offer; the seller keeps the NFT.
///      - one NFT per trade; `buy` requires msg.value == expectedPrice == live price.
///      - seller proceeds are pull-based: `buy` credits `owed[seller]` (net of feeBps) for `withdraw`.
///      The mock adds test switches (`setBlockBuy`, `setPayNothing`, `setBlockWithdraw`) so the failure
///      paths can be exercised. It must never exist on BSC mainnet (chainId 56).
contract MockCircuitMarket is ICircuitMarket {
    struct Listing {
        address seller;
        address circuits;
        uint96 price;
        uint16 feeBps;
        uint256 tokenId;
        bool valid;
    }

    uint256 public nextListingId = 1;
    uint16 private _feeBps;
    mapping(uint256 => Listing) private _listings;
    mapping(address => mapping(uint256 => uint256)) private _listingIdOf; // circuits => tokenId => id
    mapping(address => uint256) private _owed;

    event Listed(uint256 indexed id, address indexed seller, address indexed circuits, uint256 tokenId, uint96 price);
    event Delisted(uint256 indexed id);
    event Bought(uint256 indexed id, address indexed buyer, address indexed seller, uint256 tokenId, uint96 price, uint16 feeBps);
    event ProceedsWithdrawn(address indexed account, uint256 amount);

    error BadListing();
    error NotSeller();
    error PriceMismatch();
    error NothingOwed();
    error MockOnMainnet();

    constructor(uint16 feeBps_) {
        if (block.chainid == 56) revert MockOnMainnet();
        _feeBps = feeBps_;
    }

    function setFeeBps(uint16 feeBps_) external {
        _feeBps = feeBps_;
    }

    /// @dev Test switch: every `buy` reverts, as if the listing was taken in the same block.
    bool public blockBuy;

    function setBlockBuy(bool on) external {
        blockBuy = on;
    }

    /// @dev Test switch: `buy` moves the NFT but credits the seller nothing (a broken market).
    bool public payNothing;

    function setPayNothing(bool on) external {
        payNothing = on;
    }

    /// @dev Test switch: `withdraw` reverts, so Campaign's soft-pull paths can be exercised.
    bool public blockWithdraw;

    function setBlockWithdraw(bool on) external {
        blockWithdraw = on;
    }

    /// @dev Test switch: `delist` reverts, so the escape hatch can be exercised against a stuck market.
    bool public blockDelist;

    function setBlockDelist(bool on) external {
        blockDelist = on;
    }

    /// @dev Test switch: `list` returns 0 without recording (a broken market).
    bool public returnZeroId;

    function setReturnZeroId(bool on) external {
        returnZeroId = on;
    }

    /// @dev Test switch: `buy` takes the money but does not move the NFT (a hostile market).
    bool public skipTransfer;

    function setSkipTransfer(bool on) external {
        skipTransfer = on;
    }

    function list(address circuits, uint256 tokenId, uint96 price) external returns (uint256 id) {
        if (circuits == address(0) || price == 0) revert BadListing();
        if (IERC721(circuits).ownerOf(tokenId) != msg.sender) revert BadListing();
        if (_listingIdOf[circuits][tokenId] != 0) revert BadListing();
        if (returnZeroId) return 0;
        id = nextListingId++;
        _listings[id] = Listing({
            seller: msg.sender,
            circuits: circuits,
            price: price,
            feeBps: _feeBps,
            tokenId: tokenId,
            valid: true
        });
        _listingIdOf[circuits][tokenId] = id;
        emit Listed(id, msg.sender, circuits, tokenId, price);
    }

    function delist(uint256 id) external {
        if (blockDelist) revert BadListing();
        Listing storage l = _listings[id];
        if (!l.valid || l.seller != msg.sender) revert NotSeller();
        l.valid = false;
        _listingIdOf[l.circuits][l.tokenId] = 0;
        emit Delisted(id);
    }

    function buy(uint256 id, uint96 expectedPrice) external payable {
        if (blockBuy) revert BadListing();
        Listing storage l = _listings[id];
        if (!l.valid) revert BadListing();
        if (msg.value != expectedPrice || expectedPrice != l.price) revert PriceMismatch();
        // Mainnet has no custody: the seller must still own the token when the buyer pays.
        if (IERC721(l.circuits).ownerOf(l.tokenId) != l.seller) revert BadListing();

        l.valid = false;
        _listingIdOf[l.circuits][l.tokenId] = 0;
        uint256 fee = (uint256(l.price) * l.feeBps) / 10_000;
        uint256 net = payNothing ? 0 : uint256(l.price) - fee;
        if (net != 0) _owed[l.seller] += net;
        // Official market uses safeTransferFrom; mock must too or Campaign.receiver bugs stay hidden.
        if (!skipTransfer) IERC721(l.circuits).safeTransferFrom(l.seller, msg.sender, l.tokenId);
        emit Bought(id, msg.sender, l.seller, l.tokenId, l.price, l.feeBps);
    }

    function listingFor(address circuits, uint256 tokenId)
        external
        view
        returns (uint256 id, address seller, uint96 price, bool valid)
    {
        id = _listingIdOf[circuits][tokenId];
        if (id == 0) return (0, address(0), 0, false);
        Listing storage l = _listings[id];
        return (id, l.seller, l.price, l.valid);
    }

    function listingOf(address circuits, uint256 tokenId) external view returns (uint256 id) {
        return _listingIdOf[circuits][tokenId];
    }

    function listings(uint256 id)
        external
        view
        returns (address seller, address circuits, uint96 price, uint16 listedFeeBps, uint256 tokenId)
    {
        Listing storage l = _listings[id];
        return (l.seller, l.circuits, l.price, l.feeBps, l.tokenId);
    }

    function feeBps() external view returns (uint16) {
        return _feeBps;
    }

    function owed(address account) external view returns (uint256) {
        return _owed[account];
    }

    /// @dev Test helper: credit proceeds that a listing sale already produced, so a Campaign can be
    ///      exercised against settlement that lands later.
    function creditOwed(address account, uint256 amount) external payable {
        if (msg.value != amount) revert BadListing();
        _owed[account] += amount;
    }

    function withdraw() external {
        if (blockWithdraw) revert BadListing();
        uint256 amount = _owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        _owed[msg.sender] = 0;
        emit ProceedsWithdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert BadListing();
    }
}
