# 使用与结果交付

在当前脚本中导入 `createBrowserClient`，将当前运行的 `browser` 方法容器交给它。先 `client.browsers.list()`，再按实际 browserId 获取 Browser；从 `selected.tabs.list()` 的真实 tabId 获取 Tab。`getDefault()` 按当前在线默认或稳定顺序选择，`getForUrl(url)` 优先复用已存在的 URL/origin；选择不会自动导航。

页面操作先观察。语义定位使用 `getByRole/getByText/getByLabel/locator`，操作后等待一个能够证明目标状态的信号。Locator 是查询描述，每次操作重解；快照 ref、DOM/AX 节点、dialog、chooser 和 WebMCP 注册另有固定修订。过期后重新观察，不把旧索引改成碰巧同名的新元素。

```javascript
const { createBrowserClient } = await import("nexum-browser");
const client = createBrowserClient(browser);
const selected = await client.browsers.get(context.input.browserId);
const tab = await selected.tabs.get(context.input.tabId);
return await tab.playwright.domSnapshot();
```

截图返回原生 JPEG 字节，向模型展示时显式使用平台结果包装：

```javascript
const image = await tab.screenshot();
return output.image({ data: image, mimeType: "image/jpeg" });
```

返回本机文件路径只说明文件存在，不代表模型已经读取。文件/文档交付使用 `output.file(...)`，外部领取使用平台 `transfer.createDownload`；它们有各自的大小、当前权限和保留规则。

`expectNavigation(action)` 的 action 留在 Node，先确认等待已就绪再操作。`const pending = tab.playwright.waitForEvent("download"); await link.click(); await pending;` 的后续动作只等 arm-ready，不会排在整个下载等待后面。下载开始事件不等于文件已经完整保存。

如果动作已派发后超时、取消或断连，`effect: unknown` 表示不能证明网站副作用。先重新观察，不能自动重发点击、提交、文件选择或整个脚本。用户原生调试取消会使旧控制失效；不通过重新 get 恢复同一已交还的 run 目标。
