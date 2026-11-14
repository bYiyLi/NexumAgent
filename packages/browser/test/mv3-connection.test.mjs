import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createExtensionConnection } from "../browser-extension/connection.js";
import {
  transportLimits,
  packBrowserValue,
  browserFrames,
} from "../browser-extension/transport.js";

function event() {
  const values = new Set();
  return {
    addListener: (fn) => values.add(fn),
    removeListener: (fn) => values.delete(fn),
    emit: (...args) => {
      for (const fn of values) fn(...args);
    },
  };
}
async function until(predicate) {
  const end = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < end, "plugin did not reach expected state");
    await delay(2);
  }
}
function fixture(
  t,
  dispatch = async (input) => ({ method: input.method, input: input.args }),
  { WebSocket: NativeSocket, pingMs = 20000, offlineMs = 60000 } = {},
) {
  const sockets = [],
    calls = [],
    values = { local: {}, session: {} },
    getCounts = { local: 0, session: 0 };
  class Socket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    message(data) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data:
            typeof data === "object" &&
            !(data instanceof Uint8Array) &&
            !(data instanceof ArrayBuffer)
              ? JSON.stringify(data)
              : data,
        }),
      );
    }
    send(value) {
      assert.equal(this.readyState, 1);
      this.sent.push(
        typeof value === "string" ? JSON.parse(value) : value.slice(),
      );
    }
    close(code = 1000) {
      if (code !== 1000 && (code < 3000 || code > 4999))
        throw new DOMException(
          "Invalid browser WebSocket close code",
          "InvalidAccessError",
        );
      if (this.readyState === 3) return;
      this.code = code;
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(new Event("close")));
    }
  }
  const chrome = {
    runtime: { id: "extension", onStartup: event() },
    alarms: { onAlarm: event(), create() {}, async clear() {} },
    action: { async setBadgeText() {}, async setTitle() {} },
    storage: Object.fromEntries(
      ["local", "session"].map((scope) => [
        scope,
        {
          async get() {
            getCounts[scope]++;
            return { ...values[scope] };
          },
          async set(input) {
            Object.assign(values[scope], input);
          },
        },
      ]),
    ),
  };
  let bound,
    snapshots = 0;
  const router = {
    start() {
      calls.push(["start"]);
    },
    bind(value) {
      bound = value;
      calls.push(["bind", value]);
    },
    async snapshot() {
      snapshots++;
      return [{ id: "1", title: "Current", url: "https://example.com/" }];
    },
    async openLease(value) {
      calls.push(["open", value]);
      return { leaseId: value.leaseId };
    },
    async endLease(id) {
      calls.push(["end", id]);
      return { leaseId: id, closed: true };
    },
    async dispatch(input, signal) {
      calls.push(["dispatch", input]);
      return dispatch(input, signal);
    },
    async dispose() {
      calls.push(["dispose"]);
    },
  };
  const connection = createExtensionConnection({
    chrome,
    WebSocket: NativeSocket ?? Socket,
    router,
    profile: "development",
    extensionVersion: "0.1.0",
    pingMs,
    offlineMs,
  });
  t.after(() => connection.dispose());
  const ready = () => ({
    v: 1,
    type: "ready",
    profile: "development",
    bootId: "boot",
    connectionId: "connection",
    browserId: "browser",
    browserSessionId: values.session.nexumBrowserSessionId,
    generation: 1,
    protocolVersion: 1,
    limits: transportLimits,
  });
  const binding = () => ({ v: 1, connectionId: "connection", generation: 1 });
  const target = () => ({
    bootId: "boot",
    browserId: "browser",
    browserSessionId: values.session.nexumBrowserSessionId,
    generation: 1,
    tabId: "1",
  });
  const lease = () => ({
    ...binding(),
    type: "lease_open",
    leaseId: "lease",
    runId: "run",
    operationId: "open",
    target: target(),
  });
  const action = (id = "action", args = {}) => ({
    ...binding(),
    type: "action",
    actionId: id,
    operationId: `operation-${id}`,
    runId: "run",
    leaseId: "lease",
    target: target(),
    method: "tab.title",
    args,
    budgetMs: 1000,
  });
  return {
    sockets,
    calls,
    values,
    getCounts,
    connection,
    router,
    ready,
    binding,
    target,
    lease,
    action,
    snapshots: () => snapshots,
    bound: () => bound,
  };
}
async function online(f) {
  await f.connection.start();
  await until(() => f.sockets.length === 1);
  const socket = f.sockets[0];
  socket.open();
  socket.message(f.ready());
  await until(() => socket.sent.some((v) => v.type === "tabs"));
  socket.message(f.lease());
  await until(() => socket.sent.some((v) => v.type === "lease_opened"));
  return socket;
}

