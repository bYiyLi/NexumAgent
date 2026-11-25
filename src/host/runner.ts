import { AgentError, isAgentError, requireCondition } from "../contracts/errors.js";
import { decodeGoResult, encodeGoArguments } from "./blob.js";
import { decodeHostBrands, type HostBrandServices } from "./brands.js";
import { isPlainRecord } from "../contracts/json.js";
import type { ResourceReadResolver } from "./resource-read.js";
import type { ModuleLoader } from "../runtime/modules.js";
import type { WorkerCompile } from "../runtime/worker-execution.js";

/** Inputs are prepared by the trusted host after Go has admitted a Run. */
export interface HostRun {
  readonly runId: string;
  readonly code: string;
  readonly context: unknown;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly filename?: string;
  readonly console?: Console;
  readonly signal?: AbortSignal;
  readonly onModule?: WorkerCompile["onModule"];
  readonly onScriptError?: WorkerCompile["onScriptError"];
  readonly onDiagnostic?: WorkerCompile["onDiagnostic"];
  readonly onAbort?: () => void;
  /** Acknowledge registration with Go before the Worker can execute. */
  readonly onAccepted?: () => Promise<void>;
  /** Close admission and resolve any unawaited input requests on root return. */
  readonly onRootReturned: () => void;
  /** Join the Run's admitted SDK operations before its result is delivered. */
  readonly settleOperations: () => Promise<void>;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly completion: Promise<unknown>;
}

export interface GoMethod {
  readonly methodId: string;
  readonly path: readonly string[];
}

export interface GoRunScope {
  readonly instanceId: string;
  readonly runId: string;
  readonly methods: readonly GoMethod[];
}

export interface GoScopeBindings {
  readonly bindings: Readonly<Record<string, unknown>>;
  onAbort(): void;
  onRootReturned(): boolean;
  settleOperations(): Promise<void>;
}

/** Bind asynchronous SDK methods to a scope sent over the trusted Go channel. */
export function bindGoScope(
  scope: GoRunScope,
  call: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  brands?: HostBrandServices,
  readResource?: ResourceReadResolver,
): GoScopeBindings {
  requireCondition(typeof scope.instanceId === "string" && scope.instanceId.length > 0 &&
    typeof scope.runId === "string" && scope.runId.length > 0 &&
    Array.isArray(scope.methods) && scope.methods.length <= 4096,
  "invalid_run_scope", "The Go Run scope is invalid.");
  const instanceId = scope.instanceId;
  const runId = scope.runId;
  const root: Record<string, unknown> = Object.create(null);
  const operations = new Set<Promise<unknown>>();
  const inputs = new Set<Promise<unknown>>();
  let accepting = true;
  for (const method of scope.methods) {
    requireCondition(typeof method.methodId === "string" && method.methodId.length > 0 &&
      method.methodId.length <= 1024 && Array.isArray(method.path) &&
      method.path.length > 0 && method.path.length <= 8 &&
      method.path.every((key: unknown, index: number) => typeof key === "string" &&
        (index === 0 ? /^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,256}$/.test(key) : key.length <= 8192)) &&
      method.path[0] !== "context",
    "invalid_run_scope", "The Go Run method path is invalid.");
    let node = root;
    for (const key of method.path.slice(0, -1)) {
      if (!Object.hasOwn(node, key)) node[key] = Object.create(null);
      requireCondition(typeof node[key] === "object" && node[key] !== null,
        "invalid_run_scope", "Go Run method paths conflict.");
      node = node[key] as Record<string, unknown>;
    }
    const key = method.path[method.path.length - 1]!;
    requireCondition(!Object.hasOwn(node, key), "invalid_run_scope",
      "Go Run method paths conflict.");
    const methodId = method.methodId;
    node[key] = (...args: unknown[]) => {
      requireCondition(accepting && !signal.aborted, "invocation_closed",
        "The Run no longer accepts new SDK calls.");
      requireCondition(operations.size < 256, "worker_capacity_exhausted",
        "The Run has too many in-flight SDK calls.");
      const operation = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        const binaryScope = { instanceId, runId, methodId };
        const encoded = await encodeGoArguments(args, binaryScope, call, signal);
        try {
          const result = await call("sdk.call", { instanceId, runId, methodId,
            arguments: encoded.arguments, ...(encoded.binaryInputs.length > 0 ? { binaryInputs: encoded.binaryInputs } : {}) }, signal);
          const decoded = await decodeGoResult(result, binaryScope, call, signal);
          requireCondition(isPlainRecord(result), "invalid_sdk_result", "The SDK response is invalid.");
          // This method's private receipt is not an SDK value. Resolve it in
          // the trusted Host using its exact Go method identity, never a
          // guest-supplied output object or arbitrary local resource path.
          if (method.path.length === 2 && method.path[0] === "runtime" && method.path[1] === "readResource") {
            requireCondition(readResource && Array.isArray(result.binaryOutputs) && result.binaryOutputs.length === 0 &&
              (result.brands === undefined || (Array.isArray(result.brands) && result.brands.length === 0)),
              "resource_read_unavailable", "The registered resource reader is unavailable.");
            return await readResource(decoded, methodId);
          }
          return decodeHostBrands(decoded, result.brands ?? [], brands);
        } catch (cause) {
          if (isAgentError(cause) && cause.code === "api_http_error") {
            const response = Object.getOwnPropertyDescriptor(cause, "response");
            const outputs = Object.getOwnPropertyDescriptor(cause, "binaryOutputs");
            if (response && "value" in response && outputs && "value" in outputs && Array.isArray(outputs.value)) {
              const restored = await decodeGoResult({ value: response.value, binaryOutputs: outputs.value },
                binaryScope, call, signal);
              Object.defineProperty(cause, "response", { value: restored, enumerable: true });
            }
          }
          throw cause;
        }
      });
      operations.add(operation);
      if (method.path.length === 2 && method.path[0] === "runtime" && method.path[1] === "requestInput") inputs.add(operation);
      const settled = () => { operations.delete(operation); inputs.delete(operation); };
      void operation.then(settled, settled);
      return operation;
    };
  }
  return {
    bindings: root,
    onAbort() { accepting = false; },
    onRootReturned() { accepting = false; return inputs.size > 0; },
    async settleOperations() {
      while (operations.size > 0) await Promise.allSettled([...operations]);
    },
  };
}

