import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Writable, addAbortSignal } from "node:stream";
import { finished } from "node:stream/promises";
import { MIMEType, types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { digest, newId } from "../contracts/json.js";
import type { ArtifactRecord } from "../results/artifacts.js";

export interface TransferIoScope {
  readonly pwd: string;
  /** The resource's independent signal after handoff, not the old invocation signal. */
  readonly signal: AbortSignal;
  assertCurrent(): void;
  authorize(target: {
    readonly path?: string;
    readonly uri?: string;
    readonly access: "read" | "write";
  }): void;
  /** Actual local file/socket writes; this does not prove the remote user saved bytes. */
  onProgress?(bytesTransferred: number): void;
}
export interface UploadTarget {
  readonly path: string;
  readonly expectedSize?: number;
  readonly expectedSha256?: string;
  readonly mimeType?: string;
}
export interface PreparedUpload {
  readonly path: string;
  readonly requestedPath: string;
  readonly parent: {
    readonly path: string;
    readonly dev: string;
    readonly ino: string;
  };
  readonly maxBytes: number;
  readonly expectedSize?: number;
  readonly expectedSha256?: string;
  readonly mimeType: string;
}
export interface UploadFileReceipt {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly revision: string;
}
export interface DownloadSource {
  readonly resource: Pick<ArtifactRecord, "uri" | "size" | "sha256">;
  readonly stream: Readable;
  /** Real source-handle closure, not merely a Readable close notification. */
  readonly closed: Promise<void>;
}
export interface DownloadReceipt {
  readonly bytesTransferred: number;
  readonly sha256: string;
  readonly outputFinished: true;
}
/** Core-only failure facts; an SDK facade maps this to safe public diagnostics. */
export class TransferIoError extends AgentError {
  constructor(
    code: string,
    message: string,
    readonly fileCommitted: boolean,
    readonly cleanupConfirmed: boolean,
    readonly file: UploadFileReceipt | undefined,
    cause: unknown,
  ) {
    super(code, message, { fileCommitted, cleanupConfirmed }, { cause });
  }
}
const maxPolicy = 20 * 1024 ** 3;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteBuffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, "byteOffset")!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;

function integer(value: unknown, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= maximum
  );
}
function policy(value: unknown): asserts value is number {
  requireCondition(
    integer(value, maxPolicy) && value > 0,
    "invalid_transfer_budget",
    "The trusted transfer limit must be positive bounded Agent configuration.",
  );
}
function check(
  scope: TransferIoScope,
  target: Parameters<TransferIoScope["authorize"]>[0],
): void {
  scope.signal.throwIfAborted();
  authorizeCall(() => scope.assertCurrent());
  authorizeCall(() => scope.authorize(Object.freeze(target)));
}
function progress(scope: TransferIoScope, bytes: number): void {
  const result: unknown = scope.onProgress?.(bytes);
  if (types.isPromise(result)) {
    void Promise.prototype.then.call(result, undefined, () => {});
    throw new AgentError(
      "transfer_progress_configuration",
      "Transfer progress reporting must finish synchronously.",
    );
  }
}
function mime(value: unknown): string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\0\r\n]/.test(value),
    "invalid_arguments",
    "The transfer MIME type must be bounded media-type text.",
  );
  try {
    return new MIMEType(value).toString();
  } catch (cause) {
    throw new AgentError(
      "invalid_arguments",
      "The transfer MIME type is invalid.",
      undefined,
      { cause },
    );
  }
}
function sameParent(
  info: BigIntStats,
  parent: PreparedUpload["parent"],
): boolean {
  return (
    info.isDirectory() &&
    String(info.dev) === parent.dev &&
    String(info.ino) === parent.ino
  );
}
function sameFile(
  left: BigIntStats,
  right: BigIntStats,
  beforeCommit = true,
): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    (!beforeCommit || left.ctimeNs === right.ctimeNs)
  );
}
async function parentCurrent(plan: PreparedUpload): Promise<void> {
  try {
    requireCondition(
      (await realpath(path.dirname(plan.requestedPath))) === plan.parent.path &&
        (await realpath(plan.parent.path)) === plan.parent.path &&
        sameParent(
          await lstat(plan.parent.path, { bigint: true }),
          plan.parent,
        ),
      "file_changed",
      "The authorized upload parent directory was moved, replaced or redirected.",
    );
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "file_changed",
      "The authorized upload parent directory is no longer available.",
      undefined,
      { cause },
    );
  }
}
async function absent(filename: string): Promise<void> {
  try {
    await lstat(filename);
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      Object.getOwnPropertyDescriptor(cause, "code")?.value === "ENOENT"
    )
      return;
    throw cause;
  }
  throw new AgentError(
    "path_already_exists",
    "The upload target already exists and cannot be replaced.",
  );
}
function copyChunk(value: unknown, remaining: number): Buffer {
  requireCondition(
    value &&
      typeof value === "object" &&
      !types.isProxy(value) &&
      types.isUint8Array(value),
    "invalid_transfer_chunk",
    "The transport must provide raw binary chunks.",
  );
  const length: number = byteLength.call(value);
  requireCondition(
    length <= remaining,
    "resource_exhausted",
    "The actual transfer bytes exceed the accepted limit.",
  );
  // A producer can reuse its chunk after an await; only private copied bytes
  // reach the file/socket and its matching hash calculation.
  return Buffer.from(
    new Uint8Array(byteBuffer.call(value), byteOffset.call(value), length),
  );
}
function errorFor(
  cause: unknown,
  signal: AbortSignal,
): { code: string; message: string } {
  if (signal.aborted)
    return signal.reason instanceof AgentError
      ? { code: signal.reason.code, message: signal.reason.message }
      : {
          code: "transfer_cancelled",
          message:
            "The transfer stopped before its remaining I/O could complete.",
        };
  if (cause instanceof AgentError)
    return { code: cause.code, message: cause.message };
  const code =
    cause && typeof cause === "object" && !types.isProxy(cause)
      ? Object.getOwnPropertyDescriptor(cause, "code")?.value
      : undefined;
  if (code === "EEXIST")
    return {
      code: "path_already_exists",
      message: "The upload target already exists and cannot be replaced.",
    };
  if (code === "ENOENT")
    return {
      code: "path_not_found",
      message: "A required transfer path is no longer available.",
    };
  if (
    [
      "forbidden",
      "permission_denied",
      "access_denied",
      "path_not_allowed",
      "resource_forbidden",
      "unauthorized",
    ].includes(code)
  )
    return {
      code,
      message: "Current authority does not permit this transfer I/O.",
    };
  return {
    code: "transfer_failed",
    message: "The actual transfer I/O did not finish successfully.",
  };
}
function closing(stream: Readable | Writable): {
  readonly closed: Promise<void>;
  dispose(): void;
} {
  if (stream.closed) return { closed: Promise.resolve(), dispose() {} };
  const result = Promise.withResolvers<void>();
  const error = () => {};
  const dispose = () => {
    stream.off("close", closed);
    stream.off("error", error);
  };
  const closed = () => {
    dispose();
    result.resolve();
  };
  stream.on("error", error);
  stream.once("close", closed);
  return { closed: result.promise, dispose };
}

