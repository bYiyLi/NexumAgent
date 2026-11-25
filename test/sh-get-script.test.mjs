import assert from "node:assert/strict";
import { File } from "node:buffer";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { compileInputSchema } from "../dist/contracts/validation.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const id = "res_" + "a".repeat(32);
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-sh-get-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new ScriptCatalog(root, "agent").resolve("nexum/sh.get.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  // The output header describes native File values. The JSON-only input
  // validator cannot validate a live File before result normalization.
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "sh", script.code);
  return {
    check,
    async run(input, get) {
      check(input);
      const result = await execute({ input }, { get });
      checkOutput(typeof result === "string" ? result : [result[0], {}]);
      return result;
    }
  };
}
const page = (fields = {}) => ({
  processId: id, status: "registered", state: "running", lifetime: "background",
  originRunId: "run_example", contextId: "ctx_example",
  origin: { type: "platform", owner: "nexum", namespace: "nexum", version: "1", revision: "revision" },
  createdAt: 1, closedAt: null, handedOffAt: 2, controlAvailable: true,
  pid: 123, exitCode: null, signal: null, outputComplete: false, details: {},
  output: [], nextCursor: "opaque.next", hasMoreOutput: false, truncated: false,
  ...fields
});

test("sh.get preserves the existing input contract and makes exactly one SDK read", async t => {
  const f = fixture(t);
  const input = { processId: id, cursor: "previous.cursor", maxBytes: 256, waitMs: 30000, encoding: "gbk" };
  let calls = 0;
  const text = await f.run(input, async actual => {
    calls++;
    assert.deepEqual(actual, input);
    return page({ details: { executable: "/usr/bin/node", cwd: "/project", privateFact: "unused" } });
  });
  assert.equal(calls, 1);
  assert.match(text, /Process: res_a{32}\nrunning · background · PID 123 · control available/);
  assert.match(text, /No output on this read/);
  assert.match(text, /Next cursor: "opaque\.next"/);
  assert.match(text, /Continue with the same processId and encoding/);
  assert.doesNotMatch(text, /privateFact|unused|"origin"|"output"/);
  for (const input of [{}, { processId: "invalid" }, { processId: id, maxBytes: 0 }, { processId: id, waitMs: 30001 }, { processId: id, encoding: "unsupported" }]) {
    assert.throws(() => f.check(input), { code: "invalid_arguments" });
  }
  assert.doesNotThrow(() => f.check({ processId: id, encoding: null }));
});

test("sh.get merges adjacent text blocks without reordering streams or changing original log bytes", async t => {
  const f = fixture(t);
  const text = await f.run({ processId: id }, async () => page({
    output: [
      { stream: "stdout", data: "part" },
      { stream: "stdout", data: "ial\r\n" },
      { stream: "stderr", data: "error  " },
      { stream: "stdout", data: "after\n" },
      { stream: "terminal", data: "~~~\n## fake heading\n" }
    ]
  }));
  assert.match(text, /### stdout\n\n~~~\npartial\r\n\n~~~/);
  assert.ok(text.indexOf("partial") < text.indexOf("error  "));
  assert.ok(text.indexOf("error  ") < text.indexOf("after\n"));
  assert.match(text, /### terminal\n\n~~~~\n~~~\n## fake heading\n\n~~~~/);
  assert.equal(text.match(/^### stdout$/gm).length, 2);
});

test("sh.get separates physical closure, exit status, output capture and current-page coverage", async t => {
  const f = fixture(t);
  const ended = { status: "closed", state: "exited", closedAt: 10, exitCode: 1, controlAvailable: false, outputComplete: true };
  const completed = await f.run({ processId: id }, async () => page(ended));
  assert.match(completed, /exit code 1/);
  assert.match(completed, /Process closed\.\nOutput capture complete\.\nNo more retained output at this read\./);
  assert.doesNotMatch(completed, /Continue with/);
  assert.match(completed, /Next cursor: "opaque.next"/);
  const more = await f.run({ processId: id }, async () => page({ ...ended, hasMoreOutput: true }));
  assert.match(more, /More retained output available/);
  assert.match(more, /Continue with the same processId/);
  const incomplete = await f.run({ processId: id }, async () => page({ ...ended, outputComplete: false, truncated: true }));
  assert.match(incomplete, /Process closed\.\nOutput capture not complete/);
  assert.match(incomplete, /Earlier output was truncated/);
  assert.doesNotMatch(incomplete, /Continue with/);
  const finishing = await f.run({ processId: id }, async () => page({ state: "finishing", exitCode: 0, outputComplete: true }));
  assert.match(finishing, /Process closure not confirmed/);
  assert.doesNotMatch(finishing, /Process closed\./);
  const unknown = await f.run({ processId: id }, async () => page({ status: "unconfirmed", state: "failed", controlAvailable: false, details: { failure: { code: "process_failed" } } }));
  assert.match(unknown, /Process closure not confirmed/);
  assert.match(unknown, /Error: process_failed/);
  assert.doesNotMatch(unknown, /Continue with/);
});

test("sh.get preserves an unready cursor and propagates an actual SDK denial", async t => {
  const f = fixture(t);
  const text = await f.run({ processId: id, waitMs: 100 }, async () => page({ state: "preparing", pid: null, nextCursor: null }));
  assert.match(text, /Output cursor not ready; query the same processId again/);
  assert.doesNotMatch(text, /Next cursor:|PID null/);
  const err = Object.assign(new Error("denied"), { code: "permission_denied" });
  await assert.rejects(f.run({ processId: id }, async () => { throw err; }), cause => cause === err);
});

test("sh.get returns one native file for undecoded byte segments in original order, with exact ranges", async t => {
  const f = fixture(t);
  const slice = Buffer.from([99, 0, 255, 99]).subarray(1, 3);
  const output = [
    { stream: "stdout", data: "before" },
    { stream: "stderr", data: slice },
    { stream: "stdout", data: "after" },
    { stream: "terminal", data: new Uint8Array([128, 13, 10]) },
  ];
  const [text, binary] = await f.run({ processId: id }, async () => page({ output, details: { outputEncodingUncertain: true }, hasMoreOutput: true }));
  assert.ok(binary instanceof File);
  assert.equal(binary.name, id + "-output.bin");
  assert.equal(binary.type, "application/octet-stream");
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0, 255, 128, 13, 10]));
  assert.ok(text.indexOf("before") < text.indexOf("offset 0, length 2 bytes"));
  assert.ok(text.indexOf("offset 0, length 2 bytes") < text.indexOf("after"));
  assert.match(text, /### terminal[\s\S]*offset 2, length 3 bytes/);
  assert.match(text, /Some output could not be decoded/);
  assert.match(text, /encoding:null without a cursor/);
  assert.match(text, /Next cursor: "opaque.next"/);
});

test("sh.get returns the complete SDK page without an added delivery budget", async t => {
  const f = fixture(t);
  const long = "日志 ".repeat(40000);
  const text = await f.run({ processId: id, maxBytes: 1048576 }, async () => page({ output: [{ stream: "stdout", data: long }] }));
  assert.ok(text.includes(long));
  assert.doesNotMatch(text, /truncated by retention/);
});
