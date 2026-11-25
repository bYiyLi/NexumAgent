import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
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
import { Server as HttpServer } from "node:http";
import { Server as NetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";
import { FixtureStore, ExecutionFixture, callerKey } from "../../../test/helpers/runtime-fixture.mjs";

// This is a Core conformance harness. No private Core value is passed to the
// production factory: it receives exactly ExtensionHost and Invocation.
const coreEntry = process.env.NEXUM_BROWSER_CORE_DIST
  ? pathToFileURL(path.join(process.env.NEXUM_BROWSER_CORE_DIST, "index.js"))
      .href
  : new URL("../../../dist/index.js", import.meta.url).href;
const core = (relative) => import(new URL(relative, coreEntry).href);
const [
  { ResourceManager },
  { ExtensionRegistry },
  { ExtensionPackageLoader },
  { ExtensionMaterials },
  { ExtensionServices },
  { ModuleLoader },
  { ScriptCatalog },
  { ArtifactStore },
  { ResultEncoder },
  { createOutput },
  { isolatedExtensionFactory },
] = await Promise.all([
  core("extensions/resources.js"),
  core("extensions/registry.js"),
  core("extensions/package-loader.js"),
  core("extensions/materials.js"),
  core("services/extensions.js"),
  core("runtime/modules.js"),
  core("runtime/scripts.js"),
  core("results/artifacts.js"),
  core("results/encoder.js"),
  core("sdk/output.js"),
  core("extensions/worker-bridge.js"),
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
test(
  "local macOS Edge native fixtures stop before launching a browser",
  { skip: process.platform !== "darwin" ? "macOS-only guard" : false },
  () => {
    const helper = new URL("./helpers/native.mjs", import.meta.url).href;
    const cases = [
      {
        name: "local",
        env: { GITHUB_ACTIONS: "false" },
        script: `try { await import(${JSON.stringify(helper)}); throw new Error("Expected the local Edge guard"); } catch(error) { if(error.code!=="LOCAL_NATIVE_EDGE_FIXTURE_DISABLED") throw error; process.stdout.write(error.code); }`,
        expected: "LOCAL_NATIVE_EDGE_FIXTURE_DISABLED",
      },
      {
        name: "GitHub macOS runner",
        env: {
          GITHUB_ACTIONS: "true",
          RUNNER_OS: "macOS",
          GITHUB_RUN_ID: "12345",
        },
        script: `await import(${JSON.stringify(helper)}); process.stdout.write("ALLOWED");`,
        expected: "ALLOWED",
      },
    ];
    for (const item of cases) {
      const child = spawnSync(
        process.execPath,
        [
          "--experimental-vm-modules",
          "--input-type=module",
          "--eval",
          item.script,
        ],
        {
          env: {
            ...process.env,
            ...item.env,
            NEXUM_BROWSER_NATIVE_BINARY: "/nexum-guard-test/Microsoft Edge",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(
        child.status,
        0,
        `${item.name}: ${child.stderr || child.error?.message}`,
      );
      assert.equal(child.stdout, item.expected, item.name);
    }
  },
);

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
  {
    gateDetach = false,
    gateCommand = false,
    nativeDownloads = false,
    declaredDownloadSize = 150000,
    authorize,
    visualFailure = false,
    isolatedWorker = false,
    nativeDialog = false,
  } = {},
) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-browser-core-")),
    ),
    work = root,
    packageRoot = path.join(work, "node_modules", "@nexum-hub/browser");
  mkdirSync(packageRoot, { recursive: true });
  for (const name of [
    "dist",
    "browser-extension",
    "instructions",
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
      dependencies: { "@nexum-hub/browser": version },
    }),
  );
  const store = new FixtureStore(root, {
    agentId: "browser-agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const logs = [];
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 25 }),
    permissions = new Set(["connection", "path", "resource", "url"]),
    registry = new ExtensionRegistry(resources, {
      cleanupTimeoutMs: 25,
      permissions,
      authorize(policy) {
        authorize?.(policy);
      },
      log(_origin, entry) {
        logs.push(entry);
      },
      progress() {},
    });
  const policy = {
    // Match the production-supported Node families used by official scripts.
    builtins: () => ["buffer", "fs", "path", "crypto"],
    approvedPackages: () => new Map([["@nexum-hub/browser", version]]),
  };
  let workerEntry;
  const modules = await ModuleLoader.create(work, store.bootId, policy),
    packages = new ExtensionPackageLoader(registry, modules, {
      policy,
      permissions,
      enabled: () => new Set(["@nexum-hub/browser"]),
      // These native-browser contract tests intentionally own the HTTP
      // listener and a synthetic Chrome peer in the same test process. Keep
      // the original Core/Registry authorization and resource lifecycle while
      // injecting the factory in-process so the fixture's loopback port
      // intercept never touches the installed Agent's actual Worker path.
      // Worker admission/crash/isolation has separate real-Worker tests.
      async createInstance(descriptor, host) {
        if (isolatedWorker)
          return isolatedExtensionFactory(pathToFileURL(workerEntry).href)(host);
        const namespace = await modules.importExtension({
          packageName: descriptor.packageName,
          entry: descriptor.entry.url,
          revision: descriptor.revision,
        });
        return namespace.default(host);
      },
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
    snapshotRef: "snapshot.json",
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
  const engine = new ExecutionFixture(store, modules, scripts, {
    authorize() {},
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    encodeResult: (value, services) =>
      encoder.encode(value, resultScope(services)),
    bindings: (scope) => ({
      ...registry.bindings(scope),
      nativeCommandReady: () => commandStarted.promise,
    }),
    resources,
    leaseScript: (origin) =>
      origin.type === "local" ? () => {} : registry.lease(origin),
  });
  const downloadSource = path.join(root, "native-download.txt"),
    downloadBytes = Buffer.alloc(150000, 57);
  const runs = new Set();
  if (nativeDownloads) writeFileSync(downloadSource, downloadBytes);
  let plugin;
  const attached = new Set(),
    detachGate = Promise.withResolvers(),
    commandGate = Promise.withResolvers(),
    commandStarted = Promise.withResolvers(),
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
    try {
      // Keep the actual peer alive while cancelled runs obtain native cleanup receipts.
      for (const runId of runs)
        if (store.getRun(runId).endedAt === null) engine.cancel(caller, runId);
      const end = Date.now() + 10000;
      for (const runId of runs)
        while (store.getRun(runId).endedAt === null) {
          assert.ok(
            Date.now() < end,
            "The fixture run did not confirm cleanup before peer shutdown.",
          );
          await engine.observe(caller, runId, 50);
        }
      const entry = services.get("@nexum-hub/browser");
      if (entry) await services.disable("@nexum-hub/browser");
      const report = await resources.shutdown(
        new Error("The Core browser fixture is closing."),
      );
      assert.deepEqual(report.unconfirmed, []);
    } finally {
      await plugin?.dispose().catch(() => {});
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  // The published extension still requires its profile port range. Only this
  // test process redirects the native listener to an OS-assigned loopback
  // port, so the Core conformance tests cannot collide with a running Dev
  // Agent or with another test process.
  let testPort;
  if (isolatedWorker) {
    const temporaryListener = new NetServer();
    await new Promise((resolve, reject) => {
      temporaryListener.once("error", reject);
      temporaryListener.listen(0, "127.0.0.1", resolve);
    });
    testPort = temporaryListener.address().port;
    await new Promise((resolve) => temporaryListener.close(resolve));
    // Only the isolated test Worker imports this wrapper. It redirects the
    // development-profile listener without touching installed Agent ports,
    // allowing the genuine Browser extension to run across the Worker bridge.
    workerEntry = path.join(root, "isolated-browser-worker.mjs");
    writeFileSync(workerEntry, [
      'import { Server as HttpServer } from "node:http";',
      'const listen = HttpServer.prototype.listen;',
      `HttpServer.prototype.listen = function (port, ...args) { return listen.call(this, port === 29030 ? ${testPort} : port, ...args); };`,
      `const extension = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist/extension/index.js")).href)});`,
      'export default extension.default;',
    ].join("\n"));
  }
  const originalListen = HttpServer.prototype.listen,
    previousDescriptor = Object.getOwnPropertyDescriptor(
      HttpServer.prototype,
      "listen",
    );
  if (!isolatedWorker)
    HttpServer.prototype.listen = function (port, ...args) {
      if (port !== 29030) return originalListen.call(this, port, ...args);
      this.once("listening", () => {
        const address = this.address();
        testPort = address?.port;
      });
      return originalListen.call(this, 0, ...args);
    };
  let enabled;
  try {
    enabled = await services.enable("@nexum-hub/browser");
  } finally {
    if (previousDescriptor)
      Object.defineProperty(HttpServer.prototype, "listen", previousDescriptor);
    else delete HttpServer.prototype.listen;
  }
  assert.equal(enabled.status, "enabled");
  assert.ok(Number.isInteger(testPort) && testPort > 0 && testPort !== 29030);
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
    windows: {
      getAll: async () => [{
        id: 1, focused: true, state: "normal",
        left: 0, top: 0, width: 800, height: 600,
      }],
    },
    alarms: {
      create: async () => {},
      clear: async () => true,
      onAlarm: event(),
    },
    tabs: {
      query: async (query = {}) => tabs
        .filter((tab) =>
          (query.active === undefined || tab.active === query.active) &&
          (query.windowId === undefined || tab.windowId === query.windowId) &&
          (query.currentWindow !== true || tab.windowId === 1))
        .map((value) => ({ ...value })),
      get: async (id) => {
        const tab = tabs.find((value) => value.id === id);
        if (!tab) throw new Error("No tab");
        return { ...tab };
      },
      create: async (options) => {
        const tab = { id: Math.max(...tabs.map((value) => value.id)) + 1,
          url: options.url ?? "about:blank", title: "New tab", active: options.active,
          windowId: 1, groupId: -1 };
        tabs.push(tab);
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
      sendCommand: async (_source, method, params) => {
        // Page.enable is now part of attaching the debugger so a modal can be
        // observed before the page executes any JavaScript. The command gate
        // deliberately holds the scenario's user Runtime.enable, not the
        // prerequisite Page event subscription.
        if (method !== "Page.enable") {
          counts.commands++;
          commandStarted.resolve();
          if (gateCommand) await commandGate.promise;
        }
        if (
          method === "Fetch.continueResponse" &&
          nativeDownloads === "matched"
        ) {
          const disposition = params.responseHeaders.find(
            (header) => header.name.toLowerCase() === "content-disposition",
          ).value;
          const filename = /filename="([^"]+)"/.exec(disposition)?.[1];
          assert.ok(filename);
          chrome.downloads.onDeterminingFilename.emit(
            { id: 71, filename },
            () => {},
          );
          chrome.debugger.onEvent.emit(_source, "Page.downloadWillBegin", {
            guid: "download-fixture",
            url: "https://fixture.test/file",
            suggestedFilename: filename,
          });
          chrome.debugger.onEvent.emit(_source, "Page.downloadProgress", {
            guid: "download-fixture",
            state: "completed",
            receivedBytes: downloadBytes.length,
            totalBytes: downloadBytes.length,
          });
          return {};
        }
        if (method === "Page.navigate" && nativeDownloads === "matched") {
          const request = { url: "https://fixture.test/file" };
          chrome.debugger.onEvent.emit(_source, "Fetch.requestPaused", {
            requestId: "download-request",
            request,
          });
          await delay(0);
          chrome.debugger.onEvent.emit(_source, "Fetch.requestPaused", {
            requestId: "download-request",
            request,
            responseStatusCode: 200,
            responseHeaders: [
              {
                name: "Content-Disposition",
                value: "attachment; filename=report.bin",
              },
            ],
          });
          return { frameId: "main" };
        }
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
        if (nativeDialog && method === "Runtime.evaluate") {
          chrome.debugger.onEvent.emit(_source, "Page.javascriptDialogOpening", {
            type: "prompt", message: "Fixture prompt",
          });
          return { result: { value: true } };
        }
        if (nativeDialog && method === "Page.handleJavaScriptDialog") {
          chrome.debugger.onEvent.emit(_source, "Page.javascriptDialogClosed", {});
          return {};
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
  chrome.scripting = {
    async executeScript(input) {
      assert.equal(input.world, "ISOLATED");
      const command = input.args[0].command;
      assert.ok(["readyState", "devicePixelRatio"].includes(command));
      return [{
        frameId: 0,
        result: {
          ok: true,
          value: command === "readyState" ? "complete" : 1,
        },
      }];
    },
  };
  chrome.downloads = {
    onCreated: event(),
    onChanged: event(),
    onDeterminingFilename: event(),
    search: async () => [
      {
        id: 71,
        state: "complete",
        exists: true,
        filename: downloadSource,
        fileSize: declaredDownloadSize,
      },
    ],
  };
  class ExtensionSocket extends WebSocket {
    constructor(url) {
      assert.equal(url, "ws://127.0.0.1:29030/nexum-browser/v1");
      super(`ws://127.0.0.1:${testPort}/nexum-browser/v1`, {
        origin: `chrome-extension://${extensionId}`,
      });
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
  let connection;
  const router = createBrowserRouter(chrome, {
    ...(visualFailure
      ? { emit: (message) => connection?.publish(message) }
      : {}),
    ...(visualFailure
      ? {
          visual: {
            async start() {},
            async beforeAction() {
              throw new Error("fixture visual failure");
            },
            async releaseTab() {},
            async dispose() {},
          },
        }
      : {}),
  });
  connection = createExtensionConnection({
    chrome,
    WebSocket: ExtensionSocket,
    router,
    profile: "development",
    extensionVersion: release.extensionVersion,
  });
  plugin = connection;
  await plugin.start();
  let fixtureBrowserId;
  const start = async (script, options = {}) => {
    let value = await engine.start(caller, {
      contextId: context.contextId,
      script,
      ...options,
      input: options.scriptName ? options.input ?? {} : { ...options.input, fixtureBrowserId },
    });
    runs.add(value.run.runId);
    if (options.waitMs === 0) return value;
    // A returned MCP wait window is not a terminal run. Ordinary cases need the actual result.
    const end = Date.now() + 60000;
    while (value.run.endedAt === null) {
      assert.ok(
        Date.now() < end,
        "The Core fixture run did not reach its actual terminal state.",
      );
      value = await engine.observe(caller, value.run.runId, 50);
    }
    return value;
  };
  const end = Date.now() + 3000;
  while (!plugin.state().connected) {
    assert.ok(
      Date.now() < end,
      "MV3 fixture did not complete real loopback handshake",
    );
    await delay(5);
  }
  fixtureBrowserId = plugin.state().browserId;
  assert.equal(typeof fixtureBrowserId, "string");
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
    simulateUserCancel: (tabId = 1) =>
      chrome.debugger.onDetach.emit({ tabId }, "canceled_by_user"),
    downloadSource,
    downloadBytes,
    encoder,
    resultScope,
    logs,
    observe: (id) => engine.observe(caller, id, 50),
  };
}
const select = `const {createBrowserClient}=await import("@nexum-hub/browser");const client=createBrowserClient(browser);const selected=await client.browsers.get(context.input.fixtureBrowserId);const tabs=await selected.tabs.list();const tab=await selected.tabs.get('1');`;

test("actual isolated Browser Worker can get a tab and clean its RunScope", async (t) => {
  const f = await fixture(t, { isolatedWorker: true });
  const result = await f.start(
    select + "let caps,shot;" +
      "try{const list=await selected.capabilities.list();caps={count:list.length}}" +
      "catch(e){caps={error:e.code||e.name,message:e.message}}" +
      "const windows=await selected.windows.list();" +
      "try{const image=await tab.screenshot();shot={bytes:image.byteLength}}" +
      "catch(e){shot={error:e.code||e.name,message:e.message}}" +
      "return {title:await tab.title(),tabs:tabs.length,caps,shot,windows:windows.length};",
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result.run.error));
  assert.equal(result.result.data.title, "Actual native fixture");
  assert.equal(result.result.data.tabs, 2);
  assert.equal(result.result.data.windows, 1);
  assert.ok(result.result.data.caps.count > 0, JSON.stringify(result.result.data));
  assert.ok(result.result.data.shot.bytes > 0, JSON.stringify(result.result.data));
  assert.ok(result.operations.items.some((item) =>
    item.method === "tabs.get" && item.status === "succeeded"));
  const scopes = f.store.resourcesForRun(result.run.runId).filter((item) =>
    item.kind === "browser.run");
  assert.equal(scopes.length, 1);
  assert.ok(scopes.every((item) => item.closedAt !== null),
    "the real Worker must close its run control after native operations");
});

test("actual isolated Browser Worker handles opaque dialog objects and absent dialogs", async (t) => {
  const f = await fixture(t, { isolatedWorker: true, nativeDialog: true });
  const result = await f.start(select + `
    const absent=await tab.getJsDialog();
    await tab.cdp.send("Runtime.evaluate",{expression:"true"});
    const first=await tab.getJsDialog();
    if(first?.type!=="prompt") throw Error("Missing prompt");
    await first.dismiss();
    await tab.cdp.send("Runtime.evaluate",{expression:"true"});
    const second=await tab.getJsDialog();
    await second.accept("中文");
    return {absent:absent??null,closed:(await tab.getJsDialog())??null};
  `);
  assert.equal(result.run.status, "succeeded", JSON.stringify(result.run.error));
  assert.deepEqual(result.result.data, { absent: null, closed: null });
});

test("visual degradation reaches extension logs with its actual run and action while the browser action continues", async (t) => {
  const f = await fixture(t, { visualFailure: true });
  const result = await f.start(
    select + 'await tab.cdp.send("Page.enable");return {done:true};',
  );
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(result.result.data, { done: true });
  const entry = f.logs.find(
    (item) => item.message === "browser.visual_degraded",
  );
  assert.ok(
    entry,
    "the actual extension log did not receive visual degradation",
  );
  assert.equal(entry.level, "warn");
  assert.equal(entry.data.runId, result.run.runId);
  assert.equal(entry.data.reason, "VISUAL_UNAVAILABLE");
  assert.equal(entry.data.tabId, "1");
  assert.ok(
    result.operations.items.some(
      (item) => item.operationId === entry.data.operationId,
    ),
  );
  assert.doesNotMatch(JSON.stringify(entry), /fixture visual failure|https?:/);
});

test("the installed Browser package publishes its own Skill, instructions and scripts and cleans a Core run", async (t) => {
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
  assert.equal(
    f.materials.published().skills.filter((entry) => entry.skillId === "browser/browser-control").length,
    1,
  );
  assert.equal(f.materials.scriptSources().length, 1);
  assert.equal("docs" in f.materials.published(), false);
  const disabled = await f.services.disable("@nexum-hub/browser");
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(f.materials.scriptSources(), []);
  assert.equal(
    f.materials.published().skills.some((entry) => entry.skillId === "browser/browser-control"),
    false,
  );
  assert.equal(f.materials.published().instructions.length, 0);
  assert.equal(f.counts.removed, 0);
  assert.equal(f.tabs.length, 2);
});
test("registered Browser scripts deliver real discovery data and the original JPEG image", async (t) => {
  const f = await fixture(t);
  const installation = await f.start(undefined, { scriptName: "browser/installation.js", input: {} });
  assert.equal(installation.run.status, "succeeded", JSON.stringify(installation.run.error));
  assert.equal(installation.result.data.assetsReady, true);
  assert.equal(installation.result.data.directory, path.join(f.work, ".nexum-browser", "extension"));
  assert.equal(installation.result.data.profile, "development");
  const discovery = await f.start(undefined, { scriptName: "browser/discover.js", input: {} });
  assert.equal(discovery.run.status, "succeeded", JSON.stringify(discovery.run.error));
  const browserId = f.plugin.state().browserId;
  assert.equal(discovery.result.data[0].browser.id, browserId);
  assert.ok(discovery.result.data[0].tabs.some(tab => tab.id === "1"));
  const screenshot = await f.start(undefined, { scriptName: "browser/screenshot.js", input: { browserId, tabId: "1" } });
  assert.equal(screenshot.run.status, "succeeded", JSON.stringify(screenshot.run.error));
  const rendered = await f.encoder.render(screenshot.result, f.resultScope(), screenshot.run);
  const image = rendered.content.find(value => value.type === "image");
  assert.ok(image);
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual(Buffer.from(image.data, "base64"), Buffer.from(jpeg, "base64"));
  assert.equal(f.attached.size, 0);
});

test("native File with structured download metadata crosses Worker and result encoder without public output", async (t) => {
  const f = await fixture(t);
  const result = await f.start(
    'const {File}=await import("node:buffer"); return {state:"complete",file:new File([new Uint8Array([0,1,127,255])],"native.bin")};',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result.run.error));
  const rendered = await f.encoder.render(result.result, f.resultScope(), result.run);
  assert.equal(rendered.structuredContent.data.state, "complete");
  const link = rendered.content.find((item) => item.type === "resource_link");
  assert.ok(link?.uri);
  const resource = await f.encoder.readResource(link.uri, f.resultScope());
  assert.deepEqual(Buffer.from(resource.contents[0].blob, "base64"), Buffer.from([0,1,127,255]));
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
  await assert.rejects(f.services.disable("@nexum-hub/browser"), {
    code: "extension_busy",
  });
  assert.equal(f.services.get("@nexum-hub/browser").status, "enabled");
  assert.equal(
    f.materials.published().skills.filter((entry) => entry.skillId === "browser/browser-control").length,
    1,
  );
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
  assert.equal((await f.services.disable("@nexum-hub/browser")).status, "disabled");
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
  // The second Core run may take longer to prepare on a loaded CI runner.
  // Give native cancellation its own bounded observation window after release.
  const cleanupDeadline = Date.now() + 4000;
  while (first.run.endedAt === null) {
    assert.ok(
      Date.now() < cleanupDeadline,
      "cancel did not finish after actual native settlement and detach",
    );
    first = await f.observe(first.run.runId);
  }
  assert.equal(first.run.status, "cancelled");
  assert.equal(f.attached.size, 0);
  assert.equal(f.counts.removed, 0);
});

test("a live lease on one tab does not prevent another Core Run from creating and controlling a different tab", async (t) => {
  const f = await fixture(t);
  let first = await f.start(select + 'await tab.cdp.send("Runtime.enable");await new Promise(resolve=>setTimeout(resolve,30000));', {waitMs:0,timeoutMs:45000});
  const deadline = Date.now()+10000;
  while (!first.operations?.items?.some(operation=>operation.method==="cdp.send" && operation.status==="succeeded")) {
    assert.ok(Date.now()<deadline,"the first Run did not acquire its tab");
    first=await f.observe(first.run.runId);
  }
  const created=await f.start('const {createBrowserClient}=await import("@nexum-hub/browser");const selected=await createBrowserClient(browser).browsers.get(context.input.fixtureBrowserId);const fresh=await selected.tabs.new("https://fixture.test/third",{active:false});return {id:fresh.id,title:await fresh.title()};');
  assert.equal(created.run.status,"succeeded",JSON.stringify(created.run.error));
  assert.deepEqual(created.result.data,{id:"3",title:"New tab"});
  f.engine.cancel(caller,first.run.runId);
  first=await f.observe(first.run.runId);
  const cleanupDeadline=Date.now()+10000;
  while(first.run.endedAt===null){
    assert.ok(Date.now()<cleanupDeadline,"first Run cleanup not confirmed");
    first=await f.observe(first.run.runId);
  }
  assert.equal(first.run.status,"cancelled");
  assert.equal(f.attached.size,0);
});
test("revoked run cannot recreate browser control after native closure releases its scope", async () => {
  const { EventEmitter } = await import("node:events");
  const { BrowserRuntime } = await import("../dist/extension/scope.js");
  const runtime = new BrowserRuntime(new EventEmitter());
  const call = {
    context: { runId: "run_original" },
    deadline: Date.now() + 30000,
    resources: {
      async register({ value }) {
        return { id: "res_original", kind: "browser.run", value,
          signal: new AbortController().signal, report() {} };
      },
    },
    signal: new AbortController().signal,
  };
  const scope = await runtime.scope(call);
  scope.revoke();
  await scope.closed;
  await assert.rejects(runtime.scope(call), { code: "USER_TAKEOVER" });
  const fresh = await runtime.scope({
    ...call, context: { runId: "run_new" },
  });
  assert.notEqual(fresh, scope);
  await fresh.dispose();
});

test("a user debugger cancel keeps the original run revoked after its native lease has closed", async (t) => {
  const f = await fixture(t);
  let run = await f.start(select + `
    await tab.cdp.send('Runtime.enable');
    let waitError;
    try { await tab.playwright.waitForDownload({timeoutMs:110000}); }
    catch (error) { waitError = error.code; }
    let nextError;
    try { await tab.cdp.send('Runtime.enable'); }
    catch (error) { nextError = error.code; }
    return {waitError, nextError};`, { waitMs: 0, timeoutMs: 120000 });
  const until = Date.now() + 15000;
  while (!run.operations?.items?.some((operation) =>
    operation.method === "waiters.get" && operation.status === "running")) {
    assert.ok(Date.now() < until, "The fixture did not enter its native waiter.");
    run = await f.observe(run.run.runId);
  }
  assert.equal(f.attached.size, 1);
  f.simulateUserCancel();
  while (run.run.endedAt === null) {
    assert.ok(Date.now() < until, "The cancelled fixture did not settle.");
    run = await f.observe(run.run.runId);
  }
  assert.equal(run.run.status, "succeeded", JSON.stringify(run.run.error));
  assert.deepEqual(run.result.data, {
    waitError: "USER_TAKEOVER", nextError: "USER_TAKEOVER",
  });
  const next = await f.start(select + 'return await tab.cdp.send("Runtime.enable");');
  assert.equal(next.run.status, "succeeded", JSON.stringify(next.run.error));
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

test("browser download records are not filtered by file-read authorization", async (t) => {
  let denyFileReads = false;
  const f = await fixture(t, {
    nativeDownloads: true,
    authorize(policy) {
      if (denyFileReads && policy.target?.type === "path")
        throw Object.assign(new Error("path denied"), {
          code: "path_not_allowed",
        });
    },
  });
  denyFileReads = true;
  const result = await f.start(
    select + "return await selected.downloads.list({limit:20});",
  );
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.equal(result.result.data[0].filename, f.downloadSource);
  assert.equal(result.result.data[0].state, "complete");
  await assert.rejects(
    f.encoder.encode(createOutput(f.work, () => {}).file(f.downloadSource), {
      ...f.resultScope(),
      authorize(target) {
        if (target.path === f.downloadSource)
          throw Object.assign(new Error("path denied"), {
            code: "path_not_allowed",
          });
      },
    }),
    { code: "path_not_allowed" },
  );
});

test("repeated original download waiters stay usable while Core never copies a file identified only by URL and time", async (t) => {
  const f = await fixture(t, { nativeDownloads: true });
  const result = await f.start(
    select +
      'let download;for(let i=0;i<38;i++){const pending=tab.playwright.waitForEvent("download");await tab.cdp.send("Page.navigate",{url:"https://fixture.test/file"});download=await pending;}const reject=async action=>{try{await action();return null;}catch(error){return error.code;}};const pathError=await reject(()=>download.path());const downloads=await tab.downloads();const saveError=await reject(()=>tab.saveDownload(downloads[0].id,"copied.txt"));return {pathError,saveError,downloadId:downloads[0].id};',
  );
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.deepEqual(result.result.data, {
    pathError: "CAPABILITY_NOT_ALLOWED",
    saveError: "CAPABILITY_NOT_ALLOWED",
    downloadId: "download-fixture",
  });
  assert.equal(existsSync(path.join(f.work, "copied.txt")), false);
  assert.deepEqual(readFileSync(f.downloadSource), f.downloadBytes);
  assert.equal(f.attached.size, 0);
});

test("a proven download record survives the complete SDK and native resource delivery path", async (t) => {
  const f=await fixture(t,{nativeDownloads:"matched"});
  const result=await f.start(select+
    'const pending=tab.playwright.waitForDownload();await tab.cdp.send("Page.navigate",{url:"https://fixture.test/file"});const download=await pending;const file=await download.path();const row=(await tab.downloads()).find(item=>item.id===download.id);const records=await selected.downloads.list({id:row.nativeRecordId});if(download.id!=="download-fixture"||row.nativeRecordId!==71||records.length!==1||records[0].id!==71||records[0].state!=="complete")throw Error("download identity mismatch");return {type:"resource_link",path:file};');
  assert.equal(result.run.status,"succeeded",JSON.stringify(result.run.error));
  const rendered=await f.encoder.render(result.result,f.resultScope(),result.run);
  const link=rendered.content.find(item=>item.type==="resource_link");
  assert.ok(link?.uri);
  const resource=await f.encoder.readResource(link.uri,f.resultScope());
  const bytes=Buffer.from(resource.contents[0].blob,"base64");
  assert.deepEqual(bytes,f.downloadBytes);
  assert.equal(f.attached.size,0);
});

test("browser file size is enforced before the downloaded artifact is published", async (t) => {
  const f = await fixture(t, {
    nativeDownloads: "matched",
    declaredDownloadSize: 150001,
  });
  const result = await f.start(
    select +
      'const pending=tab.playwright.waitForDownload();await tab.cdp.send("Page.navigate",{url:"https://fixture.test/file"});const download=await pending;try{return {path:await download.path()};}catch(error){return {error:error.code};}',
  );
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  assert.deepEqual(result.result.data, { error: "FILE_SIZE_MISMATCH" });
  assert.deepEqual(readFileSync(f.downloadSource), f.downloadBytes);
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
  assert.equal(next.result.data, "Actual native fixture");
});
test("handoff reaches the nonblocking control plane while a native command is pending and cannot be undone by getting the tab again", async (t) => {
  const f = await fixture(t, { gateCommand: true });
  let result = await f.start(
    select +
      'const first=tab.cdp.send("Runtime.enable").then(()=>null,error=>({code:error.code}));await nativeCommandReady();await tab.markHandoff();const initial=await first;let after;try{const again=await selected.tabs.get(tabs[0].id);await again.title();}catch(error){after=error.code;}return {initial,after};',
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
