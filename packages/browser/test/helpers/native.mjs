import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { on, once } from "node:events";
import WebSocket from "ws";
import { extensionId } from "../../browser-extension/build.mjs";

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
  { createOutput },
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
  core("sdk/output.js"),
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
const githubMacRunner =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_OS === "macOS" &&
  /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "");
if (
  process.platform === "darwin" &&
  /^microsoft edge/i.test(path.basename(binary)) &&
  !githubMacRunner
) {
  throw Object.assign(
    new Error(
      "Local macOS Edge fixture startup is disabled after Keychain dialogs appeared during isolated-profile checks. Run native Edge checks on a GitHub macOS runner until the cause is resolved.",
    ),
    { code: "LOCAL_NATIVE_EDGE_FIXTURE_DISABLED" },
  );
}
export async function nativeFixture(t, options = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-browser-core-")),
    ),
    work = path.join(root, "work"),
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
      dependencies: { "@nexum-hub/browser": version },
    }),
  );
  const store = new SqliteStore(root, {
    agentId: "browser-agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const connectionDiagnostics = [],
    visualDiagnostics = [];
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 25 }),
    permissions = new Set(["connection", "path", "resource", "url"]),
    registry = new ExtensionRegistry(resources, {
      cleanupTimeoutMs: 25,
      permissions,
      authorize(...args) {
        options.authorize?.(...args);
      },
      log(_origin, entry) {
        if (entry.message === "browser.visual_degraded") {
          visualDiagnostics.push(entry.data);
          if (visualDiagnostics.length > 20) visualDiagnostics.shift();
        }
        if (entry.message !== "browser.connection") return;
        connectionDiagnostics.push(entry.data);
        if (connectionDiagnostics.length > 20) connectionDiagnostics.shift();
      },
      progress() {},
    });
  const policy = {
    builtins: () => [],
    approvedPackages: () => new Map([["@nexum-hub/browser", version]]),
  };
  const modules = await ModuleLoader.create(work, store.bootId, policy),
    packages = new ExtensionPackageLoader(registry, modules, {
      policy,
      permissions,
      enabled: () => new Set(["@nexum-hub/browser"]),
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
    bindings: (scope) => ({
      ...registry.bindings(scope),
      output: createOutput(work, () => scope.assertCurrent()),
    }),
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
  if (options.sessionIdSeed !== undefined) {
    assert.ok(
      Number.isSafeInteger(options.sessionIdSeed) &&
        options.sessionIdSeed > 0 &&
        options.sessionIdSeed < 2 ** 31 - 1000,
    );
    // Configure the real native generator only in this fixture's fresh profile.
    writeFileSync(
      path.join(userData, "Local State"),
      JSON.stringify({
        session_id_generator_last_value: String(options.sessionIdSeed),
      }),
    );
  }
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
    const entry = services.get("@nexum-hub/browser");
    if (entry) await services.disable("@nexum-hub/browser").catch(() => {});
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
  await services.enable("@nexum-hub/browser");
  const extension = path.join(work, ".nexum-browser", "extension");
  for (const name of readdirSync(extension)) {
    if (!name.endsWith(".js") || name === "profile.js") continue;
    assert.deepEqual(
      readFileSync(path.join(extension, name)),
      readFileSync(path.join(packageRoot, "browser-extension", name)),
      `The native fixture would run stale ${name}; rebuild the browser package before acceptance.`,
    );
  }
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
  // Read-only failure/cleanup inspection of this fixture's own MV3 worker. Never
  // inspect a user profile or print journal keys, clipboard values or page data.
  const cleanupFacts = async ({ visualTabId } = {}) => {
    let socket;
    try {
      let visualQuery = "";
      if (visualTabId !== undefined) {
        const tabId = Number(visualTabId);
        assert.ok(
          /^\d+$/.test(String(visualTabId)) && Number.isSafeInteger(tabId),
          "The fixture visual target must be an actual numeric tab ID.",
        );
        visualQuery = `result.visual=(await chrome.scripting.executeScript({target:{tabId:${tabId}},world:'ISOLATED',func:()=>{const visual=globalThis[Symbol.for('nexum.browser.visual.v1')];return {closed:visual?.closed?.size??null,hasCurrent:!!visual?.current};}}))[0]?.result??null;`;
      }
      const port = stderr.match(
        /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/,
      )?.[1];
      assert.ok(port, "The fixture's own DevTools endpoint is missing.");
      const manifest = JSON.parse(
        readFileSync(path.join(extension, "manifest.json"), "utf8"),
      );
      const expectedId = extensionId(manifest.key);
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(2000),
        })
      ).json();
      const worker = targets.find(
        (item) =>
          item.type === "service_worker" &&
          item.url === `chrome-extension://${expectedId}/worker.js`,
      );
      assert.ok(worker, "The fixture's exact MV3 worker is unavailable.");
      socket = new WebSocket(worker.webSocketDebuggerUrl);
      socket.on("error", () => {});
      await once(socket, "open", { signal: AbortSignal.timeout(2000) });
      // DevTools can publish unsolicited events before the command reply.
      // Subscribe before sending and correlate by request id rather than
      // mistaking the first native message for our failure diagnostic.
      const replies = on(socket, "message", {
        signal: AbortSignal.timeout(2000),
      });
      try {
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression: `(async()=>{const state=await chrome.storage.session.get(['nexumOwnedControls','nexumClosedLeases','nexumVisualMarkers']),targets=await chrome.debugger.getTargets();const result={id:chrome.runtime.id,owned:(state.nexumOwnedControls??[]).map(item=>({tabId:item.tabId,runId:item.runId,attached:targets.some(target=>target.tabId===item.tabId&&target.attached),keys:item.keys?.length??0,buttons:item.buttons?.length??0,streams:item.streams?.length??0,viewport:item.viewport,attachmentIntent:item.attachmentIntent})),closedReceipts:state.nexumClosedLeases?.length??0,visualMarkers:state.nexumVisualMarkers?.length??0};${visualQuery}return result;})()`,
              awaitPromise: true,
              returnByValue: true,
            },
          }),
        );
        for await (const [bytes] of replies) {
          const reply = JSON.parse(bytes);
          if (reply.id !== 1) continue;
          assert.equal(reply.result?.result?.value?.id, expectedId);
          return reply.result.result.value;
        }
      } finally {
        await replies.return();
      }
    } catch (error) {
      return { unavailable: String(error.message) };
    } finally {
      socket?.terminate();
    }
  };
  let fixtureBrowserId;
  const start = async (script, input = {}, options = {}) => {
    const view = await engine.start(caller, {
      contextId: context.contextId,
      script,
      input: {
        ...input,
        ...(fixtureBrowserId ? { fixtureBrowserId } : {}),
      },
      waitMs: 0,
      timeoutMs: 60000,
      ...options,
    });
    runs.add(view.run.runId);
    return view;
  };
  const run = async (script, input = {}, options = {}) => {
    let result = await start(
      `try { ${script} } catch(error) { return {nativeFailure:{code:error.code??"native_error",message:String(error.message)}}; }`,
      input,
      { waitMs: 1000, ...options },
    );
    const until = Date.now() + (options.timeoutMs ?? 60000) + 5000;
    while (result.run.endedAt === null) {
      if (Date.now() >= until)
        assert.fail(
          `native run failed to settle: ${JSON.stringify({ run: result.run, operations: result.operations, connectionDiagnostics, nativeCleanup: await cleanupFacts() })}; stderr=${stderr.slice(-4096)}`,
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
        connectionDiagnostics,
      }),
    );
    return result;
  };
  const deadline = Date.now() + 30000;
  let diagnostics = "";
  while (true) {
    const probe = await run(
      'const {createBrowserClient}=await import("@nexum-hub/browser");const client=createBrowserClient(browser),browsers=await client.browsers.list(),matches=[];for(const peer of browsers){const tabs=(await(await client.browsers.get(peer.id)).tabs.list()).filter(tab=>tab.url===context.input.base);if(tabs.length)matches.push({browserId:peer.id,tabs});}return {browsers,matches};',
      { base },
    );
    assert.ok(
      probe.result.data.matches.length <= 1,
      "The owned native fixture page appeared in more than one browser.",
    );
    if (probe.result.data.matches.length === 1) {
      fixtureBrowserId = probe.result.data.matches[0].browserId;
      t.diagnostic(
        JSON.stringify({
          nativeFixture: true,
          observedPeers: probe.result.data.browsers.length,
          ownedMatches: probe.result.data.matches.length,
        }),
      );
      break;
    }
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
          publicMatches: probe.result.data.matches,
          publicPeerCount: probe.result.data.browsers.length,
          connectionDiagnostics,
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
                "new Promise(resolve=>{const socket=new WebSocket('ws://127.0.0.1:29030/nexum-browser/v1');const timer=setTimeout(()=>{socket.close();resolve({state:socket.readyState,timeout:true});},2000);socket.onopen=()=>{clearTimeout(timer);socket.close();resolve({opened:true});};socket.onerror=()=>{clearTimeout(timer);resolve({error:true,state:socket.readyState});};})",
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
    browserId: fixtureBrowserId,
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
    cleanupFacts,
    visualDiagnostics: () => [...visualDiagnostics],
    stderr: () => stderr,
  };
}
export const select = `const {createBrowserClient}=await import("@nexum-hub/browser");const client=createBrowserClient(browser);const selected=await client.browsers.get(context.input.fixtureBrowserId);const choices=await selected.tabs.list();const item=choices.find(item=>item.url===context.input.base);if(!item)throw new Error("The owned native test page was not discovered.");const tab=await selected.tabs.get(item.id);`;
