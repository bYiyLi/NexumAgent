# Browser Skill 与 Agent Scripts 的责任边界

## 平台 `agent.scripts`

这些脚本由 Nexum Agent 登记。先查本次 `agent.open` 的 `agent.scripts.complete`：当为 `false` 时，必须先从该结果真实给出的 `agent.scripts.index` 按需补读清单，不能因 `items` 为空就断言脚本不存在。以成功发现的 `scriptName` 和 `scriptInputSchema` 判断是否可调用。常见脚本名称可能包括 `browser/installation.js`、`browser/discover.js`、`browser/screenshot.js`，实际使用前以当前目标是否列出为准。

选择已登记脚本时，由 AI Host 调用 MCP 工具 `agent.run.start`，传入本次 `agent.open` 的 `contextId`、清单中已登记的 `scriptName`、符合 `scriptInputSchema` 的 `input`（以及需要时的 `title`）。这不是在 Nexum Run 的 JavaScript 代码里调用的 SDK 方法；不要仅凭同名文件猜测已注册。授权、作用范围、运行历史和错误由 Nexum Agent Run 管理。

## Skill 辅助脚本

Skill 自己的 `scripts/`（若存在）只对被选中的 Skill 负责，除非平台明确另行注册，它们**不属于** `agent.scripts`。辅助脚本通常用于可重复的确定性处理，不负责替代 Skill 的操作判断、授权与验证。

本版 Browser Skill 不额外创建内部脚本：安装信息、发现与截图已有平台登记脚本可用，页面交互使用实际 Browser SDK。需要新增辅助实现时，先确认重复场景及输入/输出/副作用，测试后才加入。

## 执行结果

从 `agent.scripts` 启动的 Run 应检查其真实结束状态和结果；浏览器写入动作还必须核对网页/业务结果。运行接受、脚本返回和业务确认是不同层级。
