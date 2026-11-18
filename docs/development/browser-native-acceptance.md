# Nexum browser 原生验收记录

## 2026-11-18：Chromium 原生点击结果与 Run 分组复验（本地候选，未发布）

- 使用本机已有 Chrome for Testing（Chromium 1254 Playwright 缓存）和隔离临时 Profile、真实 MV3 插件、真实 Worker、Core/Registry，在不碰用户现有浏览器和 Dev Agent 端口的条件下，`native MV3 provides page interaction, MCP JPEG and an actual downloaded MCP resource` 正向用例通过：实际 DOM、填表、点击、业务状态、MCP JPEG 和文件资源字节均有证据；不等同于截图已到达 ChatGPT 对话。
- 扩展原生矩阵首次 6 项中 2 项失败：一个滚动后点击在点击发送时由于 Chromium 可视区域/滚动迟到变化，实际可信事件落在 `spacer`，原代码却按同一坐标上的任意可信点击算成功；另一个测试错误地要求新 Run 重命名前一 Run 已保留的 AI 蓝色分组，与现行 `docs/browser/interaction.md` 每 Run 分组隔离规则冲突。
- 点击修复在首次原生鼠标移动后，重新使用**原目标 ref** 获取真实坐标并按需再次移动；只在坐标稳定且目标真实存在时注册回执并发送**一次**按下/释放。点击回执先确认目标命中，并要求可信事件 `composedPath()` 含原目标；不把坐标相同但点击其他节点当成成功，不重放已发送的输入。预定位只滚动一次，后续观察不重复触发滚动，原生测试已通过遮挡解除、持续遮挡 `TIMEOUT`、取消后禁止迟到点击，且确认实际点击元素身份及 `event.isTrusted`。
- 分组原生测试改为在创建者 Run 中命名其蓝色组，后续 Run 不更改旧组；既有用户绿组也不受影响。**同源真实 Chromium 专项 7/7 通过，0 失败/跳过**，包含跨站嵌套 Frame、滚动/遮挡/取消点击、AX 状态与截图、真实网络取消/截止时间和任务分组保留。旧用例错误预期不作为产品缺陷；权限与跨 Run 隔离不放宽。
- 已补真实目标事件的负向组件回归：同一点可信点击必须属于原目标，否则确认数仍为零；VM Frame 夹具提供标准 DOM `composedPath()`，恢复真实目标门禁。新版本 Browser 全量 `check` 通过，**225/225 通过，0 失败/跳过**；尚待新 Agent/Browser 包安装至 Dev 后在真实 ChatGPT Host 上重验，不能从本机结果推断已部署。
- **2026-11-18 续测证据**：复查上轮中断的文件写入与当前 Git diff 后，在本机隔离 Chrome for Testing 中独立复跑「用户组及旧 Run 蓝组保留」1/1 通过，并复跑「点位被遮挡拒绝」「遮挡等待、取消后不迟到点击」「AX/CUA/DOM 真实控件输入」3/3 通过，全部 0 失败/跳过；未重命名另一 Run 的组，也没有绕过可信点击目标校验。随后当前源码 Browser 完整 `check` **226/226 通过**，Agent 完整 `check` **1400/1427 通过、27 跳过、0 失败**，根仓库 `check:quick` 退出 0。此处为本地最新验证，另有并行开发中的安装/Profile 改动仍在工作区；未提交/发布此修复，未在 Dev Cloud 的真实 Host 上验收图像交付。

## 2026-11-18：Extension Worker 资源上报身份修复候选（未发布）

- 已部署 Nexum Dev 的 Browser 在 `browsers.list/get`、`tabs.list` 成功后，`tabs.get`、`management.windows.list` 和 `capabilities.browserList` 返回 `extension_worker_request_invalid / Unknown resource report owner`。相同错误在两个真实标签的 `tabs.get` 中复现；尚无原生页面 DOM、截图或点击验收结论。
- 源码根因位于 Core Worker Bridge：`call.resources.register` 创建的 `browser.run` 被记录为 `call` owner，但 `worker-entry.localRef.report` 固定以 `host` owner 上报。修复后保留 Worker-local 的精确 token 以及注册时的 `host/call` 身份，经生命周期通道上报，Core 仍核对 token 与原 owner；不放开跨 owner 的 `resources.get`。
- 新增真实 Worker 回归，覆盖 host/call 两种资源报告、原创建方法结束后继续报告，以及 `call` 不能借用 host 资源。定向 Agent 构建和 Worker/Run 测试 14/14 通过；随后 `corepack pnpm --dir agent check` 与 `corepack pnpm --dir agent/packages/browser check` 均退出 0。新源码尚未发布到 Dev，实际 Chrome/Edge/Host 的 `tabs.get`、DOM、截图、操作及收尾仍须另验，不从本地门禁推断线上已修复。
- **本轮补测**：新增 `packages/browser/test/runtime.test.mjs` 的真正独立 Extension Worker + Core/Registry/SQLite + Browser 公共 SDK + 实际 MV3 Router/连接代码的隔离链路。使用测试进程临时端口和模拟 `chrome.*` API，不占用 Dev Agent 监听端口；`tabs.get`、`capabilities.browserList`、`management.windows.list`、截图 JPEG 字节读取与 `browser.run` 真实资源收尾均通过。此前模拟 `tabs.query` 忽略 `active/currentWindow` 条件会导致伪造的 `INVALID_TARGET`，已修正夹具并复验。测试属于组件端到端，**不等于真实 Chrome/Edge 或 Host 截图交付**。
- 补充 Core 发起 Run 资源 `dispose()` 后 Worker 仍正确报告物理关闭的回归，且不能跨 owner 借用控制器。本轮重新执行 Browser `check` 退出码 0；Agent `check` 共 1431 项，1404 通过、27 跳过、0 失败。新增测试与修复均尚未发布至 Dev Agent；当前已连接 Test Mac 仍为 Browser `0.0.3-next.17`，`tabs.get` 仍复现旧错误。

## 2026-11-17：IANA 未分配冷门端口段候选（尚未发布）

