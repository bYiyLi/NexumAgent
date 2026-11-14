import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  setImmediate as tick,
  setTimeout as delay,
} from "node:timers/promises";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ResourceManager } from "../dist/extensions/resources.js";

const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
const origin = {
  type: "platform",
  owner: "nexum",
  namespace: "transfer",
  version: "1",
  revision: "one",
};
const scope = {
  callerKey: "caller",
  owner: {
    type: origin.type,
    owner: origin.owner,
    namespace: origin.namespace,
  },
};
const fileReceipt = (prepared, size) => ({
  path: prepared.transfer.metadata.target.path,
  name: path.basename(prepared.transfer.metadata.target.path),
  size,
  mimeType: "text/plain",
  sha256: "a".repeat(64),
  revision: "b".repeat(64),
});

function fixture(t, { rejectPending = false, rejectFinal = false } = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-transfer-store-")),
  );
  mkdirSync(path.join(root, "work"));
  let store = new SqliteStore(root, binding);
  if (rejectPending || rejectFinal) {
    store.close();
    const db = new DatabaseSync(path.join(root, "state/runtime.sqlite"));
    const condition = rejectPending
      ? "NEW.status='pending'"
      : "NEW.status IN ('succeeded','failed','cancelled','expired')";
    db.exec(`CREATE TRIGGER reject_transfer_write BEFORE UPDATE OF status ON transfers
      WHEN ${condition} BEGIN SELECT RAISE(ABORT,'injected transfer write failure'); END`);
    db.close();
    store = new SqliteStore(root, binding);
  }
  const manager = new ResourceManager(store, { cleanupTimeoutMs: 20 });
  const instanceController = new AbortController(),
    controls = [],
    runs = [];
  let allowed = true;
  const authorize = () => {
    if (!allowed)
      throw Object.assign(new Error("Denied"), { code: "forbidden" });
  };
  const instance = manager.instance(origin, {
    signal: instanceController.signal,
    assertActive: authorize,
    authorize,
  });
  const run = (callerKey = scope.callerKey) => {
    const work = store.openWork({
      callerKey,
      pwd: path.join(root, "work"),
      snapshotRef: "work/snapshot",
    });
    let row = store.acceptRun({
      callerKey,
      contextId: work.contextId,
      sourceKind: "inline",
      source: {},
    }).run;
    row = store.transitionRun(row.runId, row.revision, "preparing_inputs");
    row = store.transitionRun(row.runId, row.revision, "running");
    const controller = new AbortController();
    const current = {
      runId: row.runId,
      signal: controller.signal,
      authorize,
      assertActive: () => {
        controller.signal.throwIfAborted();
        authorize();
      },
    };
    const result = {
      row,
      controller,
      binding: current,
      resources: instance.bind(current),
    };
    runs.push(result);
    return result;
  };
  const prepare = async (
    owner = run(),
    ownerScope = scope,
    now = Date.now(),
    target,
  ) => {
    const closed = Promise.withResolvers();
    let stops = 0;
    const value = {
      closed: closed.promise,
      dispose() {
        stops++;
        closed.resolve();
      },
    };
    const ref = await owner.resources.register({ kind: "transfer", value });
    const transfer = store.createTransfer(
      ownerScope,
      {
        resourceId: ref.id,
        runId: owner.row.runId,
        direction: "upload",
        maxBytes: 4096,
        metadata: {
          target: target ?? { path: path.join(root, "work", ref.id + ".txt") },
        },
      },
      now,
    );
    const result = { owner, ref, transfer, closed, stops: () => stops };
    controls.push(result);
    return result;
  };
  const publish = (prepared, ownerScope = scope) => {
    let published;
    manager.commitHandoff(prepared.ref, (checked) => {
      published = store.publishTransferPending(
        prepared.transfer.transferId,
        ownerScope,
        {
          revision: prepared.transfer.revision,
          resourceRevision: checked.revision,
          claimDeadlineAt: Date.now() + 30000,
        },
      );
      return published.resource;
    });
    return published;
  };
  t.after(async () => {
    for (const item of controls) item.closed.resolve();
    await tick();
    for (const item of runs) item.controller.abort();
    instanceController.abort();
    await delay(30);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    manager,
    instance,
    run,
    prepare,
    publish,
    revoke: () => {
      allowed = false;
    },
  };
}

