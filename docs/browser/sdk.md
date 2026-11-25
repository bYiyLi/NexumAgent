# Nexum browser SDK 契约

本文件是 Nexum browser 的完整公开能力设计，产品名固定为 **Nexum browser**，npm 技术包名为 `@nexum-hub/browser`，公开受管命名空间为 `browser`。当前为设计与验收输入，不宣称代码已实现、已发布或所有浏览器均支持。

## 调用入口与对象边界

```javascript
import { createBrowserClient } from "@nexum-hub/browser";

const client = createBrowserClient(browser);
const choices = await client.browsers.list();
const selectedBrowser = await client.browsers.get(choices[0].id);
const tabs = await selectedBrowser.tabs.list();
const tab = await selectedBrowser.tabs.get(tabs[0].id);
const view = await tab.playwright.domSnapshot();
// 根据本次观察选取目标，再操作，再观察。
return view;
```

`browser` 是核心按当前运行绑定的受管方法表；`createBrowserClient(browser)` 是本包普通 Node 入口导出的无 I/O 工厂。它只构造公开 Browser/Tab/Locator/Dialog/Download 等门面。私有连接、host/call、原始 handler、CDP 控制对象永不由受管方法返回。客户端每次实际 I/O 调用明确登记的受管方法；同步 locator/frame 组合只构造不可变描述，不伪造 I/O 记录。禁止用一个未声明 Schema 的任意 `invoke(method,args)` 旁路吞掉逐方法登记、校验、权限和审计。

注册层对多参数/RegExp/bytes 作显式 normalize；公开客户端负责参数保真和对象描述，不改变运行身份。当前核心只接收业务值的约束无需为 browser 放宽。脚本可直接用受管数据接口，也可用上述链式客户端；二者进入同一方法注册与 I/O。

## 通用行为

- 22 个接口、148 个成员全部列于本文及 [逐成员清单](capability-matrix.md)，属性与同步组合也必须有真实行为和验证。额外能力见本文末节，不能以 CDP 兜底说明替代已承诺的高级接口。
- 全自动操作沿已确认决定：AI 可发现、选择同设备当前及后续连接的可控标签；内部占用锁不构成人工认领或逐动作确认。扩展安装/启用、客户端身份与设备接入仍走 Nexum 当前授权；页面内容不能授予权限。
- `getDefault()`：选择本 profile 明确配置的在线默认浏览器；未设置时按 browserId 稳定排序取首个在线连接；无在线目标报 `EXTENSION_OFFLINE`。不创建窗口或导航。
- `getForUrl(url)`：规范化 HTTP(S) URL，优先已有相同 URL（发现匹配去除 userinfo/query/fragment）的目标；其次相同 origin；多个候选按 browserId 稳定排序；没有匹配走 getDefault。结果是选择建议，实际调用前仍核对连接，不预留控制资格。
- Browser/Tab/Locator 门面保留 `bootId/browserId/browserSessionId/generation/tabId` 的必要绑定；快照引用另绑定 pageVersion。查询式 Locator/Frame 每次 I/O 重解当前文档，固定 ref/节点引用失效报错，具体规则见 interaction.md。句柄不是凭据，不自动指向新连接或同名标签。
- 所有跨边界方法返回原生 Promise；属性读取、locator/frame 组合、`isMultiple()` 等已取得数据的同步操作保持同步。方法明确声明实际所需条件，不将全部方法强行变成异步。
- Locator I/O 默认等待目标唯一且满足动作可用条件；多目标报 `AMBIGUOUS_TARGET`，不得悄悄选首个。`first/last/nth` 为显式选择，`all` 返回当前快照集合；`filter/and/or` 只组合当前同目标的定位描述。
- 页面求值接受字符串与显式可序列化参数；Node 函数、DOM 节点、CDP session 和捕获局部变量的闭包不跨越连接。`expectNavigation(action)` 的回调在本地 Node 执行，先注册等待、再调用 action，失败/取消时清理等待器。
- 方法默认期限 30 秒；下载/媒体方法默认 120 秒；有效截止为方法期限、`call.deadline` 和取消信号共同约束。总运行期限、容量、输入等待与终态由 Nexum 负责，不沿用 QuickJS 的 60/300 秒运行上限、32 次桥接或 8/1 全局执行队列。
- 结果使用原生文本、结构化数据、bytes 和本机文件；大内容遵守 [结果交付](results.md)，不默认 base64，不强行套用旧 64 KiB 图片/上传限制。截图默认 JPEG quality=80、最长边 1920px；显式请求仍受平台媒体/像素预算。
- 快照默认正文预算 64 KiB；结构化快照截断明确标志并可返回完整本机 artifact，最后经 output 固定为资源；纯字符串接口超限明确报错。`tabs.content` 每批 1–8 个 HTTP(S) URL、默认/最大 30 秒、每页 4096 UTF-16 代码单元、批次普通 JSON 最多 60000 UTF-8 字节；临时标签在成功/失败后清理。
- 历史默认 limit=20、范围 1–20、queries 最多 4 个，按 URL 去重并按访问时间倒序；未知浏览器权限不能伪装为空结果。不同浏览器配置的历史不合并。
- 操作发出后断连/取消/超时，若无法确认效果，错误记录 `effect: "unknown"`。先重新观察，不自动重发点击、提交、文件选择、下载、移动或关闭。
- Browser/Tab 的 capability 发现只说明当前原生可用性。缺权限、受限页面、企业策略、WebMCP 未注册、CDP 调试器冲突等返回准确原因；实现缺失必须记为未完成，不能假装浏览器不支持。
- `markDeliverable` 记录结果标签和结束视觉状态，`markHandoff` 释放本次控制并交还标签；原始 `requestManualHandoff` 的目标方法名为 `requestUserTakeover`，映射为可选用户接管请求，等待复用 runtime 输入，不自动增加审批或修改 run 终态。
- `ax.write` 返回可交付的 `OutputIntent`，由脚本 return/组合结果交付；不建立隐藏的模型消息通道。`library_file` 映射为本地 document/标准资源，不依赖特定 Host 文件库。
- `ax.get/write` 的文字观察包含当前标题、URL、原生元素索引及可观察的值/状态。首次读取、文档或控制身份变化时返回完整状态；同一运行、同一标签后续读取可返回较小的新增/删除/变化差异，无变化时明确说明。`disableDiffing:true` 强制完整文字并更新该基准，纯截图和结构化 `ax.snapshot()` 不推进文字基准；失败/取消的混合读取不消费基准。差异只是一种有界交付优化，不能将旧索引改绑到新元素，也不恢复其他运行的隐式状态。
- 导出、上传、剪贴板、Cookie/JS 和 CDP 遵守同一自动操作合同，不按业务类别建立额外许可弹窗。浏览器自身和目标网站限制如实反馈，不能从全量 CDP 目标推导浏览器后端支持任意命令。

