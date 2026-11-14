import { addAbortListener, EventEmitter, once } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import {
  Client,
  ReadBuffer,
  serializeMessage,
  type Transport,
  type JSONRPCMessage,
  type Tool,
  type Resource,
  type ResourceTemplateType,
  type Prompt,
  type RequestOptions,
  type JsonSchemaType,
  type JsonSchemaValidatorResult,
  type ClientCapabilities,
  type ClientContext,
  type CreateMessageResult,
  type ElicitResult,
  type ListRootsResult,
  type McpSubscription,
  type OAuthClientProvider,
  getSupportedElicitationModes,
} from "@modelcontextprotocol/client";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import {
  compileMethodSchema,
  type SchemaDialect,
} from "../contracts/validation.js";
import type { JsonObject } from "../contracts/types.js";
import type {
  ExtensionFactory,
  ExtensionHost,
  Invocation,
  MethodDefinition,
} from "../extensions/api.js";
import type { ManagedResource, ResourceRef } from "../extensions/resources.js";
import type {
  ProcessBackend,
  ProcessBackendOptions,
} from "../process/backend.js";
import { normalizeLaunch, prepareLaunch } from "../process/launch.js";
import {
  projectMcpProtocolResult,
  copyMcpJSON,
  type McpReadScope,
  type McpResourceReader,
} from "../results/mcp.js";
import { ManagedHttpTransport } from "./mcp-http.js";
import { McpWire } from "./mcp-wire.js";
import {
  createSessionPortFromClient,
  withTasks,
  toolDeclarationFromMcpTool,
  resultFromTaskOutcome,
  createApplicationInputHandler,
  type TaskEnabledSession,
  type ToolExecution,
  type TaskView,
  type TaskOutcome,
  type ConnectedMcpSessionPort,
  type ApplicationInputRequest,
} from "@modelcontextprotocol/ext-tasks/client";
import {
  taskId as taskIdentity,
  type TaskId,
} from "@modelcontextprotocol/ext-tasks/core";
import { CreateTaskResultV1Schema } from "@modelcontextprotocol/ext-tasks/core/v1";
import { CreateTaskResultV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";

export type McpConnectionConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: readonly string[];
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }
  | {
      name: string;
      transport: "streamable-http";
      url: string;
      headers?: Readonly<Record<string, string>>;
    };
export interface McpAdapterOptions {
  revision?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxCatalogBytes?: number;
  maxCatalogItems?: number;
  /** Trusted Core bridge availability, never inferred from a caller or config file. */
  hostCapabilities?: JsonObject;
  /** Core-provided after user approval; not a connection JSON field. */
  authProvider?: OAuthClientProvider;
  /** Binds approved private credentials to this exact live extension host. */
  authProviderFactory?: (host: ExtensionHost) => OAuthClientProvider;
}
export interface McpCatalog {
  readonly name: string;
  readonly transport: McpConnectionConfig["transport"];
  readonly instanceId: string;
  readonly revision: string | null;
  readonly ready: boolean;
  readonly stale: boolean;
  readonly protocolVersion: string | null;
  readonly server: unknown;
  readonly capabilities: unknown;
  readonly instructions: string | null;
  readonly tools: readonly Tool[];
  readonly resources: readonly Resource[];
  readonly resourceTemplates: readonly ResourceTemplateType[];
  readonly prompts: readonly Prompt[];
}
type RemoteMethod =
  | "tools/call"
  | "tools/list"
  | "resources/list"
  | "resources/templates/list"
  | "resources/read"
  | "prompts/list"
  | "prompts/get";
// Trusted installed program identity; this does not start or probe a connection.
const installedAgent = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name?: unknown; version?: unknown };
requireCondition(
  typeof installedAgent.name === "string" &&
    typeof installedAgent.version === "string",
  "invalid_mcp_host",
  "The MCP client requires its actual installed Agent identity.",
);
const clientIdentity = Object.freeze({
  name: installedAgent.name,
  version: installedAgent.version,
});
const MiB = 1024 * 1024;
const maximumTimeout = 2_147_483_647;
const allPermissions = Object.freeze(["mcp.use"] as const);
const pageSchema = {
  type: "object",
  additionalProperties: false,
  properties: { cursor: { type: "string", minLength: 1, maxLength: 4096 } },
};
const readSchema = {
  type: "object",
  required: ["uri"],
  additionalProperties: false,
  properties: { uri: { type: "string", minLength: 1, maxLength: 1024 } },
};
const getPromptSchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 1024 },
    arguments: { type: "object", additionalProperties: { type: "string" } },
  },
};

type Limits = Required<
  Omit<McpAdapterOptions, "revision" | "authProvider" | "authProviderFactory">
> &
  Pick<McpAdapterOptions, "revision" | "authProvider" | "authProviderFactory">;
