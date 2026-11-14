import assert from "node:assert/strict";
import { inspect } from "node:util";
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

// Real local result, artifact, Registry and Resources integrations. Remote reads
// delegate to a registered reader; these tests do not claim Cloud or Host delivery.
const dist = new URL(
  process.env.NEXUM_MCP_RESULTS_DIST ?? "../dist/",
  import.meta.url,
);
const [
  {
    wrapMcpResult,
    mcpResult,
    rebuildMcpResult,
    mcpLogSnapshot,
    projectMcpProtocolResult,
    McpResultResources,
    copyMcpJSON,
  },
  { ResultEncoder },
  { ArtifactStore },
  { createOutput },
  { normalizeData },
  { SqliteStore },
  { ResourceManager },
  { ExtensionRegistry },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { AgentError },
] = await Promise.all(
  [
    "results/mcp.js",
    "results/encoder.js",
    "results/artifacts.js",
    "sdk/output.js",
    "results/normalize.js",
    "storage/sqlite.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "runtime/modules.js",
    "runtime/scripts.js",
    "runtime/engine.js",
    "contracts/errors.js",
  ].map((file) => import(new URL(file, dist))),
);

const secret = "synthetic-host-meta-only-do-not-show-48";
const caller = {
  principalId: "user",
  clientId: "mcp-results",
  host: "local-test",
  grantId: "grant-current",
};
const run = { runId: "run_mcp", status: "succeeded" };
const origin = {
  type: "extension",
  owner: "@test/mcp",
  namespace: "remote",
  version: "1",
  revision: "one",
};
function png() {
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
    chunk("IDAT", deflateSync(Buffer.from([0, 80, 100, 120, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function wav() {
  const bytes = Buffer.alloc(124);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
function noSecret(value) {
  assert.equal(JSON.stringify(value).includes(secret), false);
}
function modelOnly(response) {
  const { _meta, ...model } = response;
  return model;
}
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(root, entry.name))
      : [path.join(root, entry.name)],
  );
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-mcp-results-")),
  );
  const work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  let allowed = true,
    live = true,
    readHook = options.read;
  const accesses = [],
    reads = [],
    resolves = [],
    logs = [],
    progress = [],
    handles = [];
  const closed = Promise.withResolvers();
  const reader = {
    connection: "service",
    closed: closed.promise,
    assertCurrent() {
      if (!live)
        throw new AgentError("mcp_source_unavailable", "Reader is closed.");
    },
    async readResource(uri, scope) {
      this.assertCurrent();
      scope.authorizeConnection("service", uri, "resources.read");
      reads.push(uri);
      if (readHook) return await readHook(uri, scope);
      return {
        contents: [{ uri, mimeType: "text/plain", text: "remote body" }],
      };
    },
    async listResources(scope, cursor) {
      scope.authorizeConnection("service", undefined, "resources.list");
      reads.push({ cursor });
      return {
        resources: [{ uri: "file:///remote/report.txt", name: "report.txt" }],
        nextCursor: "remote-next",
        _meta: { host: secret },
      };
    },
    dispose() {
      live = false;
      closed.resolve();
    },
  };
  const source = {
    agentId: "agent",
    profileRoot: root,
    extensionId: "extension-test",
    origin,
    connectionResourceId: "res_" + "a".repeat(32),
    connection: "service",
  };
  let store, resources, registry, engine, context;
  const scope = (extra = {}, services) => ({
    ownerKey: callerKey(caller),
    grantId: caller.grantId,
    pwd: work,
    runId: services?.runId ?? run.runId,
    ...(services ? { signal: services.signal } : {}),
    assertCurrent() {
      services?.assertCurrent();
    },
    authorize(target) {
      if (
        !allowed ||
        (target.resource && target.resource.ownerKey !== callerKey(caller))
      )
        throw new AgentError(
          "forbidden",
          "Current artifact access was revoked.",
        );
    },
    authorizeTarget(target) {
      accesses.push(target);
      if (!allowed)
        throw new AgentError(
          "forbidden",
          "Current connection access was revoked.",
        );
      return options.authorize?.(target);
    },
    ...extra,
  });
  const artifacts = new ArtifactStore(root, "agent");
  const router = new McpResultResources({
    agentId: "agent",
    profileRoot: root,
    async resolveResource(identity, authority) {
      resolves.push(identity);
      if (registry)
        return await registry.resolveMcpResource(identity, authority);
      assert.deepEqual(JSON.parse(JSON.stringify(identity)), source);
      return reader;
    },
  });
  const encoder = new ResultEncoder(
    artifacts,
    options.limits,
    undefined,
    router,
  );
  const output = createOutput(work, () => {}, source);
  if (options.runtime) {
    store = new SqliteStore(root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    });
    resources = new ResourceManager(store, { cleanupTimeoutMs: 20 });
    registry = new ExtensionRegistry(resources, {
      cleanupTimeoutMs: 25,
      permissions: new Set(["mcp"]),
      authorize() {
        if (!allowed)
          throw new AgentError(
            "forbidden",
            "Current extension access was revoked.",
          );
      },
      log(...args) {
        logs.push(args);
      },
      progress(...args) {
        progress.push(args);
      },
    });
    const loader = await ModuleLoader.create(work, store.bootId, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    });
    const scripts = new ScriptCatalog(work, "agent", () => []);
    writeFileSync(path.join(work, "snapshot.json"), '{"project":null}');
    context = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "work/snapshot.json",
    });
    engine = new RunEngine(store, loader, scripts, {
      authorize(who, target) {
        if (target.run && target.run.callerKey !== callerKey(who))
          throw new AgentError("forbidden", "Wrong run owner.");
      },
      loadWork: (item) =>
        JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
      encodeResult: (value, services) =>
        encoder.encode(
          value,
          scope({ grantId: services.context.caller.grantId }, services),
        ),
      bindings: (services) => ({
        ...registry.bindings(services),
        output: createOutput(work, () => services.assertCurrent()),
      }),
      resources,
    });
  }
  t.after(async () => {
    if (registry)
      for (const handle of handles.reverse()) await registry.disable(handle);
    reader.dispose();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    source,
    scope,
    artifacts,
    router,
    encoder,
    output,
    reader,
    accesses,
    reads,
    resolves,
    logs,
    progress,
    store,
    registry,
    engine,
    wrap(raw, method) {
      return wrapMcpResult(raw, source, method);
    },
    revoke() {
      allowed = false;
    },
    readWith(fn) {
      readHook = fn;
    },
    async extension(methods, revision = "one", suppliedReader = reader) {
      let ref;
      const handle = await registry.prepare(
        {
          apiVersion: 1,
          origin: { ...origin, revision },
          permissions: ["mcp"],
          config: {},
        },
        async (host) => {
          ref = await host.resources.register({
            kind: "mcp.connection",
            value: suppliedReader,
          });
          return {
            methods: Object.fromEntries(
              Object.entries(methods).map(([name, handle]) => [
                name,
                {
                  description: "测试源感知 MCP 结果",
                  permissions: ["mcp"],
                  schemaDialect: "draft7",
                  inputSchema: { type: "object" },
                  handle(input, call) {
                    return handle(input, call, {
                      connectionResourceId: ref.id,
                      connection: "service",
                    });
                  },
                },
              ]),
            ),
          };
        },
      );
      registry.publish(handle);
      handles.push(handle);
      return handle;
    },
    start(script, waitMs = 3000) {
      return engine.start(caller, {
        contextId: context.contextId,
        script,
        waitMs,
      });
    },
  };
}

