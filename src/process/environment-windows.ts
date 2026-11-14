import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { KoffiFunc } from "koffi";
import { AgentError, requireCondition } from "../contracts/errors.js";

export interface WindowsEnvironmentOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

type Pointer = bigint;
interface CreateResult {
  readonly success: number;
  readonly win32Code: number | null;
}
interface NativeEnvironmentApi {
  readonly currentProcess: KoffiFunc<() => Pointer>;
  readonly openToken: KoffiFunc<
    (process: Pointer, access: number, out: (Pointer | null)[]) => number
  >;
  readonly close: KoffiFunc<(token: Pointer) => number>;
  readonly destroy: KoffiFunc<(block: Pointer) => number>;
  readonly length: KoffiFunc<(text: Pointer) => number>;
  readonly lastError: KoffiFunc<() => number>;
  readonly create: (
    out: (Pointer | null)[],
    token: Pointer,
  ) => Promise<CreateResult>;
  readonly readString: (text: Pointer, length: number) => string;
}

let api: NativeEnvironmentApi | undefined;

function native(): NativeEnvironmentApi {
  if (api) return api;
  const require = createRequire(import.meta.url);
  try {
    const koffi: typeof import("koffi") = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const advapi32 = koffi.load("advapi32.dll");
    const userenv = koffi.load("userenv.dll");
    const currentProcess = kernel32.func(
      "void * __stdcall GetCurrentProcess()",
    ) as NativeEnvironmentApi["currentProcess"];
    const openToken = advapi32.func(
      "int32_t __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    ) as NativeEnvironmentApi["openToken"];
    const close = kernel32.func(
      "int32_t __stdcall CloseHandle(void *handle)",
    ) as NativeEnvironmentApi["close"];
    const destroy = userenv.func(
      "int32_t __stdcall DestroyEnvironmentBlock(void *block)",
    ) as NativeEnvironmentApi["destroy"];
    const length = kernel32.func(
      "int32_t __stdcall lstrlenW(void *text)",
    ) as NativeEnvironmentApi["length"];
    const lastError = kernel32.func(
      "uint32_t __stdcall GetLastError()",
    ) as NativeEnvironmentApi["lastError"];
    const create = userenv.func(
      "int32_t __stdcall CreateEnvironmentBlock(_Out_ void **block, void *token, int32_t inherit)",
    ) as KoffiFunc<
      (out: (Pointer | null)[], token: Pointer, inherit: number) => number
    >;
    // Koffi executes .async on a worker and restores that worker's LastError only
    // during this callback. Capture it here, before promisify/await resumes.
    const createAsync = promisify(
      (
        out: (Pointer | null)[],
        token: Pointer,
        callback: (error: Error | null, result?: CreateResult) => void,
      ): void => {
        create.async(out, token, 0, (error: unknown, success) => {
          if (error) {
            callback(
              new AgentError(
                "windows_environment_native_unavailable",
                "The Windows environment native call could not be completed.",
              ),
            );
            return;
          }
          const win32Code = success ? null : lastError();
          callback(null, { success, win32Code });
        });
      },
    );
    api = {
      currentProcess,
      openToken,
      close,
      destroy,
      length,
      lastError,
      create: createAsync as NativeEnvironmentApi["create"],
      // lstrlenW has measured this exact OS-owned entry before any JS string is
      // allocated. Never decode a guessed block capacity or memory past its NUL.
      readString: (text, characters) => koffi.decode.string16(text, characters),
    };
    return api;
  } catch {
    throw new AgentError(
      "windows_environment_native_unavailable",
      "The Windows environment native binding could not be loaded.",
    );
  }
}

function nativeFailure(operation: string, win32Code: number): AgentError {
  return new AgentError(
    "windows_environment_native_error",
    `The Windows ${operation} environment operation failed.`,
    { operation, win32Code },
  );
}

/**
 * Fresh current-user environment, without inheriting a long-lived daemon's env.
 * Requires an already-loaded OS user profile. Never loads profiles or writes the
 * registry. Native completion and actual cleanup precede cancellation/deadline
 * rejection; an uncancellable Userenv operation is never left running in secret.
 *
 * https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createenvironmentblock
 * https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-destroyenvironmentblock
 */
export async function readWindowsUserEnvironment(
  options: WindowsEnvironmentOptions,
): Promise<Readonly<Record<string, string>>> {
  requireCondition(
    options.signal instanceof AbortSignal &&
      Number.isSafeInteger(options.timeoutMs) &&
      options.timeoutMs >= 1 &&
      options.timeoutMs <= 30000 &&
      Number.isSafeInteger(options.maxBytes) &&
      options.maxBytes >= 1 &&
      options.maxBytes <= 4 * 1024 * 1024,
    "invalid_environment_options",
    "Windows user environment discovery requires a native signal and bounded deadline/output budget.",
  );
  options.signal.throwIfAborted();
  requireCondition(
    process.platform === "win32",
    "windows_environment_unsupported",
    "The native Windows user environment is available only on Windows.",
  );
  const deadline = performance.now() + options.timeoutMs;
  const check = (): void => {
    options.signal.throwIfAborted();
    requireCondition(
      performance.now() < deadline,
      "environment_probe_timeout",
      "The user environment probe exceeded its deadline.",
    );
  };
  const nativeApi = native();
  const tokenOut: (Pointer | null)[] = [null];
  const blockOut: (Pointer | null)[] = [null];
  let token: Pointer | undefined;
  let ownedBlock: Pointer | undefined;
  try {
    check();
    // A primary process token needs TOKEN_QUERY | TOKEN_DUPLICATE, not elevation.
    // GetCurrentProcess is a pseudo-handle and must never be closed.
    if (
      !nativeApi.openToken(
        nativeApi.currentProcess(),
        0x0008 | 0x0002,
        tokenOut,
      )
    )
      throw nativeFailure("OpenProcessToken", nativeApi.lastError());
    requireCondition(
      typeof tokenOut[0] === "bigint" && tokenOut[0] !== 0n,
      "windows_environment_native_error",
      "Windows did not return a valid user token handle.",
    );
    token = tokenOut[0];
    check();
    const result = await nativeApi.create(blockOut, token);
    if (result.success && typeof blockOut[0] === "bigint" && blockOut[0] !== 0n)
      ownedBlock = blockOut[0];
    // The native callback is actually complete at this point, including output
    // pointer marshalling. An aborted call still releases both native resources.
    check();
    if (!result.success)
      throw nativeFailure("CreateEnvironmentBlock", result.win32Code!);
    const block = ownedBlock;
    requireCondition(
      typeof block === "bigint" && block !== 0n,
      "windows_environment_native_error",
      "Windows did not return a valid user environment block.",
    );

    const entries: { pointer: Pointer; characters: number }[] = [];
    let cursor = block;
    let nativeBytes = 2; // The final second UTF-16 NUL.
    for (;;) {
      check();
      const characters = nativeApi.length(cursor);
      requireCondition(
        Number.isInteger(characters) && characters >= 0 && characters <= 32767,
        "environment_too_large",
        "A Windows environment entry exceeds the bounded variable size.",
      );
      if (characters === 0) break;
      nativeBytes += (characters + 1) * 2;
      requireCondition(
        nativeBytes <= options.maxBytes && entries.length < 100000,
        "environment_too_large",
        "The Windows environment block exceeds its output budget.",
      );
      entries.push({ pointer: cursor, characters });
      cursor += BigInt((characters + 1) * 2);
    }
    if (entries.length === 0) nativeBytes = 4;
    requireCondition(
      nativeBytes <= options.maxBytes,
      "environment_too_large",
      "The Windows environment block exceeds its output budget.",
    );
    // The entire UTF-16 allocation has now been bounded before string allocation.
    const values = Object.create(null) as Record<string, string>;
    const names = new Set<string>();
    let utf8Bytes = 0;
    for (const entry of entries) {
      check();
      const text = nativeApi.readString(entry.pointer, entry.characters);
      utf8Bytes += Buffer.byteLength(text) + 1;
      requireCondition(
        utf8Bytes <= options.maxBytes,
        "environment_too_large",
        "The Windows environment snapshot exceeds its output budget.",
      );
      const equal = text.indexOf("=");
      requireCondition(
        equal > 0,
        "invalid_environment",
        "The Windows user environment contains an invalid variable.",
      );
      const name = text.slice(0, equal);
      const identity = name.toUpperCase();
      requireCondition(
        !names.has(identity),
        "invalid_environment",
        "The Windows user environment repeats a case-insensitive variable.",
      );
      names.add(identity);
      values[name] = text.slice(equal + 1);
    }
    const profile = Object.keys(values).find(
      (name) => name.toUpperCase() === "USERPROFILE",
    );
    requireCondition(
      profile !== undefined && values[profile]!.length > 0,
      "windows_user_profile_unavailable",
      "The current Windows user's profile is not available; it must already be loaded by the OS session.",
    );
    check();
    return Object.freeze(values);
  } finally {
    let cleanupError: AgentError | undefined;
    if (ownedBlock !== undefined && !nativeApi.destroy(ownedBlock))
      cleanupError = nativeFailure(
        "DestroyEnvironmentBlock",
        nativeApi.lastError(),
      );
    if (token !== undefined && !nativeApi.close(token))
      cleanupError ??= nativeFailure("CloseHandle", nativeApi.lastError());
    if (cleanupError) throw cleanupError;
  }
}
