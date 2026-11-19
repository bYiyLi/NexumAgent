import {
  parentPort, workerData, receiveMessageOnPort, type MessagePort,
} from "node:worker_threads";
import { deserialize } from "node:v8";
import { AgentError, isAgentError } from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import { isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import { ModuleLoader } from "./modules.js";
import { NativePromiseAudit } from "./promises.js";
import { types } from "node:util";

interface WorkerStart {
  work: string;
  bootId: string;
  code: string;
  context: unknown;
  template: Record<string, unknown>;
  policy: { builtins: string[]; approvedPackages: [string, string][] };
  filename?: string;
  syncReplyPort: MessagePort;
}
const port = parentPort;
if (!port) throw new Error("A script Worker needs its original Core port.");
const data = workerData as WorkerStart;
const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
const originalArgs = new Map<string, readonly unknown[]>();
const issuedErrors = new WeakMap<object, string>();
const guestCallbacks = new Map<string, (...args: unknown[]) => unknown>();
const outputIntents = new WeakMap<object, Promise<unknown>>();
const issuedIntentViews = new WeakMap<object, string>();
const issuedOfferViews = new WeakMap<object, { id: string; snapshot: unknown }>();
const bindingViews = new WeakMap<object, string>();
const mcpViews = new WeakMap<object, { id: string; snapshot: Record<string, unknown> }>();
const inFlight = new Set<Promise<unknown>>();
const outputKinds: Readonly<Record<string, string>> = Object.freeze({
  text: "text", json: "json", image: "image", images: "collection",
  audio: "audio", resourceLink: "resource_link", file: "resource_link",
  embeddedResource: "resource", resource: "resource",
  result: "result", error: "result",
});
let counter = 0;
let started = false;
let lastScriptDiagnostic: {
  exceptionType: string;
  location?: { source: string; line: number; column?: number };
} | undefined;
const syncBytes = 64 * 1024;
const syncHeaderBytes = 8;
const send = (value: object) => port.postMessage(value);

/** Preserve bounded factual status from an already verified Core error,
 * without transporting arbitrary exception properties or private targets. */
function attachFailureFacts(
  error: AgentError,
  facts: {
    dispatched?: unknown; effect?: unknown; retryable?: unknown;
  },
): void {
  if (typeof facts.dispatched === "boolean")
    Object.defineProperty(error, "dispatched", {
      value: facts.dispatched, enumerable: true,
    });
  if (typeof facts.retryable === "boolean")
    Object.defineProperty(error, "retryable", {
      value: facts.retryable, enumerable: true,
    });
  if (["none", "confirmed", "unknown"].includes(String(facts.effect)))
    Object.defineProperty(error, "effect", {
      value: facts.effect, enumerable: true,
    });
}

/** A Core-issued MCP result has private protocol _meta slots. Restore them
 * as non-enumerable, read-only guest properties. Ordinary logs and JSON copies
 * cannot accidentally publish these fields, while the original brand stays
 * exclusively in Core for its final result encoder. */
function fromCore(
  value: unknown, depth = 0,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (depth > 24) throw new AgentError("worker_reply_invalid",
    "A Core SDK response exceeded the nested data budget.");
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const one of value)
      result.push(fromCore(one, depth + 1, seen));
    return result;
  }
  if (!isPlainRecord(value)) return value;
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.__nexumBufferBytes === "object" &&
      envelope.__nexumBufferBytes instanceof Uint8Array &&
      Object.keys(envelope).length === 1) {
    const bytes = envelope.__nexumBufferBytes;
    const exact = bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
    );
    const buffer = Buffer.from(exact);
    seen.set(value, buffer);
    return buffer;
  }
  if (isPlainRecord(envelope.__nexumNativeError) &&
      Object.keys(envelope).length === 1) {
    const model = envelope.__nexumNativeError;
    const error = new Error(
      typeof model.message === "string" ? model.message : "",
    );
    seen.set(value, error);
    if (Object.hasOwn(model, "cause"))
      Object.defineProperty(error, "cause", {
        value: fromCore(model.cause, depth + 1, seen),
        enumerable: false,
      });
    return error;
  }
  if (typeof envelope.__nexumIntent === "string" &&
      isPlainRecord(envelope.model)) {
    const model = fromCore(envelope.model, depth + 1, seen) as Record<string, unknown>;
    seen.set(value, model);
    issuedIntentViews.set(model, envelope.__nexumIntent);
    return Object.freeze(model);
  }
  if (typeof envelope.__nexumOfferEnvelope === "string" &&
      isPlainRecord(envelope.model) && isPlainRecord(envelope.snapshot)) {
    const model = fromCore(envelope.model, depth + 1, seen) as Record<string, unknown>;
    const snapshot = fromCore(envelope.snapshot, depth + 1, seen);
    Object.defineProperty(model, "toJSON", {
      value: () => snapshot, enumerable: false,
    });
    seen.set(value, model);
    issuedOfferViews.set(model, {
      id: envelope.__nexumOfferEnvelope, snapshot,
    });
    return Object.freeze(model);
  }
  if (typeof envelope.__nexumMcpEnvelope === "string" &&
      isPlainRecord(envelope.model) && Array.isArray(envelope.meta)) {
    const model = fromCore(envelope.model, depth + 1, seen) as Record<string, unknown>;
    seen.set(value, model);
    const item = (input: unknown): Record<string, unknown> | undefined =>
      isPlainRecord(input) ? input : undefined;
    const entries = (input: unknown): unknown[] | undefined =>
      Array.isArray(input) ? input : undefined;
    for (const slot of envelope.meta) {
      if (!isPlainRecord(slot) || !isPlainRecord(slot.meta)) continue;
      const index = typeof slot.index === "number" &&
        Number.isSafeInteger(slot.index) ? slot.index : -1;
      let target: Record<string, unknown> | undefined;
      if (slot.target === "result") target = model;
      else if (slot.target === "content")
        target = item(entries(model.content)?.[index]);
      else if (slot.target === "resource")
        target = item(entries(model.contents)?.[index]) ??
          item(item(entries(model.content)?.[index])?.resource);
      else if (slot.target === "message")
        target = item(entries(item(model.structuredContent)?.messages)?.[index]);
      else if (slot.target === "entry" && typeof slot.collection === "string")
        target = item(entries(item(model.structuredContent)?.[slot.collection])?.[index]);
      if (target && !Object.hasOwn(target, "_meta"))
        Object.defineProperty(target, "_meta", {
          value: slot.meta, enumerable: false,
        });
    }
    const snapshot = structuredClone(model);
    const freeze = (item: unknown, depth = 0): void => {
      if (depth > 24 || !item || typeof item !== "object" ||
          (!Array.isArray(item) && !isPlainRecord(item))) return;
      for (const nested of Object.values(item)) freeze(nested, depth + 1);
      Object.freeze(item);
    };
    freeze(model);
    mcpViews.set(model, {
      id: envelope.__nexumMcpEnvelope, snapshot,
    });
    return model;
  }
  const result = Object.create(null) as Record<string, unknown>;
  seen.set(value, result);
  for (const [key, nested] of Object.entries(envelope))
    result[key] = fromCore(nested, depth + 1, seen);
  return result;
}
/** Resolve pending output helpers and make ordinary result data cloneable.
 * Do not invoke user getters or conversion hooks; native bytes and dates pass
 * through unchanged. SDK arguments stay strict unless resultData is enabled. */
