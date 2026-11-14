import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { schemaVersion } from "../dist/storage/schema.js";
import { ResourceManager } from "../dist/extensions/resources.js";

const origin = {
  type: "extension",
  owner: "@test/process",
  namespace: "process",
  version: "1",
  revision: "one",
};
function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-resources-")),
  );
  mkdirSync(path.join(root, "work"));
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const manager = new ResourceManager(store, {
    cleanupTimeoutMs: 30,
    ...options,
  });
  const instanceSignal = new AbortController();
  let allowed = true;
  const authorize = (action, id) => {
    options.authorize?.(action, id);
    if (!allowed)
      throw Object.assign(new Error("forbidden"), { code: "forbidden" });
  };
  const instance = manager.instance(origin, {
    signal: instanceSignal.signal,
    authorize,
    assertActive: () => {},
  });
  const controllers = [];
  function run(key = "caller") {
    const work = store.openWork({
      callerKey: key,
      pwd: path.join(root, "work"),
      snapshotRef: "work/test",
    });
    let row = store.acceptRun({
      callerKey: key,
      contextId: work.contextId,
      sourceKind: "inline",
      source: {},
    }).run;
    row = store.transitionRun(row.runId, row.revision, "preparing_inputs");
    row = store.transitionRun(row.runId, row.revision, "running");
    const controller = new AbortController();
    controllers.push(controller);
    const binding = {
      runId: row.runId,
      signal: controller.signal,
      authorize,
      assertActive: () => {
        controller.signal.throwIfAborted();
      },
    };
    return { row, controller, binding, resources: instance.bind(binding) };
  }
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    instanceSignal.abort();
    // Let bounded attempts finish before removing their actual profile database.
    await delay(45);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    manager,
    instance,
    instanceSignal,
    run,
    revoke: () => {
      allowed = false;
    },
  };
}
function control(dispose) {
  const closed = Promise.withResolvers();
  let stops = 0;
  const value = {
    closed: closed.promise,
    dispose(reason) {
      stops++;
      return dispose?.(closed, reason);
    },
  };
  return { value, closed, stops: () => stops };
}

test("Agent shutdown stops registered run, background and instance controllers and closes admission", async (t) => {
  const f = fixture(t),
    run = f.run(),
    background = f.run();
  const controllers = [
    control(({ resolve }) => resolve()),
    control(({ resolve }) => resolve()),
    control(({ resolve }) => resolve()),
  ];
  const active = await run.resources.register({
    kind: "process",
    value: controllers[0].value,
  });
  const handed = await background.resources.register({
    kind: "process",
    value: controllers[1].value,
  });
  await background.resources.handoff(handed.id);
  const shared = await f.instance.resources.register({
    kind: "connection",
    value: controllers[2].value,
  });
  const first = f.manager.shutdown(new Error("explicit Agent stop"));
  assert.equal(f.manager.shutdown(), first);
  await assert.rejects(
    run.resources.register({ kind: "process", value: control().value }),
    { code: "agent_stopping" },
  );
  const result = await first;
  assert.deepEqual(result, { closed: 3, unconfirmed: [] });
  for (const current of [active, handed, shared])
    assert.notEqual(f.store.getResource(current.id).closedAt, null);
  controllers.forEach((controller) => assert.equal(controller.stops(), 1));
  assert.throws(
    () =>
      f.manager.instance(origin, {
        signal: new AbortController().signal,
        assertActive() {},
        authorize() {},
      }),
    { code: "agent_stopping" },
  );
});

test("Agent shutdown retains unknown physical closure and only an explicit retry confirms later evidence", async (t) => {
  const f = fixture(t),
    run = f.run(),
    pending = control();
  const ref = await run.resources.register({
    kind: "process",
    value: pending.value,
  });
  await run.resources.handoff(ref.id);
  const result = await f.manager.shutdown();
  assert.equal(result.closed, 0);
  assert.equal(result.unconfirmed.length, 1);
  assert.equal(f.store.getResource(ref.id).closedAt, null);
  assert.equal(pending.stops(), 1);
  pending.closed.resolve();
  await f.manager.shutdown();
  assert.notEqual(f.store.getResource(ref.id).closedAt, null);
  assert.equal(pending.stops(), 1);
});

