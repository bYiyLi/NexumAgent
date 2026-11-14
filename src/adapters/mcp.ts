import { addAbortListener } from "node:events";
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

type Limits = Required<Omit<McpAdapterOptions, "revision">> &
  Pick<McpAdapterOptions, "revision">;
function configuration(value: unknown): McpConnectionConfig {
  const input = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  requireCondition(
    isPlainRecord(input),
    "invalid_mcp_config",
    "An MCP connection needs a configuration object.",
  );
  requireCondition(
    typeof input.name === "string" &&
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.name),
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
  const fixed = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
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
  return Object.freeze(result);
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

class McpConnection implements McpResourceReader {
  get connection(): string {
    return this.config.name;
  }
  readonly closed: Promise<void>;
  readonly client: Client;
  readonly transport: Transport;
  #control: ManagedResource;
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
      capabilities: {},
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
      );
      this.#stdio = stdio;
      this.#control = stdio;
      this.transport = stdio;
    } else {
      this.#http = new ManagedHttpTransport({
        url: config.url,
        headers: config.headers,
        maxMessageBytes: limits.maxMessageBytes,
        authorize: (value) =>
          host.authorize({ type: "url", value, access: "connect" }),
      });
      this.#control = this.#http;
      this.transport = this.#http.transport;
    }
    this.closed = this.#control.closed;
    void this.closed.then(() => {
      this.#physicallyClosed = true;
      this.#ready = false;
      for (const detach of this.#detach.splice(0)) detach();
    });
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
        { method: method as "tools/list", params },
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
  async invoke(
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
      const action = () =>
        this.client.callTool(
          { name: tool.name, arguments: params },
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
  const config = configuration(value),
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
