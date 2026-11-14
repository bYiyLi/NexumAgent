import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const moduleUrl =
  process.env.NEXUM_APPLICATION_MODULE ??
  new URL("../dist/application/runtime.js", import.meta.url).href;
const { AgentRuntime } = await import(moduleUrl);
const { defaultBuiltins } = await import(
  new URL("../runtime/modules.js", moduleUrl).href
);
const { newId, canonicalJson } = await import(
  new URL("../contracts/json.js", moduleUrl).href
);
const { validateContract } = await import(
  new URL("../contracts/validation.js", moduleUrl).href
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const caller = {
  principalId: "owner",
  clientId: "client",
  grantId: "grant_fixture",
  hostRef: "host_fixture",
  hostCapabilities: { sampling: true, elicitation: true, roots: true },
};
function write(filename, content) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    typeof content === "string" || ArrayBuffer.isView(content)
      ? content
      : JSON.stringify(content),
  );
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "nexum-app-")),
    ),
    work = path.join(root, "work"),
    project = path.join(root, "project");
  mkdirSync(work);
  mkdirSync(project);
  write(path.join(work, "package.json"), { private: true, type: "module" });
  const bootId = newId("boot"),
    token = "fixture_private_agent_token",
    events = [],
    requests = [],
    streams = new Map(),
    sources = new Map(),
    sockets = new Set(),
    runEvents = new EventEmitter();
  let runtime, currentPort;
  const server = createServer((request, response) => {
    request.on("error", () => {});
    response.on("error", () => {});
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const id = request.url.split("/").at(-1),
        stream = streams.get(id);
      assert.ok(stream, "only prepared stream IDs may be used");
      assert.equal(
        request.headers["x-nexum-stream-purpose"],
        stream.ref.purpose,
      );
      assert.equal(
        request.headers["x-nexum-stream-direction"],
        stream.ref.direction,
      );
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Length": stream.bytes.length });
        response.end(stream.bytes);
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      stream.bytes = Buffer.concat(chunks);
      assert.equal(stream.bytes.length, stream.ref.size);
      assert.equal(hash(stream.bytes), stream.ref.sha256);
      stream.received.resolve(stream.bytes);
      response.writeHead(204);
      response.end();
    })().catch((cause) => {
      response.destroy();
      options.serverFailure?.(cause);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    try {
      await runtime?.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
  const serverUrl = `http://127.0.0.1:${server.address().port}/fixture`;
  function incoming(bytes, purpose = "attachment", metadata = {}) {
    const ref = {
      streamId: newId("stream"),
      purpose,
      direction: "cloud-to-agent",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxBytes: Math.max(1, bytes.length),
      size: bytes.length,
      sha256: hash(bytes),
      mimeType: "application/octet-stream",
      ...metadata,
    };
    streams.set(ref.streamId, {
      ref,
      bytes,
      received: Promise.withResolvers(),
    });
    return ref;
  }
  function port(connectionId = newId("connection")) {
    const controller = new AbortController();
    const value = {
      binding: {
        agentId: "agent_fixture",
        profile: "development",
        cloudEnvironment: "development",
        connectionId,
        bootId,
      },
      signal: controller.signal,
      async send(message) {
        validateContract("wire", message);
        events.push(message);
        await options.send?.(message);
        if (message.name === "agent.run.changed")
          runEvents.emit(message.data.runId, message);
      },
      async request(operation, context, input, signal) {
        signal.throwIfAborted();
        validateContract("wire.input:" + operation, input);
        requests.push({ operation, context, input });
        let output;
        if (operation === "authorization.refresh")
          output = { authorization: authorization(context.authorization) };
        else if (operation === "stream.prepare") {
          const {
            originInvocationId: _origin,
            runId: _run,
            resourceUri: _uri,
            ...source
          } = input;
          const ref = { streamId: newId("stream"), ...source };
          streams.set(ref.streamId, { ref, received: Promise.withResolvers() });
          output = { stream: ref };
        } else if (operation === "stream.revoke")
          output = { streamId: input.streamId, closed: true };
        else if (operation === "attachment.open") {
          assert.ok(
            events.some(
              (event) =>
                event.name === "agent.run.changed" &&
                event.data.originInvocationId === input.originInvocationId &&
                event.data.runId === input.runId,
            ),
            "actual announcement must settle before opening any source",
          );
          const source = sources.get(input.sourceId);
          assert.ok(source, "source is registered by the actual Host fixture");
          output = {
            stream: incoming(source.bytes, "attachment", source.ref),
            name: source.name ?? "input.bin",
            mimeType: source.mimeType ?? "application/octet-stream",
            size: source.bytes.length,
            sha256: source.sha256 ?? hash(source.bytes),
          };
        } else if (operation === "host.request") {
          const outbound = streams.get(input.body.streamId);
          const bytes = await outbound.received.promise;
          const payload = JSON.parse(bytes.toString("utf8"));
          options.hostRequest?.(input, payload);
          const result = options.hostResponse ?? {
            role: "assistant",
            model: "fixture",
            content: { type: "text", text: "host replied" },
          };
          const encoded = Buffer.from(canonicalJson(result));
          output = {
            action: input.action,
            body: incoming(encoded, "host-response", {
              mimeType: "application/json",
            }),
          };
        } else if (operation === "transfer.prepare")
          output = {
            transferId: input.transferId,
            request: {
              method: input.direction === "upload" ? "PUT" : "GET",
              url: serverUrl + "/public/" + input.transferId,
              headers: { "Content-Type": "application/octet-stream" },
              expiresAt: input.claimDeadlineAt,
            },
          };
        else if (operation === "transfer.revoke")
          output = { transferId: input.transferId, closed: true };
        else throw Error("unexpected reverse operation " + operation);
        validateContract("wire.output:" + operation, output);
        return output;
      },
      abort() {
        controller.abort();
      },
    };
    return value;
  }
  function authorization(extra = {}) {
    return {
      agentId: "agent_fixture",
      allowedRoots: [project],
      budgets: {
        textBytes: 256 * 1024,
        controlBytes: 1024 * 1024,
        fileBytes: 256 * 1024 * 1024,
      },
      revision: newId("policy"),
      expiresAt: new Date(Date.now() + 25_000).toISOString(),
      ...extra,
    };
  }
  if (options.prepare) await options.prepare({ root, work, project, write });
  currentPort = port();
  const config = {
    root,
    profile: "development",
    serverUrl,
    token,
    ...(options.config ?? {}),
  };
  runtime = await AgentRuntime.create(config, currentPort, bootId, {
    home: null,
    ...(options.runtime ?? {}),
  });
  async function invoke(
    operation,
    input,
    policy = {},
    who = caller,
    signal = AbortSignal.timeout(15000),
  ) {
    return runtime
      .dispatch(
        {
          type: "invoke",
          id: newId("rpc"),
          operation,
          context: {
            caller: who,
            authorization: authorization(policy),
            connection: currentPort.binding,
          },
          input,
        },
        signal,
      )
      .catch((cause) => {
        if (cause?.details?.errors)
          cause.message += " " + JSON.stringify(cause.details.errors);
        throw cause;
      });
  }
  const open = (input = {}, policy = {}) =>
    invoke("agent.open", { agentId: "agent_fixture", ...input }, policy);
  async function waitForState(value, expectedState) {
    const runId = value.run.runId,
      deadline = Date.now() + 15000;
    while (value.run.status !== expectedState) {
      assert.equal(
        ["succeeded", "failed", "cancelled", "interrupted"].includes(
          value.run.status,
        ),
        false,
        JSON.stringify(value),
      );
      const remaining = deadline - Date.now();
      assert.ok(
        remaining > 0,
        `Run ${runId} did not reach ${expectedState}: ${JSON.stringify(value)}`,
      );
      value = await invoke("agent.run.get", {
        agentId: "agent_fixture",
        runId,
        waitMs: Math.min(1000, remaining),
      });
      assert.equal(value.run.runId, runId);
    }
    return value;
  }
  async function finish(value) {
    const runId = value.run.runId,
      deadline = Date.now() + 15000;
    while (
      !["succeeded", "failed", "cancelled", "interrupted"].includes(
        value.run.status,
      )
    ) {
      const remaining = deadline - Date.now();
      assert.ok(
        remaining > 0,
        `Run ${runId} did not settle: ${JSON.stringify(value)}`,
      );
      const observation = new AbortController();
      const changed = once(runEvents, runId, {
        signal: AbortSignal.any([
          observation.signal,
          AbortSignal.timeout(remaining),
        ]),
      });
      void changed.catch(() => {});
      try {
        value = await invoke("agent.run.get", {
          agentId: "agent_fixture",
          runId,
          waitMs: Math.min(1000, remaining),
        });
        assert.equal(value.run.runId, runId);
        // A delivered input can still expose the same wait while its native
        // preparation settles. Wait for a real lifecycle event, not a busy
        // microtask loop or a fixed sleep, before observing that Run again.
        if (
          value.wait &&
          !["succeeded", "failed", "cancelled", "interrupted"].includes(
            value.run.status,
          )
        )
          await changed;
      } finally {
        observation.abort();
      }
    }
    return value;
  }
  async function run(script, input = null, workView) {
    const opened = workView ?? (await open());
    return finish(
      await invoke("agent.run.start", {
        contextId: opened.contextId,
        script,
        input,
        waitMs: 1000,
      }),
    );
  }
  return {
    root,
    work,
    project,
    runtime,
    events,
    requests,
    streams,
    sources,
    incoming,
    invoke,
    open,
    finish,
    waitForState,
    run,
    authorization,
    get binding() {
      return currentPort.binding;
    },
    disconnect() {
      currentPort.abort();
    },
    async reconnect() {
      currentPort.abort();
      currentPort = port();
      await runtime.attachConnection(currentPort);
      return currentPort;
    },
  };
}

test("actual application composes one work, VM, registry, local state and output encoder", async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  assert.equal(opened.pwd, f.work);
  assert.equal(opened.project, null);
  assert.ok(
    opened.agent.instructions.some((instruction) =>
      instruction.content.includes("Node/npm"),
    ),
  );
  const result = await f.run(
    `const fs = await import('node:fs/promises'); const p=await import('node:path'); await fs.writeFile(p.join(context.pwd,'from-runtime.txt'),'actual'); const stored=await state.agent.set('count',{value:context.input},{expectedVersion:null}); return output.json({file:await fs.readFile(p.join(context.pwd,'from-runtime.txt'),'utf8'),value:stored.value});`,
    7,
    opened,
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.file, "actual");
  assert.deepEqual(result.result.data.value, { value: 7 });
  assert.equal(
    readFileSync(path.join(f.work, "from-runtime.txt"), "utf8"),
    "actual",
  );
  assert.ok(
    f.events.some(
      (event) =>
        event.name === "agent.run.changed" && event.data.originInvocationId,
    ),
  );
});

test("header enrollment, scriptName execution, default discovery and filtered history reuse the actual Core", async (t) => {
  const f = await fixture(t),
    opened = await f.open();
  const header = {
    scriptName: "repeat.js",
    scriptDesc: "Return one value",
    scriptWhenUse: "Repeat a known flow",
    scriptOpenDefault: true,
    scriptInputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  const first = await f.run(
    "/**\n" +
      JSON.stringify(header) +
      "\n*/\nreturn {value:context.input.value};",
    { value: 1 },
    opened,
  );
  assert.equal(first.run.status, "succeeded", JSON.stringify(first));
  const second = await f.finish(
    await f.invoke("agent.run.start", {
      contextId: opened.contextId,
      scriptName: "repeat.js",
      input: { value: 2 },
      waitMs: 1000,
    }),
  );
  assert.equal(second.run.status, "succeeded", JSON.stringify(second));
  assert.equal(second.result.data.value, 2);
  const list = await f.invoke("agent.run.list", {
    agentId: "agent_fixture",
    scriptName: "repeat.js",
    status: "succeeded",
  });
  assert.ok(list.runs.some((run) => run.runId === second.run.runId));
  const refresh = await f.open({ contextId: opened.contextId });
  assert.ok(JSON.stringify(refresh.agent.scripts).includes("repeat.js"));
});

test("wait continuation consumes the same Core run and uses its actual input origin", async (t) => {
  const f = await fixture(t),
    opened = await f.open();
  let waiting = await f.invoke("agent.run.start", {
    contextId: opened.contextId,
    script: `const answer=await runtime.requestInput({message:'next',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}});return {value:answer.input.value};`,
    waitMs: 0,
  });
  waiting = await f.waitForState(waiting, "waiting_input");
  assert.equal(waiting.run.status, "waiting_input", JSON.stringify(waiting));
  const resumed = await f.finish(
    await f.invoke("agent.run.input", {
      agentId: "agent_fixture",
      runId: waiting.run.runId,
      waitId: waiting.wait.waitId,
      input: { value: 19 },
      waitMs: 1000,
    }),
  );
  assert.equal(resumed.run.runId, waiting.run.runId);
  assert.equal(resumed.run.status, "succeeded", JSON.stringify(resumed));
  assert.equal(resumed.result.data.value, 19);
  assert.ok(
    f.events.filter(
      (event) =>
        event.data.runId === waiting.run.runId && event.data.originInvocationId,
    ).length >= 2,
  );
});

test("real HTTP attachments form a >64KiB immutable input barrier before script execution", async (t) => {
  const f = await fixture(t),
    opened = await f.open(),
    bytes = Buffer.alloc(512 * 1024 + 7, 0xff);
  const sourceId = "att_" + hash(Buffer.from("one"));
  f.sources.set(sourceId, { bytes, name: "picture.bin" });
  const value = await f.finish(
    await f.invoke("agent.run.start", {
      contextId: opened.contextId,
      script: `const fs=await import('node:fs/promises'); const crypto=await import('node:crypto'); const item=context.attachments[0]; return {size:item.size,actual:(await fs.readFile(item.path)).length,sha:crypto.createHash('sha256').update(await fs.readFile(item.path)).digest('hex'),name:item.name};`,
      attachments: [{ sourceId }],
      waitMs: 1000,
    }),
  );
  assert.equal(value.run.status, "succeeded", JSON.stringify(value));
  assert.deepEqual(value.result.data, {
    size: bytes.length,
    actual: bytes.length,
    sha: hash(bytes),
    name: "picture.bin",
  });
  assert.equal(
    JSON.stringify(value).includes("fixture_private_agent_token"),
    false,
  );
});

test("failed required attachment prevents business code and cleans previously committed batch files", async (t) => {
  const f = await fixture(t),
    opened = await f.open(),
    bytes = Buffer.alloc(128 * 1024, 7);
  const goodId = "att_" + hash(Buffer.from("good")),
    badId = "att_" + hash(Buffer.from("bad"));
  f.sources.set(goodId, { bytes });
  f.sources.set(badId, {
    bytes,
    ref: { sha256: "0".repeat(64) },
    sha256: "0".repeat(64),
  });
  const result = await f.finish(
    await f.invoke("agent.run.start", {
      contextId: opened.contextId,
      script: `const fs=await import('node:fs/promises');await fs.writeFile(context.pwd+'/MUST-NOT-RUN','bad');return true;`,
      attachments: [{ sourceId: goodId }, { sourceId: badId }],
      waitMs: 1000,
    }),
  );
  assert.equal(result.run.status, "failed", JSON.stringify(result));
  assert.equal(existsSync(path.join(f.work, "MUST-NOT-RUN")), false);
});

test("reconnect retains the actual engine and accepted computation; project close closes every project context", async (t) => {
  const f = await fixture(t),
    opened = await f.open();
  const running = await f.invoke("agent.run.start", {
    contextId: opened.contextId,
    script: `const {setTimeout}=await import('node:timers/promises');await setTimeout(150);return {bootRun:context.runId};`,
    waitMs: 0,
  });
  await f.reconnect();
  const finished = await f.finish(running);
  assert.equal(finished.run.runId, running.run.runId);
  assert.equal(finished.run.status, "succeeded", JSON.stringify(finished));
  const projectPolicy = {
    projectId: "project_one",
    projectRoot: f.project,
    projectName: "Fixture",
  };
  const first = await f.open({ projectId: "project_one" }, projectPolicy),
    second = await f.open({ projectId: "project_one" }, projectPolicy);
  const close = await f.invoke(
    "agent.close",
    { contextId: first.contextId },
    projectPolicy,
  );
  assert.deepEqual(
    new Set(close.affectedContextIds),
    new Set([first.contextId, second.contextId]),
  );
  assert.equal(close.projectId, "project_one");
  await assert.rejects(
    f.invoke("agent.run.start", {
      contextId: second.contextId,
      script: "return true;",
    }),
    (cause) => /context/.test(cause.code),
  );
});

test("result resources use registered fixed bytes and native HTTP rather than an Offer or original file", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(512 * 1024 + 9, 0xe3);
  write(path.join(f.work, "export.bin"), bytes);
  const result = await f.run(`return output.file('export.bin');`);
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  const uri = result.result.content.find(
    (item) => item.type === "resource_link",
  ).uri;
  write(path.join(f.work, "export.bin"), "changed");
  const listed = await f.invoke("agent.resources.list", {});
  assert.ok(listed.resources.some((resource) => resource.uri === uri));
  const response = await f.invoke("agent.resources.read", {
    uri,
    maxBytes: bytes.length,
  });
  const stream = f.streams.get(response.contents[0].stream.streamId);
  assert.deepEqual(await stream.received.promise, bytes);
});

test("a declared package alone does not become approved or enabled SDK capability", async (t) => {
  const f = await fixture(t, {
    prepare({ work, write }) {
      write(path.join(work, "package.json"), {
        type: "module",
        dependencies: { "unapproved-fixture": "1.0.0" },
      });
      write(path.join(work, "node_modules/unapproved-fixture/package.json"), {
        name: "unapproved-fixture",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      });
      write(
        path.join(work, "node_modules/unapproved-fixture/index.js"),
        "export const value=42;",
      );
    },
  });
  const result = await f.run(
    "const p=await import('unapproved-fixture');return p.value;",
  );
  assert.equal(result.run.status, "failed", JSON.stringify(result));
  assert.match(result.run.error.code, /module|script/);
});

test("an explicitly approved enabled npm SDK contributes capabilities, materials and original-Host sampling", async (t) => {
  let host;
  const f = await fixture(t, {
    runtime: {
      modulePolicy: {
        builtins: () => defaultBuiltins,
        approvedPackages: () => new Map([["fixture-sdk", "1.0.0"]]),
      },
      extensionPermissions: new Set(["read"]),
    },
    hostRequest(input, body) {
      host = { input, body };
    },
    prepare({ root, work, write }) {
      write(path.join(work, "package.json"), {
        type: "module",
        dependencies: { "fixture-sdk": "1.0.0" },
      });
      const dir = path.join(work, "node_modules/fixture-sdk");
      write(path.join(dir, "package.json"), {
        name: "fixture-sdk",
        version: "1.0.0",
        type: "module",
        exports: {
          "./nexum": { types: "./extension.d.ts", import: "./extension.js" },
        },
        nexum: {
          apiVersion: 1,
          namespace: "probe",
          permissions: ["read"],
          docs: "./docs",
          instructions: "./rules.md",
        },
      });
      write(
        path.join(dir, "extension.d.ts"),
        "export default function createExtension(host:unknown):unknown;\n",
      );
      write(
        path.join(dir, "docs/README.md"),
        "# Probe guide\nUse sample for the original Host.\n",
      );
      write(
        path.join(dir, "rules.md"),
        "# Probe rules\nUse only negotiated sampling.\n",
      );
      write(
        path.join(dir, "extension.js"),
        `export default function(){return {methods:{sample:{description:'Sample using original Host',permissions:['read'],schemaDialect:'draft7',inputSchema:{type:'object',additionalProperties:false},async handle(_input,call){return await call.hostRequests.sampling({messages:[{role:'user',content:{type:'text',text:'actual Host request'}}]});}}}};}`,
      );
      write(path.join(root, "state/maintenance/extensions.json"), {
        "fixture-sdk": {
          enabled: true,
          objectId: "extension_fixture",
          revision: "revision_fixture",
          config: {},
        },
      });
    },
  });
  const opened = await f.open();
  assert.ok(
    opened.agent.instructions.some((item) =>
      item.content.includes("Probe rules"),
    ),
  );
  const result = await f.run("return await probe.sample({});", null, opened);
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.model, "fixture");
  assert.equal(host.input.hostRef, caller.hostRef);
  assert.equal(host.input.action, "sampling");
  assert.equal(host.body.messages[0].content.text, "actual Host request");
  assert.ok(
    f.events.some(
      (event) =>
        event.data.originInvocationId === host.input.originInvocationId &&
        event.data.runId === result.run.runId,
    ),
  );
});

