import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { canonicalJson, newRequestId } from "../dist/contracts/json.js";

const caller = { principalId: "user", clientId: "client", host: "test-host" };
async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-engine-")),
    workDir = path.join(root, "work");
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
    agentId: "a",
    profile: "development",
    cloudEnvironment: "test",
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const scripts = new ScriptCatalog(workDir, "a");
  const loader = await ModuleLoader.create(workDir, store.bootId, {
    builtins: () => ["timers"],
    approvedPackages: () => new Map(),
  });
  const snapshot = path.join(workDir, "snapshot.json");
  writeFileSync(snapshot, JSON.stringify({ project: null }));
  const work = store.openWork({
    callerKey: callerKey(caller),
    pwd: workDir,
    snapshotRef: path.relative(root, snapshot),
  });
  let allowed = true;
  const engine = new RunEngine(store, loader, scripts, {
    authorize(who, target) {
      if (!allowed || (target.run && target.run.callerKey !== callerKey(who)))
        throw Object.assign(new Error("forbidden"), { code: "forbidden" });
    },
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    // This fixture exercises the engine boundary with ordinary JSON. The complete
    // media/result service is independently required by the Phase, not mocked as acceptance.
    encodeResult: async (value) =>
      value === undefined
        ? { content: [] }
        : { content: [], data: JSON.parse(canonicalJson(value)) },
    bindings: (services) => ({
      runtime: { requestInput: services.requestInput },
    }),
    ...options,
  });
  const start = (input) =>
    engine.start(caller, { contextId: work.contextId, ...input });
  const finish = (id) => engine.observe(caller, id, 3000);
  return {
    engine,
    store,
    scripts,
    work,
    root,
    workDir,
    start,
    finish,
    revoke: () => (allowed = false),
  };
}
function named(body = "return context.input;", extra = {}) {
  return (
    "/**\n" +
    JSON.stringify({
      scriptName: "example.js",
      scriptDesc: "测试流程",
      scriptWhenUse: "测试输入",
      scriptInputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer" } },
        additionalProperties: false,
      },
      ...extra,
    }) +
    "\n*/\n" +
    body
  );
}

test("accepted native execution saves snapshots/results and keeps observation timeouts independent", async (t) => {
  const { start, finish, engine, store, root } = await fixture(t);
  const first = await start({
    script:
      'await new Promise(resolve=>setTimeout(resolve,40)); console.log("hello");return {value:context.input,pwd:context.pwd};',
    input: 3,
    waitMs: 0,
  });
  assert.equal(first.run.status, "accepted");
  const running = await engine.observe(caller, first.run.runId, 5);
  assert.equal(running.run.status, "running");
  assert.equal(running.run.stop, null);
  const completed = await finish(first.run.runId);
  assert.equal(completed.run.status, "succeeded");
  assert.equal(completed.result.data.value, 3);
  assert.match(
    readFileSync(path.join(root, completed.run.logsRef), "utf8"),
    /hello/,
  );
  assert.equal(store.getRun(first.run.runId).endedAt !== null, true);
  assert.deepEqual((await finish(first.run.runId)).result, completed.result);
});

test("enrollment precedes input validation; syntax/preparation failures never count as an actual start", async (t) => {
  const { start, store, scripts } = await fixture(t);
  const prepared = await start({ script: named(), input: { value: "wrong" } });
  assert.equal(prepared.run.status, "failed");
  assert.equal(prepared.run.startedAt, null);
  assert.equal(prepared.run.error.phase, "prepare");
  assert.equal(scripts.resolve("example.js").name, "example.js");
  assert.equal(store.scriptUsage(callerKey(caller)).length, 0);
  const syntax = await start({
    script: named("return {"),
    input: { value: 1 },
  }).catch((error) => error);
  // The name conflict is a preparation failure; an anonymous syntax failure reaches compile.
  assert.equal(syntax.run.error.code, "script_name_conflict");
  const bad = await start({ script: "return {", waitMs: 1000 });
  assert.equal(bad.run.status, "failed");
  assert.equal(bad.run.error.code, "script_syntax_error");
  assert.equal(bad.run.startedAt, null);
  assert.ok(bad.run.codeRef);
  assert.ok(bad.run.inputRef);
});

test("dedup does not reload changed code or execute twice, including after work closes", async (t) => {
  let calls = 0;
  const { start, store, work, engine } = await fixture(t, {
    bindings: () => ({ mark: () => calls++ }),
  });
  const requestId = newRequestId();
  const first = await start({ script: "mark();return 1;", requestId });
  assert.equal(first.run.status, "succeeded");
  assert.equal(calls, 1);
  store.closeWork(work.contextId, callerKey(caller));
  const repeated = await engine.start(caller, {
    contextId: work.contextId,
    script: "mark();return 1;",
    requestId,
    waitMs: 0,
  });
  assert.equal(repeated.run.runId, first.run.runId);
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      engine.start(caller, {
        contextId: work.contextId,
        script: "mark();return 2;",
        requestId,
      }),
    { code: "submission_conflict" },
  );
});

