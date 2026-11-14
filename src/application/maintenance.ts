import { AgentError, requireCondition } from "../contracts/errors.js";
import { callerKey, type Caller } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { validateContract } from "../contracts/validation.js";
import type { JsonObject } from "../contracts/types.js";
import type {
  WireInvokeV2,
  WireOperationV2,
  WireInputsV2,
  WireOutputsV2,
} from "../contracts/wire.js";
import {
  MaintenanceRequests,
  type MaintenanceAuthority,
  type MaintenanceBackend,
  type MaintenanceIdentity,
  type MaintenanceScope,
  type MaintenanceDraftInput,
  type MaintenanceOAuthBinding,
  type MaintenanceOAuthComplete,
  type MaintenanceRequestView,
} from "../maintenance/requests.js";
import {
  MaintenanceBackends,
  NpmMaintenanceBackend,
} from "../maintenance/npm.js";
import type { ProfileConfiguration } from "./config.js";
import type { ApplicationComponents, AgentRuntimeOptions } from "./runtime.js";

const plain = <T>(value: unknown): T => JSON.parse(canonicalJson(value)) as T;

/** The six authority methods use the authenticated connection; scripts cannot mint decisions. */
export class ControlMaintenanceAuthority implements MaintenanceAuthority {
  constructor(readonly components: ApplicationComponents) {}
  #context(identity: MaintenanceIdentity) {
    const { store } = this.components;
    for (const key of ["agentId", "profile", "cloudEnvironment"] as const)
      requireCondition(
        identity[key] === store.binding[key],
        "maintenance_binding_mismatch",
        "Maintenance belongs to this Agent profile only.",
      );
    const caller: Caller = {
      principalId: identity.principalId,
      clientId: identity.clientId,
      grantId: identity.grantId,
    };
    requireCondition(
      callerKey(caller) === identity.callerKey,
      "maintenance_binding_mismatch",
      "The verified maintenance caller does not match its identity.",
    );
    return this.components.context(caller);
  }
  async #request<O extends WireOperationV2>(
    identity: MaintenanceIdentity,
    operation: O,
    input: WireInputsV2[O],
    signal: AbortSignal,
  ): Promise<WireOutputsV2[O]> {
    return await this.components
      .control()
      .request(operation, this.#context(identity), input, signal);
  }
  create: MaintenanceAuthority["create"] = async (who, input, signal) =>
    plain(
      await this.#request(who, "maintenance.request.create", input, signal),
    );
  get: MaintenanceAuthority["get"] = async (who, requestId, signal) =>
    plain(
      await this.#request(
        who,
        "maintenance.request.get",
        { requestId },
        signal,
      ),
    );
  list: MaintenanceAuthority["list"] = async (who, options, signal) =>
    plain(
      await this.#request(who, "maintenance.request.list", options, signal),
    );
  cancel: MaintenanceAuthority["cancel"] = async (who, requestId, signal) =>
    plain(
      await this.#request(
        who,
        "maintenance.request.cancel",
        { requestId },
        signal,
      ),
    );
  decision: MaintenanceAuthority["decision"] = async (who, requestId, signal) =>
    plain(
      await this.#request(
        who,
        "maintenance.request.decision",
        { requestId },
        signal,
      ),
    );
  beginExecution: MaintenanceAuthority["beginExecution"] = async (
    who,
    input,
    signal,
  ) =>
    plain(
      await this.#request(
        who,
        "maintenance.request.beginExecution",
        input,
        signal,
      ),
    );
}

