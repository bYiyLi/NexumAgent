import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dist = new URL(
  process.env.NEXUM_STORAGE_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { SqliteStore },
  { ResourceManager },
  { ExtensionRegistry },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { ArtifactStore },
  { ProfileRetention },
  { AgentError },
  { canonicalJson },
  { PipeProcessBackend },
  { WindowsProcessBackend },
] = await Promise.all(
  [
    "storage/sqlite.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "runtime/modules.js",
    "runtime/scripts.js",
    "runtime/engine.js",
    "results/artifacts.js",
    "runtime/retention.js",
    "contracts/errors.js",
    "contracts/json.js",
    "process/pipes.js",
    "process/windows-pipes.js",
  ].map((file) => import(new URL(file, dist))),
);
const caller = {
  principalId: "user",
  clientId: "storage-test",
  grantId: "grant-live",
};
const deferred = () => Promise.withResolvers();
const method = (handle, permissions = ["storage.reserve"]) => ({
  description: "Exercise the public managed storage reservation port",
  permissions,
  schemaDialect: "draft7",
  inputSchema: { type: "object" },
  handle,
});
async function until(predicate, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  assert.fail(message);
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-storage-port-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(work, "snapshot.json"), '{"project":null}');
  const store = new SqliteStore(root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    }),
    resources = new ResourceManager(store, { cleanupTimeoutMs: 20 }),
    artifacts = new ArtifactStore(root, "agent");
  const retention = new ProfileRetention(store, artifacts, {
    maxManagedBytes: 16 * 1024 * 1024,
    controlHeadroomBytes: 0,
    intervalMs: 60000,
  });
  await retention.open();
  let sourceAllowed = true,
    providerGate,
    providerCalls = 0;
  const grants = new Set([caller.grantId]),
    policies = [],
    rawTickets = [],
    handles = [],
    runs = [];
  const provider = {
    async reserve(bytes) {
      providerCalls++;
      const ticket = await retention.reserve(bytes);
      rawTickets.push(ticket);
      if (providerGate) await providerGate.promise;
      return ticket;
    },
  };
  const source = {
    apiVersion: 1,
    origin: {
      type: "extension",
      owner: "@test/storage",
      namespace: "quota",
      version: "1",
      revision: "storage-one",
    },
    permissions: options.sourcePermissions ?? ["storage.reserve", "read"],
  };
  const registry = new ExtensionRegistry(resources, {
    cleanupTimeoutMs: 20,
    permissions: new Set(["storage.reserve", "read"]),
    ...(options.available === false ? {} : { storage: provider }),
    authorize(policy) {
      policies.push(policy);
      if (["invoke", "resource"].includes(policy.action)) {
        if (policy.context) {
          if (!grants.has(policy.context.caller.grantId))
            throw new AgentError(
              "forbidden",
              "The original current Grant is revoked.",
            );
        } else if (!sourceAllowed)
          throw new AgentError(
            "forbidden",
            "The source storage authority is revoked.",
          );
      }
    },
    log() {},
    progress() {},
  });
  const modules = await ModuleLoader.create(work, store.bootId, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    }),
    scripts = new ScriptCatalog(work, "agent", () => []),
    workView = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "work/snapshot.json",
    });
  const engine = new RunEngine(store, modules, scripts, {
    authorize(who, target) {
      if (target.run && target.run.callerKey !== callerKey(who))
        throw new AgentError("forbidden", "Wrong actual run owner.");
    },
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    encodeResult: async (value) => ({
      content: [],
      ...(value === undefined
        ? {}
        : { data: JSON.parse(canonicalJson(value)) }),
    }),
    bindings: (services) => registry.bindings(services),
    resources,
  });
  t.after(async () => {
    providerGate?.resolve();
    for (const id of runs) {
      if (!store.getRun(id).endedAt) {
        engine.cancel(caller, id);
        await engine.observe(caller, id, 1000).catch(() => {});
      }
    }
    for (const handle of handles) {
      try {
        await registry.disable(handle);
      } catch {}
    }
    await resources.shutdown();
    await retention.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    registry,
    retention,
    provider,
    rawTickets,
    policies,
    get providerCalls() {
      return providerCalls;
    },
    setGate(value) {
      providerGate = value;
    },
    revokeGrant() {
      grants.delete(caller.grantId);
    },
    revokeSource() {
      sourceAllowed = false;
    },
    grant() {
      grants.add(caller.grantId);
      sourceAllowed = true;
    },
    async publish(factory) {
      let handle;
      try {
        handle = await registry.prepare(source, factory);
      } catch (error) {
        const failure = registry.preparationFailure(error);
        if (failure) handles.push(failure);
        throw error;
      }
      handles.push(handle);
      registry.publish(handle);
      return handle;
    },
    async start(script, input = {}) {
      const result = await engine.start(caller, {
        contextId: workView.contextId,
        script,
        input,
        waitMs: 100,
      });
      runs.push(result.run.runId);
      return result;
    },
    async finish(view) {
      let result = view;
      while (
        !["succeeded", "failed", "cancelled", "interrupted"].includes(
          result.run.status,
        )
      )
        result = await engine.observe(caller, result.run.runId, 1000);
      return result;
    },
    cancel: (runId) => engine.cancel(caller, runId),
  };
}
function value(view) {
  assert.equal(view.run.status, "succeeded", JSON.stringify(view.run.error));
  return view.result.data;
}

