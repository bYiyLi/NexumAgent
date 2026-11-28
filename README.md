# NexumAgent

Nexum Agent 的独立、公开 Node 执行宿主与扩展项目，以及 Nexum Desktop 桌面管理客户端；可通过 Git Submodule 被主仓库引用。

## 当前状态

**Phase 52 正在整合，整体验收尚未完成。** 常驻 Go Agent 拥有 Cloud 连接、当前授权、Run 生命周期、SQLite、MCP/OpenAPI 与受管资源；Node Host 只提供 Node `24.22.1` 宿主、逐 Run Worker、JavaScript 模块加载、SDK/Browser 扩展及资料生成，不再提供与 Go 竞争的 `nexum-agent` npm CLI。

Go 与 Node 使用父子进程 stdin/stdout 上的逐行双向 JSON-RPC 2.0；日志走 stderr，大附件与媒体使用受管引用。Node 的就绪、真实结果与收尾由 Go 确认；Node 安装或初始化失败不应把 Go 在线误报为脚本可运行。

旧 TypeScript Core、Cloud 编排、Node SQLite、MCP/OpenAPI 适配及维护执行后端已移除。Node 只通过现有 Host RPC 使用 Go 管理的运行事实和服务；扩展维护保留公开 facade，不在 Node 内执行配置变更。仍需按 Phase 52 完成全链路与原生平台验收，局部测试不等于完整交付或已发布。Node VM 不是恶意代码安全沙箱，系统隔离由目标 OS/容器承担。

此仓库不包含 Nexum Cloud 的私有代码、配置、Token 或生产部署资源。

## Nexum Desktop

[Desktop](desktop/README.md) 是独立 Wails/Go/React 工程，采用自己的 Go Module、pnpm Workspace、SQLite 和生产/开发 Profile；不依赖私有主仓库构建。当前仅建设基础工程，Agent 管理业务与跨平台发行验收见其开发记录。

## 文档

[Nexum browser 完整设计与验收资料](docs/browser/README.md)包含 SDK、类型、插件连接、生命周期、结果、独立 npm 包和逐项验收，以及 Avru/原始接口资料的本地归档。[可选包候选实现](packages/browser/README.md)已开始实现并进行组件测试，不作为 Agent 默认依赖或默认安装项；完整能力、原生浏览器验收和发行尚未完成。

## 分发与扩展 npm 包

Node Host 的源码包为私有 `@nexum/node-host`，**不再作为 npm Core 发布或安装**。主仓库 Cloud Docker 镜像构建时从本仓库固定 Submodule 提交生成 `node-host-<version>.tar.gz`，Go Native Agent 按当前 Cloud 的 Host Manifest 下载、验证和管理本地 `node-host/<version>/`。Node Host 的安装身份与平台 SDK Owner 不同；内置平台统一使用固定 Owner `nexum`，不从 npm 包名推导权限。

npm 仅发布独立的 `@nexum-hub/sdk` 与可选 `@nexum-hub/browser`。GitHub Actions `.github/workflows/npm-next.yml` 在 `vX.Y.Z` Tag 发布正式版本（`latest`），在 `main` 手动运行时发布测试版（`next`），并使用 OIDC 回读 npm Registry；普通 `main` 推送不自动发布 npm 包。两包的版本和发布门禁由 `scripts/npm-release.mjs` 管理。上传被接受后只读 Registry 索引最长等待 10 分钟/包，同时核对版本、dist-tag、SHA-1 与 SHA-512；超时不自动重发。保留相同的已准备版本、包字节及 RELEASE_VERSION/RELEASE_TAG 时，可用 `node scripts/npm-release.mjs verify-index` 重新验证，不上传或改动 dist-tag。

SDK/Browser 的 npm 发行与 Cloud 镜像、六平台 Go Agent、Node Host 归档及设备部署分别验收。不能将 npm 成功发布等同于 Native 或 Node Host 已部署成功。

### Cloud 管理的安装与破坏性升级

