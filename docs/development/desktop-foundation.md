# Desktop 基础工程

范围：按 [Desktop 设计基线](../desktop/design.md) 建立独立、可构建和运行的桌面基础，保留现有 Agent/Browser/Cloud 的实现和发行方式；不实现 Agent 管理业务、不发布正式版本。

## 验收

| 目标 | 验证入口 | 当前状态 |
| --- | --- | --- |
| Wails v3 + Go + React/TypeScript/Tailwind/shadcn/ui | `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm tools:install`、`pnpm check` | 独立依赖安装、生成绑定、lint、类型、Vitest、Vite、Go module/vet/test 已通过；最终 pnpm check exit 0，无 warning |
| 独立 SQLite 和 Profile | Go 测试覆盖不同 Profile 持久化、外来数据库、另一 Profile 副本、无效配置 | Go 测试通过；Mac 同时启动两种 Profile，独立 HOME 中两个真实 SQLite 的 application_id 分别为 1314407504 / 1314407492，user_version=1，profile 与 theme 均读回正确 |
| 基础窗口、托盘、原生绑定和热更新 | macOS 开发运行、两种 Profile 实际应用检查；`pnpm dev` | Mac 两种原生应用均运行并记录前端绑定 ready；开发模式 HTTP 200、Vite 实际 HMR 事件通过；测试进程均确认停止。托盘代码已构建，菜单点击仍需人工验证 |
| 两种 Profile macOS 打包 | `pnpm package` / `pnpm package:dev`、签名与 DMG 校验 | Mac ARM64 0.1.0 / 0.1.0-dev 候选 DMG 均实际构建，ad-hoc codesign、plist、hdiutil 与 SHA-256 通过；非正式签名 |
| 四平台 GitHub CI | Desktop CI 的实际 commit/run、制品 | 工作流已配置，actionlint 通过；未推送，GitHub Runner 尚未实际运行 |
| 独立 GitHub Release | tag 选择、签名门禁、完整制品与摘要检查；实际发行需授权 | 工作流已配置，actionlint 通过；无发布 Tag、未实际发布、正式签名凭据未验证 |
| 保留现有 Node Host/Browser 与 Git 状态 | Agent 仓库根 `pnpm check` 与 Git diff | 仓库根 pnpm check exit 0；原有 Browser 修改保留；按任务范围检查 diff 与未跟踪文件 |

## 窗口外壳迭代（2026-11-27）

- 固定窄屏、自绘标题栏、细边框、主题、居中 Agent 选择与空白工作区已实现；开发预览目标与生产目标隔离。
- Mac ARM64 上本次修改后的 `pnpm check` 与 `pnpm build:dev` 通过；实际开发版应用启动成功，日志确认独立 Desktop SQLite 及前端绑定就绪，系统窗口信息约为 399 × 679（目标逻辑尺寸 400 × 680）。
- 真实 Agent 发现及连接不在本次范围内；Windows 原生窗口效果、交互操作及四平台 CI 仍需对应环境验收。

## 原生窗口控件迭代（2026-11-27）

- 改用 macOS 原生透明隐藏式标题栏及交通灯，禁用缩放/全屏；Windows 保留无边框窗口与右侧控件。统一背景及居中胶囊选择器，主体继续留空。
- Mac ARM64 开发工作区：本次修改后的 Desktop `pnpm check`（lint、TypeScript、4 项前端测试、Vite、Go module/vet 与三种标签下的 Go 测试）和 `pnpm build:dev` 均 exit 0。开发版重新启动，前端及 SQLite 日志就绪，系统窗口信息 399 × 679（配置 400 × 680）。
- 系统未授予当前诊断进程屏幕录制及辅助功能权限，因此实际交通灯外观、窗口点击、切换和拖动等交互未完成自动化真机验收；Windows 原生真机仍待验收。

## 极简标题栏迭代（2026-11-27）

- 移除 Agent 选择器常驻背景与图标、标题栏字标；将名称/版本/主题收纳至三点菜单。保留平台原生窗口行为及固定窄屏，主体留空。
- Mac ARM64：修改后的 Desktop `pnpm check`、`pnpm build:dev` 均 exit 0。开发版重新打开。独立 AppKit + WKWebView 布局测试加载实际构建 CSS，采用本机原生隐藏式工具栏复现窗口布局：原生关闭按钮、Agent 选择器、三点菜单垂直中心均为 26px；选择器水平中心 199.492px（窗口宽度 399px），未交互背景透明。此测试为独立布局测试，非实际应用截图或点击验收。
- 实际开发版窗口完整视觉和点击行为仍待人工确认；Windows 真机、真实 Agent 连接及四平台 CI 未验收。

## 客户端更新界面与公共主题（2026-11-27）

- 按已确认的纯色画布设计实现客户端更新全页、公共主题与品牌资源、共享进度组件、开发版预览与失败/重试状态；不接入真实更新器，不新增 Agent 管理功能。
- 本地 Mac ARM64 未提交工作区：Desktop `pnpm check` exit 0（10 项前端测试、lint、类型、Vite、Go module/vet 及三种标签下的 Go 测试）；`pnpm build:dev` exit 0，生成 ad-hoc 签名的原生开发版 .app。
- 使用本地已安装 Chromium 对实际构建前端进行隔离的 Wails IPC 测试替身验收（不是原生窗口截图）：macOS/Windows 外壳 × 浅色/深色四种组合均通过。400 × 680 页面无滚动溢出；body、外壳、标题栏、工作区、更新页、进度面板背景 RGB 全部一致，更新标签居中、68% 进度真实渲染；校验阶段不显示伪百分比，失败可重试、主题切换发出正确背景同步调用，退出调用及生产版预览禁用均通过。首次浏览器检查因 Playwright 默认版本缓存缺失失败，改用本机已安装 headless Chromium 后通过。
- 现有开发版 Desktop 实例仍在运行，保留该会话；未启动新包进行原生交通灯、窗口色差与真实退出验收。Windows 原生效果、实际自动更新和四平台 GitHub CI 仍未验收。

## 方案 B 公共标题栏与应用设置（2026-11-27）

