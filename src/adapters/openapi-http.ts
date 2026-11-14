import { addAbortListener } from "node:events";
import { authorizeCall } from "../contracts/caller.js";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import type { JsonObject } from "../contracts/types.js";
import type { ExtensionHost, Invocation } from "../extensions/api.js";
import type { ManagedResource, ResourceRef } from "../extensions/resources.js";
import type { OpenApiRequest } from "./openapi-request.js";
import type { OpenApiResponse } from "./openapi-types.js";

export interface OpenApiHttpOptions {
  readonly request: OpenApiRequest;
  readonly host: ExtensionHost;
  readonly call: Invocation;
  readonly operation: string;
  readonly limits: {
    readonly requestBytes: number;
    readonly responseBytes: number;
    readonly requestTimeoutMs: number;
  };
  authenticate(signal: AbortSignal): Promise<{
    readonly url: string;
    readonly headers: Headers;
    readonly dispatcher?: unknown;
    readonly secrets: readonly string[];
    readonly sensitiveHeaders: readonly string[];
  }>;
  validateResponse(response: OpenApiResponse, mimeType: string): void;
}

export class OpenApiHttpError extends AgentError {
  constructor(
    readonly response: OpenApiResponse,
    details: JsonObject,
  ) {
    super(
      "api_http_error",
      "The API returned an unsuccessful HTTP status.",
      details,
    );
    this.name = "OpenApiHttpError";
  }
}

const safeErrors = new WeakSet<object>();
function failure(code: string, message: string): AgentError {
  const error = new AgentError(code, message);
  safeErrors.add(error);
  return error;
}
const forbiddenRoutingHeaders = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
]);
const privateResponseHeaders = new Set([
  "set-cookie",
  "set-cookie2",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "authentication-info",
  "proxy-authentication-info",
]);
const denials = new Set([
  "forbidden",
  "permission_denied",
  "access_denied",
  "path_not_allowed",
  "resource_forbidden",
  "unauthorized",
]);
function mimeType(value: string | null): string {
  return (value ?? "application/octet-stream")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}
function jsonMime(mime: string): boolean {
  return mime === "application/json" || /^application\/[^/]+\+json$/.test(mime);
}
function textMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    /(?:\+xml|\+yaml)$/.test(mime) ||
    [
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "application/ecmascript",
    ].includes(mime)
  );
}