async function resource(r, kind = "process", state = "running") {
  const c = control(({ resolve }) => resolve());
  const ref = await r.resources.register({ kind, value: c.value });
  ref.report({ state, label: ref.id });
  return { ...c, ref };
}

test("public resource history snapshots retain reported facts without leaking runtime identities or control objects", async (t) => {
  const f = fixture(t),
    r = f.run(),
    current = await resource(r);
  const active = await r.resources.describe(current.ref.id);
  assert.equal(active.id, current.ref.id);
  assert.equal(active.controlAvailable, true);
  assert.equal(active.contextId, r.row.contextId);
  assert.deepEqual(active.origin, origin);
  assert.equal(active.status, "registered");
  assert.equal(active.details.state, "running");
  for (const key of [
    "callerKey",
    "bootId",
    "instanceId",
    "value",
    "signal",
    "report",
  ])
    assert.equal(Object.hasOwn(active, key), false, key);
  assert.equal(Object.hasOwn(active.origin, "instanceId"), false);
  active.details.state = "changed";
  active.origin.version = "changed";
  assert.equal(
    (await r.resources.describe(current.ref.id)).details.state,
    "running",
  );
  assert.equal(
    (await r.resources.describe(current.ref.id)).origin.version,
    "1",
  );
  current.ref.report({ state: "exited", exitCode: 0 });
  assert.equal(
    (await r.resources.list({ state: "exited" })).items[0].status,
    "registered",
  );
  current.ref.report({ state: { status: "exited" } });
  assert.equal(
    (await r.resources.list({ state: '{"status":"exited"}' })).items.length,
    0,
  );
  current.ref.report({ state: "exited", exitCode: 0 });
  current.closed.resolve();
  await f.manager.waitForRunClosure(r.row.runId);
  const historical = await r.resources.describe(current.ref.id);
  assert.equal(historical.status, "closed");
  assert.equal(historical.details.state, "exited");
  assert.notEqual(historical.closedAt, null);
  assert.equal(historical.controlAvailable, false);
  await assert.rejects(() => r.resources.get(current.ref.id), {
    code: "resource_unavailable",
  });
  await assert.rejects(() => f.instance.resources.describe(current.ref.id), {
    code: "resource_history_requires_call",
  });
  await assert.rejects(() => f.instance.resources.list(), {
    code: "resource_history_requires_call",
  });
});

