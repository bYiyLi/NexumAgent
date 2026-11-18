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
import { isAgentError, requireCondition } from "../contracts/errors.js";
import type { Profile } from "../contracts/types.js";
import { privateDirectory } from "../runtime/paths.js";
import type { ConnectionDiagnosticDetails } from "./connection.js";

export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

const exceptionNames = new Set([
  "AgentError", "Error", "TypeError", "RangeError", "ReferenceError",
  "SyntaxError", "AggregateError", "SystemError",
]);
const systemCodes = new Set([
  "EACCES", "EPERM", "ENOENT", "EEXIST", "EBUSY", "EADDRINUSE",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ERR_SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CORRUPT",
  "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED",
]);
const recoveryHints: Readonly<Record<string, string>> = {
  check_configuration: "检查当前 profile 的配置格式与 Cloud 地址；不要将 Token 粘贴到日志或对话。",
  inspect_storage: "检查本地 SQLite 的真实状态、文件权限和数据库版本；禁止直接删除数据库或重放未完成的 Run。",
  check_permissions: "确认当前 OS 用户对本地工作、状态与日志目录拥有访问权限，检查路径是否被占用。",
  verify_core: "检查受管 Node/npm 和已安装 Agent 版本、模块入口与相关构建产物；不能用旧版跳过版本门禁。",
  check_network: "检查 Cloud 连接、DNS、网络和当前 Token 是否有效；不要输出凭据。",
  inspect_startup: "检查本次启动 attemptId 对应的 startup.log 与 agent.log，按阶段和源码模块定位；不要重放未知副作用。",
  inspect_shutdown: "检查各子系统的关闭与资源回收状态，不要把未确认退出当成成功。",
};
type RecoveryCode = keyof typeof recoveryHints;

function exceptionName(value: unknown): string {
  if (isAgentError(value)) return "AgentError";
  if (value instanceof TypeError) return "TypeError";
  if (value instanceof RangeError) return "RangeError";
  if (value instanceof ReferenceError) return "ReferenceError";
  if (value instanceof SyntaxError) return "SyntaxError";
  if (value instanceof AggregateError) return "AggregateError";
  if (value instanceof Error) return "Error";
  return "unknown";
}

/** Extract only a bounded module/compiled-line coordinate, never a raw stack,
 * absolute path, message, environment, caller code or a credential. */
function sourceCoordinate(value: unknown): {
  sourceModule?: string; sourceLine?: number;
} {
  if (!(value instanceof Error)) return {};
  try {
    const stack = value.stack;
    if (typeof stack !== "string") return {};
    const pattern = /[/\\]dist[/\\]((?:application|storage|runtime|work|extensions|results|services|maintenance|contracts|transfer)[/\\][a-z][a-z0-9_-]*(?:[/\\][a-z][a-z0-9_-]*){0,2})\.js:(\d{1,6}):\d{1,6}/g;
    let fallback: { sourceModule?: string; sourceLine?: number } = {};
    for (const match of stack.slice(0, 16384).matchAll(pattern)) {
      const sourceLine = Number(match[2]);
      const entry = {
        sourceModule: match[1]!.replaceAll("\\", "/"),
        ...(sourceLine > 0 ? { sourceLine } : {}),
      };
      fallback = fallback.sourceModule ? fallback : entry;
      // requireCondition is a shared throw helper; its caller is the useful
      // business module. Do not blame the generic helper for every fault.
      if (entry.sourceModule !== "contracts/errors") return entry;
    }
    return fallback;
  } catch {
    return {};
  }
}

/** Use only trusted error classes and recognized system codes as evidence.
 * An arbitrary thrown message/code/stack cannot become an instruction or log. */
export function startupFailureDetails(
  cause: unknown,
  phase: string,
  attemptId?: string,
): ConnectionDiagnosticDetails {
  let failureCode = "unclassified_failure";
  let sourceCode: string | undefined;
  let type = exceptionName(cause);
  let location: ReturnType<typeof sourceCoordinate> = {};
  let current: unknown = cause;
  const visited = new Set<unknown>();
  for (let i = 0; i < 6 && current && typeof current === "object"; i++) {
    if (visited.has(current)) break;
    visited.add(current);
    try {
      if (isAgentError(current) && /^[a-z][a-z0-9_]{0,100}$/.test(current.code))
        failureCode = current.code;
      const rawCode = Object.getOwnPropertyDescriptor(current, "code")?.value;
      if (typeof rawCode === "string" && systemCodes.has(rawCode))
        sourceCode = rawCode;
      if (type === "unknown" || type === "AgentError" || type === "Error")
        type = exceptionName(current);
      const found = sourceCoordinate(current);
      if (found.sourceModule) location = found;
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    } catch {
      break;
    }
  }
  const recoveryCode: RecoveryCode =
    failureCode === "invalid_configuration" || phase === "profile_load"
      ? "check_configuration"
      : failureCode.startsWith("storage_") || sourceCode?.startsWith("SQLITE") ||
          sourceCode === "ERR_SQLITE_ERROR"
        ? "inspect_storage"
        : sourceCode === "EACCES" || sourceCode === "EPERM" || sourceCode === "EBUSY"
          ? "check_permissions"
          : sourceCode === "ERR_MODULE_NOT_FOUND" ||
              sourceCode === "ERR_PACKAGE_PATH_NOT_EXPORTED"
            ? "verify_core"
            : ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(sourceCode ?? "")
              ? "check_network"
              : phase === "shutdown" ? "inspect_shutdown" : "inspect_startup";
  return {
    component: "core",
    phase,
    failureCode,
    exceptionType: exceptionNames.has(type) ? type : undefined,
    ...location,
    ...(sourceCode ? { sourceCode } : {}),
    recoveryCode,
    ...(attemptId ? { attemptId } : {}),
  };
}

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
  const attemptId = typeof details.attemptId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(details.attemptId)
    ? details.attemptId : undefined;
  const exceptionType = typeof details.exceptionType === "string" &&
    exceptionNames.has(details.exceptionType) ? details.exceptionType : undefined;
  const sourceModule = typeof details.sourceModule === "string" &&
    /^(?:application|storage|runtime|work|extensions|results|services|maintenance|contracts|transfer)\/[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*){0,2}$/.test(details.sourceModule)
    ? details.sourceModule : undefined;
  const sourceCode = typeof details.sourceCode === "string" &&
    systemCodes.has(details.sourceCode) ? details.sourceCode : undefined;
  const recoveryCode = typeof details.recoveryCode === "string" &&
    Object.hasOwn(recoveryHints, details.recoveryCode)
    ? details.recoveryCode as RecoveryCode : undefined;
  return {
    ...(component ? { component } : {}),
    ...(phase ? { phase } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(exceptionType ? { exceptionType } : {}),
    ...(sourceModule ? { sourceModule } : {}),
    ...(safeNumber(details.sourceLine) && details.sourceLine > 0 && details.sourceLine <= 999999
      ? { sourceLine: details.sourceLine } : {}),
    ...(sourceCode ? { sourceCode } : {}),
    ...(recoveryCode ? {
      recoveryCode, recoveryHint: recoveryHints[recoveryCode],
    } : {}),
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
