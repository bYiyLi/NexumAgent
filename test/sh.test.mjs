import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { shExtension } from "../dist/sdk/sh.js";
import { ProcessOutputLog } from "../dist/process/output-log.js";
import { ManagedProcess } from "../dist/process/managed.js";
import { normalizeLaunch } from "../dist/process/launch.js";
import { AgentError } from "../dist/contracts/errors.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = { principalId: "user", clientId: "client", host: "sh-test" };
const origin = {
  type: "platform",
  owner: "nexum",
  namespace: "sh",
  version: "1",
  revision: "sh",
};
async function until(read, predicate, timeout = 5000) {
  const start = Date.now();
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(15);
  } while (Date.now() - start < timeout);
  assert.fail(`Condition was not reached: ${JSON.stringify(value)}`);
}
async function fixture(t, authorize = () => {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-sh-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 50 }),
    policies = [];
  const registry = new ExtensionRegistry(resources, {
    permissions: new Set(["sh.execute", "sh.read", "sh.control"]),
    authorize(policy) {
      policies.push(policy);
      authorize(policy);
    },
    log() {},
    progress() {},
  });
  const handle = await registry.prepare(
    {
      apiVersion: 1,
      origin,
      permissions: ["sh.execute", "sh.read", "sh.control"],
    },
    shExtension,
  );
  registry.publish(handle);
  const loader = await ModuleLoader.create(work, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const context = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: "work/snapshot.json",
  });
  const engine = new RunEngine(
    store,
    loader,
    new ScriptCatalog(work, "agent"),
    {
      authorize(who, target) {
        if (target.run && target.run.callerKey !== callerKey(who))
          throw new AgentError("forbidden", "Wrong caller.");
      },
      loadWork: () => ({}),
      resources,
      bindings: (services) => registry.bindings(services),
      encodeResult: async (value) =>
        value === undefined
          ? { content: [] }
          : {
              content: [],
              data: JSON.parse(canonicalJson(value, 2 * 1024 * 1024)),
            },
    },
  );
  const start = (script, more = {}) =>
    engine.start(caller, {
      contextId: context.contextId,
      script,
      waitMs: 3000,
      ...more,
    });
  t.after(async () => {
    const runs = store.listRuns({}, "cleanup", 100).runs;
    for (const run of runs)
      if (run.endedAt === null)
        await engine.cancel(caller, run.runId).catch(() => {});
    const live = new Set(
      runs
        .flatMap((run) => store.resourcesForRun(run.runId))
        .filter((row) => row.closedAt === null)
        .map((row) => row.resourceId),
    );
    for (const processId of live)
      await start(
        "return await sh.stop({processId:context.input,graceMs:30,forceMs:2000});",
        { input: processId },
      ).catch(() => {});
    for (const run of runs)
      if (store.getRun(run.runId).endedAt === null)
        await engine.observe(caller, run.runId, 3000).catch(() => {});
    await registry.disable(handle);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    resources,
    registry,
    handle,
    policies,
    engine,
    context,
    start,
    finish: (id) => engine.observe(caller, id, 3000),
    get: (id, more = {}) =>
      start("return await sh.get(context.input);", {
        input: { processId: id, ...more },
      }),
  };
}
function command(code, more = {}) {
  return { command: process.execPath, args: ["-e", code], ...more };
}
function data(result) {
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify(result.run.error),
  );
  return result.result.data;
}
function text(result) {
  return result.output.map((item) => item.data).join("");
}

