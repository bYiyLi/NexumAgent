import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createBrowserClient,
  browserRoutes,
  normalizeBrowserValue,
  validateLocatorDescription,
} from "../dist/client/index.js";

const target = {
  browserId: "browser-a",
  bootId: "boot-a",
  browserSessionId: "session-a",
  generation: 2,
  tabId: "9",
};
const info = {
  id: target.browserId,
  name: "Fixture browser",
  type: "extension",
  status: "online",
  bootId: target.bootId,
  browserSessionId: target.browserSessionId,
  generation: target.generation,
};
function fixture(handlers = {}) {
  const calls = [],
    methods = Object.create(null);
  for (const { path } of browserRoutes) {
    const parts = path.split(".");
    let node = methods;
    for (const name of parts.slice(0, -1))
      node = node[name] ??= Object.create(null);
    node[parts.at(-1)] = async (input) => {
      calls.push({ path, input });
      if (handlers[path]) return await handlers[path](input);
      if (path.startsWith("browsers.get")) return { ...info };
      if (
        ["tabs.get", "tabs.new", "tabs.selected", "user.claimTab"].includes(
          path,
        )
      )
        return {
          id: target.tabId,
          target: { ...target, pageVersion: 13 },
          title: "A page",
        };
      if (path === "browsers.list") return [{ ...info }];
      if (path === "waiters.cancel") return { cancelled: true };
      if (path === "capabilities.browserGet" || path === "capabilities.tabGet")
        return { id: input.id, supported: true };
    };
  }
  const client = createBrowserClient(methods);
  return {
    client,
    methods,
    calls,
    tab: async () =>
      await (await client.browsers.get(info.id)).tabs.get(target.tabId),
  };
}
async function until(predicate) {
  const end = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(
      performance.now() < end,
      "client fixture did not reach expected phase",
    );
    await delay(1);
  }
}

test("construction is inert and public discovery fixes immutable connection targets without a dispatch escape", async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.equal(Object.isFrozen(f.client), true);
  assert.equal(Object.hasOwn(f.client, "invoke"), false);
  const browser = await f.client.browsers.get(info.id);
  const tab = await browser.tabs.new("https://example.test/", {
    active: false,
  });
  assert.equal(Object.isFrozen(browser), true);
  assert.equal(Object.isFrozen(tab), true);
  assert.equal(tab.id, target.tabId);
  assert.equal(browser.windows, browser.management.windows);
  assert.equal(browser.tabGroups, browser.management.tabGroups);
  assert.equal(browser.tabs.query, browser.management.tabs.query);
  await browser.windows.list();
  await browser.management.windows.list();
  await tab.navigate("https://example.test/next", { waitUntil: "commit" });
  assert.equal(
    f.calls.filter((call) => call.path === "management.windows.list").length,
    2,
  );
  const navigation = f.calls.at(-1);
  assert.equal(navigation.path, "tab.navigate");
  assert.deepEqual(navigation.input.target, target);
  assert.equal(Object.hasOwn(navigation.input.target, "pageVersion"), false);
  assert.throws(() => {
    tab.id = "different";
  }, TypeError);
  let getterCalls = 0;
  const bad = {};
  Object.defineProperty(bad, "browsers", {
    get() {
      getterCalls++;
      throw new Error("getter");
    },
  });
  assert.throws(() => createBrowserClient(bad), { code: "INVALID_ARGUMENT" });
  assert.equal(getterCalls, 0);
  await assert.rejects(createBrowserClient({}).browsers.list(), {
    code: "CAPABILITY_NOT_ALLOWED",
  });
});

