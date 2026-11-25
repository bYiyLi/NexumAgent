import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-transfer-list-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(root, "agent");
  const script = catalog.resolve("nexum/transfer.list.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "transfer", script.code);
  return {
    catalog, script, check,
    async run(input, list) {
      check(input);
      const report = await execute({ input }, { list });
      checkOutput(report);
      return report;
    }
  };
}
const record = (transferId, fields = {}) => ({
  transferId, direction: "upload", status: "pending", runId: null,
  contextId: "ctx_example", projectId: null, maxBytes: 104857600,
  progress: { bytesTransferred: 0, totalBytes: null },
  createdAt: "2026-11-25T00:00:00.000Z", expiresAt: null,
  startedAt: null, deadlineAt: null, finishedAt: null, error: null, ...fields,
});

test("transfer.list forwards existing filters and the opaque cursor in one SDK call", async t => {
  const f = fixture(t);
  const input = { direction: "upload", status: "pending", runId: "run_example", limit: 1, cursor: "previous.cursor" };
  let calls = 0;
  const report = await f.run(input, async actual => {
    calls++;
    assert.deepEqual(actual, input);
    return { transfers: [record("tr_example", { runId: "run_example", path: "/project/upload.bin" })], nextCursor: "opaque.next==" };
  });
  assert.equal(calls, 1);
  assert.match(report, /tr_example · upload · pending · 0 B transferred \(total unknown\)/);
  assert.match(report, /Path: \/project\/upload.bin · Run: run_example/);
  assert.match(report, /Next cursor: "opaque.next=="/);
  assert.match(report, /Continue with the same filters and cursor/);
  assert.doesNotMatch(report, /"transfers"|"contextId"|"maxBytes"|"expiresAt"/);
});

