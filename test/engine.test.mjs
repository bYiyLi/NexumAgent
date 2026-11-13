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
import { EventEmitter, once } from "node:events";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { canonicalJson, newRequestId } from "../dist/contracts/json.js";
import { ResourceManager } from "../dist/extensions/resources.js";

const caller = { principalId: "user", clientId: "client", host: "test-host" };

async function resourceFixture(t) {
  const events = new EventEmitter(),
    controls = new Map();
  let manager;
  const setup = await fixture(t, ({ store }) => {
    manager = new ResourceManager(store, { cleanupTimeoutMs: 30 });
    const instance = manager.instance(
      {
        type: "extension",
        owner: "@test/engine",
        namespace: "engine-test",
        version: "1",
        revision: "one",
      },
      {
        signal: new AbortController().signal,
        assertActive: () => {},
        authorize: () => {},
      },
    );
    return {
      resources: manager,
      bindings(services) {
        const resources = instance.bind({
          runId: services.runId,
          signal: services.signal,
          assertActive: services.assertCurrent,
          authorize: () => {},
        });
        return {
          managed: {
            async open(background = false) {
              services.assertActive();
              const closed = Promise.withResolvers();
              const entry = {
                closed,
                stops: 0,
                closeOnDispose: false,
                ref: undefined,
              };
              const value = {
                closed: closed.promise,
                dispose() {
                  entry.stops++;
                  if (entry.closeOnDispose) closed.resolve();
                },
              };
              entry.ref = await resources.register({ kind: "session", value });
              controls.set(entry.ref.id, entry);
              if (background) await resources.handoff(entry.ref.id);
              events.emit("registered", entry.ref.id);
              return entry.ref.id;
            },
            async close(id) {
              services.assertActive();
              const ref = await resources.get(id);
              return { id, status: (await manager.dispose(ref)).status };
            },
          },
        };
      },
    };
  });
  return { ...setup, manager, controls, events };
}
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
    ...(typeof options === "function"
      ? options({ store, loader, scripts })
      : options),
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
  assert.ok(["preparing_inputs", "running"].includes(running.run.status));
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
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  const { start, finish, store } = await fixture(t);
  const initial = await start({
    script:
      'try { await runtime.requestInput({message:"short",inputSchema:{},timeoutMs:60000}); }catch(error){return {name:error.name};}',
  });
  assert.equal(initial.run.status, "waiting_input");
  Date.now = () => initial.wait.deadlineAt + 1;
  const done = await finish(initial.run.runId);
  Date.now = realNow;
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
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { start, engine, finish } = await fixture(t, {
    bindings: (s) => ({
      gate: () => {
        entered.resolve();
        return gate.promise;
      },
      runtime: { requestInput: s.requestInput },
    }),
  });
  const initial = await start({
    script:
      'await gate();try {await runtime.requestInput({message:"late",inputSchema:{}});} catch {} return "success";',
    waitMs: 0,
  });
  await entered.promise;
  assert.equal(
    (await engine.observe(caller, initial.run.runId)).run.status,
    "running",
  );
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
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { start, engine, finish } = await fixture(t, {
    bindings: () => ({
      gate: () => {
        entered.resolve();
        return gate.promise;
      },
    }),
  });
  const first = await start({
    script: "await gate();return 1;",
    timeoutMs: 60_000,
    waitMs: 0,
  });
  await entered.promise;
  Date.now = () => first.run.deadlineAt + 1;
  assert.equal(
    (await engine.observe(caller, first.run.runId)).run.status,
    "cancelling",
  );
  engine.cancel(caller, first.run.runId);
  gate.resolve();
  const done = await finish(first.run.runId);
  assert.equal(done.run.status, "failed");
  assert.equal(done.run.stop.kind, "deadline");
  Date.now = realNow;
  const encoding = Promise.withResolvers(),
    encoded = Promise.withResolvers();
  const resultPhase = await fixture(t, {
    encodeResult: async () => {
      encoding.resolve();
      await encoded.promise;
      return { content: [], data: 1 };
    },
  });
  const resultRun = await resultPhase.start({
    script: "return 1;",
    timeoutMs: 60_000,
    waitMs: 0,
  });
  await encoding.promise;
  Date.now = () => resultRun.run.deadlineAt + 1;
  assert.equal(
    (await resultPhase.engine.observe(caller, resultRun.run.runId)).run.status,
    "cancelling",
  );
  encoded.resolve();
  const timedOut = await resultPhase.finish(resultRun.run.runId);
  assert.equal(timedOut.run.status, "failed");
  assert.equal(timedOut.run.stop.kind, "deadline");
  assert.equal(timedOut.run.resultRef, null);
  Date.now = realNow;
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
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { start, engine, finish } = await fixture(t, {
    bindings: (services) => ({
      gate: () => {
        entered.resolve();
        return gate.promise;
      },
      runtime: { requestInput: services.requestInput },
    }),
  });
  t.after(() => {
    Date.now = realNow;
  });
  const first = await start({
    script: "await gate();return 1;",
    timeoutMs: 2000,
    waitMs: 0,
  });
  await entered.promise;
  Date.now = () => realNow() - 60_000;
  await delay(2050);
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
      'try{await runtime.requestInput({message:"clock",inputSchema:{},timeoutMs:2000});}catch(error){return error.name;}',
  });
  assert.equal(waiting.run.status, "waiting_input");
  Date.now = () => realNow() - 60_000;
  await delay(2050);
  const ended = await finish(waiting.run.runId);
  assert.equal(ended.run.status, "succeeded");
  assert.equal(ended.result.data, "InputTimeoutError");
  Date.now = realNow;
});

