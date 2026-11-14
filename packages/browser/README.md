# Nexum browser

这是 Nexum 的可选浏览器客户端、受管扩展与匹配 MV3 插件源码。Agent 默认不安装或启用它；普通 `import "nexum-browser"` 和 `createBrowserClient(browser)` 不监听端口、不扫描浏览器。

本包当前处于开发验证阶段，`private: true`。客户端接口、Node loopback 服务和 MV3 原生路由正在组合验证；本机 fixture 结果不表示真实 Chrome/Edge、全部高阶能力或 npm 发行已验收。当前进度与具体缺口见 [实现台账](implementation.json)。

普通入口：

```javascript
import { createBrowserClient } from "nexum-browser";
const client = createBrowserClient(browser);
const choices = await client.browsers.list();
const selected = await client.browsers.get(choices[0].id);
const tabs = await selected.tabs.list();
const tab = await selected.tabs.get(tabs[0].id);
return await tab.playwright.domSnapshot();
```

`browser` 来自当前运行注入的受管方法表。普通 Node 客户端只构造公开门面；实际 I/O 逐项调用已经注册的公共扩展方法。未实现或未注册的方法明确失败。

平台注册入口为 `nexum-browser/nexum` 的默认 `createExtension(host)`。它只使用 `@nexum/extension-api` 当前公开类型和标准 Node/WS；独立公共协议包的正式发行仍未完成。模块顶层不初始化服务，工厂先登记冷资源，启用成功才监听本 profile 固定 loopback 端口。

[使用手册](docs/README.md) · [连接](docs/connection.md) · [生命周期](docs/lifecycle.md)
