import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { newRequestId, digest } from "../dist/contracts/json.js";

const binding = {
  agentId: "agent_test",
  profile: "development",
  cloudEnvironment: "cloud_test",
};
const sdkOrigin = {
  type: "extension",
  owner: "@test/operations",
  namespace: "calls",
  version: "1",
  revision: "source",
  unrelatedSecret: "not-for-operation-history",
};
function setup(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-store-")),
  );
  const store = new SqliteStore(root, binding);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const work = store.openWork({
    callerKey: "caller",
    pwd: root,
    snapshotRef: "work/tmp/work.json",
  });
  return { store, work, root };
}
function accept(store, work, more = {}, now = Date.now()) {
  return store.acceptRun(
    {
      callerKey: "caller",
      contextId: work.contextId,
      sourceKind: "inline",
      source: { codeSource: "inline" },
      ...more,
    },
    now,
  ).run;
}
function start(store, work, more = {}) {
  let run = accept(store, work, more);
  run = store.transitionRun(run.runId, run.revision, "preparing_inputs");
  return store.transitionRun(run.runId, run.revision, "running");
}

test("profile storage cannot follow a state junction into another root", (t) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-profile-path-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  const agentRoot = path.join(root, "agent");
  mkdirSync(outside);
  mkdirSync(agentRoot);
  symlinkSync(outside, path.join(agentRoot, "state"), "junction");
  assert.throws(() => new SqliteStore(agentRoot, binding), {
    code: "storage_path_escape",
  });
  assert.equal(existsSync(path.join(outside, "runtime.sqlite")), false);
});

test("unrepresentable runtime deadlines are rejected before acceptance", (t) => {
  const { store, work } = setup(t),
    now = Date.now();
  assert.throws(
    () => accept(store, work, { timeoutMs: 253402300800000 - now }, now),
    { code: "invalid_timeout" },
  );
  assert.equal(store.listRuns({}, "scope").runs.length, 0);
});

test("initialization creates a bound WAL database; future and mismatched stores are never reset", (t) => {
  const { store, root, work } = setup(t);
  const run = start(store, work);
  store.close();
  assert.throws(
    () => new SqliteStore(root, { ...binding, profile: "production" }),
    { code: "storage_binding_mismatch" },
  );
  const db = new DatabaseSync(path.join(root, "state/runtime.sqlite"));
  assert.equal(
    db.prepare("SELECT status FROM runs WHERE run_id=?").get(run.runId).status,
    "running",
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.exec("PRAGMA user_version=2");
  db.close();
  assert.throws(() => new SqliteStore(root, binding), {
    code: "storage_future_version",
  });
  const check = new DatabaseSync(path.join(root, "state/runtime.sqlite"));
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(check.prepare("SELECT count(*) n FROM runs").get().n, 1);
  check.close();
});

test("failed initial migration rolls back schema and preserves existing data", (t) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-migrate-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "state"));
  const filename = path.join(root, "state/runtime.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE runs(kept TEXT); INSERT INTO runs VALUES('original')");
  db.close();
  assert.throws(() => new SqliteStore(root, binding), {
    code: "storage_error",
  });
  const check = new DatabaseSync(filename);
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(check.prepare("SELECT kept FROM runs").get().kept, "original");
  assert.equal(
    check
      .prepare("SELECT count(*) n FROM sqlite_master WHERE name='runtime_meta'")
      .get().n,
    0,
  );
  check.close();
});

test("dedup returns the original run before capacity or old-context checks; changed intent and expired IDs fail", (t) => {
  const { store, work } = setup(t);
  const now = Date.now(),
    requestId = newRequestId(now),
    intentDigest = digest({ script: "return 1" });
  const first = accept(
    store,
    work,
    { requestId, intentDigest, capacity: 1 },
    now,
  );
  store.closeWork(work.contextId, "caller", now + 1);
  const repeated = store.acceptRun(
    {
      callerKey: "caller",
      contextId: work.contextId,
      sourceKind: "inline",
      source: {},
      requestId,
      intentDigest,
      capacity: 1,
    },
    now + 2,
  );
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.run.runId, first.runId);
  assert.throws(
    () =>
      accept(store, work, { requestId, intentDigest: "different" }, now + 2),
    { code: "submission_conflict" },
  );
  assert.throws(
    () => accept(store, work, { requestId, intentDigest }, now + 86_400_000),
    { code: "submission_expired" },
  );
  assert.throws(() => store.findSubmission("other", requestId, now), {
    code: "submission_unknown",
  });
  assert.equal(
    store.findSubmission("caller", requestId, now).runId,
    first.runId,
  );
  assert.equal(store.listRuns({}, "scope").runs.length, 1);
});