- 按已确认的四态设计实现公共 DesktopTitleBar：正常工作区和设置页显示 Logo + Agent 下拉及设置齿轮，启动与客户端更新显示 Logo + 页面标题，隐藏 Agent 与设置入口；复用统一主题与平台窗口控件。设置包含真实主题/语言持久化、应用版本与通道；概览只展示管理目标和未连接事实，不实现 Agent 业务。开发预览从设置页进入，预览状态的调试操作留在正文，不可用于正式版。
- 本地 Mac ARM64 未提交工作区：首次完整 Desktop pnpm check 生成新版绑定、lint、typecheck 后，测试阶段因进程超时中止。顺序拆分后，前端 vitest run --maxWorkers=1（16 项）和前端 build 通过；缓存 Go 1.26.6 下 mod tidy -diff、vet、默认/production/production,desktopdev 三组 test 均 exit 0，含语言保存、旧 schema 默认值、无效值及 Profile 隔离测试。pnpm build:dev exit 0，生成新版 macOS 开发版应用。
- 使用实际构建前端和隔离的 Wails IPC 测试替身对 macOS/Windows 外壳 × 浅/深色 × 简体中文/English 八组合验收。400 × 680 下中央控件水平居中、统一背景、无横向溢出；各状态正确显隐控件，Agent 选择、设置选中及返回、启动/更新预览、失败重试、主题/语言写入响应与重新加载、正式版预览隔离均通过。测试脚本先后纠正下拉项完整可访问名称、异步保存后再断言 radio 状态，两次非通过不作为通过证据。浏览器验收不是 Windows 原生验收。
- 正常退出旧开发客户端（PID 48664），打开新构建应用（PID 5902），LaunchServices 确认前台、非隐藏、完成启动；日志确认 development SQLite 和新版前端资源已就绪。未修改生产版或 Agent。
- Agent 仓库根 pnpm check 本次超时中止，记录 186 通过、3 失败（npm spawn ETIMEDOUT 与登录环境探测超时）、55 取消、5 跳过；根门禁未通过，未扩大到 Node Host/Browser 修复。所有 Desktop 子检查分步通过；实际自动更新后端、真实 Agent 连接、原生托盘国际化及 Windows 原生/四平台 CI 未验收。

## 客户端启动页 UI（2026-11-27）

- 先更新 [Desktop 设计基线](../desktop/design.md) 的客户端启动与初始化章节，明确客户端自身初始化、必要就绪条件、失败与安全重试、Agent 检测和更新边界。完整初始化流程只做设计，本轮保持现有 Go 启动、SQLite、FoundationService 与前端 Info 调用及失败重试流程不变。
- 按确认的 Splash Screen 开发：原生窗口控件、留白、Nexum 字标、58 × 3px 不确定进度细线、状态文案、DESKTOP；共用现有主题及 ProgressBar，支持减少动态效果偏好、简体中文与 English。开发预览增加专用入口和结束预览操作，生产版隔离。
- Mac ARM64 未提交工作区：Desktop pnpm check exit 0，17 项前端测试通过，lint、类型、Vite、Go module/vet 及三种标签 Go 测试通过；pnpm build:dev exit 0，原生开发应用启动，实际进程参数为 --preview-startup，日志确认 development SQLite 与前端就绪。
- 隔离 Chromium 使用实际构建前端及测试替身 IPC 验证 macOS/Windows 外壳 × 浅色/深色 × 简体中文/English 八种组合，在正常及 reduced-motion 模式分别通过；400 × 680 内无滚动溢出，画布统一，字标居中，细线尺寸为 58 × 3px，无虚假百分比；结束预览、正式版预览隔离、既有失败重试测试通过。此为前端布局/交互测试，不是 Windows 原生或真实初始化验收。
- 当前保留实际 Mac Dev 预览供人工确认视觉；后台初始化、真实 Agent 连接/更新与 Windows 原生验收不在本轮范围。

## 启动与更新统一 Bootstrap（2026-11-27）

- 按确认的既有 Splash Screen 合并启动和客户端更新 UI 与展示状态：BootstrapView 保留原 Nexum 字标、58 × 3px 细线、状态文案及 DESKTOP，所有非 ready 状态共用 bootstrap 页面，顶部仅保留平台窗口控件。初始化样式原样保留；检查、下载、校验、安装、重启和失败沿用同一布局，退出、重试与开发预览继续可用。旧独立 StartupView、ClientUpdateView 和 client-update.css 已清理。
- 本地 Mac ARM64 未提交工作区：Desktop pnpm check exit 0，16 项前端测试通过，lint、类型、Vite、Go module/vet 及三种标签下的 Go 测试通过；pnpm build:dev exit 0，生成新版原生开发包。
- 修改前后分别使用实际 Vite 构建前端、隔离 Chromium 和 Wails IPC 测试替身，以 reduced-motion 模式在 macOS/Windows 外壳 × 简体中文/English × 浅色/深色八种 400 × 680 组合对比。初始化预览的布局、计算样式和 PNG SHA-256 全部一致；检查版本、68% 下载示例、未知进度、校验、安装、重启、失败、重试及结束预览逐项通过。预览无外部网络请求；不是原生窗口的逐像素截图或真实更新验收。
- 正常退出旧 Dev 实例 PID 19909，启动新版 PID 38647，实际参数 --preview-client-update；LaunchServices 确认前台可见，日志确认独立 development SQLite 及新版资源、前端就绪。
- 真实版本检查、强制更新后端门禁、签名、下载、替换和真实 Agent 连接仍未接入；正常启动目前仅等待真实本地 Info，不伪造更新检查。Windows 原生真机/四平台 CI 未验收。

## 统一启动流程预览入口（2026-11-27）

- 设置页将启动加载与客户端更新两个旧入口合并为「启动流程预览」，从初始化进入，共用 BootstrapView；开发预览底部可以切换初始化、检查更新、下载、校验、安装、重启、更新失败七个阶段。仅保留启动预览命令和参数，移除旧独立更新入口；正式版仍禁用预览。
- Desktop pnpm check（17 项前端测试及三组 Go 测试）和 pnpm build:dev 均 exit 0；Agent 仓库根 pnpm check exit 0。实际构建前端在双平台外壳、双主题、双语言八组合下验证单一启动入口、七阶段交互、原初始化主体计算样式和几何位置一致、旧入口禁用及生产隔离。正常退出原 Dev 实例并启动新版 PID 53517，参数 --preview-startup，前台可见且日志确认前端就绪。
- 收尾检查发现并行的 Agent 环境检测界面开发增加了独立环境检测预览和样式，保留其改动，不将该业务预览误判为旧客户端更新入口；本轮构建及 UI 验收对应并行改动之前的启动预览候选。真实更新引擎仍未实施。

## Agent 环境初始化确认页（2026-11-27）

