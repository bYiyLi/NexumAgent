import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  setImmediate as tick,
  setTimeout as delay,
} from "node:timers/promises";
import { types } from "node:util";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = { principalId: "user", clientId: "client" };
const origin = {
  type: "extension",
  owner: "@test/calls",
  namespace: "calls",
  version: "1.0.0",
  revision: "one",
};
async function fixture(t, methods, extra = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-operations-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const scripts = new ScriptCatalog(work, "agent"),
    loader = await ModuleLoader.create(work, store.bootId, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    });
  const context = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: "work/snapshot.json",
  });
  let allowed = true,
    services,
    bound;
  const engine = new RunEngine(store, loader, scripts, {
    authorize(who, target) {
      if (
        !allowed ||
        who.principalId !== caller.principalId ||
        (target.run && target.run.callerKey !== callerKey(who))
      )
        throw Object.assign(new Error("forbidden"), { code: "forbidden" });
    },
    loadWork: () => ({ project: null }),
    encodeResult: async (value) => ({
      content: [],
      data: value === undefined ? null : JSON.parse(canonicalJson(value)),
    }),
    bindings(current) {
      services = current;
      const method =
        (name, handle) =>
        (...args) => {
          current.assertActive();
          return current.operation(origin, name, (id) => handle(id, ...args));
        };
      bound = methods(current, method);
      return { sdk: bound };
    },
    ...(typeof extra === "function"
      ? extra({ store, scripts, loader })
      : extra),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    engine,
    get services() {
      return services;
    },
    get bound() {
      return bound;
    },
    start: (input) =>
      engine.start(caller, { contextId: context.contextId, ...input }),
    finish: (id) => engine.observe(caller, id, 3000),
    revoke: () => {
      allowed = false;
    },
    restore: () => {
      allowed = true;
    },
  };
}

test("unawaited calls retain the run until actual settlement and register identity before invoking the handler", async (t) => {
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  let finished = false;
  const f = await fixture(t, (_s, method) => ({
    work: method("work", async (id, input) => {
      assert.equal(f.store.getOperation(id).status, "running");
      assert.equal(input, "synthetic-sensitive-input");
      entered.resolve(id);
      await gate.promise;
      finished = true;
      return 9;
    }),
  }));
  const started = await f.start({
    script: 'sdk.work("synthetic-sensitive-input");return 7;',
    waitMs: 0,
  });
  const id = await entered.promise;
  const live = await f.engine.observe(caller, started.run.runId, 0);
  assert.equal(live.run.status, "running");
  assert.equal(live.result, null);
  assert.equal(finished, false);
  assert.equal(live.operations.items[0].operationId, id);
  assert.throws(
    () =>
      f.store.transitionRun(started.run.runId, live.run.revision, "succeeded"),
    { code: "run_operations_pending" },
  );
  gate.resolve();
  const done = await f.finish(started.run.runId);
  assert.equal(done.run.status, "succeeded");
  assert.equal(done.result.data, 7);
  assert.equal(finished, true);
  const row = f.store.getOperation(id);
  assert.equal(row.status, "succeeded");
  assert.equal(row.endedAt !== null, true);
  assert.doesNotMatch(JSON.stringify(row), /synthetic-sensitive-input/);
});

test("synchronous calls and native binary values keep their actual identity without JSON conversion", async (t) => {
  const f = await fixture(t, (_s, method) => ({
    inspect: method("inspect", (id, bytes, typed) => {
      assert.equal(f.store.getOperation(id).status, "running");
      assert.equal(Buffer.isBuffer(bytes), true);
      assert.equal(types.isUint8Array(typed), true);
      assert.equal(bytes.toString(), "payload");
      return bytes;
    }),
  }));
  const done = await f.start({
    script:
      'const b=Buffer.from("payload");const n=new Uint8Array([1,2]);return sdk.inspect(b,n)===b;',
  });
  assert.equal(done.run.status, "succeeded");
  assert.equal(done.result.data, true);
  assert.equal(f.store.operationsForRun(done.run.runId).length, 1);
});

