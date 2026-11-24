import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { MaterialRetention } from "../dist/runtime/material-retention.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { ExecutionFixture, callerKey } from "./helpers/runtime-fixture.mjs";
import { restoreManagedShell } from "../dist/host/sh-runtime.js";
import { ExtensionWorkers } from "../dist/host/extension-workers.js";

test("managed shell publishes the real methods and executes with its retained resource", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-host-sh-")));
  const work = root;
  mkdirSync(work, { recursive: true });
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "test" };
  const store = new FixtureStore(root, binding);
  const reserve = async () => ({ release() {} });
  const retention = new MaterialRetention(root, { reserve, liveSnapshotRefs: () => new Set() });
  const permissions = new Set(["path", "resource", "sh.execute", "sh.read", "sh.control", "storage.reserve"]);
  let allocated = false;
  const policies = [];
  const shell = await restoreManagedShell({ root, store, reserve, retention,
    allocateOwner(origin) {
      assert.equal(origin.namespace, "sh");
      allocated = true;
      return `instance_${"a".repeat(32)}`;
    },
    releaseOwner() { allocated = false; },
    registry: { permissions, storage: { reserve }, authorize(policy) { policies.push(policy); }, log() {}, progress() {} },
  });
  let closed = false;
  let cleanupBackground;
  t.after(async () => {
    await cleanupBackground?.();
    if (!closed) await shell.close();
    await retention.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(shell.close(), { code: "publication_unconfirmed" });
  const skill = shell.published().skills[0];
  assert.match(readFileSync(skill.skillFile, "utf8"), /sh\["exec"\]/);
  assert.match(readFileSync(path.join(skill.path, "references", "calling.md"), "utf8"), /sh\.exec/);
  assert.ok(shell.methods.some((method) => method.operation === "exec" && method.path.join(".") === "sh.exec"));
  shell.confirmPublished();

  const caller = { principalId: "user", clientId: "client", host: "test" };
  const context = store.openWork({ callerKey: callerKey(caller), pwd: work, snapshotRef: "snapshot.json" });
  const loader = await ModuleLoader.create(work, store.bootId, { builtins: () => [], approvedPackages: () => new Map() });
  const engine = new ExecutionFixture(store, loader, new ScriptCatalog(work, "agent"), {
    authorize() {}, loadWork: () => ({}), resources: shell.resources,
    bindings: (services) => shell.registry.bindings(services),
    encodeResult: async (value) => ({ content: [], data: value }),
  });
  let result = await engine.start(caller, { contextId: context.contextId,
    script: "return await sh.exec(context.input)",
    input: { command: process.execPath, args: ["-e", "process.stdout.write('shell-ok')"] }, waitMs: 3000 });
  const runId = result.run.runId;
  while (result.run.endedAt === null) result = await engine.observe(caller, runId, 1000);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.result.data.exitCode, 0);
  assert.ok(result.result.data.output.some((chunk) => chunk.data === "shell-ok"));
  assert.ok(policies.some((policy) => policy.action === "invoke" && policy.method === "exec"));
  assert.equal(store.resourcesForRun(runId).length, 1);

  async function execute(script, input) {
    let observed = await engine.start(caller, { contextId: context.contextId, script, input, waitMs: 3000 });
    while (observed.run.endedAt === null) observed = await engine.observe(caller, observed.run.runId, 1000);
    assert.equal(observed.run.status, "succeeded", JSON.stringify(observed.run.error));
    return observed.result.data;
  }
  const background = await execute("return await sh.start(context.input)", {
    command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], background: true,
  });
  cleanupBackground = async () => {
    await execute("return await sh.stop({processId: context.input})", background.processId);
  };
  assert.equal(background.lifetime, "background");
  await assert.rejects(shell.close(), { code: "extension_busy" });
  const observed = await execute("return await sh.get({processId: context.input})", background.processId);
  assert.equal(observed.processId, background.processId);
  assert.equal(observed.controlAvailable, true);
  const stopped = await execute("return await sh.stop({processId: context.input})", background.processId);
  assert.equal(stopped.confirmed, true);
  cleanupBackground = undefined;
  assert.equal((await shell.close()).status, "disabled");
  closed = true;
  assert.equal(allocated, false);
});

