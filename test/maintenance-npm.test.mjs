import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
const dist = new URL(
  process.env.NEXUM_MAINTENANCE_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { NpmMaintenanceBackend, ExtensionEnablement },
  { maintenanceIntent },
  { SqliteStore },
  { ResourceManager },
  { ExtensionRegistry },
  { ExtensionPackageLoader },
  { ExtensionMaterials },
  { ExtensionServices },
  { ModuleLoader },
  { RunEngine, callerKey },
  { ScriptCatalog },
  { AgentError },
] = await Promise.all(
  [
    "maintenance/npm.js",
    "maintenance/requests.js",
    "storage/sqlite.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "extensions/package-loader.js",
    "extensions/materials.js",
    "services/extensions.js",
    "runtime/modules.js",
    "runtime/engine.js",
    "runtime/scripts.js",
    "contracts/errors.js",
  ].map((file) => import(new URL(file, dist))),
);
const { ApprovedPackageCatalog } = await import(
  new URL("application/packages.js", dist)
);
const run = promisify(execFile),
  name = "nexum-maintenance-native-fixture";
const cli =
  process.platform === "win32"
    ? path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      )
    : path.resolve(
        path.dirname(process.execPath),
        "..",
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
function write(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
async function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-native-npm-")),
    ),
    work = path.join(root, "work"),
    marker = path.join(root, "install-markers.txt"),
    empty = path.join(root, "npmrc"),
    globalConfig = path.join(root, "global-npmrc");
  write(path.join(work, "package.json"), {
    name: "private-agent-work",
    version: "1.0.0",
    private: true,
    type: "module",
  });
  write(empty, "");
  write(globalConfig, "");
  const env = {
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: empty,
    npm_config_globalconfig: globalConfig,
    npm_config_update_notifier: "false",
    npm_config_fetch_retries: "0",
    NPM_FIXTURE_INSTALL_MARKER: marker,
  };
  const archives = new Map();
  const controlKey = `native-maintenance-${randomUUID()}`,
    control = {
      entered: Promise.withResolvers(),
      gate: Promise.withResolvers(),
    };
  globalThis[Symbol.for(controlKey)] = control;
  for (const version of ["1.0.0", "2.0.0"]) {
    const source = path.join(root, `source-${version}`);
    write(path.join(source, "package.json"), {
      name,
      version,
      type: "module",
      main: "index.js",
      exports: {
        ".": "./index.js",
        "./nexum": { types: "./extension.d.ts", import: "./extension.js" },
      },
      nexum: {
        apiVersion: 1,
        namespace: "fixtureSDK",
        permissions: ["read"],
        docs: "./docs",
      },
      scripts: { install: "node install.js" },
    });
    write(
      path.join(source, "index.js"),
      `export const version=${JSON.stringify(version)};`,
    );
    write(
      path.join(source, "extension.d.ts"),
      "export default function createExtension(host:unknown):unknown;\n",
    );
    write(
      path.join(source, "docs/README.md"),
      "# Native npm extension fixture\n",
    );
    write(
      path.join(source, "install.js"),
      `import {appendFileSync,writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';appendFileSync(process.env.NPM_FIXTURE_INSTALL_MARKER,${JSON.stringify(version + "\n")});if(process.env.NPM_FIXTURE_INSTALL_HOLD){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.env.NPM_FIXTURE_INSTALL_HOLD,String(child.pid));setInterval(()=>{},1000);}`,
    );
    write(
      path.join(source, "extension.js"),
      `export default function(){const control=globalThis[Symbol.for(${JSON.stringify(controlKey)})];return {methods:{echo:{description:'Return actual installed version',permissions:['read'],schemaDialect:'draft7',inputSchema:{type:'object'},handle(){return ${JSON.stringify(version)}}},wait:{description:'Hold one actual SDK call',permissions:['read'],schemaDialect:'draft7',inputSchema:{type:'object'},async handle(){control.entered.resolve();await control.gate.promise;return ${JSON.stringify(version)}}}}}}`,
    );
    const packed = await run(
      process.execPath,
      [cli, "pack", "--ignore-scripts", "--json"],
      { cwd: source, env: { ...process.env, ...env } },
    );
    const file = JSON.parse(packed.stdout)[0].filename,
      bytes = readFileSync(path.join(source, file));
    archives.set(version, {
      bytes,
      integrity:
        "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    });
  }
  let latest = "1.0.0",
    requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const uri = new URL(req.url, "http://fixture");
    if (uri.pathname === `/${name}`) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name,
          "dist-tags": { latest },
          versions: Object.fromEntries(
            [...archives].map(([version, item]) => [
              version,
              {
                name,
                version,
                scripts: { install: "node install.js" },
                dist: {
                  tarball: `${base}/${name}/-/${version}.tgz`,
                  integrity: item.integrity,
                },
              },
            ]),
          ),
        }),
      );
      return;
    }
    const match = /\/(\d+\.\d+\.\d+)\.tgz$/.exec(uri.pathname),
      archive = match && archives.get(match[1]);
    if (archive) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(archive.bytes);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  env.npm_config_registry = base;
  const store = new SqliteStore(root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    }),
    resources = new ResourceManager(store, { cleanupTimeoutMs: 30 }),
    registry = new ExtensionRegistry(resources, {
      permissions: new Set(["read"]),
      authorize() {},
    }),
    approved = new Map(),
    policy = {
      builtins: () => ["node:path"],
      approvedPackages: () => approved,
    },
    modules = await ModuleLoader.create(work, store.bootId, policy),
    enablement = await ExtensionEnablement.open(root),
    packages = new ExtensionPackageLoader(registry, modules, {
      policy,
      permissions: new Set(["read"]),
      enabled: () => enablement.enabled(),
    }),
    materials = new ExtensionMaterials(work),
    extensions = new ExtensionServices(registry, packages, materials);
  const catalog = await ApprovedPackageCatalog.open(root, {
      agentId: "agent",
      profile: "development",
    }),
    snapshots = [];
  const refresh = async (snapshot) => {
    await catalog.accept(snapshot);
    snapshots.push(snapshot);
    approved.clear();
    for (const [key, value] of catalog.approvedPackages())
      approved.set(key, value);
  };
  const backend = new NpmMaintenanceBackend({
    root,
    modules,
    extensions,
    enablement,
    npmCli: cli,
    env,
    refreshPackages: refresh,
  });
  let allowed = true;
  const controller = new AbortController();
  const scope = {
    caller: { principalId: "user", clientId: "test", grantId: "verified" },
    operationId: "op_" + "1".repeat(32),
    signal: controller.signal,
    assertCurrent() {
      if (!allowed)
        throw new AgentError("forbidden", "Fixture authority revoked.");
    },
    authorize() {},
  };
  write(path.join(work, "snapshot.json"), { project: null });
  const context = store.openWork({
      callerKey: callerKey(scope.caller),
      pwd: work,
      snapshotRef: "work/snapshot.json",
    }),
    scripts = new ScriptCatalog(work, "agent", () => []),
    engine = new RunEngine(store, modules, scripts, {
      authorize() {},
      loadWork: () => ({ project: null }),
      encodeResult: async (value) => JSON.parse(JSON.stringify(value)),
      bindings: (services) => registry.bindings(services),
      resources,
    }),
    runs = [];
  const start = async (script, waitMs = 3000) => {
    const value = await engine.start(scope.caller, {
      contextId: context.contextId,
      script,
      waitMs,
    });
    runs.push(value.run.runId);
    return value;
  };
  const intent = (method, extra = {}) =>
      maintenanceIntent(method, { name, ...extra }, work),
    prepare = (method, extra) => backend.prepare(intent(method, extra), scope),
    apply = (method, candidate, extra) =>
      backend.apply(intent(method, extra), candidate, scope);
  t.after(async () => {
    control.gate.resolve();
    for (const runId of runs)
      await engine
        .get(scope.caller, { agentId: "agent", runId, waitMs: 3000 })
        .catch(() => {});
    for (const entry of extensions.list())
      await extensions.disable(entry.name).catch(() => {});
    delete globalThis[Symbol.for(controlKey)];
    store.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    marker,
    backend,
    scope,
    store,
    registry,
    modules,
    extensions,
    enablement,
    approved,
    catalog,
    snapshots,
    intent,
    prepare,
    apply,
    controller,
    env,
    engine,
    start,
    control,
    setLatest(value) {
      latest = value;
    },
    requests: () => requests,
    revoke() {
      allowed = false;
    },
  };
}

