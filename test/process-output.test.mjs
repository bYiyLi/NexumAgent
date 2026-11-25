import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";

const { ProcessOutputLog } = await import(
  process.env.NEXUM_PROCESS_OUTPUT_TEST_MODULE ??
    new URL("../dist/process/output-log.js", import.meta.url)
);
const id = (value = "a") => `res_${value.repeat(32)}`;
function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-output-")),
  );
  const views = [];
  t.after(async () => {
    for (const view of views) await view.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const create = (processId = id(), overrides = {}) => {
    const value = new ProcessOutputLog(root, processId, {
      ...options,
      ...overrides,
    });
    views.push(value);
    return value;
  };
  return { root, create };
}
function joined(page, stream) {
  const values = page.output
    .filter((block) => block.stream === stream)
    .map((block) => block.data);
  return values.every((value) => typeof value === "string")
    ? values.join("")
    : Buffer.concat(values);
}
async function all(log, options = {}) {
  const output = [];
  let cursor, final;
  for (let index = 0; index < 10000; index++) {
    const page = await log.read({
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const repeat = await log.read({
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.deepEqual(repeat, page);
    output.push(...page.output);
    final = page;
    cursor = page.nextCursor;
    if (!page.hasMoreOutput) return { ...page, output };
  }
  assert.fail("output pagination did not make bounded progress");
}

test("construction is cold and history open never creates or repairs missing output", async (t) => {
  const f = fixture(t),
    log = f.create();
  assert.deepEqual(readdirSync(f.root), []);
  assert.equal(
    log.path,
    path.join(f.root, "logs", "processes", `${id()}.output`),
  );
  assert.equal(log.maxBytes, 16 * 1024 * 1024);
  assert.throws(() => log.read(), { code: "output_closed" });
  await assert.rejects(f.create(id("b")).open({ readOnly: true }), {
    code: "output_unavailable",
  });
  assert.deepEqual(readdirSync(f.root), []);
  await log.open();
  assert.equal(log.outputComplete, false);
  assert.ok(statSync(log.path).size > 0);
  if (process.platform !== "win32")
    assert.equal(statSync(log.path).mode & 0o777, 0o600);
  await assert.rejects(f.create().open(), { code: "output_unavailable" });
  assert.throws(() => f.create("../outside"), {
    code: "invalid_output_options",
  });
  assert.throws(() => f.create(id("c"), { maxBytes: 511 }), {
    code: "invalid_output_options",
  });
});

test("accepted stdout/stderr/terminal captures serialize and snapshot only the actual native byte view", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  const backing = Buffer.from([91, 1, 2, 3, 92]);
  const first = log.append("stdout", backing.subarray(1, 4));
  backing.fill(9);
  const second = log.append("stderr", Buffer.from([4, 5]));
  const third = log.append("terminal", Buffer.from([0, 255]));
  await Promise.all([first, second, third]);
  const page = await log.read({ encoding: null });
  assert.deepEqual(page.output, [
    { stream: "stdout", data: Buffer.from([1, 2, 3]) },
    { stream: "stderr", data: Buffer.from([4, 5]) },
    { stream: "terminal", data: Buffer.from([0, 255]) },
  ]);
  assert.equal(page.outputComplete, false);
  assert.equal(page.hasMoreOutput, false);
  await log.finish();
  assert.equal(
    (await log.read({ cursor: page.nextCursor, encoding: null }))
      .outputComplete,
    true,
  );
  assert.throws(() => log.append("stdout", Buffer.from("late")), {
    code: "output_complete",
  });
});

test("native capture ignores shadow accessors and rejects proxies or detached bytes without invoking hooks", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  const bytes = Uint8Array.from([91, 1, 2, 92]).subarray(1, 3);
  let hooks = 0;
  for (const field of ["buffer", "byteOffset", "byteLength"])
    Object.defineProperty(bytes, field, {
      get() {
        hooks++;
        throw Error("shadow accessor");
      },
    });
  bytes[Symbol.iterator] = () => {
    hooks++;
    throw Error("iterator");
  };
  await log.append("stdout", bytes);
  const proxy = new Proxy(bytes, {
    get() {
      hooks++;
      throw Error("proxy");
    },
  });
  assert.throws(() => log.append("stdout", proxy), {
    code: "invalid_output_data",
  });
  const detached = new Uint8Array(8);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.throws(() => log.append("stdout", detached), {
    code: "invalid_output_data",
  });
  assert.equal(hooks, 0);
  assert.deepEqual(
    joined(await log.read({ encoding: null }), "stdout"),
    Buffer.from([1, 2]),
  );
});

test("UTF-8 is decoded independently per stream across capture chunks and one-byte repeatable read pages", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  const stdout = Buffer.from("中😀"),
    stderr = Buffer.from("汉é"),
    terminal = Buffer.from("终端");
  for (
    let index = 0;
    index < Math.max(stdout.length, stderr.length, terminal.length);
    index++
  )
    for (const [stream, data] of [
      ["stdout", stdout],
      ["stderr", stderr],
      ["terminal", terminal],
    ])
      if (index < data.length)
        await log.append(stream, data.subarray(index, index + 1));
  await log.finish();
  const page = await all(log, { maxBytes: 1 });
  assert.equal(joined(page, "stdout"), "中😀");
  assert.equal(joined(page, "stderr"), "汉é");
  assert.equal(joined(page, "terminal"), "终端");
  assert.equal(page.outputComplete, true);
  assert.equal(page.truncated, false);
  assert.equal(
    page.output.some((block) => block.data.includes("�")),
    false,
  );
});

test("a live partial character remains in its cursor and is emitted exactly once when later bytes arrive", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  const bytes = Buffer.from("€");
  await log.append("stdout", bytes.subarray(0, 2));
  const partial = await log.read();
  assert.deepEqual(partial.output, []);
  assert.equal(partial.hasMoreOutput, false);
  assert.equal(partial.outputComplete, false);
  await log.append("stderr", Buffer.from("!"));
  await log.append("stdout", bytes.subarray(2));
  const continued = await log.read({ cursor: partial.nextCursor });
  assert.deepEqual(continued.output, [
    { stream: "stderr", data: "!" },
    { stream: "stdout", data: "€" },
  ]);
  assert.deepEqual(await log.read({ cursor: partial.nextCursor }), continued);
  await log.append("stdout", Buffer.from([0xe4]));
  const tail = await log.read({ cursor: continued.nextCursor });
  assert.deepEqual(tail.output, []);
  await log.finish();
  assert.deepEqual(
    joined(await log.read({ cursor: tail.nextCursor }), "stdout"),
    Buffer.from([0xe4]),
  );
});

test("supported standard Node encodings retain native semantics across pages and unsupported choices fail explicitly", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  const bytes = Buffer.from("A汉😀Z", "utf16le");
  for (const byte of bytes) await log.append("stdout", Buffer.from([byte]));
  await log.finish();
  for (const encoding of [
    "utf16le",
    "ucs2",
    "latin1",
    "binary",
    "ascii",
    "hex",
    "base64",
    "base64url",
  ])
    assert.equal(
      joined(await all(log, { encoding, maxBytes: 1 }), "stdout"),
      bytes.toString(encoding),
    );
  assert.throws(() => log.read({ encoding: "iso-2022-jp" }), {
    code: "unsupported_output_encoding",
  });
  assert.throws(() => log.read({ encoding: "__proto__" }), {
    code: "unsupported_output_encoding",
  });
  assert.throws(() => log.read({ maxBytes: 1024 * 1024 + 1 }), {
    code: "invalid_output_options",
  });
  assert.throws(() => log.read({ maxBytes: 0 }), {
    code: "invalid_output_options",
  });
});

