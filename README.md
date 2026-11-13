# NexumAgent

Nexum 的独立、公开 TypeScript Agent 项目。它是运行在用户本地系统的 Agent，面向多种 AI Host 与 Agent Runtime；与 Nexum Cloud 分仓维护，可通过 Git Submodule 被主仓库引用。

## 当前状态

**正在实现可编程运行时，尚未形成可连接使用的完整 Agent。** 当前 CLI 仍只支持 `--help` 和 `--version`。已实现的内部基础包括：

- `contracts/v2` 的八个工具输入 Schema、可信 wire envelope、正反例，以及独立 Draft 7 脚本入参校验；
- 原生 SQLite 的绑定/迁移、运行接纳与去重、输入单次消费、工作关闭、后台资源交接、历史筛选、共享值版本更新及重启中断；
- 独立 JavaScript 作用域、动态 import/require、Node/npm 准入、原生 ESM/CJS 条件、显式文件模块与缓存换版检查。

运行协调器与完整 SDK、Cloud 鉴权/连接、多附件与结果适配、MCP/API/扩展维护、安装更新及整体验收仍在实施范围内，不能将基础库测试视为产品验收。Node VM 用于执行作用域，系统安全由目标 OS/容器负责，不提供恶意代码安全沙箱。

此仓库不包含 Nexum Cloud 的私有代码、配置、Token 或生产部署资源。

## 本地开发

需要 Node.js 24.22.1（当前验证基线）、pnpm 10.34.5：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node dist/cli.js --help
```

`pnpm check` 执行 TypeScript 类型检查、构建及 Node 内置测试，测试进程带 `--experimental-vm-modules`。GitHub Actions 配置 Linux、macOS、Windows 的原生 Node 检查矩阵；实际通过状态以对应提交的运行结果为准。

## 仓库关系

- 此仓库拥有 Agent 的源码、独立 Git 历史、构建与未来发布流程。
- Nexum Cloud 仓库只引用本仓库的固定提交，不复制源码或隐式追踪最新主分支。
- 接口和生命周期沿已确定的可编程 Agent 设计实施；脚本不直接访问内部数据库或管理对象。

## 许可

代码仓库公开可见；目前尚未确定开源许可证。在正式确定许可证前，不对外授予额外的复用权利。