test("pending publication and resource handoff commit together before detaching creator cancellation", async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  let commits = 0;
  const commit = (checked) => {
    commits++;
    return f.store.publishTransferPending(prepared.transfer.transferId, scope, {
      revision: prepared.transfer.revision,
      resourceRevision: checked.revision,
      claimDeadlineAt: Date.now() + 30000,
    }).resource;
  };
  const result = f.manager.commitHandoff(prepared.ref, commit);
  assert.equal(
    f.store.getTransfer(prepared.transfer.transferId, scope).status,
    "pending",
  );
  assert.equal(result.lifetime, "background");
  assert.equal(result.ownerRunId, null);
  assert.equal(
    f.manager.commitHandoff(prepared.ref, commit).resourceId,
    prepared.ref.id,
  );
  assert.equal(commits, 1);
  prepared.owner.controller.abort();
  await tick();
  assert.equal(prepared.stops(), 0);
  assert.equal(prepared.ref.signal.aborted, false);
  assert.deepEqual(await f.manager.cleanupRun(prepared.owner.row.runId), {
    closed: 0,
    unconfirmed: [],
  });
  assert.throws(() => f.manager.commitHandoff(prepared.ref, commit));
  assert.equal(commits, 1);
});

test("preparing identity may precede confirmed target but pending preserves its budget and claim sets the real start time", async (t) => {
  const f = fixture(t),
    creator = f.run();
  const prepared = await f.prepare(creator, scope, Date.now(), {});
  assert.deepEqual(prepared.transfer.metadata.target, {});
  assert.equal(prepared.transfer.metadata.maxBytes, 4096);
  assert.equal(prepared.transfer.metadata.startedAt, null);
  assert.throws(() => f.publish(prepared), {
    code: "invalid_transfer_metadata",
  });
  const target = { path: path.join(f.root, "work", "canonical.txt") };
  const publish = (metadata) =>
    f.manager.commitHandoff(
      prepared.ref,
      (resource) =>
        f.store.publishTransferPending(prepared.transfer.transferId, scope, {
          revision: prepared.transfer.revision,
          resourceRevision: resource.revision,
          claimDeadlineAt: Date.now() + 30000,
          metadata,
        }).resource,
    );
  assert.throws(() => publish({ target, maxBytes: 8192 }), {
    code: "invalid_transfer_metadata",
  });
  assert.throws(() => publish({ target, startedAt: 123 }), {
    code: "invalid_transfer_metadata",
  });
  publish({ target });
  let row = f.store.getTransfer(prepared.transfer.transferId, scope);
  assert.deepEqual(row.metadata.target, target);
  assert.equal(row.metadata.maxBytes, 4096);
  assert.deepEqual(row.metadata.origin, prepared.transfer.metadata.origin);
  const startedAt = Date.now();
  row = f.store.claimTransfer(
    row.transferId,
    scope,
    { revision: row.revision, transferDeadlineAt: startedAt + 30000 },
    startedAt,
  );
  assert.equal(row.metadata.startedAt, startedAt);
  assert.throws(
    () =>
      f.store.progressTransfer(row.transferId, scope, {
        revision: row.revision,
        bytesTransferred: 4097,
      }),
    { code: "resource_exhausted" },
  );
  prepared.closed.resolve();
  await tick();
  row = f.store.finishTransfer(row.transferId, scope, {
    revision: row.revision,
    status: "failed",
    cleanupConfirmed: true,
  });
  assert.equal(row.metadata.maxBytes, 4096);
  assert.equal(row.metadata.startedAt, startedAt);
});