test("real sh exec preserves argv/cwd, consumes input through EOF and retains nonzero outcomes", async (t) => {
  const f = await fixture(t);
  const input = command(
    'let chunks=[];process.stdin.on("data",d=>chunks.push(d));process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(1),pwd:process.cwd(),input:Buffer.concat(chunks).toString()}));process.stderr.write("stderr-tail");});',
  );
  input.args.push("a b", 'quote"value', "literal;$dollar");
  input.input = "hello input";
  const result = data(
    await f.start("return await sh.exec(context.input);", { input }),
  );
  assert.match(result.processId, /^res_[a-f0-9]{32}$/);
  assert.equal(result.outputComplete, true);
  const stdout = result.output
    .filter((item) => item.stream === "stdout")
    .map((item) => item.data)
    .join("");
  assert.deepEqual(JSON.parse(stdout), {
    args: ["a b", 'quote"value', "literal;$dollar"],
    pwd: f.work,
    input: "hello input",
  });
  assert.match(text(result), /stderr-tail/);
  assert.equal(result.exitCode, 0);
  const raw = data(
    await f.start(
      'const result=await sh.get({processId:context.input,encoding:null});return {native:result.output.every(item=>item.data.constructor.name==="Buffer"),bytes:result.output.map(item=>({stream:item.stream,bytes:Array.from(item.data)}))};',
      { input: result.processId },
    ),
  );
  assert.equal(raw.native, true);
  assert.ok(
    raw.bytes.some(
      (item) =>
        item.stream === "stderr" &&
        Buffer.from(item.bytes).toString() === "stderr-tail",
    ),
  );
  const failed = data(
    await f.start("return await sh.exec(context.input);", {
      input: command(
        'process.stdout.write("failure-output");process.exitCode=7;',
      ),
    }),
  );
  assert.equal(failed.exitCode, 7);
  assert.match(text(failed), /failure-output/);
  const checked = data(
    await f.start(
      "try{await sh.exec(context.input);}catch(e){return {code:e.code,processId:e.details.processId,exitCode:e.details.exitCode};}",
      { input: command("process.exitCode=9;", { check: true }) },
    ),
  );
  assert.equal(checked.code, "process_exit_failed");
  assert.equal(checked.exitCode, 9);
  assert.match(checked.processId, /^res_/);
  const eof = data(
    await f.start("return await sh.exec(context.input);", {
      input: command(
        'process.stdin.on("end",()=>process.stdout.write("EOF"));process.stdin.resume();',
      ),
    }),
  );
  assert.match(text(eof), /EOF/);
  const missing = await f.start("return await sh.exec(context.input);", {
    input: { command: "nexum_missing_executable_for_sh_test_8bc2d1", args: [] },
  });
  assert.equal(missing.run.status, "failed");
  assert.equal(missing.run.error.code, "command_not_found");
  const resource = f.store.resourcesForRun(missing.run.runId)[0];
  assert.equal(missing.run.error.details.processId, resource.resourceId);
  assert.notEqual(resource.closedAt, null);
  assert.equal(resource.diagnostic.details.pid, null);
});

test("MCP observation timeout keeps the same exec alive; cancellation waits for its registered process closure", async (t) => {
  const f = await fixture(t);
  const accepted = await f.start("return await sh.exec(context.input);", {
    input: command('process.stdout.write("ready");setInterval(()=>{},1000);'),
    waitMs: 0,
  });
  const row = await until(
    () => f.store.resourcesForRun(accepted.run.runId)[0],
    (value) => value?.diagnostic.details?.pid > 0,
  );
  assert.equal(row.originRunId, accepted.run.runId);
  assert.equal(row.closedAt, null);
  const observing = await f.engine.observe(caller, accepted.run.runId, 10);
  assert.equal(observing.run.endedAt, null);
  assert.equal(observing.resources.items[0].resourceId, row.resourceId);
  await f.engine.cancel(caller, accepted.run.runId);
  const closed = await f.finish(accepted.run.runId);
  assert.equal(closed.run.status, "cancelled");
  assert.notEqual(f.store.getResource(row.resourceId).closedAt, null);
});

