import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  Server,
  SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

// A separate output directory lets adapter work be checked without mutating
// another worker's dist. All runtime imports must share that module graph.
const adapterUrl = process.env.NEXUM_MCP_ADAPTER_TEST_MODULE
  ? new URL(
      process.env.NEXUM_MCP_ADAPTER_TEST_MODULE,
      pathToFileURL(`${process.cwd()}/`),
    )
  : new URL("../dist/adapters/mcp.js", import.meta.url);
const moduleRoot = new URL("../", adapterUrl);
const [
  { createMcpAdapter },
  { SqliteStore },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { ResourceManager },
  { ExtensionRegistry },
  { ArtifactStore },
  { ResultEncoder },
  { AgentError },
  { McpResultResources },
] = await Promise.all([
  import(adapterUrl.href),
  import(new URL("storage/sqlite.js", moduleRoot)),
  import(new URL("runtime/modules.js", moduleRoot)),
  import(new URL("runtime/scripts.js", moduleRoot)),
  import(new URL("runtime/engine.js", moduleRoot)),
  import(new URL("extensions/resources.js", moduleRoot)),
  import(new URL("extensions/registry.js", moduleRoot)),
  import(new URL("results/artifacts.js", moduleRoot)),
  import(new URL("results/encoder.js", moduleRoot)),
  import(new URL("contracts/errors.js", moduleRoot)),
  import(new URL("results/mcp.js", moduleRoot)),
]);

const caller = { principalId: "user", clientId: "client", host: "test-host" };
const capabilities = { tools: {}, resources: {}, prompts: {} };
const fixtureProtocolVersions = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];
const echoInput = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: {
    value: { type: "integer" },
    tuple: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false,
      minItems: 2,
    },
    waitMs: { type: "integer", minimum: 0, maximum: 5000 },
  },
};
const tools = [
  {
    name: "echo-value",
    description: "Echo exact SDK arguments",
    inputSchema: echoInput,
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["name", "received"],
      additionalProperties: false,
      properties: { name: { const: "echo-value" }, received: echoInput },
    },
  },
  {
    name: "draft-seven",
    description: "Exercise explicit JSON Schema draft-07",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { value: { type: "integer" }, tag: { type: "string" } },
      required: ["value"],
      dependencies: { value: ["tag"] },
      additionalProperties: false,
    },
    outputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { const: "draft-seven" },
        received: {
          type: "object",
          required: ["value", "tag"],
          additionalProperties: false,
          properties: { value: { type: "integer" }, tag: { type: "string" } },
        },
      },
      dependencies: { name: ["received"] },
    },
  },
  {
    name: "fail-tool",
    description: "A tool-level failure is still a valid MCP result",
    inputSchema: { type: "object", additionalProperties: false },
  },
];

