import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ExtensionPackageLoader } from "../dist/extensions/package-loader.js";
import { inspectExtensionPackage } from "../dist/extensions/packages.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { AgentError } from "../dist/contracts/errors.js";
import { canonicalJson } from "../dist/contracts/json.js";

const name = "@fixture/native-extension";
const caller = { principalId: "user", clientId: "client", host: "test" };
function write(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
async function until(predicate) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(
      performance.now() < end,
      "native fixture did not reach its expected phase",
    );
    await delay(5);
  }
}
async function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-extension-loader-")),
  );
  const work = path.join(root, "work");
  const pkg = path.join(work, "node_modules", ...name.split("/"));
  const sentinel = path.join(root, "events");
  const key = `nexum-package-test:${randomUUID()}`;
  const control = { hosts: [], resources: [] };
  globalThis[Symbol.for(key)] = control;
  const manifest = {
    name,
    version: "1.0.0",
    type: "module",
    exports: {
      "./nexum": {
        types: "./extension.d.ts",
        node: { import: "./extension.js" },
        default: "./wrong.js",
      },
      "./normal": { import: "./normal.js", require: "./normal.cjs" },
    },
    nexum: {
      apiVersion: 1,
      namespace: "fixtureSDK",
      permissions: ["read"],
      docs: "./docs",
    },
  };
  write(path.join(work, "package.json"), {
    type: "module",
    dependencies: { [name]: "1.0.0" },
  });
  write(path.join(pkg, "package.json"), manifest);
  write(
    path.join(pkg, "extension.d.ts"),
    "export default function createExtension(host: unknown): unknown;\n",
  );
  write(
    path.join(pkg, "docs", "README.md"),
    "# Authored extension docs\nRead the current SDK instructions.\n",
  );
  write(path.join(pkg, "helper.js"), "export const value=1;\n");
  write(path.join(pkg, "normal.js"), 'export {value} from "./helper.js";\n');
  write(path.join(pkg, "normal.cjs"), "module.exports={value:1};\n");
  write(
    path.join(pkg, "wrong.js"),
    'throw new Error("wrong native import condition");\n',
  );
  write(
    path.join(pkg, "extension.js"),
    `
import {appendFileSync} from "node:fs";
import {value} from "./helper.js";
const control=globalThis[Symbol.for(${JSON.stringify(key)})];
const event=(value)=>appendFileSync(${JSON.stringify(sentinel)},value+"\\n");
event("evaluate");
if(control.evaluate) await control.evaluate.promise;
if(control.evaluateFailure) throw new Error("top-level evaluation rejected");
export default async function createExtension(host){
  event("factory");
  control.hosts.push(host);
  if(control.factory) await control.factory.promise;
  if(control.resource){
    const closed=Promise.withResolvers();
    (control.resourceClosures??=[]).push(closed);
    const value={closed:closed.promise,dispose(){event("resource-dispose");if(!control.resourceUnconfirmed)closed.resolve();}};
    const ref=await host.resources.register({kind:"fixture.connection",value});
    control.resources.push(ref.id);
  }
  if(control.factoryFailure) throw new Error("factory rejected after resource registration");
  return {methods:{echo:{description:"Echo input",permissions:["read"],schemaDialect:"draft7",inputSchema:control.invalidSchema?{type:"unknown-schema-type"}:{type:"object"},handle:(input)=>({input,value,endpoint:host.config.endpoint??null})}},dispose(){event("dispose");if(control.disposeFailure)throw new Error("dispose not confirmed");}};
}
`,
  );
  const approved = new Map([[name, "1.0.0"]]);
  const enabled = new Set([name]);
  const permissions = new Set(["read"]);
  const policy = { builtins: () => [], approvedPackages: () => approved };
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 30 });
  let allowed = true;
  const registry = new ExtensionRegistry(resources, {
    cleanupTimeoutMs: 30,
    permissions,
    authorize(action) {
      if (control.authorizeFailure) throw control.authorizeFailure;
      if (control.denyDisable && action.action === "disable")
        throw new AgentError("forbidden", "Stopping is currently denied.");
      if (!allowed && action.action !== "disable")
        throw new AgentError("forbidden", "Current authority was revoked.");
    },
    log() {},
    progress() {},
  });
  const modules = await ModuleLoader.create(work, store.bootId, policy);
  const loader = new ExtensionPackageLoader(registry, modules, {
    policy,
    permissions,
    enabled: () => enabled,
  });
  const scripts = new ScriptCatalog(work, "agent", () => []);
  write(path.join(work, "snapshot.json"), { project: null });
  const context = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: "work/snapshot.json",
  });
  const engine = new RunEngine(store, modules, scripts, {
    authorize() {},
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    encodeResult: async (value) => ({
      content: [],
      data: JSON.parse(canonicalJson(value)),
    }),
    bindings: (services) => registry.bindings(services),
    resources,
  });
  t.after(async () => {
    control.evaluate?.resolve();
    control.factory?.resolve();
    await delay(20);
    delete globalThis[Symbol.for(key)];
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    pkg,
    sentinel,
    control,
    manifest,
    approved,
    enabled,
    modules,
    loader,
    registry,
    store,
    events: () =>
      existsSync(sentinel)
        ? readFileSync(sentinel, "utf8").trim().split("\n")
        : [],
    saveManifest: () => write(path.join(pkg, "package.json"), manifest),
    revoke: () => {
      allowed = false;
    },
    start: (script) =>
      engine.start(caller, { contextId: context.contextId, script }),
  };
}
function count(f, value) {
  return f.events().filter((item) => item === value).length;
}
function causeCode(cause) {
  return cause?.cause?.code;
}

