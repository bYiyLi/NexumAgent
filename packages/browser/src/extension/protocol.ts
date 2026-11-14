import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";

export const protocolVersion = 1;
export const socketPath = "/nexum-browser/v1";
export const limits = Object.freeze({
  controlBytes: 1024 * 1024,
  headerBytes: 4096,
  chunkBytes: 65536,
  maxStreams: 8,
  maxAttachments: 1024,
  valueBytes: 128 * 1024 * 1024,
  inFlight: 64,
  snapshotItems: 10000,
  snapshotBytes: 4 * 1024 * 1024,
});
export type Data =
  null | boolean | number | string | Data[] | { [key: string]: Data };
export type RecordData = { [key: string]: Data };
export interface Target {
  browserId: string;
  bootId: string;
  browserSessionId: string;
  generation: number;
  tabId?: string;
  pageVersion?: number;
  controlEpoch?: string;
}
export type Failure = Error & {
  code: string;
  dispatched: boolean;
  effect: "none" | "confirmed" | "unknown";
  retryable: boolean;
  operationId?: string;
  target?: Target;
};
export function failure(
  code: string,
  message: string,
  fields: Partial<
    Pick<
      Failure,
      "dispatched" | "effect" | "retryable" | "operationId" | "target"
    >
  > = {},
): Failure {
  return Object.assign(
    new Error(message),
    { code, dispatched: false, effect: "none" as const, retryable: false },
    fields,
  );
}
export function check(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw failure(code, message);
}
export function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\0\r\n]/.test(value)
  );
}
export function record(value: unknown): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    return false;
  const proto = Object.getPrototypeOf(value);
  if (types.isProxy(proto)) return false;
  if (proto === null || proto === Object.prototype) return true;
  const field = Object.getOwnPropertyDescriptor(proto, "constructor");
  return (
    Object.getPrototypeOf(proto) === null &&
    !!field &&
    "value" in field &&
    typeof field.value === "function" &&
    Function.prototype.toString.call(field.value) ===
      Function.prototype.toString.call(Object)
  );
}
/** Configuration errors remain actionable even if their code resembles a read denial. */
export function permissionDenied(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || types.isProxy(cause)) return false;
  let prototype: object | null = cause;
  for (let depth = 0; prototype && depth < 16; depth++) {
    if (types.isProxy(prototype)) return false;
    const name = Object.getOwnPropertyDescriptor(prototype, "name"),
      constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    const className =
      constructor &&
      "value" in constructor &&
      typeof constructor.value === "function" &&
      !types.isProxy(constructor.value)
        ? Object.getOwnPropertyDescriptor(constructor.value, "name")
        : undefined;
    if (
      (name && "value" in name && name.value === "SourceConfigError") ||
      (className &&
        "value" in className &&
        className.value === "SourceConfigError")
    )
      return false;
    prototype = Object.getPrototypeOf(prototype);
  }
  const code = Object.getOwnPropertyDescriptor(cause, "code");
  return (
    !!code &&
    "value" in code &&
    [
      "forbidden",
      "permission_denied",
      "access_denied",
      "resource_forbidden",
      "path_not_allowed",
      "unauthorized",
    ].includes(code.value)
  );
}
const tp = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsic = (proto: object, key: PropertyKey) =>
  Object.getOwnPropertyDescriptor(proto, key)!.get!;
const viewBuffer = intrinsic(tp, "buffer"),
  viewOffset = intrinsic(tp, "byteOffset"),
  viewLength = intrinsic(tp, "byteLength"),
  bufferLength = intrinsic(ArrayBuffer.prototype, "byteLength");
