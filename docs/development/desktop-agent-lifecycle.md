# Desktop Agent 生命周期管理

状态：生命周期与启动体验优化已实现，Desktop 完整门禁、Native 专项回归、macOS ARM64 候选构建与隔离原生窗口验收通过（2026-11-28）。真实 Dev Agent 管理与旧协议兼容已在当前原生窗口验证；新版 Native/安装器尚未配套部署，新增 Node 实时进度的真实首次安装、自升级及 Windows / 独立 Linux SSH 全链路仍待验收。此前真实安装、启动、凭据恢复、缺失程序/服务修复及 SSH 回环验收见历史记录。

设计基线：Desktop 设计中的 Agent 生命周期真实接线。范围从 Bootstrap 就绪及 Local/SSH 连接开始，到经 Native 实际验证的 Agent 工作区为止。能力管理的只读清单已接线，实际验收见 [能力管理](desktop-capabilities.md)。本阶段不部署或变更生产环境。

## 实施状态

| 实施项 | 当前实现与边界 |
| --- | --- |
| Local / SSH Runtime | 真实 Local/SSH 目标、Lstat 路径检查、受限命令执行、SSH stdin 与脱敏 progress marker；SSH 断线/未知结果不自动重放 |
| 环境检查与管理协议 | Desktop Lifecycle Controller、Native 管理协议 v1、受限 CLI；验证 Profile、OS/arch、固定 Agent 路径、服务定义、配置、凭据、版本及实际管理连接 |
| 首次初始化 | PKCE loopback、浏览器授权、Cloud purpose=initialize、Manifest/平台/架构/大小/SHA-256 校验、磁盘空间复检、stdin 安装、独占创建新 Profile |
| 恢复授权 | Cloud purpose=restore，禁止创建 Agent；已知 Agent ID 绑定 expectedAgentId，服务端在轮换前校验；Web 只显示匹配目标，未知身份时提示核对主机/平台 |
| 运行中凭据恢复 | 用户浏览器明确批准后重新检查；只停止已核实的当前 Profile 服务，确认管理连接消失，再验证新 Token、原子更新配置、回读并启动；服务缺失时恢复配置后转入修复；未知服务/配置/停止结果阻断 |
| 启动 | 当前 Profile 专属 launchd / systemd --user / Windows Task Scheduler；启动请求受理与实际管理连接就绪分离 |
| 实时步骤进度 | Unix/PowerShell 安装器、Native helper 和只读 runtime-progress 观察接口提供受限真实阶段；已知下载字节总量时显示百分比及实际量。Local/SSH 共用快照、标记解析和有界阶段记录；未知总量使用不确定进度，已观察不等于已完成 |
| 页面收敛 | BootstrapView 与 AgentLifecycleView 共用启动视觉语言；保留既有窗口与标题栏。检查、初始化、安装、启动、升级、修复及异常共用生命周期渲染器；开发设置仅一个生命周期预览入口，旧启动参数作为兼容别名 |
| Node Host 就绪 | Agent 自主管理 Node、pnpm、Host 的准备与恢复；Desktop 只读观察，已验证身份后有界等待已知准备阶段；异常、超时或旧接口无细节时允许降级管理，健康状态以 executionReady 为准 |
| 升级 | 观察 Agent 自升级和实际运行版本，不增加 Desktop 第二套 Agent 升级器 |
| 定向修复 | 只修复已确认缺失的固定 Native 程序或 Profile 服务；已有损坏程序、未知目录、权限/配置/服务冲突均阻断，不覆盖、不删除用户数据 |
| 工作区门禁 | 实际 Boot ID、Agent ID、Profile、运行版本和管理连接；Cloud 在线、Agent 健康与管理连接分开呈现，真实状态与预览数据隔离 |

## 早期自动化验证结果

