import { parentPort, workerData, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { deserialize } from "node:v8";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { AgentError, isAgentError, requireCondition } from "../contracts/errors.js";
import { safeErrorData, isPublicErrorCode, failureFacts, boundErrorDetails, boundErrorMessage } from "../contracts/error-data.js";
import { isPlainRecord } from "../contracts/json.js";
import { compileMethodSchema } from "../contracts/validation.js";
import type { JsonObject } from "../contracts/types.js";
import type {
  ExtensionFactory, ExtensionHost, ExtensionInstance,
  Invocation, MethodDefinition, AccessTarget, LogEntry,
} from "./api.js";
import type {
  ManagedResource, ResourceRef, ResourceService,
} from "./resources.js";

const port = parentPort;
if (!port) throw new Error("The extension Worker must have an original Core port.");
const config = workerData as { entryUrl: string; syncReplyPort: MessagePort };
const syncBytes = 64 * 1024, syncHeaderBytes = 8;
const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
const resources = new Map<string, {
  value: ManagedResource;
  id: string;
  controller: AbortController;
  kind: string;
}>();
const tickets = new Map<string, { release(): void }>();
const callControllers = new Map<string, AbortController>();
const importAdmission = Promise.withResolvers<void>();
void importAdmission.promise.catch(() => {});
const outputViews = new WeakMap<object, { id: string; kind: string }>();
const mcpViews = new WeakMap<object, { id: string; snapshot: Record<string, unknown> }>();
let initialized: ExtensionInstance | undefined, stopping = false;
interface WorkerMethod {
  readonly definition: MethodDefinition;
  readonly handle: MethodDefinition["handle"];
  readonly normalize: MethodDefinition["normalize"];
  readonly contract: {
    readonly schema: unknown;
    readonly dialect: MethodDefinition["schemaDialect"];
    readonly references: MethodDefinition["schemas"];
  };
  validateInput?: (value: unknown) => void;
}
const methods = new Map<string, WorkerMethod>();
function registeredMethod(name: string): WorkerMethod {
  const method = methods.get(name);
  requireCondition(method, "extension_worker_method_missing",
    "The requested method is not part of this extension.");
  return method;
}
function validateMethod(method: WorkerMethod, value: unknown): void {
  // Compile once per instance/method from the declaration that was sent to
  // Core. Invalid candidate schemas remain a Registry preparation failure;
  // normalization and invoke both retain their actual validation step.
  const validate = method.validateInput ??= compileMethodSchema(
    method.contract.schema, method.contract.dialect, method.contract.references,
  );
  validate(value);
}

const send = (message: object) => port!.postMessage(message);
function safeComponentCode(cause: unknown): string {
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current &&
    typeof current === "object" && !types.isProxy(current); depth++) {
    const value = Object.getOwnPropertyDescriptor(current, "code");
    if (value && "value" in value &&
        isPublicErrorCode(value.value))
      return value.value;
    const nested = Object.getOwnPropertyDescriptor(current, "cause");
    current = nested && "value" in nested ? nested.value : null;
  }
  return "extension_worker_failed";
}