test("start is run-owned by default while explicit background supports new-call input and historical output", async (t) => {
  const f = await fixture(t);
  const foreground = data(
    await f.start("return await sh.start(context.input);", {
      input: command("setInterval(()=>{},1000);"),
    }),
  );
  assert.notEqual(f.store.getResource(foreground.processId).closedAt, null);
  const started = await f.start("return await sh.start(context.input);", {
    input: command(
      'process.stdin.on("data",d=>process.stdout.write(d));process.stdin.on("end",()=>process.exit(0));setInterval(()=>{},1000);',
      { background: true },
    ),
  });
  const processId = data(started).processId;
  assert.equal(f.store.getResource(processId).lifetime, "background");
  assert.equal(f.store.getResource(processId).ownerRunId, null);
  assert.equal(f.store.getResource(processId).closedAt, null);
  const written = data(
    await f.start(
      'return await sh.write({processId:context.input,data:"shared-input",eof:true});',
      { input: processId },
    ),
  );
  assert.equal(written.accepted, true);
  const ended = await until(
    () => f.get(processId, { waitMs: 100 }),
    (value) => data(value).outputComplete,
  );
  assert.match(text(data(ended)), /shared-input/);
  assert.equal(data(ended).controlAvailable, false);
  const list = data(
    await f.start("return await sh.list({state:'exited',limit:100});"),
  );
  assert.ok(list.items.some((item) => item.processId === processId));
  const replay = data(await f.get(processId));
  assert.equal(text(replay), text(data(ended)));
});

test("get wait cancellation only stops the observer; pipe resize rejects and stop confirms the owned tree", async (t) => {
  const f = await fixture(t);
  const processId = data(
    await f.start("return await sh.start(context.input);", {
      input: command(
        'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000);',
        { background: true },
      ),
    }),
  ).processId;
  const ready = await until(
    () => f.get(processId, { waitMs: 100 }),
    (value) => text(data(value)).includes("ready"),
  );
  const cursor = data(ready).nextCursor;
  const observer = await f.start("return await sh.get(context.input);", {
    input: { processId, cursor, waitMs: 30000 },
    waitMs: 0,
  });
  await until(
    () => f.store.operationsForRun(observer.run.runId),
    (value) => value.length > 0,
  );
  await f.engine.cancel(caller, observer.run.runId);
  assert.equal((await f.finish(observer.run.runId)).run.status, "cancelled");
  assert.equal(data(await f.get(processId)).controlAvailable, true);
  const unsupported = data(
    await f.start(
      "try{await sh.resize({processId:context.input,cols:90,rows:30});}catch(e){return e.code;}",
      { input: processId },
    ),
  );
  assert.match(unsupported, /tty|terminal/i);
  const stopped = data(
    await f.start("return await sh.stop(context.input);", {
      input: { processId, graceMs: 30, forceMs: 2000 },
    }),
  );
  assert.equal(stopped.accepted, true);
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.facts.closed, true);
  assert.equal(stopped.facts.forceRequested, true);
  const repeated = data(
    await f.start("return await sh.stop({processId:context.input});", {
      input: processId,
    }),
  );
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.confirmed, true);
  assert.equal(repeated.facts.closed, true);
});

test("which and shell execution use fresh user discovery while descriptor-safe inputs never execute hooks", async (t) => {
  const f = await fixture(t);
  const found = data(
    await f.start("return await sh.which(context.input);", {
      input: process.execPath,
    }),
  );
  assert.equal(found.path, realpathSync.native(process.execPath));
  assert.equal(found.kind, "native");
  const shell = data(
    await f.start("return await sh.exec(context.input);", {
      input:
        process.platform === "win32"
          ? "echo shell-ready"
          : "printf shell-ready",
    }),
  );
  assert.match(text(shell), /shell-ready/);
  const checked = data(
    await f.start(
      `
    let hooks=0;const invalid={get command(){hooks++;return "bad";}};let code;
    try{await sh.exec(invalid);}catch(e){code=e.code;}
    const bytes=new Uint8Array([0,1,255]);Object.defineProperty(bytes,"constructor",{get(){hooks++;throw Error("hook");}});
    const result=await sh.exec({command:context.input,args:["-e",'let a=[];process.stdin.on("data",d=>a.push(d));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(a).toString("hex")));'],input:bytes});
    return {hooks,code,output:result.output};
  `,
      { input: process.execPath },
    ),
  );
  assert.equal(checked.hooks, 0);
  assert.equal(checked.code, "invalid_process_arguments");
  assert.match(checked.output.map((value) => value.data).join(""), /0001ff/);
  assert.ok(f.policies.some((policy) => policy.target?.access === "execute"));
});