test("capacity refusal creates no accepted run or request; idle work is protected by an active run", (t) => {
  const { store, work } = setup(t);
  const run = accept(store, work, { capacity: 1 });
  assert.throws(() => accept(store, work, { capacity: 1 }), {
    code: "runtime_busy",
  });
  assert.equal(store.listRuns({}, "scope").runs.length, 1);
  const protectedRun = accept(
    store,
    work,
    { capacity: 2 },
    Date.now() + 86_400_001,
  );
  assert.equal(store.getRun(run.runId).status, "accepted");
  assert.equal(protectedRun.contextId, work.contextId);
});

test("single input reservation survives preparation failure and consumes exactly once, including retries after terminal", (t) => {
  const { store, work } = setup(t);
  const run = start(store, work);
  const wait = store.createWait(
    run.runId,
    { message: "Continue?", schema: { type: "boolean" } },
    run.deadlineAt,
  );
  assert.throws(() => store.createWait(run.runId, {}, run.deadlineAt), {
    code: "invalid_wait",
  });
  const reserved = store.reserveInput(run.runId, wait.waitId, "input1");
  assert.equal(reserved.duplicate, false);
  assert.equal(
    store.reserveInput(run.runId, wait.waitId, "input1").duplicate,
    true,
  );
  assert.throws(() => store.reserveInput(run.runId, wait.waitId, "input2"), {
    code: "input_conflict",
  });
  store.failInput(wait.waitId, reserved.wait.revision, {
    code: "attachment_failed",
  });
  assert.equal(store.getRun(run.runId).status, "waiting_input");
  const retry = store.reserveInput(run.runId, wait.waitId, "input2");
  const receipt = { inputAccepted: true, waitId: wait.waitId };
  const consumed = store.consumeInput(
    run.runId,
    wait.waitId,
    "input2",
    retry.wait.revision,
    "work/tmp/input.json",
    receipt,
  );
  assert.equal(consumed.status, "consumed");
  assert.equal(store.getRun(run.runId).status, "running");
  store.transitionRun(run.runId, store.getRun(run.runId).revision, "succeeded");
  assert.deepEqual(
    store.reserveInput(run.runId, wait.waitId, "input2").wait.receipt,
    receipt,
  );
  assert.throws(() => store.reserveInput(run.runId, wait.waitId, "input1"), {
    code: "input_conflict",
  });
  assert.throws(() => store.reserveInput("different", wait.waitId, "input2"), {
    code: "wait_mismatch",
  });
});

test("stop reason is sticky; stale preparation, success and new resources cannot win after cancellation", (t) => {
  const { store, work } = setup(t);
  const run = start(store, work);
  const wait = store.createWait(run.runId, {}, run.deadlineAt);
  const reserved = store.reserveInput(run.runId, wait.waitId, "input");
  const stop = store.requestStop(run.runId, { kind: "cancel" });
  assert.equal(stop.accepted, true);
  assert.equal(
    store.requestStop(run.runId, { kind: "timeout" }).accepted,
    false,
  );
  assert.deepEqual(store.getRun(run.runId).stop, { kind: "cancel" });
  assert.throws(
    () =>
      store.consumeInput(
        run.runId,
        wait.waitId,
        "input",
        reserved.wait.revision,
        "ref",
        {},
      ),
    { code: "input_closed" },
  );
  assert.throws(
    () =>
      store.registerResource({
        runId: run.runId,
        callerKey: "caller",
        kind: "process",
        source: {},
      }),
    { code: "run_stopping" },
  );
  assert.throws(
    () => store.transitionRun(run.runId, stop.run.revision, "succeeded"),
    { code: "run_state_conflict" },
  );
  const finished = store.transitionRun(
    run.runId,
    stop.run.revision,
    "cancelled",
  );
  assert.equal(
    store.requestStop(run.runId, { kind: "cancel" }).run.status,
    "cancelled",
  );
  assert.throws(
    () => store.transitionRun(run.runId, finished.revision, "failed"),
    { code: "run_state_conflict" },
  );
});

