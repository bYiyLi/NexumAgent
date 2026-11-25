# Nexum browser 开发与验收

本文件定义完整交付条件，不承担当前实现状态。候选实现、组件与部分真实浏览器验证已经存在，实际源码、环境和结果由[原生验收记录](../development/browser-native-acceptance.md)维护。代码存在、Avru 历史通过、静态 capability=true、只用 mock 或一份本机候选均不等于本包完成。执行顺序与 Phase 48 的 A–G 依赖一致。

## 能力完成台账

- B001–B148 对应原始参考基线的 22 个接口/148 成员；B002/B011/B145 的独立文档能力已由 Skill 引用替代，退出当前公开成员验收，活动成员为 145 加额外 102 项；[机器清单](capability-matrix.json) 保留适配签名与契约映射，原始参考资料不随公开仓库分发。属性、重载、同步 locator/frame 组合、别名也要有实际证据，当前状态由开发记录维护。
- X001–X102 共 102 条额外验收项（含属性、同语义别名与接线方法），包含 Avru 的便捷接口、窗口/标签组/书签组织、资产、导出、WebMCP、CDP、可视化和文件/媒体。完整清单与类型在 SDK 文档，不因不计入 148 而省略。
- 每项记录实际实现文件/导出/Schema、正常用例、非法输入/当前权限、失效目标/页面、取消/超时/断连、结果交付、适用 OS/浏览器、精确 revision 与命令/结果。
- 环境原生不支持时，准确错误和限制是该环境的验收结果；至少在支持该能力的真实环境实现/验证。包未实现、文档缺项、测试跳过不能当原生不支持或完成。

## A. 通用协议与不侵入核心

1. 只装 Agent、不装 browser：无 browser 依赖、端口、扫描、SDK/资料注入；Agent 启动、运行、维护、既有 8 工具不受影响。
2. 用通用维护安装、启用、停用、更新、移除本包；Agent 主入口、内部 DDL、MCP 注册无 browser 硬编码，包不导入私有源码/manager、不写内部数据库或终态。
3. 普通 import/客户端构造无监听/I/O；SDK 返回控制对象的负例被阻止；公开 Browser/Tab/Locator 由客户端业务描述构造，实际 I/O 全部有 operation/Schema/当前 call。
4. 四类贡献整体发布/撤下，来源版本一致；命名空间冲突、旧脚本/Skill 引用、旧 ESM 不能切换时按公共协议反馈，无旁路强换版。
5. 公共 API conformance 以正式导出和真实第三方式接入验证，不能给测试工厂额外注入私有服务后声称扩展等价。
6. 正常 return、失败、取消均仅靠已登记 RunScope 的 dispose/closed 收尾；不注入 onRunEnd/RunStore/内部 ArtifactStore，收尾不调用已失效的旧 call 服务。

## B. 插件、身份与连接

1. Chrome/Edge 真实 MV3 插件加载、自动接入、多个浏览器/两个配置、相同 tabId 不串线；没有用户先选目标或手动认领前置。
2. dev/prod 同机监听、插件 ID/storage/数据隔离；错 Host/Origin/profile/协议/插件 ID、远程代理、网页 WS、未知自定义 profile 均拒绝；不读取/传递 Agent Token。
3. 端口冲突仅扩展初始化失败，不抢占/杀进程或偷偷换端口；没有浏览器在线时服务可用但列表为空，离线/服务失败不伪造空成功。
4. socket 替换、旧 close/metadata/事件、Plugin/Agent/完整浏览器重启、睡眠唤醒、MV3 worker 恢复均遵守 boot/browserSession/generation；同 worker attemptSequence 防迟到覆盖，克隆 profileId 的健康连接冲突不抢占，原生 tabId 重用不串线；不重放动作。
5. action/result/cancel/事件/二进制正确关联；乱序、重复、超大、背压、hash/大小不符、断流、回执丢失及缓存容量受控；同 action 去重不被宣传为网站 exactly-once。
6. 完整 tabs/capabilities 快照分片组齐后原子发布；错误总数/遗漏/超预算不能变成完整列表。二进制 headerLength/sequence/流并发预算、控制消息优先、CDP 大 JSON 参数与响应真实验证，不能只测小图片。