test("successful background handoff survives a failure to return the subsequent snapshot", async (t) => {
  let handed = false,
    deny = true;
  const f = await fixture(t, (policy) => {
    if (policy.target?.access === "handoff") handed = true;
    if (deny && handed && policy.target?.access === "describe")
      throw new AgentError("forbidden", "Snapshot access changed.");
  });
  const started = await f.start("return await sh.start(context.input);", {
    input: command("setInterval(()=>{},1000);", { background: true }),
  });
  assert.equal(started.run.status, "failed");
  const row = f.store.resourcesForRun(started.run.runId)[0];
  assert.equal(row.lifetime, "background");
  assert.equal(row.closedAt, null);
  deny = false;
  assert.equal(data(await f.get(row.resourceId)).controlAvailable, true);
  assert.equal(
    data(
      await f.start(
        "return await sh.stop({processId:context.input,graceMs:20,forceMs:2000});",
        { input: row.resourceId },
      ),
    ).confirmed,
    true,
  );
});

test("local process deadline retains its reason independently of a completed background creator", async (t) => {
  const f = await fixture(t);
  const created = await f.start("return await sh.start(context.input);", {
    input: command("setInterval(()=>{},1000);", {
      background: true,
      timeoutMs: 1500,
    }),
  });
  const processId = data(created).processId;
  const ended = await until(
    () => f.get(processId, { waitMs: 100 }),
    (value) => data(value).closedAt !== null,
    6000,
  );
  assert.equal(data(ended).details.stopReason.code, "process_timeout");
  assert.equal(data(ended).outputComplete, true);
  assert.equal(f.store.getRun(created.run.runId).status, "succeeded");
});

test("a log finish failure releases a physically closed process only after actual log close", async (t) => {
  const f = await fixture(t),
    finish = ProcessOutputLog.prototype.finish,
    close = ProcessOutputLog.prototype.close;
  let closes = 0;
  ProcessOutputLog.prototype.finish = async function () {
    throw new AgentError("output_finish_failed", "injected finish failure");
  };
  ProcessOutputLog.prototype.close = async function (...args) {
    closes++;
    return await close.apply(this, args);
  };
  try {
    const result = await f.start("return await sh.exec(context.input);", {
      input: command('process.stdout.write("retained");'),
    });
    assert.equal(result.run.status, "failed");
    const row = f.store.resourcesForRun(result.run.runId)[0];
    assert.notEqual(row.closedAt, null);
    assert.equal(row.diagnostic.details.outputComplete, false);
    assert.ok(closes > 0);
  } finally {
    ProcessOutputLog.prototype.finish = finish;
    ProcessOutputLog.prototype.close = close;
  }
});

test("a failed output append never publishes a false complete history after the process physically closes", async (t) => {
  const f = await fixture(t),
    append = ProcessOutputLog.prototype.append;
  const module = await import(
    new URL(
      `../dist/process/${process.platform === "win32" ? "windows-pipes" : "pipes"}.js`,
      import.meta.url,
    ).href
  );
  const Backend =
    process.platform === "win32"
      ? module.WindowsProcessBackend
      : module.PipeProcessBackend;
  const facts = Backend.prototype.facts;
  let observedBackend,
    sawKnownIncomplete = false;
  Backend.prototype.facts = function () {
    observedBackend = this;
    const actual = facts.call(this);
    if (actual.closed && this.failure !== undefined) {
      // Windows correctly retains incomplete output after a consumer rejection.
      // Exercise that same contract on every platform while using real OS I/O.
      sawKnownIncomplete = true;
      return { ...actual, outputComplete: false };
    }
    return actual;
  };
  ProcessOutputLog.prototype.append = async function () {
    throw new AgentError("output_write_failed", "injected append failure");
  };
  let row;
  try {
    const accepted = await f.start("return await sh.exec(context.input);", {
      input: command(
        'process.stdout.write("not-saved");setInterval(()=>{},1000);',
      ),
      waitMs: 0,
    });
    const result = await until(
      () => f.finish(accepted.run.runId),
      (value) => value.run.endedAt !== null,
      15000,
    );
    assert.equal(result.run.status, "failed");
    row = f.store.resourcesForRun(result.run.runId)[0];
    assert.ok(sawKnownIncomplete);
    await observedBackend.closed;
    assert.equal(facts.call(observedBackend).closed, true);
    assert.equal(facts.call(observedBackend).treeStopped, true);
    assert.notEqual(row.closedAt, null);
    assert.equal(row.diagnostic.details.outputComplete, false);
    assert.equal(row.diagnostic.details.failure.code, "output_write_failed");
  } finally {
    ProcessOutputLog.prototype.append = append;
    Backend.prototype.facts = facts;
  }
  assert.equal(data(await f.get(row.resourceId)).outputComplete, false);
});

