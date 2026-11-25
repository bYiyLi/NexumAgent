# 使用与维护 Browser 脚本

- 按本次 `agent.scripts` 的公开 scriptName 和 description 选择；参数不明确时调用已登记的 `nexum/script.metadata.js`，input.path 为目标条目的实际绝对路径。若有 agent_scripts_incomplete，核对 warnings，必要时刷新原 contextId。
- 由 AI Host 调用 `agent.run.start`，传原 contextId、已登记的 scriptName、符合合同的 input；不是在 Run 的 JavaScript 中调用 MCP 工具。仅需发现时，例如已登记 browser/discover.js，input={}；返回文本中保留真实 browserId/tabId。
- Skill 私有 scripts/ 不自动进入 agent.scripts，不可猜测 scriptName。新建或修改可复用的登记脚本时，按本次发现的 script-authoring Skill 操作。
- 检查原 Run 终态与实际结果。页面操作的业务确认和媒体交付分别按 [页面交互](interaction.md)、[观察与截图](observation.md) 或 [下载与文件](downloads.md) 的相关分支处理。
