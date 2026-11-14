import { isAgentError } from "./errors.js";
import { canonicalJson } from "./json.js";
import type { JsonObject } from "./types.js";

/** Error reporting must not invoke guest behavior or prevent real work from settling. */
export function safeErrorData(
  value: unknown,
  fallback: { readonly code: string; readonly message: string },
): JsonObject {
  if (!isAgentError(value)) return { ...fallback };
  const own = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const code = own("code");
  const message = own("message");
  const result: JsonObject = {
    code:
      typeof code === "string" && code.length > 0 && code.length <= 256
        ? code
        : fallback.code,
    message:
      typeof message === "string"
        ? message.length > 1024
          ? message.slice(0, 1012) + "…[truncated]"
          : message
        : fallback.message,
  };
  const descriptor = Object.getOwnPropertyDescriptor(value, "details");
  if (!descriptor || ("value" in descriptor && descriptor.value === undefined))
    return result;
  try {
    // Own data only. canonicalJson inspects descriptors instead of toJSON/getters,
    // rejects proxies and fixes a bounded copy without retaining mutable state.
    if (
      !("value" in descriptor) ||
      descriptor.value === null ||
      typeof descriptor.value !== "object" ||
      Array.isArray(descriptor.value)
    ) {
      result.details = { omitted: true, reason: "invalid_error_details" };
      return result;
    }
    result.details = JSON.parse(
      canonicalJson(descriptor.value, 8 * 1024),
    ) as JsonObject;
  } catch (cause) {
    const code = isAgentError(cause)
      ? Object.getOwnPropertyDescriptor(cause, "code")
      : undefined;
    result.details = {
      omitted: true,
      reason:
        code && "value" in code && code.value === "data_too_large"
          ? "error_details_too_large"
          : "invalid_error_details",
    };
  }
  return result;
}
