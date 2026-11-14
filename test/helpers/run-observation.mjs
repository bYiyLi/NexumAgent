import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// waitMs bounds one observation; it is not the admitted run's completion or
// input-registration deadline. Keep observing the same run using a real clock,
// including in tests that deliberately move Date.now to expire a stored wait.
export async function observeRunUntil(
  engine,
  caller,
  view,
  predicate,
  {
    timeoutMs = 60000,
    label = "The original run did not reach its expected state",
  } = {},
) {
  const runId = view.run.runId,
    deadline = performance.now() + timeoutMs;
  while (!predicate(view)) {
    const diagnostic = () =>
      JSON.stringify({
        run: view.run,
        wait: view.wait,
        operations: view.operations,
      });
    assert.equal(
      view.run.runId,
      runId,
      "An observation cannot replace the original admitted run.",
    );
    assert.equal(
      view.run.endedAt,
      null,
      `${label}: original run ended first; ${diagnostic()}`,
    );
    const remaining = deadline - performance.now();
    assert.ok(
      remaining > 0,
      `${label}: observation deadline reached; ${diagnostic()}`,
    );
    view = await engine.observe(
      caller,
      runId,
      Math.min(1000, Math.ceil(remaining)),
    );
    // An exposed input wait may make observe return immediately. Yield native
    // I/O/timers as well as microtasks so its expiry and cleanup can progress.
    await delay(0);
  }
  assert.equal(view.run.runId, runId);
  return view;
}

export const observeRunTerminal = (engine, caller, view, options) =>
  observeRunUntil(
    engine,
    caller,
    view,
    (value) => value.run.endedAt !== null,
    options,
  );
