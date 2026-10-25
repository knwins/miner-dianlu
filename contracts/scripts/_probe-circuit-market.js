// Temporary probe: verify the official Circuit Market surface on BSC mainnet.
const { ethers } = require("ethers");

const RPC = "https://bsc-rpc.publicnode.com";
const MARKET = "0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f";
const CPU_FACTORY = "0x68224F668083c29e9800Be2a646d42d18cedF7e2";
const TAPEOUT = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";
const BEHEMOTH = "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c";

const MARKET_ABI = [
  "function nextListingId() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function MAX_FEE_BPS() view returns (uint16)",
  "function factory() view returns (address)",
  "function protocolWallet() view returns (address)",
  "function isSealed() view returns (bool)",
  "function listings(uint256) view returns (address seller, address circuits, uint96 price, uint16 feeBps, uint256 tokenId)",
  "function listingFor(address circuits, uint256 tokenId) view returns (uint256 id, address seller, uint96 price, bool valid)",
  "function listingOf(address circuits, uint256 tokenId) view returns (uint256)",
  "function owed(address) view returns (uint256)",
];
const FACTORY_ABI = [
  "function circuitCount() view returns (uint256)",
  "function circuits(uint256) view returns (address)",
  "function isCircuit(address) view returns (bool)",
  "function owner() view returns (address)",
];
const NFT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function supportsInterface(bytes4) view returns (bool)",
];

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, 56);
  const market = new ethers.Contract(MARKET, MARKET_ABI, p);
  console.log("market", MARKET);
  for (const fn of ["nextListingId", "feeBps", "MAX_FEE_BPS", "factory", "protocolWallet", "isSealed"]) {
    try {
      console.log(fn, String(await market[fn]()));
    } catch (e) {
      console.log(fn, "ERR", e.shortMessage || e.message);
    }
  }
  const n = Number(await market.nextListingId());
  console.log("listings:", n);
  const start = Math.max(1, n - 8);
  for (let id = start; id < n; id++) {
    try {
      const l = await market.listings(id);
      console.log("listing", id, {
        seller: l.seller,
        circuits: l.circuits,
        price: ethers.formatEther(l.price),
        feeBps: String(l.feeBps),
        tokenId: String(l.tokenId),
      });
    } catch (e) {
      console.log("listing", id, "ERR", e.shortMessage || e.message);
    }
  }

  for (const [label, addr] of [["TapeOut", TAPEOUT], ["Behemoth", BEHEMOTH]]) {
    const nft = new ethers.Contract(addr, NFT_ABI, p);
    console.log("---", label, addr);
    for (const fn of ["name", "symbol", "totalSupply"]) {
      try { console.log(fn, String(await nft[fn]())); } catch (e) { console.log(fn, "ERR", e.shortMessage || e.message); }
    }
    try { console.log("supports721", await nft.supportsInterface("0x80ac58cd")); } catch (e) { console.log("supports721 ERR", e.shortMessage || e.message); }
  }

  const f = new ethers.Contract(CPU_FACTORY, FACTORY_ABI, p);
  console.log("--- CPU factory", CPU_FACTORY);
  for (const fn of ["circuitCount", "owner"]) {
    try { console.log(fn, String(await f[fn]())); } catch (e) { console.log(fn, "ERR", e.shortMessage || e.message); }
  }
  try { console.log("isCircuit(TapeOut)", await f.isCircuit(TAPEOUT)); } catch (e) { console.log("isCircuit ERR", e.shortMessage || e.message); }
  try { console.log("isCircuit(Behemoth)", await f.isCircuit(BEHEMOTH)); } catch (e) { console.log("isCircuit ERR", e.shortMessage || e.message); }
}

main().catch((e) => { console.error(e); process.exit(1); });
