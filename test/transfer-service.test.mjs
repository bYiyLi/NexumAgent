import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AgentError } from "../dist/contracts/errors.js";
import { callerKey } from "../dist/contracts/caller.js";
import { ResourceManager } from "../dist/extensions/resources.js";
import { ArtifactStore } from "../dist/results/artifacts.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { TransferServices } from "../dist/services/transfer.js";
import { TransferOfferDelivery } from "../dist/transfer/offers.js";
import { TransferIoError } from "../dist/transfer/io.js";
import { TransferStreamSlots } from "../dist/transfer/stream-slots.js";
import { transferExtension } from "../dist/sdk/transfer.js";

const origin = {
  type: "platform",
  owner: "nexum",
  namespace: "transfer",
  version: "1",
  revision: "1",
};
const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
const caller = { principalId: "user", clientId: "host", grantId: "grant" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function until(check) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  assert.fail("The real transfer did not reach the expected state.");
}

async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-transfer-service-")),
  );
  mkdirSync(path.join(root, "work"));
  let store = new SqliteStore(root, binding);
  if (options.rejectPending || options.rejectFinish) {
    store.close();
    const db = new DatabaseSync(path.join(root, "state", "runtime.sqlite"));
    const condition = options.rejectPending
      ? "NEW.status='pending'"
      : "NEW.status='succeeded'";
    db.exec(
      `CREATE TRIGGER reject_transfer_write BEFORE UPDATE OF status ON transfers WHEN ${condition} BEGIN SELECT RAISE(ABORT,'injected write rejection'); END`,
    );
    db.close();
    store = new SqliteStore(root, binding);
  }
  const manager = new ResourceManager(store, { cleanupTimeoutMs: 40 });
  const instances = [];
  const createInstance = manager.instance.bind(manager);
  manager.instance = (...args) => {
    const instance = createInstance(...args);
    instances.push(instance);
    return instance;
  };
  const artifacts = new ArtifactStore(root, binding.agentId, {
    maxFileBytes: 1024 * 1024,
  });
  let service,
    allowed = true,
    deniedPath,
    brokenPolicy = false,
    controlOffline = options.controlOffline ?? false;
  const faults = [],
    channels = new Map(),
    runs = [],
    operations = new Set();
  const authorize = (target) => {
    if (brokenPolicy)
      throw new AgentError(
        "authorization_configuration",
        "Broken current policy.",
      );
    if (!allowed || (target.type === "path" && target.value === deniedPath))
      throw new AgentError("forbidden", "Current access denied.");
  };
  const freshClaim = (overrides = {}) => ({
    binding: { ...binding, bootId: store.bootId },
    caller,
    signal: new AbortController().signal,
    assertCurrent() {
      authorize({});
    },
    authorize,
    ...overrides,
  });
  const adapter = {
    async prepare(info, signal) {
      channels.set(info.transferId, { info, signal, used: false });
      if (options.prepareGate) await options.prepareGate.promise;
      signal.throwIfAborted();
      return {
        method: info.direction === "upload" ? "PUT" : "GET",
        url: `http://127.0.0.1:${server.address().port}/${info.transferId}?token=private-channel-token`,
        headers: {},
        expiresAt: new Date(info.claimDeadlineAt).toISOString(),
      };
    },
    async revoke(info) {
      const entry = channels.get(info.transferId);
      if (!entry) return;
      entry.revokeCalls = (entry.revokeCalls ?? 0) + 1;
      if (controlOffline)
        throw new AgentError(
          "connection_closed",
          "Synthetic control observation disconnected.",
        );
      entry.revoked = true;
      if (options.revokeGate) await options.revokeGate.promise;
      if (entry.closed) {
        if (info.direction === "upload" && !entry.req.complete)
          entry.req.destroy();
        if (info.direction === "download" && !entry.res.writableFinished)
          entry.res.destroy();
        await entry.closed;
      }
    },
  };
  const server = http.createServer((req, res) => {
    const operation = (async () => {
      const id = new URL(req.url, "http://localhost").pathname.slice(1),
        channel = channels.get(id);
      try {
        assert(channel && !channel.revoked && !channel.used);
        assert.equal(
          new URL(req.url, "http://localhost").searchParams.get("token"),
          "private-channel-token",
        );
        assert.equal(
          req.method,
          channel.info.direction === "upload" ? "PUT" : "GET",
        );
        const reservation = service.reserveClaim(id, freshClaim());
        // This fixture's atomic one-use fact is deliberately after Core permit
        // admission. The production Cloud authority is wired separately.
        channel.used = true;
        channel.claims = (channel.claims ?? 0) + 1;
        channel.req = req;
        channel.res = res;
        const endpoint = req.method === "PUT" ? req : res;
        channel.closed = new Promise((resolve) => {
          endpoint.once("close", resolve);
        });
        let closed = channel.closed;
        if (options.knownClosedFailure) {
          channel.closedFacts = {
            request: false,
            response: false,
            socket: false,
          };
          const transportClosed = Promise.all([
            channel.closed.then(() => {
              channel.closedFacts.request = true;
            }),
            new Promise((resolve) =>
              res.once("close", () => {
                channel.closedFacts.response = true;
                resolve();
              }),
            ),
            new Promise((resolve) =>
              req.socket.once("close", () => {
                channel.closedFacts.socket = true;
                resolve();
              }),
            ),
          ]);
          closed = (async () => {
            await channel.closed;
            await until(
              () =>
                store.getTransfer(id, {
                  callerKey: callerKey(caller),
                  owner: origin,
                }).metadata.fileCommitted === true,
            );
            res.writeHead(409, { Connection: "close" });
            res.end("stream_http_failed");
            await transportClosed;
            throw new TransferIoError(
              "stream_http_failed",
              "Synthetic business failure after actual HTTP closure.",
              false,
              true,
              undefined,
              new Error("HTTP business response failed"),
            );
          })();
        } else if (options.unknownClosedFailure) {
          closed = channel.closed.then(() => {
            throw new AgentError(
              "stream_close_unknown",
              "Synthetic missing local cleanup certificate.",
              { cleanupConfirmed: true },
            );
          });
        }
        const io =
          req.method === "PUT"
            ? {
                upload: req,
                ...(req.headers["content-length"] === undefined
                  ? {}
                  : { contentLength: Number(req.headers["content-length"]) }),
                closed,
              }
            : { download: res, closed };
        const snapshot = await service.commitClaim(reservation, io);
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(snapshot.status === "succeeded" ? 200 : 409);
          res.end(snapshot.status);
        }
      } catch (cause) {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(cause.code === "transfer_busy" ? 429 : 409);
          res.end(cause.code ?? "failed");
        }
      }
    })();
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const offers = new TransferOfferDelivery({
    agentId: binding.agentId,
    profileRoot: root,
    maxEntries: options.offerCapacity ?? 32,
    ...(options.now ? { now: options.now } : {}),
    authorize: (scope, view) => service.authorizeDelivery(scope, view),
  });
  const streams = new TransferStreamSlots(options.capacity ?? 4);
  service = new TransferServices(store, manager, artifacts, offers, adapter, {
    origin,
    maxBytes: 1024 * 1024,
    streams,
    ...(options.claimTimeoutMs
      ? { claimTimeoutMs: options.claimTimeoutMs }
      : {}),
    ...(options.activeTimeoutMs
      ? { activeTimeoutMs: options.activeTimeoutMs }
      : {}),
    ...(options.reservationTimeoutMs
      ? { reservationTimeoutMs: options.reservationTimeoutMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  service.on("fault", (event) => faults.push(event));
  const run = (identity = caller) => {
    const work = store.openWork({
      callerKey: callerKey(identity),
      pwd: path.join(root, "work"),
      snapshotRef: "work/snapshot",
    });
    let row = store.acceptRun({
      callerKey: callerKey(identity),
      contextId: work.contextId,
      sourceKind: "inline",
      source: {},
    }).run;
    row = store.transitionRun(row.runId, row.revision, "preparing_inputs");
    row = store.transitionRun(row.runId, row.revision, "running");
    const controller = new AbortController();
    const scope = {
      context: {
        caller: identity,
        agentId: binding.agentId,
        runId: row.runId,
        pwd: work.pwd,
      },
      runId: row.runId,
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted();
        authorize({});
      },
      authorize,
    };
    const result = { row, scope, controller, api: service.bind(scope) };
    runs.push(result);
    return result;
  };
  t.after(async () => {
    options.prepareGate?.resolve();
    options.revokeGate?.resolve();
    allowed = true;
    controlOffline = false;
    deniedPath = undefined;
    brokenPolicy = false;
    const observer = run();
    for (const item of (await observer.api.list()).transfers) {
      if (
        ![
          "succeeded",
          "failed",
          "cancelled",
          "expired",
          "interrupted",
        ].includes(item.status)
      )
        await observer.api.cancel(item.transferId).catch(() => {});
    }
    for (const channel of channels.values()) {
      channel.req?.destroy();
      channel.res?.destroy();
    }
    await Promise.allSettled(operations);
    await delay(25);
    for (const item of runs) item.controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    manager,
    artifacts,
    service,
    offers,
    streams,
    run,
    channels,
    faults,
    instances,
    freshClaim,
    setControlOffline: (value) => {
      controlOffline = value;
    },
    deny: (value) => {
      allowed = !value;
    },
    denyPath: (value) => {
      deniedPath = value;
    },
    breakPolicy: (value) => {
      brokenPolicy = value;
    },
  };
}

test("preparing is immediately observable, then pending and background are committed before issuing the Offer", async (t) => {
  const gate = Promise.withResolvers(),
    f = await fixture(t, { prepareGate: gate });
  const creator = f.run(),
    observer = f.run();
  const creation = creator.api.createUpload({
    path: "upload.bin",
    expectedSize: 3,
  });
  const preparing = await until(async () =>
    (await observer.api.list()).transfers.find(
      (item) => item.status === "preparing",
    ),
  );
  assert.equal(preparing.expiresAt, null);
  assert.equal(preparing.path, undefined);
  assert.equal(
    f.store.getResource(
      f.store.getTransfer(preparing.transferId, {
        callerKey: callerKey(caller),
        owner: origin,
      }).resourceId,
    ).lifetime,
    "run",
  );
  gate.resolve();
  const offer = await creation;
  assert.equal(offer.status, "pending");
  assert.equal(offer.maxBytes, 1024 * 1024);
  assert.equal(f.streams.active, 0);
  const row = f.store.getTransfer(offer.transferId, {
    callerKey: callerKey(caller),
    owner: origin,
  });
  assert.equal(f.store.getResource(row.resourceId).lifetime, "background");
  creator.controller.abort(new Error("Creation invocation has ended."));
  const response = await fetch(offer.request.url, {
    method: "PUT",
    body: Buffer.from("abc"),
  });
  assert.equal(response.status, 200);
  await response.text();
  const done = await observer.api.get(offer.transferId);
  assert.equal(done.status, "succeeded");
  assert.equal(done.file.sha256, hash("abc"));
  assert.equal(readFileSync(done.file.path, "utf8"), "abc");
  assert.equal(done.runId, creator.row.runId);
  assert.equal(done.contextId, creator.row.contextId);
  assert.equal(JSON.stringify(done).includes("private-channel-token"), false);
  assert.equal(f.streams.active, 0);
  assert.equal(f.store.getResource(row.resourceId).closedAt !== null, true);
});

test("download sends the fixed ArtifactStore bytes after the original file changes", async (t) => {
  const f = await fixture(t),
    owner = f.run();
  const source = path.join(f.root, "work", "source.txt");
  writeFileSync(source, "fixed original");
  const offer = await owner.api.createDownload({
    path: source,
    name: "report.txt",
    mimeType: "text/plain",
  });
  writeFileSync(source, "changed source");
  const response = await fetch(offer.request.url);
  assert.equal(await response.text(), "fixed original");
  const done = await until(async () => {
    const v = await owner.api.get(offer.transferId);
    return v.status === "succeeded" && v;
  });
  assert.equal(done.resource.uri, offer.resource.uri);
  assert.equal(
    done.progress.bytesTransferred,
    Buffer.byteLength("fixed original"),
  );
  assert.equal(Date.parse(done.startedAt) < Date.parse(done.deadlineAt), true);
  assert.equal(f.streams.active, 0);
});

test("flow exhaustion does not consume a pending HTTP URL, and preparation shares the same four slots", async (t) => {
  const f = await fixture(t),
    owner = f.run();
  const offer = await owner.api.createUpload({ path: "later.bin" });
  const permits = Array.from({ length: 4 }, () => f.streams.tryAcquire());
  const busy = await fetch(offer.request.url, { method: "PUT", body: "later" });
  assert.equal(busy.status, 429);
  assert.equal(await busy.text(), "transfer_busy");
  assert.equal(f.channels.get(offer.transferId).used, false);
  writeFileSync(path.join(f.root, "work", "source.txt"), "file");
  await assert.rejects(owner.api.createDownload({ path: "source.txt" }), {
    code: "transfer_busy",
  });
  permits.forEach((permit) => permit.release());
  const retried = await fetch(offer.request.url, {
    method: "PUT",
    body: "later",
  });
  assert.equal(retried.status, 200);
  await retried.text();
  assert.equal((await owner.api.get(offer.transferId)).status, "succeeded");
});

test("cancel returns cancelling until actual channel revocation confirms closure", async (t) => {
  const gate = Promise.withResolvers(),
    f = await fixture(t, { revokeGate: gate }),
    owner = f.run();
  const offer = await owner.api.createUpload({ path: "cancelled.bin" });
  const result = await owner.api.cancel(offer.transferId);
  assert.equal(result.accepted, true);
  assert.equal(result.transfer.status, "cancelling");
  await delay(10);
  assert.equal((await owner.api.get(offer.transferId)).finishedAt, null);
  gate.resolve();
  const done = await until(async () => {
    const item = await owner.api.get(offer.transferId);
    return item.status === "cancelled" && item;
  });
  assert.notEqual(done.finishedAt, null);
  assert.equal((await owner.api.cancel(offer.transferId)).accepted, false);
});

test("pending expiry and claimed active deadline are independent", async (t) => {
  const f = await fixture(t, { claimTimeoutMs: 500, activeTimeoutMs: 5000 }),
    owner = f.run();
  const unused = await owner.api.createUpload({ path: "unused.bin" });
  const expired = await until(async () => {
    const item = await owner.api.get(unused.transferId);
    return item.status === "expired" && item;
  });
  assert.equal(expired.startedAt, null);
  const active = await owner.api.createUpload({
    path: "active.bin",
    expectedSize: 6,
  });
  const request = http.request(active.request.url, { method: "PUT" });
  const response = once(request, "response");
  request.write("abc");
  await until(
    async () =>
      (await owner.api.get(active.transferId)).status === "transferring",
  );
  // Cross the actual fixed claim cutoff after the HTTP claim is confirmed,
  // rather than assume an 80 ms Offer survives runner scheduling and disk I/O.
  await delay(Math.max(0, Date.parse(active.expiresAt) - Date.now() + 50));
  assert.equal(Date.now() >= Date.parse(active.expiresAt), true);
  assert.equal((await owner.api.get(active.transferId)).status, "transferring");
  request.end("def");
  const [res] = await response;
  res.resume();
  await once(res, "end");
  assert.equal((await owner.api.get(active.transferId)).status, "succeeded");
});

test("active timeout aborts real input and releases its permit only after I/O closes", async (t) => {
  const f = await fixture(t, { activeTimeoutMs: 60 }),
    owner = f.run();
  const offer = await owner.api.createUpload({ path: "timeout.bin" });
  const request = http.request(offer.request.url, { method: "PUT" });
  request.on("error", () => {});
  request.write("partial");
  const done = await until(async () => {
    const item = await owner.api.get(offer.transferId);
    return item.status === "failed" && item;
  });
  assert.equal(done.error.code, "transfer_timeout");
  assert.equal(done.file, undefined);
  assert.equal(f.streams.active, 0);
});

test("a wall-clock rollback cannot extend pending expiry or admit a late claim before timers resume", async (t) => {
  let wall = Date.now();
  const f = await fixture(t, { now: () => wall, claimTimeoutMs: 500 }),
    owner = f.run();
  const offer = await owner.api.createUpload({ path: "rollback-pending.bin" });
  wall -= 60 * 60_000;
  // Real dense synchronous checks also exercise fractional elapsed time: no
  // timer can run during this turn, so admission itself must detect expiry.
  const end = performance.now() + 600;
  while (performance.now() < end) {
    try {
      const reservation = f.service.reserveClaim(
        offer.transferId,
        f.freshClaim(),
      );
      f.service.releaseReservation(reservation);
    } catch (cause) {
      assert.equal(cause.code, "transfer_not_claimable");
    }
  }
  assert.throws(
    () => f.service.reserveClaim(offer.transferId, f.freshClaim()),
    { code: "transfer_not_claimable" },
  );
  assert.equal(f.streams.active, 0);
  assert.equal(f.channels.get(offer.transferId).used, false);
  const done = await until(async () => {
    const value = await owner.api.get(offer.transferId);
    return value.status === "expired" && value;
  });
  assert.equal(done.expiresAt, offer.expiresAt);
  assert.equal(done.startedAt, null);
  assert.equal(Date.parse(done.finishedAt) >= Date.parse(done.expiresAt), true);
  assert.equal(wall < Date.parse(done.expiresAt), true);
  assert.deepEqual(f.faults, []);
});

test("an unstarted claim reservation releases its real permit after rollback without consuming the URL", async (t) => {
  let wall = Date.now();
  const f = await fixture(t, {
      now: () => wall,
      claimTimeoutMs: 2000,
      reservationTimeoutMs: 60,
    }),
    owner = f.run();
  const offer = await owner.api.createUpload({
    path: "rollback-reservation.bin",
  });
  const reservation = f.service.reserveClaim(offer.transferId, f.freshClaim());
  assert.equal(f.streams.active, 1);
  wall -= 60 * 60_000;
  await until(() => f.streams.active === 0);
  assert.equal((await owner.api.get(offer.transferId)).status, "pending");
  assert.equal(f.channels.get(offer.transferId).used, false);
  await assert.rejects(f.service.commitClaim(reservation, {}), {
    code: "invalid_transfer_reservation",
  });
  const next = f.service.reserveClaim(offer.transferId, f.freshClaim());
  f.service.releaseReservation(next);
  assert.equal(f.streams.active, 0);
  assert.deepEqual(f.faults, []);
});

test("a real active upload expires by elapsed time after an observed forward jump and rollback", async (t) => {
  const initial = Date.now();
  let wall = initial;
  const f = await fixture(t, {
      now: () => wall,
      claimTimeoutMs: 2000,
      activeTimeoutMs: 80,
    }),
    owner = f.run();
  wall += 60_000;
  const offer = await owner.api.createUpload({ path: "rollback-active.bin" });
  assert.equal(Date.parse(offer.createdAt) >= initial + 60_000, true);
  wall = initial - 60 * 60_000;
  const request = http.request(offer.request.url, { method: "PUT" });
  request.on("error", () => {});
  request.write("partial");
  const active = await until(async () => {
    const value = await owner.api.get(offer.transferId);
    return value.status === "transferring" && value;
  });
  assert.equal(
    Date.parse(active.startedAt) >= Date.parse(offer.createdAt),
    true,
  );
  assert.equal(
    Date.parse(active.deadlineAt) - Date.parse(active.startedAt),
    80,
  );
  const done = await until(async () => {
    const value = await owner.api.get(offer.transferId);
    return value.status === "failed" && value;
  });
  assert.equal(done.error.code, "transfer_timeout");
  assert.equal(done.deadlineAt, active.deadlineAt);
  assert.equal(
    Date.parse(done.finishedAt) >= Date.parse(done.deadlineAt),
    true,
  );
  assert.equal(wall < Date.parse(done.deadlineAt), true);
  assert.equal(done.file, undefined);
  assert.equal(f.streams.active, 0);
  assert.deepEqual(f.faults, []);
});

test("fresh caller/Grant/boot and target authority are required before taking any claim slot", async (t) => {
  const f = await fixture(t),
    owner = f.run(),
    offer = await owner.api.createUpload({ path: "authorized.bin" });
  for (const overrides of [
    { caller: { ...caller, grantId: "wrong" } },
    { binding: { ...binding, bootId: "old" } },
    { caller: { ...caller, clientId: "other" } },
  ]) {
    assert.throws(
      () => f.service.reserveClaim(offer.transferId, f.freshClaim(overrides)),
      { code: "transfer_claim_forbidden" },
    );
    assert.equal(f.streams.active, 0);
  }
  f.denyPath(offer.path);
  assert.throws(
    () => f.service.reserveClaim(offer.transferId, f.freshClaim()),
    { code: "forbidden" },
  );
  assert.equal(f.streams.active, 0);
  assert.equal((await owner.api.list()).transfers.length, 0);
  f.breakPolicy(true);
  await assert.rejects(owner.api.list(), {
    code: "authorization_configuration",
  });
  f.breakPolicy(false);
  f.denyPath(undefined);
  const reservation = f.service.reserveClaim(offer.transferId, f.freshClaim());
  assert.equal(f.streams.active, 1);
  f.service.releaseReservation(reservation);
  assert.equal(f.streams.active, 0);
});

test("failed handoff revokes prepared channel without publishing an Offer", async (t) => {
  const f = await fixture(t, { rejectPending: true }),
    owner = f.run();
  await assert.rejects(owner.api.createUpload({ path: "never.bin" }));
  const [record] = (await owner.api.list()).transfers;
  assert.equal(record.status, "failed");
  assert.equal(f.channels.get(record.transferId).revoked, true);
  assert.equal(f.streams.active, 0);
});

test("post-handoff delivery failure preserves the independent channel and query identity", async (t) => {
  const f = await fixture(t, { offerCapacity: 1 }),
    owner = f.run();
  await owner.api.createUpload({ path: "first.bin" });
  await assert.rejects(owner.api.createUpload({ path: "second.bin" }));
  const records = (await owner.api.list()).transfers;
  assert.equal(records.length, 2);
  assert.equal(
    records.every((item) => item.status === "pending"),
    true,
  );
  assert.equal(
    [...f.channels.values()].some((item) => item.revoked),
    false,
  );
  assert.equal(
    records.some((item) => JSON.stringify(item).includes("token")),
    false,
  );
});

test("committed upload survives a terminal SQL failure, with actual file receipt retained", async (t) => {
  const f = await fixture(t, { rejectFinish: true }),
    owner = f.run(),
    offer = await owner.api.createUpload({ path: "committed.bin" });
  const response = await fetch(offer.request.url, {
    method: "PUT",
    body: "committed",
  });
  await response.text();
  const snapshot = await owner.api.get(offer.transferId);
  assert.equal(snapshot.status, "transferring");
  assert.equal(snapshot.finishedAt, null);
  assert.equal(snapshot.file.sha256, hash("committed"));
  assert.equal(readFileSync(snapshot.file.path, "utf8"), "committed");
  assert.equal(f.streams.active, 0);
});

test("the SDK factory only normalizes and delegates the same public transfer methods", async () => {
  const extension = transferExtension(),
    calls = [],
    marker = {};
  const transfer = Object.fromEntries(
    ["createUpload", "createDownload", "get", "list", "cancel"].map((name) => [
      name,
      (...args) => {
        calls.push([name, ...args]);
        return marker;
      },
    ]),
  );
  for (const [name, args] of [
    ["createUpload", ["a.bin"]],
    ["createDownload", [{ uri: "nexum://agents/agent/resources/resource" }]],
    ["get", ["identity", { waitMs: 2 }]],
    ["list", []],
    ["cancel", ["identity"]],
  ]) {
    const method = extension.methods[name];
    assert.deepEqual(method.permissions, [`transfer.${name}`]);
    assert.equal(method.handle(method.normalize(args), { transfer }), marker);
  }
  assert.deepEqual(calls, [
    ["createUpload", { path: "a.bin" }],
    ["createDownload", { uri: "nexum://agents/agent/resources/resource" }],
    ["get", "identity", { waitMs: 2 }],
    ["list", {}],
    ["cancel", "identity"],
  ]);
});

test("a committed HTTP upload retains its file and slot through lost revoke observation, then explicit cancel shares one cleanup retry", async (t) => {
  const gate = Promise.withResolvers(),
    f = await fixture(t, { controlOffline: true, revokeGate: gate }),
    creator = f.run(),
    offer = await creator.api.createUpload({ path: "retry-committed.bin" });
  const response = await fetch(offer.request.url, {
    method: "PUT",
    body: "committed-once",
  });
  await response.text();
  const original = await creator.api.get(offer.transferId),
    row = f.store.getTransfer(offer.transferId, {
      callerKey: callerKey(caller),
      owner: origin,
    }),
    channel = f.channels.get(offer.transferId);
  assert.equal(original.status, "transferring");
  assert.equal(original.finishedAt, null);
  assert.equal(original.error.code, "connection_closed");
  assert.equal(original.file.sha256, hash("committed-once"));
  assert.equal(row.metadata.fileCommitted, true);
  assert.equal(row.bytesTransferred, Buffer.byteLength("committed-once"));
  assert.equal(f.store.getResource(row.resourceId).closedAt, null);
  assert.equal(f.streams.active, 1);
  assert.equal(channel.revokeCalls, 1);
  assert.equal(channel.claims, 1);
  const actual = f.store.getRun(creator.row.runId);
  f.store.transitionRun(actual.runId, actual.revision, "succeeded");
  creator.controller.abort();
  const observer = f.run();
  assert.equal(
    (await observer.api.get(offer.transferId)).file.revision,
    original.file.revision,
  );
  assert.equal(channel.revokeCalls, 1);
  f.setControlOffline(false);
  const [first, repeated] = await Promise.all([
    observer.api.cancel(offer.transferId),
    observer.api.cancel(offer.transferId),
  ]);
  assert.equal(first.transfer.status, "cancelling");
  assert.equal(repeated.transfer.status, "cancelling");
  await until(() => channel.revokeCalls === 2);
  assert.equal(f.streams.active, 1);
  assert.equal(f.store.getResource(row.resourceId).closedAt, null);
  gate.resolve();
  const done = await until(async () => {
    const value = await observer.api.get(offer.transferId);
    return value.finishedAt !== null && value;
  });
  assert.equal(done.status, "cancelled");
  assert.equal(done.runId, creator.row.runId);
  assert.equal(done.contextId, creator.row.contextId);
  assert.deepEqual(done.file, original.file);
  assert.equal(done.error.code, "connection_closed");
  assert.equal(
    done.progress.bytesTransferred,
    original.progress.bytesTransferred,
  );
  assert.equal(readFileSync(done.file.path, "utf8"), "committed-once");
  assert.equal(channel.claims, 1);
  assert.equal(channel.revokeCalls, 2);
  assert.notEqual(f.store.getResource(row.resourceId).closedAt, null);
  assert.equal(f.streams.active, 0);
  assert.equal((await observer.api.cancel(offer.transferId)).accepted, false);
});

test("a real ResourceManager cleanup retry can re-observe a previously disconnected channel", async (t) => {
  const f = await fixture(t, { controlOffline: true }),
    owner = f.run(),
    offer = await owner.api.createUpload({ path: "never-claimed.bin" });
  const record = f.store.getTransfer(offer.transferId, {
    callerKey: callerKey(caller),
    owner: origin,
  });
  const resources = f.instances[0].bind({
      runId: owner.row.runId,
      signal: owner.controller.signal,
      assertActive: owner.scope.assertCurrent,
      authorize: () => {},
    }),
    ref = await resources.get(record.resourceId);
  const first = await f.manager.dispose(ref);
  assert.equal(first.closedAt, null);
  assert.equal(first.status, "unconfirmed");
  assert.equal(f.channels.get(offer.transferId).revokeCalls, 1);
  f.setControlOffline(false);
  const closed = await f.manager.dispose(ref);
  assert.notEqual(closed.closedAt, null);
  const done = await until(async () => {
    const value = await owner.api.get(offer.transferId);
    return value.finishedAt && value;
  });
  assert.equal(done.status, "cancelled");
  assert.equal(f.channels.get(offer.transferId).revokeCalls, 2);
});

test("confirmed remote revoke cannot erase a download's unknown local source closure or release its actual stream slot", async (t) => {
  const f = await fixture(t),
    owner = f.run();
  writeFileSync(
    path.join(f.root, "work", "source-unknown.txt"),
    "downloaded-once",
  );
  const actualOpen = f.artifacts.open.bind(f.artifacts);
  let opens = 0;
  f.artifacts.open = async (...args) => {
    const source = await actualOpen(...args);
    opens++;
    return {
      ...source,
      closed: source.closed.then(() => {
        throw new AgentError(
          "source_close_unknown",
          "Synthetic local source cleanup uncertainty.",
        );
      }),
    };
  };
  const offer = await owner.api.createDownload({ path: "source-unknown.txt" });
  const received = await new Promise((resolve, reject) => {
    const request = http.get(offer.request.url, (response) => {
      const chunks = [];
      let error;
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", (cause) => {
        error = cause;
      });
      response.on("close", () =>
        resolve({
          bytes: Buffer.concat(chunks),
          complete: response.complete,
          error,
        }),
      );
    });
    request.on("error", reject);
  });
  assert.equal(received.bytes.toString(), "downloaded-once");
  assert.equal(received.complete, false);
  assert.equal(received.error?.code, "ECONNRESET");
  const value = await until(async () => {
    const snapshot = await owner.api.get(offer.transferId);
    return snapshot.error?.code === "transfer_cleanup_unconfirmed" && snapshot;
  });
  const record = f.store.getTransfer(offer.transferId, {
    callerKey: callerKey(caller),
    owner: origin,
  });
  assert.equal(value.status, "cancelling");
  assert.equal(value.finishedAt, null);
  assert.equal(f.store.getResource(record.resourceId).closedAt, null);
  assert.equal(f.streams.active, 1);
  assert.equal(opens, 1);
  assert.equal(f.channels.get(offer.transferId).revokeCalls, 1);
  const retry = await owner.api.cancel(offer.transferId);
  assert.equal(retry.accepted, false);
  await until(
    () =>
      f.faults.filter((item) => item.transferId === offer.transferId).length >=
      2,
  );
  const after = await owner.api.get(offer.transferId);
  assert.equal(after.status, "cancelling");
  assert.equal(after.finishedAt, null);
  assert.equal(after.error.code, "transfer_cleanup_unconfirmed");
  assert.equal(f.store.getResource(record.resourceId).closedAt, null);
  assert.equal(f.streams.active, 1);
  assert.equal(opens, 1);
});

test("a permanent terminal SQLite failure remains visible after explicit cleanup retry instead of becoming cancelled success", async (t) => {
  const f = await fixture(t, { rejectFinish: true }),
    owner = f.run(),
    offer = await owner.api.createUpload({ path: "persistent-failure.bin" }),
    response = await fetch(offer.request.url, {
      method: "PUT",
      body: "keep-this-file",
    });
  await response.text();
  const original = await owner.api.get(offer.transferId);
  assert.equal(original.error.code, "transfer_persistence_failed");
  assert.equal(original.finishedAt, null);
  assert.equal(f.streams.active, 0);
  const previous = f.faults.length;
  await assert.rejects(owner.api.cancel(offer.transferId), {
    code: "transfer_persistence_failed",
  });
  await until(() => f.faults.length > previous);
  const after = await owner.api.get(offer.transferId);
  assert.equal(after.finishedAt, null);
  assert.equal(after.error.code, "transfer_persistence_failed");
  assert.equal(after.status, "cancelling");
  assert.deepEqual(after.file, original.file);
  assert.equal(readFileSync(after.file.path, "utf8"), "keep-this-file");
  assert.equal(f.channels.get(offer.transferId).claims, 1);
  assert.equal(f.streams.active, 0);
});

test("a business failure certified after real HTTP closure fails the transfer while releasing its resource and slot, preserving committed file facts", async (t) => {
  const f = await fixture(t, { knownClosedFailure: true }),
    owner = f.run(),
    offer = await owner.api.createUpload({
      path: "closed-business-failure.bin",
    });
  const response = await fetch(offer.request.url, {
    method: "PUT",
    body: "committed-before-response-error",
  });
  assert.equal(response.status, 409);
  assert.equal(await response.text(), "stream_http_failed");
  const value = await until(async () => {
    const snapshot = await owner.api.get(offer.transferId);
    return snapshot.finishedAt !== null && snapshot;
  });
  const record = f.store.getTransfer(offer.transferId, {
    callerKey: callerKey(caller),
    owner: origin,
  });
  assert.equal(value.status, "failed");
  assert.equal(value.error.code, "stream_http_failed");
  assert.equal(value.error.details.cleanupConfirmed, true);
  assert.equal(record.metadata.fileCommitted, true);
  assert.equal(value.file.sha256, hash("committed-before-response-error"));
  assert.equal(
    readFileSync(value.file.path, "utf8"),
    "committed-before-response-error",
  );
  assert.notEqual(f.store.getResource(record.resourceId).closedAt, null);
  assert.equal(f.streams.active, 0);
  assert.deepEqual(f.channels.get(offer.transferId).closedFacts, {
    request: true,
    response: true,
    socket: true,
  });
  assert.equal(f.channels.get(offer.transferId).claims, 1);
});

test("an ordinary rejected I/O closure cannot forge a cleanup certificate through error details", async (t) => {
  const f = await fixture(t, { unknownClosedFailure: true }),
    owner = f.run(),
    offer = await owner.api.createUpload({ path: "unknown-local-close.bin" }),
    response = await fetch(offer.request.url, {
      method: "PUT",
      body: "preserve-this-commit",
    });
  await response.text();
  const value = await owner.api.get(offer.transferId),
    record = f.store.getTransfer(offer.transferId, {
      callerKey: callerKey(caller),
      owner: origin,
    });
  assert.equal(value.status, "cancelling");
  assert.equal(value.finishedAt, null);
  assert.equal(value.error.code, "stream_close_unknown");
  assert.equal(record.metadata.fileCommitted, true);
  assert.equal(readFileSync(value.file.path, "utf8"), "preserve-this-commit");
  assert.equal(f.store.getResource(record.resourceId).closedAt, null);
  assert.equal(f.streams.active, 1);
  const prior = f.faults.length;
  await owner.api.cancel(offer.transferId);
  await until(() => f.faults.length > prior);
  assert.equal((await owner.api.get(offer.transferId)).finishedAt, null);
  assert.equal(f.store.getResource(record.resourceId).closedAt, null);
  assert.equal(f.streams.active, 1);
  assert.equal(f.channels.get(offer.transferId).claims, 1);
});
