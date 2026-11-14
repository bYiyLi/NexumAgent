import path from "node:path";
import { once } from "node:events";
import { types } from "node:util";
import { Blob, File } from "node:buffer";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import {
  canonicalJson,
  digest,
  newId,
  isPlainRecord,
} from "../contracts/json.js";
import type {
  ContributionOrigin,
  JsonObject,
  JsonValue,
} from "../contracts/types.js";
import { compileMethodSchema } from "../contracts/validation.js";
import type { RunServices } from "../runtime/engine.js";
import { extensionNamespace } from "../runtime/names.js";
import { NativePromiseAudit } from "../runtime/promises.js";
import { createOutput, outputIntent } from "../sdk/output.js";
import {
  ResourceManager,
  type ResourceInstance,
  type ResourceService,
  type ManagedResource,
} from "./resources.js";
import type {
  AccessTarget,
  ExtensionFactory,
  ExtensionHost,
  ExtensionInstance,
  Invocation,
  LogEntry,
  MethodDefinition,
} from "./api.js";

export interface ExtensionSource {
  apiVersion: 1;
  origin: ContributionOrigin;
  permissions: readonly string[];
  config?: JsonObject;
  /** Trusted platform adapters may expose e.g. mcp.github.tools without renaming the source tool. */
  bindingPath?: readonly string[];
}
export interface ExtensionHandle {
  readonly id: string;
  readonly origin: ContributionOrigin;
  readonly methods: readonly JsonObject[];
}
export interface RegistryPolicy {
  origin: ContributionOrigin;
  action: "prepare" | "publish" | "invoke" | "resource" | "disable";
  permissions: readonly string[];
  method?: string;
  runId?: string;
  context?: Readonly<JsonObject>;
  input?: unknown;
  target?: AccessTarget;
  scriptOrigin?: ContributionOrigin;
}
export interface RegistryOptions {
  cleanupTimeoutMs?: number;
  permissions: ReadonlySet<string>;
  authorize(policy: RegistryPolicy): void;
  log(
    origin: ContributionOrigin,
    entry: LogEntry,
    runId?: string,
    operationId?: string,
  ): void;
  progress(
    origin: ContributionOrigin,
    runId: string,
    operationId: string,
    value: JsonObject,
  ): void;
}
interface Method {
  name: string;
  path: readonly string[];
  metadata: JsonObject;
  permissions: readonly string[];
  normalize?: MethodDefinition["normalize"];
  handle: MethodDefinition["handle"];
  input(value: unknown): void;
  output?: (value: unknown) => void;
}
interface Entry {
  source: ExtensionSource;
  key: string;
  root: readonly string[];
  factory: ExtensionFactory;
  handle: ExtensionHandle;
  controller: AbortController;
  resources: ResourceInstance;
  protected: WeakSet<object>;
  methods: Method[];
  state:
    "preparing" | "ready" | "published" | "stopping" | "failed" | "disabled";
  calls: number;
  scripts: number;
  instance?: ExtensionInstance;
  preparation: Promise<ExtensionHandle>;
  recovery?: Promise<ExtensionHandle>;
  disposal?: Promise<JsonObject>;
  disposeTask?: Promise<void>;
  disposeDone?: AbortController;
  disposed?: boolean;
  disposeFailed?: boolean;
  dispose?: ExtensionInstance["dispose"];
  resourceTask?: Promise<void>;
  resourceDone?: AbortController;
  resourceReport?: JsonObject;
  resourceFailed?: boolean;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
const json = <T>(value: T): T => frozen(JSON.parse(canonicalJson(value)) as T);
// V8's native lazy stack accessor is data-bearing infrastructure, not an
// extension getter. It must remain usable without evaluating arbitrary getters.
const nativeStack = Object.getOwnPropertyDescriptor(new Error(), "stack");
const blobInternals = new Set(Reflect.ownKeys(new Blob([])));
const dataConstructors = [
  Object,
  Array,
  Date,
  RegExp,
  Map,
  Set,
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
  AggregateError,
  ArrayBuffer,
  SharedArrayBuffer,
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
];
const nativeDataConstructors = new Set(
  dataConstructors.map((value) => Function.prototype.toString.call(value)),
);
const dataPrototypes = new Set<object>([
  ...dataConstructors.map((value) => value.prototype),
  Object.getPrototypeOf(Uint8Array.prototype),
  Buffer.prototype,
  URL.prototype,
  Blob.prototype,
  File.prototype,
  AgentError.prototype,
]);
for (const key of blobInternals) {
  const value = Reflect.get(new Blob([]), key);
  if (value && typeof value === "object")
    dataPrototypes.add(Object.getPrototypeOf(value));
}
const segment = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 1024 &&
  !/[\0\r\n]/.test(value);
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const prefix = (left: readonly string[], right: readonly string[]) =>
  left.length <= right.length &&
  left.every(
    (value, index) => value.toLowerCase() === right[index]!.toLowerCase(),
  );

/** Core factory/method lifecycle. Package parsing and five-contribution preparation own publication readiness. */
export class ExtensionRegistry {
  readonly resources: ResourceManager;
  #options: RegistryOptions;
  #entries = new Set<Entry>();
  #handles = new WeakMap<ExtensionHandle, Entry>();
  constructor(resources: ResourceManager, options: RegistryOptions) {
    this.resources = resources;
    this.#options = { ...options, permissions: new Set(options.permissions) };
    requireCondition(
      Number.isSafeInteger(options.cleanupTimeoutMs ?? 5000) &&
        (options.cleanupTimeoutMs ?? 5000) > 0 &&
        (options.cleanupTimeoutMs ?? 5000) <= 30000,
      "invalid_extension_options",
      "Extension cleanup observation must be positive and bounded.",
    );
  }
  #authorize(policy: RegistryPolicy): void {
    authorizeCall(() => this.#options.authorize(policy));
  }
  prepare(
    value: ExtensionSource,
    factory: ExtensionFactory,
  ): Promise<ExtensionHandle> {
    const source = json(value);
    requireCondition(
      source.apiVersion === 1 &&
        source.origin &&
        segment(source.origin.version) &&
        segment(source.origin.revision) &&
        segment(source.origin.owner) &&
        segment(source.origin.namespace) &&
        ["platform", "extension"].includes(source.origin.type) &&
        typeof factory === "function",
      "invalid_extension",
      "An extension needs its actual source/version, supported API and factory.",
    );
    if (source.origin.type === "extension")
      extensionNamespace(source.origin.namespace);
    else
      requireCondition(
        [
          "nexum",
          "sh",
          "output",
          "transfer",
          "runtime",
          "state",
          "maintenance",
          "mcp",
          "api",
        ].includes(source.origin.namespace),
        "invalid_namespace",
        "A platform source must use its registered namespace.",
      );
    requireCondition(
      Array.isArray(source.permissions) &&
        new Set(source.permissions).size === source.permissions.length &&
        source.permissions.every(
          (permission) =>
            typeof permission === "string" &&
            this.#options.permissions.has(permission),
        ),
      "invalid_extension_permissions",
      "The extension must declare known permissions explicitly.",
    );
    const root = source.bindingPath ?? [source.origin.namespace];
    requireCondition(
      root.length > 0 &&
        root.length <= 8 &&
        root.every(segment) &&
        root[0] === source.origin.namespace &&
        (source.origin.type === "platform" || root.length === 1),
      "invalid_namespace",
      "The SDK path must stay inside its actual source namespace.",
    );
    this.#authorize({
      origin: source.origin,
      action: "prepare",
      permissions: source.permissions,
    });
    const key = digest(source);
    const previous = [...this.#entries].find(
      (entry) => prefix(entry.root, root) || prefix(root, entry.root),
    );
    if (previous) {
      requireCondition(
        previous.key === key &&
          previous.factory === factory &&
          ["preparing", "ready", "published", "failed"].includes(
            previous.state,
          ),
        "namespace_conflict",
        "A source already owns this namespace or a parent/child SDK path.",
      );
      if (previous.state === "failed") {
        if (!previous.recovery) {
          const recovery = this.#cleanup(previous).then((cleanup) => {
            requireCondition(
              cleanup.status === "disabled",
              "extension_cleanup_pending",
              "The failed instance must finish cleanup before another initialization.",
              { extensionId: previous.handle.id, cleanup },
            );
            this.#entries.delete(previous);
            return this.prepare(source, factory);
          });
          previous.recovery = recovery;
          void recovery
            .finally(() => {
              if (previous.recovery === recovery) previous.recovery = undefined;
            })
            .catch(() => {});
        }
        return previous.recovery;
      }
      return previous.preparation;
    }
    const controller = new AbortController();
    const handle = {
      id: newId("extension"),
      origin: source.origin,
      methods: [] as JsonObject[],
    };
    const preparation = Promise.withResolvers<ExtensionHandle>();
    void preparation.promise.catch(() => {});
    const entry: Entry = {
      source,
      key,
      root: Object.freeze([...root]),
      factory,
      controller,
      state: "preparing",
      calls: 0,
      scripts: 0,
      methods: [],
      protected: new WeakSet(),
      preparation: preparation.promise,
      handle,
      resources: undefined!,
    };
    this.#entries.add(entry);
    this.#handles.set(handle, entry);
    try {
      entry.resources = this.resources.instance(source.origin, {
        signal: controller.signal,
        assertActive: () => this.#instance(entry),
        authorize: () =>
          this.#authorize({
            origin: source.origin,
            action: "resource",
            permissions: source.permissions,
          }),
      });
    } catch (error) {
      this.#entries.delete(entry);
      this.#handles.delete(handle);
      preparation.reject(error);
      return preparation.promise;
    }
    // Defer initialization until this one shared promise and namespace reservation exist.
    void Promise.resolve()
      .then(() => this.#initialize(entry))
      .then(preparation.resolve, preparation.reject);
    return entry.preparation;
  }
  #instance(entry: Entry): void {
    requireCondition(
      this.#entries.has(entry) &&
        ["preparing", "ready", "published"].includes(entry.state) &&
        !entry.controller.signal.aborted,
      "extension_unavailable",
      "The originating extension instance is not available.",
    );
  }
  #protectResources(entry: Entry, inner: ResourceService): ResourceService {
    const protect = <T extends { value: object }>(value: T): T => {
      entry.protected.add(value);
      entry.protected.add(value.value);
      return value;
    };
    const api: ResourceService = Object.freeze({
      register: async <T extends ManagedResource>(input: {
        kind: string;
        value: T;
      }) => {
        // A synchronous handler may start registration without awaiting it and
        // immediately return its controller. Protect the value before yielding.
        if (
          input?.value &&
          (typeof input.value === "object" || typeof input.value === "function")
        )
          entry.protected.add(input.value);
        return protect(await inner.register(input));
      },
      get: async <T extends ManagedResource>(id: string) =>
        protect(await inner.get<T>(id)),
      handoff: (id: string) => inner.handoff(id),
    });
    entry.protected.add(api);
    return api;
  }
  async #initialize(entry: Entry): Promise<ExtensionHandle> {
    const audit = new NativePromiseAudit();
    const root = this.resources.store.root;
    const host: ExtensionHost = Object.freeze({
      context: json({
        agentId: this.resources.store.binding.agentId,
        profile: this.resources.store.binding.profile,
        paths: {
          work: path.join(root, "work"),
          docs: path.join(root, "work", "docs"),
          resources: path.join(root, "work", "resources"),
        },
      }),
      config: json(entry.source.config ?? {}),
      signal: entry.controller.signal,
      resources: this.#protectResources(entry, entry.resources.resources),
      log: (value: LogEntry) => this.#log(entry, value),
    });
    entry.protected.add(host);
    entry.protected.add(host.config);
    entry.protected.add(host.context);
    try {
      const candidate = await audit.run(() => entry.factory(host));
      requireCondition(
        candidate && typeof candidate === "object" && !types.isProxy(candidate),
        "invalid_extension",
        "A factory must return a complete method table.",
      );
      entry.instance = candidate;
      entry.protected.add(candidate);
      let prototype: object | null = candidate;
      while (prototype) {
        requireCondition(
          !types.isProxy(prototype),
          "invalid_extension",
          "An instance cannot hide lifecycle callbacks behind a proxy.",
        );
        const dispose = Object.getOwnPropertyDescriptor(prototype, "dispose");
        if (dispose) {
          requireCondition(
            "value" in dispose &&
              (dispose.value === undefined ||
                typeof dispose.value === "function"),
            "invalid_extension",
            "dispose must be an actual lifecycle function.",
          );
          entry.dispose = dispose.value;
          break;
        }
        prototype = Object.getPrototypeOf(prototype);
      }
      const table = Object.getOwnPropertyDescriptor(candidate, "methods");
      requireCondition(
        table && "value" in table && isPlainRecord(table.value),
        "invalid_extension",
        "The method table must be a stable data property.",
      );
      const declarations = table.value as Readonly<
        Record<string, MethodDefinition>
      >;
      const methods: Method[] = [];
      for (const name of Object.keys(declarations)) {
        requireCondition(
          segment(name),
          "invalid_method",
          "A method name must be bounded text.",
        );
        const descriptor = Object.getOwnPropertyDescriptor(declarations, name);
        requireCondition(
          descriptor &&
            "value" in descriptor &&
            descriptor.value &&
            typeof descriptor.value === "object" &&
            !types.isProxy(descriptor.value),
          "invalid_method",
          "Method declarations must be stable data properties.",
        );
        const fields = Object.getOwnPropertyDescriptors(descriptor.value);
        requireCondition(
          Object.values(fields).every((field) => "value" in field),
          "invalid_method",
          "Method metadata cannot execute getters.",
        );
        const def = Object.fromEntries(
          Object.entries(fields).map(([key, field]) => [key, field.value]),
        ) as unknown as MethodDefinition;
        requireCondition(
          typeof def.description === "string" &&
            def.description.length > 0 &&
            def.description.length <= 4096 &&
            typeof def.handle === "function" &&
            Array.isArray(def.permissions) &&
            new Set(def.permissions).size === def.permissions.length &&
            def.permissions.every((permission) =>
              entry.source.permissions.includes(permission),
            ) &&
            (def.normalize === undefined ||
              typeof def.normalize === "function"),
          "invalid_method",
          "A method needs a description, explicit permission subset and handler.",
        );
        const target = def.path ?? [name];
        requireCondition(
          target.length > 0 &&
            target.length <= 8 &&
            target.every(segment) &&
            !methods.some(
              (method) =>
                (method.path.length <= target.length &&
                  method.path.every(
                    (value, index) => value === target[index],
                  )) ||
                (target.length <= method.path.length &&
                  target.every((value, index) => value === method.path[index])),
            ),
          "method_conflict",
          "Two methods cannot claim the same SDK path or its parent/child.",
        );
        const metadata = json({
          name,
          path: [...target],
          description: def.description,
          permissions: [...def.permissions],
          inputSchema: def.inputSchema,
          ...(def.schemas ? { schemas: def.schemas } : {}),
          ...(def.schemaDialect ? { schemaDialect: def.schemaDialect } : {}),
          ...(def.outputSchema === undefined
            ? {}
            : { outputSchema: def.outputSchema }),
          ...(def.outputSchemaDialect
            ? { outputSchemaDialect: def.outputSchemaDialect }
            : {}),
        }) as unknown as JsonObject;
        const input = compileMethodSchema(
          metadata.inputSchema,
          def.schemaDialect,
          metadata.schemas as readonly unknown[] | undefined,
        );
        const output =
          def.outputSchema === undefined
            ? undefined
            : compileMethodSchema(
                metadata.outputSchema,
                def.outputSchemaDialect ??
                  (typeof def.outputSchema === "object" &&
                  def.outputSchema &&
                  "$schema" in def.outputSchema
                    ? undefined
                    : def.schemaDialect),
                metadata.schemas as readonly unknown[] | undefined,
              );
        entry.protected.add(def.handle);
        methods.push({
          name,
          path: Object.freeze([...target]),
          metadata,
          permissions: Object.freeze([...def.permissions]),
          normalize: def.normalize,
          handle: def.handle,
          input,
          output,
        });
      }
      await audit.checkpoint();
      this.#instance(entry);
      this.#authorize({
        origin: entry.source.origin,
        action: "prepare",
        permissions: entry.source.permissions,
      });
      entry.methods = methods;
      Object.assign(entry.handle, {
        methods: Object.freeze(methods.map((method) => method.metadata)),
      });
      Object.freeze(entry.handle);
      entry.state = "ready";
      return entry.handle;
    } catch (cause) {
      entry.state = "failed";
      entry.controller.abort(
        new AgentError(
          "extension_initialization_failed",
          "The extension failed before publication.",
        ),
      );
      const cleanup = await this.#cleanup(entry).catch(() => null);
      if (cleanup?.status === "disabled") this.#entries.delete(entry);
      throw new AgentError(
        "extension_initialization_failed",
        "The extension's factory or declared method table could not be prepared.",
        { extensionId: entry.handle.id, ...(cleanup ? { cleanup } : {}) },
        { cause },
      );
    } finally {
      audit.close();
    }
  }
  #entry(handle: ExtensionHandle): Entry {
    const entry = this.#handles.get(handle);
    requireCondition(
      entry,
      "extension_unavailable",
      "This is not an extension instance from this Agent/profile.",
    );
    return entry;
  }
  publish(handle: ExtensionHandle): void {
    const entry = this.#entry(handle);
    this.#instance(entry);
    this.#authorize({
      origin: entry.source.origin,
      action: "publish",
      permissions: entry.source.permissions,
    });
    requireCondition(
      entry.state === "ready" || entry.state === "published",
      "extension_not_ready",
      "Only a completely prepared extension may be published.",
    );
    entry.state = "published";
  }
  bindings(services: RunServices): Readonly<Record<string, unknown>> {
    const result = Object.create(null) as Record<string, unknown>;
    for (const entry of this.#entries)
      if (entry.state === "published")
        for (const method of entry.methods) {
          const keys = [...entry.root, ...method.path];
          let node = result;
          for (const key of keys.slice(0, -1)) {
            if (!Object.hasOwn(node, key))
              Object.defineProperty(node, key, {
                value: Object.create(null),
                enumerable: true,
              });
            node = node[key] as Record<string, unknown>;
          }
          Object.defineProperty(node, keys.at(-1)!, {
            value: (...args: unknown[]) =>
              this.#invoke(entry, method, services, args),
            enumerable: true,
          });
        }
    const freeze = (node: Record<string, unknown>): void => {
      for (const value of Object.values(node))
        if (value && typeof value === "object")
          freeze(value as Record<string, unknown>);
      Object.freeze(node);
    };
    freeze(result);
    return result;
  }
  #invoke(
    entry: Entry,
    method: Method,
    services: RunServices,
    args: readonly unknown[],
  ): unknown {
    services.assertActive();
    this.#instance(entry);
    requireCondition(
      entry.state === "published",
      "extension_unavailable",
      "This extension is no longer admitting SDK calls.",
    );
    let input: unknown;
    if (method.normalize) {
      try {
        input = Reflect.apply(method.normalize, undefined, [
          Object.freeze([...args]),
        ]);
      } catch (cause) {
        throw this.#failure(entry, cause);
      }
      if (types.isPromise(input)) {
        void Promise.prototype.then.call(input, undefined, () => {});
        throw new AgentError(
          "invalid_normalizer",
          "A method normalizer must return data synchronously.",
        );
      }
    } else {
      requireCondition(
        args.length <= 1,
        "invalid_arguments",
        "This method accepts at most one input argument.",
      );
      input = args.length ? args[0] : {};
    }
    method.input(input);
    const policy: RegistryPolicy = {
      origin: entry.source.origin,
      action: "invoke",
      permissions: method.permissions,
      method: method.name,
      runId: services.runId,
      context: services.context,
      input,
    };
    this.#authorize(policy);
    entry.calls++;
    let active = true;
    const current = () => {
      requireCondition(
        active,
        "invocation_closed",
        "The originating method invocation has already settled.",
      );
      services.assertCurrent();
      this.#instance(entry);
      this.#authorize(policy);
    };
    const close = () => {
      if (active) {
        active = false;
        entry.calls--;
      }
    };
    let entered = false;
    try {
      return services.operation(
        entry.source.origin,
        method.name,
        (operationId) => {
          entered = true;
          const resources = this.#protectResources(
            entry,
            entry.resources.bind({
              runId: services.runId,
              signal: services.signal,
              assertActive: current,
              authorize: (action, id) =>
                this.#authorize({
                  ...policy,
                  action: "resource",
                  ...(id
                    ? {
                        target: { type: "resource", value: id, access: action },
                      }
                    : {}),
                }),
            }),
          );
          const call: Invocation = Object.freeze({
            context: services.context,
            operationId,
            signal: services.signal,
            deadline: services.deadlineAt,
            resources,
            output: createOutput(services.context.pwd as string, current),
            log: (value: LogEntry) => {
              current();
              this.#log(entry, value, services.runId, operationId);
            },
            progress: (value: JsonObject) => {
              current();
              const data = json(value);
              canonicalJson(data, 16384);
              this.#options.progress(
                entry.source.origin,
                services.runId,
                operationId,
                data,
              );
            },
            authorize: (target: AccessTarget) => {
              current();
              requireCondition(
                target &&
                  [
                    "path",
                    "url",
                    "resource",
                    "connection",
                    "agent-state",
                    "user-state",
                  ].includes(target.type) &&
                  segment(target.value) &&
                  segment(target.access),
                "invalid_access_target",
                "An access check needs a bounded target and action.",
              );
              this.#authorize({ ...policy, target: json(target) });
            },
            requestInput: (
              request: Parameters<Invocation["requestInput"]>[0],
            ) => {
              current();
              return services.requestInput(request);
            },
          });
          entry.protected.add(call);
          entry.protected.add(call.output);
          return Reflect.apply(method.handle, undefined, [input, call]);
        },
        {
          complete: (value) => {
            this.#result(entry, value);
            if (method.output) {
              const result = outputIntent(value);
              if (result?.kind === "result") {
                const payload = result.value as {
                  isError?: boolean;
                  structuredContent?: unknown;
                };
                if (
                  !payload.isError &&
                  Object.hasOwn(payload, "structuredContent")
                )
                  method.output(payload.structuredContent);
              } else if (result?.kind === "json") method.output(result.value);
              else if (!result && !this.#media(value)) method.output(value);
            }
            return value;
          },
          failure: (cause) => this.#failure(entry, cause),
          settled: close,
        },
      );
    } catch (error) {
      // Once admitted, only the operation's actual settlement releases its
      // occupancy. An observation failure does not prove the work stopped.
      if (!entered) close();
      throw error;
    }
  }
  #media(value: unknown): boolean {
    if (outputIntent(value)) return true;
    if (Array.isArray(value))
      return value.length > 0 && value.every((item) => this.#media(item));
    if (!isPlainRecord(value)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "type");
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !["text", "image", "audio", "resource_link", "resource"].includes(
        descriptor.value,
      )
    )
      return false;
    // Reuse the public content validator; a type tag by itself is not media.
    createOutput(this.resources.store.root, () => {}).result({
      content: [value],
    });
    return true;
  }
  #failure(entry: Entry, cause: unknown): unknown {
    try {
      this.#result(entry, cause);
      return cause;
    } catch {
      return new AgentError(
        "invalid_sdk_result",
        "The SDK failure contains a private control value or unsupported data.",
      );
    }
  }
  #result(
    entry: Entry,
    value: unknown,
    seen = new Set<object>(),
    internal = false,
  ): void {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return;
    requireCondition(
      !entry.protected.has(value) &&
        typeof value !== "function" &&
        !types.isProxy(value),
      "invalid_sdk_result",
      "A method cannot return its host, invocation, handler or raw resource controls.",
    );
    if (seen.has(value)) return;
    seen.add(value);
    requireCondition(
      seen.size <= 100000,
      "data_too_large",
      "The SDK result exceeds its object budget.",
    );
    let prototype = Object.getPrototypeOf(value),
      depth = 0;
    while (prototype) {
      requireCondition(
        ++depth <= 64 &&
          !types.isProxy(prototype) &&
          !entry.protected.has(prototype),
        "invalid_sdk_result",
        "SDK result prototypes cannot expose private controls.",
      );
      const constructor = Object.getOwnPropertyDescriptor(
        prototype,
        "constructor",
      );
      const native =
        constructor &&
        "value" in constructor &&
        typeof constructor.value === "function" &&
        !types.isProxy(constructor.value) &&
        nativeDataConstructors.has(
          Function.prototype.toString.call(constructor.value),
        ) &&
        Object.getOwnPropertyDescriptor(constructor.value, "prototype")
          ?.value === prototype;
      requireCondition(
        dataPrototypes.has(prototype) || native,
        "invalid_sdk_result",
        "SDK data must retain its ordinary built-in prototype, not a custom control prototype.",
      );
      prototype = Object.getPrototypeOf(prototype);
    }
    const blob = value instanceof Blob;
    const error = types.isNativeError(value);
    requireCondition(
      internal ||
        Array.isArray(value) ||
        isPlainRecord(value) ||
        outputIntent(value) ||
        types.isArrayBufferView(value) ||
        types.isAnyArrayBuffer(value) ||
        types.isMap(value) ||
        types.isSet(value) ||
        types.isDate(value) ||
        types.isRegExp(value) ||
        error ||
        value instanceof URL ||
        blob,
      "invalid_sdk_result",
      "An SDK result contains an unsupported class or control object.",
    );
    // Check non-enumerable values too: scripts receive this value before MCP
    // encoding and could otherwise read e.g. Error.cause or a hidden controller.
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        error &&
        key === "stack" &&
        descriptor.get === nativeStack?.get &&
        descriptor.set === nativeStack?.set &&
        !descriptor.enumerable
      )
        continue;
      const nativeBlobField = blob && blobInternals.has(key);
      requireCondition(
        (typeof key === "string" || nativeBlobField) && "value" in descriptor,
        "invalid_sdk_result",
        "SDK result data cannot hide controls behind accessors or Symbol keys.",
      );
      this.#result(entry, descriptor.value, seen, nativeBlobField);
    }
    if (types.isMap(value))
      Map.prototype.forEach.call(value, (item: unknown, key: unknown) => {
        this.#result(entry, key, seen);
        this.#result(entry, item, seen);
      });
    else if (types.isSet(value))
      Set.prototype.forEach.call(value, (item: unknown) =>
        this.#result(entry, item, seen),
      );
  }
  #log(
    entry: Entry,
    value: LogEntry,
    runId?: string,
    operationId?: string,
  ): void {
    const data = json(value);
    requireCondition(
      ["debug", "info", "warn", "error"].includes(data.level) &&
        typeof data.message === "string",
      "invalid_log",
      "A log entry needs an explicit level and text message.",
    );
    canonicalJson(data, 16384);
    this.#options.log(entry.source.origin, data, runId, operationId);
  }
  lease(origin: ContributionOrigin): () => void {
    const entries = [...this.#entries].filter((item) =>
      same(
        [
          item.source.origin.owner,
          item.source.origin.namespace!,
          item.source.origin.version!,
        ],
        [origin.owner, origin.namespace!, origin.version!],
      ),
    );
    const entry = entries.length === 1 ? entries[0] : undefined;
    requireCondition(
      entry && entry.state === "published",
      "extension_unavailable",
      "The script source is not the published extension revision.",
    );
    this.#instance(entry);
    this.#authorize({
      origin: entry.source.origin,
      action: "invoke",
      permissions: [],
      scriptOrigin: json(origin),
    });
    entry.scripts++;
    let active = true;
    return () => {
      if (active) {
        active = false;
        entry.scripts--;
      }
    };
  }
  disable(handle: ExtensionHandle): Promise<JsonObject> {
    const entry = this.#entry(handle);
    this.#authorize({
      origin: entry.source.origin,
      action: "disable",
      permissions: entry.source.permissions,
    });
    if (entry.state === "disabled")
      return Promise.resolve({ status: "disabled" });
    requireCondition(
      entry.state !== "preparing" &&
        entry.calls === 0 &&
        entry.scripts === 0 &&
        !entry.resources.busy(),
      "extension_busy",
      "Calls, active source scripts or independent business resources still use this version.",
    );
    if (entry.disposal) return entry.disposal;
    entry.state = "stopping";
    entry.controller.abort(
      new AgentError(
        "extension_stopping",
        "The originating extension instance is stopping.",
      ),
    );
    const work = this.#cleanup(entry).then((report) => {
      if (report.status === "disabled") {
        entry.state = "disabled";
        this.#entries.delete(entry);
      }
      return report;
    });
    entry.disposal = work;
    void work
      .finally(() => {
        if (entry.disposal === work) entry.disposal = undefined;
      })
      .catch(() => {});
    return work;
  }
  async #cleanup(entry: Entry): Promise<JsonObject> {
    if (!entry.disposed && !entry.disposeTask) {
      const done = new AbortController();
      entry.disposeDone = done;
      entry.disposeFailed = false;
      const task = Promise.resolve().then(() =>
        entry.dispose
          ? Reflect.apply(entry.dispose, entry.instance, [])
          : undefined,
      );
      entry.disposeTask = task;
      void task.then(
        () => {
          entry.disposed = true;
          done.abort();
        },
        () => {
          entry.disposeFailed = true;
          if (entry.disposeTask === task) entry.disposeTask = undefined;
          done.abort();
        },
      );
    }
    if (!entry.resourceTask) {
      const done = new AbortController();
      entry.resourceDone = done;
      entry.resourceFailed = false;
      entry.resourceTask = Promise.resolve()
        .then(() => entry.resources.stop())
        .then(
          (report) => {
            entry.resourceReport = report;
            done.abort();
          },
          () => {
            entry.resourceFailed = true;
            done.abort();
          },
        );
    }
    const observer = new AbortController();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      this.#options.cleanupTimeoutMs ?? 5000,
    );
    try {
      const waits = [entry.disposeDone, entry.resourceDone]
        .filter(
          (done): done is AbortController => !!done && !done.signal.aborted,
        )
        .map((done) => once(done.signal, "abort", { signal: observer.signal }));
      if (waits.length)
        await Promise.race([
          Promise.all(waits),
          once(timeout.signal, "abort", { signal: observer.signal }),
        ]);
    } finally {
      clearTimeout(timer);
      observer.abort();
    }
    const resourcePending = !entry.resourceDone?.signal.aborted;
    const report = entry.resourceReport ?? { pending: resourcePending };
    const unconfirmed = Array.isArray(report.unconfirmed)
      ? report.unconfirmed.length > 0
      : true;
    const complete =
      entry.disposed &&
      !entry.disposeFailed &&
      !resourcePending &&
      !entry.resourceFailed &&
      !unconfirmed;
    if (!resourcePending && (entry.resourceFailed || unconfirmed))
      entry.resourceTask = undefined;
    return {
      status: complete ? "disabled" : "stopping",
      disposeFailed: !!entry.disposeFailed,
      disposePending: !entry.disposed && !entry.disposeFailed,
      cleanup: report,
      ...(entry.resourceFailed ? { resourceCleanupFailed: true } : {}),
    };
  }
}
