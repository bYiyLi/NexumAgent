import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { Profile } from "../contracts/types.js";
import { requireCondition } from "../contracts/errors.js";
import { privateDirectory } from "../runtime/paths.js";
import type { ConnectionDiagnosticDetails } from "./connection.js";

export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

function safeDiagnosticDetails(details?: ConnectionDiagnosticDetails): object {
  if (!details) return {};
  const reason = [
    "heartbeat_timeout",
    "socket_closed",
    "socket_error",
    "local_close",
  ].includes(details.reason ?? "")
    ? details.reason
    : undefined;
  const lastPingAt =
    details.lastPingAt === null
      ? null
      : typeof details.lastPingAt === "string" &&
          Number.isFinite(Date.parse(details.lastPingAt))
        ? new Date(details.lastPingAt).toISOString()
        : undefined;
  const safeNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const component = typeof details.component === "string" &&
    details.component.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(details.component)
    ? details.component : undefined;
  const phase = typeof details.phase === "string" &&
    /^[a-z][a-z0-9_]{0,60}$/.test(details.phase)
    ? details.phase : undefined;
  const failureCode = typeof details.failureCode === "string" &&
    /^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/.test(details.failureCode)
    ? details.failureCode : undefined;
  const activeVersion = typeof details.activeVersion === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(details.activeVersion)
    ? details.activeVersion : undefined;
  const runId = typeof details.runId === "string" &&
    /^run_[0-9a-f]{32}$/.test(details.runId)
    ? details.runId : undefined;
  const workerId = typeof details.workerId === "string" &&
    /^runworker_[0-9a-f]{32}$/.test(details.workerId)
    ? details.workerId : undefined;
  return {
    ...(component ? { component } : {}),
    ...(phase ? { phase } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(activeVersion ? { activeVersion } : {}),
    ...(runId ? { runId } : {}),
    ...(workerId ? { workerId } : {}),
    ...(safeNumber(details.threadId) ? { threadId: details.threadId } : {}),
    ...(safeNumber(details.durationMs) ? { durationMs: details.durationMs } : {}),
    ...(reason ? { reason } : {}),
    ...(lastPingAt !== undefined ? { lastPingAt } : {}),
    ...(safeNumber(details.closeCode) && details.closeCode <= 65535
      ? { closeCode: details.closeCode }
      : {}),
    ...(safeNumber(details.httpStatus) && details.httpStatus <= 599
      ? { httpStatus: details.httpStatus }
      : {}),
    ...(safeNumber(details.attempt) ? { attempt: details.attempt } : {}),
    ...(safeNumber(details.retryDelayMs)
      ? { retryDelayMs: details.retryDelayMs }
      : {}),
    ...(safeNumber(details.offlineMs) ? { offlineMs: details.offlineMs } : {}),
  };
}

/** Private, bounded control diagnostics. Native/plugin errors and payloads never enter this file. */
export function appendDiagnostic(
  root: string,
  profile: Profile,
  code: string,
  retry: boolean,
  details?: ConnectionDiagnosticDetails,
): void {
  const directory = privateDirectory(root, "logs");
  const filename = path.join(directory, "agent.log");
  const before = lstatSync(filename, { throwIfNoEntry: false });
  requireCondition(
    !before || (before.isFile() && before.nlink === 1),
    "agent_log_unavailable",
    "The diagnostic file is unavailable.",
  );
  const file = openSync(
    filename,
    constants.O_RDWR |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    const actual = fstatSync(file);
    const current = lstatSync(filename);
    requireCondition(
      actual.isFile() &&
        actual.nlink === 1 &&
        actual.dev === current.dev &&
        actual.ino === current.ino &&
        (!before || (actual.dev === before.dev && actual.ino === before.ino)) &&
        realpathSync.native(root) === root &&
        realpathSync.native(directory) === directory,
      "agent_log_unavailable",
      "The diagnostic file is unavailable.",
    );
    fchmodSync(file, 0o600);
    const entry = Buffer.from(
      JSON.stringify({
        time: new Date().toISOString(),
        profile,
        code: /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : "agent_failed",
        retry,
        ...safeDiagnosticDetails(details),
      }) + "\n",
    );
    let position = actual.size;
    if (position + entry.length > MAX_DIAGNOSTIC_BYTES) {
      const length = Math.min(actual.size, MAX_DIAGNOSTIC_BYTES / 2);
      const tail = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = readSync(
          file,
          tail,
          read,
          length - read,
          actual.size - length + read,
        );
        if (!count) break;
        read += count;
      }
      // Drop the first partial record, including any partial UTF-8 character.
      const newline = tail.subarray(0, read).indexOf(10);
      const retained =
        newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1, read);
      ftruncateSync(file, 0);
      writeAll(file, retained, 0);
      position = retained.length;
    }
    writeAll(file, entry, position);
  } finally {
    closeSync(file);
  }
}

function writeAll(file: number, bytes: Buffer, position: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(
      file,
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    requireCondition(
      count > 0,
      "agent_log_unavailable",
      "The diagnostic write did not complete.",
    );
    offset += count;
  }
}