test("a failing pending update rolls back handoff and preserves creator cleanup attachment", async (t) => {
  const f = fixture(t, { rejectPending: true }),
    prepared = await f.prepare();
  const before = f.store.getResource(prepared.ref.id);
  assert.throws(() => f.publish(prepared), { code: "storage_error" });
  const after = f.store.getResource(prepared.ref.id);
  assert.equal(after.lifetime, "run");
  assert.equal(after.ownerRunId, prepared.owner.row.runId);
  assert.equal(after.revision, before.revision);
  assert.equal(
    f.store.getTransfer(prepared.transfer.transferId, scope).status,
    "preparing",
  );
  prepared.owner.controller.abort();
  await f.manager.waitForRunClosure(prepared.owner.row.runId);
  assert.equal(prepared.stops(), 1);
  assert.equal(prepared.ref.signal.aborted, true);
});

test("a Core handoff repeat after natural closure still checks the creator's current authority", async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  f.publish(prepared);
  prepared.closed.resolve();
  await tick();
  let commits = 0;
  const repeat = () =>
    f.manager.commitHandoff(prepared.ref, () => {
      commits++;
      throw new Error("must-not-repeat-domain-commit");
    });
  assert.equal(repeat().lifetime, "background");
  f.revoke();
  assert.throws(repeat, { code: "forbidden" });
  assert.equal(commits, 0);
});

test("Core commit rejects fake references and uncommitted rows without losing the old signal", async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  let getters = 0,
    commits = 0;
  const fake = {
    get id() {
      getters++;
      return prepared.ref.id;
    },
  };
  assert.throws(
    () =>
      f.manager.commitHandoff(fake, () => {
        commits++;
      }),
    { code: "invalid_resource_commit" },
  );
  assert.equal(getters, 0);
  assert.equal(commits, 0);
  assert.throws(() => f.manager.commitHandoff(prepared.ref, async () => {}), {
    code: "invalid_resource_commit",
  });
  assert.throws(
    () =>
      f.manager.commitHandoff(prepared.ref, (row) => ({
        ...row,
        lifetime: "background",
        ownerRunId: null,
        handedOffAt: Date.now(),
        revision: row.revision + 1,
      })),
    { code: "resource_commit_unconfirmed" },
  );
  prepared.owner.controller.abort();
  await f.manager.waitForRunClosure(prepared.owner.row.runId);
  assert.equal(prepared.stops(), 1);
});

test("ordinary resource handoff cannot publish a preparing Core transfer or borrow another source", async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  await assert.rejects(
    () => prepared.owner.resources.handoff(prepared.ref.id),
    { code: "transfer_handoff_required" },
  );
  const external = f.manager.instance(
    {
      ...origin,
      type: "extension",
      owner: "@test/external",
      namespace: "external",
    },
    {
      signal: new AbortController().signal,
      assertActive() {},
      authorize() {},
    },
  );
  await assert.rejects(
    () => external.bind(prepared.owner.binding).handoff(prepared.ref.id),
    { code: "resource_owner_mismatch" },
  );
  assert.equal(
    f.store.getTransfer(prepared.transfer.transferId, scope).status,
    "preparing",
  );
  assert.equal(
    f.store.getResource(prepared.ref.id).ownerRunId,
    prepared.owner.row.runId,
  );
  f.revoke();
  assert.throws(() => f.publish(prepared), { code: "forbidden" });
});

test("the existing 32-background capacity rejects publication atomically without detaching the rejected resource", async (t) => {
  const f = fixture(t),
    creator = f.run(),
    prepared = [];
  for (let i = 0; i < 33; i++) prepared.push(await f.prepare(creator));
  for (const item of prepared.slice(0, 32)) f.publish(item);
  assert.throws(() => f.publish(prepared[32]), { code: "background_busy" });
  assert.equal(
    f.store.getTransfer(prepared[32].transfer.transferId, scope).status,
    "preparing",
  );
  assert.equal(f.store.getResource(prepared[32].ref.id).lifetime, "run");
  creator.controller.abort();
  await f.manager.waitForRunClosure(creator.row.runId);
  assert.equal(prepared[32].stops(), 1);
  assert(prepared.slice(0, 32).every((item) => item.stops() === 0));
});

