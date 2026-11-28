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
const assetRevision = "b".repeat(64);
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
    assetRevision,
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
    profile = "development",
    pluginVersion = "0.1.0",
    pluginRevision = assetRevision,
    protocol = { min: 1, max: 1 },
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
      profile,
      extensionId,
      extensionVersion: pluginVersion,
      ...(pluginRevision === null ? {} : { assetRevision: pluginRevision }),
      protocol,
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

test("Node sends bound wakeups only while a peer has an active action", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const peer = await connect(f),
    ready = await peer.ready(),
    idle = await connect(f, { profileId: "idle-profile" });
  await idle.ready();
  snapshot(peer, ready);
  await until(() => f.service.get(ready.browserId).tabsReady);
  let idlePings = 0,
    activePings = 0;
  idle.socket.on("message", (raw, binary) => {
    if (!binary && JSON.parse(raw).type === "ping") idlePings++;
  });
  peer.socket.on("message", (raw, binary) => {
    if (!binary && JSON.parse(raw).type === "ping") activePings++;
  });
  const pending = action(f.service, ready, { budgetMs: 5000 }),
    request = await peer.next("action"),
    ping = await peer.next("ping");
  assert.equal(ping.connectionId, ready.connectionId);
  assert.equal(ping.generation, ready.generation);
  assert.equal(idlePings, 0);
  ready.send({
    type: "action_result",
    actionId: request.actionId,
    operationId: request.operationId,
    ok: true,
    value: null,
  });
  assert.equal(await pending, null);
  await delay(30);
  const afterCompletion = activePings;
  await delay(250);
  assert.equal(activePings, afterCompletion);
  assert.equal(idlePings, 0);

  const controller = new AbortController(),
    cancelled = action(f.service, ready, {
      budgetMs: 5000,
      signal: controller.signal,
    });
  await peer.next("action");
  await peer.next("ping");
  controller.abort();
  await assert.rejects(cancelled, { code: "UNKNOWN_RESULT" });
  await delay(30);
  const afterCancellation = activePings;
  await delay(250);
  assert.equal(activePings, afterCancellation);
});

test("screenshot stage diagnostics belong only to the current in-flight action", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const peer = await connect(f), ready = await peer.ready();
  snapshot(peer, ready);
  await until(() => f.service.get(ready.browserId).tabsReady);
  const browser = f.service.get(ready.browserId);
  const opening = f.service.openLease(browser, {
    id: "lease",
    runId: "run-one",
    operationId: "operation-one",
    target: ready.target,
    signal: new AbortController().signal,
    onClosed() {},
  });
  const open = await peer.next("lease_open");
  ready.send({
    type: "lease_opened",
    leaseId: open.leaseId,
    runId: open.runId,
    operationId: open.operationId,
  });
  await opening;
  const diagnostics = [];
  const publicEvents = [];
  f.service.on("browser-event", (_peer, event) => publicEvents.push(event));
  const pending = action(f.service, ready, {
    method: "tab.screenshot",
    budgetMs: 10000,
    onScreenshotStage: (progress) => diagnostics.push(progress),
  });
  const request = await peer.next("action");
  const message = {
    type: "event",
    event: "screenshot_stage",
    actionId: request.actionId,
    leaseId: request.leaseId,
    runId: request.runId,
    operationId: request.operationId,
    target: ready.target,
    stage: "capture",
    elapsedMs: 25,
  };
  ready.send({ ...message, sequence: 1, extra: "private-page-data" });
  ready.send({ ...message, sequence: 2, operationId: "other-operation" });
  ready.send({ ...message, sequence: 3, target: { ...ready.target, tabId: "2" } });
  ready.send({ ...message, sequence: 4, stage: "untrusted-stage" });
  ready.send({ ...message, sequence: 5, elapsedMs: -1 });
  ready.send({ ...message, sequence: 6, elapsedMs: 30 }); // duplicate phase
  ready.send({ ...message, sequence: 7, stage: "layout", elapsedMs: 40 }); // stale phase
  ready.send({ ...message, sequence: 8, stage: "decode", elapsedMs: 10 }); // backwards time
  ready.send({ ...message, sequence: 9, stage: "complete", elapsedMs: 80 });
  await until(() => browser.sequence === 9);
  assert.deepEqual(diagnostics, [
    { stage: "capture", elapsedMs: 25 },
    { stage: "complete", elapsedMs: 80 },
  ]);
  assert.deepEqual(publicEvents, []);
  ready.send({
    type: "action_result",
    actionId: request.actionId,
    operationId: request.operationId,
    ok: true,
    value: null,
  });
  assert.equal(await pending, null);
  ready.send({ ...message, sequence: 10, stage: "complete" });
  await until(() => browser.sequence === 10);
  assert.equal(diagnostics.length, 2, "a late event must not log against a completed action");
});

