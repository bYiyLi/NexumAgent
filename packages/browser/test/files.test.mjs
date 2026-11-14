import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  realpathSync,
  lstatSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  materializeDownload,
  prepareFiles,
  browserFileBudget,
} from "../dist/extension/files.js";

function fixture(t, authorize = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-browser-files-test-"));
  const work = path.join(root, "work"),
    pwd = path.join(root, "project");
  mkdirSync(work);
  mkdirSync(pwd);
  const controller = new AbortController(),
    grants = [];
  const call = {
    context: { runId: "run_files_fixture", pwd },
    deadline: Date.now() + 60000,
    signal: controller.signal,
    authorize(target) {
      grants.push({ ...target });
      authorize(target);
    },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, work, pwd, call, controller, grants };
}
function artifacts(work) {
  const run = path.join(work, "tmp", "browser", "run_files_fixture");
  return existsSync(run) ? readdirSync(run) : [];
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function exact(actual, expected) {
  assert.equal(actual.length, expected.length);
  assert.equal(hash(actual), hash(expected));
}

test("downloads create durable exact snapshots with current lexical/canonical authority and actual metadata", async (t) => {
  const f = fixture(t),
    bytes = Buffer.alloc(3 * 65536 + 19, 0x65),
    source = path.join(f.pwd, "report.pdf");
  writeFileSync(source, bytes);
  const result = await materializeDownload(
    { path: "report.pdf", expectedSize: bytes.length },
    f.call,
    f.work,
  );
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, hash(bytes));
  assert.equal(result.name, "report.pdf");
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(
    path.dirname(result.path),
    path.join(realpathSync(f.work), "tmp", "browser", f.call.context.runId),
  );
  exact(readFileSync(result.path), bytes);
  assert.equal(lstatSync(result.path).isFile(), true);
  assert.ok(f.grants.some((g) => g.value === source && g.access === "read"));
  writeFileSync(source, "new contents");
  f.controller.abort();
  exact(readFileSync(result.path), bytes);
  assert.equal(
    artifacts(f.work).some((name) => name.endsWith(".partial")),
    false,
  );
});

test("multiple path/native inputs finish preparation before returning; path snapshots do not track later edits", async (t) => {
  const f = fixture(t),
    source = path.join(f.pwd, "a.txt");
  writeFileSync(source, Buffer.alloc(100000, 0x61));
  const original = Buffer.alloc(150000, 0x73),
    view = new Uint8Array(original.buffer, original.byteOffset + 7, 100000);
  let getterCalls = 0;
  Object.defineProperty(view, "privateController", {
    get() {
      getterCalls++;
      throw Error("private");
    },
  });
  const buffer = new ArrayBuffer(80000);
  new Uint8Array(buffer).fill(0x62);
  Object.defineProperty(buffer, "byteLength", {
    get() {
      getterCalls++;
      throw Error("shadow");
    },
  });
  const result = await prepareFiles(
    [
      "a.txt",
      { data: view, name: "view.bin" },
      { data: buffer, name: "array.bin" },
    ],
    f.call,
    f.work,
  );
  assert.equal(result.length, 3);
  assert.equal(result[0].name, "a.txt");
  assert.equal(result[0].data, undefined);
  assert.notEqual(result[0].path, source);
  assert.equal(readFileSync(result[1].path).byteLength, 100000);
  assert.equal(readFileSync(result[2].path).byteLength, 80000);
  assert.equal(Object.hasOwn(result[1], "privateController"), false);
  assert.equal(getterCalls, 0);
  exact(readFileSync(result[1].path), Buffer.alloc(100000, 0x73));
  original.fill(0);
  assert.equal(readFileSync(result[1].path)[0], 0x73);
  writeFileSync(source, "changed");
  assert.equal(readFileSync(result[0].path).length, 100000);
});

test("a failed later file removes all undelivered copies and never mutates a browser", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.pwd, "one.txt"), "first");
  await assert.rejects(
    prepareFiles(["one.txt", "absent.txt"], f.call, f.work),
    { code: "ENOENT" },
  );
  assert.deepEqual(artifacts(f.work), []);
  const completed = await materializeDownload(
    { path: "one.txt" },
    f.call,
    f.work,
  );
  await assert.rejects(
    prepareFiles(
      ["one.txt", { data: new Uint8Array([1]), name: "bad/name" }],
      f.call,
      f.work,
    ),
    { code: "INVALID_ARGUMENT" },
  );
  assert.deepEqual(artifacts(f.work), [path.basename(completed.path)]);
  assert.equal(readFileSync(completed.path, "utf8"), "first");
});

