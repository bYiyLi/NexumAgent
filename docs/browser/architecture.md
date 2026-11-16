# Nexum browser 架构与包合同

## 当前问题与最小方案

Nexum 需要操作用户已有浏览器，同时保持 Agent 的运行、身份、SDK 和结果机制通用。现有公共工厂、受管方法和实例资源已经能承载本机监听与共享连接。采用一个官方可选 npm 包及配套浏览器插件；包内提供数据接口和普通 Node 客户端。无需新的执行器、通用工作流服务、browser 特例或另一个公网入口。

```text
AI Host -- MCP 8 工具 --> Cloud -- 当前 Agent 连接 --> Node 运行
  Node 脚本 -- 受管方法 --> Nexum browser 实例 -- loopback WS --> 浏览器插件
  Node 客户端（公开 Tab/Locator 等门面）               插件 -- CDP/扩展 API --> 现有浏览器
```

| 组件                   | 拥有                                                                                        | 边界                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Agent 核心             | 通用包加载/启用、方法登记、call 身份与当前授权、operation、运行与结果、资源监督             | 不导入 browser 包，不识别浏览器 ID/CDP/端口/Locator                |
| npm 扩展入口 `./nexum` | 插件连接服务、目标/引用、受管方法、锁、信号接线、资源和诊断                                 | 只使用公开 host/call，不读写内部 manager/SQLite/终态               |
| 普通 npm 入口          | `createBrowserClient(browser)`、不可变 Browser/Tab/Locator/Dialog/Download 门面、参数归一化 | 导入/构造不监听端口、不启动服务；不能获得私有 host/call/连接控制器 |
| 浏览器插件             | MV3 连接、真实浏览器 API/CDP、页面观察与操作、受限页面反馈、视觉提示                        | 不持有 Agent/Cloud Token，不直接连接 Cloud 或提供远程调试端口      |
| Cloud/MCP              | 当前授权、8 工具、标准内容/Resources 与受控二进制转发                                       | 不新增 browser_* 工具、专属运行表或专属授权体系                    |

## 普通 Node 门面与受管数据方法

Nexum 方法返回业务数据，不返回自定义控制原型、函数或 host/call。Browser/Tab/Locator 等链式对象由普通客户端在脚本侧构造：对象只含公开描述和已绑定的受管调用函数，不能缓存某个内部 Invocation 或把其他运行作为“当前运行”。

例如 `client.browsers.get(id)` 调用 `browser.browsers.get({id})` 取得经过核对的连接元数据，再构造公开 Browser 门面；`selectedBrowser.tabs.get(id)` 同理。`getByRole/nth/filter/frameLocator` 构造有界不可变 selector AST；`click/fill/count` 才把目标及 AST 交到各自受管方法。RegExp 编码为 source/flags，嵌套 Locator 按 SDK 的有界数据 AST 归一化；本地回调（expectNavigation）通过公开登记的 waiters.arm/get/cancel 先建立并确认等待就绪，再执行 Node action，函数不跨 WS。

每个 I/O 能力在扩展方法表有实际注册项、描述、输入 Schema、权限、错误与 normalize。可用 `MethodDefinition.path` 将名称映射到命名空间内的层级；同语义别名复用注册实现。禁止通过单个无约束动态 dispatch 跳过逐方法校验/operation 记录；不要求核心接收 Page/Locator 类实例或开放原始私有对象。

## 源码与制品目录

实现落点为 Agent 仓库的 `packages/browser/`；候选代码和部分验证已经存在，完整验收状态以开发记录为准。

```text
packages/browser/                 # 独立浏览器包
  package.json                    # 独立 npm 包 @nexum/browser
  src/client/                     # 普通 Node 门面和类型
  src/extension/                  # 公共工厂、方法表、连接/目标/锁/资源实现
  browser-extension/              # 配套 MV3 插件源码
  instructions/  docs/  scripts/  skills/
  test/
docs/browser/                     # 设计与验收台账
```

该包不是 Agent 默认 dependencies；工作区开发存在包目录不等于用户已安装。控制协议及插件资产随本包独立版本固定，跨包复用只走公开依赖或协议包。

