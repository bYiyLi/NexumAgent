import { once, EventEmitter } from "node:events";
import { types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, newId } from "../contracts/json.js";
import { authorizeCall } from "../contracts/caller.js";
import type {
  ContributionOrigin,
  JsonObject,
  ResourceRecord,
} from "../contracts/types.js";
import { SqliteStore } from "../storage/sqlite.js";

/** Extension-side control objects. Neither these nor ResourceRef cross the script/wire boundary. */
export interface ManagedResource {
  readonly closed: Promise<void>;
  dispose(reason?: unknown): void | Promise<void>;
}
export interface ResourceRef<T extends ManagedResource = ManagedResource> {
  readonly id: string;
  readonly kind: string;
  readonly signal: AbortSignal;
  readonly value: T;
}
export interface ResourceService {
  register<T extends ManagedResource>(input: {
    kind: string;
    value: T;
  }): Promise<ResourceRef<T>>;
  get<T extends ManagedResource = ManagedResource>(
    id: string,
  ): Promise<ResourceRef<T>>;
  handoff(id: string): Promise<ResourceRecord>;
}
export interface ResourceBinding {
  readonly signal: AbortSignal;
  /** The current invocation policy, including ownership/path/connection restrictions. */
  authorize(action: "register" | "get" | "handoff", id?: string): void;
  /** Check admission/current invocation before resource side effects. */
  assertActive(): void;
  readonly runId?: string;
}
interface Owner {
  id: string;
  origin: ContributionOrigin;
  signal: AbortSignal;
  stopping: boolean;
  authorize: ResourceBinding["authorize"];
}
interface Entry {
  readonly ref: ResourceRef;
  readonly owner: Owner;
  readonly controller: AbortController;
  readonly closure: AbortController;
  readonly binding: ResourceBinding;
  readonly confirmation: Promise<void>;
  readonly confirm: () => void;
  readonly rejectConfirmation: (error: unknown) => void;
  detachRun?: () => void;
  detachOwner: () => void;
  attempt?: Promise<void>;
  cleanupAttempt?: Promise<void>;
  closedError?: boolean;
  persistenceError?: unknown;
}
export interface CleanupReport extends JsonObject {
  closed: number;
  unconfirmed: JsonObject[];
}
export interface ResourceInstance {
  readonly id: string;
  readonly resources: ResourceService;
  bind(binding: ResourceBinding): ResourceService;
  busy(): boolean;
  stop(reason?: unknown): Promise<CleanupReport>;
}

