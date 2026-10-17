// 用 solc 编译 contracts/ 下全部 .sol，做类型/语法校验并导出 ABI。运行：
//   NODE_PATH=<workspace>/node_modules node compile.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(
  "C:/Users/Administrator/.workbuddy/binaries/node/workspace/package.json"
);
const solc = require("solc");

const ROOT = "D:/Code/miner/contracts/contracts";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".sol")) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const dirs = [...new Set(files.map((f) => dirname(f)))];

const sources = {};
for (const f of files) {
  const key = f.slice(ROOT.length + 1).replace(/\\/g, "/");
  sources[key] = { content: readFileSync(f, "utf8") };
}

function findImport(requestPath) {
  for (const d of dirs) {
    try {
      return { contents: readFileSync(join(d, requestPath), "utf8") };
    } catch {
      /* 试下一个目录 */
    }
  }
  return { error: "File not found: " + requestPath };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

const errors = (output.errors || []).filter((e) => e.severity === "error");
const warnings = (output.errors || []).filter((e) => e.severity !== "error");

for (const w of warnings) console.log("WARN:", w.formattedMessage.split("\n")[0]);
for (const e of errors) console.log("ERROR:", e.formattedMessage);

if (errors.length) {
  console.log(`\n✗ 编译失败：${errors.length} 个错误`);
  process.exit(1);
}

console.log(`\n✓ 编译通过（${files.length} 个文件）`);
for (const [file, contracts] of Object.entries(output.contracts || {})) {
  for (const name of Object.keys(contracts)) {
    const abi = contracts[name].abi;
    const fns = abi.filter((x) => x.type === "function").map((x) => x.name);
    console.log(`  - ${file}:${name}  ${fns.length} 个函数`);
  }
}
