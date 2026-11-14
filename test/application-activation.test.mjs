import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
const application =
  process.env.NEXUM_APPLICATION_MODULE ??
  new URL("../dist/application/runtime.js", import.meta.url).href;
const { ConfigurationSources } = await import(
  new URL("./activation.js", application)
);
const { ExtensionRegistry } = await import(
  new URL("../extensions/registry.js", application)
);
const { ResourceManager } = await import(
  new URL("../extensions/resources.js", application)
);
const { SqliteStore } = await import(
  new URL("../storage/sqlite.js", application)
);
const caller = { principalId: "owner", clientId: "client", grantId: "grant" };
const method = () => ({
  description: "Original method",
  permissions: [],
  schemaDialect: "draft7",
  inputSchema: { type: "object" },
  handle() {
    return 1;
  },
});
function input(revision, factory) {
  return {
    kind: "api",
    name: "fixture",
    objectId: "config_fixture",
    revision,
    config: {},
    api: {
      factory,
      revision,
      bindingPath: ["api", "fixture"],
      permissions: [],
      documentation: { markdown: "# Fixture " + revision, types: "export {};" },
      catalog() {
        return {
          name: "fixture",
          revision,
          ready: true,
          sourceVersion: "3.1.0",
          operations: [],
        };
      },
    },
  };
}
async function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-activation-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "development",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 15 });
  const registry = new ExtensionRegistry(resources, {
    cleanupTimeoutMs: 15,
    permissions: new Set(),
    authorize() {},
    log() {},
    progress() {},
  });
  const sources = new ConfigurationSources(work, registry);
  t.after(async () => {
    await sources.close();
    await resources.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const scope = (controller = new AbortController()) => ({
    caller,
    operationId: "op_test",
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
    authorize() {
      controller.signal.throwIfAborted();
    },
  });
  return { sources, resources, registry, scope };
}

test("an adapter removal retains the actual stopping handle until an explicit retry confirms disposal", async (t) => {
  const f = await fixture(t),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  const prepared = await f.sources.prepare(
    input("1", () => ({
      methods: { ping: method() },
      async dispose() {
        await release.promise;
      },
    })),
    f.scope(),
  );
  prepared.publish();
  const target = {
    kind: "api",
    name: "fixture",
    objectId: "config_fixture",
    revision: "1",
  };
  await assert.rejects(f.sources.remove(target, f.scope()), {
    code: "configuration_cleanup_unconfirmed",
  });
  assert.equal(f.sources.published().docs.length, 0);
  await assert.rejects(f.sources.remove(target, f.scope()), {
    code: "configuration_cleanup_unconfirmed",
  });
  await assert.rejects(f.sources.close(), { code: "shutdown_unconfirmed" });
  release.resolve();
  await f.sources.remove(target, f.scope());
  await f.sources.close();
});

test("a failed candidate with unconfirmed native cleanup remains owned until shutdown retry joins it", async (t) => {
  const f = await fixture(t),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  let disposed = 0;
  await assert.rejects(
    f.sources.prepare(
      input("bad", async (host) => {
        await host.resources.register({
          kind: "fixture.pending",
          value: {
            closed: release.promise,
            dispose() {
              disposed++;
            },
          },
        });
        return { methods: { invalid: { description: "incomplete" } } };
      }),
      f.scope(),
    ),
    { code: "extension_initialization_failed" },
  );
  assert.ok(disposed >= 1);
  await assert.rejects(f.sources.close(), { code: "shutdown_unconfirmed" });
  release.resolve();
  await f.sources.close();
});

test("after a retired predecessor cannot be republished, a later approved retry creates one real replacement", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  let closed = 0;
  const previous = await f.sources.prepare(
    input("old", () => ({
      methods: { ping: method() },
      dispose() {
        closed++;
      },
    })),
    f.scope(),
  );
  previous.publish();
  const candidate = await f.sources.prepare(
    input("new", () => ({ methods: { ping: method() } })),
    f.scope(controller),
  );
  assert.equal(closed, 1);
  controller.abort();
  await candidate.dispose();
  assert.equal(f.sources.published().docs.length, 0);
  const retry = await f.sources.prepare(
    input("new", () => ({ methods: { ping: method() } })),
    f.scope(),
  );
  retry.publish();
  assert.equal(f.sources.published().docs.length, 1);
  assert.match(f.sources.published().docs[0].name, /api.fixture/);
  assert.equal(closed, 1);
});
