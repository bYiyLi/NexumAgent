import { browserRoutes } from "../client/routes.js";

/** Result contracts of the raw managed routes, not the convenience client.
 * Binary/host output, undefined, and externally defined values intentionally
 * have no JSON Schema: their result semantics are documented instead.
 */
type Schema = Record<string, unknown>;
const str = { type: "string" };
const num = { type: "number" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const nil = { type: "null" };
const list = (items: Schema): Schema => ({ type: "array", items });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: "object", properties, required, additionalProperties: false,
});
const nullable = (value: Schema): Schema => ({ anyOf: [value, nil] });
const binding = { browserId: str, bootId: str, browserSessionId: str, generation: int };
const target = obj({ ...binding, tabId: str, pageVersion: int, controlEpoch: str }, [...Object.keys(binding), "tabId", "pageVersion"]);
const browserInfo = obj({
  id: str, name: str, type: { const: "extension" }, status: { const: "online" },
  generation: int, bootId: str, browserSessionId: str, profileName: str, family: str,
  metadata: obj({ browserVersion: str, extensionVersion: str, versionSource: { enum: ["clientHints", "userAgent", "unknown"] } }, ["extensionVersion", "versionSource"]),
}, ["id", "name", "type", "status", "generation", "bootId", "browserSessionId"]);
const tabSummary = { id: str, providerTabId: str, title: str, url: str };
const tabInfo = obj({ ...tabSummary, target }, ["id", "target"]);
const artifact = obj({ path: str, name: str, mimeType: str, size: int, sha256: str });
const action = obj({ ok: { const: true }, operationId: str, target, changed: bool });
const nativeTab = obj({ ...binding, tabId: str, title: str, url: str, active: bool, windowId: str,
  index: int, pinned: bool, muted: bool, groupId: str }, [...Object.keys(binding), "tabId", "title", "url", "active", "windowId"]);
