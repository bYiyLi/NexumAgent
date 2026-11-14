# 公开接口与数据类型

此页由本包公开 TypeScript 声明生成，用于查询调用合同；调用是否已注册及实际验证范围见包内 `implementation.json`。未注册的方法明确失败，类型存在不代表当前插件已经支持。

入口为 `import { createBrowserClient } from "nexum-browser"`。`createBrowserClient(browser)` 接收当前运行注入的方法容器，返回 `BrowserClient`。所有 I/O 都经过当前受管调用，客户端对象不传入 MCP 结果。

```typescript
/** Public browser SDK data and facade contracts. Runtime control objects never cross managed calls. */
import type { OutputIntent } from "@nexum/extension-api";
export type { OutputIntent } from "@nexum/extension-api";

export type BrowserCapabilityCollection = {
  get(id: "management"): Promise<ManagementCapability>;
  get(id: "visibility"): Promise<VisibilityCapability>;
  get(id: "viewport"): Promise<ViewportCapability>;
  get(id: string): Promise<CapabilityInfo>;
  list(): Promise<CapabilityInfo[]>;
};

export interface BrowserHistoryOptions {
  from?: string | Date;
  limit?: number;
  queries?: Array<string>;
  to?: string | Date;
}

export interface BrowserHistoryEntry {
  dateVisited: string;
  title?: string;
  url: string;
}

export interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  providerTabId?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

export type BrowserUserTabContext =
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

export interface TabsContentOptions {
  contentType: TabsContentType;
  timeoutMs?: number;
  urls: Array<string>;
}

export interface TabsContentResult {
  truncated: boolean;
  content: null | string;
  title: null | string;
  url: string;
}

export interface TabInfo {
  id: string;
  providerTabId?: string;
  title?: string;
  url?: string;
}

export type TabCapabilityCollection = {
  get(id: "pageAssets"): Promise<PageAssetsCapability>;
  get(id: "cdp"): Promise<CdpCapability>;
  get(id: "webmcp"): Promise<WebMcpCapability>;
  get(id: string): Promise<CapabilityInfo>;
  list(): Promise<CapabilityInfo[]>;
};

export type Dialog =
  AlertDialog | BeforeUnloadDialog | ConfirmDialog | PromptDialog;

export type ScreenshotOptions = {
  clip?: ClipRect;
  fullPage?: boolean;
  quality?: number;
  maxEdgePx?: number;
};

export type AXPoint = { x: number; y: number };

export type AXClickOptions = {
  clickCount?: number;
  duration?: number;
  key?: string;
  mouseButton?: AXMouseButton;
};

export type AXStateOptions = {
  disableDiffing?: boolean;
};

export type AXPasteOptions = {
  format?: "text" | "md" | "html";
};

export type AXPressKeyOptions = {
  duration?: number;
};

export type AXDirection =
  "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";

export type AXSelectTextOptions = {
  prefix?: string;
  selectionType?: AXSelectionType;
  suffix?: string;
};

export type ClickOptions = {
  button?: 1 | 2 | 3 | 4 | 5;
  keypress?: Array<string>;
  x: number;
  y: number;
};

export type DoubleClickOptions = {
  keypress?: Array<string>;
  x: number;
  y: number;
};

export type CuaDownloadMediaOptions = {
  timeoutMs?: number;
  x: number;
  y: number;
};

export type DragOptions = {
  keys?: Array<string>;
  path: Array<{ x: number; y: number }>;
};

export type KeypressOptions = {
  duration?: number;
  keys: Array<string>;
};

export type MoveOptions = {
  keys?: Array<string>;
  x: number;
  y: number;
};

export type ScrollOptions = {
  keypress?: Array<string>;
  scrollX: number;
  scrollY: number;
  x: number;
  y: number;
};

export type TypeOptions = {
  text: string;
};

export type DomClickOptions = {
  node_id: NodeId;
};

export type DomDownloadMediaOptions = {
  node_id: NodeId;
  timeoutMs?: number;
};

export type DomKeypressOptions = {
  keys: Array<string>;
};

export type DomScrollOptions = {
  node_id?: NodeId;
  x: number;
  y: number;
};

export type DomTypeOptions = {
  text: string;
};

export type ElementInfoOptions = {
  includeNonInteractable?: boolean;
  x: number;
  y: number;
};

export type ElementInfo = {
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

export type ElementScreenshotOptions = {
  includeNonInteractable?: boolean;
  x: number;
  y: number;
};

export type PlaywrightEvaluateFunction<TArg, TResult> = string;

export type PlaywrightEvaluateOptions = {
  timeoutMs?: number;
};

export type LoadState = "load" | "domcontentloaded" | "networkidle";

export type TextMatcher = string | RegExp;

export type WaitForEventOptions = {
  timeoutMs?: number;
};

export type PageWaitForLoadStateOptions = {
  state?: LoadState;
  timeoutMs?: number;
};

export type PageWaitForURLOptions = {
  timeoutMs?: number;
  waitUntil?: WaitUntil;
};

export type LocatorCheckOptions = {
  timeoutMs?: number;
};

export type LocatorClickOptions = {
  button?: MouseButton;
  clickCount?: number;
  position?: { x: number; y: number };
  modifiers?: Array<KeyboardModifier>;
  timeoutMs?: number;
};

export type LocatorDownloadMediaOptions = {
  timeoutMs?: number;
};

export type LocatorEvaluateFunction<TArg, TResult> = string;

export type LocatorEvaluateAllFunction<TArg, TResult> = string;

export type LocatorFilterOptions = {
  has?: PlaywrightLocator;
  hasNot?: PlaywrightLocator;
  hasNotText?: TextMatcher;
  hasText?: TextMatcher;
  visible?: boolean;
};

export type LocatorLocatorOptions = {
  has?: PlaywrightLocator;
  hasNot?: PlaywrightLocator;
  hasNotText?: TextMatcher;
  hasText?: TextMatcher;
};

export type LocatorPressSequentiallyOptions = {
  timeoutMs?: number;
};

export type SelectOptionInput = string | SelectOptionDescriptor;

export type LocatorWaitForOptions = {
  state: WaitForState;
  timeoutMs?: number;
};

export type FileChooserFiles = string | Array<string | BrowserFileSource>;

export type TabClipboardItem = {
  entries: Array<TabClipboardEntry>;
  presentationStyle?: "unspecified" | "inline" | "attachment";
};

export interface TabDevLogsOptions {
  filter?: string;
  levels?: Array<"debug" | "info" | "log" | "warn" | "error" | "warning">;
  limit?: number;
}

export interface TabDevLogEntry {
  level: "debug" | "info" | "log" | "warn" | "error";
  message: string;
  timestamp: string;
  url?: string;
}

export type TabsContentType = "html" | "text" | "domSnapshot";

export type ClipRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type AXMouseButton = "left" | "right" | "middle" | "l" | "r" | "m";

export type AXSelectionType = "text" | "cursor_before" | "cursor_after";

export type ElementInfoRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type ElementInfoSelector = {
  candidates: Array<string>;
  frameSelectors?: Array<string>;
  primary?: string | null;
};

export type WaitUntil = LoadState | "commit";

export type MouseButton = "left" | "right" | "middle";

export type KeyboardModifier =
  "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

export type SelectOptionDescriptor = {
  index?: number;
  label?: string;
  value?: string;
};

export type WaitForState = "attached" | "detached" | "visible" | "hidden";

export type TabClipboardEntry =
  | { mimeType: string; text: string; data?: never }
  | { mimeType: string; data: Uint8Array; text?: never };

export type BrowserTarget = {
  browserId: string;
  tabId?: string;
  generation: number;
  bootId: string;
  browserSessionId: string;
  pageVersion?: number;
};

export type BrowserFileSource =
  | { path: string; name?: string; mimeType?: string }
  | { data: Uint8Array | ArrayBuffer | Blob; name: string; mimeType?: string };

export type BrowserError = Error & {
  code: string;
  dispatched: boolean;
  effect: "none" | "confirmed" | "unknown";
  retryable: boolean;
  operationId?: string;
  method?: string;
  ref?: ElementRef;
  target?: BrowserTarget;
};
export type SdkError = BrowserError;
// 以下为 Nexum browser 便捷操作与额外能力的完整数据合同。
export type BrowserId = string;
export type TabId = string;
export type Generation = number;
export type ElementRef = string;
export type NodeId = string;
export interface BrowserTab {
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
}
export interface SnapshotNode {
  ref: ElementRef;
  role: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  children?: SnapshotNode[];
}
export interface PageSnapshot {
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
export interface ActionResult {
  ok: true;
  operationId: string;
  target: BrowserTarget & { tabId: string; pageVersion: number };
  changed: boolean;
}
export interface CapabilityInfo {
  id: string;
  name: string;
  title: string;
  description: string;
  supported: boolean;
  reason?: string;
  revision: string;
}
export type WaitCondition = (
  | { kind: "element"; selector: string; state?: WaitForState }
  | { kind: "selector"; value: string; state?: WaitForState }
  | { kind: "text" | "url"; value: string }
  | { kind: "navigation"; url?: string; waitUntil?: WaitUntil }
  | { kind: "state"; state: LoadState }
) & { timeoutMs?: number; pollingMs?: number };
export interface WaitResult {
  matched: true;
  snapshot: PageSnapshot;
}
export interface NavigationOptions {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
}
export interface BrowserWindow {
  id: string;
  focused: boolean;
  state: "normal" | "minimized" | "maximized" | "fullscreen";
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  tabs?: BrowserTab[];
}
export interface BrowserTabGroup {
  id: string;
  windowId: string;
  title: string;
  color: string;
  collapsed: boolean;
}
export interface BrowserBookmark {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: BrowserBookmark[];
}
export interface BrowserArtifact {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}
export interface BrowserDownload {
  id: string;
  target: BrowserTarget;
  url?: string;
  suggestedFilename: string;
  state: "in_progress" | "complete" | "cancelled" | "interrupted" | "unknown";
  bytesReceived: number;
  totalBytes?: number;
  error?: string;
}
export interface ManagementAuditEntry {
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
export interface ManagementCapability {
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
  }): Promise<{ changes: ManagementAuditEntry[]; nextCursor?: string }>;
}
export type PageAssetKind =
  "other" | "script" | "font" | "image" | "stylesheet" | "video";
export interface PageAsset {
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
export interface PageAssetInventory {
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
export interface PageAssetBundle {
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
export interface PageAssetsCapability {
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
export type CdpTarget =
  | { sessionId: string; targetId?: never }
  | { sessionId?: never; targetId: string };
export interface CdpEvent {
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
export interface CdpEventsOptions {
  afterSequence?: number;
  limit?: number;
  methods?: string[];
  target?: CdpTarget;
  timeoutMs?: number;
}
export interface CdpCapability {
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
export interface WebMcpTool {
  documentRevision: string;
  registrationRevision: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export interface WebMcpTools {
  documentRevision: string;
  registrationRevision: string;
  tools: readonly WebMcpTool[];
  invokeTool(name: string, args: unknown): Promise<unknown>;
}
export interface WebMcpCapability {
  listTools(): Promise<WebMcpTool[]>;
  invokeTool(name: string, args: unknown): Promise<unknown>;
  fetchTools(): Promise<WebMcpTools>;
}
export interface VisibilityCapability {
  get(): Promise<boolean>;
  set(visible: boolean): Promise<void>;
}
export interface ViewportCapability {
  set(options: {
    tabId?: string;
    width: number;
    height: number;
  }): Promise<ActionResult>;
  reset(tabId?: string): Promise<ActionResult>;
}

export interface Browser {
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
export interface Tabs {
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
export interface Tab {
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
export interface Frame {
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
export interface PlaywrightAPI {
  waitForDownload(options?: WaitForEventOptions): Promise<PlaywrightDownload>;
  waitForFileChooser(
    options?: WaitForEventOptions,
  ): Promise<PlaywrightFileChooser>;
}
export interface AXAPI {
  snapshot(options?: AXStateOptions): Promise<{
    target: BrowserTarget & { tabId: string; pageVersion: number };
    nodes: { index: number; role: string; name?: string }[];
    truncated: boolean;
  }>;
}
export interface DomCUAAPI {
  fill(nodeId: NodeId, text: string): Promise<ActionResult>;
}
export interface BrowserInfo {
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
export type TextMatcherData =
  | { kind: "text"; value: string; exact?: boolean }
  | { kind: "regexp"; source: string; flags: string };
export type LocatorData =
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
export interface LocatorDescription {
  target: BrowserTarget & { tabId: string };
  framePath: readonly string[];
  query: LocatorData;
}
export interface BrowserWaiterInfo {
  id: string;
  target: BrowserTarget & { tabId: string };
  expiresAt: number;
}
export type BrowserWaiterEvent =
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
export interface BrowserWaiterMethods {
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
export interface VisibleDomTree {
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

export interface BrowserClient {
  browsers: Browsers;
  documentation: Documentation;
}

export interface Browsers {
  get(id: string): Promise<Browser>;
  getDefault(): Promise<Browser>;
  getForUrl(url: string): Promise<Browser>;
  list(): Promise<BrowserInfo[]>;
}

export interface Browser {
  browserId: string;
  capabilities: BrowserCapabilityCollection;
  tabs: Tabs;
  user: BrowserUser;
  documentation(): Promise<string>;
  history(options?: BrowserHistoryOptions): Promise<Array<BrowserHistoryEntry>>;
  nameSession(name: string): Promise<void>;
}

export interface BrowserUser {
  claimTab(tab: string | BrowserUserTabInfo): Promise<Tab>;
  getTabContext(
    tab?: string | BrowserUserTabInfo,
  ): Promise<BrowserUserTabContext>;
  openTabs(): Promise<Array<BrowserUserTabInfo>>;
}

export interface Tabs {
  content(options: TabsContentOptions): Promise<Array<TabsContentResult>>;
  get(id: string): Promise<Tab>;
  list(): Promise<Array<TabInfo>>;
  new: (url?: string, options?: { active?: boolean }) => Promise<Tab>;
  select(id: string): Promise<ActionResult>;
  selected(): Promise<undefined | Tab>;
}

export interface Tab {
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

export interface AXAPI {
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

export interface ContentAPI {
  export(): Promise<BrowserArtifact>;
  exportGsuite(
    type: "pdf" | "md" | "xlsx" | "csv" | "docx" | "pptx",
  ): Promise<BrowserArtifact>;
  exportYouTubeTranscript(): Promise<BrowserArtifact>;
}

export interface CUAAPI {
  click(options: ClickOptions): Promise<void>;
  doubleClick(options: DoubleClickOptions): Promise<void>;
  downloadMedia(options: CuaDownloadMediaOptions): Promise<BrowserArtifact>;
  drag(options: DragOptions): Promise<void>;
  keypress(options: KeypressOptions): Promise<void>;
  move(options: MoveOptions): Promise<void>;
  scroll(options: ScrollOptions): Promise<void>;
  type(options: TypeOptions): Promise<void>;
}

export interface DomCUAAPI {
  click(options: DomClickOptions): Promise<void>;
  doubleClick(options: DomClickOptions): Promise<void>;
  downloadMedia(options: DomDownloadMediaOptions): Promise<BrowserArtifact>;
  getVisibleTree(): Promise<VisibleDomTree>;
  keypress(options: DomKeypressOptions): Promise<void>;
  scroll(options: DomScrollOptions): Promise<void>;
  type(options: DomTypeOptions): Promise<void>;
}

export interface PlaywrightAPI {
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

export interface PlaywrightFrameLocator {
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

export interface PlaywrightLocator {
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

export interface PlaywrightDownload {
  path(options?: { timeoutMs?: number }): Promise<null | string>;
}

export interface PlaywrightFileChooser {
  isMultiple(): boolean;
  setFiles(
    files: FileChooserFiles,
    options?: { timeoutMs?: number },
  ): Promise<void>;
}

export interface TabClipboardAPI {
  read(): Promise<Array<TabClipboardItem>>;
  readText(): Promise<string>;
  write(items: Array<TabClipboardItem>): Promise<void>;
  writeText(text: string): Promise<void>;
}

export interface TabDevAPI {
  logs(options?: TabDevLogsOptions): Promise<Array<TabDevLogEntry>>;
}

export interface AlertDialog {
  type: "alert";
  message: string;
  dismiss(): Promise<void>;
}

export interface BeforeUnloadDialog {
  type: "beforeunload";
  message: string;
  dismiss(): Promise<void>;
}

export interface ConfirmDialog {
  type: "confirm";
  message: string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
}

export interface Documentation {
  get(name: string): Promise<string>;
}

export interface PromptDialog {
  type: "prompt";
  message: string;
  accept(text: string): Promise<void>;
  dismiss(): Promise<void>;
}

/** Managed discovery result. This fixes a connection; it is not a live controller. */
export interface TabDescriptor extends TabInfo {
  target: BrowserTarget & { tabId: string };
}
export interface DialogDescriptor {
  target: BrowserTarget & { tabId: string };
  dialogId: string;
  pageVersion: number;
  type: "alert" | "beforeunload" | "confirm" | "prompt";
  message: string;
}
export interface DownloadDescriptor {
  target: BrowserTarget & { tabId: string };
  downloadId: string;
  suggestedFilename: string;
}
export interface FileChooserDescriptor {
  target: BrowserTarget & { tabId: string };
  chooserId: string;
  pageVersion: number;
  multiple: boolean;
}
export interface FrameDescriptor {
  target: BrowserTarget & { tabId: string };
  framePath: readonly string[];
}
export interface WebMcpToolsDescriptor {
  documentRevision: string;
  registrationRevision: string;
  tools: readonly WebMcpTool[];
}
```