test("real npm preparation runs no install code and approved exact plans install/update/remove once", async (t) => {
  const f = await fixture(t);
  const initial = JSON.parse(
    readFileSync(path.join(f.work, "package.json"), "utf8"),
  );
  initial.optionalDependencies = { "fixture-optional-missing": "1.0.0" };
  write(path.join(f.work, "package.json"), initial);
  const manifest = readFileSync(path.join(f.work, "package.json"), "utf8");
  const first = await f.prepare("packages.install");
  assert.equal(first.summary.version, "1.0.0");
  assert.equal(existsSync(f.marker), false);
  assert.equal(
    readFileSync(path.join(f.work, "package.json"), "utf8"),
    manifest,
  );
  assert.equal(existsSync(path.join(f.work, "package-lock.json")), false);
  f.setLatest("2.0.0");
  const installed = await f.apply("packages.install", first);
  assert.equal(installed.package.installedVersion, "1.0.0");
  assert.deepEqual(f.snapshots[0].target, {
    name,
    action: "install",
    version: "1.0.0",
  });
  assert.equal(
    f.snapshots[0].manifest,
    readFileSync(path.join(f.work, "package.json"), "utf8"),
  );
  assert.equal(
    f.snapshots[0].lock,
    readFileSync(path.join(f.work, "package-lock.json"), "utf8"),
  );
  assert.deepEqual([...f.catalog.approvedPackages()], [[name, "1.0.0"]]);
  assert.equal(f.extensions.list().length, 0);
  assert.equal(readFileSync(f.marker, "utf8"), "1.0.0\n");
  const second = await f.prepare("packages.update");
  assert.equal(second.summary.version, "2.0.0");
  assert.equal(readFileSync(f.marker, "utf8"), "1.0.0\n");
  const updated = await f.apply("packages.update", second);
  assert.equal(updated.package.installedVersion, "2.0.0");
  assert.deepEqual(f.snapshots[1].target, {
    name,
    action: "update",
    version: "2.0.0",
  });
  assert.deepEqual([...f.catalog.approvedPackages()], [[name, "2.0.0"]]);
  assert.equal(readFileSync(f.marker, "utf8"), "1.0.0\n2.0.0\n");
  const remove = await f.prepare("packages.remove"),
    removed = await f.apply("packages.remove", remove);
  assert.equal(removed.package.declared, false);
  assert.equal(removed.package.installedVersion, null);
  assert.deepEqual(f.snapshots[2].target, {
    name,
    action: "remove",
    version: null,
  });
  assert.equal(f.catalog.approvedPackages().size, 0);
  assert.equal(readFileSync(f.marker, "utf8"), "1.0.0\n2.0.0\n");
  assert.ok(f.requests() > 0);
});
test("real installed extension enable/disable uses static preparation then the existing publication lifecycle", async (t) => {
  const f = await fixture(t);
  await f.apply("packages.install", await f.prepare("packages.install"));
  const enable = await f.prepare("extensions.enable");
  assert.equal(f.modules.loadedPackages().length, 0);
  assert.equal(f.extensions.list().length, 0);
  const active = await f.apply("extensions.enable", enable);
  assert.equal(active.extension.state, "enabled");
  assert.equal(active.extension.activeVersion, "1.0.0");
  assert.equal(f.enablement.enabled().has(name), true);
  assert.equal(f.modules.loadedPackages()[0].name, name);
  const disable = await f.prepare("extensions.disable"),
    closed = await f.apply("extensions.disable", disable);
  assert.equal(closed.extension.state, "disabled");
  assert.equal(f.enablement.enabled().has(name), false);
  assert.equal(
    existsSync(path.join(f.work, "node_modules", name, "package.json")),
    true,
  );
});
test("changed work preconditions and busy extensions reject before npm or file mutation", async (t) => {
  const f = await fixture(t);
  await f.apply("packages.install", await f.prepare("packages.install"));
  await f.apply("extensions.enable", await f.prepare("extensions.enable"));
  f.setLatest("2.0.0");
  const candidate = await f.prepare("packages.update"),
    before = readFileSync(path.join(f.work, "package.json"), "utf8"),
    lock = readFileSync(path.join(f.work, "package-lock.json"), "utf8");
  const running = await f.start(
    "return {version:await fixtureSDK.wait({})};",
    0,
  );
  await f.control.entered.promise;
  await assert.rejects(f.apply("packages.update", candidate), {
    code: "extension_busy",
  });
  assert.equal(readFileSync(path.join(f.work, "package.json"), "utf8"), before);
  f.control.gate.resolve();
  assert.equal(
    (
      await f.engine.get(f.scope.caller, {
        agentId: "agent",
        runId: running.run.runId,
        waitMs: 3000,
      })
    ).run.status,
    "succeeded",
  );
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const busy = f.extensions.withPackageChanges(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const blocked = await f.start("return {version:await fixtureSDK.echo({})};");
  assert.equal(blocked.run.status, "failed");
  assert.equal(blocked.run.error.code, "extension_busy");
  await assert.rejects(f.apply("packages.update", candidate), {
    code: "extension_busy",
  });
  assert.equal(readFileSync(path.join(f.work, "package.json"), "utf8"), before);
  assert.equal(
    readFileSync(path.join(f.work, "package-lock.json"), "utf8"),
    lock,
  );
  release.resolve();
  await busy;
  write(path.join(f.work, "package.json"), {
    ...JSON.parse(before),
    description: "changed externally",
  });
  await assert.rejects(f.apply("packages.update", candidate), {
    code: "maintenance_precondition_changed",
  });
  assert.equal(readFileSync(f.marker, "utf8"), "1.0.0\n");
});
test("native module and extension admission gates block concurrent outsiders and release after failure", async (t) => {
  const f = await fixture(t);
  await f.apply("packages.install", await f.prepare("packages.install"));
  await f.apply("extensions.enable", await f.prepare("extensions.enable"));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const active = f.modules.withPackageChanges(() =>
    f.extensions.withPackageChanges(async () => {
      entered.resolve();
      await release.promise;
      throw new AgentError("fixture_failure", "Expected owner failure.");
    }),
  );
  await entered.promise;
  assert.throws(() => f.modules.resolveImport(name), { code: "module_busy" });
  assert.match(f.modules.resolveImport("node:path"), /^node:path$/);
  await assert.rejects(async () => f.extensions.disable(name), {
    code: "extension_busy",
  });
  release.resolve();
  await assert.rejects(active, { code: "fixture_failure" });
  const resumed = await f.start("return {version:await fixtureSDK.echo({})};");
  assert.equal(resumed.run.status, "succeeded");
  assert.match(f.modules.resolveImport(name), /index\.js$/);
  await f.extensions.disable(name);
  assert.equal(f.extensions.list().length, 0);
});

test("native npm cancellation waits for the actual install-script descendant tree before releasing maintenance", async (t) => {
  const f = await fixture(t),
    candidate = await f.prepare("packages.install"),
    pidFile = path.join(f.root, "install-child.pid");
  f.env.NPM_FIXTURE_INSTALL_HOLD = pidFile;
  const pending = f.apply("packages.install", candidate);
  void pending.catch(() => {});
  const deadline = Date.now() + 5000;
  while (!existsSync(pidFile) && Date.now() < deadline) await delay(20);
  assert.equal(
    existsSync(pidFile),
    true,
    "The real install script must have spawned its descendant before cancellation.",
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  process.kill(pid, 0);
  f.controller.abort(new Error("fixture independent execution cancelled"));
  await assert.rejects(pending, { code: "maintenance_cancelled" });
  assert.equal(f.snapshots.length, 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
  );
  await f.modules.withPackageChanges(() =>
    f.extensions.withPackageChanges(async () => {}),
  );
});

test("a changed lock after native evaluation withdraws affected SDKs and requires a real restart", async (t) => {
  const f = await fixture(t);
  await f.apply("packages.install", await f.prepare("packages.install"));
  await f.apply("extensions.enable", await f.prepare("extensions.enable"));
  const same = await f.prepare("packages.update", { version: "1.0.0" });
  assert.equal(same.summary.restartMayBeRequired, false);
  const approvedBefore = f.snapshots.length;
  const unchanged = await f.apply("packages.update", same, {
    version: "1.0.0",
  });
  assert.equal(unchanged.changed, false);
  assert.equal(f.snapshots.length, approvedBefore + 1);
  assert.deepEqual(f.snapshots.at(-1).target, {
    name,
    action: "update",
    version: "1.0.0",
  });
  assert.equal(f.extensions.list().length, 1);
  assert.equal(readFileSync(f.marker, "utf8"), "1.0.0\n");
  f.setLatest("2.0.0");
  const changed = await f.prepare("packages.update");
  assert.equal(changed.summary.restartMayBeRequired, true);
  const result = await f.apply("packages.update", changed);
  assert.equal(result.restartRequired, true);
  assert.equal(result.package.installedVersion, "2.0.0");
  assert.equal(result.extension.activeVersion, null);
  assert.equal(result.extension.state, "restart_required");
  assert.equal(f.extensions.list().length, 0);
  assert.equal(f.enablement.enabled().has(name), true);
  assert.equal(result.affectedExtensions[0].state, "disabled");
  assert.throws(() => f.modules.resolveImport(name), {
    code: "module_restart_required",
  });
  assert.equal(f.modules.resolveImport("node:path"), "node:path");
  const replacement = await ModuleLoader.create(f.work, "replacement-loader", {
    builtins: () => ["node:path"],
    approvedPackages: () => f.approved,
  });
  assert.throws(() => replacement.resolveImport(name), {
    code: "module_restart_required",
  });
  const disabling = await f.prepare("extensions.disable");
  const disabled = await f.apply("extensions.disable", disabling);
  assert.equal(disabled.extension.state, "disabled");
  assert.equal(f.enablement.enabled().has(name), false);
  assert.throws(() => f.modules.resolveImport(name), {
    code: "module_restart_required",
  });
});
