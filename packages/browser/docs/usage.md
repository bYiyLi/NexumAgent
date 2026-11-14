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

当前 MV3 传输能保留目标绑定的原始下载事件和 `tab.downloads()` 状态，但 Chrome 公开接口没有提供该 GUID 与本机文件的可靠对应。因此 `download.path()`、`tab.saveDownload()` 明确返回 `CAPABILITY_NOT_ALLOWED`；本包不按 URL、时间或文件名猜测文件，不重发原请求。它们的正向文件取回仍未完成验收。下面的页面媒体、资产下载与导出按实际来源生成自己的产物，不受这项原生下载文件身份限制影响。

如果动作已派发后超时、取消或断连，`effect: unknown` 表示不能证明网站副作用。先重新观察，不能自动重发点击、提交、文件选择或整个脚本。用户原生调试取消会使旧控制失效；不通过重新 get 恢复同一已交还的 run 目标。

`selected.visibility` 控制当前浏览器内的任务标签跟随。`false` 时真实控制动作仍执行，但不切换活动标签；恢复 `true` 后，在后续真实控制动作之前切换到目标标签。只读标题、标签列表等元数据不会为了读取而抢走焦点，也不会把浏览器窗口强行带到系统前台。任务标签使用本运行自己的蓝色分组；用户已有的组不被接管。

需要用户接管时，`await tab.requestUserTakeover("authentication")` 会交还该标签，并通过平台真实输入等待请求确认。同一运行里的其他标签继续保留。只有用户明确确认、当前运行及权限仍有效、浏览器重新观察原生标签和文档成功后，才签发新的控制身份。旧 Tab、Locator、ref、Dialog 等不会复活；继续时通过 `selected.tabs.get(tab.id)` 取得新 Tab 并重新观察。否决、取消、超时和撤权都不会恢复控制，也不证明站点登录已经成功。

资产清单先观察，下载按固定清单执行。`tab.assets.list()` 返回库存身份；`tab.assets.bundle({inventoryId, kinds:["image","stylesheet"]})` 保存实际文件和相对路径 manifest，逐项保留失败。`tab.cua.downloadMedia(point)`、`tab.dom.downloadMedia({node_id})` 和 `locator.downloadMedia()` 都从真实观察到的媒体元素读取原始来源，不把截图改名冒充媒体。媒体、资产下载和导出均返回本机固定文件的 `BrowserArtifact`，包含实际大小及 SHA-256。

`tab.exportFile({format:"pdf"|"html"|"markdown"})` 分别读取原生 PDF 流或实际 DOM，Markdown 由实际 HTML 转换。Google Workspace 导出与 YouTube 字幕必须存在可观察的真实文档、导出地址或字幕源；需要登录、无字幕、CORS、权限或跨域重定向不满足时明确失败，不生成替代内容。本包当前不自动追随未经重新授权的下载重定向。

WebMCP 的协议域存在不代表页面已注册工具。先读取实际能力与 `tab.webmcp.listTools()`；空数组就是本次观察没有可调用的工具。`fetchTools()` 返回的绑定版本只执行原注册，同名工具被替换后会失效。浏览器仍处于实验阶段时，网站可能需要 Origin Trial，或在独立测试配置中启用浏览器提供的 WebMCP 实验能力；不能把测试配置下的可用性推断为所有普通浏览器默认可用。
