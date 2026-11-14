import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";

// This is a Core conformance harness. No private Core value is passed to the
// production factory: it receives exactly ExtensionHost and Invocation.
const coreEntry = process.env.NEXUM_BROWSER_CORE_DIST
  ? pathToFileURL(path.join(process.env.NEXUM_BROWSER_CORE_DIST, "index.js"))
      .href
  : new URL("../../../dist/index.js", import.meta.url).href;
const core = (relative) => import(new URL(relative, coreEntry).href);
const [
  { SqliteStore },
  { ResourceManager },
  { ExtensionRegistry },
  { ExtensionPackageLoader },
  { ExtensionMaterials },
  { ExtensionServices },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { ArtifactStore },
  { ResultEncoder },
] = await Promise.all([
  core("storage/sqlite.js"),
  core("extensions/resources.js"),
  core("extensions/registry.js"),
  core("extensions/package-loader.js"),
  core("extensions/materials.js"),
  core("services/extensions.js"),
  core("runtime/modules.js"),
  core("runtime/scripts.js"),
  core("runtime/engine.js"),
  core("results/artifacts.js"),
  core("results/encoder.js"),
]);
const source = realpathSync.native(
  fileURLToPath(new URL("../", import.meta.url)),
);
const version = JSON.parse(
  readFileSync(path.join(source, "package.json"), "utf8"),
).version;
const caller = {
  principalId: "browser-fixture",
  clientId: "native-loopback",
  host: "test",
};
const jpeg =
  "/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD5/ooor7Q+PP/Z";
