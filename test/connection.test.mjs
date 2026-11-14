import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import {
  setTimeout as delay,
  setImmediate as tick,
} from "node:timers/promises";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  ControlConnection,
  reconnectControl,
  ConnectionRejection,
} from "../dist/application/connection.js";
import { newId, canonicalJson } from "../dist/contracts/json.js";
import { SqliteStore } from "../dist/storage/sqlite.js";
import { ModuleLoader } from "../dist/runtime/modules.js";
import { ScriptCatalog } from "../dist/runtime/scripts.js";
import { RunEngine, callerKey } from "../dist/runtime/engine.js";
import { AgentError } from "../dist/contracts/errors.js";

const token = "synthetic-agent-private-token";
async function within(promise, ms = 5000) {
  const stop = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: stop.signal }).then(() => {
        throw new Error("Fixture deadline exceeded");
      }),
    ]);
  } finally {
    stop.abort();
  }
}
function context(binding) {
  return {
    connection: binding,
    caller: { principalId: "user", clientId: "client", grantId: "grant" },
    authorization: {
      agentId: binding.agentId,
      allowedRoots: [],
      budgets: {},
      revision: "policy",
      expiresAt: new Date(Date.now() + 20000).toISOString(),
    },
  };
}
function syncEvent(binding, generation = "one") {
  return {
    type: "event",
    name: "agent.catalog.sync",
    connection: binding,
    data: {
      generation,
      page: 0,
      complete: true,
      projects: [],
      allowedRoots: [],
    },
  };
}
async function fixture(t, options = {}) {
  const events = new EventEmitter(),
    peers = [],
    messages = [],
    requests = [],
    clients = [],
    gates = [],
    controller = new AbortController(),
    bootId = newId("boot");
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  ws.on("headers", (headers, request) => {
    const b = request.binding;
    headers.push(
      ...(options.headers?.(b) ?? [
        `X-Nexum-Agent-Id: ${b.agentId}`,
        `X-Nexum-Cloud-Environment: ${b.cloudEnvironment}`,
        `X-Nexum-Connection-Id: ${b.connectionId}`,
      ]),
    );
  });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (request, socket, head) => {
    requests.push(request);
    events.emit("request", request);
    if (options.rejection) {
      const { status, code } = options.rejection;
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\n${code ? `X-Nexum-Error-Code: ${code}\r\n` : ""}Content-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    request.binding = {
      agentId: "agent",
      cloudEnvironment: "development",
      connectionId: `connection_${requests.length}`,
      profile: "development",
      bootId: request.headers["x-nexum-boot-id"],
    };
    ws.handleUpgrade(request, socket, head, (peer) =>
      ws.emit("connection", peer, request),
    );
  });
  ws.on("connection", (peer, request) => {
    const entry = { peer, binding: request.binding };
    peers.push(entry);
    peer.on("error", () => {});
    peer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      messages.push({ peer, message });
      events.emit("message", { peer, message });
      options.onMessage?.(peer, message, entry.binding);
    });
    events.emit("peer", entry);
    options.onPeer?.(entry, peers.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = {
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    token,
    profile: "development",
    bootId,
    version: "test-version",
    signal: controller.signal,
    ready: async () => {},
    invoke: async () => ({ root: "/fixed", name: "fixture" }),
    event: async () => {},
  };
  const waitMessage = async (predicate) => {
    const found = messages.find((x) => predicate(x.message, x.peer));
    if (found) return found.message;
    const result = Promise.withResolvers();
    const receive = (x) => {
      if (predicate(x.message, x.peer)) {
        events.removeListener("message", receive);
        result.resolve(x.message);
      }
    };
    events.on("message", receive);
    try {
      return await within(result.promise);
    } finally {
      events.removeListener("message", receive);
    }
  };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    controller.abort();
    for (const { peer } of peers) {
      peer._socket?.resume();
      peer.terminate();
    }
    await Promise.allSettled(clients.map((c) => c.closed));
    await Promise.all([
      new Promise((resolve) => ws.close(resolve)),
      new Promise((resolve) => server.close(resolve)),
    ]);
  });
  return {
    base,
    controller,
    requests,
    peers,
    messages,
    events,
    waitMessage,
    gate() {
      const value = Promise.withResolvers();
      gates.push(value);
      return value;
    },
    async peer() {
      return peers.at(-1) ?? (await within(once(events, "peer")))[0];
    },
    async connect(extra = {}) {
      const value = await ControlConnection.connect({ ...base, ...extra });
      clients.push(value);
      return value;
    },
  };
}

