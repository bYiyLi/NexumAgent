import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  ConfigurationMaintenanceBackend,
  configurationDirectoryName,
} from "../dist/maintenance/configuration.js";
import { CredentialVault } from "../dist/maintenance/credentials.js";
import {
  MaintenanceRequests,
  maintenanceIntent,
} from "../dist/maintenance/requests.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { callerKey } from "../dist/contracts/caller.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine } from "../dist/runtime/engine.js";
import { AgentError } from "../dist/contracts/errors.js";

const caller = { principalId: "owner", clientId: "host", grantId: "grant" };
const clone = (value) => JSON.parse(JSON.stringify(value));
const files = (root) =>
  readdirSync(root, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? files(path.join(root, item.name))
      : [path.join(root, item.name)],
  );
function schema(base, authentication = false) {
  return {
    openapi: "3.1.0",
    info: { title: "Fixture", version: "1" },
    servers: [{ url: base }],
    ...(authentication
      ? {
          components: {
            securitySchemes: {
              key: { type: "apiKey", in: "header", name: "X-API-Key" },
            },
          },
          security: [{ key: [] }],
        }
      : {}),
    paths: {
      "/value": {
        get: {
          operationId: "read",
          responses: {
            200: {
              description: "Value",
              content: {
                "application/json": { schema: { $ref: "./value.json" } },
              },
            },
          },
        },
      },
    },
  };
}
async function server(t, route) {
  const seen = [],
    server = createServer(async (req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      try {
        await route(req, res);
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { url: "http://127.0.0.1:" + server.address().port, seen, server };
}
const send = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

class Authority {
  records = new Map();
  async create(identity, input) {
    const id = "maint_req_" + (this.records.size + 1),
      now = Date.now(),
      view = {
        ...clone(input),
        requestId: id,
        agentId: identity.agentId,
        profile: identity.profile,
        status: "pending",
        revision: 1,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1800000).toISOString(),
        approvalUrl: "https://cloud.example/authorize/maintenance/" + id,
      };
    delete view.requestKey;
    delete view.originRunId;
    this.records.set(id, view);
    return clone(view);
  }
  async get(_identity, id) {
    return clone(this.records.get(id));
  }
  decision(...args) {
    return this.get(...args);
  }
  edit(id, candidate) {
    Object.assign(this.records.get(id), clone(candidate), {
      revision: this.records.get(id).revision + 1,
    });
  }
  approve(id) {
    const view = this.records.get(id);
    view.status = "approved";
    view.decidedAt = new Date().toISOString();
    view.decision = {
      status: "approved",
      revision: view.revision,
      candidateRevision: view.candidateRevision,
      decidedAt: view.decidedAt,
      decisionId: "decision-" + id,
    };
    delete view.approvalUrl;
  }
  async beginExecution(_identity, input) {
    const view = this.records.get(input.requestId);
    assert.equal(view.candidateRevision, input.approvedRevision);
    assert.equal(view.revision, input.decisionRevision);
    view.execution = {
      operationId: input.operationId,
      startedAt: new Date().toISOString(),
    };
    return clone(view);
  }
}
async function fixture(t, overrides = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-config-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  const store = new SqliteStore(root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    }),
    vault = await CredentialVault.open(root),
    active = new Map(),
    events = [],
    authorizations = [],
    closers = [];
  let allowed = true,
    sequence = 0;
  const originContext = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: "work/snapshot.json",
  });
  const originRun = store.acceptRun({
    callerKey: callerKey(caller),
    contextId: originContext.contextId,
    sourceKind: "inline",
    source: {},
  }).run;
  const scope = (signal = new AbortController().signal, identity = caller) => ({
    caller: identity,
    signal,
    operationId: "scope-" + ++sequence,
    runId: originRun.runId,
    pwd: work,
    assertCurrent() {
      signal.throwIfAborted();
      if (!allowed) throw new AgentError("forbidden", "Revoked.");
    },
    authorize(target) {
      if (!allowed) throw new AgentError("forbidden", "Revoked.");
      authorizations.push(clone(target));
    },
  });
  const activation = {
    async prepare(input, authority) {
      authority.assertCurrent();
      events.push({ type: "prepare", input });
      if (overrides.prepare) await overrides.prepare(input, authority);
      let published = false;
      return {
        publish() {
          authority.assertCurrent();
          overrides.publish?.(input);
          active.set(input.kind + ":" + input.name, input);
          published = true;
          events.push({ type: "publish", input });
        },
        async dispose() {
          events.push({ type: "dispose", input, published });
        },
      };
    },
    async remove(input, authority) {
      authority.assertCurrent();
      events.push({ type: "remove", input });
      active.delete(input.kind + ":" + input.name);
    },
  };
  const options = {
    root,
    agentId: "agent",
    profile: "development",
    credentials: vault,
    activation,
    runtimeScope: (request) => scope(request.signal, request.context.caller),
    ...overrides.options,
  };
  let backend = await ConfigurationMaintenanceBackend.open(options);
  const authority = new Authority(),
    requests = new MaintenanceRequests(store, authority, backend, {
      approvalOrigin: "https://cloud.example",
    });
  t.after(async () => {
    for (const close of closers) await close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    vault,
    backend,
    authority,
    requests,
    active,
    events,
    scope,
    authorizations,
    options,
    closers,
    revoke() {
      allowed = false;
    },
    allow() {
      allowed = true;
    },
    async reopen() {
      backend = await ConfigurationMaintenanceBackend.open(options);
      return backend;
    },
    intent(method, args) {
      return maintenanceIntent(method, args, work);
    },
  };
}

