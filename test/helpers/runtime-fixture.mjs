import { appendFileSync, mkdirSync } from "node:fs";
import { Console } from "node:console";
import { finished } from "node:stream/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { types } from "node:util";
import { AgentError, requireCondition } from "../../dist/contracts/errors.js";
import { safeErrorData } from "../../dist/contracts/error-data.js";
import { callerKey, fixedCaller } from "../../dist/contracts/caller.js";
import { canonicalJson, newId } from "../../dist/contracts/json.js";
import { compileInputSchema } from "../../dist/contracts/validation.js";
import { HostRunner } from "../../dist/host/runner.js";
import { HostRunLog } from "../../dist/host/run-log.js";

export { callerKey };
const copy = (value) => {
  const data = value => {
    if (Array.isArray(value)) return value.map(data);
    if (value && typeof value === "object" && !types.isProxy(value) &&
        [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
      return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).flatMap(([key, field]) => {
        requireCondition("value" in field, "invalid_json", "Fixture facts cannot execute getters.");
        return field.value === undefined ? [] : [[key, data(field.value)]];
      }));
    }
    return value;
  };
  return value === undefined ? undefined : JSON.parse(canonicalJson(data(value), 8 * 1024 * 1024));
};
const assert = (condition, code) => requireCondition(condition, code, `Fixture rejected ${code}.`);
const errorData = cause => safeErrorData(cause, { code: "sdk_operation_failed", message: "The fixture operation failed." });