const nativeWindow = obj({ id: str, focused: bool, state: str, left: int, top: int, width: int, height: int, tabs: list(nativeTab) }, ["id"]);
const nativeGroup = obj({ id: str, windowId: str, title: str, color: str, collapsed: bool });
const contracts = new Map<string, { description: string; outputSchema?: Schema }>();
function add(paths: string, description: string, outputSchema?: Schema) {
  for (const path of paths.split(" ")) {
    if (contracts.has(path)) throw new Error("Duplicate browser result contract: " + path);
    contracts.set(path, { description, ...(outputSchema === undefined ? {} : { outputSchema }) });
  }
}
add("browsers.list", "列出当前已授权且在线的浏览器连接，返回真实浏览器身份列表。", list(browserInfo));
add("browsers.get browsers.getDefault browsers.getForUrl", "选择当前已授权且在线的浏览器，返回连接身份；目标不存在时失败。", browserInfo);
add("tabs.list user.openTabs", "读取连接中已观察到的标签摘要，不取得控制权；返回 ID、标题及 URL（后两项可能缺失）。", list(obj(tabSummary, ["id", "providerTabId"])));
add("tabs.get tabs.new user.claimTab", "取得、创建或认领指定标签，返回真实标签身份和后续调用所需 target。", tabInfo);
add("tabs.selected", "读取当前选中的标签身份及 target；无选中标签时返回 undefined。");
add("tab.title tab.url", "读取当前目标的标题或 URL，返回字符串；浏览器未提供该值时返回 undefined。");
add("tab.getJsDialog", "读取当前页面的原生对话框及 dialogId、pageVersion；没有对话框时返回 undefined。");
add("tab.requestUserTakeover", "将控制交还用户，等待实际用户输入确认后恢复控制；无 JSON 业务结果。");
add("tabs.select tab.goBack tab.forward tab.reload tab.navigate tab.click tab.fill tab.press tab.selectOption tab.scroll tab.hover tab.focus tab.keyboardDown tab.keyboardUp frame.click frame.fill dom.click dom.doubleClick dom.fill clipboard.write clipboard.writeText dialogs.accept dialogs.dismiss tab.dialogAccept tab.dialogDismiss viewport.set viewport.reset tab.setViewport tab.resetViewport", "在实际目标执行操作，返回操作回执、target 及 changed；回执不证明页面业务提交已成功。", action);
add("tab.close browsers.nameSession visibility.set management.tabs.ungroup management.tabs.close management.bookmarks.remove tab.markDeliverable locator.check locator.uncheck locator.setChecked locator.waitFor locator.type locator.press locator.pressSequentially locator.fill playwright.waitForTimeout playwright.waitForURL playwright.waitForLoadState cua.click cua.doubleClick cua.move cua.scroll cua.type cua.keypress cua.drag dom.type dom.keypress dom.scroll ax.click ax.drag ax.scroll ax.pressKey ax.typeText ax.selectText ax.paste", "执行指定操作或等待条件；成功返回 null。操作失败或超时应读取实际错误，不把 null 当成页面业务提交证明。", nil);
add("locator.count", "统计匹配元素数量。", { type: "integer", minimum: 0 });
add("locator.allTextContents locator.selectOption", "返回匹配文本或实际选中的 option 值列表。", list(str));
add("locator.textContent locator.getAttribute", "读取匹配元素的文本或指定属性；缺失时返回 null。", nullable(str));
add("locator.innerText clipboard.readText playwright.domSnapshot cdp.cursor", "读取当前目标的文本、快照或事件游标；返回字符串。", str);
add("locator.isEnabled locator.isVisible visibility.get", "读取当前状态，返回布尔值。", bool);
add("tab.frame", "解析目标 iframe，返回当前 target 和实际 framePath。", obj({ target, framePath: list(str) }));
add("tab.contentExport", "按指定格式导出页面内容，返回数据文本及截断标志。", obj({ data: str, truncated: bool }));
add("user.getTabContext", "读取已保留标签的文本上下文、标题、URL 和截断标志。", obj({ kind: { const: "text" }, text: str, title: str, url: str, truncated: bool }));
add("management.windows.list management.windows.getAll", "读取窗口列表及浏览器提供的属性；请求 populate 时包含标签。", list(nativeWindow));
add("management.windows.create management.windows.update", "创建或更新指定窗口，返回实际窗口属性。", nativeWindow);
add("management.tabs.query", "按条件查询真实标签，返回原生标签属性列表。", list(nativeTab));
add("management.tabs.get management.tabs.move management.tabs.update", "读取、移动或更新指定标签，返回实际标签属性。", nativeTab);
add("management.tabs.group", "将指定标签加入实际标签组，返回 groupId。", obj({ groupId: str }));
add("management.tabGroups.query", "查询标签组列表。", list(nativeGroup));
add("management.tabGroups.get management.tabGroups.update management.tabGroups.move", "读取或修改指定标签组，返回实际标签组属性。", nativeGroup);
add("browsers.history", "根据条件读取浏览历史；返回真实 URL、标题（可能缺失）和访问时间。", list(obj({ url: str, title: str, dateVisited: str }, ["dateVisited"])));
add("browsers.downloads", "读取浏览器原生下载记录及下载状态、大小和时间；可按实际数字 id 精确查询。", list(obj({ id: int, filename: str, state: str, startTime: str, endTime: str, fileSize: num, totalBytes: num, bytesReceived: num, mime: str, exists: bool }, ["id"])));
add("tab.saveDownload content.export content.exportGsuite content.exportYouTubeTranscript tab.exportFile cua.downloadMedia dom.downloadMedia locator.downloadMedia", "取得经过授权并实际保存到 Agent 工作区的文件，返回路径、名称、媒体类型、字节数及 SHA-256；需要交付时使用文件输出。", artifact);
add("downloads.path", "取得已完成下载的本地路径；尚无完成文件时返回 null。", nullable(str));
add("tab.markHandoff", "将真实标签释放给用户；运行时验证原生 released 回执后返回 undefined。");
add("waiters.arm", "在当前运行和标签上预先登记事件等待器，返回 ID、target 和到期时间；在触发事件前调用。", obj({ id: str, target, expiresAt: num }));
add("waiters.cancel", "取消属于当前运行的指定等待器。", obj({ cancelled: { const: true } }));
add("waiters.get", "等待已登记事件实际完成；返回 navigation、download 或 filechooser 的真实事件。", { oneOf: [
  obj({ type: { const: "navigation" }, target, url: str, pageVersion: int }),
  obj({ type: { const: "download" }, target, downloadId: str, suggestedFilename: str }),
  obj({ type: { const: "filechooser" }, target, chooserId: str, pageVersion: int, multiple: bool }),
] });
add("tab.screenshot playwright.elementScreenshot", "拍摄实际页面或元素的 JPEG 图像，返回 Uint8Array；直接 return 原生 JPEG 字节，由平台自动识别并交付图片，不包装为 JSON。");
add("tab.semanticSnapshot tab.writeObservation", "读取当前已授权页面的原生 DOM/AX 融合语义树及可选 JPEG；semanticSnapshot 返回结构化观察，writeObservation 直接交付紧凑树形文本及请求的原生截图。观察范围和不可用边界见 coverage/warnings；无需等待页面完全加载。");
add("ax.get ax.write", "按 mode 读取辅助功能状态文本、截图字节或两者；write 返回 Host 原生文本/图像结果。不要将媒体伪造成 JSON。");
add("tab.evaluate playwright.evaluate locator.evaluate locator.evaluateAll", "在当前受控页面执行表达式，结果取决于表达式的真实序列化值；无固定业务结构。");
add("cdp.send", "调用实际 CDP method；返回结构由该 CDP method 决定，不使用统一的伪造结果 Schema。");
add("webmcp.invokeTool", "执行已发现、同文档和注册修订的页面工具；结果由该工具的实际合同及内容类型决定。");
// The page snapshot has a flattened target and an explicitly described DOM tree.
const snapshotNode = obj({ ref: str, role: str, name: str, disabled: bool, checked: bool,
  children: list({ $ref: "#/definitions/SnapshotNode" }) }, ["ref", "role"]);
