import assert from "node:assert/strict";
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
import test from "node:test";

// Local SQLite/SDK/lifecycle integrations. The Cloud fixture below implements
// decisions and the execution CAS; it is not a deployed Browser or Cloud test.
const dist = new URL(
  process.env.NEXUM_MAINTENANCE_DIST ?? "../dist/",
  import.meta.url,
);
const [
  {
    MaintenanceRequests,
    maintenanceMethods,
    maintenanceOrigin,
    maintenanceIntent,
  },
  { maintenanceExtension },
  { SqliteStore },
  { ResourceManager },
  { ExtensionRegistry },
  { RunEngine, callerKey },
  { ModuleLoader },
  { ScriptCatalog },
  { canonicalJson },
  { AgentError },
] = await Promise.all(
  [
    "maintenance/requests.js",
    "sdk/maintenance.js",
    "storage/sqlite.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "runtime/engine.js",
    "runtime/modules.js",
    "runtime/scripts.js",
    "contracts/json.js",
    "contracts/errors.js",
  ].map((file) => import(new URL(file, dist))),
);

const caller = {
  principalId: "user",
  clientId: "maintenance-test",
  grantId: "grant-live",
  host: "local-test",
};
const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
const approvalOrigin = "https://cloud.example.test";
const secret = "synthetic-maintenance-private-config-48";
const clone = (value) => JSON.parse(JSON.stringify(value));
const error = (code, message = "Synthetic boundary denial.") =>
  new AgentError(code, message);
const code = (expected) => (value) => value?.code === expected;
const noSecret = (value) =>
  assert.equal(JSON.stringify(value).includes(secret), false);
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(root, entry.name))
      : [path.join(root, entry.name)],
  );
}