async function settle(
  value: unknown,
  depth = 0,
  resultData = false,
): Promise<unknown> {
  if (depth > 24) throw new AgentError("worker_arguments_invalid",
    "Nested SDK arguments exceed the value depth limit.");
  // Functions and Symbols are valid JavaScript values, but cannot cross the
  // Worker data channel. Keep them as undefined for the JSON result normalizer.
  if (resultData && (typeof value === "function" || typeof value === "symbol"))
    return undefined;
  if (value instanceof Promise) return settle(await value, depth + 1, resultData);
  if (value && typeof value === "object" && outputIntents.has(value))
    return settle(await outputIntents.get(value), depth + 1, resultData);
  if (value && typeof value === "object" && issuedIntentViews.has(value))
    return { __nexumIntent: issuedIntentViews.get(value)! };
  if (value && typeof value === "object" && issuedOfferViews.has(value))
    return { __nexumOfferHandle: issuedOfferViews.get(value)!.id };
  if (value && typeof value === "object" && bindingViews.has(value))
    return { __nexumBoundData: bindingViews.get(value)! };
  if (value && typeof value === "object" && mcpViews.has(value)) {
    const entry = mcpViews.get(value)!;
    return { ...entry.snapshot, __nexumMcpHandle: entry.id };
  }
  if (Array.isArray(value))
    return Promise.all(value.map((item) => settle(item, depth + 1, resultData)));
  if (resultData && types.isMap(value)) {
    const entries: [unknown, unknown][] = [];
    Map.prototype.forEach.call(value, (item: unknown, key: unknown) =>
      entries.push([key, item]));
    const resolved: [unknown, unknown][] = [];
    let nonCloneableKeys = false;
    for (const [key, item] of entries) {
      if (typeof key === "function" || typeof key === "symbol")
        nonCloneableKeys = true;
      resolved.push([
        await settle(key, depth + 1, resultData),
        await settle(item, depth + 1, resultData),
      ]);
    }
    // Replacing distinct Symbol/function keys with undefined in a Map would
    // silently collapse entries. Keep every entry as a JSON-compatible pair.
    return nonCloneableKeys ? resolved : new Map(resolved);
  }
  if (resultData && types.isSet(value)) {
    const entries: unknown[] = [];
    Set.prototype.forEach.call(value, (item: unknown) => entries.push(item));
    const resolved: unknown[] = [];
    let nonCloneableValues = false;
    for (const item of entries) {
      if (typeof item === "function" || typeof item === "symbol")
        nonCloneableValues = true;
      resolved.push(await settle(item, depth + 1, resultData));
    }
    return nonCloneableValues ? resolved : new Set(resolved);
  }
  if (isPlainRecord(value)) {
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor))
        throw new AgentError("worker_arguments_invalid",
          "SDK data cannot contain accessors.");
      result[key] = await settle(descriptor.value, depth + 1, resultData);
    }
    return result;
  }
  return value;
}

