/**
 * Pack official PoD start args into Campaign.execute startData.
 *
 * Usage:
 *   node scripts/encode-start-data.js --circuit 17907 --task 220 --cpu 0xb102... --proofs 0x..,0x..
 *   node scripts/encode-start-data.js --json path/to/args.json
 *
 * Proofs must come from tapeout.net / your prover. Empty arrays are only for MockOfficialPoD.
 */
const { ethers } = require("ethers");
const fs = require("node:fs");

const OFFICIAL_CPU = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function splitHex(list) {
  if (!list) return [];
  return String(list)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  let input = {};
  const jsonPath = arg("json");
  if (jsonPath) {
    input = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } else {
    input = {
      cpu: arg("cpu", OFFICIAL_CPU),
      circuitId: arg("circuit", "0"),
      taskId: arg("task", "0"),
      anchor: arg("anchor", "0"),
      circuits: splitHex(arg("circuits")),
      proofs: splitHex(arg("proofs")),
      pubs: arg("pubs") ? JSON.parse(arg("pubs")) : [],
      salt: arg("salt", ethers.ZeroHash),
    };
  }

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint32", "uint256", "bytes[]", "bytes[]", "bytes32[][]", "bytes32"],
    [
      ethers.getAddress(input.cpu || OFFICIAL_CPU),
      BigInt(input.circuitId ?? 0),
      Number(input.taskId ?? 0),
      BigInt(input.anchor ?? 0),
      input.circuits || [],
      input.proofs || [],
      input.pubs || [],
      input.salt || ethers.ZeroHash,
    ]
  );
  console.log(encoded);
}

main();
