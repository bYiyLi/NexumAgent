/**
{
  "scriptName": "installation.js",
  "scriptDesc": "查询当前 Agent 的 Chrome/Edge 插件安装准备状态。输入 {}，无需在线浏览器。Installation assets: ready 返回已校验 Directory、Profile、Extension、版本、完整 Extension ID 及安装/重载步骤；资产就绪不证明插件已安装、启用或在线，用户操作后用 browser/discover.js 确认。unavailable 时报告实际错误及有证据的 Reason，不猜 npm 路径。脚本未登记时核对 Open 警告及包安装/启用状态；不自动安装或重载。",
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
    "1. On this Agent, open chrome://extensions in Chrome or edge://extensions in Edge.",
    "2. Enable Developer mode. If the matching extension is absent, choose Load unpacked and select the verified Directory above.",
    "3. If it is already loaded from that directory, reload it when needed. Confirm any native browser prompts.",
    "4. Run the registered browser/discover.js with {} to verify the actual connection. Assets ready is not evidence of a connected browser.");
}
return lines.join("\n");
