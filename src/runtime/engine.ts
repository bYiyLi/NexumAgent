import { EventEmitter, once } from "node:events";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import {
  readFileSync,
  realpathSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { types } from "node:util";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import { canonicalJson, digest } from "../contracts/json.js";
import type {
  JsonObject,
  JsonValue,
  ContributionOrigin,
  RunRecord,
  RunStatus,
  HistoryFilter,
  WaitRecord,
  WorkRecord,
} from "../contracts/types.js";
import { terminalStatuses } from "../contracts/types.js";
import {
  compileInputSchema,
  validateContract,
} from "../contracts/validation.js";
import { SqliteStore } from "../storage/sqlite.js";
import { ModuleLoader, type ModuleUse } from "./modules.js";
import { ScriptCatalog, scriptHeader, type ScriptSnapshot } from "./scripts.js";
import { createHash } from "node:crypto";
import { atomicText, contains, privateDirectory } from "./paths.js";
import type { ResourceManager } from "../extensions/resources.js";
import { RunOperations, type OperationHooks } from "./operations.js";
import { qualifyControlScript } from "./control-scripts.js";
import {
  authorizeCall,
  callerKey,
  fixedCaller,
  type Caller,
} from "../contracts/caller.js";
export { callerKey, type Caller } from "../contracts/caller.js";

export interface StartInput {
  contextId: string;
  script?: string;
  scriptName?: string;
  replayRunId?: string;
  input?: JsonValue;
  attachments?: JsonObject[];
  requestId?: string;
  pwd?: string;
  timeoutMs?: number;
  waitMs?: number;
}
export interface GetInput {
  agentId: string;
  runId?: string;
  requestId?: string;
  waitMs?: number;
}
export interface ListInput {
  agentId: string;
  status?: RunStatus;
  scriptName?: string;
  source?: "inline" | "named" | "history";
  projectId?: string;
  contextId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}
export interface RetainedSnapshot {
  readonly ref: string | null;
  readonly status: "available" | "unavailable" | "not_recorded" | "too_large";
  readonly bytes: number | null;
  readonly value?: JsonValue;
  readonly truncated?: true;
  readonly nextOffset?: number;
}
export interface CancelView extends RunView {
  /** This invocation actually recorded the first stop request; it does not confirm shutdown. */
  readonly accepted: boolean;
}
/** Internal retained detail; the Cloud adapter must project results and move media before model delivery. */
export interface RunDetails extends RunView {
  readonly snapshots: {
    readonly code: RetainedSnapshot;
    readonly input: RetainedSnapshot;
    readonly logs: RetainedSnapshot;
  };
}
export interface RunSummary extends JsonObject {
  runId: string;
  scriptName: string | null;
  scriptDesc: string | null;
  source: "inline" | "named" | "history";
  origin: JsonObject | null;
  projectId: string | null;
  contextId: string;
  status: RunStatus;
  acceptedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  replayOfRunId: string | null;
  availability: JsonObject;
}
export interface InputRequest {
  message: string;
  inputSchema: JsonValue;
  timeoutMs?: number;
}
export interface RunServices {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly context: JsonObject;
  /** Fixed Core verdict; not script context or an extension-provided permission. */
  readonly controlStorage?: boolean;
  readonly deadlineAt: number;
  assertActive(): void;
  /** Existing operations keep current authority while root admission is closed. */
  assertCurrent(): void;
  /** Trusted wrappers check script admission, normalize/validate and authorize before this core service. */
  operation<T>(
    origin: ContributionOrigin,
    method: string,
    action: (operationId: string) => T | Promise<T>,
    hooks?: OperationHooks<T>,
  ): T | Promise<T>;
  requestInput(request: InputRequest): Promise<JsonObject>;
}
export interface EngineOptions {
  // All callbacks are trusted application services, not tool arguments or guest objects.
  authorize(
    caller: Caller,
    target: {
      action: string;
      run?: RunRecord;
      work?: WorkRecord;
      path?: string;
      origin?: ScriptSnapshot["origin"];
    },
  ): void;
  loadWork(work: WorkRecord): JsonObject | Promise<JsonObject>;
  encodeResult(value: unknown, services: RunServices): Promise<JsonObject>;
  bindings(services: RunServices): Readonly<Record<string, unknown>>;
  prepareAttachments?(
    references: readonly JsonObject[],
    directory: string,
    services: RunServices,
  ): Promise<JsonObject[]>;
  capacity?: number;
  controlCapacity?: number;
  resources?: ResourceManager;
  leaseScript?(origin: ContributionOrigin): () => void;
  reserve?(
    bytes: number,
    options?: { readonly control?: boolean },
  ): Promise<{ release(): void }>;
}
export interface RunView {
  run: RunRecord;
  wait: WaitRecord | null;
  result: JsonObject | null;
  unavailable?: JsonObject;
  operations: { items: JsonObject[]; complete: boolean };
  resources: { items: JsonObject[]; complete: boolean };
}
interface PendingWait {
  record: WaitRecord;
  resolve(value: JsonObject): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}
interface Scope {
  readonly runId: string;
  readonly caller: Caller;
  readonly work: WorkRecord;
  readonly controlEligible: boolean;
  readonly controller: AbortController;
  readonly acceptedMono: number;
  readonly acceptedAt: number;
  readonly duration: number;
  services: RunServices;
  context: JsonObject;
  accepting: boolean;
  pending: PendingWait | null;
  deliveries: Set<Promise<void>>;
  inputPreparation?: Promise<void>;
  logReservation?: { release(): void };
  loggingClosed?: boolean;
  operations: RunOperations;
  timer?: NodeJS.Timeout;
  fatal?: AgentError;
  logError?: unknown;
}

function failure(error: unknown, phase: string): JsonObject {
  // Exceptions never cross the control plane with host stack, cause or configuration.
  return {
    ...safeErrorData(error, {
      code:
        phase === "compile" ? "script_syntax_error" : "script_execution_failed",
      message:
        phase === "compile"
          ? "The JavaScript body could not be compiled."
          : "The script or its result processing failed; inspect the local run log.",
    }),
    phase,
  };
}
function frozenJson(value: JsonObject): JsonObject {
  const copy = JSON.parse(canonicalJson(value, 2 * 1024 * 1024)) as JsonObject;
  const freeze = (item: JsonValue): void => {
    if (item && typeof item === "object") {
      for (const nested of Object.values(item)) freeze(nested);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

function attachmentIntent(references: readonly JsonObject[] = []): JsonValue[] {
  return references.map((reference): JsonObject => {
    if (typeof reference.sourceId === "string")
      return { sourceId: reference.sourceId };
    // Host temporary URLs are delivery credentials, not a submission's identity.
    if (typeof reference.file_id === "string")
      return {
        file_id: reference.file_id,
        ...(reference.file_name === undefined
          ? {}
          : { file_name: reference.file_name }),
        ...(reference.mime_type === undefined
          ? {}
          : { mime_type: reference.mime_type }),
      };
    if (typeof reference.transferId === "string")
      return { transferId: reference.transferId };
    return { uri: reference.uri! };
  });
}

const historyDenials = new Set([
  "forbidden",
  "permission_denied",
  "access_denied",
  "resource_forbidden",
  "path_not_allowed",
  "unauthorized",
]);
function deniedHistory(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || types.isProxy(cause)) return false;
  const code = Object.getOwnPropertyDescriptor(cause, "code");
  return !!code && "value" in code && historyDenials.has(code.value);
}

export class RunEngine extends EventEmitter {
  #scopes = new Map<string, Scope>();
  #inputDeliveries = new Map<string, Promise<void>>();
  readonly store: SqliteStore;
  readonly loader: ModuleLoader;
  readonly scripts: ScriptCatalog;
  #options: EngineOptions;

  constructor(
    store: SqliteStore,
    loader: ModuleLoader,
    scripts: ScriptCatalog,
    options: EngineOptions,
  ) {
    super();
    this.setMaxListeners(0); // Each observer has a bounded, individually cancelled once listener.
    requireCondition(
      scripts.work === path.join(store.root, "work") &&
        loader.work === scripts.work &&
        scripts.owner === `local:${store.binding.agentId}`,
      "runtime_profile_mismatch",
      "Runtime components must use this Agent's one profile/work environment.",
    );
    this.store = store;
    this.loader = loader;
    this.scripts = scripts;
    this.#options = options;
    requireCondition(
      !options.resources || options.resources.store === store,
      "runtime_profile_mismatch",
      "Managed resources must use this runtime's actual Agent/profile store.",
    );
  }

  #publish(runId: string): void {
    this.emit(runId);
  }
  activeSnapshotRefs(): ReadonlySet<string> {
    return new Set(
      [...this.#scopes.values()].map((scope) => scope.work.snapshotRef),
    );
  }
  #authorize(
    caller: Caller,
    target: Parameters<EngineOptions["authorize"]>[1],
  ): void {
    authorizeCall(() => this.#options.authorize(caller, target));
  }
  #run(caller: Caller, runId: string, action: string): RunRecord {
    const run = this.store.getRun(runId);
    this.#authorize(caller, { action, run });
    this.#checkDeadline(this.#scopes.get(runId));
    return this.store.getRun(runId);
  }
  #relative(filename: string): string {
    return path.relative(this.store.root, filename).split(path.sep).join("/");
  }
  #read(ref: string | null, runId: string, limit = 2 * 1024 * 1024): string {
    requireCondition(
      ref,
      "snapshot_unavailable",
      "The retained run snapshot is unavailable.",
    );
    const expected = path.join(this.scripts.work, "tmp", "runs", runId);
    const root = realpathSync.native(expected);
    requireCondition(
      root === expected,
      "snapshot_unavailable",
      "The retained run root was redirected outside the Agent work directory.",
    );
    const filename = realpathSync.native(path.resolve(this.store.root, ref));
    requireCondition(
      contains(root, filename) &&
        statSync(filename).isFile() &&
        statSync(filename).size <= limit,
      "snapshot_unavailable",
      "The snapshot is outside the run directory or exceeds its budget.",
    );
    return readFileSync(filename, "utf8");
  }
  #directory(runId: string): string {
    return privateDirectory(this.scripts.work, "tmp", "runs", runId);
  }

  #agent(agentId: string): void {
    requireCondition(
      agentId === this.store.binding.agentId,
      "agent_mismatch",
      "The query targets another Agent.",
    );
  }

  async get(
    caller: Caller,
    input: GetInput,
    signal?: AbortSignal,
  ): Promise<RunDetails> {
    validateContract("agent.run.get", input);
    input = JSON.parse(canonicalJson(input)) as GetInput;
    caller = fixedCaller(caller);
    this.#agent(input.agentId);
    this.#authorize(caller, { action: "get" });
    const runId =
      input.runId ??
      this.store.findSubmission(callerKey(caller), input.requestId!).runId;
    let view = await this.observe(caller, runId, input.waitMs ?? 0, signal);
    // Observation can yield; inspect retained details only under current authority.
    const current = this.#run(caller, runId, "get");
    if (current.revision !== view.run.revision)
      view = this.#view(caller, runId);
    return {
      ...view,
      snapshots: {
        code: this.#snapshot(view.run, "code", true),
        input: this.#snapshot(view.run, "input", true),
        logs: this.#snapshot(view.run, "logs", true),
      },
    };
  }

  list(
    caller: Caller,
    input: ListInput,
  ): { runs: RunSummary[]; nextCursor: string | null } {
    validateContract("agent.run.list", input);
    input = JSON.parse(canonicalJson(input)) as ListInput;
    caller = fixedCaller(caller);
    this.#agent(input.agentId);
    this.#authorize(caller, { action: "list" });
    const time = (
      value: string | undefined,
    ):
      | { milliseconds: number; remainder: string; boundary: number }
      | undefined => {
      if (value === undefined) return undefined;
      const milliseconds = Date.parse(value);
      requireCondition(
        Number.isFinite(milliseconds),
        "invalid_range",
        "The history time must be representable.",
      );
      // SQLite accepts integer milliseconds. Keep RFC3339 sub-millisecond
      // ordering before rounding both half-open boundaries up to that grid.
      const fraction = /\.(\d+)(?:z|[+-]\d{2}:\d{2})$/i.exec(value)?.[1] ?? "";
      const remainder = fraction.slice(3).replace(/0+$/, "");
      return {
        milliseconds,
        remainder,
        boundary: milliseconds + (remainder ? 1 : 0),
      };
    };
    const from = time(input.from),
      to = time(input.to);
    if (from && to) {
      const precision = Math.max(from.remainder.length, to.remainder.length);
      requireCondition(
        from.milliseconds < to.milliseconds ||
          (from.milliseconds === to.milliseconds &&
            from.remainder.padEnd(precision, "0") <=
              to.remainder.padEnd(precision, "0")),
        "invalid_range",
        "The history start must not exceed the end.",
      );
    }
    const filter: HistoryFilter = {
      status: input.status,
      scriptName: input.scriptName,
      sourceKind:
        input.source === undefined
          ? undefined
          : ({ inline: "inline", named: "script", history: "replay" } as const)[
              input.source
            ],
      projectId: input.projectId,
      contextId: input.contextId,
      from: from?.boundary,
      to: to?.boundary,
    };
    const scope = digest({
      caller: callerKey(caller),
      grantId: caller.grantId ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    });
    const runs: RunSummary[] = [];
    let cursor = input.cursor,
      scanned = 0;
    const limit = input.limit ?? 20;
    // Bounded scan, including denied rows. A short/empty page can carry its
    // opaque continuation without claiming that no further authorized history exists.
    while (scanned < 1000) {
      const page = this.store.scanRuns(
        filter,
        scope,
        Math.min(100, 1000 - scanned),
        cursor,
      );
      for (const item of page.items) {
        let run: RunRecord;
        try {
          run = this.#run(caller, item.record.runId, "get");
        } catch (cause) {
          if (!deniedHistory(cause)) throw cause;
          cursor = item.cursor;
          scanned++;
          continue;
        }
        // Deadline observation or a reentrant current-policy callback can change
        // mutable fields after SQL selected the candidate.
        if (
          (filter.status !== undefined && run.status !== filter.status) ||
          (filter.scriptName !== undefined &&
            run.scriptName !== filter.scriptName)
        ) {
          cursor = item.cursor;
          scanned++;
          continue;
        }
        const summary = this.#summary(run);
        if (
          Buffer.byteLength(
            canonicalJson(
              { runs: [...runs, summary], nextCursor: item.cursor },
              128 * 1024,
            ),
          ) >
          64 * 1024
        ) {
          requireCondition(
            runs.length > 0,
            "history_summary_too_large",
            "A retained history summary exceeds the page budget.",
          );
          return { runs, nextCursor: cursor ?? null };
        }
        runs.push(summary);
        cursor = item.cursor;
        scanned++;
        if (runs.length === limit) {
          const remaining = item !== page.items.at(-1) || page.more;
          return { runs, nextCursor: remaining ? cursor : null };
        }
      }
      if (!page.more) return { runs, nextCursor: null };
    }
    return { runs, nextCursor: cursor ?? null };
  }

  #snapshot(
    run: RunRecord,
    kind: "code" | "input" | "result" | "logs",
    value = false,
  ): RetainedSnapshot {
    const ref = run[`${kind}Ref`];
    if (!ref) return { ref: null, status: "not_recorded", bytes: null };
    let bytes: number | null = null;
    try {
      const expected = path.join(
        this.store.root,
        ...(kind === "logs"
          ? ["logs", "runs", run.runId]
          : ["work", "tmp", "runs", run.runId]),
      );
      const root = realpathSync.native(expected);
      const filename = realpathSync.native(path.resolve(this.store.root, ref));
      requireCondition(
        root === expected && contains(root, filename),
        "snapshot_unavailable",
        "The retained snapshot was redirected.",
      );
      const file = openSync(
        filename,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = fstatSync(file);
        requireCondition(
          stat.isFile(),
          "snapshot_unavailable",
          "The retained snapshot is not a file.",
        );
        bytes = stat.size;
        if (!value) return { ref, status: "available", bytes };
        if (kind !== "logs" && bytes > 8192)
          return { ref, status: "too_large", bytes };
        const maximum = kind === "logs" ? 4096 : 8192;
        const buffer = Buffer.alloc(Math.min(bytes + 1, maximum + 1));
        const count = readSync(file, buffer, 0, buffer.length, 0);
        if (kind !== "logs") {
          if (count > 8192)
            return { ref, status: "too_large", bytes: Math.max(bytes, count) };
          return {
            ref,
            status: "available",
            bytes,
            value: JSON.parse(
              canonicalJson(
                JSON.parse(buffer.subarray(0, count).toString("utf8")),
                8192,
              ),
            ) as JsonValue,
          };
        }
        const text = new StringDecoder("utf8").write(
          buffer.subarray(0, Math.min(count, maximum)),
        );
        const consumed = Buffer.byteLength(text);
        return {
          ref,
          status: "available",
          bytes,
          value: text,
          ...(consumed < bytes || count > maximum
            ? { truncated: true, nextOffset: consumed }
            : {}),
        };
      } finally {
        closeSync(file);
      }
    } catch {
      return { ref, status: "unavailable", bytes };
    }
  }

  #summary(run: RunRecord): RunSummary {
    const source = run.source;
    const origin = source.origin;
    const trustedOrigin =
      origin && typeof origin === "object" && !Array.isArray(origin)
        ? {
            type: origin.type ?? null,
            owner: origin.owner ?? null,
            namespace: origin.namespace ?? null,
            version: origin.version ?? null,
            revision: origin.revision ?? null,
          }
        : null;
    const description =
      typeof source.scriptDesc === "string" ? source.scriptDesc : null;
    return {
      runId: run.runId,
      scriptName: run.scriptName,
      scriptDesc: description === null ? null : description.slice(0, 2048),
      ...(description !== null && description.length > 2048
        ? { descriptionTruncated: true }
        : {}),
      source: (
        { inline: "inline", script: "named", replay: "history" } as const
      )[run.sourceKind],
      origin: trustedOrigin,
      projectId: run.projectId,
      contextId: run.contextId,
      status: run.status,
      acceptedAt: new Date(run.acceptedAt).toISOString(),
      startedAt:
        run.startedAt === null ? null : new Date(run.startedAt).toISOString(),
      endedAt:
        run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
      replayOfRunId:
        typeof source.replayRunId === "string" ? source.replayRunId : null,
      availability: {
        code: this.#snapshot(run, "code").status,
        input: this.#snapshot(run, "input").status,
        result: this.#snapshot(run, "result").status,
        logs: this.#snapshot(run, "logs").status,
        artifacts: "unknown",
      },
    };
  }

  async start(
    caller: Caller,
    input: StartInput,
    observationSignal?: AbortSignal,
  ) {
    validateContract("runtime:agent.run.start", input);
    input = JSON.parse(canonicalJson(input)) as StartInput;
    caller = fixedCaller(caller);
    this.#authorize(caller, { action: "start" });
    const { waitMs: _wait, attachments: _attachments, ...intent } = input;
    const key = callerKey(caller);
    const intentDigest = digest({
      ...intent,
      ...(input.attachments === undefined
        ? {}
        : { attachments: attachmentIntent(input.attachments) }),
    });
    const original = input.requestId
      ? this.store.findMatchingSubmission(key, input.requestId, intentDigest)
      : null;
    if (original) {
      this.#authorize(caller, { action: "get", run: original });
      return await this.observe(
        caller,
        original.runId,
        input.waitMs ?? 1000,
        observationSignal,
      );
    }
    let pinned: ScriptSnapshot | undefined;
    try {
      if (input.scriptName !== undefined)
        pinned = qualifyControlScript(this.scripts, input.scriptName);
    } catch (cause) {
      // A source resolver can call trusted services reentrantly. A submission
      // accepted since the first lookup still owns its original identity.
      const concurrent = input.requestId
        ? this.store.findMatchingSubmission(key, input.requestId, intentDigest)
        : null;
      if (!concurrent) throw cause;
      this.#authorize(caller, { action: "get", run: concurrent });
      return await this.observe(
        caller,
        concurrent.runId,
        input.waitMs ?? 1000,
        observationSignal,
      );
    }
    let admission: { release(): void } | undefined;
    try {
      if (this.#options.reserve)
        admission = await this.#options.reserve(65536, {
          control: pinned !== undefined,
        });
    } catch (cause) {
      const concurrent = input.requestId
        ? this.store.findMatchingSubmission(key, input.requestId, intentDigest)
        : null;
      if (!concurrent) throw cause;
      this.#authorize(caller, { action: "get", run: concurrent });
      return await this.observe(
        caller,
        concurrent.runId,
        input.waitMs ?? 1000,
        observationSignal,
      );
    }
    let accepted: { run: RunRecord; duplicate: boolean };
    try {
      this.#authorize(caller, { action: "start" });
      accepted = this.store.acceptRun({
        callerKey: key,
        contextId: input.contextId,
        sourceKind:
          input.script !== undefined
            ? "inline"
            : input.scriptName !== undefined
              ? "script"
              : "replay",
        source: {
          entry:
            input.script !== undefined
              ? "inline"
              : input.scriptName !== undefined
                ? "named"
                : "history",
          ...(input.replayRunId ? { replayRunId: input.replayRunId } : {}),
        },
        ...(input.scriptName === undefined
          ? {}
          : { scriptName: input.scriptName }),
        timeoutMs: input.timeoutMs,
        requestId: input.requestId,
        intentDigest,
        capacity: this.#options.capacity,
        controlCapacity: this.#options.controlCapacity,
        controlEligible: pinned !== undefined,
      });
    } finally {
      admission?.release();
    }
    if (accepted.duplicate)
      this.#authorize(caller, { action: "get", run: accepted.run });
    else {
      const scope = this.#scope(accepted.run, caller, pinned !== undefined);
      this.#scopes.set(scope.runId, scope);
      this.#scheduleDeadline(scope);
      const begin = () => {
        void this.#drive(scope, input, pinned)
          .finally(() => {
            scope.loggingClosed = true;
            scope.logReservation?.release();
            scope.logReservation = undefined;
          })
          .catch((error) => this.#persistenceFailure(scope, error));
      };
      // Fixed code already has a known source. Acquire its lease before the
      // caller can synchronously stop/replace that source after start returns.
      if (pinned) begin();
      else queueMicrotask(begin);
    }
    return await this.observe(
      caller,
      accepted.run.runId,
      input.waitMs ?? 1000,
      observationSignal,
    );
  }

  #scope(run: RunRecord, caller: Caller, controlEligible = false): Scope {
    const scope = {
      runId: run.runId,
      caller: fixedCaller(caller),
      controlEligible,
      work: this.store.getWork(run.contextId),
      controller: new AbortController(),
      acceptedMono: performance.now(),
      acceptedAt: run.acceptedAt,
      duration: run.deadlineAt - run.acceptedAt,
      context: {},
      accepting: true,
      pending: null,
      deliveries: new Set<Promise<void>>(),
    } as Scope;
    scope.operations = new RunOperations(
      this.store,
      run.runId,
      () => this.#assertCurrent(scope),
      (error) => this.#persistenceFailure(scope, error),
      () => this.#publish(run.runId),
    );
    scope.services = Object.freeze({
      runId: run.runId,
      controlStorage: scope.controlEligible,
      signal: scope.controller.signal,
      deadlineAt: run.deadlineAt,
      get context() {
        return scope.context;
      },
      assertActive: () => this.#assertActive(scope),
      assertCurrent: () => this.#assertCurrent(scope),
      operation: <T>(
        origin: ContributionOrigin,
        method: string,
        action: (operationId: string) => T | Promise<T>,
        hooks?: OperationHooks<T>,
      ) => scope.operations.start(origin, method, action, hooks),
      requestInput: (request: InputRequest) =>
        this.#requestInput(scope, request),
    });
    return scope;
  }
  #remaining(scope: Scope): number {
    return Math.min(
      scope.duration - (performance.now() - scope.acceptedMono),
      scope.acceptedAt + scope.duration - Date.now(),
    );
  }
  #now(scope: Scope): number {
    return Math.floor(
      Math.max(
        Date.now(),
        scope.acceptedAt + performance.now() - scope.acceptedMono,
      ),
    );
  }
  #checkDeadline(scope?: Scope): void {
    if (
      scope &&
      !scope.controller.signal.aborted &&
      this.#remaining(scope) <= 0
    )
      this.#stop(scope, { kind: "deadline", code: "run_deadline_exceeded" });
    if (
      scope?.pending &&
      this.#now(scope) >= scope.pending.record.deadlineAt &&
      !scope.controller.signal.aborted
    )
      this.#expireInput(scope, scope.pending.record.waitId);
  }
  #scheduleDeadline(scope: Scope): void {
    scope.timer = setTimeout(
      () => {
        try {
          this.#checkDeadline(scope);
          if (!scope.controller.signal.aborted) this.#scheduleDeadline(scope);
        } catch (error) {
          this.#persistenceFailure(scope, error);
        }
      },
      Math.max(1, Math.min(this.#remaining(scope), 2_147_483_647)),
    );
    scope.timer.unref();
  }
  #persistenceFailure(scope: Scope, error: unknown): void {
    scope.fatal ??= new AgentError(
      "run_persistence_failed",
      "The run could not confirm its saved state; do not replay it automatically.",
      { runId: scope.runId },
      { cause: error },
    );
    scope.accepting = false;
    clearTimeout(scope.timer);
    if (scope.pending) {
      const pending = scope.pending;
      scope.pending = null;
      clearTimeout(pending.timer);
      pending.reject(scope.fatal);
    }
    scope.controller.abort(scope.fatal);
    this.#publish(scope.runId);
  }
  #assertActive(scope: Scope): void {
    requireCondition(
      scope.accepting && !scope.controller.signal.aborted,
      "run_stopping",
      "The run no longer accepts new managed work.",
    );
    this.#assertCurrent(scope);
  }
  #assertCurrent(scope: Scope): void {
    this.#checkDeadline(scope);
    scope.controller.signal.throwIfAborted();
    const run = this.store.getRun(scope.runId);
    requireCondition(
      run.bootId === this.store.bootId &&
        run.endedAt === null &&
        run.stop === null,
      "run_stopping",
      "The originating run no longer admits operation continuations.",
    );
    this.#authorize(scope.caller, {
      action: "operation",
      run,
    });
  }
  #stop(
    scope: Scope,
    reason: JsonObject,
  ): { accepted: boolean; run: RunRecord } {
    const stopped = this.store.requestStop(
      scope.runId,
      reason,
      this.#now(scope),
    );
    if (stopped.accepted) {
      scope.accepting = false;
      clearTimeout(scope.timer);
      scope.controller.abort(
        new AgentError(
          reason.kind === "cancel"
            ? "run_cancelled"
            : reason.kind === "authorization"
              ? String(reason.code)
              : "run_deadline_exceeded",
          "The run accepted a stop request.",
        ),
      );
      if (scope.pending) {
        const pending = scope.pending;
        scope.pending = null;
        clearTimeout(pending.timer);
        pending.reject(scope.controller.signal.reason);
      }
      this.#publish(scope.runId);
    }
    return stopped;
  }

  async #drive(
    scope: Scope,
    input: StartInput,
    pinned?: ScriptSnapshot,
  ): Promise<void> {
    let phase = "prepare",
      directory = "";
    let result: JsonObject | undefined, error: JsonObject | undefined;
    let resultRef: string | undefined;
    let releaseScript: (() => void) | undefined;
    const moduleUses = new Map<string, ModuleUse>();
    let modulesIncomplete = false;
    try {
      this.#assertActive(scope);
      let run = this.store.getRun(scope.runId);
      if (pinned) {
        this.#authorize(scope.caller, {
          action: "script",
          run,
          origin: pinned.origin,
        });
        this.#assertActive(scope);
        releaseScript = this.#options.leaseScript?.(pinned.origin);
      }
      run = this.store.transitionRun(
        run.runId,
        run.revision,
        "preparing_inputs",
        {},
        this.#now(scope),
      );
      this.#publish(run.runId);
      directory = this.#directory(run.runId);
      const work = await this.#options.loadWork(scope.work);
      const pwd = realpathSync.native(input.pwd ?? scope.work.pwd);
      requireCondition(
        statSync(pwd).isDirectory(),
        "invalid_pwd",
        "The requested working directory is not a directory.",
      );
      this.#authorize(scope.caller, {
        action: "prepare",
        work: scope.work,
        path: pwd,
      });
      let snapshot: ScriptSnapshot,
        businessInput: JsonValue = null;
      let attachments = input.attachments;
      if (input.script !== undefined)
        snapshot = (
          await this.scripts.enrollManaged(input.script, {
            reserve: this.#options.reserve
              ? (bytes) =>
                  this.#options.reserve!(bytes, {
                    control: scope.controlEligible,
                  })
              : undefined,
            assertCurrent: () => this.#assertActive(scope),
          })
        ).snapshot;
      else if (input.scriptName !== undefined)
        snapshot = pinned ?? this.scripts.resolve(input.scriptName);
      else {
        const previous = this.#run(scope.caller, input.replayRunId!, "replay");
        const saved = JSON.parse(
          this.#read(previous.inputRef, previous.runId),
        ) as JsonObject;
        snapshot = JSON.parse(
          this.#read(previous.codeRef, previous.runId),
        ) as ScriptSnapshot;
        requireCondition(
          typeof snapshot.code === "string" &&
            createHash("sha256").update(snapshot.code).digest("hex") ===
              previous.source.revision,
          "snapshot_changed",
          "The retained code no longer matches the recorded revision.",
        );
        snapshot.origin = previous.source.origin as ScriptSnapshot["origin"];
        snapshot.name = previous.scriptName;
        snapshot.metadata = scriptHeader(snapshot.code);
        if (attachments === undefined)
          requireCondition(
            saved.attachmentsReady !== false || saved.expectedAttachments === 0,
            "attachments_unavailable",
            "Historical required attachments were never fully prepared; supply replacements.",
          );
        if (
          attachments === undefined &&
          Array.isArray(saved.attachments) &&
          saved.attachments.length
        ) {
          // Only local retained references are reused; Host URL/file IDs were never saved.
          attachments = saved.attachments.map((item) => ({
            uri: (item as JsonObject).resourceUri!,
          }));
          requireCondition(
            attachments.every((item) => typeof item.uri === "string"),
            "attachments_unavailable",
            "The historical attachments have no reusable authorized resource references.",
          );
        }
        if (!Object.hasOwn(input, "input")) businessInput = saved.input!;
      }
      businessInput = Object.hasOwn(input, "input")
        ? input.input!
        : (businessInput! ?? null);
      this.#authorize(scope.caller, {
        action: "script",
        run: this.store.getRun(scope.runId),
        origin: snapshot.origin,
      });
      this.#assertActive(scope);
      if (!pinned) releaseScript = this.#options.leaseScript?.(snapshot.origin);
      const codeRef = this.#relative(path.join(directory, "code.json"));
      const inputRef = this.#relative(path.join(directory, "input.json"));
      await this.#writeSnapshot(
        scope,
        path.join(directory, "code.json"),
        canonicalJson(snapshot),
      );
      await this.#writeSnapshot(
        scope,
        path.join(directory, "input.json"),
        canonicalJson({
          input: businessInput,
          attachments: [],
          expectedAttachments: (attachments ?? []).length,
          attachmentsReady: false,
        }),
      );
      run = this.store.getRun(scope.runId);
      const source: JsonObject = {
        origin: snapshot.origin,
        revision: snapshot.origin.revision,
        nodeVersion: process.version,
        workRevision: scope.work.revision,
        ...(snapshot.metadata
          ? { scriptDesc: snapshot.metadata.scriptDesc }
          : {}),
        ...(input.replayRunId ? { replayRunId: input.replayRunId } : {}),
      };
      run = this.store.savePreparation(run.runId, run.revision, {
        codeRef,
        inputRef,
        source,
        ...(snapshot.name ? { scriptName: snapshot.name } : {}),
      });
      if (snapshot.metadata)
        compileInputSchema(snapshot.metadata.scriptInputSchema)(businessInput);
      const paths = {
        work: this.scripts.work,
        docs: this.scripts.docs,
        scripts: this.scripts.local,
        resources: path.join(this.scripts.work, "resources"),
        temp: directory,
      };
      scope.context = {
        contextId: run.contextId,
        agentId: this.store.binding.agentId,
        runId: run.runId,
        pwd,
        project: work.project ?? null,
        caller: { ...scope.caller },
        script: {
          name: snapshot.name,
          source:
            input.script !== undefined
              ? "inline"
              : input.scriptName !== undefined
                ? "named"
                : "history",
          origin: snapshot.origin,
          code: snapshot.code,
        },
        paths,
        input: businessInput,
        attachments: [],
        agent: work.agentShared ?? {},
        user: work.userShared ?? {},
      };
      const prepared = await this.#prepareAttachments(
        attachments ?? [],
        privateDirectory(directory, "inputs"),
        scope,
      );
      this.#assertActive(scope);
      scope.context.attachments = prepared;
      scope.context = frozenJson(scope.context);
      // The context is copied/frozen by ModuleLoader; later input never mutates it.
      await this.#writeSnapshot(
        scope,
        path.join(directory, "input.json"),
        canonicalJson(
          {
            input: businessInput,
            attachments: prepared,
            attachmentsReady: true,
          },
          2 * 1024 * 1024,
        ),
      );
      const logsFile = path.join(
        privateDirectory(this.store.root, "logs", "runs", run.runId),
        "console.log",
      );
      scope.logReservation = await this.#options.reserve?.(1024 * 1024 + 1024, {
        control: scope.controlEligible,
      });
      this.#assertActive(scope);
      atomicText(logsFile, "");
      let log = "";
      const stream = new Writable({
        write: (chunk, _encoding, done) => {
          try {
            if (scope.loggingClosed) {
              done();
              return;
            }
            if (Buffer.byteLength(log) < 1024 * 1024) {
              log += Buffer.from(chunk)
                .subarray(0, 1024 * 1024 - Buffer.byteLength(log))
                .toString("utf8");
              atomicText(logsFile, log);
            }
            done();
          } catch (error) {
            scope.logError = error;
            done();
          }
        },
      });
      // Console inspects guest objects only when the script explicitly chooses to log them.
      const runConsole = new Console({
        stdout: stream,
        stderr: stream,
        ignoreErrors: false,
      });
      phase = "compile";
      await scope.operations.settle();
      const execute = this.loader.compile(
        snapshot.code,
        { ...this.#options.bindings(scope.services), context: scope.context },
        {
          filename: `nexum:${snapshot.name ?? run.runId + ".js"}`,
          console: runConsole,
          onModule: (use) => {
            if (moduleUses.size < 256 || moduleUses.has(use.entry))
              moduleUses.set(use.entry, use);
            else modulesIncomplete = true;
          },
        },
      );
      this.#assertActive(scope);
      run = this.store.getRun(run.runId);
      this.store.transitionRun(
        run.runId,
        run.revision,
        "running",
        {
          codeRef,
          inputRef,
          logsRef: this.#relative(logsFile),
          source,
          ...(snapshot.name ? { scriptName: snapshot.name } : {}),
        },
        this.#now(scope),
      );
      this.#publish(run.runId);
      phase = "execute";
      const value = await scope.operations.audit.run(execute);
      if (scope.logError)
        throw new AgentError(
          "run_log_failed",
          "The local run log could not be saved.",
        );
      scope.accepting = false;
      if (scope.pending || scope.inputPreparation) {
        const pending = scope.pending;
        scope.pending = null;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(
            new AgentError(
              "input_not_awaited",
              "The root script returned without awaiting its input request.",
            ),
          );
        }
        throw new AgentError(
          "input_not_awaited",
          "The root script returned without awaiting its input request.",
        );
      }
      phase = "operations";
      await scope.operations.settle();
      if (scope.logError)
        throw new AgentError(
          "run_log_failed",
          "The local run log could not be saved.",
        );
      this.#checkDeadline(scope);
      scope.controller.signal.throwIfAborted();
      phase = "result";
      result = await this.#options.encodeResult(value, scope.services);
      this.#checkDeadline(scope);
      scope.controller.signal.throwIfAborted();
      await this.#writeSnapshot(
        scope,
        path.join(directory, "result.json"),
        canonicalJson(result, 96 * 1024 * 1024),
      );
      resultRef = this.#relative(path.join(directory, "result.json"));
    } catch (cause) {
      error = failure(cause, phase);
    }
    scope.accepting = false;
    if (scope.pending) {
      const pending = scope.pending;
      scope.pending = null;
      clearTimeout(pending.timer);
      pending.reject(
        new AgentError("run_closed", "The root execution is closing."),
      );
    }
    if (error && !scope.controller.signal.aborted)
      scope.controller.abort(
        new AgentError(
          "run_failed",
          "The root or its managed work failed; in-flight operations must stop.",
        ),
      );
    try {
      await scope.operations.settle();
    } catch (cause) {
      error ??= failure(cause, "operations");
    }
    await Promise.allSettled([...scope.deliveries]);
    let cleanup: JsonObject = {};
    if (this.#options.resources) {
      if (error && !scope.controller.signal.aborted)
        scope.controller.abort(
          new AgentError(
            "run_failed",
            "The root execution failed; managed work must stop.",
          ),
        );
      const resources = this.#options.resources;
      let report = await resources.cleanupRun(
        scope.runId,
        scope.controller.signal.reason,
      );
      if (report.unconfirmed.length) {
        this.store.saveCleanup(
          scope.runId,
          { phase: "cleanup", ...report, ...(error ? { cause: error } : {}) },
          this.#now(scope),
        );
        this.#publish(scope.runId);
        // A bounded cleanup attempt is over; physical closure remains unconfirmed.
        // Wait on actual resource evidence without polling or manufacturing a terminal state.
        await resources.waitForRunClosure(scope.runId);
        report = await resources.cleanupRun(
          scope.runId,
          scope.controller.signal.reason,
        );
      }
      cleanup = report;
    }
    if (scope.fatal) {
      scope.operations.audit.close();
      return;
    }
    try {
      await scope.operations.settle();
    } catch (cause) {
      error ??= failure(cause, "cleanup");
    }
    if (scope.fatal) {
      scope.operations.audit.close();
      return;
    }
    if (scope.logError)
      error ??= failure(
        new AgentError(
          "run_log_failed",
          "The local run log could not be saved.",
        ),
        "cleanup",
      );
    this.#checkDeadline(scope);
    const run = this.store.getRun(scope.runId);
    const status = run.stop
      ? run.stop.kind === "cancel"
        ? "cancelled"
        : "failed"
      : error
        ? "failed"
        : "succeeded";
    releaseScript?.();
    releaseScript = undefined;
    // The root can return before tracked handlers finish. Keep its captured
    // console and reserved log budget until their actual settlement is known.
    scope.loggingClosed = true;
    scope.logReservation?.release();
    scope.logReservation = undefined;
    this.store.transitionRun(
      run.runId,
      run.revision,
      status,
      {
        ...(error ? { error } : {}),
        ...(resultRef ? { resultRef } : {}),
        cleanup,
        source: {
          ...run.source,
          modules: [...moduleUses.values()].map((use) => ({ ...use })),
          modulesIncomplete,
        },
      },
      this.#now(scope),
    );
    clearTimeout(scope.timer);
    scope.operations.audit.close();
    this.#scopes.delete(scope.runId);
    this.#publish(scope.runId);
  }

  async #writeSnapshot(
    scope: Scope,
    filename: string,
    text: string,
  ): Promise<void> {
    const ticket = await this.#options.reserve?.(
      Buffer.byteLength(text) + 1024,
      { control: scope.controlEligible },
    );
    try {
      this.#assertCurrent(scope);
      atomicText(filename, text);
    } finally {
      ticket?.release();
    }
  }

  async #prepareAttachments(
    references: readonly JsonObject[],
    directory: string,
    scope: Scope,
  ): Promise<JsonObject[]> {
    if (!references.length) return [];
    requireCondition(
      this.#options.prepareAttachments,
      "attachments_unavailable",
      "The attachment data-plane service is unavailable.",
    );
    return await this.#options.prepareAttachments(
      references,
      directory,
      scope.services,
    );
  }
  #requestInput(scope: Scope, request: InputRequest): Promise<JsonObject> {
    if (!this.#options.reserve) return this.#openInput(scope, request);
    this.#assertActive(scope);
    requireCondition(
      !scope.pending && !scope.inputPreparation,
      "input_busy",
      "This run already has an input request being prepared or awaiting a response.",
    );
    const fixed = JSON.parse(canonicalJson(request)) as InputRequest;
    const response = Promise.withResolvers<JsonObject>();
    void response.promise.catch(() => {});
    const prepare = (async () => {
      const ticket = await this.#options.reserve!(
        Buffer.byteLength(canonicalJson(fixed)) + 65536,
        { control: scope.controlEligible },
      );
      try {
        this.#assertActive(scope);
        this.#openInput(scope, fixed).then(response.resolve, response.reject);
      } finally {
        ticket.release();
      }
    })();
    scope.inputPreparation = prepare;
    scope.deliveries.add(prepare);
    const settled = () => {
      if (scope.inputPreparation === prepare)
        scope.inputPreparation = undefined;
      scope.deliveries.delete(prepare);
    };
    void prepare.then(settled, (cause) => {
      settled();
      response.reject(cause);
    });
    return response.promise;
  }
  #openInput(scope: Scope, request: InputRequest): Promise<JsonObject> {
    this.#assertActive(scope);
    request = JSON.parse(canonicalJson(request)) as InputRequest;
    requireCondition(
      typeof request.message === "string" && request.message.trim().length > 0,
      "invalid_wait",
      "An input request needs a message.",
    );
    compileInputSchema(request.inputSchema);
    requireCondition(
      request.timeoutMs === undefined ||
        (Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0),
      "invalid_wait",
      "The input timeout must be positive.",
    );
    const run = this.store.getRun(scope.runId);
    const deadline = Math.floor(
      Math.min(
        run.deadlineAt,
        this.#now(scope) + (request.timeoutMs ?? this.#remaining(scope)),
      ),
    );
    const record = this.store.createWait(
      scope.runId,
      { message: request.message, inputSchema: request.inputSchema },
      deadline,
      this.#now(scope),
    );
    const deferred = Promise.withResolvers<JsonObject>();
    // Internal lifecycle rejection is observed even if the guest abandons this wait.
    void deferred.promise.catch(() => {});
    const timer = setTimeout(
      () => {
        try {
          this.#expireInput(scope, record.waitId);
        } catch (error) {
          this.#persistenceFailure(scope, error);
        }
      },
      Math.min(Math.max(1, deadline - this.#now(scope)), 2_147_483_647),
    );
    timer.unref();
    scope.pending = {
      record,
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer,
    };
    this.#publish(scope.runId);
    return deferred.promise;
  }
  #expireInput(scope: Scope, waitId: string): void {
    if (scope.pending?.record.waitId !== waitId) return;
    const run = this.store.getRun(scope.runId);
    if (this.#remaining(scope) <= 0 || Date.now() >= run.deadlineAt) {
      this.#stop(scope, { kind: "deadline", code: "run_deadline_exceeded" });
      return;
    }
    const pending = scope.pending;
    if (this.#now(scope) < pending.record.deadlineAt) {
      pending.timer = setTimeout(
        () => {
          try {
            this.#expireInput(scope, waitId);
          } catch (error) {
            this.#persistenceFailure(scope, error);
          }
        },
        Math.min(pending.record.deadlineAt - this.#now(scope), 2_147_483_647),
      );
      pending.timer.unref();
      return;
    }
    this.store.expireWait(waitId, this.#now(scope));
    scope.pending = null;
    clearTimeout(pending.timer);
    const error = new AgentError(
      "input_timeout",
      "The local input wait expired.",
    );
    error.name = "InputTimeoutError";
    pending.reject(error);
    this.#publish(scope.runId);
  }

  async input(
    caller: Caller,
    input: {
      agentId: string;
      runId: string;
      waitId: string;
      input: JsonValue;
      attachments?: JsonObject[];
      waitMs?: number;
    },
    signal?: AbortSignal,
  ) {
    validateContract("runtime:agent.run.input", input);
    input = JSON.parse(canonicalJson(input)) as typeof input;
    requireCondition(
      input.agentId === this.store.binding.agentId,
      "agent_mismatch",
      "The input targets a different Agent.",
    );
    this.#run(caller, input.runId, "input");
    const intent = digest({
      input: input.input,
      ...(input.attachments === undefined
        ? {}
        : { attachments: attachmentIntent(input.attachments) }),
    });
    const previous = this.store.getWait(input.waitId);
    const duplicate =
      previous.runId === input.runId &&
      previous.inputDigest === intent &&
      (previous.status === "consumed" ||
        previous.deliveryState === "preparing");
    const ticket = duplicate
      ? undefined
      : await this.#options.reserve?.(65536, {
          control: this.#scopes.get(input.runId)?.controlEligible === true,
        });
    let reservation: ReturnType<SqliteStore["reserveInput"]>;
    try {
      this.#run(caller, input.runId, "input");
      reservation = this.store.reserveInput(input.runId, input.waitId, intent);
    } finally {
      ticket?.release();
    }
    if (!reservation.duplicate) {
      const scope = this.#scopes.get(input.runId);
      requireCondition(
        scope && scope.pending?.record.waitId === input.waitId,
        "input_closed",
        "The live input continuation is unavailable.",
      );
      const delivery = this.#deliverInput(
        scope,
        input,
        reservation.wait,
        intent,
        fixedCaller(caller),
      );
      scope.deliveries.add(delivery);
      this.#inputDeliveries.set(input.waitId, delivery);
      void delivery
        .finally(() => {
          scope.deliveries.delete(delivery);
          if (this.#inputDeliveries.get(input.waitId) === delivery)
            this.#inputDeliveries.delete(input.waitId);
        })
        .catch(() => {});
    }
    const delivery = this.#inputDeliveries.get(input.waitId);
    // Delivery is independent of the observation. Do not wait for it unboundedly.
    void delivery?.catch(() => {});
    const result = await this.observe(
      caller,
      input.runId,
      input.waitMs ?? 1000,
      signal,
      true,
    );
    return { ...result, submission: this.store.getWait(input.waitId) };
  }
  async #deliverInput(
    scope: Scope,
    input: { waitId: string; input: JsonValue; attachments?: JsonObject[] },
    wait: WaitRecord,
    intent: string,
    controller: Caller,
  ): Promise<void> {
    try {
      compileInputSchema(wait.request.inputSchema)(input.input);
      const directory = privateDirectory(
        this.#directory(scope.runId),
        "inputs",
        input.waitId,
      );
      const prepared = await this.#prepareAttachments(
        input.attachments ?? [],
        directory,
        scope,
      );
      this.#checkDeadline(scope);
      scope.controller.signal.throwIfAborted();
      const filename = path.join(directory, "input.json");
      const reply = JSON.parse(
        canonicalJson(
          { input: input.input, attachments: prepared },
          2 * 1024 * 1024,
        ),
      ) as JsonObject;
      await this.#writeSnapshot(
        scope,
        filename,
        canonicalJson(reply, 2 * 1024 * 1024),
      );
      this.#run(controller, scope.runId, "input");
      this.store.consumeInput(
        scope.runId,
        input.waitId,
        intent,
        wait.revision,
        this.#relative(filename),
        { accepted: true, waitId: input.waitId, controller: { ...controller } },
        this.#now(scope),
      );
      const pending = scope.pending;
      requireCondition(
        pending?.record.waitId === input.waitId,
        "input_closed",
        "The live continuation is no longer current.",
      );
      scope.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(reply);
      this.#publish(scope.runId);
    } catch (error) {
      const current = this.store.getWait(input.waitId);
      if (current.status === "waiting" && current.revision === wait.revision)
        this.store.failInput(
          input.waitId,
          wait.revision,
          failure(error, "input"),
        );
      this.#publish(scope.runId);
    }
  }

  /** Trusted Core authority revocation, never a script/transport parameter entry. */
  stopAcceptedRun(
    runId: string,
    reason: { readonly code: string },
  ): { accepted: boolean; run: RunRecord } {
    requireCondition(
      typeof reason.code === "string" &&
        /^[a-z][a-z0-9_]{0,127}$/.test(reason.code),
      "invalid_stop_reason",
      "A Core authority stop needs its fixed failure code.",
    );
    const run = this.store.getRun(runId);
    requireCondition(
      run.bootId === this.store.bootId,
      "run_boot_mismatch",
      "Only this boot's actually accepted execution can be stopped.",
    );
    const scope = this.#scopes.get(runId);
    return scope && !terminalStatuses.has(run.status)
      ? this.#stop(scope, { kind: "authorization", code: reason.code })
      : { accepted: false, run };
  }
  cancel(caller: Caller, runId: string): CancelView {
    caller = fixedCaller(caller);
    const run = this.#run(caller, runId, "cancel");
    const scope = this.#scopes.get(runId);
    const accepted =
      scope && !terminalStatuses.has(run.status)
        ? this.#stop(scope, {
            kind: "cancel",
            requestedBy: {
              principalId: caller.principalId,
              clientId: caller.clientId,
            },
          }).accepted
        : false;
    return { ...this.#view(caller, runId), accepted };
  }
  #view(caller: Caller, runId: string): RunView {
    const run = this.#run(caller, runId, "get");
    const fatal = this.#scopes.get(runId)?.fatal;
    if (fatal) throw fatal;
    let result: JsonObject | null = null,
      unavailable: JsonObject | undefined;
    if (run.resultRef) {
      try {
        result = JSON.parse(
          this.#read(run.resultRef, runId, 96 * 1024 * 1024),
        ) as JsonObject;
      } catch {
        unavailable = {
          code: "result_unavailable",
          message:
            "The retained result is unavailable; the original run state is unchanged.",
        };
      }
    }
    const operations = this.store.operationsForRun(runId, 65);
    const resources = this.store.resourcesForRun(runId, 65);
    let resourceDetailBytes = 0;
    return {
      run,
      wait: this.store.activeWait(runId),
      result,
      resources: {
        items: resources.slice(0, 64).map((resource) => {
          const details = resource.diagnostic.details ?? {};
          const bytes = Buffer.byteLength(canonicalJson(details, 16384));
          const included =
            bytes <= 4096 && resourceDetailBytes + bytes <= 16384;
          if (included) resourceDetailBytes += bytes;
          return {
            resourceId: resource.resourceId,
            kind: resource.kind,
            status: resource.status,
            lifetime: resource.lifetime,
            createdAt: resource.createdAt,
            handedOffAt: resource.handedOffAt,
            closedAt: resource.closedAt,
            details: included ? details : {},
            ...(included ? {} : { detailsTruncated: true }),
          };
        }),
        complete: resources.length <= 64,
      },
      operations: {
        items: operations.slice(0, 64).map((operation) => ({
          operationId: operation.operationId,
          namespace: operation.namespace,
          method: operation.method,
          source: operation.source,
          status: operation.status,
          error: operation.error,
          createdAt: operation.createdAt,
          endedAt: operation.endedAt,
        })),
        complete: operations.length <= 64,
      },
      ...(unavailable ? { unavailable } : {}),
    };
  }
  async observe(
    caller: Caller,
    runId: string,
    waitMs = 0,
    signal?: AbortSignal,
    afterInput = false,
  ) {
    requireCondition(
      Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 30000,
      "invalid_wait",
      "Observation waitMs must be between 0 and 30000.",
    );
    const deadline = performance.now() + waitMs;
    for (;;) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const event = once(this, runId, { signal: combined });
      void event.catch(() => {});
      let view: RunView;
      try {
        view = this.#view(caller, runId);
      } catch (error) {
        controller.abort();
        throw error;
      }
      if (
        terminalStatuses.has(view.run.status) ||
        (view.wait &&
          (!afterInput || view.wait.deliveryState !== "preparing")) ||
        performance.now() >= deadline
      ) {
        controller.abort();
        return view;
      }
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, deadline - performance.now()),
      );
      try {
        await event;
      } catch {
        signal?.throwIfAborted();
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
  }
}