/** Prepares target identity only; it does not create or reserve the user's file. */
export async function prepareUpload(
  target: UploadTarget,
  scope: TransferIoScope,
  options: { readonly maxBytes: number },
): Promise<PreparedUpload> {
  policy(options.maxBytes);
  requireCondition(
    typeof scope.pwd === "string" &&
      path.isAbsolute(scope.pwd) &&
      target &&
      typeof target.path === "string" &&
      target.path.length > 0 &&
      Buffer.byteLength(target.path) <= 262144 &&
      !target.path.includes("\0"),
    "invalid_arguments",
    "An upload needs an absolute working directory and bounded target path.",
  );
  requireCondition(
    target.expectedSize === undefined ||
      integer(target.expectedSize, maxPolicy),
    "invalid_arguments",
    "Expected size must be a non-negative safe byte count.",
  );
  requireCondition(
    target.expectedSize === undefined ||
      target.expectedSize <= options.maxBytes,
    "resource_exhausted",
    "The declared upload size exceeds its Agent limit.",
  );
  requireCondition(
    target.expectedSha256 === undefined ||
      (typeof target.expectedSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(target.expectedSha256)),
    "invalid_arguments",
    "Expected SHA-256 must contain 64 lowercase hexadecimal characters.",
  );
  const requestedPath = path.resolve(scope.pwd, target.path);
  check(scope, { access: "write", path: requestedPath });
  const parentPath = await realpath(path.dirname(requestedPath));
  const parent = await lstat(parentPath, { bigint: true });
  requireCondition(
    parent.isDirectory(),
    "invalid_arguments",
    "The upload parent must be an existing regular directory.",
  );
  const canonical = path.join(parentPath, path.basename(requestedPath));
  check(scope, { access: "write", path: canonical });
  await absent(canonical);
  const result: PreparedUpload = Object.freeze({
    path: canonical,
    requestedPath,
    parent: Object.freeze({
      path: parentPath,
      dev: String(parent.dev),
      ino: String(parent.ino),
    }),
    maxBytes: options.maxBytes,
    ...(target.expectedSize === undefined
      ? {}
      : { expectedSize: target.expectedSize }),
    ...(target.expectedSha256 === undefined
      ? {}
      : { expectedSha256: target.expectedSha256 }),
    mimeType: mime(target.mimeType ?? "application/octet-stream"),
  });
  await parentCurrent(result);
  check(scope, { access: "write", path: result.path });
  return result;
}

