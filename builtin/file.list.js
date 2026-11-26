/**
{
  "scriptName": "file.list.js",
  "scriptDesc": "查看授权目录树。输入 {path?,depth?,include?,exclude?,respectGitignore?,limit?,offset?}；path 默认 .，有 Project 时相对于项目根目录，否则相对于 context.pwd；depth 1–8（默认1），include/exclude 为相对目标目录的 Glob 字符串数组，respectGitignore 默认 true，limit 1–500（默认200），offset 默认0（最大20000）。返回文本目录树，路径相对于同一根；按 nextOffset 保持筛选续读，探索不完整则缩小范围。不跟随软链接/Junction。",
  "scriptWhenUse": "定位文件或了解目录结构；搜索正文用 nexum/file.search.js。",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "maxLength": 4096,
        "description": "目录有 Project 时相对于项目根目录，否则相对于 context.pwd，默认 .；不经过软链接。"
      },
      "depth": {
        "type": "integer",
        "minimum": 1,
        "maximum": 8,
        "description": "目录展开层数，默认 1，最大 8。"
      },
      "include": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "description": "相对于目标 path 的 POSIX Glob；仅返回匹配条目，不阻断子目录探索。"
      },
      "exclude": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "description": "相对于目标 path 的 POSIX Glob；匹配的目录不再展开。"
      },
      "respectGitignore": {
        "type": "boolean",
        "description": "默认 true，使用授权根目录内 Git 工作树的忽略规则（包括嵌套规则，按 --no-index 匹配）；false 时不检查 Git。"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500,
        "description": "默认 200；还受实际输出字节预算限制。"
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "maximum": 20000,
        "description": "默认 0；跳过筛选后的匹配条目，下一页使用返回的 nextOffset。目录变动可能造成重复或遗漏。"
      }
    },
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "紧凑目录列表。分页时给出 nextOffset；扫描不完整时说明原因，不输出虚假总数。"
  }
}
*/
const fs = await import("node:fs/promises");
const path = await import("node:path");
const root = await fs.realpath(context.project?.root ?? context.pwd);
const input = context.input ?? {};
const relative = input.path || ".";
const depth = input.depth ?? 1;
const limit = input.limit ?? 200;
const offset = input.offset ?? 0;
const include = input.include ?? [];
const exclude = input.exclude ?? [];
const respectGitignore = input.respectGitignore !== false;
const maxScan = 20000;
// Reserve space for the result envelope as well as the returned paths.
const maxOutputBytes = 12 * 1024 - 512;
const deadline = Date.now() + 5000;
const skipRecursion = new Set([".git", "node_modules", "dist", "build", ".cache", ".next", "coverage", ".platform-controls"]);

if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).includes("..")) {
  throw Object.assign(Error("file_path_escape: path relative to Project root or current working directory required"), { nexumBuiltinFailure: { code: "file_path_escape" } });
}
function contained(directory) {
  const inside = path.relative(root, directory);
  return inside !== ".." && !inside.startsWith(".." + path.sep) && !path.isAbsolute(inside);
}
async function verifyDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(Error("file_path_escape: target must be a real directory"), { nexumBuiltinFailure: { code: "file_path_escape" } });
  const actual = await fs.realpath(directory);
  if (!contained(actual) || path.relative(directory, actual) !== "") throw Object.assign(Error("file_path_escape: directory outside file-script root or redirected"), { nexumBuiltinFailure: { code: "file_path_escape" } });
}
const directory = path.resolve(root, relative);
// Reject links in any explicit path component, not just the last component.
let current = root;
for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
  current = path.join(current, component);
  await verifyDirectory(current);
}
const slashPath = (base, target) => path.relative(base, target).split(path.sep).join("/");
const matches = (patterns, name) => patterns.some((pattern) => path.posix.matchesGlob(name, pattern));
let reason = null;
let scanned = 0;
let matched = 0;
let outputBytes = 0;
let nextOffset = null;
let returned = 0;
let lastParent = null;
const rows = [];
// Escape control characters and ambiguous names without repeating JSON keys.
const label = (value) => /[\u0000-\u001f\u007f\\"]|^\s|\s$| \[(?:symlink|other)\]$/.test(value) ? JSON.stringify(value) : value;

function expired() {
  if (Date.now() < deadline) return false;
  reason = "time_budget";
  return true;
}
async function hasGitMarker(dir) {
  try {
    const info = await fs.lstat(path.join(dir, ".git"));
    // Never follow a redirected .git marker to discover a worktree.
    if (info.isSymbolicLink()) {
      reason = "gitignore_unavailable";
      return false;
    }
    return info.isDirectory() || info.isFile();
  } catch (error) {
    if (error.code !== "ENOENT") reason = "gitignore_unavailable";
    return false;
  }
}
// Discover worktrees only within the authorized project, not its parents.
let inGit = false;
if (respectGitignore) {
  current = root;
  inGit = await hasGitMarker(current);
  for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    if (reason || expired()) break;
    current = path.join(current, component);
    inGit = await hasGitMarker(current) || inGit;
  }
}

