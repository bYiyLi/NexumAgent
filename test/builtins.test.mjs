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
import { FixtureStore } from "./helpers/runtime-fixture.mjs";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { ExecutionFixture, callerKey } from "./helpers/runtime-fixture.mjs";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { StateFixture } from "./helpers/runtime-fixture.mjs";
import { AgentError } from "../dist/contracts/errors.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = { principalId: "verified-user", clientId: "verified-client" };
const permissions = [
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
    work = root;
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const store = new FixtureStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "cloud-test",
  });
  const resources = new ResourceManager(store),
    states = new StateFixture(store, user),
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
  const loader = await ModuleLoader.create(work, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const context = store.openWork({
    callerKey: callerKey(caller),
    pwd: work,
    snapshotRef: "snapshot.json",
  });
  const engine = new ExecutionFixture(
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

test("a native timer keeps cancelling until the JavaScript Promise really settles", async (t) => {
  const f = await fixture(t);
  const initial = await f.start(
    'await new Promise(resolve => setTimeout(resolve, 8000));return "must-not-complete";',
    { waitMs: 0, timeoutMs: 15000 },
  );
  let current;
  const startupDeadline = Date.now() + 6000;
  while (Date.now() < startupDeadline) {
    current = await f.engine.observe(caller, initial.run.runId, 150);
    if (current.run.status === "running") break;
    assert.equal(current.run.endedAt, null,
      "the original Run must reach running before it can be cancelled");
  }
  assert.equal(current?.run.status, "running",
    "wait for the actual Worker state, not a fixed number of Host event-loop ticks");
  const stopped = f.engine.cancel(caller, initial.run.runId);
  assert.equal(stopped.accepted, true);
  assert.equal(stopped.run.status, "cancelling");
  current = await f.engine.observe(caller, initial.run.runId, 0);
  assert.equal(current.run.status, "cancelling");
  const finished = await f.engine.observe(caller, initial.run.runId, 2000);
  assert.equal(finished.run.status, "cancelled");
  assert.equal(finished.result, null);
  assert.equal(finished.run.error.code, "run_cancelled");
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
    'return await shared.read();',
  );
  f.restore();
  assert.equal(denied.run.status, "failed");
  assert.deepEqual(f.store.getState("k").value, { ok: true });
});

test("ordinary script returns work without the removed output namespace", async (t) => {
  const f = await fixture(t);
  const result = await f.start('return { text: "ready", list: [1, 2, 3] };');
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(result.result.data, {
    text: "ready",
    list: [1, 2, 3],
  });
  assert.equal(f.store.operationsForRun(result.run.runId).length, 0);
  const bad = await f.start('return output.text("unused");');
  assert.equal(bad.run.status, "failed");
  assert.equal(bad.run.error.code, "script_execution_failed");
});
