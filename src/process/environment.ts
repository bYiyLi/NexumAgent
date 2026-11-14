import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";

export interface EnvironmentSnapshot {
  readonly platform: NodeJS.Platform;
  readonly variables: Readonly<Record<string, string>>;
  /** The user-environment probe shell, not sh.shellCommand's default shell. */
  readonly shell: string;
  readonly source: "login-shell" | "windows-user";
  readonly discoveredAt: number;
  readonly cwd: string;
}
export interface DiscoverEnvironmentOptions {
  readonly signal: AbortSignal;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}
export interface Executable {
  readonly command: string;
  /** Resolved absolute spelling; preserves executable symlink/argv[0] semantics. */
  readonly launchPath: string;
  readonly path: string;
  readonly kind: "native" | "batch";
  readonly platform: NodeJS.Platform;
}

const maximumBytes = 4 * 1024 * 1024;
const supportedShells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const privateVariables = new Set([
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
  "NODE_UNIQUE_ID",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
]);
const forbidden = (name: string): boolean =>
  /^(?:_?NEXUM)(?:_|$)|^NODE_CHANNEL_/i.test(name) ||
  privateVariables.has(name.toUpperCase());

function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function name(value: unknown): asserts value is string {
  requireCondition(
    typeof value === "string" && value.length > 0 && !/[=\0]/.test(value),
    "invalid_environment",
    "Environment names must be nonempty strings without NUL or equals signs.",
  );
}
function entries(value: unknown): [string, string | null][] {
  requireCondition(
    isPlainRecord(value),
    "invalid_environment",
    "Environment values must be ordinary data properties.",
  );
  const result: [string, string | null][] = [];
  let bytes = 0;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable) continue;
    name(key);
    requireCondition(
      "value" in descriptor &&
        (descriptor.value === null ||
          (typeof descriptor.value === "string" &&
            !descriptor.value.includes("\0"))),
      "invalid_environment",
      "Environment values must be strings or explicit null removals.",
    );
    bytes +=
      Buffer.byteLength(key) + Buffer.byteLength(descriptor.value ?? "") + 2;
    requireCondition(
      bytes <= maximumBytes && result.length < 100000,
      "environment_too_large",
      "Environment data exceeds its bounded size.",
    );
    result.push([key, descriptor.value]);
  }
  return result;
}
function clean(value: unknown, windows: boolean): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  const keys = new Map<string, string>();
  for (const [key, item] of entries(value)) {
    if (forbidden(key) || item === null) continue;
    const identity = windows ? key.toUpperCase() : key;
    const previous = keys.get(identity);
    requireCondition(
      previous === undefined,
      "invalid_environment",
      "The environment contains competing case-insensitive names.",
    );
    keys.set(identity, key);
    result[key] = item;
  }
  return result;
}
function parentEnvironment(): Record<string, string> {
  const inherited = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(process.env))
    // A background Agent's launcher/preload options are not a user baseline.
    // User shell initialization / Windows registry may declare these again;
    // normal business child overrides also accept them unchanged.
    if (
      value !== undefined &&
      !forbidden(key) &&
      !["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())
    )
      inherited[key] = value;
  // Node itself selects just one case-insensitive Windows name. Make that
  // selection explicit instead of letting two PATH keys change child lookup.
  if (process.platform === "win32") {
    const seen = new Set<string>();
    for (const key of Object.keys(inherited).sort()) {
      const identity = key.toUpperCase();
      if (seen.has(identity)) delete inherited[key];
      else seen.add(identity);
    }
  }
  return inherited;
}
function field(
  values: Readonly<Record<string, string>>,
  key: string,
  windows: boolean,
): string | undefined {
  if (!windows) return values[key];
  const found = Object.keys(values).find(
    (item) => item.toUpperCase() === key.toUpperCase(),
  );
  return found === undefined ? undefined : values[found];
}
async function directory(value: string, signal?: AbortSignal): Promise<string> {
  abort(signal);
  requireCondition(
    typeof value === "string" &&
      path.isAbsolute(value) &&
      !value.includes("\0"),
    "invalid_cwd",
    "The process working directory must be an absolute path.",
  );
  try {
    const resolved = await realpath(value);
    requireCondition(
      (await stat(resolved)).isDirectory(),
      "invalid_cwd",
      "The process working directory is not a directory.",
    );
    await access(
      resolved,
      constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK),
    );
    abort(signal);
    return resolved;
  } catch (cause) {
    abort(signal);
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "cwd_unavailable",
      "The process working directory cannot be accessed.",
      undefined,
      { cause },
    );
  }
}

