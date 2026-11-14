import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const dist = new URL(
  process.env.NEXUM_RETENTION_DIST ?? "../dist/",
  import.meta.url,
);
const [{ ProfileRetention }, { ArtifactStore }, { SqliteStore }] =
  await Promise.all(
    ["runtime/retention.js", "results/artifacts.js", "storage/sqlite.js"].map(
      (file) => import(new URL(file, dist)),
    ),
  );
const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
const day = 86400000;
const code = (expected) => (value) => value?.code === expected;

async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-retention-")),
  );
  const work = path.join(root, "work");
  mkdirSync(work);
  let now = 1800000000000,
    retention;
  const store = new SqliteStore(root, binding),
    errors = [],
    pinned = new Set();
  const artifacts = new ArtifactStore(root, "agent", {
    now: () => now,
    retentionMs: 1000,
    retentionUntil: (id, originRunId) =>
      store.taskArtifactRetentionUntil(id, originRunId, now),
    reserve: (bytes) => retention.reserve(bytes),
  });
  const port = {
    root,
    binding,
    cleanupBatch: (input) => store.cleanupBatch(input),
    activeRunIds: () => store.activeRunIds(),
    completeInputsCleanup: (runId, time) =>
      store.completeInputsCleanup(runId, time),
    protectedArtifactIds: (time) =>
      new Set([...store.protectedArtifactIds(time), ...pinned]),
    taskArtifactRetentionUntil: (id, originRunId, time) =>
      store.taskArtifactRetentionUntil(id, originRunId, time),
  };
  const make = (extra) =>
    new ProfileRetention(port, artifacts, {
      now: () => now,
      controlHeadroomBytes: 0,
      onError: (cause) => errors.push(cause),
      ...extra,
    });
  retention = make(options);
  if (options.quotaExtra !== undefined) {
    const baseline = await retention.measure();
    await retention.stop();
    retention = make({
      ...options,
      maxManagedBytes: baseline.bytes + options.quotaExtra,
    });
  }
  t.after(async () => {
    await retention.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const scope = (runId) => ({
    pwd: work,
    ownerKey: "owner",
    ...(runId ? { runId } : {}),
    assertCurrent() {},
    authorize() {},
  });
  return {
    root,
    work,
    store,
    artifacts,
    port,
    pinned,
    errors,
    scope,
    get retention() {
      return retention;
    },
    advance(ms) {
      now += ms;
    },
    now: () => now,
    artifact(data = "fixed", runId) {
      return artifacts.register(
        { data: Buffer.from(data), name: "file.txt", mimeType: "text/plain" },
        scope(runId),
      );
    },
    run() {
      const context = store.openWork(
        { callerKey: "owner", pwd: work, snapshotRef: "work/snapshot.json" },
        now,
      );
      return store.acceptRun(
        {
          callerKey: "owner",
          contextId: context.contextId,
          sourceKind: "inline",
          source: {},
        },
        now,
      ).run;
    },
    end(run) {
      const current = store.getRun(run.runId);
      return store.transitionRun(
        run.runId,
        current.revision,
        "failed",
        {},
        now,
      );
    },
    file(relative, content = "bytes") {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
  };
}

test("construction is cold; open and stop are explicit and stopped services reject new work", async (t) => {
  const root = path.join(
    tmpdir(),
    `nexum-retention-absent-${process.pid}-${Date.now()}`,
  );
  const store = {
    root,
    binding,
    cleanupBatch() {
      throw Error("cold construction must not touch store");
    },
    activeRunIds() {
      return new Set();
    },
    completeInputsCleanup() {
      throw Error("cold construction must not clean inputs");
    },
    protectedArtifactIds() {
      return new Set();
    },
    taskArtifactRetentionUntil() {
      return 0;
    },
  };
  const retention = new ProfileRetention(store, {
    root,
    directory: path.join(root, "work", "resources"),
    activeSnapshot() {
      return { resourceIds: new Set(), pendingPaths: new Set() };
    },
  });
  assert.equal(existsSync(root), false);
  await assert.rejects(retention.open(), (value) => value.code === "ENOENT");
  await retention.stop();
  await assert.rejects(retention.reserve(1), code("retention_closed"));
  assert.throws(() => retention.sweep(), code("retention_closed"));
  assert.equal(existsSync(root), false);
});

test("actual managed measurement excludes dependencies, raw work files and projects, deduplicates hard links and never follows symbolic links", async (t) => {
  const f = await fixture(t),
    baseline = await f.retention.measure();
  f.file("work/node_modules/large.bin", Buffer.alloc(200000));
  f.file("work/arbitrary-native-file.bin", Buffer.alloc(300000));
  const project = f.file("project/source.bin", Buffer.alloc(400000));
  const data = f.file("work/data/persistent.bin", Buffer.alloc(37));
  linkSync(data, path.join(f.root, "work", "data", "same-inode.bin"));
  symlinkSync(project, path.join(f.root, "work", "data", "project-link"));
  const usage = await f.retention.measure();
  assert.equal(usage.complete, true);
  assert.equal(usage.bytes - baseline.bytes, 37);
  assert.equal(usage.files - baseline.files, 1);
  assert.equal(usage.symlinks, 1);
  assert.equal(readFileSync(project).length, 400000);
});

test("persistent local scripts, skills and Core work Git data are measured without counting external home skills", async (t) => {
  const f = await fixture(t),
    baseline = await f.retention.measure();
  const persistent = [
    f.file("work/scripts/local.js", Buffer.alloc(11)),
    f.file("work/skills/local/SKILL.md", Buffer.alloc(17)),
    f.file("work/.git/objects/retained", Buffer.alloc(23)),
  ];
  const external = f.file(
    "external-home/skills/external/SKILL.md",
    Buffer.alloc(29000),
  );
  symlinkSync(path.dirname(external), path.join(f.work, "skills", "external"));
  const usage = await f.retention.measure();
  assert.equal(usage.complete, true);
  assert.equal(usage.bytes - baseline.bytes, 11 + 17 + 23);
  assert.equal(usage.files - baseline.files, 3);
  assert.equal(usage.symlinks, 1);
  f.advance(31 * day);
  await f.retention.sweep();
  for (const file of [...persistent, external])
    assert.equal(existsSync(file), true);
});

test("the real ArtifactStore reserves before registration, releases after actual I/O, and expires only fixed copied content", async (t) => {
  const f = await fixture(t),
    source = f.file("project/original.txt", "original");
  const resource = await f.artifacts.register({ path: source }, f.scope());
  assert.equal(f.retention.reservedBytes, 0);
  const content = path.join(
    f.artifacts.directory,
    resource.resourceId,
    "content",
    "data",
  );
  assert.equal(readFileSync(content, "utf8"), "original");
  writeFileSync(source, "changed source");
  f.advance(1001);
  const result = await f.retention.sweep();
  assert.equal(result.removedArtifacts, 1);
  assert.equal(existsSync(content), false);
  assert.equal(readFileSync(source, "utf8"), "changed source");
});

test("Task/transfer pin, active original run and an open native artifact stream protect expired files", async (t) => {
  const f = await fixture(t),
    run = f.run();
  const pinned = await f.artifact("pin"),
    origin = await f.artifact("origin", run.runId),
    borrowed = await f.artifact("borrowed");
  f.pinned.add(pinned.resourceId);
  const reading = await f.artifacts.open(borrowed.uri, f.scope());
  assert.ok(f.artifacts.activeSnapshot().resourceIds.has(borrowed.resourceId));
  f.advance(1001);
  const protectedResult = await f.retention.sweep();
  assert.equal(protectedResult.removedArtifacts, 0);
  for (const resource of [pinned, origin, borrowed])
    assert.equal(
      existsSync(path.join(f.artifacts.directory, resource.resourceId)),
      true,
    );
  reading.stream.destroy();
  await reading.closed;
  f.pinned.clear();
  f.end(run);
  // A native directory cursor wraps at EOF; a following sweep starts a new pass.
  await f.retention.sweep();
  await f.retention.sweep();
  for (const resource of [pinned, origin, borrowed])
    assert.equal(
      existsSync(path.join(f.artifacts.directory, resource.resourceId)),
      false,
    );
});

test("an actual in-flight artifact stage is protected and its pending reservation ends only after registration settles", async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const pending = f.artifacts.register(
    { data: Buffer.from("pending") },
    f.scope(),
    async () => {
      entered.resolve();
      await gate.promise;
      return {};
    },
  );
  await entered.promise;
  const active = f.artifacts.activeSnapshot();
  assert.equal(active.pendingPaths.size, 1);
  assert.ok(f.retention.reservedBytes > 0);
  const temporary = [...active.pendingPaths][0];
  f.advance(10000);
  await f.retention.sweep();
  assert.equal(existsSync(temporary), true);
  gate.resolve();
  const resource = await pending;
  assert.equal(f.retention.reservedBytes, 0);
  assert.equal(f.artifacts.activeSnapshot().pendingPaths.size, 0);
  assert.equal(
    existsSync(path.join(f.artifacts.directory, resource.resourceId)),
    true,
  );
});

test("each sweep processes at most 100 artifact entries and its native directory cursor reaches later entries", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 105; i++) {
    const id = `res_${i.toString(16).padStart(32, "0")}`;
    f.file(`work/resources/${id}/content/data`, "expired");
    f.file(
      `work/resources/${id}/resource.json`,
      JSON.stringify({
        schemaVersion: 1,
        resourceId: id,
        agentId: "agent",
        originRunId: null,
        expiresAt: new Date(f.now() - 1).toISOString(),
      }),
    );
  }
  const first = await f.retention.sweep();
  assert.equal(first.processed, 100);
  assert.equal(first.removedArtifacts, 100);
  const second = await f.retention.sweep();
  assert.equal(second.processed, 5);
  assert.equal(second.removedArtifacts, 5);
  assert.deepEqual(readdirSync(f.artifacts.directory), []);
});

