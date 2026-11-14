import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  Server,
  SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
  inputRequired,
} from "@modelcontextprotocol/server";
import * as taskV1 from "@modelcontextprotocol/ext-tasks/core/v1";
import * as taskV2 from "@modelcontextprotocol/ext-tasks/core/v2";

// A separate output directory lets adapter work be checked without mutating
// another worker's dist. All runtime imports must share that module graph.
const adapterUrl = process.env.NEXUM_MCP_ADAPTER_TEST_MODULE
  ? new URL(
      process.env.NEXUM_MCP_ADAPTER_TEST_MODULE,
      pathToFileURL(`${process.cwd()}/`),
    )
  : new URL("../dist/adapters/mcp.js", import.meta.url);
const moduleRoot = new URL("../", adapterUrl);
const [
  { createMcpAdapter },
  { SqliteStore },
  { ModuleLoader },
  { ScriptCatalog },
  { RunEngine, callerKey },
  { ResourceManager },
  { ExtensionRegistry },
  { ArtifactStore },
  { ResultEncoder },
  { AgentError },
  { McpResultResources },
] = await Promise.all([
  import(adapterUrl.href),
  import(new URL("storage/sqlite.js", moduleRoot)),
  import(new URL("runtime/modules.js", moduleRoot)),
  import(new URL("runtime/scripts.js", moduleRoot)),
  import(new URL("runtime/engine.js", moduleRoot)),
  import(new URL("extensions/resources.js", moduleRoot)),
  import(new URL("extensions/registry.js", moduleRoot)),
  import(new URL("results/artifacts.js", moduleRoot)),
  import(new URL("results/encoder.js", moduleRoot)),
  import(new URL("contracts/errors.js", moduleRoot)),
  import(new URL("results/mcp.js", moduleRoot)),
]);

const caller = { principalId: "user", clientId: "client", host: "test-host" };
const capabilities = { tools: {}, resources: {}, prompts: {} };
const fixtureProtocolVersions = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];
const hostCapabilities = { sampling: {}, elicitation: { form: {} }, roots: {} };
const hostTool = {
  name: "host-roundtrip",
  description: "Exercise the original Host port",
  inputSchema: {
    type: "object",
    required: ["value"],
    additionalProperties: false,
    properties: { value: { type: "integer" } },
  },
};
const legacyHostTool = {
  name: "legacy-host",
  description: "An unassociated reverse stdio request must be rejected",
  inputSchema: {
    type: "object",
    required: ["kind"],
    additionalProperties: false,
    properties: { kind: { enum: ["sampling", "elicitation", "roots"] } },
  },
};
const taskTool = {
  name: "task-tool",
  description: "A real legacy Tasks execution",
  execution: { taskSupport: "required" },
  inputSchema: {
    type: "object",
    required: ["value"],
    additionalProperties: false,
    properties: {
      value: { type: "integer" },
      waitMs: { type: "integer", minimum: 1, maximum: 10000 },
    },
  },
};
const taskCapabilities = {
  tools: {},
  tasks: { requests: { tools: { call: {} } }, cancel: {}, list: {} },
};
const notifyTool = {
  name: "notify-resource",
  description: "Publish actual resource update notifications",
  inputSchema: {
    type: "object",
    required: ["uri"],
    additionalProperties: false,
    properties: {
      uri: { type: "string" },
      count: { type: "integer", minimum: 1, maximum: 300 },
    },
  },
};
const echoInput = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: {
    value: { type: "integer" },
    tuple: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false,
      minItems: 2,
    },
    waitMs: { type: "integer", minimum: 0, maximum: 5000 },
  },
};
const tools = [
  {
    name: "echo-value",
    description: "Echo exact SDK arguments",
    inputSchema: echoInput,
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["name", "received"],
      additionalProperties: false,
      properties: { name: { const: "echo-value" }, received: echoInput },
    },
  },
  {
    name: "draft-seven",
    description: "Exercise explicit JSON Schema draft-07",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { value: { type: "integer" }, tag: { type: "string" } },
      required: ["value"],
      dependencies: { value: ["tag"] },
      additionalProperties: false,
    },
    outputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { const: "draft-seven" },
        received: {
          type: "object",
          required: ["value", "tag"],
          additionalProperties: false,
          properties: { value: { type: "integer" }, tag: { type: "string" } },
        },
      },
      dependencies: { name: ["received"] },
    },
  },
  {
    name: "fail-tool",
    description: "A tool-level failure is still a valid MCP result",
    inputSchema: { type: "object", additionalProperties: false },
  },
];

