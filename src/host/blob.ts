import { createHash } from "node:crypto";
import { Blob, File } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { types } from "node:util";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { requireCondition } from "../contracts/errors.js";
import { snapshotBlob } from "../results/artifacts.js";

const maximumLimit = 2_147_483_647;
const chunkSize = 64 * 1024;
type Path = readonly (string | number)[];
type Call = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
type Scope = { instanceId: string; runId: string; methodId?: string };
type BinaryKind = "blob" | "file" | "buffer" | "arraybuffer" | "dataview" |
  "int8array" | "uint8array" | "uint8clampedarray" | "int16array" | "uint16array" |
  "int32array" | "uint32array" | "float16array" | "float32array" | "float64array" | "bigint64array" | "biguint64array";
const kinds: readonly BinaryKind[] = ["blob", "file", "buffer", "arraybuffer", "dataview", "int8array", "uint8array", "uint8clampedarray", "int16array", "uint16array", "int32array", "uint32array", "float16array", "float32array", "float64array", "bigint64array", "biguint64array"];
export interface BinaryRef { readonly id: string; readonly name?: string; readonly contentType?: string; readonly kind?: BinaryKind; readonly lastModified?: number; readonly originalName?: string; readonly originalType?: string }
export interface BinaryItem { readonly path: Path; readonly ref: BinaryRef }
interface BlobTicket { ticket: string; path: string }
interface OpenTicket extends BlobTicket { size: number; sha256: string; contentType: string; kind?: BinaryKind; lastModified?: number; originalName?: string; originalType?: string }

const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")!.get!;
const typedSize = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")!.get!;
const viewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!;
const viewSize = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!;
const arraySize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;

type BinarySnapshot = { blob?: Blob; bytes?: Uint8Array; size: number; name?: string; contentType: string; kind: BinaryKind; lastModified?: number; originalName?: string; originalType?: string };
function nativeBlob(value: unknown): BinarySnapshot | null {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  const snapshot = snapshotBlob(value, maximumLimit, true);
  if (snapshot) return { blob: snapshot.blob, size: snapshot.size, name: snapshot.name && Buffer.byteLength(snapshot.name) <= 1024 && !/[\0\r\n]/.test(snapshot.name) ? snapshot.name : "blob", contentType: snapshot.mimeType || "application/octet-stream", kind: snapshot.name === undefined ? "blob" : "file", originalType: snapshot.mimeType, ...(snapshot.name === undefined ? {} : { originalName: snapshot.name }), ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }) };
  if (types.isSharedArrayBuffer(value)) throw new Error("shared binary input is unsupported");
  let bytes: Uint8Array;
  let kind: BinaryKind;
  if (Buffer.isBuffer(value)) kind = "buffer";
  else if (types.isDataView(value)) kind = "dataview";
  else if (types.isArrayBuffer(value)) kind = "arraybuffer";
  else if (types.isInt8Array(value)) kind = "int8array";
  else if (types.isUint8Array(value)) kind = "uint8array";
  else if (types.isUint8ClampedArray(value)) kind = "uint8clampedarray";
  else if (types.isInt16Array(value)) kind = "int16array";
  else if (types.isUint16Array(value)) kind = "uint16array";
  else if (types.isInt32Array(value)) kind = "int32array";
  else if (types.isUint32Array(value)) kind = "uint32array";
  else if ((types as typeof types & { isFloat16Array?: (value: unknown) => boolean }).isFloat16Array?.(value)) kind = "float16array";
  else if (types.isFloat32Array(value)) kind = "float32array";
  else if (types.isFloat64Array(value)) kind = "float64array";
  else if (types.isBigInt64Array(value)) kind = "bigint64array";
  else if (types.isBigUint64Array(value)) kind = "biguint64array";
  else return null;
  if (types.isDataView(value)) bytes = new Uint8Array(viewBuffer.call(value), viewOffset.call(value), viewSize.call(value));
  else if (types.isArrayBufferView(value)) bytes = new Uint8Array(typedBuffer.call(value), typedOffset.call(value), typedSize.call(value));
  else if (types.isArrayBuffer(value)) bytes = new Uint8Array(value, 0, arraySize.call(value));
  else return null;
  requireCondition(bytes.byteLength <= maximumLimit && !types.isSharedArrayBuffer(bytes.buffer), "resource_too_large", "Binary input exceeds its budget or uses shared memory.");
  return { bytes, size: bytes.byteLength, contentType: "application/octet-stream", kind };
}

