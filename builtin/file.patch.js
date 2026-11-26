/**
{
  "scriptName": "file.patch.js",
  "scriptDesc": "按 Codex apply_patch 语法批量创建、修改、删除或移动授权文本文件。输入 {patch:string}，完整 *** Begin Patch / *** End Patch 文本；*** Add File:、*** Update File:、*** Delete File:，移动用 Update File + *** Move to:；@@、空格上下文、+/-、*** End of File。路径有 Project 时相对于项目根目录，否则相对于 context.pwd，不跟随软链接/Junction；无 Markdown 围栏或 shell，最多64项且1 MiB。整体预检、逐文件写入回读，返回 A/M/D/R 与验证摘要；部分失败先核对实际文件及 Run 日志，不盲目重试。",
  "scriptWhenUse": "需要修改已有或新增文本文件时；先读取实际上下文。",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "patch": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1048576,
        "description": "完整 Codex apply_patch 文本，路径有 Project 时相对于项目根目录，否则相对于 context.pwd；不包含 shell、heredoc 或 Markdown 围栏。最多 64 个文件操作、1 MiB UTF-8。"
      }
    },
    "required": [
      "patch"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "已验证的 A/M/D/R 文件列表及完成摘要；失败 Run 的日志说明预检拒绝或实际部分执行状态。"
  }
}
*/
// Independent JS implementation of the Codex apply_patch language and
// matching strategy, based on openai/codex ebd0765aafa255d63ebf690ebdffe0164dc14a0c,
// codex-rs/apply-patch/src/{parser,streaming_parser,seek_sequence,file_update,text_file}.rs.
// Nexum uses stricter paths, unambiguous matching, preflight and verified writes.
// OpenAI Codex, Copyright 2025 OpenAI, Apache-2.0 (license at end of source).
const fs = await import("node:fs/promises");
const { constants } = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");
const MiB = 1024 * 1024;
const maxFile = 8 * MiB;
const maxTotal = 32 * MiB;
const deadline = Date.now() + 10000;
let comparisons = 0;
let totalBytes = 0;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const issue = (code, detail) => Object.assign(new Error(code + ": " + detail), { patchCode: code, patchDetail: detail });
const syntax = (line, detail) => issue("invalid_patch", "Patch line " + line + ": " + detail);
const conflict = detail => issue("file_patch_conflict", detail);
const label = value => JSON.stringify(value);
function checkBudget() {
  if (Date.now() >= deadline || comparisons > 10000000) throw issue("file_patch_budget", "Patch processing budget exhausted; split the patch into smaller independent changes.");
}
const begin = "*** Begin Patch", end = "*** End Patch", eof = "*** End of File";
const add = "*** Add File: ", update = "*** Update File: ", remove = "*** Delete File: ", move = "*** Move to: ";
function portablePath(raw, line) {
  if (!raw || Buffer.byteLength(raw) > 1024 || /[\u0000-\u001f\u007f]/.test(raw) ||
      path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw issue("file_path_escape", "Patch line " + line + ": expected a file path relative to Project root or current working directory.");
  }
  const parts = raw.replaceAll("\\", "/").split("/").filter(part => part !== ".");
  if (parts.length > 64 || parts.some(part => !part || part === ".." || /[<>:"|?*]/.test(part) ||
      /[. ]$/.test(part) || Buffer.byteLength(part) > 255 ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) ||
      /^(?:\.git|\.platform-controls)$/i.test(part) || /^\.nexum-patch-/i.test(part))) {
    throw issue("file_path_escape", "Patch line " + line + ": unsafe, reserved, or ambiguous file path.");
  }
  if (!parts.length) throw issue("file_path_escape", "Patch line " + line + ": expected a file, not the file-script root.");
  return parts.join("/");
}
function parsePatch(patch) {
  if (typeof patch !== "string" || !patch.isWellFormed() || patch.includes("\0")) throw syntax(1, "expected well-formed text.");
  if (Buffer.byteLength(patch) > MiB) throw issue("file_too_large", "Patch exceeds 1 MiB.");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > 100000) throw issue("file_patch_budget", "Too many patch lines.");
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() !== begin) throw syntax(i + 1, "expected *** Begin Patch.");
  i++;
  if (lines.at(-1)?.trim() !== end) throw syntax(lines.length, "expected *** End Patch.");
  const ops = [];
  const targets = new Map();
  let pathBytes = 0, chunks = 0;
  const key = name => name.normalize("NFC").toLowerCase();
  function reserve(name, line) {
    const id = key(name);
    for (const known of targets.keys()) {
      if (known === id || known.startsWith(id + "/") || id.startsWith(known + "/")) {
        throw conflict("Patch line " + line + ": overlapping or repeated file paths; combine edits to the same file into one Update File.");
      }
    }
    targets.set(id, name);
    pathBytes += Buffer.byteLength(name);
    if (pathBytes > 12 * 1024) throw issue("file_patch_budget", "Patch file path list is too large.");
  }
  function header(line) {
    return line === end || line.startsWith(add) || line.startsWith(update) || line.startsWith(remove);
  }
  while (i < lines.length - 1) {
    checkBudget();
    const lineNo = i + 1;
    const line = lines[i++].trimStart();
    if (!line.trim()) continue;
    if (ops.length >= 64) throw issue("file_patch_budget", "Patch contains more than 64 file operations.");
    const marker = [add, update, remove].find(prefix => line.startsWith(prefix));
    if (!marker) throw syntax(lineNo, "expected Add File, Update File, or Delete File.");
    const name = portablePath(line.slice(marker.length), lineNo);
    reserve(name, lineNo);
    const op = { kind: marker === add ? "A" : marker === remove ? "D" : "M", name, lineNo, chunks: [] };
    ops.push(op);
    if (op.kind === "A") {
      const added = [];
      while (i < lines.length - 1 && !header(lines[i].trim())) {
        if (!lines[i].startsWith("+")) throw syntax(i + 1, "Add File lines must start with +.");
        added.push(lines[i++].slice(1));
      }
      op.added = added.length ? added.join("\n") + "\n" : "";
      continue;
    }
    if (op.kind === "D") continue;
    if (lines[i]?.startsWith(move)) {
      op.destination = portablePath(lines[i].slice(move.length), i + 1);
      reserve(op.destination, i + 1);
      op.kind = "R";
      i++;
    }
    let chunk = null;
    while (i < lines.length - 1 && !header(lines[i].trimEnd())) {
      const at = i + 1, raw = lines[i++], control = raw.trimEnd();
      if (control === "@@" || control.startsWith("@@ ")) {
        if (chunk && !chunk.rows.length) throw syntax(at, "empty change hunk.");
        chunk = { anchor: control === "@@" ? null : control.slice(3), rows: [], eof: false, lineNo: at };
        op.chunks.push(chunk);
        if (++chunks > 512) throw issue("file_patch_budget", "Patch contains more than 512 change hunks.");
        continue;
      }
      if (control === eof) {
        if (!chunk || !chunk.rows.length || chunk.eof) throw syntax(at, "unexpected End of File marker.");
        chunk.eof = true;
        continue;
      }
      if (chunk?.eof && !raw) continue;
      if (chunk?.eof) throw syntax(at, "expected a new @@ hunk after End of File.");
      if (!raw || /^[ +\-]/.test(raw)) {
        if (!chunk) {
          chunk = { anchor: null, rows: [], eof: false, lineNo: at };
          op.chunks.push(chunk);
          if (++chunks > 512) throw issue("file_patch_budget", "Too many change hunks.");
        }
        chunk.rows.push({ kind: raw ? raw[0] : " ", text: raw ? raw.slice(1) : "" });
      } else throw syntax(at, "change lines must start with space, +, or -.");
    }
    if (chunk && !chunk.rows.length) throw syntax(chunk.lineNo, "empty change hunk.");
    if (!op.chunks.length && !op.destination) throw syntax(lineNo, "Update File requires changes or Move to.");
  }
  if (!ops.length) throw syntax(1, "empty patch.");
  return ops;
}