- Desktop 最终 pnpm check 通过：Wails bindings、ESLint、TypeScript、Vite 构建、Go test/race；前端 14 个测试文件、57 项通过。
- Desktop Go：go test -race ./internal/lifecycle ./internal/environment ./... 通过；Lifecycle stop-confirmation、PKCE restore expectedAgentId、progress marker 解析等专项用例通过。
- Cloud/Native Go：controlplane、desktopinstallhttp、bootstrap、database/migrations 相关测试通过；controlplane/bootstrap/migrations race 测试通过；对应 go vet 通过。
- Native Agent 6 个目标交叉编译通过：darwin arm64/amd64、windows arm64/amd64、linux arm64/amd64。
- Desktop Windows amd64/arm64 Go 交叉编译通过。
- Web：check:web-architecture 6 项通过；Web ESLint、TypeScript 通过；58 个测试文件、360 项 Vitest 通过。
- Unix 安装器 sh -n 通过；迁移 19 的发布清单 SHA-256 与嵌入迁移一致；主仓与 Agent 子仓 git diff --check 通过。
- 构建仍有 macOS 重复 -lobjc 及 deployment target 警告；不影响本轮测试退出码，但未做专项链接优化。

## 原真机验收清单（后续结果见下文）

- 配套新版 Cloud 部署到开发环境，验证真实 Browser Session、initialize/restore purpose、expectedAgentId 匹配/不匹配、PKCE、Token 轮换和旧 WSS 关闭。
- macOS Local：首次安装、运行中凭据恢复、服务缺失修复、程序缺失修复、启动、Agent 自升级和断线/未知结果恢复。
- Windows：PowerShell 安装器、Task Scheduler 身份/停止/启动、Named Pipe、ARM64/AMD64 原生执行。
- Linux SSH：systemd --user 精确服务定义、drop-in 冲突拒绝、stdin 凭据交付、断线与恢复。
- 当前 Yi Test Win / Yi Win 目标离线；Mac 无 PowerShell 解析器，因此 PowerShell 脚本尚未完成原生语法/行为验收。交叉编译不代表 Windows/Linux 安装器或服务真机通过。
- 若恢复请求没有可信 Agent ID，Web 会提示用户核对主机与平台；当前不从 Agent 私有 SQLite 或 Token 推导身份。未来若需要无人工核对恢复，可评估在 Desktop 环境元数据中持久化已验证 Agent ID，需单独设计迁移。
- Native Agent 制品继续沿用现有 Cloud Manifest + HTTPS + size/SHA-256/平台架构验证；本阶段没有引入 Ed25519 Native 发布签名门禁。Desktop 自身 updater 的信任策略保持独立。
- 不支持自动覆盖已有损坏程序、未知目录、权限/配置/服务冲突；这些场景安全阻断并要求检查。真实逐步骤事件是阶段标记，不代表字节级下载百分比。

## 早期交付边界（历史记录）

- 本轮保留主仓及 Agent 子仓的所有并行工作树修改，包括能力管理 UI；未提交、推送、发布或部署。
- 未重启现有 Agent，未执行真实初始化、凭据轮换或服务停止；没有操作生产 Cloud/Agent。
- 自动化门禁通过不等于完整 Phase 验收。必须先部署配套开发 Cloud/Native，再使用隔离 Profile 和真机完成上述验证。

## Mac 开发环境端到端验收（2026-11-27）