async function limits(call: Call, scope: Scope, signal: AbortSignal): Promise<{ inputBytes: number; outputBytes: number }> {
  const value = await call("blob.limits", scope, signal);
  requireCondition(isPlainRecord(value) && Number.isSafeInteger(value.inputBytes) && (value.inputBytes as number) > 0 &&
    (value.inputBytes as number) <= maximumLimit && Number.isSafeInteger(value.outputBytes) && (value.outputBytes as number) > 0 &&
    (value.outputBytes as number) <= maximumLimit, "invalid_resource", "The binary transfer limits are invalid.");
  return { inputBytes: value.inputBytes as number, outputBytes: value.outputBytes as number };
}

function ticket(value: unknown): BlobTicket {
  requireCondition(isPlainRecord(value) && typeof value.ticket === "string" && value.ticket.length > 0 &&
    typeof value.path === "string" && value.path.length > 0, "invalid_resource", "The binary transfer ticket is invalid.");
  return { ticket: value.ticket, path: value.path };
}

function reference(value: unknown): BinaryRef {
  requireCondition(isPlainRecord(value) && typeof value.id === "string" && value.id.length > 0 &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.contentType === undefined || typeof value.contentType === "string") &&
    (value.kind === undefined || (typeof value.kind === "string" && kinds.includes(value.kind as BinaryKind))) &&
    (value.kind === "file" ? Number.isSafeInteger(value.lastModified) : value.lastModified === undefined) &&
    (value.originalName === undefined || (value.kind === "file" && typeof value.originalName === "string" && Buffer.byteLength(value.originalName) <= 8192)) &&
    (value.originalType === undefined || ((value.kind === "blob" || value.kind === "file") && typeof value.originalType === "string" && value.originalType.length <= 256)), "invalid_resource", "The binary resource reference is invalid.");
  return { id: value.id, ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.contentType === undefined ? {} : { contentType: value.contentType }),
    ...(value.kind === undefined ? {} : { kind: value.kind as BinaryKind }),
    ...(value.lastModified === undefined ? {} : { lastModified: value.lastModified as number }),
    ...(value.originalName === undefined ? {} : { originalName: value.originalName as string }),
    ...(value.originalType === undefined ? {} : { originalType: value.originalType as string }) };
}

async function release(call: Call, scope: Scope, id: string): Promise<void> {
  await call("blob.release", { ...scope, ticket: id }, AbortSignal.timeout(2_000));
}

async function upload(snapshot: BinarySnapshot,
  scope: Scope, call: Call, signal: AbortSignal): Promise<BinaryRef> {
  signal.throwIfAborted();
  const staged = ticket(await call("blob.prepare", { ...scope, size: snapshot.size, kind: snapshot.kind, ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }), ...(snapshot.originalName === undefined ? {} : { originalName: snapshot.originalName }), ...(snapshot.originalType === undefined ? {} : { originalType: snapshot.originalType }) }, signal));
  let committed = false;
  try {
    const file = await open(staged.path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    const hash = createHash("sha256");
    let size = 0;
    try {
      const info = await file.stat();
      requireCondition(info.isFile() && info.nlink === 1 && info.size === 0, "invalid_resource", "The binary staging file is invalid.");
      const write = async (bytes: Uint8Array) => {
          size += bytes.byteLength;
          requireCondition(size <= snapshot.size, "resource_too_large", "Binary input exceeds its declared size.");
          hash.update(bytes);
          for (let offset = 0; offset < bytes.byteLength;) {
            const written = await file.write(bytes, offset, bytes.byteLength - offset);
            requireCondition(written.bytesWritten > 0, "resource_write_failed", "The binary input could not be written.");
            offset += written.bytesWritten;
          }
      };
      if (snapshot.bytes) {
        for (let offset = 0; offset < snapshot.bytes.byteLength; offset += chunkSize) {
          signal.throwIfAborted();
          await write(snapshot.bytes.subarray(offset, offset + chunkSize));
        }
      } else {
        const reader = snapshot.blob!.stream().getReader();
        try {
          for (;;) {
            signal.throwIfAborted();
            const item = await reader.read();
            if (item.done) break;
            await write(item.value);
          }
        } finally { reader.releaseLock(); }
      }
      requireCondition(size === snapshot.size, "invalid_resource", "Binary input size changed during transfer.");
      await file.sync();
    } finally { await file.close(); }
    const output = reference(await call("blob.commit", { ...scope, ticket: staged.ticket, size,
      sha256: hash.digest("hex"), contentType: snapshot.contentType, name: snapshot.name ?? "blob" }, signal));
    requireCondition((output.kind ?? "blob") === snapshot.kind && output.lastModified === snapshot.lastModified && output.originalName === snapshot.originalName && output.originalType === snapshot.originalType,
      "invalid_resource", "The committed binary type does not match the staged value.");
    committed = true;
    return output;
  } finally {
    if (!committed) await release(call, scope, staged.ticket).catch(() => {});
  }
}