test("unknown incomplete backend output remains unconfirmed despite native closure until an explicit retry has complete evidence", async (t) => {
  const f = await fixture(t);
  const module = await import(
    new URL(
      `../dist/process/${process.platform === "win32" ? "windows-pipes" : "pipes"}.js`,
      import.meta.url,
    ).href
  );
  const Backend =
    process.platform === "win32"
      ? module.WindowsProcessBackend
      : module.PipeProcessBackend;
  const facts = Backend.prototype.facts;
  let observedBackend, row, accepted;
  Backend.prototype.facts = function () {
    observedBackend = this;
    const actual = facts.call(this);
    return actual.closed ? { ...actual, outputComplete: false } : actual;
  };
  try {
    accepted = await f.start("return await sh.exec(context.input);", {
      input: command(
        'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("retained"));',
      ),
      waitMs: 0,
    });
    row = await until(
      () => f.store.resourcesForRun(accepted.run.runId)[0],
      (value) =>
        value?.diagnostic.details?.failure?.code ===
        "process_cleanup_unconfirmed",
    );
    await observedBackend.closed;
    assert.equal(facts.call(observedBackend).closed, true);
    assert.equal(facts.call(observedBackend).treeStopped, true);
    assert.equal(observedBackend.failure, undefined);
    assert.equal(row.closedAt, null);
    assert.equal(f.store.getRun(accepted.run.runId).endedAt, null);
  } finally {
    Backend.prototype.facts = facts;
  }
  const retry = data(
    await f.start(
      "return await sh.stop({processId:context.input,graceMs:20,forceMs:1000});",
      { input: row.resourceId },
    ),
  );
  assert.equal(retry.confirmed, true);
  assert.notEqual(f.store.getResource(row.resourceId).closedAt, null);
  assert.equal((await f.finish(accepted.run.runId)).run.status, "failed");
});

test("unconfirmed log handle close keeps the original resource pending and explicit retry can confirm it", async (t) => {
  const f = await fixture(t),
    finish = ProcessOutputLog.prototype.finish,
    close = ProcessOutputLog.prototype.close;
  ProcessOutputLog.prototype.finish = async function () {
    throw new AgentError("output_finish_failed", "injected finish failure");
  };
  ProcessOutputLog.prototype.close = async function () {
    throw new AgentError("output_close_failed", "injected close failure");
  };
  let started, row;
  try {
    started = await f.start("return await sh.exec(context.input);", {
      input: command('process.stdout.write("retained");'),
      waitMs: 0,
    });
    row = await until(
      () => f.store.resourcesForRun(started.run.runId)[0],
      (value) => value?.diagnostic.details?.failure,
    );
    await delay(70);
    assert.equal(f.store.getResource(row.resourceId).closedAt, null);
    assert.equal(f.store.getRun(started.run.runId).endedAt, null);
  } finally {
    ProcessOutputLog.prototype.finish = finish;
    ProcessOutputLog.prototype.close = close;
  }
  const retry = data(
    await f.start(
      "return await sh.stop({processId:context.input,graceMs:20,forceMs:1000});",
      { input: row.resourceId },
    ),
  );
  assert.equal(retry.confirmed, true);
  assert.notEqual(f.store.getResource(row.resourceId).closedAt, null);
  assert.equal((await f.finish(started.run.runId)).run.status, "failed");
});

