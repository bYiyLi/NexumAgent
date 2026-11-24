import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageChannel, Worker } from "node:worker_threads";
import { restoreExtension } from "../dist/host/extension-runtime.js";
import { ExtensionWorkers } from "../dist/host/extension-workers.js";
import { HostService } from "../dist/host/service.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { serveSyncRPC } from "../dist/host/sync-rpc.js";
import { AgentError } from "../dist/contracts/errors.js";

const name = "@fixture/restored";
const reserve = async () => ({ release() {} });

async function fixture(t, enabled) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-host-extension-")));
  const work = root;
  const pkg = path.join(work, "node_modules", ...name.split("/"));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(work, "package.json"), JSON.stringify({ type: "module", dependencies: { [name]: "1.0.0" } }));
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module",
    exports: { "./nexum": { types: "./extension.d.ts", import: "./extension.js" } },
    nexum: { apiVersion: 1, namespace: "restoredSDK", permissions: ["read"] } }));
  writeFileSync(path.join(pkg, "extension.d.ts"), "export default function createExtension(host: unknown): unknown;\n");
  writeFileSync(path.join(pkg, "extension.js"), `export default async function (host) {
    host.log({ level: "info", message: "initializing" });
    return { methods: { echo: { description: "Echo input", permissions: ["read"],
      schemaDialect: "draft7", inputSchema: { type: "object" },
      handle: async (input, call) => {
        if (input.ask) return await call.requestInput({ message: "Continue?", inputSchema: { type: "object" } });
        if (input.keep) {
          const closed = Promise.withResolvers();
          await call.resources.register({ kind: "fixture.live", value: {
            closed: closed.promise, dispose() { closed.resolve(); },
          } });
          return { created: true };
        }
        if (input.media) return new Blob(["output-bytes"], { type: "text/plain" });
        if (input.asset) return { data: await input.asset.text() };
        return input;
      } } }, dispose() {} };
  }\n`);
  const store = new FixtureStore(root, { agentId: "agent", profile: "development", cloudEnvironment: "test" });
  const policy = { builtins: () => [], approvedPackages: () => new Map([[name, "1.0.0"]]) };
  const modules = await ModuleLoader.create(work, store.bootId, policy);
  const approval = enabled ? { objectId: "extension_fixture", revision: "revision_fixture", config: {} } : undefined;
  t.after(async () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, packageName: name, modules, policy, store, reserve, approval,
    registry: { permissions: new Set(["read"]), authorize() {}, log() {}, progress() {} },
    allocateOwner: () => `instance_${"a".repeat(32)}`, releaseOwner() {} };
}

test("restores the approved npm extension and publishes its real method Skill", async (t) => {
  const runtime = await restoreExtension(await fixture(t, true));
  try {
    assert.equal(runtime.info.status, "enabled");
    assert.equal(runtime.info.methodCount, 1);
    assert.equal(runtime.published().skills.length, 1);
    assert.equal(runtime.scriptSources().length, 0);
  } finally {
    assert.equal((await runtime.close()).status, "disabled");
  }
  assert.equal(runtime.published().skills.length, 0);
});

test("refuses to restore a package without an enabled approval", async (t) => {
  await assert.rejects(restoreExtension(await fixture(t, false)), { code: "extension_not_enabled" });
});

