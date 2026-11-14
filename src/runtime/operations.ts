import { types } from "node:util";
import { AgentError } from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import type { ContributionOrigin, JsonObject } from "../contracts/types.js";
import { SqliteStore } from "../storage/sqlite.js";
import { NativePromiseAudit } from "./promises.js";

export interface OperationHooks<T> {
  complete?(value: T): T;
  failure?(cause: unknown): unknown;
  settled?(): void;
}

export class RunOperations {
  readonly audit = new NativePromiseAudit();
  #pending = new Set<Promise<void>>();
  constructor(
    readonly store: SqliteStore,
    readonly runId: string,
    readonly current: () => void,
    readonly fatal: (error: unknown) => void,
    readonly changed: () => void,
  ) {}

  start<T>(
    origin: ContributionOrigin,
    method: string,
    action: (operationId: string) => T | Promise<T>,
    hooks: OperationHooks<T> = {},
  ): T | Promise<T> {
    this.current();
    const record = this.store.startOperation(this.runId, origin, method);
    this.changed();
    let value: T | Promise<T>;
    try {
      this.current();
      value = this.audit.run(() => action(record.operationId));
    } catch (cause) {
      const error = this.#failure(cause, hooks);
      try {
        this.#finish(record.operationId, "failed", error);
      } finally {
        hooks.settled?.();
      }
      throw error;
    }
    let asynchronous: boolean;
    try {
      asynchronous =
        types.isPromise(value) ||
        (value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          typeof (value as { then?: unknown }).then === "function");
    } catch (error) {
      this.fatal(error);
      throw new AgentError(
        "operation_observation_failed",
        "The operation returned a value whose completion could not be observed.",
      );
    }
    if (!asynchronous) {
      return this.#succeed(record.operationId, value as T, hooks);
    }
    let persisted: Promise<T>;
    try {
      persisted = this.audit.run(() =>
        Promise.resolve(value).then(
          (result: T) => {
            return this.#succeed(record.operationId, result, hooks);
          },
          (cause: unknown) => {
            const error = this.#failure(cause, hooks);
            try {
              this.#finish(record.operationId, "failed", error);
            } finally {
              hooks.settled?.();
            }
            throw error;
          },
        ),
      );
    } catch (error) {
      // An inability to observe the real Promise does not prove its underlying work stopped.
      this.fatal(error);
      throw new AgentError(
        "operation_observation_failed",
        "The operation could not attach its native completion observer.",
      );
    }
    // The internal observer waits for real settlement and persistence. It does
    // not mark the separately returned public Promise as handled by the script.
    const settled = persisted.then(
      () => {},
      () => {},
    );
    this.#pending.add(settled);
    void settled.then(() => {
      this.#pending.delete(settled);
    });
    return this.audit.run(() => persisted.then((value) => value));
  }
  #failure<T>(cause: unknown, hooks: OperationHooks<T>): unknown {
    try {
      return hooks.failure ? hooks.failure(cause) : cause;
    } catch (replacement) {
      return replacement;
    }
  }
  #succeed<T>(id: string, value: T, hooks: OperationHooks<T>): T {
    let result: T;
    try {
      result = hooks.complete ? hooks.complete(value) : value;
    } catch (cause) {
      const error = this.#failure(cause, hooks);
      try {
        this.#finish(id, "failed", error);
      } finally {
        hooks.settled?.();
      }
      throw error;
    }
    try {
      this.#finish(id, "succeeded");
      return result;
    } finally {
      hooks.settled?.();
    }
  }
  #finish(id: string, status: "succeeded" | "failed", cause?: unknown): void {
    try {
      const error: JsonObject | undefined =
        status === "succeeded"
          ? undefined
          : safeErrorData(cause, {
              code: "sdk_operation_failed",
              message:
                "The SDK operation failed; its source and run are retained locally.",
            });
      this.store.finishOperation(id, status, error);
      this.changed();
    } catch (error) {
      this.fatal(error);
      throw new AgentError(
        "operation_persistence_failed",
        "The operation could not save its completion; do not retry it automatically.",
        { operationId: id },
      );
    }
  }
  async settle(): Promise<void> {
    // Handlers can register nested managed operations before they settle.
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    await this.audit.checkpoint();
  }
}
