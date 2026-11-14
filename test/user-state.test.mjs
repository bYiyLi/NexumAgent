import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ControlConnection } from "../dist/application/connection.js";
import { AgentAuthority } from "../dist/application/authority.js";
import { CloudUserStateBackend } from "../dist/application/user-state.js";
import { StateServices } from "../dist/services/state.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { newId } from "../dist/contracts/json.js";

async function within(promise) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(5000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Fixture deadline exceeded");
      }),
    ]);
  } finally {
    controller.abort();
  }
}

async function fixture(t, receive) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-user-state-")),
    ),
    messages = [],
    peers = [],
    connections = [],
    controllers = [],
    stores = [],
    events = new EventEmitter(),
    values = new Map();
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  ws.on("headers", (headers, request) =>
    headers.push(
      `X-Nexum-Agent-Id: ${request.agentId}`,
      "X-Nexum-Cloud-Environment: development",
      `X-Nexum-Connection-Id: ${request.connectionId}`,
    ),
  );
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    request.agentId = request.url.split("/")[1];
    request.connectionId = newId("connection");
    ws.handleUpgrade(request, socket, head, (peer) => {
      peers.push(peer);
      peer.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        messages.push(message);
        events.emit("message", message);
        if (message.type !== "invoke") return;
        const reply = (output) =>
          peer.send(
            JSON.stringify({
              type: "result",
              id: message.id,
              operation: message.operation,
              output,
            }),
          );
        const fail = (code) =>
          peer.send(
            JSON.stringify({
              type: "error",
              id: message.id,
              error: { code, message: "The Cloud operation was rejected." },
            }),
          );
        if (receive?.({ peer, message, reply, fail, values })) return;
        const key = `${message.context.caller.principalId}:${message.input.key}`,
          previous = values.get(key);
        if (message.operation === "state.user.get")
          reply({ state: previous ?? null });
        else if (message.operation === "state.user.set") {
          if ((previous?.version ?? null) !== message.input.expectedVersion) {
            fail("state_version_conflict");
            return;
          }
          const value = {
            value: message.input.value,
            version: (previous?.version ?? 0) + 1,
            updatedAt: Date.now(),
          };
          values.set(key, value);
          reply(value);
        } else if (message.operation === "state.user.delete") {
          values.delete(key);
          reply({
            deleted: true,
            version: previous.version + 1,
            updatedAt: Date.now(),
          });
        }
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    controllers.forEach((controller) => controller.abort());
    peers.forEach((peer) => peer.terminate());
    await Promise.allSettled(
      connections.map((connection) => connection.closed),
    );
    await Promise.all([
      new Promise((resolve) => ws.close(resolve)),
      new Promise((resolve) => server.close(resolve)),
    ]);
    stores.forEach((store) => store.close());
    rmSync(root, { recursive: true, force: true });
  });
  async function agent(
    agentId,
    caller = { principalId: "user", clientId: "client", grantId: "grant" },
  ) {
    const controller = new AbortController(),
      bootId = newId("boot");
    controllers.push(controller);
    const connection = await ControlConnection.connect({
      serverUrl: `http://127.0.0.1:${server.address().port}/${agentId}`,
      token: "synthetic-user-state-token",
      profile: "development",
      bootId,
      version: "test",
      signal: controller.signal,
      ready: async () => {},
      invoke: async () => {
        throw new Error("Unexpected Cloud invocation");
      },
      event: async () => {},
    });
    connections.push(connection);
    const directory = path.join(root, agentId, String(connections.length));
    mkdirSync(path.join(directory, "work"), { recursive: true });
    const store = new SqliteStore(
      directory,
      { agentId, profile: "development", cloudEnvironment: "development" },
      Date.now(),
      bootId,
    );
    stores.push(store);
    const authority = new AgentAuthority(
      { ...store.binding, bootId },
      path.join(directory, "work"),
    );
    authority.connect(connection.binding);
    const context = {
      caller,
      connection: connection.binding,
      authorization: {
        agentId,
        allowedRoots: [],
        budgets: {},
        revision: "policy",
        expiresAt: new Date(Date.now() + 25000).toISOString(),
      },
    };
    authority.observe(context);
    const backend = new CloudUserStateBackend({
        control: () => connection,
        context: (identity) => authority.context(identity),
      }),
      identity = { ...caller, agentId, cloudEnvironment: "development" },
      states = new StateServices(store, backend),
      service = states.bind({
        context: { agentId, caller },
        signal: controller.signal,
        assertCurrent() {
          authority.authorize(caller);
        },
        authorize(target) {
          authority.authorize(caller, target);
        },
      });
    return {
      connection,
      backend,
      authority,
      identity,
      service,
      controller,
      context,
      store,
    };
  }
  return {
    agent,
    messages,
    values,
    waitMessage(predicate) {
      const previous = messages.find(predicate);
      if (previous) return Promise.resolve(previous);
      const result = Promise.withResolvers();
      const check = (message) => {
        if (predicate(message)) {
          events.removeListener("message", check);
          result.resolve(message);
        }
      };
      events.on("message", check);
      return within(result.promise).finally(() =>
        events.removeListener("message", check),
      );
    },
  };
}

