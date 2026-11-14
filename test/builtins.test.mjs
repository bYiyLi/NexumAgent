import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { StateServices } from "../dist/services/state.js";
import { runtimeExtension } from "../dist/sdk/runtime.js";
import { stateExtension } from "../dist/sdk/state.js";
import { outputExtension } from "../dist/sdk/output-extension.js";
import { outputIntent } from "../dist/sdk/output.js";
import { AgentError } from "../dist/contracts/errors.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = { principalId: "verified-user", clientId: "verified-client" };
const permissions = [
  "output",
  "runtime.input",
  "state.agent.read",
  "state.agent.write",
  "state.user.read",
  "state.user.write",
];
async function fixture(t, user) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-builtins-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "cloud-test",
  });
  const resources = new ResourceManager(store),
    states = new StateServices(store, user),
    policies = [];
  let allowed = true;
  const registry = new ExtensionRegistry(resources, {
    permissions: new Set(permissions),
    authorize(policy) {
      policies.push(policy);
      if (!allowed)
        throw new AgentError("forbidden", "Current access was revoked.");
    },
    log() {},
    progress() {},
    state: (scope) => states.bind(scope),
  });
  const handles = [];
  for (const [namespace, factory, declared] of [
    ["runtime", runtimeExtension, ["runtime.input"]],
    [
      "state",
      stateExtension,
      permissions.filter((p) => p.startsWith("state.")),
    ],
    ["output", outputExtension, ["output"]],
  ]) {
    const handle = await registry.prepare(
      {
        apiVersion: 1,
        origin: {
          type: "platform",
          owner: "nexum",
          namespace,
          version: "1",
          revision: namespace,
        },
        permissions: declared,
      },
      factory,
    );
    registry.publish(handle);
    handles.push(handle);
  }
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
          throw new AgentError("forbidden", "Wrong run owner.");
      },
      loadWork: () => ({
        project: null,
        agentShared: { snapshot: "old" },
        userShared: {},
      }),
      bindings: (services) => registry.bindings(services),
      resources,
      encodeResult: async (value) => ({
        content: [],
        ...(value === undefined
          ? {}
          : { data: JSON.parse(canonicalJson(value)) }),
      }),
    },
  );
  t.after(async () => {
    for (const handle of handles) await registry.disable(handle);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    registry,
    engine,
    policies,
    states,
    handles,
    start: (script, more = {}) =>
      engine.start(caller, {
        contextId: context.contextId,
        script,
        waitMs: 3000,
        ...more,
      }),
    revoke: () => {
      allowed = false;
    },
    restore: () => {
      allowed = true;
    },
  };
}

test("state SDK uses the public invocation service and keeps snapshots and returned data independent", async (t) => {
  const f = await fixture(t);
  let result = await f.start(
    `const first=await state.agent.set("count",{n:1},{expectedVersion:null});first.value.n=99;const current=await state.agent.get("count");return {current,snapshot:context.agent};`,
  );
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.result.data.current.value.n, 1);
  assert.deepEqual(result.result.data.snapshot, { snapshot: "old" });
  assert.equal(f.store.operationsForRun(result.run.runId).length, 2);
  assert(
    f.policies.some(
      (p) =>
        p.target?.type === "agent-state" &&
        p.target.value === "count" &&
        p.target.access === "write",
    ),
  );
  result = await f.start(
    `const old=await state.agent.get("count");await state.agent.delete("count",{expectedVersion:old.version});const gone=await state.agent.get("count");const current=await state.agent.set("count",null,{expectedVersion:null});let conflict;try{await state.agent.set("count",2,{expectedVersion:old.version});}catch(e){conflict=e.code;}return {gone,current,conflict};`,
  );
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.result.data.gone, null);
  assert.equal(result.result.data.current.version, 3);
  assert.equal(result.result.data.current.value, null);
  assert.equal(result.result.data.conflict, "state_version_conflict");
});

test("shared writes require explicit versions and concurrent stale writers cannot silently overwrite", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.start('await state.agent.set("race",0,{expectedVersion:null});'))
      .run.status,
    "succeeded",
  );
  const script =
    'try{return await state.agent.set("race",context.input,{expectedVersion:1});}catch(e){return {error:e.code};}';
  const results = await Promise.all([
    f.start(script, { input: 1 }),
    f.start(script, { input: 2 }),
  ]);
  assert.equal(results.filter((r) => r.result.data.version === 2).length, 1);
  assert.equal(
    results.filter((r) => r.result.data.error === "state_version_conflict")
      .length,
    1,
  );
  const bad = await f.start(
    'await state.agent.delete("race",{expectedVersion:null});',
  );
  assert.equal(bad.run.status, "failed");
  assert.equal(bad.run.error.code, "invalid_arguments");
  assert.equal(f.store.getState("race").version, 2);
});

