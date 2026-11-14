import { randomUUID } from "node:crypto";
import { validateTarget } from "../client/serialize.js";
import type {
  Invocation,
  ManagedResource,
  ResourceRef,
} from "@nexum/extension-api";
import {
  BrowserService,
  type BrowserPeer,
  type LeaseEvidence,
} from "./service.js";
import { check, failure, identifier, record, type Target } from "./protocol.js";

interface Reservation {
  target: Target;
  exclusive: boolean;
}
interface Lease {
  id: string;
  peer: BrowserPeer;
  initial: Target;
  targets: Map<string, Reservation>;
  started: boolean;
  closed: boolean;
  ready?: Promise<void>;
}
const key = (target: Target) =>
  JSON.stringify([
    target.bootId,
    target.browserId,
    target.browserSessionId,
    target.generation,
    target.tabId ?? "*",
  ]);
const browserKey = (target: Target) =>
  JSON.stringify([
    target.bootId,
    target.browserId,
    target.browserSessionId,
    target.generation,
  ]);
const stableKey = (target: Target) =>
  JSON.stringify([
    target.browserId,
    target.browserSessionId,
    target.tabId ?? "*",
  ]);
/** One actual Core run resource; no settled Invocation is retained. */
export class RunScope implements ManagedResource {
  readonly closed: Promise<void>;
  readonly signal: AbortSignal;
  #done = Promise.withResolvers<void>();
  #stop = new AbortController();
  #ref?: ResourceRef<RunScope>;
  #completed = false;
  #unconfirmedControls = false;
  #leases = new Map<string, Lease>();
  #sealed = new Set<string>();
  #stopping = false;
  #disposing?: Promise<void>;
  #queues = new Map<string, Promise<void>>();
  #wideBorrows = new Map<string, number>();
  constructor(
    readonly runtime: BrowserRuntime,
    readonly runId: string,
  ) {
    this.closed = this.#done.promise;
    this.signal = this.#stop.signal;
    void this.closed.catch(() => {});
  }
  bind(ref: ResourceRef<RunScope>): void {
    check(
      !this.#ref && ref.value === this,
      "INVALID_TARGET",
      "The browser run scope has already been registered.",
    );
    this.#ref = ref;
    const abort = () => {
      void this.dispose(ref.signal.reason).catch(() => {});
    };
    ref.signal.addEventListener("abort", abort, { once: true });
    void this.closed.then(() => ref.signal.removeEventListener("abort", abort));
    if (ref.signal.aborted) abort();
  }
  current(target?: Target): void {
    check(
      !this.#stopping && !this.signal.aborted,
      "USER_TAKEOVER",
      "This browser run no longer accepts control.",
    );
    if (target)
      check(
        !this.#sealed.has(stableKey(target)),
        "USER_TAKEOVER",
        "This run has handed the target back to the user.",
      );
  }
  async reserve(
    targets: readonly Target[],
    call: Invocation,
    exclusive = true,
    signal: AbortSignal = call.signal,
  ): Promise<Lease> {
    this.current();
    const unique = [
      ...new Map(targets.map((target) => [key(target), target])).entries(),
    ].sort(([a], [b]) => a.localeCompare(b));
    check(
      unique.length > 0,
      "INVALID_TARGET",
      "Browser control requires a current target.",
    );
    for (const [targetKey, target] of unique) {
      this.current(target);
      this.runtime.service.target(target);
      if (exclusive) this.runtime.assertFree(targetKey, this.runId);
    }
    const selected = new Set<Lease>();
    // No await between checking the complete known target set and retaining its locks.
    for (const [targetKey, target] of unique) {
      const connection = browserKey(target);
      let lease = this.#leases.get(connection);
      if (lease?.closed) {
        this.#leases.delete(connection);
        lease = undefined;
      }
      if (!lease) {
        lease = {
          id: randomUUID(),
          peer: this.runtime.service.target(target),
          initial: { ...target },
          targets: new Map(),
          started: false,
          closed: false,
        };
        this.#leases.set(connection, lease);
      }
      const previous = lease.targets.get(targetKey);
      if (exclusive && !target.tabId)
        this.#wideBorrows.set(
          targetKey,
          (this.#wideBorrows.get(targetKey) ?? 0) + 1,
        );
      if (exclusive && !previous?.exclusive)
        this.runtime.lock(targetKey, this.runId);
      lease.targets.set(targetKey, {
        target: { ...target },
        exclusive: exclusive || !!previous?.exclusive,
      });
      selected.add(lease);
    }
    for (const lease of selected) {
      this.current();
      if (!lease.ready) {
        lease.started = true;
        lease.ready = this.runtime.service.openLease(lease.peer, {
          id: lease.id,
          runId: this.runId,
          operationId: call.operationId,
          target: lease.initial,
          signal: AbortSignal.any([this.signal, signal]),
          onClosed: (evidence) => this.#closedLease(lease, evidence),
        });
        void lease.ready.catch(() => {});
      }
      await lease.ready;
      this.current();
      signal.throwIfAborted();
    }
    this.#ref?.report({
      state: "controlling",
      browserCount: this.#leases.size,
      targetCount: [...this.#leases.values()].reduce(
        (n, lease) => n + lease.targets.size,
        0,
      ),
    });
    return [...selected][0]!;
  }
  #closedLease(lease: Lease, evidence?: LeaseEvidence): void {
    lease.closed = true;
    this.#unconfirmedControls ||= evidence?.unconfirmedControls === true;
    for (const targetKey of lease.targets.keys()) {
      this.runtime.unlock(targetKey, this.runId);
      this.#wideBorrows.delete(targetKey);
    }
    this.#maybeClosed();
  }
  #maybeClosed(): void {
    if (
      !this.#completed &&
      this.#stopping &&
      !this.#queues.size &&
      [...this.#leases.values()].every((lease) => lease.closed)
    ) {
      this.#completed = true;
      try {
        this.#ref?.report({
          state: "closed",
          ...(this.#unconfirmedControls ? { unconfirmedControls: true } : {}),
        });
      } catch {
        /* Core owns persistence failures; a failed fact report cannot reopen closed native controls. */
      }
      this.#done.resolve();
      this.runtime.finished(this);
    }
  }
  owns(target?: Target, leaseId?: string): boolean {
    return [...this.#leases.values()].some(
      (lease) =>
        !lease.closed &&
        ((leaseId && lease.id === leaseId) ||
          (target &&
            [...lease.targets.values()].some(
              (value) => stableKey(value.target) === stableKey(target),
            ))),
    );
  }
  retainCreated(target: Target): void {
    this.current(target);
    this.runtime.service.target({ ...target, tabId: undefined });
    const lease = this.#leases.get(browserKey(target));
    check(
      lease && !lease.closed,
      "INVALID_TARGET",
      "The creating browser lease ended before its tab could be retained.",
    );
    this.runtime.lock(key(target), this.runId);
    lease.targets.set(key(target), { target: { ...target }, exclusive: true });
  }
  releaseWide(targets: readonly Target[]): void {
    for (const target of targets) {
      if (target.tabId) continue;
      const id = key(target),
        count = this.#wideBorrows.get(id);
      if (!count) continue;
      if (count > 1) {
        this.#wideBorrows.set(id, count - 1);
        continue;
      }
      this.#wideBorrows.delete(id);
      this.runtime.unlock(id, this.runId);
      const retained = this.#leases.get(browserKey(target))?.targets.get(id);
      if (retained) retained.exclusive = false;
    }
  }
  closedTarget(target: Target): void {
    this.#leases.get(browserKey(target))?.targets.delete(key(target));
    this.runtime.unlock(key(target), this.runId);
  }
  released(target: Target): void {
    this.#sealed.add(stableKey(target));
    const lease = this.#leases.get(browserKey(target));
    if (lease) {
      lease.targets.delete(key(target));
      this.runtime.unlock(key(target), this.runId);
    }
  }
  async resume(target: Target, call: Invocation): Promise<void> {
    this.current();
    check(
      this.#sealed.has(stableKey(target)),
      "USER_TAKEOVER",
      "Only an explicitly handed-off target can request fresh control.",
    );
    const lease = this.#leases.get(browserKey(target));
    check(
      lease && lease.started && !lease.closed,
      "INVALID_TARGET",
      "The original browser lease is no longer available.",
    );
    const peer = this.runtime.service.target(target);
    call.authorize({
      type: "connection",
      value: target.browserId,
      access: "control",
    });
    this.runtime.lock(key(target), this.runId);
    // Keep a reservation after an ambiguous native reply. Actual lease closure
    // remains the only proof that unconfirmed native control has ended.
    lease.targets.set(key(target), { target: { ...target }, exclusive: true });
    const budget = Math.min(30000, call.deadline - Date.now());
    check(budget > 0, "TIMEOUT", "No continuation deadline remains.");
    const value = await this.runtime.service.action(peer, {
      method: "tab.resumeUserControl",
      args: { target },
      target,
      runId: this.runId,
      operationId: call.operationId,
      leaseId: lease.id,
      budgetMs: budget,
      signal: AbortSignal.any([call.signal, this.signal]),
    });
    check(
      record(value) && value.resumed === true && record(value.target),
      "UNKNOWN_RESULT",
      "The browser did not confirm fresh target control.",
    );
    const next = validateTarget(value.target, true);
    check(
      identifier(next.controlEpoch) &&
        next.controlEpoch !== target.controlEpoch &&
        stableKey(next) === stableKey(target),
      "PROTOCOL_MISMATCH",
      "The resumed target did not receive a fresh control identity.",
    );
    this.current();
    call.signal.throwIfAborted();
    this.runtime.service.target(next);
    call.authorize({
      type: "connection",
      value: target.browserId,
      access: "control",
    });
    lease.targets.set(key(next), { target: { ...next }, exclusive: true });
    this.#sealed.delete(stableKey(target));
    this.#ref?.report({
      state: "controlling",
      resumed: true,
      targetCount: [...this.#leases.values()].reduce(
        (n, item) => n + item.targets.size,
        0,
      ),
    });
  }
  async command<T>(
    target: Target,
    execute: () => Promise<T>,
    queued = true,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!queued) return execute();
    const targetKey = key(target),
      before = this.#queues.get(targetKey) ?? Promise.resolve();
    const task = before
      .catch(() => {})
      .then(() => {
        this.current(target);
        signal?.throwIfAborted();
        return execute();
      });
    const settled = task.then(
      () => {},
      () => {},
    );
    this.#queues.set(targetKey, settled);
    void settled
      .finally(() => {
        if (this.#queues.get(targetKey) === settled)
          this.#queues.delete(targetKey);
        this.#maybeClosed();
      })
      .catch(() => {});
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      void task.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (cause) => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
      if (signal.aborted) abort();
    });
  }
  revoke(target?: Target): void {
    if (target) this.#sealed.add(stableKey(target));
    void this.dispose(
      failure("USER_TAKEOVER", "The browser user stopped this run's control."),
    ).catch(() => {});
  }
  dispose(reason?: unknown): Promise<void> {
    this.#stopping = true;
    if (!this.signal.aborted)
      this.#stop.abort(
        reason ?? failure("USER_TAKEOVER", "The browser run is closing."),
      );
    if (this.#disposing) return this.#disposing;
    const task = (async () => {
      for (const lease of this.#leases.values()) {
        if (!lease.started) this.#closedLease(lease);
        else if (!lease.closed) await this.runtime.service.endLease(lease.id);
      }
      this.#maybeClosed();
    })();
    this.#disposing = task;
    void task
      .finally(() => {
        if (this.#disposing === task) this.#disposing = undefined;
      })
      .catch(() => {});
    return task;
  }
}
export class BrowserRuntime {
  #scopes = new Map<string, Promise<RunScope>>();
  #locks = new Map<string, string>();
  #waiters = new Map<
    string,
    { runId: string; target: Target; expiresAt: number; settled: boolean }
  >();
  constructor(readonly service: BrowserService) {
    service.on(
      "browser-event",
      (
        _peer: BrowserPeer,
        event: { event?: string; target?: Target; leaseId?: string },
      ) => {
        if (event.event === "user_takeover")
          for (const promise of this.#scopes.values())
            void promise
              .then((scope) => {
                if (scope.owns(event.target, event.leaseId))
                  scope.revoke(event.target);
              })
              .catch(() => {});
      },
    );
  }
  assertFree(targetKey: string, runId: string): void {
    const parts = JSON.parse(targetKey) as (string | number)[],
      prefix = JSON.stringify(parts.slice(0, -1));
    for (const [held, owner] of this.#locks) {
      const heldParts = JSON.parse(held) as (string | number)[];
      if (
        owner !== runId &&
        JSON.stringify(heldParts.slice(0, -1)) === prefix &&
        (held === targetKey || heldParts.at(-1) === "*" || parts.at(-1) === "*")
      )
        throw failure(
          "TAB_ALREADY_CLAIMED",
          "Another run already controls the requested target.",
        );
    }
  }
  lock(targetKey: string, runId: string): void {
    this.assertFree(targetKey, runId);
    this.#locks.set(targetKey, runId);
  }
  unlock(targetKey: string, runId: string): void {
    if (this.#locks.get(targetKey) === runId) this.#locks.delete(targetKey);
  }
  finished(scope: RunScope): void {
    for (const [id, waiter] of this.#waiters)
      if (waiter.runId === scope.runId) this.#waiters.delete(id);
    const promise = this.#scopes.get(scope.runId);
    if (promise)
      void promise
        .then((value) => {
          if (value === scope && this.#scopes.get(scope.runId) === promise)
            this.#scopes.delete(scope.runId);
        })
        .catch(() => {});
  }
  async scope(call: Invocation): Promise<RunScope> {
    const runId = call.context.runId;
    check(
      identifier(runId),
      "INVALID_TARGET",
      "Browser control needs the actual Core run identity.",
    );
    let promise = this.#scopes.get(runId);
    if (!promise) {
      const scope = new RunScope(this, runId);
      promise = (async () => {
        const ref = await call.resources.register({
          kind: "browser.run",
          value: scope,
        });
        scope.bind(ref);
        call.signal.throwIfAborted();
        return scope;
      })();
      this.#scopes.set(runId, promise);
      const current = promise;
      void promise.catch(() => {
        if (this.#scopes.get(runId) === current) this.#scopes.delete(runId);
      });
    }
    return promise;
  }
  async resume(target: Target, call: Invocation): Promise<void> {
    await (await this.scope(call)).resume(target, call);
  }
  waiter(id: unknown, call: Invocation): { target: Target; expiresAt: number } {
    check(
      identifier(id),
      "WAITER_GONE",
      "The browser waiter has no valid identity.",
    );
    const waiter = this.#waiters.get(id);
    check(
      waiter && waiter.runId === call.context.runId,
      "WAITER_GONE",
      "The browser waiter does not belong to this actual run.",
    );
    return waiter;
  }
  #rememberWaiter(value: unknown, target: Target, call: Invocation): void {
    check(
      value &&
        typeof value === "object" &&
        identifier((value as { id?: unknown }).id) &&
        typeof (value as { expiresAt?: unknown }).expiresAt === "number",
      "PROTOCOL_MISMATCH",
      "Browser arm did not return a fixed ready waiter identity.",
    );
    const item = value as { id: string; expiresAt: number };
    check(
      Number.isFinite(item.expiresAt) &&
        item.expiresAt > Date.now() &&
        !this.#waiters.has(item.id),
      "PROTOCOL_MISMATCH",
      "The browser waiter identity is duplicate or expired.",
    );
    const runId = call.context.runId;
    check(
      identifier(runId),
      "INVALID_TARGET",
      "The waiter must belong to the actual run.",
    );
    check(
      this.#waiters.size < 8192,
      "QUEUE_FULL",
      "The Agent browser waiter receipt budget is full.",
    );
    this.#waiters.set(item.id, {
      runId,
      target: { ...target },
      expiresAt: item.expiresAt,
      settled: false,
    });
  }
  async action(
    method: string,
    args: Record<string, unknown>,
    target: Target,
    call: Invocation,
    mutating = true,
  ): Promise<unknown> {
    const started = performance.now(),
      options = args.options as { timeoutMs?: unknown } | undefined;
    const requested =
      typeof options?.timeoutMs === "number"
        ? options.timeoutMs
        : typeof args.timeoutMs === "number"
          ? method === "playwright.waitForTimeout"
            ? Math.max(30000, args.timeoutMs + 1000)
            : args.timeoutMs
          : args.condition &&
              typeof args.condition === "object" &&
              typeof (args.condition as { timeoutMs?: unknown }).timeoutMs ===
                "number"
            ? Number((args.condition as { timeoutMs: number }).timeoutMs)
            : /download|export|bundle|setFiles/i.test(method)
              ? 120000
              : 30000;
    const budget = Math.min(requested, call.deadline - Date.now(), 2147483647);
    check(
      Number.isFinite(budget) && budget > 0,
      "TIMEOUT",
      "The browser method has no remaining deadline.",
    );
    let dispatched = false,
      confirmed = false;
    let reservedScope: RunScope | undefined,
      reservedTargets: Target[] | undefined;
    const deadline = new AbortController(),
      timer = setTimeout(
        () =>
          deadline.abort(
            failure("TIMEOUT", "The browser method exceeded its deadline.", {
              dispatched,
              effect: dispatched ? "unknown" : "none",
              operationId: call.operationId,
            }),
          ),
        Math.min(Math.max(1, Math.ceil(budget)), 2147483647),
      );
    const signal = AbortSignal.any([call.signal, deadline.signal]);
    try {
      signal.throwIfAborted();
      call.authorize({
        type: "connection",
        value: target.browserId,
        access: mutating ? "control" : "read",
      });
      const peer = this.service.target(target),
        scope = await this.scope(call);
      let targets = [target];
      if (mutating && !target.tabId) {
        const input = (args.options ?? args) as Record<string, unknown>,
          ids = Array.isArray(input.tabIds)
            ? input.tabIds
            : Array.isArray(args.ids)
              ? args.ids
              : typeof args.id === "string" &&
                  method.startsWith("management.tabs.")
                ? [args.id]
                : [];
        if (ids.length)
          targets = ids.map((id) => ({ ...target, tabId: String(id) }));
      }
      if (method === "waiters.arm")
        check(
          [...this.#waiters.values()].filter(
            (waiter) =>
              waiter.runId === scope.runId &&
              !waiter.settled &&
              key(waiter.target) === key(target) &&
              waiter.expiresAt > Date.now(),
          ).length < 32,
          "QUEUE_FULL",
          "This run and target already have the maximum number of browser waiters.",
        );
      const lease = await scope.reserve(
        targets,
        call,
        !!target.tabId || mutating,
        signal,
      );
      reservedScope = scope;
      reservedTargets = !!target.tabId || mutating ? targets : undefined;
      const queued =
        !/^(waiters\.get|tabs\.closeTemporary|tab\.(?:markHandoff|getJsDialog|dialogAccept|dialogDismiss)|dialogs\.(?:accept|dismiss)|downloads\.path|tab\.saveDownload|playwright\.waitFor|(?:tab|frame|locator)\.waitFor|cdp\.(events|readEvents))/.test(
          method,
        );
      const value = await scope.command(
        target,
        async () => {
          const remaining = budget - (performance.now() - started);
          check(
            remaining > 0,
            "TIMEOUT",
            "The browser method has no remaining deadline.",
          );
          signal.throwIfAborted();
          call.authorize({
            type: "connection",
            value: target.browserId,
            access: mutating ? "control" : "read",
          });
          call.log({
            level: "debug",
            message: "Browser action dispatched.",
            data: {
              method,
              browserId: target.browserId,
              operationId: call.operationId,
            },
          });
          return this.service.action(peer, {
            method,
            args,
            target,
            runId: scope.runId,
            operationId: call.operationId,
            leaseId: lease.id,
            budgetMs: Math.min(remaining, 2147483647),
            signal: AbortSignal.any([scope.signal, signal]),
            onDispatched: () => {
              dispatched = true;
            },
          });
        },
        queued,
        signal,
      );
      confirmed = true;
      if (method === "tab.close" || method === "tabs.closeTemporary")
        scope.closedTarget(target);
      if (
        (method === "tabs.new" || method === "tabs.createTemporary") &&
        record(value) &&
        record(value.target)
      ) {
        const created = validateTarget(value.target, true);
        check(
          value.id === created.tabId &&
            browserKey(created) === browserKey(target),
          "PROTOCOL_MISMATCH",
          "A created tab belongs to another browser identity.",
        );
        scope.retainCreated(created);
      }
      signal.throwIfAborted();
      if (performance.now() - started > budget)
        throw failure(
          "TIMEOUT",
          "The browser result arrived after its method deadline.",
          {
            dispatched: true,
            effect: "unknown",
            operationId: call.operationId,
          },
        );
      if (method === "waiters.arm") this.#rememberWaiter(value, target, call);
      if (method === "waiters.get" || method === "waiters.cancel") {
        const waiter = this.#waiters.get(String(args.id));
        if (waiter && waiter.runId === scope.runId) waiter.settled = true;
      }
      if (method === "tab.markHandoff") {
        check(
          value &&
            typeof value === "object" &&
            (value as { released?: unknown }).released === true,
          "UNKNOWN_RESULT",
          "The browser did not confirm target control release.",
        );
        scope.released(target);
        return undefined;
      }
      return value;
    } catch (cause) {
      if (
        !dispatched ||
        (cause instanceof Error &&
          Object.getOwnPropertyDescriptor(cause, "effect")?.value === "none")
      )
        confirmed = true;
      if (deadline.signal.aborted && !call.signal.aborted)
        throw deadline.signal.reason;
      throw cause;
    } finally {
      if (confirmed && reservedScope && reservedTargets)
        reservedScope.releaseWide(reservedTargets);
      clearTimeout(timer);
    }
  }
  async dispose(): Promise<void> {
    for (const scope of this.#scopes.values()) await (await scope).dispose();
  }
}
