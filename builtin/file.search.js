/**
{
  "scriptName": "file.search.js",
  "scriptDesc": "在授权文件或目录中搜索字面关键词。输入 {query:string|string[],path?,caseSensitive?,include?,exclude?,respectGitignore?,contextLines?,encoding?,limit?,offset?}；query 必填，最多16个关键词 OR 匹配，同一行计一次；每项1–256字符，不含 NUL/CR/LF。path 默认 .，有 Project 时相对于项目根目录，否则相对于 context.pwd；caseSensitive 默认 false，contextLines 0–5（默认2），include/exclude 为相对目标目录的 Glob 数组，respectGitignore 默认 true，encoding 默认 auto，limit 1–100（默认40），offset 默认0。返回带路径、行号及去重上下文的 Markdown；按 nextOffset 保持筛选续读，未完整扫描或有跳过文件不能断言不存在。不跟随软链接/Junction。",
  "scriptWhenUse": "按文本定位代码或文件；深入阅读用 nexum/file.read.js。",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "anyOf": [
          {
            "type": "string",
            "minLength": 1,
            "maxLength": 256,
            "pattern": "^[^\\x00\\r\\n]+$"
          },
          {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256,
              "pattern": "^[^\\x00\\r\\n]+$"
            }
          }
        ]
      },
      "path": {
        "type": "string",
        "maxLength": 4096,
        "description": "文件或目录有 Project 时相对于项目根目录，否则相对于 context.pwd，默认 .。"
      },
      "caseSensitive": {
        "type": "boolean"
      },
      "include": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        }
      },
      "exclude": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        }
      },
      "respectGitignore": {
        "type": "boolean"
      },
      "contextLines": {
        "type": "integer",
        "minimum": 0,
        "maximum": 5,
        "description": "默认 2，前后文按实际行号去重。"
      },
      "encoding": {
        "enum": [
          "auto",
          "utf-8",
          "utf-16le",
          "utf-16be",
          "gb18030",
          "gbk",
          "shift_jis",
          "big5",
          "euc-kr",
          "windows-1252"
        ],
        "description": "默认 auto：BOM 或严格 UTF-8；已知其他编码时显式指定。"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "description": "默认 40，另受输出预算。"
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991,
        "description": "跳过匹配行；默认 0。工作树变化可能导致重复或遗漏。"
      }
    },
    "required": [
      "query"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "按文件分组的紧凑 Markdown；> 标记命中行，… 表示片段省略；末尾说明完整性和可用 nextOffset。"
  }
}
*/
const fs = await import("node:fs/promises");
const { constants } = await import("node:fs");
const path = await import("node:path");
const root = await fs.realpath(context.project?.root ?? context.pwd);
const input = context.input;
const relative = input.path || ".";
const limit = input.limit ?? 40;
const offset = input.offset ?? 0;
const contextLines = input.contextLines ?? 2;
const include = input.include ?? [];
const exclude = input.exclude ?? [];
const respectGitignore = input.respectGitignore !== false;
const deadline = Date.now() + 5000;
const maxScan = 20000;
const maxOutput = 12 * 1024 - 512;
let remaining = 64 * 1024 * 1024;
const skipRecursion = new Set([".git", "node_modules", "dist", "build", ".cache", ".next", "coverage", ".platform-controls"]);
const queries = [...new Set(Array.isArray(input.query) ? input.query : [input.query])];
const patterns = queries.map(query => new RegExp(query.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), input.caseSensitive ? "u" : "iu"));
const overlap = Math.max(...queries.map(query => query.length)) + 140;
const slashPath = (base, target) => path.relative(base, target).split(path.sep).join("/");
const matches = (rules, name) => rules.some(rule => path.posix.matchesGlob(name, rule));
const label = value => /[\u0000-\u001f\u007f\\]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
const safeSlice = (value, start, end) => value.slice(start, end).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, "");
let reason = null;
let scanned = 0;
let scannedFiles = 0;
let omitted = 0;
let matched = 0;
let returned = 0;
let outputBytes = 0;
let nextOffset = null;
const sections = [];