// This function is also serialized into the stdio child. It deliberately uses
// the official low-level SDK, never a hand-written JSON-RPC implementation.
function installHandlers(server, options, record) {
  const tasks = new Map();
  if (options.taskFixture === "v1") {
    const get = (request) => {
      const task = tasks.get(request.params.taskId);
      if (!task) throw new Error("Unknown fixture task");
      return task;
    };
    server.setRequestHandler("tasks/get", (request) => {
      const item = get(request);
      record({
        method: "tasks/get",
        taskId: item.task.taskId,
        status: item.task.status,
      });
      return taskV1.GetTaskResultV1Schema.parse(item.task);
    });
    server.setRequestHandler("tasks/result", (request) => {
      const item = get(request);
      record({ method: "tasks/result", taskId: item.task.taskId });
      if (item.task.status !== "completed")
        throw new Error("Fixture task has not completed");
      return taskV1.CallToolResultV1Schema.parse({
        content: [{ type: "text", text: `task:${item.value}` }],
        structuredContent: { value: item.value, taskId: item.task.taskId },
      });
    });
    server.setRequestHandler("tasks/cancel", (request) => {
      const item = get(request);
      clearTimeout(item.timer);
      item.task.status = "cancelled";
      item.task.lastUpdatedAt = new Date().toISOString();
      record({
        method: "tasks/cancel",
        taskId: item.task.taskId,
        status: item.task.status,
      });
      return taskV1.CancelTaskResultV1Schema.parse(item.task);
    });
    server.setRequestHandler("tasks/list", () => ({
      tasks: [...tasks.values()].map((item) => item.task),
    }));
  }
  if (options.taskFixture === "v2") {
    const get = (params) => {
      const item = tasks.get(params.taskId);
      if (!item) throw new Error("Unknown fixture task");
      return item;
    };
    server.setRequestHandler(
      "tasks/get",
      { params: taskV2.GetTaskRequestV2Schema.shape.params },
      (params) => {
        const item = get(params);
        if (options.taskFlow === "input" && item.task.status === "working") {
          item.task.status = "input_required";
          item.task.inputRequests = {
            sample: inputRequired.createMessage({
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: `task-sample:${item.value}` },
                },
              ],
              maxTokens: 32,
            }),
          };
        }
        record({
          method: "tasks/get",
          taskId: item.task.taskId,
          status: item.task.status,
        });
        return taskV2.GetTaskResultV2Schema.parse({
          resultType: "complete",
          ...item.task,
        });
      },
    );
    // The SDK lifts inputResponses from every request into its public context.
    // Validate the remaining params first, then restore that documented field
    // before applying the complete official extension schema.
    server.setRequestHandler(
      "tasks/update",
      {
        params: taskV2.UpdateTaskRequestV2Schema.shape.params.omit({
          inputResponses: true,
        }),
      },
      (params, ctx) => {
        try {
          const inputResponses = taskV2.UpdateTaskRequestV2Schema.parse({
            jsonrpc: "2.0",
            id: ctx.mcpReq.id,
            method: "tasks/update",
            params: { ...params, inputResponses: ctx.mcpReq.inputResponses },
          }).params.inputResponses;
          const item = get(params);
          const sampling = taskV2.CreateMessageResultV2Schema.parse(
            inputResponses.sample,
          );
          delete item.task.inputRequests;
          item.task.status = "completed";
          item.task.lastUpdatedAt = new Date().toISOString();
          item.task.result = taskV2.CallToolResultV2Schema.parse({
            resultType: "complete",
            content: [{ type: "text", text: `v2-task:${item.value}` }],
            structuredContent: { value: item.value, sampling },
          });
          record({
            method: "tasks/update",
            taskId: item.task.taskId,
            responseKeys: Object.keys(inputResponses),
            sampling,
          });
          return taskV2.UpdateTaskResultV2Schema.parse({
            resultType: "complete",
          });
        } catch (cause) {
          record({
            method: "tasks/update-error",
            message: cause.message,
            responseKeys: Object.keys(ctx.mcpReq.inputResponses ?? {}),
          });
          throw cause;
        }
      },
    );
    server.setRequestHandler(
      "tasks/cancel",
      { params: taskV2.CancelTaskRequestV2Schema.shape.params },
      (params) => {
        const item = get(params);
        record({
          method: "tasks/cancel",
          taskId: item.task.taskId,
          status: item.task.status,
          acknowledged: true,
        });
        if (!options.taskCancelReleaseFile) {
          delete item.task.inputRequests;
          item.task.status = "cancelled";
          item.task.lastUpdatedAt = new Date().toISOString();
          record({ method: "task-cancelled", taskId: item.task.taskId });
          return taskV2.CancelTaskResultV2Schema.parse({
            resultType: "complete",
          });
        }
        const deadline = Date.now() + 30_000;
        const release = setInterval(() => {
          if (existsSync(options.taskCancelReleaseFile)) {
            clearInterval(release);
            item.task.status = "cancelled";
            item.task.lastUpdatedAt = new Date().toISOString();
            record({ method: "task-cancelled", taskId: item.task.taskId });
          } else if (Date.now() >= deadline) {
            clearInterval(release);
            process.exit(23);
          }
        }, 10);
        return taskV2.CancelTaskResultV2Schema.parse({
          resultType: "complete",
        });
      },
    );
  }
  const page = (request, items, key, label) => {
    record({
      method: label,
      cursor: request.params?.cursor ?? null,
      protocolVersion: server.getNegotiatedProtocolVersion() ?? null,
    });
    if (
      options.mode === "backpressure" &&
      label === "tools/list" &&
      request.params?.cursor === "second"
    ) {
      process.stdin.pause();
      record({ method: "stdin-paused" });
      const releaseDeadline = Date.now() + 30_000;
      const release = setInterval(() => {
        if (existsSync(options.stdinReleaseFile)) {
          clearInterval(release);
          record({ method: "stdin-resumed" });
          process.stdin.resume();
        } else if (Date.now() >= releaseDeadline) {
          clearInterval(release);
          record({ method: "stdin-release-timeout" });
          process.exit(23);
        }
      }, 10);
    }
    return request.params?.cursor === "second"
      ? { [key]: items.slice(1) }
      : { [key]: items.slice(0, 1), nextCursor: "second" };
  };
  if (options.capabilities.tools) {
    server.setRequestHandler("tools/list", (request) =>
      page(request, options.tools, "tools", "tools/list"),
    );
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const { name, arguments: input = {} } = request.params;
      record({
        method: "tools/call",
        name,
        input:
          typeof input.padding === "string"
            ? {
                ...input,
                padding: undefined,
                paddingBytes: Buffer.byteLength(input.padding),
              }
            : input,
      });
      if (name === "notify-resource") {
        for (let index = 0; index < (input.count ?? 1); index++)
          await server.sendResourceUpdated({ uri: input.uri });
        record({
          method: "resource-updated",
          uri: input.uri,
          count: input.count ?? 1,
        });
        return {
          content: [],
          structuredContent: { notified: input.count ?? 1 },
        };
      }
      if (name === "task-tool") {
        if (options.taskFixture === "v2") {
          const now = new Date().toISOString();
          const task = taskV2.TaskV2Schema.parse({
            taskId: `fixture-v2-${input.value}`,
            status: "working",
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: 60000,
            pollIntervalMs: 20,
          });
          tasks.set(task.taskId, { task, value: input.value });
          record({
            method: "task-created",
            taskId: task.taskId,
            status: task.status,
            generation: "v2",
          });
          if (options.taskCreationReleaseFile)
            await new Promise((resolve) => {
              const deadline = Date.now() + 30_000;
              const release = setInterval(() => {
                if (existsSync(options.taskCreationReleaseFile)) {
                  clearInterval(release);
                  record({
                    method: "task-creation-replied",
                    taskId: task.taskId,
                  });
                  resolve();
                } else if (Date.now() >= deadline) {
                  clearInterval(release);
                  process.exit(23);
                }
              }, 10);
            });
          return {
            content: [],
            ...taskV2.CreateTaskResultV2Schema.parse({
              resultType: "task",
              ...task,
            }),
          };
        }
        taskV1.CallToolAsTaskRequestV1Schema.parse({
          jsonrpc: "2.0",
          id: ctx.mcpReq.id,
          method: "tools/call",
          params: request.params,
        });
        const now = new Date().toISOString();
        const task = taskV1.TaskV1Schema.parse({
          taskId: `fixture-task-${input.value}`,
          status: "working",
          createdAt: now,
          lastUpdatedAt: now,
          ttl: 60000,
          pollInterval: 20,
        });
        const item = { task, value: input.value };
        item.timer = setTimeout(() => {
          task.status = "completed";
          task.lastUpdatedAt = new Date().toISOString();
          record({ method: "task-completed", taskId: task.taskId });
        }, input.waitMs ?? 80);
        tasks.set(task.taskId, item);
        record({
          method: "task-created",
          taskId: task.taskId,
          status: task.status,
          augmented: request.params.task !== undefined,
        });
        if (options.malformedTaskCreation) {
          const { createdAt, ...malformed } = task;
          return { content: [], task: malformed };
        }
        return {
          content: [],
          ...taskV1.CreateTaskResultV1Schema.parse({ task }),
        };
      }
      if (name === "host-roundtrip") {
        const responses = ctx.mcpReq.inputResponses;
        record({
          method: "host-roundtrip",
          value: input.value,
          wireId: ctx.mcpReq.id,
          requestState: ctx.mcpReq.requestState() ?? null,
          responseKeys: Object.keys(responses ?? {}),
        });
        if (!responses)
          return inputRequired({
            requestState: `opaque:${input.value}`,
            inputRequests: {
              sample: inputRequired.createMessage({
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text: `sample:${input.value}` },
                  },
                ],
                maxTokens: 32,
              }),
              question: inputRequired.elicit({
                message: `confirm:${input.value}`,
                requestedSchema: {
                  type: "object",
                  properties: { approved: { type: "boolean" } },
                  required: ["approved"],
                },
              }),
              roots: inputRequired.listRoots(),
            },
          });
        return {
          content: [{ type: "text", text: `host:${input.value}` }],
          structuredContent: {
            value: input.value,
            sampling: responses.sample,
            elicitation: responses.question,
            roots: responses.roots,
            requestState: ctx.mcpReq.requestState(),
          },
        };
      }
      if (name === "legacy-host") {
        const requestOptions = {
          relatedRequestId: ctx.mcpReq.id,
          signal: ctx.mcpReq.signal,
          timeout: 1000,
        };
        try {
          let response;
          if (input.kind === "sampling")
            response = await server.createMessage(
              {
                messages: [
                  {
                    role: "user",
                    content: {
                      type: "text",
                      text: "unassociated legacy sample",
                    },
                  },
                ],
                maxTokens: 32,
              },
              requestOptions,
            );
          else if (input.kind === "elicitation")
            response = await server.elicitInput(
              {
                message: "unassociated legacy question",
                requestedSchema: {
                  type: "object",
                  properties: { approved: { type: "boolean" } },
                  required: ["approved"],
                },
              },
              requestOptions,
            );
          else response = await server.listRoots({}, requestOptions);
          return {
            content: [],
            structuredContent: { kind: input.kind, rejected: false, response },
          };
        } catch (cause) {
          record({
            method: "legacy-host-rejected",
            kind: input.kind,
            code: cause.code ?? null,
          });
          return {
            content: [
              {
                type: "text",
                text: "Unassociated legacy Host request rejected.",
              },
            ],
            structuredContent: { kind: input.kind, rejected: true },
            isError: true,
          };
        }
      }
      if (input.waitMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, input.waitMs);
          ctx.mcpReq.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              record({ method: "cancelled", name, value: input.value });
              reject(ctx.mcpReq.signal.reason ?? new Error("Cancelled"));
            },
            { once: true },
          );
        });
      }
      if (name === "fail-tool")
        return {
          content: [{ type: "text", text: "fixture business failure" }],
          structuredContent: { reason: "fixture-only" },
          isError: true,
        };
      if (options.mode === "close-after-call")
        setTimeout(() => process.exit(0), 500);
      return {
        content: [{ type: "text", text: `${name}:${input.value}` }],
        structuredContent: { name, received: input },
        isError: false,
      };
    });
  }
  if (options.capabilities.resources) {
    if (options.capabilities.resources.subscribe) {
      server.setRequestHandler("resources/subscribe", (request) => {
        record({ method: "resources/subscribe", uri: request.params.uri });
        return {};
      });
      server.setRequestHandler("resources/unsubscribe", async (request) => {
        record({ method: "resources/unsubscribe", uri: request.params.uri });
        if (options.unsubscribeReleaseFile)
          await new Promise((resolve) => {
            const deadline = Date.now() + 30_000;
            const release = setInterval(() => {
              if (existsSync(options.unsubscribeReleaseFile)) {
                clearInterval(release);
                resolve();
              } else if (Date.now() >= deadline) {
                clearInterval(release);
                process.exit(23);
              }
            }, 10);
          });
        return {};
      });
    }
    const resources = [1, 2].map((number) => ({
      uri: `fixture://document/${number}`,
      name: `Document ${number}`,
      mimeType: "text/plain",
    }));
    const templates = [1, 2].map((number) => ({
      uriTemplate: `fixture://template-${number}/{id}`,
      name: `Template ${number}`,
    }));
    server.setRequestHandler("resources/list", (request) =>
      page(request, resources, "resources", "resources/list"),
    );
    server.setRequestHandler("resources/templates/list", (request) =>
      page(request, templates, "resourceTemplates", "resources/templates/list"),
    );
    server.setRequestHandler("resources/read", (request) => {
      record({ method: "resources/read", uri: request.params.uri });
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/plain",
            text: "fixture resource body",
          },
        ],
      };
    });
  }
  if (options.capabilities.prompts) {
    const prompts = [1, 2].map((number) => ({
      name: `prompt-${number}`,
      description: `Prompt ${number}`,
      arguments: [{ name: "topic", required: true }],
    }));
    server.setRequestHandler("prompts/list", (request) =>
      page(request, prompts, "prompts", "prompts/list"),
    );
    server.setRequestHandler("prompts/get", (request) => {
      record({ method: "prompts/get", name: request.params.name });
      return {
        description: "fixture prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Write about ${request.params.arguments?.topic}`,
            },
          },
        ],
      };
    });
  }
}

