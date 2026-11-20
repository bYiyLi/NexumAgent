---
name: script-authoring
description: 用户要求创建、保存或修改可反复按 scriptName 调用的 Nexum JavaScript 脚本时选择；只运行已有脚本、执行一次性代码或查询历史时不选择。
---

# 创建与维护可复用脚本

1. 先核对本次 `agent.open.agent.scripts`：按用途、来源与 `scriptInputSchema` 寻找已有脚本；`complete=false` 时读 `index`。若现有脚本已符合需求且不需要修改，直接复用。
2. 需要新建时，在单段 `.js` 文件开头写有效 JSON 块注释，包含 `scriptName`、`scriptDesc`、`scriptWhenUse`、`scriptInputSchema`。仅在用户希望默认展示时加 `scriptOpenDefault: true`。代码从 `context.input` 读取参数，依赖以目标执行环境实际可用的 Node/npm 与 SDK 为准；不能猜测 AI Host 或其他环境的路径。
3. **仅保存**：用获准的文件能力把源码写到本次 `agent.open.agent.paths.scripts`，不要为收录而执行业务代码。**保存并执行**：可用带合法头部的 `agent.run.start.script`，Agent 在执行前收录；收录成功不等于运行成功。
4. 同名不同内容不会自动覆盖。修改前核对本地脚本的当前文件；平台/扩展脚本应修改所属来源，不覆盖运行时副本。
5. 刷新该工作并核对实际公开名称、用途、输入 Schema 和来源。只有要求执行时才用 `scriptName` 提交并检查原 Run 的真实结果。

需要 JSON 头部及保存示例时读取 [创建示例](references/authoring.md)。