test("cursors bind the process, log generation and encoding, reject alteration, and raw byte pages never consume data", async (t) => {
  const f = fixture(t),
    log = f.create(),
    other = f.create(id("b"));
  await Promise.all([log.open(), other.open()]);
  await log.append("stdout", Buffer.from([0, 1, 2, 255, 3]));
  const first = await log.read({ encoding: null, maxBytes: 2 });
  assert.deepEqual(first.output[0].data, Buffer.from([0, 1]));
  const second = await log.read({
    cursor: first.nextCursor,
    encoding: null,
    maxBytes: 2,
  });
  assert.deepEqual(second.output[0].data, Buffer.from([2, 255]));
  assert.deepEqual(
    await log.read({ cursor: first.nextCursor, encoding: null, maxBytes: 2 }),
    second,
  );
  await assert.rejects(
    other.read({ cursor: first.nextCursor, encoding: null }),
    { code: "invalid_output_cursor" },
  );
  const sameProcess = fixture(t).create();
  await sameProcess.open();
  await assert.rejects(
    sameProcess.read({ cursor: first.nextCursor, encoding: null }),
    { code: "invalid_output_cursor" },
  );
  await assert.rejects(log.read({ cursor: first.nextCursor }), {
    code: "invalid_output_cursor",
  });
  await assert.rejects(
    log.read({ cursor: `${first.nextCursor.slice(0, -2)}AA`, encoding: null }),
    { code: "invalid_output_cursor" },
  );
  await assert.rejects(log.read({ cursor: "invalid" }), {
    code: "invalid_output_cursor",
  });
});