async function until(predicate, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
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
function events(filename) {
  return existsSync(filename)
    ? readFileSync(filename, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
}
function samplingResult(runId) {
  return {
    role: "assistant",
    model: "fixture-host-model",
    stopReason: "endTurn",
    content: { type: "text", text: runId },
  };
}
function hostRequestsFor(binding, seen, options = {}) {
  const current = () => {
    binding.assertCurrent();
    options.assertCurrent?.();
  };
  const record = (kind, params, requestOptions) => {
    current();
    const item = {
      kind,
      params,
      runId: binding.runId,
      caller: binding.context.caller,
      signal: requestOptions?.signal ?? binding.signal,
    };
    seen.push(item);
    return item;
  };
  return {
    capabilities: options.capabilities ?? hostCapabilities,
    assertCurrent: current,
    async sampling(params, requestOptions) {
      const item = record("sampling", params, requestOptions);
      return options.sampling
        ? options.sampling(item)
        : samplingResult(binding.runId);
    },
    async elicitation(params, requestOptions) {
      record("elicitation", params, requestOptions);
      return { action: "accept", content: { approved: true } };
    },
    async roots(requestOptions) {
      record("roots", undefined, requestOptions);
      return {
        roots: [
          { uri: pathToFileURL(options.workDir).href, name: binding.runId },
        ],
      };
    },
  };
}
async function fixture(t, options = {}) {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "nexum-mcp-adapter-")),
  );
  const workDir = path.join(root, "work");
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(workDir, "snapshot.json"), '{"project":null}');
  const store = new SqliteStore(root, {
    agentId: "agent",
    profile: "development",
    cloudEnvironment: "test",
  });
  const resources = new ResourceManager(store, { cleanupTimeoutMs: 1500 });
  const logs = [],
    policies = [],
    handles = [],
    runs = [],
    cleanups = [];
  const registry = new ExtensionRegistry(resources, {
    cleanupTimeoutMs: 1500,
    permissions: new Set(["mcp.use"]),
    authorize(policy) {
      policies.push(policy);
    },
    log(...args) {
      logs.push(args);
    },
    progress() {},
    ...(options.hostRequests ? { hostRequests: options.hostRequests } : {}),
  });
  const scripts = new ScriptCatalog(workDir, "agent", () => []);
  const loader = await ModuleLoader.create(workDir, store.bootId, {
    builtins: () => [],
    approvedPackages: () => new Map(),
  });
  const mcpResources = new McpResultResources({
    agentId: "agent",
    profileRoot: root,
    resolveResource: (source, scope) =>
      registry.resolveMcpResource(source, scope),
  });
  const encoder = new ResultEncoder(
    new ArtifactStore(root, "agent"),
    {},
    undefined,
    mcpResources,
  );
  const work = store.openWork({
    callerKey: callerKey(caller),
    pwd: workDir,
    snapshotRef: "work/snapshot.json",
  });
  const engine = new RunEngine(store, loader, scripts, {
    authorize() {},
    loadWork: (item) =>
      JSON.parse(readFileSync(path.join(root, item.snapshotRef), "utf8")),
    encodeResult: (value, services) =>
      encoder.encode(value, {
        pwd: workDir,
        ownerKey: callerKey(caller),
        grantId: "fixture-grant",
        runId: services.runId,
        signal: services.signal,
        assertCurrent: () => services.assertCurrent(),
        authorize() {},
        authorizeTarget(target) {
          policies.push({ action: "encode-result", target });
        },
      }),
    bindings: (services) => registry.bindings(services),
    resources,
    leaseScript: (origin) =>
      origin.type === "local" ? () => {} : registry.lease(origin),
  });
  t.after(async () => {
    for (const runId of runs) {
      if (store.getRun(runId).endedAt === null) {
        engine.cancel(caller, runId);
        await engine.observe(caller, runId, 1000).catch(() => {});
      }
    }
    for (const handle of handles) {
      try {
        await registry.disable(handle);
      } catch {}
    }
    for (const cleanup of cleanups) await cleanup();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workDir,
    store,
    registry,
    engine,
    logs,
    policies,
    handles,
    cleanups,
    async prepare(config, options, transformHost = (host) => host) {
      const adapter = createMcpAdapter(config, options);
      const origin = {
        type: "platform",
        owner: "@test/mcp",
        namespace: "mcp",
        version: "1",
        revision: `fixture-${config.name}`,
      };
      const source = {
        apiVersion: 1,
        origin,
        permissions: adapter.permissions,
        bindingPath: adapter.bindingPath,
      };
      const handle = await registry.prepare(source, (host) =>
        adapter.factory(transformHost(host)),
      );
      handles.push(handle);
      return { adapter, handle, source };
    },
    async start(script, options = {}) {
      const result = await engine.start(caller, {
        contextId: work.contextId,
        script,
        waitMs: 3000,
        ...options,
      });
      runs.push(result.run.runId);
      return result;
    },
    finish: (runId) => engine.observe(caller, runId, 4000),
    render(view) {
      return encoder.render(
        view.result,
        {
          pwd: workDir,
          ownerKey: callerKey(caller),
          grantId: "fixture-grant",
          runId: view.run.runId,
          assertCurrent() {},
          authorize() {},
          authorizeTarget(target) {
            policies.push({ action: "render-result", target });
          },
        },
        view.run,
        { textFallback: false },
      );
    },
    history() {
      return store
        .scanResourceHistory(
          {
            owner: "@test/mcp",
            namespace: "mcp",
            type: "platform",
          },
          callerKey(caller),
        )
        .items.map((item) => item.record);
    },
  };
}
function stdioFixture(t, f, options = {}) {
  const filename = path.join(f.root, `mcp-${options.name ?? "fixture"}.mjs`);
  const trace = `${filename}.events`;
  const childOptions = {
    capabilities,
    tools,
    protocolVersions: fixtureProtocolVersions,
    ...options,
  };
  writeFileSync(
    filename,
    `
import { appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Server, ProtocolError, METHOD_NOT_FOUND, inputRequired } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};
import { StdioServerTransport, serveStdio } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};
import * as taskV1 from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/ext-tasks/core/v1"))};
import * as taskV2 from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/ext-tasks/core/v2"))};
const options = ${JSON.stringify(childOptions)};
const record = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ at: Date.now(), ...value }) + "\\n");
record({ method: "spawn", pid: process.pid });
process.on("exit", () => record({ method: "exit" }));
if (options.mode === "idle") {
  process.stdin.resume();
} else if (options.mode === "exit") {
  process.exit(23);
} else if (options.mode === "root-exit-with-child") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send({ready:true}); process.disconnect();"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.once("message", (message) => {
    if (!message.ready) throw new Error("The descendant must report its actual native readiness.");
    record({ method: "child-pid", pid: child.pid });
    const release = setInterval(() => {
      if (!existsSync(options.rootReleaseFile)) return;
      clearInterval(release);
      process.exit(23);
    }, 10);
  });
} else {
  const transport = new StdioServerTransport();
  serveStdio(() => {
    const server = new Server({ name: "Nexum local MCP fixture", version: "1.0.0" }, { capabilities: options.capabilities, supportedProtocolVersions: options.protocolVersions });
    (${installHandlers.toString()})(server, options, record);
    if (options.legacyOnly) {
      const connect = server.connect.bind(server);
      server.connect = async (channel) => {
        server.setRequestHandler("server/discover", () => {
          record({ method: "server/discover", fallback: true });
          throw new ProtocolError(METHOD_NOT_FOUND, "The legacy fixture does not implement discovery.");
        });
        return connect(channel);
      };
    }
    return server;
  }, { transport });
  const receive = transport.onmessage;
  transport.onmessage = (message, ...extra) => {
    record({ method: "incoming", name: message.method, id: message.id ?? null, requestId: message.params?.requestId ?? null });
    return receive?.(message, ...extra);
  };
}
`,
  );
  f.cleanups.push(() => {
    for (const event of events(trace).filter((event) =>
      ["spawn", "child-pid"].includes(event.method),
    ))
      if (event.pid && alive(event.pid)) process.kill(event.pid, "SIGKILL");
  });
  return {
    config: {
      name: options.name ?? "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [filename],
      cwd: f.workDir,
    },
    events: () => events(trace),
    pid: () => events(trace).find((event) => event.method === "spawn")?.pid,
  };
}
// These two tests target process cleanup after an initialized native launch,
// not the developer's login plugins. Keep a real bounded environment probe but
// give it a fixture-owned OS shell entry; environment.test covers the real user.
function controlledProbeShell(t, f) {
  if (process.platform === "win32") return;
  const shell = path.join(f.root, "sh");
  writeFileSync(
    shell,
    '#!/bin/sh\n[ "$#" -eq 4 ] && [ "$1" = "-i" ] && [ "$2" = "-l" ] && [ "$3" = "-c" ] || exit 64\nexec /bin/sh -c "$4"\n',
    { mode: 0o700 },
  );
  const original = os.userInfo;
  os.userInfo = (...args) => ({ ...original(...args), shell });
  syncBuiltinESMExports();
  t.after(() => {
    os.userInfo = original;
    syncBuiltinESMExports();
  });
}
async function httpFixture(t, options = {}) {
  const seen = [];
  const server = new Server(
    { name: "Nexum HTTP fixture", version: "1.0.0" },
    { capabilities, supportedProtocolVersions: fixtureProtocolVersions },
  );
  installHandlers(server, { capabilities, tools, ...options }, (event) =>
    seen.push(event),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => "fixture-session",
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const http = createServer(async (request, response) => {
    seen.push({
      method: "http",
      verb: request.method,
      authorization: request.headers.authorization,
    });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const webRequest = new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(body.length ? { body, duplex: "half" } : {}),
      });
      const result = await transport.handleRequest(webRequest);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body).pipe(response);
      else response.end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, seen };
}