class ApprovedFixtureAuthority {
  records = new Map();
  async create(identity, input) {
    const requestId = "maint_req_app_" + (this.records.size + 1);
    const record = {
      ...JSON.parse(JSON.stringify(input)),
      requestId,
      agentId: identity.agentId,
      profile: identity.profile,
      status: "pending",
      revision: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      approvalUrl: "https://cloud.example/authorize/maintenance/" + requestId,
    };
    delete record.requestKey;
    delete record.originRunId;
    this.records.set(requestId, record);
    return structuredClone(record);
  }
  async get(_identity, id) {
    return structuredClone(this.records.get(id));
  }
  decision(...args) {
    return this.get(...args);
  }
  approve(id) {
    const view = this.records.get(id);
    view.status = "approved";
    view.decidedAt = new Date().toISOString();
    view.decision = {
      status: "approved",
      revision: view.revision,
      candidateRevision: view.candidateRevision,
      decidedAt: view.decidedAt,
      decisionId: "decision-" + id,
    };
    delete view.approvalUrl;
  }
  async beginExecution(identity, input) {
    const view = this.records.get(input.requestId);
    assert.equal(view.candidateRevision, input.approvedRevision);
    view.execution = {
      operationId: input.operationId,
      startedAt: new Date().toISOString(),
    };
    return structuredClone(view);
  }
}
async function configuredFixture(t, options = {}) {
  const { MaintenanceRequests } = await import(
    new URL("../maintenance/requests.js", moduleUrl)
  );
  const authority = new ApprovedFixtureAuthority();
  let components, requests;
  const f = await fixture(t, {
    ...options,
    runtime: {
      ...options.runtime,
      configureMaintenance: async (value) => {
        components = value;
        return (requests = new MaintenanceRequests(
          value.store,
          authority,
          await value.configurationBackend(),
          { approvalOrigin: "https://cloud.example" },
        ));
      },
    },
  });
  const origin = await f.run("return null;");
  const scope = () =>
    components.scope(caller, new AbortController().signal, origin.run.runId);
  return {
    ...f,
    get binding() {
      return f.binding;
    },
    components,
    maintenance: requests,
    authority,
    scope,
    async approve(request) {
      await assert.rejects(requests.execute(request.requestId, scope()), {
        code: "maintenance_not_approved",
      });
      authority.approve(request.requestId);
      const result = await requests.execute(request.requestId, scope());
      assert.equal(
        result.execution.status,
        "succeeded",
        JSON.stringify(result),
      );
      return result;
    },
  };
}