test("only explicitly enabled approved packages with valid static declarations are evaluated", async (t) => {
  for (const scenario of ["disabled", "unapproved", "static"]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      let code;
      if (scenario === "disabled") {
        f.enabled.clear();
        code = "extension_not_enabled";
      }
      if (scenario === "unapproved") {
        f.approved.clear();
        code = "extension_not_approved";
      }
      if (scenario === "static") {
        f.manifest.nexum.permissions = ["invented"];
        f.saveManifest();
        code = "invalid_extension_permissions";
      }
      await assert.rejects(async () => f.loader.prepare(name), { code });
      assert.deepEqual(f.events(), []);
      assert.equal(f.control.hosts.length, 0);
    });
  }
});

test("concurrent preparation constructs host before native import, initializes once and does not publish", async (t) => {
  const f = await fixture(t);
  f.control.factory = Promise.withResolvers();
  const a = f.loader.prepare(name, { endpoint: "approved" });
  const b = f.loader.prepare(name, { endpoint: "approved" });
  assert.equal(a, b);
  await until(() => count(f, "factory") === 1);
  assert.equal(count(f, "evaluate"), 1);
  assert.equal(f.control.hosts.length, 1);
  assert.equal(f.control.hosts[0].context.profile, "development");
  assert.equal(f.control.hosts[0].config.endpoint, "approved");
  assert.equal(f.control.hosts[0].context.runId, undefined);
  assert.equal(
    (await f.start("return typeof fixtureSDK;")).result.data,
    "undefined",
  );
  f.control.factory.resolve();
  const prepared = await a;
  assert.equal(prepared.handle, (await b).handle);
  assert.equal(prepared.descriptor.packageName, name);
  assert.equal(Object.isFrozen(prepared), true);
  await f.loader.verify(prepared);
  assert.equal(
    (await f.start("return typeof fixtureSDK;")).result.data,
    "undefined",
  );
  f.registry.publish(prepared.handle);
  const result = await f.start("return fixtureSDK.echo({answer:42});");
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(result.result.data, {
    input: { answer: 42 },
    value: 1,
    endpoint: "approved",
  });
  assert.equal(count(f, "factory"), 1);
});

