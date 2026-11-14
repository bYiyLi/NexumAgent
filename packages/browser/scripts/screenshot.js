/**
{"scriptName":"screenshot.js","scriptDesc":"把选定真实标签的 JPEG 截图交给模型","scriptWhenUse":"需要查看页面的视觉状态时","scriptInputSchema":{"type":"object","properties":{"browserId":{"type":"string","minLength":1},"tabId":{"type":"string","minLength":1}},"required":["browserId","tabId"],"additionalProperties":false},"scriptOpenDefault":false}
*/
const { createBrowserClient } = await import("nexum-browser");
const client = createBrowserClient(browser);
const selected = await client.browsers.get(context.input.browserId);
const tab = await selected.tabs.get(context.input.tabId);
const image = await tab.screenshot();
return output.image({ data: image, mimeType: "image/jpeg" });
