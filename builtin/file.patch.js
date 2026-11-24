/**
{
  "scriptName": "file.patch.js",
  "scriptDesc": "在项目内创建、删除或按唯一文本片段替换单个文件；支持原文件 SHA-256 校验",
  "scriptWhenUse": "需要安全地进行一次小范围文件修改并记录在当前 Run 时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "operation": {
        "type": "string",
        "enum": [
          "create",
          "replace",
          "delete"
        ]
      },
      "oldText": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1048576
      },
      "newText": {
        "type": "string",
        "maxLength": 1048576
      },
      "expectedSha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    "required": [
      "path",
      "operation"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "operation": {
            "const": "create"
          },
          "path": {
            "type": "string"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "bytes": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "operation",
          "path",
          "sha256",
          "bytes"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "operation": {
            "const": "replace"
          },
          "path": {
            "type": "string"
          },
          "beforeSha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "bytes": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "operation",
          "path",
          "beforeSha256",
          "sha256",
          "bytes"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "operation": {
            "const": "delete"
          },
          "path": {
            "type": "string"
          },
          "beforeSha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "deleted": {
            "const": true
          }
        },
        "required": [
          "operation",
          "path",
          "beforeSha256",
          "deleted"
        ],
        "additionalProperties": false
      }
    ]
  }
}
*/
const fs = await import("node:fs/promises");
const path = await import("node:path");
const crypto = await import("node:crypto");
const root = await fs.realpath(context.project?.root ?? context.pwd);
const relative = context.input.path;
if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || relative === ".") throw Error("file_path_escape: project-relative file path required");
const target = path.resolve(root, relative);
const parent = await fs.realpath(path.dirname(target));
const inside = path.relative(root, parent);
if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) throw Error("file_path_escape: parent outside project");
const info = await fs.lstat(target).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (info && (!info.isFile() || info.isSymbolicLink())) throw Error("file_path_escape: target must be a regular file");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const operation = context.input.operation;
if ((context.input.newText?.includes("\u0000") ?? false) || (context.input.oldText?.includes("\u0000") ?? false)) throw Error("file_not_text: NUL byte in patch");
if (context.input.newText !== undefined && Buffer.byteLength(context.input.newText) > 1024 * 1024) throw Error("file_too_large: patch text exceeds 1 MiB");
if (operation === "create") {
  if (info || context.input.newText === undefined || context.input.oldText !== undefined) throw Error("file_patch_conflict: create requires a new file and newText");
  await fs.writeFile(target, context.input.newText, { flag: "wx", mode: 0o600 });
  return { operation, path: relative, sha256: hash(Buffer.from(context.input.newText)), bytes: Buffer.byteLength(context.input.newText) };
}
if (!info || info.size > 1024 * 1024) throw Error("file_patch_conflict: existing file must be at most 1 MiB");
const before = await fs.readFile(target);
if (before.includes(0)) throw Error("file_not_text: binary content");
const beforeHash = hash(before);
if (context.input.expectedSha256 && beforeHash !== context.input.expectedSha256) throw Error("file_patch_conflict: SHA-256 mismatch");
if (operation === "delete") {
  if (!context.input.expectedSha256 || context.input.oldText !== undefined || context.input.newText !== undefined) throw Error("file_patch_conflict: delete requires expectedSha256 only");
  const current = await fs.lstat(target);
  if (!current.isFile() || current.isSymbolicLink() || hash(await fs.readFile(target)) !== beforeHash) throw Error("file_patch_conflict: target changed");
  await fs.unlink(target);
  return { operation, path: relative, beforeSha256: beforeHash, deleted: true };
}
if (operation !== "replace" || !context.input.oldText || context.input.newText === undefined) throw Error("file_patch_conflict: replace requires oldText and newText");
const source = new TextDecoder("utf-8", { fatal: true }).decode(before);
const index = source.indexOf(context.input.oldText);
if (index < 0 || source.indexOf(context.input.oldText, index + 1) !== -1) throw Error("file_patch_conflict: oldText must occur exactly once");
const updated = source.slice(0, index) + context.input.newText + source.slice(index + context.input.oldText.length);
if (Buffer.byteLength(updated) > 1024 * 1024) throw Error("file_too_large: updated file exceeds 1 MiB");
const temporary = path.join(parent, ".nexum-patch-" + crypto.randomUUID());
try {
  await fs.writeFile(temporary, updated, { flag: "wx", mode: info.mode & 0o777 });
  const current = await fs.lstat(target);
  if (!current.isFile() || current.isSymbolicLink() || hash(await fs.readFile(target)) !== beforeHash) throw Error("file_patch_conflict: target changed");
  await fs.rename(temporary, target);
} finally {
  await fs.rm(temporary, { force: true });
}
return { operation, path: relative, beforeSha256: beforeHash, sha256: hash(Buffer.from(updated)), bytes: Buffer.byteLength(updated) };
