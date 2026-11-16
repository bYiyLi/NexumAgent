# Nexum browser 插件连接与协议

## 安装和接入

用户在 Agent 中安装 `@nexum/browser`、确认启用，再在目标 Chrome/Edge 配置安装配套 **Nexum browser** 插件。用户在浏览器原生界面确认扩展安装及其权限。Agent 默认不安装本包、不监听此端口。浏览器启动或插件唤醒后主动连接对应 profile 的本机 WS；包内服务可已就绪而没有任何浏览器在线，空连接集合不影响 Agent 的其他能力。

production 地址为 `ws://127.0.0.1:43831/nexum-browser/v1`；development 为 `ws://127.0.0.1:43832/nexum-browser/v1`。两个插件使用不同、稳定的 manifest key/ID 与 storage。浏览器界面显示产品名 **Nexum browser**，开发构建显示环境后缀。固定 ID 是来源检查条件，不宣称密码学身份。

## 本机信任与远程边界

沿用已确认的本机自动接入体验：不要求复制 token、手动逐页授权或扫码配对。服务仅监听 loopback，校验请求 Host、Upgrade 路径、精确匹配的 extension Origin、插件 ID、协议、profile 和实例绑定；拒绝网页 origin、缺失/错误来源、公网代理路径和错环境。

同一 OS 用户可模拟本地程序或 Origin，这不是本协议提供的强隔离。边界是受信本机用户与外部网页/网络；不重新把同机自动连接宣传为硬件认证。Nexum 的公网 MCP/Agent 认证、当前 Grant、扩展启用和方法授权继续生效；插件不会得到 Agent/Cloud Token。本机端口不接收 run.start、脚本、maintenance 或任意远程 JSON-RPC。

MV3 manifest 仅声明实现所需的 debugger、tabs、scripting、storage、alarms、downloads、history、tabGroups、bookmarks、clipboardRead/clipboardWrite 等及所需 HTTP(S) host 权限；最终权限清单逐方法对照验收。无痕和浏览器系统页面不伪装为可控；Chrome 原生无法开放的协议域如实错误。页面或 WebMCP 输入不能改变连接配置、授予权限或调用管理面。

## 协商与身份

初次建立后插件发送 `hello`：`{v:1,type:"hello",profile,extensionId,extensionVersion,protocol:{min,max},browserProfileId,browserSessionId,clientInstanceId,attemptSequence,metadata}`。

- browserProfileId 首次随机生成并保存在本插件 storage.local，禁止 storage.sync；它只标识浏览器配置，不作认证。browserSessionId 放在插件私有 storage.session，区分完整浏览器重启与 MV3 worker 重启；clientInstanceId 在每次 worker 启动随机生成，attemptSequence 在该实例内单调递增。
- 同一 profile 身份下，仅同一 clientInstanceId 的更高 attemptSequence 可替换自己的旧连接。另一实例占用且健康时拒绝 PROFILE_CONFLICT，不把克隆的 profileId 或晚到 hello 当作“最后连接胜出”。worker 重启等原连接实际断开/租约到期后才能替换；复制配置导致冲突时显式重置该插件本地身份，不能偷偷抢占。
- 服务校验后分配/恢复本 profile 的不透明 browserId，回复 `ready`：`{v:1,type:"ready",profile,bootId,connectionId,browserId,browserSessionId,generation,protocolVersion:1,limits}`。每次成功接纳的新连接增加 generation；服务重启产生新 bootId。旧 close/event 和迟到握手不能撤下新连接。
- ready 前不发送标签、能力、动作或二进制；两边不能用客户端自报 agentId/profile 改绑 host 真实身份。metadata 含有界名称/版本及其来源，不按 UA 推断确定版本。

随后插件发送 capabilities/tabs 完整快照，后续变化发送有界增量或重做快照。快照需带 snapshotId、分片序号/总数，服务组齐且校验预算后原子发布，不能把前一代和后一代片段混合或将被截断的数组伪装成全部标签。tabId 是该配置内原生 ID 的字符串形式，目标由 bootId/browserId/browserSessionId/generation/tabId 共同解释。导航更新 pageVersion；元素、AX/DOM 索引、dialog、WebMCP、inventory 绑定相应文档修订；下载绑定原始下载事件/连接且可跨导航等待完成；CDP child target 按真实 session/target 生命周期失效，不互相代作凭据。

普通发现默认只传有界标题和去除 userinfo/query/fragment 的 URL，不在连接时上传所有正文/截图。实际任务需要的页面内容和完整位置由受管方法按当前授权读取，审计保持脱敏。

