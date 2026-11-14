import { EventEmitter, once } from "node:events";
import { performance } from "node:perf_hooks";
import { AgentError, isAgentError } from "../contracts/errors.js";
import { types } from "node:util";
import { safeErrorData } from "../contracts/error-data.js";
import type { JsonObject } from "../contracts/types.js";
import type { ResourceRef, ManagedResource } from "../extensions/resources.js";
import type {
  ProcessBackend,
  ProcessBackendOptions,
  ProcessFacts,
  ProcessStopOptions,
} from "./backend.js";
import { ProcessOutputLog, type ProcessOutputOptions } from "./output-log.js";
import type { LaunchInput, PreparedLaunch } from "./launch.js";

const instances = new WeakSet<object>();
export const isManagedProcess = (value: unknown): value is ManagedProcess =>
  !!value && typeof value === "object" && instances.has(value);

async function createBackend(
  tty: boolean,
  options: ProcessBackendOptions,
): Promise<ProcessBackend> {
  const file =
    process.platform === "win32" ? "windows-pipes" : tty ? "pty" : "pipes";
  const name =
    process.platform === "win32"
      ? "WindowsProcessBackend"
      : tty
        ? "PtyProcessBackend"
        : "PipeProcessBackend";
  const module = (await import(
    new URL(`./${file}.js`, import.meta.url).href
  )) as Record<string, new (options: ProcessBackendOptions) => ProcessBackend>;
  return new module[name]!(options);
}
const initialFacts: ProcessFacts = {
  pid: null,
  startedAt: null,
  rootExited: false,
  exitCode: null,
  exitSignal: null,
  outputComplete: false,
  treeStopped: false,
  closed: false,
  stopRequested: false,
  forceRequested: false,
};

function defaultEofAlreadyClosed(cause: unknown, facts: ProcessFacts): boolean {
  const code = (value: unknown): unknown => {
    if (
      !value ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      !types.isNativeError(value)
    )
      return undefined;
    const field = Object.getOwnPropertyDescriptor(value, "code");
    return field && "value" in field ? field.value : undefined;
  };
  const value = code(cause);
  if (
    [
      "process_stdin_closed",
      "process_input_closed",
      "EPIPE",
      "ERR_STREAM_DESTROYED",
      "ERR_STREAM_WRITE_AFTER_END",
    ].includes(value as string)
  )
    return true;
  if (value === "process_closed") return facts.closed;
  const inner = isAgentError(cause)
    ? Object.getOwnPropertyDescriptor(cause, "cause")
    : undefined;
  return (
    value === "process_input_failed" &&
    !!inner &&
    "value" in inner &&
    [
      "process_stdin_closed",
      "process_input_closed",
      "EPIPE",
      "ERR_STREAM_DESTROYED",
      "ERR_STREAM_WRITE_AFTER_END",
    ].includes(code(inner.value) as string)
  );
}