test("same revision reuses the native cache and only creates a new instance after confirmed disable", async (t) => {
  const f = await fixture(t);
  const first = await f.loader.prepare(name);
  assert.equal((await f.loader.prepare(name)).handle, first.handle);
  assert.equal(count(f, "factory"), 1);
  assert.equal((await f.registry.disable(first.handle)).status, "disabled");
  const second = await f.loader.prepare(name);
  assert.notEqual(second.handle.id, first.handle.id);
  assert.equal(count(f, "factory"), 2);
  assert.equal(count(f, "evaluate"), 1);
  assert.equal(count(f, "dispose"), 1);
});

test("factory failure cleans registered host resources and an explicit retry reuses evaluated code", async (t) => {
  const f = await fixture(t);
  f.control.resource = true;
  f.control.factoryFailure = true;
  await assert.rejects(f.loader.prepare(name), (cause) => {
    assert.equal(cause.code, "extension_initialization_failed");
    assert.equal(cause.details.cleanup.status, "disabled");
    assert.equal(f.loader.preparationFailure(cause), null);
    return true;
  });
  assert.equal(count(f, "resource-dispose"), 1);
  assert.notEqual(f.store.getResource(f.control.resources[0]).closedAt, null);
  assert.equal(
    (await f.start("return typeof fixtureSDK;")).result.data,
    "undefined",
  );
  f.control.factoryFailure = false;
  const prepared = await f.loader.prepare(name);
  assert.equal(count(f, "evaluate"), 1);
  assert.equal(count(f, "factory"), 2);
  assert.equal((await f.registry.disable(prepared.handle)).status, "disabled");
});

test("a rejected candidate schema invokes its instance dispose and host-resource cleanup", async (t) => {
  const f = await fixture(t);
  f.control.resource = true;
  f.control.invalidSchema = true;
  await assert.rejects(f.loader.prepare(name), {
    code: "extension_initialization_failed",
  });
  assert.equal(count(f, "dispose"), 1);
  assert.equal(count(f, "resource-dispose"), 1);
  assert.notEqual(f.store.getResource(f.control.resources[0]).closedAt, null);
});

test("enable and module approval revocation during native top-level await prevent factory invocation", async (t) => {
  for (const scenario of ["enabled", "approved"]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      f.control.evaluate = Promise.withResolvers();
      const pending = f.loader.prepare(name);
      await until(() => count(f, "evaluate") === 1);
      if (scenario === "enabled") f.enabled.clear();
      else f.approved.clear();
      f.control.evaluate.resolve();
      await assert.rejects(pending, {
        code: "extension_initialization_failed",
      });
      assert.equal(count(f, "factory"), 0);
      f.enabled.add(name);
      f.approved.set(name, "1.0.0");
      await f.loader.prepare(name);
      assert.equal(count(f, "evaluate"), 1);
      assert.equal(count(f, "factory"), 1);
    });
  }
});

test("revocation after a factory returns still disposes the candidate through Registry", async (t) => {
  const f = await fixture(t);
  f.control.resource = true;
  f.control.factory = Promise.withResolvers();
  const pending = f.loader.prepare(name);
  await until(() => count(f, "factory") === 1);
  f.enabled.clear();
  f.control.factory.resolve();
  await assert.rejects(pending, (cause) => {
    assert.equal(cause.code, "extension_package_changed");
    assert.equal(causeCode(cause), "extension_not_enabled");
    assert.equal(cause.details.cleanup.status, "disabled");
    assert.equal(f.loader.preparationFailure(cause), null);
    return true;
  });
  assert.equal(count(f, "dispose"), 1);
  assert.equal(count(f, "resource-dispose"), 1);
  assert.notEqual(f.store.getResource(f.control.resources[0]).closedAt, null);
  f.enabled.add(name);
  await f.loader.prepare(name);
  assert.equal(count(f, "factory"), 2);
  assert.equal(count(f, "evaluate"), 1);
});

