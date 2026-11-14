import { open, opendir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type { ModulePolicy } from "../runtime/modules.js";
import { extensionNamespace } from "../runtime/names.js";
import { contains } from "../runtime/paths.js";
import { scriptHeader, type ScriptMetadata } from "../runtime/scripts.js";
import { boundedFile, parseSkillFrontmatter } from "../work/discovery.js";
import type { ExtensionSource } from "./registry.js";

export interface ExtensionPackageOptions {
  work: string;
  packageName: string;
  policy: ModulePolicy;
  /** ModuleLoader.resolveImport: Node import conditions, authorization, no evaluation. */
  resolveImport(specifier: string): string;
  permissions: ReadonlySet<string>;
  signal?: AbortSignal;
  limits?: { maxFiles?: number; maxBytes?: number; maxDirectories?: number };
}
export interface ExtensionPackageFile {
  /** Canonical source, not a generated public reading path. */
  path: string;
  /** Package-relative layout; publication retains its declared subtree. */
  relativePath: string;
  revision: string;
  size: number;
}
export interface ExtensionPackageDirectory {
  path: string;
  relativePath: string;
  files: readonly ExtensionPackageFile[];
}
export interface ExtensionPackageScript {
  scriptName: string;
  file: ExtensionPackageFile;
  metadata: ScriptMetadata;
}
export interface ExtensionPackageSkill {
  publicName: string;
  metadata: ReturnType<typeof parseSkillFrontmatter>;
  directory: ExtensionPackageDirectory;
  skillFile: ExtensionPackageFile;
}
export interface ExtensionPackageDescriptor {
  work: string;
  packageName: string;
  version: string;
  root: string;
  revision: string;
  fileCount: number;
  totalBytes: number;
  manifest: ExtensionPackageFile;
  entry: ExtensionPackageFile & { url: string };
  types: ExtensionPackageFile;
  source: ExtensionSource;
  materials: {
    instructions?: ExtensionPackageFile;
    docs: ExtensionPackageDirectory;
    scripts?: {
      directory: string;
      entries: readonly ExtensionPackageScript[];
    };
    skills?: {
      directory: string;
      entries: readonly ExtensionPackageSkill[];
    };
  };
}
interface FileIdentity {
  relativePath: string;
  path: string;
  revision: string;
  size: number;
  identity: Stats;
}
interface DirectoryIdentity {
  lexical: string;
  path: string;
  identity: Stats;
}
const textLimits = {
  manifest: 1024 * 1024,
  instructions: 65536,
  script: 1024 * 1024,
  skill: 1024 * 1024,
  document: 8 * 1024 * 1024,
  types: 8 * 1024 * 1024,
} as const;
const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;
const relative = (root: string, filename: string): string =>
  path.relative(root, filename).split(path.sep).join("/");
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const hidden = (filename: string): boolean =>
  filename.split("/").some((part) => part.startsWith("."));
const packageOwned = (root: string, filename: string): boolean =>
  contains(root, filename) &&
  !relative(root, filename)
    .split("/")
    .some((part) => part.toLowerCase() === "node_modules");
const portable = (name: string): string => name.normalize("NFC").toLowerCase();
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function version(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      value,
    );
  return (
    !!match &&
    (!match[4] ||
      match[4]
        .split(".")
        .every(
          (part) =>
            part.length > 0 &&
            (!/^[0-9]+$/.test(part) || part === "0" || part[0] !== "0"),
        )) &&
    (!match[5] || match[5].split(".").every((part) => part.length > 0))
  );
}
function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AgentError(
      "extension_material_encoding",
      "An extension text source is not valid UTF-8.",
      undefined,
      { cause },
    );
  }
}
function parseManifest(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(utf8(bytes));
    requireCondition(
      record(value),
      "invalid_extension_manifest",
      "An installed package manifest must be a JSON object.",
    );
    return value;
  } catch (cause) {
    throw new AgentError(
      "invalid_extension_manifest",
      "The installed package manifest could not be parsed.",
      undefined,
      { cause },
    );
  }
}
function publicFile(file: FileIdentity): ExtensionPackageFile {
  return {
    path: file.path,
    relativePath: file.relativePath,
    revision: file.revision,
    size: file.size,
  };
}