test("real Upgrade sends bounded metadata once and admits only the authenticated immutable 101 identity", async (t) => {
  const f = await fixture(t),
    c = await f.connect({ serverUrl: f.base.serverUrl + "/prefix///" });
  assert.equal(f.requests[0].url, "/prefix/agent/connect");
  assert.equal(f.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(f.requests[0].headers["x-nexum-protocol-version"], "2");
  assert.equal(f.requests[0].headers["x-nexum-boot-id"], f.base.bootId);
  assert.equal(f.requests[0].headers["x-nexum-profile"], "development");
  assert.equal(f.requests[0].headers["x-nexum-agent-id"], undefined);
  assert.deepEqual(c.binding, f.peers[0].binding);
  assert(Object.isFrozen(c.binding));
  assert.equal(Object.values(c.binding).includes(token), false);
  c.close();
  await within(c.closed);
  assert.equal(c.signal.aborted, true);
  assert.throws(
    () =>
      c.request(
        "authorization.refresh",
        context(c.binding),
        { runId: "run", originInvocationId: "rpc" },
        new AbortController().signal,
      ),
    { code: "connection_closed" },
  );
});

test("missing, duplicated or cross-environment Upgrade identities never enter application readiness", async (t) => {
  for (const headers of [
    (b) => [
      `X-Nexum-Cloud-Environment: development`,
      `X-Nexum-Connection-Id: ${b.connectionId}`,
    ],
    (b) => [
      `X-Nexum-Agent-Id: ${b.agentId}`,
      `X-Nexum-Cloud-Environment: development`,
      `X-Nexum-Cloud-Environment: development`,
      `X-Nexum-Connection-Id: ${b.connectionId}`,
    ],
    (b) => [
      `X-Nexum-Agent-Id: ${b.agentId}`,
      `X-Nexum-Cloud-Environment: production`,
      `X-Nexum-Connection-Id: ${b.connectionId}`,
    ],
    (b) => [
      `X-Nexum-Agent-Id: ${b.agentId}`,
      `X-Nexum-Cloud-Environment: development`,
      `X-Nexum-Connection-Id: `,
    ],
  ]) {
    let ready = 0;
    const f = await fixture(t, { headers });
    await assert.rejects(
      f.connect({
        ready: async () => {
          ready++;
        },
      }),
      { code: "invalid_connection_binding" },
    );
    assert.equal(ready, 0);
  }
});

test("only matching documented HTTP rejection pairs and invalid local configuration permanently stop reconnect", async (t) => {
  for (const [status, code, permanent] of [
    [401, "invalid_agent_credential", true],
    [409, "agent_already_connected", true],
    [400, "unsupported_protocol", true],
    [400, "invalid_agent_metadata", true],
    [400, "unsupported_agent_environment", true],
    [403, undefined, false],
    [401, "future_code", false],
    [401, "f".repeat(64), false],
    [503, "invalid_agent_credential", false],
    [401, undefined, false],
    [429, "agent_already_connected", false],
  ]) {
    const f = await fixture(t, { rejection: { status, code } }),
      diagnostics = [];
    const outcome = await reconnectControl(f.base, (code, retry) => {
      diagnostics.push({ code, retry });
      if (retry) f.controller.abort();
    });
    assert.equal(outcome, permanent ? "permanent" : "stopped");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].retry, !permanent);
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(diagnostics).includes(token), false);
  }
  const f = await fixture(t),
    diagnostics = [];
  assert.equal(
    await reconnectControl(
      { ...f.base, serverUrl: `https://user:${token}@server.example` },
      (code, retry) => diagnostics.push({ code, retry }),
    ),
    "permanent",
  );
  assert.deepEqual(diagnostics, [
    { code: "invalid_configuration", retry: false },
  ]);
  assert.equal(f.requests.length, 0);
  assert.equal(
    new ConnectionRejection(403, "invalid_agent_credential").stopNoRestart,
    false,
  );
});

