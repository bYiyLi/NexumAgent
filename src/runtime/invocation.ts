import type { ContributionOrigin, JsonObject, JsonValue } from "../contracts/types.js";

export interface InputRequest {
  message: string;
  inputSchema: JsonValue;
  timeoutMs?: number;
}

export interface OperationHooks<T> {
  complete?(value: T): T;
  failure?(cause: unknown): unknown;
  settled?(): void;
}

export interface RunServices {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly context: JsonObject;
  readonly controlStorage?: boolean;
  readonly deadlineAt: number;
  assertActive(): void;
  assertCurrent(): void;
  operation<T>(
    origin: ContributionOrigin,
    method: string,
    action: (operationId: string) => T | Promise<T>,
    hooks?: OperationHooks<T>,
  ): T | Promise<T>;
  requestInput(request: InputRequest): Promise<JsonObject>;
}