// This function is also serialized into the stdio child. It deliberately uses
// the official low-level SDK, never a hand-written JSON-RPC implementation.
function installHandlers(server, options, record) {
  const page = (request, items, key, label) => {
    record({
      method: label,
      cursor: request.params?.cursor ?? null,
      protocolVersion: server.getNegotiatedProtocolVersion() ?? null,
    });
    if (
      options.mode === "backpressure" &&
      label === "tools/list" &&
      request.params?.cursor === "second"
    ) {
      process.stdin.pause();
      record({ method: "stdin-paused" });
      setTimeout(() => {
        record({ method: "stdin-resumed" });
        process.stdin.resume();
      }, 500);
    }
    return request.params?.cursor === "second"
      ? { [key]: items.slice(1) }
      : { [key]: items.slice(0, 1), nextCursor: "second" };
  };
  if (options.capabilities.tools) {
    server.setRequestHandler("tools/list", (request) =>
      page(request, options.tools, "tools", "tools/list"),
    );
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const { name, arguments: input = {} } = request.params;
      record({
        method: "tools/call",
        name,
        input:
          typeof input.padding === "string"
            ? {
                ...input,
                padding: undefined,
                paddingBytes: Buffer.byteLength(input.padding),
              }
            : input,
      });
      if (input.waitMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, input.waitMs);
          ctx.mcpReq.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              record({ method: "cancelled", name, value: input.value });
              reject(ctx.mcpReq.signal.reason ?? new Error("Cancelled"));
            },
            { once: true },
          );
        });
      }
      if (name === "fail-tool")
        return {
          content: [{ type: "text", text: "fixture business failure" }],
          structuredContent: { reason: "fixture-only" },
          isError: true,
        };
      if (options.mode === "close-after-call")
        setTimeout(() => process.exit(0), 500);
      return {
        content: [{ type: "text", text: `${name}:${input.value}` }],
        structuredContent: { name, received: input },
        isError: false,
      };
    });
  }
  if (options.capabilities.resources) {
    const resources = [1, 2].map((number) => ({
      uri: `fixture://document/${number}`,
      name: `Document ${number}`,
      mimeType: "text/plain",
    }));
    const templates = [1, 2].map((number) => ({
      uriTemplate: `fixture://template-${number}/{id}`,
      name: `Template ${number}`,
    }));
    server.setRequestHandler("resources/list", (request) =>
      page(request, resources, "resources", "resources/list"),
    );
    server.setRequestHandler("resources/templates/list", (request) =>
      page(request, templates, "resourceTemplates", "resources/templates/list"),
    );
    server.setRequestHandler("resources/read", (request) => {
      record({ method: "resources/read", uri: request.params.uri });
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/plain",
            text: "fixture resource body",
          },
        ],
      };
    });
  }
  if (options.capabilities.prompts) {
    const prompts = [1, 2].map((number) => ({
      name: `prompt-${number}`,
      description: `Prompt ${number}`,
      arguments: [{ name: "topic", required: true }],
    }));
    server.setRequestHandler("prompts/list", (request) =>
      page(request, prompts, "prompts", "prompts/list"),
    );
    server.setRequestHandler("prompts/get", (request) => {
      record({ method: "prompts/get", name: request.params.name });
      return {
        description: "fixture prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Write about ${request.params.arguments?.topic}`,
            },
          },
        ],
      };
    });
  }
}

