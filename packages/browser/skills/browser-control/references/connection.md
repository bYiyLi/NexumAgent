# 浏览器连接问题：AI 操作步骤

仅在浏览器不可用、扩展离线、端口冲突、权限拒绝或明确断连时读取本文件。普通页面定位失败不是连接失败。

1. 从本次 `agent.open` 核对目标 Agent、已启用的 `browser` 方法与实际授权；已注册的 `browser/discover.js` 存在时可按实际输入 Schema 获取浏览器及标签，否则通过 [初始化与发现](bootstrap.md) 读取 `client.browsers.list()`。空结果只表示本次没有发现可用浏览器，不证明远端服务故障。
2. 如果提示 `EXTENSION_OFFLINE`，报告当前 Agent/浏览器和连接状态。检查已提供的扩展在线信息；必要时提示用户检查该 Agent 所在机器的 Chrome/Edge 扩展是否已安装、启用并有对应站点权限。插件包已安装不等于浏览器扩展已连接。需要安装路径或重新加载时，读 [安装与更新](installation.md)，不要猜测 npm 内部路径。
3. 如果提示 `PORT_IN_USE`，说明本地 Browser 监听端口不可用；保持已有服务与用户浏览器原状，不抢占其他监听者，也不跨 development / production profile 猜测替代端口。
4. 如果提示权限、企业策略、受保护页面或 debugger 冲突，准确报告受阻操作和需由用户/管理员处理的权限。不要绕过系统策略或改用未获授权的浏览器控制方式。
5. 只有确认连接被重建时，才重新发现 browserId、tabId 和当前页面；旧控制代次、ref、Dialog、Chooser 不自动有效。连接恢复不能证明之前的点击、提交或下载没有发生，先只读核对业务状态。

无法诊断时返回实际错误码、已核对的连接信息、未执行步骤及需要的恢复条件。需要端口、握手、profile、lease 的工程排查证据时按需读取 [内部诊断依据](diagnostics.md)。

插件工具栏的 connecting（…）表示仍在候选探测或握手，单端口拒绝不是最终离线。整轮失败的 offline（OFF）提示保留已确认的 `PROFILE_MISMATCH`、`PLUGIN_VERSION_MISMATCH`、`PROTOCOL_MISMATCH`、`PROFILE_CONFLICT` 或有界连接超时/断开分类；不能把版本不匹配解释成需要开放其他环境端口。成功重连后清除旧失败提示。Chrome 自身网络诊断仍可能显示候选端口拒绝。