if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) ||
    relative.split(/[\\/]/).includes("..") || (path.sep === "\\" && relative.includes(":"))) {
  throw Error("file_path_escape: path relative to Project root or current working directory required");
}
const initial = path.resolve(root, relative);
function expired() {
  if (Date.now() < deadline) return false;
  reason = "time_budget";
  return true;
}
function fingerprint(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
async function verify(target) {
  const info = await fs.lstat(target, { bigint: true });
  const actual = await fs.realpath(target);
  const inside = path.relative(root, actual);
  if (info.isSymbolicLink() || inside === ".." || inside.startsWith(".." + path.sep) ||
      path.isAbsolute(inside) || path.relative(target, actual) !== "") {
    throw Error("file_path_escape: search target outside file-script root or redirected");
  }
  return info;
}
let current = root;
for (const part of path.relative(root, initial).split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  await verify(current);
}
const initialInfo = await verify(initial);
const base = initialInfo.isDirectory() ? initial : path.dirname(initial);
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


let inGit = false;
if (respectGitignore) {
  current = root;
  inGit = await hasGitMarker(root);
  for (const part of path.relative(root, base).split(path.sep).filter(Boolean)) {
    if (reason || expired()) break;
    current = path.join(current, part);
    inGit = await hasGitMarker(current) || inGit;
  }
}
function decoderFor(bytes) {
  let bom;
  if (bytes.length >= 4 && (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 254, 255])) ||
      bytes.subarray(0, 4).equals(Buffer.from([255, 254, 0, 0])))) throw Error("unsupported encoding");
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) bom = "utf-8";
  else if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) bom = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) bom = "utf-16be";
  const requested = input.encoding ?? "auto";
  if (bom && requested !== "auto" && requested !== bom) throw Error("encoding conflicts with BOM");
  return new TextDecoder(requested === "auto" ? bom ?? "utf-8" : requested, { fatal: true });
}
function renderGroup(file, hits) {
  const rows = new Map();
  for (const hit of hits) {
    for (const row of [...hit.before, ...hit.after]) if (!rows.has(row.number)) rows.set(row.number, { ...row, hit: false });
    rows.set(hit.row.number, { ...hit.row, hit: true, keywords: hit.keywords });
  }
  const lines = [];
  let last = 0;
  for (const row of [...rows.values()].sort((a,b) => a.number-b.number)) {
    if (last && row.number > last + 1) lines.push("    …");
    const keywordNote = row.hit && queries.length > 1 ? " [matched: " + row.keywords.map(label).join(", ") + "]" : "";
    lines.push("    " + (row.hit ? "> " : "  ") + row.number + " | " + row.text + keywordNote);
    last = row.number;
  }
  return "## " + label(slashPath(root, file)) + "\n\n" + lines.join("\n");
}
async function scanFile(file) {
  const info = await verify(file);
  if (!info.isFile()) return;
  const flags = constants.O_RDONLY | (path.sep === "\\" ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const handle = await fs.open(file, flags);
  const revision = fingerprint(info);
  const hits = [];
  let count = 0;
  let number = 1;
  let prefix = "";
  let tail = "";
  let length = 0;
  let snippet = null;
  let keywords = new Set();
  const history = [];
  let pending = [];
  let position = 0;
  let decoder;
  const cap = Math.min(32 * 1024 * 1024, remaining, Number(info.size));
  const buffer = Buffer.allocUnsafe(64 * 1024);
  function part(text) {
    if (!text) return;
    if (prefix.length < 300) prefix += text.slice(0, 300 - prefix.length);
    const window = tail + text;
    for (let i = 0; i < patterns.length; i++) {
      if (keywords.has(i)) continue;
      const hit = patterns[i].exec(window);
      if (!hit) continue;
      keywords.add(i);
      if (snippet === null) {
        const start = Math.max(0, hit.index - 120);
        const end = Math.min(window.length, hit.index + hit[0].length + 120);
        snippet = {
          value: (length - tail.length + start > 0 ? "…" : "") + safeSlice(window, start, end),
          end: length - tail.length + end
        };
      }
    }
    length += text.length;
    tail = safeSlice(window, -overlap);
  }
  function finishLine() {
    const contextRow = { number, text: safeSlice(prefix, 0, 300) + (length > prefix.length ? "…" : "") };
    for (const hit of pending) hit.after.push(contextRow);
    pending = pending.filter(hit => hit.after.length < contextLines);
    if (keywords.size) {
      const rank = matched + count++;
      if (rank >= offset && hits.length < limit - returned + 1) {
        const hit = {
          row: { number, text: snippet.value + (snippet.end < length ? "…" : "") },
          keywords: [...keywords].map(i => queries[i]), before: history.slice(), after: []
        };
        hits.push(hit);
        if (contextLines) pending.push(hit);
      }
    }
    if (contextLines) {
      history.push(contextRow);
      if (history.length > contextLines) history.shift();
    }
    number++;
    prefix = ""; tail = ""; length = 0; snippet = null; keywords = new Set();
  }
  function consume(text) {
    if (text.includes("\0")) throw Error("not text");
    let at = 0;
    while (at < text.length) {
      const newline = text.indexOf("\n", at);
      if (newline === -1) { part(text.slice(at)); break; }
      part(text.slice(at, newline));
      finishLine();
      at = newline + 1;
    }
  }
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== revision) throw Error("changed");
    if (cap < 4 && BigInt(cap) < info.size) { reason = "scan_budget"; return; }
    while (position < cap) {
      if (expired()) break;
      const want = Math.min(buffer.length, cap - position);
      let size = 0;
      while (size < want) {
        const { bytesRead } = await handle.read(buffer, size, want - size, position + size);
        if (!bytesRead) throw Error("changed");
        size += bytesRead;
      }
      position += size;
      remaining -= size;
      const bytes = buffer.subarray(0, size);
      decoder ??= decoderFor(bytes);
      consume(decoder.decode(bytes, { stream: true }));
    }
    const complete = BigInt(position) === info.size;
    if (complete) {
      decoder ??= decoderFor(Buffer.alloc(0));
      consume(decoder.decode(new Uint8Array(0)));
      finishLine();
    } else if (!reason) reason = "scan_budget";
    if (fingerprint(await handle.stat({ bigint: true })) !== revision ||
        fingerprint(await verify(file)) !== revision) throw Error("changed");
    // Commit only complete lines from the same verified file. An invalid
    // decoder or changed file discards its tentative matches.
    scannedFiles++;
    const page = [];
    for (const hit of hits) {
      const candidate = renderGroup(file, [...page, hit]);
      const cost = Buffer.byteLength(candidate) + 2;
      if (returned + page.length >= limit || outputBytes + cost > maxOutput) {
        if (!reason) {
          reason = returned + page.length >= limit ? "limit" : "output_budget";
          if (returned + page.length > 0) nextOffset = offset + returned + page.length;
        }
        break;
      }
      page.push(hit);
    }
    if (page.length) {
      const section = renderGroup(file, page);
      sections.push(section);
      outputBytes += Buffer.byteLength(section) + 2;
      returned += page.length;
    }
    matched += count;
  } finally { await handle.close(); }
}
async function searchOne(file) {
  if (expired()) return;
  if (!remaining) { reason = "scan_budget"; return; }
  try { await scanFile(file); }
  catch (error) {
    if (String(error.message).startsWith("file_path_escape:")) throw error;
    omitted++;
  }
}
const queue = initialInfo.isDirectory() ? [{ dir: initial, inGit }] : [];
if (!initialInfo.isDirectory() && !reason) {
  if (!initialInfo.isFile()) throw Error("file_path_escape: expected regular file or directory");
  const name = path.basename(initial);
  const ignored = inGit ? await ignoredByGit(base, [{ name, isDirectory: () => false }]) : new Set();
  if (!reason && !ignored.has("./" + name) && !matches(exclude, name) && (!include.length || matches(include, name))) await searchOne(initial);
}
for (let index = 0; index < queue.length && !reason; index++) {
  if (expired()) break;
  const work = queue[index];
  const children = [];
  try {
    if (!(await verify(work.dir)).isDirectory()) throw Error("directory changed");
    for await (const item of await fs.opendir(work.dir)) {
      if (expired()) break;
      if (scanned >= maxScan) { reason = "scan_budget"; break; }
      scanned++;
      children.push(item);
    }
  } catch (error) {
    if (index === 0 || String(error.message).startsWith("file_path_escape:")) throw error;
    reason = "directory_unavailable";
  }
  if (reason || expired()) break;
  children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const candidates = [];
  for (const item of children) {
    if (expired()) break;
    const scoped = slashPath(base, path.join(work.dir, item.name));
    if (!item.isSymbolicLink() && !matches(exclude, scoped) &&
        !(item.isDirectory() && skipRecursion.has(item.name)) &&
        (item.isDirectory() || (item.isFile() && (!include.length || matches(include, scoped))))) candidates.push(item);
  }
  if (reason) break;
  const useGit = respectGitignore && (await hasGitMarker(work.dir) || work.inGit);
  if (reason) break;
  const ignored = useGit ? await ignoredByGit(work.dir, candidates) : new Set();
  if (reason) break;
  for (const item of candidates) {
    if (expired() || reason) break;
    if (ignored.has("./" + item.name + (item.isDirectory() ? "/" : ""))) continue;
    const full = path.join(work.dir, item.name);
    if (item.isDirectory()) queue.push({ dir: full, inGit: useGit });
    else await searchOne(full);
  }
}
let footer;
if (reason) {
  footer = "Search incomplete (" + reason + "): " + returned + " matching lines returned.";
  if (nextOffset !== null) footer += " Continue with offset=" + nextOffset + " (nextOffset).";
  else footer += " No reliable nextOffset; narrow the path or filters.";
} else {
  footer = (omitted ? "Search incomplete (skipped_files): " : "Search complete in the eligible text files: ") + matched + " matching lines" +
    (offset ? "; returned " + returned + " from offset " + offset : "") + ".";
}
footer += " Scanned " + scannedFiles + " files.";
if (omitted) footer += " Skipped " + omitted + " unreadable, changed or undecodable files; coverage is incomplete.";
if (reason === "gitignore_unavailable") footer += " Git ignore check unavailable; disable respectGitignore only if appropriate.";
if (!sections.length) footer = "No matches returned. " + footer;
return (sections.length ? sections.join("\n\n") + "\n\n" : "") + footer;
