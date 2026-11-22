import { requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { Caller } from "../contracts/caller.js";
import type { WorkRecord } from "../contracts/types.js";
import type { OpenInput, WorkOptions } from "../work/service.js";
import type { MaterialSession, PreparedMaterial } from "./materials.js";

export interface MaterialRequest {
  instanceId: string;
  ticket: string;
  caller: Caller;
  input: OpenInput;
  previous: WorkRecord | null;
  project: unknown;
  pwd: string;
  context: Record<string, unknown>;
  scriptUsage: unknown[];
}

/** The factory supplies current authorization, source registry and quotas. */
export type MaterialFactory = (request: MaterialRequest, signal: AbortSignal) => Promise<{
  session: MaterialSession;
  options: WorkOptions & Required<Pick<WorkOptions, "scriptUsage" | "canUseScript">>;
}>;

/** Dispatches Go-owned snapshot preparation and acknowledges its final disposition. */
export class MaterialRPC {
  readonly #instanceId: string;
  readonly #factory?: MaterialFactory;
  readonly #pending = new Map<string, { session?: MaterialSession; discard: boolean }>();
  readonly #discarded = new Set<string>();
  readonly #failed = new Set<string>();
  #closed = false;

  constructor(instanceId: string, factory?: MaterialFactory) {
    this.#instanceId = instanceId;
    this.#factory = factory;
  }

  async prepare(value: unknown, signal: AbortSignal): Promise<PreparedMaterial> {
    requireCondition(isPlainRecord(value) && value.instanceId === this.#instanceId &&
      typeof value.ticket === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.ticket) &&
      isPlainRecord(value.caller) && isPlainRecord(value.context) &&
      isPlainRecord(value.context.caller) && isPlainRecord(value.context.connection) &&
      isPlainRecord(value.context.authorization) && isPlainRecord(value.input) &&
      typeof value.pwd === "string" && Array.isArray(value.scriptUsage) &&
      (value.previous === null || isPlainRecord(value.previous)) &&
      (value.project === null || isPlainRecord(value.project)) &&
      canonicalJson(value.caller) === canonicalJson(value.context.caller) &&
      value.input.agentId === value.context.connection.agentId,
    "invalid_work_scope", "The material request does not match its trusted call context.");
    const ticket = value.ticket;
    if (this.#closed || !this.#factory) {
      this.#rememberFailure(ticket);
      requireCondition(false, "materials_unavailable",
        "The host has not restored the material and authorization services.");
    }
    requireCondition(this.#pending.size < 64 && !this.#pending.has(ticket),
      "work_busy", "The material ticket is already active or the host is busy.");
    requireCondition(!this.#discarded.delete(ticket), "work_aborted",
      "The material ticket was already cancelled.");
    const entry: { session?: MaterialSession; discard: boolean } = { discard: false };
    this.#pending.set(ticket, entry);
    try {
      const request = value as unknown as MaterialRequest;
      const { session, options } = await this.#factory(request, signal);
      entry.session = session;
      if (entry.discard || this.#closed || signal.aborted) {
        session.close();
        signal.throwIfAborted();
        throw new Error("material request cancelled");
      }
      return await session.prepare(ticket, request.caller, request.input, request.previous, signal, options);
    } catch (error) {
      entry.session?.close();
      this.#pending.delete(ticket);
      this.#rememberFailure(ticket);
      throw error;
    }
  }

  #rememberFailure(ticket: string): void {
    if (this.#failed.size >= 1024) {
      const oldest = this.#failed.values().next().value;
      if (oldest !== undefined) this.#failed.delete(oldest);
    }
    this.#failed.add(ticket);
  }

  release(value: unknown): void {
    requireCondition(isPlainRecord(value) && value.instanceId === this.#instanceId &&
      typeof value.ticket === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.ticket) &&
      typeof value.committed === "boolean", "invalid_work_scope", "The material acknowledgement is invalid.");
    const ticket = value.ticket;
    const entry = this.#pending.get(ticket);
    if (!entry && !value.committed) {
      if (this.#failed.delete(ticket)) return;
      requireCondition(this.#discarded.size < 1024, "work_busy", "Too many material cancellations are pending.");
      this.#discarded.add(ticket);
      return;
    }
    requireCondition(entry, "work_snapshot_unavailable", "The material ticket is unavailable.");
    if (!entry.session) {
      requireCondition(!value.committed, "work_snapshot_unavailable", "The snapshot has not been prepared.");
      entry.discard = true;
      return;
    }
    entry.session.release(ticket, value.committed);
    if (!value.committed) entry.discard = true;
    this.#pending.delete(ticket);
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      if (entry.session) entry.session.close();
      else entry.discard = true;
    }
    this.#pending.clear();
    this.#discarded.clear();
    this.#failed.clear();
  }
}