- 用户授权更新配套 Cloud/Native 到 Dev，并在本机验证 Desktop 浏览器授权、安装启动及真实清单。目标固定为 development、`~/.nexum-dev`、`https://nexum-dev.y2l.top`。
- OpenClaw 已部署 `1.1.2-next.20261127`。构建基线为主仓 `eef30791af5fc32512f94af9cc6cc982bd24b551`、Agent `4360274e572a80d430f70dd7cff00e3950eafad4`，叠加冻结的 Desktop 配套 Cloud/Native/Web 修改。源码归档 SHA-256 为 `deb6a3d88c147e5714b6425bf27ecfaba3b90af7f5655ad64daf7733d8a09304`，属于开发验证快照。
- Hosted tag 为 `1.1.2-next.20261127-deb6a3d8`。Hosted/Group 的 OCI index 一致，摘要为 `sha256:6af993a7faf05388f2753a8f62640a1ce4301e7a08bbe86e40f9c719bbc099ac`；Dev 运行 Linux/amd64 平台摘要为 `sha256:9e67e22ec3cb54654d05a35ae929d32e487b44851f1166c7eb8c69681065c20c`。镜像包含六平台 Native、Node 运行时及 Node Host。
- Dev schema 18→19 的只读预检、在线备份、临时数据库恢复及迁移演练、停服后备份、正式 Dev 迁移与运行角色权限检查通过。Server 容器 healthy，公开 `/healthz` 返回 ok，公开 Native Manifest 返回新版本及六项制品。首次使用的 `1.1.2-next.20261127.1` 不符合 Cloud 的 next.N 通道规则，曾造成 Dev 启动失败；修正版本后已向前恢复到上述健康镜像，未降低校验要求。
- Mac 原有开发服务停止后，整个 Profile 及 launchd 定义保存在 `~/.nexum-dev-backups/desktop-validation-20261127-204405/`。真实 Desktop 从无安装状态进入浏览器，批准复用已有 Test Mac，完成 PKCE loopback 和一次性兑换；Cloud 记录为 consumed/initialize/existing。旧开发凭据的只读验证返回 401，新凭据留在 Native 安装路径。
- Desktop 实际下载安装、核对大小与 SHA-256、创建 development 配置、注册 launchd 并启动 Agent；受管 Node 24.22.1 和 Node Host 就绪。Native inspect 确认 Agent ID `agt_Otz7FfyMST9E1gL6wKxKrj48`、版本 `1.1.2-next.20261127`、service=running、cloudOnline=true、executionReady=true；管理 Boot ID 为 `boot_5832c34f8a2ddacbe1da9860b257739e`。已安装 Mac Native 的大小和 SHA-256 与 Dev Manifest 一致。
- 已实际查看原生窗口中的运行正常、管理已连接、Cloud 在线及真实空清单。用受管 Node/pnpm 在开发 Profile 安装固定 `zod@4.6.7`，真实 Node 导入通过，Native capabilities 返回 available 且包含 npm/zod，原生 Desktop 列表同步出现该条目。包作为本轮验收数据保留在开发 Profile。
- 真机发现持续观察将 Cloud 已验证的显示名覆盖为 Agent ID。Desktop lifecycle 保留同一 Agent 的已验证名称，新增现有启动测试中的观察回归，修改前复现失败，修改后通过。最终 Desktop pnpm check、61 项前端测试、三组 Go 标签测试、lifecycle race 和 build:dev 通过；重启 Desktop 后仍显示 Test Mac 及真实 zod 清单，Agent Boot ID 保持不变。
- Cloud/Native 相关 Go 包测试通过；显式 Node 24 的 ProductionCloudRun/ConsoleInspection race 专项通过。构建保留 Vite chunk 超阈值、macOS 重复 -lobjc 及构建包装 Dockerfile 的默认 ARG 警告。
- OpenClaw 构建、Registry、备份及部署证据保存在 `/data/apps/NexumDev/artifacts/Nexum-dev-desktop-1.1.2-next.20261127/`，初次失败版本证据另存于同级 `.1` 目录。Mac 生产配置和服务定义哈希保持一致。未操作生产 Cloud/Agent，未提交或推送代码，未发布 Desktop 正式版本。
- 本轮覆盖 macOS 本机成功主流程和真实 npm 清单。MCP/API 真机条目、Windows、Linux SSH、恢复、取消拒绝及异常分支继续按原验收要求执行。

## 启动、恢复与异常分支补充验收（2026-11-27）