class Redactor {
  readonly patterns: readonly Buffer[];
  readonly headers: ReadonlySet<string>;
  #expression?: RegExp;
  changed = false;
  constructor(
    secrets: readonly string[],
    headers: readonly string[],
    readonly limit: number,
    requestLimit: number,
  ) {
    requireCondition(
      Array.isArray(secrets) &&
        secrets.length <= 256 &&
        Array.isArray(headers) &&
        headers.length <= 256,
      "api_invalid_authentication",
      "The authentication metadata is not bounded.",
    );
    const expressions = new Set<string>();
    let size = 0;
    for (const secret of secrets) {
      requireCondition(
        typeof secret === "string",
        "api_invalid_authentication",
        "Credential redaction metadata must contain strings.",
      );
      size += Buffer.byteLength(secret);
      requireCondition(
        size <= requestLimit,
        "api_invalid_authentication",
        "Credential redaction metadata exceeds the request policy.",
      );
      if (!secret) continue;
      expressions.add(secret);
      // Protect provider URL echoes as well as ordinary decoded JSON/text.
      expressions.add(encodeURIComponent(secret));
      expressions.add(JSON.stringify(secret).slice(1, -1));
    }
    const needles = [...expressions]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    this.patterns = needles.map((secret) => Buffer.from(secret));
    if (needles.length)
      this.#expression = new RegExp(
        needles
          .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|"),
        "g",
      );
    this.headers = new Set([
      ...privateResponseHeaders,
      ...headers.map((header) => {
        requireCondition(
          typeof header === "string" &&
            /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) &&
            header.length <= 256,
          "api_invalid_authentication",
          "Sensitive header metadata is invalid.",
        );
        return header.toLowerCase();
      }),
    ]);
  }
  text(value: string): string {
    if (!this.#expression) return value;
    this.#expression.lastIndex = 0;
    let bytes = Buffer.byteLength(value),
      found = false;
    for (
      let match = this.#expression.exec(value);
      match;
      match = this.#expression.exec(value)
    ) {
      found = true;
      bytes += 10 - Buffer.byteLength(match[0]);
      if (bytes > this.limit) {
        this.changed = true;
        return this.limit >= 10 ? "[REDACTED]" : "";
      }
    }
    if (!found) return value;
    this.changed = true;
    this.#expression.lastIndex = 0;
    return value.replace(this.#expression, "[REDACTED]");
  }
  json(value: unknown, depth = 0): unknown {
    requireCondition(
      depth <= 128,
      "api_response_encoding",
      "The API JSON response is too deeply nested.",
    );
    if (typeof value === "string") return this.text(value);
    if (value === null) return value;
    if (typeof value === "number" || typeof value === "boolean") {
      const text = String(value),
        fixed = this.text(text);
      return fixed === text ? value : fixed;
    }
    if (Array.isArray(value))
      return value.map((item) => this.json(item, depth + 1));
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (this.text(key) !== key) continue;
      result[key] = this.json(item, depth + 1);
    }
    return result;
  }
  binary(value: Buffer): void {
    if (this.patterns.some((secret) => value.indexOf(secret) !== -1))
      throw failure(
        "api_sensitive_response",
        "The API binary response contains a protected credential and cannot be returned.",
      );
  }
  responseHeaders(headers: Headers): Readonly<Record<string, string>> {
    const result: Record<string, string> = Object.create(null);
    for (const [name, value] of headers) {
      if (this.headers.has(name.toLowerCase())) {
        this.changed = true;
        continue;
      }
      if (this.text(name) !== name) continue;
      result[name] = this.text(value);
    }
    return Object.freeze(result);
  }
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;
/** A cold, per-call exchange. closed means fetch and owned readers settled. */
class HttpExchange implements ManagedResource {
  readonly closed: Promise<void>;
  #closure = Promise.withResolvers<void>();
  #stop = new AbortController();
  #ref?: ResourceRef;
  #signal?: AbortSignal;
  #timeout?: AbortSignal;
  #running?: Promise<OpenApiResponse>;
  #disposal?: Promise<void>;
  #readers = new Set<Reader>();
  #reads = new Set<Promise<unknown>>();
  #cancels = new Map<Reader, Promise<unknown>>();
  #dispatched = false;
  #status?: number;
  #uploadBytes = 0;
  #responseBytes = 0;
  #uploadFailure?: AgentError;
  #httpFailure?: OpenApiHttpError;
  #phase = "preparing";
  #unsubscribe?: Disposable;
  constructor(readonly options: OpenApiHttpOptions) {
    this.closed = this.#closure.promise;
  }
  start(ref: ResourceRef): Promise<OpenApiResponse> {
    requireCondition(
      !this.#running,
      "api_request_closed",
      "The HTTP exchange cannot start twice.",
    );
    this.#ref = ref;
    this.#timeout = AbortSignal.timeout(this.options.limits.requestTimeoutMs);
    this.#signal = AbortSignal.any([
      this.#stop.signal,
      this.options.host.signal,
      this.options.call.signal,
      ref.signal,
      this.#timeout,
    ]);
    this.#unsubscribe = addAbortListener(this.#signal, () => {
      void this.#cancelReaders();
    });
    // Assign before entering any caller-provided authorization/authentication.
    this.#running = Promise.resolve().then(() => this.#drive());
    return this.#running;
  }
  dispose(): Promise<void> {
    if (!this.#disposal)
      this.#disposal = (async () => {
        this.#stop.abort();
        await this.#cancelReaders();
        if (this.#running) await this.#running.catch(() => {});
        else this.#closure.resolve();
      })();
    return this.#disposal;
  }
  #assertCurrent(): void {
    if (this.#signal?.aborted)
      throw failure(
        this.#timedOut() ? "api_request_timeout" : "api_request_cancelled",
        this.#timedOut()
          ? "The API request exceeded its execution timeout."
          : "The API request was cancelled.",
      );
    const target = {
      type: "url",
      value: this.options.request.url,
      access: "request",
    } as const;
    authorizeCall(() => this.options.host.authorize(target));
    authorizeCall(() => this.options.call.authorize(target));
  }
  #timedOut(): boolean {
    return !!(
      this.#timeout?.aborted && this.#signal?.reason === this.#timeout.reason
    );
  }
  #report(phase: string): void {
    this.#phase = phase;
    this.#ref?.report({
      operation: this.options.operation,
      state: phase,
      dispatched: this.#dispatched,
      uploadedBytes: this.#uploadBytes,
      responseBytes: this.#responseBytes,
      ...(this.#status === undefined ? {} : { status: this.#status }),
    });
  }
  #read(reader: Reader): Promise<ReadableStreamReadResult<Uint8Array>> {
    const pending = reader.read();
    this.#reads.add(pending);
    void pending.then(
      () => this.#reads.delete(pending),
      () => this.#reads.delete(pending),
    );
    return pending;
  }
  #cancel(reader: Reader): Promise<unknown> {
    let cancellation = this.#cancels.get(reader);
    if (!cancellation) {
      cancellation = (async () => {
        // A rejected closed still confirms physical stream closure. A pending
        // cancel/closed never becomes fabricated successful cleanup.
        await Promise.allSettled([reader.cancel(), reader.closed]);
      })();
      this.#cancels.set(reader, cancellation);
    }
    return cancellation;
  }
  async #cancelReaders(): Promise<void> {
    await Promise.all([...this.#readers].map((reader) => this.#cancel(reader)));
  }
  #safeError(cause: unknown): AgentError {
    const details: JsonObject = {
      operation: this.options.operation,
      dispatched: this.#dispatched,
      effect: this.#dispatched ? "unknown" : "none",
      ...(this.#status === undefined ? {} : { status: this.#status }),
    };
    if (cause === this.#httpFailure) return this.#httpFailure!;
    if (this.#uploadFailure) return this.#uploadFailure;
    if (cause && typeof cause === "object" && safeErrors.has(cause))
      return new AgentError(
        (cause as AgentError).code,
        (cause as AgentError).message,
        details,
      );
    if (this.#signal?.aborted)
      return new AgentError(
        this.#timedOut() ? "api_request_timeout" : "api_request_cancelled",
        this.#timedOut()
          ? "The API request exceeded its execution timeout."
          : "The API request was cancelled.",
        details,
      );
    if (isAgentError(cause) && denials.has(cause.code))
      return new AgentError(
        cause.code,
        "The API request is no longer authorized.",
        details,
      );
    if (isAgentError(cause) && cause.code === "authorization_configuration")
      return new AgentError(
        cause.code,
        "The API authorization callback must be synchronous and cannot return a value.",
        details,
      );
    return new AgentError(
      this.#phase === "authenticating"
        ? "api_authentication_failed"
        : "api_network_error",
      this.#phase === "authenticating"
        ? "API authentication could not be completed."
        : "The API HTTP exchange failed.",
      details,
    );
  }
  async #drive(): Promise<OpenApiResponse> {
    try {
      this.#assertCurrent();
      this.#report("authenticating");
      const authentication = await this.options.authenticate(this.#signal!);
      this.#assertCurrent();
      const original = new URL(this.options.request.url),
        authenticated = new URL(authentication.url);
      if (
        original.origin !== authenticated.origin ||
        original.pathname !== authenticated.pathname ||
        authenticated.username ||
        authenticated.password ||
        authenticated.hash
      )
        throw failure(
          "api_auth_target_changed",
          "Authentication cannot replace the approved API target.",
        );
      const headers = new Headers(authentication.headers);
      for (const [name] of headers)
        if (
          forbiddenRoutingHeaders.has(name) ||
          name.startsWith("proxy-") ||
          name.startsWith(":")
        )
          throw failure(
            "api_invalid_header",
            "Authentication cannot set a reserved transport header.",
          );
      let requestBytes =
        Buffer.byteLength(authentication.url) +
        this.options.request.method.length +
        8;
      for (const [name, value] of headers)
        requestBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
      if (requestBytes > this.options.limits.requestBytes)
        throw failure(
          "api_request_too_large",
          "The authenticated request exceeds its byte budget.",
        );
      const redactor = new Redactor(
        authentication.secrets,
        authentication.sensitiveHeaders,
        this.options.limits.responseBytes,
        this.options.limits.requestBytes,
      );
      const native = new Request(authentication.url, {
        method: this.options.request.method,
        headers,
        body: this.options.request.body,
        duplex: "half",
        signal: this.#signal,
      } as RequestInit);
      let upload: ReadableStream<Uint8Array> | undefined;
      if (native.body) {
        const reader = native.body.getReader();
        this.#readers.add(reader);
        upload = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              this.#assertCurrent();
              const part = await this.#read(reader);
              this.#assertCurrent();
              if (part.done) {
                controller.close();
                return;
              }
              if (
                part.value.byteLength >
                this.options.limits.requestBytes - requestBytes
              )
                throw failure(
                  "api_request_too_large",
                  "The API upload exceeds its actual byte budget.",
                );
              requestBytes += part.value.byteLength;
              this.#uploadBytes += part.value.byteLength;
              controller.enqueue(part.value);
            } catch (cause) {
              this.#uploadFailure ??= this.#safeError(cause);
              this.#stop.abort();
              controller.error(cause);
              await this.#cancel(reader);
            }
          },
          cancel: async () => {
            await this.#cancel(reader);
          },
        });
      }
      this.#assertCurrent();
      this.#report("requesting");
      this.#dispatched = true;
      const response = await fetch(authentication.url, {
        method: this.options.request.method,
        headers: native.headers,
        body: upload,
        duplex: "half",
        signal: this.#signal,
        redirect: "manual",
        ...(authentication.dispatcher === undefined
          ? {}
          : { dispatcher: authentication.dispatcher }),
      } as RequestInit);
      const reader = response.body?.getReader();
      if (reader) this.#readers.add(reader);
      this.#assertCurrent();
      this.#status = response.status;
      this.#report("reading");
      if (response.status >= 300 && response.status < 400)
        throw failure(
          "api_redirect_not_allowed",
          "The API returned a redirect; no redirected request was sent.",
        );
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        /^\d+$/.test(declared) &&
        Number(declared) > this.options.limits.responseBytes
      )
        throw failure(
          "api_response_too_large",
          "The API response declares a size beyond its byte budget.",
        );
      let headerBytes = 0;
      const rawHeaders: Record<string, string> = Object.create(null);
      for (const [name, value] of response.headers) {
        headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
        if (headerBytes > this.options.limits.responseBytes)
          throw failure(
            "api_response_too_large",
            "The API response headers exceed their byte budget.",
          );
        rawHeaders[name] = value;
      }
      const chunks: Uint8Array[] = [];
      if (reader)
        while (true) {
          this.#assertCurrent();
          const part = await this.#read(reader);
          this.#assertCurrent();
          if (part.done) break;
          if (
            part.value.byteLength >
            this.options.limits.responseBytes - this.#responseBytes
          )
            throw failure(
              "api_response_too_large",
              "The API response exceeds its actual byte budget.",
            );
          this.#responseBytes += part.value.byteLength;
          chunks.push(part.value);
        }
      const bytes = Buffer.concat(chunks, this.#responseBytes);
      const mime = mimeType(response.headers.get("content-type"));
      let data: unknown;
      try {
        data =
          bytes.length === 0
            ? null
            : jsonMime(mime)
              ? JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                )
              : textMime(mime)
                ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
                : new Blob([bytes], { type: mime });
      } catch {
        throw failure(
          "api_response_encoding",
          "The API response is not valid for its declared media type.",
        );
      }
      const raw: OpenApiResponse = {
        ok: response.ok,
        status: response.status,
        headers: rawHeaders,
        data,
      };
      try {
        this.options.validateResponse(raw, mime);
      } catch {
        throw failure(
          "api_invalid_response",
          "The API response does not match its declared schema.",
        );
      }
      this.#assertCurrent();
      const publicHeaders = redactor.responseHeaders(response.headers);
      if (bytes.length && !jsonMime(mime) && !textMime(mime))
        redactor.binary(bytes);
      else
        data = jsonMime(mime)
          ? redactor.json(data)
          : typeof data === "string"
            ? redactor.text(data)
            : data;
      const result: OpenApiResponse = Object.freeze({
        ok: response.ok,
        status: response.status,
        headers: publicHeaders,
        data,
        ...(redactor.changed ? { redacted: true } : {}),
      });
      this.#report("completed");
      if (!response.ok) {
        this.#httpFailure = new OpenApiHttpError(result, {
          operation: this.options.operation,
          status: response.status,
          dispatched: true,
          effect: "unknown",
        });
        throw this.#httpFailure;
      }
      return result;
    } catch (cause) {
      throw this.#safeError(cause);
    } finally {
      this.#stop.abort();
      await this.#cancelReaders();
      await Promise.allSettled([...this.#reads]);
      this.#unsubscribe?.[Symbol.dispose]();
      for (const reader of this.#readers) reader.releaseLock();
      this.#closure.resolve();
    }
  }
}

export async function executeOpenApiHttp(
  options: OpenApiHttpOptions,
): Promise<OpenApiResponse> {
  for (const [name, value] of Object.entries(options.limits))
    requireCondition(
      Number.isSafeInteger(value) &&
        value > 0 &&
        (name !== "requestTimeoutMs" || value <= 2_147_483_647),
      "api_invalid_limits",
      "API HTTP limits must be positive bounded integers.",
    );
  const exchange = new HttpExchange(options);
  let ref: ResourceRef;
  try {
    ref = await options.call.resources.register({
      kind: "api.request",
      value: exchange,
    });
  } catch {
    await exchange.dispose();
    throw new AgentError(
      "api_resource_unavailable",
      "The API request could not register its runtime resource.",
      { operation: options.operation, dispatched: false, effect: "none" },
    );
  }
  return exchange.start(ref);
}