## C. 生命周期、竞态和真实停止

1. 注册冷对象 → listen → ready；并发初始化只有一个监听；初始化每个失败阶段、静态/方法/资料失败、启动/取消竞态均无端口/连接泄漏。
2. run 结束/取消收尾本次锁、等待器、订阅与临时后台标签，保留共享连接和用户/结果标签；锁重入、多个 run 冲突、跨目标原子保留/动态追加冲突无等待环；正常 return 与未 await 的已准入操作均被公共运行机制实际监督。
3. 点击/提交/下载已发出后断连/超时保持 effect=unknown，不自动重发；停止请求、真实停止、闭合证据分开。
4. host.signal、dispose、closed/清理拒绝、清理观察超时、并发/重试、晚到启动/结果、markHandoff 失败与自然关闭竞态均有实际资源验证。
5. 在途调用/脚本/后台业务资源使停用忙碌；空闲共享连接不永久阻塞；stopping 未确认不发布新版/释放身份。停用/退出释放监听及本包资源，不结束用户浏览器。
6. 用户原生调试取消/接管后，本 run 浏览器写入口失效，等待结束、UI 状态恢复，真实错误与运行结论分别保存；重启不恢复原 JS/CDP/Promise/action。
7. arm ready 前的事件、arm 失败后的 action、action 失败后的 cancel、事件早于 get、重复 get/cancel、事件到期/目标失效/运行收尾全部覆盖；pending waitForEvent → click → await pending 不自锁，导航/下载等待不占住命令队列。
8. lease_open/close 回执、socket 断连/Agent 崩溃/worker 重启/保活过期、远端清理失败或未知均验证；本机 closed 不冒充远端租约 closed，网页 effect=unknown 与真实控制已关闭可以同时存在。
9. markDeliverable 不等于 run succeeded；markHandoff 封闭该目标后重新 get 也不可写；主动 takeover 释放控制、输入续接后新观察/新租约，不能拿用户回复直接证明登录成功。

## D. 页面控制与高级能力

1. 逐项 B001–B148；搜索框填入 → 点击 → 等待 → 新观察的真实页面流程；旧连接门面及固定 ref/节点/dialog/inventory/WebMCP 失效、查询式 Locator/Frame 在当前文档正确重解、动态 DOM、多目标、跨 frame/子 target、页面导航失败。
2. 窗口/标签/组/书签逐方法、before 审计与实际顺序；跨浏览器 ID/窗口、共享组、书签目录/叶子、部分失败、用户并发变化均明确反馈。
3. 全量浏览器可达 CDP 命令、params、attached child session、事件游标/背压/截断/原生域限制；不能只测 Page/DOM 两个例子就称全部接口实现，也不要求枚举未来所有 CDP 命令。
4. 内容/资产 inventory 与 bundle、PDF/HTML/Markdown/Gsuite/YouTube transcript、视口/剪贴板/JS dialog/WebMCP 均有实际可用内容与失败路径；无注册工具不伪造。
5. 虚拟鼠标先显示再真实动作、分组命名/固定品牌色、active/结果 favicon、用户激活清除、导航重发布、前台标签跟随、原生调试取消按已定体验验证；不通过 AI 额外工具模拟这些实现。
6. 对登录/权限/企业策略/系统页面等原生限制准确反馈；不把资料中的旧确认分级、单 origin 或 CDP 白名单重新实施。
7. Avru 的 Tab/Frame/Playwright 便捷入口、Tabs.new/select、截图 quality/maxEdgePx、clickCount/position、Locator type.delayMs/press.modifiers、DOM NodeId 与 node_id 同型且不和原生 CDP nodeId 混用、导航 options、selector/text/url 等待、Dialog message/快照 dialog、Browser 元数据逐项验证；force 和未知字段拒绝，AXPoint 具名坐标与剪贴板 bytes 按当前合同。
8. AST 嵌套/跨 frame/跨目标/无效正则/环/上限、all() 固定成员与旧节点不重用；WebMCP 同名工具重新注册不得自动执行新版本，绑定门面保真；CDP 已 detach child 的缓冲事件仍可筛选，send 则明确失效。
9. Locator 自动查询当前 scope 的开放 Shadow DOM，包括嵌套根与 Slot；CSS 保持各原生根的匹配语义，跨根通过宿主链式定位，Frame 仍显式进入。覆盖同名 ID/名称歧义、组合查询、根内 IDREF 与布局分隔的名称、Slot 限定作用域及动态重分配、失活嵌套 Slot、固定引用失效（含 adopt 到其他文档）、内外层遮挡、可信点击、键盘焦点丢失、表单回读、普通及跨源 Frame 中的开放根；观察不导出闭合根内容或宣称不可验证的定位能力。文件选择和媒体读取使用实际节点、原有授权及原始字节。
10. 超时、等待与取消：从实际传输剩余时间到 MV3 原生队列、Frame 渲染、轮询和事件回执使用一致截止；测试探测耗尽预算后的真实失败和无负数定时器、过期事件与排队动作拒绝、延迟字节发送/租约确认取消后的收尾和其他任务正常执行。

