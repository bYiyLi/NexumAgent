/**
{
  "scriptName": "installation.js",
  "scriptDesc": "查询当前 Agent 的 Chrome/Edge 插件安装准备状态。输入 {}，无需在线浏览器。Installation assets: ready 返回已校验 Directory、Profile、Extension、版本、完整 Extension ID、构建标识及按状态选择的安装/启用/重载步骤；资产就绪不证明插件已安装、启用或在线，用户操作后用 browser/discover.js 确认。unavailable 时报告实际错误及有证据的 Reason，不猜 npm 路径。脚本未登记时按 Open 警告选择 environment-maintenance 核对 @nexum-hub/browser 的版本及 SDK 状态；不自动安装或重载。",
  "scriptWhenUse": "安装、重载或核对插件加载目录时；discover 已提供有效安装诊断则无需重复查询。",
  "scriptInputSchema": {
    "type": "object",
    "additionalProperties": false
  },
  "scriptOpenDefault": true,
  "scriptOutputSchema": {
    "type": "string",
    "description": "面向 AI 的安装准备检查与安装指引文本，成功提供已校验的当前资产目录、身份及版本，失败保留安全错误码、原因及恢复方向；不证明浏览器已安装插件。"
  }
}
*/
const { inspectInstallation, formatInstallationInspection } = await import("@nexum-hub/browser/installation");
const result = await inspectInstallation(context.paths?.work, context.profile);
const lines = [formatInstallationInspection(result)];
if (result.assetsReady) {
  lines.push("", "## Install or reload",
    "1. On this Agent, open chrome://extensions in Chrome or edge://extensions in Edge and check the matching extension identity, directory and enabled state.",
    "2. If absent, enable Developer mode, choose Load unpacked and select the verified Directory above. If the matching extension is disabled, enable it.",
    "3. If its build is confirmed incompatible or reload was explicitly requested, reload the matching extension from the verified Directory. A matching connected build needs no reload unless requested; a past npm update alone does not establish mismatch. If status is unknown, check it before choosing an action. Confirm native prompts. If rediscovery still confirms a build mismatch after reload with the verified loaded directory, ask the user to disable and re-enable only that matching extension once and rediscover.",
    "4. Run the registered browser/discover.js with {} to verify the actual connection. Assets ready is not evidence of a connected browser.");
}
return lines.join("\n");