async function mountedApi(f, namespace = "crm") {
  const resources = new ResourceManager(f.store, { cleanupTimeoutMs: 1000 }),
    registry = new ExtensionRegistry(resources, {
      permissions: new Set(["api.use"]),
      authorize() {
        f.scope().assertCurrent();
      },
      log() {},
      progress() {},
    });
  const api = f.active.get("api:" + namespace).api,
    handle = await registry.prepare(
      {
        apiVersion: 1,
        origin: {
          type: "platform",
          owner: "nexum-agent",
          namespace: "api",
          version: "0.0.1",
          revision: api.revision,
        },
        permissions: api.permissions,
        bindingPath: api.bindingPath,
      },
      api.factory,
    );
  registry.publish(handle);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await registry.disable(handle);
    }
  };
  f.closers.push(close);
  writeFileSync(path.join(f.work, "package.json"), '{"type":"module"}');
  const loader = await ModuleLoader.create(f.work, f.store.bootId, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    }),
    scripts = new ScriptCatalog(f.work, "agent"),
    opened = f.store.openWork({
      callerKey: callerKey(caller),
      pwd: f.work,
      snapshotRef: "work/snapshot.json",
    });
  const engine = new RunEngine(f.store, loader, scripts, {
    authorize() {
      f.scope().assertCurrent();
    },
    loadWork: () => ({ project: null }),
    bindings: (services) => registry.bindings(services),
    resources,
    encodeResult: async (value) => clone(value),
    leaseScript: (origin) =>
      origin.type === "local" ? () => {} : registry.lease(origin),
  });
  return { engine, contextId: opened.contextId, close };
}

