import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = { principalId: "user", clientId: "client", host: "test-host" };
const source = (revision = "old") => ({
  apiVersion: 1,
  origin: {
    type: "extension",
    owner: "@test/demo",
    namespace: "demo",
    version: "1",
    revision,
  },
  permissions: [],
});
const method = (handle) => ({
  description: "replacement fixture",
  permissions: [],
  schemaDialect: "draft7",
  inputSchema: { type: "object" },
  handle,
});
const factory = (value) => () => ({ methods: { ping: method(() => value) } });

async function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-replacement-")),
  );
  const workDir = path.join(root, "work");
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(workDir, "snapshot.json"), '{"project":null}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 20 });
  const registry = new ExtensionRegistry(resources, {
    cleanupTimeoutMs: 25,
    permissions: new Set(),
    authorize() {},
    log() {},
    progress() {},
  });
  const loader = await ModuleLoader.create(workDir, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const work = store.openWork({
    callerKey: callerKey(caller),
    pwd: workDir,
    snapshotRef: "work/snapshot.json",
  });
  const engine = new RunEngine(
    store,
    loader,
    new ScriptCatalog(workDir, "agent", () => []),
    {
      authorize() {},
      loadWork: (item) =>
        JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
      encodeResult: async (value) => ({
        content: [],
        data: JSON.parse(canonicalJson(value)),
      }),
      bindings: (services) => registry.bindings(services),
      resources,
    },
  );
  t.after(async () => {
    await resources.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    registry,
    resources,
    store,
    start: (script) =>
      engine.start(caller, { contextId: work.contextId, script, waitMs: 0 }),
    finish: (id) => engine.observe(caller, id, 3000),
    async ping() {
      const run = await engine.start(caller, {
        contextId: work.contextId,
        script: "return demo.ping();",
      });
      assert.equal(run.run.status, "succeeded");
      return run.result.data;
    },
  };
}

test("hidden same-version successor preserves old calls and shared heartbeat, then joins actual old closure before atomic publish", async (t) => {
  const f = await fixture(t);
  const preparing = Promise.withResolvers(),
    prepared = Promise.withResolvers(),
    closed = Promise.withResolvers();
  let oldHost,
    newHost,
    disposed = 0,
    initialized = 0,
    ticks = 0,
    heartbeatFailure,
    interval;
  const old = await f.registry.prepare(source(), async (host) => {
    oldHost = host;
    interval = setInterval(() => {
      try {
        host.authorize({
          type: "connection",
          value: "fixture",
          access: "heartbeat",
        });
        ticks++;
      } catch (error) {
        heartbeatFailure = error;
      }
    }, 1);
    await host.resources.register({
      kind: "fixture.shared",
      value: {
        closed: closed.promise,
        dispose() {
          disposed++;
          clearInterval(interval);
        },
      },
    });
    return { methods: { ping: method(() => "old") } };
  });
  t.after(() => {
    clearInterval(interval);
    closed.resolve();
  });
  f.registry.publish(old);
  const nextFactory = async (host) => {
    initialized++;
    newHost = host;
    preparing.resolve();
    await prepared.promise;
    return { methods: { ping: method(() => "new") } };
  };
  const first = f.registry.prepareReplacement(old, source("new"), nextFactory);
  const duplicate = f.registry.prepareReplacement(
    old,
    source("new"),
    nextFactory,
  );
  assert.equal(first, duplicate);
  await preparing.promise;
  assert.equal(await f.ping(), "old");
  const releaseScript = f.registry.lease(source().origin);
  releaseScript();
  await delay(10);
  assert.ok(ticks > 0);
  assert.equal(heartbeatFailure, undefined);
  assert.equal(oldHost.signal.aborted, false);
  assert.equal(disposed, 0);
  assert.equal(initialized, 1);
  prepared.resolve();
  const token = await first;
  assert.equal(Object.isFrozen(token), true);
  assert.equal(token.previous, old);
  assert.throws(() => f.registry.publish(token.candidate), {
    code: "extension_replacement_required",
  });
  assert.throws(() => f.registry.publishReplacement(token), {
    code: "extension_replacement_not_retired",
  });
  let index = "old";
  const retiring = f.registry.retireReplacement(token);
  assert.equal(retiring, f.registry.retireReplacement(token));
  assert.equal(oldHost.signal.aborted, true);
  assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
  assert.equal(newHost.signal.aborted, false);
  const pending = await retiring;
  assert.equal(pending.status, "stopping");
  assert.equal(disposed, 1);
  assert.equal(index, "old");
  assert.throws(() => f.registry.publishReplacement(token), {
    code: "extension_replacement_not_retired",
  });
  closed.resolve();
  await delay(0);
  assert.equal((await f.registry.retireReplacement(token)).status, "disabled");
  assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
  f.registry.publishReplacement(token, () => {
    assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
    index = "new";
  });
  assert.equal(index, "new");
  assert.equal(await f.ping(), "new");
  assert.throws(
    () =>
      oldHost.authorize({
        type: "connection",
        value: "fixture",
        access: "heartbeat",
      }),
    { code: "extension_unavailable" },
  );
  f.registry.publishReplacement(token, () => {
    throw new Error("must not replay commit");
  });
  assert.equal(initialized, 1);
  await f.registry.disable(token.candidate);
});

test("in-flight calls and script leases reject cutover synchronously without withdrawing the old version", async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  let oldHost;
  const old = await f.registry.prepare(source(), (host) => {
    oldHost = host;
    return {
      methods: {
        ping: method(() => "old"),
        hold: method(async () => {
          entered.resolve();
          await finish.promise;
          return "finished";
        }),
      },
    };
  });
  t.after(() => finish.resolve());
  f.registry.publish(old);
  const token = await f.registry.prepareReplacement(
    old,
    source("new"),
    factory("new"),
  );
  const running = await f.start("return demo.hold();");
  await entered.promise;
  assert.throws(() => f.registry.retireReplacement(token), {
    code: "extension_busy",
  });
  assert.equal(oldHost.signal.aborted, false);
  assert.equal(await f.ping(), "old");
  finish.resolve();
  assert.equal((await f.finish(running.run.runId)).run.status, "succeeded");
  const release = f.registry.lease(source().origin);
  assert.throws(() => f.registry.retireReplacement(token), {
    code: "extension_busy",
  });
  assert.equal(await f.ping(), "old");
  release();
  assert.equal((await f.registry.retireReplacement(token)).status, "disabled");
  f.registry.publishReplacement(token);
  assert.equal(await f.ping(), "new");
  await f.registry.disable(token.candidate);
});