test("MCP configuration rejects unsupported fields and transports before connecting", async () => {
  const valid = {
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
  };
  for (const config of [
    { ...valid, shell: true },
    { ...valid, transport: "sse" },
    { ...valid, command: "" },
    { ...valid, env: { TOKEN: 7 } },
    { ...valid, args: [7] },
    { ...valid, name: "a".repeat(129) },
    { ...valid, name: "fixture/other" },
    { ...valid, name: "fixture.other" },
    { name: "fixture", transport: "streamable-http", url: "not a URL" },
    {
      name: "fixture",
      transport: "streamable-http",
      url: "http://127.0.0.1",
      oauth: {},
    },
  ])
    assert.throws(() => createMcpAdapter(config));
  for (const name of ["$fixture", "_fixture", "a".repeat(128)])
    assert.doesNotThrow(() => createMcpAdapter({ ...valid, name }));
  assert.throws(() => createMcpAdapter(valid, { requestTimeoutMs: -1 }));
  assert.throws(() => createMcpAdapter(valid, { unknown: true }));
});

test("real stdio SDK tools retain hyphenated names, schema dialects and standard result semantics", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  assert.deepEqual(
    adapter.catalog().tools.map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
  assert.equal(
    adapter.catalog().protocolVersion,
    peer.events().find((event) => event.method === "tools/list")
      .protocolVersion,
  );
  assert.ok(
    fixtureProtocolVersions.includes(adapter.catalog().protocolVersion),
  );
  assert.match(
    adapter.catalog().protocolVersion,
    /^2026-/,
    JSON.stringify(peer.events()),
  );
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 7, tuple: ["first", 2] });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.deepEqual((await f.render(result)).content, [
    { type: "text", text: "echo-value:7" },
  ]);
  assert.deepEqual(result.result.data, {
    name: "echo-value",
    received: { value: 7, tuple: ["first", 2] },
  });
  const invalid = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 7, tuple: [2, "wrong"] });',
  );
  assert.equal(invalid.run.status, "failed");
  const missingDependency = await f.start(
    'return await mcp.fixture.tools["draft-seven"]({ value: 9 });',
  );
  assert.equal(missingDependency.run.status, "failed");
  const draft7 = await f.start(
    'return await mcp.fixture.tools["draft-seven"]({ value: 9, tag: "ok" });',
  );
  assert.equal(draft7.run.status, "succeeded", JSON.stringify(draft7));
  const mutated = await f.start(
    'const args = { value: 71 }; const pending = mcp.fixture.tools["echo-value"](args); args.value = "after"; return await pending;',
  );
  assert.equal(mutated.run.status, "succeeded", JSON.stringify(mutated));
  assert.equal(mutated.result.data.received.value, 71);
  const failure = await f.start(
    'return await mcp.fixture.tools["fail-tool"]({});',
  );
  assert.equal(failure.run.status, "succeeded", JSON.stringify(failure));
  assert.equal(failure.result.isError, true);
  assert.deepEqual(failure.result.data, { reason: "fixture-only" });
  assert.equal(failure.result.content[0].text, "fixture business failure");
  assert.deepEqual(
    peer
      .events()
      .filter((event) => event.method === "tools/call")
      .map((event) => event.name),
    ["echo-value", "draft-seven", "echo-value", "fail-tool"],
  );
  assert.equal(f.store.operationsForRun(result.run.runId).length, 1);
});

test("two real runs share one connection and cancelling one request leaves the other usable", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const first = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 1, waitMs: 3000 });',
    { waitMs: 0 },
  );
  const second = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 2, waitMs: 250 });',
    { waitMs: 0 },
  );
  await until(
    () =>
      peer.events().filter((event) => event.method === "tools/call").length ===
      2,
    "Both requests should reach the same MCP process",
  );
  f.engine.cancel(caller, first.run.runId);
  const cancelled = await f.finish(first.run.runId),
    completed = await f.finish(second.run.runId);
  assert.equal(cancelled.run.status, "cancelled");
  await until(
    () =>
      peer
        .events()
        .some((event) => event.method === "cancelled" && event.value === 1),
    "Run cancellation must reach the SDK request's abort signal",
  );
  assert.equal(completed.run.status, "succeeded", JSON.stringify(completed));
  assert.equal(completed.result.data.received.value, 2);
  assert.equal(
    peer.events().filter((event) => event.method === "spawn").length,
    1,
  );
  assert.equal(alive(peer.pid()), true);
  const third = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 3 });',
  );
  assert.equal(third.run.status, "succeeded", JSON.stringify(third));
  assert.ok(f.history().length > 0);
  assert.ok(
    f
      .history()
      .every(
        (resource) =>
          resource.lifetime === "instance" && resource.status === "registered",
      ),
  );
  assert.ok(
    f
      .history()
      .some(
        (resource) =>
          resource.createdAt <=
          peer.events().find((event) => event.method === "spawn").at,
      ),
  );
  const report = await f.registry.disable(handle);
  assert.equal(report.status, "disabled", JSON.stringify(report));
  await until(
    () => !alive(peer.pid()),
    "Disabling must await actual child-process exit",
  );
  assert.ok(
    f
      .history()
      .every(
        (resource) =>
          resource.status === "closed" && resource.closedAt !== null,
      ),
  );
});

test("resource and prompt capabilities follow every catalog page and preserve standard response bodies", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const catalog = adapter.catalog();
  assert.equal(catalog.resources.length, 2);
  assert.equal(catalog.resourceTemplates.length, 2);
  assert.equal(catalog.prompts.length, 2);
  for (const method of [
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "prompts/list",
  ])
    assert.deepEqual(
      peer
        .events()
        .filter((event) => event.method === method)
        .map((event) => event.cursor),
      [null, "second"],
    );
  const read = await f.start(
    'return await mcp.fixture.resources.read({ uri: "fixture://document/2" });',
  );
  assert.equal(read.run.status, "succeeded", JSON.stringify(read));
  const deliveredRead = await f.render(read);
  assert.equal(deliveredRead.content[0].type, "resource");
  assert.equal(deliveredRead.content[0].resource.text, "fixture resource body");
  assert.match(deliveredRead.content[0].resource.mimeType, /^text\/plain/);
  const prompt = await f.start(
    'return await mcp.fixture.prompts.get({ name: "prompt-2", arguments: { topic: "local-first" } });',
  );
  assert.equal(prompt.run.status, "succeeded", JSON.stringify(prompt));
  assert.deepEqual(prompt.result.data, {
    description: "fixture prompt",
    messages: [{ role: "user", contentIndex: 0 }],
  });
  assert.deepEqual((await f.render(prompt)).content, [
    { type: "text", text: "Write about local-first" },
  ]);
  const list = await f.start(
    'return await mcp.fixture.resources.list({ cursor: "second" });',
  );
  assert.equal(list.run.status, "succeeded", JSON.stringify(list));
  assert.equal(list.result.data.resources[0].uri, "fixture://document/2");
});

test("a server without resource or prompt capabilities does not gain synthetic entry points", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { capabilities: { tools: {} } });
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const result = await f.start(
    'return { resources: typeof mcp.fixture.resources, prompts: typeof mcp.fixture.prompts, tools: typeof mcp.fixture.tools["echo-value"] };',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.result.data, {
    resources: "undefined",
    prompts: "undefined",
    tools: "function",
  });
  assert.deepEqual(adapter.catalog().resources, []);
  assert.deepEqual(adapter.catalog().prompts, []);
  assert.equal(
    peer.events().some((event) => /^(resources|prompts)\//.test(event.method)),
    false,
  );
});

test("real Streamable HTTP uses configured static headers without publishing credentials", async (t) => {
  const f = await fixture(t),
    peer = await httpFixture(t);
  const secret = "Bearer fixture-private-token";
  const { adapter, handle } = await f.prepare({
    name: "fixture",
    transport: "streamable-http",
    url: peer.url,
    headers: { Authorization: secret },
  });
  f.registry.publish(handle);
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 31 });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.received.value, 31);
  assert.ok(peer.seen.filter((event) => event.method === "http").length >= 3);
  assert.ok(
    peer.seen
      .filter((event) => event.method === "http")
      .every((event) => event.authorization === secret),
  );
  const published = JSON.stringify({
    catalog: adapter.catalog(),
    methods: handle.methods,
    logs: f.logs,
    history: f.history(),
  });
  assert.equal(published.includes(secret), false);
  assert.equal(published.includes("fixture-private-token"), false);
  assert.equal(published.includes("Authorization"), false);
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.ok(f.history().every((resource) => resource.status === "closed"));
});

test("failed stdio initialization closes registered resources and waits for actual process exit", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { mode: "idle" });
  await assert.rejects(f.prepare(peer.config, { connectTimeoutMs: 2500 }));
  const pid = await until(
    () => peer.pid(),
    "The local failure fixture must actually start",
  );
  await until(
    () => !alive(pid),
    "Initialization failure must close the real child",
  );
  const history = f.history();
  assert.ok(
    history.length > 0,
    "The transport must be registered before it can fail",
  );
  assert.ok(
    history.every(
      (resource) => resource.status === "closed" && resource.closedAt !== null,
    ),
    JSON.stringify(history),
  );
  assert.equal(Object.hasOwn(f.registry.bindings({}), "mcp"), false);
});