export function validateMcpConnectionConfig(
  value: unknown,
): McpConnectionConfig {
  const input = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  requireCondition(
    isPlainRecord(input),
    "invalid_mcp_config",
    "An MCP connection needs a configuration object.",
  );
  requireCondition(
    typeof input.name === "string" &&
      /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/.test(input.name),
    "invalid_mcp_config",
    "An MCP connection needs a bounded unambiguous name.",
  );
  const fields =
    input.transport === "stdio"
      ? ["name", "transport", "command", "args", "cwd", "env"]
      : input.transport === "streamable-http"
        ? ["name", "transport", "url", "headers"]
        : [];
  requireCondition(
    fields.length && Object.keys(input).every((key) => fields.includes(key)),
    "invalid_mcp_config",
    "Only the supported MCP transport configuration fields are accepted.",
  );
  if (input.transport === "stdio") {
    // Reuse the same direct-argv/environment validation as the managed process SDK.
    normalizeLaunch(
      [
        {
          command: input.command,
          ...(input.args === undefined ? {} : { args: input.args }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.env === undefined ? {} : { env: input.env }),
        },
      ],
      "start",
    );
    if (input.env !== undefined)
      requireCondition(
        isPlainRecord(input.env) &&
          Object.values(input.env).every((value) => typeof value === "string"),
        "invalid_mcp_config",
        "MCP environment values must be strings.",
      );
  } else {
    requireCondition(
      typeof input.url === "string" && Buffer.byteLength(input.url) <= 1024,
      "invalid_mcp_config",
      "The MCP HTTP endpoint must be a bounded URL.",
    );
    let endpoint: URL;
    try {
      endpoint = new URL(input.url);
    } catch {
      throw new AgentError(
        "invalid_mcp_config",
        "The MCP HTTP endpoint is not an absolute URL.",
      );
    }
    requireCondition(
      ["http:", "https:"].includes(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.hash,
      "invalid_mcp_config",
      "MCP HTTP requires an HTTP(S) endpoint without embedded credentials or fragments.",
    );
    if (input.headers !== undefined) {
      requireCondition(
        isPlainRecord(input.headers) && Object.keys(input.headers).length <= 64,
        "invalid_mcp_config",
        "MCP headers require a bounded data object.",
      );
      const reserved = new Set([
        "host",
        "connection",
        "transfer-encoding",
        "content-length",
        "content-type",
        "accept",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
      ]);
      for (const [name, value] of Object.entries(input.headers))
        requireCondition(
          /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
            !reserved.has(name.toLowerCase()) &&
            typeof value === "string" &&
            !/[\0\r\n]/.test(value) &&
            Buffer.byteLength(value) <= 16384,
          "invalid_mcp_config",
          "MCP headers contain an invalid or protocol-reserved field.",
        );
    }
  }
  return deepFreeze(input) as unknown as McpConnectionConfig;
}
function optionsSnapshot(value: McpAdapterOptions): Limits {
  requireCondition(
    isPlainRecord(value),
    "invalid_mcp_options",
    "MCP adapter options require a trusted data object.",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireCondition(
    Object.values(descriptors).every((descriptor) => "value" in descriptor),
    "invalid_mcp_options",
    "MCP adapter options cannot contain accessors.",
  );
  const { authProvider, authProviderFactory, ...data } = value;
  requireCondition(
    authProviderFactory === undefined ||
      (typeof authProviderFactory === "function" && authProvider === undefined),
    "invalid_mcp_options",
    "Use one trusted OAuth provider or its instance-bound factory.",
  );
  if (authProvider !== undefined)
    requireCondition(
      typeof authProvider === "object" &&
        authProvider !== null &&
        [
          "clientInformation",
          "tokens",
          "saveTokens",
          "redirectToAuthorization",
          "saveCodeVerifier",
          "codeVerifier",
        ].every(
          (key) =>
            typeof (authProvider as unknown as Record<string, unknown>)[key] ===
            "function",
        ),
      "invalid_mcp_options",
      "MCP OAuth requires the official trusted provider service.",
    );
  const fixed = JSON.parse(canonicalJson(data)) as Record<string, unknown>;
  requireCondition(
    isPlainRecord(fixed) &&
      Object.keys(fixed).every((key) =>
        [
          "revision",
          "connectTimeoutMs",
          "requestTimeoutMs",
          "maxMessageBytes",
          "maxCatalogBytes",
          "maxCatalogItems",
          "hostCapabilities",
        ].includes(key),
      ),
    "invalid_mcp_options",
    "The MCP adapter options contain an unknown field.",
  );
  if (fixed.revision !== undefined)
    requireCondition(
      typeof fixed.revision === "string" &&
        fixed.revision.length > 0 &&
        Buffer.byteLength(fixed.revision) <= 1024,
      "invalid_mcp_options",
      "The source revision must be bounded text.",
    );
  const result = {
    connectTimeoutMs: 10000,
    requestTimeoutMs: maximumTimeout,
    maxMessageBytes: 128 * MiB,
    maxCatalogBytes: 4 * MiB,
    maxCatalogItems: 1000,
    hostCapabilities: {},
    ...fixed,
  } as Limits;
  for (const key of [
    "connectTimeoutMs",
    "requestTimeoutMs",
    "maxMessageBytes",
    "maxCatalogBytes",
    "maxCatalogItems",
  ] as const)
    requireCondition(
      Number.isSafeInteger(result[key]) &&
        result[key] >= 1 &&
        result[key] <=
          (key.endsWith("TimeoutMs")
            ? maximumTimeout
            : key === "maxCatalogItems"
              ? 10000
              : 128 * MiB),
      "invalid_mcp_options",
      "An MCP adapter limit is outside its supported budget.",
    );
  requireCondition(
    isPlainRecord(result.hostCapabilities) &&
      Object.keys(result.hostCapabilities).every((key) =>
        ["sampling", "elicitation", "roots"].includes(key),
      ),
    "invalid_mcp_options",
    "Only actual Host bridge capabilities may be advertised.",
  );
  // Freeze JSON options, never freeze or enumerate a trusted provider's private
  // mutable token/session service.
  return Object.freeze({
    ...deepFreeze(result),
    ...(authProvider
      ? { authProvider: authProvider as OAuthClientProvider }
      : {}),
    ...(authProviderFactory
      ? {
          authProviderFactory: authProviderFactory as (
            host: ExtensionHost,
          ) => OAuthClientProvider,
        }
      : {}),
  });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function publicMetadata(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "_meta"),
  );
}
function publicError(cause: unknown, stage: string): AgentError {
  // Remote protocol/transport messages and Error causes can contain arguments,
  // authorization headers or server stderr. Never put them in ordinary logs/results.
  const code =
    cause && typeof cause === "object"
      ? Object.getOwnPropertyDescriptor(cause, "code")?.value
      : undefined;
  return new AgentError(
    "mcp_request_failed",
    `The MCP ${stage} did not complete.`,
    typeof code === "number" && Number.isFinite(code)
      ? { protocolCode: code }
      : undefined,
  );
}
function dialect(schema: unknown): SchemaDialect {
  const declared = isPlainRecord(schema) ? schema.$schema : undefined;
  return declared === "http://json-schema.org/draft-07/schema#" ||
    declared === "http://json-schema.org/draft-07/schema"
    ? "draft7"
    : "2020-12";
}

interface StdioCallScope {
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<void>>;
  readonly dropped: Set<string | number>;
  active: boolean;
}
/** Official MCP framing over the same cold, physically managed process backend as sh. */
class ManagedStdioTransport implements Transport, ManagedResource {
  get pid(): number | undefined {
    return this.#backend?.facts().pid ?? undefined;
  }
  get stderr(): null {
    return null;
  }
  readonly closed: Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  #done = Promise.withResolvers<void>();
  #signal = new AbortController();
  #backend?: ProcessBackend;
  #backendChanged?: () => void;
  #reportFailure: unknown;
  #start?: Promise<void>;
  #close?: Promise<void>;
  #stopping = false;
  #complete = false;
  #buffer: ReadBuffer;
  #queue: Promise<void> = Promise.resolve();
  #pendingBytes = 0;
  #pendingMessages = 0;
  #calls = new AsyncLocalStorage<StdioCallScope>();
  #requestScopes = new Map<string | number, StdioCallScope>();
  constructor(
    readonly config: Extract<McpConnectionConfig, { transport: "stdio" }>,
    readonly host: ExtensionHost,
    readonly maximum: number,
    readonly report: (facts: JsonObject) => void,
    readonly committed?: () => void,
  ) {
    this.closed = this.#done.promise;
    this.#buffer = new ReadBuffer({ maxBufferSize: maximum });
  }
  start(): Promise<void> {
    requireCondition(
      !this.#start && !this.#stopping,
      "mcp_connection_closed",
      "The MCP transport cannot be started again.",
    );
    this.#start = this.#startProcess();
    return this.#start;
  }
  async #startProcess(): Promise<void> {
    try {
      const filename = process.platform === "win32" ? "windows-pipes" : "pipes";
      const exported =
        process.platform === "win32"
          ? "WindowsProcessBackend"
          : "PipeProcessBackend";
      const module = await import(
        new URL(`../process/${filename}.js`, import.meta.url).href
      );
      this.#signal.signal.throwIfAborted();
      const options: ProcessBackendOptions = {
        onOutput: async (stream, bytes) => {
          if (stream !== "stdout") return; // Consume stderr with backpressure; do not persist protocol secrets.
          if (this.#stopping) return;
          try {
            this.#buffer.append(bytes);
            for (;;) {
              const message = this.#buffer.readMessage();
              if (!message) break;
              this.onmessage?.(message);
            }
          } catch (cause) {
            this.onerror?.(publicError(cause, "message decoding"));
            queueMicrotask(() => {
              void this.dispose().catch(() => {});
            });
          }
        },
      };
      this.#backend = new module[exported](options) as ProcessBackend;
      this.#backendChanged = () => {
        try {
          this.report({ ...this.#backend!.facts() });
        } catch (cause) {
          // Reporting must not unwind a native process event or interrupt its
          // stop reservation before a signal reaches the real process tree.
          this.#reportFailure ??= cause;
          queueMicrotask(() => {
            void this.dispose(cause).catch(() => {});
          });
        }
      };
      this.#backend.on("change", this.#backendChanged);
      void this.#backend.closed.then(() => this.#finish());
      const input = normalizeLaunch(
        [
          {
            command: this.config.command,
            args: this.config.args ?? [],
            ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
            env: this.config.env ?? {},
          },
        ],
        "start",
      );
      const paths = this.host.context.paths as JsonObject;
      requireCondition(
        paths && typeof paths.work === "string",
        "invalid_mcp_host",
        "The MCP instance needs its Agent work directory.",
      );
      const prepared = await prepareLaunch(
        input,
        paths.work,
        this.#signal.signal,
        (value, access) => this.host.authorize({ type: "path", value, access }),
      );
      this.#signal.signal.throwIfAborted();
      await this.#backend.start(prepared.launch);
    } catch (cause) {
      if (!this.#backend) this.#finish();
      throw cause;
    }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    requireCondition(
      !this.#stopping && this.#backend,
      "mcp_connection_closed",
      "The MCP connection is closed.",
    );
    const serialized = Buffer.from(serializeMessage(message));
    requireCondition(
      serialized.byteLength <= this.maximum &&
        this.#pendingBytes + serialized.byteLength <= this.maximum &&
        this.#pendingMessages < 256,
      "mcp_message_too_large",
      "MCP outbound messages exceed the connection budget.",
    );
    const request = "method" in message && "id" in message;
    const cancellationId =
      "method" in message && message.method === "notifications/cancelled"
        ? message.params?.requestId
        : undefined;
    const scope =
      (typeof cancellationId === "string" || typeof cancellationId === "number"
        ? this.#requestScopes.get(cancellationId)
        : undefined) ?? this.#calls.getStore();
    requireCondition(
      !request || !scope || scope.active,
      "mcp_call_closed",
      "The MCP call no longer admits requests.",
    );
    if (request && scope)
      this.#requestScopes.set(message.id as string | number, scope);
    this.#pendingBytes += serialized.byteLength;
    this.#pendingMessages++;
    const task = this.#queue.then(async () => {
      // A request not yet committed to the shared stream must not start after
      // its caller stops. A partially written frame must finish before the
      // cancellation frame, otherwise it would corrupt everybody's channel.
      if (request && scope?.signal.aborted) {
        scope.dropped.add(message.id as string | number);
        scope.signal.throwIfAborted();
      }
      if (
        "method" in message &&
        message.method === "notifications/cancelled" &&
        scope
      ) {
        const id = message.params?.requestId;
        if (
          (typeof id === "string" || typeof id === "number") &&
          scope.dropped.has(id)
        )
          return;
      }
      if (request) this.committed?.();
      for (let offset = 0; offset < serialized.byteLength; offset += 65536)
        await this.#backend!.write(
          serialized.subarray(offset, offset + 65536),
          false,
          this.#signal.signal,
        );
    });
    scope?.pending.add(task);
    void task.then(
      () => scope?.pending.delete(task),
      () => scope?.pending.delete(task),
    );
    this.#queue = task.catch(() => {});
    try {
      await task;
    } finally {
      this.#pendingBytes -= serialized.byteLength;
      this.#pendingMessages--;
    }
  }
  async run<T>(signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const scope: StdioCallScope = {
      signal,
      pending: new Set(),
      dropped: new Set(),
      active: true,
    };
    try {
      return await this.#calls.run(scope, callback);
    } finally {
      scope.active = false;
      while (scope.pending.size) await Promise.allSettled([...scope.pending]);
      for (const [id, owner] of this.#requestScopes)
        if (owner === scope) this.#requestScopes.delete(id);
    }
  }
  close(): Promise<void> {
    return this.dispose();
  }
  dispose(_reason?: unknown): Promise<void> {
    if (this.#close) return this.#close;
    this.#stopping = true;
    this.#signal.abort(
      new AgentError("mcp_connection_closed", "The MCP instance is closing."),
    );
    this.#close = (async () => {
      // Initialization/preparation can be in flight; abort it and wait before
      // confirming a cold backend. No late process can start after disposal.
      // Stop a starting backend immediately as well: on Windows, merely
      // waiting for helper readiness could otherwise permit a late spawn.
      const backendStop = this.#backend?.dispose();
      const [_, stopped] = await Promise.allSettled([this.#start, backendStop]);
      if (stopped.status === "rejected") throw stopped.reason;
      if (this.#backend) await this.#backend.closed;
      else this.#finish();
      await this.#queue;
      if (this.#reportFailure) throw this.#reportFailure;
    })();
    void this.#close.catch(() => {
      this.#close = undefined;
    });
    return this.#close;
  }
  #finish(): void {
    if (this.#complete) return;
    this.#complete = true;
    if (this.#backend && this.#backendChanged)
      this.#backend.off("change", this.#backendChanged);
    this.#buffer.clear();
    this.#calls.disable();
    this.#done.resolve();
    this.onclose?.();
  }
}

interface TaskCreation {
  readonly call: Invocation;
  maybeStarted: boolean;
  awaitingResponse: boolean;
  taskId?: TaskId;
  malformedTask: boolean;
  stopping: boolean;
}
/** Tracks the official execution, not a second task runner. Cancel ACK is not terminal evidence. */
class ManagedMcpExecution implements ManagedResource {
  readonly closed: Promise<void>;
  #done = Promise.withResolvers<void>();
  #ref?: ResourceRef;
  #execution?: ToolExecution<unknown, Invocation>;
  #running?: Promise<unknown>;
  #creation?: Promise<ToolExecution<unknown, Invocation>>;
  #disposal?: Promise<void>;
  #terminal = false;
  #stopping = false;
  #reportFailure: unknown;
  #last?: TaskView;
  #state = "preparing";
  #cancelAcknowledged = false;
  #cleanupActive = false;
  #finishRequested = false;
  #finished = false;
  #confirmedOutcome?: TaskOutcome<unknown>;
  constructor(
    readonly session: TaskEnabledSession<Invocation>,
    readonly call: Invocation,
    readonly connection: string,
    readonly begin: () => Promise<ToolExecution<unknown, Invocation>>,
    readonly drain: () => Promise<void>,
    readonly creation: TaskCreation,
    readonly cleanup: <T>(action: () => Promise<T>) => Promise<T>,
  ) {
    this.closed = this.#done.promise;
  }
  attach(ref: ResourceRef): void {
    this.#ref = ref;
    this.#report();
  }
  #finish(): void {
    this.#finishRequested = true;
    if (!this.#cleanupActive && !this.#finished) {
      this.#finished = true;
      this.#done.resolve();
    }
  }
  #report(task?: TaskView): void {
    if (this.#finished) return;
    if (
      task &&
      this.#terminal &&
      !["completed", "failed", "cancelled"].includes(task.status)
    )
      return;
    if (task) {
      this.#last = task;
      this.#state = task.status;
    }
    try {
      this.#ref?.report({
        connection: this.connection,
        state: task?.status ?? (this.#stopping ? "stopping" : this.#state),
        remoteTaskId: task?.taskId ?? this.creation.taskId ?? null,
        remoteTerminal: this.#terminal,
        cancelAcknowledged: this.#cancelAcknowledged,
        creationMayHaveStarted: this.creation.maybeStarted,
        creationResponsePending: this.creation.awaitingResponse,
      });
    } catch (cause) {
      this.#reportFailure ??= cause;
    }
  }
  execute(): Promise<unknown> {
    requireCondition(
      !this.#running && !this.#stopping,
      "mcp_task_closed",
      "The task controller cannot start again.",
    );
    if (this.#reportFailure) {
      this.#finish();
      throw this.#reportFailure;
    }
    this.#running = (async () => {
      try {
        this.#creation = this.begin();
        this.#execution = await this.#creation;
        const settlement = await this.#execution.settle({
          close: false,
          onEvent: (event) => {
            if (event.type === "task") {
              if (
                this.#terminal &&
                !["completed", "failed", "cancelled"].includes(
                  event.task.status,
                )
              )
                return;
              this.#terminal ||= ["completed", "failed", "cancelled"].includes(
                event.task.status,
              );
              this.#report(event.task);
              if (!this.call.signal.aborted)
                this.call.progress({
                  connection: this.connection,
                  remoteTaskId: event.task.taskId,
                  taskStatus: event.task.status,
                });
            }
          },
        });
        if (this.#execution.kind === "immediate") {
          this.#terminal = true;
          this.#state = "completed";
          this.#report();
        }
        if (settlement.lastTask) {
          this.#terminal ||= ["completed", "failed", "cancelled"].includes(
            settlement.lastTask.status,
          );
          this.#report(settlement.lastTask);
        }
        if (this.#terminal) {
          await this.#execution.detach();
          await this.drain();
          this.#finish();
        }
        if (this.#reportFailure) throw this.#reportFailure;
        return resultFromTaskOutcome(
          this.#confirmedOutcome ?? settlement.outcome,
        );
      } catch (cause) {
        if (!this.#execution) {
          this.#state =
            this.creation.taskId ||
            (this.creation.maybeStarted &&
              (this.creation.awaitingResponse || this.creation.malformedTask))
              ? "creation_unknown"
              : this.call.signal.aborted
                ? "cancelled"
                : "failed";
          this.#report();
          await this.drain();
          if (this.#state !== "creation_unknown") this.#finish();
        } else if (this.#terminal) {
          await this.#execution.detach();
          await this.drain();
          this.#finish();
        }
        throw cause;
      }
    })();
    return this.#running;
  }
  facts(): JsonObject {
    return {
      connection: this.connection,
      state: this.#last?.status ?? this.#state,
      remoteTaskId:
        this.#last?.taskId ??
        (this.#execution?.kind === "task"
          ? this.#execution.handle.taskId
          : (this.creation.taskId ?? null)),
      remoteTerminal: this.#terminal,
      cancelAcknowledged: this.#cancelAcknowledged,
      creationMayHaveStarted: this.creation.maybeStarted,
      creationResponsePending: this.creation.awaitingResponse,
    };
  }
  async snapshot(signal: AbortSignal): Promise<JsonObject> {
    if (this.#execution?.kind !== "task") return this.facts();
    const task = await this.session
      .task(this.#execution.handle.taskId, { requestTimeoutMs: 5000 })
      .snapshot(signal);
    this.#terminal ||= ["completed", "failed", "cancelled"].includes(
      task.status,
    );
    this.#report(task);
    return this.facts();
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#stopping = true;
    this.creation.stopping = true;
    this.#report();
    this.#cleanupActive = true;
    this.#disposal = this.cleanup(async () => {
      if (!this.#running) {
        this.#finish();
        return;
      }
      await this.#creation?.catch(() => {});
      if (!this.#execution && !this.creation.taskId) {
        await this.#running.catch(() => {});
        requireCondition(
          !(
            this.creation.maybeStarted &&
            (this.creation.awaitingResponse || this.creation.malformedTask)
          ),
          "mcp_task_creation_unconfirmed",
          "The committed task creation has no confirmed response or task identity.",
        );
        this.#finish();
        return;
      }
      if (this.#terminal) {
        if (!this.call.signal.aborted) await this.#running.catch(() => {});
        await this.#execution?.detach();
        await this.drain();
        this.#finish();
        return;
      }
      if (this.#execution?.kind === "immediate") {
        await this.#execution.detach();
        await this.#running.catch(() => {});
        this.#finish();
        return;
      }
      const signal = AbortSignal.timeout(5000);
      const taskId =
        this.#execution?.kind === "task"
          ? this.#execution.handle.taskId
          : this.creation.taskId!;
      const remote = this.session.task(taskId, { requestTimeoutMs: 5000 });
      await remote.cancel(signal);
      this.#cancelAcknowledged = true;
      try {
        if (!this.#finished)
          this.#ref?.report({
            connection: this.connection,
            state: this.#terminal
              ? (this.#last?.status ?? this.#state)
              : "cancelling",
            remoteTaskId: taskId,
            cancelAcknowledged: true,
            remoteTerminal: this.#terminal,
          });
      } catch (cause) {
        this.#reportFailure ??= cause;
      }
      // The official controller performs generation-specific observation. A
      // cooperative V2 cancel is not falsely converted into remote termination.
      const outcome = await remote.result({ signal });
      this.#confirmedOutcome = outcome;
      this.#terminal ||=
        !!outcome.task &&
        ["completed", "failed", "cancelled"].includes(outcome.task.status);
      requireCondition(
        this.#terminal,
        "mcp_task_stop_unconfirmed",
        "The remote task has not reached a confirmed terminal state.",
      );
      this.#report(outcome.task);
      await this.#execution?.detach();
      await this.#running.catch(() => {});
      await this.drain();
      this.#finish();
      if (this.#reportFailure) throw this.#reportFailure;
    })
      .finally(async () => {
        await this.drain();
        this.#cleanupActive = false;
        if (this.#finishRequested) this.#finish();
      })
      .catch((cause) => {
        throw cause instanceof AgentError
          ? cause
          : publicError(cause, "task cleanup");
      });
    void this.#disposal.catch(() => {
      this.#disposal = undefined;
    });
    return this.#disposal;
  }
}

