/**
{
  "scriptName": "git.status.js",
  "scriptDesc": "通过受管 sh SDK 查询当前项目的 Git 分支和工作树变更",
  "scriptWhenUse": "需要检查当前仓库是否存在未提交更改时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
*/
const cwd = context.project?.root ?? context.pwd;
return await sh.exec({ command: "git", args: ["status", "--porcelain=v1", "--branch", "-uall"], cwd, timeoutMs: 15000, check: true });
