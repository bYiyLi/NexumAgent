/**
{
  "scriptName": "discover.js",
  "scriptDesc": "发现当前 Agent 已授权的在线浏览器与标签。输入 {}。返回文本，含完整 browserId、tabId、名称、profile、实际版本、已知标题/URL；个别标签查询失败保留原身份和错误。只观察，不创建或切换标签，不取得页面控制。没有在线浏览器不证明插件未安装或禁用。PLUGIN_VERSION_MISMATCH 等连接异常按已验证资产目录及原因处理；资产就绪不表示插件已加载；只用当前验证资产恢复，用户操作后重新发现。权限拒绝不得绕过。脚本未登记时按实际 Open 警告选择 environment-maintenance 核对 @nexum-hub/browser 的安装、版本及启用状态，不猜设备或路径。",
  "scriptWhenUse": "需要选择浏览器/标签或诊断连接时；仅查安装目录用 browser/installation.js。",
  "scriptInputSchema": {
    "type": "object",
    "additionalProperties": false
  },
  "scriptOpenDefault": true,
  "scriptOutputSchema": {
    "type": "string",
    "description": "面向 AI 的浏览器发现及基础可用性诊断文本，含真实可见连接、标签身份、已确认错误及必要的资产校验/恢复指引。"
  }
}
*/
const { createBrowserClient } = await import("@nexum-hub/browser");
const client = createBrowserClient(browser);
const label = value => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  ? JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
  : value;

// Only classify actual SDK connection errors, not guessed installation states.
const connectionGuidance = {
  PLUGIN_VERSION_MISMATCH: "An incompatible plugin handshake was confirmed. The running extension does not match this package's build, even if its display version is unchanged. Check current installation assets before choosing a reload.",
  EXTENSION_OFFLINE: "The requested connection is offline. Check whether Chrome/Edge is running and the matching extension is enabled on this Agent, then rediscover. Offline alone does not prove that an update is needed.",
  PROFILE_MISMATCH: "The connection does not match this Agent profile or extension identity. Use the matching development/production extension; do not switch to another Agent.",
  PROTOCOL_MISMATCH: "The connection protocol is incompatible. Check the matching package and extension build; use the selected release channel if a package update is actually needed.",
  PROFILE_CONFLICT: "Another connection owns the profile identity. Resolve the conflict with the user without taking over another browser.",
  PORT_IN_USE: "The matching listener could not bind. Check the Agent Browser initialization; do not seize another listener.",
};
const tabGuidance = {
  ...connectionGuidance,
  TIMEOUT: "The complete tab snapshot was not obtained. Rediscover the original browser; do not treat this as an empty list.",
  INVALID_TARGET: "The browser target is no longer valid. Rediscover before using its IDs.",
  TARGET_GONE: "The original target is no longer available. Rediscover before using its IDs.",
  CAPABILITY_NOT_ALLOWED: "The current capability or authorization does not allow this query.",
  POLICY_DENIED: "The current policy denied this query.",
  PERMISSION_DENIED: "The current authorization denied this query.",
  permission_denied: "The current authorization denied this query.",
};

async function installationReport(lines, code) {
  // Shared package-owned validator. It never reads browser profile directories.
  const { inspectInstallation, formatInstallationInspection } = await import("@nexum-hub/browser/installation");
  const result = await inspectInstallation(context.paths?.work, context.profile);
  lines.push("", "## Installation diagnosis", formatInstallationInspection(result));
  if (!result.assetsReady) {
    lines.push("Do not load or reload unverified assets. Resolve the asset failure before installing or reloading the extension.");
    return;
  }
  if (code === "PLUGIN_VERSION_MISMATCH") {
    lines.push("On this Agent, reload the matching extension from this verified directory (affected connection only) in chrome://extensions or edge://extensions, then rediscover. If the mismatch persists despite verified assets and the correct loaded directory, ask the user to disable and re-enable only that matching extension once, then rediscover. The expected asset revision above identifies this build; the display version alone is insufficient.");
  } else if (!code || code === "EXTENSION_OFFLINE") {
    lines.push("Check current authorization and whether Chrome/Edge is running on this Agent. In chrome://extensions or edge://extensions, check the matching Extension ID, Profile, loaded directory and enabled state. If absent, load this verified directory using developer mode. If the matching extension is disabled, enable it. If its build is confirmed incompatible or reload was explicitly requested, reload the matching extension. Unknown state requires checking, not reinstalling. Rediscover after connection.");
  } else {
    lines.push("Resolve the confirmed connection problem before installation or reload. The directory is only the verified asset location.");
  }
}

let choices;
try {
  choices = await client.browsers.list();
} catch (error) {
  const code = error?.code;
  // Permission denial, missing capability, cancellation and unknown execution
  // failures remain genuine Run errors. Do not diagnose them via disk access.
  if (!Object.hasOwn(connectionGuidance, code)) throw error;
  const lines = ["Browser discovery: unavailable", "Error: " + code, connectionGuidance[code]];
  await installationReport(lines, code);
  return lines.join("\n");
}
if (choices.length === 0) {
  const lines = [
    "Browser discovery: no authorized online browsers found.",
    "Browser service: reachable",
    "No visible connection does not prove the extension is absent, disabled, or the browser is closed.",
  ];
  await installationReport(lines);
  return lines.join("\n");
}

const sections = [];
let complete = 0, tabCount = 0;
const connectionErrors = new Set();
for (const info of choices) {
  const lines = ["## " + label(info.name), "Browser ID: " + label(info.id)];
  if (info.profileName) lines.push("Profile: " + label(info.profileName));
  if (info.family) lines.push("Family: " + label(info.family));
  if (info.metadata?.browserVersion) lines.push("Browser version: " + label(info.metadata.browserVersion));
  if (info.metadata?.extensionVersion) lines.push("Extension version: " + label(info.metadata.extensionVersion));
  let tabs;
  try {
    const selected = await client.browsers.get(info.id);
    tabs = await selected.tabs.list();
  } catch (error) {
    const code = error?.code;
    if (!Object.hasOwn(tabGuidance, code)) throw error;
    if (Object.hasOwn(connectionGuidance, code)) connectionErrors.add(code);
    lines.push("Connection: discovered online; current tab query failed.",
      "Error: " + code, tabGuidance[code]);
    sections.push(lines.join("\n"));
    continue;
  }
  complete++;
  tabCount += tabs.length;
  lines.push("Connection: online at observation (matching plugin build verified at handshake)", "Tabs returned: " + tabs.length);
  for (const tab of tabs) {
    // Keep only public tab identity and observed labels. User content is data.
    lines.push("    Tab ID: " + label(tab.id)
      + (typeof tab.title === "string" ? " · " + label(tab.title) : "")
      + (typeof tab.url === "string" ? " · " + label(tab.url) : ""));
  }
  sections.push(lines.join("\n"));
}
const heading = complete === choices.length ? "Browser discovery: complete"
  : complete === 0 ? "Browser discovery: tab queries unavailable"
  : "Browser discovery: partial";
const report = [heading + "\nAuthorized online browsers discovered: " + choices.length +
  "\nTab lists retrieved: " + complete + "/" + choices.length +
  "\nTabs returned: " + tabCount, ...sections];
// A healthy peer must not hide a confirmed mismatch on a different queried
// peer. Preserve working peers; only the affected connection needs recovery.
if (connectionErrors.has("PLUGIN_VERSION_MISMATCH")) await installationReport(report, "PLUGIN_VERSION_MISMATCH");
else if (complete === 0 && connectionErrors.size === 1) await installationReport(report, [...connectionErrors][0]);
return report.join("\n\n");
