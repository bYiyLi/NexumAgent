import type { ContributionOrigin, JsonObject, JsonValue } from "../contracts/types.js";

export interface InputRequest {
  message: string;
  inputSchema: JsonObject | boolean;
  timeoutMs?: number;
}

export interface InputAttachment {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  revision: string;
  resourceUri: string;
}

/** Continuation input does not replace the original context.input. */
export interface InputReply {
  input: JsonValue;
  attachments: InputAttachment[];
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
  requestInput(request: InputRequest): Promise<InputReply>;
}