async function until(predicate, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail(message);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function events(filename) {
  return existsSync(filename)
    ? readFileSync(filename, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
}
async function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-mcp-adapter-")),
  );
  const workDir = path.join(root, "work");
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(workDir, "snapshot.json"), '{"project":null}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 1500 });
  const logs = [],
    policies = [],
    handles = [],
    cleanups = [];
  const registry = new ExtensionRegistry(resources, {
    cleanupTimeoutMs: 1500,
    permissions: new Set(["mcp.use"]),
    authorize(policy) {
      policies.push(policy);
    },
    log(...args) {
      logs.push(args);
    },
    progress() {},
  });
  const scripts = new ScriptCatalog(workDir, "agent", () => []);
  const loader = await ModuleLoader.create(workDir, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const mcpResources = new McpResultResources({
    agentId: "agent",
    profileRoot: root,
    resolveResource: (source, scope) =>
      registry.resolveMcpResource(source, scope),
  });
  const encoder = new ResultEncoder(
    new ArtifactStore(root, "agent"),
    {},
    undefined,
    mcpResources,
  );
  const work = store.openWork({
    callerKey: callerKey(caller),
    pwd: workDir,
    snapshotRef: "work/snapshot.json",
  });
  const engine = new RunEngine(store, loader, scripts, {
    authorize() {},
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    encodeResult: (value, services) =>
      encoder.encode(value, {
        pwd: workDir,
        ownerKey: callerKey(caller),
        grantId: "fixture-grant",
        runId: services.runId,
        signal: services.signal,
        assertCurrent: () => services.assertCurrent(),
        authorize() {},
        authorizeTarget(target) {
          policies.push({ action: "encode-result", target });
        },
      }),
    bindings: (services) => registry.bindings(services),
    resources,
    leaseScript: (origin) =>
      origin.type === "local" ? () => {} : registry.lease(origin),
  });
  t.after(async () => {
    for (const handle of handles)
      await registry.disable(handle).catch(() => {});
    for (const cleanup of cleanups) await cleanup();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workDir,
    store,
    registry,
    engine,
    logs,
    policies,
    handles,
    cleanups,
    async prepare(config, options, transformHost = (host) => host) {
      const adapter = createMcpAdapter(config, options);
      const origin = {
        type: "platform",
        owner: "@test/mcp",
        namespace: "mcp",
        version: "1",
        revision: `fixture-${config.name}`,
      };
      const source = {
        apiVersion: 1,
        origin,
        permissions: adapter.permissions,
        bindingPath: adapter.bindingPath,
      };
      const handle = await registry.prepare(source, (host) =>
        adapter.factory(transformHost(host)),
      );
      handles.push(handle);
      return { adapter, handle, source };
    },
    start(script, options = {}) {
      return engine.start(caller, {
        contextId: work.contextId,
        script,
        waitMs: 3000,
        ...options,
      });
    },
    finish: (runId) => engine.observe(caller, runId, 4000),
    render(view) {
      return encoder.render(
        view.result,
        {
          pwd: workDir,
          ownerKey: callerKey(caller),
          grantId: "fixture-grant",
          runId: view.run.runId,
          assertCurrent() {},
          authorize() {},
          authorizeTarget(target) {
            policies.push({ action: "render-result", target });
          },
        },
        view.run,
        { textFallback: false },
      );
    },
    history() {
      return store
        .scanResourceHistory(
          {
            owner: "@test/mcp",
            namespace: "mcp",
            type: "platform",
          },
          callerKey(caller),
        )
        .items.map((item) => item.record);
    },
  };
}
function stdioFixture(t, f, options = {}) {
  const filename = path.join(f.root, `mcp-${options.name ?? "fixture"}.mjs`);
  const trace = `${filename}.events`;
  const childOptions = {
    capabilities,
    tools,
    protocolVersions: fixtureProtocolVersions,
    ...options,
  };
  writeFileSync(
    filename,
    `
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Server, ProtocolError, METHOD_NOT_FOUND } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};
import { StdioServerTransport, serveStdio } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};
const options = ${JSON.stringify(childOptions)};
const record = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ at: Date.now(), ...value }) + "\\n");
record({ method: "spawn", pid: process.pid });
process.on("exit", () => record({ method: "exit" }));
if (options.mode === "idle") {
  process.stdin.resume();
} else if (options.mode === "exit") {
  process.exit(23);
} else if (options.mode === "root-exit-with-child") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  record({ method: "child-pid", pid: child.pid });
  process.exit(23);
} else {
  const transport = new StdioServerTransport();
  serveStdio(() => {
    const server = new Server({ name: "Nexum local MCP fixture", version: "1.0.0" }, { capabilities: options.capabilities, supportedProtocolVersions: options.protocolVersions });
    (${installHandlers.toString()})(server, options, record);
    if (options.legacyOnly) {
      const connect = server.connect.bind(server);
      server.connect = async (channel) => {
        server.setRequestHandler("server/discover", () => {
          record({ method: "server/discover", fallback: true });
          throw new ProtocolError(METHOD_NOT_FOUND, "The legacy fixture does not implement discovery.");
        });
        return connect(channel);
      };
    }
    return server;
  }, { transport });
  const receive = transport.onmessage;
  transport.onmessage = (message, ...extra) => {
    record({ method: "incoming", name: message.method });
    return receive?.(message, ...extra);
  };
}
`,
  );
  f.cleanups.push(() => {
    for (const event of events(trace).filter((event) =>
      ["spawn", "child-pid"].includes(event.method),
    ))
      if (event.pid && alive(event.pid)) process.kill(event.pid, "SIGKILL");
  });
  return {
    config: {
      name: options.name ?? "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [filename],
      cwd: f.workDir,
    },
    events: () => events(trace),
    pid: () => events(trace).find((event) => event.method === "spawn")?.pid,
  };
}
async function httpFixture(t, options = {}) {
  const seen = [];
  const server = new Server(
    { name: "Nexum HTTP fixture", version: "1.0.0" },
    { capabilities, supportedProtocolVersions: fixtureProtocolVersions },
  );
  installHandlers(server, { capabilities, tools, ...options }, (event) =>
    seen.push(event),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => "fixture-session",
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const http = createServer(async (request, response) => {
    seen.push({
      method: "http",
      verb: request.method,
      authorization: request.headers.authorization,
    });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const webRequest = new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(body.length ? { body, duplex: "half" } : {}),
      });
      const result = await transport.handleRequest(webRequest);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body).pipe(response);
      else response.end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, seen };
}

test("MCP configuration rejects unsupported fields and transports before connecting", async () => {
  const valid = {
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
  };
  for (const config of [
    { ...valid, shell: true },
    { ...valid, transport: "sse" },
    { ...valid, command: "" },
    { ...valid, env: { TOKEN: 7 } },
    { ...valid, args: [7] },
    { name: "fixture", transport: "streamable-http", url: "not a URL" },
    {
      name: "fixture",
      transport: "streamable-http",
      url: "http://127.0.0.1",
      oauth: {},
    },
  ])
    assert.throws(() => createMcpAdapter(config));
  assert.throws(() => createMcpAdapter(valid, { requestTimeoutMs: -1 }));
  assert.throws(() => createMcpAdapter(valid, { unknown: true }));
});

test("real stdio SDK tools retain hyphenated names, schema dialects and standard result semantics", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  assert.deepEqual(
    adapter.catalog().tools.map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
  assert.equal(
    adapter.catalog().protocolVersion,
    peer.events().find((event) => event.method === "tools/list")
      .protocolVersion,
  );
  assert.ok(
    fixtureProtocolVersions.includes(adapter.catalog().protocolVersion),
  );
  assert.match(
    adapter.catalog().protocolVersion,
    /^2026-/,
    JSON.stringify(peer.events()),
  );
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 7, tuple: ["first", 2] });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.deepEqual((await f.render(result)).content, [
    { type: "text", text: "echo-value:7" },
  ]);
  assert.deepEqual(result.result.data, {
    name: "echo-value",
    received: { value: 7, tuple: ["first", 2] },
  });
  const invalid = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 7, tuple: [2, "wrong"] });',
  );
  assert.equal(invalid.run.status, "failed");
  const missingDependency = await f.start(
    'return await mcp.fixture.tools["draft-seven"]({ value: 9 });',
  );
  assert.equal(missingDependency.run.status, "failed");
  const draft7 = await f.start(
    'return await mcp.fixture.tools["draft-seven"]({ value: 9, tag: "ok" });',
  );
  assert.equal(draft7.run.status, "succeeded", JSON.stringify(draft7));
  const mutated = await f.start(
    'const args = { value: 71 }; const pending = mcp.fixture.tools["echo-value"](args); args.value = "after"; return await pending;',
  );
  assert.equal(mutated.run.status, "succeeded", JSON.stringify(mutated));
  assert.equal(mutated.result.data.received.value, 71);
  const failure = await f.start(
    'return await mcp.fixture.tools["fail-tool"]({});',
  );
  assert.equal(failure.run.status, "succeeded", JSON.stringify(failure));
  assert.equal(failure.result.isError, true);
  assert.deepEqual(failure.result.data, { reason: "fixture-only" });
  assert.equal(failure.result.content[0].text, "fixture business failure");
  assert.deepEqual(
    peer
      .events()
      .filter((event) => event.method === "tools/call")
      .map((event) => event.name),
    ["echo-value", "draft-seven", "echo-value", "fail-tool"],
  );
  assert.equal(f.store.operationsForRun(result.run.runId).length, 1);
});