/** One manager per live Agent/profile, backed by that profile's existing resource rows. */
export class ResourceManager extends EventEmitter {
  readonly store: SqliteStore;
  #entries = new Map<string, Entry>();
  #identities = new WeakMap<ManagedResource, Entry>();
  #owners = new Set<Owner>();
  #timeout: number;
  #capacity: number;
  constructor(
    store: SqliteStore,
    options: { cleanupTimeoutMs?: number; capacity?: number } = {},
  ) {
    super();
    this.setMaxListeners(0);
    this.store = store;
    this.#timeout = options.cleanupTimeoutMs ?? 5000;
    this.#capacity = options.capacity ?? 4096;
    requireCondition(
      Number.isSafeInteger(this.#timeout) &&
        this.#timeout > 0 &&
        this.#timeout <= 30000 &&
        Number.isSafeInteger(this.#capacity) &&
        this.#capacity > 0,
      "invalid_resource_options",
      "Resource capacity and cleanup observation must be positive and bounded.",
    );
  }
  instance(
    origin: ContributionOrigin,
    binding: Omit<ResourceBinding, "runId">,
  ): ResourceInstance {
    authorizeCall(() => binding.assertActive());
    binding.signal.throwIfAborted();
    const owner: Owner = {
      id: newId("instance"),
      origin: JSON.parse(canonicalJson(origin)),
      signal: binding.signal,
      stopping: false,
      authorize: binding.authorize,
    };
    requireCondition(
      owner.origin.owner &&
        owner.origin.version &&
        owner.origin.namespace &&
        owner.origin.revision,
      "invalid_resource_owner",
      "A resource instance needs its trusted source and effective version.",
    );
    this.#owners.add(owner);
    const host = this.#facade(owner, binding);
    return Object.freeze({
      id: owner.id,
      resources: host,
      bind: (call: ResourceBinding) => {
        this.#active(owner, call, "get");
        requireCondition(
          call.runId,
          "invalid_resource_binding",
          "A call facade needs a current run identity.",
        );
        return this.#facade(owner, call);
      },
      busy: () =>
        [...this.#entries.values()].some(
          (entry) =>
            entry.owner === owner &&
            this.store.getResource(entry.ref.id).lifetime !== "instance",
        ),
      stop: async (reason?: unknown) => {
        requireCondition(
          ![...this.#entries.values()].some(
            (entry) =>
              entry.owner === owner &&
              this.store.getResource(entry.ref.id).lifetime !== "instance",
          ),
          "extension_busy",
          "Run-owned or independent business resources still use this extension instance.",
        );
        owner.stopping = true;
        const entries = [...this.#entries.values()].filter(
          (entry) => entry.owner === owner,
        );
        await Promise.all(entries.map((entry) => this.#dispose(entry, reason)));
        const report = this.#report(entries.map((entry) => entry.ref.id));
        if (!report.unconfirmed.length) this.#owners.delete(owner);
        return report;
      },
    });
  }
  #active(
    owner: Owner,
    binding: ResourceBinding,
    action: "register" | "get" | "handoff",
    id?: string,
  ): void {
    requireCondition(
      this.#owners.has(owner) && !owner.stopping,
      "extension_unavailable",
      "The originating extension instance is no longer admitting calls.",
    );
    owner.signal.throwIfAborted();
    binding.signal.throwIfAborted();
    authorizeCall(() => binding.assertActive());
    authorizeCall(() => owner.authorize(action, id));
    authorizeCall(() => binding.authorize(action, id));
    if (binding.runId) {
      const run = this.store.getRun(binding.runId);
      requireCondition(
        run.bootId === this.store.bootId &&
          run.endedAt === null &&
          run.stop === null,
        "run_stopping",
        "This call no longer belongs to a live run.",
      );
    }
  }
  #record(owner: Owner, id: string): ResourceRecord {
    const row = this.store.getResource(id);
    requireCondition(
      row.bootId === this.store.bootId && row.source.instanceId === owner.id,
      "resource_owner_mismatch",
      "The resource belongs to another Agent boot or extension instance.",
    );
    return row;
  }
  #facade(owner: Owner, binding: ResourceBinding): ResourceService {
    return Object.freeze({
      register: async <T extends ManagedResource>({
        kind,
        value,
      }: {
        kind: string;
        value: T;
      }) => {
        this.#active(owner, binding, "register");
        requireCondition(
          typeof kind === "string" &&
            /^[a-z][a-z0-9_.-]{0,63}$/.test(kind) &&
            value &&
            (typeof value === "object" || typeof value === "function") &&
            typeof value.dispose === "function",
          "invalid_resource",
          "A managed resource needs a bounded kind and a control object with dispose().",
        );
        const previous = this.#identities.get(value);
        if (previous) {
          const row = this.#record(owner, previous.ref.id);
          requireCondition(
            previous.ref.kind === kind &&
              previous.binding.runId === binding.runId &&
              row.originRunId === (binding.runId ?? null),
            "resource_owner_mismatch",
            "A control object cannot be re-registered with another kind or origin.",
          );
          return previous.ref as ResourceRef<T>;
        }
        requireCondition(
          this.#entries.size < this.#capacity,
          "resource_busy",
          "The Agent has no managed resource slot available.",
        );
        const closed = value.closed;
        requireCondition(
          types.isPromise(closed),
          "invalid_resource",
          "closed must be the actual native Promise confirming physical closure and required cleanup.",
        );
        const row = this.store.registerResource({
          callerKey: binding.runId
            ? this.store.getRun(binding.runId).callerKey
            : "instance:" + owner.id,
          kind,
          source: { ...owner.origin, instanceId: owner.id },
          ...(binding.runId ? { runId: binding.runId } : {}),
          status: "registered",
        });
        const controller = new AbortController();
        const confirmation = Promise.withResolvers<void>();
        void confirmation.promise.catch(() => {});
        const ref = Object.freeze({
          id: row.resourceId,
          kind,
          signal: controller.signal,
          value,
        });
        // Observe closed before returning identity to the extension. No start is allowed before this point.
        const entry = {
          ref,
          owner,
          binding,
          controller,
          closure: new AbortController(),
          confirmation: confirmation.promise,
          confirm: confirmation.resolve,
          rejectConfirmation: confirmation.reject,
          detachOwner: () => {},
        } as Entry;
        const observed = Promise.prototype.then.call(
          closed,
          () => this.#closed(entry),
          () => {
            entry.closedError = true;
            this.#diagnostic(entry, "closed_rejected");
            void this.#dispose(
              entry,
              new AgentError(
                "resource_unconfirmed",
                "The resource could not confirm closure.",
              ),
            ).catch((error) => {
              this.#persistenceFailure(entry, error);
            });
          },
        );
        void observed.catch((error: unknown) => {
          this.#persistenceFailure(entry, error);
        });
        this.#entries.set(row.resourceId, entry);
        this.#identities.set(value, entry);
        const forward = (signal: AbortSignal) => {
          const stop = () => {
            void this.#dispose(entry, signal.reason).catch((error) => {
              this.#persistenceFailure(entry, error);
            });
          };
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
          return () => signal.removeEventListener("abort", stop);
        };
        entry.detachOwner = forward(owner.signal);
        if (binding.runId) entry.detachRun = forward(binding.signal);
        this.emit("change", row.resourceId);
        return ref as ResourceRef<T>;
      },
      get: async <T extends ManagedResource>(id: string) => {
        this.#active(owner, binding, "get", id);
        const row = this.#record(owner, id),
          entry = this.#entries.get(id);
        requireCondition(
          row.closedAt === null && entry && !entry.persistenceError,
          "resource_unavailable",
          "The resource is closed or its live control is unavailable; its retained history is unchanged.",
        );
        return entry.ref as ResourceRef<T>;
      },
      handoff: async (id: string) => {
        this.#active(owner, binding, "handoff", id);
        const row = this.#record(owner, id);
        requireCondition(
          binding.runId && row.originRunId === binding.runId,
          "resource_owner_mismatch",
          "Only the originating live call may hand off this resource.",
        );
        // Check the retained handoff fact only after the current authority/instance checks.
        if (row.handedOffAt !== null) return row;
        const entry = this.#entries.get(id);
        requireCondition(
          entry &&
            row.closedAt === null &&
            !entry.closedError &&
            !entry.persistenceError &&
            !entry.controller.signal.aborted,
          "resource_unavailable",
          "A stopped or unconfirmed resource cannot become an independent background resource.",
        );
        const result = this.store.handoff(id, binding.runId, row.revision);
        // The committed DB fact precedes detachment. Failure above keeps the old cleanup association.
        entry.detachRun?.();
        entry.detachRun = undefined;
        this.emit("change", id);
        return result;
      },
    });
  }
  #persistenceFailure(entry: Entry, cause: unknown): void {
    entry.persistenceError = cause;
    entry.rejectConfirmation(
      new AgentError(
        "resource_persistence_failed",
        "The resource could not persist its actual cleanup evidence.",
        undefined,
        { cause },
      ),
    );
  }
  #diagnostic(entry: Entry, code: string): void {
    const row = this.store.getResource(entry.ref.id);
    this.store.resourceDiagnostic(entry.ref.id, "unconfirmed", {
      ...row.diagnostic,
      code,
      ...(code === "dispose_failed" ? { disposeError: code } : {}),
      ...(code === "closed_rejected" ? { closedError: code } : {}),
    });
    this.emit("change", entry.ref.id);
  }
  #closed(entry: Entry): void {
    const row = this.store.getResource(entry.ref.id);
    this.store.closeResource(row.resourceId, row.revision, {
      ...row.diagnostic,
      closedConfirmed: true,
    });
    entry.detachRun?.();
    entry.detachOwner();
    entry.controller.abort(
      new AgentError("resource_closed", "The actual resource has closed."),
    );
    this.#entries.delete(entry.ref.id);
    entry.confirm();
    entry.closure.abort();
    this.emit("change", entry.ref.id);
  }
  async #dispose(entry: Entry, reason?: unknown): Promise<void> {
    if (this.store.getResource(entry.ref.id).closedAt !== null) return;
    if (entry.cleanupAttempt) return await entry.cleanupAttempt;
    const cleanup = this.#attemptCleanup(entry, reason);
    entry.cleanupAttempt = cleanup;
    try {
      await cleanup;
    } finally {
      if (entry.cleanupAttempt === cleanup) entry.cleanupAttempt = undefined;
    }
  }
  async #attemptCleanup(entry: Entry, reason?: unknown): Promise<void> {
    entry.controller.abort(
      reason ??
        new AgentError("resource_stopping", "Resource cleanup was requested."),
    );
    if (!entry.attempt) {
      this.store.resourceDiagnostic(
        entry.ref.id,
        "stopping",
        this.store.getResource(entry.ref.id).diagnostic,
      );
      const attempt = Promise.resolve().then(() =>
        entry.ref.value.dispose(reason),
      );
      entry.attempt = attempt;
      void attempt
        .then(
          () => {},
          () => {
            if (entry.attempt === attempt) entry.attempt = undefined;
            this.#diagnostic(entry, "dispose_failed");
          },
        )
        .catch((error) => {
          this.#persistenceFailure(entry, error);
        });
    }
    const observation = new AbortController();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#timeout);
    const timedOut = once(timeout.signal, "abort", {
      signal: observation.signal,
    }).then(() => false);
    const closed = once(entry.closure.signal, "abort", {
      signal: observation.signal,
    }).then(() => true);
    // Disposal completion is only a request fact. Confirmation is exclusively closed.
    try {
      const confirmed =
        entry.closure.signal.aborted ||
        (await Promise.race([closed, timedOut]));
      if (!confirmed)
        this.#diagnostic(
          entry,
          entry.closedError ? "closed_rejected" : "cleanup_unconfirmed",
        );
    } finally {
      clearTimeout(timer);
      observation.abort();
    }
  }
  #report(ids: readonly string[]): CleanupReport {
    const rows = ids.map((id) => this.store.getResource(id));
    return {
      closed: rows.filter((row) => row.closedAt !== null).length,
      unconfirmed: rows
        .filter((row) => row.closedAt === null)
        .map((row) => ({
          id: row.resourceId,
          status: row.status,
          diagnostic: row.diagnostic,
        })),
    };
  }
  async cleanupRun(runId: string, reason?: unknown): Promise<CleanupReport> {
    const ids = this.store
      .resourcesForRun(runId)
      .filter((row) => row.ownerRunId === runId)
      .map((row) => row.resourceId);
    await Promise.all(
      ids.map(async (id) => {
        const entry = this.#entries.get(id);
        if (entry) await this.#dispose(entry, reason);
      }),
    );
    return this.#report(ids);
  }
  async waitForRunClosure(runId: string): Promise<void> {
    const rows = this.store
      .resourcesForRun(runId)
      .filter((row) => row.ownerRunId === runId && row.closedAt === null);
    const entries = rows.map((row) => {
      const entry = this.#entries.get(row.resourceId);
      requireCondition(
        entry && !entry.persistenceError,
        "resource_unavailable",
        "Resource closure could not be confirmed in this Agent boot.",
      );
      return entry;
    });
    await Promise.all(entries.map((entry) => entry.confirmation));
  }
  /** Control adapters use this after their current call has authorized get(id). */
  async dispose(ref: ResourceRef, reason?: unknown): Promise<ResourceRecord> {
    const entry = this.#entries.get(ref.id);
    requireCondition(
      entry && entry.ref === ref,
      "resource_unavailable",
      "This is not a live control reference from this runtime.",
    );
    await this.#dispose(entry, reason);
    return this.store.getResource(ref.id);
  }
}
