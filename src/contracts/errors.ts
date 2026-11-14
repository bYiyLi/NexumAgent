import type { JsonObject } from "./types.js";

const agentErrors = new WeakSet<object>();

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonObject,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentError";
    agentErrors.add(this);
  }

  toJSON(): JsonObject {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** A private construction brand, independent of guest prototypes and Proxy hooks. */
export function isAgentError(value: unknown): value is AgentError {
  return typeof value === "object" && value !== null && agentErrors.has(value);
}

export function requireCondition(
  value: unknown,
  code: string,
  message: string,
  details?: JsonObject,
): asserts value {
  if (!value) throw new AgentError(code, message, details);
}
