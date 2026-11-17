# NexumAgent 文档

## 给 AI 使用的运行资料

- Cloud 的 `agent.list/open/run.*` 负责目标选择、执行与历史；实际开启 Goal 时另有 `goal.manage`，两者不是 Agent JavaScript SDK。
- 每次 `agent.open` 都会交付适用 Instructions、Skills 选择元数据、可复用脚本默认/高频列表及 `agent.docs` 目录预览，扩展能力由本次启用状态决定。
- `src/runtime/scripts.ts` 依据有效 `.js` 头部生成真实 `work/docs/scripts.md`；官方 [script-authoring](../skills/script-authoring/SKILL.md) 负责创建与维护可复用脚本。
- `src/application/runtime.ts` 从当前平台方法生成 `work/docs/platform/*.md`，每类 SDK 提供方法索引、参数与适用的 JavaScript 用法。
- 已启用的扩展或经授权接入的 MCP/OpenAPI 各有自己的来源文档；模型不能仅凭某个 npm 包已安装而假设扩展方法可调用。

下游 AI 使用 `agent.open` 返回的实际材料，而不是自动读取本仓库的开发文档。模型可见内容只保留决策条件、实际调用、结果/错误处理及按需阅读入口。

[Nexum browser](browser/README.md) 是官方可选浏览器控制包的设计、SDK/类型、连接与生命周期、结果交付、独立 npm 发行和逐项验收资料。它不默认安装；候选代码及部分验证已经存在，完整验收和 npm 发布尚未完成。

第三方原始参考资料仅作本地开发参考，不随公开仓库分发；当前设计、来源说明和实际实现状态分别维护。