test("native thenables are assimilated by Promise while their deferred underlying work remains tracked", async (t) => {
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const f = await fixture(t, (_s, method) => ({
    lazy: method("lazy", () => ({
      then(resolve) {
        entered.resolve();
        void gate.promise.then(() => resolve(4));
      },
    })),
  }));
  const started = await f.start({ script: "sdk.lazy();return 3;", waitMs: 0 });
  await entered.promise;
  assert.equal(
    f.store.operationsForRun(started.run.runId)[0].status,
    "running",
  );
  assert.equal(
    (await f.engine.observe(caller, started.run.runId, 0)).run.status,
    "running",
  );
  gate.resolve();
  assert.equal((await f.finish(started.run.runId)).run.status, "succeeded");
});

test("cancellation cannot manufacture completion for an uncooperative operation", async (t) => {
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const f = await fixture(t, (_s, method) => ({
    wait: method("wait", async () => {
      entered.resolve();
      return await gate.promise;
    }),
  }));
  const started = await f.start({ script: "sdk.wait();return 2;", waitMs: 0 });
  await entered.promise;
  assert.equal(
    f.engine.cancel(caller, started.run.runId).run.status,
    "cancelling",
  );
  assert.equal(f.store.operationsForRun(started.run.runId)[0].endedAt, null);
  gate.resolve(5);
  const done = await f.finish(started.run.runId);
  assert.equal(done.run.status, "cancelled");
  assert.equal(done.operations.items[0].status, "succeeded");
});

test("existing operations can admit nested work after root return while the script's stale entry is closed", async (t) => {
  const entered = Promise.withResolvers(),
    parentGate = Promise.withResolvers(),
    childGate = Promise.withResolvers(),
    childStarted = Promise.withResolvers();
  const f = await fixture(t, (services, method) => ({
    parent: method("parent", async () => {
      entered.resolve();
      await parentGate.promise;
      services.operation(origin, "child", async () => {
        childStarted.resolve();
        await childGate.promise;
      });
      return 1;
    }),
    fresh: method("fresh", () => 1),
  }));
  const started = await f.start({
    script: "sdk.parent();return 3;",
    waitMs: 0,
  });
  await entered.promise;
  await tick();
  assert.throws(() => f.bound.fresh(), { code: "run_stopping" });
  parentGate.resolve();
  await childStarted.promise;
  await tick();
  const live = await f.engine.observe(caller, started.run.runId, 0);
  assert.equal(live.run.status, "running");
  assert.equal(live.operations.items.length, 2);
  childGate.resolve();
  const done = await f.finish(started.run.runId);
  assert.equal(done.run.status, "succeeded");
  assert.equal(
    done.operations.items.every((row) => row.endedAt !== null),
    true,
  );
  assert.throws(() => f.services.assertCurrent(), { code: "run_stopping" });
});

test("a later resource registration belongs to the original in-flight operation and is cleaned before terminal publication", async (t) => {
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  let manager,
    instance,
    resourceId,
    disposeCount = 0;
  const f = await fixture(
    t,
    (services, method) => ({
      later: method("later", async () => {
        entered.resolve();
        await gate.promise;
        const closed = Promise.withResolvers();
        const resource = await instance
          .bind({
            runId: services.runId,
            signal: services.signal,
            assertActive: services.assertCurrent,
            authorize: () => {},
          })
          .register({
            kind: "session",
            value: {
              closed: closed.promise,
              dispose() {
                disposeCount++;
                closed.resolve();
              },
            },
          });
        resourceId = resource.id;
        return resource.id;
      }),
    }),
    ({ store }) => {
      manager = new ResourceManager(store, { cleanupTimeoutMs: 100 });
      instance = manager.instance(origin, {
        signal: new AbortController().signal,
        assertActive: () => {},
        authorize: () => {},
      });
      return { resources: manager };
    },
  );
  const started = await f.start({ script: "sdk.later();return 3;", waitMs: 0 });
  await entered.promise;
  await tick();
  gate.resolve();
  const done = await f.finish(started.run.runId);
  assert.equal(resourceId !== undefined, true);
  assert.equal(done.run.cleanup.closed, 1);
  assert.equal(disposeCount, 1);
  assert.equal(done.run.status, "succeeded");
});