/** A stateful component authority, with Browser-only decision helpers. */
class CloudAuthority {
  records = new Map();
  keys = new Map();
  calls = [];
  activeGrants = new Set([caller.grantId]);
  sequence = 0;
  beginHook;
  getHook;
  constructor(now) {
    this.now = now;
  }
  current(identity, signal) {
    signal.throwIfAborted();
    if (
      identity.agentId !== binding.agentId ||
      identity.profile !== binding.profile ||
      identity.cloudEnvironment !== binding.cloudEnvironment ||
      identity.principalId !== caller.principalId ||
      identity.clientId !== caller.clientId ||
      identity.callerKey !== callerKey(caller) ||
      !this.activeGrants.has(identity.grantId)
    )
      throw error("forbidden");
  }
  record(identity, id, signal) {
    this.current(identity, signal);
    const item = this.records.get(id);
    if (!item || canonicalJson(item.identity) !== canonicalJson(identity))
      throw error("maintenance_not_found");
    if (
      !item.view.execution &&
      ["pending", "approved"].includes(item.view.status) &&
      Date.parse(item.view.expiresAt) <= this.now()
    ) {
      item.view.status = "expired";
      delete item.view.approvalUrl;
    }
    return item;
  }
  async create(identity, input, signal) {
    this.current(identity, signal);
    this.calls.push({
      method: "create",
      identity: clone(identity),
      input: clone(input),
    });
    const key = `${identity.callerKey}:${identity.grantId}:${input.requestKey}`;
    if (this.keys.has(key)) {
      const previous = this.record(identity, this.keys.get(key), signal);
      if (previous.view.candidateRevision !== input.candidateRevision)
        throw error("maintenance_request_conflict");
      return clone(previous.view);
    }
    const requestId = `maint_req_${++this.sequence}`;
    const view = {
      requestId,
      agentId: identity.agentId,
      profile: identity.profile,
      target: input.target,
      action: input.action,
      name: input.name,
      status: "pending",
      revision: 1,
      candidateRevision: input.candidateRevision,
      objectId: input.objectId,
      baseRevision: input.baseRevision,
      summary: clone(input.summary),
      authStatus: input.authStatus,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
      approvalUrl: `${approvalOrigin}/authorize/maintenance/${requestId}`,
    };
    this.records.set(requestId, { identity: clone(identity), view });
    this.keys.set(key, requestId);
    return clone(view);
  }
  async get(identity, id, signal) {
    this.record(identity, id, signal);
    this.calls.push({ method: "get", id });
    await this.getHook?.();
    return clone(this.record(identity, id, signal).view);
  }
  async decision(identity, id, signal) {
    this.calls.push({ method: "decision", id });
    return clone(this.record(identity, id, signal).view);
  }
  async list(identity, query, signal) {
    this.current(identity, signal);
    this.calls.push({ method: "list", query: clone(query) });
    const values = [...this.records.keys()]
      .reverse()
      .map((id) => this.record(identity, id, signal).view)
      .filter(
        (view) =>
          (!query.target || view.target === query.target) &&
          (!query.name || view.name === query.name) &&
          (!query.status || view.status === query.status),
      );
    const from = query.cursor
      ? values.findIndex((view) => view.requestId === query.cursor) + 1
      : 0;
    const limit = query.limit ?? 20,
      page = values.slice(from, from + limit);
    return {
      requests: clone(page),
      nextCursor: from + limit < values.length ? page.at(-1).requestId : null,
    };
  }
  async cancel(identity, id, signal) {
    this.calls.push({ method: "cancel", id });
    const row = this.record(identity, id, signal);
    if (row.view.execution) throw error("maintenance_already_started");
    if (["pending", "approved"].includes(row.view.status)) {
      row.view.status = "cancelled";
      delete row.view.approvalUrl;
    }
    return clone(row.view);
  }
  // These helpers represent a current authenticated owner in the Browser, not SDK methods.
  approve(id, expectedRevision) {
    const row = this.records.get(id),
      view = row.view;
    this.record(row.identity, id, new AbortController().signal);
    if (view.status === "approved" && view.revision === expectedRevision)
      return clone(view);
    if (view.status !== "pending" || view.revision !== expectedRevision)
      throw error("maintenance_revision_conflict");
    view.status = "approved";
    delete view.approvalUrl;
    view.decidedAt = new Date(this.now()).toISOString();
    view.decision = {
      status: "approved",
      revision: view.revision,
      candidateRevision: view.candidateRevision,
      decidedAt: view.decidedAt,
      decisionId: `decision_${id}`,
    };
    return clone(view);
  }
  deny(id) {
    const row = this.records.get(id),
      view = row.view;
    this.record(row.identity, id, new AbortController().signal);
    if (view.status !== "pending") throw error("maintenance_revision_conflict");
    view.status = "denied";
    delete view.approvalUrl;
    view.decidedAt = new Date(this.now()).toISOString();
    view.decision = {
      status: "denied",
      revision: view.revision,
      candidateRevision: view.candidateRevision,
      decidedAt: view.decidedAt,
      decisionId: `decision_${id}`,
    };
  }
  edit(id, candidate) {
    const row = this.records.get(id),
      view = row.view;
    this.record(row.identity, id, new AbortController().signal);
    if (
      view.status !== "pending" ||
      candidate.name !== view.name ||
      candidate.target !== view.target ||
      candidate.action !== view.action
    )
      throw error("maintenance_revision_conflict");
    Object.assign(view, {
      revision: view.revision + 1,
      candidateRevision: candidate.candidateRevision,
      objectId: candidate.objectId,
      baseRevision: candidate.baseRevision,
      summary: clone(candidate.summary),
      authStatus: candidate.authStatus,
    });
    return clone(view);
  }
  async beginExecution(identity, input, signal) {
    this.record(identity, input.requestId, signal);
    this.calls.push({ method: "beginExecution", input: clone(input) });
    await this.beginHook?.(input);
    const view = this.record(identity, input.requestId, signal).view;
    if (
      view.status !== "approved" ||
      view.revision !== input.decisionRevision ||
      view.candidateRevision !== input.approvedRevision ||
      view.decision?.candidateRevision !== input.approvedRevision
    )
      throw error("maintenance_not_approved");
    if (view.execution && view.execution.operationId !== input.operationId)
      throw error("maintenance_execution_conflict");
    view.execution ??= {
      operationId: input.operationId,
      startedAt: new Date(this.now()).toISOString(),
    };
    return clone(view);
  }
}

