/**
{
  "scriptName": "file.list.js",
  "scriptDesc": "列出当前项目目录内的文件和子目录，不跟随软链接",
  "scriptWhenUse": "需要定位项目文件或了解某个目录结构时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500
      }
    },
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      },
      "total": {
        "type": "integer",
        "minimum": 0
      },
      "truncated": {
        "type": "boolean"
      },
      "entries": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string"
            },
            "type": {
              "type": "string",
              "enum": [
                "symlink",
                "directory",
                "file",
                "other"
              ]
            }
          },
          "required": [
            "name",
            "type"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "path",
      "total",
      "truncated",
      "entries"
    ],
    "additionalProperties": false
  }
}
*/
const fs = await import("node:fs/promises");
const path = await import("node:path");
const root = await fs.realpath(context.project?.root ?? context.pwd);
const relative = context.input.path || ".";
if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw Error("file_path_escape: project-relative path required");
const directory = await fs.realpath(path.resolve(root, relative));
const inside = path.relative(root, directory);
if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) throw Error("file_path_escape: directory outside project");
const entries = await fs.readdir(directory, { withFileTypes: true });
entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
const limit = context.input.limit ?? 100;
return {
  path: relative,
  total: entries.length,
  truncated: entries.length > limit,
  entries: entries.slice(0, limit).map((item) => ({
    name: item.name,
    type: item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : item.isFile() ? "file" : "other"
  }))
};