interface SubscriptionChannel {
  readonly uri: string;
  readonly members: Set<ManagedMcpSubscription>;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly closing: boolean;
  readonly active: boolean;
  readonly acceptingUpdates: boolean;
  stop(): Promise<void>;
}
/** A listener is a normal Core resource; its channel uses the registered connection. */
class ManagedMcpSubscription extends EventEmitter implements ManagedResource {
  readonly closed: Promise<void>;
  #done = Promise.withResolvers<void>();
  #channel?: SubscriptionChannel;
  #ref?: ResourceRef;
  #events: { cursor: number; uri: string; receivedAt: string }[] = [];
  #sequence = 0;
  #stopping = false;
  #complete = false;
  #ready = false;
  #opening?: Promise<void>;
  #disposal?: Promise<void>;
  #reportFailure: unknown;
  constructor(
    readonly connection: string,
    readonly uri: string,
    readonly acquire: (member: ManagedMcpSubscription) => SubscriptionChannel,
    readonly release: (
      member: ManagedMcpSubscription,
      channel: SubscriptionChannel,
    ) => Promise<void>,
  ) {
    super();
    this.setMaxListeners(0);
    this.closed = this.#done.promise;
  }
  attach(ref: ResourceRef): void {
    this.#ref = ref;
  }
  open(): Promise<void> {
    requireCondition(
      !this.#opening && !this.#stopping,
      "mcp_subscription_closed",
      "The subscription cannot be opened again.",
    );
    this.#opening = (async () => {
      this.#channel = this.acquire(this);
      try {
        await this.#channel.ready;
        requireCondition(
          !this.#stopping,
          "mcp_subscription_closed",
          "The subscription closed while opening.",
        );
        this.#ready = true;
        this.#report();
      } catch (cause) {
        await this.dispose().catch(() => {});
        throw cause;
      }
    })();
    return this.#opening;
  }
  updated(): void {
    if (this.#stopping || this.#complete) return;
    this.#events.push({
      cursor: ++this.#sequence,
      uri: this.uri,
      receivedAt: new Date().toISOString(),
    });
    if (this.#events.length > 256) this.#events.shift();
    this.#report();
    this.emit("change");
  }
  #report(): void {
    try {
      this.#ref?.report({
        connection: this.connection,
        uri: this.uri,
        state: this.#complete
          ? "closed"
          : this.#stopping
            ? "stopping"
            : this.#ready
              ? "subscribed"
              : "opening",
        latestCursor: this.#sequence,
      });
    } catch (cause) {
      this.#reportFailure ??= cause;
      queueMicrotask(() => {
        void this.dispose().catch(() => {});
      });
    }
  }
  async read(
    cursor: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted();
    if (!this.#complete && this.#sequence <= cursor && waitMs > 0) {
      const waiting = AbortSignal.any([signal, AbortSignal.timeout(waitMs)]);
      try {
        await once(this, "change", { signal: waiting });
      } catch {
        signal.throwIfAborted();
      }
    }
    signal.throwIfAborted();
    return {
      uri: this.uri,
      state: this.#complete
        ? "closed"
        : this.#stopping
          ? "stopping"
          : this.#ready
            ? "subscribed"
            : "opening",
      events: this.#events.filter((item) => item.cursor > cursor),
      cursor: this.#sequence,
      historyLost:
        !!this.#events.length && cursor < this.#events[0]!.cursor - 1,
    };
  }
  channelClosed(): void {
    if (this.#complete) return;
    this.#complete = true;
    this.#report();
    this.#done.resolve();
    this.emit("change");
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#stopping = true;
    this.#disposal = (async () => {
      try {
        if (this.#channel) await this.release(this, this.#channel);
      } finally {
        this.channelClosed();
      }
      if (this.#reportFailure) throw this.#reportFailure;
    })();
    void this.#disposal.catch(() => {
      this.#disposal = undefined;
    });
    return this.#disposal;
  }
}

