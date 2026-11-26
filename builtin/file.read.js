/**
{
  "scriptName": "file.read.js",
  "scriptDesc": "读取授权文本，输入 {path,startLine?,endLine?,encoding?,expectedRevision?} 或 {files:[同结构，最多8项]}；path 有 Project 时相对于项目根目录，否则相对于 context.pwd。行号从1开始，包含结束行，默认最多200行，显式范围最多500行；encoding 默认 auto（BOM/严格UTF-8），可指定已知编码。返回分文件带行号 Markdown、revision，完整扫描时给出字节 SHA-256；按 nextLine 续读并传原 expectedRevision、相同编码。逐项核对失败，超长行改用有界字节读取。不跟随软链接/Junction。",
  "scriptWhenUse": "深入读取已知文本文件；定位正文先用 nexum/file.search.js。",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "oneOf": [
      {
        "$ref": "#/definitions/request"
      },
      {
        "type": "object",
        "properties": {
          "files": {
            "type": "array",
            "minItems": 1,
            "maxItems": 8,
            "items": {
              "$ref": "#/definitions/request"
            }
          }
        },
        "required": [
          "files"
        ],
        "additionalProperties": false
      }
    ],
    "definitions": {
      "request": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096,
            "description": "文件有 Project 时相对于项目根目录，否则相对于 context.pwd，不跟随软链接/Junction。"
          },
          "startLine": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991,
            "description": "从 1 开始，默认 1。"
          },
          "endLine": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991,
            "description": "包含结束行，默认最多 200 行；显式范围最多 500 行，另受输出预算约束。"
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
            "description": "默认 auto：识别 UTF-8/UTF-16 BOM，否则严格 UTF-8；已知其他编码时显式指定。"
          },
          "expectedRevision": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$",
            "description": "续读时可传前次 revision 检查文件身份和元数据是否变化；不是完整内容 SHA-256。"
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      }
    }
  },
  "scriptOutputSchema": {
    "type": "string",
    "description": "按文件分组的 Markdown。正文带真实行号；完整扫描时给出 SHA-256，续读时给出 nextLine 和 expectedRevision；批量失败逐项说明。"
  }
}
*/
const fs = await import("node:fs/promises");
const { constants } = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");
const root = await fs.realpath(context.project?.root ?? context.pwd);
const input = context.input;
const requests = input.files ?? [input];
const textBudget = Math.min(12 * 1024, Math.floor(24 * 1024 / requests.length));
const deadline = Date.now() + 5000;
let remaining = 64 * 1024 * 1024;

