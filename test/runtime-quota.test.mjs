import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
const dist = new URL(
  process.env.NEXUM_RUNTIME_QUOTA_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { SqliteStore },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { ArtifactStore },
  { ProfileRetention },
  { materializeControlScripts, FIXED_CONTROL_SCRIPTS },
  { canonicalJson },
] = await Promise.all(
  [
    "storage/sqlite.js",
    "runtime/modules.js",
    "runtime/scripts.js",
    "runtime/engine.js",
    "results/artifacts.js",
    "runtime/retention.js",
    "runtime/control-scripts.js",
    "contracts/json.js",
  ].map((file) => import(new URL(file, dist))),
);
const caller = {
    principalId: "owner",
    clientId: "runtime-quota",
    grantId: "grant",
  },
  MiB = 1024 ** 2;
async function fixture(t, options = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-runtime-quota-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const loader = await ModuleLoader.create(work, store.bootId, {
    builtins: () => ["timers"],
    approvedPackages: () => new Map(),
  });
  const controls = materializeControlScripts(work),
    scripts = new ScriptCatalog(work, "agent", () => controls);
  const artifacts = new ArtifactStore(root, "agent");
  const snapshot = path.join(work, "snapshot.json");
  writeFileSync(snapshot, '{"project":null}');
  const context = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: path.relative(root, snapshot),
  });
  const initial = new ProfileRetention(store, artifacts, {
      controlHeadroomBytes: 0,
    }),
    usage = await initial.measure();
  await initial.stop();
  const retention = new ProfileRetention(store, artifacts, {
    maxManagedBytes: usage.bytes + (options.quotaExtra ?? 16 * MiB),
    controlHeadroomBytes: options.headroom ?? 0,
  });
  let granted = true,
    executed = 0,
    controlCalls = 0;
  const calls = [];
  const reserve = async (bytes, reserveOptions) => {
    calls.push({ bytes, control: reserveOptions?.control === true });
    if (options.beforeReserve)
      await options.beforeReserve(bytes, reserveOptions);
    return await retention.reserve(bytes, reserveOptions);
  };
  const engine = new RunEngine(store, loader, scripts, {
    reserve,
    authorize(who, target) {
      assert.ok(granted && callerKey(who) === callerKey(caller), "forbidden");
      if (target.run) assert.equal(target.run.callerKey, callerKey(caller));
    },
    loadWork: (row) =>
      JSON.parse(readFileSync(path.join(root, row.snapshotRef), "utf8")),
    encodeResult: async (value) => ({
      content: [],
      data: JSON.parse(canonicalJson(value ?? null, 8 * MiB)),
    }),
    bindings: (services) => ({
      executed: () => ++executed,
      runtime: { requestInput: services.requestInput },
      sh: {
        async get(id) {
          controlCalls++;
          return { id, state: "closed" };
        },
      },
      ...options.bindings,
    }),
  });
  t.after(async () => {
    await retention.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    engine,
    scripts,
    retention,
    context,
    calls,
    get executed() {
      return executed;
    },
    get controlCalls() {
      return controlCalls;
    },
    revoke: () => (granted = false),
    start: (script, rest = {}) =>
      engine.start(caller, {
        contextId: context.contextId,
        script,
        waitMs: 100,
        ...rest,
      }),
    finish: (runId) => engine.observe(caller, runId, 3000),
  };
}

test("full managed storage refuses a new submission before SQLite acceptance or script execution", async (t) => {
  const f = await fixture(t, { quotaExtra: 1024 });
  await assert.rejects(f.start("return executed();"), {
    code: "storage_quota_exceeded",
  });
  assert.equal(f.executed, 0);
  assert.equal(f.store.listRuns({}, "scope").runs.length, 0);
  assert.equal(f.retention.reservedBytes, 0);
});

test("code, input and result grow only under real reservations and all tickets release after settlement", async (t) => {
  const f = await fixture(t),
    run = await f.start("return {value:executed()};");
  const ended = await f.finish(run.run.runId);
  assert.equal(ended.run.status, "succeeded");
  for (const ref of [
    ended.run.codeRef,
    ended.run.inputRef,
    ended.run.resultRef,
  ])
    assert.ok(existsSync(path.join(f.root, ref)));
  assert.ok(f.calls.some((call) => call.bytes === 65536));
  assert.ok(f.calls.some((call) => call.bytes === MiB + 1024));
  assert.equal(f.retention.reservedBytes, 0);
  assert.equal(ended.result.data.value, 1);
});

test("result quota refusal preserves the actual failed run and leaves query/cancel plus SQLite settlement available", async (t) => {
  const f = await fixture(t, { quotaExtra: 2 * MiB, headroom: 256 * 1024 });
  const run = await f.start("return 'x'.repeat(3*1024*1024);");
  const ended = await f.finish(run.run.runId);
  assert.equal(ended.run.status, "failed");
  assert.equal(ended.run.error.phase, "result");
  assert.equal(ended.run.resultRef, null);
  assert.equal(
    existsSync(path.join(f.work, "tmp", "runs", run.run.runId, "result.json")),
    false,
  );
  assert.equal(
    (await f.engine.get(caller, { agentId: "agent", runId: run.run.runId })).run
      .status,
    "failed",
  );
  assert.equal(f.engine.cancel(caller, run.run.runId).accepted, false);
  assert.equal(f.retention.reservedBytes, 0);
});

