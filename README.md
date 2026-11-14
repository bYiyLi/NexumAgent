# NexumAgent

Nexum 的独立、公开 TypeScript Agent 项目。它是运行在用户本地系统的 Agent，面向多种 AI Host 与 Agent Runtime；与 Nexum Cloud 分仓维护，可通过 Git Submodule 被主仓库引用。

## 当前状态

**正在实现可编程运行时，整体验收尚未完成。** 当前 CLI 支持 `--help`、`--version` 及明确选择 profile 的 `run --profile development|production`；连接与运行入口已接线，不能据此宣称完整版本已交付。已实现的内部基础包括：

- `contracts/v2` 的八个工具输入/输出 Schema、可信 wire envelope、独立数据面描述及跨 TS/Go 正反例，以及独立 Draft 7 脚本入参校验；
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
- 受管 `sh/transfer`、npm 扩展加载与五类贡献整体发布、MCP Tasks/Host 请求/订阅和 OpenAPI 适配、维护请求及 npm 执行组件；
- WSS 身份绑定、短期授权、HTTP 数据面、多附件、README 更新及应用组合入口，以及从实际源码生成的独立公开类型包 `@nexum/extension-api`。

以上是待整体验收的开发快照。MCP/API 配置与 OAuth、用户共享数据的 Cloud authority、远端资源投影、Task 保护、清理器及安装脚本已有实现；真实链路、配额边界、原生服务与三平台支持仍须按最终源码分别验证。Console 进程控制和 MCP Apps 尚未完整承接，不能宣称所有 AI Host 特性已交付。媒体验证覆盖格式、尺寸/时长和有界 metadata，不声明已完整解码所有像素、动画帧或音频样本。Node VM 用于执行作用域，系统安全由目标 OS/容器负责，不提供恶意代码安全沙箱。

此仓库不包含 Nexum Cloud 的私有代码、配置、Token 或生产部署资源。

## 文档

[Nexum browser 完整设计与验收资料](docs/browser/README.md)包含 SDK、类型、插件连接、生命周期、结果、独立 npm 包和逐项验收，以及 Avru/原始接口资料的本地归档。[可选包候选实现](packages/browser/README.md)已开始实现并进行组件测试，不作为 Agent 默认依赖或默认安装项；完整能力、原生浏览器验收和发行尚未完成。

## 本地开发

需要 Node.js 24.22.1（当前验证基线）、pnpm 10.34.5：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node dist/cli.js --help
```

`pnpm check` 执行 TypeScript 类型检查、构建及 Node 内置测试，测试进程带 `--experimental-vm-modules`。GitHub Actions 配置 Linux、macOS、Windows 的原生 Node 检查矩阵；实际通过状态以对应提交的运行结果为准。

## owner 的保留与容量配置

owner 可直接在所选 profile 的 `config.json` 中添加可选 `storage` 和 `retention`；不增加另一个配置文件或脚本 SDK。development 使用 `~/.nexum-dev/config.json`，production 使用 `~/.nexum/config.json`。保留原有 `server_url` 和 `token`，配置只由该本地账户读取，不要把完整文件交给 AI 或提交到仓库。

```json
{
  "storage": { "max_managed_bytes": 21474836480 },
  "retention": {
    "work_idle_ms": 86400000,
    "run_history_ms": 2592000000,
    "run_logs_ms": 604800000,
    "input_attachments_ms": 86400000,
    "artifact_ms": 604800000,
    "material_copies_ms": 604800000
  }
}
```

上例是要合并进现有配置的字段，数值为默认值；字节和毫秒均使用正安全整数，生成的到期日期必须处于协议支持的 RFC 3339 范围（不超过 9999 年），未知字段会被拒绝。省略这些配置继续使用默认策略。配置在下次正常启动时读取，新保留策略只用于新对象；已有记录、产物和 Task 的原保留承诺继续有效。缩短新对象的期限不会提前删除旧对象；容量限制覆盖受管数据，不覆盖依赖包、用户项目或任意 Node/sh 写入。更新安装器默认逐字保留已有配置，明确替换配置时才采用新的内容。

## 运行日志

每个运行的 console 输出保存在当前 profile 的 `logs/runs/<runId>/console.log`，文件滚动保留最新内容，包含首行在内最多 50 MiB。它使用原生 Node 文件及流能力，按实际增长申请受管容量；运行终态等待已接纳的写入真正完成。

日志是 UTF-8 文本，首行 `NEXUM_RUN_LOG_V1` 后的 JSON 记录原日志流的 `startOffset/endOffset`，后续为 console 正文。`agent.run.get` 只返回有界预览；发生裁剪或预览不完整时，返回保留范围、实际文件位置及 `dataOffset/nextOffset`，可以通过获准 Node 文件能力继续读取。活跃日志再次滚动后须重新核对范围。旧版本保留的普通文本日志继续可读；丢失或被外部改写的文件明确报告不可用。

## 仓库关系

- 此仓库拥有 Agent 的源码、独立 Git 历史、构建与未来发布流程。
- Nexum Cloud 仓库只引用本仓库的固定提交，不复制源码或隐式追踪最新主分支。
- 接口和生命周期沿已确定的可编程 Agent 设计实施；脚本不直接访问内部数据库或管理对象。

## 许可

代码仓库公开可见；目前尚未确定开源许可证。在正式确定许可证前，不对外授予额外的复用权利。

## 本地安装候选与原生用户服务

安装组件使用固定 Node `24.22.1`、`--experimental-vm-modules` 和明确的 `run --profile development|production`。macOS 使用用户 LaunchAgent，Linux 使用 `systemd --user`，Windows 使用当前用户 `InteractiveToken` 任务。它们不提权、不保存用户密码；登录会话与无人登录启动不同，安装器不会自动启用 Linux linger。Windows 任务负责登录启动与启停，启动器以原生 Job 约束自身及继承的进程树，任务退出时由系统关闭 Job，避免只停启动器而留下 Node。现有启动器对 Agent 非零退出每次等待 10 秒、至多重试 255 次；退出 0 立即停止，不能仅靠 Task Scheduler 的启动失败重试承诺程序退出后重启。正式 Agent 诊断统一写入 profile 内有界的 `logs/agent.log`；macOS LaunchAgent 将 stdout/stderr 指向 `/dev/null`，避免重复生成无界服务日志。Linux stdout/stderr 由 journald 管理，Windows 任务不另写服务日志。

公开扩展类型由单一源码生成，不需要把 Agent 的运行服务安装到扩展项目中：

```bash
node scripts/build-extension-api.mjs
```

`packages/extension-api` 的本地 npm 包只包含生成的声明、空 ESM 入口和说明；没有私有 Core manager、Agent 初始化或凭据。当前尚未发布到 npm。

创建本机平台的安装候选时，需要独立提供 Ed25519 私钥；不要把私钥放进源码、产物目录或 CI artifact：

```bash
pnpm run build:candidate \
  --out-dir /absolute/candidate-output \
  --signing-key-file /absolute/private-release-key.pem