Cloud 安装命令只写入所选 profile 的配置、下载校验 Go 二进制、注册用户服务并启动。development 使用 `~/.nexum-dev`，production 使用 `~/.nexum`；Go 按本 profile 的 Node 24.22.1 校验和 Cloud Manifest 准备受管运行时，不从 npm 安装 Core。

本次 Go Native 升级**不兼容旧 Core 身份和运行历史**：SQLite 版本 2 一次性删除旧 Run、上下文、任务、受管资源、Transfer、操作和 Agent State 等持久运行记录及旧备份；保留已认证的 Agent/Profile 绑定与用户 work 目录。新资源一律使用 Owner `nexum`；旧记录不做别名读取、转换或续接。重新启动已是新版数据库的 Agent 时，不再次清空新产生的数据。

## 本地开发

仅支持 Node.js `24.22.1`，开发使用 pnpm `10.34.5`：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` 执行 TypeScript 类型检查、构建及 Node 内置测试，测试进程带 `--experimental-vm-modules`。GitHub Actions 配置 Linux、macOS、Windows 的原生 Node 检查矩阵；实际通过状态以对应提交的运行结果为准。

`pnpm build` 先清空 `dist/`，避免已删除实现残留在 npm 制品。Node/SDK/Browser 组件测试使用测试专属的内存事实与真实 HostRunner、Worker、Registry，不打开 SQLite，也不将该测试 peer 当作 Go 持久化、授权或故障恢复验收。

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

上例是合并进当前配置的字段；字节和毫秒使用正安全整数，生成的到期日期不得超过 9999 年，未知字段会被拒绝。Go 在所选 profile 初始化时读取配置；策略只用于新对象，不能缩短已保存的保留承诺。容量不覆盖依赖包、用户项目或任意 Node/sh 写入。安装命令会生成连接配置，执行前保存本地自行调整的策略；这里不承诺旧配置迁移。

## 运行日志

每个运行的 console 输出保存在当前 profile 的 `logs/runs/<runId>/console.log`，文件滚动保留最新内容，包含首行在内最多 50 MiB。它使用原生 Node 文件及流能力，按实际增长申请受管容量；运行终态等待已接纳的写入真正完成。

日志是 UTF-8 文本，首行 `NEXUM_RUN_LOG_V1` 后的 JSON 记录原日志流的 `startOffset/endOffset`，后续为 console 正文。`agent.run.get` 只返回有界预览；裁剪或预览不完整时返回实际保留范围及 `dataOffset/nextOffset`。活跃日志再次滚动后须重新核对范围；丢失或被外部改写的文件明确报告不可用。

## 仓库关系

- 此仓库拥有 Node Host、SDK 和 Browser 的源码及独立 Git 历史；只有 SDK/Browser 通过 npm 发布，Cloud、Go Agent 与 Node Host 制品由主仓配套构建分发。
- Nexum Cloud 仓库只引用本仓库的固定提交，不复制源码或隐式追踪最新主分支。
- 接口和生命周期沿已确定的可编程 Agent 设计实施；脚本不直接访问内部数据库或管理对象。

## 许可

代码仓库公开可见；目前尚未确定开源许可证。在正式确定许可证前，不对外授予额外的复用权利。

## 扩展类型构建

公开扩展类型由单一源码生成，不需要把 Go Agent 或 Node 宿主的运行服务安装到扩展项目中：

```bash
node scripts/build-extension-api.mjs
```

`packages/extension-api` 只包含生成的声明、空 ESM 入口和说明，不包含宿主初始化、管理对象或凭据。npm 包发布与实际 Registry 状态按上方流程分别核实。

Go Agent、六架构制品、Cloud 内置 Node 和三平台用户服务由主仓负责。本仓不再定义另一套签名安装归档、旧版本切换或回退流程；原生安装、真实 Chrome/Edge 插件及登录启动仍需对应平台实测，不能由类型检查或交叉构建代替。
