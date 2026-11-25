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
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-sh-resize-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ScriptCatalog(root, "agent");
  const script = catalog.resolve("nexum/sh.resize.js");
  const check = compileInputSchema(script.metadata.scriptInputSchema);
  const checkOutput = compileInputSchema(script.metadata.scriptOutputSchema);
  const execute = new AsyncFunction("context", "sh", script.code);
  return {
    catalog, script, check,
    async run(input, resize) {
      check(input);
      const report = await execute({ input }, { resize });
      checkOutput(report);
      return report;
    }
  };
}

test("sh.resize forwards the exact original process and dimensions once and reports the SDK receipt", async t => {
  const f = fixture(t);
  for (const [cols, rows] of [[100, 40], [1, 1000], [1000, 1]]) {
    const input = { processId: id, cols, rows };
    let calls = 0;
    const report = await f.run(input, async actual => {
      calls++;
      assert.deepEqual(actual, input);
      return { processId: id, accepted: true, cols, rows };
    });
    assert.equal(calls, 1);
    assert.equal(report, "Terminal resize accepted.\nProcess: " + id + "\nSize: " + cols + " columns × " + rows + " rows");
    assert.doesNotMatch(report, /redraw complete|Process stopped|"accepted"/i);
  }
});

test("sh.resize preserves both required integer dimensions and the existing limits", t => {
  const f = fixture(t);
  for (const input of [
    {}, { processId: id, cols: 80 }, { processId: id, rows: 24 }, { cols: 80, rows: 24 },
    { processId: "123", cols: 80, rows: 24 }, { processId: id, cols: 0, rows: 24 },
    { processId: id, cols: 80, rows: 1001 }, { processId: id, cols: 1001, rows: 24 },
    { processId: id, cols: 80, rows: -1 }, { processId: id, cols: 1.5, rows: 24 },
    { processId: id, cols: "80", rows: 24 }, { processId: id, cols: 80, rows: 24, tty: true }
  ]) assert.throws(() => f.check(input), { code: "invalid_arguments" });
  assert.doesNotThrow(() => f.check({ processId: id, cols: 1, rows: 1000 }));
  assert.doesNotThrow(() => f.check({ processId: id, cols: 1000, rows: 1 }));
});

test("sh.resize propagates non-PTY, closed, denied and unknown outcome errors without retrying", async t => {
  const f = fixture(t);
  for (const code of ["process_not_tty", "process_input_closed", "permission_denied", "process_resize_failed", "operation_timeout"]) {
    let calls = 0;
    const err = Object.assign(Error(code), { code });
    await assert.rejects(f.run({ processId: id, cols: 80, rows: 24 }, async () => {
      calls++;
      throw err;
    }), cause => cause === err);
    assert.equal(calls, 1);
  }
});

test("sh.resize public discovery retains the invocation, PTY-only boundary and recovery contract", t => {
  const f = fixture(t);
  const entry = f.catalog.discover().entries.find(entry => entry.scriptName === "nexum/sh.resize.js");
  assert.ok(entry);
  assert.equal(entry.scriptDesc, f.script.metadata.scriptDesc);
  for (const phrase of ["{processId,cols,rows}", "不是 OS PID", "普通 Run 满载", "tty:true",
    "cols 为列数、rows 为行数", "1–1000", "普通管道不支持 resize", "不重启进程",
    "不代表终端应用已完成重绘", "nexum/sh.get.js", "参数错误时修正行列",
    "授权被拒绝时停止调整", "查询原 Run 及原进程", "不盲目重试"]) {
    assert.ok(entry.scriptDesc.includes(phrase), "missing decision-critical instruction: " + phrase);
  }
  assert.equal(f.script.metadata.scriptOutputSchema.type, "string");
  assert.equal(f.script.metadata.scriptOpenDefault, false);
});