/** Same-directory hard-link publication is atomic no-replace on supported filesystems. */
export async function receiveUpload(
  source: Readable,
  plan: PreparedUpload,
  scope: TransferIoScope,
  options: { readonly maxBytes?: number; readonly contentLength?: number } = {},
): Promise<UploadFileReceipt> {
  const inputClosure = closing(source);
  let temporary: string | undefined,
    output: FileHandle | undefined,
    identity: BigIntStats | undefined;
  let createdTemporary = false;
  let committed = false,
    receipt: UploadFileReceipt | undefined;
  let failure: unknown;
  let cleanupConfirmed = true;
  try {
    policy(plan.maxBytes);
    if (options.maxBytes !== undefined) policy(options.maxBytes);
    const maximum = Math.min(plan.maxBytes, options.maxBytes ?? plan.maxBytes);
    requireCondition(
      options.contentLength === undefined ||
        integer(options.contentLength, maxPolicy),
      "invalid_arguments",
      "Content-Length must be a non-negative safe byte count when supplied.",
    );
    requireCondition(
      options.contentLength === undefined || options.contentLength <= maximum,
      "resource_exhausted",
      "Content-Length exceeds the accepted transfer limit.",
    );
    requireCondition(
      plan.expectedSize === undefined || plan.expectedSize <= maximum,
      "resource_exhausted",
      "The accepted expected size exceeds the current Agent limit.",
    );
    requireCondition(
      plan.expectedSize === undefined ||
        options.contentLength === undefined ||
        plan.expectedSize === options.contentLength,
      "transfer_size_mismatch",
      "Content-Length does not match the accepted expected size.",
    );
    check(scope, { access: "write", path: plan.path });
    await parentCurrent(plan);
    await absent(plan.path);
    temporary = path.join(plan.parent.path, "." + newId("nexum-upload"));
    output = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    createdTemporary = true;
    identity = await output.stat({ bigint: true });
    requireCondition(
      identity.isFile(),
      "file_changed",
      "The random upload temporary entry must be a regular file.",
    );
    const hash = createHash("sha256");
    let count = 0;
    addAbortSignal(scope.signal, source);
    for await (const input of source) {
      check(scope, { access: "write", path: plan.path });
      const chunk = copyChunk(input, maximum - count);
      let offset = 0;
      while (offset < chunk.byteLength) {
        check(scope, { access: "write", path: plan.path });
        const written = await output.write(
          chunk,
          offset,
          chunk.byteLength - offset,
          null,
        );
        requireCondition(
          written.bytesWritten > 0,
          "transfer_failed",
          "The upload temporary file stopped accepting bytes.",
        );
        hash.update(chunk.subarray(offset, offset + written.bytesWritten));
        offset += written.bytesWritten;
        count += written.bytesWritten;
        progress(scope, count);
      }
      check(scope, { access: "write", path: plan.path });
    }
    requireCondition(
      (plan.expectedSize === undefined || count === plan.expectedSize) &&
        (options.contentLength === undefined ||
          count === options.contentLength),
      "transfer_size_mismatch",
      "The actual upload length does not match its accepted declarations.",
    );
    const sha256 = hash.digest("hex");
    requireCondition(
      plan.expectedSha256 === undefined || sha256 === plan.expectedSha256,
      "checksum_mismatch",
      "The actual upload SHA-256 does not match its accepted declaration.",
    );
    await output.sync();
    identity = await output.stat({ bigint: true });
    requireCondition(
      identity.isFile() && identity.size === BigInt(count),
      "file_changed",
      "The upload temporary file changed during reception.",
    );
    await parentCurrent(plan);
    await absent(plan.path);
    requireCondition(
      sameFile(identity, await lstat(temporary, { bigint: true })),
      "file_changed",
      "The upload temporary file was replaced or changed before commit.",
    );
    check(scope, { access: "write", path: plan.path });
    // No exists+rename fallback: unsupported hard links fail explicitly.
    await link(temporary, plan.path);
    committed = true;
    await parentCurrent(plan);
    const final = await lstat(plan.path, { bigint: true });
    requireCondition(
      sameFile(identity, final, false),
      "file_changed",
      "The committed upload cannot be confirmed at its bound target.",
    );
    receipt = Object.freeze({
      path: plan.path,
      name: path.basename(plan.path),
      size: count,
      mimeType: plan.mimeType,
      sha256,
      revision: digest({
        sha256,
        size: count,
        dev: String(final.dev),
        ino: String(final.ino),
        mtime: String(final.mtimeNs),
      }),
    });
    check(scope, { access: "write", path: plan.path });
  } catch (cause) {
    failure = cause;
    source.destroy();
  } finally {
    source.destroy();
    try {
      await output?.close();
    } catch (cause) {
      cleanupConfirmed = false;
      failure ??= cause;
    }
    if (temporary && createdTemporary) {
      try {
        await parentCurrent(plan);
        const present = await lstat(temporary, { bigint: true });
        requireCondition(
          identity &&
            present.isFile() &&
            present.dev === identity.dev &&
            present.ino === identity.ino,
          "file_changed",
          "The upload temporary entry no longer has its original identity.",
        );
        await unlink(temporary);
      } catch (cause) {
        cleanupConfirmed = false;
        failure ??= cause;
      }
    }
    await inputClosure.closed;
  }
  if (failure) {
    const publicError = errorFor(failure, scope.signal);
    throw new TransferIoError(
      publicError.code,
      publicError.message,
      committed,
      cleanupConfirmed,
      receipt,
      failure,
    );
  }
  requireCondition(
    committed && receipt && cleanupConfirmed,
    "transfer_failed",
    "The upload did not establish a fully confirmed commit and cleanup.",
  );
  return receipt;
}

