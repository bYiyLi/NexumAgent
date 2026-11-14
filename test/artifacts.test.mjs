import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Blob, File } from "node:buffer";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  renameSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const { ArtifactStore, artifactUri, parseArtifactUri, snapshotBlob } =
  await import(
    process.env.NEXUM_ARTIFACT_MODULE ?? "../dist/results/artifacts.js"
  );
function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-artifacts-")),
  );
  mkdirSync(path.join(root, "work"));
  let now = 1800000000000;
  const store = new ArtifactStore(root, "agent /%一", {
    now: () => now,
    ...options,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = (
    ownerKey = "owner",
    authorize = () => {},
    controller = new AbortController(),
  ) => ({
    pwd: path.join(root, "work"),
    ownerKey,
    runId: "run_source",
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
    authorize,
  });
  const contentPath = (record) =>
    path.join(store.directory, record.resourceId, "content", "data");
  const metadataPath = (record) =>
    path.join(store.directory, record.resourceId, "resource.json");
  return {
    root,
    store,
    scope,
    contentPath,
    metadataPath,
    advance(ms) {
      now += ms;
    },
  };
}
const forbidden = () =>
  Object.assign(new Error("forbidden"), { code: "forbidden" });
async function collect(opened) {
  const chunks = [];
  try {
    for await (const chunk of opened.stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    opened.stream.destroy();
    await opened.closed;
  }
}

test("local resources are complete fixed snapshots with directory-backed identity across restart", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  const source = path.join(scope.pwd, "notes.txt");
  writeFileSync(source, "original content");
  const record = await f.store.register(
    { path: "notes.txt", mimeType: "text/plain; charset=UTF-8" },
    scope,
  );
  assert.equal(record.name, "notes.txt");
  assert.equal(record.size, 16);
  assert.equal(
    record.sha256,
    createHash("sha256").update("original content").digest("hex"),
  );
  assert.equal(record.originRunId, "run_source");
  assert.equal(
    record.expiresAt,
    new Date(Date.parse(record.createdAt) + 7 * 86400000).toISOString(),
  );
  assert.deepEqual(parseArtifactUri(record.uri), {
    agentId: "agent /%一",
    resourceId: record.resourceId,
  });
  assert.equal(readFileSync(source, "utf8"), "original content");
  assert.equal(readFileSync(f.contentPath(record), "utf8"), "original content");
  assert.doesNotMatch(
    JSON.stringify(record),
    /ownerKey|schemaVersion|\/work\/|\\work\\/,
  );
  const saved = JSON.parse(readFileSync(f.metadataPath(record), "utf8"));
  assert.equal(saved.ownerKey, "owner");
  assert.equal(saved.schemaVersion, 1);
  writeFileSync(source, "replacement");
  const restarted = new ArtifactStore(f.root, f.store.agentId, {
    now: () => Date.parse(record.createdAt) + 1000,
  });
  assert.deepEqual(await restarted.metadata(record.uri, scope), record);
  assert.deepEqual((await restarted.list(scope)).resources, [record]);
  assert.equal(
    (
      await restarted.read(record.uri, scope, { maxBytes: 100 })
    ).data.toString(),
    "original content",
  );
  assert.deepEqual(
    (await collect(await restarted.open(record.uri, scope))).toString(),
    "original content",
  );
});

test("native views are copied before await and keep only their actual byte ranges", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  const backing = Uint8Array.from([91, 1, 2, 3, 92]);
  const pending = f.store.register(
    { data: backing.subarray(1, 4), name: "view.bin" },
    scope,
  );
  backing.fill(9);
  const record = await pending;
  assert.deepEqual(
    (await f.store.read(record.uri, scope, { maxBytes: 5 })).data,
    Buffer.from([1, 2, 3]),
  );
  const view = new DataView(Uint8Array.from([44, 5, 6, 45]).buffer, 1, 2);
  const second = await f.store.register({ data: view }, scope);
  assert.deepEqual(
    (await f.store.read(second.uri, scope, { maxBytes: 2 })).data,
    Buffer.from([5, 6]),
  );
  const shared = new SharedArrayBuffer(4);
  new Uint8Array(shared).set([7, 8, 9, 10]);
  const third = await f.store.register(
    { data: new Uint8Array(shared, 1, 2) },
    scope,
  );
  new Uint8Array(shared).fill(0);
  assert.deepEqual(
    (await f.store.read(third.uri, scope, { maxBytes: 2 })).data,
    Buffer.from([8, 9]),
  );
  const empty = await f.store.register({ data: new ArrayBuffer(0) }, scope);
  assert.equal(
    (await f.store.read(empty.uri, scope, { maxBytes: 0 })).data.length,
    0,
  );
});

