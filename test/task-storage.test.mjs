import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
const dist =
  process.env.NEXUM_TASKS_DIST ?? new URL("../dist/", import.meta.url).href;
const base = dist.startsWith("file:")
  ? new URL(dist)
  : pathToFileURL(dist + path.sep);
const { SqliteStore } = await import(new URL("storage/sqlite.js", base));
const { newRequestId } = await import(new URL("contracts/json.js", base));
const binding = {
  agentId: "agent_tasks",
  profile: "development",
  cloudEnvironment: "test",
};
const day = 86400000,
  startTime = Date.now() - 90 * day;
const origin = {
  type: "extension",
  owner: "@test/process",
  namespace: "sh",
  version: "1",
  revision: "one",
};
const taskId = () =>
  "nx_task_" +
  Buffer.from(JSON.stringify([binding.agentId, randomUUID()])).toString(
    "base64url",
  );

function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-task-store-")),
  );
  let store = new SqliteStore(root, binding, startTime);
  const work = store.openWork(
    { callerKey: "caller", pwd: root, snapshotRef: "unused" },
    startTime,
  );
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const running = (source = {}, extra = {}) => {
    let run = store.acceptRun(
      {
        callerKey: "caller",
        contextId: work.contextId,
        sourceKind: "inline",
        source,
        ...extra,
      },
      startTime,
    ).run;
    run = store.transitionRun(
      run.runId,
      run.revision,
      "preparing_inputs",
      {},
      startTime + 1,
    );
    return store.transitionRun(
      run.runId,
      run.revision,
      "running",
      {},
      startTime + 2,
    );
  };
  return {
    root,
    work,
    get store() {
      return store;
    },
    running,
    finish: (run) =>
      store.transitionRun(
        run.runId,
        store.getRun(run.runId).revision,
        "succeeded",
        {},
        startTime + 3,
      ),
    restart: (now) => {
      store.close();
      store = new SqliteStore(root, binding, now);
      return store;
    },
  };
}

test("unexpired Task and all its local pins protect a terminal run; expiration removes in true batches of at most 100", (t) => {
  const f = fixture(t),
    run = f.finish(f.running());
  const task = f.store.createTask(
    {
      taskId: taskId(),
      callerKey: "caller",
      runId: run.runId,
      ttlMs: 60 * day,
    },
    startTime,
  );
  const ids = Array.from(
    { length: 105 },
    (_, n) => "res_" + n.toString(16).padStart(32, "0"),
  );
  f.store.pinTaskRunArtifacts(run.runId, ids, startTime);
  assert.equal(
    f.store.cleanupBatch({ now: startTime + 40 * day }).deleted.runs,
    undefined,
  );
  assert.equal(f.store.getRun(run.runId).runId, run.runId);
  assert.equal(
    f.store.taskArtifactRetentionUntil(ids[0], null, startTime + 40 * day),
    task.expiresAt,
  );
  const first = f.store.cleanupBatch({ now: startTime + 61 * day });
  assert.equal(first.processed, 100);
  assert.equal(first.deleted.task_artifacts, 100);
  assert.equal(f.store.getRun(run.runId).runId, run.runId);
  const second = f.store.cleanupBatch({ now: startTime + 61 * day });
  assert.ok(second.processed <= 100);
  assert.equal(second.deleted.task_artifacts, 5);
  assert.equal(second.deleted.mcp_tasks, 1);
  assert.equal(second.deleted.runs, 1);
  assert.ok(
    second.files.some((file) => file.ref === `work/tmp/runs/${run.runId}`),
  );
  assert.throws(() => f.store.getRun(run.runId), { code: "run_not_found" });
  assert.throws(() => f.store.cleanupBatch({ limit: 101 }), {
    code: "invalid_cleanup",
  });
});

test("live/background dependencies and retained resource origin context prevent deleting old source runs", (t) => {
  const f = fixture(t),
    run = f.running();
  let resource = f.store.registerResource(
    {
      callerKey: "caller",
      kind: "sh.process",
      source: origin,
      runId: run.runId,
    },
    startTime + 2,
  );
  resource = f.store.handoff(
    resource.resourceId,
    run.runId,
    resource.revision,
    startTime + 2,
  );
  f.finish(run);
  assert.ok(f.store.activeRunIds().has(run.runId));
  f.store.cleanupBatch({ now: startTime + 40 * day });
  assert.equal(f.store.getRun(run.runId).contextId, f.work.contextId);
  f.store.closeResource(
    resource.resourceId,
    resource.revision,
    { osStopped: true },
    startTime + 38 * day,
  );
  f.store.cleanupBatch({ now: startTime + 40 * day });
  assert.equal(f.store.getRun(run.runId).contextId, f.work.contextId);
  const expired = f.store.cleanupBatch({ now: startTime + 70 * day });
  assert.equal(expired.deleted.managed_resources, 1);
  assert.equal(expired.deleted.runs, 1);
  assert.ok(
    expired.files.some(
      (file) =>
        file.kind === "process_log" &&
        file.ref.endsWith(`${resource.resourceId}.output`),
    ),
  );
});

