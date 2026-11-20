# Nexum browser

Nexum browser 是 Nexum 官方维护的可选浏览器控制扩展，源码与完整开发资料归 Agent 项目，作为独立 npm 包 `@nexum-hub/browser` 发布。它使用 Nexum 公共扩展协议，不是 Agent 默认依赖，不随 Agent 默认安装，也不因包已下载就自动启用。本文件及下列正文定义产品合同；候选代码、组件与部分原生验证已经存在，完整验收和 npm 发布尚未完成，实际进展见[原生验收记录](../development/browser-native-acceptance.md)。

## 交付边界

浏览器交互默认以可靠性优先：AI 负责定位页面目标与描述可验证的业务预期；Browser SDK 负责原生输入调度、页面/Frame 就绪、真实事件回执、有限稳定窗口和条件等待。高层 `locator.click({expect})` 复用原有 `WaitCondition`，只在匹配页面条件后返回验证快照；`tab.observe()` 复用 AX 全量/差异、标题与 URL。可信点击事件确认与业务成功是不同层级，不能把 Chrome 原生命令成功冒充业务完成；未知效果不自动重放。原生 Chrome/Edge 和三平台验证仍须按当前发行版本分别取证。

- 官方内置能力包表示由 Nexum 维护、与 Agent 在同一仓库开发、使用同一公开协议；不表示固化到 Agent 二进制或启动路径。独立版本、npm 制品和浏览器插件版本分别记录。
- 范围为 Avru 已确认的完整浏览器控制：22 接口/148 成员及 102 条额外验收项（便捷入口/属性/别名/接线），包括原始接口外的浏览器管理/资产/导出/WebMCP/CDP，以及控制可视化、文件与媒体、恢复、审计和真实验收。已确认的 botDetection 不实现、Host 专属 iab/mcpapps/siwc 后端不适用；对应通用浏览器能力按本文档原生实现，不能借不适用删掉 148 行。
- 运行链为 AI Host → Nexum MCP/Cloud → Agent Node 运行 → browser 受管 SDK → 本机 WebSocket → 浏览器插件 → 已打开的浏览器。Agent 不内置 browser 包名、端口、CDP、标签页、Locator、专属表或专属生命周期 hook。
- 浏览器插件以 Avru 的浏览器能力设计为依据，由 Nexum browser 自己维护。没有 Avru daemon、QuickJS、Avru 六工具或 FRPC 运行依赖。Nexum 原有 8 个模型工具及标准 Resources 不增加浏览器专用工具。
- 目标浏览器后端为 Chromium MV3 插件，首期正式验收矩阵为 macOS/Linux/Windows 上的 Chrome/Edge；具体版本与架构在真实发行验收记录。其他 Chromium 品牌逐项记录，Firefox/Safari、系统应用控制和任意浏览器原生不支持功能不据此宣称支持。
- 已获客户端/设备访问及扩展启用后，AI 自动发现和操作同设备现在及后续连接的可控标签页；不增加人工认领、逐动作审批或单 origin/CDP 命令白名单。平台当前身份/Grant、扩展权限、浏览器自身限制仍检查。

## 文档责任与阅读顺序

| 文档                                                                               | 完整责任                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [architecture.md](architecture.md)                                                 | 包、公开客户端、受管方法、插件与核心分工；目录、配置和协议适配        |
| [sdk.md](sdk.md) / [sdk-types.md](sdk-types.md)                                    | 全部公开接口、类型、原生映射、错误、默认规则与额外能力                |
| [capability-matrix.md](capability-matrix.md) / [JSON 清单](capability-matrix.json) | 22/148 与额外 102 项的稳定 ID、目标和契约映射；进展由开发记录维护     |
| [connection.md](connection.md)                                                     | 插件安装、loopback 端口、环境/设备身份、WS/动作/二进制、重连与故障    |
| [lifecycle.md](lifecycle.md)                                                       | 初始化、共享资源、单次调用、锁、取消、停用/升级、Agent 退出/重启      |
| [interaction.md](interaction.md)                                                   | 页面观察、引用、虚拟鼠标/标签组/favicon、前台跟随、用户停止与原生限制 |
| [results.md](results.md)                                                           | 截图、文本、附件/文件、导出、下载、标准内容与 Resources、历史         |
| [packaging.md](packaging.md)                                                       | 官方可选 npm 包、浏览器插件、四类贡献、独立版本和发布验收             |
| [acceptance.md](acceptance.md)                                                     | 功能、失败/竞态、完整能力、真实环境、制品与不侵入核心验收             |
| [platform-contract.md](platform-contract.md)                                       | 本包使用的公共协议、无私有回调接入、一般能力与接线前提                |
| [sources.md](sources.md)                                                           | 设计来源、参考材料的分发边界及当前合同的裁定                          |

本文档组是浏览器扩展的现行设计正文。未确认再分发权限的第三方原始材料只保留在本地参考中，不随公开仓库分发；其历史指令不覆盖当前合同。设计、实现、局部测试、三平台/Host 验收、提交、npm 发布和用户安装分别记录。

开发计划归主仓 Phase 48；浏览器工作是该 Phase 内部交付项，不能单独用部分 SDK 或 mock 通过宣告 Phase 完成。
