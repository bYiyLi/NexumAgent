import path from "node:path";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject, Profile } from "../contracts/types.js";
import {
  privateMaintenanceRead,
  privateMaintenanceWrite,
} from "../maintenance/credentials.js";
import { maintenanceText } from "../maintenance/files.js";
import type { VerifiedPackageSnapshot } from "../maintenance/npm.js";

const fileLimit = 32 * 1024 * 1024;
const recordLimit = 64 * 1024 * 1024;
const recordPath = ["packages.json"] as const;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
interface PackageRecord {
  version: 1;
  agentId: string;
  profile: Profile;
  root: string;
  approved: Record<string, string>;
  manifest: string;
  lock: string;
}
function name(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 214 &&
    packageName.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}
function version(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 256 && exactVersion.test(value)
  );
}
function document(value: unknown): Record<string, unknown> {
  requireCondition(
    typeof value === "string" && Buffer.byteLength(value) <= fileLimit,
    "package_approval_invalid",
    "Approved npm evidence needs bounded manifest and lock text.",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    /* Report no source text or parser details. */
  }
  requireCondition(
    isPlainRecord(parsed),
    "package_approval_invalid",
    "Approved npm evidence must contain JSON objects.",
  );
  return parsed;
}
function declared(manifest: Record<string, unknown>, target: string): boolean {
  return ["dependencies", "devDependencies", "optionalDependencies"].some(
    (group) =>
      isPlainRecord(manifest[group]) &&
      typeof manifest[group][target] === "string",
  );
}
/** A synchronous ModulePolicy callback must reject disk drift before returning any approval. */
function matches(filename: string, expected: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(
      filename,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = fstatSync(fd),
      bytes = Buffer.from(expected);
    if (
      !before.isFile() ||
      before.size !== bytes.length ||
      bytes.length > fileLimit
    )
      return false;
    const chunk = Buffer.allocUnsafe(65536);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, bytes.length - offset),
        null,
      );
      if (
        !count ||
        !chunk.subarray(0, count).equals(bytes.subarray(offset, offset + count))
      )
        return false;
      offset += count;
    }
    if (readSync(fd, chunk, 0, 1, null) !== 0) return false;
    const after = fstatSync(fd),
      current = lstatSync(filename);
    return (
      current.isFile() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      current.dev === after.dev &&
      current.ino === after.ino
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Private explicit package approvals; the work manifest and installed packages never grant approval. */
export class ApprovedPackageCatalog {
  #record: PackageRecord | null = null;
  #accepting = false;
  private constructor(
    readonly root: string,
    readonly binding: Readonly<{ agentId: string; profile: Profile }>,
    readonly reserve?: (bytes: number) => Promise<{ release(): void }>,
  ) {}
  static async open(
    root: string,
    binding: { agentId: string; profile: Profile },
    options: { reserve?: (bytes: number) => Promise<{ release(): void }> } = {},
  ): Promise<ApprovedPackageCatalog> {
    const actual = realpathSync.native(root);
    requireCondition(
      actual === root &&
        typeof binding.agentId === "string" &&
        binding.agentId.length > 0 &&
        Buffer.byteLength(binding.agentId) <= 256 &&
        !/[\0\r\n]/.test(binding.agentId) &&
        ["development", "production"].includes(binding.profile),
      "package_approval_invalid",
      "The package catalog must use its actual Agent/profile root and binding.",
    );
    const catalog = new ApprovedPackageCatalog(
      actual,
      Object.freeze({ ...binding }),
      options.reserve,
    );
    const saved = await privateMaintenanceRead(actual, recordPath, recordLimit);
    if (saved !== null) {
      requireCondition(
        saved.version === 1 &&
          saved.root === actual &&
          saved.agentId === binding.agentId &&
          saved.profile === binding.profile &&
          Object.keys(saved).every((key) =>
            [
              "version",
              "root",
              "agentId",
              "profile",
              "approved",
              "manifest",
              "lock",
            ].includes(key),
          ) &&
          isPlainRecord(saved.approved) &&
          Object.entries(saved.approved).every(
            ([key, value]) => name(key) && version(value),
          ),
        "package_approval_invalid",
        "Saved package approvals do not belong to this actual Agent/profile or contain invalid identities.",
      );
      document(saved.manifest);
      document(saved.lock);
      catalog.#record = saved as unknown as PackageRecord;
    }
    return catalog;
  }
  #work(): string {
    const work = path.join(this.root, "work");
    try {
      if (
        realpathSync.native(this.root) === this.root &&
        lstatSync(work).isDirectory() &&
        realpathSync.native(work) === work
      )
        return work;
    } catch {
      /* Do not expose private filesystem paths through system errors. */
    }
    throw new AgentError(
      "package_approval_changed",
      "The npm work directory cannot redirect away from this profile.",
    );
  }
  approvedPackages(): ReadonlyMap<string, string> {
    if (!this.#record) return new Map();
    try {
      const work = this.#work();
      if (
        matches(path.join(work, "package.json"), this.#record.manifest) &&
        matches(path.join(work, "package-lock.json"), this.#record.lock)
      )
        return new Map(Object.entries(this.#record.approved));
    } catch {
      /* An unreadable or redirected work tree grants no npm access. */
    }
    return new Map();
  }
  async accept(snapshot: VerifiedPackageSnapshot): Promise<void> {
    requireCondition(
      !this.#accepting,
      "package_approval_busy",
      "A verified package approval is already being saved.",
    );
    const fixed = JSON.parse(
      canonicalJson(snapshot, recordLimit),
    ) as VerifiedPackageSnapshot;
    requireCondition(
      isPlainRecord(fixed) &&
        Object.keys(fixed).every((key) =>
          ["target", "manifest", "lock"].includes(key),
        ) &&
        isPlainRecord(fixed.target) &&
        Object.keys(fixed.target).every((key) =>
          ["name", "action", "version"].includes(key),
        ) &&
        name(fixed.target.name) &&
        ["install", "update", "remove"].includes(fixed.target.action) &&
        (fixed.target.action === "remove"
          ? fixed.target.version === null
          : version(fixed.target.version)),
      "package_approval_invalid",
      "A package approval requires one explicit exact npm target.",
    );
    const manifest = document(fixed.manifest),
      lock = document(fixed.lock);
    const locked = isPlainRecord(lock.packages)
      ? lock.packages[`node_modules/${fixed.target.name}`]
      : undefined;
    requireCondition(
      fixed.target.action === "remove"
        ? !declared(manifest, fixed.target.name)
        : declared(manifest, fixed.target.name) &&
            isPlainRecord(locked) &&
            locked.version === fixed.target.version,
      "package_approval_invalid",
      "The verified manifest and lock must describe the explicit package target.",
    );
    this.#accepting = true;
    try {
      const work = this.#work();
      let actual: readonly (string | null)[];
      try {
        actual = await Promise.all([
          maintenanceText(path.join(work, "package.json"), fileLimit),
          maintenanceText(path.join(work, "package-lock.json"), fileLimit),
        ]);
      } catch {
        throw new AgentError(
          "package_approval_changed",
          "The actual npm files could not be safely verified.",
        );
      }
      requireCondition(
        this.#work() === work &&
          actual[0] === fixed.manifest &&
          actual[1] === fixed.lock,
        "package_approval_changed",
        "The npm files changed after the approved installation was verified.",
      );
      const approved = new Map(Object.entries(this.#record?.approved ?? {}));
      if (fixed.target.action === "remove") approved.delete(fixed.target.name);
      else approved.set(fixed.target.name, fixed.target.version!);
      const record: PackageRecord = {
        version: 1,
        agentId: this.binding.agentId,
        profile: this.binding.profile,
        root: this.root,
        approved: Object.fromEntries(approved),
        manifest: fixed.manifest,
        lock: fixed.lock,
      };
      await privateMaintenanceWrite(
        this.root,
        recordPath,
        record as unknown as JsonObject,
        false,
        this.reserve,
      );
      this.#record = record;
    } finally {
      this.#accepting = false;
    }
  }
}