export function bytes(
  value: unknown,
  maximum = limits.valueBytes,
): Buffer | null {
  if (types.isProxy(value)) return null;
  if (types.isUint8Array(value)) {
    const buffer = viewBuffer.call(value) as ArrayBuffer,
      offset = viewOffset.call(value) as number,
      length = viewLength.call(value) as number;
    check(
      length <= maximum,
      "OUTPUT_TOO_LARGE",
      "The browser byte value exceeds its negotiated budget.",
    );
    return Buffer.from(new Uint8Array(buffer, offset, length));
  }
  if (types.isArrayBuffer(value)) {
    const length = bufferLength.call(value) as number;
    check(
      length <= maximum,
      "OUTPUT_TOO_LARGE",
      "The browser byte value exceeds its negotiated budget.",
    );
    return Buffer.from(new Uint8Array(value as ArrayBuffer, 0, length));
  }
  return null;
}
function stringSize(value: string, charge: (count: number) => void): void {
  charge(2);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92) charge(2);
    else if (code < 32) charge([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
    else if (code < 128) charge(1);
    else if (code < 2048) charge(2);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        charge(4);
        i++;
      } else charge(6);
    } else if (code >= 0xdc00 && code <= 0xdfff) charge(6);
    else charge(3);
  }
}
export function data(value: unknown, maximum = limits.controlBytes): Data {
  let nodes = 0,
    total = 0;
  const active = new Set<object>();
  const charge = (count: number) => {
    total += count;
    check(
      total <= maximum,
      "OUTPUT_TOO_LARGE",
      "The browser value exceeds its encoded data budget.",
    );
  };
  const visit = (value: unknown, depth: number): Data => {
    check(
      ++nodes <= 100000 && depth <= 64,
      "INVALID_ARGUMENT",
      "The browser value exceeds its data graph budget.",
    );
    if (value === null) {
      charge(4);
      return value;
    }
    if (typeof value === "boolean") {
      charge(value ? 4 : 5);
      return value;
    }
    if (typeof value === "string") {
      stringSize(value, charge);
      return value;
    }
    if (typeof value === "number") {
      check(
        Number.isFinite(value),
        "INVALID_ARGUMENT",
        "Browser numbers must be finite.",
      );
      charge(JSON.stringify(value).length);
      return value;
    }
    check(
      value &&
        typeof value === "object" &&
        !types.isProxy(value) &&
        (Array.isArray(value) || record(value)) &&
        !active.has(value),
      "INVALID_ARGUMENT",
      "Browser arguments must be acyclic data, not controllers or accessors.",
    );
    active.add(value);
    try {
      if (Array.isArray(value)) {
        check(
          value.length <= 100000,
          "INVALID_ARGUMENT",
          "The browser array is too large.",
        );
        const out: Data[] = [];
        charge(2 + Math.max(0, value.length - 1));
        for (let i = 0; i < value.length; i++) {
          const field = Object.getOwnPropertyDescriptor(value, String(i));
          check(
            field && "value" in field,
            "INVALID_ARGUMENT",
            "Browser arrays cannot contain holes or accessors.",
          );
          out.push(visit(field.value, depth + 1));
        }
        check(
          Reflect.ownKeys(value).every(
            (key) =>
              key === "length" ||
              (typeof key === "string" &&
                /^(0|[1-9][0-9]*)$/.test(key) &&
                Number(key) < value.length),
          ),
          "INVALID_ARGUMENT",
          "Browser arrays cannot hide additional properties.",
        );
        return out;
      }
      const out = Object.create(null) as RecordData;
      charge(2);
      let fields = 0;
      for (const key of Reflect.ownKeys(value)) {
        const field = Object.getOwnPropertyDescriptor(value, key)!;
        check(
          typeof key === "string" && field.enumerable && "value" in field,
          "INVALID_ARGUMENT",
          "Browser data cannot contain hidden fields, symbols or accessors.",
        );
        stringSize(key, charge);
        charge(1 + (fields++ ? 1 : 0));
        Object.defineProperty(out, key, {
          value: visit(field.value, depth + 1),
          enumerable: true,
        });
      }
      return out;
    } finally {
      active.delete(value);
    }
  };
  const result = visit(value, 0);
  check(
    Buffer.byteLength(JSON.stringify(result)) <= maximum,
    "OUTPUT_TOO_LARGE",
    "Encoded browser data exceeds its budget.",
  );
  return result;
}
export function control(value: unknown): string {
  return JSON.stringify(data(value, limits.controlBytes));
}
export function parseControl(raw: Buffer): Record<string, unknown> {
  check(
    raw.byteLength <= limits.controlBytes,
    "PROTOCOL_MISMATCH",
    "Browser control frame is too large.",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw failure(
      "PROTOCOL_MISMATCH",
      "Browser control frames must be UTF-8 JSON.",
    );
  }
  check(
    record(parsed) && parsed.v === 1 && typeof parsed.type === "string",
    "PROTOCOL_MISMATCH",
    "Browser control frame has an unsupported envelope.",
  );
  return parsed;
}
export interface StreamBinding {
  actionId: string;
  operationId: string;
  generation: number;
}
export interface StreamInfo extends StreamBinding {
  streamId: string;
  kind: "bytes" | "json";
  size: number;
  sha256: string;
}
interface StreamState {
  meta: StreamInfo;
  chunks: Buffer[];
  sequence: number;
  received: number;
  hash: ReturnType<typeof createHash>;
  complete: boolean;
  discard: boolean;
  reserved: boolean;
  value?: Buffer;
}
export class BinaryInbox {
  #streams = new Map<string, StreamState>();
  #reserved = 0;
  begin(
    value: unknown,
    accept: (binding: StreamBinding) => boolean,
    discard = false,
  ): void {
    check(
      record(value) &&
        identifier(value.streamId) &&
        identifier(value.actionId) &&
        identifier(value.operationId) &&
        Number.isSafeInteger(value.generation) &&
        (value.kind === "bytes" || value.kind === "json") &&
        Number.isSafeInteger(value.size) &&
        Number(value.size) >= 0 &&
        Number(value.size) <= limits.valueBytes &&
        typeof value.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(value.sha256),
      "PROTOCOL_MISMATCH",
      "Invalid browser binary stream declaration.",
    );
    const meta = value as unknown as StreamInfo;
    check(
      accept(meta) &&
        !this.#streams.has(meta.streamId) &&
        this.#streams.size < limits.maxAttachments &&
        [...this.#streams.values()].filter(
          (stream) => !stream.complete && !stream.discard,
        ).length < limits.maxStreams &&
        this.#reserved + meta.size <= limits.valueBytes,
      "PROTOCOL_MISMATCH",
      "The browser binary stream is unbound, duplicate or exceeds its budget.",
    );
    this.#reserved += meta.size;
    this.#streams.set(meta.streamId, {
      meta,
      chunks: [],
      sequence: 0,
      received: 0,
      hash: createHash("sha256"),
      complete: false,
      discard,
      reserved: true,
    });
  }
  push(raw: Buffer): void {
    check(
      raw.byteLength >= 4,
      "PROTOCOL_MISMATCH",
      "A browser binary frame has no header.",
    );
    const count = raw.readUInt32BE(0);
    check(
      count > 0 &&
        count <= limits.headerBytes &&
        raw.byteLength >= 4 + count &&
        raw.byteLength - 4 - count <= limits.chunkBytes,
      "PROTOCOL_MISMATCH",
      "A browser binary frame exceeds its header or payload budget.",
    );
    let header: unknown;
    try {
      header = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          raw.subarray(4, 4 + count),
        ),
      );
    } catch {
      throw failure("PROTOCOL_MISMATCH", "Invalid browser binary header.");
    }
    check(
      record(header) && identifier(header.streamId),
      "PROTOCOL_MISMATCH",
      "A browser binary frame has no stream identity.",
    );
    const state = this.#streams.get(header.streamId);
    check(
      state &&
        !state.complete &&
        header.actionId === state.meta.actionId &&
        header.operationId === state.meta.operationId &&
        header.generation === state.meta.generation &&
        header.kind === state.meta.kind &&
        header.sequence === state.sequence,
      "PROTOCOL_MISMATCH",
      "A browser binary frame has a stale or out-of-order binding.",
    );
    const payload = raw.subarray(4 + count);
    check(
      payload.byteLength > 0 &&
        state.received + payload.byteLength <= state.meta.size,
      "PROTOCOL_MISMATCH",
      "The browser binary stream exceeds its declared byte count.",
    );
    state.sequence++;
    state.received += payload.byteLength;
    state.hash.update(payload);
    if (!state.discard) state.chunks.push(Buffer.from(payload));
  }
  end(value: unknown): void {
    check(
      record(value) && identifier(value.streamId),
      "PROTOCOL_MISMATCH",
      "A browser binary end has no identity.",
    );
    const state = this.#streams.get(value.streamId);
    check(
      state &&
        !state.complete &&
        value.actionId === state.meta.actionId &&
        value.operationId === state.meta.operationId &&
        value.generation === state.meta.generation &&
        value.size === state.received &&
        value.sha256 === state.meta.sha256 &&
        state.received === state.meta.size,
      "PROTOCOL_MISMATCH",
      "The browser binary stream ended with a mismatching binding or size.",
    );
    check(
      state.hash.digest("hex") === state.meta.sha256,
      "PROTOCOL_MISMATCH",
      "The browser binary stream hash does not match.",
    );
    state.complete = true;
    if (state.discard) {
      this.#streams.delete(state.meta.streamId);
      if (state.reserved) this.#reserved -= state.meta.size;
    } else state.value = Buffer.concat(state.chunks, state.received);
    state.chunks = [];
  }
  take(id: string, binding: StreamBinding): Buffer {
    const state = this.#streams.get(id);
    check(
      state?.complete &&
        state.value &&
        state.meta.actionId === binding.actionId &&
        state.meta.operationId === binding.operationId &&
        state.meta.generation === binding.generation,
      "PROTOCOL_MISMATCH",
      "Browser result refers to an incomplete or unrelated binary stream.",
    );
    this.#streams.delete(id);
    if (state.reserved) this.#reserved -= state.meta.size;
    return state.value;
  }
  discard(actionId?: string): void {
    for (const [key, value] of this.#streams)
      if (!actionId || value.meta.actionId === actionId) {
        if (value.reserved) {
          this.#reserved -= value.meta.size;
          value.reserved = false;
        }
        if (!actionId || value.complete) this.#streams.delete(key);
        else {
          value.discard = true;
          value.chunks = [];
        }
      }
  }
}
export interface Attachment {
  streamId: string;
  path: (string | number)[];
}
export interface Packed {
  value: Data;
  attachments: Attachment[];
  streams: { meta: StreamInfo; bytes: Buffer }[];
  valueStream?: string;
}
export function pack(value: unknown, binding: StreamBinding): Packed {
  const streams: Packed["streams"] = [],
    attachments: Attachment[] = [],
    active = new Set<object>();
  let total = 0,
    nodes = 0,
    jsonBytes = 0;
  const charge = (count: number) => {
    jsonBytes += count;
    check(
      total + jsonBytes <= limits.valueBytes,
      "OUTPUT_TOO_LARGE",
      "The browser value exceeds its aggregate data budget.",
    );
  };
  const stream = (payload: Buffer, kind: "bytes" | "json") => {
    total += payload.length;
    check(
      total <= limits.valueBytes && streams.length < limits.maxAttachments,
      "OUTPUT_TOO_LARGE",
      "The browser value exceeds its stream budget.",
    );
    const streamId = randomUUID();
    streams.push({
      meta: {
        ...binding,
        streamId,
        kind,
        size: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
      bytes: payload,
    });
    return streamId;
  };
  const visit = (
    value: unknown,
    path: (string | number)[],
    depth: number,
  ): Data => {
    check(
      ++nodes <= 100000 && depth <= 64,
      "INVALID_ARGUMENT",
      "Browser values exceed the graph budget.",
    );
    const binary = bytes(value, limits.valueBytes - total - jsonBytes);
    if (binary) {
      attachments.push({ streamId: stream(binary, "bytes"), path });
      charge(4);
      return null;
    }
    if (value === undefined || value === null) {
      charge(4);
      return null;
    }
    if (typeof value === "string") {
      stringSize(value, charge);
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      const scalar = data(value, 32);
      charge(JSON.stringify(scalar).length);
      return scalar;
    }
    check(
      typeof value === "object",
      "INVALID_ARGUMENT",
      "Browser values cannot contain functions or unsupported primitives.",
    );
    check(
      !types.isProxy(value) &&
        (Array.isArray(value) || record(value)) &&
        !active.has(value),
      "INVALID_ARGUMENT",
      "Only native bytes or acyclic browser data can cross the connection.",
    );
    active.add(value);
    try {
      if (Array.isArray(value)) {
        check(
          value.length <= 100000,
          "INVALID_ARGUMENT",
          "The browser array is too large.",
        );
        const result: Data[] = [];
        charge(2 + Math.max(0, value.length - 1));
        for (let i = 0; i < value.length; i++) {
          const field = Object.getOwnPropertyDescriptor(value, String(i));
          check(
            field && "value" in field,
            "INVALID_ARGUMENT",
            "Browser arrays cannot contain holes or accessors.",
          );
          result.push(visit(field.value, [...path, i], depth + 1));
        }
        return result;
      }
      const result = Object.create(null) as RecordData;
      charge(2);
      let fields = 0;
      for (const key of Reflect.ownKeys(value)) {
        const field = Object.getOwnPropertyDescriptor(value, key)!;
        check(
          typeof key === "string" && field.enumerable && "value" in field,
          "INVALID_ARGUMENT",
          "Browser arguments cannot contain accessors or private fields.",
        );
        if (field.value === undefined) continue;
        stringSize(key, charge);
        charge(1 + (fields++ ? 1 : 0));
        Object.defineProperty(result, key, {
          value: visit(field.value, [...path, key], depth + 1),
          enumerable: true,
        });
      }
      return result;
    } finally {
      active.delete(value);
    }
  };
  const copied = visit(value, [], 0),
    encoded = Buffer.from(JSON.stringify(copied));
  total += encoded.length;
  check(
    total <= limits.valueBytes,
    "OUTPUT_TOO_LARGE",
    "The browser value exceeds its aggregate budget.",
  );
  if (encoded.length > limits.controlBytes / 2) {
    total -= encoded.length;
    return {
      value: null,
      attachments,
      streams,
      valueStream: stream(encoded, "json"),
    };
  }
  return { value: copied, attachments, streams };
}
export function unpack(
  value: unknown,
  attachments: unknown,
  valueStream: unknown,
  inbox: BinaryInbox,
  binding: StreamBinding,
): unknown {
  let result = valueStream
    ? JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          inbox.take(String(valueStream), binding),
        ),
      )
    : value;
  check(
    attachments === undefined ||
      (Array.isArray(attachments) &&
        attachments.length <= limits.maxAttachments),
    "PROTOCOL_MISMATCH",
    "Invalid browser attachment list.",
  );
  for (const item of (attachments ?? []) as unknown[]) {
    check(
      record(item) &&
        identifier(item.streamId) &&
        Array.isArray(item.path) &&
        item.path.length <= 64 &&
        item.path.every(
          (part) =>
            typeof part === "string" ||
            (Number.isSafeInteger(part) && Number(part) >= 0),
        ),
      "PROTOCOL_MISMATCH",
      "Invalid browser binary attachment path.",
    );
    const payload = inbox.take(item.streamId, binding);
    if (!item.path.length) {
      result = payload;
      continue;
    }
    let parent = result;
    for (const part of item.path.slice(0, -1)) {
      check(
        parent && typeof parent === "object" && Object.hasOwn(parent, part),
        "PROTOCOL_MISMATCH",
        "A browser binary attachment points outside its value.",
      );
      parent = (parent as Record<string, unknown>)[part as string];
    }
    const key = item.path.at(-1)!;
    check(
      parent &&
        typeof parent === "object" &&
        Object.hasOwn(parent, key) &&
        (parent as Record<string, unknown>)[key as string] === null,
      "PROTOCOL_MISMATCH",
      "A browser binary attachment cannot replace unrelated data.",
    );
    Object.defineProperty(parent, key, {
      value: payload,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
export function* frames(meta: StreamInfo, payload: Buffer): Generator<Buffer> {
  for (
    let offset = 0, sequence = 0;
    offset < payload.length;
    offset += limits.chunkBytes, sequence++
  ) {
    const header = Buffer.from(JSON.stringify({ ...meta, sequence }));
    check(
      header.length <= limits.headerBytes,
      "PROTOCOL_MISMATCH",
      "The browser stream header is too large.",
    );
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(header.length);
    yield Buffer.concat([
      prefix,
      header,
      payload.subarray(offset, offset + limits.chunkBytes),
    ]);
  }
}