test("history filters and stable pages span ended resources, preserve mid-batch positions and bind callers/sources/filters", async (t) => {
  const f = fixture(t),
    first = f.run(),
    second = f.run();
  const values = [];
  for (let index = 0; index < 27; index++)
    values.push(
      await resource(
        index % 2 ? first : second,
        index % 3 ? "process" : "session",
        index % 4 ? "running" : "exited",
      ),
    );
  for (const item of values.slice(0, 5)) item.closed.resolve();
  await delay(0);
  const expected = values
    .map((item) => f.store.getResource(item.ref.id))
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt || b.resourceId.localeCompare(a.resourceId),
    )
    .map((item) => item.resourceId);
  const normal = await first.resources.list();
  assert.equal(normal.items.length, 20);
  assert.notEqual(normal.nextCursor, null);
  assert.deepEqual(
    (await second.resources.list({ cursor: normal.nextCursor })).items.map(
      (item) => item.id,
    ),
    expected.slice(20),
  );
  const all = [];
  let cursor;
  do {
    const page = await first.resources.list({
      limit: 3,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(all, expected);
  assert.equal(new Set(all).size, 27);
  const filtered = await first.resources.list({
    kind: "process",
    state: "running",
    runId: first.row.runId,
    contextId: first.row.contextId,
    limit: 100,
  });
  assert.ok(filtered.items.length > 0);
  for (const item of filtered.items) {
    assert.equal(item.kind, "process");
    assert.equal(item.details.state, "running");
    assert.equal(item.originRunId, first.row.runId);
    assert.equal(item.contextId, first.row.contextId);
  }
  const ended = await first.resources.list({ status: "closed" });
  assert.equal(ended.items.length, 5);
  const otherCaller = f.run("another-caller");
  await assert.rejects(
    () => otherCaller.resources.list({ cursor: normal.nextCursor }),
    { code: "invalid_cursor" },
  );
  await assert.rejects(
    () => first.resources.list({ state: "running", cursor: normal.nextCursor }),
    { code: "invalid_cursor" },
  );
  await assert.rejects(
    () =>
      first.resources.list({ cursor: normal.nextCursor.slice(0, -2) + "zz" }),
    { code: "invalid_cursor" },
  );
  for (const query of [
    { limit: 0 },
    { limit: 101 },
    { state: { not: "running" } },
    { unknown: "x" },
  ])
    await assert.rejects(() => first.resources.list(query));
});

test("history reads span source versions but reject another namespace while live control stays on its original instance", async (t) => {
  const f = fixture(t),
    r = f.run(),
    current = await resource(r);
  const binding = { ...r.binding, authorize() {} };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const newer = f.manager.instance(
    { ...origin, version: "2", revision: "two" },
    { signal: controller.signal, assertActive() {}, authorize() {} },
  );
  const reader = newer.bind(binding);
  assert.equal((await reader.describe(current.ref.id)).origin.version, "1");
  assert.equal((await reader.describe(current.ref.id)).controlAvailable, false);
  assert.equal((await reader.list()).items.length, 1);
  await assert.rejects(() => reader.get(current.ref.id), {
    code: "resource_owner_mismatch",
  });
  const foreign = f.manager
    .instance(
      { ...origin, namespace: "other" },
      { signal: controller.signal, assertActive() {}, authorize() {} },
    )
    .bind(binding);
  await assert.rejects(() => foreign.describe(current.ref.id), {
    code: "resource_owner_mismatch",
  });
  assert.equal((await foreign.list()).items.length, 0);
  const first = await r.resources.list({ limit: 1 });
  await resource(r);
  const page = await r.resources.list({ limit: 1 });
  assert.notEqual(page.nextCursor, null);
  await assert.rejects(() => foreign.list({ cursor: page.nextCursor }), {
    code: "invalid_cursor",
  });
  current.closed.resolve();
  await delay(0);
});

test("history pages filter only current per-id denials and propagate source/policy configuration failures", async (t) => {
  const denied = new Set();
  let failure;
  const f = fixture(t, {
    authorize(action, id) {
      if (failure && action === "list" && id) throw failure;
      if (id && denied.has(id))
        throw Object.assign(new Error("private"), { code: "forbidden" });
    },
  });
  const r = f.run(),
    values = [];
  for (let index = 0; index < 12; index++) values.push(await resource(r));
  const ordered = values
    .map((value) => f.store.getResource(value.ref.id))
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt || b.resourceId.localeCompare(a.resourceId),
    );
  ordered
    .filter((_, index) => index % 2 === 0)
    .forEach((item) => denied.add(item.resourceId));
  let cursor;
  const visible = [];
  do {
    const page = await r.resources.list({
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    visible.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(
    visible,
    ordered
      .filter((item) => !denied.has(item.resourceId))
      .map((item) => item.resourceId),
  );
  await assert.rejects(() => r.resources.describe(ordered[0].resourceId), {
    code: "forbidden",
  });
  class SourceConfigError extends Error {
    code = "forbidden";
  }
  failure = new SourceConfigError("invalid configured authority");
  await assert.rejects(
    () => r.resources.list(),
    (cause) => cause === failure,
  );
  failure = new Error("unexpected policy exception");
  await assert.rejects(
    () => r.resources.list(),
    (cause) => cause === failure,
  );
  failure = undefined;
  f.revoke();
  await assert.rejects(() => r.resources.list(), { code: "forbidden" });
  await assert.rejects(() => r.resources.describe(values[1].ref.id), {
    code: "forbidden",
  });
});

test("page byte budgets retain complete individual details and resume without omitting records", async (t) => {
  const f = fixture(t),
    r = f.run(),
    ids = [];
  for (let index = 0; index < 8; index++) {
    const item = await resource(r);
    item.ref.report({ state: "exited", text: "x".repeat(15000) });
    ids.push(item.ref.id);
  }
  let cursor;
  const all = [];
  do {
    const page = await r.resources.list({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536);
    assert.ok(page.items.length > 0 && page.items.length < 8);
    for (const item of page.items)
      assert.equal(item.details.text.length, 15000);
    all.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(new Set(all), new Set(ids));
  assert.equal(all.length, ids.length);
});

test("bounded denied scans return an opaque continuation instead of hiding later visible history", async (t) => {
  const denied = new Set();
  const f = fixture(t, {
    authorize(action, id) {
      if (action === "list" && denied.has(id))
        throw Object.assign(new Error("private"), { code: "forbidden" });
    },
  });
  const r = f.run();
  let visible;
  for (let index = 0; index < 1003; index++) {
    const row = f.store.registerResource(
      {
        callerKey: "caller",
        kind: "process",
        runId: r.row.runId,
        source: { ...origin, instanceId: f.instance.id },
      },
      Date.now() - 2000 + index,
    );
    if (index < 2) visible ??= row.resourceId;
    else denied.add(row.resourceId);
  }
  const first = await r.resources.list();
  assert.equal(first.items.length, 0);
  assert.notEqual(first.nextCursor, null);
  const decoded = Buffer.from(first.nextCursor, "base64url");
  assert.equal(decoded.includes(Buffer.from([...denied][0])), false);
  assert.throws(() => JSON.parse(decoded.toString("utf8")));
  const next = await r.resources.list({ cursor: first.nextCursor });
  assert.equal(next.items.length, 2);
  assert.equal(next.nextCursor, null);
  assert.ok(next.items.some((item) => item.id === visible));
});

test("v2 migration preserves state/resource history and restart readers cannot reacquire old controls", async (t) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-resource-history-migration-")),
  );
  mkdirSync(path.join(root, "work"));
  const binding = {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  };
  const filename = path.join(root, "state", "runtime.sqlite");
  let store = new SqliteStore(root, binding);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const row = store.registerResource({
    callerKey: "old-caller",
    kind: "process",
    source: { ...origin, instanceId: "old-instance" },
  });
  store.resourceDiagnostic(row.resourceId, "registered", {
    details: { state: "running", pid: 123 },
  });
  store.setState("kept", { value: 1 }, null);
  store.setState("deleted", 1, null);
  store.deleteState("deleted", 1);
  store.close();
  let db = new DatabaseSync(filename);
  db.exec(
    "DROP TABLE task_artifacts; DROP INDEX resources_history; ALTER TABLE runs DROP COLUMN admission_class; PRAGMA user_version=2",
  );
  db.close();
  assert.throws(
    () => new SqliteStore(root, { ...binding, profile: "production" }),
    { code: "storage_binding_mismatch" },
  );
  db = new DatabaseSync(filename);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(
    db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .some((column) => column.name === "admission_class"),
    false,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='resources_history'",
      )
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='task_artifacts'",
      )
      .get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT version FROM agent_state WHERE key='deleted'").get()
      .version,
    2,
  );
  db.close();
  store = new SqliteStore(root, binding);
  assert.deepEqual(store.getState("kept").value, { value: 1 });
  assert.equal(store.getState("deleted"), null);
  assert.equal(store.setState("deleted", 2, null).version, 3);
  const work = store.openWork({
    callerKey: "new-caller",
    pwd: path.join(root, "work"),
    snapshotRef: "work/test",
  });
  let run = store.acceptRun({
    callerKey: "new-caller",
    contextId: work.contextId,
    sourceKind: "inline",
    source: {},
  }).run;
  run = store.transitionRun(run.runId, run.revision, "preparing_inputs");
  run = store.transitionRun(run.runId, run.revision, "running");
  const signal = new AbortController(),
    manager = new ResourceManager(store);
  const instance = manager.instance(
    { ...origin, version: "2", revision: "two" },
    { signal: signal.signal, assertActive() {}, authorize() {} },
  );
  const reader = instance.bind({
    runId: run.runId,
    signal: signal.signal,
    assertActive() {},
    authorize() {},
  });
  const snapshot = await reader.describe(row.resourceId);
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.closedAt, null);
  assert.equal(snapshot.controlAvailable, false);
  assert.equal(snapshot.details.pid, 123);
  assert.equal(
    (await reader.list({ state: "running" })).items[0].id,
    row.resourceId,
  );
  await assert.rejects(() => reader.get(row.resourceId), {
    code: "resource_owner_mismatch",
  });
  store.close();
  db = new DatabaseSync(filename);
  assert.equal(
    db.prepare("PRAGMA user_version").get().user_version,
    schemaVersion,
  );
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM managed_resources
    WHERE json_extract(source_json,'$.owner')=? AND json_extract(source_json,'$.namespace')=? AND json_extract(source_json,'$.type')=?
    ORDER BY created_at DESC,resource_id DESC LIMIT 20`,
    )
    .all(origin.owner, origin.namespace, origin.type);
  assert.ok(plan.some((item) => item.detail.includes("resources_history")));
  assert.ok(plan.every((item) => !item.detail.includes("TEMP B-TREE")));
  db.close();
});

test("resource facts follow the registered lifetime without granting ownership or completion authority", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control();
  const ref = await r.resources.register({ kind: "process", value: c.value });
  ref.report({ pid: 123, outputComplete: false });
  assert.deepEqual(f.store.getResource(ref.id).diagnostic.details, {
    pid: 123,
    outputComplete: false,
  });
  await r.resources.handoff(ref.id);
  r.controller.abort();
  ref.report({ pid: 123, exitCode: 0, status: "closed", ownerRunId: "fake" });
  const row = f.store.getResource(ref.id);
  assert.equal(row.lifetime, "background");
  assert.equal(row.ownerRunId, null);
  assert.equal(row.closedAt, null);
  assert.equal(row.status, "registered");
  let called = false;
  const data = Object.defineProperty({}, "bad", {
    enumerable: true,
    get() {
      called = true;
      return 1;
    },
  });
  assert.throws(() => ref.report(data));
  assert.equal(called, false);
  c.closed.resolve();
  await delay(5);
  assert.notEqual(f.store.getResource(ref.id).closedAt, null);
  assert.throws(() => ref.report({ pid: 123 }), {
    code: "resource_unavailable",
  });
});

test("registration fixes identity before start; duplicates keep the original id and require current authority", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control();
  const ref = await r.resources.register({ kind: "process", value: c.value });
  assert.equal(f.store.getResource(ref.id).status, "registered");
  assert.equal(
    (await r.resources.register({ kind: "process", value: c.value })).id,
    ref.id,
  );
  assert.equal(c.stops(), 0);
  await assert.rejects(
    () => r.resources.register({ kind: "browser", value: c.value }),
    { code: "resource_owner_mismatch" },
  );
  const other = f.run();
  await assert.rejects(
    () => other.resources.register({ kind: "process", value: c.value }),
    { code: "resource_owner_mismatch" },
  );
  f.revoke();
  await assert.rejects(
    () => r.resources.register({ kind: "process", value: c.value }),
    { code: "forbidden" },
  );
  await assert.rejects(() => r.resources.get(ref.id), { code: "forbidden" });
  c.closed.resolve();
  await f.manager.waitForRunClosure(r.row.runId);
});

test("run cancellation requests disposal but cannot claim closure until the real closed Promise settles", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control();
  const ref = await r.resources.register({ kind: "session", value: c.value });
  r.controller.abort(new Error("cancelled"));
  await delay(0);
  assert.equal(ref.signal.aborted, true);
  assert.equal(c.stops(), 1);
  assert.equal(f.store.getResource(ref.id).closedAt, null);
  const report = await f.manager.cleanupRun(r.row.runId);
  assert.equal(report.unconfirmed[0].id, ref.id);
  assert.equal(c.stops(), 1);
  assert.throws(
    () =>
      f.store.transitionRun(
        r.row.runId,
        f.store.getRun(r.row.runId).revision,
        "succeeded",
      ),
    { code: "run_cleanup_pending" },
  );
  c.closed.resolve();
  await f.manager.waitForRunClosure(r.row.runId);
  assert.equal(f.store.getResource(ref.id).status, "closed");
  const row = f.store.getRun(r.row.runId);
  assert.equal(
    f.store.transitionRun(row.runId, row.revision, "succeeded").status,
    "succeeded",
  );
});

test("successful handoff commits before detaching the old signal; later runs borrow without acquiring ownership", async (t) => {
  const f = fixture(t),
    first = f.run(),
    second = f.run(),
    c = control();
  const ref = await first.resources.register({
    kind: "process",
    value: c.value,
  });
  const handoff = await first.resources.handoff(ref.id);
  assert.equal(handoff.ownerRunId, null);
  assert.equal(handoff.lifetime, "background");
  assert.equal(
    (await first.resources.handoff(ref.id)).handedOffAt,
    handoff.handedOffAt,
  );
  assert.equal((await second.resources.get(ref.id)).value, c.value);
  first.controller.abort();
  second.controller.abort();
  await delay(0);
  assert.equal(ref.signal.aborted, false);
  assert.equal(c.stops(), 0);
  assert.deepEqual(
    (await f.manager.cleanupRun(first.row.runId)).unconfirmed,
    [],
  );
  assert.equal(f.instance.busy(), true);
  await assert.rejects(() => f.instance.stop(), { code: "extension_busy" });
  c.closed.resolve();
  await delay(0);
  assert.equal(f.store.getResource(ref.id).handedOffAt, handoff.handedOffAt);
  assert.equal(f.store.getResource(ref.id).closedAt !== null, true);
  assert.equal(f.instance.busy(), false);
});

test("a failed handoff keeps run cleanup attached, while cancellation or closure first refuses a new background identity", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control(({ resolve }) => resolve());
  const ref = await r.resources.register({ kind: "process", value: c.value });
  const handoff = f.store.handoff.bind(f.store);
  f.store.handoff = () => {
    throw new Error("sqlite failure");
  };
  await assert.rejects(() => r.resources.handoff(ref.id), /sqlite failure/);
  f.store.handoff = handoff;
  r.controller.abort();
  await f.manager.waitForRunClosure(r.row.runId);
  assert.equal(c.stops(), 1);
  assert.equal(f.store.getResource(ref.id).lifetime, "run");
  const other = f.run(),
    already = control();
  const closedRef = await other.resources.register({
    kind: "process",
    value: already.value,
  });
  already.closed.resolve();
  await f.manager.waitForRunClosure(other.row.runId);
  await assert.rejects(() => other.resources.handoff(closedRef.id), {
    code: "resource_unavailable",
  });
});

test("handoff retry checks authority before returning its retained fact, even after natural closure", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control();
  const ref = await r.resources.register({ kind: "process", value: c.value });
  const row = await r.resources.handoff(ref.id);
  c.closed.resolve();
  await delay(0);
  const retry = await r.resources.handoff(ref.id);
  assert.equal(retry.handedOffAt, row.handedOffAt);
  assert.equal(retry.status, "closed");
  f.revoke();
  await assert.rejects(() => r.resources.handoff(ref.id), {
    code: "forbidden",
  });
});

test("concurrent cleanup reuses one actual dispose; failed attempts are observable and can be explicitly retried", async (t) => {
  const f = fixture(t),
    r = f.run();
  let first = true;
  const c = control((closed) => {
    if (first) {
      first = false;
      throw new Error("sensitive failure");
    }
    closed.resolve();
  });
  const ref = await r.resources.register({ kind: "session", value: c.value });
  const reports = await Promise.all([
    f.manager.cleanupRun(r.row.runId),
    f.manager.cleanupRun(r.row.runId),
  ]);
  assert.equal(c.stops(), 1);
  assert.equal(reports[0].unconfirmed.length, 1);
  assert.equal(
    reports[0].unconfirmed[0].diagnostic.disposeError,
    "dispose_failed",
  );
  assert.doesNotMatch(JSON.stringify(reports), /sensitive failure/);
  assert.equal(f.store.getResource(ref.id).closedAt, null);
  const retried = await f.manager.cleanupRun(r.row.runId);
  assert.equal(c.stops(), 2);
  assert.equal(retried.closed, 1);
  assert.equal(
    f.store.getResource(ref.id).diagnostic.disposeError,
    "dispose_failed",
  );
});

test("closed rejection is an unconfirmed diagnostic and never a closure fact or an unhandled rejection", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control();
  const ref = await r.resources.register({ kind: "session", value: c.value });
  c.closed.reject(new Error("secret failure"));
  await delay(0);
  assert.equal(f.store.getResource(ref.id).diagnostic.code, "closed_rejected");
  const retained = await r.resources.get(ref.id);
  assert.equal(retained.signal.aborted, true);
  assert.equal(retained.value, c.value);
  const report = await f.manager.cleanupRun(r.row.runId);
  assert.equal(report.unconfirmed.length, 1);
  assert.equal(f.store.getResource(ref.id).closedAt, null);
  assert.doesNotMatch(JSON.stringify(report), /secret failure/);
});

test("instance resources are shared rather than run-owned, and another version cannot fetch their raw controls", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control(({ resolve }) => resolve());
  const ref = await f.instance.resources.register({
    kind: "connection",
    value: c.value,
  });
  assert.equal(f.store.getResource(ref.id).lifetime, "instance");
  assert.equal((await r.resources.get(ref.id)).id, ref.id);
  await assert.rejects(() => r.resources.handoff(ref.id), {
    code: "resource_owner_mismatch",
  });
  r.controller.abort();
  await delay(0);
  assert.equal(c.stops(), 0);
  const other = f.manager.instance(
    { ...origin, version: "2" },
    {
      signal: new AbortController().signal,
      authorize: () => {},
      assertActive: () => {},
    },
  );
  await assert.rejects(() => other.resources.get(ref.id), {
    code: "resource_owner_mismatch",
  });
  const closed = await f.instance.stop();
  assert.equal(closed.closed, 1);
  await assert.rejects(() => f.instance.resources.get(ref.id), {
    code: "extension_unavailable",
  });
});

test("capacity and malformed controls fail before registration or startup; diagnostic APIs cannot manufacture closure", async (t) => {
  const f = fixture(t, { capacity: 1 }),
    r = f.run(),
    c = control();
  await assert.rejects(
    () =>
      r.resources.register({
        kind: "bad",
        value: { closed: Promise.resolve(), dispose: null },
      }),
    { code: "invalid_resource" },
  );
  await assert.rejects(
    () =>
      r.resources.register({
        kind: "bad",
        value: { closed: { then() {} }, dispose() {} },
      }),
    { code: "invalid_resource" },
  );
  const ref = await r.resources.register({ kind: "session", value: c.value });
  await assert.rejects(
    () => r.resources.register({ kind: "other", value: control().value }),
    { code: "resource_busy" },
  );
  assert.throws(() => f.store.resourceDiagnostic(ref.id, "closed", {}), {
    code: "invalid_resource_diagnostic",
  });
  c.closed.resolve();
  await f.manager.waitForRunClosure(r.row.runId);
  const next = control();
  await r.resources.register({ kind: "other", value: next.value });
  next.closed.resolve();
  await f.manager.waitForRunClosure(r.row.runId);
});

test("a failed closure write rejects confirmation without inventing closure or leaking a rejection", async (t) => {
  const f = fixture(t),
    r = f.run(),
    c = control();
  const ref = await r.resources.register({ kind: "session", value: c.value });
  const pending = f.manager.waitForRunClosure(r.row.runId);
  f.store.closeResource = () => {
    throw new Error("database unavailable");
  };
  c.closed.resolve();
  await assert.rejects(() => pending, { code: "resource_persistence_failed" });
  assert.equal(f.store.getResource(ref.id).closedAt, null);
  await assert.rejects(() => r.resources.get(ref.id), {
    code: "resource_unavailable",
  });
  assert.throws(
    () =>
      f.store.transitionRun(
        r.row.runId,
        f.store.getRun(r.row.runId).revision,
        "succeeded",
      ),
    { code: "run_cleanup_pending" },
  );
});

test("a native process starts only after registration; real stream/child close confirms cleanup", async (t) => {
  const f = fixture(t, { cleanupTimeoutMs: 2000 }),
    r = f.run();
  const closed = Promise.withResolvers();
  let child,
    state = "created",
    ref;
  const value = {
    closed: closed.promise,
    async start() {
      assert.equal(state, "created");
      ref.signal.throwIfAborted();
      state = "starting";
      assert.equal(f.store.getResource(ref.id).status, "registered");
      child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = once(child, "close");
      void exited.then(
        () => {
          state = "closed";
          closed.resolve();
        },
        (error) => closed.reject(error),
      );
      const ready = once(child.stdout, "data");
      const output = await ready;
      assert.match(output[0].toString(), /ready/);
      ref.signal.throwIfAborted();
      state = "running";
    },
    dispose() {
      if (state === "closed" || state === "stopping") return;
      state = "stopping";
      if (child) child.kill();
      else {
        state = "closed";
        closed.resolve();
      }
    },
  };
  t.after(async () => {
    if (child && state !== "closed") {
      child.kill("SIGKILL");
      await closed.promise;
    }
  });
  ref = await r.resources.register({ kind: "process", value });
  await value.start();
  assert.equal(typeof child.pid, "number");
  r.controller.abort();
  await f.manager.waitForRunClosure(r.row.runId);
  assert.equal(state, "closed");
  assert.equal(child.stdout.destroyed, true);
  assert.equal(f.store.getResource(ref.id).closedAt !== null, true);
});