// Extension errors are untrusted. Preserve a bounded semantic diagnosis
// without forwarding arbitrary messages, paths, target data or stack traces.
const componentMessages: Readonly<Record<string, string>> = Object.freeze({
  TAB_ALREADY_CLAIMED: "Another run already controls the requested browser target.",
  INVALID_TARGET: "The requested target is unavailable or no longer current.",
  INVALID_ARGUMENT: "The requested operation has invalid arguments.",
  CAPABILITY_NOT_ALLOWED: "The requested capability is unavailable or not allowed.",
  EXTENSION_OFFLINE: "The extension connection is offline.",
  USER_TAKEOVER: "The user has taken control of the target.",
  TIMEOUT: "The operation exceeded its deadline.",
  DEADLINE_EXCEEDED: "The operation exceeded its deadline.",
  CANCELLED: "The operation was cancelled.",
  UNKNOWN_RESULT: "The operation result could not be confirmed.",
  PROTOCOL_MISMATCH: "The extension returned an incompatible protocol result.",
  FILE_CHANGED: "The source or staging file changed during preparation.",
  FILE_SIZE_MISMATCH: "The received file size did not match the declared size.",
  OUTPUT_TOO_LARGE: "The result exceeded its size budget.",
  PERMISSION_DENIED: "The native operation was denied.",
  permission_denied: "The current source, run or target is not authorized.",
  forbidden: "Current access was revoked or denied.",
  path_not_allowed: "The requested path is outside the authorized scope.",
  AMBIGUOUS_TARGET: "More than one current element matches the target.",
  ARTIFACT_PREPARATION_FAILED: "The artifact could not be fixed for delivery.",
  CDP_DISCONNECTED: "The native debugger connection is unavailable.",
  EXPECTATION_UNCONFIRMED: "The requested page condition was not confirmed after input.",
  FILE_CLEANUP_FAILED: "Cleanup of the original file operation is not confirmed.",
  FILE_CLOSE_FAILED: "Closure of the original file handle is not confirmed.",
  FILE_IO_FAILED: "The authorized file operation could not be completed.",
  FILE_UNAVAILABLE: "The original file or download is unavailable.",
  INPUT_UNCONFIRMED: "The browser did not confirm the requested input.",
  INVALID_CONTEXT: "The current execution context cannot support the operation.",
  NATIVE_OPERATION_FAILED: "The native operation failed; its specific cause is not confirmed.",
  NAVIGATION_FAILED: "The browser did not confirm successful navigation.",
  PORT_IN_USE: "No allowed local listener port is available.",
  PROFILE_CONFLICT: "Another active connection owns this browser profile.",
  PROFILE_MISMATCH: "The endpoint belongs to a different profile or extension identity.",
  PLUGIN_VERSION_MISMATCH: "The running browser plugin does not match the installed Browser package. Reload the Nexum browser extension and discover it again.",
  QUEUE_FULL: "The current operation capacity is exhausted.",
  STALE_REF: "The observed reference belongs to an earlier target or document.",
  STALE_REGISTRATION: "The observed tool registration is no longer current.",
  TARGET_GONE: "The original native target no longer exists.",
  VISUAL_CANCELLED: "The browser visual action was cancelled.",
  VISUAL_GROUP_UNAVAILABLE: "The browser visual group is unavailable.",
  VISUAL_TARGET_RELEASED: "The visual target has already been released.",
  VISUAL_TIMEOUT: "The browser visual action exceeded its deadline.",
  VISUAL_UNAVAILABLE: "The browser visual capability is unavailable.",
  WAITER_GONE: "The original event waiter no longer exists.",
});
const componentReasons: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  element_not_found: ["INVALID_TARGET", "The locator did not match any current element."],
  element_not_unique: ["AMBIGUOUS_TARGET", "The locator matched multiple current elements."],
  invalid_key: ["INVALID_ARGUMENT", "Use a single character or a supported case-sensitive native key name, such as Backspace, Enter, ArrowLeft, or ControlOrMeta."],
  element_not_actionable: ["INVALID_TARGET", "The current element is not visible and enabled."],
  element_blocked: ["INVALID_TARGET", "Another element blocks the action target."],
  download_not_owned: ["FILE_UNAVAILABLE", "The original download is not owned by this run target."],
  download_identity_unconfirmed: ["CAPABILITY_NOT_ALLOWED", "The original download does not have a proven native file identity."],
  download_identity_ambiguous: ["FILE_UNAVAILABLE", "The browser reported an ambiguous download identity."],
  download_cancelled: ["FILE_UNAVAILABLE", "The browser download was cancelled."],
  download_record_missing: ["FILE_UNAVAILABLE", "The original native download record is unavailable."],
  download_interrupted: ["FILE_UNAVAILABLE", "The browser download was interrupted."],
  download_path_invalid: ["FILE_UNAVAILABLE", "The completed browser download has no valid local filename."],
  download_source_authorization_denied: ["permission_denied", "The owned browser download source was denied by the Agent. Check its current authorization before delivery."],
  source_file_missing: ["FILE_UNAVAILABLE", "The authorized source file is no longer present."],
  tab_closed: ["TARGET_GONE", "The original native browser tab is closed."],
  protected_page: ["PERMISSION_DENIED", "The native browser page is protected or not accessible."],
  dialog_already_open: ["INVALID_TARGET", "Handle the current native dialog before clicking."],
  dialog_opened_after_input: ["INPUT_UNCONFIRMED", "Input opened a native dialog; handle it before further actions."],
});
// Recovery is a bounded semantic category, not arbitrary extension-supplied advice.
function componentRecovery(code: string, reason: unknown): string | undefined {
  if (typeof reason === "string" && reason.startsWith("download_")) return "inspect_download";
  switch (code) {
    case "INVALID_ARGUMENT": return "correct_input";
    case "INVALID_CONTEXT": return "observe_target";
    case "INVALID_TARGET": case "AMBIGUOUS_TARGET": case "STALE_REF":
    case "TARGET_GONE": case "STALE_REGISTRATION": case "NAVIGATION_FAILED": case "WAITER_GONE":
      return "observe_target";
    case "TAB_ALREADY_CLAIMED": case "QUEUE_FULL": case "PROFILE_CONFLICT":
      return "wait_for_capacity";
    case "CAPABILITY_NOT_ALLOWED": case "PERMISSION_DENIED":
    case "permission_denied": case "forbidden": case "path_not_allowed":
      return "check_authorization";
    case "EXTENSION_OFFLINE": case "CDP_DISCONNECTED": case "PROFILE_MISMATCH":
    case "PLUGIN_VERSION_MISMATCH": case "PROTOCOL_MISMATCH": case "PORT_IN_USE":
      return "check_connection";
    case "USER_TAKEOVER": return "stop_control";
    case "FILE_UNAVAILABLE": case "FILE_CHANGED": case "FILE_SIZE_MISMATCH":
    case "FILE_IO_FAILED": case "FILE_CLOSE_FAILED": case "FILE_CLEANUP_FAILED":
    case "ARTIFACT_PREPARATION_FAILED": return "inspect_file";
    case "OUTPUT_TOO_LARGE": return "reduce_scope";
    case "UNKNOWN_RESULT": case "INPUT_UNCONFIRMED": case "EXPECTATION_UNCONFIRMED":
    case "TIMEOUT": case "DEADLINE_EXCEEDED": case "NATIVE_OPERATION_FAILED":
      return "verify_effect";
    default: return undefined;
  }
}
function componentError(cause: unknown): JsonObject {
  const code = safeComponentCode(cause);
  const fallback = {
    code,
    message: Object.hasOwn(componentMessages, code)
      ? componentMessages[code]!
      : "The extension Worker failed to complete its operation.",
  };
  const result = safeErrorData(cause, fallback);
  if (isAgentError(cause) || !cause || typeof cause !== "object" || types.isProxy(cause))
    return result;
  const own = (key: string): unknown => {
    const field = Object.getOwnPropertyDescriptor(cause, key);
    return field && "value" in field ? field.value : undefined;
  };
  const reason = own("reason");
  if (typeof reason === "string" && Object.hasOwn(componentReasons, reason) &&
      (componentReasons[reason]![0] === code ||
       (reason === "dialog_opened_after_input" && code === "EXPECTATION_UNCONFIRMED"))) {
    result.message = componentReasons[reason]![1];
    result.details = { reason };
  }
  const facts = failureFacts(cause);
  if (Object.keys(facts).length)
    result.details = boundErrorDetails({...(isPlainRecord(result.details) ? result.details : {}),...facts})!;

  const details = isPlainRecord(result.details) ? result.details : {};
  const recovery = details.effect === "unknown" || details.effect === "confirmed" || details.dispatched === true ? "verify_effect" : componentRecovery(code, details.reason);
  if (recovery) result.details = { ...details, recovery };
  return result;
}