/** A test peer's facts, not a database, migration layer or production authority. */
export class FixtureStore {
  bootId = newId("boot");
  works = new Map();
  runs = new Map();
  resources = new Map();
  operations = new Map();
  cursors = new Map();
  projects = new Set();
  closeReceipts = new Map();
  state = new Map();
  constructor(root, binding) {
    this.root = root;
    this.binding = Object.freeze({ ...binding });
    mkdirSync(path.join(root, "state"), { recursive: true });
  }
  close() {}
  openWork(input, now = Date.now()) {
    assert(!this.projects.has(input.projectId), "project_closed");
    const row = { ...copy(input), contextId: newId("ctx"), projectId: input.projectId ?? null,
      bootId: this.bootId, revision: 1, status: "open", createdAt: now,
      lastUsedAt: now, expiresAt: now + 86400000, closedAt: null };
    this.works.set(row.contextId, row);
    return copy(row);
  }
  getWork(id) { assert(this.works.has(id), "context_not_found"); return copy(this.works.get(id)); }
  activeWork(id, caller, now = Date.now()) {
    const row = this.getWork(id);
    assert(row.callerKey === caller && row.bootId === this.bootId, "context_binding_mismatch");
    assert(row.status === "open" && row.expiresAt > now, "context_closed");
    return row;
  }
  refreshWork(id, caller, revision, snapshotRef, now = Date.now()) {
    const row = this.activeWork(id, caller, now);
    assert(row.revision === revision, "context_revision_mismatch");
    const next = { ...row, snapshotRef, revision: revision + 1, lastUsedAt: now };
    this.works.set(id, next);
    return copy(next);
  }
  closeWork(id, caller, now = Date.now()) {
    const row = this.getWork(id);
    assert(row.callerKey === caller, "context_binding_mismatch");
    if (this.closeReceipts.has(id)) return copy(this.closeReceipts.get(id));
    const affected = row.projectId ? this.closeProject(row.projectId, now).affectedContextIds : [id];
    if (!row.projectId) this.works.set(id, { ...row, status: "closed", closedAt: now, revision: row.revision + 1 });
    const receipt = { contextId: id, projectId: row.projectId, agentConfirmed: true, affectedContextIds: affected, closedAt: now };
    this.closeReceipts.set(id, receipt);
    return copy(receipt);
  }
  closeProject(projectId, now = Date.now()) {
    this.projects.add(projectId);
    const affectedContextIds = [];
    for (const row of this.works.values()) if (row.projectId === projectId && row.status === "open") {
      affectedContextIds.push(row.contextId);
      this.works.set(row.contextId, { ...row, status: "closed", closedAt: now, revision: row.revision + 1 });
    }
    return { projectId, agentConfirmed: true, affectedContextIds, closedAt: now };
  }
  workSnapshotRefs(now = Date.now()) {
    return new Set([...this.works.values()].filter(row => row.status === "open" && row.expiresAt > now).map(row => row.snapshotRef));
  }
  scriptUsage() { return []; }
  acceptRun(input, now = Date.now()) {
    const work = this.getWork(input.contextId);
    const runId = newId("run");
    const row = { ...copy(input), runId, projectId: work.projectId, logsRef: `logs/runs/${runId}/console.log`,
      bootId: this.bootId, status: "accepted", revision: 1, error: null, stop: null,
      cleanup: {}, acceptedAt: now, startedAt: null, endedAt: null,
      deadlineAt: now + (input.timeoutMs ?? 60000), updatedAt: now };
    this.runs.set(row.runId, row);
    return { run: copy(row) };
  }
  getRun(id) { assert(this.runs.has(id), "run_not_found"); return copy(this.runs.get(id)); }
  transitionRun(id, revision, status, fields = {}, now = Date.now()) {
    const row = this.getRun(id);
    assert(row.revision === revision, "run_revision_mismatch");
    const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
    const next = { ...row, ...copy(fields), status, revision: revision + 1, updatedAt: now,
      startedAt: row.startedAt ?? (status === "running" ? now : null), endedAt: terminal ? now : null };
    this.runs.set(id, next);
    return copy(next);
  }
  requestStop(id, stop) {
    const row = this.getRun(id);
    this.runs.set(id, { ...row, stop: copy(stop), status: "cancelling" });
    return this.getRun(id);
  }
  listRuns() { return { runs: [...this.runs.values()].map(copy) }; }
  operationsForRun(id) { return [...this.operations.values()].filter(row => row.originRunId === id).map(copy); }
  registerResource(input, now = Date.now()) {
    const row = { ...copy(input), resourceId: newId("res"), bootId: this.bootId,
      originRunId: input.runId ?? null, ownerRunId: input.runId ?? null,
      lifetime: input.runId ? "run" : "instance", status: input.status ?? "registered", revision: 1, diagnostic: {},
      createdAt: now, handedOffAt: null, closedAt: null };
    this.resources.set(row.resourceId, row);
    return copy(row);
  }
  getResource(id) { assert(this.resources.has(id), "resource_not_found"); return copy(this.resources.get(id)); }
  resourceHistory(id) {
    const row = this.getResource(id);
    return { ...row, contextId: row.originRunId ? this.getRun(row.originRunId).contextId : null };
  }
  resourcesForRun(id, limit = 10000) {
    return [...this.resources.values()].filter(row => row.ownerRunId === id || row.originRunId === id).slice(0, limit).map(copy);
  }
  resourceDiagnostic(id, status, diagnostic) {
    const row = this.getResource(id);
    this.resources.set(id, { ...row, status, diagnostic: copy(diagnostic), revision: row.revision + 1 });
    return this.getResource(id);
  }
  closeResource(id, revision, diagnostic = {}, now = Date.now()) {
    const row = this.getResource(id);
    assert(row.revision === revision, "resource_revision_mismatch");
    this.resources.set(id, { ...row, status: "closed", diagnostic: copy(diagnostic), closedAt: now, revision: revision + 1 });
    return this.getResource(id);
  }
  handoff(id, runId, revision, now = Date.now()) {
    const row = this.getResource(id);
    assert(row.ownerRunId === runId && row.revision === revision && row.closedAt === null, "resource_owner_mismatch");
    this.resources.set(id, { ...row, ownerRunId: null, lifetime: "background", handedOffAt: now, revision: revision + 1 });
    return this.getResource(id);
  }
  scanResourceHistory(filter, caller, limit = 20, cursor) {
    const key = canonicalJson({ filter, caller });
    const position = cursor === undefined ? undefined : this.cursors.get(cursor);
    assert(cursor === undefined || position?.key === key, "invalid_cursor");
    const rows = [...this.resources.values()].map(row => this.resourceHistory(row.resourceId))
      .filter(row => row.callerKey === caller && row.source.owner === filter.owner && row.source.namespace === filter.namespace && row.source.type === filter.type)
      .filter(row => (!filter.kind || row.kind === filter.kind) && (!filter.status || row.status === filter.status) &&
        (!filter.state || row.diagnostic.details?.state === filter.state) && (!filter.runId || row.originRunId === filter.runId) &&
        (!filter.contextId || row.contextId === filter.contextId))
      .sort((a, b) => b.createdAt - a.createdAt || b.resourceId.localeCompare(a.resourceId));
    const start = position ? rows.findIndex(row => row.resourceId === position.id) + 1 : 0;
    const items = rows.slice(start, start + limit).map(record => {
      const next = Buffer.from(newId("cursor")).toString("base64url");
      this.cursors.set(next, { key, id: record.resourceId });
      return { record, cursor: next };
    });
    return { items, more: start + items.length < rows.length };
  }
  getState(key) { const row = this.state.get(key); return row?.deleted ? null : copy(row ?? null); }
  setState(key, value, expectedVersion) {
    const old = this.state.get(key);
    assert((this.getState(key)?.version ?? null) === expectedVersion, "state_version_conflict");
    const row = { value: copy(value), version: (old?.version ?? 0) + 1, updatedAt: Date.now() };
    this.state.set(key, row);
    return copy(row);
  }
  deleteState(key, expectedVersion) {
    const old = this.getState(key);
    assert(old?.version === expectedVersion, "state_version_conflict");
    const receipt = { deleted: true, version: old.version + 1, updatedAt: Date.now() };
    this.state.set(key, { ...old, ...receipt });
    return receipt;
  }
}

