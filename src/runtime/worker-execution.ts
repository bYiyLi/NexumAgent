import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { isDeepStrictEqual, types } from "node:util";
import { serialize } from "node:v8";
import { AgentError, isAgentError, requireCondition } from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import { mcpResult } from "../results/mcp.js";
import { snapshotBlob } from "../results/artifacts.js";
import { outputIntent } from "../sdk/output.js";
import { transferOffer } from "../transfer/offers.js";
import { packWorkerBinary, unpackWorkerBinary } from "./worker-binary.js";
import type { ModuleUse } from "./modules.js";

export interface WorkerCompile {
  work: string;
  code: string;
  context: unknown;
  bindings: Readonly<Record<string, unknown>>;
  policy: { builtins: readonly string[]; approvedPackages: readonly [string, string][] };
  filename?: string;
  console?: Console;
  signal?: AbortSignal;
  onModule?: (use: ModuleUse) => void;
  onScriptError?: (value: {
    exceptionType: string;
    location?: { source: string; line: number; column?: number };
  }) => void;
  /** Core-owned structured diagnostics only; no script contents or arguments. */
  onDiagnostic?: (event: {
    readonly stage: string;
    readonly code: string;
    readonly workerId: string;
    readonly threadId: number;
    readonly durationMs: number;
  }) => void;
  onRootReturned?: () => void;
}

export type IsolatedExecution = (() => Promise<unknown>) & {
  close(): Promise<void>;
  flushCallbacks(): Promise<void>;
  audit(): Promise<void>;
};

const maxRpc = 1024;
const maxDepth = 24;
const syncBytes = 64 * 1024;
const syncHeaderBytes = 8;
const validSegment = /^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,256}$/;
function aliasTree(
  bindings: Readonly<Record<string, unknown>>,
  token: string,
): { template: Record<string, unknown>;
  handlers: Map<string, Function>;
  bindingHandles: Map<string, object> } {
  const handlers = new Map<string, Function>();
  const bindingHandles = new Map<string, object>();
  const visit = (value: unknown, keys: string[], depth: number): unknown => {
    requireCondition(depth <= 8,
    "worker_binding_invalid", "The SDK binding graph cannot be transferred.");
    if (typeof value === "function") {
      handlers.set(JSON.stringify(keys), value);
      return true;
    }
    if (value === null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
        types.isSharedArrayBuffer(value) || value instanceof Blob ||
        value instanceof Date || value instanceof Map ||
        value instanceof Set) {
      const id = randomUUID();
      bindingHandles.set(id, value);
      return { __nexumBindingData: id,
        data: packWorkerBinary(value, token) ?? structuredClone(value) };
    }
    requireCondition(isPlainRecord(value) || Array.isArray(value),
      "worker_binding_invalid", "SDK constant bindings must be plain data.");
    const data = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      requireCondition((keys.length === 0 ? validSegment.test(key) : key.length <= 8192) &&
        "value" in descriptor,
        "worker_binding_invalid", "SDK bindings need stable named properties.");
      data[key] = visit(descriptor.value, [...keys, key], depth + 1);
    }
    return data;
  };
  return {
    template: visit(bindings, [], 0) as Record<string, unknown>,
    handlers,
    bindingHandles,
  };
}

