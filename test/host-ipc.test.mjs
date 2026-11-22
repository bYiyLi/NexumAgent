import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Peer } from "../dist/host/peer.js";

test("host IPC supports bidirectional nested calls", async () => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new Peer(bToA, aToB, async (method) => {
    assert.equal(method, "callback");
    return { value: 17 };
  });
  const b = new Peer(aToB, bToA, async (method) => {
    assert.equal(method, "nested");
    return await b.call("callback", {});
  });
  a.start();
  b.start();
  try {
    assert.deepEqual(await a.call("nested", {}), { value: 17 });
  } finally {
    a.close();
    b.close();
  }
});

test("host IPC rejects pending calls when its stream closes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new Peer(input, output, async () => null);
  peer.start();
  const call = peer.call("pending", {});
  input.end();
  await assert.rejects(call, /agent IPC closed/);
  output.destroy();
});

test("managed host handshake reports actual readiness", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { fileURLToPath } = await import("node:url");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/host/main.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  const peer = new Peer(child.stdout, child.stdin, async () => null);
  peer.start();
  try {
    assert.deepEqual(await peer.call("host.initialize", { protocolVersion: 1, instanceId: "test-instance" }), {
      protocolVersion: 1, instanceId: "test-instance", transportReady: true, executionReady: false,
      resultEncoding: "stored-v1", nodeVersion: process.version,
    });
  } finally {
    peer.close();
    child.stdin.end();
    await once(child, "exit");
  }
});

test("host IPC closes the active handler scope on disconnect", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let stopped;
  const closed = new Promise((resolve) => { stopped = resolve; });
  const peer = new Peer(input, output, async (_method, _params, signal) => {
    started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    stopped();
    return null;
  });
  peer.start();
  input.write('{"jsonrpc":"2.0","id":"1","method":"wait"}\n');
  await ready;
  input.end();
  await closed;
  output.destroy();
});

test("host IPC cancellation waits for remote handler cleanup", async () => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  let acknowledge;
  const cancelled = new Promise((resolve) => { acknowledge = resolve; });
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const a = new Peer(bToA, aToB, () => null);
  const b = new Peer(aToB, bToA, async (_method, _params, signal) => {
    start();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    acknowledge();
    await cleanup;
    return { settled: true };
  });
  a.start(); b.start();
  const abort = new AbortController();
  const pending = a.call("operation", {}, abort.signal);
  let finished = false;
  void pending.catch(() => {}).finally(() => { finished = true; });
  await started;
  abort.abort(new Error("cancelled"));
  await cancelled;
  assert.equal(finished, false);
  release();
  await assert.rejects(pending, /cancelled/);
  a.close(); b.close();
});