## 类型与逐接口签名

所有参数/返回类型收录于 [SDK 类型](sdk-types.md)。以下签名按参考接口逐项适配；`Agent` 改为公开客户端 `BrowserClient`，`dom_cua/get_visible_dom/double_click/goto/back` 沿已确认 Avru 映射为 `dom/getVisibleTree/doubleClick/navigate/goBack`。原始参考资料不随公开仓库分发。

## BrowserClient

工作入口；BrowserClient 由公开 Node 客户端构造，不创建第二个 Agent。

```typescript
interface BrowserClient {
  browsers: Browsers;
}
declare function createBrowserClient(
  methods: Readonly<Record<string, unknown>>,
): BrowserClient;
```

工厂参数是当前运行注入的普通方法容器，构造时核对已知路由；Record 只描述容器边界，不提供任意 invoke。每条实际 I/O 的目标、AST、输入/输出、Schema 与权限仍按本合同登记。

## Browsers

从已连接目标发现或选择；默认/URL 选择规则固定在 SDK 正文，不创建浏览器或静默导航。

```typescript
interface Browsers {
  get(id: string): Promise<Browser>;
  getDefault(): Promise<Browser>;
  getForUrl(url: string): Promise<Browser>;
  list(): Promise<BrowserInfo[]>;
}
```

## Browser

浏览器元数据、能力、标签页、历史和会话命名，按当前连接重新核对。

```typescript
interface Browser {
  browserId: string;
  capabilities: BrowserCapabilityCollection;
  downloads: {
    list(options?: { limit?: number; id?: number }): Promise<BrowserDownloadRecord[]>;
  };
  tabs: Tabs;
  user: BrowserUser;
  history(options?: BrowserHistoryOptions): Promise<Array<BrowserHistoryEntry>>;
  nameSession(name: string): Promise<void>;
}
```

`downloads.list()` 返回当前浏览器配置的原生下载记录和文件路径；已知原生数字 ID 时可用 `downloads.list({id})` 精确查询；它不按标签或目录筛选，也不将记录自动归属当前运行。选定文件后可用 Node 读取或通过 `{type:"resource_link",path:...}` 登记 MCP Resource；文件访问仍检查当前权限。

## BrowserUser

发现用户已有标签；claimTab 是自动内部互斥/公开对象绑定，不增加人工认领。

```typescript
interface BrowserUser {
  claimTab(tab: string | BrowserUserTabInfo): Promise<Tab>;
  getTabContext(
    tab?: string | BrowserUserTabInfo,
  ): Promise<BrowserUserTabContext>;
  openTabs(): Promise<Array<BrowserUserTabInfo>>;
}
```

## Tabs

目标归属必须包含浏览器和连接代次；新建/选择/后台读页的实际状态可验证。

```typescript
interface Tabs {
  content(options: TabsContentOptions): Promise<Array<TabsContentResult>>;
  get(id: string): Promise<Tab>;
  list(): Promise<Array<TabInfo>>;
  new: (url?: string, options?: { active?: boolean }) => Promise<Tab>;
  select(id: string): Promise<ActionResult>;
  selected(): Promise<undefined | Tab>;
}
```

## Tab

页面导航、观察、结果标记和可选人工接管；页面变化使旧观察引用失效。