const failure = (code, message, revisions = {}) => Object.assign(Error(code + ": " + message), { fileReadCode: code, fileReadMessage: message, nexumBuiltinFailure: { code, ...revisions } });
function classify(error) {
  if (error.fileReadCode) return error;
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return failure("file_not_found", "requested file does not exist");
  if (error.code === "EACCES" || error.code === "EPERM") return failure("permission_denied", "requested file is not accessible");
  if (error.code === "ELOOP") return failure("file_path_escape", "symbolic links are not followed");
  return failure("file_read_failed", "could not read the requested regular file");
}
function fingerprint(info) {
  return crypto.createHash("sha256").update([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":")).digest("hex");
}
async function resolveFile(relative) {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) ||
      relative.split(/[\\/]/).includes("..") || (path.sep === "\\" && relative.includes(":"))) {
    throw failure("file_path_escape", "file path relative to Project root or current working directory required");
  }
  const target = path.resolve(root, relative);
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  if (!parts.length) throw failure("file_not_text", "expected a regular file");
  let current = root;
  let info;
  for (const part of parts) {
    current = path.join(current, part);
    info = await fs.lstat(current, { bigint: true });
    if (info.isSymbolicLink()) throw failure("file_path_escape", "symbolic links and Junctions are not followed");
  }
  const actual = await fs.realpath(target);
  const inside = path.relative(root, actual);
  if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside) || path.relative(target, actual) !== "") {
    throw failure("file_path_escape", "file outside file-script root or redirected");
  }
  if (!info.isFile()) throw failure("file_not_text", "expected a regular file");
  return { target, info };
}
function decoderFor(bytes, requested) {
  let bom;
  if (bytes.length >= 4 && (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 254, 255])) ||
      bytes.subarray(0, 4).equals(Buffer.from([255, 254, 0, 0])))) {
    throw failure("file_not_text", "UTF-32 is not supported");
  }
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) bom = "utf-8";
  else if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) bom = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) bom = "utf-16be";
  if (bom && requested !== "auto" && requested !== bom) throw failure("file_not_text", "explicit encoding conflicts with the file BOM");
  const encoding = requested === "auto" ? bom ?? "utf-8" : requested;
  try { return new TextDecoder(encoding, { fatal: true }); }
  catch { throw failure("file_not_text", "requested encoding is unavailable"); }
}
async function readOne(request) {
  const start = request.startLine ?? 1;
  const end = request.endLine ?? Math.min(Number.MAX_SAFE_INTEGER, start + 199);
  if (end < start || end - start >= 500) throw failure("invalid_line_range", "select at most 500 lines");
  if (Date.now() >= deadline || remaining === 0) throw failure("file_read_budget", "batch read budget exhausted; request fewer files");
  const { target, info } = await resolveFile(request.path);
  if (BigInt(remaining) < info.size && remaining < 4) throw failure("file_read_budget", "batch read budget exhausted; request fewer files");
  const revision = fingerprint(info);
  if (request.expectedRevision && revision !== request.expectedRevision) throw failure("file_changed", "file changed since the earlier read; restart reading", { expectedRevision: request.expectedRevision, currentRevision: revision });
  // Verify the opened handle before reading. Nonblocking/no-follow on POSIX
  // prevents a replaced regular file from blocking on a FIFO or following a link.
  const flags = constants.O_RDONLY | (path.sep === "\\" ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const handle = await fs.open(target, flags);
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== revision) throw failure("file_changed", "file changed before reading");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const scanCap = Math.min(32 * 1024 * 1024, remaining, Number(info.size));
    const small = info.size <= 1024n * 1024n;
    let position = 0;
    let decoder;
    let lineNo = 1;
    let line = "";
    let oversize = false;
    let used = 0;
    const selected = [];
    let reason = null;
    let budgetReason = null;

    function completeLine() {
      if (lineNo < start || lineNo > end || reason) return;
      const cost = oversize ? Infinity : Buffer.byteLength("    " + lineNo + " | " + line + "\n");
      if (used + cost > textBudget) {
        if (!selected.length) throw failure("file_output_too_large", "one line exceeds the text output budget; use bounded byte reading or request this file alone");
        reason = "output_budget";
        return;
      }
      selected.push(line);
      used += cost;
    }
    function consume(text) {
      if (text.includes("\0")) throw failure("file_not_text", "decoded text contains NUL");
      let at = 0;
      while (at < text.length) {
        const newline = text.indexOf("\n", at);
        const stop = newline === -1 ? text.length : newline;
        if (lineNo >= start && lineNo <= end && !reason && !oversize) {
          if (line.length + stop - at > textBudget) {
            line = "";
            oversize = true;
            if (!selected.length) throw failure("file_output_too_large", "one line exceeds the text output budget; use bounded byte reading or request this file alone");
            reason = "output_budget";
          } else {
            line += text.slice(at, stop);
          }
        }
        if (newline === -1) break;
        completeLine();
        lineNo++;
        line = "";
        oversize = false;
        if (!reason && lineNo > end) reason = "line_limit";
        at = stop + 1;
      }
    }
    function decode(bytes, stream) {
      let text;
      try { text = decoder.decode(bytes, { stream }); }
      catch { throw failure("file_not_text", "invalid text for the selected encoding; specify the known encoding"); }
      consume(text);
    }

    while (position < scanCap) {
      if (Date.now() >= deadline) { budgetReason = "time_budget"; break; }
      const want = Math.min(buffer.length, scanCap - position);
      let count = 0;
      // Fill this bounded chunk to preserve BOM recognition on short reads.
      while (count < want) {
        const { bytesRead } = await handle.read(buffer, count, want - count, position + count);
        if (!bytesRead) throw failure("file_changed", "file became shorter while reading");
        count += bytesRead;
      }
      position += count;
      remaining -= count;
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      decoder ??= decoderFor(bytes, request.encoding ?? "auto");
      decode(bytes, true);
      // For large files, stop once an omitted line is known. Small files
      // retain the historical complete line-count and raw-byte hash behavior.
      if (!small && reason) break;
    }
    const complete = BigInt(position) === info.size;
    decoder ??= decoderFor(Buffer.alloc(0), request.encoding ?? "auto");
    if (complete) {
      decode(new Uint8Array(0), false);
      completeLine(); // LF splitting deliberately counts a trailing empty line.
      if (start > lineNo) throw failure("invalid_line_range", "startLine is beyond the end of the file");
    } else if (!reason) {
      budgetReason ??= "scan_budget";
    }
    // Check handle and path identity again after the last read. This detects
    // ordinary concurrent edits/replacements but does not create a snapshot.
    const after = await resolveFile(request.path).catch(() => null);
    if (!after || fingerprint(after.info) !== revision || fingerprint(await handle.stat({ bigint: true })) !== revision) {
      throw failure("file_changed", "file changed while reading; restart reading");
    }
    if (!selected.length) {
      if (!complete) throw failure("file_read_budget", "requested line was not reached within the scan/time budget");
      throw failure("invalid_line_range", "no requested line exists");
    }
    const finalReason = reason ?? budgetReason;
    const last = start + selected.length - 1;
    return {
      path: request.path, startLine: start, endLine: last,
      totalLines: complete ? lineNo : null,
      truncated: finalReason !== null, reason: finalReason,
      nextLine: reason ? last + 1 : null,
      sha256: complete ? hash.digest("hex") : null,
      revision, encoding: decoder.encoding, text: selected.join("\n")
    };
  } finally {
    await handle.close();
  }
}

