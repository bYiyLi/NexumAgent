import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// Native HTTP/files/SQLite and the real configuration backend. Activation is a
// local Core port fixture, not a deployed Cloud, Browser or MCP-service claim.
const dist = new URL(
  process.env.NEXUM_CONFIGURATION_DIST ?? "../dist/",
  import.meta.url,
);
const [
  { ConfigurationMaintenanceBackend },
  { CredentialVault },
  { SqliteStore },
  { callerKey },
  { maintenanceIntent },
  { canonicalJson },
  { AgentError },
] = await Promise.all(
  [
    "maintenance/configuration.js",
    "maintenance/credentials.js",
    "storage/sqlite.js",
    "contracts/caller.js",
    "maintenance/requests.js",
    "contracts/json.js",
    "contracts/errors.js",
  ].map((file) => import(new URL(file, dist))),
);
const caller = {
  principalId: "owner",
  clientId: "config-quota",
  grantId: "grant",
};
const binding = {
  agentId: "agent",
  profile: "development",
  cloudEnvironment: "test",
};
const bytes = (value) =>
  Buffer.byteLength(
    typeof value === "string" ? value : canonicalJson(value, 64 * 1024 * 1024),
  );
const files = (root) =>
  !existsSync(root)
    ? []
    : readdirSync(root, { withFileTypes: true }).flatMap((item) =>
        item.isDirectory()
          ? files(path.join(root, item.name))
          : [path.join(root, item.name)],
      );

async function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-config-quota-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  const store = new SqliteStore(root, binding),
    context = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "unused",
    });
  const run = store.acceptRun({
    callerKey: callerKey(caller),
    contextId: context.contextId,
    sourceKind: "inline",
    source: {},
  }).run;
  const vault = await CredentialVault.open(root),
    active = new Map(),
    events = [],
    reservations = [];
  let outstanding = 0,
    limit = Infinity,
    onReserve,
    onPrepare,
    onDispose,
    failPublish = false,
    sequence = 0;
  const handles = [];
  const scope = () => ({
    caller,
    runId: run.runId,
    pwd: work,
    operationId: "scope-" + ++sequence,
    signal: new AbortController().signal,
    assertCurrent() {},
    authorize() {},
  });
  const reserve = async (size) => {
    assert.ok(Number.isSafeInteger(size) && size > 0);
    reservations.push(size);
    if (size > limit)
      throw new AgentError(
        "storage_quota_exceeded",
        "The fixed configuration cannot fit its managed-storage admission.",
      );
    await onReserve?.();
    outstanding++;
    let released = false;
    return {
      release() {
        assert.equal(released, false);
        released = true;
        outstanding--;
        events.push({ type: "release" });
      },
    };
  };
  const activation = {
    async prepare(input) {
      events.push({ type: "prepare", input });
      const handle = await open(
        path.join(root, "native-activation-" + handles.length),
        "wx",
        0o600,
      );
      handles.push(handle);
      await onPrepare?.(input);
      return {
        publish() {
          events.push({ type: "publish", input });
          if (failPublish)
            throw new AgentError(
              "publication_denied",
              "The candidate was not published.",
            );
          active.set(input.kind + ":" + input.name, input);
        },
        async dispose() {
          events.push({ type: "dispose-start", input });
          await onDispose?.(handle);
          await handle.close();
          assert.equal(handle.fd, -1);
          events.push({ type: "disposed", input });
        },
      };
    },
    async remove(input) {
      events.push({ type: "remove", input });
      active.delete(input.kind + ":" + input.name);
    },
  };
  const backend = await ConfigurationMaintenanceBackend.open({
    root,
    agentId: binding.agentId,
    profile: binding.profile,
    credentials: vault,
    activation,
    reserve,
    runtimeScope: () => scope(),
  });
  t.after(async () => {
    for (const handle of handles) await handle.close().catch(() => {});
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    work,
    store,
    backend,
    events,
    active,
    reservations,
    scope,
    setLimit: (value) => (limit = value),
    setReserveHook: (value) => (onReserve = value),
    setPrepareHook: (value) => (onPrepare = value),
    setDisposeHook: (value) => (onDispose = value),
    setPublishFailure: (value) => (failPublish = value),
    get outstanding() {
      return outstanding;
    },
    intent: (method, input) => maintenanceIntent(method, input, work),
    snapshot: (prepared) =>
      JSON.parse(
        readFileSync(
          path.join(
            root,
            "state",
            "maintenance",
            "configurations",
            "candidates",
            prepared.payload.configurationId + ".json",
          ),
          "utf8",
        ),
      ),
    approvedFile: path.join(
      root,
      "state",
      "maintenance",
      "configurations",
      "approved.json",
    ),
  };
}

