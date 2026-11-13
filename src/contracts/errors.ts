import type { JsonObject } from "./types.js";

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonObject,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentError";
  }

  toJSON(): JsonObject {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function requireCondition(
  value: unknown,
  code: string,
  message: string,
  details?: JsonObject,
): asserts value {
  if (!value) throw new AgentError(code, message, details);
}