test("Blob/File use native data reads and preserve appropriate display metadata", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  class NativeFile extends File {
    stream() {
      throw new Error("custom stream must not be called");
    }
    get size() {
      throw new Error("custom size must not be called");
    }
    get type() {
      throw new Error("custom MIME must not be called");
    }
    get name() {
      throw new Error("custom name must not be called");
    }
  }
  const file = new NativeFile(["file bytes"], "report.txt", {
    type: "text/plain",
    lastModified: 1234567890,
  });
  assert.equal(snapshotBlob(file).lastModified, 1234567890);
  const record = await f.store.register({ data: file }, scope);
  assert.equal(record.name, "report.txt");
  assert.equal(record.mimeType, "text/plain");
  assert.equal(
    (await f.store.read(record.uri, scope, { maxBytes: 100 })).data.toString(),
    "file bytes",
  );
  const blob = await f.store.register(
    { data: new Blob(["blob bytes"]) },
    scope,
  );
  assert.equal(blob.name, "resource.bin");
  assert.equal(blob.mimeType, "application/octet-stream");
});

test("Blob branding and snapshots never execute forged Symbol, handle or File metadata hooks", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  const reference = new Blob(["native bytes"], { type: "text/plain" });
  const fields = Object.getOwnPropertyDescriptors(reference);
  const symbols = Object.getOwnPropertySymbols(reference);
  const handleKey = symbols.find((key) => key.description === "kHandle");
  const nativeHandle = fields[handleKey].value;
  let calls = 0;
  const forgedSymbols = Object.create(Blob.prototype);
  for (const key of symbols)
    Object.defineProperty(forgedSymbols, key, {
      get() {
        calls++;
        return fields[key].value;
      },
    });
  await assert.rejects(f.store.register({ data: forgedSymbols }, scope), {
    code: "invalid_artifact_source",
  });
  assert.equal(calls, 0);
  const forged = (handle) => {
    const value = Object.create(Blob.prototype);
    for (const key of symbols)
      Object.defineProperty(value, key, {
        value: key === handleKey ? handle : fields[key].value,
      });
    return value;
  };
  for (const method of ["getReader", "slice"]) {
    const handle = Object.create(Object.getPrototypeOf(nativeHandle));
    Object.defineProperty(handle, method, {
      value() {
        calls++;
        throw new Error("custom native method");
      },
    });
    await assert.rejects(f.store.register({ data: forged(handle) }, scope), {
      code: "invalid_artifact_source",
    });
    assert.equal(calls, 0);
  }
  const proxyHandle = new Proxy(nativeHandle, {
    getPrototypeOf() {
      calls++;
      throw new Error();
    },
    ownKeys() {
      calls++;
      throw new Error();
    },
  });
  await assert.rejects(f.store.register({ data: forged(proxyHandle) }, scope), {
    code: "invalid_artifact_source",
  });
  assert.equal(calls, 0);
  // A JS lookalike with the exact native prototype still fails V8's receiver signature.
  await assert.rejects(
    f.store.register(
      { data: forged(Object.create(Object.getPrototypeOf(nativeHandle))) },
      scope,
    ),
    { code: "invalid_artifact_source" },
  );
  const file = new File(["file"], "real.txt", { type: "text/plain" });
  const stateKey = Object.getOwnPropertySymbols(file).find(
    (key) => !symbols.includes(key),
  );
  const state = Object.getOwnPropertyDescriptor(file, stateKey).value;
  const forgedState = Object.create(File.prototype);
  for (const key of symbols)
    Object.defineProperty(forgedState, key, { value: fields[key].value });
  Object.defineProperty(forgedState, stateKey, {
    get() {
      calls++;
      return state;
    },
  });
  await assert.rejects(f.store.register({ data: forgedState }, scope), {
    code: "invalid_artifact_source",
  });
  assert.equal(calls, 0);
  Object.defineProperty(state, "name", {
    get() {
      calls++;
      throw new Error("fake File metadata");
    },
  });
  await assert.rejects(f.store.register({ data: file }, scope), {
    code: "invalid_artifact_source",
  });
  assert.equal(calls, 0);
  const forgedLength = new Blob(["larger than its declared size"]);
  const lengthKey = symbols.find((key) => key.description === "kLength");
  Object.defineProperty(forgedLength, lengthKey, { value: 1 });
  let inspected = 0;
  await assert.rejects(
    f.store.register(
      { data: forgedLength },
      scope,
      async () => {
        inspected++;
        return {};
      },
      { maxBytes: 4 },
    ),
    { code: "resource_too_large" },
  );
  assert.equal(inspected, 0);
  assert.deepEqual(readdirSync(f.store.directory), []);
  Object.defineProperty(reference, "extra", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("no structuredClone of user object");
    },
  });
  Object.defineProperty(reference, "stream", {
    get() {
      calls++;
      throw new Error("no user stream");
    },
  });
  const snapshot = snapshotBlob(reference, 100);
  assert.equal(snapshot.size, 12);
  assert.equal(snapshot.mimeType, "text/plain");
  assert.notEqual(snapshot.blob, reference);
  const copied = await f.store.register({ data: reference }, scope);
  assert.equal(
    (await f.store.read(copied.uri, scope, { maxBytes: 100 })).data.toString(),
    "native bytes",
  );
  assert.equal(calls, 0);
  assert.equal(snapshotBlob({ ordinary: true }), null);
  assert.deepEqual(readdirSync(f.store.directory), [copied.resourceId]);
});

