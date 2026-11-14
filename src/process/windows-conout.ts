/**
 * Adapted from node-pty@1.2.0-beta.18's windowsConoutConnection.js.
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 * Copyright (c) 2018 - present Microsoft Corporation. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { AgentError, requireCondition } from "../contracts/errors.js";

interface ListenerDisposable {
  dispose(): void;
}

export interface RawConoutExit {
  readonly exitCode: number;
  readonly disposed: boolean;
  /** The native conout pipe actually emitted EOF, rather than being terminated. */
  readonly ended: boolean;
}

export interface RawConoutConnection {
  readonly closed: Promise<RawConoutExit>;
  onReady(listener: () => void): ListenerDisposable;
  onError(listener: (error: Error) => void): ListenerDisposable;
  connectSocket(socket: Socket): void;
  /** Explicit cleanup; not an output-drained or successful-EOF assertion. */
  dispose(): void;
}

/**
 * Compatibility factory for the pinned node-pty WindowsPtyAgent options.
 * Keep this controller Host-private. The helper reverses latin1 with
 * Buffer.from(data, 'latin1') before byte accounting/IPC/output persistence.
 */
export function createRawConoutConnection(
  conoutPipeName: string,
  useConptyDll: boolean,
): RawConoutConnection {
  requireCondition(
    process.platform === "win32",
    "windows_conout_unsupported",
    "Windows ConPTY output connections are available only on Windows.",
  );
  requireCondition(
    typeof conoutPipeName === "string" &&
      conoutPipeName.length > 0 &&
      conoutPipeName.length <= 32768 &&
      !conoutPipeName.includes("\0"),
    "windows_conout_invalid_pipe",
    "A bounded native ConPTY output pipe name is required.",
  );
  // Both native ConPTY implementations use the same raw transport and actual
  // EOF contract. There is deliberately no idle/flush timeout for either one.
  void useConptyDll;
  let worker: Worker;
  try {
    worker = new Worker(
      new URL("./windows-conout-worker.js", import.meta.url),
      {
        workerData: { conoutPipeName },
        execArgv: [],
      },
    );
  } catch {
    throw new AgentError(
      "windows_conout_worker_unavailable",
      "The Windows ConPTY output worker could not be started.",
    );
  }
  const readyListeners = new Set<() => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const completion = Promise.withResolvers<RawConoutExit>();
  let ready = false;
  let ended = false;
  let disposed = false;
  let exited = false;
  let connected = false;
  let firstError: AgentError | undefined;

  function report(error: AgentError, cleanupFailure = false): void {
    if ((disposed && !cleanupFailure) || firstError) return;
    firstError = error;
    for (const listener of [...errorListeners]) listener(error);
  }

  worker.on("message", (message: unknown) => {
    if (disposed || exited) return;
    if (message === "ready") {
      if (ready) return;
      ready = true;
      for (const listener of [...readyListeners]) listener();
    } else if (message === "end") {
      ended = true;
    } else if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "error"
    ) {
      const code =
        "code" in message &&
        typeof message.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(message.code)
          ? message.code
          : "UNKNOWN";
      report(
        new AgentError(
          "windows_conout_pipe_failed",
          "The Windows ConPTY output pipe failed.",
          { code },
        ),
      );
    } else {
      report(
        new AgentError(
          "windows_conout_invalid_message",
          "The Windows ConPTY output worker sent an invalid control message.",
        ),
      );
    }
  });
  worker.on("error", () => {
    report(
      new AgentError(
        "windows_conout_worker_failed",
        "The Windows ConPTY output worker failed.",
      ),
    );
  });
  worker.once("exit", (exitCode) => {
    exited = true;
    if (!disposed && (!ended || exitCode !== 0)) {
      report(
        new AgentError(
          "windows_conout_worker_exited",
          "The Windows ConPTY output worker exited before a clean output close.",
          { exitCode },
        ),
      );
    }
    completion.resolve(Object.freeze({ exitCode, disposed, ended }));
    readyListeners.clear();
    errorListeners.clear();
  });

  return Object.freeze({
    closed: completion.promise,
    onReady(listener: () => void): ListenerDisposable {
      if (!disposed && !exited) {
        readyListeners.add(listener);
        if (ready)
          queueMicrotask(() => {
            if (!disposed && !exited && readyListeners.has(listener))
              listener();
          });
      }
      return {
        dispose: () => {
          readyListeners.delete(listener);
        },
      };
    },
    onError(listener: (error: Error) => void): ListenerDisposable {
      if (!disposed && !exited) errorListeners.add(listener);
      if (!disposed && firstError) {
        const error = firstError;
        errorListeners.add(listener);
        queueMicrotask(() => {
          if (!disposed && errorListeners.has(listener)) listener(error);
          if (exited) errorListeners.delete(listener);
        });
      }
      return {
        dispose: () => {
          errorListeners.delete(listener);
        },
      };
    },
    connectSocket(socket: Socket): void {
      requireCondition(
        ready && !disposed && !exited && !connected && !firstError,
        "windows_conout_not_ready",
        "The Windows ConPTY output connection is not available for connection.",
      );
      // WindowsPtyAgent preselects utf8. Replace it through Node's public API
      // before any data arrives; latin1 maps each byte to one code unit exactly.
      socket.setEncoding("latin1");
      socket.connect(`${conoutPipeName}-worker`);
      connected = true;
    },
    dispose(): void {
      if (disposed || exited) return;
      disposed = true;
      readyListeners.clear();
      // Observe the real 'exit' event, including explicit termination. Never
      // resolve closed merely because terminate() was requested.
      void worker.terminate().catch(() => {
        report(
          new AgentError(
            "windows_conout_cleanup_failed",
            "The Windows ConPTY output worker could not be terminated.",
          ),
          true,
        );
      });
    },
  });
}
