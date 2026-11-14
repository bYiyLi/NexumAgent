import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";

// These are local component integrations. They do not assert Cloud transport or
// a real AI Host's rendering/download acceptance.
const dist = new URL(
  process.env.NEXUM_ENCODER_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { ResultEncoder },
  { ArtifactStore },
  { createOutput },
  { SqliteStore },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { ResourceManager },
  { ExtensionRegistry },
  { AgentError },
] = await Promise.all(
  [
    "results/encoder.js",
    "results/artifacts.js",
    "sdk/output.js",
    "storage/sqlite.js",
    "runtime/modules.js",
    "runtime/scripts.js",
    "runtime/engine.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "contracts/errors.js",
  ].map((file) => import(new URL(file, dist))),
);

const KiB = 1024;
const MiB = 1024 * KiB;
const caller = { principalId: "user", clientId: "encoder", host: "local-test" };
const run = { runId: "run_fixture", status: "succeeded" };
function png(colour = 80) {
  const chunk = (type, bytes) => {
    const name = Buffer.from(type),
      value = Buffer.alloc(12 + bytes.length);
    value.writeUInt32BE(bytes.length);
    name.copy(value, 4);
    bytes.copy(value, 8);
    value.writeUInt32BE(crc32(Buffer.concat([name, bytes])), 8 + bytes.length);
    return value;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, colour, 100, 120, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function wav(samples = 40) {
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  return data;
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-encoder-")),
  );
  const work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  let now = 1800000000000,
    allowed = true;
  const accesses = [];
  const artifacts = new ArtifactStore(root, "agent", {
    now: () => now,
    ...options.artifacts,
  });
  const encoder = new ResultEncoder(artifacts, options.limits);
  const scope = (services) => ({
    pwd: work,
    ownerKey: callerKey(caller),
    runId: services?.runId ?? run.runId,
    ...(services ? { signal: services.signal } : {}),
    assertCurrent() {
      services?.assertCurrent();
    },
    authorize(target) {
      accesses.push(target);
      if (
        !allowed ||
        (target.resource && target.resource.ownerKey !== callerKey(caller))
      )
        throw new AgentError(
          "forbidden",
          "Current resource access was revoked.",
        );
      options.authorize?.(target);
    },
  });
  const output = createOutput(work, () => {});
  let store, registry, handle, engine, context;
  if (options.runtime) {
    store = new SqliteStore(root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    });
    const resources = new ResourceManager(store, { cleanupTimeoutMs: 20 });
    registry = new ExtensionRegistry(resources, {
      cleanupTimeoutMs: 20,
      permissions: new Set(["read"]),
      authorize() {},
      log() {},
      progress() {},
    });
    const scripts = new ScriptCatalog(work, "agent", () => []);
    const loader = await ModuleLoader.create(work, store.bootId, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    });
    writeFileSync(path.join(work, "snapshot.json"), '{"project":null}');
    context = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "work/snapshot.json",
    });
    engine = new RunEngine(store, loader, scripts, {
      authorize(who, target) {
        if (target.run && target.run.callerKey !== callerKey(who))
          throw new AgentError("forbidden", "Wrong caller.");
      },
      loadWork: (item) =>
        JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
      encodeResult: (value, services) => encoder.encode(value, scope(services)),
      bindings: (services) => ({
        ...registry.bindings(services),
        output: createOutput(work, () => services.assertCurrent()),
      }),
      resources,
    });
  }
  t.after(async () => {
    if (handle) await registry.disable(handle);
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    artifacts,
    encoder,
    scope,
    output,
    accesses,
    store,
    engine,
    source(name, data) {
      const file = path.join(work, name);
      writeFileSync(file, data);
      return file;
    },
    contentPath(record) {
      return path.join(
        artifacts.directory,
        record.resourceId,
        "content",
        "data",
      );
    },
    revoke() {
      allowed = false;
    },
    grant() {
      allowed = true;
    },
    advance(ms) {
      now += ms;
    },
    async extension(methods) {
      handle = await registry.prepare(
        {
          apiVersion: 1,
          origin: {
            type: "extension",
            owner: "@test/encoder",
            namespace: "demo",
            version: "1",
            revision: "one",
          },
          permissions: ["read"],
          config: {},
        },
        () => ({
          methods: Object.fromEntries(
            Object.entries(methods).map(([name, value]) => [
              name,
              {
                description: "结果集成测试",
                permissions: ["read"],
                schemaDialect: "draft7",
                inputSchema: { type: "object" },
                ...(typeof value === "function" ? { handle: value } : value),
              },
            ]),
          ),
        }),
      );
      registry.publish(handle);
    },
    start(script) {
      return engine.start(caller, {
        contextId: context.contextId,
        script,
        waitMs: 3000,
      });
    },
  };
}
function savedJSON(value) {
  return JSON.parse(JSON.stringify(value));
}
function onlyMedia(response, type) {
  return response.content.filter((item) => item.type === type);
}