test("trusted inspection validates the fixed pending bytes before any resource publication", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  let inspection = 0;
  await assert.rejects(
    f.store.register(
      { data: Buffer.from("invalid media") },
      scope,
      async (fixed) => {
        inspection++;
        assert.equal(fixed.size, 13);
        assert.equal(readFileSync(fixed.path, "utf8"), "invalid media");
        assert.deepEqual((await f.store.list(scope)).resources, []);
        throw new Error("invalid media bytes");
      },
    ),
    { code: "resource_registration_failed" },
  );
  assert.equal(inspection, 1);
  assert.deepEqual(readdirSync(f.store.directory), []);
  const record = await f.store.register(
    { data: Buffer.from("validated content"), name: "image.bin" },
    scope,
    async (fixed) => {
      assert.equal(fixed.mimeType, "application/octet-stream");
      assert.equal(fixed.name, "image.bin");
      assert.equal(readFileSync(fixed.path, "utf8"), "validated content");
      return { mimeType: "image/png" };
    },
  );
  assert.equal(record.mimeType, "image/png");
  assert.equal(
    (await f.store.metadata(record.uri, scope)).mimeType,
    "image/png",
  );
  await assert.rejects(
    f.store.register({ data: Buffer.from("bytes") }, scope, async (fixed) => {
      writeFileSync(fixed.path, "other");
      return { mimeType: "image/png" };
    }),
    { code: "resource_preparation_changed" },
  );
  assert.deepEqual((await f.store.list(scope)).resources, [record]);
});

test("source, file and read budgets fail before publishing a partial resource", async (t) => {
  const f = fixture(t, { maxFileBytes: 8, maxReadBytes: 4 }),
    scope = f.scope();
  await assert.rejects(f.store.register({ data: Buffer.alloc(9) }, scope), {
    code: "resource_too_large",
  });
  writeFileSync(path.join(scope.pwd, "large"), Buffer.alloc(9));
  await assert.rejects(f.store.register({ path: "large" }, scope), {
    code: "resource_too_large",
  });
  await assert.rejects(f.store.register({ path: "." }, scope), {
    code: "invalid_artifact_source",
  });
  assert.deepEqual(readdirSync(f.store.directory), []);
  const record = await f.store.register({ data: Buffer.alloc(6) }, scope);
  await assert.rejects(f.store.read(record.uri, scope, { maxBytes: 8 }), {
    code: "invalid_resource_budget",
  });
  await assert.rejects(f.store.read(record.uri, scope, { maxBytes: 4 }), {
    code: "resource_read_too_large",
  });
  assert.equal(
    (await collect(await f.store.open(record.uri, scope))).length,
    6,
  );
  let hooks = 0;
  await assert.rejects(
    f.store.register(
      {
        get data() {
          hooks++;
          return Buffer.alloc(1);
        },
      },
      scope,
    ),
    { code: "invalid_artifact_source" },
  );
  await assert.rejects(
    f.store.register(
      new Proxy(
        {},
        {
          ownKeys() {
            hooks++;
            throw new Error();
          },
        },
      ),
      scope,
    ),
    { code: "invalid_artifact_source" },
  );
  await assert.rejects(
    f.store.register({ data: Buffer.alloc(1), path: "large" }, scope),
    { code: "invalid_artifact_source" },
  );
  assert.equal(hooks, 0);
});