- 目标始终为 development、`~/.nexum-dev` 和开发 Cloud。OpenClaw 构建并部署配套 Cloud/Native `1.1.2-next.2026112703`；基础提交仍为主仓 `eef30791af5fc32512f94af9cc6cc982bd24b551`、Agent `4360274e572a80d430f70dd7cff00e3950eafad4`，叠加冻结的开发改动。源码归档 SHA-256 为 `0830bb1f8aa47680e33802808a71788ee29dd2962e523fd4812db85783292af3`。
- Hosted Registry 标签为 `1.1.2-next.2026112703-0830bb1f`，Hosted/Group OCI index 校验一致，摘要 `sha256:0968f9ac3794ccd2962ccf2c4ab459da33ff33b50dbe9400b1727eeeb55fe422`；Dev 实际运行 Linux/amd64 平台摘要 `sha256:4418b582a7f21d303078b43430b6fcd050951914120496c2add156a56814ce90`。迁移目录无变化、schema 仍为 19；部署前备份和预检通过，Dev 服务健康。
- 本机 Development Agent 自动升级至上述 Native 版本。真实桌面窗口验证了服务停止后的启动、浏览器取消与拒绝授权、缺失凭据恢复已有 Test Mac 并轮换凭据、缺失 Native 程序的下载校验与补齐、缺失 launchd 服务的定向修复。恢复和修复后 Agent ID 不变、Cloud 在线、执行能力就绪，真实 npm `zod` 清单仍可读取。取消、拒绝、成功恢复的 Cloud 请求分别记录为 cancelled、denied、consumed；旧凭据返回 401。
- 修复了 launchd 用户域输出过长导致误判、macOS 停止服务参数不正确、缺失凭据时丢失可核实 Agent 身份、启动和服务修复初期服务状态未稳定导致误报、启动后丢失已验证显示名，以及授权取消/拒绝提示混淆。服务注册后由 launchd 的 RunAtLoad 启动，不重复 kickstart。
- SSH 表单的必填项、端口、私钥校验及连接失败恢复已实测。本机回环 SSH 展示的主机指纹与系统公钥一致，使用已有密钥连接后，可通过 SSH 读取同一 Development Agent 的真实 `zod` 清单。连接被拒绝与真正超时的提示已区分，未保存凭据时失败页只提供返回配置。
- 局域网目标在终端可连接，但验收用 macOS 应用连接时报 `no route to host`。这与本地网络隐私限制的表现一致，尚未确认具体系统授权状态；Desktop 打包配置已补充 `NSLocalNetworkUsageDescription`，仍须在获得适用的系统授权后用真实局域网主机复验，不能将回环连接当作 Linux 远程验收。
- 本轮构建中 OpenClaw Docker 文件系统曾写满并使 Dev PostgreSQL 暂时不可用；按用户要求清理 Docker 构建缓存后，数据库自行恢复、Dev 健康，未清理数据卷。Windows 开发设备在最近一次 Dev 部署前已离线，Windows 原生启动、Task Scheduler 和其异常分支仍未完成；Linux 真实 SSH 与非本机 OS 页面仍未完成。Desktop 工作区的能力详情、资料、项目、活动及维护功能不属于本轮启动链路的完整验收。
- 真机使用单独的数据目录和测试 App；开发 Profile 中保留用于验收的 `zod`。未修改生产 Cloud 或生产 Agent，未提交或推送代码，也未发布正式 Desktop。

## 开发镜像更新及复验（2026-11-27）