test("disk retention discards old frames, reports truncation and stale cursors, and still captures later output", async (t) => {
  const f = fixture(t, { maxBytes: 1024 }),
    log = f.create();
  await log.open();
  let changes = 0;
  log.on("change", () => changes++);
  const changed = once(log, "change");
  await log.append("stdout", Buffer.alloc(200, 65));
  await changed;
  const old = await log.read({ maxBytes: 10, encoding: null });
  for (const [stream, byte] of [
    ["stderr", 66],
    ["stdout", 67],
    ["terminal", 68],
  ])
    await log.append(stream, Buffer.alloc(300, byte));
  const retained = await all(log, { encoding: null, maxBytes: 97 });
  assert.equal(retained.truncated, true);
  assert.deepEqual(joined(retained, "stdout"), Buffer.alloc(300, 67));
  assert.deepEqual(joined(retained, "terminal"), Buffer.alloc(300, 68));
  const stale = await log.read({ cursor: old.nextCursor, encoding: null });
  assert.equal(stale.truncated, true);
  assert.deepEqual(stale.output, (await log.read({ encoding: null })).output);
  await log.finish();
  assert.ok(changes >= 5);
  const diskBytes = readdirSync(path.dirname(log.path)).reduce(
    (total, name) =>
      total + statSync(path.join(path.dirname(log.path), name)).size,
    0,
  );
  assert.ok(diskBytes <= 1024);
  const history = f.create();
  await history.open({ readOnly: true });
  assert.equal(history.maxBytes, 1024);
  assert.equal((await history.read({ encoding: null })).outputComplete, true);
  assert.equal((await history.read()).truncated, true);
});

test("a single capture larger than retention keeps its newest tail without exceeding disk policy", async (t) => {
  const f = fixture(t, { maxBytes: 512, maxPendingBytes: 8192 }),
    log = f.create();
  await log.open();
  const bytes = Buffer.alloc(4096, 65);
  bytes[bytes.length - 1] = 90;
  await log.append("stdout", bytes);
  const result = await log.read({ encoding: null });
  const tail = joined(result, "stdout");
  assert.ok(tail.length > 0 && tail.length < bytes.length);
  assert.deepEqual(tail, bytes.subarray(bytes.length - tail.length));
  assert.equal(result.truncated, true);
  await log.finish();
  assert.ok(
    readdirSync(path.dirname(log.path)).reduce(
      (n, name) => n + statSync(path.join(path.dirname(log.path), name)).size,
      0,
    ) <= 512,
  );
});

