/**
{"scriptName":"discover.js","scriptDesc":"列出当前可用浏览器和目标标签摘要","scriptWhenUse":"需要选择已连接浏览器和真实标签页时","scriptInputSchema":{"type":"object","additionalProperties":false},"scriptOpenDefault":true,"scriptOutputSchema":{"type":"array","items":{"type":"object","properties":{"browser":{"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"},"type":{"const":"extension"},"status":{"const":"online"},"generation":{"type":"integer"},"bootId":{"type":"string"},"browserSessionId":{"type":"string"},"profileName":{"type":"string"},"family":{"type":"string"},"metadata":{"type":"object","properties":{"browserVersion":{"type":"string"},"extensionVersion":{"type":"string"},"versionSource":{"enum":["clientHints","userAgent","unknown"]}},"required":["extensionVersion","versionSource"],"additionalProperties":false}},"required":["id","name","type","status","generation","bootId","browserSessionId"],"additionalProperties":false},"tabs":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"providerTabId":{"type":"string"},"title":{"type":"string"},"url":{"type":"string"}},"required":["id"],"additionalProperties":false}}},"required":["browser","tabs"],"additionalProperties":false}}}
*/
const { createBrowserClient } = await import("@nexum-hub/browser");
const client = createBrowserClient(browser);
const choices = await client.browsers.list();
const result = [];
for (const info of choices) {
  const selected = await client.browsers.get(info.id);
  result.push({ browser: info, tabs: await selected.tabs.list() });
}
return result;
