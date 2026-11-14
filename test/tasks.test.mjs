import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

const dist =
  process.env.NEXUM_TASKS_DIST ?? new URL("../dist/", import.meta.url).href;
const moduleAt = (name) =>
  import(
    new URL(
      name,
      dist.endsWith("/") ? dist : pathToFileURL(dist + path.sep).href,
    )
  );
const { SqliteStore } = await moduleAt("storage/sqlite.js");
const { ModuleLoader } = await moduleAt("runtime/modules.js");
const { ScriptCatalog } = await moduleAt("runtime/scripts.js");
const { RunEngine, callerKey } = await moduleAt("runtime/engine.js");
const { RuntimeTasks, localTaskArtifactIds, taskAgentId } =
  await moduleAt("runtime/tasks.js");
const { ArtifactStore } = await moduleAt("results/artifacts.js");
const { ResultEncoder } = await moduleAt("results/encoder.js");
const { createOutput } = await moduleAt("sdk/output.js");
const { taskHandlers } = await moduleAt("application/tasks.js");
const { ProfileRetention } = await moduleAt("runtime/retention.js");
const caller = { principalId: "user", clientId: "client", grantId: "grant-a" };
const binding = {
  agentId: "agent_tasks",
  profile: "development",
  cloudEnvironment: "test",
};
const png = (() => {
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      value = Buffer.alloc(12 + data.length);
    value.writeUInt32BE(data.length);
    name.copy(value, 4);
    data.copy(value, 8);
    value.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
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
})();

async function fixture(t, extra = {}, encoderLimits = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-tasks-")),
    ),
    workDir = path.join(root, "work");
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, "package.json"), '{"type":"module"}');
  const snapshot = path.join(workDir, "snapshot.json");
  writeFileSync(snapshot, '{"project":null}');
  let clock = Date.now(),
    allowedGrant = caller.grantId,
    store,
    engine,
    tasks,
    loader;
  const now = () => clock;
  const scope = (who = caller, runId) => ({
    pwd: workDir,
    ownerKey: callerKey(who),
    runId,
    assertCurrent() {
      assert.equal(who.grantId, allowedGrant, "forbidden");
    },
    authorize() {
      assert.equal(who.grantId, allowedGrant, "forbidden");
    },
  });
  const artifacts = new ArtifactStore(root, binding.agentId, {
    now,
    retentionMs: 1000,
    retentionUntil: (id, runId, expiresAt) =>
      store.taskArtifactRetentionUntil(id, runId, now(), expiresAt),
  });
  const encoder = new ResultEncoder(artifacts, encoderLimits);
  const output = createOutput(workDir, () => {});
  const boot = async () => {
    store = new SqliteStore(root, binding, now());
    loader = await ModuleLoader.create(workDir, store.bootId, {
      builtins: () => ["timers"],
      approvedPackages: () => new Map(),
    });
    engine = new RunEngine(
      store,
      loader,
      new ScriptCatalog(workDir, binding.agentId),
      {
        authorize(who, target) {
          assert.equal(who.grantId, allowedGrant, "forbidden");
          if (target.run)
            assert.equal(target.run.callerKey, callerKey(who), "forbidden");
        },
        loadWork: (work) =>
          JSON.parse(readFileSync(path.join(root, work.snapshotRef), "utf8")),
        encodeResult: async (value, services) => {
          const saved = await encoder.encode(
            value,
            scope(caller, services.runId),
          );
          store.pinTaskRunArtifacts(
            services.runId,
            localTaskArtifactIds(saved, binding.agentId),
            now(),
          );
          return saved;
        },
        bindings: (services) => ({
          requestInput: services.requestInput,
          image: () => output.image({ data: png }),
          businessError: () => output.error("Expected validation failure"),
          ...extra,
        }),
      },
    );
    tasks = new RuntimeTasks(store, engine, { now });
  };
  await boot();
  let work = store.openWork(
    {
      callerKey: callerKey(caller),
      pwd: workDir,
      snapshotRef: path.relative(root, snapshot),
    },
    now(),
  );
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workDir,
    artifacts,
    encoder,
    scope,
    output,
    now,
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    get tasks() {
      return tasks;
    },
    advance: (ms) => (clock += ms),
    grant: (value) => (allowedGrant = value),
    start: (script, options = {}) =>
      engine.start(caller, {
        contextId: work.contextId,
        script,
        waitMs: 100,
        ...options,
      }),
    finish: (id) => engine.observe(caller, id, 3000),
    reboot: async () => {
      store.close();
      await boot();
      work = store.openWork(
        {
          callerKey: callerKey(caller),
          pwd: workDir,
          snapshotRef: path.relative(root, snapshot),
        },
        now(),
      );
    },
    get work() {
      return work;
    },
  };
}