test("automatic and explicit images share validated fixed bytes and actual MCP image rendering", async (t) => {
  const f = await fixture(t),
    bytes = png();
  f.source("chart.png", bytes);
  for (const value of [
    { type: "image", path: "chart.png" },
    f.output.image("chart.png"),
  ]) {
    const saved = await f.encoder.encode(value, f.scope());
    assert.equal(saved.content[0].type, "image");
    assert.equal(saved.content[0].mimeType, "image/png");
    assert.equal(
      saved.content[0].resource.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(Object.hasOwn(saved.content[0], "data"), false);
    assert.doesNotMatch(
      JSON.stringify(saved),
      new RegExp(bytes.toString("base64")),
    );
    const rendered = await f.encoder.render(savedJSON(saved), f.scope(), run);
    assert.deepEqual(
      Buffer.from(onlyMedia(rendered, "image")[0].data, "base64"),
      bytes,
    );
    assert.equal(rendered.structuredContent.run.status, "succeeded");
  }
  assert.ok(
    f.accesses.some(
      (item) =>
        item.action === "register" &&
        item.path === path.join(f.work, "chart.png"),
    ),
  );
});

test("all five content types and mixed structured data retain their standard content semantics", async (t) => {
  const f = await fixture(t),
    image = png(),
    audio = wav(),
    binary = Buffer.from([0, 1, 2, 255]);
  f.source("notes.md", "# fixed notes");
  const saved = await f.encoder.encode(
    f.output.result({
      content: [
        f.output.text("done", {
          annotations: { audience: ["assistant"], priority: 0.8 },
        }),
        f.output.images([{ data: image }]),
        f.output.audio({ data: audio }),
        f.output.file({ data: binary, name: "report.bin" }),
        f.output.resource("notes.md"),
      ],
      structuredContent: { total: 2, items: ["one", "two"] },
    }),
    f.scope(),
  );
  assert.deepEqual(
    saved.content.map((item) => item.type),
    ["text", "image", "audio", "resource_link", "resource"],
  );
  const rendered = await f.encoder.render(savedJSON(saved), f.scope(), run);
  assert.deepEqual(rendered.structuredContent.data, {
    total: 2,
    items: ["one", "two"],
  });
  assert.deepEqual(rendered.content[0].annotations, {
    audience: ["assistant"],
    priority: 0.8,
  });
  assert.deepEqual(Buffer.from(rendered.content[1].data, "base64"), image);
  assert.equal(rendered.content[2].mimeType, "audio/wav");
  assert.deepEqual(Buffer.from(rendered.content[2].data, "base64"), audio);
  const link = rendered.content[3];
  assert.equal(link.name, "report.bin");
  assert.match(link.uri, /^nexum:\/\/agents\/agent\/resources\/res_/);
  assert.deepEqual(
    (await f.artifacts.read(link.uri, f.scope(), { maxBytes: binary.length }))
      .data,
    binary,
  );
  assert.equal(rendered.content[4].resource.text, "# fixed notes");
  assert.equal(rendered.content[4].resource.mimeType, "text/markdown");
});

test("standard encoded image/audio and embedded binary resources are fixed, with no saved base64 payloads", async (t) => {
  const f = await fixture(t),
    image = png(),
    audio = wav(),
    blob = Buffer.from("embedded binary");
  const saved = await f.encoder.encode(
    [
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      { type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" },
      {
        type: "resource",
        resource: {
          uri: "remote://original",
          mimeType: "application/octet-stream",
          blob: blob.toString("base64"),
        },
      },
    ],
    f.scope(),
  );
  for (const bytes of [image, audio, blob])
    assert.equal(
      JSON.stringify(saved).includes(bytes.toString("base64")),
      false,
    );
  const rendered = await f.encoder.render(savedJSON(saved), f.scope(), run);
  assert.deepEqual(Buffer.from(rendered.content[0].data, "base64"), image);
  assert.deepEqual(Buffer.from(rendered.content[1].data, "base64"), audio);
  assert.deepEqual(
    Buffer.from(rendered.content[2].resource.blob, "base64"),
    blob,
  );
  assert.notEqual(rendered.content[2].resource.uri, "remote://original");
});

test("nested binary keeps structure and content associations and snapshots only its actual subview", async (t) => {
  const f = await fixture(t),
    backing = Uint8Array.from([91, 10, 20, 30, 92]);
  const view = new DataView(backing.buffer, 1, 3);
  const saved = await f.encoder.encode(
    {
      title: "binary",
      items: [{ bytes: view }, { image: { type: "image", data: png() } }],
    },
    f.scope(),
  );
  backing.fill(255);
  assert.equal(saved.data.title, "binary");
  assert.equal(saved.data.items.length, 2);
  const ref = saved.data.items[0].bytes;
  assert.equal(ref.contentIndex, 0);
  assert.equal(ref.uri, saved.content[0].resource.uri);
  assert.equal(ref.size, 3);
  assert.deepEqual(
    (await f.artifacts.read(ref.uri, f.scope(), { maxBytes: 3 })).data,
    Buffer.from([10, 20, 30]),
  );
  assert.equal(saved.data.items[1].image.contentIndex, 1);
  assert.equal(saved.content[1].type, "image");
  assert.ok(saved.conversions.some((item) => item.path === "$.items[0].bytes"));
  assert.doesNotMatch(JSON.stringify(saved), /91,10,20,30,92/);
});

test("explicit pure data preserves media-looking objects and refuses embedded binary with a useful field location", async (t) => {
  const f = await fixture(t),
    business = [{ type: "image", path: "not-a-file.png" }, { id: 2n }];
  const saved = await f.encoder.encode(f.output.json(business), f.scope());
  assert.deepEqual(saved.content, []);
  assert.deepEqual(savedJSON(saved.data), [
    { type: "image", path: "not-a-file.png" },
    { id: "2" },
  ]);
  assert.equal((await f.artifacts.list(f.scope())).resources.length, 0);
  await assert.rejects(
    () =>
      f.encoder.encode(
        f.output.result({
          content: [],
          structuredContent: { rows: [{ bytes: Buffer.from([1]) }] },
        }),
        f.scope(),
      ),
    (error) =>
      error.code === "invalid_result_data" &&
      error.details?.path === "$.rows[0].bytes",
  );
});

test("text and JSON beyond 64 KiB become real readable resources with explicit incomplete delivery", async (t) => {
  const f = await fixture(t),
    large = "正文".repeat(16000);
  assert.ok(Buffer.byteLength(large) > 64 * KiB);
  const data = { title: "full", body: large, count: 3n };
  for (const [value, kind] of [
    [f.output.json(data), "dataResource"],
    [large, "textResource"],
  ]) {
    const saved = await f.encoder.encode(value, f.scope());
    assert.equal(saved.delivery.complete, false);
    assert.equal(saved.delivery.reason, "context_budget");
    const resource = saved.delivery[kind];
    assert.ok(resource.uri);
    const full = JSON.parse(
      (
        await f.artifacts.read(resource.uri, f.scope(), { maxBytes: 1 * MiB })
      ).data.toString("utf8"),
    );
    if (kind === "dataResource") {
      assert.equal(Object.hasOwn(saved, "data"), false);
      assert.deepEqual(full.data, { title: "full", body: large, count: "3" });
      assert.ok(full.conversions.some((item) => item.from === "BigInt"));
    } else assert.equal(full[0].item.text, large);
    const rendered = await f.encoder.render(savedJSON(saved), f.scope(), run);
    assert.equal(rendered.structuredContent.delivery.complete, false);
    assert.ok(
      rendered.content.some(
        (item) => item.type === "resource_link" && item.uri === resource.uri,
      ),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(rendered)) <= 64 * KiB);
    assert.equal(JSON.stringify(rendered).includes(large), false);
  }
});

test("registered extension results run through the real engine encoder while business isError preserves successful lifecycle", async (t) => {
  const f = await fixture(t, { runtime: true }),
    image = png();
  await f.extension({
    image: (_input, call) =>
      call.output.image({ data: image, mimeType: "image/png" }),
    business: {
      outputSchema: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
      handle: (_input, call) =>
        call.output.error("item not found", {
          structuredContent: { code: "not_found", run: { status: "failed" } },
        }),
    },
    invalid: (_input, call) =>
      call.output.image({
        data: Buffer.from("not a real image"),
        mimeType: "image/png",
      }),
  });
  const ok = await f.start("return await demo.image({});");
  assert.equal(ok.run.status, "succeeded");
  assert.equal(ok.operations.items[0].status, "succeeded");
  const disk = readFileSync(path.join(f.root, ok.run.resultRef), "utf8");
  assert.deepEqual(JSON.parse(disk), ok.result);
  assert.equal(disk.includes(image.toString("base64")), false);
  assert.deepEqual(
    Buffer.from(
      (await f.encoder.render(ok.result, f.scope(), ok.run)).content[0].data,
      "base64",
    ),
    image,
  );
  const business = await f.start("return demo.business({});");
  assert.equal(business.run.status, "succeeded");
  assert.equal(business.result.isError, true);
  assert.equal(business.run.error, null);
  const response = await f.encoder.render(
    business.result,
    f.scope(),
    business.run,
  );
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.run.status, "succeeded");
  assert.equal(response.structuredContent.data.run.status, "failed");
  const history = await f.engine.observe(caller, business.run.runId);
  assert.equal(history.run.status, "succeeded");
  assert.equal(history.result.isError, true);
  const failed = await f.start("return demo.invalid({});");
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.error.phase, "result");
  assert.equal(failed.run.error.code, "unsupported_media_format");
  assert.equal(failed.result, null);
});