test("independent streams claim once after creator terminal and retain committed files across unconfirmed cancellation", async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  let row = f.publish(prepared).transfer;
  const creator = f.store.getRun(prepared.owner.row.runId);
  f.store.transitionRun(creator.runId, creator.revision, "succeeded");
  row = f.store.claimTransfer(row.transferId, scope, {
    revision: row.revision,
    transferDeadlineAt: Date.now() + 30000,
  });
  assert.throws(
    () =>
      f.store.claimTransfer(row.transferId, scope, {
        revision: row.revision,
        transferDeadlineAt: Date.now() + 30000,
      }),
    { code: "transfer_not_claimable" },
  );
  const resultRef = path.join(f.root, "work", "committed.txt");
  const file = fileReceipt(prepared, 7);
  row = f.store.progressTransfer(row.transferId, scope, {
    revision: row.revision,
    bytesTransferred: 7,
    fileCommitted: true,
    file,
    resultRef,
  });
  assert.equal(row.metadata.fileCommitted, true);
  assert.deepEqual(row.metadata.file, file);
  const stopped = f.store.requestTransferCancel(row.transferId, scope, {
    revision: row.revision,
    reason: { kind: "cancel", code: "transfer_cancelled" },
  });
  assert.equal(stopped.accepted, true);
  row = stopped.transfer;
  const repeat = f.store.requestTransferCancel(row.transferId, scope, {
    revision: row.revision,
    reason: { kind: "timeout", code: "transfer_timeout" },
  });
  assert.equal(repeat.transfer.metadata.stop.kind, "cancel");
  assert.equal(repeat.accepted, false);
  assert.equal(repeat.transfer.revision, row.revision);
  row = f.store.finishTransfer(row.transferId, scope, {
    revision: row.revision,
    status: "cancelled",
    cleanupConfirmed: false,
  });
  assert.equal(row.status, "cancelling");
  assert.equal(row.endedAt, null);
  assert.equal(row.metadata.fileCommitted, true);
  assert.deepEqual(row.metadata.file, file);
  assert.equal(row.resultRef, resultRef);
  prepared.closed.resolve();
  await tick();
  row = f.store.finishTransfer(row.transferId, scope, {
    revision: row.revision,
    status: "cancelled",
    cleanupConfirmed: true,
  });
  assert.equal(row.status, "cancelled");
  assert.notEqual(row.endedAt, null);
  assert.equal(row.metadata.fileCommitted, true);
  assert.deepEqual(row.metadata.file, file);
  assert.equal(
    f.store.requestTransferCancel(row.transferId, scope, {
      revision: row.revision,
      reason: { kind: "cancel", code: "transfer_cancelled" },
    }).accepted,
    false,
  );
  assert.throws(
    () =>
      f.store.progressTransfer(row.transferId, scope, {
        revision: row.revision,
        bytesTransferred: 0,
      }),
    { code: "transfer_state_conflict" },
  );
});

