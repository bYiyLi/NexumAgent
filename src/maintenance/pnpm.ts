import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import type { Profile } from "../contracts/types.js";
import type {
  MaintenanceBackend, MaintenanceIntent, MaintenanceResult,
  MaintenanceScope, PreparedMaintenance,
} from "./requests.js";

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const initialVersion = /^(?:[~^])?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$|^(?:latest|next)$/;
const fileLimit = 1024 * 1024;
const revisionOf = (body: string) =>
  createHash("sha256").update(body).digest("hex");

type DirectManifest = {
  private?: boolean;
  type?: string;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

/** The existing SDK request and Cloud approval page own the user's one-time
 * permission to add/update/remove a package. This backend does not approve or
 * install package versions. It edits the single work/package.json; the Cloud
 * bootstrap reconciles dependencies on the next OS-managed start.
 *
 * Manual edits to package.json are equally valid and need no approval record.
 */
export class PnpmMaintenanceBackend implements MaintenanceBackend {
  readonly root: string;
  readonly work: string;

  constructor(readonly options: { root: string; profile: Profile }) {
    this.root = realpathSync.native(options.root);
    this.work = realpathSync.native(path.join(this.root, "work"));
    requireCondition(this.root === options.root &&
      ["production", "development"].includes(options.profile),
      "maintenance_profile_mismatch",
      "The package request must use this Agent's work directory.");
  }

  #validate(intent: MaintenanceIntent): void {
    requireCondition(intent.target === "package" &&
      ["install", "update", "remove"].includes(intent.action) &&
      intent.name !== "@nexum-hub/agent" &&
      packageName.test(intent.name) && intent.name.length <= 214 &&
      (intent.version === undefined || initialVersion.test(intent.version)),
      "invalid_package",
      "Choose one direct npm package and an optional initial version.");
  }

  async #read(): Promise<{ manifest: DirectManifest; body: string; revision: string }> {
    requireCondition(realpathSync.native(this.root) === this.root &&
      realpathSync.native(this.work) === this.work,
      "maintenance_profile_mismatch", "The Agent work directory changed.");
    const filename = path.join(this.work, "package.json");
    const stat = lstatSync(filename);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= fileLimit,
      "invalid_package_manifest", "The package manifest is not a regular file.");
    const body = await readFile(filename, "utf8");
    const manifest: DirectManifest = JSON.parse(body);
    requireCondition(manifest && typeof manifest === "object" &&
      !Array.isArray(manifest) && (!manifest.dependencies ||
        (typeof manifest.dependencies === "object" &&
          !Array.isArray(manifest.dependencies))),
      "invalid_package_manifest", "The package manifest must contain dependencies.");
    return { manifest, body, revision: revisionOf(body) };
  }

  async prepare(intent: MaintenanceIntent, scope: MaintenanceScope): Promise<PreparedMaintenance> {
    this.#validate(intent);
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    const existing = await this.#read();
    const declared = typeof existing.manifest.dependencies?.[intent.name] === "string";
    requireCondition(intent.action === "install" ? !declared : declared,
      intent.action === "install" ? "package_already_declared" : "package_not_installed",
      "Use install for a new package, or update/remove for a declared package.");
    const manifest: DirectManifest = JSON.parse(existing.body);
    manifest.dependencies ??= {};
    const requested = intent.action === "remove" ? null :
      intent.version ?? (this.options.profile === "development" &&
        intent.name.startsWith("@nexum-hub/") ? "next" : "latest");
    if (requested === null) delete manifest.dependencies[intent.name];
    else manifest.dependencies[intent.name] = requested;
    const next = JSON.stringify(manifest, null, 2) + "\n";
    requireCondition(Buffer.byteLength(next) <= fileLimit,
      "invalid_package_manifest", "The package manifest is too large.");
    return {
      objectId: declared ? "npm:" + intent.name : null,
      baseRevision: existing.revision,
      authStatus: "not_required",
      summary: {
        changeKinds: ["package", "dependency",
          ...(intent.action === "remove" ? ["remove"] : [])],
        permissions: [], version: requested, namespace: null,
        restartMayBeRequired: true,
      },
      payload: {
        name: intent.name, action: intent.action,
        initialVersion: requested, manifest: next,
      },
    };
  }

  async verify(intent: MaintenanceIntent, candidate: PreparedMaintenance,
    scope: MaintenanceScope): Promise<void> {
    this.#validate(intent);
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    const actual = await this.#read();
    const payload = candidate.payload;
    requireCondition(candidate.baseRevision === actual.revision &&
      payload.name === intent.name && payload.action === intent.action &&
      typeof payload.manifest === "string" &&
      Buffer.byteLength(payload.manifest) <= fileLimit,
      "npm_plan_changed", "The package manifest changed after the SDK request.");
    const next = JSON.parse(payload.manifest) as DirectManifest;
    const expected = next.dependencies?.[intent.name] ?? null;
    requireCondition(intent.action === "remove" ? expected === null :
      expected === payload.initialVersion &&
      typeof expected === "string" && initialVersion.test(expected),
      "npm_plan_changed", "The requested initial package version changed.");
  }

  async apply(intent: MaintenanceIntent, candidate: PreparedMaintenance,
    scope: MaintenanceScope): Promise<MaintenanceResult> {
    await this.verify(intent, candidate, scope);
    const current = await this.#read();
    const filename = path.join(this.work, "package.json");
    const next = candidate.payload.manifest as string;
    const changed = current.body !== next;
    if (changed) {
      const temporary = filename + ".new-" + randomUUID();
      try {
        await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
        scope.signal.throwIfAborted();
        authorizeCall(() => scope.assertCurrent());
        requireCondition((await this.#read()).revision === candidate.baseRevision,
          "npm_plan_changed", "The package manifest changed during the request.");
        await rename(temporary, filename);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    // An update request can also be used to retry a failed bootstrap without
    // changing a dependency specifier. The OS-owned restart performs the work.
    return {
      changed,
      restartRequired: changed || intent.action === "update",
      package: {
        name: intent.name,
        declared: intent.action !== "remove",
        installedVersion: null,
      },
      extension: null,
    };
  }
}