test("the default configuration backend publishes approved API definitions through the original Registry and atomically replaces them", async (t) => {
  let revision = 1;
  const business = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/spec")
      res.end(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Fixture API", version: String(revision) },
          servers: [{ url: `http://127.0.0.1:${business.address().port}` }],
          paths: {
            ["/value" + revision]: {
              get: {
                operationId: "read",
                responses: {
                  200: {
                    description: "value",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { version: { type: "integer" } },
                          required: ["version"],
                          additionalProperties: false,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
    else res.end(JSON.stringify({ version: Number(req.url.slice(-1)) }));
  });
  await new Promise((resolve) => business.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        business.closeAllConnections();
        business.close(resolve);
      }),
  );
  const f = await configuredFixture(t),
    url = `http://127.0.0.1:${business.address().port}/spec`;
  const pending = await f.maintenance
    .bind(f.scope())
    .api.import({ name: "crm", url });
  assert.equal(
    (await f.run("return {type:typeof api};")).result.data.type,
    "undefined",
  );
  await f.approve(pending);
  assert.equal(
    (await f.run("return {version:(await api.crm.read()).data.version};"))
      .result.data.version,
    1,
  );
  const opened = await f.open();
  assert.ok(JSON.stringify(opened.agent.docs).includes("api.crm"));
  revision = 2;
  const update = await f.maintenance
    .bind(f.scope())
    .api.update({ name: "crm", url });
  assert.equal(
    (await f.run("return {version:(await api.crm.read()).data.version};"))
      .result.data.version,
    1,
  );
  await f.approve(update);
  assert.equal(
    (await f.run("return {version:(await api.crm.read()).data.version};"))
      .result.data.version,
    2,
  );
  const removal = await f.maintenance
    .bind(f.scope())
    .api.remove({ name: "crm" });
  assert.equal(
    (await f.run("return {version:(await api.crm.read()).data.version};"))
      .result.data.version,
    2,
  );
  await f.approve(removal);
  assert.equal(
    (await f.run("return {type:typeof api};")).result.data.type,
    "undefined",
  );
});

test("approved MCP connections contribute real SDK methods, instructions and lossless standard multi-resource bodies", async (t) => {
  const f = await configuredFixture(t);
  const fixtureFile = path.join(f.work, "mcp-fixture.cjs");
  writeFileSync(
    fixtureFile,
    `const readline=require('node:readline'); const v=process.argv[2];
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(!('id'in q))return;
if(q.method==='initialize')send(q.id,{protocolVersion:q.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:v},instructions:'Approved MCP guide '+v});
else if(q.method==='tools/list')send(q.id,{tools:[{name:'version',description:'Actual child revision',inputSchema:{type:'object',additionalProperties:false}}]});
else if(q.method==='resources/list')send(q.id,{resources:[{uri:'fixture://value',name:'value'}]});
else if(q.method==='resources/templates/list')send(q.id,{resourceTemplates:[]});
else if(q.method==='tools/call')send(q.id,{content:[{type:'text',text:v},{type:'resource_link',uri:'fixture://value',name:'value'}]});
else if(q.method==='resources/read')send(q.id,{contents:[{uri:'fixture://value',mimeType:'text/plain',text:'',_meta:{piece:1}},{uri:'fixture://binary',mimeType:'application/octet-stream',blob:Buffer.alloc(96*1024,255).toString('base64'),_meta:{piece:2}}],_meta:{top:'preserved'}});
else send(q.id,{});});`,
  );
  const config = (version) => ({
    transport: "stdio",
    command: process.execPath,
    args: [fixtureFile, version],
    cwd: f.work,
  });
  await f.approve(
    await f.maintenance
      .bind(f.scope())
      .mcp.add({ name: "fixture", config: config("1") }),
  );
  const run = await f.run("return await mcp.fixture.tools.version({});");
  assert.equal(run.run.status, "succeeded", JSON.stringify(run));
  assert.equal(run.result.content[0].text, "1");
  assert.ok(
    (await f.open()).agent.instructions.some(
      (value) => value.content === "Approved MCP guide 1",
    ),
  );
  const read = await f.run(
    "return await mcp.fixture.resources.read({uri:'fixture://value'});",
  );
  assert.equal(read.run.status, "succeeded", JSON.stringify(read));
  const listing = await f.run("return await mcp.fixture.resources.list({});");
  assert.equal(listing.result.data.resources[0].uri, "fixture://value");
  const resourceUri = run.result.content.find(
    (value) => value.type === "resource_link",
  )?.uri;
  assert.ok(resourceUri, JSON.stringify(listing));
  const projected = await f.invoke("agent.resources.read", {
    uri: resourceUri,
    maxBytes: 1024 * 1024,
  });
  assert.ok(projected.body, JSON.stringify(projected));
  const bytes = await f.streams.get(projected.body.streamId).received.promise;
  const body = JSON.parse(bytes.toString("utf8"));
  assert.equal(body._meta.top, "preserved");
  assert.ok(
    body._meta["io.nexum/mcp"].protocolMeta.some(
      (value) => value.target === "result" && value.meta.top === "preserved",
    ),
  );
  assert.equal(body.contents[0].text, "");
  assert.deepEqual(
    body.contents.map((value) => value._meta),
    [{ piece: 1 }, { piece: 2 }],
  );
  assert.equal(Buffer.from(body.contents[1].blob, "base64").length, 96 * 1024);
  await f.approve(
    await f.maintenance
      .bind(f.scope())
      .mcp.update({ name: "fixture", config: config("2") }),
  );
  const next = await f.run("return await mcp.fixture.tools.version({});");
  assert.equal(next.result.content[0].text, "2");
  assert.ok(
    (await f.open()).agent.instructions.some(
      (value) => value.content === "Approved MCP guide 2",
    ),
  );
  assert.equal(
    (await f.open()).agent.instructions.some(
      (value) => value.content === "Approved MCP guide 1",
    ),
    false,
  );
});

test("close reports an unsettled native Promise and keeps its Store available until an explicit retry joins it", async (t) => {
  const f = await fixture(t, { runtime: { shutdownWaitMs: 30 } }),
    opened = await f.open();
  const gate = path.join(f.work, "release-native-promise"),
    ready = path.join(f.work, "native-promise-ready");
  const started = await f.invoke("agent.run.start", {
    contextId: opened.contextId,
    script: `const fs=await import('node:fs/promises'); const timers=await import('node:timers/promises'); await fs.writeFile(${JSON.stringify(ready)},'ready'); while(true){try{await fs.access(${JSON.stringify(gate)});break;}catch{} await timers.setTimeout(10);} return 1;`,
    waitMs: 0,
  });
  try {
    const readyDeadline = Date.now() + 10000;
    while (!existsSync(ready) && Date.now() < readyDeadline) await delay(10);
    assert.equal(
      existsSync(ready),
      true,
      "the actual native Promise must enter before shutdown",
    );
    await assert.rejects(f.runtime.close(), { code: "shutdown_unconfirmed" });
  } finally {
    writeFileSync(gate, "release");
  }
  const closedDeadline = Date.now() + 10000;
  for (;;) {
    try {
      await f.runtime.close();
      break;
    } catch (cause) {
      if (cause.code !== "shutdown_unconfirmed" || Date.now() >= closedDeadline)
        throw cause;
      await delay(20);
    }
  }
  assert.ok(started.run.runId);
});

test("explicit Cloud revocation aborts the original live Run and its actual native fetch with the authorization stop reason", async (t) => {
  const entered = Promise.withResolvers(),
    disconnected = Promise.withResolvers();
  const remote = createServer((request, response) => {
    request.on("close", () => disconnected.resolve());
    response.on("error", () => {});
    entered.resolve();
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        remote.closeAllConnections();
        remote.close(resolve);
      }),
  );
  const f = await configuredFixture(t);
  const handle = await f.components.registry.prepare(
    {
      apiVersion: 1,
      origin: {
        type: "extension",
        owner: "@test/revoke",
        namespace: "live",
        version: "1",
        revision: "1",
      },
      permissions: [],
    },
    () => ({
      methods: {
        hold: {
          description:
            "Await real native HTTP until current authorization stops",
          permissions: [],
          schemaDialect: "draft7",
          inputSchema: { type: "object", additionalProperties: false },
          async handle(_input, call) {
            const response = await fetch(
              `http://127.0.0.1:${remote.address().port}`,
              { signal: call.signal },
            );
            return response.status;
          },
        },
      },
    }),
  );
  f.components.registry.publish(handle);
  const opened = await f.open(),
    started = await f.invoke("agent.run.start", {
      contextId: opened.contextId,
      script: "return await live.hold({});",
      waitMs: 0,
    });
  await entered.promise;
  await f.runtime.event(
    {
      type: "event",
      name: "agent.authorization.changed",
      connection: f.binding,
      data: { caller, authorization: null },
    },
    new AbortController().signal,
  );
  await disconnected.promise;
  const row = f.components.store.getRun(started.run.runId);
  assert.equal(row.stop.kind, "authorization");
  assert.equal(row.stop.code, "authorization_revoked");
  for (
    let i = 0;
    i < 100 && !f.components.store.getRun(started.run.runId).endedAt;
    i++
  )
    await delay(10);
  assert.equal(f.components.store.getRun(started.run.runId).status, "failed");
  assert.equal(
    (await f.components.registry.disable(handle)).status,
    "disabled",
  );
});

test("an independent maintenance lease outlives its creator and observer connection but aborts on explicit revocation", async (t) => {
  const f = await configuredFixture(t),
    opened = await f.open();
  const origin = await f.run("return null;", null, opened);
  const originInvocationId = f.events.find(
    (event) =>
      event.data?.runId === origin.run.runId && event.data.originInvocationId,
  ).data.originInvocationId;
  const spec = path.join(f.work, "lease-spec.json");
  writeFileSync(
    spec,
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "lease", version: "1" },
      paths: {
        "/value": {
          get: {
            operationId: "read",
            responses: { 200: { description: "value" } },
          },
        },
      },
      servers: [{ url: "https://api.example.com" }],
    }),
  );
  const created = await f.maintenance
    .bind(f.scope())
    .api.import({ name: "lease", path: spec });
  const lease = f.components.startLease(
    caller,
    { maintenanceRequestId: created.requestId, originInvocationId },
    new AbortController().signal,
  );
  await f.reconnect();
  assert.equal(lease.scope.signal.aborted, false);
  await f.runtime.event(
    {
      type: "event",
      name: "agent.authorization.changed",
      connection: f.binding,
      data: { caller, authorization: null },
    },
    new AbortController().signal,
  );
  assert.equal(lease.scope.signal.aborted, true);
  assert.equal(lease.scope.signal.reason.code, "authorization_revoked");
  lease.close();
});