test("success requires a real claim and immutable upload publication facts while a committed cancellation race may succeed", async (t) => {
  const f = fixture(t),
    unclaimed = await f.prepare();
  let row = f.publish(unclaimed).transfer;
  assert.throws(
    () =>
      f.store.progressTransfer(row.transferId, scope, {
        revision: row.revision,
        bytesTransferred: 1,
      }),
    { code: "transfer_state_conflict" },
  );
  row = f.store.requestTransferCancel(row.transferId, scope, {
    revision: row.revision,
    reason: { kind: "cancel", code: "transfer_cancelled" },
  }).transfer;
  unclaimed.closed.resolve();
  await tick();
  assert.throws(
    () =>
      f.store.finishTransfer(row.transferId, scope, {
        revision: row.revision,
        status: "succeeded",
        cleanupConfirmed: true,
      }),
    { code: "invalid_transfer_outcome" },
  );
  const prepared = await f.prepare();
  row = f.publish(prepared).transfer;
  row = f.store.claimTransfer(row.transferId, scope, {
    revision: row.revision,
    transferDeadlineAt: Date.now() + 30000,
  });
  assert.throws(
    () =>
      f.store.finishTransfer(row.transferId, scope, {
        revision: row.revision,
        status: "succeeded",
        cleanupConfirmed: true,
      }),
    { code: "invalid_transfer_outcome" },
  );
  const file = fileReceipt(prepared, 2);
  assert.throws(
    () =>
      f.store.progressTransfer(row.transferId, scope, {
        revision: row.revision,
        bytesTransferred: 1,
        fileCommitted: true,
        file,
      }),
    { code: "invalid_transfer_file" },
  );
  row = f.store.progressTransfer(row.transferId, scope, {
    revision: row.revision,
    bytesTransferred: 2,
    fileCommitted: true,
    file,
  });
  assert.throws(
    () =>
      f.store.progressTransfer(row.transferId, scope, {
        revision: row.revision,
        bytesTransferred: 2,
        fileCommitted: true,
        file: { ...file, sha256: "c".repeat(64) },
      }),
    { code: "transfer_state_conflict" },
  );
  row = f.store.requestTransferCancel(row.transferId, scope, {
    revision: row.revision,
    reason: { kind: "cancel", code: "transfer_cancelled" },
  }).transfer;
  prepared.closed.resolve();
  await tick();
  row = f.store.finishTransfer(row.transferId, scope, {
    revision: row.revision,
    status: "succeeded",
    cleanupConfirmed: true,
  });
  assert.equal(row.status, "succeeded");
  assert.deepEqual(row.metadata.file, file);
});

test("download success requires its complete byte count but no upload file receipt", async (t) => {
  const f = fixture(t),
    creator = f.run(),
    closed = Promise.withResolvers();
  const ref = await creator.resources.register({
    kind: "transfer",
    value: {
      closed: closed.promise,
      dispose() {
        closed.resolve();
      },
    },
  });
  let row = f.store.createTransfer(scope, {
    resourceId: ref.id,
    runId: creator.row.runId,
    direction: "download",
    maxBytes: 4096,
    metadata: {
      target: {
        resourceUri: "nexum://agents/agent/resources/res_" + "d".repeat(32),
        size: 3,
        sha256: "a".repeat(64),
      },
    },
  });
  row = f.publish({ ref, transfer: row }).transfer;
  row = f.store.claimTransfer(row.transferId, scope, {
    revision: row.revision,
    transferDeadlineAt: Date.now() + 30000,
  });
  row = f.store.progressTransfer(row.transferId, scope, {
    revision: row.revision,
    bytesTransferred: 2,
  });
  closed.resolve();
  await tick();
  assert.throws(
    () =>
      f.store.finishTransfer(row.transferId, scope, {
        revision: row.revision,
        status: "succeeded",
        cleanupConfirmed: true,
      }),
    { code: "invalid_transfer_outcome" },
  );
  row = f.store.progressTransfer(row.transferId, scope, {
    revision: row.revision,
    bytesTransferred: 3,
  });
  row = f.store.finishTransfer(row.transferId, scope, {
    revision: row.revision,
    status: "succeeded",
    cleanupConfirmed: true,
  });
  assert.equal(row.status, "succeeded");
  assert.equal(row.metadata.file, undefined);
});

test("a linked upload without a confirmed final receipt retains its committed fact but cannot succeed", async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  let row = f.publish(prepared).transfer;
  row = f.store.claimTransfer(row.transferId, scope, {
    revision: row.revision,
    transferDeadlineAt: Date.now() + 30000,
  });
  row = f.store.progressTransfer(row.transferId, scope, {
    revision: row.revision,
    bytesTransferred: 3,
    fileCommitted: true,
  });
  assert.equal(row.metadata.fileCommitted, true);
  assert.equal(row.metadata.file, undefined);
  prepared.closed.resolve();
  await tick();
  assert.throws(
    () =>
      f.store.finishTransfer(row.transferId, scope, {
        revision: row.revision,
        status: "succeeded",
        cleanupConfirmed: true,
      }),
    { code: "invalid_transfer_outcome" },
  );
  row = f.store.finishTransfer(row.transferId, scope, {
    revision: row.revision,
    status: "failed",
    cleanupConfirmed: true,
    error: {
      code: "file_changed",
      message: "The committed target identity could not be confirmed.",
    },
  });
  assert.equal(row.status, "failed");
  assert.equal(row.metadata.fileCommitted, true);
  assert.equal(row.metadata.file, undefined);
});