function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}
function storage() {
  const values = {};
  return {
    get: async (keys) =>
      Object.fromEntries(
        keys
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, values[key]]),
      ),
    set: async (input) => Object.assign(values, input),
  };
}
async function fixture(
  t,
  { gateDetach = false, gateCommand = false, nativeDownloads = false } = {},
) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-browser-core-")),
    ),
    work = path.join(root, "work"),
    packageRoot = path.join(work, "node_modules", "nexum-browser");
  mkdirSync(packageRoot, { recursive: true });
  for (const name of [
    "dist",
    "browser-extension",
    "instructions",
    "docs",
    "scripts",
    "skills",
    "package.json",
  ]) {
    cpSync(path.join(source, name), path.join(packageRoot, name), {
      recursive: true,
    });
  }
  mkdirSync(path.join(packageRoot, "node_modules"));
  for (const dependency of Object.keys(
    JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"))
      .dependencies,
  ))
    symlinkSync(
      fileURLToPath(new URL("../node_modules/" + dependency, import.meta.url)),
      path.join(packageRoot, "node_modules", dependency),
      "junction",
    );
  writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { "nexum-browser": version },
    }),
  );
  const store = new SqliteStore(root, {
    agentId: "browser-agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 25 }),
    permissions = new Set(["connection", "path", "resource", "url"]),
    registry = new ExtensionRegistry(resources, {
      cleanupTimeoutMs: 25,
      permissions,
      authorize() {},
      log() {},
      progress() {},
    });
  const policy = {
    builtins: () => [],
    approvedPackages: () => new Map([["nexum-browser", version]]),
  };
  const modules = await ModuleLoader.create(work, store.bootId, policy),
    packages = new ExtensionPackageLoader(registry, modules, {
      policy,
      permissions,
      enabled: () => new Set(["nexum-browser"]),
    }),
    materials = new ExtensionMaterials(work),
    services = new ExtensionServices(registry, packages, materials);
  const scripts = new ScriptCatalog(work, "browser-agent", () =>
    materials.scriptSources(),
  );
  writeFileSync(
    path.join(work, "snapshot.json"),
    JSON.stringify({ project: null }),
  );
  const context = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: "work/snapshot.json",
  });
  const artifacts = new ArtifactStore(root, "browser-agent"),
    encoder = new ResultEncoder(artifacts),
    resultScope = (services) => ({
      pwd: work,
      ownerKey: callerKey(caller),
      runId: services?.runId ?? "history",
      ...(services ? { signal: services.signal } : {}),
      assertCurrent() {
        services?.assertCurrent();
      },
      authorize() {},
    });
  const engine = new RunEngine(store, modules, scripts, {
    authorize() {},
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    encodeResult: (value, services) =>
      encoder.encode(value, resultScope(services)),
    bindings: (scope) => registry.bindings(scope),
    resources,
    leaseScript: (origin) =>
      origin.type === "local" ? () => {} : registry.lease(origin),
  });
  const downloadSource = path.join(root, "native-download.txt"),
    downloadBytes = Buffer.alloc(150000, 57);
  if (nativeDownloads) writeFileSync(downloadSource, downloadBytes);
  let plugin;
  const attached = new Set(),
    detachGate = Promise.withResolvers(),
    commandGate = Promise.withResolvers(),
    counts = { attach: 0, detach: 0, removed: 0, commands: 0, handoff: 0 };
  const tabs = [
    {
      id: 1,
      url: "https://fixture.test/",
      title: "Actual native fixture",
      active: true,
      windowId: 1,
      groupId: -1,
    },
    {
      id: 2,
      url: "https://fixture.test/second",
      title: "Untouched",
      active: false,
      windowId: 1,
      groupId: -1,
    },
  ];
  t.after(async () => {
    detachGate.resolve();
    commandGate.resolve();
    await plugin?.dispose().catch(() => {});
    const entry = services.get("nexum-browser");
    if (entry) await services.disable("nexum-browser").catch(() => {});
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const enabled = await services.enable("nexum-browser");
  assert.equal(enabled.status, "enabled");
  const release = JSON.parse(
      readFileSync(
        path.join(packageRoot, "browser-extension", "release-info.json"),
        "utf8",
      ),
    ),
    extensionId = release.profiles.development.extensionId;
  const chrome = {
    runtime: { id: extensionId },
    storage: { local: storage(), session: storage() },
    action: { setBadgeText: async () => {}, setTitle: async () => {} },
    alarms: {
      create: async () => {},
      clear: async () => true,
      onAlarm: event(),
    },
    tabs: {
      query: async () => tabs.map((value) => ({ ...value })),
      get: async (id) => {
        const tab = tabs.find((value) => value.id === id);
        if (!tab) throw new Error("No tab");
        return { ...tab };
      },
      update: async (id, change) => {
        const tab = tabs.find((value) => value.id === id);
        Object.assign(tab, change);
        return { ...tab };
      },
      remove: async () => {
        counts.removed++;
      },
      onRemoved: event(),
      onUpdated: event(),
      onCreated: event(),
      onActivated: event(),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async (target) => {
        counts.attach++;
        attached.add(target.tabId);
      },
      detach: async (target) => {
        counts.detach++;
        if (gateDetach) await detachGate.promise;
        attached.delete(target.tabId);
        chrome.debugger.onDetach.emit(target, "canceled_by_user");
      },
      sendCommand: async (_source, method) => {
        counts.commands++;
        if (gateCommand) await commandGate.promise;
        if (method === "Page.navigate" && nativeDownloads) {
          const url = "https://fixture.test/file";
          chrome.downloads.onCreated.emit({
            id: 71,
            url,
            startTime: new Date().toISOString(),
            state: "complete",
            filename: downloadSource,
            exists: true,
            bytesReceived: downloadBytes.length,
            totalBytes: downloadBytes.length,
          });
          chrome.debugger.onEvent.emit(_source, "Page.downloadWillBegin", {
            guid: "download-fixture",
            url,
            suggestedFilename: "native-download.txt",
          });
          return { frameId: "main" };
        }
        if (method === "Accessibility.getFullAXTree")
          return {
            nodes: [
              {
                nodeId: "native-1",
                backendDOMNodeId: 41,
                role: { value: "button" },
                name: { value: "Native submit" },
              },
            ],
          };
        if (method === "Page.getLayoutMetrics")
          return {
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 1,
              clientHeight: 1,
            },
          };
        if (method === "Page.captureScreenshot") return { data: jpeg };
        return { enabled: true };
      },
    },
  };
  chrome.downloads = {
    onCreated: event(),
    onChanged: event(),
    search: async () => [
      { id: 71, state: "complete", exists: true, filename: downloadSource },
    ],
  };
  class ExtensionSocket extends WebSocket {
    constructor(url) {
      super(url, { origin: `chrome-extension://${extensionId}` });
      this.binaryType = "arraybuffer";
      this.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const value = JSON.parse(event.data);
          if (value.type === "action" && value.method === "tab.markHandoff")
            counts.handoff++;
        }
      });
    }
  }
  const { createBrowserRouter } = await import(
      pathToFileURL(path.join(packageRoot, "browser-extension", "router.js"))
        .href
    ),
    { createExtensionConnection } = await import(
      pathToFileURL(
        path.join(packageRoot, "browser-extension", "connection.js"),
      ).href
    );
  const router = createBrowserRouter(chrome),
    connection = createExtensionConnection({
      chrome,
      WebSocket: ExtensionSocket,
      router,
      profile: "development",
      extensionVersion: release.extensionVersion,
    });
  plugin = connection;
  await plugin.start();
  const start = (script, options = {}) =>
    engine.start(caller, { contextId: context.contextId, script, ...options });
  const end = Date.now() + 3000;
  while (!plugin.state().connected) {
    assert.ok(
      Date.now() < end,
      "MV3 fixture did not complete real loopback handshake",
    );
    await delay(5);
  }
  return {
    root,
    work,
    store,
    engine,
    services,
    materials,
    registry,
    plugin,
    attached,
    detachGate,
    commandGate,
    counts,
    tabs,
    start,
    router,
    downloadSource,
    downloadBytes,
    encoder,
    resultScope,
    observe: (id) => engine.observe(caller, id, 50),
  };
}
const select = `const {createBrowserClient}=await import("nexum-browser");const client=createBrowserClient(browser);const selected=await client.browsers.getDefault();const tabs=await selected.tabs.list();const tab=await selected.tabs.get(tabs[0].id);`;