- 继本日 `43830–43849` 在 Windows + WSL Mirrored 网络模式中与 `43255–47350` 保留区间冲突后，进一步核对 IANA 官方 [Service Name and Transport Protocol Port Number Registry](https://www.iana.org/assignments/service-names-port-numbers)：`29001–29117` 在当前登记表标记为 `Unassigned`（未分配）。选择 Dev `29030–29039`、Production `29040–29049`，保留每个环境十个端口、按顺序尝试、限定本环境 MV3 CSP、现有握手身份校验和失败后的退避。未分配不表示平台独占或永远空闲。
- 在 Yi Test Win / Development Agent `0.0.3-next.18` 上，以实际 TCP socket 在 `127.0.0.1` 逐个探测新端口段：**20/20 可以监听并正常关闭**；同机 Windows 默认 TCP 动态端口起点为 `49152`，当前 WSL 的临时端口范围是 `43255–47350`。这只确认当次本机可用，不保证其他设备或重启后状态。
- 本机 macOS/arm64 对新端口候选执行 `corepack pnpm --dir packages/browser typecheck`、`build`、`test`：**223 项通过、0 失败、0 跳过**，包括 Dev/Production 的端口段枚举、监听回退、隔离和插件 CSP。代码及组件检查成功不等于已部署或真实 Windows Browser 控制通过。
- 同一轮 Agent Core 执行 `corepack pnpm typecheck`、`corepack pnpm build` 与全部 `test/*.test.mjs`：**1386 项通过、0 失败、27 项跳过**。上述只核对当前本地源码，不等价于 npm 发行、Cloud 部署、Windows Chrome/Edge 插件实际连通。
- 新候选只修改本地 Agent/Browser 源码、插件、对应测试与设计资料；尚未推送/发布 npm，也未升级 Windows Browser 包、重新加载 Chrome/Edge 插件或完成真实 Host 端到端验收。下面 `43830–43849` 的旧候选及失败证据保留作为历史记录。

## 2026-11-17：Profile 十端口段候选（尚未发布）

- 按本轮明确要求，Development 仅在本机 `43830–43839` 中顺序绑定可用端口，Production 仅在 `43840–43849` 中绑定。Chrome/Edge 配套 MV3 插件同步限定各自十个 WebSocket 地址，未完成握手时短暂探测并尝试下一端口；全部不可用时仍明确失败，不越过环境边界或重放网页动作。监听授权按实际候选端口逐次检查，资源状态报告实际监听端口。
- 本机 macOS/arm64 对候选源码执行 `corepack pnpm --dir packages/browser typecheck`、`build`、`test`，Browser 共 **223 项通过，0 失败、0 跳过**。新增回归覆盖占用后选择下一个端口、整个单端口段不可用、Dev/Production 插件只探测所属范围以及最终 MV3 CSP 只允许本环境十个端口。属于组件/模拟连接验收，不是 Windows 实际安装或用户浏览器端到端成功。
- 在已授权 Windows 测试机 Yi Test Win 的 Development Agent `0.0.3-next.18` 上，使用独立 Node 程序实际尝试绑定 `43830–43849` 共二十个 loopback TCP 端口，**20/20 返回 `EADDRINUSE`**。因此端口段候选仍不能解决该机器当前全部候选端口不可用的问题；未修改 Windows 网络配置、未更新 Agent/Browser npm 包及用户 Chrome/Edge 插件，未报告真实连接已恢复。
- 同机进一步只读排查定位原因：Windows 的 `%USERPROFILE%\.wslconfig` 明确启用 `networkingMode=mirrored`，已运行的 WSL Ubuntu 的 `/proc/sys/net/ipv4/ip_local_port_range` 恰为 `43255–47350`（4096 端口）。Windows 独立 Node 与 .NET TcpListener 在区间内分别得到 `EADDRINUSE` 和 Winsock 10048；边界探测 `43254`、`47351` 可监听，`43255`、`47350` 不能监听；`netstat`、`Get-NetTCPConnection` 及 IPv4/IPv6 excludedportrange 均未显示该区间的普通占用。此结果与微软 WSL 团队说明的 Mirrored 模式 HNS 为 Linux 临时端口保留 4096 端口行为一致（[WSL issue #40169](https://github.com/microsoft/WSL/issues/40169)）。因此本次固定端口段完全落入 WSL 保留区间，增加十端口回退仍不足以恢复该 Windows 设备。
- 只读检测 Windows `42030–42049` 当前 20 个端口均可监听，但这不是对重启后可用性或更换设计的授权；WSL 保留窗口可能在后续启动时变化。未停止 WSL、未调整 `.wslconfig`、未使用其他端口代替用户已指定的范围。Agent Core 类型、构建及全量回归亦通过：1386 项通过、27 项跳过、0 失败。
- 上线时需同时发布、启用本包与匹配的 MV3 插件，并重新加载现有插件；旧插件仍只连接旧固定端口。完整 250 项与三平台真实 Browser 原生矩阵保持原有未完成状态。

当前状态为 `in_progress`。候选公开入口、受管方法、MV3 插件和五类贡献已经存在；完整 250 项、Chrome/Edge 与三平台矩阵尚未完成，未发布 npm。用户已在现有 Chrome 手动加载开发扩展并完成局部场景，范围与限制见下文。设计与稳定 ID 由 [browser 设计](../browser/README.md)及[成员映射](../browser/capability-matrix.json)拥有，本文件只记录实际证据与缺口。

## 2026-11-17：AI 可靠交互候选回归（本地，未发布）

- 在现有 Browser 候选基础上，增加同一浏览器会话的原生变更顺序协调、点击前双次布局一致性检查、主文档及跨域/嵌套 Frame 的可信点击回执（Frame ID/文档 token 绑定）、短暂稳定窗口与表单输入/选择同步状态核验。不可确认的点击返回 `INPUT_UNCONFIRMED`，不自动重放。
- 公开 Locator 可选 `click({expect: WaitCondition})` / `dblclick({expect})`；点击前预登记顶层导航事件，点击后观察明确的业务页面条件，成功返回真实 `WaitResult` 快照，未观察到返回 `EXPECTATION_UNCONFIRMED` 与未知效果，不重放输入。新增 `tab.observe()` / `tab.observe({full:true})` 组合现有 load、URL、标题和 AX 全量/差异供 AI 简化观察。更新 Browser Skill 和用法文档；无新 MCP Tools。
- 本机 macOS/arm64、Node 24.22.1、pnpm 10.34.5：`corepack pnpm typecheck`、`corepack pnpm build` 及 `corepack pnpm test` 成功，Browser **219 项通过、0 失败/跳过/取消**。新增用例覆盖跨域 Frame 可信回执、点击目标位置稳定、跨标签输入互斥、快导航预登记、业务期望匹配与超时不重放、AI `observe()` 的调用和返回。真实浏览器及异步业务成功语义不从这些夹具测试推断。
- 独立 Chrome 原生验收需要占用当前 development Browser 端口；已有 Nexum Dev Agent 正在使用，原生夹具的 `PORT_IN_USE` 拒绝不应以停止现有 Agent 绕过。本次**未部署/重启 Dev Agent、未升级其 Browser SDK 或浏览器插件，不能将旧 Dev Agent 的成功调用计作新候选验收**。
- 后续阻塞：需发布新的匹配测试包/插件到受控 Dev 环境，再以真实 macOS Chrome/Edge 检查跨 Frame 原生事件、两个 Tab 并发点击、页面 SPA 异步状态、未知结果处理、取消和清理；Linux/Windows 与完整 250 成员仍依托各自实际证据验收。此记录不宣告发布、推送或整体验收通过。

## 2026-11-14：组件与跨平台候选

- Node 24.22.1、pnpm 10.34.5，本机 macOS/arm64 的 `pnpm --dir packages/browser check`：类型、构建及 131 项组件检查通过，0 跳过。它们包含真实 Core/Registry、loopback MV3 peer 和受控浏览器 API 夹具，不能当原生 Chrome/Edge 全量验收。
- 安全 CI 候选 `ba36ebf504f32c939cebee5a408c5a244ca78d4d` 修正了 native command 就绪屏障及 Windows 直接启动 npm CLI 的方式。[browser 运行 43594505339](https://github.com/bYiyLi/NexumAgent/actions/runs/43594505339) 的 Linux、Windows、macOS 三平台组件、打包与制品上传均已通过。这是候选组件 CI，不是三平台真实浏览器全量验收。
- `packages/browser/implementation.json` 的 `publicMembers.nativeAcceptance` 是完整逐成员原生矩阵的状态；当前尚未逐项执行完该矩阵，不用组件测试或下面的局部通过将 250 项全部标为通过。

## 2026-11-14：独立 Chrome for Testing 160

只使用新建的临时浏览器 profile、受控 loopback 页面、实际 MV3 插件和实际 Core SDK。没有选择、修改或安装到用户现有 profile。浏览器为 macOS/arm64 官方 Chrome for Testing `160.0.8160.0`、revision `1744042`；下载归档 SHA-256 为 `415c9a0ecc40969f80cba4f4377552e9ba1dd13b375ecb2d6e64c7328755eb42`，同时核对官方对象 MD5。

固定源码：

| 文件                                                       | SHA-256                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/browser/test/native-capabilities.acceptance.mjs` | `4eea7eb5fb3fff4656c52d9499a9041153c406649922bb2fe8699a858c40247c` |
| `packages/browser/test/helpers/native.mjs`                 | `5ac2dfadec695bb2d2b5f5163afec287b4fef10ed78a54009a3dcf9dcefe0bcf` |
| `packages/browser/browser-extension/router.js`             | `86663cc1ec1217174567bdce5bd54589d05bc5e10b78d33d18b609464bfd6b7d` |
| `packages/browser/src/extension/index.ts`                  | `45339d9d2f20f993fbf95f73a2b76d1c38e978f3880a8920a4d1888bb16fe0b8` |

两组结果必须分开：

1. 不开启 WebMCP 测试特性，执行 `node --experimental-vm-modules --test packages/browser/test/native-capabilities.acceptance.mjs`：6 项通过、0 跳过。实际覆盖 peer 身份/metadata/资料、capability 修订、视口与前台跟随、当前撤权、原生日志筛选、真实 Dialog 别名及 WebMCP 探测。该浏览器默认没有 `document.modelContext`；最后一项证明准确反馈实际不可用，不能计为正向工具调用。
2. 在该独立 profile 设置 `NEXUM_BROWSER_WEBMCP_TESTING=1`，只选择 `native WebMCP` 测试：1 项通过、0 跳过。实际执行原生注册、direct/bound 调用、同名重新注册、旧绑定拒绝和新修订调用，要求真实 opaque toolId，不用名称降级。这只证明该明确开启的测试特性，不推导普通 Chrome 默认可用。

浏览器二进制路径由 `NEXUM_BROWSER_NATIVE_BINARY` 显式选择。测试结束清理自己创建的实例与 profile；不借用户登录、生产 Agent 或其他进程完成验收。上述检查使用当时实际编译的 Core 候选，不等于这些路径已经经过 Cloud/真实用户 Host；之后的 Core 收尾和文件计量修改仍须最终同源回归另证，不能自动继承这些结果。

## 当前缺口

- 下载的 CDP GUID 与 `chrome.downloads` 整数 ID/本机文件之间还缺可靠身份绑定，URL/时间/文件名不能单独作为同一下载的证明。
- 完整 250 项需要逐成员正常、失效、权限、取消和结果证据；上面的分组通过尚未形成全量同源矩阵。
- 普通 Chrome/Edge、三平台、多个用户配置、用户已有标签与实际 Host 的文件/图片交付仍须分别验收。
- 原生 WebMCP 的默认可用性与测试特性分开，不将真实环境不支持、实现缺失、跳过和完成混在一起。

所有结论性问题修复、实际矩阵与 Phase 48 完成门槛共同通过后，才可更改整体状态。

## 2026-11-14：下载身份检查与当前限制

`d52eb5f936b7b9718cd2d3bfeaf8d874998c06ff` 的 [browser CI 43599908327](https://github.com/bYiyLi/NexumAgent/actions/runs/43599908327) 三平台组件、打包与制品通过；同一候选 Core 与签名安装服务亦三平台通过。macOS/arm64、上面的独立 CfT 160 在当前 Core 编译图 `512bd64a76c62ae507439acde269811389dd42aac40c3952481f7933058ea99e` 上运行五份原生场景文件，25 项通过、0 跳过。测试修正为读取公开 ActionResult 的真实 controlEpoch、按实际 Schema 控制等待器，并等待真实视口尺寸到达；没有放宽目标身份或原生状态断言。

这 25 项的原始下载正向路径依赖 URL/时间猜测，无法证明本机文件属于原始 CDP GUID，因此不作为安全文件取回验收通过。Chrome 的 [DownloadItem](https://developer.chrome.com/docs/extensions/reference/api/downloads/#type-DownloadItem) 暴露整数 ID，Page 下载事件使用 GUID；当前 [extension debugger 可用域](https://developer.chrome.com/docs/extensions/reference/api/debugger/#restricted-domains) 不包含 Browser。固定 Chromium `160.0.8160.0` 的 [Page handler](https://chromium.googlesource.com/chromium/src/+/refs/tags/160.0.8160.0/content/browser/devtools/protocol/page_handler.cc) 与 [Downloads API](https://chromium.googlesource.com/chromium/src/+/refs/tags/160.0.8160.0/chrome/browser/extensions/api/downloads/downloads_api.cc) 也未给出二者的直接关联；不能把当前唯一、同 URL、同名、完成时间或事件顺序推断当成身份凭证。

后续修复删除全局 downloads 元数据监听及 URL/时间关联。原始 target/lease/controlEpoch/GUID 的事件、状态与取消等待器继续可用；当前 MV3 的 `download.path()`、`tab.saveDownload()` 明确报 `CAPABILITY_NOT_ALLOWED`，不调用 `downloads.search` 读取猜测路径，不扫描用户下载目录，不重发原始网络请求，也不改浏览器全局下载设置。使用手册与实现清单同步公开这个限制。正向文件取回仍未实现，不能把拒绝测试计成该特性完成。

本机串行组件检查已通过 132 项、0 跳过，新增实际路由回归覆盖同 URL 外部文件先到/后到、完成状态不产生文件授权；实际 Core/Registry/SQLite 场景仍保留 38 次下载等待器并确认未复制该文件。已知来源的文件快照、资产/媒体下载、PDF/HTML/Markdown 导出继续由原有真实字节测试验证，与原始浏览器下载身份问题分开。12 份本轮相关源码清单 SHA-256 为 `f7fb3c61aeee928b147c90926c7a2f3031c15e78f660dadb8964154127030014`，router SHA-256 为 `4179c9b2bdac732d3788232aefb20e932c415f175aed4a88eaa61106d30670ab`；66 份包源码冻结清单为 `7f809f479cbd6bf6179a8e91997789532918b49d85e1509fc931e580977ec377`。

这份修复的 macOS/arm64 原生串行复验 25/25 通过、0 跳过，随后单独启用 WebMCP 的真实注册/调用/旧绑定拒绝 1/1 通过。25 项中的两个下载场景验证明确不可用与拒绝错误文件，不是正向文件取回验收。安全候选 `3ed08ea11f409c2ac8a420f11d18fa21e28d61c7` 已提交推送，301 个产品文件清单 SHA-256 为 `c188c149b56492f4bfdc60e7b6b3fd98d7a008652af829ea167315f5bfd0a26f`；[browser CI 43600946315](https://github.com/bYiyLi/NexumAgent/actions/runs/43600946315) 的实际结果另记，不预记通过。

一次组件与原生场景被误并行调度，争用固定本机端口，导致 `PORT_IN_USE`；该批日志保留，不计为产品故障或通过证据。组件串行重跑通过后，原生场景再单独执行；没有关闭已有用户服务来腾出测试端口。

## 三平台原生场景 CI

可选包工作流新增实际原生浏览器场景，与之前的组件/打包检查分开。固定 CfT `160.0.8160.0`，从 Google 官方 HTTPS 版本对象完整读取并预先计算 SHA-256；CI 再核对精确字节数与 SHA-256，之后才解压、执行。平台对象分别为 linux64 `7521f2e2f6fe90af5b1d6481a80a0a1421b6d743e370de6f614b05d4b1bed4de`、mac-x64 `7fd77afe2e542a15113d6ecafd0c6ce6cea70548801a04071b35f09818f5efe6`、win64 `574ca7f73e650798e184eb6b2c5aa8c590dd7a46d18add670c9d0bb69d95ac14`。

准备脚本只允许 GitHub-hosted 临时 runner，并验证临时目录和工作流环境文件。浏览器文件在 RUNNER_TEMP，每个场景使用自己的新 profile，不选择现有用户浏览器。Linux 仅设置该已验 hash 归档中的原生 SUID sandbox helper，不禁用浏览器 sandbox，不修改全局内核策略。Windows 仅对该公开程序树授予 AppContainer 的读/执行权限，测试 profile 与用户目录在其外，不授予写权限。CI 发布的原生准备记录只含版本、平台、归档/程序 hash 等公开证据；不发布浏览器 profile、网络记录或运行凭据。

同一 job 先完成组件检查，再串行运行五份原生场景，最后单独启用 WebMCP 测试特性，要求实际注册调用成功及旧绑定拒绝，不能用不可用分支冒充正向通过。默认探测与明确开启的实验特性仍分开。该接线本身不表示三平台已经原生通过，也不替代普通 Chrome/Edge、完整 250 项、真实用户配置或 Host 验收。

实际 CI 进展：

- `e28c5ca1354bf2764116ca74852c2326c03c1828` / [43601526622](https://github.com/bYiyLi/NexumAgent/actions/runs/43601526622)：macOS Intel、Linux 各 25 项原生场景和 1 项开启 WebMCP 的正向场景通过。Windows 组件 132 项通过，但原生 25 项都未通过测试页初始化；没有当作业务能力已验收。
- `c07cb3316493cac851c3437faa81b91c80595b76` 改为前置检查确认真实页面出现后才执行后续场景，并保留 Windows 原生 Known Folder 环境。Windows 诊断明确显示受限进程无法读取程序；与[官方 Puppeteer 的问题说明](https://pptr.dev/next/troubleshooting#chrome-reports-sandbox-errors-on-windows)一致，后续只修复临时程序目录的读/执行权限。SDK 权限没有放宽。
- `f86f3557d4da0d384f9ce9431aa93e30f617436a` / [43603209579](https://github.com/bYiyLi/NexumAgent/actions/runs/43603209579)：三平台组件 134 项通过；Linux 原生前置 1 项、后续 24 项及正向 WebMCP 均通过。macOS Intel、Windows 各为前置 1 项通过、后续 24 项中 22 项通过，无跳过。macOS 后台标签的可视化/点击遇到断连，保留 UNKNOWN_RESULT；Windows 的两项为连续拖拽计数及运行期限早于输入准备结束。没有将未知动作重放。
- 同一版本修复了真实浏览器 WebSocket API 对 `close(1001/1002)` 抛异常的问题，改为合法应用私有码 4001/4002；Node 原生 WebSocket 与真实 loopback 服务验证协议拒绝、失联关闭。它属于组件回归，不能写成实际 Chrome 的正向原生验收；[WebSockets 标准](https://websockets.spec.whatwg.org/#dom-websocket-close)与本包连接设计分别拥有 API 约束和内部约定。
- 当前 `a821f5d350613c462d7b9e76c0ec99f3d4be8808` 只把事件类别、协议错误码/关闭码、浏览器身份和最多 8 个 operationId 经公共 host.log 保存。明确不保存拒绝消息、页面正文、headers 或凭据，并有实际拒绝回归验证。原生失败摘要最多附最近 20 条诊断。手势夹具分别等待两次真实 pointer 事件，且禁用测试面板无关的文本选择；超时夹具仍验证真实期限结束及不续接，允许先完成输入准备。

`a821f5d` 的[实际 CI 43604661413](https://github.com/bYiyLi/NexumAgent/actions/runs/43604661413) 已结束：三平台组件 135 项通过，Windows/Linux 的前置 1 项、后续 24 项和单独开启 WebMCP 的 1 项全通过；macOS Intel 后续 24 项仍有可视化与后台点击两项失败，均记录插件主动关闭码 4002，未重放未知动作。本机 macOS/arm64 的手势、可视化、后台跟随与取消/到期四项通过不替代该 macOS Intel 失败。

进一步用真实 loopback 服务与实际 MV3 连接代码，结合 Node 原生定时器控制复现：服务每 20 秒的主动 ping 缺少 connectionId/generation，插件严格校验后关闭。修复只让握手后心跳带当前连接身份；接收方继续拒绝未绑定消息。新增回归在修复前失败，修复后验证双向两轮心跳、原连接代次不变以及后续动作仅执行一次。完整本机组件目前 136 项通过。原生前置场景新增跨真实 21 秒等待后再次点击，并核对同一 boot/session/generation，不能用自动重连冒充原连接保持正常；三平台结果另记。

完整 250 项仍未完成；下载文件取回的限制也没有因为组件或局部原生检查通过而消失。

## 2026-11-14：心跳修复的三平台原生结果

安全候选 `0f7bcda5177da180d661451948266fb54e501e1b` 的 302 文件清单 SHA-256 为 `fa55d9307ee682b069a676226cff29354c720d6fbbabfd2bd22cd262ccf97edd`。[browser 43606056715](https://github.com/bYiyLi/NexumAgent/actions/runs/43606056715) 的 macOS Intel、Linux、Windows 全部通过：组件 136 项，原生前置 1 项（包含真实 21 秒心跳后原身份及后续点击）、后续 24 项，以及单独启用 WebMCP 的正向 1 项，均无跳过。macOS Intel 的后台点击及可视化两项原失败已通过，没有将目标强制切到前台，也没有重放未知动作。同 SHA 的 Core 和安装原生 CI 亦三平台通过。

macOS/arm64 的同源局部复验包含心跳/身份、后台跟随和可视化，3 项通过、0 跳过。一次新增夹具把去除 query 的公开发现 URL 与完整位置混用导致未找到标签，修正为使用公开发现地址后通过；未改产品 URL 脱敏规则。

在不登录、不使用现有浏览器 profile 的前提下，进一步实际打开 [Chromium 公开文档](https://issues.chromium.org/issues/376084060)提供的 Google Docs 文档。浏览与当前页面身份正常，但 `content.exportGsuite('docx')` 的页面数据请求报 FILE_UNAVAILABLE。只读诊断确认其导出先重定向到 googleusercontent；带 credentials 的页面 fetch 还遇到实际 CORS 限制。该公开站点检查不在上面的 25 场景中，保留为导出能力缺口；不以替身的 Google 格式/URL 检查冒充真实站点导出成功。

## 2026-11-14：真实 Google 导出修复与 Edge

当前修复改用原标签 frame 的 `Network.loadNetworkResource`，通过浏览器凭据取得实际响应，复用 PDF 的受管 `IO.read/close`。没有改页面 CORS 或浏览器安全开关，也没有把登录凭据搬到 Node。多段读取、错误 HTTP、取消后的迟到流、导航使原计划失效及原句柄关闭均有回归；本机完整组件 138 项通过、0 跳过。

macOS/arm64 的 CfT 160 实际导出上述公开文档，`tab.content.exportGsuite('docx')` 和 `tab.exportGsuite('docx')` 两入口均通过：每份 631327 bytes，独立解包后核对文档中的预期正文，实际 size/hash 与产物元数据一致。一次仅用于诊断的脚本返回了含 undefined 的字段，被平台结果验证拒绝；该脚本不计为导出通过证据，修正诊断输出后确认了浏览器原生资源接口取得 200/真实 ZIP 字节。

本机 Microsoft Edge `157.0.4341.46` 原生程序签名验证通过，程序 SHA-256 为 `7c5928668411376398c84280d3b3b3cd8bb13ead96bad2cd09ff7feba5aae38c`。仅通过全新临时 user-data-dir、临时 HOME、禁用同步/默认应用/组件更新及 mock keychain 执行，没有加载或修改用户现有 profile。当前同源结果：

- 五份现有原生场景：25/25 通过、0 跳过，包含真实 21 秒心跳、后台点击、PDF/HTML/Markdown、资产和文件输入。下载 path/saveDownload 仍只验证明确不可用，不计正向文件取回。
- 新增公开 Google Docs 场景：1/1 通过、0 跳过；两入口均导出 631327 bytes 的真实 DOCX，解包正文与实际 size/hash 均核对。没有打印文档正文、响应 headers 或签名重定向位置。
- Edge 仅按默认原生能力探测 WebMCP；本次未启用额外实验特性，不借 CfT 160 的正向注册结果声称所有 Edge 版本可用。

安全候选 `632826bbbd4a6d9ef85c348d4ab8bf488d986391` 已提交推送。303 文件清单 SHA-256 为 `0b37e7d2353f881a6bc22ab67224133f6fb00974c10bc92d2851b89c8e0b0038`。[三平台 browser CI 43607823836](https://github.com/bYiyLi/NexumAgent/actions/runs/43607823836) 已全部通过：组件 138 项、既有原生 25 项、单独开启 WebMCP 的正向 1 项，以及新增实际匿名 Google DOCX 场景。使用公开 URL 和独立预期文本，制品不包含文档内容；Core 与安装 CI 亦三平台通过。

## 2026-11-14：Google PDF / Markdown 实际格式扩验

实际公开文档的 PDF 为 245365 bytes，内容签名与 size/hash 验证通过；Markdown 最初被格式验证拒绝。进一步只读检查确认 Google 返回 `text/x-markdown; charset=utf-8`、26790 bytes 的真实 Markdown，而不是 ZIP 或登录 HTML。当前修复识别该同义 MIME，交付 `text/markdown`，仍拒绝 HTML 登录响应，不把其他二进制改 MIME 冒充文本。

`e74ec07ddbe98627c0a8169118a2ac4d3f4db865` 的本机完整组件 139 项通过、0 跳过。CfT 160 与 Edge 157 的实际公开站点场景均通过四次导出：两个入口的 DOCX、PDF、Markdown；每份产物实际 size/hash 均核对，DOCX 独立解包、Markdown 核对原文中的预期文本。PDF SHA-256 为 `7ed680a80edc00c9d4ef456257e003b7367d1c11aecb8512cb8d692196a232f0`，Markdown 为 `8c47ddf370f2dd1c378919ec7586e96136e6882e0ed398b328307c66cd64b7ab`；DOCX 每次的动态元数据可使 hash 不同，不要求两次字节相同。

303 文件清单 SHA-256 为 `12088389df9779de1a01b7fd1c1ed39d9f0eec842327ae613c046f2a7c2e757b`；[browser 43609081831](https://github.com/bYiyLi/NexumAgent/actions/runs/43609081831) 已三平台通过：组件各 139 项、原生前置 1 项与后续 24 项、正向 WebMCP 1 项及真实 Google Docs 三格式场景 1 项，均无跳过。同 SHA 安装原生 CI 三平台通过；Core 的 Windows 6 项观察问题由后续测试夹具修订另行复验，不将其隐藏为整套通过。

此前 Edge 25 场景属于 `632826b` 的冻结源码，后续修订只涉及 Markdown MIME、该格式回归和手册，不能把旧记录改写成新 SHA 的完整矩阵。`b0158fa` 之后只改 Core 测试观察，browser 生产/测试/手册文件及 105 份 Core 编译图仍与上述有效证据逐字节一致；没有为重复计数而重跑 browser。完整 250 项、其他 Google 文档类型、标准 Chrome 与更多平台/Host 矩阵仍需分别完成。

## 2026-11-15：核心复验与普通 Chrome 窗口定位

安全候选 `540d572bbaa98bbac3b5ea01243412d25616fec7` 的 [Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43613028278)及[原生安装](https://github.com/bYiyLi/NexumAgent/actions/runs/43613028252)均三平台通过。该修订仅调整实际 npm 安装子进程的就绪观察及失败清理，browser 生产/测试/手册和 105 份 Core 编译图未变；browser 继续引用上面的 `e74ec07` 原始证据，不计为新一轮浏览器执行。

本机普通 Google Chrome `157.0.8103.51` 另启动全新临时 profile、独立 HOME 和唯一测试页面，未使用用户现有配置。当前界面工具按应用绑定后只能选到用户原有窗口，其窗口菜单中未出现该独立实例；没有向原有窗口安装扩展、导航或更改配置，也没有修改普通 Chrome 对命令行加载扩展的限制。仅查看并关闭窗口菜单后，测试程序通过自有实例的关闭入口退出，并确认进程关闭。该尝试不计为普通 Chrome 插件安装或 SDK 验收通过，保留为窗口选择限制；不影响其他独立原生场景继续执行。

## 2026-11-15：交还、剪贴板便捷入口与页面切换等待

新增 CfT 160 原生交还场景通过：已就绪的下载等待器随 `markHandoff()` 结束，旧 Locator 与重新获取的 Tab 均不能在同一 Run 继续写入；同 Run 另一标签继续可写，下一 Run 使用新租约可以重新操作原标签。该场景覆盖 B037 的实际交还行为，不把它等同于整个 250 项矩阵完成。首次夹具误把再次交还当作幂等成功，实际公共运行层返回 `USER_TAKEOVER`；按既定“交还后旧控制失效”合同修正夹具，没有修改产品规则。

原生多 MIME 场景增加 B134 及 X067–X070：规范接口与便捷接口交叉读写文本、HTML 和 PNG，核对实际内容、类型及 ActionResult 身份；结束时仍在浏览器内部恢复原有剪贴板，不将原内容放入结果或日志。与交还场景一并在本机 CfT 160 通过 2/2。

实际打开 [YouTube 官方播放器示例](https://developers.google.com/youtube/iframe_api_reference)的视频 `M7lc1UVf-VE`，复现了文档切换使 `executeScript` 返回空数组、加载等待提前失败的问题。当前仅对 readiness 观察允许在浏览器明确仍有 loading/pendingUrl 时继续等，并在 pendingUrl 提交前不接受旧文档 ready；已稳定页面的空结果继续报错，动作不自动重试。两个新增回归在修复前均失败，修复后连同原有 DOM/load/networkidle 区分检查共 3/3 通过，包含等待取消；完整组件检查 141/141、0 跳过。

修复后的实际 YouTube 页面加载及播放器身份可观察：原视频 ID 一致、playability 为 OK、存在 2 条字幕轨道。但两个字幕导出入口均取得空字幕响应并准确报 `FILE_UNAVAILABLE`，没有得到真实字幕文件；不把诊断程序成功退出计为字幕导出验收通过，也未登录、绕过站点验证或改写字幕内容。真实 YouTube 字幕正向交付仍缺证据。

安全候选 `cbdad9a4ef728b7474363b51b40892f596c1181a` 包含本轮三个产品文件的修改；304 文件清单 SHA-256 为 `b75babc4f66ed965d9b94d2b03a2b5f25503d6159b4b24dfea3e356f84e89429`。本机 Edge `157.0.4341.46` 的现有原生场景 26/26 通过、0 跳过，程序签名及原二进制 SHA-256 再核对一致。[三平台 browser 43615554438](https://github.com/bYiyLi/NexumAgent/actions/runs/43615554438)和[安装 43615554424](https://github.com/bYiyLi/NexumAgent/actions/runs/43615554424)已通过；Core 同 SHA 的新失败另查，不记为整套共同通过。原始下载文件身份、普通 Chrome 安装、其他平台原生用户取消、真实 Host 及完整逐项矩阵的缺口继续保留。

## 2026-11-15：macOS 原生调试取消

在独立 macOS/arm64 CfT 160 有界测试中，实际打开原生调试信息栏并点击“取消”；没有用 `chrome.debugger.detach`、伪造事件或脚本模拟用户操作。实际页面唯一标题、回环地址和合成运行 ID 在点击前核对。公共 SDK 原下载等待器与旧 Locator 后续写入均返回 `USER_TAKEOVER`，原运行处理错误后正常结束；新的独立 Run 读取页面，确认仍为取消前内容，没有发生被禁止的写入。随后测试夹具关闭自己的浏览器及 profile，未关闭用户现有浏览器。

仓库内可复用场景为 `packages/browser/test/native-user-stop.acceptance.mjs`；本次执行的测试文件 SHA-256 为 `db459980855ba99e0acef76867565341ee19256359b345eddbebf1495419840d`，1/1 通过、0 跳过。它要求显式 headful 模式并点击真实浏览器按钮，当时不纳入无人操作的 26 场景 CI，也不把 UI 未执行算成通过；使用的生产与 Core 源码分别匹配 `cbdad9a` 清单与既有 105 份 Core 编译图。本证据覆盖 X055 的 macOS 实际路径；测试文件后来增加了可选的自动化就绪通知，新文件及 Linux 复验另记。

后续 `1014763` 仅修改通用空间统计和相应测试：当原生维护目录在检查后消失，只对真实 `ENOENT` 跳过，其他权限/路径错误继续失败。browser 参与 CI 的生产、测试和手册保持 `cbdad9a`，上述独立手工场景按自己的 SHA 单独记录；Core 的 105 份编译图已改为 `48f9fdda3c5ba54f45583c26e727728fbb9f708a4062b720427b10960e6c97d1`。新图已通过 6 项真实 Cloud/PG/官方 SDK Host 联合 race 检查，不把旧 Core 图或浏览器手工检查改写为新执行。其余详细结果由主仓 Phase 48 §5.9 记录。

## 2026-11-15：真实字幕、隐藏角色、输入前等待和重定向

实际 YouTube 已显示字幕时，当前页面使用 `transcript-segment-view-model`，原实现只识别旧版 `ytd-transcript-segment-renderer`。现支持两种实际布局，只读取一份时间戳与字幕正文，并在读取 DOM 前核对已知播放器身份；旧 SPA 初始响应不能覆盖实际播放器，已知不一致也不能被旧字幕 DOM 掩盖。两个新增字幕回归在旧代码均失败，修复后通过，原有字幕轨道及格式限制保留。

同一页面还暴露隐藏排版按钮被角色查询选中：原生 AX 实际只有一个按钮，旧 `getByRole` 却返回六个候选。修复排除 CSS 隐藏、`aria-hidden` 和 `inert` 子树，保留显式 CSS 观察、可见子节点和无布局盒角色；实际原生回归由失败变为通过，不宣称完整 ARIA 算法已经验收。

滚动后按钮有可见矩形，命中测试却暂时返回页面根元素，页面稳定后同一点恢复命中。现只在输入前、有界期限内重新观察目标及祖先 frame，不重放已派发输入。原生场景确认：遮挡移除后只有一次 `isTrusted` 点击；持续遮挡为 `TIMEOUT` 且无额外点击；确认待点击操作已开始后取消 Run，移除遮挡也没有迟到输入。旧持续 frame 遮挡断言同步为等待期限内的 `TIMEOUT`，仍检查零输入与全部句柄释放；另验证祖先遮挡消失后只点击一次。

Edge 另暴露导航等待错误：站点正常重定向后虽已加载，`tab.navigate` 仍等待输入地址而超时。新增本地真实 HTTP 302 场景在旧代码失败，修复后 commit、DOMContentLoaded、load 均通过且各请求仅一次，显式 `waitForURL` 的不同地址继续超时；这里只调整本次导航等待，不重发导航。

最终安全候选为 `f94bbad67cf0bf7a9a30e56c64a2a019641e7a92`，已提交推送。305 份源码逐个核对本地与 CI 副本一致，清单 SHA-256 为 `29f37c4c82ac1aa80b77551be622fed8b0447b269b4bba9d29bcc83baad5d1ea`。本机完整 browser 组件 144/144、协议契约 320/320；Core 完整检查 1391 项、1364 通过、27 平台专属跳过，无失败/取消。本机 macOS/arm64 同源完整原生场景：CfT 160 为 29/29、114.27 秒，Edge 157.0.4341.46 为 29/29、126.14 秒，均无跳过。Edge 原生签名及二进制 SHA-256 `7c5928668411376398c84280d3b3b3cd8bb13ead96bad2cd09ff7feba5aae38c` 再核对一致。

该 SHA 的 [browser CI 43624042438](https://github.com/bYiyLi/NexumAgent/actions/runs/43624042438)已三平台全部通过，逐 Job 日志确认：

| 环境        | 组件    | 独立原生场景     | 实验 WebMCP | 实际 Google 三格式 | 实际 YouTube |
| ----------- | ------- | ---------------- | ----------- | ------------------ | ------------ |
| macOS Intel | 144/144 | 前置 1 + 后续 28 | 1/1         | 1/1                | 1/1          |
| Windows     | 144/144 | 前置 1 + 后续 28 | 1/1         | 1/1                | 1/1          |
| Linux       | 144/144 | 前置 1 + 后续 28 | 1/1         | 1/1                | 1/1          |

上述 browser 检查均无失败/取消/跳过。默认配置的 WebMCP 场景仍准确说明页面没有 `document.modelContext`；正向注册、调用和失效验证由显式启用实验能力的独立场景完成，不将负例冒充正向。

`packages/browser/test/native-youtube.acceptance.mjs` 在实际页面点击打开字幕，并核对实际 watch 文档身份、URL 和已知播放器 ID。三平台 CI 及本机 Edge 的两个 SDK 入口都取得 189 段、22,105 字节的真实文件，逐字节等于该次页面实际字幕，SHA-256 同为 `0705b24a45fb6e25959c56c8515ea08ecd1645a8e03a5c07d98b10d0f21456be`。未登录、复制 Cookie、绕过验证或生成替代字幕；日志仅保留来源、段数、大小、hash 及有界失败诊断，不保存正文和签名字幕 URL。

前候选 `8c4ffb9` 的三平台 browser 已通过组件、28 项原生场景、WebMCP 和 Google 三格式，但最后 YouTube 测试只从可选播放器方法取 ID，得到 `null` 而失败。该失败保留在 [43622716495](https://github.com/bYiyLi/NexumAgent/actions/runs/43622716495)；修订按实际 `ytd-watch-flexy[video-id]` 校验，没有用输入值替代观察值，也没有直接跳过校验。

同轮旧安装 Windows 在第四次调用返回 `authorization_expired`；原日志没有足够时间采样，不能确定为过期还是超过协议租期上限。此次仅将合成 Cloud 夹具的普通租期由上限 30 秒改为上限以内 20 秒，给独立进程的时间观察留余量，补发送、到期、接收和等待时长诊断；生产授权校验未改。新 [安装 43624042380](https://github.com/bYiyLi/NexumAgent/actions/runs/43624042380)已三平台通过：实际安装后 CLI 两次真实 boot、SDK/后台子进程随服务停止、历史读取且不重放、服务/进程清理全部确认。当前通过不改写旧失败的确定原因。

新 [Core 43624042416](https://github.com/bYiyLi/NexumAgent/actions/runs/43624042416)亦三平台通过：macOS/Linux 各 1391 项、1364 通过、27 平台跳过，Windows 1393 项、1360 通过、33 平台跳过，均无失败/取消。105 份 Core 编译文件仍逐字节匹配已通过真实 Cloud/PG 的图 `48f9fdda3c5ba54f45583c26e727728fbb9f708a4062b720427b10960e6c97d1`；本轮不重复计算该联合链路。

完整 250 项逐成员矩阵、原始下载 GUID 与本机文件的可靠身份绑定、普通 Chrome 安装、更多 Edge 平台、其他平台原生用户取消、其他 Google 文档类型与真实用户 Host 接入仍未全部闭合。安全 CI 分支的提交推送不等于主开发分支最终提交、npm 发布或生产部署，状态继续为 `in_progress`。

## 2026-11-15：指定点击位置与缩放 frame

继续逐项检查 B100/B102 的 `position` 和 Tab 点击别名，实际 CfT 复现两个缺陷：中心未遮挡却在指定角落点击了覆盖层；跨站点、双层非等比缩放 frame 内请求 `(24,18)`，实际事件相对坐标为 `(19,13)`。旧实现只检查中心，再于顶层重加未经缩放的偏移。两项原生回归在旧代码均失败；当前让当前元素命中检查、每层祖先检查和最终输入共用实际点，命中和映射规则由 [页面交互合同](../browser/interaction.md)拥有。

修复后的两项原生场景通过，验证指定点遮挡时零点击、中心遮挡而指定点可用时单击/双击及 `tab.click(ref,…)` 均正常、右/下边缘及负坐标拒绝、实际双层 frame 的事件坐标正确。另一个祖先仅在指定点遮挡的组件回归，在 `f94bbad` 源码上因未拒绝而失败，修复后为 `TIMEOUT` 且零原生输入、所有 frame 句柄释放。未放开 force 或绕过命中检查。

本机完整 browser 检查 145/145、0 跳过；Agent 完整检查 1391 项、1364 通过、27 平台专属跳过，无失败/取消。最终本机 macOS/arm64 原生矩阵为 CfT 160 的 31/31、119.75 秒，Edge 157 的 31/31、132.06 秒，均无跳过。安全候选 `9ef4b7065514bb5ab42ae84a4a760e895eb0fc60` 已提交推送，305 文件清单 SHA-256 为 `e27931fb0909ebee933fa6f2309689ea2567f62d1338c56124f013b0db572e32`；[browser 43626121517](https://github.com/bYiyLi/NexumAgent/actions/runs/43626121517)、[Core 43626121483](https://github.com/bYiyLi/NexumAgent/actions/runs/43626121483)及[安装 43626121496](https://github.com/bYiyLi/NexumAgent/actions/runs/43626121496)均已三平台全部通过。browser 的逐 Job 日志确认组件 145、原生前置 1 与后续 30、实验 WebMCP 1、实际 Google Docs 三格式 1 及实际 YouTube 1 全部通过，无跳过；两个指定位置原生回归也分别三平台通过。

## 2026-11-15：实际 Google Sheets 与 Slides 导出

新增 `packages/browser/test/native-workspace.acceptance.mjs`，使用 [Google Sheets 官方 quickstart](https://developers.google.com/workspace/sheets/api/quickstart/js)的公开表格及 [BlinkOn 6 官方材料](https://developers.google.com/web/shows/blinkon/6/blinkon-6-day-2-talk-1-headless-chrome?hl=en)链接的公开演示文稿，不使用账号、私有 Cookie 或 API Key。现有生产实现未改：验证 Sheets 的两入口 XLSX、CSV、PDF，以及 Slides 的两入口 PPTX、PDF。

每份实际产物独立读取并核对 size/hash/MIME；Office 文件通过原生归档程序解包，在真实内容中查找独立指定的样例文本，PDF 检查原生文件头，CSV 核对实际内容。PPTX 枚举有界的真实 slide XML，不要求预期标题恰好位于 ZIP 中的第一页；初次仓库夹具的该假设失败已保留。Office 的动态元数据可能使两次导出的字节及 hash 不同，不以相等替代内容验证。

Edge 首轮 Slides 在来源观察阶段返回 `STALE_REF`，没有产物通过。实际观察确认编辑器初始化会写入当前 slide 的 query/hash；用例现等待 load 及已观察到的首张幻灯片可见，再读取最终地址并导出。生产来源校验保持不变，不捕获错误后盲重发导出。最终仓库用例在 macOS/arm64 的 CfT 160 与 Edge 157 分别 2/2 通过、0 跳过，耗时 26.13 / 26.15 秒。

本轮实际 CSV 为 1,408 字节，SHA-256 `c9ce73edd7052aaa8bbf7efb9eb0e10967c4670e725fdd79aedafb87c25e06e6`；表格 PDF 为 53,269 字节，演示 PDF 为 974,138 字节；实际 PPTX 约 2.47 MB。正文、签名重定向 URL 和响应头不进入日志。候选 `9d92b28ea83b27bdb1986e22bbf26030ad951e6f` 已提交推送，306 文件清单 SHA-256 为 `1b71a1eace53aad5b42431abecb51968799a3b648bdc033e177e5184196c086e`。该修订只增加场景和 CI 步骤，原有 305 份生产/测试源码保持上一候选字节不变。

[Core 43627894221](https://github.com/bYiyLi/NexumAgent/actions/runs/43627894221)和[安装 43627894240](https://github.com/bYiyLi/NexumAgent/actions/runs/43627894240)已三平台通过；[browser 43627894245](https://github.com/bYiyLi/NexumAgent/actions/runs/43627894245)仅 macOS Intel 整套通过。Windows 与 Linux 的组件、31 项原生场景、实验 WebMCP、Docs、YouTube 及新增 Slides 均通过，新增 Sheets 失败：Windows 返回无原生 stream 的 `FILE_UNAVAILABLE`，原诊断没有保留 HTTP/网络分类及具体格式；Linux 的导出到达 60 秒期限后保持 `cancelling`，原记录没有操作明细。macOS 实际 Sheets 四次导出均通过，耗时 63.55 秒；不将本机或 macOS 通过改写为全部平台通过，也尚不能判定原始网络失败的具体原因。

## 2026-11-15：长原生网络请求的运行收尾

以独立 CfT profile 和自有回环 HTTP 服务复现：服务收到实际 `Network.loadNetworkResource` 请求后不返回响应，公共 SDK Run 取消和到期均停在 `cancelling / cleanup unconfirmed`。测试在断言后才释放自己的响应，原生回归两项均失败。另一个诊断仅在已核对固定扩展 ID 的自有 worker 中调用真实 `chrome.debugger.detach`，观察到服务端连接关闭、原等待拒绝及 Run 终态；这个诊断不计为未修改 SDK 的取消验收或用户点击原生取消。

当前仅对正在派发原生资源加载的目标，在等待该原生 Promise 前执行既有按键/按钮/视口/流清理及调试器分离；目标归属仍保留到实际待办和全部清理完成，用户标签保持打开。运行结束和显式 handoff 共用该路径。组件回归确认分离前已释放输入、分离未完成时新 Run 不能抢占、其他 Run 的标签未被分离且没有伪造用户接管。HTTP 失败诊断只增加有界状态码和 `net::ERR_*` 分类，排除 URL、响应头及正文；真实导出用例另记录实际阶段/格式/入口，超期断言保留操作明细，不增加隐式重试。

本机当前 browser 类型/构建及组件检查 149/149、0 跳过；公共 SDK 原生取消/到期回归 3/3（含父项）通过，确认服务未完成前连接已关闭、Shift 原生 keyup 到达以及下一 Run 可重新使用原页面。完整原生 CfT 160 为 34/34、143.68 秒，Edge 157 为 34/34、138.89 秒，均无跳过；真实 Sheets / Slides 分别为 2/2，耗时 27.67 / 28.77 秒。Agent 完整检查 1391 项、1364 通过、27 平台跳过，无失败/取消。实际 105 份 Core 编译文件仍逐字节匹配已经通过真实 Cloud/PG 联合验收的图，不重复执行未变的联合链路。

另一个仅使用公共 SDK 的自有服务诊断先发送真实响应头和部分正文，再保留未完成响应；当前运行取消仍在服务返回剩余正文前关闭连接并完成终态，1/1 通过，不扩大为所有 CDP 命令的强制中止保证。

候选 `90e820cd31c3b276df155e889431f9ca71b34ff4` 已在安全 CI 分支提交推送；306 份文件逐个与本地核对一致，清单 SHA-256 为 `c12b454b3470736a1cb682163d79b92be5bc2ddd3430c1e78d775ac823cdabea`。[browser 43630551361](https://github.com/bYiyLi/NexumAgent/actions/runs/43630551361)、[Core 43630551362](https://github.com/bYiyLi/NexumAgent/actions/runs/43630551362)及[安装 43630551450](https://github.com/bYiyLi/NexumAgent/actions/runs/43630551450)已三平台全部通过。

browser 逐 Job 日志确认每个平台均为组件 149、原生前置 1 与后续 33（包含取消/到期父项）、实验 WebMCP 1、实际 Docs 1、YouTube 1、Sheets/Slides 2 全部通过，0 失败/取消/跳过。Windows、Linux、macOS Intel 新增原生停止场景均实际关闭自有服务连接、释放按键并重新获取原页面；Sheets 各次导出亦均有真实产物校验。旧 `9d92b28` 的具体网络失败本轮未再次出现，没有诊断足以将其归因为某一 HTTP/网络错误；保留原失败和新诊断，不因本轮通过宣称原始原因已经查明。主开发分支增量尚未完成 Phase 最终提交，原始下载、完整逐成员矩阵及真实用户 Host 等缺口继续保留。

## 2026-11-15：组织审计、游标与成员用例映射

逐项检查 X016–X036 / X102 时发现：原组织审计的 `before` 固定为空，关闭/移除没有目标 ID，失败、取消及迟到结果会漏记；默认分页从最旧记录开始，读取时未清理过期项，普通数字游标能被另一份历史误用。原生组织场景在旧代码因缺失 before 失败；跨实例游标组件回归在原数字游标版本未拒绝，修复后明确 `STALE_REF`。

当前读取真实窗口几何、标签原位置/固定/静音/分组、组和书签元数据；URL 脱敏及未知/失败/确认规则由 [SDK 合同](../browser/sdk.md)拥有。原生派发时先记 unknown，实际返回后更新同一记录；未确认或变更前已取消不伪造成功，迟到原生成功与 Run 取消分别记录。上层在进入浏览器前拒绝的调用保留平台 operation 历史，不补造浏览器审计。新的实际场景交叉使用规范和便捷入口，独立核对原状态、删除 ID、最新分页及实际窗口尺寸。

最初静态检查曾将窗口/组的成员检查判断为缺失；真实旧候选 `90e820c` 复验表明，上层运行范围锁已拒绝两个跨 Run 修改，颜色和宽度均未变化。初次夹具错误要求浏览器审计出现两条失败，已改为检查实际 Core operation 的两条失败；旧机制对照和当前原生场景均通过，不新增重复锁或修改 Core 权限。

审计按原有 1000 条 / 7 天 / 10 MiB 边界保留，读取也处理到期；游标绑定实例。使用实际 router 与合成 Chrome 的预算基准：1000 条小记录后加入接近 10 MiB 的 before，旧重复序列化路径耗时 6054.63 ms；按条维护精确字节计量后为 27.20 ms，均保留 74 条并报告截断。该数值属于组件基准，不是原生浏览器吞吐量。另验证取消或准备阶段超过实际 action budget 时不派发原生变更。

`implementation.json` 已将 22 个成员关联到正常/结果场景，其中 X019 / X028 另关联现有范围冲突场景；`coverage` 标明用例范围。250 个 `nativeAcceptance` 仍为完整矩阵未完成状态，不以这些关联代替全部错误路径、浏览器或平台验收。

本轮中间版本 CfT 全量 35 项通过，Edge 为 33 通过、2 失败（到期子项及父项）：Run 已普通失败，stop 为 null，原断言未保留原异常，原因不能确定。补充原始 Run/operations 诊断后的聚焦复验通过；到期夹具仅在 SDK `TIMEOUT` 时用 Node 原生计时器短暂保持脚本活跃，仍要求真实 Run deadline、原请求连接关闭和按键释放，其他错误仍失败。原失败保留，不以新通过宣称旧原因已查明。

最终本机组件检查 153/153、0 跳过；Agent 完整检查 1391 项、1364 通过、27 平台跳过，无失败/取消。105 份实际 Core 编译图仍匹配既有真实 Cloud/PG 联合验收，不重跑未变的联合链路。最终 CfT 全量 35/35 通过，Edge 为 34 通过、1 失败：跨实际心跳后的第二次 Run，其 6 个 operation 已成功，Run 却未完成清理，60 秒到期后仍 `cancelling`，保留一个 browser 的两个目标未确认；原诊断没有插件内清理事实，原因未知。stderr 中更新器消息不是原因证据。

安全候选 `7d4ca06292f62ee6c62b804245fd5263672d0bfa` 已提交推送；306 文件逐个与主工作树核对一致，清单 SHA-256 为 `be96ec62e3d22865197e627b2820858ef2389aeb731a6d81960002fe1f17c333`。[Core 43638041726](https://github.com/bYiyLi/NexumAgent/actions/runs/43638041726)和[安装 43638041839](https://github.com/bYiyLi/NexumAgent/actions/runs/43638041839)三平台通过；[browser 43638041853](https://github.com/bYiyLi/NexumAgent/actions/runs/43638041853)仅 Windows 全部通过。Linux 的取消子项在 Run 已结束时尚未观察到服务端连接 close，后续 deadline 通过；macOS Intel 的缩放 frame 原生点击为 `(24,15)`，未满足请求 `(24,18)` 的 1px 边界。三平台组件各 153/153 通过，不将此计为原生全通过。

针对这些已出现的失败，当前候选仅调整原生夹具：保持服务端响应不发送，有界等待实际 peer close 并记录相对 Run 终态的时间；清理超时则只读检查本夹具准确身份的 MV3 worker，保留连接诊断及控制日志计数，不读取用户配置、按键值或剪贴板；frame 场景保留真实事件与父 frame 几何。断言边界及产品代码未放宽。Edge 聚焦取消/到期、心跳和 frame 共 5 项通过，但不据此宣称上述失败原因已查明；新候选完整验证及跨平台终态另记。Phase 及完整逐项矩阵继续 `in_progress`。

本轮首次 Agent 全量检查有 1 个资源游标负例失败（1363 通过、27 平台跳过）：测试改写末尾 Base64 字符，可能没有改变鉴权后的字节。独立实际 ResourceManager/SQLite 游标实验确认同一份 94 字节密文可以有不同末尾编码，原断言会把合法相同字节误报为篡改。改为翻转实际鉴权 tag 中一位，确保测的是真实变更；未修改产品游标或权限逻辑。资源 21/21 通过，最终 Agent 全量 1391 项中 1364 通过、27 平台跳过；browser 组件 153/153、CfT 聚焦原生 5/5 通过。306 文件新清单 SHA-256 为 `89f05eaeb40c61834868a19e0c6bbb909fcdab9cf3463f1d74059b99061846ef`；这次四个源文件变更均为测试/诊断，原 Core 和插件产品源码未改，前述实际联合图保持不变。

## 2026-11-15：多配置隔离、frame 绘制与原生退出事实

上述诊断候选为已提交推送的 `1f8b37733381e6807abf9eb6ee61a6dc343725ca`。[Core 43640702747](https://github.com/bYiyLi/NexumAgent/actions/runs/43640702747)和[安装 43640702768](https://github.com/bYiyLi/NexumAgent/actions/runs/43640702768)三平台通过。[browser 43640702729](https://github.com/bYiyLi/NexumAgent/actions/runs/43640702729)仍仅 Windows 全部通过；Linux 原生前置 1、后续 34、实验 WebMCP 和 Docs 通过，YouTube 到达后没有预期 videoId，旧断言未输出实际目标页面，原因未知，Sheets/Slides 未执行。取消/到期的实际服务端连接 close 均已记录，但不能据此认定前次失败仅为通知时序。macOS Intel 再次在同一 frame 场景落到 `(24,15)`；其余 33 个后续原生用例通过。

两个独立本机浏览器配置的实际用例已经加入：A 等待时 B 可操作，A 的冲突仍拒绝，取消 A 后两端值分别保留，默认/URL 选择及关闭 B 后 A 的身份不变。CfT 和 Edge 各 1 项通过；浏览器本次分配的 tabId 不同，不宣称相同 tabId 的原生场景已完成。8 个公开成员另关联该场景，已有用例关联累计 30 个成员；250 项完整验收状态继续未完成。增加这些用例的固定工作树在绘制修复前，CfT / Edge 全量原生各 36/36、本机实际 YouTube 两入口 1/1 通过，结果仍为 189 段、22105 字节，SHA-256 与原记录一致；此整套结果不自动移作后续插件修改的验收。

frame 新候选针对可见祖先滚动后的原生输入时机：在重新读取最终坐标前等待实际动画帧，单次等待有界，未就绪只继续观察，不重发点击；后台文档保持原有输入路径。组件新增等待期间无输入、后台不依赖暂停的 rAF、绘制未就绪时超时且无残留回调/句柄，11 项 frame 组件通过。macOS Intel 的实际根因仍待新候选原生验证，不因组件通过就宣告修复完成。

另确认本机早期聚焦命令可能加载旧生成插件：两次 frame 聚焦结果不计新绘制修复验收。原生夹具现对实际物化的全部 JS（生成 profile.js 除外）逐个与包内源码核对；不一致在启动浏览器前失败。重建并核对后，browser 组件 156/156，CfT / Edge 相关 frame、取消/到期、心跳与双配置原生各 7/7、无跳过通过。

最终一次 Agent 检查曾挂在实际 npm 子进程：macOS 原生采样显示主线程在 `NodePlatform::Shutdown` / `uv_thread_join`，V8 Maglev 编译线程在等待 GC；npm 日志写出 exit 0 并不代表物理退出。保存原始采样后，只强停该夹具确认身份的独立进程组，让实际检查按 `npm_command_failed` 失败结束；1391 项中 1363 通过、1 失败、27 平台跳过，476.45 秒，此次不能计通过。未修改 Node 版本、引擎开关或生产终态逻辑。npm 配额夹具改用 Node 原生 120 秒测试期限、`t.signal` 与已有取消/资源关闭机制，失败不再无限等待；新完整检查终态另记。105 份 Core 编译文件仍逐字节匹配既有真实联合图。

2026-11-15 再次核对该次本机原始采样（SHA-256 `57e23bce5780d8e0cbbae8732566bcb1320f8ed60a743dd0b4ffe9d61a979c6b`）：主线程经 `Environment::Exit`、`DefaultProcessExitHandlerInternal` 进入平台线程 join，V8 后台 Maglev 编译线程停在 `CollectionBarrier::AwaitCollectionBackground`。这些栈帧与 [Node 上游退出挂起问题 #64274](https://github.com/nodejs/node/issues/64274) 中 macOS/arm64、Node 24 的报告高度相似；其[修复提案 #66171](https://github.com/nodejs/node/pull/66171)在本次核对时仍未合并。这是有依据的相关线索，不证明两次事件根因完全相同，也不能据此解释此前 Windows 等待超时；不据此更改引擎开关或把日志中的退出信息当成进程已关闭。

随后在 [GitHub 隔离诊断](https://github.com/bYiyLi/NexumAgent/actions/runs/43692222596)中使用 Node 24.22.1、人工并发分配压力和独立合成进程对照退出方式：macOS 15/arm64 的 3 次主动 `process.exit(0)` 均超过 8 秒观察期限，由测试父进程对其自有子进程发送 SIGTERM 并确认关闭；3 次设置退出码后自然结束均正常退出。Linux/x64 的两组各 3 次均正常退出。该测试为人为构造的 Node 运行时压力场景，没有运行 npm，也没有采集上述新挂起进程的堆栈；它证明了当前固定版本在该 macOS 场景可以复现退出不结束，不能单独证明原 npm 现场的唯一根因或估计正常使用的发生率。产品引擎参数和终态判断未因此更改。

在[另一轮同平台合成对照](https://github.com/bYiyLi/NexumAgent/actions/runs/43692394981)中，添加 `--single-threaded` 的 3 次主动退出均正常；仅关闭并发重编译与 Sparkplug 的 3 次均超过 8 秒，测试父进程只终止并确认关闭自己的子进程。该诊断本身启用了 `--stress-concurrent-allocation`，故不能据此推断普通工作负载下各参数的效果，也没有验证 npm 功能、性能或其他平台。当前不将这些诊断参数加入产品。

随后只在独立 CI 试验分支的 macOS/arm64、Node 24.22.1 上，将该参数限于维护子进程并执行真实 npm 安装、升级、卸载、扩展启停与取消收尾：[首轮](https://github.com/bYiyLi/NexumAgent/actions/runs/43692951001) 7/7 通过，记录 119 次维护子进程启动；[同机先后对照](https://github.com/bYiyLi/NexumAgent/actions/runs/43693388390)中，原实现 6/6 用时 17.54 秒，试验实现 7/7 用时 21.77 秒，额外一项核对启动参数。试验夹具确认合成包的安装脚本未继承该参数。单次测试耗时不能代表一般 npm 性能，且两轮均未复现原本的实际 npm 退出挂起；这只证明所测功能兼容，尚未证明对真实故障有效。试验参数没有进入主工作树。

最终默认 Node 24.22.1、未修改引擎开关的 Agent 完整检查为 1391 项中 1364 通过、27 平台跳过，106.98 秒；四个配额场景及其资源关闭正常通过。该次通过不代表之前的 V8 退出挂起已经修复。最终 306 文件清单 SHA-256 为 `66b4cda344e43d533f3dccf52b5fcd88f39934e099dc2d3dfc7058c68287a7c8`，逐个与安全 CI 工作树核对一致；实际 Core 编译图仍为 `48f9fdda3c5ba54f45583c26e727728fbb9f708a4062b720427b10960e6c97d1`。

随后在 macOS/arm64 的 [Node 24.22.1 全量 Core 检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43693654861)中，1392 项有 1364 通过、1 失败和 27 个平台跳过；失败场景的空 EOF 返回 `ERR_STREAM_DESTROYED`。该日志不能证明当时进程已经退出，也不能证明与前述 Node/V8 退出挂起有关。[受控回归](https://github.com/bYiyLi/NexumAgent/actions/runs/43694147297)在真实 npm 维护子进程的 EOF 调用后注入同类错误，旧实现拒绝了准备操作；它验证错误处理路径，不冒充自然触发的操作系统竞态。

修复复用受管进程已有的空 EOF 关闭判断，仅在未发现后端故障且错误属于已关闭输入时继续等待，并保持实际进程树、输出和成功退出检查；未知 I/O 错误与取消仍失败。[聚焦验证](https://github.com/bYiyLi/NexumAgent/actions/runs/43694265246)在 macOS/arm64 通过，覆盖确认关闭、未知错误与取消；完整跨平台结果另记。

`f55a378` 的[跨平台 Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43694429036)中，Linux 通过；Windows 新回归的 30ms 清理观察未确认实际关闭，macOS Intel 的 33 MiB npm 规划用例在 120 秒超时。测试调整只在注入未知错误或取消前先等待真实进程关闭，正常分支仍由产品代码等待；[Windows 聚焦验证](https://github.com/bYiyLi/NexumAgent/actions/runs/43695546998)通过。`5a1880f` 的[完整 Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43695765617)三平台通过：Windows 1395 项中 1361 通过、34 跳过；Linux/macOS Intel 各 1393 项中 1366 通过、27 跳过，均无失败或取消。[Intel 单项诊断](https://github.com/bYiyLi/NexumAgent/actions/runs/43695285702)中的大规划用例 3.73 秒通过，因未达到采样时间而没有生成堆栈；先前超时原因仍未知。

安全候选 `6fa99b9493ab94acb1bf9b83e00f1af9fc36cce5` 已提交推送。[Core 43643916587](https://github.com/bYiyLi/NexumAgent/actions/runs/43643916587)、[安装 43643916615](https://github.com/bYiyLi/NexumAgent/actions/runs/43643916615)及[browser 43643916595](https://github.com/bYiyLi/NexumAgent/actions/runs/43643916595)均三平台全部通过。已逐个核对三份 browser Job 原始日志：组件各 156、原生前置 1 与后续 35、实验 WebMCP 1、真实 Docs 1、YouTube 1、Sheets/Slides 2 均通过，无失败/取消/跳过；两份配置均实际在线、各自控制和下线身份验证通过，各平台分配的 tabId 仍不同。macOS Intel 的 frame 本次为 `(24,17)`，满足请求 `(24,18)` 的 1px 边界，原祖先 scrollY 4 的实际几何仍保留；Linux/Windows 为 `(24,18)`。此前 Edge 心跳清理停滞及 YouTube 到达失败的原始原因仍未查明，不能由本轮通过抹去。Phase 与 250 项完整逐项状态继续 `in_progress`；本安全分支提交不等于主开发分支的最终提交、正式发布或生产部署。

### 截图物理像素上限与 Edge 收尾复核（2026-11-15）

本轮先在真实 Chrome for Testing 160.0.8160.0 复现：`maxEdgePx:120` 在 DPR 2 时生成 `240×180` JPEG，在 DPR 1.25 时最长边为 150，原缩放和解码像素预检漏算了原生像素密度。修复使用插件隔离世界读取原生比例；`clip` 仍为 CSS 坐标，最长边和 4000 万像素预算按实际图片计算，不放大小图。页面 MAIN 世界伪造 `devicePixelRatio=99` 不改变计算。新增组件验证缩放、分数/较低密度、超像素预算在截图前拒绝及无效原生比例；新增原生用例用浏览器自身解码 JPEG，核对 DPR 1、2、1.25 下的视口、整页、裁剪共 9 份图片及 quality 0/100。

安全候选 `00381860270908535d411db40caffb14c69b920e` 已提交推送。306 份公开产品源码清单 SHA-256 为 `25c71a715fa38440557b682283a2abc5419f6f13251d2c109bc0128b2ff01d39`，已逐份与安全 CI 工作树核对。以下证据固定在该候选：

- 本机默认 Node 24.22.1 的 `pnpm check`：1391 项中 1364 通过、27 平台跳过，108.65 秒；`pnpm --dir packages/browser check`：158/158；候选包实际 pack 检查 2/2。105 份 Core 编译文件继续匹配既有真实联合图，不把 browser 修改算作重做了 Cloud 联合验收。
- macOS/arm64 的实际 Chrome for Testing 选定原生组 36/36、131.50 秒；实际 Edge 157.0.4341.46 为 35/36、210.33 秒。命令为设置 `NEXUM_BROWSER_NATIVE_BINARY` 后运行 `node --experimental-vm-modules --test --test-concurrency=1 --test-skip-pattern="native WebMCP" packages/browser/test/native.acceptance.mjs packages/browser/test/native-actions.acceptance.mjs packages/browser/test/native-capabilities.acceptance.mjs packages/browser/test/native-client.acceptance.mjs packages/browser/test/native-visual.acceptance.mjs`。此本机组未选择 WebMCP 专项，不以它替代实验注册验证。
- [Core 43648347292](https://github.com/bYiyLi/NexumAgent/actions/runs/43648347292)、[安装 43648347297](https://github.com/bYiyLi/NexumAgent/actions/runs/43648347297)、[browser 43648347335](https://github.com/bYiyLi/NexumAgent/actions/runs/43648347335)均三平台通过。已读取 Linux、Windows、macOS Intel 各自原始 browser 日志：组件 158、原生前置 1 与后续 36、实验 WebMCP 1、真实 Docs 1、YouTube 1、Sheets/Slides 2 均通过，无失败、取消或跳过；三平台分别返回 9 份解码尺寸，最长边均符合限制。

Edge 的失败再次出现在 metadata/21 秒心跳后的第二次 Run：6 个业务 operation 在约 5 秒内全部 `succeeded`，运行到 60 秒期限后仍为 `cancelling`，本地资源保持 `unconfirmed`，未收到浏览器控制关闭证据。没有把业务调用成功、强停测试浏览器或之后的通过当作成功收尾。原生故障诊断本轮还暴露了自身缺口：收到无请求 ID 的 CDP 事件后就校验首包，未能取得目标回复；因此这一份失败没有可用的插件控制清单，不能据此确定挂在 detach、visual 或其他步骤。

后续本机测试增量改用 Node 原生事件迭代器按请求 ID 读取诊断回复，并在 metadata 正常结束后直接确认插件的受管控制清单为空。实际 Edge 的一次原聚焦场景及一次新增控制事实检查均通过，分别 1/1；该次增量未改变产品控制逻辑，当时尚未推送，不算该偶发停滞已修复。主开发分支、普通 Chrome 接入、原始下载正向取回、250 项完整矩阵、真实用户 Host、正式发布和生产部署仍未完成。

最终本机增量的 306 文件清单 SHA-256 为 `652e92cd553063253afecc94a04d9f807ef217c084141bf2dffc195b8d893b25`；相较 `0038186` 仅测试助手和 metadata 原生用例变化。默认 Node 的 `pnpm check` 为 1391 项中 1364 通过、27 平台跳过，102.16 秒；`pnpm --dir packages/browser check` 为 158/158，9.21 秒。105 份实际 Core 编译文件仍逐字节匹配既有联合图。该本机诊断增量当时尚未提交推送，此处三平台 CI 的结论只归属于 `0038186`；后续提交另记。

### 原生后台动画与实际收尾（2026-11-15）

本轮从未闭合的视觉执行继续定位，发现 `visualPage` 的长距离移动 Promise 只在 `requestAnimationFrame` 回调中结束。后台标签的帧回调会暂停，这也符合 [MDN 的平台说明](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)。外层 250ms 的视觉降级没有终止页面内 Promise，因此不能成为资源已经关闭的证据。

修改前先做真实浏览器复现：CfT 的自有后台标签实际为 `visibilityState="hidden"`，一次定时观察没有帧回调；鼠标移动及随后业务调用均成功，但 Run 持续未结束、资源清理未确认。插件实际受管附着清单已经为空，关闭回执仍为 0，证明只检查 detach 不足以覆盖视觉执行。Edge 同一短观察尚停在鼠标命令，未据此声称原理与旧偶发现场完全相同。基线 `visual.js` SHA-256 为 `fbb1455ca9d15a432d240ea27b73051344b9fa34d980eb991638aa0f2d663af9`；复现脚本为 `2f793b981b640e6bf71d25542009c896968c91e6d1b4e3b102a57e3536f253fc`。两个新增组件用例在旧实现上都因实际 Promise 仍 pending 而失败，不把组件替身当成原生证据。

修复后，隐藏页面直接更新指针，不等待帧绘制；可见页面的动画同时登记原生定时器，期限结束时终止实际 Promise、撤销帧回调，并防止晚回调继续修改 DOM。RunScope、detach、lease_closed 和资源终态逻辑均未放宽，原“250ms 降级不代表原生执行已结束”负例继续通过。

新原生用例通过公开 SDK 创建自有后台标签，观察真实隐藏/无绘制帧状态，执行可信的 `(180,140)` 原生鼠标移动，验证前台标签保持不变；Run 正常结束、插件受管清单为空，下一次 Run 可以复用。B063 的 `nativeCases` 已关联该用例，仅表示其 normal/background/cleanup/result 范围，250 项完整逐项状态继续未完成。

候选 `e07edc0fae836196ebb8df80ce9c4d68a5136050` 已在安全 CI 分支提交推送，包含此前尚未推送的诊断回复关联与 metadata 清理事实检查。306 文件清单 SHA-256 为 `0f59594ba3666fddaff2dacac1e3ce99b3dedbb0c5a03f944fbcba2cdf78b13b`，逐份与安全工作树核对一致。

- 本机默认 Node 24.22.1：`pnpm check` 1391 项中 1364 通过、27 平台跳过，101.66 秒；browser 完整检查 160/160、9.08 秒。105 份实际 Core 编译图未变，未声称重新执行既有 Cloud/PG 联合验收。
- 实际 CfT 的后台回归 1/1，实际 Edge 的 metadata/后台移动/原可视化聚焦组 3/3；随后冻结同一源码执行完整选定原生组，CfT 37/37、139.23 秒，Edge 37/37、153.66 秒，均无失败/取消/跳过。两份实际后台观察均为 hidden 且无帧回调。完整组命令沿用上一节，不含 WebMCP 专项。
- 本候选 [安装 43650957383](https://github.com/bYiyLi/NexumAgent/actions/runs/43650957383)和[browser 43650957378](https://github.com/bYiyLi/NexumAgent/actions/runs/43650957378)均三平台通过。三份原始 browser 日志已逐一核对：组件 160、原生前置 1 与后续 37、实验 WebMCP 1、Docs 1、YouTube 1、Sheets/Slides 2 均通过，无失败/取消/跳过；三平台的新后台场景实际均为 hidden 且无帧回调。[Core 43650957389](https://github.com/bYiyLi/NexumAgent/actions/runs/43650957389)的 Linux / macOS 通过，Windows 为 1393 项中 1359 通过、1 失败、33 跳过、0 取消；失败由下面的测试观察修正承接，不把本候选写成全套通过。

本次关闭的是明确复现的后台动画悬挂；旧 Edge 偶发失败缺少当时完整插件现场，不能将它们一概归因为同一问题，也不删除原失败。原始下载正向取回、250 项完整矩阵、同 tabId 原生场景、普通 Chrome / 更多 Edge 环境、真实用户 Host 及 Phase 最终交付继续未完成。

### Registry 测试的真实终态观察（2026-11-15）

`e07edc0` 的唯一 Windows Core 失败位于 Blob/File 结果图测试：默认 `waitMs=1000` 的提交观察返回 `running`，测试在该次返回后直接要求 `succeeded`；该场景耗时 1745ms。观察窗口结束没有证明脚本执行失败，也没有证明运行已经结束。原失败日志保留，未靠重放脚本、改运行期限、取消完整性断言或直接重跑同一个候选来归为通过。

测试修正使用已有 `observeRunTerminal` 持续观察原来的 Run。失败场景显式 `waitMs:0`，随后等待真实终态；同一文件另 12 处明确要求终态的同类断言也接入该助手，需要运行中/输入/取消状态的场景没有切成终态等待。Blob/File 正文、元数据、私有 handle 拒绝及 array/map/set 容量拒绝断言保留。

候选 `aaccef9c05e351d27571b27a0e7b418b629990ce` 已提交推送，仅修改 `test/registry.test.mjs`。306 文件清单 SHA-256 为 `b769bf86348a54e2ce1eeaa441d96a7097ec5d30fb3f1ab43ec1e783c82f8e52`；本机聚焦 Blob 场景 1/1、完整 `pnpm check` 1391 项中 1364 通过、27 平台跳过，103.79 秒。当前 260 份 Go 源码与 105 份 Core 编译文件均匹配真实联合验收原输入。

本提交与 `e07edc0` 的整个 `packages/browser` Git 子树均为 `44a7b3da88f96cc2cb3ae21edd0e69c824e8eaa3`，没有包、插件、原生用例或 browser 工作流输入变化，因此沿用该子树三平台原生证据；未把它冒充成在新提交上另执行过 browser CI。[Core 43652375100](https://github.com/bYiyLi/NexumAgent/actions/runs/43652375100)和[安装 43652375054](https://github.com/bYiyLi/NexumAgent/actions/runs/43652375054)均已在该提交三平台通过。Windows 完整 Core 实际为 1393 项中 1360 通过、33 平台跳过、0 失败/取消；原 Blob/File 场景通过，所有原数据和拒绝断言保留。Phase 仍为 `in_progress`。

### 滚动后的元素截图与 AX 结果模式（2026-11-15）

真实 CfT 基线复现了元素截图坐标错误：自有页面的红色元素位于文档 `(1000,1300)`，页面滚动到 `(850,1100)` 后，其视口矩形为 `(150,200,160,100)`。旧实现将这个视口矩形直接交给要求文档坐标的原生截图，DPR 1 / 2 的 JPEG 尺寸虽然分别正确为 `160×100` / `320×200`，中心像素实际却是背景蓝色 `[19,40,209,255]`。不能以 JPEG 可解码或尺寸正确证明截到了目标。

修复只调整既有元素截图路径：在同一次原生隔离世界执行中读取元素矩形及实际滚动偏移，生成文档 CSS 坐标后复用既有 screenshot；公开 `elementInfo` 继续返回视口矩形。没有增加公共 SDK 或绕开像素、字节和当前权限限制。新增组件检查验证序列化后的真实 page command 与空目标拒绝；原生场景在 DPR 1 / 2 均解码核对实际目标像素为 `[230,20,31,255]`、尺寸正确，并保留 `INVALID_TARGET` 及运行收尾检查。使用手册已明确视口点、视口矩形与显式截图 clip 文档坐标的区别。

另一个新原生场景覆盖 `ax.get` / `ax.write` 的默认、state、screenshot 和 both：核对真实 AX 正文、截图可解码、AX 索引稳定、未知选项拒绝和当前读取授权撤销；经实际 ResultEncoder 生成标准文本/图片内容与平台运行信息，确认保存的 JSON 不含图片 base64。修改源页面后再次物化原历史结果，四种模式的内容逐字节保持原快照。两处初始测试期待已按既有契约纠正：末尾运行身份/状态文本是必需 fallback；AX 读取和截图检查 `read` 权限，撤销 `control` 并不禁止已授权的读取。未因此更改生产协议或权限实现。B046 / B054 / B074 / B075 已关联这两个原生场景，关联只覆盖明示维度，不将 250 项完整状态改为通过。

安全候选 `59e5dcc71c5a2a1604a2b0dafefe9cc34b9a5dee` 已提交推送，限定这 6 个审阅后的包文件。306 文件清单 SHA-256 为 `e28e00f15adca1624ae8c9c5bf54c1d532775afc80256a7cea04635050283f62`，主工作树和安全 CI 工作树逐份匹配。

- 本机 macOS/arm64、Node 24.22.1、pnpm 10.34.5：Agent `pnpm check` 为 1391 项中 1364 通过、27 平台跳过，112.67 秒；browser 完整检查 161/161、9.05 秒，均无失败/取消。
- 同一冻结源码的完整所选原生组：CfT 160 为 39/39、138.60 秒；Edge 157 为 39/39、128.50 秒，均无失败/取消/跳过。两份新增元素截图均核对真实红色像素，AX 四种输出均达到真实终态；Edge 程序 SHA-256 仍为 `7c5928668411376398c84280d3b3b3cd8bb13ead96bad2cd09ff7feba5aae38c`。命令沿用前节五份原生文件的串行组，不含前置 metadata 或单独开启 WebMCP 的专项。
- 本轮未改 Core / Cloud 产品源码；260 份 Go/契约与 105 份实际 Core 编译文件仍逐份匹配既有真实联合 race 6 项输入，没有重复执行或冒充新一轮联合验收。
- 本提交的 [browser 43655633858](https://github.com/bYiyLi/NexumAgent/actions/runs/43655633858)、[Core 43655633948](https://github.com/bYiyLi/NexumAgent/actions/runs/43655633948)和[安装 43655633809](https://github.com/bYiyLi/NexumAgent/actions/runs/43655633809)均三平台通过，共 9 个 Job。三份 browser 原始日志逐一确认组件 161、原生前置 1 + 后续 39、实验 WebMCP 1、真实 Docs 1、YouTube 1、Sheets/Slides 2 均通过，无失败/取消/跳过；三平台新增截图的实际中心像素均为上述红色值，AX 四种模式检查均执行。Core 的 Windows 为 1393 项中 1360 通过、33 平台跳过，macOS 为 1391 项中 1364 通过、27 平台跳过，均无失败/取消。

原始下载文件正向取回、250 项完整同源矩阵、同 tabId 原生冲突、普通 Chrome / 更多 Edge 平台及真实用户 Host 继续未完成。主开发分支尚未最终提交，未发布、未部署，Phase 保持 `in_progress`。

### AX 差异读取与观察基准（2026-11-15）

逐项核对 B046 / B054 时发现 `disableDiffing` 只有类型/Schema，原实现始终返回完整文字，没有实现参考能力要求的差异观察。固定参考的 `accessibility.md` 明确描述了默认增量、强制完整和纯截图不推进文字观察；它仅用于核对已承诺的能力，不引入参考环境的隐藏模型输出机制。修改前的原生场景因缺少完整状态元数据而失败；独立目录保留旧 router，运行新增组件场景，第二次相同观察仍返回全文而非无变化说明，0/1 通过。旧 router SHA-256 为 `3771a2ec5628d1ec7599e75e7359930238801d681f600748264e92697bfe5568`，该组件复现的测试文件为 `813ca1f6fda5550b5970b489270889cd16d31d92f233db8f07d95f9ef0fc9916`；组件 Chrome API 替身不计作原生验收。

当前 `ax.get/write` 的文字包含标题、URL、原生索引和输入值、选中/展开/禁用等标量状态。第一次返回 `AX full`；同一运行、标签、文档和控制身份的后续观察，在合适时返回 `Removed / Added / Changed` 差异，无变化明确说明。`disableDiffing:true` 强制完整；结构化 `ax.snapshot()`、纯截图及失败/取消/到期的混合读取均不消费文字基准。原生节点重排回到完整状态，避免误报无变化。控制释放、续接和新文档不继承旧文字基准，也不改绑旧 AX 索引。

文字按 UTF-8 逐步计量，超过 60000 字节或原生树已截断时明确报 `OUTPUT_TOO_LARGE`；不把半棵树当完整文字或静默覆盖旧基准。每个活动租约最多保留 16 份有界文字基准，淘汰只使对应标签下一次返回完整状态，不限制其继续操作。新增组件覆盖实际值变化、空树、顺序变化、跨标签/文档/租约、截图失败、取消、到期、途中换页、超大值、截断及缓存淘汰；两处初始夹具错误分别为无法清除显式 undefined 和新建标签没有传递其真实 controlEpoch，修正夹具后原身份检查继续生效。

两个新增原生场景分别实际调用 `ax.get` 与 `ax.write`：CfT / Edge 均核对新增、移除、改名和输入值变化，完整文字 1422 字节、差异 490 字节；强制完整、纯截图/结构化快照不推进文字、独立标签、导航和新 Run 也验证。`ax.write` 的 state / both / 强制完整三种分支实际经平台 ResultEncoder 交付，文字分别为 243 / 242 / 1413 字节，混合模式包含真实 JPEG。B046 / B054 / X050 仅关联这些已明示的场景，不将 250 项完整矩阵改为通过。

候选 `ada426cb491bb793fdc6db0e57d6104ae70fbd8a` 已在安全 CI 分支提交推送，限定 5 个审阅后的包文件。306 文件清单 SHA-256 为 `67602e0a7324f3c5018cbdb96de0180c2057be463ef97c65d346e9a7e820c042`，主工作树与安全工作树逐份匹配。SDK 设计说明与包内使用手册已同步，主开发分支文档仍为本地增量。

- 本机 macOS/arm64、Node 24.22.1、pnpm 10.34.5：Agent 完整检查 1391 项中 1364 通过、27 平台跳过，114.00 秒；browser 完整检查 168/168、9.08 秒，均无失败/取消。
- 同一冻结源码的五文件串行原生组，CfT 160 为 41/41、147.68 秒，Edge 157 为 41/41、132.30 秒，均无失败/取消/跳过；该组不含前置 metadata 或单独开启 WebMCP 的专项。两份新差异场景均实际执行，所有运行收尾检查通过。
- 260 份 Go/契约与 105 份实际 Core 编译文件仍匹配既有真实联合 race 6 项输入，本轮未重新执行该联合验收。
- 本候选的 [browser 43659386529](https://github.com/bYiyLi/NexumAgent/actions/runs/43659386529)及[安装 43659386566](https://github.com/bYiyLi/NexumAgent/actions/runs/43659386566)均三平台通过。三份原始 browser 日志已逐一确认组件 168、原生前置 1 + 后续 41、实验 WebMCP 1、真实 Docs 1、YouTube 1、Sheets/Slides 2 均通过，无失败/取消/跳过；新增 AX 差异与写出场景在三个平台均实际执行。[Core 43659386500](https://github.com/bYiyLi/NexumAgent/actions/runs/43659386500)的 Windows / Linux 通过，macOS 为 1391 项中 1363 通过、1 失败、27 跳过、0 取消；失败为原生 CLI 在实际 Git 维护不可用诊断后，仍等待不存在的维护状态文件。原现场不可用的具体原因未保留，不能据此归因为某个确定的环境错误。后续测试修正只承接该观察契约，不把本候选写成 9 个 Job 全通过。

等待该候选 CI 时，按机器清单的 `sourceInterface` 另补查 B143 `ConfirmDialog.accept` 与 B148 `PromptDialog.dismiss`。独立原生脚本在本机 CfT / Edge 各 1/1 通过，核对 confirm 实际返回 true、prompt 实际返回 null、confirm 的非法文本参数不会关闭原对话框、已消费 prompt 句柄报 `STALE_REF` 及运行收尾。脚本 SHA-256 为 `bb98683101f9a7b120fbd3c39c5cc6de99f8338fed09a82504aefc0256ee8f01`，复用本候选冻结的公开 SDK/MV3/Core，没有修改产品或仓库用例；它未纳入上述 41 项与三平台 CI，后续仍需整理进正式用例与逐成员映射。

完整 250 项、原始下载正向取回、相同 tabId 场景、普通 Chrome / 更多 Edge 平台、真实用户 Host 及 Phase 最终评审/主开发分支提交继续未完成；未发布、未部署。

### CLI 的可选 Git 维护降级观察（2026-11-15）

`ada426c` 的 macOS Core 原生 CLI 场景已完成连接及真实 VM 的 `{answer:42}` 检查，随后在等待 `state/work-git.json` 时失败；该场景共 87.51 秒，stderr 只有 `agent_connected` 与 `work_git_unavailable`。原测试没有处理“环境探测在 Git 维护结果产生前失败”的降级路径，继续等待不存在的状态文件。既定 work Git 合同允许维护不可用时保留诊断、继续提供 Agent 能力；原现场的具体异常没有保留，不将本次修正写成该异常根因已查明。

修正只涉及 `test/cli.test.mjs`，不更改生产实现。正常路径仍核对实际维护文件的 schema、Git commit 或明确的 Git 不可用结果；文件尚未产生时，必须在本次 development profile 的真实 `logs/agent.log` 找到 `work_git_unavailable`、`retry:false`，单靠 stdout 或缺少文件不能通过。两条路径均继续检查同一实际 CLI 的打开工作、真实 VM 结果、关闭后拒绝执行、原异常净化与 OS 信号后的实际零退出。

新增受控故障场景沿已有 Node 原生 builtin 同步方式，仅在自有 CLI 子进程中把配置 shell 指向测试目录里的可执行文件；该文件写入实际运行标记并以 17 退出。真实环境探测、后台调度、WebSocket、Core/VM 和退出流程照常执行，没有替换维护实现或在测试侧生成维护结果。场景要求该实际执行标记、持久不可用诊断、缺少伪维护文件和后续 VM / 关闭断言同时成立。它属于原生子进程中的故障注入，不代表真实用户 shell 的验收。

候选 `65cfc1875789eed5ed675418229c3fe862020dcc` 已在安全 CI 分支提交推送。306 文件清单 SHA-256 为 `853960524b99221d51bc57b228858ff2e4dfe3b9d3fbd0ee3efb25669d380781`；相对 `ada426c` 仅这一份测试变化，整个 browser Git 子树同为 `79555eae2bab8c9a10d20348444dcefcdf58f41a`，105 份实际 Core 编译文件未变。本机聚焦两个真实 CLI 场景 2/2；完整 `pnpm check` 为 1392 项中 1365 通过、27 平台跳过，108.82 秒，无失败/取消。

新 [Core 43661327161](https://github.com/bYiyLi/NexumAgent/actions/runs/43661327161)和[安装 43661327084](https://github.com/bYiyLi/NexumAgent/actions/runs/43661327084)均三平台通过。逐份核对 Core 原始日志：macOS/Linux 各 1392 项中 1365 通过、27 平台跳过，Windows 1394 项中 1360 通过、34 平台跳过，均无失败/取消。正常 CLI 与受控 Git 探测故障场景在 macOS/Linux 实际执行通过；Windows 明确跳过这两个 POSIX 信号场景，实际服务停止另由原生安装验收覆盖。browser 沿用完全相同子树的 `ada426c` 三平台结果，没有将它冒充为新提交另跑过 browser CI。原 `ada426c` 的失败与未知根因保留，Phase 继续 `in_progress`。

### 对话框与 Tab 输入别名的正式原生用例（2026-11-15）

将上一轮独立实测整理为仓库正式用例，仅修改 `native-client.acceptance.mjs`、`native-actions.acceptance.mjs` 与 `implementation.json`，生产逻辑未变：

- `native confirm acceptance and prompt dismissal preserve real values and consumed identities`：真实 confirm 接受后为 `true`，prompt 取消后为 `null`；confirm 接受不允许的文本参数返回 `INVALID_ARGUMENT` 且不关闭对话框，已消费 prompt 返回 `STALE_REF`。同时核对实际类型、消息、无残留对话框、Run 收尾和插件实际受管控制为空。
- `native Tab focus hover keyboard and scroll aliases produce actual events, coordinates and fixed-ref rejection`：真实 `:hover`、焦点、可信 Shift 按下/释放事件和页面滚动 240px；五次动作返回五个不同 operationId 及准确 tabId；删除旧节点、插入同 ID 替代节点后，旧 ref 返回 `STALE_REF` 且替代节点未获得焦点，最后核对实际控制已释放。
- 为既有 Dialog 用例及新增两例关联 17 个成员，目前共 54 个成员有仓库原生用例链接。未关联的 196 项需要继续核对证据，不能解释为能力未实现；这也不是完整逐项验收通过比例。250 项完整 `nativeAcceptance` 继续保持未完成，不把场景中的某个失败分支推广为所有关联成员均覆盖该分支。

候选 `0fc9f3e0fe7147c6eb368636538dc8873f9ff62d` 已在专用安全 CI 分支提交推送，306 文件源码清单 SHA-256 为 `f8538b3e02ac7bf3762831513e8261495f8bc74a7e00531de068e6c79d13433d`，主工作树与该候选逐文件一致。Node `24.22.1`、macOS/arm64 上，完整 `pnpm check` 为 1392 项中 1365 通过、27 平台跳过、0 失败/取消，109.60 秒；browser 完整检查 168/168。新增正式两例在 CfT 160 与 Edge 157 各 2/2、无失败/取消/跳过，分别 17.64 / 14.35 秒；该聚焦结果没有冒充完整原生组再次执行。

新 [browser 43663106635](https://github.com/bYiyLi/NexumAgent/actions/runs/43663106635)、[Core 43663106656](https://github.com/bYiyLi/NexumAgent/actions/runs/43663106656)和[安装 43663106629](https://github.com/bYiyLi/NexumAgent/actions/runs/43663106629)均三平台通过，共 9 个 Job。逐一核对三份 browser 原始日志：组件 168、原生前置 1 + 后续 43、实验 WebMCP 1、真实 Docs 1、YouTube 1、Sheets/Slides 2 均通过，无失败/取消/跳过；新增两个正式场景在三个平台均实际执行。完整原生组通过与本机聚焦两例分别记录。历史双配置检查的实际 tabId 不同，相同原生 tabId 的隔离仍待实际验证；不以生成假的 ID 或复用组件测试补齐该缺口。Phase 保持 `in_progress`，主开发分支尚未最终提交，未发布或部署。

### 普通 Chrome 的人工加载与实际页面验收（2026-11-15）

用户已解锁电脑，并明确改为在其现有普通 Chrome 中按验收标签组测试。界面控制未能准确定位另一进程的旧隔离窗口；浏览器控制工具随后明确拒绝 `chrome://extensions/`，并禁止改用其他界面绕过同一限制。因此只将该管理操作交还用户，其余原生验收继续，不将工具策略拒绝归为 Nexum 产品失败。

当前候选通过真实 Core/VM 和 CfT 启动自有 development loopback 测试连接；用户已在普通 Chrome 手动加载当前扩展，随后只选择该新增连接并创建验收页面。扩展已复制到 `~/.nexum-dev/work/tmp/browser-acceptance/0fc9f3e/extension`，15 份实际 JavaScript 与当前候选源码逐文件一致，另核对准备阶段的 profile.js；未覆盖现有 Agent 扩展、配置或凭据，目录拥有独立来源标记，测试监听不连接 production Server。扩展声明含 debugger、tabs、历史、书签和剪贴板等权限，已向用户说明标签组只是本次操作范围，不缩小扩展自身权限。

独立场景 `ordinary user Chrome runs the current Nexum package only on its new acceptance tab` 已 1/1 通过、无失败/取消/跳过：真实原生输入和可信点击后页面显示“已验证：普通 Chrome 原生输入”；`ax.write('both')` 经实际 ResultEncoder.render 返回标准文本/ImageContent，JPEG 为 37539 字节、SHA-256 `7941725f21f8ebed084154399ce3c6cae64f497dce17b11d47b7d9c81909a545`，已解码查看。原 Run 收尾 `closed:1`、`unconfirmed:[]`。总用时 303.74 秒含等待人工加载，不能当作业务执行性能。

电脑控制随后在用户原 Chrome 连接中按同一个原生 tabId 和准确回环 URL 核对：实际页面标题、输入值、结果均正确，标签组为 `🧪 Nexum 验收`。当前原生 peer 的 `versionSource` 为 `unknown`，未虚构其已报告浏览器版本。本次标准图像编码、本机真实用户 Chrome 页面与先前 CI 分开记录，不代表完整 250 项、普通 Chrome 全量能力或真实远程 MCP Host 传输已经验收。该次自有监听与资源已收尾，旧独立 Chrome 进程经核对已退出；用户安装的开发扩展目录保留，没有自动卸载或改动用户原有扩展。

### 相同原生 tabId 的独立配置对照（2026-11-15）

此前普通双配置场景在三个 CI 平台均实际得到不同 tabId，补充观察也确认两个独立进程的 ID 起点不同，不能据此声称相同 ID 已验收。进一步核对 [Chromium 原生 SessionIdGenerator](https://github.com/chromium/chromium/blob/main/components/sessions/core/session_id_generator.cc)，只在两个新建自有配置的 `Local State` 中设置已有 `session_id_generator_last_value` 持久计数起点，由真实浏览器自行生成 ID；没有改写扩展响应、拦截 Chrome API、伪造 target 或读取/修改用户日常浏览器配置。

在冻结的 `0fc9f3e` 生产代码上，独立原生夹具已实际通过：

- CfT 160：两个真实原生 tabId 均为 `1000052`，1/1，通过总用时 8.70 秒。
- Edge 157：两个真实原生 tabId 均为 `1000053`，1/1，通过总用时 9.54 秒。
- 两边独立填入 `profile one` / `profile two` 并读回；持有第一边等待时第二边可以操作，同一第一目标的另一 Run 正确返回 `TAB_ALREADY_CLAIMED`；取消、实际收尾、第二配置退出后第一配置原 boot/session/generation 保留均成立。所有结果来自真实 SDK/Core/MV3/浏览器，未替换控制身份。

为与用户已启用的普通 Chrome 开发扩展共存，独立夹具按自有测试 URL 选择目标并只归集两个测试配置；默认浏览器的断言则使用实际完整 peer ID 集合核对，不假定所有连接都属于测试。此独立对照执行时，正式夹具仍有全局 `getDefault()` 的假设，后续候选已改为准确目标选择。

独立夹具源码 SHA-256 为 `78163a3db007173a9adc95338121cb686595a0af04e430c9b94c56ed3a4187fc`，场景 SHA-256 为 `b08fc3a8da8cccf73f1235fa9c6cd1682e6b4f787ffface736cdb29a80eb72b0`。此独立对照不能并入 `0fc9f3e` 的原生 43 项或把完整支持矩阵标为完成；后续正式用例和 CI 单独记录。当前 260 份 Go/契约和 105 份实际 Core 编译文件再次核对，仍与既有联合 race 输入逐文件一致。

### 正式夹具隔离及本机 Edge 弹窗（2026-11-15）

正式原生夹具改为按自有测试页面选择对应浏览器，再显式传递该 peer 身份；双配置场景使用真实浏览器自行生成的相同 tabId，检查两端各自控制、冲突、取消及离线后的身份。默认浏览器测试仍按实际完整 peer 集合断言，不把连接的用户 Chrome 当作测试配置。`implementation.json` 为 B029 关联此正式用例；共 55 个成员有原生用例链接，链接不代表 250 项完整验收。

用户手动加载的 Chrome 开发扩展曾自动连接本机测试服务，而当时部分组件夹具仍使用默认浏览器和首个标签。发现后立即停止该次测试，并将组件夹具改为明确选择其自有模拟连接；由于测试中止，原失败未输出完整异常堆栈，无法确认是否有操作落到用户的其他标签。后续可能连接浏览器扩展的自动测试均改到远端执行；不以停止或重跑结果推定用户其他标签的状态。

该版本增加保护前，本机 CfT 的五文件选定原生组为 44/44；本机 Edge 为 43 通过、1 失败，失败是视觉标记用例读取不到预期图层。Edge 运行期间桌面出现“找不到钥匙串”弹窗，用户确认弹窗已经消失；浏览器测试已停止，没有重置用户钥匙串。测试日志未记录弹窗具体原因，不能断言该失败由弹窗造成，也不能用别处通过推定本机问题已修复。

测试夹具现在默认会在本机 macOS 启动标准 Edge 程序前拒绝运行；保护检查只用 Node 和不存在的路径验证拒绝以及 GitHub macOS 分支，不启动浏览器。本机 browser 组件检查为 169/169，Agent 完整 Node 检查为 1392 项中 1365 通过、27 平台跳过、无失败或取消。生产 SDK 与浏览器插件源码未因这一批测试调整改变。

安全 CI 候选 `597517c9a19e006f901830c961963d5b4990b952` 已提交推送，306 份源码清单 SHA-256 为 `98384a14cb555285bc94001b6b8ad7c286ee158c7e4426084dc0ddd82c573bff`。[browser](https://github.com/bYiyLi/NexumAgent/actions/runs/43670177729)、[Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43670177763) 和[安装](https://github.com/bYiyLi/NexumAgent/actions/runs/43670177773)三平台共 9 个 Job 均通过。逐一核对 browser 日志：macOS 组件 169/169；Linux、Windows 各 168 通过、1 项 macOS 专属保护检查跳过；三平台 Chrome 原生前置各 1 项、后续各 43 项及 WebMCP、Docs、YouTube、Sheets/Slides 专项均通过。相同 tabId 的 Chrome 双配置在三平台均实际为 `1000052`。

新增远端 macOS/Intel 的 Edge 151.0.4129.101 聚焦原生检查为 2/2、0 失败/取消/跳过，分别覆盖相同原生 tabId `1000053` 的双配置和视觉标记清理；其程序 SHA-256 为 `358b5f91612a07e8b54d4883ee489fbea0971f1040b6c17da1f938693f5676af`。该执行机与用户本机 macOS/arm64 的 Edge 157 不同，不能据此认定本机弹窗原因或本机视觉失败已修复。安全候选不等于主开发分支最终提交、完整 Phase 验收、发布或部署。

### 定位器空结果与联合顺序（2026-11-15）

[真实 Chrome 对照](https://github.com/bYiyLi/NexumAgent/actions/runs/43693824019)发现，当按钮同时含 `aria-labelledby` 和不同的 `aria-label` 时，浏览器无障碍树报告 `Save report`，旧 Locator 却错误匹配 `Discard report`。修复让非空引用文本优先，并回退到 `aria-label`；[同场景验证](https://github.com/bYiyLi/NexumAgent/actions/runs/43694265220)在隔离 Linux Chrome 通过。这个针对性修复不代表完整 ARIA 名称算法已实现，覆盖多个引用及实际点击的跨平台验收另记。

`f55a378` 的[浏览器检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43694429221)在 Linux 和 Windows 完整通过；macOS Intel 的 Chrome 48 项均通过，包含上述名称、多个引用和实际点击，但 Edge 视觉反馈场景未通过，故 Mac 整套未通过。此前视觉降级事件仅在插件发出，没有接入扩展日志；新增日志仅使用已确认连接与租约、匹配的在途动作和固定原因码，不写页面、URL 或原生异常。随后[隔离 Edge 诊断](https://github.com/bYiyLi/NexumAgent/actions/runs/43696563216)再次观察视觉层先出现后移除，并记录同一动作的超时、取消与不可用，但没有证明唯一根因；新诊断的连接与脱敏聚焦测试在 Linux/macOS Intel 通过，实际 Edge 场景仍失败。

[后续聚焦验证](https://github.com/bYiyLi/NexumAgent/actions/runs/43696838734)收紧目标关联：只有当前租约与在途动作的目标一致时才记录 operationId/tabId，未知原因归一为固定码；Linux 和 macOS Intel 日志测试各 2/2 通过，macOS Intel 实际 Edge 视觉场景 1/1 通过。该次通过不能解释此前失败，完整 browser 验收仍需以最终候选执行结果为准。

安全候选 `eef0055b56a52e53bd49e416a5664af32b2922ad` 的[浏览器检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43697067396)在 Linux、Windows、macOS Intel 均通过，Mac Edge 两个场景均通过；此结果不覆盖后续代码改动。[后续诊断](https://github.com/bYiyLi/NexumAgent/actions/runs/43698385146)中 Mac Edge 视觉提示再次失败：提示层短暂出现后消失，期间记录到受限的不可用及取消原因；目前不能据此确定唯一根因。测试中的页面、浏览器配置和文件均为隔离合成数据。

服务端在消费视觉事件前先校验完整输入，以避免非法事件进入日志。新增回归检查还发现连接关闭与服务释放的竞态：关闭发送可能在返回 Promise 之前同步抛错，导致服务无法完成自身清理。修复前在远端 Linux 的 Node 24.15.0 上稳定复现 `EXTENSION_OFFLINE`，修复后同一受控场景和非法事件场景 2/2 通过；Node 24.22.1 的[聚焦检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43698385146)在 Linux/macOS Intel 各 2/2 通过，日志传递另各 1/1 通过。收尾完成只指本地服务资源关闭，未收到浏览器确认的远端租约不会被标记为已确认关闭。修复后的三平台浏览器整套结果另记。

断线修复对应安全候选 `fedc2ae` 的[浏览器检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43698487740)三平台通过，Mac Edge 两项通过；不能用它解释此前的间歇失败。为定位视觉问题，在仅含合成页面的[隔离诊断第二次运行](https://github.com/bYiyLi/NexumAgent/actions/runs/43698712601/attempts/2)中观察到：同一操作两次等待页面图标准备，均未及时完成；第二次耗尽视觉准备时限后，首次指针显示未能完成。记录只支持该次失败的具体经过，不证明其他失败都有相同原因。

现让同一目标的指针步骤复用该次操作已经发起的视觉准备，将时间留给指针显示；若目标不同或还没有对应页面记录，仍重新检查。远端 Linux 的受控慢图标场景在修复前未显示指针，修复后通过，视觉组件共 13/13、路由组件 62/62；取消、迟到执行及未确认的实际关闭规则保持不变。[带诊断的复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43699373070)在 Linux/macOS Intel 的视觉组件各 13/13，但 Edge 场景仍未显示指针：这次已经没有重复图标准备，指针本身的注入仍未在期限内完成，实际鼠标调用也耗时较长；该场景失败，不能宣称视觉问题已解决。最终候选三平台检查另记。

安全候选 `3e7391a` 的[浏览器检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43699318888)在 Linux、Windows、macOS Intel 三平台通过；三平台 Chrome 主要原生场景各 48/48，macOS Edge 聚焦 2/2，Linux 实际原生取消 1/1，新增断线和慢图标回归也均实际运行。候选的 70 个 browser 文件与当时的 Agent 工作树逐字节一致。此次 Edge 通过不消除上面带诊断运行的失败；原始下载取回、完整 250 项矩阵和真实用户 Host 仍未验收。候选相较 `5a1880f` 只修改 browser 子树，未把本轮主动取消的重复 Core/安装检查算作通过。

为扩大 Edge 实际覆盖，[独立检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43700642292)的 Windows Edge 156.0.4314.58 前置 1/1 和主要原生场景 48/48 通过；同批 macOS Intel 前置通过，48 项中 45 项通过、3 项失败：等待遮挡解除后点击超时、页面关闭提示期间运行未正常收尾、等待后出现的定位器超时。前述 Mac Edge 聚焦 2/2 不能代替这些失败。Linux 的[第一次](https://github.com/bYiyLi/NexumAgent/actions/runs/43700893189)和[第二次](https://github.com/bYiyLi/NexumAgent/actions/runs/43701066587)尝试均在扩展上线前失败：执行机原装 Edge 的 SUID helper 权限不符合浏览器要求，第二次传入独立 helper 的环境变量仍被忽略。随后仅在测试机临时目录复制浏览器及 helper 并为副本准备所需权限，没有关闭浏览器沙箱；[Linux Edge 157.0.4341.46 复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43701247021)的前置 1/1 和主要原生场景 48/48 均通过。这些检查使用各自的临时浏览器配置及合成页面，测试候选相较 `3e7391a` 仅增加工作流。Mac 的三个失败仍须诊断，不能据此宣布完整 Edge 验收通过。

[Mac 隔离聚焦复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43702405069)再次执行上述三个场景：点击遮挡场景通过；另外两项仍失败。测试页记录显示，定位目标在创建定时器约 408ms 后已经出现在可见页面，但该次等待到 5 秒仍超时。关闭提示场景中，10ms 的等待调用在端到端记录中耗时约 10 秒，随后运行在达到截止时间后仍有未确认的控制收尾。上述数据来自合成页面及诊断代码，只描述所测运行，不把单次结果扩展到所有环境；根因及正式修复仍待确认。

继续在同一隔离条件下跟踪等待：一次[诊断尝试](https://github.com/bYiyLi/NexumAgent/actions/runs/43702879480)未能使测试插件上线，不能据此判断页面行为；[后续诊断](https://github.com/bYiyLi/NexumAgent/actions/runs/43703287511)中关闭提示场景通过，但定位器仍失败。插件的 50ms 定时器在整整 5 秒内没有自然触发，最终被超时取消；测试页的 400ms 定时器则实际触发，目标已经存在。该证据确定了这次失败的等待经过，不证明所有 Edge 延迟都有相同原因。

候选修复复用已有连接的心跳，由 Agent 的 Node 定时器在动作等待期间唤醒插件；插件继续按单调时钟确认等待期限，不缩短等待或重放动作，成功、取消、断连后停止额外唤醒。本机隔离组件检查 84/84 通过，另补充完成和取消后停止唤醒的回归 9/9；[Mac Edge 151 聚焦复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43704160406)的原三个场景 3/3 通过、无跳过。该结果不能消除更早的视觉提示失败，也不能代替完整 Edge 和三平台复验。

相同浏览器实现的候选 `b9700be` 扩大到 Edge 全量场景：[macOS Intel / Windows](https://github.com/bYiyLi/NexumAgent/actions/runs/43704564956)和 [Linux](https://github.com/bYiyLi/NexumAgent/actions/runs/43704565022)各有前置 1/1 与主要 48/48 通过，均无跳过；此前失败的三个 Mac 场景及视觉场景均在该次通过。但对应 `739f735` 的[浏览器工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43704160366)虽然 Linux、Windows 全部通过，macOS Intel 的组件 181/181、Chrome 前置 1/1 和主要 48/48 均通过，Edge 聚焦两项中视觉提示仍有 1 项失败，因此 Mac 工作流整体失败，后续网站专项未执行。该次操作日志显示可视化反馈降级、一次鼠标操作历时约 12.5 秒，不能把另一次 Edge 全量通过当作该失败的解释。候选与当前工作树随后新增的视觉超时处理是不同源码。

针对视觉准备本身也依赖插件计时器的问题，当前将它的有界等待接入同一唤醒方式：达到原期限后只报告降级，不取消已经确认的业务结果、不重放输入；迟到的原生任务仍按实际收尾。受控计时器停滞回归同时覆盖视觉动作与结果标记，以及迟到准备不继续注入；相关连接、路由、视觉和服务组件共 99/99 通过。该处理针对超时收尾，暂不证明受影响页面的指针提示一定能够显示。[实际 Mac Edge 聚焦运行](https://github.com/bYiyLi/NexumAgent/actions/runs/43705453049)中指针已出现，但所需的图标未被观察到，因此仍失败；[加入诊断的单次运行](https://github.com/bYiyLi/NexumAgent/actions/runs/43705567539)通过，带有额外诊断，不能消除原失败或证明其原因。完整浏览器验证另记。

[后续合成页面跟踪](https://github.com/bYiyLi/NexumAgent/actions/runs/43705801716)再次发生指针存在而图标缺失：该次标签分组约耗时 174ms，随后才开始图标注入，而图标注入约 262ms 后才结束，已经超过同次视觉准备的 250ms 期限；该结果只说明这次调用的实际顺序与耗时。现让同一目标的分组/前台准备与图标注入并行，仍在实际业务动作前等待其结果，不重放输入或接管用户原有分组。受控回归在改动前因图标未提前开始而失败，改动后通过；完整视觉组件 15/15 通过，额外检查取消收尾不留下迟到图标或自建分组。实际浏览器复验另记。

此前、尚未包含并行准备的候选 `d17d588` 的[浏览器工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43705452962)在 Linux、Windows 和 macOS Intel 全部通过，包括 Mac Edge 的视觉与配置隔离两项；这不能证明后续代码也已通过。加入并行准备后的候选 `ec8901b` 在[Mac Edge 聚焦复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43706226917)中仍未观察到指针，实际鼠标动作约 8.2 秒才结束，视觉场景失败；目前不能确定其与前一次图标缺失是否同因。该候选的整套浏览器工作流被主动取消，不能记为通过；当前仍在隔离环境核查原生调用和页面准备的实际耗时。

[进一步的隔离诊断](https://github.com/bYiyLi/NexumAgent/actions/runs/43706668659)再次未观察到首个后台操作的指针和图标。该次分组与图标准备已并行，图标注入请求发出约 537ms 后页面才开始执行；指针样式的浏览器调用约 430ms 才返回，超出原 250ms 视觉预算；真实鼠标指令随后在浏览器原生命令中等待约 5.7 秒才返回。后续前台操作的图标、指针及鼠标指令均完成。诊断只说明本次原生调用的实际耗时，不能推断其他机器或每次失败的原因，也不能通过扩大期限或重放鼠标冒充修复。当前源码的连接、路由、服务和视觉组件联合复验 100/100 通过，不能替代正常浏览器的视觉验收。

将原生准备中途的释放回归扩展到 `dispose` 与 `release` 后，候选 `f617893` 的[Mac Edge 聚焦检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43707221270)再次未观察到首个后台指针，鼠标动作约 7.1 秒结束，场景失败；页面随后观察到前台图标和指针。该候选的三平台整套浏览器检查结果如下。

同一候选的[三平台浏览器检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43707221376)中，Linux 和 macOS Intel 的 job 通过，Mac Edge 两项也通过；Windows 的 48 个主要原生场景为 47 通过、1 失败。失败场景在视觉业务动作前就未发现测试扩展的在线连接，隔离浏览器页面和扩展 worker 存在，诊断发起的测试 WebSocket 能握手；这些事实不足以确定原连接为何未上线，不能把它算作视觉动作失败或通过。测试夹具的超时诊断现补充已收集的有界连接事件和观察到的 peer 数。该结果属于修复上述连接竞态之前的源码。

对启动代码的独立检查发现两个可复现的问题：首次创建 WebSocket 同步抛错后没有进入已有退避重连；多个启动通知在初始化期间到达时，初始化完成后可并发创建多个连接。现分别让首次连接失败进入原重连流程，并在初始化完成后再次检查已有连接。两项受控回归均在修复前失败、修复后通过；身份日志缺失仍拒绝连接，另有回归保护。上述场景是受控故障，尚未证明 Windows 那次未上线由它们引起；实际浏览器复验另计。

继续检查发现，旧连接处于 closing 状态时若收到启动通知，原实现可以提前创建新连接，使旧连接关闭回调失去清理身份。现保留旧连接作为当前所有者，直到它的关闭回调开始清理；受控回归在修改前实际创建两个连接并失败，修改后确认在途动作收到取消、旧租约开始清理后才重连，迟到的旧关闭通知不会影响新连接，原动作只派发一次。补充回归让清理在新连接建立后才实际完成，确认关闭回执只在完成后发往新连接，并保留原连接代次。相关组件联合检查 106/106 通过。此问题也不能据此解释上述 Windows 未上线现场；含该修复的候选 `ad912a7` 跨平台实际浏览器检查另计。

增加迟到回执断言后的候选 `2d60ee3` 的[连接恢复专项检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43710201887)在 Linux、Windows 和 macOS Intel 各 6/6 通过、0 跳过，覆盖初始化竞争、身份拒绝、旧连接收尾、首次连接失败重试及样式恢复；它属于受控组件检查，不替代真实浏览器验收。

另发现保存的控制记录属于其他浏览器会话时，原实现虽然拒绝连接，却会先启动路由监听。现将该身份检查提前到路由启动之前；受控回归修改前失败、修改后通过，相关本机组件合计 107/107。此项后续修改不包含在上述候选或其浏览器结果中；包含该修改的候选 `762ba6e` 实际浏览器结果另计。

候选 `762ba6e` 的[完整 browser 工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43710471766)在 Linux、Windows、macOS Intel 三平台通过：主要原生 Chrome 场景各 48/48，Mac Edge 两个场景 2/2；Linux 原生取消、开启 WebMCP 及公开站点检查也执行通过。组件检查 Mac 为 191/191，Linux/Windows 各 190 通过及 1 个 macOS 专属保护按平台跳过。该候选的[独立 Mac Edge 聚焦检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43710471675)仍未观察到首个后台指针，鼠标动作约 6.37 秒后返回，场景失败；一次完整工作流通过不能抹去这一独立失败。该候选尚未包含下面的回执写入修复。

继续检查并发收尾：两个 lease 同时结束时，原实现并发写入各自的 session 快照；在受控夹具中让第一笔写入延迟，第二笔先完成，再放行第一笔，会使较旧快照覆盖较新快照。修复后顺序保存回执；新回归确认两份记录均被保存，模拟 worker 重启后在新连接发出两份回执，且保留各自原始代次。此处只证明受控的乱序存储场景，不声称已在真实 Chrome 观察到该乱序。相关连接、路由、服务和视觉组件联合检查 108/108 通过；安全候选 `e7b7f07af042a73e0d02a1f543175c3289bb7ebf` 的 70 份 browser 文件当时与主工作树逐字节一致。

该候选的[完整 browser 工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43711100321)在 Linux、Windows、macOS Intel 三平台通过：主要原生 Chrome 场景各 48/48，Mac Edge 两个场景 2/2；Linux 原生取消、WebMCP 及公开站点检查也执行通过。组件检查 Mac 为 192/192，Linux/Windows 各 191 通过及 1 个 macOS 专属保护按平台跳过，三平台均实际执行新增并发回执组件用例。这不覆盖原始下载正向取回，也不消除前述独立 Mac Edge 视觉失败。

另准备了两个真实浏览器任务并发结束的隔离专项。[首轮](https://github.com/bYiyLi/NexumAgent/actions/runs/43712149152)在三平台都未到预期等待点，脚本实际以 `script_execution_failed` 结束；原夹具没有保留具体异常，不能据此认定产品原因。静态核对发现该夹具只装 browser，没有向脚本绑定首轮所用的 `runtime`；修订版使用测试页面服务器的本地 HTTP 等待点并保留脚本异常，结果另计。

修订后的独立提交 `4ff4ccab26d44e7d29c802519bd21172f1b9767c` 在[专项运行](https://github.com/bYiyLi/NexumAgent/actions/runs/43712481785)的 Linux、Windows、macOS Intel 各 1/1 通过、0 跳过。每个平台均先让两个运行分别控制真实测试标签并同时到达本地等待点，再同时放行；两运行成功且无未确认清理，插件 session 中的关闭回执从 1 条增加到 3 条，实际受管控制为空。该专项验证真实浏览器的并发收尾，不声称自然复现了存储写入乱序；产品 browser 源码与 `e7b7f07` 相同。专项已按项目测试目录整理并加入 browser 工作流，后续工作流结果另计。

整理后的安全候选 `e3c968c669cc877759ceb6a8e1945e9ffb3c5ecc` 的 71 份 browser 文件及 browser 工作流与当前工作树逐字节一致；新测试主体与 `4ff4cca` 一致，只有所在目录和 helper 相对导入不同。[完整 browser 工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43712952521)的 Windows 和 macOS Intel job 通过，主要原生场景各 49/49，新增并发收尾及公开 YouTube 场景均执行通过，Mac Edge 为 2/2。Linux 主要原生 Chrome 场景 49/49 通过，包含新增并发收尾场景；原生取消、WebMCP 和公开 Docs 检查通过。之后真实 YouTube 页面返回 Google 访问验证页面，没有得到目标 videoId，因此 YouTube 用例失败、后续 Sheets/Slides 未运行，Linux job 及整轮工作流未通过；不绕过站点验证，也不将其算作成功或断言产品是失败原因。该候选的产品 browser 源码与此前三平台包括真实 YouTube 检查通过的 `e7b7f07` 相同。此次推送自动触发的重复 Core 与独立 Edge 工作流已取消，不作为通过证据。

继续检查长期打开的页面发现，旧视觉层把每个已释放租约永久放入页面内 Set。对原函数使用受控时钟，每秒结束一个不同租约，模拟 10000 次后仍保留 10000 个标记；这不是用户页面的实测数量。现按该身份已经观察到的最晚动作期限和 250ms 原生分派窗口保留关闭标记，之后在下一次页面操作时清理；旧 worker 的 Set 也先保留一个分派窗口再清理。受控回归覆盖仍有效的迟到动作拒绝、到期后的旧动作拒绝和旧 Set 过渡；模拟 10000 次后保留 1 个末次标记。连接、路由、服务和视觉组件联合检查 110/110 通过，真实浏览器及跨平台结果另计。此项修复针对资源累积，不宣称上述 Mac Edge 后台视觉提示偶发问题已解决。

进一步在隔离 Linux 真实 Chrome 中复现：旧源码的[原生对照](https://github.com/bYiyLi/NexumAgent/actions/runs/43715595729)对同一测试页面连续完成四次任务后，四个视觉关闭标记仍保留，故新增断言失败；四次指针均实际出现，租约控制已清空。修复候选 `d853685085a13a5d2fde9e68d2dced817c883278` 的[专项检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43715794487)在 Linux、Windows 和 macOS Intel 各通过 3 个组件用例及 1 个真实浏览器用例，四次任务后各保留 1 个未过期标记。该候选当时的 71 份 browser 文件、139 份运行时/契约及工作流支持文件和正式 browser 工作流与主工作树逐字节一致。

复核时又发现，连续两次释放同一身份可能用较短期限覆盖先前记录的较长期限。受控回归在 `d853685` 上实际令旧动作重新绘制并失败；现保留已有最长期限，回归修复后通过，连接、路由、服务和视觉组件联合检查 110/110。该问题发生在受控的较长动作期限场景，不声称已在真实浏览器自然发生。由于当前源码随后改变，`d853685` 的[完整浏览器工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43715794346)已主动取消，不记作通过；后续候选 `0324364` 的结果另计。

包含重复释放修复的候选 `03243642bb201f112eb246b4e72d8941d6d812c5`，其 211 份 browser、运行时、契约及正式工作流支持文件与当前工作树逐字节一致。[三平台专项检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43716122694)在 Linux、Windows 和 macOS Intel 各通过 3 个组件用例及 1 个真实 Chrome for Testing 用例，四次任务后各保留 1 个未过期标记。本机以 Node 24.22.1 和 pnpm 10.34.5 执行 `pnpm check`，1393 项中 1366 通过、27 个按平台跳过、0 失败/取消。[三平台 Core 复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43716122723)的第二次尝试通过：Linux/macOS Intel 各 1366 通过、27 跳过，Windows 1361 通过、34 跳过，均无失败或取消；该 CI 分别执行同一类型检查、构建和测试，并增加测试事件记录及期限。第一次尝试主动取消，不作为通过证据。

同一候选的[完整浏览器工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43716122721)三平台通过：主要原生 Chrome for Testing 场景各 50/50，均实际包含视觉身份清理与并发关闭回执；组件检查 macOS Intel 194/194，Linux/Windows 各 193 通过、1 个 Mac 专属用例跳过。Linux 原生用户取消、三平台 WebMCP 和公开 Docs/YouTube/Sheets/Slides 场景、macOS Edge 双配置与视觉场景均通过。先前独立 Mac Edge 聚焦失败及下载文件身份缺口仍保留，不能由本轮通过推断已解决。

为覆盖本次视觉修改，后续安全候选 `599c49ed79dce0fc065b4a808111f309242b0afb` 仅在 `0324364` 上新增两份隔离 Edge 检查工作流；相关 211 份源码和测试文件再次与主工作树逐字节一致。[Linux Edge](https://github.com/bYiyLi/NexumAgent/actions/runs/43716816932)及 [Windows/macOS Intel Edge](https://github.com/bYiyLi/NexumAgent/actions/runs/43716816989)的真实浏览器前置检查各 1/1、主要场景各 49/49 通过，均包括实际视觉身份清理；分别使用 Edge 157.0.4341.46、156.0.4314.58 和 151.0.4129.101。macOS 本轮后台指针和视觉反馈用例通过，但先前独立失败的原因仍未闭合；该结果也不代表其他 Edge 版本、用户本机或完整逐成员矩阵已完成。

`ad912a7` 的 [Mac Edge 聚焦检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43709030470)仍未观察到首个后台指针，鼠标动作历时约 16.2 秒，该场景失败；不能将连接关闭竞态的修复解释为后台视觉问题已解决。三个平台的完整 browser 检查及 Windows 启动阶段隔离探查结果如下。

该候选的[完整 browser 工作流](https://github.com/bYiyLi/NexumAgent/actions/runs/43709030444)在 Linux、Windows、macOS Intel 三个平台通过：每个平台的主要原生 Chrome 场景各 48/48，Mac Edge 双配置和视觉场景 2/2；Linux 的原生取消、各平台开启 WebMCP 的注册调用及公开站点检查也完成。组件检查 Mac 为 190/190，Linux/Windows 各 189 通过、1 个 Mac 专属保护测试按平台跳过。当时该候选的 30 个 browser 生产文件与工作树逐字节一致；随后调整了上述会话身份校验顺序并增加对应测试，新源码验证另计。此轮通过不消除上述独立 Mac Edge 聚焦失败，也不等于原始下载正向取回或 250 项完整原生验收已完成。

[Windows 启动阶段隔离探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43709299923)使用包含诊断的独立测试提交 `ea53f5e`，顺序启动 16 个全新测试浏览器配置，16/16 均在线并完成页面读取，0 跳过。该诊断提交附加记录启动阶段，没有进入产品源码；本轮未复现此前的未上线故障，不能证明其原因或以此覆盖原失败。

包含上述连接及样式恢复修复的候选 `36ca023` 的[Mac Edge 聚焦检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43708252682)中，首个后台指针仍未观察到，鼠标操作约 7.8 秒结束，场景失败；页面随后出现前台图标和指针。连接、路由、服务及视觉组件在当时源码上共 105 项通过；该次 Mac 后台慢响应不能视为已修复。对应三平台 browser 检查的终态另记。

该候选的[三平台 browser 检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43708252803)中，Linux 与 macOS Intel job 通过，Mac Edge 两项也通过；Windows 的 48 个主要原生场景为 47 通过、1 失败。失败发生在组织操作业务代码之前：测试页面及扩展 worker 已存在，公开在线 peer 数为 0，Agent 没有收到连接诊断；诊断主动建立的测试 WebSocket 能完成握手。原因仍未知，不能把这次失败归因于任一组织操作或新修复，也不能用 Mac Edge 的通过覆盖单独的聚焦失败。

同一候选的[隔离 Mac Edge 带界面检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43708648587)也未观察到首个后台指针，鼠标操作约 6.6 秒结束，之后前台图标和指针出现；因此不能把后台慢响应简单归因于无界面模式。该测试仅使用 GitHub 执行机上的临时浏览器配置，没有操作用户电脑。

包含 `36ca023` 的隔离候选 `b14a963` 在 Linux、Node 24.22.1 和 pnpm 10.34.5 执行仓库要求的 [`pnpm check`](https://github.com/bYiyLi/NexumAgent/actions/runs/43708527915)，1393 项中 1366 通过、27 项按平台跳过，0 失败/取消；候选只另加执行工作流。后续 closing 连接修复位于可选 browser 包，不能把该 Core 检查当成其浏览器验收。

独立审阅另发现：一次原生指针样式注入明确失败后，旧的失败 Promise 会被继续复用，导致后续动作无法恢复。现仅在浏览器实际拒绝该注入时撤下对应缓存，供后续动作重新准备；迟到的旧文档失败不得移除新文档的缓存，也不重发原业务动作。前者的受控回归在修复前失败、修复后通过，后者另有竞态回归；当前连接、路由、服务和视觉组件合计 102/102 通过。此次诊断中的 Mac Edge 调用是缓慢返回而非上述注入拒绝，不能将其失败称为已修复，当前源码的跨平台浏览器检查另计。

按现有 SDK 清单复核定位器时，分别复现两个会影响后续页面操作的问题：没有匹配元素时 `last().count()` 错误返回 `INVALID_ARGUMENT`，导致依赖该定位器等待新元素也不能正确工作；`or()` 结果按左右条件的书写顺序拼接，而不是页面元素顺序，调用 `first()` / `last()` 可能取得错误目标。前者在远端 Node 24.22.1 中执行实际序列化页面函数复现，后者在远端 Node 24.15.0 同样复现；这些是受控 DOM 夹具证据，不冒充真实浏览器。联合结果的页面顺序也与 [Playwright 上游实现](https://github.com/microsoft/playwright/blob/main/packages/injected/src/injectedScript.ts)一致。

修复保留空定位器直到匹配元素出现；联合结果去重后按当前文档顺序排列，不改变跨目标和跨 frame 的既有身份检查。新增组件和原生场景分别覆盖空结果、后续出现、first/last、越界、反向联合、去重和真实清理。远端原生 Linux 的 Node 24.22.1 上，`mv3-router.test.mjs` 为 60/60 通过、0 跳过；62 个成员已关联到原生用例定义，链接不代表完整逐成员验收。

安全 CI 候选 `17e9a1eaf05c38d8f52c9d28d3f83b82233cd63b` 的 [browser 检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43677934946)在 Linux、Windows 和 macOS Intel 均通过。三份原始日志确认：实际 Chrome 前置各 1 项、随后各 44 项通过且无跳过，新增原生场景在三平台均执行；macOS 的 Edge 双配置与视觉清理另 2/2。macOS 组件 171/171，Linux 和 Windows 各 170 通过、1 项 macOS 专属检查跳过；WebMCP、公开 Docs、YouTube、Sheets 和 Slides 专项均通过。该候选的 Core 与安装检查也分别三平台通过。

后续候选 `5c468f2714f786864a1b24f3cc809a56c9a5e2e4` 只增加安装后服务进程树的测试；`packages/browser` 的 Git 子树在两候选均为 `8ea097686a47d1ca61538fdeba36e2eb7ff3f7f6`，因此浏览器证据属于 `17e9a1e` 的相同浏览器代码，不声称 `5c468f2` 另外运行了 browser CI。该证据仍不覆盖用户本机 Edge 弹窗原因或完整 250 项矩阵。

再次核对下载身份时，[Page.downloadProgress](https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-downloadProgress) 有原始 GUID 但没有文件路径；[Browser.downloadProgress](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#event-downloadProgress) 的路径是可选值，且 Browser 域不在[扩展 debugger 允许的域](https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains)中。现有公开接口仍不能据此将页面原始下载与本机文件可靠绑定；`download.path()` / `tab.saveDownload()` 的正向取回继续未完成。

进一步检查 Chromium 当前 [Page handler 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc)发现，`Page.setDownloadBehavior` 虽然属于 Page 域，其实现会将操作交给当前 `BrowserContext` 的 browser handler；[协议定义](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-setDownloadBehavior)也未提供按 GUID 命名选项。因此不能把它当作只影响一个标签页、能够绑定原始下载身份的安全替代方案。本次只是源码核对，没有在用户浏览器调用或改变下载设置。

另核对 [Chromium 下载数据库源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/history/core/browser/download_database.cc)，其内部表包含 GUID 和路径字段，但这不是浏览器扩展的公开下载身份接口。独立测试只使用临时 profile 和合成下载；[首次探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43702754800)因测试脚本重复声明变量而在编译阶段失败，[修正后的 Linux Edge 探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43702936263)先确认下载完成，再以只读方式按原始 GUID 查询本测试浏览器自己的数据库，15 秒内没有取得对应记录，最后一次错误为数据库锁定。该结果不能代表其他浏览器或所有运行状态，也没有读取任何用户浏览器资料；目前不能依此实现下载取回。

### 控件禁用状态（2026-11-15）

检查 `locator.isEnabled()` 时，在远端隔离的 Node 页面函数夹具复现：禁用 `fieldset` 内的输入框自身 `disabled` 属性仍为 false，旧实现因此误报可用。修复后使用浏览器原生 `:disabled` 判断控件的实际禁用状态，并沿祖先读取 `aria-disabled`，尊重最近的显式 `false`；同一状态也用于动作前检查。行为参考 [Playwright 的 enabled 判定](https://playwright.dev/docs/actionability#enabled)及其 [ARIA 实现](https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/roleUtils.ts)，核对日期 2026-11-15。新增组件用例覆盖原生禁用、继承的 ARIA 禁用、显式覆盖及普通控件，远端 router 组件检查 61/61 通过。

安全候选 `1d1229b639fc03e61f72d8093c335d3f6eefdaee` 的 [browser](https://github.com/bYiyLi/NexumAgent/actions/runs/43681330421)、[Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43681330424)和[安装](https://github.com/bYiyLi/NexumAgent/actions/runs/43681330491)均三平台通过。逐份 browser 原始日志确认新增场景在 Linux、Windows、macOS Intel 的真实 Chrome 均实际通过：禁用时动作不触发，解除禁用后才可操作，`fieldset` 首个 `legend` 内控件保持可用。三平台各执行前置 1 项和原生场景 45 项，均无失败、取消或跳过；macOS 的 Edge 隔离与清理另为 2/2。browser 组件为 macOS 172/172，Linux/Windows 各 171/172，1 项 macOS 专属保护按平台跳过。

`B116` 已关联该原生用例，该候选共 63 个成员关联了至少一个原生用例定义，不代表 250 项完整矩阵完成。候选浏览器子树为 `d86cfb2afa07cdcdb2e5d6db54704d644e5cf862`；主开发工作树仍未最终提交，原始下载正向取回和真实用户 Host 等缺口不受本轮通过影响。

### 文本定位与已有用例索引（2026-11-15）

远端页面函数夹具复现旧文本定位的四个偏差：带换行或多空格的文字和按钮 `value` 找不到，脚本正文被当成页面文字，按文字过滤也不归一化空格。修复后字符串匹配归一化空白，按钮/提交/重置输入按实际 `value` 匹配并排除脚本、样式和文档头内容；正则继续使用原始文本，范围定位和过滤沿同一文字提取规则。行为参考 [Playwright Locator 文档](https://playwright.dev/docs/api/class-locator#locator-get-by-text)与其 [文本匹配实现](https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/injectedScript.ts)，核对日期 2026-11-15。远端 router 组件检查 62/62 通过。

安全候选 `3970e0033bc757c693682ccdfa63ebb6784d5389` 的 [browser](https://github.com/bYiyLi/NexumAgent/actions/runs/43682724042)、[Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43682723985)和[安装](https://github.com/bYiyLi/NexumAgent/actions/runs/43682724004)均三平台通过。逐份原始日志确认新增文本定位用例和既有框架、媒体、定位器用例在 Linux、Windows、macOS Intel 实际通过；各平台前置 1 项和原生浏览器场景 46 项均无失败、取消或跳过。

随后将四个已在上述三平台真实运行的既有用例关联到能力清单，增加 59 个此前没有关联的成员；当时共 125 个成员有至少一个用例入口，250 项 `nativeAcceptance` 仍全部为 `not_run`，不能把关联数量当成完整验收比例。引用文件、测试名和所有关联均已核对，唯一改动是 `implementation.json`，并已提交安全候选 `1984cd61b04ce6fe0c4ab9f7f5647ee14798028e`。该提交的 [browser](https://github.com/bYiyLi/NexumAgent/actions/runs/43683771770)、[Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43683771762) 和[安装](https://github.com/bYiyLi/NexumAgent/actions/runs/43683771731)检查均在 Linux、Windows、macOS Intel 通过；其 CI 结果与 `3970e00` 分别记录。

继续逐一核对既有测试的源码、断言及 `1984cd6` 三平台原始日志，补录 20 个已执行场景和现有场景的关联，当时工作树有 242 个成员至少关联一个实际用例。关联只表示可追溯的局部证据，不表示权限、失效、取消或平台矩阵已全部通过；例如 `download.path` 和 `tab.saveDownload` 目前关联的只是无法确证身份时的拒绝场景。250 项完整原生验收状态仍均为 `not_run`，该轮只修改证据索引，没有新增浏览器测试或重新运行旧用例。

安全候选 `06ec7b858d1528f135dfbb684ff4102da8ce4025` 新增页面滚动、按键和等待的实际效果断言，并在开启 WebMCP 的场景中调用三个直接入口及失效注册。[browser 检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43688881044)的 Linux、Windows 各有 47 个原生场景及 1 个开启 WebMCP 的场景通过，新增断言实际执行；macOS 组件检查中，2 MiB 二进制回包在该测试的 500ms 操作期限内未完成，导致 172 通过、1 失败，原生场景没有执行。后续只调整该数据完整性测试的观察期限，仍保留独立超时和迟到结果检查。

随后 `a7e477e4897d9eb4b2c53f409c456c245b96a09d` 的 [browser](https://github.com/bYiyLi/NexumAgent/actions/runs/43689537818)、[Core](https://github.com/bYiyLi/NexumAgent/actions/runs/43689537806)和[安装](https://github.com/bYiyLi/NexumAgent/actions/runs/43689537797)检查均三平台通过。三份 browser 日志确认新增滚动/按键/等待实际效果与 WebMCP 的开启场景均在三平台执行：主要原生 Chrome 场景各 47/47，macOS Edge 聚焦场景 2/2；macOS 的二进制回包测试亦通过。Windows 的进程清理测试先观察实际 backend 和进程树关闭，再验证未确认状态及明确重试，亦通过；不能据此确定上一轮等待超时的原因。对照这些新用例，为 B050、B071、B087、X004、X041、X042、X043 增加局部证据关联，当时有 249 个成员关联至少一个场景，全部 250 项完整原生验收仍为 `not_run`。

### 下载身份的网络事件探查（2026-11-15）

在 GitHub Linux 执行机的隔离 Chrome for Testing 160 profile 中，以自有回环服务提供 24,576 字节、分块延迟的合成下载，并通过实际扩展的 `Network` 事件流观察。对照请求的 `Network.requestWillBeSent/responseReceived/dataReceived/loadingFinished` 均能看到；服务器确认下载请求只发生一次，页面能收到 `Page.downloadWillBegin/Progress`，但多次读取及最终未截断的事件列表中均没有该下载的 `Network.requestWillBeSent`，因此没有可传给 `Network.streamResourceContent` 的该下载 requestId。[探查运行](https://github.com/bYiyLi/NexumAgent/actions/runs/43685649377)使用独立测试提交 `1de9624d964178d9da7258c9f1b8ed6dd12d6578`，是诊断而非产品实现或完整验收。此结论只覆盖所测的同源链接下载，不排除其他下载形式或不同接入方式；原生下载 path/saveDownload 的可靠身份与正向取回仍未完成。

后续 [Fetch 响应拦截探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43685904550)在诊断脚本读取结果时因 `data` 不可用而失败，尚不能据此判断拦截是否可行；输出过大是待复核的可能原因。该失败未发生在用户电脑，也不算产品验收通过或功能缺陷结论。

将诊断结果改为只返回长度与内容比较后，[同环境后续探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43686069339)观察到目标 HTTP 响应可被 `Fetch` 暂停；`Fetch.getResponseBody` 返回的 24,576 字节与合成源完全一致，继续请求后浏览器报告下载完成，服务端只收到一次请求。先前失败的确切原因仍未保留到足够证据，不能仅凭本次通过断定其原因。该结果只证明单标签、单次、小型 HTTP 下载的可行性，尚未验证浏览器实际落盘字节、并发同 URL 的事件归属、其他下载类型、大文件预算、取消及多平台，因此不能作为 path/saveDownload 完成证据。[CDP Fetch 定义](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)规定 `getResponseBody` 一次返回完整正文，而取得流之后不能原样继续原请求；这些边界需要在实现前解决，未对用户浏览器启用拦截。

[后续隔离探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43686368285)核对了单次下载的浏览器实际落盘内容；另外让两个受控标签同时请求同一个 URL，服务分别返回不同内容，两边的暂停事件、响应字节、下载 GUID、目标标签及两个实际落盘文件均符合对应事实。该证据仅覆盖两个标签、受控的 HTTP 小文件，不能由此推断同一标签中的并发、拦截前已在途请求或其他下载形式可可靠关联；产品实现仍未接入该试验方案。

[同标签并发探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43686628286)向同一个 URL 发出两次实际请求，但观察期只捕获到一个暂停事件，后续观察没有收到下载开始事件或下载记录。该实验没有确认两条请求的完整终态及浏览器取消原因，不能据此推断所有同标签并发都会失败；它至少表明“只观察到一个暂停事件”不足以证明只有一次请求或据此认领下载身份。

另一个仅限隔离 profile 的[身份标记探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43686971155)已观察到修改后的合成文件名出现在 `Page.downloadWillBegin` 和下载记录；之后测试夹具因把 DevTools 异步通知当作请求响应而失败，未验证 `chrome.downloads` 的数字 ID、文件名还原或最终方案。该失败不作为用户浏览器问题或产品功能通过的证据。

修正测试夹具后，[后续隔离探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43687182015)对单个 24,576 字节 HTTP 下载验证了：响应中的唯一标记同时到达页面下载事件和 `chrome.downloads.onDeterminingFilename`；测试监听器据此记录数字下载 ID、恢复原文件名，再按该 ID 查到完成的真实文件并核对字节。测试监听器由隔离夹具动态安装，当时尚未验证实际 MV3 worker 重启、扩展被停用、其他扩展竞争、无 `Content-Disposition`、blob、并发/中断或大文件等情况。该轮发生时用户尚未确认文件名方案；之后用户同意保留带编号的下载文件名，当前实现和验收结果见下文“浏览器下载固定与资源读取”。

为避免改动文件名，又在[隔离探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43687843524)中尝试给请求 URL 的 fragment 加入标记；服务器只收到一次原始路径、文件名保持不变，但页面下载事件及 `chrome.downloads` 的 URL 都不包含该标记，因而这一做法不能在该场景中连接两个下载身份。测试仅覆盖所测单个 HTTP 下载，不把它推广为所有可能的接入方式均不可行。

原生协议中 `Browser.downloadProgress` 的完成事件可携带同一 GUID 的 `filePath`，但该字段本身为可选，文件存在仍须核实；[Chromium 协议](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.27/third_party/blink/public/devtools_protocol/browser_protocol.pdl)与 [Chrome 扩展调试 API](https://developer.chrome.com/docs/extensions/reference/api/debugger)表明，普通扩展的调试入口不开放 `Browser` 域。现用的 `Page.downloadProgress` 不含路径，[Chromium 页面处理器](https://github.com/chromium/chromium/blob/main/content/browser/devtools/protocol/page_handler.cc)也只发送 GUID、字节数和状态。不能把另一个受限接口的可选字段当作当前扩展已能读取的事实，也不为获取它改变用户浏览器下载行为。

[Chrome 官方直连能力](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)要求用户在 Chrome 144 及以上主动启用远程调试，并在连接时确认；该连接可访问整个浏览器配置的数据，不等同现有扩展的单标签调用。另据 [Browser 协议](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setDownloadBehavior)与 [Chromium 实现](https://chromium.googlesource.com/chromium/src/+/8b96632ef93385dbf3039bb44b9447240102dbd9/content/browser/devtools/protocol/browser_handler.cc)，下载事件默认关闭，启用需要调用设置浏览器上下文下载行为的接口，返回路径仍可能不存在。该方式尚未实现或验证，也没有修改用户浏览器设置，不能作为当前插件解决下载身份的证据。

[Blob 下载探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43689337286)使用独立提交 `31bee208f5f297d424915e5afac2bec78185b8fd`，在 Linux 隔离浏览器中连续下载两个同名、不同内容的合成 Blob；页面事件中两条 Blob URL 与 GUID 各不相同，浏览器均报告完成，随后从仍存活的原页面按 Blob URL 读取到各自字节，与浏览器保存的两个合成文件内容集合一致。撤销一个 URL 后，该 URL 无法再读取。该探查通过页面主世界执行 `fetch`，未证明其不受网页篡改；它也没有将 GUID 与浏览器实际路径配对，未覆盖页面导航、URL 提前撤销、其他 frame、大文件或跨平台，不能代替原生文件身份或完整下载验收。当前没有把该方式接入产品，也没有修改用户文件。

[后续隔离世界探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43689654075)在同类合成下载页面故意替换页面 `fetch`，使主世界读取到伪造的 `[90,90,90]`；根据原生下载事件的 frame 身份创建的隔离世界在同一场景读取到真实 `[31,32,33]`，与实际保存的三字节文件一致。该结果只覆盖一个仍存活的顶层页面及其极小 Blob，不构成对恶意页面、生命周期、文件路径关联或跨平台的完整安全证明，也没有接入产品。

### Linux 原生调试取消（2026-11-15）

为补验 Linux 的原生调试取消，[独立 CI 探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43690085620)使用自己的显示服务、临时 Chrome profile 和测试页面；页面与原等待器达到就绪，但自动观察没有识别并点击取消控件，等待器随后按期限超时，测试失败。截图可见浏览器有折叠的额外提示，尚不能由此认定原生取消功能失败；该轮没有在用户电脑执行，也没有取得 Linux 原生取消通过证据。

[后续探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43690764951)增加真实等待器就绪标记，识别并点击了折叠提示的数量标记，但仍未识别到调试取消按钮；到观察期限后测试夹具退出，截图仍显示独立浏览器的命令行提示。该轮没有执行取消动作，也不作为产品行为的失败或通过证据。

[再次探查](https://github.com/bYiyLi/NexumAgent/actions/runs/43691001559)在同一隔离条件下关闭了夹具的命令行提示，截图显示了真实调试提示与蓝色 Cancel 按钮；文字识别将按钮识别为其他字符，自动脚本仍未点击，故该轮没有原生取消行为的通过或失败证据。

[隔离 UI 复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43691224705)在 Linux 实际点击了测试浏览器的原生 Cancel 控件：同一运行的下载等待和后续页面写入均返回 `USER_TAKEOVER`，新的运行读到取消前的页面值，1/1 通过。该测试使用临时 profile、自有页面和合成运行，161 份相关运行时、契约及 browser 生产源码与当前工作树逐项一致；测试源码与现有手工测试仅增加就绪文件通知及格式调整。当前已将该局部证据关联到 X055，250 个成员均有至少一个场景链接，但下载正向读取等完整行为及跨平台矩阵仍未完成，所有成员的 `nativeAcceptance` 保持 `not_run`。

可复用 Linux UI 检查已加入 browser 工作流，并对非隔离的 GitHub Linux 执行环境直接拒绝启动。安全候选 `d2d8bda11fdf286cf568a5f6533c6bc3ed18f795` 的[集成 browser 检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43691685560)三平台通过；逐份日志确认三平台主要原生 Chrome 场景各 47/47、WebMCP 正向场景均通过，Linux 新增原生 Cancel 场景 1/1、macOS Edge 聚焦场景 2/2。新 UI 场景仅在 Linux 自动运行，不能据此宣称 Windows 原生取消已验收；本机保护在缺少 CI 环境和使用普通 Chrome 路径的两种条件下均实际拒绝。该候选只涉及测试、工作流及证据索引，与此前 `a7e477e` 的生产源码一致；由推送自动触发的重复 Core 和安装检查被主动取消，Core/安装证据仍分别属于 `a7e477e`，没有把取消的检查算成通过。

### 浏览器下载固定与资源读取（2026-11-15）

按用户确认的方案，浏览器在该次受控下载的文件名中保留唯一编号，并建议放入默认下载目录的 `Nexum` 子目录，不更改全局下载位置。明确等待的 HTTP 附件通过原响应文件名关联下载事件和浏览器记录；受控点击触发的 HTTP、Blob、data 下载链接在点击期间临时设置编号，随后恢复网页链接属性。只有身份、实际完成状态及路径授权均满足时，Agent 才固定文件；脚本通过 `output.file` 登记 Agent 的标准 MCP Resource，再按 Resource 读取。原浏览器文件保留，无法确认身份时明确拒绝。

[三平台专项](https://github.com/bYiyLi/NexumAgent/actions/runs/43726987057)使用独立候选 `e7ba3652a2fe6578eb8c3b25677aa788509d03d5` 和各平台隔离 Chrome profile，Linux、Windows、macOS Intel 分别执行 7 个真实浏览器场景，均通过。覆盖 HTTP 附件与无附件响应头链接、直接 Blob/data、同一次点击中同步创建并触发的 Blob 链接、其他标签的同 URL 不同内容下载、等待前已开始的下载，以及 `path`、`saveDownload` 和资源读取的实际字节。另有下载身份、重复编号和取消清理的组件检查；相关 161 份运行时、契约与浏览器产品源码与当时工作树逐字节一致。

资源读取证据来自实际 Agent 结果编码与资源读取实现，尚未覆盖真实用户 Host 到 Cloud 的完整下载链路。部分异步生成、未连接页面、跨 frame 的下载暂不能确保关联；MV3 重启、其他扩展竞争和全部成员的完整平台矩阵也不能由该专项推断。早先将 Blob URL 再次读取的[独立尝试](https://github.com/bYiyLi/NexumAgent/actions/runs/43724658424)未能确证原始下载身份，相关方案未进入当前实现。此前本机 Edge 弹窗原因仍未知；本次验证未操作用户的浏览器、钥匙串或下载目录。

后续 review 发现浏览器已提供的文件大小没有传入 Agent 固定文件检查。现在使用 `DownloadItem.fileSize` 的解压后字节数，存在已知大小时与实际文件核对，不把传输字节数误作文件大小；`-1` 表示未知，按实际文件处理。模拟浏览器事件经真实扩展和运行时取回文件的回归确认大小不一致返回 `FILE_SIZE_MISMATCH`，原文件不变；另验证未知和非法大小的处理。最新产品源码的浏览器全量跨平台检查单独记录，不沿用前一个候选的结果。

大小校验修正前的候选 `b5bada74f3ee990487ffbb36c642ee9247469716` 的[完整浏览器检查](https://github.com/bYiyLi/NexumAgent/actions/runs/43727338279)三平台通过：主要原生 Chrome 场景各 55/55，Linux 原生取消 1/1，macOS Edge 2/2。该结果只对应该候选，不覆盖之后的文件大小检查。

大小校验修正后的候选 `7068935e6c3a17109f82e27e0d7b4571a7b39fbc` 的[首次完整复验](https://github.com/bYiyLi/NexumAgent/actions/runs/43728230849/attempts/1)中，三个系统的主要原生场景均为 55/55，Windows 和 macOS 工作流通过，macOS Edge 为 2/2。Linux 的组件检查通过 200 项、按平台跳过 1 项，原生取消通过；公开视频测试页面被重定向到 `google.com/sorry/index`，未进入视频，测试失败，该 job 后续站点场景未执行，首次运行总体失败。[第二次运行](https://github.com/bYiyLi/NexumAgent/actions/runs/43728230849/attempts/2)仅重跑 Linux，55 个主要原生场景、原生取消和包括 YouTube 在内的公开站点检查均通过，工作流总体通过；Windows/macOS 使用第一次同一候选的通过结果。候选与工作树的 198 份相关源码、测试及脚本逐字节一致，未比较开发记录和部分说明文件。

### 浏览器下载列表与资源交付（2026-11-15）

用户确认直接提供当前浏览器配置的正常下载列表，不按目录筛选。`selected.downloads.list()` 返回浏览器记录及其 `filename` 路径；列表并不声称当前运行触发了该下载。AI 可选择完成的文件并调用 `output.file`，内容读取与资源登记仍执行现有授权和预算检查。

候选 `a3ee46f7481e2b92a30fd57f66a2f76c9f65b49f` 的[隔离专项](https://github.com/bYiyLi/NexumAgent/actions/runs/43732482878)在 Linux、Windows 和 macOS Intel 均通过 3 项组件检查及 1 项真实 Chrome 场景。场景在一次运行中触发延迟下载，在下一次运行从浏览器历史取得原始路径，使用实际 Agent 结果编码和资源读取验证完整字节；组件检查确认跨目录记录不因文件读取授权被筛除，而实际 `output.file` 读取拒绝未授权路径。该测试没有使用用户浏览器，也没有经过真实用户 Host。此前的[首次专项](https://github.com/bYiyLi/NexumAgent/actions/runs/43732195077)因测试脚本重复声明变量在编译阶段失败；已修正测试脚本，不能把失败算作浏览器功能的通过或失败证据。

随后检查正式 Agent 时发现其默认已知权限未包含浏览器扩展所声明的 `connection`、`path`、`resource` 和 `url`，会阻止扩展启用。已将这四类登记为通用扩展权限，保留当前调用者的实际路径授权；应用级回归在修复前以 `invalid_extension_permissions` 失败，修复后能加载扩展并拒绝未授权路径。本机 macOS/arm64 的 Agent `pnpm check` 复验共 1394 项，1367 项通过、27 项按平台跳过。首次全量有一项独立 MCP stdio 夹具未及时启动，该项单独复验和后续全量复验通过；不能据此判断首次原因。尚未将浏览器下载链路经过真实用户 Host 的交付记为通过。