test("visual diagnostics correlate only a live lease and never log untrusted event data", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const peer = await connect(f),
    ready = await peer.ready();
  snapshot(peer, ready, [
    { id: "1", title: "Native", url: "https://example.test/", pageVersion: 1 },
    { id: "2", title: "Other", url: "https://other.test/", pageVersion: 1 },
  ]);
  await until(() => f.service.get(ready.browserId).tabsReady);
  const browser = f.service.get(ready.browserId),
    opened = f.service.openLease(browser, {
      id: "lease",
      runId: "run-one",
      operationId: "operation-one",
      target: ready.target,
      signal: new AbortController().signal,
      onClosed() {},
    });
  const open = await peer.next("lease_open");
  ready.send({
    type: "lease_opened",
    leaseId: open.leaseId,
    runId: open.runId,
    operationId: open.operationId,
  });
  await opened;
  const pending = action(f.service, ready, { budgetMs: 10000 }),
    request = await peer.next("action"),
    diagnostics = [],
    events = [];
  f.service.on("visual-diagnostic", (value) => diagnostics.push(value));
  f.service.on("browser-event", (_peer, value) => events.push(value));
  const message = {
    type: "event",
    event: "visual_degraded",
    leaseId: "lease",
    runId: "run-one",
    operationId: "operation-one",
    target: ready.target,
  };
  ready.send({ ...message, sequence: 1, reason: "VISUAL_TIMEOUT" });
  ready.send({
    ...message,
    sequence: 2,
    reason: "private-untrusted-payload",
    target: { ...ready.target, tabId: "2" },
  });
  ready.send({
    ...message,
    sequence: 3,
    runId: "other-run",
    reason: "VISUAL_TIMEOUT",
  });
  await until(() => events.length === 3);
  assert.deepEqual(diagnostics, [
    {
      browserId: ready.browserId,
      generation: ready.generation,
      runId: "run-one",
      operationId: "operation-one",
      tabId: "1",
      reason: "VISUAL_TIMEOUT",
    },
    {
      browserId: ready.browserId,
      generation: ready.generation,
      runId: "run-one",
      operationId: null,
      tabId: null,
      reason: "VISUAL_UNAVAILABLE",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|https?:/);
  ready.send({
    type: "action_result",
    actionId: request.actionId,
    operationId: request.operationId,
    ok: true,
    value: null,
  });
  assert.equal(await pending, null);
  let nested = {};
  for (let index = 0; index < 70; index++) nested = { child: nested };
  const closed = once(peer.socket, "close", {
    signal: AbortSignal.timeout(5000),
  });
  ready.send({ ...message, sequence: 4, reason: "VISUAL_TIMEOUT", nested });
  await closed;
  assert.equal(
    diagnostics.length,
    2,
    "an invalid frame must not create a visual log",
  );
});

test("closing a disconnected peer completes service cleanup without confirming its lease", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const peer = await connect(f),
    ready = await peer.ready(),
    browser = f.service.get(ready.browserId);
  let confirmedClosed = false;
  const opened = f.service.openLease(browser, {
    id: "lease",
    runId: "run-one",
    operationId: "operation-one",
    target: ready.target,
    signal: new AbortController().signal,
    onClosed() {
      confirmedClosed = true;
    },
  });
  const open = await peer.next("lease_open");
  ready.send({
    type: "lease_opened",
    leaseId: open.leaseId,
    runId: open.runId,
    operationId: open.operationId,
  });
  await opened;
  browser.socket.terminate();
  assert.notEqual(browser.socket.readyState, WebSocket.OPEN);
  await f.service.endLease("lease");
  await f.service.dispose();
  await f.service.closed;
  assert.equal(confirmedClosed, false);
});

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
  // This test transfers a 2 MiB response; the short timeout belongs to the
  // dedicated deadline test below, not to binary integrity validation.
  const pending = action(f.service, ready, { budgetMs: 10000 }),
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
  const broken = action(f.service, ready, { budgetMs: 10000 }),
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