test("a failing final write retains previously reported committed file facts without inventing a terminal receipt", async (t) => {
  const f = fixture(t, { rejectFinal: true }),
    prepared = await f.prepare();
  let row = f.publish(prepared).transfer;
  row = f.store.claimTransfer(row.transferId, scope, {
    revision: row.revision,
    transferDeadlineAt: Date.now() + 30000,
  });
  const file = fileReceipt(prepared, 3);
  row = f.store.progressTransfer(row.transferId, scope, {
    revision: row.revision,
    bytesTransferred: 3,
    fileCommitted: true,
    file,
  });
  prepared.closed.resolve();
  await tick();
  assert.throws(
    () =>
      f.store.finishTransfer(row.transferId, scope, {
        revision: row.revision,
        status: "succeeded",
        cleanupConfirmed: true,
      }),
    { code: "storage_error" },
  );
  const retained = f.store.getTransfer(row.transferId, scope);
  assert.equal(retained.status, "transferring");
  assert.equal(retained.endedAt, null);
  assert.equal(retained.revision, row.revision);
  assert.equal(retained.metadata.fileCommitted, true);
  assert.deepEqual(retained.metadata.file, file);
});

test("claim expiry requires actual elapsed time and still waits for real resource cleanup", async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  let row = f.publish(prepared).transfer;
  const reason = { kind: "expired", code: "transfer_expired" };
  assert.throws(
    () =>
      f.store.requestTransferCancel(row.transferId, scope, {
        revision: row.revision,
        reason,
      }),
    { code: "transfer_state_conflict" },
  );
  const after = row.claimDeadlineAt + 1;
  assert.throws(
    () =>
      f.store.claimTransfer(
        row.transferId,
        scope,
        {
          revision: row.revision,
          transferDeadlineAt: after + 30000,
        },
        after,
      ),
    { code: "transfer_not_claimable" },
  );
  row = f.store.requestTransferCancel(
    row.transferId,
    scope,
    { revision: row.revision, reason },
    after,
  ).transfer;
  row = f.store.finishTransfer(
    row.transferId,
    scope,
    { revision: row.revision, status: "expired", cleanupConfirmed: true },
    after,
  );
  assert.equal(row.status, "cancelling");
  assert.equal(row.endedAt, null);
  prepared.closed.resolve();
  await tick();
  row = f.store.finishTransfer(
    row.transferId,
    scope,
    { revision: row.revision, status: "expired", cleanupConfirmed: true },
    after,
  );
  assert.equal(row.status, "expired");
  assert.notEqual(row.endedAt, null);
});

