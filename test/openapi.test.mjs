import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareOpenApi } from "../dist/adapters/openapi.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { ResultEncoder } from "../dist/results/encoder.js";
import { ArtifactStore } from "../dist/results/artifacts.js";
import { AgentError } from "../dist/contracts/errors.js";
import { outputExtension } from "../dist/sdk/output-extension.js";

const caller = {
  principalId: "person",
  clientId: "client",
  host: "fixture-host",
};
const jsonResponse = (schema) => ({
  description: "Actual result",
  content: { "application/json": { schema } },
});
const operation = (extra = {}) => ({
  responses: { 200: jsonResponse({ type: "object" }) },
  ...extra,
});
const document = (paths) => ({
  openapi: "3.1.0",
  info: { title: "Fixture", version: "1.0.0" },
  paths,
});
function config(spec, serviceUrl, extra = {}) {
  return {
    name: "crm",
    revision: "approved-config-one",
    document: {
      location: "https://spec.example/openapi.json",
      bytes: JSON.stringify(spec),
    },
    serviceUrl,
    ...extra,
  };
}
async function peer(t, handler) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    });
    try {
      await handler(request, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, seen, server };
}
function send(response, value, status = 200, type = "application/json") {
  response.writeHead(status, { "content-type": type });
  response.end(type.includes("json") ? JSON.stringify(value) : value);
}
async function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-openapi-core-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(work, "snapshot.json"), '{"project":null}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 1000 });
  const policies = [],
    logs = [],
    handles = [],
    runs = [];
  let allowed = true;
  const registry = new ExtensionRegistry(resources, {
    permissions: new Set(["api.use", "output"]),
    authorize(policy) {
      policies.push(policy);
      if (!allowed)
        throw new AgentError("forbidden", "Current authority was revoked.");
    },
    log(...args) {
      logs.push(args);
    },
    progress() {},
  });
  const outputHandle = await registry.prepare(
    {
      apiVersion: 1,
      origin: {
        type: "platform",
        owner: "nexum-agent",
        namespace: "output",
        version: "0.0.1",
        revision: "fixture-output",
      },
      permissions: ["output"],
    },
    outputExtension,
  );
  registry.publish(outputHandle);
  handles.push(outputHandle);
  const loader = await ModuleLoader.create(work, store.bootId, {
    builtins: () => ["buffer"],
    approvedPackages: () => new Map(),
  });
  const scripts = new ScriptCatalog(work, "agent");
  const encoder = new ResultEncoder(new ArtifactStore(root, "agent"));
  const opened = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: "work/snapshot.json",
  });
  const outputScope = (runId) => ({
    pwd: work,
    ownerKey: callerKey(caller),
    grantId: "fixture-grant",
    runId,
    assertCurrent() {},
    authorize() {},
    authorizeTarget() {},
  });
  const engine = new RunEngine(store, loader, scripts, {
    authorize() {},
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef))),
    bindings: (services) => registry.bindings(services),
    resources,
    encodeResult: (value, services) =>
      encoder.encode(value, {
        ...outputScope(services.runId),
        signal: services.signal,
        assertCurrent: () => services.assertCurrent(),
      }),
    leaseScript: (origin) =>
      origin.type === "local" ? () => {} : registry.lease(origin),
  });
  t.after(async () => {
    allowed = true;
    for (const runId of runs)
      if (store.getRun(runId).endedAt === null) {
        engine.cancel(caller, runId);
        await engine.observe(caller, runId, 3000);
      }
    for (const handle of handles) await registry.disable(handle);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    resources,
    registry,
    engine,
    policies,
    logs,
    revoke() {
      allowed = false;
    },
    async install(value, options) {
      const adapter = await prepareOpenApi(value, options);
      const handle = await registry.prepare(
        {
          apiVersion: 1,
          origin: {
            type: "platform",
            owner: "nexum-agent",
            namespace: "api",
            version: "0.0.1",
            revision: adapter.revision,
          },
          permissions: adapter.permissions,
          bindingPath: adapter.bindingPath,
        },
        adapter.factory,
      );
      handles.push(handle);
      registry.publish(handle);
      return { adapter, handle };
    },
    async start(script, options = {}) {
      const result = await engine.start(caller, {
        contextId: opened.contextId,
        script,
        waitMs: 3000,
        ...options,
      });
      runs.push(result.run.runId);
      return result;
    },
    finish: (runId) => engine.observe(caller, runId, 4000),
    render: (view) =>
      encoder.render(view.result, outputScope(view.run.runId), view.run, {
        textFallback: false,
      }),
  };
}

