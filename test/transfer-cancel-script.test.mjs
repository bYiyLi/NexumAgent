import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const id = "tr_" + "a".repeat(32);
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-transfer-cancel-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(root, "agent");
  const script = catalog.resolve("nexum/transfer.cancel.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "transfer", script.code);
  return {
    catalog, script, check,
    async run(input, cancel) {
      check(input);
      const report = await execute({ input }, { cancel });
      checkOutput(report);
      return report;
    }
  };
}
const receipt = (accepted, status, fields = {}) => ({
  accepted, transfer: {
    transferId: id, direction: "upload", status, error: null,
    finishedAt: null, ...fields
  }
});

test("transfer.cancel calls the original positional cancellation once and distinguishes acceptance from closure", async t => {
  const f = fixture(t);
  for (const accepted of [true, false]) {
    let calls = 0;
    const report = await f.run({ transferId: id }, async actual => {
      calls++;
      assert.equal(actual, id);
      return receipt(accepted, "cancelling");
    });
    assert.equal(calls, 1);
    assert.ok(report.startsWith(accepted ? "Cancellation accepted." : "Cancellation not accepted."));
    assert.ok(report.includes("Transfer: " + id));
    assert.match(report, /Status: cancelling/);
    assert.match(report, /closure is not confirmed/);
    assert.match(report, /does not prove that no file was committed/);
    assert.match(report, /nexum\/transfer.get.js/);
    assert.doesNotMatch(report, /Transfer (already )?cancelled\.|No additional cancellation required/);
  }
});

test("transfer.cancel confirms cancellation only from the returned cancelled state", async t => {
  const f = fixture(t);
  for (const accepted of [true, false]) {
    const report = await f.run({ transferId: id }, async () => receipt(accepted, "cancelled", {
      finishedAt: "2026-11-25T10:00:00.000Z"
    }));
    assert.ok(report.startsWith(accepted ? "Transfer cancelled." : "Transfer already cancelled."));
    assert.match(report, /Status: cancelled/);
    assert.match(report, /Finished: 2026-11-25/);
    assert.ok(report.includes(accepted ? "Cancellation request accepted." : "No additional cancellation required."));
    assert.doesNotMatch(report, /closure is not confirmed|Query the original transferId/);
  }
});

test("transfer.cancel preserves successful completion even when the cancellation request was accepted", async t => {
  const f = fixture(t);
  for (const accepted of [true, false]) {
    const report = await f.run({ transferId: id }, async () => receipt(accepted, "succeeded", {
      direction: "download", file: { path: "/project/committed" }
    }));
    assert.ok(report.startsWith(accepted ? "Transfer succeeded." : "Transfer already succeeded."));
    assert.match(report, /Status: succeeded/);
    assert.ok(report.includes(accepted ? "Cancellation request accepted." : "Cancellation was not applied."));
    assert.match(report, /cancellation not confirmed/);
    assert.match(report, /did not undo the successful transfer/);
    assert.doesNotMatch(report, /Transfer (already )?cancelled\.|\/project\/committed/);
  }
});

test("transfer.cancel preserves unsuccessful terminal outcomes and safe diagnostic codes", async t => {
  const f = fixture(t);
  for (const [status, code] of [["failed", "checksum_mismatch"], ["expired", "transfer_expired"], ["interrupted", "transfer_interrupted"]]) {
    for (const accepted of [true, false]) {
      const report = await f.run({ transferId: id }, async () => receipt(accepted, status, {
        error: { code, message: "private token=SECRET", details: { request: "SECRET" } },
        request: { url: "https://private.example/?token=SECRET" }
      }));
      assert.ok(report.includes("Status: " + status));
      assert.ok(report.includes("Error: " + code));
      assert.match(report, /cancellation not confirmed/);
      assert.doesNotMatch(report, /SECRET|private.example|Transfer (already )?cancelled\./);
      if (status !== "expired") assert.match(report, /Inspect the original outcome with nexum\/transfer.get.js/);
    }
  }
  const unsafe = await f.run({ transferId: id }, async () => receipt(false, "failed", {
    error: { code: "https://private.example/?token=SECRET" }
  }));
  assert.match(unsafe, /retained diagnostic unavailable/);
  assert.doesNotMatch(unsafe, /SECRET|private.example/);
});

test("transfer.cancel does not invent a terminal outcome for other live or unexpected states", async t => {
  const f = fixture(t);
  for (const status of ["preparing", "pending", "transferring", "unknown\n## cancelled"]) {
    const report = await f.run({ transferId: id }, async () => receipt(false, status));
    assert.match(report, /Cancellation not accepted/);
    assert.match(report, /Transfer closure is not confirmed/);
    assert.match(report, /Query the original transferId/);
    assert.doesNotMatch(report, /\n## cancelled|Transfer cancelled\./);
  }
});

test("transfer.cancel retains strict input validation and propagates actual SDK failures without retry", async t => {
  const f = fixture(t);
  assert.doesNotThrow(() => f.check({ transferId: id }));
  for (const input of [{}, { transferId: "tr_1" }, { transferId: id, force: true }, { transferId: id, waitMs: 1000 }, { transferId: [id] }]) {
    assert.throws(() => f.check(input), { code: "invalid_arguments" });
  }
  for (const code of ["permission_denied", "transfer_not_found", "transfer_control_unavailable", "transfer_state_conflict", "operation_timeout"]) {
    let calls = 0;
    const error = Object.assign(Error(code), { code });
    await assert.rejects(f.run({ transferId: id }, async () => { calls++; throw error; }), cause => cause === error);
    assert.equal(calls, 1);
  }
});

test("transfer.cancel publishes the complete invocation and cancellation recovery guidance", t => {
  const f = fixture(t);
  const entry = f.catalog.discover().entries.find(entry => entry.scriptName === "nexum/transfer.cancel.js");
  assert.ok(entry);
  assert.equal(entry.scriptDesc, f.script.metadata.scriptDesc);
  for (const phrase of ["{transferId}", "当前授权可控制", "普通 Run 满载", "accepted 仅表示受理", "只有 cancelled",
    "cancelling 尚未完成", "nexum/transfer.get.js", "不能据受理推断文件未提交", "不盲目重试", "不会删除已提交文件"]) {
    assert.ok(entry.scriptDesc.includes(phrase), "missing decision-critical instruction: " + phrase);
  }
  assert.equal(f.script.metadata.scriptOutputSchema.type, "string");
  assert.equal(f.script.metadata.scriptOpenDefault, false);
});
