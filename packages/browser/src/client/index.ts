import type * as t from "./types.js";
import { browserRoutes } from "./routes.js";
import {
  clientError,
  dataObject,
  defined,
  freeze,
  normalizeBrowserValue,
  options,
  plain,
  queryTarget,
  requireArgument,
  targetKey,
  textMatcher,
  validateLocatorDescription,
  validateTarget,
} from "./serialize.js";
export type * from "./types.js";
export { browserRoutes } from "./routes.js";
export {
  normalizeBrowserValue,
  validateLocatorDescription,
} from "./serialize.js";

const routeMap = new Map(browserRoutes.map((route) => [route.path, route]));
type TabTarget = t.BrowserTarget & { tabId: string };
class Router {
  readonly #methods = new Map<string, Function>();
  readonly #barriers = new Map<string, Promise<void>>();
  constructor(methods: Readonly<Record<string, unknown>>) {
    requireArgument(
      plain(methods),
      "Use the current managed browser method container.",
    );
    for (const route of browserRoutes) {
      let node: unknown = methods;
      for (const key of route.path.split(".")) {
        if (node === undefined) break;
        requireArgument(
          plain(node),
          "A managed route container must be an ordinary data object.",
        );
        const d = Object.getOwnPropertyDescriptor(node, key);
        if (!d) {
          node = undefined;
          break;
        }
        requireArgument("value" in d, "Managed routes cannot be accessors.");
        node = d.value;
      }
      if (node !== undefined) {
        requireArgument(
          typeof node === "function",
          "A managed browser route must be a function.",
        );
        this.#methods.set(route.path, node);
      }
    }
  }
  option(
    _path: string,
    value: unknown,
    _field = "options",
  ): Record<string, unknown> | undefined {
    // Validation occurs inside the native Promise returned by call(), preserving
    // the async I/O API even when local argument normalization fails.
    return value as Record<string, unknown> | undefined;
  }
  barrier(target: TabTarget, ready: Promise<void>): void {
    const key = targetKey(target),
      previous = this.#barriers.get(key);
    const combined = previous
      ? Promise.all([previous, ready]).then(() => {})
      : ready;
    this.#barriers.set(key, combined);
    void combined.catch(() => {});
  }
  async call<T>(
    path: string,
    input: Record<string, unknown>,
    barrier = true,
  ): Promise<T> {
    const fn = this.#methods.get(path);
    if (!fn)
      throw clientError(
        "CAPABILITY_NOT_ALLOWED",
        "This managed browser route is not available in the supplied current method table.",
      );
    const fields = defined(input);
    const schema = routeMap.get(path)!.inputSchema as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    for (const [name, field] of Object.entries(schema.properties)) {
      if (fields[name] !== undefined && field.properties)
        fields[name] = dataObject(fields[name], Object.keys(field.properties));
    }
    const value = normalizeBrowserValue(fields) as Record<string, unknown>;
    if (path === "cdp.readEvents") {
      const o = value.options as { methods?: unknown[] } | undefined;
      if (o?.methods !== undefined)
        requireArgument(
          Array.isArray(o.methods) && o.methods.length > 0,
          "CDP method filters must be nonempty.",
        );
    }
    if (path === "tab.screenshot") {
      const o = value.options as
        { clip?: unknown; fullPage?: unknown } | undefined;
      requireArgument(
        !(o?.clip !== undefined && o.fullPage === true),
        "A screenshot cannot combine fullPage with an explicit clip.",
      );
    }
    const target = (value.target ??
      (value.locator as { target?: unknown } | undefined)?.target) as
      t.BrowserTarget | undefined;
    if (barrier && target?.tabId) await this.#barriers.get(targetKey(target));
    return (await Reflect.apply(fn, undefined, [value])) as T;
  }
}
const locatorDescriptions = new WeakMap<object, t.LocatorDescription>();
function locatorScope(description: t.LocatorDescription): string {
  return targetKey(description.target) + JSON.stringify(description.framePath);
}
function descriptionOf(value: unknown): t.LocatorDescription {
  const description =
    value && typeof value === "object"
      ? locatorDescriptions.get(value)
      : undefined;
  requireArgument(
    description,
    "A locator combination needs a locator created by this public client.",
  );
  return description;
}
function locatorObject(
  router: Router,
  input: t.LocatorDescription,
): t.PlaywrightLocator {
  const description = validateLocatorDescription(input);
  const nested = (query: t.LocatorData) =>
    locatorObject(router, { ...description, query });
  const descendant = (query: t.LocatorData) =>
    nested({ kind: "descendant", root: description.query, query });
  const otherQuery = (other: unknown) => {
    const right = descriptionOf(other);
    requireArgument(
      locatorScope(right) === locatorScope(description),
      "Locator combinations cannot cross browser, connection, tab or frame scopes.",
    );
    return right.query;
  };
  const filter = (value: unknown) => {
    const data = dataObject(value, [
      "has",
      "hasNot",
      "hasText",
      "hasNotText",
      "visible",
    ]);
    return defined({
      has: data.has === undefined ? undefined : otherQuery(data.has),
      hasNot: data.hasNot === undefined ? undefined : otherQuery(data.hasNot),
      hasText:
        data.hasText === undefined ? undefined : textMatcher(data.hasText),
      hasNotText:
        data.hasNotText === undefined
          ? undefined
          : textMatcher(data.hasNotText),
      visible: data.visible,
    });
  };
  const invoke = <T>(name: string, fields: Record<string, unknown> = {}) =>
    router.call<T>(`locator.${name}`, { locator: description, ...fields });
  const opts = (name: string, value: unknown) =>
    router.option(`locator.${name}`, value);
  const result = {
    ...queryMethods(descendant),
    locator: (selector: string, value?: t.LocatorLocatorOptions) => {
      const child = {
        kind: "descendant",
        root: description.query,
        query: { kind: "selector", selector },
      } as t.LocatorData;
      return value === undefined
        ? nested(child)
        : nested({
            kind: "filter",
            query: child,
            ...filter(value),
          } as t.LocatorData);
    },
    and: (other: t.PlaywrightLocator) =>
      nested({
        kind: "and",
        left: description.query,
        right: otherQuery(other),
      }),
    or: (other: t.PlaywrightLocator) =>
      nested({ kind: "or", left: description.query, right: otherQuery(other) }),
    filter: (value: t.LocatorFilterOptions) =>
      nested({
        kind: "filter",
        query: description.query,
        ...filter(value),
      } as t.LocatorData),
    first: () =>
      nested({ kind: "position", query: description.query, at: "first" }),
    last: () =>
      nested({ kind: "position", query: description.query, at: "last" }),
    nth: (at: number) =>
      nested({ kind: "position", query: description.query, at }),
    all: async () => {
      const rows = await invoke<t.LocatorDescription[]>("all");
      requireArgument(
        Array.isArray(rows),
        "The managed locator snapshot is invalid.",
      );
      return rows.map((row) => {
        const fixed = validateLocatorDescription(row);
        requireArgument(
          locatorScope(fixed) === locatorScope(description) &&
            fixed.query.kind === "ref",
          "Locator.all must return fixed observed members of the same scope.",
        );
        return locatorObject(router, fixed);
      });
    },
    count: () => invoke<number>("count"),
    allTextContents: (value?: { timeoutMs?: number }) =>
      invoke<string[]>("allTextContents", {
        options: opts("allTextContents", value),
      }),
    click: (value?: t.LocatorClickOptions) =>
      invoke<void>("click", { options: opts("click", value) }),
    dblclick: (value?: t.LocatorClickOptions) =>
      invoke<void>("dblclick", { options: opts("dblclick", value) }),
    check: (value?: t.LocatorCheckOptions) =>
      invoke<void>("check", { options: opts("check", value) }),
    uncheck: (value?: t.LocatorCheckOptions) =>
      invoke<void>("uncheck", { options: opts("uncheck", value) }),
    setChecked: (checked: boolean, value?: t.LocatorCheckOptions) =>
      invoke<void>("setChecked", {
        checked,
        options: opts("setChecked", value),
      }),
    fill: (value: string, o?: { timeoutMs?: number }) =>
      invoke<void>("fill", { value, options: opts("fill", o) }),
    press: (
      value: string,
      o?: { timeoutMs?: number; modifiers?: t.KeyboardModifier[] },
    ) => invoke<void>("press", { value, options: opts("press", o) }),
    pressSequentially: (value: string, o?: t.LocatorPressSequentiallyOptions) =>
      invoke<void>("pressSequentially", {
        value,
        options: opts("pressSequentially", o),
      }),
    type: (value: string, o?: { timeoutMs?: number; delayMs?: number }) =>
      invoke<void>("type", { value, options: opts("type", o) }),
    selectOption: (
      value: t.SelectOptionInput | t.SelectOptionInput[],
      o?: { timeoutMs?: number },
    ) =>
      invoke<void>("selectOption", { value, options: opts("selectOption", o) }),
    getAttribute: (name: string, o?: { timeoutMs?: number }) =>
      invoke<string | null>("getAttribute", {
        name,
        options: opts("getAttribute", o),
      }),
    innerText: (o?: { timeoutMs?: number }) =>
      invoke<string>("innerText", { options: opts("innerText", o) }),
    textContent: (o?: { timeoutMs?: number }) =>
      invoke<string | null>("textContent", { options: opts("textContent", o) }),
    isEnabled: () => invoke<boolean>("isEnabled"),
    isVisible: () => invoke<boolean>("isVisible"),
    waitFor: (value: t.LocatorWaitForOptions) =>
      invoke<void>("waitFor", { options: opts("waitFor", value) }),
    downloadMedia: (value?: t.LocatorDownloadMediaOptions) =>
      invoke<t.BrowserArtifact>("downloadMedia", {
        options: opts("downloadMedia", value),
      }),
    evaluate: <R, A>(
      expression: string,
      arg?: A,
      value?: t.PlaywrightEvaluateOptions,
    ) =>
      invoke<R>("evaluate", {
        expression,
        arg,
        options: opts("evaluate", value),
      }),
    evaluateAll: <R, A>(
      expression: string,
      arg?: A,
      value?: t.PlaywrightEvaluateOptions,
    ) =>
      invoke<R>("evaluateAll", {
        expression,
        arg,
        options: opts("evaluateAll", value),
      }),
  };
  freeze(result);
  locatorDescriptions.set(result, description);
  return result as t.PlaywrightLocator;
}
function queryMethods(create: (query: t.LocatorData) => t.PlaywrightLocator) {
  return {
    locator: (selector: string) => create({ kind: "selector", selector }),
    getByRole: (
      role: string,
      value?: { exact?: boolean; name?: t.TextMatcher },
    ) => {
      const o = options(value, ["exact", "name"]);
      return create(
        defined({
          kind: "role",
          role,
          exact: o?.exact,
          name: o?.name === undefined ? undefined : textMatcher(o.name),
        }) as unknown as t.LocatorData,
      );
    },
    getByLabel: (value: t.TextMatcher, o?: { exact?: boolean }) =>
      create({
        kind: "label",
        matcher: textMatcher(
          value,
          options(o, ["exact"])?.exact as boolean | undefined,
        ),
      }),
    getByPlaceholder: (value: t.TextMatcher, o?: { exact?: boolean }) =>
      create({
        kind: "placeholder",
        matcher: textMatcher(
          value,
          options(o, ["exact"])?.exact as boolean | undefined,
        ),
      }),
    getByText: (value: t.TextMatcher, o?: { exact?: boolean }) =>
      create({
        kind: "text",
        matcher: textMatcher(
          value,
          options(o, ["exact"])?.exact as boolean | undefined,
        ),
      }),
    getByTestId: (value: string) => create({ kind: "testId", value }),
  };
}
function frameLocator(
  router: Router,
  target: TabTarget,
  framePath: readonly string[],
): t.PlaywrightFrameLocator {
  requireArgument(
    framePath.length <= 8 &&
      framePath.every(
        (selector) => typeof selector === "string" && selector.length > 0,
      ),
    "At most eight nested frame selectors are allowed.",
  );
  const path = freeze([...framePath]);
  return freeze({
    ...queryMethods((query) =>
      locatorObject(router, { target, framePath: path, query }),
    ),
    frameLocator: (selector: string) =>
      frameLocator(router, target, [...path, selector]),
  });
}
function makeFrame(
  router: Router,
  input: t.FrameDescriptor,
  expected: TabTarget,
): t.Frame {
  const target = queryTarget(input.target, true) as TabTarget;
  requireArgument(
    targetKey(target) === targetKey(expected),
    "The frame descriptor belongs to a different control target.",
  );
  requireArgument(
    Array.isArray(input.framePath) &&
      input.framePath.length <= 8 &&
      input.framePath.every(
        (item) => typeof item === "string" && item.length > 0,
      ),
    "The frame descriptor is invalid.",
  );
  const path = freeze([...input.framePath]);
  return freeze({
    ...frameLocator(router, target, path),
    snapshot: (value?: { maxBytes?: number }) =>
      router.call<t.PageSnapshot>("frame.snapshot", {
        target,
        framePath: path,
        options: router.option("frame.snapshot", value),
      }),
    click: (ref: string, value?: { timeoutMs?: number }) =>
      router.call<t.ActionResult>("frame.click", {
        target,
        framePath: path,
        ref,
        options: router.option("frame.click", value),
      }),
    fill: (ref: string, text: string, value?: { timeoutMs?: number }) =>
      router.call<t.ActionResult>("frame.fill", {
        target,
        framePath: path,
        ref,
        text,
        options: router.option("frame.fill", value),
      }),
    waitFor: (condition: t.WaitCondition) =>
      router.call<t.WaitResult>("frame.waitFor", {
        target,
        framePath: path,
        condition,
      }),
  });
}
function makeDownload(
  router: Router,
  input: t.DownloadDescriptor,
): t.PlaywrightDownload {
  const target = queryTarget(input.target, true) as TabTarget;
  requireArgument(
    typeof input.downloadId === "string" && input.downloadId.length > 0,
    "The download descriptor is invalid.",
  );
  const downloadId = input.downloadId;
  return freeze({
    path: (value?: { timeoutMs?: number }) =>
      router.call<string | null>("downloads.path", {
        target,
        downloadId,
        options: router.option("downloads.path", value),
      }),
  });
}
function makeChooser(
  router: Router,
  input: t.FileChooserDescriptor,
): t.PlaywrightFileChooser {
  const target = queryTarget(input.target, true) as TabTarget;
  requireArgument(
    typeof input.chooserId === "string" &&
      Number.isSafeInteger(input.pageVersion) &&
      typeof input.multiple === "boolean",
    "The chooser descriptor is invalid.",
  );
  const { chooserId, pageVersion, multiple } = input;
  return freeze({
    isMultiple: () => multiple,
    setFiles: (files: t.FileChooserFiles, value?: { timeoutMs?: number }) =>
      router.call<void>("fileChoosers.setFiles", {
        target,
        chooserId,
        pageVersion,
        files,
        options: router.option("fileChoosers.setFiles", value),
      }),
  });
}
function makeDialog(
  router: Router,
  input: t.DialogDescriptor,
  target: TabTarget,
): t.Dialog {
  const fixed = normalizeBrowserValue(
    dataObject(input, ["target", "dialogId", "pageVersion", "type", "message"]),
  ) as t.DialogDescriptor;
  requireArgument(
    targetKey(validateTarget(fixed.target, true)) === targetKey(target) &&
      typeof fixed.dialogId === "string" &&
      Number.isSafeInteger(fixed.pageVersion) &&
      typeof fixed.message === "string",
    "The dialog descriptor is invalid.",
  );
  requireArgument(
    ["alert", "beforeunload", "confirm", "prompt"].includes(fixed.type),
    "The native dialog kind is invalid.",
  );
  const fields = {
    target,
    dialogId: fixed.dialogId,
    pageVersion: fixed.pageVersion,
  };
  const result = {
    type: fixed.type,
    message: fixed.message,
    dismiss: () => router.call<void>("dialogs.dismiss", fields),
    ...(["confirm", "prompt"].includes(fixed.type)
      ? {
          accept: async (text?: string) => {
            requireArgument(
              fixed.type === "prompt" || text === undefined,
              "Only prompt dialogs accept text.",
            );
            return router.call<void>("dialogs.accept", { ...fields, text });
          },
        }
      : {}),
  };
  return freeze(result) as t.Dialog;
}
function makeWebMcp(router: Router, target: TabTarget): t.WebMcpCapability {
  let discovered: readonly t.WebMcpTool[] | undefined;
  const checked = (tools: unknown): readonly t.WebMcpTool[] => {
    requireArgument(
      Array.isArray(tools),
      "WebMCP discovery did not return tool data.",
    );
    const fixed = normalizeBrowserValue(tools) as t.WebMcpTool[],
      names = new Set<string>();
    for (const tool of fixed) {
      requireArgument(
        typeof tool.name === "string" &&
          typeof tool.documentRevision === "string" &&
          typeof tool.registrationRevision === "string" &&
          !names.has(tool.name),
        "WebMCP registrations require unique names and exact revisions.",
      );
      names.add(tool.name);
    }
    return freeze(fixed);
  };
  const invoke = (
    tools: readonly t.WebMcpTool[],
    name: string,
    args: unknown,
  ) => {
    const tool = tools.find((tool) => tool.name === name);
    requireArgument(
      tool,
      "The requested WebMCP tool was not present in this discovery.",
    );
    return router.call<unknown>("webmcp.invokeTool", {
      target,
      name,
      args,
      tool,
    });
  };
  const api = {
    async listTools() {
      discovered = checked(await router.call("webmcp.listTools", { target }));
      return [...discovered];
    },
    async invokeTool(name: string, args: unknown) {
      const tools = discovered ?? (await api.listTools());
      return invoke(tools, name, args);
    },
    async fetchTools() {
      const value = await router.call<t.WebMcpToolsDescriptor>(
        "webmcp.fetchTools",
        { target },
      );
      const tools = checked(value.tools);
      requireArgument(
        typeof value.documentRevision === "string" &&
          typeof value.registrationRevision === "string" &&
          tools.every(
            (tool) =>
              tool.documentRevision === value.documentRevision &&
              tool.registrationRevision === value.registrationRevision,
          ),
        "WebMCP discovery revisions are inconsistent.",
      );
      discovered = tools;
      return freeze({
        documentRevision: value.documentRevision,
        registrationRevision: value.registrationRevision,
        tools,
        invokeTool: (name: string, args: unknown) => invoke(tools, name, args),
      });
    },
  };
  return freeze(api);
}
function management(
  router: Router,
  target: t.BrowserTarget,
): t.ManagementCapability {
  const call = <R>(path: string, fields: Record<string, unknown> = {}) =>
    router.call<R>(`management.${path}`, { target, ...fields });
  const opts = (path: string, value: unknown) =>
    router.option(`management.${path}`, value);
  return freeze({
    windows: {
      list: () => call<t.BrowserWindow[]>("windows.list"),
      getAll: (o?: { populate?: boolean }) =>
        call<t.BrowserWindow[]>("windows.getAll", {
          options: opts("windows.getAll", o),
        }),
      create: (o?: unknown) =>
        call<t.BrowserWindow>("windows.create", {
          options: opts("windows.create", o),
        }),
      update: (id: string, o: unknown) =>
        call<t.BrowserWindow>("windows.update", {
          id,
          options: opts("windows.update", o),
        }),
    },
    tabs: {
      query: (o?: unknown) =>
        call<t.BrowserTab[]>("tabs.query", { options: opts("tabs.query", o) }),
      get: (id: string) => call<t.BrowserTab>("tabs.get", { id }),
      move: (id: string, o: unknown) =>
        call<t.BrowserTab>("tabs.move", { id, options: opts("tabs.move", o) }),
      update: (id: string, o: unknown) =>
        call<t.BrowserTab>("tabs.update", {
          id,
          options: opts("tabs.update", o),
        }),
      group: (o: unknown) =>
        call<{ groupId: string }>("tabs.group", {
          options: opts("tabs.group", o),
        }),
      ungroup: (ids: string[]) => call<void>("tabs.ungroup", { ids }),
      close: (id: string) => call<void>("tabs.close", { id }),
    },
    tabGroups: {
      query: (o?: unknown) =>
        call<t.BrowserTabGroup[]>("tabGroups.query", {
          options: opts("tabGroups.query", o),
        }),
      get: (id: string) => call<t.BrowserTabGroup>("tabGroups.get", { id }),
      update: (id: string, o: unknown) =>
        call<t.BrowserTabGroup>("tabGroups.update", {
          id,
          options: opts("tabGroups.update", o),
        }),
      move: (id: string, o: unknown) =>
        call<t.BrowserTabGroup>("tabGroups.move", {
          id,
          options: opts("tabGroups.move", o),
        }),
    },
    bookmarks: {
      search: (query: unknown) =>
        call<t.BrowserBookmark[]>("bookmarks.search", { query }),
      getTree: () => call<t.BrowserBookmark[]>("bookmarks.getTree"),
      create: (o?: unknown) =>
        call<t.BrowserBookmark>("bookmarks.create", {
          options: opts("bookmarks.create", o),
        }),
      update: (id: string, o: unknown) =>
        call<t.BrowserBookmark>("bookmarks.update", {
          id,
          options: opts("bookmarks.update", o),
        }),
      move: (id: string, o: unknown) =>
        call<t.BrowserBookmark>("bookmarks.move", {
          id,
          options: opts("bookmarks.move", o),
        }),
      remove: (id: string) => call<void>("bookmarks.remove", { id }),
    },
    getAuditTrail: (o?: { limit?: number; cursor?: string }) =>
      call<{ changes: t.ManagementAuditEntry[]; nextCursor?: string }>(
        "getAuditTrail",
        { options: opts("getAuditTrail", o) },
      ),
  });
}
function makeBrowser(router: Router, value: t.BrowserInfo): t.Browser {
  const info = normalizeBrowserValue(dataObject(value)) as t.BrowserInfo;
  requireArgument(
    typeof info.id === "string" &&
      typeof info.name === "string" &&
      info.type === "extension" &&
      info.status === "online",
    "The selected browser descriptor is invalid.",
  );
  const target = queryTarget({
    browserId: info.id,
    bootId: info.bootId,
    browserSessionId: info.browserSessionId,
    generation: info.generation,
  });
  const organization = management(router, target);
  const visibility = freeze({
    get: () => router.call<boolean>("visibility.get", { target }),
    set: (visible: boolean) =>
      router.call<void>("visibility.set", { target, visible }),
  });
  const viewport = freeze({
    set: (options: { tabId?: string; width: number; height: number }) =>
      router.call<t.ActionResult>("viewport.set", {
        target,
        options: router.option("viewport.set", options),
      }),
    reset: (tabId?: string) =>
      router.call<t.ActionResult>("viewport.reset", { target, tabId }),
  });
  const capabilities = {
    list: () =>
      router.call<t.CapabilityInfo[]>("capabilities.browserList", { target }),
    async get(id: string) {
      const descriptor = await router.call<t.CapabilityInfo>(
        "capabilities.browserGet",
        { target, id },
      );
      requireArgument(
        descriptor.id === id,
        "The capability response does not match its requested identity.",
      );
      if (!descriptor.supported)
        throw clientError(
          "CAPABILITY_NOT_ALLOWED",
          "The requested browser capability is unavailable in this connection.",
        );
      switch (id) {
        case "management":
          return organization;
        case "visibility":
          return visibility;
        case "viewport":
          return viewport;
        default:
          return freeze(normalizeBrowserValue(descriptor));
      }
    },
  };
  const tabFrom = (descriptor: t.TabDescriptor) =>
    makeTab(router, descriptor, target);
  const tabs = {
    ...organization.tabs,
    list: () => router.call<t.TabInfo[]>("tabs.list", { target }),
    get: async (id: string) =>
      tabFrom(await router.call<t.TabDescriptor>("tabs.get", { target, id })),
    new: async (url?: string, o?: { active?: boolean }) =>
      tabFrom(
        await router.call<t.TabDescriptor>("tabs.new", {
          target,
          url,
          options: router.option("tabs.new", o),
        }),
      ),
    selected: async () => {
      const result = await router.call<t.TabDescriptor | undefined>(
        "tabs.selected",
        { target },
      );
      return result === undefined ? undefined : tabFrom(result);
    },
    select: (id: string) =>
      router.call<t.ActionResult>("tabs.select", { target, id }),
    content: (options: t.TabsContentOptions) =>
      router.call<t.TabsContentResult[]>("tabs.content", {
        target,
        options: router.option("tabs.content", options),
      }),
  };
  const user = {
    openTabs: () =>
      router.call<t.BrowserUserTabInfo[]>("user.openTabs", { target }),
    claimTab: async (tab: string | t.BrowserUserTabInfo) =>
      tabFrom(
        await router.call<t.TabDescriptor>("user.claimTab", { target, tab }),
      ),
    getTabContext: (tab?: string | t.BrowserUserTabInfo) =>
      router.call<t.BrowserUserTabContext>("user.getTabContext", {
        target,
        tab,
      }),
  };
  return freeze({
    browserId: info.id,
    name: info.name,
    type: "extension" as const,
    profileName: info.profileName,
    tabs,
    user,
    capabilities,
    management: organization,
    windows: organization.windows,
    tabGroups: organization.tabGroups,
    bookmarks: organization.bookmarks,
    visibility,
    viewport,
    documentation: () =>
      router.call<string>("browsers.documentation", { target }),
    history: (options?: t.BrowserHistoryOptions) =>
      router.call<t.BrowserHistoryEntry[]>("browsers.history", {
        target,
        options: router.option("browsers.history", options),
      }),
    nameSession: (name: string) =>
      router.call<void>("browsers.nameSession", { target, name }),
  }) as t.Browser;
}
function makeTab(
  router: Router,
  value: t.TabDescriptor,
  browserTarget?: t.BrowserTarget,
): t.Tab {
  const descriptor = dataObject(value, [
    "target",
    "id",
    "title",
    "url",
    "providerTabId",
    "active",
    "windowId",
    "groupId",
  ]);
  const target = queryTarget(
    descriptor.target as t.BrowserTarget,
    true,
  ) as TabTarget;
  requireArgument(
    (descriptor.id === undefined || descriptor.id === target.tabId) &&
      (!browserTarget ||
        targetKey({ ...target, tabId: undefined, controlEpoch: undefined }) ===
          targetKey(browserTarget)),
    "The tab descriptor belongs to a different target.",
  );
  const call = <R>(name: string, fields: Record<string, unknown> = {}) =>
    router.call<R>(name, { target, ...fields });
  const opts = (name: string, value: unknown) => router.option(name, value);
  const queries = queryMethods((query) =>
    locatorObject(router, { target, framePath: [], query }),
  );
  const cancelWaiter = async (id: string, primaryFailed: boolean) => {
    try {
      await router.call("waiters.cancel", { id }, false);
    } catch (cause) {
      if (!primaryFailed) throw cause;
    }
  };
  const arm = (
    event: "navigation" | "download" | "filechooser",
    value?: unknown,
  ) => {
    const arming = (async () => {
      requireArgument(
        ["navigation", "download", "filechooser"].includes(event),
        "This event waiter type is unsupported.",
      );
      const fields = options(
        value,
        event === "navigation"
          ? ["timeoutMs", "url", "waitUntil"]
          : ["timeoutMs"],
      );
      const info = await router.call<t.BrowserWaiterInfo>(
        "waiters.arm",
        { target, event, ...fields },
        false,
      );
      requireArgument(
        typeof info.id === "string" &&
          targetKey(validateTarget(info.target, true)) === targetKey(target),
        "The waiter descriptor does not match its target.",
      );
      return info;
    })();
    router.barrier(
      target,
      arming.then(() => {}),
    );
    void arming.catch(() => {});
    return arming;
  };
  const eventWait = (
    event: "download" | "filechooser",
    value?: t.WaitForEventOptions,
  ) => {
    const arming = arm(event, value);
    const pending = (async () => {
      let id: string | undefined,
        failed = false;
      try {
        const info = await arming;
        id = info.id;
        const result = await router.call<t.BrowserWaiterEvent>(
          "waiters.get",
          { id },
          false,
        );
        requireArgument(
          result.type === event &&
            targetKey(validateTarget(result.target, true)) ===
              targetKey(target),
          "The waiter event does not match its registration.",
        );
        return result.type === "download"
          ? makeDownload(router, {
              target,
              downloadId: result.downloadId,
              suggestedFilename: result.suggestedFilename,
            })
          : makeChooser(router, {
              target,
              chooserId: result.chooserId,
              pageVersion: result.pageVersion,
              multiple: result.multiple,
            });
      } catch (cause) {
        failed = true;
        throw cause;
      } finally {
        if (id) await cancelWaiter(id, failed);
      }
    })();
    void pending.catch(() => {});
    return pending;
  };
  const playwright = {
    ...queries,
    domSnapshot: () => call<string>("playwright.domSnapshot"),
    elementInfo: (options: t.ElementInfoOptions) =>
      call<t.ElementInfo[]>("playwright.elementInfo", {
        options: opts("playwright.elementInfo", options),
      }),
    elementScreenshot: (options: t.ElementScreenshotOptions) =>
      call<Uint8Array>("playwright.elementScreenshot", {
        options: opts("playwright.elementScreenshot", options),
      }),
    evaluate: <R, A>(
      expression: string,
      arg?: A,
      options?: t.PlaywrightEvaluateOptions,
    ) =>
      call<R>("playwright.evaluate", {
        expression,
        arg,
        options: opts("playwright.evaluate", options),
      }),
    frameLocator: (selector: string) =>
      frameLocator(router, target, [selector]),
    async expectNavigation<T>(
      action: () => Promise<T>,
      value?: { timeoutMs?: number; url?: string; waitUntil?: t.WaitUntil },
    ): Promise<T> {
      requireArgument(
        typeof action === "function",
        "expectNavigation requires a local action callback.",
      );
      const arming = arm(
        "navigation",
        options(value, ["timeoutMs", "url", "waitUntil"]),
      );
      let id: string | undefined,
        failed = false;
      try {
        const info = await arming;
        id = info.id;
        const result = await action();
        const event = await router.call<t.BrowserWaiterEvent>(
          "waiters.get",
          { id },
          false,
        );
        requireArgument(
          event.type === "navigation" &&
            targetKey(validateTarget(event.target, true)) === targetKey(target),
          "The navigation event does not match its registration.",
        );
        return result;
      } catch (cause) {
        failed = true;
        throw cause;
      } finally {
        if (id) await cancelWaiter(id, failed);
      }
    },
    waitForEvent: eventWait,
    waitForDownload: (value?: t.WaitForEventOptions) =>
      eventWait("download", value) as Promise<t.PlaywrightDownload>,
    waitForFileChooser: (value?: t.WaitForEventOptions) =>
      eventWait("filechooser", value) as Promise<t.PlaywrightFileChooser>,
    waitForLoadState: (options?: t.PageWaitForLoadStateOptions) =>
      call<void>("playwright.waitForLoadState", {
        options: opts("playwright.waitForLoadState", options),
      }),
    waitForTimeout: (timeoutMs: number) =>
      call<void>("playwright.waitForTimeout", { timeoutMs }),
    waitForURL: (url: string, options?: t.PageWaitForURLOptions) =>
      call<void>("playwright.waitForURL", {
        url,
        options: opts("playwright.waitForURL", options),
      }),
  };
  const ax = {
    click: (element: number | t.AXPoint, options?: t.AXClickOptions) =>
      call<void>("ax.click", { element, options: opts("ax.click", options) }),
    drag: (from: t.AXPoint, to: t.AXPoint) =>
      call<void>("ax.drag", { from, to }),
    get: (mode?: "state" | "screenshot" | "both", options?: t.AXStateOptions) =>
      call<unknown>("ax.get", { mode, options: opts("ax.get", options) }),
    write: (
      mode?: "state" | "screenshot" | "both",
      options?: t.AXStateOptions,
    ) =>
      call<t.OutputIntent>("ax.write", {
        mode,
        options: opts("ax.write", options),
      }),
    snapshot: (options?: t.AXStateOptions) =>
      call<unknown>("ax.snapshot", { options: opts("ax.snapshot", options) }),
    paste: (
      elementIndex: number | null,
      text: string,
      options?: t.AXPasteOptions,
    ) =>
      call<void>("ax.paste", {
        elementIndex,
        text,
        options: opts("ax.paste", options),
      }),
    performSecondaryAction: (elementIndex: number, action: string) =>
      call<void>("ax.performSecondaryAction", { elementIndex, action }),
    pressKey: (
      elementIndex: number | null,
      key: string,
      options?: t.AXPressKeyOptions,
    ) =>
      call<void>("ax.pressKey", {
        elementIndex,
        key,
        options: opts("ax.pressKey", options),
      }),
    scroll: (
      element: number | t.AXPoint,
      direction: t.AXDirection,
      pages?: number,
    ) => call<void>("ax.scroll", { element, direction, pages }),
    selectText: (
      elementIndex: number,
      text: string,
      options?: t.AXSelectTextOptions,
    ) =>
      call<void>("ax.selectText", {
        elementIndex,
        text,
        options: opts("ax.selectText", options),
      }),
    setValue: (elementIndex: number, value: string) =>
      call<void>("ax.setValue", { elementIndex, value }),
    typeText: (elementIndex: number | null, text: string) =>
      call<void>("ax.typeText", { elementIndex, text }),
  };
  const cua = Object.fromEntries(
    [
      "click",
      "doubleClick",
      "downloadMedia",
      "drag",
      "keypress",
      "move",
      "scroll",
      "type",
    ].map((name) => [
      name,
      (value: unknown) =>
        call(`cua.${name}`, { options: opts(`cua.${name}`, value) }),
    ]),
  );
  const dom = {
    ...Object.fromEntries(
      [
        "click",
        "doubleClick",
        "downloadMedia",
        "keypress",
        "scroll",
        "type",
      ].map((name) => [
        name,
        (value: unknown) =>
          call(`dom.${name}`, { options: opts(`dom.${name}`, value) }),
      ]),
    ),
    getVisibleTree: () => call<t.VisibleDomTree>("dom.getVisibleTree"),
    fill: (nodeId: string, text: string) =>
      call<t.ActionResult>("dom.fill", { nodeId, text }),
  };
  const content = {
    export: () => call<t.BrowserArtifact>("content.export"),
    exportGsuite: (type: Parameters<t.ContentAPI["exportGsuite"]>[0]) =>
      call<t.BrowserArtifact>("content.exportGsuite", { type }),
    exportYouTubeTranscript: () =>
      call<t.BrowserArtifact>("content.exportYouTubeTranscript"),
  };
  const clipboard = {
    read: () => call<t.TabClipboardItem[]>("clipboard.read"),
    readText: () => call<string>("clipboard.readText"),
    write: (items: t.TabClipboardItem[]) =>
      call<void>("clipboard.write", { items }),
    writeText: (text: string) => call<void>("clipboard.writeText", { text }),
  };
  const assets = {
    list: () => call<t.PageAssetInventory>("pageAssets.list"),
    download: (urls: string[]) =>
      call<Awaited<ReturnType<t.PageAssetsCapability["download"]>>>(
        "pageAssets.download",
        { urls },
      ),
    bundle: (options: Parameters<t.PageAssetsCapability["bundle"]>[0]) =>
      call<t.PageAssetBundle>("pageAssets.bundle", {
        options: opts("pageAssets.bundle", options),
      }),
  };
  const cdp = {
    send: (
      method: string,
      params?: Record<string, unknown>,
      options?: Parameters<t.CdpCapability["send"]>[2],
    ) =>
      call<unknown>("cdp.send", {
        method,
        params,
        options: opts("cdp.send", options),
      }),
    events: (cursor?: string) =>
      call<Awaited<ReturnType<t.CdpCapability["events"]>>>("cdp.events", {
        cursor,
      }),
    cursor: () => call<string>("cdp.cursor"),
    readEvents: (options?: t.CdpEventsOptions) => {
      return call<Awaited<ReturnType<t.CdpCapability["readEvents"]>>>(
        "cdp.readEvents",
        { options: opts("cdp.readEvents", options) },
      );
    },
  };
  const webmcp = makeWebMcp(router, target);
  const capabilities = {
    list: () => call<t.CapabilityInfo[]>("capabilities.tabList"),
    async get(id: string) {
      const info = await call<t.CapabilityInfo>("capabilities.tabGet", { id });
      requireArgument(
        info.id === id,
        "The capability descriptor does not match the requested identity.",
      );
      if (!info.supported)
        throw clientError(
          "CAPABILITY_NOT_ALLOWED",
          "The requested tab capability is unavailable.",
        );
      switch (id) {
        case "pageAssets":
          return assets;
        case "cdp":
          return cdp;
        case "webmcp":
          return webmcp;
        default:
          return freeze(normalizeBrowserValue(info));
      }
    },
  };
  const result = {
    id: target.tabId,
    ax,
    cua,
    dom,
    content,
    clipboard,
    playwright,
    assets,
    cdp,
    webmcp,
    capabilities,
    goBack: (options?: t.NavigationOptions) =>
      call<t.ActionResult>("tab.goBack", {
        options: opts("tab.goBack", options),
      }),
    forward: (options?: t.NavigationOptions) =>
      call<t.ActionResult>("tab.forward", {
        options: opts("tab.forward", options),
      }),
    reload: (options?: t.NavigationOptions) =>
      call<t.ActionResult>("tab.reload", {
        options: opts("tab.reload", options),
      }),
    navigate: (url: string, options?: t.NavigationOptions) =>
      call<t.ActionResult>("tab.navigate", {
        url,
        options: opts("tab.navigate", options),
      }),
    close: () => call<void>("tab.close"),
    title: () => call<string | undefined>("tab.title"),
    url: () => call<string | undefined>("tab.url"),
    screenshot: (options?: t.ScreenshotOptions) =>
      call<Uint8Array>("tab.screenshot", {
        options: opts("tab.screenshot", options),
      }),
    markDeliverable: () => call<void>("tab.markDeliverable"),
    markHandoff: () => call<void>("tab.markHandoff"),
    requestUserTakeover: (
      reason?: "authentication" | "captcha" | "user_requested" | "other",
    ) => call<void>("tab.requestUserTakeover", { reason }),
    getJsDialog: async () => {
      const value = await call<t.DialogDescriptor | undefined>(
        "tab.getJsDialog",
      );
      return value === undefined
        ? undefined
        : makeDialog(router, value, target);
    },
    snapshot: (options?: {
      maxBytes?: number;
      root?: string;
      frame?: string;
    }) =>
      call<t.PageSnapshot>("tab.snapshot", {
        options: opts("tab.snapshot", options),
      }),
    click: (ref: string, options?: t.LocatorClickOptions) =>
      call<t.ActionResult>("tab.click", {
        ref,
        options: opts("tab.click", options),
      }),
    fill: (ref: string, text: string, options?: { timeoutMs?: number }) =>
      call<t.ActionResult>("tab.fill", {
        ref,
        text,
        options: opts("tab.fill", options),
      }),
    press: (
      key: string,
      options?: { timeoutMs?: number; modifiers?: t.KeyboardModifier[] },
    ) =>
      call<t.ActionResult>("tab.press", {
        key,
        options: opts("tab.press", options),
      }),
    selectOption: (
      ref: string,
      values: t.SelectOptionInput | t.SelectOptionInput[],
    ) => call<t.ActionResult>("tab.selectOption", { ref, values }),
    scroll: (options: Parameters<t.Tab["scroll"]>[0]) =>
      call<t.ActionResult>("tab.scroll", {
        options: opts("tab.scroll", options),
      }),
    hover: (ref: string, options?: { timeoutMs?: number }) =>
      call<t.ActionResult>("tab.hover", {
        ref,
        options: opts("tab.hover", options),
      }),
    focus: (ref: string) => call<t.ActionResult>("tab.focus", { ref }),
    waitFor: (condition: t.WaitCondition) =>
      call<t.WaitResult>("tab.waitFor", { condition }),
    locator: queries.locator,
    evaluate: <R>(expression: string, args?: unknown) =>
      call<R>("tab.evaluate", { expression, args }),
    keyboardDown: (key: string) =>
      call<t.ActionResult>("tab.keyboardDown", { key }),
    keyboardUp: (key: string) =>
      call<t.ActionResult>("tab.keyboardUp", { key }),
    frame: async (selector: string) =>
      makeFrame(
        router,
        await call<t.FrameDescriptor>("tab.frame", { selector }),
        target,
      ),
    dialogAccept: (text?: string) =>
      call<t.ActionResult>("tab.dialogAccept", { text }),
    dialogDismiss: () => call<t.ActionResult>("tab.dialogDismiss"),
    contentExport: (options: { format: "html" | "markdown" | "text" }) =>
      call<Awaited<ReturnType<t.Tab["contentExport"]>>>("tab.contentExport", {
        options: opts("tab.contentExport", options),
      }),
    exportGsuite: content.exportGsuite,
    exportYouTubeTranscript: content.exportYouTubeTranscript,
    clipboardReadText: clipboard.readText,
    clipboardRead: clipboard.read,
    clipboardWriteText: (text: string) =>
      call<t.ActionResult>("clipboard.writeText", { text }),
    clipboardWrite: (items: t.TabClipboardItem[]) =>
      call<t.ActionResult>("clipboard.write", { items }),
    setFiles: (ref: string, files: t.BrowserFileSource[]) =>
      call<t.ActionResult>("tab.setFiles", { ref, files }),
    downloads: () => call<t.BrowserDownload[]>("tab.downloads"),
    saveDownload: (id: string, path?: string) =>
      call<t.BrowserArtifact>("tab.saveDownload", { id, path }),
    setViewport: (size: { width: number; height: number }) =>
      call<t.ActionResult>("tab.setViewport", {
        size: router.option("tab.setViewport", size, "size"),
      }),
    resetViewport: () => call<t.ActionResult>("tab.resetViewport"),
    devLogs: (options?: t.TabDevLogsOptions & { since?: number }) =>
      call<t.TabDevLogEntry[]>("tab.devLogs", {
        options: opts("tab.devLogs", options),
      }),
    dev: {
      logs: (options?: t.TabDevLogsOptions) =>
        call<t.TabDevLogEntry[]>("dev.logs", {
          options: opts("dev.logs", options),
        }),
    },
    exportFile: (options: { format: "pdf" | "html" | "markdown" }) =>
      call<t.BrowserArtifact>("tab.exportFile", {
        options: opts("tab.exportFile", options),
      }),
  };
  return freeze(result) as unknown as t.Tab;
}
/** Construct immutable public facades only. No connection, listener, filesystem or browser I/O occurs here. */
export function createBrowserClient(
  methods: Readonly<Record<string, unknown>>,
): t.BrowserClient {
  const router = new Router(methods);
  return freeze({
    browsers: {
      list: () => router.call<t.BrowserInfo[]>("browsers.list", {}),
      get: async (id: string) =>
        makeBrowser(
          router,
          await router.call<t.BrowserInfo>("browsers.get", { id }),
        ),
      getDefault: async () =>
        makeBrowser(
          router,
          await router.call<t.BrowserInfo>("browsers.getDefault", {}),
        ),
      getForUrl: async (url: string) =>
        makeBrowser(
          router,
          await router.call<t.BrowserInfo>("browsers.getForUrl", { url }),
        ),
    },
    documentation: {
      get: (name: string) => router.call<string>("documentation.get", { name }),
    },
  });
}
