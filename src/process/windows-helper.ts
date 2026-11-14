import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { Socket } from "node:net";
import type { ProcessLaunch } from "./backend.js";
import { getCurrentProcessBirthIdentity } from "./windows-job.js";
import { createRawConoutConnection } from "./windows-conout.js";

export type WindowsParentMessage =
  | { readonly type: "start"; readonly launch: ProcessLaunch }
  | { readonly type: "finish" }
  | {
      readonly type: "input";
      readonly id: number;
      readonly data: Uint8Array;
      readonly eof: boolean;
    }
  | {
      readonly type: "control";
      readonly id: number;
      readonly action: "resize" | "interrupt";
      readonly cols?: number;
      readonly rows?: number;
    };
export type WindowsHelperMessage =
  | { readonly type: "ready"; readonly birth: string }
  | {
      readonly type: "started";
      readonly pid: number;
      readonly startedAt: number;
    }
  | { readonly type: "root-exit"; readonly exitCode: number | null }
  | { readonly type: "terminal-closed"; readonly complete: boolean }
  | { readonly type: "input-closed" }
  | {
      readonly type: "failed";
      readonly code: string;
      readonly systemCode?: string;
    }
  | {
      readonly type: "ack";
      readonly id: number;
      readonly ok: boolean;
      readonly code?: string;
    };

// This is a fixed, privately forked module. Its own startup environment/execArgv
// never contain business preloads, and business children receive no IPC channel.
function send(message: WindowsHelperMessage): void {
  if (!process.connected || !process.send) process.exit(1);
  process.send(message, (error) => {
    if (error) process.exit(1);
  });
}
function fail(code: string, cause?: unknown): void {
  let value =
    cause instanceof Error
      ? Object.getOwnPropertyDescriptor(cause, "code")?.value
      : undefined;
  if (value === undefined && cause instanceof Error) {
    const match = /error code: ([0-9]{1,10})(?:\D|$)/.exec(cause.message);
    if (match && Number(match[1]) <= 0xffffffff) value = `WIN32_${match[1]}`;
  }
  send({
    type: "failed",
    code,
    ...(typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value)
      ? { systemCode: value }
      : {}),
  });
}
function businessEnvironment(
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      /^_?NEXUM(?:_|$)/i.test(key) ||
      /^(?:NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|NODE_UNIQUE_ID|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE)$/i.test(
        key,
      )
    )
      continue;
    result[key] = value;
  }
  // NODE_OPTIONS/NODE_PATH belong to business Node, never to this helper.
  return result;
}

