import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

const configured = process.env.NEXUM_STATE_PROCESS_QUOTA_DIST;
const dist = configured
  ? configured.startsWith("file:")
    ? new URL(configured)
    : pathToFileURL(configured + path.sep)
  : new URL("../dist/", import.meta.url);
const [
  { StateServices },
  { SqliteStore },
  { ProcessOutputLog },
  { canonicalJson },
  { AgentError },
  { ProfileRetention },
  { ArtifactStore },
] = await Promise.all(
  [
    "services/state.js",
    "storage/sqlite.js",
    "process/output-log.js",
    "contracts/json.js",
    "contracts/errors.js",
    "runtime/retention.js",
    "results/artifacts.js",
  ].map((file) => import(new URL(file, dist))),
);

const processId = "res_" + "a".repeat(32);
function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-state-process-quota-")),
  );
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const logs = [];
  t.after(async () => {
    for (const log of logs) await log.close().catch(() => {});
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let allowed = true;
  const scope = {
    context: {
      agentId: "agent",
      caller: { principalId: "user", clientId: "client", grantId: "grant" },
    },
    signal: new AbortController().signal,
    assertCurrent() {
      if (!allowed)
        throw new AgentError("forbidden", "Current authority denied.");
    },
    authorize() {
      if (!allowed)
        throw new AgentError("forbidden", "Current authority denied.");
    },
  };
  return {
    root,
    store,
    scope,
    revoke: () => (allowed = false),
    log(options = {}) {
      const log = new ProcessOutputLog(root, processId, options);
      logs.push(log);
      return log;
    },
  };
}

test("local state reserves its actual serialized bytes before SQLite and refusal makes no mutation", async (t) => {
  const f = fixture(t),
    value = { text: "中文\ud800", count: 2 },
    requests = [];
  let full = true,
    released = 0;
  const service = new StateServices(f.store, undefined, {
    async reserve(bytes) {
      requests.push(bytes);
      if (full)
        throw new AgentError(
          "storage_quota_exceeded",
          "Managed storage is full.",
        );
      return {
        release() {
          released++;
        },
      };
    },
  }).bind(f.scope);
  await assert.rejects(
    service.agent.set("key", value, { expectedVersion: null }),
    { code: "storage_quota_exceeded" },
  );
  assert.equal(f.store.getState("key"), null);
  assert.equal(released, 0);
  assert.equal(
    requests[0],
    Buffer.byteLength(canonicalJson(value)) + Buffer.byteLength("key") + 1024,
  );
  full = false;
  const changed = await service.agent.set("key", value, {
    expectedVersion: null,
  });
  assert.equal(changed.version, 1);
  assert.deepEqual(changed.value, value);
  assert.equal(released, 1);
  await assert.rejects(
    service.agent.set("key", "stale", { expectedVersion: null }),
    { code: "state_version_conflict" },
  );
  assert.equal(released, 2);
  assert.deepEqual(f.store.getState("key").value, value);
  full = true;
  assert.deepEqual((await service.agent.get("key")).value, value);
  assert.equal(
    (await service.agent.delete("key", { expectedVersion: 1 })).deleted,
    true,
  );
  assert.equal(
    requests.length,
    3,
    "read and deletion remain available without new business space",
  );
});

test("local state rechecks current authority after waiting admission and always releases the ticket", async (t) => {
  const f = fixture(t),
    entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let released = 0;
  const service = new StateServices(f.store, undefined, {
    async reserve() {
      entered.resolve();
      await resume.promise;
      return {
        release() {
          released++;
        },
      };
    },
  }).bind(f.scope);
  const pending = service.agent.set("key", 7, { expectedVersion: null });
  await entered.promise;
  f.revoke();
  resume.resolve();
  await assert.rejects(pending, { code: "forbidden" });
  assert.equal(released, 1);
  assert.equal(f.store.getState("key"), null);
});

test("real profile space exhaustion rejects a local state write but does not block reads or CAS deletion", async (t) => {
  const f = fixture(t),
    retention = new ProfileRetention(
      f.store,
      new ArtifactStore(f.root, "agent"),
      { maxManagedBytes: 1024 },
    );
  t.after(() => retention.stop());
  f.store.setState("kept", { previous: true }, null);
  const service = new StateServices(f.store, undefined, {
    reserve: (bytes) => retention.reserve(bytes),
  }).bind(f.scope);
  assert.ok((await retention.measure()).bytes > retention.maxManagedBytes);
  await assert.rejects(service.agent.set("new", 7, { expectedVersion: null }), {
    code: "storage_quota_exceeded",
  });
  assert.equal(f.store.getState("new"), null);
  assert.deepEqual((await service.agent.get("kept")).value, { previous: true });
  assert.equal(
    (await service.agent.delete("kept", { expectedVersion: 1 })).deleted,
    true,
  );
  assert.equal(retention.reservedBytes, 0);
});

test("Cloud user state never consumes the local profile reservation", async (t) => {
  const f = fixture(t);
  let localRequests = 0;
  const service = new StateServices(
    f.store,
    {
      async set(identity, key, value) {
        assert.equal(identity.grantId, "grant");
        return { value, version: 1, updatedAt: Date.now() };
      },
    },
    {
      async reserve() {
        localRequests++;
        throw new Error("local full");
      },
    },
  ).bind(f.scope);
  assert.deepEqual(
    (await service.user.set("key", { value: 1 }, { expectedVersion: null }))
      .value,
    { value: 1 },
  );
  assert.equal(localRequests, 0);
  assert.equal(f.store.getState("key"), null);
});

test("process output refuses the complete bounded writer budget before creating logs or files", async (t) => {
  const f = fixture(t);
  let requested;
  const log = f.log({
    maxBytes: 2048,
    async reserve(bytes) {
      requested = bytes;
      throw new AgentError(
        "storage_quota_exceeded",
        "Managed storage is full.",
      );
    },
  });
  assert.equal(existsSync(path.join(f.root, "logs")), false);
  await assert.rejects(log.open(), { code: "storage_quota_exceeded" });
  assert.equal(requested, 2048 + 1024);
  assert.equal(existsSync(path.join(f.root, "logs")), false);
  assert.equal(log.outputComplete, false);
});

test("one admitted process ring drains and writes its completion marker without later business admissions", async (t) => {
  const f = fixture(t);
  let admitted = 0,
    released = 0,
    retained = 0;
  let log;
  log = f.log({
    maxBytes: 2048,
    async reserve(bytes) {
      assert.equal(++admitted, 1);
      retained = bytes;
      return {
        release() {
          released++;
          retained = 0;
          assert.ok(existsSync(`${log.path}.complete`));
          assert.ok(
            statSync(log.path).size + statSync(`${log.path}.complete`).size <=
              log.maxBytes,
          );
        },
      };
    },
  });
  await log.open();
  assert.equal(retained, 3072);
  for (let i = 0; i < 100; i++)
    await log.append("stdout", Buffer.from(`line-${i}\n`.repeat(8)));
  assert.equal(released, 0);
  assert.equal(admitted, 1);
  await log.finish();
  assert.equal(log.outputComplete, true);
  assert.equal(released, 1);
  assert.equal(retained, 0);
  const page = await log.read({ encoding: null, maxBytes: 1024 });
  assert.equal(page.truncated, true);
  await log.close();
  await log.close();
  assert.equal(released, 1);
  const historical = new ProcessOutputLog(f.root, processId, {
    async reserve() {
      throw new Error("history must not reserve");
    },
  });
  try {
    await historical.open({ readOnly: true });
    assert.equal(historical.outputComplete, true);
  } finally {
    await historical.close();
  }
});

test("an aborted pending process admission releases without publishing a writer; close releases unfinished writers", async (t) => {
  const f = fixture(t),
    entered = Promise.withResolvers(),
    resume = Promise.withResolvers(),
    controller = new AbortController();
  let released = 0;
  const log = f.log({
    async reserve() {
      entered.resolve();
      await resume.promise;
      return {
        release() {
          released++;
        },
      };
    },
  });
  const pending = log.open({ signal: controller.signal });
  await entered.promise;
  controller.abort(new Error("cancelled"));
  resume.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.equal(released, 1);
  assert.equal(existsSync(log.path), false);
  const other = new ProcessOutputLog(f.root, "res_" + "b".repeat(32), {
    async reserve() {
      return {
        release() {
          released++;
        },
      };
    },
  });
  await other.open();
  await other.append("stderr", Buffer.from("partial"));
  await other.close();
  assert.equal(other.outputComplete, false);
  assert.equal(released, 2);
});
