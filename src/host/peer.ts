import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { AgentError, isAgentError } from "../contracts/errors.js";
import { safeErrorData, isPublicErrorCode, boundErrorMessage, boundErrorDetails } from "../contracts/error-data.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";

export const protocolVersion = 1;
export const maxFrameBytes = 16 * 1024 * 1024;
const maxPending = 256;

type RpcError = { code: number; message: string; data?: unknown };
type Message = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: RpcError };
type Handler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown> | unknown;

export class Peer {
  readonly #reader: Readable;
  readonly #writer: Writable;
  readonly #handler: Handler;
  readonly #lifetime = new AbortController();
  readonly #active = new Map<string, AbortController>();
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  #next = 0;
  #incoming = 0;
  #buffer = "";
  #decoder = new StringDecoder("utf8");
  #closed = false;

  constructor(reader: Readable, writer: Writable, handler: Handler) {
    this.#reader = reader;
    this.#writer = writer;
    this.#handler = handler;
  }

  get signal(): AbortSignal { return this.#lifetime.signal; }

  start(): void {
    this.#reader.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      this.#buffer += this.#decoder.write(chunk);
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > maxFrameBytes) return this.close(new Error("agent IPC frame too large"));
        try { this.#receive(JSON.parse(line) as unknown); }
        catch { return this.close(new Error("invalid agent IPC message")); }
      }
      if (Buffer.byteLength(this.#buffer) > maxFrameBytes) this.close(new Error("agent IPC frame too large"));
    });
    this.#reader.on("end", () => this.close(new Error("agent IPC closed")));
    this.#reader.on("error", (error) => this.close(error));
    this.#writer.on("error", (error) => this.close(error));
  }

  close(error = new Error("agent IPC closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#reader.destroy();
  }

  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error("agent IPC closed");
    if (this.#pending.size >= maxPending) throw new Error("agent IPC busy");
    if (signal?.aborted) throw signal.reason;
    const id = String(++this.#next);
    return await new Promise<unknown>((resolve, reject) => {
      let cancelled = false;
      const abort = () => {
        cancelled = true;
        try { this.#send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }); }
        catch (error) { this.close(error instanceof Error ? error : new Error("agent IPC cancellation failed")); }
      };
      const done = (callback: () => void) => { signal?.removeEventListener("abort", abort); callback(); };
      this.#pending.set(id, {
        resolve: (value) => done(() => cancelled ? reject(signal?.reason) : resolve(value)),
        reject: (error) => done(() => reject(this.#closed ? error : cancelled ? signal?.reason : error)),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.#send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.#pending.delete(id); done(() => reject(error)); }
    });
  }

  notify(method: string, params: unknown): void { this.#send({ jsonrpc: "2.0", method, params }); }

  #send(message: Message): void {
    if (this.#closed) throw new Error("agent IPC closed");
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > maxFrameBytes) throw new Error("agent IPC frame too large");
    if (this.#writer.writableLength + Buffer.byteLength(line) + 1 > maxFrameBytes) {
      throw new Error("agent IPC write budget exceeded");
    }
    this.#writer.write(line + "\n");
  }

  #receive(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid message");
    const message = value as Message;
    if (message.jsonrpc !== "2.0") throw new Error("invalid version");
    if (typeof message.method === "string" && message.method) {
      if (message.method === "$/cancelRequest" && message.id === undefined) {
        const params = message.params;
        if (isPlainRecord(params) && (typeof params.id === "string" || typeof params.id === "number")) {
          this.#active.get(JSON.stringify(params.id))?.abort();
        }
        return;
      }
      if (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number") throw new Error("invalid id");
      if (this.#incoming >= maxPending) {
        if (message.id !== undefined) this.#send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "agent IPC busy" } });
        return;
      }
      const key = message.id === undefined ? undefined : JSON.stringify(message.id);
      if (key !== undefined && this.#active.has(key)) throw new Error("duplicate request id");
      const controller = new AbortController();
      const abort = () => controller.abort(this.#lifetime.signal.reason);
      this.#lifetime.signal.addEventListener("abort", abort, { once: true });
      if (key !== undefined) this.#active.set(key, controller);
      this.#incoming++;
      void Promise.resolve().then(() => this.#handler(message.method!, message.params, controller.signal)).then(
        (result) => { if (message.id !== undefined) this.#send({ jsonrpc: "2.0", id: message.id, result: result ?? null }); },
        (cause: unknown) => {
          if (message.id === undefined) return;
          const data = isAgentError(cause)
            ? safeErrorData(cause, { code: "host_error", message: "The host request failed." })
            : undefined;
          this.#send({ jsonrpc: "2.0", id: message.id,
            error: { code: -32603, message: "internal error", ...(data ? { data } : {}) } });
        },
      ).catch(() => this.close()).finally(() => {
        this.#incoming--;
        this.#lifetime.signal.removeEventListener("abort", abort);
        if (key !== undefined) this.#active.delete(key);
      });
      return;
    }
    if (typeof message.id !== "string" || (Object.hasOwn(message, "result") === Object.hasOwn(message, "error"))) throw new Error("invalid response");
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      const data = message.error.data;
      if (isPlainRecord(data) && isPublicErrorCode(data.code)) {
        const error = new AgentError(data.code, boundErrorMessage(data.message,"The host request failed."), boundErrorDetails(data.details,data));
        if (data.code === "api_http_error" && isPlainRecord(data.response) &&
            Number.isSafeInteger(data.response.status)) {
          try {
            const response = JSON.parse(canonicalJson(data.response, 64 * 1024)) as JsonObject;
            Object.defineProperty(error, "response", { value: response, enumerable: true, configurable: true });
            if (Array.isArray(data.binaryOutputs))
              Object.defineProperty(error, "binaryOutputs", { value: data.binaryOutputs });
            error.name = "OpenApiHttpError";
          } catch {
            // Invalid or oversized error response data stays outside the Worker.
          }
        }
        pending.reject(error);
      } else pending.reject(new Error(`agent IPC error ${message.error.code}: ${message.error.message}`));
    }
    else pending.resolve(message.result);
  }
}
