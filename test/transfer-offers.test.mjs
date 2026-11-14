import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

// Local result/authority integrations; no HTTP channel, Cloud Grant transport,
// registration or background handoff is claimed by the delivery helper.
const dist = new URL(
  process.env.NEXUM_TRANSFER_TEST_DIST ?? "../dist/",
  import.meta.url,
);
const [
  {
    TransferOfferDelivery,
    transferOffer,
    rebuildTransferOffer,
    transferSafeJSON,
  },
  { ArtifactStore },
  { ResultEncoder },
  { createOutput },
  { normalizeData },
  { SqliteStore },
  { RunEngine, callerKey },
  { ModuleLoader },
  { ScriptCatalog },
  { ResourceManager },
  { ExtensionRegistry },
  { AgentError },
] = await Promise.all(
  [
    "transfer/offers.js",
    "results/artifacts.js",
    "results/encoder.js",
    "sdk/output.js",
    "results/normalize.js",
    "storage/sqlite.js",
    "runtime/engine.js",
    "runtime/modules.js",
    "runtime/scripts.js",
    "extensions/resources.js",
    "extensions/registry.js",
    "contracts/errors.js",
  ].map((file) => import(new URL(file, dist))),
);
const secret = "synthetic-transfer-secret-only-test-42";
const caller = {
  principalId: "user",
  clientId: "client",
  grantId: "grant-original",
  host: "local-test",
};
const run = { runId: "run_offer", status: "succeeded" };
function assertSafe(value) {
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(JSON.stringify(value).includes("?token="), false);
}
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(root, entry.name))
      : [path.join(root, entry.name)],
  );
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-transfer-offer-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  let now = 1800000000000,
    allowed = true;
  const authorizations = [],
    logs = [],
    progress = [];
  const scope = (grantId = caller.grantId, services) => ({
    ownerKey: callerKey(caller),
    grantId,
    pwd: work,
    runId: services?.runId ?? run.runId,
    ...(services ? { signal: services.signal } : {}),
    assertCurrent() {
      services?.assertCurrent();
    },
    authorize(target) {
      if (target.resource && target.resource.ownerKey !== callerKey(caller))
        throw new AgentError("forbidden", "Wrong resource owner.");
    },
  });
  const artifacts = new ArtifactStore(root, "agent", { now: () => now });
  const authorize = (current, snapshot) => {
    authorizations.push({
      grantId: current.grantId,
      transferId: snapshot.transferId,
    });
    if (!allowed) throw new AgentError("forbidden", `Denied ${secret}`);
    options.authorize?.(current, snapshot);
  };
  const delivery = new TransferOfferDelivery({
    agentId: "agent",
    profileRoot: root,
    now: () => now,
    authorize,
    ...options.delivery,
  });
  const encoder = new ResultEncoder(artifacts, options.limits, delivery),
    output = createOutput(work, () => {});
  const snapshot = (id, extra = {}) => ({
    transferId: id,
    direction: "upload",
    status: "pending",
    runId: run.runId,
    contextId: "ctx_offer",
    projectId: null,
    ...(extra.direction === "download"
      ? {}
      : { path: path.join(work, "target.bin") }),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600000).toISOString(),
    progress: { bytesTransferred: 0, totalBytes: null },
    ...extra,
  });
  const request = (data) => ({
    method: data.direction === "download" ? "GET" : "PUT",
    url: `https://transfer.example.test/channels/${data.transferId}?token=${secret}`,
    headers:
      data.direction === "upload"
        ? { "Content-Type": "application/octet-stream" }
        : {},
    expiresAt: data.expiresAt,
  });
  const issue = (id = "tr_upload", extra = {}, current = scope()) => {
    const data = snapshot(id, extra);
    return delivery.issue(data, request(data), current);
  };
  let store, registry, engine, context, handle;
  if (options.runtime) {
    store = new SqliteStore(root, {
      agentId: "agent",
      profile: "development",
      cloudEnvironment: "test",
    });
    const resources = new ResourceManager(store, { cleanupTimeoutMs: 20 });
    registry = new ExtensionRegistry(resources, {
      permissions: new Set(["transfer"]),
      authorize() {},
      log(...args) {
        logs.push(args);
      },
      progress(...args) {
        progress.push(args);
      },
    });
    const loader = await ModuleLoader.create(work, store.bootId, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    });
    const scripts = new ScriptCatalog(work, "agent", () => []);
    writeFileSync(path.join(work, "snapshot.json"), '{"project":null}');
    context = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "work/snapshot.json",
    });
    engine = new RunEngine(store, loader, scripts, {
      authorize(who, target) {
        if (target.run && target.run.callerKey !== callerKey(who))
          throw new AgentError("forbidden", "Wrong run owner.");
      },
      loadWork: (item) =>
        JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
      encodeResult: (value, services) =>
        encoder.encode(value, scope(services.context.caller.grantId, services)),
      bindings: (services) => ({
        ...registry.bindings(services),
        output: createOutput(work, () => services.assertCurrent()),
      }),
      resources,
    });
  }
  t.after(async () => {
    if (handle) await registry.disable(handle);
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    scope,
    artifacts,
    delivery,
    encoder,
    output,
    snapshot,
    request,
    issue,
    authorizations,
    logs,
    progress,
    engine,
    advance(ms) {
      now += ms;
    },
    revoke() {
      allowed = false;
    },
    grant() {
      allowed = true;
    },
    async download(id = "tr_download") {
      const resource = await artifacts.register(
        {
          data: Buffer.from("fixed report"),
          name: "report.txt",
          mimeType: "text/plain",
        },
        scope(),
      );
      return issue(id, { direction: "download", resource });
    },
    async extension(methods) {
      handle = await registry.prepare(
        {
          apiVersion: 1,
          origin: {
            type: "extension",
            owner: "@test/transfer",
            namespace: "demo",
            version: "1",
            revision: "one",
          },
          permissions: ["transfer"],
          config: {},
        },
        () => ({
          methods: Object.fromEntries(
            Object.entries(methods).map(([name, handle]) => [
              name,
              {
                description: "受控传输结果测试",
                permissions: ["transfer"],
                schemaDialect: "draft7",
                inputSchema: { type: "object" },
                handle,
              },
            ]),
          ),
        }),
      );
      registry.publish(handle);
    },
    start(script, waitMs = 3000) {
      return engine.start(caller, {
        contextId: context.contextId,
        script,
        waitMs,
      });
    },
  };
}
function delivered(response) {
  return response.structuredContent.delivery.transfers;
}

