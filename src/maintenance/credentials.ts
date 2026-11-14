import path from "node:path";
import { constants, lstatSync, realpathSync } from "node:fs";
import { open, rename, rm, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { privateDirectory } from "../runtime/paths.js";
import type { JsonObject } from "../contracts/types.js";

export type CredentialBinding = JsonObject;
/** Trusted Core storage admission, never supplied by a draft or credential value. */
export type MaintenanceSpaceReserve = (
  bytes: number,
) => Promise<{ release(): void }>;
const maximum = 64 * 1024 * 1024;
const credentialMaximum = 4 * 1024 * 1024;
const copy = (value: JsonObject): JsonObject =>
  JSON.parse(canonicalJson(value, credentialMaximum)) as JsonObject;
const valid = (part: string): boolean =>
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}$/.test(part) &&
  part !== "." &&
  part !== "..";
function filename(root: string, parts: readonly string[]): string {
  requireCondition(
    parts.length > 0 && parts.length <= 8 && parts.every(valid),
    "credential_path_invalid",
    "Use fixed private maintenance file identities.",
  );
  const directory = privateDirectory(
    root,
    "state",
    "maintenance",
    ...parts.slice(0, -1),
  );
  requireCondition(
    realpathSync.native(directory) === directory,
    "credential_path_invalid",
    "Private maintenance directories cannot redirect.",
  );
  return path.join(directory, parts.at(-1)!);
}
function verifyFile(
  file: { isFile(): boolean; nlink: number; mode: number; size: number },
  limit: number,
): void {
  requireCondition(
    file.isFile() &&
      file.nlink === 1 &&
      file.size <= limit &&
      (process.platform === "win32" || (file.mode & 0o077) === 0),
    "credential_file_invalid",
    "Private maintenance data must be a bounded owner-only regular file without hard links.",
  );
}
/** Only trusted maintenance components use this store; values never enter public drafts. */
export async function privateMaintenanceRead(
  root: string,
  parts: readonly string[],
  limit = maximum,
): Promise<JsonObject | null> {
  const location = filename(root, parts);
  let handle;
  try {
    handle = await open(
      location,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AgentError(
      "credential_file_invalid",
      "Private maintenance data could not be opened safely.",
    );
  }
  try {
    const before = await handle.stat();
    verifyFile(before, limit);
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, limit - length + 1));
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
      requireCondition(
        length <= limit,
        "credential_file_invalid",
        "Private maintenance data exceeds its byte budget.",
      );
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(),
      current = await lstat(location);
    verifyFile(after, limit);
    verifyFile(current, limit);
    requireCondition(
      before.ino === after.ino &&
        before.dev === after.dev &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        current.ino === after.ino &&
        current.dev === after.dev &&
        realpathSync.native(path.dirname(location)) === path.dirname(location),
      "credential_file_changed",
      "Private maintenance data changed while being read.",
    );
    let result: unknown;
    try {
      result = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, length),
        ),
      );
    } catch {
      throw new AgentError(
        "credential_file_invalid",
        "Private maintenance data is not valid UTF-8 JSON.",
      );
    }
    requireCondition(
      isPlainRecord(result),
      "credential_file_invalid",
      "Private maintenance data needs one JSON object.",
    );
    return JSON.parse(canonicalJson(result, limit)) as JsonObject;
  } finally {
    await handle.close();
  }
}
export async function privateMaintenanceWrite(
  root: string,
  parts: readonly string[],
  value: JsonObject,
  exclusive = false,
  reserve?: MaintenanceSpaceReserve,
): Promise<void> {
  const text = canonicalJson(value, maximum),
    reservation = await reserve?.(Buffer.byteLength(text) + 1024);
  let handle: Awaited<ReturnType<typeof open>> | undefined,
    temporary: string | undefined;
  try {
    const location = filename(root, parts),
      directory = path.dirname(location);
    const existing = lstatSync(location, { throwIfNoEntry: false });
    if (existing) verifyFile(existing, maximum);
    requireCondition(
      !exclusive || !existing,
      "credential_file_exists",
      "Private maintenance identity already exists.",
    );
    temporary = path.join(
      directory,
      `.private-${randomBytes(24).toString("hex")}`,
    );
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(text, "utf8");
    await handle.sync();
    verifyFile(await handle.stat(), maximum);
    requireCondition(
      realpathSync.native(directory) === directory,
      "credential_path_invalid",
      "Private maintenance directories changed while saving.",
    );
    const current = lstatSync(location, { throwIfNoEntry: false });
    if (current) verifyFile(current, maximum);
    requireCondition(
      !exclusive || !current,
      "credential_file_exists",
      "Private maintenance identity already exists.",
    );
    requireCondition(
      (!existing && !current) ||
        (existing &&
          current &&
          existing.dev === current.dev &&
          existing.ino === current.ino &&
          existing.mtimeMs === current.mtimeMs &&
          existing.ctimeMs === current.ctimeMs),
      "credential_file_changed",
      "Private maintenance data changed before replacement.",
    );
    await handle.close();
    await rename(temporary, location);
  } finally {
    try {
      await handle?.close().catch(() => {});
      if (temporary) await rm(temporary, { force: true });
    } finally {
      reservation?.release();
    }
  }
}

