# Desktop 运行活动

设计来源：[运行活动](../desktop/design.md#运行活动)。

## 2026-11-27 实现与验证

- 已在工作区接入运行活动列表、详情、执行脚本、输入参数、运行日志、执行结果和资源与产物阅读页；支持中英文、双主题、统一列表、分页、运行中刷新、原文换行及返回位置和焦点恢复。示例只用于 development 工作区预览。
- 已实现 Desktop → 已认证 Local/SSH Runtime → 固定 Native CLI → 同用户管理端点 → Agent 本地 Run 存储的只读链路。读取绑定当前 target、operation、Profile、Agent ID、Boot ID 和来源；Agent 校验 Run/Work 归属及原工作目录的当前系统访问与身份。它不构造 Cloud 用户会话、不读取当前同名脚本、不执行历史 Run，也不改变 Cloud/MCP 的授权检查。
- Agent 复用既有留存快照和结果读取代码。每次代码、输入、日志读取最多 16 KiB；Desktop 最多展示 256 KiB，已裁剪、不完整、权限不足、过期及无法读取均不冒充完整内容。结果和资源按当前实际留存数据展示，不生成或刷新传输链接。
- Desktop `pnpm check` 通过：19 个前端测试文件、80 项测试，以及 Wails bindings、ESLint、TypeScript、Vite 构建、Go module/vet 和三组构建标签下的 Go 测试。Vite 主包超过 500 kB、macOS 链接器重复 `-lobjc` 为非阻塞警告。
- Agent 运行视图与 Native 管理端点的针对性 race 测试通过；隔离测试使用真实 Agent SQLite、留存脚本/输入/日志和产物、同用户 socket 与本地编译的 Native CLI，并经 Desktop Lifecycle Controller 读取列表、详情及各快照。测试数据为专用临时数据，不是运行中 Agent 的业务记录。Agent 读取与 Native 管理包的 Windows amd64、Linux arm64 交叉编译及 Desktop Lifecycle 的 Windows amd64 交叉编译通过，未在对应系统运行。
- 并行生命周期任务更新本机 development Agent 后，本任务通过该 Agent 的本机只读管理命令验证：空列表可正常返回；随后能读取并行任务创建的一条 development 测试 Run 的列表、详情、结果和完整脚本、输入、日志快照，并核对测试标记。该测试 Run 由并行任务通过 development 连接创建；本任务仅读取已有记录。
- 使用独立浏览器加载实际 React 组件与 Desktop 样式，检查中文浅色预览、英文深色详情、脚本与输入阅读、返回焦点；真实响应形状的交互使用测试替身，不构成 Wails 原生窗口或真实 Agent 数据验收。
- 共享检出曾因并行任务新增 AI 资料/资源用量接线而出现 TypeScript 类型错误；与该任务同步并修复后，完整 `pnpm check` 已再次通过。运行活动的 8 项专项前端测试和 ESLint 也单独通过。

## 独立 Mac 原生窗口复验（2026-11-27）

- 配套 `1.1.3-next.2026112702` 开发 Agent 上线后，用独立原生验收 App 打开真实 development 测试 Run，核对已完成状态、脚本、`context.input` 快照、日志、结果值 `42` 及无产物提示。保留的资源和产物正向读取由隔离集成测试覆盖。
- 按确认的精简方案移除列表标题和分组标题后，重新构建并启动 Desktop Dev；本机原生窗口确认真实记录直接显示，详情入口及返回可用。

## SSH 与异常场景补充验收（2026-11-28）

- 在独立 Mac 原生验收 App 中，经真实 SSH 回环连接运行中的 development Agent，读取现有测试 Run 的列表、详情、脚本、输入、日志和结果。另以 Desktop Lifecycle Controller 比较 SSH 和本机 Native CLI 的脚本、输入及日志响应，内容一致。此项使用 Mac 本机回环，不能代表远端 Linux Agent 已完成端到端验收。
- 仅断开独立验收 App 的 SSH 会话后，原生窗口显示未连接；重新连接后可再次读取同一条运行记录。隔离 Controller 测试在活动命令发出前断开 SSH，确认读取失败、不返回旧列表；重连后旧 operation 被拒绝，新 operation 可读取。另有无副作用 SSH 命令在执行中断线，确认结果为未知。尚未模拟活动响应数据传输到一半时断线。
- 通过 Desktop 的真实 SSH Runtime 在远端 Linux 以普通用户执行隔离测试：实际 Native CLI、同用户管理 socket、历史快照、目录身份、分页、产物、关闭、目录权限及缺失快照等九项均通过；Desktop SSH Runtime 侧启用 race 检查。远端未安装 development Agent，因此这是 Linux 原生隔离测试，不是运行中远端 Agent 的原生窗口验收。
- 在 Mac 和远端 Linux 的隔离数据上实际撤销某工作目录的系统权限：列表标记为部分可用，隐藏该目录的 Run，允许其他目录的 Run；底层读取器对详情及脚本返回 `path_not_allowed`，经同用户管理 socket 读取时拒绝并不返回内容。恢复权限后，两条读取路径的列表均恢复。删除测试专用代码快照后，详情标记代码不可用，已保留的输入仍可读取。权限不足和快照缺失的原生窗口提示尚未实机验证。
- 当前 Agent 测试包及 Desktop Lifecycle 的 Windows amd64 交叉编译通过；没有可用 Windows 测试机，未在 Windows 运行或验收客户端。初次交叉编译遇到并行任务的测试代码兼容错误，对方更新后复编通过。
- 本次 Desktop `pnpm check` 首次在生命周期 `TestControllerFreshCheckAndStart` 失败；并行生命周期任务调整后，该单项及完整检查重跑通过，包括 Wails bindings、ESLint、TypeScript、前端 19 个文件 / 82 项测试、Vite 构建和三组构建标签下的 Go 测试。Vite 主包大小及 macOS 重复 `-lobjc` 警告仍为非阻塞项。

## 尚待验收

- 运行活动的非空产物尚未在真实开发 Agent 的原生窗口复测。
- 远端 Linux 上运行中的 development Agent、Windows 原生客户端、活动响应传输中断线、权限不足及快照缺失的原生窗口提示和大历史清单仍需相应环境验收。现有隔离测试和交叉编译不能代替对应实机验收。
- 本任务未提交、推送、发布或操作生产 Agent，也未自行重启 development Agent；并行生命周期任务独立更新了开发环境。
