import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable, Duplex } from "node:stream";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, request } from "node:http";
import test from "node:test";

const moduleUrl =
  process.env.NEXUM_TRANSFER_IO_MODULE ??
  new URL("../dist/transfer/io.js", import.meta.url).href;
const { prepareUpload, receiveUpload, sendDownload, TransferIoError } =
  await import(moduleUrl);
const { ArtifactStore } = await import(
  new URL("../results/artifacts.js", moduleUrl).href
);
const { AgentError } = await import(
  new URL("../contracts/errors.js", moduleUrl).href
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-transfer-io-")),
  );
  const work = path.join(root, "work");
  mkdirSync(work);
  const controller = new AbortController(),
    events = [];
  let authorized = true;
  const scope = {
    pwd: work,
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
    authorize(target) {
      if (!authorized) throw new AgentError("forbidden", "revoked");
      options.authorize?.(target);
    },
    onProgress(count) {
      events.push(count);
      options.progress?.(count);
    },
  };
  const artifacts = new ArtifactStore(root, "agent", {
    maxFileBytes: 1024 * 1024,
    maxReadBytes: 1024 * 1024,
  });
  const artifactScope = {
    pwd: work,
    runId: "origin",
    ownerKey: "owner",
    signal: controller.signal,
    assertCurrent: scope.assertCurrent,
    authorize: () => {},
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = (extra = {}, maxBytes = 1024 * 1024) =>
    prepareUpload({ path: "upload.bin", ...extra }, scope, { maxBytes });
  const source = async (bytes) => {
    const resource = await artifacts.register({ data: bytes }, artifactScope);
    return artifacts.open(resource.uri, artifactScope);
  };
  return {
    root,
    work,
    scope,
    controller,
    events,
    artifacts,
    artifactScope,
    plan,
    source,
    revoke() {
      authorized = false;
    },
  };
}
function destination(options = {}) {
  const chunks = [];
  const target = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      options.write ? options.write(chunk, callback) : callback();
    },
    final(callback) {
      options.final ? options.final(callback) : callback();
    },
    destroy(error, callback) {
      options.destroy ? options.destroy(error, callback) : callback(error);
    },
  });
  return { target, chunks, bytes: () => Buffer.concat(chunks) };
}

test("upload preparation binds canonical identity without creating a target; verified stream commits once", async (t) => {
  const f = fixture(t),
    bytes = Buffer.from("first part\nsecond part\n");
  const plan = await f.plan({
    expectedSize: bytes.length,
    expectedSha256: sha(bytes),
    mimeType: "text/plain",
  });
  assert.equal(plan.path, path.join(f.work, "upload.bin"));
  assert.equal(existsSync(plan.path), false);
  assert.deepEqual(readdirSync(f.work), ["resources"]);
  const input = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]);
  f.scope.onProgress = (count) => f.events.push(count);
  const result = await receiveUpload(input, plan, f.scope, {
    contentLength: bytes.length,
  });
  assert.deepEqual(readFileSync(result.path), bytes);
  assert.equal(result.name, "upload.bin");
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, sha(bytes));
  assert.equal(result.mimeType, "text/plain");
  assert.match(result.revision, /^[0-9a-f]{64}$/);
  assert.equal(input.closed, true);
  assert.equal(f.events.at(-1), bytes.length);
  assert.equal(
    readdirSync(f.work).some((name) => name.startsWith(".nexum-upload_")),
    false,
  );
  await assert.rejects(
    prepareUpload({ path: "upload.bin" }, f.scope, { maxBytes: 1024 }),
    { code: "path_already_exists" },
  );
});

test("upload never overwrites a file, directory or symlink created after preparation", async (t) => {
  for (const kind of ["file", "directory", "link"]) {
    const f = fixture(t),
      plan = await f.plan();
    if (kind === "file") writeFileSync(plan.path, "keep");
    else if (kind === "directory") mkdirSync(plan.path);
    else {
      mkdirSync(path.join(f.root, "link-target"));
      symlinkSync(path.join(f.root, "link-target"), plan.path, "junction");
    }
    const input = Readable.from([Buffer.from("replace")]);
    const error = await receiveUpload(input, plan, f.scope).then(
      () => null,
      (cause) => cause,
    );
    assert.ok(error instanceof TransferIoError);
    assert.equal(error.code, "path_already_exists");
    assert.equal(error.fileCommitted, false);
    assert.equal(error.cleanupConfirmed, true);
    assert.equal(input.closed, true);
    if (kind === "file") assert.equal(readFileSync(plan.path, "utf8"), "keep");
  }
});