async function ignoredByGit(dir, children) {
  const ignored = new Set();
  // NUL-delimited stdin/stdout is lossless for whitespace and newlines.
  // Keep each call's entire output within the existing sh output page budget.
  const names = children.map((item) => "./" + item.name + (item.isDirectory() ? "/" : ""));
  let batch = [];
  let bytes = 0;
  async function checkBatch() {
    if (batch.length === 0 || expired()) return;
    try {
      const result = await sh.exec({
        command: "git",
        args: ["check-ignore", "--no-index", "-z", "--stdin"],
        cwd: dir,
        input: Buffer.from(batch.join("\0") + "\0", "utf8"),
        env: { GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, GIT_CEILING_DIRECTORIES: path.dirname(root) },
        timeoutMs: Math.max(1, deadline - Date.now()),
        check: false
      });
      if (![0, 1].includes(result.exitCode) || !result.outputComplete || result.hasMoreOutput || result.truncated) {
        throw Error("Git ignore check did not return complete output");
      }
      const data = Buffer.concat(result.output.filter((part) => part.stream === "stdout").map((part) => Buffer.from(part.data)));
      const stdout = new TextDecoder("utf-8", { fatal: true }).decode(data);
      const found = stdout === "" ? [] : stdout.slice(0, -1).split("\0");
      const allowed = new Set(batch);
      if ((stdout !== "" && !stdout.endsWith("\0")) || found.some((name) => !allowed.has(name)) ||
          (result.exitCode === 1 && found.length !== 0) || (result.exitCode === 0 && found.length === 0)) {
        throw Error("Git ignore check returned unexpected paths");
      }
      for (const name of found) ignored.add(name);
    } catch {
      reason = Date.now() >= deadline ? "time_budget" : "gitignore_unavailable";
    }
    batch = [];
    bytes = 0;
  }
  for (const name of names) {
    const size = Buffer.byteLength(name) + 1;
    if (bytes + size > 16 * 1024) await checkBatch();
    if (reason) break;
    batch.push(name);
    bytes += size;
  }
  if (!reason) await checkBatch();
  return ignored;
}

// Breadth-first: list the current directory before descending into its children.
// Sort each complete directory by a locale-independent name order. Do not
// manufacture a resumable page from a partially enumerated directory.
const queue = [{ dir: directory, level: 1, inGit }];
for (let index = 0; index < queue.length && !reason; index++) {
  if (expired()) break;
  const work = queue[index];
  const children = [];
  try {
    await verifyDirectory(work.dir);
    const handle = await fs.opendir(work.dir);
    for await (const item of handle) {
      if (expired()) break;
      if (scanned >= maxScan) {
        reason = "scan_budget";
        break;
      }
      scanned++;
      children.push(item);
    }
  } catch (error) {
    // An explicitly requested inaccessible directory is an error, not empty.
    if (index === 0 || String(error.message).startsWith("file_path_escape:")) throw error;
    reason = "directory_unavailable";
  }
  if (reason || expired()) break;
  children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const candidates = [];
  for (const item of children) {
    if (expired()) break;
    if (!matches(exclude, slashPath(directory, path.join(work.dir, item.name)))) candidates.push(item);
  }
  if (expired()) break;
  const useGit = respectGitignore && (await hasGitMarker(work.dir) || work.inGit);
  if (reason || expired()) break;
  const ignored = useGit ? await ignoredByGit(work.dir, candidates) : new Set();
  if (reason) break;
  for (const item of candidates) {
    if (expired()) break;
    if (ignored.has("./" + item.name + (item.isDirectory() ? "/" : ""))) continue;
    const full = path.join(work.dir, item.name);
    const scoped = slashPath(directory, full);
    const type = item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : item.isFile() ? "file" : "other";
    if (type === "directory" && work.level < depth && !skipRecursion.has(item.name)) {
      queue.push({ dir: full, level: work.level + 1, inGit: useGit });
    }
    if (include.length && !matches(include, scoped)) continue;
    if (matched < offset) {
      matched++;
      continue;
    }
    const parent = slashPath(root, work.dir) || ".";
    const suffix = type === "directory" ? "/" : type === "symlink" ? " [symlink]" : type === "other" ? " [other]" : "";
    const row = (parent !== lastParent ? "    " + label(parent) + "/\n" : "") + "      " + label(item.name) + suffix + "\n";
    const size = Buffer.byteLength(row);
    if (returned >= limit || outputBytes + size > maxOutputBytes) {
      reason = returned >= limit ? "limit" : "output_budget";
      if (returned) nextOffset = offset + returned;
      break;
    }
    rows.push(row);
    lastParent = parent;
    returned++;
    outputBytes += size;
    matched++;
  }
}
let footer = reason === null
  ? "Directory listing complete: " + matched + " matching entries" + (offset ? "; returned " + returned + " from offset " + offset : "") + "."
  : "Directory listing incomplete (" + reason + "): " + returned + " matching entries returned.";
if (nextOffset !== null) footer += " Continue with offset=" + nextOffset + " (nextOffset).";
else if (reason !== null) footer += " No reliable nextOffset; narrow the directory or filters.";
if (reason === "gitignore_unavailable") footer += " Git ignore check unavailable; use respectGitignore:false only if appropriate.";
if (!rows.length && reason === null) footer = "No entries on this page. " + footer;
return (rows.length ? rows.join("").trimEnd() + "\n\n" : "") + footer;
