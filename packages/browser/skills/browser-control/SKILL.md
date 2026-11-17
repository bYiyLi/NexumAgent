---
name: browser-control
description: 用户要求观察或操作当前已连接的 Nexum 浏览器页面、截图、下载或验证页面业务结果时选择；浏览器概念讨论、安装或配置任务不选择。
---

# 浏览器操作

- 确认本次实际注册的 `browser` 能力。需要列出浏览器/标签或对已知标签截图时，先查 `agent.scripts` 中的 `browser/discover.js`、`browser/screenshot.js`，匹配其输入 Schema 后按 `scriptName` 执行；未启用时不假装存在。
- 其他交互用 `createBrowserClient(browser)`，从真实发现结果取得 browserId/tabId，先 `tab.observe({full:true})`。以 `tab.playwright.getByRole/getByLabel/locator` 定位当前元素，操作后回读页面并检查用户要求的业务完成条件。点击事件成功不等于保存或提交成功。
- 遇到 `INPUT_UNCONFIRMED`、`EXPECTATION_UNCONFIRMED`、超时或断连，原输入可能已产生副作用：重新观察，不盲目重放。固定 ref、dialog、chooser 过期后重新发现；用户接管后不沿用旧句柄。
- 图片用 `output.image` 返回，文件用 `output.file` 或 `transfer`；离线、权限拒绝、方法缺失和业务结果未知时明确报告，不编造完成。

## 按需阅读

- [操作与交付](../../docs/usage.md)：交互、业务验证、截图和下载
- [连接问题](../../docs/connection.md)：浏览器或插件掉线、profile 匹配、重连
- [生命周期](../../docs/lifecycle.md)：任务锁、控制交还、关闭与资源
- [方法类型](../../docs/api.md)：需要确认某个具体方法的签名时再读取相关片段