test("issued Offer keeps its script-readable request but identity and safe serializers cannot be forged", async (t) => {
  const f = await fixture(t),
    offer = f.issue();
  assert.ok(offer.request.url.includes(secret));
  assert.equal(Object.isFrozen(offer.request.headers), true);
  assert.equal(transferOffer(offer).snapshot.transferId, offer.transferId);
  assertSafe(JSON.parse(JSON.stringify(offer)));
  assert.equal(inspect({ nested: [offer] }).includes(secret), false);
  assert.equal(transferOffer({ ...offer }), null);
  assert.equal(transferOffer(Object.create(offer)), null);
  let traps = 0;
  const proxy = new Proxy(offer, {
    get() {
      traps++;
      throw Error("hook");
    },
  });
  assert.equal(transferOffer(proxy), null);
  assert.equal(traps, 0);
  const rebuilt = rebuildTransferOffer(
    offer,
    JSON.parse(JSON.stringify(offer)),
  );
  assert.ok(transferOffer(rebuilt));
  assert.equal(rebuilt.request, offer.request);
  assert.throws(
    () =>
      rebuildTransferOffer(offer, {
        ...transferOffer(offer).snapshot,
        transferId: "other",
      }),
    { code: "invalid_transfer_offer" },
  );
  assert.equal(
    transferSafeJSON({ explicitlyCopied: offer.request.url }).includes(secret),
    true,
  );
});