test("download size mismatches and non-regular sources fail before publication", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.pwd, "file"), "abc");
  await assert.rejects(
    materializeDownload({ path: "file", expectedSize: 9 }, f.call, f.work),
    { code: "FILE_SIZE_MISMATCH" },
  );
  await assert.rejects(materializeDownload({ path: f.pwd }, f.call, f.work), {
    code: "INVALID_ARGUMENT",
  });
  assert.deepEqual(artifacts(f.work), []);
});

test("source mutation, current revocation and cancellation settle with no partial or delivered artifacts", async (t) => {
  for (const mode of ["mutate", "revoke", "cancel"]) {
    let f,
      writes = 0;
    f = fixture(t, (target) => {
      if (
        target.access === "write" &&
        target.value.endsWith(".partial") &&
        ++writes === 2
      ) {
        if (mode === "mutate")
          writeFileSync(path.join(f.pwd, "source"), "replacement");
        if (mode === "revoke")
          throw Object.assign(new Error("revoked"), { code: "forbidden" });
        if (mode === "cancel") f.controller.abort();
      }
    });
    writeFileSync(path.join(f.pwd, "source"), Buffer.alloc(200000, 3));
    await assert.rejects(
      materializeDownload({ path: "source" }, f.call, f.work),
      {
        code:
          mode === "mutate"
            ? "FILE_CHANGED"
            : mode === "revoke"
              ? "forbidden"
              : "CANCELLED",
      },
    );
    assert.deepEqual(artifacts(f.work), []);
  }
});

test("existing final destinations are never replaced and a failed publication removes its partial copy", async (t) => {
  let f;
  f = fixture(t, (target) => {
    if (
      target.access === "write" &&
      path.basename(target.value).match(/^[0-9a-f-]{36}$/) &&
      !existsSync(target.value)
    )
      writeFileSync(target.value, "existing");
  });
  writeFileSync(path.join(f.pwd, "source"), "new");
  await assert.rejects(
    materializeDownload({ path: "source" }, f.call, f.work),
    { code: "EEXIST" },
  );
  const files = artifacts(f.work);
  assert.equal(files.length, 1);
  assert.equal(files[0].endsWith(".partial"), false);
  assert.equal(
    readFileSync(
      path.join(f.work, "tmp", "browser", f.call.context.runId, files[0]),
      "utf8",
    ),
    "existing",
  );
});

test("deadlines, unsafe run IDs, unwriteable work and redirected profile subdirectories fail closed", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.pwd, "source"), "file");
  await assert.rejects(
    prepareFiles(
      [{ data: new Uint8Array([1]), name: "x" }],
      { ...f.call, deadline: Date.now() - 1 },
      f.work,
    ),
    { code: "DEADLINE_EXCEEDED" },
  );
  await assert.rejects(
    materializeDownload(
      { path: "source" },
      { ...f.call, context: { ...f.call.context, runId: "../other" } },
      f.work,
    ),
    { code: "INVALID_CONTEXT" },
  );
  // A pre-existing file in the output directory position is a real filesystem failure on every OS.
  writeFileSync(path.join(f.work, "tmp"), "obstruction");
  await assert.rejects(
    materializeDownload({ path: "source" }, f.call, f.work),
    { code: "FILE_CHANGED" },
  );
  assert.equal(readFileSync(path.join(f.work, "tmp"), "utf8"), "obstruction");
});

test("canonical read authorization is required for symlinked local sources", async (t) => {
  const f = fixture(t, (target) => {
    if (
      target.access === "read" &&
      target.value.startsWith(realpathSync(f.pwd) + path.sep)
    )
      throw Object.assign(new Error("canonical denied"), { code: "forbidden" });
  });
  const real = path.join(f.pwd, "real.bin"),
    alias = path.join(f.root, "alias");
  writeFileSync(real, "actual");
  symlinkSync(f.pwd, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    prepareFiles([path.join(alias, "real.bin")], f.call, f.work),
    {
      code: "forbidden",
    },
  );
  assert.deepEqual(artifacts(f.work), []);
});