test("input resumes the same stack once; invalid input remains correctable and duplicates keep the consumed receipt", async (t) => {
  let before = 0,
    after = 0;
  const { start, engine, finish, store } = await fixture(t, {
    bindings: (s) => ({
      runtime: { requestInput: s.requestInput },
      before: () => before++,
      after: () => after++,
    }),
  });
  const initial = await start({
    script:
      'before();const reply=await runtime.requestInput({message:"a number",inputSchema:{type:"integer"}});after();return {reply:reply.input,initial:context.input};',
    input: 9,
  });
  assert.equal(initial.run.status, "waiting_input");
  assert.equal(before, 1);
  assert.equal(after, 0);
  const args = {
    agentId: "a",
    runId: initial.run.runId,
    waitId: initial.wait.waitId,
    input: "invalid",
  };
  const failed = await engine.input(caller, args);
  assert.equal(failed.submission.deliveryState, "failed");
  assert.equal(failed.run.status, "waiting_input");
  const good = await engine.input(caller, { ...args, input: 4 });
  const done = await finish(initial.run.runId);
  assert.equal(done.run.runId, initial.run.runId);
  assert.equal(done.run.status, "succeeded");
  assert.deepEqual(done.result.data, { initial: 9, reply: 4 });
  assert.equal(after, 1);
  const duplicate = await engine.input(caller, { ...args, input: 4 });
  assert.equal(duplicate.submission.status, "consumed");
  assert.equal(before, 1);
  assert.equal(after, 1);
  await assert.rejects(() => engine.input(caller, { ...args, input: 5 }), {
    code: "input_conflict",
  });
  assert.equal(store.getWait(good.submission.waitId).receipt.accepted, true);
});

test("concurrent identical input preparation runs once; cancellation wins over a late attachment completion", async (t) => {
  let prepared = 0;
  const gate = Promise.withResolvers();
  const { start, engine, finish } = await fixture(t, {
    prepareAttachments: async () => {
      prepared++;
      await gate.promise;
      return [];
    },
  });
  const initial = await start({
    script:
      'await runtime.requestInput({message:"files",inputSchema:{type:"integer"}});return "after";',
  });
  const args = {
    agentId: "a",
    runId: initial.run.runId,
    waitId: initial.wait.waitId,
    input: 2,
    attachments: [{ transferId: "transfer_test" }],
    waitMs: 0,
  };
  const [a, b] = await Promise.all([
    engine.input(caller, args),
    engine.input(caller, args),
  ]);
  assert.equal(prepared, 1);
  assert.equal(a.submission.deliveryState, "preparing");
  assert.equal(b.submission.deliveryState, "preparing");
  engine.cancel(caller, initial.run.runId);
  assert.equal(
    (await engine.observe(caller, initial.run.runId, 5)).run.status,
    "cancelling",
  );
  gate.resolve();
  const done = await finish(initial.run.runId);
  assert.equal(done.run.status, "cancelled");
  assert.equal(done.result, null);
  assert.equal(done.run.stop.kind, "cancel");
});

test("local input timeout is catchable; an abandoned input wait fails rather than leaving a phantom continuation", async (t) => {
  const { start, finish, store } = await fixture(t);
  const initial = await start({
    script:
      'try { await runtime.requestInput({message:"short",inputSchema:{},timeoutMs:20}); }catch(error){return {name:error.name};}',
  });
  await delay(30);
  const done = await finish(initial.run.runId);
  assert.equal(done.run.status, "succeeded");
  assert.equal(done.result.data.name, "InputTimeoutError");
  assert.equal(store.getWait(initial.wait.waitId).status, "expired");
  const abandoned = await start({
    script:
      'runtime.requestInput({message:"ignored",inputSchema:{}});return "done";',
  });
  // An observation may first see the newly exposed wait; query after root settlement.
  await delay(1);
  const failed = await finish(abandoned.run.runId);
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.error.code, "input_not_awaited");
  assert.equal(failed.wait, null);
});

test("a stop closes managed entry immediately and keeps cancelling until an uncooperative root actually settles", async (t) => {
  const gate = Promise.withResolvers();
  const { start, engine, finish } = await fixture(t, {
    bindings: (s) => ({
      gate: () => gate.promise,
      runtime: { requestInput: s.requestInput },
    }),
  });
  const initial = await start({
    script:
      'await gate();try {await runtime.requestInput({message:"late",inputSchema:{}});} catch {} return "success";',
    waitMs: 5,
  });
  assert.equal(initial.run.status, "running");
  assert.equal(
    engine.cancel(caller, initial.run.runId).run.status,
    "cancelling",
  );
  assert.equal(
    (await engine.observe(caller, initial.run.runId, 10)).run.status,
    "cancelling",
  );
  gate.resolve();
  const stopped = await finish(initial.run.runId);
  assert.equal(stopped.run.status, "cancelled");
  assert.equal(stopped.result, null);
  assert.equal(
    engine.cancel(caller, initial.run.runId).run.status,
    "cancelled",
  );
});

