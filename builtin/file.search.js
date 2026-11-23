/**
{
  "scriptName": "file.search.js",
  "scriptDesc": "在当前项目内按字面文本搜索文件内容，限制扫描量并跳过软链接",
  "scriptWhenUse": "需要按符号、错误消息或片段定位源码时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "minLength": 1, "maxLength": 256 },
      "path": { "type": "string", "maxLength": 4096 },
      "caseSensitive": { "type": "boolean" },
      "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
*/
const fs = await import("node:fs/promises");
const path = await import("node:path");
const root = await fs.realpath(context.project?.root ?? context.pwd);
const relative = context.input.path || ".";
if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw Error("file_path_escape: project-relative path required");
const initial = await fs.realpath(path.resolve(root, relative));
const inside = path.relative(root, initial);
if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) throw Error("file_path_escape: search outside project");
const limit = context.input.limit ?? 40;
const ignore = new Set([".git", "node_modules", "dist", "build", ".cache", ".next", "coverage", ".platform-controls"]);
const queue = [initial];
const matches = [];
const needle = context.input.caseSensitive ? context.input.query : context.input.query.toLowerCase();
let scannedFiles = 0;
let omittedFiles = 0;
let scannedDirectories = 0;
while (queue.length && scannedFiles < 2000 && scannedDirectories < 2000 && matches.length < limit) {
  const current = queue.shift();
  const info = await fs.lstat(current);
  if (info.isSymbolicLink()) continue;
  if (info.isDirectory()) {
    scannedDirectories++;
    const children = await fs.readdir(current, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      if (child.isSymbolicLink() || (child.isDirectory() && ignore.has(child.name))) continue;
      if (queue.length < 10000) queue.push(path.join(current, child.name));
      else omittedFiles++;
    }
    continue;
  }
  if (!info.isFile() || info.size > 256 * 1024) { omittedFiles++; continue; }
  scannedFiles++;
  const bytes = await fs.readFile(current);
  if (bytes.includes(0)) { omittedFiles++; continue; }
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { omittedFiles++; continue; }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const haystack = context.input.caseSensitive ? lines[i] : lines[i].toLowerCase();
    if (!haystack.includes(needle)) continue;
    matches.push({ path: path.relative(root, current), line: i + 1, text: lines[i].slice(0, 300) });
  }
}
return { query: context.input.query, matches, scannedFiles, scannedDirectories, omittedFiles, truncated: queue.length > 0 || matches.length === limit || scannedDirectories >= 2000 || omittedFiles > 0 };