test("shell preparation failure disposes its Go-issued source instance", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-host-sh-failed-")));
  mkdirSync(root, { recursive: true });
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "test" });
  const reserve = async () => ({ release() {} });
  const retention = new MaterialRetention(root, { reserve, liveSnapshotRefs: () => new Set() });
  t.after(async () => { await retention.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  let allocated = 0;
  let released = 0;
  await assert.rejects(restoreManagedShell({ root, store, reserve, retention,
    allocateOwner() { allocated++; return `instance_${"a".repeat(32)}`; },
    releaseOwner() { released++; },
    registry: {
      permissions: new Set(["path", "resource", "sh.execute", "sh.read", "sh.control", "storage.reserve"]),
      storage: { reserve },
      authorize(policy) { if (policy.action === "publish") throw new Error("publication denied"); },
      log() {}, progress() {},
    },
  }));
  assert.equal(allocated, 1);
  assert.equal(released, 1);
});

test("platform shell Worker publishes through Go before executing a managed process", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-host-sh-worker-")));
  const work = root;
  mkdirSync(work, { recursive: true });
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "development" });
  const context = store.openWork({ callerKey: "caller", pwd: work, snapshotRef: "snapshot.json" });
  let run = store.acceptRun({ callerKey: "caller", contextId: context.contextId,
    sourceKind: "inline", source: { codeSource: "inline" } }).run;
  run = store.transitionRun(run.runId, run.revision, "preparing_inputs");
  run = store.transitionRun(run.runId, run.revision, "running");
  const source = `instance_${"a".repeat(32)}`;
  const host = `host_${"b".repeat(32)}`;
  const preparation = `preparation_${"c".repeat(32)}`;
  const previous = process.env.NEXUM_CLOUD_BOOTSTRAP;
  process.env.NEXUM_CLOUD_BOOTSTRAP = "1";
  let proposal;
  let reserved = 0;
  let releases = 0;
  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === "resource.registerInstance") {
      assert.equal(params.preparationId, preparation);
      assert.equal(params.origin.type, "platform");
      assert.equal(params.origin.namespace, "sh");
      return source;
    }
    if (method === "resource.unregisterInstance" || method === "extension.authorize" ||
      method === "extension.log" || method === "extension.progress") return {};
    if (method === "storage.reserve") return `ticket_${++reserved}`;
    if (method === "storage.release") { releases++; return {}; }
    if (method === "materials.liveSnapshotRefs") return [];
    if (method.startsWith("resource.")) {
      assert.equal(params.sourceInstanceId, source);
      const name = method.slice("resource.".length);
      return store[name](...params.args);
    }
    if (method === "platform.publish") {
      assert.equal(workers.prepared(source), true);
      assert.equal(workers.published().skills.length, 0);
      proposal = params;
      return { published: true };
    }
    if (method === "platform.withdraw") return { withdrawn: true };
    throw new Error(`Unexpected method ${method}`);
  };
  const workers = new ExtensionWorkers(root, store.binding, store.bootId, host, call);
  t.after(async () => {
    await workers.close();
    store.close();
    if (previous === undefined) delete process.env.NEXUM_CLOUD_BOOTSTRAP;
    else process.env.NEXUM_CLOUD_BOOTSTRAP = previous;
    rmSync(root, { recursive: true, force: true });
  });
  await workers.activatePlatform({ preparationId: preparation,
    permissions: ["path", "resource", "sh.execute", "sh.read", "sh.control", "storage.reserve"] },
  new AbortController().signal);
  assert.equal(workers.published().skills.length, 1);
  const exec = proposal.methods.find((method) => method.operation === "exec");
  const result = await workers.invoke({ sourceInstanceId: source, runId: run.runId,
    methodId: exec.methodId, operationId: `operation_${"d".repeat(32)}`,
    deadlineAt: Date.now() + 20_000, context: { runId: run.runId, pwd: work },
    arguments: [{ command: process.execPath, args: ["-e", "process.stdout.write('worker-ok')"] }],
  }, new AbortController().signal);
  assert.equal(result.value.exitCode, 0);
  assert.ok(result.value.output.some((chunk) => chunk.data === "worker-ok"));
  await workers.stopRun(run.runId);
  await workers.disable("platform:sh");
  assert.ok(methods.indexOf("platform.publish") < methods.indexOf("platform.withdraw"));
  assert.equal(reserved, releases);
});