test("already evaluated package code, materials or version changes require restart without re-evaluation", async (t) => {
  const f = await fixture(t);
  const first = await f.loader.prepare(name);
  assert.equal((await f.registry.disable(first.handle)).status, "disabled");
  write(path.join(f.pkg, "helper.js"), "export const value=2;\n");
  await assert.rejects(f.loader.prepare(name), {
    code: "module_restart_required",
  });
  write(path.join(f.pkg, "helper.js"), "export const value=1;\n");
  appendFileSync(path.join(f.pkg, "docs", "README.md"), "Changed manual\n");
  await assert.rejects(f.loader.prepare(name), {
    code: "module_restart_required",
  });
  f.manifest.version = "2.0.0";
  f.approved.set(name, "2.0.0");
  f.saveManifest();
  await assert.rejects(f.loader.prepare(name), {
    code: "module_restart_required",
  });
  assert.equal(count(f, "evaluate"), 1);
  assert.equal(count(f, "factory"), 1);
});

test("ordinary import or require cannot supply an unknown cached package revision to extension loading", async (t) => {
  for (const mode of ["import", "require"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const code =
        mode === "import"
          ? `return (await import(${JSON.stringify(name + "/normal")})).value;`
          : `return require(${JSON.stringify(name + "/normal")}).value;`;
      assert.equal(await f.modules.execute(code, {}), 1);
      write(path.join(f.pkg, "helper.js"), "export const value=99;\n");
      await assert.rejects(f.loader.prepare(name), {
        code: "module_restart_required",
      });
      assert.equal(count(f, "evaluate"), 0);
      assert.equal(count(f, "factory"), 0);
    });
  }
});

test("failed top-level evaluation remains pinned and cannot be replaced with another revision", async (t) => {
  const f = await fixture(t);
  f.control.evaluateFailure = true;
  await assert.rejects(f.loader.prepare(name), {
    code: "extension_initialization_failed",
  });
  await assert.rejects(f.loader.prepare(name), {
    code: "extension_initialization_failed",
  });
  assert.equal(count(f, "evaluate"), 1);
  assert.equal(count(f, "factory"), 0);
  write(path.join(f.pkg, "helper.js"), "export const value=2;\n");
  await assert.rejects(f.loader.prepare(name), {
    code: "module_restart_required",
  });
  assert.equal(count(f, "evaluate"), 1);
});

test("verification rechecks current intent and policy; separate profiles do not share instances", async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  const first = await a.loader.prepare(name),
    second = await b.loader.prepare(name);
  assert.notEqual(first.handle.id, second.handle.id);
  assert.notEqual(a.control.hosts[0], b.control.hosts[0]);
  assert.equal(count(a, "evaluate"), 1);
  assert.equal(count(b, "evaluate"), 1);
  await assert.rejects(a.loader.verify(second), {
    code: "extension_unavailable",
  });
  assert.throws(
    () => new ExtensionPackageLoader(a.registry, b.modules, b.loader.options),
    { code: "extension_profile_mismatch" },
  );
  a.enabled.clear();
  await assert.rejects(a.loader.verify(first), {
    code: "extension_not_enabled",
  });
  a.enabled.add(name);
  a.approved.clear();
  await assert.rejects(a.loader.verify(first), { code: "module_not_allowed" });
  a.approved.set(name, "1.0.0");
  a.revoke();
  await assert.rejects(a.loader.prepare(name), { code: "forbidden" });
});

test("failed cleanup stays retryable before a changed source can require restart", async (t) => {
  const f = await fixture(t);
  f.control.factory = Promise.withResolvers();
  f.control.disposeFailure = true;
  const pending = f.loader.prepare(name);
  await until(() => count(f, "factory") === 1);
  f.enabled.clear();
  f.control.factory.resolve();
  let originalFailure, retryFailure;
  await assert.rejects(pending, (cause) => {
    originalFailure = cause;
    assert.equal(cause.code, "extension_package_changed");
    assert.notEqual(cause.details.cleanup.status, "disabled");
    assert.equal(
      f.loader.preparationFailure(cause).descriptor.packageName,
      name,
    );
    return true;
  });
  f.enabled.add(name);
  write(path.join(f.pkg, "helper.js"), "export const value=2;\n");
  await assert.rejects(f.loader.prepare(name), (cause) => {
    retryFailure = cause;
    assert.equal(cause.code, "extension_cleanup_pending");
    assert.equal(
      f.loader.preparationFailure(cause).handle,
      f.loader.preparationFailure(originalFailure).handle,
    );
    return true;
  });
  assert.equal(count(f, "factory"), 1);
  assert.equal(count(f, "dispose"), 2);
  f.control.disposeFailure = false;
  await assert.rejects(f.loader.prepare(name), {
    code: "module_restart_required",
  });
  assert.equal(count(f, "dispose"), 3);
  assert.equal(f.loader.preparationFailure(originalFailure), null);
  assert.equal(f.loader.preparationFailure(retryFailure), null);
  assert.equal(count(f, "factory"), 1);
  assert.equal(count(f, "evaluate"), 1);
});