test("repeated ring wrap retains an ordered suffix of independently modeled stream bytes", async (t) => {
  const f = fixture(t, { maxBytes: 1024 }),
    log = f.create();
  await log.open();
  const observed = [],
    sizes = [1, 127, 2, 333, 63, 7, 512, 199, 5, 73, 311, 9];
  for (let index = 0; index < 24; index++) {
    const stream = ["stdout", "stderr", "terminal"][index % 3],
      bytes = Buffer.alloc(sizes[index % sizes.length], index);
    await log.append(stream, bytes);
    for (const byte of bytes) observed.push([stream, byte]);
    const page = await all(log, { encoding: null, maxBytes: 37 });
    const actual = page.output.flatMap((block) =>
      [...block.data].map((byte) => [block.stream, byte]),
    );
    assert.deepEqual(actual, observed.slice(-actual.length));
    assert.ok(statSync(log.path).size <= 1024);
  }
  await log.finish();
});

test("pending capture admission has real bounded backpressure and does not silently accept rejected bytes", async (t) => {
  const f = fixture(t, { maxPendingBytes: 8 }),
    log = f.create();
  await log.open();
  const first = log.append("stdout", Buffer.from("12345678"));
  await assert.rejects(log.append("stderr", Buffer.from("X")), {
    code: "output_busy",
  });
  await first;
  await log.append("stderr", Buffer.from("Y"));
  const pending = Array.from({ length: 32 }, () =>
    log.append("stdout", Buffer.alloc(0)),
  );
  await assert.rejects(log.append("stdout", Buffer.alloc(0)), {
    code: "output_busy",
  });
  // One fixed cleanup slot remains available even when normal admission is full.
  const finished = log.finish();
  await Promise.all(pending);
  await finished;
  const page = await log.read();
  assert.equal(joined(page, "stdout"), "12345678");
  assert.equal(joined(page, "stderr"), "Y");
  assert.equal(page.outputComplete, true);
});

test("real concurrently drained child pipes preserve all raw output under awaited append backpressure", async (t) => {
  const f = fixture(t, { maxBytes: 1024 * 1024 }),
    log = f.create();
  await log.open();
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stdout.write(Buffer.alloc(150000,65));process.stderr.write(Buffer.alloc(130000,66));",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  const drain = async (stream, name) => {
    for await (const bytes of stream) await log.append(name, bytes);
  };
  await Promise.all([
    drain(child.stdout, "stdout"),
    drain(child.stderr, "stderr"),
  ]);
  assert.deepEqual(await closed, [0, null]);
  await log.finish();
  const page = await all(log, { encoding: null, maxBytes: 32768 });
  assert.deepEqual(joined(page, "stdout"), Buffer.alloc(150000, 65));
  assert.deepEqual(joined(page, "stderr"), Buffer.alloc(130000, 66));
  assert.equal(page.truncated, false);
  assert.equal(page.outputComplete, true);
});

test("history does not depend on an active controller and closing a view never manufactures completion", async (t) => {
  const f = fixture(t),
    writer = f.create();
  await writer.open();
  await writer.append("stdout", Buffer.from("before restart"));
  await writer.close();
  const history = f.create();
  await history.open({ readOnly: true });
  assert.equal(joined(await history.read(), "stdout"), "before restart");
  assert.equal(history.outputComplete, false);
  assert.throws(() => history.append("stdout", Buffer.from("new")), {
    code: "output_read_only",
  });
  assert.throws(() => history.finish(), { code: "output_read_only" });
  await history.close();
  await assert.rejects(history.open({ readOnly: true }), {
    code: "output_closed",
  });
  const reopened = f.create();
  await reopened.open({ readOnly: true });
  assert.equal((await reopened.read()).outputComplete, false);
  await reopened.close();
  rmSync(writer.path);
  await assert.rejects(f.create().open({ readOnly: true }), {
    code: "output_unavailable",
  });
  assert.equal(existsSync(writer.path), false);
});

