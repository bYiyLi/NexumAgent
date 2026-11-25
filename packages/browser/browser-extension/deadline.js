import { BrowserActionError, requireValue } from "./errors.js";

const maxTimer = 2147483647;

// All execution budgets are durations on the local monotonic clock. A nested
// operation may narrow its parent's deadline but never restart that budget.
export const remainingBudget = (ctx, at = performance.now()) =>
  Math.max(0, ctx.started + ctx.budgetMs - at);

export function requireBudget(ctx, message = "The browser action exceeded its deadline.") {
  ctx.signal?.throwIfAborted();
  const remaining = remainingBudget(ctx);
  requireValue(Number.isFinite(remaining) && remaining > 0, "TIMEOUT", message);
  return remaining;
}

export function narrowerBudget(ctx, timeoutMs = ctx.budgetMs) {
  requireValue(Number.isFinite(timeoutMs) && timeoutMs > 0);
  ctx.signal?.throwIfAborted();
  const started = performance.now();
  const budgetMs = Math.min(timeoutMs, remainingBudget(ctx, started));
  requireValue(budgetMs > 0, "TIMEOUT", "The browser action exceeded its deadline.");
  return {...ctx, started, budgetMs};
}

// Timers may fire early (fractional milliseconds) or be throttled in MV3.
// Both timer callbacks and explicit wakeups use the same deadline. A heartbeat
// can never shorten a wait. No zero/negative/overflow timer is ever scheduled.
export function deadlineTimer(expiresAt, expire, initialMs) {
  requireValue(Number.isFinite(expiresAt));
  let timer, closed = false;
  const clear = () => {
    closed = true;
    clearTimeout(timer);
  };
  const wake = () => {
    if (closed || performance.now() < expiresAt) return;
    clear();
    expire();
  };
  const schedule = (delay) => {
    if (closed) return;
    if (delay <= 0) {
      queueMicrotask(tick);
      return;
    }
    timer = setTimeout(tick, Math.min(maxTimer, Math.ceil(delay)));
  };
  function tick() {
    wake();
    if (!closed) schedule(expiresAt - performance.now());
  }
  schedule(initialMs ?? expiresAt - performance.now());
  return {clear,wake};
}

export function timeoutError(message = "The browser condition was not observed before its deadline.") {
  return new BrowserActionError("TIMEOUT",message);
}