test("recreating a loader for the same profile cannot forget native evaluated revision evidence", async (t) => {
  const f = await fixture(t);
  const first = await f.loader.prepare(name);
  assert.equal((await f.registry.disable(first.handle)).status, "disabled");
  write(path.join(f.pkg, "helper.js"), "export const value=2;\n");
  const freshModules = await ModuleLoader.create(
    f.work,
    "recreated_bridge",
    f.loader.options.policy,
  );
  const freshLoader = new ExtensionPackageLoader(
    f.registry,
    freshModules,
    f.loader.options,
  );
  await assert.rejects(freshLoader.prepare(name), {
    code: "module_restart_required",
  });
  assert.equal(count(f, "evaluate"), 1);
  assert.equal(count(f, "factory"), 1);
});

test("native entry must default-export the factory, while checks and compilation alone do not pin evaluation", async (t) => {
  const f = await fixture(t);
  f.modules.compile(`return import(${JSON.stringify(name + "/normal")});`, {});
  f.modules.resolveImport(name + "/nexum");
  write(
    path.join(f.pkg, "extension.js"),
    `import {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(f.sentinel)},"evaluate\\n");export default {not:"a factory"};\n`,
  );
  await assert.rejects(f.loader.prepare(name), (cause) => {
    assert.equal(cause.code, "extension_initialization_failed");
    assert.equal(causeCode(cause), "invalid_extension_export");
    return true;
  });
  assert.equal(count(f, "evaluate"), 1);
  assert.equal(count(f, "factory"), 0);
});

test("failed initialization exposes only its exact retained instance for cleanup after enable intent is revoked", async (t) => {
  const f = await fixture(t),
    other = await fixture(t);
  f.control.resource = true;
  f.control.resourceUnconfirmed = true;
  f.control.factoryFailure = true;
  let failure;
  await assert.rejects(
    f.loader.prepare(name, { endpoint: "exact-approved-config" }),
    (cause) => {
      failure = cause;
      assert.equal(cause.code, "extension_initialization_failed");
      assert.notEqual(cause.details.cleanup.status, "disabled");
      return true;
    },
  );
  const retained = f.loader.preparationFailure(failure);
  assert.equal(Object.isFrozen(retained), true);
  assert.equal(retained.descriptor.packageName, name);
  assert.deepEqual(retained.handle.origin, retained.descriptor.source.origin);
  assert.equal(other.loader.preparationFailure(failure), null);
  assert.equal(
    f.loader.preparationFailure(
      new AgentError(failure.code, failure.message, failure.details),
    ),
    null,
  );
  assert.equal(
    f.loader.preparationFailure(
      new Proxy(failure, {
        get() {
          throw new Error("must not inspect a forged error");
        },
      }),
    ),
    null,
  );
  assert.equal(f.loader.preparationFailure(null), null);
  assert.equal(
    f.loader.preparationFailure("extension_initialization_failed"),
    null,
  );
  f.enabled.clear();
  assert.equal(f.loader.preparationFailure(failure).handle, retained.handle);
  f.control.resourceUnconfirmed = false;
  f.control.resourceClosures[0].resolve();
  assert.equal((await f.registry.disable(retained.handle)).status, "disabled");
  assert.equal(f.loader.preparationFailure(failure), null);
  assert.equal(count(f, "factory"), 1);
  assert.notEqual(f.store.getResource(f.control.resources[0]).closedAt, null);
});