```

构建在隔离目录编译，按锁文件准备实际生产依赖，包含固定 Node/npm，并检查 `node-pty`、`koffi` 能在本平台加载。输出为平台归档、整个归档的 SHA-256、独立签名和单独可审阅的 `installer-kit`。首次 bootstrap 运行 kit 中的脚本，不从尚未验证的程序归档中提取并执行验证器。Agent 的 browser 资料归档、测试、本机 state/log/config/tmp 不进入程序归档；不同 OS/架构不能共用一份原生依赖产物。

安装前，从独立可信渠道取得发布者公钥及预期 digest。安装器不信任归档或 manifest 自带的公钥，也不会先执行归档里的 Node 进行自证。完整安装脚本位于 `scripts/install.sh`、`scripts/install.ps1`，它们先按内置官方 SHA-256 校验 bootstrap Node。已有可信的固定版本 Node 时，也可直接运行下列入口：

```bash
node scripts/install-agent.mjs \
  --archive /absolute/nexum-agent-platform.tar.gz \
  --sha256 EXPECTED_SHA256 \
  --signature-file /absolute/nexum-agent-platform.tar.gz.sig \
  --public-key-file /absolute/independently-trusted-public.pem \
  --profile development
```

首次安装通过标准输入提供包含 `server_url`、`token` 的 JSON；不要把 Token 放进 argv、服务定义或日志。production 要求 HTTPS；development 使用自己的 Server URL 与 `~/.nexum-dev`。配置写入所选 profile 的私有 `config.json`。默认注册并请求启动当前用户服务，`--no-start` 只安装/启用持久定义而不立即启动，`--no-register` 仅准备程序和可检查的 manifest。临时 home 只允许与 `--no-register` 一起使用，供隔离验证。

再次安装新签名归档会保留配置；若明确替换凭据，需要 `--replace-config` 并重新从标准输入提供配置。程序先验签并固定到私有副本，校验平台与完整内容后，才停止旧服务、切换版本和请求启动。命令失败或结果未知时，先检查真实服务及版本状态，不盲目重放更新。

已有选定版本时，`--no-register` 只准备新程序与独立预览，保留原 `active.json`、配置及服务启动文件；它不能与更换既有配置混用。Windows 预览使用单独的 `service-preview-launch.ps1`，不会改变原任务下次启动的目标。清理仍保护原选定版本；正式切换需执行常规安装更新。

选定程序目录下的 `scripts/service.mjs` 提供 `install/start/stop/status/remove --profile ...`。`stop` 同时关闭以后自动启动；`start` 重新启用。退出码 `0` 停止，不自动重启；需要重启使用 `75`，其它非零故障按各平台的有界策略重启，Windows 沿上面的任务及启动器分工。安装入口的 `--cleanup --profile ...` 只清理有安装凭据且不再 active 的旧程序版本，不删除工作资料、运行记录或凭据，不执行旧 Node，也不接管旧 PID。

`Agent install candidates` 是手动触发的三平台候选构建、临时安装与原生用户服务生命周期工作流。服务测试使用临时 home 和含路径 hash 的唯一标签，实际验证 0/75/故障退出、停止、恢复及注销，不使用真实用户的 Agent profile；Linux 仅在受守卫的 GitHub-hosted 临时 runner 中按需准备当前 UID 的 user manager，不启用 linger，不启动第二个 manager，也不退出已有 manager。其中签名密钥为一次性测试身份，不能当作正式发布信任锚。`Optional browser package` 独立检查可选包，不成为 Agent 默认安装或测试的依赖。这些工作流定义不代表对应提交已经 CI 通过，也不代表用户服务的真实登录、登出、重启和上线已完成验收。
