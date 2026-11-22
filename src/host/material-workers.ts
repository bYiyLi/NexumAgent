import { MessageChannel, Worker } from "node:worker_threads";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import type { Binding } from "../contracts/types.js";
import type { WorkOptions } from "../work/service.js";
import { serveSyncRPC } from "./sync-rpc.js";

type Call = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
interface Entry {
  worker: Worker;
  stopPort(): void;
  finished: Promise<void>;
  signal: AbortSignal;
  prepared: boolean;
  releasing: boolean;
}

/** Runs synchronous work authorization in Workers while the host serves Go. */
export class MaterialWorkers {
  readonly #entries = new Map<string, Entry>();
  readonly #discarded = new Set<string>();
  readonly #failed = new Set<string>();
  #closed = false;

  constructor(readonly root: string, readonly binding: Binding, readonly bootId: string,
    readonly instanceId: string, readonly home: string | null, readonly agent: WorkOptions["agent"],
    readonly call: Call) {}

  async prepare(value: unknown, signal: AbortSignal): Promise<unknown> {
    requireCondition(isPlainRecord(value) && value.instanceId === this.instanceId &&
      typeof value.ticket === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.ticket),
    "invalid_work_scope", "The material request identity is invalid.");
    const ticket = value.ticket;
    if (this.#closed || !Array.isArray(value.sourceSnapshot)) {
      this.#rememberFailure(ticket);
      throw new AgentError("materials_unavailable", "The current authorized material snapshot is unavailable.");
    }
    requireCondition(this.#entries.size < 64 && !this.#entries.has(ticket),
      "work_busy", "The material ticket is already active or the host is busy.");
    requireCondition(!this.#discarded.delete(ticket), "work_aborted", "The material request was cancelled.");
    signal.throwIfAborted();
    const channel = new MessageChannel();
    const stopRPC = serveSyncRPC(channel.port1, (method, params, callSignal) => this.call(method, params, callSignal));
    const stopPort = () => { stopRPC(); channel.port1.close(); };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./material-worker.js", import.meta.url), {
        workerData: { root: this.root, binding: this.binding, bootId: this.bootId,
          instanceId: this.instanceId, home: this.home, agent: this.agent,
          request: value, port: channel.port2 }, transferList: [channel.port2],
      });
    } catch (cause) {
      stopPort();
      channel.port2.close();
      throw cause;
    }
    const finished = Promise.withResolvers<void>();
    const entry = { worker, stopPort, finished: finished.promise, signal, prepared: false, releasing: false };
    this.#entries.set(ticket, entry);
    const abort = () => worker.postMessage({ type: "cancel" });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const result = await this.#receive(worker, ["prepared", "failed"]);
      if (result.type !== "prepared") throw new AgentError(
        typeof result.code === "string" ? result.code : "work_snapshot_unavailable", "Material preparation failed.");
      entry.prepared = true;
      signal.throwIfAborted();
      return result.result;
    } catch (cause) {
      if (!entry.prepared && !entry.releasing) {
        this.#entries.delete(ticket);
        stopPort();
        await worker.terminate();
        this.#rememberFailure(ticket);
      }
      throw cause;
    } finally {
      signal.removeEventListener("abort", abort);
      finished.resolve();
    }
  }

  #rememberFailure(ticket: string): void {
    if (this.#failed.size >= 1024) {
      const oldest = this.#failed.values().next().value;
      if (oldest !== undefined) this.#failed.delete(oldest);
    }
    this.#failed.add(ticket);
  }

  async release(value: unknown): Promise<void> {
    requireCondition(isPlainRecord(value) && value.instanceId === this.instanceId &&
      typeof value.ticket === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.ticket) &&
      typeof value.committed === "boolean", "invalid_work_scope", "The material acknowledgement is invalid.");
    const entry = this.#entries.get(value.ticket);
    if (!entry && !value.committed) {
      if (this.#failed.delete(value.ticket)) return;
      requireCondition(this.#discarded.size < 1024, "work_busy", "Too many material cancellations are pending.");
      this.#discarded.add(value.ticket);
      return;
    }
    requireCondition(entry, "work_snapshot_unavailable", "The material ticket is unavailable.");
    requireCondition(!entry.releasing, "work_busy", "The material release is already in progress.");
    entry.releasing = true;
    const response = this.#receive(entry.worker, ["released", "releaseFailed", "failed"]);
    entry.worker.postMessage({ type: "release", committed: value.committed });
    try {
      const result = await response;
      requireCondition(result.type === "released" || (!value.committed && result.type === "failed"),
        "work_snapshot_unavailable", "The material release failed.");
      await entry.finished;
      this.#entries.delete(value.ticket);
      entry.stopPort();
      await entry.worker.terminate();
    } catch (cause) {
      entry.releasing = false;
      throw cause;
    }
  }

  async #receive(worker: Worker, expected: readonly string[]): Promise<Record<string, unknown>> {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new AgentError("work_snapshot_unavailable", "The material Worker did not respond.")), 30_000);
      const message = (value: unknown) => {
        if (isPlainRecord(value) && typeof value.type === "string" && expected.includes(value.type)) done(undefined, value);
      };
      const failure = () => done(new AgentError("work_snapshot_unavailable", "The material Worker exited."));
      const done = (error?: Error, result?: Record<string, unknown>) => {
        clearTimeout(timer); worker.off("message", message); worker.off("error", failure); worker.off("exit", failure);
        if (error) reject(error); else resolve(result!);
      };
      worker.on("message", message); worker.once("error", failure); worker.once("exit", failure);
      if (worker.threadId === -1) failure();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.entries()];
    const failures: unknown[] = [];
    this.#discarded.clear();
    this.#failed.clear();
    for (const [ticket, entry] of entries) {
      if (!entry.prepared) entry.worker.postMessage({ type: "cancel" });
      try { await this.release({ instanceId: this.instanceId, ticket, committed: entry.prepared }); }
      catch (cause) {
        failures.push(cause);
        entry.stopPort();
        try { await entry.worker.terminate(); } catch (termination) { failures.push(termination); }
        this.#entries.delete(ticket);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Material Worker cleanup was not confirmed.");
  }
}