async function fixture(t, options = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-maintenance-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  let now = 1800000000000,
    allowed = true,
    scopeSequence = 0,
    lockVersion = 1,
    latest = "1.2.3";
  let store = new SqliteStore(root, binding),
    requests;
  writeFileSync(path.join(work, "snapshot.json"), '{"project":null}');
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
  const cloud = new CloudAuthority(() => now),
    prepares = [],
    verifies = [],
    applies = [],
    states = new Map(),
    logs = [],
    progress = [],
    handles = [];
  let verifyHook, applyHook;
  const backend = {
    async prepare(intent, scope) {
      scope.signal.throwIfAborted();
      prepares.push(clone(intent));
      const state = states.get(`${intent.target}:${intent.name}`);
      if (
        ["install", "add", "import"].includes(intent.action) ? !!state : !state
      )
        throw error(
          state ? "maintenance_target_exists" : "maintenance_target_missing",
        );
      return {
        objectId: state?.id ?? null,
        baseRevision: state?.revision ?? null,
        payload: {
          privateConfig: { token: secret, initial: intent.config ?? null },
          lockVersion,
          resolvedVersion:
            intent.version === "latest" || !intent.version
              ? latest
              : intent.version,
        },
        authStatus:
          intent.target === "api" || intent.target === "mcp"
            ? "required"
            : "not_required",
        summary: {
          changeKinds: [intent.target === "mcp" ? "connection" : intent.target],
          permissions: [`${intent.target}.use`],
          version:
            intent.target === "package"
              ? intent.version === "latest" || !intent.version
                ? latest
                : intent.version
              : null,
          namespace: intent.target === "extension" ? "sample" : null,
          restartMayBeRequired: false,
        },
      };
    },
    async verify(intent, candidate, scope) {
      verifies.push({ method: intent.method, name: intent.name });
      await verifyHook?.(intent, candidate, scope);
      scope.signal.throwIfAborted();
      const state = states.get(`${intent.target}:${intent.name}`);
      if (
        (state?.id ?? null) !== candidate.objectId ||
        (state?.revision ?? null) !== candidate.baseRevision ||
        candidate.payload.lockVersion !== lockVersion
      )
        throw error("maintenance_precondition_conflict");
    },
    async apply(intent, candidate, scope) {
      // Application work can only follow a real winning execution CAS.
      assert.ok(
        [...cloud.records.values()].some(
          (row) =>
            row.view.name === intent.name &&
            row.view.execution &&
            row.view.status === "approved",
        ),
      );
      applies.push({
        method: intent.method,
        name: intent.name,
        version: candidate.payload.resolvedVersion,
      });
      await applyHook?.(intent, candidate, scope);
      scope.signal.throwIfAborted();
      const key = `${intent.target}:${intent.name}`;
      if (intent.action === "remove") states.delete(key);
      else
        states.set(key, {
          id: candidate.objectId ?? `object_${intent.name}`,
          revision: String(Number(candidate.baseRevision ?? 0) + 1),
          version: candidate.payload.resolvedVersion,
        });
      if (intent.target === "package") lockVersion++;
      return {
        changed: true,
        restartRequired: false,
        ...(intent.target === "package"
          ? {
              package: {
                name: intent.name,
                declared: intent.action !== "remove",
                installedVersion:
                  intent.action === "remove"
                    ? null
                    : candidate.payload.resolvedVersion,
              },
            }
          : {}),
      };
    },
  };
  const makeRequests = () =>
    new MaintenanceRequests(store, cloud, backend, {
      approvalOrigin,
      now: () => now,
    });
  requests = makeRequests();
  const scope = (extra = {}) => ({
    caller,
    operationId: `op_test_${++scopeSequence}`,
    runId: originRun.runId,
    signal: new AbortController().signal,
    assertCurrent() {
      if (!allowed) throw error("forbidden");
    },
    authorize(target) {
      if (!allowed) throw error("forbidden");
      assert.equal(target.type, "maintenance");
    },
    ...extra,
  });
  let registry, engine, context;
  if (options.runtime) {
    const resources = new ResourceManager(store, { cleanupTimeoutMs: 20 });
    const permissions = [...maintenanceMethods, "get", "list", "cancel"].map(
      (name) => `maintenance.${name}`,
    );
    registry = new ExtensionRegistry(resources, {
      cleanupTimeoutMs: 25,
      permissions: new Set(permissions),
      maintenance: (current) => requests.bind(current),
      authorize() {
        if (!allowed) throw error("forbidden");
      },
      log(...args) {
        logs.push(args);
      },
      progress(...args) {
        progress.push(args);
      },
    });
    const handle = await registry.prepare(
      { apiVersion: 1, origin: maintenanceOrigin, permissions },
      maintenanceExtension,
    );
    registry.publish(handle);
    handles.push(handle);
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
          throw error("forbidden");
      },
      loadWork: (item) =>
        JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
      encodeResult: async (value) =>
        value === undefined
          ? { content: [] }
          : { content: [], data: JSON.parse(canonicalJson(value)) },
      bindings: (services) => registry.bindings(services),
      resources,
    });
  }
  t.after(async () => {
    if (registry)
      for (const handle of handles.reverse()) await registry.disable(handle);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    cloud,
    backend,
    prepares,
    verifies,
    applies,
    states,
    logs,
    progress,
    registry,
    engine,
    get store() {
      return store;
    },
    get requests() {
      return requests;
    },
    scope,
    service(extra) {
      return requests.bind(scope(extra));
    },
    async create(
      method = "packages.install",
      input = { name: "fresh", version: "latest" },
      extra,
    ) {
      const service = requests.bind(scope(extra)),
        [group, action] = method.split(".");
      return await service[group][action](input);
    },
    execute(id, extra) {
      return requests.execute(id, scope(extra));
    },
    seed(kind, name, data = {}) {
      states.set(`${kind}:${name}`, {
        id: `object_${name}`,
        revision: "1",
        version: "1.0.0",
        ...data,
      });
    },
    advance(ms) {
      now += ms;
    },
    revoke() {
      allowed = false;
    },
    grant() {
      allowed = true;
    },
    nextLock() {
      lockVersion++;
    },
    latest(version) {
      latest = version;
    },
    verifyWith(fn) {
      verifyHook = fn;
    },
    applyWith(fn) {
      applyHook = fn;
    },
    restart() {
      store.close();
      store = new SqliteStore(root, binding);
      requests = makeRequests();
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

const examples = [
  ["packages.install", { name: "new-package", version: "latest" }],
  ["packages.update", { name: "old-package", version: "2.0.0" }],
  ["packages.remove", { name: "remove-package" }],
  ["extensions.enable", { name: "@test/enable" }],
  ["extensions.disable", { name: "@test/disable" }],
  [
    "mcp.add",
    { name: "new-mcp", config: { headers: { Authorization: secret } } },
  ],
  [
    "mcp.update",
    { name: "old-mcp", config: { command: "node", args: ["server.js"] } },
  ],
  ["mcp.remove", { name: "remove-mcp" }],
  ["api.import", { name: "new-api", path: "openapi.yaml" }],
  [
    "api.update",
    { name: "old-api", config: { server: "https://api.example.test" } },
  ],
  ["api.remove", { name: "remove-api" }],
];
function seedExamples(f) {
  for (const [method, input] of examples)
    if (!["install", "add", "import"].includes(method.split(".")[1]))
      f.seed(
        method.startsWith("packages")
          ? "package"
          : method.startsWith("extensions")
            ? "extension"
            : method.split(".")[0],
        input.name,
      );
}

test("all eleven methods only prepare fixed pending requests, with private candidates and safe Cloud summaries", async (t) => {
  const f = await fixture(t);
  seedExamples(f);
  assert.deepEqual(
    [...maintenanceMethods],
    examples.map(([method]) => method),
  );
  const before = clone([...f.states]);
  for (const [method, input] of examples) {
    const receipt = await f.create(method, input);
    assert.equal(receipt.status, "pending");
    assert.deepEqual(Object.keys(receipt).sort(), [
      "approvalUrl",
      "expiresAt",
      "requestId",
      "status",
    ]);
    const row = f.cloud.records.get(receipt.requestId).view;
    assert.equal(
      Date.parse(row.expiresAt) - Date.parse(row.createdAt),
      30 * 60 * 1000,
    );
    assert.match(row.candidateRevision, /^[0-9a-f]{64}$/);
    noSecret(receipt);
    noSecret(row);
    assert.equal(f.store.getMaintenanceOperation(receipt.requestId), null);
  }
  assert.equal(f.prepares.length, 11);
  assert.equal(f.verifies.length, 0);
  assert.equal(f.applies.length, 0);
  assert.deepEqual([...f.states], before);
  noSecret(f.cloud.calls);
  const candidates = files(
    path.join(f.root, "state", "maintenance", "candidates"),
  );
  assert.equal(candidates.length, 11);
  assert.ok(
    candidates.every((file) => readFileSync(file, "utf8").includes(secret)),
  );
  assert.equal(
    f.prepares.find((item) => item.method === "api.import").path,
    path.join(f.work, "openapi.yaml"),
  );
});

test("SDK methods use the same Registry provider, and a completed creation run does not own later execution", async (t) => {
  const f = await fixture(t, { runtime: true });
  seedExamples(f);
  const script = `return await Promise.all([${examples.map(([method, input]) => `maintenance.${method}(${JSON.stringify(input).replaceAll(secret, "credential-reference")})`).join(",")}]);`;
  const completed = await f.start(script);
  assert.equal(
    completed.run.status,
    "succeeded",
    JSON.stringify(completed.run.error),
  );
  assert.equal(completed.result.data.length, 11);
  assert.equal(f.applies.length, 0);
  noSecret(completed.result);
  noSecret(completed.operations);
  noSecret(f.logs);
  noSecret(f.progress);
  noSecret(f.cloud.calls);
  const receipt = completed.result.data[0];
  f.cloud.approve(receipt.requestId, 1);
  const applied = await f.execute(receipt.requestId);
  assert.equal(applied.execution.status, "succeeded");
  assert.equal(applied.execution.result.package.installedVersion, "1.2.3");
  const operation = f.store.getMaintenanceOperation(receipt.requestId);
  assert.equal(operation.originRunId, completed.run.runId);
  assert.equal(f.store.getRun(completed.run.runId).status, "succeeded");
  assert.equal(f.applies.length, 1);
});

test("missing Grant and current local or Cloud permission loss fail closed before preparation or delivery", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.create(undefined, undefined, {
      caller: { ...caller, grantId: undefined },
    }),
    code("maintenance_authority_unavailable"),
  );
  assert.equal(f.prepares.length, 0);
  const created = await f.create();
  f.revoke();
  await assert.rejects(f.service().get(created.requestId), code("forbidden"));
  await assert.rejects(f.service().list(), code("forbidden"));
  await assert.rejects(
    f.service().cancel(created.requestId),
    code("forbidden"),
  );
  f.grant();
  f.cloud.activeGrants.delete(caller.grantId);
  await assert.rejects(f.service().get(created.requestId), code("forbidden"));
  f.cloud.activeGrants.add(caller.grantId);
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  f.cloud.getHook = async () => {
    entered.resolve();
    await gate.promise;
  };
  const pending = f.service().get(created.requestId);
  await entered.promise;
  f.revoke();
  gate.resolve();
  await assert.rejects(pending, code("forbidden"));
  assert.equal(f.applies.length, 0);
});

test("a local API specification is resolved against the trusted current working context", async (t) => {
  const f = await fixture(t),
    project = path.join(f.root, "project");
  mkdirSync(project);
  writeFileSync(path.join(project, "schema.yaml"), "openapi: 3.0.3\n");
  await f.create(
    "api.import",
    { name: "projectApi", path: "schema.yaml" },
    { pwd: project },
  );
  assert.equal(f.prepares.at(-1).path, path.join(project, "schema.yaml"));
  await f.create("api.import", { name: "workApi", path: "schema.yaml" });
  assert.equal(f.prepares.at(-1).path, path.join(f.work, "schema.yaml"));
  assert.equal(f.applies.length, 0);
});

test("pending, denied, cancelled and exactly expired requests never admit an execution", async (t) => {
  for (const state of [
    "pending",
    "denied",
    "cancelled",
    "expired",
    "approved-expired",
  ]) {
    await t.test(state, async (t) => {
      const f = await fixture(t),
        created = await f.create();
      if (state === "denied") f.cloud.deny(created.requestId);
      if (state === "cancelled") await f.service().cancel(created.requestId);
      if (state === "approved-expired") f.cloud.approve(created.requestId, 1);
      if (state.endsWith("expired")) f.advance(30 * 60 * 1000);
      await assert.rejects(
        f.execute(created.requestId),
        code("maintenance_not_approved"),
      );
      assert.equal(f.store.getMaintenanceOperation(created.requestId), null);
      assert.equal(f.applies.length, 0);
      assert.equal(
        f.cloud.calls.filter((item) => item.method === "beginExecution").length,
        0,
      );
    });
  }
});

test("get/list/cancel preserve original identities, expiry and approval links without creating, signing or applying", async (t) => {
  const f = await fixture(t),
    first = await f.create(),
    second = await f.create("packages.install", { name: "another" });
  const initial = clone(f.cloud.records.get(first.requestId).view);
  f.advance(5000);
  const viewed = await f.service().get(first.requestId);
  const page = await f
    .service()
    .list({ target: "package", status: "pending", limit: 1 });
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].requestId, second.requestId);
  assert.equal(
    (
      await f
        .service()
        .list({ target: "package", limit: 1, cursor: page.nextCursor })
    ).requests[0].requestId,
    first.requestId,
  );
  const cancelled = await f.service().cancel(first.requestId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await f.service().cancel(first.requestId)).status, "cancelled");
  for (const value of [viewed, cancelled]) {
    assert.equal(value.requestId, initial.requestId);
    assert.equal(value.expiresAt, initial.expiresAt);
    if (value.approvalUrl !== undefined)
      assert.equal(value.approvalUrl, initial.approvalUrl);
  }
  assert.equal(cancelled.approvalUrl, undefined);
  f.advance(30 * 60 * 1000);
  assert.equal((await f.service().get(second.requestId)).status, "expired");
  assert.equal(
    f.cloud.calls.filter((item) => item.method === "create").length,
    2,
  );
  assert.equal(f.applies.length, 0);
  await assert.rejects(
    f.service().list({ limit: 101 }),
    code("invalid_maintenance_filter"),
  );
  const calls = f.cloud.calls.length;
  await assert.rejects(
    f.service().list({ name: { token: secret } }),
    code("invalid_maintenance_filter"),
  );
  await assert.rejects(
    f.service().list({ cursor: { token: secret } }),
    code("invalid_maintenance_filter"),
  );
  assert.equal(f.cloud.calls.length, calls);
});