test("protocol rejection diagnostics retain close identity without recording the rejected payload", async (t) => {
  const f = await fixture(t);
  const diagnostics = [];
  f.service.on("diagnostic", (entry) => diagnostics.push(entry));
  await f.service.start(new AbortController().signal);
  const peer = await connect(f);
  const ready = await peer.ready();
  const closed = once(peer.socket, "close");
  ready.send({
    type: "unknown-message",
    privatePayload: "fixture-private-credential-not-for-logs",
  });
  const [closeCode] = await closed;
  assert.equal(closeCode, 1008);
  const rejected = diagnostics.find(
    (entry) => entry.event === "protocol_rejected",
  );
  assert.deepEqual(rejected, {
    event: "protocol_rejected",
    browserId: ready.browserId,
    generation: ready.generation,
    code: "PROTOCOL_MISMATCH",
    closeCode: null,
    operationIds: [],
  });
  const end = Date.now() + 3000;
  while (!diagnostics.some((entry) => entry.event === "closed")) {
    assert.ok(Date.now() < end, "Native connection closure was not observed.");
    await delay(2);
  }
  assert.equal(diagnostics.at(-1).closeCode, 1008);
  assert.equal(diagnostics.at(-1).browserId, ready.browserId);
  assert.doesNotMatch(
    JSON.stringify(diagnostics),
    /fixture-private-credential/,
  );
});


test("Browser failed action without a public message explains how to inspect the unknown effect", async (t) => {
  const f = await fixture(t);
  await f.service.start(new AbortController().signal);
  const peer = await connect(f);
  const ready = await peer.ready();
  snapshot(peer, ready);
  await until(() => f.service.get(ready.browserId).tabsReady);
  const pending = action(f.service, ready, { budgetMs: 5000 });
  const request = await peer.next("action");
  ready.send({
    type: "action_result",
    actionId: request.actionId,
    operationId: request.operationId,
    ok: false,
    code: "UNKNOWN_RESULT",
    dispatched: true,
    effect: "unknown",
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "UNKNOWN_RESULT");
    assert.match(error.message, /operationId.*dispatched.*effect/);
    assert(!error.message.includes("The browser operation failed."));
    return true;
  });
});

test("hello rejects mismatched profile, plugin version and protocol with distinct safe codes", async(t)=>{
  const f=await fixture(t);
  await f.service.start(new AbortController().signal);
  for(const [options,code] of [
    [{profile:"production"},"PROFILE_MISMATCH"],
    [{pluginVersion:"9.9.9"},"PLUGIN_VERSION_MISMATCH"],
    [{pluginRevision:"c".repeat(64)},"PLUGIN_VERSION_MISMATCH"],
    [{pluginRevision:null},"PLUGIN_VERSION_MISMATCH"],
    [{pluginRevision:"bad"},"PLUGIN_VERSION_MISMATCH"],
    [{protocol:{min:2,max:2}},"PROTOCOL_MISMATCH"],
  ]){
    const peer=await connect(f,options);
    const error=await peer.next("error");
    assert.equal(error.code,code);
    assert.deepEqual(f.service.list(),[]);
    if(code==="PLUGIN_VERSION_MISMATCH") {
      assert.match(error.message,/if verified ready, reload the affected matching extension/);
      assert.match(error.message,/Do not reload stale or unverified assets/);
      assert.throws(()=>f.service.requireCurrentAssets(),{code:"PLUGIN_VERSION_MISMATCH"});
    }
  }
  const peer=await connect(f);
  const ready=await peer.ready();
  assert.equal(ready.profile,"development");
  assert.equal(ready.assetRevision,assetRevision);
  assert.doesNotThrow(()=>f.service.requireCurrentAssets());
});

test("a rejected stale build cannot replace a compatible online peer or poison another profile", async(t)=>{
  const f=await fixture(t);
  await f.service.start(new AbortController().signal);
  const current=await connect(f);
  const ready=await current.ready();
  const stale=await connect(f,{client:"old-worker",pluginRevision:"c".repeat(64)});
  assert.equal((await stale.next("error")).code,"PLUGIN_VERSION_MISMATCH");
  assert.equal(f.service.get(ready.browserId).generation,ready.generation);
  const unrelated=await connect(f,{profileId:"other-profile",pluginRevision:null});
  assert.equal((await unrelated.next("error")).code,"PLUGIN_VERSION_MISMATCH");
  assert.doesNotThrow(()=>f.service.requireCurrentAssets());
  assert.equal(f.service.list().length,1);
  current.socket.close();
  await until(()=>f.service.list().length===0);
  assert.throws(()=>f.service.get(ready.browserId),{code:"EXTENSION_OFFLINE"});
  assert.throws(()=>f.service.requireCurrentAssets(),{code:"PLUGIN_VERSION_MISMATCH"});
  const replacement=await connect(f,{profileId:"other-profile",client:"reloaded-worker"});
  assert.equal((await replacement.ready()).assetRevision,assetRevision);
  assert.doesNotThrow(()=>f.service.requireCurrentAssets());
});