test("candidate initialization failure cleans only its own resource and leaves old source callable", async (t) => {
  const f = await fixture(t),
    closed = Promise.withResolvers();
  let disposed = 0,
    oldDisposed = 0;
  const old = await f.registry.prepare(source(), () => ({
    methods: { ping: method(() => "old") },
    dispose() {
      oldDisposed++;
    },
  }));
  f.registry.publish(old);
  await assert.rejects(
    f.registry.prepareReplacement(old, source("invalid"), async (host) => {
      await host.resources.register({
        kind: "fixture.candidate",
        value: {
          closed: closed.promise,
          dispose() {
            disposed++;
            closed.resolve();
          },
        },
      });
      return { methods: { invalid: { description: "incomplete" } } };
    }),
    { code: "extension_initialization_failed" },
  );
  assert.equal(disposed, 1);
  assert.equal(oldDisposed, 0);
  assert.equal(await f.ping(), "old");
  const token = await f.registry.prepareReplacement(
    old,
    source("valid"),
    factory("new"),
  );
  await f.registry.disable(token.candidate);
  assert.equal(await f.ping(), "old");
  await f.registry.disable(old);
});

test("unconfirmed failed candidate retains its own reservation until explicit real cleanup without stopping the old source", async (t) => {
  const f = await fixture(t),
    closed = Promise.withResolvers();
  t.after(() => closed.resolve());
  const old = await f.registry.prepare(source(), factory("old"));
  f.registry.publish(old);
  let failure;
  const invalidSource = source("invalid-pending");
  await assert.rejects(
    f.registry.prepareReplacement(old, invalidSource, async (host) => {
      await host.resources.register({
        kind: "fixture.pending",
        value: {
          closed: closed.promise,
          dispose() {},
        },
      });
      return { methods: { invalid: { description: "incomplete" } } };
    }),
    (error) => {
      failure = error;
      return (
        error.code === "extension_initialization_failed" &&
        error.details.cleanup.status === "stopping"
      );
    },
  );
  const failed = f.registry.preparationFailure(failure, invalidSource);
  assert.ok(failed);
  assert.equal(await f.ping(), "old");
  const release = f.registry.lease(source().origin);
  release();
  assert.throws(
    () =>
      f.registry.prepareReplacement(old, source("another"), factory("blocked")),
    { code: "extension_busy" },
  );
  assert.equal((await f.registry.disable(failed)).status, "stopping");
  closed.resolve();
  await delay(0);
  assert.equal((await f.registry.disable(failed)).status, "disabled");
  const token = await f.registry.prepareReplacement(
    old,
    source("valid"),
    factory("new"),
  );
  await f.registry.disable(token.candidate);
  assert.equal(await f.ping(), "old");
  await f.registry.disable(old);
});