test("real registry/engine API calls preserve parameter positions, operation precedence, schemas and revision-bound docs", async (t) => {
  const f = await fixture(t),
    server = await peer(t, (request, response) =>
      send(response, {
        path: request.url,
        tenant: request.headers["x-tenant"],
        cookie: request.headers.cookie,
      }),
    );
  const spec = document({
    "/things/{id}": {
      parameters: [
        { in: "query", name: "limit", schema: { type: "integer", maximum: 1 } },
      ],
      get: operation({
        operationId: "readThing",
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", maximum: 10 },
          },
          {
            in: "header",
            name: "X-Tenant",
            required: true,
            schema: { type: "string" },
          },
          { in: "cookie", name: "locale", schema: { type: "string" } },
        ],
      }),
    },
  });
  const { adapter, handle } = await f.install(config(spec, server.url + "/v1"));
  const result = await f.start(
    'return (await api.crm.readThing({path:{id:"x y"},query:{limit:7},headers:{"x-tenant":"team"},cookies:{locale:"en"}})).data;',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.match(result.result.data.path, /^\/v1\/things\/x%20y\?limit=7$/);
  assert.equal(result.result.data.tenant, "team");
  assert.equal(result.result.data.cookie, "locale=en");
  assert.equal(
    f.store.operationsForRun(result.run.runId)[0].status,
    "succeeded",
  );
  assert.ok(
    f.store
      .resourcesForRun(result.run.runId)
      .every((item) => item.status === "closed"),
  );
  const invalid = await f.start(
    'return await api.crm.readThing({path:{id:"x"},query:{limit:11},headers:{"X-Tenant":"team"}});',
  );
  assert.equal(invalid.run.status, "failed");
  assert.equal(server.seen.length, 1);
  assert.equal(adapter.catalog().sourceVersion, "3.1.0");
  assert.equal(adapter.catalog().ready, true);
  assert.match(adapter.documentation.markdown, /maximum.*10/);
  assert.equal(handle.methods[0].schemaDialect, "2020-12");
});

test("requestBody references, JSON scalar bodies and raw Swagger2 multipart files use the same public engine", async (t) => {
  const f = await fixture(t),
    server = await peer(t, async (request, response) => {
      if (request.url === "/legacy/a") {
        const wrapped = new Request("http://fixture/upload", {
          method: "POST",
          headers: request.headers,
          body: request,
          duplex: "half",
        });
        const form = await wrapped.formData(),
          file = form.get("file");
        send(response, {
          text: form.get("text"),
          name: file.name,
          bytes: [...new Uint8Array(await file.arrayBuffer())],
        });
      } else {
        let body = "";
        for await (const bytes of request) body += bytes;
        send(response, { value: JSON.parse(body) });
      }
    });
  const spec = document({
    "/scalar": {
      post: operation({
        operationId: "scalar",
        requestBody: { $ref: "#/components/requestBodies/Scalar" },
      }),
    },
  });
  spec.components = {
    requestBodies: {
      Scalar: {
        required: true,
        content: {
          "application/json": {
            schema: { type: ["number", "boolean", "null"] },
          },
        },
      },
    },
  };
  await f.install(config(spec, server.url));
  for (const value of [0, false, null]) {
    const done = await f.start(
      `return (await api.crm.scalar({body:${JSON.stringify(value)}})).data;`,
    );
    assert.equal(done.run.status, "succeeded", JSON.stringify(done));
    assert.equal(done.result.data.value, value);
  }
  const legacy = {
    swagger: "2.0",
    info: { title: "Legacy upload", version: "1" },
    consumes: ["multipart/form-data"],
    produces: ["application/json"],
    paths: {
      "/legacy/{id}": {
        post: {
          operationId: "upload",
          parameters: [
            { in: "path", name: "id", required: true, type: "string" },
            { in: "formData", name: "file", required: true, type: "file" },
            { in: "formData", name: "text", required: true, type: "string" },
          ],
          responses: { 200: { description: "ok", schema: { type: "object" } } },
        },
      },
    },
  };
  const setup = config(legacy, server.url);
  setup.name = "legacy";
  await f.install(setup);
  const uploaded = await f.start(
    `const {File}=await import("node:buffer");return (await api.legacy.upload({path:{id:"a"},body:{file:new File([new Uint8Array([2,4,6])],"actual.bin",{type:"application/octet-stream"}),text:${JSON.stringify('"hello"')}}})).data;`,
  );
  assert.equal(uploaded.run.status, "succeeded", JSON.stringify(uploaded));
  assert.deepEqual(uploaded.result.data.bytes, [2, 4, 6]);
  assert.equal(uploaded.result.data.name, "actual.bin");
  assert.equal(uploaded.result.data.text, '"hello"');
});