test("a rejected known profile recovers its browser identity only on matching reload",async t=>{
  const f=await fixture(t);
  await f.service.start(new AbortController().signal);
  const current=await connect(f);
  const ready=await current.ready();
  current.socket.close();
  await until(()=>f.service.list().length===0);
  const old=await connect(f,{client:"old-worker",pluginRevision:null});
  assert.equal((await old.next("error")).code,"PLUGIN_VERSION_MISMATCH");
  assert.throws(()=>f.service.get(ready.browserId),{code:"PLUGIN_VERSION_MISMATCH"});
  const fresh=await connect(f,{client:"reloaded-worker"});
  const accepted=await fresh.ready();
  assert.equal(accepted.browserId,ready.browserId);
  assert.equal(accepted.generation,ready.generation+1);
  assert.doesNotThrow(()=>f.service.requireCurrentAssets());
  fresh.socket.close();
  await until(()=>f.service.list().length===0);
  assert.doesNotThrow(()=>f.service.requireCurrentAssets());
  assert.throws(()=>f.service.get(ready.browserId),{code:"EXTENSION_OFFLINE"});
});

test("a timed out outbound action stops its own byte stream after a delayed send callback", async t=>{
  const f=await fixture(t);await f.service.start(new AbortController().signal);
  const peer=await connect(f),ready=await peer.ready();
  snapshot(peer,ready);await until(()=>f.service.get(ready.browserId).tabsReady);
  const actual=f.service.get(ready.browserId),socket=actual.socket,send=socket.send;
  let release,framesSent=0,starts=0,ends=0,cancels=0;
  socket.send=function(value,...args) {
    if (typeof value==="string") {
      const message=JSON.parse(value);
      if(message.type==="binary_start") starts++;
      if(message.type==="binary_end") ends++;
      if(message.type==="cancel_action") cancels++;
      if(message.type==="action" && !release) {
        const callback=args.at(-1);
        release=()=>callback();
        // Deliver the action to the real peer, but hold the WS send callback.
        return send.call(this,value,()=>{});
      }
    } else if (Buffer.isBuffer(value)) framesSent++;
    return send.call(this,value,...args);
  };
  try {
    const original=action(f.service,ready,{budgetMs:50,args:{data:Buffer.alloc(128*1024,7)}});
    const request=await peer.next("action");
    assert.ok(request.budgetMs>0&&request.budgetMs<=50);
    await assert.rejects(original,{code:"TIMEOUT",effect:"unknown"});
    await peer.next("cancel_action");
    release();
    await delay(30);
    assert.equal(starts,0);assert.equal(ends,0);assert.equal(framesSent,0);assert.equal(cancels,1);
    const later=action(f.service,ready),next=await peer.next("action");
    ready.send({type:"action_result",actionId:next.actionId,operationId:next.operationId,ok:true,value:"current"});
    assert.equal(await later,"current");
  } finally {release?.();socket.send=send;}
});

test("cancelled lease readiness does not wait for a stalled send or fabricate native closure", async t=>{
  const f=await fixture(t);await f.service.start(new AbortController().signal);
  const peer=await connect(f),ready=await peer.ready();snapshot(peer,ready);
  await until(()=>f.service.get(ready.browserId).tabsReady);
  const actual=f.service.get(ready.browserId),socket=actual.socket,send=socket.send;
  let release,closed=0;
  socket.send=function(value,...args){
    if(typeof value==="string"&&JSON.parse(value).type==="lease_open"){
      const callback=args.at(-1);release=()=>callback();
      return send.call(this,value,()=>{});
    }
    return send.call(this,value,...args);
  };
  const abort=new AbortController(),reason=Error("cancel original lease observation");
  try{
    const lease=f.service.openLease(actual,{id:"lease-delayed",runId:"run-one",operationId:"op-open",target:ready.target,signal:abort.signal,onClosed:()=>{closed++;}});
    const request=await peer.next("lease_open");
    abort.abort(reason);
    await assert.rejects(Promise.race([lease,delay(500).then(()=>{throw Error("lease readiness stalled");})]),e=>e===reason);
    assert.equal(closed,0);
    release();
    ready.send({type:"lease_opened",leaseId:request.leaseId,runId:request.runId,operationId:request.operationId});
    await f.service.endLease(request.leaseId);
    await peer.next("lease_end");
    assert.equal(closed,0);
    ready.send({type:"lease_closed",leaseId:request.leaseId,runId:request.runId,operationId:request.operationId,originalGeneration:ready.generation});
    await until(()=>closed===1);
  } finally {release?.();socket.send=send;}
});
