import path from "node:path";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile, rename, rm, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { canonicalJson, isPlainRecord, newId } from "../contracts/json.js";
import { privateDirectory } from "../runtime/paths.js";
import { maintenanceText } from "./files.js";
import { authorizeCall } from "../contracts/caller.js";
import type {
  ProcessBackend,
  ProcessBackendOptions,
} from "../process/backend.js";
import { maintenanceOrigin } from "./requests.js";
import type { JsonObject } from "../contracts/types.js";
import { ExtensionServices } from "../services/extensions.js";
import {
  inspectExtensionPackage,
  type ExtensionPackageDescriptor,
} from "../extensions/packages.js";
import type { ModuleLoader } from "../runtime/modules.js";
import type { MaintenanceSpaceReserve } from "./credentials.js";
import type {
  MaintenanceBackend,
  MaintenanceIntent,
  PreparedMaintenance,
  MaintenanceScope,
  MaintenanceResult,
  MaintenanceDraft,
  MaintenanceDraftInput,
  MaintenanceOAuthBinding,
  MaintenanceOAuthLaunch,
  MaintenanceOAuthComplete,
  MaintenanceOAuthScope,
} from "./requests.js";

const cap = 32 * 1024 * 1024;
// Runs in the existing managed native-child path. npm owns configuration and
// dependency resolution; only the Agent parent is allowed to save root records.
const npmPlannerSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const failure = code => Object.assign(new Error(code), { safeCode: code });
let sourceReady = false;
(async () => {
  const cli = fs.realpathSync(process.argv[1]);
  const root = fs.realpathSync(path.resolve(path.dirname(cli), '..'));
  const fromNpm = createRequire(cli);
  const npmPackage = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(npmPackage, 'utf8'));
  if (pkg.name !== 'npm' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg.version)) throw failure('npm_planner_unsupported');
  const files = [cli, npmPackage];
  const resolve = specifier => {
    const filename = fs.realpathSync(fromNpm.resolve(specifier));
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw failure('npm_planner_unsupported');
    files.push(filename); return filename;
  };
  const arbEntry = resolve('@npmcli/arborist');
  const arbPackage = resolve('@npmcli/arborist/package.json');
  const configEntry = resolve('@npmcli/config');
  const configPackage = resolve('@npmcli/config/package.json');
  const definitionsEntry = resolve('@npmcli/config/lib/definitions');
  const Arborist = fromNpm(arbEntry), Config = fromNpm(configEntry);
  const definitions = fromNpm(definitionsEntry);
  if (typeof Arborist.prototype.lockfileString !== 'function' || typeof Config !== 'function' ||
      typeof definitions.flatten !== 'function' || !definitions.definitions || !definitions.shorthands) throw failure('npm_planner_unsupported');
  const fingerprint = () => {
    const digest = createHash('sha256').update(root);
    for (const filename of files) digest.update('\0').update(fs.readFileSync(filename));
    return digest.digest('hex');
  };
  const source = {
    npmVersion: pkg.version,
    arboristVersion: JSON.parse(fs.readFileSync(arbPackage, 'utf8')).version,
    configurationVersion: JSON.parse(fs.readFileSync(configPackage, 'utf8')).version,
    revision: fingerprint(),
  };
  sourceReady = true;
  if (process.argv[2] === 'source') { process.stdout.write(JSON.stringify({ source })); return; }
  const maximum = Number(process.argv[6]);
  const config = new Config({ npmPath: root, ...definitions, cwd: process.cwd(), env: process.env,
    argv: [process.execPath, cli, '--global=false', '--prefix=' + process.cwd(), '--workspaces=false', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund'] });
  await config.load(); config.validate();
  const arb = new Arborist({ ...config.flat, path: process.cwd(), global: false, workspaces: [], workspacesEnabled: false, ignoreScripts: true, audit: false, fund: false });
  const lock = await arb.lockfileString(process.argv[3] === 'remove'
    ? { rm: [process.argv[4]] } : { add: [process.argv[4] + '@' + process.argv[5]] });
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const ideal = arb.idealTree.package;
  for (const key of ['dependencies','devDependencies','optionalDependencies','peerDependencies','peerDependenciesMeta','bundleDependencies','bundledDependencies']) {
    if (Object.hasOwn(ideal, key)) manifest[key] = ideal[key]; else delete manifest[key];
  }
  const body = JSON.stringify(manifest, null, 2) + '\n';
  if (!Number.isSafeInteger(maximum) || maximum < 1 || Buffer.byteLength(body) > maximum || Buffer.byteLength(lock) > maximum) throw failure('npm_plan_too_large');
  if (fingerprint() !== source.revision) throw failure('npm_planner_changed');
  const result = Buffer.from(JSON.stringify({ source, manifest: body, lock }));
  for (let offset = 0; offset < result.length; offset += 65536)
    if (!process.stdout.write(result.subarray(offset, offset + 65536))) await once(process.stdout, 'drain');
})().catch(error => {
  const code = ['npm_planner_unsupported','npm_plan_too_large','npm_planner_changed'].includes(error.safeCode) ? error.safeCode : sourceReady ? 'npm_plan_failed' : 'npm_planner_unsupported';
  process.stdout.write(JSON.stringify({ error: code }));
});
`;
const hash = (value: string | null): string =>
  createHash("sha256")
    .update(value === null ? "missing" : `present:${value}`)
    .digest("hex");
const textFile = (filename: string, optional = false): Promise<string | null> =>
  maintenanceText(filename, cap, optional);
function declaration(value: ExtensionPackageDescriptor): JsonObject {
  const scripts = value.materials.scripts?.entries ?? [],
    skills = value.materials.skills?.entries ?? [];
  return {
    namespace: value.source.origin.namespace,
    version: value.version,
    revision: value.revision,
    permissions: [...value.source.permissions],
    entry: value.entry.relativePath,
    types: value.types.relativePath,
    docs: {
      directory: value.materials.docs.relativePath,
      fileCount: value.materials.docs.files.length,
    },
    instructions: value.materials.instructions?.relativePath ?? null,
    scripts: {
      names: scripts.slice(0, 200).map((item) => item.scriptName),
      count: scripts.length,
      complete: scripts.length <= 200,
    },
    skills: {
      names: skills.slice(0, 200).map((item) => item.publicName),
      count: skills.length,
      complete: skills.length <= 200,
    },
  };
}
async function replace(
  filename: string,
  body: string,
  reserve?: MaintenanceSpaceReserve,
): Promise<void> {
  const reservation = await reserve?.(Buffer.byteLength(body) + 1024);
  let temp: string | undefined;
  try {
    const current = await lstat(filename).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    requireCondition(
      !current || current.isFile(),
      "maintenance_path_invalid",
      "Maintenance cannot replace a linked or special target.",
    );
    temp = `${filename}.${newId("tmp")}`;
    await writeFile(temp, body, { mode: current?.mode ?? 0o600, flag: "wx" });
    await rename(temp, filename);
  } finally {
    try {
      if (temp) await rm(temp, { force: true });
    } finally {
      reservation?.release();
    }
  }
}
type EnablementState = Record<
  string,
  { enabled: boolean; objectId: string; revision: string; config: JsonObject }
>;
export class ExtensionEnablement {
  #state: EnablementState = {};
  private constructor(
    readonly root: string,
    readonly reserve?: MaintenanceSpaceReserve,
  ) {}
  static async open(
    root: string,
    options: { reserve?: MaintenanceSpaceReserve } = {},
  ): Promise<ExtensionEnablement> {
    const value = new ExtensionEnablement(
        realpathSync.native(root),
        options.reserve,
      ),
      body = await textFile(
        path.join(value.root, "state", "maintenance", "extensions.json"),
        true,
      );
    if (body) {
      const parsed = JSON.parse(body);
      requireCondition(
        isPlainRecord(parsed),
        "invalid_extension_intent",
        "The saved extension enablement is invalid.",
      );
      value.#state = parsed as EnablementState;
    }
    return value;
  }
  enabled(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#state)
        .filter(([, value]) => value.enabled)
        .map(([name]) => name),
    );
  }
  get(name: string): {
    enabled: boolean;
    objectId: string;
    revision: string;
    config: JsonObject;
  } | null {
    const value = this.#state[name];
    return value ? JSON.parse(canonicalJson(value)) : null;
  }
  async set(
    name: string,
    enabled: boolean,
    config: JsonObject,
    expectedRevision: string | null,
    options: { reserved?: boolean } = {},
  ): Promise<void> {
    const existing = this.get(name);
    requireCondition(
      (existing?.revision ?? null) === expectedRevision,
      "maintenance_precondition_changed",
      "Extension enablement changed after user confirmation.",
    );
    const value = {
      enabled,
      objectId: existing?.objectId ?? newId("extension"),
      revision: newId("revision"),
      config: JSON.parse(canonicalJson(config)) as JsonObject,
    };
    const next = { ...this.#state, [name]: value },
      file = path.join(
        privateDirectory(this.root, "state", "maintenance"),
        "extensions.json",
      );
    await replace(
      file,
      canonicalJson(next),
      options.reserved ? undefined : this.reserve,
    );
    this.#state = next;
  }
}
export interface NpmMaintenanceOptions {
  readonly root: string;
  readonly modules: ModuleLoader;
  readonly extensions: ExtensionServices;
  readonly enablement: ExtensionEnablement;
  readonly npmCli?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly reserve?: MaintenanceSpaceReserve;
  /** Persist only the verified explicit target, then rebuild approved npm discovery/docs. */
  readonly refreshPackages: (
    snapshot: VerifiedPackageSnapshot,
  ) => void | Promise<void>;
}
/** Core-only approval evidence after actual npm files and target installation were verified. */
export interface VerifiedPackageSnapshot {
  readonly target: {
    readonly name: string;
    readonly action: "install" | "update" | "remove";
    readonly version: string | null;
  };
  readonly manifest: string;
  readonly lock: string;
}
/** Native npm planning/apply plus the existing extension lifecycle; no alternate resolver. */
export class NpmMaintenanceBackend implements MaintenanceBackend {
  readonly work: string;
  readonly root: string;
  #busy = false;
  #commands = new Set<ProcessBackend>();
  constructor(readonly options: NpmMaintenanceOptions) {
    this.root = realpathSync.native(options.root);
    this.work = realpathSync.native(path.join(this.root, "work"));
    requireCondition(
      options.modules.work === this.work &&
        options.extensions.packages.modules === options.modules &&
        options.enablement.root === this.root,
      "maintenance_profile_mismatch",
      "Package maintenance must use this actual work loader, extensions and profile.",
    );
  }
  async #command(
    args: readonly string[],
    cwd: string,
    scope: MaintenanceScope,
  ): Promise<string> {
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    // registry/auth still follow native npm configuration. Its installation
    // target cannot follow a user global/prefix/workspace override.
    return await this.#child(
      [
        this.#npmCli(),
        ...args,
        "--global=false",
        `--prefix=${cwd}`,
        "--workspaces=false",
      ],
      cwd,
      scope,
    );
  }
  #npmCli(): string {
    const cli =
      this.options.npmCli ??
      (process.platform === "win32"
        ? path.join(
            path.dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          )
        : path.resolve(
            path.dirname(process.execPath),
            "..",
            "lib",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ));
    requireCondition(
      path.isAbsolute(cli),
      "npm_unavailable",
      "Native npm requires its actual absolute CLI entry.",
    );
    return cli;
  }
  async #child(
    args: readonly string[],
    cwd: string,
    scope: MaintenanceScope,
    maximum = 1024 * 1024,
  ): Promise<string> {
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    const decoder = new StringDecoder("utf8");
    let output = "",
      size = 0;
    const options: ProcessBackendOptions = {
      onOutput: async (stream, bytes) => {
        if (stream !== "stdout") return;
        size += bytes.length;
        requireCondition(
          size <= maximum,
          "npm_output_too_large",
          "Native npm output exceeds its bounded control response.",
        );
        output += decoder.write(bytes);
      },
    };
    const backend: ProcessBackend =
      process.platform === "win32"
        ? new (
            await import("../process/windows-pipes.js")
          ).WindowsProcessBackend(options)
        : new (await import("../process/pipes.js")).PipeProcessBackend(options);
    const owner = this.options.extensions.registry.resources.instance(
      { ...maintenanceOrigin, operationId: scope.operationId },
      {
        signal: scope.signal,
        assertActive: () => authorizeCall(() => scope.assertCurrent()),
        authorize: () => authorizeCall(() => scope.assertCurrent()),
      },
    );
    this.#commands.add(backend);
    void backend.closed.then(
      () => this.#commands.delete(backend),
      () => {},
    );
    let registered = false;
    try {
      await owner.resources.register({
        kind: "maintenance.command",
        value: backend,
      });
      registered = true;
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        ...process.env,
        ...this.options.env,
      }))
        if (typeof value === "string") env[key] = value;
      await backend.start({
        file: process.execPath,
        args,
        cwd,
        env,
        tty: false,
        cols: 80,
        rows: 24,
      });
      await backend.write(new Uint8Array(), true, scope.signal);
      await backend.closed;
      const facts = backend.facts();
      requireCondition(
        facts.closed && facts.treeStopped && facts.outputComplete,
        "process_stop_unconfirmed",
        "The native npm process tree and output have not actually closed.",
      );
      if (scope.signal.aborted)
        throw new AgentError(
          "maintenance_cancelled",
          "The native npm process tree closed after a cancellation request.",
        );
      requireCondition(
        !backend.failure && facts.exitCode === 0,
        "npm_command_failed",
        "Native npm did not complete the confirmed operation.",
        { exitCode: facts.exitCode },
      );
      authorizeCall(() => scope.assertCurrent());
      return output + decoder.end();
    } finally {
      if (!registered) await backend.dispose();
      const cleanup = await owner.stop();
      requireCondition(
        cleanup.unconfirmed.length === 0,
        "process_stop_unconfirmed",
        "A native maintenance command has unconfirmed process-tree cleanup.",
      );
    }
  }
  async #planner(
    mode: "source" | "plan",
    cwd: string,
    scope: MaintenanceScope,
    intent?: MaintenanceIntent,
    version?: string | null,
  ): Promise<{
    source: JsonObject;
    manifest: string | null;
    lock: string | null;
  }> {
    const output = await this.#child(
      [
        "--input-type=commonjs",
        "--eval",
        npmPlannerSource,
        this.#npmCli(),
        mode,
        intent?.action ?? "",
        intent?.name ?? "",
        version ?? "",
        String(cap),
      ],
      cwd,
      scope,
      mode === "plan" ? 4 * cap + 4096 : 16384,
    );
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      /* No producer text or parser details leave this boundary. */
    }
    requireCondition(
      isPlainRecord(value),
      "npm_plan_invalid",
      "Native npm did not return one bounded planning result.",
    );
    if (
      [
        "npm_planner_unsupported",
        "npm_plan_too_large",
        "npm_plan_failed",
        "npm_planner_changed",
      ].includes(value.error as string)
    )
      throw new AgentError(
        value.error as string,
        value.error === "npm_planner_unsupported"
          ? "The selected npm distribution does not provide the supported in-memory planning API."
          : value.error === "npm_plan_too_large"
            ? "The native npm manifest or lock exceeds the managed planning byte limit; no generated root file was saved."
            : value.error === "npm_planner_changed"
              ? "The selected npm distribution changed during planning; no generated root file was saved."
              : "Native npm could not prepare the dependency plan; protected source and registry details were not exposed.",
      );
    const source = value.source;
    requireCondition(
      isPlainRecord(source) &&
        Object.keys(source).length === 4 &&
        ["npmVersion", "arboristVersion", "configurationVersion"].every(
          (key) =>
            typeof source[key] === "string" &&
            /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
              source[key] as string,
            ),
        ) &&
        typeof source.revision === "string" &&
        /^[0-9a-f]{64}$/.test(source.revision) &&
        Object.keys(value).every((key) =>
          ["source", "manifest", "lock"].includes(key),
        ) &&
        (mode === "source" ||
          (typeof value.manifest === "string" &&
            typeof value.lock === "string" &&
            Buffer.byteLength(value.manifest) <= cap &&
            Buffer.byteLength(value.lock) <= cap)),
      "npm_plan_invalid",
      "Native npm source evidence and generated root records must match their bounded contract.",
    );
    return {
      source: source as JsonObject,
      manifest: mode === "plan" ? (value.manifest as string) : null,
      lock: mode === "plan" ? (value.lock as string) : null,
    };
  }
  async #files(): Promise<{
    manifest: string;
    lock: string | null;
    npmrc: string | null;
    revision: string;
  }> {
    const manifest = (await textFile(path.join(this.work, "package.json")))!,
      lock = await textFile(path.join(this.work, "package-lock.json"), true),
      npmrc = await textFile(path.join(this.work, ".npmrc"), true);
    return {
      manifest,
      lock,
      npmrc,
      revision: hash(
        canonicalJson({
          manifest: hash(manifest),
          lock: hash(lock),
          npmrc: hash(npmrc),
        }),
      ),
    };
  }
  #direct(manifest: JsonObject, name: string): boolean {
    return ["dependencies", "devDependencies", "optionalDependencies"].some(
      (group) =>
        isPlainRecord(manifest[group]) && Object.hasOwn(manifest[group]!, name),
    );
  }
  async #installed(name: string): Promise<string | null> {
    try {
      const value = JSON.parse(
        (await textFile(
          path.join(this.work, "node_modules", name, "package.json"),
        ))!,
      ) as JsonObject;
      requireCondition(
        value.name === name && typeof value.version === "string",
        "npm_install_invalid",
        "The installed package identity is invalid.",
      );
      return value.version;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  }
  async #verifiedPackage(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
  ): Promise<{
    snapshot: VerifiedPackageSnapshot;
    installed: string | null;
    declared: boolean;
  }> {
    const actual = await this.#files();
    requireCondition(
      actual.lock !== null &&
        canonicalJson(JSON.parse(actual.manifest), cap) ===
          canonicalJson(
            JSON.parse(candidate.payload.manifest as string),
            cap,
          ) &&
        canonicalJson(JSON.parse(actual.lock), cap) ===
          canonicalJson(JSON.parse(candidate.payload.lock as string), cap),
      "npm_plan_changed",
      "Native npm or package lifecycle changed the confirmed dependency plan; the partial disk result requires inspection.",
    );
    const installed = await this.#installed(intent.name),
      declared = this.#direct(
        JSON.parse(actual.manifest) as JsonObject,
        intent.name,
      ),
      retained = (JSON.parse(actual.lock).packages as JsonObject)[
        `node_modules/${intent.name}`
      ];
    requireCondition(
      intent.target === "package" &&
        ["install", "update", "remove"].includes(intent.action) &&
        (intent.action === "remove"
          ? !declared &&
            (isPlainRecord(retained)
              ? installed === retained.version
              : installed === null)
          : declared &&
            typeof installed === "string" &&
            installed === candidate.payload.targetVersion),
      "npm_install_invalid",
      "The actual installed package does not match the approved target.",
    );
    return {
      snapshot: {
        target: {
          name: intent.name,
          action: intent.action as VerifiedPackageSnapshot["target"]["action"],
          version: intent.action === "remove" ? null : installed,
        },
        manifest: actual.manifest,
        lock: actual.lock,
      },
      installed,
      declared,
    };
  }
  async #inspectInstalled(
    name: string,
    scope: MaintenanceScope,
  ): Promise<ExtensionPackageDescriptor> {
    const manifest = JSON.parse(
      (await textFile(
        path.join(this.work, "node_modules", name, "package.json"),
      ))!,
    ) as JsonObject;
    requireCondition(
      manifest.name === name &&
        typeof manifest.version === "string" &&
        isPlainRecord(manifest.nexum),
      "invalid_extension_package",
      "The installed package must declare its own static extension entry.",
    );
    const permissions = (manifest.nexum as JsonObject).permissions;
    requireCondition(
      Array.isArray(permissions) &&
        permissions.every((value) => typeof value === "string"),
      "invalid_extension_permissions",
      "The installed extension must declare its static permissions.",
    );
    const approved = new Map(
      this.options.extensions.packages.options.policy.approvedPackages(),
    );
    approved.set(name, manifest.version);
    const policy = {
      builtins: this.options.extensions.packages.options.policy.builtins,
      approvedPackages: () => approved,
    };
    const resolved = await this.#child(
      [
        "--input-type=module",
        "--eval",
        "process.stdout.write(import.meta.resolve(process.argv[1]));",
        `${name}/nexum`,
      ],
      this.work,
      scope,
    );
    return await inspectExtensionPackage({
      work: this.work,
      packageName: name,
      policy,
      resolveImport: (specifier) => {
        requireCondition(
          specifier === `${name}/nexum`,
          "invalid_extension_source",
          "Only the installed package's static entry is resolved.",
        );
        return resolved;
      },
      permissions: new Set([
        ...this.options.extensions.packages.options.permissions,
        ...(permissions as string[]),
      ]),
      signal: scope.signal,
    });
  }
  async prepare(
    intent: MaintenanceIntent,
    scope: MaintenanceScope,
  ): Promise<PreparedMaintenance> {
    requireCondition(
      intent.target === "package" || intent.target === "extension",
      "maintenance_backend_unavailable",
      "This backend only prepares npm packages and SDK extensions.",
    );
    const files = await this.#files(),
      manifest = JSON.parse(files.manifest) as JsonObject,
      declared = this.#direct(manifest, intent.name),
      installed = await this.#installed(intent.name),
      enabled = this.options.enablement.get(intent.name),
      active = this.options.extensions.get(intent.name);
    let oldExtensionRevision: string | null = null,
      oldPermissions: readonly string[] = [],
      oldNamespace: string | null = null,
      oldDeclaration: JsonObject | null = null;
    if (installed) {
      const metadata = JSON.parse(
        (await textFile(
          path.join(this.work, "node_modules", intent.name, "package.json"),
        ))!,
      ) as JsonObject;
      if (metadata.nexum !== undefined) {
        const descriptor = await this.#inspectInstalled(intent.name, scope);
        oldExtensionRevision = descriptor.revision;
        oldPermissions = descriptor.source.permissions;
        oldNamespace = descriptor.source.origin.namespace;
        oldDeclaration = declaration(descriptor);
      }
    }
    if (intent.method === "packages.install")
      requireCondition(
        !declared,
        "package_already_declared",
        "Use packages.update for an existing direct dependency.",
      );
    else
      requireCondition(
        declared && installed,
        "package_not_installed",
        "The target must be an installed direct dependency.",
      );
    if (intent.target === "extension") {
      const descriptor = await this.#inspectInstalled(intent.name, scope);
      return {
        objectId: enabled?.objectId ?? `npm:${intent.name}`,
        baseRevision: files.revision,
        authStatus: "not_required",
        summary: {
          changeKinds: [
            "extension",
            "capability",
            "script",
            "instruction",
            "docs",
            "skill",
          ],
          permissions: descriptor.source.permissions,
          version: descriptor.version,
          namespace: descriptor.source.origin.namespace,
          restartMayBeRequired: false,
        },
        payload: {
          filesRevision: files.revision,
          installedVersion: installed,
          extensionRevision: descriptor.revision,
          enablementRevision: enabled?.revision ?? null,
          enabled: enabled?.enabled ?? false,
          config: enabled?.config ?? {},
          namespace: descriptor.source.origin.namespace,
          contributions: declaration(descriptor),
          currentContributions: oldDeclaration,
        },
      };
    }
    const reservation = await this.options.reserve?.(
      Buffer.byteLength(files.manifest) +
        Buffer.byteLength(files.lock ?? "") +
        Buffer.byteLength(files.npmrc ?? "") +
        2 * cap +
        4096,
    );
    let staging: string | undefined;
    try {
      scope.signal.throwIfAborted();
      authorizeCall(() => scope.assertCurrent());
      const stagingBase = privateDirectory(
        this.root,
        "state",
        "maintenance",
        "npm",
      );
      staging = await mkdtemp(path.join(stagingBase, "plan-"));
      await writeFile(path.join(staging, "package.json"), files.manifest, {
        mode: 0o600,
      });
      if (files.lock !== null)
        await writeFile(path.join(staging, "package-lock.json"), files.lock, {
          mode: 0o600,
        });
      if (files.npmrc !== null)
        await writeFile(path.join(staging, ".npmrc"), files.npmrc, {
          mode: 0o600,
        });
      let version: string | null = null;
      if (intent.action !== "remove") {
        const raw = JSON.parse(
          await this.#command(
            [
              "view",
              `${intent.name}@${intent.version ?? "latest"}`,
              "version",
              "--json",
            ],
            this.work,
            scope,
          ),
        );
        requireCondition(
          typeof raw === "string" &&
            /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(
              raw,
            ),
          "npm_version_unresolved",
          "npm did not resolve one exact version.",
        );
        version = raw;
      }
      const planned = await this.#planner(
        "plan",
        staging,
        scope,
        intent,
        version,
      );
      const nextManifest = planned.manifest!,
        nextLock = planned.lock!,
        lock = JSON.parse(nextLock) as JsonObject;
      requireCondition(
        isPlainRecord(lock.packages),
        "npm_lock_invalid",
        "npm must produce an exact package-lock before confirmation.",
      );
      const locked = lock.packages[`node_modules/${intent.name}`] as
        JsonObject | undefined;
      if (version)
        requireCondition(
          locked?.version === version &&
            typeof locked.resolved === "string" &&
            typeof locked.integrity === "string",
          "npm_lock_invalid",
          "The confirmed package requires its exact npm source and integrity.",
        );
      // Only this parent saves root records, after the actual producer bytes
      // passed their limits. npm's in-memory planner never saves these files.
      await replace(path.join(staging, "package.json"), nextManifest);
      await replace(path.join(staging, "package-lock.json"), nextLock);
      let extensionRevision: string | null = null,
        permissions = oldPermissions,
        namespace = oldNamespace;
      let contributions: JsonObject | null = null;
      if (version) {
        // Fetch the confirmed tree into a private planner; no lifecycle or factory runs here.
        await this.#command(
          [
            "install",
            "--ignore-scripts",
            "--no-save",
            "--package-lock=true",
            "--no-audit",
            "--no-fund",
          ],
          staging,
          scope,
        );
        const metadata = JSON.parse(
          (await textFile(
            path.join(staging, "node_modules", intent.name, "package.json"),
          ))!,
        ) as JsonObject;
        if (metadata.nexum !== undefined) {
          // Only this candidate is inspected; optional OS-specific direct packages may be absent.
          const approved = new Map<string, string>([
            [intent.name, metadata.version as string],
          ]);
          const policy = {
            builtins: this.options.extensions.packages.options.policy.builtins,
            approvedPackages: () => approved,
          };
          // A disposable native resolver cannot accumulate temporary ESM cache entries in the Agent.
          const resolved = await this.#child(
            [
              "--input-type=module",
              "--eval",
              "process.stdout.write(import.meta.resolve(process.argv[1]));",
              `${intent.name}/nexum`,
            ],
            staging,
            scope,
          );
          const declared = (metadata.nexum as JsonObject).permissions;
          requireCondition(
            Array.isArray(declared) &&
              declared.every((item) => typeof item === "string"),
            "invalid_extension_permissions",
            "The candidate extension must statically declare its permissions.",
          );
          const descriptor = await inspectExtensionPackage({
            work: staging,
            packageName: intent.name,
            policy,
            resolveImport: (specifier) => {
              requireCondition(
                specifier === `${intent.name}/nexum`,
                "invalid_extension_source",
                "Only the candidate's own static entry is resolved.",
              );
              return resolved;
            },
            permissions: new Set([
              ...this.options.extensions.packages.options.permissions,
              ...(declared as string[]),
            ]),
            signal: scope.signal,
          });
          extensionRevision = descriptor.revision;
          permissions = descriptor.source.permissions;
          namespace = descriptor.source.origin.namespace;
          contributions = declaration(descriptor);
        }
      }
      const oldPackages = files.lock
          ? (JSON.parse(files.lock).packages ?? {})
          : {},
        nextPackages = lock.packages as JsonObject;
      const changes = [
        ...new Set([...Object.keys(oldPackages), ...Object.keys(nextPackages)]),
      ]
        .filter(
          (key) =>
            key &&
            canonicalJson(oldPackages[key] ?? null, cap) !==
              canonicalJson(nextPackages[key] ?? null, cap),
        )
        .map((key) => ({
          name: key.slice(key.lastIndexOf("node_modules/") + 13),
          fromVersion: (oldPackages[key]?.version ?? null) as string | null,
          toVersion: ((nextPackages[key] as JsonObject | undefined)?.version ??
            null) as string | null,
        }));
      const registryRaw = (
        await this.#command(["config", "get", "registry"], this.work, scope)
      ).trim();
      let registryOrigin: string | null = null;
      try {
        registryOrigin = new URL(registryRaw).origin;
      } catch {}
      const lockChanged =
          files.lock === null ||
          canonicalJson(JSON.parse(files.lock), cap) !==
            canonicalJson(JSON.parse(nextLock), cap),
        loaded = this.options.modules
          .loadedPackages()
          .map((item) => ({ name: item.name, version: item.version })),
        activeExtensions = this.options.extensions.list().map((item) => ({
          name: item.name!,
          extensionId: item.extensionId!,
        }));
      return {
        objectId: declared ? `npm:${intent.name}` : null,
        baseRevision: files.revision,
        authStatus: "not_required",
        summary: {
          changeKinds: [
            "package",
            "dependency",
            "lockfile",
            ...(extensionRevision || oldExtensionRevision
              ? [
                  "extension",
                  "capability",
                  "script",
                  "instruction",
                  "docs",
                  "skill",
                ]
              : []),
            ...(intent.action === "remove" ? ["remove"] : []),
          ],
          permissions,
          version,
          namespace,
          restartMayBeRequired: lockChanged && loaded.length > 0,
        },
        payload: {
          filesRevision: files.revision,
          manifest: nextManifest,
          lock: nextLock,
          targetVersion: version,
          installedVersion: installed,
          enabled: enabled?.enabled ?? false,
          enablementRevision: enabled?.revision ?? null,
          extensionConfig: enabled?.config ?? {},
          activeExtensionId: active?.extensionId ?? null,
          oldExtensionRevision,
          extensionRevision,
          registryOrigin,
          npmSource: planned.source,
          dependencyChanges: changes.slice(0, 200),
          dependencyChangesCount: changes.length,
          currentDeclared: declared,
          currentNamespace: oldNamespace,
          currentPermissions: [...oldPermissions],
          lockChanged,
          loaded,
          activeExtensions,
          contributions,
          currentContributions: oldDeclaration,
        },
      };
    } finally {
      try {
        if (staging) await rm(staging, { recursive: true, force: true });
      } finally {
        reservation?.release();
      }
    }
  }
  async verify(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<void> {
    scope.signal.throwIfAborted();
    scope.assertCurrent();
    this.options.extensions.assertPackageChangeReady();
    if (intent.target === "package") {
      const producer = await this.#planner("source", this.work, scope);
      requireCondition(
        canonicalJson(producer.source) ===
          canonicalJson(candidate.payload.npmSource),
        "maintenance_precondition_changed",
        "The selected native npm distribution changed after confirmation.",
      );
      const loaded = this.options.modules.loadedPackages();
      requireCondition(
        Array.isArray(candidate.payload.loaded) &&
          loaded.every((item) =>
            (candidate.payload.loaded as JsonObject[]).some(
              (prior) =>
                prior.name === item.name && prior.version === item.version,
            ),
          ) &&
          canonicalJson(
            this.options.extensions.list().map((item) => ({
              name: item.name!,
              extensionId: item.extensionId!,
            })),
          ) === canonicalJson(candidate.payload.activeExtensions),
        "maintenance_precondition_changed",
        "Package evaluation or active extensions changed after the user reviewed restart impact.",
      );
    }
    const files = await this.#files();
    requireCondition(
      files.revision === candidate.payload.filesRevision,
      "maintenance_precondition_changed",
      "The work manifest, npm lock or configuration changed after confirmation.",
    );
    const enabled = this.options.enablement.get(intent.name);
    requireCondition(
      (enabled?.revision ?? null) === candidate.payload.enablementRevision,
      "maintenance_precondition_changed",
      "The extension enablement changed after confirmation.",
    );
    requireCondition(
      (await this.#installed(intent.name)) ===
        candidate.payload.installedVersion,
      "maintenance_precondition_changed",
      "The installed package changed after confirmation.",
    );
    if (typeof candidate.payload.oldExtensionRevision === "string") {
      const descriptor = await this.#inspectInstalled(intent.name, scope);
      requireCondition(
        descriptor.revision === candidate.payload.oldExtensionRevision,
        "maintenance_precondition_changed",
        "The installed extension source changed after user confirmation.",
      );
    }
    if (intent.target !== "package") {
      const descriptor = await this.#inspectInstalled(intent.name, scope);
      requireCondition(
        descriptor.revision === candidate.payload.extensionRevision,
        "maintenance_precondition_changed",
        "The extension declarations or source changed after confirmation.",
      );
    }
  }
  async readDraft(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceDraft> {
    scope.signal.throwIfAborted();
    scope.assertCurrent();
    return {
      config: {
        name: intent.name,
        version: candidate.summary.version,
        registryOrigin: candidate.payload.registryOrigin ?? null,
        npmSource: candidate.payload.npmSource ?? null,
        namespace: candidate.summary.namespace,
        permissions: [...candidate.summary.permissions],
        dependencyChanges: candidate.payload.dependencyChanges ?? [],
        dependencyChangesCount: candidate.payload.dependencyChangesCount ?? 0,
        contributions: candidate.payload.contributions ?? null,
        restartMayBeRequired: candidate.summary.restartMayBeRequired,
        extensionsToStop: candidate.summary.restartMayBeRequired
          ? (candidate.payload.activeExtensions ?? [])
          : [],
        lockRevision:
          typeof candidate.payload.lock === "string"
            ? hash(candidate.payload.lock)
            : null,
      },
      ...(candidate.objectId
        ? {
            currentConfig: {
              name: intent.name,
              installedVersion: candidate.payload.installedVersion ?? null,
              declared: candidate.payload.currentDeclared ?? true,
              desiredEnabled: candidate.payload.enabled ?? false,
              namespace:
                candidate.payload.currentNamespace ??
                candidate.summary.namespace,
              permissions: candidate.payload.currentPermissions ?? [
                ...candidate.summary.permissions,
              ],
              contributions: candidate.payload.currentContributions ?? null,
            },
          }
        : {}),
      authentication: [],
      security: [],
      diagnostics: [],
    };
  }
  async apply(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceResult> {
    requireCondition(
      !this.#busy && this.#commands.size === 0,
      "maintenance_busy",
      "Native npm is already changing this work environment.",
    );
    this.#busy = true;
    let reservation: { release(): void } | undefined;
    let changed = false;
    let packageRestart = false;
    const stopped: NonNullable<
      MaintenanceResult["affectedExtensions"]
    >[number][] = [];
    try {
      return await this.options.modules.withPackageChanges(() =>
        this.options.extensions.withPackageChanges(async () => {
          await this.verify(intent, candidate, scope);
          const desired = candidate.payload.enabled === true,
            config = (candidate.payload.config ??
              candidate.payload.extensionConfig ??
              {}) as JsonObject;
          const enablement = await textFile(
            path.join(this.root, "state", "maintenance", "extensions.json"),
            true,
          );
          reservation = await this.options.reserve?.(
            Buffer.byteLength(enablement ?? "") +
              Buffer.byteLength(canonicalJson(config)) +
              4096 +
              (intent.target === "extension"
                ? 0
                : cap +
                  Buffer.byteLength(candidate.payload.manifest as string) +
                  Buffer.byteLength(candidate.payload.lock as string)),
          );
          scope.signal.throwIfAborted();
          authorizeCall(() => scope.assertCurrent());
          await this.verify(intent, candidate, scope);
          scope.signal.throwIfAborted();
          authorizeCall(() => scope.assertCurrent());
          if (intent.target === "extension") {
            const enable = intent.action === "enable",
              before = this.options.extensions.get(intent.name);
            if (enable) {
              await this.options.enablement.set(
                intent.name,
                true,
                config,
                candidate.payload.enablementRevision as string | null,
                { reserved: Boolean(reservation) },
              );
              changed = true;
              await this.options.extensions.enable(intent.name, config);
            } else {
              if (before) {
                await this.options.extensions.disable(intent.name);
                changed = true;
              }
              await this.options.enablement.set(
                intent.name,
                false,
                config,
                candidate.payload.enablementRevision as string | null,
                { reserved: Boolean(reservation) },
              );
              changed = true;
            }
            const after = this.options.extensions.get(intent.name);
            return {
              changed: desired !== enable || Boolean(before) !== Boolean(after),
              restartRequired: false,
              package: {
                name: intent.name,
                declared: true,
                installedVersion: await this.#installed(intent.name),
              },
              extension: {
                namespace: candidate.payload.namespace as string,
                desiredEnabled: enable,
                state: (after?.status as string) ?? "disabled",
                activeVersion: after
                  ? ((after.origin as JsonObject).version as string)
                  : null,
              },
            };
          }
          if (candidate.payload.lockChanged === false) {
            const actual = await this.#verifiedPackage(intent, candidate);
            scope.signal.throwIfAborted();
            authorizeCall(() => scope.assertCurrent());
            await this.options.refreshPackages(actual.snapshot);
            const before = this.options.extensions.get(intent.name);
            return {
              changed: false,
              restartRequired: false,
              package: {
                name: intent.name,
                declared: actual.declared,
                installedVersion: actual.installed,
              },
              extension: before
                ? {
                    namespace: (before.origin as JsonObject)
                      .namespace as string,
                    desiredEnabled: desired,
                    state: before.status as string,
                    activeVersion:
                      before.status === "enabled"
                        ? ((before.origin as JsonObject).version as string)
                        : null,
                  }
                : null,
            };
          }
          packageRestart =
            candidate.payload.lockChanged === true &&
            this.options.modules.loadedPackages().length > 0;
          const affected = packageRestart
            ? this.options.extensions.list()
            : this.options.extensions
                .list()
                .filter((item) => item.name === intent.name);
          for (const entry of affected) {
            const report = await this.options.extensions.disable(
              entry.name as string,
            );
            changed = true;
            stopped.push({
              name: entry.name as string,
              namespace: (entry.origin as JsonObject).namespace as string,
              desiredEnabled:
                this.options.enablement.get(entry.name as string)?.enabled ??
                false,
              state: report.status as string,
              activeVersion: null,
            });
            requireCondition(
              report.status === "disabled",
              "extension_cleanup_unconfirmed",
              "An affected extension must actually close before npm changes its dependency tree.",
            );
          }
          const npmOptions = [
            "--no-save",
            "--package-lock=true",
            "--no-audit",
            "--no-fund",
          ];
          if (packageRestart) this.options.modules.markPackageRestartRequired();
          if (intent.action === "remove") {
            // Keep the original direct edge visible to native npm's actual
            // tree diff. Removing it from the files first can hide the old
            // package from npm's workspace-disabled reconciliation filter.
            changed = true;
            await this.#command(
              ["uninstall", intent.name, ...npmOptions],
              this.work,
              scope,
            );
            requireCondition(
              (await this.#files()).revision === candidate.baseRevision,
              "npm_plan_changed",
              "Native npm changed the original root records before the approved plan could be saved.",
            );
          }
          await replace(
            path.join(this.work, "package.json"),
            candidate.payload.manifest as string,
          );
          changed = true;
          await replace(
            path.join(this.work, "package-lock.json"),
            candidate.payload.lock as string,
          );
          scope.signal.throwIfAborted();
          authorizeCall(() => scope.assertCurrent());
          if (intent.action !== "remove")
            await this.#command(["install", ...npmOptions], this.work, scope);
          const { snapshot, installed, declared } = await this.#verifiedPackage(
            intent,
            candidate,
          );
          scope.signal.throwIfAborted();
          authorizeCall(() => scope.assertCurrent());
          await this.options.refreshPackages(snapshot);
          let restartRequired = packageRestart,
            extension: MaintenanceResult["extension"] = null;
          if (desired) {
            const state = this.options.enablement.get(intent.name);
            if (intent.action === "remove")
              await this.options.enablement.set(
                intent.name,
                false,
                config,
                state?.revision ?? null,
                { reserved: Boolean(reservation) },
              );
            else if (!restartRequired) {
              try {
                await this.options.extensions.enable(intent.name, config);
              } catch (cause) {
                if (
                  isAgentError(cause) &&
                  cause.code === "module_restart_required"
                )
                  restartRequired = true;
                else throw cause;
              }
            }
            const active = this.options.extensions.get(intent.name);
            extension = {
              namespace: active
                ? ((active.origin as JsonObject).namespace as string)
                : (candidate.summary.namespace ?? intent.name),
              desiredEnabled: intent.action !== "remove",
              state:
                (active?.status as string) ??
                (restartRequired ? "restart_required" : "disabled"),
              activeVersion: active
                ? ((active.origin as JsonObject).version as string)
                : null,
            };
          }
          return {
            changed: true,
            restartRequired,
            package: {
              name: intent.name,
              declared,
              installedVersion: installed,
            },
            extension,
            ...(stopped.length ? { affectedExtensions: stopped } : {}),
          };
        }),
      );
    } catch (cause) {
      const partial: MaintenanceResult = {
        changed,
        restartRequired:
          packageRestart ||
          (isAgentError(cause) && cause.code === "module_restart_required"),
        ...(stopped.length ? { affectedExtensions: stopped } : {}),
      };
      try {
        const declared = this.#direct(
          JSON.parse(
            (await textFile(path.join(this.work, "package.json")))!,
          ) as JsonObject,
          intent.name,
        );
        partial.package = {
          name: intent.name,
          declared,
          installedVersion: await this.#installed(intent.name),
        };
      } catch {}
      const active = this.options.extensions.get(intent.name),
        desired = this.options.enablement.get(intent.name)?.enabled ?? false;
      if (active || desired)
        partial.extension = {
          namespace: active
            ? ((active.origin as JsonObject).namespace as string)
            : (candidate.summary.namespace ?? intent.name),
          desiredEnabled: desired,
          state: (active?.status as string) ?? "disabled",
          activeVersion:
            active?.status === "enabled"
              ? ((active.origin as JsonObject).version as string)
              : null,
        };
      throw new AgentError(
        isAgentError(cause) ? cause.code : "maintenance_execution_failed",
        "The approved npm or extension change did not complete.",
        { partial: JSON.parse(canonicalJson(partial)) as JsonObject },
      );
    } finally {
      reservation?.release();
      this.#busy = false;
    }
  }
}

/** MCP/API remain real application ports; absent configuration support fails closed. */
export class MaintenanceBackends implements MaintenanceBackend {
  constructor(
    readonly npm: MaintenanceBackend,
    readonly configuration?: MaintenanceBackend,
  ) {}
  #for(intent: MaintenanceIntent): MaintenanceBackend {
    if (intent.target === "package" || intent.target === "extension")
      return this.npm;
    requireCondition(
      this.configuration,
      "maintenance_backend_unavailable",
      "This Agent has no approved MCP/API configuration backend.",
    );
    return this.configuration;
  }
  prepare(
    intent: MaintenanceIntent,
    scope: MaintenanceScope,
  ): Promise<PreparedMaintenance> {
    return this.#for(intent).prepare(intent, scope);
  }
  verify(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<void> {
    return this.#for(intent).verify(intent, candidate, scope);
  }
  apply(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceResult> {
    return this.#for(intent).apply(intent, candidate, scope);
  }
  async readDraft(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceDraft> {
    const backend = this.#for(intent);
    if (backend.readDraft)
      return await backend.readDraft(intent, candidate, scope);
    requireCondition(
      intent.target === "package" || intent.target === "extension",
      "maintenance_draft_unavailable",
      "A safe configuration draft provider is required.",
    );
    return { config: {}, authentication: [], security: [], diagnostics: [] };
  }
  async prepareDraft(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    input: MaintenanceDraftInput,
    scope: MaintenanceScope,
  ): Promise<PreparedMaintenance> {
    const backend = this.#for(intent);
    if (backend.prepareDraft)
      return await backend.prepareDraft(intent, candidate, input, scope);
    requireCondition(
      (input.credentials?.length ?? 0) === 0,
      "maintenance_credentials_unavailable",
      "This backend cannot accept protected credential edits.",
    );
    return await backend.prepare(intent, scope);
  }
  async startOAuth(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    binding: MaintenanceOAuthBinding,
    scope: MaintenanceOAuthScope,
  ): Promise<MaintenanceOAuthLaunch> {
    const backend = this.#for(intent);
    requireCondition(
      backend.startOAuth,
      "maintenance_oauth_unavailable",
      "No trusted OAuth provider is configured.",
    );
    return await backend.startOAuth(intent, candidate, binding, scope);
  }
  async completeOAuth(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    input: MaintenanceOAuthComplete,
    scope: MaintenanceOAuthScope,
  ): Promise<PreparedMaintenance> {
    const backend = this.#for(intent);
    requireCondition(
      backend.completeOAuth,
      "maintenance_oauth_unavailable",
      "No trusted OAuth completion provider is configured.",
    );
    return await backend.completeOAuth(intent, candidate, input, scope);
  }
}