function decode(
  value: unknown,
  handles: ReadonlyMap<string, { value: unknown; snapshot?: unknown }>,
  token: string,
  depth = 0,
): unknown {
  requireCondition(depth <= maxDepth, "worker_message_invalid",
    "Worker data exceeds the nested value budget.");
  if (!value || typeof value !== "object") return value;
  const binary = unpackWorkerBinary(value, token);
  if (binary !== undefined) return binary;
  if (types.isMap(value)) return new Map([...value].map(([key, item]) =>
    [decode(key, handles, token, depth + 1), decode(item, handles, token, depth + 1)]));
  if (types.isSet(value)) return new Set([...value].map((item) => decode(item, handles, token, depth + 1)));
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
      value instanceof Blob || value instanceof Date ||
      value instanceof Map || value instanceof Set || types.isRegExp(value))
    return value;
  if (Array.isArray(value))
    return value.map((entry) => decode(entry, handles, token, depth + 1));
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length === 1 && keys[0] === "__nexumIntent") {
    const id = source.__nexumIntent;
    requireCondition(typeof id === "string" && handles.has(id),
      "worker_result_invalid", "The output intent belongs to another run.");
    return handles.get(id)!.value;
  }
  if (keys.length === 1 && keys[0] === "__nexumOfferHandle") {
    const id = source.__nexumOfferHandle;
    requireCondition(typeof id === "string" && handles.has(id) &&
      transferOffer(handles.get(id)!.value),
    "worker_result_invalid", "The transfer offer belongs to another Run.");
    return handles.get(id)!.value;
  }
  if (keys.includes("__nexumMcpHandle")) {
    const id = source.__nexumMcpHandle;
    requireCondition(typeof id === "string" && handles.has(id),
      "worker_result_invalid", "The MCP result belongs to another run.");
    const handle = handles.get(id)!;
    const valueWithoutHandle = { ...source };
    delete valueWithoutHandle.__nexumMcpHandle;
    requireCondition(handle.snapshot !== undefined &&
      isDeepStrictEqual(valueWithoutHandle, handle.snapshot),
      "worker_result_invalid",
      "A branded MCP result changed after its source was verified.");
    return handle.value;
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(source))
    result[key] = decode(item, handles, token, depth + 1);
  return result;
}

