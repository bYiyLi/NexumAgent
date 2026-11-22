import assert from "node:assert/strict";
import { finished } from "node:stream/promises";
import test from "node:test";
import { HostRunLog } from "../dist/host/run-log.js";

test("log delivery preserves UTF-8 and bounds individual RPC frames", async () => {
  const chunks = [];
  const log = new HostRunLog(async (text) => chunks.push(text));
  const text = "a".repeat(1024 * 1024 - 1) + "🍎" + "b".repeat(1024 * 1024);
  log.write(text);
  log.end();
  await finished(log);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 1024 * 1024 + 3));
  assert.equal(log.failure, undefined);
});

test("pending console bytes are bounded until the Go writer acknowledges them", async () => {
  const first = Promise.withResolvers();
  let sends = 0;
  const log = new HostRunLog(async () => {
    if (sends++ === 0) await first.promise;
  });
  log.write(Buffer.alloc(64 * 1024 * 1024, 0x61));
  log.write("overflow");
  assert.equal(log.failure?.code, "run_log_failed");
  log.end();
  first.resolve();
  await finished(log);
  assert.equal(sends, 64);
});

test("Go log failure is retained while the stream drains", async () => {
  const log = new HostRunLog(async () => { throw new Error("private diagnostic"); });
  log.write("message");
  log.end();
  await finished(log);
  assert.equal(log.failure?.code, "run_log_failed");
  assert.equal(log.failure?.message, "The Run log could not be delivered.");
});
