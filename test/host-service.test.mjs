import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { HostService } from "../dist/host/service.js";
import { Peer } from "../dist/host/peer.js";
import { AgentError } from "../dist/contracts/errors.js";

async function fixture(t, call) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-service-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = root;
  await mkdir(path.join(work, "modules"), { recursive: true });
  await writeFile(path.join(work, "package.json"), '{"private":true,"type":"module"}');
  const service = new HostService("host_1", call);
  t.after(() => service.close());
  assert.deepEqual(await service.configure({
    instanceId: "host_1", profileRoot: root, profile: "development",
  }), { configured: true, executionReady: false, resultEncoding: "stored-v1" });
  return service;
}

test("host RPC services execute a real Worker and deliver scoped SDK calls and logs", async (t) => {
  const calls = [];
  const service = await fixture(t, async (method, params) => {
    calls.push({ method, params });
    return method === "sdk.call" ? { value: { count: 3 }, binaryOutputs: [] } : null;
  });
  const result = await service.execute({
    instanceId: "host_1", runId: "run_1", context: { runId: "run_1" },
    methods: [{ methodId: "tool_1", path: ["github", "tool_list"] }],
    code: 'console.log("counting"); return await github.tool_list({ repo: "demo" });',
  }, new AbortController().signal);
  assert.deepEqual(result, { version: 1, storedResult: { content: [], data: { count: 3 } } });
  assert.ok(calls.some((call) => call.method === "run.log" &&
    call.params.runId === "run_1" && call.params.text.includes("counting")));
  assert.ok(calls.some((call) => call.method === "sdk.call" &&
    call.params.instanceId === "host_1" && call.params.runId === "run_1" &&
    call.params.methodId === "tool_1" && call.params.arguments[0].repo === "demo"));
  await assert.rejects(service.execute({
    instanceId: "host_2", runId: "run_2", context: {}, methods: [], code: "return 1",
  }, new AbortController().signal), { code: "invalid_run_scope" });
});

test("host cancellation waits for the active Worker to finish", async (t) => {
  const called = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const service = await fixture(t, async (method) => {
    if (method === "sdk.call") {
      called.resolve();
      return await pending.promise;
    }
    return null;
  });
  const execution = service.execute({
    instanceId: "host_1", runId: "run_2", context: { runId: "run_2" },
    methods: [{ methodId: "tool_1", path: ["github", "tool_wait"] }],
    code: "await github.tool_wait({}); return 1;",
  }, new AbortController().signal);
  const failure = assert.rejects(execution, { code: "run_cancelled" });
  await called.promise;
  assert.deepEqual(service.cancel({ instanceId: "host_1", runId: "run_2" }), { accepted: true });
  pending.resolve({ value: null, binaryOutputs: [] });
  await failure;
  assert.deepEqual(service.cancel({ instanceId: "host_1", runId: "run_2" }), { accepted: false });
});

test("a host closed during configuration cannot accept later Runs", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-close-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  const service = new HostService("host_1", async () => null);
  const configuring = service.configure({ instanceId: "host_1", profileRoot: root, profile: "development" });
  await service.close();
  await assert.rejects(configuring, { code: "host_closing" });
  await assert.rejects(service.execute({
    instanceId: "host_1", runId: "run_1", context: { runId: "run_1" }, methods: [], code: "return 1;",
  }, new AbortController().signal), { code: "invalid_run_scope" });
});

test("extension RPC requires the Go-authenticated host binding and valid preparation", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-binding-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  const service = new HostService("host_1", async () => null);
  t.after(() => service.close());
  await service.configure({ instanceId: "host_1", profileRoot: root, profile: "development",
    binding: { agentId: "agent_1", profile: "development", cloudEnvironment: "development" },
    bootId: "boot_1" });
  assert.deepEqual(service.extensionPrepared({ instanceId: "host_1", sourceInstanceId: "missing" }),
    { prepared: false });
  assert.throws(() => service.extensionPrepared({ instanceId: "old_host", sourceInstanceId: "missing" }),
    { code: "extension_unavailable" });
  await assert.rejects(service.activateExtension({ instanceId: "host_1", packageName: "fixture",
    preparationId: "not_approved", permissions: [], approval: { objectId: "extension_fixture", revision: "revision_fixture", config: {} } }, new AbortController().signal),
  { code: "invalid_extension_activation" });
});

test("a successful script reports a failed Run when Go cannot persist its log", async (t) => {
  const service = await fixture(t, async (method) => {
    if (method === "run.log") throw new Error("private failure");
    return null;
  });
  await assert.rejects(service.execute({
    instanceId: "host_1", runId: "run_log_failure", context: { runId: "run_log_failure" },
    methods: [], code: 'console.log("record this"); return 1;',
  }, new AbortController().signal), { code: "run_log_failed" });
});

