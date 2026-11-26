# 浏览器连接诊断

用于目标浏览器不可用、握手拒绝、连接断开或监听失败。普通页面定位失败不属于连接异常。

1. 核对本次 Open 的 Agent、授权及实际登记能力。优先调用 `browser/discover.js`（input={}）；仅 SDK 已登记时可按 [初始化与发现](bootstrap.md) 查询。若 Browser 能力未发布，走本次登记的 environment-maintenance；无可用入口时报告缺口。部分标签查询失败不是空列表，保留健康连接和已取得的结果。
2. 根据实际错误选择恢复：
   - `PLUGIN_VERSION_MISMATCH`：确认握手构建不匹配。按 [安装与重载](installation.md) 核对当前 Profile 的资产，再引导用户重载受影响插件；复用已有有效安装诊断。资产不可用时先恢复资产。
   - `EXTENSION_OFFLINE` 或没有授权可见连接：核对浏览器是否运行及插件安装、启用、连接状态；离线不证明未安装或需要升级。需要安装或重载时走 [安装与重载](installation.md)。
   - `PROFILE_MISMATCH`：核对 Agent 与插件的正式/开发 Profile 及身份。
   - `PROTOCOL_MISMATCH`：核对当前包、插件构建及协议；确需更新包时走 environment-maintenance，不猜测升级通道。
   - `PROFILE_CONFLICT` / `PORT_IN_USE`：核对冲突浏览器或监听服务，不抢占其他连接、监听者或跨 Profile 探测替代端口。
   - 权限、企业策略、受保护页面或 debugger 冲突：报告受阻操作和用户/管理员需要处理的权限，不绕过。
3. 连接恢复后重新发现 browserId、tabId 和目标页面；旧控制代次、ref、Dialog、Chooser 不自动有效。此前动作效果未知时按 [错误与恢复](errors.md) 核对原业务状态，不重放。

插件工具栏 connecting（…）表示候选探测或握手中；单端口拒绝不是最终离线。offline（OFF）时查看实际分类和恢复提示；重新连接成功后清除旧提示。无法确认原因时报告实际错误、已核对状态和缺失条件。只有需要端口、握手、Profile 或 lease 的工程证据时读 [内部诊断依据](diagnostics.md)。