export async function encodeGoArguments(args: readonly unknown[], scope: Scope,
  call: Call, signal: AbortSignal): Promise<{ arguments: unknown; binaryInputs: BinaryItem[] }> {
  const binaryInputs: BinaryItem[] = [];
  const snapshots: { path: (string | number)[]; source: NonNullable<ReturnType<typeof nativeBlob>> }[] = [];
  const active = new Set<object>();
  let nodes = 0;
  let binaryBytes = 0;
  function visit(value: unknown, path: (string | number)[], depth: number): unknown {
    requireCondition(++nodes <= 100_000 && depth <= 64, "data_too_large", "SDK input exceeds its structural budget.");
    const snapshot = nativeBlob(value);
    if (snapshot) {
      requireCondition(snapshots.length < 128 && path.length <= 32, "data_too_large", "Binary inputs exceed their count or nesting budget.");
      binaryBytes += snapshot.size;
      requireCondition(binaryBytes <= maximumLimit, "resource_too_large", "Binary inputs exceed their combined byte budget.");
      snapshots.push({ path, source: snapshot });
      return null;
    }
    if (value === null || typeof value !== "object") return value;
    requireCondition(!types.isProxy(value) && !active.has(value) && (Array.isArray(value) || isPlainRecord(value)),
      "invalid_json", "SDK arguments must be acyclic plain data.");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        const output: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          requireCondition(descriptor && "value" in descriptor, "invalid_json", "Sparse arrays and accessors are not supported.");
          output.push(visit(descriptor.value, [...path, index], depth + 1));
        }
        return output;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireCondition(descriptor && "value" in descriptor, "invalid_json", "SDK argument accessors are not supported.");
        output[key] = visit(descriptor.value, [...path, key], depth + 1);
      }
      return output;
    } finally { active.delete(value); }
  }
  const output = JSON.parse(canonicalJson(visit(args, [], 0))) as unknown;
  if (snapshots.length > 0) {
    const allowed = await limits(call, scope, signal);
    requireCondition(binaryBytes <= allowed.inputBytes, "resource_too_large", "Binary inputs exceed the approved byte budget.");
  }
  for (const snapshot of snapshots) {
    binaryInputs.push({ path: snapshot.path, ref: await upload(snapshot.source, scope, call, signal) });
  }
  return { arguments: output, binaryInputs };
}

// Both ordinary SDK binary outputs and text resource reads use the same
// verified private staging file. A range read consumes chunks, not a whole-file
// Buffer, and never gives the guest a private filesystem path.
async function visitBinary(ref: BinaryRef, scope: Scope, call: Call, signal: AbortSignal,
  budget: { remaining: number }, visit: (chunk: Buffer) => void,
  expected?: { size: number; sha256: string; mimeType: string }): Promise<OpenTicket> {
  const value = await call("blob.open", { ...scope, ref }, signal);
  const opened = ticket(value);
  try {
    requireCondition(isPlainRecord(value) && Number.isSafeInteger(value.size) && (value.size as number) >= 0 &&
      (value.size as number) <= budget.remaining && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) &&
      typeof value.contentType === "string" && value.contentType.length <= 256 &&
      (value.kind === undefined || (typeof value.kind === "string" && kinds.includes(value.kind as BinaryKind))) &&
      (value.kind ?? "blob") === (ref.kind ?? "blob") && value.lastModified === ref.lastModified &&
      value.originalName === ref.originalName && value.originalType === ref.originalType, "invalid_resource", "The binary resource metadata is invalid.");
    const metadata = value as unknown as OpenTicket;
    requireCondition(!expected || (metadata.size === expected.size && metadata.sha256 === expected.sha256 && metadata.contentType === expected.mimeType),
      "resource_changed", "The fixed resource no longer matches its original identity.");
    budget.remaining -= metadata.size;
    const file = await open(opened.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      requireCondition(info.isFile() && info.nlink === 1 && info.size === metadata.size, "invalid_resource", "The binary resource file is invalid.");
      const hash = createHash("sha256");
      let size = 0;
      while (size < metadata.size) {
        signal.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(chunkSize, metadata.size - size));
        const read = await file.read(chunk, 0, chunk.length, null);
        requireCondition(read.bytesRead > 0, "invalid_resource", "The binary resource was truncated.");
        const actual = chunk.subarray(0, read.bytesRead);
        hash.update(actual);
        visit(actual);
        size += actual.length;
      }
      const final = await file.stat();
      requireCondition(final.size === metadata.size && hash.digest("hex") === metadata.sha256,
        "invalid_resource", "The binary resource did not match its committed contents.");
      signal.throwIfAborted();
      return metadata;
    } finally { await file.close(); }
  } finally { await release(call, scope, opened.ticket).catch(() => {}); }
}