- 按确认的方案 B 实现 EnvironmentConfirmView：复用公共标题栏及共享主题，左对齐标题、一张设备信息卡、2 × 2 环境属性、编号初始化步骤、底部确认说明与主按钮。开发版通过设置或 --preview-environment 进入，明确标注示例数据；确认仅更新本地 UI 文案，不调用后端，不伪造初始化成功。设置、退出预览及开发目标切换保持可用。正式版不开放预览。真实环境检测、Agent 安装及初始化后端仍未实现。
- 本地 Mac ARM64 未提交工作区：Desktop pnpm check exit 0，18 项前端测试、lint、类型、Vite 构建、Go module/vet 与三个构建标签的 Go 测试全部通过。pnpm build:dev exit 0。
- 实际构建前端在隔离 Chromium 和 Wails IPC 测试替身环境中通过 macOS/Windows 外壳 × 浅色/深色 × 简体中文/English 八种 400 × 680 组合；均无滚动溢出，双列属性布局正确，按钮高度 46px。macOS 信息卡宽 352px，按钮纵坐标 602px；Windows 信息卡宽 350px（含窗口边框影响），按钮纵坐标 601px。标题、次要文案、卡片标签、主按钮文字实测对比度均 ≥4.5:1。验证确认按钮无新增 IPC 请求、设置往返、结束与重新进入预览、Mac 浅色中文的开发目标切换、正式版预览隔离。此为前端布局与交互检查，不是原生截图或真实 Agent 初始化验收。
- 停止旧 Dev Desktop 实例 PID 53517，启动新开发版 PID 85681，实际启动参数 --preview-environment，日志确认 development SQLite 和前端 ready。未修改 Agent 运行状态或生产客户端。Windows 原生与完整 Agent 根门禁、四平台 CI 尚未针对本轮重新验收。

## 环境确认页比例校准（2026-11-27）

- 只调整确认页设备卡、属性网格、步骤区间距及预览结束入口；保留公共标题栏、主题及原生窗口 400 × 680 配置。修改前系统窗口元数据实测 399 × 679（无屏幕录制权限，未读取实际截图）。
- Desktop pnpm check exit 0（18 项前端测试与三组 Go 测试），pnpm build:dev exit 0。隔离 Chromium 加载实际构建前端与 Wails IPC 测试替身，macOS/Windows 外壳 × 浅深色 × 中英文八组以及 399 × 679 macOS 尺寸全部通过。400 × 680 macOS 画布设备卡 (24,157,352,203)，步骤区 y=385，确认说明 y=563，主按钮 (24,601,352,46)，均对齐方案 B 的比例基准；结束预览位于按钮下方，无溢出。确认按钮无新增 IPC，退出预览仍有效。
- 旧 Dev Desktop 实例 PID 85681 已退出，新版 PID 96728 使用 --preview-environment 启动，日志确认独立 development SQLite 及前端 ready。Windows 原生、实际 Mac 窗口视觉仍需人工确认；未开发环境初始化后端或修改 Agent。

## 扁平应用设置与通知界面（2026-11-27）

- 按确认设计将设置改为扁平分组（外观与语言、常规、通知、数据与诊断、关于客户端），移除分组卡片，保留主题控制及固定标题栏；不修改共享主题或启动页样式。开发版常规和通知开关为明确标注的临时 UI 预览，通知总开关联动禁用子项并保留预览值；生产版未接入配置不可操作。数据目录/日志操作尚未接入，现有主题与语言真实保存，关于链接调用 Wails 系统浏览器接口。保留启动流程和环境初始化的独立开发预览。
- Desktop pnpm check（20 项前端测试及三种 Go 标签）和 pnpm build:dev 均 exit 0；Agent 根 pnpm check exit 0（Windows 专用测试仍按平台跳过）。使用实际构建前端与隔离 Wails IPC 测试替身在 macOS/Windows 外壳、浅/深色、中文/English 八组合验证扁平分组、固定标题栏、开关联动、预览不写入偏好、主题语言保存调用、外部链接调用、生产版隔离及已有预览入口，全部通过。首次 SSR 测试因未考虑 HTML & 转义失败，修正断言后重新通过。
- macOS 正常退出原 Dev 实例 PID 96728，启动新版 PID 17809，前台可见；实际启动日志确认 development SQLite 和新版前端资源就绪。未实施真实系统通知、自启动、关闭行为配置或诊断文件打开；Windows 原生真机与实际浏览器链接导航仍待验收。

## SSH 配置表单与连接状态页（2026-11-27）

- 按已确认的新版设计优化顶部环境切换与远程添加流程：保留 304px 居中分组菜单、真实本机入口及明确未连接的远程示例；主机/端口同行、名称选填、SSH Agent/私钥/密码三种认证分支。密码仅限本地表单示例、支持显隐，私钥选择只展示示例文件名。非秘密字段与连接展示状态统一管理，返回配置保留非秘密字段，退出或切换目标清理草稿。
- 新增 RemoteConnectionView 与六种可手动切换的连接状态：连接、主机身份核验、认证、超时失败、认证失败、主机身份变化。连接状态沿用 56px 图标及 58 × 3px 不确定进度线；完整示例指纹可换行，未宣称实际远程连接或成功。信任、重试、取消和返回均仅驱动 UI，不读取密钥、发送密码或调用 Agent。实际 SSH 连接、凭据、主机验证、目标持久化及初始化逻辑仍为设计。
- 本地 Desktop pnpm check exit 0，23 项前端测试、lint、类型、Vite、Go module/vet 与三种标签测试通过；pnpm build:dev exit 0。实际构建前端使用隔离 Chromium、Wails IPC 测试替身与 CDP 鼠标/键盘输入事件，macOS/Windows 外壳 × 双主题 × 双语八组 400 × 680、399 × 679 Mac 尺寸共九组均通过。默认主机输入 (24,182,252,40)，端口宽 88px，主按钮 (24,595,352,46)，密码分支同一按钮位置；连接图标 (172,174,56,56)，进度线 (171,362,58,3)。完整指纹卡允许真实长度换行而非截断。
- 首次测试发现 399 × 679 密码分支纵向超出 2px，调整表单底部最小间距后重新运行全部组合通过。先前环境切换的合成事件测试未通过，本次改用真实 CDP 鼠标/键盘事件重新验收，目标切换及共用环境确认视图正常，返回配置、清空密码、选项切换、字段校验、信任/重试/取消、切换目标取消连接和生产版隔离均通过；预览流程无新增 IPC 请求、外部网络请求或运行时异常。
- Mac 原生开发版由 PID 87885 更新至 PID 22040，实际参数 --preview-environment，日志确认 development SQLite 和前端 ready。保留用户查看预览；本次验收不是 Windows 原生运行或真实 SSH 安装/连接验收，未重跑 Agent 根门禁及四平台 CI。未提交或推送。

## SSH 默认认证方式优化（2026-11-27）

