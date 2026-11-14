import path from "node:path";
import { types } from "node:util";
import { Blob, File } from "node:buffer";
import { AgentError } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import type { JsonObject, JsonValue } from "../contracts/types.js";
import { transferOffer } from "../transfer/offers.js";
import { mcpResult } from "./mcp.js";
import {
  createOutput,
  outputIntent,
  type OutputIntent,
} from "../sdk/output.js";

export interface NormalizeOptions {
  mode?: "auto" | "data";
  pwd?: string;
  /** Diagnostic location; long prefixes are bounded and marked in conversions/errors. */
  resolveContent?(value: unknown, position: string): Promise<JsonValue>;
  /** Issued Offers use this same walk/budget, including explicit pure data. */
  resolveTransferOffer?(value: unknown): Promise<JsonValue>;
  /** Trusted remote protocol results use this same bounded data walk. */
  resolveMcpResult?(value: unknown): Promise<JsonValue>;
  assertCurrent?(): void;
  maxDepth?: number;
  maxNodes?: number;
  /** Encoded ordinary JSON and conversion metadata; media bytes are separate. */
  maxBytes?: number;
  maxConversions?: number;
}
export interface NormalizedData {
  data: JsonValue;
  conversions: JsonObject[];
}

const href = Object.getOwnPropertyDescriptor(URL.prototype, "href")!.get!;
const viewBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const regexSource = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  "source",
)!.get!;
const regexFlags = [
  ["hasIndices", "d"],
  ["global", "g"],
  ["ignoreCase", "i"],
  ["multiline", "m"],
  ["dotAll", "s"],
  ["unicode", "u"],
  ["unicodeSets", "v"],
  ["sticky", "y"],
].map(([name, flag]) => ({
  get: Object.getOwnPropertyDescriptor(RegExp.prototype, name!)?.get,
  flag: flag!,
}));