```typescript
interface Tab {
  ax: AXAPI;
  capabilities: TabCapabilityCollection;
  clipboard: TabClipboardAPI;
  content: ContentAPI;
  cua: CUAAPI;
  dev: TabDevAPI;
  dom: DomCUAAPI;
  id: string;
  playwright: PlaywrightAPI;
  goBack(options?: NavigationOptions): Promise<ActionResult>;
  close(): Promise<void>;
  forward(options?: NavigationOptions): Promise<ActionResult>;
  getJsDialog(): Promise<undefined | Dialog>;
  navigate(url: string, options?: NavigationOptions): Promise<ActionResult>;
  markDeliverable(): Promise<void>;
  markHandoff(): Promise<void>;
  reload(options?: NavigationOptions): Promise<ActionResult>;
  requestUserTakeover(): Promise<void>;
  requestUserTakeover(
    reason?: "authentication" | "captcha" | "user_requested" | "other",
  ): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<Uint8Array>;
  title(): Promise<undefined | string>;
  url(): Promise<undefined | string>;
}
```

## AXAPI

无障碍节点或坐标操作；节点索引绑定当前页面修订；write 返回可交付内容值。

```typescript
interface AXAPI {
  click(target: number | AXPoint, options?: AXClickOptions): Promise<void>;
  drag(from: AXPoint, to: AXPoint): Promise<void>;
  get(mode?: "state", options?: AXStateOptions): Promise<string>;
  get(mode: "screenshot"): Promise<Uint8Array>;
  get(
    mode: "both",
    options?: AXStateOptions,
  ): Promise<{ screenshot?: Uint8Array; state: string }>;
  paste(
    elementIndex: null | number,
    text: string,
    options?: AXPasteOptions,
  ): Promise<void>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
  pressKey(
    elementIndex: null | number,
    key: string,
    options?: AXPressKeyOptions,
  ): Promise<void>;
  scroll(
    target: number | AXPoint,
    direction: AXDirection,
    pages?: number,
  ): Promise<void>;
  selectText(
    elementIndex: number,
    text: string,
    options?: AXSelectTextOptions,
  ): Promise<void>;
  setValue(elementIndex: number, value: string): Promise<void>;
  typeText(elementIndex: null | number, text: string): Promise<void>;
  write(mode?: "state", options?: AXStateOptions): Promise<OutputIntent>;
  write(mode: "screenshot"): Promise<OutputIntent>;
  write(mode: "both", options?: AXStateOptions): Promise<OutputIntent>;
}
```

## ContentAPI

在当前登录和页面状态提取实际内容，导出为本地字节/文件；不依赖特定 Host 文件库。

```typescript
interface ContentAPI {
  export(): Promise<BrowserArtifact>;
  exportGsuite(
    type: "pdf" | "md" | "xlsx" | "csv" | "docx" | "pptx",
  ): Promise<BrowserArtifact>;
  exportYouTubeTranscript(): Promise<BrowserArtifact>;
}
```

## CUAAPI

视口坐标、鼠标、键盘和媒体获取；操作前后的观察及虚拟鼠标遵守同一目标。

```typescript
interface CUAAPI {
  click(options: ClickOptions): Promise<void>;
  doubleClick(options: DoubleClickOptions): Promise<void>;
  downloadMedia(options: CuaDownloadMediaOptions): Promise<BrowserArtifact>;
  drag(options: DragOptions): Promise<void>;
  keypress(options: KeypressOptions): Promise<void>;
  move(options: MoveOptions): Promise<void>;
  scroll(options: ScrollOptions): Promise<void>;
  type(options: TypeOptions): Promise<void>;
}
```

## DomCUAAPI

可见 DOM 节点操作；节点身份不可猜测，失效后重新观察。

```typescript
interface DomCUAAPI {
  click(options: DomClickOptions): Promise<void>;
  doubleClick(options: DomClickOptions): Promise<void>;
  downloadMedia(options: DomDownloadMediaOptions): Promise<BrowserArtifact>;
  getVisibleTree(): Promise<VisibleDomTree>;
  keypress(options: DomKeypressOptions): Promise<void>;
  scroll(options: DomScrollOptions): Promise<void>;
  type(options: DomTypeOptions): Promise<void>;
}
```

## PlaywrightAPI

语义定位、页面观察、导航与事件等待；等待先注册，回调只在 Node 客户端执行。

```typescript
interface PlaywrightAPI {
  domSnapshot(): Promise<string>;
  elementInfo(options: ElementInfoOptions): Promise<Array<ElementInfo>>;
  elementScreenshot(options: ElementScreenshotOptions): Promise<Uint8Array>;
  evaluate<TResult, TArg>(
    pageFunction: PlaywrightEvaluateFunction<TArg, TResult>,
    arg?: TArg,
    options?: PlaywrightEvaluateOptions,
  ): Promise<TResult>;
  expectNavigation<T>(
    action: () => Promise<T>,
    options?: { timeoutMs?: number; url?: string; waitUntil?: WaitUntil },
  ): Promise<T>;
  frameLocator(frameSelector: string): PlaywrightFrameLocator;
  getByLabel(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  getByPlaceholder(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  getByRole(
    role: string,
    options?: { exact?: boolean; name?: TextMatcher },
  ): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;
  getByText(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  locator(selector: string): PlaywrightLocator;
  waitForEvent(
    event: "download",
    options?: WaitForEventOptions,
  ): Promise<PlaywrightDownload>;
  waitForEvent(
    event: "filechooser",
    options?: WaitForEventOptions,
  ): Promise<PlaywrightFileChooser>;
  waitForLoadState(options?: PageWaitForLoadStateOptions): Promise<void>;
  waitForTimeout(timeoutMs: number): Promise<void>;
  waitForURL(url: string, options?: PageWaitForURLOptions): Promise<void>;
}
```