test("native Blob and File streams support >64KiB, retain MIME, ignore overridden methods and strip private getters", async (t) => {
  const f = fixture(t),
    bytes = Buffer.alloc(3 * 65536 + 7, 0x62);
  let hooks = 0;
  const blob = new Blob([bytes], { type: "application/x-fixture" });
  for (const name of [
    "size",
    "type",
    "stream",
    "arrayBuffer",
    "privateController",
  ])
    Object.defineProperty(blob, name, {
      get() {
        hooks++;
        throw Error(name);
      },
      enumerable: true,
    });
  const file = new File([bytes], "internal.bin", {
    type: "application/x-file",
  });
  Object.defineProperty(file, "name", {
    get() {
      hooks++;
      throw Error("name");
    },
  });
  const result = await prepareFiles(
    [
      { data: blob, name: "blob.bin" },
      { data: file, name: "file.bin" },
    ],
    f.call,
    f.work,
  );
  assert.equal(hooks, 0);
  exact(readFileSync(result[0].path), bytes);
  exact(readFileSync(result[1].path), bytes);
  assert.equal(result[0].mimeType, "application/x-fixture");
  assert.equal(result[1].mimeType, "application/x-file");
  assert.equal(Object.hasOwn(result[0], "privateController"), false);
});

test("forged Blob Symbol getters and native-handle lookalikes reject without executing source hooks or crashing", async (t) => {
  const f = fixture(t),
    blob = new Blob(["native"]),
    symbols = Object.getOwnPropertySymbols(blob);
  let hooks = 0;
  const fake = Object.create(Blob.prototype);
  for (const symbol of symbols)
    Object.defineProperty(fake, symbol, {
      get() {
        hooks++;
        throw Error("symbol");
      },
    });
  await assert.rejects(
    prepareFiles([{ data: fake, name: "bad" }], f.call, f.work),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(hooks, 0);
  const handleKey = symbols.find((k) => k.description === "kHandle");
  const fakeHandle = Object.create(
    Object.getPrototypeOf(
      Object.getOwnPropertyDescriptor(blob, handleKey).value,
    ),
  );
  const fakeNative = Object.create(Blob.prototype);
  for (const key of symbols)
    Object.defineProperty(fakeNative, key, {
      value:
        key === handleKey
          ? fakeHandle
          : Object.getOwnPropertyDescriptor(blob, key).value,
    });
  await assert.rejects(
    prepareFiles([{ data: fakeNative, name: "bad" }], f.call, f.work),
    { code: "INVALID_ARGUMENT" },
  );
  const realHandle = Object.getOwnPropertyDescriptor(blob, handleKey).value;
  Object.defineProperty(realHandle, "getReader", {
    get() {
      hooks++;
      throw Error("reader");
    },
  });
  await assert.rejects(
    prepareFiles([{ data: blob, name: "bad" }], f.call, f.work),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(hooks, 0);
});

test("input metadata/arrays cannot execute accessors, iterators, Proxy hooks or custom conversion", async (t) => {
  const f = fixture(t);
  let hooks = 0;
  const entry = { name: "x" };
  Object.defineProperty(entry, "data", {
    get() {
      hooks++;
      throw Error("data");
    },
  });
  await assert.rejects(prepareFiles([entry], f.call, f.work), {
    code: "INVALID_ARGUMENT",
  });
  const array = [];
  Object.defineProperty(array, "0", {
    get() {
      hooks++;
      throw Error("index");
    },
  });
  await assert.rejects(prepareFiles(array, f.call, f.work), {
    code: "INVALID_ARGUMENT",
  });
  const proxy = new Proxy([], {
    get() {
      hooks++;
      throw Error("proxy");
    },
    ownKeys() {
      hooks++;
      throw Error("proxy");
    },
  });
  await assert.rejects(prepareFiles(proxy, f.call, f.work), {
    code: "INVALID_ARGUMENT",
  });
  const safe = [{ data: new Uint8Array([7]), name: "safe" }];
  Object.defineProperty(safe, Symbol.iterator, {
    get() {
      hooks++;
      throw Error("iterator");
    },
  });
  const result = await prepareFiles(safe, f.call, f.work);
  assert.equal(readFileSync(result[0].path)[0], 7);
  assert.equal(hooks, 0);
});

test("the 128 MiB budget counts the complete batch while path data stays streamed", async (t) => {
  const f = fixture(t),
    source = path.join(f.pwd, "large");
  writeFileSync(source, "");
  truncateSync(source, browserFileBudget);
  await assert.rejects(
    prepareFiles(
      [source, { data: new Uint8Array([1]), name: "extra" }],
      f.call,
      f.work,
    ),
    { code: "OUTPUT_TOO_LARGE" },
  );
  assert.deepEqual(artifacts(f.work), []);
  const over = new ArrayBuffer(browserFileBudget + 1);
  await assert.rejects(
    prepareFiles([{ data: over, name: "over" }], f.call, f.work),
    { code: "OUTPUT_TOO_LARGE" },
  );
});

test("10 MiB native subviews do not enumerate millions of numeric properties under a bounded JS heap", () => {
  const module = new URL("../dist/extension/files.js", import.meta.url).href;
  const run = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      "--input-type=module",
      "-e",
      `
 import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {prepareFiles} from ${JSON.stringify(module)};
 const source=new Uint8Array(10*1024*1024+20);source.fill(42);const view=source.subarray(9,-11);let calls=0;Object.defineProperty(view,'private',{get(){calls++;throw Error('leak')}});
 const root=mkdtempSync(path.join(tmpdir(),'nexum-browser-files-heap-'));const work=path.join(root,'work');mkdirSync(work);
 try {const call={context:{pwd:root,runId:'run_heap'},signal:new AbortController().signal,deadline:Date.now()+10000,authorize(){}};
 const [result]=await prepareFiles([{data:view,name:'large.bin'}],call,work);const data=readFileSync(result.path);assert.equal(data.length,10*1024*1024);assert.equal(data[0],42);assert.equal(calls,0);assert.equal(Object.hasOwn(result,'private'),false);assert.equal(path.basename(result.path),'large.bin');}finally{rmSync(root,{recursive:true,force:true});}
 `,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  assert.equal(run.signal, null);
});

test("explicit download destinations use current authority and atomic no-replace without creating missing parents", async (t) => {
  const f = fixture(t),
    source = path.join(f.pwd, "source.bin"),
    bytes = Buffer.alloc(150000, 0x41);
  writeFileSync(source, bytes);
  const result = await materializeDownload(
    { path: source, destination: "saved.bin", expectedSize: bytes.length },
    f.call,
    f.work,
  );
  assert.equal(result.path, path.join(realpathSync(f.pwd), "saved.bin"));
  assert.equal(result.name, "saved.bin");
  exact(readFileSync(result.path), bytes);
  assert.equal(result.sha256, hash(bytes));
  assert.ok(
    f.grants.some(
      (target) =>
        target.value === path.join(f.pwd, "saved.bin") &&
        target.access === "write",
    ),
  );
  writeFileSync(source, "later");
  await assert.rejects(
    materializeDownload(
      { path: source, destination: "saved.bin" },
      f.call,
      f.work,
    ),
    { code: "EEXIST" },
  );
  exact(readFileSync(result.path), bytes);
  await assert.rejects(
    materializeDownload(
      { path: source, destination: "absent/save.bin" },
      f.call,
      f.work,
    ),
    { code: "ENOENT" },
  );
  assert.equal(existsSync(path.join(f.pwd, "absent")), false);
  assert.equal(
    readdirSync(f.pwd).some((name) => name.endsWith(".partial")),
    false,
  );
  const denied = {
    ...f.call,
    authorize(target) {
      if (target.access === "write" && target.value.endsWith("denied.bin"))
        throw Object.assign(Error("denied"), { code: "forbidden" });
    },
  };
  await assert.rejects(
    materializeDownload(
      { path: source, destination: "denied.bin" },
      denied,
      f.work,
    ),
    { code: "forbidden" },
  );
  assert.equal(existsSync(path.join(f.pwd, "denied.bin")), false);
});

test("Blob actual stream size is verified independently of its mutable declared native field", async (t) => {
  const f = fixture(t),
    blob = new Blob([Buffer.alloc(100000, 0x61)]),
    lengthKey = Object.getOwnPropertySymbols(blob).find(
      (k) => k.description === "kLength",
    );
  Object.defineProperty(blob, lengthKey, { value: 0 });
  await assert.rejects(
    prepareFiles([{ data: blob, name: "mismatch.bin" }], f.call, f.work),
    { code: "FILE_SIZE_MISMATCH" },
  );
  assert.deepEqual(artifacts(f.work), []);
});