/** Runs the real HostRunner/Worker/Registry against a small in-memory Go peer. */
export class ExecutionFixture {
  active = new Map();
  constructor(store, loader, scripts, options) {
    Object.assign(this, { store, loader, scripts, options });
    this.runner = new HostRunner(loader);
  }
  activeSnapshotRefs() {
    return new Set([...this.active.entries()].filter(([id]) => this.store.getRun(id).endedAt === null).map(([, state]) => state.snapshotRef));
  }
  js(caller, input) { return this.start(caller, input); }
  async start(caller, input) {
    caller = fixedCaller(caller);
    this.options.authorize(caller, { action: "start", work: this.store.getWork(input.contextId) });
    const work = this.store.activeWork(input.contextId, callerKey(caller));
    let snapshot, preparationError;
    try { snapshot = input.scriptName ? this.scripts.resolve(input.scriptName) : this.scripts.enroll(input.script).snapshot; }
    catch (cause) { preparationError = cause; }
    const release = snapshot ? this.options.leaseScript?.(snapshot.origin) ?? (() => {}) : () => {};
    const run = this.store.acceptRun({ callerKey: callerKey(caller), contextId: work.contextId, sourceKind: input.scriptName ? "script" : "inline",
      source: { ...snapshot?.origin, workRevision: work.revision, workSnapshotRef: work.snapshotRef }, scriptName: snapshot?.name ?? input.scriptName ?? null, timeoutMs: input.timeoutMs }).run;
    const state = { controller: new AbortController(), accepting: true, pending: new Set(), result: null, wait: null, snapshotRef: work.snapshotRef };
    this.active.set(run.runId, state);
    const current = () => {
      state.controller.signal.throwIfAborted();
      assert(this.store.getRun(run.runId).endedAt === null, "run_closed");
      this.options.authorize(caller, { action: "invoke", run: this.store.getRun(run.runId) });
    };
    const services = {
      runId: run.runId, signal: state.controller.signal, deadlineAt: run.deadlineAt,
      assertCurrent: current,
      assertActive() { current(); assert(state.accepting, "invocation_closed"); },
      operation: (origin, method, action, hooks = {}) => {
        current();
        const record = { operationId: newId("op"), originRunId: run.runId, namespace: origin.namespace, method, status: "running", source: copy(origin) };
        this.store.operations.set(record.operationId, record);
        const settle = (value, failed = false) => {
          try {
            if (failed) throw hooks.failure ? hooks.failure(value) : value;
            const result = hooks.complete ? hooks.complete(value) : value;
            record.status = "succeeded";
            return result;
          } catch (cause) {
            record.status = "failed";
            record.error = errorData(cause);
            throw cause;
          } finally { hooks.settled?.(); }
        };
        let value;
        try { value = action(record.operationId); } catch (cause) { return settle(cause, true); }
        if (!types.isPromise(value) && !(value && typeof value.then === "function")) return settle(value);
        const pending = Promise.resolve(value).then(value => settle(value), cause => settle(cause, true));
        state.pending.add(pending);
        void pending.then(() => state.pending.delete(pending), () => state.pending.delete(pending));
        return pending;
      },
      requestInput: async (request) => {
        current();
        assert(!state.wait, "input_already_pending");
        const reply = Promise.withResolvers();
        state.wait = { waitId: newId("wait"), request: copy(request), ...reply };
        const row = this.store.getRun(run.runId);
        this.store.transitionRun(run.runId, row.revision, "waiting_input");
        const abort = () => reply.reject(state.controller.signal.reason);
        state.controller.signal.addEventListener("abort", abort, { once: true });
        try { return await reply.promise; }
        finally { state.controller.signal.removeEventListener("abort", abort); state.wait = null; }
      },
    };
    const settleOperations = async () => { while (state.pending.size) await Promise.allSettled([...state.pending]); };
    state.done = (async () => {
      let failure;
      const directory = path.join(this.store.root, "logs", "runs", run.runId);
      mkdirSync(directory, { recursive: true });
      const log = new HostRunLog(async text => appendFileSync(path.join(directory, "console.log"), text));
      const logger = new Console({ stdout: log, stderr: log, ignoreErrors: false });
      try {
        if (preparationError) throw preparationError;
        if (snapshot.metadata) compileInputSchema(snapshot.metadata.scriptInputSchema)(input.input ?? {});
        const view = await this.options.loadWork(work);
        current();
        services.context = { contextId: work.contextId, agentId: this.store.binding.agentId, runId: run.runId,
          pwd: input.pwd ?? view.pwd ?? work.pwd, project: view.project ?? null, caller, input: input.input ?? {}, attachments: [],
          agent: view.agentShared ?? {}, user: view.userShared ?? {}, paths: { work: this.loader.work, resources: path.join(this.loader.work, "resources") },
          script: { name: snapshot.name, origin: snapshot.origin, code: snapshot.code, source: input.scriptName ? "named" : "inline" } };
        if (this.options.prepareAttachments) services.context.attachments = await this.options.prepareAttachments(input.attachments ?? [], "", services);
        current();
        const row = this.store.getRun(run.runId);
        this.store.transitionRun(run.runId, row.revision, "running");
        const value = await this.runner.start({ runId: run.runId, code: snapshot.code, context: services.context,
          bindings: this.options.bindings(services), signal: services.signal, settleOperations, console: logger,
          onRootReturned: () => { state.accepting = false; }, onAbort: () => { state.accepting = false; },
          onDiagnostic: this.options.onWorkerDiagnostic });
        state.result = structuredClone(await this.options.encodeResult(value, services));
      } catch (cause) { failure = cause; }
      finally {
        state.accepting = false;
        state.controller.abort(new AgentError("invocation_closed", "The fixture Run is closing."));
        await settleOperations();
        await this.options.resources?.cleanupRun(run.runId);
        await this.options.resources?.waitForRunClosure(run.runId);
        log.end();
        await finished(log);
        if (log.failure) failure ??= log.failure;
        release();
      }
      const row = this.store.getRun(run.runId);
      const cancelled = row.stop !== null;
      this.store.transitionRun(run.runId, row.revision, cancelled ? "cancelled" : failure ? "failed" : "succeeded", {
        error: cancelled ? { code: "run_cancelled" } : failure ? errorData(failure) : null,
      });
      if (failure || cancelled) state.result = null;
    })();
    return this.observe(caller, run.runId, input.waitMs ?? 3000);
  }
  async observe(caller, id, waitMs = 3000) {
    const state = this.active.get(id);
    this.options.authorize(caller, { action: "observe", run: this.store.getRun(id) });
    const deadline = performance.now() + waitMs;
    while (this.store.getRun(id).endedAt === null && !state.wait && performance.now() < deadline) await delay(5);
    return { run: this.store.getRun(id), result: state.result, wait: state.wait ? { waitId: state.wait.waitId, request: state.wait.request } : null,
      operations: { items: this.store.operationsForRun(id) }, resources: { items: this.store.resourcesForRun(id) } };
  }
  cancel(caller, id) {
    this.options.authorize(caller, { action: "cancel", run: this.store.getRun(id) });
    this.store.requestStop(id, { kind: "cancel" });
    this.active.get(id).controller.abort(new AgentError("run_cancelled", "The fixture Run was cancelled."));
    return { accepted: true, run: this.store.getRun(id) };
  }
  async input(caller, input) {
    const state = this.active.get(input.runId);
    assert(state.wait?.waitId === input.waitId, "input_wait_mismatch");
    const row = this.store.getRun(input.runId);
    this.store.transitionRun(row.runId, row.revision, "running");
    const waiting = state.wait;
    state.wait = null;
    waiting.resolve({ input: copy(input.input), attachments: [] });
    return this.observe(caller, input.runId, input.waitMs ?? 3000);
  }
}