## PlaywrightFrameLocator

同步构造 frame 描述；执行时重新解析，不把 DOM/协议对象带回脚本。

```typescript
interface PlaywrightFrameLocator {
  frameLocator(frameSelector: string): PlaywrightFrameLocator;
  getByLabel(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  getByPlaceholder(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  getByRole(
    role: string,
    options?: { exact?: boolean; name?: TextMatcher },
  ): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;
  getByText(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  locator(selector: string): PlaywrightLocator;
}
```

## PlaywrightLocator

同步组合定位器；I/O 时进入受管方法；唯一性、可见性、超时与错误规则一致。

```typescript
interface PlaywrightLocator {
  all(): Promise<Array<PlaywrightLocator>>;
  allTextContents(options?: { timeoutMs?: number }): Promise<Array<string>>;
  and(locator: PlaywrightLocator): PlaywrightLocator;
  check(options?: LocatorCheckOptions): Promise<void>;
  click(options?: LocatorClickOptions): Promise<void>;
  count(): Promise<number>;
  dblclick(options?: LocatorClickOptions): Promise<void>;
  downloadMedia(
    options?: LocatorDownloadMediaOptions,
  ): Promise<BrowserArtifact>;
  evaluate<TResult, TArg>(
    pageFunction: LocatorEvaluateFunction<TArg, TResult>,
    arg?: TArg,
    options?: PlaywrightEvaluateOptions,
  ): Promise<TResult>;
  evaluateAll<TResult, TArg>(
    pageFunction: LocatorEvaluateAllFunction<TArg, TResult>,
    arg?: TArg,
    options?: PlaywrightEvaluateOptions,
  ): Promise<TResult>;
  fill(value: string, options?: { timeoutMs?: number }): Promise<void>;
  filter(options: LocatorFilterOptions): PlaywrightLocator;
  first(): PlaywrightLocator;
  getAttribute(
    name: string,
    options?: { timeoutMs?: number },
  ): Promise<null | string>;
  getByLabel(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  getByPlaceholder(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  getByRole(
    role: string,
    options?: { exact?: boolean; name?: TextMatcher },
  ): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;
  getByText(
    text: TextMatcher,
    options?: { exact?: boolean },
  ): PlaywrightLocator;
  innerText(options?: { timeoutMs?: number }): Promise<string>;
  isEnabled(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  last(): PlaywrightLocator;
  locator(selector: string, options?: LocatorLocatorOptions): PlaywrightLocator;
  nth(index: number): PlaywrightLocator;
  or(locator: PlaywrightLocator): PlaywrightLocator;
  press(
    value: string,
    options?: { timeoutMs?: number; modifiers?: KeyboardModifier[] },
  ): Promise<void>;
  pressSequentially(
    value: string,
    options?: LocatorPressSequentiallyOptions,
  ): Promise<void>;
  selectOption(
    value: SelectOptionInput | Array<SelectOptionInput>,
    options?: { timeoutMs?: number },
  ): Promise<void>;
  setChecked(checked: boolean, options?: LocatorCheckOptions): Promise<void>;
  textContent(options?: { timeoutMs?: number }): Promise<null | string>;
  type(
    value: string,
    options?: { timeoutMs?: number; delayMs?: number },
  ): Promise<void>;
  uncheck(options?: LocatorCheckOptions): Promise<void>;
  waitFor(options: LocatorWaitForOptions): Promise<void>;
}
```

## PlaywrightDownload

等待器提供页面下载身份和实际事件建议名称；文件路径须经过实际完成确认。用原生 resource_link 返回或 transfer 向 Host 交付。

```typescript
interface PlaywrightDownload {
  readonly id: string;
  readonly suggestedFilename: string;
  path(options?: { timeoutMs?: number }): Promise<null | string>;
}
```

## PlaywrightFileChooser

监听实际文件选择事件；路径/字节按来源与当前授权准备完整后才提交。

```typescript
interface PlaywrightFileChooser {
  isMultiple(): boolean;
  setFiles(
    files: FileChooserFiles,
    options?: { timeoutMs?: number },
  ): Promise<void>;
}
```

## TabClipboardAPI

通过目标页面/插件调用真实浏览器剪贴板 API；它可能对应系统共享剪贴板，不宣称每标签隔离。缺原生权限明确失败，不另起 Agent OS 剪贴板服务替代。