test("Task handle is routable, persisted before return, and retry never starts a second run or renews TTL", async (t) => {
  let calls = 0;
  const f = await fixture(t, { count: () => ++calls });
  const run = await f.start("return count();");
  await f.finish(run.run.runId);
  const task = await f.tasks.create(caller, {
    runId: run.run.runId,
    ttlMs: 5000,
  });
  assert.equal(taskAgentId(task.taskId), binding.agentId);
  assert.equal(task.status, "completed");
  const record = f.store.getTask(task.taskId, callerKey(caller), f.now());
  assert.ok(existsSync(path.join(f.root, record.resultRef)));
  f.advance(100);
  const retry = await f.tasks.create(caller, {
    runId: run.run.runId,
    ttlMs: 99999,
  });
  assert.deepEqual(retry, task);
  assert.equal(calls, 1);
  assert.equal((await f.tasks.get(caller, task.taskId)).view.result.data, 1);
});

test("same caller still needs current Grant; IDs and persisted snapshots grant no authority", async (t) => {
  const f = await fixture(t);
  const run = await f.start("return 42;");
  assert.equal((await f.finish(run.run.runId)).run.status, "succeeded");
  const task = await f.tasks.create(caller, { runId: run.run.runId });
  const next = { ...caller, grantId: "grant-b" };
  await assert.rejects(f.tasks.get(next, task.taskId), /forbidden/);
  await assert.rejects(
    f.tasks.get({ ...caller, clientId: "other" }, task.taskId),
    { code: "task_not_found" },
  );
  f.grant(next.grantId);
  assert.equal((await f.tasks.get(next, task.taskId)).view.result.data, 42);
  await assert.rejects(f.tasks.get(caller, task.taskId), /forbidden/);
  const bad =
    "nx_task_" +
    Buffer.from(
      JSON.stringify(["different", "d76811e9-f88d-4db4-9ec9-df125200d740"]),
    ).toString("base64url");
  await assert.rejects(f.tasks.get(next, bad), { code: "agent_mismatch" });
});

test("ordinary script failure and isError results both complete the method; only explicit RPC failures are failed Tasks", async (t) => {
  const f = await fixture(t);
  for (const [script, status] of [
    ["throw new Error('business');", "failed"],
    ["return businessError();", "succeeded"],
  ]) {
    const run = await f.start(script);
    await f.finish(run.run.runId);
    const task = await f.tasks.create(caller, { runId: run.run.runId });
    const saved = await f.tasks.get(caller, task.taskId);
    assert.equal(saved.task.status, "completed");
    assert.equal(saved.view.run.status, status);
    assert.equal(saved.task.error, undefined);
    if (status === "succeeded") assert.equal(saved.view.result.isError, true);
  }
  const gate = Promise.withResolvers();
  const g = await fixture(t, { pause: () => gate.promise });
  const run = await g.start("await pause(); return 7;", { waitMs: 0 });
  const task = await g.tasks.create(caller, { runId: run.run.runId });
  const failed = await g.tasks.fail(caller, task.taskId, {
    code: -32603,
    message: "The original method failed.",
  });
  assert.equal(failed.task.status, "failed");
  assert.equal(failed.task.error.code, -32603);
  assert.equal((await g.tasks.cancel(caller, task.taskId)).accepted, false);
  gate.resolve();
  await g.finish(run.run.runId);
});

