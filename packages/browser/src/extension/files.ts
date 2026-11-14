import { constants, type BigIntStats } from "node:fs";
import {
  open,
  lstat,
  mkdir,
  realpath,
  link,
  unlink,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { types } from "node:util";
import type { Invocation } from "@nexum/extension-api";
import type {
  BrowserArtifact,
  BrowserFileSource,
  FileChooserFiles,
} from "../client/types.js";
import { check, failure, limits } from "./protocol.js";

export interface PreparedBrowserFile {
  path: string;
  name: string;
  mimeType?: string;
}
export interface DownloadFileInput {
  path: string;
  name?: string;
  expectedSize?: number;
  destination?: string;
}
interface OutputDirectory {
  path: string;
  stat: BigIntStats;
  requestedParent?: string;
}
export const browserFileBudget = limits.valueBytes;
const chunkBytes = 65536;
const nativeBlob = Blob;
const blobProbe = new nativeBlob([]);
const symbols = Object.getOwnPropertySymbols(blobProbe);
const handleKey = symbols.find((key) => key.description === "kHandle")!;
const sizeKey = symbols.find((key) => key.description === "kLength")!;
const typeKey = symbols.find((key) => key.description === "kType")!;
const handlePrototype = Object.getPrototypeOf(
  Object.getOwnPropertyDescriptor(blobProbe, handleKey)!.value,
);
const handleSlice = Object.getOwnPropertyDescriptor(
  handlePrototype,
  "slice",
)!.value;
const handleReader = Object.getOwnPropertyDescriptor(
  handlePrototype,
  "getReader",
)!.value;
const blobStream = Blob.prototype.stream;
const getReader = ReadableStream.prototype.getReader;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (prototype: object, name: string) =>
  Object.getOwnPropertyDescriptor(prototype, name)!.get!;
const viewBuffer = intrinsic(typedPrototype, "buffer"),
  viewOffset = intrinsic(typedPrototype, "byteOffset"),
  viewLength = intrinsic(typedPrototype, "byteLength");
const bufferLength = intrinsic(ArrayBuffer.prototype, "byteLength");

function current(call: Invocation): void {
  if (call.signal.aborted)
    throw failure("CANCELLED", "Browser file preparation was cancelled.");
  check(
    Number.isFinite(call.deadline) && Date.now() < call.deadline,
    "DEADLINE_EXCEEDED",
    "Browser file preparation exceeded its deadline.",
  );
}
function authorize(
  call: Invocation,
  value: string,
  access: "read" | "write",
): void {
  current(call);
  call.authorize({ type: "path", value, access });
}
function own(value: object, name: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, name);
  check(
    !field || "value" in field,
    "INVALID_ARGUMENT",
    "Browser file fields cannot use accessors.",
  );
  return field?.value;
}
function plain(value: unknown): asserts value is Record<string, unknown> {
  check(
    value && typeof value === "object" && !types.isProxy(value),
    "INVALID_ARGUMENT",
    "A browser file source must be plain data.",
  );
  const prototype = Object.getPrototypeOf(value);
  check(
    prototype === null || prototype === Object.prototype,
    "INVALID_ARGUMENT",
    "A browser file source must be a plain record.",
  );
}
function fields(value: object, allowed: readonly string[]): void {
  check(
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        allowed.includes(key) &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    ),
    "INVALID_ARGUMENT",
    "Browser file sources cannot contain unknown fields or accessors.",
  );
}
function fileName(value: unknown, fallback: string): string {
  const name = value === undefined ? fallback : value;
  check(
    typeof name === "string" &&
      name.length > 0 &&
      Buffer.byteLength(name) <= 255 &&
      name !== "." &&
      name !== ".." &&
      !/[\\/\x00-\x1f\x7f]/.test(name),
    "INVALID_ARGUMENT",
    "A browser file name must be bounded filename text.",
  );
  return name;
}
function mime(value: unknown, name: string): string {
  if (value !== undefined) {
    check(
      typeof value === "string" &&
        value.length > 0 &&
        value.length <= 256 &&
        /^[\x20-\x7e]+$/.test(value) &&
        !/[\r\n]/.test(value),
      "INVALID_ARGUMENT",
      "A browser MIME type must be bounded media-type text.",
    );
    return value;
  }
  return (
    (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".json": "application/json",
        ".csv": "text/csv",
        ".mp3": "audio/mpeg",
        ".mp4": "video/mp4",
      } as Record<string, string>
    )[path.extname(name).toLowerCase()] ?? "application/octet-stream"
  );
}
function identity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isFile() === right.isFile()
  );
}
function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return (
    identity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
function pwd(call: Invocation): string {
  const value = call.context.pwd;
  check(
    typeof value === "string" && path.isAbsolute(value),
    "INVALID_CONTEXT",
    "Browser file preparation requires the current working directory.",
  );
  return value;
}
async function directory(
  call: Invocation,
  work: string,
): Promise<{ path: string; stat: BigIntStats }> {
  check(
    typeof work === "string" && path.isAbsolute(work),
    "INVALID_CONTEXT",
    "Browser artifacts require an absolute profile work directory.",
  );
  const run = call.context.runId;
  check(
    typeof run === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(run),
    "INVALID_CONTEXT",
    "Browser artifacts require the actual current run identity.",
  );
  authorize(call, work, "write");
  let parent = await realpath(work);
  authorize(call, parent, "write");
  for (const name of ["tmp", "browser", run]) {
    const next = path.join(parent, name);
    authorize(call, next, "write");
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(next, { bigint: true });
    check(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (await realpath(next)) === next,
      "FILE_CHANGED",
      "The browser artifact directory is not a stable local directory.",
    );
    authorize(call, next, "write");
    parent = next;
  }
  return { path: parent, stat: await lstat(parent, { bigint: true }) };
}
async function directoryCurrent(
  target: OutputDirectory,
  call: Invocation,
): Promise<void> {
  authorize(call, target.path, "write");
  const stat = await lstat(target.path, { bigint: true });
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === target.stat.dev &&
      stat.ino === target.stat.ino &&
      (await realpath(target.path)) === target.path &&
      (target.requestedParent === undefined ||
        (await realpath(target.requestedParent)) === target.path),
    "FILE_CHANGED",
    "The browser artifact directory changed during preparation.",
  );
}
async function destinationDirectory(
  destination: string,
  call: Invocation,
): Promise<{ target: OutputDirectory; final: string }> {
  check(
    typeof destination === "string" &&
      destination.length > 0 &&
      destination.length <= 32768 &&
      !destination.includes("\0"),
    "INVALID_ARGUMENT",
    "A browser download destination must be bounded path text.",
  );
  const requested = path.resolve(pwd(call), destination);
  authorize(call, requested, "write");
  const requestedParent = path.dirname(requested),
    parent = await realpath(requestedParent);
  authorize(call, parent, "write");
  const stat = await lstat(parent, { bigint: true });
  check(
    stat.isDirectory(),
    "INVALID_ARGUMENT",
    "A browser download destination requires an existing directory.",
  );
  const final = path.join(parent, fileName(path.basename(requested), ""));
  authorize(call, final, "write");
  return { target: { path: parent, stat, requestedParent }, final };
}
async function removeOwned(
  filename: string,
  expected: BigIntStats | undefined,
): Promise<void> {
  if (!expected) return;
  try {
    const actual = await lstat(filename, { bigint: true });
    check(
      identity(expected, actual),
      "FILE_CHANGED",
      "An undelivered browser artifact was replaced; its replacement was preserved.",
    );
    await unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function writeAll(
  fd: FileHandle,
  chunk: Uint8Array,
  call: Invocation,
  target: string,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    authorize(call, target, "write");
    const result = await fd.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    check(
      result.bytesWritten > 0,
      "FILE_IO_FAILED",
      "The browser artifact stopped accepting bytes.",
    );
    offset += result.bytesWritten;
  }
}

async function copyFile(
  input: DownloadFileInput,
  call: Invocation,
  work: string,
  maximum: number,
): Promise<BrowserArtifact> {
  check(
    typeof input.path === "string" &&
      input.path.length > 0 &&
      input.path.length <= 32768 &&
      !input.path.includes("\0"),
    "INVALID_ARGUMENT",
    "A browser file path must be bounded text.",
  );
  const expected = input.expectedSize;
  check(
    expected === undefined || (Number.isSafeInteger(expected) && expected >= 0),
    "INVALID_ARGUMENT",
    "Expected file size must be a nonnegative safe byte count.",
  );
  const requested = path.resolve(pwd(call), input.path);
  authorize(call, requested, "read");
  const canonical = await realpath(requested);
  authorize(call, canonical, "read");
  const observed = await lstat(canonical, { bigint: true });
  check(
    observed.isFile(),
    "INVALID_ARGUMENT",
    "A browser file source must be a regular file.",
  );
  check(
    input.destination === undefined || typeof input.destination === "string",
    "INVALID_ARGUMENT",
    "A browser download destination must be path text.",
  );
  const name = fileName(
    input.name,
    path.basename(input.destination ?? canonical),
  );
  let source: FileHandle | undefined,
    output: FileHandle | undefined,
    temporary: string | undefined,
    final: string | undefined,
    outputIdentity: BigIntStats | undefined;
  let createdTemporary = false,
    committed = false,
    result: BrowserArtifact | undefined,
    caught: unknown;
  try {
    source = await open(
      canonical,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = await source.stat({ bigint: true });
    check(
      before.isFile() && identity(observed, before),
      "FILE_CHANGED",
      "The browser source changed while opening it.",
    );
    check(
      before.size <= BigInt(maximum) &&
        before.size <= BigInt(Number.MAX_SAFE_INTEGER),
      "OUTPUT_TOO_LARGE",
      "A browser file exceeds its local preparation budget or is not a regular file.",
    );
    check(
      expected === undefined || BigInt(expected) === before.size,
      "FILE_SIZE_MISMATCH",
      "The downloaded file size does not match its completed declaration.",
    );
    authorize(call, requested, "read");
    authorize(call, canonical, "read");
    check(
      (await realpath(requested)) === canonical &&
        identity(before, await lstat(canonical, { bigint: true })),
      "FILE_CHANGED",
      "The browser source changed while opening it.",
    );
    const plan =
      input.destination === undefined
        ? undefined
        : await destinationDirectory(input.destination, call);
    const target = plan?.target ?? (await directory(call, work));
    const id = randomUUID();
    temporary = path.join(target.path, `.${id}.partial`);
    final = plan?.final ?? path.join(target.path, id);
    authorize(call, temporary, "write");
    authorize(call, final, "write");
    await directoryCurrent(target, call);
    output = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    createdTemporary = true;
    outputIdentity = await output.stat({ bigint: true });
    await directoryCurrent(target, call);
    check(
      (await realpath(temporary)) === temporary,
      "FILE_CHANGED",
      "The browser artifact path was redirected while opening it.",
    );
    authorize(call, temporary, "write");
    const buffer = Buffer.allocUnsafe(chunkBytes),
      hash = createHash("sha256");
    let count = 0;
    while (true) {
      authorize(call, requested, "read");
      authorize(call, canonical, "read");
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      count += bytesRead;
      check(
        count <= maximum && BigInt(count) <= before.size,
        "FILE_CHANGED",
        "The browser source grew beyond its accepted length.",
      );
      const chunk = buffer.subarray(0, bytesRead);
      await writeAll(output, chunk, call, temporary);
      hash.update(chunk);
    }
    authorize(call, requested, "read");
    authorize(call, canonical, "read");
    check(
      BigInt(count) === before.size &&
        unchanged(before, await source.stat({ bigint: true })) &&
        (await realpath(requested)) === canonical &&
        unchanged(before, await lstat(canonical, { bigint: true })),
      "FILE_CHANGED",
      "The browser source changed while preparing its snapshot.",
    );
    await output.sync();
    check(
      identity(outputIdentity, await lstat(temporary, { bigint: true })) &&
        (await output.stat({ bigint: true })).size === BigInt(count),
      "FILE_CHANGED",
      "The browser artifact changed while being written.",
    );
    await source.close();
    source = undefined;
    await output.close();
    output = undefined;
    await directoryCurrent(target, call);
    authorize(call, final, "write");
    await link(temporary, final); // Same-directory hard-link publication is atomic no-replace.
    committed = true;
    await unlink(temporary);
    temporary = undefined;
    const stat = await lstat(final, { bigint: true });
    check(
      stat.isFile() &&
        identity(outputIdentity, stat) &&
        stat.size === BigInt(count),
      "FILE_CHANGED",
      "The published browser artifact no longer matches its completed copy.",
    );
    current(call);
    result = {
      path: final,
      name,
      mimeType: mime(undefined, name),
      size: count,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    caught = error;
  } finally {
    for (const fd of [source, output])
      if (fd)
        try {
          await fd.close();
        } catch {
          caught ??= failure(
            "FILE_CLOSE_FAILED",
            "A browser file handle could not be confirmed closed.",
          );
        }
    if (temporary && createdTemporary)
      try {
        await removeOwned(temporary, outputIdentity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          caught ??= failure(
            "FILE_CLEANUP_FAILED",
            "A partial browser artifact could not be removed.",
          );
      }
    // A committed copy is removed only before this method has delivered it.
    if (committed && caught && final)
      try {
        await removeOwned(final, outputIdentity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          caught ??= failure(
            "FILE_CLEANUP_FAILED",
            "An undelivered browser artifact could not be removed.",
          );
      }
  }
  if (caught) throw caught;
  return result!;
}

export async function materializeDownload(
  input: DownloadFileInput,
  call: Invocation,
  work: string,
): Promise<BrowserArtifact> {
  plain(input);
  fields(input, ["path", "name", "expectedSize", "destination"]);
  return await copyFile(
    {
      path: own(input, "path") as string,
      name: own(input, "name") as string | undefined,
      expectedSize: own(input, "expectedSize") as number | undefined,
      destination: own(input, "destination") as string | undefined,
    },
    call,
    work,
    Number.MAX_SAFE_INTEGER,
  );
}

function nativeBytes(value: unknown, maximum: number): Uint8Array | null {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  let buffer: ArrayBufferLike,
    offset = 0,
    length: number;
  if (types.isUint8Array(value)) {
    buffer = viewBuffer.call(value);
    offset = viewOffset.call(value);
    length = viewLength.call(value);
  } else if (types.isArrayBuffer(value)) {
    buffer = value as ArrayBuffer;
    length = bufferLength.call(value);
  } else return null;
  check(
    length <= maximum,
    "OUTPUT_TOO_LARGE",
    "Browser file inputs exceed the 128 MiB local protocol budget.",
  );
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
/** Node24 Blob Symbol getters are not brand checks. Only a verified native handle enters a fresh carrier. */
function blobSnapshot(
  value: unknown,
  maximum: number,
): { blob: Blob; size: number; mimeType: string } | null {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  let prototype = Object.getPrototypeOf(value),
    found = false;
  for (let depth = 0; prototype && depth < 64; depth++) {
    check(
      !types.isProxy(prototype),
      "INVALID_ARGUMENT",
      "A Blob prototype cannot be a Proxy.",
    );
    if (prototype === nativeBlob.prototype) {
      found = true;
      break;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!found) return null;
  const field = (key: symbol): unknown => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(
      d && "value" in d,
      "INVALID_ARGUMENT",
      "Blob native fields cannot use accessors.",
    );
    return d.value;
  };
  const handle = field(handleKey),
    size = field(sizeKey),
    type = field(typeKey);
  check(
    typeof size === "number" &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      size <= maximum,
    "OUTPUT_TOO_LARGE",
    "Browser file inputs exceed the 128 MiB local protocol budget.",
  );
  check(
    typeof type === "string" && type.length <= 256 && !/[\r\n\0]/.test(type),
    "INVALID_ARGUMENT",
    "Blob MIME metadata must be bounded text.",
  );
  check(
    handle &&
      typeof handle === "object" &&
      !types.isProxy(handle) &&
      Object.getPrototypeOf(handle) === handlePrototype &&
      Reflect.ownKeys(handle).length === 0 &&
      Object.getOwnPropertyDescriptor(handlePrototype, "slice")?.value ===
        handleSlice &&
      Object.getOwnPropertyDescriptor(handlePrototype, "getReader")?.value ===
        handleReader,
    "INVALID_ARGUMENT",
    "Blob handles must retain their native identity.",
  );
  try {
    Reflect.apply(handleSlice, handle, [0, 0]);
  } catch {
    throw failure(
      "INVALID_ARGUMENT",
      "A Blob handle is not an actual native handle.",
    );
  }
  const carrier = Object.create(null);
  Object.defineProperties(carrier, {
    [handleKey]: { value: handle },
    size: { value: size },
  });
  const blob = new nativeBlob([carrier], { type });
  return {
    blob,
    size,
    mimeType: Object.getOwnPropertyDescriptor(blob, typeKey)!.value,
  };
}
async function nativeDataFile(
  value: unknown,
  name: string,
  requestedMime: unknown,
  call: Invocation,
  destination: string,
  maximum: number,
): Promise<BrowserArtifact> {
  const bytes = nativeBytes(value, maximum);
  const snapshot = bytes ? null : blobSnapshot(value, maximum);
  check(
    bytes || snapshot,
    "INVALID_ARGUMENT",
    "A browser file data source must be native Uint8Array, ArrayBuffer or Blob.",
  );
  const mimeType = mime(
    requestedMime ?? (snapshot?.mimeType || undefined),
    name,
  );
  const plan = await destinationDirectory(destination, call),
    target = plan.target,
    final = plan.final;
  const temporary = path.join(target.path, `.${randomUUID()}.partial`);
  let output: FileHandle | undefined, outputIdentity: BigIntStats | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let sourceComplete = false,
    created = false,
    committed = false,
    caught: unknown;
  let result: BrowserArtifact | undefined;
  try {
    authorize(call, temporary, "write");
    await directoryCurrent(target, call);
    output = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    outputIdentity = await output.stat({ bigint: true });
    await directoryCurrent(target, call);
    check(
      (await realpath(temporary)) === temporary,
      "FILE_CHANGED",
      "The browser input path was redirected while opening it.",
    );
    if (snapshot) {
      const stream = Reflect.apply(
        blobStream,
        snapshot.blob,
        [],
      ) as ReadableStream<Uint8Array>;
      reader = Reflect.apply(
        getReader,
        stream,
        [],
      ) as ReadableStreamDefaultReader<Uint8Array>;
    }
    const hash = createHash("sha256");
    let count = 0;
    while (true) {
      current(call);
      const item = reader
        ? await reader.read()
        : sourceComplete
          ? { done: true as const, value: undefined }
          : { done: false as const, value: bytes! };
      current(call);
      if (item.done) {
        sourceComplete = true;
        break;
      }
      const chunk = reader
        ? nativeBytes(item.value, maximum - count)
        : item.value;
      check(
        chunk,
        "INVALID_ARGUMENT",
        "A native Blob produced unsupported bytes.",
      );
      count += chunk.byteLength;
      check(
        count <= maximum,
        "OUTPUT_TOO_LARGE",
        "Browser file inputs exceed the 128 MiB local protocol budget.",
      );
      await writeAll(output, chunk, call, temporary);
      hash.update(chunk);
      if (!reader) sourceComplete = true;
    }
    check(
      count === (bytes?.byteLength ?? snapshot!.size),
      "FILE_SIZE_MISMATCH",
      "The native file source does not match its declared byte count.",
    );
    if (reader) {
      reader.releaseLock();
      reader = undefined;
    }
    await output.sync();
    check(
      identity(outputIdentity, await lstat(temporary, { bigint: true })) &&
        (await output.stat({ bigint: true })).size === BigInt(count),
      "FILE_CHANGED",
      "The browser input changed during preparation.",
    );
    await output.close();
    output = undefined;
    await directoryCurrent(target, call);
    authorize(call, final, "write");
    await link(temporary, final);
    committed = true;
    await unlink(temporary);
    created = false;
    authorize(call, final, "read");
    const published = await lstat(final, { bigint: true });
    check(
      identity(outputIdentity, published) && published.size === BigInt(count),
      "FILE_CHANGED",
      "The published browser input changed during preparation.",
    );
    result = {
      path: final,
      name,
      mimeType,
      size: count,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    caught = error;
  } finally {
    if (reader) {
      try {
        if (!sourceComplete) await reader.cancel();
      } catch {
        caught ??= failure(
          "FILE_CLOSE_FAILED",
          "A native browser input stream could not be confirmed closed.",
        );
      }
      try {
        reader.releaseLock();
      } catch {
        caught ??= failure(
          "FILE_CLOSE_FAILED",
          "A native browser input reader could not be released.",
        );
      }
    }
    if (output)
      try {
        await output.close();
      } catch {
        caught ??= failure(
          "FILE_CLOSE_FAILED",
          "A browser input file handle could not be confirmed closed.",
        );
      }
    if (created)
      try {
        await removeOwned(temporary, outputIdentity);
      } catch {
        caught ??= failure(
          "FILE_CLEANUP_FAILED",
          "An undelivered browser input could not be removed.",
        );
      }
    if (committed && caught)
      try {
        await removeOwned(final, outputIdentity);
      } catch {
        caught ??= failure(
          "FILE_CLEANUP_FAILED",
          "An undelivered browser input could not be removed.",
        );
      }
  }
  if (caught) throw caught;
  return result!;
}
async function inputDirectory(call: Invocation, work: string): Promise<string> {
  const root = await directory(call, work),
    leaf = path.join(root.path, randomUUID());
  authorize(call, leaf, "write");
  await directoryCurrent(root, call);
  await mkdir(leaf, { mode: 0o700 });
  const stat = await lstat(leaf, { bigint: true });
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await realpath(leaf)) === leaf,
    "FILE_CHANGED",
    "A browser input directory was redirected during preparation.",
  );
  return leaf;
}

export async function prepareFiles(
  input: FileChooserFiles | BrowserFileSource[],
  call: Invocation,
  work: string,
): Promise<PreparedBrowserFile[]> {
  current(call);
  const entries: unknown[] = [];
  if (typeof input === "string") entries.push(input);
  else {
    check(
      Array.isArray(input) && !types.isProxy(input),
      "INVALID_ARGUMENT",
      "Browser files must be a path or an array of file sources.",
    );
    const count = own(input, "length");
    check(
      typeof count === "number" && Number.isSafeInteger(count) && count <= 1024,
      "INVALID_ARGUMENT",
      "At most 1024 browser file inputs may be prepared together.",
    );
    for (let i = 0; i < count; i++) {
      const field = Object.getOwnPropertyDescriptor(input, String(i));
      check(
        field && "value" in field,
        "INVALID_ARGUMENT",
        "Browser file arrays cannot contain holes or accessors.",
      );
      entries.push(field.value);
    }
  }
  const result: PreparedBrowserFile[] = [],
    copies: { path: string; stat: BigIntStats }[] = [],
    directories: string[] = [];
  let total = 0;
  try {
    for (const entry of entries) {
      current(call);
      let file: Record<string, unknown>;
      if (typeof entry === "string") file = { path: entry };
      else {
        plain(entry);
        fields(entry, ["path", "data", "name", "mimeType"]);
        file = entry;
      }
      const sourcePath = own(file, "path"),
        data = own(file, "data"),
        requestedName = own(file, "name"),
        requestedMime = own(file, "mimeType");
      check(
        (sourcePath !== undefined) !== (data !== undefined),
        "INVALID_ARGUMENT",
        "A browser file source must provide exactly one of path or data.",
      );
      check(
        sourcePath === undefined || typeof sourcePath === "string",
        "INVALID_ARGUMENT",
        "A browser file path must be text.",
      );
      const name = fileName(
        requestedName,
        sourcePath === undefined ? "" : path.basename(sourcePath),
      );
      if (requestedMime !== undefined) mime(requestedMime, name);
      const leaf = await inputDirectory(call, work);
      directories.push(leaf);
      const destination = path.join(leaf, name);
      const artifact =
        sourcePath === undefined
          ? await nativeDataFile(
              data,
              name,
              requestedMime,
              call,
              destination,
              browserFileBudget - total,
            )
          : await copyFile(
              { path: sourcePath, name, destination },
              call,
              work,
              browserFileBudget - total,
            );
      copies.push({
        path: artifact.path,
        stat: await lstat(artifact.path, { bigint: true }),
      });
      authorize(call, artifact.path, "read");
      total += artifact.size;
      result.push({
        path: artifact.path,
        name,
        mimeType: mime(requestedMime ?? artifact.mimeType, name),
      });
    }
    current(call);
    return result;
  } catch (error) {
    let cleanupFailed = false;
    for (const file of copies)
      try {
        await removeOwned(file.path, file.stat);
      } catch {
        /* Preserve replacements; only this failed batch's own undelivered copies may be removed. */
        cleanupFailed = true;
      }
    for (const dirname of directories)
      try {
        await rmdir(dirname);
      } catch (cause) {
        /* Do not remove nonempty/replaced directories or earlier delivered artifacts. */
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
          cleanupFailed = true;
      }
    if (cleanupFailed)
      throw failure(
        "FILE_CLEANUP_FAILED",
        "Browser file preparation failed and undelivered artifact cleanup was not confirmed.",
      );
    throw error;
  }
}