test("historical results retain original image snapshots and recheck current resource permissions", async (t) => {
  const f = await fixture(t, { runtime: true }),
    original = png(80),
    replacement = png(180);
  const source = f.source("history.png", original);
  const first = await f.start('return output.image("history.png");');
  assert.equal(first.run.status, "succeeded");
  writeFileSync(source, replacement);
  const historical = await f.engine.observe(caller, first.run.runId);
  const saved = savedJSON(historical.result);
  const uri = saved.content[0].resource.uri;
  const resourceBody = await f.encoder.readResource(uri, f.scope());
  assert.deepEqual(
    Buffer.from(resourceBody.contents[0].blob, "base64"),
    original,
  );
  assert.deepEqual(
    Buffer.from(
      (await f.encoder.render(saved, f.scope(), historical.run)).content[0]
        .data,
      "base64",
    ),
    original,
  );
  const restarted = new ResultEncoder(
    new ArtifactStore(f.root, "agent", { now: () => 1800000000100 }),
  );
  assert.deepEqual(
    Buffer.from(
      (await restarted.render(saved, f.scope(), historical.run)).content[0]
        .data,
      "base64",
    ),
    original,
  );
  f.revoke();
  await assert.rejects(
    () => f.encoder.render(saved, f.scope(), historical.run),
    { code: "forbidden" },
  );
  assert.equal(
    (await f.engine.observe(caller, first.run.runId)).run.status,
    "succeeded",
  );
  f.grant();
  rmSync(f.contentPath(saved.content[0].resource));
  await assert.rejects(() => f.encoder.readResource(uri, f.scope()), {
    code: "resource_unavailable",
  });
  assert.equal(
    (await f.encoder.listResources(f.scope())).resources.some(
      (item) => item.uri === uri,
    ),
    false,
  );
  await assert.rejects(
    () => f.encoder.render(saved, f.scope(), historical.run),
    { code: "resource_unavailable" },
  );
  assert.equal(
    (await f.engine.observe(caller, first.run.runId)).run.status,
    "succeeded",
  );
});