test("catalog budget failure cleans up the peer and never publishes a partial capability surface", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  await assert.rejects(f.prepare(peer.config, { maxCatalogItems: 1 }));
  const pid = await until(
    () => peer.pid(),
    "The budget fixture must actually start",
  );
  await until(() => !alive(pid), "Catalog failure must close its MCP process");
  assert.ok(f.history().length > 0);
  assert.ok(f.history().every((resource) => resource.status === "closed"));
  assert.equal(Object.hasOwn(f.registry.bindings({}), "mcp"), false);
});

test("a request timeout fails its operation while the shared SDK connection remains usable", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f);
  const { handle } = await f.prepare(peer.config, { requestTimeoutMs: 200 });
  f.registry.publish(handle);
  const timedOut = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 41, waitMs: 500 });',
  );
  assert.equal(timedOut.run.status, "failed", JSON.stringify(timedOut));
  assert.equal(
    f.store.operationsForRun(timedOut.run.runId)[0].status,
    "failed",
  );
  assert.equal(alive(peer.pid()), true);
  const next = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 42 });',
  );
  assert.equal(next.run.status, "succeeded", JSON.stringify(next));
  assert.equal(next.result.data.received.value, 42);
  assert.equal(
    peer.events().filter((event) => event.method === "spawn").length,
    1,
  );
});

test(
  "stdio initialization failure reaps a surviving process group after its root exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    controlledProbeShell(t, f);
    const rootReleaseFile = path.join(f.root, "release-root-exit");
    const peer = stdioFixture(t, f, {
      mode: "root-exit-with-child",
      rootReleaseFile,
    });
    const registered = [];
    const preparing = f.prepare(
      peer.config,
      { connectTimeoutMs: 30000 },
      (host) => ({
        ...host,
        resources: {
          ...host.resources,
          async register(input) {
            const ref = await host.resources.register(input);
            registered.push(input.value);
            return ref;
          },
        },
      }),
    );
    // Attach the rejection observer before waiting for either native process.
    const rejected = assert.rejects(preparing);
    let child;
    try {
      child = await until(
        () => peer.events().find((event) => event.method === "child-pid")?.pid,
        "The real fixture must start a ready descendant that inherits stdout",
        15000,
      );
      assert.equal(alive(peer.pid()), true);
      assert.equal(alive(child), true);
      writeFileSync(rootReleaseFile, "release");
      await until(() => !alive(peer.pid()), "The MCP root process must exit");
      assert.equal(alive(child), true);
      assert.equal(registered.length, 1);
    } finally {
      writeFileSync(rootReleaseFile, "release");
      // An exited root whose descendant still owns stdout does not prove the
      // transport closed. Stop its real registered initialization resource;
      // the 30s connect deadline remains only a watchdog for missing readiness.
      await Promise.all(
        registered.map((resource) =>
          resource.dispose(
            new AgentError(
              "fixture_initialization_stopped",
              "Stop the real initialization after its root exited.",
            ),
          ),
        ),
      );
      await rejected;
    }
    await until(() => !alive(peer.pid()), "The MCP root process must exit");
    await until(
      () => !alive(child),
      "Resource closure must stop the surviving descendant",
    );
    assert.ok(f.history().length > 0);
    assert.ok(
      f
        .history()
        .every(
          (resource) =>
            resource.status === "closed" && resource.closedAt !== null,
        ),
      JSON.stringify(f.history()),
    );
    assert.equal(Object.hasOwn(f.registry.bindings({}), "mcp"), false);
  },
);

test("naturally closed stdio connections can be disabled repeatedly without reporting an already closed resource", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { mode: "close-after-call" });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 51 });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  await until(
    () => !alive(peer.pid()),
    "The fixture should close its own stdio connection",
  );
  await until(
    () =>
      f.history().length > 0 &&
      f.history().every((resource) => resource.status === "closed"),
    "Resource history must observe natural physical closure",
  );
  assert.equal((await f.registry.disable(handle)).status, "disabled");
  assert.equal((await f.registry.disable(handle)).status, "disabled");
});

test("external run cancellation waits for real stdio backpressure and a cancelled queued call is never sent later", async (t) => {
  const f = await fixture(t);
  const paddedTools = tools.map((tool) =>
    tool.name === "echo-value"
      ? {
          ...tool,
          inputSchema: {
            ...echoInput,
            properties: {
              ...echoInput.properties,
              padding: { type: "string", maxLength: 2 * 1024 * 1024 },
            },
          },
        }
      : tool,
  );
  const stdinReleaseFile = path.join(f.root, "mcp-backpressure-release");
  const peer = stdioFixture(t, f, {
    mode: "backpressure",
    stdinReleaseFile,
    capabilities: { tools: {} },
    tools: paddedTools,
  });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  let first, second;
  try {
    await until(
      () => peer.events().some((event) => event.method === "stdin-paused"),
      "The real MCP fixture must pause stdin",
    );
    first = await f.start(
      'return await mcp.fixture.tools["echo-value"]({ value: 61, waitMs: 3000, padding: "x".repeat(1024 * 1024) });',
      { waitMs: 0 },
    );
    await until(
      () =>
        f.store
          .operationsForRun(first.run.runId)
          .some((operation) => operation.status === "running"),
      "The first operation must enter its pipe write",
    );
    second = await f.start(
      'return await mcp.fixture.tools["echo-value"]({ value: 62 });',
      { waitMs: 0 },
    );
    await until(
      () =>
        f.store
          .operationsForRun(second.run.runId)
          .some((operation) => operation.status === "running"),
      "The second operation must join the transport queue",
    );
    f.engine.cancel(caller, second.run.runId);
    f.engine.cancel(caller, first.run.runId);
    assert.equal(
      peer.events().some((event) => event.method === "stdin-resumed"),
      false,
      "Cancellation should happen during actual backpressure",
    );
    const stopping = await f.engine.observe(caller, first.run.runId, 0);
    assert.equal(stopping.run.status, "cancelling", JSON.stringify(stopping));
  } finally {
    writeFileSync(stdinReleaseFile, "release");
  }
  const cancelledFirst = await f.finish(first.run.runId),
    cancelledSecond = await f.finish(second.run.runId);
  assert.equal(cancelledFirst.run.status, "cancelled");
  assert.equal(cancelledSecond.run.status, "cancelled");
  assert.equal(
    peer.events().some((event) => event.method === "stdin-resumed"),
    true,
  );
  await until(
    () =>
      peer
        .events()
        .some((event) => event.method === "cancelled" && event.value === 61),
    "The first frame and its cancellation must actually reach the SDK",
  );
  assert.equal(
    peer
      .events()
      .some(
        (event) => event.method === "tools/call" && event.input.value === 62,
      ),
    false,
  );
  assert.equal(
    peer
      .events()
      .find(
        (event) => event.method === "tools/call" && event.input.value === 61,
      )?.input.paddingBytes,
    1024 * 1024,
  );
  const next = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 63 });',
  );
  assert.equal(next.run.status, "succeeded", JSON.stringify(next));
  assert.equal(next.result.data.received.value, 63);
});

test("resource reporting failure cannot escape a native event or prevent actual stdio process cleanup", async (t) => {
  const f = await fixture(t);
  controlledProbeShell(t, f);
  const peer = stdioFixture(t, f);
  let rejectReports = false,
    failures = 0;
  const registered = [];
  const { handle } = await f.prepare(peer.config, undefined, (host) => ({
    ...host,
    resources: {
      ...host.resources,
      async register(input) {
        const ref = await host.resources.register(input);
        registered.push(input.value);
        return Object.freeze({
          ...ref,
          report(details) {
            if (rejectReports) {
              failures++;
              throw new AgentError(
                "fixture_report_failed",
                "Controlled resource reporting failure.",
              );
            }
            ref.report(details);
          },
        });
      },
    },
  }));
  f.registry.publish(handle);
  assert.equal(alive(peer.pid()), true);
  rejectReports = true;
  await f.registry.disable(handle).catch(() => {});
  assert.ok(
    failures > 0,
    "The real backend event path must encounter the controlled report failure",
  );
  await until(
    () => !alive(peer.pid()),
    "Reporting failure must not prevent native process termination",
  );
  await Promise.all(registered.map((resource) => resource.closed));
  await until(
    () =>
      f.history().length > 0 &&
      f.history().every((resource) => resource.status === "closed"),
    "The store must retain actual closed-resource evidence despite report failure",
  );
});

test("auto negotiation falls back to a real legacy initialize handshake after official MethodNotFound discovery", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, { legacyOnly: true });
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  assert.equal(
    peer
      .events()
      .some((event) => event.method === "server/discover" && event.fallback),
    true,
    JSON.stringify(peer.events()),
  );
  assert.match(adapter.catalog().protocolVersion, /^2025-/);
  assert.equal(
    adapter.catalog().protocolVersion,
    peer.events().find((event) => event.method === "tools/list")
      .protocolVersion,
  );
  const result = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 81 });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.received.value, 81);
});