test("delivery reuses the same request and deadline only for the current matching verified Grant", async (t) => {
  const f = await fixture(t),
    offer = f.issue(),
    ref = transferOffer(offer).reference;
  const first = f.delivery.deliver(ref, f.scope());
  f.advance(1000);
  const second = f.delivery.deliver(ref, f.scope());
  assert.equal(first.available, true);
  assert.equal(second.request, first.request);
  assert.equal(second.request.expiresAt, offer.expiresAt);
  assert.equal(f.authorizations.length, 3);
  assert.deepEqual(f.delivery.deliver(ref, f.scope("different-grant")), {
    transferId: offer.transferId,
    available: false,
    reason: "binding_mismatch",
  });
  assertSafe(
    f.delivery.deliver(ref, { ...f.scope(), ownerKey: "someone-else" }),
  );
  assertSafe(f.delivery.deliver(ref, { ...f.scope(), grantId: undefined }));
  assert.equal(
    f.delivery.deliver(ref, { ...f.scope(), grantId: undefined }).available,
    false,
  );
  assert.throws(
    () => f.issue("no_grant", {}, { ...f.scope(), grantId: undefined }),
    { code: "transfer_grant_required" },
  );
  f.revoke();
  assert.deepEqual(f.delivery.deliver(ref, f.scope()), {
    transferId: offer.transferId,
    available: false,
    reason: "authorization_denied",
  });
  f.grant();
  assert.equal(f.delivery.deliver(ref, f.scope()).request, first.request);
});

test("consumption, terminal state, expiry and memory loss return safe information without issuing replacements", async (t) => {
  const f = await fixture(t),
    offer = f.issue(),
    ref = transferOffer(offer).reference;
  assert.equal(f.issue().request, offer.request);
  f.delivery.forget(offer.transferId, "consumed");
  assert.deepEqual(f.delivery.deliver(ref, f.scope()), {
    transferId: offer.transferId,
    available: false,
    reason: "consumed",
  });
  assert.throws(() => f.issue(), { code: "transfer_offer_conflict" });
  const terminal = f.issue("terminal");
  f.delivery.forget(terminal.transferId, "terminal");
  assertSafe(f.delivery.deliver(transferOffer(terminal).reference, f.scope()));
  const pending = f.issue("memory_loss");
  const restarted = new TransferOfferDelivery({
    agentId: "agent",
    profileRoot: f.root,
    authorize() {},
  });
  assert.equal(
    restarted.deliver(transferOffer(pending).reference, f.scope()).available,
    false,
  );
  f.advance(600000);
  assert.deepEqual(f.delivery.deliver(ref, f.scope()), {
    transferId: offer.transferId,
    available: false,
    reason: "expired",
  });
});

test("the per-profile cache is bounded and absent, boolean or asynchronous authorization cannot grant delivery", async (t) => {
  const f = await fixture(t, { delivery: { maxEntries: 2 } });
  const first = f.issue("one");
  f.issue("two");
  assert.throws(() => f.issue("three"), { code: "transfer_delivery_busy" });
  f.delivery.forget(first.transferId, "consumed");
  assert.ok(f.issue("three"));
  for (const authorize of [undefined, () => true, async () => true]) {
    const delivery = new TransferOfferDelivery({
      agentId: "agent",
      profileRoot: f.root,
      authorize,
    });
    const data = f.snapshot("denied");
    assert.throws(
      () => delivery.issue(data, f.request(data), f.scope()),
      (error) => {
        assertSafe(error);
        return [
          "transfer_authorization_unavailable",
          "transfer_not_authorized",
        ].includes(error.code);
      },
    );
  }
  assert.throws(
    () =>
      new ResultEncoder(
        f.artifacts,
        {},
        new TransferOfferDelivery({
          agentId: "different",
          profileRoot: f.root,
        }),
      ),
    { code: "result_profile_mismatch" },
  );
});

test("Offer-safe logs replace only authentic Offers and never invoke arbitrary hooks", async (t) => {
  const f = await fixture(t),
    offer = f.issue();
  const safe = JSON.parse(
    transferSafeJSON({ level: "info", data: { one: offer, list: [offer] } }),
  );
  assertSafe(safe);
  assert.equal(safe.data.one.transferId, offer.transferId);
  let hooks = 0;
  const object = { ok: true };
  Object.defineProperty(object, "toJSON", {
    get() {
      hooks++;
      throw Error("hook");
    },
  });
  assert.deepEqual(JSON.parse(transferSafeJSON(object)), { ok: true });
  Object.defineProperty(object, "value", {
    enumerable: true,
    get() {
      hooks++;
      throw Error("hook");
    },
  });
  assert.throws(() => transferSafeJSON(object));
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        hooks++;
        throw Error("hook");
      },
    },
  );
  assert.throws(() => transferSafeJSON({ proxy }));
  assert.equal(hooks, 0);
  assert.throws(() => transferSafeJSON({ text: "A".repeat(20000) }));
});

