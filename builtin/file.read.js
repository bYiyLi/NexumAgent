/**
{
  "scriptName": "file.read.js",
  "scriptDesc": "读取当前授权项目中的 UTF-8 文件，支持指定行范围并返回 SHA-256",
  "scriptWhenUse": "需要查看代码、配置或文档的具体内容时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "startLine": {
        "type": "integer",
        "minimum": 1
      },
      "endLine": {
        "type": "integer",
        "minimum": 1
      }
    },
    "required": [
      "path"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      },
      "startLine": {
        "type": "integer",
        "minimum": 1
      },
      "endLine": {
        "type": "integer",
        "minimum": 1
      },
      "totalLines": {
        "type": "integer",
        "minimum": 1
      },
      "truncated": {
        "type": "boolean"
      },
      "sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "text": {
        "type": "string"
      }
    },
    "required": [
      "path",
      "startLine",
      "endLine",
      "totalLines",
      "truncated",
      "sha256",
      "text"
    ],
    "additionalProperties": false
  }
}
*/
const fs = await import("node:fs/promises");
const path = await import("node:path");
const crypto = await import("node:crypto");
const root = await fs.realpath(context.project?.root ?? context.pwd);
const relative = context.input.path;
if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw Error("file_path_escape: project-relative path required");
const target = await fs.realpath(path.resolve(root, relative));
const inside = path.relative(root, target);
if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) throw Error("file_path_escape: file outside project");
const stat = await fs.stat(target);
if (!stat.isFile() || stat.size > 1024 * 1024) throw Error("file_too_large: expected regular UTF-8 file at most 1 MiB");
const bytes = await fs.readFile(target);
if (bytes.includes(0)) throw Error("file_not_text: binary content");
const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const lines = content.split("\n");
const start = context.input.startLine ?? 1;
const end = context.input.endLine ?? Math.min(lines.length, start + 499);
if (start > lines.length || end < start || end - start >= 500) throw Error("invalid_line_range: select up to 500 existing lines");
const selected = lines.slice(start - 1, end).join("\n");
if (Buffer.byteLength(selected) > 128 * 1024) throw Error("file_output_too_large: request fewer lines");
return {
  path: relative,
  startLine: start,
  endLine: Math.min(end, lines.length),
  totalLines: lines.length,
  truncated: end < lines.length,
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  text: selected
};