test("host inspection reads the actual package declaration without evaluating its entry", async (t) => {
  const input = await fixture(t, false);
  const entry = path.join(input.root, "node_modules", name, "extension.js");
  writeFileSync(entry, `throw new Error("Entry must not be evaluated during inspection");
    export default () => ({ methods: {} });`);
  const service = new HostService("host-one", async (method) => {
    throw new Error(`Static inspection must not call ${method}`);
  });

  try {
    await service.configure({ instanceId: "host-one", profileRoot: input.root, profile: "development" });
    const inspected = await service.inspectExtension({ instanceId: "host-one", packageName: name,
      permissions: ["read"] }, new AbortController().signal);
    assert.equal(inspected.source.origin.owner, name);
    assert.equal(inspected.source.origin.namespace, "restoredSDK");
    assert.equal(inspected.source.origin.version, "1.0.0");
    assert.match(inspected.source.origin.revision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(inspected.entry.path, entry);
    await assert.rejects(service.inspectExtension({ instanceId: "another-host", packageName: name,
      permissions: ["read"] }, new AbortController().signal), { code: "extension_unavailable" });
  } finally {
    await service.close();
  }
});

test("disabling an absent extension confirms no Worker remains", async (t) => {
  const input = await fixture(t, false);
  const extensions = new ExtensionWorkers(input.root, input.store.binding, input.store.bootId, "host-one", async () => {
    throw new Error("No Worker should be created while disabling an absent source");
  });
  await extensions.disable(name);
  await extensions.close();
});

test("a Registry Worker restores and withdraws an approved extension through host RPC", async (t) => {
  const input = await fixture(t, true);
  const channel = new MessageChannel();
  const instanceId = `instance_${"c".repeat(32)}`;
  const seen = [];
  let ticket = 0;
  const stop = serveSyncRPC(channel.port1, async (method, params) => {
    assert.equal(params.instanceId, "host-one");
    seen.push(method);
    if (method === "resource.registerInstance") return instanceId;
    if (method === "resource.unregisterInstance") {
      assert.equal(params.sourceInstanceId, instanceId);
      return { released: true };
    }
    if (method === "storage.reserve") return `ticket_${++ticket}`;
    if (method === "storage.release" || method === "extension.authorize" || method === "extension.log") return {};
    throw new Error(`Unexpected method ${method}`);
  });
  const worker = new Worker(new URL("../dist/host/extension-worker.js", import.meta.url), {
    workerData: { root: input.root, instanceId: "host-one", preparationId: "prepare-one", bootId: input.store.bootId,
      binding: input.store.binding, packageName: name, permissions: ["read"], approval: input.approval, port: channel.port2 },
    transferList: [channel.port2],
  });
  try {
    const [ready] = await once(worker, "message");
    assert.equal(ready.type, "ready", JSON.stringify({ ready, seen }));
    assert.equal(ready.info.status, "enabled");
    assert.equal(ready.published.skills.length, 1);
    const closing = once(worker, "message");
    worker.postMessage({ type: "close" });
    const [closed] = await closing;
    assert.equal(closed.type, "closed", JSON.stringify(closed));
    assert.ok(seen.includes("resource.registerInstance"));
    assert.ok(seen.includes("resource.unregisterInstance"));
    assert.ok(seen.includes("extension.authorize"));
  } finally {
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});

test("host publishes the actual extension methods only after Go accepts them", async (t) => {
  const input = await fixture(t, true);
  const previous = process.env.NEXUM_CLOUD_BOOTSTRAP;
  process.env.NEXUM_CLOUD_BOOTSTRAP = "1";
  let published;
  let ticket = 0;
  const bytes = Buffer.from("input-bytes");
  const inputPath = path.join(input.root, "blob-input");
  const outputPath = path.join(input.root, "blob-output");
  writeFileSync(inputPath, bytes);
  const seen = [];
  let resource;
  let blobMetadata;
  const call = async (method, params) => {
    seen.push(method);
    if (method.startsWith("resource.lifetime.")) {
      assert.equal(params.runId, undefined);
      assert.equal(params.sourceInstanceId, resource.source.instanceId);
      assert.equal(params.args[0], resource.resourceId);
      method = method.replace("resource.lifetime.", "resource.");
    }
    if (method.startsWith("blob.")) assert.equal(params.methodId, published.methods[0].methodId);
    if (method === "resource.registerInstance") return `instance_${"c".repeat(32)}`;
    if (method === "resource.getRun") return { bootId: input.store.bootId, endedAt: null, stop: null, callerKey: "caller" };
    if (method === "resource.registerResource") {
      const [value] = params.args;
      resource = { resourceId: `res_${"a".repeat(32)}`, bootId: input.store.bootId,
        source: value.source, originRunId: value.runId, ownerRunId: value.runId,
        lifetime: "run", status: "registered", closedAt: null, diagnostic: {}, revision: 1 };
      return resource;
    }
    if (method === "resource.getResource") return resource;
    if (method === "resource.resourcesForRun") return resource ? [resource] : [];
    if (method === "resource.resourceDiagnostic") {
      resource = { ...resource, status: params.args[1], diagnostic: params.args[2], revision: resource.revision + 1 };
      return resource;
    }
    if (method === "resource.closeResource") {
      resource = { ...resource, status: "closed", closedAt: Date.now(), diagnostic: params.args[2], revision: resource.revision + 1 };
      return resource;
    }
    if (method === "storage.reserve") return `ticket_${++ticket}`;
    if (method === "extension.publish") {
      assert.equal(extensions.prepared(params.scope.sourceInstanceId), true);
      const described = extensions.describe(params.scope.sourceInstanceId);
      assert.deepEqual(described.methods, params.methods);
      assert.deepEqual(described.published, params.published);
      described.methods[0].operation = "forged";
      assert.equal(extensions.describe(params.scope.sourceInstanceId).methods[0].operation, "echo");
      assert.equal(extensions.published().skills.length, 0);
      published = params;
      // Simulate Go committing its authorized Directory before this RPC
      // returns. A concurrent admitted call must already reach the Worker.
      const runId = `run_${"0".repeat(32)}`;
      const duringPublish = await extensions.invoke({ sourceInstanceId: params.scope.sourceInstanceId,
        runId, methodId: params.methods[0].methodId, operationId: `operation_${"0".repeat(32)}`,
        context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
        arguments: [{ duringPublish: true }] }, new AbortController().signal);
      assert.deepEqual(duringPublish, { value: { duringPublish: true }, binaryOutputs: [] });
      return {};
    }
    if (method === "extension.requestInput") return { accepted: true };
    if (method === "blob.limits") return { inputBytes: 64 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 };
    if (method === "blob.open") return { ticket: "input", path: inputPath, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "text/plain" };
    if (method === "blob.prepare") { blobMetadata = { kind: params.kind, originalType: params.originalType }; writeFileSync(outputPath, ""); return { ticket: "output", path: outputPath }; }
    if (method === "blob.commit") return { id: "output-ref", contentType: "text/plain", ...blobMetadata };
    if (method === "blob.release") return {};
    if (["resource.unregisterInstance", "storage.release", "extension.authorize", "extension.log", "extension.withdraw"].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  };
  const extensions = new ExtensionWorkers(input.root, input.store.binding, input.store.bootId, "host-one", call);
  try {
    const result = await extensions.activate({ packageName: name, preparationId: `preparation_${"d".repeat(32)}`,
      permissions: ["read"], approval: input.approval }, new AbortController().signal);
    assert.equal(result.status, "enabled");
    assert.equal(published.methods.length, 1);
    assert.deepEqual(published.methods[0].path, ["restoredSDK", "echo"]);
    assert.equal(published.methods[0].operation, "echo");
    assert.equal(extensions.published().skills.length, 1);
    const runId = `run_${"e".repeat(32)}`;
    const resultValue = await extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"f".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ example: 42 }] }, new AbortController().signal);
    assert.deepEqual(resultValue, { value: { example: 42 }, binaryOutputs: [] });
    const answered = await extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"1".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ ask: true }] }, new AbortController().signal);
    assert.deepEqual(answered, { value: { accepted: true }, binaryOutputs: [] });
    const binaryInput = await extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"2".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ asset: null }], binaryInputs: [{ path: [0, "asset"], ref: { id: "input-ref" } }] },
    new AbortController().signal);
    assert.deepEqual(binaryInput, { value: { data: "input-bytes" }, binaryOutputs: [] });
    const binaryOutput = await extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"3".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ media: true }] }, new AbortController().signal);
    assert.deepEqual(binaryOutput, { value: null, binaryOutputs: [{ path: [], ref: { id: "output-ref", contentType: "text/plain", kind: "blob", originalType: "text/plain" } }] });
    assert.equal(readFileSync(outputPath, "utf8"), "output-bytes");
    const kept = await extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"8".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ keep: true }] }, new AbortController().signal);
    assert.deepEqual(kept, { value: { created: true }, binaryOutputs: [] });
    assert.equal(resource.closedAt, null);
    await extensions.stopRun(runId);
    assert.equal(resource.status, "closed");
    const transactionId = `package_${"4".repeat(32)}`;
    await extensions.beginPackages(transactionId);
    await assert.rejects(extensions.disable(name), { code: "extension_busy" });
    const anotherRun = `run_${"9".repeat(32)}`;
    await assert.rejects(extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId,
      runId: anotherRun, methodId: published.methods[0].methodId, operationId: `operation_${"5".repeat(32)}`,
      context: { runId: anotherRun, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{}] }, new AbortController().signal), { code: "extension_busy" });
    await extensions.finishPackages(transactionId);
    const next = `package_${"6".repeat(32)}`;
    const beginning = extensions.beginPackages(next);
    const finishing = extensions.finishPackages(next);
    await Promise.all([beginning, finishing]);
    await extensions.disable(name);
    assert.equal(extensions.published().skills.length, 0);
    assert.equal(extensions.prepared(published.scope.sourceInstanceId), false);
    assert.ok(seen.indexOf("extension.publish") < seen.indexOf("extension.withdraw"));
  } finally {
    await extensions.close();
    if (previous === undefined) delete process.env.NEXUM_CLOUD_BOOTSTRAP;
    else process.env.NEXUM_CLOUD_BOOTSTRAP = previous;
  }
});

