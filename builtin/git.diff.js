/**
{
  "scriptName": "git.diff.js",
  "scriptDesc": "通过受管 sh SDK 查看 Git 工作树或暂存区的差异",
  "scriptWhenUse": "修改代码前后需要核对真实 Git Diff 时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "minLength": 1, "maxLength": 4096 },
      "cached": { "type": "boolean" },
      "stat": { "type": "boolean" }
    },
    "additionalProperties": false
  }
}
*/
const path = await import("node:path");
const relative = context.input.path;
if (relative && (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))) throw Error("git_path_escape: project-relative path required");
const args = ["diff", "--no-ext-diff"];
if (context.input.cached) args.push("--cached");
if (context.input.stat) args.push("--stat");
if (relative) args.push("--", relative);
return await sh.exec({ command: "git", args, cwd: context.project?.root ?? context.pwd, timeoutMs: 15000, check: true });
