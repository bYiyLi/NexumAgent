# 标签管理、导航与观察数据

需要 Browser 与 Tab 时先按 [初始化与发现](bootstrap.md) 获取目标。

## 标签操作

- `selected.tabs.new(url)` 的第一个参数是字符串 URL，而不是 `{url}`。例如 `selected.tabs.new("https://example.com")`。创建成功后保留真实 tabId。
- `tabs.list()` 的数组位置只是返回数组的下标，**不等于**浏览器标签栏的 `index`。
- 如需移动标签，调用已启用的 `management.tabs.move(tabId,{index})`，然后以 `management.tabs.get(tabId).index` 验证；不要使用 `tabs.list().findIndex(...)` 判定 `move` 未生效。

  在同一 Nexum Run 中已取得 `selected` 和真实 `tabId` 后：

  ```javascript
  const management = await selected.capabilities.get("management");
  const moved = await management.tabs.move(tabId, { index: 0 });
  const actual = await management.tabs.get(tabId);
  return { movedIndex: moved.index, currentIndex: actual.index };
  ```

  仅在用户要求移动该标签时使用这个示例；不能将本例写死的索引用于未知页面。
- 页面已在目标 URL 时，除非用户明确需要刷新，不要无谓地再次导航，避免丢失未提交表单。导航与历史回退后重新观察实际 URL。
- 只操作当前请求涉及的标签；测试中新建标签可以在确认没有未完成业务状态后关闭，不影响用户现有标签。

## 选择合适的观察方式

| 目标 | 建议调用 | 使用说明 |
| --- | --- | --- |
| 了解整页可访问内容 | `tab.observe({full:true})` | 返回实际观察结构；长度依页面与请求而异 |
| 获取文本 DOM 快照 | `tab.playwright.domSnapshot()` | 用于语义定位，但不是完整浏览器原生 Playwright |
| 获取简要状态 | `tab.snapshot()`、`tab.ax.get()` | 各自数据形状和长度以真实返回为准 |
| 获取坐标下的元素详情 | `tab.playwright.elementInfo({x,y})` | **返回数组**；可能为空，先检查 `result.length` |
| 取得截图 | `tab.screenshot({maxEdgePx:800})` | 图片字节若需交付，直接 return 原生字节 |

`elementInfo` 元素可能包含 `preview`、`role`、`tagName`、`boundingBox` 和 `selector`；`selector` 可能没有可用候选，不能据此猜测 CSS 选择器。不要把空数组的 `Object.keys` 误读为格式错误。

读数不一致时分别核查返回类型、页面状态、调用参数、导航代次和权限；单次短结果不能推出固定截断。

## 与操作同步的结果验证

点击、导航或输入后用当前最便宜的观察检查完成条件，不必每次同时请求 DOM、AX 和截图。保存、提交等动作应核对业务完成证据；只确认浏览器方法返回成功不足以报告业务成功。
