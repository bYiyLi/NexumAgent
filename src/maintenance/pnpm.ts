import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireCondition } from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import type { Profile } from "../contracts/types.js";
import { defaultEofAlreadyClosed, type ProcessBackend } from "../process/backend.js";
import type { ResourceManager } from "../extensions/resources.js";
import { maintenanceOrigin } from "./requests.js";
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

/** Approved package changes install immediately into the existing managed
 * work tree. The native supervisor can reuse these bytes at its next start.
 */
export class PnpmMaintenanceBackend implements MaintenanceBackend {
  readonly root: string;
  readonly work: string;

  constructor(readonly options: {
    root: string;
    profile: Profile;
    resources: ResourceManager;
    withPackageChanges: <T>(action: () => Promise<T>) => Promise<T>;
  }) {
    this.root = realpathSync.native(options.root);
    this.work = realpathSync.native(path.join(this.root, "work"));
    requireCondition(this.root === options.root &&
      ["production", "development"].includes(options.profile),
      "maintenance_profile_mismatch",
      "The package request must use this Agent's work directory.");
  }

  #pnpm(): string {
    return process.platform === "win32"
      ? path.join(this.root, "runtime", "node_modules", "pnpm", "bin", "pnpm.cjs")
      : path.join(this.root, "runtime", "lib", "node_modules", "pnpm", "bin", "pnpm.cjs");
  }

  async #command(args: readonly string[], scope: MaintenanceScope): Promise<void> {
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    const cli = this.#pnpm();
    requireCondition(
      existsSync(cli) && lstatSync(cli).isFile(),
      "pnpm_unavailable",
      "The managed pnpm CLI is unavailable.",
    );
    const backend: ProcessBackend = process.platform === "win32"
      ? new (await import("../process/windows-pipes.js")).WindowsProcessBackend({
          onOutput: async () => {},
        })
      : new (await import("../process/pipes.js")).PipeProcessBackend({
          onOutput: async () => {},
        });
    const owner = this.options.resources.instance(
      { ...maintenanceOrigin, operationId: scope.operationId },
      {
        signal: scope.signal,
        assertActive: () => authorizeCall(() => scope.assertCurrent()),
        authorize: () => authorizeCall(() => scope.assertCurrent()),
      },
    );
    let registered = false;
    try {
      await owner.resources.register({ kind: "maintenance.command", value: backend });
      registered = true;
      await backend.start({
        file: process.execPath,
        args: [cli, "--dir", this.work, ...args],
        cwd: this.work,
        env: {
          ...process.env,
          CI: "true",
          NEXUM_CLOUD_BOOTSTRAP: "1",
          npm_config_registry: "https://registry.npmjs.org/",
        },
        tty: false,
        cols: 80,
        rows: 24,
      });
      try {
        await backend.write(new Uint8Array(), true, scope.signal);
      } catch (cause) {
        scope.signal.throwIfAborted();
        if (backend.failure !== undefined ||
          !defaultEofAlreadyClosed(cause, backend.facts())) throw cause;
      }
      await backend.closed;
      const facts = backend.facts();
      requireCondition(
        facts.closed && facts.treeStopped && facts.outputComplete,
        "process_stop_unconfirmed",
        "The managed pnpm process has not completely exited.",
      );
      scope.signal.throwIfAborted();
      requireCondition(
        !backend.failure && facts.exitCode === 0,
        "pnpm_command_failed",
        "The approved pnpm operation did not complete successfully.",
        { exitCode: facts.exitCode },
      );
      authorizeCall(() => scope.assertCurrent());
    } finally {
      if (!registered) await backend.dispose();
      const cleanup = await owner.stop();
      requireCondition(
        cleanup.unconfirmed.length === 0,
        "process_stop_unconfirmed",
        "The managed pnpm process has unconfirmed cleanup.",
      );
    }
  }

  async #installed(name: string): Promise<string | null> {
    const modules = path.join(this.work, "node_modules");
    const location = path.join(modules, ...name.split("/"));
    let actual: string;
    try {
      actual = realpathSync.native(location);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
    const relative = path.relative(modules, actual);
    requireCondition(
      relative !== ".." && !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative),
      "pnpm_install_invalid",
      "The installed package is outside this Agent work directory.",
    );
    const parsed = JSON.parse(await readFile(path.join(actual, "package.json"), "utf8"));
    requireCondition(
      parsed?.name === name && typeof parsed.version === "string" &&
        parsed.version.length > 0,
      "pnpm_install_invalid",
      "The installed package does not match the approved dependency.",
    );
    return parsed.version;
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
    return this.options.withPackageChanges(() => this.#apply(intent, candidate, scope));
  }

  async #apply(intent: MaintenanceIntent, candidate: PreparedMaintenance,
    scope: MaintenanceScope): Promise<MaintenanceResult> {
    await this.verify(intent, candidate, scope);
    const current = await this.#read();
    const previousVersion = await this.#installed(intent.name);
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
    await this.#command(
      intent.action === "update"
        ? ["update", intent.name]
        : ["install", "--no-frozen-lockfile"],
      scope,
    );
    const installedVersion = await this.#installed(intent.name);
    const finalManifest = await this.#read();
    requireCondition(
      finalManifest.manifest.dependencies?.[intent.name] ===
        (intent.action === "remove" ? undefined : candidate.payload.initialVersion),
      "pnpm_install_invalid",
      "The installed dependency declaration differs from the approved request.",
    );
    requireCondition(
      existsSync(path.join(this.work, "pnpm-lock.yaml")) &&
        lstatSync(path.join(this.work, "pnpm-lock.yaml")).isFile() &&
        (intent.action === "remove" ? installedVersion === null : installedVersion !== null),
      "pnpm_install_invalid",
      "pnpm did not leave the expected installed package and lockfile.",
    );
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    const packageChanged = changed || previousVersion !== installedVersion;
    return {
      changed: packageChanged,
      restartRequired: packageChanged,
      package: {
        name: intent.name,
        declared: intent.action !== "remove",
        installedVersion,
      },
      extension: null,
    };
  }
}
