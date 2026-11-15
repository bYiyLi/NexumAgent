# Nexum browser SDK 类型

本文件与 [SDK 契约](sdk.md) 共同定义公开 Node 客户端的数据类型。67 个来源类型已转为本包接口输入；另补目标、文件和错误类型。对应候选实现已经存在，独立协议包尚未发布，完整验收状态见开发记录。

图像/二进制为真实字节；方法不返回 WebSocket、CDP session 控制器、host/call 或 Agent 私有对象。函数只允许在客户端编排 API 使用；页面求值仍使用字符串表达式和显式参数，不能跨浏览器传递 Node 闭包。`OutputIntent` 使用 [公共运行服务](platform-contract.md) 定义的结果类型。

```typescript
type BrowserCapabilityCollection = {
  get(id: "management"): Promise<ManagementCapability>;
  get(id: "visibility"): Promise<VisibilityCapability>;
  get(id: "viewport"): Promise<ViewportCapability>;
  get(id: string): Promise<CapabilityInfo>;
  list(): Promise<CapabilityInfo[]>;
};

interface BrowserHistoryOptions {
  from?: string | Date;
  limit?: number;
  queries?: Array<string>;
  to?: string | Date;
}

interface BrowserHistoryEntry {
  dateVisited: string;
  title?: string;
  url: string;
}

interface BrowserDownloadRecord {
  id: number;
  filename: string;
  state: "in_progress" | "interrupted" | "complete";
  startTime: string;
  endTime?: string;
  fileSize: number;
  totalBytes: number;
  bytesReceived: number;
  mime: string;
  exists: boolean;
}

interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  providerTabId?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

type BrowserUserTabContext =
  | { kind: "artifact"; artifact: BrowserArtifact; title: string; url: string }
  | {
      kind: "text";
      text: string;
      title: string;
      truncated: boolean;
      artifact?: BrowserArtifact;
      url: string;
    }
  | {
      kind: "document";
      data: Uint8Array;
      fileName: string;
      mimeType: string;
      title: string;
      url: string;
    }
  | {
      kind: "resource";
      uri: string;
      fileName: string;
      mimeType: string;
      title: string;
      url: string;
    };

interface TabsContentOptions {
  contentType: TabsContentType;
  timeoutMs?: number;
  urls: Array<string>;
}

interface TabsContentResult {
  truncated: boolean;
  content: null | string;
  title: null | string;
  url: string;
}

interface TabInfo {
  id: string;
  providerTabId?: string;
  title?: string;
  url?: string;
}

type TabCapabilityCollection = {
  get(id: "pageAssets"): Promise<PageAssetsCapability>;
  get(id: "cdp"): Promise<CdpCapability>;
  get(id: "webmcp"): Promise<WebMcpCapability>;
  get(id: string): Promise<CapabilityInfo>;
  list(): Promise<CapabilityInfo[]>;
};

type Dialog = AlertDialog | BeforeUnloadDialog | ConfirmDialog | PromptDialog;

type ScreenshotOptions = {
  clip?: ClipRect;
  fullPage?: boolean;
  quality?: number;
  maxEdgePx?: number;
};

type AXPoint = { x: number; y: number };

type AXClickOptions = {
  clickCount?: number;
  duration?: number;
  key?: string;
  mouseButton?: AXMouseButton;
};

type AXStateOptions = {
  disableDiffing?: boolean;
};

type AXPasteOptions = {
  format?: "text" | "md" | "html";
};

type AXPressKeyOptions = {
  duration?: number;
};

type AXDirection = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";

type AXSelectTextOptions = {
  prefix?: string;
  selectionType?: AXSelectionType;
  suffix?: string;
};

type ClickOptions = {
  button?: 1 | 2 | 3 | 4 | 5;
  keypress?: Array<string>;
  x: number;
  y: number;
};

type DoubleClickOptions = {
  keypress?: Array<string>;
  x: number;
  y: number;
};

type CuaDownloadMediaOptions = {
  timeoutMs?: number;
  x: number;
  y: number;
};

type DragOptions = {
  keys?: Array<string>;
  path: Array<{ x: number; y: number }>;
};

type KeypressOptions = {
  duration?: number;
  keys: Array<string>;
};

type MoveOptions = {
  keys?: Array<string>;
  x: number;
  y: number;
};

type ScrollOptions = {
  keypress?: Array<string>;
  scrollX: number;
  scrollY: number;
  x: number;
  y: number;
};

type TypeOptions = {
  text: string;
};

type DomClickOptions = {
  node_id: NodeId;
};

type DomDownloadMediaOptions = {
  node_id: NodeId;
  timeoutMs?: number;
};

type DomKeypressOptions = {
  keys: Array<string>;
};

type DomScrollOptions = {
  node_id?: NodeId;
  x: number;
  y: number;
};

type DomTypeOptions = {
  text: string;
};

type ElementInfoOptions = {
  includeNonInteractable?: boolean;
  x: number;
  y: number;
};

type ElementInfo = {
  ariaName?: string | null;
  boundingBox?: ElementInfoRect | null;
  nodeId?: number | null;
  preview: string;
  role?: string | null;
  selector: ElementInfoSelector;
  tagName: string;
  testId?: string | null;
  visibleText?: string | null;
};

type ElementScreenshotOptions = {
  includeNonInteractable?: boolean;
  x: number;
  y: number;
};

type PlaywrightEvaluateFunction<TArg, TResult> = string;

type PlaywrightEvaluateOptions = {
  timeoutMs?: number;
};

type LoadState = "load" | "domcontentloaded" | "networkidle";

type TextMatcher = string | RegExp;

type WaitForEventOptions = {
  timeoutMs?: number;
};

type PageWaitForLoadStateOptions = {
  state?: LoadState;
  timeoutMs?: number;
};

type PageWaitForURLOptions = {
  timeoutMs?: number;
  waitUntil?: WaitUntil;
};

type LocatorCheckOptions = {
  timeoutMs?: number;
};

type LocatorClickOptions = {
  button?: MouseButton;
  clickCount?: number;
  position?: { x: number; y: number };
  modifiers?: Array<KeyboardModifier>;
  timeoutMs?: number;
};

type LocatorDownloadMediaOptions = {
  timeoutMs?: number;
};

type LocatorEvaluateFunction<TArg, TResult> = string;

type LocatorEvaluateAllFunction<TArg, TResult> = string;

type LocatorFilterOptions = {
  has?: PlaywrightLocator;
  hasNot?: PlaywrightLocator;
  hasNotText?: TextMatcher;
  hasText?: TextMatcher;
  visible?: boolean;
};

type LocatorLocatorOptions = {
  has?: PlaywrightLocator;
  hasNot?: PlaywrightLocator;
  hasNotText?: TextMatcher;
  hasText?: TextMatcher;
};

type LocatorPressSequentiallyOptions = {
  timeoutMs?: number;
};

type SelectOptionInput = string | SelectOptionDescriptor;

type LocatorWaitForOptions = {
  state: WaitForState;
  timeoutMs?: number;
};

type FileChooserFiles = string | Array<string | BrowserFileSource>;

type TabClipboardItem = {
  entries: Array<TabClipboardEntry>;
  presentationStyle?: "unspecified" | "inline" | "attachment";
};

interface TabDevLogsOptions {
  filter?: string;
  levels?: Array<"debug" | "info" | "log" | "warn" | "error" | "warning">;
  limit?: number;
}

interface TabDevLogEntry {
  level: "debug" | "info" | "log" | "warn" | "error";
  message: string;
  timestamp: string;
  url?: string;
}

type TabsContentType = "html" | "text" | "domSnapshot";

type ClipRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type AXMouseButton = "left" | "right" | "middle" | "l" | "r" | "m";

type AXSelectionType = "text" | "cursor_before" | "cursor_after";

type ElementInfoRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type ElementInfoSelector = {
  candidates: Array<string>;
  frameSelectors?: Array<string>;
  primary?: string | null;
};

type WaitUntil = LoadState | "commit";

type MouseButton = "left" | "right" | "middle";

type KeyboardModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

type SelectOptionDescriptor = {
  index?: number;
  label?: string;
  value?: string;
};

type WaitForState = "attached" | "detached" | "visible" | "hidden";

type TabClipboardEntry =
  | { mimeType: string; text: string; data?: never }
  | { mimeType: string; data: Uint8Array; text?: never };

type BrowserTarget = {
  browserId: string;
  tabId?: string;
  generation: number;
  bootId: string;
  browserSessionId: string;
  pageVersion?: number;
};

type BrowserFileSource =
  | { path: string; name?: string; mimeType?: string }
  | { data: Uint8Array | ArrayBuffer | Blob; name: string; mimeType?: string };

type BrowserError = Error & {
  code: string;
  dispatched: boolean;
  effect: "none" | "confirmed" | "unknown";
  retryable: boolean;
  operationId?: string;
  method?: string;
  ref?: ElementRef;
  target?: BrowserTarget;
};
type SdkError = BrowserError;
// 以下为 Nexum browser 便捷操作与额外能力的完整数据合同。
type BrowserId = string;
type TabId = string;
type Generation = number;
type ElementRef = string;
type NodeId = string;
interface BrowserTab {
  browserId: string;
  tabId: string;
  generation: number;
  bootId: string;
  browserSessionId: string;
  title?: string;
  url?: string;
  active: boolean;
  windowId?: string;
  groupId?: string;
  index?: number;
  pinned?: boolean;
  muted?: boolean;
}
interface SnapshotNode {
  ref: ElementRef;
  role: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  children?: SnapshotNode[];
}
interface PageSnapshot {
  browserId: string;
  tabId: string;
  generation: number;
  bootId: string;
  browserSessionId: string;
  pageVersion: number;
  url: string;
  title: string;
  root: SnapshotNode;
  dialog?: { type: Dialog["type"]; message: string };
  truncated: boolean;
  artifact?: BrowserArtifact;
}
interface ActionResult {
  ok: true;
  operationId: string;
  target: BrowserTarget & { tabId: string; pageVersion: number };
  changed: boolean;
}
interface CapabilityInfo {
  id: string;
  name: string;
  title: string;
  description: string;
  supported: boolean;
  reason?: string;
  revision: string;
}
type WaitCondition = (
  | { kind: "element"; selector: string; state?: WaitForState }
  | { kind: "selector"; value: string; state?: WaitForState }
  | { kind: "text" | "url"; value: string }
  | { kind: "navigation"; url?: string; waitUntil?: WaitUntil }
  | { kind: "state"; state: LoadState }
) & { timeoutMs?: number; pollingMs?: number };
interface WaitResult {
  matched: true;
  snapshot: PageSnapshot;
}
interface NavigationOptions {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
}
interface BrowserWindow {
  id: string;
  focused: boolean;
  state: "normal" | "minimized" | "maximized" | "fullscreen";
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  tabs?: BrowserTab[];
}
interface BrowserTabGroup {
  id: string;
  windowId: string;
  title: string;
  color: string;
  collapsed: boolean;
}
interface BrowserBookmark {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: BrowserBookmark[];
}
interface BrowserArtifact {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}
interface BrowserDownload {
  id: string;
  target: BrowserTarget;
  url?: string;
  suggestedFilename: string;
  state: "in_progress" | "complete" | "cancelled" | "interrupted" | "unknown";
  bytesReceived: number;
  totalBytes?: number;
  error?: string;
}
interface ManagementAuditEntry {
  id: string;
  createdAt: number;
  runId: string;
  operationId: string;
  namespace: "windows" | "tabs" | "tabGroups" | "bookmarks";
  method: string;
  before: {
    windows?: BrowserWindow[];
    tabs?: BrowserTab[];
    groups?: BrowserTabGroup[];
    bookmarks?: BrowserBookmark[];
  };
  changedIds: string[];
  outcome: "confirmed" | "failed" | "unknown";
}
interface ManagementCapability {
  windows: {
    list(): Promise<BrowserWindow[]>;
    getAll(options?: { populate?: boolean }): Promise<BrowserWindow[]>;
    create(options?: {
      tabId?: string;
      focused?: boolean;
      left?: number;
      top?: number;
      width?: number;
      height?: number;
    }): Promise<BrowserWindow>;
    update(
      id: string,
      options: {
        focused?: boolean;
        state?: BrowserWindow["state"];
        left?: number;
        top?: number;
        width?: number;
        height?: number;
      },
    ): Promise<BrowserWindow>;
  };
  tabs: {
    query(options?: {
      windowId?: string;
      url?: string | string[];
      active?: boolean;
      pinned?: boolean;
      groupId?: string;
    }): Promise<BrowserTab[]>;
    get(id: string): Promise<BrowserTab>;
    move(
      id: string,
      options: { index: number; windowId?: string },
    ): Promise<BrowserTab>;
    update(
      id: string,
      options: { pinned?: boolean; muted?: boolean },
    ): Promise<BrowserTab>;
    group(options: {
      tabIds: string[];
      groupId?: string;
      createProperties?: { windowId?: string };
    }): Promise<{ groupId: string }>;
    ungroup(ids: string[]): Promise<void>;
    close(id: string): Promise<void>;
  };
  tabGroups: {
    query(options?: {
      windowId?: string;
      title?: string;
      color?: string;
      collapsed?: boolean;
    }): Promise<BrowserTabGroup[]>;
    get(id: string): Promise<BrowserTabGroup>;
    update(
      id: string,
      options: { title?: string; color?: string; collapsed?: boolean },
    ): Promise<BrowserTabGroup>;
    move(
      id: string,
      options: { index: number; windowId?: string },
    ): Promise<BrowserTabGroup>;
  };
  bookmarks: {
    search(
      query: string | { query?: string; title?: string; url?: string },
    ): Promise<BrowserBookmark[]>;
    getTree(): Promise<BrowserBookmark[]>;
    create(options: {
      parentId?: string;
      index?: number;
      title?: string;
      url?: string;
    }): Promise<BrowserBookmark>;
    update(
      id: string,
      options: { title?: string; url?: string },
    ): Promise<BrowserBookmark>;
    move(
      id: string,
      options: { parentId?: string; index?: number },
    ): Promise<BrowserBookmark>;
    remove(id: string): Promise<void>;
  };
  getAuditTrail(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<{
    changes: ManagementAuditEntry[];
    nextCursor?: string;
    truncated: boolean;
  }>;
}
type PageAssetKind =
  "other" | "script" | "font" | "image" | "stylesheet" | "video";
interface PageAsset {
  id: string;
  kind: PageAssetKind;
  name: string;
  url: string;
  sources: {
    kind: "attribute" | "computedStyle" | "resource";
    nodeId?: number;
    property?: string;
  }[];
}
interface PageAssetInventory {
  id: string;
  target: BrowserTarget;
  assets: PageAsset[];
  inlineSvgs: { id: string; markup: string; name: string }[];
  pageUrl: string | null;
  summary: {
    byKind: Partial<Record<PageAssetKind, number>>;
    inlineSvgCount: number;
    totalCount: number;
  };
}
interface PageAssetBundle {
  directoryPath: string;
  manifestPath: string;
  assets: (BrowserArtifact & {
    id: string;
    kind: PageAssetKind;
    url: string;
  })[];
  failures: { id: string; url: string; name: string; reason: string }[];
  summary: {
    requestedCount: number;
    downloadedCount: number;
    failedCount: number;
    elapsedMs: number;
  };
}
interface PageAssetsCapability {
  list(): Promise<PageAssetInventory>;
  download(urls: string[]): Promise<{
    files: (BrowserArtifact & { url: string })[];
    failures: { url: string; reason: string }[];
  }>;
  bundle(options: {
    inventoryId: string;
    assetIds?: string[];
    kinds?: ("font" | "image" | "stylesheet" | "video")[];
  }): Promise<PageAssetBundle>;
}
type CdpTarget =
  | { sessionId: string; targetId?: never }
  | { sessionId?: never; targetId: string };
interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sequence: number;
  source: {
    browserId: string;
    bootId: string;
    browserSessionId: string;
    generation: number;
    tabId?: string;
    sessionId?: string;
    targetId?: string;
  };
}
interface CdpEventsOptions {
  afterSequence?: number;
  limit?: number;
  methods?: string[];
  target?: CdpTarget;
  timeoutMs?: number;
}
interface CdpCapability {
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: { target?: CdpTarget; timeoutMs?: number },
  ): Promise<unknown>;
  events(cursor?: string): Promise<{
    events: CdpEvent[];
    nextCursor?: string;
    hasMore: boolean;
    truncated: boolean;
  }>;
  cursor(): Promise<string>;
  readEvents(options?: CdpEventsOptions): Promise<{
    cursor: number;
    events: CdpEvent[];
    hasMore: boolean;
    truncated: boolean;
  }>;
}
interface WebMcpTool {
  documentRevision: string;
  registrationRevision: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
interface WebMcpTools {
  documentRevision: string;
  registrationRevision: string;
  tools: readonly WebMcpTool[];
  invokeTool(name: string, args: unknown): Promise<unknown>;
}
interface WebMcpCapability {
  listTools(): Promise<WebMcpTool[]>;
  invokeTool(name: string, args: unknown): Promise<unknown>;
  fetchTools(): Promise<WebMcpTools>;
}
interface VisibilityCapability {
  get(): Promise<boolean>;
  set(visible: boolean): Promise<void>;
}
interface ViewportCapability {
  set(options: {
    tabId?: string;
    width: number;
    height: number;
  }): Promise<ActionResult>;
  reset(tabId?: string): Promise<ActionResult>;
}

interface Browser {
  name: string;
  type: "extension";
  profileName?: string;
  windows: ManagementCapability["windows"];
  tabGroups: ManagementCapability["tabGroups"];
  bookmarks: ManagementCapability["bookmarks"];
  management: ManagementCapability;
  visibility: VisibilityCapability;
  viewport: ViewportCapability;
}
interface Tabs {
  query(options?: {
    windowId?: string;
    url?: string | string[];
    active?: boolean;
    pinned?: boolean;
    groupId?: string;
  }): Promise<BrowserTab[]>;
  move(
    id: string,
    options: { index: number; windowId?: string },
  ): Promise<BrowserTab>;
  update(
    id: string,
    options: { pinned?: boolean; muted?: boolean },
  ): Promise<BrowserTab>;
  group(options: {
    tabIds: string[];
    groupId?: string;
    createProperties?: { windowId?: string };
  }): Promise<{ groupId: string }>;
  ungroup(ids: string[]): Promise<void>;
  close(id: string): Promise<void>;
}
interface Tab {
  snapshot(options?: {
    maxBytes?: number;
    root?: ElementRef;
    frame?: string;
  }): Promise<PageSnapshot>;
  click(
    ref: ElementRef,
    options?: {
      timeoutMs?: number;
      button?: MouseButton;
      modifiers?: KeyboardModifier[];
      clickCount?: number;
      position?: { x: number; y: number };
    },
  ): Promise<ActionResult>;
  fill(
    ref: ElementRef,
    text: string,
    options?: { timeoutMs?: number },
  ): Promise<ActionResult>;
  press(
    key: string,
    options?: { timeoutMs?: number; modifiers?: KeyboardModifier[] },
  ): Promise<ActionResult>;
  selectOption(
    ref: ElementRef,
    values: SelectOptionInput | SelectOptionInput[],
  ): Promise<ActionResult>;
  scroll(options: {
    x?: number;
    y?: number;
    ref?: ElementRef;
    behavior?: "auto" | "smooth";
  }): Promise<ActionResult>;
  hover(
    ref: ElementRef,
    options?: { timeoutMs?: number },
  ): Promise<ActionResult>;
  focus(ref: ElementRef): Promise<ActionResult>;
  waitFor(condition: WaitCondition): Promise<WaitResult>;
  locator(selector: string): PlaywrightLocator;
  evaluate<TResult = unknown>(
    expression: string,
    args?: unknown,
  ): Promise<TResult>;
  keyboardDown(key: string): Promise<ActionResult>;
  keyboardUp(key: string): Promise<ActionResult>;
  frame(selector: string): Promise<Frame>;
  dialogAccept(text?: string): Promise<ActionResult>;
  dialogDismiss(): Promise<ActionResult>;
  contentExport(options: {
    format: "html" | "markdown" | "text";
  }): Promise<{ data: string; truncated: boolean; artifact?: BrowserArtifact }>;
  exportGsuite(
    type: "pdf" | "md" | "xlsx" | "csv" | "docx" | "pptx",
  ): Promise<BrowserArtifact>;
  exportYouTubeTranscript(): Promise<BrowserArtifact>;
  clipboardReadText(): Promise<string>;
  clipboardWriteText(text: string): Promise<ActionResult>;
  clipboardRead(): Promise<TabClipboardItem[]>;
  clipboardWrite(items: TabClipboardItem[]): Promise<ActionResult>;
  setFiles(ref: ElementRef, files: BrowserFileSource[]): Promise<ActionResult>;
  downloads(): Promise<BrowserDownload[]>;
  saveDownload(id: string, path?: string): Promise<BrowserArtifact>;
  setViewport(size: { width: number; height: number }): Promise<ActionResult>;
  resetViewport(): Promise<ActionResult>;
  devLogs(
    options?: TabDevLogsOptions & { since?: number },
  ): Promise<TabDevLogEntry[]>;
  assets: PageAssetsCapability;
  exportFile(options: {
    format: "pdf" | "html" | "markdown";
  }): Promise<BrowserArtifact>;
  webmcp: WebMcpCapability;
  cdp: CdpCapability;
}
interface Frame {
  snapshot(options?: { maxBytes?: number }): Promise<PageSnapshot>;
  click(
    ref: ElementRef,
    options?: { timeoutMs?: number },
  ): Promise<ActionResult>;
  fill(
    ref: ElementRef,
    text: string,
    options?: { timeoutMs?: number },
  ): Promise<ActionResult>;
  locator(selector: string): PlaywrightLocator;
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
  waitFor(condition: WaitCondition): Promise<WaitResult>;
}
interface PlaywrightAPI {
  waitForDownload(options?: WaitForEventOptions): Promise<PlaywrightDownload>;
  waitForFileChooser(
    options?: WaitForEventOptions,
  ): Promise<PlaywrightFileChooser>;
}
interface AXAPI {
  snapshot(options?: AXStateOptions): Promise<{
    target: BrowserTarget & { tabId: string; pageVersion: number };
    nodes: { index: number; role: string; name?: string }[];
    truncated: boolean;
  }>;
}
interface DomCUAAPI {
  fill(nodeId: NodeId, text: string): Promise<ActionResult>;
}
interface BrowserInfo {
  id: string;
  name: string;
  profileName?: string;
  family?: string;
  type: "extension";
  status: "online";
  generation: number;
  bootId: string;
  browserSessionId: string;
  metadata?: {
    browserVersion?: string;
    extensionVersion: string;
    versionSource: "clientHints" | "userAgent" | "unknown";
  };
}
type TextMatcherData =
  | { kind: "text"; value: string; exact?: boolean }
  | { kind: "regexp"; source: string; flags: string };
type LocatorData =
  | { kind: "selector"; selector: string }
  | { kind: "role"; role: string; name?: TextMatcherData; exact?: boolean }
  | { kind: "label" | "placeholder" | "text"; matcher: TextMatcherData }
  | { kind: "testId"; value: string }
  | { kind: "descendant"; root: LocatorData; query: LocatorData }
  | { kind: "and" | "or"; left: LocatorData; right: LocatorData }
  | { kind: "position"; query: LocatorData; at: "first" | "last" | number }
  | {
      kind: "filter";
      query: LocatorData;
      has?: LocatorData;
      hasNot?: LocatorData;
      hasText?: TextMatcherData;
      hasNotText?: TextMatcherData;
      visible?: boolean;
    }
  | { kind: "ref"; ref: ElementRef; pageVersion: number };
interface LocatorDescription {
  target: BrowserTarget & { tabId: string };
  framePath: readonly string[];
  query: LocatorData;
}
interface BrowserWaiterInfo {
  id: string;
  target: BrowserTarget & { tabId: string };
  expiresAt: number;
}
type BrowserWaiterEvent =
  | {
      type: "navigation";
      target: BrowserTarget;
      url: string;
      pageVersion: number;
    }
  | {
      type: "download";
      target: BrowserTarget;
      downloadId: string;
      suggestedFilename: string;
    }
  | {
      type: "filechooser";
      target: BrowserTarget;
      chooserId: string;
      pageVersion: number;
      multiple: boolean;
    };
// browser.waiters is a registered data-method table; it never returns a controller.
interface BrowserWaiterMethods {
  arm(input: {
    target: BrowserTarget & { tabId: string };
    event: "navigation" | "download" | "filechooser";
    timeoutMs?: number;
    url?: string;
    waitUntil?: WaitUntil;
  }): Promise<BrowserWaiterInfo>;
  get(input: { id: string }): Promise<BrowserWaiterEvent>;
  cancel(input: { id: string }): Promise<{ cancelled: boolean }>;
}
interface VisibleDomTree {
  target: BrowserTarget;
  nodes: {
    nodeId: NodeId;
    role: string;
    name?: string;
    rect?: { x: number; y: number; width: number; height: number };
    children?: NodeId[];
  }[];
  truncated: boolean;
  artifact?: BrowserArtifact;
}
```
