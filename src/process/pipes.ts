import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, addAbortListener } from "node:events";
import { constants } from "node:os";
import path from "node:path";
import { types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import type {
  ProcessBackend,
  ProcessBackendOptions,
  ProcessFacts,
  ProcessLaunch,
  ProcessSignalReceipt,
  ProcessStopOptions,
  ProcessStopReceipt,
} from "./backend.js";

interface WriteJob {
  bytes: Buffer;
  readonly size: number;
  readonly eof: boolean;
  readonly signal: AbortSignal;
  started: boolean;
  submitted: boolean;
  counted: boolean;
  finish(cause?: unknown): void;
  cancel(cause?: unknown): void;
}
const inputByteLimit = 16 * 1024 * 1024;
const inputCountLimit = 256;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(
  typedArray,
  "byteOffset",
)!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(
  typedArray,
  "byteLength",
)!.get!;

/** An owned POSIX process group and its real pipes; construction starts no I/O. */
export class PipeProcessBackend extends EventEmitter implements ProcessBackend {
  readonly closed: Promise<void>;
  #resolveClosed: () => void;
  #options: ProcessBackendOptions;
  #child?: ChildProcessWithoutNullStreams;
  #group: number | null = null;
  #started = false;
  #attempted = false;
  #rootDone = false;
  #stdioClosed = false;
  #outputPending = 0;
  #outputFailed = false;
  #writesPending = 0;
  #failure: unknown;
  #groupPoll?: NodeJS.Timeout;
  #stopTask?: Promise<ProcessStopReceipt>;
  #disposeTask?: Promise<void>;
  #writeQueue: WriteJob[] = [];
  #activeWrite?: WriteJob;
  #writing = false;
  #inputBytes = 0;
  #inputCount = 0;
  #inputSignals = new Map<
    AbortSignal,
    { jobs: Set<WriteJob>; dispose(): void }
  >();
  #eof: WriteJob | null = null;
  #inputClosed = false;
  #facts: ProcessFacts = {
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

  constructor(options: ProcessBackendOptions) {
    super();
    requireCondition(
      options && typeof options.onOutput === "function",
      "invalid_process_backend",
      "A process backend needs its bounded output consumer.",
    );
    this.setMaxListeners(0);
    this.#options = { onOutput: options.onOutput };
    const closed = Promise.withResolvers<void>();
    this.closed = closed.promise;
    this.#resolveClosed = closed.resolve;
  }
  get failure(): unknown {
    return this.#failure;
  }
  facts(): ProcessFacts {
    return Object.freeze({ ...this.#facts });
  }
  #change(patch: Partial<ProcessFacts> = {}): void {
    this.#facts = { ...this.#facts, ...patch };
    this.emit("change");
  }
  #fail(cause: unknown): void {
    this.#failure ??= cause;
    this.emit("change");
    void this.stop().catch((error) => {
      this.#failure ??= error;
      this.emit("change");
    });
  }

  async start(launch: ProcessLaunch): Promise<void> {
    requireCondition(
      process.platform !== "win32",
      "process_backend_unsupported",
      "POSIX pipes cannot stand in for Windows Job Object management.",
    );
    requireCondition(
      !launch.tty,
      "process_tty_unsupported",
      "A pipe backend does not create a terminal.",
    );
    requireCondition(
      !this.#attempted && !this.#facts.stopRequested && !this.#facts.closed,
      "process_stopping",
      "This process identity cannot start again or after disposal.",
    );
    requireCondition(
      path.isAbsolute(launch.file) &&
        path.isAbsolute(launch.cwd) &&
        !launch.file.includes("\0") &&
        !launch.cwd.includes("\0") &&
        Array.isArray(launch.args) &&
        launch.args.every(
          (argument) =>
            typeof argument === "string" && !argument.includes("\0"),
        ),
      "invalid_process_launch",
      "A pipe process needs a resolved program, explicit cwd and separate string arguments.",
    );
    this.#attempted = true;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.file, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      this.#group = child.pid ?? null;
    } catch (cause) {
      this.#failure = new AgentError(
        "process_spawn_failed",
        "The native process could not be started.",
        undefined,
        { cause },
      );
      this.#rootDone = this.#stdioClosed = true;
      this.#change({ outputComplete: true, treeStopped: true });
      this.#closeIfReady();
      throw this.#failure;
    }
    this.#consume(child.stdout, "stdout");
    this.#consume(child.stderr, "stderr");
    child.stdin.on("error", (cause) => {
      this.#failure ??= new AgentError(
        "process_input_failed",
        "The native process input failed.",
        undefined,
        { cause },
      );
      this.emit("change");
    });
    child.stdin.once("close", () => {
      this.#inputClosed = true;
    });
    child.once("exit", (exitCode, exitSignal) => {
      this.#rootDone = true;
      this.#change({ rootExited: true, exitCode, exitSignal });
      this.#observeGroup();
      this.#closeIfReady();
    });
    child.once("close", (exitCode, exitSignal) => {
      this.#rootDone = this.#stdioClosed = true;
      this.#inputClosed = true;
      this.#change(
        this.#started ? { rootExited: true, exitCode, exitSignal } : {},
      );
      this.#observeGroup();
      this.#closeIfReady();
    });
    return await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        this.#started = true;
        this.#change({ pid: child.pid!, startedAt: Date.now() });
        if (this.#facts.stopRequested) {
          try {
            this.#send("SIGTERM");
          } catch (cause) {
            this.#fail(cause);
          }
          reject(
            new AgentError(
              "process_stopping",
              "The process started while its owning scope was stopping.",
            ),
          );
        } else resolve();
      });
      child.on("error", (cause) => {
        const failure = new AgentError(
          "process_spawn_failed",
          "The native process could not be started or controlled.",
          undefined,
          { cause },
        );
        this.#fail(failure);
        reject(failure);
      });
    });
  }

  #consume(stream: NodeJS.ReadableStream, kind: "stdout" | "stderr"): void {
    const queue: Buffer[] = [];
    let consuming = false;
    const consume = async () => {
      if (consuming) return;
      consuming = true;
      while (queue.length) {
        const value = queue.shift()!;
        try {
          for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
            if (this.#outputFailed) break;
            // Never give a consumer a larger slab or another stream's bytes.
            const bytes = Buffer.from(
              value.subarray(
                offset,
                Math.min(value.byteLength, offset + 64 * 1024),
              ),
            );
            await this.#options.onOutput(kind, bytes);
            this.emit("change");
          }
        } catch (cause) {
          this.#outputFailed = true;
          this.#fail(
            new AgentError(
              "process_output_failed",
              "The native process output could not be consumed.",
              { stream: kind },
              { cause },
            ),
          );
        } finally {
          this.#outputPending--;
          this.#closeIfReady();
        }
      }
      consuming = false;
      stream.resume();
    };
    stream.on("data", (value: Buffer) => {
      stream.pause();
      // ChildProcess flushStdio() can resume paused pipes when the root exits.
      // Serialize that final extra chunk too; pause alone is not a mutex.
      queue.push(value);
      this.#outputPending++;
      void consume();
    });
    stream.on("error", (cause) => {
      this.#fail(
        new AgentError(
          "process_output_failed",
          "The native process output pipe failed.",
          { stream: kind },
          { cause },
        ),
      );
    });
  }
  #observeGroup(): void {
    if (this.#facts.treeStopped || !this.#rootDone) return;
    if (this.#group === null) {
      this.#change({ treeStopped: true });
      this.#closeIfReady();
      return;
    }
    try {
      process.kill(-this.#group, 0);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        clearTimeout(this.#groupPoll);
        this.#groupPoll = undefined;
        this.#change({ treeStopped: true });
        this.#closeIfReady();
        return;
      }
      // EPERM establishes no closure. This also covers groups awaiting reaping.
      if (code !== "EPERM")
        this.#failure ??= new AgentError(
          "process_tree_unconfirmed",
          "The original process group could not be observed.",
          undefined,
          { cause },
        );
    }
    if (!this.#groupPoll)
      this.#groupPoll = setTimeout(() => {
        this.#groupPoll = undefined;
        this.#observeGroup();
      }, 50);
  }
  #closeIfReady(): void {
    if (this.#facts.closed) return;
    const outputComplete = this.#stdioClosed && this.#outputPending === 0;
    if (outputComplete !== this.#facts.outputComplete)
      this.#change({ outputComplete });
    if (
      !this.#rootDone ||
      !outputComplete ||
      !this.#facts.treeStopped ||
      this.#writesPending !== 0
    )
      return;
    clearTimeout(this.#groupPoll);
    this.#groupPoll = undefined;
    this.#change({ closed: true });
    this.#resolveClosed();
  }
  #send(signal: NodeJS.Signals): ProcessSignalReceipt {
    requireCondition(
      typeof signal === "string" && Object.hasOwn(constants.signals, signal),
      "unsupported_process_signal",
      "The selected signal is not supported on this platform.",
    );
    if (this.#facts.treeStopped || this.#facts.closed || this.#group === null)
      return {
        requested: signal,
        delivered: false,
        mechanism: "process-group",
      };
    try {
      process.kill(-this.#group, signal);
      this.#change(signal === "SIGKILL" ? { forceRequested: true } : {});
      return { requested: signal, delivered: true, mechanism: "process-group" };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
        this.#observeGroup();
        return {
          requested: signal,
          delivered: false,
          mechanism: "process-group",
        };
      }
      throw new AgentError(
        "process_signal_failed",
        "The signal could not be delivered to the original process group.",
        { requested: signal },
        { cause },
      );
    }
  }
  signal(signal: NodeJS.Signals): ProcessSignalReceipt {
    requireCondition(
      this.#attempted || this.#facts.closed,
      "process_not_started",
      "The cold process has not started.",
    );
    return this.#send(signal);
  }
  resize(_cols: number, _rows: number): void {
    throw new AgentError(
      "process_not_tty",
      "A pipe process cannot resize a terminal.",
    );
  }

  #writable(): ChildProcessWithoutNullStreams["stdin"] {
    requireCondition(
      this.#started &&
        !this.#facts.stopRequested &&
        !this.#facts.closed &&
        !this.#inputClosed &&
        this.#child &&
        !this.#child.stdin.destroyed &&
        !this.#child.stdin.writableEnded,
      "process_stdin_closed",
      "The process no longer accepts input.",
    );
    return this.#child.stdin;
  }
  write(data: Uint8Array, eof: boolean, signal: AbortSignal): Promise<void> {
    try {
      requireCondition(
        types.isUint8Array(data) &&
          typeof eof === "boolean" &&
          signal instanceof AbortSignal,
        "invalid_process_input",
        "Process input needs native bytes, an EOF choice and a native signal.",
      );
      this.#writable();
      requireCondition(
        !this.#eof,
        "process_stdin_closed",
        "An earlier input request already reserved EOF.",
      );
      const size = lengthOf.call(data) as number;
      requireCondition(
        this.#inputCount < inputCountLimit &&
          size <= inputByteLimit - this.#inputBytes,
        "process_input_busy",
        "The pending input count or byte budget is full.",
        { maxPending: inputCountLimit, maxBytes: inputByteLimit },
      );
      const completion = Promise.withResolvers<void>();
      let waiting = true;
      const job: WriteJob = {
        bytes: Buffer.from(
          Buffer.from(
            bufferOf.call(data) as ArrayBuffer,
            offsetOf.call(data) as number,
            size,
          ),
        ),
        size,
        eof,
        signal,
        started: false,
        submitted: false,
        counted: true,
        finish: (cause?: unknown) => {
          if (!waiting) return;
          waiting = false;
          this.#unwatchInput(job);
          if (cause !== undefined) completion.reject(cause);
          else completion.resolve();
        },
        cancel: (cause?: unknown) => {
          if (!job.started) {
            const index = this.#writeQueue.indexOf(job);
            if (index >= 0) this.#writeQueue.splice(index, 1);
            if (this.#eof === job) this.#eof = null;
            this.#releaseInput(job);
          }
          job.finish(
            new AgentError(
              "process_write_wait_cancelled",
              "Stopped waiting for process input; bytes already submitted may still have been delivered.",
              {
                submitted: job.submitted,
                bytesSubmitted: job.submitted ? job.size : 0,
              },
              { cause },
            ),
          );
        },
      };
      if (eof) this.#eof = job;
      this.#inputCount++;
      this.#inputBytes += size;
      this.#writeQueue.push(job);
      this.#watchInput(job);
      this.#pumpInput();
      return completion.promise;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  #releaseInput(job: WriteJob): void {
    if (!job.counted) return;
    job.counted = false;
    this.#inputCount--;
    this.#inputBytes -= job.size;
    job.bytes = Buffer.alloc(0);
  }
  #watchInput(job: WriteJob): void {
    let entry = this.#inputSignals.get(job.signal);
    if (!entry) {
      const jobs = new Set<WriteJob>();
      const subscription = addAbortListener(job.signal, () => {
        for (const current of [...jobs]) current.cancel(job.signal.reason);
      });
      entry = { jobs, dispose: () => subscription[Symbol.dispose]() };
      this.#inputSignals.set(job.signal, entry);
    }
    entry.jobs.add(job);
    if (job.signal.aborted) job.cancel(job.signal.reason);
  }
  #unwatchInput(job: WriteJob): void {
    const entry = this.#inputSignals.get(job.signal);
    if (!entry) return;
    entry.jobs.delete(job);
    if (!entry.jobs.size) {
      this.#inputSignals.delete(job.signal);
      entry.dispose();
    }
  }
  #pumpInput(): void {
    if (this.#writing) return;
    this.#writing = true;
    void (async () => {
      while (this.#writeQueue.length) {
        const job = this.#writeQueue.shift()!;
        this.#activeWrite = job;
        job.started = true;
        this.#writesPending++;
        try {
          job.signal.throwIfAborted();
          this.#writable();
          if (job.bytes.byteLength) await this.#writeBytes(job);
          if (job.eof) await this.#endInput(job);
          job.finish();
        } catch (cause) {
          job.finish(cause);
        } finally {
          this.#activeWrite = undefined;
          this.#writesPending--;
          this.#releaseInput(job);
          this.#closeIfReady();
        }
      }
    })().then(
      () => {
        this.#writing = false;
        if (this.#writeQueue.length) this.#pumpInput();
      },
      (cause) => {
        this.#writing = false;
        this.#fail(cause);
      },
    );
  }
  #writeBytes(job: WriteJob): Promise<void> {
    const input = this.#writable();
    return new Promise((resolve, reject) => {
      let callback = false,
        returned = false,
        needsDrain = false,
        drained = false,
        finished = false;
      const clear = () => {
        input.off("error", failed);
        input.off("close", closed);
        input.off("drain", drain);
      };
      const failed = (cause: unknown) => {
        if (finished) return;
        finished = true;
        clear();
        reject(
          new AgentError(
            "process_input_failed",
            "The input write failed; submitted bytes may have been partially delivered.",
            { submitted: job.submitted },
            { cause },
          ),
        );
      };
      const check = () => {
        if (!finished && returned && callback && (!needsDrain || drained)) {
          finished = true;
          clear();
          resolve();
        }
      };
      const closed = () =>
        failed(
          new AgentError(
            "process_stdin_closed",
            "The process closed its input during a write.",
          ),
        );
      const drain = () => {
        drained = true;
        check();
      };
      input.once("error", failed);
      input.once("close", closed);
      input.on("drain", drain);
      try {
        job.submitted = true;
        needsDrain = !input.write(job.bytes, (error) => {
          if (error) failed(error);
          else {
            callback = true;
            check();
          }
        });
        returned = true;
        check();
      } catch (cause) {
        failed(cause);
      }
    });
  }
  #endInput(job: WriteJob): Promise<void> {
    const input = this.#writable();
    return new Promise((resolve, reject) => {
      let finished = false;
      const clear = () => {
        input.off("error", failed);
        input.off("close", closed);
      };
      const failed = (cause: unknown) => {
        if (finished) return;
        finished = true;
        clear();
        reject(
          new AgentError(
            "process_input_failed",
            "The process input could not finish cleanly.",
            { submitted: job.submitted },
            { cause },
          ),
        );
      };
      const closed = () => {
        if (!input.writableFinished)
          failed(
            new AgentError(
              "process_stdin_closed",
              "The process closed its input before EOF was flushed.",
            ),
          );
      };
      input.once("error", failed);
      input.once("close", closed);
      try {
        job.submitted = true;
        input.end((error?: Error | null) => {
          if (error) {
            failed(error);
            return;
          }
          if (finished) return;
          if (!input.writableFinished) {
            failed(
              new AgentError(
                "process_stdin_closed",
                "The process input did not confirm its final flush.",
              ),
            );
            return;
          }
          finished = true;
          clear();
          this.#inputClosed = true;
          resolve();
        });
      } catch (cause) {
        failed(cause);
      }
    });
  }

  #waitClosed(ms: number): Promise<boolean> {
    if (this.#facts.closed || ms === 0)
      return Promise.resolve(this.#facts.closed);
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.off("change", changed);
        resolve(value);
      };
      const changed = () => {
        if (this.#facts.closed) finish(true);
      };
      const timer = setTimeout(() => finish(false), ms);
      this.on("change", changed);
      changed();
    });
  }
  stop(options: ProcessStopOptions = {}): Promise<ProcessStopReceipt> {
    const graceMs = options.graceMs ?? 1000,
      forceMs = options.forceMs ?? 1000;
    requireCondition(
      [graceMs, forceMs].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= 30000,
      ),
      "invalid_process_stop",
      "Process stop observation must be nonnegative and bounded.",
    );
    if (this.#stopTask) return this.#stopTask;
    const completion = Promise.withResolvers<ProcessStopReceipt>();
    const task = completion.promise;
    this.#stopTask = task;
    if (!this.#facts.stopRequested) {
      this.#change({ stopRequested: true });
      const reason = new AgentError(
        "process_stopping",
        "The process is stopping.",
      );
      for (const job of [...this.#writeQueue]) job.cancel(reason);
      this.#activeWrite?.cancel(reason);
    }
    if (!this.#attempted) {
      this.#rootDone = this.#stdioClosed = true;
      this.#change({ treeStopped: true });
      this.#closeIfReady();
    }
    void (async () => {
      try {
        this.#send("SIGTERM");
      } catch (cause) {
        this.#failure ??= cause;
      }
      let confirmed = await this.#waitClosed(graceMs);
      if (!confirmed) {
        this.#change({ forceRequested: true });
        try {
          this.#send("SIGKILL");
        } catch (cause) {
          this.#failure ??= cause;
        }
        confirmed = await this.#waitClosed(forceMs);
      }
      return Object.freeze({ confirmed, facts: this.facts() });
    })().then(completion.resolve, completion.reject);
    void task.then(
      () => {
        if (this.#stopTask === task && !this.#facts.closed)
          this.#stopTask = undefined;
      },
      () => {
        if (this.#stopTask === task) this.#stopTask = undefined;
      },
    );
    return task;
  }
  dispose(_reason?: unknown): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask;
    const task = this.stop().then((result) => {
      requireCondition(
        result.confirmed,
        "process_stop_unconfirmed",
        "The original process and pipes have not actually closed.",
      );
    });
    this.#disposeTask = task;
    void task.catch(() => {
      if (this.#disposeTask === task) this.#disposeTask = undefined;
    });
    return task;
  }
}