function encode(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const walk = (item: unknown, depth = 0): unknown => {
    requireCondition(depth <= 24, "extension_worker_message_invalid",
      "The SDK input exceeds the nested data budget.");
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return seen.get(item);
    if (outputViews.has(item)) {
      const marker = { __nexumIntent: outputViews.get(item)!.id };
      seen.set(item, marker);
      return marker;
    }
    if (mcpViews.has(item)) {
      const record = mcpViews.get(item)!;
      const marker = { ...record.snapshot, __nexumMcpHandle: record.id };
      seen.set(item, marker);
      return marker;
    }
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      seen.set(item, result);
      for (const nested of item) result.push(walk(nested, depth + 1));
      return result;
    }
    if (isPlainRecord(item)) {
      const result = Object.create(null) as Record<string, unknown>;
      seen.set(item, result);
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(item),
      )) {
        if (!descriptor.enumerable) continue;
        requireCondition("value" in descriptor,
          "extension_worker_message_invalid",
          "SDK messages cannot execute guest accessors.");
        result[key] = walk(descriptor.value, depth + 1);
      }
      return result;
    }
    return item;
  };
  return walk(value);
}

function decode(value: unknown): unknown {
  const walk = (item: unknown, depth = 0): unknown => {
    requireCondition(depth <= 24, "extension_worker_result_invalid",
      "Core data exceeds the nested result budget.");
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map((one) => walk(one, depth + 1));
    if (!isPlainRecord(item)) return item;
    if (typeof item.__nexumIntent === "string") {
      const kind = "unknown";
      const placeholder = Object.freeze({ kind });
      outputViews.set(placeholder, { id: item.__nexumIntent, kind });
      return placeholder;
    }
    if (typeof item.__nexumMcpEnvelope === "string" &&
        isPlainRecord(item.model) && Array.isArray(item.meta)) {
      const model = walk(item.model) as Record<string, unknown>;
      const block = (v: unknown): Record<string, unknown> | undefined =>
        isPlainRecord(v) ? v : undefined;
      for (const entry of item.meta) {
        if (!isPlainRecord(entry) || !isPlainRecord(entry.meta)) continue;
        const idx = Number.isSafeInteger(entry.index) ? Number(entry.index) : -1;
        const list = (value: unknown): unknown[] =>
          Array.isArray(value) ? value : [];
        let target: Record<string, unknown> | undefined;
        if (entry.target === "result") target = model;
        else if (entry.target === "content")
          target = block(list(model.content)[idx]);
        else if (entry.target === "resource")
          target = block(list(model.contents)[idx]) ??
            block(block(list(model.content)[idx])?.resource);
        else if (entry.target === "message")
          target = block(list(block(model.structuredContent)?.messages)[idx]);
        else if (entry.target === "entry" && typeof entry.collection === "string")
          target = block(list(block(model.structuredContent)?.[entry.collection])[idx]);
        if (target && !Object.hasOwn(target, "_meta"))
          Object.defineProperty(target, "_meta", {
            value: entry.meta, enumerable: false,
          });
      }
      mcpViews.set(model, {
        id: item.__nexumMcpEnvelope, snapshot: structuredClone(model),
      });
      return model;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, nested] of Object.entries(item))
      result[key] = walk(nested, depth + 1);
    return result;
  };
  return walk(value);
}

