import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const dist = new URL(
  process.env.NEXUM_CONTROL_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { SqliteStore },
  { schemaVersion, migration1, migration2, migration3 },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { ExtensionRegistry },
  { ResourceManager },
  { AgentError },
  { canonicalJson, digest, newRequestId },
  controls,
] = await Promise.all(
  [
    "storage/sqlite.js",
    "storage/schema.js",
    "runtime/modules.js",
    "runtime/scripts.js",
    "runtime/engine.js",
    "extensions/registry.js",
    "extensions/resources.js",
    "contracts/errors.js",
    "contracts/json.js",
    "runtime/control-scripts.js",
  ].map((file) => import(new URL(file, dist))),
);
const {
  CONTROL_OWNER,
  CONTROL_VERSION,
  FIXED_CONTROL_SCRIPTS,
  materializeControlScripts,
  qualifyControlScript,
} = controls;
const caller = { principalId: "user", clientId: "control-tests" };
const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
function profile() {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-control-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  return {
    root,
    work,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
async function fixture(t, options = {}) {
  const f = profile(),
    sources = [...materializeControlScripts(f.work)];
  const store = new SqliteStore(f.root, binding),
    resources = new ResourceManager(store),
    gates = new Map(),
    calls = [],
    policies = [];
  let allowed = true,
    sourceError;
  const registry = new ExtensionRegistry(resources, {
    permissions: new Set(["process.control", "transfer.control"]),
    authorize(policy) {
      policies.push(policy);
      if (!allowed)
        throw new AgentError(
          "forbidden",
          "Current control access was revoked.",
        );
      options.sdkAuthorize?.(policy);
    },
    log() {},
    progress() {},
  });
  const handles = [];
  const method = (handle, more = {}) => ({
    description: "控制准入集成测试",
    permissions: ["process.control"],
    schemaDialect: "draft7",
    inputSchema: { type: "object" },
    handle,
    ...more,
  });
  const shMethods = {};
  for (const name of ["get", "list", "write", "resize", "signal", "stop"]) {
    shMethods[name] = method(async (input) => {
      calls.push({ name, input });
      if (name === "get" && input.processId.startsWith("hold-")) {
        const gate = Promise.withResolvers();
        gates.set(input.processId, gate);
        await gate.promise;
      }
      return { method: name, input };
    });
  }
  const sh = await registry.prepare(
    {
      apiVersion: 1,
      origin: {
        type: "platform",
        owner: CONTROL_OWNER,
        namespace: "sh",
        version: CONTROL_VERSION,
        revision: "sh-instance",
      },
      permissions: ["process.control"],
    },
    () => ({ methods: shMethods }),
  );
  registry.publish(sh);
  handles.push(sh);
  const transferMethods = {
    get: method((input) => ({ method: "get", input }), {
      permissions: ["transfer.control"],
      normalize(args) {
        assert.equal(args.length, 2);
        return { transferId: args[0], options: args[1] };
      },
    }),
    list: method((input) => ({ method: "list", input }), {
      permissions: ["transfer.control"],
    }),
    cancel: method((input) => ({ method: "cancel", input }), {
      permissions: ["transfer.control"],
      normalize(args) {
        assert.equal(args.length, 1);
        return { transferId: args[0] };
      },
    }),
  };
  const transfer = await registry.prepare(
    {
      apiVersion: 1,
      origin: {
        type: "platform",
        owner: CONTROL_OWNER,
        namespace: "transfer",
        version: CONTROL_VERSION,
        revision: "transfer-instance",
      },
      permissions: ["transfer.control"],
    },
    () => ({ methods: transferMethods }),
  );
  registry.publish(transfer);
  handles.push(transfer);
  const scripts = new ScriptCatalog(f.work, binding.agentId, () => {
    if (sourceError) throw sourceError;
    return sources;
  });
  const loader = await ModuleLoader.create(f.work, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const work = store.openWork({
    callerKey: callerKey(caller),
    pwd: f.work,
    snapshotRef: "work/snapshot.json",
  });
  let loadCalls = 0,
    tampered = false;
  const engine = new RunEngine(store, loader, scripts, {
    authorize(who, target) {
      if (!allowed || (target.run && target.run.callerKey !== callerKey(who)))
        throw new AgentError(
          "forbidden",
          "Current execution access was revoked.",
        );
      options.authorize?.(who, target);
    },
    loadWork(item) {
      loadCalls++;
      options.loadWork?.({ loadCalls, sources, work: item });
      return { project: null };
    },
    bindings(services) {
      return {
        ...registry.bindings(services),
        tampered() {
          tampered = true;
        },
      };
    },
    encodeResult: async (value) => ({
      content: [],
      ...(value === undefined
        ? {}
        : { data: JSON.parse(canonicalJson(value)) }),
    }),
    resources,
    leaseScript: (origin) =>
      origin.type === "local" ? () => {} : registry.lease(origin),
    capacity: options.capacity ?? 1,
    controlCapacity: options.controlCapacity ?? 2,
  });
  const accepted = new Set();
  const start = async (input) => {
    const view = await engine.start(caller, {
      contextId: work.contextId,
      waitMs: 3000,
      ...input,
    });
    accepted.add(view.run.runId);
    return view;
  };
  t.after(async () => {
    allowed = true;
    sourceError = undefined;
    for (const id of accepted) engine.cancel(caller, id);
    for (const gate of gates.values()) gate.resolve();
    for (const id of accepted) await engine.observe(caller, id, 3000);
    for (const handle of handles) await registry.disable(handle);
    store.close();
    f.clean();
  });
  return {
    ...f,
    store,
    resources,
    registry,
    handles,
    engine,
    scripts,
    work,
    sources,
    gates,
    calls,
    policies,
    start,
    accepted,
    finish: (id) => engine.observe(caller, id, 3000),
    sourceError: (error) => {
      sourceError = error;
    },
    revoke: () => {
      allowed = false;
    },
    restore: () => {
      allowed = true;
    },
    wasTampered: () => tampered,
  };
}
const definition = (name) =>
  FIXED_CONTROL_SCRIPTS.find((script) => script.name === name);
const sourceFile = (f, name) => {
  const entry = definition(name),
    source = f.sources.find((value) => value.namespace === entry.namespace);
  return path.join(source.directory, entry.filename);
};
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert(Date.now() < deadline, "The expected managed call did not start.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("control module import is read-only and explicit materialization produces nine complete platform definitions", (t) => {
  const f = profile();
  t.after(f.clean);
  const imported = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: f.work,
    encoding: "utf8",
    input: `await import(${JSON.stringify(new URL("runtime/control-scripts.js", dist).href)});`,
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(readdirSync(f.work), ["package.json"]);
  const sources = materializeControlScripts(f.work),
    scripts = new ScriptCatalog(f.work, "agent", () => sources);
  assert.equal(FIXED_CONTROL_SCRIPTS.length, 9);
  assert.equal(sources.length, 2);
  for (const spec of FIXED_CONTROL_SCRIPTS) {
    const resolved = scripts.resolve(spec.name);
    const snapshot = qualifyControlScript(scripts, spec.name);
    assert(snapshot, `${spec.name}: ${JSON.stringify(resolved.origin)}`);
    assert.equal(snapshot.code, spec.code);
    assert.equal(snapshot.origin.revision, spec.revision);
    assert.equal(snapshot.origin.owner, CONTROL_OWNER);
    assert.equal(snapshot.origin.version, CONTROL_VERSION);
    assert.equal(snapshot.origin.type, "platform");
    assert.equal(snapshot.metadata.scriptOpenDefault, true);
    assert(Object.isFrozen(snapshot));
    assert(Object.isFrozen(snapshot.metadata.scriptInputSchema));
  }
});

test("ordinary and reserved slots are persisted independently across all active statuses", (t) => {
  const f = profile(),
    store = new SqliteStore(f.root, binding);
  t.after(() => {
    store.close();
    f.clean();
  });
  const work = store.openWork({
    callerKey: "caller",
    pwd: f.work,
    snapshotRef: "work/snapshot.json",
  });
  const accept = (more = {}) =>
    store.acceptRun({
      callerKey: "caller",
      contextId: work.contextId,
      sourceKind: "inline",
      source: {},
      ...more,
    }).run;
  const ordinary = [];
  for (let i = 0; i < 256; i++) ordinary.push(accept());
  assert(ordinary.every((row) => row.admissionClass === "ordinary"));
  assert.throws(() => accept(), { code: "runtime_busy" });
  const a = accept({
    sourceKind: "script",
    scriptName: "sh/get.js",
    controlEligible: true,
  });
  const b = accept({
    sourceKind: "script",
    scriptName: "sh/stop.js",
    controlEligible: true,
  });
  assert.equal(a.admissionClass, "control");
  assert.equal(b.admissionClass, "control");
  assert.throws(
    () =>
      accept({
        sourceKind: "script",
        scriptName: "sh/list.js",
        controlEligible: true,
      }),
    { code: "runtime_busy" },
  );
  let preparing = store.transitionRun(a.runId, a.revision, "preparing_inputs", {
    source: { admission_class: "ordinary" },
  });
  preparing = store.savePreparation(preparing.runId, preparing.revision, {
    codeRef: "code",
    inputRef: "input",
    source: {},
  });
  assert.equal(preparing.admissionClass, "control");
  store.requestStop(b.runId, { kind: "cancel" });
  assert.throws(
    () =>
      accept({
        sourceKind: "script",
        scriptName: "sh/get.js",
        controlEligible: true,
      }),
    { code: "runtime_busy" },
  );
  store.transitionRun(ordinary[0].runId, ordinary[0].revision, "failed");
  const available = accept({
    sourceKind: "script",
    scriptName: "sh/get.js",
    controlEligible: true,
  });
  assert.equal(available.admissionClass, "ordinary");
});

test("fixed controls use ordinary capacity first and remain executable through two reserved slots", async (t) => {
  const f = await fixture(t);
  const ordinary = await f.start({
    script: 'return await sh.get({processId:"hold-ordinary"});',
    waitMs: 0,
  });
  const first = await f.start({
    scriptName: "sh/get.js",
    input: { processId: "hold-a" },
    waitMs: 0,
  });
  const second = await f.start({
    scriptName: "sh/get.js",
    input: { processId: "hold-b" },
    waitMs: 0,
  });
  assert.equal(ordinary.run.admissionClass, "ordinary");
  assert.equal(first.run.admissionClass, "control");
  assert.equal(second.run.admissionClass, "control");
  await assert.rejects(
    () => f.start({ scriptName: "sh/stop.js", input: { processId: "p" } }),
    { code: "runtime_busy" },
  );
  const observed = await f.engine.observe(caller, first.run.runId, 0);
  assert.equal(observed.run.runId, first.run.runId);
  await until(() => f.gates.has("hold-ordinary"));
  assert.equal(
    f.engine.cancel(caller, ordinary.run.runId).run.status,
    "cancelling",
  );
  const before = f.store.listRuns({}, "test", 100).runs.length;
  await assert.rejects(() => f.start({ script: "return 1;" }), {
    code: "runtime_busy",
  });
  assert.equal(f.store.listRuns({}, "test", 100).runs.length, before);
  f.gates.get("hold-ordinary").resolve();
  await f.finish(ordinary.run.runId);
  const now = await f.start({
    scriptName: "sh/stop.js",
    input: { processId: "p" },
  });
  assert.equal(now.run.admissionClass, "ordinary");
  assert.equal(now.run.status, "succeeded");
});

test("all fixed scripts pass their full input schemas to the corresponding registered SDK calls", async (t) => {
  const f = await fixture(t);
  const inputs = {
    "sh/get.js": { processId: "p", waitMs: 0 },
    "sh/list.js": {},
    "sh/write.js": { processId: "p", data: "x", eof: true },
    "sh/resize.js": { processId: "p", cols: 80, rows: 24 },
    "sh/signal.js": { processId: "p", signal: "SIGTERM" },
    "sh/stop.js": { processId: "p" },
    "transfer/get.js": { transferId: "t", waitMs: 0 },
    "transfer/list.js": {},
    "transfer/cancel.js": { transferId: "t" },
  };
  for (const [scriptName, input] of Object.entries(inputs)) {
    const view = await f.start({ scriptName, input });
    assert.equal(
      view.run.status,
      "succeeded",
      `${scriptName}: ${JSON.stringify(view.run.error)}`,
    );
    assert.equal(view.run.admissionClass, "ordinary");
    assert.equal(view.operations.items.length, 1);
    assert.equal(view.run.source.origin.owner, CONTROL_OWNER);
    assert.equal(
      view.result.data.method,
      scriptName.split("/")[1].replace(".js", ""),
    );
    if (scriptName === "transfer/get.js")
      assert.deepEqual(view.result.data.input, {
        transferId: "t",
        options: { waitMs: 0 },
      });
  }
});

test("an unrelated missing extension cannot disable a healthy control or bare local source", async (t) => {
  const f = await fixture(t);
  f.sources.push({
    type: "extension",
    owner: "@test/missing",
    namespace: "missing",
    version: "1",
    directory: path.join(f.scripts.work, "node_modules", "missing", "scripts"),
  });
  writeFileSync(
    path.join(f.scripts.local, "get.js"),
    definition("sh/get.js").code,
  );
  assert.equal(f.scripts.resolve("get.js").origin.type, "local");
  await f.start({
    script: 'return await sh.get({processId:"hold-normal"});',
    waitMs: 0,
  });
  const result = await f.start({
    scriptName: "sh/get.js",
    input: { processId: "p" },
  });
  assert.equal(result.run.admissionClass, "control");
  assert.equal(result.run.status, "succeeded");
  f.sources.push({ ...f.sources[0], owner: "conflict" });
  await assert.rejects(() => f.start({ scriptName: "sh/list.js", input: {} }), {
    code: "namespace_conflict",
  });
  f.sources.pop();
});

test("a qualified source lease covers its first preparation wait and is released at terminal", async (t) => {
  let f,
    checked = false;
  f = await fixture(t, {
    loadWork() {
      checked = true;
      assert.throws(() => f.registry.disable(f.handles[0]), {
        code: "extension_busy",
      });
    },
  });
  const result = await f.start({
    scriptName: "sh/get.js",
    input: { processId: "p" },
  });
  assert.equal(checked, true);
  assert.equal(result.run.status, "succeeded");
  assert.equal((await f.registry.disable(f.handles[0])).status, "disabled");
});

test("reserved admission never grants a fixed script additional SDK permission", async (t) => {
  const f = await fixture(t, {
    sdkAuthorize(policy) {
      if (
        policy.action === "invoke" &&
        policy.origin.namespace === "sh" &&
        policy.method === "stop"
      )
        throw new AgentError(
          "forbidden",
          "The current SDK permission is unavailable.",
        );
    },
  });
  await f.start({
    script: 'return await sh.get({processId:"hold-normal"});',
    waitMs: 0,
  });
  const result = await f.start({
    scriptName: "sh/stop.js",
    input: { processId: "p" },
  });
  assert.equal(result.run.admissionClass, "control");
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.error.code, "forbidden");
  assert.equal(result.operations.items.length, 0);
  assert.equal(
    f.calls.some((call) => call.name === "stop"),
    false,
  );
});

test("a qualified start holds its source before returning to the same synchronous caller", async (t) => {
  const f = await fixture(t);
  const pending = f.start({
    scriptName: "sh/get.js",
    input: { processId: "p" },
  });
  assert.throws(() => f.registry.disable(f.handles[0]), {
    code: "extension_busy",
  });
  const result = await pending;
  assert.equal(result.run.status, "succeeded");
  assert.equal((await f.registry.disable(f.handles[0])).status, "disabled");
});

test("copied inline code, external names and changed platform code cannot claim reserved capacity", async (t) => {
  const f = await fixture(t);
  await f.start({
    script: 'return await sh.get({processId:"hold-normal"});',
    waitMs: 0,
  });
  const fixed = definition("sh/get.js");
  await assert.rejects(
    () => f.start({ script: fixed.code, input: { processId: "p" } }),
    { code: "runtime_busy" },
  );
  await assert.rejects(
    () => f.start({ scriptName: "browser/get.js", input: { processId: "p" } }),
    { code: "runtime_busy" },
  );
  await assert.rejects(
    () => f.start({ script: '/** {"control":true} */ return 1;' }),
    { code: "runtime_busy" },
  );
  await assert.rejects(() => f.start({ script: "return 1;", control: true }), {
    code: "invalid_arguments",
  });
  await assert.rejects(
    () => f.start({ script: "return 1;", admissionClass: "control" }),
    { code: "invalid_arguments" },
  );
  const filename = sourceFile(f, "sh/get.js");
  writeFileSync(filename, fixed.code + "tampered();\n");
  await assert.rejects(
    () => f.start({ scriptName: "sh/get.js", input: { processId: "p" } }),
    { code: "runtime_busy" },
  );
  assert.equal(f.wasTampered(), false);
  writeFileSync(filename, fixed.code);
  const source = f.sources.find((value) => value.namespace === "sh");
  f.sources[f.sources.indexOf(source)] = {
    ...source,
    owner: "@external/forged",
  };
  await assert.rejects(
    () => f.start({ scriptName: "sh/get.js", input: { processId: "p" } }),
    { code: "runtime_busy" },
  );
  f.sources[f.sources.findIndex((value) => value.namespace === "sh")] = {
    ...source,
    version: "other",
  };
  await assert.rejects(
    () => f.start({ scriptName: "sh/get.js", input: { processId: "p" } }),
    { code: "runtime_busy" },
  );
  assert.equal(f.store.listRuns({}, "test", 100).runs.length, 1);
});

test("admission pins the qualified code before asynchronous preparation and still checks current authority", async (t) => {
  let filename;
  const f = await fixture(t, {
    loadWork({ loadCalls }) {
      if (loadCalls === 2) writeFileSync(filename, 'tampered(); return "bad";');
    },
  });
  filename = sourceFile(f, "sh/get.js");
  await f.start({
    script: 'return await sh.get({processId:"hold-normal"});',
    waitMs: 0,
  });
  const view = await f.start({
    scriptName: "sh/get.js",
    input: { processId: "p" },
  });
  assert.equal(view.run.admissionClass, "control");
  assert.equal(view.run.status, "succeeded");
  assert.equal(f.wasTampered(), false);
  const saved = JSON.parse(
    readFileSync(path.join(f.root, view.run.codeRef), "utf8"),
  );
  assert.equal(saved.code, definition("sh/get.js").code);
  assert(
    f.policies.some(
      (policy) =>
        policy.action === "invoke" && policy.origin.namespace === "sh",
    ),
  );
  f.revoke();
  await assert.rejects(
    () => f.start({ scriptName: "sh/stop.js", input: { processId: "p" } }),
    { code: "forbidden" },
  );
  f.restore();
});

test("historical replay does not inherit the original fixed script's reserved admission", async (t) => {
  const f = await fixture(t);
  const original = await f.start({
    scriptName: "sh/get.js",
    input: { processId: "p" },
  });
  assert.equal(original.run.status, "succeeded");
  await f.start({
    script: 'return await sh.get({processId:"hold-normal"});',
    waitMs: 0,
  });
  await assert.rejects(() => f.start({ replayRunId: original.run.runId }), {
    code: "runtime_busy",
  });
});

test("duplicates retain their original identity without rereading changed control sources or closed work", async (t) => {
  const f = await fixture(t),
    requestId = newRequestId();
  await f.start({
    script: 'return await sh.get({processId:"hold-normal"});',
    waitMs: 0,
  });
  const input = {
    scriptName: "sh/get.js",
    input: { processId: "hold-original" },
    requestId,
    waitMs: 0,
  };
  const first = await f.start(input);
  assert.equal(first.run.admissionClass, "control");
  writeFileSync(sourceFile(f, "sh/get.js"), 'throw new Error("changed");');
  let reads = 0;
  f.scripts.resolve = () => {
    reads++;
    throw new Error("must not read current code");
  };
  f.store.closeWork(f.work.contextId, callerKey(caller));
  const duplicate = await f.start(input);
  assert.equal(duplicate.run.runId, first.run.runId);
  assert.equal(reads, 0);
  await assert.rejects(
    () => f.start({ ...input, input: { processId: "different" } }),
    { code: "submission_conflict" },
  );
  assert.equal(reads, 0);
});

test("acceptance rechecks a submission inserted after the initial duplicate lookup", async (t) => {
  const f = await fixture(t),
    requestId = newRequestId();
  await f.start({
    script: 'return await sh.get({processId:"hold-normal"});',
    waitMs: 0,
  });
  const resolve = f.scripts.resolve.bind(f.scripts),
    input = {
      contextId: f.work.contextId,
      scriptName: "sh/get.js",
      input: { processId: "p" },
      requestId,
    };
  let original;
  f.scripts.resolve = (name) => {
    const snapshot = resolve(name);
    if (!original)
      original = f.store.acceptRun({
        callerKey: callerKey(caller),
        contextId: f.work.contextId,
        sourceKind: "script",
        scriptName: name,
        source: { entry: "named" },
        requestId,
        intentDigest: digest(input),
        capacity: 1,
        controlEligible: true,
      }).run;
    return snapshot;
  };
  const result = await f.start({ ...input, waitMs: 0 });
  assert.equal(result.run.runId, original.runId);
  assert.equal(result.run.admissionClass, "control");
  assert.equal(result.run.startedAt, null);
  assert.equal(
    f.calls.some((call) => call.input.processId === "p"),
    false,
  );
  f.store.transitionRun(original.runId, original.revision, "failed");
});

test("unreadable control sources become ordinary preparation while unknown source policies fail closed", async (t) => {
  const f = await fixture(t);
  unlinkSync(sourceFile(f, "sh/get.js"));
  const missing = await f.start({
    scriptName: "sh/get.js",
    input: { processId: "p" },
  });
  assert.equal(missing.run.admissionClass, "ordinary");
  assert.equal(missing.run.status, "failed");
  assert.equal(missing.run.startedAt, null);
  const error = new Error("source policy configuration failed");
  f.sourceError(error);
  const count = f.store.listRuns({}, "test", 100).runs.length;
  await assert.rejects(
    () => f.start({ scriptName: "sh/list.js", input: {} }),
    (cause) => cause === error,
  );
  assert.equal(f.store.listRuns({}, "test", 100).runs.length, count);
  f.sourceError(undefined);
});

test("schema four keeps schema-three history and shared deletion revisions", (t) => {
  const f = profile();
  t.after(f.clean);
  mkdirSync(path.join(f.root, "state"));
  const filename = path.join(f.root, "state", "runtime.sqlite"),
    old = new DatabaseSync(filename);
  old.exec(migration1);
  old.exec(migration2);
  old.exec(migration3);
  old.exec("PRAGMA user_version=3");
  old
    .prepare("INSERT INTO runtime_meta VALUES(1,?,?,?,?)")
    .run(
      binding.agentId,
      binding.profile,
      binding.cloudEnvironment,
      "old-boot",
    );
  old
    .prepare("INSERT INTO work_contexts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "ctx",
      "caller",
      null,
      "old-boot",
      1,
      "closed",
      f.work,
      "snapshot",
      1,
      1,
      2,
      2,
    );
  old
    .prepare(
      "INSERT INTO runs(run_id,caller_key,context_id,boot_id,status,source_kind,source_json,accepted_at,deadline_at,updated_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "run_old",
      "caller",
      "ctx",
      "old-boot",
      "succeeded",
      "inline",
      "{}",
      1,
      100,
      2,
      2,
    );
  old
    .prepare(
      "INSERT INTO agent_state(key,value_json,version,updated_at,deleted_at) VALUES(?,?,?,?,?)",
    )
    .run("deleted", "null", 9, 1, 1);
  old.close();
  const store = new SqliteStore(f.root, binding);
  try {
    assert.equal(store.getRun("run_old").status, "succeeded");
    assert.equal(store.getRun("run_old").admissionClass, "ordinary");
    assert.equal(store.getState("deleted"), null);
    assert.equal(store.setState("deleted", "new", null).version, 10);
  } finally {
    store.close();
  }
  const check = new DatabaseSync(filename);
  try {
    assert.equal(
      check.prepare("PRAGMA user_version").get().user_version,
      schemaVersion,
    );
  } finally {
    check.close();
  }
});