test("ready can await a reverse reply while invocation and event admission remain buffered and an early cancel removes its queued RPC", async (t) => {
  const f = await fixture(t, {
    onMessage(peer, message) {
      if (
        message.type === "invoke" &&
        message.operation === "authorization.refresh"
      )
        peer.send(
          JSON.stringify({
            type: "result",
            id: message.id,
            operation: message.operation,
            output: { authorization: message.context.authorization },
          }),
        );
    },
  });
  const gate = f.gate(),
    entered = f.gate();
  let invokes = 0,
    events = 0;
  const opening = f.connect({
    ready: async (c) => {
      const result = await c.request(
        "authorization.refresh",
        context(c.binding),
        { runId: "run", originInvocationId: "rpc" },
        c.signal,
      );
      assert.equal(result.authorization.revision, "policy");
      entered.resolve();
      await gate.promise;
    },
    invoke: async () => {
      invokes++;
      return { root: "/fixed", name: "fixture" };
    },
    event: async () => {
      events++;
    },
  });
  await within(entered.promise);
  const { peer, binding } = await f.peer();
  peer.send(JSON.stringify(syncEvent(binding)));
  for (const id of ["cancelled_before_ready", "after_ready"])
    peer.send(
      JSON.stringify({
        type: "invoke",
        id,
        operation: "agent.project.resolve",
        context: context(binding),
        input: { path: "/requested" },
      }),
    );
  peer.send(JSON.stringify({ type: "cancel", id: "cancelled_before_ready" }));
  await tick();
  assert.equal(invokes, 0);
  assert.equal(events, 0);
  gate.resolve();
  const c = await within(opening);
  await f.waitMessage((m) => m.type === "result" && m.id === "after_ready");
  assert.equal(invokes, 1);
  assert.equal(events, 1);
  assert.equal(c.signal.aborted, false);
});

test("a queued event checks actual closure before entering its callback", async (t) => {
  const f = await fixture(t),
    entered = f.gate(),
    gate = f.gate(),
    called = [];
  const c = await f.connect({
    event: async (message) => {
      called.push(message.data.generation);
      entered.resolve();
      await gate.promise;
    },
  });
  const { peer, binding } = await f.peer();
  peer.send(JSON.stringify(syncEvent(binding, "first")));
  peer.send(JSON.stringify(syncEvent(binding, "must-not-run")));
  await within(entered.promise);
  c.close();
  await within(c.closed);
  gate.resolve();
  await tick();
  await tick();
  assert.deepEqual(called, ["first"]);
});

test("current binding and expected operation identity are checked before invoking or resolving", async (t) => {
  const f = await fixture(t);
  let invoked = 0;
  const c = await f.connect({
      invoke: async () => {
        invoked++;
        return { root: "/x", name: "x" };
      },
    }),
    { peer, binding } = await f.peer();
  assert.throws(
    () =>
      c.request(
        "authorization.refresh",
        context({ ...binding, connectionId: "old" }),
        { runId: "r", originInvocationId: "rpc" },
        c.signal,
      ),
    { code: "connection_binding_mismatch" },
  );
  assert.throws(
    () =>
      c.request(
        "agent.project.resolve",
        context(binding),
        { path: "/x" },
        c.signal,
      ),
    { code: "invalid_control_direction" },
  );
  peer.send(
    JSON.stringify({
      type: "invoke",
      id: "wrong_binding",
      operation: "agent.project.resolve",
      context: context({ ...binding, bootId: "stale_boot" }),
      input: { path: "/x" },
    }),
  );
  await within(c.closed);
  assert.equal(invoked, 0);
  const g = await fixture(t),
    d = await g.connect(),
    entry = await g.peer();
  const pending = d.request(
    "authorization.refresh",
    context(d.binding),
    { runId: "r", originInvocationId: "rpc" },
    d.signal,
  );
  const rejected = assert.rejects(pending, { code: "connection_closed" });
  const request = await g.waitMessage((m) => m.type === "invoke");
  entry.peer.send(
    JSON.stringify({
      type: "result",
      id: request.id,
      operation: "agent.project.resolve",
      output: { root: "/other", name: "wrong-op" },
    }),
  );
  await rejected;
  await within(d.closed);
});

