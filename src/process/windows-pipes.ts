import { EventEmitter } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { WindowsJob } from "./windows-job.js";
import type {
  ProcessBackend,
  ProcessBackendOptions,
  ProcessFacts,
  ProcessLaunch,
  ProcessSignalReceipt,
  ProcessStopOptions,
  ProcessStopReceipt,
  ProcessStream,
} from "./backend.js";
import type {
  WindowsHelperMessage,
  WindowsParentMessage,
} from "./windows-helper.js";

const trustedExecPath = process.execPath;
const helperUrl = new URL("./windows-helper.js", import.meta.url);
const helperVariables = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);
function helperEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && helperVariables.has(key.toUpperCase()))
      env[key] = value;
  return env;
}
function boundedTime(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  requireCondition(
    Number.isInteger(result) && result >= 0 && result <= 60000,
    "invalid_process_stop_timeout",
    "Process stop intervals must be integers from 0 through 60000 milliseconds.",
  );
  return result;
}

/** Cold, host-private Windows launcher. Public resource registration precedes start. */
export class WindowsProcessBackend
  extends EventEmitter
  implements ProcessBackend
{
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;
  readonly #options: ProcessBackendOptions;
  #failure: unknown;
  #state: ProcessFacts = {
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
  #started = false;
  #launch: ProcessLaunch | undefined;
  #helper: ChildProcess | undefined;
  #job: WindowsJob | undefined;
  #assigned = false;
  #helperClosed = false;
  #outputSettled = false;
  #outputFailed = false;
  #terminalComplete = false;
  #terminalClosed = false;
  #finishing = false;
  #poll: ReturnType<typeof setInterval> | undefined;
  #startResult = Promise.withResolvers<void>();
  #startTimer: ReturnType<typeof setTimeout> | undefined;
  #stopResult: Promise<ProcessStopReceipt> | undefined;
  #inputTail = Promise.resolve();
  #inputEof = false;
  #controlId = 0;
  #controls = new Map<
    number,
    {
      resolve: () => void;
      reject: (error: unknown) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: ProcessBackendOptions) {
    super();
    this.#options = options;
    const closed = Promise.withResolvers<void>();
    this.closed = closed.promise;
    this.#resolveClosed = closed.resolve;
    void this.#startResult.promise.catch(() => {});
  }

  get failure(): unknown {
    return this.#failure;
  }
  facts(): ProcessFacts {
    return Object.freeze({ ...this.#state });
  }
  #change(update: Partial<ProcessFacts> = {}): void {
    this.#state = { ...this.#state, ...update };
    this.emit("change", this.facts());
  }
  #recordFailure(code: string, message: string, cause?: unknown): AgentError {
    const error = new AgentError(code, message, undefined, { cause });
    this.#failure ??= isAgentError(cause) ? cause : error;
    this.#startResult.reject(this.#failure);
    this.#change();
    return error;
  }
  #send(message: WindowsParentMessage): void {
    const child = this.#helper;
    requireCondition(
      child?.connected,
      "windows_helper_disconnected",
      "The managed Windows helper is disconnected.",
    );
    child.send(message, (error) => {
      if (error && !this.#state.closed) {
        this.#recordFailure(
          "windows_helper_ipc_failed",
          "The managed Windows helper channel failed.",
          error,
        );
        this.#force();
      }
    });
  }

  async start(launch: ProcessLaunch): Promise<void> {
    requireCondition(
      !this.#started && !this.#state.closed,
      "process_already_started",
      "The process backend has already started or closed.",
    );
    this.#started = true;
    try {
      requireCondition(
        process.platform === "win32",
        "windows_process_unsupported",
        "The Windows process backend is available only on Windows.",
      );
      requireCondition(
        !/\.(?:cmd|bat)$/i.test(launch.file),
        "windows_batch_direct_unsupported",
        "Windows batch files require an explicit command shell.",
      );
      requireCondition(
        path.isAbsolute(launch.file) && path.isAbsolute(launch.cwd),
        "invalid_process_launch",
        "The executable and working directory must be absolute paths.",
      );
      this.#launch = launch;
      this.#job = WindowsJob.create();
      this.#helper = fork(helperUrl, [], {
        execPath: trustedExecPath,
        execArgv: [],
        cwd: path.dirname(fileURLToPath(helperUrl)),
        env: helperEnvironment(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "advanced",
        windowsHide: true,
      });
      const child = this.#helper;
      child.on("message", (message: WindowsHelperMessage) =>
        this.#message(message),
      );
      child.once("error", (error) => {
        this.#recordFailure(
          "windows_helper_spawn_failed",
          "The managed Windows helper could not start.",
          error,
        );
        this.#force();
      });
      child.once("exit", (exitCode) => {
        if (this.#state.pid === null && !this.#failure)
          this.#recordFailure(
            "windows_helper_exited",
            "The Windows helper exited before the business process started.",
          );
        else if (
          !this.#state.forceRequested &&
          (!this.#finishing || exitCode !== 0)
        ) {
          this.#outputFailed = true;
          this.#recordFailure(
            "windows_helper_unexpected_exit",
            "The Windows helper exited without completing the managed output shutdown.",
          );
        }
        if (!this.#finishing) this.#force();
      });
      child.once("close", () => {
        this.#helperClosed = true;
        this.#tick();
      });
      const output = Promise.all([
        this.#read(child.stdout!, launch.tty ? "terminal" : "stdout"),
        this.#read(child.stderr!, launch.tty ? "terminal" : "stderr"),
      ]);
      void output.finally(() => {
        this.#outputSettled = true;
        this.#tick();
      });
      this.#poll = setInterval(() => this.#tick(), 20);
      this.#startTimer = setTimeout(() => {
        this.#recordFailure(
          "windows_process_start_timeout",
          "The Windows business process start was not confirmed in time.",
        );
        this.#force();
      }, 20000);
      await this.#startResult.promise;
    } catch (error) {
      this.#failure ??= error;
      this.#startResult.reject(error);
      if (this.#helper) this.#force();
      else {
        this.#job?.close();
        this.#change({ outputComplete: true, treeStopped: true, closed: true });
        this.#resolveClosed();
      }
      throw error;
    }
  }

  #message(message: WindowsHelperMessage): void {
    try {
      if (message?.type === "ready") {
        requireCondition(
          !this.#assigned && this.#job && this.#helper,
          "windows_helper_invalid_handshake",
          "The Windows helper handshake is invalid.",
        );
        this.#job.assignChild(this.#helper, message.birth);
        this.#assigned = true;
        if (this.#state.stopRequested) this.#force();
        else this.#send({ type: "start", launch: this.#launch! });
      } else if (message?.type === "started") {
        requireCondition(
          this.#assigned && Number.isInteger(message.pid) && message.pid > 0,
          "windows_helper_invalid_start",
          "The Windows helper did not confirm a valid process start.",
        );
        clearTimeout(this.#startTimer);
        this.#change({ pid: message.pid, startedAt: message.startedAt });
        this.#startResult.resolve();
      } else if (message?.type === "root-exit") {
        this.#change({ rootExited: true, exitCode: message.exitCode });
      } else if (message?.type === "terminal-closed") {
        this.#terminalClosed = true;
        this.#terminalComplete = message.complete;
        if (!message.complete)
          this.#recordFailure(
            "windows_pty_output_incomplete",
            "The Windows terminal closed without a complete output EOF.",
          );
      } else if (message?.type === "input-closed") {
        this.#inputEof = true;
      } else if (message?.type === "failed") {
        this.#recordFailure(
          message.code,
          "The managed Windows business process failed.",
          new AgentError(
            message.code,
            "The managed Windows business process failed.",
            message.systemCode === undefined
              ? undefined
              : { systemCode: message.systemCode },
          ),
        );
        this.#force();
      } else if (message?.type === "ack") {
        const control = this.#controls.get(message.id);
        if (control) {
          this.#controls.delete(message.id);
          clearTimeout(control.timer);
          if (message.ok) control.resolve();
          else
            control.reject(
              new AgentError(
                message.code ?? "windows_pty_control_failed",
                "The Windows terminal control operation failed.",
              ),
            );
        }
      }
      this.#tick();
    } catch (error) {
      this.#recordFailure(
        "windows_helper_protocol_failed",
        "The Windows helper handshake or control protocol failed.",
        error,
      );
      this.#force();
    }
  }

  async #read(stream: Readable, kind: ProcessStream): Promise<void> {
    try {
      for await (const chunk of stream) {
        if (this.#outputFailed) continue;
        try {
          await this.#options.onOutput(kind, Buffer.from(chunk));
        } catch (error) {
          this.#outputFailed = true;
          this.#recordFailure(
            "process_output_failed",
            "The managed process output consumer failed.",
            error,
          );
          this.#force();
        }
      }
    } catch (error) {
      this.#outputFailed = true;
      this.#recordFailure(
        "process_output_failed",
        "The managed process output stream failed.",
        error,
      );
      this.#force();
    }
  }

  #force(): void {
    if (this.#state.closed) return;
    this.#change({ forceRequested: true });
    try {
      if (this.#assigned) this.#job!.terminate(1);
      else if (
        this.#helper &&
        this.#helper.exitCode === null &&
        this.#helper.signalCode === null
      )
        this.#helper.kill(); // Only our privately retained, not-yet-assigned helper.
    } catch (error) {
      this.#failure ??= isAgentError(error)
        ? error
        : new AgentError(
            "windows_process_stop_failed",
            "The Windows process tree stop could not be delivered.",
            undefined,
            { cause: error },
          );
      this.#change();
    }
  }

  #tick(): void {
    if (this.#state.closed || !this.#job) return;
    try {
      const active = this.#job.queryAccounting().activeProcesses;
      if (
        this.#assigned &&
        this.#state.pid !== null &&
        !this.#finishing &&
        this.#state.rootExited &&
        active === 1 &&
        (!this.#launch!.tty || this.#terminalClosed)
      ) {
        this.#finishing = true;
        this.#send({ type: "finish" });
      }
      if (active === 0 && this.#helperClosed && !this.#state.treeStopped)
        this.#change({
          treeStopped: true,
          rootExited: this.#state.pid !== null || this.#state.rootExited,
        });
      if (active !== 0 || !this.#helperClosed || !this.#outputSettled) return;
      if (
        this.#state.forceRequested &&
        this.#launch?.tty &&
        !this.#terminalComplete
      ) {
        // The Job and both helper streams have physically closed. Forced
        // helper termination can lose the ConPTY tail: that is a known output
        // failure, not an indefinitely unknown process lifetime or a fake EOF.
        this.#outputFailed = true;
        this.#failure ??= new AgentError(
          "process_output_failed",
          "The forced Windows terminal shutdown could not retain a complete output tail.",
        );
      }
      this.#job.close();
      clearInterval(this.#poll);
      clearTimeout(this.#startTimer);
      for (const control of this.#controls.values()) {
        clearTimeout(control.timer);
        control.reject(
          new AgentError("process_closed", "The managed process has closed."),
        );
      }
      this.#controls.clear();
      this.#change({
        rootExited: this.#state.pid !== null || this.#state.rootExited,
        treeStopped: true,
        outputComplete:
          !this.#outputFailed && (!this.#launch?.tty || this.#terminalComplete),
        closed: true,
      });
      this.#startResult.reject(
        this.#failure ??
          new AgentError(
            "process_closed",
            "The managed process closed before start completed.",
          ),
      );
      this.#resolveClosed();
    } catch (error) {
      this.#failure ??= isAgentError(error)
        ? error
        : new AgentError(
            "windows_job_query_failed",
            "The actual Windows Job state could not be confirmed.",
            undefined,
            { cause: error },
          );
      this.#change();
    }
  }

  async write(
    data: Uint8Array,
    eof: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    requireCondition(
      !(this.#launch?.tty && eof),
      "pty_eof_unsupported",
      "A terminal does not support pipe EOF; use terminal input or stop.",
    );
    const bytes = Buffer.from(data);
    const operation = this.#inputTail.then(async () => {
      signal.throwIfAborted();
      requireCondition(
        this.#state.pid !== null &&
          !this.#state.rootExited &&
          !this.#state.closed &&
          !this.#inputEof,
        "process_input_closed",
        "The managed process input is unavailable or closed.",
      );
      // At most one 64KiB input frame awaits the actual business sink callback.
      // An aborted caller stops waiting but does not release this internal queue
      // until the already-sent frame settles, preventing unbounded IPC buildup.
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        signal.throwIfAborted();
        await this.#input(bytes.subarray(offset, offset + 64 * 1024), false);
      }
      if (eof) {
        signal.throwIfAborted();
        this.#inputEof = true;
        await this.#input(Buffer.alloc(0), true);
      }
    });
    this.#inputTail = operation.catch(() => {});
    return this.#abortable(operation, signal);
  }

  #input(data: Buffer, eof: boolean): Promise<void> {
    const id = ++this.#controlId;
    return new Promise((resolve, reject) => {
      this.#controls.set(id, { resolve, reject });
      try {
        this.#send({ type: "input", id, data, eof });
      } catch (error) {
        this.#controls.delete(id);
        reject(error);
      }
    });
  }

  #abortable(operation: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      void operation.then(
        () => {
          signal.removeEventListener("abort", aborted);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  }

  #control(
    action: "resize" | "interrupt",
    cols?: number,
    rows?: number,
  ): Promise<void> {
    requireCondition(
      this.#launch?.tty &&
        this.#state.pid !== null &&
        !this.#state.rootExited &&
        !this.#state.closed,
      "process_terminal_unavailable",
      "A live managed terminal is required for this operation.",
    );
    const id = ++this.#controlId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#controls.delete(id);
        reject(
          new AgentError(
            "windows_pty_control_timeout",
            "The terminal control operation was not confirmed in time.",
          ),
        );
      }, 5000);
      this.#controls.set(id, { resolve, reject, timer });
      try {
        this.#send({
          type: "control",
          id,
          action,
          ...(cols === undefined ? {} : { cols, rows }),
        });
      } catch (error) {
        clearTimeout(timer);
        this.#controls.delete(id);
        reject(error);
      }
    });
  }

  async resize(cols: number, rows: number): Promise<void> {
    requireCondition(
      Number.isInteger(cols) &&
        cols > 0 &&
        cols <= 10000 &&
        Number.isInteger(rows) &&
        rows > 0 &&
        rows <= 10000,
      "invalid_terminal_size",
      "Terminal columns and rows must be positive bounded integers.",
    );
    await this.#control("resize", cols, rows);
  }

  async signal(signal: NodeJS.Signals): Promise<ProcessSignalReceipt> {
    requireCondition(
      this.#state.pid !== null && !this.#state.closed,
      "process_closed",
      "The managed process is unavailable or closed.",
    );
    if (signal === "SIGKILL") {
      this.#job!.terminate(1);
      this.#change({ forceRequested: true });
      return { requested: signal, delivered: true, mechanism: "job-object" };
    }
    if (signal === "SIGINT" && this.#launch?.tty) {
      await this.#control("interrupt");
      return {
        requested: signal,
        delivered: true,
        mechanism: "terminal-input",
      };
    }
    throw new AgentError(
      "process_signal_unsupported",
      "This Windows signal cannot be delivered through the managed backend.",
    );
  }

  async #waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.#state.closed) return true;
    const controller = new AbortController();
    const timeout = delay(timeoutMs, false, { signal: controller.signal });
    try {
      return await Promise.race([this.closed.then(() => true), timeout]);
    } finally {
      controller.abort();
    }
  }

  async stop(options: ProcessStopOptions = {}): Promise<ProcessStopReceipt> {
    const graceMs = boundedTime(options.graceMs, 1000);
    const forceMs = boundedTime(options.forceMs, 5000);
    if (this.#state.closed) return { confirmed: true, facts: this.facts() };
    if (this.#stopResult) return this.#stopResult;
    this.#stopResult = (async () => {
      this.#change({ stopRequested: true });
      if (!this.#started) {
        this.#change({ outputComplete: true, treeStopped: true, closed: true });
        this.#resolveClosed();
        return { confirmed: true, facts: this.facts() };
      }
      if (this.#state.pid !== null && !this.#state.rootExited && graceMs > 0) {
        if (this.#launch?.tty) {
          void this.#control("interrupt").catch(() => {});
        } else if (!this.#inputEof)
          void this.write(
            Buffer.alloc(0),
            true,
            new AbortController().signal,
          ).catch(() => {});
      }
      if (!(await this.#waitClosed(graceMs))) this.#force();
      const confirmed = await this.#waitClosed(forceMs);
      return { confirmed, facts: this.facts() };
    })();
    try {
      return await this.#stopResult;
    } finally {
      this.#stopResult = undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