test("run terminal waits for run-owned resource closure; handoff persists independent identity", (t) => {
  const { store, work } = setup(t);
  const run = start(store, work);
  const resource = store.registerResource({
    runId: run.runId,
    callerKey: "caller",
    kind: "process",
    source: { namespace: "sh", version: "1" },
  });
  assert.throws(
    () => store.transitionRun(run.runId, run.revision, "succeeded"),
    { code: "run_cleanup_pending" },
  );
  const detached = store.handoff(
    resource.resourceId,
    run.runId,
    resource.revision,
  );
  assert.equal(detached.ownerRunId, null);
  assert.equal(detached.lifetime, "background");
  store.transitionRun(run.runId, run.revision, "succeeded");
  assert.equal(
    store.resourcesForRun(run.runId)[0].resourceId,
    detached.resourceId,
  );
  const ended = store.closeResource(detached.resourceId, detached.revision, {
    exitCode: 0,
  });
  assert.equal(ended.status, "closed");
  assert.equal(
    store.closeResource(ended.resourceId, ended.revision).revision,
    ended.revision,
  );
});

test("project close invalidates all project work while preserving accepted runs and independent resources", (t) => {
  const { store, root } = setup(t);
  const a = store.openWork({
    callerKey: "caller",
    projectId: "project_a",
    pwd: root,
    snapshotRef: "ref1",
  });
  const b = store.openWork({
    callerKey: "caller2",
    projectId: "project_a",
    pwd: root,
    snapshotRef: "ref2",
  });
  const other = store.openWork({
    callerKey: "caller",
    projectId: "project_b",
    pwd: root,
    snapshotRef: "ref3",
  });
  const run = start(store, a);
  const receipt = store.closeWork(a.contextId, "caller");
  assert.deepEqual(
    new Set(receipt.affectedContextIds),
    new Set([a.contextId, b.contextId]),
  );
  assert.equal(store.getWork(b.contextId).status, "closed");
  assert.equal(store.getWork(other.contextId).status, "open");
  assert.equal(store.getRun(run.runId).status, "running");
  assert.deepEqual(store.closeWork(a.contextId, "caller"), receipt);
  assert.throws(
    () => store.refreshWork(b.contextId, "caller2", b.revision, "ref4"),
    { code: "context_closed" },
  );
  const reopened = store.openWork({
    callerKey: "caller",
    projectId: "new_project_a",
    pwd: root,
    snapshotRef: "ref5",
  });
  store.closeWork(a.contextId, "caller");
  assert.equal(store.getWork(reopened.contextId).status, "open");
});

test("history keyset binds filters and caller scope, handles same timestamp and does not depend on active work", (t) => {
  const { store, work } = setup(t),
    now = Date.now();
  for (let i = 0; i < 5; i++)
    accept(store, work, { sourceKind: "script", scriptName: "x.js" }, now);
  accept(store, work, { scriptName: "other.js" }, now);
  store.closeWork(work.contextId, "caller");
  const first = store.listRuns({ scriptName: "x.js" }, "caller_scope", 2);
  const second = store.listRuns(
    { scriptName: "x.js" },
    "caller_scope",
    2,
    first.nextCursor,
  );
  const third = store.listRuns(
    { scriptName: "x.js" },
    "caller_scope",
    2,
    second.nextCursor,
  );
  assert.equal(
    new Set([...first.runs, ...second.runs, ...third.runs].map((r) => r.runId))
      .size,
    5,
  );
  assert.equal(third.nextCursor, null);
  assert.throws(() => store.listRuns({}, "caller_scope", 2, first.nextCursor), {
    code: "invalid_cursor",
  });
  assert.throws(
    () =>
      store.listRuns(
        { scriptName: "x.js" },
        "different_scope",
        2,
        first.nextCursor,
      ),
    { code: "invalid_cursor" },
  );
  assert.throws(() => store.listRuns({}, "scope", 0), {
    code: "invalid_limit",
  });
  assert.throws(() => store.listRuns({ from: now + 1, to: now }, "scope"), {
    code: "invalid_range",
  });
  assert.equal(store.listRuns({ from: now, to: now }, "scope").runs.length, 0);
});