/** Consume a method-bound fixed resource without allocating its full body. */
export async function visitGoResourceBytes(rawRef: unknown, scope: Scope, call: Call, signal: AbortSignal,
  expected: { size: number; sha256: string; mimeType: string }, visit: (chunk: Buffer) => void): Promise<void> {
  await visitBinary(reference(rawRef), scope, call, signal, { remaining: expected.size }, visit, expected);
}

async function download(ref: BinaryRef, scope: Scope, call: Call, signal: AbortSignal, budget: { remaining: number }): Promise<unknown> {
  const chunks: Buffer[] = [];
  const metadata = await visitBinary(ref, scope, call, signal, budget, chunk => chunks.push(chunk));
  const bytes = Buffer.concat(chunks, metadata.size);
  switch (metadata.kind ?? "blob") {
    case "blob": return new Blob([bytes], { type: metadata.originalType ?? metadata.contentType });
    case "file": return new File([bytes], metadata.originalName ?? ref.name ?? "blob", { type: metadata.originalType ?? metadata.contentType, lastModified: metadata.lastModified });
    case "buffer": return bytes;
    default: {
      const exact = Uint8Array.from(bytes).buffer;
      switch (metadata.kind) {
        case "arraybuffer": return exact;
        case "dataview": return new DataView(exact);
        case "int8array": return new Int8Array(exact);
        case "uint8array": return new Uint8Array(exact);
        case "uint8clampedarray": return new Uint8ClampedArray(exact);
        case "int16array": return new Int16Array(exact);
        case "uint16array": return new Uint16Array(exact);
        case "int32array": return new Int32Array(exact);
        case "uint32array": return new Uint32Array(exact);
        case "float16array": return new (globalThis as unknown as { Float16Array: new (buffer: ArrayBuffer) => unknown }).Float16Array(exact);
        case "float32array": return new Float32Array(exact);
        case "float64array": return new Float64Array(exact);
        case "bigint64array": return new BigInt64Array(exact);
        case "biguint64array": return new BigUint64Array(exact);
        default: throw new Error("invalid binary resource type");
      }
    }
  }
}

export async function decodeGoResult(result: unknown, scope: Scope, call: Call, signal: AbortSignal): Promise<unknown> {
  requireCondition(isPlainRecord(result) && Object.hasOwn(result, "value") && Array.isArray(result.binaryOutputs) &&
    result.binaryOutputs.length <= 128, "invalid_resource", "The SDK response envelope is invalid.");
  let value = JSON.parse(canonicalJson(result.value)) as unknown;
  const budget = { remaining: result.binaryOutputs.length > 0 ? (await limits(call, scope, signal)).outputBytes : 0 };
  for (const entry of result.binaryOutputs) {
    requireCondition(isPlainRecord(entry) && Array.isArray(entry.path) && entry.path.length <= 32,
      "invalid_resource", "A binary output path is invalid.");
    if (entry.path.length === 0) {
      requireCondition(value === null, "invalid_resource", "The binary output placeholder is invalid.");
      value = await download(reference(entry.ref), scope, call, signal, budget);
      continue;
    }
    let cursor: unknown = value;
    for (const key of entry.path.slice(0, -1)) {
      requireCondition((typeof key === "string" || Number.isSafeInteger(key)) && cursor !== null && typeof cursor === "object" &&
        Object.hasOwn(cursor, key), "invalid_resource", "The binary output path does not exist.");
      cursor = (cursor as Record<string, unknown>)[String(key)];
    }
    const key = entry.path.at(-1);
    requireCondition((typeof key === "string" || Number.isSafeInteger(key)) && cursor !== null && typeof cursor === "object" &&
      Object.hasOwn(cursor, key) && (cursor as Record<string, unknown>)[String(key)] === null,
    "invalid_resource", "The binary output placeholder is invalid.");
    (cursor as Record<string, unknown>)[String(key)] = await download(reference(entry.ref), scope, call, signal, budget);
  }
  return value;
}