/** Fixed Win32 registry/environment probe; it never executes a user command or profile. */
function windowsProbe(marker: string): string {
  return `
$ErrorActionPreference = 'Stop'
$values = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$expand = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$volatile = @('SystemRoot','SystemDrive','COMPUTERNAME','ComSpec','USERPROFILE','HOMEDRIVE','HOMEPATH','USERNAME','USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','LOGONSERVER','LOCALAPPDATA','APPDATA','TEMP','TMP','ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','PROCESSOR_LEVEL','PROCESSOR_REVISION','NUMBER_OF_PROCESSORS')
foreach ($item in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { if ($volatile -contains [string]$item.Key) { $values[[string]$item.Key] = [string]$item.Value } }
$machinePath = $null; $userPath = $null; $machineExpand = $false; $userExpand = $false
foreach ($location in @('machine','user')) {
  if ($location -eq 'machine') { $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') }
  else { $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment') }
  if ($null -eq $key) { continue }
  try {
    foreach ($entry in $key.GetValueNames()) {
      $kind = $key.GetValueKind($entry)
      if (($kind -ne [Microsoft.Win32.RegistryValueKind]::String) -and ($kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString)) { throw 'Unsupported environment value' }
      $value = [string]$key.GetValue($entry, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($entry -ieq 'Path') {
        if ($location -eq 'machine') { $machinePath = $value; $machineExpand = $kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString }
        else { $userPath = $value; $userExpand = $kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString }
      } else {
        $values[$entry] = $value
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { [void]$expand.Add($entry) } else { [void]$expand.Remove($entry) }
      }
    }
  } finally { $key.Dispose() }
}
foreach ($entry in @($values.Keys)) { [Environment]::SetEnvironmentVariable($entry, $values[$entry], 'Process') }
# Never expand fresh registry values against the background Agent's old PATH.
[Environment]::SetEnvironmentVariable('Path', $null, 'Process')
if ($null -ne $machinePath -or $null -ne $userPath) {
  if ($machineExpand) { $machinePath = [Environment]::ExpandEnvironmentVariables($machinePath) }
  [Environment]::SetEnvironmentVariable('Path', $machinePath, 'Process')
  if ($userExpand) { $userPath = [Environment]::ExpandEnvironmentVariables($userPath) }
  $parts = @(); if ($null -ne $machinePath -and $machinePath.Length -gt 0) { $parts += $machinePath }; if ($null -ne $userPath -and $userPath.Length -gt 0) { $parts += $userPath }
  $values['Path'] = $parts -join ';'
  [Environment]::SetEnvironmentVariable('Path', $values['Path'], 'Process')
}
# Use the OS's expansion semantics once, rather than inventing a recursive DSL.
foreach ($entry in @($expand)) { $values[$entry] = [Environment]::ExpandEnvironmentVariables($values[$entry]); [Environment]::SetEnvironmentVariable($entry, $values[$entry], 'Process') }
$output = [ordered]@{}
foreach ($entry in ($values.Keys | Sort-Object)) { $output[$entry] = $values[$entry] }
$body = $output | ConvertTo-Json -Compress -Depth 3
$encoder = [Text.UTF8Encoding]::new($false)
$bytes = $encoder.GetBytes([char]0 + '${marker}_start' + [char]0 + $body + [char]0 + '${marker}_end' + [char]0)
$stream = [Console]::OpenStandardOutput(); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
`;
}

