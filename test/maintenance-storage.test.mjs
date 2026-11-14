import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { callerKey } from "../dist/contracts/caller.js";
import { newId, digest } from "../dist/contracts/json.js";

const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
const owner = callerKey({ principalId: "user", clientId: "client" });
const other = callerKey({ principalId: "other", clientId: "client" });
const origin = {
  type: "platform",
  owner: "nexum",
  namespace: "maintenance",
  version: "1",
  revision: "1",
};
function fixture(t, bootId) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-maintenance-storage-")),
  );
  let store = new SqliteStore(root, binding, Date.now(), bootId);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get store() {
      return store;
    },
    restart(nextBoot) {
      store.close();
      store = new SqliteStore(root, binding, Date.now(), nextBoot);
      return store;
    },
    inject(sql) {
      store.close();
      const db = new DatabaseSync(path.join(root, "state/runtime.sqlite"));
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
      store = new SqliteStore(root, binding);
    },
    run(caller = owner) {
      const work = store.openWork({
        callerKey: caller,
        pwd: root,
        snapshotRef: "unused",
      });
      return store.acceptRun({
        callerKey: caller,
        contextId: work.contextId,
        sourceKind: "inline",
        source: {},
      }).run;
    },
  };
}
function input(overrides = {}) {
  const requestId = overrides.requestId ?? newId("maint_req"),
    approvedRevision =
      overrides.approvedRevision ?? digest({ candidate: requestId });
  const method = overrides.method ?? "packages.install";
  const target = {
    packages: "package",
    extensions: "extension",
    mcp: "mcp",
    api: "api",
  }[method.split(".")[0]];
  return {
    requestId,
    approvedRevision,
    callerKey: owner,
    originRunId: null,
    source: {
      origin,
      target,
      name: "fixture",
      objectId: null,
      baseRevision: null,
      candidateRevision: approvedRevision,
    },
    method,
    detailRef: `state/maintenance/${requestId}/execution.json`,
    ...overrides,
  };
}

test("the trusted pre-handshake process boot is the one persisted in work, run and operation records", (t) => {
  const boot = newId("boot"),
    f = fixture(t, boot);
  assert.equal(f.store.bootId, boot);
  const run = f.run();
  assert.equal(run.bootId, boot);
  assert.equal(f.store.getWork(run.contextId).bootId, boot);
  const accepted = f.store.startMaintenanceOperation(
    input({ originRunId: run.runId }),
  );
  assert.equal(accepted.operation.bootId, boot);
  const next = newId("boot");
  f.restart(next);
  assert.equal(f.store.bootId, next);
  assert.equal(f.store.getRun(run.runId).status, "interrupted");
  assert.equal(
    f.store.getOperation(accepted.operation.operationId).status,
    "interrupted",
  );
  for (const bad of [
    "",
    "boot_invalid",
    "boot_" + "a".repeat(31),
    "boot_" + "A".repeat(32),
    null,
    {},
    12,
  ]) {
    const target = path.join(f.root, "invalid-" + newId("case"));
    assert.throws(() => new SqliteStore(target, binding, Date.now(), bad), {
      code: "invalid_boot_id",
    });
    assert.equal(existsSync(target), false);
  }
  const automatic = fixture(t);
  assert.match(automatic.store.bootId, /^boot_[0-9a-f]{32}$/);
  assert.notEqual(automatic.store.bootId, boot);
});

test("a maintenance request registers one independent real operation without inventing a source run", (t) => {
  const f = fixture(t),
    candidate = input();
  assert.equal(f.store.getMaintenanceOperation(candidate.requestId), null);
  const first = f.store.startMaintenanceOperation(candidate, 1000);
  assert.equal(first.duplicate, false);
  assert.equal(first.operation.originRunId, null);
  assert.equal(first.operation.namespace, "maintenance");
  assert.equal(first.operation.status, "running");
  assert.equal(first.operation.createdAt, 1000);
  assert.equal(first.operation.detailRef, candidate.detailRef);
  assert.equal(first.operation.approvedRevision, candidate.approvedRevision);
  assert.equal(first.operation.maintenanceRequestId, candidate.requestId);
  assert.equal(first.operation.callerKey, owner);
  assert.deepEqual(first.operation.source, candidate.source);
  const { origin, ...fields } = candidate.source;
  const duplicate = f.store.startMaintenanceOperation(
    { ...candidate, source: { ...fields, origin } },
    2000,
  );
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.operation, first.operation);
  assert.equal(
    f.store.getMaintenanceOperation(candidate.requestId).operationId,
    first.operation.operationId,
  );
  assert.deepEqual(f.store.listRuns({}, "inspection").runs, []);
  assert.throws(() => f.store.getMaintenanceOperation("not-a-request"), {
    code: "invalid_maintenance_request",
  });
});

test("all eleven approved actions retain their exact method and matching safe target", (t) => {
  const f = fixture(t);
  for (const method of [
    "packages.install",
    "packages.update",
    "packages.remove",
    "extensions.enable",
    "extensions.disable",
    "mcp.add",
    "mcp.update",
    "mcp.remove",
    "api.import",
    "api.update",
    "api.remove",
  ]) {
    const candidate = input({ method });
    const first = f.store.startMaintenanceOperation(candidate);
    assert.equal(first.operation.method, method);
    assert.equal(first.operation.source.target, candidate.source.target);
    assert.equal(first.duplicate, false);
  }
});

