import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { callerKey, fixedCaller, type Caller } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord, newId } from "../contracts/json.js";
import type { JsonObject, JsonValue } from "../contracts/types.js";
import { terminalStatuses } from "../contracts/types.js";
import {
  SqliteStore,
  type McpTaskRecord,
  type McpTaskStatus,
} from "../storage/sqlite.js";
import { parseArtifactUri } from "../results/artifacts.js";
import { RunEngine, type RunView } from "./engine.js";
import { atomicText, contains, privateDirectory } from "./paths.js";

const snapshotLimit = 96 * 1024 * 1024;
export const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;
export interface TaskBinding {
  readonly taskId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly status: McpTaskStatus;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
  readonly error?: JsonObject;
}
export interface TaskView {
  readonly task: TaskBinding;
  readonly view: RunView;
}

export function taskAgentId(taskId: string): string {
  requireCondition(
    typeof taskId === "string" &&
      /^nx_task_[A-Za-z0-9_-]{1,1016}$/.test(taskId),
    "invalid_task",
    "The Task identity is invalid.",
  );
  try {
    const encoded = taskId.slice(8),
      bytes = Buffer.from(encoded, "base64url");
    requireCondition(
      bytes.toString("base64url") === encoded,
      "invalid_task",
      "The Task identity is invalid.",
    );
    const route: unknown = JSON.parse(bytes.toString("utf8"));
    requireCondition(
      Array.isArray(route) &&
        route.length === 2 &&
        typeof route[0] === "string" &&
        route[0].length > 0 &&
        route[0].length <= 256 &&
        typeof route[1] === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          route[1],
        ),
      "invalid_task",
      "The Task route is invalid.",
    );
    return route[0];
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError("invalid_task", "The Task route is invalid.");
  }
}

/** Already normalized Core data only. Never follows a URL or interprets a guest object. */
export function localTaskArtifactIds(
  value: JsonValue,
  agentId: string,
  promisedAt = 0,
  retentionUntil?: (
    resourceId: string,
    originRunId: string | null,
    originalExpiresAt: number,
  ) => number,
): readonly string[] {
  const ids = new Set<string>();
  const resource = (item: JsonValue | undefined): void => {
    if (
      !item ||
      Array.isArray(item) ||
      typeof item !== "object" ||
      typeof item.uri !== "string"
    )
      return;
    try {
      const target = parseArtifactUri(item.uri);
      if (
        target.agentId === agentId &&
        item.resourceId === target.resourceId &&
        typeof item.expiresAt === "string" &&
        (Date.parse(item.expiresAt) > promisedAt ||
          (retentionUntil?.(
            target.resourceId,
            typeof item.originRunId === "string" ? item.originRunId : null,
            Date.parse(item.expiresAt),
          ) ?? 0) > promisedAt)
      )
        ids.add(target.resourceId);
    } catch {
      /* Remote links are not fixed local artifacts. */
    }
  };
  // Only encoder-owned artifact coordinates carry retention authority. A business
  // string/object that happens to contain a URI must never revive old content.
  if (value && !Array.isArray(value) && typeof value === "object") {
    if (Array.isArray(value.content))
      for (const block of value.content)
        if (block && !Array.isArray(block) && typeof block === "object")
          resource(block.resource);
    const delivery = value.delivery;
    if (delivery && !Array.isArray(delivery) && typeof delivery === "object") {
      resource(delivery.dataResource);
      resource(delivery.textResource);
    }
  }
  requireCondition(
    ids.size <= 16384,
    "task_result_too_large",
    "The Task result has too many artifact references.",
  );
  return Object.freeze([...ids]);
}

