import path from "node:path";
import { constants, type Dir, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, rm, rmdir } from "node:fs/promises";
import { AgentError, requireCondition } from "../contracts/errors.js";
import type { MaterialRetention } from "./material-retention.js";

export interface RetentionFile {
  readonly kind: "run" | "log" | "task" | "process_log" | "inputs";
  readonly ref: string;
}
export interface RetentionStore {
  readonly root: string;
  readonly binding: { readonly agentId: string };
  cleanupBatch(input: { now?: number; limit?: number }): {
    processed: number;
    deleted: Record<string, number>;
    files: readonly RetentionFile[];
  };
  activeRunIds(): ReadonlySet<string>;
  completeInputsCleanup(runId: string, now?: number): void;
  protectedArtifactIds(now: number): ReadonlySet<string>;
  taskArtifactRetentionUntil(
    id: string,
    originRunId: string | null,
    now: number,
  ): number | null;
}
export interface RetentionArtifacts {
  readonly root: string;
  readonly directory: string;
  activeSnapshot(): {
    readonly resourceIds: ReadonlySet<string>;
    readonly pendingPaths: ReadonlySet<string>;
  };
}
export interface ManagedUsage {
  readonly bytes: number;
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
  readonly observedAt: number;
  readonly complete: boolean;
}
export interface RetentionSweep {
  readonly processed: number;
  readonly deleted: Readonly<Record<string, number>>;
  readonly removedFiles: number;
  readonly removedArtifacts: number;
  readonly removedMaterials: number;
  readonly protectedArtifacts: number;
  readonly pendingInputDirectories: number;
  readonly errors: readonly { readonly code: string; readonly ref: string }[];
}
export interface SpaceReservation {
  release(): void;
}
export interface RetentionOptions {
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly maxManagedBytes?: number;
  readonly controlHeadroomBytes?: number;
  readonly materialRetention?: MaterialRetention;
  readonly onError?: (error: unknown) => void;
}

const GiB = 1024 ** 3,
  batchSize = 100,
  scanLimit = 100_000;
const managedRoots = [
  "state",
  "logs",
  "work/tmp",
  "work/resources",
  "work/docs",
  "work/data",
  "work/scripts",
  "work/skills",
  "work/.git",
  "work/.platform-controls",
] as const;
const resourcePattern = /^res_[0-9a-f]{32}$/;
const runPattern = /^run_[0-9a-f]{32}$/;
const absent = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException)?.code === "ENOENT";
const failure = (cause: unknown): string =>
  cause instanceof AgentError ? cause.code : "retention_io_failed";

/** Cold, profile-bound cleanup and admission. Raw Node/npm/project writes are not intercepted.
 * Callers reserve before real managed allocation and release only after its I/O settles.
 * Pending reservations are counted conservatively even while their writes become visible.
 */
