# 初始化与浏览器发现

## 选择浏览器和标签

在当前脚本中导入 `createBrowserClient`，将当前运行的 `browser` 方法容器交给它。先 `client.browsers.list()`，再按实际 browserId 获取 Browser；从 `selected.tabs.list()` 的真实 tabId 获取 Tab。`getDefault()` 按当前在线默认或稳定顺序选择，`getForUrl(url)` 优先复用已存在的 URL/origin；选择不会自动导航。

下面是可作为 `agent.run.start.script` 的只读入口。首次不传 ID 时返回浏览器列表，提供本次发现的 `input.browserId` 后返回标签列表，再提供 `input.tabId` 才观察页面；不要按名称或旧截图猜测 ID：

```javascript
const { createBrowserClient } = await import("@nexum-hub/browser");
const client = createBrowserClient(browser);
const browsers = await client.browsers.list();
if (!context.input?.browserId) return { browsers };
const selected = await client.browsers.get(context.input.browserId);
const tabs = await selected.tabs.list();
if (!context.input?.tabId) return { tabs };
const tab = await selected.tabs.get(context.input.tabId);
return await tab.observe({ full: true });
```
