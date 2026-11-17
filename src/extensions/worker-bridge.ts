import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { serialize } from "node:v8";
import { types } from "node:util";
import { AgentError, isAgentError, requireCondition } from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import { isPlainRecord } from "../contracts/json.js";
import { compileMethodSchema } from "../contracts/validation.js";
import { mcpResult } from "../results/mcp.js";
import { outputIntent } from "../sdk/output.js";
import type { JsonObject } from "../contracts/types.js";
import type {
  ExtensionFactory, ExtensionHost, ExtensionInstance,
  Invocation, MethodDefinition,
} from "./api.js";
import type { ManagedResource, ResourceRef } from "./resources.js";

const maxRpcBytes = 64 * 1024;
const headerBytes = 8;
const namePattern = /^[A-Za-z0-9_.$-]{1,256}$/;
const maxPending = 512;
const hostMethods = new Set([
  "authorize", "log", "resources.register", "resources.get",
  "resources.handoff", "resources.describe", "resources.list",
  "resources.report", "storage.reserve", "storage.release",
]);
const callMethods = new Set([
  "authorize", "log", "progress", "requestInput",
  "resources.register", "resources.get", "resources.handoff",
  "resources.describe", "resources.list", "resources.report",
  "storage.reserve", "storage.release",
]);
const sdkRoots = new Set([
  "output", "state", "transfer", "maintenance", "hostRequests",
]);
const isolatedHandlers = new WeakSet<Function>();
/** Only Core-created remote methods can select the worker normalization path. */
export const isIsolatedHandler = (value: Function): boolean =>
  isolatedHandlers.has(value);

interface RemoteMethod {
  readonly name: string;
  readonly description: string;
  readonly permissions: string[];
  readonly path?: string[];
  readonly inputSchema: unknown;
  readonly schemaDialect?: string;
  readonly schemas?: unknown[];
  readonly outputSchema?: unknown;
  readonly outputSchemaDialect?: string;
  readonly normalizes?: boolean;
}
interface HostResource {
  readonly owner: "host" | "call";
  readonly token: string;
  readonly ref: ResourceRef<ManagedResource>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}
interface RemoteCall {
  readonly call: Invocation;
  readonly methods: ReadonlySet<string>;
  readonly abort: () => void;
  readonly issuedIds: Set<string>;
}

/**
 * Only execution of the third-party factory and handler moves to the Worker.
 * The original Core Registry is still the authority for methods, resources,
 * permissions, documentation and cleanup.
 */
