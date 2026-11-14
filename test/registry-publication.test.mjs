import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentError } from "../dist/contracts/errors.js";
import { ExtensionRegistry } from "../dist/extensions/registry.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { SqliteStore } from "../dist/storage/sqlite.js";

const source = {
  apiVersion: 1,
  origin: {
    type: "extension",
    owner: "publication-fixture",
    namespace: "publicationFixture",
    version: "1.0.0",
    revision: "revision-one",
  },
  permissions: [],
};
const methods = {
  inspect: {
    description: "Read fixture state",
    permissions: [],
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    },
    handle() {
      return { ready: true };
    },
  },
};

function fixture(t, authorize = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nexum-publication-"));
  const store = new SqliteStore(root, {
    agentId: "agent-publication",
    profile: "development",
    cloudEnvironment: "isolated-publication-fixture",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 20 });
  const registry = new ExtensionRegistry(resources, {
    permissions: new Set(),
    cleanupTimeoutMs: 20,
    authorize,
    log() {},
    progress() {},
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  // Bindings are inspected only, so no fake invocation or operation is made.
  const visible = () =>
    Object.hasOwn(registry.bindings({}), "publicationFixture");
  return { registry, visible, store };
}

test("prepared discovery commits after publication checks and before SDK visibility", async (t) => {
  let catalogVisible = false,
    observedPublicationCheck = false;
  const f = fixture(t, (policy) => {
    if (policy.action === "publish") {
      observedPublicationCheck = true;
      assert.equal(catalogVisible, false);
      assert.equal(f.visible(), false);
    }
  });
  const started = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const pending = f.registry.prepare(source, async () => {
    started.resolve();
    await gate.promise;
    return { methods };
  });
  await started.promise;
  assert.equal(f.visible(), false);
  gate.resolve();
  const handle = await pending;
  assert.equal(f.visible(), false);
  f.registry.publish(handle, () => {
    assert.equal(observedPublicationCheck, true);
    assert.equal(f.visible(), false);
    catalogVisible = true;
  });
  assert.equal(catalogVisible, true);
  assert.equal(f.visible(), true);
  await f.registry.disable(handle, () => {
    catalogVisible = false;
  });
});

test("failed authorization or commit never publishes the SDK, and async commits are rejected before execution", async (t) => {
  let denied = true;
  const f = fixture(t, (policy) => {
    if (denied && policy.action === "publish")
      throw new AgentError("forbidden", "Publication is no longer allowed.");
  });
  const handle = await f.registry.prepare(source, () => ({ methods }));
  let commits = 0;
  assert.throws(() => f.registry.publish(handle, () => commits++), {
    code: "forbidden",
  });
  assert.equal(commits, 0);
  denied = false;
  assert.throws(
    () =>
      f.registry.publish(handle, async () => {
        commits++;
      }),
    { code: "extension_publication_configuration" },
  );
  assert.equal(commits, 0);
  assert.throws(() =>
    f.registry.publish(handle, () => {
      throw new Error("No discovery index was committed.");
    }),
  );
  assert.equal(f.visible(), false);
  f.registry.publish(handle, () => {
    commits++;
  });
  assert.equal(f.visible(), true);
  assert.equal(commits, 1);
  await f.registry.disable(handle);
});

test("busy disable retains all discovery; accepted withdrawal precedes synchronous abort and dispose callbacks", async (t) => {
  const f = fixture(t);
  let catalogVisible = false,
    stopped = false,
    disposed = false;
  const handle = await f.registry.prepare(source, (host) => {
    host.signal.addEventListener("abort", () => {
      assert.equal(catalogVisible, false);
      assert.equal(f.visible(), false);
      stopped = true;
    });
    return {
      methods,
      dispose() {
        assert.equal(catalogVisible, false);
        assert.equal(f.visible(), false);
        disposed = true;
      },
    };
  });
  f.registry.publish(handle, () => {
    catalogVisible = true;
  });
  const release = f.registry.lease(handle.origin);
  const withdraw = () => {
    catalogVisible = false;
  };
  assert.throws(() => f.registry.disable(handle, withdraw), {
    code: "extension_busy",
  });
  assert.equal(catalogVisible, true);
  assert.equal(f.visible(), true);
  assert.equal(stopped, false);
  release();
  const report = await f.registry.disable(handle, withdraw);
  assert.equal(report.status, "disabled");
  assert.equal(stopped, true);
  assert.equal(disposed, true);
  assert.equal(catalogVisible, false);
  assert.equal(f.visible(), false);
});

test("unconfirmed disposal keeps the withdrawn source unavailable until the same cleanup actually settles", async (t) => {
  const f = fixture(t),
    closed = Promise.withResolvers();
  let catalogVisible = false,
    disposals = 0;
  const handle = await f.registry.prepare(source, () => ({
    methods,
    dispose() {
      disposals++;
      return closed.promise;
    },
  }));
  f.registry.publish(handle, () => {
    catalogVisible = true;
  });
  const report = await f.registry.disable(handle, () => {
    catalogVisible = false;
  });
  assert.equal(report.status, "stopping");
  assert.equal(catalogVisible, false);
  assert.equal(f.visible(), false);
  assert.equal(disposals, 1);
  closed.resolve();
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.equal(disposals, 1);
});

test("instance target authority is current, source-bound and independent of run or caller", async (t) => {
  const targets = [];
  let allowed = true,
    asynchronous = false,
    host;
  const f = fixture(t, (policy) => {
    if (!policy.target) return;
    if (asynchronous) return Promise.resolve();
    if (!allowed) throw new AgentError("forbidden", "Instance access revoked.");
    targets.push(policy);
  });
  const handle = await f.registry.prepare(source, (value) => {
    host = value;
    host.authorize({ type: "path", value: "/fixture/tool", access: "execute" });
    return { methods };
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].action, "resource");
  assert.deepEqual(targets[0].origin, source.origin);
  assert.deepEqual(targets[0].permissions, source.permissions);
  assert.equal(targets[0].context, undefined);
  assert.equal(targets[0].runId, undefined);
  f.registry.publish(handle);
  host.authorize({
    type: "connection",
    value: "approved-connection",
    access: "connect",
  });
  assert.throws(
    () => host.authorize({ type: "user-state", value: "key", access: "get" }),
    { code: "invalid_access_target" },
  );
  allowed = false;
  assert.throws(
    () =>
      host.authorize({
        type: "url",
        value: "https://example.test",
        access: "connect",
      }),
    { code: "forbidden" },
  );
  allowed = true;
  asynchronous = true;
  assert.throws(
    () =>
      host.authorize({
        type: "url",
        value: "https://example.test",
        access: "connect",
      }),
    { code: "authorization_configuration" },
  );
  asynchronous = false;
  await f.registry.disable(handle);
  const count = targets.length;
  assert.throws(
    () =>
      host.authorize({
        type: "path",
        value: "/fixture/tool",
        access: "execute",
      }),
    { code: "extension_unavailable" },
  );
  assert.equal(targets.length, count);
});

test("standard MCP resource reads use the original instance with fresh authority and occupy it until real settlement", async (t) => {
  const f = fixture(t),
    response = Promise.withResolvers();
  let connectionId,
    reads = 0,
    allowed = true;
  const factory = async (host) => {
    const closure = Promise.withResolvers();
    const ref = await host.resources.register({
      kind: "mcp.connection",
      value: {
        connection: "fixture",
        closed: closure.promise,
        assertCurrent() {
          host.signal.throwIfAborted();
        },
        readResource() {
          reads++;
          return response.promise;
        },
        dispose() {
          closure.resolve();
        },
      },
    });
    connectionId = ref.id;
    return { methods };
  };
  const handle = await f.registry.prepare(source, factory);
  f.registry.publish(handle);
  const identity = {
    agentId: f.store.binding.agentId,
    profileRoot: f.store.root,
    extensionId: handle.id,
    origin: handle.origin,
    connectionResourceId: connectionId,
    connection: "fixture",
  };
  const scope = {
    ownerKey: "verified-owner",
    grantId: "verified-grant",
    assertCurrent() {
      if (!allowed) throw new AgentError("forbidden", "Grant revoked.");
    },
    authorizeConnection() {
      if (!allowed) throw new AgentError("forbidden", "Grant revoked.");
    },
  };
  await assert.rejects(
    f.registry.resolveMcpResource({ ...identity, agentId: "other" }, scope),
    { code: "mcp_profile_mismatch" },
  );
  const reader = await f.registry.resolveMcpResource(identity, scope);
  assert.equal("dispose" in reader, false);
  assert.equal("closed" in reader, false);
  await assert.rejects(
    reader.readResource("fixture://document", { ...scope }),
    { code: "mcp_authorization_configuration" },
  );
  assert.equal(reads, 0);
  const pending = reader.readResource("fixture://document", scope);
  assert.equal(reads, 1);
  assert.throws(() => f.registry.disable(handle), { code: "extension_busy" });
  assert.equal(f.visible(), true);
  allowed = false;
  response.resolve({ contents: [{ uri: "fixture://document", text: "body" }] });
  await assert.rejects(pending, { code: "forbidden" });
  allowed = true;
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  const replacement = await f.registry.prepare(source, factory);
  f.registry.publish(replacement);
  assert.notEqual(replacement.id, handle.id);
  assert.notEqual(connectionId, identity.connectionResourceId);
  await assert.rejects(f.registry.resolveMcpResource(identity, scope), {
    code: "mcp_source_unavailable",
  });
  await f.registry.disable(replacement);
});
