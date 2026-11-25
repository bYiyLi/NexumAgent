import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const id = "tr_" + "a".repeat(32);
const hash = "c".repeat(64);
const time = "2026-11-25T10:00:00.000Z";
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-transfer-get-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(root, "agent");
  const script = catalog.resolve("nexum/transfer.get.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "transfer", script.code);
  return {
    catalog, script, check,
    async run(input, get) {
      check(input);
      const report = await execute({ input }, { get });
      checkOutput(report);
      return report;
    }
  };
}
const snapshot = (fields = {}) => ({
  transferId: id, direction: "upload", status: "pending", runId: "run_original",
  contextId: "ctx_example", projectId: null, maxBytes: 104857600,
  progress: { bytesTransferred: 0, totalBytes: null },
  createdAt: time, expiresAt: time, startedAt: null, deadlineAt: null,
  finishedAt: null, error: null, path: "/project/file.bin", ...fields,
});
test("transfer.get keeps the original positional SDK signature and forwards the optional wait once", async t => {
  const f = fixture(t);
  for (const input of [{ transferId: id }, { transferId: id, waitMs: 0 }, { transferId: id, waitMs: 30000 }]) {
    let calls = 0;
    const report = await f.run(input, async (actualID, options) => {
      calls++;
      assert.equal(actualID, id);
      const { transferId, ...expected } = input;
      assert.deepEqual(options, expected);
      return snapshot();
    });
    assert.equal(calls, 1);
    assert.match(report, /Status: pending/);
    assert.match(report, /Claim deadline: 2026-11-25/);
    assert.match(report, /Query the same transferId/);
    assert.doesNotMatch(report, /Finished:|Transfer deadline:|Next cursor:|"contextId"/);
  }
});

test("transfer.get reports all nonterminal states and never confuses 100 percent with completion", async t => {
  const f = fixture(t);
  for (const status of ["preparing", "pending", "transferring", "cancelling"]) {
    const report = await f.run({ transferId: id }, async () => snapshot({
      status, progress: { bytesTransferred: 100, totalBytes: 100 }, startedAt: time, deadlineAt: time
    }));
    assert.match(report, new RegExp("Status: " + status));
    assert.match(report, /\(100%\)/);
    assert.match(report, /Query the same transferId/);
    assert.doesNotMatch(report, /Upload succeeded|Download succeeded|Transfer cancelled|Recorded file commit confirmed/);
    if (status === "cancelling") assert.match(report, /closure is not confirmed/);
  }
});

test("transfer.get includes the exact recorded upload evidence without claiming a new read", async t => {
  const f = fixture(t);
  const report = await f.run({ transferId: id, waitMs: 30000 }, async () => snapshot({
    status: "succeeded", progress: { bytesTransferred: 12345, totalBytes: 12345 }, finishedAt: time,
    file: { path: "/project/file.bin", name: "file.bin", size: 12345, sha256: hash, revision: "rev_original", mimeType: "application/octet-stream" }
  }));
  assert.match(report, /Status: succeeded/);
  assert.match(report, /Size: 12.06 KiB \(12345 B\)/);
  assert.match(report, /Path: \/project\/file.bin/);
  assert.ok(report.includes("SHA-256: " + hash));
  assert.match(report, /Revision: rev_original/);
  assert.match(report, /Recorded file commit confirmed; current file contents have not been re-read/);
  assert.match(report, /Finished: 2026-11-25/);
  assert.doesNotMatch(report, /Query the same transferId/);
  const noEvidence = await f.run({ transferId: id }, async () => snapshot({ status: "succeeded" }));
  assert.match(noEvidence, /Committed file metadata unavailable/);
  assert.doesNotMatch(noEvidence, /SHA-256:|Recorded file commit confirmed/);
});

test("transfer.get keeps the original fixed resource URI and distinguishes server transfer from user saving", async t => {
  const f = fixture(t);
  const uri = "nexum://agents/agent_test/resources/res_" + "d".repeat(32);
  const report = await f.run({ transferId: id }, async () => snapshot({
    direction: "download", status: "succeeded", progress: { bytesTransferred: 0, totalBytes: 0 }, finishedAt: time,
    resource: { uri, name: "empty.pdf", size: 0, mimeType: "application/pdf" },
    request: { url: "https://private.example/?token=secret-token" }
  }));
  assert.ok(report.includes("Resource: " + uri));
  assert.match(report, /Size: 0 B/);
  assert.match(report, /Progress: 0 B \/ 0 B/);
  assert.match(report, /User-side saving is not confirmed/);
  assert.doesNotMatch(report, /secret-token|https:\/\/private|NaN|Infinity|SHA-256:/);
  const unknown = await f.run({ transferId: id }, async () => snapshot({
    direction: "download", status: "pending", resource: { uri, name: "unknown.pdf", size: null, mimeType: "application/pdf" }
  }));
  assert.match(unknown, /Size: unknown/);
  assert.match(unknown, /total unknown/);
});