test("cancellation waits for an actual in-flight write, preserves committed bytes and leaves completion false", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  const probe = await open(path.join(f.root, "probe"), "w"),
    prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.write,
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let delayed = false;
  t.mock.method(prototype, "write", async function (...args) {
    if (
      !delayed &&
      Buffer.isBuffer(args[0]) &&
      args[0].length === 19 &&
      args[0][0] === 65
    ) {
      delayed = true;
      entered.resolve();
      await release.promise;
    }
    return Reflect.apply(original, this, args);
  });
  const controller = new AbortController(),
    reason = new Error("capture cancelled");
  const pending = log.append("stdout", Buffer.alloc(19, 65), {
    signal: controller.signal,
  });
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await entered.promise;
  controller.abort(reason);
  await turn();
  assert.equal(settled, false);
  release.resolve();
  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(
    joined(await log.read({ encoding: null }), "stdout"),
    Buffer.alloc(19, 65),
  );
  assert.equal(log.outputComplete, false);
  await log.finish();
});

test("finish publishes completion only after real sync/close and late cancellation does not pretend I/O ended early", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  await log.append("stdout", Buffer.from("done"));
  const probe = await open(path.join(f.root, "probe"), "w"),
    prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.sync,
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let delayed = false;
  t.mock.method(prototype, "sync", async function (...args) {
    if (!delayed) {
      delayed = true;
      entered.resolve();
      await release.promise;
    }
    return Reflect.apply(original, this, args);
  });
  const controller = new AbortController(),
    reason = new Error("finish observer cancelled");
  const pending = log.finish({ signal: controller.signal });
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await entered.promise;
  controller.abort(reason);
  await turn();
  assert.equal(settled, false);
  assert.equal(log.outputComplete, false);
  const during = f.create();
  await during.open({ readOnly: true });
  assert.equal((await during.read()).outputComplete, false);
  await during.close();
  release.resolve();
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(log.outputComplete, true);
  const history = f.create();
  await history.open({ readOnly: true });
  assert.equal((await history.read()).outputComplete, true);
});

test("pre-cancelled operations and failed sync do not mark historical output complete", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  const controller = new AbortController(),
    reason = new Error("cancelled");
  controller.abort(reason);
  assert.throws(
    () =>
      log.append("stdout", Buffer.from("ignored"), {
        signal: controller.signal,
      }),
    (error) => error === reason,
  );
  await assert.rejects(
    log.read({ signal: controller.signal }),
    (error) => error === reason,
  );
  await assert.rejects(
    log.finish({ signal: controller.signal }),
    (error) => error === reason,
  );
  await log.append("stdout", Buffer.from("retained"));
  const probe = await open(path.join(f.root, "probe"), "w"),
    prototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.mock.method(prototype, "sync", async () => {
    throw new Error("disk sync failed");
  });
  await assert.rejects(log.finish(), { code: "output_unavailable" });
  assert.equal(log.outputComplete, false);
  await log.close();
  const history = f.create();
  await history.open({ readOnly: true });
  assert.equal((await history.read()).outputComplete, false);
  assert.equal(joined(await history.read(), "stdout"), "retained");
});

test("corrupt or replaced retained files fail explicitly without reconstruction", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  await log.append("stdout", Buffer.from("text"));
  await log.finish();
  await log.close();
  const original = readFileSync(log.path);
  writeFileSync(log.path, original.subarray(0, 30));
  await assert.rejects(f.create().open({ readOnly: true }), {
    code: "output_unavailable",
  });
  assert.equal(statSync(log.path).size, 30);
});

test("a live view rejects replaced files instead of reading or appending through a stale file descriptor", async (t) => {
  const f = fixture(t),
    log = f.create();
  await log.open();
  await log.append("stdout", Buffer.from("original"));
  renameSync(log.path, `${log.path}.moved`);
  writeFileSync(log.path, "replacement");
  await assert.rejects(log.read(), { code: "output_unavailable" });
  await assert.rejects(log.append("stdout", Buffer.from("new")), {
    code: "output_unavailable",
  });
  assert.equal(readFileSync(log.path, "utf8"), "replacement");
});

