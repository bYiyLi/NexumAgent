import { AsyncLocalStorage } from "node:async_hooks";
import {
  StreamableHTTPClientTransport,
  isJSONRPCRequest,
  type Transport,
} from "@modelcontextprotocol/client";
import { AgentError, requireCondition } from "../contracts/errors.js";
import type { ManagedResource } from "../extensions/resources.js";

interface CallScope {
  readonly signal: AbortSignal;
  readonly pending: Set<PendingFetch>;
  active: boolean;
}
interface PendingFetch {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  cancel?(reason?: unknown): Promise<void>;
}
export interface ManagedHttpTransportOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxMessageBytes: number;
  authorize(url: string): void;
}

/** Bound wire bytes between SSE blank lines; the official SDK owns parsing. */
function frameBudget(limit: number): (bytes: Uint8Array) => void {
  let frameBytes = 0,
    lineBytes = 0,
    afterCR = false,
    resetAfterCR = false;
  const count = () => {
    requireCondition(
      ++frameBytes <= limit,
      "mcp_message_too_large",
      "An MCP HTTP event exceeds the configured message byte limit.",
    );
  };
  return (bytes) => {
    for (const byte of bytes) {
      if (afterCR) {
        afterCR = false;
        if (byte === 10) {
          count();
          if (resetAfterCR) frameBytes = 0;
          resetAfterCR = false;
          continue;
        }
        if (resetAfterCR) frameBytes = 0;
        resetAfterCR = false;
      }
      count();
      if (byte === 13 || byte === 10) {
        const blank = lineBytes === 0;
        lineBytes = 0;
        if (byte === 13) {
          afterCR = true;
          resetAfterCR = blank;
        } else if (blank) frameBytes = 0;
      } else lineBytes++;
    }
  };
}

/**
 * Cold official MCP transport with resource ownership of the underlying HTTP
 * exchanges. SDK onclose is notification, not proof that a body has closed.
 */
export class ManagedHttpTransport implements ManagedResource {
  readonly transport: Transport;
  readonly closed: Promise<void>;
  #lifetime = new AbortController();
  #calls = new AsyncLocalStorage<CallScope>();
  #pending = new Set<PendingFetch>();
  #closeSdk: () => Promise<void>;
  #resolveClosed: () => void;
  #disposal?: Promise<void>;
  #limit: number;
  #authorize: ManagedHttpTransportOptions["authorize"];

