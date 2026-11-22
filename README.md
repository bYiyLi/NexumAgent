# NexumAgent

Nexum Agent 的独立、公开 Node 执行宿主与扩展项目，面向多种 AI Host 与 Agent Runtime；可通过 Git Submodule 被主仓库引用。

## 当前状态

**Phase 52 正在整合，整体验收尚未完成。** 常驻 Go Agent 拥有 Cloud 连接、当前授权、Run 生命周期、SQLite、MCP/OpenAPI 与受管资源；本包只提供 Node `24.22.1` 宿主、逐 Run Worker、JavaScript 模块加载、SDK/Browser 扩展及资料生成，不再提供与 Go 竞争的 `nexum-agent` npm CLI。

Go 与 Node 使用父子进程 stdin/stdout 上的逐行双向 JSON-RPC 2.0；日志走 stderr，大附件与媒体使用受管引用。Node 的就绪、真实结果与收尾由 Go 确认；Node 安装或初始化失败不应把 Go 在线误报为脚本可运行。

旧 TypeScript Core、Cloud 编排、Node SQLite、MCP/OpenAPI 适配及维护执行后端已移除。Node 只通过现有 Host RPC 使用 Go 管理的运行事实和服务；扩展维护保留公开 facade，不在 Node 内执行配置变更。仍需按 Phase 52 完成全链路与原生平台验收，局部测试不等于完整交付或已发布。Node VM 不是恶意代码安全沙箱，系统隔离由目标 OS/容器承担。

此仓库不包含 Nexum Cloud 的私有代码、配置、Token 或生产部署资源。

## 文档

[Nexum browser 完整设计与验收资料](docs/browser/README.md)包含 SDK、类型、插件连接、生命周期、结果、独立 npm 包和逐项验收，以及 Avru/原始接口资料的本地归档。[可选包候选实现](packages/browser/README.md)已开始实现并进行组件测试，不作为 Agent 默认依赖或默认安装项；完整能力、原生浏览器验收和发行尚未完成。

## npm 发布：Tag 正式版、手动测试版

统一使用 GitHub Actions 的 `.github/workflows/npm-next.yml` 发行 `@nexum-hub/sdk`、`@nexum-hub/agent`、`@nexum-hub/browser`，三包同版，依次构建、检查、发布，并回读 npm Registry。只有发布者推送 `vX.Y.Z` Tag 才会触发正式版；手动运行该工作流（选择 `main`）只会发布 `next` 测试版。**普通推送 `main` 不自动发布 npm 包。**

- **正式版**：在已提交并推送到 `main` 的代码上执行 `git tag v0.0.3 && git push origin v0.0.3`（下一版示例），CI 从 Tag 解析 `0.0.3`，发布三个 `0.0.3` 包并将 dist-tag 设为 `latest`；非 `vX.Y.Z` 格式或不属于 `main` 历史的 Tag 不发布。
- **测试版**：在 GitHub Actions 手动运行 `Publish npm`（或 `gh workflow run npm-next.yml --ref main`）。如尚无正式 Tag，默认以 `0.0.1` 为基线，自动生成 `0.0.1-next.<run_number>`；如果已有正式 Tag（例如 `v0.0.2`），则自动生成下一补丁测试版 `0.0.3-next.<run_number>`。`run_number` 是 GitHub Workflow 的唯一运行序号，不必人为维护版本。
- **已发布版本不可覆盖**：在 Registry 中检查同版本实际 tarball 校验值；内容不一致时停止，而不是重发。如果内容完全一致，可复用不可变制品并按需要更新 dist-tag。已发布的 `0.0.1`、`0.0.2` 与历史测试版均保留；下一次正式版使用未占用的版本号。

三个包继续保持 `UNLICENSED`，公开可安装不代表开源再分发授权。发布工作流通过 GitHub Actions OIDC 可信发布，不再要求或注入长期 npm Token；Token、OTP 和私有配置不能进入仓库或 CI 日志。

### Trusted Publishing / OIDC（已验证）

在 npmjs.com 分别进入 `@nexum-hub/sdk`、`@nexum-hub/agent`、`@nexum-hub/browser` 的 **Settings → Trusted Publishing**，添加 GitHub Actions Publisher，每个包填写相同配置：

| 项目                        | 值                                       |
| --------------------------- | ---------------------------------------- |
| GitHub organization or user | `bYiyLi`                                 |
| GitHub repository           | `NexumAgent`                             |
| Workflow filename           | `npm-next.yml`（仅文件名，不包含目录）   |
| Environment                 | 留空                                     |
| Allowed actions             | 同时允许 `npm publish` 和 `npm dist-tag` |

2026-11-16 在 GitHub Actions [Run 43813668730](https://github.com/bYiyLi/NexumAgent/actions/runs/43813668730) 真实验证：旧 Token 发布步骤跳过、无 Token 门禁通过、三个包由 npm OIDC 发布 `0.0.3-next.11` 成功。Registry 回读三包 `next=0.0.3-next.11` 且 `latest=0.0.2`，三个公开 tarball 均已下载并核对 SHA-1。后续正式 Tag 与 `main` 手动发布统一直接使用 OIDC，工作流不再有 token 回退分支。GitHub Secret `NPM_PUBLISH_TOKEN` 已删除并回读确认不存在；npm 账户中原始访问 Token 尚未撤销，仍需 npm 包所有者在 npm 网站操作。

`nexum-agent` CLI 由 Cloud 分发的 Go 制品提供；本 npm 包只分发 Node 宿主。npm 发布、Cloud 镜像发布和系统服务部署分别验收。

### Cloud 分发与全新安装

Cloud 安装命令只写入所选 profile 的配置、下载并校验 Go 二进制、注册当前用户服务及启动，不预装 JavaScript 工具链。development 使用 `~/.nexum-dev`，production 使用 `~/.nexum`；生命周期操作前核实 profile 与 `server_url`，不能借用另一环境。

Cloud 镜像包含固定 Node 的六个平台安装包。Go 先检查本 profile 的 `runtime`：版本、可执行平台及 npm 有效时直接复用，缺失或损坏时只从配置的 Cloud 下载，验证 SHA-256/大小后用 Go 解压。不要求机器预装 Node/npm/pnpm 或解压工具，不扫描全局 Node/nvm，也不回源到其他 Node 下载站。首次准备不是离线单文件分发。

宿主从 `@nexum-hub/agent` 安装到 `node-host/<version>`；Cloud 用 `development → next`、`production → latest` 选择精确 npm 版本。失败保留明确诊断，不切换旧 Core。采用全新配置与新版数据库，不提供旧版迁移、兼容入口或升级回退；不静默清空实际用户状态。

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

- 此仓库拥有 Node 宿主、SDK 和 Browser 的源码、独立 Git 历史及 npm 构建/发布流程；Go Agent 与 Cloud 镜像在主仓维护。
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