const label = (value) => /[\u0000-\u001f\u007f\\]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
function renderRead(result) {
  const lines = result.text.split("\n").map((line, index) => "    " + (result.startLine + index) + " | " + line);
  const head = "## " + label(result.path) + "\n\nLines " + result.startLine + "–" + result.endLine +
    (result.totalLines !== null ? " / " + result.totalLines : " (total unknown)") + " · " + result.encoding;
  const facts = [];
  if (result.sha256 !== null) facts.push("SHA-256: " + result.sha256);
  else facts.push("Complete-file SHA-256 unavailable.");
  if (result.nextLine !== null) {
    facts.push("Continue: startLine=" + result.nextLine + " (nextLine), expectedRevision=" + result.revision);
  } else if (result.truncated) {
    facts.push("Read incomplete (" + result.reason + "); no reliable nextLine. Narrow the request or use bounded byte reading.");
  }
  if (result.nextLine !== null && result.reason === "output_budget") facts.push("Output budget reached; a long line may require bounded byte reading.");
  return head + "\n\n" + lines.join("\n") + "\n\n" + facts.join("\n");
}
if (!input.files) {
  try { return renderRead(await readOne(input)); }
  catch (error) { throw classify(error); }
}
const results = [];
for (const request of requests) {
  try { results.push(renderRead(await readOne(request))); }
  catch (error) {
    const known = classify(error);
    results.push("## " + label(request.path) + "\n\nError (" + known.fileReadCode + "): " + known.fileReadMessage);
  }
}
return results.join("\n\n");