test("only issued MCP results retain immutable provenance through an exact native copy", async (t) => {
  const f = await fixture(t);
  const value = f.wrap({
    content: [{ type: "text", text: "body", _meta: { host: secret } }],
    structuredContent: { n: 1 },
    _meta: { host: secret },
  });
  assert.equal(
    mcpResult(value).source.connectionResourceId,
    f.source.connectionResourceId,
  );
  assert.equal(value._meta.host, secret);
  assert.equal(
    Object.getOwnPropertyDescriptor(value, "_meta").enumerable,
    false,
  );
  assert.equal(Object.isFrozen(value), true);
  noSecret(JSON.parse(JSON.stringify(value)));
  assert.equal(inspect({ nested: value }).includes(secret), false);
  noSecret(mcpLogSnapshot(value));
  assert.equal(mcpResult({ ...value }), null);
  assert.equal(mcpResult(Object.create(value)), null);
  let traps = 0;
  const proxy = new Proxy(value, {
    get() {
      traps++;
      throw Error("hook");
    },
    ownKeys() {
      traps++;
      throw Error("hook");
    },
  });
  assert.equal(mcpResult(proxy), null);
  assert.equal(traps, 0);
  const copy = rebuildMcpResult(
    value,
    JSON.parse(JSON.stringify(mcpResult(value).model)),
  );
  assert.notEqual(copy, value);
  assert.equal(
    mcpResult(copy).source.connectionResourceId,
    f.source.connectionResourceId,
  );
  assert.equal(copy._meta.host, secret);
  assert.throws(() => rebuildMcpResult(value, { content: [] }), {
    code: "invalid_mcp_result",
  });
  assert.throws(
    () =>
      wrapMcpResult(value, {
        ...f.source,
        connectionResourceId: "res_" + "b".repeat(32),
      }),
    { code: "mcp_source_mismatch" },
  );
  assert.throws(() => wrapMcpResult(value, f.source, "tools/list"), {
    code: "mcp_source_mismatch",
  });
  assert.throws(
    () =>
      createOutput(f.work, () => {}).mcpResult(
        { content: [] },
        {
          connectionResourceId: f.source.connectionResourceId,
          connection: "service",
        },
      ),
    { code: "mcp_source_unavailable" },
  );
});