test("the installed optional package loads through the public factory, publishes five contributions and cleans a real Core run", async (t) => {
  const f = await fixture(t);
  const result = await f.start(
    select + "return {title:await tab.title(),tabs:tabs.length};",
  );
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.deepEqual(result.result.data, {
    title: "Actual native fixture",
    tabs: 2,
  });
  const runResources = f.store.resourcesForRun(result.run.runId);
  assert.equal(
    runResources.filter((value) => value.kind === "browser.run").length,
    1,
  );
  assert.ok(runResources.every((value) => value.closedAt !== null));
  assert.equal(f.materials.published().instructions.length, 1);
  assert.equal(f.materials.published().skills.length, 1);
  assert.equal(f.materials.scriptSources().length, 1);
  assert.ok(f.materials.published().docs.length > 0);
  const disabled = await f.services.disable("nexum-browser");
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(f.materials.scriptSources(), []);
  assert.equal(f.materials.published().instructions.length, 0);
  assert.equal(f.counts.removed, 0);
  assert.equal(f.tabs.length, 2);
});
test("normal return waits for actual remote detach and busy disable preserves all published contributions", async (t) => {
  const f = await fixture(t, { gateDetach: true });
  let result = await f.start(
    select + 'return await tab.cdp.send("Runtime.enable");',
    { waitMs: 0 },
  );
  const deadline = Date.now() + 3000;
  while (!f.counts.detach) {
    assert.ok(Date.now() < deadline, "run never requested real native detach");
    await delay(5);
    result = await f.observe(result.run.runId);
  }
  assert.equal(result.run.endedAt, null);
  assert.equal(f.attached.size, 1);
  await assert.rejects(f.services.disable("nexum-browser"), {
    code: "extension_busy",
  });
  assert.equal(f.services.get("nexum-browser").status, "enabled");
  assert.equal(f.materials.published().skills.length, 1);
  f.detachGate.resolve();
  while (result.run.endedAt === null) {
    assert.ok(
      Date.now() < deadline,
      "run did not finish after actual native detach evidence",
    );
    result = await f.observe(result.run.runId);
  }
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.equal(f.attached.size, 0);
  assert.equal(f.counts.removed, 0);
  assert.equal((await f.services.disable("nexum-browser")).status, "disabled");
});

