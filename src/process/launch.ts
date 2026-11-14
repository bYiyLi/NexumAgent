import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { types } from "node:util";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { isPlainRecord } from "../contracts/json.js";
import type { ProcessLaunch } from "./backend.js";
import {
  discoverEnvironment,
  mergeChildEnvironment,
  whichExecutable,
  type EnvironmentSnapshot,
  type Executable,
} from "./environment.js";

const KiB = 1024;
const MiB = KiB * KiB;
const textLimit = 256 * KiB;
const argumentLimit = MiB;
const inputLimit = MiB;
const maximumTimeout = 2_147_483_647;
const launchFields = new Set([
  "command",
  "args",
  "shellCommand",
  "shell",
  "cwd",
  "env",
  "tty",
  "cols",
  "rows",
  "input",
  "background",
  "check",
  "timeoutMs",
]);
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedGet = (key: string) =>
  Object.getOwnPropertyDescriptor(typedPrototype, key)!.get!;
const typedBuffer = typedGet("buffer");
const typedOffset = typedGet("byteOffset");
const typedLength = typedGet("byteLength");
const typedValues = Uint8Array.prototype.values;
const typedSet = Uint8Array.prototype.set;

/** Independent, descriptor-checked input used by the managed sh resource. */
export interface LaunchInput {
  readonly command?: string;
  readonly args: readonly string[];
  readonly shellCommand?: string;
  readonly shell?: string;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | null>>;
  readonly tty: boolean;
  readonly cols: number;
  readonly rows: number;
  /** Both public text and byte forms normalize to an independent native view. */
  readonly input?: Uint8Array;
  readonly background: boolean;
  readonly check: boolean;
  readonly timeoutMs?: number;
}
export interface PreparedLaunch {
  readonly launch: ProcessLaunch;
  readonly executable: Executable;
  readonly environment: EnvironmentSnapshot;
  readonly shell: string | null;
}

function text(
  value: unknown,
  label: string,
  maximum = textLimit,
  nonempty = true,
): string {
  requireCondition(
    typeof value === "string" &&
      (!nonempty || value.length > 0) &&
      !value.includes("\0") &&
      Buffer.byteLength(value) <= maximum,
    "invalid_process_arguments",
    `${label} must be bounded text without NUL bytes.`,
  );
  return value;
}
function record(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  requireCondition(
    isPlainRecord(value),
    "invalid_process_arguments",
    `${label} must be an ordinary data object.`,
  );
  const keys = Reflect.ownKeys(value);
  requireCondition(
    keys.length <= 4096,
    "process_arguments_too_large",
    `${label} exceeds its field budget.`,
  );
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireCondition(
      typeof key === "string" &&
        allowed.has(key) &&
        descriptor.enumerable &&
        "value" in descriptor,
      "invalid_process_arguments",
      `${label} cannot contain unknown fields, symbols, hidden fields or accessors.`,
    );
    if (descriptor.value !== undefined)
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        enumerable: true,
      });
  }
  return copy;
}
function argumentsSnapshot(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  requireCondition(
    !types.isProxy(value) && Array.isArray(value),
    "invalid_process_arguments",
    "args must be an ordinary array of strings.",
  );
  const length = Object.getOwnPropertyDescriptor(value, "length")!
    .value as number;
  requireCondition(
    length <= 4096,
    "process_arguments_too_large",
    "The command has too many arguments.",
  );
  const keys = Reflect.ownKeys(value);
  requireCondition(
    keys.length === length + 1,
    "invalid_process_arguments",
    "args cannot contain sparse entries or additional fields.",
  );
  const copy: string[] = [];
  let bytes = 0;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireCondition(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "invalid_process_arguments",
      "args must contain only explicit string data entries.",
    );
    const item = text(
      descriptor.value,
      "Each command argument",
      textLimit,
      false,
    );
    bytes += Buffer.byteLength(item);
    requireCondition(
      bytes <= argumentLimit,
      "process_arguments_too_large",
      "Command arguments exceed their aggregate byte budget.",
    );
    copy.push(item);
  }
  return Object.freeze(copy);
}
function environmentSnapshot(
  value: unknown,
): Readonly<Record<string, string | null>> {
  if (value === undefined)
    return Object.freeze(Object.create(null)) as Readonly<
      Record<string, string | null>
    >;
  requireCondition(
    isPlainRecord(value),
    "invalid_process_arguments",
    "env must contain ordinary data properties.",
  );
  const keys = Reflect.ownKeys(value);
  requireCondition(
    keys.length <= 4096,
    "process_arguments_too_large",
    "The environment has too many overrides.",
  );
  const copy = Object.create(null) as Record<string, string | null>;
  let bytes = 0;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireCondition(
      typeof key === "string" &&
        key.length > 0 &&
        !/[=\0]/.test(key) &&
        Buffer.byteLength(key) <= 1024 &&
        descriptor.enumerable &&
        "value" in descriptor &&
        (descriptor.value === null || typeof descriptor.value === "string"),
      "invalid_process_arguments",
      "Environment overrides require bounded names and string/null data values.",
    );
    const item =
      descriptor.value === null
        ? null
        : text(descriptor.value, "An environment value", textLimit, false);
    bytes += Buffer.byteLength(key) + Buffer.byteLength(item ?? "") + 2;
    requireCondition(
      bytes <= MiB,
      "process_arguments_too_large",
      "Environment overrides exceed their aggregate byte budget.",
    );
    Object.defineProperty(copy, key, { value: item, enumerable: true });
  }
  return Object.freeze(copy);
}
/** Copies only the actual native byte range; source metadata and iterators are ignored. */
export function copyProcessInput(value: unknown): Uint8Array {
  if (typeof value === "string") {
    text(value, "Process input", inputLimit, false);
    const data = Buffer.from(value, "utf8");
    const copy = new Uint8Array(data.byteLength);
    Reflect.apply(typedSet, copy, [data]);
    return copy;
  }
  requireCondition(
    !types.isProxy(value) && types.isUint8Array(value),
    "invalid_process_input",
    "Process input must be text or an actual Uint8Array/Buffer.",
  );
  try {
    // This native check distinguishes legal empty views from detached/OOB views.
    Reflect.apply(typedValues, value, []);
    const buffer = Reflect.apply(typedBuffer, value, []) as ArrayBufferLike;
    const offset = Reflect.apply(typedOffset, value, []) as number;
    const length = Reflect.apply(typedLength, value, []) as number;
    requireCondition(
      length <= inputLimit,
      "process_input_too_large",
      "Process input exceeds 1 MiB.",
    );
    const copy = new Uint8Array(length);
    Reflect.apply(typedSet, copy, [new Uint8Array(buffer, offset, length)]);
    return copy;
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "invalid_process_input",
      "The process input byte range is detached or unavailable.",
      undefined,
      { cause },
    );
  }
}
function flag(value: unknown, label: string): boolean {
  requireCondition(
    value === undefined || typeof value === "boolean",
    "invalid_process_arguments",
    `${label} must be a boolean.`,
  );
  return value ?? false;
}
function dimension(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  requireCondition(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 10000,
    "invalid_process_arguments",
    `${label} must be an integer between 1 and 10000.`,
  );
  return value;
}

