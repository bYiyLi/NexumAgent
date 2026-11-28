# NexumAgent Development Rules

- Node Host、SDK 与 Browser 属于独立 TypeScript 工程，不把 Nexum Cloud 或任何 AI Host 的专属实现引入 Agent 核心。
- Desktop 是独立 Wails 工程；进入 `desktop/` 按其 [AGENTS.md](desktop/AGENTS.md) 使用独立依赖、验证和发行流程。
- 保持 Host-neutral、Agent-neutral 和 local-first。
- 按当前源码、实际测试结果及开发记录判断能力与交付状态；设计或局部测试不代表完整交付。
- 修改后执行 `pnpm check`，检视 Git diff；不要提交凭据、本地状态或构建产物。
- 重大通信、权限、运行时或扩展协议设计确认前，不以占位实现冒充真实能力。
- 用户 Skills 只从公开的个人/Project 目录发现。内部生成资料的根目录为 `<profile>/cache/materials/`，不能在 profile 根目录中重新创建自有 `skills/` 库。
- Agent/profile 根目录是私有存储边界，不是业务路径授权。普通 Agent-only Run 默认在 `<profile>/scripts/` 工作；不得因为取消 `work/` 就自动授权读取配置、凭据、缓存或 SQLite。