test("RPC cancellation ends the observer, sends one cancel and discards a late reply without closing the shared socket", async (t) => {
  const f = await fixture(t),
    c = await f.connect(),
    { peer } = await f.peer(),
    abort = new AbortController();
  const pending = c.request(
    "authorization.refresh",
    context(c.binding),
    { runId: "r", originInvocationId: "rpc" },
    abort.signal,
  );
  const rejected = assert.rejects(pending, /observer cancelled/);
  const request = await f.waitMessage((m) => m.type === "invoke");
  abort.abort(new Error("observer cancelled"));
  await rejected;
  await f.waitMessage((m) => m.type === "cancel" && m.id === request.id);
  peer.send(
    JSON.stringify({
      type: "result",
      id: request.id,
      operation: request.operation,
      output: { authorization: context(c.binding).authorization },
    }),
  );
  await tick();
  assert.equal(c.signal.aborted, false);
  const again = c.request(
    "authorization.refresh",
    context(c.binding),
    { runId: "r", originInvocationId: "second" },
    c.signal,
  );
  const next = await f.waitMessage(
    (m) => m.type === "invoke" && m.id !== request.id,
  );
  peer.send(
    JSON.stringify({
      type: "result",
      id: next.id,
      operation: next.operation,
      output: { authorization: context(c.binding).authorization },
    }),
  );
  assert.equal((await within(again)).authorization.agentId, "agent");
  assert.equal(f.messages.filter((x) => x.message.type === "cancel").length, 1);
});

test("text limits and binary rejection close actual sockets before application dispatch", async (t) => {
  for (const payload of ["x".repeat(1024 * 1024 + 1), Buffer.from("{}")]) {
    const f = await fixture(t);
    let calls = 0;
    const c = await f.connect({
        invoke: async () => {
          calls++;
          return {};
        },
      }),
      { peer } = await f.peer();
    peer.send(payload);
    await within(c.closed);
    assert.equal(calls, 0);
    assert.equal(c.signal.aborted, true);
  }
  const f = await fixture(t),
    c = await f.connect();
  const before = f.messages.length;
  await assert.rejects(
    c.send({
      type: "event",
      name: "agent.catalog.changed",
      connection: c.binding,
      data: {
        sequence: 1,
        observedAt: new Date().toISOString(),
        projects: [
          {
            projectId: "p",
            root: "/x",
            status: "ok",
            description: "x".repeat(1024 * 1024),
            revision: "one",
          },
        ],
      },
    }),
    { code: "data_too_large" },
  );
  assert.equal(f.messages.length, before);
  assert.equal(c.signal.aborted, false);
});

test("outgoing backpressure bounds concurrent native writes without an unbounded output queue", async (t) => {
  const f = await fixture(t),
    c = await f.connect(),
    { peer } = await f.peer();
  peer._socket.pause();
  const event = {
    type: "event",
    name: "agent.catalog.changed",
    connection: c.binding,
    data: {
      sequence: 1,
      observedAt: new Date().toISOString(),
      projects: [
        {
          projectId: "p",
          root: "/x",
          status: "ok",
          description: "x".repeat(600 * 1024),
          revision: "one",
        },
      ],
    },
  };
  const sending = Array.from({ length: 10 }, () => c.send(event));
  const outcome = Promise.allSettled(sending);
  peer._socket.resume();
  const values = await within(outcome);
  assert(
    values.some(
      (x) => x.status === "rejected" && x.reason.code === "control_busy",
    ),
  );
  assert(values.some((x) => x.status === "fulfilled"));
  assert.equal(c.signal.aborted, false);
});