test("Task update consumes the original wait identity; cancel remains a receipt until actual run settlement", async (t) => {
  const f = await fixture(t);
  const run = await f.start(
    "return await requestInput({message:'Name',inputSchema:{type:'object',required:['name'],properties:{name:{type:'string'}},additionalProperties:false}});",
  );
  const task = await f.tasks.create(caller, { runId: run.run.runId });
  assert.equal(task.status, "input_required");
  const before = await f.tasks.get(caller, task.taskId),
    waitId = before.view.wait.waitId;
  await assert.rejects(
    f.tasks.update(caller, {
      taskId: task.taskId,
      waitId: "wait_" + "0".repeat(32),
      input: { name: "wrong" },
    }),
  );
  await f.tasks.update(caller, {
    taskId: task.taskId,
    waitId,
    input: { name: "Ada" },
  });
  await f.finish(run.run.runId);
  assert.deepEqual(
    (await f.tasks.get(caller, task.taskId)).view.result.data.input,
    { name: "Ada" },
  );
  assert.equal(f.store.getWait(waitId).status, "consumed");
  const gate = Promise.withResolvers(),
    g = await fixture(t, { pause: () => gate.promise });
  const active = await g.start("await pause(); return 1;", { waitMs: 0 });
  const binding = await g.tasks.create(caller, { runId: active.run.runId });
  const receipt = await g.tasks.cancel(caller, binding.taskId);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.view.run.status, "cancelling");
  assert.equal(receipt.task.status, "working");
  gate.resolve();
  await g.finish(active.run.runId);
  assert.equal(
    (await g.tasks.get(caller, binding.taskId)).task.status,
    "cancelled",
  );
});

test("filesystem failure never publishes a terminal Task or replays a run; SQLite close cannot publish a handle", async (t) => {
  let count = 0;
  const f = await fixture(t, { count: () => ++count });
  const run = await f.start("return count();");
  await f.finish(run.run.runId);
  writeFileSync(path.join(f.root, "state", "tasks"), "not a directory");
  await assert.rejects(f.tasks.create(caller, { runId: run.run.runId }), {
    code: "storage_path_escape",
  });
  rmSync(path.join(f.root, "state", "tasks"));
  const recovered = await f.tasks.create(caller, { runId: run.run.runId });
  assert.equal(recovered.status, "completed");
  assert.equal(count, 1);
  const g = await fixture(t);
  const accepted = await g.start("return 1;");
  await g.finish(accepted.run.runId);
  const attempt = g.tasks.create(caller, { runId: accepted.run.runId });
  g.store.close();
  await assert.rejects(attempt, { code: "storage_closed" });
});

test("terminal snapshot is immutable, safe normalized data and not regenerated if its private file disappears", async (t) => {
  const f = await fixture(t);
  const run = await f.start("return image();");
  await f.finish(run.run.runId);
  const task = await f.tasks.create(caller, { runId: run.run.runId });
  const ref = f.store.getTask(
    task.taskId,
    callerKey(caller),
    f.now(),
  ).resultRef;
  const bytes = readFileSync(path.join(f.root, ref), "utf8");
  assert.ok(!bytes.includes(png.toString("base64")));
  assert.ok(!bytes.includes('"type":"Buffer"'));
  assert.ok(bytes.includes('"resourceId"'));
  rmSync(path.join(f.root, ref));
  await assert.rejects(f.tasks.get(caller, task.taskId), {
    code: "task_result_unavailable",
  });
  assert.equal(f.store.getRun(run.run.runId).status, "succeeded");
  assert.ok(!existsSync(path.join(f.root, ref)));
});

test("Task retention permits original image beyond ordinary expiry, never renews it, and does not bypass current resource authority", async (t) => {
  const gate = Promise.withResolvers(),
    f = await fixture(t, { pause: () => gate.promise });
  const running = await f.start("await pause(); return image();", {
    waitMs: 0,
  });
  const task = await f.tasks.create(caller, {
    runId: running.run.runId,
    ttlMs: 10000,
  });
  gate.resolve();
  await f.finish(running.run.runId);
  const saved = await f.tasks.get(caller, task.taskId),
    resource = saved.view.result.content[0].resource;
  f.advance(2000);
  const read = await f.artifacts.read(resource.uri, f.scope(), {
    maxBytes: 1024,
  });
  assert.deepEqual(read.data, png);
  assert.equal(read.resource.expiresAt, resource.expiresAt);
  assert.equal(
    (await f.tasks.get(caller, task.taskId)).task.expiresAt,
    task.expiresAt,
  );
  await assert.rejects(
    f.artifacts.read(
      resource.uri,
      {
        ...f.scope(),
        authorize() {
          throw Object.assign(new Error("no"), { code: "forbidden" });
        },
      },
      { maxBytes: 1024 },
    ),
    { code: "forbidden" },
  );
  f.advance(8000);
  await assert.rejects(f.tasks.get(caller, task.taskId), {
    code: "task_expired",
  });
  await assert.rejects(f.artifacts.metadata(resource.uri, f.scope()), {
    code: "resource_expired",
  });
});