- 新建远程环境默认密码认证，密码框留空、默认隐藏；认证选项依次为密码认证、使用本机 SSH 密钥、指定私钥文件，中英文同步更新，图标随认证方式切换。继续保持 SSH 连接预览、密码清除与非秘密表单字段恢复的原有契约，不改变实际 SSH 后端。
- Desktop pnpm check exit 0（24 项前端测试，lint、类型检查、Vite、三种 Go 标签检查通过）；实际构建前端通过 Mac/Windows 外壳、浅深色、中英文八组 400 × 680 及一组 399 × 679 回归。默认密码框、密码校验、显隐与清除、选项顺序、本机密钥文案、私钥分支、连接状态与取消/切换、生产隔离均通过，无预览新增 IPC 或外部网络请求。
- pnpm build:dev exit 0，Mac Dev 由 PID 22040 更新至 PID 78805，启动参数 --preview-environment，日志确认 development SQLite 与前端就绪。Go 链接阶段出现重复 -lobjc 非致命警告；Windows 原生与真实 SSH 未验收，不执行生产操作或 Git 提交推送。

完成条件：本地实际检查通过，macOS 窗口/托盘/绑定/热更新与候选包得到验收，CI 对同一提交生成四平台预期制品，现有工作不被覆盖；正式公开发行单独授权和验证。

## Desktop 基础设置后端与系统集成（2026-11-27）

- 本轮真实接通主题、语言、关闭行为、桌面通知总开关及异常/结果子项；布尔偏好兼容现有 SQLite schema v1，默认关闭窗口隐藏、通知总开关关闭、子项开启。实际登录项与系统通知权限通过原生接口回读，不把偏好当成授权；两个 Profile 独立。统一关闭钩子、登录项操作通知及诊断错误通知、固定 data/logs 路径和测试通知接口均已实现。移除常规/通知临时预览，保留已确定的扁平设置页和其他开发预览。
- Mac ARM64：Desktop pnpm check exit 0（24 项 Vitest、ESLint、TS、Vite、module/vet、三种标签 Go 测试），pnpm build:dev exit 0；Agent 根 pnpm check exit 0（平台专属测试按原有条件运行或跳过）。Windows AMD64 与 ARM64 Go 交叉编译通过，不代表 Windows 原生验收或安装包构建。Mac 链接器仅报告重复 -lobjc 库警告，未导致构建失败。
- 用独立身份、隔离数据库和相同实际 Go 设置服务及窗口关闭钩子的 Mac 原生验收应用，确认 SMAppService 登录项启用、回读、撤销及清理成功；真实打开该验收 Profile 的数据和日志目录成功；窗口隐藏、恢复、按配置关闭退出均确认成功。正常退出验收进程，无残留测试登录项。实际登录重启场景与 macOS 12 LaunchAgent 路径未执行真机验收。
- 原生通知授权申请已发出，但验收等待期间没有获得系统授权回执，未真实发送测试通知。未代用户授予权限或修改 TCC；当前实际投递仍待用户授权后验收。后端测试覆盖未授权、总开关/子项、成功回执、拒绝/发送失败及操作结果不受通知失败影响。Windows WinRT 权限状态与 Wails 发送仅编译和逻辑测试通过，仍须原生真机确认。
- 实际 Vite 前端使用隔离 Chromium 与 IPC 测试替身验证 macOS/Windows × 中文/English × 浅/深主题八组（开发/生产 Profile 分别覆盖），实际生成绑定对应请求、开关联动与持久化回读、错误后回读、测试通知、诊断路径语义参数、主题语言保存和重新加载、400px 横向布局及开发预览隔离全部通过。初次测试的异步 radio 与 Windows 1px 边框断言修正后通过；替身测试不作为原生通知发送证据。
- 收尾核对真实 Mac Dev 最新构建已启动（PID 78805），13:20:49 日志确认 development SQLite 与前端 ready。保留并行开发的远程连接 UI 修改；未修改 Agent 或生产客户端运行状态。git diff --check 通过，无构建产物、数据库或生成绑定泄漏到未跟踪文件列表；未提交、推送或发布。

## SSH 新建环境表单精简（2026-11-27）

- 移除环境名称输入、RemoteDraft.name、名称辅助函数及已无引用的双语文案和样式。连接预览直接显示主机地址及完整 SSH 端点；后续真实连接成功后的 Hostname 读取、地址回退及重命名仅更新设计。默认密码认证和凭据清除、身份核验、返回及取消流程保持不变；调整表单行间距，保持原窗口与底部操作位置。
- Desktop pnpm check exit 0（24 项前端测试、lint、类型、Vite、Go module/vet 及三组标签测试）；隔离 Chromium 与实际构建前端、Wails IPC 测试替身及 CDP 输入事件的九组布局回归全部通过，覆盖 macOS/Windows 外壳、双主题、中英文与 399 × 679 Mac 尺寸。三种认证分支均无名称字段；连接状态按实际输入地址展示，返回恢复非秘密字段、密码清除、取消和重试、生产版隔离通过，无外部网络请求和新增预览 IPC。
- pnpm build:dev exit 0；Mac Dev PID 78805 正常替换为 PID 44198，启动参数 --preview-environment，13:46:31 日志确认 development 前端就绪。仅存在重复 -lobjc 非致命链接警告；真实 SSH、Windows 原生和四平台 CI 未验收。未修改生产运行状态，未提交推送。

## 设置操作空响应白屏修复（2026-11-27）

- 根因：Wails v3.1.0 实际 transport_http.go 对 Go 无业务返回值的成功绑定调用返回 JSON {}，旧 settingsAction 将其作为 ClientSettings 写入 React state，SettingsView 读取缺失 login.state 触发渲染异常，React root 清空。使用相同实际 HTTP payload 在修改前复现。旧 IPC 测试替身返回 null，未覆盖真实协议。
- 修复：client-settings.ts 增加完整状态校验及 settingsAfterCommand，打开目录和测试通知丢弃 void 响应，单独读取 Settings；所有设置快照入口校验，异常读回显示可恢复错误而非白屏。未改变 Go 原生目录功能、UI 样式或配置 schema。
- Desktop pnpm check exit 0（28 项前端测试、lint、类型、Vite、Go module/vet 和三组 Go 测试），pnpm build:dev exit 0。实际构建前端在 macOS/Windows 外壳 × 双语 × 双主题八组合通过真实 {} 响应的两个目录/测试通知、操作失败、异常设置快照及重新读取回归。
- 原生 Mac 隔离验收：实际 WKWebView 点击 data/logs 交替四次，Go/Wails/Finder 全链路真实返回 HTTP 200 {}，每次随后 Settings 返回完整状态；设置页仍可见，JS 错误 0，独立验收应用正常退出。测试通知仅验证空响应处理，未重新申请系统权限或验证实际投递。Windows 原生未运行。

## 统一 Agent 环境检查 UI（2026-11-27）