test("separate actual Core runs cannot take the same controlled tab and cancellation waits for remote cleanup", async (t) => {
  const f = await fixture(t, { gateCommand: true });
  let first = await f.start(
    select + 'return await tab.cdp.send("Runtime.enable");',
    { waitMs: 0 },
  );
  const deadline = Date.now() + 4000;
  while (!f.counts.commands) {
    assert.ok(
      Date.now() < deadline,
      "first run did not dispatch the native command",
    );
    await delay(5);
  }
  const other = await f.start(
    select +
      'try { await tab.cdp.send("Runtime.enable"); return {unexpected:true}; } catch(error) { return {code:error.code}; }',
  );
  assert.equal(other.run.status, "succeeded", JSON.stringify(other.run.error));
  assert.deepEqual(other.result.data, { code: "TAB_ALREADY_CLAIMED" });
  assert.equal(f.counts.commands, 1);
  f.engine.cancel(caller, first.run.runId);
  first = await f.observe(first.run.runId);
  assert.equal(first.run.endedAt, null);
  assert.equal(f.attached.size, 1);
  f.commandGate.resolve();
  while (first.run.endedAt === null) {
    assert.ok(
      Date.now() < deadline,
      "cancel did not finish after actual native settlement and detach",
    );
    first = await f.observe(first.run.runId);
  }
  assert.equal(first.run.status, "cancelled");
  assert.equal(f.attached.size, 0);
  assert.equal(f.counts.removed, 0);
});

test("AX state plus actual JPEG bytes cross Registry and the real Core result pipeline without entering saved JSON", async (t) => {
  const f = await fixture(t);
  const result = await f.start(select + 'return await tab.ax.write("both");');
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.equal(result.result.content.length, 2);
  assert.equal(result.result.content[0].type, "text");
  assert.match(result.result.content[0].text, /Native submit/);
  assert.equal(result.result.content[1].type, "image");
  assert.equal(Object.hasOwn(result.result.content[1], "data"), false);
  assert.doesNotMatch(
    JSON.stringify(result.result),
    new RegExp(jpeg.slice(100, 160)),
  );
  const rendered = await f.encoder.render(
    result.result,
    f.resultScope(),
    result.run,
  );
  const image = rendered.content.find((value) => value.type === "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual(
    Buffer.from(image.data, "base64"),
    Buffer.from(jpeg, "base64"),
  );
  assert.equal(f.attached.size, 0);
});

test("a ready native download is copied into authorized fixed files and an explicit destination before ordinary SDK results return", async (t) => {
  const f = await fixture(t, { nativeDownloads: true });
  const result = await f.start(
    select +
      'let download;for(let i=0;i<38;i++){const pending=tab.playwright.waitForEvent("download");await tab.cdp.send("Page.navigate",{url:"https://fixture.test/file"});download=await pending;}const savedPath=await download.path();const downloads=await tab.downloads();const artifact=await tab.saveDownload(downloads[0].id,"copied.txt");return {savedPath,artifact};',
  );
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  const { savedPath, artifact } = result.result.data;
  assert.notEqual(savedPath, f.downloadSource);
  assert.ok(savedPath.startsWith(path.join(f.work, "tmp", "browser")));
  assert.deepEqual(readFileSync(savedPath), f.downloadBytes);
  assert.equal(artifact.path, path.join(f.work, "copied.txt"));
  assert.equal(artifact.size, f.downloadBytes.length);
  assert.equal(
    artifact.sha256,
    createHash("sha256").update(f.downloadBytes).digest("hex"),
  );
  assert.deepEqual(readFileSync(artifact.path), f.downloadBytes);
  assert.equal(f.attached.size, 0);
});