test("preparation time consumes the accepted deadline without invoking the root", async (t) => {
  let invoked = false;
  const { start } = await fixture(t, {
    loadWork: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      return { project: null };
    },
    bindings: () => ({
      entered: () => {
        invoked = true;
      },
    }),
  });
  const done = await start({ script: "entered();return 1;", timeoutMs: 20 });
  assert.equal(done.run.status, "failed");
  assert.equal(done.run.stop.kind, "deadline");
  assert.equal(done.run.startedAt, null);
  assert.equal(invoked, false);
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

test("run completion waits for actual managed closure, persists unconfirmed facts and still accepts cancellation", async (t) => {
  const f = await resourceFixture(t);
  const registered = once(f.events, "registered");
  const started = await f.start({
    script: "return await managed.open();",
    waitMs: 0,
  });
  const [id] = await registered;
  const closing = await f.engine.observe(caller, started.run.runId, 150);
  assert.equal(closing.run.status, "running");
  assert.equal(closing.run.cleanup.phase, "cleanup");
  assert.equal(closing.run.cleanup.unconfirmed[0].id, id);
  assert.equal(closing.result, null);
  assert.equal(f.controls.get(id).stops, 1);
  const cancelled = f.engine.cancel(caller, started.run.runId);
  assert.equal(cancelled.run.status, "cancelling");
  f.controls.get(id).closed.resolve();
  const done = await f.finish(started.run.runId);
  assert.equal(done.run.status, "cancelled");
  assert.equal(done.run.cleanup.closed, 1);
  assert.deepEqual(done.run.cleanup.unconfirmed, []);
});

test("handed-off resources survive the creator terminal state and new runs explicitly control the original instance", async (t) => {
  const f = await resourceFixture(t);
  const started = await f.start({ script: "return await managed.open(true);" });
  assert.equal(started.run.status, "succeeded");
  const id = started.result.data,
    control = f.controls.get(id);
  assert.equal(control.ref.signal.aborted, false);
  f.engine.cancel(caller, started.run.runId);
  assert.equal(control.stops, 0);
  control.closeOnDispose = true;
  const stopped = await f.start({
    script: "return await managed.close(context.input);",
    input: id,
  });
  assert.equal(stopped.run.status, "succeeded");
  assert.equal(stopped.result.data.status, "closed");
  assert.equal(f.store.getResource(id).originRunId, started.run.runId);
  assert.equal(f.store.getResource(id).ownerRunId, null);
  assert.equal((await f.finish(started.run.runId)).run.status, "succeeded");
});

test("root errors and resource cleanup failures retain separate facts until closure is confirmed", async (t) => {
  const f = await resourceFixture(t);
  const registered = once(f.events, "registered");
  const started = await f.start({
    script: "await managed.open();throw new Error('private message');",
    waitMs: 0,
  });
  const [id] = await registered;
  const closing = await f.engine.observe(caller, started.run.runId, 150);
  assert.equal(closing.run.status, "running");
  assert.equal(closing.run.cleanup.cause.phase, "execute");
  assert.equal(closing.run.cleanup.unconfirmed[0].id, id);
  assert.doesNotMatch(JSON.stringify(closing), /private message/);
  f.controls.get(id).closed.resolve();
  const done = await f.finish(started.run.runId);
  assert.equal(done.run.status, "failed");
  assert.equal(done.run.error.phase, "execute");
  assert.equal(done.run.cleanup.closed, 1);
});
