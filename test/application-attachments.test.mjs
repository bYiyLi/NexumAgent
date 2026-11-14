import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import test from "node:test";

const base =
  process.env.NEXUM_APPLICATION_MODULE ??
  new URL("../dist/application/runtime.js", import.meta.url).href;
const { prepareRunAttachments } = await import(
  new URL("attachments.js", base).href
);
const { TransferStreamSlots } = await import(
  new URL("../transfer/stream-slots.js", base).href
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-inputs-")),
    ),
    work = path.join(root, "work"),
    runId = "run_fixture",
    directory = path.join(work, "tmp", "runs", runId, "inputs");
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController(),
    slots = new TransferStreamSlots();
  const services = {
    runId,
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
  };
  return { root, work, directory, services, slots, controller };
}
function source(bytes, extra = {}) {
  return {
    name: "original/input.bin",
    mimeType: "application/octet-stream",
    size: bytes.length,
    sha256: hash(bytes),
    async open() {
      return { readable: Readable.from([bytes]), closed: Promise.resolve() };
    },
    ...extra,
  };
}

test("the existing upload I/O atomically prepares complete binary inputs and metadata under this run", async (t) => {
  const f = fixture(t),
    bytes = Buffer.alloc(256 * 1024 + 11, 0xff);
  const result = await prepareRunAttachments(
    {
      work: f.work,
      slots: f.slots,
      async resolve() {
        return source(bytes);
      },
    },
    [{ sourceId: "source_fixture" }],
    f.directory,
    f.services,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "original/input.bin");
  assert.equal(result[0].size, bytes.length);
  assert.equal(result[0].sha256, hash(bytes));
  assert.deepEqual(readFileSync(result[0].path), bytes);
  assert.equal(path.dirname(result[0].path), f.directory);
  assert.equal(f.slots.active, 0);
  assert.equal(readdirSync(f.directory).length, 1);
});

test("a failed required input removes the preceding committed batch file and releases the shared slot", async (t) => {
  const f = fixture(t),
    bytes = Buffer.alloc(128 * 1024, 7);
  await assert.rejects(
    prepareRunAttachments(
      {
        work: f.work,
        slots: f.slots,
        async resolve(reference) {
          return source(
            bytes,
            reference.sourceId === "bad" ? { sha256: "0".repeat(64) } : {},
          );
        },
      },
      [{ sourceId: "good" }, { sourceId: "bad" }],
      f.directory,
      f.services,
    ),
  );
  assert.deepEqual(readdirSync(f.directory), []);
  assert.equal(f.slots.active, 0);
});

test("attachment preparation shares the exact four Core stream permits and never queues behind a full pool", async (t) => {
  const f = fixture(t),
    permits = Array.from({ length: 4 }, () => f.slots.tryAcquire());
  let resolutions = 0;
  const options = {
    work: f.work,
    slots: f.slots,
    async resolve() {
      resolutions++;
      return source(Buffer.from("ok"));
    },
  };
  await assert.rejects(
    prepareRunAttachments(
      options,
      [{ sourceId: "one" }],
      f.directory,
      f.services,
    ),
    (cause) => cause.code === "transfer_busy",
  );
  assert.equal(resolutions, 0);
  assert.equal(f.slots.active, 4);
  permits.forEach((permit) => permit.release());
  assert.equal(
    (
      await prepareRunAttachments(
        options,
        [{ sourceId: "one" }],
        f.directory,
        f.services,
      )
    ).length,
    1,
  );
  assert.equal(f.slots.active, 0);
});

test("count, declared single-file bytes and another run directory fail before source opening", async (t) => {
  const f = fixture(t);
  let openings = 0;
  const options = {
    work: f.work,
    slots: f.slots,
    async resolve() {
      return source(Buffer.alloc(0), {
        size: 256 * 1024 * 1024 + 1,
        async open() {
          openings++;
          throw Error("must not open");
        },
      });
    },
  };
  await assert.rejects(
    prepareRunAttachments(
      options,
      Array.from({ length: 21 }, () => ({ sourceId: "one" })),
      f.directory,
      f.services,
    ),
    (cause) => cause.code === "attachment_count_exceeded",
  );
  await assert.rejects(
    prepareRunAttachments(
      options,
      [{ sourceId: "one" }],
      f.directory,
      f.services,
    ),
    (cause) => cause.code === "attachment_budget_exceeded",
  );
  const other = path.join(f.work, "tmp/runs/another/inputs");
  mkdirSync(other, { recursive: true });
  await assert.rejects(
    prepareRunAttachments(options, [{ sourceId: "one" }], other, f.services),
    (cause) => cause.code === "attachment_path_escape",
  );
  assert.equal(openings, 0);
  assert.equal(f.slots.active, 0);
});
