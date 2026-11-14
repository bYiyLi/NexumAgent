import path from "node:path";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Dir,
  type Stats,
} from "node:fs";
import { lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { privateDirectory } from "./paths.js";

export type ManagedReserve = (bytes: number) => Promise<{ release(): void }>;
export type MaterialKind = "work" | "catalog" | "extension";
interface Marker {
  schemaVersion: 1;
  kind: MaterialKind;
  ref: string;
  unreferencedSince: number | null;
  retentionMs?: number;
}
interface DeletionFrame {
  directory: string;
  identity: Stats;
  handle: Dir;
  closed: boolean;
}
interface MaterialDeletion {
  ref: string;
  target: string;
  marker: string;
  markerIdentity: Stats;
  markerParentIdentity: Stats;
  frames: DeletionFrame[];
  failed: boolean;
}
export interface MaterialRetentionOptions {
  readonly reserve?: ManagedReserve;
  readonly now?: () => number;
  readonly retentionMs?: number;
  readonly liveSnapshotRefs: () => ReadonlySet<string>;
  readonly publishedDirectories?: () => ReadonlySet<string>;
}
export interface MaterialSweep {
  readonly processed: number;
  readonly removed: number;
  readonly errors: readonly { code: string; ref: string }[];
}
const markerBytes = 4096,
  grace = 7 * 86400000;
const absent = (cause: unknown) =>
  (cause as NodeJS.ErrnoException)?.code === "ENOENT";
const key = (ref: string) => createHash("sha256").update(ref).digest("hex");
function generation(ref: string): { kind: MaterialKind; ref: string } | null {
  const work =
    /^(work\/tmp\/contexts\/snapshot_[0-9a-f]{32})(?:\/[^\0]*)?$/.exec(ref);
  if (work) return { kind: "work", ref: work[1]! };
  const catalog = /^(work\/docs\/\.catalog\/[0-9a-f]{64})(?:\/[^\0]*)?$/.exec(
    ref,
  );
  if (catalog) return { kind: "catalog", ref: catalog[1]! };
  const extension =
    /^(work\/docs\/extensions\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{64})(?:\/[^\0]*)?$/.exec(
      ref,
    );
  if (
    extension &&
    !extension[1]!.split("/").some((part) => part === "." || part === "..")
  )
    return { kind: "extension", ref: extension[1]! };
  const adapter =
    /^(work\/docs\/adapters\/(?:api|mcp)\/[0-9a-f]{64}\/[0-9a-f]{64})(?:\/[^\0]*)?$/.exec(
      ref,
    );
  if (adapter) return { kind: "extension", ref: adapter[1]! };
  return null;
}

/** Private fixed-size lifecycle facts. No mtime inference or reconstruction of missing materials. */
export class MaterialRetention {
  readonly root: string;
  #pending = new Map<string, number>();
  #preparing = new Map<string, Promise<void>>();
  #published = new Map<string, string>();
  #deleting = new Set<string>();
  #pendingStages = new Map<string, number>();
  #directory?: Dir;
  #deletion?: MaterialDeletion;
  #sweeping?: Promise<MaterialSweep>;
  #closing = false;
  #closed = false;
  #stopping?: Promise<void>;
  constructor(
    root: string,
    readonly options: MaterialRetentionOptions,
  ) {
    requireCondition(
      path.isAbsolute(root) && path.resolve(root) === root,
      "material_profile_mismatch",
      "Material retention needs the fixed Agent profile root.",
    );
    this.root = root;
    requireCondition(
      options.retentionMs === undefined ||
        (Number.isSafeInteger(options.retentionMs) &&
          options.retentionMs > 0 &&
          options.retentionMs <= 253_402_300_799_999 - this.#now()),
      "invalid_material_retention",
      "New material retention must fit a positive protocol timestamp duration.",
    );
  }
  #now(): number {
    const now = this.options.now?.() ?? Date.now();
    requireCondition(
      Number.isSafeInteger(now) && now >= 0,
      "invalid_material_clock",
      "Material lifecycle time must be a valid timestamp.",
    );
    return now;
  }
  #assertOpen(): void {
    requireCondition(
      !this.#closing,
      "material_retention_closed",
      "Material retention is closing and cannot accept new work.",
    );
  }
  #ref(directory: string): { kind: MaterialKind; ref: string } {
    requireCondition(
      path.isAbsolute(directory),
      "material_path_escape",
      "Material lifecycle paths must be absolute profile coordinates.",
    );
    const relative = path
        .relative(this.root, directory)
        .split(path.sep)
        .join("/"),
      value = generation(relative);
    requireCondition(
      value && value.ref === relative,
      "material_path_escape",
      "Only a fixed work or material generation can enter retention.",
    );
    return value;
  }
  #marker(ref: string): string {
    return path.join(
      this.root,
      "state",
      "material-retention",
      `${key(ref)}.json`,
    );
  }
  #existing(directory: string): void {
    requireCondition(
      realpathSync.native(this.root) === this.root &&
        lstatSync(this.root).isDirectory(),
      "material_path_escape",
      "The actual profile root cannot redirect material access.",
    );
    let current = this.root;
    for (const part of path.relative(this.root, directory).split(path.sep)) {
      requireCondition(
        part !== "." && part !== ".." && part.length > 0,
        "material_path_escape",
        "A material coordinate must stay in its profile.",
      );
      current = path.join(current, part);
      const info = lstatSync(current);
      requireCondition(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          realpathSync.native(current) === current,
        "material_path_escape",
        "A material directory cannot redirect or be reconstructed.",
      );
    }
  }
  #encode(value: Marker): Buffer {
    const bytes = Buffer.from(JSON.stringify(value));
    requireCondition(
      bytes.length <= markerBytes,
      "material_marker_too_large",
      "The fixed private lifecycle marker is too large.",
    );
    const buffer = Buffer.alloc(markerBytes, 32);
    bytes.copy(buffer);
    return buffer;
  }
  #decode(buffer: Buffer, hash: string): Marker {
    const marker = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    ) as Marker;
    const actual = marker && generation(marker.ref);
    requireCondition(
      marker &&
        [
          "kind,ref,schemaVersion,unreferencedSince",
          "kind,ref,retentionMs,schemaVersion,unreferencedSince",
        ].includes(Object.keys(marker).sort().join(",")) &&
        marker.schemaVersion === 1 &&
        actual &&
        actual.ref === marker.ref &&
        actual.kind === marker.kind &&
        key(marker.ref) === hash &&
        (marker.unreferencedSince === null ||
          (Number.isSafeInteger(marker.unreferencedSince) &&
            marker.unreferencedSince >= 0)) &&
        (marker.retentionMs === undefined ||
          (Number.isSafeInteger(marker.retentionMs) &&
            marker.retentionMs > 0 &&
            marker.retentionMs <= 253_402_300_799_999)),
      "invalid_material_marker",
      "The private material lifecycle fact is invalid.",
    );
    return marker;
  }
  #read(ref: string): Marker {
    this.#existing(path.join(this.root, "state", "material-retention"));
    const file = openSync(
      this.#marker(ref),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = fstatSync(file);
      requireCondition(
        info.isFile() && info.nlink === 1 && info.size === markerBytes,
        "invalid_material_marker",
        "A lifecycle marker must keep its fixed regular-file size.",
      );
      const buffer = Buffer.alloc(markerBytes);
      let position = 0;
      while (position < buffer.length) {
        const count = readSync(
          file,
          buffer,
          position,
          buffer.length - position,
          position,
        );
        requireCondition(
          count > 0,
          "invalid_material_marker",
          "The lifecycle marker ended before its fixed record.",
        );
        position += count;
      }
      return this.#decode(buffer, key(ref));
    } finally {
      closeSync(file);
    }
  }
  #update(ref: string, time: number | null): void {
    const marker = this.#read(ref);
    if (marker.unreferencedSince === time) return;
    const bytes = this.#encode({ ...marker, unreferencedSince: time });
    const file = openSync(
      this.#marker(ref),
      constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = fstatSync(file);
      requireCondition(
        info.isFile() && info.nlink === 1 && info.size === markerBytes,
        "invalid_material_marker",
        "A material marker cannot grow during synchronous publication.",
      );
      let position = 0;
      while (position < bytes.length) {
        const count = writeSync(
          file,
          bytes,
          position,
          bytes.length - position,
          position,
        );
        requireCondition(
          count > 0,
          "material_marker_write_failed",
          "The lifecycle marker stopped accepting bytes.",
        );
        position += count;
      }
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
  }
  async #ensure(kind: MaterialKind, ref: string): Promise<void> {
    privateDirectory(this.root, "state", "material-retention");
    try {
      const current = this.#read(ref);
      requireCondition(
        current.kind === kind,
        "material_marker_conflict",
        "A generation cannot change its lifecycle kind.",
      );
      return;
    } catch (cause) {
      if (!absent(cause)) throw cause;
    }
    const reservation = await this.options.reserve?.(markerBytes);
    let created = false;
    try {
      this.#assertOpen();
      privateDirectory(this.root, "state", "material-retention");
      const file = await open(
        this.#marker(ref),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      created = true;
      try {
        await file.writeFile(
          this.#encode({
            schemaVersion: 1,
            kind,
            ref,
            unreferencedSince: null,
            retentionMs: this.options.retentionMs ?? grace,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") this.#read(ref);
      else {
        if (created) await unlink(this.#marker(ref)).catch(() => {});
        throw cause;
      }
    } finally {
      reservation?.release();
    }
  }
  async hold(
    kind: MaterialKind,
    directory: string,
  ): Promise<{ release(): void }> {
    this.#assertOpen();
    const actual = this.#ref(directory);
    requireCondition(
      actual.kind === kind,
      "material_marker_conflict",
      "The generation path does not match its declared lifecycle kind.",
    );
    requireCondition(
      !this.#deleting.has(actual.ref),
      "material_retiring",
      "This retired generation is being removed; prepare a fresh generation after cleanup settles.",
    );
    requireCondition(
      this.#pending.has(actual.ref) || this.#pending.size < 4096,
      "material_retention_busy",
      "Too many material preparations are pending.",
    );
    this.#pending.set(actual.ref, (this.#pending.get(actual.ref) ?? 0) + 1);
    try {
      let preparing = this.#preparing.get(actual.ref);
      if (!preparing) {
        preparing = this.#ensure(kind, actual.ref);
        this.#preparing.set(actual.ref, preparing);
        void preparing
          .finally(() => {
            if (this.#preparing.get(actual.ref) === preparing)
              this.#preparing.delete(actual.ref);
          })
          .catch(() => {});
      }
      await preparing;
      this.#assertOpen();
    } catch (cause) {
      const count = this.#pending.get(actual.ref)! - 1;
      if (count) this.#pending.set(actual.ref, count);
      else this.#pending.delete(actual.ref);
      throw cause;
    }
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        const count = this.#pending.get(actual.ref)!;
        if (
          !this.#closing &&
          count === 1 &&
          ![...this.#published.values()].includes(actual.ref)
        )
          this.#update(actual.ref, null);
        if (count > 1) this.#pending.set(actual.ref, count - 1);
        else this.#pending.delete(actual.ref);
        released = true;
      },
    });
  }
  setPublished(owner: string, directory: string | null): void {
    if (directory !== null) this.#assertOpen();
    requireCondition(
      typeof owner === "string" &&
        owner.length > 0 &&
        owner.length <= 512 &&
        (!directory ||
          this.#published.has(owner) ||
          this.#published.size < 4096),
      "invalid_material_owner",
      "A material publisher needs its bounded actual Core identity.",
    );
    const previous = this.#published.get(owner),
      next = directory === null ? null : this.#ref(directory).ref;
    requireCondition(
      !next || !this.#deleting.has(next),
      "material_retiring",
      "A deleting generation cannot become newly published.",
    );
    if (next) {
      this.#existing(path.join(this.root, next));
      this.#update(next, null);
    }
    if (
      !this.#closing &&
      previous &&
      previous !== next &&
      !this.#pending.has(previous) &&
      ![...this.#published].some(
        ([key, ref]) => key !== owner && ref === previous,
      )
    )
      this.#update(previous, null);
    if (next) this.#published.set(owner, next);
    else this.#published.delete(owner);
  }
  protectPending(directory: string): () => void {
    this.#assertOpen();
    const ref = path.relative(this.root, directory).split(path.sep).join("/");
    requireCondition(
      /^work\/docs\/extensions\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.prepare-[A-Za-z0-9_-]+$/.test(
        ref,
      ),
      "material_path_escape",
      "Only a real extension preparation stage can be protected here.",
    );
    this.#existing(directory);
    this.#pendingStages.set(
      directory,
      (this.#pendingStages.get(directory) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (!released) {
        released = true;
        const count = this.#pendingStages.get(directory)! - 1;
        if (count) this.#pendingStages.set(directory, count);
        else this.#pendingStages.delete(directory);
      }
    };
  }
  activeDirectories(): ReadonlySet<string> {
    return new Set(
      [...this.#pending.keys(), ...this.#published.values()]
        .map((ref) => path.join(this.root, ref))
        .concat([...this.#pendingStages.keys()]),
    );
  }
  async #bytes(filename: string, maximum: number): Promise<Buffer> {
    const file = await open(
      filename,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await file.stat();
      requireCondition(
        info.isFile() && info.size <= maximum,
        "material_snapshot_unavailable",
        "A retained material reference must be a bounded regular file.",
      );
      const buffer = Buffer.alloc(info.size + 1);
      let position = 0;
      while (position < buffer.length) {
        const read = await file.read(
          buffer,
          position,
          buffer.length - position,
          position,
        );
        if (!read.bytesRead) break;
        position += read.bytesRead;
      }
      requireCondition(
        position === info.size,
        "material_snapshot_unavailable",
        "The retained material reference changed while reading.",
      );
      return buffer.subarray(0, position);
    } finally {
      await file.close();
    }
  }
  async #live(): Promise<ReadonlySet<string>> {
    const live = new Set([
      ...this.#pending.keys(),
      ...this.#published.values(),
    ]);
    for (const directory of this.options.publishedDirectories?.() ?? []) {
      const relative = path
          .relative(this.root, directory)
          .split(path.sep)
          .join("/"),
        value = generation(relative);
      if (value) live.add(value.ref);
    }
    const snapshots = this.options.liveSnapshotRefs();
    requireCondition(
      snapshots.size <= 4096,
      "material_reference_budget",
      "Live work references exceed the bounded cleanup inspection budget.",
    );
    const add = (value: unknown) => {
      if (typeof value !== "string" || !path.isAbsolute(value)) return;
      const actual = generation(
        path.relative(this.root, value).split(path.sep).join("/"),
      );
      if (actual) live.add(actual.ref);
    };
    for (const ref of snapshots) {
      requireCondition(
        /^work\/tmp\/contexts\/snapshot_[0-9a-f]{32}\/bundle\.json$/.test(ref),
        "invalid_material_reference",
        "Live work references must retain their actual private snapshot coordinate.",
      );
      live.add(path.posix.dirname(ref));
      this.#existing(path.join(this.root, path.posix.dirname(ref)));
      const bundle = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await this.#bytes(path.join(this.root, ref), 16 * 1024 * 1024),
        ),
      ) as Record<string, any>;
      add(bundle.view?.agent?.docs?.entry);
      for (const group of ["docs", "instructions", "skills"])
        for (const item of bundle.published?.[group] ?? []) {
          add(item.path);
          add(item.skillFile);
        }
    }
    return live;
  }
  #sameDirectory(directory: string, expected: Stats): void {
    const actual = lstatSync(directory);
    requireCondition(
      actual.isDirectory() &&
        !actual.isSymbolicLink() &&
        actual.dev === expected.dev &&
        actual.ino === expected.ino &&
        realpathSync.native(directory) === directory,
      "material_path_escape",
      "A deleting material directory changed its canonical identity.",
    );
  }
  #checkDeletion(deletion: MaterialDeletion): void {
    this.#existing(deletion.target);
    for (const frame of deletion.frames)
      this.#sameDirectory(frame.directory, frame.identity);
  }
  async #closeFrame(frame: DeletionFrame): Promise<void> {
    if (frame.closed) return;
    try {
      await frame.handle.close();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED")
        throw cause;
    }
    frame.closed = true;
  }
  async #beginDeletion(ref: string): Promise<void> {
    const marker = this.#marker(ref),
      parent = path.dirname(marker),
      target = path.join(this.root, ref);
    this.#existing(parent);
    const markerIdentity = lstatSync(marker);
    requireCondition(
      markerIdentity.isFile() &&
        !markerIdentity.isSymbolicLink() &&
        markerIdentity.nlink === 1 &&
        markerIdentity.size === markerBytes,
      "invalid_material_marker",
      "Only the actual fixed private lifecycle record can be removed.",
    );
    let identity: Stats | undefined;
    try {
      this.#existing(target);
      identity = lstatSync(target);
    } catch (cause) {
      if (!absent(cause)) throw cause;
    }
    const deletion: MaterialDeletion = {
      ref,
      target,
      marker,
      markerIdentity,
      markerParentIdentity: lstatSync(parent),
      frames: [],
      failed: false,
    };
    this.#deleting.add(ref);
    this.#deletion = deletion;
    if (!identity) return;
    try {
      const handle = await opendir(target);
      deletion.frames.push({
        directory: target,
        identity,
        handle,
        closed: false,
      });
      this.#checkDeletion(deletion);
    } catch (cause) {
      deletion.failed = true;
      throw cause;
    }
  }
  async #deleteStep(): Promise<{
    removed: boolean;
    error?: unknown;
    blocked?: boolean;
  }> {
    const deletion = this.#deletion!;
    if (deletion.failed) {
      const frame = deletion.frames.at(-1);
      if (frame) {
        try {
          await this.#closeFrame(frame);
          deletion.frames.pop();
        } catch (cause) {
          return { removed: false, error: cause, blocked: true };
        }
      }
      if (!deletion.frames.length) {
        this.#deleting.delete(deletion.ref);
        this.#deletion = undefined;
      }
      return { removed: false };
    }
    try {
      const frame = deletion.frames.at(-1);
      if (frame) {
        const entry = await frame.handle.read();
        // Native directory reads may yield. The complete established chain is
        // checked again in the same turn as each actual unlink/rmdir below.
        this.#checkDeletion(deletion);
        if (!entry) {
          await this.#closeFrame(frame);
          this.#checkDeletion(deletion);
          rmdirSync(frame.directory);
          deletion.frames.pop();
        } else {
          requireCondition(
            entry.name !== "." &&
              entry.name !== ".." &&
              path.basename(entry.name) === entry.name,
            "material_path_escape",
            "A material entry must keep its actual directory name.",
          );
          const filename = path.join(frame.directory, entry.name);
          let identity: Stats;
          try {
            identity = lstatSync(filename);
          } catch (cause) {
            if (absent(cause)) return { removed: false };
            throw cause;
          }
          if (identity.isDirectory() && !identity.isSymbolicLink()) {
            requireCondition(
              deletion.frames.length < 128,
              "material_depth_exceeded",
              "Retired material traversal exceeds its bounded directory depth.",
            );
            const handle = await opendir(filename);
            deletion.frames.push({
              directory: filename,
              identity,
              handle,
              closed: false,
            });
            this.#checkDeletion(deletion);
          } else {
            // unlink never follows a leaf symlink; an unexpected leaf type is
            // removed only at its verified parent coordinate.
            unlinkSync(filename);
          }
        }
        return { removed: false };
      }
      const parent = path.dirname(deletion.marker);
      this.#existing(parent);
      this.#sameDirectory(parent, deletion.markerParentIdentity);
      const marker = lstatSync(deletion.marker);
      requireCondition(
        marker.isFile() &&
          !marker.isSymbolicLink() &&
          marker.nlink === 1 &&
          marker.dev === deletion.markerIdentity.dev &&
          marker.ino === deletion.markerIdentity.ino &&
          marker.size === markerBytes,
        "invalid_material_marker",
        "The allocated lifecycle record changed during material deletion.",
      );
      unlinkSync(deletion.marker);
      this.#deleting.delete(deletion.ref);
      this.#deletion = undefined;
      return { removed: true };
    } catch (cause) {
      deletion.failed = true;
      return { removed: false, error: cause };
    }
  }
  sweep(limit = 100): Promise<MaterialSweep> {
    this.#assertOpen();
    requireCondition(
      Number.isSafeInteger(limit) && limit >= 0 && limit <= 100,
      "invalid_material_batch",
      "Material cleanup must fit the remaining Core batch budget.",
    );
    if (this.#sweeping) return this.#sweeping;
    const pending = this.#sweep(limit);
    this.#sweeping = pending;
    void pending
      .finally(() => {
        if (this.#sweeping === pending) this.#sweeping = undefined;
      })
      .catch(() => {});
    return pending;
  }
  async #sweep(limit: number): Promise<MaterialSweep> {
    const errors: { code: string; ref: string }[] = [];
    let processed = 0,
      removed = 0;
    if (!limit) return { processed, removed, errors };
    const directory = path.join(this.root, "state", "material-retention");
    let live: ReadonlySet<string> | undefined;
    const now = this.#now();
    while (processed < limit) {
      if (this.#deletion) {
        const ref = this.#deletion.ref;
        processed++;
        const step = await this.#deleteStep();
        if (step.removed) removed++;
        if (step.error)
          errors.push({
            code:
              step.error instanceof AgentError
                ? step.error.code
                : "material_retention_failed",
            ref,
          });
        if (step.blocked) break;
        continue;
      }
      if (!live) {
        try {
          requireCondition(
            (await lstat(directory)).isDirectory() &&
              (await realpath(directory)) === directory,
            "material_path_escape",
            "The lifecycle index must stay in its private directory.",
          );
        } catch (cause) {
          if (absent(cause)) return { processed, removed, errors };
          throw cause;
        }
        live = await this.#live();
      }
      this.#directory ??= await opendir(directory);
      const entry = await this.#directory.read();
      processed++;
      if (!entry) {
        await this.#directory.close();
        this.#directory = undefined;
        break;
      }
      if (!/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
      if (
        [...this.#pending.keys()].some(
          (ref) => key(ref) + ".json" === entry.name,
        )
      )
        continue;
      let ref = entry.name;
      try {
        this.#existing(directory);
        const bytes = await this.#bytes(
          path.join(directory, entry.name),
          markerBytes,
        );
        requireCondition(
          bytes.length === markerBytes,
          "invalid_material_marker",
          "The lifecycle record lost its fixed allocated size.",
        );
        const marker = this.#decode(bytes, entry.name.slice(0, -5));
        ref = marker.ref;
        if (live.has(ref)) {
          if (marker.unreferencedSince !== null) this.#update(ref, null);
          continue;
        }
        if (marker.unreferencedSince === null) {
          this.#update(ref, now);
          continue;
        }
        if (now - marker.unreferencedSince < (marker.retentionMs ?? grace))
          continue;
        const current = await this.#live();
        if (
          current.has(ref) ||
          this.#pending.has(ref) ||
          [...this.#published.values()].includes(ref)
        ) {
          this.#update(ref, null);
          continue;
        }
        await this.#beginDeletion(ref);
      } catch (cause) {
        errors.push({
          code:
            cause instanceof AgentError
              ? cause.code
              : "material_retention_failed",
          ref,
        });
      }
    }
    return { processed, removed, errors };
  }
  stop(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#stopping) return this.#stopping;
    this.#closing = true;
    const stopping = this.#finishStop();
    this.#stopping = stopping;
    void stopping
      .finally(() => {
        if (this.#stopping === stopping) this.#stopping = undefined;
      })
      .catch(() => {});
    return stopping;
  }
  async #finishStop(): Promise<void> {
    await Promise.allSettled([...this.#preparing.values()]);
    await this.#sweeping?.catch(() => {});
    let failure: unknown;
    const deletion = this.#deletion;
    if (deletion) {
      for (const frame of [...deletion.frames].reverse()) {
        try {
          await this.#closeFrame(frame);
        } catch (cause) {
          failure ??= cause;
        }
      }
      deletion.frames = deletion.frames.filter((frame) => !frame.closed);
      if (!deletion.frames.length) {
        this.#deleting.delete(deletion.ref);
        this.#deletion = undefined;
      }
    }
    const directory = this.#directory;
    if (directory) {
      try {
        await directory.close();
        this.#directory = undefined;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ERR_DIR_CLOSED")
          this.#directory = undefined;
        else failure ??= cause;
      }
    }
    if (failure) throw failure;
    this.#closed = true;
  }
}
