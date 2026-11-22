import assert from "node:assert/strict";
import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import { test } from "node:test";
import { AgentError } from "../dist/contracts/errors.js";
import { serveSyncRPC } from "../dist/host/sync-rpc.js";

function startWorker(port, method, timeout = 1000) {
  const url = new URL("../dist/host/sync-rpc.js", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { callHostSync } = await import(workerData.url);
      try {
        const value = callHostSync(workerData.port, workerData.method, { value: 7 }, workerData.timeout);
        parentPort.postMessage({ value });
      } catch (error) {
        parentPort.postMessage({ code: error.code, message: error.message, details: error.details });
      }
    })();
  `, { eval: true, workerData: { port, method, timeout, url }, transferList: [port] });
  return worker;
}

test("a Worker waits while the host services asynchronous RPC", async () => {
  const channel = new MessageChannel();
  const stop = serveSyncRPC(channel.port1, async (method, params) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { method, params };
  });
  const worker = startWorker(channel.port2, "resource.get");
  try {
    const [result] = await once(worker, "message");
    assert.deepEqual(result, { value: { method: "resource.get", params: { value: 7 } } });
  } finally {
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});

test("authority failures propagate after the current host check", async () => {
  const channel = new MessageChannel();
  let allowed = true;
  const stop = serveSyncRPC(channel.port1, async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (!allowed) throw new AgentError("CAPABILITY_NOT_ALLOWED", "no", { reason: "outside" });
    return true;
  });
  const worker = startWorker(channel.port2, "resource.get");
  setTimeout(() => { allowed = false; }, 5);
  try {
    const [result] = await once(worker, "message");
    assert.deepEqual(result, { code: "CAPABILITY_NOT_ALLOWED", message: "no", details: { reason: "outside" } });
  } finally {
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});

test("a timeout aborts the in-flight host operation", async () => {
  const channel = new MessageChannel();
  const observed = Promise.withResolvers();
  const stop = serveSyncRPC(channel.port1, async (_method, _params, signal) => {
    signal.addEventListener("abort", () => observed.resolve(), { once: true });
    await once(signal, "abort");
    throw new Error("aborted");
  });
  const worker = startWorker(channel.port2, "resource.get", 25);
  try {
    const [result] = await once(worker, "message");
    assert.equal(result.code, "host_rpc_timeout");
    await observed.promise;
  } finally {
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});

test("stopping the host wakes a waiting Worker and cancels its operation", async () => {
  const channel = new MessageChannel();
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const stop = serveSyncRPC(channel.port1, async (_method, _params, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await once(signal, "abort");
    throw new Error("aborted");
  });
  const worker = startWorker(channel.port2, "resource.get");
  try {
    await entered.promise;
    const message = once(worker, "message");
    stop();
    await aborted.promise;
    const [result] = await message;
    assert.equal(result.code, "host_rpc_closed");
  } finally {
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});

test("terminating a waiting Worker aborts its outstanding host operation", async () => {
  const channel = new MessageChannel();
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const stop = serveSyncRPC(channel.port1, async (_method, _params, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await once(signal, "abort");
    throw new Error("aborted");
  });
  const worker = startWorker(channel.port2, "resource.get");
  try {
    await entered.promise;
    await worker.terminate();
    await Promise.race([
      aborted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("host operation leaked")), 1000)),
    ]);
  } finally {
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});

test("the existing ResourceManager uses the Go store port for its complete instance lifecycle", async () => {
  const channel = new MessageChannel();
  const root = "/tmp";
  const binding = { agentId: "agent", profile: "development", cloudEnvironment: "test" };
  const bootId = `boot_${"a".repeat(32)}`;
  const source = { type: "extension", owner: "@test/example", namespace: "example", version: "1", revision: "one" };
  let row;
  const seen = [];
  const sourceInstanceId = `instance_${"c".repeat(32)}`;
  const stop = serveSyncRPC(channel.port1, async (method, params) => {
    assert.equal(params.instanceId, "host-instance");
    seen.push(method);
    if (method === "resource.registerInstance") {
      assert.deepEqual(params.origin, source);
      return sourceInstanceId;
    }
    assert.equal(params.sourceInstanceId, sourceInstanceId);
    if (method === "resource.unregisterInstance") return null;
    if (method === "resource.registerResource") {
      const [input] = params.args;
      row = { resourceId: `res_${"b".repeat(32)}`, bootId, source: input.source,
        lifetime: "instance", status: "registered", closedAt: null, diagnostic: {}, revision: 1 };
      return row;
    }
    if (method === "resource.getResource") return row;
    if (method === "resource.resourceDiagnostic") {
      row = { ...row, status: params.args[1], diagnostic: params.args[2], revision: row.revision + 1 };
      return row;
    }
    if (method === "resource.closeResource") {
      row = { ...row, status: "closed", closedAt: Date.now(), diagnostic: params.args[2], revision: row.revision + 1 };
      return row;
    }
    throw new Error(`Unexpected resource method ${method}`);
  });
  const storeUrl = new URL("../dist/host/registry-store.js", import.meta.url).href;
  const managerUrl = new URL("../dist/extensions/resources.js", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { registryStore, registryOwner } = await import(workerData.storeUrl);
      const { ResourceManager } = await import(workerData.managerUrl);
      const owner = registryOwner(workerData.port, "host-instance");
      const store = registryStore(workerData.port, workerData.root, workerData.binding,
        workerData.bootId, owner.scope);
      const manager = new ResourceManager(store, {
        allocateOwner: owner.allocateOwner, releaseOwner: owner.releaseOwner,
      });
      const signal = new AbortController();
      const instance = manager.instance(workerData.source, { signal: signal.signal,
        authorize() {}, assertActive() {} });
      const closed = Promise.withResolvers();
      const ref = await instance.resources.register({ kind: "connection",
        value: { closed: closed.promise, dispose() { closed.resolve(); } } });
      ref.report({ state: "ready" });
      const result = await instance.stop();
      parentPort.postMessage({ result });
    })().catch((error) => parentPort.postMessage({ failure: String(error.stack) }));
  `, { eval: true, workerData: { port: channel.port2, root, binding, bootId, source, storeUrl, managerUrl },
    transferList: [channel.port2] });
  try {
    const [result] = await once(worker, "message");
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.result, { closed: 1, unconfirmed: [] });
    assert.equal(row.status, "closed");
    assert.deepEqual(row.diagnostic.details, { state: "ready" });
    assert.ok(seen.includes("resource.registerResource"));
    assert.ok(seen.includes("resource.closeResource"));
    assert.ok(seen.includes("resource.unregisterInstance"));
  } finally {
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});

test("an asynchronous cancellation waits for the host operation to settle", async () => {
  const channel = new MessageChannel();
  const entered = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const stop = serveSyncRPC(channel.port1, async (_method, _params, signal) => {
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    entered.resolve();
    await finish.promise;
    return { committed: true };
  });
  const url = new URL("../dist/host/sync-rpc.js", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { HostAsyncRPC } = await import(workerData.url);
      const client = new HostAsyncRPC(workerData.port);
      const controller = new AbortController();
      parentPort.on("message", () => controller.abort());
      try { await client.call("extension.requestInput", {}, controller.signal); parentPort.postMessage("success"); }
      catch { parentPort.postMessage("cancelled"); }
    })();
  `, { eval: true, workerData: { port: channel.port2, url }, transferList: [channel.port2] });
  try {
    await entered.promise;
    let settled = false;
    const message = once(worker, "message").then(([value]) => { settled = true; return value; });
    worker.postMessage("cancel");
    await cancelled.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    finish.resolve();
    assert.equal(await message, "cancelled");
  } finally {
    finish.resolve();
    stop();
    channel.port1.close();
    await worker.terminate();
  }
});