test("a queued deadline reports no dispatched effect and never sends its late native command", async (t) => {
  const f = await fixture(t, { gateCommand: true });
  let result = await f.start(
    select +
      'const first=tab.cdp.send("Runtime.enable");await new Promise(resolve=>setTimeout(resolve,15));let fact;try{await tab.cdp.send("Runtime.enable",{}, {timeoutMs:15});}catch(error){fact={code:error.code,dispatched:error.dispatched,effect:error.effect};}await first;return fact;',
    { waitMs: 0 },
  );
  const deadline = Date.now() + 3000;
  while (!f.counts.commands) {
    assert.ok(Date.now() < deadline);
    await delay(5);
  }
  await delay(70);
  assert.equal(f.counts.commands, 1);
  f.commandGate.resolve();
  while (result.run.endedAt === null) {
    assert.ok(Date.now() < deadline);
    result = await f.observe(result.run.runId);
  }
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.deepEqual(result.result.data, {
    code: "TIMEOUT",
    dispatched: false,
    effect: "none",
  });
  assert.equal(f.counts.commands, 1);
});
test("a proven remote lease admission refusal closes that Core run resource without disconnecting the browser", async (t) => {
  const f = await fixture(t);
  const target = f.router.target("1");
  f.router.openLease({
    leaseId: "old-owner",
    runId: "old-run",
    operationId: "old-operation",
    target,
  });
  let result = await f.start(
    "try{return await browser.tab.title({target:context.input.target});}catch(error){return {code:error.code};}",
    { input: { target }, waitMs: 0 },
  );
  const deadline = Date.now() + 3000;
  while (result.run.endedAt === null) {
    assert.ok(
      Date.now() < deadline,
      "rejected admission left a fictitious live lease",
    );
    result = await f.observe(result.run.runId);
  }
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.deepEqual(result.result.data, { code: "TAB_ALREADY_CLAIMED" });
  assert.ok(
    f.store
      .resourcesForRun(result.run.runId)
      .every((value) => value.closedAt !== null),
  );
  assert.equal(f.plugin.state().connected, true);
  await f.router.endLease("old-owner");
  const next = await f.start(select + "return await tab.title();");
  assert.equal(next.run.status, "succeeded");
  assert.equal(next.result.content[0].text, "Actual native fixture");
});
test("handoff reaches the nonblocking control plane while a native command is pending and cannot be undone by getting the tab again", async (t) => {
  const f = await fixture(t, { gateCommand: true });
  let result = await f.start(
    select +
      'const first=tab.cdp.send("Runtime.enable").then(()=>null,error=>({code:error.code}));await new Promise(resolve=>setTimeout(resolve,15));await tab.markHandoff();const initial=await first;let after;try{const again=await selected.tabs.get(tabs[0].id);await again.title();}catch(error){after=error.code;}return {initial,after};',
    { waitMs: 0 },
  );
  const deadline = Date.now() + 3000;
  while (!f.counts.handoff) {
    assert.ok(
      Date.now() < deadline,
      "handoff was trapped behind its own native command queue",
    );
    await delay(5);
  }
  assert.equal(f.counts.commands, 1);
  assert.equal(f.attached.size, 1);
  f.commandGate.resolve();
  while (result.run.endedAt === null) {
    assert.ok(Date.now() < deadline);
    result = await f.observe(result.run.runId);
  }
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.equal(result.result.data.after, "USER_TAKEOVER");
  assert.equal(f.attached.size, 0);
  assert.equal(f.counts.removed, 0);
});