test("invalid UTF-8 preserves original bytes and raw reads decode known Windows code pages without API changes", async (t) => {
  const f = fixture(t), log = f.create();
  await log.open();
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]);
  const utf8 = Buffer.from("A中😀");
  await log.append("stdout", utf8);
  await log.append("stdout", gbk.subarray(0, 1));
  await log.append("stderr", sjis.subarray(0, 1));
  await log.append("stdout", gbk.subarray(1));
  await log.append("stderr", sjis.subarray(1));
  await log.finish();
  const page = await all(log, { maxBytes: 1 });
  assert.ok(page.output.some(block => Buffer.isBuffer(block.data)));
  const preserved = stream => Buffer.concat(page.output
    .filter(block => block.stream === stream)
    .map(block => Buffer.isBuffer(block.data) ? block.data : Buffer.from(block.data)));
  assert.deepEqual(preserved("stdout"), Buffer.concat([utf8, gbk]));
  assert.deepEqual(preserved("stderr"), sjis);
  const raw = await all(log, { encoding: null, maxBytes: 1 });
  assert.deepEqual(joined(raw, "stdout"), Buffer.concat([utf8, gbk]));
  assert.equal(new TextDecoder("gb18030", { fatal: true }).decode(joined(raw, "stdout").subarray(utf8.length)), "你好");
  assert.equal(new TextDecoder("shift_jis", { fatal: true }).decode(joined(raw, "stderr")), "日本");
});

test("explicit legacy encodings produce Unicode across single-byte pages and independent streams", async t => {
  const cases = [
    ["cp936", "c4e3bac3", "你好"],
    ["gb18030", "c4e3bac39534b235", "你好𠮷"],
    ["cp932", "93fa967b8cea", "日本語"],
    ["cp950", "c163c5e9", "繁體"],
    ["cp949", "c7d1b1db", "한글"],
    ["cp1252", "80e9", "€é"],
  ];
  for (const [encoding, hex, expected] of cases) {
    const f = fixture(t), log = f.create();
    await log.open();
    const bytes = Buffer.from(hex, "hex");
    for (const b of bytes) {
      await log.append("stdout", Buffer.from([b]));
      await log.append("stderr", Buffer.from([b]));
    }
    await log.finish();
    const page = await all(log, { encoding, maxBytes: 1 });
    assert.equal(joined(page, "stdout"), expected, encoding);
    assert.equal(joined(page, "stderr"), expected, encoding);
    const raw = await all(log, { encoding: null, maxBytes: 1 });
    assert.deepEqual(joined(raw, "stdout"), bytes);
  }
});

test("automatic decoding is stream-local and follows complete BOM evidence across retained pages", async t => {
  const f = fixture(t), log = f.create();
  await log.open();
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文𠮷", "utf16le")]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("日本語😀", "utf16le").swap16()]);
  const terminal = Buffer.from("终端😀");
  for (let i=0; i<Math.max(le.length,be.length,terminal.length); i++) {
    for (const [stream, bytes] of [["stdout",le],["stderr",be],["terminal",terminal]]) {
      if (i<bytes.length) await log.append(stream,bytes.subarray(i,i+1));
    }
  }
  await log.finish();
  const page = await all(log,{maxBytes:1});
  assert.equal(joined(page,"stdout"),"中文𠮷");
  assert.equal(joined(page,"stderr"),"日本語😀");
  assert.equal(joined(page,"terminal"),"终端😀");
  const history = f.create();
  await history.open({readOnly:true});
  assert.deepEqual(await all(history,{maxBytes:1}),page);
  assert.deepEqual(joined(await all(history,{encoding:null,maxBytes:1}),"stdout"),le);
});