test("construction stays cold and the exact profile handshake precedes any atomic snapshots", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.getCounts, { local: 0, session: 0 });
  assert.equal(f.sockets.length, 0);
  assert.deepEqual(f.calls, []);
  await f.connection.start();
  await until(() => f.sockets.length === 1);
  const socket = f.sockets[0];
  assert.equal(socket.url, "ws://127.0.0.1:43832/nexum-browser/v1");
  socket.open();
  assert.equal(socket.sent.length, 1);
  const hello = socket.sent[0];
  assert.equal(hello.type, "hello");
  assert.equal(hello.profile, "development");
  assert.equal(hello.browserProfileId, f.values.local.nexumBrowserProfileId);
  assert.equal(hello.browserSessionId, f.values.session.nexumBrowserSessionId);
  assert.equal(f.snapshots(), 0);
  socket.message(f.ready());
  await until(() => socket.sent.some((v) => v.type === "tabs"));
  const tabs = socket.sent.find((v) => v.type === "tabs");
  assert.equal(tabs.index, 0);
  assert.equal(tabs.total, 1);
  assert.equal(tabs.items.length, 1);
  assert.equal(tabs.generation, 1);
  const capabilities = socket.sent.find((v) => v.type === "capabilities");
  assert.ok(
    capabilities.items.every(
      (v) => typeof v.method === "string" && !Object.hasOwn(v, "supported"),
    ),
  );
});

test("mismatching ready profile closes the channel without dispatching snapshots", async (t) => {
  const f = fixture(t);
  await f.connection.start();
  await until(() => f.sockets.length === 1);
  const socket = f.sockets[0];
  socket.open();
  socket.message({ ...f.ready(), profile: "production" });
  await until(() => socket.readyState === 3);
  assert.equal(socket.code, 4002);
  assert.equal(f.snapshots(), 0);
});

test("duplicate actions reuse their receipt and a same-ID different argument cannot be dispatched", async (t) => {
  const f = fixture(t),
    socket = await online(f),
    action = f.action("duplicate", { request: "first" });
  socket.message(action);
  await until(() => socket.sent.some((v) => v.type === "action_result"));
  socket.message(action);
  await until(
    () => socket.sent.filter((v) => v.type === "action_result").length === 2,
  );
  assert.equal(f.calls.filter((v) => v[0] === "dispatch").length, 1);
  socket.message({ ...action, args: { request: "rebound" } });
  await until(() => socket.readyState === 3);
  assert.equal(socket.code, 4002);
  assert.equal(f.calls.filter((v) => v[0] === "dispatch").length, 1);
});

for (const mode of ["protocol rejection", "silent peer expiry"])
  test(
    `the native Node WebSocket API closes ${mode} without an invalid-code exception`,
    { timeout: 15000 },
    async (t) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const closed = Promise.withResolvers();
      class NativeSocket extends globalThis.WebSocket {
        constructor(url) {
          assert.equal(url, "ws://127.0.0.1:43832/nexum-browser/v1");
          // Only the injected test transport selects an ephemeral local port;
          // the production profile's fixed-endpoint check is still exercised.
          super(`ws://127.0.0.1:${server.address().port}`);
        }
      }
      const f = fixture(t, undefined, {
        WebSocket: NativeSocket,
        pingMs: 10,
        offlineMs: mode === "silent peer expiry" ? 100 : 60000,
      });
      t.after(async () => {
        for (const socket of server.clients) socket.terminate();
        await new Promise((resolve) => server.close(resolve));
      });
      server.on("connection", (socket) => {
        socket.once("close", (code) => closed.resolve(code));
        socket.once("message", () => {
          socket.send(
            JSON.stringify({
              ...f.ready(),
              ...(mode === "protocol rejection"
                ? { profile: "production" }
                : {}),
            }),
          );
        });
      });
      await f.connection.start();
      assert.equal(
        await closed.promise,
        mode === "protocol rejection" ? 4002 : 4001,
      );
      if (mode === "protocol rejection") assert.equal(f.snapshots(), 0);
      else assert.ok(f.snapshots() > 0);
    },
  );