test("two real runs share one connection and cancelling one request leaves the other usable", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const first = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 1, waitMs: 3000 });',
    { waitMs: 0 },
  );
  const second = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 2, waitMs: 250 });',
    { waitMs: 0 },
  );
  await until(
    () =>
      peer.events().filter((event) => event.method === "tools/call").length ===
      2,
    "Both requests should reach the same MCP process",
  );
  f.engine.cancel(caller, first.run.runId);
  const cancelled = await f.finish(first.run.runId),
    completed = await f.finish(second.run.runId);
  assert.equal(cancelled.run.status, "cancelled");
  await until(
    () =>
      peer
        .events()
        .some((event) => event.method === "cancelled" && event.value === 1),
    "Run cancellation must reach the SDK request's abort signal",
  );
  assert.equal(completed.run.status, "succeeded", JSON.stringify(completed));
  assert.equal(completed.result.data.received.value, 2);
  assert.equal(
    peer.events().filter((event) => event.method === "spawn").length,
    1,
  );
  assert.equal(alive(peer.pid()), true);
  const third = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 3 });',
  );
  assert.equal(third.run.status, "succeeded", JSON.stringify(third));
  assert.ok(f.history().length > 0);
  assert.ok(
    f
      .history()
      .every(
        (resource) =>
          resource.lifetime === "instance" && resource.status === "registered",
      ),
  );
  assert.ok(
    f
      .history()
      .some(
        (resource) =>
          resource.createdAt <=
          peer.events().find((event) => event.method === "spawn").at,
      ),
  );
  const report = await f.registry.disable(handle);
  assert.equal(report.status, "disabled", JSON.stringify(report));
  await until(
    () => !alive(peer.pid()),
    "Disabling must await actual child-process exit",
  );
  assert.ok(
    f
      .history()
      .every(
        (resource) =>
          resource.status === "closed" && resource.closedAt !== null,
      ),
  );
});