test("another package's namespace conflict cannot claim the active owner's cleanup handle", async (t) => {
  const f = await fixture(t);
  const owner = await f.loader.prepare(name, { endpoint: "owner" });
  f.registry.publish(owner.handle);
  const otherName = "@fixture/conflicting-extension";
  const otherRoot = path.join(f.work, "node_modules", ...otherName.split("/"));
  cpSync(f.pkg, otherRoot, { recursive: true });
  write(path.join(otherRoot, "package.json"), {
    ...f.manifest,
    name: otherName,
  });
  write(path.join(f.work, "package.json"), {
    type: "module",
    dependencies: { [name]: "1.0.0", [otherName]: "1.0.0" },
  });
  f.approved.set(otherName, "1.0.0");
  f.enabled.add(otherName);
  await assert.rejects(f.loader.prepare(otherName), (cause) => {
    assert.equal(cause.code, "namespace_conflict");
    assert.equal(f.loader.preparationFailure(cause), null);
    assert.equal(f.registry.preparationFailure(cause), null);
    return true;
  });
  await assert.rejects(
    f.loader.prepare(name, { endpoint: "different-config" }),
    (cause) => {
      assert.equal(cause.code, "namespace_conflict");
      assert.equal(f.loader.preparationFailure(cause), null);
      return true;
    },
  );
  assert.deepEqual((await f.start("return fixtureSDK.echo({});")).result.data, {
    input: {},
    value: 1,
    endpoint: "owner",
  });
  assert.equal(count(f, "factory"), 1);
  assert.equal(count(f, "dispose"), 0);
});

test("a final-verification failure keeps its exact unpublished ready handle when stop authority is denied", async (t) => {
  const f = await fixture(t);
  f.control.factory = Promise.withResolvers();
  const pending = f.loader.prepare(name);
  await until(() => count(f, "factory") === 1);
  f.enabled.clear();
  f.control.denyDisable = true;
  f.control.factory.resolve();
  let failure;
  await assert.rejects(pending, (cause) => {
    failure = cause;
    assert.equal(cause.code, "extension_package_changed");
    assert.equal(cause.details.cleanup.status, "unconfirmed");
    return true;
  });
  const retained = f.loader.preparationFailure(failure);
  assert.equal(retained.descriptor.packageName, name);
  assert.equal(
    (await f.start("return typeof fixtureSDK;")).result.data,
    "undefined",
  );
  f.control.denyDisable = false;
  assert.equal((await f.registry.disable(retained.handle)).status, "disabled");
  assert.equal(f.loader.preparationFailure(failure), null);
  assert.equal(count(f, "factory"), 1);
  assert.equal(count(f, "dispose"), 1);
});

test("an old failure rethrown by policy cannot claim the same owner's different configuration", async (t) => {
  const f = await fixture(t);
  const descriptor = await inspectExtensionPackage({
    work: f.work,
    packageName: name,
    policy: f.loader.options.policy,
    permissions: f.loader.options.permissions,
    resolveImport: (specifier) => f.modules.resolveImport(specifier),
  });
  const oldSource = {
    ...descriptor.source,
    config: { endpoint: "old-config" },
  };
  const closed = Promise.withResolvers();
  let oldFailure;
  await assert.rejects(
    f.registry.prepare(oldSource, async (host) => {
      await host.resources.register({
        kind: "fixture.connection",
        value: { closed: closed.promise, dispose() {} },
      });
      throw new Error("old initialization failed");
    }),
    (cause) => {
      oldFailure = cause;
      return true;
    },
  );
  const oldHandle = f.registry.preparationFailure(oldFailure, oldSource);
  assert.ok(oldHandle);
  f.control.authorizeFailure = oldFailure;
  await assert.rejects(
    f.loader.prepare(name, { endpoint: "new-config" }),
    (cause) => {
      assert.equal(cause, oldFailure);
      assert.equal(f.loader.preparationFailure(cause), null);
      return true;
    },
  );
  f.control.authorizeFailure = undefined;
  closed.resolve();
  assert.equal((await f.registry.disable(oldHandle)).status, "disabled");
  assert.equal(count(f, "factory"), 0);
  assert.equal(count(f, "evaluate"), 0);
});
