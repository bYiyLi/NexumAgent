# Browser 插件安装、更新与验证

用于当前 Agent 的 Chrome/Edge 插件安装、重新加载、路径查询，不要求浏览器已经连接。

1. 核对本次 `agent.open` 选择的 Agent 与实际登记的 Browser 能力。若 warnings 中有 agent_scripts_incomplete，核对实际警告并按需刷新原 contextId；只执行真实存在且 Schema 匹配的 `browser/installation.js`（输入为空对象）。
2. discover 的安装诊断已给出校验通过的目录、环境和版本时，可直接使用本次证据，无需重复查询；否则以 installation 文本的 `Installation assets: ready` 及实际 Directory、Profile、Extension、Extension version、Extension ID 为准。不要拼接 npm 内部路径、使用包管理器缓存或把其他 Agent 的路径交给用户。
3. 用户在该 Agent 所在机器打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”并选择上述目录；已经加载同一稳定目录时使用浏览器的重新加载操作。权限、企业策略和原生确认由用户或管理员处理。
4. 资产就绪不证明插件已加载。用实际登记的 `browser/discover.js` 或 [初始化与发现](bootstrap.md) 查询当前授权可见的浏览器。即使显示版本号相同，`PLUGIN_VERSION_MISMATCH` 也要求用户在原生扩展管理界面重新加载同一 profile 的稳定目录。重新发现成功后再操作。没有在线浏览器且没有具体拒绝码时，不能猜测原因。

脚本缺失、扩展未启用或准备失败时，报告实际可用性，按平台维护状态和 [连接诊断](connection.md) 处理；需要安装或启用 npm 包须走现有用户确认机制。若文本返回 `Installation assets: unavailable`，报告 `browser_assets_unavailable` 及实际 Reason，按随附的恢复指引核对当前环境，不提供未经验证的路径：

- `invalid_context` / `profile_mismatch`：核对当前 Agent 和 production/development 环境。
- `assets_not_prepared` / `asset_missing`：核对稳定目录或必要资产的准备状态。
- `asset_invalid` / `integrity_mismatch` / `build_mismatch`：核对资产描述、内容及当前包构建；不加载未通过校验的资产。
- `unsafe_asset_path` / `asset_read_failed`：保持路径和权限边界，核对实际资产或读取权限，不绕过。
- `assets_changed`：资产在检查中变化；确认准备过程结束后重新检查。
- `inspection_failed`：无法确认具体原因，核对当前扩展生命周期诊断，不将未知误报为未安装。

不自动安装或重载，不修改浏览器企业策略。
