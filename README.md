# NexumAgent

Nexum 的独立、公开 TypeScript Agent 项目。它是运行在用户本地系统的 Agent，面向多种 AI Host 与 Agent Runtime；与 Nexum Cloud 分仓维护，可通过 Git Submodule 被主仓库引用。

## 当前状态

**正在实现可编程运行时，尚未形成可连接使用的完整 Agent。** 当前 CLI 仍只支持 `--help` 和 `--version`。已实现的内部基础包括：

- `contracts/v2` 的八个工具输入 Schema、可信 wire envelope、正反例，以及独立 Draft 7 脚本入参校验；
- 原生 SQLite 的绑定/迁移、运行接纳与去重、输入单次消费、工作关闭、后台资源交接、历史筛选、共享值条件写入/删除及重启中断；共享值删除后保留版本序列，避免旧读取版本误写重建值；
- 独立 JavaScript 作用域、编译与调用分离、动态 import/require、Node/npm 准入、原生 ESM/CJS 条件、显式文件模块与缓存换版检查；
- `.js` JSON 头部、自动收录/冲突检查、来源命名空间与手册生成、默认 30 项和高频 Top 20 的完整定义选择；
- 独立于观察请求的运行协调、代码/输入快照、同次执行的单次输入续接、协作取消/总期限、历史重放和结果保存边界；
- 个人、Agent 和项目指令与 Skills 发现、项目 visibility 过滤、README 摘要、工作资料的创建/串行刷新/关闭及固定快照，以及按修订保存的脚本/npm 手册；
- 扩展实例/运行绑定的资源登记、身份去重、当前授权、后台交接及信号解除；运行终态等待真实 `closed` 证据，清理尝试有界，失败与未确认项保留在本地记录中；
- 公共扩展工厂、方法注册/发布、调用上下文与权限检查，以及初始化失败清理、占用保护、停用和脚本来源 lease；
- SDK operation 持久登记、原生 Promise 拒绝归属及真实结算收尾，未 `await` 的受管调用同样阻止运行提前结束，普通同步值和二进制对象不经过 JSON 转换；
- 使用同一扩展协议注册的 `runtime.requestInput`、`state.agent/user` 和 `output` 门面；状态服务按方法声明及当前 key 权限绑定，用户范围通过独立 Cloud authority 接口访问；
- `output` 的文本、JSON、图片、音频、资源链接、嵌入资源和混合结果意图包装，以及受预算约束的 JS 值规范化和 Agent 本地结果编码；
- `work/resources` 的原子登记、固定内容与 SHA-256、目录分页/当前权限、真实流关闭、到期/丢失反馈，以及标准 MCP 内容构建和 Resources 的 `text/blob` 正文；保存结果只含规范化数据和资源身份，媒体 bytes 在授权交付时读取。

完整 `sh/transfer`、Cloud 鉴权/连接、多附件、跨端媒体数据通道、MCP/API/扩展维护、安装更新及整体验收仍在实施范围内。公共扩展调用、工作资料与结果服务已有真实组件集成；包加载、五类贡献整体发布、用户共享数据的真实 Cloud authority 和实际业务接线尚未完成。结果测试验证本机文件及 MCP 内容结构，不代表 Cloud 传输或某个 AI Host 已交付。媒体验证覆盖格式、尺寸/时长和有界 metadata，不声明已完整解码所有像素、动画帧或音频样本。整 profile 配额、Task 保护和清理器尚待接入。不能将组件测试视为产品验收。Node VM 用于执行作用域，系统安全由目标 OS/容器负责，不提供恶意代码安全沙箱。

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
