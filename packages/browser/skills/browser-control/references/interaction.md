# 页面交互与业务确认

需要当前 Tab 时先按 [初始化与发现](bootstrap.md) 取得真实目标。

## 导航与等待

`expectNavigation(action)` 的 action 留在 Node；先建立真实导航等待条件，再触发当前已确认的页面操作，避免漏掉导航结果。

`tab.navigate(url,{waitUntil})` 等待实际顶层导航的指定阶段，允许站点正常重定向；完成后用 `await tab.url()` 观察最终地址。方法 timeoutMs 不会延长 Run 期限；出现 TIMEOUT/取消时先检查原操作的 dispatched/effect 和实际目标状态。若原操作可能已派发，不重新点击或提交以制造同一个事件；按原目标查询事实。`waitForURL` 或显式带 `url` 的导航等待仍按指定地址精确匹配；它们不会因某个不同地址已经加载而返回成功。

## 观察、定位与业务确认

页面操作先用已登记的 `browser/observe.js` 或 `tab.semanticSnapshot()` 获取当前结构及定位属性；需要同一 Run AX 增量时再使用 `tab.observe({full:true})`。再用 `tab.playwright.getByRole/getByLabel/getByText/locator` 定位当前元素。Locator 会在操作时重新查询，包括开放 Shadow DOM 与实际生效的 Slot 分配；CSS 在各实际根内匹配，不制造跨根或 Slot 父子关系。跨组件使用 `tab.playwright.locator("#host").getByRole(...)`，进入 iframe 仍使用 `frameLocator`。同名目标先缩小范围，不自动取首个；closed Shadow 不猜测内部元素。固定 ref、dialog、chooser 等过期后需重新观察，不能把旧 ID 改猜成另一个元素。

`locator.click({position:{x:20,y:15}})` 和 `dblclick` 的位置相对元素当前矩形左上角，使用元素所在文档的 CSS 坐标，不填时取中心；iframe 的偏移和缩放由 SDK 转换。指定位置必须在元素矩形内，且该点未被遮挡；中心可用不能替代指定点可用。越界报 `INVALID_ARGUMENT`，持续遮挡可能报 `INVALID_TARGET`（`reason: element_blocked`）或在外层期限到达时返回 `TIMEOUT`，不会点击覆盖层。先重新观察，不盲目重试。

点击或输入后检查返回的实际状态。若出现 `INPUT_UNCONFIRMED` 或 `effect: unknown`，输入可能已送达：先重新观察，不自动再次点击、提交或选择文件。

点击成功只说明网页接收了输入，不代表异步业务完成。保存、支付或提交后，应等待或回读可观察的完成结果（例如确认文字或目标 URL）；确认不了就报告未知，不重复提交。

若使用 AX 增量观察，首次用 `tab.observe({full:true})`，后续可用 `tab.observe()` 获取变化；需要验证点击后的业务结果时，在点击之前提供等待条件：

以下片段的 `tab` 必须先在同一次脚本中按上方方式获取，不能单独提交为完整脚本。

```javascript
const before = await tab.observe({ full: true });
const result = await tab.playwright.getByRole("button", { name: "保存" }).click({
  expect: { kind: "text", value: "保存成功", timeoutMs: 15000 },
  timeoutMs: 20000,
});
return { before: before.url, matched: result.matched, after: await tab.observe() };
```

`click({expect})` 会等待已指定的页面条件；例如文字、导航或 URL 匹配。返回 `EXPECTATION_UNCONFIRMED` 表示业务完成尚未证实，原输入可能已经发生，不能自动重放。无 `expect` 的点击不证明异步业务结果。

同步触发原生 JavaScript 弹窗时，Browser 可依据本次输入后观察到的新弹窗返回控制权；此时使用 `tab.getJsDialog()` 查看并按用户授权处理，不要重复点击。若已指定业务 `expect`，弹窗出现不代表业务条件满足，仍返回 `EXPECTATION_UNCONFIRMED`，并保留原始输入效果未知的语义。

只需要文本 DOM 快照时，在取得当前 tab 后使用 `return await tab.playwright.domSnapshot();`，不必加载全部 API 声明。
