import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
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
import { ResourceManager } from "../dist/extensions/resources.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { AgentError } from "../dist/contracts/errors.js";
import { canonicalJson } from "../dist/contracts/json.js";

const caller = { principalId: "user", clientId: "client", host: "test-host" };
const origin = {
  type: "extension",
  owner: "@test/demo",
  namespace: "demo",
  version: "1",
  revision: "bundle-one",
};
const source = {
  apiVersion: 1,
  origin,
  permissions: ["read", "write"],
  config: { endpoint: "approved" },
};
const method = (handle, extra = {}) => ({
  description: "测试方法",
  permissions: ["read"],
  schemaDialect: "draft7",
  inputSchema: { type: "object" },
  handle,
  ...extra,
});
function control(closeOnDispose = true) {
  const closed = Promise.withResolvers();
  let stops = 0;
  const value = {
    closed: closed.promise,
    dispose() {
      stops++;
      if (closeOnDispose) closed.resolve();
    },
  };
  return { value, closed, stops: () => stops };
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-registry-")),
  );
  const workDir = path.join(root, "work");
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, "package.json"), '{"type":"module"}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 20 });
  const policies = [],
    logs = [],
    progress = [];
  let allowed = true;
  const registry = new ExtensionRegistry(resources, {
    cleanupTimeoutMs: 25,
    permissions: new Set(["read", "write"]),
    authorize(policy) {
      policies.push(policy);
      if (!allowed && ["invoke", "publish", "resource"].includes(policy.action))
        throw new AgentError("forbidden", "Current permission was revoked.");
      options.authorize?.(policy);
    },
    log(...args) {
      logs.push(args);
    },
    progress(...args) {
      progress.push(args);
    },
  });
  const scripts = new ScriptCatalog(
    workDir,
    "agent",
    options.sources ?? (() => []),
  );
  const loader = await ModuleLoader.create(workDir, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const snapshot = path.join(workDir, "snapshot.json");
  writeFileSync(snapshot, '{"project":null}');
  const work = store.openWork({
    callerKey: callerKey(caller),
    pwd: workDir,
    snapshotRef: "work/snapshot.json",
  });
  const bindings = [];
  const engine = new RunEngine(store, loader, scripts, {
    authorize(who, target) {
      if (target.run && target.run.callerKey !== callerKey(who))
        throw new AgentError("forbidden", "Wrong caller.");
    },
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    // The registry boundary is tested here with ordinary JSON; these tests do
    // not substitute for the separately owned MCP media encoder acceptance.
    encodeResult: async (value) =>
      value === undefined
        ? { content: [] }
        : { content: [], data: JSON.parse(canonicalJson(value)) },
    bindings(services) {
      const value = registry.bindings(services);
      bindings.push(value);
      return { ...value, ...options.bindings?.(services) };
    },
    resources,
    leaseScript: (item) =>
      item.type === "local" ? () => {} : registry.lease(item),
    ...(options.prepareAttachments
      ? { prepareAttachments: options.prepareAttachments }
      : {}),
  });
  t.after(async () => {
    await delay(40);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workDir,
    store,
    resources,
    registry,
    engine,
    scripts,
    work,
    policies,
    logs,
    progress,
    bindings,
    start: (input) =>
      engine.start(caller, { contextId: work.contextId, ...input }),
    finish: (id) => engine.observe(caller, id, 3000),
    revoke: () => {
      allowed = false;
    },
    grant: () => {
      allowed = true;
    },
  };
}

test("concurrent prepare initializes once, keeps host scope private and publishes only when ready", async (t) => {
  const f = await fixture(t),
    gate = Promise.withResolvers();
  let initialized = 0,
    host;
  const factory = async (value) => {
    initialized++;
    host = value;
    await gate.promise;
    return {
      methods: {
        echo: method((input, call) => ({
          input,
          caller: call.context.caller,
          operationId: call.operationId,
        })),
      },
    };
  };
  const first = f.registry.prepare(source, factory),
    second = f.registry.prepare(source, factory);
  assert.equal(first, second);
  await delay(0);
  assert.equal(initialized, 1);
  assert.deepEqual(Object.keys(host.context).sort(), [
    "agentId",
    "paths",
    "profile",
  ]);
  assert.equal(host.context.caller, undefined);
  assert.equal(host.context.runId, undefined);
  assert.equal(host.config.endpoint, "approved");
  assert.equal(Object.isFrozen(host.context.paths), true);
  assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
  gate.resolve();
  const handle = await first;
  assert.equal(handle.methods[0].name, "echo");
  assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
  f.revoke();
  assert.throws(() => f.registry.publish(handle), { code: "forbidden" });
  f.grant();
  f.registry.publish(handle);
  const result = await f.start({ script: "return demo.echo({ value: 4 });" });
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.result.data.input.value, 4);
  assert.deepEqual(result.result.data.caller, caller);
  assert.equal(
    f.store.operationsForRun(result.run.runId)[0].operationId,
    result.result.data.operationId,
  );
  assert.equal((await f.registry.disable(handle)).status, "disabled");
});