  constructor(options: ManagedHttpTransportOptions) {
    requireCondition(
      Number.isSafeInteger(options.maxMessageBytes) &&
        options.maxMessageBytes > 0,
      "invalid_mcp_config",
      "MCP HTTP message limits must be positive bounded integers.",
    );
    this.#limit = options.maxMessageBytes;
    this.#authorize = options.authorize;
    const url = new URL(options.url);
    requireCondition(
      (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password,
      "invalid_mcp_config",
      "MCP HTTP requires an HTTP URL without embedded credentials.",
    );
    const closure = Promise.withResolvers<void>();
    this.closed = closure.promise;
    this.#resolveClosed = closure.resolve;
    const sdk = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { ...options.headers }, redirect: "error" },
      fetch: (target, init) => this.#fetch(target, init),
      // Authentication is limited to explicitly configured static headers.
      onInsufficientScope: "throw",
      maxStepUpRetries: 0,
    });
    this.#closeSdk = sdk.close.bind(sdk);
    const send = sdk.send.bind(sdk);
    sdk.send = (message, sendOptions) => {
      const messages = Array.isArray(message) ? message : [message];
      // The initialized notification starts the shared GET in its async
      // descendants. Clear call context there; request recovery GETs retain it.
      return messages.some(isJSONRPCRequest)
        ? send(message, sendOptions)
        : this.#calls.exit(() => send(message, sendOptions));
    };
    // Keep the official transport's complete API and per-request stream flag.
    // Client.close() must use the same physical closure path as resource stop.
    sdk.close = () => this.dispose();
    this.transport = sdk;
  }

  async run<T>(signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
    this.#lifetime.signal.throwIfAborted();
    signal.throwIfAborted();
    const scope: CallScope = { signal, pending: new Set(), active: true };
    try {
      return await this.#calls.run(scope, callback);
    } finally {
      scope.active = false;
      // The callback owns the SDK result promise. Once it settles, a server
      // retaining its POST stream must not retain the finished operation.
      // The shared GET and notifications belong to the resource, not this set.
      for (const pending of scope.pending) {
        if (pending.cancel) void pending.cancel(signal.reason);
        else pending.controller.abort(signal.reason);
      }
      await this.#drain(scope.pending);
      signal.throwIfAborted();
    }
  }

  dispose(reason?: unknown): Promise<void> {
    if (!this.#disposal) {
      this.#disposal = (async () => {
        this.#lifetime.abort(reason);
        try {
          await this.#closeSdk();
        } finally {
          await this.#drain(this.#pending);
          this.#calls.disable();
          this.#resolveClosed();
        }
      })();
    }
    return this.#disposal;
  }

  async #drain(pending: ReadonlySet<PendingFetch>): Promise<void> {
    while (pending.size)
      await Promise.all([...pending].map((entry) => entry.done));
  }

  async #fetch(
    target: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    this.#lifetime.signal.throwIfAborted();
    const url = new URL(target).href;
    this.#authorize(url);
    const body = init.body;
    let request = false;
    if (typeof body === "string") {
      requireCondition(
        Buffer.byteLength(body) <= this.#limit,
        "mcp_message_too_large",
        "An MCP HTTP request exceeds the configured message byte limit.",
      );
      // The SDK has already serialized the message; this only associates an
      // exchange with its call. Notifications must survive call cancellation.
      const messages: unknown = JSON.parse(body);
      request = (Array.isArray(messages) ? messages : [messages]).some(
        isJSONRPCRequest,
      );
    }
    const scope =
      request || init.method === "GET" ? this.#calls.getStore() : undefined;
    requireCondition(
      !scope || scope.active,
      "mcp_call_closed",
      "The MCP operation no longer admits HTTP requests.",
    );
    const controller = new AbortController();
    const signals = [this.#lifetime.signal, controller.signal];
    if (init.signal && (request || init.method === "GET"))
      signals.push(init.signal);
    if (scope) signals.push(scope.signal);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const completion = Promise.withResolvers<void>();
    const entry: PendingFetch = { controller, done: completion.promise };
    this.#pending.add(entry);
    scope?.pending.add(entry);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.#pending.delete(entry);
      scope?.pending.delete(entry);
      completion.resolve();
    };
    try {
      const response = await fetch(url, { ...init, redirect: "error", signal });
      if (!response.body) {
        finish();
        return response;
      }
      const reader = response.body.getReader();
      let cancellation: Promise<void> | undefined;
      const settle = async () => {
        await reader.closed.catch(() => {});
        await cancellation;
        signal.removeEventListener("abort", onAbort);
        finish();
      };
      const cancel = (reason?: unknown): Promise<void> => {
        if (!cancellation) {
          // Mark cancellation before aborting: abort delivery is synchronous.
          const done = Promise.withResolvers<void>();
          cancellation = done.promise;
          void reader
            .cancel(reason)
            .catch(() => {})
            .then(done.resolve);
          controller.abort(reason);
        }
        return settle();
      };
      const onAbort = () => {
        void cancel(signal.reason);
      };
      entry.cancel = cancel;
      signal.addEventListener("abort", onAbort, { once: true });
      void reader.closed.then(settle, settle);
      if (signal.aborted) await cancel(signal.reason);
      if (response.status === 401) {
        await cancel();
        throw new AgentError(
          "mcp_authentication_required",
          "The MCP server requires configured authentication; interactive OAuth is unsupported.",
        );
      }
      const sse =
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() === "text/event-stream";
      const checkFrame = sse ? frameBudget(this.#limit) : null;
      let bytes = 0;
      const wrapped = new ReadableStream<Uint8Array>({
        pull: async (output) => {
          try {
            const item = await reader.read();
            if (item.done) {
              output.close();
              await settle();
              return;
            }
            if (checkFrame) checkFrame(item.value);
            else {
              bytes += item.value.byteLength;
              requireCondition(
                bytes <= this.#limit,
                "mcp_message_too_large",
                "An MCP HTTP response exceeds the configured message byte limit.",
              );
            }
            output.enqueue(item.value);
          } catch (error) {
            output.error(error);
            await cancel(error);
          }
        },
        cancel,
      });
      return new Response(wrapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      // A native fetch rejection has no body. Once headers were received,
      // closure is confirmed by the reader/cancellation path instead.
      if (entry.cancel) await entry.cancel(error);
      else finish();
      throw error;
    }
  }
}