test("expired historical media fails explicitly without recreating it from a still-existing source file", async (t) => {
  const f = await fixture(t, { artifacts: { retentionMs: 1000 } });
  const source = f.source("expire.png", png());
  const saved = await f.encoder.encode(f.output.image(source), f.scope());
  f.advance(1000);
  await assert.rejects(
    () => f.encoder.readResource(saved.content[0].resource.uri, f.scope()),
    { code: "resource_expired" },
  );
  await assert.rejects(() => f.encoder.render(saved, f.scope(), run), {
    code: "resource_expired",
  });
  assert.deepEqual(readFileSync(source), png());
  assert.equal(
    readFileSync(f.contentPath(saved.content[0].resource)).length,
    png().length,
  );
});

test("individual real image/audio boundaries and aggregate raw-byte boundaries are enforced before success", async (t) => {
  const f = await fixture(t),
    image = png(),
    audio = wav();
  assert.equal(f.encoder.limits.imageBytes, 10 * MiB);
  assert.equal(f.encoder.limits.audioBytes, 32 * MiB);
  assert.equal(f.encoder.limits.inlineBytes, 64 * MiB);
  for (const [type, bytes, limit] of [
    ["image", image, "imageBytes"],
    ["audio", audio, "audioBytes"],
  ]) {
    const exact = new ResultEncoder(f.artifacts, { [limit]: bytes.length });
    const saved = await exact.encode(
      f.output[type]({ data: bytes }),
      f.scope(),
    );
    assert.equal(saved.content[0].resource.size, bytes.length);
    const small = new ResultEncoder(f.artifacts, { [limit]: bytes.length - 1 });
    await assert.rejects(
      () => small.encode(f.output[type]({ data: bytes }), f.scope()),
      { code: "inline_media_too_large" },
    );
    await assert.rejects(() => small.render(saved, f.scope(), run), {
      code: "resource_read_too_large",
    });
  }
  const values = f.output.result({
    content: [f.output.image({ data: image }), f.output.audio({ data: audio })],
  });
  const exact = new ResultEncoder(f.artifacts, {
    inlineBytes: image.length + audio.length,
  });
  const saved = await exact.encode(values, f.scope());
  assert.equal(
    (await exact.render(saved, f.scope(), run)).content[1].type,
    "audio",
  );
  const small = new ResultEncoder(f.artifacts, {
    inlineBytes: image.length + audio.length - 1,
  });
  await assert.rejects(() => small.encode(values, f.scope()), {
    code: "inline_content_too_large",
  });
  await assert.rejects(() => small.render(saved, f.scope(), run), {
    code: "inline_content_too_large",
  });
});