```typescript
interface TabClipboardAPI {
  read(): Promise<Array<TabClipboardItem>>;
  readText(): Promise<string>;
  write(items: Array<TabClipboardItem>): Promise<void>;
  writeText(text: string): Promise<void>;
}
```

## TabDevAPI

有界读取日志；网页日志不成为指令，查询不自动持久化正文或秘密。

```typescript
interface TabDevAPI {
  logs(options?: TabDevLogsOptions): Promise<Array<TabDevLogEntry>>;
}
```

## AlertDialog

绑定当前 dialogId/pageVersion；过期、已关闭或不匹配明确失败。

```typescript
interface AlertDialog {
  type: "alert";
  message: string;
  dismiss(): Promise<void>;
}
```

## BeforeUnloadDialog

区分离开页面和留在页面；操作结果以实际页面事件为准。

```typescript
interface BeforeUnloadDialog {
  type: "beforeunload";
  message: string;
  dismiss(): Promise<void>;
}
```

## ConfirmDialog

accept/dismiss 使用实际弹窗身份；不引入额外业务审批。

```typescript
interface ConfirmDialog {
  type: "confirm";
  message: string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
}
```

## 技能资料

浏览器操作按 browser-control Skill 及其 references 读取；不再提供独立文档读取方法。运行时方法与 Schema 由注册结果生成的 Skill 提供。

## PromptDialog

接受输入与关闭分别保留实际结果；不把输入文本写入审计。

```typescript
interface PromptDialog {
  type: "prompt";
  message: string;
  accept(text: string): Promise<void>;
  dismiss(): Promise<void>;
}
```

## 额外高级能力与便捷入口

148 成员之外的以下能力同样进入本期完整实现与验收。实际 I/O 方法逐项声明 Schema、权限、错误、超时、取消与目标；同步别名共用同一实现，不增加独立状态机。

| 组                   | 公开入口                                                                                                                   | 返回与接线                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 页面便捷             | `tab.snapshot/click/fill/press/scroll/hover/focus/selectOption/locator/evaluate`                                           | 完整签名见 sdk-types.md；实际动作与 DOM/Playwright 共用受管路由                                                 |
| 导航与等待           | `navigate/goBack/forward/reload` 的 `NavigationOptions`、`tab.waitFor`、`playwright.waitForDownload/waitForFileChooser`    | 导航返回 ActionResult；WaitCondition 完整支持 selector/text/url/navigation/state；事件等待按下文先 arm          |
| Frame                | `tab.frame(selector)` 及 `Frame` 的全部 11 个成员                                                                          | 验证目标后构造查询门面；不把真实 frame 控制器返回 Node                                                          |
| 键盘与视口           | `tab.keyboardDown/keyboardUp/setViewport/resetViewport`、`selectedBrowser.viewport.set/reset`                              | 实际 CDP 按键状态与覆盖由 run 资源管理；浏览器级视口无 tabId 时在调用时解析 selected 标签                       |
| 文件与下载           | `tab.setFiles/downloads/saveDownload`                                                                                      | 全部输入准备好才提交；返回真实已完成本机文件                                                                    |
| 对话框               | `tab.dialogAccept/dialogDismiss`、原生 Dialog 的 type/message                                                              | 对当前 dialogId 操作；text 仅用于 prompt；原生无障碍/权限错误如实反馈                                           |
| 内容与剪贴板别名     | `tab.contentExport/exportGsuite/exportYouTubeTranscript/clipboardReadText/clipboardWriteText/clipboardRead/clipboardWrite` | 文本导出支持 html/markdown/text；文件和多格式剪贴板使用本机产物/原生 bytes，不使用旧 base64                     |
| 窗口、标签、组、书签 | `selectedBrowser.management` 及 `windows/tabs/tabGroups/bookmarks` 便捷命名空间                                            | ManagementCapability 给出逐方法完整参数/返回；`tabs.select` 是显式激活，`tabs.new(url?,{active?})` 支持 HTTP(S)、省略 URL 或显式 `about:blank` 创建空白标签；不因此开放其他受保护协议或页面控制 |
| 组织审计             | `selectedBrowser.management.getAuditTrail`                                                                                 | 有界 before/变更分页；不自动撤销                                                                                |
| 页面资产与文件导出   | `tab.assets.list/download/bundle`、`tab.exportFile`                                                                        | inventory/页面修订绑定；实际文件、manifest、逐项失败，不把导航当下载                                            |
| WebMCP               | `tab.webmcp.listTools/invokeTool/fetchTools`、返回门面的 `invokeTool`                                                      | 精确绑定 document/registration revision；先发现后调用，不自动改用同名新注册                                     |
| CDP                  | `tab.cdp.send/events/cursor/readEvents`                                                                                    | 浏览器原生可达全域命令/事件、child target、分页/丢失信息；不以高级接口缺失要求用户自行写 CDP                    |
| 可见性适配           | `selectedBrowser.visibility.get/set`                                                                                       | 读取/设置前台标签跟随开关；是 Avru 原生映射，不能宣称可隐藏/显示 OS 窗口                                        |
| 能力发现             | Browser/Tab 的 `capabilities.list/get`                                                                                     | 元数据经受管方法返回；已知能力由客户端构造类型化门面，未知能力明确失败                                          |
| 登录协助             | `tab.requestUserTakeover("authentication")`、页面/Dialog/Cookie/JS/CDP                                                     | 原浏览器/站点流程；用户接管等待沿 runtime，不创建 Host 专属认证后端                                             |

