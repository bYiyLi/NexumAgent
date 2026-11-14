/**
{"scriptName":"discover.js","scriptDesc":"列出当前可用浏览器和目标标签摘要","scriptWhenUse":"需要选择已连接浏览器和真实标签页时","scriptInputSchema":{"type":"object","additionalProperties":false},"scriptOpenDefault":true}
*/
const { createBrowserClient } = await import("nexum-browser");
const client = createBrowserClient(browser);
const choices = await client.browsers.list();
const result = [];
for (const info of choices) {
  const selected = await client.browsers.get(info.id);
  result.push({ browser: info, tabs: await selected.tabs.list() });
}
return result;