interface ResultPath {
  text: string;
  truncated: boolean;
}
const rootPath: ResultPath = { text: "$", truncated: false };
const pathByteLimit = 512;
function safePath(position: ResultPath): JsonObject {
  return {
    path: position.text,
    ...(position.truncated ? { pathTruncated: true } : {}),
  };
}
function problem(code: string, message: string, position: ResultPath): never {
  throw new AgentError(code, message, safePath(position));
}
function appendPath(
  position: ResultPath,
  segment: string,
  segmentTruncated = false,
): ResultPath {
  if (position.truncated) return position;
  // A field contributes at most 512 source code units, so even JSON escaping
  // cannot create a large temporary path before this independent limit applies.
  const candidate = position.text + segment;
  const encoded = Buffer.from(candidate);
  if (!segmentTruncated && encoded.byteLength <= pathByteLimit)
    return { text: candidate, truncated: false };
  let end = Math.min(encoded.byteLength, pathByteLimit - 3);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return {
    text: encoded.subarray(0, end).toString("utf8") + "…",
    truncated: true,
  };
}
function field(position: ResultPath, key: string): ResultPath {
  if (position.truncated) return position;
  const prefix = key.slice(0, pathByteLimit);
  const complete = prefix.length === key.length;
  const segment =
    complete && /^[A-Za-z_$][\w$]*$/.test(prefix)
      ? `.${prefix}`
      : `[${JSON.stringify(prefix)}]`;
  return appendPath(position, segment, !complete);
}
function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}
function nativeValue(
  getter: (this: unknown) => unknown,
  value: object,
): unknown {
  try {
    return Reflect.apply(getter, value, []);
  } catch {
    return undefined;
  }
}
function blobKind(value: object, position: ResultPath): "Blob" | "File" | null {
  let prototype = Object.getPrototypeOf(value);
  for (let depth = 0; prototype && depth < 64; depth++) {
    if (types.isProxy(prototype))
      problem(
        "invalid_result_data",
        "A result prototype cannot be a Proxy.",
        position,
      );
    if (prototype === File.prototype) return "File";
    if (prototype === Blob.prototype) return "Blob";
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

/** Validate actual content descriptions without reading bytes or touching files. */
export function contentValue(
  value: unknown,
  pwd: string,
): OutputIntent | Readonly<Record<string, unknown>> | null {
  const known = outputIntent(value);
  if (known) return known.kind === "json" ? null : known;
  if (!isPlainRecord(value)) return null;
  const tag = Object.getOwnPropertyDescriptor(value, "type");
  if (!tag?.enumerable || !("value" in tag)) return null;
  const kind = tag.value;
  const locator = ["path", "data", "uri"].some((key) => own(value, key));
  const candidate =
    (kind === "text" && own(value, "text")) ||
    (["image", "audio", "resource_link"].includes(kind) && locator) ||
    (kind === "resource" && (locator || own(value, "resource")));
  if (!candidate) return null;
  const result = outputIntent(
    createOutput(pwd, () => {}).result({ content: [value] }),
  )!;
  return (result.value as { content: Record<string, unknown>[] }).content[0]!;
}

/**
 * Convert business data to fresh JSON without invoking author conversion hooks.
 * The supplied resolver owns permission checks, immutable bytes and media I/O.
 */
export async function normalizeData(
  value: unknown,
  options: NormalizeOptions = {},
): Promise<NormalizedData> {
  const maximum = {
    depth: options.maxDepth ?? 64,
    nodes: options.maxNodes ?? 100000,
    bytes: options.maxBytes ?? 64 * 1024,
    conversions: options.maxConversions ?? 1000,
  };
  if (
    ![maximum.depth, maximum.nodes, maximum.bytes, maximum.conversions].every(
      (limit) => Number.isSafeInteger(limit) && limit >= 0,
    ) ||
    maximum.depth > 1024 ||
    maximum.nodes < 1 ||
    maximum.bytes < 2 ||
    (options.mode !== undefined && !["auto", "data"].includes(options.mode))
  )
    throw new AgentError(
      "invalid_normalization_options",
      "Data normalization needs valid bounded limits and a known mode.",
    );
  const pwd = options.pwd ?? path.resolve(".");
  const conversions: JsonObject[] = [];
  const ancestors = new Set<object>();
  let nodes = 0,
    bytes = 0,
    conversionBytes = 2;

  function charge(amount: number, position: ResultPath): void {
    bytes += amount;
    if (bytes + conversionBytes + 24 > maximum.bytes)
      problem(
        "result_data_too_large",
        "The encoded business data and conversion metadata exceed their byte budget.",
        position,
      );
  }
  function encodedTextBytes(
    input: string,
    remaining: number,
    position: ResultPath,
  ): number {
    // JSON escapes can be six times larger than the original string. Count
    // UTF-16 code units without allocating the escaped string, stopping as soon
    // as the remaining budget is exceeded. Surrogate pairs stay a single UTF-8
    // code point; unpaired surrogates use JSON's six-byte \uXXXX encoding.
    let encoded = 2; // Quotes.
    for (let index = 0; encoded <= remaining && index < input.length; index++) {
      const code = input.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) encoded += 2;
      else if (code <= 0x1f)
        encoded +=
          code === 8 || code === 9 || code === 10 || code === 12 || code === 13
            ? 2
            : 6;
      else if (code <= 0x7f) encoded++;
      else if (code <= 0x7ff) encoded += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          encoded += 4;
          index++;
        } else encoded += 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) encoded += 6;
      else encoded += 3;
    }
    if (encoded > remaining)
      problem(
        "result_data_too_large",
        "A data string exceeds its encoded byte budget.",
        position,
      );
    return encoded;
  }
  function text(input: string, position: ResultPath): string {
    charge(
      encodedTextBytes(
        input,
        maximum.bytes - bytes - conversionBytes - 24,
        position,
      ),
      position,
    );
    return input;
  }
  function converted(position: ResultPath, from: string, to: string): void {
    if (conversions.length >= maximum.conversions)
      problem(
        "result_data_too_large",
        "Conversion metadata exceeds its entry budget.",
        position,
      );
    const conversion = { ...safePath(position), from, to };
    const remaining = maximum.bytes - bytes - conversionBytes - 24;
    // Fixed object syntax plus its three string values, including a list comma.
    let encoded =
      23 +
      (conversions.length ? 1 : 0) +
      (position.truncated ? Buffer.byteLength(',"pathTruncated":true') : 0);
    for (const value of [position.text, from, to])
      encoded += encodedTextBytes(value, remaining - encoded, position);
    conversionBytes += encoded;
    charge(0, position);
    conversions.push(conversion);
  }
  function enumerableKeys(input: object, position: ResultPath): string[] {
    if (
      Object.getOwnPropertySymbols(input).some(
        (key) => Object.getOwnPropertyDescriptor(input, key)?.enumerable,
      )
    )
      problem(
        "invalid_result_data",
        "Enumerable Symbol keys cannot be represented as JSON.",
        position,
      );
    const keys = Object.keys(input);
    if (keys.length > maximum.nodes - nodes)
      problem(
        "result_data_too_large",
        "Data exceeds its remaining property budget.",
        position,
      );
    return keys;
  }
  function dataProperty(
    input: object,
    key: string,
    position: ResultPath,
  ): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor))
      problem(
        "invalid_result_data",
        "Data accessors and array holes require an explicit value.",
        position,
      );
    return descriptor.value;
  }
  async function media(
    input: unknown,
    position: ResultPath,
    depth: number,
    from: string,
  ): Promise<JsonValue> {
    if (!options.resolveContent)
      problem(
        "result_content_resolver_required",
        "Binary and content results need an authorized resource resolver.",
        position,
      );
    options.assertCurrent?.();
    let reference: JsonValue;
    try {
      reference = await options.resolveContent(input, position.text);
    } catch (cause) {
      const code =
        cause &&
        typeof cause === "object" &&
        !types.isProxy(cause) &&
        types.isNativeError(cause)
          ? Object.getOwnPropertyDescriptor(cause, "code")
          : undefined;
      throw new AgentError(
        code &&
          "value" in code &&
          typeof code.value === "string" &&
          /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(code.value)
          ? code.value
          : "result_content_resolution_failed",
        "The result content could not be resolved at the indicated data position.",
        safePath(position),
        { cause },
      );
    }
    options.assertCurrent?.();
    converted(position, from, "resource-association");
    // A resource reference is data even if it contains a type/URI field.
    return visit(reference, position, depth, true);
  }
  function sharedView(input: object): boolean {
    const buffer = types.isDataView(input)
      ? Reflect.apply(dataViewBuffer, input, [])
      : Reflect.apply(viewBuffer, input, []);
    return types.isSharedArrayBuffer(buffer);
  }
  function errorName(input: object, position: ResultPath): string {
    let current: object | null = input;
    for (let count = 0; current && count < maximum.depth + 1; count++) {
      if (types.isProxy(current))
        problem(
          "invalid_result_data",
          "Error metadata cannot use a Proxy prototype.",
          position,
        );
      const descriptor = Object.getOwnPropertyDescriptor(current, "name");
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "string")
          problem(
            "invalid_result_data",
            "An Error name must be a data string.",
            field(position, "name"),
          );
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current);
    }
    return "Error";
  }

  async function visit(
    input: unknown,
    position: ResultPath,
    depth: number,
    pure: boolean,
    synthetic = false,
  ): Promise<JsonValue> {
    options.assertCurrent?.();
    if (++nodes > maximum.nodes || depth > maximum.depth)
      problem(
        "result_data_too_large",
        "Data exceeds its depth or node budget.",
        position,
      );
    if (input === null || typeof input === "boolean") {
      charge(input === null ? 4 : input ? 4 : 5, position);
      return input;
    }
    if (typeof input === "string") return text(input, position);
    if (typeof input === "number") {
      if (!Number.isFinite(input))
        problem(
          "invalid_result_data",
          "Non-finite numbers require an explicit representation.",
          position,
        );
      if (Object.is(input, -0)) converted(position, "-0", "0");
      charge(Buffer.byteLength(String(input)), position);
      return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input === "bigint") {
      converted(position, "BigInt", "decimal-string");
      const digits =
        maximum.bytes - bytes - conversionBytes - 26 - (input < 0n ? 1 : 0);
      if (digits < 1)
        problem(
          "result_data_too_large",
          "A BigInt decimal representation exceeds its byte budget.",
          position,
        );
      // This rational is an upper bound for log2(10). Computing a shift count
      // uses only tiny integers, unlike constructing 10 ** remainingBytes.
      // A value that passes needs at most the decimal budget plus a few chars;
      // exact escaped-string accounting below decides the final boundary.
      const bits =
        (BigInt(digits) * 3321928094887363n + 999999999999999n) /
        1000000000000000n;
      const leading = input >> bits;
      if (input >= 0n ? leading !== 0n : leading !== -1n)
        problem(
          "result_data_too_large",
          "A BigInt decimal representation exceeds its byte budget.",
          position,
        );
      return text(BigInt.prototype.toString.call(input), position);
    }
    if (!input || typeof input !== "object")
      problem(
        "invalid_result_data",
        "Undefined, functions and Symbols require an explicit JSON value.",
        position,
      );
    if (types.isProxy(input))
      problem(
        "invalid_result_data",
        "Proxy objects are not result data.",
        position,
      );
    if (types.isPromise(input))
      problem(
        "invalid_result_data",
        "Await nested Promises before returning their containing data.",
        position,
      );
    if (ancestors.has(input))
      problem(
        "invalid_result_data",
        "Circular data cannot be represented as JSON.",
        position,
      );
    ancestors.add(input);
    try {
      if (mcpResult(input)) {
        if (!options.resolveMcpResult)
          problem(
            "result_mcp_resolver_required",
            "A trusted MCP result needs its source-aware resolver.",
            position,
          );
        const data = await options.resolveMcpResult(input);
        options.assertCurrent?.();
        converted(position, "McpResult", "content-association");
        return await visit(data, position, depth, true);
      }
      if (transferOffer(input)) {
        if (!options.resolveTransferOffer)
          problem(
            "result_transfer_resolver_required",
            "An issued Offer requires its controlled transfer result resolver.",
            position,
          );
        const data = await options.resolveTransferOffer(input);
        options.assertCurrent?.();
        converted(position, "TransferOffer", "transfer-snapshot");
        return await visit(data, position, depth, true);
      }
      const known = outputIntent(input);
      if (known?.kind === "json")
        return await visit(known.value, position, depth, true);
      if (known) {
        if (pure)
          problem(
            "invalid_result_data",
            "Pure data cannot contain output intentions; move them into content.",
            position,
          );
        return await media(known, position, depth, "content");
      }
      if (!pure && !synthetic) {
        let content: ReturnType<typeof contentValue>;
        try {
          content = contentValue(input, pwd);
        } catch (cause) {
          throw new AgentError(
            "invalid_result_content",
            "The content description is invalid.",
            safePath(position),
            { cause },
          );
        }
        if (content) return await media(content, position, depth, "content");
      }
      if (types.isSharedArrayBuffer(input))
        problem(
          "invalid_result_data",
          "SharedArrayBuffer requires an explicit content source.",
          position,
        );
      if (types.isAnyArrayBuffer(input) || types.isArrayBufferView(input)) {
        if (types.isArrayBufferView(input) && sharedView(input))
          problem(
            "invalid_result_data",
            "A shared byte view requires an explicit content source.",
            position,
          );
        if (pure)
          problem(
            "invalid_result_data",
            "Pure data cannot contain binary values; move them into content.",
            position,
          );
        const from = Buffer.isBuffer(input)
          ? "Buffer"
          : types.isDataView(input)
            ? "DataView"
            : types.isArrayBufferView(input)
              ? "TypedArray"
              : "ArrayBuffer";
        return await media(input, position, depth, from);
      }
      // Node Blob/File's public getters read discoverable Symbol fields. Merely
      // probing them on arbitrary objects would execute caller accessors. Route
      // candidates by a safe prototype walk; the byte resolver validates the
      // actual native source before taking its immutable snapshot.
      const blob = blobKind(input, position);
      if (blob !== null) {
        if (pure)
          problem(
            "invalid_result_data",
            "Pure data cannot contain Blob/File values; move them into content.",
            position,
          );
        return await media(input, position, depth, blob);
      }
      if (types.isDate(input)) {
        const time = Date.prototype.getTime.call(input);
        if (!Number.isFinite(time))
          problem(
            "invalid_result_data",
            "An invalid Date has no ISO timestamp.",
            position,
          );
        converted(position, "Date", "iso8601-utc");
        return text(Date.prototype.toISOString.call(input), position);
      }
      if (types.isMap(input)) {
        const size = Reflect.apply(mapSize, input, []) as number;
        if (size > Math.floor((maximum.nodes - nodes) / 3))
          problem(
            "result_data_too_large",
            "Map entries exceed the remaining node budget.",
            position,
          );
        const entries: unknown[][] = [];
        Map.prototype.forEach.call(input, (value: unknown, key: unknown) =>
          entries.push([key, value]),
        );
        converted(position, "Map", "entries");
        return await visit(entries, position, depth, pure, true);
      }
      if (types.isSet(input)) {
        const size = Reflect.apply(setSize, input, []) as number;
        if (size > maximum.nodes - nodes)
          problem(
            "result_data_too_large",
            "Set entries exceed the remaining node budget.",
            position,
          );
        const items: unknown[] = [];
        Set.prototype.forEach.call(input, (item: unknown) => items.push(item));
        converted(position, "Set", "array");
        return await visit(items, position, depth, pure, true);
      }
      if (types.isRegExp(input)) {
        const source = Reflect.apply(regexSource, input, []) as string;
        const flags = regexFlags
          .filter(({ get }) => get && Reflect.apply(get, input, []))
          .map(({ flag }) => flag)
          .join("");
        converted(position, "RegExp", "object");
        return await visit({ source, flags }, position, depth, pure, true);
      }
      const url = nativeValue(href, input);
      if (typeof url === "string") {
        converted(position, "URL", "string");
        return text(url, position);
      }
      if (types.isNativeError(input)) {
        const keys = enumerableKeys(input, position);
        const error: Record<string, unknown> = Object.create(null);
        error.name = errorName(input, position);
        const message = own(input, "message")
          ? dataProperty(input, "message", field(position, "message"))
          : "";
        if (typeof message !== "string")
          problem(
            "invalid_result_data",
            "An Error message must be a data string.",
            field(position, "message"),
          );
        error.message = message;
        for (const key of new Set([...keys, "code", "cause"])) {
          if (["name", "message", "stack"].includes(key) || !own(input, key))
            continue;
          Object.defineProperty(error, key, {
            enumerable: true,
            value: dataProperty(input, key, field(position, key)),
          });
        }
        converted(position, "Error", "object");
        return await visit(error, position, depth, pure, true);
      }
      if (Array.isArray(input)) {
        const length = dataProperty(input, "length", position) as number;
        if (length > maximum.nodes - nodes)
          problem(
            "result_data_too_large",
            "Array length exceeds the remaining node budget.",
            position,
          );
        const keys = enumerableKeys(input, position);
        if (
          keys.some(
            (key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length,
          )
        )
          problem(
            "invalid_result_data",
            "Array properties outside its element range cannot be represented as JSON.",
            position,
          );
        const result: JsonValue[] = [];
        charge(2, position);
        for (let index = 0; index < length; index++) {
          if (index) charge(1, position);
          const itemPath = appendPath(position, `[${index}]`);
          result.push(
            await visit(
              dataProperty(input, String(index), itemPath),
              itemPath,
              depth + 1,
              pure,
            ),
          );
        }
        return result;
      }
      if (!isPlainRecord(input))
        problem(
          "invalid_result_data",
          "An unsupported class requires an explicit supported value.",
          position,
        );
      const result: JsonObject = Object.create(null);
      charge(2, position);
      let index = 0;
      for (const key of enumerableKeys(input, position)) {
        if (index++) charge(1, position);
        text(key, position);
        charge(1, position);
        const itemPath = field(position, key);
        Object.defineProperty(result, key, {
          enumerable: true,
          value: await visit(
            dataProperty(input, key, itemPath),
            itemPath,
            depth + 1,
            pure,
          ),
        });
      }
      return result;
    } finally {
      ancestors.delete(input);
    }
  }
  const data = await visit(value, rootPath, 0, options.mode === "data");
  // Only fresh JSON produced above is serialized, never the original object graph.
  if (Buffer.byteLength(JSON.stringify({ data, conversions })) > maximum.bytes)
    problem(
      "result_data_too_large",
      "The final encoded data exceeds its byte budget.",
      rootPath,
    );
  return { data, conversions };
}