test("final confirmation binds the edited actual candidate and never follows a changed latest tag", async (t) => {
  const f = await fixture(t),
    first = await f.create();
  noSecret(await f.requests.readDraft(first.requestId, f.scope()));
  await assert.rejects(
    f.requests.prepareDraft(
      first.requestId,
      { revision: 1, name: "different-target" },
      f.scope(),
    ),
    code("invalid_maintenance_draft"),
  );
  const prepared = await f.requests.prepareDraft(
    first.requestId,
    { revision: 1, version: "2.0.0" },
    f.scope(),
  );
  noSecret(prepared);
  const edited = f.cloud.edit(first.requestId, prepared.candidate);
  assert.throws(
    () => f.cloud.approve(first.requestId, 1),
    code("maintenance_revision_conflict"),
  );
  assert.equal(f.applies.length, 0);
  f.cloud.approve(first.requestId, edited.revision);
  f.latest("9.9.9");
  const done = await f.execute(first.requestId);
  assert.equal(done.execution.result.package.installedVersion, "2.0.0");
  assert.equal(f.applies[0].version, "2.0.0");
  assert.equal(
    f.store.getMaintenanceOperation(first.requestId).approvedRevision,
    edited.candidateRevision,
  );
  assert.equal(
    f.cloud.calls.filter((item) => item.method === "create").length,
    1,
  );
});