test("the default package policy imports only its verified approved snapshot and immediately rejects work manifest drift", async (t) => {
  const f = await configuredFixture(t);
  const manifest = JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "approved-runtime-fixture": "1.0.0" },
  });
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "approved-runtime-fixture": "1.0.0" } },
      "node_modules/approved-runtime-fixture": { version: "1.0.0" },
    },
  });
  write(path.join(f.work, "package.json"), manifest);
  write(path.join(f.work, "package-lock.json"), lock);
  write(
    path.join(f.work, "node_modules/approved-runtime-fixture/package.json"),
    {
      name: "approved-runtime-fixture",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    },
  );
  write(
    path.join(f.work, "node_modules/approved-runtime-fixture/index.js"),
    "export const value=48;",
  );
  assert.equal(
    (
      await f.run(
        "return {value:(await import('approved-runtime-fixture')).value};",
      )
    ).run.status,
    "failed",
  );
  await f.components.refreshPackages({
    target: {
      name: "approved-runtime-fixture",
      action: "install",
      version: "1.0.0",
    },
    manifest,
    lock,
  });
  const approved = await f.run(
    "return {value:(await import('approved-runtime-fixture')).value};",
  );
  assert.equal(approved.run.status, "succeeded", JSON.stringify(approved));
  assert.equal(approved.result.data.value, 48);
  assert.match(
    readFileSync(path.join(f.work, "docs/packages/README.md"), "utf8"),
    /approved-runtime-fixture/,
  );
  write(path.join(f.work, "package.json"), manifest + "\n");
  assert.equal(
    (
      await f.run(
        "return {value:(await import('approved-runtime-fixture')).value};",
      )
    ).run.status,
    "failed",
  );
});