## 配置与本地数据

| 项                 | 规则                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 配置来源           | 当前 profile 的显式启用配置经通用 host.config 提供；extension namespace=browser                                              |
| 监听               | production `127.0.0.1:43831`，development `127.0.0.1:43832`；WS 路径 `/nexum-browser/v1`                                     |
| 环境               | 来自可信 host.context.profile；production/development 分开。未知 profile 拒绝启用，不从 npm dist-tag 猜身份                  |
| 其他自定义 profile | 必须显式配置未冲突端口，并使用该 profile 的专用插件构建/稳定 ID；首发标准矩阵仅 production/development，不能静默共用默认端口 |
| 扩展持久目录       | `<work>/.nexum-browser/`，只放本包安装身份、浏览器 profile 映射、非敏感偏好和插件资产；不用 Agent 内部库                     |
| 插件稳定目录       | `<work>/.nexum-browser/extension/`；不从临时 npx 缓存或可变 node_modules 直接加载                                            |
| 日志               | 公开 call.log/host.log 与当前 profile 日志目录；运行日志沿平台保留策略，不另建 Avru 审计库                                   |
| 数据不持久化       | 默认不保存全部标签清单、网页正文、截图、表单输入、Cookie/Token 或 WS 短期状态                                                |
| 故障               | 端口冲突令本扩展初始化失败，保留诊断；不抢端口、不杀其他进程、不自动漂移地址或跨 profile 连接                                |

安装身份和浏览器 profileId 是路由信息，不是凭据或 OS 身份证明。配套插件的稳定 ID、公钥、协议范围与版本必须在发行元数据中固定；实际 key/ID 在构建时产生并验收，不能虚构为已经注册。

## 支持边界

保持 Avru 已确认的自动选择、全量浏览器可达 CDP、实际状态和可视化体验；将旧运行器预算、MCP 六工具、FRPC、独立 daemon、Host 专属后端和数据面编码适配为 Nexum 的公开机制。Chrome/Edge 插件权限、原生 API、站点登录/验证和企业策略造成的真实限制必须反馈，不能用“CDP 全量”宣称绕过浏览器限制。

默认浏览器选择和按 URL 匹配遵守 SDK 中的固定规则；没有全局可变“当前 AI/项目/标签页”。共享状态限于真实连接/资源，单次调用身份总由当前 call 提供。

## 无私有回调的接线核查

| 当前需求                               | 扩展自有实现                                                  | 仅使用的公共能力                                                |
| -------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 多调用共用本机端口/WS                  | 冷 BrowserService，host 归属资源                              | 工厂、host.context/config/signal/resources                      |
| run 正常结束、取消、失败都释放控制     | RunScope/目标租约，先登记后锁定/附着；dispose/closed 真正收尾 | call.context/runId、call.resources.register、标准信号与资源监督 |
| 链式/嵌套 Locator、RegExp、本地 action | Node 门面序列化纯数据；回调在 Node，先 arm ready              | 每项 MethodDefinition 的 Schema/normalize/受管 operation        |
| 网页事件早到、等待与动作并发           | 包内 waiter 缓冲和就绪屏障，等待不占住命令发送队列            | 本包登记的 waiters.arm/get/cancel；无需核心事件服务             |
| 取消/崩溃后远端附着与 UI 释放          | 插件控制租约、lease_end/closed、断线本地清理/回执             | 同一 loopback 连接与扩展资源；无 onRunEnd/UI 核心 hook          |
| 截图/文件/全文交给 Host                | 原生 bytes/本机 artifact，由脚本显式包装                      | output 与标准 Resources/transfer；无内部 ArtifactStore          |
| 主动用户接管与继续                     | 先释放目标控制，再等待用户；恢复后新观察                      | call.requestInput 的原运行输入；无特殊浏览器终态                |

上述自有对象和协议解决本包已经存在的连接、事件和收尾问题，不注册新核心服务、私有 manager 或另一套运行状态机。正式实现按 A/C/D 的公共契约接入；公共组件与产品级 npm 加载尚未全部闭合，不能把设计表视为实现证明。