test("a rejected Go publication withdraws and closes the actual extension", async (t) => {
  const input = await fixture(t, true);
  const previous = process.env.NEXUM_CLOUD_BOOTSTRAP;
  process.env.NEXUM_CLOUD_BOOTSTRAP = "1";
  const seen = [];
  const call = async (method) => {
    seen.push(method);
    if (method === "resource.registerInstance") return `instance_${"c".repeat(32)}`;
    if (method === "storage.reserve") return "ticket_one";
    if (method === "extension.publish") throw new AgentError("permission_denied", "not approved");
    if (["resource.unregisterInstance", "storage.release", "extension.authorize", "extension.log", "extension.withdraw"].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  };
  const extensions = new ExtensionWorkers(input.root, input.store.binding, input.store.bootId, "host-one", call);
  try {
    await assert.rejects(extensions.activate({ packageName: name, preparationId: `preparation_${"d".repeat(32)}`,
      permissions: ["read"], approval: input.approval }, new AbortController().signal), { code: "permission_denied" });
    assert.equal(extensions.published().skills.length, 0);
    assert.ok(seen.includes("extension.withdraw"));
    assert.ok(seen.includes("resource.unregisterInstance"));
  } finally {
    await extensions.close();
    if (previous === undefined) delete process.env.NEXUM_CLOUD_BOOTSTRAP;
    else process.env.NEXUM_CLOUD_BOOTSTRAP = previous;
  }
});

test("activation cancellation waits for initialization and closes the created instance", async (t) => {
  const input = await fixture(t, true);
  const previous = process.env.NEXUM_CLOUD_BOOTSTRAP;
  process.env.NEXUM_CLOUD_BOOTSTRAP = "1";
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let waited = false;
  const seen = [];
  const call = async (method) => {
    seen.push(method);
    if (method === "extension.authorize" && !waited) { waited = true; entered.resolve(); await finish.promise; }
    if (method === "resource.registerInstance") return `instance_${"c".repeat(32)}`;
    if (method === "storage.reserve") return "ticket_one";
    if (["resource.unregisterInstance", "storage.release", "extension.authorize", "extension.log", "extension.withdraw"].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  };
  const extensions = new ExtensionWorkers(input.root, input.store.binding, input.store.bootId, "host-one", call);
  const controller = new AbortController();
  try {
    let settled = false;
    const activation = extensions.activate({ packageName: name, preparationId: `preparation_${"d".repeat(32)}`,
      permissions: ["read"], approval: input.approval }, controller.signal).finally(() => { settled = true; });
    void activation.catch(() => {});
    await entered.promise;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    finish.resolve();
    await assert.rejects(activation);
    assert.ok(seen.includes("resource.unregisterInstance"));
    assert.equal(seen.includes("extension.publish"), false);
  } finally {
    finish.resolve();
    await extensions.close();
    if (previous === undefined) delete process.env.NEXUM_CLOUD_BOOTSTRAP;
    else process.env.NEXUM_CLOUD_BOOTSTRAP = previous;
  }
});

test("cancelling an extension input waits for the host callback to finish", async (t) => {
  const input = await fixture(t, true);
  const previous = process.env.NEXUM_CLOUD_BOOTSTRAP;
  process.env.NEXUM_CLOUD_BOOTSTRAP = "1";
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let published;
  const call = async (method, params, signal) => {
    if (method === "resource.registerInstance") return `instance_${"c".repeat(32)}`;
    if (method === "resource.getRun") return { bootId: input.store.bootId, endedAt: null, stop: null, callerKey: "caller" };
    if (method === "storage.reserve") return "ticket_one";
    if (method === "extension.publish") { published = params; return {}; }
    if (method === "extension.requestInput") {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await finish.promise;
      return { accepted: true };
    }
    if (["resource.unregisterInstance", "storage.release", "extension.authorize", "extension.log", "extension.withdraw"].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  };
  const extensions = new ExtensionWorkers(input.root, input.store.binding, input.store.bootId, "host-one", call);
  const controller = new AbortController();
  try {
    await extensions.activate({ packageName: name, preparationId: `preparation_${"d".repeat(32)}`,
      permissions: ["read"], approval: input.approval }, new AbortController().signal);
    const runId = `run_${"e".repeat(32)}`;
    let settled = false;
    const operation = extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId, runId,
      methodId: published.methods[0].methodId, operationId: `operation_${"f".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ ask: true }] }, controller.signal).finally(() => { settled = true; });
    void operation.catch(() => {});
    await entered.promise;
    await assert.rejects(extensions.beginPackages(`package_${"7".repeat(32)}`), { code: "extension_busy" });
    controller.abort();
    await aborted.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    finish.resolve();
    await assert.rejects(operation);
  } finally {
    finish.resolve();
    await extensions.close();
    if (previous === undefined) delete process.env.NEXUM_CLOUD_BOOTSTRAP;
    else process.env.NEXUM_CLOUD_BOOTSTRAP = previous;
  }
});

test("HostService routes a prepared extension and its real invocation", async (t) => {
  const input = await fixture(t, true);
  const previous = process.env.NEXUM_CLOUD_BOOTSTRAP;
  process.env.NEXUM_CLOUD_BOOTSTRAP = "1";
  let published;
  let service;
  const call = async (method, params) => {
    if (method === "resource.registerInstance") return `instance_${"c".repeat(32)}`;
    if (method === "resource.getRun") return { bootId: input.store.bootId, endedAt: null, stop: null, callerKey: "caller" };
    if (method === "resource.resourcesForRun") return [];
    if (method === "storage.reserve") return "ticket_one";
    if (method === "extension.publish") {
      assert.deepEqual(service.extensionPrepared({ instanceId: "host-one", sourceInstanceId: params.scope.sourceInstanceId }),
        { prepared: true });
      published = params;
      return {};
    }
    if (["resource.unregisterInstance", "storage.release", "extension.authorize", "extension.log", "extension.withdraw"].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  };
  service = new HostService("host-one", call);
  try {
    await service.configure({ instanceId: "host-one", profileRoot: input.root, profile: "development",
      binding: { ...input.store.binding, cloudEnvironment: "development" }, bootId: input.store.bootId });
    await service.activateExtension({ instanceId: "host-one", packageName: name,
      preparationId: `preparation_${"d".repeat(32)}`, permissions: ["read"], approval: input.approval }, new AbortController().signal);
    const runId = `run_${"e".repeat(32)}`;
    const result = await service.invokeExtension({ instanceId: "host-one", sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"f".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ example: 42 }] }, new AbortController().signal);
    assert.deepEqual(result, { value: { example: 42 }, binaryOutputs: [] });
    const transactionId = `package_${"9".repeat(32)}`;
    await service.beginPackages({ instanceId: "host-one", transactionId });
    await assert.rejects(service.invokeExtension({ instanceId: "host-one", sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"a".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{}] }, new AbortController().signal), { code: "extension_busy" });
    await assert.rejects(service.disableExtension({ instanceId: "host-one", packageName: name }), { code: "extension_busy" });
    await service.finishPackages({ instanceId: "host-one", transactionId });
    const invalidLock = path.join(input.root, "pnpm-lock.yaml");
    mkdirSync(invalidLock);
    await assert.rejects(service.beginPackages({ instanceId: "host-one", transactionId: `package_${"b".repeat(32)}` }));
    rmSync(invalidLock, { recursive: true });
    const afterFailure = await service.invokeExtension({ instanceId: "host-one", sourceInstanceId: published.scope.sourceInstanceId,
      runId, methodId: published.methods[0].methodId, operationId: `operation_${"c".repeat(32)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ after: true }] }, new AbortController().signal);
    assert.deepEqual(afterFailure, { value: { after: true }, binaryOutputs: [] });
    assert.deepEqual(service.extensionRunStatus({ instanceId: "host-one", runId }), { status: "unknown" });
    const stop = service.stopExtensionRun({ instanceId: "host-one", runId });
    assert.deepEqual(service.extensionRunStatus({ instanceId: "host-one", runId }), { status: "running" });
    assert.deepEqual(await stop, { stopped: true });
    assert.deepEqual(service.extensionRunStatus({ instanceId: "host-one", runId }), { status: "stopped" });
    assert.deepEqual(await service.disableExtension({ instanceId: "host-one", packageName: name }), { disabled: true });
    const missingRun = `run_${"0".repeat(32)}`;
    await assert.rejects(service.stopExtensionRun({ instanceId: "host-one", runId: missingRun }),
      { code: "resource_cleanup_unconfirmed" });
    assert.deepEqual(service.extensionRunStatus({ instanceId: "host-one", runId: missingRun }), { status: "failed" });
  } finally {
    await service.close();
    if (previous === undefined) delete process.env.NEXUM_CLOUD_BOOTSTRAP;
    else process.env.NEXUM_CLOUD_BOOTSTRAP = previous;
  }
});