function writeChunk(target: Writable, chunk: Buffer): Promise<void> {
  const result = Promise.withResolvers<void>();
  const failed = (cause: Error) => result.reject(cause);
  const closed = () =>
    result.reject(
      new AgentError(
        "transfer_failed",
        "The download destination closed before its write completed.",
      ),
    );
  target.once("error", failed);
  target.once("close", closed);
  try {
    target.write(chunk, (cause) =>
      cause ? result.reject(cause) : result.resolve(),
    );
  } catch (cause) {
    result.reject(cause);
  }
  return result.promise.finally(() => {
    target.off("error", failed);
    target.off("close", closed);
  });
}

/** Completes the byte stream, not the remote Host's save nor the transfer row. */
export async function sendDownload(
  source: DownloadSource,
  target: Writable,
  scope: TransferIoScope,
  options: { readonly maxBytes: number },
): Promise<DownloadReceipt> {
  const { resource } = source;
  const outputClosure = closing(target);
  let completion: Promise<void> | undefined;
  let count = 0;
  const hash = createHash("sha256");
  let failure: unknown;
  try {
    policy(options.maxBytes);
    requireCondition(
      integer(resource.size, options.maxBytes),
      "resource_exhausted",
      "The fixed resource exceeds the accepted transfer limit.",
    );
    requireCondition(
      typeof resource.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(resource.sha256),
      "invalid_arguments",
      "A download must identify a fixed resource checksum.",
    );
    check(scope, { access: "read", uri: resource.uri });
    completion = finished(target, { readable: false, cleanup: true });
    void completion.catch((cause) => source.stream.destroy(cause));
    addAbortSignal(scope.signal, source.stream);
    addAbortSignal(scope.signal, target);
    for await (const input of source.stream) {
      check(scope, { access: "read", uri: resource.uri });
      const chunk = copyChunk(
        input,
        Math.min(options.maxBytes, resource.size) - count,
      );
      await writeChunk(target, chunk);
      hash.update(chunk);
      count += chunk.byteLength;
      progress(scope, count);
      check(scope, { access: "read", uri: resource.uri });
    }
    requireCondition(
      count === resource.size,
      "transfer_size_mismatch",
      "The fixed download source ended before its registered length.",
    );
    const sha256 = hash.digest("hex");
    requireCondition(
      sha256 === resource.sha256,
      "checksum_mismatch",
      "The fixed download source no longer matches its registered checksum.",
    );
    await source.closed;
    check(scope, { access: "read", uri: resource.uri });
    target.end();
    await completion;
    check(scope, { access: "read", uri: resource.uri });
    return Object.freeze({
      bytesTransferred: count,
      sha256,
      outputFinished: true,
    });
  } catch (cause) {
    failure = cause;
    source.stream.destroy();
    target.destroy();
    const value = errorFor(cause, scope.signal);
    throw new AgentError(
      value.code,
      value.message,
      { bytesTransferred: count },
      { cause },
    );
  } finally {
    let closureFailure: unknown;
    try {
      await source.closed;
    } catch (cause) {
      closureFailure = cause;
    }
    if (failure) {
      await completion?.catch(() => {});
      await outputClosure.closed;
    } else outputClosure.dispose();
    if (closureFailure)
      throw new AgentError(
        "transfer_cleanup_unconfirmed",
        "The download source could not confirm actual closure.",
        {
          bytesTransferred: count,
          cleanupConfirmed: false,
          ...(failure
            ? { originalCode: errorFor(failure, scope.signal).code }
            : {}),
        },
        {
          cause: failure
            ? new AggregateError(
                [failure, closureFailure],
                "The transfer and source cleanup both failed.",
              )
            : closureFailure,
        },
      );
  }
}
