# Browser 插件安装、启用与重载

仅处理当前 Agent 的 Chrome/Edge 插件及其安装资产。npm 包版本和 SDK 扩展状态由平台 environment-maintenance 负责；若需维护包，按该 Skill 的实际方法与审批执行。只有确认原维护结果要求重启、尚未生效且已获重启授权时，按 runtime-control 的重启合同完成交接，再检查当前资产。

## 核对安装资产

复用本次 discover 已校验的安装诊断；没有有效证据时调用已登记的 `browser/installation.js`（input={}，无需在线浏览器）。脚本未登记时，核对 Open 告警及实际 SDK 状态，不猜 npm 路径或调用未登记脚本。

只有 `Installation assets: ready` 才使用报告中的 Directory、Profile、Extension、Extension ID 和版本。extensionVersion 是浏览器显示版本，Expected asset revision 是已验证资产的构建身份；资产就绪不证明插件已安装、启用或已加载这个构建。

## 按实际浏览器状态选择动作

请用户在目标 Agent 的 Chrome/Edge 打开 `chrome://extensions` 或 `edge://extensions`，核对对应插件身份、加载目录及启用状态。只对已验证的当前 Profile 资产提供以下指引：

- 未安装：开启开发者模式，选择“加载已解压的扩展程序”，使用已验证目录。
- 已安装但禁用：启用现有匹配插件。
- 已确认 `PLUGIN_VERSION_MISMATCH` 或用户明确要求重载：在匹配插件上执行重新加载；显示版本相同也可能构建不同。重新发现仍确认构建不匹配，且已验证资产和加载目录正确时，可请用户对该插件停用后重新启用一次，再核对握手；不重复升级或操作其他 Profile。
- 已连接且构建匹配、用户未要求重载：直接使用，不因曾经更新 npm 包而再次加载。
- 安装、启用或加载目录未知：先核对，不猜测动作。身份或目录不匹配时请用户选择正确的匹配插件，不覆盖其他环境。

原生确认、权限和企业策略由用户或管理员处理。不自动安装、重载或修改策略。用户完成操作后，用实际登记的 `browser/discover.js` 或 [初始化与发现](bootstrap.md) 中的 SDK 查询验证目标连接；不要以磁盘资产或用户操作回执代替握手成功。

## 资产检查失败

返回 `browser_assets_unavailable` 时报告实际 Reason，不提供未验证目录或要求用户加载旧资产。按检测结果恢复：

- `invalid_context` / `profile_mismatch`：核对目标 Agent 和 production/development Profile。
- `assets_not_prepared` / `asset_missing`：核对当前包的资产准备状态。
- `asset_invalid` / `integrity_mismatch` / `build_mismatch`：检查当前包及资产生成，不加载未通过校验的资产。若存在已批准更新，核对实际重启要求，不能仅凭构建不匹配重启。
- `unsafe_asset_path` / `asset_read_failed`：保持路径与权限边界，核对实际访问条件。
- `assets_changed`：确认资产准备结束后重查。
- `inspection_failed`：报告未确认原因，核对扩展生命周期诊断。