/** Cold public-protocol resource. No process, environment probe or log is opened by construction. */
export class ManagedProcess extends EventEmitter implements ManagedResource {
  readonly closed: Promise<void>;
  readonly input: LaunchInput;
  #closed = Promise.withResolvers<void>();
  #completed = Promise.withResolvers<void>();
  #stop = new AbortController();
  #ref?: ResourceRef<ManagedProcess>;
  #backend?: ProcessBackend;
  #log?: ProcessOutputLog;
  #flow?: Promise<void>;
  #preparing = false;
  #started = false;
  #logOpened = false;
  #outputComplete = false;
  #outputFailed = false;
  #preparationUnconfirmed = false;
  #confirmed = false;
  #finishing?: Promise<void>;
  #disposing?: Promise<void>;
  #failure: unknown;
  #stopReason?: JsonObject;
  #prepared?: PreparedLaunch;
  #lastReport = "";
  #revision = 0;
  #timer?: NodeJS.Timeout;
  #deadlineWall?: number;
  #deadlineMono?: number;
  #detach: (() => void)[] = [];
  constructor(
    readonly agentRoot: string,
    input: LaunchInput,
    readonly mode: "exec" | "start",
    readonly outputOptions: ProcessOutputOptions = {},
  ) {
    super();
    this.setMaxListeners(0);
    this.input = input;
    this.closed = this.#closed.promise;
    void this.closed.catch(() => {});
    void this.#completed.promise.catch(() => {});
    instances.add(this);
  }
  get revision(): number {
    return this.#revision;
  }
  get failure(): unknown {
    return this.#failure ?? this.#backend?.failure;
  }
  get log(): ProcessOutputLog | undefined {
    return this.#log;
  }
  get outputReady(): boolean {
    return this.#logOpened;
  }
  bind(ref: ResourceRef<ManagedProcess>): void {
    if (this.#ref || ref.value !== this)
      throw new AgentError(
        "invalid_process_binding",
        "The process must retain its one registered identity.",
      );
    this.#ref = ref;
    if (this.#confirmed) return;
    const stop = () => {
      void this.dispose(ref.signal.reason).catch((cause) =>
        this.#failed(cause),
      );
    };
    ref.signal.addEventListener("abort", stop, { once: true });
    this.#detach.push(() => ref.signal.removeEventListener("abort", stop));
    if (ref.signal.aborted) stop();
    this.#publish();
  }
  facts(): ProcessFacts {
    const facts = this.#backend?.facts() ?? initialFacts;
    return {
      ...facts,
      closed: this.#confirmed,
      outputComplete: this.#outputComplete,
      treeStopped: this.#backend ? facts.treeStopped : this.#confirmed,
    };
  }
  #checkDeadline(): void {
    if (
      !this.#confirmed &&
      !this.#stop.signal.aborted &&
      this.#deadlineWall !== undefined &&
      (Date.now() >= this.#deadlineWall ||
        performance.now() >= this.#deadlineMono!)
    )
      void this.dispose(
        new AgentError(
          "process_timeout",
          "The process resource deadline expired.",
        ),
      ).catch((cause) => this.#failed(cause));
  }
  details(): JsonObject {
    this.#checkDeadline();
    const facts = this.facts();
    const state = this.#confirmed
      ? this.#failure
        ? "failed"
        : "exited"
      : this.#stop.signal.aborted
        ? "stopping"
        : this.#failure
          ? "failed"
          : facts.rootExited
            ? "finishing"
            : this.#started
              ? "running"
              : this.#preparing
                ? "preparing"
                : "registered";
    return {
      state,
      ...facts,
      outputComplete: this.#outputComplete,
      tty: this.input.tty,
      platform: process.platform,
      ...(this.#prepared
        ? {
            executable: this.#prepared.executable.path,
            shell: this.#prepared.shell,
            cwd: this.#prepared.launch.cwd,
          }
        : {}),
      ...(this.#stopReason ? { stopReason: this.#stopReason } : {}),
      ...(this.#preparationUnconfirmed ? { preparationUnconfirmed: true } : {}),
      ...(this.#failure
        ? {
            failure: {
              code:
                safeErrorData(this.#failure, {
                  code: "process_failed",
                  message: "The managed process failed.",
                }).code ?? "process_failed",
            },
          }
        : {}),
    } as JsonObject;
  }
  #publish(): void {
    this.#revision++;
    if (this.#ref && !this.#confirmed) {
      const details = this.details(),
        encoded = JSON.stringify(details);
      if (encoded !== this.#lastReport) {
        this.#ref.report(details);
        this.#lastReport = encoded;
      }
    }
    this.emit("change");
  }
  #changed = (): void => {
    try {
      this.#publish();
    } catch (cause) {
      this.#failed(cause);
      void this.dispose(cause).catch(() => {});
    }
  };
  #failed(cause: unknown): void {
    this.#failure ??= cause;
    this.#completed.reject(cause);
    try {
      this.#publish();
    } catch {
      this.#revision++;
      this.emit("change");
    }
  }
  async start(
    prepare: (signal: AbortSignal) => Promise<PreparedLaunch>,
  ): Promise<void> {
    if (!this.#ref || this.#flow)
      throw new AgentError(
        "invalid_process_start",
        "A process starts exactly once after resource registration.",
      );
    this.#stop.signal.throwIfAborted();
    this.#preparing = true;
    if (this.input.timeoutMs !== undefined) {
      this.#deadlineWall = Date.now() + this.input.timeoutMs;
      this.#deadlineMono = performance.now() + this.input.timeoutMs;
      this.#timer = setTimeout(
        () => this.#checkDeadline(),
        this.input.timeoutMs,
      );
    }
    const flow = this.#start(prepare);
    this.#flow = flow;
    try {
      await flow;
    } catch (cause) {
      if (
        safeErrorData(cause, {
          code: "process_failed",
          message: "Process preparation failed.",
        }).code === "environment_cleanup_unconfirmed"
      )
        this.#preparationUnconfirmed = true;
      this.#failed(cause);
      await this.dispose(cause).catch((cleanup) => this.#failed(cleanup));
      throw cause;
    }
  }
  async #start(
    prepare: (signal: AbortSignal) => Promise<PreparedLaunch>,
  ): Promise<void> {
    const signal = this.#stop.signal;
    this.#log = new ProcessOutputLog(
      this.agentRoot,
      this.#ref!.id,
      this.outputOptions,
    );
    this.#log.on("change", this.#changed);
    this.#detach.push(() => this.#log?.off("change", this.#changed));
    this.#publish();
    await this.#log.open({ signal });
    this.#logOpened = true;
    signal.throwIfAborted();
    this.#backend = await createBackend(this.input.tty, {
      onOutput: async (stream, bytes) => {
        try {
          await this.#log!.append(stream, bytes);
        } catch (cause) {
          this.#outputFailed = true;
          this.#failure ??= cause;
          throw cause;
        }
      },
    });
    this.#backend.on("change", this.#changed);
    this.#detach.push(() => this.#backend?.off("change", this.#changed));
    // Observe real native completion before any environment or start operation.
    void this.#backend.closed.then(
      () => {
        void this.#finish().catch((cause) => this.#failed(cause));
      },
      (cause) => this.#failed(cause),
    );
    signal.throwIfAborted();
    this.#prepared = await prepare(signal);
    signal.throwIfAborted();
    await this.#backend.start(this.#prepared.launch);
    signal.throwIfAborted();
    this.#started = true;
    this.#preparing = false;
    this.#publish();
    if (this.input.input !== undefined)
      await this.#backend.write(
        this.input.input,
        !this.input.tty && this.mode === "exec",
        signal,
      );
    else if (
      !this.input.tty &&
      this.mode === "exec" &&
      !this.#backend.facts().rootExited &&
      !this.#backend.facts().closed
    ) {
      try {
        await this.#backend.write(new Uint8Array(), true, signal);
      } catch (cause) {
        signal.throwIfAborted();
        // This is only an idempotent close of an empty Agent write end. Explicit
        // input/user writes, fatal backend errors and unknown I/O failures retain
        // their failures; actual process/output closure is still awaited.
        if (
          this.#backend.failure !== undefined ||
          !defaultEofAlreadyClosed(cause, this.#backend.facts())
        )
          throw cause;
      }
    }
    signal.throwIfAborted();
  }
  async #finish(): Promise<void> {
    if (this.#confirmed) return;
    if (this.#finishing) return await this.#finishing;
    const work = (async () => {
      if (this.#flow) await this.#flow.catch(() => {});
      if (this.#backend?.failure) this.#failure ??= this.#backend.failure;
      const facts = this.#backend?.facts() ?? initialFacts;
      if (this.#backend?.failure && facts.closed && !facts.outputComplete)
        this.#outputFailed = true;
      if (
        this.#backend &&
        (!facts.closed ||
          !facts.treeStopped ||
          (!facts.outputComplete && !this.#outputFailed))
      )
        throw new AgentError(
          "process_cleanup_unconfirmed",
          "The process backend has not confirmed actual tree and output closure.",
        );
      // Known backend failure with settled native readers keeps output incomplete,
      // but cannot retain a physically closed process after its log also closes.
      // Unknown incomplete output still cannot establish resource closure.
      if (this.#preparationUnconfirmed) {
        await this.#log?.close();
        throw new AgentError(
          "process_preparation_unconfirmed",
          "A preparation process group could not confirm closure.",
        );
      }
      if (this.#logOpened && !this.#outputFailed) {
        try {
          await this.#log!.finish();
          this.#outputComplete = true;
        } catch (cause) {
          this.#failure ??= cause;
          this.#outputComplete = false;
          // Failed durability is a failure outcome, not evidence that the OS
          // process is still alive. Closure requires the real handle close.
          await this.#log!.close();
        }
      } else await this.#log?.close();
      this.#preparing = false;
      const details = {
        ...this.details(),
        state: this.#failure ? "failed" : "exited",
        closed: true,
        treeStopped: this.#backend ? facts.treeStopped : true,
        outputComplete: this.#outputComplete,
      };
      this.#ref?.report(details);
      this.#confirmed = true;
      if (this.#timer) clearTimeout(this.#timer);
      for (const detach of this.#detach.splice(0)) detach();
      this.#closed.resolve();
      if (this.#failure) this.#completed.reject(this.#failure);
      else this.#completed.resolve();
      this.#revision++;
      this.emit("change");
    })();
    this.#finishing = work;
    try {
      await work;
    } finally {
      if (this.#finishing === work) this.#finishing = undefined;
    }
  }
  async wait(): Promise<void> {
    return await this.#completed.promise;
  }
  async write(
    data: Uint8Array,
    eof: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.#checkDeadline();
    this.#stop.signal.throwIfAborted();
    signal.throwIfAborted();
    if (!this.#started || !this.#backend)
      throw new AgentError(
        "process_not_running",
        "The process input is not available.",
      );
    await this.#backend.write(data, eof, signal);
  }
  async resize(cols: number, rows: number): Promise<void> {
    this.#checkDeadline();
    this.#stop.signal.throwIfAborted();
    if (!this.#backend)
      throw new AgentError(
        "process_not_running",
        "The process terminal is not available.",
      );
    await this.#backend.resize(cols, rows);
  }
  async signal(value: NodeJS.Signals): Promise<unknown> {
    this.#checkDeadline();
    this.#stop.signal.throwIfAborted();
    if (!this.#backend)
      throw new AgentError(
        "process_not_running",
        "The process signal target is not available.",
      );
    return await this.#backend.signal(value);
  }
  async stop(
    options: ProcessStopOptions = {},
    reason: unknown = new AgentError(
      "process_stopped",
      "Process stop was requested.",
    ),
  ): Promise<{ accepted: true; confirmed: boolean; facts: ProcessFacts }> {
    this.#requestStop(reason, false);
    const stopping = this.#backend?.stop(options);
    if (this.#flow) await this.#flow.catch(() => {});
    if (this.#backend) {
      await (stopping ?? this.#backend.stop(options));
      if (this.#backend.facts().closed)
        await this.#finish().catch((cause) => this.#failed(cause));
    } else await this.#finish().catch((cause) => this.#failed(cause));
    return { accepted: true, confirmed: this.#confirmed, facts: this.facts() };
  }
  #requestStop(reason: unknown, stopBackend = true): void {
    if (this.#confirmed || this.#stop.signal.aborted) return;
    const safe = safeErrorData(reason, {
      code: "process_stopped",
      message: "Process stop was requested.",
    });
    this.#stopReason = { code: safe.code ?? "process_stopped" };
    if (safe.code === "process_timeout") this.#failure ??= reason;
    this.#stop.abort(reason);
    // Stopping must reach a cold/starting backend immediately, before awaiting
    // the preparation flow that may itself still be waiting on native readiness.
    if (stopBackend && this.#backend)
      void Promise.resolve()
        .then(() => this.#backend!.dispose(reason))
        .catch((cause) => this.#failed(cause));
    this.#changed();
  }
  async dispose(reason?: unknown): Promise<void> {
    if (this.#confirmed) return;
    this.#requestStop(
      reason ??
        new AgentError("process_stopped", "Process cleanup was requested."),
    );
    if (this.#disposing) return await this.#disposing;
    const work = (async () => {
      // Abort preparation immediately. Its own actual cleanup must finish before
      // this resource can confirm closure or a delayed backend could start.
      if (this.#flow) await this.#flow.catch(() => {});
      if (this.#backend) {
        await this.#backend.dispose(reason);
        if (this.#backend.facts().closed) await this.#finish();
      } else await this.#finish();
    })();
    this.#disposing = work;
    try {
      await work;
    } finally {
      if (this.#disposing === work) this.#disposing = undefined;
    }
  }
  async waitForChange(
    revision: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.#checkDeadline();
    if (this.#revision !== revision || this.#confirmed || waitMs === 0) return;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), waitMs);
    const changed = once(this, "change", {
      signal: AbortSignal.any([signal, timeout.signal]),
    });
    if (this.#revision !== revision || this.#confirmed) timeout.abort();
    try {
      await changed;
    } catch {
      signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      timeout.abort();
    }
  }
}