test("locator combinations are bounded immutable AST with native regexp flags and exact frame/target ownership", async () => {
  const f = fixture(),
    tab = await f.tab();
  const before = f.calls.length;
  const expression = /save/gi;
  expression.lastIndex = 15;
  let getters = 0;
  Object.defineProperty(expression, "source", {
    get() {
      getters++;
      return "wrong";
    },
  });
  const root = tab.playwright.getByRole("button", {
    name: expression,
    exact: true,
  });
  const locator = root
    .filter({
      hasText: /continue/i,
      hasNot: tab.playwright.getByText("disabled"),
      visible: true,
    })
    .and(tab.playwright.locator("button.enabled"))
    .nth(2);
  assert.equal(f.calls.length, before);
  assert.equal(Object.isFrozen(locator), true);
  await locator.click({
    button: "left",
    clickCount: 2,
    position: { x: 4, y: 7 },
    modifiers: ["Shift"],
  });
  const input = f.calls.at(-1).input;
  assert.equal(f.calls.at(-1).path, "locator.click");
  assert.equal(input.locator.query.kind, "position");
  assert.equal(getters, 0);
  assert.match(JSON.stringify(input.locator), /"source":"save","flags":"gi"/);
  assert.equal(JSON.stringify(input).includes("lastIndex"), false);
  assert.deepEqual(input.locator.target, target);
  const frame = tab.playwright.frameLocator("iframe").getByRole("button");
  assert.throws(() => root.and(frame), { code: "INVALID_ARGUMENT" });
  let deep = root;
  assert.throws(
    () => {
      for (let i = 0; i < 17; i++) deep = deep.first();
    },
    { code: "INVALID_ARGUMENT" },
  );
  assert.throws(() => root.getByText(new RegExp("x".repeat(1025))), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(() => tab.playwright.frameLocator(""), {
    code: "INVALID_ARGUMENT",
  });
  const cycle = { kind: "position", at: 0 };
  cycle.query = cycle;
  assert.throws(
    () => validateLocatorDescription({ target, framePath: [], query: cycle }),
    { code: "INVALID_ARGUMENT" },
  );
});

test("locator all snapshots preserve concrete refs and never turn a DOM reordering into a new nth target", async () => {
  const f = fixture({
    "locator.all": async ({ locator }) =>
      [1, 2].map((i) => ({
        ...locator,
        query: { kind: "ref", ref: `ref-${i}`, pageVersion: 31 },
      })),
  });
  const tab = await f.tab(),
    members = await tab.playwright.locator("li").all();
  await members[1].click();
  assert.deepEqual(f.calls.at(-1).input.locator.query, {
    kind: "ref",
    ref: "ref-2",
    pageVersion: 31,
  });
  const bad = fixture({
    "locator.all": async ({ locator }) => [
      { ...locator, query: { kind: "selector", selector: "li:nth-child(2)" } },
    ],
  });
  await assert.rejects((await bad.tab()).playwright.locator("li").all(), {
    code: "INVALID_ARGUMENT",
  });
});

test("waitForEvent establishes an arm-ready barrier while its get wait never blocks the action needed to produce the event", async () => {
  const armed = Promise.withResolvers(),
    event = Promise.withResolvers();
  const f = fixture({
    "waiters.arm": () => armed.promise,
    "waiters.get": () => event.promise,
    "locator.click": async () =>
      event.resolve({
        type: "download",
        target: { ...target, pageVersion: 44 },
        downloadId: "download-1",
        suggestedFilename: "report.txt",
      }),
    "downloads.path": async () => "/fixture/report.txt",
  });
  const tab = await f.tab(),
    pending = tab.playwright.waitForEvent("download"),
    click = tab.playwright.getByRole("button").click();
  await until(() => f.calls.some((call) => call.path === "waiters.arm"));
  assert.equal(
    f.calls.some((call) => call.path === "locator.click"),
    false,
  );
  armed.resolve({ id: "waiter-1", target, expiresAt: Date.now() + 1000 });
  await click;
  const download = await pending;
  assert.equal(await download.path(), "/fixture/report.txt");
  assert.equal(f.calls.at(-1).input.downloadId, "download-1");
  assert.equal(f.calls.filter((call) => call.path === "waiters.get").length, 1);
  assert.equal(
    f.calls.filter((call) => call.path === "waiters.cancel").length,
    1,
  );
});

test("early waiter events are consumed; failed arm blocks later actions; action failure survives a failed cancellation", async () => {
  const early = fixture({
    "waiters.arm": async () => ({
      id: "early",
      target,
      expiresAt: Date.now() + 1000,
    }),
    "waiters.get": async () => ({
      type: "filechooser",
      target,
      chooserId: "chooser-1",
      pageVersion: 3,
      multiple: true,
    }),
  });
  const chooser = await (await early.tab()).playwright.waitForFileChooser();
  const count = early.calls.length;
  assert.equal(chooser.isMultiple(), true);
  assert.equal(early.calls.length, count);
  const armFailure = new Error("listener did not become ready");
  const failed = fixture({
      "waiters.arm": async () => {
        throw armFailure;
      },
    }),
    tab = await failed.tab();
  const pending = tab.playwright.waitForDownload();
  await assert.rejects(
    tab.playwright.locator("a").click(),
    (cause) => cause === armFailure,
  );
  await assert.rejects(pending, (cause) => cause === armFailure);
  assert.equal(
    failed.calls.some((call) => call.path === "locator.click"),
    false,
  );
  const actionFailure = new Error("local action failed"),
    cancelFailure = new Error("cleanup failed");
  let actionRan = 0;
  const navigation = fixture({
    "waiters.arm": async () => ({
      id: "nav",
      target,
      expiresAt: Date.now() + 1000,
    }),
    "waiters.cancel": async () => {
      throw cancelFailure;
    },
  });
  await assert.rejects(
    (await navigation.tab()).playwright.expectNavigation(async () => {
      actionRan++;
      throw actionFailure;
    }),
    (cause) => cause === actionFailure,
  );
  assert.equal(actionRan, 1);
  assert.equal(
    navigation.calls.some((call) => call.path === "waiters.get"),
    false,
  );
  assert.equal(
    navigation.calls.filter((call) => call.path === "waiters.cancel").length,
    1,
  );
  const good = fixture({
    "waiters.arm": async () => ({
      id: "nav",
      target,
      expiresAt: Date.now() + 1000,
    }),
    "waiters.get": async () => ({
      type: "navigation",
      target,
      url: "https://example.test",
      pageVersion: 2,
    }),
  });
  const local = {
    callback() {
      return 1;
    },
  };
  assert.equal(
    await (await good.tab()).playwright.expectNavigation(async () => local),
    local,
  );
  assert.equal(
    good.calls.some((call) => JSON.stringify(call.input).includes("callback")),
    false,
  );
});

test("dialog, chooser and download facades keep fixed opaque identities and native binary inputs", async () => {
  let current = {
    target,
    dialogId: "dialog-a",
    pageVersion: 8,
    type: "confirm",
    message: "Continue?",
  };
  const f = fixture({
    "tab.getJsDialog": async () => current,
    "waiters.arm": async () => ({
      id: "chooser",
      target,
      expiresAt: Date.now() + 1000,
    }),
    "waiters.get": async () => ({
      type: "filechooser",
      target,
      chooserId: "chooser-a",
      pageVersion: 8,
      multiple: true,
    }),
  });
  const tab = await f.tab(),
    dialog = await tab.getJsDialog();
  current = { ...current, dialogId: "dialog-b", pageVersion: 9 };
  await dialog.accept();
  assert.equal(f.calls.at(-1).input.dialogId, "dialog-a");
  assert.equal(f.calls.at(-1).input.pageVersion, 8);
  await assert.rejects(dialog.accept("invalid confirm text"), {
    code: "INVALID_ARGUMENT",
  });
  const chooser = await tab.playwright.waitForFileChooser();
  const source = new Uint8Array(10 * 1024 * 1024 + 6).fill(4);
  source[4] = 199;
  let getterCalls = 0;
  Object.defineProperty(source, "private", {
    get() {
      getterCalls++;
      return () => {};
    },
  });
  const bytes = source.subarray(4, source.length - 2);
  Object.defineProperty(bytes, "private", {
    get() {
      getterCalls++;
      return () => {};
    },
  });
  await chooser.setFiles([
    { data: bytes, name: "large.bin", mimeType: "application/octet-stream" },
  ]);
  const sent = f.calls.at(-1).input;
  assert.equal(sent.chooserId, "chooser-a");
  assert.equal(sent.pageVersion, 8);
  assert.ok(sent.files[0].data instanceof Uint8Array);
  assert.equal(sent.files[0].data.length, 10 * 1024 * 1024);
  assert.equal(sent.files[0].data[0], 199);
  assert.notEqual(sent.files[0].data.buffer, source.buffer);
  assert.equal(getterCalls, 0);
  const buffer = new ArrayBuffer(8);
  Object.defineProperty(buffer, "byteLength", {
    get() {
      getterCalls++;
      throw new Error("shadow getter");
    },
  });
  assert.equal(normalizeBrowserValue(buffer).byteLength, 8);
  assert.equal(getterCalls, 0);
});

test("unknown action options, accessor data and Node functions fail before invoking managed I/O", async () => {
  const f = fixture(),
    tab = await f.tab(),
    before = f.calls.length;
  await assert.rejects(
    tab.playwright.locator("button").click({ force: true }),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    tab.screenshot({
      fullPage: true,
      clip: { x: 0, y: 0, width: 10, height: 10 },
    }),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    tab.playwright.evaluate(() => 1),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(tab.cdp.readEvents({ methods: [] }), {
    code: "INVALID_ARGUMENT",
  });
  let calls = 0;
  const options = {};
  Object.defineProperty(options, "quality", {
    enumerable: true,
    get() {
      calls++;
      return 80;
    },
  });
  await assert.rejects(tab.screenshot(options), { code: "INVALID_ARGUMENT" });
  assert.equal(calls, 0);
  assert.equal(f.calls.length, before);
});

test("WebMCP bound snapshots never silently rediscover stale registrations and concurrent first calls use their own discovery", async () => {
  const tools = (revision) => [
    {
      name: "lookup",
      documentRevision: "doc",
      registrationRevision: revision,
      inputSchema: { type: "object" },
    },
  ];
  let current = "one";
  const f = fixture({
    "webmcp.listTools": async () => tools(current),
    "webmcp.fetchTools": async () => ({
      documentRevision: "doc",
      registrationRevision: current,
      tools: tools(current),
    }),
    "webmcp.invokeTool": async ({ tool }) => tool.registrationRevision,
  });
  const tab = await f.tab(),
    bound = await tab.webmcp.fetchTools();
  current = "two";
  await tab.webmcp.listTools();
  assert.equal(await bound.invokeTool("lookup", {}), "one");
  assert.equal(await tab.webmcp.invokeTool("lookup", {}), "two");
  const one = Promise.withResolvers(),
    two = Promise.withResolvers();
  let discoveries = 0;
  const concurrent = fixture({
    "webmcp.listTools": () => (++discoveries === 1 ? one.promise : two.promise),
    "webmcp.invokeTool": async ({ tool }) => tool.registrationRevision,
  });
  const page = await concurrent.tab();
  const a = page.webmcp.invokeTool("lookup", {}),
    b = page.webmcp.invokeTool("lookup", {});
  one.resolve(tools("first"));
  two.resolve(tools("second"));
  assert.deepEqual(await Promise.all([a, b]), ["first", "second"]);
});

test("the canonical route manifest contains exact schemas without an unbounded invoke entry", () => {
  const paths = browserRoutes.map((route) => route.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(
    paths.some((path) => path === "invoke" || path === "dispatch"),
    false,
  );
  for (const route of browserRoutes) {
    assert.equal(route.inputSchema.type, "object");
    assert.equal(route.inputSchema.additionalProperties, false);
    assert.equal(Object.isFrozen(route.inputSchema), true);
  }
  assert.ok(paths.includes("management.windows.getAll"));
  assert.ok(paths.includes("waiters.arm"));
  assert.ok(paths.includes("locator.evaluateAll"));
  assert.ok(paths.includes("pageAssets.bundle"));
});

test("ordinary Node import and construction never load extension services, call the method table or initialize a profile", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-client-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    work = path.join(root, "work");
  mkdirSync(home);
  mkdirSync(work);
  const entry = new URL("../dist/client/index.js", import.meta.url).href;
  const script = `import assert from "node:assert/strict";import {registerHooks} from "node:module";
const prefix=${JSON.stringify(new URL("../dist/client/", import.meta.url).href)};
const hooks=registerHooks({resolve(specifier,context,next){const found=next(specifier,context);assert.ok(found.url==="node:util"||found.url.startsWith(prefix),"Ordinary client import must not load extension/Core services or other runtime dependencies.");return found;}});
try{const {createBrowserClient}=await import(${JSON.stringify(entry)});const client=createBrowserClient({});assert.equal(Object.isFrozen(client),true);assert.deepEqual(Object.keys(client),["browsers","documentation"]);}finally{hooks.deregister();}`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NEXUM_PROFILE: "development",
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(readdirSync(work), []);
  const value = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"ordinary data"}',
  );
  const copied = normalizeBrowserValue(value);
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.equal(Object.hasOwn(copied, "__proto__"), true);
  assert.equal(copied.__proto__.polluted, true);
  assert.equal(copied.constructor, "ordinary data");
  assert.equal({}.polluted, undefined);
});