export class ReservationFixture {
  reservedBytes = 0;
  constructor(maximum = Number.MAX_SAFE_INTEGER) { this.maximum = maximum; }
  async reserve(bytes) {
    assert(this.reservedBytes + bytes <= this.maximum, "storage_quota_exceeded");
    this.reservedBytes += bytes;
    let active = true;
    return { release: () => { if (active) this.reservedBytes -= bytes; active = false; } };
  }

  async stop() { assert(this.reservedBytes === 0, "fixture_reservation_leaked"); }
}

/** Supplies the public StateService contract without a Node storage backend. */
export class StateFixture {
  constructor(store, user) { Object.assign(this, { store, user }); }
  bind(scope) {
    const namespace = kind => Object.fromEntries(["get", "set", "delete"].map(action => [action, async (key, value, options) => {
      const current = () => {
        scope.assertCurrent();
        scope.authorize({ type: `${kind}-state`, value: key, access: action === "get" ? "read" : "write" });
      };
      current();
      let result;
      if (kind === "agent") {
        result = action === "get" ? this.store.getState(key) : action === "set"
          ? this.store.setState(key, value, options.expectedVersion)
          : this.store.deleteState(key, value.expectedVersion);
      } else {
        assert(this.user, "user_state_unavailable");
        const identity = { principalId: scope.context.caller.principalId, clientId: scope.context.caller.clientId,
          agentId: this.store.binding.agentId, cloudEnvironment: this.store.binding.cloudEnvironment };
        result = await this.user[action](identity, key, ...(action === "set" ? [value, options] : action === "delete" ? [value] : []), scope.signal);
      }
      current();
      return copy(result);
    }]));
    return { agent: namespace("agent"), user: namespace("user") };
  }
}