test("a target created during reception wins without being replaced at commit", async (t) => {
  const f = fixture(t),
    plan = await f.plan();
  f.scope.onProgress = () => {
    if (!existsSync(plan.path)) writeFileSync(plan.path, "concurrent owner");
  };
  const error = await receiveUpload(
    Readable.from([Buffer.from("incoming content")]),
    plan,
    f.scope,
  ).then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error.code, "path_already_exists");
  assert.equal(error.fileCommitted, false);
  assert.equal(error.cleanupConfirmed, true);
  assert.equal(readFileSync(plan.path, "utf8"), "concurrent owner");
});

test("an upload already linked at its bound target is retained when later authority fails", async (t) => {
  const f = fixture(t),
    bytes = Buffer.from("committed body"),
    plan = await f.plan();
  f.scope.authorize = () => {
    if (existsSync(plan.path))
      throw new AgentError("forbidden", "revoked after atomic commit");
  };
  const error = await receiveUpload(Readable.from([bytes]), plan, f.scope).then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error.code, "forbidden");
  assert.equal(error.fileCommitted, true);
  assert.equal(error.cleanupConfirmed, true);
  assert.equal(error.file.path, plan.path);
  assert.equal(error.file.sha256, sha(bytes));
  assert.deepEqual(readFileSync(plan.path), bytes);
  assert.equal(
    readdirSync(f.work).some((name) => name.startsWith(".nexum-upload_")),
    false,
  );
});

test("zero-byte uploads remain valid and actual stream budgets/size/hash are independently enforced", async (t) => {
  const zero = fixture(t),
    empty = await zero.plan({
      expectedSize: 0,
      expectedSha256: sha(Buffer.alloc(0)),
    });
  assert.equal(
    (
      await receiveUpload(Readable.from([]), empty, zero.scope, {
        contentLength: 0,
      })
    ).size,
    0,
  );
  for (const scenario of [
    "limit",
    "expected-size",
    "content-length",
    "checksum",
    "non-binary",
  ]) {
    const f = fixture(t),
      declarations =
        scenario === "expected-size"
          ? { expectedSize: 6 }
          : scenario === "checksum"
            ? { expectedSha256: "0".repeat(64) }
            : {};
    const plan = await f.plan(declarations, scenario === "limit" ? 4 : 1024);
    const input = Readable.from([
      scenario === "non-binary" ? "text chunk" : Buffer.from("12345"),
    ]);
    const error = await receiveUpload(
      input,
      plan,
      f.scope,
      scenario === "content-length" ? { contentLength: 4 } : {},
    ).then(
      () => null,
      (cause) => cause,
    );
    assert.equal(
      error.code,
      scenario === "limit"
        ? "resource_exhausted"
        : scenario === "checksum"
          ? "checksum_mismatch"
          : scenario === "non-binary"
            ? "invalid_transfer_chunk"
            : "transfer_size_mismatch",
    );
    assert.equal(error.fileCommitted, false);
    assert.equal(error.cleanupConfirmed, true);
    assert.equal(existsSync(plan.path), false);
    assert.deepEqual(readdirSync(f.work), ["resources"]);
  }
});

test("known invalid transfer declarations fail without accepting a body or temporary file", async (t) => {
  const f = fixture(t);
  for (const target of [
    { path: "x", expectedSize: -1 },
    { path: "x", expectedSize: 9 },
    { path: "x", expectedSha256: "INVALID" },
  ])
    await assert.rejects(prepareUpload(target, f.scope, { maxBytes: 8 }), {
      code:
        target.expectedSize === 9 ? "resource_exhausted" : "invalid_arguments",
    });
  const plan = await f.plan({ expectedSize: 4 }, 8);
  const input = Readable.from([Buffer.from("abcd")]);
  await assert.rejects(
    receiveUpload(input, plan, f.scope, { contentLength: 9 }),
    { code: "resource_exhausted" },
  );
  assert.equal(input.closed, true);
  assert.deepEqual(readdirSync(f.work), ["resources"]);
});

test("early upload refusal waits for the body stream's actual close callback", async (t) => {
  const f = fixture(t),
    plan = await f.plan({}, 4),
    closing = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const input = new Readable({
    read() {},
    destroy(error, callback) {
      entered.resolve();
      closing.promise.then(() => callback(error));
    },
  });
  let settled = false;
  const receiving = receiveUpload(input, plan, f.scope, { contentLength: 8 })
    .then(
      () => null,
      (cause) => cause,
    )
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  await delay(5);
  assert.equal(settled, false);
  closing.resolve();
  const error = await receiving;
  assert.equal(error.code, "resource_exhausted");
  assert.equal(input.closed, true);
  assert.equal(error.cleanupConfirmed, true);
});