test("candidate tampering or a replacement object/lock revision cannot reuse the old user approval", async (t) => {
  for (const mismatch of ["bytes", "object", "lock"]) {
    await t.test(mismatch, async (t) => {
      const f = await fixture(t);
      f.seed("package", "existing");
      const created = await f.create("packages.update", {
        name: "existing",
        version: "2.0.0",
      });
      const view = f.cloud.approve(created.requestId, 1);
      if (mismatch === "bytes")
        writeFileSync(
          path.join(
            f.root,
            "state",
            "maintenance",
            "candidates",
            `${view.candidateRevision}.json`,
          ),
          "{}",
        );
      if (mismatch === "object")
        f.seed("package", "existing", {
          id: "replacement-object",
          revision: "1",
        });
      if (mismatch === "lock") f.nextLock();
      await assert.rejects(
        f.execute(created.requestId),
        code(
          mismatch === "bytes"
            ? "maintenance_candidate_conflict"
            : "maintenance_precondition_conflict",
        ),
      );
      assert.equal(f.applies.length, 0);
      assert.equal(f.store.getMaintenanceOperation(created.requestId), null);
    });
  }
});

test("Cloud execution CAS losing to cancellation cannot run apply", async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  f.cloud.approve(created.requestId, 1);
  f.cloud.beginHook = async () => {
    entered.resolve();
    await gate.promise;
  };
  const pending = f.execute(created.requestId);
  await entered.promise;
  const cancelled = await f.service().cancel(created.requestId);
  assert.equal(cancelled.status, "cancelled");
  gate.resolve();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.error.code, "maintenance_not_approved");
  assert.deepEqual(Object.keys(result.execution.error).sort(), [
    "code",
    "message",
  ]);
  assert.equal(f.applies.length, 0);
  assert.equal((await f.service().get(created.requestId)).status, "cancelled");
  assert.equal(
    f.store.getMaintenanceOperation(created.requestId).error.code,
    "maintenance_not_approved",
  );
});