function buildBindings(template: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown, prefix: string[]): unknown => {
    if (isPlainRecord(value) &&
        typeof value.__nexumBindingData === "string" &&
        "data" in value) {
      const result = value.isBuffer &&
        value.data instanceof Uint8Array
        ? Buffer.from(value.data) : fromCore(value.data);
      if (result && typeof result === "object")
        bindingViews.set(result, value.__nexumBindingData);
      return result;
    }
    if (value === true) {
      const invoke = (...args: unknown[]) => {
        let inspected = 0;
        const unsafe = (value: unknown, depth = 0): boolean => {
          if (depth > 24 || !value || typeof value !== "object")
            return depth > 24;
          // The node budget protects object graphs, not each byte in a
          // plain numeric array (for example a screenshot passed to evaluate).
          if (++inspected > 4096 ||
              (Array.isArray(value) && value.length > 1024 * 1024)) return true;
          if (types.isProxy(value)) return true;
          if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
              value instanceof Blob || value instanceof Date ||
              value instanceof Map || value instanceof Set ||
              value instanceof Error) return false;
          if (!isPlainRecord(value) && !Array.isArray(value)) return false;
          for (const descriptor of Object.values(
            Object.getOwnPropertyDescriptors(value))) {
            if (descriptor.enumerable &&
                (!("value" in descriptor) ||
                  unsafe(descriptor.value, depth + 1))) return true;
          }
          return false;
        };
        if (args.some((arg) => unsafe(arg)))
          throw new AgentError(
            prefix[0] === "sh" ? "invalid_process_arguments"
              : "worker_arguments_invalid",
            "The SDK input cannot contain accessors or unsafe object graphs.",
          );
        const id = "call_" + (++counter);
        originalArgs.set(id, args);
        const pending = Promise.withResolvers<unknown>();
        waiting.set(id, pending);
        const buffer = new SharedArrayBuffer(syncHeaderBytes + syncBytes);
        const header = new Int32Array(buffer, 0, 2);
        // Guest Buffer and AgentError identities are not preserved by the
        // structured-clone algorithm. Encode only the exact, supported types
        // without evaluating guest getters or toJSON implementations.
        const transfer = (value: unknown): unknown => {
          if (value && typeof value === "object" &&
              bindingViews.has(value))
            return { __nexumBoundData: bindingViews.get(value)! };
          if (value && typeof value === "object" &&
              issuedIntentViews.has(value))
            return { __nexumIntent: issuedIntentViews.get(value)! };
          if (value && typeof value === "object" &&
              issuedOfferViews.has(value))
            return { __nexumOfferHandle: issuedOfferViews.get(value)!.id };
          if (typeof value === "function") {
            const callbackId = "callback_" + (++counter);
            guestCallbacks.set(callbackId, value as (...args: unknown[]) => unknown);
            return { __nexumGuestCallback: callbackId };
          }
          if (isAgentError(value) && issuedErrors.has(value)) {
            const issue = safeErrorData(value, {
              code: "sdk_call_failed",
              message: "The SDK invocation failed.",
            });
            return {
              __nexumIssuedError: issuedErrors.get(value)!,
              ...(issue.details === undefined ? {} : { details: issue.details }),
            };
          }
          return value;
        };
        const supplied = args.map(transfer);
        const nativeTypes = args.map((value) =>
          Buffer.isBuffer(value) ? "buffer" : null);
        try {
          // The fast path preserves SDK methods which return or throw
          // synchronously. This blocks ONLY the guest Worker; Core stays
          // responsive and applies every existing authorization check.
          send({ type: "call", id, path: prefix, args: supplied,
            nativeTypes, sync: buffer });
        } catch {
          // Promise-containing arguments cannot be structured-cloned.
          // Preserve the asynchronous contract only for such arguments.
          void Promise.all(args.map((one) => settle(one)))
            .then((fixed) => send({ type: "call", id, path: prefix,
              args: fixed.map(transfer), nativeTypes }),
              (cause: unknown) => {
                waiting.delete(id);
                originalArgs.delete(id);
                pending.reject(cause);
              }).catch((cause) => {
              waiting.delete(id);
              originalArgs.delete(id);
              pending.reject(cause);
            });
          return pending.promise;
        }
        if (Atomics.load(header, 0) === 0)
          Atomics.wait(header, 0, 0, 30_000);
        let status = Atomics.load(header, 0);
        if (status === 3) return pending.promise;
        waiting.delete(id);
        originalArgs.delete(id);
        if (status === 0) throw new AgentError("worker_rpc_timeout",
          "The Core did not acknowledge the original SDK call. Do not replay it.");
        let response: unknown;
        if (status === 4) {
          const transferred = receiveMessageOnPort(data.syncReplyPort)?.message;
          if (!transferred || transferred.id !== id ||
              ![1, 2].includes(transferred.state))
            throw new AgentError("worker_rpc_invalid",
              "The large synchronous reply has no matching Core identity.");
          status = transferred.state;
          response = transferred.value;
        } else {
          const count = Atomics.load(header, 1);
          if (count < 1 || count > syncBytes)
            throw new AgentError("worker_rpc_invalid",
              "The SDK reply has an invalid length.");
          const bytes = Buffer.from(
            new Uint8Array(buffer, syncHeaderBytes, count),
          );
          response = deserialize(bytes);
        }
        if (status === 1) {
          if (isPlainRecord(response) &&
              Object.keys(response).length === 1 &&
              typeof response.__nexumOriginalArg === "number" &&
              Number.isInteger(response.__nexumOriginalArg) &&
              response.__nexumOriginalArg >= 0 &&
              response.__nexumOriginalArg < args.length)
            return args[response.__nexumOriginalArg];
          return fromCore(response);
        }
        if (status === 2) {
          const issue = response as {
            code?: string; message?: string; details?: JsonObject;
            exceptionType?: string; response?: JsonObject;
            issuedErrorId?: string; nativeCause?: object;
            dispatched?: boolean; effect?: string; retryable?: boolean;
          };
          const error = new AgentError(
            typeof issue.code === "string" ? issue.code : "sdk_call_failed",
            typeof issue.message === "string"
              ? issue.message : "The SDK invocation failed.",
            issue.details,
          );
          if (issue.exceptionType === "InputTimeoutError")
            error.name = "InputTimeoutError";
          attachFailureFacts(error, issue);
          if (issue.code === "api_http_error" && isPlainRecord(issue.response))
            Object.defineProperty(error, "response", {
              value: fromCore(issue.response), enumerable: false,
            });
          if (typeof issue.issuedErrorId === "string")
            issuedErrors.set(error, issue.issuedErrorId);
          if (issue.nativeCause)
            Object.defineProperty(error, "cause", {
              value: fromCore(issue.nativeCause), enumerable: false,
            });
          throw error;
        }
        throw new AgentError("worker_rpc_invalid",
          "The SDK reply has an invalid state.");
      };
      if (prefix.length === 2 && prefix[0] === "output" &&
          Object.hasOwn(outputKinds, prefix[1]!)) {
        return (...args: unknown[]) => {
          const result = Object.freeze({ kind: outputKinds[prefix[1]!] });
          // Explicit result content may contain earlier output helpers. Their
          // Core identities must exist before the enclosing result is built;
          // a cloneable placeholder is not a valid MCP content block.
          const task = prefix[1] === "result" || prefix[1] === "json"
            ? Promise.all(args.map((value) => settle(value, 0, true)))
                .then((resolved) => invoke(...resolved))
            : Promise.resolve(invoke(...args));
          outputIntents.set(result, task);
          inFlight.add(task);
          void task.finally(() => inFlight.delete(task)).catch(() => {});
          return result;
        };
      }
      return invoke;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, one] of Object.entries(value))
      result[key] = walk(one, [...prefix, key]);
    return Object.freeze(result);
  };
  return walk(template, []) as Record<string, unknown>;
}