test("upload cancellation and revocation stop actual writes and clean uncommitted content", async (t) => {
  for (const stop of ["cancel", "revoke", "timeout"]) {
    let f;
    f = fixture(t, {
      progress() {
        if (stop === "revoke") f.revoke();
        else
          f.controller.abort(
            stop === "timeout"
              ? new AgentError("transfer_timeout", "deadline")
              : undefined,
          );
      },
    });
    const plan = await f.plan();
    const error = await receiveUpload(
      Readable.from([Buffer.from("first"), Buffer.from("second")]),
      plan,
      f.scope,
    ).then(
      () => null,
      (cause) => cause,
    );
    assert.equal(
      error.code,
      stop === "revoke"
        ? "forbidden"
        : stop === "timeout"
          ? "transfer_timeout"
          : "transfer_cancelled",
    );
    assert.equal(error.fileCommitted, false);
    assert.equal(error.cleanupConfirmed, true);
    assert.deepEqual(readdirSync(f.work), ["resources"]);
  }
});

test("parent replacement is detected and an unlocatable temporary file is reported rather than deleted elsewhere", async (t) => {
  const f = fixture(t),
    parent = path.join(f.work, "incoming"),
    moved = path.join(f.work, "moved");
  mkdirSync(parent);
  const plan = await f.plan({ path: "incoming/upload.bin" });
  let replaced = false;
  f.scope.onProgress = () => {
    if (replaced) return;
    replaced = true;
    renameSync(parent, moved);
    mkdirSync(parent);
    writeFileSync(path.join(parent, "untouched"), "keep");
  };
  const error = await receiveUpload(
    Readable.from([Buffer.from("body")]),
    plan,
    f.scope,
  ).then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error.code, "file_changed");
  assert.equal(error.fileCommitted, false);
  assert.equal(error.cleanupConfirmed, false);
  assert.equal(readFileSync(path.join(parent, "untouched"), "utf8"), "keep");
  assert.equal(existsSync(plan.path), false);
  assert.equal(readdirSync(moved).length, 1);
});

test("already redirected parents fail before temporary creation; canonical write authorization is rechecked", async (t) => {
  const f = fixture(t),
    parent = path.join(f.work, "incoming"),
    outside = path.join(f.root, "outside");
  mkdirSync(parent);
  mkdirSync(outside);
  const plan = await f.plan({ path: "incoming/upload.bin" });
  renameSync(parent, parent + "-old");
  symlinkSync(outside, parent, "junction");
  await assert.rejects(
    receiveUpload(Readable.from([Buffer.from("body")]), plan, f.scope),
    { code: "file_changed" },
  );
  assert.deepEqual(readdirSync(outside), []);
  const restricted = {
    ...f.scope,
    authorize(target) {
      if (target.path && !target.path.startsWith(f.work + path.sep))
        throw new AgentError("path_not_allowed", "canonical escape");
    },
  };
  await assert.rejects(
    prepareUpload({ path: "incoming/other.bin" }, restricted, {
      maxBytes: 100,
    }),
    { code: "path_not_allowed" },
  );
});

test("downloads consume fixed artifact bytes, respect backpressure and wait for writable finalization", async (t) => {
  const f = fixture(t),
    bytes = Buffer.alloc(3 * 65536, 7),
    source = await f.source(bytes);
  const final = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const output = destination({
    final(callback) {
      entered.resolve();
      final.promise.then(() => callback());
    },
  });
  let ended = false;
  const sending = sendDownload(source, output.target, f.scope, {
    maxBytes: bytes.length,
  }).then((result) => {
    ended = true;
    return result;
  });
  await entered.promise;
  assert.equal(ended, false);
  final.resolve();
  const result = await sending;
  assert.deepEqual(output.bytes(), bytes);
  assert.deepEqual(result, {
    bytesTransferred: bytes.length,
    sha256: sha(bytes),
    outputFinished: true,
  });
  assert.equal(output.target.writableFinished, true);
  await source.closed;
});