test("API import fixes authorized source/ref bytes, exposes safe editable authentication, and only exact user confirmation activates", async (t) => {
  let base;
  const http = await server(t, (req, res) =>
    req.url === "/openapi.json"
      ? send(res, schema(base, true))
      : req.url === "/value.json"
        ? send(res, {
            type: "object",
            required: ["value"],
            properties: { value: { type: "string" } },
            additionalProperties: false,
          })
        : send(res, { value: "business" }),
  );
  base = http.url;
  const f = await fixture(t),
    scope = f.scope(),
    created = await f.requests
      .bind(scope)
      .api.import({ name: "crm", url: base + "/openapi.json" });
  assert.equal(f.events.length, 0);
  assert.equal(f.active.size, 0);
  assert.equal(created.status, "pending");
  await assert.rejects(f.requests.execute(created.requestId, f.scope()), {
    code: "maintenance_not_approved",
  });
  const first = await f.requests.readDraft(created.requestId, f.scope());
  assert.equal(first.draft.config.serviceUrl, new URL(base).href);
  assert.equal(first.draft.authentication[0].fields[0].key, "key.value");
  const secret = "private-page-secret-config48",
    edited = await f.requests.prepareDraft(
      created.requestId,
      {
        revision: 1,
        credentials: [
          { key: "key.value", operation: "replace", value: secret },
        ],
      },
      f.scope(),
    );
  f.authority.edit(created.requestId, edited.candidate);
  assert.equal(edited.candidate.authStatus, "ready");
  assert.equal(JSON.stringify(edited).includes(secret), false);
  assert.equal(f.events.length, 0);
  const reads = http.seen.length;
  f.authority.approve(created.requestId);
  const result = await f.requests.execute(created.requestId, f.scope());
  assert.equal(result.execution.status, "succeeded", JSON.stringify(result));
  assert.equal(f.active.has("api:crm"), true);
  assert.equal(
    http.seen.length,
    reads,
    "apply never re-downloads approved sources",
  );
  const activated = f.active.get("api:crm");
  assert.match(activated.api.documentation.markdown, /read/);
  assert.match(activated.api.documentation.types, /ApiClient/);
  for (const file of files(f.work))
    assert.equal(readFileSync(file, "utf8").includes(secret), false, file);
  assert.equal(
    f.authorizations.some(
      (item) => item.type === "url" && item.value === base + "/value.json",
    ),
    true,
  );
  const again = await f.requests.execute(created.requestId, f.scope());
  assert.equal(again.execution.operationId, result.execution.operationId);
  assert.equal(f.events.filter((item) => item.type === "publish").length, 1);
});

test("approved API credentials use the actual future invocation after its approval scope ends and revoked callers cannot dispatch", async (t) => {
  let base;
  const http = await server(t, (req, res) =>
    req.url === "/spec"
      ? send(res, schema(base, true))
      : req.url === "/value.json"
        ? send(res, {
            type: "object",
            properties: { value: { type: "string" } },
          })
        : send(res, { value: "actual-business" }),
  );
  base = http.url;
  const f = await fixture(t),
    intent = f.intent("api.import", { name: "crm", url: base + "/spec" }),
    pending = await f.backend.prepare(intent, f.scope()),
    ready = await f.backend.prepareDraft(
      intent,
      pending,
      {
        revision: 1,
        credentials: [
          {
            key: "key.value",
            operation: "replace",
            value: "actual-private-api-key",
          },
        ],
      },
      f.scope(),
    ),
    approval = new AbortController();
  await f.backend.apply(intent, ready, f.scope(approval.signal));
  const { engine, contextId } = await mountedApi(f);
  approval.abort(new Error("Approval request has ended."));
  const result = await engine.start(caller, {
    contextId,
    script: "return (await api.crm.read()).data;",
    waitMs: 3000,
  });
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.value, "actual-business");
  assert.equal(http.seen.at(-1).headers["x-api-key"], "actual-private-api-key");
  const requests = http.seen.length;
  f.revoke();
  await assert.rejects(
    engine.start(caller, {
      contextId,
      script: "return await api.crm.read();",
      waitMs: 3000,
    }),
    { code: "forbidden" },
  );
  assert.equal(http.seen.length, requests);
  f.allow();
});

test("MCP static preparation never launches commands, secrets stay private, and add/update/remove each require a separate confirmation", async (t) => {
  const f = await fixture(t),
    secret = "mcp-private-env-48",
    created = await f.requests.bind(f.scope()).mcp.add({
      name: "local",
      config: {
        transport: "stdio",
        command: "node",
        args: ["--version"],
        env: { KEY: secret },
      },
    });
  assert.equal(f.events.length, 0);
  const draft = await f.requests.readDraft(created.requestId, f.scope());
  assert.equal(JSON.stringify(draft).includes(secret), false);
  assert.equal(draft.draft.authentication[0].fields[0].configured, true);
  f.authority.approve(created.requestId);
  assert.equal(
    (await f.requests.execute(created.requestId, f.scope())).execution.status,
    "succeeded",
  );
  assert.equal(f.active.get("mcp:local").mcp.env.KEY, secret);
  const work = readFileSync(path.join(f.work, "mcp.json"), "utf8");
  assert.equal(work.includes(secret), false);
  assert.match(work, /credentialBindings/);
  const update = await f.requests.bind(f.scope()).mcp.update({
    name: "local",
    config: { ...draft.draft.config, args: ["--help"] },
  });
  await assert.rejects(f.requests.execute(update.requestId, f.scope()), {
    code: "maintenance_not_approved",
  });
  assert.deepEqual(f.active.get("mcp:local").mcp.args, ["--version"]);
  f.authority.approve(update.requestId);
  assert.equal(
    (await f.requests.execute(update.requestId, f.scope())).execution.status,
    "succeeded",
  );
  assert.deepEqual(f.active.get("mcp:local").mcp.args, ["--help"]);
  const remove = await f.requests.bind(f.scope()).mcp.remove({ name: "local" });
  await assert.rejects(f.requests.execute(remove.requestId, f.scope()), {
    code: "maintenance_not_approved",
  });
  assert.equal(f.active.has("mcp:local"), true);
  f.authority.approve(remove.requestId);
  assert.equal(
    (await f.requests.execute(remove.requestId, f.scope())).execution.status,
    "succeeded",
  );
  assert.equal(f.active.has("mcp:local"), false);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(f.work, "mcp.json"), "utf8")),
    { mcpServers: {} },
  );
});