interface FixedWindowsPtyAgent {
  readonly innerPid: number;
  readonly inSocket: Socket;
  readonly outSocket: Socket;
  onError(listener: (error: Error) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  _$onProcessExit(exitCode: number): void;
}

async function main(): Promise<void> {
  if (process.platform !== "win32" || !process.send || !process.connected)
    process.exit(1);
  let started = false;
  let child: ChildProcess | undefined;
  let terminal: FixedWindowsPtyAgent | undefined;
  let controlTail = Promise.resolve();
  let inputTail = Promise.resolve();
  let finishing = false;
  let businessStarted = false;
  const handshakeTimer = setTimeout(() => process.exit(1), 20000);
  process.on("disconnect", () => process.exit(0));
  process.stdin.on("error", () => {});
  process.stdout.on("error", () => process.exit(1));
  process.stderr.on("error", () => process.exit(1));
  const finish = async (): Promise<void> => {
    if (finishing) return;
    finishing = true;
    await Promise.all([
      new Promise<void>((resolve) => process.stdout.end(resolve)),
      new Promise<void>((resolve) => process.stderr.end(resolve)),
    ]);
    // The parent permits this only after Job accounting proves that no business
    // process remains. Exit also releases node-pty's idle worker/server handles.
    process.exit(0);
  };
  const launch = async (input: ProcessLaunch): Promise<void> => {
    const env = businessEnvironment(input.env);
    if (!input.tty) {
      child = spawn(input.file, [...input.args], {
        cwd: input.cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        // Output is the parent's original OS pipe, without another JS buffer.
        // Descendants retain that same pipe; root exit is never treated as EOF.
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.once("error", (error) =>
        fail("windows_process_spawn_failed", error),
      );
      child.once("spawn", () => {
        businessStarted = true;
        child!.stdin!.on("error", () => send({ type: "input-closed" }));
        child!.stdin!.once("close", () => send({ type: "input-closed" }));
        send({ type: "started", pid: child!.pid!, startedAt: Date.now() });
      });
      child.once("exit", (exitCode) => send({ type: "root-exit", exitCode }));
      return;
    }

    const require = createRequire(import.meta.url);
    const version = require("node-pty/package.json") as { version?: string };
    if (version.version !== "1.2.0-beta.18") {
      fail("windows_pty_version_unsupported");
      return;
    }
    const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
    const { WindowsPtyAgent } = require(
      path.join(packageRoot, "lib/windowsPtyAgent.js"),
    ) as {
      WindowsPtyAgent: new (
        file: string,
        args: string[],
        env: string[],
        cwd: string,
        cols: number,
        rows: number,
        debug: boolean,
        useDll: boolean,
        inheritCursor: boolean,
        options: {
          connectionTimeout: number;
          conoutConnectionFactory: typeof createRawConoutConnection;
        },
      ) => FixedWindowsPtyAgent;
    };
    // The public WindowsTerminal wrapper has no actual-ready event and defers
    // input until first output. Its default bridge irreversibly decodes UTF-8.
    // This exact-version adapter uses the shipped native Agent with a raw bridge.
    terminal = new WindowsPtyAgent(
      input.file,
      [...input.args],
      Object.entries(env).map(([key, value]) => `${key}=${value}`),
      input.cwd,
      input.cols,
      input.rows,
      false,
      true,
      false,
      {
        connectionTimeout: 15000,
        conoutConnectionFactory: (pipeName, useDll) => {
          const connection = createRawConoutConnection(pipeName, useDll);
          connection.onError((error) =>
            fail("windows_pty_output_failed", error),
          );
          return connection;
        },
      },
    );
    const agent = terminal;
    if (
      !agent ||
      typeof agent.resize !== "function" ||
      typeof agent._$onProcessExit !== "function" ||
      typeof agent.onError !== "function" ||
      !agent.inSocket ||
      typeof agent.inSocket.write !== "function" ||
      !agent.outSocket ||
      typeof agent.outSocket.pipe !== "function"
    ) {
      fail("windows_pty_adapter_unsupported");
      return;
    }
    agent.onError((error) => fail("windows_pty_spawn_failed", error));
    // useDll=true uses ConptyReleasePseudoConsole, not the system-ConPTY
    // one-second timer that destroys the socket after the root process exits.
    const originalExit = agent._$onProcessExit.bind(agent);
    agent._$onProcessExit = (exitCode) => {
      send({ type: "root-exit", exitCode });
      originalExit(exitCode);
    };
    // The raw worker keeps bytes intact. latin1 is a reversible one-byte view
    // on the Agent socket, avoiding Node-private decoder mutation or UTF-8 loss.
    agent.outSocket.on("data", (chunk: string | Buffer) => {
      const bytes =
        typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
      if (!process.stdout.write(bytes)) {
        agent.outSocket.pause();
        process.stdout.once("drain", () => agent.outSocket.resume());
      }
    });
    let terminalClosed = false;
    const closeTerminal = (complete: boolean): void => {
      if (terminalClosed) return;
      terminalClosed = true;
      send({ type: "terminal-closed", complete });
    };
    agent.outSocket.once("end", () => closeTerminal(true));
    agent.outSocket.once("close", () =>
      closeTerminal(agent.outSocket.readableEnded),
    );
    agent.outSocket.on("error", () => fail("windows_pty_output_failed"));
    agent.inSocket.on("error", () => send({ type: "input-closed" }));
    agent.inSocket.once("close", () => send({ type: "input-closed" }));
    const until = Date.now() + 15000;
    await new Promise<void>((resolve, reject) => {
      const poll = setInterval(() => {
        if (terminal!.innerPid > 0) {
          clearInterval(poll);
          resolve();
        } else if (terminalClosed || Date.now() >= until) {
          clearInterval(poll);
          reject(new Error("PTY start was not confirmed"));
        }
      }, 10);
    });
    businessStarted = true;
    send({ type: "started", pid: terminal.innerPid, startedAt: Date.now() });
  };
  process.on("message", (message: WindowsParentMessage) => {
    if (message?.type === "start") {
      if (started) {
        fail("windows_helper_duplicate_start");
        return;
      }
      started = true;
      clearTimeout(handshakeTimer);
      void launch(message.launch).catch((error) =>
        fail("windows_process_spawn_failed", error),
      );
    } else if (message?.type === "finish") {
      void finish().catch(() => process.exit(1));
    } else if (message?.type === "input") {
      inputTail = inputTail.then(async () => {
        try {
          const sink = terminal?.inSocket ?? child?.stdin;
          if (
            !businessStarted ||
            !sink ||
            sink.destroyed ||
            sink.writableEnded ||
            (terminal && message.eof) ||
            !(message.data instanceof Uint8Array) ||
            message.data.length > 64 * 1024
          )
            throw new Error("The business input is unavailable");
          if (message.data.length)
            await new Promise<void>((resolve, reject) => {
              sink.write(Buffer.from(message.data), (error) =>
                error ? reject(error) : resolve(),
              );
            });
          if (message.eof)
            await new Promise<void>((resolve, reject) => {
              sink.once("error", reject);
              sink.end(() => {
                sink.off("error", reject);
                resolve();
              });
            });
          send({ type: "ack", id: message.id, ok: true });
        } catch {
          send({
            type: "ack",
            id: message.id,
            ok: false,
            code: "process_input_closed",
          });
        }
      });
    } else if (message?.type === "control") {
      controlTail = controlTail.then(async () => {
        try {
          if (!terminal || !businessStarted)
            throw new Error("No live terminal");
          if (message.action === "resize") {
            terminal.resize(message.cols!, message.rows!);
          } else if (message.action === "interrupt") {
            await new Promise<void>((resolve, reject) => {
              terminal!.inSocket.write(Buffer.from([3]), (error) =>
                error ? reject(error) : resolve(),
              );
            });
          } else throw new Error("Unknown control");
          send({ type: "ack", id: message.id, ok: true });
        } catch {
          send({
            type: "ack",
            id: message.id,
            ok: false,
            code: "windows_pty_control_failed",
          });
        }
      });
    }
  });
  send({ type: "ready", birth: getCurrentProcessBirthIdentity() });
}

void main().catch(() => {
  if (process.connected && process.send)
    fail("windows_helper_initialization_failed");
  else process.exit(1);
});
