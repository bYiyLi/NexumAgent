import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AgentError, requireCondition } from "../contracts/errors.js";
import {
  canonicalJson,
  digest,
  newId,
  requestWindow,
} from "../contracts/json.js";
import {
  terminalStatuses,
  type Binding,
  type HistoryFilter,
  type JsonObject,
  type JsonValue,
  type ResourceRecord,
  type RunRecord,
  type RunStatus,
  type SourceKind,
  type WaitRecord,
  type WorkRecord,
} from "../contracts/types.js";
import { migration1, schemaVersion } from "./schema.js";

const terminalSql = "'succeeded','failed','cancelled','interrupted'";
const transitions: Record<RunStatus, readonly RunStatus[]> = {
  accepted: ["preparing_inputs", "failed"],
  preparing_inputs: ["running", "failed"],
  running: ["succeeded", "failed"],
  waiting_input: ["failed"],
  cancelling: ["cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

function decode<T>(row: object): T {
  const value: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row)) {
    const json = key.endsWith("_json");
    const name = (json ? key.slice(0, -5) : key).replace(
      /_([a-z])/g,
      (_, letter: string) => letter.toUpperCase(),
    );
    value[name] = json && item !== null ? JSON.parse(item as string) : item;
  }
  return value as T;
}

export interface AcceptRun {
  callerKey: string;
  contextId: string;
  sourceKind: SourceKind;
  source: JsonObject;
  scriptName?: string;
  timeoutMs?: number;
  requestId?: string;
  intentDigest?: string;
  capacity?: number;
}

export class SqliteStore {
  readonly bootId = newId("boot");
  readonly root: string;
  readonly binding: Readonly<Binding>;
  #db: DatabaseSync;
  #cursorKey = randomBytes(32);
  #closed = false;