test("a Duplex download destination need not close its independent readable side", async (t) => {
  const f = fixture(t),
    bytes = Buffer.from("duplex"),
    source = await f.source(bytes),
    chunks = [];
  const target = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  t.after(() => target.destroy());
  const result = await sendDownload(source, target, f.scope, { maxBytes: 100 });
  assert.equal(result.bytesTransferred, bytes.length);
  assert.equal(target.writableFinished, true);
  assert.equal(target.readableEnded, false);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test("destination failure while waiting for a source chunk cancels the source and waits for real closure", async (t) => {
  const f = fixture(t),
    actualClosed = Promise.withResolvers(),
    release = Promise.withResolvers(),
    started = Promise.withResolvers();
  let stopped = false;
  const stream = new Readable({
    read() {
      started.resolve();
    },
    destroy(error, callback) {
      stopped = true;
      release.promise.then(() => {
        callback(error);
        actualClosed.resolve();
      });
    },
  });
  const output = destination();
  const source = {
    resource: {
      uri: "nexum://agents/agent/resources/res_test",
      size: 10,
      sha256: sha(Buffer.alloc(10)),
    },
    stream,
    closed: actualClosed.promise,
  };
  let settled = false;
  const sending = sendDownload(source, output.target, f.scope, {
    maxBytes: 100,
  })
    .then(
      () => null,
      (error) => error,
    )
    .finally(() => {
      settled = true;
    });
  await started.promise;
  output.target.destroy(new Error("synthetic sink failure"));
  await delay(5);
  assert.equal(stopped, true);
  assert.equal(settled, false);
  release.resolve();
  assert.equal((await sending).code, "transfer_failed");
});

test("download limits and integrity errors never claim success and release fixed source handles", async (t) => {
  for (const scenario of [
    "size-preflight",
    "actual-size",
    "checksum",
    "sink",
    "revoked",
  ]) {
    const f = fixture(t),
      bytes = Buffer.alloc(3 * 65536, 2),
      real = await f.source(bytes);
    const source = {
      ...real,
      resource: {
        ...real.resource,
        ...(scenario === "actual-size" ? { size: 2 } : {}),
        ...(scenario === "checksum" ? { sha256: "0".repeat(64) } : {}),
      },
    };
    const output = destination(
      scenario === "sink"
        ? {
            write(_chunk, callback) {
              callback(new Error("sink"));
            },
          }
        : {},
    );
    if (scenario === "revoked") f.revoke();
    const error = await sendDownload(source, output.target, f.scope, {
      maxBytes: scenario === "size-preflight" ? 1 : bytes.length,
    }).then(
      () => null,
      (cause) => cause,
    );
    assert.equal(
      error.code,
      scenario === "revoked"
        ? "forbidden"
        : scenario === "checksum"
          ? "checksum_mismatch"
          : scenario === "sink"
            ? "transfer_failed"
            : "resource_exhausted",
    );
    await real.closed;
    assert.equal(real.stream.closed, true);
    assert.equal(output.target.closed, true);
  }
});

test("source closure failure remains explicit even when download bytes or destination also fail", async (t) => {
  const f = fixture(t),
    failed = Promise.reject(new Error("unconfirmed native close"));
  void failed.catch(() => {});
  const source = {
    resource: {
      uri: "nexum://agents/agent/resources/res_test",
      size: 3,
      sha256: sha(Buffer.from("abc")),
    },
    stream: Readable.from([Buffer.from("abc")]),
    closed: failed,
  };
  const output = destination({
    write(_chunk, callback) {
      callback(new Error("body failed"));
    },
  });
  const error = await sendDownload(source, output.target, f.scope, {
    maxBytes: 100,
  }).then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error.code, "transfer_cleanup_unconfirmed");
  assert.equal(error.details.cleanupConfirmed, false);
  assert.equal(error.details.originalCode, "transfer_failed");
  assert.ok(error.cause instanceof AggregateError);
  assert.equal(error.cause.errors.length, 2);
  assert.equal(output.target.closed, true);
});

test("a real HTTP byte destination receives the fixed artifact and returns its own acknowledgement", async (t) => {
  const f = fixture(t),
    bytes = Buffer.alloc(150000, 19),
    received = Promise.withResolvers();
  const server = createServer(async (input, response) => {
    try {
      const chunks = [];
      for await (const chunk of input) chunks.push(chunk);
      received.resolve(Buffer.concat(chunks));
      response.writeHead(204);
      response.end();
    } catch (error) {
      received.reject(error);
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const target = request({
    hostname: "127.0.0.1",
    port: server.address().port,
    method: "PUT",
    path: "/bytes",
    headers: { "Content-Length": bytes.length },
  });
  const acknowledged = new Promise((resolve, reject) => {
    target.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
      response.once("error", reject);
    });
    target.once("error", reject);
  });
  const result = await sendDownload(await f.source(bytes), target, f.scope, {
    maxBytes: bytes.length,
  });
  assert.equal(result.outputFinished, true);
  assert.equal(await acknowledged, 204);
  assert.deepEqual(await received.promise, bytes);
});
