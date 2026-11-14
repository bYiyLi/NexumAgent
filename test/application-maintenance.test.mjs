import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";

// Real AgentRuntime/SQLite/Registry and native HTTP/processes. The ControlPort
// peer models authenticated Cloud decisions; this is not deployed WSS/UI proof.
const runtimeUrl =
  process.env.NEXUM_APPLICATION_MODULE ??
  new URL("../dist/application/runtime.js", import.meta.url).href;
const rootUrl = new URL("../", runtimeUrl);
const [
  { AgentRuntime },
  { MaintenanceApplication },
  { PipeProcessBackend },
  { WindowsProcessBackend },
  { AgentError },
  { newId, canonicalJson },
  { validateContract },
] = await Promise.all([
  import(runtimeUrl),
  ...[
    "application/maintenance.js",
    "process/pipes.js",
    "process/windows-pipes.js",
    "contracts/errors.js",
    "contracts/json.js",
    "contracts/validation.js",
  ].map((file) => import(new URL(file, rootUrl))),
]);
const caller = {
  principalId: "owner",
  clientId: "maintenance-client",
  grantId: "maintenance-grant",
};
const secret = "synthetic-maintenance-body-secret";
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gate = () => Promise.withResolvers();
const safe = (value) =>
  assert.equal(inspect(value, { depth: 15 }).includes(secret), false);