test("host and invocation share the actual profile budget while release remains one-shot after the call ends or authority is revoked", async (t) => {
  const f = await fixture(t);
  let hostTicket, callTicket, oldCall, host;
  const handle = await f.publish(async (value) => {
    host = value;
    hostTicket = await host.storage.reserve(100);
    return {
      methods: {
        hold: method(async (_input, call) => {
          oldCall = call;
          callTicket = await call.storage.reserve(200);
          return { reserved: 300 };
        }),
      },
    };
  });
  assert.equal(f.retention.reservedBytes, 100);
  assert.equal(Object.isFrozen(host.storage), true);
  const result = await f.finish(await f.start("return await quota.hold({});"));
  assert.deepEqual(value(result), { reserved: 300 });
  assert.equal(f.retention.reservedBytes, 300);
  f.revokeGrant();
  f.revokeSource();
  assert.doesNotThrow(() => {
    callTicket.release();
    callTicket.release();
  });
  assert.equal(f.retention.reservedBytes, 100);
  await assert.rejects(
    oldCall.storage.reserve(1),
    (error) => error.code === "invocation_closed",
  );
  assert.equal(f.providerCalls, 2);
  await assert.rejects(
    host.storage.reserve(1),
    (error) => error.code === "forbidden",
  );
  assert.equal(f.providerCalls, 2);
  assert.doesNotThrow(() => {
    hostTicket.release();
    hostTicket.release();
  });
  assert.equal(f.retention.reservedBytes, 0);
  await f.registry.disable(handle);
  assert.equal(f.retention.reservedBytes, 0);
});

test("declaration, positive integer validation and unavailable provider reject before touching the underlying budget", async (t) => {
  for (const mode of ["source", "method", "unavailable", "bytes"])
    await t.test(mode, async (t) => {
      const f = await fixture(t, {
        ...(mode === "source" ? { sourcePermissions: ["read"] } : {}),
        ...(mode === "unavailable" ? { available: false } : {}),
      });
      let host;
      await f.publish((value) => {
        host = value;
        return {
          methods: {
            reserve: method(
              async (input, call) => {
                const ticket = await (
                  mode === "source" ? host.storage : call.storage
                ).reserve(input.bytes);
                ticket.release();
                return { ok: true };
              },
              mode === "source" || mode === "method"
                ? ["read"]
                : ["storage.reserve"],
            ),
          },
        };
      });
      const inputs =
        mode === "bytes"
          ? [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null]
          : [1];
      for (const bytes of inputs) {
        const view = await f.finish(
          await f.start(
            "try{return await quota.reserve(context.input);}catch(error){return {code:error.code};}",
            { bytes },
          ),
        );
        assert.equal(
          value(view).code,
          mode === "source" || mode === "method"
            ? "undeclared_permission"
            : mode === "unavailable"
              ? "storage_unavailable"
              : "invalid_storage_reservation",
        );
      }
      assert.equal(f.providerCalls, 0);
      assert.equal(f.retention.reservedBytes, 0);
    });
});

test("authority revoked during a real reservation await refunds the acquired Core ticket without exposing it", async (t) => {
  const f = await fixture(t),
    hold = deferred();
  f.setGate(hold);
  await f.publish(() => ({
    methods: {
      reserve: method(async (_input, call) => {
        const ticket = await call.storage.reserve(400);
        ticket.release();
        return { unexpected: true };
      }),
    },
  }));
  const pending = await f.start(
    "try{return await quota.reserve({});}catch(error){return {code:error.code};}",
  );
  await until(
    () => f.rawTickets.length === 1,
    "The real profile reservation must be acquired before revocation",
  );
  assert.equal(f.retention.reservedBytes, 400);
  f.revokeGrant();
  hold.resolve();
  const finished = await f.finish(pending);
  assert.equal(value(finished).code, "forbidden");
  assert.equal(f.retention.reservedBytes, 0);
  assert.equal(f.providerCalls, 1);
});

test("call cancellation waits for its actual pending reservation to return and refunds it after the signal check", async (t) => {
  const f = await fixture(t),
    hold = deferred();
  f.setGate(hold);
  await f.publish(() => ({
    methods: {
      reserve: method(async (_input, call) => {
        const ticket = await call.storage.reserve(500);
        ticket.release();
        return { unexpected: true };
      }),
    },
  }));
  const pending = await f.start("return await quota.reserve({});");
  await until(
    () => f.rawTickets.length === 1,
    "The actual budget must be held by the pending operation",
  );
  f.cancel(pending.run.runId);
  assert.equal(f.retention.reservedBytes, 500);
  hold.resolve();
  const finished = await f.finish(pending);
  assert.equal(finished.run.status, "cancelled");
  assert.equal(f.retention.reservedBytes, 0);
});