test("control epochs remain fixed on Tab, Frame, Locator and dialog facades after a new Tab is obtained", async () => {
  let epoch = "opaque-before",
    pageVersion = 1;
  const fixed = () => ({ ...target, controlEpoch: epoch, pageVersion });
  const active = (input) => {
    const selected = input.target ?? input.locator?.target;
    if (selected?.controlEpoch !== epoch)
      throw Object.assign(Error("user control changed"), {
        code: "USER_TAKEOVER",
      });
    return selected;
  };
  const f = fixture({
    "tabs.get": async () => ({
      id: target.tabId,
      target: fixed(),
      title: "Epoch fixture",
    }),
    "tab.title": async (input) => {
      active(input);
      return epoch;
    },
    "tab.navigate": async (input) => {
      active(input);
      return { ok: true };
    },
    "locator.count": async (input) => {
      active(input);
      return 1;
    },
    "tab.frame": async (input) => ({
      target: active(input),
      framePath: [input.selector],
    }),
    "frame.snapshot": async (input) => {
      active(input);
      return { nodes: [] };
    },
    "tab.getJsDialog": async (input) => ({
      target: active(input),
      dialogId: "fixed-dialog",
      pageVersion: 1,
      type: "alert",
      message: "A dialog",
    }),
    "dialogs.dismiss": async (input) => {
      active(input);
    },
  });
  const browser = await f.client.browsers.get(info.id),
    old = await browser.tabs.get(target.tabId),
    oldFrame = await old.frame("iframe"),
    oldLocator = old.playwright.getByRole("button"),
    dialog = await old.getJsDialog();
  assert.equal(await old.title(), "opaque-before");
  assert.equal(await oldLocator.count(), 1);
  epoch = "opaque-after";
  pageVersion = 2;
  const fresh = await browser.tabs.get(target.tabId),
    freshFrame = await fresh.frame("iframe"),
    freshLocator = fresh.playwright.getByRole("button");
  assert.equal(await fresh.title(), "opaque-after");
  assert.equal(await freshLocator.count(), 1);
  await freshFrame.snapshot();
  for (const work of [
    () => old.title(),
    () => old.navigate("https://example.test/new"),
    () => oldLocator.count(),
    () => oldFrame.snapshot(),
    () => dialog.dismiss(),
  ])
    await assert.rejects(work(), { code: "USER_TAKEOVER" });
  assert.throws(() => oldLocator.and(freshLocator), {
    code: "INVALID_ARGUMENT",
  });
  const requests = f.calls.filter((item) =>
    [
      "tab.title",
      "tab.navigate",
      "locator.count",
      "frame.snapshot",
      "dialogs.dismiss",
    ].includes(item.path),
  );
  assert.ok(
    requests.some(
      (item) =>
        (item.input.target ?? item.input.locator?.target).controlEpoch ===
        "opaque-before",
    ),
  );
  const navigation = f.calls.findLast((item) => item.path === "tab.navigate");
  assert.equal(navigation.input.target.controlEpoch, "opaque-before");
  assert.equal(Object.hasOwn(navigation.input.target, "pageVersion"), false);
});

