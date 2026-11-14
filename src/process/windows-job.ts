import { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { KoffiFunc } from "koffi";
import { AgentError, requireCondition } from "../contracts/errors.js";

/** Exact FILETIME ticks as decimal text, including when sent over Node IPC. */
export type WindowsProcessBirthIdentity = string;

export interface WindowsJobAccounting {
  readonly activeProcesses: number;
  readonly totalProcesses: number;
  /** Windows counts limit terminations here, not every observed process exit. */
  readonly totalTerminatedProcesses: number;
  readonly totalPageFaultCount: number;
  readonly totalUserTime100ns: string;
  readonly totalKernelTime100ns: string;
  readonly thisPeriodTotalUserTime100ns: string;
  readonly thisPeriodTotalKernelTime100ns: string;
}

type Handle = bigint;
type NativeFunction<T extends (...args: never[]) => unknown> = KoffiFunc<T>;
interface NativeApi {
  createJob: NativeFunction<(attributes: null, name: null) => Handle | null>;
  setJob: NativeFunction<
    (job: Handle, kind: number, data: Buffer, size: number) => number
  >;
  assign: NativeFunction<(job: Handle, process: Handle) => number>;
  query: NativeFunction<
    (
      job: Handle,
      kind: number,
      data: Buffer,
      size: number,
      length: null,
    ) => number
  >;
  terminate: NativeFunction<(job: Handle, exitCode: number) => number>;
  close: NativeFunction<(handle: Handle) => number>;
  openProcess: NativeFunction<
    (access: number, inherit: number, pid: number) => Handle | null
  >;
  currentProcess: NativeFunction<() => Handle>;
  processTimes: NativeFunction<
    (
      process: Handle,
      creation: Buffer,
      exit: Buffer,
      kernel: Buffer,
      user: Buffer,
    ) => number
  >;
  lastError: NativeFunction<() => number>;
  readonly extendedLimitSize: number;
  readonly limitFlagsOffset: number;
  readonly accountingSize: number;
}

const queryLimitedInformation = 0x1000;
const setQuota = 0x0100;
const terminateProcess = 0x0001;
const killOnJobClose = 0x2000;
let api: NativeApi | undefined;

function native(): NativeApi {
  requireCondition(
    process.platform === "win32",
    "windows_job_unsupported",
    "Windows Job Objects are available only on Windows.",
  );
  if (api) return api;
  // Neither the native addon nor a Win32 DLL is loaded on other platforms.
  const require = createRequire(import.meta.url);
  let koffi: typeof import("koffi");
  let kernel32: import("koffi").LibraryHandle;
  try {
    koffi = require("koffi");
    kernel32 = koffi.load("kernel32.dll");
  } catch {
    throw new AgentError(
      "windows_job_native_unavailable",
      "The Windows Job Object native binding could not be loaded.",
    );
  }
  // Explicit Win32 widths (BOOL/DWORD are 32-bit even on Windows x64).
  // https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
  const basicLimit = koffi.struct({
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  const ioCounters = koffi.struct({
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  // https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information
  const extendedLimit = koffi.struct({
    BasicLimitInformation: basicLimit,
    IoInfo: ioCounters,
    ProcessMemoryLimit: "uintptr_t",
    JobMemoryLimit: "uintptr_t",
    PeakProcessMemoryUsed: "uintptr_t",
    PeakJobMemoryUsed: "uintptr_t",
  });
  // https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information
  const accounting = koffi.struct({
    TotalUserTime: "int64_t",
    TotalKernelTime: "int64_t",
    ThisPeriodTotalUserTime: "int64_t",
    ThisPeriodTotalKernelTime: "int64_t",
    TotalPageFaultCount: "uint32_t",
    TotalProcesses: "uint32_t",
    ActiveProcesses: "uint32_t",
    TotalTerminatedProcesses: "uint32_t",
  });
  const func = <T extends (...args: never[]) => unknown>(
    declaration: string,
  ): NativeFunction<T> => kernel32.func(declaration) as NativeFunction<T>;
  const loadedApi: NativeApi = {
    createJob: func(
      "void * __stdcall CreateJobObjectW(void *attributes, void *name)",
    ),
    setJob: func(
      "int32_t __stdcall SetInformationJobObject(void *job, int32_t kind, void *data, uint32_t size)",
    ),
    assign: func(
      "int32_t __stdcall AssignProcessToJobObject(void *job, void *process)",
    ),
    query: func(
      "int32_t __stdcall QueryInformationJobObject(void *job, int32_t kind, void *data, uint32_t size, void *length)",
    ),
    terminate: func(
      "int32_t __stdcall TerminateJobObject(void *job, uint32_t exitCode)",
    ),
    close: func("int32_t __stdcall CloseHandle(void *handle)"),
    openProcess: func(
      "void * __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)",
    ),
    currentProcess: func("void * __stdcall GetCurrentProcess()"),
    processTimes: func(
      "int32_t __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)",
    ),
    lastError: func("uint32_t __stdcall GetLastError()"),
    extendedLimitSize: extendedLimit.size,
    limitFlagsOffset:
      extendedLimit.members!.BasicLimitInformation!.offset +
      basicLimit.members!.LimitFlags!.offset,
    accountingSize: accounting.size,
  };
  requireCondition(
    loadedApi.accountingSize === 48 && loadedApi.limitFlagsOffset === 16,
    "windows_job_abi_mismatch",
    "The Win32 Job Object structure layout is unsupported.",
  );
  api = loadedApi;
  return loadedApi;
}

function failure(nativeApi: NativeApi, operation: string): AgentError {
  // Read immediately, before any other Win32 call. Koffi preserves LastError
  // across synchronous calls; only fixed operation names and the code escape.
  const win32Code = nativeApi.lastError();
  return new AgentError(
    "windows_job_native_error",
    `The Windows ${operation} operation failed.`,
    { operation, win32Code },
  );
}

function closeHandle(nativeApi: NativeApi, handle: Handle): void {
  if (!nativeApi.close(handle)) throw failure(nativeApi, "CloseHandle");
}

function birth(
  nativeApi: NativeApi,
  handle: Handle,
): WindowsProcessBirthIdentity {
  // FILETIME is two DWORDs. Reading copied bytes as BigInt avoids precision loss
  // and avoids the FILETIME-to-ULARGE_INTEGER pointer cast forbidden by Win32.
  const creation = Buffer.alloc(8);
  if (
    !nativeApi.processTimes(
      handle,
      creation,
      Buffer.alloc(8),
      Buffer.alloc(8),
      Buffer.alloc(8),
    )
  )
    throw failure(nativeApi, "GetProcessTimes");
  return creation.readBigUInt64LE().toString();
}

function childPid(child: ChildProcess): number {
  requireCondition(
    child instanceof ChildProcess &&
      Number.isInteger(child.pid) &&
      child.pid! > 0 &&
      child.pid! <= 0xffffffff &&
      child.pid !== process.pid &&
      typeof child.spawnfile === "string" &&
      child.spawnfile.length > 0 &&
      child.exitCode === null &&
      child.signalCode === null,
    "windows_job_invalid_child",
    "A live, newly spawned ChildProcess is required for Job Object assignment.",
  );
  return child.pid!;
}

function withChildHandle<T>(
  nativeApi: NativeApi,
  child: ChildProcess,
  access: number,
  action: (handle: Handle) => T,
): T {
  const handle = nativeApi.openProcess(access, 0, childPid(child));
  if (!handle) throw failure(nativeApi, "OpenProcess");
  try {
    return action(handle);
  } finally {
    closeHandle(nativeApi, handle);
  }
}

/** Read-only self identity for the trusted helper's pre-start IPC handshake. */
export function getCurrentProcessBirthIdentity(): WindowsProcessBirthIdentity {
  const nativeApi = native();
  // GetCurrentProcess returns a pseudo-handle, which must never be closed.
  return birth(nativeApi, nativeApi.currentProcess());
}

/** Read-only capture for a privately retained Node child; not a public PID API. */
export function captureChildProcessBirthIdentity(
  child: ChildProcess,
): WindowsProcessBirthIdentity {
  const nativeApi = native();
  return withChildHandle(nativeApi, child, queryLimitedInformation, (handle) =>
    birth(nativeApi, handle),
  );
}

/**
 * Host-private Win32 ownership primitive; never expose this controller to scripts.
 * The caller must keep its trusted helper waiting for IPC until assignChild has
 * succeeded. Assigning an already-running business process cannot close the
 * pre-assignment descendant race. The launcher must supply only its own private
 * ChildProcess object: Node exposes mutable pid/spawnfile properties, so shape
 * validation here is not proof of child provenance or script authorization.
 * No taskkill/PID-tree fallback is performed.
 */
export class WindowsJob {
  #handle: Handle | undefined;
  readonly #api: NativeApi;

  private constructor(nativeApi: NativeApi, handle: Handle) {
    this.#api = nativeApi;
    this.#handle = handle;
  }

  static create(): WindowsJob {
    const nativeApi = native();
    // NULL attributes -> noninheritable handle; NULL name -> private fresh Job.
    const handle = nativeApi.createJob(null, null);
    if (!handle) throw failure(nativeApi, "CreateJobObjectW");
    try {
      const limits = Buffer.alloc(nativeApi.extendedLimitSize);
      limits.writeUInt32LE(killOnJobClose, nativeApi.limitFlagsOffset);
      if (!nativeApi.setJob(handle, 9, limits, limits.length))
        throw failure(nativeApi, "SetInformationJobObject");
      return new WindowsJob(nativeApi, handle);
    } catch (error) {
      closeHandle(nativeApi, handle);
      throw error;
    }
  }

  get closed(): boolean {
    return this.#handle === undefined;
  }

  #open(): Handle {
    requireCondition(
      this.#handle !== undefined,
      "windows_job_closed",
      "The Windows Job Object handle has been closed.",
    );
    return this.#handle;
  }

  assignChild(
    child: ChildProcess,
    expectedBirthIdentity: WindowsProcessBirthIdentity,
  ): void {
    const job = this.#open();
    requireCondition(
      typeof expectedBirthIdentity === "string" &&
        /^[1-9][0-9]{0,19}$/.test(expectedBirthIdentity) &&
        BigInt(expectedBirthIdentity) <= 0xffffffffffffffffn,
      "windows_job_invalid_birth_identity",
      "A precise decimal Windows process creation identity is required.",
    );
    withChildHandle(
      this.#api,
      child,
      queryLimitedInformation | setQuota | terminateProcess,
      (handle) => {
        requireCondition(
          birth(this.#api, handle) === expectedBirthIdentity,
          "windows_job_birth_mismatch",
          "The spawned child no longer matches the expected process identity.",
        );
        // The same handle stays open from identity validation through assignment:
        // even if that process exits now, a reused PID cannot substitute for it.
        if (!this.#api.assign(job, handle))
          throw failure(this.#api, "AssignProcessToJobObject");
      },
    );
  }

  queryAccounting(): WindowsJobAccounting {
    const handle = this.#open();
    const data = Buffer.alloc(this.#api.accountingSize);
    if (!this.#api.query(handle, 1, data, data.length, null))
      throw failure(this.#api, "QueryInformationJobObject");
    return Object.freeze({
      totalUserTime100ns: data.readBigInt64LE(0).toString(),
      totalKernelTime100ns: data.readBigInt64LE(8).toString(),
      thisPeriodTotalUserTime100ns: data.readBigInt64LE(16).toString(),
      thisPeriodTotalKernelTime100ns: data.readBigInt64LE(24).toString(),
      totalPageFaultCount: data.readUInt32LE(32),
      totalProcesses: data.readUInt32LE(36),
      activeProcesses: data.readUInt32LE(40),
      totalTerminatedProcesses: data.readUInt32LE(44),
    });
  }

  /** Delivery only. Query activeProcesses and await actual stdio closure after. */
  terminate(exitCode = 1): void {
    const handle = this.#open();
    requireCondition(
      Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 0xffffffff,
      "windows_job_invalid_exit_code",
      "A Windows termination exit code must be an unsigned 32-bit integer.",
    );
    if (!this.#api.terminate(handle, exitCode))
      throw failure(this.#api, "TerminateJobObject");
  }

  /** True only after actual CloseHandle success; repeated close is a no-op. */
  close(): boolean {
    if (this.#handle === undefined) return false;
    closeHandle(this.#api, this.#handle);
    this.#handle = undefined;
    return true;
  }
}
