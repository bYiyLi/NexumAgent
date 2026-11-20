# 高级浏览器能力

仅在请求资产、媒体、导出或 WebMCP 时读取。

## 资产、导出与高级能力

资产清单先观察，下载按固定清单执行。`tab.assets.list()` 返回库存身份；`tab.assets.bundle({inventoryId, kinds:["image","stylesheet"]})` 保存实际文件和相对路径 manifest，逐项保留失败。`tab.cua.downloadMedia(point)`、`tab.dom.downloadMedia({node_id})` 和 `locator.downloadMedia()` 都从真实观察到的媒体元素读取原始来源，不把截图改名冒充媒体。媒体、资产下载和导出均返回本机固定文件的 `BrowserArtifact`，包含实际大小及 SHA-256。

`tab.exportFile({format:"pdf"|"html"|"markdown"})` 分别读取原生 PDF 流或实际 DOM，Markdown 由实际 HTML 转换。Google Workspace 导出使用当前浏览器文档与登录态读取实际导出响应，支持站点正常的导出重定向；需要登录、权限不足或响应不是所请求文档格式时明确失败。`tab.content.exportYouTubeTranscript()` 与 `tab.exportYouTubeTranscript()` 使用当前播放器身份及可观察字幕源，支持当前和旧版已渲染字幕面板。若站点的字幕轨道响应不可用，可以先通过实际页面打开字幕面板，再导出已显示的字幕；导出本身不自动点击页面，也不生成替代字幕。普通资产和媒体读取仍受页面原生 CORS 约束，不通过 Node 代持浏览器凭据。

## WebMCP 可用性

WebMCP 的协议域存在不代表页面已注册工具。先读取实际能力与 `tab.webmcp.listTools()`；空数组就是本次观察没有可调用的工具。`fetchTools()` 返回的绑定版本只执行原注册，同名工具被替换后会失效。浏览器仍处于实验阶段时，网站可能需要 Origin Trial，或在独立测试配置中启用浏览器提供的 WebMCP 实验能力；不能把测试配置下的可用性推断为所有普通浏览器默认可用。