test("a pending binary action can be cancelled; its late stream is discarded while another action remains usable", async (t) => {
  const f = fixture(t),
    socket = await online(f),
    action = f.action("bytes", { data: null });
  const packed = await packBrowserValue(new Uint8Array([1, 2, 3]), {
      actionId: action.actionId,
      operationId: action.operationId,
      generation: action.generation,
    }),
    stream = packed.streams[0];
  action.attachments = [{ streamId: stream.meta.streamId, path: ["data"] }];
  socket.message(action);
  socket.message({
    ...f.binding(),
    type: "cancel_action",
    actionId: action.actionId,
    operationId: action.operationId,
  });
  await until(() =>
    socket.sent.some(
      (v) => v.type === "action_result" && v.actionId === "bytes",
    ),
  );
  assert.equal(f.calls.filter((v) => v[0] === "dispatch").length, 0);
  socket.message({
    v: 1,
    type: "binary_start",
    connectionId: "connection",
    ...stream.meta,
  });
  for (const frame of browserFrames(stream.meta, stream.bytes))
    socket.message(frame.buffer);
  socket.message({
    v: 1,
    type: "binary_end",
    connectionId: "connection",
    ...stream.meta,
  });
  socket.message(f.action("next"));
  await until(() =>
    socket.sent.some(
      (v) => v.type === "action_result" && v.actionId === "next",
    ),
  );
  assert.equal(socket.readyState, 1);
  assert.equal(f.calls.filter((v) => v[0] === "dispatch").length, 1);
});

test("complete byte inputs are hydrated before dispatch without blocking unrelated control messages", async (t) => {
  const f = fixture(t),
    socket = await online(f),
    action = f.action("hydrated", { data: null });
  const packed = await packBrowserValue(new Uint8Array([7, 8, 9, 10]), {
      actionId: action.actionId,
      operationId: action.operationId,
      generation: action.generation,
    }),
    stream = packed.streams[0];
  action.attachments = [{ streamId: stream.meta.streamId, path: ["data"] }];
  socket.message(action);
  socket.message({ ...f.binding(), type: "ping" });
  await until(() => socket.sent.some((v) => v.type === "pong"));
  assert.equal(f.calls.filter((v) => v[0] === "dispatch").length, 0);
  socket.message({
    v: 1,
    type: "binary_start",
    connectionId: "connection",
    ...stream.meta,
  });
  for (const frame of browserFrames(stream.meta, stream.bytes))
    socket.message(frame.buffer);
  socket.message({
    v: 1,
    type: "binary_end",
    connectionId: "connection",
    ...stream.meta,
  });
  await until(() => f.calls.some((v) => v[0] === "dispatch"));
  assert.deepEqual(
    [...f.calls.find((v) => v[0] === "dispatch")[1].args.data],
    [7, 8, 9, 10],
  );
});