test("a winning execution is independent, unique in SQLite and never repeated by observation or duplicate delivery", async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  f.cloud.approve(created.requestId, 1);
  f.applyWith(async () => {
    entered.resolve();
    await gate.promise;
  });
  const accepted = [];
  const first = f.execute(created.requestId, {
    onAccepted(operationId) {
      assert.equal(
        f.store.getMaintenanceOperation(created.requestId).operationId,
        operationId,
      );
      assert.equal(
        f.applies.length,
        0,
        "admission must precede any backend side effect",
      );
      accepted.push(operationId);
    },
  });
  await entered.promise;
  const duplicateService = new MaintenanceRequests(
    f.store,
    f.cloud,
    f.backend,
    {
      approvalOrigin,
      now: () =>
        Date.parse(f.cloud.records.get(created.requestId).view.createdAt),
    },
  );
  const duplicate = await duplicateService.execute(
    created.requestId,
    f.scope(),
  );
  assert.equal(duplicate.execution.status, "running");
  await assert.rejects(
    f.service().cancel(created.requestId),
    code("maintenance_already_started"),
  );
  gate.resolve();
  const done = await first,
    repeated = await f.execute(created.requestId);
  assert.equal(done.execution.operationId, repeated.execution.operationId);
  assert.equal(done.execution.status, "succeeded");
  assert.deepEqual(accepted, [done.execution.operationId]);
  assert.equal(f.applies.length, 1);
  assert.equal(
    f.cloud.calls.filter((item) => item.method === "beginExecution").length,
    1,
  );
  noSecret(done);
  noSecret(f.store.getMaintenanceOperation(created.requestId));
});

