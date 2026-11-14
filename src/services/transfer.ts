import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { MIMEType } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import {
  authorizeCall,
  callerKey,
  fixedCaller,
  type Caller,
} from "../contracts/caller.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type {
  Binding,
  ContributionOrigin,
  JsonObject,
} from "../contracts/types.js";
import type { AccessTarget } from "../extensions/api.js";
import {
  ResourceManager,
  type ResourceInstance,
  type ResourceRef,
  type ManagedResource,
} from "../extensions/resources.js";
import type {
  TransferService,
  TransferSnapshot,
  UploadOffer,
  DownloadOffer,
} from "../extensions/transfer.js";
import {
  ArtifactStore,
  type ArtifactRecord,
  type ArtifactScope,
} from "../results/artifacts.js";
import { SqliteStore } from "../storage/sqlite.js";
import type {
  TransferOwner,
  TransferRecord,
  TransferStop,
  TransferTerminalStatus,
  TransferTarget,
} from "../storage/transfers.js";
import {
  prepareUpload,
  receiveUpload,
  sendDownload,
  TransferIoError,
  type PreparedUpload,
  type TransferIoScope,
  type UploadFileReceipt,
} from "../transfer/io.js";
import {
  TransferOfferDelivery,
  type IssuedTransferSnapshot,
  type TransferOfferScope,
  type TransferRequest,
} from "../transfer/offers.js";
import {
  TransferStreamSlots,
  type StreamPermit,
} from "../transfer/stream-slots.js";

export interface TransferScope {
  readonly context: Readonly<JsonObject>;
  readonly runId?: string;
  readonly signal: AbortSignal;
  readonly deadline?: number;
  assertCurrent(): void;
  authorize(target: AccessTarget): void;
}
/** Fresh Core authority for one actual HTTP/wire claim, never the settled SDK invocation. */
export interface TransferClaimScope {
  readonly binding: Binding & { readonly bootId: string };
  readonly caller: Caller;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  authorize(target: AccessTarget): void;
}
export interface TransferChannelBinding {
  readonly binding: Binding & { readonly bootId: string };
  readonly transferId: string;
  readonly resourceId: string;
  readonly caller: Caller;
  readonly direction: "upload" | "download";
  readonly claimDeadlineAt: number;
  readonly maxBytes: number;
  readonly target: TransferTarget;
}
/** Implemented by the real Cloud control/binary bridge, or a component HTTP fixture. */
export interface TransferChannelPort {
  prepare(
    binding: TransferChannelBinding,
    signal: AbortSignal,
  ): Promise<TransferRequest>;
  /** Resolves only when no remaining claimant/stream uses this channel. */
  revoke(binding: TransferChannelBinding, reason: TransferStop): Promise<void>;
}
export type TransferClaimIo = (
  | { readonly upload: Readable; readonly contentLength?: number }
  | { readonly download: Writable }
) & {
  /** Actual transport closure/acknowledgement, independent of Writable.finish. */
  readonly closed: Promise<void>;
};
export interface TransferReservation {
  readonly transferId: string;
}
export interface TransferServicesOptions {
  readonly origin: ContributionOrigin;
  readonly maxBytes?: number;
  readonly claimTimeoutMs?: number;
  readonly activeTimeoutMs?: number;
  readonly reservationTimeoutMs?: number;
  readonly streams?: TransferStreamSlots;
  readonly now?: () => number;
}
interface Authority {
  readonly caller: Caller;
  readonly owner: TransferOwner;
  readonly runId: string;
  readonly pwd: string;
}
interface Entry {
  readonly authority: Authority;
  readonly ref: ResourceRef;
  readonly stopped: AbortController;
  readonly closure: ReturnType<typeof Promise.withResolvers<void>>;
  record: TransferRecord;
  preparing: Promise<void>;
  active?: Promise<void>;
  settling?: Promise<void>;
  published: boolean;
  channel?: TransferChannelBinding;
  request?: TransferRequest;
  prepared?: PreparedUpload;
  artifact?: ArtifactRecord;
  claimTimer?: NodeJS.Timeout;
  activeTimer?: NodeJS.Timeout;
  reservation?: Reservation;
  stop?: TransferStop;
  file?: UploadFileReceipt;
  fileCommitted: boolean;
  cleanupConfirmed: boolean;
  failure?: JsonObject;
  fault?: unknown;
}
interface Reservation {
  readonly identity: TransferReservation;
  readonly entry: Entry;
  readonly scope: TransferClaimScope;
  readonly permit: StreamPermit;
  timer: NodeJS.Timeout;
  consumed: boolean;
  released: boolean;
}
const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
]);
const statuses = new Set([
  "preparing",
  "pending",
  "transferring",
  "cancelling",
  ...terminal,
]);
const denials = new Set([
  "forbidden",
  "permission_denied",
  "access_denied",
  "resource_forbidden",
  "path_not_allowed",
  "unauthorized",
]);
const iso = (value: number | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();
function data<T>(value: T, max = 16384): T {
  return JSON.parse(canonicalJson(value, max)) as T;
}
function keys(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  requireCondition(
    isPlainRecord(value) &&
      Object.keys(value).every((key) => allowed.includes(key)),
    "invalid_arguments",
    "Only the documented transfer parameters are accepted.",
  );
}
function text(value: unknown, maximum = 4096): asserts value is string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= maximum &&
      !/[\0\r\n]/.test(value),
    "invalid_arguments",
    "A transfer parameter must be bounded nonempty text.",
  );
}
function mime(value: unknown): string {
  text(value, 256);
  try {
    return new MIMEType(value).toString();
  } catch {
    throw new AgentError(
      "invalid_arguments",
      "The transfer MIME type is invalid.",
    );
  }
}
function safeError(cause: unknown, fallback = "transfer_failed"): JsonObject {
  // Causes and transport messages can contain credential-bearing URLs. Persist only known codes.
  const code =
    cause instanceof AgentError && /^[a-z][a-z0-9_]{0,95}$/.test(cause.code)
      ? cause.code
      : fallback;
  return {
    code,
    message:
      "The transfer did not complete; inspect its retained state and closure diagnostics.",
    ...(cause instanceof TransferIoError
      ? {
          details: {
            fileCommitted: cause.fileCommitted,
            cleanupConfirmed: cause.cleanupConfirmed,
          },
        }
      : {}),
  };
}

