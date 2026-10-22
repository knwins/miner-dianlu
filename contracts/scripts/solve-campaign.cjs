// Local compile + repro check for the deployed Campaign (19773 bytes on BSC).
// Solves for the constructor args by brute force over the plausible dependency set.
// Usage: node scripts/solve-campaign.cjs <address>
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const solc = require("solc");

const root = join(__dirname, "..");
const info = JSON.parse(readFileSync(join(root, "artifacts", "build-info", "c6e898b9c8ed6fd1ed757501c4cbf6c0.json"), "utf8"));
const files = readFileSync(join(root, "tmp-verify", "files.txt"), "utf8").split(/\r?\n/).filter(Boolean);
const sources = Object.fromEntries(
  files.map((f) => [f, { content: readFileSync(join(root, "tmp-verify", "src", f.replace(/\//g, "__")), "utf8") }]),
);
// Only the contracts Campaign imports are reachable; pass the rest so imports resolve.
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: info.input.settings })));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) {
  console.log(errs[0].formattedMessage);
  process.exit(1);
}
const art = out.contracts["contracts/Campaign.sol"].Campaign;
const runtime = art.evm.deployedBytecode.object;
console.log("runtime bytes", runtime.length / 2, "creation", art.evm.bytecode.object.length / 2);
const i = ("0x" + runtime).toLowerCase().lastIndexOf("a2646970667358221220");
console.log("meta", ("0x" + runtime).toLowerCase().slice(i + 22, i + 22 + 64));
