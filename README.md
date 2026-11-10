# NexumAgent

Nexum 的独立、公开 TypeScript Agent 项目。它是运行在用户本地系统的 Agent，面向多种 AI Host 与 Agent Runtime；与 Nexum Cloud 分仓维护，可通过 Git Submodule 被主仓库引用。

## 当前状态

**仅完成工程初始化，尚无可用的 Agent 功能。** 当前 CLI 只支持 `--help` 和 `--version`，其它命令会明确报错。以下能力均未实现：Cloud 鉴权与连接、受控 JavaScript Runtime、SDK Capability、外部 MCP/API 适配、安装与更新。

此仓库不包含 Nexum Cloud 的私有代码、配置、Token 或生产部署资源。

## 本地开发

需要 Node.js 24+、pnpm 10.34.5：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node dist/cli.js --help
```

`pnpm check` 执行 TypeScript 类型检查、构建及 Node 内置测试。GitHub Actions 使用相同的门禁。

## 仓库关系

- 此仓库拥有 Agent 的源码、独立 Git 历史、构建与未来发布流程。
- Nexum Cloud 仓库只引用本仓库的固定提交，不复制源码或隐式追踪最新主分支。
- 运行时安全边界和 SDK 接口需要经过单独设计后再实现。

## 许可

代码仓库公开可见；目前尚未确定开源许可证。在正式确定许可证前，不对外授予额外的复用权利。
