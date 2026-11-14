import {
  authorizeCall,
  callerKey,
  fixedCaller,
  type Caller,
} from "../contracts/caller.js";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { canonicalJson, digest, isPlainRecord } from "../contracts/json.js";
import type { JsonObject, ResourceRecord } from "../contracts/types.js";
import {
  ResourceManager,
  resourceReadDenied,
  type ResourceSnapshot,
} from "../extensions/resources.js";
import { CONTROL_OWNER, CONTROL_VERSION } from "../runtime/control-scripts.js";
import type { ResourceHistoryRecord } from "../storage/sqlite.js";

export interface ProcessSnapshot extends JsonObject {
  readonly processId: string;
  readonly originRunId: string | null;
  readonly contextId: string | null;
  readonly projectId: string | null;
  readonly status: string;
  readonly lifetime: ResourceRecord["lifetime"];
  readonly createdAt: number;
  readonly closedAt: number | null;
  readonly handedOffAt: number | null;
  readonly controlAvailable: boolean;
  readonly details: JsonObject;
}
export interface ProcessListInput {
  readonly projectId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ProcessPage {
  readonly items: readonly ProcessSnapshot[];
  readonly nextCursor: string | null;
  readonly observedAt: number;
}
export interface ApplicationProcessOptions {
  /** null verifies the current Agent authority even for an empty page. */
  authorize(
    caller: Caller,
    record: ResourceHistoryRecord | null,
    action: "read" | "stop",
  ): void;
  readonly now?: () => number;
}
const detailsKeys = new Set([
  "state",
  "pid",
  "startedAt",
  "rootExited",
  "exitCode",
  "exitSignal",
  "outputComplete",
  "treeStopped",
  "closed",
  "stopRequested",
  "forceRequested",
  "tty",
  "platform",
  "executable",
  "shell",
  "cwd",
  "stopReason",
  "preparationUnconfirmed",
  "failure",
]);
const copy = <T>(value: T, maximum = 32768): T =>
  JSON.parse(canonicalJson(value, maximum)) as T;

/** Owner Console projection of existing sh resources; it owns no process controllers or execution state. */
export class ApplicationProcesses {
  constructor(
    readonly resources: ResourceManager,
    readonly options: ApplicationProcessOptions,
  ) {}
  #caller(caller: Caller): Caller {
    caller = fixedCaller(caller);
    requireCondition(
      caller.source === "owner_session",
      "forbidden",
      "Process inspection requires the current owner Console session.",
    );
    authorizeCall(() => this.options.authorize(caller, null, "read"));
    return caller;
  }
  #belongs(record: ResourceHistoryRecord): boolean {
    const source = record.source;
    return (
      record.bootId === this.resources.store.bootId &&
      record.kind === "sh.process" &&
      source.type === "platform" &&
      source.owner === CONTROL_OWNER &&
      source.namespace === "sh" &&
      source.version === CONTROL_VERSION &&
      source.revision === CONTROL_VERSION &&
      record.originRunId !== null
    );
  }
  #source(record: ResourceHistoryRecord): void {
    requireCondition(
      this.#belongs(record),
      "process_unavailable",
      "Only this boot's actual built-in sh process resources are available.",
    );
  }
  #authorize(
    caller: Caller,
    record: ResourceHistoryRecord,
    action: "read" | "stop",
  ): void {
    this.#source(record);
    authorizeCall(() => this.options.authorize(caller, record, action));
  }
  #project(record: ResourceHistoryRecord): string | null {
    if (record.originRunId === null) return null;
    try {
      return this.resources.store.getRun(record.originRunId).projectId;
    } catch (cause) {
      if (isAgentError(cause) && cause.code === "run_not_found") return null;
      throw cause;
    }
  }
  #snapshot(snapshot: ResourceSnapshot): ProcessSnapshot {
    const row = this.resources.store.resourceHistory(snapshot.id);
    this.#source(row);
    return copy({
      processId: snapshot.id,
      originRunId: snapshot.originRunId,
      contextId: snapshot.contextId,
      projectId: this.#project(row),
      status: snapshot.status,
      lifetime: snapshot.lifetime,
      createdAt: snapshot.createdAt,
      closedAt: snapshot.closedAt,
      handedOffAt: snapshot.handedOffAt,
      controlAvailable: snapshot.controlAvailable,
      details: Object.fromEntries(
        Object.entries(snapshot.details).filter(([key]) =>
          detailsKeys.has(key),
        ),
      ),
    });
  }
  #id(input: { readonly processId: string }): string {
    const fixed = copy(input, 4096);
    requireCondition(
      isPlainRecord(fixed) &&
        Object.keys(fixed).length === 1 &&
        typeof fixed.processId === "string" &&
        /^res_[0-9a-f]{32}$/.test(fixed.processId),
      "invalid_process_id",
      "Use an actual managed process resource identity, never an OS PID.",
    );
    return fixed.processId;
  }
  get(caller: Caller, input: { readonly processId: string }): ProcessSnapshot {
    caller = this.#caller(caller);
    return this.#snapshot(
      this.resources.inspectResource(this.#id(input), (record) =>
        this.#authorize(caller, record, "read"),
      ),
    );
  }
  async stop(
    caller: Caller,
    input: { readonly processId: string },
  ): Promise<{ accepted: boolean; item: ProcessSnapshot }> {
    caller = this.#caller(caller);
    const result = await this.resources.disposeResource(
      this.#id(input),
      (record) => this.#authorize(caller, record, "stop"),
      new AgentError(
        "process_stopped",
        "The current owner requested managed process shutdown.",
      ),
    );
    return { accepted: result.accepted, item: this.#snapshot(result.snapshot) };
  }
  list(caller: Caller, input: ProcessListInput = {}): ProcessPage {
    caller = this.#caller(caller);
    const query = copy(input, 8192);
    requireCondition(
      isPlainRecord(query) &&
        Object.keys(query).every((key) =>
          ["projectId", "limit", "cursor"].includes(key),
        ),
      "invalid_process_query",
      "Use only project and pagination fields.",
    );
    const limit = query.limit ?? 20;
    requireCondition(
      typeof limit === "number" &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      "invalid_limit",
      "A process page contains between 1 and 100 items.",
    );
    requireCondition(
      query.projectId === undefined ||
        (typeof query.projectId === "string" &&
          query.projectId.length > 0 &&
          Buffer.byteLength(query.projectId) <= 256 &&
          !/[\0\r\n]/.test(query.projectId)),
      "invalid_process_query",
      "Use one bounded Project identity.",
    );
    requireCondition(
      query.cursor === undefined ||
        (typeof query.cursor === "string" &&
          query.cursor.length > 0 &&
          query.cursor.length <= 4096),
      "invalid_cursor",
      "The process cursor is invalid.",
    );
    const scope = digest({
      caller: callerKey(caller),
      sessionRef: caller.sessionRef ?? null,
      bootId: this.resources.store.bootId,
      projectId: query.projectId ?? null,
    });
    const filter = {
      owner: CONTROL_OWNER,
      namespace: "sh",
      type: "platform" as const,
      kind: "sh.process",
    };
    const items: ProcessSnapshot[] = [];
    let cursor = query.cursor,
      scanned = 0,
      bytes = 0;
    while (scanned < 1000) {
      authorizeCall(() => this.options.authorize(caller, null, "read"));
      const page = this.resources.store.scanResourceHistory(
        filter,
        scope,
        Math.min(100, 1000 - scanned),
        cursor,
      );
      for (let n = 0; n < page.items.length; n++) {
        const candidate = page.items[n]!,
          previous = cursor;
        cursor = candidate.cursor;
        scanned++;
        if (!this.#belongs(candidate.record)) continue;
        if (
          query.projectId !== undefined &&
          this.#project(candidate.record) !== query.projectId
        )
          continue;
        let snapshot: ResourceSnapshot;
        try {
          snapshot = this.resources.inspectResource(
            candidate.record.resourceId,
            (record) => this.#authorize(caller, record, "read"),
          );
        } catch (cause) {
          if (resourceReadDenied(cause)) continue;
          throw cause;
        }
        const item = this.#snapshot(snapshot),
          size = Buffer.byteLength(canonicalJson(item));
        if (bytes + size > 60 * 1024)
          return this.#page(caller, items, previous ?? null);
        bytes += size;
        items.push(item);
        if (items.length === limit)
          return this.#page(
            caller,
            items,
            n < page.items.length - 1 || page.more ? cursor : null,
          );
      }
      if (!page.more) return this.#page(caller, items, null);
    }
    return this.#page(caller, items, cursor ?? null);
  }
  #page(
    caller: Caller,
    items: ProcessSnapshot[],
    nextCursor: string | null,
  ): ProcessPage {
    authorizeCall(() => this.options.authorize(caller, null, "read"));
    const observedAt = (this.options.now ?? Date.now)();
    requireCondition(
      Number.isSafeInteger(observedAt) && observedAt >= 0,
      "invalid_process_clock",
      "The observation time must be a valid timestamp.",
    );
    return { items, nextCursor, observedAt };
  }
}