组织接口的结构化返回包括实际浏览器原生 ID、窗口/分组归属和变更事实；TypeScript/Schema 在实现时逐接口固化，不能用 `unknown` 代替真实返回的长期合同。source `api.json` 的 148 成员及上表方法都必须出现在能力清单，逐项关联实现和验收。

## 统一错误

浏览器业务错误保留 `BrowserError`：`code/message/operationId/dispatched/effect/retryable` 及有界目标身份。不得包含 Token、Cookie、输入文本或敏感 URL。公开枚举：`INVALID_ARGUMENT`、`INVALID_TARGET`、`AMBIGUOUS_TARGET`、`TARGET_GONE`、`STALE_REF`、`EXTENSION_OFFLINE`、`PROTOCOL_MISMATCH`、`PROFILE_MISMATCH`、`PROFILE_CONFLICT`、`PORT_IN_USE`、`PERMISSION_DENIED`、`TAB_ALREADY_CLAIMED`、`CAPABILITY_NOT_ALLOWED`、`QUEUE_FULL`、`TIMEOUT`、`UNKNOWN_RESULT`、`CDP_DISCONNECTED`、`TAB_CLOSED`、`USER_TAKEOVER`、`OUTPUT_TOO_LARGE`、`FILE_UNAVAILABLE`、`RESOURCE_EXPIRED`、`TOPIC_NOT_FOUND`、`STALE_REGISTRATION`、`WAITER_GONE`。平台自身的 run/operation/maintenance 错误保留平台代码，不创造 `RUNNER_CRASHED/DAEMON_UNAVAILABLE` 替代 Nexum 事实。

`TAB_NOT_CLAIMED`、Avru executionId、QuickJS 资源错误只留在历史归档；新调用不以手动认领或 Avru 运行器作为前置。业务已失败与资源已经关闭是独立事实；出错不自动回滚网页动作，也不伪造 run 终态。

## 额外能力的类型与路由约定

额外能力的全部结构化返回和参数已在 SDK 类型中的 ManagementCapability、PageAssetsCapability、CdpCapability、WebMcpCapability、VisibilityCapability 和 ViewportCapability 定义。Browser 的 windows/tabs/tabGroups/bookmarks 便捷入口与 management capability 使用同一受管方法；windows.getAll({populate}) 补充 list 的包含标签形态，不新增浏览器后端。

capabilities.get 的受管结果只返回能力 ID/版本/支持状态及已声明数据，公开客户端按本包已知类型构造对应门面；不能让 handler 返回带函数的 capability 对象。未知能力返回明确错误而非任意可执行实现。viewport 的浏览器级入口优先显式 tabId；省略时在该次受管调用中重新取得原生 selected 标签，无 selected 明确报 INVALID_TARGET，不缓存全局当前标签。Tab 入口使用原绑定目标。覆盖通过目标 CDP 实现，不调整其他窗口；临时覆盖 reset，控制释放时清理本 run 的覆盖，不承诺脱离控制仍保持虚拟视口。

组织审计默认从最近记录向前返回 100 项，limit=1–100，使用返回的 `nextCursor` 续读；后续追加记录不移动既有游标。游标绑定当前审计实例，切换浏览器或 worker 重启后使用旧游标返回 `STALE_REF`。最多保留 1000 条/7 天及合计 10 MiB，写入和读取时均清理过期记录；`truncated` 明确表示已有记录因保留边界被淘汰。

`before` 读取该次实际目标的窗口几何、标签位置/固定/静音及分组、组元数据或书签原位置。URL 移除用户名、密码、query 和 hash，不保存 data/blob/file 地址；不保存页面正文、表单输入、请求参数或原生异常正文。单次 before 超出已有 10 MiB 审计预算时，在变更前明确拒绝。组织操作沿用现有运行范围与目标锁，不以审计入口绕过占用检查。

进入浏览器变更处理的每个 operation 只有一条审计记录：原生变更已发出但尚未确认时为 `unknown`；实际成功返回后更新为 `confirmed`，即使等待者此时已取消；变更前拒绝为 `failed`。在上层运行范围或权限检查中已被拒绝、未进入浏览器的调用由平台 operation 历史记录，不伪造原生审计。`changedIds` 只列已确认的原生变化身份，关闭/移除也保留原目标 ID；失败或未知时为空。审计结果与 Run 终态分别记录，不自动回滚或撤销。

额外字段约束：字符串 ID 非空且有界（最多 256 UTF-8 bytes）；窗口尺寸正整数且位于浏览器可用范围；index 为 -1 或非负整数；group/tabId 必须来自同一当前浏览器配置，默认不跨窗口移动；bookmark URL 仅 HTTP(S)。重复/冲突字段、未知字段、无效正则、失效 inventory/registration 都在 I/O 前明确拒绝。方法的真实 Schema 与这些类型/规则共同生成，禁止只用 Record<string,unknown> 充当最终方法合同。

