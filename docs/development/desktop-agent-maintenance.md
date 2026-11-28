# Desktop Agent 设置与维护

设计来源：[Agent 设置与维护](../desktop/design.md#agent-设置与维护)。

状态：开发及验收进行中；不得将隔离测试或构建结果当作五项操作的真机验收。

## 实现范围

- 工作区采用两行两列入口，左下为 Agent 设置与维护、右下为运行活动；底部提供紧凑的重启、停止、重新安装、重置连接和卸载操作。确认框展示设备、Profile 与影响，不使用分割线。
- Desktop 负责操作状态、目标与修订绑定、授权、制品校验、结果复查和界面。Native/Agent 只提供受限状态、同用户管理接口、任务准入保护和固定服务／程序操作；维护、启动和自动升级使用同 Profile 安装锁。
- 维护页显示真实身份、服务和连接状态及 Node Host 的 CPU/RSS 采样；Agent 系统事件只暴露限定类别、组件和时间，最多 20 条，支持复制诊断摘要。
- 重新安装由目标助手在固定私有暂存槽重新准备 Native 对应的官方 Node/npm、pnpm 和 Node Host，再安全停机、替换并验证实际启动；重置连接先等待浏览器批准，确认停机后兑换，凭据经标准输入交付；卸载保留配置、数据和 Cloud 登记，恢复使用原 Agent 身份。Cloud 离线时禁止会依赖在线验证才能完成的重启。

## 已验证

- 主仓 `go test ./...` 通过；Desktop 使用 Node 24.22.1 和 pnpm 10.34.5 的 `pnpm check` 通过，包含 ESLint、类型、88 项前端测试、Vite 构建、Go vet 和三组构建标签测试。后续变更继续按最终源码复验。
- 生命周期与 Native race 专项覆盖旧修订或身份拒绝、目标观察代次、Agent 忙碌、未知结果不重放、重置前停机与凭据交换顺序、日志投影脱敏和恢复记录归属。
- 使用本地可控授权服务与回调，验证重置授权的拒绝、取消、过期，以及批准后 Boot ID 改变或管理断开，均不执行停机或兑换；这是自动化模拟，不替代真实浏览器授权验收。
- 在隔离标识与数据目录的 macOS development Wails 窗口，检查四宫格、紧凑操作、中文深色和英文浅色布局、实际设备及 Node Host 采样、系统事件和诊断摘要复制。旧 Agent 不支持维护协议时，操作显示不可用。确认弹窗另以无副作用预览替身检查。
- Mac development Agent 在 `1.1.3-next.2026112803` 上已通过客户端实际执行重启、停止并再次启动；重启后核对 Agent ID 不变、Boot ID 更新，停止后核对服务停止且管理连接消失，启动后核对 Cloud 和执行引擎恢复。重启中发现的显示名退回 ID 问题已修复并补充回归测试。
- 在同一版本上由客户端实际发起重新安装后，通过 Native 独立回读同一 Agent 身份、新 Boot ID、运行中的服务和版本；安装程序 SHA-256 与 Dev Manifest 一致。Mac 锁屏发生在当时的结果界面复核之前。随后在 `1.1.3-next.2026112805` 通过客户端再次重新安装，界面返回同一 Agent 且 Cloud 和执行引擎恢复；独立回读新 Boot ID、Manifest 摘要及原有测试 Run。
- 在 `1.1.3-next.2026112804` 上，通过真实浏览器批准重置连接，客户端回到工作区；独立回读原 Agent ID 不变、Boot ID 更新、凭据有效，Cloud 和执行引擎恢复。随后通过客户端卸载，核对固定程序与 launchd 注册均已移除、配置与数据仍在，Cloud 保留原 Agent 登记；从“恢复安装”返回原 Agent，核对新 Boot ID、有效凭据、在线状态和程序 Manifest 摘要，之前已取消的测试 Run 仍可按原 ID 读回。
- 对 Mac development Agent 使用错误 Boot ID 请求停止，命令被拒绝，回读服务及原 Boot ID 不变。用受控 Run 占用 Agent 时发起维护停止，Native 返回 `busy`，服务与 Boot ID 不变；随后取消该 Run 并核对已取消、清理无未确认项。
- 重新安装后观察到一次 Cloud 连接中断：Cloud 列表先显示离线，本机稍后才记录 Cloud 离线；连接随后自动恢复，Cloud 列表与本机再次显示在线。该次记录不证明所有断线场景的状态同步延迟均已消除。
- 排查确认本地依赖 Agent WebSocket 的断线检测，半开连接在对端已经移除时仍可能暂时被显示为在线。修复让 Desktop 轮询 Cloud 对同一 Boot 的只读登记事实，不更改 Agent 心跳或任务准入；半开连接的可控模拟在约 5 秒内显示离线，旧 Native 的真实客户端显示未知并禁用依赖 Cloud 的重启。新配套版本在 Dev 上实际确认当前 Boot 在线、其他 Boot 不在线，客户端也显示 Cloud 在线；尚未以真实网络半开故障测量端到端时延。
- Cloud 状态修复后重新通过主仓 `go test ./...`、Desktop `pnpm check` 与状态和目标切换的 race 测试；Native 的 opt-in 只读测试在实际 Dev Cloud 核对当前 Boot 与不同 Boot，Windows amd64/arm64 Desktop 交叉构建通过。实际窗口为隔离验收 App，不代表已发布或更新主 Desktop 安装。
- 在授权 Linux 主机，通过 Desktop 的真实 SSH Runtime 和已核对主机密钥，以非特权用户运行 Native 隔离测试，覆盖日志、旧 Boot、停机准入、卸载身份记录和 systemd 服务定义解析。未对远端真实 Agent 或其 systemd 服务执行维护。
- Native 和 Desktop 已交叉编译 Windows amd64/arm64；Windows 服务适配器的脚本契约检查覆盖身份和归属校验在启动、停止、卸载前执行，以及卸载时重启任务查询失败必须拒绝。检查不执行 PowerShell 或 Task Scheduler，Windows 真实设备尚未验收。

## 配套构建与待办

- Dev 配套 `1.1.3-next.2026112803` 已由 OpenClaw 从冻结源码构建，保留当前 Mac development Agent 已运行的资料和能力状态接口，未带入并行开发中的新审批功能。基底为主仓 `fc13da744d7f353cd281824eaf4945ecdf277db6` 对应的已部署 `1.1.3-next.2026112702` 快照；本次源码归档 SHA-256 为 `5d2ad890a7314070da09e33d703940080dd055a861d1b66f03cb1ceb50b5e60c`，归档及 51 项叠加文件摘要记录在 OpenClaw 的本次 artifacts 目录。
- Hosted 标签为 `1.1.3-next.2026112803-5d2ad890`；Hosted 和 Group Registry 的 OCI index 摘要均为 `sha256:8328b5cab93a75d734fe384938bb112c5d19338d223a9dee1a983ad165ad68d3`，Dev Linux/amd64 部署摘要为 `sha256:cf7ace3beb8829b7eb5752934dabeb6018e97730460cd4a048b8d0df6f8d2ffe`。部署前核对 compose 和迁移一致，备份 Dev 数据库并通过 schema 19→19 预检；Server 已 healthy，公开健康检查与 Native Manifest 版本通过。Mac development Agent 已自动升级至该版本，实际维护验收尚在继续。
- 发现并修复 Windows 卸载时对一次性重启任务的查询可能静默忽略错误；修复后的 `1.1.3-next.2026112804` 源码已冻结，归档 SHA-256 为 `4d503dc4a997d2633b2bfe137a4df259e8dea5da114f5ec199fac270eef04be6`。OpenClaw 已构建并推送标签 `1.1.3-next.2026112804-4d503dc4`；Hosted 与 Group Registry 的 OCI index 摘要均为 `sha256:ac806aa3fa503570ea0386483cc71eb5186062339ee7a29b720826e68302b291`，Dev Linux/amd64 部署摘要为 `sha256:6eb2716c5a90ac47ade53e1f962d97422c18d48d1d0f1828f88ec26f48cb216e`。
- `1.1.3-next.2026112804` 已部署到 Dev：部署前备份数据库并通过 schema 19→19 预检；Server healthy，公开健康检查和六平台 Manifest 通过。Mac development Agent 已自动升级，同一 Agent 在 Cloud 显示在线、执行引擎就绪，本机程序摘要与 Dev Manifest 一致。生产环境未操作。
- Cloud 状态修复的 `1.1.3-next.2026112805` 基于上一个已部署 Dev 快照及受限状态补丁构建，冻结源码归档 SHA-256 为 `eb57341f5267b0a8d8f74443d171a290b84696043a0f18654aab7fe6a578f02c`；Hosted 和 Group Registry 的 OCI index 摘要均为 `sha256:9c7f31ff55f7f0fa010966c7b7685853404d582bf537ad15ec43f76a0c04c280`，Dev Linux/amd64 部署摘要为 `sha256:85012f07846eb5f1f182f8d96d51cc84e13d662f510c7687524cfbcb47ed8f08`。Dev 已部署并通过备份、schema 19→19 预检、健康检查及六平台 Manifest；Mac development Agent 已自动升级并核对同一身份。
- 随后并行开发将 Dev 更新至 `1.1.4-next.2026112802`，覆盖了上述正在运行的 Dev 版本。Mac development Agent 自动升级后回读同一身份、服务运行、Cloud 在线和执行引擎就绪；该版本的受限 Cloud 状态查询仍返回同一 Boot 在线。本轮五项操作的真实验收发生在前述 2803–2805 版本，不推断新版本已重复通过全部操作。
- 构建后发现 OpenClaw 实际 Docker 存储挂载 `/docker` 空间耗尽，Dev PostgreSQL 短时处于恢复状态；构建前误检查了另一个挂载点。按已授权的缓存清理范围移除一小时前未使用的 BuildKit 缓存，未清理数据卷或运行中的容器；缓存回收完成后 `/docker` 可用约 57 GiB，Dev 数据库和 Server 恢复 healthy，schema 仍为 19。后续构建前须核对 Docker 实际根目录所在挂载的空间。
- 仍需补充尚未实测的浏览器拒绝、取消、过期和中断异常；本轮准备补测时未能读取验收窗口，浏览器只读到了授权回执，且 development 配置文件摘要与补测前不同，无法确定变更原因或证明该次取消／拒绝保留凭据。之后 Dev 又发生并行升级；当前配置与凭据有效，但不将该次异常尝试记为通过。真实网络半开时延、Linux 真实 systemd 生命周期和 Windows 真机另行记录。禁止操作 production。
- 本轮与其他会话共用工作区，提交、推送、最终镜像和 Dev 部署分别以实际执行结果更新，不将其他会话的未提交改动整体提交。

## 完整官方运行环境重装优化（2026-11-28）

- 本次将用户明确确认的重装范围从 Native-only 扩展到完整官方运行环境。新客户端携带 --full-runtime；兼容旧客户端原重装契约，拒绝新客户端静默降级为旧助手。Node 和 Host 复用原有发布清单、大小、固定哈希、平台及解包验证；pnpm 复用固定版本无安装脚本的官方准备流程。
- 独占暂存槽 state/desktop-runtime-reinstall 先准备全新 runtime 与 Cloud 指定版本 Host；持有安装锁前只写暂存资源，取得锁后再检查发布、凭据、目标及原实例。停机后仅替换 runtime 和指定 node-host 版本，保留其他 Host 版本、扩展、凭据及用户资料；验证移动后的 Node、npm、pnpm、Host，Native 替换继续校验 SHA-256、版本及平台。
- 已确认无法继续的准备失败清理当前暂存槽，不发出停机请求；移位失败恢复经身份核实的旧树，无法确认替换/回滚则保留唯一恢复槽，不覆盖、不自动重放。启动受理后不自动回滚，避免旧程序访问可能已迁移的数据库。
- 降级停止只对已经完成 Host 尝试和清理、没有活动 Run 与维护的实例开放；暂停下一 Host 尝试，确认旧实例正常退出。未确认进程收尾继续拒绝停机；npm 包变更仍走原健康执行环境准入。
- Desktop 使用同一生命周期页展示重装准备、Node/Host 实际阶段、下载字节、停止与替换；清理过期进度，区分准备失败及留存恢复槽。开发验收结果单独补充，不把此处设计或代码写入等同部署。

### 本地验证结果（2026-11-28）

- Native：nativeagent、agentapp、agentlaunch、agentlayout、cmd/nexum-agent 五组测试通过；完整运行环境重装、已静止降级 Host 停机及原停机准入专项 Race 测试通过。
- Desktop：pnpm check 完整门禁通过（18 个前端测试文件、85 项测试），三组 Go 构建标签测试及重装/生命周期/进度专项 Race 测试通过。
- 隔离测试覆盖重新下载并重建官方 Node/npm、固定 pnpm 和指定版本 Node Host、同版本 Host 损坏、准备失败、回滚、非安全目录拒绝、保留恢复暂存槽、保留用户包/配置/历史/脚本、未完成任务或维护时拒绝停机，以及不降级执行旧版 Native-only 重装。
- 编译：Native Windows/Linux amd64/arm64、Desktop Windows amd64/arm64 及 macOS arm64 均通过。macOS 链接存在 SDK 26.0 与最低目标 11.0 版本警告；Vite 存在 chunk 大小警告，不能据此认定旧 macOS 版本真机兼容。主仓与 Agent 子仓 git diff --check、19 项本次涉及文件的空白检查均通过。
- 本轮未执行真实 Agent 重装或重启、未部署新版 Native/Cloud、未在 Windows/远程 SSH 上完成全流程实机验收；旧版助手不支持完整运行环境重装时不会自动回退为仅替换 Native，需部署匹配版本后验收。暂存或恢复结果不明确时保留固定恢复槽，要求先诊断再继续，避免覆盖。混合工作区的其他修改保留，本轮未提交或推送。
