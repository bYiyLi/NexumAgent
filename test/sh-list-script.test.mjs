import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-sh-list-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new ScriptCatalog(root, "agent").resolve("nexum/sh.list.js");
  const inputCheck = compileInputSchema(script.metadata.scriptInputSchema);
  const outputCheck = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "sh", script.code);
  const run = async (input, list) => {
    inputCheck(input);
    const result = await execute({ input }, { list });
    outputCheck(result);
    return result;
  };
  return { script, run, inputCheck };
}

const process = (processId, overrides = {}) => ({
  processId, status: "registered", state: "running", lifetime: "run",
  originRunId: "run_example", contextId: "ctx_example",
  origin: { type: "platform", owner: "nexum", namespace: "nexum", version: "1", revision: "revision" },
  createdAt: 1, closedAt: null, handedOffAt: null, controlAvailable: true,
  pid: 123, exitCode: null, signal: null, outputComplete: false, details: {},
  ...overrides,
});

test("sh.list keeps the full optional SDK query contract, one SDK call and an unchanged cursor", async t => {
  const f = fixture(t);
  const input = { status: "registered", state: "running", runId: "run_example", contextId: "ctx_example", limit: 3, cursor: "previous" };
  const cursor = "opaque-123==";
  let calls = 0;
  const result = await f.run(input, async actual => {
    calls++;
    assert.deepEqual(actual, input);
    return { items: [process("res_example")], nextCursor: cursor };
  });
  assert.equal(calls, 1);
  assert.equal(f.script.metadata.scriptOutputSchema.type, "string");
  assert.match(result, /res_example · running · run · PID 123 · control available/);
  assert.ok(result.includes('Next cursor: "' + cursor + '"'));
  assert.ok(result.includes("Continue with the same filters and cursor."));
  assert.doesNotMatch(result, /"items"|"origin"|"details"|"createdAt"/);
  assert.throws(() => f.inputCheck({ limit: 101 }), { code: "invalid_arguments" });
  assert.throws(() => f.inputCheck({ cursor: "" }), { code: "invalid_arguments" });
  assert.throws(() => f.inputCheck({ pid: 1 }), { code: "invalid_arguments" });
});

test("sh.list groups confirmed closure separately from active or unknown processes", async t => {
  const f = fixture(t);
  const rows = [
    process("res_finished", { status: "closed", state: "exited", closedAt: 42, exitCode: 0, controlAvailable: false, outputComplete: true }),
    process("res_running", { lifetime: "background", details: { executable: "/usr/bin/node", cwd: "/project", internal: "do not display", windowsCodePages: { oem: 932 } } }),
    process("res_failed_live", { status: "unconfirmed", state: "failed", controlAvailable: false, details: { failure: { code: "process_failed", privateDetail: "do not display" } } }),
    process("res_stopping", { status: "stopping", state: "stopping", lifetime: "background" }),
    process("res_unavailable", { status: "unavailable", state: "unavailable", controlAvailable: false }),
    process("res_failed_closed", { status: "closed", state: "failed", closedAt: 43, signal: "SIGTERM", exitCode: 1, controlAvailable: false }),
    process("res_preparing", { state: "preparing", pid: null }),
    process("res_finishing", { state: "finishing", exitCode: 0 }),
  ];
  const result = await f.run({}, async () => ({ items: rows, nextCursor: null }));
  const [active, history, unknown] = result.split(/\n\n(?=## )/);
  assert.match(active, /^## Active \/ closing/);
  for (const id of ["res_running", "res_stopping", "res_preparing", "res_finishing"]) assert.ok(active.includes(id), id);
  assert.match(active, /Executable: \/usr\/bin\/node · cwd: \/project/);
  assert.doesNotMatch(active, /res_preparing[^\n]*PID/);
  assert.match(history, /^## Finished/);
  assert.match(history, /res_finished · exited · status: closed · run · exit code 0 · control unavailable · output complete/);
  assert.match(history, /res_failed_closed[^\n]*exit code 1[^\n]*signal SIGTERM[^\n]*output incomplete/);
  assert.doesNotMatch(history, /res_failed_live|res_unavailable|PID/);
  assert.match(unknown, /^## Unavailable \/ unconfirmed/);
  assert.match(unknown, /res_failed_live[^\n]*closure unconfirmed/);
  assert.match(unknown, /res_unavailable[^\n]*closure unconfirmed/);
  assert.match(unknown, /Error: process_failed/);
  assert.match(result, /8 processes returned\.$/);
  assert.doesNotMatch(result, /do not display|windowsCodePages|Next cursor/);
  for (const row of rows) assert.equal(result.split(row.processId).length, 2, row.processId);
});

test("sh.list distinguishes empty final pages from empty continuation pages and propagates SDK errors", async t => {
  const f = fixture(t);
  assert.equal(await f.run({}, async () => ({ items: [], nextCursor: null })), "No processes on this page.");
  const nextCursor = "opaque-next";
  const partial = await f.run({}, async () => ({ items: [], nextCursor }));
  assert.match(partial, /No processes on this page.\nNext cursor: "opaque-next"/);
  const denied = Object.assign(Error("denied"), { code: "permission_denied" });
  await assert.rejects(f.run({}, async () => { throw denied; }), error => error === denied);
});

test("sh.list renders the entire SDK page and escapes misleading line breaks in display values", async t => {
  const f = fixture(t);
  const rows = Array.from({ length: 100 }, (_, i) => process("res_" + String(i).padStart(3, "0"), {
    details: { executable: "node", cwd: i ? "/project/" + i : "/project\n## Finished\u202e" },
  }));
  const result = await f.run({ limit: 100 }, async () => ({ items: rows, nextCursor: "next" }));
  assert.match(result, /100 processes returned/);
  assert.match(result, /Next cursor: "next"/);
  assert.ok(result.includes('cwd: "/project\\n## Finished\\u202e"'));
  assert.doesNotMatch(result, /\n## Finished/);
  assert.equal(result.match(/^    res_\d{3} · /gm)?.length, 100);
  for (const row of rows) assert.equal(result.split(row.processId).length, 2, row.processId);
});
