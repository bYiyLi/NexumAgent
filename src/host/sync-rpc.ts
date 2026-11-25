import { MessagePort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { safeErrorData, isPublicErrorCode, boundErrorMessage, boundErrorDetails } from "../contracts/error-data.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";

// The synchronous side runs only in the dedicated Registry Worker. The host
// thread stays responsive to Go RPC while the Worker waits for its answer.
const bufferBytes = 1024 * 1024;
const headerBytes = 8;
const pending = 0;
const finished = 1;
const abandoned = 2;
const writing = 3;

type RequestHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;

function encode(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value, bufferBytes - headerBytes));
}

/** A blocking call for a dedicated Worker, never for the stdio event loop. */
export function callHostSync(port: MessagePort, method: string, params: unknown, timeoutMs = 30_000): unknown {
  requireCondition(typeof method === "string" && /^[a-z][a-zA-Z0-9_.]{0,127}$/.test(method) &&
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000,
  "invalid_sync_request", "The host request needs a bounded method and timeout.");
  const fixed = JSON.parse(canonicalJson(params ?? null, bufferBytes - headerBytes)) as unknown;
  const buffer = new SharedArrayBuffer(bufferBytes);
  const header = new Int32Array(buffer, 0, 2);
  const id = randomUUID();
  port.postMessage({ type: "request", id, method, params: fixed, buffer });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = Atomics.load(header, 0);
    if (state === finished) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0 && Atomics.compareExchange(header, 0, pending, abandoned) === pending) {
      port.postMessage({ type: "cancel", id });
      throw new AgentError("host_rpc_timeout", "The host request did not finish before its deadline.");
    }
    // Once the host has claimed the buffer it must complete its bounded write.
    Atomics.wait(header, 0, state, Math.max(1, remaining));
  }
  const length = Atomics.load(header, 1);
  requireCondition(length > 0 && length <= bufferBytes - headerBytes,
    "host_rpc_invalid_response", "The host response is invalid.");
  let response: unknown;
  try {
    response = JSON.parse(Buffer.from(buffer, headerBytes, length).toString("utf8"));
  } catch {
    throw new AgentError("host_rpc_invalid_response", "The host response is invalid.");
  }
  requireCondition(isPlainRecord(response) && typeof response.ok === "boolean",
    "host_rpc_invalid_response", "The host response is invalid.");
  if (!response.ok) {
    const error = isPlainRecord(response.error) ? response.error : {};
    const code = isPublicErrorCode(error.code)
      ? error.code : "host_rpc_failed";
    const message = boundErrorMessage(error.message,"The host request failed.");
    throw new AgentError(code, message, boundErrorDetails(error.details));
  }
  return response.value;
}

/** Asynchronous calls share the port without blocking callbacks or other Runs. */
export class HostAsyncRPC {
  readonly #port: MessagePort;
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(cause: unknown): void }>();
  #closed = false;

  constructor(port: MessagePort) {
    this.#port = port;
    port.on("message", this.#receive);
    port.on("close", this.#close);
  }

  async call(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    requireCondition(!this.#closed && /^[a-z][a-zA-Z0-9_.]{0,127}$/.test(method) &&
      this.#pending.size < 128, "host_rpc_unavailable", "The host request is unavailable.");
    signal.throwIfAborted();
    const fixed = JSON.parse(canonicalJson(params ?? null, bufferBytes - headerBytes)) as unknown;
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const cleanup = () => { this.#pending.delete(id); signal.removeEventListener("abort", abort); };
      // A stop signal requests cancellation. Keep the operation pending until
      // the host reports its real settlement or the channel closes.
      const abort = () => { this.#port.postMessage({ type: "cancel", id }); };
      this.#pending.set(id, { resolve: (value) => { cleanup();
        if (signal.aborted) reject(signal.reason); else resolve(value); },
        reject: (cause) => { cleanup(); reject(cause); } });
      signal.addEventListener("abort", abort, { once: true });
      try { this.#port.postMessage({ type: "async-request", id, method, params: fixed }); }
      catch (cause) { cleanup(); reject(cause); }
    });
  }

  readonly #receive = (value: unknown): void => {
    if (!isPlainRecord(value) || value.type !== "async-response" || typeof value.id !== "string") return;
    const entry = this.#pending.get(value.id);
    if (!entry) return;
    if (value.ok === true) entry.resolve(value.value);
    else {
      const error = isPlainRecord(value.error) ? value.error : {};
      const code = isPublicErrorCode(error.code)
        ? error.code : "host_rpc_failed";
      const message = boundErrorMessage(error.message,"The host request failed.");
      entry.reject(new AgentError(code, message, boundErrorDetails(error.details)));
    }
  };

  readonly #close = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.off("message", this.#receive);
    this.#port.off("close", this.#close);
    for (const entry of this.#pending.values())
      entry.reject(new AgentError("host_rpc_closed", "The host request channel closed."));
    this.#pending.clear();
  };

  close(): void { this.#close(); }
}

