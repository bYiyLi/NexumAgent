import { MessageChannel, Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { AgentError, isAgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { Binding, JsonObject } from "../contracts/types.js";
import type { ScriptSource } from "../runtime/scripts.js";
import type { PublishedMaterials } from "../work/service.js";
import { platformNamespaces } from "../sdk/platform.js";
import { serveSyncRPC } from "./sync-rpc.js";
import { maxFrameBytes } from "./peer.js";
import type { ExtensionApproval } from "./extension-runtime.js";

type Call = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;

export interface ExtensionActivation {
  readonly preparationId: string;
  readonly packageName: string;
  readonly permissions: readonly string[];
  readonly approval: ExtensionApproval;
}

export interface ExtensionInvocation {
  readonly sourceInstanceId: string;
  readonly runId: string;
  readonly methodId: string;
  readonly operationId: string;
  readonly deadlineAt: number;
  readonly context: JsonObject;
  readonly arguments: readonly unknown[];
  readonly binaryInputs?: readonly JsonObject[];
}

interface ActiveExtension {
  readonly worker: Worker;
  readonly stopPort: () => void;
  readonly scope: JsonObject;
  readonly info: JsonObject;
  readonly methods: readonly JsonObject[];
  readonly published: PublishedMaterials;
  readonly scriptSources: readonly ScriptSource[];
  readonly platform: boolean;
  isPublished: boolean;
}

/** Owns one isolated Registry Worker per approved npm extension. */
export class ExtensionWorkers {
  readonly #entries = new Map<string, ActiveExtension>();
  readonly #pending = new Map<string, { controller: AbortController; done: Promise<void> }>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #invocations = new Set<string>();
  readonly #runStops = new Map<string, { status: "running" | "stopped" | "failed"; task: Promise<void> }>();
  #packageTransaction?: { id: string; workers: Worker[]; ready: Promise<void> };
  #closed = false;

  constructor(readonly root: string, readonly binding: Binding, readonly bootId: string,
    readonly instanceId: string, readonly call: Call) {}

  platformsReady(): boolean {
    return !this.#closed && platformNamespaces.every((name) => {
      const entry = this.#entries.get(`platform:${name}`);
      return entry?.isPublished === true && entry.worker.threadId !== -1;
    });
  }

  async activate(input: ExtensionActivation, signal: AbortSignal): Promise<JsonObject> {
    return await this.#activate(input, signal, false);
  }

  async activatePlatform(input: { namespace?: string; preparationId: string; permissions: readonly string[] }, signal: AbortSignal): Promise<JsonObject> {
    return await this.#activate({ ...input, packageName: `platform:${input.namespace ?? "sh"}` }, signal, true);
  }

  async #activate(input: Omit<ExtensionActivation, "approval"> & { approval?: ExtensionApproval }, signal: AbortSignal, platform: boolean): Promise<JsonObject> {
    requireCondition(!this.#closed && !this.#packageTransaction && typeof input.packageName === "string" &&
      (platform ? platformNamespaces.some((name) => input.packageName === `platform:${name}`) : /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(input.packageName)) &&
      typeof input.preparationId === "string" && /^preparation_[0-9a-f]{32}$/.test(input.preparationId) &&
      Array.isArray(input.permissions) && input.permissions.length <= 256 &&
      input.permissions.every((permission) => typeof permission === "string" && permission.length <= 256) &&
      !this.#entries.has(input.packageName) && !this.#pending.has(input.packageName),
    "invalid_extension_activation", "The approved extension activation is invalid or already active.");
    signal.throwIfAborted();
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    this.#pending.set(input.packageName, { controller, done: completion.promise });
    const activationSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30_000)]);
    const channel = new MessageChannel();
    const stopPort = serveSyncRPC(channel.port1, (method, params, requestSignal) =>
      this.call(method, params, requestSignal));
    const stop = () => { stopPort(); channel.port1.close(); };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./extension-worker.js", import.meta.url), {
        workerData: { root: this.root, binding: this.binding, bootId: this.bootId, instanceId: this.instanceId,
          packageName: input.packageName, preparationId: input.preparationId, permissions: input.permissions,
          approval: input.approval,
          port: channel.port2 }, transferList: [channel.port2],
      });
    } catch (cause) {
      stop();
      channel.port2.close();
      this.#pending.delete(input.packageName);
      completion.resolve();
      throw cause;
    }
    let entry: ActiveExtension | undefined;
    try {
      // Cancellation closes admission but does not prove that an initializing
      // extension has released resources. Observe initialization first so the
      // actual instance can be withdrawn and stopped when it becomes known.
      const value = await this.#message(worker, AbortSignal.timeout(30_000), (message) =>
        isPlainRecord(message) && (message.type === "ready" || message.type === "failed"));
      if (isPlainRecord(value) && value.type === "failed") {
        const codes: JsonObject = {};
        for (const field of ["code", "causeCode"] as const) {
          const code = value[field];
          if (typeof code === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,95}$/.test(code)) codes[field] = code;
        }
        throw new AgentError("extension_initialization_failed", "The extension could not initialize.", codes);
      }
      requireCondition(isPlainRecord(value) && value.type === "ready" && isPlainRecord(value.info) &&
        isPlainRecord(value.scope) && value.scope.instanceId === this.instanceId &&
        typeof value.scope.sourceInstanceId === "string" && Array.isArray(value.methods) &&
        value.methods.every(isPlainRecord) && isPlainRecord(value.published) &&
        Array.isArray(value.published.instructions) && Array.isArray(value.published.skills) &&
        Array.isArray(value.scriptSources),
      "extension_initialization_failed", "The extension did not publish its actual contributions.");
      entry = { worker, stopPort: stop, scope: value.scope as JsonObject, info: value.info as JsonObject,
        methods: value.methods as JsonObject[], published: value.published as unknown as PublishedMaterials,
        scriptSources: value.scriptSources as unknown as ScriptSource[], platform, isPublished: false };
      worker.on("exit", () => {
        if (!entry?.isPublished) return;
        entry.isPublished = false;
        entry.stopPort();
        void this.call(platform ? "platform.withdraw" : "extension.withdraw", { instanceId: this.instanceId,
          sourceInstanceId: entry.scope.sourceInstanceId }, AbortSignal.timeout(30_000)).catch(() => {});
      });
      // Retain the instance before publishing so a failed acknowledgement can
      // still be cleaned up explicitly without creating a second instance.
      this.#entries.set(input.packageName, entry);
      activationSignal.throwIfAborted();
      await this.call(platform ? "platform.publish" : "extension.publish", { instanceId: this.instanceId,
        preparationId: input.preparationId, ...value }, activationSignal);
      if (platform) await this.#platformSettlement(worker, "platform.confirm");
      activationSignal.throwIfAborted();
      requireCondition(worker.threadId !== -1, "extension_worker_exited", "The extension Worker exited before publication.");
      entry.isPublished = true;
      return entry.info;
    } catch (cause) {
      if (entry) {
        try { await this.#closeEntry(input.packageName, entry); }
        catch { /* The retained instance remains available for an explicit cleanup retry. */ }
      } else {
        stop();
        await worker.terminate();
        if (cause instanceof Error && cause.name === "TimeoutError")
          throw new AgentError("extension_cleanup_unconfirmed", "Extension initialization timed out before cleanup could be confirmed.", undefined, { cause });
      }
      throw cause;
    } finally {
      this.#pending.delete(input.packageName);
      completion.resolve();
    }
  }

  published(): PublishedMaterials {
    const values = [...this.#entries.values()].filter((entry) => entry.isPublished);
    return { instructions: values.flatMap((entry) => entry.published.instructions),
      skills: values.flatMap((entry) => entry.published.skills) };
  }

  scriptSources(): readonly ScriptSource[] {
    return [...this.#entries.values()].filter((entry) => entry.isPublished).flatMap((entry) => entry.scriptSources);
  }

  /** Go uses this before committing the prepared source and its method table. */
  prepared(sourceInstanceId: string): boolean {
    return [...this.#entries.values()].some((entry) =>
      entry.scope.sourceInstanceId === sourceInstanceId && entry.worker.threadId !== -1);
  }

  describe(sourceInstanceId: string): unknown {
    const entry = [...this.#entries.values()].find((candidate) =>
      candidate.scope.sourceInstanceId === sourceInstanceId && candidate.worker.threadId !== -1);
    requireCondition(!this.#closed && entry, "extension_unavailable",
      "The prepared extension Worker is unavailable.");
    return JSON.parse(canonicalJson({ scope: entry.scope, info: entry.info, methods: entry.methods,
      published: entry.published, scriptSources: entry.scriptSources }, maxFrameBytes));
  }

  /** Go supplies the actual admitted Run, source, method and operation scope. */
  async invoke(input: ExtensionInvocation, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    requireCondition(typeof input.sourceInstanceId === "string" && typeof input.methodId === "string" &&
      typeof input.runId === "string" && typeof input.operationId === "string" &&
      Number.isSafeInteger(input.deadlineAt) && isPlainRecord(input.context) &&
      input.context.runId === input.runId && Array.isArray(input.arguments),
    "invalid_run_scope", "The extension invocation needs its admitted Go Run scope.");
    // Go authorizes every invocation against its committed Directory. Its
    // commit may precede the publish acknowledgement received by this host,
    // so the prepared Worker must already be callable in that interval.
    const entry = [...this.#entries.values()].find((candidate) =>
      candidate.scope.sourceInstanceId === input.sourceInstanceId &&
      candidate.methods.some((method) => method.methodId === input.methodId));
    requireCondition(entry, "extension_unavailable", "The published extension method is unavailable.");
    requireCondition(!this.#runStops.has(input.runId), "run_closed", "This Run is already stopping or stopped.");
    requireCondition(!this.#packageTransaction, "extension_busy", "A package change is using the extension tree.");
    const id = randomUUID();
    this.#invocations.add(id);
    const result = this.#message(entry.worker, new AbortController().signal, (message) =>
      isPlainRecord(message) && message.type === "invoked" && message.id === id);
    const cancel = () => entry.worker.postMessage({ type: "cancel", id });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      entry.worker.postMessage({ type: "invoke", id, ...input });
      if (signal.aborted) cancel();
      const message = await result;
      requireCondition(isPlainRecord(message), "extension_invocation_failed", "The extension response is invalid.");
      if (isPlainRecord(message.error)) {
        const code = typeof message.error.code === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,95}$/.test(message.error.code)
          ? message.error.code : "extension_invocation_failed";
        const text = typeof message.error.message === "string" && message.error.message.length <= 1024
          ? message.error.message : "The extension operation failed.";
        throw new AgentError(code, text, isPlainRecord(message.error.details) ? message.error.details as JsonObject : undefined);
      }
      if (typeof message.code === "string")
        throw new AgentError(message.code, "The extension operation failed.");
      requireCondition(Object.hasOwn(message, "result"), "extension_invocation_failed", "The extension response is incomplete.");
      return message.result;
    } finally {
      signal.removeEventListener("abort", cancel);
      this.#invocations.delete(id);
    }
  }

  async #packageRequest(worker: Worker, type: "packages.begin" | "packages.finish", transactionId: string): Promise<void> {
    const id = randomUUID();
    const expected = type === "packages.begin" ? "packages.begun" : "packages.finished";
    const result = this.#message(worker, AbortSignal.timeout(30_000), (message) =>
      isPlainRecord(message) && message.type === expected && message.id === id);
    worker.postMessage({ type, id, transactionId });
    const response = await result;
    requireCondition(isPlainRecord(response) && response.code === undefined, "extension_busy",
      "An extension could not confirm the package maintenance gate.");
  }

  async beginPackages(transactionId: string): Promise<void> {
    requireCondition(!this.#closed && !this.#packageTransaction && /^package_[0-9a-f]{32}$/.test(transactionId) &&
      this.#pending.size === 0 && this.#closing.size === 0 && this.#invocations.size === 0,
    "extension_busy", "An extension is initializing, stopping or handling an active call.");
    const prepared = Promise.withResolvers<void>();
    const transaction = { id: transactionId, workers: [] as Worker[], ready: prepared.promise };
    this.#packageTransaction = transaction;
    try {
      for (const entry of this.#entries.values()) {
        try {
          await this.#packageRequest(entry.worker, "packages.begin", transactionId);
        } catch (cause) {
          // A lost acknowledgement can hide a held gate; explicitly attempt
          // release and retain the transaction if that cannot be confirmed.
          if (!isAgentError(cause) || cause.code !== "extension_busy") transaction.workers.push(entry.worker);
          throw cause;
        }
        transaction.workers.push(entry.worker);
      }
    } catch (cause) {
      const outcomes = await Promise.allSettled(transaction.workers.map((worker) =>
        this.#packageRequest(worker, "packages.finish", transactionId)));
      transaction.workers = transaction.workers.filter((_worker, index) => outcomes[index]?.status === "rejected");
      if (transaction.workers.length === 0) this.#packageTransaction = undefined;
      else throw new AgentError("extension_cleanup_unconfirmed", "The package maintenance gate could not be released.", undefined, { cause });
      throw cause;
    } finally {
      prepared.resolve();
    }
  }

  async finishPackages(transactionId: string): Promise<void> {
    const transaction = this.#packageTransaction;
    requireCondition(transaction && transaction.id === transactionId, "maintenance_transaction_invalid",
      "The extension package transaction does not belong to this host.");
    await transaction.ready;
    if (this.#packageTransaction !== transaction) return;
    const outcomes = await Promise.allSettled(transaction.workers.map((worker) =>
      this.#packageRequest(worker, "packages.finish", transactionId)));
    transaction.workers = transaction.workers.filter((_worker, index) => outcomes[index]?.status === "rejected");
    requireCondition(transaction.workers.length === 0, "extension_cleanup_unconfirmed",
      "An extension did not release its package maintenance gate.");
    if (this.#packageTransaction === transaction) this.#packageTransaction = undefined;
  }

  /** Join this Run's extension resources after requesting their actual stop. */
  stopRun(runId: string): Promise<void> {
    requireCondition(/^run_[0-9a-f]{32}$/.test(runId), "invalid_run_scope", "The Run identity is invalid.");
    const existing = this.#runStops.get(runId);
    if (existing) return existing.task;
    if (this.#runStops.size >= 4096) {
      const old = [...this.#runStops].find(([, value]) => value.status !== "running");
      if (old) this.#runStops.delete(old[0]);
    }
    requireCondition(this.#runStops.size < 4096, "extension_busy", "Too many extension Run cleanups are in progress.");
    const state: { status: "running" | "stopped" | "failed"; task: Promise<void> } = {
      status: "running", task: Promise.resolve(),
    };
    state.task = this.#stopRun(runId).then(() => { state.status = "stopped"; }, (error: unknown) => {
      state.status = "failed";
      throw error;
    });
    this.#runStops.set(runId, state);
    return state.task;
  }

  runStatus(runId: string): "running" | "stopped" | "failed" | "unknown" {
    requireCondition(/^run_[0-9a-f]{32}$/.test(runId), "invalid_run_scope", "The Run identity is invalid.");
    return this.#runStops.get(runId)?.status ?? "unknown";
  }

  async #stopRun(runId: string): Promise<void> {
    requireCondition(this.#entries.size > 0, "resource_cleanup_unconfirmed", "No extension Worker is available to confirm Run cleanup.");
    const outcomes = await Promise.allSettled([...this.#entries.values()].map(async (entry) => {
      const id = randomUUID();
      const response = this.#message(entry.worker, new AbortController().signal, (message) =>
        isPlainRecord(message) && message.type === "run.stopped" && message.id === id);
      entry.worker.postMessage({ type: "run.stop", id, runId });
      const result = await response;
      requireCondition(isPlainRecord(result) && result.code === undefined, "resource_cleanup_unconfirmed",
        "The Run's extension resources did not confirm their actual cleanup.");
    }));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async #closeEntry(name: string, entry: ActiveExtension): Promise<void> {
    const existing = this.#closing.get(name);
    if (existing) return await existing;
    const task = this.#stopEntry(name, entry);
    this.#closing.set(name, task);
    try { await task; } finally { if (this.#closing.get(name) === task) this.#closing.delete(name); }
  }

  async #stopEntry(name: string, entry: ActiveExtension): Promise<void> {
    const signal = AbortSignal.timeout(30_000);
    await this.call(entry.platform ? "platform.withdraw" : "extension.withdraw", { instanceId: this.instanceId,
      sourceInstanceId: entry.scope.sourceInstanceId }, signal);
    entry.isPublished = false;
    if (entry.platform) await this.#platformSettlement(entry.worker, "platform.withdrawn");
    const result = this.#message(entry.worker, signal, (message) =>
      isPlainRecord(message) && (message.type === "closed" || message.type === "close_failed"));
    entry.worker.postMessage({ type: "close" });
    const message = await result;
    requireCondition(isPlainRecord(message) && message.type === "closed", "extension_cleanup_unconfirmed",
      "The extension did not confirm its actual cleanup.");
    entry.stopPort();
    await entry.worker.terminate();
    if (this.#entries.get(name) === entry) this.#entries.delete(name);
  }

  async #platformSettlement(worker: Worker, type: "platform.confirm" | "platform.withdrawn"): Promise<void> {
    const id = randomUUID();
    const response = this.#message(worker, AbortSignal.timeout(30_000), (message) =>
      isPlainRecord(message) && message.type === "platform.settled" && message.id === id);
    worker.postMessage({ type, id });
    const result = await response;
    requireCondition(isPlainRecord(result) && result.code === undefined,
      "platform_publication_failed", "The platform publication could not be settled.");
  }

  async disable(name: string): Promise<void> {
    requireCondition(!this.#packageTransaction, "extension_busy", "A package change is using the extension tree.");
    const pending = this.#pending.get(name);
    if (pending) {
      pending.controller.abort(new AgentError("extension_disabled", "The extension is being disabled."));
      await pending.done;
    }
    const entry = this.#entries.get(name);
    if (!entry) return;
    await this.#closeEntry(name, entry);
  }

  async close(): Promise<void> {
    this.#closed = true;
    let packageFailure: unknown;
    if (this.#packageTransaction) {
      try { await this.finishPackages(this.#packageTransaction.id); }
      catch (cause) { packageFailure = cause; }
    }
    const pending = [...this.#pending.values()];
    for (const entry of pending) entry.controller.abort(new AgentError("host_closing", "The host is closing."));
    await Promise.all(pending.map((entry) => entry.done));
    const outcomes = await Promise.allSettled([...this.#entries].map(([name, entry]) => this.#closeEntry(name, entry)));
    const failure = outcomes.find((result) => result.status === "rejected");
    if (failure?.status === "rejected" || packageFailure) {
      // Losing Go prevents authenticated cleanup confirmation. Terminate the
      // local Workers so the host can exit while reporting the unknown state.
      await Promise.allSettled([...this.#entries.values()].map(async (entry) => {
        entry.stopPort();
        await entry.worker.terminate();
      }));
      throw failure?.status === "rejected" ? failure.reason : packageFailure;
    }
  }

  #message(worker: Worker, signal: AbortSignal, accepts: (message: unknown) => boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      if (worker.threadId === -1) { reject(new AgentError("extension_worker_exited", "The extension Worker exited.")); return; }
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        signal.removeEventListener("abort", onAbort);
      };
      const onMessage = (message: unknown) => { if (!accepts(message)) return; cleanup(); resolve(message); };
      const onError = () => { cleanup(); reject(new AgentError("extension_worker_failed", "The extension Worker failed.")); };
      const onExit = () => { cleanup(); reject(new AgentError("extension_worker_exited", "The extension Worker exited.")); };
      const onAbort = () => { cleanup(); reject(signal.reason); };
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
