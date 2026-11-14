# NexumAgent Development Rules

- 维护独立 TypeScript Agent 项目，不把 Nexum Cloud 或任何 AI Host 的专属实现引入 Agent 核心。
- 保持 Host-neutral、Agent-neutral 和 local-first。
- 按当前源码、实际测试结果及开发记录判断能力与交付状态；设计或局部测试不代表完整交付。
- 修改后执行 `pnpm check`，检视 Git diff；不要提交凭据、本地状态或构建产物。
- 重大通信、权限、运行时或扩展协议设计确认前，不以占位实现冒充真实能力。
