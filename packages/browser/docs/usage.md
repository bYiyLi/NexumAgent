# 使用与结果交付

在当前脚本中导入 `createBrowserClient`，将当前运行的 `browser` 方法容器交给它。先 `client.browsers.list()`，再按实际 browserId 获取 Browser；从 `selected.tabs.list()` 的真实 tabId 获取 Tab。`getDefault()` 按当前在线默认或稳定顺序选择，`getForUrl(url)` 优先复用已存在的 URL/origin；选择不会自动导航。

页面操作先观察。语义定位使用 `getByRole/getByText/getByLabel/locator`，操作后等待一个能够证明目标状态的信号。Locator 是查询描述，每次操作重解；快照 ref、DOM/AX 节点、dialog、chooser 和 WebMCP 注册另有固定修订。过期后重新观察，不把旧索引改成碰巧同名的新元素。

`locator.click({position:{x:20,y:15}})` 和 `dblclick` 的位置相对元素当前矩形左上角，使用元素所在文档的 CSS 坐标，不填时取中心；iframe 的偏移和缩放由 SDK 转换。指定位置必须在元素矩形内，且该点未被遮挡；中心可用不能替代指定点可用。越界报 `INVALID_ARGUMENT`，持续遮挡在期限内报 `TIMEOUT`，不会点击覆盖层。