## E. 文件、多媒体与 Host 交付

1. 多附件经平台完整准备；文件选择支持本机路径和真实 bytes，大于旧 64 KiB 的文件正常使用；失败/取消不交付半份文件。
2. 下载先等待再触发，实际完成/存在/可读、目标 no-replace、文件变化、丢失、流中断、权限撤销、大小/hash不符覆盖；未知副作用不再次点击。
3. 图片让模型实际收到标准 ImageContent；文本、JSON、音频、文件/文档/视频、混合结果按支持 Host 与预算真实交付；bytes 不落结构化结果或历史。
4. 标准 resources/read 按原 Run 交付的 URI 返回真实 text/blob；resources/list 不暴露 Run 产物；资源归属/profile、有效期、Task 保护和离线错误验证。资源预读不消费用户 Offer；历史回看不重截图/下载/读变化源。
5. 所有数据量/尺寸/时长/编码预算和背压按当前平台与本地协议分别检查；超限/截断明确，不能以小 fixture 或改 MIME 代替媒体支持验收。
6. 大快照先返回真实本机 artifact，不虚构 resourceUri/nextCursor；显式 output 后才注册真实资源；run 收尾不提前删除待物化结果源。下载跨页面导航仍按原 downloadId 查询，重复同名文件不误匹配。
7. 文本/多 MIME 剪贴板是真实浏览器原生能力，bytes 不 base64 落盘；权限拒绝不可用时不伪造成功或在 Agent 增加 OS 剪贴板旁路。

## F. npm、浏览器制品与支持矩阵

1. 固定本包 source SHA、Node/pnpm、公开协议版本、锁文件、浏览器/插件版本、manifest ID 和最终 tarball digest；普通与 extension 两入口均可从干净安装使用。
2. macOS、Linux、Windows 原生环境验证安装/启用/连接/停用/更新与重启；Mac 不使用 VM/依赖本地 VM 的容器。CI/授权远程机器和用户现有浏览器验收分别记录。
3. Chrome 与 Edge 及两个配置真实接入，在用户已有标签与独立测试标签均有证据；替身/临时 Chromium 结果不能冒充所有品牌、OS 登录或用户实际安装。
4. npm pack 实际字节白名单：自己的 Skill 引用与四类贡献完整，原始 Codex/Avru/平台档案、运行时依赖副本、秘密与本机状态全部不在制品。npm 发布和浏览器市场/插件安装分别授权和验证。
5. 完整 Phase 48 review：不新增核心 browser 特例；所有结论性问题修复并复验，文档/矩阵反映实际结果，按 Phase 完成门槛提交。真实发布/生产部署保留独立交付状态。

## 设计文档验证

应验证参考基线的 22/148/67 计数、成员键与目标映射完整、额外能力无遗漏、Markdown/JSON/TypeScript 片段和本地链接、Phase 48 范围/依赖/验收一致，以及实际 diff 范围。原始参考资料的许可和完整性在本地单独核验，不作为公开仓库文件。Agent AGENTS 要求的 pnpm check 结果另记录，不能替代本文件要求的真实浏览器验收。