export class ProfileRetention {
  readonly maxManagedBytes: number;
  readonly intervalMs: number;
  readonly controlHeadroomBytes: number;
  readonly root: string;
  lastError: unknown = null;
  #opened = false;
  #stopped = false;
  #opening?: Promise<void>;
  #stopping?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #sweeping?: Promise<RetentionSweep>;
  #admission: Promise<void> = Promise.resolve();
  #pendingAdmissions = 0;
  #reserved = 0;
  #artifactDirectory?: Dir;
  #artifactIdentity?: Stats;
  #materialFirst = true;
  #inputs: RetentionFile[] = [];
  #inputCursor?: {
    ref: string;
    runId: string;
    directory: string;
    root: Dir;
    wait?: Dir;
    waitPath?: string;
    failed: boolean;
  };

  constructor(
    readonly store: RetentionStore,
    readonly artifacts: RetentionArtifacts,
    readonly options: RetentionOptions = {},
  ) {
    requireCondition(
      path.isAbsolute(store.root) &&
        path.resolve(store.root) === store.root &&
        artifacts.root === store.root &&
        artifacts.directory === path.join(store.root, "work", "resources"),
      "retention_profile_mismatch",
      "Retention must use the same actual Agent/profile and artifact directory.",
    );
    this.root = store.root;
    requireCondition(
      !options.materialRetention ||
        options.materialRetention.root === this.root,
      "retention_profile_mismatch",
      "Material cleanup must share this actual Agent profile.",
    );
    this.maxManagedBytes = options.maxManagedBytes ?? 20 * GiB;
    this.controlHeadroomBytes =
      options.controlHeadroomBytes ??
      Math.min(8 * 1024 ** 2, Math.floor(this.maxManagedBytes / 64));
    this.intervalMs = options.intervalMs ?? 60_000;
    requireCondition(
      Number.isSafeInteger(this.maxManagedBytes) &&
        this.maxManagedBytes > 0 &&
        Number.isSafeInteger(this.controlHeadroomBytes) &&
        this.controlHeadroomBytes >= 0 &&
        this.controlHeadroomBytes < this.maxManagedBytes &&
        Number.isSafeInteger(this.intervalMs) &&
        this.intervalMs > 0 &&
        this.intervalMs <= 2_147_483_647,
      "invalid_retention_options",
      "Managed quota and cleanup interval must be positive bounded integers.",
    );
  }
  get reservedBytes(): number {
    return this.#reserved;
  }
  #now(): number {
    const now = this.options.now?.() ?? Date.now();
    requireCondition(
      Number.isSafeInteger(now) && now >= 0,
      "invalid_retention_clock",
      "Retention requires a valid current timestamp.",
    );
    return now;
  }
  #admit(): void {
    requireCondition(
      !this.#stopped,
      "retention_closed",
      "The profile retention service has stopped.",
    );
  }
  async #root(): Promise<void> {
    requireCondition(
      (await lstat(this.root)).isDirectory() &&
        (await realpath(this.root)) === this.root,
      "storage_path_escape",
      "The Agent profile root cannot redirect elsewhere.",
    );
  }
  async #directory(directory: string): Promise<Stats | null> {
    await this.#root();
    let current = this.root;
    for (const part of path.relative(this.root, directory).split(path.sep)) {
      requireCondition(
        part !== ".." && part !== "." && part.length > 0,
        "storage_path_escape",
        "Cleanup must stay in its fixed managed directory.",
      );
      current = path.join(current, part);
      let stats: Stats;
      try {
        stats = await lstat(current);
      } catch (cause) {
        if (absent(cause)) return null;
        throw cause;
      }
      requireCondition(
        stats.isDirectory() && !stats.isSymbolicLink(),
        "storage_path_escape",
        "A managed directory cannot be a symbolic link or another file type.",
      );
    }
    requireCondition(
      (await realpath(directory)) === directory,
      "storage_path_escape",
      "A managed directory cannot redirect elsewhere.",
    );
    return await lstat(directory);
  }
  async open(): Promise<void> {
    this.#admit();
    if (this.#opened) return;
    this.#opening ??= (async () => {
      await this.#root();
      this.#opened = true;
    })();
    try {
      await this.#opening;
    } finally {
      this.#opening = undefined;
    }
  }
  async start(): Promise<void> {
    await this.open();
    this.#admit();
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.sweep().catch((cause) => {
        this.lastError = cause;
        try {
          this.options.onError?.(cause);
        } catch (callback) {
          this.lastError = callback;
        }
      });
    }, this.intervalMs);
    this.#timer.unref();
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#stopping = this.#finishStop();
    return this.#stopping;
  }
  async #finishStop(): Promise<void> {
    await this.#sweeping?.catch(() => {});
    await this.#admission;
    await this.#closeDirectory();
    await this.#closeInputs();
    await this.options.materialRetention?.stop();
    if (this.#inputs.length) {
      this.lastError = new AgentError(
        "retention_cleanup_incomplete",
        "Temporary input cleanup stopped before its bounded traversal completed.",
        { count: this.#inputs.length },
      );
      this.options.onError?.(this.lastError);
    }
  }
  async measure(): Promise<ManagedUsage> {
    await this.open();
    let bytes = 0,
      files = 0,
      directories = 0,
      symlinks = 0,
      scanned = 0,
      complete = true;
    const identities = new Set<string>();
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (!complete) return;
      if (depth > 128) {
        complete = false;
        return;
      }
      if (!(await this.#directory(directory))) return;
      const dir = await opendir(directory);
      try {
        await this.#directory(directory);
        for await (const entry of dir) {
          if (++scanned > scanLimit) {
            complete = false;
            break;
          }
          const filename = path.join(directory, entry.name);
          // npm dependency trees remain the native package environment even
          // while the bounded maintenance planner uses a private temp root.
          const relative = path
            .relative(this.root, filename)
            .split(path.sep)
            .join("/");
          if (
            /^state\/maintenance\/npm\/plan-[A-Za-z0-9_-]+\/node_modules$/.test(
              relative,
            )
          )
            continue;
          let stats: Stats;
          try {
            stats = await lstat(filename);
          } catch (cause) {
            if (absent(cause)) continue;
            throw cause;
          }
          if (stats.isSymbolicLink()) {
            symlinks++;
            continue;
          }
          if (stats.isDirectory()) {
            directories++;
            await walk(filename, depth + 1);
          } else if (stats.isFile()) {
            const identity = `${stats.dev}:${stats.ino}`;
            if (!identities.has(identity)) {
              identities.add(identity);
              bytes += stats.size;
              files++;
            }
          }
          if (!complete) break;
        }
      } finally {
        await dir.close().catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED")
            throw cause;
        });
      }
    };
    for (const relative of managedRoots) {
      const directory = path.join(this.root, relative);
      if (await this.#directory(directory)) {
        directories++;
        await walk(directory, 0);
      }
      if (!complete) break;
    }
    return Object.freeze({
      bytes,
      files,
      directories,
      symlinks,
      observedAt: this.#now(),
      complete,
    });
  }
  async reserve(
    bytes: number,
    options: { readonly control?: boolean } = {},
  ): Promise<SpaceReservation> {
    this.#admit();
    requireCondition(
      Number.isSafeInteger(bytes) && bytes > 0,
      "invalid_storage_reservation",
      "Reserve a positive safe byte count before managed allocation.",
    );
    requireCondition(
      this.#pendingAdmissions < 256,
      "storage_reservation_busy",
      "The bounded managed-space admission queue is full.",
    );
    this.#pendingAdmissions++;
    const maximum =
      this.maxManagedBytes -
      (options.control === true ? 0 : this.controlHeadroomBytes);
    const admission = this.#admission.then(async () => {
      this.#admit();
      let usage = await this.measure();
      requireCondition(
        usage.complete,
        "storage_measurement_incomplete",
        "The managed usage scan could not finish within its safety budget.",
      );
      if (bytes > maximum - usage.bytes - this.#reserved) {
        await this.sweep();
        usage = await this.measure();
      }
      requireCondition(
        usage.complete,
        "storage_measurement_incomplete",
        "The managed usage scan could not finish within its safety budget.",
      );
      requireCondition(
        bytes <= maximum - usage.bytes - this.#reserved,
        "storage_quota_exceeded",
        "Managed storage is full after eligible expired data cleanup.",
      );
      this.#admit();
      this.#reserved += bytes;
      let released = false;
      return Object.freeze({
        release: () => {
          if (!released) {
            released = true;
            this.#reserved -= bytes;
          }
        },
      });
    });
    this.#admission = admission.then(
      () => {},
      () => {},
    );
    try {
      return await admission;
    } finally {
      this.#pendingAdmissions--;
    }
  }
  sweep(): Promise<RetentionSweep> {
    this.#admit();
    if (this.#sweeping) return this.#sweeping;
    const pending = this.#sweep();
    this.#sweeping = pending;
    void pending
      .finally(() => {
        if (this.#sweeping === pending) this.#sweeping = undefined;
      })
      .catch(() => {});
    return pending;
  }
  async #closeDirectory(): Promise<void> {
    const dir = this.#artifactDirectory;
    this.#artifactDirectory = undefined;
    this.#artifactIdentity = undefined;
    if (dir)
      await dir.close().catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED")
          throw cause;
      });
  }
  async #nextArtifact(): Promise<string | null> {
    const stats = await this.#directory(this.artifacts.directory);
    if (!stats) {
      await this.#closeDirectory();
      return null;
    }
    if (this.#artifactIdentity)
      requireCondition(
        stats.dev === this.#artifactIdentity.dev &&
          stats.ino === this.#artifactIdentity.ino,
        "storage_path_escape",
        "The open artifact catalog was replaced.",
      );
    if (!this.#artifactDirectory) {
      this.#artifactDirectory = await opendir(this.artifacts.directory);
      this.#artifactIdentity = stats;
    }
    const entry = await this.#artifactDirectory.read();
    if (!entry) {
      await this.#closeDirectory();
      return null;
    }
    return entry.name;
  }
  #protected(id: string, originRunId: string | null, now: number): boolean {
    const active = this.artifacts.activeSnapshot();
    return (
      active.resourceIds.has(id) ||
      active.pendingPaths.has(path.join(this.artifacts.directory, id)) ||
      this.store.protectedArtifactIds(now).has(id) ||
      (originRunId !== null && this.store.activeRunIds().has(originRunId)) ||
      (this.store.taskArtifactRetentionUntil(id, originRunId, now) ?? 0) > now
    );
  }
  async #removeArtifact(
    id: string,
    now: number,
  ): Promise<"removed" | "protected" | "current"> {
    if (!resourcePattern.test(id) || this.#protected(id, null, now))
      return "protected";
    const directory = path.join(this.artifacts.directory, id);
    if (!(await this.#directory(directory))) return "current";
    let record:
      | {
          resourceId?: unknown;
          agentId?: unknown;
          originRunId?: unknown;
          expiresAt?: unknown;
        }
      | undefined;
    try {
      const handle = await open(
        path.join(directory, "resource.json"),
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stats = await handle.stat();
        requireCondition(
          stats.isFile() && stats.size <= 16384,
          "invalid_resource_metadata",
          "Only bounded regular artifact metadata can be cleaned.",
        );
        const buffer = Buffer.alloc(16385),
          read = await handle.read(buffer, 0, buffer.length, 0);
        requireCondition(
          read.bytesRead <= 16384,
          "invalid_resource_metadata",
          "The artifact metadata changed beyond its safe size.",
        );
        record = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, read.bytesRead),
          ),
        );
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (!absent(cause)) throw cause;
    }
    let originRunId: string | null = null;
    if (record !== undefined) {
      requireCondition(
        record &&
          record.resourceId === id &&
          record.agentId === this.store.binding.agentId &&
          (record.originRunId === null ||
            (typeof record.originRunId === "string" &&
              runPattern.test(record.originRunId))) &&
          typeof record.expiresAt === "string" &&
          Number.isFinite(Date.parse(record.expiresAt)),
        "invalid_resource_metadata",
        "Artifact cleanup requires its actual registered identity and expiry.",
      );
      originRunId = record.originRunId as string | null;
      if (Date.parse(record.expiresAt) > now) return "current";
    }
    if (this.#protected(id, originRunId, now)) return "protected";
    await this.#directory(directory);
    if (this.#protected(id, originRunId, now)) return "protected";
    await rm(directory, { recursive: true, force: true });
    return "removed";
  }
  async #removeFile(candidate: RetentionFile): Promise<number> {
    const { kind, ref } = candidate;
    let match: RegExpExecArray | null;
    if (kind === "run") {
      match = /^work\/tmp\/runs\/(run_[0-9a-f]{32})$/.exec(ref);
      requireCondition(
        match,
        "invalid_cleanup_reference",
        "Run cleanup only accepts a fixed expired run directory.",
      );
      if (this.store.activeRunIds().has(match[1]!)) return 0;
      if (await this.#directory(path.join(this.root, ref)))
        await rm(path.join(this.root, ref), { recursive: true, force: true });
      return 1;
    }
    if (kind === "log") {
      match = /^logs\/runs\/(run_[0-9a-f]{32})\/console\.log$/.exec(ref);
      requireCondition(
        match,
        "invalid_cleanup_reference",
        "Run log cleanup only accepts its fixed console file.",
      );
      if (this.store.activeRunIds().has(match[1]!)) return 0;
    } else if (kind === "task")
      requireCondition(
        /^state\/tasks\/[0-9a-f]{64}\/result_[0-9a-f]{32}\.json$/.test(ref),
        "invalid_cleanup_reference",
        "Task cleanup only accepts its fixed retained result file.",
      );
    else if (kind === "process_log")
      requireCondition(
        /^logs\/processes\/res_[0-9a-f]{32}\.output$/.test(ref),
        "invalid_cleanup_reference",
        "Process output cleanup only accepts its fixed managed log.",
      );
    else
      throw new AgentError(
        "invalid_cleanup_reference",
        "Unknown managed cleanup kind.",
      );
    const filename = path.join(this.root, ref),
      parent = path.dirname(filename);
    if (!(await this.#directory(parent))) return 0;
    const names =
      kind === "process_log" ? [filename, `${filename}.complete`] : [filename];
    let removed = 0;
    for (const file of names) {
      try {
        const stats = await lstat(file);
        requireCondition(
          stats.isFile() && !stats.isSymbolicLink(),
          "storage_path_escape",
          "A retained file cannot redirect cleanup elsewhere.",
        );
        await rm(file);
        removed++;
      } catch (cause) {
        if (!absent(cause)) throw cause;
      }
    }
    if (kind === "log" || kind === "task")
      await rmdir(parent).catch((cause) => {
        if (
          !absent(cause) &&
          (cause as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        )
          throw cause;
      });
    return removed;
  }
  async #closeInputs(): Promise<void> {
    const cursor = this.#inputCursor;
    this.#inputCursor = undefined;
    for (const dir of [cursor?.wait, cursor?.root])
      if (dir)
        await dir.close().catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED")
            throw cause;
        });
  }
  async #drainInputs(
    limit: number,
    now: number,
    errors: { code: string; ref: string }[],
  ): Promise<{ processed: number; removed: number }> {
    let processed = 0,
      removed = 0;
    while (processed < limit && this.#inputs.length) {
      const candidate = this.#inputs[0]!;
      try {
        const match = /^work\/tmp\/runs\/(run_[0-9a-f]{32})\/inputs$/.exec(
          candidate.ref,
        );
        requireCondition(
          match,
          "invalid_cleanup_reference",
          "Input cleanup only accepts the original run's fixed temporary directory.",
        );
        const runId = match[1]!;
        if (this.store.activeRunIds().has(runId)) {
          processed++;
          break;
        }
        if (!this.#inputCursor) {
          const directory = path.join(this.root, candidate.ref);
          if (!(await this.#directory(directory))) {
            this.store.completeInputsCleanup(runId, now);
            this.#inputs.shift();
            processed++;
            continue;
          }
          this.#inputCursor = {
            ref: candidate.ref,
            runId,
            directory,
            root: await opendir(directory),
            failed: false,
          };
        }
        const cursor = this.#inputCursor;
        requireCondition(
          cursor.ref === candidate.ref,
          "invalid_cleanup_reference",
          "Input traversal cannot be rebound to another run.",
        );
        await this.#directory(cursor.waitPath ?? cursor.directory);
        const entry = await (cursor.wait ?? cursor.root).read();
        if (!entry) {
          if (cursor.wait) {
            await cursor.wait.close();
            cursor.wait = undefined;
            const waitPath = cursor.waitPath!;
            cursor.waitPath = undefined;
            await rmdir(waitPath).catch((cause) => {
              if (
                !absent(cause) &&
                (cause as NodeJS.ErrnoException).code !== "ENOTEMPTY"
              )
                throw cause;
            });
          } else {
            const finished = !cursor.failed;
            await this.#closeInputs();
            processed++;
            if (finished && !this.store.activeRunIds().has(runId))
              this.store.completeInputsCleanup(runId, now);
            this.#inputs.shift();
            await rmdir(cursor.directory).catch((cause) => {
              if (
                !absent(cause) &&
                (cause as NodeJS.ErrnoException).code !== "ENOTEMPTY"
              )
                throw cause;
            });
          }
          continue;
        }
        processed++;
        if (
          !cursor.wait &&
          entry.isDirectory() &&
          /^wait_[0-9a-f]{32}$/.test(entry.name)
        ) {
          const directory = path.join(cursor.directory, entry.name);
          if (await this.#directory(directory)) {
            cursor.wait = await opendir(directory);
            cursor.waitPath = directory;
          }
        } else if (/^input_[0-9a-f]{32}\.bin$/.test(entry.name)) {
          const filename = path.join(
            cursor.waitPath ?? cursor.directory,
            entry.name,
          );
          const stats = await lstat(filename);
          requireCondition(
            stats.isFile() && !stats.isSymbolicLink(),
            "storage_path_escape",
            "Temporary attachment cleanup cannot follow a link or remove another file type.",
          );
          if (this.store.activeRunIds().has(runId)) break;
          await rm(filename);
          removed++;
        }
      } catch (cause) {
        errors.push({ code: failure(cause), ref: candidate.ref });
        if (this.#inputCursor) this.#inputCursor.failed = true;
        else {
          this.#inputs.shift();
          processed++;
        }
        // A failed native directory read cannot be resumed safely by assuming
        // that it advanced. Retry through the Store's still-unfinished fact.
        await this.#closeInputs();
        if (this.#inputs[0] === candidate) this.#inputs.shift();
      }
    }
    return { processed, removed };
  }
  async #sweep(): Promise<RetentionSweep> {
    await this.open();
    const now = this.#now();
    let processed = 0,
      removedFiles = 0,
      removedArtifacts = 0,
      removedMaterials = 0,
      protectedArtifacts = 0;
    let deleted: Readonly<Record<string, number>> = {};
    const errors: { code: string; ref: string }[] = [];
    const pending = await this.#drainInputs(batchSize, now, errors);
    processed += pending.processed;
    removedFiles += pending.removed;
    if (!this.#inputs.length && processed < batchSize) {
      const limit = batchSize - processed,
        batch = this.store.cleanupBatch({ now, limit });
      requireCondition(
        Number.isSafeInteger(batch.processed) &&
          batch.processed >= 0 &&
          batch.processed <= limit &&
          Array.isArray(batch.files) &&
          batch.files.length <= 2 * limit,
        "invalid_cleanup_batch",
        "The Store cleanup batch exceeds its bounded contract.",
      );
      processed += batch.processed;
      deleted = Object.freeze({ ...batch.deleted });
      for (const candidate of batch.files) {
        if (candidate.kind === "inputs") {
          requireCondition(
            this.#inputs.length < batchSize,
            "invalid_cleanup_batch",
            "The bounded input cleanup continuation is full.",
          );
          if (!this.#inputs.some((item) => item.ref === candidate.ref))
            this.#inputs.push(candidate);
        } else
          try {
            removedFiles += await this.#removeFile(candidate);
          } catch (cause) {
            errors.push({ code: failure(cause), ref: candidate.ref });
          }
      }
      const inputs = await this.#drainInputs(
        batchSize - processed,
        now,
        errors,
      );
      processed += inputs.processed;
      removedFiles += inputs.removed;
    }
    const materials = async () => {
      if (!this.options.materialRetention || processed >= batchSize) return;
      const remaining = batchSize - processed,
        material = await this.options.materialRetention.sweep(remaining);
      requireCondition(
        Number.isSafeInteger(material.processed) &&
          material.processed >= 0 &&
          material.processed <= remaining,
        "invalid_cleanup_batch",
        "Material cleanup exceeded the remaining Core batch budget.",
      );
      processed += material.processed;
      removedMaterials += material.removed;
      errors.push(...material.errors);
    };
    if (this.#materialFirst) await materials();
    while (processed < batchSize) {
      const id = await this.#nextArtifact();
      if (id === null) break;
      processed++;
      if (!resourcePattern.test(id)) continue;
      try {
        const result = await this.#removeArtifact(id, now);
        if (result === "removed") removedArtifacts++;
        if (result === "protected") protectedArtifacts++;
      } catch (cause) {
        errors.push({ code: failure(cause), ref: `work/resources/${id}` });
      }
    }
    if (!this.#materialFirst) await materials();
    this.#materialFirst = !this.#materialFirst;
    const result = Object.freeze({
      processed,
      deleted,
      removedFiles,
      removedArtifacts,
      removedMaterials,
      protectedArtifacts,
      pendingInputDirectories: this.#inputs.length,
      errors: Object.freeze(errors),
    });
    if (errors.length) {
      this.lastError = new AgentError(
        "retention_cleanup_failed",
        "Some retained files could not be safely removed.",
        { count: errors.length },
      );
      this.options.onError?.(this.lastError);
    } else this.lastError = null;
    return result;
  }
}
