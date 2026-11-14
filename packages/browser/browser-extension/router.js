import {
  BrowserActionError,
  requireValue,
  record,
  text,
  nativeId,
  httpUrl,
  publicUrl,
} from "./errors.js";
import { pageCommand } from "./page.js";
import {
  chord,
  keyDescription,
  keyDown,
  keyToken,
  keyUp,
  pressKeys,
} from "./keyboard.js";
import { nativeNodeCommand } from "./native-node.js";
import {
  clipboardCommand,
  readClipboard,
  writeClipboard,
} from "./clipboard.js";
import { framePage } from "./frames.js";
import { evaluateLocated } from "./evaluate.js";
import { pageDataCommand, readPageBytes } from "./page-data.js";
import {
  listAssets,
  planAssets,
  downloadAssets,
  bundleAssets,
  planContent,
  exportContent,
} from "./assets.js";

const encoder = new TextEncoder();
const maxEventBytes = 1024 * 1024;
const now = () => Date.now();
const targetFields = ["bootId", "browserId", "browserSessionId", "generation"];
const options = (args) => args.options ?? args;
const stringData = (value, maximum = 1024 * 1024) => {
  requireValue(
    typeof value === "string" && encoder.encode(value).byteLength <= maximum,
  );
  return value;
};
const sameData = (left, right, depth = 0) => {
  if (left === right) return true;
  if (
    depth > 64 ||
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && sameData(left[key], right[key], depth + 1),
    )
  );
};
const axFacts = (node) => ({
  role: node.role?.value,
  value: node.value?.value,
  ...Object.fromEntries(
    (node.properties ?? []).map((property) => [
      property.name,
      property.value?.value,
    ]),
  ),
});
const secondaryActions = (node) => {
  const facts = axFacts(node);
  if (facts.disabled === true || facts.readonly === true) return [];
  const actions = [];
  if (typeof facts.expanded === "boolean")
    actions.push(facts.expanded ? "Collapse" : "Expand");
  if ([true, false, "true", "false", "mixed"].includes(facts.checked))
    actions.push("Toggle");
  const value = Number(facts.value);
  if (["slider", "spinbutton"].includes(facts.role) && Number.isFinite(value)) {
    if (facts.valuemax === undefined || value < Number(facts.valuemax))
      actions.push("Increment");
    if (facts.valuemin === undefined || value > Number(facts.valuemin))
      actions.push("Decrement");
  }
  return actions;
};
const fields = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const tabIdOf = (ctx, args) =>
  nativeId(args.id ?? args.tabId ?? ctx.target.tabId);
const decimal = (value) => (value === undefined ? undefined : nativeId(value));
const arrayIds = (value) => {
  requireValue(
    Array.isArray(value) && value.length > 0 && value.length <= 1000,
  );
  return value.map(nativeId);
};
const mappedOptions = (args, keys, ids = []) => {
  const result = fields(options(args), keys);
  for (const key of ids)
    if (result[key] !== undefined) result[key] = nativeId(result[key]);
  return result;
};
const sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
const routes = {};
function route(method, handle, { needsTab = false, mutating = false } = {}) {
  routes[method] = Object.freeze({ method, handle, needsTab, mutating });
}
const aliases = (names, handle, meta) => {
  for (const method of names) route(method, handle, meta);
};
const tabInfo = (ctx, tab) => {
  const epochs = (ctx.lease.epochs ??= new Map());
  if (!epochs.has(tab.id)) epochs.set(tab.id, crypto.randomUUID());
  return {
    id: String(tab.id),
    providerTabId: String(tab.id),
    ...(tab.title === undefined ? {} : { title: tab.title.slice(0, 4096) }),
    ...(tab.url === undefined ? {} : { url: tab.url }),
    target: ctx.router.target(String(tab.id), ctx.lease),
  };
};
const nativeTab = (ctx, tab) => ({
  browserId: ctx.target.browserId,
  tabId: String(tab.id),
  bootId: ctx.target.bootId,
  browserSessionId: ctx.target.browserSessionId,
  generation: ctx.target.generation,
  title: tab.title ?? "",
  url: tab.url ?? "",
  active: !!tab.active,
  windowId: String(tab.windowId),
  ...(tab.groupId >= 0 ? { groupId: String(tab.groupId) } : {}),
});
const nativeWindow = (ctx, window) => ({
  ...fields(window, ["focused", "state", "left", "top", "width", "height"]),
  id: String(window.id),
  ...(window.tabs ? { tabs: window.tabs.map((t) => nativeTab(ctx, t)) } : {}),
});
const nativeGroup = (value) => ({
  id: String(value.id),
  windowId: String(value.windowId),
  title: value.title ?? "",
  color: value.color,
  collapsed: !!value.collapsed,
});
const bookmark = (value) => ({
  ...fields(value, ["id", "parentId", "index", "title", "url"]),
  ...(value.children ? { children: value.children.map(bookmark) } : {}),
});

route("tabs.list", async (ctx) =>
  (await ctx.chrome.tabs.query({})).map((tab) => tabInfo(ctx, tab)),
);
route("tabs.get", async (ctx, args) =>
  tabInfo(ctx, await ctx.chrome.tabs.get(tabIdOf(ctx, args))),
);
route(
  "tabs.new",
  async (ctx, args) =>
    tabInfo(
      ctx,
      await ctx.chrome.tabs.create({
        ...(args.url === undefined ? {} : { url: httpUrl(args.url) }),
        active: options(args).active ?? true,
      }),
    ),
  { mutating: true },
);
route("tabs.selected", async (ctx) => {
  const tabs = await ctx.chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0] ? tabInfo(ctx, tabs[0]) : null;
});
route(
  "tabs.select",
  async (ctx, args) => {
    const id = tabIdOf(ctx, args);
    ctx.router.claim(ctx.lease, id);
    await ctx.chrome.tabs.update(id, { active: true });
    return ctx.router.actionResult(ctx, id);
  },
  { mutating: true },
);
route(
  "tab.title",
  async (ctx) =>
    (await ctx.chrome.tabs.get(nativeId(ctx.target.tabId))).title ?? null,
  { needsTab: true },
);
route(
  "tab.url",
  async (ctx) =>
    (await ctx.chrome.tabs.get(nativeId(ctx.target.tabId))).url ?? null,
  { needsTab: true },
);
route(
  "tab.close",
  async (ctx) => {
    await ctx.router.closeNativeTab(ctx, nativeId(ctx.target.tabId));
    return null;
  },
  { needsTab: true, mutating: true },
);
for (const [method, api] of [
  ["goBack", "goBack"],
  ["forward", "goForward"],
  ["reload", "reload"],
]) {
  route(
    `tab.${method}`,
    (ctx, args) => ctx.router.navigate(ctx, api, undefined, options(args)),
    { needsTab: true, mutating: true },
  );
}
route(
  "tab.navigate",
  (ctx, args) =>
    ctx.router.navigate(ctx, "navigate", httpUrl(args.url), options(args)),
  { needsTab: true, mutating: true },
);
route("user.openTabs", async (ctx) =>
  (await ctx.chrome.tabs.query({})).map((tab) => ({
    ...tabInfo(ctx, tab),
    ...(tab.lastAccessed
      ? { lastOpened: new Date(tab.lastAccessed).toISOString() }
      : {}),
    ...(tab.groupId >= 0 ? { tabGroup: String(tab.groupId) } : {}),
  })),
);
route(
  "user.claimTab",
  async (ctx, args) => {
    const id = nativeId(
      typeof args.tab === "string" ? args.tab : (args.tab?.id ?? args.id),
    );
    ctx.router.claim(ctx.lease, id);
    return tabInfo(ctx, await ctx.chrome.tabs.get(id));
  },
  { mutating: true },
);
route("browsers.history", async (ctx, args) => {
  const input = options(args),
    limit = input.limit ?? 20;
  requireValue(
    Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 20 &&
      (!input.queries ||
        (Array.isArray(input.queries) && input.queries.length <= 4)),
  );
  const startTime = input.from === undefined ? 0 : Date.parse(input.from),
    endTime = input.to === undefined ? Date.now() : Date.parse(input.to);
  requireValue(
    Number.isFinite(startTime) &&
      Number.isFinite(endTime) &&
      startTime <= endTime,
  );
  const all = (
    await Promise.all(
      (input.queries?.length ? input.queries : [""]).map((query) =>
        ctx.chrome.history.search({
          text: query,
          startTime,
          endTime,
          maxResults: limit,
        }),
      ),
    )
  ).flat();
  const unique = new Map();
  for (const item of all)
    if (
      !unique.has(item.url) ||
      unique.get(item.url).lastVisitTime < item.lastVisitTime
    )
      unique.set(item.url, item);
  return [...unique.values()]
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
    .slice(0, limit)
    .map((item) => ({
      url: item.url,
      title: item.title,
      dateVisited: new Date(item.lastVisitTime).toISOString(),
    }));
});
route("browsers.nameSession", async (ctx, args) => {
  ctx.lease.name = text(args.name, 120);
  await ctx.router.nameVisualSession(ctx, args.name);
  return null;
});
route("visibility.get", async (ctx) => ctx.router.followSessionTab);
route("visibility.set", async (ctx, args) => {
  requireValue(typeof (args.visible ?? args.value) === "boolean");
  ctx.router.followSessionTab = args.visible ?? args.value;
  return null;
});

route("management.windows.list", async (ctx) =>
  (await ctx.chrome.windows.getAll({ populate: false })).map((w) =>
    nativeWindow(ctx, w),
  ),
);
route("management.windows.getAll", async (ctx, args) =>
  (
    await ctx.chrome.windows.getAll({
      populate: options(args).populate ?? false,
    })
  ).map((w) => nativeWindow(ctx, w)),
);
route(
  "management.windows.create",
  async (ctx, args) =>
    nativeWindow(
      ctx,
      await ctx.chrome.windows.create(
        mappedOptions(
          args,
          ["tabId", "focused", "left", "top", "width", "height"],
          ["tabId"],
        ),
      ),
    ),
  { mutating: true },
);
route(
  "management.windows.update",
  async (ctx, args) =>
    nativeWindow(
      ctx,
      await ctx.chrome.windows.update(
        nativeId(args.id),
        mappedOptions(args, [
          "focused",
          "state",
          "left",
          "top",
          "width",
          "height",
        ]),
      ),
    ),
  { mutating: true },
);
route("management.tabs.query", async (ctx, args) =>
  (
    await ctx.chrome.tabs.query(
      mappedOptions(
        args,
        ["windowId", "url", "active", "pinned", "groupId"],
        ["windowId", "groupId"],
      ),
    )
  ).map((tab) => nativeTab(ctx, tab)),
);
route("management.tabs.get", async (ctx, args) =>
  nativeTab(ctx, await ctx.chrome.tabs.get(tabIdOf(ctx, args))),
);
route(
  "management.tabs.move",
  async (ctx, args) => {
    const id = tabIdOf(ctx, args);
    ctx.router.claim(ctx.lease, id);
    const value = await ctx.chrome.tabs.move(
      id,
      mappedOptions(args, ["index", "windowId"], ["windowId"]),
    );
    return nativeTab(ctx, Array.isArray(value) ? value[0] : value);
  },
  { mutating: true },
);
route(
  "management.tabs.update",
  async (ctx, args) => {
    const id = tabIdOf(ctx, args);
    ctx.router.claim(ctx.lease, id);
    const input = options(args);
    return nativeTab(
      ctx,
      await ctx.chrome.tabs.update(id, {
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.muted === undefined ? {} : { muted: input.muted }),
      }),
    );
  },
  { mutating: true },
);
route(
  "management.tabs.group",
  async (ctx, args) => {
    const input = options(args),
      ids = arrayIds(input.tabIds);
    for (const id of ids) ctx.router.canClaim(ctx.lease, id);
    const tabs = await Promise.all(ids.map((id) => ctx.chrome.tabs.get(id)));
    const windows = new Set(tabs.map((tab) => tab.windowId));
    requireValue(
      windows.size === 1,
      "INVALID_TARGET",
      "A task group must stay in one actual browser window.",
    );
    for (const id of ids) ctx.router.canClaim(ctx.lease, id);
    for (const id of ids) ctx.router.claim(ctx.lease, id);
    const id = await ctx.chrome.tabs.group({
      tabIds: ids,
      ...(input.groupId === undefined
        ? {}
        : { groupId: nativeId(input.groupId) }),
      ...(input.createProperties === undefined
        ? {}
        : {
            createProperties: {
              windowId: decimal(input.createProperties.windowId),
            },
          }),
    });
    return { groupId: String(id) };
  },
  { mutating: true },
);
route(
  "management.tabs.ungroup",
  async (ctx, args) => {
    const ids = arrayIds(args.ids ?? args.tabIds);
    for (const id of ids) ctx.router.canClaim(ctx.lease, id);
    for (const id of ids) ctx.router.claim(ctx.lease, id);
    await ctx.chrome.tabs.ungroup(ids);
    return null;
  },
  { mutating: true },
);
route(
  "management.tabs.close",
  async (ctx, args) => {
    const id = tabIdOf(ctx, args);
    ctx.router.claim(ctx.lease, id);
    await ctx.router.closeNativeTab(ctx, id);
    return null;
  },
  { mutating: true },
);
route("management.tabGroups.query", async (ctx, args) =>
  (
    await ctx.chrome.tabGroups.query(
      mappedOptions(
        args,
        ["windowId", "title", "color", "collapsed"],
        ["windowId"],
      ),
    )
  ).map(nativeGroup),
);
route("management.tabGroups.get", async (ctx, args) =>
  nativeGroup(await ctx.chrome.tabGroups.get(nativeId(args.id))),
);
route(
  "management.tabGroups.update",
  async (ctx, args) =>
    nativeGroup(
      await ctx.chrome.tabGroups.update(
        nativeId(args.id),
        mappedOptions(args, ["title", "color", "collapsed"]),
      ),
    ),
  { mutating: true },
);
route(
  "management.tabGroups.move",
  async (ctx, args) =>
    nativeGroup(
      await ctx.chrome.tabGroups.move(
        nativeId(args.id),
        mappedOptions(args, ["index", "windowId"], ["windowId"]),
      ),
    ),
  { mutating: true },
);
route("management.bookmarks.search", async (ctx, args) =>
  (await ctx.chrome.bookmarks.search(args.query)).map(bookmark),
);
route("management.bookmarks.getTree", async (ctx) =>
  (await ctx.chrome.bookmarks.getTree()).map(bookmark),
);
route(
  "management.bookmarks.create",
  async (ctx, args) => {
    const input = mappedOptions(args, ["parentId", "index", "title", "url"]);
    if (input.url !== undefined) input.url = httpUrl(input.url);
    return bookmark(await ctx.chrome.bookmarks.create(input));
  },
  { mutating: true },
);
route(
  "management.bookmarks.update",
  async (ctx, args) => {
    const input = mappedOptions(args, ["title", "url"]);
    if (input.url !== undefined) input.url = httpUrl(input.url);
    return bookmark(
      await ctx.chrome.bookmarks.update(text(args.id, 256), input),
    );
  },
  { mutating: true },
);
route(
  "management.bookmarks.move",
  async (ctx, args) =>
    bookmark(
      await ctx.chrome.bookmarks.move(
        text(args.id, 256),
        mappedOptions(args, ["parentId", "index"]),
      ),
    ),
  { mutating: true },
);
route(
  "management.bookmarks.remove",
  async (ctx, args) => {
    await ctx.chrome.bookmarks.remove(text(args.id, 256));
    return null;
  },
  { mutating: true },
);
route("management.getAuditTrail", async (ctx, args) =>
  ctx.router.audit(options(args)),
);

const pageRoute = (command) => async (ctx, args) =>
  ctx.router.page(ctx, { ...args, ...options(args), command });
for (const method of [
  "count",
  "allTextContents",
  "textContent",
  "innerText",
  "isVisible",
  "isEnabled",
  "getAttribute",
])
  route(`locator.${method}`, pageRoute(method), { needsTab: true });