const punctuation = text => text.trim()
  .replace(/[\u2010-\u2015\u2212]/g, "-")
  .replace(/[\u2018-\u201b]/g, "'")
  .replace(/[\u201c-\u201f]/g, '"')
  .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
const normalizers = [text => text, text => text.trimEnd(), text => text.trim(), punctuation];
// Linear-time sequence matching per strictness level. A unique named @@
// anchor uses Codex's first matching sequence after the anchor; without
// that anchor, reject equally good matches instead of choosing arbitrarily.
function locate(texts, wanted, start, atEnd, unique = true) {
  if (!wanted.length) return start;
  if (wanted.length > texts.length - start) return -1;
  for (const normalize of normalizers) {
    const needle = wanted.map(normalize);
    if (atEnd) {
      const index = texts.length - needle.length;
      if (index >= start && needle.every((value, j) => normalize(texts[index + j]) === value)) return index;
      continue;
    }
    const prefix = new Uint32Array(needle.length);
    for (let j = 1, n = 0; j < needle.length; j++) {
      while (n && needle[j] !== needle[n]) n = prefix[n - 1];
      if (needle[j] === needle[n]) n++;
      prefix[j] = n;
    }
    let found = -1;
    for (let j = start, n = 0; j < texts.length; j++) {
      if ((++comparisons & 2047) === 0) checkBudget();
      const value = normalize(texts[j]);
      while (n && value !== needle[n]) n = prefix[n - 1];
      if (value === needle[n]) n++;
      if (n === needle.length) {
        if (!unique) return j - needle.length + 1;
        if (found !== -1) return -2;
        found = j - needle.length + 1;
        n = prefix[n - 1];
      }
    }
    if (found !== -1) return found;
  }
  return -1;
}
function editBytes(bytes, op) {
  if (!op.chunks.length) return bytes;
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw issue("file_not_text", label(op.name) + " is not valid UTF-8."); }
  if (text.includes("\0")) throw issue("file_not_text", label(op.name) + " contains binary data.");
  const source = [];
  let preferred = "\n", at = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    if (!source.length) preferred = match[0];
    source.push({ text: text.slice(at, match.index), ending: match[0] });
    at = match.index + match[0].length;
    if (source.length > 200000) throw issue("file_patch_budget", label(op.name) + " exceeds the line budget.");
  }
  if (at < text.length) source.push({ text: text.slice(at), ending: "" });
  const ended = source.length === 0 || source.at(-1).ending !== "";
  const texts = source.map(row => row.text);
  let cursor = 0, outputCursor = 0;
  const result = [];
  for (const hunk of op.chunks) {
    checkBudget();
    const failMatch = (kind, at) => conflict(label(op.name) + ", patch line " + hunk.lineNo + ": " +
      (at === -2 ? "ambiguous " : "missing ") + kind + "; provide more exact surrounding context.");
    if (hunk.anchor !== null) {
      const anchorAt = locate(texts, [hunk.anchor], cursor, false);
      if (anchorAt < 0) throw failMatch("context anchor", anchorAt);
      cursor = anchorAt + 1;
    }
    let rows = hunk.rows;
    let wanted = rows.filter(row => row.kind !== "+").map(row => row.text);
    // Codex addition-only hunks append to EOF. Include context lines when
    // inserting at a specific location within a file.
    let index = wanted.length ? locate(texts, wanted, cursor, hunk.eof, hunk.anchor === null) : source.length;
    if (index === -1 && wanted.length > 1 && wanted.at(-1) === "") {
      // The final empty context line can stand for the terminating newline.
      // Restrict this fallback to actual EOF; never drop a real interior line.
      const lastOld = rows.findLastIndex(row => row.kind !== "+");
      if (rows[lastOld].kind === " ") {
        const shorter = wanted.slice(0, -1);
        const terminal = locate(texts, shorter, cursor, true);
        if (terminal >= 0) {
          index = terminal;
          wanted = shorter;
          rows = rows.filter((_, n) => n !== lastOld);
        }
      }
    }
    if (index < 0) throw failMatch("expected lines", index);
    if (index < outputCursor) throw conflict(label(op.name) + ": overlapping or out-of-order hunks.");
    for (let n = outputCursor; n < index; n++) result.push(source[n]);
    let oldIndex = index;
    for (const row of rows) {
      if (row.kind === " ") result.push(source[oldIndex++]);
      else if (row.kind === "-") oldIndex++;
      else result.push({ text: row.text, ending: preferred });
    }
    cursor = outputCursor = index + wanted.length;
  }
  for (let n = outputCursor; n < source.length; n++) result.push(source[n]);
  // Preserve the original final-newline convention and each untouched
  // terminator; inserted lines use the first observed style (or LF).
  const output = result.map((row, n) => row.text +
    (n === result.length - 1 && !ended ? "" : row.ending || preferred)).join("");
  const encoded = Buffer.from((bom ? "\ufeff" : "") + output, "utf8");
  if (encoded.length > maxFile) throw issue("file_too_large", label(op.name) + ": updated file exceeds 8 MiB.");
  return encoded;
}