- 并行开发工作先将 Dev 更新至 `1.1.3-next.20261127`。随后以该版本的实际源码归档为基底，仅叠加 Node 探测超时修复和版本号，构建并部署 `1.1.3-next.2026112701`，未覆盖其余并行改动。基础提交为 `fc13da744d7f353cd281824eaf4945ecdf277db6`，冻结源码归档 SHA-256 为 `59ff21c8b99e0d4727366b5081c69c5d8dcdee6ac53498a070a513b858b4b2bb`。
- Hosted 标签为 `1.1.3-next.2026112701-59ff21c8`，Hosted/Group OCI index 摘要均为 `sha256:aa6f7d15e2c60e7e97e8c3b0fde25fc60970795c8c8d348d96c1f66fabf34109`；Dev 部署 Linux/amd64 平台摘要为 `sha256:a66776790765707ce0823da5a290ba17d3e1d5938af8e73dc9c1c1e9651cf78f`。部署前已备份开发数据库并通过迁移预检，schema 保持 19，Cloud 健康。
- 修复受管 Node/npm 版本探测因取消或超时未完成时被当作运行时损坏、触发替换的问题；这种情况现在返回未确认状态供重试。新增 Node 和 npm 探测超时回归，验证不会下载或移除现有运行时。该修复针对已确认的代码缺陷，未将此前本机某次准备缓慢的原因断言为相同问题。
- Desktop 最终 `pnpm check` 通过，包含 17 个前端测试文件、72 项测试、ESLint、类型检查和三组 Go 标签测试；Native `go test -race ./internal/nativeagent -count=1` 通过。新镜像部署后，本机 development Agent 实际运行目标版本、Cloud 在线、`executionReady=true`，管理接口再次读取到真实 npm `zod` 条目；Linux 开发 Agent 重新上线，其 Node Host 报告就绪，实际只读 Run 返回预期结果。一次验收脚本因误用沙箱未提供的 `process` 全局变量失败，改用受支持的纯 JavaScript 后通过；这不等于 Linux Desktop 安装及 SSH 验收通过。
- Windows 开发设备仍离线；本机真实局域网 SSH 和对应 Linux 远程验收仍未完成。未提交或推送代码，没有发布正式 Desktop 或变更生产环境。

## 工作区与 Cloud 通信边界（2026-11-28）

- 工作区移除项目与权限入口，能力管理和 AI 资料并排，运行活动与维护入口各占一行。项目及访问授权由 Cloud 控制台管理。
- 安装预检与缺失程序修复通过已选 Local/SSH 目标下载清单、安装脚本和制品。Desktop 自身仅在一次性浏览器授权的 start、exchange、cancel 阶段直接请求 Cloud。程序修复在目标校验大小和 SHA-256，未知结果先复检。
- Desktop `pnpm check` 和临时副本的 `pnpm build:dev` 通过。隔离的 macOS 原生窗口检查了中文深色、英文浅色、四个入口和返回焦点，并在 development Agent 上只读查看真实能力、资料、活动与维护。测试替身覆盖 Cloud 离线时能力读取、目标下载失败、超限、重定向、连接中断及摘要不匹配。
- 本机回环 SSH 使用实际目标执行层、受信任主机公钥和隔离 HTTP 服务完成安装预检及修复制品的下载校验。此结果不代表真实远程主机验收。Windows 下载器已交叉编译，尚未在 Windows 真机执行。未对运行中的 Agent 执行重新授权、安装或修复。

## Linux SSH 目标下载补充验收（2026-11-28）

- 通过已核实主机公钥的实际 Linux/amd64 SSH 连接，使用 Desktop 目标执行层从 development Cloud 下载清单、安装脚本和 Native 制品到目标私有暂存目录，完成脚本协议、平台、制品大小与 SHA-256 校验；测试结束后清理本次暂存文件。实际版本为 `1.1.3-next.2026112702`。
- 该测试仅覆盖远程预检与制品校验，没有创建远端 Agent、执行安装/恢复/修复或逐进程记录完整通信；不能作为完整 SSH 生命周期或通信边界真机验收。当前可连接目标为共享主机的 root 用户，完整安装会新增高权限 Agent，尚未执行。Windows 真机仍不可用。

## 生命周期与启动体验优化验收（2026-11-28）

