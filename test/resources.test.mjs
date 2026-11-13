import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
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
  const authorize = () => {
    if (!allowed)
      throw Object.assign(new Error("forbidden"), { code: "forbidden" });
  };
  const instance = manager.instance(origin, {
    signal: instanceSignal.signal,
    authorize,
    assertActive: () => {},
  });
  const controllers = [];
  function run() {
    const work = store.openWork({
      callerKey: "caller",
      pwd: path.join(root, "work"),
      snapshotRef: "work/test",
    });
    let row = store.acceptRun({
      callerKey: "caller",
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