test("AND/OR auth uses protected credential provider and real caller identity without exposing secrets in results or docs", async (t) => {
  const f = await fixture(t),
    secret = "api-fixture-private-key",
    token = "fixture-bearer-private-token",
    seenCredentials = [];
  const server = await peer(t, (request, response) => {
    response.setHeader("X-Api-Key", secret);
    response.setHeader("Set-Cookie", "private-cookie");
    send(response, {
      key: request.headers["x-api-key"],
      authorization: request.headers.authorization,
      business: "ok",
    });
  });
  const spec = document({
    "/auth": {
      get: operation({
        operationId: "auth",
        security: [{ key: [], token: [] }, {}],
      }),
    },
  });
  spec.components = {
    securitySchemes: {
      key: { type: "apiKey", in: "header", name: "X-Api-Key" },
      token: { type: "http", scheme: "bearer" },
    },
  };
  const approved = config(spec, server.url, {
    authentication: {
      credentialBindings: { key: "credential:key", token: "credential:token" },
      operationSelections: { auth: 0 },
    },
  });
  const { adapter, handle } = await f.install(approved, {
    credentials: {
      async get(request) {
        seenCredentials.push(request);
        return request.scheme === "key"
          ? { type: "apiKey", value: secret }
          : { type: "bearer", token };
      },
    },
  });
  const result = await f.start("return await api.crm.auth();");
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.data.business, "ok");
  assert.equal(server.seen[0].headers["x-api-key"], secret);
  assert.equal(server.seen[0].headers.authorization, "Bearer " + token);
  assert.equal(seenCredentials.length, 2);
  assert.equal(
    seenCredentials[0].context.caller.principalId,
    caller.principalId,
  );
  assert.equal(seenCredentials[0].context.runId, result.run.runId);
  const publicText = JSON.stringify({
    result,
    catalog: adapter.catalog(),
    docs: adapter.documentation,
    methods: handle.methods,
    logs: f.logs,
    policies: f.policies,
  });
  for (const value of [
    secret,
    token,
    "private-cookie",
    "credential:key",
    "credential:token",
  ])
    assert.equal(publicText.includes(value), false, value);
  const anonymous = config(spec, server.url);
  anonymous.name = "anonymous";
  await f.install(anonymous);
  await f.start("return (await api.anonymous.auth()).status;");
  assert.equal(server.seen[1].headers.authorization, undefined);
  await assert.rejects(
    prepareOpenApi(
      config(spec, server.url, {
        authentication: {
          operationSelections: { auth: 0 },
          credentialBindings: { key: "credential:key" },
        },
      }),
      {
        credentials: {
          async get() {
            throw new Error("never");
          },
        },
      },
    ),
    { code: "api_authentication_required" },
  );
});

test("current authority revocation after credential retrieval starts prevents any network dispatch", async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const server = await peer(t, (_request, response) => send(response, {}));
  const spec = document({
    "/auth": {
      get: operation({ operationId: "auth", security: [{ key: [] }] }),
    },
  });
  spec.components = {
    securitySchemes: { key: { type: "apiKey", in: "query", name: "key" } },
  };
  await f.install(
    config(spec, server.url, {
      authentication: { credentialBindings: { key: "key-ref" } },
    }),
    {
      credentials: {
        async get() {
          entered.resolve();
          await release.promise;
          return { type: "apiKey", value: "private-query-key" };
        },
      },
    },
  );
  const running = await f.start("return await api.crm.auth();", { waitMs: 0 });
  await entered.promise;
  f.revoke();
  release.resolve();
  const ended = await f.finish(running.run.runId);
  assert.equal(ended.run.status, "failed");
  assert.equal(server.seen.length, 0);
  assert.ok(
    f.store
      .resourcesForRun(ended.run.runId)
      .every((item) => item.status === "closed"),
  );
  assert.equal(
    JSON.stringify({ ended, policies: f.policies }).includes(
      "private-query-key",
    ),
    false,
  );
});