function errorFromCore(problem: unknown): AgentError {
  if (!isPlainRecord(problem))
    return new AgentError("extension_worker_call_failed",
      "An external service request failed.");
  return new AgentError(
    isPublicErrorCode(problem.code)
      ? problem.code : "extension_worker_call_failed",
    boundErrorMessage(problem.message, "An external service request failed."),
    boundErrorDetails(problem.details,problem),
  );
}

function rpc(
  owner: "host" | "call", name: string, args: unknown[],
  callId: string | null = null,
): unknown {
  requireCondition(!stopping, "extension_worker_closed",
    "This Worker is closing its SDK instance.");
  const id = randomUUID();
  const pending = Promise.withResolvers<unknown>();
  waiting.set(id, pending);
  const buffer = new SharedArrayBuffer(syncHeaderBytes + syncBytes);
  const header = new Int32Array(buffer, 0, 2);
  try {
    send({ type: "host-call", id, owner, name, args: encode(args),
      ...(callId ? { callId } : {}), sync: buffer });
  } catch {
    waiting.delete(id);
    throw new AgentError("extension_worker_message_invalid",
      "The SDK message cannot be transferred to its Core.");
  }
  if (Atomics.load(header, 0) === 0) Atomics.wait(header, 0, 0, 30000);
  const state = Atomics.load(header, 0);
  if (state === 3) return pending.promise;
  waiting.delete(id);
  let response: unknown;
  if (state === 4) {
    const message = receiveMessageOnPort(config.syncReplyPort)?.message;
    requireCondition(isPlainRecord(message) && message.id === id && isPlainRecord(message.payload),
      "extension_worker_result_invalid", "The large Core reply has no matching identity.");
    response = message.payload;
  } else {
    if (state === 5)
      throw new AgentError("extension_worker_result_invalid", "The synchronous Core result is not transferable.");
    if (state !== 1)
      throw new AgentError("extension_worker_rpc_timeout",
        "The Core did not acknowledge this SDK call; do not blindly replay it.");
    const count = Atomics.load(header, 1);
    requireCondition(count > 0 && count <= syncBytes,
      "extension_worker_result_invalid", "Invalid Core reply length.");
    response = deserialize(Buffer.from(new Uint8Array(buffer, syncHeaderBytes, count)));
  }
  if (isPlainRecord(response) && response.error)
    throw errorFromCore(response.error);
  return decode((response as { value: unknown }).value);
}