test("cold managed disposal prevents any late preparation or process start", async () => {
  const managed = new ManagedProcess(
    tmpdir(),
    normalizeLaunch([command("throw Error('must not execute')")], "start"),
    "start",
  );
  await managed.dispose();
  await managed.closed;
  managed.bind({
    id: "res_" + "0".repeat(32),
    kind: "sh.process",
    value: managed,
    signal: new AbortController().signal,
    report() {},
  });
  let preparations = 0;
  await assert.rejects(
    () =>
      managed.start(async () => {
        preparations++;
        throw new Error("must not prepare");
      }),
    { code: "process_stopped" },
  );
  assert.equal(preparations, 0);
  const receipt = await managed.stop();
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.facts.closed, true);
  assert.equal(receipt.facts.treeStopped, true);
  assert.equal(receipt.facts.outputComplete, false);
});

test("an explicitly unconfirmed environment preparation cannot become a false closed process resource", async (t) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-sh-preparation-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const managed = new ManagedProcess(
    root,
    normalizeLaunch([command("")], "start"),
    "start",
  );
  let facts;
  managed.bind({
    id: "res_" + "1".repeat(32),
    kind: "sh.process",
    value: managed,
    signal: new AbortController().signal,
    report(value) {
      facts = value;
    },
  });
  await assert.rejects(
    () =>
      managed.start(async () => {
        throw new AgentError(
          "environment_cleanup_unconfirmed",
          "Probe group remains unknown.",
        );
      }),
    { code: "environment_cleanup_unconfirmed" },
  );
  const receipt = await managed.stop({ graceMs: 0, forceMs: 0 });
  assert.equal(receipt.confirmed, false);
  assert.equal(receipt.facts.closed, false);
  assert.equal(facts.preparationUnconfirmed, true);
  assert.equal(facts.outputComplete, false);
});

test("closed-stop fallback never swallows denied, source configuration or unknown policy failures", async () => {
  const extension = await shExtension({
    context: { paths: { logs: path.join(tmpdir(), "logs") } },
  });
  class SourceConfigError extends AgentError {}
  const failures = [
    new AgentError("forbidden", "Denied"),
    new SourceConfigError("resource_unavailable", "Broken source config"),
    new Error("Unknown policy error"),
  ];
  for (const failure of failures) {
    let descriptions = 0;
    await assert.rejects(
      () =>
        extension.methods.stop.handle(
          { processId: "res_" + "0".repeat(32) },
          {
            resources: {
              async get() {
                throw failure;
              },
              async describe() {
                descriptions++;
                throw Error("must not describe");
              },
            },
            signal: new AbortController().signal,
          },
        ),
      (cause) => cause === failure,
    );
    assert.equal(descriptions, 0);
  }
});

test("fast zero-output, stdout and nonzero execs are not mistaken for default EOF failures", async (t) => {
  const f = await fixture(t);
  const inputs = Array.from({ length: 3 }, () => [
    command(""),
    command('process.stdout.write("fast-output");'),
    command("process.exitCode=7;"),
  ]).flat();
  const accepted = await f.start(
    "return await Promise.all(context.input.map(input=>sh.exec(input)));",
    { input: inputs, waitMs: 0 },
  );
  const completed = await until(
    () => f.finish(accepted.run.runId),
    (value) => value.run.endedAt !== null,
    15000,
  );
  const results = data(completed);
  assert.equal(results.length, 9);
  for (let index = 0; index < results.length; index++) {
    assert.equal(results[index].exitCode, index % 3 === 2 ? 7 : 0);
    assert.equal(results[index].outputComplete, true);
    if (index % 3 === 1) assert.match(text(results[index]), /fast-output/);
  }
});