test("resource and prompt capabilities follow every catalog page and preserve standard response bodies", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const catalog = adapter.catalog();
  assert.equal(catalog.resources.length, 2);
  assert.equal(catalog.resourceTemplates.length, 2);
  assert.equal(catalog.prompts.length, 2);
  for (const method of [
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "prompts/list",
  ])
    assert.deepEqual(
      peer
        .events()
        .filter((event) => event.method === method)
        .map((event) => event.cursor),
      [null, "second"],
    );
  const read = await f.start(
    'return await mcp.fixture.resources.read({ uri: "fixture://document/2" });',
  );
  assert.equal(read.run.status, "succeeded", JSON.stringify(read));
  const deliveredRead = await f.render(read);
  assert.equal(deliveredRead.content[0].type, "resource");
  assert.equal(deliveredRead.content[0].resource.text, "fixture resource body");
  assert.match(deliveredRead.content[0].resource.mimeType, /^text\/plain/);
  const prompt = await f.start(
    'return await mcp.fixture.prompts.get({ name: "prompt-2", arguments: { topic: "local-first" } });',
  );
  assert.equal(prompt.run.status, "succeeded", JSON.stringify(prompt));
  assert.deepEqual(prompt.result.data, {
    description: "fixture prompt",
    messages: [{ role: "user", contentIndex: 0 }],
  });
  assert.deepEqual((await f.render(prompt)).content, [
    { type: "text", text: "Write about local-first" },
  ]);
  const list = await f.start(
    'return await mcp.fixture.resources.list({ cursor: "second" });',
  );
  assert.equal(list.run.status, "succeeded", JSON.stringify(list));
  assert.equal(list.result.data.resources[0].uri, "fixture://document/2");
});

test("a server without resource or prompt capabilities does not gain synthetic entry points", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { capabilities: { tools: {} } });
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const result = await f.start(
    'return { resources: typeof mcp.fixture.resources, prompts: typeof mcp.fixture.prompts, tools: typeof mcp.fixture.tools["echo-value"] };',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.result.data, {
    resources: "undefined",
    prompts: "undefined",
    tools: "function",
  });
  assert.deepEqual(adapter.catalog().resources, []);
  assert.deepEqual(adapter.catalog().prompts, []);
  assert.equal(
    peer.events().some((event) => /^(resources|prompts)\//.test(event.method)),
    false,
  );
});

test("real Streamable HTTP uses configured static headers without publishing credentials", async (t) => {
  const f = await fixture(t),
    peer = await httpFixture(t);
  const secret = "Bearer fixture-private-token";
  const { adapter, handle } = await f.prepare({
    name: "fixture",
    transport: "streamable-http",
    url: peer.url,
    headers: { Authorization: secret },
  });
  f.registry.publish(handle);
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 31 });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.received.value, 31);
  assert.ok(peer.seen.filter((event) => event.method === "http").length >= 3);
  assert.ok(
    peer.seen
      .filter((event) => event.method === "http")
      .every((event) => event.authorization === secret),
  );
  const published = JSON.stringify({
    catalog: adapter.catalog(),
    methods: handle.methods,
    logs: f.logs,
    history: f.history(),
  });
  assert.equal(published.includes(secret), false);
  assert.equal(published.includes("fixture-private-token"), false);
  assert.equal(published.includes("Authorization"), false);
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.ok(f.history().every((resource) => resource.status === "closed"));
});