test("total deadline covers the root and result processing, remains distinct from explicit cancellation", async (t) => {
  const gate = Promise.withResolvers();
  const { start, engine, finish } = await fixture(t, {
    bindings: () => ({ gate: () => gate.promise }),
  });
  const first = await start({
    script: "await gate();return 1;",
    timeoutMs: 25,
    waitMs: 5,
  });
  await delay(35);
  assert.equal(
    (await engine.observe(caller, first.run.runId)).run.status,
    "cancelling",
  );
  engine.cancel(caller, first.run.runId);
  gate.resolve();
  const done = await finish(first.run.runId);
  assert.equal(done.run.status, "failed");
  assert.equal(done.run.stop.kind, "deadline");
});

test("replay uses the historical code/header/input without recollection and explicit input replaces it", async (t) => {
  const { start, scripts } = await fixture(t);
  const original = await start({
    script: named("return context.input.value+1;"),
    input: { value: 4 },
  });
  writeFileSync(
    scripts.resolve("example.js").path,
    named("return context.input.value+100;"),
  );
  const current = await start({
    scriptName: "example.js",
    input: { value: 1 },
  });
  assert.equal(current.result.data, 101);
  const replay = await start({ replayRunId: original.run.runId });
  assert.equal(replay.result.data, 5);
  assert.equal(replay.run.source.replayRunId, original.run.runId);
  const replacement = await start({
    replayRunId: original.run.runId,
    input: { value: 7 },
  });
  assert.equal(replacement.result.data, 8);
  assert.match(scripts.resolve("example.js").code, /\+100/);
});

test("an aborted observer does not cancel the run; current access is rechecked on observation", async (t) => {
  const { start, finish, engine, revoke } = await fixture(t);
  const first = await start({
    script: "await new Promise(resolve=>setTimeout(resolve,50));return 1;",
    waitMs: 0,
  });
  const controller = new AbortController();
  const observation = engine.observe(
    caller,
    first.run.runId,
    1000,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(() => observation, { name: "AbortError" });
  const done = await finish(first.run.runId);
  assert.equal(done.run.status, "succeeded");
  assert.equal(done.run.stop, null);
  revoke();
  await assert.rejects(() => engine.observe(caller, first.run.runId), {
    code: "forbidden",
  });
  assert.equal(engine.listenerCount(first.run.runId), 0);
});

test("clock rollback cannot extend the total or local input deadlines", async (t) => {
  const realNow = Date.now;
  const gate = Promise.withResolvers();
  const { start, engine, finish } = await fixture(t, {
    bindings: (services) => ({
      gate: () => gate.promise,
      runtime: { requestInput: services.requestInput },
    }),
  });
  t.after(() => {
    Date.now = realNow;
  });
  const first = await start({
    script: "await gate();return 1;",
    timeoutMs: 30,
    waitMs: 1,
  });
  Date.now = () => realNow() - 60_000;
  await delay(40);
  assert.equal(
    (await engine.observe(caller, first.run.runId)).run.status,
    "cancelling",
  );
  gate.resolve();
  const done = await finish(first.run.runId);
  assert.equal(done.run.status, "failed");
  assert.equal(done.run.stop.kind, "deadline");
  assert.ok(done.run.endedAt >= done.run.deadlineAt);
  Date.now = realNow;
  const waiting = await start({
    script:
      'try{await runtime.requestInput({message:"clock",inputSchema:{},timeoutMs:20});}catch(error){return error.name;}',
  });
  Date.now = () => realNow() - 60_000;
  await delay(30);
  const ended = await finish(waiting.run.runId);
  assert.equal(ended.run.status, "succeeded");
  assert.equal(ended.result.data, "InputTimeoutError");
  Date.now = realNow;
});

test("failed result persistence records failure without publishing a nonexistent result; later file loss preserves history", async (t) => {
  const setup = await fixture(t, {
    encodeResult: async (_value, services) => {
      mkdirSync(path.join(services.context.paths.temp, "result.json"));
      return { content: [], data: 1 };
    },
  });
  const failed = await setup.start({ script: "return 1;" });
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.error.phase, "result");
  assert.equal(failed.run.resultRef, null);
  assert.equal(failed.result, null);
  const next = await fixture(t);
  const done = await next.start({ script: "return 2;" });
  assert.equal(done.run.status, "succeeded");
  rmSync(path.join(next.root, done.run.resultRef));
  const historical = await next.finish(done.run.runId);
  assert.equal(historical.run.status, "succeeded");
  assert.equal(historical.result, null);
  assert.equal(historical.unavailable.code, "result_unavailable");
});