## 消息与关联

| 消息                                  | 方向       | 必须含的事实                                                                                            |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| hello / ready                         | 双向初始化 | 协议、profile、插件及真实连接身份                                                                       |
| capabilities / tabs / metadata        | 插件 → 包  | 当前连接的真实能力、标签/版本；过期连接消息拒绝                                                         |
| action                                | 包 → 插件  | actionId、runId、operationId、connection/generation、target、method、规范化 args、剩余时间预算 budgetMs |
| action_result                         | 插件 → 包  | actionId、operationId、generation、ok；value 或 code/message/dispatched/effect、pageVersion             |
| cancel_action                         | 包 → 插件  | 原 actionId、当前连接和原因；不能被解释为远端已停止                                                     |
| event                                 | 插件 → 包  | 连接/目标、递增 sequence、类型、关联 action/等待器或有界内容                                            |
| lease_open / lease_end / lease_closed | 双向       | RunScope 的真实 run/目标/leaseId、租约就绪、幂等停止和实际清理证据                                      |
| binary_start / binary_end             | 双向       | streamId、operation/action 绑定、方向、MIME/name、声明大小/hash及最终实测值                             |
| ping / pong / error                   | 双向       | liveness 或有界协议错误；不授予额外权限                                                                 |

控制帧为 UTF-8 JSON，单帧上限 1 MiB；普通 args/value 按方法声明的数据预算，超限不把大文件塞进 JSON。二进制在同一已校验 WS 的 binary frame 传输：4-byte big-endian 无符号 headerLength（最多 4 KiB）+ UTF-8 JSON header + payload（最多 64 KiB）。header 含 streamId、sequence、actionId、operationId、generation、kind；streamId 在 binary_start 中先声明。完整 JSON 只在该流的结束/大小/hash 都核对后解析，不能让一块半帧先进入 handler。总 bytes 按平台文件/媒体预算计量。流先建关联，再接受数据；乱序/重复、错操作、错连接、超量、大小/hash不符均失败并清理未提交内容。ws.bufferedAmount 高水位 1 MiB 时暂停生产，回落再继续；不得无限排队。每连接最多 8 条活动流，发送调度优先控制/cancel/ping，二进制生产每片让出事件循环；同 WS 仍有 TCP 顺序和事件循环限制，不承诺零延迟取消。流和 args/value 的总预算也从 ready.limits 固定，不用无限 metadata/tabs 或循环开流绕过。拆片不是绕过总大小/期限检查。

动作 method 是已登记 SDK/插件路由名；CDP method 是经过结构校验的真实命令名，两者不可混淆。CDP 所有该浏览器后端可达的域与事件均可调用，不按业务类别、origin、Cookie/JS 增加白名单；浏览器 debugger 原生域限制、target 限制、扩展权限和企业策略错误原样映射。

动作在插件调度实际浏览器调用前再次核对目标、连接代次、租约、取消/期限与内部锁。budgetMs 是扩展依据方法期限、call.deadline 和本机已消耗时间计算的剩余预算；插件按自己的单调时钟消费，不信任两端 wall clock 恰好相同。timeout/取消不能证明已运行的网页同步代码可被强制抢占。同一 actionId 仅在本连接内去重：保留在途和有界完成回执 5 分钟/最多 1024 条，活跃项不可为新请求淘汰；容量不足返回忙碌。回执只帮助核对，Nexum 仍不自动重发结果未知动作；不能把它宣称为外部网站副作用 exactly-once。

## 断连、重连、故障与事件

