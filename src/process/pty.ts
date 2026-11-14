import { EventEmitter } from "node:events";
import { constants } from "node:os";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ReadStream } from "node:tty";
import { setImmediate } from "node:timers/promises";
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

interface NativePty {
  fork(
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helper: string,
    exit: (code: number, signal: number) => void,
  ): { fd: number; pid: number; pty: string };
  resize(
    fd: number,
    cols: number,
    rows: number,
    xPixel: number,
    yPixel: number,
  ): void;
}
interface NativeAdapter {
  readonly api: NativePty;
  readonly helper: string;
}
let adapter: NativeAdapter | undefined;

function native(): NativeAdapter {
  requireCondition(
    process.platform === "darwin" || process.platform === "linux",
    "process_backend_unsupported",
    "This PTY backend requires a verified POSIX platform.",
  );
  if (adapter) return adapter;
  try {
    const require = createRequire(import.meta.url);
    const metadata = require("node-pty/package.json") as { version?: string };
    const exported = require("node-pty") as { native?: NativePty };
    const utility = require("node-pty/lib/utils.js") as {
      loadNativeModule(name: string): { dir: string; module: NativePty };
    };
    requireCondition(
      metadata.version === "1.2.0-beta.18" &&
        typeof utility.loadNativeModule === "function",
      "process_pty_native_unsupported",
      "The PTY native adapter requires its exact verified component version.",
    );
    const loaded = utility.loadNativeModule("pty");
    requireCondition(
      loaded.module === exported.native &&
        typeof loaded.module.fork === "function" &&
        typeof loaded.module.resize === "function" &&
        typeof loaded.dir === "string",
      "process_pty_native_unsupported",
      "The installed PTY component does not expose the verified native contract.",
    );
    // Only Darwin's posix_spawn adapter uses the helper; Linux forkpty does not
    // ship or execute one, but the native signature still expects a string.
    let helper = "";
    if (process.platform === "darwin") {
      helper = realpathSync.native(
        path.resolve(
          path.dirname(require.resolve("node-pty/lib/unixTerminal.js")),
          loaded.dir,
          "spawn-helper",
        ),
      );
      requireCondition(
        statSync(helper).isFile(),
        "process_pty_native_unsupported",
        "The verified PTY spawn helper is unavailable.",
      );
      accessSync(helper, fsConstants.X_OK);
    }
    adapter = { api: loaded.module, helper };
    return adapter;
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "process_pty_native_unsupported",
      "The installed PTY native binary or helper is unavailable.",
      undefined,
      { cause },
    );
  }
}

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
const maxInputQueue = 16 * 1024 * 1024;
const maxInputJobs = 256;
interface WriteJob {
  bytes: Buffer | null;
  readonly length: number;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  abort: () => void;
  started: boolean;
}

/**
 * A cold, owned POSIX PTY. node-pty (Microsoft, MIT) owns forkpty/resize/reaping.
 * Its pinned native export is intentionally used here: the beta.18 JS wrapper
 * destroys its socket 200ms after root exit, even when descendants still own it.
 * Node's stream/EOF, not that timer or public onExit, determines output closure.
 * Upstream: https://github.com/microsoft/node-pty (pinned lib/unixTerminal.js).
 */
