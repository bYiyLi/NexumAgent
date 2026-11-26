export class BrowserActionError extends Error {
  constructor(
    code,
    message,
    { dispatched = false, effect = "none", retryable = false, reason } = {},
  ) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.dispatched = dispatched;
    this.effect = effect;
    this.retryable = retryable;
    if (typeof reason === "string") this.reason = reason;
  }
}
export function requireValue(
  value,
  code = "INVALID_ARGUMENT",
  message = "The browser input is invalid.",
  reason,
) {
  if (!value) throw new BrowserActionError(code, message, { reason });
}
export function record(value, keys) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
  );
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    requireValue(
      typeof key === "string" &&
        (!keys || keys.includes(key)) &&
        field.enumerable &&
        "value" in field,
    );
  }
  return value;
}
export function text(value, maximum = 8192) {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      new TextEncoder().encode(value).byteLength <= maximum &&
      !value.includes("\0"),
  );
  return value;
}
export function nativeId(value) {
  requireValue(
    typeof value === "string" &&
      /^(0|[1-9][0-9]*)$/.test(value) &&
      Number.isSafeInteger(Number(value)),
    "INVALID_TARGET",
    "A target needs a real native browser identity.",
  );
  return Number(value);
}
export function httpUrl(value) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw new BrowserActionError(
      "INVALID_ARGUMENT",
      "Use a valid HTTP(S) URL.",
    );
  }
  requireValue(
    url.protocol === "http:" || url.protocol === "https:",
    "INVALID_ARGUMENT",
    "Use a valid HTTP(S) URL.",
  );
  return url.href;
}
export function publicUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}
export function publicError(cause, dispatched = false) {
  if (cause instanceof BrowserActionError)
    return {
      code: cause.code,
      message: cause.message,
      dispatched: cause.dispatched || dispatched,
      effect: cause.effect === "none" && dispatched ? "unknown" : cause.effect,
      retryable: cause.retryable && cause.effect === "none" && !dispatched,
      ...(cause.reason === undefined ? {} : { reason: cause.reason }),
    };
  // Recognize only bounded, well-known Chromium diagnostics. Never expose
  // the native message itself (it may contain a URL or page content).
  const message = cause instanceof Error ? cause.message : "";
  const known = /^(?:No tab with id: \d+\.?|Invalid tab ID: \d+\.?|No such tab)$/i.test(message)
    ? ["TARGET_GONE", "The original native browser tab is closed.", "tab_closed"]
    : /^Cannot access a chrome:\/\/ URL(?:\.|$)/i.test(message)
      ? ["PERMISSION_DENIED", "The native browser page is protected or not accessible.", "protected_page"]
      : undefined;
  if (known)
    return { code: known[0], message: known[1], reason: known[2], dispatched,
      effect: dispatched ? "unknown" : "none", retryable: false };
  // Native errors can contain page contents, URLs or input; retain a bounded diagnostic category.
  return {
    code: "NATIVE_OPERATION_FAILED",
    message: "The browser rejected the native operation; the specific cause is not confirmed.",
    dispatched,
    effect: dispatched ? "unknown" : "none",
    retryable: false,
  };
}

// Private loopback diagnostic, not a public SDK message. The receiving Agent
// persists it in its local error log before producing the public projection.
export function nativeDiagnostic(cause) {
  const seen = new Set();
  let remaining = 4096;
  function visit(value, depth) {
    if (remaining-- <= 0 || depth > 64) return "[diagnostic traversal limit]";
    if (value === null || typeof value === "string" || typeof value === "boolean" ||
        typeof value === "number") return value;
    if (!value || typeof value !== "object") return "[" + typeof value + "]";
    if (seen.has(value)) return "[circular cause]";
    seen.add(value);
    try {
      const result = {};
      for (const key of ["name", "message", "code", "stack"]) {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (field && "value" in field &&
            (typeof field.value === "string" || typeof field.value === "number"))
          result[key] = field.value;
      }
      const nested = Object.getOwnPropertyDescriptor(value, "cause");
      if (nested && "value" in nested) result.cause = visit(nested.value, depth + 1);
      const aggregate = Object.getOwnPropertyDescriptor(value, "errors");
      if (aggregate && "value" in aggregate && Array.isArray(aggregate.value)) {
        result.errors = [];
        for (let i = 0; i < aggregate.value.length && remaining > 0; i++) {
          const item = Object.getOwnPropertyDescriptor(aggregate.value, String(i));
          result.errors.push(visit(item && "value" in item ? item.value : undefined, depth + 1));
        }
        if (result.errors.length < aggregate.value.length)
          result.errors.push("[diagnostic traversal limit]");
      }
      return result;
    } catch {
      return "[native error could not be inspected]";
    } finally {
      seen.delete(value);
    }
  }
  return JSON.stringify(visit(cause, 0), null, 2);
}