test("approved execution can outlive its caller run and never blocks that run's own terminal transition", (t) => {
  const f = fixture(t),
    alreadyEnded = f.run();
  f.store.transitionRun(alreadyEnded.runId, alreadyEnded.revision, "failed");
  const after = f.store.startMaintenanceOperation(
    input({ originRunId: alreadyEnded.runId }),
  );
  assert.equal(after.operation.originRunId, alreadyEnded.runId);
  assert.equal(after.operation.status, "running");
  const active = f.run();
  const pending = f.store.startMaintenanceOperation(
    input({ originRunId: active.runId }),
  );
  const ended = f.store.transitionRun(active.runId, active.revision, "failed");
  assert.equal(ended.status, "failed");
  assert.equal(
    f.store.getOperation(pending.operation.operationId).status,
    "running",
  );
  const foreign = f.run(other),
    bad = input({ originRunId: foreign.runId });
  assert.throws(() => f.store.startMaintenanceOperation(bad), {
    code: "maintenance_execution_conflict",
  });
  assert.equal(f.store.getMaintenanceOperation(bad.requestId), null);
  const absent = input({ originRunId: newId("run") });
  assert.throws(() => f.store.startMaintenanceOperation(absent), {
    code: "run_not_found",
  });
  assert.equal(f.store.getMaintenanceOperation(absent.requestId), null);
});

test("the unique approval identity cannot be rebound to another caller, revision, action, target or origin", (t) => {
  const f = fixture(t),
    run = f.run(),
    candidate = input({ originRunId: run.runId });
  const original = f.store.startMaintenanceOperation(candidate).operation;
  const revision = digest({ changed: true });
  for (const changed of [
    { ...candidate, callerKey: other },
    {
      ...candidate,
      approvedRevision: revision,
      source: { ...candidate.source, candidateRevision: revision },
    },
    { ...candidate, method: "packages.update" },
    { ...candidate, source: { ...candidate.source, name: "another" } },
    { ...candidate, originRunId: null },
  ])
    assert.throws(() => f.store.startMaintenanceOperation(changed), {
      code: "maintenance_execution_conflict",
    });
  assert.deepEqual(
    f.store.getMaintenanceOperation(candidate.requestId),
    original,
  );
});

test("terminal and interrupted execution facts are returned as duplicates across boots without replay", (t) => {
  const f = fixture(t),
    success = input(),
    failure = input(),
    pending = input();
  const a = f.store.startMaintenanceOperation(success).operation,
    b = f.store.startMaintenanceOperation(failure).operation,
    c = f.store.startMaintenanceOperation(pending).operation;
  const done = f.store.finishOperation(
    a.operationId,
    "succeeded",
    undefined,
    1500,
  );
  const failed = f.store.finishOperation(
    b.operationId,
    "failed",
    { code: "apply_failed", message: "Actual effect failed." },
    1600,
  );
  assert.deepEqual(f.store.startMaintenanceOperation(success).operation, done);
  assert.deepEqual(
    f.store.startMaintenanceOperation(failure).operation,
    failed,
  );
  const oldBoot = f.store.bootId;
  f.restart();
  assert.notEqual(f.store.bootId, oldBoot);
  const interrupted = f.store.getMaintenanceOperation(pending.requestId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.bootId, oldBoot);
  for (const candidate of [success, failure, pending]) {
    const repeated = f.store.startMaintenanceOperation(candidate);
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.operation.bootId, oldBoot);
  }
  assert.equal(
    f.store.getMaintenanceOperation(pending.requestId).operationId,
    c.operationId,
  );
  assert.throws(() => f.store.finishOperation(c.operationId, "succeeded"), {
    code: "operation_state_conflict",
  });
  const next = f.store.startMaintenanceOperation(input());
  assert.equal(next.duplicate, false);
  assert.equal(next.operation.bootId, f.store.bootId);
});

test("invalid approval metadata, secrets and unsafe detail paths create no execution", (t) => {
  const f = fixture(t);
  for (const patch of [
    { requestId: "../escape" },
    { approvedRevision: "not-a-revision" },
    { method: "packages.execute" },
    { detailRef: "/tmp/public.json" },
    { detailRef: "state/maintenance/../execution.json" },
    { callerKey: "" },
    { originRunId: "pretend-run" },
  ])
    assert.throws(() => f.store.startMaintenanceOperation(input(patch)), {
      code: "invalid_maintenance_operation",
    });
  for (const alter of [
    (source) => ({ ...source, config: { token: "synthetic-secret" } }),
    (source) => ({ ...source, target: "api" }),
    (source) => ({ ...source, candidateRevision: digest("other") }),
    (source) => ({ ...source, origin: { ...origin, type: "extension" } }),
  ]) {
    const candidate = input();
    candidate.source = alter(candidate.source);
    assert.throws(() => f.store.startMaintenanceOperation(candidate), {
      code: "invalid_maintenance_operation",
    });
    assert.equal(f.store.getMaintenanceOperation(candidate.requestId), null);
  }
});

test("a real SQLite admission failure leaves no memory-only accepted execution or duplicate fact", (t) => {
  const f = fixture(t),
    candidate = input();
  f.inject(
    "CREATE TRIGGER fail_maintenance BEFORE INSERT ON operations WHEN NEW.maintenance_request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture admission failure'); END;",
  );
  assert.throws(() => f.store.startMaintenanceOperation(candidate), {
    code: "storage_error",
  });
  assert.equal(f.store.getMaintenanceOperation(candidate.requestId), null);
  f.inject("DROP TRIGGER fail_maintenance;");
  const first = f.store.startMaintenanceOperation(candidate);
  assert.equal(first.duplicate, false);
  f.store.close();
  assert.throws(() => f.store.startMaintenanceOperation(input()), {
    code: "storage_closed",
  });
  assert.throws(
    () => f.store.getMaintenanceOperation(candidate.requestId),
    /not open/i,
  );
});