async function until(check, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  assert.fail(message);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function fixture(t) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-app-maintenance-")),
    ),
    work = path.join(root, "work");
  mkdirSync(work);
  writeFileSync(
    path.join(work, "package.json"),
    '{"private":true,"type":"module"}',
  );
  let runtime,
    components,
    application,
    currentPort,
    serverUrl,
    bootId,
    beginGate,
    cleanupGate,
    oauthCleanupGate,
    oauthBodyGate;
  const records = new Map(),
    streams = new Map(),
    events = [],
    requests = [],
    native = [],
    calls = {
      prepare: 0,
      verify: 0,
      apply: 0,
      draft: 0,
      oauthStart: 0,
      oauthComplete: 0,
      oauthCleanup: 0,
    },
    sockets = new Set();
  const nativeOAuth = [];
  let policyAllowed = true;
  const http = createServer((request, response) => {
    request.on("error", () => {});
    response.on("error", () => {});
    void (async () => {
      if (request.url === "/oauth-native") {
        const evidence = { closed: false };
        nativeOAuth.push(evidence);
        response.once("close", () => (evidence.closed = true));
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"waiting":');
        await oauthBodyGate?.promise;
        if (!response.destroyed) response.end("true}");
        return;
      }
      assert.equal(
        request.headers.authorization,
        "Bearer fixture_private_agent_token",
      );
      const id = request.url.split("/").at(-1),
        entry = streams.get(id);
      assert.ok(entry);
      assert.equal(
        request.headers["x-nexum-stream-purpose"],
        entry.ref.purpose,
      );
      assert.equal(
        request.headers["x-nexum-stream-direction"],
        entry.ref.direction,
      );
      entry.reads++;
      response.once("close", () => (entry.closed = true));
      if (request.method === "GET") {
        response.writeHead(200, { "content-length": entry.bytes.length });
        if (entry.hold) {
          response.write(entry.bytes.subarray(0, 1));
          await entry.hold.promise;
        }
        if (!response.destroyed)
          response.end(entry.hold ? entry.bytes.subarray(1) : entry.bytes);
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      entry.bytes = Buffer.concat(chunks);
      assert.equal(entry.bytes.length, entry.ref.size);
      assert.equal(hash(entry.bytes), entry.ref.sha256);
      entry.received.resolve(entry.bytes);
      response.writeHead(204);
      response.end();
    })().catch(() => response.destroy());
  });
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${http.address().port}`;
  function authorization(extra = {}) {
    return {
      agentId: "agent_maintenance",
      allowedRoots: [root],
      budgets: {
        textBytes: 262144,
        controlBytes: 1048576,
        fileBytes: 268435456,
      },
      revision: newId("policy"),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      ...extra,
    };
  }
  function owned(context, id, signal) {
    signal.throwIfAborted();
    if (
      !policyAllowed ||
      context.caller.principalId !== caller.principalId ||
      context.caller.clientId !== caller.clientId ||
      context.caller.grantId !== caller.grantId
    )
      throw new AgentError(
        "forbidden",
        "The verified caller is not currently authorized.",
      );
    const row = records.get(id);
    if (!row)
      throw new AgentError(
        "maintenance_not_found",
        "No request belongs to this caller.",
      );
    return row;
  }
  function port() {
    const controller = new AbortController();
    return {
      binding: {
        agentId: "agent_maintenance",
        profile: "development",
        cloudEnvironment: "development",
        connectionId: newId("connection"),
        bootId,
      },
      signal: controller.signal,
      abort() {
        controller.abort();
      },
      async send(message) {
        validateContract("wire", message);
        events.push(clone(message));
      },
      async request(operation, context, input, signal) {
        signal.throwIfAborted();
        validateContract("wire.input:" + operation, input);
        requests.push({
          operation,
          context: clone(context),
          input: clone(input),
        });
        let output;
        if (operation === "authorization.refresh") {
          if (!policyAllowed)
            throw new AgentError("forbidden", "Current Grant revoked.");
          output = {
            authorization: authorization(
              context.authorization.projectId
                ? { projectId: context.authorization.projectId }
                : {},
            ),
          };
        } else if (operation === "stream.prepare") {
          const { originInvocationId, runId, resourceUri, ...source } = input;
          const ref = { streamId: newId("stream"), ...source };
          streams.set(ref.streamId, { ref, received: gate(), reads: 0 });
          output = { stream: ref };
        } else if (operation === "stream.revoke")
          output = { streamId: input.streamId, closed: true };
        else if (operation === "maintenance.request.create") {
          if (!policyAllowed || context.caller.grantId !== caller.grantId)
            throw new AgentError("forbidden", "Current Grant revoked.");
          const requestId = `maint_req_${records.size + 1}`,
            view = {
              requestId,
              agentId: "agent_maintenance",
              profile: "development",
              target: input.target,
              action: input.action,
              name: input.name,
              status: "pending",
              revision: 1,
              candidateRevision: input.candidateRevision,
              objectId: input.objectId,
              baseRevision: input.baseRevision,
              summary: clone(input.summary),
              authStatus: input.authStatus,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 600000).toISOString(),
              approvalUrl: `${serverUrl}/authorize/maintenance/${requestId}`,
            };
          records.set(requestId, view);
          output = clone(view);
        } else if (
          operation === "maintenance.request.get" ||
          operation === "maintenance.request.decision"
        )
          output = clone(owned(context, input.requestId, signal));
        else if (operation === "maintenance.request.list")
          output = {
            requests: [...records.values()].map(clone),
            nextCursor: null,
          };
        else if (operation === "maintenance.request.cancel") {
          const row = owned(context, input.requestId, signal);
          row.status = "cancelled";
          delete row.approvalUrl;
          output = clone(row);
        } else if (operation === "maintenance.request.beginExecution") {
          const row = owned(context, input.requestId, signal);
          assert.equal(row.status, "approved");
          assert.equal(row.candidateRevision, input.approvedRevision);
          assert.equal(row.revision, input.decisionRevision);
          if (beginGate) await beginGate.promise;
          signal.throwIfAborted();
          row.execution = {
            operationId: input.operationId,
            startedAt: new Date().toISOString(),
          };
          output = clone(row);
        } else
          throw new Error("Unexpected verified reverse operation " + operation);
        validateContract("wire.output:" + operation, output);
        return output;
      },
    };
  }
  const prepared = (payload) => ({
    objectId: null,
    baseRevision: null,
    payload,
    authStatus: "not_required",
    summary: {
      changeKinds: ["connection"],
      permissions: ["mcp.use"],
      version: null,
      namespace: null,
      restartMayBeRequired: false,
    },
  });
  const backend = {
    async prepare(intent, scope) {
      scope.assertCurrent();
      calls.prepare++;
      return prepared({ private: secret, config: intent.config ?? {} });
    },
    async verify(_intent, _candidate, scope) {
      scope.assertCurrent();
      calls.verify++;
    },
    async apply(_intent, _candidate, scope) {
      calls.apply++;
      scope.assertCurrent();
      const options = {
        onOutput(_stream, bytes) {
          if (Buffer.from(bytes).toString().includes("ready"))
            item.ready = true;
        },
      };
      const backend =
          process.platform === "win32"
            ? new WindowsProcessBackend(options)
            : new PipeProcessBackend(options),
        item = { backend, ready: false, settled: false };
      native.push(item);
      const stopping = () => {
        void backend.dispose(scope.signal.reason).catch(() => {});
      };
      scope.signal.addEventListener("abort", stopping, { once: true });
      try {
        await backend.start({
          file: process.execPath,
          args: [
            "-e",
            `process.stdout.write('ready');setInterval(()=>{},1000)`,
          ],
          cwd: work,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              ["SYSTEMROOT", "COMSPEC", "TEMP", "TMP"].includes(
                key.toUpperCase(),
              ),
            ),
          ),
          tty: false,
        });
        if (scope.signal.aborted) stopping();
        await backend.closed;
        scope.signal.throwIfAborted();
        return { changed: true, restartRequired: false };
      } finally {
        await backend.dispose();
        await backend.closed;
        scope.signal.removeEventListener("abort", stopping);
        if (cleanupGate) await cleanupGate.promise;
        item.settled = true;
      }
    },
    async readDraft(_intent, candidate, scope) {
      scope.assertCurrent();
      return {
        config: { public: true },
        authentication: [
          {
            id: "key",
            type: "bearer",
            oauth: false,
            fields: [
              {
                key: "key.value",
                label: "Key",
                configured: !!candidate.payload.private,
                required: true,
              },
            ],
          },
        ],
        security: [],
        diagnostics: [],
      };
    },
    async prepareDraft(_intent, candidate, input, scope) {
      scope.assertCurrent();
      calls.draft++;
      return prepared({
        ...candidate.payload,
        ...(input.config ? { config: input.config } : {}),
        private:
          input.credentials?.find((item) => item.operation === "replace")
            ?.value ?? candidate.payload.private,
      });
    },
    async startOAuth(_intent, _candidate, binding, scope) {
      scope.assertCurrent();
      calls.oauthStart++;
      if (oauthBodyGate) {
        let res;
        try {
          res = await fetch(`${serverUrl}/oauth-native`, {
            signal: scope.signal,
          });
          await res.text();
        } finally {
          await res?.body?.cancel().catch(() => {});
          calls.oauthCleanup++;
          if (oauthCleanupGate) await oauthCleanupGate.promise;
        }
      }
      scope.assertCurrent();
      return {
        authorizationUrl: `${serverUrl}/login?state=${binding.state}`,
        issuer: serverUrl,
        requireIssuer: false,
      };
    },
    async completeOAuth(_intent, candidate, _input, scope) {
      scope.assertCurrent();
      calls.oauthComplete++;
      return prepared({ ...candidate.payload, oauth: true });
    },
  };
  const config = {
    root,
    profile: "development",
    serverUrl,
    token: "fixture_private_agent_token",
  };
  async function start() {
    bootId = newId("boot");
    currentPort = port();
    runtime = await AgentRuntime.create(config, currentPort, bootId, {
      home: null,
      configureMaintenance(value) {
        components = value;
        application = new MaintenanceApplication(value, backend, serverUrl);
        return application.requests;
      },
      dispatchMaintenance: (message, scope, _components, _service, signal) =>
        application.dispatch(message, scope, signal),
    });
  }
  await start();
  t.after(async () => {
    beginGate?.resolve();
    cleanupGate?.resolve();
    oauthBodyGate?.resolve();
    oauthCleanupGate?.resolve();
    for (const item of streams.values()) item.hold?.resolve();
    try {
      await runtime?.close();
    } finally {
      for (const item of native) await item.backend.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => http.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
  function message(operation, input, options = {}) {
    return {
      type: "invoke",
      id: newId("rpc"),
      operation,
      context: {
        caller: options.caller ?? caller,
        authorization: authorization(options.policy),
        connection: currentPort.binding,
      },
      input,
    };
  }
  function invoke(operation, input, options = {}) {
    return runtime.dispatch(
      message(operation, input, options),
      options.signal ?? AbortSignal.timeout(15000),
    );
  }
  async function create() {
    const opened = await invoke("agent.open", { agentId: "agent_maintenance" });
    let result = await invoke("agent.run.start", {
      contextId: opened.contextId,
      script: `return await maintenance.mcp.add({name:'fixture',config:{transport:'stdio',command:'node'}});`,
      waitMs: 1000,
    });
    while (
      !["succeeded", "failed", "cancelled", "interrupted"].includes(
        result.run.status,
      )
    )
      result = await invoke("agent.run.get", {
        agentId: "agent_maintenance",
        runId: result.run.runId,
        waitMs: 1000,
      });
    assert.equal(result.run.status, "succeeded", JSON.stringify(result));
    return { ...result.result.data, originRunId: result.run.runId };
  }
  function approve(id) {
    const row = records.get(id);
    row.status = "approved";
    delete row.approvalUrl;
    row.decidedAt = new Date().toISOString();
    row.decision = {
      status: "approved",
      revision: row.revision,
      candidateRevision: row.candidateRevision,
      decidedAt: row.decidedAt,
      decisionId: newId("decision"),
    };
  }
  function incoming(value, extra = {}) {
    const bytes = Buffer.from(
      typeof value === "string" ? value : canonicalJson(value),
    );
    const ref = {
      streamId: newId("stream"),
      purpose: "maintenance",
      direction: "cloud-to-agent",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxBytes: Math.max(1, bytes.length),
      size: bytes.length,
      sha256: hash(bytes),
      mimeType: "application/json",
      ...extra,
    };
    streams.set(ref.streamId, { ref, bytes, received: gate(), reads: 0 });
    return ref;
  }
  return {
    root,
    work,
    records,
    streams,
    events,
    requests,
    native,
    nativeOAuth,
    calls,
    invoke,
    message,
    create,
    approve,
    incoming,
    async body(ref) {
      const stream = streams.get(ref.streamId);
      return JSON.parse((await stream.received.promise).toString());
    },
    get components() {
      return components;
    },
    get runtime() {
      return runtime;
    },
    setBeginGate(value) {
      beginGate = value;
    },
    setCleanupGate(value) {
      cleanupGate = value;
    },
    setOAuthGates(body, cleanup) {
      oauthBodyGate = body;
      oauthCleanupGate = cleanup;
    },
    async reconnect() {
      currentPort.abort();
      currentPort = port();
      await runtime.attachConnection(currentPort);
    },
    async restart() {
      await runtime.close();
      await start();
    },
    disconnect() {
      currentPort.abort();
    },
    async revokeEvent() {
      policyAllowed = false;
      await runtime.event(
        {
          type: "event",
          name: "agent.authorization.changed",
          connection: currentPort.binding,
          data: { caller, authorization: null },
        },
        new AbortController().signal,
      );
    },
    revoke() {
      policyAllowed = false;
    },
  };
}

test("accepted maintenance returns the durable operation before Cloud execution ACK and outlives its script and observation connection", async (t) => {
  const f = await fixture(t),
    created = await f.create();
  safe(created);
  assert.ok(f.components.store.getRun(created.originRunId).endedAt !== null);
  f.approve(created.requestId);
  const begin = gate(),
    cleanup = gate();
  f.setBeginGate(begin);
  f.setCleanupGate(cleanup);
  const receipt = await f.invoke("agent.maintenance.execute", {
    requestId: created.requestId,
  });
  const operation = f.components.store.getMaintenanceOperation(
    created.requestId,
  );
  assert.equal(receipt.execution.operationId, operation.operationId);
  assert.equal(f.calls.apply, 0);
  assert.equal(f.records.get(created.requestId).execution, undefined);
  assert.ok(
    f.requests.some(
      (item) =>
        item.operation === "authorization.refresh" &&
        item.input.maintenanceRequestId === created.requestId,
    ),
  );
  begin.resolve();
  await until(
    () => f.native[0]?.ready,
    "The admitted maintenance must launch a real child",
  );
  f.disconnect();
  assert.equal(alive(f.native[0].backend.facts().pid), true);
  assert.equal(f.native[0].backend.facts().closed, false);
  await f.reconnect();
  const view = await f.invoke("agent.maintenance.get", {
    requestId: created.requestId,
  });
  assert.equal(view.execution.operationId, operation.operationId);
  let returned = false;
  const cancelling = f
    .invoke("agent.maintenance.cancel", { requestId: created.requestId })
    .then((value) => ((returned = true), value));
  void cancelling.catch(() => {});
  await until(
    () => f.native[0].backend.facts().closed,
    "Cancellation must close actual native pipes",
  );
  assert.equal(returned, false);
  assert.equal(f.native[0].settled, false);
  assert.equal(
    f.components.store.getMaintenanceOperation(created.requestId).status,
    "running",
  );
  cleanup.resolve();
  const cancelled = await cancelling;
  assert.equal(cancelled.execution.operationId, operation.operationId);
  assert.equal(cancelled.execution.status, "failed");
  assert.equal(cancelled.execution.error.code, "maintenance_cancelled");
  assert.equal(f.native[0].settled, true);
  safe([receipt, cancelled, f.events, f.requests]);
  const count = f.calls.apply;
  await f.restart();
  const recovered = await f.invoke("agent.maintenance.execute", {
    requestId: created.requestId,
  });
  assert.equal(recovered.execution.operationId, operation.operationId);
  assert.equal(f.calls.apply, count);
});

test("maintenance JSON bodies use fixed hashes and the actual four shared slots before any credential or OAuth change", async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    row = f.records.get(created.requestId);
  const draft = await f.invoke("agent.maintenance.draft.read", {
    requestId: created.requestId,
  });
  safe(draft);
  const document = await f.body(draft.body);
  assert.equal(document.draft.authentication[0].fields[0].configured, true);
  safe(document);
  const body = f.incoming({
    revision: row.revision,
    credentials: [{ key: "key.value", operation: "replace", value: secret }],
  });
  const slots = await until(() => {
    const acquired = [];
    while (true) {
      const slot = f.components.streams.tryAcquire();
      if (!slot) break;
      acquired.push(slot);
    }
    if (acquired.length === 4) return acquired;
    for (const slot of acquired) slot.release();
    return false;
  }, "The previous real output stream must release all four shared permits");
  assert.equal(slots.length, 4);
  await assert.rejects(
    f.invoke("agent.maintenance.draft.prepare", {
      requestId: created.requestId,
      revision: row.revision,
      body,
    }),
    (error) => error.code === "transfer_busy",
  );
  assert.equal(f.streams.get(body.streamId).reads, 0);
  for (const slot of slots) slot.release();
  await assert.rejects(
    f.invoke("agent.maintenance.draft.prepare", {
      requestId: created.requestId,
      revision: row.revision + 1,
      body,
    }),
    (error) => error.code === "maintenance_revision_conflict",
  );
  assert.equal(f.streams.get(body.streamId).reads, 0);
  const corrupt = { ...body, sha256: "0".repeat(64) };
  await assert.rejects(
    f.invoke("agent.maintenance.draft.prepare", {
      requestId: created.requestId,
      revision: row.revision,
      body: corrupt,
    }),
  );
  assert.equal(f.calls.draft, 0);
  const foreign = { ...caller, clientId: "foreign", grantId: "foreign-grant" };
  await assert.rejects(
    f.invoke(
      "agent.maintenance.draft.prepare",
      { requestId: created.requestId, revision: row.revision, body },
      { caller: foreign },
    ),
    (error) => ["forbidden", "maintenance_not_found"].includes(error.code),
  );
  assert.equal(f.calls.draft, 0);
  const reverseBefore = f.requests.length;
  const ownerMessage = f.message(
    "agent.maintenance.get",
    { requestId: created.requestId },
    {
      caller: {
        principalId: caller.principalId,
        clientId: `nexum-console:${"a".repeat(64)}`,
        source: "owner_session",
        sessionRef: "a".repeat(64),
      },
    },
  );
  // Validate this caller on its allowed read before testing the forbidden
  // maintenance operation, so a malformed identity cannot make this pass.
  validateContract("wire", {
    ...ownerMessage,
    operation: "agent.project.resolve",
    input: { path: f.work },
  });
  await assert.rejects(
    f.runtime.dispatch(ownerMessage, AbortSignal.timeout(15000)),
    (error) => {
      safe(error);
      return [
        "invalid_arguments",
        "forbidden",
        "unauthorized",
        "invalid_control_direction",
      ].includes(error.code);
    },
  );
  assert.equal(
    f.requests.length,
    reverseBefore,
    "A Browser session must not replace the original maintenance Grant",
  );
  const updated = await f.invoke("agent.maintenance.draft.prepare", {
    requestId: created.requestId,
    revision: row.revision,
    body,
  });
  assert.equal(f.calls.draft, 1);
  safe(updated);
  const prepared = await f.body(updated.body);
  safe(prepared);
  // The Browser authority, not the Agent SDK, adopts the returned fixed draft.
  Object.assign(row, prepared.candidate, { revision: row.revision + 1 });
  const verified = await f.invoke("agent.maintenance.draft.verify", {
    requestId: created.requestId,
    revision: row.revision,
  });
  assert.equal(verified.candidateRevision, row.candidateRevision);
  assert.deepEqual(
    await f.invoke("agent.maintenance.draft.notify", {
      requestId: created.requestId,
      revision: row.revision,
    }),
    { requestId: created.requestId, notified: true },
  );
  const binding = {
    state: "state_fixture",
    callbackUrl: `${new URL(row.approvalUrl).origin}/api/console/maintenance/oauth/callback`,
    schemeId: "oauth",
    candidateRevision: row.candidateRevision,
  };
  const invalid = f.incoming({ ...binding, unknown: secret });
  await assert.rejects(
    f.invoke("agent.maintenance.oauth.start", {
      requestId: created.requestId,
      revision: row.revision,
      body: invalid,
    }),
    (error) => {
      safe(error);
      return true;
    },
  );
  assert.equal(f.calls.oauthStart, 0);
  const oauth = await f.invoke("agent.maintenance.oauth.start", {
    requestId: created.requestId,
    revision: row.revision,
    body: f.incoming(binding),
  });
  assert.equal((await f.body(oauth.body)).requireIssuer, false);
  const completed = await f.invoke("agent.maintenance.oauth.complete", {
    requestId: created.requestId,
    revision: row.revision,
    body: f.incoming({
      schemeId: "oauth",
      candidateRevision: row.candidateRevision,
      callback: { state: "state_fixture", code: secret },
    }),
  });
  safe(await f.body(completed.body));
  assert.equal(f.calls.oauthStart, 1);
  assert.equal(f.calls.oauthComplete, 1);
  safe([f.events, f.requests]);
});

test("a current Grant revocation propagates a stop request to its reachable independently executing native maintenance", async (t) => {
  const f = await fixture(t),
    created = await f.create();
  f.approve(created.requestId);
  await f.invoke("agent.maintenance.execute", { requestId: created.requestId });
  await until(
    () => f.native[0]?.ready,
    "The authorized native execution must actually be running",
  );
  await f.revokeEvent();
  await until(
    () => f.native[0].backend.facts().stopRequested,
    "Revocation must reach its in-flight native stop signal",
  );
  await until(
    () => f.native[0].backend.facts().closed,
    "Revoked native work must confirm actual closure",
  );
});

test("shutdown joins a real OAuth body and its backend cleanup before closing SQLite", async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    row = f.records.get(created.requestId),
    bodyGate = gate(),
    cleanup = gate();
  f.setOAuthGates(bodyGate, cleanup);
  const body = f.incoming({
    state: "state_fixture",
    callbackUrl: `${new URL(row.approvalUrl).origin}/api/console/maintenance/oauth/callback`,
    schemeId: "oauth",
    candidateRevision: row.candidateRevision,
  });
  const starting = f.invoke("agent.maintenance.oauth.start", {
    requestId: created.requestId,
    revision: row.revision,
    body,
  });
  void starting.catch(() => {});
  await until(
    () => f.nativeOAuth.length === 1,
    "The OAuth backend must enter actual HTTP I/O",
  );
  let finished = false;
  const closing = f.runtime.close().then(() => (finished = true));
  void closing.catch(() => {});
  try {
    await until(
      () => f.nativeOAuth[0].closed,
      "Shutdown must abort the real OAuth HTTP socket",
    );
    await until(
      () => f.calls.oauthCleanup === 1,
      "The admitted OAuth backend must reach its actual cleanup barrier",
    );
    assert.equal(
      finished,
      false,
      "SQLite cannot close while the admitted OAuth backend has not finished cleanup",
    );
    assert.doesNotThrow(() => f.components.store.getRun(created.originRunId));
  } finally {
    cleanup.resolve();
    bodyGate.resolve();
    await Promise.allSettled([closing, starting]);
  }
});