test("trusted lower registration budgets reject known sizes before copying or inspection and bound actual source growth", async (t) => {
  const f = fixture(t, { maxFileBytes: 32 }),
    scope = f.scope();
  let inspected = 0;
  const inspect = async () => {
    inspected++;
    return {};
  };
  const filename = path.join(scope.pwd, "lower-cap.bin");
  writeFileSync(filename, Buffer.alloc(9));
  for (const source of [
    { path: filename },
    { data: Buffer.alloc(9) },
    { data: new Blob([Buffer.alloc(9)]) },
  ]) {
    await assert.rejects(
      f.store.register(source, scope, inspect, { maxBytes: 8 }),
      { code: "resource_too_large" },
    );
    assert.equal(inspected, 0);
    assert.deepEqual(readdirSync(f.store.directory), []);
  }
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, 33, null])
    await assert.rejects(
      f.store.register({ data: Buffer.from([1]) }, scope, inspect, {
        maxBytes,
      }),
      { code: "invalid_resource_budget" },
    );
  await assert.rejects(
    f.store.register(
      { data: Buffer.from([1]), maxBytes: 1000 },
      scope,
      inspect,
    ),
    { code: "invalid_artifact_source" },
  );
  assert.equal(inspected, 0);
  assert.deepEqual(readdirSync(f.store.directory), []);
  writeFileSync(filename, Buffer.alloc(4));
  let grew = false;
  const growing = f.scope("owner", (target) => {
    if (
      !grew &&
      target.action === "register" &&
      target.path === filename &&
      readdirSync(f.store.directory).some((name) =>
        name.startsWith(".pending-"),
      )
    ) {
      grew = true;
      writeFileSync(filename, Buffer.alloc(12));
    }
  });
  await assert.rejects(
    f.store.register({ path: filename }, growing, inspect, { maxBytes: 8 }),
    { code: "resource_too_large" },
  );
  assert.equal(grew, true);
  assert.equal(inspected, 0);
  assert.deepEqual(readdirSync(f.store.directory), []);
  const accepted = await f.store.register(
    { data: Buffer.from([1, 2]) },
    scope,
    inspect,
    { maxBytes: 2 },
  );
  assert.equal(accepted.size, 2);
  assert.equal(inspected, 1);
  const defaultPolicy = await f.store.register(
    { data: Buffer.alloc(16) },
    scope,
  );
  assert.equal(defaultPolicy.size, 16);
});

test("directory-backed lists paginate only current authorized resources and bind caller cursors", async (t) => {
  const f = fixture(t),
    records = [];
  for (let index = 0; index < 4; index++)
    records.push(
      await f.store.register(
        { data: Buffer.from([index]) },
        f.scope(index === 1 ? "other" : "owner"),
      ),
    );
  const scope = f.scope("owner", (target) => {
    if (target.resource && target.resource.ownerKey !== "owner")
      throw forbidden();
  });
  const found = [];
  let page = await f.store.list(scope, { limit: 1 });
  assert.ok(page.nextCursor);
  await assert.rejects(
    f.store.list(f.scope("other"), { limit: 1, cursor: page.nextCursor }),
    { code: "invalid_cursor" },
  );
  while (true) {
    found.push(...page.resources);
    if (!page.nextCursor) break;
    page = await f.store.list(scope, { limit: 1, cursor: page.nextCursor });
  }
  assert.equal(found.length, 3);
  assert.deepEqual(
    found.map((item) => item.resourceId),
    [...found]
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
      .map((item) => item.resourceId),
  );
  assert.equal(new Set(found.map((item) => item.resourceId)).size, 3);
  assert.doesNotMatch(JSON.stringify(found), /ownerKey|schemaVersion/);
  await assert.rejects(f.store.list(f.scope("owner", () => false)), {
    code: "authorization_configuration",
  });
  await assert.rejects(
    f.store.list(
      f.scope("owner", (target) => {
        if (target.resource) throw new Error("policy engine failed");
      }),
    ),
    { code: "authorization_failed" },
  );
});