test("expiry after actual execution admission does not pretend that the running work stopped", async (t) => {
  const f = await fixture(t),
    created = await f.create();
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  f.cloud.approve(created.requestId, 1);
  f.applyWith(async () => {
    entered.resolve();
    await gate.promise;
  });
  const pending = f.execute(created.requestId);
  await entered.promise;
  f.advance(30 * 60 * 1000);
  const running = await f.service().get(created.requestId);
  assert.equal(running.status, "approved");
  assert.equal(running.execution.status, "running");
  assert.equal(running.expiresAt, created.expiresAt);
  await assert.rejects(
    f.service().cancel(created.requestId),
    code("maintenance_already_started"),
  );
  gate.resolve();
  const done = await pending;
  assert.equal(done.execution.status, "succeeded");
  assert.equal(done.execution.operationId, running.execution.operationId);
  assert.equal(f.applies.length, 1);
});

test("summary projection and invalid execution results do not publish private configuration or replay real side effects", async (t) => {
  const f = await fixture(t);
  const prepare = f.backend.prepare.bind(f.backend),
    apply = f.backend.apply.bind(f.backend);
  f.backend.prepare = async (...args) => {
    const candidate = await prepare(...args);
    candidate.summary.rawConfiguration = { token: secret };
    return candidate;
  };
  f.backend.apply = async (...args) => ({
    ...(await apply(...args)),
    rawConfiguration: { token: secret },
  });
  const created = await f.create();
  noSecret(f.cloud.records.get(created.requestId).view);
  noSecret(f.cloud.calls);
  f.cloud.approve(created.requestId, 1);
  const done = await f.execute(created.requestId);
  assert.equal(done.execution.status, "failed");
  assert.equal(done.execution.error.code, "invalid_maintenance_result");
  assert.deepEqual(Object.keys(done.execution.error).sort(), [
    "code",
    "message",
  ]);
  assert.equal(
    (await f.service().get(created.requestId)).execution.error.code,
    "invalid_maintenance_result",
  );
  assert.equal(
    f.store.getMaintenanceOperation(created.requestId).error.code,
    "invalid_maintenance_result",
  );
  assert.equal(f.states.get("package:fresh").version, "1.2.3");
  noSecret(done);
  noSecret(f.store.getMaintenanceOperation(created.requestId));
  noSecret(
    JSON.parse(
      readFileSync(
        path.join(
          f.root,
          "state",
          "maintenance",
          created.requestId,
          "execution.json",
        ),
        "utf8",
      ),
    ),
  );
  await f.execute(created.requestId);
  assert.equal(f.applies.length, 1);
});