route(
  "locator.all",
  async (ctx, args) =>
    (await ctx.router.page(ctx, { ...args, command: "all" })).map((query) => ({
      target: ctx.router.target(ctx.target.tabId, ctx.lease),
      framePath: args.locator.framePath,
      query,
    })),
  { needsTab: true },
);
route("locator.fill", pageRoute("fill"), { needsTab: true, mutating: true });
route("locator.selectOption", pageRoute("selectOption"), {
  needsTab: true,
  mutating: true,
});
route("playwright.domSnapshot", pageRoute("domSnapshot"), { needsTab: true });
route(
  "dom.getVisibleTree",
  async (ctx, args) => ({
    target: ctx.router.target(ctx.target.tabId, ctx.lease),
    ...(await ctx.router.page(ctx, { ...args, command: "visibleTree" })),
  }),
  { needsTab: true },
);
route(
  "tab.frame",
  async (ctx, args) => {
    text(args.selector, 8192);
    await ctx.router.page(ctx, {
      command: "readyState",
      framePath: [args.selector],
    });
    return {
      target: ctx.router.target(ctx.target.tabId, ctx.lease),
      framePath: [args.selector],
    };
  },
  { needsTab: true },
);
aliases(
  ["tab.snapshot", "frame.snapshot"],
  async (ctx, args) => ({
    ...ctx.router.target(ctx.target.tabId, ctx.lease),
    ...(await ctx.router.page(ctx, {
      ...args,
      ...options(args),
      command: "snapshot",
    })),
  }),
  { needsTab: true },
);
route("playwright.elementInfo", pageRoute("elementInfo"), { needsTab: true });
route(
  "dom.fill",
  async (ctx, args) => {
    await ctx.router.page(ctx, {
      ...args,
      nodeId: args.nodeId ?? args.node_id,
      command: "fill",
      value: args.text,
    });
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
aliases(
  ["tab.fill", "frame.fill"],
  async (ctx, args) => {
    await ctx.router.page(ctx, { ...args, command: "fill", value: args.text });
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.focus",
  async (ctx, args) => {
    await ctx.router.page(ctx, { ...args, command: "focus" });
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.selectOption",
  async (ctx, args) => {
    await ctx.router.page(ctx, { ...args, command: "selectOption" });
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.scroll",
  async (ctx, args) => {
    await ctx.router.page(ctx, { ...options(args), command: "scroll" });
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "dom.scroll",
  async (ctx, args) => {
    const input = options(args);
    await ctx.router.page(ctx, {
      ...input,
      nodeId: input.node_id,
      command: "scroll",
    });
    return null;
  },
  { needsTab: true, mutating: true },
);
aliases(
  ["tab.waitFor", "frame.waitFor"],
  (ctx, args) => ctx.router.waitForCondition(ctx, args),
  { needsTab: true },
);
route("clipboard.readText", pageRoute("readText"), { needsTab: true });
route("clipboard.read", (ctx) => readClipboard(ctx), { needsTab: true });
route(
  "clipboard.write",
  async (ctx, args) => {
    await writeClipboard(ctx, args.items);
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "clipboard.writeText",
  async (ctx, args) => {
    await ctx.router.page(ctx, { ...args, command: "writeText" });
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.contentExport",
  async (ctx, args) => ({
    data: await ctx.router.page(ctx, {
      ...args,
      format: options(args).format ?? "text",
      command: "content",
    }),
    truncated: false,
  }),
  { needsTab: true },
);
route("user.getTabContext", async (ctx, args) => {
  const id =
    args.tab === undefined
      ? ctx.target.tabId
      : typeof args.tab === "string"
        ? args.tab
        : args.tab.id;
  requireValue(
    id && ctx.target.tabId === id,
    "INVALID_TARGET",
    "The user-context request must identify its exact reserved tab.",
  );
  await ctx.router.resolveTab(ctx, id);
  const tab = await ctx.chrome.tabs.get(nativeId(id));
  return {
    kind: "text",
    text: await ctx.router.page(ctx, { command: "content", format: "text" }),
    title: tab.title ?? "",
    url: tab.url ?? "",
    truncated: false,
  };
});
route(
  "playwright.waitForTimeout",
  async (ctx, args) => {
    requireValue(
      Number.isFinite(args.timeoutMs) &&
        args.timeoutMs >= 0 &&
        args.timeoutMs <= ctx.budgetMs,
    );
    await sleep(args.timeoutMs, ctx.signal);
    return null;
  },
  { needsTab: true },
);
route(
  "locator.waitFor",
  async (ctx, args) => {
    await ctx.router.poll(ctx, () =>
      ctx.router.page(ctx, {
        ...args,
        command: "waitState",
        state: options(args).state,
      }),
    );
    return null;
  },
  { needsTab: true },
);
route(
  "playwright.waitForURL",
  async (ctx, args) => {
    await ctx.router.poll(
      ctx,
      async () =>
        (await ctx.chrome.tabs.get(nativeId(ctx.target.tabId))).url ===
        args.url,
    );
    return null;
  },
  { needsTab: true },
);
route(
  "playwright.waitForLoadState",
  (ctx, args) => ctx.router.waitForLoadState(ctx, options(args)),
  { needsTab: true },
);
aliases(
  ["tab.evaluate", "playwright.evaluate"],
  async (ctx, args) =>
    ctx.router.evaluate(
      ctx,
      args.expression ?? args.pageFunction,
      args.args ?? args.arg,
    ),
  { needsTab: true, mutating: true },
);
for (const multiple of [false, true])
  route(
    multiple ? "locator.evaluateAll" : "locator.evaluate",
    (ctx, args) => ctx.router.evaluateLocator(ctx, args, multiple),
    { needsTab: true, mutating: true },
  );

route(
  "cdp.send",
  async (ctx, args) => {
    text(args.method, 256);
    record(args.params ?? {});
    requireValue(
      /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(args.method),
    );
    const requested = args.options?.target;
    return ctx.router.send(ctx, args.method, args.params ?? {}, requested);
  },
  { needsTab: true, mutating: true },
);
route("cdp.cursor", async (ctx) => ctx.router.eventCursor(ctx), {
  needsTab: true,
});
route(
  "cdp.events",
  async (ctx, args) => ctx.router.events(ctx, { cursor: args.cursor }),
  { needsTab: true },
);
route(
  "cdp.readEvents",
  async (ctx, args) => ctx.router.events(ctx, args.options ?? {}),
  { needsTab: true },
);
for (const method of ["tab.screenshot"])
  route(
    method,
    async (ctx, args) => ctx.router.screenshot(ctx, options(args)),
    { needsTab: true },
  );
route(
  "playwright.elementScreenshot",
  async (ctx, args) => {
    const info = await ctx.router.page(ctx, {
      ...args,
      ...options(args),
      command: "elementInfo",
    });
    requireValue(
      info.length === 1,
      "INVALID_TARGET",
      "No element exists at these coordinates.",
    );
    return ctx.router.screenshot(ctx, { clip: info[0].boundingBox });
  },
  { needsTab: true },
);
route(
  "viewport.set",
  async (ctx, args) => {
    const input = options(args);
    requireValue(
      Number.isInteger(input.width) &&
        input.width > 0 &&
        Number.isInteger(input.height) &&
        input.height > 0 &&
        input.width <= 16384 &&
        input.height <= 16384,
    );
    await ctx.router.resolveTab(ctx, input.tabId);
    await ctx.router.send(ctx, "Emulation.setDeviceMetricsOverride", {
      width: input.width,
      height: input.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    ctx.lease.viewports.add(nativeId(ctx.target.tabId));
    return ctx.router.actionResult(ctx);
  },
  { mutating: true },
);
route(
  "viewport.reset",
  async (ctx, args) => {
    await ctx.router.resolveTab(ctx, args.tabId);
    await ctx.router.send(ctx, "Emulation.clearDeviceMetricsOverride", {});
    ctx.lease.viewports.delete(nativeId(ctx.target.tabId));
    return ctx.router.actionResult(ctx);
  },
  { mutating: true },
);
route(
  "tab.setViewport",
  (ctx, args) => routes["viewport.set"].handle(ctx, { options: args.size }),
  { needsTab: true, mutating: true },
);
route("tab.resetViewport", (ctx) => routes["viewport.reset"].handle(ctx, {}), {
  needsTab: true,
  mutating: true,
});

const buttons = {
  left: "left",
  right: "right",
  middle: "middle",
  1: "left",
  2: "middle",
  3: "right",
  4: "back",
  5: "forward",
};
const modifierMask = (keys = []) =>
  keys.reduce(
    (mask, key) =>
      mask |
      ({
        Alt: 1,
        Control: 2,
        Meta: 4,
        Shift: 8,
        ControlOrMeta: /Mac/.test(globalThis.navigator?.platform ?? "") ? 4 : 2,
      }[key] ?? 0),
    0,
  );
async function point(ctx, args) {
  requireValue(Number.isFinite(args.x) && Number.isFinite(args.y));
  return { x: args.x, y: args.y };
}
async function click(ctx, args, double = false) {
  const p = await point(ctx, args),
    button = buttons[args.button ?? "left"];
  requireValue(button);
  const count = double ? 2 : (args.clickCount ?? 1);
  requireValue(Number.isInteger(count) && count >= 1 && count <= 3);
  await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...p,
    button: "none",
  });
  for (let i = 1; i <= count; i++) {
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...p,
      button,
      clickCount: i,
      modifiers: modifierMask(args.modifiers ?? args.keypress),
    });
    if (args.duration > 0) await ctx.router.delay(ctx, args.duration * 1000);
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...p,
      button,
      clickCount: i,
      modifiers: modifierMask(args.modifiers ?? args.keypress),
    });
  }
  return null;
}
route("cua.click", (ctx, args) => click(ctx, options(args)), {
  needsTab: true,
  mutating: true,
});
route("cua.doubleClick", (ctx, args) => click(ctx, options(args), true), {
  needsTab: true,
  mutating: true,
});
route(
  "cua.move",
  async (ctx, args) => {
    const input = options(args);
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...(await point(ctx, input)),
      modifiers: modifierMask(input.keys),
    });
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "cua.scroll",
  async (ctx, args) => {
    const input = options(args);
    requireValue(
      Number.isFinite(input.scrollX) && Number.isFinite(input.scrollY),
    );
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...(await point(ctx, input)),
      deltaX: input.scrollX,
      deltaY: input.scrollY,
      modifiers: modifierMask(input.keypress),
    });
    return null;
  },
  { needsTab: true, mutating: true },
);
aliases(
  ["cua.type", "dom.type"],
  async (ctx, args) => {
    stringData(options(args).text);
    await ctx.router.send(ctx, "Input.insertText", {
      text: options(args).text,
    });
    return null;
  },
  { needsTab: true, mutating: true },
);
aliases(
  ["cua.keypress", "dom.keypress"],
  async (ctx, args) => {
    await pressKeys(ctx, options(args).keys, options(args).duration ?? 0);
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.keyboardDown",
  async (ctx, args) => {
    await keyDown(ctx, args.key);
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.keyboardUp",
  async (ctx, args) => {
    await keyUp(ctx, args.key);
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.press",
  async (ctx, args) => {
    await pressKeys(ctx, chord(args.key, options(args).modifiers));
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "locator.press",
  async (ctx, args) => {
    await ctx.router.page(ctx, { ...args, command: "focus" });
    await pressKeys(ctx, chord(args.value, options(args).modifiers));
    return null;
  },
  { needsTab: true, mutating: true },
);
for (const method of ["locator.type", "locator.pressSequentially"])
  route(
    method,
    async (ctx, args) => {
      stringData(args.value);
      const delayMs = options(args).delayMs ?? 0;
      requireValue(Number.isFinite(delayMs) && delayMs >= 0);
      await ctx.router.page(ctx, { ...args, command: "focus" });
      for (const character of args.value) {
        await pressKeys(ctx, [character]);
        if (delayMs > 0) await ctx.router.delay(ctx, delayMs);
      }
      return null;
    },
    { needsTab: true, mutating: true },
  );
route(
  "cua.drag",
  async (ctx, args) => {
    const input = options(args);
    requireValue(
      Array.isArray(input.path) &&
        input.path.length >= 2 &&
        input.path.length <= 1000,
    );
    const first = await point(ctx, input.path[0]);
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...first,
    });
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...first,
      button: "left",
      clickCount: 1,
    });
    for (const p of input.path.slice(1))
      await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...(await point(ctx, p)),
        button: "left",
        buttons: 1,
        modifiers: modifierMask(input.keys),
      });
    const last = input.path.at(-1);
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...last,
      button: "left",
      clickCount: 1,
    });
    return null;
  },
  { needsTab: true, mutating: true },
);
async function locatorClick(ctx, args, double = false) {
  const found = await ctx.router.page(ctx, {
    ...args,
    ...options(args),
    command: "resolve",
  });
  const r = found.rect,
    position = options(args).position;
  const x = r.x + (position?.x ?? r.width / 2),
    y = r.y + (position?.y ?? r.height / 2);
  requireValue(
    x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height,
  );
  return click(ctx, { ...options(args), x, y }, double);
}
route("locator.click", (ctx, args) => locatorClick(ctx, args), {
  needsTab: true,
  mutating: true,
});
route("locator.dblclick", (ctx, args) => locatorClick(ctx, args, true), {
  needsTab: true,
  mutating: true,
});
aliases(
  ["tab.click", "frame.click", "dom.click", "dom.doubleClick"],
  async (ctx, args) => {
    await locatorClick(
      ctx,
      { ...args, ref: args.ref ?? options(args).node_id },
      ctx.method === "dom.doubleClick",
    );
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
route(
  "tab.hover",
  async (ctx, args) => {
    const node = await ctx.router.page(ctx, {
      ...args,
      ...options(args),
      command: "resolve",
    });
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: node.rect.x + node.rect.width / 2,
      y: node.rect.y + node.rect.height / 2,
    });
    return ctx.router.actionResult(ctx);
  },
  { needsTab: true, mutating: true },
);
for (const [method, desired] of [
  ["check", true],
  ["uncheck", false],
  ["setChecked", null],
])
  route(
    `locator.${method}`,
    async (ctx, args) => {
      const wanted = desired ?? args.checked;
      requireValue(typeof wanted === "boolean");
      if (
        (await ctx.router.page(ctx, { ...args, command: "checked" })) !== wanted
      )
        await locatorClick(ctx, args);
      requireValue(
        (await ctx.router.page(ctx, { ...args, command: "checked" })) ===
          wanted,
        "INVALID_TARGET",
        "The requested checked state was not observed.",
      );
      return null;
    },
    { needsTab: true, mutating: true },
  );
route("tab.markHandoff", (ctx) => ctx.router.releaseTab(ctx), {
  needsTab: true,
  mutating: true,
});
route("tab.markDeliverable", (ctx) => ctx.router.markDeliverable(ctx), {
  needsTab: true,
});
route("tab.getJsDialog", async (ctx) => ctx.router.dialog(ctx), {
  needsTab: true,
});
route(
  "dialogs.accept",
  async (ctx, args) => ctx.router.handleDialog(ctx, true, args),
  { needsTab: true, mutating: true },
);
route(
  "dialogs.dismiss",
  async (ctx, args) => ctx.router.handleDialog(ctx, false, args),
  { needsTab: true, mutating: true },
);
route(
  "dev.logs",
  async (ctx, args) => {
    await ctx.router.send(ctx, "Runtime.enable", {});
    return ctx.router.logs(ctx, options(args));
  },
  {
    needsTab: true,
  },
);

