---
name: script-authoring
description: 用户要求创建、保存或修改可反复按 scriptName 调用的 Nexum JavaScript 脚本时选择；只运行已有脚本、执行一次性代码或查询历史时不选择。
---

# 创建与维护可复用脚本

1. 检查本次 Open 的 agent.scripts 数组。先判断已有脚本能否满足请求；需要完整合同才调用已登记的 nexum/script.metadata.js（input.path 为目标条目的实际绝对路径）。若 warnings 中有 agent_scripts_incomplete，核对警告并按需刷新原 contextId；不假定未列出的脚本不存在。
2. 需要新建时，在单段 `.js` 文件开头写有效 JSON 块注释，包含 `scriptName`、`scriptDesc`、`scriptWhenUse`、`scriptInputSchema`（Draft 7，本地引用）。pattern 使用 Go 与 JavaScript 均支持的正则，例如 NUL 转义用 `\x00`，不使用仅一端支持的表达式。返回结构明确时可声明 `scriptOutputSchema`（Draft 7）；它描述成功业务返回值，不是 Run 外层响应。scriptDesc 写明功能及产出；基础脚本补足直接调用所需的输入、默认值、约束及续读/失败处理。scriptWhenUse 只写触发条件或与相邻能力的区别，不复述 scriptDesc（Open 会合并两者）。新脚本不需要 scriptOpenDefault。代码从 `context.input` 读取参数，依赖以目标执行环境实际可用的 Node/npm 与 SDK 为准；不能猜测 AI Host 或其他环境的路径。
   - 结果仅供 AI 阅读或判断时，直接 `return` 紧凑文本或 Markdown 字符串；如声明输出 Schema，使用 `type: string`。下游确实按字段消费时才返回结构化对象。不重复输出两种格式；保留失败、未完整、续读位置和必要校验值。图片、音频和文件按当前支持的原生结果合同返回。
3. **仅保存**：用获准的 Node 文件能力把源码写到本次 Open 的 `agent.paths.scripts`，不要为收录而执行业务代码。**保存并执行**：可用带合法头部的 `agent.run.start.script`，Agent 在执行前收录；收录成功不等于运行成功。
4. 同名不同内容不会自动覆盖。修改本地脚本前核对当前源码及用户授权；平台/扩展脚本应修改所属来源，不覆盖运行时副本。文件脚本的相对路径以 Project 根目录（无 Project 时为 context.pwd）为根，不用于猜测脚本库的相对位置。
5. 刷新原工作，核对公开 scriptName、description、path；需要完整合同时使用 nexum/script.metadata.js。只有获准执行时才用 scriptName 提交并检查原 Run 的真实结果。
6. SDK 失败时保留原异常；需要结束失败 Run 时直接重抛原 Error，不重新包装或修改 code/message/details。若操作已派发或结果未知，先查询原 Run、进程、传输或目标状态，再决定后续行动；不得仅因异常或 retryable=true 自动重做有副作用的操作。

需要 JSON 头部及保存示例时读取 [创建示例](references/authoring.md)。
