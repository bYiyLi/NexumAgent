# Nexum Desktop 开发规则

- 本目录是独立 Wails Go Module 和 pnpm Workspace。依赖与构建不得要求 Nexum 私有主仓库、Cloud 凭据或 Agent 本地状态。
- 产品与技术边界见 [Desktop 设计基线](../docs/desktop/design.md)，实施验收见 [基础工程](../docs/development/desktop-foundation.md)。
- production 与 development Profile 在构建时确定。保留独立 App ID、单实例、配置/日志/SQLite、Windows WebView 数据及安装制品；不读写 Agent 的 profile 数据或 SQLite。
- 在 `desktop/` 使用 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm tools:install`、`pnpm check`；开发运行使用 `pnpm dev`，候选打包用 `pnpm package:dev` / `pnpm package`。跨平台验收使用对应原生机器或 GitHub Actions，不使用本机虚拟机或 Docker。
- 只在明确授权的范围内创建发布 Tag、推送或发行；Desktop 发行使用 `desktop/v*`，不触发 SDK/Browser npm 发布。未通过真实签名与验收不得宣称正式发布。
- 不提交生成的 bindings、dist、bin、工具缓存、SQLite、日志或密钥。不得为 Desktop 修改无关 Node Host、SDK/Browser 或 Cloud 行为。
- Agent 管理的业务流程、状态编排与交互逻辑由 Desktop 实现。Agent/Native 侧仅提供确认目标身份、保护运行中任务、访问 Agent 自有状态，以及必须在目标设备本地执行的系统服务和程序操作所必需的最小受限接口；不得因客户端管理功能改变 Agent 的正常运行路径或其他已有行为。停止、重启等操作仅由用户主动发起并按操作确认结果。