test("modern MRTR dispatches sampling, elicitation and roots to the original Host of each concurrent run", async (t) => {
  const seen = [];
  let f;
  f = await fixture(t, {
    hostRequests: (binding) =>
      hostRequestsFor(binding, seen, { workDir: f.workDir }),
  });
  const peer = stdioFixture(t, f, {
    capabilities: { tools: {} },
    tools: [hostTool],
  });
  const { handle } = await f.prepare(peer.config, { hostCapabilities });
  f.registry.publish(handle);
  const first = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 91 });',
    { waitMs: 0 },
  );
  const second = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 92 });',
    { waitMs: 0 },
  );
  const completed = await Promise.all([
    f.finish(first.run.runId),
    f.finish(second.run.runId),
  ]);
  for (const [index, result] of completed.entries()) {
    assert.equal(result.run.status, "succeeded", JSON.stringify(result));
    assert.equal(result.wait, null);
    assert.equal(result.result.data.value, 91 + index);
    assert.equal(result.result.data.sampling.model, "fixture-host-model");
    assert.equal(result.result.data.sampling.content.text, result.run.runId);
    assert.deepEqual(result.result.data.elicitation, {
      action: "accept",
      content: { approved: true },
    });
    assert.equal(result.result.data.roots.roots[0].name, result.run.runId);
    assert.equal(
      result.result.data.roots.roots[0].uri,
      pathToFileURL(f.workDir).href,
    );
    assert.equal(result.result.data.requestState, `opaque:${91 + index}`);
    const owned = seen.filter((item) => item.runId === result.run.runId);
    assert.deepEqual(owned.map((item) => item.kind).sort(), [
      "elicitation",
      "roots",
      "sampling",
    ]);
    for (const item of owned) assert.deepEqual(item.caller, caller);
    assert.equal(
      owned.find((item) => item.kind === "sampling").params.messages[0].content
        .text,
      `sample:${91 + index}`,
    );
  }
  for (const value of [91, 92]) {
    const rounds = peer
      .events()
      .filter(
        (event) => event.method === "host-roundtrip" && event.value === value,
      );
    assert.equal(rounds.length, 2);
    assert.notEqual(rounds[0].wireId, rounds[1].wireId);
    assert.deepEqual(rounds[1].responseKeys.sort(), [
      "question",
      "roots",
      "sample",
    ]);
  }
});

test("cancelling one modern input-required round aborts its actual Host sampling without borrowing another run", async (t) => {
  const seen = [];
  let f;
  f = await fixture(t, {
    hostRequests: (binding) =>
      hostRequestsFor(binding, seen, {
        workDir: f.workDir,
        sampling(item) {
          if (item.params.messages[0].content.text !== "sample:101")
            return samplingResult(item.runId);
          return new Promise((_, reject) =>
            item.signal.addEventListener(
              "abort",
              () => {
                seen.push({ kind: "sampling-aborted", runId: item.runId });
                reject(item.signal.reason);
              },
              { once: true },
            ),
          );
        },
      }),
  });
  const peer = stdioFixture(t, f, {
    capabilities: { tools: {} },
    tools: [hostTool],
  });
  const { handle } = await f.prepare(peer.config, { hostCapabilities });
  f.registry.publish(handle);
  const first = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 101 });',
    { waitMs: 0 },
  );
  await until(
    () =>
      seen.some(
        (item) => item.kind === "sampling" && item.runId === first.run.runId,
      ),
    "The actual Host sampling must start before cancelling its run",
  );
  const second = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 102 });',
    { waitMs: 0 },
  );
  f.engine.cancel(caller, first.run.runId);
  const cancelled = await f.finish(first.run.runId),
    completed = await f.finish(second.run.runId);
  assert.equal(cancelled.run.status, "cancelled", JSON.stringify(cancelled));
  assert.equal(completed.run.status, "succeeded", JSON.stringify(completed));
  assert.equal(completed.result.data.sampling.content.text, second.run.runId);
  assert.equal(
    seen.some(
      (item) =>
        item.kind === "sampling-aborted" && item.runId === first.run.runId,
    ),
    true,
  );
  assert.equal(
    seen.some(
      (item) =>
        item.kind === "sampling-aborted" && item.runId === second.run.runId,
    ),
    false,
  );
  assert.equal(alive(peer.pid()), true);
});

test("Host bridge uses the actual per-call capability intersection and rechecks authority after Host work", async (t) => {
  const seen = [];
  let f,
    actualCapabilities = {},
    allowed = true,
    revokeOnSample = false;
  f = await fixture(t, {
    hostRequests: (binding) =>
      hostRequestsFor(binding, seen, {
        workDir: f.workDir,
        capabilities: actualCapabilities,
        assertCurrent() {
          if (!allowed)
            throw new AgentError(
              "forbidden",
              "The fixture Host authority was revoked.",
            );
        },
        sampling(item) {
          if (revokeOnSample) allowed = false;
          return samplingResult(item.runId);
        },
      }),
  });
  const peer = stdioFixture(t, f, {
    capabilities: { tools: {} },
    tools: [hostTool],
  });
  const { handle } = await f.prepare(peer.config, { hostCapabilities });
  f.registry.publish(handle);
  const unavailable = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 111 });',
  );
  assert.equal(unavailable.run.status, "failed", JSON.stringify(unavailable));
  assert.equal(seen.length, 0);
  actualCapabilities = { sampling: {}, elicitation: { url: {} }, roots: {} };
  const incompatibleMode = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 114 });',
  );
  assert.equal(
    incompatibleMode.run.status,
    "failed",
    JSON.stringify(incompatibleMode),
  );
  assert.equal(
    seen.length,
    0,
    "A URL-only Host must not receive the statically declared form request",
  );
  actualCapabilities = hostCapabilities;
  revokeOnSample = true;
  const revoked = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 112 });',
  );
  assert.equal(revoked.run.status, "failed", JSON.stringify(revoked));
  assert.equal(revoked.result, null);
  assert.equal(
    seen.some(
      (item) => item.kind === "sampling" && item.runId === revoked.run.runId,
    ),
    true,
  );
  allowed = true;
  revokeOnSample = false;
  const restored = await f.start(
    'return await mcp.fixture.tools["host-roundtrip"]({ value: 113 });',
  );
  assert.equal(restored.run.status, "succeeded", JSON.stringify(restored));
  assert.equal(restored.result.data.sampling.content.text, restored.run.runId);
});

test("legacy reverse requests without stdio wire association cannot borrow the active Host invocation", async (t) => {
  const seen = [];
  let f;
  f = await fixture(t, {
    hostRequests: (binding) =>
      hostRequestsFor(binding, seen, { workDir: f.workDir }),
  });
  const peer = stdioFixture(t, f, {
    legacyOnly: true,
    capabilities: { tools: {} },
    tools: [legacyHostTool],
  });
  const { adapter, handle } = await f.prepare(peer.config, {
    hostCapabilities,
  });
  f.registry.publish(handle);
  assert.match(adapter.catalog().protocolVersion, /^2025-/);
  for (const kind of ["sampling", "elicitation", "roots"]) {
    const result = await f.start(
      `return await mcp.fixture.tools["legacy-host"]({ kind: "${kind}" });`,
    );
    assert.equal(result.run.status, "succeeded", JSON.stringify(result));
    assert.equal(result.result.isError, true);
    assert.deepEqual(result.result.data, { kind, rejected: true });
  }
  assert.equal(seen.length, 0);
  const rejections = peer
    .events()
    .filter((event) => event.method === "legacy-host-rejected");
  assert.deepEqual(
    rejections.map((event) => event.kind),
    ["sampling", "elicitation", "roots"],
  );
  assert.ok(
    rejections.every((event) => Number.isInteger(event.code)),
    "The peer must receive actual JSON-RPC denials instead of timing out locally",
  );
});

test("a required Tasks V1 tool performs real creation, polling and final-result delivery through the ordinary binding", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, {
      legacyOnly: true,
      taskFixture: "v1",
      capabilities: taskCapabilities,
      tools: [taskTool, tools[0]],
    });
  const { adapter, handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  assert.match(adapter.catalog().protocolVersion, /^2025-/);
  assert.equal(
    adapter.catalog().tools.find((tool) => tool.name === "task-tool").execution
      .taskSupport,
    "required",
  );
  const result = await f.start(
    'return await mcp.fixture.tools["task-tool"]({ value: 121 });',
  );
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.result.data, {
    value: 121,
    taskId: "fixture-task-121",
  });
  assert.deepEqual((await f.render(result)).content, [
    { type: "text", text: "task:121" },
  ]);
  const trace = peer.events();
  const created = trace.find(
    (event) =>
      event.method === "task-created" && event.taskId === "fixture-task-121",
  );
  assert.equal(created?.status, "working");
  assert.equal(created?.augmented, true);
  assert.ok(
    trace.some(
      (event) =>
        event.method === "tasks/get" && event.taskId === "fixture-task-121",
    ),
  );
  assert.ok(
    trace.some(
      (event) =>
        event.method === "task-completed" &&
        event.taskId === "fixture-task-121",
    ),
  );
  assert.ok(
    trace.some(
      (event) =>
        event.method === "tasks/result" && event.taskId === "fixture-task-121",
    ),
  );
});

test("a malformed Tasks V1 creation response cannot confirm closure of its still-working remote task", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, {
      legacyOnly: true,
      taskFixture: "v1",
      malformedTaskCreation: true,
      capabilities: taskCapabilities,
      tools: [taskTool],
    });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const started = await f.start(
    'return await mcp.fixture.tools["task-tool"]({ value: 126, waitMs: 10000 });',
    { waitMs: 0 },
  );
  await until(
    () =>
      peer
        .events()
        .some(
          (event) =>
            event.method === "task-created" &&
            event.taskId === "fixture-task-126",
        ),
    "The malformed reply must follow an actual durable Task creation",
  );
  await until(
    () =>
      f
        .history()
        .some(
          (item) =>
            item.kind === "mcp.task" &&
            item.originRunId === started.run.runId &&
            item.diagnostic.details.state !== "preparing",
        ),
    "The adapter must process the malformed creation response before closure is checked",
  );
  const observed = await f.engine.observe(caller, started.run.runId, 200);
  const row = f
    .history()
    .find(
      (item) =>
        item.kind === "mcp.task" && item.originRunId === started.run.runId,
    );
  assert.ok(row);
  const actualTerminal = peer
    .events()
    .some(
      (event) =>
        event.taskId === "fixture-task-126" &&
        event.at <= row.closedAt &&
        ((event.method === "tasks/cancel" && event.status === "cancelled") ||
          event.method === "task-completed"),
    );
  assert.ok(
    row.closedAt === null || actualTerminal,
    JSON.stringify({ observed, row, trace: peer.events() }),
  );
  assert.notEqual(observed.run.status, "succeeded");
});

