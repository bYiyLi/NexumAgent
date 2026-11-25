import assert from "node:assert/strict";
import { Blob, File } from "node:buffer";
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
  { FixtureStore },
  { ModuleLoader },
  { ScriptCatalog },
  { ExecutionFixture, callerKey },
  { ResourceManager },
  { ExtensionRegistry },
  { AgentError },
] = await Promise.all(
  [
    "results/encoder.js",
    "results/artifacts.js",
    "sdk/output.js",
    "../test/helpers/runtime-fixture.mjs",
    "runtime/modules.js",
    "runtime/scripts.js",
    "../test/helpers/runtime-fixture.mjs",
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

test("native bytes automatically produce real MCP media; native File produces an addressable link", async (t) => {
  const f = await fixture(t);
  const image = await f.encoder.encode(png(), f.scope());
  assert.equal(image.content.length, 1);
  assert.equal(image.content[0].type, "image");
  assert.equal(image.content[0].mimeType, "image/png");
  const photo = await f.encoder.render(savedJSON(image), f.scope(), run);
  assert.equal(photo.content[0].type, "image");
  assert.ok(photo.content[0].data);

  const audio = await f.encoder.encode(wav(), f.scope());
  assert.equal(audio.content[0].type, "audio");
  const file = await f.encoder.encode(new File(["report body"], "report.pdf", { type: "application/pdf" }), f.scope());
  assert.equal(file.content[0].type, "resource_link");
  assert.equal(file.content[0].resource.name, "report.pdf");
  const generic = await f.encoder.encode(Buffer.from([0, 1, 2]), f.scope());
  assert.equal(generic.content[0].type, "resource_link");

  // Large on-disk files do not need to be fully buffered in JavaScript.
  f.source("source-report.pdf", Buffer.from("%PDF-1.7\nreal file"));
  const fileLink = await f.encoder.encode({ type: "resource_link", path: "source-report.pdf" }, f.scope());
  assert.equal(fileLink.content[0].type, "resource_link");
  assert.equal(fileLink.content[0].resource.name, "source-report.pdf");
  const ordinaryRecord = await f.encoder.encode({ type: "image", path: "chart.png" }, f.scope());
  assert.deepEqual(savedJSON(ordinaryRecord.data), { type: "image", path: "chart.png" });
  const businessLink = await f.encoder.encode({ type: "resource_link", path: "irrelevant", subject: "business" }, f.scope());
  assert.deepEqual(savedJSON(businessLink.data), { type: "resource_link", path: "irrelevant", subject: "business" });
});
test("published Browser observation and download examples deliver native results without a legacy global", async (t) => {
  const f = await fixture(t);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const refs = new URL("../packages/browser/skills/browser-control/references/", import.meta.url);
  const example = (name) => {
    const text = readFileSync(new URL(name, refs), "utf8");
    const source = text.match(/```javascript\n([\s\S]*?)\n```/);
    assert.ok(source, "missing example " + name);
    return source[1];
  };
  const image = await new AsyncFunction("tab", example("observation.md"))({
    screenshot: async () => Uint8Array.from(png()),
  });
  const encoded = await f.encoder.encode(image, f.scope());
  assert.equal(encoded.content[0].type, "image");
  f.source("downloaded-report.pdf", Buffer.from("%PDF-1.7\nfixture document"));
  const download = new AsyncFunction("selected", "context", example("downloads.md"));
  const selected = { downloads: { list: async () => [{id: 7, state: "complete", filename: "downloaded-report.pdf"}] }};
  const value = await download(selected, {input:{downloadRecordId:7}});
  const result = await f.encoder.encode(value, f.scope());
  assert.equal(result.content[0].type, "resource_link");
  assert.equal(result.content[0].resource.name, "downloaded-report.pdf");
  assert.equal((await download(selected, {input:{downloadRecordId:8}})).status, "unconfirmed");
});
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-encoder-")),
  );
  const work = root;
  mkdirSync(work, { recursive: true });
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
    store = new FixtureStore(root, {
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
      builtins: () => ["fs"],
      approvedPackages: () => new Map(),
    });
    writeFileSync(path.join(work, "snapshot.json"), '{"project":null}');
    context = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "snapshot.json",
    });
    engine = new ExecutionFixture(store, loader, scripts, {
      authorize(who, target) {
        if (target.run && target.run.callerKey !== callerKey(who))
          throw new AgentError("forbidden", "Wrong caller.");
      },
      loadWork: (item) =>
        JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
      encodeResult: (value, services) => encoder.encode(value, scope(services)),
      bindings: (services) => ({
        ...registry.bindings(services),
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


test("content-shaped business values remain JSON while explicit images use verified native bytes", async (t) => {
  const f = await fixture(t), bytes = png();
  f.source("chart.png", bytes);
  const raw = { type: "image", path: "chart.png" };
  const business = await f.encoder.encode(raw, f.scope());
  assert.equal(business.content.length, 0);
  assert.deepEqual(savedJSON(business.data), raw);
  const saved = await f.encoder.encode(f.output.image("chart.png"), f.scope());
  assert.equal(saved.content[0].type, "image");
  assert.equal(saved.content[0].mimeType, "image/png");
  assert.equal(saved.content[0].resource.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(Object.hasOwn(saved.content[0], "data"), false);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(bytes.toString("base64")));
  const rendered = await f.encoder.render(savedJSON(saved), f.scope(), run);
  assert.deepEqual(Buffer.from(onlyMedia(rendered, "image")[0].data, "base64"), bytes);
  assert.equal(rendered.structuredContent.run.status, "succeeded");
  assert.ok(f.accesses.some((item) => item.action === "register" && item.path === path.join(f.work, "chart.png")));
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
    f.output.result({ content: [
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
    ] }),
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
      items: [{ bytes: view }, { image: f.output.image({ data: png() }) }],
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


test("large JSON, primitive text and explicit text become readable bounded resources", async (t) => {
  const f = await fixture(t), large = "正文".repeat(16000);
  assert.ok(Buffer.byteLength(large) > 64 * KiB);
  const data = { title: "full", body: large, count: 3n };
  for (const [value, kind] of [
    [f.output.json(data), "dataResource"],
    [large, "dataResource"],
    [f.output.text(large), "textResource"]
  ]) {
    const saved = await f.encoder.encode(value, f.scope());
    assert.equal(saved.delivery.complete, false);
    assert.equal(saved.delivery.reason, "context_budget");
    const resource = saved.delivery[kind];
    assert.ok(resource.uri);
    const full = JSON.parse((await f.artifacts.read(resource.uri, f.scope(), { maxBytes: 1 * MiB })).data.toString("utf8"));
    if (kind === "textResource") {
      assert.equal(full[0].item.text, large);
    } else if (value === large) {
      assert.equal(full.data, large);
    } else {
      assert.equal(Object.hasOwn(saved, "data"), false);
      assert.deepEqual(full.data, { title: "full", body: large, count: "3" });
      assert.ok(full.conversions.some((item) => item.from === "BigInt"));
    }
    const rendered = await f.encoder.render(savedJSON(saved), f.scope(), run);
    assert.equal(rendered.structuredContent.delivery.complete, false);
    assert.ok(rendered.content.some((item) => item.type === "resource_link" && item.uri === resource.uri));
    assert.ok(Buffer.byteLength(JSON.stringify(rendered)) <= 64 * KiB);
    assert.equal(JSON.stringify(rendered).includes(large), false);
  }
});

test("registered extension results run through the real Worker and encoder while business isError preserves successful lifecycle", async (t) => {
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
  assert.equal(JSON.stringify(ok.result).includes(image.toString("base64")), false);
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
  assert.equal(failed.run.error.code, "unsupported_media_format");
  assert.equal(failed.result, null);
});

test("nested undefined and other ordinary JSON conversions preserve the successful Run and its complete result", async (t) => {
  const f = await fixture(t, { runtime: true });
  const completed = await f.start(
    'return { checks: [{ name: "first", status: "passed" }, { name: "second", value: undefined }, { name: "third", values: [undefined, , NaN, Infinity] }] };',
  );
  assert.equal(completed.run.status, "succeeded");
  assert.equal(completed.run.error, null);
  assert.deepEqual(savedJSON(completed.result.data), {
    checks: [
      { name: "first", status: "passed" },
      { name: "second" },
      { name: "third", values: [null, null, null, null] },
    ],
  });
  const pure = await f.start(
    'return { nested: { missing: undefined, count: NaN }, list: [undefined] };',
  );
  assert.equal(pure.run.status, "succeeded");
  assert.deepEqual(savedJSON(pure.result.data), {
    nested: { count: null },
    list: [null],
  });
  const explicit = await f.start(
    'return { good: 1, missing: undefined };',
  );
  assert.equal(explicit.run.status, "succeeded");
  assert.deepEqual(savedJSON(explicit.result.data), { good: 1 });
  const nonFinite = await f.start("return Infinity");
  assert.equal(nonFinite.run.status, "succeeded");
  assert.equal(nonFinite.result.data, null);
});

test("non-cloneable ordinary values reach the Core result normalizer without failing the Worker", async (t) => {
  const f = await fixture(t, { runtime: true });
  const direct = await f.start(
    'return { ok: true, ignored: () => 1, symbol: Symbol("value"), items: [Symbol("value"), () => 2], map: new Map([[Symbol("first"), 1], [Symbol("second"), 2]]), set: new Set([Symbol("first"), Symbol("second"), 4]) };',
  );
  assert.equal(direct.run.status, "succeeded");
  assert.deepEqual(savedJSON(direct.result.data), {
    ok: true,
    items: [null, null],
    map: [[null, 1], [null, 2]],
    set: [null, null, 4],
  });
  const wrapped = await f.start(
    'return { ok: true, ignored: () => 1, list: [Symbol("value")] };',
  );
  assert.equal(wrapped.run.status, "succeeded");
  assert.deepEqual(savedJSON(wrapped.result.data), {
    ok: true,
    list: [null],
  });
});

test("historical results retain original image snapshots and recheck current resource permissions", async (t) => {
  const f = await fixture(t, { runtime: true }),
    original = png(80),
    replacement = png(180);
  const source = f.source("history.png", original);
  const first = await f.start('const fs=await import("node:fs/promises");return await fs.readFile(context.pwd+"/history.png");');
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


test("inline media limits automatically promote to verifiable links while retained inline responses respect Host budgets", async (t) => {
  const f = await fixture(t), image = png(), audio = wav();
  assert.equal(f.encoder.limits.imageBytes, 10 * MiB);
  assert.equal(f.encoder.limits.audioBytes, 32 * MiB);
  assert.equal(f.encoder.limits.inlineBytes, 64 * MiB);
  for (const [type, bytes, limit] of [
    ["image", image, "imageBytes"],
    ["audio", audio, "audioBytes"]
  ]) {
    const exact = new ResultEncoder(f.artifacts, { [limit]: bytes.length });
    const saved = await exact.encode(f.output[type]({ data: bytes }), f.scope());
    assert.equal(saved.content[0].resource.size, bytes.length);
    const small = new ResultEncoder(f.artifacts, { [limit]: bytes.length - 1 });
    const downgraded = await small.encode(f.output[type]({ data: bytes }), f.scope());
    assert.equal(downgraded.content[0].type, "resource_link");
    assert.equal(downgraded.content[0].resource.size, bytes.length);
    const savedBytes = await f.artifacts.read(downgraded.content[0].resource.uri, f.scope(), { maxBytes: bytes.length });
    assert.deepEqual(Buffer.from(savedBytes.data), bytes);
    await assert.rejects(() => small.render(saved, f.scope(), run), {
      code: "resource_read_too_large"
    });
  }
  const values = f.output.result({
    content: [f.output.image({ data: image }), f.output.audio({ data: audio })]
  });
  const exact = new ResultEncoder(f.artifacts, {
    inlineBytes: image.length + audio.length
  });
  const saved = await exact.encode(values, f.scope());
  assert.equal((await exact.render(saved, f.scope(), run)).content[1].type, "audio");
  const small = new ResultEncoder(f.artifacts, {
    inlineBytes: image.length + audio.length - 1
  });
  const promoted = await small.encode(values, f.scope());
  assert.equal(promoted.content[0].type, "image");
  assert.equal(promoted.content[1].type, "resource_link");
  await assert.rejects(() => small.render(saved, f.scope(), run), {
    code: "inline_content_too_large"
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


test("ordinary resource-shaped data stays JSON while explicit oversized embedded text becomes a real link", async (t) => {
  const f = await fixture(t), text = "中".repeat(1000);
  const value = {
    type: "resource",
    resource: { uri: "remote://original-text", text, mimeType: "text/plain" }
  };
  const plain = await f.encoder.encode(value, f.scope());
  assert.deepEqual(savedJSON(plain.data), value);
  assert.equal(plain.content.length, 0);
  const explicit = f.output.result({ content: [value] });
  const normal = await f.encoder.encode(explicit, f.scope());
  assert.equal(normal.content[0].type, "resource");
  const bounded = new ResultEncoder(f.artifacts, {
    textBytes: Buffer.byteLength(text) - 1
  });
  const saved = await bounded.encode(explicit, f.scope());
  assert.equal(saved.content[0].type, "resource_link");
  const resource = saved.content[0].resource;
  const bytes = await f.artifacts.read(resource.uri, f.scope(), { maxBytes: Buffer.byteLength(text) });
  assert.equal(bytes.data.toString("utf8"), text);
  assert.equal(saved.content[0].resource.sha256, createHash("sha256").update(text).digest("hex"));
});


test("native bytes and Blob exceeding inline budgets still produce bounded, readable file resources", async (t) => {
  const f = await fixture(t), image = png(), binary = Buffer.alloc(256, 65);
  const imageBlob = new Blob([image], { type: "image/png" });
  const binaryBlob = new Blob([binary]);
  for (const source of [image, imageBlob]) {
    const bounded = new ResultEncoder(f.artifacts, {
      imageBytes: image.length - 1
    });
    const saved = await bounded.encode(f.output.image({ data: source }), f.scope());
    assert.equal(saved.content[0].type, "resource_link");
    const identity = saved.content[0].resource;
    assert.equal(identity.mimeType, "image/png");
    const bytes = await f.artifacts.read(identity.uri, f.scope(), { maxBytes: image.length });
    assert.deepEqual(Buffer.from(bytes.data), image);
  }
  for (const source of [binary, binaryBlob]) {
    const bounded = new ResultEncoder(f.artifacts, {
      inlineBytes: binary.length - 1
    });
    const saved = await bounded.encode(f.output.resource({
      data: source, mimeType: "application/octet-stream"
    }), f.scope());
    assert.equal(saved.content[0].type, "resource_link");
    const identity = saved.content[0].resource;
    const bytes = await f.artifacts.read(identity.uri, f.scope(), { maxBytes: binary.length });
    assert.deepEqual(Buffer.from(bytes.data), binary);
  }
});

test("result descriptions retain five content kinds and actual resource coordinates without reading media bytes", async (t) => {
  const f = await fixture(t);
  f.source("wire-notes.md", "# complete notes");
  const saved = await f.encoder.encode(
    f.output.result({
      content: [
        f.output.text("finished"),
        f.output.image({ data: png() }),
        f.output.audio({ data: wav() }),
        f.output.file({ data: Buffer.from([0, 255]), name: "raw.bin" }),
        f.output.resource("wire-notes.md"),
      ],
      structuredContent: { total: 5 },
    }),
    f.scope(),
  );
  const before = savedJSON(saved);
  const read = f.artifacts.read,
    open = f.artifacts.open;
  f.artifacts.read = async () => {
    assert.fail("description must not read inline media bytes");
  };
  f.artifacts.open = async () => {
    assert.fail("description must not open a byte transport");
  };
  try {
    const described = await f.encoder.describe(saved, f.scope());
    assert.deepEqual(
      described.result.content.map((item) => item.type),
      ["text", "image", "audio", "resource_link", "resource"],
    );
    assert.deepEqual(described.result.data, { total: 5 });
    assert.deepEqual(described.transfers, []);
    for (const item of described.result.content) {
      assert.equal(Object.hasOwn(item, "blob"), false);
      if (["image", "audio"].includes(item.type)) {
        assert.equal(Object.hasOwn(item, "data"), false);
        assert.match(
          item.resource.uri,
          /^nexum:\/\/agents\/agent\/resources\/res_/,
        );
        assert.match(item.resource.sha256, /^[0-9a-f]{64}$/);
        assert(item.resource.size > 0);
      }
    }
    assert.deepEqual(savedJSON(saved), before);
  } finally {
    f.artifacts.read = read;
    f.artifacts.open = open;
  }
  f.revoke();
  await assert.rejects(f.encoder.describe(saved, f.scope()), {
    code: "forbidden",
  });
});

test("result descriptions keep a complete large-data fallback and fail closed for asynchronous authority", async (t) => {
  const f = await fixture(t, { limits: { textBytes: 2048 } });
  const saved = await f.encoder.encode(
    f.output.json({ full: "x".repeat(10000) }),
    f.scope(),
  );
  const described = await f.encoder.describe(saved, f.scope());
  assert.equal(described.result.delivery.complete, false);
  assert.equal(described.result.delivery.reason, "context_budget");
  assert(described.result.delivery.dataResource.size > 10000);
  const original = await f.artifacts.read(
    described.result.delivery.dataResource.uri,
    f.scope(),
    { maxBytes: 20000 },
  );
  assert.equal(JSON.parse(original.data.toString()).data.full.length, 10000);
  await assert.rejects(
    f.encoder.describe(saved, { ...f.scope(), assertCurrent: async () => {} }),
    { code: "authorization_configuration" },
  );
});

test("a smaller current observation budget moves retained JSON to a readable resource without changing history", async (t) => {
  const f = await fixture(t);
  const saved = await f.encoder.encode(
    f.output.json({ value: "x".repeat(10000) }),
    f.scope(),
  );
  assert.equal(saved.data.value.length, 10000);
  const before = savedJSON(saved);
  const projected = await f.encoder.describe(saved, f.scope(), {
    textBytes: 2048,
  });
  assert.equal(projected.result.delivery.complete, false);
  assert.equal(projected.result.delivery.reason, "context_budget");
  const full = await f.artifacts.read(
    projected.result.delivery.dataResource.uri,
    f.scope(),
    { maxBytes: 20000 },
  );
  assert.equal(JSON.parse(full.data.toString()).data.value.length, 10000);
  assert.deepEqual(savedJSON(saved), before);
});

test("model mirror expansion resourceizes data and text before the final Cloud context ceiling", async (t) => {
  const f=await fixture(t);
  for (const [value,kind,expected] of [
    [f.output.json({html:"<&>".repeat(4000)}),"dataResource",{html:"<&>".repeat(4000)}],
    [f.output.text("nested text ".repeat(2500)),"textResource","nested text ".repeat(2500)],
  ]) {
    const saved=await f.encoder.encode(value,f.scope());
    const resource=saved.delivery?.[kind];
    assert.ok(resource,kind);
    const read=await f.artifacts.read(resource.uri,f.scope(),{maxBytes:128*KiB});
    const parsed=JSON.parse(read.data.toString("utf8"));
    assert.deepEqual(kind==="textResource"?parsed[0].item.text:parsed.data,expected);
  }
});
