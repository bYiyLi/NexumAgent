# Browser 插件安装、更新与验证

用于当前 Agent 的 Chrome/Edge 插件安装、重新加载、路径查询，不要求浏览器已经连接。

1. 核对本次 `agent.open` 选择的 Agent 与实际登记的 Browser 能力。脚本清单不完整时按其索引补读；只执行真实存在且 Schema 匹配的 `browser/installation.js`（输入为空对象）。
2. 脚本返回 `assetsReady: true` 时，把实际 `directory`、`profile`、`name`、`extensionVersion` 和 `extensionId` 告知用户；不要拼接 npm 内部路径、使用包管理器缓存或把其他 Agent 的路径交给用户。
3. 用户在该 Agent 所在机器打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”并选择上述目录；已经加载同一稳定目录时使用浏览器的重新加载操作。权限、企业策略和原生确认由用户或管理员处理。
4. 资产已准备只证明磁盘端插件存在且身份校验通过。用实际登记的 `browser/discover.js` 或 [初始化与发现](bootstrap.md) 查询当前授权可见的浏览器；核对握手中的实际插件版本。无可见在线浏览器不代表已安装、未安装或连接失败的确切原因。

脚本缺失、扩展未启用或准备失败时，报告实际可用性，按平台维护状态和 [连接诊断](connection.md) 处理；需要安装或启用 npm 包须走现有用户确认机制。若脚本返回 `assetsReady: false`，不提供未经验证的路径，报告 `browser_assets_unavailable` 并核对当前扩展生命周期诊断。

不自动静默安装浏览器插件，不修改浏览器企业策略，不调用不存在的 SDK，也不将磁盘版本冒充正在运行的浏览器插件版本。