test("target schemas and native target validation accept optional opaque epochs but reject unknown, empty or accessor identities", async () => {
  const Ajv = createRequire(import.meta.url)("ajv"),
    ajv = new Ajv({ strict: true });
  for (const route of browserRoutes) ajv.compile(route.inputSchema);
  const route = browserRoutes.find((route) => route.path === "tab.navigate"),
    validate = ajv.compile(route.inputSchema);
  const input = {
    target: { ...target, controlEpoch: "opaque-epoch" },
    url: "https://example.test/",
  };
  assert.equal(validate(input), true);
  assert.equal(
    validate({ target, url: input.url }),
    true,
    "older fixtures may omit the optional native epoch",
  );
  for (const changed of [
    { ...input.target, unknownEpoch: "private" },
    { ...input.target, controlEpoch: "" },
    { ...input.target, controlEpoch: "bad\nepoch" },
  ])
    assert.equal(validate({ ...input, target: changed }), false);
  let value = { ...target, controlEpoch: "native-valid" },
    hooks = 0;
  const f = fixture({
      "tabs.get": async () => ({ id: target.tabId, target: value }),
    }),
    browser = await f.client.browsers.get(info.id);
  const tab = await browser.tabs.get(target.tabId);
  await tab.title();
  assert.equal(f.calls.at(-1).input.target.controlEpoch, "native-valid");
  for (const controlEpoch of [
    "",
    "x".repeat(257),
    "界".repeat(100),
    "bad\0epoch",
    123,
  ]) {
    value = { ...target, controlEpoch };
    await assert.rejects(browser.tabs.get(target.tabId), {
      code: "INVALID_ARGUMENT",
    });
  }
  value = { ...target };
  Object.defineProperty(value, "controlEpoch", {
    get() {
      hooks++;
      throw Error("private getter");
    },
    enumerable: true,
  });
  await assert.rejects(browser.tabs.get(target.tabId), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(hooks, 0);
});

test("an old Tab cannot obtain a revived Frame from a reply carrying a new control epoch", async () => {
  const f = fixture({
    "tabs.get": async () => ({
      id: target.tabId,
      target: { ...target, controlEpoch: "original" },
    }),
    "tab.frame": async () => ({
      target: { ...target, controlEpoch: "replacement" },
      framePath: ["iframe"],
    }),
  });
  const tab = await f.tab();
  await assert.rejects(tab.frame("iframe"), { code: "INVALID_ARGUMENT" });
  assert.equal(f.calls.at(-1).input.target.controlEpoch, "original");
});