function localRef(
  token: string, data: unknown, registeredOwner: "host" | "call",
): ResourceRef {
  requireCondition(isPlainRecord(data) &&
    typeof data.id === "string" && typeof data.kind === "string",
    "extension_worker_result_invalid", "Resource registration has no Core identity.");
  const record = resources.get(token);
  requireCondition(record, "extension_worker_resource_unavailable",
    "A resource must be registered before receiving its handle.");
  record.id = data.id;
  record.kind = data.kind;
  if (data.signalAborted) record.controller.abort();
  return Object.freeze({
    id: record.id, kind: record.kind, value: record.value,
    signal: record.controller.signal,
    report: (details: JsonObject) => {
      // Resource facts may arrive after the creating invocation has returned.
      // Use the Worker lifecycle lane, but preserve the resource's original
      // registration owner for Core's exact-token ownership check.
      rpc("host", "resources.report", [token, details, registeredOwner]);
    },
  });
}

function nativeResources(owner: "host" | "call", callId?: string): ResourceService {
  return Object.freeze({
    async register(input: { kind: string; value: ManagedResource }) {
      requireCondition(input && typeof input.kind === "string" &&
        input.value && typeof input.value.dispose === "function" &&
        input.value.closed instanceof Promise,
      "extension_worker_resource_invalid",
      "The Worker must register a real disposable managed resource.");
      const token = randomUUID();
      resources.set(token, {
        value: input.value, id: "", kind: input.kind,
        controller: new AbortController(),
      });
      try {
        const result = await rpc(owner, "resources.register",
          [{ kind: input.kind, token }], callId ?? null);
        const ref = localRef(token, result, owner);
        void input.value.closed.then(
          () => send({ type: "resource-closed", token }),
          () => send({ type: "resource-closed", token }),
        );
        return ref;
      } catch (cause) {
        resources.delete(token);
        throw cause;
      }
    },
    async get(id: string) {
      const result = await rpc(owner, "resources.get", [id], callId ?? null);
      const response = result as { token?: string };
      if (!response.token)
        throw new AgentError("extension_worker_resource_unavailable",
          "The resource is not owned by this Worker.");
      return localRef(response.token, response, owner);
    },
    handoff: (id: string) => rpc(owner, "resources.handoff", [id], callId ?? null),
    describe: (id: string) => rpc(owner, "resources.describe", [id], callId ?? null),
    list: (query?: unknown) => rpc(owner, "resources.list", [query], callId ?? null),
  }) as ResourceService;
}

function nativeStorage(owner: "host" | "call", callId?: string) {
  return Object.freeze({
    async reserve(bytes: number) {
      const result = await rpc(owner, "storage.reserve", [bytes], callId ?? null);
      const ticket = (result as { ticketId?: string }).ticketId;
      requireCondition(typeof ticket === "string",
        "extension_worker_storage_invalid",
        "Core storage did not issue a real reservation.");
      let released = false;
      const handle = Object.freeze({
        release() {
          if (released) return;
          rpc(owner, "storage.release", [ticket], callId ?? null);
          released = true;
        },
      });
      tickets.set(ticket, handle);
      return handle;
    },
  });
}