test("restart restores only privately approved fixed configuration and ignores direct file additions/edits/deletion", async (t) => {
  const f = await fixture(t),
    intent = f.intent("mcp.add", {
      name: "approved",
      config: { transport: "stdio", command: "node", args: ["--version"] },
    }),
    candidate = await f.backend.prepare(intent, f.scope());
  await f.backend.apply(intent, candidate, f.scope());
  writeFileSync(
    path.join(f.work, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        approved: { transport: "stdio", command: "malicious-unapproved" },
        new: { transport: "stdio", command: "also-unapproved" },
      },
    }),
  );
  f.active.clear();
  const reopened = await f.reopen(),
    restored = await reopened.restore(f.scope());
  assert.deepEqual(restored, [
    { kind: "mcp", name: "approved", state: "ready" },
  ]);
  assert.equal(f.active.get("mcp:approved").mcp.command, "node");
  assert.equal(f.active.has("mcp:new"), false);
  rmSync(path.join(f.work, "mcp.json"));
  f.active.clear();
  await reopened.restore(f.scope());
  assert.equal(f.active.get("mcp:approved").mcp.command, "node");
});

test("failed preparation and stale disk/private revisions retain the previous approved source", async (t) => {
  let fail = false;
  const f = await fixture(t, {
      async prepare() {
        if (fail)
          throw new AgentError(
            "fixture_initialize_failed",
            "Expected initialization failure.",
          );
      },
    }),
    initial = f.intent("mcp.add", {
      name: "one",
      config: { transport: "stdio", command: "node" },
    }),
    candidate = await f.backend.prepare(initial, f.scope());
  await f.backend.apply(initial, candidate, f.scope());
  const update = f.intent("mcp.update", {
      name: "one",
      config: { transport: "stdio", command: "another" },
    }),
    next = await f.backend.prepare(update, f.scope());
  fail = true;
  await assert.rejects(f.backend.apply(update, next, f.scope()), {
    code: "fixture_initialize_failed",
  });
  assert.equal(f.active.get("mcp:one").mcp.command, "node");
  fail = false;
  f.active.clear();
  await (await f.reopen()).restore(f.scope());
  assert.equal(f.active.get("mcp:one").mcp.command, "node");
  const stale = await f.backend.prepare(update, f.scope());
  writeFileSync(
    path.join(f.work, "mcp.json"),
    JSON.stringify({
      mcpServers: { one: { transport: "stdio", command: "external" } },
    }),
  );
  await assert.rejects(f.backend.apply(update, stale, f.scope()), {
    code: "maintenance_precondition_changed",
  });
  assert.equal(f.active.get("mcp:one").mcp.command, "node");
});