test("protocol metadata is extracted at standard slots while business and Schema metadata remain ordinary data", async (t) => {
  const f = await fixture(t);
  const value = f.wrap({
    content: [
      {
        type: "resource",
        _meta: { host: secret },
        resource: {
          uri: "file:///remote/report.txt",
          text: "report",
          _meta: { host: secret },
        },
      },
    ],
    structuredContent: { _meta: { business: "retained" } },
    _meta: { host: secret },
  });
  const info = mcpResult(value);
  assert.deepEqual(
    info.meta.map((entry) => entry.target),
    ["result", "content", "resource"],
  );
  noSecret(info.model);
  assert.equal(info.model.structuredContent._meta.business, "retained");
  const rawCatalog = {
    tools: [
      {
        name: "search",
        inputSchema: { type: "object", _meta: { schema: "retained" } },
        _meta: { host: secret },
      },
    ],
    _meta: { host: secret },
  };
  const catalog = projectMcpProtocolResult(rawCatalog, "tools/list");
  noSecret(catalog);
  assert.equal(
    catalog.structuredContent.tools[0].inputSchema._meta.schema,
    "retained",
  );
  assert.deepEqual(
    mcpResult(f.wrap(rawCatalog, "tools/list")).meta.map(
      (entry) => entry.target,
    ),
    ["result", "entry"],
  );
  // The current protocol may permit arbitrary structured JSON; preserve it rather than imposing a legacy object restriction.
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        mcpResult(f.wrap({ content: [], structuredContent: [1, "two"] })).model
          .structuredContent,
      ),
    ),
    [1, "two"],
  );
});

test("trusted raw JSON validation rejects Proxy/getter input without invoking user hooks", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const getter = { content: [] };
  Object.defineProperty(getter, "_meta", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => f.wrap(getter), { code: "invalid_mcp_result" });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
      getPrototypeOf() {
        calls++;
        return Object.prototype;
      },
    },
  );
  assert.throws(() => copyMcpJSON(proxy), { code: "invalid_mcp_result" });
  assert.equal(calls, 0);
  assert.throws(() => copyMcpJSON({ text: "x".repeat(128) }, 16), {
    code: "mcp_result_too_large",
  });
  assert.throws(
    () =>
      f.wrap({ content: [{ type: "image", data: "", mimeType: "bad mime" }] }),
    { code: "invalid_mcp_content" },
  );
  assert.throws(() => f.wrap({ content: [], _meta: "invalid" }), {
    code: "invalid_mcp_meta",
  });
});