/** Executes already-admitted Runs through the existing scoped ModuleLoader. */
export class HostRunner {
  readonly #loader: ModuleLoader;
  readonly #active = new Map<string, ActiveRun>();
  #closing = false;
  #closeTask?: Promise<void>;

  constructor(loader: ModuleLoader) {
    this.#loader = loader;
  }

  start(run: HostRun): Promise<unknown> {
    requireCondition(!this.#closing, "host_closing", "The Node host is closing.");
    requireCondition(typeof run.runId === "string" && run.runId.length > 0,
      "invalid_run_id", "A Run needs its Go-issued identity.");
    requireCondition(!this.#active.has(run.runId), "run_already_active",
      "This Run already has an active Worker.");
    requireCondition(typeof run.onRootReturned === "function" &&
      typeof run.settleOperations === "function", "invalid_run_scope",
    "The trusted host must provide Run lifecycle services.");

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(run.signal?.reason);
    const stopAdmission = () => run.onAbort?.();
    controller.signal.addEventListener("abort", stopAdmission, { once: true });
    if (run.signal?.aborted) forwardAbort();
    else run.signal?.addEventListener("abort", forwardAbort, { once: true });
    const completion = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      await run.onAccepted?.();
      controller.signal.throwIfAborted();
      let admissionClosed = false;
      const closeAdmission = () => {
        if (admissionClosed) return;
        admissionClosed = true;
        run.onRootReturned();
      };
      const execute = await this.#loader.compileIsolated(
        run.code,
        { ...run.bindings, context: run.context },
        {
          signal: controller.signal,
          filename: run.filename,
          console: run.console,
          onModule: run.onModule,
          onScriptError: run.onScriptError,
          onDiagnostic: run.onDiagnostic,
          onRootReturned: closeAdmission,
        },
      );
      let value: unknown;
      let failure: unknown;
      let failed = false;
      try {
        controller.signal.throwIfAborted();
        value = await execute();
        await run.settleOperations();
        await execute.flushCallbacks();
        await run.settleOperations();
        await execute.audit();
        controller.signal.throwIfAborted();
      } catch (cause) {
        failed = true;
        failure = cause;
        if (!controller.signal.aborted)
          controller.abort(new AgentError("run_failed", "The Run failed and is closing."));
      }
      try {
        closeAdmission();
        await run.settleOperations();
        if (!controller.signal.aborted) await execute.flushCallbacks();
      } catch (cause) {
        if (!failed) {
          failed = true;
          failure = cause;
        }
      }
      try {
        await execute.close();
      } catch (cause) {
        if (!failed) {
          failed = true;
          failure = cause;
        }
      }
      if (failed) throw failure;
      return value;
    }).finally(() => {
      run.signal?.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", stopAdmission);
      this.#active.delete(run.runId);
    });
    this.#active.set(run.runId, { controller, completion });
    return completion;
  }

  cancel(runId: string): boolean {
    const run = this.#active.get(runId);
    if (!run) return false;
    run.controller.abort(new AgentError("run_cancelled", "The Run was cancelled."));
    return true;
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closing = true;
    const runs = [...this.#active.values()];
    for (const run of runs)
      run.controller.abort(new AgentError("host_closing", "The Node host is closing."));
    this.#closeTask = Promise.allSettled(runs.map((run) => run.completion)).then(() => {});
    return this.#closeTask;
  }
}