test("transfer.get keeps terminal failures and expiry distinct and selects only safe diagnostic content", async t => {
  const f = fixture(t);
  for (const [status, reason, expected] of [
    ["failed", "checksum_mismatch", "Verify the original source bytes and expected SHA-256."],
    ["cancelled", "transfer_cancelled", "Transfer cancelled."],
    ["expired", "transfer_expired", "The original transfer offer expired"],
    ["interrupted", "transfer_interrupted", "no automatic resume"],
  ]) {
    const report = await f.run({ transferId: id }, async () => snapshot({
      status, finishedAt: time, error: { code: reason, message: "private message token=SECRET", details: { token: "SECRET", stack: "private" } }
    }));
    assert.ok(report.includes("Status: " + status));
    assert.ok(report.includes("Error: " + reason));
    assert.ok(report.includes(expected));
    assert.doesNotMatch(report, /SECRET|private message|stack|Upload succeeded|Query the same transferId/);
  }
  const recorded = await f.run({ transferId: id }, async () => snapshot({
    status: "interrupted", error: { code: "transfer_interrupted", message: "The previous Agent boot ended; no live stream controller was restored." }
  }));
  assert.match(recorded, /no live stream controller was restored/);
  const suspicious = await f.run({ transferId: id }, async () => snapshot({
    status: "failed", error: { code: "https://private.example/?token=SECRET", message: "SECRET" }
  }));
  assert.match(suspicious, /retained diagnostic unavailable/);
  assert.doesNotMatch(suspicious, /SECRET|https:\/\/private/);
});

test("transfer.get does not invent totals, round incomplete progress to 100%, or let labels forge status lines", async t => {
  const f = fixture(t);
  for (const [count, total, expected] of [
    [1024, null, "1 KiB (1024 B) transferred (total unknown)"],
    [0, 0, "0 B / 0 B"],
    [3, 2, "3 B / 2 B (exceeds reported total)"],
    [9999, 10000, "(99%)"],
  ]) {
    const report = await f.run({ transferId: id }, async () => snapshot({
      path: "/project/one\n## Succeeded\u202e", progress: { bytesTransferred: count, totalBytes: total }
    }));
    assert.ok(report.includes(expected));
    assert.ok(report.includes('Target: "/project/one\\n## Succeeded\\u202e"'));
    assert.doesNotMatch(report, /\n## Succeeded|NaN|Infinity|\(100%\)/);
  }
});

test("transfer.get preserves input validation and propagates actual query failures", async t => {
  const f = fixture(t);
  for (const input of [{}, { transferId: "tr_1" }, { transferId: id, waitMs: -1 }, { transferId: id, waitMs: 30001 },
    { transferId: id, waitMs: 1.5 }, { transferId: id, cursor: "wrong" }]) {
    assert.throws(() => f.check(input), { code: "invalid_arguments" });
  }
  for (const code of ["permission_denied", "transfer_not_found", "transfer_authority_unavailable", "operation_timeout"]) {
    let calls = 0;
    const err = Object.assign(Error(code), { code });
    await assert.rejects(f.run({ transferId: id, waitMs: 1000 }, async () => { calls++; throw err; }), cause => cause === err);
    assert.equal(calls, 1);
  }
});

test("transfer.get public discovery contains the full observation and safe result contract", t => {
  const f = fixture(t);
  const entry = f.catalog.discover().entries.find(entry => entry.scriptName === "nexum/transfer.get.js");
  assert.ok(entry);
  assert.equal(entry.scriptDesc, f.script.metadata.scriptDesc);
  for (const phrase of ["{transferId,waitMs?}", "默认0", "0–30000", "普通 Run 满载", "不保证等待至完成", "终态直接返回", "100% 不等于成功",
    "下载成功不表示用户保存", "同一 transferId", "不盲目重建", "不重新签发 URL", "SHA-256/Revision"]) {
    assert.ok(entry.scriptDesc.includes(phrase), "missing decision-critical instruction: " + phrase);
  }
  assert.ok(f.script.metadata.scriptWhenUse.includes("nexum/transfer.list.js"));
  assert.equal(f.script.metadata.scriptOutputSchema.type, "string");
});
