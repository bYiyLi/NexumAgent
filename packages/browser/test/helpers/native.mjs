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
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";

// This is a Core conformance harness. No private Core value is passed to the
// production factory: it receives exactly ExtensionHost and Invocation.
const coreEntry = process.env.NEXUM_BROWSER_CORE_DIST
  ? pathToFileURL(path.join(process.env.NEXUM_BROWSER_CORE_DIST, "index.js"))
      .href
  : new URL("../../../../dist/index.js", import.meta.url).href;
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
  fileURLToPath(new URL("../../", import.meta.url)),
);
const version = JSON.parse(
  readFileSync(path.join(source, "package.json"), "utf8"),
).version;
const caller = {
  principalId: "browser-fixture",
  clientId: "native-loopback",
  host: "test",
};
const binary = process.env.NEXUM_BROWSER_NATIVE_BINARY;
assert.ok(
  binary && path.isAbsolute(binary),
  "Set NEXUM_BROWSER_NATIVE_BINARY to an isolated Chrome for Testing/Chromium executable; no user browser is selected automatically.",
);
export async function nativeFixture(t, options = {}) {
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
      fileURLToPath(
        new URL("../../node_modules/" + dependency, import.meta.url),
      ),
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
      authorize(...args) {
        options.authorize?.(...args);
      },
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

  const downloadDirectory = path.join(root, "native-downloads"),
    userData = path.join(root, "browser-profile"),
    home = path.join(root, "home");
  for (const directory of [
    downloadDirectory,
    path.join(userData, "Default"),
    home,
  ])
    mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(userData, "Default", "Preferences"),
    JSON.stringify({
      download: {
        default_directory: downloadDirectory,
        prompt_for_download: false,
        directory_upgrade: true,
      },
    }),
  );
  const downloadBytes = Buffer.alloc(150000, 83);
  const server = createServer((request, response) => {
    if (options.handleRequest?.(request, response)) return;
    if (request.url === "/download") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=native.bin",
        "Content-Length": downloadBytes.length,
      });
      response.end(downloadBytes);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      options.html ??
        `<!doctype html><html><head><title>Nexum native acceptance</title></head><body><h1>Nexum native page</h1><label for="name">Name</label><input id="name"><button onclick="document.querySelector('#answer').textContent='Hello '+document.querySelector('#name').value">Submit</button><p id="answer" data-testid="answer">Waiting</p><a href="/download" download="native.bin">Download native</a><input type="file" id="upload" aria-label="Upload files" multiple></body></html>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/`;
  const runs = new Set();
  let child,
    closed,
    stderr = "";
  t.after(async () => {
    for (const runId of runs) {
      try {
        engine.cancel(caller, runId);
      } catch {}
    }
    const cleanupDeadline = Date.now() + 5000;
    while (Date.now() < cleanupDeadline) {
      let active = false;
      for (const runId of runs) {
        try {
          if (store.getRun(runId).endedAt === null) {
            active = true;
            await engine.observe(caller, runId, 25);
          }
        } catch {}
      }
      if (!active) break;
      await delay(10);
    }
    const entry = services.get("nexum-browser");
    if (entry) await services.disable("nexum-browser").catch(() => {});
    const report = await resources
      .shutdown(new Error("The isolated native test fixture is closing."))
      .catch((error) => ({ error: String(error) }));
    if (report?.unconfirmed?.length)
      t.diagnostic(
        "Native test cleanup retained unconfirmed resource facts; no successful product shutdown was inferred.",
      );
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([closed, delay(4000)]);
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
        await closed;
      }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await delay(0);
    store.close();
    if (process.env.NEXUM_BROWSER_KEEP_NATIVE !== "1")
      rmSync(root, { recursive: true, force: true });
  });
  await services.enable("nexum-browser");
  const extension = path.join(work, ".nexum-browser", "extension");
  child = spawn(
    binary,
    [
      `--user-data-dir=${userData}`,
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      ...(process.env.NEXUM_BROWSER_NATIVE_HEADFUL === "1"
        ? []
        : ["--headless=new"]),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--use-mock-keychain",
      "--password-store=basic",
      // Chrome 158's enable-webmcp-testing flag maps to blink::features::kWebMCP.
      // Opt-in only for native experimental conformance; stock baselines omit it.
      ...(process.env.NEXUM_BROWSER_WEBMCP_TESTING === "1"
        ? ["--enable-features=WebMCP"]
        : []),
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--enable-logging=stderr",
      `--log-net-log=${path.join(root, "network.json")}`,
      base,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      // Chrome's --user-data-dir is the browser-profile boundary. On Windows,
      // retain the real native Known Folder environment instead of fabricating
      // USERPROFILE while LOCALAPPDATA and the current user token still differ.
      env:
        process.platform === "win32"
          ? process.env
          : { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
  closed = once(child, "close");
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(-65536);
  });
  child.on("error", () => {});
  const start = async (script, input = {}, options = {}) => {
    const view = await engine.start(caller, {
      contextId: context.contextId,
      script,
      input,
      waitMs: 0,
      timeoutMs: 60000,
      ...options,
    });
    runs.add(view.run.runId);
    return view;
  };
  const run = async (script, input = {}) => {
    let result = await start(
      `try { ${script} } catch(error) { return {nativeFailure:{code:error.code??"native_error",message:String(error.message)}}; }`,
      input,
      { waitMs: 1000 },
    );
    const until = Date.now() + 65000;
    while (result.run.endedAt === null) {
      assert.ok(
        Date.now() < until,
        `native run failed to settle: ${JSON.stringify(result.run)}; stderr=${stderr.slice(-4096)}`,
      );
      result = await engine.observe(caller, result.run.runId, 50);
    }
    assert.equal(
      result.run.status,
      "succeeded",
      `${JSON.stringify(result.run.error)}; stderr=${stderr.slice(-4096)}`,
    );
    assert.equal(
      result.result?.data?.nativeFailure,
      undefined,
      JSON.stringify({
        failure: result.result?.data?.nativeFailure,
        operations: result.operations,
        stderr: stderr.slice(-4096),
      }),
    );
    return result;
  };
  const deadline = Date.now() + 30000;
  let diagnostics = "";
  while (true) {
    const probe = await run(
      'const {createBrowserClient}=await import("nexum-browser");const client=createBrowserClient(browser),browsers=await client.browsers.list();return {browsers,tabs:browsers.length?await(await client.browsers.getDefault()).tabs.list():[]};',
    );
    if (
      probe.result.data?.browsers.length &&
      probe.result.data.tabs.some((tab) => tab.url === base)
    )
      break;
    assert.equal(child.exitCode, null, `isolated browser exited: ${stderr}`);
    if (Date.now() >= deadline) {
      try {
        const match = stderr.match(
          /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/,
        );
        const targets = await (
          await fetch(`http://127.0.0.1:${match[1]}/json/list`)
        ).json();
        diagnostics = JSON.stringify({
          publicTabs: probe.result.data.tabs,
          nativeTargets: targets.map((value) => ({
            type: value.type,
            url: value.url,
          })),
        });
        for (const target of targets.filter(
          (value) =>
            value.type === "service_worker" &&
            value.url.includes("jefnkdpjllmodpfhhjbegddododpiahf"),
        )) {
          const socket = new WebSocket(target.webSocketDebuggerUrl);
          await once(socket, "open");
          let serial = 0;
          const messages = [],
            pending = new Map();
          socket.on("message", (data) => {
            const message = JSON.parse(data);
            if (message.id && pending.has(message.id)) {
              pending.get(message.id)(message);
              pending.delete(message.id);
            } else messages.push(message);
          });
          const rpc = (method, params = {}) =>
            new Promise((resolve) => {
              const id = ++serial;
              pending.set(id, resolve);
              socket.send(JSON.stringify({ id, method, params }));
            });
          await rpc("Runtime.enable");
          await rpc("Log.enable");
          await rpc("Network.enable");
          diagnostics += JSON.stringify(
            await rpc("Runtime.evaluate", {
              expression:
                '(async()=>({id:chrome.runtime.id,title:await chrome.action.getTitle({}),storage:await chrome.storage.session.get(null),local:await chrome.storage.local.get(null),permission:await navigator.permissions.query({name:"loopback-network"}).then(value=>value.state).catch(error=>String(error))}))()',
              awaitPromise: true,
              returnByValue: true,
            }),
          );
          diagnostics += JSON.stringify(
            await rpc("Runtime.evaluate", {
              expression:
                "new Promise(resolve=>{const socket=new WebSocket('ws://127.0.0.1:43832/nexum-browser/v1');const timer=setTimeout(()=>{socket.close();resolve({state:socket.readyState,timeout:true});},2000);socket.onopen=()=>{clearTimeout(timer);socket.close();resolve({opened:true});};socket.onerror=()=>{clearTimeout(timer);resolve({error:true,state:socket.readyState});};})",
              awaitPromise: true,
              returnByValue: true,
            }),
          );
          await delay(100);
          diagnostics += JSON.stringify(messages);
          socket.close();
        }
      } catch (error) {
        diagnostics += String(error);
      }
    }
    assert.ok(
      Date.now() < deadline,
      `actual MV3 plugin never became online; root=${root}; diagnostics=${diagnostics}; stderr=${stderr}`,
    );
    await delay(100);
  }
  return {
    root,
    work,
    base,
    run,
    start,
    cancel: (runId) => engine.cancel(caller, runId),
    observe: (runId, waitMs = 50) => engine.observe(caller, runId, waitMs),
    input: (runId, waitId, input) =>
      engine.input(caller, {
        agentId: "browser-agent",
        runId,
        waitId,
        input,
        waitMs: 1000,
      }),
    encoder,
    resultScope,
    downloadBytes,
    stderr: () => stderr,
  };
}
export const select = `const {createBrowserClient}=await import("nexum-browser");const client=createBrowserClient(browser);const selected=await client.browsers.getDefault();const choices=await selected.tabs.list();const item=choices.find(item=>item.url===context.input.base);if(!item)throw new Error("Actual test page was not discovered: "+JSON.stringify(choices));const tab=await selected.tabs.get(item.id);`;