/** Static, explicit-package preparation. It never imports or executes package code. */
export async function inspectExtensionPackage(
  options: ExtensionPackageOptions,
): Promise<ExtensionPackageDescriptor> {
  const check = (): void => options.signal?.throwIfAborted();
  check();
  const name = options.packageName;
  requireCondition(
    typeof name === "string" &&
      name.length <= 214 &&
      /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) &&
      !["node_modules", "favicon.ico"].includes(name),
    "invalid_extension_package",
    "Use the actual standard npm package name, not a path or alias.",
  );
  const limits = {
    files: options.limits?.maxFiles ?? 10000,
    bytes: options.limits?.maxBytes ?? 256 * 1024 * 1024,
    directories: options.limits?.maxDirectories ?? 10000,
  };
  requireCondition(
    Object.values(limits).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
    "invalid_extension_limits",
    "Extension source limits must be positive bounded integers.",
  );
  const knownPermissions = new Set(options.permissions);
  const work = await realpath(options.work);
  const modules = await realpath(path.join(work, "node_modules"));
  const root = await realpath(path.join(modules, name));
  requireCondition(
    contains(work, modules) &&
      contains(modules, root) &&
      (await stat(root)).isDirectory(),
    "extension_path_escape",
    "The extension must be installed in this Agent work environment.",
  );
  async function declared(): Promise<void> {
    check();
    const actual = await realpath(path.join(work, "package.json"));
    requireCondition(
      contains(work, actual),
      "extension_path_escape",
      "The work package declaration escapes this profile.",
    );
    const manifest = parseManifest(
      (await boundedFile(actual, textLimits.manifest, options.signal)).bytes,
    );
    requireCondition(
      ["dependencies", "devDependencies", "optionalDependencies"].some(
        (group) =>
          record(manifest[group]) && typeof manifest[group][name] === "string",
      ),
      "extension_not_direct_dependency",
      "The extension is not an explicitly declared direct dependency of work.",
    );
  }
  await declared();
  const approved = options.policy.approvedPackages().get(name);
  requireCondition(
    typeof approved === "string" && version(approved),
    "extension_not_approved",
    "This installed package version is not approved for the Agent work environment.",
  );

  async function packagePath(
    value: unknown,
    kind: "file" | "directory",
  ): Promise<{ lexical: string; path: string }> {
    requireCondition(
      typeof value === "string" &&
        value.length > 0 &&
        value.length <= 8192 &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        !path.isAbsolute(value) &&
        !/^[a-zA-Z]:/.test(value) &&
        !value
          .split("/")
          .some(
            (part) => part === ".." || part.toLowerCase() === "node_modules",
          ),
      "invalid_extension_source",
      "An extension source must be a package-relative path without dependency traversal.",
    );
    const lexical = path.resolve(root, value);
    const actual = await realpath(lexical);
    requireCondition(
      kind !== "directory" || (lexical !== root && actual !== root),
      "invalid_extension_source",
      "Contribution directories must use a declared package subtree, not expose the entire package.",
    );
    requireCondition(
      contains(root, lexical) &&
        packageOwned(root, actual) &&
        (kind === "file"
          ? (await stat(actual)).isFile()
          : (await stat(actual)).isDirectory()),
      "extension_path_escape",
      "The declared extension source is not the expected file or directory inside its package.",
    );
    return { lexical, path: actual };
  }
  const manifestSource = await packagePath("package.json", "file");
  const manifestRead = await boundedFile(
    manifestSource.path,
    textLimits.manifest,
    options.signal,
  );
  const manifest = parseManifest(manifestRead.bytes);
  requireCondition(
    manifest.name === name &&
      version(manifest.version) &&
      manifest.version === approved,
    "extension_package_changed",
    "The actual package identity or version differs from its approved direct dependency.",
  );
  const metadata = manifest.nexum;
  requireCondition(
    record(metadata) &&
      metadata.apiVersion === 1 &&
      typeof metadata.namespace === "string" &&
      typeof metadata.docs === "string",
    "invalid_extension_manifest",
    "An extension needs protocol version 1, a namespace and an authored docs directory.",
  );
  requireCondition(
    Object.keys(metadata).every((field) =>
      [
        "apiVersion",
        "namespace",
        "permissions",
        "instructions",
        "docs",
        "scripts",
        "skills",
      ].includes(field),
    ),
    "invalid_extension_manifest",
    "The static extension declaration contains an unknown field.",
  );
  extensionNamespace(metadata.namespace);
  requireCondition(
    Array.isArray(metadata.permissions) &&
      new Set(metadata.permissions).size === metadata.permissions.length &&
      metadata.permissions.every(
        (permission) =>
          typeof permission === "string" && knownPermissions.has(permission),
      ),
    "invalid_extension_permissions",
    "An extension must explicitly declare a subset of known platform permissions.",
  );
  const permissions = [...metadata.permissions] as string[];
  const exports = manifest.exports;
  const condition = record(exports) ? exports["./nexum"] : undefined;
  requireCondition(
    record(condition) &&
      Object.keys(condition)[0] === "types" &&
      typeof condition.types === "string",
    "invalid_extension_types",
    "The ./nexum export must declare its types file before runtime conditions.",
  );
  const typesSource = await packagePath(condition.types, "file");
  requireCondition(
    /\.(?:d\.)?(?:ts|mts|cts)$/.test(typesSource.path),
    "invalid_extension_types",
    "The extension types entry must be a TypeScript declaration or source file.",
  );
  let resolved: string;
  try {
    resolved = options.resolveImport(`${name}/nexum`);
  } catch (cause) {
    if (isAgentError(cause) && cause.code === "module_restart_required")
      throw cause;
    throw new AgentError(
      "extension_entry_unavailable",
      "Node could not resolve the approved ./nexum import entry.",
      undefined,
      { cause },
    );
  }
  const entryPath = await realpath(fileURLToPath(resolved));
  requireCondition(
    packageOwned(root, entryPath) &&
      (await stat(entryPath)).isFile() &&
      entryPath !== typesSource.path,
    "extension_path_escape",
    "The Node-resolved extension entry must be a runtime file inside the approved package.",
  );
  const docs = await packagePath(metadata.docs, "directory");
  const instruction =
    metadata.instructions === undefined
      ? undefined
      : await packagePath(metadata.instructions, "file");
  if (instruction)
    requireCondition(
      /\.md$/i.test(instruction.path),
      "invalid_extension_source",
      "Entry instructions must be a Markdown file.",
    );
  const scripts =
    metadata.scripts === undefined
      ? undefined
      : await packagePath(metadata.scripts, "directory");
  const skills =
    metadata.skills === undefined
      ? undefined
      : await packagePath(metadata.skills, "directory");

  const files = new Map<string, FileIdentity>();
  const directories: DirectoryIdentity[] = [];
  let totalBytes = 0;
  async function hashFile(lexical: string, actual: string): Promise<void> {
    check();
    requireCondition(
      files.size < limits.files,
      "extension_source_limit",
      "The package exceeds its own-file count budget.",
    );
    const handle = await open(actual, "r");
    try {
      const before = await handle.stat();
      requireCondition(
        before.isFile() && before.size <= limits.bytes - totalBytes,
        "extension_source_limit",
        "The package exceeds its bounded own-file byte budget.",
      );
      requireCondition(
        (await realpath(lexical)) === actual &&
          sameIdentity(before, await stat(actual)),
        "extension_package_changed",
        "An extension file changed before hashing could start.",
      );
      const hash = createHash("sha256");
      let read = 0;
      const stream = handle.createReadStream({
        autoClose: false,
        highWaterMark: 65536,
        signal: options.signal,
      });
      try {
        for await (const bytes of stream) {
          check();
          read += (bytes as Buffer).byteLength;
          requireCondition(
            read <= before.size,
            "extension_package_changed",
            "An extension source grew while being hashed.",
          );
          hash.update(bytes as Buffer);
        }
        requireCondition(
          read === before.size && sameIdentity(before, await handle.stat()),
          "extension_package_changed",
          "An extension source changed while being hashed.",
        );
      } finally {
        stream.destroy();
      }
      totalBytes += read;
      const key = relative(root, lexical);
      files.set(key, {
        relativePath: key,
        path: actual,
        revision: `sha256:${hash.digest("hex")}`,
        size: read,
        identity: before,
      });
    } finally {
      await handle.close();
    }
  }
  async function walk(
    lexical: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
    check();
    const actual = await realpath(lexical);
    requireCondition(
      packageOwned(root, actual) && !ancestors.has(actual),
      "extension_path_escape",
      "A package directory escapes its owner or contains a symbolic-link cycle.",
    );
    const info = await stat(actual);
    requireCondition(
      info.isDirectory() && directories.length < limits.directories,
      "extension_source_limit",
      "The package exceeds its directory budget.",
    );
    directories.push({ lexical, path: actual, identity: info });
    const active = new Set(ancestors).add(actual);
    const directory = await opendir(actual, { bufferSize: 32 });
    for await (const item of directory) {
      check();
      if (item.name.toLowerCase() === "node_modules") continue;
      const candidate = path.join(lexical, item.name);
      const canonical = await realpath(candidate);
      requireCondition(
        packageOwned(root, canonical),
        "extension_path_escape",
        "A package-owned file must not redirect outside its package.",
      );
      const kind = await stat(canonical);
      if (kind.isDirectory()) await walk(candidate, active);
      else {
        requireCondition(
          kind.isFile(),
          "invalid_extension_source",
          "Package source entries must be regular files or directories.",
        );
        await hashFile(candidate, canonical);
      }
    }
  }
  await walk(root, new Set());
  function file(lexical: string, expected?: string): FileIdentity {
    const result = files.get(relative(root, lexical));
    requireCondition(
      result && (!expected || result.path === expected),
      "extension_source_unavailable",
      "The declared extension source is not part of its bounded own-file snapshot.",
    );
    return result;
  }
  const manifestFile = file(manifestSource.lexical, manifestSource.path);
  requireCondition(
    manifestFile.revision === manifestRead.revision,
    "extension_package_changed",
    "The extension manifest changed during preparation.",
  );
  const entryFile =
    files.get(relative(root, entryPath)) ??
    [...files.values()]
      .filter((item) => item.path === entryPath)
      .sort((left, right) => compare(left.relativePath, right.relativePath))[0];
  requireCondition(
    entryFile,
    "extension_source_unavailable",
    "The runtime entry is not a package-owned file.",
  );
  const typesFile = file(typesSource.lexical, typesSource.path);
  async function readText(item: FileIdentity, limit: number): Promise<string> {
    check();
    const read = await boundedFile(item.path, limit, options.signal);
    requireCondition(
      read.revision === item.revision &&
        (await realpath(path.join(root, item.relativePath))) === item.path,
      "extension_package_changed",
      "A declared source changed after its file snapshot.",
    );
    return utf8(read.bytes);
  }
  await readText(typesFile, textLimits.types);
  function collection(source: {
    lexical: string;
    path: string;
  }): ExtensionPackageDirectory {
    const prefix = relative(root, source.lexical);
    const collected = [...files.values()].filter(
      (item) =>
        (prefix === "" || item.relativePath.startsWith(prefix + "/")) &&
        !hidden(
          prefix === ""
            ? item.relativePath
            : item.relativePath.slice(prefix.length + 1),
        ),
    );
    const collisions = new Set<string>();
    for (const item of collected) {
      requireCondition(
        contains(source.path, item.path),
        "extension_path_escape",
        "A declared material resource escapes its own source directory.",
      );
      const key = portable(item.relativePath);
      requireCondition(
        !collisions.has(key),
        "extension_material_conflict",
        "Declared material paths have a portable name collision.",
      );
      collisions.add(key);
    }
    return {
      path: source.path,
      relativePath: prefix,
      files: collected
        .sort((a, b) => compare(a.relativePath, b.relativePath))
        .map(publicFile),
    };
  }
  const docCollection = collection(docs);
  requireCondition(
    docCollection.files.some((item) => /\.md$/i.test(item.relativePath)),
    "extension_docs_missing",
    "The declared docs directory needs actual authored Markdown content.",
  );
  for (const item of docCollection.files)
    if (/\.md$/i.test(item.relativePath))
      await readText(
        file(path.join(root, item.relativePath)),
        textLimits.document,
      );
  const instructionFile = instruction
    ? file(instruction.lexical, instruction.path)
    : undefined;
  if (instructionFile) await readText(instructionFile, textLimits.instructions);
  let scriptCollection: ExtensionPackageDescriptor["materials"]["scripts"];
  if (scripts) {
    const all = collection(scripts);
    const prefix = all.relativePath ? all.relativePath + "/" : "";
    const entries: ExtensionPackageScript[] = [];
    for (const item of all.files) {
      const filename = item.relativePath.slice(prefix.length);
      if (filename.includes("/") || !filename.endsWith(".js")) continue;
      const parsed = scriptHeader(
        await readText(
          file(path.join(root, item.relativePath)),
          textLimits.script,
        ),
      );
      requireCondition(
        parsed &&
          parsed.scriptName === filename &&
          path.basename(item.path) === filename,
        "script_header_mismatch",
        "Each published package script needs its own matching filename and valid JSON header.",
      );
      entries.push({
        scriptName: `${metadata.namespace}/${filename}`,
        file: item,
        metadata: parsed,
      });
    }
    scriptCollection = { directory: scripts.path, entries };
  }
  let skillCollection: ExtensionPackageDescriptor["materials"]["skills"];
  if (skills) {
    const entries: ExtensionPackageSkill[] = [];
    const names = new Set<string>();
    const directory = await opendir(skills.path, { bufferSize: 32 });
    for await (const item of directory) {
      check();
      if (item.name.startsWith(".")) continue;
      const lexical = path.join(skills.lexical, item.name);
      const actual = await realpath(lexical);
      if (!(await stat(actual)).isDirectory()) continue;
      requireCondition(
        contains(skills.path, actual) &&
          path.basename(actual).normalize("NFC") === item.name.normalize("NFC"),
        "extension_path_escape",
        "A Skill must retain its declared directory identity.",
      );
      const source = collection({ lexical, path: actual });
      const skillFile = file(path.join(lexical, "SKILL.md"));
      requireCondition(
        contains(actual, skillFile.path),
        "extension_path_escape",
        "A Skill entry must remain inside its own resource subtree.",
      );
      const parsed = parseSkillFrontmatter(
        Buffer.from(await readText(skillFile, textLimits.skill)),
        item.name.normalize("NFC"),
      );
      const key = portable(parsed.name);
      requireCondition(
        !names.has(key),
        "extension_material_conflict",
        "Two package Skills share a portable public identity.",
      );
      names.add(key);
      entries.push({
        publicName: `${metadata.namespace}/${parsed.name.normalize("NFC")}`,
        metadata: parsed,
        directory: source,
        skillFile: publicFile(skillFile),
      });
    }
    requireCondition(
      entries.length > 0,
      "extension_skills_missing",
      "A declared Skill collection needs valid SKILL.md entries.",
    );
    entries.sort((a, b) => compare(a.publicName, b.publicName));
    skillCollection = { directory: skills.path, entries };
  }
  await declared();
  requireCondition(
    (await realpath(path.join(modules, name))) === root &&
      options.policy.approvedPackages().get(name) === approved &&
      (await realpath(
        fileURLToPath(options.resolveImport(`${name}/nexum`)),
      )) === entryPath,
    "extension_package_changed",
    "The approved package or native entry changed during static preparation.",
  );
  // Recheck identities after asynchronous parsing and current routing checks. Full content is rehashed by
  // verifyExtensionPackage immediately before and after the later native import.
  for (const directory of directories) {
    check();
    requireCondition(
      (await realpath(directory.lexical)) === directory.path &&
        sameIdentity(directory.identity, await stat(directory.path)),
      "extension_package_changed",
      "A package directory changed during static preparation.",
    );
  }
  for (const item of files.values()) {
    check();
    requireCondition(
      (await realpath(path.join(root, item.relativePath))) === item.path &&
        sameIdentity(item.identity, await stat(item.path)),
      "extension_package_changed",
      "A package file changed during static preparation.",
    );
  }
  check();
  const digest = createHash("sha256");
  for (const item of [...files.values()].sort((a, b) =>
    compare(a.relativePath, b.relativePath),
  ))
    digest.update(
      canonicalJson([
        item.relativePath,
        relative(root, item.path),
        item.size,
        item.revision,
      ]) + "\n",
    );
  const revision = `sha256:${digest.digest("hex")}`;
  return immutable({
    work,
    packageName: name,
    version: approved,
    root,
    revision,
    fileCount: files.size,
    totalBytes,
    manifest: publicFile(manifestFile),
    entry: { ...publicFile(entryFile), url: pathToFileURL(entryPath).href },
    types: publicFile(typesFile),
    source: {
      apiVersion: 1,
      origin: {
        type: "extension",
        owner: name,
        namespace: metadata.namespace,
        version: approved,
        revision,
      },
      permissions,
    },
    materials: {
      docs: docCollection,
      ...(instructionFile ? { instructions: publicFile(instructionFile) } : {}),
      ...(scriptCollection ? { scripts: scriptCollection } : {}),
      ...(skillCollection ? { skills: skillCollection } : {}),
    },
  });
}

/** Reject replacement races around a later import; never imports or rolls back code. */
export async function verifyExtensionPackage(
  descriptor: ExtensionPackageDescriptor,
  options: ExtensionPackageOptions,
): Promise<void> {
  let current: ExtensionPackageDescriptor;
  try {
    current = await inspectExtensionPackage(options);
  } catch (cause) {
    options.signal?.throwIfAborted();
    throw new AgentError(
      "extension_package_changed",
      "The extension source is unavailable or changed; refuse evaluation or publication.",
      undefined,
      { cause },
    );
  }
  requireCondition(
    current.work === descriptor.work &&
      current.packageName === descriptor.packageName &&
      current.root === descriptor.root &&
      current.entry.url === descriptor.entry.url &&
      current.revision === descriptor.revision &&
      canonicalJson(current.source) === canonicalJson(descriptor.source),
    "extension_package_changed",
    "The extension source changed; refuse evaluation or publication and prepare it again.",
  );
}