test("revoked registration cleans the uncommitted directory and source changes are never published", async (t) => {
  const f = fixture(t),
    bytes = Buffer.alloc(3 * 65536, 1);
  let checks = 0;
  const scope = f.scope("owner", (target) => {
    if (target.action === "register" && ++checks === 4) throw forbidden();
  });
  await assert.rejects(f.store.register({ data: bytes }, scope), {
    code: "forbidden",
  });
  assert.deepEqual(readdirSync(f.store.directory), []);
  const source = path.join(scope.pwd, "changing.bin");
  writeFileSync(source, bytes);
  let changed = false;
  const changing = f.scope("owner", (target) => {
    if (
      !changed &&
      target.action === "register" &&
      target.path === source &&
      readdirSync(f.store.directory).some((name) =>
        name.startsWith(".pending-"),
      )
    ) {
      changed = true;
      writeFileSync(source, Buffer.alloc(bytes.length, 2));
    }
  });
  await assert.rejects(f.store.register({ path: source }, changing), {
    code: "resource_source_changed",
  });
  assert.equal(changed, true);
  assert.deepEqual(readdirSync(f.store.directory), []);
});

test("missing, expired and altered history stays unavailable without reading a changed source", async (t) => {
  const f = fixture(t, { retentionMs: 100 }),
    scope = f.scope();
  const source = path.join(scope.pwd, "source.txt");
  writeFileSync(source, "history");
  const missing = await f.store.register({ path: source }, scope);
  unlinkSync(f.contentPath(missing));
  writeFileSync(source, "current");
  await assert.rejects(f.store.read(missing.uri, scope, { maxBytes: 100 }), {
    code: "resource_unavailable",
  });
  assert.deepEqual((await f.store.list(scope)).resources, []);
  const altered = await f.store.register({ data: Buffer.from("fixed") }, scope);
  writeFileSync(f.contentPath(altered), "other");
  await assert.rejects(collect(await f.store.open(altered.uri, scope)), {
    code: "resource_changed",
  });
  const expired = await f.store.register(
    { data: Buffer.from("retained") },
    scope,
  );
  const active = await f.store.open(expired.uri, scope);
  f.advance(101);
  assert.equal((await collect(active)).toString(), "retained");
  await assert.rejects(f.store.metadata(expired.uri, scope), {
    code: "resource_expired",
  });
  assert.deepEqual((await f.store.list(scope)).resources, []);
});

test("stream cancellation and permission revocation retain actual closure evidence", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  const record = await f.store.register(
    { data: Buffer.alloc(4 * 65536, 1) },
    scope,
  );
  const early = await f.store.open(record.uri, scope);
  early.stream.destroy();
  await early.closed;
  assert.equal(early.stream.closed, true);
  const controller = new AbortController(),
    aborted = await f.store.open(
      record.uri,
      f.scope("owner", () => {}, controller),
    );
  controller.abort();
  await assert.rejects(collect(aborted), { code: "resource_read_cancelled" });
  await aborted.closed;
  let allowed = true;
  const reading = await f.store.open(
    record.uri,
    f.scope("owner", () => {
      if (!allowed) throw forbidden();
    }),
  );
  const consume = async () => {
    try {
      for await (const _chunk of reading.stream) allowed = false;
    } finally {
      reading.stream.destroy();
      await reading.closed;
    }
  };
  await assert.rejects(consume(), { code: "forbidden" });
});

test("private registration fields cannot escape through metadata and URI parsing is strict", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  const record = await f.store.register({ data: Buffer.from([1]) }, scope);
  const metadata = JSON.parse(readFileSync(f.metadataPath(record), "utf8"));
  metadata.path = "/private/source";
  metadata.token = "synthetic-sensitive-token";
  writeFileSync(f.metadataPath(record), JSON.stringify(metadata));
  assert.deepEqual(await f.store.metadata(record.uri, scope), record);
  assert.doesNotMatch(
    JSON.stringify(await f.store.list(scope)),
    /private\/source|synthetic-sensitive-token/,
  );
  for (const uri of [
    record.uri + "?x=1",
    record.uri + "#fragment",
    record.uri.replace("nexum:", "file:"),
    record.uri.replace("%2F", "%2f"),
    record.uri.replace("/resources/", "/resources/../resources/"),
  ])
    await assert.rejects(f.store.metadata(uri, scope), {
      code: "invalid_resource_uri",
    });
  await assert.rejects(
    f.store.metadata(artifactUri("another-agent", record.resourceId), scope),
    { code: "resource_agent_mismatch" },
  );
});