test("cancellation during asynchronous stream hashing drops only that original stream", async (t) => {
  const f = fixture(t),
    socket = await online(f),
    action = f.action("digest-cancel", { data: null });
  const packed = await packBrowserValue(new Uint8Array(999).fill(7), {
      actionId: action.actionId,
      operationId: action.operationId,
      generation: action.generation,
    }),
    stream = packed.streams[0];
  action.attachments = [{ streamId: stream.meta.streamId, path: ["data"] }];
  const original = crypto.subtle.digest,
    own = Object.getOwnPropertyDescriptor(crypto.subtle, "digest"),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  crypto.subtle.digest = function (algorithm, value) {
    if (value.byteLength === 999) {
      entered.resolve();
      return gate.promise.then(() => original.call(this, algorithm, value));
    }
    return original.call(this, algorithm, value);
  };
  try {
    socket.message(action);
    socket.message({
      v: 1,
      type: "binary_start",
      connectionId: "connection",
      ...stream.meta,
    });
    for (const frame of browserFrames(stream.meta, stream.bytes))
      socket.message(frame.buffer);
    socket.message({
      v: 1,
      type: "binary_end",
      connectionId: "connection",
      ...stream.meta,
    });
    await entered.promise;
    socket.message({
      ...f.binding(),
      type: "cancel_action",
      actionId: action.actionId,
      operationId: action.operationId,
    });
    await until(() =>
      socket.sent.some(
        (v) => v.type === "action_result" && v.actionId === action.actionId,
      ),
    );
    gate.resolve();
    await delay(5);
    socket.message(f.action("after-digest"));
    await until(() =>
      socket.sent.some(
        (v) => v.type === "action_result" && v.actionId === "after-digest",
      ),
    );
    assert.equal(socket.readyState, 1);
    assert.equal(f.calls.filter((v) => v[0] === "dispatch").length, 1);
  } finally {
    gate.resolve();
    if (own) Object.defineProperty(crypto.subtle, "digest", own);
    else delete crypto.subtle.digest;
  }
});

test("a valid native-timer-sized action budget does not disconnect the shared plugin channel", async (t) => {
  const f = fixture(t),
    socket = await online(f);
  socket.message(f.lease());
  await until(() => socket.sent.some((value) => value.type === "lease_opened"));
  socket.message({ ...f.action("long-budget"), budgetMs: 2147483647 });
  await until(() =>
    socket.sent.some(
      (value) =>
        value.type === "action_result" && value.actionId === "long-budget",
    ),
  );
  assert.equal(
    socket.sent.find(
      (value) =>
        value.type === "action_result" && value.actionId === "long-budget",
    ).ok,
    true,
  );
  assert.equal(socket.readyState, 1);
  socket.message({ ...f.binding(), type: "ping" });
  await until(() => socket.sent.some((value) => value.type === "pong"));
});

test("a proven pre-admission lease rejection returns a closed receipt without disconnecting healthy leases", async (t) => {
  const f = fixture(t),
    socket = await online(f);
  const receipts = new WeakMap(),
    original = f.router.openLease;
  f.router.openLease = (input) => {
    if (input.leaseId !== "rejected") return original(input);
    const cause = new Error("The native target is already owned.");
    receipts.set(cause, {
      leaseId: input.leaseId,
      runId: input.runId,
      operationId: input.operationId,
      originalGeneration: input.generation,
      closed: true,
      rejected: true,
      code: "TAB_ALREADY_CLAIMED",
      message: "The native target is already owned.",
    });
    throw cause;
  };
  f.router.rejectedLeaseOpen = (cause) => receipts.get(cause) ?? null;
  socket.message(f.lease());
  await until(() => socket.sent.some((value) => value.type === "lease_opened"));
  socket.message({
    ...f.lease(),
    leaseId: "rejected",
    operationId: "rejected-open",
  });
  await until(() =>
    socket.sent.some(
      (value) => value.type === "lease_closed" && value.leaseId === "rejected",
    ),
  );
  const rejected = socket.sent.find(
    (value) => value.type === "lease_closed" && value.leaseId === "rejected",
  );
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.code, "TAB_ALREADY_CLAIMED");
  assert.equal(rejected.operationId, "rejected-open");
  assert.equal(
    f.values.session.nexumClosedLeases.some(
      (value) => value.leaseId === "rejected",
    ),
    true,
  );
  assert.equal(socket.readyState, 1);
  socket.message(f.action("healthy"));
  await until(() =>
    socket.sent.some(
      (value) => value.type === "action_result" && value.actionId === "healthy",
    ),
  );
  assert.equal(
    socket.sent.find(
      (value) => value.type === "action_result" && value.actionId === "healthy",
    ).ok,
    true,
  );
  assert.equal(
    f.calls.some((value) => value[0] === "end" && value[1] === "rejected"),
    false,
  );
});