test("one normalizer walk preserves nested structure, pure data and explicit mixed content without persisting requests", async (t) => {
  const f = await fixture(t),
    offer = f.issue();
  for (const value of [
    { normal: 1, nested: [offer, { again: offer }] },
    new Map([
      ["offer", offer],
      ["set", new Set([offer])],
    ]),
    f.output.json({ nested: offer }),
    f.output.result({
      content: [f.output.text("prepared"), offer],
      structuredContent: { another: offer },
    }),
  ]) {
    const saved = await f.encoder.encode(value, f.scope());
    assertSafe(saved);
    assert.equal(saved.transferOffers.length, 1);
    const restored = JSON.parse(JSON.stringify(saved));
    const response = await f.encoder.render(restored, f.scope(), run);
    assert.equal(delivered(response).length, 1);
    assert.equal(delivered(response)[0].request.url, offer.request.url);
    assertSafe(restored);
    assertSafe(saved);
  }
  await assert.rejects(normalizeData(offer), {
    code: "result_transfer_resolver_required",
  });
  await assert.rejects(f.encoder.encode(offer, f.scope("different-grant")), {
    code: "transfer_offer_binding_mismatch",
  });
});

test("download Offers use registered MCP resource links and never follow a suspicious source URI", async (t) => {
  const f = await fixture(t);
  const resource = await f.artifacts.register(
    {
      data: Buffer.from("fixed report"),
      name: "report.txt",
      mimeType: "text/plain",
    },
    f.scope(),
  );
  const offer = f.issue("download", { direction: "download", resource });
  const saved = await f.encoder.encode(offer, f.scope());
  assertSafe(saved);
  const response = await f.encoder.render(saved, f.scope(), run);
  assert.equal(
    response.content.find((item) => item.type === "resource_link").uri,
    resource.uri,
  );
  assert.equal(delivered(response)[0].request.url, offer.request.url);
  assert.throws(
    () =>
      f.issue("bad_uri", {
        direction: "download",
        resource: { uri: `https://untrusted.example/?token=${secret}` },
      }),
    (error) => {
      assertSafe(error);
      return error.code === "invalid_transfer_resource";
    },
  );
});

test("context fallback keeps safe references and current delivery merges without overwriting context-budget facts", async (t) => {
  const f = await fixture(t),
    offer = f.issue();
  const saved = await f.encoder.encode(
    { text: "large".repeat(20000), offer },
    f.scope(),
  );
  assert.equal(saved.delivery.complete, false);
  assert.equal(saved.delivery.reason, "context_budget");
  assertSafe(saved);
  const response = await f.encoder.render(saved, f.scope(), run);
  assert.equal(response.structuredContent.delivery.complete, false);
  assert.equal(response.structuredContent.delivery.reason, "context_budget");
  assert.equal(delivered(response)[0].available, true);
  const unconfigured = new ResultEncoder(f.artifacts);
  assert.equal(
    delivered(await unconfigured.render(saved, f.scope(), run))[0].available,
    false,
  );
  assertSafe(await unconfigured.render(saved, f.scope(), run));
  assertSafe(
    await f.encoder.render(saved, { ...f.scope(), grantId: undefined }, run),
  );
});

test("reference and final-response budgets reject clearly without echoing credentials or mutating safe history", async (t) => {
  const f = await fixture(t),
    offer = f.issue();
  const tiny = new ResultEncoder(f.artifacts, { textBytes: 128 }, f.delivery);
  await assert.rejects(tiny.encode(offer, f.scope()), (error) => {
    assertSafe(error);
    return error.code === "result_transfer_too_large";
  });
  const saved = await f.encoder.encode(offer, f.scope());
  const response = await f.encoder.render(saved, f.scope(), run);
  const maximum = Buffer.byteLength(JSON.stringify(response));
  await assert.rejects(
    f.encoder.render(saved, f.scope(), run, { maxResponseBytes: maximum - 1 }),
    (error) => {
      assertSafe(error);
      return error.code === "mcp_response_too_large";
    },
  );
  const duplicated = JSON.parse(JSON.stringify(saved));
  duplicated.transferOffers.push(duplicated.transferOffers[0]);
  await assert.rejects(f.encoder.render(duplicated, f.scope(), run), {
    code: "invalid_saved_result",
  });
  assertSafe(saved);
});

