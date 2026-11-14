import { types } from "node:util";
import type {
  BrowserError,
  BrowserTarget,
  LocatorData,
  LocatorDescription,
  TextMatcherData,
} from "./types.js";

export function clientError(code: string, message: string): BrowserError {
  return Object.assign(new Error(message), {
    name: "BrowserError",
    code,
    dispatched: false,
    effect: "none" as const,
    retryable: false,
  });
}
export function requireArgument(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw clientError("INVALID_ARGUMENT", message);
}
const nativeObject = Function.prototype.toString.call(Object);
export function plain(value: unknown): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return true;
  if (types.isProxy(proto) || Object.getPrototypeOf(proto) !== null)
    return false;
  const c = Object.getOwnPropertyDescriptor(proto, "constructor");
  return (
    !!c &&
    "value" in c &&
    typeof c.value === "function" &&
    Function.prototype.toString.call(c.value) === nativeObject
  );
}
export function dataObject(
  value: unknown,
  fields?: readonly string[],
): Record<string, unknown> {
  requireArgument(plain(value), "Use an ordinary data object.");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    requireArgument(
      typeof key === "string" &&
        d.enumerable &&
        "value" in d &&
        (!fields || fields.includes(key)),
      "Arguments cannot contain unknown fields, accessors, symbols or hidden fields.",
    );
    if (d.value !== undefined) result[key as string] = d.value;
  }
  return result;
}
export function options(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : dataObject(value, fields);
}
export function defined(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}
export function freeze<T>(value: T): T {
  if (
    value &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value) &&
    !types.isAnyArrayBuffer(value)
  ) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const get = (prototype: object, key: PropertyKey) =>
  Object.getOwnPropertyDescriptor(prototype, key)!.get!;
const typedBuffer = get(typed, "buffer"),
  typedOffset = get(typed, "byteOffset"),
  typedLength = get(typed, "byteLength");
const arrayBufferLength = get(ArrayBuffer.prototype, "byteLength");
const sharedBufferLength = get(SharedArrayBuffer.prototype, "byteLength");
const viewBuffer = get(DataView.prototype, "buffer"),
  viewOffset = get(DataView.prototype, "byteOffset"),
  viewLength = get(DataView.prototype, "byteLength");