test("all five standard content kinds survive encoding, mixed rendering and saved native-media identities", async (t) => {
  const f = await fixture(t),
    image = png(),
    audio = wav();
  const remote = f.wrap({
    content: [
      {
        type: "text",
        text: "remote text",
        annotations: { audience: ["assistant"], priority: 0.8 },
        _meta: { host: secret },
      },
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      { type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" },
      {
        type: "resource_link",
        uri: "file:///remote/report.txt",
        name: "report.txt",
        description: "remote coordinate",
        mimeType: "text/plain",
        size: 11,
      },
      {
        type: "resource",
        resource: {
          uri: "file:///remote/embedded.txt",
          mimeType: "text/plain",
          text: "fixed embedded body",
        },
      },
    ],
    structuredContent: { answer: 42, _meta: { business: "retained" } },
    _meta: { host: secret, "io.nexum/mcp": { upstream: true } },
  });
  const saved = await f.encoder.encode(remote, f.scope());
  assert.deepEqual(
    saved.content.map((item) => item.type),
    ["text", "image", "audio", "resource_link", "resource"],
  );
  assert.equal(JSON.stringify(saved).includes(image.toString("base64")), false);
  assert.equal(JSON.stringify(saved).includes(audio.toString("base64")), false);
  const response = await f.encoder.render(saved, f.scope(), run, {
    textFallback: false,
  });
  assert.deepEqual(
    response.content.map((item) => item.type),
    ["text", "image", "audio", "resource_link", "resource"],
  );
  assert.deepEqual(Buffer.from(response.content[1].data, "base64"), image);
  assert.deepEqual(Buffer.from(response.content[2].data, "base64"), audio);
  assert.equal(response.content[4].resource.text, "fixed embedded body");
  assert.match(response.content[3].uri, /^nexum:\/\/agents\/agent\/mcp\//);
  assert.match(
    response.content[4].resource.uri,
    /^nexum:\/\/agents\/agent\/mcp\//,
  );
  assert.equal(response.structuredContent.data._meta.business, "retained");
  assert.equal(response._meta.host, secret);
  assert.equal(response._meta["io.nexum/mcp"].upstream, true);
  assert.ok(response._meta["io.nexum/mcp/1"].results[0].protocolMeta.length);
  noSecret(modelOnly(response));
  assert.equal(JSON.stringify(modelOnly(response)).includes(f.root), false);
  const mixed = await f.encoder.encode(
    f.output.result({
      content: [f.output.text("local first"), remote],
      structuredContent: { local: true },
    }),
    f.scope(),
  );
  const mixedResponse = await f.encoder.render(mixed, f.scope(), run, {
    textFallback: false,
  });
  assert.equal(mixedResponse.content[0].text, "local first");
  assert.equal(mixedResponse.content.length, 6);
  assert.equal(
    mixedResponse.structuredContent.mcpResults[0].structuredContent.answer,
    42,
  );
  noSecret(modelOnly(mixedResponse));
});

test("nested and explicit pure-data MCP results preserve association, content and business flags", async (t) => {
  const f = await fixture(t);
  const remote = f.wrap({
    content: [{ type: "text", text: "remote" }],
    structuredContent: { _meta: { business: true } },
    isError: true,
    _meta: { host: secret },
  });
  for (const value of [{ list: [{ remote }] }, f.output.json({ remote })]) {
    const saved = await f.encoder.encode(value, f.scope());
    const response = await f.encoder.render(saved, f.scope(), run, {
      textFallback: false,
    });
    assert.equal(response.content[0].text, "remote");
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.run.status, "succeeded");
    const associated =
      response.structuredContent.data.list?.[0].remote ??
      response.structuredContent.data.remote;
    assert.equal(associated.mcpResult, 0);
    assert.equal(associated.isError, true);
    assert.equal(associated.structuredContent._meta.business, true);
    noSecret(modelOnly(response));
  }
  await assert.rejects(
    normalizeData(remote, {
      mode: "data",
      maxBytes: 65536,
      assertCurrent() {},
    }),
    { code: "result_mcp_resolver_required" },
  );
});

test("remote coordinates never touch ArtifactStore and standard Resources reads truly delegate text/blob", async (t) => {
  const f = await fixture(t);
  const calls = { register: 0, metadata: 0, read: 0 };
  for (const name of Object.keys(calls)) {
    const original = f.artifacts[name].bind(f.artifacts);
    t.mock.method(f.artifacts, name, (...args) => {
      calls[name]++;
      return original(...args);
    });
  }
  const rawUri = "file:///remote/report.txt";
  const saved = await f.encoder.encode(
    f.wrap({
      content: [{ type: "resource_link", uri: rawUri, name: "report.txt" }],
    }),
    f.scope(),
  );
  const response = await f.encoder.render(saved, f.scope(), run, {
    textFallback: false,
  });
  const uri = response.content[0].uri;
  assert.notEqual(uri, rawUri);
  const text = await f.encoder.readResource(uri, f.scope());
  assert.equal(text.contents[0].text, "remote body");
  assert.equal(text.contents[0].uri, uri);
  assert.equal(text.contents[0].type, undefined);
  const bytes = png();
  f.readWith(async (requested) => ({
    contents: [
      { uri: requested, mimeType: "image/png", blob: bytes.toString("base64") },
    ],
    _meta: { host: secret, "io.nexum/mcp": { upstream: true } },
  }));
  const binary = await f.encoder.readResource(uri, f.scope());
  assert.deepEqual(Buffer.from(binary.contents[0].blob, "base64"), bytes);
  assert.equal(binary.contents[0].data, undefined);
  assert.equal(binary._meta.host, secret);
  assert.equal(binary._meta["io.nexum/mcp"].upstream, true);
  assert.ok(binary._meta["io.nexum/mcp/1"].protocolMeta.length > 0);
  noSecret(modelOnly(binary));
  assert.deepEqual(f.reads, [rawUri, rawUri]);
  assert.deepEqual(calls, { register: 0, metadata: 0, read: 0 });
  assert.ok(
    f.accesses.some(
      (target) =>
        target.type === "resource" &&
        target.value === rawUri &&
        target.access === "read",
    ),
  );
  const directory = await f.router.listResources(
    f.source,
    f.scope(),
    "remote-cursor",
  );
  assert.equal(directory.resources[0].uri, uri);
  assert.equal(directory.nextCursor, "remote-next");
  assert.deepEqual(f.reads.at(-1), { cursor: "remote-cursor" });
  noSecret(modelOnly(directory));
});

test("every remote read checks current Grant and authority again after asynchronous delivery", async (t) => {
  const f = await fixture(t),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const uri = f.router.uri(f.source, "file:///remote/private.txt");
  await assert.rejects(
    f.encoder.readResource(uri, f.scope({ grantId: undefined })),
    { code: "mcp_authorization_unavailable" },
  );
  await assert.rejects(
    f.encoder.readResource(uri, f.scope({ authorizeTarget: undefined })),
    { code: "mcp_authorization_unavailable" },
  );
  await assert.rejects(
    f.encoder.readResource(uri, f.scope({ authorizeTarget: () => true })),
    { code: "authorization_configuration" },
  );
  await assert.rejects(
    f.encoder.readResource(uri, f.scope({ authorizeTarget: async () => {} })),
    { code: "authorization_configuration" },
  );
  await assert.rejects(
    f.encoder.readResource(uri, f.scope({ assertCurrent: () => true })),
    { code: "authorization_configuration" },
  );
  await assert.rejects(
    f.encoder.readResource(uri, f.scope({ assertCurrent: async () => {} })),
    { code: "authorization_configuration" },
  );
  assert.equal(f.reads.length, 0);
  f.readWith(async (requested) => {
    entered.resolve();
    await gate.promise;
    return { contents: [{ uri: requested, text: "must not escape" }] };
  });
  const pending = f.encoder.readResource(uri, f.scope());
  await entered.promise;
  f.revoke();
  gate.resolve();
  await assert.rejects(pending, { code: "forbidden" });
  assert.equal(f.reads.length, 1);
});

test("Host-only metadata has an independent bounded budget and never enters fallback model text", async (t) => {
  const f = await fixture(t),
    meta = secret + "x".repeat(70 * 1024);
  const value = f.wrap({
    content: [{ type: "text", text: "small" }],
    structuredContent: { ok: true },
    _meta: { host: meta },
  });
  const saved = await f.encoder.encode(value, f.scope());
  const response = await f.encoder.render(saved, f.scope(), run);
  assert.equal(response._meta.host, meta);
  assert.ok(Buffer.byteLength(JSON.stringify(modelOnly(response))) < 65536);
  noSecret(modelOnly(response));
  await assert.rejects(
    f.encoder.render(saved, f.scope({ grantId: undefined }), run),
    { code: "mcp_authorization_unavailable" },
  );
  const limited = new ResultEncoder(
    f.artifacts,
    { metaBytes: 1024 },
    undefined,
    f.router,
  );
  await assert.rejects(limited.encode(value, f.scope()), {
    code: "mcp_meta_too_large",
  });
  await assert.rejects(
    f.encoder.render(saved, f.scope(), run, { maxResponseBytes: 1024 }),
    { code: "mcp_response_too_large" },
  );
});

test("remote Resources enforce full text/metadata and final encoded response budgets", async (t) => {
  const f = await fixture(t);
  const uri = f.router.uri(f.source, "file:///remote/" + "long".repeat(200));
  await assert.rejects(
    f.router.readResource(uri, f.scope(), { textBytes: 256 }),
    { code: "resource_read_too_large" },
  );
  const ordinary = f.router.uri(f.source, "file:///remote/report.txt");
  await assert.rejects(
    f.router.listResources(f.source, f.scope(), undefined, { textBytes: 100 }),
    { code: "resource_list_too_large" },
  );
  await assert.rejects(
    f.router.readResource(ordinary, f.scope(), { responseBytes: 64 }),
    { code: "mcp_response_too_large" },
  );
  f.readWith(async (requested) => ({
    contents: [
      { uri: requested, mimeType: "image/png", blob: png().toString("base64") },
    ],
  }));
  await assert.rejects(
    f.router.readResource(ordinary, f.scope(), { imageBytes: 1 }),
    { code: "resource_read_too_large" },
  );
});

test("Registry native copies preserve branded nested results while automatic logs, progress and error diagnostics stay safe", async (t) => {
  const f = await fixture(t, { runtime: true });
  let issued;
  await f.extension({
    value(_input, call, options) {
      issued = call.output.mcpResult(
        {
          content: [{ type: "text", text: "remote body" }],
          structuredContent: { answer: 42 },
          _meta: { host: secret },
        },
        options,
      );
      call.log({
        level: "info",
        message: "received",
        data: { nested: issued },
      });
      call.progress({ nested: issued });
      return { nested: issued, again: [issued] };
    },
    fail(_input, call, options) {
      const remote = call.output.mcpResult(
        { content: [], _meta: { host: secret } },
        options,
      );
      throw new AgentError("remote_error", "Synthetic handler failure.", {
        remote,
      });
    },
    business(_input, call, options) {
      return call.output.mcpResult(
        { content: [{ type: "text", text: "business failed" }], isError: true },
        options,
      );
    },
  });
  const completed = await f.start(
    'const value=await remote.value({});if(value.nested._meta.host.length<1)throw Error("missing host meta");console.log(value);return value;',
  );
  assert.equal(
    completed.run.status,
    "succeeded",
    JSON.stringify(completed.run.error),
  );
  assert.equal(completed.result.mcpSources.length, 1);
  assert.equal(completed.result.data.nested.mcpResult, 0);
  assert.equal(completed.result.data.again[0].mcpResult, 0);
  assert.deepEqual(
    completed.result.mcpResults?.map((entry) => entry.mcpResult),
    [0],
  );
  const response = await f.encoder.render(
    completed.result,
    f.scope(),
    completed.run,
  );
  assert.equal(response._meta.host, secret);
  noSecret(modelOnly(response));
  assert.ok(mcpResult(issued));
  noSecret(f.logs);
  noSecret(f.progress);
  noSecret(completed.operations);
  const failure = await f.start("return remote.fail({});");
  assert.equal(failure.run.status, "failed");
  noSecret(failure.run.error);
  noSecret(failure.operations);
  const business = await f.start("return remote.business({});");
  assert.equal(business.run.status, "succeeded");
  assert.equal(business.result.isError, true);
  const logFiles = files(f.root).filter((name) => name.endsWith(".log"));
  assert.ok(logFiles.length > 0);
  for (const filename of logFiles)
    assert.equal(
      readFileSync(filename).includes(Buffer.from(secret)),
      false,
      path.relative(f.root, filename),
    );
});

test("an old remote resource coordinate cannot rebind to a replacement connection under the same namespace", async (t) => {
  const f = await fixture(t, { runtime: true });
  const handle = await f.extension({
    link(_input, call, options) {
      return call.output.mcpResult(
        {
          content: [
            {
              type: "resource_link",
              uri: "file:///remote/report.txt",
              name: "report.txt",
            },
          ],
        },
        options,
      );
    },
  });
  const completed = await f.start("return remote.link({});");
  assert.equal(
    completed.run.status,
    "succeeded",
    JSON.stringify(completed.run.error),
  );
  const response = await f.encoder.render(
    completed.result,
    f.scope(),
    completed.run,
    { textFallback: false },
  );
  const uri = response.content[0].uri;
  assert.equal(
    (await f.encoder.readResource(uri, f.scope())).contents[0].text,
    "remote body",
  );
  await f.registry.disable(handle);
  let replacementReads = 0;
  const closed = Promise.withResolvers();
  await f.extension({}, "two", {
    connection: "service",
    closed: closed.promise,
    assertCurrent() {},
    async readResource(requested) {
      replacementReads++;
      return { contents: [{ uri: requested, text: "new instance" }] };
    },
    dispose() {
      closed.resolve();
    },
  });
  await assert.rejects(f.encoder.readResource(uri, f.scope()), (error) =>
    ["mcp_source_unavailable", "extension_disabled"].includes(error.code),
  );
  await assert.rejects(
    f.encoder.render(completed.result, f.scope(), completed.run),
    (error) =>
      ["mcp_source_unavailable", "extension_disabled"].includes(error.code),
  );
  assert.equal(replacementReads, 0);
});

test("fixed image/audio/embedded history survives a closed source while an unresolved remote link still fails", async (t) => {
  const f = await fixture(t),
    image = png(),
    audio = wav();
  const blocks = [
    { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    { type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" },
    {
      type: "resource",
      resource: {
        uri: "file:///remote/embedded.txt",
        mimeType: "text/plain",
        text: "fixed history",
      },
    },
  ];
  const fixed = await f.encoder.encode(f.wrap({ content: blocks }), f.scope());
  const linked = await f.encoder.encode(
    f.wrap({
      content: [
        ...blocks,
        {
          type: "resource_link",
          uri: "file:///remote/not-downloaded.txt",
          name: "not-downloaded.txt",
        },
      ],
    }),
    f.scope(),
  );
  const resolves = f.resolves.length;
  f.reader.dispose();
  const response = await f.encoder.render(
    fixed,
    f.scope({ grantId: undefined }),
    run,
    { textFallback: false },
  );
  assert.deepEqual(Buffer.from(response.content[0].data, "base64"), image);
  assert.deepEqual(Buffer.from(response.content[1].data, "base64"), audio);
  assert.equal(response.content[2].resource.text, "fixed history");
  assert.equal(f.reads.length, 0);
  assert.equal(f.resolves.length, resolves);
  await assert.rejects(f.encoder.render(linked, f.scope(), run), {
    code: "mcp_source_unavailable",
  });
  assert.equal(f.reads.length, 0);
});

test("trusted MCP media respects individual, aggregate, final encoded and Host budgets", async (t) => {
  const f = await fixture(t),
    image = png(),
    audio = wav();
  const blocks = [
    { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    { type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" },
  ];
  let registrations = 0;
  const original = f.artifacts.register.bind(f.artifacts);
  t.mock.method(f.artifacts, "register", (...args) => {
    registrations++;
    return original(...args);
  });
  for (const [index, field, bytes] of [
    [0, "imageBytes", image],
    [1, "audioBytes", audio],
  ]) {
    const lower = new ResultEncoder(
      f.artifacts,
      { [field]: bytes.length - 1 },
      undefined,
      f.router,
    );
    await assert.rejects(
      lower.encode(f.wrap({ content: [blocks[index]] }), f.scope()),
      { code: "invalid_media_encoding" },
    );
    assert.equal(registrations, 0);
  }
  const exact = new ResultEncoder(
    f.artifacts,
    { inlineBytes: image.length + audio.length },
    undefined,
    f.router,
  );
  const saved = await exact.encode(f.wrap({ content: blocks }), f.scope());
  const response = await exact.render(saved, f.scope(), run);
  const lower = new ResultEncoder(
    f.artifacts,
    { inlineBytes: image.length + audio.length - 1 },
    undefined,
    f.router,
  );
  await assert.rejects(lower.encode(f.wrap({ content: blocks }), f.scope()), {
    code: "invalid_media_encoding",
  });
  await assert.rejects(lower.render(saved, f.scope(), run), {
    code: "inline_content_too_large",
  });
  const size = Buffer.byteLength(JSON.stringify(response));
  assert.deepEqual(
    await exact.render(saved, f.scope(), run, { maxResponseBytes: size }),
    response,
  );
  await assert.rejects(
    exact.render(saved, f.scope(), run, { maxResponseBytes: size - 1 }),
    { code: "mcp_response_too_large" },
  );
  await assert.rejects(
    exact.render(saved, f.scope(), run, {
      supportedImages: new Set(["image/jpeg"]),
    }),
    { code: "host_content_unsupported" },
  );
  await assert.rejects(
    exact.render(saved, f.scope(), run, {
      supportedAudio: new Set(["audio/ogg"]),
    }),
    { code: "host_content_unsupported" },
  );
});