- 设计基线明确 Desktop 只检查系统信息及条件、Agent 根目录、Agent 程序、基础配置、系统服务和版本兼容性；受管 Node/Host、SQLite、npm、MCP/API/SDK 等内部环境由 Agent 自身维护。Local/SSH 共用检查契约，结果绑定目标、连接、用户、Profile 和批次；实际检查必须只读，未知不等于未安装。真实受限状态接口、探测报告和自动分流后续设计，遵循现有私有数据边界。
- 新增 EnvironmentCheckView 与 environment-check.ts，复用连接状态页 56px 图标、58 × 3px 不确定加载条和公共主题。七个阶段、八种结果均为明确标注的手动示例；初始化分支查看现有确认页，就绪分支查看未连接的工作区外壳，配置、升级、修复和启动分支展示后续建议而不执行操作。重新检查、取消、切换目标/进入设置重置；生产版不开放开发预览。保留原 SSH 与直接初始化预览。
- Desktop pnpm check exit 0：29 项前端测试、lint、类型检查、Vite、Go module/vet 与三组标签测试全部通过。初次 SSR 断言未考虑英文撇号的 HTML 转义，按实际渲染修正断言，并为重试后恢复焦点补充实现，重新执行完整门禁通过。
- 实际构建前端使用隔离 Chromium、Wails IPC 测试替身及 CDP 输入事件：macOS/Windows 外壳 × 浅深主题 × 中英文八种 400 × 680 组合及 Mac 399 × 679，共九组通过；各组验证七个阶段、八种结果、无滚动溢出、进度尺寸、目标切换重置、重试/焦点、初始化及工作区路由、设置入口和 SSH 表单返回、生产隔离。无外部网络请求或运行时异常，检查预览不新增 Agent IPC。
- pnpm build:dev exit 0，Mac Dev 从 PID 57576 更新为 PID 15351，启动参数 --preview-environment-check，14:19:26 日志确认 development 前端就绪。链接器重复 -lobjc 警告未阻止构建。实际 Agent 环境检查、生命周期操作、Windows 原生及四平台 CI 尚未验收；未修改 Agent 运行状态、生产环境或提交推送。

## Bootstrap 全状态 UI（2026-11-27）

- 按确认的极简启动页扩展单一 BootstrapView。16 种设计稿状态加配置加载、系统服务准备、迁移后数据校验共 19 种阶段；保留公共主题、字标、58 × 3px 进度槽、DESKTOP 和单一启动预览入口。更新阶段才显示版本，已知下载进度才显示百分比；六种失败显示对应错误图标和操作。数据迁移仅在可安全重试时展示重试，预览重试只切换阶段，手动安装预览反馈不执行安装；查看日志调用既有真实 Desktop 日志目录接口。正式版禁用预览，保留实际 Info 启动逻辑。
- Desktop pnpm check exit 0（32 项前端测试、lint、类型、Vite、Go module/vet 和三组 Go 标签测试），pnpm build:dev exit 0；Agent 根 pnpm check exit 0，平台特定测试按现有条件跳过。Mac 链接阶段重复 -lobjc 为非致命警告。
- 实际构建前端与隔离 Chromium/Wails IPC 测试替身验证 macOS/Windows 外壳 × 双语言 × 双主题八种 400 × 680 组合及 macOS 英文暗色 399 × 679，共九组；每组验证 19 状态、对应重试、手动安装预览、真实日志绑定参数、真实 Info 失败重试、生产隔离，均通过。Nexum 字标纵坐标 Mac 262 / Windows 255，进度槽与 DESKTOP 固定（0.05px 亚像素误差阈值），无滚动溢出或重叠、JS 异常或外部请求。阶段切换、重试、手动安装预览不产生实际操作 IPC。初次回归发现菜单异步展开断言、亚像素差异和失败页底部溢出，分别修正测试时序/亚像素阈值及异常布局；手动安装反馈复用现有预览提示，不额外占高，最终全部通过。
- macOS Dev PID 15351 正常退出，最终构建 PID 41147 启动参数 --preview-startup，14:28:28 日志确认新版 JS/CSS 与 development SQLite、前端就绪；窗口未隐藏，但检查时不是前台活动应用。未执行真实版本检查、下载安装、数据库迁移或强制更新后端；Windows 原生及四平台 CI 未验收。CSS 启动区之外保持原样，保留并行环境检查开发记录。git diff --check 通过，无生成绑定/构建产物/SQLite 泄漏到未跟踪文件；未提交、推送或发布。


## Bootstrap 初始化、强制更新与 SQLite 迁移后端（2026-11-27）

- 真实 Go Bootstrap 服务提供带 revision 的状态快照、变更事件及受控重试、退出、手动安装入口。React 读取并校验快照，事件配合启动期轮询，拒绝无效或过时快照；未就绪不得进入工作区或开发预览。设置等业务绑定也受 Go 就绪门禁约束。启动读取现有 Profile、日志、数据库、配置及服务，通知权限不作为启动前置要求。源码/HMR/本地候选构建明确记录 localBuild，不执行公开发行更新；已知签名更新要求不能被候选构建绕过。
- SQLite 仍为 Schema 1。首次创建先在隔离路径完成再发布，迁移使用内嵌连续 SQL、VACUUM INTO 一致性备份、事务和版本更新，校验身份、完整性、外键及配置，拒绝外部数据库、错误 Profile 和更高版本。失败迁移事务回滚；备份保留以供诊断和恢复。没有为未来业务虚构 Schema 2。
- Updater 区分 production/development 的 GitHub Desktop Release、版本顺序、平台架构与独立 Ed25519 信任根；验证原始签名清单、制品大小和 SHA-256，流式下载并发布实际字节进度。已确认版本要求与安装事务原子持久化；有更新要求后断网仍阻止就绪。辅助进程交接、进程间锁、程序校验、更新后启动确认与临时文件清理已接通；macOS 同文件系统原子交换 app，Windows 受控执行固定路径 NSIS 静默安装并核对实际程序哈希。对安装或恢复结果不明的情形保留程序与数据库备份，阻止不安全的自动重试或降级；当前不实现结果不明时无条件自动恢复已提交的数据库或程序版本。真实手动安装入口仅打开已验证安装包位置。
- 更新发行工作流及签名脚本使用按通道注入的公钥和私钥，发布构建缺少信任配置失败关闭，不生成正式密钥。隔离 Node 测试以临时 Ed25519 密钥验证两个通道各四个模拟制品，确认正确签名、错误公钥拒绝、制品篡改拒绝及已有清单覆盖拒绝。未配置实际发行签名材料，未发布 GitHub Release；公开网络、正式平台签名和四平台实际发行仍待验收。
- 最终 Desktop pnpm check exit 0（34 项前端测试、lint、类型、Vite、Go module/vet、三组 Go 标签测试），pnpm build:dev exit 0，Windows AMD64/ARM64 Go 交叉编译 exit 0。Agent 根检查初次因 PATH 缺少 pnpm 子进程入口失败，使用实际 runtime/bin 路径重跑 exit 0。构建存在重复 -lobjc 和 Vite 500KB 阈值的非致命警告。
- macOS 原生隔离升级通过两轮，最终可重复脚本 pnpm test:update:mac exit 0：旧版 0.1.0-next.1、新版 0.1.0-next.2，实际原生包、真实 WebView、临时 Ed25519 签名、替代 GitHub 的隔离传输 fixture、真实 DMG 下载验证、旧进程退出、辅助进程安装和新版自动启动。第二轮已安装 SHA-256 与签名清单一致，更新事务 complete，测试 Schema 1→2 成功，备份一份，主题 dark、语言 en-US、关闭行为 false、通知偏好 false 及迁移 fixture 保留；临时安装任务清理完毕，验收应用已全部正常退出。Schema 2 仅由隔离测试注入，不修改真实项目 Schema。
- 构建前端通过隔离 Chromium/Wails IPC 替身的 macOS 中文浅色及 Windows 英文深色两组合，确认真实快照失败时预览不能绕过门禁，重试实际调用 RetryBootstrap，显示下载 35/100 对应 35%，19 阶段、操作、生产隔离、位置与无溢出回归通过。不是 Windows 原生 UI/安装验收。
- 当前本地开发版由旧 PID 41147 退出后启动新版 PID 25794，15:06:14 实际日志确认 storage/configuration/services/ready，updateCheck=localBuild，原生窗口前台活动。未更改用户已有偏好、Agent 或生产运行环境。检查基线差异限 Desktop、Desktop CI/release 和关联文档；保留已有 Browser 改动。无数据库、密钥、生成绑定和构建产物泄漏进未跟踪文件。未提交、推送或发布；Windows 真机安装、正式可信签名及公开发行端到端验收仍待完成。