test("new Tasks do not resurrect previously expired images; business URI strings acquire no pins", async (t) => {
  const f = await fixture(t);
  const run = await f.start("return image();");
  const view = await f.finish(run.run.runId);
  const resource = view.result.content[0].resource;
  f.advance(2000);
  await f.tasks.create(caller, { runId: run.run.runId, ttlMs: 10000 });
  await assert.rejects(f.artifacts.metadata(resource.uri, f.scope()), {
    code: "resource_expired",
  });
  assert.deepEqual(
    localTaskArtifactIds(
      {
        content: [],
        data: { uri: resource.uri, resourceId: resource.resourceId },
        text: resource.uri,
      },
      binding.agentId,
    ),
    [],
  );
});

test("a valid reused resource is pinned by normalized content for a different Task run", async (t) => {
  let uri;
  const f = await fixture(t, { reused: () => f.output.file({ uri }) });
  const first = await f.start("return image();"),
    original = await f.finish(first.run.runId);
  uri = original.result.content[0].resource.uri;
  const second = await f.start("return reused();");
  await f.finish(second.run.runId);
  const task = await f.tasks.create(caller, {
    runId: second.run.runId,
    ttlMs: 10000,
  });
  f.advance(2000);
  assert.ok(
    f.store
      .protectedArtifactIds(f.now())
      .has(original.result.content[0].resource.resourceId),
  );
  assert.deepEqual(
    (await f.artifacts.read(uri, f.scope(), { maxBytes: 1024 })).data,
    png,
  );
  assert.equal(
    (await f.tasks.get(caller, task.taskId)).task.status,
    "completed",
  );
});

test("reboot keeps the association, classifies original interrupted run as a completed method, and never restores code", async (t) => {
  const f = await fixture(t);
  const run = f.store.acceptRun({
    callerKey: callerKey(caller),
    contextId: f.work.contextId,
    sourceKind: "inline",
    source: { codeSource: "inline" },
  }).run;
  const task = await f.tasks.create(caller, { runId: run.runId });
  assert.equal(task.status, "working");
  await f.reboot();
  const result = await f.tasks.get(caller, task.taskId);
  assert.equal(result.view.run.status, "interrupted");
  assert.equal(result.view.run.error.code, "agent_restarted");
  assert.equal(result.task.status, "completed");
  assert.equal(result.view.result, null);
  assert.equal(
    f.store.getTask(task.taskId, callerKey(caller), f.now()).runId,
    run.runId,
  );
});

test("a new Task may preserve legitimately readable content already protected by another Task without reviving expired content", async (t) => {
  let uri;
  const f = await fixture(t, { reused: () => f.output.file({ uri }) });
  const first = await f.start("return image();"),
    original = await f.finish(first.run.runId);
  uri = original.result.content[0].resource.uri;
  const oldTask = await f.tasks.create(caller, {
    runId: first.run.runId,
    ttlMs: 5000,
  });
  f.advance(2000);
  const second = await f.start("return reused();");
  await f.finish(second.run.runId);
  const nextTask = await f.tasks.create(caller, {
    runId: second.run.runId,
    ttlMs: 10000,
  });
  f.advance(4000);
  await assert.rejects(f.tasks.get(caller, oldTask.taskId), {
    code: "task_expired",
  });
  assert.deepEqual(
    (await f.artifacts.read(uri, f.scope(), { maxBytes: 1024 })).data,
    png,
  );
  assert.equal(
    (await f.tasks.get(caller, nextTask.taskId)).task.status,
    "completed",
  );
});

