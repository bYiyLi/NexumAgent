# Desktop 能力管理

状态：能力状态与维护源码已接入，隔离环境联合验收通过（2026-11-28）；新版 Desktop、Native 和 Cloud 尚未在实际开发环境配套部署及验收。此前 macOS ARM64 本机已通过配套 Dev Cloud/Native 的真实 npm 清单验收；最新部署与授权安装结果见 [生命周期端到端记录](desktop-agent-lifecycle.md#mac-开发环境端到端验收2026-11-27)。

设计来源：[Desktop 能力管理清单](../desktop/design.md#能力管理清单)、[能力状态与提示](../desktop/design.md#能力状态与提示)和[能力详情与操作](../desktop/design.md#能力详情与操作)。单连接 MCP 重连及 Desktop 用户发起的 Web 维护审批已在隔离环境接通；真实 Dev 环境和要求的全部验收条件尚未完成，不将本项标为完整交付。

## 实施与验收

| 项目 | 交付与验收要求 |
| --- | --- |
| 统一清单 UI | 保留已确认的扁平列表、返回、类型标签及深浅主题/双语；“＋”直接打开当前 Profile 的 Web 市场，不显示分类菜单 |
| Agent 数据来源 | 当前已发布且批准修订有效的 MCP/API；直接依赖声明与实际安装元数据校验后的 npm；不包含 Skills/Scripts/Instructions、市场或残留包 |
| 只读管理链路 | App → Native 同用户 IPC → 固定 CLI → Local/SSH Runtime → Wails → 真实工作区；Desktop 不读写 Agent 私有数据，不增加 Cloud 转发 |
| 身份与失败 | 绑定目标、operation、Profile、origin、Agent ID、Boot ID，读取前后复核；空/partial/加载/不可用分开，旧响应丢弃，失败不保留旧清单 |
| 自动化 | Desktop pnpm check、Node Host pnpm check、相关 Go 包、竞争检测，以及显式真实 Node/loopback Cloud 与 OS IPC 专项 |
| 实际环境 | 新版开发 Native 与真实开发 Cloud 配套后，完成 Local/SSH、权限不足、断线及异常验收；不能用示例或自动化替身代替实际环境验收 |

## 本轮证据与限制

- 此前已实际查看 Mac ARM64 `Nexum Desktop Dev` 的暗色中文及浅色英文能力列表，并验证当时的添加菜单；2026-11-27 后续产品决定改为“＋”直接打开 Web 市场。预览数据不能证明真实清单。
- 新增只读 Native capabilities 查询、最小资源投影、生命周期会话准入与 Wails 接线、前端严格解析及串行刷新。复用原有 AgentWorkspaceView 的 Props，不改动其工作区/生命周期 UI。
- 最终 Desktop pnpm check 通过（15 个文件、61 项 Vitest，Wails bindings、ESLint、TypeScript、Vite、Go module/vet 及三组 Go 标签测试）。Node Host pnpm check 通过：694 项中 666 通过、28 跳过、0 失败；Native/Agent 的 nativeagent、agentprotocol、agentapp、agentmaintenance、agentwork、cmd/nexum-agent 六个 Go 包通过。
- 显式使用 Node 24.22.1 与实际构建入口 `agent/dist/host/main.js`，`TestRealNodeProductionCloudRun` 和 `TestRealNodeConsoleInspection` 通过。核对 Desktop 与权威 Console 的 npm 清单、Node 未就绪时 partial、MCP/API 发布后出现及移除后消失。真实 OS IPC 专项覆盖错误 Profile/origin/Agent/Boot 在读取前拒绝、读取中换 Boot、缺少 provider、非法资源、重复 ID 与 200 项大于旧 8KiB 限制的有界清单。loopback Cloud 是隔离测试服务，不是实际开发 Cloud。
- Native Desktop IPC、Desktop lifecycle、显式真实 Node ProductionCloudRun 的 `go test -race` 通过。Native Windows amd64、Linux arm64 交叉构建通过；这不代表对应系统原生运行或 SSH 真机通过。
- Node 24.22.1、pnpm 10.34.5、Go 1.26.6 下 `pnpm build:dev` 通过，开发候选已重建并以 `--preview-agent-workspace` 启动，当前预览 PID 28133。Vite 主包 581.74 kB 和 macOS 重复 `-lobjc` 为非阻塞警告；候选构建不等于正式签名发行。
- 当前已安装开发 Native 未包含 Desktop CLI 标记，开发 Profile 的管理端点不存在；未替换、启动或重启该 Agent。实际已连接 Local/SSH 清单尚未验收。正式客户端、生产 Agent、Cloud 服务未操作。
- MCP/API/npm 详情和新增流程继续保持未接入，后续设计必须使用对话中的可交互高保真 UI；本轮没有新增界面设计，也不以静态图代替原型。
- 两个仓库原有大量并行未提交修改，Desktop 仍为未跟踪目录；以修改前副本和任务文件核对本轮差异，不整体清理、暂存或提交。
- 生命周期负责人的会话仍在响应，协调消息因工具返回“already responding”未投递。既有 `desktop/internal/lifecycle/controller.go`、启动/安装/恢复实现及 AgentWorkspaceView/agent-workspace.ts 未改；共享接点限于只读管理协议、Native 启动入口、运行时 provider 和主应用 Props 接线。

## Web 市场入口（2026-11-27）

- 按用户确认，移除能力清单添加菜单；“＋”直接调用 Native 固定目的地并经系统浏览器打开对应 Profile 市场。开发预览也能打开开发市场；不传递 Agent ID 或凭据，不声称市场安装流程已经接入。
- Desktop `pnpm check` 通过：15 个前端测试文件、61 项测试，以及 Wails bindings、ESLint、TypeScript、Vite 和三组构建标签下的 Go 检查。Go 测试覆盖 development 与 production 市场地址、启动就绪门禁和浏览器错误传递。
- 在隔离的 macOS 原生测试应用中，实际点击能力列表“＋”，验证无分类菜单、Wails 调用到达 Go 且目标为开发市场；以浏览器调用替身模拟失败时，界面显示现有链接错误提示。该隔离测试未实际通过系统浏览器访问市场，也未操作共享的 Desktop Dev 进程。
- 随后按用户要求以 `pnpm build:dev` 重建并启动 Desktop Dev 的工作区预览，实际点击能力列表“＋”；Chrome 新标签打开 `https://nexum-dev.y2l.top/marketplace`，市场页面及能力列表正常加载，未弹出分类菜单。Desktop 的预览清单是示例，此次未验证市场安装到目标 Agent 的闭环。

## Mac 真实能力清单验收（2026-11-27）

- 已通过真实 Desktop、开发 Cloud 授权及 Native 安装主流程。首次打开得到真实空清单；在开发 Profile 实际安装 `zod@4.6.7` 后，Native capabilities 返回 available 和 npm/zod，Desktop 原生列表出现同一条目。
- Native 查询绑定实际 Agent ID 与 Boot ID，已安装程序与 Dev Manifest 大小及 SHA-256 一致。真实 Node 导入 zod 通过；重启 Desktop 后列表仍能从同一运行中的 Agent 读取。
- Desktop 名称观察回归修复、最终检查及交付边界由上述生命周期记录拥有。本次没有执行 MCP/API 注册、市场安装或详情维护业务。

## 能力详情与操作接线（2026-11-27，未完成）

- 增加固定 `desktop capability-detail` 只读查询，按能力 ID、目标会话、Profile、origin、Agent ID 与 Boot ID 校验，读取后复查来源批准修订及当前发布快照。MCP/API 的工具与接口来自已批准发布目录；npm 仅读取实际安装的直接依赖，SDK 方法仅在可核实的已发布扩展中展示。方法信息不完整时明确标记。
- 配置以可视化及 JSON 摘要显示。只投影明确允许的字段，隐藏敏感值及未知字段，URL 不显示路径、查询参数或用户凭据；这不是未经处理的完整原始文件。详情刷新失败清除旧结果，身份变化丢弃迟到响应。开发预览和真实读取相互隔离。
- 列表悬停/键盘焦点和详情顶部展示操作位置。2026-11-27 当时，现有 MCP `Activate` 在连接仍存活时只是刷新目录，不等于重连或重启；维护申请仅有 Host 授权及 Run 路径，Desktop 尚无创建入口，因此当时两项操作均禁用。后续实现及验收见下节。
- 自动化覆盖身份不匹配、读取期间 Boot 变化、敏感配置及 schema 默认值脱敏、安装版本变化、目标离开与前端回归。使用隔离 loopback Cloud、真实 Node Host 和受控 MCP/API 服务验证批准资源的详情投影；这不是本机开发 Cloud/Agent 的实际环境验收。
- Desktop `pnpm check` 通过，覆盖 Wails bindings、前端检查和三组 Go 标签测试；随后按最终界面调整再次通过 ESLint、TypeScript/Vite 构建和 19 个文件共 77 项前端测试。主仓相关 Go 包及详情并发竞态检查通过。Vite 包体超过 500 KB 与 macOS 重复 `-lobjc` 仍是非阻塞构建警告。
- 在隔离浏览器预览中按 400 × 680 检查浅色/深色、列表返回、焦点下的操作位置、JSON 切换和工具参数展开；预览数据仅用于页面检查。尚未替换或启动新版开发 Native/Desktop，Local/SSH、权限不足、断线和真实维护授权流程仍需验收。

- 开发 Cloud/Native 升级至 `1.1.3-next.2026112702` 后，独立的 Mac 原生验收 App 已实读 Test Mac 上 `zod` 的详情、依赖声明和实际安装版本 `4.6.7`。MCP/API 在隔离环境验证，实际 Dev MCP/API 条目、Windows/SSH 和维护写操作仍待验收。镜像及配套窗口证据见 [管理工作区验收](desktop-foundation.md#agent-管理工作区真实验收2026-11-27)。

## 能力状态与维护（2026-11-28，未完成）

- Desktop Go 串行调度状态读取、合并按需清单、比较版本和维护 24 小时缓存；窗口隐藏、退出或切换目标时取消旧查询。详情打开前取消 Registry 查询，详情期间只使用缓存。Agent 仅投影现有运行事实；MCP 的显式重连检查指定连接的调用、任务和订阅，成功以新握手和发布为准。
- 实现已确认故障及配置待批准的条目、角标和详情提示；API 缺少连接证据时显示未验证。已声明但缺失或无效的 npm 依赖显示异常，不称为已安装。公开 npm 检查要求可证明的公开来源及现有发布通道；当前维护流程会固定版本，历史记录通常不能证明原通道，故这些包保留未知状态而不查询 Registry。
- 最终 Desktop `pnpm check` 通过，包含 Wails bindings、ESLint、TypeScript、20 个前端测试文件共 88 项、Vite、Go vet 和三组构建标签测试；巡检计时、详情期间 Registry 禁止访问及缓存逻辑的 Go 竞态专项通过。Vite 主包超过 500 KB、macOS 链接器重复 `-lobjc` 为非阻塞警告。
- 2026-11-28 在隔离 macOS 原生预览中使用独立单实例标识及临时配置，检查中文/英文、深色/浅色的能力列表与详情，以及返回、悬停/键盘聚焦、JSON 切换和工具参数展开。修复英文详情顶部操作溢出、英文预览描述未翻译，以及 npm 有更新时类型标签与快捷操作重叠；修复后重新构建并在原生窗口复验。隔离源码快照的前端 TypeScript、ESLint、20 个文件共 88 项 Vitest 和 Vite 构建通过。
- 另以仅存在于临时预览的样本观察无提示、建议、异常和混合场景：角标及混合清单的提示和观察时间显示符合预期，快捷操作回调为测试替身，未操作真实能力。示例预览不等于实际 Dev Agent 或原生窗口中的真实 Web 审批验收。Windows amd64 Agent 测试包交叉编译通过，不代表 Windows 真机运行通过。
- 在临时 development Profile、真实 Node Host、受控 MCP 服务及同用户 Native IPC 中，验证状态/详情不触发业务请求或工具重新发现、HTTP 和 stdio 重连各自只作用于目标、断线和配置待批准的事实，以及待批准时只读已批准配置。实际 Desktop SSH 传输通过本机回环读取同一隔离 Agent 并重连指定 MCP；Cloud 在此测试中为 loopback 替身。
- 临时 Unix socket PostgreSQL、真实 Cloud 路由、Go Agent、Node Host、Native IPC 和 Desktop 控制器的隔离联合测试通过：真实浏览器经现有 Web 窗口批准后，Local MCP 移除、SSH 回环 API 移除及公开源 npm 指定版本更新均取得真实执行结果；私有源 npm 卸载使用相同的真实 Cloud 审批 HTTP 接口验证执行。API 拒绝后可再次申请，旧修订、错误 Boot、无权批准的观察凭据和重复兑换均被拒绝。公开 npm 测试在临时 Profile 中构造已安装旧版本和明确 latest 通道，版本检查与更新包使用真实公开 Registry。此联合测试驱动 Desktop Go 控制器，未以实际 Wails 窗口完成整条审批链路。
- 用户会话维护路径独立于现有 Host Grant/Run；Cloud 新增 `0021_desktop_maintenance.sql` 源码迁移，用于区分用户会话和保存一次性观察凭据的哈希。该迁移仅在临时测试数据库执行，未应用于开发或生产数据库；没有部署 Cloud。
- Desktop、Native 和包含本轮 Web 构建的 Cloud Go 服务已分别在临时目录构建；这不是包含全部发行资产的 Cloud 镜像，也没有替换现有客户端或 Agent。观察凭据仅驻留 Desktop 内存，最长不超过 24 小时或原用户会话的剩余时间；Desktop 重启后不能自动恢复原进度。
- 尚需将新版 Desktop、Native 和 Cloud 配套交付至获授权的开发环境，再验证真实目标的三类异常、权限不足、失败恢复，以及原生窗口隐藏/关闭时的完整联动。当前 JSON 是安全脱敏摘要，非完整原始文件；Desktop 用户会话的维护草案超过 512 KiB 时会显示不可用。重新安装和重新导入不在本轮范围。没有提交、推送或发布。

## Desktop 主动维护与删除统一（2026-11-28）

- 已实现本地确认、Native 同用户执行、身份/修订与维护互斥校验；MCP/API 热移除，npm 修改后安全重启并核验结果。保留 Skills/Scripts 安全删除与 Agent 卸载边界，SSH 移除改为确认弹窗并受维护门禁保护。
- 旧 Desktop 浏览器审批的 Web 页面、Cloud HTTP、Agent Cloud 专属协议、观察凭据与旧客户端测试实现已退役，测试改为直接 Native 管理；保留 AI Host 审批和 Web 控制台其他 owner_session 操作。已登记迁移 0021/0022 不重写。迁移 0023 移除专属短期观察凭据表，并禁止新增或修改旧 owner_session 维护申请；历史申请原样保留且不参与当前维护查询。上节浏览器审批测试仅为历史证据，不属于现行验收标准。
- 退役清理后：Desktop 全量门禁及最终前端复检（20 文件、90 项）、Web lint/typecheck/全量测试（59 文件、362 项）和 Web 架构门禁、相关 Go 包及专项 race、隔离真实 Cloud/Node/Native 的 Host 审批创建能力及本地 MCP/API/npm 删除、旧路由与协议拒绝、迁移完整升级矩阵均通过。真实 API 删除使用 Desktop Local 控制器。旧版数据库申请记录保留，迁移只在隔离临时 PostgreSQL 验证；未提交、部署、运行实际 Dev/生产迁移或重启真实 Agent。公开源 npm 更新和新协议独立远端 SSH/Windows 真机验收未在本次清理中执行。
- 已通过 Desktop 全量检查（90 项前端测试）、Go Native/Agent 专项回归、生命周期控制器专项测试，以及真实隔离 PostgreSQL/Cloud/Go Agent/Node Host/Native IPC 联合测试（MCP/API 移除、私有源 npm 卸载、旧修订与重复请求拒绝、能力清单回读）。npm 重启顺序由控制器测试验证，尚未在实际 Dev Agent 及独立远端 SSH/Windows 原生客户端完成端到端验收。未部署或发布。
