import { AsyncLocalStorage } from "node:async_hooks";
import { promiseHooks } from "node:v8";
import { setImmediate } from "node:timers/promises";
import { requireCondition } from "../contracts/errors.js";

// Observe Node's own Promise lifecycle. No Promise subclass, patched then(),
// thenable executor, or substitute cancellation protocol is introduced.
const current = new AsyncLocalStorage<NativePromiseAudit>();
const owners = new WeakMap<Promise<unknown>, NativePromiseAudit>();
const active = new Set<NativePromiseAudit>();
let stop: (() => void) | undefined;
function unhandled(reason: unknown, promise: Promise<unknown>): void {
  const owner = owners.get(promise);
  if (owner && active.has(owner)) {
    owner.rejected(promise);
    return;
  }
  // A runtime listener must not quietly swallow unrelated Agent failures.
  // Existing process listeners retain their normal responsibility when present.
  if (process.listenerCount("unhandledRejection") === 1)
    queueMicrotask(() => {
      throw reason instanceof Error
        ? reason
        : new Error("An unowned asynchronous operation failed.");
    });
}
function handled(promise: Promise<unknown>): void {
  owners.get(promise)?.handled(promise);
}
function monitor(): void {
  if (stop) return;
  const close = promiseHooks.onInit((promise, parent) => {
    const owner = current.getStore() ?? (parent && owners.get(parent));
    if (owner) owners.set(promise, owner);
  });
  stop = () => close();
  process.on("unhandledRejection", unhandled);
  process.on("rejectionHandled", handled);
}

export class NativePromiseAudit {
  #unhandled = new WeakSet<Promise<unknown>>();
  #count = 0;
  constructor() {
    active.add(this);
    monitor();
  }
  run<T>(action: () => T): T {
    requireCondition(
      active.has(this),
      "run_closed",
      "The originating asynchronous scope is closed.",
    );
    return current.run(this, action);
  }
  rejected(promise: Promise<unknown>): void {
    if (!this.#unhandled.has(promise)) {
      this.#unhandled.add(promise);
      this.#count++;
    }
  }
  handled(promise: Promise<unknown>): void {
    if (this.#unhandled.delete(promise)) this.#count--;
  }
  async checkpoint(): Promise<void> {
    // Node emits rejection/handled events across a turn. Caught SDK errors are
    // business outcomes, while an ignored or propagated rejection remains an error.
    await setImmediate();
    requireCondition(
      this.#count === 0,
      "unhandled_async_error",
      "The run has asynchronous failures that were not handled.",
      { count: this.#count },
    );
  }
  close(): void {
    active.delete(this);
    if (active.size === 0 && stop) {
      stop();
      stop = undefined;
      process.off("unhandledRejection", unhandled);
      process.off("rejectionHandled", handled);
    }
  }
}