test("replacement requires exact source/root and authentic handles and tokens", async (t) => {
  const f = await fixture(t);
  const old = await f.registry.prepare(source(), factory("old"));
  f.registry.publish(old);
  for (const changed of [
    {
      ...source("next"),
      origin: { ...source("next").origin, owner: "@other/demo" },
    },
    {
      ...source("next"),
      origin: { ...source("next").origin, namespace: "other" },
    },
  ])
    assert.throws(
      () => f.registry.prepareReplacement(old, changed, factory("bad")),
      { code: "extension_replacement_mismatch" },
    );
  assert.throws(
    () =>
      f.registry.prepareReplacement({ ...old }, source("next"), factory("bad")),
    { code: "extension_unavailable" },
  );
  assert.throws(
    () => f.registry.retireReplacement({ previous: old, candidate: old }),
    { code: "extension_replacement_unavailable" },
  );
  assert.throws(
    () => f.registry.publishReplacement({ previous: old, candidate: old }),
    { code: "extension_replacement_unavailable" },
  );
  const platform = {
    apiVersion: 1,
    origin: {
      ...source().origin,
      type: "platform",
      owner: "nexum",
      namespace: "mcp",
    },
    bindingPath: ["mcp", "github"],
    permissions: [],
  };
  const remote = await f.registry.prepare(platform, factory("remote"));
  f.registry.publish(remote);
  assert.throws(
    () =>
      f.registry.prepareReplacement(
        remote,
        { ...platform, bindingPath: ["mcp", "other"] },
        factory("bad"),
      ),
    { code: "extension_replacement_mismatch" },
  );
  assert.equal(await f.ping(), "old");
  await f.registry.disable(remote);
  await f.registry.disable(old);
});

test("old dispose rejection remains stopping, then explicit retry permits publication without reinitialization", async (t) => {
  const f = await fixture(t);
  let attempts = 0,
    initialized = 0;
  const old = await f.registry.prepare(source(), () => ({
    methods: { ping: method(() => "old") },
    dispose() {
      if (++attempts === 1) throw new Error("native shutdown failed");
    },
  }));
  f.registry.publish(old);
  const token = await f.registry.prepareReplacement(old, source("new"), () => {
    initialized++;
    return { methods: { ping: method(() => "new") } };
  });
  const stopping = await f.registry.retireReplacement(token);
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.disposeFailed, true);
  assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
  assert.throws(() => f.registry.publish(old), {
    code: "extension_unavailable",
  });
  assert.throws(() => f.registry.publishReplacement(token), {
    code: "extension_replacement_not_retired",
  });
  assert.equal((await f.registry.retireReplacement(token)).status, "disabled");
  assert.equal(attempts, 2);
  f.registry.publishReplacement(token);
  assert.equal(await f.ping(), "new");
  assert.equal(initialized, 1);
  await f.registry.disable(token.candidate);
});

test("abandoning a hidden candidate releases only its reservation and invalidates its old token", async (t) => {
  const f = await fixture(t);
  const old = await f.registry.prepare(source(), factory("old"));
  f.registry.publish(old);
  const abandoned = await f.registry.prepareReplacement(
    old,
    source("abandoned"),
    factory("bad"),
  );
  assert.equal(
    (await f.registry.disable(abandoned.candidate)).status,
    "disabled",
  );
  assert.equal(await f.ping(), "old");
  assert.throws(() => f.registry.retireReplacement(abandoned), {
    code: "extension_unavailable",
  });
  const next = await f.registry.prepareReplacement(
    old,
    source("good"),
    factory("new"),
  );
  assert.equal((await f.registry.retireReplacement(next)).status, "disabled");
  assert.throws(() => f.registry.publishReplacement(abandoned), {
    code: "extension_unavailable",
  });
  f.registry.publishReplacement(next);
  assert.equal(await f.ping(), "new");
  await f.registry.disable(next.candidate);
});

test("failed synchronous contribution commit keeps candidate hidden for explicit retry after old retirement", async (t) => {
  const f = await fixture(t);
  const old = await f.registry.prepare(source(), factory("old"));
  f.registry.publish(old);
  const token = await f.registry.prepareReplacement(
    old,
    source("new"),
    factory("new"),
  );
  await f.registry.retireReplacement(token);
  assert.throws(() => f.registry.publishReplacement(token, async () => {}), {
    code: "extension_publication_configuration",
  });
  assert.throws(
    () =>
      f.registry.publishReplacement(token, () => {
        throw new Error("index commit failed");
      }),
    /index commit failed/,
  );
  assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
  assert.throws(() => f.registry.publish(token.candidate), {
    code: "extension_replacement_required",
  });
  let committed = false;
  f.registry.publishReplacement(token, () => {
    committed = true;
  });
  assert.equal(committed, true);
  assert.equal(await f.ping(), "new");
  await f.registry.disable(token.candidate);
});