route("waiters.arm", (ctx, args) => ctx.router.armWaiter(ctx, args), {
  needsTab: true,
});
route("waiters.get", (ctx, args) => ctx.router.getWaiter(ctx, args.id), {
  needsTab: true,
});
route("waiters.cancel", (ctx, args) => ctx.router.cancelWaiter(ctx, args.id), {
  needsTab: true,
});
route("tab.downloads", (ctx) => ctx.router.downloads(ctx), { needsTab: true });
route(
  "downloads.path",
  (ctx, args) => ctx.router.downloadPath(ctx, args.downloadId),
  { needsTab: true },
);
route("ax.snapshot", (ctx) => ctx.router.axSnapshot(ctx), { needsTab: true });
route(
  "ax.get",
  async (ctx, args) => {
    const mode = args.mode ?? "state";
    requireValue(["state", "screenshot", "both"].includes(mode));
    if (mode === "screenshot") return ctx.router.screenshot(ctx, {});
    const snapshot = await ctx.router.axSnapshot(ctx);
    const state =
      snapshot.nodes
        .map(
          (node) =>
            `[${node.index}] ${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ""}${ctx.lease.axReferences.get(node.index).actions.length ? ` (actions: ${ctx.lease.axReferences.get(node.index).actions.join(", ")})` : ""}`,
        )
        .join("\n") + (snapshot.truncated ? "\n[truncated]" : "");
    return mode === "both"
      ? { state, screenshot: await ctx.router.screenshot(ctx, {}) }
      : state;
  },
  { needsTab: true },
);
route(
  "ax.click",
  async (ctx, args) => {
    const p = await ctx.router.axPoint(ctx, args.element),
      input = options(args);
    const duration = input.duration ?? 0;
    requireValue(Number.isFinite(duration) && duration >= 0 && duration <= 30);
    const keys = input.key ? chord(input.key) : [];
    const acquired = [];
    let failure;
    try {
      keys.forEach(keyDescription);
      for (const key of keys) {
        const description = keyDescription(key);
        if (!ctx.router.heldKey(ctx, description)) acquired.push(description);
        await keyDown(ctx, key);
      }
      await click(ctx, {
        ...p,
        button:
          { l: "left", r: "right", m: "middle" }[input.mouseButton] ??
          input.mouseButton,
        clickCount: input.clickCount,
        duration,
        modifiers: keys,
      });
    } catch (cause) {
      failure = cause;
    }
    for (const key of acquired.reverse())
      try {
        await ctx.router.releaseKey(ctx, key);
      } catch {
        failure ??= new BrowserActionError(
          "CDP_DISCONNECTED",
          "The native key cleanup is not confirmed.",
          { dispatched: true, effect: "unknown" },
        );
      }
    if (failure) throw failure;
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "ax.drag",
  (ctx, args) =>
    routes["cua.drag"].handle(ctx, { options: { path: [args.from, args.to] } }),
  { needsTab: true, mutating: true },
);
route(
  "ax.scroll",
  async (ctx, args) => {
    const p = await ctx.router.axPoint(ctx, args.element),
      direction = {
        up: [0, -1],
        u: [0, -1],
        down: [0, 1],
        d: [0, 1],
        left: [-1, 0],
        l: [-1, 0],
        right: [1, 0],
        r: [1, 0],
      }[args.direction],
      pages = args.pages ?? 1;
    requireValue(
      direction && Number.isFinite(pages) && pages > 0 && pages <= 1000,
    );
    const layout = await ctx.router.send(ctx, "Page.getLayoutMetrics", {}),
      viewport = layout.cssVisualViewport ?? layout.visualViewport;
    const width = viewport?.clientWidth ?? viewport?.width,
      height = viewport?.clientHeight ?? viewport?.height;
    requireValue(Number.isFinite(width) && Number.isFinite(height));
    await ctx.router.send(ctx, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...p,
      deltaX: direction[0] * pages * width,
      deltaY: direction[1] * pages * height,
    });
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "ax.pressKey",
  async (ctx, args) => {
    if (args.elementIndex !== null)
      await ctx.router.axFocus(ctx, args.elementIndex);
    await pressKeys(ctx, chord(args.key), options(args).duration ?? 0);
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "ax.typeText",
  async (ctx, args) => {
    stringData(args.text);
    if (args.elementIndex !== null)
      await ctx.router.axFocus(ctx, args.elementIndex);
    await ctx.router.send(ctx, "Input.insertText", { text: args.text });
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "ax.setValue",
  async (ctx, args) => {
    stringData(args.value);
    return ctx.router.axNodeCommand(ctx, args.elementIndex, {
      command: "setValue",
      value: args.value,
    });
  },
  { needsTab: true, mutating: true },
);
route(
  "ax.selectText",
  async (ctx, args) => {
    text(args.text, 65536);
    const input = options(args);
    requireValue(
      ["text", "cursor_before", "cursor_after"].includes(
        input.selectionType ?? "text",
      ),
    );
    await ctx.router.axNodeCommand(ctx, args.elementIndex, {
      command: "selectText",
      text: args.text,
      ...fields(input, ["prefix", "suffix", "selectionType"]),
    });
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "ax.performSecondaryAction",
  (ctx, args) => ctx.router.axSecondary(ctx, args.elementIndex, args.action),
  { needsTab: true, mutating: true },
);
route(
  "ax.paste",
  async (ctx, args) => {
    stringData(args.text);
    const format = options(args).format ?? "text";
    requireValue(["text", "html", "md"].includes(format));
    requireValue(
      format !== "md" || typeof args.html === "string",
      "CAPABILITY_NOT_ALLOWED",
      "Markdown paste requires the approved Markdown rendering adapter.",
    );
    if (args.elementIndex !== null)
      await ctx.router.axFocus(ctx, args.elementIndex);
    const entries =
      format === "text"
        ? [{ mimeType: "text/plain", text: args.text }]
        : [
            {
              mimeType: "text/html",
              text: format === "md" ? args.html : args.text,
            },
            ...(format === "md"
              ? [{ mimeType: "text/plain", text: args.text }]
              : []),
          ];
    await writeClipboard(ctx, [{ entries }]);
    await pressKeys(ctx, ["ControlOrMeta", "v"], 0, ["Paste"]);
    return null;
  },
  { needsTab: true, mutating: true },
);
route(
  "webmcp.listTools",
  async (ctx) => (await ctx.router.webMcpSnapshot(ctx)).tools,
  { needsTab: true },
);
route("webmcp.fetchTools", (ctx) => ctx.router.webMcpSnapshot(ctx), {
  needsTab: true,
});
route("webmcp.invokeTool", (ctx, args) => ctx.router.webMcpInvoke(ctx, args), {
  needsTab: true,
  mutating: true,
});
route("tab.setFiles", (ctx, args) => ctx.router.setFiles(ctx, args), {
  needsTab: true,
  mutating: true,
});
route("fileChoosers.setFiles", (ctx, args) => ctx.router.setFiles(ctx, args), {
  needsTab: true,
  mutating: true,
});
route("tab.resumeUserControl", (ctx) => ctx.router.resumeUserControl(ctx), {
  needsTab: true,
});
route("pageAssets.list", (ctx) => listAssets(ctx), { needsTab: true });
route(
  "tabs.createTemporary",
  (ctx, args) => ctx.router.createTemporary(ctx, args),
  { mutating: true },
);
route(
  "tabs.closeTemporary",
  (ctx, args) => ctx.router.closeTemporary(ctx.lease, nativeId(args.id)),
  {},
);
route("pageAssets.plan", (ctx, args) => planAssets(ctx, args), {
  needsTab: true,
});
route("pageAssets.download", (ctx, args) => downloadAssets(ctx, args.urls), {
  needsTab: true,
});
route("pageAssets.bundle", (ctx, args) => bundleAssets(ctx, args), {
  needsTab: true,
});
route("content.plan", (ctx, args) => planContent(ctx, args), {
  needsTab: true,
});
route("content.export", (ctx, args) => exportContent(ctx, args), {
  needsTab: true,
});
route("tab.exportFile", (ctx, args) => exportContent(ctx, args), {
  needsTab: true,
});
for (const method of [
  "content.exportGsuite",
  "content.exportYouTubeTranscript",
  "cua.downloadMedia",
  "dom.downloadMedia",
  "locator.downloadMedia",
])
  route(method, (ctx, args) => exportContent(ctx, args), { needsTab: true });
for (const level of ["browser", "tab"]) {
  route(
    `capabilities.${level}List`,
    (ctx) => ctx.router.capabilities(ctx, level),
    { needsTab: level === "tab" },
  );
  route(
    `capabilities.${level}Get`,
    async (ctx, args) => {
      const infos = await ctx.router.capabilities(ctx, level, args.id);
      requireValue(
        infos.length === 1,
        "CAPABILITY_NOT_ALLOWED",
        "This browser capability is not defined.",
      );
      return infos[0];
    },
    { needsTab: level === "tab" },
  );
}
export const routeDefinitions = Object.freeze(Object.values(routes));

export function createBrowserRouter(
  chrome,
  { emit = () => {}, clock = now, persistOwned = async () => {}, visual } = {},
) {
  let binding,
    started = false,
    stopped = false,
    disposing,
    journalTail = Promise.resolve();
  const versions = new Map(),
    documents = new Map(),
    leases = new Map(),
    closedLeases = new Map(),
    owners = new Map(),
    queues = new Map(),
    listeners = [];
  const leaseOpenFailures = new WeakMap();
  const eventBuffer = [],
    logs = [],
    dialogs = new Map(),
    children = new Map(),
    executionContexts = new Map(),
    auditEntries = [],
    waiters = new Map(),
    downloadRecords = new Map(),
    webMcpPending = new Map(),
    webMcpEarly = new Map();
  let eventSequence = 0,
    eventBytes = 0,
    eventTruncated = false,
    dialogSequence = 0,
    auditSequence = 0;
  const target = (tabId, lease) => ({
    ...fields(binding ?? {}, targetFields),
    ...(tabId === undefined
      ? {}
      : {
          tabId: String(tabId),
          pageVersion: version(tabId),
          ...(lease?.epochs?.has(Number(tabId))
            ? { controlEpoch: lease.epochs.get(Number(tabId)) }
            : {}),
        }),
  });
  const version = (id) => versions.get(String(id)) ?? 1;
  const on = (event, fn) => {
    if (!event?.addListener) return;
    event.addListener(fn);
    listeners.push(() => event.removeListener(fn));
  };
  const verifyTarget = (value) => {
    record(value);
    requireValue(
      binding && targetFields.every((key) => value[key] === binding[key]),
      "STALE_REF",
      "The target belongs to another browser connection.",
    );
    if (value.tabId !== undefined) nativeId(value.tabId);
    if (value.controlEpoch !== undefined) {
      text(value.controlEpoch, 256);
      requireValue(
        !/[\r\n]/.test(value.controlEpoch),
        "INVALID_TARGET",
        "A control epoch must be opaque single-line identity text.",
      );
    }
  };
  const active = (lease) => {
    requireValue(
      lease && !lease.ended && !stopped,
      "INVALID_TARGET",
      "The control lease is no longer active.",
    );
    requireValue(
      !lease.revoked,
      "USER_TAKEOVER",
      "The user ended this run's browser control.",
    );
  };
  const canClaim = (lease, id) => {
    active(lease);
    requireValue(
      !lease.closedTabs?.has(id),
      "INVALID_TARGET",
      "This native tab was already closed by this run.",
    );
    requireValue(
      !lease.handedOff.has(id),
      "INVALID_TARGET",
      "This run already handed this target back to the user.",
    );
    requireValue(
      !owners.has(id) || owners.get(id) === lease.id,
      "TAB_ALREADY_CLAIMED",
      "Another run controls this tab.",
    );
  };
  const claim = (lease, id) => {
    canClaim(lease, id);
    owners.set(id, lease.id);
    lease.tabs.add(id);
  };
  const appendEvent = (source, method, params) => {
    if (!binding) return;
    const event = {
      method,
      params,
      sequence: ++eventSequence,
      source: {
        ...target(source.tabId, leases.get(owners.get(source.tabId))),
        ...(source.sessionId
          ? {
              sessionId: source.sessionId,
              targetId: children.get(source.sessionId)?.targetId,
            }
          : {}),
      },
    };
    const size = encoder.encode(JSON.stringify(event)).byteLength;
    if (size > maxEventBytes) {
      eventTruncated = true;
      return;
    }
    eventBuffer.push({ event, size });
    eventBytes += size;
    while (eventBuffer.length > 1000 || eventBytes > maxEventBytes) {
      eventBytes -= eventBuffer.shift().size;
      eventTruncated = true;
    }
    emit({ type: "event", event: "cdp", value: event });
  };
  const settleWaiter = (waiter, value, cause) => {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    if (cause) {
      waiter.error = cause;
      waiter.reject(cause);
    } else {
      waiter.value = value;
      waiter.resolve(value);
    }
    if (waiter.event === "filechooser") {
      const lease = leases.get(waiter.leaseId);
      if (lease) void syncChooserIntercept(lease, waiter.tabId).catch(() => {});
    }
  };
  const syncChooserIntercept = (lease, tabId) => {
    const queues = (lease.chooserSync ??= new Map()),
      before = queues.get(tabId) ?? Promise.resolve();
    const task = before
      .catch(() => {})
      .then(async () => {
        if (owners.get(tabId) !== lease.id || !lease.attached.has(tabId))
          return;
        const wanted =
          !lease.ended &&
          !lease.revoked &&
          [...waiters.values()].some(
            (waiter) =>
              waiter.leaseId === lease.id &&
              waiter.tabId === tabId &&
              waiter.event === "filechooser" &&
              !waiter.settled,
          );
        if (wanted === lease.fileChoosers.has(tabId)) return;
        await chrome.debugger.sendCommand(
          { tabId },
          "Page.setInterceptFileChooserDialog",
          { enabled: wanted },
        );
        if (wanted) lease.fileChoosers.add(tabId);
        else lease.fileChoosers.delete(tabId);
      });
    queues.set(tabId, task);
    lease.pending.set(task, {
      tabId: String(tabId),
      actionId: `chooser_cleanup_${crypto.randomUUID()}`,
    });
    void task
      .finally(() => {
        lease.pending.delete(task);
        if (queues.get(tabId) === task) queues.delete(tabId);
      })
      .catch(() => {});
    return task;
  };
  const cancelWaiter = (waiter) => {
    if (!waiter.settled)
      settleWaiter(
        waiter,
        undefined,
        new BrowserActionError(
          "WAITER_GONE",
          "The browser event waiter was cancelled.",
        ),
      );
    waiter.cancelled = true;
  };
  const finishNavigation = (details, stage) => {
    if (details.frameId !== 0) return;
    for (const waiter of waiters.values())
      if (
        !waiter.settled &&
        waiter.event === "navigation" &&
        waiter.tabId === details.tabId &&
        waiter.waitUntil === stage &&
        (!waiter.url || waiter.url === details.url)
      )
        settleWaiter(waiter, {
          type: "navigation",
          target: target(String(details.tabId), leases.get(waiter.leaseId)),
          url: details.url,
          pageVersion: version(details.tabId),
        });
  };
  const ownedSnapshot = () =>
    [...leases.values()].flatMap((lease) =>
      [
        ...new Set([
          ...lease.intents,
          ...(lease.temporaryTabs ?? []),
          ...[...(lease.clipboardStages?.values() ?? [])].map((stage) =>
            nativeId(stage.tabId),
          ),
        ]),
      ].map((tabId) => ({
        ...lease.metadata,
        tabId,
        keys: [...(lease.keys.get(tabId)?.values() ?? [])],
        buttons: [...(lease.buttons.get(tabId)?.values() ?? [])],
        viewport: lease.viewports.has(tabId),
        externallyDetached: lease.externallyDetached.has(tabId),
        streams: [...(lease.nativeStreams?.get(tabId) ?? [])],
        temporary: lease.temporaryTabs?.has(tabId) ?? false,
        attachmentIntent: lease.intents.has(tabId),
        clipboardStages: [...(lease.clipboardStages?.entries() ?? [])]
          .filter(([, stage]) => nativeId(stage.tabId) === tabId)
          .map(([token, stage]) => ({
            token,
            pageVersion: stage.pageVersion,
            kind: stage.kind ?? "clipboard",
          })),
      })),
    );
  const persist = () => {
    const task = journalTail.then(async () => {
      const records = ownedSnapshot();
      requireValue(
        records.length <= 10000 &&
          encoder.encode(JSON.stringify(records)).byteLength <= 4 * 1024 * 1024,
        "QUEUE_FULL",
        "The native attachment journal reached its bounded capacity.",
      );
      await persistOwned(records);
    });
    journalTail = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  const closeStream = async (tabId, handle) => {
    try {
      await chrome.debugger.sendCommand({ tabId }, "IO.close", { handle });
    } catch (cause) {
      if (!/Invalid stream handle/i.test(String(cause?.message ?? "")))
        throw cause;
    }
  };
  const releaseControl = async (lease, tabId, { detach = true } = {}) => {
    if (!lease.attached.has(tabId) && !lease.intents.has(tabId)) return;
    for (const waiter of waiters.values())
      if (waiter.leaseId === lease.id && waiter.tabId === tabId)
        cancelWaiter(waiter);
    if (!lease.attached.has(tabId) && !lease.externallyDetached.has(tabId)) {
      const targets = await chrome.debugger.getTargets();
      if (!targets.some((item) => item.tabId === tabId && item.attached))
        lease.externallyDetached.add(tabId);
    }
    if (lease.externallyDetached.has(tabId)) {
      if (
        lease.keys.get(tabId)?.size ||
        lease.buttons.get(tabId)?.size ||
        lease.viewports.has(tabId) ||
        lease.nativeStreams?.get(tabId)?.size
      )
        lease.unconfirmedControls = true;
    } else {
      for (const handle of lease.nativeStreams?.get(tabId) ?? [])
        await closeStream(tabId, handle);
      if (lease.fileChoosers.has(tabId)) {
        await chrome.debugger.sendCommand(
          { tabId },
          "Page.setInterceptFileChooserDialog",
          { enabled: false },
        );
        lease.fileChoosers.delete(tabId);
      }
      for (const entry of lease.buttons.get(tabId)?.values() ?? [])
        await chrome.debugger.sendCommand(
          entry.source,
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", ...entry.params, clickCount: 1 },
        );
      for (const entry of lease.keys.get(tabId)?.values() ?? [])
        await chrome.debugger.sendCommand(
          entry.source,
          "Input.dispatchKeyEvent",
          { type: "keyUp", ...entry.params, modifiers: 0 },
        );
      if (lease.viewports.has(tabId))
        await chrome.debugger.sendCommand(
          { tabId },
          "Emulation.clearDeviceMetricsOverride",
          {},
        );
      if (!detach) {
        // Confirm effects while the actual page channel still exists. Do not claim target
        // destruction released a key, viewport or stream that never received native cleanup.
        lease.buttons.delete(tabId);
        lease.keys.delete(tabId);
        lease.viewports.delete(tabId);
        lease.nativeStreams?.delete(tabId);
        await persist();
        return;
      }
      lease.detaching.add(tabId);
      try {
        await chrome.debugger.detach({ tabId });
      } catch (cause) {
        const targets = await chrome.debugger.getTargets();
        requireValue(
          !targets.some((target) => target.tabId === tabId && target.attached),
          "CDP_DISCONNECTED",
          "The native attachment cleanup is not confirmed.",
        );
      } finally {
        lease.detaching.delete(tabId);
      }
    }
    lease.attached.delete(tabId);
    lease.intents.delete(tabId);
    lease.buttons.delete(tabId);
    lease.keys.delete(tabId);
    lease.viewports.delete(tabId);
    lease.fileChoosers.delete(tabId);
    for (const [index, ref] of lease.axReferences ?? [])
      if (Number(ref.tabId) === tabId) lease.axReferences.delete(index);
    lease.webMcpStates?.delete(tabId);
    lease.frameTargets?.delete(tabId);
    lease.frameParents?.delete(tabId);
    lease.nativeStreams?.delete(tabId);
    for (const [key, context] of executionContexts)
      if (context.tabId === tabId) executionContexts.delete(key);
    for (const child of children.values())
      if (child.tabId === tabId) child.active = false;
    await persist();
  };
  const router = {
    followSessionTab: true,
    target,
    version,
    claim,
    canClaim,
    start() {
      requireValue(
        !stopped,
        "INVALID_TARGET",
        "A stopped router cannot start.",
      );
      if (started) return;
      started = true;
      on(chrome.webNavigation?.onCommitted, (details) => {
        if (details.frameId !== 0) return;
        const id = String(details.tabId);
        if (documents.get(id) !== details.documentId || !details.documentId) {
          documents.set(id, details.documentId);
          versions.set(id, version(id) + 1);
          dialogs.delete(id);
        }
        finishNavigation(details, "commit");
        emit({
          type: "event",
          event: "navigation",
          target: target(id),
          value: { url: details.url, pageVersion: version(id) },
        });
      });
      on(chrome.webNavigation?.onDOMContentLoaded, (details) =>
        finishNavigation(details, "domcontentloaded"),
      );
      on(chrome.webNavigation?.onCompleted, (details) =>
        finishNavigation(details, "load"),
      );
      on(chrome.tabs.onRemoved, (id) => {
        versions.set(String(id), version(id) + 1);
        dialogs.delete(String(id));
        emit({
          type: "event",
          event: "tab_closed",
          target: target(String(id)),
        });
        emit({ type: "tabs_changed" });
      });
      on(chrome.tabs.onUpdated, (id, change) => {
        if (!chrome.webNavigation?.onCommitted && change.status === "loading")
          versions.set(String(id), version(id) + 1);
        emit({ type: "tabs_changed" });
      });
      on(chrome.tabs.onCreated, () => emit({ type: "tabs_changed" }));
      on(chrome.tabs.onActivated, () => emit({ type: "tabs_changed" }));
      on(chrome.debugger?.onEvent, (source, method, params) => {
        const owner = owners.get(source.tabId),
          lease = owner && leases.get(owner);
        if (!lease?.attached.has(source.tabId)) return;
        if (method === "Runtime.executionContextCreated") {
          const context = params.context;
          executionContexts.set(
            `${source.tabId}:${source.sessionId ?? ""}:${context.id}`,
            {
              tabId: source.tabId,
              sessionId: source.sessionId,
              ...fields(context, [
                "id",
                "uniqueId",
                "origin",
                "name",
                "auxData",
              ]),
            },
          );
          if (executionContexts.size > 1024)
            executionContexts.delete(executionContexts.keys().next().value);
        }
        if (method === "Runtime.executionContextDestroyed")
          executionContexts.delete(
            `${source.tabId}:${source.sessionId ?? ""}:${params.executionContextId}`,
          );
        if (method === "Runtime.executionContextsCleared")
          for (const [key, context] of executionContexts)
            if (
              context.tabId === source.tabId &&
              context.sessionId === source.sessionId
            )
              executionContexts.delete(key);
        if (
          !source.sessionId &&
          ["WebMCP.toolsAdded", "WebMCP.toolsRemoved"].includes(method)
        ) {
          const state = lease.webMcpStates?.get(source.tabId);
          if (state && state.pageVersion === version(source.tabId))
            try {
              requireValue(
                Array.isArray(params.tools) && params.tools.length <= 256,
                "OUTPUT_TOO_LARGE",
                "The WebMCP registration event exceeds its tool budget.",
              );
              let changed = false;
              for (const tool of params.tools) {
                requireValue(
                  typeof tool.toolId === "string",
                  "CAPABILITY_NOT_ALLOWED",
                  "This browser's native WebMCP protocol has no opaque registration IDs; invoking a tool by name cannot preserve the observed registration.",
                );
                text(tool.toolId, 512);
                if (method === "WebMCP.toolsRemoved")
                  changed = state.tools.delete(tool.toolId) || changed;
                else {
                  text(tool.name, 256);
                  stringData(tool.description, 8192);
                  text(tool.frameId, 512);
                  record(tool.inputSchema ?? {});
                  requireValue(
                    state.tools.has(tool.toolId) || state.tools.size < 256,
                    "OUTPUT_TOO_LARGE",
                    "The WebMCP registry exceeds its tool budget.",
                  );
                  const descriptor = {
                    ...fields(tool, [
                      "toolId",
                      "name",
                      "description",
                      "frameId",
                      "inputSchema",
                      "annotations",
                    ]),
                  };
                  changed ||= !sameData(
                    state.tools.get(tool.toolId),
                    descriptor,
                  );
                  state.tools.set(tool.toolId, descriptor);
                }
              }
              requireValue(
                encoder.encode(JSON.stringify([...state.tools.values()]))
                  .byteLength <=
                  1024 * 1024,
                "OUTPUT_TOO_LARGE",
                "The WebMCP registry exceeds its metadata budget.",
              );
              if (changed) {
                state.registrationRevision = crypto.randomUUID();
                state.snapshot = undefined;
              }
            } catch (cause) {
              state.error = cause;
            }
        }
        if (!source.sessionId && method === "WebMCP.toolResponded") {
          const pending = webMcpPending.get(params.invocationId);
          if (
            pending &&
            pending.leaseId === lease.id &&
            pending.tabId === source.tabId
          )
            pending.resolve(params);
          else if (
            typeof params.invocationId === "string" &&
            params.invocationId.length <= 512 &&
            encoder.encode(JSON.stringify(params)).byteLength <= 1024 * 1024
          ) {
            webMcpEarly.set(params.invocationId, {
              leaseId: lease.id,
              tabId: source.tabId,
              params,
              expiresAt: clock() + 5000,
            });
            while (webMcpEarly.size > 32)
              webMcpEarly.delete(webMcpEarly.keys().next().value);
          }
        }
        if (method === "Target.attachedToTarget") {
          const child = {
            tabId: source.tabId,
            targetId: params.targetInfo?.targetId,
            leaseId: lease.id,
            active: true,
          };
          children.set(params.sessionId, child);
          if (
            params.targetInfo?.type === "iframe" &&
            !lease.ended &&
            !lease.revoked
          ) {
            child.ready = chrome.debugger.sendCommand(
              { tabId: source.tabId, sessionId: params.sessionId },
              "Target.setAutoAttach",
              {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: true,
                filter: [{ type: "iframe", exclude: false }, { exclude: true }],
              },
            );
            void child.ready.catch(() => {});
          }
        }
        if (
          method === "Target.detachedFromTarget" &&
          children.has(params.sessionId)
        )
          children.get(params.sessionId).active = false;
        if (method === "Page.javascriptDialogOpening")
          dialogs.set(String(source.tabId), {
            id: `dialog_${++dialogSequence}`,
            type: params.type,
            message: params.message,
            pageVersion: version(source.tabId),
            controlEpoch: lease.epochs?.get(source.tabId),
          });
        if (method === "Page.javascriptDialogClosed")
          dialogs.delete(String(source.tabId));
        if (method === "Page.downloadWillBegin") {
          const value = {
            id: params.guid,
            leaseId: lease.id,
            runId: lease.runId,
            target: target(String(source.tabId), lease),
            url: params.url,
            suggestedFilename: params.suggestedFilename,
            startedAt: clock(),
            state: "in_progress",
            bytesReceived: 0,
          };
          downloadRecords.set(value.id, value);
          while (downloadRecords.size > 1024)
            downloadRecords.delete(downloadRecords.keys().next().value);
          for (const waiter of waiters.values())
            if (
              !waiter.settled &&
              waiter.event === "download" &&
              waiter.leaseId === lease.id &&
              waiter.tabId === source.tabId
            )
              settleWaiter(waiter, {
                type: "download",
                target: value.target,
                downloadId: value.id,
                suggestedFilename: value.suggestedFilename,
              });
        }
        if (method === "Page.downloadProgress") {
          const value = downloadRecords.get(params.guid);
          if (value && value.leaseId === lease.id) {
            value.state =
              params.state === "completed"
                ? "complete"
                : params.state === "canceled"
                  ? "cancelled"
                  : "in_progress";
            value.bytesReceived = params.receivedBytes;
            value.totalBytes = params.totalBytes;
          }
        }
        if (method === "Page.fileChooserOpened") {
          const chooserId = `chooser_${crypto.randomUUID()}`,
            pageVersion = version(source.tabId);
          lease.choosers.set(chooserId, {
            id: chooserId,
            tabId: source.tabId,
            pageVersion,
            backendNodeId: params.backendNodeId,
            controlEpoch: lease.epochs?.get(source.tabId),
            multiple: params.mode === "selectMultiple",
          });
          while (lease.choosers.size > 32)
            lease.choosers.delete(lease.choosers.keys().next().value);
          for (const waiter of waiters.values())
            if (
              !waiter.settled &&
              waiter.event === "filechooser" &&
              waiter.leaseId === lease.id &&
              waiter.tabId === source.tabId
            )
              settleWaiter(waiter, {
                type: "filechooser",
                target: target(String(source.tabId), lease),
                chooserId,
                pageVersion,
                multiple: params.mode === "selectMultiple",
              });
        }
        if (method === "Page.lifecycleEvent" && params.name === "networkIdle")
          for (const waiter of waiters.values())
            if (
              !waiter.settled &&
              waiter.event === "navigation" &&
              waiter.waitUntil === "networkidle" &&
              waiter.leaseId === lease.id &&
              waiter.frameId === params.frameId
            ) {
              void chrome.tabs
                .get(source.tabId)
                .then((tab) => {
                  if (!waiter.url || waiter.url === tab.url)
                    settleWaiter(waiter, {
                      type: "navigation",
                      target: target(String(source.tabId), lease),
                      url: tab.url,
                      pageVersion: version(source.tabId),
                    });
                })
                .catch((cause) => settleWaiter(waiter, undefined, cause));
            }
        if (method === "Runtime.consoleAPICalled") {
          const message = (params.args ?? [])
            .map((arg) =>
              typeof arg.value === "string"
                ? arg.value
                : (arg.description ?? ""),
            )
            .join(" ")
            .slice(0, 16384);
          logs.push({
            tabId: source.tabId,
            level:
              params.type === "warning"
                ? "warn"
                : ["debug", "info", "warn", "error"].includes(params.type)
                  ? params.type
                  : "log",
            message,
            timestamp: new Date(
              Number.isFinite(params.timestamp) ? params.timestamp : clock(),
            ).toISOString(),
          });
          while (
            logs.length > 1000 ||
            encoder.encode(JSON.stringify(logs)).byteLength > maxEventBytes
          )
            logs.shift();
        }
        appendEvent(source, method, params);
      });
      on(chrome.debugger?.onDetach, (source, reason) => {
        const lease = leases.get(owners.get(source.tabId));
        if (!lease) return;
        lease.attached.delete(source.tabId);
        if (!lease.detaching.has(source.tabId)) {
          lease.externallyDetached.add(source.tabId);
          if (
            lease.keys.get(source.tabId)?.size ||
            lease.buttons.get(source.tabId)?.size ||
            lease.viewports.has(source.tabId)
          )
            lease.unconfirmedControls = true;
          void persist().catch(() => {});
        }
        if (
          !lease.ended &&
          !lease.detaching.has(source.tabId) &&
          !lease.closingTemporaryTabs?.has(source.tabId) &&
          !(reason === "target_closed" && lease.closingTabs?.has(source.tabId))
        ) {
          lease.revoked = true;
          for (const controller of lease.controllers.values())
            controller.stop.abort(
              new BrowserActionError(
                "USER_TAKEOVER",
                "The user ended this run's browser control.",
                { dispatched: true, effect: "unknown" },
              ),
            );
          for (const waiter of waiters.values())
            if (waiter.leaseId === lease.id) cancelWaiter(waiter);
          emit({
            type: "event",
            event: "user_takeover",
            target: target(String(source.tabId), lease),
            leaseId: lease.id,
            value: {
              reason:
                reason === "canceled_by_user"
                  ? "USER_TAKEOVER"
                  : "CDP_DISCONNECTED",
            },
          });
        }
      });
    },
    bind(value) {
      record(value);
      requireValue(started && !stopped);
      binding = Object.freeze({ ...value });
      eventBuffer.length = 0;
      eventBytes = 0;
      eventSequence = 0;
      eventTruncated = false;
    },
    async snapshot() {
      requireValue(
        binding && !stopped,
        "EXTENSION_OFFLINE",
        "The plugin has not completed its connection handshake.",
      );
      return (await chrome.tabs.query({}))
        .filter((t) => Number.isInteger(t.id) && !t.incognito)
        .map((t) => ({
          id: String(t.id),
          providerTabId: String(t.id),
          title: (t.title ?? "").slice(0, 4096),
          url: publicUrl(t.url),
          pageVersion: version(t.id),
          active: !!t.active,
          windowId: String(t.windowId),
          ...(t.groupId >= 0 ? { groupId: String(t.groupId) } : {}),
        }));
    },
    openLease(input) {
      try {
        verifyTarget(input.target);
        text(input.leaseId, 256);
        text(input.runId, 256);
        requireValue(
          !closedLeases.has(input.leaseId),
          "INVALID_TARGET",
          "A closed control lease cannot be reopened.",
        );
        const previous = leases.get(input.leaseId);
        if (previous) {
          requireValue(
            previous.runId === input.runId &&
              !previous.ended &&
              !previous.revoked,
            "INVALID_TARGET",
            "A lease identity cannot be rebound.",
          );
          if (input.target.tabId !== undefined)
            claim(previous, nativeId(input.target.tabId));
          return { leaseId: previous.id };
        }
        requireValue(
          leases.size < 1024,
          "QUEUE_FULL",
          "The plugin reached its control lease capacity.",
        );
        const lease = {
          id: input.leaseId,
          runId: input.runId,
          originalGeneration: binding.generation,
          tabs: new Set(),
          handedOff: new Set(),
          attached: new Set(),
          detaching: new Set(),
          intents: new Set(),
          attaching: new Map(),
          pending: new Map(),
          controllers: new Map(),
          fileChoosers: new Set(),
          choosers: new Map(),
          metadata: fields(input, [
            "leaseId",
            "runId",
            "operationId",
            "connectionId",
            "generation",
            "target",
          ]),
          buttons: new Map(),
          keys: new Map(),
          viewports: new Set(),
          externallyDetached: new Set(),
          unconfirmedControls: false,
          ended: false,
          revoked: false,
          closing: null,
          closed: false,
        };
        if (input.target.tabId !== undefined)
          claim(lease, nativeId(input.target.tabId));
        leases.set(lease.id, lease);
        return { leaseId: lease.id };
      } catch (cause) {
        // Only this synchronous, pre-admission path can prove that no lease or native control was acquired.
        // An existing lease (including a failed target expansion) must never receive a fake closed receipt.
        if (
          cause instanceof BrowserActionError &&
          !leases.has(input.leaseId) &&
          !closedLeases.has(input.leaseId)
        )
          leaseOpenFailures.set(cause, {
            leaseId: input.leaseId,
            runId: input.runId,
            operationId: input.operationId,
            closed: true,
            rejected: true,
            originalGeneration: binding?.generation,
            code: cause.code,
            message: cause.message,
          });
        throw cause;
      }
    },
    rejectedLeaseOpen(cause) {
      return cause !== null && typeof cause === "object"
        ? (leaseOpenFailures.get(cause) ?? null)
        : null;
    },
    async endLease(id) {
      const lease = leases.get(id);
      if (!lease) {
        const receipt = closedLeases.get(id);
        requireValue(
          receipt,
          "INVALID_TARGET",
          "No such control lease was established by this plugin.",
        );
        return receipt;
      }
      if (lease.closed)
        return {
          leaseId: id,
          closed: true,
          originalGeneration: lease.originalGeneration,
          ...(lease.unconfirmedControls ? { unconfirmedControls: true } : {}),
        };
      if (lease.closing) return lease.closing;
      lease.ended = true;
      for (const waiter of waiters.values())
        if (waiter.leaseId === lease.id) cancelWaiter(waiter);
      const closing = (async () => {
        for (const controller of lease.controllers.values())
          controller.stop.abort(
            new BrowserActionError(
              "UNKNOWN_RESULT",
              "The run control lease is ending.",
              { dispatched: true, effect: "unknown" },
            ),
          );
        const tempErrors = [];
        for (const tabId of lease.temporaryTabs ?? [])
          try {
            await router.closeTemporary(lease, tabId);
          } catch (cause) {
            tempErrors.push(cause);
          }
        await Promise.allSettled([...lease.pending.keys()]);
        const errors = [...tempErrors];
        for (const [token, stage] of lease.clipboardStages ?? []) {
          try {
            await router.clipboardPage(
              { lease, target: target(stage.tabId), dispatched: () => {} },
              { command: "drop", token },
              true,
            );
          } catch (cause) {
            errors.push(cause);
          }
        }
        for (const tabId of new Set([...lease.attached, ...lease.intents])) {
          try {
            await releaseControl(lease, tabId);
          } catch (cause) {
            errors.push(cause);
          }
        }
        for (const ctx of lease.visualContexts?.values() ?? [])
          try {
            await visual?.releaseTab({
              ...ctx,
              signal: undefined,
              deadline: Date.now() + 250,
              result: false,
            });
          } catch (cause) {
            errors.push(cause);
          }
        if (errors.length)
          throw new BrowserActionError(
            "CDP_DISCONNECTED",
            "Some native controls have not confirmed cleanup.",
            { dispatched: true, effect: "unknown" },
          );
        for (const tabId of lease.tabs)
          if (owners.get(tabId) === lease.id) owners.delete(tabId);
        lease.closed = true;
        for (const [key, waiter] of waiters)
          if (waiter.leaseId === lease.id) waiters.delete(key);
        lease.choosers.clear();
        const receipt = {
          leaseId: id,
          closed: true,
          originalGeneration: lease.originalGeneration,
          ...(lease.unconfirmedControls ? { unconfirmedControls: true } : {}),
        };
        closedLeases.set(id, receipt);
        leases.delete(id);
        while (closedLeases.size > 256)
          closedLeases.delete(closedLeases.keys().next().value);
        return receipt;
      })();
      lease.closing = closing;
      void closing
        .finally(() => {
          if (lease.closing === closing) lease.closing = null;
        })
        .catch(() => {});
      return closing;
    },
    async dispatch(input, signal, onDispatch = () => {}) {
      requireValue(started && !stopped && binding, "EXTENSION_OFFLINE");
      verifyTarget(input.target);
      const definition = routes[input.method];
      requireValue(
        definition,
        "CAPABILITY_NOT_ALLOWED",
        "This build has no registered implementation for that browser method.",
      );
      const lease = leases.get(input.leaseId);
      active(lease);
      requireValue(
        lease.runId === input.runId && !lease.revoked,
        lease?.revoked ? "USER_TAKEOVER" : "INVALID_TARGET",
        "The action does not own this current control lease.",
      );
      record(input.args ?? {});
      const freshDiscovery = [
        "tabs.get",
        "tabs.list",
        "tabs.selected",
        "tabs.new",
        "user.openTabs",
      ].includes(input.method);
      const currentEpoch =
        input.target.tabId === undefined
          ? undefined
          : lease.epochs?.get(nativeId(input.target.tabId));
      if (!freshDiscovery && input.method !== "tab.resumeUserControl")
        requireValue(
          input.target.controlEpoch === currentEpoch,
          "STALE_REF",
          "This tab facade belongs to an earlier control epoch.",
        );
      requireValue(
        Number.isFinite(input.budgetMs) &&
          input.budgetMs > 0 &&
          input.budgetMs <= 2147483647,
      );
      if (definition.needsTab)
        requireValue(
          input.target.tabId !== undefined,
          "INVALID_TARGET",
          "This method needs a specific current tab.",
        );
      if (input.args?.locator?.target) {
        verifyTarget(input.args.locator.target);
        requireValue(
          input.args.locator.target.tabId === input.target.tabId &&
            input.args.locator.target.controlEpoch ===
              input.target.controlEpoch,
          "INVALID_TARGET",
          "A locator cannot cross its tab target.",
        );
      }
      if (
        input.target.tabId !== undefined &&
        !(
          (["tab.markHandoff", "tab.resumeUserControl"].includes(
            input.method,
          ) ||
            freshDiscovery) &&
          lease.handedOff.has(nativeId(input.target.tabId))
        )
      )
        claim(lease, nativeId(input.target.tabId));
      signal?.throwIfAborted();
      const stop = new AbortController();
      const actionSignal = signal
        ? AbortSignal.any([signal, stop.signal])
        : stop.signal;
      lease.controllers.set(input.actionId, {
        stop,
        tabId: input.target.tabId,
      });
      const namespaceCache = new Map();
      const observedChrome = new Proxy(chrome, {
        get(source, key) {
          const value = Reflect.get(source, key);
          if (!value || typeof value !== "object") return value;
          if (!namespaceCache.has(key))
            namespaceCache.set(
              key,
              new Proxy(value, {
                get(namespace, method) {
                  const member = Reflect.get(namespace, method);
                  return typeof member === "function"
                    ? (...args) => {
                        onDispatch();
                        return Reflect.apply(member, namespace, args);
                      }
                    : member;
                },
              }),
            );
          return namespaceCache.get(key);
        },
      });
      const ctx = {
        chrome: observedChrome,
        dispatched: onDispatch,
        router,
        lease,
        target: input.target,
        method: input.method,
        operationId: input.operationId,
        actionId: input.actionId,
        runId: input.runId,
        signal: actionSignal,
        budgetMs: input.budgetMs,
        started: performance.now(),
        pendingInfo: { tabId: input.target.tabId, actionId: input.actionId },
      };
      const perform = async () => {
        active(lease);
        actionSignal.throwIfAborted();
        if (
          definition.mutating &&
          ![
            "tab.markHandoff",
            "tabs.createTemporary",
            "tabs.closeTemporary",
          ].includes(input.method) &&
          !lease.temporaryTabs?.has(nativeId(input.target.tabId ?? "0")) &&
          !visual &&
          router.followSessionTab &&
          input.target.tabId !== undefined
        )
          await observedChrome.tabs.update(nativeId(input.target.tabId), {
            active: true,
          });
        if (
          visual &&
          definition.mutating &&
          input.target.tabId !== undefined &&
          !lease.temporaryTabs?.has(nativeId(input.target.tabId)) &&
          ![
            "tab.markHandoff",
            "tab.resumeUserControl",
            "tabs.closeTemporary",
          ].includes(input.method)
        )
          await router.prepareVisual(ctx);
        actionSignal.throwIfAborted();
        const value = await definition.handle(ctx, input.args ?? {});
        actionSignal.throwIfAborted();
        if (definition.mutating && input.method.startsWith("management.")) {
          auditEntries.push({
            id: `change_${++auditSequence}`,
            createdAt: clock(),
            runId: input.runId,
            operationId: input.operationId,
            namespace: input.method.split(".")[1],
            method: input.method.split(".")[2],
            before: {},
            changedIds: value?.id
              ? [String(value.id)]
              : value?.groupId
                ? [String(value.groupId)]
                : [],
            outcome: "confirmed",
          });
          while (
            auditEntries.length > 1000 ||
            auditEntries[0]?.createdAt < clock() - 7 * 86400000 ||
            encoder.encode(JSON.stringify(auditEntries)).byteLength >
              10 * 1024 * 1024
          )
            auditEntries.shift();
        }
        return value;
      };
      const nonBlocking =
        input.method.startsWith("waiters.") ||
        input.method.includes("waitFor") ||
        [
          "tab.markHandoff",
          "tab.navigate",
          "tab.goBack",
          "tab.forward",
          "tab.reload",
          "dialogs.accept",
          "dialogs.dismiss",
          "downloads.path",
          "tabs.closeTemporary",
          "tab.getJsDialog",
        ].includes(input.method);
      const queueKey =
        input.target.tabId ??
        (definition.mutating ? "browser-management" : undefined);
      let task;
      if (queueKey && !nonBlocking) {
        task = (queues.get(queueKey) ?? Promise.resolve()).then(perform);
        const tail = task.then(
          () => {},
          () => {},
        );
        queues.set(queueKey, tail);
        void tail.then(() => {
          if (queues.get(queueKey) === tail) queues.delete(queueKey);
        });
      } else task = perform();
      lease.pending.set(task, ctx.pendingInfo);
      void task
        .finally(() => {
          lease.pending.delete(task);
          lease.controllers.delete(input.actionId);
        })
        .catch(() => {});
      return task;
    },
    async resolveTab(ctx, requested) {
      let id = requested ?? ctx.target.tabId;
      if (id === undefined) {
        const selected = await ctx.chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        requireValue(
          selected.length === 1,
          "INVALID_TARGET",
          "Select one actual browser tab before changing its viewport.",
        );
        id = String(selected[0].id);
      }
      const tab = await ctx.chrome.tabs.get(nativeId(id));
      requireValue(
        !tab.incognito,
        "CAPABILITY_NOT_ALLOWED",
        "Incognito targets are outside this browser profile's control scope.",
      );
      claim(ctx.lease, nativeId(id));
      ctx.target = target(id, ctx.lease);
      ctx.pendingInfo.tabId = String(id);
      const controller = ctx.lease.controllers.get(ctx.actionId);
      if (controller) controller.tabId = String(id);
      return ctx.target;
    },
    async createTemporary(ctx, args) {
      const url = httpUrl(args.url);
      ctx.signal?.throwIfAborted();
      const tab = await ctx.chrome.tabs.create({ url, active: false });
      requireValue(
        Number.isSafeInteger(tab.id) && tab.id >= 0,
        "PROTOCOL_MISMATCH",
        "The browser did not identify its created temporary tab.",
      );
      (ctx.lease.temporaryTabs ??= new Set()).add(tab.id);
      ctx.lease.tabs.add(tab.id);
      owners.set(tab.id, ctx.lease.id);
      await persist();
      if (ctx.lease.ended || ctx.signal?.aborted) {
        await router.closeTemporary(ctx.lease, tab.id);
        ctx.signal?.throwIfAborted();
        throw new BrowserActionError(
          "INVALID_TARGET",
          "The run ended while its temporary tab was being created.",
        );
      }
      return tabInfo(ctx, tab);
    },
    async closeTemporary(lease, id) {
      if (lease.closedTemporaryTabs?.has(id))
        return { id: String(id), closed: true };
      requireValue(
        lease.temporaryTabs?.has(id),
        "INVALID_TARGET",
        "This run did not create the requested temporary tab.",
      );
      (lease.closingTemporaryTabs ??= new Set()).add(id);
      try {
        await chrome.tabs.remove(id);
      } catch (cause) {
        if (
          !/No tab with id|Invalid tab ID/i.test(String(cause?.message ?? ""))
        )
          throw cause;
      }
      lease.temporaryTabs.delete(id);
      (lease.closedTemporaryTabs ??= new Set()).add(id);
      lease.externallyDetached.add(id);
      lease.attached.delete(id);
      if (owners.get(id) === lease.id) owners.delete(id);
      if (lease.closedTemporaryTabs.size > 1024)
        lease.closedTemporaryTabs.delete(
          lease.closedTemporaryTabs.values().next().value,
        );
      await persist();
      return { id: String(id), closed: true };
    },
    async closeNativeTab(ctx, id) {
      const lease = ctx.lease;
      canClaim(lease, id);
      const closing = { ...ctx, target: { ...target(String(id), lease) } };
      // Closing a different management target must never send cleanup to the caller's tab.
      await releaseControl(lease, id, { detach: false });
      for (const [token, stage] of lease.clipboardStages ?? [])
        if (nativeId(stage.tabId) === id)
          await router.clipboardPage(closing, { command: "drop", token }, true);
      active(lease);
      ctx.signal?.throwIfAborted();
      (lease.closingTabs ??= new Set()).add(id);
      let removed = false;
      try {
        try {
          await ctx.chrome.tabs.remove(id);
          removed = true;
        } catch (cause) {
          // Inspect an ambiguous native result; never replay the removal request.
          try {
            await chrome.tabs.get(id);
          } catch (probe) {
            if (
              /No tab with id|Invalid tab ID/i.test(
                String(probe?.message ?? ""),
              )
            )
              removed = true;
          }
          if (!removed) throw cause;
        }
        (lease.closedTabs ??= new Set()).add(id);
        lease.externallyDetached.add(id);
        await releaseControl(lease, id);
        for (const waiter of waiters.values())
          if (waiter.leaseId === lease.id && waiter.tabId === id)
            cancelWaiter(waiter);
        for (const [actionId, controller] of lease.controllers)
          if (actionId !== ctx.actionId && controller.tabId === String(id))
            controller.stop.abort(
              new BrowserActionError(
                "INVALID_TARGET",
                "The native tab was closed by this run.",
              ),
            );
        const visualCtx = lease.visualContexts?.get(id);
        if (visualCtx)
          await visual?.releaseTab({
            ...visualCtx,
            signal: undefined,
            deadline: Date.now() + 250,
            result: false,
          });
        lease.visualContexts?.delete(id);
        if (owners.get(id) === lease.id) owners.delete(id);
        lease.tabs.delete(id);
        lease.attached.delete(id);
        lease.intents.delete(id);
        await persist();
      } finally {
        // Success has removed the owner before a delayed detach can be delivered. Failure
        // leaves the original owner intact and removes only this request's admission marker.
        if (!removed || owners.get(id) !== lease.id)
          lease.closingTabs.delete(id);
      }
    },
    async clipboardPage(ctx, payload, cleanup = false) {
      return router.scriptPage(
        ctx,
        payload,
        cleanup,
        cleanup
          ? (ctx.lease.clipboardStages?.get(payload.token)?.kind ?? "clipboard")
          : "clipboard",
      );
    },
    async dataPage(ctx, payload, cleanup = false) {
      let abort;
      if (!cleanup && payload.command === "fetch" && ctx.signal) {
        abort = () => {
          void router
            .scriptPage(
              ctx,
              { command: "cancel", token: payload.token },
              true,
              "page-data",
            )
            .catch(() => {});
        };
        ctx.signal.addEventListener("abort", abort, { once: true });
      }
      try {
        return await router.scriptPage(ctx, payload, cleanup, "page-data");
      } finally {
        if (abort) ctx.signal.removeEventListener("abort", abort);
      }
    },
    async trackNativeStream(ctx, handle) {
      text(handle, 1024);
      const id = nativeId(ctx.target.tabId),
        streams = (ctx.lease.nativeStreams ??= new Map());
      const handles = streams.get(id) ?? new Set();
      requireValue(
        handles.size < 64,
        "QUEUE_FULL",
        "The native stream-handle budget is full.",
      );
      streams.set(id, handles);
      handles.add(handle);
      await persist();
    },
    async closeNativeStream(ctx, handle) {
      const id = nativeId(ctx.target.tabId),
        handles = ctx.lease.nativeStreams?.get(id);
      if (ctx.lease.attached.has(id)) await closeStream(id, handle);
      else ctx.lease.unconfirmedControls = true;
      handles?.delete(handle);
      await persist();
    },
    async scriptPage(ctx, payload, cleanup = false, kind = "clipboard") {
      const stages = (ctx.lease.clipboardStages ??= new Map());
      const previous = stages.get(payload.token);
      if (payload.command === "drop" && !previous) return null;
      if (!cleanup) ctx.signal?.throwIfAborted();
      if (
        previous &&
        !previous.recovered &&
        previous.pageVersion !== version(previous.tabId)
      ) {
        stages.delete(payload.token);
        await persist();
        if (cleanup) return null;
        throw new BrowserActionError(
          "STALE_REF",
          "The original clipboard document changed.",
        );
      }
      const tabId = previous?.tabId ?? ctx.target.tabId,
        pageVersion = previous?.pageVersion ?? version(tabId);
      if (
        ["read", "prepare", "inventory", "fetch", "export"].includes(
          payload.command,
        ) &&
        !previous
      ) {
        requireValue(
          stages.size < 64,
          "QUEUE_FULL",
          "This run reached its clipboard staging budget.",
        );
        stages.set(payload.token, { tabId, pageVersion, kind });
        await persist();
        active(ctx.lease);
        ctx.signal?.throwIfAborted();
      }
      ctx.dispatched();
      const responses = await chrome.scripting.executeScript({
        target: { tabId: nativeId(tabId) },
        world: "ISOLATED",
        func: kind === "clipboard" ? clipboardCommand : pageDataCommand,
        args: [{ ...payload, leaseId: ctx.lease.id, pageVersion }],
      });
      const response = responses[0]?.result;
      requireValue(
        responses.length === 1 && response,
        "INVALID_TARGET",
        "The browser clipboard did not return one native page result.",
      );
      if (!response.ok)
        throw new BrowserActionError(
          response.error.code,
          response.error.message,
        );
      if (payload.command === "drop") {
        stages.delete(payload.token);
        await persist();
      }
      if (!cleanup) ctx.signal?.throwIfAborted();
      return response.value;
    },
    async page(ctx, payload) {
      ctx.signal?.throwIfAborted();
      const input = {
        ...payload,
        pageVersion: version(ctx.target.tabId),
        leaseId: router.referenceLease(ctx),
      };
      if (
        payload.ref ||
        payload.nodeId ||
        payload.locator?.query?.kind === "ref"
      )
        requireValue(
          ctx.target.pageVersion === undefined ||
            ctx.target.pageVersion === version(ctx.target.tabId),
          "STALE_REF",
          "The fixed reference belongs to another document.",
        );
      const framePath = payload.locator?.framePath ?? payload.framePath ?? [];
      if (framePath.length > 0) return framePage(ctx, payload, framePath);
      ctx.dispatched();
      const result = await chrome.scripting.executeScript({
        target: { tabId: nativeId(ctx.target.tabId) },
        world: "ISOLATED",
        func: pageCommand,
        args: [input],
      });
      requireValue(
        result.length === 1 && result[0].result,
        "INVALID_TARGET",
        "The page execution did not produce one main-frame result.",
      );
      if (!result[0].result.ok)
        throw new BrowserActionError(
          result[0].result.error.code,
          result[0].result.error.message,
        );
      return result[0].result.value;
    },
    referenceLease(ctx) {
      const epoch = ctx.lease.epochs?.get(nativeId(ctx.target.tabId));
      return epoch ? `${ctx.lease.id}:${epoch}` : ctx.lease.id;
    },
    async enableFrameTargets(ctx) {
      const id = nativeId(ctx.target.tabId);
      const pending = (ctx.lease.frameTargets ??= new Map());
      if (!pending.has(id))
        pending.set(
          id,
          router.send(ctx, "Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{ type: "iframe", exclude: false }, { exclude: true }],
          }),
        );
      await pending.get(id);
    },
    async frameSend(ctx, frameId, method, params) {
      const childForFrame = () =>
        [...children.entries()].find(
          ([, child]) =>
            child.active &&
            child.leaseId === ctx.lease.id &&
            child.tabId === nativeId(ctx.target.tabId) &&
            child.targetId === frameId,
        );
      let child = router.frameSource(ctx, frameId);
      try {
        await child?.[1].ready;
        return await router.send(
          ctx,
          method,
          params,
          child ? { sessionId: child[0] } : undefined,
        );
      } catch (cause) {
        if (
          method !== "Page.createIsolatedWorld" ||
          !/no frame|frame.*not found/i.test(String(cause?.message ?? ""))
        )
          throw cause;
        // A frame can enter its own renderer between native owner observation and auto-attach delivery.
        for (
          let attempt = 0;
          attempt < 50 && !(child = childForFrame());
          attempt++
        )
          await router.delay(ctx, 10);
        requireValue(
          child,
          "STALE_REF",
          "The actual child-frame target is no longer attached.",
        );
      }
      await child[1].ready;
      return router.send(ctx, method, params, { sessionId: child[0] });
    },
    noteFrameParent(ctx, child, parent) {
      text(child, 512);
      text(parent, 512);
      requireValue(
        child !== parent,
        "STALE_REF",
        "A native frame cannot own itself.",
      );
      const tabs = (ctx.lease.frameParents ??= new Map()),
        id = nativeId(ctx.target.tabId);
      const parents = tabs.get(id) ?? new Map();
      tabs.set(id, parents);
      parents.set(child, parent);
      if (parents.size > 10000) parents.delete(parents.keys().next().value);
    },
    frameSource(ctx, frameId) {
      const parents = ctx.lease.frameParents?.get(nativeId(ctx.target.tabId)),
        seen = new Set();
      while (frameId && !seen.has(frameId) && seen.size <= 16) {
        seen.add(frameId);
        const child = [...children.entries()].find(
          ([, value]) =>
            value.active &&
            value.leaseId === ctx.lease.id &&
            value.tabId === nativeId(ctx.target.tabId) &&
            value.targetId === frameId,
        );
        if (child) return child;
        frameId = parents?.get(frameId);
      }
      return undefined;
    },
    async frameContext(ctx, frameId, world) {
      await router.frameSend(ctx, frameId, "Runtime.enable", {});
      const sessionId = router.frameSource(ctx, frameId)?.[0];
      const contexts = [...executionContexts.values()].filter(
        (context) =>
          context.tabId === nativeId(ctx.target.tabId) &&
          context.sessionId === sessionId &&
          context.auxData?.frameId === frameId &&
          (world === "main"
            ? context.auxData?.isDefault === true
            : context.auxData?.isDefault === false &&
              context.origin?.replace(/\/$/, "") ===
                `chrome-extension://${chrome.runtime.id}`),
      );
      requireValue(
        contexts.length === 1,
        "STALE_REF",
        "The exact native frame execution context is no longer available.",
      );
      return contexts[0].id;
    },
    async evaluateLocator(ctx, args, multiple) {
      const selectors = args.locator?.framePath ?? [];
      if (selectors.length)
        return framePage(ctx, args, selectors, (scope) =>
          evaluateLocated(ctx, args, multiple, scope),
        );
      // Establish/validate the same extension world that owns existing main-document references.
      await router.page(ctx, { ...args, command: "all" });
      const tree = await router.send(ctx, "Page.getFrameTree", {}),
        frameId = tree.frameTree?.frame?.id;
      text(frameId, 512);
      return evaluateLocated(ctx, args, multiple, {
        frameId,
        executionContextId: await router.frameContext(
          ctx,
          frameId,
          "extension",
        ),
        native: (method, params) =>
          router.frameSend(ctx, frameId, method, params),
        input: {
          ...args,
          framePath: [],
          pageVersion: version(ctx.target.tabId),
          leaseId: router.referenceLease(ctx),
        },
      });
    },
    async releaseFrameObject(ctx, frameId, objectId) {
      const tabId = nativeId(ctx.target.tabId);
      if (!ctx.lease.attached.has(tabId)) return;
      const child = router.frameSource(ctx, frameId);
      await chrome.debugger.sendCommand(
        { tabId, ...(child ? { sessionId: child[0] } : {}) },
        "Runtime.releaseObject",
        { objectId },
      );
    },
    async attach(ctx) {
      const id = nativeId(ctx.target.tabId);
      active(ctx.lease);
      if (ctx.lease.attached.has(id)) return;
      if (ctx.lease.attaching.has(id)) return ctx.lease.attaching.get(id);
      const task = (async () => {
        ctx.lease.intents.add(id);
        try {
          await persist();
          active(ctx.lease);
          ctx.signal?.throwIfAborted();
        } catch (cause) {
          ctx.lease.intents.delete(id);
          await persist();
          throw cause;
        }
        ctx.dispatched();
        await chrome.debugger.attach({ tabId: id }, "1.3");
        ctx.lease.attached.add(id);
        if (ctx.lease.ended) {
          await releaseControl(ctx.lease, id);
          throw new BrowserActionError(
            "INVALID_TARGET",
            "The lease stopped during native attachment.",
          );
        }
      })();
      ctx.lease.attaching.set(id, task);
      try {
        await task;
      } finally {
        ctx.lease.attaching.delete(id);
      }
    },
    async send(ctx, method, params, child) {
      active(ctx.lease);
      ctx.signal?.throwIfAborted();
      await router.attach(ctx);
      ctx.signal?.throwIfAborted();
      if (
        visual &&
        method === "Input.dispatchMouseEvent" &&
        !child &&
        Number.isFinite(params.x) &&
        Number.isFinite(params.y) &&
        !ctx.lease.temporaryTabs?.has(nativeId(ctx.target.tabId))
      )
        await router.preparePointer(ctx, { x: params.x, y: params.y });
      ctx.signal?.throwIfAborted();
      let source = { tabId: nativeId(ctx.target.tabId) };
      if (child) {
        requireValue(!(child.sessionId && child.targetId), "INVALID_ARGUMENT");
        const entry = child.sessionId
          ? children.get(child.sessionId)
          : [...children.entries()].find(
              ([, value]) => value.targetId === child.targetId && value.active,
            );
        const sessionId = child.sessionId ?? entry?.[0],
          value = child.sessionId ? entry : entry?.[1];
        requireValue(
          value?.active && value.tabId === source.tabId && sessionId,
          "STALE_REF",
          "The child target is not attached to this tab.",
        );
        source = { ...source, sessionId };
      }
      const tabId = nativeId(ctx.target.tabId);
      let inputMap,
        token,
        inputIntent = false;
      if (
        method === "Input.dispatchKeyEvent" &&
        ["keyDown", "rawKeyDown", "keyUp"].includes(params.type) &&
        ((typeof params.key === "string" && params.key.length <= 128) ||
          (typeof params.code === "string" && params.code.length <= 128) ||
          Number.isInteger(params.windowsVirtualKeyCode))
      ) {
        if (!ctx.lease.keys.has(tabId)) ctx.lease.keys.set(tabId, new Map());
        inputMap = ctx.lease.keys.get(tabId);
        token = keyToken(params, source);
        if (params.type !== "keyUp") {
          requireValue(
            inputMap.has(token) || inputMap.size < 128,
            "QUEUE_FULL",
            "The native pressed-key ledger is full.",
          );
          inputMap.set(token, {
            source: { ...source },
            params: fields(params, [
              "key",
              "code",
              "windowsVirtualKeyCode",
              "nativeVirtualKeyCode",
              "location",
            ]),
          });
          inputIntent = true;
        }
      }
      if (
        method === "Input.dispatchMouseEvent" &&
        ["mousePressed", "mouseReleased", "mouseMoved"].includes(params.type)
      ) {
        if (!ctx.lease.buttons.has(tabId))
          ctx.lease.buttons.set(tabId, new Map());
        const entries = ctx.lease.buttons.get(tabId);
        if (params.type === "mouseMoved") {
          if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
            for (const entry of entries.values())
              if (entry.source.sessionId === source.sessionId) {
                entry.params.x = params.x;
                entry.params.y = params.y;
              }
            inputIntent = entries.size > 0;
          }
        } else if (
          ["left", "right", "middle", "back", "forward"].includes(
            params.button,
          ) &&
          Number.isFinite(params.x) &&
          Number.isFinite(params.y)
        ) {
          inputMap = entries;
          token = `${source.sessionId ?? ""}\0${params.button}`;
          if (params.type === "mousePressed") {
            requireValue(
              entries.has(token) || entries.size < 20,
              "QUEUE_FULL",
              "The native mouse-button ledger is full.",
            );
            entries.set(token, {
              source: { ...source },
              params: fields(params, ["x", "y", "button"]),
            });
            inputIntent = true;
          }
        }
      }
      if (!child && method === "Emulation.setDeviceMetricsOverride") {
        ctx.lease.viewports.add(tabId);
        inputIntent = true;
      }
      if (inputIntent) {
        await persist();
        active(ctx.lease);
        ctx.signal?.throwIfAborted();
      }
      ctx.dispatched();
      const result = await chrome.debugger.sendCommand(source, method, params);
      if (
        (params.type === "keyUp" || params.type === "mouseReleased") &&
        inputMap
      )
        inputMap.delete(token);
      if (!child && method === "Emulation.clearDeviceMetricsOverride")
        ctx.lease.viewports.delete(tabId);
      if (
        ((params.type === "keyUp" || params.type === "mouseReleased") &&
          inputMap) ||
        (!child && method === "Emulation.clearDeviceMetricsOverride")
      )
        await persist();
      return result;
    },
    heldKey(ctx, key) {
      return ctx.lease.keys.get(nativeId(ctx.target.tabId))?.get(keyToken(key));
    },
    async releaseKey(ctx, key) {
      const entries = ctx.lease.keys.get(nativeId(ctx.target.tabId)),
        token = keyToken(key),
        entry = entries?.get(token);
      if (!entry) return;
      // Cleanup remains reachable after the action signal is cancelled. Never reattach here.
      requireValue(
        ctx.lease.attached.has(nativeId(ctx.target.tabId)),
        "CDP_DISCONNECTED",
        "The native key release needs its original attachment.",
      );
      await chrome.debugger.sendCommand(
        entry.source,
        "Input.dispatchKeyEvent",
        { type: "keyUp", ...entry.params, modifiers: 0 },
      );
      entries.delete(token);
      await persist();
    },
    async delay(ctx, milliseconds) {
      const remaining = Math.max(
        0,
        ctx.budgetMs - (performance.now() - ctx.started),
      );
      await sleep(Math.min(milliseconds, remaining), ctx.signal);
      requireValue(
        milliseconds <= remaining,
        "TIMEOUT",
        "The browser action exceeded its deadline.",
      );
    },
    async axSnapshot(ctx) {
      const pageVersion = version(ctx.target.tabId);
      await router.send(ctx, "Accessibility.enable", {});
      const result = await router.send(ctx, "Accessibility.getFullAXTree", {
        depth: 32,
      });
      requireValue(
        pageVersion === version(ctx.target.tabId),
        "STALE_REF",
        "The document changed during accessibility observation.",
      );
      requireValue(
        Array.isArray(result.nodes) && result.nodes.length <= 10000,
        "OUTPUT_TOO_LARGE",
        "The native accessibility tree exceeds its node budget.",
      );
      const refs = (ctx.lease.axReferences ??= new Map());
      for (const [index, ref] of refs)
        if (ref.tabId === ctx.target.tabId && ref.pageVersion !== pageVersion)
          refs.delete(index);
      const reverse = new Map(
        [...refs]
          .filter(
            ([, ref]) =>
              ref.tabId === ctx.target.tabId && ref.pageVersion === pageVersion,
          )
          .map(([index, ref]) => [ref.backendNodeId, index]),
      );
      const nativeIds = new Set(result.nodes.map((node) => node.nodeId)),
        nodes = [];
      let bytes = 0,
        truncated = result.nodes.some((node) =>
          node.childIds?.some((id) => !nativeIds.has(id)),
        );
      for (const node of result.nodes) {
        if (
          node.ignored ||
          !Number.isInteger(node.backendDOMNodeId) ||
          node.backendDOMNodeId <= 0
        )
          continue;
        const item = {
          index:
            reverse.get(node.backendDOMNodeId) ?? (ctx.lease.axNext ?? 0) + 1,
          role: String(node.role?.value ?? "unknown").slice(0, 256),
          ...(typeof node.name?.value === "string"
            ? { name: node.name.value.slice(0, 4096) }
            : {}),
        };
        const size = encoder.encode(JSON.stringify(item)).byteLength;
        if (bytes + size > 60000) {
          truncated = true;
          break;
        }
        bytes += size;
        if (!reverse.has(node.backendDOMNodeId)) {
          requireValue(
            refs.size < 10000 && item.index < Number.MAX_SAFE_INTEGER,
            "QUEUE_FULL",
            "This run reached its native accessibility-reference budget.",
          );
          ctx.lease.axNext = item.index;
          reverse.set(node.backendDOMNodeId, item.index);
          refs.set(item.index, {
            tabId: ctx.target.tabId,
            pageVersion,
            backendNodeId: node.backendDOMNodeId,
            controlEpoch: ctx.lease.epochs?.get(nativeId(ctx.target.tabId)),
          });
        }
        refs.get(item.index).actions = secondaryActions(node);
        refs.get(item.index).facts = axFacts(node);
        nodes.push(item);
      }
      return { target: target(ctx.target.tabId, ctx.lease), nodes, truncated };
    },
    axReference(ctx, index) {
      requireValue(Number.isSafeInteger(index) && index > 0);
      const value = ctx.lease.axReferences?.get(index);
      requireValue(
        value &&
          value.tabId === ctx.target.tabId &&
          value.pageVersion === version(ctx.target.tabId) &&
          value.controlEpoch ===
            ctx.lease.epochs?.get(nativeId(ctx.target.tabId)),
        "STALE_REF",
        "The accessibility index belongs to another observation or document.",
      );
      return value;
    },
    async axSecondary(ctx, index, action) {
      text(action, 128);
      const ref = router.axReference(ctx, index);
      requireValue(
        ref.actions.includes(action),
        "INVALID_ARGUMENT",
        "Use a secondary action exposed by this exact accessibility observation.",
      );
      const current = async () => {
        router.axReference(ctx, index);
        const tree = await router.send(ctx, "Accessibility.getPartialAXTree", {
          backendNodeId: ref.backendNodeId,
          fetchRelatives: false,
        });
        const node = tree.nodes?.find(
          (node) => node.backendDOMNodeId === ref.backendNodeId,
        );
        requireValue(
          node && !node.ignored,
          "STALE_REF",
          "The original accessibility node is no longer available.",
        );
        return node;
      };
      const before = await current(),
        facts = axFacts(before);
      requireValue(
        secondaryActions(before).includes(action),
        "STALE_REF",
        "The observed accessibility action is no longer available.",
      );
      if (["Expand", "Collapse", "Toggle"].includes(action))
        await click(ctx, await router.axPoint(ctx, index));
      else {
        await router.axFocus(ctx, index);
        await pressKeys(ctx, [
          action === "Increment" ? "ArrowUp" : "ArrowDown",
        ]);
      }
      await router.poll(ctx, async () => {
        const after = axFacts(await current());
        return action === "Expand"
          ? after.expanded === true
          : action === "Collapse"
            ? after.expanded === false
            : action === "Toggle"
              ? after.checked !== facts.checked
              : action === "Increment"
                ? Number(after.value) > Number(facts.value)
                : Number(after.value) < Number(facts.value);
      });
      return null;
    },
    async axFocus(ctx, index) {
      const ref = router.axReference(ctx, index);
      await router.send(ctx, "DOM.focus", { backendNodeId: ref.backendNodeId });
      router.axReference(ctx, index);
    },
    async axPoint(ctx, element) {
      if (typeof element !== "number") return point(ctx, element);
      const ref = router.axReference(ctx, element);
      await router.send(ctx, "DOM.scrollIntoViewIfNeeded", {
        backendNodeId: ref.backendNodeId,
      });
      const result = await router.send(ctx, "DOM.getBoxModel", {
        backendNodeId: ref.backendNodeId,
      });
      router.axReference(ctx, element);
      const quad = result.model?.border;
      requireValue(
        Array.isArray(quad) && quad.length === 8 && quad.every(Number.isFinite),
        "INVALID_TARGET",
        "The observed accessibility node has no visible native box.",
      );
      return {
        x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
        y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
      };
    },
    async axNodeCommand(ctx, index, input) {
      const ref = router.axReference(ctx, index);
      const resolved = await router.send(ctx, "DOM.resolveNode", {
        backendNodeId: ref.backendNodeId,
      });
      const objectId = resolved.object?.objectId;
      requireValue(
        typeof objectId === "string" && objectId.length > 0,
        "STALE_REF",
        "The observed accessibility node no longer resolves.",
      );
      try {
        router.axReference(ctx, index);
        const response = await router.send(ctx, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: nativeNodeCommand.toString(),
          arguments: [{ value: input }],
          returnByValue: true,
          userGesture: true,
        });
        requireValue(
          !response.exceptionDetails && response.result?.value === true,
          "INVALID_TARGET",
          "The requested operation could not be applied to the observed native node.",
        );
        router.axReference(ctx, index);
      } finally {
        // Release exactly the temporary native object, even if the action was cancelled.
        if (ctx.lease.attached.has(nativeId(ctx.target.tabId)))
          await chrome.debugger.sendCommand(
            { tabId: nativeId(ctx.target.tabId) },
            "Runtime.releaseObject",
            { objectId },
          );
      }
      return null;
    },
    async setFiles(ctx, args) {
      requireValue(Array.isArray(args.files) && args.files.length <= 1024);
      // The Node boundary materializes and authorizes the complete batch before this request is sent.
      // Validate every prepared entry before looking up or mutating a browser file input.
      const paths = args.files.map((file) => {
        record(file, ["path", "name", "mimeType"]);
        text(file.path, 8192);
        text(file.name, 255);
        requireValue(
          /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(file.path) &&
            !/[\x00-\x1f\x7f]/.test(file.path),
        );
        requireValue(
          file.name !== "." &&
            file.name !== ".." &&
            !/[\\/\x00-\x1f\x7f]/.test(file.name),
        );
        if (file.mimeType !== undefined) {
          text(file.mimeType, 256);
          requireValue(/^[\x20-\x7e]+$/.test(file.mimeType));
        }
        return file.path;
      });
      const tabId = nativeId(ctx.target.tabId),
        pageVersion = version(tabId);
      let backendNodeId, expectedMultiple, objectId;
      const chooser =
        ctx.method === "fileChoosers.setFiles"
          ? ctx.lease.choosers.get(args.chooserId)
          : undefined;
      try {
        if (ctx.method === "fileChoosers.setFiles") {
          requireValue(
            chooser &&
              chooser.tabId === tabId &&
              chooser.pageVersion === args.pageVersion &&
              chooser.pageVersion === pageVersion &&
              chooser.controlEpoch === ctx.lease.epochs?.get(tabId),
            "STALE_REF",
            "The original file chooser is no longer current.",
          );
          backendNodeId = chooser.backendNodeId;
          expectedMultiple = chooser.multiple;
        } else {
          text(args.ref, 512);
          const info = await router.page(ctx, {
            command: "fileInfo",
            ref: args.ref,
          });
          expectedMultiple = info.multiple;
          await router.send(ctx, "Runtime.enable", {});
          const frame = await router.send(ctx, "Page.getFrameTree", {});
          const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
          const contexts = [...executionContexts.values()].filter(
            (context) =>
              context.tabId === tabId &&
              !context.sessionId &&
              typeof context.origin === "string" &&
              context.origin.replace(/\/$/, "") === extensionOrigin &&
              context.auxData?.frameId === frame.frameTree.frame.id &&
              context.auxData?.isDefault === false,
          );
          requireValue(
            contexts.length === 1,
            "CAPABILITY_NOT_ALLOWED",
            "The browser has not exposed this extension's exact isolated-world context.",
          );
          const expression = `(()=>{const state=globalThis[Symbol.for("nexum.browser.document.v1")];const ref=${JSON.stringify(args.ref)};if(!state||state.document!==document||state.version!==${pageVersion}||!ref.startsWith(${JSON.stringify(`r_${router.referenceLease(ctx)}_${pageVersion}_`)}))throw new Error("STALE_REF");const node=state.refs.get(ref);if(!node||!node.isConnected)throw new Error("STALE_REF");return node})()`;
          const resolved = await router.send(ctx, "Runtime.evaluate", {
            expression,
            contextId: contexts[0].id,
            returnByValue: false,
          });
          objectId = resolved.result?.objectId;
          requireValue(
            !resolved.exceptionDetails &&
              resolved.result?.subtype === "node" &&
              typeof objectId === "string",
            "STALE_REF",
            "The exact observed file-input node no longer resolves.",
          );
        }
        const described = await router.send(
          ctx,
          "DOM.describeNode",
          objectId ? { objectId } : { backendNodeId },
        );
        const node = described.node,
          attributes = new Map();
        requireValue(
          node && Array.isArray(node.attributes),
          "INVALID_TARGET",
          "The native file-input node has no attributes.",
        );
        for (let i = 0; i < node.attributes.length; i += 2)
          attributes.set(
            node.attributes[i].toLowerCase(),
            node.attributes[i + 1],
          );
        requireValue(
          node.nodeName === "INPUT" &&
            attributes.get("type")?.toLowerCase() === "file" &&
            Number.isInteger(node.backendNodeId),
          "INVALID_TARGET",
          "The observed native node is not a file input.",
        );
        if (backendNodeId !== undefined)
          requireValue(
            node.backendNodeId === backendNodeId,
            "STALE_REF",
            "The original file chooser node was replaced.",
          );
        requireValue(
          attributes.has("multiple") === expectedMultiple,
          "STALE_REF",
          "The observed file input's multiple state changed.",
        );
        requireValue(
          paths.length <= 1 || expectedMultiple,
          "INVALID_ARGUMENT",
          "This original file input does not accept multiple files.",
        );
        requireValue(
          pageVersion === version(tabId),
          "STALE_REF",
          "The file-input document changed during preparation.",
        );
        await router.send(ctx, "DOM.setFileInputFiles", {
          backendNodeId: node.backendNodeId,
          files: paths,
        });
        if (chooser) ctx.lease.choosers.delete(args.chooserId);
        return router.actionResult(ctx);
      } finally {
        if (objectId && ctx.lease.attached.has(tabId))
          await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.releaseObject",
            { objectId },
          );
      }
    },
    async webMcpSnapshot(ctx) {
      const id = nativeId(ctx.target.tabId),
        pageVersion = version(id);
      const states = (ctx.lease.webMcpStates ??= new Map());
      let state = states.get(id);
      if (!state || state.pageVersion !== pageVersion) {
        state = {
          pageVersion,
          tools: new Map(),
          registrationRevision: crypto.randomUUID(),
          snapshot: undefined,
          ready: undefined,
        };
        states.set(id, state);
        state.ready = router.send(ctx, "WebMCP.enable", {}).catch((cause) => {
          if (states.get(id) === state) states.delete(id);
          if (
            /method.*(?:not found|wasn't found)|not allowed|unsupported|not supported|unknown.*domain/i.test(
              String(cause?.message ?? ""),
            )
          )
            throw new BrowserActionError(
              "CAPABILITY_NOT_ALLOWED",
              "This browser does not expose the native WebMCP domain to this extension.",
            );
          throw cause;
        });
      }
      await state.ready;
      ctx.signal?.throwIfAborted();
      requireValue(
        state.pageVersion === version(id),
        "STALE_REGISTRATION",
        "The WebMCP document changed during discovery.",
      );
      if (state.error) throw state.error;
      if (!state.snapshot) {
        const names = new Set(),
          documentRevision = `${binding.browserSessionId}:${id}:${pageVersion}:${ctx.lease.epochs?.get(id) ?? "initial"}`;
        const native = new Map();
        const tools = [...state.tools.values()]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((tool) => {
            requireValue(
              !names.has(tool.name),
              "AMBIGUOUS_TARGET",
              "Multiple native frames registered the same WebMCP tool name.",
            );
            names.add(tool.name);
            const descriptor = {
              documentRevision,
              registrationRevision: state.registrationRevision,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema ?? { type: "object" },
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
            };
            native.set(tool.name, {
              toolId: tool.toolId,
              frameId: tool.frameId,
              descriptor,
            });
            return descriptor;
          });
        state.snapshot = {
          descriptor: {
            documentRevision,
            registrationRevision: state.registrationRevision,
            tools,
          },
          native,
        };
      }
      // Return detached protocol data, not the mutable native registration cache.
      return JSON.parse(JSON.stringify(state.snapshot.descriptor));
    },
    async capabilities(ctx, level, requested) {
      const definitions =
        level === "browser"
          ? [
              [
                "management",
                "Browser management",
                "Native windows, tabs, groups and bookmarks.",
              ],
              [
                "visibility",
                "Tab following",
                "Follow the actual operation target inside the existing browser window.",
              ],
              [
                "viewport",
                "Viewport emulation",
                "Native viewport emulation for the current selected or explicit page.",
              ],
            ]
          : [
              [
                "pageAssets",
                "Page assets",
                "Observe actual document assets and materialize selected browser content.",
              ],
              [
                "cdp",
                "Chrome DevTools Protocol",
                "The browser's currently reachable native protocol domains.",
              ],
              [
                "webmcp",
                "WebMCP",
                "Current native WebMCP registration discovery and exact tool invocation.",
              ],
            ];
      const values = [];
      for (const [id, title, description] of definitions.filter(
        ([id]) => requested === undefined || requested === id,
      )) {
        let supported = false,
          reason;
        try {
          ctx.signal?.throwIfAborted();
          if (id === "management") {
            const granted = await chrome.permissions?.contains?.({
              permissions: ["tabs", "tabGroups", "bookmarks"],
            });
            if (!granted)
              reason =
                "Required native browser management permissions were not granted.";
            else {
              await ctx.chrome.windows.getAll({ populate: false });
              await ctx.chrome.tabs.query({});
              await ctx.chrome.tabGroups.query({});
              await ctx.chrome.bookmarks.search({
                query: `nexum-capability-probe-${crypto.randomUUID()}`,
              });
              supported = true;
            }
          } else if (id === "visibility") {
            await ctx.chrome.tabs.query({ active: true, currentWindow: true });
            supported = true;
          } else if (id === "viewport") {
            await router.resolveTab(ctx);
            const available = await router.send(
              ctx,
              "Emulation.canEmulate",
              {},
            );
            supported = available.result === true;
            if (!supported)
              reason =
                "The actual selected target does not permit native viewport emulation.";
          } else if (id === "cdp") {
            await router.send(ctx, "Runtime.enable", {});
            supported = true;
          } else if (id === "webmcp") {
            await router.send(ctx, "WebMCP.enable", {});
            await router.webMcpSnapshot(ctx);
            supported = true;
          } else {
            const inventory = await listAssets(ctx);
            supported = !!inventory.id;
          }
        } catch (cause) {
          ctx.signal?.throwIfAborted();
          if (
            cause instanceof BrowserActionError &&
            [
              "STALE_REF",
              "USER_TAKEOVER",
              "TAB_ALREADY_CLAIMED",
              "INVALID_TARGET",
            ].includes(cause.code)
          )
            throw cause;
          reason =
            cause instanceof BrowserActionError
              ? cause.message
              : "The browser rejected the required native capability probe.";
        }
        values.push({
          id,
          name: id,
          title,
          description,
          supported,
          ...(reason ? { reason } : {}),
          revision: `${binding.browserSessionId}:${binding.generation}:${ctx.target.tabId ?? "browser"}:${ctx.target.tabId ? version(ctx.target.tabId) : 0}:${id}:${supported ? "available" : "unavailable"}`,
        });
      }
      return values;
    },
    async webMcpInvoke(ctx, args) {
      text(args.name, 256);
      record(args.tool);
      record(args.args);
      const id = nativeId(ctx.target.tabId),
        state = ctx.lease.webMcpStates?.get(id),
        observed = state?.snapshot?.native.get(args.name);
      requireValue(
        observed &&
          state.pageVersion === version(id) &&
          state.snapshot.descriptor.registrationRevision ===
            state.registrationRevision &&
          sameData(observed.descriptor, args.tool),
        "STALE_REGISTRATION",
        "The exact observed WebMCP registration is no longer current.",
      );
      // Native invokeTool uses the opaque toolId and performs the tool's native input-Schema validation.
      // It must never fall back to toolName when a page unregisters and replaces a tool.
      requireValue(
        webMcpPending.size < 64,
        "QUEUE_FULL",
        "The native WebMCP invocation budget is full.",
      );
      const response = await router.send(ctx, "WebMCP.invokeTool", {
        frameId: observed.frameId,
        toolId: observed.toolId,
        input: args.args,
      });
      text(response.invocationId, 512);
      const pending = {
        ...Promise.withResolvers(),
        leaseId: ctx.lease.id,
        tabId: id,
      };
      webMcpPending.set(response.invocationId, pending);
      const early = webMcpEarly.get(response.invocationId);
      webMcpEarly.delete(response.invocationId);
      if (
        early?.leaseId === ctx.lease.id &&
        early.tabId === id &&
        early.expiresAt >= clock()
      )
        pending.resolve(early.params);
      let abort;
      const aborted = new Promise((_, reject) => {
        abort = () => {
          // Cancellation is sent to the original invocation, independently of the aborted action signal.
          void chrome.debugger
            .sendCommand({ tabId: id }, "WebMCP.cancelInvocation", {
              invocationId: response.invocationId,
            })
            .then(
              () => reject(ctx.signal.reason),
              () =>
                reject(
                  new BrowserActionError(
                    "UNKNOWN_RESULT",
                    "The native WebMCP cancellation is not confirmed.",
                    { dispatched: true, effect: "unknown" },
                  ),
                ),
            );
        };
        ctx.signal?.addEventListener("abort", abort, { once: true });
        if (ctx.signal?.aborted) abort();
      });
      try {
        const result = await Promise.race([pending.promise, aborted]);
        ctx.signal?.throwIfAborted();
        requireValue(
          result.status === "Completed",
          result.status === "Canceled" ? "UNKNOWN_RESULT" : "INVALID_ARGUMENT",
          "The native WebMCP invocation did not complete successfully.",
        );
        requireValue(
          encoder.encode(JSON.stringify(result.output ?? null)).byteLength <=
            1024 * 1024,
          "OUTPUT_TOO_LARGE",
          "The WebMCP result exceeds its inline data budget.",
        );
        return result.output ?? null;
      } finally {
        ctx.signal?.removeEventListener("abort", abort);
        webMcpPending.delete(response.invocationId);
      }
    },
    async evaluate(ctx, expression, arg) {
      text(expression, 65536);
      const serialized = JSON.stringify(arg ?? null);
      requireValue(encoder.encode(serialized).byteLength <= 1024 * 1024);
      const result = await router.send(ctx, "Runtime.evaluate", {
        expression: `(async()=>{const value=(${expression});return typeof value==="function"?await value(${serialized}):value})()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      requireValue(
        !result.exceptionDetails,
        "INVALID_ARGUMENT",
        "The page expression rejected.",
      );
      return result.result?.value ?? null;
    },
    async screenshot(ctx, input) {
      requireValue(!(input.fullPage && input.clip));
      const quality = input.quality ?? 80,
        maxEdgePx = input.maxEdgePx ?? 1920;
      requireValue(
        Number.isInteger(quality) &&
          quality >= 0 &&
          quality <= 100 &&
          Number.isInteger(maxEdgePx) &&
          maxEdgePx > 0 &&
          maxEdgePx <= 16384,
      );
      const metrics = await router.send(ctx, "Page.getLayoutMetrics", {});
      const size = input.fullPage
        ? (metrics.cssContentSize ?? metrics.contentSize)
        : (metrics.cssVisualViewport ?? metrics.visualViewport);
      const clip = input.clip ?? {
        x: size.pageX ?? 0,
        y: size.pageY ?? 0,
        width: size.width ?? size.clientWidth,
        height: size.height ?? size.clientHeight,
      };
      requireValue(
        [clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) &&
          clip.x >= 0 &&
          clip.y >= 0 &&
          clip.width > 0 &&
          clip.height > 0,
      );
      const scale = Math.min(1, maxEdgePx / Math.max(clip.width, clip.height));
      requireValue(
        clip.width * clip.height * scale * scale <= 40000000,
        "OUTPUT_TOO_LARGE",
        "The screenshot exceeds its decoded-pixel budget.",
      );
      const result = await router.send(ctx, "Page.captureScreenshot", {
        format: "jpeg",
        quality,
        captureBeyondViewport: !!input.fullPage,
        clip: { ...clip, scale },
      });
      requireValue(
        typeof result.data === "string" &&
          result.data.length <= Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4,
        "OUTPUT_TOO_LARGE",
        "The encoded screenshot exceeds its byte budget.",
      );
      const decoded = atob(result.data);
      requireValue(
        decoded.length <= 10 * 1024 * 1024,
        "OUTPUT_TOO_LARGE",
        "The image exceeds its inline byte budget.",
      );
      const data = new Uint8Array(decoded.length);
      for (let i = 0; i < data.length; i++) data[i] = decoded.charCodeAt(i);
      return data;
    },
    actionResult(ctx, id = ctx.target.tabId, before = version(id)) {
      return {
        ok: true,
        operationId: ctx.operationId,
        target: target(String(id), ctx.lease),
        changed: before !== version(id),
      };
    },
    async poll(ctx, predicate) {
      while (performance.now() - ctx.started < ctx.budgetMs) {
        ctx.signal?.throwIfAborted();
        if (await predicate()) return;
        await sleep(
          Math.min(
            ctx.pollingMs ?? 50,
            ctx.budgetMs - (performance.now() - ctx.started),
          ),
          ctx.signal,
        );
      }
      throw new BrowserActionError(
        "TIMEOUT",
        "The browser condition was not observed before its deadline.",
        { dispatched: true, effect: "unknown" },
      );
    },
    async waitForCondition(ctx, args) {
      const condition = record(args.condition),
        remaining = ctx.budgetMs - (performance.now() - ctx.started),
        timeoutMs = condition.timeoutMs ?? remaining,
        pollingMs = condition.pollingMs ?? 50;
      requireValue(
        Number.isFinite(timeoutMs) &&
          timeoutMs > 0 &&
          Number.isFinite(pollingMs) &&
          pollingMs >= 1,
      );
      const scoped = {
        ...ctx,
        started: performance.now(),
        budgetMs: Math.min(timeoutMs, remaining),
        pollingMs,
      };
      const payload = {
        framePath: args.framePath ?? [],
        condition,
        command: "waitProbe",
      };
      const first = await router.page(scoped, payload);
      const state =
        condition.kind === "state"
          ? condition.state
          : condition.kind === "navigation"
            ? (condition.waitUntil ?? "load")
            : null;
      if (state)
        requireValue(
          ["commit", "load", "domcontentloaded", "networkidle"].includes(state),
        );
      let idle = () => false;
      if (state === "networkidle") {
        const after = eventSequence;
        const setup = async ({ frameId, native }) => {
          await native("Page.enable", {});
          await native("Page.setLifecycleEventsEnabled", { enabled: true });
          const sessionId = router.frameSource(ctx, frameId)?.[0];
          idle = () =>
            eventBuffer.some(
              ({ event }) =>
                event.sequence > after &&
                event.method === "Page.lifecycleEvent" &&
                event.params?.name === "networkIdle" &&
                event.params?.frameId === frameId &&
                event.source.tabId === ctx.target.tabId &&
                event.source.sessionId === sessionId &&
                event.source.controlEpoch === ctx.target.controlEpoch,
            );
        };
        if (payload.framePath.length)
          await framePage(scoped, payload, payload.framePath, setup);
        else {
          const tree = await router.send(scoped, "Page.getFrameTree", {});
          await setup({
            frameId: tree.frameTree?.frame?.id,
            native: (method, params) => router.send(scoped, method, params),
          });
        }
      }
      await router.poll(scoped, async () => {
        const value = await router.page(scoped, payload);
        if (!value.matched) return false;
        if (
          condition.kind === "navigation" &&
          value.documentToken === first.documentToken
        )
          return false;
        return (
          !state ||
          state === "commit" ||
          (state === "networkidle" && idle()) ||
          (state === "load" && value.readyState === "complete") ||
          (state === "domcontentloaded" &&
            ["interactive", "complete"].includes(value.readyState))
        );
      });
      return {
        matched: true,
        snapshot: {
          ...router.target(ctx.target.tabId, ctx.lease),
          ...(await router.page(scoped, {
            framePath: payload.framePath,
            command: "snapshot",
          })),
        },
      };
    },
    eventCursor(ctx) {
      return JSON.stringify({
        generation: binding.generation,
        tabId: ctx.target.tabId,
        controlEpoch: ctx.target.controlEpoch,
        sequence: eventSequence,
      });
    },
    events(ctx, input) {
      let after = input.afterSequence ?? eventSequence;
      if (input.cursor !== undefined) {
        let cursor;
        try {
          cursor = JSON.parse(input.cursor);
        } catch {
          throw new BrowserActionError(
            "INVALID_ARGUMENT",
            "The event cursor is invalid.",
          );
        }
        requireValue(
          cursor.generation === binding.generation &&
            cursor.tabId === ctx.target.tabId &&
            cursor.controlEpoch === ctx.target.controlEpoch,
          "STALE_REF",
          "The event cursor belongs to another target.",
        );
        after = cursor.sequence;
      }
      requireValue(
        Number.isInteger(after) &&
          after >= 0 &&
          (!input.methods ||
            (Array.isArray(input.methods) &&
              input.methods.length > 0 &&
              input.methods.every((v) => typeof v === "string"))),
      );
      const limit = input.limit ?? 100;
      requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 1000);
      const matches = eventBuffer
        .map((v) => v.event)
        .filter(
          (e) =>
            e.source.tabId === ctx.target.tabId &&
            e.source.controlEpoch === ctx.target.controlEpoch &&
            e.sequence > after &&
            (!input.methods || input.methods.includes(e.method)) &&
            (!input.target ||
              (input.target.sessionId
                ? e.source.sessionId === input.target.sessionId
                : e.source.targetId === input.target.targetId)),
        );
      const events = matches.slice(0, limit),
        sequence = events.at(-1)?.sequence ?? eventSequence;
      return {
        cursor: sequence,
        events,
        nextCursor: JSON.stringify({
          generation: binding.generation,
          tabId: ctx.target.tabId,
          controlEpoch: ctx.target.controlEpoch,
          sequence,
        }),
        hasMore: matches.length > events.length,
        truncated:
          eventTruncated &&
          after < (eventBuffer[0]?.event.sequence ?? eventSequence),
      };
    },
    dialog(ctx) {
      const value = dialogs.get(String(ctx.target.tabId));
      return value &&
        value.controlEpoch === ctx.lease.epochs?.get(nativeId(ctx.target.tabId))
        ? {
            dialogId: value.id,
            pageVersion: value.pageVersion,
            type: value.type,
            message: value.message,
            target: target(ctx.target.tabId, ctx.lease),
          }
        : null;
    },
    async handleDialog(ctx, accept, args) {
      const current = dialogs.get(String(ctx.target.tabId));
      requireValue(
        current &&
          current.id === (args.id ?? args.dialogId) &&
          args.pageVersion === current.pageVersion &&
          current.pageVersion === version(ctx.target.tabId) &&
          current.controlEpoch ===
            ctx.lease.epochs?.get(nativeId(ctx.target.tabId)),
        "STALE_REF",
        "The observed dialog is no longer current.",
      );
      requireValue(args.text === undefined || current.type === "prompt");
      await router.send(ctx, "Page.handleJavaScriptDialog", {
        accept,
        ...(args.text === undefined ? {} : { promptText: args.text }),
      });
      return router.actionResult(ctx);
    },
    logs(ctx, input) {
      const limit = input.limit ?? 100;
      requireValue(Number.isInteger(limit) && limit > 0 && limit <= 1000);
      requireValue(
        input.since === undefined ||
          (Number.isFinite(input.since) && input.since >= 0),
      );
      const levels = input.levels?.map((value) =>
        value === "warning" ? "warn" : value,
      );
      return logs
        .filter(
          (entry) =>
            entry.tabId === nativeId(ctx.target.tabId) &&
            (!levels || levels.includes(entry.level)) &&
            (input.since === undefined ||
              Date.parse(entry.timestamp) >= input.since) &&
            (!input.filter || entry.message.includes(input.filter)),
        )
        .slice(-limit)
        .map(({ tabId: _, ...entry }) => entry);
    },
    audit(input) {
      const limit = input.limit ?? 100,
        cursor = input.cursor === undefined ? 0 : Number(input.cursor);
      requireValue(
        Number.isInteger(limit) &&
          limit >= 1 &&
          limit <= 100 &&
          Number.isInteger(cursor) &&
          cursor >= 0,
      );
      return {
        changes: auditEntries.slice(cursor, cursor + limit),
        ...(cursor + limit < auditEntries.length
          ? { nextCursor: String(cursor + limit) }
          : {}),
      };
    },
    async releaseTab(ctx) {
      const id = nativeId(ctx.target.tabId),
        lease = ctx.lease;
      lease.handedOff.add(id);
      for (const waiter of waiters.values())
        if (waiter.leaseId === lease.id && waiter.tabId === id)
          cancelWaiter(waiter);
      for (const [actionId, controller] of lease.controllers)
        if (actionId !== ctx.actionId && controller.tabId === ctx.target.tabId)
          controller.stop.abort(
            new BrowserActionError(
              "UNKNOWN_RESULT",
              "The tab is being handed back to the user.",
              { dispatched: true, effect: "unknown" },
            ),
          );
      await Promise.resolve();
      await Promise.allSettled(
        [...lease.pending]
          .filter(
            ([, info]) =>
              info.tabId === ctx.target.tabId && info.actionId !== ctx.actionId,
          )
          .map(([task]) => task),
      );
      for (const [token, stage] of lease.clipboardStages ?? [])
        if (nativeId(stage.tabId) === id)
          await router.clipboardPage(ctx, { command: "drop", token }, true);
      if (lease.attached.has(id) || lease.intents.has(id)) ctx.dispatched();
      await releaseControl(lease, id);
      if (visual)
        await visual.releaseTab({
          ...router.visualContext(ctx),
          signal: undefined,
          deadline: Date.now() + 250,
          result: true,
        });
      if (owners.get(id) === lease.id) owners.delete(id);
      lease.tabs.delete(id);
      return { released: true, target: target(ctx.target.tabId, ctx.lease) };
    },
    visualContext(ctx) {
      const remaining = Math.max(
        1,
        ctx.budgetMs - (performance.now() - ctx.started),
      );
      const result = {
        leaseId: ctx.lease.id,
        runId: ctx.runId,
        operationId: ctx.operationId,
        target: { ...ctx.target, pageVersion: version(ctx.target.tabId) },
        signal: ctx.signal,
        deadline: Date.now() + remaining,
        followSessionTab: router.followSessionTab,
      };
      (ctx.lease.visualContexts ??= new Map()).set(nativeId(ctx.target.tabId), {
        ...result,
        signal: undefined,
      });
      return result;
    },
    async prepareVisual(ctx) {
      try {
        await visual?.beforeAction(router.visualContext(ctx));
      } catch {
        ctx.signal?.throwIfAborted();
        emit({
          type: "event",
          event: "visual_degraded",
          runId: ctx.runId,
          operationId: ctx.operationId,
          target: ctx.target,
          reason: "VISUAL_UNAVAILABLE",
        });
      }
    },
    async preparePointer(ctx, point) {
      if (
        ctx.lastVisualPoint?.x === point.x &&
        ctx.lastVisualPoint?.y === point.y
      )
        return;
      const first = ctx.lastVisualPoint === undefined;
      ctx.lastVisualPoint = point;
      ctx.lease.visualSequence = (ctx.lease.visualSequence ?? 0) + 1;
      try {
        await visual?.beforePointer({
          ...router.visualContext(ctx),
          point,
          moveSequence: ctx.lease.visualSequence,
          wait: first,
        });
      } catch {
        ctx.signal?.throwIfAborted();
        emit({
          type: "event",
          event: "visual_degraded",
          runId: ctx.runId,
          operationId: ctx.operationId,
          target: ctx.target,
          reason: "VISUAL_UNAVAILABLE",
        });
      }
    },
    async markDeliverable(ctx) {
      requireValue(
        visual,
        "CAPABILITY_NOT_ALLOWED",
        "This browser build has no native result-marker controller.",
      );
      const result = await visual.markDeliverable(router.visualContext(ctx));
      requireValue(
        !result.degraded,
        "CAPABILITY_NOT_ALLOWED",
        "The native result marker was not applied to this actual page.",
      );
      return null;
    },
    async nameVisualSession(ctx, name) {
      if (visual)
        await visual.nameSession({
          leaseId: ctx.lease.id,
          runId: ctx.runId,
          operationId: ctx.operationId,
          target: ctx.target,
          signal: ctx.signal,
          deadline:
            Date.now() +
            Math.max(1, ctx.budgetMs - (performance.now() - ctx.started)),
          name,
        });
    },
    async startVisual(browserSessionId, markers) {
      await visual?.start({ browserSessionId, markers });
    },
    async resumeUserControl(ctx) {
      const id = nativeId(ctx.target.tabId),
        lease = ctx.lease;
      requireValue(
        lease.handedOff.has(id) && !lease.revoked,
        "INVALID_TARGET",
        "Only this run's explicitly handed-off target can be resumed.",
      );
      requireValue(
        ctx.target.controlEpoch === lease.epochs?.get(id),
        "STALE_REF",
        "The resume request does not identify the original control epoch.",
      );
      requireValue(
        !owners.has(id) || owners.get(id) === lease.id,
        "TAB_ALREADY_CLAIMED",
        "Another run now controls the handed-off target.",
      );
      const tab = await ctx.chrome.tabs.get(id);
      requireValue(
        !tab.incognito && /^https?:/.test(tab.url ?? ""),
        "CAPABILITY_NOT_ALLOWED",
        "The actual current page is not available for resumed browser control.",
      );
      const native = await ctx.chrome.debugger.getTargets();
      requireValue(
        !native.some((target) => target.tabId === id && target.attached),
        "CDP_DISCONNECTED",
        "A native debugger already controls the handed-off target.",
      );
      const frames = await ctx.chrome.webNavigation.getAllFrames({ tabId: id });
      const main = frames?.find((frame) => frame.frameId === 0);
      requireValue(
        main && typeof main.documentId === "string" && main.url === tab.url,
        "STALE_REF",
        "The native current document could not be observed consistently.",
      );
      active(lease);
      ctx.signal?.throwIfAborted();
      requireValue(
        lease.handedOff.has(id) &&
          (!owners.has(id) || owners.get(id) === lease.id),
        "TAB_ALREADY_CLAIMED",
        "The target ownership changed during native resume observation.",
      );
      (lease.epochs ??= new Map()).set(id, crypto.randomUUID());
      lease.handedOff.delete(id);
      lease.externallyDetached.delete(id);
      owners.set(id, lease.id);
      lease.tabs.add(id);
      dialogs.delete(String(id));
      for (const [key, value] of lease.choosers)
        if (value.tabId === id) lease.choosers.delete(key);
      for (const [key, value] of lease.axReferences ?? [])
        if (value.tabId === String(id)) lease.axReferences.delete(key);
      return {
        resumed: true,
        target: target(String(id), lease),
        document: {
          url: tab.url,
          documentId: main.documentId,
          frameCount: frames.length,
        },
      };
    },
    async navigate(ctx, method, url, input) {
      const id = nativeId(ctx.target.tabId),
        before = version(id);
      const info = await router.armWaiter(ctx, {
        event: "navigation",
        waitUntil: input.waitUntil ?? "load",
        timeoutMs: Math.min(input.timeoutMs ?? ctx.budgetMs, ctx.budgetMs),
        ...(url ? { url } : {}),
      });
      try {
        ctx.signal?.throwIfAborted();
        if (method === "navigate") await chrome.tabs.update(id, { url });
        else await chrome.tabs[method](id);
        await router.getWaiter(ctx, info.id);
        return router.actionResult(ctx, id, before);
      } finally {
        await router.cancelWaiter(ctx, info.id);
      }
    },
    async waitForLoadState(ctx, input) {
      const state = input.state ?? "load";
      requireValue(["load", "domcontentloaded", "networkidle"].includes(state));
      const timeoutMs = input.timeoutMs ?? ctx.budgetMs;
      requireValue(Number.isFinite(timeoutMs) && timeoutMs > 0);
      const scoped = {
        ...ctx,
        started: performance.now(),
        budgetMs: Math.min(
          timeoutMs,
          Math.max(0, ctx.budgetMs - (performance.now() - ctx.started)),
        ),
      };
      requireValue(
        scoped.budgetMs > 0,
        "TIMEOUT",
        "The page load deadline already elapsed.",
      );
      if (state !== "networkidle") {
        await router.poll(scoped, async () => {
          const ready = await router.page(scoped, { command: "readyState" });
          return state === "load"
            ? ready === "complete"
            : ready === "interactive" || ready === "complete";
        });
      } else {
        // Only the browser's actual main-frame networkIdle lifecycle event can establish this state.
        const waiter = await router.armWaiter(scoped, {
          event: "navigation",
          waitUntil: "networkidle",
          timeoutMs: scoped.budgetMs,
        });
        try {
          await router.getWaiter(scoped, waiter.id);
        } finally {
          await router.cancelWaiter(scoped, waiter.id);
        }
      }
      return null;
    },
    async armWaiter(ctx, input) {
      requireValue(
        ["navigation", "download", "filechooser"].includes(input.event),
      );
      if (input.event === "navigation")
        requireValue(
          ["commit", "domcontentloaded", "load", "networkidle"].includes(
            input.waitUntil ?? "load",
          ),
        );
      const timeoutMs = input.timeoutMs ?? Math.min(30000, ctx.budgetMs);
      requireValue(
        Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647,
      );
      const tabId = nativeId(ctx.target.tabId);
      requireValue(
        [...waiters.values()].filter(
          (v) => v.leaseId === ctx.lease.id && v.tabId === tabId && !v.settled,
        ).length < 32,
        "QUEUE_FULL",
        "This run target already has 32 active event waiters.",
      );
      for (const [id, previous] of waiters)
        if (previous.settled && previous.expiresAt < clock())
          waiters.delete(id);
      requireValue(
        waiters.size < 1024,
        "QUEUE_FULL",
        "The browser event receipt budget is full.",
      );
      const pending = Promise.withResolvers();
      void pending.promise.catch(() => {});
      const waiter = {
        ...pending,
        id: `waiter_${crypto.randomUUID()}`,
        leaseId: ctx.lease.id,
        runId: ctx.runId,
        tabId,
        controlEpoch: ctx.target.controlEpoch,
        event: input.event,
        url: input.url,
        waitUntil: input.waitUntil ?? "load",
        expiresAt: clock() + timeoutMs,
        settled: false,
        cancelled: false,
        ready: false,
      };
      waiters.set(waiter.id, waiter);
      waiter.timer = setTimeout(
        () =>
          settleWaiter(
            waiter,
            undefined,
            new BrowserActionError(
              "TIMEOUT",
              "The browser event was not observed before its deadline.",
            ),
          ),
        timeoutMs,
      );
      try {
        await router.send(ctx, "Page.enable", {});
        if (input.event === "filechooser") {
          await syncChooserIntercept(ctx.lease, tabId);
        }
        if (
          input.event === "navigation" &&
          waiter.waitUntil === "networkidle"
        ) {
          const frame = await router.send(ctx, "Page.getFrameTree", {});
          waiter.frameId = frame.frameTree.frame.id;
          await router.send(ctx, "Page.setLifecycleEventsEnabled", {
            enabled: true,
          });
        }
        ctx.signal?.throwIfAborted();
        if (waiter.error) throw waiter.error;
        waiter.ready = true;
        return {
          id: waiter.id,
          target: target(String(tabId), ctx.lease),
          expiresAt: waiter.expiresAt,
        };
      } catch (cause) {
        cancelWaiter(waiter);
        if (input.event === "filechooser")
          await syncChooserIntercept(ctx.lease, tabId);
        waiters.delete(waiter.id);
        throw cause;
      }
    },
    async getWaiter(ctx, id) {
      const waiter = waiters.get(id);
      requireValue(
        waiter &&
          waiter.leaseId === ctx.lease.id &&
          waiter.runId === ctx.runId &&
          String(waiter.tabId) === ctx.target.tabId &&
          waiter.controlEpoch === ctx.target.controlEpoch,
        "WAITER_GONE",
        "The event waiter does not belong to this run and target.",
      );
      if (waiter.value) return waiter.value;
      if (waiter.error) throw waiter.error;
      ctx.signal?.throwIfAborted();
      if (!ctx.signal) return waiter.promise;
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(ctx.signal.reason);
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([waiter.promise, aborted]);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
    async cancelWaiter(ctx, id) {
      const waiter = waiters.get(id);
      requireValue(
        waiter &&
          waiter.leaseId === ctx.lease.id &&
          waiter.runId === ctx.runId &&
          String(waiter.tabId) === ctx.target.tabId &&
          waiter.controlEpoch === ctx.target.controlEpoch,
        "WAITER_GONE",
        "The event waiter does not belong to this run and target.",
      );
      cancelWaiter(waiter);
      if (waiter.event === "filechooser")
        await syncChooserIntercept(ctx.lease, waiter.tabId);
      return { cancelled: true };
    },
    downloads(ctx) {
      return [...downloadRecords.values()]
        .filter(
          (v) =>
            v.leaseId === ctx.lease.id &&
            v.target.tabId === ctx.target.tabId &&
            v.target.controlEpoch === ctx.target.controlEpoch,
        )
        .map(
          ({
            id,
            target: source,
            suggestedFilename,
            url,
            state,
            bytesReceived,
            totalBytes,
          }) => ({
            id,
            target: source,
            suggestedFilename,
            url,
            state,
            bytesReceived,
            ...(totalBytes === undefined ? {} : { totalBytes }),
          }),
        );
    },
    async downloadPath(ctx, id) {
      const value = downloadRecords.get(id);
      requireValue(
        value &&
          value.leaseId === ctx.lease.id &&
          value.target.tabId === ctx.target.tabId &&
          value.target.controlEpoch === ctx.target.controlEpoch,
        "FILE_UNAVAILABLE",
        "The original download is not owned by this run target.",
      );
      // Page's GUID proves the original target; downloads.search exposes a
      // different integer ID without that GUID. URL/time/name matching cannot
      // authorize a local file, including a single currently visible match.
      // Do not read an unrelated user's download or refetch the original URL.
      throw new BrowserActionError(
        "CAPABILITY_NOT_ALLOWED",
        "This browser transport cannot prove the original download's local file identity.",
      );
    },
    async recoverOwnedControls(records) {
      requireValue(
        Array.isArray(records) && records.length <= 10000,
        "PROTOCOL_MISMATCH",
        "The saved native attachment journal is invalid.",
      );
      for (const saved of records) {
        record(saved);
        const id = nativeId(String(saved.tabId));
        text(saved.leaseId, 256);
        text(saved.runId, 256);
        let lease = leases.get(saved.leaseId);
        if (!lease) {
          lease = {
            id: saved.leaseId,
            runId: saved.runId,
            originalGeneration: saved.generation,
            metadata: fields(saved, [
              "leaseId",
              "runId",
              "operationId",
              "connectionId",
              "generation",
              "target",
            ]),
            tabs: new Set(),
            handedOff: new Set(),
            attached: new Set(),
            detaching: new Set(),
            intents: new Set(),
            attaching: new Map(),
            pending: new Map(),
            controllers: new Map(),
            fileChoosers: new Set(),
            choosers: new Map(),
            buttons: new Map(),
            keys: new Map(),
            viewports: new Set(),
            externallyDetached: new Set(),
            unconfirmedControls: false,
            ended: true,
            revoked: false,
            closed: false,
            closing: null,
          };
          leases.set(lease.id, lease);
        }
        requireValue(
          lease.runId === saved.runId,
          "PROTOCOL_MISMATCH",
          "A saved lease identity was rebound.",
        );
        lease.tabs.add(id);
        requireValue(
          saved.attachmentIntent === undefined ||
            typeof saved.attachmentIntent === "boolean",
          "PROTOCOL_MISMATCH",
          "The saved attachment intent is invalid.",
        );
        if (saved.attachmentIntent !== false) lease.intents.add(id);
        owners.set(id, lease.id);
        requireValue(
          saved.temporary === undefined || typeof saved.temporary === "boolean",
          "PROTOCOL_MISMATCH",
          "The saved temporary-tab ownership is invalid.",
        );
        if (saved.temporary) (lease.temporaryTabs ??= new Set()).add(id);
        const clipboardStages = saved.clipboardStages ?? [];
        requireValue(
          Array.isArray(clipboardStages) && clipboardStages.length <= 32,
          "PROTOCOL_MISMATCH",
          "The saved clipboard stages are invalid.",
        );
        for (const stage of clipboardStages) {
          record(stage, ["token", "pageVersion", "kind"]);
          text(stage.token, 512);
          requireValue(
            Number.isSafeInteger(stage.pageVersion) && stage.pageVersion > 0,
            "PROTOCOL_MISMATCH",
            "The saved clipboard document is invalid.",
          );
          requireValue(
            stage.kind === undefined ||
              ["clipboard", "page-data"].includes(stage.kind),
            "PROTOCOL_MISMATCH",
            "The saved native staging kind is invalid.",
          );
          (lease.clipboardStages ??= new Map()).set(stage.token, {
            tabId: String(id),
            pageVersion: stage.pageVersion,
            recovered: true,
            kind: stage.kind ?? "clipboard",
          });
        }
        const streams = saved.streams ?? [];
        requireValue(
          Array.isArray(streams) &&
            streams.length <= 64 &&
            (!streams.length || saved.attachmentIntent !== false),
          "PROTOCOL_MISMATCH",
          "The saved native stream handles are invalid.",
        );
        for (const handle of streams) text(handle, 1024);
        if (streams.length)
          (lease.nativeStreams ??= new Map()).set(id, new Set(streams));
        for (const [field, maximum, allowed] of [
          [
            "keys",
            128,
            [
              "key",
              "code",
              "windowsVirtualKeyCode",
              "nativeVirtualKeyCode",
              "location",
            ],
          ],
          ["buttons", 20, ["x", "y", "button"]],
        ]) {
          const entries = saved[field] ?? [];
          requireValue(
            Array.isArray(entries) && entries.length <= maximum,
            "PROTOCOL_MISMATCH",
            "The saved input-control ledger is invalid.",
          );
          const restored = new Map();
          for (const entry of entries) {
            record(entry, ["source", "params"]);
            record(entry.source, ["tabId", "sessionId"]);
            record(entry.params, allowed);
            requireValue(
              entry.source.tabId === id &&
                (entry.source.sessionId === undefined ||
                  (typeof entry.source.sessionId === "string" &&
                    entry.source.sessionId.length <= 512)),
              "PROTOCOL_MISMATCH",
              "A saved input control changed its native target.",
            );
            if (field === "keys") {
              requireValue(
                (typeof entry.params.key === "string" &&
                  entry.params.key.length <= 128) ||
                  (typeof entry.params.code === "string" &&
                    entry.params.code.length <= 128) ||
                  Number.isInteger(entry.params.windowsVirtualKeyCode),
                "PROTOCOL_MISMATCH",
                "A saved key is not identifiable.",
              );
              restored.set(keyToken(entry.params, entry.source), {
                source: { ...entry.source },
                params: { ...entry.params },
              });
            } else {
              requireValue(
                ["left", "right", "middle", "back", "forward"].includes(
                  entry.params.button,
                ) &&
                  Number.isFinite(entry.params.x) &&
                  Number.isFinite(entry.params.y),
                "PROTOCOL_MISMATCH",
                "A saved mouse button is invalid.",
              );
              restored.set(
                `${entry.source.sessionId ?? ""}\0${entry.params.button}`,
                { source: { ...entry.source }, params: { ...entry.params } },
              );
            }
          }
          lease[field].set(id, restored);
        }
        requireValue(
          saved.viewport === undefined || typeof saved.viewport === "boolean",
          "PROTOCOL_MISMATCH",
          "The saved viewport control is invalid.",
        );
        if (saved.viewport) lease.viewports.add(id);
        requireValue(
          saved.externallyDetached === undefined ||
            typeof saved.externallyDetached === "boolean",
          "PROTOCOL_MISMATCH",
          "The saved native-detach fact is invalid.",
        );
        if (saved.externallyDetached) lease.externallyDetached.add(id);
      }
      const result = [];
      for (const lease of [...leases.values()])
        result.push({
          lease: lease.metadata,
          receipt: await router.endLease(lease.id),
        });
      return result;
    },
    async dispose() {
      if (disposing) return disposing;
      stopped = true;
      disposing = (async () => {
        const results = await Promise.allSettled(
          [...leases.keys()].map((id) => router.endLease(id)),
        );
        const rejected = results.find((v) => v.status === "rejected");
        if (rejected) {
          disposing = undefined;
          throw rejected.reason;
        }
        for (const remove of listeners.splice(0)) remove();
        await visual?.dispose();
      })();
      return disposing;
    },
  };
  return router;
}