test("a fixed control script still uses headroom in an ordinary free slot, while a copied inline script cannot claim it", async (t) => {
  const f = await fixture(t, { quotaExtra: 3 * MiB, headroom: 2 * MiB });
  mkdirSync(path.join(f.work, "data"));
  const fill = await f.retention.reserve(MiB - 8192);
  writeFileSync(path.join(f.work, "data", "fill"), Buffer.alloc(MiB - 8192));
  fill.release();
  await assert.rejects(f.start("return executed();"), {
    code: "storage_quota_exceeded",
  });
  const fixed = FIXED_CONTROL_SCRIPTS.find(
    (script) => script.namespace === "sh" && script.filename === "get.js",
  );
  assert.ok(fixed);
  await assert.rejects(
    f.start(fixed.code, { input: { processId: "res_" + "0".repeat(32) } }),
    { code: "storage_quota_exceeded" },
  );
  const run = await f.engine.start(caller, {
    contextId: f.context.contextId,
    scriptName: fixed.name,
    input: { processId: "res_" + "0".repeat(32) },
    waitMs: 3000,
  });
  assert.equal(run.run.status, "succeeded");
  assert.equal(run.run.admissionClass, "ordinary");
  assert.equal(f.controlCalls, 1);
  assert.equal(f.retention.reservedBytes, 0);
});

test("quota during input continuation keeps the original wait retryable and does not write an oversized reply", async (t) => {
  const f = await fixture(t, { quotaExtra: 1408 * 1024 });
  const started = await f.start(
    "const r=await runtime.requestInput({message:'Value',inputSchema:{type:'string'}}); return r.input.length;",
    { waitMs: 0 },
  );
  const run = await f.engine.observe(caller, started.run.runId, 3000);
  assert.equal(run.run.status, "waiting_input");
  const waitId = run.wait.waitId;
  const rejected = await f.engine.input(caller, {
    agentId: "agent",
    runId: run.run.runId,
    waitId,
    input: "x".repeat(768 * 1024),
    waitMs: 3000,
  });
  assert.equal(rejected.submission.deliveryState, "failed");
  assert.equal(rejected.run.status, "waiting_input");
  assert.equal(
    existsSync(
      path.join(
        f.work,
        "tmp",
        "runs",
        run.run.runId,
        "inputs",
        waitId,
        "input.json",
      ),
    ),
    false,
  );
  await f.engine.input(caller, {
    agentId: "agent",
    runId: run.run.runId,
    waitId,
    input: "ok",
    waitMs: 3000,
  });
  const ended = await f.finish(run.run.runId);
  assert.equal(ended.run.status, "succeeded");
  assert.equal(ended.result.data, 2);
  assert.equal(f.retention.reservedBytes, 0);
});

test("an unawaited input remains tracked while quota admission is pending and cannot create a wait after the root closes", async (t) => {
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let enabled = false;
  const f = await fixture(t, {
    beforeReserve: async (bytes) => {
      if (enabled && bytes > 65536 && bytes < 70000) {
        entered.resolve();
        await gate.promise;
      }
    },
    bindings: { enable: () => (enabled = true) },
  });
  const run = await f.start(
    "enable(); runtime.requestInput({message:'Value',inputSchema:{type:'string'}}); return 1;",
    { waitMs: 0 },
  );
  await entered.promise;
  assert.equal(f.store.activeWait(run.run.runId), null);
  gate.resolve();
  const ended = await f.finish(run.run.runId);
  assert.equal(ended.run.status, "failed");
  assert.equal(ended.run.error.code, "input_not_awaited");
  assert.equal(f.store.activeWait(run.run.runId), null);
  assert.equal(f.retention.reservedBytes, 0);
});

test("an input preparation rejection is fully released before the script catches it and immediately requests new input", async (t) => {
  const f = await fixture(t);
  const started = await f.start(
    "try { await runtime.requestInput({message:'Bad',inputSchema:{type:'invalid-type'}}); } catch {} return await runtime.requestInput({message:'Good',inputSchema:{type:'string'}});",
    { waitMs: 0 },
  );
  const run = await f.engine.observe(caller, started.run.runId, 3000);
  assert.equal(run.run.status, "waiting_input");
  assert.equal(run.wait.request.message, "Good");
  await f.engine.input(caller, {
    agentId: "agent",
    runId: run.run.runId,
    waitId: run.wait.waitId,
    input: "ok",
    waitMs: 100,
  });
  const ended = await f.finish(run.run.runId);
  assert.equal(ended.run.status, "succeeded");
  assert.equal(ended.result.data.input, "ok");
  assert.equal(f.retention.reservedBytes, 0);
});