```javascript
const { createBrowserClient } = await import("@nexum-hub/browser");
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

`tab.screenshot({maxEdgePx:1200})` 限制实际图片的最长边为 1200 像素，计入浏览器的原生像素密度；`clip` 使用文档 CSS 坐标，包含页面滚动偏移。`tab.playwright.elementInfo({x,y})` 与 `elementScreenshot({x,y})` 的输入使用当前视口 CSS 坐标；前者返回视口矩形，后者自动按实际滚动偏移截取目标元素。小图保持原始分辨率，4000 万解码像素和 10 MiB JPEG 字节预算继续生效。

`tab.ax.get()` 返回文字；`return await tab.ax.write()` 将同一文字作为平台输出交付。文字包含标题、URL、原生索引及输入值、选中/展开/禁用等实际状态。第一次返回 `AX full`；同一运行、同一标签后续观察在差异更小时返回 `AX diff`，按 `Removed` / `Added` / `Changed` 列出变化，无变化时说明 `No accessibility changes.`。需要完整上下文时使用 `tab.ax.get("state",{disableDiffing:true})`，或对应的 `ax.write`。纯截图模式及 `ax.snapshot()` 不推进文字基准，混合读取失败或取消也不推进；导航、控制交还/续接、新运行或基准淘汰后重新返回完整状态。文字观察超过 60000 UTF-8 字节会报 `OUTPUT_TOO_LARGE`，可改用带截断标记的 `ax.snapshot()` 或按定位器读取所需数据。

返回本机文件路径只说明文件存在，不代表模型已经读取。文件/文档交付使用 `output.file(...)`，外部领取使用平台 `transfer.createDownload`；它们有各自的大小、当前权限和保留规则。

`expectNavigation(action)` 的 action 留在 Node，先确认等待已就绪再操作。`const pending = tab.playwright.waitForEvent("download"); await link.click(); await pending;` 的后续动作只等 arm-ready，不会排在整个下载等待后面。下载开始事件不等于文件已经完整保存。

`tab.navigate(url,{waitUntil})` 等待实际顶层导航的指定阶段，允许站点正常重定向；完成后用 `await tab.url()` 观察最终地址。`waitForURL` 或显式带 `url` 的导航等待仍按指定地址精确匹配；它们不会因某个不同地址已经加载而返回成功。

明确等待受控标签发起的 HTTP 附件下载时，扩展为原始响应中的文件名添加唯一编号，并建议浏览器保存到默认下载目录的 `Nexum` 子目录，不修改浏览器全局下载位置。点击页面上带 `download` 属性的 HTTP/Blob/data 链接，或页面在该次点击中同步创建并点击此类链接时，扩展只在此次点击期间设置带编号的下载名称，随后恢复页面链接属性。两种方式都用编号绑定页面下载事件与浏览器的下载记录，等待浏览器实际完成，再按当前路径权限读取和固定文件；浏览器中的原文件保留。

如果网页下载没有被当前等待器关联，可以直接查看当前浏览器配置的下载列表。`selected.downloads.list()` 返回原生记录，`filename` 是浏览器报告的本机路径；列表包含其他标签和目录的记录，默认最多 1000 条，可用 `limit` 调整数量，`0` 表示全部。按需要选中一条 `state === "complete"` 的记录，再交给 `output.file`：

```javascript
const records = await selected.downloads.list({ limit: 20 });
const report = records.find((item) =>
  item.state === "complete" && item.filename.endsWith("report.pdf"),
);
if (!report) throw new Error("未找到下载完成的报表");
return output.file(report.filename, { name: "report.pdf" });
```

列表中路径可能位于浏览器配置的任意下载目录；实际读取仍使用当前 Agent 的路径授权和大小规则。记录由浏览器提供，文件可能已移动或删除，`exists` 也可能滞后。浏览器记录的数字 `id` 与 `tab.downloads()` 的页面下载 ID 不同，不可用于 `tab.saveDownload`。列表不返回来源 URL，避免将下载内容或凭据放进模型上下文。

当前等待器无法确认下载身份时，`download.path()` 仍返回 `CAPABILITY_NOT_ALLOWED`；可以通过上述列表由 AI 选择文件。浏览器提供文件大小时，等待器路径的实际文件必须与之相符；大小未知时按实际读取结果处理。不会重发原请求。

`tab.downloads()` 对 `data:` 下载省略 URL，因为 URL 本身包含文件内容；完整内容通过文件或资源交付。

下载结果需要交给 AI 时，可以直接复用平台的资源包装：

```javascript
const pending = tab.playwright.waitForDownload();
await tab.playwright.getByRole("link", { name: "下载报表" }).click();
const downloaded = await pending;
const file = await downloaded.path();
return output.file(file, { name: "报表.pdf" });
```

平台在返回结果时将实际文件固定并登记到当前 Agent 的 `work/resources`，提供标准 MCP 资源引用；Host 再通过 `resources/read` 获取内容。读取浏览器下载目录和保存平台资源仍受当前授权与大小限制约束。

如果动作已派发后超时、取消或断连，`effect: unknown` 表示不能证明网站副作用。先重新观察，不能自动重发点击、提交、文件选择或整个脚本。用户原生调试取消会使旧控制失效；不通过重新 get 恢复同一已交还的 run 目标。

`selected.visibility` 控制当前浏览器内的任务标签跟随。`false` 时真实控制动作仍执行，但不切换活动标签；恢复 `true` 后，在后续真实控制动作之前切换到目标标签。只读标题、标签列表等元数据不会为了读取而抢走焦点，也不会把浏览器窗口强行带到系统前台。任务标签使用本运行自己的蓝色分组；用户已有的组不被接管。

需要用户接管时，`await tab.requestUserTakeover("authentication")` 会交还该标签，并通过平台真实输入等待请求确认。同一运行里的其他标签继续保留。只有用户明确确认、当前运行及权限仍有效、浏览器重新观察原生标签和文档成功后，才签发新的控制身份。旧 Tab、Locator、ref、Dialog 等不会复活；继续时通过 `selected.tabs.get(tab.id)` 取得新 Tab 并重新观察。否决、取消、超时和撤权都不会恢复控制，也不证明站点登录已经成功。

资产清单先观察，下载按固定清单执行。`tab.assets.list()` 返回库存身份；`tab.assets.bundle({inventoryId, kinds:["image","stylesheet"]})` 保存实际文件和相对路径 manifest，逐项保留失败。`tab.cua.downloadMedia(point)`、`tab.dom.downloadMedia({node_id})` 和 `locator.downloadMedia()` 都从真实观察到的媒体元素读取原始来源，不把截图改名冒充媒体。媒体、资产下载和导出均返回本机固定文件的 `BrowserArtifact`，包含实际大小及 SHA-256。

`tab.exportFile({format:"pdf"|"html"|"markdown"})` 分别读取原生 PDF 流或实际 DOM，Markdown 由实际 HTML 转换。Google Workspace 导出使用当前浏览器文档与登录态读取实际导出响应，支持站点正常的导出重定向；需要登录、权限不足或响应不是所请求文档格式时明确失败。`tab.content.exportYouTubeTranscript()` 与 `tab.exportYouTubeTranscript()` 使用当前播放器身份及可观察字幕源，支持当前和旧版已渲染字幕面板。若站点的字幕轨道响应不可用，可以先通过实际页面打开字幕面板，再导出已显示的字幕；导出本身不自动点击页面，也不生成替代字幕。普通资产和媒体读取仍受页面原生 CORS 约束，不通过 Node 代持浏览器凭据。

WebMCP 的协议域存在不代表页面已注册工具。先读取实际能力与 `tab.webmcp.listTools()`；空数组就是本次观察没有可调用的工具。`fetchTools()` 返回的绑定版本只执行原注册，同名工具被替换后会失效。浏览器仍处于实验阶段时，网站可能需要 Origin Trial，或在独立测试配置中启用浏览器提供的 WebMCP 实验能力；不能把测试配置下的可用性推断为所有普通浏览器默认可用。