## 原生品牌图标统一（2026-11-27）

- 排查确认原 PNG、ICNS、ICO 的 SHA-256 与 Wails v3.1.0 默认资产相同，macOS 菜单栏显式引用 Wails 默认模板。改为从现有公开 Nexum SVG 生成彩色应用 PNG、同源 ICNS/ICO 及透明单色托盘模板；保持 Desktop 原有 App ID、窗口与 Profile。macOS 模板由系统着色，Windows 浅深色托盘显式绑定同一多尺寸 ICO，避免框架回退。
- 新增 pnpm icons:generate / icons:check 及生成清单；普通 check/build 仅校验已生成资源，不安装额外渲染依赖。Mac 使用系统 sips 和固定 Wails CLI 生成，ICNS 为 8 个原生 PNG 表示（32–1024px，含 16pt Retina），ICO 含 16、20、24、32、40、48、64、128、256px，菜单栏模板 64px。初次 ICNS 检查要求 16px 独立表示，核对 Wails 编码器后改为实际支持的八个表示；各尺寸实际解码、透明边角及品牌色通过。隔离副本验证过期 SVG、资源被修改、截断 ICO 均拒绝通过。
- Desktop pnpm check exit 0（34 项前端测试、lint、类型、Vite、Go module/vet 及三种标签测试；Go 图标测试逐个解码全部 PNG 表示并检查品牌色、透明留白及模板单色性）。在 Mac 通过固定 Wails CLI 独立生成 Windows AMD64/ARM64 COFF 图标资源，两者各包含全部 9 个 ICO PNG；NSIS 安装与卸载配置均引用该 ICO。未在 Windows 真机构建或运行安装包。
- pnpm build:dev exit 0；开发版原 PID 25794 正常替换为 PID 73758，15:15:06 前端 ready、updateCheck=localBuild。实际 Bundle ID com.nexum.desktop.dev、Info.plist 图标引用及 ad-hoc 签名通过，Bundle 内 ICNS 与源资产 SHA-256 一致。NSWorkspace.iconForFile 和 NSRunningApplication.icon 返回新版 Nexum 图形（系统阴影与边缘处理，不要求与源 PNG 逐像素相同）；AppKit 可解码 64px 菜单栏图标并设为 template。屏幕录制权限未开启，未获得实际 Dock/菜单栏屏幕截图或主题切换视觉验收。构建重复 -lobjc 与 Vite chunk size 为非致命警告。
- 核对任务文件写入回执、原生资源清单、git diff --check 与未跟踪文件，保留其他并行修改，无临时测试资源或构建产物进入未忽略清单。未操作正式 Desktop 或 Agent，未提交推送或发布。

## Agent 初始化授权与执行 UI（2026-11-27）

- 本轮替换旧 EnvironmentConfirmView，新增 AgentInitializationView、14 个明确标注的授权/安装状态以及环境检查 initialize/configure 的分流。无服务器地址/Token 输入；无新增 Agent IPC、系统浏览器打开或真实安装。
- Desktop 独立 pnpm check exit 0：34 个前端测试、三种编译标签的 Go 测试、类型、lint、绑定及构建通过。隔离 Chromium 实际 Vite 构建与最新 Bootstrap IPC 替身，在 macOS/Windows 外壳、双主题、中英文八个 400 × 680 组合及 Mac 399 × 679 共九组验证 14 状态、目标重置、重新授权、返回检查、配置分流、工作区预览、无溢出、无新增 IPC、生产预览隔离、无外部网络请求及运行异常。不是原生 Windows 或真实 Agent 安装验收。
- 完整 Cloud 协议、原生凭据保护、目标/检查批次绑定及后续 Go 接线见主仓库设计文档。当前实际 Desktop 安装与授权回调后端仍未实施。

## 原生快捷菜单与主窗口恢复（2026-11-27）