test("HTTP errors remain failed operations with safe response data, and real image data reaches the existing output encoder", async (t) => {
  const f = await fixture(t),
    png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4J0AAAAASUVORK5CYII=",
      "base64",
    );
  const server = await peer(t, (request, response) =>
    request.url === "/image"
      ? send(response, png, 200, "image/png")
      : send(response, { reason: "missing" }, 404),
  );
  const spec = document({
    "/error": {
      get: operation({
        operationId: "error",
        responses: {
          404: jsonResponse({
            type: "object",
            required: ["reason"],
            properties: { reason: { type: "string" } },
          }),
        },
      }),
    },
    "/image": {
      get: operation({
        operationId: "image",
        responses: {
          200: {
            description: "PNG",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      }),
    },
  });
  await f.install(config(spec, server.url));
  const caught = await f.start(
    "try {await api.crm.error();} catch(error) {return {code:error.code,status:error.response.status,reason:error.response.data.reason};}",
  );
  assert.equal(caught.run.status, "succeeded", JSON.stringify(caught));
  assert.equal(caught.result.data.code, "api_http_error");
  assert.equal(caught.result.data.status, 404);
  assert.equal(caught.result.data.reason, "missing");
  assert.equal(f.store.operationsForRun(caught.run.runId)[0].status, "failed");
  const image = await f.start(
    "return output.image({data:(await api.crm.image()).data});",
  );
  assert.equal(image.run.status, "succeeded", JSON.stringify(image));
  const rendered = await f.render(image);
  assert.equal(
    rendered.content.find((item) => item.type === "image").data,
    png.toString("base64"),
  );
});

test("invalid identities, duplicated operations, unconfigured auth and unsupported schemes never create an available factory", async (t) => {
  const server = await peer(t, (_request, response) => send(response, {}));
  const duplicate = document({
    "/a": { get: operation({ operationId: "same" }) },
    "/b": { post: operation({ operationId: "same" }) },
  });
  await assert.rejects(prepareOpenApi(config(duplicate, server.url)), (error) =>
    ["api_operation_conflict", "api_invalid_specification"].includes(
      error.code,
    ),
  );
  await assert.rejects(
    prepareOpenApi(
      config(
        document({ "/ok": { get: operation() } }),
        server.url + "/?secret=value",
      ),
    ),
    { code: "api_invalid_service" },
  );
  const unsupported = document({
    "/auth": { get: operation({ security: [{ digest: [] }] }) },
  });
  unsupported.components = {
    securitySchemes: { digest: { type: "http", scheme: "digest" } },
  };
  await assert.rejects(prepareOpenApi(config(unsupported, server.url)), {
    code: "api_unsupported_authentication",
  });
  assert.equal(server.seen.length, 0);
});

test("Basic equivalent credentials and form-encoded query-key echoes are redacted through the real engine", async (t) => {
  const f = await fixture(t),
    pair = "public-user:",
    encoded = Buffer.from(pair).toString("base64"),
    key = "private query/key+with spaces";
  const server = await peer(t, (request, response) =>
    send(response, {
      encoded: request.headers.authorization?.slice(6) ?? "",
      url: request.url,
    }),
  );
  const basic = document({
    "/basic": {
      get: operation({ operationId: "read", security: [{ basic: [] }] }),
    },
  });
  basic.components = {
    securitySchemes: { basic: { type: "http", scheme: "basic" } },
  };
  const setup = config(basic, server.url, {
    authentication: { credentialBindings: { basic: "basic-ref" } },
  });
  setup.name = "basic";
  await f.install(setup, {
    credentials: {
      async get() {
        return { type: "basic", username: "public-user", password: "" };
      },
    },
  });
  const first = await f.start("return await api.basic.read();");
  assert.equal(first.run.status, "succeeded", JSON.stringify(first));
  assert.equal(JSON.stringify(first).includes(encoded), false);
  assert.equal(first.result.data.redacted, true);
  const query = document({
    "/query": {
      get: operation({ operationId: "read", security: [{ key: [] }] }),
    },
  });
  query.components = {
    securitySchemes: { key: { type: "apiKey", in: "query", name: "key" } },
  };
  const next = config(query, server.url, {
    authentication: { credentialBindings: { key: "query-ref" } },
  });
  next.name = "query";
  await f.install(next, {
    credentials: {
      async get() {
        return { type: "apiKey", value: key };
      },
    },
  });
  const second = await f.start("return await api.query.read();");
  assert.equal(second.run.status, "succeeded", JSON.stringify(second));
  assert.equal(
    JSON.stringify(second).includes(
      new URLSearchParams({ key }).toString().slice(4),
    ),
    false,
  );
  assert.equal(second.result.data.redacted, true);
});

test("wildcard request representations require a concrete MIME and support schema-free native binary", async (t) => {
  const f = await fixture(t),
    server = await peer(t, async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      send(response, {
        contentType: request.headers["content-type"],
        text: Buffer.concat(chunks).toString(),
      });
    });
  const spec = document({
    "/raw": {
      post: operation({
        operationId: "raw",
        requestBody: { required: true, content: { "*/*": {} } },
      }),
    },
  });
  await f.install(config(spec, server.url));
  const rejected = await f.start('return await api.crm.raw({body:"opaque"});');
  assert.equal(rejected.run.status, "failed");
  assert.equal(server.seen.length, 0);
  const valid = await f.start(
    'const {Blob}=await import("node:buffer");return (await api.crm.raw({contentType:"application/octet-stream",body:new Blob(["actual bytes"])})).data;',
  );
  assert.equal(valid.run.status, "succeeded", JSON.stringify(valid));
  assert.equal(valid.result.data.contentType, "application/octet-stream");
  assert.equal(valid.result.data.text, "actual bytes");
});