class McpConnection implements McpResourceReader {
  get connection(): string {
    return this.config.name;
  }
  readonly closed: Promise<void>;
  readonly client: Client;
  readonly transport: Transport;
  #control: ManagedResource;
  #wire: McpWire<Invocation>;
  #calls = new Set<Invocation>();
  #tasks?: TaskEnabledSession<Invocation>;
  #taskPending = new Map<Invocation, Set<Promise<unknown>>>();
  #creations = new WeakMap<Invocation, TaskCreation>();
  #knownTasks = new Map<string, TaskCreation>();
  #creationContext = new AsyncLocalStorage<TaskCreation>();
  #cleanupContext = new AsyncLocalStorage<boolean>();
  #subscriptions = new Map<string, SubscriptionChannel>();
  #taskPort?: ConnectedMcpSessionPort & Disposable;
  #http?: ManagedHttpTransport;
  #stdio?: ManagedStdioTransport;
  #ref?: ResourceRef;
  #ready = false;
  #stopping = false;
  #stale = false;
  #epoch = 0;
  #detach: (() => void)[] = [];
  #dispose?: Promise<void>;
  #catalog: McpCatalog | null = null;
  #initialFailure?: unknown;
  #physicallyClosed = false;
  constructor(
    readonly host: ExtensionHost,
    readonly config: McpConnectionConfig,
    readonly limits: Limits,
  ) {
    this.client = new Client(clientIdentity, {
      capabilities: limits.hostCapabilities as ClientCapabilities,
      // The official client otherwise selects its own default dialect for
      // outputSchema. Reuse the exact declared-dialect validator used by Core.
      jsonSchemaValidator: {
        getValidator<T>(schema: JsonSchemaType) {
          const validate = compileMethodSchema(schema, dialect(schema));
          return (input: unknown): JsonSchemaValidatorResult<T> => {
            try {
              validate(input);
              return {
                valid: true,
                data: input as T,
                errorMessage: undefined,
              };
            } catch {
              return {
                valid: false,
                data: undefined,
                errorMessage:
                  "The structured result does not match its declared schema.",
              };
            }
          };
        },
      },
      versionNegotiation: { mode: "auto" },
    });
    if (config.transport === "stdio") {
      const stdio = new ManagedStdioTransport(
        config,
        host,
        limits.maxMessageBytes,
        (facts) => {
          if (facts.rootExited) this.#ready = false;
          this.#ref?.report({
            connection: config.name,
            transport: config.transport,
            state: this.#ready
              ? "ready"
              : this.#stopping
                ? "stopping"
                : "connecting",
            ...facts,
          });
        },
        () => {
          const creation = this.#creationContext.getStore();
          if (creation) {
            creation.call.signal.throwIfAborted();
            creation.maybeStarted = true;
          }
        },
      );
      this.#stdio = stdio;
      this.#control = stdio;
      this.transport = stdio;
    } else {
      this.#http = new ManagedHttpTransport({
        url: config.url,
        headers: config.headers,
        authProvider: limits.authProviderFactory?.(host) ?? limits.authProvider,
        maxMessageBytes: limits.maxMessageBytes,
        authorize: (value) => {
          host.authorize({ type: "url", value, access: "connect" });
          const creation = this.#creationContext.getStore();
          if (creation) {
            creation.call.signal.throwIfAborted();
            creation.maybeStarted = true;
          }
        },
      });
      this.#control = this.#http;
      this.transport = this.#http.transport;
    }
    this.#wire = new McpWire<Invocation>(this.transport, {
      maxMessageBytes: limits.maxMessageBytes,
    });
    this.transport = this.#wire.transport;
    const send = this.transport.send.bind(this.transport);
    this.transport.send = (message, options) => {
      if ("method" in message && this.client.getProtocolEra() === "modern") {
        const params = isPlainRecord(message.params) ? message.params : {};
        const meta = isPlainRecord(params._meta) ? params._meta : {};
        message = {
          ...message,
          params: {
            ...params,
            _meta: { ...meta, ...this.#metadata(this.#wire.current()) },
          },
        } as typeof message;
      }
      return send(message, options);
    };
    this.closed = this.#control.closed.then(async () => {
      await Promise.allSettled(
        [...this.#subscriptions.values()].map((channel) => channel.stop()),
      );
      this.#wire.finish();
      this.#creationContext.disable();
      this.#cleanupContext.disable();
    });
    if (limits.hostCapabilities.sampling)
      this.client.setRequestHandler(
        "sampling/createMessage",
        (request, context) =>
          this.#hostRequest(
            request,
            context,
            "sampling",
          ) as Promise<CreateMessageResult>,
      );
    if (limits.hostCapabilities.elicitation)
      this.client.setRequestHandler(
        "elicitation/create",
        (request, context) =>
          this.#hostRequest(
            request,
            context,
            "elicitation",
          ) as Promise<ElicitResult>,
      );
    if (limits.hostCapabilities.roots)
      this.client.setRequestHandler(
        "roots/list",
        (request, context) =>
          this.#hostRequest(
            request,
            context,
            "roots",
          ) as Promise<ListRootsResult>,
      );
    void this.closed.then(() => {
      this.#physicallyClosed = true;
      this.#ready = false;
      for (const detach of this.#detach.splice(0)) detach();
    });
    this.client.setNotificationHandler(
      "notifications/resources/updated",
      async (notification) => {
        const channel = this.#subscriptions.get(notification.params.uri);
        if (channel?.acceptingUpdates && !channel.closing)
          for (const member of channel.members) member.updated();
      },
    );
    this.client.onerror = () =>
      host.log({
        level: "warn",
        message: "An MCP transport reported a protocol or I/O failure.",
        data: { connection: config.name },
      });
    this.client.onclose = () => {
      this.#ready = false;
    };
    for (const method of [
      "notifications/tools/list_changed",
      "notifications/resources/list_changed",
      "notifications/prompts/list_changed",
    ] as const)
      this.client.setNotificationHandler(method, async () => {
        this.#epoch++;
        this.#stale = true;
        this.#ref?.report({
          connection: config.name,
          transport: config.transport,
          state: "catalog-stale",
        });
      });
  }
  #hostCapabilities(call?: Invocation): JsonObject {
    const actual = call?.hostRequests?.capabilities;
    if (
      !actual ||
      this.#cleanupContext.getStore() ||
      call?.signal.aborted ||
      (call && this.#creations.get(call)?.stopping)
    )
      return {};
    const intersect = (left: unknown, right: unknown): unknown => {
      if (isPlainRecord(left) && isPlainRecord(right))
        return Object.fromEntries(
          Object.keys(left)
            .filter((key) => Object.hasOwn(right, key))
            .map((key) => [key, intersect(left[key], right[key])])
            .filter(([, value]) => value !== undefined),
        );
      return left === right ? left : undefined;
    };
    const capabilities: JsonObject = {};
    for (const key of ["sampling", "elicitation", "roots"] as const) {
      if (
        Object.hasOwn(this.limits.hostCapabilities, key) &&
        Object.hasOwn(actual, key)
      ) {
        if (key === "elicitation") {
          const left = getSupportedElicitationModes(
            this.limits.hostCapabilities
              .elicitation as ClientCapabilities["elicitation"],
          );
          const right = getSupportedElicitationModes(
            actual.elicitation as ClientCapabilities["elicitation"],
          );
          const modes: JsonObject = {};
          const l = this.limits.hostCapabilities.elicitation as JsonObject,
            r = actual.elicitation as JsonObject;
          if (left.supportsFormMode && right.supportsFormMode)
            modes.form = copyMcpJSON(intersect(l.form ?? {}, r.form ?? {}));
          if (left.supportsUrlMode && right.supportsUrlMode)
            modes.url = copyMcpJSON(intersect(l.url ?? {}, r.url ?? {}));
          if (Object.keys(modes).length) capabilities.elicitation = modes;
        } else {
          const value = intersect(
            this.limits.hostCapabilities[key],
            actual[key],
          );
          if (value !== undefined) capabilities[key] = copyMcpJSON(value);
        }
      }
    }
    return capabilities;
  }
  #metadata(call?: Invocation): JsonObject {
    return this.client.getProtocolEra() === "modern"
      ? {
          "io.modelcontextprotocol/clientCapabilities":
            this.#hostCapabilities(call),
        }
      : {};
  }
  #hostRequest(
    request: { method: string; params?: unknown },
    context: ClientContext,
    kind: "sampling" | "elicitation" | "roots",
  ): Promise<JsonObject> {
    // Legacy task-associated input has protocol evidence owned by ext-tasks.
    // Its public fallback performs correlation; an unrelated peer request is
    // rejected rather than borrowing whichever invocation happens to be active.
    if (
      !this.#wire.current() &&
      this.#tasks &&
      this.client.fallbackRequestHandler
    )
      return this.client.fallbackRequestHandler(
        request as never,
        context,
      ) as Promise<JsonObject>;
    return this.#hostInput(
      kind,
      (request.params ?? {}) as JsonObject,
      context.mcpReq.signal,
    );
  }
  async #hostInput(
    kind: "sampling" | "elicitation" | "roots",
    params: JsonObject,
    inputSignal: AbortSignal,
  ): Promise<JsonObject> {
    const call = this.#wire.current();
    requireCondition(
      call && this.#calls.has(call) && call.hostRequests,
      "mcp_input_unassociated",
      "The remote Host request has no verified active originating invocation.",
    );
    this.assertCurrent();
    call.signal.throwIfAborted();
    requireCondition(
      !this.#creations.get(call)?.stopping,
      "mcp_task_stopping",
      "The originating task is stopping and no longer accepts Host requests.",
    );
    inputSignal.throwIfAborted();
    call.hostRequests.assertCurrent();
    const capabilities = this.#hostCapabilities(call);
    requireCondition(
      Object.hasOwn(capabilities, kind),
      "mcp_host_capability_unavailable",
      "The original Host does not currently provide the requested capability.",
    );
    if (kind === "elicitation") {
      const modes = getSupportedElicitationModes(
        capabilities.elicitation as ClientCapabilities["elicitation"],
      );
      requireCondition(
        params.mode === "url" ? modes.supportsUrlMode : modes.supportsFormMode,
        "mcp_host_capability_unavailable",
        "The original Host does not support this elicitation mode.",
      );
    }
    if (
      kind === "sampling" &&
      (params.tools !== undefined || params.toolChoice !== undefined)
    )
      requireCondition(
        isPlainRecord(capabilities.sampling) &&
          capabilities.sampling.tools !== undefined,
        "mcp_host_capability_unavailable",
        "The original Host does not support sampling tools.",
      );
    call.authorize({
      type: "connection",
      value: this.config.name,
      access: `host.${kind}`,
    });
    const signal = AbortSignal.any([call.signal, inputSignal]);
    const input = copyMcpJSON(
      params,
      this.limits.maxMessageBytes,
    ) as JsonObject;
    const result =
      kind === "roots"
        ? await call.hostRequests.roots({ signal })
        : await call.hostRequests[kind](input, { signal });
    signal.throwIfAborted();
    call.hostRequests.assertCurrent();
    this.assertCurrent();
    call.authorize({
      type: "connection",
      value: this.config.name,
      access: `host.${kind}`,
    });
    return copyMcpJSON(result, this.limits.maxMessageBytes) as JsonObject;
  }
  #io<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return this.#http
      ? this.#http.run(signal, action)
      : this.#stdio!.run(signal, action);
  }
  #claimTask(creation: TaskCreation, id: string): void {
    const known = this.#knownTasks.get(id);
    if (known && known !== creation) {
      creation.malformedTask = true;
      throw new AgentError(
        "mcp_task_identity_conflict",
        "The server returned a task identity already owned by another active invocation.",
      );
    }
    creation.taskId = taskIdentity(id);
    this.#knownTasks.set(id, creation);
  }
  #setupTasks(): void {
    const capabilities = this.client.getServerCapabilities();
    if (
      !capabilities?.tasks &&
      !capabilities?.extensions?.["io.modelcontextprotocol/tasks"]
    )
      return;
    const native = createSessionPortFromClient(this.client, this.#ref!.id, {
      rawDispatch: (request, options) => {
        const value = copyMcpJSON(
          request,
          this.limits.maxMessageBytes,
        ) as JsonObject;
        const params = isPlainRecord(value.params)
          ? (value.params as JsonObject)
          : {};
        const meta = isPlainRecord(params._meta)
          ? (params._meta as JsonObject)
          : {};
        const actual = this.#hostCapabilities(this.#wire.current());
        // Tasks support belongs to this real extension port; reverse Host
        // capabilities still come from the one originating invocation.
        value.params = {
          ...params,
          _meta: {
            ...meta,
            "io.modelcontextprotocol/clientCapabilities": {
              ...actual,
              extensions: { "io.modelcontextprotocol/tasks": {} },
            },
          },
        };
        return this.#wire.rawDispatch(value, options);
      },
      v2RequestFraming: {
        protocolVersion: this.client.getNegotiatedProtocolVersion()!,
        clientInfo: clientIdentity,
        clientCapabilities: this.limits.hostCapabilities,
      },
    });
    this.#taskPort = native;
    const port: ConnectedMcpSessionPort = {
      endpointId: native.endpointId,
      taskCapabilities: native.taskCapabilities,
      get invalidated() {
        return native.invalidated;
      },
      onServerRequest: (handler) => native.onServerRequest(handler),
      onNotification: (handler) => native.onNotification(handler),
      onInvalidated: (handler) => native.onInvalidated(handler),
      dispatch: (request, options) => {
        this.host.signal.throwIfAborted();
        requireCondition(
          !this.#stopping && this.#ready,
          "mcp_connection_unavailable",
          "The original MCP Task connection is unavailable.",
        );
        this.host.authorize({
          type: "connection",
          value: this.config.name,
          access:
            isPlainRecord(request) && typeof request.method === "string"
              ? request.method
              : "tasks.use",
        });
        const owner = this.#wire.current();
        const creation =
          isPlainRecord(request) && request.method === "tools/call" && owner
            ? this.#creations.get(owner)
            : undefined;
        const method = isPlainRecord(request) ? request.method : undefined;
        const params =
          isPlainRecord(request) && isPlainRecord(request.params)
            ? request.params
            : undefined;
        const cleanup = this.#cleanupContext.getStore() === true;
        if (owner && !owner.signal.aborted && !cleanup)
          owner.authorize({
            type: "connection",
            value: this.config.name,
            access: typeof method === "string" ? method : "tasks.use",
          });
        if (
          owner &&
          (owner.signal.aborted ||
            this.#creations.get(owner)?.stopping ||
            cleanup)
        )
          requireCondition(
            ["tasks/get", "tasks/result", "tasks/cancel"].includes(
              method as string,
            ) &&
              typeof params?.taskId === "string" &&
              this.#knownTasks.has(params.taskId),
            "mcp_task_stopping",
            "Only known-task observation and cancellation may continue during cleanup.",
          );
        if (!owner)
          requireCondition(
            ["tasks/get", "tasks/result", "tasks/cancel"].includes(
              method as string,
            ) &&
              typeof params?.taskId === "string" &&
              this.#knownTasks.has(params.taskId),
            "mcp_task_unassociated",
            "An unassociated task operation cannot use this connection.",
          );
        if (creation) creation.call.signal.throwIfAborted();
        const perform = () =>
          this.#io(
            creation && this.#stdio
              ? creation.call.signal
              : (options?.signal ?? this.host.signal),
            () => native.dispatch(request, options),
          );
        if (creation) creation.awaitingResponse = true;
        const pending = creation
          ? this.#creationContext.run(creation, perform).then((response) => {
              creation.awaitingResponse = false;
              if (response.kind === "result") {
                if (native.taskCapabilities.generation === "v2") {
                  const task = CreateTaskResultV2Schema.safeParse(
                    response.result,
                  );
                  if (task.success) {
                    this.#claimTask(creation, task.data.taskId);
                  } else if (
                    isPlainRecord(response.result) &&
                    response.result.resultType === "task"
                  )
                    creation.malformedTask = true;
                } else {
                  const task = CreateTaskResultV1Schema.safeParse(
                    response.result,
                  );
                  if (task.success) {
                    this.#claimTask(creation, task.data.task.taskId);
                  } else if (
                    isPlainRecord(response.result) &&
                    Object.hasOwn(response.result, "task")
                  )
                    creation.malformedTask = true;
                }
              }
              return response;
            })
          : perform();
        if (owner) {
          let group = this.#taskPending.get(owner);
          if (!group) this.#taskPending.set(owner, (group = new Set()));
          group.add(pending);
          void pending.then(
            () => group!.delete(pending),
            () => group!.delete(pending),
          );
        }
        return pending;
      },
    };
    this.#tasks = withTasks<Invocation>(port, {
      signal: this.host.signal,
      maxInputRounds: 10,
      tools: {
        currentTool: (name) => {
          const tool = this.#catalog!.tools.find((item) => item.name === name);
          return tool ? toolDeclarationFromMcpTool(tool) : undefined;
        },
      },
      onInputRequest: async (request, context) => {
        const call = context.applicationContext;
        requireCondition(
          call && this.#calls.has(call),
          "mcp_input_unassociated",
          "Task input has no verified originating invocation.",
        );
        return (await this.#wire.run(call, () =>
          this.#hostInput(
            request.kind,
            copyMcpJSON(request.params ?? {}) as JsonObject,
            context.signal ?? call.signal,
          ),
        )) as never;
      },
      onError: () =>
        this.host.log({
          level: "warn",
          message: "The MCP Tasks adapter reported a protocol error.",
          data: { connection: this.config.name },
        }),
    });
  }
  async #drainTasks(call: Invocation): Promise<void> {
    const group = this.#taskPending.get(call);
    while (group?.size) await Promise.allSettled([...group]);
    if (this.#taskPending.get(call) === group) this.#taskPending.delete(call);
  }
  async #withCall<T>(call: Invocation, action: () => Promise<T>): Promise<T> {
    this.#calls.add(call);
    try {
      return await this.#wire.run(call, action);
    } catch (cause) {
      call.signal.throwIfAborted();
      throw cause instanceof AgentError ? cause : publicError(cause, "call");
    } finally {
      await this.#drainTasks(call);
      this.#calls.delete(call);
      this.#wire.release(call);
      this.#creations.delete(call);
    }
  }
  attach(ref: ResourceRef): void {
    this.#ref = ref;
    for (const signal of [this.host.signal, ref.signal]) {
      const subscription = addAbortListener(signal, () => {
        void this.dispose(signal.reason).catch(() => {});
      });
      this.#detach.push(() => subscription[Symbol.dispose]());
    }
  }
  async connect(): Promise<void> {
    requireCondition(
      this.#ref && !this.#stopping,
      "mcp_connection_closed",
      "The MCP resource must be registered before connection.",
    );
    this.host.authorize({
      type: "connection",
      value: this.config.name,
      access: "connect",
    });
    const timer = setTimeout(() => {
      this.#initialFailure = new AgentError(
        "mcp_connect_timeout",
        "The MCP connection or catalog exceeded its initialization deadline.",
      );
      void this.dispose(this.#initialFailure).catch(() => {});
    }, this.limits.connectTimeoutMs);
    try {
      await this.client.connect(this.transport, {
        timeout: this.limits.connectTimeoutMs,
      });
      const epoch = this.#epoch;
      const capabilities = this.client.getServerCapabilities() ?? {};
      const budget = { bytes: 0, items: 0 };
      const tools = capabilities.tools
        ? ((await this.#collect("tools/list", "tools", budget)) as Tool[])
        : [];
      const resources = capabilities.resources
        ? ((await this.#collect(
            "resources/list",
            "resources",
            budget,
          )) as Resource[])
        : [];
      const resourceTemplates = capabilities.resources
        ? ((await this.#collect(
            "resources/templates/list",
            "resourceTemplates",
            budget,
          )) as ResourceTemplateType[])
        : [];
      const prompts = capabilities.prompts
        ? ((await this.#collect("prompts/list", "prompts", budget)) as Prompt[])
        : [];
      requireCondition(
        epoch === this.#epoch,
        "mcp_catalog_changed",
        "The MCP catalog changed while it was being prepared.",
      );
      const header = {
        server: publicMetadata(this.client.getServerVersion() ?? null),
        capabilities: Object.fromEntries(
          Object.entries(capabilities)
            .filter(([key]) => key !== "_meta")
            .map(([key, value]) => [key, publicMetadata(value)]),
        ),
        instructions: this.client.getInstructions() ?? null,
        protocolVersion: this.client.getNegotiatedProtocolVersion() ?? null,
      };
      requireCondition(
        budget.bytes +
          Buffer.byteLength(
            canonicalJson(header, this.limits.maxCatalogBytes),
          ) <=
          this.limits.maxCatalogBytes,
        "mcp_catalog_too_large",
        "MCP catalog metadata exceeds its byte budget.",
      );
      this.#catalog = deepFreeze({
        name: this.config.name,
        transport: this.config.transport,
        instanceId: this.#ref!.id,
        revision: this.limits.revision ?? null,
        ready: true,
        stale: false,
        ...header,
        tools,
        resources,
        resourceTemplates,
        prompts,
      });
      this.#setupTasks();
      this.#initialCurrent("connect");
      this.#stale = false;
      this.#ready = true;
      this.#ref!.report({
        connection: this.config.name,
        transport: this.config.transport,
        state: "ready",
        toolCount: tools.length,
        resourceCount: resources.length,
        promptCount: prompts.length,
        protocolVersion: header.protocolVersion,
      });
    } catch (cause) {
      await this.dispose(cause);
      throw (
        this.#initialFailure ??
        (cause instanceof AgentError
          ? cause
          : publicError(cause, "initialization"))
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async #collect(
    method:
      | "tools/list"
      | "resources/list"
      | "resources/templates/list"
      | "prompts/list",
    field: string,
    budget: { bytes: number; items: number },
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const identities = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const result = (await this.#request(
        method,
        cursor === undefined ? {} : { cursor },
        this.host.signal,
        this.limits.connectTimeoutMs,
        false,
      )) as Record<string, unknown>;
      budget.bytes += Buffer.byteLength(
        canonicalJson(result, this.limits.maxCatalogBytes),
      );
      requireCondition(
        budget.bytes <= this.limits.maxCatalogBytes &&
          Array.isArray(result[field]),
        "mcp_catalog_too_large",
        "An MCP catalog page is invalid or exceeds its byte budget.",
      );
      for (const item of result[field] as unknown[]) {
        requireCondition(
          isPlainRecord(item),
          "invalid_mcp_catalog",
          "MCP catalog entries must be data objects.",
        );
        const identity =
          item[
            field === "resources"
              ? "uri"
              : field === "resourceTemplates"
                ? "uriTemplate"
                : "name"
          ];
        requireCondition(
          typeof identity === "string" &&
            identity.length > 0 &&
            Buffer.byteLength(identity) <= 1024 &&
            !/[\0\r\n]/.test(identity) &&
            !identities.has(identity),
          "invalid_mcp_catalog",
          "An MCP catalog has an invalid or duplicate original identity.",
        );
        identities.add(identity);
        if (field === "tools") {
          compileMethodSchema(item.inputSchema, dialect(item.inputSchema));
          if (item.outputSchema !== undefined)
            compileMethodSchema(item.outputSchema, dialect(item.outputSchema));
        }
        requireCondition(
          ++budget.items <= this.limits.maxCatalogItems,
          "mcp_catalog_too_large",
          "The MCP catalog exceeds its item budget.",
        );
        items.push(item);
      }
      if (result.nextCursor === undefined) return items;
      requireCondition(
        typeof result.nextCursor === "string" &&
          result.nextCursor.length > 0 &&
          Buffer.byteLength(result.nextCursor) <= 4096 &&
          !cursors.has(result.nextCursor),
        "invalid_mcp_catalog",
        "MCP pagination returned an invalid or repeated cursor.",
      );
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new AgentError(
      "mcp_catalog_too_large",
      "The MCP catalog exceeds its page budget.",
    );
  }
  catalog(): McpCatalog | null {
    if (!this.#catalog) return null;
    const visible = (
      method:
        | "tools/list"
        | "resources/list"
        | "resources/templates/list"
        | "prompts/list",
      field: string,
      items: readonly unknown[],
    ) =>
      (
        projectMcpProtocolResult({ [field]: items }, method)
          .structuredContent as JsonObject
      )[field];
    return deepFreeze({
      ...this.#catalog,
      tools: visible("tools/list", "tools", this.#catalog.tools),
      resources: visible(
        "resources/list",
        "resources",
        this.#catalog.resources,
      ),
      resourceTemplates: visible(
        "resources/templates/list",
        "resourceTemplates",
        this.#catalog.resourceTemplates,
      ),
      prompts: visible("prompts/list", "prompts", this.#catalog.prompts),
      ready: this.#ready && !this.#stopping && !this.#stale,
      stale: this.#stale,
    }) as unknown as McpCatalog;
  }
  assertCurrent(): void {
    requireCondition(
      this.#ready && !this.#stopping && !this.#stale,
      "mcp_connection_unavailable",
      "The original MCP instance is unavailable or needs a catalog refresh.",
    );
    this.host.authorize({
      type: "connection",
      value: this.config.name,
      access: "use",
    });
  }
  #initialCurrent(access: string): void {
    this.host.signal.throwIfAborted();
    this.#ref?.signal.throwIfAborted();
    requireCondition(
      !this.#stopping && !this.#initialFailure,
      "mcp_connection_closed",
      "The MCP initialization is no longer active.",
    );
    this.host.authorize({
      type: "connection",
      value: this.config.name,
      access,
    });
  }
  #requestOptions(signal: AbortSignal, timeout: number): RequestOptions {
    return { signal, timeout, maxTotalTimeout: timeout };
  }
  async #request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeout: number,
    requireReady = true,
  ): Promise<unknown> {
    if (requireReady) this.assertCurrent();
    else this.#initialCurrent(method);
    this.host.authorize({
      type: "connection",
      value: this.config.name,
      access: method,
    });
    signal.throwIfAborted();
    canonicalJson(params, this.limits.maxMessageBytes);
    const action = () =>
      this.client.request(
        {
          method: method as "tools/list",
          params: { ...params, _meta: this.#metadata(this.#wire.current()) },
        },
        this.#requestOptions(signal, timeout),
      );
    try {
      const result = await (this.#http
        ? this.#http.run(signal, action)
        : this.#stdio!.run(signal, action));
      signal.throwIfAborted();
      if (requireReady) this.assertCurrent();
      else this.#initialCurrent(method);
      this.host.authorize({
        type: "connection",
        value: this.config.name,
        access: method,
      });
      return result;
    } catch (cause) {
      signal.throwIfAborted();
      throw cause instanceof AgentError ? cause : publicError(cause, "request");
    }
  }
  invoke(
    method: RemoteMethod,
    params: Record<string, unknown>,
    call: Invocation,
    tool?: Tool,
  ): Promise<unknown> {
    return this.#withCall(call, () => this.#invoke(method, params, call, tool));
  }
  async #invoke(
    method: RemoteMethod,
    params: Record<string, unknown>,
    call: Invocation,
    tool?: Tool,
  ): Promise<unknown> {
    this.assertCurrent();
    call.authorize({
      type: "connection",
      value: this.config.name,
      access: method,
    });
    this.host.authorize({
      type: "connection",
      value: this.config.name,
      access: method,
    });
    if (this.config.transport === "streamable-http")
      call.authorize({
        type: "url",
        value: this.config.url,
        access: "request",
      });
    if (method === "resources/read")
      call.authorize({
        type: "resource",
        value: params.uri as string,
        access: "read",
      });
    requireCondition(
      call.deadline > Date.now(),
      "deadline_exceeded",
      "The MCP operation deadline has already expired.",
    );
    const timeout = Math.max(
      1,
      Math.min(
        this.limits.requestTimeoutMs,
        Math.ceil(call.deadline - Date.now()),
        maximumTimeout,
      ),
    );
    call.signal.throwIfAborted();
    if (tool) {
      canonicalJson(params, this.limits.maxMessageBytes);
      if (this.#tasks?.capabilities.execution)
        return this.#invokeTask(tool, params, call, timeout);
      const action = () =>
        this.client.callTool(
          { name: tool.name, arguments: params, _meta: this.#metadata(call) },
          {
            ...this.#requestOptions(call.signal, timeout),
            toolDefinition: this.#catalog!.tools.find(
              (item) => item.name === tool.name,
            )!,
          },
        );
      try {
        const raw = await (this.#http
          ? this.#http.run(call.signal, action)
          : this.#stdio!.run(call.signal, action));
        call.signal.throwIfAborted();
        this.assertCurrent();
        this.host.authorize({
          type: "connection",
          value: this.config.name,
          access: method,
        });
        return call.output.mcpResult(raw, {
          connectionResourceId: this.#ref!.id,
          connection: this.config.name,
        });
      } catch (cause) {
        call.signal.throwIfAborted();
        throw cause instanceof AgentError
          ? cause
          : publicError(cause, "tool call");
      }
    }
    const raw = await this.#request(method, params, call.signal, timeout);
    this.assertCurrent();
    if (method === "resources/read")
      return call.output.mcpResourceResult(raw, {
        connectionResourceId: this.#ref!.id,
        connection: this.config.name,
      });
    return call.output.mcpResult(raw, {
      connectionResourceId: this.#ref!.id,
      connection: this.config.name,
      method,
    });
  }
  #channel(uri: string, member: ManagedMcpSubscription): SubscriptionChannel {
    const existing = this.#subscriptions.get(uri);
    if (existing && !existing.closing) {
      existing.members.add(member);
      return existing;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([this.host.signal, abort.signal]);
    const ready = Promise.withResolvers<void>(),
      closed = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    let running: Promise<void>,
      closing = false,
      active = false,
      acceptingUpdates = false;
    const channel: SubscriptionChannel = {
      uri,
      members: new Set([member]),
      ready: ready.promise,
      closed: closed.promise,
      get closing() {
        return closing;
      },
      get active() {
        return active;
      },
      get acceptingUpdates() {
        return acceptingUpdates;
      },
      stop: async () => {
        closing = true;
        active = false;
        acceptingUpdates = false;
        abort.abort();
        try {
          await running;
        } catch (cause) {
          throw cause instanceof AgentError
            ? cause
            : publicError(cause, "subscription cleanup");
        }
      },
    };
    this.#subscriptions.set(uri, channel);
    running = this.#wire.run(undefined, async () => {
      let attempted = false;
      try {
        // The old legacy unsubscribe must settle before a replacement subscribe;
        // otherwise its late ACK can clear the newly accepted subscription.
        if (existing) await existing.stop();
        signal.throwIfAborted();
        this.host.authorize({
          type: "connection",
          value: this.config.name,
          access: "resources.subscribe",
        });
        this.host.authorize({
          type: "resource",
          value: uri,
          access: "subscribe",
        });
        acceptingUpdates = true;
        if (this.client.getProtocolEra() === "modern") {
          await this.#io(signal, async () => {
            const subscription = await this.client.listen(
              { resourceSubscriptions: [uri] },
              {
                signal,
                timeout: Math.min(this.limits.requestTimeoutMs, 10000),
              },
            );
            try {
              requireCondition(
                subscription.honoredFilter.resourceSubscriptions?.includes(uri),
                "mcp_subscription_rejected",
                "The MCP server did not honor this resource subscription.",
              );
              active = true;
              ready.resolve();
              await subscription.closed;
            } finally {
              await subscription.close();
            }
          });
        } else {
          attempted = true;
          await this.#io(signal, () =>
            this.client.subscribeResource(
              { uri },
              {
                signal,
                timeout: Math.min(this.limits.requestTimeoutMs, 10000),
              },
            ),
          );
          active = true;
          ready.resolve();
          if (!signal.aborted) await once(signal, "abort");
        }
      } catch (cause) {
        ready.reject(cause);
        throw cause;
      } finally {
        active = false;
        acceptingUpdates = false;
        closing = true;
        try {
          if (attempted && !this.host.signal.aborted) {
            const stopSignal = AbortSignal.any([
              this.host.signal,
              AbortSignal.timeout(5000),
            ]);
            this.host.authorize({
              type: "connection",
              value: this.config.name,
              access: "resources.unsubscribe",
            });
            await this.#io(stopSignal, () =>
              this.client.unsubscribeResource(
                { uri },
                { signal: stopSignal, timeout: 5000 },
              ),
            );
          }
        } finally {
          if (this.#subscriptions.get(uri) === channel)
            this.#subscriptions.delete(uri);
          closed.resolve();
          for (const listener of channel.members) listener.channelClosed();
          channel.members.clear();
        }
      }
    });
    void running.catch(() => {});
    return channel;
  }
  subscriptionControl(
    action: "subscribe" | "get" | "unsubscribe",
    input: Record<string, unknown>,
    call: Invocation,
  ): Promise<unknown> {
    return this.#withCall(call, async () => {
      this.host.signal.throwIfAborted();
      call.signal.throwIfAborted();
      call.authorize({
        type: "connection",
        value: this.config.name,
        access: `resources.${action}`,
      });
      if (action === "subscribe") {
        this.assertCurrent();
        const uri = input.uri as string;
        call.authorize({ type: "resource", value: uri, access: "subscribe" });
        const member = new ManagedMcpSubscription(
          this.config.name,
          uri,
          (item) => this.#channel(uri, item),
          async (item, channel) => {
            channel.members.delete(item);
            if (!channel.members.size) await channel.stop();
          },
        );
        const ref = await call.resources.register({
          kind: "mcp.subscription",
          value: member,
        });
        member.attach(ref);
        try {
          await member.open();
          call.signal.throwIfAborted();
          if (input.background === true) await call.resources.handoff(ref.id);
          return {
            subscriptionId: ref.id,
            uri,
            background: input.background === true,
          };
        } catch (cause) {
          await member.dispose().catch(() => {});
          throw cause;
        }
      }
      const ref = await call.resources.get(input.subscriptionId as string);
      requireCondition(
        ref.kind === "mcp.subscription" &&
          ref.value instanceof ManagedMcpSubscription &&
          ref.value.connection === this.config.name,
        "mcp_subscription_unavailable",
        "The resource is not a subscription owned by this original connection.",
      );
      call.authorize({
        type: "resource",
        value: ref.value.uri,
        access: action === "get" ? "read" : "unsubscribe",
      });
      if (action === "unsubscribe") {
        await ref.value.dispose();
        return { subscriptionId: ref.id, state: "closed" };
      }
      return {
        subscriptionId: ref.id,
        ...(await ref.value.read(
          (input.cursor as number | undefined) ?? 0,
          (input.waitMs as number | undefined) ?? 0,
          call.signal,
        )),
      };
    });
  }
  supportsTasks(): boolean {
    return !!this.#tasks?.capabilities.execution;
  }
  taskControl(
    action: "get" | "cancel" | "list",
    input: Record<string, unknown>,
    call: Invocation,
  ): Promise<unknown> {
    return this.#withCall(call, async () => {
      this.host.signal.throwIfAborted();
      call.signal.throwIfAborted();
      call.authorize({
        type: "connection",
        value: this.config.name,
        access: `tasks.${action}`,
      });
      if (action === "list") {
        const page = await call.resources.list({
          kind: "mcp.task",
          ...(input.limit === undefined
            ? {}
            : { limit: input.limit as number }),
          ...(input.cursor === undefined
            ? {}
            : { cursor: input.cursor as string }),
          ...(input.status === undefined
            ? {}
            : { state: input.status as string }),
        });
        return {
          ...page,
          items: page.items.filter(
            (item) => item.details.connection === this.config.name,
          ),
        };
      }
      const ref = await call.resources.get(input.resourceId as string);
      requireCondition(
        ref.kind === "mcp.task" &&
          ref.value instanceof ManagedMcpExecution &&
          ref.value.connection === this.config.name,
        "mcp_task_unavailable",
        "The resource is not a task owned by this original MCP connection.",
      );
      if (action === "cancel") {
        await ref.value.dispose();
        return { resourceId: ref.id, ...ref.value.facts() };
      }
      return { resourceId: ref.id, ...(await ref.value.snapshot(call.signal)) };
    });
  }
  async #invokeTask(
    tool: Tool,
    params: Record<string, unknown>,
    call: Invocation,
    timeout: number,
  ): Promise<unknown> {
    const creation: TaskCreation = {
      call,
      maybeStarted: false,
      awaitingResponse: false,
      malformedTask: false,
      stopping: false,
    };
    this.#creations.set(call, creation);
    const controller = new ManagedMcpExecution(
      this.#tasks!,
      call,
      this.config.name,
      async () => {
        this.assertCurrent();
        call.signal.throwIfAborted();
        return this.#tasks!.callTool(tool.name, params as JsonObject, {
          declaration: toolDeclarationFromMcpTool(tool),
          applicationContext: call,
          signal: this.host.signal,
          metadata: this.#metadata(call),
          requestTimeoutMs: timeout,
        });
      },
      () => this.#drainTasks(call),
      creation,
      (action) =>
        this.#cleanupContext.run(true, () => this.#wire.run(call, action)),
    );
    const ref = await call.resources.register({
      kind: "mcp.task",
      value: controller,
    });
    controller.attach(ref);
    void controller.closed.then(() => {
      if (creation.taskId && this.#knownTasks.get(creation.taskId) === creation)
        this.#knownTasks.delete(creation.taskId);
    });
    const raw = await controller.execute();
    if (
      tool.outputSchema !== undefined &&
      isPlainRecord(raw) &&
      raw.isError !== true
    ) {
      requireCondition(
        Object.hasOwn(raw, "structuredContent"),
        "invalid_mcp_result",
        "The task result omitted its declared structured content.",
      );
      compileMethodSchema(
        tool.outputSchema,
        dialect(tool.outputSchema),
      )(raw.structuredContent);
    }
    call.signal.throwIfAborted();
    this.assertCurrent();
    return call.output.mcpResult(raw, {
      connectionResourceId: this.#ref!.id,
      connection: this.config.name,
    });
  }
  readResource(uri: string, scope: McpReadScope): Promise<unknown> {
    this.assertCurrent();
    scope.assertCurrent();
    scope.authorizeConnection(this.config.name, uri, "resources.read");
    this.host.authorize({ type: "resource", value: uri, access: "read" });
    const signal = scope.signal ?? this.host.signal;
    return this.#request(
      "resources/read",
      { uri },
      signal,
      this.limits.requestTimeoutMs,
    ).then((result) => {
      scope.assertCurrent();
      scope.authorizeConnection(this.config.name, uri, "resources.read");
      this.assertCurrent();
      return result;
    });
  }
  listResources(scope: McpReadScope, cursor?: string): Promise<unknown> {
    this.assertCurrent();
    scope.assertCurrent();
    scope.authorizeConnection(this.config.name, undefined, "resources.list");
    return this.#request(
      "resources/list",
      cursor === undefined ? {} : { cursor },
      scope.signal ?? this.host.signal,
      this.limits.requestTimeoutMs,
    ).then((result) => {
      scope.assertCurrent();
      this.assertCurrent();
      return result;
    });
  }
  dispose(reason?: unknown): Promise<void> {
    if (this.#dispose) return this.#dispose;
    this.#stopping = true;
    this.#ready = false;
    let reportFailure: unknown;
    if (!this.#physicallyClosed) {
      try {
        this.#ref?.report({
          connection: this.config.name,
          transport: this.config.transport,
          state: "stopping",
        });
      } catch (cause) {
        reportFailure = cause;
      }
    }
    this.#dispose = (async () => {
      await this.#control.dispose(reason);
      await this.closed;
      await this.#tasks?.close();
      this.#taskPort?.[Symbol.dispose]();
      if (reportFailure) throw reportFailure;
    })();
    void this.#dispose.catch(() => {
      this.#dispose = undefined;
    });
    return this.#dispose;
  }
}

