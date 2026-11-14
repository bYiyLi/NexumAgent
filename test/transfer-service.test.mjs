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
  for (let attempt = 0; attempt < 200; attempt++) {
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
  const artifacts = new ArtifactStore(root, binding.agentId, {
    maxFileBytes: 1024 * 1024,
  });
  let service,
    allowed = true,
    deniedPath,
    brokenPolicy = false;
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
        channel.req = req;
        channel.res = res;
        const endpoint = req.method === "PUT" ? req : res;
        channel.closed = new Promise((resolve) => {
          endpoint.once("close", resolve);
        });
        const io =
          req.method === "PUT"
            ? {
                upload: req,
                ...(req.headers["content-length"] === undefined
                  ? {}
                  : { contentLength: Number(req.headers["content-length"]) }),
                closed: channel.closed,
              }
            : { download: res, closed: channel.closed };
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
    freshClaim,
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
  const f = await fixture(t, { claimTimeoutMs: 80, activeTimeoutMs: 500 }),
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
  await delay(110);
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