test("normalization, schema and method authority precede handler; metadata is an immutable snapshot", async (t) => {
  let calls = 0,
    denied = false,
    f;
  f = await fixture(t, {
    authorize(policy) {
      if (denied && policy.action === "invoke")
        throw new AgentError("forbidden", "Denied method.");
    },
  });
  const schema = {
    type: "object",
    required: ["n"],
    additionalProperties: false,
    properties: { n: { type: "integer" } },
  };
  const permissions = ["read"];
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      add: method(
        (input, call) => {
          calls++;
          assert.equal(
            f.store.operationsForRun(call.context.runId)[0].status,
            "running",
          );
          call.authorize({ type: "path", value: f.workDir, access: "read" });
          call.log({ level: "info", message: "handler" });
          call.progress({ done: 1 });
          return { n: input.n + 1 };
        },
        {
          permissions,
          inputSchema: schema,
          outputSchema: schema,
          normalize: (args) =>
            typeof args[0] === "number" && args.length === 1
              ? { n: args[0] }
              : args[0],
        },
      ),
    },
  }));
  schema.properties.n.type = "string";
  permissions.push("write");
  f.registry.publish(handle);
  const invalid = await f.start({
    script: 'try { demo.add({n:"bad"}); } catch (e) { return e.code; }',
  });
  assert.equal(invalid.result.data, "invalid_arguments");
  assert.equal(calls, 0);
  assert.equal(f.store.operationsForRun(invalid.run.runId).length, 0);
  denied = true;
  const forbidden = await f.start({
    script: "try { demo.add(2); } catch(e) { return e.code; }",
  });
  assert.equal(forbidden.result.data, "forbidden");
  assert.equal(calls, 0);
  denied = false;
  const ok = await f.start({ script: "return demo.add(2);" });
  assert.equal(ok.run.status, "succeeded");
  assert.equal(ok.result.data.n, 3);
  assert.equal(calls, 1);
  assert.deepEqual(handle.methods[0].permissions, ["read"]);
  assert.equal(f.logs[0][2], ok.run.runId);
  assert.equal(f.progress[0][1], ok.run.runId);
  assert.ok(f.policies.some((policy) => policy.target?.value === f.workDir));
  await f.registry.disable(handle);
});

test("native inputs remain native, schemas retain dialect/ref ownership, and names use ordinary JS property access", async (t) => {
  const buffer = Buffer.from([1, 2]);
  let got;
  const f = await fixture(t, { bindings: () => ({ bytes: buffer }) });
  const common = {
    $id: "urn:demo:value",
    type: "object",
    required: ["value"],
    properties: { value: { type: "integer" } },
    additionalProperties: false,
  };
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      bytes: method(
        (input) => {
          got = input;
          return Buffer.isBuffer(input);
        },
        { inputSchema: true },
      ),
      "search-code": method((input) => input, {
        schemaDialect: "2020-12",
        schemas: [common],
        inputSchema: { $ref: "urn:demo:value" },
      }),
      Search: method(() => "uppercase"),
      search: method(() => "lowercase"),
      nested: method(() => "nested", { path: ["group", "query"] }),
    },
  }));
  common.properties.value.type = "string";
  f.registry.publish(handle);
  const result = await f.start({
    script:
      'return [demo.bytes(bytes), demo["search-code"]({value:2}), demo.Search(), demo.search(), demo.group.query()];',
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal(got, buffer);
  assert.deepEqual(result.result.data, [
    true,
    { value: 2 },
    "uppercase",
    "lowercase",
    "nested",
  ]);
  await f.registry.disable(handle);
});

