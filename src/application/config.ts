import { homedir } from "node:os";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import type { Profile } from "../contracts/types.js";

export interface AgentStorageConfiguration {
  readonly max_managed_bytes?: number;
}
export interface AgentRetentionConfiguration {
  readonly work_idle_ms?: number;
  readonly run_history_ms?: number;
  readonly run_logs_ms?: number;
  readonly input_attachments_ms?: number;
  readonly artifact_ms?: number;
  readonly material_copies_ms?: number;
}
export interface ProfileConfiguration {
  readonly profile: Profile;
  readonly root: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly storage?: Readonly<AgentStorageConfiguration>;
  readonly retention?: Readonly<AgentRetentionConfiguration>;
}
function invalid(): AgentError {
  // Never attach the source text, filename, credential or parser/system cause.
  return new AgentError(
    "invalid_configuration",
    "The selected Agent profile configuration is unavailable or invalid.",
  );
}
function numericPolicy(
  value: unknown,
  fields: readonly string[],
  duration = false,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw invalid();
  for (const [key, number] of Object.entries(value))
    if (
      !fields.includes(key) ||
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      (duration && number > 253_402_300_799_999 - Date.now())
    )
      throw invalid();
  return Object.freeze({ ...value }) as Readonly<Record<string, number>>;
}
export function validateServerUrl(value: unknown, profile: Profile): URL {
  try {
    requireCondition(
      (profile === "production" || profile === "development") &&
        typeof value === "string" &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 8192 &&
        value.trim() === value &&
        !/[\x00-\x20\x7f]/.test(value),
      "invalid_configuration",
      "The Server URL is invalid.",
    );
    const url = new URL(value);
    requireCondition(
      ["http:", "https:"].includes(url.protocol) &&
        (profile === "development" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "invalid_configuration",
      "The Server URL is invalid.",
    );
    return url;
  } catch {
    throw invalid();
  }
}
export function validateAgentToken(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value))
    throw invalid();
  return value;
}
export function profileRoot(profile: Profile, home = homedir()): string {
  if (!(
    (profile === "production" || profile === "development") &&
    typeof home === "string" &&
    path.isAbsolute(home)
  ))
    throw invalid();
  return path.join(home, profile === "development" ? ".nexum-dev" : ".nexum");
}
export function loadProfileConfig(
  profile: Profile,
  home = homedir(),
): ProfileConfiguration {
  let file: number | undefined;
  try {
    const root = profileRoot(profile, realpathSync.native(home));
    const directory = lstatSync(root);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      realpathSync.native(root) !== root
    )
      throw invalid();
    const filename = path.join(root, "config.json"),
      before = lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink()) throw invalid();
    file = openSync(
      filename,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > 16384 ||
      realpathSync.native(root) !== root
    )
      throw invalid();
    if (
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()))
    )
      throw invalid();
    const bytes = Buffer.alloc(16385);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(file, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 16384) throw invalid();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.keys(value).every((key) =>
        ["server_url", "token", "storage", "retention"].includes(key),
      ) ||
      !Object.hasOwn(value, "server_url") ||
      !Object.hasOwn(value, "token")
    )
      throw invalid();
    const fields = value as Record<string, unknown>;
    const serverUrl = validateServerUrl(fields.server_url, profile).href;
    const token = validateAgentToken(fields.token);
    const storage = numericPolicy(fields.storage, ["max_managed_bytes"]);
    const retention = numericPolicy(
      fields.retention,
      [
        "work_idle_ms",
        "run_history_ms",
        "run_logs_ms",
        "input_attachments_ms",
        "artifact_ms",
        "material_copies_ms",
      ],
      true,
    );
    const configuration = {
      profile,
      root,
      serverUrl,
      ...(storage ? { storage } : {}),
      ...(retention ? { retention } : {}),
    } as ProfileConfiguration;
    Object.defineProperty(configuration, "token", {
      value: token,
      enumerable: false,
    });
    return Object.freeze(configuration);
  } catch {
    throw invalid();
  } finally {
    if (file !== undefined) {
      try {
        closeSync(file);
      } catch {
        throw invalid();
      }
    }
  }
}
