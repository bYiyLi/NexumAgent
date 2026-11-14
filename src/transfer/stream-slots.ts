import { requireCondition } from "../contracts/errors.js";

export interface StreamPermit {
  /** Idempotent; call only after preparation/stream and required closure finish. */
  release(): void;
}

/** One shared, non-queuing admission counter for input preparation and transfer I/O. */
export class TransferStreamSlots {
  #active = 0;
  readonly capacity: number;
  constructor(capacity = 4) {
    requireCondition(
      Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 4,
      "invalid_transfer_options",
      "The Agent can configure at most four actual file streams.",
    );
    this.capacity = capacity;
  }
  get active(): number {
    return this.#active;
  }
  tryAcquire(): StreamPermit | null {
    if (this.#active >= this.capacity) return null;
    this.#active++;
    let released = false;
    return Object.freeze({
      release: () => {
        if (!released) {
          released = true;
          this.#active--;
        }
      },
    });
  }
}