test("replay preparing protects its older retained code even before the new run loads it", (t) => {
  const f = fixture(t),
    old = f.finish(f.running());
  const replay = f.running({ replayRunId: old.runId });
  f.store.cleanupBatch({ now: startTime + 40 * day });
  assert.equal(f.store.getRun(old.runId).runId, old.runId);
  assert.ok(f.store.activeRunIds().has(old.runId));
  f.finish(replay);
  assert.equal(
    f.store.cleanupBatch({ now: startTime + 40 * day }).deleted.runs,
    2,
  );
});

test("restart records first actual unavailability without claiming OS closure or extending it on every boot", (t) => {
  const f = fixture(t),
    run = f.running();
  let resource = f.store.registerResource(
    {
      callerKey: "caller",
      kind: "sh.process",
      source: origin,
      runId: run.runId,
    },
    startTime + 2,
  );
  resource = f.store.handoff(
    resource.resourceId,
    run.runId,
    resource.revision,
    startTime + 2,
  );
  f.finish(run);
  f.restart(startTime + 40 * day);
  let lost = f.store.getResource(resource.resourceId);
  assert.equal(lost.status, "unavailable");
  assert.equal(lost.closedAt, null);
  assert.equal(lost.diagnostic.osStopped, null);
  assert.equal(lost.diagnostic.unavailableAt, startTime + 40 * day);
  f.restart(startTime + 41 * day);
  lost = f.store.getResource(resource.resourceId);
  assert.equal(lost.diagnostic.unavailableAt, startTime + 40 * day);
  assert.equal(
    f.store.cleanupBatch({ now: startTime + 41 * day }).deleted
      .managed_resources,
    undefined,
  );
  assert.equal(
    f.store.cleanupBatch({ now: startTime + 71 * day }).deleted
      .managed_resources,
    1,
  );
});

test("logs, raw attachment inputs and context admission have independent retention; incomplete input cleanup is selected again", (t) => {
  const f = fixture(t);
  let run = f.running();
  run = f.store.transitionRun(
    run.runId,
    run.revision,
    "succeeded",
    { logsRef: `logs/runs/${run.runId}/console.log` },
    startTime + 3,
  );
  let batch = f.store.cleanupBatch({ now: startTime + 2 * day });
  assert.ok(batch.files.some((file) => file.kind === "inputs"));
  assert.ok(!batch.files.some((file) => file.kind === "log"));
  assert.equal(f.store.getWork(f.work.contextId).status, "expired");
  assert.ok(
    f.store
      .cleanupBatch({ now: startTime + 2 * day })
      .files.some((file) => file.kind === "inputs"),
  );
  f.store.completeInputsCleanup(run.runId, startTime + 2 * day);
  assert.ok(
    !f.store
      .cleanupBatch({ now: startTime + 2 * day })
      .files.some((file) => file.kind === "inputs"),
  );
  batch = f.store.cleanupBatch({ now: startTime + 8 * day });
  assert.ok(batch.files.some((file) => file.kind === "log"));
  assert.equal(f.store.getRun(run.runId).logsRef, null);
  assert.equal(f.store.getRun(run.runId).status, "succeeded");
});

test("closed process output expires seven days after actual closure while resource/run facts remain thirty days", (t) => {
  const f = fixture(t),
    run = f.running();
  let resource = f.store.registerResource(
    {
      callerKey: "caller",
      kind: "sh.process",
      source: origin,
      runId: run.runId,
    },
    startTime + 2,
  );
  resource = f.store.closeResource(
    resource.resourceId,
    resource.revision,
    { osStopped: true },
    startTime + 2,
  );
  f.finish(run);
  assert.ok(
    !f.store
      .cleanupBatch({ now: startTime + 6 * day })
      .files.some((file) => file.kind === "process_log"),
  );
  const batch = f.store.cleanupBatch({ now: startTime + 8 * day });
  assert.ok(batch.files.some((file) => file.kind === "process_log"));
  assert.equal(batch.deleted.managed_resources, undefined);
  assert.equal(
    f.store.getResource(resource.resourceId).closedAt,
    resource.closedAt,
  );
  assert.equal(f.store.getRun(run.runId).status, "succeeded");
});

test("submission deduplication keeps its original 24h expiry, and cleanup never treats read access as renewal", (t) => {
  const f = fixture(t),
    requestId = newRequestId(startTime),
    run = f.finish(f.running({}, { requestId, intentDigest: "fixed" }));
  f.store.cleanupBatch({ now: startTime + day / 2 });
  assert.equal(
    f.store.findSubmission("caller", requestId, startTime + day / 2).runId,
    run.runId,
  );
  const expired = f.store.cleanupBatch({ now: startTime + day + 1 });
  assert.equal(expired.deleted.run_requests, 1);
  assert.throws(
    () => f.store.findSubmission("caller", requestId, startTime + day + 1),
    { code: "submission_expired" },
  );
});