- macOS/Windows 原生托盘左键恢复原窗口，右键呈现原生菜单；菜单头使用现有 Nexum 品牌资源和真实产品名、版本，四项操作为打开主窗口、设置、关于、退出。Dock 重开与单实例激活复用主线程窗口恢复逻辑；macOS 先解除应用隐藏，再 Restore/Show/Focus。打开窗口不重置页面或目标。设置、关于通过递增修订导航到现有设置页对应区域；启动门禁与退出规则由 Go 实际状态控制，已保存语言优先，系统语言提示仅保存在进程内。退出仅结束 Desktop。
- 独立专项验证：35 项前端测试、lint、类型及 Vite 构建通过；Go 菜单与 FoundationService 专项测试三种编译标签通过。隔离 Chromium 验证四组平台外壳、主题和语言，设置/关于定位、快速导航顺序、重复修订拒绝、聚焦恢复、就绪门禁及目标保持通过。Windows AMD64/ARM64 交叉编译 exit 0。
- macOS ARM64 临时 App 独立数据目录签名构建与真实 WKWebView 验收通过：关于、设置、隐藏后恢复的实际页面回执 ok=true；AppKit 原窗口隐藏标志 33、恢复标志 43（窗口存在、可见、key、应用 active），外部 open 重开同 PID 并再次得到 43。首次验收脚本恢复回执存在语法错误；复验改用真实 AppKit 可见性而非 Wails 遮挡状态并修正脚本。临时 App 和数据均已清理。未获得辅助功能/屏幕录制权限，未执行物理托盘点击及截图验收；Windows 未真机验收。
- 整体 pnpm check 在并行环境层 Schema 2 变更期间遇到旧迁移测试仍假定 Schema 1 的失败（TestMigrationChainAndConsistentBackup、TestPreferencesPersistence、TestLanguagePreferenceCompatibilityAndIsolation）。不改动其他任务负责的迁移逻辑，未重启共享 Dev App 或触发共享数据迁移。保留其他并行任务修改，未提交、推送或发布。

## Agent 自升级状态 UI（2026-11-27）

- 按已确认方案实现 AgentUpgradeView 与 agent-upgrade.ts，复用现有环境状态画布：等待、升级、恢复连接、结果未知及失败五个示例；成功直接进入未连接工作区，不增加成功页。环境检查 upgrade、设置及开发启动参数均可进入；返回/异常恢复重新检查、切换目标重置、生产预览隔离。不触发安装、升级、启动、停止或修复 Agent。
- 并行授权恢复 UI 的修改保留，合并后的最终 Desktop pnpm check exit 0（39 个前端测试、10 个测试文件，lint/typecheck/Vite、Go 绑定/module/vet 及三组标签测试）；pnpm build:dev exit 0，macOS ARM64 开发版构建成功。Vite 520.89 kB chunk 与重复 -lobjc 为非阻塞警告。
- 最终实际 Vite 构建 index-CpQifMkg.js / index-oNyG5Ddj.css 经隔离 Chromium 和 Wails IPC 替身复验：macOS/Windows 外壳 × 浅深色 × 中英文八组 400 × 680 加 Mac 中文浅色 399 × 679 共九组，五种状态、56px 图标、58 × 3px 不确定进度、异常操作、重新检查焦点、远程目标切换、设置往返、成功分流、直接预览入口均通过。无滚动溢出、额外 Agent IPC、外部网络请求或运行异常；正式 Profile 不开放该预览。
- 设计基线已明确 Agent 负责自升级及内部恢复，Desktop 后续通过受限生命周期状态契约观察；真实观察、实际版本与管理连接验证、工作区自动恢复、真实修复及跨平台原生验收不在本次 UI 开发范围。未启动/重启共享客户端以避免影响并行环境层及初始化开发；未触碰 Agent 或生产环境，未提交、推送或发布。


## Agent 未授权与连接恢复 UI（2026-11-27）

- 环境检查的 configure 预览结果仅代表已安装且凭据明确缺失/失效，显示「Agent 未授权」；网络连接异常独立显示并只提供重新检查，配置或服务损坏仍归修复，不推断授权失效。复用 AgentInitializationView：首次安装 7 个执行阶段，连接恢复 4 个执行阶段，不重新下载、安装或注册服务；两种模式均复用 5 个授权阶段和 2 个结果，分别 14/11 个示例状态。执行列表整体水平居中、内部图标和文案左对齐，进行中以品牌色、动画及 aria-current 区分。切换目标或新建预览重置模式。全部预览不执行真实授权、安装、配置或 Token 兑换。
- 更新 Desktop 设计基线和 README；新增 agent-initialization.test.tsx，专项两文件 18 项通过。Mac ARM64 完整 Desktop pnpm check exit 0（39 项前端测试、lint、类型检查、绑定、Vite、Go module/vet 及三组 Go 标签测试）。Vite 大于 500 kB 与重复 -lobjc 为非阻塞警告。
- 以该次 Vite 实际构建、隔离 Chrome、Wails IPC fixture，验证 macOS/Windows 外壳 × 中英文 × 浅深色八组 400×680 与 macOS 英文暗色 399×679。九组通过网络异常重查、首次安装与恢复分流、授权等待、所有执行/失败/结果状态、步骤图标和文本对齐、列表居中及无溢出；同一模式执行状态变化时列表位置及宽度差值为 0px。生产预览隔离通过；无外部网络、业务操作 IPC 或 JS 异常。该验证不是原生 Windows/真实授权验收。
- 并行 Local/SSH 接线随后更新 App.tsx 和公共 CSS；回读确认本轮 canPreview 守卫、初始化模式分流/重置及居中样式仍保留。最新类型检查、39 项 Vitest、任务所涉文件 ESLint 均通过；最新全量 ESLint 在其他协作者的 AddRemoteView.tsx:38:99 发现 react-hooks/exhaustive-deps 错误，已通知环境层同学处理，未改其文件；最新合并工作树全量门禁因此尚未确认通过。既有未跟踪 Desktop 工程采用读前后内容与修改锚点对比；Git 已跟踪差异检查通过，无新增未忽略构建产物、SQLite 或密钥文件。未重新启动实际 Desktop、执行 Agent 根门禁、提交、推送或发布。

## Agent 正常就绪控制中心 UI（2026-11-27）

- 实现 AgentWorkspaceView 与 agent-workspace.ts：按确认稿复用现有品牌 SVG、居中 72px 状态图标及身份、独立运行/管理/Cloud 状态、2×2 功能卡片、独立 Agent 设置与维护入口；双语双主题，功能范围二级页提供返回及焦点恢复，不提供未实现的业务写操作。
- development 设置入口、--preview-agent-workspace / pnpm preview:agent-workspace，以及环境检查 ready、初始化/连接恢复完成、升级成功示例均进入同一工作区预览。示例身份与版本健康数据明确标注；真实 SSH 目标退出预览并遵循原连接逻辑；非预览 WorkspaceView 保留。未新增任何 Agent 管理后端或修改真实 Agent。
- 最终 Desktop pnpm check exit 0（12 个前端测试文件、46 项测试、lint/typecheck/Vite、Go 绑定与三组标签测试）；pnpm build:dev exit 0，macOS ARM64 开发版构建成功。首次新增 SSR 断言未考虑英文 & 的 HTML 转义，修正后全量通过；同时完善浅深色成功状态对比度。Vite 547.94 kB chunk 和重复 -lobjc 为非阻塞警告。
- 实际 Vite 构建 index-BhMTwr8r.js / index-CUZcfOp6.css 使用隔离 Chromium 与真实 Wails 绑定形状替身：macOS/Windows 外壳 × 浅深主题 × 中英文八种 400 × 680 组合及 Mac 399 × 679 共九组通过。核对 72px 品牌图标、两列间距 12px、Mac 四宫格 352 × 228、维护入口 352 × 62，五个入口点击/返回焦点、设置往返、目标切换、真实 SSH fixture 不继承示例上线状态、成功分流、直接入口及正式隔离。无布局溢出、额外业务写操作 IPC、外部网络请求或运行错误。
- 设计基线与 README 已同步，真实管理状态接口、具体二级功能与异常恢复待后续接入；Windows 原生界面未实跑。本次不重启共享开发版、不操作 Agent、不提交/推送/发布。


