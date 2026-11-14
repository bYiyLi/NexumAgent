import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";
import { BrowserService } from "../dist/extension/service.js";
import { pack, frames } from "../dist/extension/protocol.js";
const extensionId = "a".repeat(32);
async function fixture(t) {
  const work = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-browser-service-")),
  );
  const service = new BrowserService({
    work,
    port: 0,
    profile: "development",
    extensionId,
    extensionVersion: "0.1.0",
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await service.dispose();
    await service.closed;
    rmSync(work, { recursive: true, force: true });
  });
  return { work, service, sockets };
}
async function connect(
  f,
  {
    profileId = "profile-one",
    client = "worker",
    attempt = 1,
    session = "browser-session",
  } = {},
) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${f.service.address.port}/nexum-browser/v1`,
    { origin: `chrome-extension://${extensionId}` },
  );
  f.sockets.push(socket);
  socket.on("error", () => {});
  const buffered = [],
    waiters = [];
  socket.on("message", (raw, binary) => {
    if (binary) return;
    const value = JSON.parse(raw);
    const waiter = waiters.find((item) => item.type === value.type);
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else buffered.push(value);
  });
  const next = (type) => {
    const index = buffered.findIndex((item) => item.type === type);
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(entry), 1);
          reject(new Error(`No ${type} response`));
        }, 1000),
      };
      waiters.push(entry);
    });
  };
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      profile: "development",
      extensionId,
      extensionVersion: "0.1.0",
      protocol: { min: 1, max: 1 },
      browserProfileId: profileId,
      browserSessionId: session,
      clientInstanceId: client,
      attemptSequence: attempt,
      metadata: { name: "Native fixture", versionSource: "unknown" },
    }),
  );
  return {
    socket,
    next,
    send: (message) => socket.send(JSON.stringify(message)),
    async ready() {
      const ready = await next("ready");
      return {
        ...ready,
        send: (message) =>
          socket.send(
            JSON.stringify({
              v: 1,
              ...message,
              connectionId: ready.connectionId,
              generation: ready.generation,
            }),
          ),
        target: {
          browserId: ready.browserId,
          bootId: ready.bootId,
          browserSessionId: ready.browserSessionId,
          generation: ready.generation,
          tabId: "1",
        },
      };
    },
  };
}
function snapshot(
  peer,
  ready,
  items = [
    { id: "1", title: "Native", url: "https://example.test/", pageVersion: 1 },
  ],
) {
  ready.send({
    type: "tabs",
    snapshotId: `snapshot-${Math.random()}`,
    index: 0,
    total: 1,
    items,
  });
}
async function until(check) {
  const end = Date.now() + 1500;
  while (!check()) {
    assert.ok(Date.now() < end, "state did not settle");
    await delay(5);
  }
}
function action(service, ready, overrides = {}) {
  return service.action(service.get(ready.browserId), {
    method: "tab.title",
    args: { target: ready.target },
    target: ready.target,
    runId: "run-one",
    operationId: "operation-one",
    leaseId: "lease",
    budgetMs: 500,
    signal: new AbortController().signal,
    ...overrides,
  });
}