const root = await fs.realpath(context.project?.root ?? context.pwd);
const identity = info => info.dev + ":" + info.ino;
const revision = info => [identity(info), info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(":");
const rootInfo = await fs.lstat(root, { bigint: true });
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Object.assign(Error("file_path_escape: invalid file-script root"), { nexumBuiltinFailure: { code: "file_path_escape" } });
const directoryIds = new Map([["", identity(rootInfo)]]);
const createdDirs = [];
const applied = [];
const plans = [];
let active = null;
let writing = false;
let cleanupWarning = null;
async function lstat(target) {
  try { return await fs.lstat(target, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function checkRoot() {
  const current = await lstat(root);
  if (!current?.isDirectory() || current.isSymbolicLink() || identity(current) !== identity(rootInfo) ||
      path.relative(root, await fs.realpath(root)) !== "") throw conflict("File-script root changed.");
}
// Record existing ancestor identities at preflight and recheck throughout.
// This is defense in depth, not an OS-level sandbox or race-free CAS.
async function inspect(name) {
  await checkRoot();
  const parts = name.split("/");
  let relative = "", current = root, missing = false;
  const missingParents = [];
  for (let i = 0; i < parts.length - 1; i++) {
    relative += (relative ? "/" : "") + parts[i];
    current = path.join(root, relative);
    const info = missing ? null : await lstat(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink() || path.relative(current, await fs.realpath(current)) !== "")) {
      throw issue("file_path_escape", label(relative) + ": parent is not a real directory.");
    }
    const actual = info ? identity(info) : null;
    if (directoryIds.has(relative) && directoryIds.get(relative) !== actual) throw conflict(label(relative) + ": parent directory changed.");
    directoryIds.set(relative, actual);
    if (!info) { missing = true; missingParents.push(relative); }
  }
  const target = path.join(root, name);
  const info = missing ? null : await lstat(target);
  if (info && (info.isSymbolicLink() || !info.isFile() || path.relative(target, await fs.realpath(target)) !== "")) {
    throw issue("file_path_escape", label(name) + ": expected a real regular file, not a redirected path.");
  }
  return { target, info, missingParents };
}
async function snapshot(name) {
  const { target, info } = await inspect(name);
  if (!info) return null;
  if (info.size > BigInt(maxFile)) throw issue("file_too_large", label(name) + ": file exceeds 8 MiB.");
  if (info.nlink > 1n) throw conflict(label(name) + ": multiply-linked files are not patched.");
  const flags = constants.O_RDONLY | (path.sep === "\\" ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const fd = await fs.open(target, flags);
  try {
    const stat = await fd.stat({ bigint: true });
    if (!stat.isFile() || revision(stat) !== revision(info)) throw conflict(label(name) + ": file changed before reading.");
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      checkBudget();
      const { bytesRead } = await fd.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw conflict(label(name) + ": file changed while reading.");
      offset += bytesRead;
    }
    const after = await inspect(name);
    if (!after.info || revision(after.info) !== revision(info) || revision(await fd.stat({ bigint: true })) !== revision(info)) {
      throw conflict(label(name) + ": file changed while reading.");
    }
    return { bytes, hash: sha(bytes), revision: revision(info), mode: Number(info.mode & 0o777n) };
  } finally { await fd.close(); }
}
async function requireOriginal(name, expected) {
  const actual = await snapshot(name);
  if (expected ? !actual || actual.revision !== expected.revision || actual.hash !== expected.hash : actual !== null) {
    throw conflict(label(name) + ": file changed since preflight.");
  }
}
async function ensureParents(name) {
  const state = await inspect(name);
  for (const relative of state.missingParents) {
    checkBudget();
    const probe = await inspect(name);
    if (!probe.missingParents.includes(relative)) throw conflict(label(relative) + ": unexpected directory change.");
    await fs.mkdir(path.join(root, relative), { mode: 0o755 });
    createdDirs.push(relative);
    const info = await lstat(path.join(root, relative));
    if (!info?.isDirectory() || info.isSymbolicLink() || path.relative(path.join(root, relative), await fs.realpath(path.join(root, relative))) !== "") {
      throw conflict(label(relative) + ": created directory could not be verified.");
    }
    directoryIds.set(relative, identity(info));
  }
}
function describe(plan) {
  const op = plan.op;
  return op.kind + "  " + label(op.name) + (op.destination ? " -> " + label(op.destination) : "");
}
async function verifyResult(name, expected) {
  const actual = await snapshot(name);
  if (expected === null ? actual !== null : !actual || actual.hash !== expected) {
    throw conflict(label(name) + ": read-back verification failed.");
  }
}
async function stageAndPublish(plan, destination, replace) {
  await ensureParents(destination);
  await requireOriginal(plan.op.name, plan.before);
  if (destination !== plan.op.name) await requireOriginal(destination, null);
  const parent = path.posix.dirname(destination);
  const tempName = (parent === "." ? "" : parent + "/") + ".nexum-patch-" + crypto.randomUUID();
  const temp = path.join(root, tempName);
  let owned = null;
  let opened = false;
  try {
    await inspect(destination);
    const fd = await fs.open(temp, "wx", plan.before?.mode ?? 0o666);
    opened = true;
    try {
      owned = identity(await fd.stat({ bigint: true }));
      await fd.writeFile(plan.after);
      if (plan.before && path.sep !== "\\") await fd.chmod(plan.before.mode);
      await fd.sync();
    } finally { await fd.close(); }
    checkBudget();
    await requireOriginal(plan.op.name, plan.before);
    if (destination !== plan.op.name) await requireOriginal(destination, null);
    const currentTemp = await lstat(temp);
    if (!currentTemp?.isFile() || currentTemp.isSymbolicLink() || identity(currentTemp) !== owned || currentTemp.nlink !== 1n) {
      throw conflict("Staged file changed before publication.");
    }
    const staged = await snapshot(tempName);
    if (!staged || staged.hash !== plan.afterHash) throw conflict("Staged bytes changed before publication.");
    await requireOriginal(plan.op.name, plan.before);
    if (destination !== plan.op.name) await requireOriginal(destination, null);
    if (replace) await fs.rename(temp, path.join(root, destination));
    // Publish new files without overwriting a destination that appeared
    // since preflight. A filesystem without hard-link support fails closed.
    else await fs.link(temp, path.join(root, destination));
  } finally {
    if (opened && owned === null) cleanupWarning = tempName;
    if (owned !== null) {
      try {
        await inspect(destination);
        const info = await lstat(temp);
        if (info) {
          if (!info.isFile() || info.isSymbolicLink() || identity(info) !== owned) throw Error("staged identity changed");
          await fs.unlink(temp);
        }
      } catch { cleanupWarning = tempName; }
    }
  }
  if (cleanupWarning) throw conflict("Staged file cleanup could not be confirmed.");
}
async function prepare(ops) {
  for (const op of ops) {
    checkBudget();
    const before = await snapshot(op.name);
    if (op.kind === "A" ? before !== null : before === null) throw conflict(label(op.name) + (op.kind === "A" ? ": destination already exists." : ": source file does not exist."));
    if (op.destination && await snapshot(op.destination) !== null) throw conflict(label(op.destination) + ": move destination already exists.");
    let after = null;
    if (op.kind === "A") after = Buffer.from(op.added, "utf8");
    else if (op.kind !== "D") after = editBytes(before.bytes, op);
    totalBytes += (before?.bytes.length ?? 0) + (after?.length ?? 0);
    if (totalBytes > maxTotal) throw issue("file_patch_budget", "Combined original and updated file bytes exceed 32 MiB.");
    if (after && after.length > maxFile) throw issue("file_too_large", "Updated file exceeds 8 MiB.");
    const plan = { op, before, after, afterHash: after === null ? null : sha(after) };
    plans.push(plan);
  }
  // One last read-only recheck before any filesystem mutation.
  for (const plan of plans) {
    await requireOriginal(plan.op.name, plan.before);
    if (plan.op.destination) await requireOriginal(plan.op.destination, null);
  }
}
async function observe(name, before, expected) {
  try {
    const current = await snapshot(name);
    if (!current) return "absent";
    if (expected !== null && current.hash === expected) return "expected bytes present";
    if (before && current.hash === before.hash) return "original bytes present";
    return "different bytes present";
  } catch { return "state unverified"; }
}
function throwRejected(error) {
  // Fixed codes are checked against the verified official script by Go.
  // The per-file, caller-supplied relative paths and factual report are logs.
  switch (error.patchCode) {
    case "invalid_patch": throw Object.assign(Error("invalid_patch: Patch rejected before writing; inspect Run logs."), { nexumBuiltinFailure: { code: "invalid_patch" } });
    case "file_path_escape": throw Object.assign(Error("file_path_escape: Patch rejected before writing; inspect Run logs."), { nexumBuiltinFailure: { code: "file_path_escape" } });
    case "file_not_text": throw Object.assign(Error("file_not_text: Patch rejected before writing; inspect Run logs."), { nexumBuiltinFailure: { code: "file_not_text" } });
    case "file_too_large": throw Object.assign(Error("file_too_large: Patch rejected before writing; inspect Run logs."), { nexumBuiltinFailure: { code: "file_too_large" } });
    case "file_patch_budget": throw Object.assign(Error("file_patch_budget: Patch rejected before writing; inspect Run logs."), { nexumBuiltinFailure: { code: "file_patch_budget" } });
    case "file_patch_conflict": throw Object.assign(Error("file_patch_conflict: Patch rejected before writing; inspect Run logs."), { nexumBuiltinFailure: { code: "file_patch_conflict" } });
    default: throw Object.assign(Error("file_patch_io_failed: Patch rejected before writing; inspect Run logs."), { nexumBuiltinFailure: { code: "file_patch_io_failed" } });
  }
}

try {
  const ops = parsePatch(context.input.patch);
  await prepare(ops);
  for (const plan of plans) {
    checkBudget();
    active = plan;
    const op = plan.op;
    await requireOriginal(op.name, plan.before);
    if (op.destination) await requireOriginal(op.destination, null);
    if (op.kind === "M" && plan.before.hash === plan.afterHash) {
      applied.push("=  " + label(op.name));
      active = null;
      continue;
    }
    writing = true;
    if (op.kind === "D") {
      await fs.unlink(path.join(root, op.name));
      await verifyResult(op.name, null);
    } else if (op.kind === "R") {
      await stageAndPublish(plan, op.destination, false);
      await verifyResult(op.destination, plan.afterHash);
      await requireOriginal(op.name, plan.before);
      await fs.unlink(path.join(root, op.name));
      await verifyResult(op.name, null);
      await verifyResult(op.destination, plan.afterHash);
    } else {
      await stageAndPublish(plan, op.name, op.kind === "M");
      await verifyResult(op.name, plan.afterHash);
    }
    applied.push(describe(plan));
    active = null;
  }
  return "Patch applied successfully.\n\n" + applied.join("\n") + "\n\n" +
    applied.length + " file operations verified." + (createdDirs.length ? " Created " + createdDirs.length + " parent directories." : "");
} catch (error) {
  const detail = error.patchDetail ?? "Filesystem operation failed; inspect the requested paths and access.";
  if (!writing) {
    console.log("Patch rejected. No file or directory writes were attempted by this patch.\n" + detail);
    throwRejected(error);
  }
  const report = ["Patch stopped. Some effects may already exist.", detail, "Previously verified operations:",
    ...(applied.length ? applied : ["(none)"])];
  if (active) {
    const { op, before, afterHash } = active;
    report.push("Current operation: " + describe(active),
      label(op.name) + ": " + await observe(op.name, before, op.destination ? null : afterHash));
    if (op.destination) report.push(label(op.destination) + ": " + await observe(op.destination, null, afterHash));
  }
  const pending = plans.slice(applied.length + (active ? 1 : 0));
  if (pending.length) report.push("Not attempted:", ...pending.map(describe));
  if (createdDirs.length) report.push("Created directories (not automatically removed):", ...createdDirs.map(label));
  if (cleanupWarning) report.push("Temporary file cleanup unverified: " + label(cleanupWarning));
  report.push("Inspect actual state before retrying. No multi-file rollback is claimed.");
  console.log(report.join("\n"));
  throw Object.assign(Error("file_patch_partial: Patch stopped during file operations; inspect Run logs and current files before retrying."), { nexumBuiltinFailure: { code: "file_patch_partial" } });
}

/*
OpenAI Codex
Copyright 2025 OpenAI
Reference: https://github.com/openai/codex/tree/ebd0765aafa255d63ebf690ebdffe0164dc14a0c/codex-rs/apply-patch

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1.  Definitions.

    "License" shall mean the terms and conditions for use, reproduction,
    and distribution as defined by Sections 1 through 9 of this document.

    "Licensor" shall mean the copyright owner or entity authorized by
    the copyright owner that is granting the License.

    "Legal Entity" shall mean the union of the acting entity and all
    other entities that control, are controlled by, or are under common
    control with that entity. For the purposes of this definition,
    "control" means (i) the power, direct or indirect, to cause the
    direction or management of such entity, whether by contract or
    otherwise, or (ii) ownership of fifty percent (50%) or more of the
    outstanding shares, or (iii) beneficial ownership of such entity.

    "You" (or "Your") shall mean an individual or Legal Entity
    exercising permissions granted by this License.

    "Source" form shall mean the preferred form for making modifications,
    including but not limited to software source code, documentation
    source, and configuration files.

    "Object" form shall mean any form resulting from mechanical
    transformation or translation of a Source form, including but
    not limited to compiled object code, generated documentation,
    and conversions to other media types.

    "Work" shall mean the work of authorship, whether in Source or
    Object form, made available under the License, as indicated by a
    copyright notice that is included in or attached to the work
    (an example is provided in the Appendix below).

    "Derivative Works" shall mean any work, whether in Source or Object
    form, that is based on (or derived from) the Work and for which the
    editorial revisions, annotations, elaborations, or other modifications
    represent, as a whole, an original work of authorship. For the purposes
    of this License, Derivative Works shall not include works that remain
    separable from, or merely link (or bind by name) to the interfaces of,
    the Work and Derivative Works thereof.

    "Contribution" shall mean any work of authorship, including
    the original version of the Work and any modifications or additions
    to that Work or Derivative Works thereof, that is intentionally
    submitted to Licensor for inclusion in the Work by the copyright owner
    or by an individual or Legal Entity authorized to submit on behalf of
    the copyright owner. For the purposes of this definition, "submitted"
    means any form of electronic, verbal, or written communication sent
    to the Licensor or its representatives, including but not limited to
    communication on electronic mailing lists, source code control systems,
    and issue tracking systems that are managed by, or on behalf of, the
    Licensor for the purpose of discussing and improving the Work, but
    excluding communication that is conspicuously marked or otherwise
    designated in writing by the copyright owner as "Not a Contribution."

    "Contributor" shall mean Licensor and any individual or Legal Entity
    on behalf of whom a Contribution has been received by Licensor and
    subsequently incorporated within the Work.

2.  Grant of Copyright License. Subject to the terms and conditions of
    this License, each Contributor hereby grants to You a perpetual,
    worldwide, non-exclusive, no-charge, royalty-free, irrevocable
    copyright license to reproduce, prepare Derivative Works of,
    publicly display, publicly perform, sublicense, and distribute the
    Work and such Derivative Works in Source or Object form.

3.  Grant of Patent License. Subject to the terms and conditions of
    this License, each Contributor hereby grants to You a perpetual,
    worldwide, non-exclusive, no-charge, royalty-free, irrevocable
    (except as stated in this section) patent license to make, have made,
    use, offer to sell, sell, import, and otherwise transfer the Work,
    where such license applies only to those patent claims licensable
    by such Contributor that are necessarily infringed by their
    Contribution(s) alone or by combination of their Contribution(s)
    with the Work to which such Contribution(s) was submitted. If You
    institute patent litigation against any entity (including a
    cross-claim or counterclaim in a lawsuit) alleging that the Work
    or a Contribution incorporated within the Work constitutes direct
    or contributory patent infringement, then any patent licenses
    granted to You under this License for that Work shall terminate
    as of the date such litigation is filed.

4.  Redistribution. You may reproduce and distribute copies of the
    Work or Derivative Works thereof in any medium, with or without
    modifications, and in Source or Object form, provided that You
    meet the following conditions:

    (a) You must give any other recipients of the Work or
    Derivative Works a copy of this License; and

    (b) You must cause any modified files to carry prominent notices
    stating that You changed the files; and

    (c) You must retain, in the Source form of any Derivative Works
    that You distribute, all copyright, patent, trademark, and
    attribution notices from the Source form of the Work,
    excluding those notices that do not pertain to any part of
    the Derivative Works; and

    (d) If the Work includes a "NOTICE" text file as part of its
    distribution, then any Derivative Works that You distribute must
    include a readable copy of the attribution notices contained
    within such NOTICE file, excluding those notices that do not
    pertain to any part of the Derivative Works, in at least one
    of the following places: within a NOTICE text file distributed
    as part of the Derivative Works; within the Source form or
    documentation, if provided along with the Derivative Works; or,
    within a display generated by the Derivative Works, if and
    wherever such third-party notices normally appear. The contents
    of the NOTICE file are for informational purposes only and
    do not modify the License. You may add Your own attribution
    notices within Derivative Works that You distribute, alongside
    or as an addendum to the NOTICE text from the Work, provided
    that such additional attribution notices cannot be construed
    as modifying the License.

    You may add Your own copyright statement to Your modifications and
    may provide additional or different license terms and conditions
    for use, reproduction, or distribution of Your modifications, or
    for any such Derivative Works as a whole, provided Your use,
    reproduction, and distribution of the Work otherwise complies with
    the conditions stated in this License.

5.  Submission of Contributions. Unless You explicitly state otherwise,
    any Contribution intentionally submitted for inclusion in the Work
    by You to the Licensor shall be under the terms and conditions of
    this License, without any additional terms or conditions.
    Notwithstanding the above, nothing herein shall supersede or modify
    the terms of any separate license agreement you may have executed
    with Licensor regarding such Contributions.

6.  Trademarks. This License does not grant permission to use the trade
    names, trademarks, service marks, or product names of the Licensor,
    except as required for reasonable and customary use in describing the
    origin of the Work and reproducing the content of the NOTICE file.

7.  Disclaimer of Warranty. Unless required by applicable law or
    agreed to in writing, Licensor provides the Work (and each
    Contributor provides its Contributions) on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
    implied, including, without limitation, any warranties or conditions
    of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
    PARTICULAR PURPOSE. You are solely responsible for determining the
    appropriateness of using or redistributing the Work and assume any
    risks associated with Your exercise of permissions under this License.

8.  Limitation of Liability. In no event and under no legal theory,
    whether in tort (including negligence), contract, or otherwise,
    unless required by applicable law (such as deliberate and grossly
    negligent acts) or agreed to in writing, shall any Contributor be
    liable to You for damages, including any direct, indirect, special,
    incidental, or consequential damages of any character arising as a
    result of this License or out of the use or inability to use the
    Work (including but not limited to damages for loss of goodwill,
    work stoppage, computer failure or malfunction, or any and all
    other commercial damages or losses), even if such Contributor
    has been advised of the possibility of such damages.

9.  Accepting Warranty or Additional Liability. While redistributing
    the Work or Derivative Works thereof, You may choose to offer,
    and charge a fee for, acceptance of support, warranty, indemnity,
    or other liability obligations and/or rights consistent with this
    License. However, in accepting such obligations, You may act only
    on Your own behalf and on Your sole responsibility, not on behalf
    of any other Contributor, and only if You agree to indemnify,
    defend, and hold each Contributor harmless for any liability
    incurred by, or claims asserted against, such Contributor by reason
    of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

Copyright 2025 OpenAI

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