test("real control RPC preserves verified Grant and Agent binding and returns shared Cloud receipts", async (t) => {
  const f = await fixture(t),
    a = await f.agent("agent-a"),
    b = await f.agent("agent-b", {
      principalId: "user",
      clientId: "another-client",
      grantId: "another-grant",
    });
  const first = await a.service.user.set(
    "shared",
    { text: "hello\0world", nested: [null, true] },
    { expectedVersion: null },
  );
  assert.equal(first.version, 1);
  assert.deepEqual(await b.service.user.get("shared"), first);
  const requests = f.messages.filter((message) => message.type === "invoke");
  assert.deepEqual(
    requests.map((message) => [
      message.operation,
      message.context.caller.grantId,
      message.context.connection.agentId,
    ]),
    [
      ["state.user.set", "grant", "agent-a"],
      ["state.user.get", "another-grant", "agent-b"],
    ],
  );
  assert(requests.every((message) => message.input.namespace === "default"));
  assert.equal(Object.hasOwn(requests[0].input, "principalId"), false);
  await assert.rejects(
    b.service.user.set("shared", false, { expectedVersion: null }),
    { code: "state_version_conflict" },
  );
  const removed = await b.service.user.delete("shared", { expectedVersion: 1 });
  assert.deepEqual(
    { deleted: removed.deleted, version: removed.version },
    { deleted: true, version: 2 },
  );
  assert.equal(await a.service.user.get("shared"), null);
  assert.equal(a.store.getState("shared"), null);
  assert.equal(b.store.getState("shared"), null);
});

test("missing Grant, revoked current authority and mismatched caller fail before reverse RPC", async (t) => {
  const f = await fixture(t),
    a = await f.agent("agent-a"),
    signal = new AbortController().signal;
  await assert.rejects(
    a.backend.get({ ...a.identity, grantId: undefined }, "key", signal),
    { code: "unauthorized" },
  );
  const forged = new CloudUserStateBackend({
    control: () => a.connection,
    context: () => a.context,
  });
  await assert.rejects(
    forged.get({ ...a.identity, principalId: "other-user" }, "key", signal),
    { code: "runtime_binding_mismatch" },
  );
  await assert.rejects(
    forged.get({ ...a.identity, agentId: "other-agent" }, "key", signal),
    { code: "runtime_binding_mismatch" },
  );
  a.authority.revoke(a.context.caller);
  await assert.rejects(a.service.user.get("key"), { code: "forbidden" });
  assert.equal(
    f.messages.filter((message) => message.type === "invoke").length,
    0,
  );
});

test("a lost mutation reply does not replay or replace Cloud facts with local state", async (t) => {
  let committed = 0;
  const f = await fixture(t, ({ peer, message, values }) => {
      if (message.operation !== "state.user.set") return false;
      committed++;
      values.set(`${message.context.caller.principalId}:${message.input.key}`, {
        value: message.input.value,
        version: 1,
        updatedAt: Date.now(),
      });
      peer.terminate();
      return true;
    }),
    a = await f.agent("agent-a");
  const mutation = a.service.user.set("uncertain", "committed-on-cloud", {
    expectedVersion: null,
  });
  await assert.rejects(within(mutation), { code: "connection_closed" });
  await within(a.connection.closed);
  assert.equal(committed, 1);
  assert.equal(a.store.getState("uncertain"), null);
  const b = await f.agent("agent-b");
  const actual = await b.service.user.get("uncertain");
  assert.equal(actual.value, "committed-on-cloud");
  assert.equal(committed, 1);
  await assert.rejects(
    a.backend.get(a.identity, "uncertain", new AbortController().signal),
    { code: "user_state_unavailable" },
  );
});

test("native abort ends observation and sends cancel without claiming the remote write was rolled back", async (t) => {
  let pending,
    writes = 0;
  const f = await fixture(t, ({ message, reply, values }) => {
      if (message.operation !== "state.user.set") return false;
      writes++;
      values.set(`${message.context.caller.principalId}:${message.input.key}`, {
        value: message.input.value,
        version: 1,
        updatedAt: Date.now(),
      });
      pending = { message, reply };
      return true;
    }),
    a = await f.agent("agent-a"),
    controller = new AbortController();
  const mutation = a.backend.set(
    a.identity,
    "cancelled-observer",
    "actual",
    null,
    controller.signal,
  );
  const rejection = assert.rejects(mutation, { message: "stop-observation" });
  await f.waitMessage((message) => message.operation === "state.user.set");
  controller.abort(new Error("stop-observation"));
  await rejection;
  await f.waitMessage(
    (message) => message.type === "cancel" && message.id === pending.message.id,
  );
  pending.reply({ value: "actual", version: 1, updatedAt: Date.now() });
  assert.equal(
    (await a.service.user.get("cancelled-observer")).value,
    "actual",
  );
  assert.equal(writes, 1);
});

test("64KiB values survive receipt overhead and oversized values never reach the socket", async (t) => {
  const f = await fixture(t),
    a = await f.agent("agent-a"),
    raw = "<".repeat(65534);
  const result = await a.service.user.set("edge", raw, {
    expectedVersion: null,
  });
  assert.equal(result.value.length, raw.length);
  assert.equal((await a.service.user.get("edge")).value.length, raw.length);
  const before = f.messages.length;
  await assert.rejects(
    a.service.user.set("oversized", "x".repeat(65535), {
      expectedVersion: null,
    }),
    { code: "data_too_large" },
  );
  assert.equal(f.messages.length, before);
});
