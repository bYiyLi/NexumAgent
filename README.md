# NexumAgent

Nexum 的独立、公开 TypeScript Agent 项目。它是运行在用户本地系统的 Agent，面向多种 AI Host 与 Agent Runtime；与 Nexum Cloud 分仓维护，可通过 Git Submodule 被主仓库引用。

## 当前状态

**正在实现可编程运行时，尚未形成可连接使用的完整 Agent。** 当前 CLI 仍只支持 `--help` 和 `--version`。已实现的内部基础包括：

- `contracts/v2` 的八个工具输入 Schema、可信 wire envelope、正反例，以及独立 Draft 7 脚本入参校验；
- 原生 SQLite 的绑定/迁移、运行接纳与去重、输入单次消费、工作关闭、后台资源交接、历史筛选、共享值版本更新及重启中断；
- 独立 JavaScript 作用域、编译与调用分离、动态 import/require、Node/npm 准入、原生 ESM/CJS 条件、显式文件模块与缓存换版检查；
- `.js` JSON 头部、自动收录/冲突检查、来源命名空间与手册生成、默认 30 项和高频 Top 20 的完整定义选择；
- 独立于观察请求的运行协调、代码/输入快照、同次执行的单次输入续接、协作取消/总期限、历史重放和结果保存边界；
- 个人、Agent 和项目指令与 Skills 发现、项目 visibility 过滤、README 摘要、工作资料的创建/串行刷新/关闭及固定快照，以及按修订保存的脚本/npm 手册；
- 扩展实例/运行绑定的资源登记、身份去重、当前授权、后台交接及信号解除；运行终态等待真实 `closed` 证据，清理尝试有界，失败与未确认项保留在本地记录中；
- 公共扩展工厂、方法注册/发布、调用上下文与权限检查，以及初始化失败清理、占用保护、停用和脚本来源 lease；
- SDK operation 持久登记、原生 Promise 拒绝归属及真实结算收尾，未 `await` 的受管调用同样阻止运行提前结束，普通同步值和二进制对象不经过 JSON 转换；
- `output` 的文本、JSON、图片、音频、资源链接、嵌入资源和混合结果意图包装；只声明返回内容，不在 helper 中读取媒体或创建传输身份。

完整 SDK、Cloud 鉴权/连接、多附件与媒体结果适配、MCP/API/扩展维护、安装更新及整体验收仍在实施范围内。公共扩展调用与工作资料服务已分别接入运行协调器；包加载、五类贡献的整体发布、平台内置 SDK 和实际 Cloud 业务链路尚未完成。测试使用独立的 JSON 结果提供者验证控制流程，`output` 意图尚未接入完整编码器，不代表数据面或媒体交付已实现。不能将组件测试视为产品验收。Node VM 用于执行作用域，系统安全由目标 OS/容器负责，不提供恶意代码安全沙箱。

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