test("final MCP encoding and actual Host capabilities fail explicitly rather than returning a false preview", async (t) => {
  const f = await fixture(t),
    image = png(),
    audio = wav();
  const saved = await f.encoder.encode(
    f.output.result({
      content: [
        f.output.image({ data: image }),
        f.output.audio({ data: audio }),
      ],
    }),
    f.scope(),
  );
  const response = await f.encoder.render(saved, f.scope(), run);
  const length = Buffer.byteLength(JSON.stringify(response));
  assert.deepEqual(
    await f.encoder.render(saved, f.scope(), run, { maxResponseBytes: length }),
    response,
  );
  await assert.rejects(
    () =>
      f.encoder.render(saved, f.scope(), run, { maxResponseBytes: length - 1 }),
    { code: "mcp_response_too_large" },
  );
  await assert.rejects(
    () =>
      f.encoder.render(saved, f.scope(), run, {
        supportedImages: new Set(["image/jpeg"]),
      }),
    { code: "host_content_unsupported" },
  );
  await assert.rejects(
    () =>
      f.encoder.render(saved, f.scope(), run, {
        supportedAudio: new Set(["audio/ogg"]),
      }),
    { code: "host_content_unsupported" },
  );
  assert.deepEqual(
    saved.content.map((item) => item.type),
    ["image", "audio"],
  );
  assert.equal(Object.hasOwn(saved.content[0], "data"), false);
});