async function probe(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer> {
  abort(signal);
  const child = spawn(executable, [...args], {
    cwd,
    env: parentEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let error: unknown;
  let bytes = 0;
  let closing = false;
  let force: NodeJS.Timeout | undefined;
  const chunks: Buffer[] = [];
  const kill = (hard: boolean) => {
    try {
      if (process.platform === "win32")
        child.kill(hard ? "SIGKILL" : "SIGTERM");
      else if (child.pid)
        process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
        error ??= new AgentError(
          "environment_cleanup_failed",
          "The environment probe could not stop its process group.",
          undefined,
          { cause },
        );
    }
  };
  const stop = (cause: unknown) => {
    error ??= cause;
    if (closing) return;
    closing = true;
    kill(false);
    force = setTimeout(() => kill(true), 100);
  };
  const cancelled = () =>
    stop(
      signal.reason ??
        new DOMException("The environment probe was aborted.", "AbortError"),
    );
  const timer = setTimeout(
    () =>
      stop(
        new AgentError(
          "environment_probe_timeout",
          "The user environment probe exceeded its deadline.",
        ),
      ),
    timeoutMs,
  );
  signal.addEventListener("abort", cancelled, { once: true });
  if (signal.aborted) cancelled();
  const collect = (chunk: Buffer, stdout: boolean) => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      stop(
        new AgentError(
          "environment_too_large",
          "The environment probe exceeded its output budget.",
        ),
      );
      return;
    }
    if (stdout && !closing) chunks.push(chunk);
  };
  child.stdout!.on("data", (chunk: Buffer) => collect(chunk, true));
  child.stderr!.on("data", (chunk: Buffer) => collect(chunk, false));
  const groupExists = (): boolean => {
    if (process.platform === "win32" || !child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
      // EPERM still means the group may exist (including a just-killed group
      // awaiting OS reaping). Observe it until absent; never treat it as closed.
      if ((cause as NodeJS.ErrnoException).code === "EPERM") return true;
      throw new AgentError(
        "environment_cleanup_failed",
        "The environment probe's process group could not be checked.",
        undefined,
        { cause },
      );
    }
  };
  const closeGroup = async (): Promise<void> => {
    if (!groupExists()) return;
    error ??= new AgentError(
      "environment_probe_lingering",
      "The environment probe left a live process group after its root closed.",
    );
    kill(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!groupExists()) return;
    kill(true);
    // These are observations of the same owned group, never replacement work.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!groupExists()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new AgentError(
      "environment_cleanup_unconfirmed",
      "The environment probe could not confirm that its process group is empty.",
    );
  };
  return await new Promise<Buffer>((resolve, reject) => {
    child.once("error", (cause) => {
      error ??= new AgentError(
        "environment_probe_failed",
        "The user environment probe could not start.",
        undefined,
        { cause },
      );
    });
    child.once("close", async (code, endedSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      try {
        await closeGroup();
      } catch (cause) {
        error = cause;
      } finally {
        if (force) clearTimeout(force);
      }
      if (error) reject(error);
      else if (code !== 0 || endedSignal)
        reject(
          new AgentError(
            "environment_probe_failed",
            "The user environment probe did not complete successfully.",
          ),
        );
      else resolve(Buffer.concat(chunks));
    });
  });
}

