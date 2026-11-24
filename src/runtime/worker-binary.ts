import { Blob, File } from "node:buffer";
import { URL } from "node:url";
import { types } from "node:util";
import { requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import { snapshotBlob } from "../results/artifacts.js";

const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")!.get!;
const typedSize = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")!.get!;
const urlHref = Object.getOwnPropertyDescriptor(URL.prototype, "href")!.get!;

/** Structured clone strips Buffer/File identity and cannot carry native URLs.
 * Preserve the real native value, not user-supplied getters or toJSON hooks. */
export function packWorkerBinary(value: unknown, token: string): unknown | undefined {
  if (Buffer.isBuffer(value)) {
    const bytes = new Uint8Array(typedBuffer.call(value), typedOffset.call(value), typedSize.call(value));
    return { __nexumBinary: token, kind: "buffer", data: Uint8Array.prototype.slice.call(bytes) };
  }
  if (!value || typeof value !== "object") return undefined;
  if (!types.isProxy(value)) {
    let href: unknown;
    try { href = Reflect.apply(urlHref, value, []); } catch { /* not a native URL */ }
    if (typeof href === "string")
      return { __nexumBinary: token, kind: "url", data: href };
  }
  const file = snapshotBlob(value, Number.MAX_SAFE_INTEGER, true);
  if (file?.name !== undefined && file.lastModified !== undefined)
    return { __nexumBinary: token, kind: "file", data: file.blob,
      name: file.name, type: file.mimeType, lastModified: file.lastModified };
  return undefined;
}

export function unpackWorkerBinary(value: unknown, token: string): unknown | undefined {
  if (!isPlainRecord(value) || value.__nexumBinary !== token) return undefined;
  if (value.kind === "url") {
    requireCondition(Object.keys(value).length === 3 && typeof value.data === "string",
      "worker_message_invalid", "Invalid Worker URL payload.");
    return new URL(value.data);
  }
  if (value.kind === "buffer") {
    requireCondition(Object.keys(value).length === 3 && value.data instanceof Uint8Array,
      "worker_message_invalid", "Invalid Worker Buffer payload.");
    const bytes = value.data;
    return Buffer.from(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  requireCondition(value.kind === "file" && Object.keys(value).length === 6 &&
    value.data instanceof Blob && typeof value.name === "string" &&
    typeof value.type === "string" && typeof value.lastModified === "number" &&
    Number.isFinite(value.lastModified), "worker_message_invalid", "Invalid Worker File payload.");
  return new File([value.data], value.name, { type: value.type, lastModified: value.lastModified });
}
