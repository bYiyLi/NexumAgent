import { BrowserActionError, requireValue, record, text } from "./errors.js";

export const transportLimits = Object.freeze({
  controlBytes: 1048576,
  headerBytes: 4096,
  chunkBytes: 65536,
  maxStreams: 8,
  maxAttachments: 1024,
  valueBytes: 128 * 1024 * 1024,
  inFlight: 64,
});
const encode = new TextEncoder(),
  decode = new TextDecoder("utf-8", { fatal: true });
const same = (a, b) =>
  a.actionId === b.actionId &&
  a.operationId === b.operationId &&
  a.generation === b.generation;
const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export function parseControl(raw) {
  requireValue(
    typeof raw === "string" &&
      encode.encode(raw).byteLength <= transportLimits.controlBytes,
    "PROTOCOL_MISMATCH",
    "The control frame is not bounded UTF-8 JSON.",
  );
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BrowserActionError(
      "PROTOCOL_MISMATCH",
      "The control frame is not JSON.",
    );
  }
  record(value);
  requireValue(
    value.v === 1 && typeof value.type === "string",
    "PROTOCOL_MISMATCH",
    "The control envelope is unsupported.",
  );
  return value;
}
export class BrowserBinaryInbox {
  #streams = new Map();
  #reserved = 0;
  begin(meta, accept) {
    record(meta);
    text(meta.streamId, 256);
    text(meta.actionId, 256);
    text(meta.operationId, 256);
    requireValue(
      Number.isSafeInteger(meta.generation) &&
        ["bytes", "json"].includes(meta.kind) &&
        Number.isSafeInteger(meta.size) &&
        meta.size >= 0 &&
        meta.size <= transportLimits.valueBytes &&
        typeof meta.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(meta.sha256),
      "PROTOCOL_MISMATCH",
      "The binary declaration is invalid.",
    );
    requireValue(
      accept(meta) &&
        !this.#streams.has(meta.streamId) &&
        this.#streams.size < transportLimits.maxAttachments &&
        [...this.#streams.values()].filter((v) => !v.complete).length <
          transportLimits.maxStreams &&
        this.#reserved + meta.size <= transportLimits.valueBytes,
      "PROTOCOL_MISMATCH",
      "The binary stream is unbound, duplicate or exceeds its budget.",
    );
    this.#streams.set(meta.streamId, {
      meta,
      sequence: 0,
      received: 0,
      chunks: [],
      complete: false,
    });
    this.#reserved += meta.size;
  }
  push(frame, ignore = () => false) {
    const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
    requireValue(
      bytes instanceof Uint8Array && bytes.byteLength >= 4,
      "PROTOCOL_MISMATCH",
      "The binary frame is invalid.",
    );
    const size = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(0);
    requireValue(
      size > 0 &&
        size <= transportLimits.headerBytes &&
        bytes.byteLength >= 4 + size &&
        bytes.byteLength - 4 - size <= transportLimits.chunkBytes,
      "PROTOCOL_MISMATCH",
      "The binary header or payload exceeds its budget.",
    );
    let header;
    try {
      header = JSON.parse(decode.decode(bytes.subarray(4, 4 + size)));
    } catch {
      throw new BrowserActionError(
        "PROTOCOL_MISMATCH",
        "The binary header is invalid.",
      );
    }
    if (ignore(header)) return false;
    const state = this.#streams.get(header.streamId);
    requireValue(
      state &&
        !state.complete &&
        !state.ending &&
        same(header, state.meta) &&
        header.kind === state.meta.kind &&
        header.sequence === state.sequence,
      "PROTOCOL_MISMATCH",
      "The binary chunk is stale or out of order.",
    );
    const payload = bytes.subarray(4 + size);
    requireValue(
      payload.byteLength > 0 &&
        state.received + payload.byteLength <= state.meta.size,
      "PROTOCOL_MISMATCH",
      "The binary byte count differs from its declaration.",
    );
    state.sequence++;
    state.received += payload.byteLength;
    state.chunks.push(payload.slice());
  }
  async end(meta) {
    record(meta);
    const state = this.#streams.get(meta.streamId);
    requireValue(
      state &&
        !state.complete &&
        !state.ending &&
        same(meta, state.meta) &&
        state.received === state.meta.size &&
        meta.size === state.received &&
        meta.sha256 === state.meta.sha256,
      "PROTOCOL_MISMATCH",
      "The binary end does not match its source.",
    );
    state.ending = true;
    const value = new Uint8Array(state.received);
    let offset = 0;
    for (const chunk of state.chunks) {
      value.set(chunk, offset);
      offset += chunk.byteLength;
    }
    requireValue(
      (await digest(value)) === state.meta.sha256,
      "PROTOCOL_MISMATCH",
      "The binary hash does not match.",
    );
    requireValue(
      this.#streams.get(meta.streamId) === state,
      "PROTOCOL_MISMATCH",
      "The stream was cancelled before validation completed.",
    );
    state.value = value;
    state.chunks = [];
    state.complete = true;
  }
  complete(id, binding) {
    const state = this.#streams.get(id);
    return !!(state?.complete && same(state.meta, binding));
  }
  take(id, binding) {
    const state = this.#streams.get(id);
    requireValue(
      state?.complete && same(state.meta, binding),
      "PROTOCOL_MISMATCH",
      "The result refers to an unrelated or incomplete binary stream.",
    );
    this.#streams.delete(id);
    this.#reserved -= state.meta.size;
    return state.value;
  }
  discard(actionId) {
    for (const [id, state] of this.#streams)
      if (!actionId || state.meta.actionId === actionId) {
        this.#streams.delete(id);
        this.#reserved -= state.meta.size;
      }
  }
}
export function unpackBrowserValue(
  value,
  attachments,
  valueStream,
  inbox,
  binding,
) {
  let result = valueStream
    ? JSON.parse(decode.decode(inbox.take(valueStream, binding)))
    : value;
  requireValue(
    attachments === undefined ||
      (Array.isArray(attachments) &&
        attachments.length <= transportLimits.maxAttachments),
    "PROTOCOL_MISMATCH",
    "The attachment manifest is invalid.",
  );
  const paths = new Set();
  for (const entry of attachments ?? []) {
    record(entry);
    text(entry.streamId, 256);
    requireValue(
      Array.isArray(entry.path) &&
        entry.path.length <= 64 &&
        entry.path.every(
          (p) =>
            (typeof p === "string" &&
              !["__proto__", "prototype", "constructor"].includes(p)) ||
            (Number.isSafeInteger(p) && p >= 0),
        ),
      "PROTOCOL_MISMATCH",
      "The attachment path is invalid.",
    );
    const path = JSON.stringify(entry.path);
    requireValue(
      !paths.has(path),
      "PROTOCOL_MISMATCH",
      "An attachment path cannot be replaced twice.",
    );
    paths.add(path);
    const bytes = inbox.take(entry.streamId, binding);
    if (entry.path.length === 0) {
      requireValue(
        result === null,
        "PROTOCOL_MISMATCH",
        "The root byte attachment must replace a null placeholder.",
      );
      result = bytes;
      continue;
    }
    let parent = result;
    for (const part of entry.path.slice(0, -1)) {
      requireValue(
        parent && typeof parent === "object" && Object.hasOwn(parent, part),
        "PROTOCOL_MISMATCH",
        "An attachment escapes its declared value.",
      );
      parent = parent[part];
    }
    const last = entry.path.at(-1);
    requireValue(
      parent &&
        typeof parent === "object" &&
        Object.hasOwn(parent, last) &&
        parent[last] === null,
      "PROTOCOL_MISMATCH",
      "An attachment must replace a null placeholder.",
    );
    Object.defineProperty(parent, last, {
      value: bytes,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
export async function packBrowserValue(value, binding) {
  const streams = [],
    attachments = [],
    active = new Set();
  let count = 0,
    total = 0,
    jsonBytes = 0;
  const stream = async (bytes, kind) => {
    total += bytes.byteLength;
    requireValue(
      total <= transportLimits.valueBytes &&
        streams.length < transportLimits.maxAttachments,
      "OUTPUT_TOO_LARGE",
      "The browser result exceeds its byte or attachment budget.",
    );
    const streamId = crypto.randomUUID();
    streams.push({
      meta: {
        ...binding,
        streamId,
        kind,
        size: bytes.byteLength,
        sha256: await digest(bytes),
      },
      bytes,
    });
    return streamId;
  };
  const visit = async (value, path, depth) => {
    requireValue(
      ++count <= 100000 && depth <= 64,
      "OUTPUT_TOO_LARGE",
      "The browser data graph exceeds its budget.",
    );
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value).slice()
          : new Uint8Array(
              value.buffer,
              value.byteOffset,
              value.byteLength,
            ).slice();
      attachments.push({ streamId: await stream(bytes, "bytes"), path });
      return null;
    }
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      jsonBytes += encode.encode(value).byteLength;
      requireValue(
        total + jsonBytes <= transportLimits.valueBytes,
        "OUTPUT_TOO_LARGE",
      );
      return value;
    }
    if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    requireValue(
      typeof value === "object" && !active.has(value),
      "INVALID_ARGUMENT",
      "Only acyclic browser data can cross the connection.",
    );
    active.add(value);
    try {
      if (Array.isArray(value)) {
        requireValue(value.length <= 100000);
        const result = [];
        for (let i = 0; i < value.length; i++) {
          const field = Object.getOwnPropertyDescriptor(value, String(i));
          requireValue(field && "value" in field);
          result.push(await visit(field.value, [...path, i], depth + 1));
        }
        return result;
      }
      record(value);
      const result = Object.create(null);
      for (const key of Object.keys(value)) {
        jsonBytes += encode.encode(key).byteLength;
        requireValue(
          total + jsonBytes <= transportLimits.valueBytes,
          "OUTPUT_TOO_LARGE",
        );
        if (value[key] !== undefined)
          Object.defineProperty(result, key, {
            value: await visit(value[key], [...path, key], depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      return result;
    } finally {
      active.delete(value);
    }
  };
  const copied = await visit(value, [], 0),
    encoded = encode.encode(JSON.stringify(copied));
  requireValue(
    encoded.byteLength +
      streams.reduce((sum, item) => sum + item.bytes.byteLength, 0) <=
      transportLimits.valueBytes,
    "OUTPUT_TOO_LARGE",
    "The result exceeds its aggregate byte budget.",
  );
  if (encoded.byteLength > transportLimits.controlBytes / 2)
    return {
      value: null,
      valueStream: await stream(encoded, "json"),
      attachments,
      streams,
    };
  return { value: copied, attachments, streams };
}
export function* browserFrames(meta, bytes) {
  for (
    let offset = 0, sequence = 0;
    offset < bytes.byteLength;
    offset += transportLimits.chunkBytes, sequence++
  ) {
    const header = encode.encode(JSON.stringify({ ...meta, sequence }));
    requireValue(header.byteLength <= transportLimits.headerBytes);
    const size = Math.min(
        transportLimits.chunkBytes,
        bytes.byteLength - offset,
      ),
      frame = new Uint8Array(4 + header.byteLength + size);
    new DataView(frame.buffer).setUint32(0, header.byteLength);
    frame.set(header, 4);
    frame.set(bytes.subarray(offset, offset + size), 4 + header.byteLength);
    yield frame;
  }
}
