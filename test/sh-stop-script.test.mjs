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
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-sh-stop-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new ScriptCatalog(root, "agent").resolve("nexum/sh.stop.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "sh", script.code);
  return {
    check,
    async run(input, stop) {
      check(input);
      const report = await execute({ input }, { stop });
      checkOutput(report);
      return report;
    }
  };
}

const receipt = (fields = {}, facts = {}) => ({
  processId: id, accepted: true, confirmed: true,
  ...fields,
  facts: {
    pid: 123, startedAt: 1, rootExited: true,
    exitCode: 0, exitSignal: null, outputComplete: true,
    treeStopped: true, closed: true, stopRequested: true,
    forceRequested: false, ...facts,
  }
});

test("sh.stop preserves the optional waiting arguments and calls the SDK exactly once", async t => {
  const f = fixture(t);
  const input = { processId: id, graceMs: 0, forceMs: 30000 };
  let calls = 0;
  const report = await f.run(input, async actual => {
    calls++;
    assert.deepEqual(actual, input);
    return receipt();
  });
  assert.equal(calls, 1);
  assert.equal(report, [
    "Process stopped.", "Process: " + id, "Process tree closed.",
    "Exit code: 0", "Output capture complete."
  ].join("\n"));
  assert.doesNotMatch(report, /"facts"|"accepted"|"confirmed"/);
  assert.doesNotThrow(() => f.check({ processId: id }));
  for (const input of [{}, { processId: "123" }, { processId: id, graceMs: -1 }, { processId: id, forceMs: 30001 }, { processId: id, pid: 123 }]) {
    assert.throws(() => f.check(input), { code: "invalid_arguments" });
  }
});

test("sh.stop distinguishes an already closed process from a newly accepted stop", async t => {
  const f = fixture(t);
  const report = await f.run({ processId: id }, async () => receipt(
    { accepted: false }, { stopRequested: false }
  ));
  assert.match(report, /^Process already closed\.\nProcess: res_a{32}\nProcess tree closed\./);
  assert.match(report, /No additional stop required/);
  assert.doesNotMatch(report, /^Process stopped\./);
  assert.doesNotMatch(report, /Stop request accepted/);
});

test("sh.stop never confuses acceptance, root exit or partial facts with confirmed closure", async t => {
  const f = fixture(t);
  for (const [fields, facts] of [
    [{ confirmed: false }, { closed: false, treeStopped: false }],
    [{ confirmed: false }, { closed: true, treeStopped: true }],
    [{ confirmed: true }, { closed: false, treeStopped: true }],
    [{ confirmed: true }, { closed: true, treeStopped: false }],
    [{ accepted: false, confirmed: false }, { closed: false, treeStopped: false, stopRequested: false }],
  ]) {
    let calls = 0;
    const report = await f.run({ processId: id }, async () => { calls++; return receipt(fields, facts); });
    assert.equal(calls, 1);
    assert.match(report, /^Stop not confirmed\.\nProcess: res_a{32}/);
    assert.ok(report.includes(fields.accepted === false ? "Stop request not accepted." : "Stop request accepted."));
    assert.match(report, /Process closure:/);
    assert.match(report, /Process tree:/);
    assert.match(report, /Inspect the original process with nexum\/sh.get.js/);
    assert.doesNotMatch(report, /^Process stopped\.|^Process already closed\.|Process tree closed\./);
  }
});

test("sh.stop confirms physical stop independently of incomplete captured output", async t => {
  const f = fixture(t);
  const report = await f.run({ processId: id }, async () => receipt({}, {
    forceRequested: true, outputComplete: false, exitCode: null, exitSignal: "SIGKILL",
  }));
  assert.match(report, /^Process stopped\./);
  assert.match(report, /Process tree closed\./);
  assert.match(report, /Exit signal: "SIGKILL"/);
  assert.match(report, /Forced stop requested/);
  assert.match(report, /Output capture incomplete/);
  assert.match(report, /Inspect the original process/);
  assert.doesNotMatch(report, /Exit code: null|Output capture complete\./);
});

test("sh.stop propagates SDK authorization and outcome failures, without retry or success", async t => {
  const f = fixture(t);
  for (const code of ["permission_denied", "process_failed", "operation_timeout"]) {
    const err = Object.assign(Error(code), { code });
    let calls = 0;
    await assert.rejects(f.run({ processId: id }, async () => { calls++; throw err; }), cause => cause === err);
    assert.equal(calls, 1);
  }
});