test("a generic resource-link cannot bypass actual media validation when a later content item reuses its bytes", async (t) => {
  const f = await fixture(t),
    invalid = Buffer.from("not real image bytes");
  await assert.rejects(
    () =>
      f.encoder.encode(
        f.output.result({
          content: [
            f.output.file({ data: invalid, mimeType: "image/png" }),
            f.output.image({ data: invalid, mimeType: "image/png" }),
          ],
        }),
        f.scope(),
      ),
    { code: "unsupported_media_format" },
  );
  const bytes = png();
  await assert.rejects(
    () =>
      f.encoder.encode(
        f.output.result({
          content: [
            f.output.file({ data: bytes, mimeType: "image/jpeg" }),
            f.output.image({ data: bytes, mimeType: "image/png" }),
          ],
        }),
        f.scope(),
      ),
    { code: "media_type_mismatch" },
  );
});

test("standard Resources read returns text/blob contents and a paginated directory enforces current authority", async (t) => {
  let blocked;
  const f = await fixture(t, {
    authorize(target) {
      if (target.action === "read" && target.uri === blocked)
        throw new AgentError("forbidden", "Resource permission was revoked.");
    },
  });
  const image = png();
  const saved = await f.encoder.encode(
    f.output.result({
      content: [
        f.output.image({ data: image, name: "picture.png" }),
        f.output.file({
          data: Buffer.from("# Manual"),
          name: "manual.md",
          mimeType: "text/markdown",
        }),
      ],
    }),
    f.scope(),
  );
  const imageUri = saved.content[0].resource.uri,
    textUri = saved.content[1].resource.uri;
  const binary = await f.encoder.readResource(imageUri, f.scope());
  assert.deepEqual(Object.keys(binary), ["contents"]);
  assert.equal(binary.contents.length, 1);
  assert.deepEqual(Object.keys(binary.contents[0]).sort(), [
    "blob",
    "mimeType",
    "uri",
  ]);
  assert.equal(binary.contents[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(binary.contents[0].blob, "base64"), image);
  const text = await f.encoder.readResource(textUri, f.scope());
  assert.deepEqual(text, {
    contents: [{ uri: textUri, mimeType: "text/markdown", text: "# Manual" }],
  });
  const first = await f.encoder.listResources(f.scope(), { limit: 1 });
  assert.equal(first.resources.length, 1);
  assert.equal(typeof first.nextCursor, "string");
  const second = await f.encoder.listResources(f.scope(), {
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.resources.length, 1);
  assert.equal(Object.hasOwn(second, "nextCursor"), false);
  assert.deepEqual(
    new Set([...first.resources, ...second.resources].map((item) => item.uri)),
    new Set([imageUri, textUri]),
  );
  assert.deepEqual(Object.keys(first.resources[0]).sort(), [
    "mimeType",
    "name",
    "size",
    "uri",
  ]);
  assert.equal(JSON.stringify(first).includes(f.work), false);
  blocked = imageUri;
  assert.deepEqual(
    (await f.encoder.listResources(f.scope())).resources.map(
      (item) => item.uri,
    ),
    [textUri],
  );
  await assert.rejects(() => f.encoder.readResource(imageUri, f.scope()), {
    code: "forbidden",
  });
  f.revoke();
  await assert.rejects(() => f.encoder.listResources(f.scope()), {
    code: "forbidden",
  });
  await assert.rejects(() => f.encoder.readResource(textUri, f.scope()), {
    code: "forbidden",
  });
});

test("Resources metadata rejects a lower encoded response budget before reading bytes or producing base64", async (t) => {
  const f = await fixture(t),
    bytes = png();
  const saved = await f.encoder.encode(
    f.output.image({ data: bytes }),
    f.scope(),
  );
  const uri = saved.content[0].resource.uri;
  const originalRead = f.artifacts.read,
    originalMetadata = f.artifacts.metadata,
    originalToString = Buffer.prototype.toString;
  let reads = 0,
    metadata = 0,
    encoded = 0;
  t.mock.method(f.artifacts, "read", function (...args) {
    reads++;
    return Reflect.apply(originalRead, this, args);
  });
  t.mock.method(f.artifacts, "metadata", function (...args) {
    metadata++;
    return Reflect.apply(originalMetadata, this, args);
  });
  t.mock.method(Buffer.prototype, "toString", function (...args) {
    if (args[0] === "base64") encoded++;
    return Reflect.apply(originalToString, this, args);
  });
  const normal = await f.encoder.readResource(uri, f.scope());
  assert.deepEqual(Buffer.from(normal.contents[0].blob, "base64"), bytes);
  assert.ok(reads > 0);
  assert.ok(encoded > 0);
  const bounded = new ResultEncoder(f.artifacts, {
    responseBytes: Buffer.byteLength(JSON.stringify(normal)) - 1,
  });
  reads = 0;
  metadata = 0;
  encoded = 0;
  await assert.rejects(() => bounded.readResource(uri, f.scope()), {
    code: "mcp_response_too_large",
  });
  assert.ok(metadata > 0);
  assert.equal(reads, 0);
  assert.equal(encoded, 0);
  assert.equal((await f.artifacts.metadata(uri, f.scope())).size, bytes.length);
});

test("Resources directory over the text budget fails clearly and a smaller real page remains usable", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++)
    await f.artifacts.register(
      { data: Buffer.from([index]), name: `resource-${index}.bin` },
      f.scope(),
    );
  const one = await f.encoder.listResources(f.scope(), { limit: 1 });
  const all = await f.encoder.listResources(f.scope(), { limit: 3 });
  const oneBytes = Buffer.byteLength(JSON.stringify(one)),
    allBytes = Buffer.byteLength(JSON.stringify(all));
  assert.ok(oneBytes < allBytes);
  const bounded = new ResultEncoder(f.artifacts, { textBytes: oneBytes });
  await assert.rejects(() => bounded.listResources(f.scope(), { limit: 3 }), {
    code: "resource_list_too_large",
  });
  assert.deepEqual(await bounded.listResources(f.scope(), { limit: 1 }), one);
});