async function longReferences(t) {
  const longA = "/left.json?padding=" + "a".repeat(6100),
    longB = "/right.json?padding=" + "b".repeat(6100);
  let base,
    version = "1";
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    const url = new URL(request.url, base);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/spec.json")
      response.end(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Quota source index", version },
          servers: [{ url: base + "/business" }],
          paths: {
            "/left": {
              get: {
                operationId: "left",
                responses: {
                  200: {
                    description: "Left",
                    content: {
                      "application/json": { schema: { $ref: longA } },
                    },
                  },
                },
              },
            },
            "/right": {
              get: {
                operationId: "right",
                responses: {
                  200: {
                    description: "Right",
                    content: {
                      "application/json": { schema: { $ref: longB } },
                    },
                  },
                },
              },
            },
          },
        }),
      );
    else if (url.pathname === "/left.json" || url.pathname === "/right.json")
      response.end(
        JSON.stringify({
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: false,
        }),
      );
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    source: base + "/spec.json",
    requested,
    setVersion: (value) => (version = value),
  };
}

test("long native HTTP source/reference locations are included in admission before any API publication", async (t) => {
  const f = await fixture(t),
    http = await longReferences(t),
    intent = f.intent("api.import", { name: "crm", url: http.source });
  const prepared = await f.backend.prepare(intent, f.scope()),
    snapshot = f.snapshot(prepared);
  assert.equal(snapshot.documents.length, 3);
  assert.equal(http.requested.length, 3);
  const documentBytes = snapshot.documents.reduce(
    (total, document) =>
      total + bytes(Buffer.from(document.base64, "base64").toString("utf8")),
    0,
  );
  const priorState = {
    binding: { agentId: binding.agentId, profile: binding.profile },
    mcp: {},
    api: {},
  };
  const oldBudget =
    documentBytes + bytes(snapshot.config) + 2 * bytes(priorState) + 8192;
  const proposed = {
    ...snapshot.config,
    identity: { name: "crm", directory: "crm" },
    specification: {
      file: snapshot.documents[0].file,
      location: snapshot.documents[0].location,
      references: snapshot.documents.slice(1).map((document) => ({
        file: document.file,
        location: document.location,
      })),
    },
  };
  assert.ok(
    documentBytes + bytes(proposed) > oldBudget,
    "The fixture must exceed the old estimate using real persisted source-index locations.",
  );
  f.setLimit(oldBudget);
  let rejected;
  try {
    await f.backend.apply(intent, prepared, f.scope());
  } catch (error) {
    rejected = error;
  }
  const written = [
    ...files(path.join(f.work, "api")),
    ...(existsSync(f.approvedFile) ? [f.approvedFile] : []),
  ].reduce((total, file) => total + statSync(file).size, 0);
  assert.equal(
    rejected?.code,
    "storage_quota_exceeded",
    `The old ${oldBudget}-byte admission permitted ${written} bytes of public/approved content.`,
  );
  assert.equal(f.events.filter((event) => event.type === "prepare").length, 0);
  assert.deepEqual(files(path.join(f.work, "api")), []);
  assert.equal(existsSync(f.approvedFile), false);
  assert.equal(f.outstanding, 0);
  assert.equal(
    http.requested.length,
    3,
    "Applying a fixed source never fetches its mutable URL again.",
  );
  f.setLimit(Infinity);
  assert.equal(
    (await f.backend.apply(intent, prepared, f.scope())).changed,
    true,
  );
  const actualBytes = [
    ...files(path.join(f.work, "api")),
    f.approvedFile,
  ].reduce((total, file) => total + statSync(file).size, 0);
  assert.ok(f.reservations.at(-1) >= actualBytes);
  assert.equal(f.outstanding, 0);
  assert.equal(http.requested.length, 3);
});

test("a remove rechecks its approved/public premise after reservation and preserves concurrent changes before any removal", async (t) => {
  for (const change of ["target", "other namespace"])
    await t.test(change, async (t) => {
      const f = await fixture(t),
        intent = f.intent("mcp.add", {
          name: "fixture",
          config: {
            transport: "stdio",
            command: process.execPath,
            args: ["--version"],
          },
        });
      await f.backend.apply(
        intent,
        await f.backend.prepare(intent, f.scope()),
        f.scope(),
      );
      const remove = f.intent("mcp.remove", { name: "fixture" }),
        candidate = await f.backend.prepare(remove, f.scope());
      const file = path.join(f.work, "mcp.json"),
        approvedBefore = readFileSync(f.approvedFile, "utf8");
      f.setReserveHook(async () => {
        const current = JSON.parse(readFileSync(file, "utf8"));
        if (change === "target")
          current.mcpServers.fixture.args = ["--changed-outside-approval"];
        else
          current.mcpServers.newUnapproved = {
            transport: "stdio",
            command: process.execPath,
            args: ["--other"],
          };
        writeFileSync(file, JSON.stringify(current));
      });
      await assert.rejects(f.backend.apply(remove, candidate, f.scope()), {
        code: "maintenance_precondition_changed",
      });
      assert.equal(
        f.events.filter((event) => event.type === "remove").length,
        0,
      );
      assert.equal(f.active.has("mcp:fixture"), true);
      assert.equal(f.outstanding, 0);
      const current = JSON.parse(readFileSync(file, "utf8"));
      assert.ok(
        change === "target"
          ? current.mcpServers.fixture.args.includes(
              "--changed-outside-approval",
            )
          : current.mcpServers.newUnapproved,
      );
      assert.equal(readFileSync(f.approvedFile, "utf8"), approvedBefore);
    });
});