test("stopping one Run waits for its callbacks without stopping another Run", async (t) => {
  const input = await fixture(t, true);
  const previous = process.env.NEXUM_CLOUD_BOOTSTRAP;
  process.env.NEXUM_CLOUD_BOOTSTRAP = "1";
  const first = `run_${"1".repeat(32)}`;
  const second = `run_${"2".repeat(32)}`;
  const entered = new Map([[first, Promise.withResolvers()], [second, Promise.withResolvers()]]);
  const finished = new Map([[first, Promise.withResolvers()], [second, Promise.withResolvers()]]);
  const stopped = Promise.withResolvers();
  let secondAborted = false;
  let published;
  const call = async (method, params, signal) => {
    if (method === "resource.registerInstance") return `instance_${"c".repeat(32)}`;
    if (method === "resource.getRun") return { bootId: input.store.bootId, endedAt: null, stop: null, callerKey: "caller" };
    if (method === "resource.resourcesForRun") return [];
    if (method === "storage.reserve") return "ticket_one";
    if (method === "extension.publish") { published = params; return {}; }
    if (method === "extension.requestInput") {
      const run = params.runId;
      signal.addEventListener("abort", () => { if (run === first) stopped.resolve(); else secondAborted = true; }, { once: true });
      entered.get(run).resolve();
      await finished.get(run).promise;
      return { accepted: true };
    }
    if (["resource.unregisterInstance", "storage.release", "extension.authorize", "extension.log", "extension.withdraw"].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  };
  const extensions = new ExtensionWorkers(input.root, input.store.binding, input.store.bootId, "host-one", call);
  try {
    await extensions.activate({ packageName: name, preparationId: `preparation_${"d".repeat(32)}`,
      permissions: ["read"], approval: input.approval }, new AbortController().signal);
    const invoke = (runId) => extensions.invoke({ sourceInstanceId: published.scope.sourceInstanceId, runId,
      methodId: published.methods[0].methodId, operationId: `operation_${runId.slice(4)}`,
      context: { runId, pwd: input.root }, deadlineAt: Date.now() + 10_000,
      arguments: [{ ask: true }] }, new AbortController().signal);
    const firstCall = invoke(first);
    const secondCall = invoke(second);
    void firstCall.catch(() => {});
    await Promise.all([...entered.values()].map((value) => value.promise));
    const cleanup = extensions.stopRun(first);
    assert.strictEqual(extensions.stopRun(first), cleanup);
    assert.equal(extensions.runStatus(first), "running");
    await stopped.promise;
    assert.equal(secondAborted, false);
    finished.get(first).resolve();
    await assert.rejects(firstCall);
    await cleanup;
    assert.equal(extensions.runStatus(first), "stopped");
    await extensions.stopRun(first);
    assert.equal(secondAborted, false);
    finished.get(second).resolve();
    assert.deepEqual(await secondCall, { value: { accepted: true }, binaryOutputs: [] });
    await extensions.stopRun(second);
  } finally {
    for (const value of finished.values()) value.resolve();
    await extensions.close();
    if (previous === undefined) delete process.env.NEXUM_CLOUD_BOOTSTRAP;
    else process.env.NEXUM_CLOUD_BOOTSTRAP = previous;
  }
});

test("Run cleanup status remains failed when no Worker can confirm cleanup", async (t) => {
  const input = await fixture(t, true);
  const extensions = new ExtensionWorkers(input.root, input.store.binding, input.store.bootId, "host-one", async () => ({}));
  const runId = `run_${"a".repeat(32)}`;
  assert.equal(extensions.runStatus(runId), "unknown");
  const first = extensions.stopRun(runId);
  assert.strictEqual(first, extensions.stopRun(runId));
  await assert.rejects(first, { code: "resource_cleanup_unconfirmed" });
  assert.equal(extensions.runStatus(runId), "failed");
  await assert.rejects(extensions.stopRun(runId), { code: "resource_cleanup_unconfirmed" });
  await extensions.close();
});
