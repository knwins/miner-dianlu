// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice tapeout.net material-market interface (mainnet 0xA6a80C1919a8326022d7c601a488888C13aA16E4).
///
///         ── 已用主网 eth_call 核对的 ABI（2026-08，scripts/probe-market-surface.mjs / probe-market-bid.mjs）──
///         官方市场是 EIP-1967 代理，**只暴露买单侧**。实测存在：
///           - placeBid(address,uint8,uint96,uint256) payable returns (uint256 id)
///               msg.value 必须**精确等于** price × quantity，多一分少一分都 revert "wrong value"。
///           - bids(uint256) → 6 元组 (buyer, transistors, price, tokenId, feeBps, remaining)
///           - cancelBid(uint256)、nextBidId()、feeBps()、owed(address)、withdraw()
///         实测**不存在**（代理 fallback 吃掉 → missing revert data）：
///           placeAsk / asks / nextAskId / cancelAsk / fillAsk
///         另有 fillBid(uint256,uint256) 存在，语义为 fillBid(bidId, qty)——
///         由**持有元件的卖家**调用，成交后市场把 ERC1155 元件转给买家（= 本 Campaign）。
///         Campaign 自身不调用 fillBid，只被动接收 ERC1155（onERC1155Received / BatchReceived）。
///
///         ── 由此得出的主网约束 ──
///         1. 官方市场的手续费 feeBps = 100（1%），从**卖家实收**里扣，不从买家托管里加。
///            买家付 price × quantity，卖家拿 99%。Campaign 的 priceLock = qty × price 与托管一致，不短缺。
///         2. 官方市场没有卖单簿 → 本合约的 placeTransistorAsk / cancelTransistorAsk / confirmSale
///            在**主网上必然 revert**（代理没有该 selector）。这些是「把元件回卖市场」的次级路径，
///            主网不可用；不影响 placeBid → 卖家 fillBid → 元件到账 → depositToPool 的主流程。
///            _askOpen() 在 askQty == 0 时会短路，不会触发 market.asks()，因此主网上不会误 revert。
///         3. 撤单/成交款回到本合约走 receive()（或 owed() + withdraw() 两条路都存在），
///            所以 receive() 只接受「已知市场」地址（见 Campaign._isKnownMarket）。
interface IMaterialMarket {
    function placeBid(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        payable
        returns (uint256 id);

    function cancelBid(uint256 id) external;

    function bids(uint256 id)
        external
        view
        returns (
            address buyer,
            address transistors,
            uint96 price,
            uint8 tokenId,
            uint16 feeBps,
            uint256 remaining
        );

    function placeAsk(address transistors, uint8 tokenId, uint96 price, uint256 quantity)
        external
        returns (uint256 id);

    function cancelAsk(uint256 id) external;

    function asks(uint256 id)
        external
        view
        returns (
            address seller,
            uint96 price,
            address transistors,
            uint8 tokenId,
            uint256 remaining
        );

    function owed(address account) external view returns (uint256);

    function withdraw() external;
}