/** One untrusted JavaScript execution per Worker; SDK authority stays in Core. */
export async function compileWorker(
  options: WorkerCompile,
): Promise<IsolatedExecution> {
  options.signal?.throwIfAborted();
  const bootId = "runworker_" + randomUUID().replaceAll("-", "");
  const { template, handlers, bindingHandles } = aliasTree(options.bindings, bootId);
  const context = structuredClone(options.context);
  const syncReplyChannel = new MessageChannel();
  const worker = new Worker(new URL("./worker-entry.js", import.meta.url), {
    workerData: {
      work: options.work, bootId, code: options.code,
      context, template, policy: options.policy, filename: options.filename,
      syncReplyPort: syncReplyChannel.port2,
    },
    transferList: [syncReplyChannel.port2],
    // Native Node VM support is required for the same checked ModuleLoader.
    execArgv: process.execArgv.includes("--experimental-vm-modules")
      ? ["--experimental-vm-modules"] : process.execArgv,
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  const createdAt = performance.now();
  const observe = (stage: string, code: string) => {
    try {
      options.onDiagnostic?.({
        stage, code, workerId: bootId, threadId: worker.threadId,
        durationMs: Math.max(0, Math.floor(performance.now() - createdAt)),
      });
    } catch {
      // A logging backend failure never changes a real Run's result.
    }
  };
  observe("spawn", "worker_created");
  const ready = Promise.withResolvers<IsolatedExecution>();
  const result = Promise.withResolvers<unknown>();
  // Mark both Promise owners observed before any asynchronous Worker response.
  void ready.promise.catch(() => {});
  void result.promise.catch(() => {});
  const handles = new Map<string, { value: unknown; snapshot?: unknown }>();
  const issuedErrors = new Map<string, { code: string; message: string }>();
  const callbackReplies = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const callbackTasks = new Set<Promise<unknown>>();
  let callbackFailure: AgentError | undefined;
  let auditResponse: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let prepared = false, started = false, settled = false,
    rootComplete = false, outstanding = 0;
  let stopping: Promise<void> | undefined;
  const finalize = (): Promise<void> => {
    if (stopping) return stopping;
    settled = true;
    auditResponse?.reject(new AgentError("worker_closed",
      "The Worker exited before its asynchronous audit was acknowledged."));
    clearTimeout(prepareTimer);
    options.signal?.removeEventListener("abort", abort);
    stopping = (async () => {
      // Confirm actual Worker exit. Do NOT await pending Core SDK calls here:
      // The host can only cancel an abandoned runtime.requestInput after it
      // observes the guest's returned root value. Waiting here deadlocks it.
      // Core's RunOperations and managed resources own their own cleanup.
      await worker.terminate();
      syncReplyChannel.port1.close();
      observe("shutdown", "worker_terminated");
    })().finally(async () => {
      await rm(path.join(options.work, "tmp", "runtime", bootId),
        { recursive: true, force: true }).catch(() => {});
    });
    return stopping;
  };
  const fail = (code: string, message: string, details?: JsonObject) => {
    if (settled) return;
    observe("failed", code);
    const error = new AgentError(code, message, details);
    const wasPrepared = prepared;
    void finalize().then(() => {
      if (!wasPrepared) ready.reject(error);
      result.reject(error);
    }, () => {
      const unresolved = new AgentError("worker_cleanup_unconfirmed",
        "The JavaScript Worker did not confirm its shutdown.");
      if (!wasPrepared) ready.reject(unresolved);
      result.reject(unresolved);
    });
  };
  const abort = () => fail("run_cancelled", "The Run ended before its Worker settled.");
  const prepareTimer = setTimeout(() =>
    fail("worker_initialization_timeout", "The script Worker did not prepare in time."),
  30_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  worker.on("error", () => fail("worker_failed",
    "The JavaScript Worker failed before completion."));
  worker.on("exit", (code) => {
    if (!settled) fail("worker_exited",
      "The JavaScript Worker exited without a confirmed result.");
  });
  worker.on("message", (message: unknown) => {
    if (settled || !message || typeof message !== "object") return;
    const entry = message as Record<string, unknown>;
    if (entry.type === "ready") {
      if (prepared) return;
      prepared = true;
      observe("prepared", "worker_ready");
      clearTimeout(prepareTimer);
      const run = (() => {
        requireCondition(!started, "worker_already_started",
          "A prepared script Worker can execute only once.");
        started = true;
        observe("execute", "worker_running");
        worker.postMessage({ type: "start" });
        return result.promise;
      }) as IsolatedExecution;
      run.close = finalize;
      run.flushCallbacks = async () => {
        await Promise.allSettled([...callbackTasks]);
        if (callbackFailure) throw callbackFailure;
      };
      run.audit = () => {
        requireCondition(!settled, "worker_closed",
          "The Run Worker has already closed.");
        if (auditResponse) return auditResponse.promise;
        auditResponse = Promise.withResolvers<void>();
        void auditResponse.promise.catch(() => {});
        worker.postMessage({ type: "audit" });
        return auditResponse.promise;
      };
      ready.resolve(run);
      return;
    }
    if (entry.type === "log" && Array.isArray(entry.args)) {
      options.console?.log(...entry.args.slice(0, 20));
      return;
    }
    if (entry.type === "module" && entry.use &&
        typeof entry.use === "object") {
      options.onModule?.(entry.use as unknown as ModuleUse);
      return;
    }
    if (entry.type === "script-error" && entry.diagnostic &&
        typeof entry.diagnostic === "object") {
      options.onScriptError?.(entry.diagnostic as Parameters<NonNullable<
        WorkerCompile["onScriptError"]>>[0]);
      return;
    }
    if (entry.type === "root-returned") {
      options.onRootReturned?.();
      observe("root_returned", "worker_root_returned");
      return;
    }
    if (entry.type === "callback-result" &&
        typeof entry.requestId === "string") {
      const pending = callbackReplies.get(entry.requestId);
      if (!pending) return;
      callbackReplies.delete(entry.requestId);
      if (entry.error && typeof entry.error === "object") {
        const error = entry.error as { code?: string; message?: string };
        pending.reject(new AgentError(
          error.code ?? "worker_callback_failed",
          error.message ?? "The guest callback failed.",
        ));
      } else {
        try { pending.resolve(decode(entry.value, handles, bootId)); }
        catch (cause) { pending.reject(cause); }
      }
      return;
    }
    if (entry.type === "audit-result" && auditResponse) {
      if (entry.ok === true) auditResponse.resolve();
      else {
        const problem = entry.error as { code?: string; message?: string;
          details?: JsonObject } | undefined;
        auditResponse.reject(new AgentError(
          problem?.code ?? "unhandled_async_error",
          problem?.message ?? "The guest Promise audit failed.",
          problem?.details,
        ));
      }
      return;
    }
    if (entry.type === "call" && typeof entry.id === "string" &&
        Array.isArray(entry.path)) {
      if (++outstanding > maxRpc) {
        fail("worker_capacity_exhausted",
          "The Run requested too many concurrent SDK operations.");
        return;
      }
      const keys = entry.path;
      const method = handlers.get(JSON.stringify(keys));
      const sync = entry.sync instanceof SharedArrayBuffer &&
        entry.sync.byteLength === syncHeaderBytes + syncBytes
        ? entry.sync : null;
      const header = sync ? new Int32Array(sync, 0, 2) : null;
      const signalSync = (state: 1 | 2 | 3, message?: unknown): boolean => {
        if (!header || !sync) return false;
        if (state === 3) {
          Atomics.store(header, 0, 3);
          Atomics.notify(header, 0);
          return true;
        }
        // MessagePort uses the native structured-clone semantics required by
        // Blob/File, SharedArrayBuffer and typed views. V8's binary serializer
        // is not equivalent for these values, even when it reports success.
        try {
          syncReplyChannel.port1.postMessage({
            id: entry.id, state, value: message,
          });
          Atomics.store(header, 0, 4);
          Atomics.notify(header, 0);
          return true;
        } catch {
          // Fall through to the bounded V8 scalar/JSON fallback below.
        }
        try {
          const bytes = serialize(message);
          if (bytes.byteLength > syncBytes)
            throw new RangeError("sync buffer budget exceeded");
          new Uint8Array(sync, syncHeaderBytes, bytes.length).set(bytes);
          Atomics.store(header, 1, bytes.byteLength);
          Atomics.store(header, 0, state);
          Atomics.notify(header, 0);
          return true;
        } catch {
          // Keep *synchronous* methods synchronous even for native Shared
          // buffers, Blobs, large audio, etc. A separate MessagePort carries
          // the clone and an atomic signal publishes its availability.
          try {
            syncReplyChannel.port1.postMessage({
              id: entry.id, state, value: message,
            });
            Atomics.store(header, 0, 4);
            Atomics.notify(header, 0);
            return true;
          } catch {
            // This data cannot be sent by either native transfer mechanism.
          }
          return false;
        }
      };
      const safe = (cause: unknown): object => {
        const error = safeErrorData(cause, {
          code: "sdk_call_failed",
          message: "The SDK invocation did not complete.",
        });
        const own = (name: string): unknown => {
          if (!cause || typeof cause !== "object") return undefined;
          const descriptor = Object.getOwnPropertyDescriptor(cause, name);
          return descriptor && "value" in descriptor
            ? descriptor.value : undefined;
        };
        const nativeCode = own("code");
        const stableCode = typeof nativeCode === "string" &&
          /^[A-Za-z_][A-Za-z0-9_-]{0,95}$/.test(nativeCode)
          ? nativeCode : undefined;
        const dispatched = own("dispatched");
        const effect = own("effect");
        const retryable = own("retryable");
        const errorId = isAgentError(cause) && issuedErrors.size < maxRpc
          ? randomUUID() : null;
        if (errorId)
          issuedErrors.set(errorId, {
            code: String(error.code), message: String(error.message),
          });
        const name = cause && typeof cause === "object"
          ? Object.getOwnPropertyDescriptor(cause, "name") : null;
        const causeValue = cause && typeof cause === "object"
          ? Object.getOwnPropertyDescriptor(cause, "cause") : null;
        const safeNativeCause = !isAgentError(cause) &&
          causeValue && "value" in causeValue &&
          Buffer.isBuffer(causeValue.value)
          ? { __nexumBufferBytes: new Uint8Array(causeValue.value) }
          : undefined;
        // OpenAPI exposes an already redacted public HTTP response on a
        // failed operation. Preserve that documented script-facing shape,
        // but never transport arbitrary exception properties or raw headers.
        let publicResponse: object | undefined;
        if (error.code === "api_http_error" && cause &&
            typeof cause === "object") {
          const descriptor = Object.getOwnPropertyDescriptor(cause, "response");
          if (descriptor && "value" in descriptor &&
              isPlainRecord(descriptor.value)) {
            try {
              const status = Object.getOwnPropertyDescriptor(descriptor.value, "status");
              requireCondition(status && "value" in status && Number.isSafeInteger(status.value),
                "invalid_json", "The response status is invalid.");
              const data = Object.getOwnPropertyDescriptor(descriptor.value, "data");
              const binary = data && "value" in data ? snapshotBlob(data.value, 64 * 1024 * 1024) : null;
              if (binary) {
                const fields = Object.getOwnPropertyDescriptors(descriptor.value);
                const safe: Record<string, unknown> = Object.create(null);
                for (const [key, field] of Object.entries(fields)) {
                  if (!field.enumerable) continue;
                  requireCondition("value" in field, "invalid_json", "Response accessors are not supported.");
                  safe[key] = key === "data" ? null : field.value;
                }
                const response = JSON.parse(canonicalJson(safe, 64 * 1024)) as Record<string, unknown>;
                response.data = binary.blob;
                publicResponse = response;
              } else {
                publicResponse = JSON.parse(canonicalJson(
                  descriptor.value, 64 * 1024,
                )) as object;
              }
            } catch {
              // An oversized/invalid response must not cross the boundary.
            }
          }
        }
        return {
          ...error,
          ...(error.code === "sdk_call_failed" && stableCode
            ? { code: stableCode } : {}),
          ...(typeof dispatched === "boolean" ? { dispatched } : {}),
          ...(["none", "unknown", "confirmed"].includes(String(effect))
            ? { effect } : {}),
          ...(typeof retryable === "boolean" ? { retryable } : {}),
          ...(errorId ? { issuedErrorId: errorId } : {}),
          ...(name && "value" in name &&
            name.value === "InputTimeoutError"
            ? { exceptionType: "InputTimeoutError" } : {}),
          ...(publicResponse ? { response: publicResponse } : {}),
          ...(safeNativeCause ? { nativeCause: safeNativeCause } : {}),
        };
      };
      const encode = (value: unknown): unknown => {
        const seen = new WeakMap<object, unknown>();
        const visit = (item: unknown, depth = 0): unknown => {
          requireCondition(depth <= maxDepth, "worker_result_invalid",
            "An SDK result exceeds the nested data budget.");
          if (!item || typeof item !== "object") return item;
          if (seen.has(item)) return seen.get(item);
          const binary = packWorkerBinary(item, bootId);
          if (binary !== undefined) { seen.set(item, binary); return binary; }
          const issuedOutput = outputIntent(item);
          if (issuedOutput) {
            const id = randomUUID();
            const marker: Record<string, unknown> = { __nexumIntent: id };
            handles.set(id, { value: item });
            seen.set(item, marker);
            marker.model = {
              kind: issuedOutput.kind,
              value: visit(issuedOutput.value, depth + 1),
              options: visit(issuedOutput.options, depth + 1),
            };
            return marker;
          }
          const offer = transferOffer(item);
          if (offer) {
            const id = randomUUID();
            const marker: Record<string, unknown> = {
              __nexumOfferEnvelope: id,
            };
            handles.set(id, { value: item });
            seen.set(item, marker);
            marker.model = visit({ ...item }, depth + 1);
            marker.snapshot = structuredClone(offer.snapshot);
            return marker;
          }
          const source = mcpResult(item);
          if (source) {
            const id = randomUUID();
            const snapshot = structuredClone(item) as Record<string, unknown>;
            const marker = {
              __nexumMcpEnvelope: id,
              model: snapshot,
              meta: structuredClone(source.meta),
            };
            handles.set(id, { value: item, snapshot });
            seen.set(item, marker);
            return marker;
          }
          if (Array.isArray(item)) {
            const result: unknown[] = [];
            seen.set(item, result);
            for (const nested of item) result.push(visit(nested, depth + 1));
            return result;
          }
          if (types.isMap(item)) {
            const result = new Map();
            seen.set(item, result);
            for (const [key, value] of item) result.set(visit(key, depth + 1), visit(value, depth + 1));
            return result;
          }
          if (types.isSet(item)) {
            const result = new Set();
            seen.set(item, result);
            for (const value of item) result.add(visit(value, depth + 1));
            return result;
          }
          if (item instanceof Error) {
            const marker: Record<string, unknown> = {
              __nexumNativeError: {
                message: typeof item.message === "string" ? item.message : "",
              },
            };
            seen.set(item, marker);
            const cause = Object.getOwnPropertyDescriptor(item, "cause");
            if (cause && "value" in cause)
              (marker.__nexumNativeError as Record<string, unknown>).cause =
                visit(cause.value, depth + 1);
            return marker;
          }
          if (isPlainRecord(item)) {
            const result = Object.create(null) as Record<string, unknown>;
            seen.set(item, result);
            for (const [key, nested] of Object.entries(item))
              result[key] = visit(nested, depth + 1);
            return result;
          }
          return item;
        };
        return visit(value);
      };
      const postReply = (payload: Record<string, unknown>) => {
        if (settled) return;
        try {
          worker.postMessage({ type: "reply", id: entry.id, ...payload });
        } catch {
          worker.postMessage({ type: "reply", id: entry.id,
            error: { code: "worker_result_invalid",
              message: "The SDK result could not cross the Worker boundary." } });
        }
      };
      try {
        requireCondition(method, "worker_method_unavailable",
          "The requested SDK method is unavailable.");
        const nativeTypes = Array.isArray(entry.nativeTypes)
          ? entry.nativeTypes : [];
        const reconstruct = (value: unknown): unknown => {
          // A valid Core-issued output/transfer/MCP identity was already
          // checked by decode(). Rebuilding the plain object strips its
          // private brand, breaking nested output.result() content.
          if (outputIntent(value) || transferOffer(value) || mcpResult(value))
            return value;
          if (isPlainRecord(value) &&
              Object.keys(value).length === 1 &&
              typeof value.__nexumBoundData === "string") {
            requireCondition(bindingHandles.has(value.__nexumBoundData),
              "worker_message_invalid",
              "The SDK constant belongs to another Run.");
            return bindingHandles.get(value.__nexumBoundData);
          }
          if (isPlainRecord(value) &&
              Object.keys(value).length === 1 &&
              typeof value.__nexumGuestCallback === "string") {
            const callbackId = value.__nexumGuestCallback;
            requireCondition(/^callback_[1-9][0-9]*$/.test(callbackId),
              "worker_message_invalid", "Invalid guest callback identity.");
            return (...args: unknown[]) => {
              requireCondition(!settled && callbackReplies.size < maxRpc,
                "worker_callback_unavailable", "The guest callback is closed.");
              const requestId = randomUUID();
              const pending = Promise.withResolvers<unknown>();
              callbackReplies.set(requestId, pending);
              const task = pending.promise;
              callbackTasks.add(task);
              void task.then(() => callbackTasks.delete(task), () => {
                callbackTasks.delete(task);
                callbackFailure ??= new AgentError("worker_callback_failed",
                  "An accepted guest callback did not complete.");
              });
              void task.catch(() => {});
              try {
                worker.postMessage({
                  type: "invoke-callback", callbackId, requestId, args: args.map(encode),
                });
              } catch {
                pending.reject(new AgentError("worker_callback_invalid",
                  "The callback arguments cannot cross the Worker boundary."));
              }
              return task;
            };
          }
          if (isPlainRecord(value) &&
              typeof value.__nexumIssuedError === "string") {
            const keys = Object.keys(value);
            requireCondition(keys.every((key) =>
              ["__nexumIssuedError", "details"].includes(key)) &&
              issuedErrors.has(value.__nexumIssuedError),
            "worker_message_invalid", "Unknown SDK exception provenance.");
            const issued = issuedErrors.get(value.__nexumIssuedError)!;
            const details = value.details;
            requireCondition(details === undefined || isPlainRecord(details),
              "worker_message_invalid", "Invalid SDK exception details.");
            return new AgentError(issued.code, issued.message,
              details as JsonObject | undefined);
          }
          if (Array.isArray(value)) return value.map(reconstruct);
          if (isPlainRecord(value)) {
            const result = Object.create(null) as Record<string, unknown>;
            for (const [key, one] of Object.entries(value))
              result[key] = reconstruct(one);
            return result;
          }
          return value;
        };
        const args = (entry.args as unknown[]).map((arg, index) => {
          const data = reconstruct(decode(arg, handles, bootId));
          return nativeTypes[index] === "buffer" &&
            data instanceof Uint8Array && !Buffer.isBuffer(data)
            ? Buffer.from(data) : data;
        });
        const reply = (value: unknown): unknown => {
          if (value && typeof value === "object") {
            const index = args.findIndex((arg) => arg === value);
            if (index >= 0) return { __nexumOriginalArg: index };
          }
          return encode(value);
        };
        const returned = Reflect.apply(method, undefined, args);
        if (types.isPromise(returned)) {
          signalSync(3);
          const pending = Promise.resolve(returned)
            .then((value) => postReply({ value: reply(value) }),
              (cause: unknown) => postReply({ error: safe(cause) }))
            .catch(() => {})
            .finally(() => { outstanding--; });
          void pending;
        } else {
          const value = reply(returned);
          if (!signalSync(1, value)) {
            signalSync(3);
            postReply({ value });
          }
          outstanding--;
        }
      } catch (cause) {
        const error = safe(cause);
        if (!signalSync(2, error)) {
          signalSync(3);
          postReply({ error });
        }
        outstanding--;
      }
      return;
    }
    if (entry.type === "done") {
      try {
        if (rootComplete) return;
        const value = decode(entry.value, handles, bootId);
        observe("completed", "worker_completed");
        rootComplete = true;
        // The Root can finish while Core-owned accepted SDK operations still
        // need a guest callback. Core closes the Worker after their settlement.
        result.resolve(value);
      } catch {
        fail("worker_result_invalid",
          "The script Worker produced an invalid result.");
      }
      return;
    }
    if (entry.type === "failed") {
      const details: JsonObject = entry.details && typeof entry.details === "object" &&
        !Array.isArray(entry.details) ? { ...entry.details as JsonObject } : {};
      if (entry.diagnostic && typeof entry.diagnostic === "object") {
        const diagnostic = entry.diagnostic as Parameters<NonNullable<
          WorkerCompile["onScriptError"]>>[0];
        options.onScriptError?.(diagnostic);
        // The Worker computed these from the original script realm. Only
        // carry bounded script-relative coordinates, never the raw stack or
        // an absolute filename, through IPC and into retained Run errors.
        if (["Error", "SyntaxError", "TypeError", "ReferenceError", "RangeError",
          "URIError", "EvalError", "AggregateError"].includes(diagnostic.exceptionType)) {
          details.exceptionType = diagnostic.exceptionType;
          const location = diagnostic.location;
          if (location && Number.isSafeInteger(location.line) && location.line > 0) {
            details.location = {
              line: location.line,
              ...(typeof location.column === "number" && Number.isSafeInteger(location.column) &&
                location.column > 0 ? { column: location.column } : {}),
            };
          }
        }
      }
      fail(typeof entry.code === "string" &&
        /^[a-z][a-z0-9_]{0,127}$/.test(entry.code)
        ? entry.code : "worker_script_failed",
      typeof entry.message === "string" && entry.message.length <= 1024
        ? entry.message : "The script Worker reported an execution failure.",
      Object.keys(details).length ? details : undefined);
    }
  });
  return ready.promise;
}