test("managed native operations stay occupied after the root returns and stale call facades close on actual settlement", async (t) => {
  const f = await fixture(t),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let saved;
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      slow: method(async (_input, call) => {
        saved = call;
        entered.resolve();
        await gate.promise;
        call.log({ level: "info", message: "still current" });
        return { done: true };
      }),
    },
  }));
  f.registry.publish(handle);
  const accepted = await f.start({
    script: "demo.slow(); return 7;",
    waitMs: 0,
  });
  await entered.promise;
  assert.throws(() => f.registry.disable(handle), { code: "extension_busy" });
  assert.equal(
    (await f.engine.observe(caller, accepted.run.runId, 5)).run.endedAt,
    null,
  );
  gate.resolve();
  const result = await f.finish(accepted.run.runId);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.result.data, 7);
  assert.equal(
    f.store.operationsForRun(result.run.runId)[0].status,
    "succeeded",
  );
  assert.throws(() => saved.log({ level: "info", message: "old" }), {
    code: "invocation_closed",
  });
  assert.throws(() => saved.output.text("old"), { code: "invocation_closed" });
  await assert.rejects(() => saved.resources.get("unknown"), {
    code: "invocation_closed",
  });
  assert.equal((await f.registry.disable(handle)).status, "disabled");
});

test("a caught native rejection remains a failed operation without failing the root", async (t) => {
  const f = await fixture(t);
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      fail: method(async () => {
        await delay(5);
        throw new Error("business failure");
      }),
    },
  }));
  f.registry.publish(handle);
  const result = await f.start({
    script: "try { await demo.fail(); } catch {} return 1;",
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal(f.store.operationsForRun(result.run.runId)[0].status, "failed");
  await f.registry.disable(handle);
});

test("output schemas validate business data while media and explicit business errors retain their meaning", async (t) => {
  const f = await fixture(t);
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      result: method(
        ({ kind }, call) => {
          if (kind === "image") return call.output.image("a.png");
          if (kind === "array") return [{ type: "image", path: "a.png" }];
          if (kind === "content")
            return call.output.result({ content: [call.output.text("hi")] });
          if (kind === "error") return call.output.error("business failure");
          if (kind === "json") return call.output.json({ n: 2 });
          if (kind === "structured")
            return call.output.result({
              content: [],
              structuredContent: { n: 2 },
            });
          if (kind === "malformed") return { type: "image", bad: true };
          return { n: "wrong" };
        },
        {
          outputSchema: {
            type: "object",
            required: ["n"],
            properties: { n: { type: "integer" } },
          },
        },
      ),
    },
  }));
  f.registry.publish(handle);
  const result = await f.start({
    script:
      'const kinds=["image","array","content","error","json","structured"];const values=kinds.map(kind=>demo.result({kind}));let invalid,malformed;try{demo.result({kind:"bad"});}catch(e){invalid=e.code;}try{demo.result({kind:"malformed"});}catch(e){malformed=e.code;}return {kinds:values.map(value=>value.kind ?? value[0].type),invalid,malformed};',
  });
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(result.result.data.kinds, [
    "image",
    "image",
    "result",
    "result",
    "json",
    "result",
  ]);
  assert.equal(result.result.data.invalid, "invalid_arguments");
  assert.equal(result.result.data.malformed, "invalid_output_source");
  await f.registry.disable(handle);
});

test("private controls cannot escape as success values, hidden properties, getters, classes or errors", async (t) => {
  const f = await fixture(t),
    managed = control();
  let host, call, resource;
  const handle = await f.registry.prepare(source, (value) => {
    host = value;
    return {
      methods: {
        leak: method(async ({ kind }, invocation) => {
          call = invocation;
          if (!resource)
            resource = await host.resources.register({
              kind: "shared",
              value: managed.value,
            });
          if (kind === "host") return host;
          if (kind === "call") return { nested: [call] };
          if (kind === "ref") return resource;
          if (kind === "raw") return managed.value;
          if (kind === "map") return new Map([["x", managed.value]]);
          if (kind === "set") return new Set([call]);
          if (kind === "hidden")
            return Object.defineProperty({}, "hidden", { value: call });
          if (kind === "symbol") return { [Symbol("control")]: resource };
          if (kind === "getter")
            return {
              get value() {
                throw new Error("getter must not execute");
              },
            };
          if (kind === "class")
            return new (class Box {
              value = resource;
            })();
          if (kind === "arrayPrototype") return Object.setPrototypeOf([], call);
          if (kind === "datePrototype")
            return Object.setPrototypeOf(new Date(), host);
          if (kind === "hiddenPrototype")
            return Object.setPrototypeOf([], { hidden: resource });
          if (kind === "cause")
            throw new Error("failed", { cause: { nested: managed.value } });
          throw call;
        }),
        sync: method(() => {
          throw host;
        }),
        normalize: method(() => 0, {
          normalize() {
            throw host;
          },
        }),
        native: method(() => [
          new Date(),
          /a/,
          new Map([["a", 1]]),
          new Set([1]),
          new URL("https://example.com"),
          new Error("business"),
          new Blob(["a"]),
          Buffer.from([1]),
          new Uint8Array([2]),
        ]),
      },
    };
  });
  f.registry.publish(handle);
  const result = await f.start({
    script:
      'const errors=[];for(const kind of ["host","call","ref","raw","map","set","hidden","symbol","getter","class","arrayPrototype","datePrototype","hiddenPrototype","cause","throw"]){try{await demo.leak({kind});errors.push("escaped");}catch(e){errors.push(e.code);}}for(const name of ["sync","normalize"]){try{demo[name]();errors.push("escaped");}catch(e){errors.push(e.code);}}const native=demo.native();return {errors,nativeCount:native.length};',
  });
  assert.equal(result.run.status, "succeeded");
  assert.deepEqual(
    result.result.data.errors,
    Array(17).fill("invalid_sdk_result"),
  );
  assert.equal(result.result.data.nativeCount, 9);
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.equal(managed.stops(), 1);
});