- 统一页面与预览：删除旧 EnvironmentCheckView、AgentInitializationView、AgentUpgradeView、AgentRepairView、AgentStartPreview 及被取代的独立状态模型；保留统一真实渲染器、兼容的开发预览启动参数和现有 Bootstrap/SSH/工作区边界。阶段历史仅记录实际观察，不将下载 100% 视为 SHA-256 验证或安装成功。
- Native 保持旧只读 JSON 契约，inspect/observe 显式选择 runtime-progress；按当前 Profile、Cloud origin、Boot ID、Agent ID 绑定观察；旧版拒绝新增参数时回退只读查询。下载进度源自实际写入字节，失败、未知长度、取消、重试和实例更换不得伪造完成。Agent 自主管理 Node Runtime、Node Host 和自动升级。
- Review 修复目标 curl 输出缓冲导致中间进度缺失、下载进程取消清理、阶段历史与过期进度、升级有界观察及升级期间已核实身份保持。相关下载、首装、旧协议兼容、Runtime 等待与降级、页面及路由回归通过。
- 主仓本地 HEAD 为 1400feae，Agent 子仓 HEAD 为 4360274，均叠加未提交工作树；不将其视为发布版本。最终 Desktop pnpm check（Run run_8b738985cec992635aae98539206843f，退出码 0）：Wails Bindings、ESLint、TypeScript、18 个前端文件 84 项测试、Vite build、go mod tidy -diff、go vet、三组 Go 标签测试通过；同次运行 go test -race ./internal/lifecycle ./internal/environment -count=1 通过。旧预览专用测试由统一渲染器与入口回归覆盖替代。
- Native 本轮最终 go test ./internal/nativeagent ./internal/agentlaunch ./internal/agentapp ./internal/agentbootstrap ./cmd/nexum-agent -count=1、sh -n internal/agentbootstrap/install.sh 与主仓 git diff --check 通过（Run run_59a8cebf273e32d287cacf6bca26b438）。新增 desktop_runtime_progress_test.go 的 HTTP 流实际字节、取消、摘要不一致、未知总量及管理协议兼容专项通过（Run run_6298bc13a543a194199bc189b81ece6f）。首装测试使用临时 HOME 和模拟系统服务，不影响现有 Agent；慢速下载测试使用本机临时 HTTP 服务。
- macOS ARM64 候选：基于通过门禁的前端 dist 及当前 Go 源码，按 production,desktopdev 标签构建独立的 0.1.0-dev 本地候选包，ad-hoc codesign --verify --deep --strict 与 Info.plist 校验通过；未替换运行中的客户端。原生 WebView 使用单独 App ID、临时数据库与编译 overlay（仅隔离身份、存储及验收钩子），运行实际 UI，验证真实 development Agent 工作区（1.1.4-next.2026112802，Node 执行就绪）、唯一预览入口、环境检查不确定进度、示例下载 6.0 MiB / 10.0 MiB（60%）、字标位置稳定、400×680 窗口、详情展开及当前步骤、Node 下载/失败与退出预览。结果 ok=true，五项验收记录；隔离进程已退出。候选及本机验收证据位于 Desktop 忽略目录 bin/.lifecycle-acceptance-9puf5D/，result.json 为本机临时验收记录；不提交生成制品或临时数据。
- 原生窗口中的下载及失败展示使用明确标记的 UI 预览数据，不能据此认定新版 Native 已经在真实 Dev Agent 提供新进度。真实 Dev Agent 当前仍为旧部署，旧版兼容路径已验证；新版 Windows PowerShell、独立远程 SSH 首装/修复、自升级及 Node 准备的实际执行仍待配套开发部署和真机验收。Windows 设备离线，现有共享 Linux root 目标不用于新建 Agent。本轮未停止、重启或修改现有 Agent，未提交混合工作树、推送、部署或发行。Vite chunk size 和 macOS 重复 -lobjc 警告仍存在，不影响通过的门禁和候选构建。
- 补充 Native runtime-progress 专项 Race、Native Windows/Linux amd64/arm64 四目标交叉编译、Desktop Windows amd64/arm64 两目标交叉编译均退出 0（Run run_259aca69b57c052700816c6163a7b2be；cross-verification.json）。交叉编译不代表 PowerShell、Named Pipe、Task Scheduler 或远程 SSH 真机验收；临时交叉编译制品已清理。