test("history is bounded, stable and bound to caller/source/filter; request URLs never become target data", async (t) => {
  const f = fixture(t),
    own = f.run(),
    other = f.run("other"),
    now = Date.now();
  for (let i = 0; i < 5; i++) await f.prepare(own, scope, now);
  await f.prepare(other, { ...scope, callerKey: "other" }, now);
  const first = f.store.scanTransfers(scope, {}, 2);
  assert.equal(first.items.length, 2);
  assert.equal(first.more, true);
  assert.equal(
    Buffer.from(first.items[1].cursor, "base64url").includes(
      Buffer.from(first.items[1].record.transferId),
    ),
    false,
  );
  assert.throws(
    () =>
      f.store.scanTransfers(scope, {}, 2, first.items[1].cursor.slice(0, -5)),
    { code: "invalid_cursor" },
  );
  const second = f.store.scanTransfers(scope, {}, 2, first.items[1].cursor);
  const third = f.store.scanTransfers(scope, {}, 2, second.items[1].cursor);
  assert.equal(
    new Set(
      [...first.items, ...second.items, ...third.items].map(
        (item) => item.record.transferId,
      ),
    ).size,
    5,
  );
  assert.equal(third.more, false);
  assert.throws(
    () =>
      f.store.scanTransfers(
        { ...scope, callerKey: "other" },
        {},
        2,
        first.items[1].cursor,
      ),
    { code: "invalid_cursor" },
  );
  assert.throws(
    () =>
      f.store.scanTransfers(
        scope,
        { status: "pending" },
        2,
        first.items[1].cursor,
      ),
    { code: "invalid_cursor" },
  );
  assert.throws(
    () =>
      f.store.getTransfer(first.items[0].record.transferId, {
        ...scope,
        callerKey: "other",
      }),
    { code: "transfer_not_found" },
  );
  const value = await f.prepare();
  assert.throws(
    () =>
      f.store.createTransfer(scope, {
        resourceId: value.ref.id,
        runId: value.owner.row.runId,
        direction: "upload",
        maxBytes: 4096,
        metadata: {
          target: {
            path: path.join(f.root, "work", "x"),
            url: "https://example.invalid/?token=secret",
          },
        },
      }),
    { code: "invalid_transfer_metadata" },
  );
  assert.throws(
    () =>
      f.store.progressTransfer(value.transfer.transferId, scope, {
        revision: value.transfer.revision,
        bytesTransferred: 0,
        resultRef: "https://example.invalid/?token=secret",
      }),
    { code: "invalid_transfer_result" },
  );
});

test("Agent restart interrupts every pending transfer and never recreates its old live controller", (t) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-transfer-restart-")),
  );
  mkdirSync(path.join(root, "work"));
  let store = new SqliteStore(root, binding);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const work = store.openWork({
    callerKey: scope.callerKey,
    pwd: path.join(root, "work"),
    snapshotRef: "work/snapshot",
  });
  let run = store.acceptRun({
    callerKey: scope.callerKey,
    contextId: work.contextId,
    sourceKind: "inline",
    source: {},
  }).run;
  run = store.transitionRun(run.runId, run.revision, "preparing_inputs");
  run = store.transitionRun(run.runId, run.revision, "running");
  const resource = store.registerResource({
    callerKey: scope.callerKey,
    runId: run.runId,
    kind: "transfer",
    source: { ...origin, instanceId: "core-transfer" },
  });
  const row = store.createTransfer(scope, {
    resourceId: resource.resourceId,
    runId: run.runId,
    direction: "upload",
    maxBytes: 4096,
    metadata: { target: { path: path.join(root, "work", "target") } },
  });
  store.publishTransferPending(row.transferId, scope, {
    revision: row.revision,
    resourceRevision: resource.revision,
    claimDeadlineAt: Date.now() + 30000,
  });
  store.close();
  store = new SqliteStore(root, binding);
  const stopped = store.getTransfer(row.transferId, scope);
  assert.equal(stopped.status, "interrupted");
  assert.notEqual(stopped.endedAt, null);
  assert.equal(store.getResource(resource.resourceId).status, "unavailable");
  assert.throws(
    () =>
      store.claimTransfer(row.transferId, scope, {
        revision: stopped.revision,
        transferDeadlineAt: Date.now() + 30000,
      }),
    { code: "transfer_state_conflict" },
  );
});