test("resource registration protects a raw controller before its first asynchronous yield", async (t) => {
  const f = await fixture(t),
    managed = control();
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      leak: method((_input, call) => {
        void call.resources.register({ kind: "session", value: managed.value });
        return managed.value;
      }),
    },
  }));
  f.registry.publish(handle);
  const result = await f.start({
    script: "try{demo.leak();}catch(e){return e.code;}",
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.result.data, "invalid_sdk_result");
  assert.equal(f.store.resourcesForRun(result.run.runId)[0].status, "closed");
  await f.registry.disable(handle);
});

test("factory and invalid method failures clean instance resources even before publication", async (t) => {
  const f = await fixture(t),
    first = control(),
    second = control();
  let disposals = 0;
  await assert.rejects(
    () =>
      f.registry.prepare(source, async (host) => {
        await host.resources.register({
          kind: "connection",
          value: first.value,
        });
        throw new Error("before returning an instance");
      }),
    (error) =>
      error.code === "extension_initialization_failed" &&
      error.details.cleanup.status === "disabled",
  );
  assert.equal(first.stops(), 1);
  await assert.rejects(
    () =>
      f.registry.prepare(source, async (host) => {
        await host.resources.register({
          kind: "connection",
          value: second.value,
        });
        return {
          methods: { invalid: { handle() {} } },
          dispose() {
            disposals++;
          },
        };
      }),
    { code: "extension_initialization_failed" },
  );
  assert.equal(disposals, 1);
  assert.equal(second.stops(), 1);
  const handle = await f.registry.prepare(source, () => ({ methods: {} }));
  await f.registry.disable(handle);
});

test("failed initialization keeps its namespace reserved and explicit retry resumes old cleanup before reinitializing", async (t) => {
  const f = await fixture(t),
    managed = control(false);
  let initializes = 0;
  const factory = async (host) => {
    initializes++;
    if (initializes === 1) {
      await host.resources.register({
        kind: "connection",
        value: managed.value,
      });
      throw new Error("initial failure");
    }
    return { methods: {} };
  };
  await assert.rejects(
    () => f.registry.prepare(source, factory),
    (error) =>
      error.code === "extension_initialization_failed" &&
      error.details.cleanup.status === "stopping",
  );
  assert.throws(
    () =>
      f.registry.prepare(
        { ...source, origin: { ...origin, version: "2" } },
        factory,
      ),
    { code: "namespace_conflict" },
  );
  const first = f.registry.prepare(source, factory),
    second = f.registry.prepare(source, factory);
  assert.equal(first, second);
  await assert.rejects(() => first, { code: "extension_cleanup_pending" });
  assert.equal(initializes, 1);
  managed.closed.resolve();
  await delay(0);
  const handle = await f.registry.prepare(source, factory);
  assert.equal(initializes, 2);
  assert.equal((await f.registry.disable(handle)).status, "disabled");
});

