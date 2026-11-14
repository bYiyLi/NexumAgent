import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { DatabaseSync } from "node:sqlite";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { AgentError } from "../dist/contracts/errors.js";
import { canonicalJson, newRequestId } from "../dist/contracts/json.js";

const caller = { principalId: "user", clientId: "one", grantId: "grant-a" };
const otherHost = { ...caller, clientId: "two", grantId: "grant-b" };
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-history-")),
  );
  const work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), ' {"type":"module"}');
  const binding = {
    agentId: "a",
    profile: "development",
    cloudEnvironment: "test",
  };
  let store = new SqliteStore(root, binding),
    interruptedId;
  if (options.interrupted) {
    const previous = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "unused.json",
    });
    interruptedId = store.acceptRun({
      callerKey: callerKey(caller),
      contextId: previous.contextId,
      sourceKind: "inline",
      source: {},
    }).run.runId;
    store.close();
    store = new SqliteStore(root, binding);
  }
  const modules = await ModuleLoader.create(work, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const scripts = new ScriptCatalog(work, "a");
  let check = () => {};
  const denied = new Set(),
    calls = [],
    runIds = new Set();
  const engine = new RunEngine(store, modules, scripts, {
    authorize(who, target) {
      calls.push({ who, target });
      const result = check(who, target);
      if (result !== undefined) return result;
      if (target.run && denied.has(target.run.runId))
        throw new AgentError("forbidden", "Not currently authorized.");
    },
    loadWork: () => ({ project: null }),
    bindings: (s) => ({
      runtime: { requestInput: s.requestInput },
      ...options.bindings?.(s),
    }),
    encodeResult: async (value) => ({
      content: [],
      data: value === undefined ? null : JSON.parse(canonicalJson(value)),
    }),
  });
  const open = (who = caller, projectId) =>
    store.openWork({
      callerKey: callerKey(who),
      pwd: work,
      snapshotRef: "unused.json",
      ...(projectId ? { projectId } : {}),
    });
  const initial = open();
  const start = async (input, who = caller, context = initial) => {
    const result = await engine.start(who, {
      contextId: context.contextId,
      waitMs: 0,
      ...input,
    });
    runIds.add(result.run.runId);
    return result;
  };
  const finish = (id, who = caller) =>
    engine.get(who, { agentId: "a", runId: id, waitMs: 30000 });
  const execute = async (input, who = caller, context = initial) =>
    finish((await start(input, who, context)).run.runId, who);
  const accepted = (now = Date.now(), who = caller, context = initial) =>
    store.acceptRun(
      {
        callerKey: callerKey(who),
        contextId: context.contextId,
        sourceKind: "inline",
        source: { entry: "inline" },
        capacity: 2000,
      },
      now,
    ).run;
  t.after(async () => {
    options.cleanup?.();
    check = () => {};
    denied.clear();
    for (const id of runIds)
      if (store.getRun(id).endedAt === null) engine.cancel(caller, id);
    await Promise.allSettled(
      [...runIds].map((id) => engine.observe(caller, id, 30000)),
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    scripts,
    engine,
    interruptedId,
    denied,
    calls,
    open,
    initial,
    start,
    finish,
    execute,
    accepted,
    setCheck: (value) => {
      check = value;
    },
    runIds,
  };
}
function named(desc = "retained description") {
  return (
    "/**\n" +
    JSON.stringify({
      scriptName: "report.js",
      scriptDesc: desc,
      scriptWhenUse: "history test",
      scriptInputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer" } },
        additionalProperties: false,
      },
    }) +
    '\n*/\nconsole.log("retained-log");return context.input.value;'
  );
}
function all(f, filter = {}, who = caller) {
  const found = [];
  let cursor;
  do {
    const page = f.engine.list(who, {
      agentId: "a",
      ...filter,
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.runs);
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

test("get confirms only the caller-scoped accepted request and never accepts, replays or revives a closed work", async (t) => {
  const f = await fixture(t),
    requestId = newRequestId();
  const done = await f.execute({
    script: 'console.log("historical");return context.input;',
    input: { value: 7 },
    requestId,
  });
  f.store.closeWork(f.initial.contextId, callerKey(caller));
  const before = f.store.listRuns({}, "inspection").runs.length;
  const byRequest = await f.engine.get(caller, { agentId: "a", requestId });
  assert.equal(byRequest.run.runId, done.run.runId);
  assert.deepEqual(byRequest.result.data, { value: 7 });
  assert.equal(
    byRequest.snapshots.code.value.code,
    'console.log("historical");return context.input;',
  );
  assert.deepEqual(byRequest.snapshots.input.value.input, { value: 7 });
  assert.match(byRequest.snapshots.logs.value, /historical/);
  assert.equal(f.store.listRuns({}, "inspection").runs.length, before);
  await assert.rejects(f.engine.get(otherHost, { agentId: "a", requestId }), {
    code: "submission_unknown",
  });
  await assert.rejects(
    f.engine.get(caller, { agentId: "a", requestId: newRequestId() }),
    { code: "submission_unknown" },
  );
  await assert.rejects(
    f.engine.get(caller, {
      agentId: "a",
      requestId: newRequestId(Date.now() - 86400001),
    }),
    { code: "submission_expired" },
  );
  const second = await f.execute(
    { script: "return 2;" },
    otherHost,
    f.open(otherHost),
  );
  assert.equal(
    (await f.engine.get(caller, { agentId: "a", runId: second.run.runId }))
      .result.data,
    2,
  );
  assert.equal(f.engine.list(caller, { agentId: "a" }).runs.length, 2);
});

test("get and list validate exact contracts, target and current authorization without hiding configuration or storage failures", async (t) => {
  const f = await fixture(t);
  const done = await f.execute({ script: "return 1;" });
  for (const input of [
    { agentId: "a" },
    { agentId: "a", runId: done.run.runId, requestId: newRequestId() },
    { agentId: "a", runId: done.run.runId, waitMs: 30001 },
    { agentId: "a", runId: done.run.runId, extra: true },
  ])
    await assert.rejects(f.engine.get(caller, input), {
      code: "invalid_arguments",
    });
  await assert.rejects(
    f.engine.get(caller, { agentId: "other", runId: done.run.runId }),
    { code: "agent_mismatch" },
  );
  assert.throws(() => f.engine.list(caller, { agentId: "other" }), {
    code: "agent_mismatch",
  });
  for (const input of [
    { agentId: "a", limit: 0 },
    { agentId: "a", limit: 101 },
    { agentId: "a", source: "script" },
    { agentId: "a", from: "not-a-time" },
  ])
    assert.throws(() => f.engine.list(caller, input), {
      code: "invalid_arguments",
    });
  assert.throws(
    () =>
      f.engine.list(caller, {
        agentId: "a",
        from: "2026-11-15T00:00:00Z",
        to: "2026-11-14T00:00:00Z",
      }),
    { code: "invalid_range" },
  );
  f.denied.add(done.run.runId);
  assert.deepEqual(f.engine.list(caller, { agentId: "a" }).runs, []);
  await assert.rejects(
    f.engine.get(caller, { agentId: "a", runId: done.run.runId }),
    { code: "forbidden" },
  );
  f.denied.clear();
  f.setCheck((_who, target) => {
    if (target.run) return false;
  });
  assert.throws(() => f.engine.list(caller, { agentId: "a" }), {
    code: "authorization_configuration",
  });
  f.setCheck((_who, target) => {
    if (target.run) throw new Error("policy-service-failed");
  });
  assert.throws(
    () => f.engine.list(caller, { agentId: "a" }),
    /policy-service-failed/,
  );
  f.setCheck(() => {
    throw new AgentError("forbidden", "Agent permission revoked");
  });
  assert.throws(
    () => f.engine.list(caller, { agentId: "a", contextId: "no-records" }),
    { code: "forbidden" },
  );
  f.setCheck(() => {});
  f.runIds.clear();
  f.store.close();
  assert.throws(
    () => f.engine.list(caller, { agentId: "a" }),
    /closed|not open/i,
  );
});

test("history is Agent-wide across closed contexts and Hosts, with AND source, name, project, context and accepted-time filters", async (t) => {
  const f = await fixture(t);
  const project = f.open(caller, "project-old"),
    other = f.open(otherHost);
  writeFileSync(path.join(f.scripts.local, "report.js"), named());
  const inline = await f.execute({ script: "return 1;" });
  const fixed = await f.execute(
    { scriptName: "report.js", input: { value: 4 } },
    caller,
    project,
  );
  const history = await f.execute(
    { replayRunId: fixed.run.runId },
    otherHost,
    other,
  );
  const failed = await f.execute({ script: "return );" });
  assert.equal(failed.run.status, "failed");
  f.store.closeWork(project.contextId, callerKey(caller));
  f.store.closeWork(other.contextId, callerKey(otherHost));
  const records = all(f, { limit: 1 });
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map((x) => x.runId)).size, 4);
  assert.deepEqual(
    records.map((x) => x.runId),
    [...records]
      .sort(
        (a, b) =>
          Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt) ||
          b.runId.localeCompare(a.runId),
      )
      .map((x) => x.runId),
  );
  const namedRows = all(f, {
    source: "named",
    scriptName: "report.js",
    status: "succeeded",
    projectId: "project-old",
    contextId: project.contextId,
    from: new Date(fixed.run.acceptedAt).toISOString(),
    to: new Date(fixed.run.acceptedAt + 1).toISOString(),
  });
  assert.deepEqual(
    namedRows.map((x) => x.runId),
    [fixed.run.runId],
  );
  assert.equal(namedRows[0].scriptDesc, "retained description");
  assert.equal(namedRows[0].origin.type, "local");
  assert.equal(all(f, { source: "history" })[0].replayOfRunId, fixed.run.runId);
  assert.equal(all(f, { source: "inline" }).length, 2);
  assert.deepEqual(
    all(f, {
      from: new Date(inline.run.acceptedAt).toISOString(),
      to: new Date(inline.run.acceptedAt).toISOString(),
    }),
    [],
  );
  const summary = records.find((x) => x.runId === fixed.run.runId);
  for (const key of [
    "callerKey",
    "bootId",
    "admissionClass",
    "codeRef",
    "inputRef",
    "resultRef",
    "logsRef",
    "error",
    "cleanup",
  ])
    assert.equal(Object.hasOwn(summary, key), false);
  assert.equal(summary.availability.result, "available");
  assert.equal(summary.availability.artifacts, "unknown");
});

test("opaque per-row continuations neither skip authorized rows nor preserve old permissions or expose denied identities", async (t) => {
  const f = await fixture(t),
    now = Date.now();
  const runs = [];
  for (let n = 0; n < 7; n++) runs.push(f.accepted(now));
  runs.sort((a, b) => b.runId.localeCompare(a.runId));
  f.denied.add(runs[0].runId);
  f.denied.add(runs[2].runId);
  f.denied.add(runs[5].runId);
  const first = f.engine.list(caller, { agentId: "a", limit: 2 });
  assert.deepEqual(
    first.runs.map((x) => x.runId),
    [runs[1].runId, runs[3].runId],
  );
  assert(first.nextCursor);
  const decoded = Buffer.from(first.nextCursor, "base64url").toString();
  for (const run of runs) assert.equal(decoded.includes(run.runId), false);
  f.denied.add(runs[4].runId);
  const second = f.engine.list(caller, {
    agentId: "a",
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.runs.map((x) => x.runId),
    [runs[6].runId],
  );
  assert.equal(second.nextCursor, null);
  for (const change of [
    { status: "accepted" },
    { contextId: f.initial.contextId },
  ])
    assert.throws(
      () =>
        f.engine.list(caller, {
          agentId: "a",
          cursor: first.nextCursor,
          ...change,
        }),
      { code: "invalid_cursor" },
    );
  assert.throws(
    () => f.engine.list(otherHost, { agentId: "a", cursor: first.nextCursor }),
    { code: "invalid_cursor" },
  );
  assert.throws(
    () =>
      f.engine.list(
        { ...caller, grantId: "new-grant" },
        { agentId: "a", cursor: first.nextCursor },
      ),
    { code: "invalid_cursor" },
  );
  assert.throws(
    () =>
      f.engine.list(caller, {
        agentId: "a",
        cursor: first.nextCursor.slice(0, -4) + "aaaa",
      }),
    { code: "invalid_cursor" },
  );
});

test("a bounded denied scan can return an empty continuation and does not omit the oldest authorized history", async (t) => {
  const f = await fixture(t),
    now = Date.now();
  let oldest;
  for (let n = 0; n < 1001; n++) {
    const run = f.accepted(now + n);
    const terminal = f.store.transitionRun(
      run.runId,
      run.revision,
      "failed",
      {},
      now + n,
    );
    if (n === 0) oldest = terminal;
    else f.denied.add(run.runId);
  }
  const first = f.engine.list(caller, { agentId: "a", limit: 1 });
  assert.deepEqual(first.runs, []);
  assert(first.nextCursor);
  const second = f.engine.list(caller, {
    agentId: "a",
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.runs.map((x) => x.runId),
    [oldest.runId],
  );
  assert.equal(second.nextCursor, null);
});

test("get reports lost, corrupt, redirected or oversized retained details without changing terminal facts, and bounds log prefixes", async (t) => {
  const f = await fixture(t);
  const done = await f.execute({
    script: 'console.log("😀".repeat(3000));return 42;',
    input: { large: "x".repeat(10000) },
  });
  const intact = await f.engine.get(caller, {
    agentId: "a",
    runId: done.run.runId,
  });
  assert.equal(intact.snapshots.input.status, "too_large");
  assert.equal(intact.snapshots.input.ref, done.run.inputRef);
  assert.equal(intact.snapshots.logs.truncated, true);
  assert.equal(
    intact.snapshots.logs.nextOffset,
    intact.snapshots.logs.dataOffset +
      Buffer.byteLength(intact.snapshots.logs.value),
  );
  assert(intact.snapshots.logs.nextOffset <= 8192);
  assert.equal(intact.snapshots.logs.value.includes("�"), false);
  const inputPath = path.join(f.root, done.run.inputRef);
  writeFileSync(inputPath, "not json");
  const codePath = path.join(f.root, done.run.codeRef);
  rmSync(codePath);
  rmSync(path.join(f.root, done.run.resultRef));
  rmSync(path.join(f.root, done.run.logsRef));
  const broken = await f.engine.get(caller, {
    agentId: "a",
    runId: done.run.runId,
  });
  assert.equal(broken.run.status, "succeeded");
  assert.equal(broken.run.revision, done.run.revision);
  assert.equal(broken.unavailable.code, "result_unavailable");
  assert.equal(broken.snapshots.code.status, "unavailable");
  assert.equal(broken.snapshots.input.status, "unavailable");
  assert.equal(broken.snapshots.logs.status, "unavailable");
  assert.equal(
    f.engine.list(caller, { agentId: "a" }).runs[0].availability.result,
    "unavailable",
  );
  const replay = await f.execute({ replayRunId: done.run.runId });
  assert.equal(replay.run.status, "failed");
  assert.equal(
    f.engine.list(caller, { agentId: "a", source: "history" }).runs[0]
      .replayOfRunId,
    done.run.runId,
  );
});

test("get observations preserve waits and deadlines, and list rechecks status after deadline observation", async (t) => {
  const f = await fixture(t);
  const waiting = await f.start({
    script:
      'return await runtime.requestInput({message:"continue",inputSchema:{type:"null"}});',
    waitMs: 30000,
  });
  assert.equal(waiting.run.status, "waiting_input");
  const got = await f.engine.get(caller, {
    agentId: "a",
    runId: waiting.run.runId,
    waitMs: 30000,
  });
  assert.equal(got.wait.waitId, waiting.wait.waitId);
  assert.equal(got.wait.status, "waiting");
  assert.equal(got.run.deadlineAt, waiting.run.deadlineAt);
  const cancelled = new AbortController();
  cancelled.abort(new Error("observe stopped"));
  await assert.rejects(
    f.engine.get(
      caller,
      { agentId: "a", runId: waiting.run.runId },
      cancelled.signal,
    ),
    /observe stopped/,
  );
  assert.equal(f.store.getRun(waiting.run.runId).status, "waiting_input");
  f.engine.cancel(caller, waiting.run.runId);
  await f.finish(waiting.run.runId);
  const short = await f.start({
    script:
      'return await runtime.requestInput({message:"continue",inputSchema:{type:"null"}});',
    waitMs: 30000,
  });
  assert.equal(short.run.status, "waiting_input");
  const clock = t.mock.method(Date, "now", () => short.run.deadlineAt + 1);
  try {
    const page = f.engine.list(caller, {
      agentId: "a",
      status: "waiting_input",
    });
    assert.equal(
      page.runs.some((x) => x.runId === short.run.runId),
      false,
    );
    assert.equal(f.store.getRun(short.run.runId).status, "cancelling");
    const cancelled = f.engine.cancel(caller, short.run.runId);
    assert.equal(cancelled.accepted, false);
    assert.equal(cancelled.run.stop.kind, "deadline");
  } finally {
    clock.mock.restore();
  }
  await f.finish(short.run.runId);
});

test("retained run lookup missing behind a request identity remains submission_unknown rather than proof of nonexecution", async (t) => {
  const f = await fixture(t),
    requestId = newRequestId();
  const result = await f.execute({ script: "return 1;", requestId });
  // The storage contract deliberately preserves a submission identity after its
  // run can no longer be returned. Use a real database fault fixture, not a fake Store.
  f.runIds.clear();
  f.store.close();
  const db = new DatabaseSync(path.join(f.root, "state", "runtime.sqlite"));
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("DELETE FROM runs WHERE run_id=?").run(result.run.runId);
  db.close();
  const reopened = new SqliteStore(f.root, {
    agentId: "a",
    profile: "development",
    cloudEnvironment: "test",
  });
  try {
    const reader = new RunEngine(reopened, f.engine.loader, f.scripts, {
      authorize: () => {},
      loadWork: () => ({}),
      bindings: () => ({}),
      encodeResult: async () => ({}),
    });
    await assert.rejects(reader.get(caller, { agentId: "a", requestId }), {
      code: "submission_unknown",
    });
  } finally {
    reopened.close();
  }
});

test("all nine retained statuses remain visible and default or maximum page limits are enforced", async (t) => {
  const f = await fixture(t, { interrupted: true });
  for (const status of [
    "accepted",
    "preparing_inputs",
    "running",
    "waiting_input",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
  ]) {
    let row = f.accepted();
    if (
      ["preparing_inputs", "running", "waiting_input", "succeeded"].includes(
        status,
      )
    )
      row = f.store.transitionRun(row.runId, row.revision, "preparing_inputs");
    if (["running", "waiting_input", "succeeded"].includes(status))
      row = f.store.transitionRun(row.runId, row.revision, "running");
    if (status === "waiting_input")
      f.store.createWait(
        row.runId,
        { message: "retained wait", inputSchema: { type: "null" } },
        row.deadlineAt,
      );
    if (["cancelling", "cancelled"].includes(status))
      row = f.store.requestStop(row.runId, { kind: "cancel" }).run;
    if (["succeeded", "failed", "cancelled"].includes(status))
      f.store.transitionRun(row.runId, row.revision, status);
  }
  assert.deepEqual(
    new Set(all(f).map((x) => x.status)),
    new Set([
      "accepted",
      "preparing_inputs",
      "running",
      "waiting_input",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]),
  );
  assert.equal(
    (await f.engine.get(caller, { agentId: "a", runId: f.interruptedId })).run
      .status,
    "interrupted",
  );
  for (let n = 0; n < 20; n++) {
    const row = f.accepted();
    f.store.transitionRun(row.runId, row.revision, "failed");
  }
  const first = f.engine.list(caller, { agentId: "a" });
  assert.equal(first.runs.length, 20);
  assert(first.nextCursor);
  assert.equal(all(f, { limit: 100 }).length, 29);
});

test("summary and optional detail budgets are measured after JSON encoding without losing a pagination position", async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let n = 0; n < 40; n++) {
    const row = f.store.acceptRun(
      {
        callerKey: callerKey(caller),
        contextId: f.initial.contextId,
        sourceKind: "script",
        scriptName: "large.js",
        source: { scriptDesc: "x".repeat(8192) },
      },
      Date.now(),
    ).run;
    ids.push(row.runId);
    f.store.transitionRun(row.runId, row.revision, "failed");
  }
  const first = f.engine.list(caller, { agentId: "a", limit: 100 });
  assert(first.runs.length < 40);
  assert(first.nextCursor);
  assert(Buffer.byteLength(canonicalJson(first)) <= 65536);
  assert.equal(first.runs[0].descriptionTruncated, true);
  assert.deepEqual(
    new Set(all(f, { limit: 100 }).map((x) => x.runId)),
    new Set(ids),
  );
  const done = await f.execute({
    script: 'console.log("\\0".repeat(8192));return 1;',
  });
  const got = await f.engine.get(caller, {
    agentId: "a",
    runId: done.run.runId,
  });
  assert(Buffer.byteLength(canonicalJson(got.snapshots)) <= 65536);
  assert.equal(got.snapshots.logs.truncated, true);
});

test("a run directory or log directory redirected to a denied run never supplies that other run's retained content", async (t) => {
  const f = await fixture(t);
  const a = await f.execute({
      script: 'console.log("public-log");return "public";',
      input: { public: true },
    }),
    b = await f.execute({
      script: 'console.log("private-log");return "private";',
      input: { private: true },
    });
  f.denied.add(b.run.runId);
  for (const [from, to] of [
    [
      path.dirname(path.join(f.root, a.run.codeRef)),
      path.dirname(path.join(f.root, b.run.codeRef)),
    ],
    [
      path.dirname(path.join(f.root, a.run.logsRef)),
      path.dirname(path.join(f.root, b.run.logsRef)),
    ],
  ]) {
    renameSync(from, from + ".saved");
    symlinkSync(to, from, "junction");
  }
  const got = await f.engine.get(caller, { agentId: "a", runId: a.run.runId });
  assert.equal(got.run.status, "succeeded");
  assert.equal(got.result, null);
  assert.equal(got.unavailable.code, "result_unavailable");
  for (const key of ["code", "input", "logs"])
    assert.equal(got.snapshots[key].status, "unavailable");
  assert.equal(JSON.stringify(got.snapshots).includes("private-log"), false);
});

test("RFC3339 sub-millisecond ranges keep exact ordering and half-open integer storage boundaries", async (t) => {
  const f = await fixture(t),
    now = Date.now(),
    row = f.accepted(now);
  const iso = new Date(now).toISOString(),
    fractional = iso.slice(0, -1) + "1Z",
    later = iso.slice(0, -1) + "2Z";
  assert.deepEqual(
    f.engine.list(caller, { agentId: "a", from: fractional }).runs,
    [],
  );
  assert.deepEqual(
    f.engine
      .list(caller, { agentId: "a", to: fractional })
      .runs.map((x) => x.runId),
    [row.runId],
  );
  assert.throws(
    () => f.engine.list(caller, { agentId: "a", from: later, to: fractional }),
    { code: "invalid_range" },
  );
  assert.deepEqual(
    f.engine.list(caller, { agentId: "a", from: fractional, to: fractional })
      .runs,
    [],
  );
  const second = f.accepted(now - 1);
  const page = f.engine.list(caller, {
    agentId: "a",
    to: fractional,
    limit: 1,
  });
  assert(page.nextCursor);
  assert.throws(
    () =>
      f.engine.list(caller, {
        agentId: "a",
        to: later,
        limit: 1,
        cursor: page.nextCursor,
      }),
    { code: "invalid_cursor" },
  );
  assert.equal(page.runs[0].runId, row.runId);
  assert.notEqual(second.runId, row.runId);
});

test("cancel returns first-request acceptance separately from actual stop, repeated requests and terminal facts", async (t) => {
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const f = await fixture(t, {
    bindings: () => ({
      hold() {
        entered.resolve();
        return gate.promise;
      },
    }),
    cleanup: () => gate.resolve(),
  });
  const initial = await f.start({
    script: 'await hold();return "late success";',
  });
  await entered.promise;
  const mutableCaller = { ...caller };
  f.setCheck((_who, target) => {
    if (target.action === "cancel")
      mutableCaller.principalId = "changed-after-check";
  });
  const first = f.engine.cancel(mutableCaller, initial.run.runId);
  f.setCheck(() => {});
  assert.equal(first.accepted, true);
  assert.deepEqual(first.run.stop.requestedBy, {
    principalId: caller.principalId,
    clientId: caller.clientId,
  });
  assert.equal(first.run.status, "cancelling");
  assert.equal(first.run.endedAt, null);
  assert.equal(first.result, null);
  assert.equal(first.run.stop.kind, "cancel");
  const repeated = f.engine.cancel(caller, initial.run.runId);
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.run.revision, first.run.revision);
  assert.deepEqual(repeated.run.stop, first.run.stop);
  assert.equal(
    (await f.engine.get(caller, { agentId: "a", runId: initial.run.runId })).run
      .status,
    "cancelling",
  );
  gate.resolve();
  const done = await f.finish(initial.run.runId);
  assert.equal(done.run.status, "cancelled");
  const terminal = f.engine.cancel(caller, initial.run.runId);
  assert.equal(terminal.accepted, false);
  assert.equal(terminal.run.status, "cancelled");
  assert.equal(terminal.run.revision, done.run.revision);
  const succeeded = await f.execute({ script: "return 7;" });
  const unchanged = f.engine.cancel(caller, succeeded.run.runId);
  assert.equal(unchanged.accepted, false);
  assert.equal(unchanged.run.status, "succeeded");
  assert.equal(unchanged.run.revision, succeeded.run.revision);
  assert.deepEqual(unchanged.result, succeeded.result);
  f.denied.add(succeeded.run.runId);
  assert.throws(() => f.engine.cancel(caller, succeeded.run.runId), {
    code: "forbidden",
  });
  assert.equal(
    f.store.getRun(succeeded.run.runId).revision,
    succeeded.run.revision,
  );
});