test("transfer.list groups each actual lifecycle state without treating byte progress as success", async t => {
  const f = fixture(t);
  const statuses = ["succeeded", "preparing", "pending", "transferring", "cancelling", "failed", "cancelled", "expired", "interrupted"];
  const rows = statuses.map(status => record("tr_" + status, {
    status,
    progress: { bytesTransferred: 100, totalBytes: 100 },
    ...(status === "succeeded" ? { file: { path: "/project/complete.bin", name: "complete.bin" } } : {}),
    ...(status === "interrupted" ? { error: { code: "transfer_interrupted", message: "private diagnosis", details: { token: "private-token" } } } : {})
  }));
  const report = await f.run({}, async () => ({ transfers: rows, nextCursor: null }));
  const [active, succeeded, terminal] = report.split(/\n\n(?=## )/);
  assert.match(active, /^## Active/);
  for (const state of ["preparing", "pending", "transferring", "cancelling"]) {
    assert.match(active, new RegExp("tr_" + state + " · upload · " + state + " · 100 B / 100 B \\(100%\\)"));
  }
  assert.match(succeeded, /^## Succeeded/);
  assert.match(succeeded, /tr_succeeded/);
  assert.match(succeeded, /Path: \/project\/complete.bin/);
  for (const state of ["failed", "cancelled", "expired", "interrupted"]) {
    assert.match(terminal, new RegExp("tr_" + state + " · upload · " + state));
  }
  assert.match(terminal, /Error: transfer_interrupted/);
  assert.doesNotMatch(report, /private diagnosis|private-token|Next cursor/);
  for (const row of rows) assert.equal(report.split(row.transferId).length, 2);
});

test("transfer.list displays known, unknown, empty and inconsistent totals without fabricated progress", async t => {
  const f = fixture(t);
  const rows = [
    record("tr_known", { status: "transferring", direction: "download", resource: { name: "fixed.bin", uri: "nexum://resource", size: 104857600 }, progress: { bytesTransferred: 68157440, totalBytes: 104857600 } }),
    record("tr_unknown", { progress: { bytesTransferred: 1024, totalBytes: null }, maxBytes: 2048 }),
    record("tr_empty", { status: "succeeded", progress: { bytesTransferred: 0, totalBytes: 0 } }),
    record("tr_over", { progress: { bytesTransferred: 3, totalBytes: 2 } }),
    record("tr_near", { progress: { bytesTransferred: 9999, totalBytes: 10000 } }),
  ];
  const report = await f.run({}, async () => ({ transfers: rows, nextCursor: null }));
  assert.match(report, /tr_known · download · transferring · 65 MiB \/ 100 MiB \(65%\)/);
  assert.match(report, /File: fixed.bin/);
  assert.match(report, /tr_unknown · upload · pending · 1 KiB transferred \(total unknown\)/);
  assert.match(report, /tr_empty · upload · succeeded · 0 B \/ 0 B(?:\n|$)/);
  assert.match(report, /tr_over · upload · pending · 3 B \/ 2 B \(exceeds reported total\)/);
  assert.match(report, /tr_near[^\n]*\(99%\)/);
  assert.doesNotMatch(report, /NaN|Infinity|nexum:\/\/resource/);
});

test("transfer.list preserves empty continuation pages and propagates actual SDK failures", async t => {
  const f = fixture(t);
  assert.equal(await f.run({}, async () => ({ transfers: [], nextCursor: null })), "No transfers on this page.");
  assert.equal(await f.run({}, async () => ({ transfers: [], nextCursor: "continue" })),
    'No transfers on this page.\nNext cursor: "continue"\nContinue with the same filters and cursor.');
  for (const code of ["permission_denied", "invalid_cursor", "transfer_page_too_large"]) {
    const error = Object.assign(Error(code), { code });
    let calls = 0;
    await assert.rejects(f.run({}, async () => { calls++; throw error; }), cause => cause === error);
    assert.equal(calls, 1);
  }
});

test("transfer.list renders all 100 returned records and contains untrusted display labels inside their lines", async t => {
  const f = fixture(t);
  const rows = Array.from({ length: 100 }, (_, i) => record("tr_" + String(i).padStart(3, "0"), {
    path: i === 0 ? "/project/one\n## Succeeded\u202e" : "/project/" + i
  }));
  const report = await f.run({ limit: 100 }, async () => ({ transfers: rows, nextCursor: "next" }));
  assert.equal(report.match(/^    tr_\d{3} · /gm)?.length, 100);
  assert.match(report, /100 transfers returned/);
  assert.match(report, /Next cursor: "next"/);
  assert.ok(report.includes('Path: "/project/one\\n## Succeeded\\u202e"'));
  assert.doesNotMatch(report, /\n## Succeeded/);
  for (const row of rows) assert.equal(report.split(row.transferId).length, 2);
});

test("transfer.list retains the input contract and model-visible invocation guidance", t => {
  const f = fixture(t);
  assert.doesNotThrow(() => f.check({}));
  assert.doesNotThrow(() => f.check({ direction: "download", status: "interrupted", runId: "run_example", limit: 100, cursor: "opaque" }));
  for (const input of [{ direction: "both" }, { status: "done" }, { limit: 0 }, { limit: 101 }, { cursor: "" }, { runId: "" }, { transferId: "tr_1" }]) {
    assert.throws(() => f.check(input), { code: "invalid_arguments" });
  }
  const entry = f.catalog.discover().entries.find(entry => entry.scriptName === "nexum/transfer.list.js");
  assert.ok(entry);
  assert.equal(entry.scriptDesc, f.script.metadata.scriptDesc);
  for (const phrase of ["{direction?,status?,runId?,limit?,cursor?}", "默认20", "当前授权可见", "100% 不代表成功",
    "仅以 succeeded 确认传输成功", "不代表用户已保存文件", "即使本页为空", "保持原筛选", "nexum/transfer.get.js", "nexum/transfer.cancel.js"]) {
    assert.ok(entry.scriptDesc.includes(phrase), "missing decision-critical instruction: " + phrase);
  }
  assert.equal(f.script.metadata.scriptOutputSchema.type, "string");
});