## Agent 异常修复 UI（2026-11-27）

- 新增 AgentRepairView、agent-repair.ts 与专项测试，环境检查 repair 结果进入修复方案确认。四种异常示例：系统服务、程序、安装目录、连接配置；程序损坏有额外制品校验，其余执行计划为确认异常、对应修复、启动或重启、验证连接。复用居中步骤列表；失败及结果未知区分处理并返回检查，修复结束直接重新检查而不伪造就绪。新增 development 专用设置入口与 --preview-agent-repair / pnpm preview:agent-repair。未修改正常就绪工作区；其他同学随后独立合入工作区预览，保留并行改动。真实受限探测、修复计划及 Agent 管理连接操作仍待后端接入。
- 首轮 Desktop pnpm check 退出码 0（12 个前端测试文件、45 项测试、lint、typecheck、Vite、Wails 绑定、Go module/vet、三组 Go 标签测试）。修复初次 SSR 测试的文案断言（原将下拉选项当作真实按钮，改为核对按钮集合）。浏览器测试首次因旋转 SVG 的外接矩形左边缘比较失败，连接短暂离线后回收原结果，未重放任何业务操作。
- Mac ARM64 最新并行合并状态 Desktop pnpm check 退出码 0（12 个文件、46 项 Vitest、lint、类型检查、Wails 绑定、Vite 构建及三组 Go 测试）；检查期间 frontend/src 与相关预览入口文件未发生变化。校验指纹 25549282adf1240fd627f4698821d6fc5b0c1e00efb9a0d45c95b18afaacbc5a；构建 index-BhMTwr8r.js / index-CUZcfOp6.css。Vite 547.94 kB chunk 与重复 -lobjc 为非阻塞警告。
- 使用该实际构建与隔离 Chromium/Wails IPC fixture 完成 macOS/Windows 外壳 × 中英文 × 浅深主题八组 400×680，以及 Mac 英文暗色 399×679，共九组；四种修复计划 × 九组全部通过。确认、执行、失败、结果未知、完成返回检查、切换目标、设置往返及生产/Bootstrap 隔离均通过；没有滚动溢出、外部网络、修复业务 IPC 或页面异常。列表位置和宽度变化均为 0px；45° 动画固定角度复现外接矩形左偏 3.1066px、中心偏差 0px，实际 SVG 布局宽度 15px，改用中心点和文案起始位置进行正确验收，保留旋转动效；非固定角度也实际观测到外接框变化。两次九组复验均通过，最终构建资产哈希测试前后相同。
- 回读任务独有文件、公共路由、双语文案、样式、原生预览入口与文档，确认与批准设计一致；对已存在的未跟踪 Desktop 文件采用前后哈希与修复专属修改内容核对，并保留共享文件的并行工作区修改。Git 跟踪及暂存差异 --check、Go 格式、任务文件尾部空白检查均通过；未跟踪清单未发现绑定、dist、bin、SQLite、密钥或临时测试文件泄漏。此次验收范围为 UI/预览，未执行真实 Agent 修复、Windows 原生 WebView 或 Agent 根全量门禁；未提交、推送、发布或重启共享 Desktop。

## Agent 管理工作区真实验收（2026-11-27）

设计来源：[Agent 正常就绪与管理工作区](../desktop/design.md#agent-正常就绪与管理工作区)。五个入口均已在独立 macOS ARM64 开发 App 上连接真实 Test Mac。

| 入口 | 真机证据 | 后续验收 |
| --- | --- | --- |
| 能力管理 | 读取 `zod@4.6.7` 的实际安装和依赖声明 | 实际 Dev MCP/API 数据及维护操作。见[能力管理](desktop-capabilities.md) |
| AI 资料 | 读取真实清单、三种资料正文及 Skill 附属文件 | 真实写入和删除。见[AI 资料](desktop-ai-materials.md) |
| 项目与权限 | Desktop 打开开发 Cloud 中 Test Mac 对应的详情；页面显示实际项目和允许目录入口 | 项目、目录和权限的变更由现有 Cloud 控制台负责 |
| 运行活动 | 读取实际 Run 的脚本、输入、日志、执行结果和无产物状态 | 含产物的原生窗口、在途和异常分支。见[运行活动](desktop-activity.md) |
| Agent 设置与维护 | 实际展示系统服务、独立连接状态及 Node Host CPU/RSS，刷新后读到新采样 | 服务控制、配置写入及诊断导出仍需对应写入和数据契约 |

配套 Cloud/Native `1.1.3-next.2026112702` 在 OpenClaw 从此前已部署的 Dev 快照叠加管理工作区源码构建。基准提交 `fc13da744d7f353cd281824eaf4945ecdf277db6`，源码归档 SHA-256 `c7d118ef2e07979848d5f6cb47f6f1123b7cbe153e72ba994a43d0e9536e7a3b`，Hosted 标签 `1.1.3-next.2026112702-c7d118ef`。Hosted/Group OCI index 摘要一致，为 `sha256:b2bac830c0724692d9952660a8192999369e7b0c67c866a4cd42930f8061fea7`。Dev 运行平台摘要为 `sha256:7ff58706e1a22f2bd5a3c2ee49420398c38d15de9ccc154e6ef927dc1bc76ad6`，迁移预检和备份通过，schema 保持 19。公开健康检查通过，Mac Agent 自动升级并恢复 Cloud 在线与执行就绪。

Desktop `pnpm check` 通过，包含 19 个前端测试文件、78 项测试、ESLint、类型检查、Vite 以及三组 Go 标签。主仓 `go test ./...`、改动范围 `go vet`、Native 管理接口和 Desktop 生命周期专项 race 检查通过。使用 Dev 配套 Node Host 和隔离的 MCP/API 服务通过能力详情的真实运行时测试。Mac 独立候选包构建、签名校验和原生窗口验证通过。以上证据对应冻结的已部署版本和配套验收 App；冻结后的资料删除等并行工作仍需独立联调。实际 Dev 操作限 development Profile，本轮源码留在工作树，正式 Desktop 未发布。Windows 和真实 SSH 端到端仍待验收。