test("reservation tickets, release methods, facade services and the Core provider cannot escape through SDK results or diagnostics", async (t) => {
  const f = await fixture(t);
  let ticket, service;
  await f.publish(async (host) => {
    service = host.storage;
    ticket = await service.reserve(600);
    return {
      methods: {
        leak: method((input) => {
          const values = {
            ticket,
            release: ticket.release,
            service,
            core: f.provider,
            raw: f.rawTickets[0],
            rawRelease: f.rawTickets[0].release,
          };
          if (input.error) throw { hidden: values[input.kind] };
          return { hidden: values[input.kind] };
        }),
      },
    };
  });
  for (const kind of [
    "ticket",
    "release",
    "service",
    "core",
    "raw",
    "rawRelease",
  ])
    for (const error of [false, true]) {
      const result = await f.finish(
        await f.start("return await quota.leak(context.input);", {
          kind,
          error,
        }),
      );
      assert.equal(result.run.status, "failed");
      assert.ok(
        ["invalid_sdk_result", "invalid_sdk_error"].includes(
          result.run.error.code,
        ),
        JSON.stringify(result.run.error),
      );
    }
  assert.equal(f.retention.reservedBytes, 600);
  ticket.release();
  assert.equal(f.retention.reservedBytes, 0);
});

test("owner fallback retains its reservation until a real native resource has closed", async (t) => {
  const f = await fixture(t),
    stop = deferred();
  let backend,
    ready = false;
  const preparing = f.publish(async (host) => {
    backend =
      process.platform === "win32"
        ? new WindowsProcessBackend({
            onOutput(_stream, bytes) {
              if (Buffer.from(bytes).toString().includes("ready")) ready = true;
            },
          })
        : new PipeProcessBackend({
            onOutput(_stream, bytes) {
              if (Buffer.from(bytes).toString().includes("ready")) ready = true;
            },
          });
    await host.resources.register({
      kind: "storage-native",
      value: {
        closed: backend.closed,
        async dispose() {
          await stop.promise;
          await backend.dispose();
        },
      },
    });
    await host.storage.reserve(700);
    await backend.start({
      file: process.execPath,
      args: ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      cwd: f.work,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          ["SYSTEMROOT", "COMSPEC", "TEMP", "TMP"].includes(key.toUpperCase()),
        ),
      ),
      tty: false,
    });
    return { methods: { check: method(() => ({ ok: true })) } };
  });
  try {
    const handle = await preparing;
    await until(() => ready, "The fixture must start its real native process");
    const first = await f.registry.disable(handle);
    assert.equal(first.status, "stopping");
    assert.equal(backend.facts().closed, false);
    assert.equal(f.retention.reservedBytes, 700);
    stop.resolve();
    await backend.closed;
    const done = await f.registry.disable(handle);
    assert.equal(done.status, "disabled");
    assert.equal(f.retention.reservedBytes, 0);
    assert.equal(backend.facts().closed, true);
  } finally {
    stop.resolve();
    await backend?.dispose();
  }
});

test("the public reservation uses the existing real quota and cannot allocate beyond it", async (t) => {
  const f = await fixture(t);
  await f.publish(() => ({
    methods: {
      reserve: method(async (_input, call) => {
        const ticket = await call.storage.reserve(20 * 1024 * 1024);
        ticket.release();
        return { unexpected: true };
      }),
    },
  }));
  const result = await f.finish(
    await f.start(
      "try{return await quota.reserve({});}catch(error){return {code:error.code};}",
    ),
  );
  assert.equal(value(result).code, "storage_quota_exceeded");
  assert.equal(f.retention.reservedBytes, 0);
});

test("failed initialization cannot confirm closure while its real reservation is still pending, and its late ticket is refunded", async (t) => {
  const f = await fixture(t),
    hold = deferred();
  f.setGate(hold);
  let pending;
  let failure;
  try {
    await f.publish((host) => {
      pending = host.storage.reserve(800);
      void pending.catch(() => {});
      throw new AgentError(
        "fixture_failed",
        "Fail initialization while its reservation is pending.",
      );
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "extension_initialization_failed");
  assert.equal(failure.details.cleanup.status, "stopping");
  await until(
    () => f.rawTickets.length === 1,
    "The pending Core reservation must eventually be physically admitted",
  );
  assert.equal(f.retention.reservedBytes, 800);
  hold.resolve();
  await assert.rejects(pending);
  await until(
    () => f.retention.reservedBytes === 0,
    "The stopped source must refund its late reservation ticket",
  );
  const handle = f.registry.preparationFailure(failure);
  assert.ok(handle);
  assert.equal((await f.registry.disable(handle)).status, "disabled");
});
