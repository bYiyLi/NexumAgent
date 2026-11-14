import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import { MIMEType } from "node:util";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import {
  canonicalJson,
  digest,
  newId,
  requestWindow,
  isPlainRecord,
} from "../contracts/json.js";
import type {
  TransferRecord,
  TransferOwner,
  TransferMetadata,
  TransferFilter,
  TransferScan,
  PublishedTransfer,
  TransferStop,
  TransferFinish,
  TransferProgress,
} from "./transfers.js";
import {
  terminalStatuses,
  DEFAULT_CONTROL_CAPACITY,
  type Binding,
  type HistoryFilter,
  type JsonObject,
  type JsonValue,
  type ResourceRecord,
  type OperationRecord,
  type ContributionOrigin,
  type RunRecord,
  type RunStatus,
  type SourceKind,
  type AdmissionClass,
  type WaitRecord,
  type WorkRecord,
} from "../contracts/types.js";
import {
  migration1,
  migration2,
  migration3,
  migration4,
  migration5,
  schemaVersion,
} from "./schema.js";

const terminalSql = "'succeeded','failed','cancelled','interrupted'";
export type McpTaskStatus =
  "working" | "input_required" | "completed" | "cancelled" | "failed";
export interface McpTaskRecord {
  readonly taskId: string;
  readonly callerKey: string;
  readonly runId: string;
  readonly status: McpTaskStatus;
  readonly resultRef: string | null;
  readonly error: JsonObject | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
}
export interface CleanupBatch {
  readonly processed: number;
  readonly deleted: Readonly<Record<string, number>>;
  readonly files: readonly {
    readonly kind: "run" | "log" | "task" | "process_log" | "inputs";
    readonly ref: string;
  }[];
}
const taskTerminal = new Set<McpTaskStatus>([
  "completed",
  "cancelled",
  "failed",
]);
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
  /** Internal verdict from the fixed platform-code qualifier; never a tool argument. */
  controlEligible?: boolean;
  controlCapacity?: number;
}
export interface MaintenanceOperationInput {
  readonly requestId: string;
  readonly approvedRevision: string;
  readonly callerKey: string;
  readonly originRunId?: string | null;
  readonly source: JsonObject;
  readonly method: string;
  readonly detailRef: string;
}
const maintenanceMethods = new Set([
  "packages.install",
  "packages.update",
  "packages.remove",
  "extensions.enable",
  "extensions.disable",
  "mcp.add",
  "mcp.update",
  "mcp.remove",
  "api.import",
  "api.update",
  "api.remove",
]);
const maintenanceRequest = /^maint_req_[A-Za-z0-9_-]{1,128}$/;

export interface ResourceHistoryFilter {
  readonly owner: string;
  readonly namespace: string;
  readonly type: ContributionOrigin["type"];
  readonly kind?: string;
  readonly status?: string;
  readonly state?: string;
  readonly runId?: string;
  readonly contextId?: string;
}
export interface ResourceHistoryRecord extends ResourceRecord {
  readonly contextId: string | null;
}

export class SqliteStore {
  readonly bootId: string;
  readonly root: string;
  readonly binding: Readonly<Binding>;
  #db: DatabaseSync;
  #cursorKey = randomBytes(32);
  #closed = false;

  constructor(
    root: string,
    binding: Binding,
    now = Date.now(),
    bootId: string = newId("boot"),
  ) {
    requireCondition(
      typeof bootId === "string" && /^boot_[0-9a-f]{32}$/.test(bootId),
      "invalid_boot_id",
      "The Agent process boot identity is invalid.",
    );
    this.bootId = bootId;
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
    this.root = realpathSync.native(root);
    this.binding = Object.freeze({ ...binding });
    const directory = path.join(this.root, "state");
    requireCondition(
      !lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink(),
      "storage_path_escape",
      "The lifecycle directory must not be redirected.",
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const relative = path.relative(this.root, realpathSync.native(directory));
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
        }
        if (version < 2) this.#db.exec(migration2);
        if (version < 3) this.#db.exec(migration3);
        if (version < 4) this.#db.exec(migration4);
        if (version < 5) this.#db.exec(migration5);
        this.#db.exec(`PRAGMA user_version=${schemaVersion}`);
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
      diagnostic_json=json_set(json_patch(diagnostic_json,?),'$.osStopped',NULL,'$.unavailableAt',
        CASE WHEN json_type(diagnostic_json,'$.unavailableAt') IN ('integer','real') THEN CAST(json_extract(diagnostic_json,'$.unavailableAt') AS INTEGER) ELSE CAST(? AS INTEGER) END),revision=revision+1 WHERE closed_at IS NULL`,
      )
      .run(
        canonicalJson({ code: "agent_restarted", controlAvailable: false }),
        now,
      );
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
  activeWork(id: string, callerKey: string, now = Date.now()): WorkRecord {
    return this.#activeWork(id, callerKey, now);
  }
  getRun(id: string): RunRecord {
    return this.#get("runs", "run_id", id, "run_not_found");
  }

  /** Bind an existing, authorized run before a Task handle can leave the Agent. */
  createTask(
    input: { taskId: string; callerKey: string; runId: string; ttlMs: number },
    now = Date.now(),
  ): McpTaskRecord {
    requireCondition(
      /^nx_task_[A-Za-z0-9_-]{1,1016}$/.test(input.taskId) &&
        typeof input.callerKey === "string" &&
        input.callerKey.length > 0 &&
        Number.isSafeInteger(input.ttlMs) &&
        input.ttlMs > 0 &&
        Number.isSafeInteger(now) &&
        now >= 0 &&
        Number.isSafeInteger(now + input.ttlMs) &&
        now + input.ttlMs <= 253402300799999,
      "invalid_task",
      "The Task identity or retention deadline is invalid.",
    );
    return this.#transaction(() => {
      const run = this.getRun(input.runId);
      requireCondition(
        run.callerKey === input.callerKey,
        "task_not_found",
        "The Task run is unavailable to this caller.",
      );
      const previous = this.#db
        .prepare(
          "SELECT * FROM mcp_tasks WHERE caller_key=? AND run_id=? AND expires_at>? ORDER BY created_at,task_id LIMIT 1",
        )
        .get(input.callerKey, input.runId, now);
      // A retried create never renews a published promise.
      if (previous) return decode<McpTaskRecord>(previous);
      this.#db
        .prepare(
          "INSERT INTO mcp_tasks(task_id,caller_key,run_id,status,created_at,updated_at,expires_at) VALUES(?,?,?,'working',?,?,?)",
        )
        .run(
          input.taskId,
          input.callerKey,
          input.runId,
          now,
          now,
          now + input.ttlMs,
        );
      return this.getTask(input.taskId, input.callerKey, now);
    });
  }

  getTask(taskId: string, key: string, now = Date.now()): McpTaskRecord {
    const row = this.#db
      .prepare("SELECT * FROM mcp_tasks WHERE task_id=? AND caller_key=?")
      .get(taskId, key);
    requireCondition(
      row,
      "task_not_found",
      "The Task does not exist for this caller.",
    );
    const task = decode<McpTaskRecord>(row);
    requireCondition(
      task.expiresAt > now,
      "task_expired",
      "The Task retention promise has expired.",
    );
    return task;
  }

  taskForRun(
    runId: string,
    key: string,
    now = Date.now(),
  ): McpTaskRecord | null {
    requireCondition(
      !this.#closed,
      "storage_closed",
      "The local store is closed.",
    );
    const row = this.#db
      .prepare(
        "SELECT * FROM mcp_tasks WHERE run_id=? AND caller_key=? AND expires_at>? ORDER BY created_at,task_id LIMIT 1",
      )
      .get(runId, key, now);
    return row ? decode<McpTaskRecord>(row) : null;
  }

  updateTask(
    taskId: string,
    key: string,
    patch: { status: McpTaskStatus; resultRef?: string; error?: JsonObject },
    now = Date.now(),
  ): McpTaskRecord {
    requireCondition(
      [
        "working",
        "input_required",
        "completed",
        "cancelled",
        "failed",
      ].includes(patch.status),
      "invalid_task",
      "The Task status is invalid.",
    );
    if (taskTerminal.has(patch.status)) {
      requireCondition(
        typeof patch.resultRef === "string" &&
          /^state\/tasks\/[0-9a-f]{64}\/result_[0-9a-f]{32}\.json$/.test(
            patch.resultRef,
          ),
        "invalid_task_result",
        "A terminal Task requires its already fixed local method-result snapshot.",
      );
    } else
      requireCondition(
        patch.resultRef === undefined && patch.error === undefined,
        "invalid_task_result",
        "A working Task cannot publish a terminal result.",
      );
    if (patch.status === "failed")
      requireCondition(
        patch.error &&
          Number.isSafeInteger(patch.error.code) &&
          typeof patch.error.message === "string" &&
          Buffer.byteLength(patch.error.message) <= 4096,
        "invalid_task_error",
        "A failed Task requires a bounded JSON-RPC error.",
      );
    else
      requireCondition(
        patch.error === undefined,
        "invalid_task_error",
        "Only a failed Task can carry a JSON-RPC error.",
      );
    return this.#transaction(() => {
      const previous = this.getTask(taskId, key, now);
      if (taskTerminal.has(previous.status)) return previous;
      if (previous.status === patch.status) return previous;
      this.#db
        .prepare(
          "UPDATE mcp_tasks SET status=?,result_ref=?,error_json=?,updated_at=? WHERE task_id=?",
        )
        .run(
          patch.status,
          patch.resultRef ?? null,
          patch.error ? canonicalJson(patch.error, 16384) : null,
          now,
          taskId,
        );
      return this.getTask(taskId, key, now);
    });
  }

  pinTaskRunArtifacts(
    runId: string,
    ids: readonly string[],
    now = Date.now(),
  ): void {
    requireCondition(
      ids.length <= 16384 && ids.every((id) => /^res_[0-9a-f]{32}$/.test(id)),
      "invalid_task_resource",
      "Task artifact references must be bounded local resource identities.",
    );
    if (!ids.length) return;
    this.#transaction(() => {
      const tasks = this.#db
        .prepare(
          "SELECT task_id FROM mcp_tasks WHERE run_id=? AND expires_at>?",
        )
        .all(runId, now);
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO task_artifacts(task_id,resource_id) VALUES(?,?)",
      );
      for (const task of tasks)
        for (const id of new Set(ids)) insert.run(task.task_id as string, id);
    });
  }

  taskArtifactRetentionUntil(
    id: string,
    originRunId: string | null,
    now = Date.now(),
    originalExpiresAt = 0,
  ): number {
    requireCondition(
      /^res_[0-9a-f]{32}$/.test(id),
      "invalid_task_resource",
      "The artifact identity is invalid.",
    );
    const row = this.#db
      .prepare(
        `SELECT max(t.expires_at) expires_at FROM mcp_tasks t
      WHERE t.expires_at>? AND ((t.run_id=? AND (?=0 OR t.created_at<?)) OR EXISTS
        (SELECT 1 FROM task_artifacts a WHERE a.task_id=t.task_id AND a.resource_id=?))`,
      )
      .get(now, originRunId, originalExpiresAt, originalExpiresAt, id);
    return typeof row?.expires_at === "number" ? row.expires_at : 0;
  }

  /** Coarse source protection is intentional: loss is preferable to guessing liveness. */
  activeRunIds(): ReadonlySet<string> {
    const rows = this.#db
      .prepare(
        `SELECT run_id FROM runs WHERE ended_at IS NULL
      UNION SELECT origin_run_id FROM managed_resources WHERE boot_id=? AND closed_at IS NULL AND status!='unavailable' AND origin_run_id IS NOT NULL
      UNION SELECT origin_run_id FROM operations WHERE ended_at IS NULL AND origin_run_id IS NOT NULL
      UNION SELECT origin_run_id FROM transfers WHERE ended_at IS NULL AND origin_run_id IS NOT NULL
      UNION SELECT json_extract(source_json,'$.replayRunId') FROM runs WHERE ended_at IS NULL AND json_type(source_json,'$.replayRunId')='text'`,
      )
      .all(this.bootId);
    return new Set(rows.map((row) => row.run_id as string));
  }

  workSnapshotRefs(now = Date.now()): ReadonlySet<string> {
    return new Set(
      this.#db
        .prepare(
          `SELECT snapshot_ref FROM work_contexts c
      WHERE (c.status='open' AND c.expires_at>?) OR EXISTS
        (SELECT 1 FROM runs r WHERE r.context_id=c.context_id AND r.ended_at IS NULL)`,
        )
        .all(now)
        .map((row) => row.snapshot_ref as string),
    );
  }

  protectedArtifactIds(now = Date.now()): ReadonlySet<string> {
    const ids = new Set(
      this.#db
        .prepare(
          `SELECT DISTINCT a.resource_id FROM task_artifacts a
      JOIN mcp_tasks t ON t.task_id=a.task_id WHERE t.expires_at>?`,
        )
        .all(now)
        .map((row) => row.resource_id as string),
    );
    const prefix = `nexum://agents/${encodeURIComponent(this.binding.agentId)}/resources/`;
    for (const row of this.#db
      .prepare(
        "SELECT json_extract(metadata_json,'$.target.resourceUri') uri FROM transfers WHERE ended_at IS NULL",
      )
      .all()) {
      const uri = row.uri;
      if (
        typeof uri === "string" &&
        uri.startsWith(prefix) &&
        /^res_[0-9a-f]{32}$/.test(uri.slice(prefix.length))
      )
        ids.add(uri.slice(prefix.length));
    }
    return ids;
  }