test("user state receives verified identity and never substitutes local state when Cloud is unavailable", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    async get(identity, key, signal) {
      calls.push({ identity, key, signal });
      return { value: "remote", version: 31, updatedAt: 1 };
    },
    async set() {
      throw new AgentError(
        "cloud_unavailable",
        "The authority is unavailable.",
      );
    },
    async delete() {
      throw new Error("unexpected");
    },
  });
  f.store.setState("same", "local", null);
  let result = await f.start('return await state.user.get("same");', {
    input: { principalId: "fake" },
  });
  assert.equal(result.result.data.value, "remote");
  assert.deepEqual(calls[0].identity, {
    principalId: caller.principalId,
    clientId: caller.clientId,
    agentId: "agent",
    cloudEnvironment: "cloud-test",
  });
  result = await f.start(
    'try{await state.user.set("same",3,{expectedVersion:31});}catch(e){return e.code;}',
  );
  assert.equal(result.result.data, "cloud_unavailable");
  assert.equal(f.store.getState("same").value, "local");
  const offline = await fixture(t);
  result = await offline.start(
    'try{return await state.user.get("same");}catch(e){return e.code;}',
  );
  assert.equal(result.result.data, "user_state_unavailable");
});

test("external extensions receive the same state service while settled facades and private returns remain unusable", async (t) => {
  const f = await fixture(t);
  let saved;
  const handle = await f.registry.prepare(
    {
      apiVersion: 1,
      origin: {
        type: "extension",
        owner: "@test/shared",
        namespace: "shared",
        version: "1",
        revision: "one",
      },
      permissions: ["state.agent.read"],
    },
    () => ({
      methods: {
        read: {
          description: "使用公开服务",
          permissions: ["state.agent.read"],
          schemaDialect: "draft7",
          inputSchema: { type: "object" },
          handle: async (_input, call) => {
            saved = call.state;
            return await call.state.agent.get("k");
          },
        },
        leak: {
          description: "检查私有门面",
          permissions: [],
          schemaDialect: "draft7",
          inputSchema: { type: "object" },
          handle: (_input, call) => call.state.agent,
        },
        undeclared: {
          description: "只读方法不能借公共服务写入",
          permissions: ["state.agent.read"],
          schemaDialect: "draft7",
          inputSchema: { type: "object" },
          handle: (_input, call) =>
            call.state.agent.set("undeclared", 1, { expectedVersion: null }),
        },
      },
    }),
  );
  f.registry.publish(handle);
  f.handles.push(handle);
  f.store.setState("k", { ok: true }, null);
  assert.deepEqual(
    (await f.start("return await shared.read();")).result.data.value,
    { ok: true },
  );
  await assert.rejects(() => saved.agent.get("k"), {
    code: "invocation_closed",
  });
  const leaked = await f.start("return await shared.leak();");
  assert.equal(leaked.run.status, "failed");
  assert.equal(leaked.run.error.code, "invalid_sdk_result");
  const undeclared = await f.start("return await shared.undeclared();");
  assert.equal(undeclared.run.error.code, "undeclared_permission");
  assert.equal(f.store.getState("undeclared"), null);
  f.revoke();
  const denied = await f.start(
    'return await state.agent.set("no",1,{expectedVersion:null});',
  );
  f.restore();
  assert.equal(denied.run.status, "failed");
  assert.equal(f.store.getState("no"), null);
});

test("a value at the configured byte budget remains writable and readable with its revision envelope", async (t) => {
  const f = await fixture(t);
  const result = await f.start(
    'const value="x".repeat(65534);const saved=await state.agent.set("large",value,{expectedVersion:null});const read=await state.agent.get("large");return {length:read.value.length,version:saved.version};',
  );
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(result.result.data, { length: 65534, version: 1 });
});

test("runtime input is a registered operation resuming the same execution stack", async (t) => {
  const f = await fixture(t);
  const waiting = await f.start(
    'const local=7;const reply=await runtime.requestInput({message:"提供值",inputSchema:{type:"integer"}});return {sum:local+reply.input};',
    { waitMs: 3000 },
  );
  assert.equal(waiting.run.status, "waiting_input");
  assert.equal(waiting.operations.items[0].namespace, "runtime");
  const resumed = await f.engine.input(caller, {
    agentId: "agent",
    runId: waiting.run.runId,
    waitId: waiting.wait.waitId,
    input: 5,
    waitMs: 3000,
  });
  assert.equal(resumed.run.runId, waiting.run.runId);
  assert.equal(resumed.run.status, "succeeded");
  assert.equal(resumed.result.data.sum, 12);
});

test("output script helpers are registered operations using the same private intent constructors", async (t) => {
  const f = await fixture(t);
  const result = await f.start(
    'const text=output.text("ready");const image=output.image("not-read.png");const json=output.json([{type:"image",path:"business"}]);return {text:text.kind,image:image.kind,json:json.kind};',
  );
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(result.result.data, {
    text: "text",
    image: "image",
    json: "json",
  });
  assert.equal(f.store.operationsForRun(result.run.runId).length, 3);
  const bad = await f.start(
    'return output.text("x",{annotations:{priority:2}});',
  );
  assert.equal(bad.run.status, "failed");
  assert.equal(bad.run.error.code, "invalid_arguments");
  assert.equal(outputIntent({ kind: "image", value: "fake" }), null);
});