test("unrecognized or incomplete BOM sequences never silently become text", async t => {
  const f=fixture(t),log=f.create();
  await log.open();
  const bytes=Buffer.from([0xff,0xfe,0,0,0x41,0,0,0]);
  for(const byte of bytes) await log.append("stdout",Buffer.from([byte]));
  await log.append("stderr",Buffer.from([0xef,0xbb]));
  await log.finish();
  const page=await all(log,{maxBytes:1});
  assert.deepEqual(joined(page,"stdout"),bytes);
  assert.deepEqual(joined(page,"stderr"),Buffer.from([0xef,0xbb]));
});

test("legacy default UTF-8 cursors and explicit aliases remain repeatable", async t => {
  const f=fixture(t),log=f.create();
  await log.open();
  const bytes=Buffer.from("中😀");
  await log.append("stdout",bytes.subarray(0,2));
  const first=await log.read({encoding:"utf8",maxBytes:2});
  await log.append("stdout",bytes.subarray(2));
  await log.finish();
  const next=await log.read({cursor:first.nextCursor});
  assert.equal(joined(next,"stdout"),"中😀");
  assert.deepEqual(await log.read({cursor:first.nextCursor,encoding:"cp65001"}),next);
  await assert.rejects(log.read({cursor:first.nextCursor,encoding:"cp936"}),{code:"invalid_output_cursor"});
});

test("known Windows single-byte OEM pages use native conversion only on Windows", {skip:process.platform!=="win32"}, async t => {
  const f=fixture(t),log=f.create();
  await log.open();
  await log.append("stdout",Buffer.from([0x82]));
  await log.append("stderr",Buffer.from([0x9b]));
  await log.finish();
  assert.equal(joined(await all(log,{encoding:"cp437",maxBytes:1}),"stdout"),"é");
  assert.equal(joined(await all(log,{encoding:"cp850",maxBytes:1}),"stderr"),"ø");
});

test("Windows auto fallback decodes localized pipe output by original code page across page sizes and historical readers", async t => {
  const samples=[
    [936,"c0b4d7d4203132372e302e302e3120b5c4bbd8b8b43a","来自 127.0.0.1 的回复:"],
    [54936,"c4e3bac39534b235","你好𠮷"],
    [932,"93fa967b8cea","日本語"],
    [950,"c163c5e9","繁體"],
    [949,"c7d1b1db","한글"],
    [1252,"80e9","€é"],
  ];
  for (const [page,hex,expected] of samples) {
    const f=fixture(t),log=f.create();
    await log.open();
    const early=await log.read();
    await log.configureWindowsFallback(page);
    // ASCII must not commit the stream to UTF-8 prematurely.
    await log.append("stdout",Buffer.from("prefix "));
    const earlyRead=await log.read({cursor:early.nextCursor,maxBytes:7});
    assert.equal(joined(earlyRead,"stdout"),"prefix ");
    const bytes=Buffer.from(hex,"hex");
    // Independent streams: stderr and terminal remain UTF-8.
    await log.append("stderr",Buffer.from("现代 UTF-8 😀"));
    await log.append("terminal",Buffer.from("终端"));
    for(const byte of bytes) await log.append("stdout",Buffer.from([byte]));
    await log.finish();
    for (const maxBytes of [1,2,7,65536]) {
      const result=await all(log,{maxBytes});
      assert.equal(joined(result,"stdout"),"prefix "+expected,`page=${page} bytes=${maxBytes}`);
      assert.equal(joined(result,"stderr"),"现代 UTF-8 😀");
      assert.equal(joined(result,"terminal"),"终端");
    }
    await log.close();
    const historical=f.create();
    await historical.open({readOnly:true});
    assert.equal(joined(await all(historical,{maxBytes:1}),"stdout"),"prefix "+expected);
    assert.deepEqual(joined(await all(historical,{encoding:null}),"stdout"),Buffer.concat([Buffer.from("prefix "),bytes]));
    await assert.rejects(historical.configureWindowsFallback(932),{code:"invalid_output_options"});
  }
});