/** Pure synchronous argument normalization, before authorization and operation admission. */
export function normalizeLaunch(
  args: readonly unknown[],
  mode: "exec" | "start",
): LaunchInput {
  requireCondition(
    args.length === 1,
    "invalid_process_arguments",
    "sh startup accepts exactly one command string or options object.",
  );
  const value =
    typeof args[0] === "string" ? { shellCommand: args[0] } : args[0];
  const fields = record(value, launchFields, "Process options");
  const command =
    fields.command === undefined ? undefined : text(fields.command, "command");
  const shellCommand =
    fields.shellCommand === undefined
      ? undefined
      : text(fields.shellCommand, "shellCommand", argumentLimit);
  requireCondition(
    (command === undefined) !== (shellCommand === undefined),
    "invalid_process_arguments",
    "Choose exactly one of command + args or shellCommand.",
  );
  requireCondition(
    shellCommand === undefined || fields.args === undefined,
    "invalid_process_arguments",
    "shellCommand cannot also contain direct args.",
  );
  requireCondition(
    command === undefined || fields.shell === undefined,
    "invalid_process_arguments",
    "An explicit shell applies only to shellCommand.",
  );
  const shell =
    fields.shell === undefined ? undefined : text(fields.shell, "shell");
  const cwd = fields.cwd === undefined ? undefined : text(fields.cwd, "cwd");
  requireCondition(
    !command || !/[\r\n]/.test(command),
    "invalid_process_arguments",
    "command cannot contain line breaks.",
  );
  requireCondition(
    !shell || !/[\r\n]/.test(shell),
    "invalid_process_arguments",
    "shell cannot contain line breaks.",
  );
  if (shell !== undefined) shellArguments(shell, shellCommand!);
  const tty = flag(fields.tty, "tty");
  requireCondition(
    tty || (fields.cols === undefined && fields.rows === undefined),
    "invalid_process_arguments",
    "Terminal dimensions require tty: true.",
  );
  const background = flag(fields.background, "background"),
    check = flag(fields.check, "check");
  requireCondition(
    mode !== "exec" || !background,
    "invalid_process_arguments",
    "Background ownership is requested through sh.start.",
  );
  requireCondition(
    mode !== "start" || !check,
    "invalid_process_arguments",
    "check applies to completed sh.exec results.",
  );
  const timeoutMs = fields.timeoutMs;
  requireCondition(
    timeoutMs === undefined ||
      (typeof timeoutMs === "number" &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs > 0 &&
        timeoutMs <= maximumTimeout),
    "invalid_process_arguments",
    "timeoutMs must be a positive integer within Node's native timer range.",
  );
  return Object.freeze({
    ...(command === undefined ? {} : { command }),
    args: argumentsSnapshot(fields.args),
    ...(shellCommand === undefined ? {} : { shellCommand }),
    ...(shell === undefined ? {} : { shell }),
    ...(cwd === undefined ? {} : { cwd }),
    env: environmentSnapshot(fields.env),
    tty,
    cols: dimension(fields.cols, "cols", 80),
    rows: dimension(fields.rows, "rows", 24),
    ...(fields.input === undefined
      ? {}
      : { input: copyProcessInput(fields.input) }),
    background,
    check,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  });
}