  constructor(root: string, binding: Binding, now = Date.now()) {
    requireCondition(
      path.isAbsolute(root),
      "invalid_root",
      "The Agent root must be absolute.",
    );
    requireCondition(
      binding.agentId &&
        binding.cloudEnvironment &&
        ["development", "production"].includes(binding.profile),
      "invalid_binding",
      "The Agent database requires a complete binding.",
    );
    requireCondition(
      !lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink(),
      "storage_path_escape",
      "The Agent root must not redirect to another profile.",
    );
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
    this.binding = Object.freeze({ ...binding });
    const directory = path.join(this.root, "state");
    requireCondition(
      !lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink(),
      "storage_path_escape",
      "The lifecycle directory must not be redirected.",
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const relative = path.relative(this.root, realpathSync(directory));
    requireCondition(
      relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative),
      "storage_path_escape",
      "The lifecycle directory must remain inside this Agent root.",
    );
    const filename = path.join(directory, "runtime.sqlite");
    for (const candidate of [filename, filename + "-wal", filename + "-shm"]) {
      const existing = lstatSync(candidate, { throwIfNoEntry: false });
      requireCondition(
        !existing || (!existing.isSymbolicLink() && existing.isFile()),
        "storage_path_escape",
        "Database files must be regular files inside the lifecycle directory.",
      );
    }
    this.#db = new DatabaseSync(filename, {
      timeout: 100,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    try {
      if (process.platform !== "win32") chmodSync(filename, 0o600);
      this.#db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
      );
      for (const [pragma, expected] of [
        ["locking_mode", "exclusive"],
        ["journal_mode", "wal"],
        ["synchronous", 2],
        ["foreign_keys", 1],
      ] as const) {
        requireCondition(
          this.#db.prepare(`PRAGMA ${pragma}`).get()?.[pragma] === expected,
          "storage_configuration",
          `SQLite could not apply ${pragma}.`,
        );
      }
      const version = this.#db.prepare("PRAGMA user_version").get()
        ?.user_version as number;
      requireCondition(
        version <= schemaVersion,
        "storage_future_version",
        "The database requires a newer Agent.",
      );
      this.#transaction(() => {
        if (version === 0) {
          this.#db.exec(migration1);
          this.#db.exec(`PRAGMA user_version=${schemaVersion}`);
        }
        const metadata = this.#db
          .prepare("SELECT * FROM runtime_meta WHERE singleton=1")
          .get();
        if (metadata) {
          requireCondition(
            metadata.agent_id === binding.agentId &&
              metadata.profile === binding.profile &&
              metadata.cloud_environment === binding.cloudEnvironment,
            "storage_binding_mismatch",
            "The database belongs to a different Agent, profile, or Cloud environment.",
          );
        } else {
          // Only a newly created, empty schema may acquire its initial binding.
          const count = this.#db
            .prepare("SELECT count(*) n FROM runs")
            .get()?.n;
          requireCondition(
            count === 0 && version === 0,
            "storage_binding_missing",
            "The existing database binding is missing.",
          );
          this.#db
            .prepare("INSERT INTO runtime_meta VALUES(1,?,?,?,?)")
            .run(
              binding.agentId,
              binding.profile,
              binding.cloudEnvironment,
              this.bootId,
            );
        }
        this.#db
          .prepare("UPDATE runtime_meta SET boot_id=? WHERE singleton=1")
          .run(this.bootId);
        this.#interrupt(now);
      });
    } catch (error) {
      this.#db.close();
      throw this.#storageError(error);
    }
  }

  #storageError(error: unknown): AgentError {
    if (error instanceof AgentError) return error;
    const code = (error as { errcode?: number })?.errcode;
    return new AgentError(
      code === 5 || code === 6 ? "storage_busy" : "storage_error",
      "The local lifecycle database operation failed.",
      undefined,
      { cause: error },
    );
  }

  #transaction<T>(operation: () => T): T {
    requireCondition(
      !this.#closed,
      "storage_closed",
      "The local store is closed.",
    );
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const value = operation();
        this.#db.exec("COMMIT");
        return value;
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      throw this.#storageError(error);
    }
  }

  #interrupt(now: number): void {
    const reason = canonicalJson({
      code: "agent_restarted",
      message: "The Agent restarted; execution was not restored.",
    });
    this.#db
      .prepare("UPDATE work_contexts SET status='expired' WHERE status='open'")
      .run();
    this.#db
      .prepare(
        `UPDATE runs SET status='interrupted',ended_at=?,updated_at=?,error_json=?,revision=revision+1
      WHERE status NOT IN (${terminalSql})`,
      )
      .run(now, now, reason);
    this.#db
      .prepare(
        "UPDATE run_waits SET status='cancelled',revision=revision+1 WHERE status='waiting'",
      )
      .run();
    this.#db
      .prepare(
        `UPDATE managed_resources SET status='unavailable',
      diagnostic_json=json_set(json_patch(diagnostic_json,?),'$.osStopped',NULL),revision=revision+1 WHERE closed_at IS NULL`,
      )
      .run(canonicalJson({ code: "agent_restarted", controlAvailable: false }));
    this.#db
      .prepare(
        `UPDATE transfers SET status='interrupted',ended_at=?,revision=revision+1
      WHERE status NOT IN ('succeeded','failed','cancelled','expired','interrupted')`,
      )
      .run(now);
    this.#db
      .prepare(
        "UPDATE operations SET status='interrupted',ended_at=?,updated_at=?,error_json=?,revision=revision+1 WHERE ended_at IS NULL",
      )
      .run(now, now, reason);
  }

  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }

  #get<T>(table: string, column: string, id: string, errorCode: string): T {
    const row = this.#db
      .prepare(`SELECT * FROM ${table} WHERE ${column}=?`)
      .get(id);
    requireCondition(
      row,
      errorCode,
      "The requested local record does not exist.",
    );
    return decode<T>(row);
  }

  getWork(id: string): WorkRecord {
    return this.#get("work_contexts", "context_id", id, "context_not_found");
  }
  getRun(id: string): RunRecord {
    return this.#get("runs", "run_id", id, "run_not_found");
  }
  getWait(id: string): WaitRecord {
    return this.#get("run_waits", "wait_id", id, "wait_not_found");
  }
  getResource(id: string): ResourceRecord {
    return this.#get(
      "managed_resources",
      "resource_id",
      id,
      "resource_not_found",
    );
  }

  #activeWork(id: string, callerKey: string, now: number): WorkRecord {
    const work = this.getWork(id);
    requireCondition(
      work.callerKey === callerKey,
      "context_forbidden",
      "This work belongs to another caller.",
    );
    const protectedByRun = this.#db
      .prepare(
        "SELECT 1 FROM runs WHERE context_id=? AND ended_at IS NULL LIMIT 1",
      )
      .get(id);
    requireCondition(
      work.bootId === this.bootId &&
        work.status === "open" &&
        (work.expiresAt > now || protectedByRun),
      "context_closed",
      "This work is closed or expired; open a new work context.",
    );
    return work;
  }

  openWork(
    input: {
      callerKey: string;
      projectId?: string;
      pwd: string;
      snapshotRef: string;
    },
    now = Date.now(),
  ): WorkRecord {
    requireCondition(
      path.isAbsolute(input.pwd),
      "invalid_pwd",
      "The work directory must be absolute.",
    );
    const id = newId("ctx");
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO work_contexts VALUES(?,?,?,?,1,'open',?,?,?,?,?,NULL)`,
        )
        .run(
          id,
          input.callerKey,
          input.projectId ?? null,
          this.bootId,
          input.pwd,
          input.snapshotRef,
          now,
          now,
          now + 86_400_000,
        );
      return this.getWork(id);
    });
  }

  refreshWork(
    id: string,
    callerKey: string,
    revision: number,
    snapshotRef: string,
    now = Date.now(),
  ): WorkRecord {
    return this.#transaction(() => {
      this.#activeWork(id, callerKey, now);
      const changed = this.#db
        .prepare(
          `UPDATE work_contexts SET revision=revision+1,snapshot_ref=?,last_used_at=?,expires_at=?
        WHERE context_id=? AND revision=? AND status='open'`,
        )
        .run(snapshotRef, now, now + 86_400_000, id, revision).changes;
      requireCondition(
        changed === 1,
        "revision_conflict",
        "The work was refreshed or closed concurrently.",
      );
      return this.getWork(id);
    });
  }

  closeWork(id: string, callerKey: string, now = Date.now()): JsonObject {
    return this.#transaction(() => {
      const previous = this.#db
        .prepare(
          "SELECT * FROM close_receipts WHERE context_id=? AND expires_at>?",
        )
        .get(id, now);
      if (previous) {
        requireCondition(
          previous.caller_key === callerKey,
          "context_forbidden",
          "The close receipt belongs to another caller.",
        );
        return JSON.parse(previous.receipt_json as string) as JsonObject;
      }
      const work = this.#activeWork(id, callerKey, now);
      const affected = work.projectId
        ? this.#db
            .prepare(
              "SELECT context_id FROM work_contexts WHERE project_id=? AND status='open'",
            )
            .all(work.projectId)
        : [{ context_id: id }];
      for (const entry of affected)
        this.#db
          .prepare(
            "UPDATE work_contexts SET status='closed',closed_at=?,revision=revision+1 WHERE context_id=?",
          )
          .run(now, entry.context_id as string);
      const receipt: JsonObject = {
        contextId: id,
        projectId: work.projectId,
        agentConfirmed: true,
        affectedContextIds: affected.map((entry) => entry.context_id as string),
        closedAt: now,
      };
      this.#db
        .prepare("INSERT INTO close_receipts VALUES(?,?,?,?,?,?,?)")
        .run(
          id,
          work.projectId,
          callerKey,
          work.revision + 1,
          canonicalJson(receipt),
          now,
          now + 86_400_000,
        );
      return receipt;
    });
  }

  acceptRun(
    input: AcceptRun,
    now = Date.now(),
  ): { run: RunRecord; duplicate: boolean } {
    const request = input.requestId
      ? requestWindow(input.requestId, now)
      : undefined;
    if (request)
      requireCondition(
        input.intentDigest,
        "invalid_submission",
        "A submission requires its fixed intent digest.",
      );
    const timeout = input.timeoutMs ?? 1_800_000;
    requireCondition(
      Number.isSafeInteger(timeout) &&
        timeout > 0 &&
        Number.isSafeInteger(now + timeout) &&
        now + timeout <= 253402300799999,
      "invalid_timeout",
      "The runtime deadline is invalid.",
    );
    return this.#transaction(() => {
      if (input.requestId) {
        const previous = this.#db
          .prepare(
            "SELECT * FROM run_requests WHERE caller_key=? AND request_id=?",
          )
          .get(input.callerKey, input.requestId);
        if (previous) {
          requireCondition(
            previous.intent_digest === input.intentDigest,
            "submission_conflict",
            "The submission identifier belongs to a different intent.",
          );
          try {
            return {
              run: this.getRun(previous.run_id as string),
              duplicate: true,
            };
          } catch (error) {
            throw new AgentError(
              "submission_unknown",
              "The original accepted run is unavailable.",
              undefined,
              { cause: error },
            );
          }
        }
      }
      const work = this.#activeWork(input.contextId, input.callerKey, now);
      const capacity = input.capacity ?? 256;
      requireCondition(
        Number.isInteger(capacity) && capacity > 0,
        "invalid_capacity",
        "The configured run capacity is invalid.",
      );
      const active = this.#db
        .prepare("SELECT count(*) n FROM runs WHERE ended_at IS NULL")
        .get()?.n as number;
      requireCondition(
        active < capacity,
        "runtime_busy",
        "The Agent has no free run slot.",
      );
      const runId = newId("run");
      this.#db
        .prepare(
          `INSERT INTO runs(run_id,caller_key,context_id,project_id,boot_id,status,source_kind,script_name,
        source_json,accepted_at,deadline_at,updated_at) VALUES(?,?,?,?,?,'accepted',?,?,?,?,?,?)`,
        )
        .run(
          runId,
          input.callerKey,
          input.contextId,
          work.projectId,
          this.bootId,
          input.sourceKind,
          input.scriptName ?? null,
          canonicalJson(input.source),
          now,
          now + timeout,
          now,
        );
      if (request)
        this.#db
          .prepare("INSERT INTO run_requests VALUES(?,?,?,?,?)")
          .run(
            input.callerKey,
            input.requestId!,
            input.intentDigest!,
            runId,
            request.expiresAt,
          );
      this.#db
        .prepare(
          "UPDATE work_contexts SET last_used_at=?,expires_at=? WHERE context_id=?",
        )
        .run(now, now + 86_400_000, work.contextId);
      return { run: this.getRun(runId), duplicate: false };
    });
  }

  findSubmission(
    callerKey: string,
    requestId: string,
    now = Date.now(),
  ): RunRecord {
    requestWindow(requestId, now);
    const row = this.#db
      .prepare(
        "SELECT run_id FROM run_requests WHERE caller_key=? AND request_id=?",
      )
      .get(callerKey, requestId);
    requireCondition(
      row,
      "submission_unknown",
      "No accepted submission can be confirmed.",
    );
    return this.getRun(row.run_id as string);
  }

  transitionRun(
    id: string,
    revision: number,
    status: RunStatus,
    patch: {
      codeRef?: string;
      inputRef?: string;
      resultRef?: string;
      logsRef?: string;
      source?: JsonObject;
      scriptName?: string;
      error?: JsonObject;
      cleanup?: JsonObject;
    } = {},
    now = Date.now(),
  ): RunRecord {
    return this.#transaction(() => {
      const run = this.getRun(id);
      requireCondition(
        run.revision === revision && transitions[run.status].includes(status),
        "run_state_conflict",
        "The run state changed or the transition is not allowed.",
      );
      if (status === "succeeded")
        requireCondition(
          run.stop === null,
          "run_stopping",
          "The run has already accepted a stop reason.",
        );
      if (status === "succeeded")
        requireCondition(
          now < run.deadlineAt,
          "run_deadline_exceeded",
          "The runtime deadline has passed.",
        );
      const ended = terminalStatuses.has(status);
      if (ended && run.stop)
        requireCondition(
          status === (run.stop.kind === "cancel" ? "cancelled" : "failed"),
          "run_state_conflict",
          "The first accepted stop reason determines the terminal outcome.",
        );
      if (ended)
        requireCondition(
          !this.#db
            .prepare(
              "SELECT 1 FROM managed_resources WHERE owner_run_id=? AND closed_at IS NULL LIMIT 1",
            )
            .get(id),
          "run_cleanup_pending",
          "Run-owned managed resources have not confirmed closure.",
        );
      this.#db
        .prepare(
          `UPDATE runs SET status=?,revision=revision+1,code_ref=?,input_ref=?,result_ref=?,logs_ref=?,script_name=?,
        source_json=?,error_json=?,cleanup_json=?,started_at=?,ended_at=?,updated_at=? WHERE run_id=? AND revision=? AND ended_at IS NULL`,
        )
        .run(
          status,
          patch.codeRef ?? run.codeRef,
          patch.inputRef ?? run.inputRef,
          patch.resultRef ?? run.resultRef,
          patch.logsRef ?? run.logsRef,
          patch.scriptName ?? run.scriptName,
          canonicalJson(patch.source ?? run.source),
          patch.error
            ? canonicalJson(patch.error)
            : run.error
              ? canonicalJson(run.error)
              : null,
          canonicalJson(patch.cleanup ?? run.cleanup),
          run.startedAt ?? (status === "running" ? now : null),
          ended ? now : null,
          now,
          id,
          revision,
        );
      if (ended)
        this.#db
          .prepare(
            "UPDATE run_waits SET status='cancelled',revision=revision+1 WHERE run_id=? AND status='waiting'",
          )
          .run(id);
      return this.getRun(id);
    });
  }

  requestStop(
    id: string,
    reason: JsonObject,
    now = Date.now(),
  ): { accepted: boolean; run: RunRecord } {
    return this.#transaction(() => {
      const run = this.getRun(id);
      if (terminalStatuses.has(run.status) || run.stop)
        return { accepted: false, run };
      this.#db
        .prepare(
          "UPDATE runs SET status='cancelling',stop_json=?,updated_at=?,revision=revision+1 WHERE run_id=? AND revision=? AND ended_at IS NULL",
        )
        .run(canonicalJson(reason), now, id, run.revision);
      this.#db
        .prepare(
          "UPDATE run_waits SET status='cancelled',revision=revision+1 WHERE run_id=? AND status='waiting'",
        )
        .run(id);
      return { accepted: true, run: this.getRun(id) };
    });
  }

  savePreparation(
    id: string,
    revision: number,
    patch: {
      codeRef: string;
      inputRef?: string;
      logsRef?: string;
      source: JsonObject;
      scriptName?: string;
    },
  ): RunRecord {
    return this.#transaction(() => {
      const run = this.getRun(id);
      requireCondition(
        run.status === "preparing_inputs" &&
          !run.stop &&
          run.revision === revision,
        "run_state_conflict",
        "Preparation is no longer current.",
      );
      this.#db
        .prepare(
          `UPDATE runs SET code_ref=?,input_ref=?,logs_ref=?,source_json=?,script_name=?,revision=revision+1
        WHERE run_id=? AND revision=? AND status='preparing_inputs'`,
        )
        .run(
          patch.codeRef,
          patch.inputRef ?? run.inputRef,
          patch.logsRef ?? run.logsRef,
          canonicalJson(patch.source),
          patch.scriptName ?? run.scriptName,
          id,
          revision,
        );
      return this.getRun(id);
    });
  }

  createWait(
    runId: string,
    request: JsonObject,
    deadlineAt: number,
    now = Date.now(),
  ): WaitRecord {
    return this.#transaction(() => {
      const run = this.getRun(runId);
      requireCondition(
        run.status === "running" &&
          !run.stop &&
          now < deadlineAt &&
          deadlineAt <= run.deadlineAt,
        "invalid_wait",
        "An input wait requires a running run and a valid deadline.",
      );
      requireCondition(
        !this.activeWait(runId),
        "input_already_waiting",
        "Only one active input wait is allowed per run.",
      );
      const id = newId("wait");
      this.#db
        .prepare(
          `INSERT INTO run_waits(wait_id,run_id,status,delivery_state,request_json,created_at,deadline_at)
        VALUES(?,?,'waiting','none',?,?,?)`,
        )
        .run(id, runId, canonicalJson(request), now, deadlineAt);
      this.#db
        .prepare(
          "UPDATE runs SET status='waiting_input',updated_at=?,revision=revision+1 WHERE run_id=? AND revision=?",
        )
        .run(now, runId, run.revision);
      return this.getWait(id);
    });
  }

  activeWait(runId: string): WaitRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM run_waits WHERE run_id=? AND status='waiting'")
      .get(runId);
    return row ? decode<WaitRecord>(row) : null;
  }

  #inputTarget(
    runId: string,
    waitId: string,
    inputDigest: string,
    now: number,
  ): WaitRecord {
    const wait = this.getWait(waitId);
    requireCondition(
      wait.runId === runId,
      "wait_mismatch",
      "This wait belongs to another run.",
    );
    if (wait.status === "consumed") {
      requireCondition(
        wait.inputDigest === inputDigest,
        "input_conflict",
        "This wait already consumed a different input.",
      );
      return wait;
    }
    const run = this.getRun(runId);
    requireCondition(
      wait.status === "waiting" &&
        wait.deadlineAt > now &&
        run.deadlineAt > now &&
        run.status === "waiting_input" &&
        !run.stop,
      "input_closed",
      "This input wait is no longer available.",
    );
    return wait;
  }

  reserveInput(
    runId: string,
    waitId: string,
    inputDigest: string,
    now = Date.now(),
  ): { duplicate: boolean; wait: WaitRecord } {
    return this.#transaction(() => {
      const wait = this.#inputTarget(runId, waitId, inputDigest, now);
      if (wait.status === "consumed") return { duplicate: true, wait };
      if (wait.deliveryState === "preparing") {
        requireCondition(
          wait.inputDigest === inputDigest,
          "input_conflict",
          "A different input is already being prepared.",
        );
        return { duplicate: true, wait };
      }
      this.#db
        .prepare(
          "UPDATE run_waits SET delivery_state='preparing',input_digest=?,error_json=NULL,revision=revision+1 WHERE wait_id=? AND revision=?",
        )
        .run(inputDigest, waitId, wait.revision);
      return { duplicate: false, wait: this.getWait(waitId) };
    });
  }

  failInput(waitId: string, revision: number, error: JsonObject): WaitRecord {
    return this.#transaction(() => {
      const changed = this.#db
        .prepare(
          `UPDATE run_waits SET delivery_state='failed',error_json=?,revision=revision+1
        WHERE wait_id=? AND revision=? AND status='waiting' AND delivery_state='preparing'`,
        )
        .run(canonicalJson(error), waitId, revision).changes;
      requireCondition(
        changed === 1,
        "input_state_conflict",
        "The input reservation is no longer current.",
      );
      return this.getWait(waitId);
    });
  }

  consumeInput(
    runId: string,
    waitId: string,
    inputDigest: string,
    revision: number,
    inputRef: string,
    receipt: JsonObject,
    now = Date.now(),
  ): WaitRecord {
    return this.#transaction(() => {
      const wait = this.#inputTarget(runId, waitId, inputDigest, now);
      if (wait.status === "consumed") return wait;
      requireCondition(
        wait.deliveryState === "preparing" &&
          wait.inputDigest === inputDigest &&
          wait.revision === revision,
        "input_state_conflict",
        "The input reservation is no longer current.",
      );
      this.#db
        .prepare(
          "UPDATE run_waits SET status='consumed',delivery_state='consumed',input_ref=?,receipt_json=?,consumed_at=?,revision=revision+1 WHERE wait_id=? AND revision=?",
        )
        .run(inputRef, canonicalJson(receipt), now, waitId, revision);
      this.#db
        .prepare(
          "UPDATE runs SET status='running',updated_at=?,revision=revision+1 WHERE run_id=? AND status='waiting_input'",
        )
        .run(now, runId);
      return this.getWait(waitId);
    });
  }

  expireWait(waitId: string, now = Date.now()): WaitRecord {
    return this.#transaction(() => {
      const wait = this.getWait(waitId);
      requireCondition(
        wait.status === "waiting" && now >= wait.deadlineAt,
        "input_state_conflict",
        "This wait has not expired.",
      );
      this.#db
        .prepare(
          "UPDATE run_waits SET status='expired',revision=revision+1 WHERE wait_id=? AND status='waiting'",
        )
        .run(waitId);
      this.#db
        .prepare(
          "UPDATE runs SET status='running',updated_at=?,revision=revision+1 WHERE run_id=? AND status='waiting_input'",
        )
        .run(now, wait.runId);
      return this.getWait(waitId);
    });
  }

  registerResource(
    input: {
      callerKey: string;
      kind: string;
      source: JsonObject;
      runId?: string;
      status?: string;
    },
    now = Date.now(),
  ): ResourceRecord {
    return this.#transaction(() => {
      if (input.runId) {
        const run = this.getRun(input.runId);
        requireCondition(
          (run.status === "running" || run.status === "waiting_input") &&
            !run.stop,
          "run_stopping",
          "This run cannot acquire a new managed resource.",
        );
      }
      const id = newId("res");
      this.#db
        .prepare(
          `INSERT INTO managed_resources(resource_id,origin_run_id,owner_run_id,caller_key,boot_id,kind,lifetime,source_json,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.runId ?? null,
          input.runId ?? null,
          input.callerKey,
          this.bootId,
          input.kind,
          input.runId ? "run" : "instance",
          canonicalJson(input.source),
          input.status ?? "active",
          now,
        );
      return this.getResource(id);
    });
  }

  handoff(
    resourceId: string,
    runId: string,
    revision: number,
    now = Date.now(),
  ): ResourceRecord {
    return this.#transaction(() => {
      const resource = this.getResource(resourceId);
      const run = this.getRun(runId);
      requireCondition(
        resource.bootId === this.bootId &&
          resource.ownerRunId === runId &&
          resource.revision === revision &&
          resource.closedAt === null,
        "resource_state_conflict",
        "This resource cannot be handed off.",
      );
      requireCondition(
        (run.status === "running" || run.status === "waiting_input") &&
          !run.stop,
        "run_stopping",
        "The creator already started finishing or stopping.",
      );
      const active = this.#db
        .prepare(
          "SELECT count(*) n FROM managed_resources WHERE boot_id=? AND lifetime='background' AND closed_at IS NULL",
        )
        .get(this.bootId)?.n as number;
      requireCondition(
        active < 32,
        "background_busy",
        "No independent background resource slot is available.",
      );
      this.#db
        .prepare(
          "UPDATE managed_resources SET lifetime='background',owner_run_id=NULL,handed_off_at=?,revision=revision+1 WHERE resource_id=? AND revision=?",
        )
        .run(now, resourceId, revision);
      return this.getResource(resourceId);
    });
  }

  closeResource(
    id: string,
    revision: number,
    diagnostic: JsonObject = {},
    now = Date.now(),
  ): ResourceRecord {
    return this.#transaction(() => {
      const resource = this.getResource(id);
      requireCondition(
        resource.bootId === this.bootId,
        "resource_unavailable",
        "The old Agent resource cannot be controlled.",
      );
      if (resource.closedAt !== null) return resource;
      requireCondition(
        resource.revision === revision,
        "resource_state_conflict",
        "The resource changed concurrently.",
      );
      this.#db
        .prepare(
          "UPDATE managed_resources SET status='closed',closed_at=?,diagnostic_json=?,revision=revision+1 WHERE resource_id=? AND revision=?",
        )
        .run(now, canonicalJson(diagnostic), id, revision);
      return this.getResource(id);
    });
  }

  resourcesForRun(runId: string): ResourceRecord[] {
    return this.#db
      .prepare(
        "SELECT * FROM managed_resources WHERE origin_run_id=? ORDER BY created_at,resource_id",
      )
      .all(runId)
      .map((row) => decode<ResourceRecord>(row));
  }

  scriptUsage(callerKey: string): {
    owner: string;
    scriptName: string;
    count: number;
    lastStartedAt: number;
  }[] {
    return this.#db
      .prepare(
        `SELECT json_extract(source_json,'$.origin.owner') owner,
      script_name scriptName,count(*) count,max(started_at) lastStartedAt FROM runs
      WHERE caller_key=? AND started_at IS NOT NULL AND script_name IS NOT NULL
      AND json_type(source_json,'$.origin.owner')='text' GROUP BY owner,script_name`,
      )
      .all(callerKey) as {
      owner: string;
      scriptName: string;
      count: number;
      lastStartedAt: number;
    }[];
  }

  getState(
    key: string,
  ): { value: JsonValue; version: number; updatedAt: number } | null {
    const row = this.#db
      .prepare("SELECT * FROM agent_state WHERE key=?")
      .get(key);
    return row
      ? {
          value: JSON.parse(row.value_json as string) as JsonValue,
          version: row.version as number,
          updatedAt: row.updated_at as number,
        }
      : null;
  }

  setState(
    key: string,
    value: JsonValue,
    expectedVersion: number | null,
    now = Date.now(),
  ): { value: JsonValue; version: number; updatedAt: number } {
    requireCondition(
      key.length > 0 && key.length <= 256,
      "invalid_state_key",
      "The state key is invalid.",
    );
    const encoded = canonicalJson(value);
    return this.#transaction(() => {
      const previous = this.getState(key);
      requireCondition(
        (previous?.version ?? null) === expectedVersion,
        "state_version_conflict",
        "The shared value changed concurrently.",
      );
      if (previous)
        this.#db
          .prepare(
            "UPDATE agent_state SET value_json=?,version=version+1,updated_at=? WHERE key=? AND version=?",
          )
          .run(encoded, now, key, expectedVersion);
      else
        this.#db
          .prepare("INSERT INTO agent_state VALUES(?,?,1,?)")
          .run(key, encoded, now);
      return this.getState(key)!;
    });
  }

  listRuns(
    filter: HistoryFilter,
    scopeKey: string,
    limit = 20,
    cursor?: string,
  ): { runs: RunRecord[]; nextCursor: string | null } {
    requireCondition(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      "invalid_limit",
      "The history limit must be between 1 and 100.",
    );
    requireCondition(
      filter.from === undefined ||
        filter.to === undefined ||
        filter.from <= filter.to,
      "invalid_range",
      "The history start must not exceed the end.",
    );
    const query = digest({
      scopeKey,
      binding: this.binding,
      filter: Object.fromEntries(
        Object.entries(filter).filter(([, value]) => value !== undefined),
      ),
    });
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [field, column] of [
      ["status", "status"],
      ["scriptName", "script_name"],
      ["sourceKind", "source_kind"],
      ["projectId", "project_id"],
      ["contextId", "context_id"],
    ] as const) {
      if (filter[field] !== undefined) {
        where.push(`${column}=?`);
        values.push(filter[field]!);
      }
    }
    if (filter.from !== undefined) {
      where.push("accepted_at>=?");
      values.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("accepted_at<?");
      values.push(filter.to);
    }
    if (cursor) {
      let page: { time: number; id: string; query: string };
      try {
        const [encoded, signature, extra] = cursor.split(".");
        requireCondition(
          encoded && signature && !extra && cursor.length <= 4096,
          "invalid_cursor",
          "The history cursor is invalid.",
        );
        const expected = createHmac("sha256", this.#cursorKey)
          .update(encoded)
          .digest();
        const supplied = Buffer.from(signature, "base64url");
        requireCondition(
          supplied.length === expected.length &&
            timingSafeEqual(supplied, expected),
          "invalid_cursor",
          "The history cursor is invalid.",
        );
        page = JSON.parse(
          Buffer.from(encoded, "base64url").toString("utf8"),
        ) as typeof page;
        requireCondition(
          page.query === query &&
            Number.isSafeInteger(page.time) &&
            typeof page.id === "string",
          "invalid_cursor",
          "The cursor belongs to another query or scope.",
        );
      } catch (error) {
        throw new AgentError(
          "invalid_cursor",
          "The history cursor is invalid or no longer current.",
          undefined,
          { cause: error },
        );
      }
      where.push("(accepted_at<? OR (accepted_at=? AND run_id<?))");
      values.push(page.time, page.time, page.id);
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY accepted_at DESC,run_id DESC LIMIT ?`,
      )
      .all(...values, limit + 1);
    const runs = rows.slice(0, limit).map((row) => decode<RunRecord>(row));
    let nextCursor: string | null = null;
    const last = runs.at(-1);
    if (rows.length > limit && last) {
      const encoded = Buffer.from(
        JSON.stringify({ query, time: last.acceptedAt, id: last.runId }),
      ).toString("base64url");
      nextCursor =
        encoded +
        "." +
        createHmac("sha256", this.#cursorKey)
          .update(encoded)
          .digest("base64url");
    }
    return { runs, nextCursor };
  }
}
