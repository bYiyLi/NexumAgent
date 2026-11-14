import assert from "node:assert/strict";
import { Console } from "node:console";
import {
  closeSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RunLog, readRunLogRange } from "../dist/runtime/run-log.js";

async function fixture(t, reserve) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-run-log-")),
    ),
    log = new RunLog(root, "run_" + "a".repeat(32), reserve);
  t.after(async () => {
    await log.finish();
    rmSync(root, { recursive: true, force: true });
  });
  await log.open();
  return { root, log };
}
function range(filename) {
  const file = openSync(filename, "r");
  try {
    return readRunLogRange(file, statSync(filename).size);
  } finally {
    closeSync(file);
  }
}

test("native Console drains a >50MiB UTF-8 stream into the latest bounded tail with a persistent byte range", async (t) => {
  let outstanding = 0;
  const { log } = await fixture(t, async (bytes) => {
    outstanding += bytes;
    return {
      release() {
        outstanding -= bytes;
      },
    };
  });
  const console = new Console({
      stdout: log,
      stderr: log,
      ignoreErrors: false,
    }),
    line = "😀x".repeat(256 * 1024),
    count = 44,
    tail = "FINAL_LOG_RECORD";
  for (let index = 0; index < count; index++) console.log(line);
  console.error(tail);
  await log.finish();
  assert.equal(log.failure, undefined);
  assert.equal(outstanding, 0);
  const bytes = readFileSync(log.filename),
    metadata = range(log.filename),
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(metadata.dataOffset),
    );
  assert.ok(bytes.length <= 50 * 1024 * 1024);
  assert.ok(bytes.length >= 50 * 1024 * 1024 - 4);
  assert.ok(metadata.startOffset > 0);
  assert.equal(
    metadata.endOffset,
    count * (Buffer.byteLength(line) + 1) + Buffer.byteLength(tail) + 1,
  );
  assert.equal(
    metadata.endOffset - metadata.startOffset,
    bytes.length - metadata.dataOffset,
  );
  assert.equal(text.endsWith(tail + "\n"), true);
  assert.equal(text.includes("\ufffd"), false);
  const before = statSync(log.filename).size;
  console.log("late unmanaged callback");
  assert.equal(statSync(log.filename).size, before);
});

test("a rejected growth reservation does not write its bytes, leaves an honest range and drains all tickets", async (t) => {
  let admissions = 0,
    outstanding = 0;
  const { log } = await fixture(t, async (bytes) => {
    if (++admissions === 3)
      throw Object.assign(new Error("fixture quota"), {
        code: "storage_quota_exceeded",
      });
    outstanding += bytes;
    return {
      release() {
        outstanding -= bytes;
      },
    };
  });
  await new Promise((resolve) => log.write("first\n", resolve));
  log.write("refused\n");
  await log.finish();
  assert.equal(log.failure.code, "storage_quota_exceeded");
  assert.equal(outstanding, 0);
  const metadata = range(log.filename);
  assert.equal(metadata.endOffset, 6);
  assert.equal(
    readFileSync(log.filename).subarray(metadata.dataOffset).toString(),
    "first\n",
  );
});

test("a hard-linked console log fails before either file is changed", async (t) => {
  const { root, log } = await fixture(t),
    alias = path.join(root, "external-alias.txt"),
    original = readFileSync(log.filename);
  linkSync(log.filename, alias);
  log.write("must not reach either file\n");
  await log.finish();
  assert.equal(log.failure.code, "run_log_unavailable");
  assert.deepEqual(readFileSync(alias), original);
  assert.deepEqual(readFileSync(log.filename), original);
});

test("retained plain-text logs from older runs remain readable without a new writer", async (t) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-old-run-log-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "old.log"),
    text = "older console output 😀\n";
  writeFileSync(filename, text);
  assert.deepEqual(range(filename), {
    dataOffset: 0,
    startOffset: 0,
    endOffset: Buffer.byteLength(text),
  });
});
