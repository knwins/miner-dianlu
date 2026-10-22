// 用仓库里某个历史提交的合约源码重编译，看哪一版能复现链上 Campaign 的 metadata 指纹。
// 用法：node scripts/find-source.mjs 0x45AF...  （先 npm run compile 过当前代码，dependency lock 就有了）
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { execSync } = require("node:child_process");
const solc = require("solc");

const META = "a2646970667358221220";
const address = process.argv[2];
if (!address) throw new Error("缺少合约地址");

const root = join(__dirname, "..");
const tmp = join(root, "tmp-verify");
mkdirSync(tmp, { recursive: true });

const info = JSON.parse(readFileSync(join(root, "artifacts", "build-info", "c6e898b9c8ed6fd1ed757501c4cbf6c0.json"), "utf8"));
const settings = info.input.settings;

function metaOf(code) {
  const i = code.lastIndexOf(META);
  return i < 0 ? "" : code.slice(i + META.length, i + META.length + 64);
}

function compileAt(rev) {
  const files = execSync(`git ls-tree -r --name-only ${rev} -- contracts/contracts`, { cwd: join(root, "..") })
    .toString().split(/\r?\n/).filter((f) => f.endsWith(".sol"));
  const sources = {};
  for (const f of files) {
    sources[f] = { content: execSync(`git show ${rev}:${f}`, { cwd: join(root, ".."), maxBuffer: 20e6 }).toString() };
  }
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings })));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) return { error: errors[0].formattedMessage.split("\n").slice(0, 3).join(" ") };
  const contracts = out.contracts || {};
  const key = Object.keys(contracts).find((k) => /Campaign\.sol$/.test(k) && contracts[k].Campaign);
  if (!key) return { error: `no Campaign in ${Object.keys(contracts).join(",")} warnings=${JSON.stringify((out.errors || []).slice(0, 2))}` };
  const hex = contracts[key].Campaign.evm.deployedBytecode.object;
  return { hex, meta: metaOf(`0x${hex}`), info: out };
}

(async () => {
  const { ethers } = require("ethers");
  const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.bnbchain.org");
  const onchain = (await provider.getCode(address)).toLowerCase();
  const want = metaOf(onchain);
  console.log("chain meta", want, "bytes", (onchain.length - 2) / 2);

  const revs = execSync("git log --format=%h -n 12 -- contracts/contracts/Campaign.sol", { cwd: join(root, "..") })
    .toString().split(/\s+/).filter(Boolean);
  for (const rev of revs) {
    const date = execSync(`git log -1 --format=%ci ${rev}`, { cwd: join(root, "..") }).toString().trim();
    const r = compileAt(rev);
    if (r.error) { console.log(rev, date, "compile error:", r.error.slice(0, 160)); continue; }
    const hit = r.meta === want;
    console.log(rev, date, "bytes", r.hex.length / 2, hit ? "MATCH" : "no");
    if (hit) {
      writeFileSync(join(tmp, "hit.json"), JSON.stringify({ rev, date, output: r.info }, null, 0));
      return;
    }
  }
  console.log("no match");
})();
