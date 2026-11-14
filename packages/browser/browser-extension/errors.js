export class BrowserActionError extends Error {
  constructor(
    code,
    message,
    { dispatched = false, effect = "none", retryable = false } = {},
  ) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.dispatched = dispatched;
    this.effect = effect;
    this.retryable = retryable;
  }
}
export function requireValue(
  value,
  code = "INVALID_ARGUMENT",
  message = "The browser input is invalid.",
) {
  if (!value) throw new BrowserActionError(code, message);
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
      retryable: cause.retryable,
    };
  // Native errors can contain page contents, URLs or input; retain a bounded diagnostic category.
  return {
    code: "PERMISSION_DENIED",
    message: "The browser rejected the native operation.",
    dispatched,
    effect: dispatched ? "unknown" : "none",
    retryable: false,
  };
}