/** The host owns the port and may safely await Go without blocking its event loop. */
export function serveSyncRPC(port: MessagePort, handler: RequestHandler): () => void {
  const active = new Map<string, { buffer?: SharedArrayBuffer; controller: AbortController }>();
  let closed = false;
  const reply = (buffer: SharedArrayBuffer, value: unknown): void => {
    const header = new Int32Array(buffer, 0, 2);
    let payload: Buffer;
    try {
      payload = encode(value);
    } catch {
      payload = encode({ ok: false, error: { code: "host_rpc_response_too_large", message: "The host response exceeds its budget." } });
    }
    if (Atomics.compareExchange(header, 0, pending, writing) !== pending) return;
    new Uint8Array(buffer, headerBytes, payload.length).set(payload);
    Atomics.store(header, 1, payload.length);
    Atomics.store(header, 0, finished);
    Atomics.notify(header, 0);
  };
  const receive = (value: unknown): void => {
    if (!isPlainRecord(value) || typeof value.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.id)) return;
    if (value.type === "cancel") {
      active.get(value.id)?.controller.abort();
      return;
    }
    if (value.type === "async-request") {
      if (closed || typeof value.method !== "string" || !/^[a-z][a-zA-Z0-9_.]{0,127}$/.test(value.method) ||
        active.has(value.id)) return;
      const id = value.id;
      const send = (payload: Record<string, unknown>) => {
        if (!closed) port.postMessage({ type: "async-response", id, ...payload });
      };
      if (active.size >= 128) { send({ ok: false, error: { code: "host_rpc_busy", message: "The host is busy." } }); return; }
      const controller = new AbortController();
      active.set(id, { controller });
      void Promise.resolve().then(() => handler(value.method as string, value.params, controller.signal))
        .then((result) => {
          const fixed = JSON.parse(canonicalJson(result ?? null, bufferBytes - headerBytes)) as unknown;
          send({ ok: true, value: fixed });
        }).catch((cause: unknown) => send({ ok: false, error: safeErrorData(cause,
          { code: "host_rpc_failed", message: "The host request failed." }) }))
        .finally(() => active.delete(id));
      return;
    }
    if (!(value.buffer instanceof SharedArrayBuffer) || value.buffer.byteLength !== bufferBytes) return;
    const buffer = value.buffer;
    if (closed || value.type !== "request" || typeof value.method !== "string" ||
      !/^[a-z][a-zA-Z0-9_.]{0,127}$/.test(value.method) || active.has(value.id)) return;
    if (active.size >= 128) {
      reply(buffer, { ok: false, error: { code: "host_rpc_busy", message: "The host is busy." } });
      return;
    }
    const controller = new AbortController();
    const id = value.id;
    active.set(id, { buffer, controller });
    void Promise.resolve().then(() => handler(value.method as string, value.params, controller.signal))
      .then((result) => reply(buffer, { ok: true, value: result ?? null }), (cause: unknown) => {
        reply(buffer, { ok: false, error: safeErrorData(cause,
          { code: "host_rpc_failed", message: "The host request failed." }) });
      }).finally(() => active.delete(id));
  };
  const stop = (): void => {
    if (closed) return;
    closed = true;
    port.off("message", receive);
    port.off("close", stop);
    for (const { buffer, controller } of active.values()) {
      controller.abort();
      if (buffer) reply(buffer, { ok: false, error: { code: "host_rpc_closed", message: "The host request channel closed." } });
    }
    active.clear();
  };
  port.on("message", receive);
  port.on("close", stop);
  return stop;
}