## 原始 Host 类型的具体适配

浏览器列表只返回 BrowserInfo：实际扩展连接、browserId/boot/generation、浏览器/插件版本及来源；不带 codexSessionId、iab/mcpapps 类型或其他 Host 会话。内容 export/exportGsuite/exportYouTubeTranscript 与媒体下载返回 BrowserArtifact，明确实际文件、MIME、大小和 hash，不用含义不明的字符串代替文件交付。getVisibleTree 返回结构化 VisibleDomTree；截图/历史的可选参数与上述默认值一致。原始接口只用于能力核对，以上是 Nexum browser 的正式目标签名。

## Avru 与原始资料的适配裁定

本节固定审查中容易丢失或冲突的语义；当前目标不是对旧 daemon/QuickJS 的二进制兼容。

| 来源事实                                                                        | Nexum browser 合同                                                                                                                                                                                                                                        | 验收归属                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Avru Tab/Frame/Playwright 的便捷方法和默认可省略 options                        | 全部保留为当前客户端入口或同语义别名；Frame 11 个成员逐项计账。`Tabs["new"]` 是可调用方法，不是 TypeScript 构造签名                                                                                                                                       | X 清单、SDK 类型用法检查、D1    |
| Avru `ScreenshotOptions.quality/maxEdgePx`、Locator `clickCount/position`       | 保留；quality 为 0–100 整数，maxEdgePx 为正整数并限制实际图片的最长像素边；默认 JPEG/80/1920。clip 使用 CSS 坐标，缩放和 4000 万解码像素预算计入原生像素密度，不放大小图。fullPage 与 clip 同时指定拒绝，clip/position 需有限合法坐标；媒体字节预算仍检查 | 截图/Locator 点击入口、E5       |
| 原始 Locator options 有 force；Avru M0 明确不开放                               | 本包不提供 force，未知字段校验拒绝；按可操作性与用户真实目标执行                                                                                                                                                                                          | D1、非法输入                    |
| 原始 AXPoint 为未约束 tuple；Avru 使用具名坐标                                  | 当前固定 `{x:number,y:number}`，有限坐标，不新建旧 tuple 兼容层                                                                                                                                                                                           | AX 点击/拖拽入口、类型与 Schema |
| Avru 导航/等待返回实际版本和快照，PageSnapshot 有 dialog                        | 导航返回 ActionResult，版本在 target；waitFor 返回 matched=true 与新快照，超时抛错；保留 dialog；BrowserError 用 target 代替旧扁平身份字段                                                                                                                | 导航入口、X009、D1              |
| 原始 visibility 表示 Host 自带浏览器是否呈现；Avru 只跟随原生标签、不抢 OS 前台 | 当前 get/set 只表示 followSessionTab；set(false) 不隐藏用户窗口，set(true) 不承诺解除最小化/抢焦点。原始 viewport 映射为目标标签覆盖，省略目标按上文 selected 规则                                                                                        | X048/X049、视口、D5             |
| 原始/旧 QuickJS 的上传与剪贴板 base64、Host library_file                        | 本机路径/原生 bytes/Blob 与标准 output/Resources；resource 分支只可指已经存在且当前可访问的 URI，不能在 handler 内虚构注册                                                                                                                                | E1–E5                           |
| Browser 的 name/type/profileName 与 claimed、全局 browser.tab                   | 前三者为核对后的公开元数据；claimed 仅内部锁事实，不作人工前置；脚本显式获取 Browser/Tab，取消旧 daemon 注入全局当前目标                                                                                                                                  | A3、B1、C2                      |
| WebMCP 返回含函数的绑定对象                                                     | 插件返回 tools 与 document/registration revision 数据，Node 构造绑定门面；调用前核对同一修订和输入 Schema，变化报 STALE_REGISTRATION                                                                                                                      | X041–X043、D4                   |
| 原始 browserAuth/siwc/botDetection 与 iab/mcpapps                               | Host 专属认证/私有后端不搬入；登录选择、表单、扫码展示与用户接管由普通观察/原站点和 runtime 输入承接；botDetection 按已确认范围不实现                                                                                                                     | 登录协助、D6                    |

`keyboardDown` 记录本 run 已成功按下的键；`keyboardUp` 按真实状态释放。失败/取消/用户接管必须尽力释放本包按键、鼠标按钮和临时视口，反馈未确认项，不能向用户其他页面乱发释放键。`dialogAccept/dismiss` 先取得当前 dialog 描述再使用同一 ID；重复或页面替换不自动操作新 dialog。别名可共用实现，不等于可省略对每个公开入口的参数与行为验收。

## 等待器与客户端参数接线

