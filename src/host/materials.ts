import type { Caller } from "../contracts/caller.js";
import { requireCondition } from "../contracts/errors.js";
import type { Binding, JsonObject, WorkRecord } from "../contracts/types.js";
import type { ModulePolicy } from "../runtime/modules.js";
import type { ScriptCatalog } from "../runtime/scripts.js";
import {
  WorkService,
  type OpenInput,
  type PreparedWorkSnapshot,
  type WorkOptions,
  type WorkSnapshotStore,
} from "../work/service.js";

/** Trusted host dependencies. The Go application owns all persistent work state. */
export interface MaterialSessionOptions {
  root: string;
  binding: Binding;
  bootId: string;
  scripts: ScriptCatalog;
  policy: ModulePolicy;
}

export interface PreparedMaterial {
  ticket: string;
  ref: string;
  view: JsonObject;
}

/** Keeps prepared snapshots alive until the storage owner acknowledges commit. */
export class MaterialSession {
  readonly #options: MaterialSessionOptions;
  readonly #pending = new Map<string, {
    snapshot?: PreparedWorkSnapshot;
    discard: boolean;
  }>();
  readonly #discarded = new Set<string>();
  #closed = false;

  constructor(options: MaterialSessionOptions) {
    this.#options = options;
  }

  #service(options: WorkOptions & Required<Pick<WorkOptions, "scriptUsage" | "canUseScript">>): WorkService {
    requireCondition(typeof options.scriptUsage === "function" &&
      typeof options.canUseScript === "function", "invalid_work_configuration",
    "The host requires the caller's actual script usage and source policy.");
    const unavailable = (): never => {
      throw new Error("work persistence belongs to Go");
    };
    const store: WorkSnapshotStore = {
      root: this.#options.root,
      binding: this.#options.binding,
      bootId: this.#options.bootId,
      activeWork: unavailable,
      getWork: unavailable,
      openWork: unavailable,
      refreshWork: unavailable,
      closeWork: unavailable,
      closeProject: unavailable,
      scriptUsage: unavailable,
    };
    return new WorkService(store, this.#options.scripts, this.#options.policy, options);
  }

  async prepare(ticket: string, caller: Caller, input: OpenInput, previous: WorkRecord | null,
    signal: AbortSignal, options: WorkOptions & Required<Pick<WorkOptions, "scriptUsage" | "canUseScript">>): Promise<PreparedMaterial> {
    requireCondition(!this.#closed, "host_closing", "The material session is closed.");
    requireCondition(this.#pending.size < 64, "work_busy", "Too many work snapshots are pending.");
    requireCondition(/^[A-Za-z0-9_-]{1,128}$/.test(ticket) && !this.#pending.has(ticket),
      "invalid_snapshot_ticket", "The snapshot ticket must be unique and valid.");
    requireCondition(!this.#discarded.delete(ticket), "work_aborted",
      "The snapshot ticket was already cancelled.");
    const entry: { snapshot?: PreparedWorkSnapshot; discard: boolean } = { discard: false };
    this.#pending.set(ticket, entry);
    try {
      const snapshot = await this.#service(options).prepareSnapshot(caller, input, previous, signal);
      entry.snapshot = snapshot;
      if (signal.aborted || this.#closed || entry.discard) {
        snapshot.release(false);
        signal.throwIfAborted();
        throw new Error("work snapshot preparation was cancelled");
      }
      return { ticket, ref: snapshot.ref, view: snapshot.view };
    } catch (error) {
      this.#pending.delete(ticket);
      throw error;
    }
  }

  release(ticket: string, committed: boolean): void {
    const entry = this.#pending.get(ticket);
    if (!entry && !committed) {
      requireCondition(/^[A-Za-z0-9_-]{1,128}$/.test(ticket) && this.#discarded.size < 1024,
        "invalid_snapshot_ticket", "The snapshot cancellation cannot be recorded.");
      this.#discarded.add(ticket);
      return;
    }
    requireCondition(entry, "work_snapshot_unavailable", "The snapshot ticket is unavailable.");
    if (!entry.snapshot) {
      requireCondition(!committed, "work_snapshot_unavailable", "The snapshot is not ready to commit.");
      entry.discard = true;
      return;
    }
    entry.snapshot.release(committed);
    this.#pending.delete(ticket);
  }

  /** A lost connection leaves commit status unknown, so retain snapshot bytes. */
  close(): void {
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      if (entry.snapshot) entry.snapshot.release(true);
      else entry.discard = true;
    }
    this.#pending.clear();
    this.#discarded.clear();
  }
}