export class PtyProcessBackend extends EventEmitter implements ProcessBackend {
  readonly closed: Promise<void>;
  #resolveClosed: () => void;
  #options: ProcessBackendOptions;
  #attempted = false;
  #rootDone = false;
  #outputDone = false;
  #reader?: ReadStream;
  #fd: number | null = null;
  #group: number | null = null;
  #failure: unknown;
  #groupPoll?: NodeJS.Timeout;
  #stopTask?: Promise<ProcessStopReceipt>;
  #disposeTask?: Promise<void>;
  #writeQueue: WriteJob[] = [];
  #draining = false;
  #writesPending = 0;
  #queuedInput = 0;
  #writeStop = new AbortController();
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
      "A PTY backend needs its bounded output consumer.",
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
      process.platform === "darwin" || process.platform === "linux",
      "process_backend_unsupported",
      "The POSIX PTY backend cannot substitute for Windows ConPTY and Job Objects.",
    );
    requireCondition(
      launch.tty === true,
      "process_not_tty",
      "The PTY backend only starts explicit terminal launches.",
    );
    requireCondition(
      !this.#attempted && !this.#facts.closed && !this.#facts.stopRequested,
      "process_stopping",
      "This PTY identity cannot start again or after disposal.",
    );
    requireCondition(
      path.isAbsolute(launch.file) &&
        path.isAbsolute(launch.cwd) &&
        !launch.file.includes("\0") &&
        !launch.cwd.includes("\0") &&
        Array.isArray(launch.args) &&
        launch.args.every(
          (value) => typeof value === "string" && !value.includes("\0"),
        ),
      "invalid_process_launch",
      "A PTY needs a resolved program, separate arguments and explicit cwd.",
    );
    geometry(launch.cols, launch.rows);
    const env = Object.create(null) as Record<string, string>;
    for (const [key, field] of Object.entries(
      Object.getOwnPropertyDescriptors(launch.env),
    )) {
      requireCondition(
        "value" in field &&
          typeof field.value === "string" &&
          key.length > 0 &&
          !/[\0=]/.test(key) &&
          !field.value.includes("\0"),
        "invalid_process_environment",
        "The PTY environment must contain stable string values.",
      );
      if (field.enumerable) env[key] = field.value;
    }
    env.PWD = launch.cwd;
    env.TERM ??= "xterm-256color";
    const capability = native();
    try {
      requireCondition(
        statSync(launch.file).isFile() && statSync(launch.cwd).isDirectory(),
        "invalid_process_launch",
        "The PTY program and cwd must still exist with their expected types.",
      );
      accessSync(launch.file, fsConstants.X_OK);
    } catch (cause) {
      throw new AgentError(
        "process_start_failed",
        "The PTY program or cwd is unavailable.",
        undefined,
        { cause },
      );
    }
    this.#attempted = true;
    let raw: { fd: number; pid: number; pty: string } | undefined;
    try {
      raw = capability.api.fork(
        launch.file,
        [...launch.args],
        Object.entries(env).map(([key, value]) => `${key}=${value}`),
        launch.cwd,
        launch.cols,
        launch.rows,
        -1,
        -1,
        true,
        capability.helper,
        (code, signal) => {
          this.#rootDone = true;
          const exitSignal =
            signal === 0
              ? null
              : (Object.entries(constants.signals).find(
                  ([, value]) => value === signal,
                )?.[0] ?? `signal:${signal}`);
          this.#change({
            rootExited: true,
            exitCode: signal ? null : code,
            exitSignal,
          });
          this.#observeGroup();
          this.#closeIfReady();
        },
      );
      requireCondition(
        Number.isSafeInteger(raw.pid) &&
          raw.pid > 1 &&
          raw.pid !== process.pid &&
          Number.isSafeInteger(raw.fd) &&
          raw.fd >= 0,
        "process_pty_native_unsupported",
        "The native PTY did not return a valid owned process and descriptor.",
      );
      this.#group = raw.pid;
      this.#fd = raw.fd;
      // ReadStream forwards this native stream option, although @types/node's
      // narrower SocketConstructorOpts omits it from excess-property checking.
      const streamOptions = { readable: true, highWaterMark: 64 * 1024 };
      const reader = new ReadStream(raw.fd, streamOptions);
      this.#reader = reader;
      const readerClosed = Promise.withResolvers<void>();
      reader.once("close", () => {
        this.#fd = null;
        readerClosed.resolve();
      });
      void this.#consume(reader, readerClosed.promise);
      this.#change({ pid: raw.pid, startedAt: Date.now() });
    } catch (cause) {
      this.#failure ??= new AgentError(
        "process_start_failed",
        "The native PTY could not start and attach its output.",
        undefined,
        { cause },
      );
      if (raw && this.#group !== null) {
        this.#change({ pid: this.#group, startedAt: Date.now() });
        if (!this.#reader) {
          try {
            closeSync(raw.fd);
            this.#fd = null;
            this.#outputDone = true;
          } catch {}
        }
        await this.stop({ graceMs: 0, forceMs: 1000 });
      } else {
        // A native exception can occur after fork but before the API returns an
        // identity. Neither an unknown pid nor absence of a return value proves
        // no child exists; keep cleanup unconfirmed instead of inventing closure.
        this.#change({ stopRequested: true });
        this.#writeStop.abort(
          new AgentError(
            "process_stopping",
            "The PTY start outcome is unconfirmed.",
          ),
        );
      }
      throw this.#failure;
    }
  }
  async #consume(reader: ReadStream, closed: Promise<void>): Promise<void> {
    let eof = false;
    try {
      for await (const value of reader) {
        const bytes = value as Buffer;
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          if (this.#failure) break;
          try {
            await this.#options.onOutput(
              "terminal",
              Buffer.from(
                bytes.subarray(
                  offset,
                  Math.min(bytes.length, offset + 64 * 1024),
                ),
              ),
            );
          } catch (cause) {
            this.#fail(
              new AgentError(
                "process_output_failed",
                "The PTY output consumer failed.",
                undefined,
                { cause },
              ),
            );
          }
        }
      }
      eof = true;
    } catch (cause) {
      // POSIX PTY masters report either EOF or EIO when the slave is hung up.
      // Other read errors are not upgraded to a successful complete output.
      if ((cause as NodeJS.ErrnoException).code === "EIO") eof = true;
      else
        this.#fail(
          new AgentError(
            "process_output_failed",
            "The PTY output stream failed before EOF.",
            undefined,
            { cause },
          ),
        );
    } finally {
      await closed;
      this.#writeStop.abort(
        new AgentError(
          "process_input_closed",
          "The PTY output descriptor is closed.",
        ),
      );
      this.#outputDone = eof;
      this.#change();
      this.#observeGroup();
      this.#closeIfReady();
    }
  }
  #observeGroup(): void {
    if (!this.#rootDone || this.#facts.treeStopped) return;
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
      if (code !== "EPERM")
        this.#failure ??= new AgentError(
          "process_tree_unconfirmed",
          "The original PTY group could not be observed.",
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
    if (this.#facts.outputComplete !== this.#outputDone)
      this.#change({ outputComplete: this.#outputDone });
    if (
      !this.#rootDone ||
      !this.#outputDone ||
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
      "The requested signal is unavailable on this platform.",
    );
    if (this.#group === null || this.#facts.closed || this.#facts.treeStopped)
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
        "The signal could not be delivered to the original PTY group.",
        { requested: signal },
        { cause },
      );
    }
  }
  signal(signal: NodeJS.Signals): ProcessSignalReceipt {
    requireCondition(
      this.#attempted || this.#facts.closed,
      "process_not_started",
      "The cold PTY has not started.",
    );
    return this.#send(signal);
  }
  resize(cols: number, rows: number): void {
    geometry(cols, rows);
    requireCondition(
      this.#fd !== null &&
        !this.#reader?.destroyed &&
        !this.#facts.closed &&
        !this.#facts.stopRequested,
      "process_input_closed",
      "The original PTY is not available for resizing.",
    );
    try {
      native().api.resize(this.#fd, cols, rows, 0, 0);
    } catch (cause) {
      throw new AgentError(
        "process_resize_failed",
        "The original terminal could not be resized.",
        undefined,
        { cause },
      );
    }
  }
  write(data: Uint8Array, eof: boolean, signal: AbortSignal): Promise<void> {
    requireCondition(
      eof === false,
      "process_tty_eof_unsupported",
      "Pipe EOF is not a terminal EOF; send explicit terminal input when appropriate.",
    );
    requireCondition(
      !types.isProxy(data) && types.isUint8Array(data),
      "invalid_process_input",
      "PTY input must be native bytes.",
    );
    signal.throwIfAborted();
    this.#writeStop.signal.throwIfAborted();
    requireCondition(
      this.#fd !== null &&
        this.#reader &&
        !this.#reader.destroyed &&
        !this.#facts.closed &&
        !this.#facts.stopRequested,
      "process_input_closed",
      "The original PTY no longer accepts input.",
    );
    const length = Reflect.apply(lengthOf, data, []) as number;
    if (length === 0) return Promise.resolve();
    requireCondition(
      length <= maxInputQueue &&
        this.#queuedInput + length <= maxInputQueue &&
        this.#writesPending < maxInputJobs,
      "process_input_busy",
      "The PTY input queue has no capacity for this write.",
    );
    const buffer = Reflect.apply(bufferOf, data, []) as ArrayBuffer;
    requireCondition(
      !types.isSharedArrayBuffer(buffer),
      "invalid_process_input",
      "Shared input bytes must be fixed before writing.",
    );
    const bytes = Buffer.from(
      new Uint8Array(
        buffer,
        Reflect.apply(offsetOf, data, []) as number,
        length,
      ),
    );
    const combined = AbortSignal.any([signal, this.#writeStop.signal]);
    const completion = Promise.withResolvers<void>();
    const job: WriteJob = {
      bytes,
      length,
      signal: combined,
      resolve: completion.resolve,
      reject: completion.reject,
      started: false,
      abort: () => {},
    };
    job.abort = () => {
      if (job.started) return; // The active syscall loop acknowledges real stop.
      const index = this.#writeQueue.indexOf(job);
      if (index < 0) return;
      this.#writeQueue.splice(index, 1);
      this.#finishWrite(job);
      job.reject(combined.reason);
    };
    this.#queuedInput += length;
    this.#writesPending++;
    this.#writeQueue.push(job);
    combined.addEventListener("abort", job.abort, { once: true });
    if (combined.aborted) job.abort();
    void this.#drainWrites();
    return completion.promise;
  }
  #finishWrite(job: WriteJob): void {
    job.signal.removeEventListener("abort", job.abort);
    job.bytes = null;
    this.#queuedInput -= job.length;
    this.#writesPending--;
    this.#closeIfReady();
  }
  async #drainWrites(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#writeQueue.length) {
        const job = this.#writeQueue.shift()!;
        job.started = true;
        try {
          await this.#writeOne(job);
          job.resolve();
        } catch (cause) {
          job.reject(cause);
        } finally {
          this.#finishWrite(job);
        }
      }
    } finally {
      this.#draining = false;
    }
  }
  async #writeOne(job: WriteJob): Promise<void> {
    const bytes = job.bytes!;
    for (let position = 0; position < bytes.length;) {
      job.signal.throwIfAborted();
      requireCondition(
        this.#fd !== null &&
          this.#reader &&
          !this.#reader.destroyed &&
          !this.#facts.closed &&
          !this.#facts.stopRequested,
        "process_input_closed",
        "The original PTY no longer accepts input.",
      );
      try {
        // This native master is O_NONBLOCK. No numeric-fd write remains queued
        // in a thread pool while the read side can close/reuse that descriptor.
        const count = writeSync(
          this.#fd,
          bytes,
          position,
          Math.min(64 * 1024, bytes.length - position),
        );
        requireCondition(
          count > 0,
          "process_input_failed",
          "The PTY write made no progress.",
        );
        position += count;
      } catch (cause) {
        if (
          !["EAGAIN", "EWOULDBLOCK"].includes(
            (cause as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw new AgentError(
            "process_input_failed",
            "The native PTY input write failed.",
            { writtenBytes: position },
            { cause },
          );
      }
      await setImmediate(undefined, { signal: job.signal });
    }
    job.signal.throwIfAborted();
  }
  #waitClosed(ms: number): Promise<boolean> {
    if (this.#facts.closed || ms === 0)
      return Promise.resolve(this.#facts.closed);
    const completion = Promise.withResolvers<boolean>();
    const changed = () => {
      if (this.#facts.closed) finish(true);
    };
    const finish = (value: boolean) => {
      clearTimeout(timer);
      this.off("change", changed);
      completion.resolve(value);
    };
    const timer = setTimeout(() => finish(this.#facts.closed), ms);
    this.on("change", changed);
    changed();
    return completion.promise;
  }
  stop(options: ProcessStopOptions = {}): Promise<ProcessStopReceipt> {
    const graceMs = options.graceMs ?? 1000,
      forceMs = options.forceMs ?? 1000;
    requireCondition(
      [graceMs, forceMs].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= 30000,
      ),
      "invalid_process_stop",
      "PTY stop observations must be nonnegative and bounded.",
    );
    if (this.#stopTask) return this.#stopTask;
    const completion = Promise.withResolvers<ProcessStopReceipt>();
    const task = completion.promise;
    this.#stopTask = task;
    if (!this.#facts.stopRequested) {
      this.#change({ stopRequested: true });
      this.#writeStop.abort(
        new AgentError("process_stopping", "The PTY is stopping."),
      );
    }
    if (!this.#attempted) {
      this.#rootDone = this.#outputDone = true;
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
        "The original terminal, process group and consumers have not actually closed.",
      );
    });
    this.#disposeTask = task;
    void task.catch(() => {
      if (this.#disposeTask === task) this.#disposeTask = undefined;
    });
    return task;
  }
}
function geometry(cols: number, rows: number): void {
  requireCondition(
    [cols, rows].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 65535,
    ),
    "invalid_process_geometry",
    "Terminal dimensions must fit positive native rows and columns.",
  );
}