test("non-regular files, catalog redirects and pending redirects cannot become published resources", async (t) => {
  const f = fixture(t),
    scope = f.scope();
  if (process.platform !== "win32") {
    const fifo = path.join(scope.pwd, "fifo");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    await assert.rejects(f.store.register({ path: fifo }, scope), {
      code: "invalid_artifact_source",
    });
    const badMetadata = await f.store.register(
      { data: Buffer.from("metadata") },
      scope,
    );
    unlinkSync(f.metadataPath(badMetadata));
    assert.equal(spawnSync("mkfifo", [f.metadataPath(badMetadata)]).status, 0);
    await assert.rejects(f.store.metadata(badMetadata.uri, scope), {
      code: "invalid_resource_metadata",
    });
    rmSync(path.join(f.store.directory, badMetadata.resourceId), {
      recursive: true,
    });
    const badContent = await f.store.register(
      { data: Buffer.from("content") },
      scope,
    );
    unlinkSync(f.contentPath(badContent));
    assert.equal(spawnSync("mkfifo", [f.contentPath(badContent)]).status, 0);
    await assert.rejects(f.store.metadata(badContent.uri, scope), {
      code: "resource_changed",
    });
    rmSync(path.join(f.store.directory, badContent.resourceId), {
      recursive: true,
    });
  }
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "untouched"), "keep");
  const escape = path.join(scope.pwd, "escape");
  symlinkSync(outside, escape, "junction");
  const restricted = f.scope("owner", (target) => {
    if (target.path && !target.path.startsWith(scope.pwd + path.sep))
      throw Object.assign(new Error("denied canonical path"), {
        code: "path_not_allowed",
      });
  });
  await assert.rejects(
    f.store.register({ path: path.join(escape, "untouched") }, restricted),
    { code: "path_not_allowed" },
  );
  let redirected = false;
  const redirect = f.scope("owner", (target) => {
    if (!redirected && target.action === "register" && target.resource) {
      redirected = true;
      const pending = path.join(
        f.store.directory,
        readdirSync(f.store.directory).find((name) =>
          name.startsWith(".pending-"),
        ),
      );
      renameSync(
        path.join(pending, "content"),
        path.join(pending, "old-content"),
      );
      symlinkSync(outside, path.join(pending, "content"), "junction");
    }
  });
  await assert.rejects(
    f.store.register({ data: Buffer.from("bytes") }, redirect),
    { code: "storage_path_escape" },
  );
  assert.equal(redirected, true);
  assert.deepEqual(readdirSync(outside), ["untouched"]);
  assert.deepEqual(readdirSync(f.store.directory), []);
  let replaced = false;
  const replaceDirectory = f.scope("owner", (target) => {
    if (!replaced && target.action === "register" && target.resource) {
      replaced = true;
      const pending = path.join(
        f.store.directory,
        readdirSync(f.store.directory).find((name) =>
          name.startsWith(".pending-"),
        ),
      );
      renameSync(
        path.join(pending, "content"),
        path.join(pending, "original-content"),
      );
      mkdirSync(path.join(pending, "content"));
    }
  });
  await assert.rejects(
    f.store.register({ data: Buffer.from("bytes") }, replaceDirectory),
    { code: "resource_preparation_changed" },
  );
  assert.equal(replaced, true);
  assert.deepEqual(readdirSync(f.store.directory), []);
  const record = await f.store.register({ data: Buffer.from("valid") }, scope);
  const saved = f.store.directory + "-saved";
  renameSync(f.store.directory, saved);
  symlinkSync(outside, f.store.directory, "junction");
  await assert.rejects(f.store.metadata(record.uri, scope), {
    code: "storage_path_escape",
  });
  assert.equal(readFileSync(path.join(outside, "untouched"), "utf8"), "keep");
  assert.equal(existsSync(path.join(outside, "resource.json")), false);
});