test("external run cancellation actually cancels its remote Tasks V1 execution and preserves the shared connection", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, {
      legacyOnly: true,
      taskFixture: "v1",
      capabilities: taskCapabilities,
      tools: [taskTool, tools[0]],
    });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const started = await f.start(
    'return await mcp.fixture.tools["task-tool"]({ value: 131, waitMs: 5000 });',
    { waitMs: 0 },
  );
  await until(
    () =>
      peer
        .events()
        .some(
          (event) =>
            event.method === "tasks/get" && event.taskId === "fixture-task-131",
        ),
    "The run must own a real working remote task before cancellation",
  );
  f.engine.cancel(caller, started.run.runId);
  const cancelled = await f.finish(started.run.runId);
  assert.equal(cancelled.run.status, "cancelled", JSON.stringify(cancelled));
  await until(
    () =>
      peer
        .events()
        .some(
          (event) =>
            event.method === "tasks/cancel" &&
            event.taskId === "fixture-task-131" &&
            event.status === "cancelled",
        ),
    "Cancellation must reach the remote task lifecycle handler",
  );
  assert.equal(
    peer
      .events()
      .some(
        (event) =>
          event.method === "tasks/result" &&
          event.taskId === "fixture-task-131",
      ),
    false,
  );
  assert.equal(alive(peer.pid()), true);
  const next = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 132 });',
  );
  assert.equal(next.run.status, "succeeded", JSON.stringify(next));
  assert.equal(next.result.data.received.value, 132);
});

test("modern Tasks V2 requests real Host input and updates the task before delivering its final result", async (t) => {
  const seen = [];
  let f;
  f = await fixture(t, {
    hostRequests: (binding) =>
      hostRequestsFor(binding, seen, { workDir: f.workDir }),
  });
  const peer = stdioFixture(t, f, {
    taskFixture: "v2",
    taskFlow: "input",
    capabilities: {
      tools: {},
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
    tools: [taskTool],
  });
  const { adapter, handle } = await f.prepare(peer.config, {
    hostCapabilities,
  });
  f.registry.publish(handle);
  assert.match(adapter.catalog().protocolVersion, /^2026-/);
  const result = await f.start(
    'return await mcp.fixture.tools["task-tool"]({ value: 141 });',
  );
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify({
      result,
      trace: peer.events(),
      hostCalls: seen.map((item) => ({ kind: item.kind, runId: item.runId })),
    }),
  );
  assert.equal(result.result.data.value, 141);
  assert.equal(result.result.data.sampling.model, "fixture-host-model");
  assert.equal(result.result.data.sampling.content.text, result.run.runId);
  assert.deepEqual((await f.render(result)).content, [
    { type: "text", text: "v2-task:141" },
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].runId, result.run.runId);
  assert.deepEqual(seen[0].caller, caller);
  assert.equal(seen[0].params.messages[0].content.text, "task-sample:141");
  const trace = peer.events();
  assert.ok(
    trace.some(
      (event) =>
        event.method === "tasks/get" && event.status === "input_required",
    ),
  );
  assert.ok(
    trace.some(
      (event) =>
        event.method === "tasks/update" &&
        event.taskId === "fixture-v2-141" &&
        event.sampling.content.text === result.run.runId,
    ),
  );
  assert.ok(
    trace.some(
      (event) => event.method === "tasks/get" && event.status === "completed",
    ),
  );
});

test("cooperative Tasks V2 cancel ACK does not falsely close the run or resource before actual remote cancellation", async (t) => {
  const f = await fixture(t),
    taskCancelReleaseFile = path.join(f.root, "task-cancel-release");
  const peer = stdioFixture(t, f, {
    taskFixture: "v2",
    taskFlow: "cancel",
    taskCancelReleaseFile,
    capabilities: {
      tools: {},
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
    tools: [taskTool, tools[0]],
  });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const started = await f.start(
    'return await mcp.fixture.tools["task-tool"]({ value: 151 });',
    { waitMs: 0 },
  );
  let row;
  try {
    await until(
      () =>
        peer
          .events()
          .some(
            (event) =>
              event.method === "tasks/get" && event.taskId === "fixture-v2-151",
          ),
      "The run must own an actual V2 task",
    );
    row = f
      .history()
      .find(
        (item) =>
          item.kind === "mcp.task" && item.originRunId === started.run.runId,
      );
    assert.ok(row);
    f.engine.cancel(caller, started.run.runId);
    await until(
      () =>
        f.store.getResource(row.resourceId).diagnostic.details
          ?.cancelAcknowledged === true,
      "A real cancel ACK must be observed before terminal cancellation is released",
    );
    assert.equal(
      peer
        .events()
        .some(
          (event) =>
            event.method === "tasks/cancel" &&
            event.taskId === "fixture-v2-151" &&
            event.status === "working",
        ),
      true,
    );
    assert.equal(
      (await f.engine.observe(caller, started.run.runId, 0)).run.status,
      "cancelling",
    );
    const stopping = f.store.getResource(row.resourceId);
    assert.notEqual(stopping.status, "closed");
    assert.equal(stopping.closedAt, null);
    assert.equal(stopping.diagnostic.details.remoteTerminal, false);
    assert.equal(
      peer.events().some((event) => event.method === "task-cancelled"),
      false,
    );
  } finally {
    writeFileSync(taskCancelReleaseFile, "release");
  }
  const cancelled = await f.finish(started.run.runId);
  assert.equal(cancelled.run.status, "cancelled", JSON.stringify(cancelled));
  assert.equal(f.store.getResource(row.resourceId).status, "closed");
  assert.equal(
    peer
      .events()
      .some(
        (event) =>
          event.method === "task-cancelled" &&
          event.taskId === "fixture-v2-151",
      ),
    true,
  );
  const next = await f.start(
    'return await mcp.fixture.tools["echo-value"]({ value: 152 });',
  );
  assert.equal(next.run.status, "succeeded", JSON.stringify(next));
  assert.equal(next.result.data.received.value, 152);
});

test("cancelling an already committed Task creation retains its late handle until the actual remote task is stopped", async (t) => {
  const f = await fixture(t),
    taskCreationReleaseFile = path.join(f.root, "task-creation-release");
  const peer = stdioFixture(t, f, {
    taskFixture: "v2",
    taskFlow: "creation",
    taskCreationReleaseFile,
    capabilities: {
      tools: {},
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
    tools: [taskTool],
  });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const started = await f.start(
    'return await mcp.fixture.tools["task-tool"]({ value: 161 });',
    { waitMs: 0 },
  );
  let row;
  try {
    await until(
      () =>
        peer
          .events()
          .some(
            (event) =>
              event.method === "task-created" &&
              event.taskId === "fixture-v2-161",
          ),
      "The peer must commit the actual Task before its reply is released",
    );
    row = f
      .history()
      .find(
        (item) =>
          item.kind === "mcp.task" && item.originRunId === started.run.runId,
      );
    assert.ok(row);
    f.engine.cancel(caller, started.run.runId);
    const observed = await f.engine.observe(caller, started.run.runId, 200);
    assert.equal(
      observed.run.status,
      "cancelling",
      JSON.stringify({
        observed,
        history: f.store.getResource(row.resourceId),
        trace: peer.events(),
      }),
    );
    assert.equal(f.store.getResource(row.resourceId).closedAt, null);
  } finally {
    writeFileSync(taskCreationReleaseFile, "release");
  }
  const cancelled = await f.finish(started.run.runId);
  assert.equal(cancelled.run.status, "cancelled", JSON.stringify(cancelled));
  await until(
    () =>
      peer
        .events()
        .some(
          (event) =>
            event.method === "tasks/cancel" &&
            event.taskId === "fixture-v2-161",
        ),
    "The late Task identity must be retained and actually cancelled",
  );
  assert.equal(f.store.getResource(row.resourceId).status, "closed");
  assert.equal(
    f.store.getResource(row.resourceId).diagnostic.details.remoteTerminal,
    true,
    JSON.stringify({
      cancelled,
      row: f.store.getResource(row.resourceId),
      trace: peer.events(),
    }),
  );
});

test("modern and legacy resource subscriptions share one channel while retaining independent member cursors", async (t) => {
  for (const legacyOnly of [false, true]) {
    const f = await fixture(t),
      peer = stdioFixture(t, f, {
        legacyOnly,
        capabilities: { tools: {}, resources: { subscribe: true } },
        tools: [notifyTool],
      });
    const { handle } = await f.prepare(peer.config);
    f.registry.publish(handle);
    const result = await f.start(`
      const first = await mcp.fixture.resources.subscribe({ uri: "fixture://document/1" });
      const second = await mcp.fixture.resources.subscribe({ uri: "fixture://document/1" });
      await mcp.fixture.tools["notify-resource"]({ uri: "fixture://document/1" });
      const firstEvents = await mcp.fixture.resources.getSubscription({ subscriptionId: first.subscriptionId, waitMs: 1000 });
      const secondEvents = await mcp.fixture.resources.getSubscription({ subscriptionId: second.subscriptionId, waitMs: 1000 });
      const firstClosed = await mcp.fixture.resources.unsubscribe({ subscriptionId: first.subscriptionId });
      await mcp.fixture.tools["notify-resource"]({ uri: "fixture://document/1" });
      const later = await mcp.fixture.resources.getSubscription({ subscriptionId: second.subscriptionId, cursor: secondEvents.cursor, waitMs: 1000 });
      return { first, second, firstEvents, secondEvents, firstClosed, later };
    `);
    assert.equal(result.run.status, "succeeded", JSON.stringify(result));
    const value = result.result.data;
    assert.notEqual(value.first.subscriptionId, value.second.subscriptionId);
    assert.equal(value.firstEvents.events.length, 1);
    assert.equal(value.secondEvents.events.length, 1);
    assert.equal(value.firstEvents.events[0].cursor, 1);
    assert.equal(value.secondEvents.events[0].cursor, 1);
    assert.equal(value.later.events.length, 1);
    assert.equal(value.later.events[0].cursor, 2);
    assert.equal(value.later.events[0].uri, "fixture://document/1");
    assert.equal(value.later.historyLost, false);
    assert.equal(value.firstClosed.state, "closed");
    assert.equal(
      f.store.getResource(value.first.subscriptionId).status,
      "closed",
    );
    assert.equal(
      f.store.getResource(value.second.subscriptionId).status,
      "closed",
    );
    const trace = peer.events();
    if (legacyOnly) {
      assert.equal(
        trace.filter((event) => event.method === "resources/subscribe").length,
        1,
      );
      assert.equal(
        trace.filter((event) => event.method === "resources/unsubscribe")
          .length,
        1,
      );
    } else {
      const listens = trace.filter(
        (event) =>
          event.method === "incoming" && event.name === "subscriptions/listen",
      );
      assert.equal(listens.length, 1);
      assert.equal(
        trace.filter(
          (event) =>
            event.method === "incoming" &&
            event.name === "notifications/cancelled" &&
            event.requestId === listens[0].id,
        ).length,
        1,
      );
    }
    assert.equal(alive(peer.pid()), true);
  }
});

test("subscription lifetime follows the run unless background handoff is explicitly requested", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, {
      capabilities: { tools: {}, resources: { subscribe: true } },
      tools: [notifyTool],
    });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const opened = await f.start(`
    const owned = await mcp.fixture.resources.subscribe({ uri: "fixture://document/2" });
    const background = await mcp.fixture.resources.subscribe({ uri: "fixture://document/2", background: true });
    return { owned, background };
  `);
  assert.equal(opened.run.status, "succeeded", JSON.stringify(opened));
  const owned = opened.result.data.owned,
    background = opened.result.data.background;
  assert.equal(owned.background, false);
  assert.equal(background.background, true);
  assert.equal(f.store.getResource(owned.subscriptionId).status, "closed");
  assert.equal(
    f.store.getResource(background.subscriptionId).status,
    "registered",
  );
  assert.equal(
    f.store.getResource(background.subscriptionId).lifetime,
    "background",
  );
  const later = await f.start(`
    await mcp.fixture.tools["notify-resource"]({ uri: "fixture://document/2" });
    return await mcp.fixture.resources.getSubscription({ subscriptionId: "${background.subscriptionId}", waitMs: 1000 });
  `);
  assert.equal(later.run.status, "succeeded", JSON.stringify(later));
  assert.equal(later.result.data.events.length, 1);
  assert.equal(later.result.data.events[0].uri, "fixture://document/2");
  const closed = await f.start(
    `return await mcp.fixture.resources.unsubscribe({ subscriptionId: "${background.subscriptionId}" });`,
  );
  assert.equal(closed.run.status, "succeeded", JSON.stringify(closed));
  assert.equal(closed.result.data.state, "closed");
  assert.equal(f.store.getResource(background.subscriptionId).status, "closed");
});

