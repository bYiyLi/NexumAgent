import { AsyncLocalStorage } from "node:async_hooks";
import {
  StreamableHTTPClientTransport,
  isJSONRPCRequest,
  type Transport,
  type OAuthClientProvider,
  type AuthProvider,
  type OAuthDiscoveryState,
  discoverOAuthServerInfo,
  extractResourceMetadataUrl,
  selectResourceURL,
  refreshAuthorization,
  assertSecureTokenEndpoint,
} from "@modelcontextprotocol/client";
import { AgentError, requireCondition } from "../contracts/errors.js";
import type { ManagedResource } from "../extensions/resources.js";

interface CallScope {
  readonly signal: AbortSignal;
  readonly pending: Set<PendingFetch>;
  readonly authentication?: Set<Promise<void>>;
  readonly authSignal?: AbortSignal;
  active: boolean;
  authGeneration?: number;
  oauth?: boolean;
}
interface AuthWaiter {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
}
interface Refresh {
  readonly controller: AbortController;
  readonly scope: CallScope;
  readonly waiters: Set<AuthWaiter>;
  readonly stopped: Set<AuthWaiter>;
  done: Promise<void>;
}
interface PendingFetch {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  cancel?(reason?: unknown): Promise<void>;
}
export interface ManagedHttpTransportOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Trusted approved source service; never decoded from connection JSON. */
  readonly authProvider?: OAuthClientProvider;
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
  #oauth: boolean;
  #sourceUrl: string;
  #sourceHeaders: Readonly<Record<string, string>>;
  #generation = 0;
  #sharedGeneration = 0;
  #refresh?: Refresh;

  constructor(options: ManagedHttpTransportOptions) {
    requireCondition(
      !options.authProvider?.dpop,
      "mcp_oauth_unsupported",
      "This MCP transport supports bearer OAuth; DPoP requires a proof-aware transport.",
    );
    requireCondition(
      !options.authProvider ||
        !new Headers(options.headers).has("authorization"),
      "invalid_mcp_config",
      "Choose bearer OAuth or a static Authorization header for this connection.",
    );
    requireCondition(
      Number.isSafeInteger(options.maxMessageBytes) &&
        options.maxMessageBytes > 0,
      "invalid_mcp_config",
      "MCP HTTP message limits must be positive bounded integers.",
    );
    this.#limit = options.maxMessageBytes;
    this.#authorize = options.authorize;
    this.#oauth = options.authProvider !== undefined;
    const url = new URL(options.url);
    this.#sourceUrl = url.href;
    this.#sourceHeaders = Object.freeze({ ...options.headers });
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
      // Do not let the SDK merge source headers into AS fetches. Injection
      // happens below only at the exact MCP endpoint, outside OAuth exchanges.
      requestInit: { redirect: "error" },
      fetch: (target, init) => this.#fetch(target, init),
      ...(options.authProvider
        ? { authProvider: this.#authentication(options.authProvider) }
        : {}),
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
    const ended = new AbortController();
    const scope: CallScope = {
      signal,
      authSignal: AbortSignal.any([signal, ended.signal]),
      pending: new Set(),
      authentication: new Set(),
      active: true,
    };
    try {
      return await this.#calls.run(scope, callback);
    } finally {
      scope.active = false;
      ended.abort(
        new AgentError(
          "mcp_call_closed",
          "The MCP operation has completed its observation.",
        ),
      );
      await Promise.allSettled(scope.authentication!);
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
          await this.#refresh?.done;
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

  #authentication(provider: OAuthClientProvider): AuthProvider {
    return {
      token: async () => {
        const generation = this.#generation;
        const tokens = await provider.tokens();
        const scope = this.#calls.getStore();
        if (scope) scope.authGeneration = generation;
        else this.#sharedGeneration = generation;
        return tokens?.access_token;
      },
      onUnauthorized: async (context) => {
        const owner = this.#calls.getStore();
        const signal =
          owner?.authSignal ?? owner?.signal ?? this.#lifetime.signal;
        signal.throwIfAborted();
        requireCondition(
          !owner || owner.active,
          "mcp_call_closed",
          "The requesting operation is closed.",
        );
        const generation = owner?.authGeneration ?? this.#sharedGeneration;
        if (generation !== this.#generation) return;
        let refresh = this.#refresh;
        // A last-waiter cancellation may still be settling real native I/O.
        // A new request observes that closure instead of joining its aborted
        // authentication scope or starting an overlapping token exchange.
        while (refresh?.scope.signal.aborted) {
          await refresh.done;
          signal.throwIfAborted();
          requireCondition(
            !owner || owner.active,
            "mcp_call_closed",
            "The requesting operation is closed.",
          );
          if (generation !== this.#generation) return;
          refresh = this.#refresh;
        }
        if (!refresh) {
          const controller = new AbortController();
          const scope: CallScope = {
            signal: AbortSignal.any([
              this.#lifetime.signal,
              controller.signal,
              AbortSignal.timeout(30000),
            ]),
            pending: new Set(),
            active: true,
            oauth: true,
          };
          refresh = {
            controller,
            scope,
            waiters: new Set(),
            stopped: new Set(),
            done: Promise.resolve(),
          };
          this.#refresh = refresh;
          const active = refresh;
          // Native shared authentication belongs to the registered connection.
          // A cancelled waiter cannot destroy a refresh still needed by others.
          active.done = Promise.resolve().then(async () => {
            let failure: unknown;
            try {
              await this.#calls.run(scope, async () => {
                scope.signal.throwIfAborted();
                const cached = await provider.discoveryState?.();
                const resourceMetadataUrl = extractResourceMetadataUrl(
                  context.response,
                );
                const discovery: OAuthDiscoveryState =
                  cached && !resourceMetadataUrl
                    ? cached
                    : await discoverOAuthServerInfo(context.serverUrl, {
                        fetchFn: context.fetchFn,
                        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
                      });
                const issuer =
                  discovery.authorizationServerMetadata?.issuer ??
                  discovery.authorizationServerUrl;
                assertSecureTokenEndpoint(issuer);
                const oldIssuer =
                  cached?.authorizationServerMetadata?.issuer ??
                  cached?.authorizationServerUrl;
                requireCondition(
                  !oldIssuer || oldIssuer === issuer,
                  "maintenance_auth_required",
                  "Changing OAuth issuer requires user confirmation.",
                );
                await provider.saveDiscoveryState?.(discovery);
                const ctx = { issuer },
                  tokens = await provider.tokens(ctx),
                  info = await provider.clientInformation(ctx);
                requireCondition(
                  tokens?.refresh_token &&
                    info &&
                    (!tokens.issuer || tokens.issuer === issuer) &&
                    (!info.issuer || info.issuer === issuer),
                  "maintenance_auth_required",
                  "Renew MCP consent through the authorization page.",
                );
                const selectedResource = await selectResourceURL(
                  context.serverUrl,
                  provider,
                  discovery.resourceMetadata,
                );
                const resource =
                  discovery.resourceMetadata?.resource ?? selectedResource;
                const result = await refreshAuthorization(
                  discovery.authorizationServerUrl,
                  {
                    metadata: discovery.authorizationServerMetadata,
                    clientInformation: info,
                    refreshToken: tokens.refresh_token,
                    scope: await provider.scopeForRefresh?.(tokens),
                    resource,
                    addClientAuthentication: provider.addClientAuthentication,
                    fetchFn: context.fetchFn,
                  },
                );
                scope.signal.throwIfAborted();
                await provider.saveTokens({ ...result, issuer }, ctx);
                scope.signal.throwIfAborted();
              });
              this.#generation++;
            } catch (error) {
              if (
                !scope.signal.aborted &&
                error &&
                typeof error === "object" &&
                "code" in error &&
                [
                  "invalid_grant",
                  "invalid_client",
                  "unauthorized_client",
                ].includes(String(error.code))
              ) {
                try {
                  await provider.invalidateCredentials?.("tokens");
                } catch {}
                failure = new AgentError(
                  "maintenance_auth_required",
                  "The MCP authorization must be renewed through the user page.",
                );
              } else
                failure = new AgentError(
                  scope.signal.aborted
                    ? "mcp_oauth_cancelled"
                    : error instanceof AgentError
                      ? error.code
                      : "mcp_oauth_failed",
                  scope.signal.aborted
                    ? "The OAuth operation was cancelled after its native work settled."
                    : "The MCP authorization operation failed; provider details are private.",
                );
            } finally {
              scope.active = false;
              for (const pending of scope.pending) {
                if (pending.cancel) void pending.cancel();
                else pending.controller.abort();
              }
              await this.#drain(scope.pending);
              if (this.#refresh === active) this.#refresh = undefined;
              for (const waiter of [...active.waiters, ...active.stopped]) {
                waiter.signal.removeEventListener("abort", waiter.abort);
                if (waiter.signal.aborted)
                  waiter.reject(
                    new AgentError(
                      "mcp_oauth_cancelled",
                      "This OAuth waiter was cancelled.",
                    ),
                  );
                else if (failure) waiter.reject(failure);
                else waiter.resolve();
              }
              active.waiters.clear();
              active.stopped.clear();
            }
          });
        }
        requireCondition(
          refresh.waiters.size < 256,
          "mcp_oauth_busy",
          "The authentication waiter budget is full.",
        );
        const active = refresh;
        const waiting = new Promise<void>((resolve, reject) => {
          const waiter: AuthWaiter = {
            signal,
            resolve,
            reject,
            abort: () => {
              if (!active.waiters.delete(waiter)) return;
              if (active.waiters.size) {
                signal.removeEventListener("abort", waiter.abort);
                reject(
                  new AgentError(
                    "mcp_oauth_cancelled",
                    "This OAuth waiter was cancelled.",
                  ),
                );
              } else {
                active.stopped.add(waiter);
                active.controller.abort(signal.reason);
              }
            },
          };
          active.waiters.add(waiter);
          signal.addEventListener("abort", waiter.abort, { once: true });
          if (signal.aborted) waiter.abort();
        });
        owner?.authentication?.add(waiting);
        try {
          await waiting;
        } finally {
          owner?.authentication?.delete(waiting);
        }
      },
    };
  }

  async #fetch(
    target: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    this.#lifetime.signal.throwIfAborted();
    const url = new URL(target).href;
    this.#authorize(url);
    const body = init.body;
    if (typeof body === "string") {
      requireCondition(
        Buffer.byteLength(body) <= this.#limit,
        "mcp_message_too_large",
        "An MCP HTTP request exceeds the configured message byte limit.",
      );
    }
    // OAuth discovery, registration and token exchanges are descendants of the
    // invoking SDK operation too. Their real fetch/body lifetime and abort must
    // remain owned by that operation, even when the body is form-urlencoded.
    const scope = this.#calls.getStore();
    if (scope?.oauth) assertSecureTokenEndpoint(url);
    const headers = new Headers(init.headers);
    if (!scope?.oauth && url === this.#sourceUrl)
      for (const [name, value] of Object.entries(this.#sourceHeaders))
        headers.set(name, value);
    requireCondition(
      !scope || scope.active,
      "mcp_call_closed",
      "The MCP operation no longer admits HTTP requests.",
    );
    const controller = new AbortController();
    const signals = [this.#lifetime.signal, controller.signal];
    if (init.signal) signals.push(init.signal);
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
      const response = await fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal,
      });
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
      if (response.status === 401 && !this.#oauth) {
        await cancel();
        throw new AgentError(
          "mcp_authentication_required",
          "The MCP server requires an approved authentication configuration.",
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