export async function discoverEnvironment(
  options: DiscoverEnvironmentOptions,
): Promise<EnvironmentSnapshot> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  requireCondition(
    options.signal instanceof AbortSignal &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 1 &&
      timeoutMs <= 30000 &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes >= 1 &&
      maxBytes <= maximumBytes,
    "invalid_environment_options",
    "Environment discovery requires a native signal and bounded deadline/output budget.",
  );
  abort(options.signal);
  const cwd = await directory(options.cwd ?? process.cwd(), options.signal);
  const windows = process.platform === "win32";
  const marker = "nexum_env_" + randomUUID().replaceAll("-", "");
  let shell: string;
  let args: string[];
  if (windows) {
    const systemRoot = field(parentEnvironment(), "SystemRoot", true);
    requireCondition(
      systemRoot && path.isAbsolute(systemRoot),
      "environment_shell_unavailable",
      "The Windows system environment probe is unavailable.",
    );
    shell = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsProbe(marker), "utf16le").toString("base64"),
    ];
  } else {
    const configured = userInfo().shell;
    requireCondition(
      configured &&
        path.isAbsolute(configured) &&
        supportedShells.has(path.basename(configured)),
      "environment_shell_unsupported",
      "The current OS user's shell is not a supported environment probe shell.",
    );
    shell = configured;
    await access("/usr/bin/env", constants.X_OK);
    const begin = `printf '\\000${marker}_start\\000'`;
    const end = `printf '\\000${marker}_end\\000'`;
    const command =
      path.basename(shell) === "fish"
        ? `${begin}; /usr/bin/env -0; or exit $status; ${end}`
        : `${begin}; /usr/bin/env -0 || exit $?; ${end}`;
    args = ["-i", "-l", "-c", command];
  }
  try {
    shell = await realpath(shell);
    requireCondition(
      (await stat(shell)).isFile(),
      "environment_shell_unavailable",
      "The environment probe shell is not a regular executable.",
    );
    await access(shell, constants.X_OK);
  } catch (cause) {
    abort(options.signal);
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "environment_shell_unavailable",
      "The environment probe shell cannot be accessed.",
      undefined,
      { cause },
    );
  }
  const bytes = await probe(
    shell,
    args,
    cwd,
    options.signal,
    timeoutMs,
    maxBytes,
  );
  abort(options.signal);
  const start = Buffer.from(`\0${marker}_start\0`);
  const end = Buffer.from(`\0${marker}_end\0`);
  const from = bytes.indexOf(start);
  const until = bytes.indexOf(end, from + start.length);
  requireCondition(
    from >= 0 &&
      until >= from + start.length &&
      bytes.indexOf(start, from + start.length) < 0 &&
      bytes.indexOf(end, until + end.length) < 0,
    "invalid_environment",
    "The environment probe did not return one complete framed snapshot.",
  );
  const body = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(from + start.length, until),
  );
  let variables: Record<string, string>;
  if (windows) {
    try {
      variables = clean(JSON.parse(body), true);
    } catch (cause) {
      throw new AgentError(
        "invalid_environment",
        "The Windows environment snapshot is not valid bounded data.",
        undefined,
        { cause },
      );
    }
  } else {
    const values = Object.create(null) as Record<string, string>;
    requireCondition(
      body.endsWith("\0"),
      "invalid_environment",
      "The environment snapshot has an incomplete entry.",
    );
    for (const entry of body.slice(0, -1).split("\0")) {
      const equals = entry.indexOf("=");
      requireCondition(
        equals > 0,
        "invalid_environment",
        "The environment snapshot contains an invalid entry.",
      );
      const key = entry.slice(0, equals);
      requireCondition(
        !Object.hasOwn(values, key),
        "invalid_environment",
        "The environment snapshot repeats a variable.",
      );
      values[key] = entry.slice(equals + 1);
    }
    variables = clean(values, false);
  }
  abort(options.signal);
  return Object.freeze({
    platform: process.platform,
    variables: Object.freeze(variables),
    shell,
    source: windows ? "windows-user" : "login-shell",
    discoveredAt: Date.now(),
    cwd,
  });
}

