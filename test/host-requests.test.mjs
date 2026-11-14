import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindHostRequests } from "../dist/extensions/host-requests.js";
import { AgentError } from "../dist/contracts/errors.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";

function provider(overrides = {}) {
  return {
    capabilities: { sampling: {}, elicitation: { form: {} } },
    assertCurrent() {},
    async sampling() {
      return {
        role: "assistant",
        content: { type: "text", text: "actual response" },
      };
    },
    async elicitation() {
      return { action: "decline" };
    },
    async roots() {
      return { roots: [] };
    },
    ...overrides,
  };
}
function binding(overrides = {}) {
  return {
    context: { caller: { principalId: "one", clientId: "host-one" } },
    runId: "run-one",
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
    assertCurrent() {},
    ...overrides,
  };
}

test("Host data and capability snapshots cannot be changed while an actual request is pending", async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let received;
  const source = provider({
    async sampling(params) {
      received = params;
      entered.resolve();
      return release.promise;
    },
  });
  const service = bindHostRequests(source, binding());
  source.capabilities.elicitation.form.extra = true;
  assert.deepEqual(service.capabilities.elicitation, { form: {} });
  assert(Object.isFrozen(service.capabilities.elicitation.form));
  const params = {
    messages: [{ role: "user", content: { type: "text", text: "original" } }],
  };
  const pending = service.sampling(params);
  await entered.promise;
  params.messages[0].content.text = "changed later";
  assert.equal(received.messages[0].content.text, "original");
  const result = {
    role: "assistant",
    content: { type: "text", text: "fixed result" },
  };
  release.resolve(result);
  const returned = await pending;
  result.content.text = "changed by provider";
  assert.equal(returned.content.text, "fixed result");
});

test("request cancellation reaches actual Host I/O without stopping another request or faking settlement", async () => {
  const requestStop = new AbortController(),
    runStop = new AbortController();
  const entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  let actualSignal,
    settled = false;
  const service = bindHostRequests(
    provider({
      async sampling(_params, options) {
        actualSignal = options.signal;
        entered.resolve();
        return finish.promise;
      },
    }),
    binding({ signal: runStop.signal }),
  );
  const pending = service.sampling(
    { messages: [] },
    { signal: requestStop.signal },
  );
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  requestStop.abort(new Error("this request only"));
  assert.equal(actualSignal.aborted, true);
  assert.equal(runStop.signal.aborted, false);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(await service.roots(), { roots: [] });
  finish.resolve({ role: "assistant" });
  await assert.rejects(pending, /this request only/);
});

test("current source and caller authority are checked after an asynchronous Host response", async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let allowed = true,
    calls = 0;
  const service = bindHostRequests(
    provider({
      assertCurrent() {
        if (!allowed)
          throw new AgentError("forbidden", "Host session revoked.");
      },
      async elicitation() {
        calls++;
        entered.resolve();
        return release.promise;
      },
    }),
    binding(),
  );
  const pending = service.elicitation({ message: "confirm" });
  await entered.promise;
  allowed = false;
  release.resolve({ action: "accept", content: { answer: true } });
  await assert.rejects(pending, { code: "forbidden" });
  await assert.rejects(service.elicitation({ message: "again" }), {
    code: "forbidden",
  });
  assert.equal(calls, 1);
  for (const assertCurrent of [() => true, async () => {}])
    assert.throws(
      () => bindHostRequests(provider(), binding({ assertCurrent })),
      { code: "authorization_configuration" },
    );
});

test("Registry binds each public Host service to its own Run and prevents returning its control facade", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-host-service-"));
  const work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "isolated-host-service",
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bound = [],
    resources = new ResourceManager(store);
  const registry = new ExtensionRegistry(resources, {
    permissions: new Set(),
    authorize() {},
    log() {},
    progress() {},
    hostRequests(scope) {
      bound.push(scope);
      return provider({
        async sampling() {
          return { runId: scope.runId, caller: scope.context.caller };
        },
      });
    },
  });
  const handle = await registry.prepare(
    {
      apiVersion: 1,
      permissions: [],
      origin: {
        type: "extension",
        owner: "host-test",
        namespace: "hostTest",
        version: "1",
        revision: "one",
      },
    },
    () => ({
      methods: {
        sample: {
          description: "Actual bound request",
          permissions: [],
          schemaDialect: "draft7",
          inputSchema: { type: "object" },
          handle: (input, call) => call.hostRequests.sampling(input),
        },
        escape: {
          description: "Reject control result",
          permissions: [],
          schemaDialect: "draft7",
          inputSchema: { type: "object" },
          handle: (_input, call) => call.hostRequests,
        },
      },
    }),
  );
  registry.publish(handle);
  const modules = await ModuleLoader.create(work, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const engine = new RunEngine(
    store,
    modules,
    new ScriptCatalog(work, "agent"),
    {
      resources,
      authorize() {},
      loadWork: () => ({ project: null }),
      bindings: (services) => registry.bindings(services),
      encodeResult: async (data) => ({ content: [], data }),
    },
  );
  for (const suffix of ["one", "two"]) {
    const caller = {
      principalId: "owner",
      clientId: `host-${suffix}`,
      grantId: `grant-${suffix}`,
    };
    const context = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "work/snapshot.json",
    });
    const view = await engine.start(caller, {
      contextId: context.contextId,
      script: "return await hostTest.sample({messages:[]});",
      waitMs: 3000,
    });
    assert.equal(view.run.status, "succeeded");
    assert.equal(view.result.data.runId, view.run.runId);
    assert.equal(view.result.data.caller.clientId, caller.clientId);
    assert.equal(bound.at(-1).runId, view.run.runId);
    const escaped = await engine.start(caller, {
      contextId: context.contextId,
      script: "return await hostTest.escape({});",
      waitMs: 3000,
    });
    assert.equal(escaped.run.status, "failed");
    assert.equal(escaped.run.error.code, "invalid_sdk_result");
  }
  await registry.disable(handle);
});