test("application handlers project the original authorized view and never create a second execution layer", async (t) => {
  const f = await fixture(t);
  const run = await f.start("return 8;");
  let projections = 0;
  const handlers = taskHandlers(f.tasks, {
    caller,
    signal: new AbortController().signal,
    project(view) {
      projections++;
      return { runId: view.run.runId, result: view.result };
    },
  });
  const task = await handlers["agent.tasks.create"]({ runId: run.run.runId });
  assert.equal((await f.finish(run.run.runId)).run.status, "succeeded");
  const result = await handlers["agent.tasks.get"]({ taskId: task.taskId });
  assert.equal(result.view.runId, run.run.runId);
  assert.equal(result.view.result.data, 8);
  assert.equal(projections, 1);
});

test("Task result growth reserves actual serialized bytes before mkdir and rechecks current authority after a waiting reservation", async (t) => {
  const f = await fixture(t),
    run = await f.start("return {value:17};");
  await f.finish(run.run.runId);
  let requested = 0;
  const refused = new RuntimeTasks(f.store, f.engine, {
    now: f.now,
    async reserve(bytes) {
      requested = bytes;
      throw Object.assign(new Error("full"), {
        code: "managed_space_exhausted",
      });
    },
  });
  await assert.rejects(refused.create(caller, { runId: run.run.runId }), {
    code: "managed_space_exhausted",
  });
  assert.ok(requested > 1024);
  assert.equal(existsSync(path.join(f.root, "state", "tasks")), false);
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let released = false;
  const delayed = new RuntimeTasks(f.store, f.engine, {
    now: f.now,
    async reserve() {
      entered.resolve();
      await gate.promise;
      return {
        release() {
          released = true;
        },
      };
    },
  });
  const pending = delayed.create(caller, { runId: run.run.runId });
  await entered.promise;
  f.grant("revoked");
  gate.resolve();
  await assert.rejects(pending, /forbidden/);
  assert.equal(released, true);
  assert.equal(existsSync(path.join(f.root, "state", "tasks")), false);
});

test("Task receipt fixes the original result identity and rejects another valid body placed at the same path", async (t) => {
  const f = await fixture(t),
    run = await f.start("return {value:1};");
  await f.finish(run.run.runId);
  const task = await f.tasks.create(caller, { runId: run.run.runId });
  const original = f.store.getRun(run.run.runId);
  writeFileSync(
    path.join(f.root, original.resultRef),
    JSON.stringify({ content: [], data: { value: 2 } }),
  );
  await assert.rejects(f.tasks.get(caller, task.taskId), {
    code: "task_result_unavailable",
  });
  assert.equal(
    (await f.engine.observe(caller, run.run.runId)).result.data.value,
    2,
  );
  assert.equal(
    f.store.getTask(task.taskId, callerKey(caller), f.now()).status,
    "completed",
  );
});

test("a Task retains one original large result plus a small fixed receipt rather than allocating a second body", async (t) => {
  const f = await fixture(t, {}, { textBytes: 4 * 1024 ** 2 }),
    run = await f.start("return {text:'x'.repeat(1024*1024)};");
  await f.finish(run.run.runId);
  const measure = new ProfileRetention(f.store, f.artifacts, {
      controlHeadroomBytes: 0,
    }),
    usage = await measure.measure();
  await measure.stop();
  const retention = new ProfileRetention(f.store, f.artifacts, {
    maxManagedBytes: usage.bytes + 256 * 1024,
    controlHeadroomBytes: 128 * 1024,
  });
  t.after(() => retention.stop());
  const tasks = new RuntimeTasks(f.store, f.engine, {
    now: f.now,
    reserve: (bytes, options) => retention.reserve(bytes, options),
  });
  const task = await tasks.create(caller, { runId: run.run.runId });
  const ref = f.store.getTask(
      task.taskId,
      callerKey(caller),
      f.now(),
    ).resultRef,
    body = readFileSync(path.join(f.root, ref), "utf8");
  assert.ok(Buffer.byteLength(body) < 65536);
  assert.equal(JSON.parse(body).result, null);
  assert.match(JSON.parse(body).retainedResultHash, /^[0-9a-f]{64}$/);
  assert.equal(
    (await tasks.get(caller, task.taskId)).view.result.data.text.length,
    1024 ** 2,
  );
  assert.equal(retention.reservedBytes, 0);
});