/** Agent/profile Core coordinator. Extension factories receive only bind()'s public service. */
export class TransferServices extends EventEmitter {
  readonly streams: TransferStreamSlots;
  #instance: ResourceInstance;
  #instanceController = new AbortController();
  #entries = new Map<string, Entry>();
  #reservations = new WeakMap<TransferReservation, Reservation>();
  #maxBytes: number;
  #claimMs: number;
  #activeMs: number;
  #reservationMs: number;
  #now: () => number;
  #origin: ContributionOrigin;
  constructor(
    readonly store: SqliteStore,
    readonly resources: ResourceManager,
    readonly artifacts: ArtifactStore,
    readonly offers: TransferOfferDelivery,
    readonly channels: TransferChannelPort,
    options: TransferServicesOptions,
  ) {
    super();
    this.setMaxListeners(0);
    this.#origin = data(options.origin);
    requireCondition(
      this.#origin.type === "platform" &&
        this.#origin.namespace === "transfer" &&
        this.#origin.owner &&
        this.#origin.version &&
        this.#origin.revision,
      "invalid_transfer_options",
      "Transfer resources need their actual Core platform source.",
    );
    requireCondition(
      resources.store === store,
      "invalid_transfer_options",
      "Transfers and managed resources must share one profile authority.",
    );
    requireCondition(
      artifacts.root === store.root &&
        artifacts.agentId === store.binding.agentId &&
        offers.profileRoot === store.root &&
        offers.agentId === store.binding.agentId,
      "invalid_transfer_options",
      "Transfers, artifacts and offers must share the actual Agent/profile.",
    );
    this.#maxBytes = options.maxBytes ?? 256 * 1024 ** 2;
    this.#claimMs = options.claimTimeoutMs ?? 10 * 60_000;
    this.#activeMs = options.activeTimeoutMs ?? 30 * 60_000;
    this.#reservationMs = options.reservationTimeoutMs ?? 5000;
    for (const [value, maximum] of [
      [this.#maxBytes, 20 * 1024 ** 3],
      [this.#claimMs, 600_000],
      [this.#activeMs, 1_800_000],
      [this.#reservationMs, 30_000],
    ])
      requireCondition(
        Number.isSafeInteger(value) && value! > 0 && value! <= maximum!,
        "invalid_transfer_options",
        "Transfer budgets and deadlines must be bounded trusted Agent configuration.",
      );
    const wallNow = options.now ?? Date.now;
    let monotonicAt = performance.now();
    let logicalAt = wallNow();
    this.#now = () => {
      const monotonicNow = performance.now();
      // Like RunEngine, elapsed monotonic time is a lower bound when the
      // wall clock moves backwards. Retain fractions internally so frequent
      // progress/checks cannot discard elapsed time, and retain observed
      // forward jumps when the wall clock subsequently returns.
      logicalAt = Math.max(wallNow(), logicalAt + monotonicNow - monotonicAt);
      monotonicAt = monotonicNow;
      return Math.floor(logicalAt);
    };
    this.streams = options.streams ?? new TransferStreamSlots();
    this.#instance = resources.instance(this.#origin, {
      signal: this.#instanceController.signal,
      assertActive: () => this.#instanceController.signal.throwIfAborted(),
      authorize() {},
    });
  }
  #owner(caller: Caller): TransferOwner {
    return {
      callerKey: callerKey(caller),
      owner: {
        type: this.#origin.type,
        owner: this.#origin.owner,
        namespace: this.#origin.namespace,
      },
    };
  }
  #current(
    scope: Pick<TransferScope, "signal" | "assertCurrent" | "authorize">,
    access: string,
    value: string,
  ): void {
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    authorizeCall(() => scope.authorize({ type: "transfer", value, access }));
  }
  #authority(scope: TransferScope): Authority {
    const caller = scope.context.caller;
    requireCondition(
      isPlainRecord(caller) &&
        typeof caller.principalId === "string" &&
        caller.principalId.length > 0 &&
        typeof caller.clientId === "string" &&
        caller.clientId.length > 0 &&
        (caller.grantId === undefined || typeof caller.grantId === "string"),
      "invalid_transfer_context",
      "Transfers require the verified current caller.",
    );
    requireCondition(
      scope.context.agentId === this.store.binding.agentId &&
        typeof scope.context.pwd === "string",
      "invalid_transfer_context",
      "Transfers require the actual Agent and working directory.",
    );
    const runId = scope.runId ?? scope.context.runId;
    text(runId, 128);
    const fixed = fixedCaller(caller as unknown as Caller),
      owner = this.#owner(fixed),
      run = this.store.getRun(runId);
    requireCondition(
      run.bootId === this.store.bootId &&
        run.callerKey === owner.callerKey &&
        run.endedAt === null &&
        !run.stop,
      "invalid_transfer_context",
      "The verified invocation must belong to a live run on this Agent boot.",
    );
    requireCondition(
      path.isAbsolute(scope.context.pwd),
      "invalid_transfer_context",
      "The transfer working directory must be the trusted absolute invocation directory.",
    );
    return { caller: fixed, owner, runId, pwd: scope.context.pwd };
  }
  #target(scope: Pick<TransferScope, "authorize">, row: TransferRecord): void {
    const target = row.metadata.target;
    if (target.path)
      authorizeCall(() =>
        scope.authorize({
          type: "path",
          value: target.path!,
          access: row.direction === "upload" ? "write" : "read",
        }),
      );
    if (target.resourceUri)
      authorizeCall(() =>
        scope.authorize({
          type: "resource",
          value: target.resourceUri!,
          access: "read",
        }),
      );
  }
  #snapshot(row: TransferRecord): TransferSnapshot {
    const target = row.metadata.target;
    const live = this.#entries.get(row.transferId);
    const file =
      row.metadata.file ?? (live?.fileCommitted ? live.file : undefined);
    return data({
      transferId: row.transferId,
      direction: row.direction,
      status: row.status,
      runId: row.originRunId,
      contextId: row.metadata.origin?.contextId ?? null,
      projectId: row.metadata.origin?.projectId ?? null,
      ...(row.direction === "upload" && target.path
        ? { path: target.path }
        : {}),
      ...(row.direction === "download" && target.resourceUri
        ? {
            resource: {
              uri: target.resourceUri,
              name: target.name!,
              mimeType: target.mimeType!,
              size: target.size!,
            },
          }
        : {}),
      maxBytes: row.metadata.maxBytes ?? null,
      progress: {
        bytesTransferred: row.bytesTransferred,
        totalBytes:
          row.direction === "download"
            ? (target.size ?? null)
            : (target.expectedSize ?? row.metadata.file?.size ?? null),
      },
      createdAt: iso(row.createdAt)!,
      expiresAt: iso(row.claimDeadlineAt),
      startedAt: iso(row.metadata.startedAt),
      deadlineAt: iso(row.transferDeadlineAt),
      finishedAt: iso(row.endedAt),
      ...(file ? { file: { ...file } } : {}),
      error:
        row.metadata.error ??
        (live?.fault
          ? safeError(undefined, "transfer_persistence_failed")
          : (live?.failure ??
            (row.status === "interrupted"
              ? {
                  code: "transfer_interrupted",
                  message:
                    "The previous Agent boot ended; no live stream controller was restored.",
                }
              : null))),
    }) as TransferSnapshot;
  }
  #changed(entry: Entry): void {
    this.emit("change", entry.record.transferId);
  }
  #refresh(entry: Entry): TransferRecord {
    return (entry.record = this.store.getTransfer(
      entry.record.transferId,
      entry.authority.owner,
    ));
  }
  #fault(entry: Entry, cause: unknown): void {
    entry.fault ??= cause;
    this.emit("fault", {
      transferId: entry.record.transferId,
      error: safeError(cause, "transfer_persistence_failed"),
    });
    this.#changed(entry);
  }
  #ioScope(
    entry: Entry,
    current: () => void,
    authorize: TransferScope["authorize"],
    signal: AbortSignal,
  ): TransferIoScope {
    return {
      pwd: entry.authority.pwd,
      signal,
      assertCurrent: current,
      authorize: (target) =>
        authorizeCall(() =>
          authorize({
            type: target.uri ? "resource" : "path",
            value: target.uri ?? target.path!,
            access: target.access,
          }),
        ),
      onProgress: (bytes) => {
        const row = this.#refresh(entry);
        entry.record = this.store.progressTransfer(
          row.transferId,
          entry.authority.owner,
          { revision: row.revision, bytesTransferred: bytes },
          this.#now(),
        );
        entry.ref.report({
          state: entry.record.status,
          bytesTransferred: bytes,
        });
        this.#changed(entry);
      },
    };
  }
  #artifactScope(
    entry: Entry,
    current: () => void,
    authorize: TransferScope["authorize"],
    signal: AbortSignal,
  ): ArtifactScope {
    return {
      pwd: entry.authority.pwd,
      ownerKey: entry.authority.owner.callerKey,
      runId: entry.authority.runId,
      signal,
      assertCurrent: current,
      authorize: (target) => {
        if (target.path)
          authorizeCall(() =>
            authorize({ type: "path", value: target.path!, access: "read" }),
          );
        if (target.uri)
          authorizeCall(() =>
            authorize({ type: "resource", value: target.uri!, access: "read" }),
          );
      },
    };
  }
  #timer(
    callback: () => void,
    at: number,
    replace: (timer: NodeJS.Timeout) => void,
  ): NodeJS.Timeout {
    const timer = setTimeout(
      () => {
        // A native timer can wake slightly early. Wait only the remaining
        // duration and keep the owner's clearTimeout handle current.
        if (this.#now() < at) {
          replace(this.#timer(callback, at, replace));
          return;
        }
        callback();
      },
      Math.max(1, at - this.#now()),
    );
    timer.unref();
    return timer;
  }
  #release(reservation: Reservation): void {
    if (reservation.released) return;
    reservation.released = true;
    clearTimeout(reservation.timer);
    reservation.permit.release();
    if (reservation.entry.reservation === reservation)
      reservation.entry.reservation = undefined;
  }
  #requestStop(entry: Entry, reason: TransferStop): boolean {
    if (terminal.has(entry.record.status)) return false;
    if (entry.stop) return entry.stop.kind === reason.kind;
    let accepted = false;
    try {
      const row = this.#refresh(entry);
      const requested = this.store.requestTransferCancel(
        row.transferId,
        entry.authority.owner,
        { revision: row.revision, reason },
        this.#now(),
      );
      entry.record = requested.transfer;
      if (!requested.accepted) return false;
      accepted = true;
      entry.stop = entry.record.metadata.stop ?? reason;
    } catch (cause) {
      this.#fault(entry, cause);
      entry.stop = reason;
    }
    entry.stopped.abort(
      new AgentError(entry.stop.code, "The independent transfer is stopping."),
    );
    clearTimeout(entry.claimTimer);
    clearTimeout(entry.activeTimer);
    if (entry.reservation && !entry.reservation.consumed)
      this.#release(entry.reservation);
    this.offers.forget(
      entry.record.transferId,
      reason.kind === "expired" ? "expired" : "unavailable",
    );
    this.#changed(entry);
    void this.#settle(entry).catch((cause) => this.#fault(entry, cause));
    return accepted;
  }
  async #settle(entry: Entry): Promise<void> {
    if (entry.settling) return entry.settling;
    const settle = async () => {
      // Cancellation can arrive while a channel is still being prepared. Wait
      // until its real binding is known before revoking, never abandon it late.
      await entry.preparing.catch(() => {});
      const closing = entry.channel
        ? this.channels.revoke(
            entry.channel,
            entry.stop ?? { kind: "failure", code: "transfer_completed" },
          )
        : Promise.resolve();
      const outcomes = await Promise.allSettled([
        closing,
        entry.active ?? Promise.resolve(),
      ]);
      const failedClosure = outcomes.find((item) => item.status === "rejected");
      if (failedClosure?.status === "rejected") {
        entry.cleanupConfirmed = false;
        entry.failure ??= safeError(
          failedClosure.reason,
          "transfer_cleanup_unconfirmed",
        );
      }
      if (!entry.cleanupConfirmed) {
        // Keep physical closure unresolved. ResourceManager will honestly retain
        // an unconfirmed resource instead of freeing capacity or reporting done.
        this.#fault(
          entry,
          new AgentError(
            "transfer_cleanup_unconfirmed",
            "Transfer I/O or channel closure was not confirmed.",
          ),
        );
        return;
      }
      entry.closure.resolve();
      await entry.closure.promise; // Manager's already-registered close observer runs first.
      const row = this.#refresh(entry);
      const status: TransferTerminalStatus =
        entry.stop?.kind === "cancel"
          ? "cancelled"
          : entry.stop?.kind === "expired"
            ? "expired"
            : entry.stop || entry.failure
              ? "failed"
              : "succeeded";
      entry.record = this.store.finishTransfer(
        row.transferId,
        entry.authority.owner,
        {
          revision: row.revision,
          status,
          cleanupConfirmed: true,
          ...(entry.fileCommitted
            ? { fileCommitted: true, file: entry.file }
            : {}),
          ...(entry.failure
            ? { error: entry.failure }
            : entry.stop
              ? {
                  error: {
                    code: entry.stop.code,
                    message:
                      "The independent transfer stopped before successful completion.",
                  },
                }
              : {}),
        },
        this.#now(),
      );
      if (entry.record.endedAt === null)
        throw new AgentError(
          "transfer_cleanup_unconfirmed",
          "The resource authority did not confirm physical closure.",
        );
      clearTimeout(entry.claimTimer);
      clearTimeout(entry.activeTimer);
      this.offers.forget(row.transferId, "terminal");
      this.#entries.delete(row.transferId);
      this.#changed(entry);
    };
    entry.settling = settle();
    return entry.settling;
  }
  async #prepare(
    entry: Entry,
    input: Record<string, unknown>,
    scope: TransferScope,
  ): Promise<void> {
    const check = () => {
      this.#current(
        scope,
        entry.record.direction === "upload" ? "createUpload" : "createDownload",
        "new",
      );
      entry.ref.signal.throwIfAborted();
      entry.stopped.signal.throwIfAborted();
    };
    const signal = AbortSignal.any([
      scope.signal,
      entry.ref.signal,
      entry.stopped.signal,
    ]);
    const authorization = (target: AccessTarget) =>
      authorizeCall(() => scope.authorize(target));
    let target: TransferTarget;
    if (entry.record.direction === "upload") {
      entry.prepared = await prepareUpload(
        input as unknown as Parameters<typeof prepareUpload>[0],
        this.#ioScope(entry, check, authorization, signal),
        { maxBytes: this.#maxBytes },
      );
      target = {
        path: entry.prepared.path,
        mimeType: entry.prepared.mimeType,
        ...(entry.prepared.expectedSize === undefined
          ? {}
          : { expectedSize: entry.prepared.expectedSize }),
        ...(entry.prepared.expectedSha256 === undefined
          ? {}
          : { expectedSha256: entry.prepared.expectedSha256 }),
      };
    } else {
      const artifactScope = this.#artifactScope(
        entry,
        check,
        authorization,
        signal,
      );
      if (input.path) {
        const permit = this.streams.tryAcquire();
        requireCondition(
          permit,
          "transfer_busy",
          "All four actual file streams are occupied; no work was queued.",
        );
        try {
          entry.artifact = await this.artifacts.register(
            {
              path: input.path as string,
              ...(input.name ? { name: input.name as string } : {}),
              ...(input.mimeType ? { mimeType: input.mimeType as string } : {}),
            },
            artifactScope,
            undefined,
            { maxBytes: this.#maxBytes },
          );
        } finally {
          permit.release();
        }
      } else
        entry.artifact = await this.artifacts.metadata(
          input.uri as string,
          artifactScope,
        );
      requireCondition(
        entry.artifact.size <= this.#maxBytes,
        "resource_exhausted",
        "The fixed artifact exceeds the accepted transfer budget.",
      );
      if (input.mimeType)
        requireCondition(
          mime(input.mimeType) === entry.artifact.mimeType,
          "invalid_arguments",
          "A download hint cannot replace the registered resource MIME type.",
        );
      target = {
        resourceUri: entry.artifact.uri,
        name: (input.name as string | undefined) ?? entry.artifact.name,
        mimeType: entry.artifact.mimeType,
        size: entry.artifact.size,
        sha256: entry.artifact.sha256,
      };
    }
    check();
    const claimDeadlineAt = Math.min(
      this.#now() + this.#claimMs,
      entry.artifact ? Date.parse(entry.artifact.expiresAt) : Infinity,
    );
    requireCondition(
      claimDeadlineAt > this.#now(),
      "resource_expired",
      "The fixed artifact expired before channel preparation.",
    );
    const channel: TransferChannelBinding = Object.freeze({
      binding: Object.freeze({
        ...this.store.binding,
        bootId: this.store.bootId,
      }),
      transferId: entry.record.transferId,
      resourceId: entry.ref.id,
      caller: entry.authority.caller,
      direction: entry.record.direction,
      claimDeadlineAt,
      maxBytes: this.#maxBytes,
      target: Object.freeze(target),
    });
    // Set before awaiting: even a prepare rejection can have created a real
    // remote channel whose cleanup must be attempted and confirmed.
    entry.channel = channel;
    entry.request = await this.channels.prepare(channel, signal);
    check();
    requireCondition(
      entry.request.method ===
        (entry.record.direction === "upload" ? "PUT" : "GET") &&
        Date.parse(entry.request.expiresAt) === claimDeadlineAt,
      "invalid_transfer_channel",
      "The actual channel must use the fixed direction and claim deadline.",
    );
    this.resources.commitHandoff(entry.ref, (checked) => {
      check();
      const published = this.store.publishTransferPending(
        entry.record.transferId,
        entry.authority.owner,
        {
          revision: entry.record.revision,
          resourceRevision: checked.revision,
          claimDeadlineAt,
          metadata: { target },
        },
        this.#now(),
      );
      entry.record = published.transfer;
      entry.published = true;
      return published.resource;
    });
    entry.claimTimer = this.#timer(
      () =>
        this.#requestStop(entry, { kind: "expired", code: "transfer_expired" }),
      claimDeadlineAt,
      (timer) => {
        entry.claimTimer = timer;
      },
    );
    this.#changed(entry);
  }
  async #create(
    scope: TransferScope,
    authority: Authority,
    direction: "upload" | "download",
    raw: unknown,
  ) {
    const access = direction === "upload" ? "createUpload" : "createDownload";
    this.#current(scope, access, "new");
    requireCondition(
      authority.caller.grantId && authority.caller.grantId.length > 0,
      "transfer_grant_required",
      "Creating a transfer channel requires the verified Cloud Grant.",
    );
    const input = data(raw);
    keys(
      input,
      direction === "upload"
        ? ["path", "expectedSize", "expectedSha256", "mimeType"]
        : ["path", "uri", "name", "mimeType"],
    );
    if (direction === "upload" || input.path !== undefined) text(input.path);
    if (direction === "download") {
      requireCondition(
        (input.path === undefined) !== (input.uri === undefined),
        "invalid_arguments",
        "A download uses exactly one path or registered resource URI.",
      );
      if (input.uri !== undefined) text(input.uri);
      if (input.name !== undefined) {
        text(input.name, 512);
        requireCondition(
          path.basename(input.name) === input.name &&
            !input.name.includes("\\") &&
            ![".", ".."].includes(input.name),
          "invalid_arguments",
          "A download name must be a single file name.",
        );
      }
    }
    if (input.mimeType !== undefined) input.mimeType = mime(input.mimeType);
    if (input.expectedSize !== undefined)
      requireCondition(
        typeof input.expectedSize === "number" &&
          Number.isSafeInteger(input.expectedSize) &&
          input.expectedSize >= 0 &&
          input.expectedSize <= this.#maxBytes,
        "resource_exhausted",
        "The declared upload size exceeds the accepted Agent budget.",
      );
    if (input.expectedSha256 !== undefined)
      requireCondition(
        typeof input.expectedSha256 === "string" &&
          /^[0-9a-f]{64}$/.test(input.expectedSha256),
        "invalid_arguments",
        "An expected SHA-256 must be lowercase hexadecimal.",
      );
    const closure = Promise.withResolvers<void>(),
      stopped = new AbortController();
    let entry: Entry | undefined;
    const value: ManagedResource = {
      closed: closure.promise,
      dispose: () => {
        stopped.abort(
          new AgentError(
            "transfer_cancelled",
            "The owning resource requested cancellation.",
          ),
        );
        if (entry)
          this.#requestStop(entry, {
            kind: "cancel",
            code: "transfer_cancelled",
          });
        else closure.resolve();
      },
    };
    const service = this.#instance.bind({
      runId: authority.runId,
      signal: scope.signal,
      assertActive: () => this.#current(scope, access, "new"),
      authorize: () => this.#current(scope, access, "new"),
    });
    const ref = await service.register({ kind: "transfer", value });
    try {
      const record = this.store.createTransfer(
        authority.owner,
        {
          resourceId: ref.id,
          runId: authority.runId,
          direction,
          maxBytes: this.#maxBytes,
          metadata: { target: {} },
        },
        this.#now(),
      );
      entry = {
        authority,
        ref,
        stopped,
        closure,
        record,
        preparing: Promise.resolve(),
        published: false,
        fileCommitted: false,
        cleanupConfirmed: true,
      };
      this.#entries.set(record.transferId, entry);
      ref.signal.addEventListener(
        "abort",
        () => {
          if (!entry!.settling && !terminal.has(entry!.record.status))
            this.#requestStop(entry!, {
              kind: "cancel",
              code: "transfer_cancelled",
            });
        },
        { once: true },
      );
      entry.preparing = this.#prepare(entry, input, scope);
      await entry.preparing;
    } catch (cause) {
      if (entry && !entry.published) {
        entry.failure = safeError(cause);
        this.#requestStop(entry, {
          kind: "failure",
          code: String(entry.failure.code),
        });
        await this.#settle(entry).catch((error) => this.#fault(entry!, error));
      } else if (!entry) closure.resolve();
      throw cause;
    }
    // Handoff is committed. A later delivery failure cannot roll back the
    // independent resource, revoke a valid channel, or replay file preparation.
    const deliveryScope = {
      ownerKey: authority.owner.callerKey,
      grantId: authority.caller.grantId,
      signal: scope.signal,
      assertCurrent: () => this.#current(scope, access, "new"),
      authorizeTarget: scope.authorize.bind(scope),
    };
    try {
      return this.offers.issue(
        this.#snapshot(entry.record) as unknown as IssuedTransferSnapshot,
        entry.request!,
        deliveryScope,
      );
    } catch (cause) {
      throw new AgentError(
        "transfer_delivery_failed",
        "The independently managed channel exists, but its short-lived Offer could not be delivered. Query or cancel the retained identity.",
        { transferId: entry.record.transferId, status: entry.record.status },
        { cause },
      );
    }
  }
  bind(scope: TransferScope): TransferService {
    const authority = this.#authority(scope);
    const read = (id: string, access: "get" | "list" | "cancel") => {
      this.#current(scope, access, id);
      const row = this.store.getTransfer(id, authority.owner);
      this.#target(scope, row);
      return row;
    };
    return Object.freeze({
      createUpload: async (
        input: Parameters<TransferService["createUpload"]>[0],
      ) =>
        (await this.#create(scope, authority, "upload", input)) as UploadOffer,
      createDownload: async (
        input: Parameters<TransferService["createDownload"]>[0],
      ) =>
        (await this.#create(
          scope,
          authority,
          "download",
          input,
        )) as DownloadOffer,
      get: async (id: string, options: { waitMs?: number } = {}) => {
        keys(options, ["waitMs"]);
        const wait = options.waitMs ?? 0;
        requireCondition(
          Number.isSafeInteger(wait) && wait >= 0 && wait <= 30000,
          "invalid_arguments",
          "Transfer observation is bounded to thirty seconds.",
        );
        let row = read(id, "get");
        if (wait && !terminal.has(row.status)) {
          await new Promise<void>((resolve, reject) => {
            const finish = (cause?: unknown) => {
              clearTimeout(timer);
              this.off("change", changed);
              scope.signal.removeEventListener("abort", aborted);
              cause ? reject(cause) : resolve();
            };
            const changed = (value: string) => {
              if (value === id) finish();
            };
            const aborted = () => finish(scope.signal.reason);
            const timer = setTimeout(() => finish(), wait);
            this.on("change", changed);
            scope.signal.addEventListener("abort", aborted, { once: true });
            if (scope.signal.aborted) aborted();
          });
          row = read(id, "get");
        }
        return this.#snapshot(row);
      },
      list: async (raw = {}) => {
        this.#current(scope, "list", "new");
        const query = data(raw);
        keys(query, ["direction", "status", "runId", "limit", "cursor"]);
        requireCondition(
          query.direction === undefined ||
            query.direction === "upload" ||
            query.direction === "download",
          "invalid_arguments",
          "Transfer direction is upload or download.",
        );
        requireCondition(
          query.status === undefined ||
            (typeof query.status === "string" && statuses.has(query.status)),
          "invalid_arguments",
          "The transfer status filter is invalid.",
        );
        if (query.runId !== undefined) text(query.runId, 128);
        if (query.cursor !== undefined) text(query.cursor, 4096);
        const limit = query.limit ?? 20;
        requireCondition(
          typeof limit === "number" &&
            Number.isSafeInteger(limit) &&
            limit > 0 &&
            limit <= 100,
          "invalid_arguments",
          "Transfer page sizes are between one and one hundred.",
        );
        const filter = {
          ...(query.direction === undefined
            ? {}
            : { direction: query.direction }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.runId === undefined ? {} : { runId: query.runId }),
        } as Parameters<SqliteStore["scanTransfers"]>[1];
        let cursor = query.cursor as string | undefined,
          scanned = 0,
          bytes = 0;
        const transfers: TransferSnapshot[] = [];
        while (scanned < 1000) {
          this.#current(scope, "list", "new");
          const page = this.store.scanTransfers(
            authority.owner,
            filter,
            Math.min(100, 1000 - scanned),
            cursor,
          );
          for (let index = 0; index < page.items.length; index++) {
            const item = page.items[index]!,
              previous = cursor;
            cursor = item.cursor;
            scanned++;
            try {
              read(item.record.transferId, "list");
            } catch (cause) {
              if (cause instanceof AgentError && denials.has(cause.code))
                continue;
              throw cause;
            }
            const snapshot = this.#snapshot(item.record),
              size = Buffer.byteLength(canonicalJson(snapshot));
            if (bytes + size > 60 * 1024)
              return { transfers, nextCursor: previous ?? null };
            bytes += size;
            transfers.push(snapshot);
            if (transfers.length === limit)
              return {
                transfers,
                nextCursor:
                  index < page.items.length - 1 || page.more ? cursor : null,
              };
          }
          if (!page.more) return { transfers, nextCursor: null };
        }
        return { transfers, nextCursor: cursor ?? null };
      },
      cancel: async (id: string) => {
        const row = read(id, "cancel");
        if (terminal.has(row.status))
          return { accepted: false, transfer: this.#snapshot(row) };
        const entry = this.#entries.get(id);
        requireCondition(
          entry,
          "transfer_control_unavailable",
          "No live controller exists for this retained transfer; no task was reconstructed.",
        );
        const accepted = this.#requestStop(entry, {
          kind: "cancel",
          code: "transfer_cancelled",
        });
        if (entry.fault)
          throw new AgentError(
            "transfer_persistence_failed",
            "The cancellation could not be confirmed by the transfer authority.",
            { transferId: id },
          );
        return { accepted, transfer: this.#snapshot(this.#refresh(entry)) };
      },
    });
  }
  /** Used only by the Core delivery authority; a snapshot alone grants no access. */
  authorizeDelivery(
    scope: TransferOfferScope,
    snapshot: IssuedTransferSnapshot,
  ): void {
    scope.signal?.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    const entry = this.#entries.get(snapshot.transferId);
    requireCondition(
      entry &&
        entry.published &&
        entry.authority.owner.callerKey === scope.ownerKey &&
        entry.authority.caller.grantId === scope.grantId &&
        entry.record.status === "pending" &&
        !entry.stop &&
        !entry.fault &&
        entry.channel &&
        entry.channel.claimDeadlineAt > this.#now(),
      "transfer_delivery_unavailable",
      "The current owner/Grant has no live unconsumed transfer channel.",
    );
    const row = this.#refresh(entry);
    requireCondition(
      row.status === "pending" &&
        row.claimDeadlineAt! > this.#now() &&
        this.store.getResource(row.resourceId).closedAt === null,
      "transfer_delivery_unavailable",
      "The transfer is no longer live and pending.",
    );
    requireCondition(
      scope.authorizeTarget,
      "transfer_delivery_authorization_unavailable",
      "Delivery requires the current transfer and target authority, not a retained creator closure.",
    );
    authorizeCall(() =>
      scope.authorizeTarget!({
        type: "transfer",
        value: row.transferId,
        access: row.direction === "upload" ? "createUpload" : "createDownload",
      }),
    );
    this.#target({ authorize: scope.authorizeTarget }, row);
  }
  #claimCurrent(entry: Entry, scope: TransferClaimScope): void {
    scope.signal.throwIfAborted();
    entry.stopped.signal.throwIfAborted();
    entry.ref.signal.throwIfAborted();
    requireCondition(
      scope.binding.agentId === this.store.binding.agentId &&
        scope.binding.profile === this.store.binding.profile &&
        scope.binding.cloudEnvironment ===
          this.store.binding.cloudEnvironment &&
        scope.binding.bootId === this.store.bootId &&
        callerKey(scope.caller) === entry.authority.owner.callerKey &&
        scope.caller.grantId === entry.authority.caller.grantId,
      "transfer_claim_forbidden",
      "The fresh claimant must match the actual Agent/profile/boot and original owner/Grant.",
    );
    this.#current(
      scope,
      entry.record.direction === "upload" ? "createUpload" : "createDownload",
      entry.record.transferId,
    );
    this.#target(scope, this.#refresh(entry));
    requireCondition(
      !entry.fault,
      "transfer_persistence_failed",
      "The transfer authority has an unresolved persistence failure.",
    );
  }
  reserveClaim(id: string, scope: TransferClaimScope): TransferReservation {
    const entry = this.#entries.get(id);
    requireCondition(
      entry,
      "transfer_control_unavailable",
      "No live transfer controller exists on this Agent boot.",
    );
    this.#claimCurrent(entry, scope);
    requireCondition(
      entry.record.status === "pending" &&
        !entry.reservation &&
        entry.record.claimDeadlineAt! > this.#now(),
      "transfer_not_claimable",
      "The offer is expired, already reserved, or no longer pending.",
    );
    const permit = this.streams.tryAcquire();
    requireCondition(
      permit,
      "transfer_busy",
      "All four actual streams are occupied; the channel must remain unconsumed.",
    );
    const identity = Object.freeze({ transferId: id });
    const reservation: Reservation = {
      identity,
      entry,
      scope,
      permit,
      consumed: false,
      released: false,
      timer: undefined as unknown as NodeJS.Timeout,
    };
    Object.assign(reservation, {
      timer: this.#timer(
        () => {
          if (!reservation.consumed) this.#release(reservation);
        },
        Math.min(
          entry.record.claimDeadlineAt!,
          this.#now() + this.#reservationMs,
        ),
        (timer) => {
          reservation.timer = timer;
        },
      ),
    });
    this.#reservations.set(identity, reservation);
    entry.reservation = reservation;
    return identity;
  }
  releaseReservation(identity: TransferReservation): void {
    const reservation = this.#reservations.get(identity);
    requireCondition(
      reservation && !reservation.consumed,
      "invalid_transfer_reservation",
      "Only an actual unstarted Core reservation can be released.",
    );
    this.#release(reservation);
  }
  async commitClaim(
    identity: TransferReservation,
    io: TransferClaimIo,
  ): Promise<TransferSnapshot> {
    const reservation = this.#reservations.get(identity);
    requireCondition(
      reservation && !reservation.released && !reservation.consumed,
      "invalid_transfer_reservation",
      "The actual unstarted Core reservation is required.",
    );
    const { entry, scope } = reservation;
    try {
      this.#claimCurrent(entry, scope);
      requireCondition(
        entry.record.direction === "upload" ? "upload" in io : "download" in io,
        "invalid_transfer_channel",
        "The actual binary endpoint must match the channel direction.",
      );
      const row = this.#refresh(entry);
      entry.record = this.store.claimTransfer(
        row.transferId,
        entry.authority.owner,
        {
          revision: row.revision,
          transferDeadlineAt: this.#now() + this.#activeMs,
        },
        this.#now(),
      );
    } catch (cause) {
      this.#release(reservation);
      throw cause;
    }
    reservation.consumed = true;
    clearTimeout(reservation.timer);
    clearTimeout(entry.claimTimer);
    this.offers.forget(entry.record.transferId, "consumed");
    entry.activeTimer = this.#timer(
      () =>
        this.#requestStop(entry, { kind: "timeout", code: "transfer_timeout" }),
      entry.record.transferDeadlineAt!,
      (timer) => {
        entry.activeTimer = timer;
      },
    );
    const signal = AbortSignal.any([
      scope.signal,
      entry.ref.signal,
      entry.stopped.signal,
    ]);
    const check = () => this.#claimCurrent(entry, scope);
    entry.active = (async () => {
      try {
        const actual = this.#ioScope(
          entry,
          check,
          scope.authorize.bind(scope),
          signal,
        );
        if ("upload" in io) {
          const file = await receiveUpload(io.upload, entry.prepared!, actual, {
            maxBytes: entry.record.metadata.maxBytes!,
            ...(io.contentLength === undefined
              ? {}
              : { contentLength: io.contentLength }),
          });
          entry.fileCommitted = true;
          entry.file = file;
          const row = this.#refresh(entry);
          entry.record = this.store.progressTransfer(
            row.transferId,
            entry.authority.owner,
            {
              revision: row.revision,
              bytesTransferred: file.size,
              fileCommitted: true,
              file,
            },
            this.#now(),
          );
        } else {
          const source = await this.artifacts.open(
            entry.artifact!.uri,
            this.#artifactScope(
              entry,
              check,
              scope.authorize.bind(scope),
              signal,
            ),
          );
          await sendDownload(source, io.download, actual, {
            maxBytes: entry.record.metadata.maxBytes!,
          });
        }
        await io.closed;
        check();
      } catch (cause) {
        if (cause instanceof TransferIoError) {
          entry.fileCommitted ||= cause.fileCommitted;
          entry.file ??= cause.file;
          entry.cleanupConfirmed &&= cause.cleanupConfirmed;
          if (entry.fileCommitted) {
            try {
              const row = this.#refresh(entry);
              entry.record = this.store.progressTransfer(
                row.transferId,
                entry.authority.owner,
                {
                  revision: row.revision,
                  bytesTransferred: entry.file?.size ?? row.bytesTransferred,
                  fileCommitted: true,
                  ...(entry.file ? { file: entry.file } : {}),
                },
                this.#now(),
              );
            } catch (error) {
              this.#fault(entry, error);
            }
          }
        }
        entry.failure = safeError(cause);
        this.#requestStop(entry, {
          kind: "failure",
          code: String(entry.failure.code),
        });
        // The port must close the transport on failure/cancellation. A rejected
        // closure cannot be turned into a confirmed successful cleanup.
        try {
          await io.closed;
        } catch {
          entry.cleanupConfirmed = false;
        }
      } finally {
        this.#changed(entry);
      }
    })();
    try {
      await entry.active;
      await this.#settle(entry);
    } catch (cause) {
      this.#fault(entry, cause);
      throw cause;
    } finally {
      if (entry.cleanupConfirmed) this.#release(reservation);
    }
    return this.#snapshot(this.#refresh(entry));
  }
}