export function mergeChildEnvironment(
  snapshot: EnvironmentSnapshot,
  overrides: Readonly<Record<string, string | null>> = {},
): Record<string, string> {
  const windows = snapshot.platform === "win32";
  const result = clean(snapshot.variables, windows);
  const seen = new Set<string>();
  for (const [key, value] of entries(overrides)) {
    requireCondition(
      !forbidden(key),
      "environment_variable_forbidden",
      "Agent control variables cannot be inherited or supplied to a child process.",
    );
    const identity = windows ? key.toUpperCase() : key;
    requireCondition(
      !seen.has(identity),
      "invalid_environment",
      "The child environment contains competing case-insensitive overrides.",
    );
    seen.add(identity);
    const previous = windows
      ? Object.keys(result).find((item) => item.toUpperCase() === identity)
      : key;
    if (previous !== undefined) delete result[previous];
    if (value !== null) result[key] = value;
  }
  // Include the merged size, rather than only each independent source's size.
  entries(result);
  return result;
}

export async function whichExecutable(
  command: string,
  snapshot: EnvironmentSnapshot,
  cwd: string,
  options: { signal?: AbortSignal } = {},
): Promise<Executable> {
  abort(options.signal);
  requireCondition(
    typeof command === "string" &&
      command.length > 0 &&
      !/[\0\r\n]/.test(command) &&
      Buffer.byteLength(command) <= 262144,
    "invalid_command",
    "A command must be nonempty bounded program text.",
  );
  requireCondition(
    snapshot.platform === process.platform,
    "environment_platform_mismatch",
    "The executable must be resolved on the platform that produced its environment.",
  );
  const current = await directory(cwd, options.signal);
  const windows = process.platform === "win32";
  requireCondition(
    !windows || !/^[A-Za-z]:[^\\/]/.test(command),
    "invalid_command",
    "A Windows command must not use an implicit per-drive working directory.",
  );
  const variables = clean(snapshot.variables, windows);
  const hasSeparator =
    command.includes("/") || (windows && command.includes("\\"));
  const search =
    hasSeparator || path.isAbsolute(command)
      ? [""]
      : [
          ...(windows ? [current] : []),
          ...(
            field(variables, "PATH", windows) ??
            (windows ? "" : "/usr/bin:/bin")
          ).split(path.delimiter),
        ];
  requireCondition(
    search.length <= 65536,
    "environment_too_large",
    "The executable search path exceeds its bounded entry count.",
  );
  let denied = false;
  const extensions = windows
    ? (field(variables, "PATHEXT", true) ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
    : [""];
  requireCondition(
    extensions.length <= 1024 &&
      (!windows || extensions.every((item) => /^\.[A-Za-z0-9]+$/.test(item))),
    "invalid_environment",
    "The executable extension list is invalid.",
  );
  const suffixes = windows
    ? path.extname(command)
      ? ["", ...extensions]
      : extensions
    : [""];
  for (const item of search) {
    abort(options.signal);
    const location = windows && /^".*"$/.test(item) ? item.slice(1, -1) : item;
    const base =
      hasSeparator || path.isAbsolute(command)
        ? path.resolve(current, command)
        : path.resolve(current, location, command);
    for (const suffix of suffixes) {
      abort(options.signal);
      const candidate = base + suffix;
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (windows && !/\.(?:exe|com|cmd|bat)$/i.test(candidate)) continue;
        await access(candidate, windows ? constants.R_OK : constants.X_OK);
        const resolved = await realpath(candidate);
        abort(options.signal);
        return Object.freeze({
          command,
          launchPath: candidate,
          path: resolved,
          kind:
            windows && /\.(?:cmd|bat)$/i.test(resolved) ? "batch" : "native",
          platform: process.platform,
        });
      } catch (cause) {
        abort(options.signal);
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        if (code === "EACCES" || code === "EPERM") {
          denied = true;
          continue;
        }
        if (cause instanceof AgentError) throw cause;
        throw new AgentError(
          "command_resolution_failed",
          "The command's filesystem identity could not be resolved.",
          undefined,
          { cause },
        );
      }
    }
  }
  throw new AgentError(
    denied ? "command_access_denied" : "command_not_found",
    denied
      ? "An executable candidate exists but is not accessible."
      : "No executable matches the command in the fixed user environment.",
  );
}
