# 浏览器连接问题：AI 操作步骤

仅在浏览器不可用、扩展离线、端口冲突、权限拒绝或明确断连时读取本文件。普通页面定位失败不是连接失败。

1. 从本次 `agent.open` 核对目标 Agent、实际授权及完整脚本清单；已注册的 `browser/discover.js` 可直接传 input={}，阅读返回文本的浏览器/标签身份、查询失败及必要安装资产诊断。脚本未登记且 Browser 能力不可用时，先检查当前 Agent 的包安装、启用或初始化状态，不能调用不存在的脚本；只有真实 SDK 可用时才按 [初始化与发现](bootstrap.md) 使用 `client.browsers.list()`。没有可见在线浏览器不证明未安装、未启用或服务故障；安装资产就绪不证明已加载插件。部分标签查询失败不是空标签列表，只使用实际观察到的目标。
2. 如果提示 `PLUGIN_VERSION_MISMATCH`，运行中的插件与 Agent 当前包不配套（显示版本号相同也可能发生）。使用 discover 已校验的当前 profile 安装目录；只有没有这项证据时才按 [安装与更新](installation.md) 查询。请用户在对应 Chrome/Edge 扩展管理界面重新加载，成功重新发现后再操作。如果提示 `EXTENSION_OFFLINE`，报告当前 Agent/浏览器和连接状态，检查实际安装、启用和连接信息；不能将离线猜成版本不一致。资产不可用时不提供猜测路径。
3. 如果提示 `PORT_IN_USE`，说明本地 Browser 监听端口不可用；保持已有服务与用户浏览器原状，不抢占其他监听者，也不跨 development / production profile 猜测替代端口。
4. 如果提示权限、企业策略、受保护页面或 debugger 冲突，准确报告受阻操作和需由用户/管理员处理的权限。不要绕过系统策略或改用未获授权的浏览器控制方式。
5. 只有确认连接被重建时，才重新发现 browserId、tabId 和当前页面；旧控制代次、ref、Dialog、Chooser 不自动有效。连接恢复不能证明之前的点击、提交或下载没有发生，先只读核对业务状态。

无法诊断时返回实际错误码、已核对的连接信息、未执行步骤及需要的恢复条件。需要端口、握手、profile、lease 的工程排查证据时按需读取 [内部诊断依据](diagnostics.md)。

插件工具栏的 connecting（…）表示仍在候选探测或握手，单端口拒绝不是最终离线。整轮失败的 offline（OFF）提示保留已确认的 `PROFILE_MISMATCH`、`PLUGIN_VERSION_MISMATCH`、`PROTOCOL_MISMATCH`、`PROFILE_CONFLICT` 或有界连接超时/断开分类；不能把版本不匹配解释成需要开放其他环境端口。成功重连后清除旧失败提示。Chrome 自身网络诊断仍可能显示候选端口拒绝。