test("reservation admission serializes concurrent writers, includes real bytes after release and never evicts fresh data", async (t) => {
  const f = await fixture(t, { quotaExtra: 1000 });
  const outcomes = await Promise.allSettled([
    f.retention.reserve(600),
    f.retention.reserve(600),
  ]);
  assert.equal(
    outcomes.filter((item) => item.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.find((item) => item.status === "rejected").reason.code,
    "storage_quota_exceeded",
  );
  const reservation = outcomes.find(
    (item) => item.status === "fulfilled",
  ).value;
  assert.equal(f.retention.reservedBytes, 600);
  f.file("work/data/persistent.bin", Buffer.alloc(600));
  reservation.release();
  reservation.release();
  assert.equal(f.retention.reservedBytes, 0);
  await assert.rejects(
    f.retention.reserve(500),
    code("storage_quota_exceeded"),
  );
  assert.equal(
    readFileSync(path.join(f.work, "data", "persistent.bin")).length,
    600,
  );
  const available = await f.retention.reserve(400);
  available.release();
});

test("real artifact quota refusal happens before staging and never leaves a reservation or partial artifact", async (t) => {
  const f = await fixture(t, { quotaExtra: 1000 });
  await assert.rejects(
    f.artifact("too large after metadata reservation"),
    code("storage_quota_exceeded"),
  );
  assert.equal(f.retention.reservedBytes, 0);
  assert.deepEqual(readdirSync(f.artifacts.directory), []);
});

test("space pressure first sweeps expired fixed data, without deleting unexpired artifacts or persistent files", async (t) => {
  const f = await fixture(t),
    old = await f.artifact("x".repeat(5000));
  f.advance(1001);
  const baseline = await f.retention.measure();
  await f.retention.stop();
  const boundedRetention = new ProfileRetention(f.port, f.artifacts, {
    now: f.now,
    controlHeadroomBytes: 0,
    maxManagedBytes: baseline.bytes + 100,
  });
  t.after(() => boundedRetention.stop());
  const reservation = await boundedRetention.reserve(4000);
  assert.equal(
    existsSync(path.join(f.artifacts.directory, old.resourceId)),
    false,
  );
  reservation.release();
});

test("business allocations preserve explicit control headroom, and control receipts cannot exceed the total profile quota", async (t) => {
  const f = await fixture(t),
    usage = await f.retention.measure();
  const limited = new ProfileRetention(f.port, f.artifacts, {
    now: f.now,
    maxManagedBytes: usage.bytes + 1024,
    controlHeadroomBytes: 512,
  });
  t.after(() => limited.stop());
  const ordinary = await limited.reserve(512);
  await assert.rejects(limited.reserve(1), code("storage_quota_exceeded"));
  const control = await limited.reserve(500, { control: true });
  await assert.rejects(
    limited.reserve(13, { control: true }),
    code("storage_quota_exceeded"),
  );
  ordinary.release();
  control.release();
  assert.equal(limited.reservedBytes, 0);
});

test("private npm planner records count while its native node_modules remain outside the managed-data quota", async (t) => {
  const f = await fixture(t),
    before = await f.retention.measure();
  const plan = path.join(f.root, "state", "maintenance", "npm", "plan-example");
  mkdirSync(path.join(plan, "node_modules", "dependency"), { recursive: true });
  writeFileSync(
    path.join(plan, "node_modules", "dependency", "index.js"),
    "x".repeat(4096),
  );
  writeFileSync(path.join(plan, "package.json"), "x".repeat(17));
  writeFileSync(path.join(plan, "package-lock.json"), "x".repeat(23));
  const measured = await f.retention.measure();
  assert.equal(measured.bytes - before.bytes, 40);
});

test("fixed Store cleanup refs remove their own files and process completion marker but reject other paths", async (t) => {
  const f = await fixture(t),
    id = "a".repeat(32),
    task = "b".repeat(64);
  const run = `run_${id}`,
    process = `res_${id}`;
  const refs = [
    { kind: "run", ref: `work/tmp/runs/${run}` },
    { kind: "log", ref: `logs/runs/${run}/console.log` },
    { kind: "task", ref: `state/tasks/${task}/result_${id}.json` },
    { kind: "process_log", ref: `logs/processes/${process}.output` },
  ];
  f.file(`${refs[0].ref}/code.json`);
  for (const ref of refs.slice(1)) f.file(ref.ref);
  f.file(`${refs[3].ref}.complete`);
  const outside = f.file("project/preserve.txt", "keep");
  f.port.cleanupBatch = () => ({
    processed: 5,
    deleted: { fixtures: 5 },
    files: [...refs, { kind: "run", ref: "project" }],
  });
  const result = await f.retention.sweep();
  assert.equal(result.errors[0].code, "invalid_cleanup_reference");
  assert.ok(f.retention.lastError);
  assert.equal(f.errors.length, 1);
  for (const ref of refs)
    assert.equal(existsSync(path.join(f.root, ref.ref)), false);
  assert.equal(existsSync(path.join(f.root, refs[3].ref + ".complete")), false);
  assert.equal(readFileSync(outside, "utf8"), "keep");
});

test("a real ended run is cleaned through Store metadata and fixed file candidates only after its history expires", async (t) => {
  const f = await fixture(t),
    run = f.run();
  f.end(run);
  const directory = `work/tmp/runs/${run.runId}`,
    logs = `logs/runs/${run.runId}/console.log`;
  f.file(`${directory}/code.json`, "saved code");
  f.file(logs, "saved log");
  f.advance(7 * day + 1);
  await f.retention.sweep();
  assert.equal(existsSync(path.join(f.root, directory, "code.json")), true);
  f.advance(24 * day);
  await f.retention.sweep();
  assert.throws(() => f.store.getRun(run.runId), code("run_not_found"));
  assert.equal(existsSync(path.join(f.root, directory)), false);
  assert.equal(existsSync(path.join(f.root, logs)), false);
});

test("expired attachment cleanup continues in bounded pages and preserves input JSON and unknown files", async (t) => {
  const f = await fixture(t),
    run = f.run(),
    wait = "wait_" + "f".repeat(32);
  f.end(run);
  const inputRoot = `work/tmp/runs/${run.runId}/inputs`;
  const bins = [];
  for (let i = 0; i < 225; i++) {
    const relative = `${inputRoot}/${i < 110 ? "" : wait + "/"}input_${i.toString(16).padStart(32, "0")}.bin`;
    bins.push(f.file(relative, "temporary bytes"));
  }
  const kept = [
    f.file(`${inputRoot}/input.json`, "ordinary input"),
    f.file(`${inputRoot}/${wait}/input.json`, "continuation input"),
    f.file(`${inputRoot}/other.bin`, "unknown"),
    f.file(
      `${inputRoot}/unknown/input_${"0".repeat(32)}.bin`,
      "unknown directory",
    ),
  ];
  f.advance(day + 1);
  const first = await f.retention.sweep();
  assert.ok(first.processed <= 100);
  assert.ok(first.pendingInputDirectories > 0);
  assert.ok(bins.some((file) => existsSync(file)));
  assert.equal(
    f.store.getRun(run.runId).cleanup.temporaryInputsExpiredAt,
    undefined,
  );
  for (let i = 0; i < 6; i++) {
    const page = await f.retention.sweep();
    assert.ok(page.processed <= 100);
    if (page.pendingInputDirectories === 0) break;
  }
  assert.ok(bins.every((file) => !existsSync(file)));
  for (const file of kept) assert.equal(existsSync(file), true);
  assert.equal(
    typeof f.store.getRun(run.runId).cleanup.temporaryInputsExpiredAt,
    "number",
  );
});

test("stopping input cleanup leaves its Store completion unset so a new service can finish the same real files", async (t) => {
  const f = await fixture(t),
    run = f.run();
  f.end(run);
  const bins = [];
  for (let i = 0; i < 110; i++)
    bins.push(
      f.file(
        `work/tmp/runs/${run.runId}/inputs/input_${i.toString(16).padStart(32, "0")}.bin`,
        "bytes",
      ),
    );
  f.advance(day + 1);
  const first = await f.retention.sweep();
  assert.ok(first.pendingInputDirectories > 0);
  await f.retention.stop();
  assert.equal(f.retention.lastError.code, "retention_cleanup_incomplete");
  assert.equal(
    f.store.getRun(run.runId).cleanup.temporaryInputsExpiredAt,
    undefined,
  );
  const next = new ProfileRetention(f.port, f.artifacts, { now: f.now });
  t.after(() => next.stop());
  await next.sweep();
  await next.sweep();
  assert.ok(bins.every((file) => !existsSync(file)));
  assert.equal(
    typeof f.store.getRun(run.runId).cleanup.temporaryInputsExpiredAt,
    "number",
  );
});

test("symbolic artifact directories are not traversed or removed, and current documents remain untouched", async (t) => {
  const f = await fixture(t),
    id = "res_" + "c".repeat(32);
  const outside = f.file("project/keep.txt", "keep");
  symlinkSync(path.dirname(outside), path.join(f.artifacts.directory, id));
  const docs = f.file("work/docs/extensions/current/manual.md", "current docs");
  const result = await f.retention.sweep();
  assert.equal(result.errors[0].code, "storage_path_escape");
  assert.equal(readFileSync(outside, "utf8"), "keep");
  assert.equal(readFileSync(docs, "utf8"), "current docs");
});

test("missing artifact metadata can be removed only without a pin; malformed metadata is reported without guessing an expiry", async (t) => {
  const f = await fixture(t),
    missing = "res_" + "d".repeat(32),
    malformed = "res_" + "e".repeat(32);
  f.file(`work/resources/${missing}/content/data`, "orphaned bytes");
  f.file(`work/resources/${malformed}/resource.json`, "not JSON");
  f.pinned.add(missing);
  const first = await f.retention.sweep();
  assert.equal(existsSync(path.join(f.artifacts.directory, missing)), true);
  assert.equal(existsSync(path.join(f.artifacts.directory, malformed)), true);
  assert.equal(first.errors.length, 1);
  f.pinned.clear();
  await f.retention.sweep();
  await f.retention.sweep();
  assert.equal(existsSync(path.join(f.artifacts.directory, missing)), false);
  assert.equal(existsSync(path.join(f.artifacts.directory, malformed)), true);
});

test("an incomplete bounded usage walk is explicit and cannot authorize a storage reservation", async (t) => {
  const f = await fixture(t);
  let directory = path.join(f.work, "data");
  mkdirSync(directory);
  for (let i = 0; i < 130; i++) {
    directory = path.join(directory, "n");
    mkdirSync(directory);
  }
  writeFileSync(
    path.join(directory, "payload"),
    "must not become an understated complete scan",
  );
  const usage = await f.retention.measure();
  assert.equal(usage.complete, false);
  await assert.rejects(
    f.retention.reserve(1),
    code("storage_measurement_incomplete"),
  );
  assert.equal(f.retention.reservedBytes, 0);
});

test("sweeps are single flight; native periodic cleanup exposes failures and stop ends scheduling", async (t) => {
  const f = await fixture(t, { intervalMs: 5 });
  let calls = 0;
  f.port.cleanupBatch = () => {
    calls++;
    throw Error("synthetic store failure");
  };
  await f.retention.start();
  await delay(25);
  assert.ok(calls > 0);
  assert.ok(f.retention.lastError);
  assert.ok(f.errors.length > 0);
  await f.retention.stop();
  const before = calls;
  await delay(15);
  assert.equal(calls, before);
  const fresh = await fixture(t);
  const first = fresh.retention.sweep(),
    second = fresh.retention.sweep();
  assert.equal(first, second);
  await first;
});