test("Task association controls the same waiting Run and retains its original normalized result", async (t) => {
  const f = await fixture(t),
    opened = await f.open();
  let waiting = await f.invoke("agent.run.start", {
    contextId: opened.contextId,
    script:
      "const answer=await runtime.requestInput({message:'next',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}});return {value:answer.input.value};",
    waitMs: 1000,
  });
  waiting = await f.waitForState(waiting, "waiting_input");
  const task = await f.invoke("agent.tasks.create", {
    runId: waiting.run.runId,
    ttlMs: 60000,
  });
  assert.equal(task.runId, waiting.run.runId);
  const before = await f.invoke("agent.tasks.get", { taskId: task.taskId });
  assert.equal(before.view.run.runId, waiting.run.runId);
  const updated = await f.invoke("agent.tasks.update", {
    taskId: task.taskId,
    waitId: waiting.wait.waitId,
    input: { value: 48 },
  });
  assert.equal(updated.view.run.runId, waiting.run.runId);
  await f.finish(updated.view);
  let completed = await f.invoke("agent.tasks.get", { taskId: task.taskId });
  const terminalDeadline = Date.now() + 10000;
  while (
    ["working", "input_required"].includes(completed.task.status) &&
    Date.now() < terminalDeadline
  ) {
    await delay(20);
    completed = await f.invoke("agent.tasks.get", { taskId: task.taskId });
  }
  assert.equal(completed.task.status, "completed", JSON.stringify(completed));
  assert.equal(completed.view.result.data.value, 48);
  const historical = await f.invoke("agent.tasks.get", { taskId: task.taskId });
  assert.deepEqual(historical.view.result, completed.view.result);
});