interface Execution {
  readonly controller: AbortController;
  readonly callerKey: string;
  readonly grantId: string | undefined;
  readonly accepted: Promise<void>;
  readonly task: Promise<MaintenanceRequestView>;
}
function observe<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Transport adaptation around the existing maintenance operation and native controller. */
export class MaintenanceApplication {
  readonly requests: MaintenanceRequests;
  #executions = new Map<string, Execution>();
  #pending = new Set<Promise<unknown>>();
  #closed = false;
  #unregister: () => void;
  constructor(
    readonly components: ApplicationComponents,
    backend: MaintenanceBackend,
    approvalOrigin: string,
  ) {
    this.requests = new MaintenanceRequests(
      components.store,
      new ControlMaintenanceAuthority(components),
      backend,
      { approvalOrigin, reserve: components.reserve },
    );
    this.#unregister = components.onShutdown(() => this.close());
  }
  #scope(scope: MaintenanceScope, signal: AbortSignal): MaintenanceScope {
    return {
      ...scope,
      signal: AbortSignal.any([scope.signal, signal, this.components.signal]),
    };
  }
  async #current(
    requestId: string,
    revision: number | undefined,
    scope: MaintenanceScope,
  ) {
    const view = await this.requests.get(requestId, scope);
    requireCondition(
      revision === undefined || revision === view.revision,
      "maintenance_revision_conflict",
      "The maintenance request changed; reload its current revision.",
    );
    return view;
  }
  #start(message: WireInvokeV2, scope: MaintenanceScope): Execution {
    const requestId = (message.input as { requestId: string }).requestId;
    const previous = this.#executions.get(requestId);
    if (previous) {
      requireCondition(
        previous.callerKey === callerKey(scope.caller) &&
          previous.grantId === scope.caller.grantId,
        "maintenance_binding_mismatch",
        "The execution belongs to its original caller and Grant.",
      );
      return previous;
    }
    requireCondition(!this.#closed, "runtime_closed", "The Agent is stopping.");
    const controller = new AbortController();
    const accepted = Promise.withResolvers<void>();
    // The Core operation is independent of the observing WebSocket and the original script.
    const signal = AbortSignal.any([controller.signal, this.components.signal]);
    const lease = this.components.startLease(
      scope.caller,
      { maintenanceRequestId: requestId, originInvocationId: message.id },
      signal,
    );
    const executionScope: MaintenanceScope = {
      ...lease.scope,
      onAccepted: () => accepted.resolve(),
    };
    const task = (async () => {
      await lease.refresh();
      return await this.requests.execute(requestId, executionScope);
    })();
    const entry: Execution = {
      controller,
      callerKey: callerKey(scope.caller),
      grantId: scope.caller.grantId,
      accepted: accepted.promise,
      task,
    };
    this.#executions.set(requestId, entry);
    void accepted.promise.catch(() => {});
    void task
      .then(
        () => accepted.resolve(),
        (error: unknown) => accepted.reject(error),
      )
      .finally(() => {
        lease.close();
        if (this.#executions.get(requestId) === entry)
          this.#executions.delete(requestId);
      });
    // Retain errors on the real Promise without introducing an unhandled rejection.
    void task.catch(() => {});
    return entry;
  }
  async dispatch(
    message: WireInvokeV2,
    scope: MaintenanceScope,
    observerSignal: AbortSignal,
  ): Promise<unknown> {
    requireCondition(!this.#closed, "runtime_closed", "The Agent is stopping.");
    const pending = this.#dispatch(message, scope, observerSignal);
    this.#pending.add(pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
    }
  }
  async #dispatch(
    message: WireInvokeV2,
    scope: MaintenanceScope,
    observerSignal: AbortSignal,
  ): Promise<unknown> {
    requireCondition(!this.#closed, "runtime_closed", "The Agent is stopping.");
    const input = message.input as {
      requestId: string;
      revision?: number;
      body?: WireInputsV2["agent.maintenance.draft.prepare"]["body"];
    };
    const reading = this.#scope(scope, observerSignal);
    if (message.operation === "agent.maintenance.get")
      return await this.requests.get(input.requestId, reading);
    if (message.operation === "agent.maintenance.execute") {
      const current = await this.#current(input.requestId, undefined, reading);
      if (this.components.store.getMaintenanceOperation(input.requestId))
        return current;
      const entry = this.#start(message, scope);
      await observe(entry.accepted, observerSignal);
      return await this.requests.get(input.requestId, reading);
    }
    if (message.operation === "agent.maintenance.cancel") {
      const current = await this.#current(input.requestId, undefined, reading);
      const entry = this.#executions.get(input.requestId);
      if (!entry)
        return current.execution
          ? current
          : await this.requests.cancel(input.requestId, reading);
      requireCondition(
        entry.callerKey === callerKey(scope.caller) &&
          entry.grantId === scope.caller.grantId,
        "maintenance_binding_mismatch",
        "The execution belongs to its original caller and Grant.",
      );
      entry.controller.abort(
        new AgentError(
          "maintenance_cancelled",
          "The user requested maintenance cancellation.",
        ),
      );
      await observe(
        entry.task.catch(() => {}),
        observerSignal,
      );
      return await this.requests.get(input.requestId, reading);
    }
    await this.#current(input.requestId, input.revision, reading);
    if (message.operation === "agent.maintenance.draft.notify")
      return { requestId: input.requestId, notified: true };
    if (message.operation === "agent.maintenance.draft.verify")
      return await this.requests.verify(input.requestId, reading);
    let result: unknown;
    if (message.operation === "agent.maintenance.draft.read")
      result = await this.requests.readDraft(input.requestId, reading);
    else {
      requireCondition(
        input.body &&
          input.revision !== undefined &&
          input.body.purpose === "maintenance" &&
          input.body.direction === "cloud-to-agent" &&
          input.body.mimeType === "application/json",
        "invalid_maintenance_body",
        "Use the authenticated fixed maintenance JSON channel.",
      );
      requireCondition(
        input.body.size <= 512 * 1024,
        "invalid_maintenance_body",
        "The maintenance input exceeds its byte budget.",
      );
      const permit = this.components.streams.tryAcquire();
      requireCondition(
        permit,
        "transfer_busy",
        "All actual file stream slots are occupied.",
      );
      let value;
      try {
        value = await this.components
          .data()
          .readJson(input.body, reading.signal);
      } finally {
        permit.release();
      }
      requireCondition(
        isPlainRecord(value),
        "invalid_maintenance_body",
        "The maintenance body must be an object.",
      );
      reading.assertCurrent();
      if (message.operation === "agent.maintenance.draft.prepare") {
        validateContract("wire.body:MaintenanceDraftInput", value);
        requireCondition(
          value.revision === input.revision,
          "maintenance_revision_conflict",
          "The body revision differs from its control request.",
        );
        result = await this.requests.prepareDraft(
          input.requestId,
          value as unknown as MaintenanceDraftInput,
          reading,
        );
      } else if (message.operation === "agent.maintenance.oauth.start") {
        validateContract("wire.body:MaintenanceOAuthBinding", value);
        result = await this.requests.startOAuth(
          input.requestId,
          input.revision,
          value as unknown as MaintenanceOAuthBinding,
          reading,
        );
      } else if (message.operation === "agent.maintenance.oauth.complete") {
        validateContract("wire.body:MaintenanceOAuthComplete", value);
        result = await this.requests.completeOAuth(
          input.requestId,
          input.revision,
          value as unknown as MaintenanceOAuthComplete,
          reading,
        );
      } else
        throw new AgentError(
          "unknown_operation",
          "This maintenance operation is not registered.",
        );
    }
    const contract =
      message.operation === "agent.maintenance.draft.read"
        ? "MaintenanceDraftRead"
        : message.operation === "agent.maintenance.oauth.start"
          ? "MaintenanceOAuthLaunch"
          : "MaintenancePrepared";
    validateContract(`wire.body:${contract}`, result);
    reading.assertCurrent();
    const object = JSON.parse(canonicalJson(result, 1024 * 1024)) as JsonObject;
    return {
      body: await this.components.shipJson(
        object,
        "maintenance",
        reading.signal,
        message.context,
        message.id,
      ),
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#unregister();
    const active = [...this.#executions.values()];
    for (const entry of active)
      entry.controller.abort(
        new AgentError("runtime_closed", "The Agent is stopping."),
      );
    await Promise.allSettled(active.map((entry) => entry.task));
    await Promise.allSettled([...this.#pending]);
  }
}

/** Npm and connection configuration share the same confirmed authority and lifecycle. */
export function maintenanceRuntimeOptions(
  config: ProfileConfiguration,
  configuration?: (
    components: ApplicationComponents,
  ) => MaintenanceBackend | Promise<MaintenanceBackend>,
): Pick<AgentRuntimeOptions, "configureMaintenance" | "dispatchMaintenance"> {
  let application: MaintenanceApplication | undefined;
  return {
    async configureMaintenance(components) {
      const npm = new NpmMaintenanceBackend({
        root: config.root,
        modules: components.modules,
        extensions: components.extensions,
        enablement: components.enablement,
        refreshPackages: components.refreshPackages,
        reserve: components.reserve,
      });
      application = new MaintenanceApplication(
        components,
        new MaintenanceBackends(
          npm,
          configuration
            ? await configuration(components)
            : await components.configurationBackend(),
        ),
        config.serverUrl,
      );
      return application.requests;
    },
    async dispatchMaintenance(
      message,
      scope,
      _components,
      _service,
      observerSignal,
    ) {
      requireCondition(
        application,
        "maintenance_unavailable",
        "The maintenance service has not initialized.",
      );
      return await application.dispatch(message, scope, observerSignal);
    },
  };
}
