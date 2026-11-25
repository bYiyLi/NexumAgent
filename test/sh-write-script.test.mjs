import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const id = "res_" + "a".repeat(32);

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-sh-write-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new ScriptCatalog(root, "agent").resolve("nexum/sh.write.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "sh", script.code);
  return {
    check,
    async run(input, write) {
      check(input);
      const report = await execute({ input }, { write });
      checkOutput(report);
      return report;
    }
  };
}

test("sh.write forwards the exact input once and uses the SDK byte count without echoing data", async t => {
  const f = fixture(t);
  const input = { processId: id, data: " confidential 中文\r\n末尾  " };
  let calls = 0;
  const report = await f.run(input, async actual => {
    calls++;
    assert.deepEqual(actual, input);
    return { processId: id, accepted: true, bytes: Buffer.byteLength(actual.data), eof: false };
  });
  assert.equal(calls, 1);
  assert.equal(report, "Input accepted.\nProcess: " + id + "\nBytes written: " + Buffer.byteLength(input.data));
  assert.doesNotMatch(report, /confidential|中文|末尾|Stdin closed|business.*complete/i);
});

test("sh.write reports zero-byte input, EOF-only and write-and-close using the actual receipt", async t => {
  const f = fixture(t);
  for (const input of [
    { processId: id, data: "" },
    { processId: id, eof: true },
    { processId: id, data: "末尾", eof: true }
  ]) {
    let calls = 0;
    const report = await f.run(input, async actual => {
      calls++;
      assert.deepEqual(actual, input);
      return { processId: id, accepted: true, bytes: Buffer.byteLength(actual.data ?? ""), eof: actual.eof === true };
    });
    assert.equal(calls, 1);
    assert.equal(report, "Input accepted.\nProcess: " + id +
      "\nBytes written: " + Buffer.byteLength(input.data ?? "") + (input.eof ? "\nStdin closed." : ""));
  }
});

test("sh.write retains the existing optional input schema and rejects malformed requests", t => {
  const f = fixture(t);
  for (const input of [{}, { processId: id }, { processId: id, eof: false }, { processId: "123", data: "x" },
    { processId: id, data: [1, 2] }, { processId: id, data: "x", eof: "true" },
    { processId: id, data: "x", newline: true }]) {
    assert.throws(() => f.check(input), { code: "invalid_arguments" });
  }
  // The existing shared control-data budget rejects oversized JSON before
  // script-specific Schema validation; preserve that original error code.
  assert.throws(() => f.check({ processId: id, data: "x".repeat(1048577) }), { code: "data_too_large" });
  for (const input of [{ processId: id, data: "" }, { processId: id, data: "y\n", eof: false }, { processId: id, eof: true }]) {
    assert.doesNotThrow(() => f.check(input));
  }
});

test("sh.write propagates original SDK errors without retrying, reading logs or fabricating acceptance", async t => {
  const f = fixture(t);
  for (const code of ["permission_denied", "process_input_closed", "process_tty_eof_unsupported", "operation_timeout"]) {
    const err = Object.assign(Error(code), { code });
    let calls = 0;
    await assert.rejects(f.run({ processId: id, data: "y\n", eof: true }, async () => { calls++; throw err; }),
      cause => cause === err);
    assert.equal(calls, 1);
  }
});
