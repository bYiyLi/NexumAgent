# Desktop AI 资料

设计来源：[AI 资料清单](../desktop/design.md#ai-资料清单)。

状态：后台巡检与受限删除已形成开发候选；已使用真实 Development Agent 验证 Local 界面及 Desktop SSH 后台链路，完整实机验收仍有缺口。Cloud 离线时 Desktop 资料请求与删除确认暂停。

## 早期界面验证（2026-11-27）

- 已将统一的 Skills、Scripts、Instructions 列表和只读详情接入工作区，复用能力管理的布局、返回入口、主题和固定 Profile 市场入口。Skill 示例支持随附文件切换，Script 示例可展开源码，返回列表恢复滚动位置和焦点。
- 示例数据仅供 development 工作区预览。真实工作区尚未接入资料查询，当前显示不可用；不读取 Agent 私有文件、不伪造 Cloud 用户会话，也不以示例代替真实资料。
- Desktop `pnpm check` 通过：16 个前端测试文件、67 项测试，以及 Wails bindings、ESLint、TypeScript、Vite 构建、Go module/vet 和三组构建标签下的 Go 测试。Vite 主包大于 500 kB、macOS 链接器重复 `-lobjc` 为非阻塞警告。
- 使用独立浏览器预览加载实际 React 组件、Desktop 样式和 400 × 680 内容画布，检查中文深色、英文浅色、三类详情、文件切换、源码展开、市场回调，以及长列表的返回位置和焦点。该预览的市场回调使用替身，未打开真实市场，也不构成 Wails 原生窗口或真实 Agent 数据验收；未重建或重启运行中的 Desktop Dev。

## 删除入口（2026-11-27）

- 按确认设计，在 development 界面预览中为个人 Skill 和本地 Script 示例提供详情页删除入口与确认弹窗，展示名称、位置和影响；个人 Skill 提示共享目录可能影响其他工具，内置及扩展来源显示维护说明。
- 确认后仅从本次预览清单移除示例，明确提示不删除真实文件；真实工作区不展示该预览入口。真实资料读取、来源及授权验证和受限删除链路仍待接入，不能把示例交互当作实际删除。
- Desktop `pnpm check` 通过：17 个前端测试文件、72 项测试，以及 Wails bindings、ESLint、TypeScript、Vite 构建、Go module/vet 和三组构建标签下的 Go 测试。Vite 主包超过 500 kB 与 macOS 链接器重复 `-lobjc` 为非阻塞警告。
- `pnpm build:dev` 通过并启动 macOS 开发预览。原生窗口已核对本地脚本删除确认、取消与从预览列表移除，以及个人 Skill 的共享目录提示；最终窗口停留在脚本删除确认。所有操作均为示例，未删除真实文件。

## 真实资料读取验收（2026-11-27）

- Desktop 通过当前环境的 `desktop materials` 和同用户 Native 管理端点读取 Agent 级资料。清单和正文绑定目标、Profile、Cloud 来源、Agent ID 和 Boot ID；复用既有资料发现及正文校验。脚本元数据、长度受限的正文、Skill 随附文件和不完整状态分别验证；绝对路径与私有配置不进入管理响应。
- 在隔离的 Mac 原生开发 App 中，实际打开 Test Mac 的 `script-authoring`、`references/authoring.md`、`nexum/file.list.js` 及 `AGENTS.md`。同一运行实例的 Native 清单回读为 55 个 Skills、16 个 Scripts、9 个 Instructions，清单完整。
- 隔离测试覆盖三类正文、超长 UTF-8 内容、越界及符号链接拒绝、旧 Boot 拒绝和离开目标后的迟到响应。隔离浏览器验证读取失败重试、重试焦点、详情返回及附属文件切换。共享工作区构建和 Dev 部署证据见 [管理工作区验收](desktop-foundation.md#agent-管理工作区真实验收2026-11-27)。
- 真实写入及删除仍需受限操作和确认流程。真实 SSH、Windows 以及真实连接断开场景尚待验收。

## 后台开发候选（2026-11-28）

- Desktop Go 按目标调度资料清单检查和公开 GitHub 来源比对，聚合危险、建议及更新提示；Agent 只在收到请求时提供资料事实或执行已确认的受限删除，不增加常驻巡检任务。资料修订不变时复用已有上游比对结果。
- 个人 Skill 和当前 Profile 本地 Script 的删除包含实际位置展示、两分钟一次性确认、提交时身份与修订复核、结果回读和角标刷新。结果未知时不重放提交；再次准备删除前重新读取原目标清单。缺失入口、非法格式、已归档来源以及无法核实的更新分别按实际证据处理。
- 根仓库 Agent/Native 相关 Go 测试和竞争检测通过；包含正在运行的真实 Node Run 与资料检查并行完成的测试。Agent `pnpm check` 通过，694 项中 666 项通过、28 项按测试条件跳过。
- Desktop `pnpm check` 覆盖 Wails bindings、ESLint、TypeScript、Vitest、Vite、Go vet 与三组构建标签下的测试，最新运行前端 84 项测试通过。额外竞争检测覆盖巡检合并与取消、旧目标丢弃、离线恢复、旧 Agent 和删除结果未知；三类角标优先级由前端测试覆盖。使用合成的安装修订，对公开 GitHub 仓库完成实际 Trees API 比对；这次合成测试不代表用户 Skill 的实际比对结果，真实联调结果见下文。
- 隔离 Home 和 development Profile 下，使用实际构建的 Native CLI、本机管理端点及 localhost SSH，读取专用 Skill 和 Script，分别跨 Local/SSH 准备与确认删除，并回读空清单；管理端点为测试夹具。独立标识的 macOS Wails 原生窗口通过启动并核对预览列表、Skill 详情与删除确认；预览使用示例数据。
- 初次构建候选时未替换运行中的 Desktop 或 Agent，后续经用户授权使用当前 Mac 的 development 服务进行真实验收，结果见下文。候选来自共享工作区，包含其他未提交的并行改动；其中当前工作区界面的「项目与权限」入口与较早截图不同，需由对应负责人核对。
- 并行开发使底层 Native 资料读取支持 Cloud 离线。Desktop 资料入口曾实施不同的离线读取行为，用户随后确认以本次方案为准：Cloud 离线时暂停资料请求和删除确认，隐藏旧结果；恢复后重新读取。Native 通用端点的离线读取能力不改变该门禁。

## Cloud 离线资料读取与补充验收（2026-11-28）

此节记录并行开发曾验证的离线读取方案；该 Desktop 行为已被用户确认的在线门禁取代，不代表当前产品行为。Native 通用资料读取能力仍可独立存在。
- 真实 macOS Development Agent 在线时，使用独立数据目录和单实例标识的本地候选窗口打开实际资料清单和 Skill 正文，检查中文深色及英文浅色布局，并验证返回后的键盘焦点。期间窗口观察到执行运行时在未就绪和就绪间变化；未追断瞬时状态的原因。未停止或替换现有 Agent。
- 独立浏览器加载实际 React 组件和模拟的 Wails 资料响应，验证离线→在线→离线期间清单和详情可读；该测试不代表真实 Cloud 断线。隔离 Native 管理夹具使用本轮构建的 Native CLI，经 Local 和 localhost SSH 验证 Cloud 离线时 Skill、Script 清单及详情；管理端点和离线状态为测试夹具。
- 当时 Desktop `pnpm check`、开发版构建，Native `internal/nativeagent` 与 `internal/agentapp` 的 race 测试及资料专项测试通过；下文记录后续开发候选安装和真实联调。

## 当前 Mac Development 真实联调（2026-11-28）

- 按用户授权，仅操作 Mac development 环境，核对 profile 与 development Server URL 后安装本地构建的 Native 候选，保留原二进制备份。两次尝试启动候选未就绪后均恢复原服务；后续重新启动候选，确认 Cloud 在线、执行 Host 就绪。候选构建版本与当前 development Server 要求一致，不代表正式发布；production Agent 未操作。
- 使用独立 Desktop 标识和配置的真实 Wails 原生窗口连接运行中的 Development Agent，读取实际资料并在当时观察到 3 项技能更新及其修订差异。仅在 development Profile 创建专用的有效和无效脚本：无效脚本显示危险及原因，两者均经界面确认删除、回读并核对文件不存在。未删除与其他工具或 production 共用的个人 Skill。
- 使用 Desktop 自身的 SSH 传输连接 localhost 上的真实 Development Agent，自动化地读取专用 development 脚本，执行一次性确认删除并回读，目标文件消失。随后在 Wails 原生窗口添加 localhost SSH 目标，核对系统主机公钥指纹，读取真实清单和 Skill 详情，并通过界面确认删除另一个专用脚本；列表回读和文件系统均确认该文件消失。测试使用实际 SSH 和正在运行的 Agent，但目标仍是同一台 Mac，未覆盖独立远程机器。另在隔离 Home/Profile 中通过真实 Native CLI 验证专用 Skill 与 Script 删除。
- 针对上游修订比对期间清单发生变化导致更新角标被延迟的问题，Desktop 在发现并发变化时重新安排比对，并增加竞争测试。另补充仓库根目录 Skill 的比对：校验树响应与提交属于同一修订后使用根目录树哈希；分支在两次请求间变化时显示未知。
- 托盘实机验证：隐藏独立 Wails 窗口后创建一个无效 development 脚本，等待超过一个 60 秒周期；恢复窗口时工作区显示危险，详情说明脚本头部无效。经 SSH 界面删除该专用脚本后，列表、角标和文件系统回读均确认清除。切换目标、停止和掉线门禁由自动化测试覆盖；真实 Cloud 单独掉线与恢复、真实归档仓库建议、六小时自然周期和 Windows 仍待实机验收。
- 最终重新构建并验证本地 Desktop 与 Native 候选；Desktop 候选为临时签名，尚未替换正在运行的验收窗口，根目录 Skill 和角标竞争修复以自动化测试验证。重新构建的 Native 候选与当前运行中的实测版本是不同二进制，不能将当前运行状态视为该新文件的实机验收。开发候选及当前工作区均含其他未提交的并行工作；未提交、推送、发布或部署 Cloud。