test("an operation settlement write failure preserves the unknown run and operation rather than publishing success", async (t) => {
  const f = await fixture(t, (_s, method) => ({
    work: method("work", () => 1),
  }));
  f.store.finishOperation = () => {
    throw new Error("database failure");
  };
  const started = await f.start({ script: "return sdk.work();", waitMs: 0 });
  await assert.rejects(() => f.finish(started.run.runId), {
    code: "run_persistence_failed",
  });
  assert.equal(f.store.getRun(started.run.runId).endedAt, null);
  assert.equal(f.store.operationsForRun(started.run.runId)[0].endedAt, null);
});

test("caught, ignored, propagated and detached SDK rejections follow native Promise handling in an isolated runtime", () => {
  const entry = new URL("../dist/", import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
import {SqliteStore} from '${entry}storage/sqlite.js';
import {ModuleLoader} from '${entry}runtime/modules.js';
import {ScriptCatalog} from '${entry}runtime/scripts.js';
import {RunEngine,callerKey} from '${entry}runtime/engine.js';
const caller={principalId:'user',clientId:'client'};
const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'nexum-rejections-'))),work=path.join(root,'work');
mkdirSync(work);writeFileSync(path.join(work,'package.json'),'{}');
const store=new SqliteStore(root,{agentId:'agent',profile:'development',cloudEnvironment:'test'});
try {
 const loader=await ModuleLoader.create(work,store.bootId,{builtins:()=>[],approvedPackages:()=>new Map()});
 const scripts=new ScriptCatalog(work,'agent');
 const context=store.openWork({callerKey:callerKey(caller),pwd:work,snapshotRef:'work/snapshot.json'});
 const engine=new RunEngine(store,loader,scripts,{authorize(){},loadWork:()=>({project:null}),encodeResult:async value=>({content:[],data:value}),
 prepareAttachments(_refs,_directory,s){const promise=Promise.resolve().then(()=>{throw new Error('precreated-prepare-error');});s.operation(${JSON.stringify(origin)},'prepare',()=>promise);return Promise.resolve([]);},
 bindings(s){return {sdk:{fail(){s.assertActive();return s.operation(${JSON.stringify(origin)},'fail',()=>Promise.reject(new Error('synthetic-sensitive-error')));}}};}});
 const results=[];
 for(const [name,code] of [
 ['caught','try{await sdk.fail()}catch{}return 7;'],
 ['ignored','sdk.fail();return 7;'],
 ['propagated','sdk.fail().then(()=>{});return 7;'],
 ['detached','(async()=>{await sdk.fail()})();return 7;'],
 ['late-caught','const p=sdk.fail();await new Promise(r=>setTimeout(r,5));p.catch(()=>{});return 7;']]) {
   const result=await engine.start(caller,{contextId:context.contextId,script:code,waitMs:3000});
   results.push({name,status:result.run.status,code:result.run.error?.code??null,operations:result.operations.items.map(op=>({status:op.status,error:op.error}))});
 }
 const prepared=await engine.start(caller,{contextId:context.contextId,script:'throw new Error("must-not-execute")',attachments:[{transferId:'transfer-test'}],waitMs:3000});
 assert.equal(prepared.run.status,'failed');assert.equal(prepared.run.error.code,'unhandled_async_error');assert.equal(prepared.run.startedAt,null);
 console.log(JSON.stringify(results));
}finally{store.close();rmSync(root,{recursive:true,force:true});}
`;
  const child = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--input-type=module"],
    { input: script, encoding: "utf8", timeout: 20000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout.trim());
  assert.deepEqual(
    results.map((row) => [row.name, row.status]),
    [
      ["caught", "succeeded"],
      ["ignored", "failed"],
      ["propagated", "failed"],
      ["detached", "failed"],
      ["late-caught", "succeeded"],
    ],
  );
  assert.equal(
    results
      .filter((row) => row.status === "failed")
      .every((row) => row.code === "unhandled_async_error"),
    true,
  );
  assert.equal(
    results.every((row) => row.operations[0].status === "failed"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(results), /synthetic-sensitive-error/);
});

test("monitoring guest promises does not swallow an unrelated host rejection", () => {
  const entry = new URL("../dist/runtime/promises.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module"], {
    input: `import {NativePromiseAudit} from ${JSON.stringify(entry)};new NativePromiseAudit();Promise.reject(new Error('unowned-host-fault'));await new Promise(r=>setTimeout(r,20));`,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /unowned-host-fault/);
});

test("late console writes from tracked handlers cannot hide a log persistence failure", async (t) => {
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const f = await fixture(t, (_services, method) => ({
    later: method("later", async (_id, log) => {
      entered.resolve();
      await gate.promise;
      log();
    }),
  }));
  const started = await f.start({
    script: 'sdk.later(()=>console.log("late"));return 7;',
    waitMs: 0,
  });
  await entered.promise;
  await tick();
  const filename = path.join(f.root, f.store.getRun(started.run.runId).logsRef);
  unlinkSync(filename);
  mkdirSync(filename);
  gate.resolve();
  const done = await f.finish(started.run.runId);
  assert.equal(done.run.status, "failed");
  assert.equal(done.run.error.code, "run_log_failed");
});

test("SDK schema compilation preserves dialect, private references and native parameters", async () => {
  const { compileMethodSchema } =
    await import("../dist/contracts/validation.js");
  const seven = compileMethodSchema(
    {
      type: "array",
      minItems: 1,
      items: [{ const: 1 }],
      additionalItems: false,
    },
    "draft7",
  );
  const modern = compileMethodSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "array",
    minItems: 1,
    prefixItems: [{ const: 2 }],
    items: false,
  });
  seven([1]);
  modern([2]);
  assert.throws(() => seven([2]), { code: "invalid_arguments" });
  assert.throws(() => modern([1]), { code: "invalid_arguments" });
  for (const [schema, dialect] of [
    [{}, undefined],
    [{ $schema: "https://unknown.invalid/schema" }, "draft7"],
    [{ $schema: "https://json-schema.org/draft/2020-12/schema" }, "draft7"],
  ])
    assert.throws(() => compileMethodSchema(schema, dialect), {
      code: "unsupported_schema_dialect",
    });
  const left = compileMethodSchema({ $ref: "urn:nexum:test:input" }, "draft7", [
    { $id: "urn:nexum:test:input", const: "left" },
  ]);
  const right = compileMethodSchema(
    { $ref: "urn:nexum:test:input" },
    "draft7",
    [{ $id: "urn:nexum:test:input", const: "right" }],
  );
  left("left");
  right("right");
  assert.throws(() => left("right"), { code: "invalid_arguments" });
  assert.throws(
    () =>
      compileMethodSchema(
        { $ref: "https://unavailable.invalid/input" },
        "draft7",
      ),
    { code: "invalid_sdk_schema" },
  );
  const validate = compileMethodSchema(
    {
      type: "object",
      properties: { data: { type: "object" } },
      required: ["data"],
      additionalProperties: false,
    },
    "draft7",
  );
  const binary = Buffer.from([1, 2]);
  binary.toJSON = () => {
    throw new Error("unexpected serialization");
  };
  validate({ data: binary });
});
