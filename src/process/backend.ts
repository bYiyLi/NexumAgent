import type { EventEmitter } from "node:events";
import type { ManagedResource } from "../extensions/resources.js";

export type ProcessStream = "stdout" | "stderr" | "terminal";
export interface ProcessLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly tty: boolean;
  readonly cols: number;
  readonly rows: number;
}
export interface ProcessFacts {
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly rootExited: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly outputComplete: boolean;
  readonly treeStopped: boolean;
  readonly closed: boolean;
  readonly stopRequested: boolean;
  readonly forceRequested: boolean;
}
export interface ProcessSignalReceipt {
  readonly requested: string;
  readonly delivered: boolean;
  readonly mechanism: "process-group" | "job-object" | "terminal-input";
}
export interface ProcessStopOptions {
  readonly graceMs?: number;
  readonly forceMs?: number;
}
export interface ProcessStopReceipt {
  readonly confirmed: boolean;
  readonly facts: ProcessFacts;
}
export interface ProcessBackendOptions {
  /** Awaited before resuming source streams; output consumers own disk budgets. */
  readonly onOutput: (stream: ProcessStream, bytes: Buffer) => Promise<void>;
}

/** Host-private cold native controller. Never passes through script results. */
export interface ProcessBackend extends EventEmitter, ManagedResource {
  readonly failure: unknown;
  facts(): ProcessFacts;
  /** Must follow successful public resource registration. */
  start(launch: ProcessLaunch): Promise<void>;
  write(data: Uint8Array, eof: boolean, signal: AbortSignal): Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  signal(
    signal: NodeJS.Signals,
  ): ProcessSignalReceipt | Promise<ProcessSignalReceipt>;
  stop(options?: ProcessStopOptions): Promise<ProcessStopReceipt>;
}