`LocatorDescription` / `LocatorData` 是跨受管边界的纯数据。客户端把 has/hasNot/and/or 的 Locator 门面递归转为 AST，把 RegExp 转为 source/flags；handler 不接收门面、函数或自定义原型。组合必须是同一 boot/browser/session/generation/tab/frame 作用域；AST 深度最多 16、节点最多 128、framePath 最多 8、单正则源码最多 1024 UTF-8 bytes，拒绝无效 flags、环、越界和不同目标。正则不隐式保留 lastIndex，执行受调用期限约束；不能宣称同步页面 JS 可被强制抢占。

扩展公开登记 `browser.waiters.arm/get/cancel` 三个精确数据方法，输入/返回见 SDK 类型。它们是本包普通方法，不是 Agent 新服务或插件接受的任意 RPC：

1. arm 以真实 call 身份登记 run 资源，建立插件端导航/download/filechooser 监听，**收到已就绪确认后**返回不透明 waiterId 与有效期限。就绪前观察到的相关事件必须缓冲；不能先返回 ID 后异步安装监听。
2. Node 的 expectNavigation 先 await arm，再运行本地 action，再 get；finally cancel 撤销未消费等待。action 失败时保留原错误，取消失败单独记录；所有已建 Promise 均观察拒绝。action 回调和返回的 T 不跨 WS。
3. `const pending = tab.playwright.waitForEvent("download"); await link.click(); await pending;` 同样成立。客户端在进入 waitForEvent 时同步排入该目标的“等待就绪”屏障，后续动作只等 **arm ready**；get 的长等待不阻塞目标发送队列或让 click 排在事件之后。不能把整个 get Promise 放入串行队列形成自锁。arm 失败拒绝对应后续动作，避免点击发生而下载无人跟踪。
4. get 从当前 run 的有界缓冲取精确事件；早到事件不丢失，重复 get 返回同一已消费事实，不再触发网页工作。最多每 run/target 32 个等待器，事件数据受连接预算；超量先拒绝再动作。下载/chooser 描述由客户端构造公开门面；有访问权的 ID 也不能跨 run/页面偷用。
5. cancel 幂等，取消/到期/运行收尾清理远端监听、缓冲和关联；无所有权报 WAITER_GONE/权限错误。下载事件只证明原生下载已开始，path/saveDownload 还需实际完成证据；取消等待器不等于撤回网页下载。

`waitForDownload/waitForFileChooser` 是 waitForEvent 的别名。浏览器事件等待与 runtime.requestInput 的单次用户输入等待是两种不同资源；不占用或替代平台唯一的输入槽。WebMCP 的 listTools/fetchTools 返回版本数据后，客户端缓存**这一份**注册描述；invokeTool 无先前发现则先完成发现并使用其返回描述，已有描述失效就报错，不能静默自动换成新版本。`fetchTools()` 返回门面的 invokeTool 永远绑定它那次获取的精确注册。

CDP readEvents 省略 afterSequence 时从当前游标开始；methods 若提供必须非空，过滤条件分页保持一致。已 detach child 的缓冲事件仍可按其原 target 筛选，但不能再对该 child send；游标/事件绑定当前门面的连接代次，旧门面不可跨重连复用。PageAssets inventory 是某次当前文档观察的固定集合，后续 list 不改写旧集合；bundle 按原 inventory 的真实 ID 下载，文档替换则明确失效，不能把新页面同 URL 的资源套入旧 inventory。

AX/DOM 快照中供后续方法使用的数字索引由本包映射到实际节点与观察修订；同一 run/控制租约内不得把已失效的数字重新分配给另一个节点。AX.get 的文本与 AX.snapshot 的结构保留观察身份，DomCUA 操作使用对应映射，不能只把原生易重用的下标当稳定引用。引用表有界并在目标/运行失效时清理，达到容量明确拒绝；查询式 Locator 与上述固定节点仍遵守不同的重解规则。

Locator 的 has/hasNot 在每个候选节点内部作相对查询，不能把其他目标/其他 frame 的定位器组合进来；all() 的固定成员不会在后续 DOM 排序变化后改指另一节点。ActionResult.changed 仅描述已观察到的页面变化，false 不证明站点无后台业务副作用；UNKNOWN_RESULT 也不能转成 changed=false 的成功。

按键/按钮台账也跟踪能够明确识别的 raw CDP Input 事件；原始协议通道仍受同一目标租约、取消和控制收尾约束。截图入口默认 JPEG；AX 的 both 模式要求实际取得状态和图像，无法取得其中一项时明确失败，不把缺图伪装成完整成功。

Avru 的 Locator.type.delayMs 与 press.modifiers 均保留；delayMs 为有限非负毫秒数，逐字符输入仍受当前截止约束。CUA button 按 Avru 的 1=左、2=中、3=右、4=后退、5=前进映射，默认 1；keypress/AX pressKey 的 duration 单位为秒且在 0–30 内，不混作 timeoutMs。DOM CUA 的 NodeId 是本包不透明字符串，与 node_id 输入一致；ElementInfo/资产来源的原生 CDP nodeId 保留数字，两个命名空间不互换。WaitCondition 对 selector/text/url 保留 value，navigation 使用 url/waitUntil、state 使用实际 LoadState；元素可见性等状态由 selector/element 的 state 表达，不复制旧的无区分字段组合。