const regexpSource = get(RegExp.prototype, "source");
const flags = [
  "hasIndices",
  "global",
  "ignoreCase",
  "multiline",
  "dotAll",
  "unicode",
  "unicodeSets",
  "sticky",
].map((key, i) => [get(RegExp.prototype, key), "dgimsuvy"[i]] as const);
/** Descriptor-safe public argument snapshot. Native bytes stay bytes, never base64 or numeric key lists. */
export function normalizeBrowserValue(value: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0,
    textBytes = 0,
    binaryBytes = 0;
  function copy(input: unknown, depth: number): unknown {
    requireArgument(
      ++nodes <= 100000 && depth <= 64,
      "The argument graph exceeds its structural budget.",
    );
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      textBytes += Buffer.byteLength(input);
      requireArgument(
        textBytes <= 1024 * 1024,
        "Text arguments exceed the control-data budget.",
      );
      return input;
    }
    if (typeof input === "number") {
      requireArgument(
        Number.isFinite(input),
        "Coordinates and numeric arguments must be finite.",
      );
      return input;
    }
    requireArgument(
      !!input && typeof input === "object" && !types.isProxy(input),
      "Only public data, native bytes and explicitly supported file values may cross a managed call.",
    );
    if (types.isArrayBufferView(input) || types.isAnyArrayBuffer(input)) {
      try {
        let buffer: ArrayBufferLike,
          offset = 0,
          length: number;
        if (types.isAnyArrayBuffer(input)) {
          buffer = input;
          length = types.isSharedArrayBuffer(input)
            ? sharedBufferLength.call(input)
            : arrayBufferLength.call(input);
        } else if (types.isDataView(input)) {
          buffer = viewBuffer.call(input);
          offset = viewOffset.call(input);
          length = viewLength.call(input);
        } else {
          buffer = typedBuffer.call(input);
          offset = typedOffset.call(input);
          length = typedLength.call(input);
        }
        binaryBytes += length;
        requireArgument(
          binaryBytes <= 128 * 1024 * 1024,
          "Native byte arguments exceed the local protocol budget.",
        );
        return new Uint8Array(new Uint8Array(buffer, offset, length));
      } catch (cause) {
        if ((cause as { code?: string })?.code === "INVALID_ARGUMENT")
          throw cause;
        throw clientError(
          "INVALID_ARGUMENT",
          "The native byte range is detached or unavailable.",
        );
      }
    }
    // Opaque browser file Blobs are read by the authorized managed input pipeline.
    // No source properties/getters are touched here; prototype shape is not an authority proof.
    if (Function.prototype[Symbol.hasInstance].call(Blob, input)) return input;
    if (types.isDate(input)) {
      try {
        return Date.prototype.toISOString.call(input);
      } catch {
        throw clientError("INVALID_ARGUMENT", "The supplied date is invalid.");
      }
    }
    requireArgument(!ancestors.has(input), "Arguments cannot contain cycles.");
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        requireArgument(
          input.length <= 100000,
          "The argument collection is too large.",
        );
        const result = [];
        for (let i = 0; i < input.length; i++) {
          const d = Object.getOwnPropertyDescriptor(input, String(i));
          requireArgument(
            d && "value" in d,
            "Arrays cannot contain holes or accessor elements.",
          );
          result.push(copy(d.value, depth + 1));
        }
        const own = Reflect.ownKeys(input);
        requireArgument(
          own.length === input.length + 1,
          "Arrays cannot hide additional argument properties.",
        );
        return result;
      }
      const data = dataObject(input),
        result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(data))
        Object.defineProperty(result, key, {
          value: copy(item, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return result;
    } finally {
      ancestors.delete(input);
    }
  }
  return copy(value, 0);
}
export function textMatcher(value: unknown, exact?: boolean): TextMatcherData {
  if (typeof value === "string")
    return defined({
      kind: "text",
      value,
      exact,
    }) as unknown as TextMatcherData;
  requireArgument(
    types.isRegExp(value),
    "A text matcher must be a string or native RegExp.",
  );
  const source = regexpSource.call(value) as string;
  const encodedFlags = flags
    .filter(([getter]) => getter.call(value))
    .map(([, flag]) => flag)
    .join("");
  requireArgument(
    Buffer.byteLength(source) <= 1024,
    "A regular expression source exceeds 1024 UTF-8 bytes.",
  );
  try {
    new RegExp(source, encodedFlags);
  } catch {
    throw clientError("INVALID_ARGUMENT", "The regular expression is invalid.");
  }
  return { kind: "regexp", source, flags: encodedFlags };
}
export function validateTarget(value: unknown, tab = false): BrowserTarget {
  const data = dataObject(value, [
    "browserId",
    "bootId",
    "browserSessionId",
    "generation",
    "tabId",
    "controlEpoch",
    "pageVersion",
  ]);
  for (const key of [
    "browserId",
    "bootId",
    "browserSessionId",
    ...(tab ? ["tabId"] : []),
  ])
    requireArgument(
      typeof data[key] === "string" &&
        Buffer.byteLength(data[key] as string) > 0 &&
        Buffer.byteLength(data[key] as string) <= 256 &&
        !/[\0\r\n]/.test(data[key] as string),
      "The browser target has an invalid identity.",
    );
  if (data.tabId !== undefined)
    requireArgument(
      typeof data.tabId === "string" &&
        Buffer.byteLength(data.tabId) > 0 &&
        Buffer.byteLength(data.tabId) <= 256,
      "The tab identity is invalid.",
    );
  requireArgument(
    Number.isSafeInteger(data.generation) && (data.generation as number) >= 1,
    "The connection generation is invalid.",
  );
  if (data.pageVersion !== undefined)
    requireArgument(
      Number.isSafeInteger(data.pageVersion) &&
        (data.pageVersion as number) >= 0,
      "The document revision is invalid.",
    );
  if (data.controlEpoch !== undefined)
    requireArgument(
      typeof data.controlEpoch === "string" &&
        Buffer.byteLength(data.controlEpoch) > 0 &&
        Buffer.byteLength(data.controlEpoch) <= 256 &&
        !/[\0\r\n]/.test(data.controlEpoch),
      "The native control identity is invalid.",
    );
  return freeze(normalizeBrowserValue(data)) as BrowserTarget;
}
export function queryTarget(value: BrowserTarget, tab = false): BrowserTarget {
  const fixed = validateTarget(value, tab);
  const { pageVersion: _, ...target } = fixed;
  return freeze(target);
}
export function targetKey(value: BrowserTarget): string {
  return JSON.stringify([
    value.bootId,
    value.browserId,
    value.browserSessionId,
    value.generation,
    value.tabId ?? null,
    value.controlEpoch ?? null,
  ]);
}
function validateMatcher(value: unknown): void {
  const m = dataObject(value, ["kind", "value", "exact", "source", "flags"]);
  if (m.kind === "text") {
    requireArgument(
      Object.keys(m).every((key) => ["kind", "value", "exact"].includes(key)),
      "A text matcher contains unknown fields.",
    );
    requireArgument(
      typeof m.value === "string" &&
        (m.exact === undefined || typeof m.exact === "boolean"),
      "A text matcher is invalid.",
    );
    return;
  }
  requireArgument(
    Object.keys(m).every((key) => ["kind", "source", "flags"].includes(key)),
    "A regular-expression matcher contains unknown fields.",
  );
  requireArgument(
    m.kind === "regexp" &&
      typeof m.source === "string" &&
      typeof m.flags === "string" &&
      Buffer.byteLength(m.source) <= 1024,
    "A regular-expression matcher is invalid.",
  );
  try {
    new RegExp(m.source, m.flags);
  } catch {
    throw clientError(
      "INVALID_ARGUMENT",
      "The regular expression source or flags are invalid.",
    );
  }
}
/** Validate the entire bounded AST, including fixed references and nested relative queries. */
export function validateLocatorDescription(value: unknown): LocatorDescription {
  const description = dataObject(value, ["target", "framePath", "query"]);
  const target = validateTarget(description.target, true);
  requireArgument(
    Array.isArray(description.framePath) &&
      description.framePath.length <= 8 &&
      description.framePath.every(
        (value) => typeof value === "string" && value.length > 0,
      ),
    "A locator may contain at most eight nonempty frame selectors.",
  );
  let nodes = 0;
  const active = new Set<object>();
  function visit(value: unknown, depth: number): void {
    requireArgument(
      ++nodes <= 128 && depth <= 16,
      "The locator AST exceeds its node or depth budget.",
    );
    const data = dataObject(value);
    requireArgument(
      !active.has(value as object),
      "The locator AST contains a cycle.",
    );
    active.add(value as object);
    try {
      const only = (fields: string[]) =>
        requireArgument(
          Object.keys(data).every((key) => ["kind", ...fields].includes(key)),
          "The locator AST contains an unknown field.",
        );
      switch (data.kind) {
        case "selector":
          only(["selector"]);
          requireArgument(
            typeof data.selector === "string" && data.selector.length > 0,
            "A selector must be nonempty.",
          );
          break;
        case "role":
          only(["role", "name", "exact"]);
          requireArgument(
            typeof data.role === "string" && data.role.length > 0,
            "A role must be nonempty.",
          );
          if (data.name !== undefined) validateMatcher(data.name);
          if (data.exact !== undefined)
            requireArgument(
              typeof data.exact === "boolean",
              "exact must be boolean.",
            );
          break;
        case "text":
        case "label":
        case "placeholder":
          only(["matcher"]);
          validateMatcher(data.matcher);
          break;
        case "testId":
          only(["value"]);
          requireArgument(
            typeof data.value === "string",
            "A test id must be a string.",
          );
          break;
        case "descendant":
          only(["root", "query"]);
          visit(data.root, depth + 1);
          visit(data.query, depth + 1);
          break;
        case "and":
        case "or":
          only(["left", "right"]);
          visit(data.left, depth + 1);
          visit(data.right, depth + 1);
          break;
        case "position":
          only(["query", "at"]);
          requireArgument(
            data.at === "first" ||
              data.at === "last" ||
              (Number.isSafeInteger(data.at) && (data.at as number) >= 0),
            "A locator index must be nonnegative.",
          );
          visit(data.query, depth + 1);
          break;
        case "filter":
          only(["query", "has", "hasNot", "hasText", "hasNotText", "visible"]);
          visit(data.query, depth + 1);
          for (const name of ["has", "hasNot"])
            if (data[name] !== undefined) visit(data[name], depth + 1);
          for (const name of ["hasText", "hasNotText"])
            if (data[name] !== undefined) validateMatcher(data[name]);
          if (data.visible !== undefined)
            requireArgument(
              typeof data.visible === "boolean",
              "visible must be boolean.",
            );
          break;
        case "ref":
          only(["ref", "pageVersion"]);
          requireArgument(
            typeof data.ref === "string" &&
              data.ref.length > 0 &&
              Number.isSafeInteger(data.pageVersion) &&
              (data.pageVersion as number) >= 0,
            "A fixed locator requires its exact observed ref and page revision.",
          );
          break;
        default:
          throw clientError("INVALID_ARGUMENT", "The locator kind is unknown.");
      }
    } finally {
      active.delete(value as object);
    }
  }
  visit(description.query, 0);
  const fixed = {
    target,
    framePath: description.framePath,
    query: description.query as LocatorData,
  };
  return freeze(normalizeBrowserValue(fixed)) as LocatorDescription;
}
