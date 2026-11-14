/** Exact public data routes. Each row becomes a distinct managed method/Schema, never an invoke tunnel. */
export interface BrowserRouteDefinition {
  readonly path: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
type Schema = Record<string, unknown>;
const string: Schema = { type: "string", maxLength: 65536 };
const id: Schema = { type: "string", minLength: 1, maxLength: 256 };
const bool: Schema = { type: "boolean" };
const number: Schema = { type: "number" };
const integer: Schema = { type: "integer" };
const timeout: Schema = { type: "number", minimum: 0 };
const enumOf = (...values: string[]): Schema => ({ enum: values });
const array = (items: Schema, maxItems = 128): Schema => ({
  type: "array",
  items,
  maxItems,
});
const object = (
  properties: Record<string, Schema>,
  required: readonly string[] = [],
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const optionalObject = (properties: Record<string, Schema>) =>
  object(properties);
const point = object({ x: number, y: number }, ["x", "y"]);
const rect = object(
  {
    x: number,
    y: number,
    width: { type: "number", exclusiveMinimum: 0 },
    height: { type: "number", exclusiveMinimum: 0 },
  },
  ["x", "y", "width", "height"],
);
const modifiers = array(
  enumOf("Alt", "Control", "ControlOrMeta", "Meta", "Shift"),
  5,
);
const navigation = optionalObject({
  timeoutMs: timeout,
  waitUntil: enumOf("load", "domcontentloaded", "networkidle", "commit"),
});
const timed = optionalObject({ timeoutMs: timeout });
const targetProperties = {
  browserId: id,
  bootId: id,
  browserSessionId: id,
  generation: { type: "integer", minimum: 1 },
  tabId: id,
  controlEpoch: { ...id, pattern: "^[^\\u0000\\r\\n]+$" },
  pageVersion: { type: "integer", minimum: 0 },
};
const browserTarget = object(targetProperties, [
  "browserId",
  "bootId",
  "browserSessionId",
  "generation",
]);
const tabTarget = object(targetProperties, [
  "browserId",
  "bootId",
  "browserSessionId",
  "generation",
  "tabId",
]);
const matcher = {
  anyOf: [
    object({ kind: { const: "text" }, value: string, exact: bool }, [
      "kind",
      "value",
    ]),
    object(
      {
        kind: { const: "regexp" },
        source: { type: "string", maxLength: 1024 },
        flags: { type: "string", pattern: "^[dgimsuvy]*$" },
      },
      ["kind", "source", "flags"],
    ),
  ],
};
const queryRef: Schema = { $ref: "#/definitions/LocatorData" };
const locatorData: Schema = {
  anyOf: [
    object({ kind: { const: "selector" }, selector: string }, [
      "kind",
      "selector",
    ]),
    object({ kind: { const: "role" }, role: id, name: matcher, exact: bool }, [
      "kind",
      "role",
    ]),
    object({ kind: enumOf("label", "placeholder", "text"), matcher }, [
      "kind",
      "matcher",
    ]),
    object({ kind: { const: "testId" }, value: string }, ["kind", "value"]),
    object({ kind: { const: "descendant" }, root: queryRef, query: queryRef }, [
      "kind",
      "root",
      "query",
    ]),
    object({ kind: enumOf("and", "or"), left: queryRef, right: queryRef }, [
      "kind",
      "left",
      "right",
    ]),
    object(
      {
        kind: { const: "position" },
        query: queryRef,
        at: {
          anyOf: [enumOf("first", "last"), { type: "integer", minimum: 0 }],
        },
      },
      ["kind", "query", "at"],
    ),
    object(
      {
        kind: { const: "filter" },
        query: queryRef,
        has: queryRef,
        hasNot: queryRef,
        hasText: matcher,
        hasNotText: matcher,
        visible: bool,
      },
      ["kind", "query"],
    ),
    object(
      {
        kind: { const: "ref" },
        ref: id,
        pageVersion: { type: "integer", minimum: 0 },
      },
      ["kind", "ref", "pageVersion"],
    ),
  ],
};
const locator = object(
  { target: tabTarget, framePath: array(string, 8), query: queryRef },
  ["target", "framePath", "query"],
);
const fileSource = {
  anyOf: [
    object({ path: string, name: id, mimeType: id }, ["path"]),
    object({ data: {}, name: id, mimeType: id }, ["data", "name"]),
  ],
};
const files = array(fileSource, 128);
const fileChooserFiles = {
  anyOf: [string, array({ anyOf: [string, fileSource] }, 128)],
};
const selection = {
  anyOf: [
    string,
    object({
      index: { type: "integer", minimum: 0 },
      label: string,
      value: string,
    }),
  ],
};
const selections = { anyOf: [selection, array(selection)] };
const click = optionalObject({
  button: enumOf("left", "right", "middle"),
  clickCount: { type: "integer", minimum: 1, maximum: 3 },
  position: point,
  modifiers,
  timeoutMs: timeout,
});
const screenshot = optionalObject({
  clip: rect,
  fullPage: bool,
  quality: { type: "integer", minimum: 0, maximum: 100 },
  maxEdgePx: { type: "integer", minimum: 1 },
});
const axState = optionalObject({ disableDiffing: bool });
const axPoint = { anyOf: [integer, point] };
const axIndex = { anyOf: [{ type: "null" }, integer] };
const duration = { type: "number", minimum: 0, maximum: 30 };
const clipboardEntry = {
  anyOf: [
    object({ mimeType: id, text: string }, ["mimeType", "text"]),
    object({ mimeType: id, data: {} }, ["mimeType", "data"]),
  ],
};
const clipboardItems = array(
  object(
    {
      entries: array(clipboardEntry, 32),
      presentationStyle: enumOf("unspecified", "inline", "attachment"),
    },
    ["entries"],
  ),
  32,
);
const waitCondition = {
  allOf: [
    {
      anyOf: [
        object(
          {
            kind: { const: "element" },
            selector: string,
            state: enumOf("attached", "detached", "visible", "hidden"),
            timeoutMs: timeout,
            pollingMs: { type: "number", minimum: 1 },
          },
          ["kind", "selector"],
        ),
        object(
          {
            kind: { const: "selector" },
            value: string,
            state: enumOf("attached", "detached", "visible", "hidden"),
            timeoutMs: timeout,
            pollingMs: { type: "number", minimum: 1 },
          },
          ["kind", "value"],
        ),
        object(
          {
            kind: enumOf("text", "url"),
            value: string,
            timeoutMs: timeout,
            pollingMs: { type: "number", minimum: 1 },
          },
          ["kind", "value"],
        ),
        object(
          {
            kind: { const: "navigation" },
            url: string,
            waitUntil: enumOf(
              "load",
              "domcontentloaded",
              "networkidle",
              "commit",
            ),
            timeoutMs: timeout,
            pollingMs: { type: "number", minimum: 1 },
          },
          ["kind"],
        ),
        object(
          {
            kind: { const: "state" },
            state: enumOf("load", "domcontentloaded", "networkidle"),
            timeoutMs: timeout,
            pollingMs: { type: "number", minimum: 1 },
          },
          ["kind", "state"],
        ),
      ],
    },
  ],
};
const cdpTarget = {
  anyOf: [
    object({ sessionId: id }, ["sessionId"]),
    object({ targetId: id }, ["targetId"]),
  ],
};
const routes: BrowserRouteDefinition[] = [];
function route(
  path: string,
  properties: Record<string, Schema> = {},
  required: readonly string[] = [],
) {
  routes.push({
    path,
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      ...object(properties, required),
      ...(Object.hasOwn(properties, "locator")
        ? { definitions: { LocatorData: locatorData } }
        : {}),
    },
  });
}
function browser(
  path: string,
  properties: Record<string, Schema> = {},
  required: readonly string[] = [],
) {
  route(path, { target: browserTarget, ...properties }, [
    "target",
    ...required,
  ]);
}
function tab(
  path: string,
  properties: Record<string, Schema> = {},
  required: readonly string[] = [],
) {
  route(path, { target: tabTarget, ...properties }, ["target", ...required]);
}
function located(
  path: string,
  properties: Record<string, Schema> = {},
  required: readonly string[] = [],
) {
  route(path, { locator, ...properties }, ["locator", ...required]);
}
route("browsers.list");
route("browsers.get", { id }, ["id"]);
route("browsers.getDefault");
route("browsers.getForUrl", { url: string }, ["url"]);
route("documentation.get", { name: string }, ["name"]);
browser("browsers.documentation");
browser("browsers.nameSession", { name: string }, ["name"]);
browser("browsers.history", {
  options: optionalObject({
    from: string,
    to: string,
    queries: array(string, 4),
    limit: { type: "integer", minimum: 1, maximum: 20 },
  }),
});
browser("tabs.list");
browser("tabs.get", { id }, ["id"]);
browser("tabs.new", { url: string, options: optionalObject({ active: bool }) });
browser("tabs.selected");
browser("tabs.select", { id }, ["id"]);
browser(
  "tabs.content",
  {
    options: object(
      {
        urls: array(string, 8),
        contentType: enumOf("html", "text", "domSnapshot"),
        timeoutMs: { type: "number", minimum: 0, maximum: 30000 },
      },
      ["urls", "contentType"],
    ),
  },
  ["options"],
);
browser("user.openTabs");
browser(
  "user.claimTab",
  {
    tab: {
      anyOf: [
        id,
        object(
          {
            id,
            lastOpened: string,
            providerTabId: id,
            tabGroup: id,
            title: string,
            url: string,
          },
          ["id"],
        ),
      ],
    },
  },
  ["tab"],
);
browser("user.getTabContext", {
  tab: {
    anyOf: [
      id,
      object(
        {
          id,
          lastOpened: string,
          providerTabId: id,
          tabGroup: id,
          title: string,
          url: string,
        },
        ["id"],
      ),
    ],
  },
});
for (const name of ["goBack", "forward", "reload"])
  tab(`tab.${name}`, { options: navigation });
tab("tab.navigate", { url: string, options: navigation }, ["url"]);
for (const name of [
  "close",
  "title",
  "url",
  "markDeliverable",
  "markHandoff",
  "getJsDialog",
])
  tab(`tab.${name}`);
tab("tab.requestUserTakeover", {
  reason: enumOf("authentication", "captcha", "user_requested", "other"),
});
tab("tab.screenshot", { options: screenshot });
tab("tab.snapshot", {
  options: optionalObject({
    maxBytes: { type: "integer", minimum: 1 },
    root: id,
    frame: string,
  }),
});
tab("tab.click", { ref: id, options: click }, ["ref"]);
tab("tab.fill", { ref: id, text: string, options: timed }, ["ref", "text"]);
tab(
  "tab.press",
  { key: string, options: optionalObject({ timeoutMs: timeout, modifiers }) },
  ["key"],
);
tab("tab.selectOption", { ref: id, values: selections }, ["ref", "values"]);
tab(
  "tab.scroll",
  {
    options: optionalObject({
      x: number,
      y: number,
      ref: id,
      behavior: enumOf("auto", "smooth"),
    }),
  },
  ["options"],
);
tab("tab.hover", { ref: id, options: timed }, ["ref"]);
tab("tab.focus", { ref: id }, ["ref"]);
tab("tab.waitFor", { condition: waitCondition }, ["condition"]);
tab("tab.evaluate", { expression: string, args: {} }, ["expression"]);
for (const name of ["keyboardDown", "keyboardUp"])
  tab(`tab.${name}`, { key: string }, ["key"]);
tab("tab.frame", { selector: string }, ["selector"]);
tab("tab.dialogAccept", { text: string });
tab("tab.dialogDismiss");
tab(
  "tab.contentExport",
  {
    options: object({ format: enumOf("html", "markdown", "text") }, ["format"]),
  },
  ["options"],
);
tab("tab.setFiles", { ref: id, files }, ["ref", "files"]);
tab("tab.downloads");
tab("tab.saveDownload", { id, path: string }, ["id"]);
tab(
  "tab.setViewport",
  {
    size: object(
      {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
      ["width", "height"],
    ),
  },
  ["size"],
);
tab("tab.resetViewport");
const logs = optionalObject({
  filter: string,
  levels: array(enumOf("debug", "info", "log", "warn", "error", "warning"), 6),
  limit: { type: "integer", minimum: 1, maximum: 1000 },
  since: number,
});
tab("dev.logs", { options: logs });
tab("tab.devLogs", { options: logs });
tab("content.export");
tab(
  "content.exportGsuite",
  { type: enumOf("pdf", "md", "xlsx", "csv", "docx", "pptx") },
  ["type"],
);
tab("content.exportYouTubeTranscript");
tab(
  "tab.exportFile",
  {
    options: object({ format: enumOf("pdf", "html", "markdown") }, ["format"]),
  },
  ["options"],
);
for (const name of ["read", "readText"]) tab(`clipboard.${name}`);
tab("clipboard.write", { items: clipboardItems }, ["items"]);
tab("clipboard.writeText", { text: string }, ["text"]);
tab(
  "ax.click",
  {
    element: axPoint,
    options: optionalObject({
      clickCount: { type: "integer", minimum: 1 },
      duration,
      key: string,
      mouseButton: enumOf("left", "right", "middle", "l", "r", "m"),
    }),
  },
  ["element"],
);
tab("ax.drag", { from: point, to: point }, ["from", "to"]);
for (const name of ["get", "write"])
  tab(`ax.${name}`, {
    mode: enumOf("state", "screenshot", "both"),
    options: axState,
  });
tab("ax.snapshot", { options: axState });
tab(
  "ax.paste",
  {
    elementIndex: axIndex,
    text: string,
    options: optionalObject({ format: enumOf("text", "md", "html") }),
  },
  ["elementIndex", "text"],
);
tab("ax.performSecondaryAction", { elementIndex: integer, action: string }, [
  "elementIndex",
  "action",
]);
tab(
  "ax.pressKey",
  { elementIndex: axIndex, key: string, options: optionalObject({ duration }) },
  ["elementIndex", "key"],
);
tab(
  "ax.scroll",
  {
    element: axPoint,
    direction: enumOf("up", "down", "left", "right", "u", "d", "l", "r"),
    pages: { type: "number", exclusiveMinimum: 0 },
  },
  ["element", "direction"],
);
tab(
  "ax.selectText",
  {
    elementIndex: integer,
    text: string,
    options: optionalObject({
      prefix: string,
      selectionType: enumOf("text", "cursor_before", "cursor_after"),
      suffix: string,
    }),
  },
  ["elementIndex", "text"],
);
tab("ax.setValue", { elementIndex: integer, value: string }, [
  "elementIndex",
  "value",
]);
tab("ax.typeText", { elementIndex: axIndex, text: string }, [
  "elementIndex",
  "text",
]);
for (const name of ["click", "doubleClick"])
  tab(
    `cua.${name}`,
    {
      options: object(
        {
          x: number,
          y: number,
          keypress: array(string, 8),
          ...(name === "click" ? { button: { enum: [1, 2, 3, 4, 5] } } : {}),
        },
        ["x", "y"],
      ),
    },
    ["options"],
  );
tab(
  "cua.downloadMedia",
  { options: object({ x: number, y: number, timeoutMs: timeout }, ["x", "y"]) },
  ["options"],
);
tab(
  "cua.drag",
  {
    options: object({ path: array(point, 1024), keys: array(string, 8) }, [
      "path",
    ]),
  },
  ["options"],
);
tab(
  "cua.keypress",
  { options: object({ keys: array(string, 8), duration }, ["keys"]) },
  ["options"],
);
tab(
  "cua.move",
  {
    options: object({ x: number, y: number, keys: array(string, 8) }, [
      "x",
      "y",
    ]),
  },
  ["options"],
);
tab(
  "cua.scroll",
  {
    options: object(
      {
        x: number,
        y: number,
        scrollX: number,
        scrollY: number,
        keypress: array(string, 8),
      },
      ["x", "y", "scrollX", "scrollY"],
    ),
  },
  ["options"],
);
tab("cua.type", { options: object({ text: string }, ["text"]) }, ["options"]);
for (const name of ["click", "doubleClick"])
  tab(`dom.${name}`, { options: object({ node_id: id }, ["node_id"]) }, [
    "options",
  ]);
tab(
  "dom.downloadMedia",
  { options: object({ node_id: id, timeoutMs: timeout }, ["node_id"]) },
  ["options"],
);
tab("dom.getVisibleTree");
tab("dom.keypress", { options: object({ keys: array(string, 8) }, ["keys"]) }, [
  "options",
]);
tab(
  "dom.scroll",
  { options: object({ node_id: id, x: number, y: number }, ["x", "y"]) },
  ["options"],
);
tab("dom.type", { options: object({ text: string }, ["text"]) }, ["options"]);
tab("dom.fill", { nodeId: id, text: string }, ["nodeId", "text"]);
tab("playwright.domSnapshot");
for (const name of ["elementInfo", "elementScreenshot"])
  tab(
    `playwright.${name}`,
    {
      options: object({ x: number, y: number, includeNonInteractable: bool }, [
        "x",
        "y",
      ]),
    },
    ["options"],
  );
tab("playwright.evaluate", { expression: string, arg: {}, options: timed }, [
  "expression",
]);
tab("playwright.waitForLoadState", {
  options: optionalObject({
    state: enumOf("load", "domcontentloaded", "networkidle"),
    timeoutMs: timeout,
  }),
});
tab("playwright.waitForTimeout", { timeoutMs: timeout }, ["timeoutMs"]);
tab("playwright.waitForURL", { url: string, options: navigation }, ["url"]);
for (const name of ["snapshot", "click", "fill", "waitFor"]) {
  const fields: Record<string, Schema> = { framePath: array(string, 8) };
  const required = ["framePath"];
  if (name === "snapshot")
    fields.options = optionalObject({
      maxBytes: { type: "integer", minimum: 1 },
    });
  if (name === "click" || name === "fill") {
    fields.ref = id;
    fields.options = timed;
    required.push("ref");
  }
  if (name === "fill") {
    fields.text = string;
    required.push("text");
  }
  if (name === "waitFor") {
    fields.condition = waitCondition;
    required.push("condition");
  }
  tab(`frame.${name}`, fields, required);
}
for (const name of [
  "all",
  "allTextContents",
  "check",
  "click",
  "count",
  "dblclick",
  "downloadMedia",
  "getAttribute",
  "innerText",
  "isEnabled",
  "isVisible",
  "press",
  "pressSequentially",
  "selectOption",
  "setChecked",
  "textContent",
  "type",
  "uncheck",
  "waitFor",
  "fill",
  "evaluate",
  "evaluateAll",
]) {
  const fields: Record<string, Schema> = {},
    required: string[] = [];
  if (
    [
      "allTextContents",
      "check",
      "downloadMedia",
      "getAttribute",
      "innerText",
      "textContent",
      "uncheck",
      "fill",
      "evaluate",
      "evaluateAll",
    ].includes(name)
  )
    fields.options = timed;
  if (name === "click" || name === "dblclick") fields.options = click;
  if (["fill", "press", "pressSequentially", "type"].includes(name)) {
    fields.value = string;
    required.push("value");
  }
  if (name === "press")
    fields.options = optionalObject({ timeoutMs: timeout, modifiers });
  if (name === "type")
    fields.options = optionalObject({
      timeoutMs: timeout,
      delayMs: { type: "number", minimum: 0 },
    });
  if (name === "pressSequentially") fields.options = timed;
  if (name === "getAttribute") {
    fields.name = string;
    required.push("name");
  }
  if (name === "selectOption") {
    fields.value = selections;
    fields.options = timed;
    required.push("value");
  }
  if (name === "setChecked") {
    fields.checked = bool;
    fields.options = timed;
    required.push("checked");
  }
  if (name === "waitFor") {
    fields.options = object(
      {
        state: enumOf("attached", "detached", "visible", "hidden"),
        timeoutMs: timeout,
      },
      ["state"],
    );
    required.push("options");
  }
  if (name === "evaluate" || name === "evaluateAll") {
    fields.expression = string;
    fields.arg = {};
    required.push("expression");
  }
  located(`locator.${name}`, fields, required);
}
route(
  "waiters.arm",
  {
    target: tabTarget,
    event: enumOf("navigation", "download", "filechooser"),
    timeoutMs: timeout,
    url: string,
    waitUntil: enumOf("load", "domcontentloaded", "networkidle", "commit"),
  },
  ["target", "event"],
);
route("waiters.get", { id }, ["id"]);
route("waiters.cancel", { id }, ["id"]);
for (const name of ["accept", "dismiss"])
  tab(
    `dialogs.${name}`,
    {
      dialogId: id,
      pageVersion: { type: "integer", minimum: 0 },
      ...(name === "accept" ? { text: string } : {}),
    },
    ["dialogId", "pageVersion"],
  );
tab("downloads.path", { downloadId: id, options: timed }, ["downloadId"]);
tab(
  "fileChoosers.setFiles",
  {
    chooserId: id,
    pageVersion: { type: "integer", minimum: 0 },
    files: fileChooserFiles,
    options: timed,
  },
  ["chooserId", "pageVersion", "files"],
);
for (const level of ["browser", "tab"]) {
  const register = level === "browser" ? browser : tab;
  register(`capabilities.${level}List`);
  register(`capabilities.${level}Get`, { id }, ["id"]);
}
for (const name of ["get", "set"])
  browser(
    `visibility.${name}`,
    name === "set" ? { visible: bool } : {},
    name === "set" ? ["visible"] : [],
  );
browser(
  "viewport.set",
  {
    options: object(
      {
        tabId: id,
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
      ["width", "height"],
    ),
  },
  ["options"],
);
browser("viewport.reset", { tabId: id });
browser("management.windows.list");
browser("management.windows.getAll", {
  options: optionalObject({ populate: bool }),
});
browser("management.windows.create", {
  options: optionalObject({
    tabId: id,
    focused: bool,
    left: integer,
    top: integer,
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
  }),
});
browser(
  "management.windows.update",
  {
    id,
    options: optionalObject({
      focused: bool,
      state: enumOf("normal", "minimized", "maximized", "fullscreen"),
      left: integer,
      top: integer,
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
    }),
  },
  ["id", "options"],
);
browser("management.tabs.query", {
  options: optionalObject({
    windowId: id,
    url: { anyOf: [string, array(string, 128)] },
    active: bool,
    pinned: bool,
    groupId: id,
  }),
});
browser("management.tabs.get", { id }, ["id"]);
browser(
  "management.tabs.move",
  {
    id,
    options: object({ index: { type: "integer", minimum: -1 }, windowId: id }, [
      "index",
    ]),
  },
  ["id", "options"],
);
browser(
  "management.tabs.update",
  { id, options: optionalObject({ pinned: bool, muted: bool }) },
  ["id", "options"],
);
browser(
  "management.tabs.group",
  {
    options: object(
      {
        tabIds: array(id, 128),
        groupId: id,
        createProperties: optionalObject({ windowId: id }),
      },
      ["tabIds"],
    ),
  },
  ["options"],
);
browser("management.tabs.ungroup", { ids: array(id, 128) }, ["ids"]);
browser("management.tabs.close", { id }, ["id"]);
browser("management.tabGroups.query", {
  options: optionalObject({
    windowId: id,
    title: string,
    color: id,
    collapsed: bool,
  }),
});
browser("management.tabGroups.get", { id }, ["id"]);
browser(
  "management.tabGroups.update",
  {
    id,
    options: optionalObject({ title: string, color: id, collapsed: bool }),
  },
  ["id", "options"],
);
browser(
  "management.tabGroups.move",
  {
    id,
    options: object({ index: { type: "integer", minimum: -1 }, windowId: id }, [
      "index",
    ]),
  },
  ["id", "options"],
);
browser(
  "management.bookmarks.search",
  {
    query: {
      anyOf: [
        string,
        optionalObject({ query: string, title: string, url: string }),
      ],
    },
  },
  ["query"],
);
browser("management.bookmarks.getTree");
browser("management.bookmarks.create", {
  options: optionalObject({
    parentId: id,
    index: { type: "integer", minimum: 0 },
    title: string,
    url: string,
  }),
});
browser(
  "management.bookmarks.update",
  { id, options: optionalObject({ title: string, url: string }) },
  ["id", "options"],
);
browser(
  "management.bookmarks.move",
  {
    id,
    options: optionalObject({
      parentId: id,
      index: { type: "integer", minimum: 0 },
    }),
  },
  ["id", "options"],
);
browser("management.bookmarks.remove", { id }, ["id"]);
browser("management.getAuditTrail", {
  options: optionalObject({
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: string,
  }),
});
tab("pageAssets.list");
tab("pageAssets.download", { urls: array(string, 128) }, ["urls"]);
tab(
  "pageAssets.bundle",
  {
    options: object(
      {
        inventoryId: id,
        assetIds: array(id, 128),
        kinds: array(enumOf("font", "image", "stylesheet", "video"), 4),
      },
      ["inventoryId"],
    ),
  },
  ["options"],
);
tab("webmcp.listTools");
tab("webmcp.fetchTools");
tab(
  "webmcp.invokeTool",
  {
    name: string,
    args: {},
    tool: object(
      {
        documentRevision: id,
        registrationRevision: id,
        name: string,
        description: string,
        inputSchema: { type: "object" },
        annotations: { type: "object" },
      },
      ["documentRevision", "registrationRevision", "name", "inputSchema"],
    ),
  },
  ["name", "args", "tool"],
);
tab(
  "cdp.send",
  {
    method: id,
    params: { type: "object" },
    options: optionalObject({ target: cdpTarget, timeoutMs: timeout }),
  },
  ["method"],
);
tab("cdp.events", { cursor: string });
tab("cdp.cursor");
tab("cdp.readEvents", {
  options: optionalObject({
    afterSequence: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
    methods: array(id, 128),
    target: cdpTarget,
    timeoutMs: timeout,
  }),
});
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const browserRoutes: readonly BrowserRouteDefinition[] = freeze(routes);
