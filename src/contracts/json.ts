import { createHash, randomBytes } from "node:crypto";
import { AgentError, requireCondition } from "./errors.js";
import type { JsonValue } from "./types.js";

// These budgets bound control data, not media; media stays on the byte data plane.
export function canonicalJson(value: unknown, maxBytes = 1024 * 1024): string {
  let nodes = 0;
  let rawBytes = 0;
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): JsonValue {
    requireCondition(
      ++nodes <= 100_000 && depth <= 64,
      "data_too_large",
      "JSON exceeds its depth or node budget.",
    );
    if (typeof input === "string") {
      rawBytes += Buffer.byteLength(input);
      requireCondition(
        rawBytes <= maxBytes,
        "data_too_large",
        "JSON exceeds its byte budget.",
      );
      return input;
    }
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    requireCondition(
      typeof input === "object" && input !== null,
      "invalid_json",
      "Only JSON values are accepted.",
    );
    requireCondition(
      !ancestors.has(input),
      "invalid_json",
      "Circular JSON values are not accepted.",
    );
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        requireCondition(
          input.length <= 100_000 - nodes,
          "data_too_large",
          "JSON exceeds its node budget.",
        );
        return Array.from({ length: input.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            input,
            String(index),
          );
          requireCondition(
            descriptor && "value" in descriptor,
            "invalid_json",
            "Sparse arrays and accessors are not accepted.",
          );
          return visit(descriptor.value, depth + 1);
        });
      }
      const prototype = Object.getPrototypeOf(input);
      requireCondition(
        prototype === Object.prototype || prototype === null,
        "invalid_json",
        "A JSON object must have a plain prototype.",
      );
      const result: { [key: string]: JsonValue } = Object.create(null);
      const keys = Object.keys(input);
      requireCondition(
        keys.length <= 100_000 - nodes,
        "data_too_large",
        "JSON exceeds its node budget.",
      );
      for (const key of keys.sort()) {
        rawBytes += Buffer.byteLength(key);
        requireCondition(
          rawBytes <= maxBytes,
          "data_too_large",
          "JSON exceeds its byte budget.",
        );
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        requireCondition(
          descriptor && "value" in descriptor,
          "invalid_json",
          "JSON accessors are not accepted.",
        );
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(input);
    }
  }
  const encoded = JSON.stringify(visit(value, 0));
  requireCondition(
    Buffer.byteLength(encoded) <= maxBytes,
    "data_too_large",
    "JSON exceeds its byte budget.",
  );
  return encoded;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function newRequestId(now = Date.now()): string {
  return `req_${now}_${randomBytes(16).toString("hex")}`;
}

export function requestWindow(
  requestId: string,
  now = Date.now(),
): { issuedAt: number; expiresAt: number } {
  const match = /^req_(\d{13})_([0-9a-f]{32})$/.exec(requestId);
  requireCondition(
    match,
    "invalid_request_id",
    "The submission identifier has an invalid format.",
  );
  const issuedAt = Number(match[1]);
  requireCondition(
    issuedAt <= now + 300_000,
    "invalid_request_id",
    "The submission time is too far in the future.",
  );
  const expiresAt = issuedAt + 86_400_000;
  if (now >= expiresAt)
    throw new AgentError(
      "submission_expired",
      "The submission window has expired; query the original run instead.",
    );
  return { issuedAt, expiresAt };
}