test("auto detection does not switch a confirmed UTF-8 stream or reinterpret ConPTY as a legacy pipe",async t=>{
  const f=fixture(t),log=f.create();
  await log.open();
  await log.configureWindowsFallback(936);
  const utf8=Buffer.from("中文");
  const gbk=Buffer.from("c4e3bac3","hex");
  await log.append("stdout",utf8);
  await log.append("stdout",gbk);
  await log.append("stderr",gbk);
  await log.append("terminal",gbk);
  await log.finish();
  const page=await all(log,{maxBytes:1});
  assert.equal(page.output.filter(x=>x.stream==="stdout"&&typeof x.data==="string").map(x=>x.data).join(""),"中文");
  assert.deepEqual(Buffer.concat(page.output.filter(x=>x.stream==="stdout"&&Buffer.isBuffer(x.data)).map(x=>x.data)),gbk);
  assert.equal(joined(page,"stderr"),"你好");
  assert.deepEqual(joined(page,"terminal"),gbk);
  await assert.rejects(log.configureWindowsFallback(932),{code:"invalid_output_options"});
});

test("an unsupported native legacy fallback never hides retained raw bytes or breaks historical output",async t=>{
  if(process.platform==="win32")return;
  const f=fixture(t),log=f.create();
  await log.open();
  await log.configureWindowsFallback(437);
  await log.append("stdout",Buffer.from([0x82,0x83]));
  await log.finish();
  assert.deepEqual(joined(await all(log,{maxBytes:1}),"stdout"),Buffer.from([0x82,0x83]));
});

test("an incomplete UTF-8 prefix can become a valid single-byte legacy character at actual EOF",async t=>{
  const f=fixture(t),log=f.create();
  await log.open();
  await log.configureWindowsFallback(1252);
  await log.append("stdout",Buffer.from([0xe9]));
  const before=await log.read();
  assert.deepEqual(before.output,[]);
  assert.equal(before.outputComplete,false);
  await log.finish();
  const final=await log.read({cursor:before.nextCursor});
  assert.equal(joined(final,"stdout"),"é");
  assert.deepEqual(await log.read({cursor:before.nextCursor}),final);
  assert.deepEqual((await log.read({cursor:final.nextCursor})).output,[]);
});

test("historical logs with no recorded fallback do not guess a code page",async t=>{
  const f=fixture(t),log=f.create();
  await log.open();
  await log.append("stdout",Buffer.from("c4e3bac3","hex"));
  await log.finish();
  await log.close();
  const history=f.create();
  await history.open({readOnly:true});
  const raw=await all(history,{maxBytes:1});
  assert.deepEqual(joined(raw,"stdout"),Buffer.from("c4e3bac3","hex"));
  assert.equal(joined(await all(history,{encoding:"cp936"}),"stdout"),"你好");
});

test("a consumed auto cursor cannot be replayed under a changed code-page header", async t => {
  const f=fixture(t),log=f.create();
  await log.open();
  await log.configureWindowsFallback(936);
  await log.append("stdout",Buffer.from("c4e3bac3","hex"));
  await log.finish();
  const cursor=(await log.read({maxBytes:2})).nextCursor;
  await log.close();
  const file=await open(log.path,"r+");
  const altered=Buffer.alloc(2);
  altered.writeUInt16LE(932);
  await file.write(altered,0,2,110);
  await file.close();
  const history=f.create();
  await history.open({readOnly:true});
  await assert.rejects(history.read({cursor}),{code:"invalid_output_cursor"});
  assert.deepEqual(joined(await all(history,{encoding:null}),"stdout"),Buffer.from("c4e3bac3","hex"));
});

test("raw automatic fallback carries no lost bytes after a decoder is unavailable", async t => {
  const {outputDecoder}=await import("../dist/process/output-encoding.js");
  const raw=outputDecoder("auto",Buffer.from([0x82]).toString("base64"),"raw");
  assert.deepEqual(raw.write(Buffer.from([0x83])),Buffer.from([0x82,0x83]));
  assert.equal(raw.carry(),"");
  assert.deepEqual(raw.end(),Buffer.alloc(0));
});
