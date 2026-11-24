# 截图、DOM 与可访问性观察

需要 Tab 时先按 [初始化与发现](bootstrap.md) 获取目标。

## 截图与可访问性输出

截图返回原生 JPEG 字节，直接 return 交给 Nexum 结果层：

```javascript
return await tab.screenshot();
```

`tab.screenshot({maxEdgePx:1200})` 限制实际图片的最长边为 1200 像素，计入浏览器的原生像素密度；`clip` 使用文档 CSS 坐标，包含页面滚动偏移。`tab.playwright.elementInfo({x,y})` 与 `elementScreenshot({x,y})` 的输入使用当前视口 CSS 坐标；前者返回视口矩形，后者自动按实际滚动偏移截取目标元素。小图保持原始分辨率，4000 万解码像素和 10 MiB JPEG 字节预算继续生效。

`tab.ax.get()` 返回文字；`return await tab.ax.write()` 将同一文字作为平台输出交付。文字包含标题、URL、原生索引及输入值、选中/展开/禁用等实际状态。第一次返回 `AX full`；同一运行、同一标签后续观察在差异更小时返回 `AX diff`，按 `Removed` / `Added` / `Changed` 列出变化，无变化时说明 `No accessibility changes.`。需要完整上下文时使用 `tab.ax.get("state",{disableDiffing:true})`，或对应的 `ax.write`。纯截图模式及 `ax.snapshot()` 不推进文字基准，混合读取失败或取消也不推进；导航、控制交还/续接、新运行或基准淘汰后重新返回完整状态。文字观察超过 60000 UTF-8 字节会报 `OUTPUT_TOO_LARGE`，可改用带截断标记的 `ax.snapshot()` 或按定位器读取所需数据。

返回本机文件路径不代表内容已经交付。文件交付按 [下载与资源](downloads.md)；外部领取使用平台 `transfer.createDownload`。核对返回的实际内容或资源引用。