test("disable is bounded, shares pending disposal, fences old facades and allows explicit retries", async (t) => {
  const f = await fixture(t),
    gate = Promise.withResolvers();
  let disposals = 0,
    host;
  const factory = (value) => {
    host = value;
    return {
      methods: { ping: method(() => "pong") },
      dispose() {
        disposals++;
        return gate.promise;
      },
    };
  };
  const handle = await f.registry.prepare(source, factory);
  f.registry.publish(handle);
  const first = f.registry.disable(handle),
    second = f.registry.disable(handle);
  assert.equal(first, second);
  assert.equal(host.signal.aborted, true);
  const report = await first;
  assert.equal(report.status, "stopping");
  assert.equal(report.disposePending, true);
  assert.equal(disposals, 1);
  assert.equal(Object.hasOwn(f.registry.bindings({}), "demo"), false);
  await assert.rejects(
    () => host.resources.register({ kind: "x", value: control().value }),
    { code: "extension_unavailable" },
  );
  assert.throws(() => f.registry.prepare(source, factory), {
    code: "namespace_conflict",
  });
  assert.equal((await f.registry.disable(handle)).status, "stopping");
  assert.equal(disposals, 1);
  gate.resolve();
  await delay(0);
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.equal(disposals, 1);
  const replacement = await f.registry.prepare(source, () => ({ methods: {} }));
  await f.registry.disable(replacement);
});

test("a rejected dispose is a retained failure and a later explicit attempt may finish", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const handle = await f.registry.prepare(source, () => ({
    methods: {},
    dispose() {
      if (++attempts === 1) throw new Error("dispose failed");
    },
  }));
  const first = await f.registry.disable(handle);
  assert.equal(first.status, "stopping");
  assert.equal(first.disposeFailed, true);
  assert.equal(attempts, 1);
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.equal(attempts, 2);
});

test("background resource identities block disable and remain usable by new calls until real closure", async (t) => {
  const f = await fixture(t),
    managed = control();
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      open: method(async (_input, call) => {
        const ref = await call.resources.register({
          kind: "session",
          value: managed.value,
        });
        await call.resources.handoff(ref.id);
        return { id: ref.id };
      }),
      close: method(async ({ id }, call) => {
        const ref = await call.resources.get(id);
        await ref.value.dispose();
        await ref.value.closed;
        return { id };
      }),
    },
  }));
  f.registry.publish(handle);
  const opened = await f.start({ script: "return demo.open();" });
  assert.equal(opened.run.status, "succeeded");
  assert.throws(() => f.registry.disable(handle), { code: "extension_busy" });
  const closed = await f.start({
    script: "return demo.close(context.input);",
    input: opened.result.data,
  });
  assert.equal(closed.run.status, "succeeded");
  assert.equal(managed.stops(), 1);
  assert.equal(f.store.getResource(opened.result.data.id).status, "closed");
  await f.registry.disable(handle);
});

test("source script leases cover asynchronous input preparation and execution despite per-file revision hashes", async (t) => {
  const sources = [],
    preparing = Promise.withResolvers(),
    inputs = Promise.withResolvers(),
    executing = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await fixture(t, {
    sources: () => sources,
    prepareAttachments: async () => {
      preparing.resolve();
      await inputs.promise;
      return [];
    },
  });
  const directory = path.join(
    f.workDir,
    "node_modules",
    "@test",
    "demo",
    "scripts",
  );
  mkdirSync(directory, { recursive: true });
  const script =
    "/**\n" +
    JSON.stringify({
      scriptName: "flow.js",
      scriptDesc: "组合流程",
      scriptWhenUse: "测试占用",
      scriptInputSchema: {},
    }) +
    "\n*/\n await demo.wait(); return 1;";
  writeFileSync(path.join(directory, "flow.js"), script);
  sources.push({
    type: "extension",
    owner: origin.owner,
    namespace: origin.namespace,
    version: origin.version,
    directory,
  });
  const handle = await f.registry.prepare(source, () => ({
    methods: {
      wait: method(async () => {
        executing.resolve();
        await release.promise;
        return 1;
      }),
    },
  }));
  f.registry.publish(handle);
  const accepted = await f.start({
    scriptName: "demo/flow.js",
    attachments: [{ transferId: "transfer-test" }],
    waitMs: 0,
  });
  await preparing.promise;
  assert.throws(() => f.registry.disable(handle), { code: "extension_busy" });
  assert.ok(
    f.policies.some(
      (policy) =>
        policy.scriptOrigin?.revision &&
        policy.scriptOrigin.revision !== source.origin.revision,
    ),
  );
  inputs.resolve();
  await executing.promise;
  assert.throws(() => f.registry.disable(handle), { code: "extension_busy" });
  release.resolve();
  assert.equal((await f.finish(accepted.run.runId)).run.status, "succeeded");
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.throws(
    () => f.registry.lease(f.scripts.resolve("demo/flow.js").origin),
    { code: "extension_unavailable" },
  );
});