test("failed stdio initialization closes registered resources and waits for actual process exit", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { mode: "idle" });
  await assert.rejects(f.prepare(peer.config, { connectTimeoutMs: 2500 }));
  const pid = await until(
    () => peer.pid(),
    "The local failure fixture must actually start",
  );
  await until(
    () => !alive(pid),
    "Initialization failure must close the real child",
  );
  const history = f.history();
  assert.ok(
    history.length > 0,
    "The transport must be registered before it can fail",
  );
  assert.ok(
    history.every(
      (resource) => resource.status === "closed" && resource.closedAt !== null,
    ),
    JSON.stringify(history),
  );
  assert.equal(Object.hasOwn(f.registry.bindings({}), "mcp"), false);
});

test("catalog budget failure cleans up the peer and never publishes a partial capability surface", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  await assert.rejects(f.prepare(peer.config, { maxCatalogItems: 1 }));
  const pid = await until(
    () => peer.pid(),
    "The budget fixture must actually start",
  );
  await until(() => !alive(pid), "Catalog failure must close its MCP process");
  assert.ok(f.history().length > 0);
  assert.ok(f.history().every((resource) => resource.status === "closed"));
  assert.equal(Object.hasOwn(f.registry.bindings({}), "mcp"), false);
});

test("a request timeout fails its operation while the shared SDK connection remains usable", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { handle } = await f.prepare(peer.config, { requestTimeoutMs: 200 });
  f.registry.publish(handle);
  const timedOut = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 41, waitMs: 500 });',
  );
  assert.equal(timedOut.run.status, "failed", JSON.stringify(timedOut));
  assert.equal(
    f.store.operationsForRun(timedOut.run.runId)[0].status,
    "failed",
  );
  assert.equal(alive(peer.pid()), true);
  const next = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 42 });',
  );
  assert.equal(next.run.status, "succeeded", JSON.stringify(next));
  assert.equal(next.result.data.received.value, 42);
  assert.equal(
    peer.events().filter((event) => event.method === "spawn").length,
    1,
  );
});

test(
  "stdio initialization failure reaps a surviving process group after its root exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      peer = stdioFixture(t, f, { mode: "root-exit-with-child" });
    await assert.rejects(f.prepare(peer.config, { connectTimeoutMs: 2500 }));
    const child = peer
      .events()
      .find((event) => event.method === "child-pid")?.pid;
    assert.ok(
      child,
      "The real fixture must start a descendant that inherits stdout",
    );
    await until(() => !alive(peer.pid()), "The MCP root process must exit");
    await until(
      () => !alive(child),
      "Resource closure must stop the surviving descendant",
    );
    assert.ok(f.history().length > 0);
    assert.ok(
      f
        .history()
        .every(
          (resource) =>
            resource.status === "closed" && resource.closedAt !== null,
        ),
      JSON.stringify(f.history()),
    );
    assert.equal(Object.hasOwn(f.registry.bindings({}), "mcp"), false);
  },
);

test("naturally closed stdio connections can be disabled repeatedly without reporting an already closed resource", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { mode: "close-after-call" });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 51 });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  await until(
    () => !alive(peer.pid()),
    "The fixture should close its own stdio connection",
  );
  await until(
    () =>
      f.history().length > 0 &&
      f.history().every((resource) => resource.status === "closed"),
    "Resource history must observe natural physical closure",
  );
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.equal((await f.registry.disable(handle)).status, "disabled");
});