test("a successful claim during current authorization cannot leave an already-consumed request available", async (t) => {
  let claimed = false,
    f;
  f = await fixture(t, {
    authorize(_scope, snapshot) {
      if (claimed) f.delivery.forget(snapshot.transferId, "consumed");
    },
  });
  const offer = f.issue(),
    ref = transferOffer(offer).reference;
  claimed = true;
  assert.deepEqual(f.delivery.deliver(ref, f.scope()), {
    transferId: offer.transferId,
    available: false,
    reason: "consumed",
  });
  assertSafe(f.delivery.deliver(ref, f.scope()));
  claimed = false;
  const download = await f.download("claimed_during_resource_io");
  const saved = await f.encoder.encode(download, f.scope());
  const metadata = f.artifacts.metadata;
  t.mock.method(f.artifacts, "metadata", async function (...args) {
    const result = await Reflect.apply(metadata, this, args);
    f.delivery.forget(download.transferId, "consumed");
    return result;
  });
  const response = await f.encoder.render(saved, f.scope(), run);
  assert.equal(delivered(response)[0].available, false);
  assertSafe(response);
});

test("Registry native copies retain Offer identity while platform logs, operations, result JSON and run console stay safe", async (t) => {
  const f = await fixture(t, { runtime: true });
  await f.extension({
    create(_input, call) {
      const offer = f.issue("registry");
      call.log({
        level: "info",
        message: "prepared",
        data: { offer, list: [offer] },
      });
      call.progress({ offer });
      return { offer, again: [offer] };
    },
    mixed(_input, call) {
      const offer = f.issue("mixed");
      return call.output.result({
        content: [call.output.text("ready"), offer],
        structuredContent: { nested: offer },
      });
    },
    fail() {
      const offer = f.issue("failed_operation");
      throw new AgentError("prepared_then_failed", "Synthetic failure", {
        offer,
      });
    },
  });
  const completed = await f.start(
    'const value=await demo.create({});if(typeof value.offer.request.url!=="string")throw Error("missing request");console.log(value);return value;',
  );
  assert.equal(completed.run.status, "succeeded");
  assertSafe(completed.result);
  assert.equal(completed.result.transferOffers.length, 1);
  assertSafe(f.logs);
  assertSafe(f.progress);
  const response = await f.encoder.render(
    completed.result,
    f.scope(),
    completed.run,
  );
  assert.equal(delivered(response)[0].available, true);
  const mixed = await f.start("return demo.mixed({});");
  assert.equal(mixed.run.status, "succeeded");
  assertSafe(mixed.result);
  const failed = await f.start("return demo.fail({});");
  assert.equal(failed.run.status, "failed");
  assertSafe(failed.run.error);
  assertSafe(failed.operations);
  for (const filename of files(f.root))
    assert.equal(
      readFileSync(filename).includes(Buffer.from(secret)),
      false,
      path.relative(f.root, filename),
    );
});

test("a short initial observation returns the run identity and a later same-Grant get can deliver that original request", async (t) => {
  const f = await fixture(t, { runtime: true }),
    gate = Promise.withResolvers();
  let original;
  await f.extension({
    async delayed() {
      await gate.promise;
      original = f.issue("delayed");
      return original;
    },
  });
  const first = await f.start("return demo.delayed({});", 0);
  assert.ok(first.run.runId);
  assert.equal(first.result, null);
  gate.resolve();
  const finished = await f.engine.observe(caller, first.run.runId, 3000);
  assert.equal(finished.run.status, "succeeded");
  assertSafe(finished.result);
  const deliveredOnce = await f.encoder.render(
    finished.result,
    f.scope(),
    finished.run,
  );
  const repeatedHistory = await f.engine.observe(caller, first.run.runId);
  const deliveredTwice = await f.encoder.render(
    repeatedHistory.result,
    f.scope(),
    repeatedHistory.run,
  );
  assert.equal(
    delivered(deliveredOnce)[0].request,
    delivered(deliveredTwice)[0].request,
  );
  assert.equal(delivered(deliveredTwice)[0].request.url, original.request.url);
  assertSafe(
    await f.encoder.render(
      repeatedHistory.result,
      f.scope("new-grant"),
      repeatedHistory.run,
    ),
  );
  f.delivery.forget(original.transferId, "consumed");
  assertSafe(
    await f.encoder.render(
      repeatedHistory.result,
      f.scope(),
      repeatedHistory.run,
    ),
  );
  assert.equal(
    (await f.engine.observe(caller, first.run.runId)).run.status,
    "succeeded",
  );
});