  completeInputsCleanup(runId: string, now = Date.now()): void {
    this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM runs WHERE run_id=?")
        .get(runId);
      if (!row) return;
      const run = decode<RunRecord>(row);
      requireCondition(
        run.endedAt !== null &&
          run.endedAt + 86400000 <= now &&
          !this.activeRunIds().has(runId),
        "cleanup_protected",
        "Temporary inputs are still protected by live work.",
      );
      this.#db
        .prepare(
          "UPDATE runs SET cleanup_json=json_set(cleanup_json,'$.temporaryInputsExpiredAt',?) WHERE run_id=?",
        )
        .run(now, runId);
    });
  }

  /** One bounded metadata transaction. File removal is deliberately outside SQLite. */
  cleanupBatch(options: { now?: number; limit?: number } = {}): CleanupBatch {
    const now = options.now ?? Date.now(),
      limit = options.limit ?? 100;
    requireCondition(
      Number.isSafeInteger(now) &&
        now >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      "invalid_cleanup",
      "A cleanup batch must use a valid clock and at most 100 records.",
    );
    return this.#transaction(() => {
      let processed = 0;
      const deleted: Record<string, number> = {},
        files: {
          kind: "run" | "log" | "task" | "process_log" | "inputs";
          ref: string;
        }[] = [];
      const remove = (
        table: string,
        key: string,
        where: string,
        parameters: SQLInputValue[] = [],
        file?: (row: Record<string, unknown>) => void,
      ) => {
        if (processed >= limit) return;
        const rows = this.#db
          .prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT ?`)
          .all(...parameters, limit - processed);
        const statement = this.#db.prepare(
          `DELETE FROM ${table} WHERE ${key}=?`,
        );
        for (const row of rows) {
          statement.run(row[key] as SQLInputValue);
          file?.(row);
          processed++;
          deleted[table] = (deleted[table] ?? 0) + 1;
        }
      };
      // Pins are small reference rows, but still count toward the same hard batch bound.
      if (processed < limit) {
        const rows = this.#db
          .prepare(
            "SELECT a.task_id,a.resource_id FROM task_artifacts a JOIN mcp_tasks t ON t.task_id=a.task_id WHERE t.expires_at<=? LIMIT ?",
          )
          .all(now, limit - processed);
        const statement = this.#db.prepare(
          "DELETE FROM task_artifacts WHERE task_id=? AND resource_id=?",
        );
        for (const row of rows) {
          statement.run(row.task_id as string, row.resource_id as string);
          processed++;
          deleted.task_artifacts = (deleted.task_artifacts ?? 0) + 1;
        }
      }
      remove(
        "mcp_tasks",
        "task_id",
        "expires_at<=? AND NOT EXISTS(SELECT 1 FROM task_artifacts a WHERE a.task_id=mcp_tasks.task_id)",
        [now],
        (row) => {
          if (typeof row.result_ref === "string")
            files.push({ kind: "task", ref: row.result_ref });
        },
      );
      // run_requests has a compound primary key; rowid is local to this transaction.
      if (processed < limit) {
        const rows = this.#db
          .prepare("SELECT rowid FROM run_requests WHERE expires_at<=? LIMIT ?")
          .all(now, limit - processed);
        for (const row of rows) {
          this.#db
            .prepare("DELETE FROM run_requests WHERE rowid=?")
            .run(row.rowid as number);
          processed++;
          deleted.run_requests = (deleted.run_requests ?? 0) + 1;
        }
      }
      remove("close_receipts", "context_id", "expires_at<=?", [now]);
      const historyBefore = now - 30 * 86400000;
      remove(
        "transfers",
        "transfer_id",
        "ended_at IS NOT NULL AND ended_at<=?",
        [historyBefore],
      );
      remove(
        "operations",
        "operation_id",
        "ended_at IS NOT NULL AND ended_at<=?",
        [historyBefore],
      );
      remove(
        "managed_resources",
        "resource_id",
        `NOT EXISTS(SELECT 1 FROM transfers t WHERE t.resource_id=managed_resources.resource_id)
        AND ((closed_at IS NOT NULL AND closed_at<=?) OR (status='unavailable' AND boot_id!=? AND
          json_type(diagnostic_json,'$.unavailableAt') IN ('integer','real') AND json_extract(diagnostic_json,'$.unavailableAt')<=?))
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.run_id=managed_resources.owner_run_id AND r.ended_at IS NULL)`,
        [historyBefore, this.bootId, historyBefore],
        (row) => {
          if (row.kind === "sh.process" && typeof row.resource_id === "string")
            files.push({
              kind: "process_log",
              ref: `logs/processes/${row.resource_id}.output`,
            });
        },
      );
      const eligible = `ended_at IS NOT NULL AND ended_at<=?
        AND NOT EXISTS(SELECT 1 FROM mcp_tasks t WHERE t.run_id=runs.run_id)
        AND NOT EXISTS(SELECT 1 FROM run_requests q WHERE q.run_id=runs.run_id)
        AND NOT EXISTS(SELECT 1 FROM managed_resources m WHERE m.owner_run_id=runs.run_id OR m.origin_run_id=runs.run_id)
        AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.origin_run_id=runs.run_id)
        AND NOT EXISTS(SELECT 1 FROM transfers t WHERE t.origin_run_id=runs.run_id)
        AND NOT EXISTS(SELECT 1 FROM runs live WHERE live.ended_at IS NULL AND json_extract(live.source_json,'$.replayRunId')=runs.run_id)`;
      remove(
        "run_waits",
        "wait_id",
        `status!='waiting' AND run_id IN(SELECT run_id FROM runs WHERE ${eligible})`,
        [historyBefore],
      );
      remove(
        "runs",
        "run_id",
        `${eligible} AND NOT EXISTS(SELECT 1 FROM run_waits w WHERE w.run_id=runs.run_id)`,
        [historyBefore],
        (row) => {
          files.push({ kind: "run", ref: `work/tmp/runs/${row.run_id}` });
          files.push({
            kind: "log",
            ref: `logs/runs/${row.run_id}/console.log`,
          });
        },
      );
      // Reading logs does not extend their independent seven-day retention.
      if (processed < limit) {
        const rows = this.#db
          .prepare(
            "SELECT run_id FROM runs WHERE ended_at IS NOT NULL AND ended_at<=? AND logs_ref IS NOT NULL LIMIT ?",
          )
          .all(now - 7 * 86400000, limit - processed);
        for (const row of rows) {
          this.#db
            .prepare("UPDATE runs SET logs_ref=NULL WHERE run_id=?")
            .run(row.run_id as string);
          files.push({
            kind: "log",
            ref: `logs/runs/${row.run_id}/console.log`,
          });
          processed++;
          deleted.logs = (deleted.logs ?? 0) + 1;
        }
      }
      if (processed < limit) {
        const rows = this.#db
          .prepare(
            `SELECT run_id FROM runs WHERE ended_at IS NOT NULL AND ended_at<=?
          AND json_type(cleanup_json,'$.temporaryInputsExpiredAt') IS NULL
          AND NOT EXISTS(SELECT 1 FROM managed_resources m WHERE m.origin_run_id=runs.run_id AND m.boot_id=? AND m.closed_at IS NULL AND m.status!='unavailable')
          AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.origin_run_id=runs.run_id AND o.ended_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM transfers t WHERE t.origin_run_id=runs.run_id AND t.ended_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM runs live WHERE live.ended_at IS NULL AND json_extract(live.source_json,'$.replayRunId')=runs.run_id) LIMIT ?`,
          )
          .all(now - 86400000, this.bootId, limit - processed);
        for (const row of rows) {
          files.push({
            kind: "inputs",
            ref: `work/tmp/runs/${row.run_id}/inputs`,
          });
          processed++;
          deleted.input_candidates = (deleted.input_candidates ?? 0) + 1;
        }
      }
      if (processed < limit) {
        const rows = this.#db
          .prepare(
            `SELECT resource_id FROM managed_resources WHERE kind='sh.process'
          AND json_type(diagnostic_json,'$.logsExpiredAt') IS NULL AND
          ((closed_at IS NOT NULL AND closed_at<=?) OR (status='unavailable' AND boot_id!=? AND
            json_type(diagnostic_json,'$.unavailableAt') IN ('integer','real') AND json_extract(diagnostic_json,'$.unavailableAt')<=?)) LIMIT ?`,
          )
          .all(
            now - 7 * 86400000,
            this.bootId,
            now - 7 * 86400000,
            limit - processed,
          );
        for (const row of rows) {
          this.#db
            .prepare(
              "UPDATE managed_resources SET diagnostic_json=json_set(diagnostic_json,'$.logsExpiredAt',?) WHERE resource_id=?",
            )
            .run(now, row.resource_id as string);
          files.push({
            kind: "process_log",
            ref: `logs/processes/${row.resource_id}.output`,
          });
          processed++;
          deleted.expired_process_logs =
            (deleted.expired_process_logs ?? 0) + 1;
        }
      }
      if (processed < limit) {
        const rows = this.#db
          .prepare(
            "SELECT context_id FROM work_contexts c WHERE status='open' AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.context_id=c.context_id AND r.ended_at IS NULL) LIMIT ?",
          )
          .all(now, limit - processed);
        for (const row of rows) {
          this.#db
            .prepare(
              "UPDATE work_contexts SET status='expired' WHERE context_id=?",
            )
            .run(row.context_id as string);
          processed++;
          deleted.expired_contexts = (deleted.expired_contexts ?? 0) + 1;
        }
      }
      return { processed, deleted, files };
    });
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

  getOperation(id: string): OperationRecord {
    return this.#get("operations", "operation_id", id, "operation_not_found");
  }

  startOperation(
    runId: string,
    origin: ContributionOrigin,
    method: string,
    now = Date.now(),
  ): OperationRecord {
    requireCondition(
      origin.namespace &&
        origin.owner &&
        origin.version &&
        origin.revision &&
        ["platform", "extension"].includes(origin.type) &&
        typeof method === "string" &&
        method.length > 0 &&
        Buffer.byteLength(method) <= 1024,
      "invalid_operation",
      "An SDK operation needs its actual source/version, namespace and method.",
    );
    const source = {
      origin: {
        type: origin.type,
        owner: origin.owner,
        namespace: origin.namespace,
        version: origin.version,
        revision: origin.revision,
      },
    };
    return this.#transaction(() => {
      const run = this.getRun(runId);
      requireCondition(
        run.bootId === this.bootId &&
          ["preparing_inputs", "running", "waiting_input"].includes(
            run.status,
          ) &&
          !run.stop,
        "run_stopping",
        "The run no longer admits managed operations.",
      );
      const id = newId("op");
      this.#db
        .prepare(
          `INSERT INTO operations(operation_id,origin_run_id,caller_key,boot_id,namespace,method,source_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'running',?,?)`,
        )
        .run(
          id,
          runId,
          run.callerKey,
          this.bootId,
          origin.namespace!,
          method,
          canonicalJson(source),
          now,
          now,
        );
      return this.getOperation(id);
    });
  }

  getMaintenanceOperation(requestId: string): OperationRecord | null {
    requireCondition(
      typeof requestId === "string" && maintenanceRequest.test(requestId),
      "invalid_maintenance_request",
      "The maintenance request identity is invalid.",
    );
    const row = this.#db
      .prepare("SELECT * FROM operations WHERE maintenance_request_id=?")
      .get(requestId);
    return row ? decode<OperationRecord>(row) : null;
  }

  /** Trusted approved execution admission; no package/network/filesystem effects run in this transaction. */
  startMaintenanceOperation(
    input: MaintenanceOperationInput,
    now = Date.now(),
  ): { operation: OperationRecord; duplicate: boolean } {
    requireCondition(
      typeof input.requestId === "string" &&
        maintenanceRequest.test(input.requestId) &&
        typeof input.approvedRevision === "string" &&
        /^[0-9a-f]{64}$/.test(input.approvedRevision) &&
        typeof input.callerKey === "string" &&
        input.callerKey.length > 0 &&
        input.callerKey.length <= 256 &&
        maintenanceMethods.has(input.method) &&
        (input.originRunId == null ||
          (typeof input.originRunId === "string" &&
            /^run_[0-9a-f]{32}$/.test(input.originRunId))) &&
        input.detailRef ===
          `state/maintenance/${input.requestId}/execution.json` &&
        Number.isSafeInteger(now) &&
        now >= 0,
      "invalid_maintenance_operation",
      "Maintenance execution needs its approved identity, action and fixed private detail reference.",
    );
    const source = JSON.parse(canonicalJson(input.source, 16384)) as JsonObject;
    const origin = source.origin;
    const safeText = (value: JsonValue | undefined): boolean =>
      typeof value === "string" && value.length > 0 && value.length <= 256;
    requireCondition(
      Object.keys(source).every((key) =>
        [
          "origin",
          "target",
          "name",
          "objectId",
          "baseRevision",
          "candidateRevision",
        ].includes(key),
      ) &&
        origin &&
        typeof origin === "object" &&
        !Array.isArray(origin) &&
        Object.keys(origin).length === 5 &&
        Object.keys(origin).every((key) =>
          ["type", "owner", "namespace", "version", "revision"].includes(key),
        ) &&
        origin.type === "platform" &&
        origin.namespace === "maintenance" &&
        safeText(origin.owner) &&
        safeText(origin.version) &&
        safeText(origin.revision) &&
        source.target ===
          (
            {
              packages: "package",
              extensions: "extension",
              mcp: "mcp",
              api: "api",
            } as Record<string, string>
          )[input.method.split(".")[0]!] &&
        safeText(source.name) &&
        (source.objectId === null || safeText(source.objectId)) &&
        (source.baseRevision === null || safeText(source.baseRevision)) &&
        source.candidateRevision === input.approvedRevision,
      "invalid_maintenance_operation",
      "Maintenance operation metadata must contain only its actual safe approved target and platform origin.",
    );
    return this.#transaction(() => {
      const previous = this.getMaintenanceOperation(input.requestId);
      if (previous) {
        requireCondition(
          previous.callerKey === input.callerKey &&
            previous.approvedRevision === input.approvedRevision &&
            previous.method === input.method &&
            canonicalJson(previous.source) === canonicalJson(source) &&
            previous.originRunId === (input.originRunId ?? null) &&
            previous.detailRef === input.detailRef,
          "maintenance_execution_conflict",
          "The request already belongs to another approved execution identity.",
        );
        return { operation: previous, duplicate: true };
      }
      if (input.originRunId) {
        const run = this.getRun(input.originRunId);
        requireCondition(
          run.callerKey === input.callerKey,
          "maintenance_execution_conflict",
          "The source run belongs to another caller.",
        );
      }
      const id = newId("op");
      this.#db
        .prepare(
          `INSERT INTO operations(operation_id,origin_run_id,caller_key,boot_id,namespace,method,source_json,maintenance_request_id,approved_revision,status,detail_ref,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?)`,
        )
        .run(
          id,
          input.originRunId ?? null,
          input.callerKey,
          this.bootId,
          "maintenance",
          input.method,
          canonicalJson(source, 16384),
          input.requestId,
          input.approvedRevision,
          input.detailRef,
          now,
          now,
        );
      return { operation: this.getOperation(id), duplicate: false };
    });
  }

  finishOperation(
    id: string,
    status: "succeeded" | "failed",
    error?: JsonObject,
    now = Date.now(),
  ): OperationRecord {
    requireCondition(
      ["succeeded", "failed"].includes(status) &&
        !(status === "succeeded" && error !== undefined),
      "invalid_operation_outcome",
      "An operation outcome must preserve its actual success or failure.",
    );
    return this.#transaction(() => {
      const operation = this.getOperation(id);
      requireCondition(
        operation.bootId === this.bootId &&
          operation.endedAt === null &&
          operation.status === "running",
        "operation_state_conflict",
        "Only an unsettled operation from this Agent boot may finish.",
      );
      this.#db
        .prepare(
          "UPDATE operations SET status=?,error_json=?,ended_at=?,updated_at=?,revision=revision+1 WHERE operation_id=? AND ended_at IS NULL",
        )
        .run(status, error ? canonicalJson(error) : null, now, now, id);
      return this.getOperation(id);
    });
  }

  operationsForRun(runId: string, limit = 64): OperationRecord[] {
    requireCondition(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
      "invalid_limit",
      "An operation query needs a bounded limit.",
    );
    return this.#db
      .prepare(
        "SELECT * FROM operations WHERE origin_run_id=? ORDER BY created_at DESC,operation_id DESC LIMIT ?",
      )
      .all(runId, limit)
      .map((row) => decode<OperationRecord>(row));
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
      if (input.projectId)
        requireCondition(
          !this.#db
            .prepare(
              "SELECT 1 FROM close_receipts WHERE project_id=? AND expires_at>? LIMIT 1",
            )
            .get(input.projectId, now),
          "project_closed",
          "This project was closed; resolve a new catalog identity before opening work.",
        );
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

  #matchingSubmission(
    callerKey: string,
    requestId: string,
    intentDigest: string,
  ): RunRecord | null {
    const previous = this.#db
      .prepare("SELECT * FROM run_requests WHERE caller_key=? AND request_id=?")
      .get(callerKey, requestId);
    if (!previous) return null;
    requireCondition(
      previous.intent_digest === intentDigest,
      "submission_conflict",
      "The submission identifier belongs to a different intent.",
    );
    try {
      return this.getRun(previous.run_id as string);
    } catch (cause) {
      throw new AgentError(
        "submission_unknown",
        "The original accepted run is unavailable.",
        undefined,
        { cause },
      );
    }
  }

  /** Read before any current-source inspection; acceptRun rechecks atomically. */
  findMatchingSubmission(
    callerKey: string,
    requestId: string,
    intentDigest: string,
    now = Date.now(),
  ): RunRecord | null {
    requireCondition(
      !this.#closed,
      "storage_closed",
      "The local store is closed.",
    );
    requestWindow(requestId, now);
    requireCondition(
      typeof intentDigest === "string" && intentDigest.length > 0,
      "invalid_submission",
      "A submission requires its fixed intent digest.",
    );
    return this.#matchingSubmission(callerKey, requestId, intentDigest);
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
        const previous = this.#matchingSubmission(
          input.callerKey,
          input.requestId,
          input.intentDigest!,
        );
        if (previous) return { run: previous, duplicate: true };
      }
      const work = this.#activeWork(input.contextId, input.callerKey, now);
      const capacity = input.capacity ?? 256;
      const controlCapacity = input.controlCapacity ?? DEFAULT_CONTROL_CAPACITY;
      requireCondition(
        Number.isSafeInteger(capacity) &&
          capacity > 0 &&
          Number.isSafeInteger(controlCapacity) &&
          controlCapacity >= 0 &&
          (input.controlEligible === undefined ||
            typeof input.controlEligible === "boolean") &&
          (!input.controlEligible ||
            (input.sourceKind === "script" &&
              typeof input.scriptName === "string")),
        "invalid_capacity",
        "The configured run capacity is invalid.",
      );
      const active = this.#db
        .prepare(
          `SELECT
        count(*) FILTER (WHERE admission_class='ordinary') ordinary,
        count(*) FILTER (WHERE admission_class='control') control
        FROM runs WHERE ended_at IS NULL`,
        )
        .get() as { ordinary: number; control: number };
      const admissionClass: AdmissionClass =
        active.ordinary < capacity ? "ordinary" : "control";
      requireCondition(
        admissionClass === "ordinary" ||
          (input.controlEligible && active.control < controlCapacity),
        "runtime_busy",
        "The Agent has no free run slot for this submission.",
        {
          ordinaryCapacity: capacity,
          controlCapacity,
          ordinaryActive: active.ordinary,
          controlActive: active.control,
        },
      );
      const runId = newId("run");
      this.#db
        .prepare(
          `INSERT INTO runs(run_id,caller_key,context_id,project_id,boot_id,status,source_kind,script_name,
        source_json,accepted_at,deadline_at,updated_at,admission_class) VALUES(?,?,?,?,?,'accepted',?,?,?,?,?,?,?)`,
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
          admissionClass,
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
    try {
      return this.getRun(row.run_id as string);
    } catch (cause) {
      if (!isAgentError(cause) || cause.code !== "run_not_found") throw cause;
      throw new AgentError(
        "submission_unknown",
        "The original accepted run is unavailable.",
        undefined,
        { cause },
      );
    }
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
              "SELECT 1 FROM operations WHERE origin_run_id=? AND maintenance_request_id IS NULL AND ended_at IS NULL LIMIT 1",
            )
            .get(id),
          "run_operations_pending",
          "Managed operations have not actually settled.",
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
          ["preparing_inputs", "running", "waiting_input"].includes(
            run.status,
          ) && !run.stop,
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
      requireCondition(
        !this.#db
          .prepare("SELECT 1 FROM transfers WHERE resource_id=?")
          .get(resourceId),
        "transfer_handoff_required",
        "A transfer must publish pending and hand off through its fixed domain command.",
      );
      return this.#handoffResource(resourceId, runId, revision, now);
    });
  }

  /** Shared fixed SQL, called only from an existing transaction. */
  #handoffResource(
    resourceId: string,
    runId: string,
    revision: number,
    now: number,
  ): ResourceRecord {
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
      (run.status === "running" || run.status === "waiting_input") && !run.stop,
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
  }

  #transferOwner(scope: TransferOwner): void {
    requireCondition(
      scope &&
        typeof scope.callerKey === "string" &&
        scope.callerKey.length > 0 &&
        scope.owner &&
        ["platform", "extension"].includes(scope.owner.type) &&
        typeof scope.owner.owner === "string" &&
        scope.owner.owner.length > 0 &&
        typeof scope.owner.namespace === "string" &&
        scope.owner.namespace.length > 0,
      "invalid_transfer_owner",
      "Transfers require a verified caller and fixed Core source binding.",
    );
  }

  #transferMetadata(value: TransferMetadata): TransferMetadata {
    const data = JSON.parse(
      canonicalJson(value, 64 * 1024),
    ) as TransferMetadata;
    requireCondition(
      isPlainRecord(data) &&
        Object.keys(data).every((key) =>
          [
            "target",
            "origin",
            "maxBytes",
            "startedAt",
            "fileCommitted",
            "file",
            "cleanupConfirmed",
            "stop",
            "error",
            "outcome",
          ].includes(key),
        ) &&
        isPlainRecord(data.target) &&
        Object.keys(data.target).every((key) =>
          [
            "path",
            "resourceUri",
            "name",
            "mimeType",
            "size",
            "sha256",
            "expectedSize",
            "expectedSha256",
          ].includes(key),
        ),
      "invalid_transfer_metadata",
      "Transfer history accepts fixed safe target and outcome fields, never request URLs or credentials.",
    );
    const target = data.target;
    requireCondition(
      (data.maxBytes === undefined ||
        data.maxBytes === null ||
        (typeof data.maxBytes === "number" &&
          Number.isSafeInteger(data.maxBytes) &&
          data.maxBytes > 0)) &&
        (data.startedAt === undefined ||
          data.startedAt === null ||
          (typeof data.startedAt === "number" &&
            Number.isSafeInteger(data.startedAt) &&
            data.startedAt >= 0)),
      "invalid_transfer_metadata",
      "A transfer keeps only its fixed accepted budget and actual claim time.",
    );
    if (data.origin !== undefined && data.origin !== null) {
      const origin = data.origin;
      requireCondition(
        isPlainRecord(origin) &&
          Object.keys(origin).length === 2 &&
          typeof origin.contextId === "string" &&
          origin.contextId.length > 0 &&
          origin.contextId.length <= 256 &&
          (origin.projectId === null ||
            (typeof origin.projectId === "string" &&
              origin.projectId.length > 0 &&
              origin.projectId.length <= 256)),
        "invalid_transfer_origin",
        "The retained creator association must contain only its actual context and project identities.",
      );
    }
    for (const field of ["path", "name", "mimeType", "resourceUri"] as const)
      requireCondition(
        target[field] === undefined ||
          (typeof target[field] === "string" &&
            target[field]!.length > 0 &&
            !target[field]!.includes("\0")),
        "invalid_transfer_metadata",
        "Transfer target text is invalid.",
      );
    requireCondition(
      (target.path === undefined ||
        (typeof target.path === "string" && path.isAbsolute(target.path))) &&
        (target.resourceUri === undefined ||
          (typeof target.resourceUri === "string" &&
            /^nexum:\/\/agents\/[^/]+\/resources\/res_[0-9a-f]{32}$/.test(
              target.resourceUri,
            ))),
      "invalid_transfer_metadata",
      "Any confirmed target must be a canonical local path or registered Nexum resource coordinate.",
    );
    for (const field of ["size", "expectedSize"] as const)
      requireCondition(
        target[field] === undefined ||
          (typeof target[field] === "number" &&
            Number.isSafeInteger(target[field]) &&
            target[field]! >= 0),
        "invalid_transfer_metadata",
        "Transfer sizes must be non-negative safe byte counts.",
      );
    for (const field of ["sha256", "expectedSha256"] as const)
      requireCondition(
        target[field] === undefined ||
          (typeof target[field] === "string" &&
            /^[0-9a-f]{64}$/.test(target[field]!)),
        "invalid_transfer_metadata",
        "Transfer checksums must be actual SHA-256 hex values.",
      );
    for (const field of ["fileCommitted", "cleanupConfirmed"] as const)
      requireCondition(
        data[field] === undefined || typeof data[field] === "boolean",
        "invalid_transfer_metadata",
        "Transfer cleanup and publication facts must be boolean.",
      );
    if (data.file !== undefined) {
      const file = data.file;
      requireCondition(
        isPlainRecord(file) &&
          Object.keys(file).length === 6 &&
          ["path", "name", "size", "mimeType", "sha256", "revision"].every(
            (key) => Object.hasOwn(file, key),
          ) &&
          typeof file.path === "string" &&
          path.isAbsolute(file.path) &&
          file.path === target.path &&
          typeof file.name === "string" &&
          file.name === path.basename(file.path) &&
          typeof file.size === "number" &&
          Number.isSafeInteger(file.size) &&
          file.size >= 0 &&
          typeof file.mimeType === "string" &&
          file.mimeType.length > 0 &&
          !file.mimeType.includes("\0") &&
          typeof file.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(file.sha256) &&
          typeof file.revision === "string" &&
          /^[0-9a-f]{64}$/.test(file.revision),
        "invalid_transfer_file",
        "The upload receipt must retain its actual safe file facts and target.",
      );
      try {
        new MIMEType(file.mimeType);
      } catch {
        throw new AgentError(
          "invalid_transfer_file",
          "The upload receipt MIME type is invalid.",
        );
      }
    }
    if (data.stop !== undefined) this.#transferStop(data.stop);
    if (data.error !== undefined) {
      requireCondition(
        isPlainRecord(data.error) &&
          Object.keys(data.error).every((key) =>
            ["code", "message", "details"].includes(key),
          ) &&
          typeof data.error.code === "string" &&
          data.error.code.length > 0 &&
          data.error.code.length <= 256 &&
          typeof data.error.message === "string" &&
          data.error.message.length <= 4096 &&
          (data.error.details === undefined ||
            isPlainRecord(data.error.details)),
        "invalid_transfer_metadata",
        "Transfer failures must be safe error data.",
      );
      canonicalJson(data.error, 12 * 1024);
    }
    requireCondition(
      data.outcome === undefined ||
        ["succeeded", "failed", "cancelled", "expired"].includes(data.outcome),
      "invalid_transfer_metadata",
      "The retained transfer outcome is invalid.",
    );
    return data;
  }

  #transferStop(reason: TransferStop): void {
    requireCondition(
      isPlainRecord(reason) &&
        Object.keys(reason).every((key) => ["kind", "code"].includes(key)) &&
        ["cancel", "expired", "timeout", "permission", "failure"].includes(
          reason.kind,
        ) &&
        typeof reason.code === "string" &&
        reason.code.length > 0 &&
        reason.code.length <= 256,
      "invalid_transfer_stop",
      "A transfer stop needs a fixed reason and safe code.",
    );
  }

  getTransfer(id: string, scope: TransferOwner): TransferRecord {
    this.#transferOwner(scope);
    requireCondition(
      typeof id === "string" && /^tr_[0-9a-f]{32}$/.test(id),
      "invalid_transfer_id",
      "A transfer needs its retained identity.",
    );
    const row = this.#get<TransferRecord>(
      "transfers",
      "transfer_id",
      id,
      "transfer_not_found",
    );
    const resource = this.getResource(row.resourceId);
    requireCondition(
      row.callerKey === scope.callerKey &&
        resource.callerKey === row.callerKey &&
        resource.originRunId === row.originRunId &&
        resource.source.type === scope.owner.type &&
        resource.source.owner === scope.owner.owner &&
        resource.source.namespace === scope.owner.namespace,
      "transfer_not_found",
      "The transfer does not belong to this caller and Core source.",
    );
    return this.#transferOrigin(row);
  }

  #transferOrigin(row: TransferRecord): TransferRecord {
    // Old records remain explicitly unknown; never infer history from a new run/project.
    return {
      ...row,
      metadata: {
        ...row.metadata,
        origin: row.metadata.origin ?? null,
        maxBytes: row.metadata.maxBytes ?? null,
        startedAt: row.metadata.startedAt ?? null,
      },
    };
  }

  #currentTransfer(
    id: string,
    scope: TransferOwner,
    revision: number,
  ): TransferRecord {
    const row = this.getTransfer(id, scope),
      resource = this.getResource(row.resourceId);
    requireCondition(
      Number.isSafeInteger(revision) &&
        revision > 0 &&
        row.revision === revision &&
        row.endedAt === null &&
        resource.bootId === this.bootId,
      "transfer_state_conflict",
      "The transfer changed or its original live control is unavailable.",
    );
    return row;
  }

  createTransfer(
    scope: TransferOwner,
    input: {
      resourceId: string;
      runId: string;
      direction: "upload" | "download";
      maxBytes: number;
      metadata: TransferMetadata;
    },
    now = Date.now(),
  ): TransferRecord {
    this.#transferOwner(scope);
    const metadata = this.#transferMetadata(input.metadata);
    requireCondition(
      ["upload", "download"].includes(input.direction) &&
        Object.keys(metadata).every((key) => key === "target") &&
        Number.isSafeInteger(input.maxBytes) &&
        input.maxBytes > 0,
      "invalid_transfer",
      "A new transfer has only its accepted target, not a fabricated outcome.",
    );
    requireCondition(
      (metadata.target.size === undefined ||
        metadata.target.size <= input.maxBytes) &&
        (metadata.target.expectedSize === undefined ||
          metadata.target.expectedSize <= input.maxBytes),
      "resource_exhausted",
      "The target exceeds the accepted transfer payload budget.",
    );
    return this.#transaction(() => {
      const resource = this.getResource(input.resourceId),
        run = this.getRun(input.runId);
      requireCondition(
        resource.bootId === this.bootId &&
          run.bootId === this.bootId &&
          resource.callerKey === scope.callerKey &&
          run.callerKey === scope.callerKey &&
          resource.source.type === scope.owner.type &&
          resource.source.owner === scope.owner.owner &&
          resource.source.namespace === scope.owner.namespace &&
          resource.originRunId === input.runId &&
          resource.ownerRunId === input.runId &&
          resource.lifetime === "run" &&
          resource.closedAt === null &&
          ["preparing_inputs", "running", "waiting_input"].includes(
            run.status,
          ) &&
          !run.stop,
        "transfer_state_conflict",
        "A transfer must originate from the verified live run and its registered resource.",
      );
      const id = newId("tr");
      const captured = this.#transferMetadata({
        ...metadata,
        origin: { contextId: run.contextId, projectId: run.projectId },
        maxBytes: input.maxBytes,
        startedAt: null,
      });
      this.#db
        .prepare(
          `INSERT INTO transfers(transfer_id,resource_id,caller_key,origin_run_id,direction,status,metadata_json,created_at)
        VALUES(?,?,?,?,?,'preparing',?,?)`,
        )
        .run(
          id,
          input.resourceId,
          scope.callerKey,
          input.runId,
          input.direction,
          canonicalJson(captured),
          now,
        );
      return this.getTransfer(id, scope);
    });
  }

  publishTransferPending(
    id: string,
    scope: TransferOwner,
    input: {
      revision: number;
      resourceRevision: number;
      claimDeadlineAt: number;
      metadata?: TransferMetadata;
    },
    now = Date.now(),
  ): PublishedTransfer {
    requireCondition(
      Number.isSafeInteger(input.claimDeadlineAt) &&
        input.claimDeadlineAt > now,
      "invalid_transfer_deadline",
      "A pending offer needs its actual future claim deadline.",
    );
    return this.#transaction(() => {
      const row = this.#currentTransfer(id, scope, input.revision);
      requireCondition(
        row.status === "preparing" && row.originRunId,
        "transfer_state_conflict",
        "Only the original preparing transfer can publish an offer.",
      );
      const supplied = input.metadata
        ? this.#transferMetadata(input.metadata)
        : row.metadata;
      requireCondition(
        supplied.origin === undefined ||
          canonicalJson(supplied.origin) ===
            canonicalJson(row.metadata.origin ?? null),
        "invalid_transfer_origin",
        "Publishing an offer cannot replace its original creator association.",
      );
      const metadata = this.#transferMetadata({
        ...supplied,
        origin: row.metadata.origin ?? null,
        maxBytes: row.metadata.maxBytes ?? null,
        startedAt: row.metadata.startedAt ?? null,
      });
      const unchangedTarget = Object.entries(row.metadata.target).every(
        ([field, value]) =>
          metadata.target[field as keyof TransferMetadata["target"]] === value,
      );
      requireCondition(
        (supplied.maxBytes === undefined ||
          supplied.maxBytes === row.metadata.maxBytes) &&
          (supplied.startedAt === undefined ||
            supplied.startedAt === row.metadata.startedAt),
        "invalid_transfer_metadata",
        "Publishing an offer cannot change its accepted budget or actual claim time.",
      );
      requireCondition(
        Object.keys(metadata).every((key) =>
          ["target", "origin", "maxBytes", "startedAt"].includes(key),
        ) &&
          unchangedTarget &&
          (row.direction === "upload"
            ? metadata.target.path !== undefined &&
              (row.metadata.target.path === undefined ||
                metadata.target.path === row.metadata.target.path)
            : metadata.target.resourceUri !== undefined &&
              metadata.target.size !== undefined &&
              metadata.target.sha256 !== undefined),
        "invalid_transfer_metadata",
        "A pending download must reference its actual fixed artifact.",
      );
      requireCondition(
        typeof metadata.maxBytes === "number" &&
          (metadata.target.size === undefined ||
            metadata.target.size <= metadata.maxBytes) &&
          (metadata.target.expectedSize === undefined ||
            metadata.target.expectedSize <= metadata.maxBytes),
        "resource_exhausted",
        "The prepared target exceeds the originally accepted payload budget.",
      );
      const resource = this.#handoffResource(
        row.resourceId,
        row.originRunId,
        input.resourceRevision,
        now,
      );
      this.#db
        .prepare(
          `UPDATE transfers SET status='pending',claim_deadline_at=?,metadata_json=?,revision=revision+1
        WHERE transfer_id=? AND revision=?`,
        )
        .run(
          input.claimDeadlineAt,
          canonicalJson(metadata),
          id,
          input.revision,
        );
      return { transfer: this.getTransfer(id, scope), resource };
    });
  }

  claimTransfer(
    id: string,
    scope: TransferOwner,
    input: { revision: number; transferDeadlineAt: number },
    now = Date.now(),
  ): TransferRecord {
    requireCondition(
      Number.isSafeInteger(input.transferDeadlineAt) &&
        input.transferDeadlineAt > now,
      "invalid_transfer_deadline",
      "A claimed stream needs its actual future transfer deadline.",
    );
    return this.#transaction(() => {
      const row = this.#currentTransfer(id, scope, input.revision),
        resource = this.getResource(row.resourceId);
      requireCondition(
        row.status === "pending" &&
          row.claimDeadlineAt !== null &&
          now < row.claimDeadlineAt,
        "transfer_not_claimable",
        "The offer is not pending or its claim deadline passed; do not reuse its URL.",
      );
      requireCondition(
        resource.lifetime === "background" &&
          resource.closedAt === null &&
          !["stopping", "unconfirmed", "unavailable"].includes(resource.status),
        "resource_unavailable",
        "The actual transfer resource cannot start a new stream.",
      );
      requireCondition(
        typeof row.metadata.maxBytes === "number" &&
          row.metadata.maxBytes > 0 &&
          row.metadata.startedAt === null,
        "transfer_state_conflict",
        "A new claim needs its original accepted budget and no prior claim time.",
      );
      const metadata = this.#transferMetadata({
        ...row.metadata,
        startedAt: now,
      });
      this.#db
        .prepare(
          `UPDATE transfers SET status='transferring',transfer_deadline_at=?,metadata_json=?,revision=revision+1
        WHERE transfer_id=? AND revision=?`,
        )
        .run(
          input.transferDeadlineAt,
          canonicalJson(metadata),
          id,
          input.revision,
        );
      return this.getTransfer(id, scope);
    });
  }

  #transferResultRef(value: string): void {
    requireCondition(
      typeof value === "string" &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 8192 &&
        !value.includes("\0") &&
        (!/^[a-z][a-z0-9+.-]*:/i.test(value) ||
          /^[a-z]:[\\/]/i.test(value) ||
          /^nexum:\/\/agents\/[^/]+\/resources\/res_[0-9a-f]{32}$/.test(value)),
      "invalid_transfer_result",
      "A result reference is a retained local coordinate, never a request URL or token.",
    );
  }

  #transferFileFacts(
    row: TransferRecord,
    metadata: TransferMetadata,
    bytes: number,
  ): void {
    if (metadata.fileCommitted === true || metadata.file !== undefined) {
      requireCondition(
        row.direction === "upload" &&
          row.transferDeadlineAt !== null &&
          metadata.fileCommitted === true &&
          (metadata.target.expectedSize === undefined ||
            metadata.target.expectedSize === bytes) &&
          (metadata.file === undefined ||
            (metadata.file.size === bytes &&
              (metadata.target.expectedSha256 === undefined ||
                metadata.target.expectedSha256 === metadata.file.sha256))),
        "invalid_transfer_file",
        "Committed upload facts and any confirmed file receipt must match the actual stream.",
      );
    }
    requireCondition(
      row.metadata.file === undefined ||
        canonicalJson(row.metadata.file) === canonicalJson(metadata.file),
      "transfer_state_conflict",
      "A committed upload receipt cannot be replaced or withdrawn.",
    );
  }

  progressTransfer(
    id: string,
    scope: TransferOwner,
    input: TransferProgress,
    now = Date.now(),
  ): TransferRecord {
    requireCondition(
      Number.isSafeInteger(input.bytesTransferred) &&
        input.bytesTransferred >= 0 &&
        (input.fileCommitted === undefined ||
          typeof input.fileCommitted === "boolean"),
      "invalid_transfer_progress",
      "Progress is an actual non-negative byte count and publication fact.",
    );
    if (input.resultRef !== undefined) this.#transferResultRef(input.resultRef);
    return this.#transaction(() => {
      const row = this.#currentTransfer(id, scope, input.revision);
      requireCondition(
        typeof row.metadata.maxBytes === "number" &&
          input.bytesTransferred <= row.metadata.maxBytes,
        "resource_exhausted",
        "Actual transfer bytes exceed the originally accepted payload budget.",
      );
      requireCondition(
        input.bytesTransferred >= row.bytesTransferred &&
          (input.bytesTransferred === row.bytesTransferred ||
            (row.transferDeadlineAt !== null &&
              ["transferring", "cancelling"].includes(row.status))) &&
          (input.resultRef === undefined ||
            row.resultRef === null ||
            row.resultRef === input.resultRef),
        "transfer_state_conflict",
        "Actual progress and a committed result cannot be rolled back or replaced.",
      );
      const metadata = this.#transferMetadata({
        ...row.metadata,
        ...(input.fileCommitted === undefined
          ? {}
          : {
              fileCommitted:
                row.metadata.fileCommitted === true || input.fileCommitted,
            }),
        ...(input.file === undefined ? {} : { file: input.file }),
      });
      this.#transferFileFacts(row, metadata, input.bytesTransferred);
      this.#db
        .prepare(
          `UPDATE transfers SET bytes_transferred=?,metadata_json=?,result_ref=COALESCE(?,result_ref),revision=revision+1
        WHERE transfer_id=? AND revision=?`,
        )
        .run(
          input.bytesTransferred,
          canonicalJson(metadata),
          input.resultRef ?? null,
          id,
          input.revision,
        );
      return this.getTransfer(id, scope);
    });
  }

  requestTransferCancel(
    id: string,
    scope: TransferOwner,
    input: { revision: number; reason: TransferStop },
    now = Date.now(),
  ): { accepted: boolean; transfer: TransferRecord } {
    this.#transferStop(input.reason);
    return this.#transaction(() => {
      const previous = this.getTransfer(id, scope);
      if (previous.endedAt !== null)
        return { accepted: false, transfer: previous };
      if (previous.status === "cancelling")
        return {
          accepted: previous.metadata.stop?.kind === input.reason.kind,
          transfer: previous,
        };
      const row = this.#currentTransfer(id, scope, input.revision);
      requireCondition(
        (input.reason.kind !== "expired" ||
          (row.status === "pending" &&
            row.claimDeadlineAt !== null &&
            now >= row.claimDeadlineAt)) &&
          (input.reason.kind !== "timeout" ||
            (row.status === "transferring" &&
              row.transferDeadlineAt !== null &&
              now >= row.transferDeadlineAt)),
        "transfer_state_conflict",
        "A deadline stop requires the corresponding actual phase and elapsed deadline.",
      );
      const metadata = this.#transferMetadata({
        ...row.metadata,
        stop: row.metadata.stop ?? input.reason,
      });
      this.#db
        .prepare(
          `UPDATE transfers SET status='cancelling',metadata_json=?,revision=revision+1
        WHERE transfer_id=? AND revision=?`,
        )
        .run(canonicalJson(metadata), id, input.revision);
      return { accepted: true, transfer: this.getTransfer(id, scope) };
    });
  }

  finishTransfer(
    id: string,
    scope: TransferOwner,
    input: TransferFinish,
    now = Date.now(),
  ): TransferRecord {
    requireCondition(
      ["succeeded", "failed", "cancelled", "expired"].includes(input.status) &&
        typeof input.cleanupConfirmed === "boolean" &&
        (input.fileCommitted === undefined ||
          typeof input.fileCommitted === "boolean"),
      "invalid_transfer_outcome",
      "Only actual I/O and cleanup facts can settle a transfer.",
    );
    if (input.resultRef !== undefined) this.#transferResultRef(input.resultRef);
    return this.#transaction(() => {
      const row = this.#currentTransfer(id, scope, input.revision),
        resource = this.getResource(row.resourceId);
      requireCondition(
        input.resultRef === undefined ||
          row.resultRef === null ||
          row.resultRef === input.resultRef,
        "transfer_state_conflict",
        "A committed transfer result cannot be replaced.",
      );
      requireCondition(
        (input.status !== "succeeded" ||
          (["transferring", "cancelling"].includes(row.status) &&
            row.transferDeadlineAt !== null &&
            (row.direction === "upload"
              ? (row.metadata.fileCommitted === true ||
                  input.fileCommitted === true) &&
                (row.metadata.file !== undefined || input.file !== undefined)
              : row.metadata.target.size === row.bytesTransferred))) &&
          (input.status !== "cancelled" ||
            row.metadata.stop?.kind === "cancel") &&
          (input.status !== "expired" || row.metadata.stop?.kind === "expired"),
        "invalid_transfer_outcome",
        "The final outcome must match the actual stream or accepted stop.",
      );
      const confirmed = input.cleanupConfirmed && resource.closedAt !== null;
      const metadata = this.#transferMetadata({
        ...row.metadata,
        fileCommitted:
          row.metadata.fileCommitted === true || input.fileCommitted === true,
        ...(input.file === undefined ? {} : { file: input.file }),
        cleanupConfirmed: confirmed,
        outcome: input.status,
        ...(input.error === undefined ? {} : { error: input.error }),
      });
      this.#transferFileFacts(row, metadata, row.bytesTransferred);
      this.#db
        .prepare(
          `UPDATE transfers SET status=?,ended_at=?,metadata_json=?,result_ref=COALESCE(?,result_ref),revision=revision+1
        WHERE transfer_id=? AND revision=?`,
        )
        .run(
          confirmed ? input.status : row.status,
          confirmed ? now : null,
          canonicalJson(metadata),
          input.resultRef ?? null,
          id,
          input.revision,
        );
      return this.getTransfer(id, scope);
    });
  }

  scanTransfers(
    scope: TransferOwner,
    filter: TransferFilter = {},
    limit = 100,
    cursor?: string,
  ): TransferScan {
    this.#transferOwner(scope);
    requireCondition(
      Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 1000 &&
        isPlainRecord(filter) &&
        Object.keys(filter).every((key) =>
          ["direction", "status", "runId"].includes(key),
        ),
      "invalid_transfer_query",
      "Transfer history needs bounded known equality filters.",
    );
    const statuses = [
      "preparing",
      "pending",
      "transferring",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
      "interrupted",
    ];
    requireCondition(
      (filter.direction === undefined ||
        (typeof filter.direction === "string" &&
          ["upload", "download"].includes(filter.direction))) &&
        (filter.status === undefined ||
          (typeof filter.status === "string" &&
            statuses.includes(filter.status))) &&
        (filter.runId === undefined ||
          (typeof filter.runId === "string" &&
            filter.runId.length > 0 &&
            filter.runId.length <= 256)),
      "invalid_transfer_query",
      "The transfer history filter is invalid.",
    );
    const query = digest({
      mode: "transfers",
      binding: this.binding,
      scope,
      filter: Object.fromEntries(
        Object.entries(filter).filter(([, value]) => value !== undefined),
      ),
    });
    const where = [
      "t.caller_key=?",
      "json_extract(m.source_json,'$.type')=?",
      "json_extract(m.source_json,'$.owner')=?",
      "json_extract(m.source_json,'$.namespace')=?",
    ];
    const values: SQLInputValue[] = [
      scope.callerKey,
      scope.owner.type,
      scope.owner.owner,
      scope.owner.namespace!,
    ];
    for (const [field, column] of [
      ["direction", "t.direction"],
      ["status", "t.status"],
      ["runId", "t.origin_run_id"],
    ] as const)
      if (typeof filter[field] === "string") {
        where.push(`${column}=?`);
        values.push(filter[field]!);
      }
    if (cursor !== undefined) {
      try {
        requireCondition(
          typeof cursor === "string" &&
            cursor.length > 0 &&
            cursor.length <= 4096 &&
            /^[A-Za-z0-9_-]+$/.test(cursor),
          "invalid_cursor",
          "The transfer history cursor is invalid.",
        );
        const envelope = Buffer.from(cursor, "base64url");
        requireCondition(
          envelope.length > 28,
          "invalid_cursor",
          "The transfer cursor has no authenticated position.",
        );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          this.#cursorKey,
          envelope.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(query));
        decipher.setAuthTag(envelope.subarray(-16));
        const position = JSON.parse(
          Buffer.concat([
            decipher.update(envelope.subarray(12, -16)),
            decipher.final(),
          ]).toString("utf8"),
        ) as { time: number; id: string };
        requireCondition(
          Number.isSafeInteger(position.time) &&
            position.time >= 0 &&
            typeof position.id === "string" &&
            /^tr_[0-9a-f]{32}$/.test(position.id),
          "invalid_cursor",
          "The transfer cursor belongs to another caller or filter.",
        );
        where.push("(t.created_at<? OR (t.created_at=? AND t.transfer_id<?))");
        values.push(position.time, position.time, position.id);
      } catch (cause) {
        throw new AgentError(
          "invalid_cursor",
          "The transfer history cursor is invalid or no longer current.",
          undefined,
          { cause },
        );
      }
    }
    const rows = this.#db
      .prepare(
        `SELECT t.* FROM transfers t JOIN managed_resources m ON m.resource_id=t.resource_id
      WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC,t.transfer_id DESC LIMIT ?`,
      )
      .all(...values, limit + 1);
    return {
      more: rows.length > limit,
      items: rows.slice(0, limit).map((raw) => {
        const record = this.#transferOrigin(decode<TransferRecord>(raw));
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", this.#cursorKey, iv);
        cipher.setAAD(Buffer.from(query));
        const ciphertext = Buffer.concat([
          cipher.update(
            JSON.stringify({ time: record.createdAt, id: record.transferId }),
          ),
          cipher.final(),
        ]);
        return {
          record,
          cursor: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
            "base64url",
          ),
        };
      }),
    };
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

  resourceDiagnostic(
    id: string,
    status: string,
    diagnostic: JsonObject,
  ): ResourceRecord {
    requireCondition(
      ["registered", "stopping", "unconfirmed"].includes(status),
      "invalid_resource_diagnostic",
      "Diagnostic updates cannot assert physical closure.",
    );
    return this.#transaction(() => {
      const resource = this.getResource(id);
      requireCondition(
        resource.bootId === this.bootId,
        "resource_unavailable",
        "The old Agent resource cannot be controlled.",
      );
      if (resource.closedAt !== null) return resource;
      this.#db
        .prepare(
          "UPDATE managed_resources SET status=?,diagnostic_json=?,revision=revision+1 WHERE resource_id=? AND closed_at IS NULL",
        )
        .run(status, canonicalJson(diagnostic), id);
      return this.getResource(id);
    });
  }

  saveCleanup(id: string, cleanup: JsonObject, now = Date.now()): RunRecord {
    return this.#transaction(() => {
      const run = this.getRun(id);
      requireCondition(
        run.bootId === this.bootId && run.endedAt === null,
        "run_state_conflict",
        "Only a live run can update its unfinished cleanup facts.",
      );
      this.#db
        .prepare(
          "UPDATE runs SET cleanup_json=?,revision=revision+1,updated_at=? WHERE run_id=? AND ended_at IS NULL",
        )
        .run(canonicalJson(cleanup), now, id);
      return this.getRun(id);
    });
  }

  resourcesForRun(runId: string, limit?: number): ResourceRecord[] {
    requireCondition(
      limit === undefined ||
        (Number.isSafeInteger(limit) && limit > 0 && limit <= 1000),
      "invalid_limit",
      "A resource summary needs a bounded limit.",
    );
    return this.#db
      .prepare(
        limit === undefined
          ? "SELECT * FROM managed_resources WHERE origin_run_id=? ORDER BY created_at,resource_id"
          : "SELECT * FROM managed_resources WHERE origin_run_id=? ORDER BY created_at DESC,resource_id DESC LIMIT ?",
      )
      .all(...(limit === undefined ? [runId] : [runId, limit]))
      .map((row) => decode<ResourceRecord>(row));
  }

  resourceHistory(id: string): ResourceHistoryRecord {
    const row = this.#db
      .prepare(
        `SELECT m.*, r.context_id FROM managed_resources m
      LEFT JOIN runs r ON r.run_id=m.origin_run_id WHERE m.resource_id=?`,
      )
      .get(id);
    requireCondition(
      row,
      "resource_not_found",
      "The resource history does not exist.",
    );
    return decode<ResourceHistoryRecord>(row);
  }

  /** Internal bounded scan. Per-row cursors let the manager filter authority without skipping rows. */
  scanResourceHistory(
    filter: ResourceHistoryFilter,
    caller: string,
    limit = 100,
    cursor?: string,
  ): {
    items: { record: ResourceHistoryRecord; cursor: string }[];
    more: boolean;
  } {
    requireCondition(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
      "invalid_limit",
      "A resource history scan must contain between 1 and 1000 rows.",
    );
    const query = digest({
      mode: "resource-history",
      binding: this.binding,
      caller,
      filter: Object.fromEntries(
        Object.entries(filter).filter(([, value]) => value !== undefined),
      ),
    });
    const where = [
      "json_extract(m.source_json,'$.owner')=?",
      "json_extract(m.source_json,'$.namespace')=?",
      "json_extract(m.source_json,'$.type')=?",
    ];
    const values: SQLInputValue[] = [
      filter.owner,
      filter.namespace,
      filter.type,
    ];
    for (const [field, expression] of [
      ["kind", "m.kind"],
      ["status", "m.status"],
      ["state", "json_extract(m.diagnostic_json,'$.details.state')"],
      ["runId", "m.origin_run_id"],
      ["contextId", "r.context_id"],
    ] as const) {
      if (filter[field] !== undefined) {
        if (field === "state")
          where.push("json_type(m.diagnostic_json,'$.details.state')='text'");
        where.push(`${expression}=?`);
        values.push(filter[field]!);
      }
    }
    if (cursor !== undefined) {
      try {
        requireCondition(
          typeof cursor === "string" &&
            cursor.length > 0 &&
            cursor.length <= 4096 &&
            /^[A-Za-z0-9_-]+$/.test(cursor),
          "invalid_cursor",
          "The resource history cursor is invalid.",
        );
        const envelope = Buffer.from(cursor, "base64url");
        requireCondition(
          envelope.length > 28,
          "invalid_cursor",
          "The resource history cursor is invalid.",
        );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          this.#cursorKey,
          envelope.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(query));
        decipher.setAuthTag(envelope.subarray(-16));
        const page = JSON.parse(
          Buffer.concat([
            decipher.update(envelope.subarray(12, -16)),
            decipher.final(),
          ]).toString("utf8"),
        ) as { time: number; id: string };
        requireCondition(
          Number.isSafeInteger(page.time) &&
            page.time >= 0 &&
            typeof page.id === "string" &&
            /^res_[0-9a-f]{32}$/.test(page.id),
          "invalid_cursor",
          "The resource history cursor has no valid position.",
        );
        where.push("(m.created_at<? OR (m.created_at=? AND m.resource_id<?))");
        values.push(page.time, page.time, page.id);
      } catch (cause) {
        throw new AgentError(
          "invalid_cursor",
          "The resource history cursor is invalid or belongs to another caller, source or filter.",
          undefined,
          { cause },
        );
      }
    }
    const rows = this.#db
      .prepare(
        `SELECT m.*, r.context_id FROM managed_resources m
      LEFT JOIN runs r ON r.run_id=m.origin_run_id WHERE ${where.join(" AND ")}
      ORDER BY m.created_at DESC,m.resource_id DESC LIMIT ?`,
      )
      .all(...values, limit + 1);
    return {
      more: rows.length > limit,
      items: rows.slice(0, limit).map((row) => {
        const record = decode<ResourceHistoryRecord>(row);
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", this.#cursorKey, iv);
        cipher.setAAD(Buffer.from(query));
        const ciphertext = Buffer.concat([
          cipher.update(
            JSON.stringify({ time: record.createdAt, id: record.resourceId }),
          ),
          cipher.final(),
        ]);
        return {
          record,
          cursor: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
            "base64url",
          ),
        };
      }),
    };
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
      .prepare("SELECT * FROM agent_state WHERE key=? AND deleted_at IS NULL")
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
      const previous = this.#db
        .prepare("SELECT * FROM agent_state WHERE key=?")
        .get(key);
      const currentVersion =
        previous && previous.deleted_at === null
          ? (previous.version as number)
          : null;
      requireCondition(
        currentVersion === expectedVersion,
        "state_version_conflict",
        "The shared value changed concurrently.",
      );
      requireCondition(
        !previous || Number(previous.version) < Number.MAX_SAFE_INTEGER,
        "state_version_exhausted",
        "The shared key's revision cannot advance safely.",
      );
      if (previous) {
        const changed = this.#db
          .prepare(
            "UPDATE agent_state SET value_json=?,version=version+1,updated_at=?,deleted_at=NULL WHERE key=? AND version=?",
          )
          .run(encoded, now, key, previous.version as number);
        requireCondition(
          changed.changes === 1,
          "state_version_conflict",
          "The shared value changed concurrently.",
        );
      } else
        this.#db
          .prepare(
            "INSERT INTO agent_state(key,value_json,version,updated_at) VALUES(?,?,1,?)",
          )
          .run(key, encoded, now);
      return this.getState(key)!;
    });
  }

  deleteState(
    key: string,
    expectedVersion: number,
    now = Date.now(),
  ): { deleted: true; version: number; updatedAt: number } {
    requireCondition(
      typeof key === "string" &&
        key.length > 0 &&
        key.length <= 256 &&
        Number.isSafeInteger(expectedVersion) &&
        expectedVersion > 0,
      "invalid_state_delete",
      "Deleting a shared value requires its actual key and positive revision.",
    );
    return this.#transaction(() => {
      const current = this.getState(key);
      requireCondition(
        current?.version === expectedVersion,
        "state_version_conflict",
        "The shared value changed concurrently.",
      );
      requireCondition(
        expectedVersion < Number.MAX_SAFE_INTEGER,
        "state_version_exhausted",
        "The shared key's revision cannot advance safely.",
      );
      const changed = this.#db
        .prepare(
          "UPDATE agent_state SET value_json='null',version=version+1,updated_at=?,deleted_at=? WHERE key=? AND version=? AND deleted_at IS NULL",
        )
        .run(now, now, key, expectedVersion);
      requireCondition(
        changed.changes === 1,
        "state_version_conflict",
        "The shared value changed concurrently.",
      );
      return { deleted: true, version: expectedVersion + 1, updatedAt: now };
    });
  }

  /** Internal bounded scan; cursors hide even records denied by the current policy. */
  scanRuns(
    filter: HistoryFilter,
    scopeKey: string,
    limit = 20,
    cursor?: string,
  ): { items: { record: RunRecord; cursor: string }[]; more: boolean } {
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
    if (cursor !== undefined) {
      try {
        requireCondition(
          typeof cursor === "string" &&
            cursor.length > 0 &&
            cursor.length <= 4096 &&
            /^[A-Za-z0-9_-]+$/.test(cursor),
          "invalid_cursor",
          "The history cursor is invalid.",
        );
        const envelope = Buffer.from(cursor, "base64url");
        requireCondition(
          envelope.length > 28,
          "invalid_cursor",
          "The history cursor is invalid.",
        );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          this.#cursorKey,
          envelope.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(query));
        decipher.setAuthTag(envelope.subarray(-16));
        const page = JSON.parse(
          Buffer.concat([
            decipher.update(envelope.subarray(12, -16)),
            decipher.final(),
          ]).toString("utf8"),
        ) as { time: number; id: string };
        requireCondition(
          Number.isSafeInteger(page.time) &&
            page.time >= 0 &&
            typeof page.id === "string" &&
            /^run_[0-9a-f]{32}$/.test(page.id),
          "invalid_cursor",
          "The cursor belongs to another query or scope.",
        );
        where.push("(accepted_at<? OR (accepted_at=? AND run_id<?))");
        values.push(page.time, page.time, page.id);
      } catch (cause) {
        throw new AgentError(
          "invalid_cursor",
          "The history cursor is invalid or no longer current.",
          undefined,
          { cause },
        );
      }
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY accepted_at DESC,run_id DESC LIMIT ?`,
      )
      .all(...values, limit + 1);
    return {
      more: rows.length > limit,
      items: rows.slice(0, limit).map((row) => {
        const record = decode<RunRecord>(row);
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", this.#cursorKey, iv);
        cipher.setAAD(Buffer.from(query));
        const ciphertext = Buffer.concat([
          cipher.update(
            JSON.stringify({ time: record.acceptedAt, id: record.runId }),
          ),
          cipher.final(),
        ]);
        return {
          record,
          cursor: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
            "base64url",
          ),
        };
      }),
    };
  }

  listRuns(
    filter: HistoryFilter,
    scopeKey: string,
    limit = 20,
    cursor?: string,
  ): { runs: RunRecord[]; nextCursor: string | null } {
    const page = this.scanRuns(filter, scopeKey, limit, cursor);
    return {
      runs: page.items.map((item) => item.record),
      nextCursor: page.more ? page.items.at(-1)!.cursor : null,
    };
  }
}
