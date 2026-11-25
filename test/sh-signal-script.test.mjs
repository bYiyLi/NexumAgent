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
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-sh-signal-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(root, "agent");
  const script = catalog.resolve("nexum/sh.signal.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "sh", script.code);
  return {
    catalog, script, check,
    async run(input, signal) {
      check(input);
      const report = await execute({ input }, { signal });
      checkOutput(report);
      return report;
    }
  };
}

test("sh.signal forwards the exact process identity and signal once, preserving the actual mechanism", async t => {
  const f = fixture(t);
  for (const [signal, mechanism] of [
    ["SIGTERM", "process-group"], ["SIGKILL", "job-object"], ["SIGINT", "terminal-input"]
  ]) {
    const input = { processId: id, signal };
    let calls = 0;
    const report = await f.run(input, async actual => {
      calls++;
      assert.deepEqual(actual, input);
      return { processId: id, requested: signal, delivered: true, mechanism };
    });
    assert.equal(calls, 1);
    assert.equal(report, [
      "Signal delivered: " + signal, "Process: " + id, "Mechanism: " + mechanism,
      "Delivery does not confirm signal handling or process exit."
    ].join("\n"));
    assert.doesNotMatch(report, /Process stopped|Process tree closed|"delivered"/);
  }
});

test("sh.signal retains non-delivery as a distinct receipt without implying closure or sending another signal", async t => {
  const f = fixture(t);
  let calls = 0;
  const report = await f.run({ processId: id, signal: "SIGINT" }, async () => {
    calls++;
    return { processId: id, requested: "SIGINT", delivered: false, mechanism: "process-group" };
  });
  assert.equal(calls, 1);
  assert.equal(report, [
    "Signal not delivered: SIGINT", "Process: " + id, "Mechanism: process-group",
    "Check the original process with nexum/sh.get.js before deciding on further action."
  ].join("\n"));
  assert.doesNotMatch(report, /Process stopped|Process tree closed|Signal delivered:/);
});

test("sh.signal retains the input schema without pretending to validate the remote platform signal set", t => {
  const f = fixture(t);
  for (const input of [
    {}, { processId: id }, { signal: "SIGINT" }, { processId: "123", signal: "SIGINT" },
    { processId: id, signal: "sigint" }, { processId: id, signal: 9 }, { processId: id, signal: "" },
    { processId: id, signal: "SIG" + "A".repeat(30) },
    { processId: id, signal: "SIGINT", force: true }
  ]) assert.throws(() => f.check(input), { code: "invalid_arguments" });
  // Host/SDK owns the platform-specific signal validation.
  for (const signal of ["SIGINT", "SIGKILL", "SIGTERM", "SIGUSR2", "SIGNOTREAL"]) {
    assert.doesNotThrow(() => f.check({ processId: id, signal }));
  }
});

test("sh.signal propagates unsupported, denied, missing-target and unknown-outcome errors unchanged", async t => {
  const f = fixture(t);
  for (const code of ["process_signal_unsupported", "unsupported_process_signal", "permission_denied", "process_closed", "operation_timeout"]) {
    let calls = 0;
    const err = Object.assign(Error(code), { code });
    await assert.rejects(f.run({ processId: id, signal: "SIGTERM" }, async actual => {
      calls++;
      assert.equal(actual.signal, "SIGTERM");
      throw err;
    }), cause => cause === err);
    assert.equal(calls, 1);
  }
});

test("sh.signal's actual public catalog description retains the cross-platform invocation and recovery contract", t => {
  const f = fixture(t);
  const entry = f.catalog.discover().entries.find(entry => entry.scriptName === "nexum/sh.signal.js");
  assert.ok(entry);
  assert.equal(entry.scriptDesc, f.script.metadata.scriptDesc);
  for (const phrase of ["{processId,signal}", "不使用 OS PID", "普通 Run 满载", "macOS/Linux", "Windows 仅支持 SIGKILL", "PTY 的 SIGINT",
    "不替换信号", "Signal delivered/not delivered", "不证明程序已处理信号或进程已退出", "nexum/sh.get.js",
    "先查原 Run", "不盲目重投", "nexum/sh.stop.js"]) {
    assert.ok(entry.scriptDesc.includes(phrase), "missing decision-critical instruction: " + phrase);
  }
  assert.equal(f.script.metadata.scriptOutputSchema.type, "string");
  assert.equal(f.script.metadata.scriptOpenDefault, false);
});
