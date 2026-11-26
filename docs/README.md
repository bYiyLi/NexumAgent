# NexumAgent 文档

## 给 AI 使用的运行资料

- Cloud 的 `agent.list/open/run.*` 负责目标选择、执行与历史；Cloud 开启 Goal 时使用其当前独立 Goal 工具，两者不是 Agent JavaScript SDK。
- 每次 `agent.open` 都会交付适用 Instructions、Skills 选择元数据及已获准的平台/扩展脚本及最多 100 条本地精选脚本摘要；完整目录按需用 nexum/script.list.js 查询，不返回独立 Docs，扩展能力由本次启用状态决定。
- `src/runtime/scripts.ts` 依据有效 `.js` 头部生成独立脚本索引；每次打开另保存本次工作快照的 `scripts.index`；官方 [script-authoring](../skills/script-authoring/SKILL.md) 负责创建与维护可复用脚本。
- `builtin/` 是 Nexum 官方内置脚本（`nexum/file.read.js`、`nexum/file.list.js`、`nexum/file.search.js`、`nexum/file.patch.js`、`nexum/script.metadata.js`、`nexum/resource.read.js`；另有 `nexum/sh.*.js` 六个及 `nexum/transfer.*.js` 三个固定控制脚本，普通 Run 满载时按实际索引调用）。它们由 ScriptCatalog 自动发现，在原有 `agent.run.start({contextId,scriptName,input})` 中运行并记录同一个 Run；不是新的 MCP Tool。先看 `agent.open.agent.scripts` 的实际描述，必要时按索引路径调用 `nexum/script.metadata.js` 获取完整头部。Git status/diff 等直接使用授权的 `sh.exec`，无需独立 Git 包装脚本。
- `src/host/platform-materials.ts` 从实际 Registry 方法生成 `work/skills/.generated/platform/` 下的 Skill，按需引用真实签名、完整 Schema 及输出/错误合同；Go 负责 MCP/OpenAPI 来源目录及其批准配置。
- 已启用的扩展或经授权接入的 MCP/OpenAPI 各自生成有来源/修订的 Skill，人工 Skill 及包内 references/scripts/assets 保留；模型不能仅凭某个 npm 包已安装而假设扩展方法可调用。

Skill 私有 scripts/ 不注册成 agent.scripts，不能按 scriptName 直接执行；可复用脚本发现、输入 Schema 与运行仍由 ScriptCatalog 独立负责。

下游 AI 使用 `agent.open` 返回的实际材料，而不是自动读取本仓库的开发文档。模型可见内容只保留决策条件、实际调用、结果/错误处理及按需阅读入口。

[Nexum browser](browser/README.md) 是官方可选浏览器控制包的设计、SDK/类型、连接与生命周期、结果交付、独立 npm 发行和逐项验收资料。它不默认安装；候选代码及部分验证已经存在，完整验收和 npm 发布尚未完成。

第三方原始参考资料仅作本地开发参考，不随公开仓库分发；当前设计、来源说明和实际实现状态分别维护。