test("state writes use optimistic versions, and busy storage never becomes a successful memory-only write", (t) => {
  const { store, root } = setup(t);
  const value = store.setState("shared", { n: 1 }, null);
  assert.equal(value.version, 1);
  assert.throws(() => store.setState("shared", { n: 2 }, null), {
    code: "state_version_conflict",
  });
  store.setState("shared", { n: 3 }, 1);
  assert.throws(() => store.setState("shared", { n: 4 }, 1), {
    code: "state_version_conflict",
  });
  store.close();
  const blocker = new DatabaseSync(path.join(root, "state/runtime.sqlite"));
  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => new SqliteStore(root, binding), {
      code: "storage_busy",
    });
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  const reopened = new SqliteStore(root, binding);
  try {
    assert.deepEqual(reopened.getState("shared").value, { n: 3 });
  } finally {
    reopened.close();
  }
});

test("a second process cannot interrupt the live profile's work or run", (t) => {
  const { store, root, work } = setup(t);
  const run = start(store, work);
  const url = new URL("../dist/storage/sqlite.js", import.meta.url).href;
  const code = `import {SqliteStore} from ${JSON.stringify(url)};
    try { new SqliteStore(${JSON.stringify(root)}, ${JSON.stringify(binding)});process.exitCode=1; }
    catch(e) { console.log(e.code); }`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "storage_busy");
  assert.equal(store.getWork(work.contextId).status, "open");
  assert.equal(store.getRun(run.runId).status, "running");
});

test("Agent restart interrupts old work without replay, keeps dedup/history, and does not assert old OS processes stopped", (t) => {
  const { store, work, root } = setup(t);
  const now = Date.now(),
    requestId = newRequestId(now);
  let run = accept(store, work, { requestId, intentDigest: "original" }, now);
  run = store.transitionRun(run.runId, run.revision, "preparing_inputs");
  run = store.transitionRun(run.runId, run.revision, "running");
  const wait = store.createWait(run.runId, {}, run.deadlineAt);
  const resource = store.registerResource({
    runId: run.runId,
    callerKey: "caller",
    kind: "process",
    source: {},
  });
  const detached = store.handoff(
    resource.resourceId,
    run.runId,
    resource.revision,
  );
  store.close();
  const restarted = new SqliteStore(root, binding, now + 10);
  try {
    assert.equal(restarted.getRun(run.runId).status, "interrupted");
    assert.equal(restarted.getWork(work.contextId).status, "expired");
    assert.equal(restarted.getWait(wait.waitId).status, "cancelled");
    assert.equal(
      restarted.findSubmission("caller", requestId, now + 10).runId,
      run.runId,
    );
    assert.equal(
      restarted.getResource(detached.resourceId).status,
      "unavailable",
    );
    assert.equal(
      restarted.getResource(detached.resourceId).diagnostic.osStopped,
      null,
    );
    assert.throws(
      () => restarted.closeResource(detached.resourceId, detached.revision),
      { code: "resource_unavailable" },
    );
  } finally {
    restarted.close();
  }
});

test("ordinary SDK operations guard run completion, preserve terminal outcomes and recover only as interrupted metadata", (t) => {
  const { store, work, root } = setup(t);
  let run = accept(store, work);
  run = store.transitionRun(run.runId, run.revision, "preparing_inputs");
  const operation = store.startOperation(run.runId, sdkOrigin, "prepare");
  assert.equal(operation.callerKey, "caller");
  assert.doesNotMatch(
    JSON.stringify(operation),
    /unrelatedSecret|not-for-operation-history/,
  );
  assert.throws(() => store.transitionRun(run.runId, run.revision, "failed"), {
    code: "run_operations_pending",
  });
  assert.throws(() => store.finishOperation(operation.operationId, "running"), {
    code: "invalid_operation_outcome",
  });
  const failed = store.finishOperation(operation.operationId, "failed", {
    code: "test_failure",
  });
  assert.throws(() => store.finishOperation(failed.operationId, "succeeded"), {
    code: "operation_state_conflict",
  });
  const pending = store.startOperation(run.runId, sdkOrigin, "waiting");
  store.close();
  const reopened = new SqliteStore(root, binding);
  try {
    assert.equal(
      reopened.getOperation(pending.operationId).status,
      "interrupted",
    );
    assert.equal(
      reopened.getOperation(pending.operationId).error.code,
      "agent_restarted",
    );
    assert.equal(reopened.getOperation(failed.operationId).status, "failed");
    assert.equal(reopened.getRun(run.runId).status, "interrupted");
    assert.throws(
      () => reopened.finishOperation(pending.operationId, "succeeded"),
      { code: "operation_state_conflict" },
    );
  } finally {
    reopened.close();
  }
});