test("failed API publication restores the original public source graph and private approval before actual native disposal releases its ticket", async (t) => {
  const f = await fixture(t),
    http = await longReferences(t),
    initial = f.intent("api.import", { name: "crm", url: http.source });
  await f.backend.apply(
    initial,
    await f.backend.prepare(initial, f.scope()),
    f.scope(),
  );
  const graphBefore = new Map(
      files(path.join(f.work, "api")).map((file) => [
        file,
        readFileSync(file, "utf8"),
      ]),
    ),
    approvedBefore = readFileSync(f.approvedFile, "utf8");
  const activeBefore = f.active.get("api:crm");
  http.setVersion("2");
  const update = f.intent("api.update", { name: "crm", url: http.source }),
    candidate = await f.backend.prepare(update, f.scope());
  const disposeEntered = Promise.withResolvers(),
    allowClose = Promise.withResolvers();
  f.setPublishFailure(true);
  f.setDisposeHook(async (handle) => {
    assert.ok(handle.fd >= 0);
    disposeEntered.resolve(handle);
    await allowClose.promise;
  });
  const applying = f.backend.apply(update, candidate, f.scope());
  const handle = await disposeEntered.promise;
  assert.ok(f.outstanding > 0);
  assert.ok(handle.fd >= 0);
  assert.equal(f.active.get("api:crm"), activeBefore);
  assert.equal(readFileSync(f.approvedFile, "utf8"), approvedBefore);
  for (const [file, value] of graphBefore)
    assert.equal(readFileSync(file, "utf8"), value, path.basename(file));
  allowClose.resolve();
  await assert.rejects(applying, { code: "publication_denied" });
  assert.equal(handle.fd, -1);
  assert.equal(f.outstanding, 0);
  const disposed = f.events.findLastIndex((event) => event.type === "disposed"),
    released = f.events.findLastIndex((event) => event.type === "release");
  assert.ok(disposed >= 0 && released > disposed);
  const published = f.events.filter((event) => event.type === "publish").length;
  assert.equal(published, 2);
  assert.equal(http.requested.length, 6);
});

test("a partial source-file publication restores its written prefix while preserving a concurrent manual source edit", async (t) => {
  const f = await fixture(t),
    http = await longReferences(t),
    initial = f.intent("api.import", { name: "crm", url: http.source });
  const initialCandidate = await f.backend.prepare(initial, f.scope());
  await f.backend.apply(initial, initialCandidate, f.scope());
  const rootFile = path.join(f.work, "api", "crm", "openapi.json"),
    oldRoot = readFileSync(rootFile, "utf8");
  const configFile = path.join(f.work, "api", "crm", "config.json"),
    oldConfig = readFileSync(configFile, "utf8"),
    oldApproved = readFileSync(f.approvedFile, "utf8");
  const source = f.snapshot(initialCandidate).documents[1],
    changedFile = path.join(f.work, "api", "crm", ...source.file.split("/")),
    manual = '{"manual":"outside-current-publication"}';
  http.setVersion("2");
  const update = f.intent("api.update", { name: "crm", url: http.source }),
    candidate = await f.backend.prepare(update, f.scope());
  f.setPrepareHook(async () => writeFileSync(changedFile, manual));
  await assert.rejects(f.backend.apply(update, candidate, f.scope()), {
    code: "maintenance_precondition_changed",
  });
  assert.equal(readFileSync(rootFile, "utf8"), oldRoot);
  assert.equal(readFileSync(changedFile, "utf8"), manual);
  assert.equal(readFileSync(configFile, "utf8"), oldConfig);
  assert.equal(readFileSync(f.approvedFile, "utf8"), oldApproved);
  assert.equal(f.outstanding, 0);
  assert.equal(f.events.filter((event) => event.type === "publish").length, 1);
  assert.ok(
    f.events.findLastIndex((event) => event.type === "disposed") <
      f.events.findLastIndex((event) => event.type === "release"),
  );
});