test("external run cancellation waits for real stdio backpressure and a cancelled queued call is never sent later", async (t) => {
  const f = await fixture(t);
  const paddedTools = tools.map((tool) =>
    tool.name === "echo-value"
      ? {
          ...tool,
          inputSchema: {
            ...echoInput,
            properties: {
              ...echoInput.properties,
              padding: { type: "string", maxLength: 2 * 1024 * 1024 },
            },
          },
        }
      : tool,
  );
  const peer = stdioFixture(t, f, {
    mode: "backpressure",
    capabilities: { tools: {} },
    tools: paddedTools,
  });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  await until(
    () => peer.events().some((event) => event.method === "stdin-paused"),
    "The real MCP fixture must pause stdin",
  );
  const first = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 61, waitMs: 3000, padding: "x".repeat(1024 * 1024) });',
    { waitMs: 0 },
  );
  await until(
    () =>
      f.store
        .operationsForRun(first.run.runId)
        .some((operation) => operation.status === "running"),
    "The first operation must enter its pipe write",
  );
  await delay(20);
  const second = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 62 });',
    { waitMs: 0 },
  );
  await until(
    () =>
      f.store
        .operationsForRun(second.run.runId)
        .some((operation) => operation.status === "running"),
    "The second operation must join the transport queue",
  );
  f.engine.cancel(caller, second.run.runId);
  f.engine.cancel(caller, first.run.runId);
  await delay(20);
  assert.equal(
    peer.events().some((event) => event.method === "stdin-resumed"),
    false,
    "Cancellation should happen during actual backpressure",
  );
  const stopping = await f.engine.observe(caller, first.run.runId, 0);
  assert.equal(stopping.run.status, "cancelling", JSON.stringify(stopping));
  const cancelledFirst = await f.finish(first.run.runId),
    cancelledSecond = await f.finish(second.run.runId);
  assert.equal(cancelledFirst.run.status, "cancelled");
  assert.equal(cancelledSecond.run.status, "cancelled");
  assert.equal(
    peer.events().some((event) => event.method === "stdin-resumed"),
    true,
  );
  await until(
    () =>
      peer
        .events()
        .some((event) => event.method === "cancelled" && event.value === 61),
    "The first frame and its cancellation must actually reach the SDK",
  );
  assert.equal(
    peer
      .events()
      .some(
        (event) => event.method === "tools/call" && event.input.value === 62,
      ),
    false,
  );
  assert.equal(
    peer
      .events()
      .find(
        (event) => event.method === "tools/call" && event.input.value === 61,
      )?.input.paddingBytes,
    1024 * 1024,
  );
  const next = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 63 });',
  );
  assert.equal(next.run.status, "succeeded", JSON.stringify(next));
  assert.equal(next.result.data.received.value, 63);
});

test("resource reporting failure cannot escape a native event or prevent actual stdio process cleanup", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  let rejectReports = false,
    failures = 0;
  const registered = [];
  const { handle } = await f.prepare(peer.config, undefined, (host) => ({
    ...host,
    resources: {
      ...host.resources,
      async register(input) {
        const ref = await host.resources.register(input);
        registered.push(input.value);
        return Object.freeze({
          ...ref,
          report(details) {
            if (rejectReports) {
              failures++;
              throw new AgentError(
                "fixture_report_failed",
                "Controlled resource reporting failure.",
              );
            }
            ref.report(details);
          },
        });
      },
    },
  }));
  f.registry.publish(handle);
  assert.equal(alive(peer.pid()), true);
  rejectReports = true;
  await f.registry.disable(handle).catch(() => {});
  assert.ok(
    failures > 0,
    "The real backend event path must encounter the controlled report failure",
  );
  await until(
    () => !alive(peer.pid()),
    "Reporting failure must not prevent native process termination",
  );
  await Promise.all(registered.map((resource) => resource.closed));
  await until(
    () =>
      f.history().length > 0 &&
      f.history().every((resource) => resource.status === "closed"),
    "The store must retain actual closed-resource evidence despite report failure",
  );
});

test("auto negotiation falls back to a real legacy initialize handshake after official MethodNotFound discovery", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { legacyOnly: true });
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  assert.equal(
    peer
      .events()
      .some((event) => event.method === "server/discover" && event.fallback),
    true,
    JSON.stringify(peer.events()),
  );
  assert.match(adapter.catalog().protocolVersion, /^2025-/);
  assert.equal(
    adapter.catalog().protocolVersion,
    peer.events().find((event) => event.method === "tools/list")
      .protocolVersion,
  );
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 81 });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.received.value, 81);
});