function shellArguments(shell: string, command: string): readonly string[] {
  const name = path
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(name))
    return ["-c", command];
  if (name === "cmd") return ["/d", "/s", "/c", command];
  if (name === "powershell" || name === "pwsh")
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  throw new AgentError(
    "unsupported_shell",
    "The explicitly selected shell does not have a supported invocation syntax.",
  );
}
function windowsVariable(
  environment: EnvironmentSnapshot,
  name: string,
): string | undefined {
  const key = Object.keys(environment.variables).find(
    (item) => item.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : environment.variables[key];
}

/** Resolves a fresh OS-user environment after resource registration, without starting business work. */
export async function prepareLaunch(
  input: LaunchInput,
  contextPwd: string,
  signal: AbortSignal,
  authorize: (filename: string, access: "read" | "execute") => void,
): Promise<PreparedLaunch> {
  signal.throwIfAborted();
  requireCondition(
    path.isAbsolute(contextPwd) && !contextPwd.includes("\0"),
    "invalid_cwd",
    "Process preparation requires the current absolute working directory.",
  );
  requireCondition(
    process.platform !== "win32" ||
      !input.cwd ||
      !/^[A-Za-z]:[^\\/]/.test(input.cwd),
    "invalid_cwd",
    "A process directory cannot use implicit per-drive Windows state.",
  );
  const requested = path.resolve(contextPwd, input.cwd ?? ".");
  authorizeCall(() => authorize(requested, "read"));
  let cwd: string;
  try {
    cwd = await realpath(requested);
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "cwd_unavailable",
      "The process working directory cannot be resolved.",
      undefined,
      { cause },
    );
  }
  signal.throwIfAborted();
  authorizeCall(() => authorize(cwd, "read"));
  try {
    requireCondition(
      (await stat(cwd)).isDirectory(),
      "invalid_cwd",
      "The process working directory is not a directory.",
    );
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "cwd_unavailable",
      "The process working directory cannot be accessed.",
      undefined,
      { cause },
    );
  }
  signal.throwIfAborted();
  const environment = await discoverEnvironment({ cwd, signal });
  signal.throwIfAborted();
  const shell =
    input.shellCommand === undefined
      ? null
      : (input.shell ??
        (process.platform === "win32"
          ? (windowsVariable(environment, "ComSpec") ?? "cmd.exe")
          : "/bin/sh"));
  // Decide syntax from the requested shell, not its realpath basename: /bin/sh
  // can be a symlink to bash/dash/busybox while retaining sh invocation meaning.
  const args =
    shell === null ? input.args : shellArguments(shell, input.shellCommand!);
  const executable = await whichExecutable(
    shell ?? input.command!,
    environment,
    cwd,
    { signal },
  );
  signal.throwIfAborted();
  requireCondition(
    executable.kind !== "batch",
    "direct_batch_unsupported",
    "A Windows batch program requires an explicit shellCommand; direct argv is not rewritten into cmd text.",
  );
  // launchPath preserves the selected symlink/applets' argv[0] identity. The
  // canonical file remains separately authorized by the current capability.
  const launchPath = executable.launchPath;
  requireCondition(
    path.isAbsolute(launchPath),
    "command_resolution_failed",
    "Executable discovery did not yield an absolute launch path.",
  );
  authorizeCall(() => authorize(launchPath, "execute"));
  authorizeCall(() => authorize(executable.path, "execute"));
  const env = Object.freeze(mergeChildEnvironment(environment, input.env));
  signal.throwIfAborted();
  return Object.freeze({
    launch: Object.freeze({
      file: launchPath,
      args: Object.freeze([...args]),
      cwd,
      env,
      tty: input.tty,
      cols: input.cols,
      rows: input.rows,
    }),
    executable,
    environment,
    shell: shell === null ? null : launchPath,
  });
}