test("package finish waits for a concurrent begin before releasing its gate", async (t) => {
  const service = await fixture(t, async () => null);
  const id = `package_${"1".repeat(32)}`;
  const begin = service.beginPackages({ instanceId: "host_1", transactionId: id });
  const finish = service.finishPackages({ instanceId: "host_1", transactionId: id });
  assert.deepEqual(await begin, { transactionId: id });
  assert.deepEqual(await finish, { restartRequired: false });
  const next = await service.beginPackages({ instanceId: "host_1" });
  assert.deepEqual(await service.finishPackages({ instanceId: "host_1", transactionId: next.transactionId }),
    { restartRequired: false });
});

test("request cancellation keeps already accepted log delivery open until acknowledgement", async (t) => {
  const sdkEntered = Promise.withResolvers();
  const logEntered = Promise.withResolvers();
  const logRelease = Promise.withResolvers();
  let logSignal;
  const service = await fixture(t, async (method, _params, signal) => {
    if (method === "run.log") {
      logSignal = signal;
      logEntered.resolve();
      await logRelease.promise;
      return null;
    }
    if (method === "sdk.call") {
      sdkEntered.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("operation stopped");
    }
    return null;
  });
  const controller = new AbortController();
  const execution = service.execute({
    instanceId: "host_1", runId: "run_log_cancel", context: { runId: "run_log_cancel" },
    methods: [{ methodId: "tool_wait", path: ["demo", "tool_wait"] }],
    code: 'console.log("accepted log"); await demo.tool_wait({});',
  }, controller.signal);
  const failed = assert.rejects(execution);
  await Promise.all([sdkEntered.promise, logEntered.promise]);
  controller.abort();
  assert.equal(logSignal.aborted, false);
  logRelease.resolve();
  await failed;
});

test("stdio RPC runs a Worker, handles reverse SDK calls and routes cancellation", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-rpc-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  const child = spawn(process.execPath, ["--experimental-vm-modules",
    fileURLToPath(new URL("../dist/host/main.js", import.meta.url))],
  { stdio: ["pipe", "pipe", "pipe"] });
  const logs = [];
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  const accepted = Promise.withResolvers();
  const releaseAccepted = Promise.withResolvers();
  const peer = new Peer(child.stdout, child.stdin, async (method, params) => {
    if (method === "run.accepted") {
      if (params.runId === "run_3") {
        accepted.resolve();
        await releaseAccepted.promise;
      }
      return null;
    }
    if (method === "sdk.call") {
      if (params.methodId === "tool_denied")
        throw new AgentError("permission_denied", "The current authorization denied this operation.");
      if (params.methodId === "tool_wait") {
        waiting.resolve();
        await release.promise;
        return { value: null, binaryOutputs: [] };
      }
      return { value: { observed: params.arguments[0] }, binaryOutputs: [] };
    }
    if (method === "run.log") { logs.push(params.text); return null; }
    throw new Error("unexpected request");
  });
  peer.start();
  try {
    const handshake = await peer.call("host.initialize", { protocolVersion: 1, instanceId: "host_1" });
    assert.equal(handshake.executionReady, false);
    assert.deepEqual(await peer.call("host.configure", {
      instanceId: "host_1", profileRoot: root, profile: "development",
    }), { configured: true, executionReady: false, resultEncoding: "stored-v1" });
    await assert.rejects(peer.call("work.prepare", { instanceId: "host_1" }),
      { code: "invalid_work_scope" });
    const change = await peer.call("packages.begin", { instanceId: "host_1" });
    assert.equal(typeof change.transactionId, "string");
    await assert.rejects(peer.call("run.execute", {
      instanceId: "host_1", runId: "run_busy", context: { runId: "run_busy" },
      methods: [], code: "return 1;",
    }), { code: "module_busy" });
    assert.deepEqual(await peer.call("packages.finish", {
      instanceId: "host_1", transactionId: change.transactionId,
    }), { restartRequired: false });
    const value = await peer.call("run.execute", {
      instanceId: "host_1", runId: "run_1", context: { runId: "run_1" },
      methods: [{ methodId: "tool_1", path: ["demo", "tool_call"] }],
      code: 'console.log("rpc log"); return await demo.tool_call({ value: 4 });',
    });
    assert.deepEqual(value, { version: 1, storedResult: { content: [], data: { observed: { value: 4 } } } });
    assert.ok(logs.some((line) => line.includes("rpc log")));
    const denied = await peer.call("run.execute", {
      instanceId: "host_1", runId: "run_denied", context: { runId: "run_denied" },
      methods: [{ methodId: "tool_denied", path: ["demo", "tool_denied"] }],
      code: 'try { await demo.tool_denied({}); } catch (error) { return {code: error.code}; }',
    });
    assert.deepEqual(denied, { version: 1, storedResult: { content: [], data: { code: "permission_denied" } } });
    assert.deepEqual(await peer.call("run.cancel", { instanceId: "host_1", runId: "run_1" }), { accepted: false });
    const running = peer.call("run.execute", {
      instanceId: "host_1", runId: "run_2", context: { runId: "run_2" },
      methods: [{ methodId: "tool_wait", path: ["demo", "tool_wait"] }],
      code: "await demo.tool_wait({}); return 1;",
    });
    const failure = assert.rejects(running, { code: "run_cancelled" });
    await waiting.promise;
    assert.deepEqual(await peer.call("run.cancel", { instanceId: "host_1", runId: "run_2" }), { accepted: true });
    release.resolve();
    await failure;
    const beforeStart = peer.call("run.execute", {
      instanceId: "host_1", runId: "run_3", context: { runId: "run_3" },
      methods: [], code: 'console.log("must not start"); return 3;',
    });
    const beforeStartFailure = assert.rejects(beforeStart, { code: "run_cancelled" });
    await accepted.promise;
    assert.deepEqual(await peer.call("run.cancel", { instanceId: "host_1", runId: "run_3" }), { accepted: true });
    releaseAccepted.resolve();
    await beforeStartFailure;
    assert.ok(logs.every((line) => !line.includes("must not start")));
  } finally {
    peer.close();
    child.stdin.end();
    await once(child, "exit");
  }
});

