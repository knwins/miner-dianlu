const { ethers } = require("ethers");

const hash = "0x5273641d0c4921f49515d5f252373ff856f8bf3a5da5620125ff989790985463";
const provider = new ethers.JsonRpcProvider("https://bsc-rpc.publicnode.com", 56, { staticNetwork: true });

async function main() {
  const addr = ethers.getCreateAddress({ from: "0xebA1B24d36487a75C533233A07D6899a268Bb9AA", nonce: 0 });
  const code = await provider.getCode(addr);
  console.log("pod", addr, "codeBytes", (code.length - 2) / 2);
  const bal = await provider.getBalance("0xebA1B24d36487a75C533233A07D6899a268Bb9AA");
  const n = await provider.getTransactionCount("0xebA1B24d36487a75C533233A07D6899a268Bb9AA");
  console.log("balance", ethers.formatEther(bal), "nonce", n);
  console.log("create0", ethers.getCreateAddress({ from: "0xebA1B24d36487a75C533233A07D6899a268Bb9AA", nonce: 0 }));
}

main();
