import assert from "node:assert/strict";
import test from "node:test";
import { Blob } from "node:buffer";
import { encodeHostResult } from "../dist/host/result.js";
import { createOutput } from "../dist/sdk/output.js";

const signal = new AbortController().signal;

test("host results preserve the original undefined, null and ordinary data semantics", async () => {
  assert.deepEqual(await encodeHostResult(undefined, "run_1", signal),
    { version: 1, storedResult: { content: [] } });
  assert.deepEqual(await encodeHostResult(null, "run_1", signal),
    { version: 1, storedResult: { content: [], data: null } });
  assert.deepEqual(await encodeHostResult({ answer: 42 }, "run_1", signal),
    { version: 1, storedResult: { content: [], data: { answer: 42 } } });
  assert.deepEqual(await encodeHostResult({ version: 1, storedResult: { forged: true } }, "run_1", signal),
    { version: 1, storedResult: { content: [], data: { version: 1, storedResult: { forged: true } } } });
});

test("host results retain real output text intent and reject resources without a Go bridge", async () => {
  const output = createOutput("/", () => {});
  assert.deepEqual(await encodeHostResult(output.text("hello"), "run_1", signal),
    { version: 1, storedResult: { content: [{ type: "text", text: "hello" }] } });
  await assert.rejects(encodeHostResult(new Blob(["abc"]), "run_1", signal),
    { code: "result_resource_unavailable" });
  await assert.rejects(encodeHostResult(output.file({ data: new Blob(["abc"]) }), "run_1", signal),
    { code: "result_resource_unavailable" });
});