function invocation(id: string, payload: Record<string, unknown>): Invocation {
  const controller = new AbortController();
  callControllers.set(id, controller);
  const method = (path: string, args: unknown[]) =>
    rpc("call", path, args, id);
  const namespaces = (name: string, methods: readonly string[]) => {
    const result = Object.create(null) as Record<string, Function>;
    for (const methodName of methods)
      result[methodName] = (...args: unknown[]) => method(name + "." + methodName, args);
    return Object.freeze(result);
  };
  const outputNames = [
    "text", "json", "image", "images", "audio",
    "resourceLink", "file", "embeddedResource", "resource",
    "result", "error", "mcpResult", "mcpResourceResult",
  ];
  const output = namespaces("output", outputNames);
  const state = {
    agent: namespaces("state.agent", ["get", "set", "delete"]),
    user: namespaces("state.user", ["get", "set", "delete"]),
  };
  const transfer = namespaces("transfer",
    ["createUpload", "createDownload", "get", "list", "cancel"]);
  const maintenance = namespaces("maintenance", [
    "packages.install", "packages.update", "packages.remove",
    "extensions.enable", "extensions.disable",
    "mcp.add", "mcp.update", "mcp.remove",
    "api.import", "api.update", "api.remove",
    "get", "list", "cancel",
  ]);
  const hostRequests = payload.hasHostRequests
    ? namespaces("hostRequests", ["sampling", "elicitation", "roots"])
    : undefined;
  return Object.freeze({
    context: payload.context as JsonObject,
    operationId: payload.operationId as string,
    deadline: payload.deadline as number,
    signal: controller.signal,
    resources: nativeResources("call", id),
    storage: nativeStorage("call", id),
    output,
    state,
    transfer,
    maintenance,
    ...(hostRequests ? { hostRequests } : {}),
    authorize: (target: AccessTarget) => method("authorize", [target]),
    log: (value: LogEntry) => method("log", [value]),
    progress: (value: JsonObject) => method("progress", [value]),
    requestInput: (input: unknown) => method("requestInput", [input]),
  }) as unknown as Invocation;
}

async function initialize(payload: Record<string, unknown>) {
  send({ type: "progress", stage: "import_start", code: "extension_importing" });
  requireCondition(!initialized && typeof config.entryUrl === "string",
    "extension_worker_configuration", "The Worker entry must be an exact module.");
  const host: ExtensionHost = Object.freeze({
    context: payload.context as JsonObject,
    config: payload.config as JsonObject,
    signal: new AbortController().signal,
    resources: nativeResources("host"),
    storage: nativeStorage("host"),
    authorize: (target: AccessTarget) => rpc("host", "authorize", [target]),
    log: (entry: LogEntry) => { rpc("host", "log", [entry]); },
  });
  const module = await import(config.entryUrl);
  send({ type: "progress", stage: "import_complete", code: "extension_imported" });
  // No factory invocation or host resource creation is allowed until the
  // trusted Core has checked actual enablement, package files, and approval
  // after this asynchronous top-level module evaluation.
  send({ type: "imported" });
  await importAdmission.promise;
  const factory: unknown = Object.getOwnPropertyDescriptor(module, "default")?.value;
  requireCondition(typeof factory === "function",
    "extension_worker_factory_missing",
    "The approved package entry must default-export its extension factory.");
  initialized = await (factory as ExtensionFactory)(host);
  send({ type: "progress", stage: "factory_complete", code: "extension_factory_ready" });
  requireCondition(initialized && isPlainRecord(initialized.methods),
    "extension_worker_contract_invalid",
    "The extension must return a real method table.");
  const declarations: object[] = [];
  for (const [name, value] of Object.entries(initialized.methods)) {
    requireCondition(value && typeof value.handle === "function" &&
      typeof value.description === "string" &&
      Array.isArray(value.permissions),
    "extension_worker_contract_invalid",
    "Every extension method needs a real handler and declared permissions.");
    const contract = structuredClone({
      schema: value.inputSchema,
      dialect: value.schemaDialect,
      references: value.schemas,
    });
    methods.set(name, {
      definition: value, handle: value.handle, normalize: value.normalize, contract,
    });
    declarations.push({
      name, description: value.description,
      ...(value.callStyle === "input-object" ? { callStyle: value.callStyle } : {}),
      permissions: value.permissions, path: value.path,
      inputSchema: contract.schema,
      ...(contract.dialect ? { schemaDialect: contract.dialect } : {}),
      ...(contract.references ? { schemas: contract.references } : {}),
      ...(value.outputSchema === undefined
        ? {} : { outputSchema: value.outputSchema }),
      ...(value.outputSchemaDialect
        ? { outputSchemaDialect: value.outputSchemaDialect } : {}),
      normalizes: typeof value.normalize === "function",
    });
  }
  send({ type: "ready", methods: declarations });
}