test("cancelling a subscription wait leaves its background subscription and original connection available", async (t) => {
  const f = await fixture(t),
    peer = stdioFixture(t, f, {
      capabilities: { tools: {}, resources: { subscribe: true } },
      tools: [notifyTool],
    });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const opened = await f.start(
    'return await mcp.fixture.resources.subscribe({ uri: "fixture://document/1", background: true });',
  );
  assert.equal(opened.run.status, "succeeded", JSON.stringify(opened));
  const id = opened.result.data.subscriptionId;
  const waiting = await f.start(
    `return await mcp.fixture.resources.getSubscription({ subscriptionId: "${id}", cursor: 0, waitMs: 30000 });`,
    { waitMs: 0 },
  );
  await until(
    () =>
      f.store
        .operationsForRun(waiting.run.runId)
        .some((operation) => operation.status === "running"),
    "The long poll must start before external cancellation",
  );
  f.engine.cancel(caller, waiting.run.runId);
  assert.equal((await f.finish(waiting.run.runId)).run.status, "cancelled");
  assert.equal(f.store.getResource(id).status, "registered");
  assert.equal(alive(peer.pid()), true);
  const next = await f.start(`
    await mcp.fixture.tools["notify-resource"]({ uri: "fixture://document/1" });
    const notification = await mcp.fixture.resources.getSubscription({ subscriptionId: "${id}", cursor: 0, waitMs: 1000 });
    await mcp.fixture.resources.unsubscribe({ subscriptionId: "${id}" });
    return notification;
  `);
  assert.equal(next.run.status, "succeeded", JSON.stringify(next));
  assert.equal(next.result.data.events.length, 1);
  assert.equal(f.store.getResource(id).status, "closed");
});

test("subscription capability controls entry publication and retained notification history stays bounded", async (t) => {
  const absent = await fixture(t),
    absentPeer = stdioFixture(t, absent, {
      capabilities: { resources: { subscribe: false } },
      tools: [],
    });
  const { handle: absentHandle } = await absent.prepare(absentPeer.config);
  absent.registry.publish(absentHandle);
  const missing = await absent.start(
    "return [typeof mcp.fixture.resources.subscribe, typeof mcp.fixture.resources.getSubscription, typeof mcp.fixture.resources.unsubscribe];",
  );
  assert.equal(missing.run.status, "succeeded", JSON.stringify(missing));
  assert.deepEqual(missing.result.data, [
    "undefined",
    "undefined",
    "undefined",
  ]);
  const f = await fixture(t),
    peer = stdioFixture(t, f, {
      capabilities: { tools: {}, resources: { subscribe: true } },
      tools: [notifyTool],
    });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const accepted = await f.start(
    `
    const subscription = await mcp.fixture.resources.subscribe({ uri: "fixture://document/1" });
    await mcp.fixture.tools["notify-resource"]({ uri: "fixture://document/1", count: 300 });
    return await mcp.fixture.resources.getSubscription({ subscriptionId: subscription.subscriptionId, cursor: 0, waitMs: 1000 });
  `,
    { waitMs: 0 },
  );
  // Publishing 300 retained notifications performs real SQLite writes. Observe
  // this one admitted run through completion even on slower native CI disks.
  const result = await f.engine.observe(caller, accepted.run.runId, 30000);
  assert.equal(result.run.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.data.cursor, 300);
  assert.equal(result.result.data.events.length, 256);
  assert.equal(result.result.data.events[0].cursor, 45);
  assert.equal(result.result.data.historyLost, true);
});

test("a new same-URI subscriber cannot join a channel while its last legacy member is unsubscribing", async (t) => {
  const f = await fixture(t),
    unsubscribeReleaseFile = path.join(f.root, "unsubscribe-release");
  const peer = stdioFixture(t, f, {
    legacyOnly: true,
    unsubscribeReleaseFile,
    capabilities: { resources: { subscribe: true } },
    tools: [],
  });
  const { handle } = await f.prepare(peer.config);
  f.registry.publish(handle);
  const started = await f.start(
    `
    const first = await mcp.fixture.resources.subscribe({ uri: "fixture://document/1" });
    const closing = mcp.fixture.resources.unsubscribe({ subscriptionId: first.subscriptionId });
    const opening = mcp.fixture.resources.subscribe({ uri: "fixture://document/1" });
    const replacement = await opening;
    await closing;
    const snapshot = await mcp.fixture.resources.getSubscription({ subscriptionId: replacement.subscriptionId });
    await mcp.fixture.resources.unsubscribe({ subscriptionId: replacement.subscriptionId });
    return snapshot;
  `,
    { waitMs: 0 },
  );
  try {
    await until(
      () =>
        peer.events().some((event) => event.method === "resources/unsubscribe"),
      "The last member's actual unsubscribe must be in flight",
    );
    await until(
      () =>
        f.history().filter((item) => item.kind === "mcp.subscription")
          .length === 2,
      "The replacement subscription must be registered during old-channel shutdown",
    );
  } finally {
    writeFileSync(unsubscribeReleaseFile, "release");
  }
  const result = await f.finish(started.run.runId);
  assert.equal(
    result.run.status,
    "succeeded",
    JSON.stringify({ result, trace: peer.events() }),
  );
  assert.equal(result.result.data.state, "subscribed");
  assert.equal(
    peer.events().filter((event) => event.method === "resources/subscribe")
      .length,
    2,
  );
  assert.equal(
    peer.events().filter((event) => event.method === "resources/unsubscribe")
      .length,
    2,
  );
});