test("source credentials are separate and private, redirects reauthorize targets, and response/ref budgets fail before activation", async (t) => {
  let base;
  const http = await server(t, (req, res) => {
    if (req.url === "/protected") {
      if (req.headers.authorization !== "Bearer source-secret") {
        res.writeHead(401);
        res.end();
      } else send(res, schema(base));
    } else if (req.url === "/value.json") send(res, { type: "object" });
    else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/openapi.json" });
      res.end();
    } else if (req.url === "/large") {
      res.writeHead(200, { "content-length": "9999999" });
      res.end();
    } else send(res, schema(base));
  });
  base = http.url;
  const f = await fixture(t),
    intent = f.intent("api.import", {
      name: "protected",
      url: base + "/protected",
    }),
    candidate = await f.backend.prepare(intent, f.scope());
  assert.equal(candidate.authStatus, "required");
  const draft = await f.backend.readDraft(intent, candidate, f.scope());
  assert.equal(draft.authentication[0].id, "source");
  const fixed = await f.backend.prepareDraft(
    intent,
    candidate,
    {
      revision: 1,
      credentials: [
        {
          key: "source.Authorization",
          operation: "replace",
          value: "Bearer source-secret",
        },
      ],
    },
    f.scope(),
  );
  assert.equal(fixed.authStatus, "not_required");
  await f.backend.apply(intent, fixed, f.scope());
  for (const file of files(f.work))
    assert.equal(readFileSync(file, "utf8").includes("source-secret"), false);
  await f.backend.prepare(
    f.intent("api.import", { name: "redirected", url: base + "/redirect" }),
    f.scope(),
  );
  assert.equal(
    f.authorizations.some((item) => item.value === base + "/openapi.json"),
    true,
  );
  await assert.rejects(
    f.backend.prepare(
      f.intent("api.import", { name: "large", url: base + "/large" }),
      f.scope(),
    ),
    { code: "configuration_source_too_large" },
  );
  assert.equal(f.events.filter((item) => item.type === "publish").length, 1);
});

