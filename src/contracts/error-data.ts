import { types } from "node:util";
import { isAgentError } from "./errors.js";
import { canonicalJson } from "./json.js";
import type { JsonObject, JsonValue } from "./types.js";

// Same public identifier contract as Go ErrorV2 projection. Preserve original
// spelling and case; this does not classify arbitrary native exception text.
export const isPublicErrorCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,255}$/.test(value);

export function boundErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f]|Traceback/.test(value))
    return fallback;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= 1024) return value;
  const suffix = "…[truncated]";
  let end = 1024 - Buffer.byteLength(suffix);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0,end).toString("utf8")+suffix;
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value,key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Independently validate dispatch facts. Missing evidence stays missing. */
export function failureFacts(value: unknown): JsonObject {
  const result: JsonObject = {};
  for (const key of ["dispatched","retryable","admitted"]) {
    const fact = own(value,key);
    if (typeof fact === "boolean") result[key] = fact;
  }
  const effect = own(value,"effect"), outcome = own(value,"outcome");
  if (effect === "none" || effect === "unknown" || effect === "confirmed") result.effect = effect;
  if (outcome === "unknown") result.outcome = outcome;
  if (result.dispatched === false && (result.effect === "unknown" || result.effect === "confirmed")) {
    delete result.dispatched;
    result.effect = "unknown";
  }
  if (result.dispatched === true || result.effect === "unknown" || result.effect === "confirmed" || result.outcome === "unknown" || result.admitted === true)
    result.retryable = false;
  return result;
}

const privateKey = /^(?:stack|stacktrace|traceback|trace|exception|cause|password|passwd|secret|token|accesstoken|refreshtoken|idtoken|apikey|privatekey|clientsecret|credential|credentials|authorization|cookie|cookies|setcookie|headers|requestheaders|responseheaders|actual|rawerror|rawresponse|requestbody|responsebody)$/i;
function clean(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(clean);
  if (value !== null && typeof value === "object") {
    const out: JsonObject = Object.create(null);
    for (const [key,item] of Object.entries(value))
      if (!privateKey.test(key.replace(/[_-]/g,""))) out[key] = clean(item);
    return out;
  }
  return value;
}

function recoveryFacts(value: unknown): JsonObject {
  const result = failureFacts(value);
  for (const key of ["phase","reason","component","namespace","method","operation","operationId","runId","agentId","contextId","projectId","requestId","waitId","transferId","processId","recovery","field","exceptionType"]) {
    const fact = own(value,key);
    if (typeof fact === "string" && Buffer.byteLength(fact) <= 256 && /^[\p{L}\p{N}_.:\-[\]]+$/u.test(fact)) result[key] = fact;
  }
  for (const key of ["status","exitCode","signal"]) {
    const fact = own(value,key);
    if (typeof fact === "number" && Number.isSafeInteger(fact) || isPublicErrorCode(fact)) result[key] = fact as string|number;
  }
  return result;
}

/** Only for data already classified by its owning adapter. Copy without
 * accessing getters/proxies; preserve independent recovery facts if optional
 * details are invalid or too large. */
export function boundErrorDetails(value: unknown, facts?: unknown): JsonObject | undefined {
  const extra = failureFacts(facts);
  if (value === undefined && Object.keys(extra).length === 0) return undefined;
  let details: JsonObject;
  try {
    if (value !== undefined && (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)))
      throw new Error("invalid detail");
    details = value === undefined ? {} : clean(JSON.parse(canonicalJson(value, 8 * 1024))) as JsonObject;
  } catch (cause) {
    details = {...recoveryFacts(value), omitted:true};
    const reason = isAgentError(cause) && own(cause,"code") === "data_too_large" ? "error_details_too_large" : "invalid_error_details";
    if (details.reason === undefined) details.reason = reason;
    else details.detailsReason = reason;
  }
  // Facts from two boundaries can disagree. Do not erase evidence of
  // dispatch, admission, a confirmed effect, or uncertainty on a rewrap.
  const original = failureFacts(details);
  Object.assign(details,extra);
  if (original.dispatched === true || extra.dispatched === true) details.dispatched = true;
  if (original.admitted === true || extra.admitted === true) details.admitted = true;
  if (original.outcome === "unknown" || extra.outcome === "unknown") details.outcome = "unknown";
  if (original.effect === "unknown" || extra.effect === "unknown") details.effect = "unknown";
  else if (original.effect === "confirmed" || extra.effect === "confirmed") details.effect = "confirmed";
  if (original.retryable === false || extra.retryable === false) details.retryable = false;
  const normalized = failureFacts(details);
  for (const key of ["dispatched","effect","retryable","admitted","outcome"]) delete details[key];
  Object.assign(details,normalized);
  try { return JSON.parse(canonicalJson(details,8*1024)) as JsonObject; }
  catch { return {...recoveryFacts(details),omitted:true,detailsReason:"error_details_too_large"}; }
}

/** Error reporting must not invoke guest behavior or prevent real work from settling. */
export function safeErrorData(
  value: unknown,
  fallback: { readonly code: string; readonly message: string },
): JsonObject {
  if (!isAgentError(value)) return { ...fallback };
  const code = own(value,"code");
  const result: JsonObject = {
    code: isPublicErrorCode(code) ? code : fallback.code,
    message: boundErrorMessage(own(value,"message"),fallback.message),
  };
  const descriptor = Object.getOwnPropertyDescriptor(value,"details");
  const details = boundErrorDetails(descriptor && !("value" in descriptor)
    ? null : own(value,"details"), value);
  if (details !== undefined) result.details = details;
  return result;
}