function wireView(view) {
  const r = view.run,
    iso = (x) => (x === null ? null : new Date(x).toISOString());
  return {
    run: {
      runId: r.runId,
      contextId: r.contextId,
      projectId: r.projectId,
      revision: r.revision,
      status: r.status,
      scriptName: r.scriptName,
      source: { inline: "inline", script: "named", replay: "history" }[
        r.sourceKind
      ],
      origin: r.source.origin ?? null,
      replayOfRunId: r.source.replayRunId ?? null,
      acceptedAt: iso(r.acceptedAt),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.endedAt),
      deadlineAt: iso(r.deadlineAt),
      updatedAt: iso(r.updatedAt),
      error: r.error,
      stop: r.stop,
      cleanup: r.cleanup,
      availability: {
        code: !!r.codeRef,
        input: !!r.inputRef,
        result: !!r.resultRef,
        logs: !!r.logsRef,
      },
    },
    wait: null,
    result: view.result,
    observedAt: new Date().toISOString(),
    operations: view.operations,
    resources: view.resources,
  };
}

test("a dropped start observer reconnects without replay while the actual accepted RunEngine work remains alive", async (t) => {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-wss-run-")),
    ),
    work = path.join(root, "work"),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  mkdirSync(work);
  writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
  const boot = newId("boot"),
    store = new SqliteStore(
      root,
      {
        agentId: "agent",
        profile: "development",
        cloudEnvironment: "development",
      },
      Date.now(),
      boot,
    ),
    scripts = new ScriptCatalog(work, "agent"),
    loader = await ModuleLoader.create(work, boot, {
      builtins: () => [],
      approvedPackages: () => new Map(),
    });
  let effects = 0;
  const caller = context({}).caller,
    initial = store.openWork({
      callerKey: callerKey(caller),
      pwd: work,
      snapshotRef: "unused",
    });
  const engine = new RunEngine(store, loader, scripts, {
    authorize: () => {},
    loadWork: () => ({}),
    bindings: () => ({
      hold: async () => {
        entered.resolve();
        await gate.promise;
        effects++;
        return 7;
      },
    }),
    encodeResult: async (value) => ({
      content: [],
      data: JSON.parse(canonicalJson(value)),
    }),
  });
  t.after(async () => {
    gate.resolve();
    for (const run of store.listRuns({}, "fixture", 100).runs)
      if (run.endedAt === null) engine.cancel(caller, run.runId);
    await Promise.allSettled(
      store
        .listRuns({}, "fixture", 100)
        .runs.map((r) => engine.observe(caller, r.runId, 30000)),
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const f = await fixture(t);
  const running = reconnectControl(
    {
      ...f.base,
      bootId: boot,
      invoke: async (message, signal) =>
        wireView(
          message.operation === "agent.run.start"
            ? await engine.start(message.context.caller, message.input, signal)
            : await engine.get(message.context.caller, message.input, signal),
        ),
    },
    () => {},
  );
  const first = await f.peer();
  first.peer.send(
    JSON.stringify({
      type: "invoke",
      id: "original_start",
      operation: "agent.run.start",
      context: context(first.binding),
      input: {
        contextId: initial.contextId,
        script: "return await hold();",
        waitMs: 30000,
      },
    }),
  );
  await within(entered.promise);
  const accepted = store.listRuns({}, "fixture").runs[0];
  assert.equal(accepted.status, "running");
  first.peer.terminate();
  const second = (await within(once(f.events, "peer")))[0];
  assert.notEqual(second.binding.connectionId, first.binding.connectionId);
  assert.equal(second.binding.bootId, boot);
  assert.equal(store.getRun(accepted.runId).status, "running");
  second.peer.send(
    JSON.stringify({
      type: "invoke",
      id: "read_original",
      operation: "agent.run.get",
      context: context(second.binding),
      input: { agentId: "agent", runId: accepted.runId },
    }),
  );
  const reply = await f.waitMessage(
    (m) => m.type === "result" && m.id === "read_original",
  );
  assert.equal(reply.output.run.runId, accepted.runId);
  assert.equal(reply.output.run.status, "running");
  assert.equal(store.listRuns({}, "fixture").runs.length, 1);
  gate.resolve();
  const done = await engine.observe(caller, accepted.runId, 30000);
  assert.equal(done.run.status, "succeeded");
  assert.equal(effects, 1);
  f.controller.abort();
  assert.equal(await within(running), "stopped");
});

test("an in-flight remote cancel aborts only its observer and keeps the current connection usable", async (t) => {
  const f = await fixture(t),
    entered = f.gate();
  let observed;
  const c = await f.connect({
      invoke: async (message, signal) => {
        if (message.id === "inflight") {
          observed = signal;
          entered.resolve();
          await once(signal, "abort");
          signal.throwIfAborted();
        }
        return { root: "/fixed", name: "fixture" };
      },
    }),
    { peer, binding } = await f.peer();
  peer.send(
    JSON.stringify({
      type: "invoke",
      id: "inflight",
      operation: "agent.project.resolve",
      context: context(binding),
      input: { path: "/x" },
    }),
  );
  await within(entered.promise);
  peer.send(JSON.stringify({ type: "cancel", id: "inflight" }));
  const failure = await f.waitMessage(
    (m) => m.type === "error" && m.id === "inflight",
  );
  assert.equal(observed.aborted, true);
  assert.equal(observed.reason.code, "observation_cancelled");
  assert.equal(failure.error.code, "observation_cancelled");
  assert.equal(c.signal.aborted, false);
  peer.send(
    JSON.stringify({
      type: "invoke",
      id: "next",
      operation: "agent.project.resolve",
      context: context(binding),
      input: { path: "/x" },
    }),
  );
  await f.waitMessage((m) => m.type === "result" && m.id === "next");
});

test("an observation timeout sends cancellation without reporting remote work stopped", async (t) => {
  const f = await fixture(t),
    c = await f.connect();
  const pending = c.request(
      "authorization.refresh",
      context(c.binding),
      { runId: "run", originInvocationId: "rpc" },
      c.signal,
      20,
    ),
    rejected = assert.rejects(pending, { code: "observation_timeout" }),
    request = await f.waitMessage((m) => m.type === "invoke");
  await rejected;
  await f.waitMessage((m) => m.type === "cancel" && m.id === request.id);
  assert.equal(c.signal.aborted, false);
});

test("valid envelopes used in the wrong Cloud-to-Agent direction are rejected before callbacks", async (t) => {
  for (const make of [
    (binding) => ({
      type: "invoke",
      id: "wrong_direction",
      operation: "authorization.refresh",
      context: context(binding),
      input: { runId: "r", originInvocationId: "rpc" },
    }),
    (binding) => ({
      type: "event",
      name: "agent.run.changed",
      connection: binding,
      data: {
        runId: "r",
        revision: 1,
        status: "running",
        observedAt: new Date().toISOString(),
      },
    }),
  ]) {
    const f = await fixture(t);
    let called = 0;
    const c = await f.connect({
        invoke: async () => {
          called++;
          return {};
        },
        event: async () => {
          called++;
        },
      }),
      { peer, binding } = await f.peer();
    peer.send(JSON.stringify(make(binding)));
    await within(c.closed);
    assert.equal(called, 0);
  }
});

test("a projection failure preserves only the actual public Run identity for later control", async (t) => {
  const runId = "run_" + "e".repeat(32);
  const f = await fixture(t);
  const c = await f.connect({
    invoke: async () => {
      throw new AgentError(
        "run_context_too_large",
        "synthetic private failure",
        {
          runId,
          status: "running",
          privateValue: "synthetic-secret",
          path: "/private/profile",
        },
      );
    },
  });
  const { peer, binding } = await f.peer();
  peer.send(
    canonicalJson({
      type: "invoke",
      id: "projection_failure",
      operation: "agent.run.get",
      context: context(binding),
      input: { agentId: "agent", runId, waitMs: 0 },
    }),
  );
  const reply = await f.waitMessage(
    (message) =>
      message.type === "error" && message.id === "projection_failure",
  );
  assert.deepEqual(reply.error, {
    code: "run_context_too_large",
    message: "The Agent operation failed.",
    details: { runId, status: "running" },
  });
  assert(!JSON.stringify(reply).includes("synthetic-secret"));
  assert(!JSON.stringify(reply).includes("/private/profile"));
  c.close();
});