/** Persistent profile-private credential references. User replacements create new refs. */
export class CredentialVault {
  #writing = new Map<string, Promise<void>>();
  private constructor(
    readonly root: string,
    readonly reserve?: MaintenanceSpaceReserve,
  ) {}
  static async open(
    root: string,
    options: { reserve?: MaintenanceSpaceReserve } = {},
  ): Promise<CredentialVault> {
    const canonical = realpathSync.native(root);
    requireCondition(
      canonical === root,
      "credential_path_invalid",
      "Credential vault needs the established profile root.",
    );
    privateDirectory(canonical, "state", "maintenance", "credentials");
    return new CredentialVault(canonical, options.reserve);
  }
  async create(binding: CredentialBinding, value: JsonObject): Promise<string> {
    const fixedBinding = copy(binding),
      fixedValue = copy(value),
      ref = `cred_${randomBytes(24).toString("hex")}`;
    requireCondition(
      Object.keys(fixedBinding).length > 0,
      "credential_binding_invalid",
      "Credentials require a fixed owner/profile/target binding.",
    );
    await privateMaintenanceWrite(
      this.root,
      ["credentials", `${ref}.json`],
      { binding: fixedBinding, value: fixedValue },
      true,
      this.reserve,
    );
    return ref;
  }
  #ref(ref: string): string {
    requireCondition(
      /^cred_[a-f0-9]{48}$/.test(ref),
      "credential_reference_invalid",
      "Use an existing protected credential reference.",
    );
    return `${ref}.json`;
  }
  async read(ref: string, binding: CredentialBinding): Promise<JsonObject> {
    const value = await privateMaintenanceRead(
      this.root,
      ["credentials", this.#ref(ref)],
      credentialMaximum,
    );
    requireCondition(
      value &&
        isPlainRecord(value.binding) &&
        isPlainRecord(value.value) &&
        canonicalJson(value.binding) === canonicalJson(binding),
      "credential_binding_mismatch",
      "The credential reference is unavailable for this owner/profile/target binding.",
    );
    return copy(value.value as JsonObject);
  }
  /** Token refresh only. Callers must preserve the approved immutable binding. */
  async update(
    ref: string,
    binding: CredentialBinding,
    value: JsonObject,
  ): Promise<void> {
    const file = this.#ref(ref),
      fixedBinding = copy(binding),
      fixedValue = copy(value),
      previous = this.#writing.get(ref) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        await this.read(ref, fixedBinding);
        await privateMaintenanceWrite(
          this.root,
          ["credentials", file],
          {
            binding: fixedBinding,
            value: fixedValue,
          },
          false,
          this.reserve,
        );
      });
    this.#writing.set(ref, work);
    try {
      await work;
    } finally {
      if (this.#writing.get(ref) === work) this.#writing.delete(ref);
    }
  }
}