test("oversized raw embedded text is rejected before Buffer allocation, registration or inspection", async (t) => {
  const f = await fixture(t),
    text = "中".repeat(100);
  const value = {
    type: "resource",
    resource: { uri: "remote://original-text", text, mimeType: "text/plain" },
  };
  const originalFrom = Buffer.from,
    originalRegister = f.artifacts.register;
  let allocations = 0,
    registrations = 0,
    inspections = 0;
  t.mock.method(Buffer, "from", function (...args) {
    if (args[0] === text) allocations++;
    return Reflect.apply(originalFrom, this, args);
  });
  t.mock.method(
    f.artifacts,
    "register",
    function (source, scope, inspect, options) {
      registrations++;
      return Reflect.apply(originalRegister, this, [
        source,
        scope,
        inspect &&
          (async (...args) => {
            inspections++;
            return inspect(...args);
          }),
        options,
      ]);
    },
  );
  const normal = await f.encoder.encode(value, f.scope());
  assert.equal(allocations, 1);
  assert.equal(registrations, 1);
  assert.equal(inspections, 1);
  rmSync(
    path.dirname(path.dirname(f.contentPath(normal.content[0].resource))),
    { recursive: true },
  );
  allocations = 0;
  registrations = 0;
  inspections = 0;
  const bounded = new ResultEncoder(f.artifacts, {
    textBytes: Buffer.byteLength(text) - 1,
  });
  await assert.rejects(() => bounded.encode(value, f.scope()), {
    code: "resource_read_too_large",
  });
  assert.equal(allocations, 0);
  assert.equal(registrations, 0);
  assert.equal(inspections, 0);
  assert.deepEqual(readdirSync(f.artifacts.directory), []);
});

