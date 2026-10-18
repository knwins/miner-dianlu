const { ethers } = require("ethers");
const factory = require("../artifacts/contracts/CampaignFactory.sol/CampaignFactory.json");
const campaign = require("../artifacts/contracts/Campaign.sol/Campaign.json");
const pod = require("../artifacts/contracts/mocks/MockPoD.sol/MockPoD.json");

function bytesOf(artifact) {
  return (artifact.bytecode.length - 2) / 2;
}

console.log("factory", bytesOf(factory));
console.log("campaign", bytesOf(campaign));
console.log("mockPod", bytesOf(pod));

const provider = new ethers.JsonRpcProvider("https://bsc-rpc.publicnode.com");
provider.getFeeData().then((f) => {
  console.log("gasPrice", f.gasPrice ? ethers.formatUnits(f.gasPrice, "gwei") : "null", "gwei");
  const price = f.gasPrice || 1_000_000_000n;
  const gas = 8_000_000n;
  console.log("8m gas costs", ethers.formatEther(gas * price), "BNB");
});