const snapshot = obj({ ...binding, tabId: str, pageVersion: int, controlEpoch: str,
  url: str, title: str, root: { $ref: "#/definitions/SnapshotNode" }, truncated: bool },
  [...Object.keys(binding), "tabId", "pageVersion", "url", "title", "root", "truncated"]);
const snapshotDefinitions = { definitions: { SnapshotNode: snapshotNode } };
const waitResult = obj({ matched: { const: true }, snapshot });
add("tab.snapshot frame.snapshot", "观察实际页面结构与可交互引用；返回当前文档 target、标题、URL、节点树及截断状态。", { ...snapshot, ...snapshotDefinitions });
add("dom.getVisibleTree", "读取真实可见 DOM 节点、位置和 target。", obj({ target, nodes: list(obj({ nodeId: str, role: str, name: str, rect: obj({ x: num, y: num, width: num, height: num }) })), truncated: bool }));
add("ax.snapshot", "读取原生无障碍树的当前 target、索引、角色、名称及截断状态。", obj({ target, nodes: list(obj({ index: int, role: str, name: str }, ["index", "role"])), truncated: bool }));
add("playwright.elementInfo", "读取指定坐标实际匹配的元素信息列表，包括位置、语义名称及引用。", list(obj({ preview: str, tagName: str, role: str, ariaName: str, visibleText: str, boundingBox: obj({ x: num, y: num, width: num, height: num }), testId: nullable(str), selector: obj({ candidates: list(str), primary: nullable(str) }), ref: str })));
// Reuse the actual Locator wire AST instead of maintaining another copy.
const locatorInput = browserRoutes.find((route) => route.path === "locator.count")!.inputSchema;
const locatorProperties = locatorInput.properties as Record<string, Schema>;
add("locator.all", "观察匹配元素，返回每个元素的实际定位器描述及 target；保持引用与页面版本，不重新猜测选择器。", {
  ...list(locatorProperties.locator!), definitions: locatorInput.definitions,
});
add("tab.waitFor frame.waitFor", "等待实际条件；返回已匹配标记与真实页面快照。", { ...waitResult, ...snapshotDefinitions });
add("locator.click locator.dblclick", "执行定位器点击；无 expect 返回 null，有 expect 时返回实际匹配标记和页面快照。超时或验证失败先观察页面。", { ...nullable(waitResult), ...snapshotDefinitions });
add("tabs.content", "对指定 URL 集合读取内容；未获得内容的页面返回 null，保持原 URL 与截断标志。", list(obj({ url: str, title: nullable(str), content: nullable(str), truncated: bool })));
add("clipboard.read", "读取真实剪贴板项目及其 MIME 内容；可能含二进制，不假定固定 JSON。");
add("ax.performSecondaryAction ax.setValue", "针对实际辅助功能元素执行指定动作；成功返回 null。核对真实页面状态。", nil);
add("tab.setFiles fileChoosers.setFiles", "向实际文件输入或选择器提交已授权文件；返回操作回执，不将文件路径当业务上传成功证明。", action);
const capability = obj({ id: str, name: str, title: str, description: str, supported: bool, reason: str, revision: str }, ["id", "name", "title", "description", "supported", "revision"]);
add("capabilities.browserList capabilities.tabList", "列出当前浏览器或标签的实际能力及支持状态。", list(capability));
add("capabilities.browserGet capabilities.tabGet", "查询指定能力的真实支持状态和修订。", capability);
const bookmark = obj({ id: str, parentId: str, index: int, title: str, url: str, children: list({ $ref: "#/definitions/Bookmark" }) }, ["id", "title"]);
const bookmarkDefinitions = { definitions: { Bookmark: bookmark } };
add("management.bookmarks.search management.bookmarks.getTree", "搜索或读取实际书签树列表，保留真实书签 ID 与层级。", { ...list({ $ref: "#/definitions/Bookmark" }), ...bookmarkDefinitions });
add("management.bookmarks.create management.bookmarks.update management.bookmarks.move", "创建、更新或移动实际书签，返回真实节点。", { $ref: "#/definitions/Bookmark", ...bookmarkDefinitions });
const audit = obj({ id: str, createdAt: num, runId: str, operationId: str,
  namespace: { enum: ["windows", "tabs", "tabGroups", "bookmarks"] }, method: str,
  before: obj({ windows: list(nativeWindow), tabs: list(nativeTab), groups: list(nativeGroup), bookmarks: list({ $ref: "#/definitions/Bookmark" }) }, []),
  changedIds: list(str), outcome: { enum: ["confirmed", "failed", "unknown"] },
});
add("management.getAuditTrail", "分页读取当前浏览器管理操作的真实审计记录及后续游标。", { ...obj({ changes: list(audit), truncated: bool, nextCursor: str }, ["changes", "truncated"]), ...bookmarkDefinitions });
const assetKind = { enum: ["other", "script", "font", "image", "stylesheet", "video"] };
const artifactProperties = { path: str, name: str, mimeType: str, size: int, sha256: str };
const asset = obj({ id: str, kind: assetKind, name: str, url: str, sources: list(obj({ kind: { enum: ["attribute", "computedStyle", "resource"] }, nodeId: int, property: str }, ["kind"])) });
add("pageAssets.list", "读取实际页面资产清单及真实 inventoryId、target；依据清单选择后续下载，不猜测 URL。", obj({
  id: str, target, assets: list(asset), inlineSvgs: list(obj({ id: str, markup: str, name: str })), pageUrl: nullable(str),
  summary: obj({ byKind: obj(Object.fromEntries(assetKind.enum.map(kind => [kind, int])), []), inlineSvgCount: int, totalCount: int }),
}));
add("pageAssets.download", "下载实际授权资产，返回每项保存的文件或失败原因。", obj({ files: list(obj({ ...artifactProperties, url: str })), failures: list(obj({ url: str, reason: str })) }));
add("pageAssets.bundle", "打包实际资产并返回已保存的目录、清单、资产、失败与统计。", obj({ directoryPath: str, manifestPath: str, assets: list(obj({ ...artifactProperties, id: str, kind: assetKind, url: str })), failures: list(obj({ id: str, url: str, name: str, reason: str })), summary: obj({ requestedCount: int, downloadedCount: int, failedCount: int, elapsedMs: num }) }));
const webTool = obj({ documentRevision: str, registrationRevision: str, name: str, description: str, inputSchema: { type: "object" }, annotations: { type: "object" } }, ["documentRevision", "registrationRevision", "name", "inputSchema"]);
add("webmcp.listTools", "列出当前页面真实 WebMCP 工具及其输入 Schema 和修订。", list(webTool));
add("webmcp.fetchTools", "读取当前页面真实 WebMCP 工具集合及文档/注册修订。", obj({ documentRevision: str, registrationRevision: str, tools: list(webTool) }));
const eventSource = obj({ ...binding, tabId: str, sessionId: str, targetId: str, controlEpoch: str, pageVersion: int }, Object.keys(binding));
const cdpEvent = obj({ method: str, params: { type: "object" }, sequence: int, source: eventSource }, ["method", "sequence", "source"]);
add("cdp.events cdp.readEvents", "读取实际 CDP 事件及游标，事件参数随 CDP 方法变化；核对截断及后续分页。", obj({ cursor: int, events: list(cdpEvent), nextCursor: str, hasMore: bool, truncated: bool }, ["cursor", "events", "nextCursor", "hasMore", "truncated"]));
add("tab.downloads", "读取当前运行相关的真实页面下载记录；nativeRecordId 仅在可靠关联原生记录时提供。", list(obj({ id: str, nativeRecordId: int, target, suggestedFilename: str, url: str, state: str, bytesReceived: num, totalBytes: num }, ["id", "target", "suggestedFilename", "state", "bytesReceived"])));
add("dev.logs tab.devLogs", "读取实际开发者日志记录，按级别、时间和条数筛选。", list(obj({ level: str, message: str, timestamp: str, url: str }, ["level", "message", "timestamp"])));

export function browserResultContract(path: string): { description: string; outputSchema?: Schema } {
  const contract = contracts.get(path);
  if (!contract) throw new Error("Browser route missing result semantics: " + path);
  return {
    description: path + "： " + contract.description,
    ...(contract.outputSchema === undefined ? {} : { outputSchema: { $schema: "http://json-schema.org/draft-07/schema#", ...contract.outputSchema } }),
  };
}