- 握手完成后每 20 秒发送带当前 connectionId/generation 的 ping，pong 同样绑定当前连接；心跳不豁免连接身份检查。有动作待完成时，本包使用 Node 定时器为该浏览器额外发送 100ms 间隔的现有心跳，唤醒可能被浏览器延迟的插件等待；本机写入队列满或连接关闭时不绕过既有背压和断连规则。插件按自己的单调时钟确认等待期限，心跳不缩短等待、不重放动作，动作完成、取消或断连后停止额外心跳。连续 60 秒无有效消息判离线，立即清空旧实时标签/能力；旧 socket 后续 close/event 不能覆盖新代次。
- 插件按 1、2、4、8、16、30 秒上限并带抖动退避，结合 startup/alarms/browser 事件恢复；只重连和重新同步，不重放网页动作。初始化期间的多个恢复通知共享同一次初始化；旧连接关闭前不得被新连接覆盖，关闭后先开始取消和收尾，真实关闭回执可能在重连后才到达，不能提前记为完成。
- 服务停止时主动关闭所有 WS；浏览器保持打开。Agent 重启后重新握手，不从磁盘恢复旧 CDP session、输入等待或 action。
- 浏览器侧遵守原生 WebSocket `close()` 的参数约束：正常关闭使用 1000，失联使用私有码 4001，协议或快照失败使用 4002。不能从浏览器 API 主动传入 1001/1002 等只允许协议层使用的状态码，导致关闭本身抛异常。关闭码只作诊断，不替代租约关闭或实际资源释放的证据。
- 未发出动作可报 effect=none；已发出但失去确认报 UNKNOWN_RESULT。新操作先重观察目标；不能因连接恢复继续发送旧 click/submit。
- CDP 事件序列单调递增，保留最近 1000 个/合计 1 MiB；分页有 cursor/hasMore/truncated。等待器有当前 run/operation 归属，先登记再触发，完成/取消清理。
- 同一浏览器两个配置的 tabId 相同不能串线；用户关闭标签、更新插件、睡眠唤醒、调试器被其他工具占用或用户点原生取消，都要返回真实状态。
- 协议版本不兼容拒绝建立动作通道，提示包/插件版本；不退回 Avru 旧自动连接、旧配对 token 或另一环境。

首发 Chrome/Edge 稳定 ID/最低浏览器版本由配套制品与真实测试固化；不在设计中虚构已安装、已兼容或已通过市场审核。

## 原始 CDP 大响应

CDP 原始参数和返回值保留浏览器协议类型，包括某些命令原生的 base64 字段；不改字段名或伪装成普通截图 API。超过控制帧预算的原始 JSON 参数/响应以 kind=json 的有界 UTF-8 二进制流传输，接收完成再还原对象；双方限额由 ready.limits 协商，初始上限不得超过本轮平台 128 MiB，仍受当前方法输入/最终输出各自预算约束，真实 bytes/期限/背压均检查。该流只改变本机传输，不能把 1 MiB 控制帧上限当成所有 CDP 方法的结果上限。

高层截图/文件 SDK 返回原生 bytes/产物，不携带 base64。脚本需要将 raw CDP 媒体交给 Host 时，先将原生编码字段解码为 bytes，再使用 output.image/file 等标准结果；SDK 不自动把 raw CDP payload 塞入日志、审计或 structuredContent。普通 Node 代码能自行编码数据不构成本协议的隔离保证。

## 用户加载插件与版本核对

包启用后先准备当前 profile 的稳定插件目录，再向用户给出实际路径、预期插件版本和环境。路径按公开 context.paths.work 下的 .nexum-browser/extension 定位；不要求用户查 npx 缓存或访问 Agent 私有状态。Chrome 使用 chrome://extensions、Edge 使用 edge://extensions 的浏览器原生“加载已解压的扩展程序”流程选择该目录；安装权限和企业策略由浏览器处理，文档不承诺已获市场发布或静默安装。

插件显示 Nexum browser/对应开发环境名称；用户加载后自动握手，上线事实来自 ready/metadata/tabs，而不是文件夹已存在。包更新后插件仍运行旧版本时明确需要重新加载，核对实际 extensionVersion/protocol/ID，不能只看磁盘文件就宣称已生效。维护卸载按通用授权处理本包目录与连接，不静默移除浏览器插件或用户配置。

## 租约与等待消息的约束

lease_open 只有当前已登记 RunScope 能发出；插件 ack 前动作不派发。lease_end/closed 遵守 lifecycle.md 的真实收尾：断线后停止新派发、清理本包附着/等待/视觉，重连只核对关闭回执，不重续已停止 run。并发完成的关闭回执按顺序写入 session，避免较早的存储结果覆盖较新的记录；写入失败不能冒充回执已保存。旧代次的清理回执有显式 originalGeneration，只匹配原 lease，绝不能使旧 action_result 成为新 run 的结果。插件 worker 恢复时以实际 debugger/target 状态核对本插件的最小 session 记录，不能借新实例连接身份接管其他工具。

SDK 的 waiters.arm 在插件安装真实事件监听并确认 ready 后才返回；浏览器事件先缓冲后交付，目标命令队列不能等待一个尚需后续命令触发的事件。waiters.get 主要等待本包缓冲，不在插件上占住唯一调度槽；cancel 撤监听与缓冲，不把原生下载开始误记为下载完成。每个浏览器事件除 sequence 还带 leaseId/waiterId 或明确的订阅身份，错误关联事件不能进入其他 run。
