import { execSync } from "node:child_process";

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error("缺少 GH_TOKEN 环境变量");
const REPO = "knwins/miner-dianlu";
const API = "https://api.github.com";

/**
 * 分叉对齐参数（本地历史与远端同内容不同 SHA 时用）：
 *
 *   --base <remoteSha>     远端父提交 SHA。快进守卫以它为准，新提交也挂在它下面。
 *   --diff-base <localSha> 本地 diff 基准。对象库里有、且其树与 --base 的树相同。
 *
 * 典型场景：远端已有一个提交（比如上次 API 推送建的），本地 rebase 后有了
 * 不同 SHA 的同内容提交。此时本地 HEAD~1 与远端 main 对不上，快进守卫会拦，
 * 用这两个参数显式指定即可，树 sha 校验仍然强制内容一致。
 */
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const BASE = argOf("--base");
const DIFF_BASE = argOf("--diff-base");

const HEAD = execSync("git rev-parse HEAD").toString().trim();
const PARENT = BASE || execSync("git rev-parse HEAD~1").toString().trim();
const DIFF_FROM = DIFF_BASE || PARENT;
const LOCAL_TREE = execSync("git show -s --format=%T HEAD").toString().trim();

async function api(path, method = "GET", body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `token ${TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "miner-dianlu-push",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${(json && json.message) || text.slice(0, 300)}`);
  }
  return json;
}

// 1) 远端 main 必须等于本地父提交，否则不是快进，中止
const ref = await api(`/repos/${REPO}/git/refs/heads/main`);
if (ref.object.sha !== PARENT) {
  throw new Error(`远端 main = ${ref.object.sha}，本地父提交 = ${PARENT}，不是快进，已中止`);
}
console.log(`快进检查通过：远端 main = 本地父提交 ${PARENT.slice(0, 7)}`);

const remoteCommit = await api(`/repos/${REPO}/git/commits/${PARENT}`);
const baseTree = remoteCommit.tree.sha;

// 2) 变更文件：blob 内容一律取 git 对象库（不用工作区文件，避开 CRLF 转换）
const raw = execSync(`git diff --no-renames --no-abbrev --raw ${DIFF_FROM} ${HEAD}`, { maxBuffer: 64 * 1024 * 1024 })
  .toString().trim().split("\n");
const tree = [];
let uploads = 0;
for (const line of raw) {
  const m = line.match(/^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ACDMT])\t(.*)$/);
  if (!m) throw new Error(`无法解析 diff 行：${line}`);
  const [, , newMode, , newSha, status, path] = m;
  if (status === "D") {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
    continue;
  }
  const content = execSync(`git cat-file blob ${newSha}`, { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  const blob = await api(`/repos/${REPO}/git/blobs`, "POST", {
    content: content.toString("base64"),
    encoding: "base64",
  });
  uploads += 1;
  if (blob.sha !== newSha) {
    throw new Error(`blob sha 不符：${path} 本地 ${newSha} vs API ${blob.sha}`);
  }
  tree.push({ path, mode: newMode, type: "blob", sha: blob.sha });
}
console.log(`blob 上传 ${uploads} 个，全部与本地对象库 sha 一致`);

// 3) 建树（基于远端父树 + 变更项），并校验与本地树完全一致
const newTree = await api(`/repos/${REPO}/git/trees`, "POST", { base_tree: baseTree, tree });
if (newTree.sha !== LOCAL_TREE) {
  throw new Error(`树 sha 不符：API ${newTree.sha} vs 本地 ${LOCAL_TREE}，内容有差异，已中止`);
}
console.log(`树校验通过：${tree.length} 项变更，树 sha 与本地提交逐字节一致`);

// 4) 建提交：作者/提交者/时间戳取自本地提交，保证与本地 8a119a9 同树同父同信息
const [an, ae, aI, cn, ce, cI] = execSync("git log -1 --format=%an%n%ae%n%aI%n%cn%n%ce%n%cI")
  .toString().trim().split("\n");
const message = execSync("git log -1 --format=%B").toString();
const commit = await api(`/repos/${REPO}/git/commits`, "POST", {
  message,
  tree: newTree.sha,
  parents: [PARENT],
  author: { name: an, email: ae, date: aI },
  committer: { name: cn, email: ce, date: cI },
});
console.log(`提交已创建：${commit.sha}`);

// 5) 快进更新 main
await api(`/repos/${REPO}/git/refs/heads/main`, "PATCH", { sha: commit.sha, force: false });
console.log(`✓ 已推送到 origin/main：${commit.sha}`);