test("local refs require current path authorization; unknown options, symlink targets and secret-like public OAuth fields fail closed", async (t) => {
  const f = await fixture(t),
    spec = path.join(f.work, "input.json"),
    ref = path.join(f.work, "value.json");
  writeFileSync(spec, JSON.stringify(schema("https://business.example")));
  writeFileSync(ref, '{"type":"object"}');
  await f.backend.prepare(
    f.intent("api.import", { name: "localapi", path: spec }),
    f.scope(),
  );
  assert.equal(
    f.authorizations.some((item) => item.type === "path" && item.value === ref),
    true,
  );
  const deny = f.scope();
  deny.authorize = (target) => {
    if (target.type === "path" && target.value === ref)
      throw new AgentError("path_not_allowed", "Denied.");
  };
  await assert.rejects(
    f.backend.prepare(
      f.intent("api.import", { name: "denied", path: spec }),
      deny,
    ),
    { code: "path_not_allowed" },
  );
  await assert.rejects(
    f.backend.prepare(
      f.intent("mcp.add", {
        name: "bad",
        config: { transport: "stdio", command: "node", unsupported: true },
      }),
      f.scope(),
    ),
    { code: "invalid_mcp_config" },
  );
  await assert.rejects(
    f.backend.prepare(
      f.intent("api.import", {
        name: "badsecret",
        path: spec,
        config: {
          oauth: {
            scheme: {
              flow: "clientCredentials",
              issuer: "https://issuer.example",
              clientId: "id",
              scopes: [],
              clientSecret: "must-not-be-public",
            },
          },
        },
      }),
      f.scope(),
    ),
    { code: "oauth_invalid_configuration" },
  );
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(
    outside,
    path.join(f.work, "api", "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.backend.prepare(
      f.intent("api.import", { name: "escape", path: spec }),
      f.scope(),
    ),
    { code: "configuration_path_invalid" },
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("source authentication never crosses an authorized reference origin and invalid publication restores the approved snapshot", async (t) => {
  const external = await server(t, (_req, res) =>
    send(res, { type: "object" }),
  );
  let base;
  const http = await server(t, (req, res) => {
    if (req.headers.authorization !== "Bearer fixed-source-secret") {
      res.writeHead(401);
      res.end();
      return;
    }
    const document = schema(base);
    document.paths["/value"].get.responses[200].content[
      "application/json"
    ].schema.$ref = external.url + "/reference";
    send(res, document);
  });
  base = http.url;
  let rejectPublish = false;
  const f = await fixture(t, {
    publish() {
      if (rejectPublish)
        throw new AgentError(
          "fixture_publication_failed",
          "Expected publication rejection.",
        );
    },
  });
  const initial = f.intent("api.import", {
      name: "crm",
      url: base + "/source",
    }),
    pending = await f.backend.prepare(initial, f.scope()),
    ready = await f.backend.prepareDraft(
      initial,
      pending,
      {
        revision: 1,
        credentials: [
          {
            key: "source.Authorization",
            operation: "replace",
            value: "Bearer fixed-source-secret",
          },
        ],
      },
      f.scope(),
    );
  assert.equal(external.seen.length, 1);
  assert.equal(external.seen[0].headers.authorization, undefined);
  await f.backend.apply(initial, ready, f.scope());
  const before = readFileSync(
      path.join(f.work, "api", "crm", "config.json"),
      "utf8",
    ),
    update = f.intent("api.update", {
      name: "crm",
      config: { serviceUrl: "https://different.example" },
    }),
    next = await f.backend.prepare(update, f.scope());
  rejectPublish = true;
  await assert.rejects(f.backend.apply(update, next, f.scope()), {
    code: "fixture_publication_failed",
  });
  assert.equal(
    readFileSync(path.join(f.work, "api", "crm", "config.json"), "utf8"),
    before,
  );
  rejectPublish = false;
  f.active.clear();
  await (await f.reopen()).restore(f.scope());
  assert.equal(f.active.get("api:crm").config.serviceUrl, new URL(base).href);
});

test("private Accept headers of any casing never replace the fixed public Accept on another reference or redirect origin", async (t) => {
  const external = await server(t, (_req, res) =>
    send(res, { type: "object" }),
  );
  let base;
  const source = await server(t, (req, res) => {
    if (req.headers.accept !== "private-accept-only-at-source") {
      res.writeHead(401);
      res.end();
      return;
    }
    const spec = schema(base);
    spec.paths["/value"].get.responses[200].content[
      "application/json"
    ].schema.$ref = external.url + "/ref";
    send(res, spec);
  });
  base = source.url;
  const f = await fixture(t);
  for (const [index, header] of ["Accept", "aCcEpT"].entries()) {
    const intent = f.intent("api.import", {
        name: "accept" + index,
        url: base + "/spec",
      }),
      pending = await f.backend.prepare(intent, f.scope());
    const ready = await f.backend.prepareDraft(
      intent,
      pending,
      {
        revision: 1,
        credentials: [
          {
            key: "source." + header,
            operation: "replace",
            value: "private-accept-only-at-source",
          },
          {
            key: "source.Cookie",
            operation: "replace",
            value: "private-cookie-only-at-source",
          },
        ],
      },
      f.scope(),
    );
    assert.equal(ready.authStatus, "not_required");
  }
  assert.equal(external.seen.length, 2);
  for (const request of external.seen) {
    assert.equal(
      request.headers.accept,
      "application/json, application/yaml, text/yaml, */*",
    );
    assert.equal(request.headers.cookie, undefined);
  }
  assert.equal(
    source.seen.filter(
      (request) => request.headers.cookie === "private-cookie-only-at-source",
    ).length,
    2,
  );
});

test("updating the specification to another origin never sends its previous source credential before user confirmation", async (t) => {
  let baseA;
  const sourceA = await server(t, (req, res) => {
    if (req.headers.authorization !== "Bearer source-A-only") {
      res.writeHead(401);
      res.end();
    } else if (req.url === "/value.json") send(res, { type: "object" });
    else send(res, schema(baseA));
  });
  baseA = sourceA.url;
  const sourceB = await server(t, (_req, res) => {
      res.writeHead(401);
      res.end();
    }),
    f = await fixture(t),
    initial = f.intent("api.import", { name: "crm", url: baseA + "/spec" }),
    pending = await f.backend.prepare(initial, f.scope()),
    ready = await f.backend.prepareDraft(
      initial,
      pending,
      {
        revision: 1,
        credentials: [
          {
            key: "source.Authorization",
            operation: "replace",
            value: "Bearer source-A-only",
          },
        ],
      },
      f.scope(),
    );
  await f.backend.apply(initial, ready, f.scope());
  const update = f.intent("api.update", {
      name: "crm",
      url: sourceB.url + "/different",
    }),
    candidate = await f.backend.prepare(update, f.scope());
  assert.equal(sourceB.seen.length, 1);
  assert.equal(sourceB.seen[0].headers.authorization, undefined);
  assert.equal(candidate.authStatus, "required");
  const draft = await f.backend.readDraft(update, candidate, f.scope());
  assert.equal(
    draft.authentication
      .find((item) => item.id === "source")
      .fields.every((item) => item.configured === false),
    true,
  );
  assert.equal(f.events.filter((item) => item.type === "publish").length, 1);
  assert.equal(f.active.get("api:crm").config.serviceUrl, new URL(baseA).href);
});

test("each pending OAuth candidate has private refs distinct from the currently approved connection", async (t) => {
  let vault;
  const oauth = {
    async ready(_config, ref, binding) {
      return (await vault.read(ref, binding)).ready === true;
    },
    async provider() {
      return () => ({});
    },
  };
  const f = await fixture(t, { options: { mcpOAuth: oauth } });
  vault = f.vault;
  const intent = f.intent("mcp.add", {
      name: "oauth",
      config: {
        transport: "streamable-http",
        url: "https://mcp.example/endpoint",
        oauth: { clientInformation: { client_id: "fixture-client" } },
      },
    }),
    pending = await f.backend.prepare(intent, f.scope());
  const snapshot = (candidate) =>
    JSON.parse(
      readFileSync(
        path.join(
          f.root,
          "state",
          "maintenance",
          "configurations",
          "candidates",
          candidate.payload.configurationId + ".json",
        ),
        "utf8",
      ),
    );
  const first = snapshot(pending),
    original = first.secrets.oauth;
  await vault.update(original.ref, original.binding, { ready: true });
  first.authStatus = "ready";
  // Backend validation fixes a newly completed pending state through the normal draft path.
  const ready = await f.backend.prepareDraft(
    intent,
    pending,
    { revision: 1 },
    f.scope(),
  );
  await f.backend.apply(intent, ready, f.scope());
  const approved = snapshot(ready).secrets.oauth;
  const update = f.intent("mcp.update", {
      name: "oauth",
      config: (await f.backend.readDraft(intent, ready, f.scope())).config,
    }),
    next = await f.backend.prepare(update, f.scope()),
    candidate = snapshot(next).secrets.oauth;
  assert.notEqual(candidate.ref, approved.ref);
  await vault.update(candidate.ref, candidate.binding, {
    ready: false,
    clientSecret: "pending-only",
  });
  assert.equal((await vault.read(approved.ref, approved.binding)).ready, true);
  assert.equal(
    (await vault.read(approved.ref, approved.binding)).clientSecret,
    undefined,
  );
});

test("portable API directory identities retain logical JS names and never collide by case or Windows device name", async (t) => {
  const f = await fixture(t),
    spec = path.join(f.work, "portable.json"),
    ref = path.join(f.work, "value.json");
  writeFileSync(spec, JSON.stringify(schema("https://business.example")));
  writeFileSync(ref, '{"type":"object"}');
  const namespaces = [
      "crm",
      "Crm",
      "con",
      "CON",
      "$crm",
      "_" + "a".repeat(127),
    ],
    directories = [];
  for (const namespace of namespaces) {
    const intent = f.intent("api.import", { name: namespace, path: spec }),
      candidate = await f.backend.prepare(intent, f.scope());
    await f.backend.apply(intent, candidate, f.scope());
    const directory = configurationDirectoryName(namespace);
    directories.push(directory);
    const config = JSON.parse(
      readFileSync(path.join(f.work, "api", directory, "config.json"), "utf8"),
    );
    assert.deepEqual(config.identity, { name: namespace, directory });
    assert.equal(f.active.has("api:" + namespace), true);
  }
  assert.equal(
    new Set(directories.map((value) => value.toLowerCase())).size,
    namespaces.length,
  );
  assert.equal(directories[0], "crm");
  assert.equal(directories[4], "$crm");
  assert.equal(
    directories.every((value) => Buffer.byteLength(value) <= 255),
    true,
  );
});

test("mTLS uses the approved private cert/key/CA through a source-owned native dispatcher", async (t) => {
  const certificate = JSON.parse(
      readFileSync(
        new URL("./configuration-tls-fixture.json", import.meta.url),
        "utf8",
      ),
    ),
    seen = [],
    sockets = new Set();
  const tls = createHttpsServer(
    {
      ...certificate,
      ca: certificate.cert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      seen.push(req.socket.authorized);
      send(res, { value: "mutual-tls" });
    },
  );
  tls.keepAliveTimeout = 60000;
  let allClosed;
  const closedSockets = new Promise((resolve) => (allClosed = resolve));
  tls.on("secureConnection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (!sockets.size) allClosed();
    });
  });
  await new Promise((resolve) => tls.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        tls.closeAllConnections();
        tls.close(resolve);
      }),
  );
  const base = "https://127.0.0.1:" + tls.address().port,
    http = await server(t, (req, res) => {
      if (req.url === "/value.json")
        send(res, {
          type: "object",
          properties: { value: { type: "string" } },
        });
      else {
        const document = schema(base);
        document.components = {
          securitySchemes: { tls: { type: "mutualTLS" } },
        };
        document.security = [{ tls: [] }];
        send(res, document);
      }
    });
  const f = await fixture(t),
    intent = f.intent("api.import", { name: "crm", url: http.url + "/source" }),
    pending = await f.backend.prepare(intent, f.scope()),
    ready = await f.backend.prepareDraft(
      intent,
      pending,
      {
        revision: 1,
        credentials: ["cert", "key", "ca"].map((field) => ({
          key: "tls." + field,
          operation: "replace",
          value: field === "key" ? certificate.key : certificate.cert,
        })),
      },
      f.scope(),
    );
  await f.backend.apply(intent, ready, f.scope());
  const { engine, contextId, close } = await mountedApi(f),
    result = await engine.start(caller, {
      contextId,
      script:
        "return {values:await Promise.all(Array.from({length:8},async()=> (await api.crm.read()).data.value))};",
      waitMs: 3000,
    });
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.result.values, Array(8).fill("mutual-tls"));
  assert.deepEqual(seen, Array(8).fill(true));
  await close();
  let timer;
  try {
    await Promise.race([
      closedSockets,
      new Promise(
        (_resolve, reject) =>
          (timer = setTimeout(
            () =>
              reject(new Error("A source-owned TLS connection remained open.")),
            3000,
          )),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(sockets.size, 0);
  for (const file of files(f.work))
    assert.equal(readFileSync(file, "utf8").includes("PRIVATE KEY"), false);
});

test("private approved state and pending snapshots cannot adopt another Agent/profile or caller", async (t) => {
  const f = await fixture(t),
    intent = f.intent("mcp.add", {
      name: "bound",
      config: { transport: "stdio", command: "node" },
    }),
    candidate = await f.backend.prepare(intent, f.scope());
  await assert.rejects(
    f.backend.readDraft(
      intent,
      candidate,
      f.scope(undefined, { ...caller, principalId: "other-owner" }),
    ),
    { code: "configuration_candidate_invalid" },
  );
  await f.backend.apply(intent, candidate, f.scope());
  await assert.rejects(
    ConfigurationMaintenanceBackend.open({
      ...f.options,
      agentId: "other-agent",
    }),
    { code: "configuration_state_invalid" },
  );
  await assert.rejects(
    ConfigurationMaintenanceBackend.open({
      ...f.options,
      profile: "production",
    }),
    { code: "configuration_state_invalid" },
  );
  assert.equal(f.events.filter((item) => item.type === "publish").length, 1);
});

test("source cancellation settles the real in-flight native response and closes its socket before preparing a candidate", async (t) => {
  let start, close;
  const started = new Promise((resolve) => (start = resolve)),
    closed = new Promise((resolve) => (close = resolve));
  const http = await server(t, (req, res) => {
    req.on("close", close);
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"openapi":');
    start();
  });
  const f = await fixture(t),
    controller = new AbortController(),
    pending = f.backend.prepare(
      f.intent("api.import", { name: "cancelled", url: http.url + "/slow" }),
      f.scope(controller.signal),
    );
  await started;
  controller.abort(new Error("Synthetic source cancellation."));
  await assert.rejects(pending, { message: "Synthetic source cancellation." });
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise(
        (_resolve, reject) =>
          (timer = setTimeout(
            () => reject(new Error("Native source socket did not close.")),
            3000,
          )),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(f.events.length, 0);
});
