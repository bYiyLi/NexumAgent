import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import type {
  DispatchOptions,
  JsonRpcResponse,
  RawClientDispatch,
} from "@modelcontextprotocol/ext-tasks/client";
import type { JsonValue } from "@modelcontextprotocol/ext-tasks/core";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";

const rawPrefix = "nexum_raw_";
const maxTimer = 2_147_483_647;

type RawOutcome =
  | { readonly ok: true; readonly response: JsonRpcResponse }
  | { readonly ok: false; readonly error: unknown };
interface RawPending<T> {
  context: T | undefined;
  outcome?: RawOutcome;
  finish(outcome: RawOutcome): boolean;
  abort(reason: unknown): void;
  progressToken?: string | number;
  progress?(): void;
}

/**
 * One cold public transport, borrowed by both the SDK and the Tasks extension.
 * This coordinates wire requests only: task driving and state remain owned by
 * ext-tasks. SDK numeric IDs and raw UUID IDs never share a pending entry.
 */
export class McpWire<T extends object> {
  readonly transport: Transport;
  readonly rawDispatch: RawClientDispatch;
  #base: Transport;
  #context = new AsyncLocalStorage<T | undefined>();
  #sdk = new Map<RequestId, T | undefined>();
  #raw = new Map<string, RawPending<T>>();
  #maxBytes: number;
  #maxPending: number;
  #closing = false;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(
    base: Transport,
    options: { readonly maxMessageBytes: number; readonly maxPending?: number },
  ) {
    requireCondition(
      Number.isSafeInteger(options.maxMessageBytes) &&
        options.maxMessageBytes > 0 &&
        options.maxMessageBytes <= 128 * 1024 * 1024 &&
        Number.isSafeInteger(options.maxPending ?? 256) &&
        (options.maxPending ?? 256) > 0 &&
        (options.maxPending ?? 256) <= 65_536,
      "invalid_mcp_config",
      "MCP wire message and pending-request limits must be bounded positive integers.",
    );
    this.#base = base;
    this.#maxBytes = options.maxMessageBytes;
    this.#maxPending = options.maxPending ?? 256;
    const wire = this;
    const proxy: Transport = {
      start: () => base.start(),
      send: (message, sendOptions) => wire.#sendSdk(message, sendOptions),
      close: () => wire.#close(),
      get sessionId() {
        return base.sessionId;
      },
      get hasPerRequestStream() {
        return base.hasPerRequestStream;
      },
    };
    if (base.setProtocolVersion)
      proxy.setProtocolVersion = (version) => base.setProtocolVersion!(version);
    if (base.setSupportedProtocolVersions)
      proxy.setSupportedProtocolVersions = (versions) =>
        base.setSupportedProtocolVersions!(versions);
    // The SDK recognizes stdio structurally. Do not add these to HTTP or
    // expose SDK-private spawn parameters/constructors to imitate its reaper.
    for (const field of ["stderr", "pid"] as const)
      if (field in base)
        Object.defineProperty(proxy, field, {
          enumerable: true,
          get: () => (base as unknown as Record<string, unknown>)[field],
        });
    this.transport = proxy;
    base.onmessage = (message, extra) => this.#receive(message, extra);
    base.onerror = (error) =>
      this.#context.run(undefined, () => proxy.onerror?.(error));
    base.onclose = () => this.#didClose();
    this.rawDispatch = (request, dispatchOptions) =>
      this.#dispatch(request, dispatchOptions);
  }

  run<R>(context: T | undefined, action: () => Promise<R>): Promise<R> {
    return this.#context.run(context, action);
  }

  current(): T | undefined {
    return this.#context.getStore();
  }

  release(context: T): void {
    for (const [id, owner] of this.#sdk)
      if (owner === context) this.#sdk.delete(id);
    for (const pending of this.#raw.values())
      if (pending.context === context) pending.context = undefined;
  }

  /** Owner calls only after its actual managed transport closure promise. */
  finish(): void {
    requireCondition(
      this.#closed,
      "mcp_connection_open",
      "Cannot release wire context while the transport is still open.",
    );
    this.#context.disable();
  }

  #active(): void {
    requireCondition(
      !this.#closing && !this.#closed,
      "mcp_connection_closed",
      "The MCP connection no longer admits requests.",
    );
  }

  #admit(): void {
    this.#active();
    requireCondition(
      this.#sdk.size + this.#raw.size < this.#maxPending,
      "mcp_request_capacity",
      "The MCP connection has reached its pending-request limit.",
    );
  }

  #budget(message: unknown): void {
    try {
      canonicalJson(message, this.#maxBytes);
    } catch {
      throw new AgentError(
        "mcp_message_too_large",
        "The MCP message is invalid or exceeds its configured JSON budget.",
      );
    }
  }

  async #sendSdk(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    this.#active();
    this.#budget(message);
    const request = isJSONRPCRequest(message);
    if (request) {
      this.#admit();
      requireCondition(
        !this.#sdk.has(message.id) &&
          !(typeof message.id === "string" && message.id.startsWith(rawPrefix)),
        "mcp_request_identity_conflict",
        "The SDK request identity is already pending or reserved for raw dispatch.",
      );
      this.#sdk.set(message.id, this.current());
    }
    try {
      // Await the real write/HTTP send. A local observation ending never turns
      // a still-writing physical transport into a completed operation.
      await this.#base.send(message, options);
    } catch (error) {
      if (request) this.#sdk.delete(message.id);
      throw error;
    } finally {
      // Client.listen owns a string ID outside Protocol's normal pending map.
      // Local close may receive no final response, so its actual cancellation
      // write also ends our correlation entry instead of leaking capacity.
      if ("method" in message && message.method === "notifications/cancelled") {
        const id = message.params?.requestId;
        if (typeof id === "string" || typeof id === "number")
          this.#sdk.delete(id);
      }
    }
  }

  #receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    const response =
      !Object.hasOwn(message, "method") && Object.hasOwn(message, "id");
    const id = response ? (message as { id: RequestId }).id : undefined;
    if (typeof id === "string" && id.startsWith(rawPrefix)) {
      const pending = this.#raw.get(id);
      if (!pending || pending.outcome) {
        this.#diagnostic(
          "mcp_unknown_response",
          "An unknown or duplicate raw MCP response was discarded.",
        );
        return;
      }
      try {
        this.#budget(message);
        const value = message as unknown as Record<string, unknown>;
        const hasResult = Object.hasOwn(value, "result");
        const hasError = Object.hasOwn(value, "error");
        requireCondition(
          hasResult !== hasError,
          "mcp_invalid_response",
          "The raw MCP response must contain exactly one result or error.",
        );
        if (hasError)
          requireCondition(
            isPlainRecord(value.error) &&
              Number.isSafeInteger(value.error.code) &&
              typeof value.error.message === "string",
            "mcp_invalid_response",
            "The raw MCP error does not have a valid code and message.",
          );
        const result: JsonRpcResponse = hasResult
          ? { kind: "result", result: value.result as JsonValue }
          : {
              kind: "error",
              error: value.error as Extract<
                JsonRpcResponse,
                { kind: "error" }
              >["error"],
            };
        this.#context.run(pending.context, () =>
          pending.finish({ ok: true, response: result }),
        );
      } catch (error) {
        pending.finish({ ok: false, error });
      }
      return;
    }
    let context: T | undefined;
    if (id !== undefined && this.#sdk.has(id)) {
      context = this.#sdk.get(id);
      this.#sdk.delete(id);
    }
    try {
      this.#budget(message);
    } catch (error) {
      this.#diagnostic(
        "mcp_message_too_large",
        "An inbound MCP message exceeded the configured JSON budget.",
      );
      if (id !== undefined)
        this.#context.run(context, () =>
          this.transport.onmessage?.({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message:
                "The local MCP transport rejected an invalid or oversized response.",
            },
          }),
        );
      return;
    }
    if ("method" in message && message.method === "notifications/progress") {
      const token = message.params?.progressToken;
      for (const pending of this.#raw.values())
        if (
          pending.progressToken !== undefined &&
          token === pending.progressToken
        )
          pending.progress?.();
    }
    // A legacy inbound peer request does not identify its initiating call.
    // In particular it must never borrow the previous/current ALS owner.
    this.#context.run(context, () =>
      this.transport.onmessage?.(message, extra),
    );
  }

  #diagnostic(code: string, message: string): void {
    this.#context.run(undefined, () =>
      this.transport.onerror?.(new AgentError(code, message)),
    );
  }

  async #dispatch(
    request: JsonValue,
    options: DispatchOptions = {},
  ): Promise<JsonRpcResponse> {
    this.#admit();
    options.signal?.throwIfAborted();
    const timeoutMs =
      options.context?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    requireCondition(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= maxTimer,
      "invalid_mcp_timeout",
      "An MCP raw request timeout must be positive and representable by a native timer.",
    );
    this.#budget(request);
    const input = JSON.parse(canonicalJson(request, this.#maxBytes)) as unknown;
    requireCondition(
      isPlainRecord(input) &&
        typeof input.method === "string" &&
        input.method.length > 0 &&
        (!Object.hasOwn(input, "params") || isPlainRecord(input.params)),
      "invalid_mcp_request",
      "An MCP raw request needs a method and optional object parameters.",
    );
    const id = rawPrefix + randomUUID();
    const message = { ...input, jsonrpc: "2.0" as const, id } as JSONRPCMessage;
    this.#budget(message);
    const ready = Promise.withResolvers<RawOutcome>();
    const controller = new AbortController();
    const pending: RawPending<T> = {
      context: this.current(),
      abort: (reason) => fail(reason),
      finish: (outcome) => {
        if (pending.outcome) return false;
        pending.outcome = outcome;
        ready.resolve(outcome);
        return true;
      },
    };
    const fail = (error: unknown) => {
      if (pending.finish({ ok: false, error })) controller.abort(error);
    };
    const aborted = () =>
      fail(
        options.signal?.reason ??
          new AgentError(
            "mcp_request_aborted",
            "The MCP request observation was aborted.",
          ),
      );
    const expired = () =>
      fail(
        new AgentError(
          "mcp_request_timeout",
          "The MCP raw request exceeded its observation deadline.",
        ),
      );
    let timer: NodeJS.Timeout | undefined;
    if (options.context?.resetTimeoutOnProgress) {
      const params =
        (message as { params?: Record<string, unknown> }).params ?? {};
      const metadata = isPlainRecord(params._meta) ? params._meta : {};
      const token = metadata.progressToken;
      pending.progressToken =
        typeof token === "string" || typeof token === "number" ? token : id;
      (message as { params?: Record<string, unknown> }).params = {
        ...params,
        _meta: { ...metadata, progressToken: pending.progressToken },
      };
      this.#budget(message);
      pending.progress = () => {
        if (!pending.outcome) {
          clearTimeout(timer);
          timer = setTimeout(expired, timeoutMs);
        }
      };
    }
    timer = setTimeout(expired, timeoutMs);
    this.#raw.set(id, pending);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
    try {
      if (!pending.outcome) {
        try {
          await this.#base.send(message, {
            ...(options.context?.headers === undefined
              ? {}
              : { headers: options.context.headers }),
            requestSignal: controller.signal,
            onRequestStreamEnd: () =>
              fail(
                new AgentError(
                  "mcp_request_stream_ended",
                  "The MCP request stream ended before a response was received.",
                ),
              ),
          });
        } catch {
          const error = new AgentError(
            "mcp_wire_send_failed",
            "The MCP raw request could not complete its physical send.",
          );
          // Even an early response cannot hide a later failed physical send.
          // An already accepted abort/timeout remains the primary observation.
          if ((pending as RawPending<T>).outcome?.ok) throw error;
          fail(error);
        }
      }
      const outcome = await ready.promise;
      if (!outcome.ok) throw outcome.error;
      return outcome.response;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      this.#raw.delete(id);
    }
  }

  #didClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    const error = new AgentError(
      "mcp_connection_closed",
      "The MCP connection closed before its pending requests completed.",
    );
    for (const pending of this.#raw.values()) pending.abort(error);
    this.#sdk.clear();
    this.#context.run(undefined, () => this.transport.onclose?.());
  }

  #close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closing = true;
      for (const pending of this.#raw.values())
        pending.abort(
          new AgentError(
            "mcp_connection_closed",
            "The MCP connection is closing.",
          ),
        );
      this.#closePromise = this.#base.close().then(() => this.#didClose());
    }
    return this.#closePromise;
  }
}