function safeConsoleArgs(args: readonly unknown[]): unknown[] {
  const seen = new WeakMap<object, unknown>();
  let nodes = 0;
  const visit = (value: unknown, depth = 0): unknown => {
    if (++nodes > 4096 || depth > 20) return "[log truncated]";
    if (typeof value !== "object" || value === null)
      return typeof value === "function" ? "[function]" : value;
    if (seen.has(value)) return seen.get(value);
    const issued = issuedOfferViews.get(value);
    if (issued) return visit(issued.snapshot, depth + 1);
    if (issuedIntentViews.has(value))
      return { kind: (value as { kind?: unknown }).kind ?? "output" };
    if (outputIntents.has(value))
      return { kind: (value as { kind?: unknown }).kind ?? "output" };
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer || value instanceof Blob)
      return "[binary data]";
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(value, output);
      for (const item of value.slice(0, 512))
        output.push(visit(item, depth + 1));
      return output;
    }
    if (!isPlainRecord(value)) return "[native value]";
    const output = Object.create(null) as Record<string, unknown>;
    seen.set(value, output);
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    ).slice(0, 512)) {
      if (descriptor.enumerable)
        output[key] = "value" in descriptor
          ? visit(descriptor.value, depth + 1) : "[accessor omitted]";
    }
    return output;
  };
  return args.slice(0, 20).map((value) => visit(value));
}
const safeConsole = Object.freeze({
  log: (...args: unknown[]) => {
    try { send({ type: "log", args: safeConsoleArgs(args) }); }
    catch { send({ type: "log", args: ["[non-serializable log values]"] }); }
  },
  info: (...args: unknown[]) => {
    try { send({ type: "log", args: safeConsoleArgs(args) }); }
    catch { send({ type: "log", args: ["[non-serializable log values]"] }); }
  },
  warn: (...args: unknown[]) => {
    try { send({ type: "log", args: safeConsoleArgs(args) }); }
    catch { send({ type: "log", args: ["[non-serializable log values]"] }); }
  },
  error: (...args: unknown[]) => {
    try { send({ type: "log", args: safeConsoleArgs(args) }); }
    catch { send({ type: "log", args: ["[non-serializable log values]"] }); }
  },
});
async function prepare() {
  const module = await ModuleLoader.create(
    data.work, data.bootId, {
      builtins: () => data.policy.builtins,
      approvedPackages: () => new Map(data.policy.approvedPackages),
    },
  );
  const sdk = buildBindings(data.template);
  const audit = new NativePromiseAudit();
  const execute = module.compile(data.code, {
    ...sdk, context: data.context,
  }, {
    filename: data.filename,
    console: safeConsole as unknown as Console,
    onModule: (use) => send({ type: "module", use }),
    onScriptError: (diagnostic) => {
      lastScriptDiagnostic = diagnostic;
      send({ type: "script-error", diagnostic });
    },
  });
  send({ type: "ready" });
  port!.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const entry = message as Record<string, unknown>;
    if (entry.type === "audit") {
      void audit.checkpoint().then(() => {
        send({ type: "audit-result", ok: true });
      }, (cause) => {
        send({ type: "audit-result",
          error: safeErrorData(cause, {
            code: "unhandled_async_error",
            message: "The Run contains an unhandled asynchronous rejection.",
          }) });
      });
      return;
    }
    if (entry.type === "invoke-callback" &&
        typeof entry.callbackId === "string" &&
        typeof entry.requestId === "string") {
      void Promise.resolve().then(async () => {
        const callback = guestCallbacks.get(entry.callbackId! as string);
        if (!callback)
          throw new AgentError("worker_callback_unavailable",
            "The original JavaScript callback is no longer available.");
        const args = Array.isArray(entry.args) ? entry.args : [];
        return await callback(...args.map((one) => fromCore(one)));
      }).then((value) =>
        send({ type: "callback-result", requestId: entry.requestId, value }),
      (cause) =>
        send({ type: "callback-result", requestId: entry.requestId,
          error: safeErrorData(cause, {
            code: "worker_callback_failed",
            message: "The guest callback failed.",
          }) }),
      );
      return;
    }
    if (entry.type === "reply" && typeof entry.id === "string") {
      const pending = waiting.get(entry.id);
      waiting.delete(entry.id);
      if (!pending) return;
      if (entry.error && typeof entry.error === "object") {
        const problem = entry.error as {code?: string; message?: string;
          details?: JsonObject; exceptionType?: string; response?: JsonObject;
          issuedErrorId?: string; nativeCause?: object;
          dispatched?: boolean; effect?: string; retryable?: boolean };
        const error = new AgentError(
          typeof problem.code === "string" ? problem.code : "sdk_call_failed",
          typeof problem.message === "string"
            ? problem.message : "The SDK invocation failed.",
          problem.details,
        );
        if (problem.exceptionType === "InputTimeoutError")
          error.name = "InputTimeoutError";
        attachFailureFacts(error, problem);
        if (problem.code === "api_http_error" &&
            isPlainRecord(problem.response))
          Object.defineProperty(error, "response", {
            value: fromCore(problem.response), enumerable: false,
          });
        if (typeof problem.issuedErrorId === "string")
          issuedErrors.set(error, problem.issuedErrorId);
        if (problem.nativeCause)
          Object.defineProperty(error, "cause", {
            value: fromCore(problem.nativeCause), enumerable: false,
          });
        pending.reject(error);
      } else {
        try {
          const originals = originalArgs.get(entry.id) ?? [];
          if (isPlainRecord(entry.value) &&
              Object.keys(entry.value).length === 1 &&
              typeof entry.value.__nexumOriginalArg === "number" &&
              Number.isInteger(entry.value.__nexumOriginalArg) &&
              entry.value.__nexumOriginalArg >= 0 &&
              entry.value.__nexumOriginalArg < originals.length)
            pending.resolve(originals[entry.value.__nexumOriginalArg]);
          else pending.resolve(fromCore(entry.value));
        }
        catch (cause) { pending.reject(cause); }
      }
      originalArgs.delete(entry.id);
    }
    if (entry.type === "start" && !started) {
      started = true;
      void (async () => {
        try {
          const result = await audit.run(execute);
          const fixed = await settle(result, 0, true);
          // Returned output.result() values can contain unawaited output
          // helpers. Resolve their authorized Core calls before closing new
          // work admission; otherwise root-returned races those callbacks
          // and incorrectly fails the Run with run_stopping.
          send({ type: "root-returned" });
          // Non-awaited synchronous output helpers must still finish their
          // Core-authorized invocations before the Run succeeds.
          const pending = [...inFlight];
          if (pending.length) {
            const outcomes = await Promise.allSettled(pending);
            const failed = outcomes.find((item) => item.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
          send({ type: "done", value: fixed });
        } catch (cause) {
          send({
            type: "failed",
            ...safeErrorData(cause, {
              code: "script_execution_failed",
              message: "The JavaScript execution failed.",
            }),
            ...(lastScriptDiagnostic
              ? { diagnostic: lastScriptDiagnostic } : {}),
          });
        }
      })();
    }
  });
}

void prepare().catch((cause) => {
  const syntax = lastScriptDiagnostic?.exceptionType === "SyntaxError" ||
    cause instanceof SyntaxError;
  send({
    type: "failed",
    ...safeErrorData(cause, {
      code: syntax
        ? "script_syntax_error" : "worker_prepare_failed",
      message: syntax
        ? "The script contains invalid JavaScript syntax."
        : "The script Worker could not be prepared.",
    }),
    ...(lastScriptDiagnostic
      ? { diagnostic: lastScriptDiagnostic } : {}),
  });
});