function normalize(payload: Record<string, unknown>): unknown {
  requireCondition(initialized && typeof payload.method === "string",
    "extension_worker_unavailable",
    "The extension is not initialized.");
  const method = registeredMethod(payload.method);
  const envelope = payload.input as { __nexumWorkerArgs?: unknown[] };
  requireCondition(isPlainRecord(envelope) &&
    Array.isArray(envelope.__nexumWorkerArgs) &&
    envelope.__nexumWorkerArgs.length <= 8,
  "extension_worker_request_invalid",
  "The Worker must receive the original authorized SDK arguments.");
  const args = envelope.__nexumWorkerArgs;
  const normalized = method.normalize
    ? Reflect.apply(method.normalize, method.definition, [Object.freeze([...args])])
    : args.length <= 1 ? (args.length ? args[0] : {}) :
      (() => { throw new AgentError("invalid_arguments",
        "The extension method accepts at most one data argument."); })();
  requireCondition(!(normalized instanceof Promise),
    "invalid_normalizer",
    "An extension normalizer must finish synchronously.");
  validateMethod(method, normalized);
  return normalized;
}

async function invoke(payload: Record<string, unknown>): Promise<unknown> {
  requireCondition(initialized && typeof payload.method === "string",
    "extension_worker_unavailable",
    "The extension is not initialized.");
  const method = registeredMethod(payload.method);
  const normalized = payload.input;
  validateMethod(method, normalized);
  const id = payload.callId as string;
  try {
    const call = invocation(id, payload);
    return await Reflect.apply(method.handle, method.definition, [normalized, call]);
  } finally {
    callControllers.delete(id);
  }
}

port.on("message", (data: unknown) => {
  if (!isPlainRecord(data)) return;
  if (data.type === "import-admitted") {
    importAdmission.resolve();
    return;
  }
  if (data.type === "import-denied") {
    importAdmission.reject(new AgentError(
      isPublicErrorCode(data.code)
        ? data.code : "extension_package_changed",
      "The Core denied extension factory activation after native import.",
    ));
    return;
  }
  if (data.type === "call-abort" && typeof data.id === "string") {
    callControllers.get(data.id)?.abort();
    return;
  }
  if (data.type === "resource-abort" && typeof data.token === "string") {
    resources.get(data.token)?.controller.abort();
    return;
  }
  if (data.type === "reply" && typeof data.id === "string") {
    const current = waiting.get(data.id);
    waiting.delete(data.id);
    if (!current) return;
    if (data.error) current.reject(errorFromCore(data.error));
    else current.resolve(decode(data.value));
    return;
  }
  if (data.type !== "request" || typeof data.id !== "string") return;
  const id = data.id;
  void (async () => {
    try {
      if (data.kind === "initialize") await initialize(data);
      else if (data.kind === "normalize") {
        send({ type: "reply", id, value: normalize(data) });
        return;
      } else if (data.kind === "invoke") {
        const result = await invoke(data);
        send({ type: "reply", id, value: encode(result) });
        return;
      } else if (data.kind === "resource-dispose") {
        const resource = resources.get(String(data.token));
        requireCondition(resource,
          "extension_worker_resource_unavailable", "Unknown resource controller.");
        await resource.value.dispose();
      } else if (data.kind === "dispose") {
        if (!stopping) {
          await initialized?.dispose?.();
          stopping = true;
          methods.clear();
        }
      } else throw new AgentError("extension_worker_request_invalid",
        "Unknown Worker lifecycle action.");
      if (data.kind !== "initialize")
        send({ type: "reply", id, value: null });
    } catch (cause) {
      const error = componentError(cause);
      if (data.kind === "initialize")
        send({ type: "fatal", code: safeComponentCode(cause) });
      else send({ type: "reply", id, error });
    }
  })();
});
