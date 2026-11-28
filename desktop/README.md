# Nexum Desktop

独立的 Nexum Agent 桌面管理客户端。当前交付范围是基础工程：原生窗口、系统托盘、Go/React 绑定、主题与语言设置、独立 SQLite、生产/开发隔离以及独立构建与发布配置、真实 Bootstrap 初始化、SQLite 迁移和签名强制更新。Local/SSH 统一环境后端及真实模式 UI 已接线；Agent 生命周期具备受限环境检查、浏览器授权、安全安装、凭据恢复、启动、升级观察、缺失组件定向修复和真实工作区门禁。已使用配套开发 Cloud/Native 通过 macOS ARM64 本机浏览器授权、安装启动和真实 npm 清单端到端验收；Windows/Linux SSH、恢复及异常场景仍待验收。MCP/API/npm 只读清单已实现，详情、新增及 SDK、Skills、Scripts、Instructions 等管理业务继续按开发记录推进。

设计见 [Desktop 设计基线](../docs/desktop/design.md)，验收状态见 [基础工程](../docs/development/desktop-foundation.md) 和 [环境运行层](../docs/development/desktop-environment-runtime.md)。

## 开发环境

- Go 1.26.6、Node.js 24.22.1、pnpm 10.34.5；Wails CLI 与 Go Module 固定 v3.1.0。
- macOS 12+（构建机安装 Xcode Command Line Tools）；Windows x64/ARM64（WebView2 Runtime，打包需 NSIS 3.10）。
- 仅在原生 macOS/Windows 环境构建，不依赖本地 Docker 或虚拟机。
- 从 `desktop/` 运行以下命令；不需要主仓库、Cloud 凭据或正在运行的 Agent。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm tools:install
pnpm check
pnpm dev
```

`pnpm tools:install` 将固定版本 Wails CLI 安装到本工程忽略目录 `.tools/`。开发模式使用本机 127.0.0.1:9245 的 Vite HMR 与 Wails Go 重建，始终采用 development profile。关闭窗口默认进入托盘，也可在设置中选择退出；单击系统托盘图标恢复并聚焦原主窗口，右键原生菜单提供真实名称/版本、打开主窗口、设置、关于和退出；菜单语言跟随客户端设置，外观跟随系统。设置/关于遵守真实 Bootstrap 就绪门禁，退出遵守安全退出门禁，仅退出 Desktop，不停止 Agent。前端只能调用实际生成的 Go 绑定。

## 窗口外壳预览

当前主窗口采用 400 × 680 固定窄屏及统一自绘标题栏，正常工作区展示选定管理目标，不虚构 Agent 状态；启动、更新、工作区和设置页共用主题和窗口外壳。正常工作区及设置页顶部中央是 Logo + Agent 选择器（默认本机），齿轮按钮切换设置；启动和客户端更新共用极简 Bootstrap 页面，顶部仅显示平台窗口控件，正文保留 Nexum 字标、加载细线、状态文案和 DESKTOP 标识。设置采用无卡片扁平分组，支持真实主题、跟随系统/简体中文/English、真实客户端版本/发行通道和外部链接。两个 Profile 的常规、通知偏好与诊断入口均为真实功能：登录项注册及回读、窗口关闭行为、桌面通知总开关及子项、数据/日志目录打开。通知总开关默认关闭，开启后须获得系统通知授权；设置中可刷新原生状态并发送测试通知。Windows 显示登录项注册状态，不保证系统 Startup Apps 策略允许执行。测试通知受理不等于可见投递。macOS 左侧为 AppKit 原生交通灯，Windows 右侧为最小化、关闭控件；关闭均遵循当前客户端的关闭行为设置。开发版下拉菜单中的 Development Server、Test Server 为未连接的界面示例；生产版不显示这些示例项。默认本机目标不是已经连接的 Agent；真实 Local/SSH 后端已接线，并通过实际 Agent 管理协议完成就绪验证。

## 客户端界面预览

仅 development Profile 提供统一启动流程预览：打开顶部设置 → 开发预览 → 启动流程预览。也可先构建，再从 `desktop/` 启动：

```sh
pnpm build:dev
pnpm preview:startup
```

如果已有开发版窗口运行，请先从托盘退出该 Desktop 实例；同一 Profile 维持单实例。启动流程预览从初始化开始，通过正文底部开发预览控件切换 19 种启动、检查更新、下载、校验、准备安装、重启、数据备份/迁移/校验/恢复及异常状态，或结束预览并返回设置。各阶段沿用同一启动页样式；切换由用户控制，不执行额外初始化、数据备份/迁移/恢复或真实更新。失败状态的重试仅切换示例，手动安装明确标注未执行；查看客户端日志使用现有真实目录打开接口。启动和更新期间标题栏没有 Agent 与设置入口。浅色、深色、跟随系统及语言沿用已保存的应用设置。预览的版本与 68% 进度是示例，不会触发网络更新、安装或 Agent 操作；正式版不提供此入口。预览仅在真实 Bootstrap 就绪后可进入。发行包启动时真实检查当前通道；本地源码/HMR/候选构建使用 localBuild 模式，不伪造版本检查。已确认的签名更新要求跨重启保存，旧版不能离线或通过预览解除限制。

### 环境检查预览

仅 development Profile：设置 → 开发预览 → 环境检查预览，或从已构建的开发版执行 `pnpm preview:environment-check`。顶部环境菜单可切换本机、远程示例；每次切换从系统信息检查开始。正文顶部可手动切换七个基础检查阶段及各结果示例，初始化和 Agent 未授权（凭据明确缺失/失效）结果分别进入首次安装及连接恢复授权预览，网络异常和配置损坏不进入授权流程，升级结果可进入 Agent 自升级状态预览，修复结果可进入 Agent 异常修复预览，就绪结果可进入正常运行工作区示例。其他结果展示下一步与未接入说明，可重新检查或结束预览。所有检查结果均为示例，不读取 Agent 私有目录、扫描真实环境、连接远端、安装或启动 Agent。真实模式由生命周期控制器驱动，与此预览隔离。

### Agent 初始化授权与执行预览

仅 development Profile：设置 → 开发预览 → Agent 初始化预览，或构建后使用 `pnpm preview:environment`。从环境检查的初始化/Agent 未授权结果也可分别进入首次安装/连接恢复模式。旧独立初始化确认页已移除。显示目标与授权引导，无 Server URL、Token 或安装目录输入；「前往授权」仅切换等待示例，顶部手动选择首次安装的 14 个或连接恢复的 11 个授权、执行及结果阶段。执行页的七步/四步列表整体居中、内部左对齐，连接恢复复用已有安装，不显示下载安装或服务注册步骤；失败可返回检查，完成可查看正常运行工作区示例，切换目标或结束预览重置状态。全部为显式 UI 示例，不打开系统浏览器、不访问授权 API、不创建注册或安装/启动 Agent。后续原生实现按照 [Desktop 设计基线](../docs/desktop/design.md#agent-初始化授权与执行) 与 Nexum 主仓库 `docs/design/desktop-install-authorization.md` 接线。

### Agent 自升级状态预览

仅 development Profile：设置 → 开发预览 → Agent 升级预览，或从已构建的开发版运行 `pnpm preview:agent-upgrade`。环境检查的升级结果也可进入。复用状态画布，顶部手动切换等待、升级、恢复连接、结果未知和异常五种状态；版本号明确为示例，无虚假百分比及立即升级/取消升级按钮。返回、重新检查、检查并修复均回到环境检查示例；选择成功分支直接查看正常运行工作区示例，不额外展示成功页。切换目标重新检查；设置往返重置示例。此预览不读取 Agent 私有状态、不请求升级、不停止/启动/修复 Agent。实际 Local/SSH 生命周期观察、失败恢复和工作区自动恢复由生命周期控制器接线，参见 [Desktop 设计基线](../docs/desktop/design.md#agent-自升级状态观察)。

### Agent 异常修复预览

仅 development Profile：设置 → 开发预览 → Agent 修复预览，或从已构建的开发版执行 `pnpm preview:agent-repair`。从环境检查的「需要修复」结果点击「查看修复方案」也可进入。默认展示系统服务异常确认，可在预览顶部选择程序损坏、安装目录异常、系统服务异常或连接配置损坏，并切换确认、对应步骤、失败、结果未知和修复结束示例。开始修复只切换首个示例步骤；完成、返回和重新检查均回到环境检查 system 示例，不进入虚假就绪状态。步骤列表整体居中、内部左对齐；失败和结果未知均先复检。预览不执行真实修复、重启、数据删除、Token 重置或读取 Agent 私有数据；真实定向修复仅覆盖确认缺失的固定程序和系统服务，未知或冲突阻断。详见 [Desktop 设计基线](../docs/desktop/design.md#agent-异常修复)。

### Agent 正常运行工作区预览

仅 development Profile：设置 → 开发预览 → Agent 工作区预览，或构建后执行 `pnpm preview:agent-workspace`；也可从环境检查、初始化和升级的显式成功示例进入。顶部居中品牌和设备信息、独立运行/管理/Cloud 状态，下方为能力管理、AI 资料、运行活动和设置维护入口。预览中的版本、健康状态及业务数据均为示例。选择其他示例目标重新检查，选择真实 SSH 目标退出预览并沿原逻辑连接。结束预览返回设置。正式版不展示示例健康状态。详见 [Desktop 设计基线](../docs/desktop/design.md#agent-正常就绪与管理工作区)。

### SSH 连接界面预览

在开发版顶部环境菜单选择「添加远程环境」。仅填写主机地址、端口、用户名及认证信息，无须命名。连接状态页显示主机地址；真实连接成功后自动获取 Hostname、失败时回退到主机地址的逻辑已有独立后端实现，仍待主应用接线。默认密码认证并显示空白密码框，也可选择「使用本机 SSH 密钥」（通过系统 SSH Agent）或「指定私钥文件」查看不同表单；私钥按钮仅选择示例名称，不打开真实文件，密码框仅用于输入示例密码（请勿输入真实凭据），离开表单时清除。点击「连接并添加」进入连接状态页，通过正文顶部的连接状态预览控件手动切换正在连接、主机身份确认、正在认证、连接失败、认证失败和主机身份变化等展示状态。可检查信任、重试、取消或返回修改配置的 UI，保留非秘密字段，切换目标或进入设置会退出预览。所有状态均为明确的开发示例，不建立真实 SSH 连接、不保存凭据或新增目标。后续统一环境确认界面可通过菜单里的远程示例查看。

## 构建

| 命令 | 作用 |
| --- | --- |
| `pnpm bindings` | 生成当前 Go 服务的 TypeScript bindings |
| `pnpm check` | 品牌图标一致性校验、生成绑定、ESLint、类型检查、Vitest、Vite 构建、Go module 一致性、go vet、三种编译标签下的 Go 测试 |
| `pnpm build:dev` | 本地开发 Profile 的原生候选应用（内嵌前端，无需 Vite） |
| `pnpm test:update:mac` | 先 build:dev；在交互式 macOS 会话内用隔离身份、临时测试签名及真实 Schema 1→2 迁移执行 DMG 升级验收 |
| `pnpm icons:generate` | 在原生 macOS 从 Nexum SVG 更新四份原生图标及哈希清单 |
| `pnpm icons:check` | 跨平台验证已生成的品牌图标格式、尺寸及源图/资源哈希 |
| `pnpm run:dev` | 运行已构建的开发 Profile |
| `pnpm preview:startup` | 运行已构建的开发 Profile 并进入统一启动流程预览 |
| `pnpm preview:environment` | 运行已构建的开发 Profile 并进入Agent 初始化授权与执行预览 |
| `pnpm preview:environment-check` | 运行已构建的开发 Profile 并进入环境检查预览 |
| `pnpm preview:agent-upgrade` | 运行已构建的开发 Profile 并进入 Agent 自升级状态预览 |
| `pnpm preview:agent-repair` | 运行已构建的开发 Profile 并进入 Agent 异常修复预览 |
| `pnpm preview:agent-start` | 运行已构建的开发 Profile 并进入 Agent 启动状态预览 |
| `pnpm preview:agent-workspace` | 运行已构建的开发 Profile 并进入 Agent 正常运行工作区预览 |
| `pnpm build` | 生产 Profile 的原生应用候选 |
| `pnpm package:dev` | 开发 Profile 的 DMG 或 NSIS 安装包及 SHA-256 |
| `pnpm package` | 生产 Profile 的 DMG 或 NSIS 安装包候选及 SHA-256 |

原生应用与安装包分别保存在 `bin/development/`、`bin/production/`（安装包位于各自的 `release/`）。不要同时在同一源码目录执行多个构建任务；前端编译中间产物与绑定由当前任务重新生成。应用与原生系统图标统一使用 Nexum 品牌资源，macOS 菜单栏使用自动适配系统外观的透明单色模板。普通构建与 pnpm check 校验 SVG 及所有原生图标的生成清单，无须安装额外渲染工具。品牌源图变动时，在原生 Mac 上执行 pnpm tools:install（如尚未安装固定版本 Wails CLI）、pnpm icons:generate，再执行 pnpm icons:check；提交源图与生成的 build/ 图标和清单。第三方模板和 UI 组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## Profile 与本地数据

| | Production | Development |
| --- | --- | --- |
| 应用名称 | Nexum Desktop | Nexum Desktop Dev |
| App ID / 单实例 ID | com.nexum.desktop | com.nexum.desktop.dev |
| macOS 数据 | ~/Library/Application Support/NexumDesktop/ | ~/Library/Application Support/NexumDesktopDev/ |
| Windows 数据 | %APPDATA%\NexumDesktop\ | %APPDATA%\NexumDesktopDev\ |

两个目录各自保存 `desktop.sqlite`、`logs/desktop.log` 和独立的 Windows WebView2 数据目录 `webview/`。macOS 原生 WebView 采用不同应用 Bundle ID；不在 WebView 持久化业务数据。主题、语言、关闭行为及三个通知偏好由 Desktop SQLite 管理；登录项及通知权限从操作系统回读。Desktop 不读取、迁移或修改 Agent 的 `~/.nexum`、`~/.nexum-dev`、凭据或 runtime SQLite。生产/开发身份在构建时确定，不能通过 UI 或运行参数切换。

## CI 与发行

[Desktop CI](../.github/workflows/desktop-ci.yml) 使用 macOS/Windows 原生 x64/ARM64 Runner；普通变更构建两个 Profile 的候选包并上传 Actions artifacts。[Desktop Release](../.github/workflows/desktop-release.yml) 处理 `desktop/vX.Y.Z` 与 `desktop/vX.Y.Z-...` 标签，要求提交属于 main；不触发现有 npm 发布。开发版若四个原生构建全部通过但最终 publish 失败，且对应制品未过期，可在 main 手动运行该工作流并填写原发行 Run ID（`recovery_run_id`）。恢复严格核验原 Tag、提交、四个构建任务及制品身份，不重建或覆盖原包，不允许恢复 Production 发行。

- 带预发行后缀的标签生成 Development 包并作为 GitHub Pre-release 发布；正式标签生成 Production 包。
- 正式发布强制签名：macOS Developer ID 和 Apple 公证，Windows Authenticode。配置仓库受保护的发布 Secrets：`APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_APP_PASSWORD`、`APPLE_TEAM_ID`、`WINDOWS_CERTIFICATE_PFX_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD`。缺少签名材料时正式发行失败关闭，不将未签名候选当作已正式发行。
- 本地和普通 CI 默认是候选构建（macOS ad-hoc，Windows 未签名），并非对外受信任正式安装包。
- 发行前汇总四个平台的安装包、SHA-256 与原生构建元数据，生成 Ed25519 签名的 update.json / update.json.sig（包含安装包和安装后程序的哈希）；先创建 draft，再发布，拒绝覆盖已有发行。两个通道各自配置仓库 Variables：NEXUM_DESKTOP_UPDATE_PUBLIC_KEY_PRODUCTION / NEXUM_DESKTOP_UPDATE_PUBLIC_KEY_DEVELOPMENT（32-byte Ed25519 原始公钥 Base64），Secrets：NEXUM_DESKTOP_UPDATE_PRIVATE_KEY_PRODUCTION / NEXUM_DESKTOP_UPDATE_PRIVATE_KEY_DEVELOPMENT（PKCS#8 DER Ed25519 私钥 Base64）。发行构建强制内置当前通道公钥，签名时匹配公私钥；缺失或不匹配即失败，不自动创建正式密钥。私钥从不进入构建制品。
- Desktop 版本、SDK/Browser npm 版本、Cloud Native 版本独立；`desktop/v*` 不改变 npm dist-tag 或 Cloud 镜像。

GitHub Actions 文件存在不等于 CI 通过，签名配置存在不等于签名实际完成。查看对应提交的运行和制品。