/** A trusted, approved final config becomes one public extension instance. */
export function createMcpAdapter(
  value: McpConnectionConfig,
  options: McpAdapterOptions = {},
): {
  readonly factory: ExtensionFactory;
  readonly bindingPath: readonly ["mcp", string];
  readonly permissions: typeof allPermissions;
  catalog(): McpCatalog | null;
} {
  const config = validateMcpConnectionConfig(value),
    limits = optionsSnapshot(options);
  let connection: McpConnection | undefined;
  const factory: ExtensionFactory = async (host) => {
    requireCondition(
      !connection,
      "mcp_adapter_in_use",
      "Create a new adapter for each MCP source instance.",
    );
    const current = new McpConnection(host, config, limits);
    connection = current;
    try {
      const ref = await host.resources.register({
        kind: "mcp.connection",
        value: current,
      });
      current.attach(ref);
      await current.connect();
      const catalog = current.catalog()!;
      const methods: Record<string, MethodDefinition> = Object.create(null);
      const define = (
        key: string,
        path: readonly string[],
        description: string,
        inputSchema: unknown,
        handler: MethodDefinition["handle"],
        schemaDialect: SchemaDialect = "2020-12",
      ) => {
        methods[key] = {
          path,
          description,
          permissions: allPermissions,
          inputSchema,
          schemaDialect,
          normalize: (args) => {
            requireCondition(
              args.length <= 1,
              "invalid_arguments",
              "MCP methods take one argument object.",
            );
            // Snapshot JSON before Core validates it. Guest mutation while
            // the official client awaits metadata must not change a checked call.
            return deepFreeze(
              copyMcpJSON(args[0] ?? {}, limits.maxMessageBytes),
            );
          },
          handle: handler,
        };
      };
      for (const tool of catalog.tools)
        define(
          `tools/${tool.name}`,
          ["tools", tool.name],
          tool.description ?? `Call MCP tool ${tool.name}.`,
          tool.inputSchema,
          (input, call) => current.invoke("tools/call", input, call, tool),
          dialect(tool.inputSchema),
        );
      if ((catalog.capabilities as { resources?: unknown }).resources) {
        define(
          "resources/list",
          ["resources", "list"],
          "List one page of the remote MCP resource catalog.",
          pageSchema,
          (input, call) => current.invoke("resources/list", input, call),
        );
        define(
          "resources/listTemplates",
          ["resources", "listTemplates"],
          "List one page of remote MCP resource templates.",
          pageSchema,
          (input, call) =>
            current.invoke("resources/templates/list", input, call),
        );
        define(
          "resources/read",
          ["resources", "read"],
          "Read a remote resource through the current MCP connection.",
          readSchema,
          (input, call) => current.invoke("resources/read", input, call),
        );
      }
      if (
        (catalog.capabilities as { resources?: { subscribe?: boolean } })
          .resources?.subscribe
      ) {
        define(
          "resources/subscribe",
          ["resources", "subscribe"],
          "Subscribe to real resource updates; ordinary ownership ends with the run unless explicitly handed off.",
          {
            type: "object",
            additionalProperties: false,
            required: ["uri"],
            properties: {
              uri: { type: "string", minLength: 1, maxLength: 1024 },
              background: { type: "boolean" },
            },
          },
          (input, call) =>
            current.subscriptionControl("subscribe", input, call),
        );
        define(
          "resources/getSubscription",
          ["resources", "getSubscription"],
          "Read bounded subscription notifications using a stable resource identity.",
          {
            type: "object",
            additionalProperties: false,
            required: ["subscriptionId"],
            properties: {
              subscriptionId: { type: "string", minLength: 1, maxLength: 256 },
              cursor: { type: "integer", minimum: 0 },
              waitMs: { type: "integer", minimum: 0, maximum: 30000 },
            },
          },
          (input, call) => current.subscriptionControl("get", input, call),
        );
        define(
          "resources/unsubscribe",
          ["resources", "unsubscribe"],
          "Stop one registered resource subscription and wait for its actual local closure.",
          {
            type: "object",
            additionalProperties: false,
            required: ["subscriptionId"],
            properties: {
              subscriptionId: { type: "string", minLength: 1, maxLength: 256 },
            },
          },
          (input, call) =>
            current.subscriptionControl("unsubscribe", input, call),
        );
      }
      if ((catalog.capabilities as { prompts?: unknown }).prompts) {
        define(
          "prompts/list",
          ["prompts", "list"],
          "List one page of the remote MCP prompt catalog.",
          pageSchema,
          (input, call) => current.invoke("prompts/list", input, call),
        );
        define(
          "prompts/get",
          ["prompts", "get"],
          "Read a prompt, preserving message roles and standard media content.",
          getPromptSchema,
          (input, call) => current.invoke("prompts/get", input, call),
        );
      }
      if (current.supportsTasks()) {
        const resource = { type: "string", minLength: 1, maxLength: 256 };
        for (const action of ["get", "cancel"] as const)
          define(
            `tasks/${action}`,
            ["tasks", action],
            `Read or stop a Nexum-managed remote task using its resource identity.`,
            {
              type: "object",
              additionalProperties: false,
              required: ["resourceId"],
              properties: { resourceId: resource },
            },
            (input, call) => current.taskControl(action, input, call),
          );
        define(
          "tasks/list",
          ["tasks", "list"],
          "List retained Nexum-managed task resources for this connection.",
          {
            type: "object",
            additionalProperties: false,
            properties: {
              status: { type: "string", maxLength: 64 },
              limit: { type: "integer", minimum: 1, maximum: 100 },
              cursor: { type: "string", maxLength: 8192 },
            },
          },
          (input, call) => current.taskControl("list", input, call),
        );
      }
      return { methods, dispose: () => current.dispose() };
    } catch (cause) {
      await current.dispose(cause);
      throw cause;
    }
  };
  return Object.freeze({
    factory,
    bindingPath: Object.freeze(["mcp", config.name] as const),
    permissions: allPermissions,
    catalog: () => connection?.catalog() ?? null,
  });
}