test("disconnect closes the host after initialization has already completed", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-disconnect-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  const child = spawn(process.execPath, ["--experimental-vm-modules",
    fileURLToPath(new URL("../dist/host/main.js", import.meta.url))],
  { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const accepted = Promise.withResolvers();
  const peer = new Peer(child.stdout, child.stdin, async (method) => {
    if (method === "run.accepted") accepted.resolve();
    return null;
  });
  peer.start();
  await peer.call("host.initialize", { protocolVersion: 1, instanceId: "host_1" });
  await peer.call("host.configure", { instanceId: "host_1", profileRoot: root, profile: "development" });
  const running = peer.call("run.execute", { instanceId: "host_1", runId: "run_1",
    context: { runId: "run_1" }, methods: [], code: "while (true) {}" });
  const failure = assert.rejects(running);
  await accepted.promise;
  const exited = once(child, "exit");
  peer.close();
  child.stdin.end();
  await failure;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
  } finally { clearTimeout(timeout); }
});

test("request cancellation waits for the Go SDK and accepted log to settle", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nexum-host-rpc-cancel-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  const child = spawn(process.execPath, ["--experimental-vm-modules",
    fileURLToPath(new URL("../dist/host/main.js", import.meta.url))],
  { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const sdkReady = Promise.withResolvers();
  const sdkCancelled = Promise.withResolvers();
  const sdkRelease = Promise.withResolvers();
  const logReady = Promise.withResolvers();
  const logRelease = Promise.withResolvers();
  const peer = new Peer(child.stdout, child.stdin, async (method, _params, signal) => {
    if (method === "run.accepted") return null;
    if (method === "run.log") { logReady.resolve(); await logRelease.promise; return null; }
    if (method === "sdk.call") {
      sdkReady.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      sdkCancelled.resolve();
      await sdkRelease.promise;
      return { value: null, binaryOutputs: [] };
    }
    throw new Error("unexpected request");
  });
  peer.start();
  try {
    await peer.call("host.initialize", { protocolVersion: 1, instanceId: "host_1" });
    await peer.call("host.configure", { instanceId: "host_1", profileRoot: root, profile: "development" });
    const controller = new AbortController();
    const running = peer.call("run.execute", { instanceId: "host_1", runId: "run_1",
      context: { runId: "run_1" }, methods: [{ methodId: "tool_wait", path: ["demo", "tool_wait"] }],
      code: 'console.log("accepted log"); await demo.tool_wait({});' }, controller.signal);
    let settled = false;
    const result = running.then(() => { settled = true; }, () => { settled = true; });
    await Promise.all([sdkReady.promise, logReady.promise]);
    controller.abort();
    await sdkCancelled.promise;
    assert.equal(settled, false);
    sdkRelease.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    logRelease.resolve();
    await result;
    assert.equal(settled, true);
  } finally {
    sdkRelease.resolve();
    logRelease.resolve();
    const exited = once(child, "exit");
    peer.close();
    child.stdin.end();
    await exited;
  }
});