test("default empty EOF accepts confirmed input closure while explicit input and unknown I/O retain safe failures", async (t) => {
  const f = await fixture(t);
  const module = await import(
    new URL(
      `../dist/process/${process.platform === "win32" ? "windows-pipes" : "pipes"}.js`,
      import.meta.url,
    ).href
  );
  const Backend =
    process.platform === "win32"
      ? module.WindowsProcessBackend
      : module.PipeProcessBackend;
  const write = Backend.prototype.write,
    stop = Backend.prototype.stop,
    start = ManagedProcess.prototype.start;
  const unknownFailures = [];
  let mode = "closed",
    calls = 0,
    observed;
  ManagedProcess.prototype.start = async function (...args) {
    observed = this;
    return await start.apply(this, args);
  };
  Backend.prototype.write = async function (bytes, eof, signal) {
    signal.throwIfAborted();
    calls++;
    if (mode === "explicit")
      throw new AgentError(
        "process_input_closed",
        "Explicit input was not delivered.",
      );
    if (mode === "unknown") {
      const native = Object.assign(new Error("private native I/O failure"), {
        code: "EIO",
      });
      Object.defineProperty(native, Symbol("host-private"), {
        value: { callback() {} },
      });
      const failure = new AgentError(
        "process_input_failed",
        "The native input failed.",
        undefined,
        { cause: native },
      );
      unknownFailures.push(failure);
      throw failure;
    }
    await write.call(this, bytes, eof, signal);
    throw new AgentError(
      "process_input_failed",
      "EOF acknowledgement raced with close.",
      undefined,
      {
        cause:
          mode === "pipe"
            ? Object.assign(new Error("The pipe is already closed."), {
                code: "EPIPE",
              })
            : new AgentError(
                "process_stdin_closed",
                "The input is already closed.",
              ),
      },
    );
  };
  Backend.prototype.stop = async function (...args) {
    if (mode === "unknown") {
      // Windows graceful stop itself writes EOF. Reproduce that subsequent
      // cleanup failure on every platform without replacing the business error.
      await this.write(
        new Uint8Array(),
        true,
        new AbortController().signal,
      ).catch(() => {});
    }
    return await stop.apply(this, args);
  };
  try {
    const input = command(
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("closed-eof"));',
    );
    for (mode of ["closed", "pipe"]) {
      const result = data(
        await f.start("return await sh.exec(context.input);", { input }),
      );
      assert.match(text(result), /closed-eof/);
      assert.equal(result.outputComplete, true);
    }
    assert.ok(calls > 0);
    mode = "explicit";
    const explicit = data(
      await f.start(
        'try{await sh.exec(context.input);}catch(e){return {code:e.code,processId:e.details.processId,cause:Object.hasOwn(e,"cause")};}',
        { input: { ...input, input: "" } },
      ),
    );
    assert.equal(explicit.code, "process_input_closed");
    assert.match(explicit.processId, /^res_/);
    assert.equal(explicit.cause, false);
    assert.notEqual(f.store.getResource(explicit.processId).closedAt, null);
    mode = "unknown";
    const failure = data(
      await f.start(
        'try{await sh.exec(context.input);}catch(e){return {code:e.code,causeCode:e.details.causeCode,processId:e.details.processId,cause:Object.hasOwn(e,"cause")};}',
        { input },
      ),
    );
    assert.equal(failure.code, "process_input_failed");
    assert.equal(failure.causeCode, "EIO");
    assert.equal(failure.cause, false);
    assert.match(failure.processId, /^res_/);
    assert.ok(unknownFailures.length >= 2);
    assert.notEqual(unknownFailures[0], unknownFailures[1]);
    assert.equal(observed.failure, unknownFailures[0]);
    const originalCause = Object.getOwnPropertyDescriptor(
      unknownFailures[0],
      "cause",
    ).value;
    const privateSymbols = Object.getOwnPropertySymbols(originalCause);
    assert.equal(privateSymbols.length, 1);
    assert.equal(typeof originalCause[privateSymbols[0]].callback, "function");
    assert.notEqual(f.store.getResource(failure.processId).closedAt, null);
  } finally {
    Backend.prototype.write = write;
    Backend.prototype.stop = stop;
    ManagedProcess.prototype.start = start;
  }
});