test("the Console owner session inspects its actual project snapshot and materials while every execution entry stays closed", async (t) => {
  const f = await fixture(t, {
    prepare({ project, write }) {
      write(
        path.join(project, "README.md"),
        "# Actual project\n" + "README正文\n".repeat(2000),
      );
      write(path.join(project, "AGENTS.md"), "Project instructions\n");
      write(
        path.join(project, ".agents/skills/console-skill/SKILL.md"),
        "---\nname: console-skill\ndescription: Inspect local project metadata\n---\nSkill entry\n",
      );
      write(
        path.join(project, ".agents/skills/console-skill/references/detail.md"),
        "Canonical skill detail\n",
      );
    },
  });
  const sessionRef = hash(Buffer.from("actual-console-session")),
    owner = {
      principalId: "owner",
      clientId: "nexum-console:" + sessionRef,
      source: "owner_session",
      sessionRef,
    };
  const policy = {
    projectId: "project_console",
    projectRoot: f.project,
    projectName: "Console project",
  };
  const resolved = await f.invoke(
    "agent.project.resolve",
    { path: f.project },
    policy,
    owner,
  );
  assert.equal(resolved.root, f.project);
  const opened = await f.invoke(
    "agent.project.inspect",
    { projectId: policy.projectId },
    policy,
    owner,
  );
  assert.equal(opened.project.projectId, policy.projectId);
  assert.ok(opened.project.descriptionItemId);
  assert.ok(
    opened.project.management.instructions.every(
      (item) => item.content === undefined,
    ),
  );
  const read = await f.invoke(
    "agent.context.read",
    {
      contextId: opened.contextId,
      revision: opened.revision,
      itemId: opened.project.descriptionItemId,
      maxBytes: 65536,
    },
    policy,
    owner,
  );
  assert.match(read.text, /^# Actual project/);
  const skill = opened.project.management.skills.find(
    (item) => item.name === "console-skill",
  );
  assert.ok(skill, JSON.stringify(opened.project.management.skills));
  const tree = await f.invoke(
    "agent.context.read",
    {
      contextId: opened.contextId,
      revision: opened.revision,
      itemId: skill.itemId,
      includeEntries: true,
      maxBytes: 65536,
    },
    policy,
    owner,
  );
  assert.ok(
    tree.entries.some(
      (item) =>
        item.displayPath === "references/detail.md" && item.kind === "file",
    ),
  );
  const detail = await f.invoke(
    "agent.context.read",
    {
      contextId: opened.contextId,
      revision: opened.revision,
      itemId: skill.itemId,
      relativePath: "references/detail.md",
      maxBytes: 65536,
    },
    policy,
    owner,
  );
  assert.equal(detail.text, "Canonical skill detail\n");
  await assert.rejects(
    f.invoke(
      "agent.run.start",
      { contextId: opened.contextId, script: "return 1;" },
      policy,
      owner,
    ),
    (cause) =>
      ["invalid_arguments", "invalid_control_direction"].includes(cause.code),
  );
  const otherRef = hash(Buffer.from("other-session")),
    other = {
      ...owner,
      clientId: "nexum-console:" + otherRef,
      sessionRef: otherRef,
    };
  await assert.rejects(
    f.invoke(
      "agent.context.read",
      {
        contextId: opened.contextId,
        revision: opened.revision,
        itemId: skill.itemId,
        maxBytes: 65536,
      },
      policy,
      other,
    ),
    { code: "context_forbidden" },
  );
});

test("Console Run inspection reads original history without creating streams, Offers or a new execution", async (t) => {
  const f = await fixture(t);
  const original = await f.run(
    "const fs=await import('node:fs/promises');const {Buffer}=await import('node:buffer');const p=await import('node:path');await fs.writeFile(p.join(context.pwd,'history.bin'),Buffer.alloc(131072,7));return output.file('history.bin');",
  );
  assert.equal(original.run.status, "succeeded", JSON.stringify(original));
  const sessionRef = hash(Buffer.from("console-history")),
    owner = {
      principalId: "owner",
      clientId: "nexum-console:" + sessionRef,
      source: "owner_session",
      sessionRef,
    };
  const before = f.requests.filter(
    (value) => value.operation === "stream.prepare",
  ).length;
  const inspected = await f.invoke(
    "agent.run.inspect",
    { runId: original.run.runId },
    {},
    owner,
  );
  assert.equal(inspected.run.runId, original.run.runId);
  assert.equal(inspected.run.status, "succeeded");
  assert.equal(inspected.result.content[0].uri, original.result.content[0].uri);
  assert.equal(inspected.transient, undefined);
  assert.equal(
    f.requests.filter((value) => value.operation === "stream.prepare").length,
    before,
  );
  assert.equal(
    f.events.filter(
      (value) =>
        value.data.originInvocationId &&
        value.data.runId === original.run.runId,
    ).length,
    1,
  );
  await assert.rejects(
    f.invoke(
      "agent.run.inspect",
      { runId: original.run.runId },
      {
        projectId: newId("project"),
        projectRoot: f.project,
        projectName: "Other project",
      },
      owner,
    ),
    { code: "authorization_scope_mismatch" },
  );
});

test("a fresh Agent owner session reads closed Project history using its current roots without borrowing a Project policy cell", async (t) => {
  const f = await fixture(t);
  const projectId = newId("project"),
    projectPolicy = {
      projectId,
      projectRoot: f.project,
      projectName: "Actual Project",
      allowedRoots: [f.project],
    };
  const opened = await f.open({ projectId }, projectPolicy);
  const original = await f.finish(
    await f.invoke(
      "agent.run.start",
      {
        contextId: opened.contextId,
        script: "return {history:48};",
        waitMs: 1000,
      },
      projectPolicy,
    ),
  );
  assert.equal(original.run.status, "succeeded", JSON.stringify(original));
  await f.invoke("agent.close", { contextId: opened.contextId }, projectPolicy);
  const sessionRef = hash(Buffer.from("fresh-project-history-owner"));
  const owner = {
    principalId: "owner",
    clientId: "nexum-console:" + sessionRef,
    source: "owner_session",
    sessionRef,
  };
  const inspected = await f.invoke(
    "agent.run.inspect",
    { runId: original.run.runId },
    { allowedRoots: [f.project] },
    owner,
  );
  assert.equal(inspected.run.projectId, projectId);
  assert.equal(inspected.result.data.history, 48);
  assert.equal(inspected.transient, undefined);
  // A valid Project policy for the same session must never override a newer
  // Agent-base request that no longer grants this directory.
  await f.runtime.event(
    {
      type: "event",
      name: "agent.authorization.changed",
      connection: f.binding,
      data: { caller: owner, authorization: f.authorization(projectPolicy) },
    },
    new AbortController().signal,
  );
  await assert.rejects(
    f.invoke(
      "agent.run.inspect",
      { runId: original.run.runId },
      { allowedRoots: [] },
      owner,
    ),
    { code: "path_not_allowed" },
  );
  await assert.rejects(
    f.invoke(
      "agent.run.inspect",
      { runId: original.run.runId },
      {
        ...projectPolicy,
        projectId: newId("project"),
        projectName: "Other Project",
      },
      owner,
    ),
    { code: "authorization_scope_mismatch" },
  );
  const history = await f.invoke(
    "agent.run.list",
    { agentId: "agent_fixture", limit: 20 },
    { allowedRoots: [f.project] },
  );
  assert.ok(history.runs.some((run) => run.runId === original.run.runId));
});

test("current Agent authorization can resume and cancel accepted Project Runs after their Project work closes", async (t) => {
  const f = await fixture(t),
    projectId = newId("project");
  const projectPolicy = {
    projectId,
    projectRoot: f.project,
    projectName: "Original Project",
    allowedRoots: [f.project],
  };
  const opened = await f.open({ projectId }, projectPolicy);
  async function waitingRun() {
    let waiting = await f.invoke(
      "agent.run.start",
      {
        contextId: opened.contextId,
        script:
          "const answer=await runtime.requestInput({message:'continue',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}});return {value:answer.input.value,project:context.project.projectId};",
        waitMs: 1000,
      },
      projectPolicy,
    );
    waiting = await f.waitForState(waiting, "waiting_input");
    assert.equal(waiting.run.status, "waiting_input", JSON.stringify(waiting));
    return waiting;
  }
  const waiting = await waitingRun();
  const cancelling = await waitingRun();
  await f.invoke("agent.close", { contextId: opened.contextId }, projectPolicy);
  await assert.rejects(
    f.invoke(
      "agent.run.input",
      {
        agentId: "agent_fixture",
        runId: waiting.run.runId,
        waitId: waiting.wait.waitId,
        input: { value: 48 },
      },
      {
        ...projectPolicy,
        projectId: newId("project"),
        projectName: "Different Project",
      },
    ),
    { code: "authorization_scope_mismatch" },
  );
  const completed = await f.finish(
    await f.invoke(
      "agent.run.input",
      {
        agentId: "agent_fixture",
        runId: waiting.run.runId,
        waitId: waiting.wait.waitId,
        input: { value: 48 },
        waitMs: 1000,
      },
      { allowedRoots: [f.project] },
    ),
  );
  assert.equal(completed.run.status, "succeeded", JSON.stringify(completed));
  assert.deepEqual(completed.result.data, { value: 48, project: projectId });
  await assert.rejects(
    f.invoke(
      "agent.run.cancel",
      { agentId: "agent_fixture", runId: cancelling.run.runId },
      { allowedRoots: [] },
    ),
    { code: "path_not_allowed" },
  );
  const stopped = await f.invoke(
    "agent.run.cancel",
    { agentId: "agent_fixture", runId: cancelling.run.runId },
    { allowedRoots: [f.project] },
  );
  assert.equal(stopped.accepted, true);
  assert.equal((await f.finish(stopped.view)).run.status, "cancelled");
});

test("the current Console owner controls the actual background sh resource after Project close and creator Grant revocation", async (t) => {
  const f = await fixture(t),
    projectId = newId("project");
  const policy = {
    projectId,
    projectRoot: f.project,
    projectName: "Process Project",
    allowedRoots: [f.project],
  };
  const opened = await f.open({ projectId }, policy),
    ready = path.join(f.project, "managed-child-ready");
  const launched = await f.finish(
    await f.invoke(
      "agent.run.start",
      {
        contextId: opened.contextId,
        script:
          "return await sh.start({command:context.input.node,args:['-e',context.input.code,context.input.ready],background:true,timeoutMs:60000});",
        input: {
          node: process.execPath,
          code: "require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);",
          ready,
        },
        waitMs: 1000,
      },
      policy,
    ),
  );
  assert.equal(launched.run.status, "succeeded", JSON.stringify(launched));
  const processId = launched.result.data.processId;
  assert.match(processId, /^res_[0-9a-f]{32}$/);
  const readyDeadline = Date.now() + 10000;
  while (!existsSync(ready) && Date.now() < readyDeadline) await delay(10);
  assert.equal(
    existsSync(ready),
    true,
    "the managed child must actually execute before inspection",
  );
  const sessionRef = hash(Buffer.from("console-process-owner"));
  const owner = {
    principalId: "owner",
    clientId: "nexum-console:" + sessionRef,
    source: "owner_session",
    sessionRef,
  };
  const closed = await f.invoke(
    "agent.project.close",
    { projectId },
    policy,
    owner,
  );
  assert.equal(closed.agentConfirmed, true);
  assert.equal(closed.affectedContextCount, 1);
  await assert.rejects(
    f.invoke(
      "agent.run.start",
      {
        contextId: opened.contextId,
        script: "throw new Error('closed work must not execute')",
      },
      policy,
    ),
    { code: "context_closed" },
  );
  await f.runtime.event(
    {
      type: "event",
      name: "agent.authorization.changed",
      connection: f.binding,
      data: { caller, authorization: null },
    },
    new AbortController().signal,
  );
  const page = await f.invoke(
    "agent.process.list",
    { projectId, limit: 20 },
    { allowedRoots: [f.project] },
    owner,
  );
  const item = page.items.find((value) => value.processId === processId);
  assert.ok(item, JSON.stringify(page));
  assert.equal(item.originRunId, launched.run.runId);
  assert.equal(item.projectId, projectId);
  assert.equal(item.lifetime, "background");
  assert.equal(item.closedAt, null);
  assert.equal(item.controlAvailable, true);
  assert.equal(item.details.cwd, f.project);
  assert.equal(item.details.args, undefined);
  assert.equal(item.details.env, undefined);
  assert.equal(
    (
      await f.invoke(
        "agent.process.get",
        { processId },
        { allowedRoots: [f.project] },
        owner,
      )
    ).details.closed,
    false,
  );
  await assert.rejects(
    f.invoke(
      "agent.process.stop",
      { processId },
      { ...policy, projectId: newId("project"), projectName: "Other Project" },
      owner,
    ),
    { code: "authorization_scope_mismatch" },
  );
  await assert.rejects(
    f.invoke("agent.process.stop", { processId }, { allowedRoots: [] }, owner),
    { code: "path_not_allowed" },
  );
  await assert.rejects(
    f.invoke(
      "agent.process.stop",
      { processId: String(item.details.pid) },
      { allowedRoots: [f.project] },
      owner,
    ),
    { code: "invalid_arguments" },
  );
  await assert.rejects(
    f.invoke(
      "agent.process.stop",
      { processId },
      { allowedRoots: [f.project] },
    ),
    { code: "invalid_arguments" },
  );
  const stopped = await f.invoke(
    "agent.process.stop",
    { processId },
    { allowedRoots: [f.project] },
    owner,
  );
  assert.equal(stopped.accepted, true);
  assert.ok(stopped.item.closedAt !== null, JSON.stringify(stopped));
  assert.equal(stopped.item.details.closed, true);
  assert.equal(stopped.item.details.treeStopped, true);
  assert.equal(stopped.item.controlAvailable, false);
  assert.equal(
    (
      await f.invoke(
        "agent.process.stop",
        { processId },
        { allowedRoots: [f.project] },
        owner,
      )
    ).accepted,
    false,
  );
  assert.equal(
    (
      await f.invoke(
        "agent.run.inspect",
        { runId: launched.run.runId },
        { allowedRoots: [f.project] },
        owner,
      )
    ).run.status,
    "succeeded",
  );
});

test("shutdown drains the final bounded native extension log writes and closes stale log admission", async (t) => {
  let entry;
  const f = await fixture(t, {
    runtime: {
      modulePolicy: {
        builtins: () => defaultBuiltins,
        approvedPackages: () => new Map([["dispose-log-fixture", "1.0.0"]]),
      },
    },
    prepare({ root, work, write }) {
      write(path.join(work, "package.json"), {
        type: "module",
        dependencies: { "dispose-log-fixture": "1.0.0" },
      });
      const dir = path.join(work, "node_modules/dispose-log-fixture");
      entry = path.join(dir, "extension.js");
      write(path.join(dir, "package.json"), {
        name: "dispose-log-fixture",
        version: "1.0.0",
        type: "module",
        exports: {
          "./nexum": { types: "./extension.d.ts", import: "./extension.js" },
        },
        nexum: {
          apiVersion: 1,
          namespace: "disposeLog",
          permissions: [],
          docs: "./docs",
        },
      });
      write(
        path.join(dir, "extension.d.ts"),
        "export default function createExtension(host:unknown):unknown;",
      );
      write(
        path.join(dir, "docs/README.md"),
        "# Native dispose logging fixture\n",
      );
      write(
        entry,
        "let retained;export function late(){retained.log({level:'info',message:'late-after-close'});}export default function(host){retained=host;return {methods:{},dispose(){for(let i=0;i<64;i++)host.log({level:'info',message:'actual-dispose-log',data:{index:i,padding:'x'.repeat(4096)}});}};}",
      );
      write(path.join(root, "state/maintenance/extensions.json"), {
        "dispose-log-fixture": {
          enabled: true,
          objectId: "extension_dispose_log",
          revision: "revision_dispose_log",
          config: {},
        },
      });
    },
  });
  const source = await import(pathToFileURL(entry).href);
  await f.runtime.close();
  const rows = readFileSync(path.join(f.root, "logs/extensions.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.message === "actual-dispose-log");
  assert.deepEqual(
    rows.map((row) => row.data.index),
    Array.from({ length: 64 }, (_, index) => index),
  );
  assert.throws(() => source.late(), { code: "log_closed" });
});

test("a control disconnect before transfer I/O admission releases the actual reservation instead of occupying a shared slot", async (t) => {
  const f = await configuredFixture(t);
  const created = await f.run(
    "return await transfer.createUpload({path:'claim-fixture.bin',expectedSize:1});",
  );
  assert.equal(created.run.status, "succeeded", JSON.stringify(created));
  const transferId = created.result.data.transferId;
  const reservation = await f.invoke("agent.transfer.reserveClaim", {
    transferId,
  });
  assert.equal(f.components.streams.active, 1);
  const stream = f.incoming(Buffer.from("x"), "transfer");
  f.disconnect();
  try {
    await assert.rejects(
      f.invoke("agent.transfer.commitClaim", {
        transferId,
        reservationId: reservation.reservationId,
        stream,
        contentLength: 1,
      }),
      { code: "connection_closed" },
    );
    assert.equal(
      f.components.streams.active,
      0,
      "the unused Core reservation must release immediately rather than waiting for its expiry",
    );
  } finally {
    await f.reconnect();
  }
  await assert.rejects(
    f.invoke("agent.transfer.releaseReservation", {
      transferId,
      reservationId: reservation.reservationId,
    }),
    { code: "invalid_transfer_reservation" },
  );
});

test("a current Project policy that removes the Run directory stops silent native I/O without waiting for another SDK call", async (t) => {
  const entered = Promise.withResolvers(),
    disconnected = Promise.withResolvers();
  const remote = createServer((request, response) => {
    request.on("close", () => disconnected.resolve());
    response.on("error", () => {});
    entered.resolve();
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        remote.closeAllConnections();
        remote.close(resolve);
      }),
  );
  const f = await configuredFixture(t),
    projectId = newId("project");
  const policy = {
    projectId,
    projectRoot: f.project,
    projectName: "Silent Project",
    allowedRoots: [f.project],
  };
  const handle = await f.components.registry.prepare(
    {
      apiVersion: 1,
      origin: {
        type: "extension",
        owner: "@test/root-removal",
        namespace: "rootRemoval",
        version: "1",
        revision: "1",
      },
      permissions: [],
    },
    () => ({
      methods: {
        hold: {
          description: "Await actual native HTTP",
          permissions: [],
          schemaDialect: "draft7",
          inputSchema: { type: "object", additionalProperties: false },
          async handle(_input, call) {
            return (
              await fetch(`http://127.0.0.1:${remote.address().port}`, {
                signal: call.signal,
              })
            ).status;
          },
        },
      },
    }),
  );
  f.components.registry.publish(handle);
  const opened = await f.open({ projectId }, policy);
  const run = await f.invoke(
    "agent.run.start",
    {
      contextId: opened.contextId,
      script: "return await rootRemoval.hold({});",
      waitMs: 0,
    },
    policy,
  );
  await entered.promise;
  await f.runtime.event(
    {
      type: "event",
      name: "agent.authorization.changed",
      connection: f.binding,
      data: {
        caller,
        authorization: f.authorization({ ...policy, allowedRoots: [] }),
      },
    },
    new AbortController().signal,
  );
  await disconnected.promise;
  const deadline = Date.now() + 10000;
  while (
    !f.components.store.getRun(run.run.runId).endedAt &&
    Date.now() < deadline
  )
    await delay(10);
  const stopped = f.components.store.getRun(run.run.runId);
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.stop.kind, "authorization");
  assert.equal(stopped.stop.code, "path_not_allowed");
  assert.equal(
    (await f.components.registry.disable(handle)).status,
    "disabled",
  );
});

test("the parsed owner profile policy reaches new Work, Run, artifact and managed-storage allocations", async (t) => {
  const retention = {
    work_idle_ms: 210000,
    run_history_ms: 240000,
    run_logs_ms: 180000,
    input_attachments_ms: 120000,
    artifact_ms: 150000,
    material_copies_ms: 300000,
  };
  const f = await configuredFixture(t, {
    config: { storage: { max_managed_bytes: 8 * 1024 * 1024 }, retention },
  });
  const opened = await f.open(),
    work = f.components.store.getWork(opened.contextId);
  assert.equal(work.expiresAt - work.lastUsedAt, retention.work_idle_ms);
  const run = await f.run(
    "const fs=await import('node:fs/promises');const p=await import('node:path');await fs.writeFile(p.join(context.pwd,'policy-artifact.txt'),'actual retained bytes');return output.file('policy-artifact.txt');",
    null,
    opened,
  );
  assert.equal(run.run.status, "succeeded", JSON.stringify(run));
  const record = f.components.store.getRun(run.run.runId);
  const stored = JSON.parse(
    readFileSync(path.join(f.root, record.resultRef), "utf8"),
  );
  const artifact = stored.content[0].resource;
  assert.equal(
    Date.parse(artifact.expiresAt) - Date.parse(artifact.createdAt),
    retention.artifact_ms,
  );
  await assert.rejects(f.components.reserve(8 * 1024 * 1024), {
    code: "storage_quota_exceeded",
  });
  await f.runtime.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(f.root, "state/runtime.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT retention_history_ms,retention_logs_ms,retention_inputs_ms FROM runs WHERE run_id=?",
      )
      .get(record.runId);
    assert.deepEqual(
      { ...row },
      {
        retention_history_ms: retention.run_history_ms,
        retention_logs_ms: retention.run_logs_ms,
        retention_inputs_ms: retention.input_attachments_ms,
      },
    );
  } finally {
    db.close();
  }
});