test("cold disposal, native listening, exact extension Origin and complete atomic snapshots", async (t) => {
  const cold = await fixture(t);
  assert.equal(cold.service.address, null);
  await cold.service.dispose();
  await cold.service.closed;
  assert.throws(() => cold.service.start(new AbortController().signal), {
    code: "EXTENSION_OFFLINE",
  });
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  assert.ok(f.service.address.port > 0);
  const denied = new WebSocket(
    `ws://127.0.0.1:${f.service.address.port}/nexum-browser/v1`,
    { origin: "https://webpage.invalid" },
  );
  f.sockets.push(denied);
  assert.match((await once(denied, "error"))[0].message, /403/);
  const peer = await connect(f),
    ready = await peer.ready();
  ready.send({
    type: "tabs",
    snapshotId: "two-parts",
    index: 0,
    total: 2,
    items: [{ id: "1" }],
  });
  await delay(10);
  assert.equal(f.service.get(ready.browserId).tabs.size, 0);
  assert.equal(f.service.get(ready.browserId).tabsReady, false);
  const waiting = f.service.waitSnapshot(
    f.service.get(ready.browserId),
    "tabs",
    new AbortController().signal,
  );
  ready.send({
    type: "tabs",
    snapshotId: "two-parts",
    index: 1,
    total: 2,
    items: [{ id: "2" }],
  });
  await waiting;
  assert.equal(f.service.get(ready.browserId).tabs.size, 2);
  assert.equal(f.service.get(ready.browserId).tabsReady, true);
});
test("healthy profile conflicts are explicit and old close or cleanup receipts cannot remove a new generation", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const first = await connect(f),
    a = await first.ready();
  const conflict = await connect(f, { client: "another-worker" });
  assert.equal((await conflict.next("error")).code, "PROFILE_CONFLICT");
  assert.equal(f.service.get(a.browserId).generation, 1);
  const replacement = await connect(f, { attempt: 2 }),
    b = await replacement.ready();
  assert.equal(b.browserId, a.browserId);
  assert.equal(b.generation, 2);
  await delay(10);
  assert.equal(f.service.get(b.browserId).generation, 2);
  b.send({
    type: "lease_closed",
    leaseId: "old-boot-receipt",
    runId: "old-run",
    operationId: "old-operation",
    originalGeneration: 9,
  });
  await delay(10);
  assert.equal(replacement.socket.readyState, WebSocket.OPEN);
  assert.equal(f.service.list().length, 1);
});
test("real binary responses hydrate only after full validation and malformed result rejects its pending action", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const peer = await connect(f),
    ready = await peer.ready();
  snapshot(peer, ready);
  await until(() => f.service.get(ready.browserId).tabsReady);
  const pending = action(f.service, ready),
    request = await peer.next("action"),
    packed = pack(
      { bytes: Buffer.alloc(2 * 1024 * 1024, 21) },
      {
        actionId: request.actionId,
        operationId: request.operationId,
        generation: request.generation,
      },
    );
  for (const stream of packed.streams) {
    ready.send({ type: "binary_start", ...stream.meta });
    for (const frame of frames(stream.meta, stream.bytes))
      peer.socket.send(frame, { binary: true });
    ready.send({ type: "binary_end", ...stream.meta });
  }
  ready.send({
    type: "action_result",
    actionId: request.actionId,
    operationId: request.operationId,
    ok: true,
    value: packed.value,
    attachments: packed.attachments,
  });
  const result = await pending;
  assert.equal(result.bytes.length, 2 * 1024 * 1024);
  assert.equal(result.bytes[0], 21);
  const broken = action(f.service, ready),
    second = await peer.next("action");
  ready.send({
    type: "action_result",
    actionId: second.actionId,
    operationId: second.operationId,
    ok: true,
    value: null,
    attachments: [{ streamId: "missing", path: [] }],
  });
  await assert.rejects(broken, { code: "PROTOCOL_MISMATCH" });
});
test("timeout retains unknown effect and late original bytes do not poison unrelated actions", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const peer = await connect(f),
    ready = await peer.ready();
  snapshot(peer, ready);
  await until(() => f.service.get(ready.browserId).tabsReady);
  const pending = action(f.service, ready, { budgetMs: 20 }),
    request = await peer.next("action");
  await assert.rejects(
    pending,
    (cause) => cause.code === "TIMEOUT" && cause.effect === "unknown",
  );
  const packed = pack(Buffer.alloc(100000, 2), {
    actionId: request.actionId,
    operationId: request.operationId,
    generation: request.generation,
  });
  for (const stream of packed.streams) {
    ready.send({ type: "binary_start", ...stream.meta });
    for (const frame of frames(stream.meta, stream.bytes))
      peer.socket.send(frame, { binary: true });
    ready.send({ type: "binary_end", ...stream.meta });
  }
  ready.send({
    type: "action_result",
    actionId: request.actionId,
    operationId: request.operationId,
    ok: true,
    value: packed.value,
    attachments: packed.attachments,
  });
  await delay(10);
  assert.equal(peer.socket.readyState, WebSocket.OPEN);
  const next = action(f.service, ready),
    second = await peer.next("action");
  ready.send({
    type: "action_result",
    actionId: second.actionId,
    operationId: second.operationId,
    ok: true,
    value: "next real result",
  });
  assert.equal(await next, "next real result");
});

test("browser identities become visible only after serial durable publication and failed persistence can be retried", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const destination = path.join(f.work, ".nexum-browser", "profiles.json");
  mkdirSync(destination);
  const rejected = await connect(f);
  assert.ok(
    ["EISDIR", "EEXIST", "EPERM", "EACCES"].includes(
      (await rejected.next("error")).code,
    ),
  );
  assert.deepEqual(f.service.list(), []);
  rmSync(destination, { recursive: true });
  const [one, two] = await Promise.all([
    connect(f, { profileId: "profile-one", client: "worker-one" }),
    connect(f, { profileId: "profile-two", client: "worker-two" }),
  ]);
  const [a, b] = await Promise.all([one.ready(), two.ready()]);
  assert.notEqual(a.browserId, b.browserId);
  assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), {
    "profile-one": a.browserId,
    "profile-two": b.browserId,
  });
});