export function isolatedExtensionFactory(
  entryUrl: string,
  options: {
    onEvent?: (phase: string, code: string, durationMs: number) => void;
    /** Recheck current package identity and enable intent after native import,
     * before the third-party factory may create resources or side effects. */
    verifyAfterImport?: () => Promise<void>;
  } = {},
): ExtensionFactory {
  return async (host) => {
    const startedAt = performance.now();
    const emit = (phase: string, code: string) => {
      try {
        options.onEvent?.(
          phase, code, Math.max(0, Math.floor(performance.now() - startedAt)),
        );
      } catch { /* Logging must not break the extension's lifecycle. */ }
    };
    const worker = new Worker(new URL("./worker-entry.js", import.meta.url), {
      workerData: { entryUrl },
      execArgv: process.execArgv.includes("--experimental-vm-modules")
        ? ["--experimental-vm-modules"] : process.execArgv,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    emit("spawn", "extension_worker_created");
    const prepared = Promise.withResolvers<RemoteMethod[]>();
    const requests = new Map<string, ReturnType<
      typeof Promise.withResolvers<unknown>>>();
    const calls = new Map<string, RemoteCall>();
    const resources = new Map<string, HostResource>();
    const tickets = new Map<string, { release(): void }>();
    const issued = new Map<string, { value: unknown; snapshot?: unknown }>();
    let ready = false, ended = false, ending = false;
    let exited = false;
    let terminating: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    const terminate = (): Promise<void> =>
      (terminating ??= worker.terminate().then(() => {}));
    const fail = (code: string) => {
      if (ended) return;
      ended = true;
      const error = new AgentError(code,
        "The third-party extension Worker could not complete its lifecycle.");
      if (!ready) prepared.reject(error);
      for (const pending of requests.values()) pending.reject(error);
      requests.clear();
      for (const current of resources.values()) current.reject(error);
      for (const ticket of tickets.values()) {
        try { ticket.release(); } catch { /* Keep the original failure. */ }
      }
      tickets.clear();
      emit("failed", code);
      if (!exited) void terminate().catch(() => {});
    };
    void prepared.promise.catch(() => {});
    const dispose = (): Promise<void> => {
      if (shutdown) return shutdown;
      if (ended) return exited ? Promise.resolve() : terminate();
      ending = true;
      shutdown = (async () => {
        try { await request("dispose", {}, 8000); }
        finally {
          await terminate();
          if (!ended) {
            ended = true;
            for (const ticket of tickets.values()) {
              try { ticket.release(); } catch { /* Preserve cleanup state. */ }
            }
            tickets.clear();
            emit("stopped", "extension_worker_stopped");
          }
        }
      })();
      return shutdown;
    };
    const request = (kind: string, data: Record<string, unknown>,
      timeoutMs = 30000): Promise<unknown> => {
      requireCondition(!ended && requests.size < maxPending,
        "extension_worker_unavailable", "The extension Worker cannot accept new work.");
      const id = randomUUID();
      const deferred = Promise.withResolvers<unknown>();
      requests.set(id, deferred);
      const timer = setTimeout(() => {
        if (!requests.delete(id)) return;
        deferred.reject(new AgentError("extension_worker_timeout",
          "The extension Worker did not confirm the original operation."));
        // The business outcome may be unknown: revoke the Worker instead of
        // allowing a timed-out instance to keep accepting new invocations.
        fail("extension_worker_timeout");
      }, timeoutMs);
      void deferred.promise.finally(() => {
        clearTimeout(timer);
        requests.delete(id);
      }).catch(() => {});
      worker.postMessage({ type: "request", id, kind, ...data });
      return deferred.promise;
    };
    const encode = (value: unknown, callId?: string): unknown => {
      const seen = new WeakMap<object, unknown>();
      const walk = (item: unknown, depth = 0): unknown => {
        requireCondition(depth <= 24, "extension_worker_result_invalid",
          "SDK result exceeds the data budget.");
        if (!item || typeof item !== "object") return item;
        if (seen.has(item)) return seen.get(item);
        if (outputIntent(item)) {
          const id = randomUUID(), marker = { __nexumIntent: id };
          issued.set(id, { value: item });
          if (callId) calls.get(callId)?.issuedIds.add(id);
          seen.set(item, marker);
          return marker;
        }
        const remote = mcpResult(item);
        if (remote) {
          const id = randomUUID();
          const snapshot = structuredClone(item) as Record<string, unknown>;
          const marker = {
            __nexumMcpEnvelope: id, model: snapshot,
            meta: structuredClone(remote.meta),
          };
          issued.set(id, { value: item, snapshot });
          if (callId) calls.get(callId)?.issuedIds.add(id);
          seen.set(item, marker);
          return marker;
        }
        if (Array.isArray(item)) {
          const result: unknown[] = [];
          seen.set(item, result);
          for (const sub of item) result.push(walk(sub, depth + 1));
          return result;
        }
        if (isPlainRecord(item)) {
          const result = Object.create(null) as Record<string, unknown>;
          seen.set(item, result);
          for (const [key, sub] of Object.entries(item))
            result[key] = walk(sub, depth + 1);
          return result;
        }
        return item;
      };
      return walk(value);
    };
    const decode = (value: unknown): unknown => {
      const walk = (item: unknown, depth = 0): unknown => {
        requireCondition(depth <= 24, "extension_worker_result_invalid",
          "SDK output exceeds the nested budget.");
        if (!item || typeof item !== "object") return item;
        if (Array.isArray(item)) return item.map((x) => walk(x, depth + 1));
        if (!isPlainRecord(item)) return item;
        const keys = Object.keys(item);
        if (keys.length === 1 && keys[0] === "__nexumIntent") {
          const identity = issued.get(item.__nexumIntent as string);
          requireCondition(identity, "extension_worker_result_invalid",
            "The output intent was not issued in this Worker instance.");
          return identity.value;
        }
        if (typeof item.__nexumMcpHandle === "string") {
          const identity = issued.get(item.__nexumMcpHandle);
          requireCondition(identity?.snapshot !== undefined,
            "extension_worker_result_invalid",
            "The MCP result identity is no longer current.");
          // Guest changes to a previously-branded result cannot change the
          // original authenticated source, model or private metadata.
          return identity.value;
        }
        const result = Object.create(null) as Record<string, unknown>;
        for (const [key, sub] of Object.entries(item))
          result[key] = walk(sub, depth + 1);
        return result;
      };
      return walk(value);
    };
    const register = async (
      owner: "host" | "call",
      token: string, kind: string,
      services: typeof host.resources,
    ): Promise<object> => {
      requireCondition(namePattern.test(kind) && typeof token === "string" &&
        /^[0-9a-f-]{36}$/.test(token) && !resources.has(token),
      "extension_worker_request_invalid",
      "Resource registration requires a unique exact identity.");
      const closed = Promise.withResolvers<void>();
      const proxy: ManagedResource = {
        closed: closed.promise,
        dispose: async () => {
          await request("resource-dispose", { token }, 30000);
        },
      };
      void closed.promise.catch(() => {});
      const ref = await services.register({ kind, value: proxy });
      const abort = () => {
        if (!ended) worker.postMessage({ type: "resource-abort", token });
      };
      ref.signal.addEventListener("abort", abort, { once: true });
      resources.set(token, {
        owner, token, ref,
        resolve: closed.resolve, reject: closed.reject,
      });
      return { id: ref.id, kind: ref.kind,
        signalAborted: ref.signal.aborted };
    };
    const lookupCall = (id: unknown): RemoteCall => {
      requireCondition(typeof id === "string" && calls.has(id),
        "extension_worker_call_closed", "This invocation has already ended.");
      return calls.get(id)!;
    };
    const method = (
      owner: "host" | "call", callId: string | null, name: string,
      args: unknown[],
    ): unknown => {
      requireCondition(namePattern.test(name) && args.length <= 10,
        "extension_worker_request_invalid",
        "An Extension Worker can invoke only bounded service methods.");
      const current = owner === "host" ? null : lookupCall(callId);
      const target = owner === "host" ? host : current!.call;
      if (name === "resources.register") {
        const [input] = args;
        requireCondition(isPlainRecord(input) &&
          typeof input.kind === "string" &&
          typeof input.token === "string",
        "extension_worker_request_invalid", "Invalid resource request.");
        return register(owner, input.token, input.kind, target.resources);
      }
      if (name === "resources.report") {
        const [token, details] = args;
        const ref = resources.get(String(token));
        requireCondition(ref && ref.owner === owner && isPlainRecord(details),
          "extension_worker_request_invalid", "Unknown resource report owner.");
        ref.ref.report(details as JsonObject);
        return null;
      }
      if (name === "storage.reserve") {
        const [bytes] = args;
        requireCondition(Number.isSafeInteger(bytes) && Number(bytes) > 0,
          "extension_worker_request_invalid", "Invalid resource reservation.");
        return target.storage.reserve(Number(bytes)).then((ticket) => {
          const id = randomUUID();
          tickets.set(id, ticket);
          return { ticketId: id };
        });
      }
      if (name === "storage.release") {
        const ticket = tickets.get(String(args[0]));
        requireCondition(ticket, "extension_worker_request_invalid",
          "The storage reservation does not exist.");
        tickets.delete(String(args[0]));
        ticket.release();
        return null;
      }
      if (name === "resources.get") {
        // Worker cannot borrow foreign live native controller values. It can
        // only access its own registered instance by retained Core resource ID.
        const ref = [...resources.values()].find((entry) =>
          entry.owner === owner && entry.ref.id === args[0]);
        requireCondition(ref, "extension_worker_resource_unavailable",
          "The live resource belongs to another source or Worker.");
        return { id: ref.ref.id, kind: ref.ref.kind,
          signalAborted: ref.ref.signal.aborted, token: ref.token };
      }
      if (owner === "host")
        requireCondition(hostMethods.has(name),
          "extension_worker_method_denied", "Only declared host services are available.");
      else requireCondition(callMethods.has(name) ||
        sdkRoots.has(name.split(".")[0]!),
      "extension_worker_method_denied", "Only declared invocation services are available.");
      const parts = name.split(".");
      let receiver: unknown = target;
      for (const key of parts.slice(0, -1)) {
        requireCondition(!["__proto__", "prototype", "constructor"].includes(key) &&
          receiver && typeof receiver === "object",
          "extension_worker_method_denied",
          "Invalid invocation property path.");
        const property = Object.getOwnPropertyDescriptor(receiver, key);
        requireCondition(property && "value" in property,
          "extension_worker_method_denied",
          "Only actual bound SDK properties may be accessed.");
        receiver = property.value;
      }
      const leaf = parts.at(-1)!;
      const desc = receiver && (typeof receiver === "object" ||
        typeof receiver === "function")
        ? Object.getOwnPropertyDescriptor(receiver, leaf) : undefined;
      requireCondition(desc && "value" in desc && typeof desc.value === "function",
        "extension_worker_method_denied",
        "The requested SDK method is not available.");
      return Reflect.apply(desc.value, receiver, args.map((v) => decode(v)));
    };
    const respond = (entry: Record<string, unknown>,
      payload: Record<string, unknown>) => {
      if (ended) return;
      const sync = entry.sync instanceof SharedArrayBuffer &&
        entry.sync.byteLength === headerBytes + maxRpcBytes
        ? entry.sync : null;
      const header = sync ? new Int32Array(sync, 0, 2) : null;
      let notified = false;
      if (header && sync) {
        try {
          const bytes = serialize(payload);
          if (bytes.byteLength <= maxRpcBytes) {
            new Uint8Array(sync, headerBytes, bytes.length).set(bytes);
            Atomics.store(header, 1, bytes.byteLength);
            Atomics.store(header, 0, 1);
            Atomics.notify(header, 0);
            notified = true;
          }
        } catch { /* Send via ordinary async Worker reply. */ }
        if (!notified) {
          Atomics.store(header, 0, 3);
          Atomics.notify(header, 0);
        }
      }
      if (!notified)
        worker.postMessage({ type: "reply", id: entry.id, ...payload });
    };
    worker.on("error", (cause: Error & { code?: string }) => fail(
      typeof cause.code === "string" &&
        /^[A-Za-z_][A-Za-z_0-9-]{0,95}$/.test(cause.code)
        ? cause.code : "extension_worker_failed",
    ));
    worker.once("online", () => emit("online", "extension_worker_online"));
    worker.on("exit", () => {
      exited = true;
      if (!ending) fail("extension_worker_exited");
    });
    worker.on("message", (message: unknown) => {
      if (ended || !isPlainRecord(message)) return;
      if (message.type === "imported") {
        emit("import_admission", "extension_import_verifying");
        void Promise.resolve()
          .then(() => options.verifyAfterImport?.())
          .then(() => {
            if (ended || ending) return;
            worker.postMessage({ type: "import-admitted" });
            emit("import_admitted", "extension_import_admitted");
          }, (cause) => {
            if (ended || ending) return;
            const code = isAgentError(cause)
              ? cause.code : "extension_package_changed";
            worker.postMessage({ type: "import-denied", code });
            emit("import_denied", "extension_import_denied");
          })
          .catch(() => fail("extension_worker_admission_failed"));
        return;
      }
      if (message.type === "progress" && typeof message.stage === "string" &&
          typeof message.code === "string" &&
          /^[a-z][a-z0-9_]{0,60}$/.test(message.stage) &&
          /^[a-z][a-z0-9_]{0,100}$/.test(message.code)) {
        emit(message.stage, message.code);
        return;
      }
      if (message.type === "ready" && Array.isArray(message.methods)) {
        ready = true;
        prepared.resolve(message.methods as RemoteMethod[]);
        emit("ready", "extension_worker_ready");
        return;
      }
      if (message.type === "fatal") {
        fail(typeof message.code === "string" ? message.code :
          "extension_worker_failed");
        return;
      }
      if (message.type === "resource-closed") {
        const record = resources.get(String(message.token));
        if (record) {
          record.resolve();
          resources.delete(record.token);
        }
        return;
      }
      if (message.type === "reply" && typeof message.id === "string") {
        const pending = requests.get(message.id);
        if (!pending) return;
        requests.delete(message.id);
        if (isPlainRecord(message.error))
          pending.reject(new AgentError(
            typeof message.error.code === "string"
              ? message.error.code : "extension_worker_failed",
            typeof message.error.message === "string"
              ? message.error.message : "The Worker rejected the request.",
          ));
        else pending.resolve(decode(message.value));
        return;
      }
      if (message.type === "host-call" &&
          typeof message.id === "string" &&
          (message.owner === "host" || message.owner === "call")) {
        const entry = message as Record<string, unknown>;
        try {
          const name = String(message.name);
          const args = Array.isArray(message.args) ? message.args : [];
          const value = method(message.owner,
            typeof message.callId === "string" ? message.callId : null,
            name, args);
          if (types.isPromise(value)) {
            if (entry.sync instanceof SharedArrayBuffer &&
                entry.sync.byteLength === headerBytes + maxRpcBytes) {
              const header = new Int32Array(entry.sync, 0, 2);
              Atomics.store(header, 0, 3);
              Atomics.notify(header, 0);
            }
            const asyncEntry = { ...entry, sync: undefined };
            void Promise.resolve(value).then(
              (v) => respond(asyncEntry, { value: encode(v,
                typeof entry.callId === "string" ? entry.callId : undefined) }),
              (e) => respond(asyncEntry, { error: safeErrorData(e, {
                code: "extension_worker_call_failed",
                message: "The original Core service failed.",
              }) }),
            );
          } else respond(entry, { value: encode(value,
            typeof entry.callId === "string" ? entry.callId : undefined) });
        } catch (e) {
          respond(entry, { error: safeErrorData(e, {
            code: "extension_worker_call_failed",
            message: "The original Core service failed.",
          }) });
        }
      }
    });
    const timeout = setTimeout(() => {
      if (ready || ended) return;
      fail("extension_worker_initialization_timeout");
      void worker.terminate().catch(() => {});
    }, 20000);
    const abort = () => {
      if (ended) return;
      if (!ready) {
        fail("extension_worker_aborted");
        return;
      }
      void dispose().catch(() => {});
    };
    host.signal.addEventListener("abort", abort, { once: true });
    worker.postMessage({
      type: "request", id: randomUUID(), kind: "initialize",
      context: host.context, config: host.config,
    });
    try {
      const methods = await prepared.promise;
      clearTimeout(timeout);
      const table = Object.create(null) as Record<string, MethodDefinition>;
      for (const method of methods) {
        requireCondition(typeof method.name === "string" &&
          namePattern.test(method.name) && !Object.hasOwn(table, method.name),
        "extension_worker_contract_invalid",
        "An Extension Worker must return a unique method contract.");
        const handle: MethodDefinition["handle"] = async (input, call) => {
          const id = randomUUID();
          const onAbort = () => {
            if (!ended) worker.postMessage({ type: "call-abort", id });
          };
          call.signal.addEventListener("abort", onAbort, { once: true });
          const issuedIds = new Set<string>();
          calls.set(id, { call, methods: callMethods, abort: onAbort,
            issuedIds });
          try {
            // Normalization runs on the third-party Worker, but Schema
            // admission stays in trusted Core before any handler executes.
            const normalized = await request("normalize", {
              method: method.name, input,
            });
            call.signal.throwIfAborted();
            compileMethodSchema(
              method.inputSchema,
              method.schemaDialect as MethodDefinition["schemaDialect"],
              method.schemas,
            )(normalized);
            return await request("invoke", {
              method: method.name, input: normalized, callId: id,
              context: call.context, operationId: call.operationId,
              deadline: call.deadline,
              hasHostRequests: Boolean(call.hostRequests),
            });
          } finally {
            calls.delete(id);
            for (const issuedId of issuedIds) issued.delete(issuedId);
            call.signal.removeEventListener("abort", onAbort);
          }
        };
        isolatedHandlers.add(handle);
        table[method.name] = {
          description: method.description,
          permissions: method.permissions,
          path: method.path,
          inputSchema: method.inputSchema,
          ...(method.schemaDialect ? { schemaDialect: method.schemaDialect as
            MethodDefinition["schemaDialect"] } : {}),
          ...(method.schemas ? { schemas: method.schemas } : {}),
          ...(method.outputSchema === undefined ? {} :
            { outputSchema: method.outputSchema }),
          ...(method.outputSchemaDialect ? {
            outputSchemaDialect: method.outputSchemaDialect as
              MethodDefinition["outputSchemaDialect"],
          } : {}),
          handle,
        };
      }
      return { methods: table, dispose };
    } catch (cause) {
      await worker.terminate().catch(() => {});
      fail(isAgentError(cause) ? cause.code :
        "extension_worker_initialization_failed");
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  };
}