/** Durable association and result retention over the existing engine, never an executor. */
export class RuntimeTasks {
  readonly store: SqliteStore;
  readonly engine: RunEngine;
  #now: () => number;
  #reserve?: (
    bytes: number,
    options?: { readonly control?: boolean },
  ) => Promise<{ release(): void }>;
  constructor(
    store: SqliteStore,
    engine: RunEngine,
    options: {
      now?: () => number;
      reserve?: (
        bytes: number,
        options?: { readonly control?: boolean },
      ) => Promise<{ release(): void }>;
    } = {},
  ) {
    requireCondition(
      engine.store === store,
      "runtime_profile_mismatch",
      "Tasks must use the original profile RunEngine.",
    );
    this.store = store;
    this.engine = engine;
    this.#now = options.now ?? Date.now;
    this.#reserve = options.reserve;
  }
  #binding(task: McpTaskRecord): TaskBinding {
    return Object.freeze({
      taskId: task.taskId,
      agentId: this.store.binding.agentId,
      runId: task.runId,
      status: task.status,
      createdAt: new Date(task.createdAt).toISOString(),
      lastUpdatedAt: new Date(task.updatedAt).toISOString(),
      expiresAt: new Date(task.expiresAt).toISOString(),
      ttlMs: task.expiresAt - task.createdAt,
      ...(task.error ? { error: task.error } : {}),
    });
  }
  #task(caller: Caller, taskId: string): McpTaskRecord {
    requireCondition(
      taskAgentId(taskId) === this.store.binding.agentId,
      "agent_mismatch",
      "The Task targets another Agent.",
    );
    return this.store.getTask(taskId, callerKey(caller), this.#now());
  }
  pinResult(runId: string, result: JsonObject): void {
    this.store.pinTaskRunArtifacts(
      runId,
      localTaskArtifactIds(result, this.store.binding.agentId),
      this.#now(),
    );
  }
  async create(
    caller: Caller,
    input: { runId: string; ttlMs?: number },
    signal?: AbortSignal,
  ): Promise<TaskBinding> {
    caller = fixedCaller(caller);
    let view = await this.engine.observe(caller, input.runId, 0, signal);
    signal?.throwIfAborted();
    const previous = this.store.taskForRun(
      view.run.runId,
      callerKey(caller),
      this.#now(),
    );
    if (previous) return (await this.#capture(caller, previous, view)).task;
    const taskId =
      "nx_task_" +
      Buffer.from(
        JSON.stringify([this.store.binding.agentId, randomUUID()]),
      ).toString("base64url");
    let admission: { release(): void } | undefined;
    try {
      admission = await this.#reserve?.(65536);
    } catch (cause) {
      const concurrent = this.store.taskForRun(
        view.run.runId,
        callerKey(caller),
        this.#now(),
      );
      if (!concurrent) throw cause;
      return (await this.#capture(caller, concurrent, view)).task;
    }
    let task: McpTaskRecord;
    try {
      view = await this.engine.observe(caller, input.runId, 0, signal);
      task = this.store.createTask(
        {
          taskId,
          callerKey: callerKey(caller),
          runId: view.run.runId,
          ttlMs: input.ttlMs ?? DEFAULT_TASK_TTL_MS,
        },
        this.#now(),
      );
    } finally {
      admission?.release();
    }
    return (await this.#capture(caller, task, view)).task;
  }
  async get(
    caller: Caller,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskView> {
    caller = fixedCaller(caller);
    const task = this.#task(caller, taskId);
    // IDs and retained metadata never stand in for today's Grant or run authority.
    const current = await this.engine.observe(caller, task.runId, 0, signal);
    signal?.throwIfAborted();
    return await this.#capture(caller, task, current);
  }
  async update(
    caller: Caller,
    input: {
      taskId: string;
      waitId: string;
      input: JsonValue;
      attachments?: JsonObject[];
    },
    signal?: AbortSignal,
    beforeInput?: (runId: string) => void | Promise<void>,
  ): Promise<TaskView> {
    caller = fixedCaller(caller);
    const task = this.#task(caller, input.taskId);
    requireCondition(
      !["completed", "cancelled", "failed"].includes(task.status),
      "task_closed",
      "The Task is already terminal.",
    );
    await beforeInput?.(task.runId);
    signal?.throwIfAborted();
    const view = await this.engine.input(
      caller,
      {
        agentId: this.store.binding.agentId,
        runId: task.runId,
        waitId: input.waitId,
        input: input.input,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        waitMs: 0,
      },
      signal,
    );
    return await this.#capture(caller, task, view);
  }
  async cancel(
    caller: Caller,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskView & { readonly accepted: boolean }> {
    caller = fixedCaller(caller);
    const task = this.#task(caller, taskId);
    signal?.throwIfAborted();
    if (["completed", "cancelled", "failed"].includes(task.status))
      return { ...(await this.get(caller, taskId, signal)), accepted: false };
    const view = this.engine.cancel(caller, task.runId);
    return {
      ...(await this.#capture(caller, task, view)),
      accepted: view.accepted,
    };
  }
  /** Trusted JSON-RPC method failure, distinct from an ordinary isError tool result. */
  async fail(
    caller: Caller,
    taskId: string,
    error: JsonObject,
    signal?: AbortSignal,
  ): Promise<TaskView> {
    caller = fixedCaller(caller);
    const task = this.#task(caller, taskId),
      view = await this.engine.observe(caller, task.runId, 0, signal);
    return await this.#capture(caller, task, view, error);
  }
  #read(task: McpTaskRecord, current: RunView): RunView {
    requireCondition(
      task.resultRef,
      "task_result_unavailable",
      "The terminal Task result is unavailable.",
    );
    const expected = `state/tasks/${createHash("sha256").update(task.taskId).digest("hex")}/`;
    let fd: number | undefined;
    try {
      requireCondition(
        task.resultRef.startsWith(expected) &&
          /^result_[0-9a-f]{32}\.json$/.test(
            task.resultRef.slice(expected.length),
          ),
        "task_result_unavailable",
        "The Task result reference is invalid.",
      );
      const filename = path.join(this.store.root, task.resultRef);
      const directory = path.dirname(filename);
      requireCondition(
        realpathSync.native(this.store.root) === this.store.root &&
          realpathSync.native(directory) === directory &&
          contains(this.store.root, directory) &&
          lstatSync(filename).isFile(),
        "task_result_unavailable",
        "The retained Task result was redirected.",
      );
      fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      requireCondition(
        fstatSync(fd).isFile() && fstatSync(fd).size <= snapshotLimit,
        "task_result_unavailable",
        "The retained Task result exceeds its original budget.",
      );
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      requireCondition(
        isPlainRecord(value) &&
          isPlainRecord(value.run) &&
          value.run.runId === task.runId &&
          value.run.callerKey === task.callerKey,
        "task_result_unavailable",
        "The retained Task result belongs to another run.",
      );
      const {
        taskSnapshotVersion,
        retainedResult,
        retainedResultHash,
        retainedArtifacts: _artifacts,
        ...saved
      } = value;
      if (taskSnapshotVersion === 1 && retainedResult === true) {
        requireCondition(
          isPlainRecord(saved.run) &&
            saved.run.resultRef === current.run.resultRef,
          "task_result_unavailable",
          "The original Task result reference changed.",
        );
        if (current.result)
          requireCondition(
            typeof retainedResultHash === "string" &&
              createHash("sha256")
                .update(canonicalJson(current.result, snapshotLimit))
                .digest("hex") === retainedResultHash,
            "task_result_unavailable",
            "The original Task result content changed.",
          );
        return {
          ...(saved as unknown as RunView),
          result: current.result,
          ...(current.unavailable ? { unavailable: current.unavailable } : {}),
        };
      }
      return saved as unknown as RunView;
    } catch (cause) {
      throw new AgentError(
        "task_result_unavailable",
        "The original terminal Task result is unavailable; it will not be regenerated.",
        undefined,
        { cause },
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  async #capture(
    caller: Caller,
    task: McpTaskRecord,
    view: RunView,
    rpcError?: JsonObject,
  ): Promise<TaskView> {
    // Another simultaneous query can have settled the same Task while we observed.
    task = this.store.getTask(task.taskId, task.callerKey, this.#now());
    if (["completed", "cancelled", "failed"].includes(task.status))
      return { task: this.#binding(task), view: this.#read(task, view) };
    const status: McpTaskStatus = rpcError
      ? "failed"
      : view.run.status === "cancelled"
        ? "cancelled"
        : terminalStatuses.has(view.run.status)
          ? "completed"
          : view.wait && ["none", "failed"].includes(view.wait.deliveryState)
            ? "input_required"
            : "working";
    if (status === "working" || status === "input_required") {
      task = this.store.updateTask(
        task.taskId,
        task.callerKey,
        { status },
        this.#now(),
      );
      return { task: this.#binding(task), view };
    }
    if (view.result)
      this.store.pinTaskRunArtifacts(
        view.run.runId,
        localTaskArtifactIds(
          view.result,
          this.store.binding.agentId,
          task.createdAt,
          (id, originRunId, expiresAt) =>
            this.store.taskArtifactRetentionUntil(
              id,
              originRunId,
              this.#now(),
              expiresAt,
            ),
        ),
        this.#now(),
      );
    const serialized = canonicalJson(
        {
          ...view,
          result: null,
          taskSnapshotVersion: 1,
          retainedResult: view.result !== null,
          retainedResultHash: view.result
            ? createHash("sha256")
                .update(canonicalJson(view.result, snapshotLimit))
                .digest("hex")
            : null,
          retainedArtifacts: view.result
            ? localTaskArtifactIds(view.result, this.store.binding.agentId).map(
                (resourceId) => ({ resourceId }),
              )
            : [],
        },
        snapshotLimit,
      ),
      reservation = await this.#reserve?.(
        Buffer.byteLength(serialized) + 1024,
        { control: true },
      );
    let filename: string | undefined;
    try {
      // A quota scan can yield: the current caller must still be authorized before publication.
      await this.engine.observe(caller, task.runId, 0);
      const directory = privateDirectory(
        this.store.root,
        "state",
        "tasks",
        createHash("sha256").update(task.taskId).digest("hex"),
      );
      filename = path.join(directory, newId("result") + ".json");
      const ref = path
        .relative(this.store.root, filename)
        .split(path.sep)
        .join("/");
      // Persist only the engine's normalized original result, never a fresh wire stream or delivery URL.
      atomicText(filename, serialized);
      task = this.store.updateTask(
        task.taskId,
        task.callerKey,
        { status, resultRef: ref, ...(rpcError ? { error: rpcError } : {}) },
        this.#now(),
      );
      if (task.resultRef !== ref) rmSync(filename, { force: true });
      return {
        task: this.#binding(task),
        view: task.resultRef === ref ? view : this.#read(task, view),
      };
    } catch (cause) {
      if (filename) rmSync(filename, { force: true });
      throw cause;
    } finally {
      reservation?.release();
    }
  }
}