test("transfer history retains actual creator identities after run removal and a new Project opens at the same directory", (t) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-transfer-origin-")),
  );
  const workPath = path.join(root, "work");
  mkdirSync(workPath);
  let store = new SqliteStore(root, binding);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = (projectId) => {
    const work = store.openWork({
      callerKey: scope.callerKey,
      projectId,
      pwd: workPath,
      snapshotRef: "work/snapshot",
    });
    let row = store.acceptRun({
      callerKey: scope.callerKey,
      contextId: work.contextId,
      sourceKind: "inline",
      source: {},
    }).run;
    row = store.transitionRun(row.runId, row.revision, "preparing_inputs");
    return store.transitionRun(row.runId, row.revision, "running");
  };
  const original = run("project-old");
  const originIds = { contextId: original.contextId, projectId: "project-old" };
  const prepare = (creator, maxBytes = 4096) => {
    const resource = store.registerResource({
      callerKey: scope.callerKey,
      runId: creator.runId,
      kind: "transfer",
      source: { ...origin, instanceId: "core-transfer" },
    });
    const metadata = {
      target: { path: path.join(workPath, "same-target.txt") },
    };
    const transfer = store.createTransfer(scope, {
      resourceId: resource.resourceId,
      runId: creator.runId,
      direction: "upload",
      maxBytes,
      metadata,
    });
    return { resource, transfer, metadata };
  };
  const first = prepare(original),
    legacy = prepare(original);
  assert.deepEqual(first.transfer.metadata.origin, originIds);
  assert.equal(first.transfer.metadata.maxBytes, 4096);
  assert.equal(first.transfer.metadata.startedAt, null);
  assert.throws(
    () =>
      store.createTransfer(scope, {
        resourceId: first.resource.resourceId,
        runId: original.runId,
        direction: "upload",
        maxBytes: 4096,
        metadata: {
          ...first.metadata,
          origin: { contextId: "invented", projectId: "invented" },
        },
      }),
    { code: "invalid_transfer" },
  );
  assert.throws(
    () =>
      store.publishTransferPending(first.transfer.transferId, scope, {
        revision: first.transfer.revision,
        resourceRevision: first.resource.revision,
        claimDeadlineAt: Date.now() + 30000,
        metadata: {
          ...first.metadata,
          origin: { contextId: "invented", projectId: "invented" },
        },
      }),
    { code: "invalid_transfer_origin" },
  );
  for (const item of [first, legacy])
    store.publishTransferPending(item.transfer.transferId, scope, {
      revision: item.transfer.revision,
      resourceRevision: item.resource.revision,
      claimDeadlineAt: Date.now() + 30000,
      metadata: item.metadata,
    });
  const pending = store.getTransfer(first.transfer.transferId, scope),
    claimTime = Date.now();
  const claimed = store.claimTransfer(
    pending.transferId,
    scope,
    { revision: pending.revision, transferDeadlineAt: claimTime + 30000 },
    claimTime,
  );
  assert.equal(claimed.metadata.startedAt, claimTime);
  store.close();
  const db = new DatabaseSync(path.join(root, "state/runtime.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "UPDATE transfers SET metadata_json=json_remove(metadata_json,'$.origin','$.maxBytes','$.startedAt') WHERE transfer_id=?",
  ).run(legacy.transfer.transferId);
  db.prepare("DELETE FROM runs WHERE run_id=?").run(original.runId);
  db.prepare("DELETE FROM work_contexts WHERE context_id=?").run(
    original.contextId,
  );
  db.close();
  store = new SqliteStore(root, binding);
  const replacement = run("project-new"),
    current = prepare(replacement, 8192);
  assert.notEqual(replacement.contextId, original.contextId);
  assert.deepEqual(current.transfer.metadata.origin, {
    contextId: replacement.contextId,
    projectId: "project-new",
  });
  const retained = store.getTransfer(first.transfer.transferId, scope);
  assert.equal(retained.originRunId, original.runId);
  assert.deepEqual(retained.metadata.origin, originIds);
  assert.equal(retained.metadata.maxBytes, 4096);
  assert.equal(retained.metadata.startedAt, claimTime);
  assert.equal(current.transfer.metadata.maxBytes, 8192);
  assert.equal(current.transfer.metadata.startedAt, null);
  assert.equal(
    store.getTransfer(legacy.transfer.transferId, scope).metadata.origin,
    null,
  );
  const records = store.scanTransfers(scope).items.map((item) => item.record);
  const unknown = records.find(
    (item) => item.transferId === legacy.transfer.transferId,
  );
  assert.equal(unknown.metadata.maxBytes, null);
  assert.equal(unknown.metadata.startedAt, null);
  assert.deepEqual(
    records.find((item) => item.transferId === first.transfer.transferId)
      .metadata.origin,
    originIds,
  );
  assert.equal(
    records.find((item) => item.transferId === legacy.transfer.transferId)
      .metadata.origin,
    null,
  );
});