test("permission loss during preparation for execution prevents apply", async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  f.cloud.approve(created.requestId, 1);
  f.verifyWith(async () => {
    entered.resolve();
    await gate.promise;
  });
  const pending = f.execute(created.requestId);
  await entered.promise;
  f.revoke();
  gate.resolve();
  await assert.rejects(pending, code("forbidden"));
  assert.equal(f.applies.length, 0);
  assert.equal(f.store.getMaintenanceOperation(created.requestId), null);
});

test("two different approved changes cannot bypass work serialization during candidate file reads", async (t) => {
  const f = await fixture(t),
    first = await f.create(),
    second = await f.create("packages.install", { name: "second" });
  f.cloud.approve(first.requestId, 1);
  f.cloud.approve(second.requestId, 1);
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  f.verifyWith(async () => {
    entered.resolve();
    await gate.promise;
  });
  const results = [f.execute(first.requestId), f.execute(second.requestId)];
  const observed = Promise.allSettled(results);
  await entered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const enteredBeforeRelease = f.verifies.length;
  gate.resolve();
  const finished = await observed;
  assert.equal(enteredBeforeRelease, 1);
  assert.equal(
    finished.filter((item) => item.status === "fulfilled").length,
    1,
  );
  assert.equal(
    finished.find((item) => item.status === "rejected").reason.code,
    "maintenance_busy",
  );
  assert.equal(f.applies.length, 1);
});

test("an accepted operation interrupted by Agent restart is retained, never reconstructed or replayed", async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    approved = f.cloud.approve(created.requestId, 1);
  const accepted = f.store.startMaintenanceOperation({
    requestId: created.requestId,
    approvedRevision: approved.candidateRevision,
    callerKey: callerKey(caller),
    originRunId: null,
    source: {
      origin: maintenanceOrigin,
      target: approved.target,
      name: approved.name,
      objectId: approved.objectId,
      baseRevision: approved.baseRevision,
      candidateRevision: approved.candidateRevision,
    },
    method: "packages.install",
    detailRef: `state/maintenance/${created.requestId}/execution.json`,
  });
  f.restart();
  const observed = await f.execute(created.requestId);
  assert.equal(observed.execution.operationId, accepted.operation.operationId);
  assert.equal(observed.execution.status, "interrupted");
  assert.equal(
    observed.execution.error.code,
    f.store.getMaintenanceOperation(created.requestId).error.code,
  );
  assert.equal(f.applies.length, 0);
  assert.equal(
    f.cloud.calls.filter((item) => item.method === "beginExecution").length,
    0,
  );
  f.advance(30 * 60 * 1000);
  assert.equal(
    (await f.execute(created.requestId)).execution.operationId,
    accepted.operation.operationId,
  );
  assert.equal(f.applies.length, 0);
});

test("maintenance argument normalization rejects target switching and accepts one exact OpenAPI source", async (t) => {
  const f = await fixture(t);
  for (const [method, input] of [
    ["packages.install", { name: "pkg", cwd: "/elsewhere" }],
    ["packages.install", { name: "pkg", version: "latest; echo injected" }],
    ["extensions.enable", { name: "../pkg" }],
    [
      "api.import",
      { name: "api", url: "https://example.test/spec", path: "spec.yaml" },
    ],
    ["api.import", { name: "api" }],
    ["api.import", { name: "api", url: "https://name:pass@example.test/spec" }],
  ])
    assert.throws(
      () => maintenanceIntent(method, input, f.work),
      (value) => value instanceof AgentError,
    );
  assert.equal(
    maintenanceIntent(
      "api.import",
      { name: "api", path: "schema.yaml" },
      f.work,
    ).path,
    path.join(f.work, "schema.yaml"),
  );
  assert.equal(
    maintenanceIntent("api.update", { name: "api", config: {} }, f.work).method,
    "api.update",
  );
  assert.equal(f.applies.length, 0);
});
