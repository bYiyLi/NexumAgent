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
const names = ["createUpload", "createDownload", "get", "list", "cancel"];
const transferId = `tr_${"1".repeat(32)}`;
const args = {
  createUpload: [
    { path: "/tmp/in.bin", expectedSize: 3, mimeType: "image/png" },
  ],
  createDownload: [
    { uri: "nexum://agents/agent/resources/example", name: "out.bin" },
  ],
  get: [transferId, { waitMs: 27 }],
  list: [
    { direction: "upload", status: "pending", limit: 4, cursor: "page-two" },
  ],
  cancel: [transferId],
};
const source = {
  apiVersion: 1,
  origin: {
    type: "extension",
    owner: "@test/transfer-provider",
    namespace: "demo",
    version: "1",
    revision: "bundle-one",
  },
  permissions: ["read", ...names.map((name) => `transfer.${name}`)],
};
const method = (handle, permissions = ["read"]) => ({
  description: "验证公共 transfer provider 边界",
  permissions,
  schemaDialect: "draft7",
  inputSchema: { type: "object" },
  handle,
});
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-transfer-provider-")),
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
  const policies = [];
  let allowed = true;
  const registry = new ExtensionRegistry(resources, {
    permissions: new Set(source.permissions),
    ...(options.transfer ? { transfer: options.transfer } : {}),
    authorize(policy) {
      policies.push(policy);
      if (!allowed && ["invoke", "resource"].includes(policy.action))
        throw new AgentError("forbidden", "Current permission was revoked.");
    },
    log() {},
    progress() {},
  });
  const scripts = new ScriptCatalog(workDir, "agent", () => []);
  const loader = await ModuleLoader.create(workDir, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  writeFileSync(path.join(workDir, "snapshot.json"), '{"project":null}');
  const work = store.openWork({
    callerKey: callerKey(caller),
    pwd: workDir,
    snapshotRef: "work/snapshot.json",
  });
  const engine = new RunEngine(store, loader, scripts, {
    authorize(who, target) {
      if (target.run && target.run.callerKey !== callerKey(who))
        throw new AgentError("forbidden", "Wrong caller.");
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
    await delay(30);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    registry,
    policies,
    publish: async (methods) => {
      const handle = await registry.prepare(source, () => ({ methods }));
      registry.publish(handle);
      return handle;
    },
    start: (script, input = {}) =>
      engine.start(caller, { contextId: work.contextId, script, input }),
    revoke: () => {
      allowed = false;
    },
    grant: () => {
      allowed = true;
    },
  };
}
function provider(calls) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      async (...input) => {
        calls.push({ name, input });
        return { method: name };
      },
    ]),
  );
}
function result(view) {
  assert.equal(view.run.status, "succeeded", JSON.stringify(view.run.error));
  return view.result.data;
}
const callScript = (name) =>
  `try{return {value:await demo.${name}({})};}catch(e){return {code:e.code};}`;

test("configured transfer provider receives all five argument lists and the current invocation binding", async (t) => {
  const calls = [],
    bindings = [];
  const f = await fixture(t, {
    transfer(binding) {
      bindings.push(binding);
      return provider(calls);
    },
  });
  await f.publish(
    Object.fromEntries(
      names.map((name) => [
        name,
        method(
          (_, call) => call.transfer[name](...args[name]),
          [`transfer.${name}`],
        ),
      ]),
    ),
  );
  for (const name of names) {
    const view = await f.start(callScript(name));
    assert.deepEqual(result(view), { value: { method: name } });
    const binding = bindings.at(-1);
    assert.equal(binding.runId, view.run.runId);
    assert.equal(binding.context.contextId, f.work.contextId);
    assert.deepEqual(binding.context.caller, caller);
    assert.equal(binding.signal instanceof AbortSignal, true);
    assert.equal(typeof binding.deadline, "number");
    assert.equal(typeof binding.assertCurrent, "function");
    assert.equal(typeof binding.authorize, "function");
    assert.throws(() => binding.assertCurrent(), { code: "invocation_closed" });
  }
  assert.deepEqual(
    calls,
    names.map((name) => ({ name, input: args[name] })),
  );
});

test("all transfer methods reject undeclared permission before invoking the provider", async (t) => {
  const calls = [];
  const f = await fixture(t, { transfer: () => provider(calls) });
  await f.publish(
    Object.fromEntries(
      names.map((name) => [
        name,
        method((_, call) => call.transfer[name](...args[name])),
      ]),
    ),
  );
  for (const name of names)
    assert.deepEqual(result(await f.start(callScript(name))), {
      code: "undeclared_permission",
    });
  assert.deepEqual(calls, []);
});

test("all transfer methods recheck current permission before invoking the provider", async (t) => {
  const calls = [];
  const f = await fixture(t, { transfer: () => provider(calls) });
  await f.publish(
    Object.fromEntries(
      names.map((name) => [
        name,
        method(
          (_, call) => {
            f.revoke();
            return call.transfer[name](...args[name]);
          },
          [`transfer.${name}`],
        ),
      ]),
    ),
  );
  for (const name of names) {
    assert.deepEqual(result(await f.start(callScript(name))), {
      code: "forbidden",
    });
    f.grant();
  }
  assert.deepEqual(calls, []);
});

test("all transfer methods fail closed when no provider is configured", async (t) => {
  const f = await fixture(t);
  await f.publish(
    Object.fromEntries(
      names.map((name) => [
        name,
        method(
          (_, call) => call.transfer[name](...args[name]),
          [`transfer.${name}`],
        ),
      ]),
    ),
  );
  for (const name of names)
    assert.deepEqual(result(await f.start(callScript(name))), {
      code: "transfer_unavailable",
    });
});

test("a settled invocation cannot reuse any captured transfer facade method", async (t) => {
  const calls = [];
  let captured;
  const f = await fixture(t, { transfer: () => provider(calls) });
  await f.publish({
    capture: method(
      (_, call) => {
        captured = call.transfer;
        return { captured: true };
      },
      names.map((name) => `transfer.${name}`),
    ),
  });
  assert.deepEqual(result(await f.start("return demo.capture({});")), {
    captured: true,
  });
  for (const name of names)
    assert.throws(() => captured[name](...args[name]), {
      code: "invocation_closed",
    });
  assert.deepEqual(calls, []);
});

test("transfer facade, methods and inner service cannot escape through SDK results", async (t) => {
  const calls = [];
  let inner;
  const f = await fixture(t, {
    transfer() {
      inner = provider(calls);
      return inner;
    },
  });
  await f.publish({
    facade: method((_, call) => call.transfer),
    method: method((_, call) => call.transfer.get),
    inner: method(() => inner),
    nested: method(() => ({ result: { inner } })),
  });
  for (const name of ["facade", "method", "inner", "nested"])
    assert.deepEqual(result(await f.start(callScript(name))), {
      code: "invalid_sdk_result",
    });
  assert.deepEqual(calls, []);
});