test("exec waits for descendant-held output and paginated retained bytes preserve the real tail", async (t) => {
  const f = await fixture(t);
  const result = data(
    await f.start("return await sh.exec(context.input);", {
      input: command(
        'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",\'process.once("disconnect",()=>setTimeout(()=>{process.stdout.write("x".repeat(512*1024),()=>process.stderr.write("DESCENDANT-TAIL"));},150));process.send("ready");\'],{detached:process.platform==="win32",stdio:["ignore","inherit","inherit","ipc"]});child.once("message",message=>{if(message==="ready")process.stdout.write("ROOT-EXIT",()=>process.exit(0));});',
      ),
    }),
  );
  assert.equal(result.outputComplete, true);
  let output = [...result.output],
    cursor = result.nextCursor,
    more = result.hasMoreOutput;
  while (more) {
    const page = data(
      await f.get(result.processId, { cursor, maxBytes: 1024 * 1024 }),
    );
    output.push(...page.output);
    cursor = page.nextCursor;
    more = page.hasMoreOutput;
  }
  const stdout = output
    .filter((item) => item.stream === "stdout")
    .map((item) => item.data)
    .join("");
  const stderr = output
    .filter((item) => item.stream === "stderr")
    .map((item) => item.data)
    .join("");
  const expected = "ROOT-EXIT" + "x".repeat(512 * 1024);
  assert.equal(
    Buffer.byteLength(stdout),
    Buffer.byteLength(expected),
    "retained stdout byte length",
  );
  assert.equal(
    createHash("sha256").update(stdout).digest("hex"),
    createHash("sha256").update(expected).digest("hex"),
    "retained stdout byte hash",
  );
  assert.equal(stderr, "DESCENDANT-TAIL");
});

test("public signal reports delivery separately from actual managed closure", async (t) => {
  const f = await fixture(t);
  const processId = data(
    await f.start("return await sh.start(context.input);", {
      input: command("setInterval(()=>{},1000);", { background: true }),
    }),
  ).processId;
  if (process.platform === "win32") {
    const unsupported = data(
      await f.start(
        'try{await sh.signal({processId:context.input,signal:"SIGTERM"});}catch(e){return e.code;}',
        { input: processId },
      ),
    );
    assert.equal(unsupported, "process_signal_unsupported");
    assert.equal(data(await f.get(processId)).controlAvailable, true);
  }
  const requested = process.platform === "win32" ? "SIGKILL" : "SIGTERM";
  const receipt = data(
    await f.start("return await sh.signal(context.input);", {
      input: { processId, signal: requested },
    }),
  );
  assert.equal(receipt.requested, requested);
  assert.equal(receipt.delivered, true);
  const ended = await until(
    () => f.get(processId, { waitMs: 100 }),
    (result) => data(result).closedAt !== null,
  );
  assert.equal(data(ended).outputComplete, true);
});

test("real PTY supports terminal input/resize while pipe EOF is explicitly rejected", async (t) => {
  const f = await fixture(t);
  const input = command(
    'process.stdin.setRawMode(true);process.stdout.write(JSON.stringify({tty:process.stdin.isTTY,cols:process.stdout.columns,rows:process.stdout.rows})+"\\n");process.stdout.on("resize",()=>process.stdout.write("SIZE="+process.stdout.columns+"x"+process.stdout.rows+"\\n"));process.stdin.on("data",d=>{if(d.includes(113))process.exit(0);});',
    { tty: true, cols: 90, rows: 30, background: true },
  );
  const processId = data(
    await f.start("return await sh.start(context.input);", { input }),
  ).processId;
  const ready = await until(
    () => f.get(processId, { waitMs: 100 }),
    (result) => text(data(result)).includes('"tty":true'),
  );
  assert.ok(data(ready).output.every((item) => item.stream === "terminal"));
  assert.match(text(data(ready)), /"cols":90/);
  assert.match(text(data(ready)), /"rows":30/);
  assert.equal(
    data(
      await f.start(
        "return await sh.resize({processId:context.input,cols:100,rows:40});",
        { input: processId },
      ),
    ).accepted,
    true,
  );
  const resized = await until(
    () => f.get(processId, { waitMs: 100 }),
    (result) => text(data(result)).includes("SIZE=100x40"),
  );
  assert.match(text(data(resized)), /SIZE=100x40/);
  const eof = data(
    await f.start(
      "try{await sh.write({processId:context.input,eof:true});}catch(e){return e.code;}",
      { input: processId },
    ),
  );
  assert.match(eof, /eof|terminal|tty/i);
  data(
    await f.start(
      'return await sh.write({processId:context.input,data:"q"});',
      { input: processId },
    ),
  );
  const ended = await until(
    () => f.get(processId, { waitMs: 100 }),
    (result) => data(result).closedAt !== null,
  );
  assert.equal(data(ended).outputComplete, true);
});
