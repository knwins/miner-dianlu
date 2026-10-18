/**
 * Official PoD startData packing for Campaign.execute → OfficialPodAdapter.start.
 *
 * Official signature:
 *   start(address cpu, uint256 circuitId, uint32 taskId, uint256 anchor,
 *         bytes[] circuits, bytes[] proofs, bytes32[][] pubs, bytes32 salt)
 *
 * Campaign passes one abi-encoded blob as startData. Proofs / circuit blobs come from
 * tapeout.net (or your prover) — do not invent them. Empty arrays only work for tests
 * against MockOfficialPoD.
 */

import { AbiCoder, ZeroHash, getAddress, isAddress, isHexString } from "ethers";

export const OFFICIAL_POD = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46";
export const OFFICIAL_CPU_TAPEOUT = "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C";
export const OFFICIAL_CPU_BEHEMOTH = "0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c";

const CODER = AbiCoder.defaultAbiCoder();
const START_TYPES = [
  "address",
  "uint256",
  "uint32",
  "uint256",
  "bytes[]",
  "bytes[]",
  "bytes32[][]",
  "bytes32",
];

function asHexBytes(value, label) {
  if (value == null || value === "") return "0x";
  const s = String(value).trim();
  if (!isHexString(s)) throw new Error(`${label} 须是 0x 开头的十六进制`);
  return s.length % 2 === 0 ? s : `0x0${s.slice(2)}`;
}

function asHexBytesList(value, label) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map((item, i) => asHexBytes(item, `${label}[${i}]`));
  const raw = String(value).trim();
  if (!raw) return [];
  // JSON array, or comma / newline separated hex blobs
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${label} JSON 须是数组`);
    return parsed.map((item, i) => asHexBytes(item, `${label}[${i}]`));
  }
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item, i) => asHexBytes(item, `${label}[${i}]`));
}

function asBytes32ListList(value, label) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.map((row, i) => {
      if (!Array.isArray(row)) throw new Error(`${label}[${i}] 须是 bytes32 数组`);
      return row.map((item, j) => {
        const h = asHexBytes(item, `${label}[${i}][${j}]`);
        if (h.length !== 66) throw new Error(`${label}[${i}][${j}] 须是 32 字节`);
        return h;
      });
    });
  }
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw.startsWith("[")) return asBytes32ListList(JSON.parse(raw), label);
  // single row of comma-separated bytes32
  const row = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item, i) => {
      const h = asHexBytes(item, `${label}[0][${i}]`);
      if (h.length !== 66) throw new Error(`${label}[0][${i}] 须是 32 字节`);
      return h;
    });
  return row.length ? [row] : [];
}

/**
 * Pack official start args into Campaign.execute's startData bytes.
 * @param {object} p
 * @param {string} p.cpu processor / circuit collection
 * @param {string|number|bigint} p.circuitId
 * @param {string|number} p.taskId
 * @param {string|number|bigint} [p.anchor=0]
 * @param {string[]|string} [p.circuits]
 * @param {string[]|string} [p.proofs]
 * @param {string[][]|string} [p.pubs]
 * @param {string} [p.salt]
 */
export function encodeOfficialStartData(p = {}) {
  const cpu = getAddress(p.cpu || OFFICIAL_CPU_TAPEOUT);
  if (!isAddress(cpu)) throw new Error("cpu 地址无效");
  const circuitId = BigInt(p.circuitId ?? 0);
  const taskId = Number(p.taskId ?? 0);
  if (!Number.isInteger(taskId) || taskId < 0 || taskId > 0xffffffff) {
    throw new Error("taskId 须是 uint32");
  }
  const anchor = BigInt(p.anchor ?? 0);
  const circuits = asHexBytesList(p.circuits, "circuits");
  const proofs = asHexBytesList(p.proofs, "proofs");
  const pubs = asBytes32ListList(p.pubs, "pubs");
  let salt = p.salt == null || p.salt === "" ? ZeroHash : String(p.salt).trim();
  if (!isHexString(salt) || salt.length !== 66) throw new Error("salt 须是 bytes32");

  return CODER.encode(START_TYPES, [cpu, circuitId, taskId, anchor, circuits, proofs, pubs, salt]);
}

/** Decode a packed startData blob back to fields (for debug / Calls page). */
export function decodeOfficialStartData(startData) {
  const raw = String(startData || "").trim();
  if (!isHexString(raw) || raw.length < 10) throw new Error("startData 无效");
  const [
    cpu,
    circuitId,
    taskId,
    anchor,
    circuits,
    proofs,
    pubs,
    salt,
  ] = CODER.decode(START_TYPES, raw);
  return {
    cpu,
    circuitId: circuitId.toString(),
    taskId: Number(taskId),
    anchor: anchor.toString(),
    circuits: [...circuits],
    proofs: [...proofs],
    pubs: pubs.map((row) => [...row]),
    salt,
  };
}

/**
 * Build startData for execute.
 * Prefer a pasted packed blob; otherwise pack structured fields.
 * Returns null when nothing usable was provided (caller may fall back to mock).
 */
export function buildExecuteStartData(args = {}) {
  const pasted = String(args.startData || args.startDataHex || "").trim();
  if (pasted && pasted !== "0x" && pasted !== "0x12345678") {
    if (!isHexString(pasted) || pasted.length % 2 !== 0) {
      throw new Error("startData 须是偶数长度的 0x 十六进制");
    }
    // If it already looks like a full abi blob (long), use as-is; short mock kept for local MockPoD.
    if (pasted.length > 10) return pasted;
  }
  if (args.circuitId != null && String(args.circuitId).trim() !== "") {
    return encodeOfficialStartData(args);
  }
  return null;
}