test("native and Blob lower inline budgets reject before actual copies, inspectors or resource publication", async (t) => {
  const f = await fixture(t),
    image = png(),
    binary = Buffer.alloc(256, 65);
  const imageBlob = new Blob([image], { type: "image/png" }),
    binaryBlob = new Blob([binary]);
  const tracked = [image, binary].map((item) => ({
    buffer: item.buffer,
    offset: item.byteOffset,
    size: item.byteLength,
  }));
  const originalFrom = Buffer.from,
    originalStream = Blob.prototype.stream,
    originalRegister = f.artifacts.register;
  let copies = 0,
    streams = 0,
    inspections = 0;
  const registrations = [];
  t.mock.method(Buffer, "from", function (...args) {
    const item = args[0];
    if (
      ArrayBuffer.isView(item) &&
      tracked.some(
        (source) =>
          item.buffer === source.buffer &&
          item.byteOffset === source.offset &&
          item.byteLength === source.size,
      )
    )
      copies++;
    return Reflect.apply(originalFrom, this, args);
  });
  t.mock.method(Blob.prototype, "stream", function (...args) {
    // ArtifactStore streams its trusted native snapshot rather than the
    // caller's Blob identity. Count the real delegated stream consumption.
    streams++;
    return Reflect.apply(originalStream, this, args);
  });
  t.mock.method(
    f.artifacts,
    "register",
    function (source, scope, inspect, options) {
      registrations.push(options?.maxBytes);
      return Reflect.apply(originalRegister, this, [
        source,
        scope,
        inspect &&
          (async (...args) => {
            inspections++;
            return inspect(...args);
          }),
        options,
      ]);
    },
  );
  for (const source of [image, imageBlob]) {
    const saved = await f.encoder.encode(
      f.output.image({ data: source }),
      f.scope(),
    );
    rmSync(
      path.dirname(path.dirname(f.contentPath(saved.content[0].resource))),
      { recursive: true },
    );
  }
  assert.ok(copies > 0);
  assert.ok(streams > 0);
  assert.equal(inspections, 2);
  copies = 0;
  streams = 0;
  inspections = 0;
  registrations.length = 0;
  for (const source of [image, imageBlob]) {
    const bounded = new ResultEncoder(f.artifacts, {
      imageBytes: image.length - 1,
    });
    await assert.rejects(
      () => bounded.encode(f.output.image({ data: source }), f.scope()),
      { code: "inline_media_too_large" },
    );
  }
  for (const source of [binary, binaryBlob]) {
    const bounded = new ResultEncoder(f.artifacts, {
      inlineBytes: binary.length - 1,
    });
    await assert.rejects(
      () =>
        bounded.encode(
          f.output.resource({
            data: source,
            mimeType: "application/octet-stream",
          }),
          f.scope(),
        ),
      { code: "resource_read_too_large" },
    );
  }
  assert.deepEqual(registrations, [
    image.length - 1,
    image.length - 1,
    binary.length - 1,
    binary.length - 1,
  ]);
  assert.equal(copies, 0);
  assert.equal(streams, 0);
  assert.equal(inspections, 0);
  assert.deepEqual(readdirSync(f.artifacts.directory), []);
  assert.deepEqual((await f.artifacts.list(f.scope())).resources, []);
});
