import { open, readdir, realpath, stat, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { isAlias, parseDocument, visit } from "yaml";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type { ContributionOrigin, JsonObject } from "../contracts/types.js";
import { contains } from "../runtime/paths.js";

export interface MaterialScope {
  type: "personal" | "agent" | "project" | "directory";
  root: string;
}
export interface Instruction {
  instructionId: string;
  kind: string;
  path: string;
  scope: MaterialScope;
  origin: ContributionOrigin;
  content?: string;
  truncated: false;
  disabled: boolean;
}
export interface SkillMetadata {
  skillId: string;
  name: string;
  description: string;
  compatibility?: string;
  path: string;
  skillFile: string;
  scope: MaterialScope;
  origin: ContributionOrigin;
  disabled: boolean;
}
export interface MaterialWarning {
  code: string;
  path: string | null;
  message: string;
}
export interface VisibilitySelector {
  kind: "instruction" | "skill";
  key: string;
}
export interface DiscoveredMaterials {
  instructions: Instruction[];
  nestedInstructions: Instruction[];
  skills: SkillMetadata[];
  warnings: MaterialWarning[];
  nestedComplete: boolean;
  skillsComplete: boolean;
}
export interface DiscoveryOptions {
  agentId: string;
  work: string;
  home: string | null;
  projectRoot?: string;
  disabledItems?: readonly VisibilitySelector[];
  signal?: AbortSignal;
  // These are application resource bounds, not patterns that silently prune user files.
  maxDirectories?: number;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const selectorKey = (
  kind: "instruction" | "skill",
  canonicalPath: string,
) => hash(kind + "\0" + canonicalPath);
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";
function check(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function boundedFile(
  filename: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; revision: string }> {
  check(signal);
  const handle = await open(filename, "r");
  try {
    const before = await handle.stat();
    requireCondition(
      before.isFile() && before.size <= limit,
      "material_too_large",
      "A material file is not a bounded regular file.",
      { path: filename },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: 16384,
      signal,
    });
    try {
      for await (const value of stream) {
        check(signal);
        const chunk = Buffer.from(value as Buffer);
        total += chunk.length;
        requireCondition(
          total <= limit,
          "material_too_large",
          "The material grew beyond its byte budget.",
          { path: filename },
        );
        chunks.push(chunk);
      }
      const after = await handle.stat();
      requireCondition(
        before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs,
        "material_changed",
        "The material changed while being read.",
        { path: filename },
      );
    } finally {
      stream.destroy();
    }
    const bytes = Buffer.concat(chunks, total);
    return { bytes, revision: "sha256:" + hash(bytes) };
  } finally {
    await handle.close();
  }
}
function utf8(bytes: Buffer, filename: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AgentError(
      "material_encoding",
      "A text material is not valid UTF-8.",
      { path: filename },
    );
  }
}
async function canonicalFile(
  filename: string,
  boundary?: string,
): Promise<string | null> {
  try {
    const actual = await realpath(filename);
    if (boundary && !contains(boundary, actual)) return null;
    return (await stat(actual)).isFile() ? actual : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function canonicalDirectory(
  filename: string,
  boundary?: string,
): Promise<string | null> {
  try {
    const actual = await realpath(filename);
    if (boundary && !contains(boundary, actual)) return null;
    return (await stat(actual)).isDirectory() ? actual : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function origin(agentId: string, revision: string): ContributionOrigin {
  return {
    type: "local",
    owner: "local:" + agentId,
    namespace: null,
    version: null,
    revision,
  };
}
function groups(root: string): { kind: string; paths: string[] }[] {
  return [
    {
      kind: "agents",
      paths: [
        path.join(root, "AGENTS.override.md"),
        path.join(root, "AGENTS.md"),
      ],
    },
    { kind: "claude", paths: [path.join(root, "CLAUDE.md")] },
    { kind: "gemini", paths: [path.join(root, "GEMINI.md")] },
    { kind: "context", paths: [path.join(root, "CONTEXT.md")] },
  ];
}
function ignored(
  filename: string,
  directory: boolean,
  matcher: Ignore | null,
  root?: string,
): boolean {
  if (!matcher || !root) return false;
  const relative = path.relative(root, filename).split(path.sep).join("/");
  return (
    relative.length > 0 && matcher.ignores(relative + (directory ? "/" : ""))
  );
}
function scopedPatterns(content: string, scope: string): string[] {
  if (!scope) return content.split(/\r?\n/);
  requireCondition(
    !/[\r\n]/.test(scope),
    "discovery_scope_invalid",
    "An ignore-file scope cannot contain line separators.",
  );
  // node-ignore owns matching and negation. Qualify directory-scoped patterns
  // into one ordered matcher so re-included parents also affect descendants.
  const prefix = scope.replace(/[\\*?\[\]#!]/g, "\\$&") + "/";
  return content.split(/\r?\n/).map((line) => {
    if (!line || line.startsWith("#") || line === "!") return line;
    const negative = line.startsWith("!") ? "!" : "";
    let pattern = negative ? line.slice(1) : line;
    if (pattern === "/") return "";
    if (pattern.startsWith("/")) return negative + prefix + pattern.slice(1);
    const inner = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    return negative + prefix + (inner.includes("/") ? "" : "**/") + pattern;
  });
}

export function parseSkillFrontmatter(
  bytes: Buffer,
  directory: string,
): { name: string; description: string; compatibility?: string } {
  // The body is never parsed as YAML or returned by initial discovery.
  const prefix = bytes.subarray(0, 65536);
  const offset = prefix.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? 3
    : 0;
  const raw = prefix.subarray(offset).toString("latin1");
  const opening = /^---\r?\n/.exec(raw);
  requireCondition(opening, "invalid_skill", "A Skill needs YAML frontmatter.");
  const closing = /(?:^|\n)---(?:\r?\n|$)/.exec(raw.slice(opening[0].length));
  requireCondition(
    closing && (closing[0].endsWith("\n") || prefix.length === bytes.length),
    "invalid_skill",
    "Skill frontmatter is missing a complete closing delimiter within 64 KiB.",
  );
  const front = prefix.subarray(
    offset + opening[0].length,
    offset + opening[0].length + closing.index,
  );
  const document = parseDocument(utf8(front, directory), {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  requireCondition(
    document.errors.length === 0 && document.warnings.length === 0,
    "invalid_skill",
    "The Skill frontmatter is not valid supported YAML.",
  );
  visit(document, {
    Node: (_key, node) => {
      requireCondition(
        !isAlias(node) && !("anchor" in node && node.anchor),
        "invalid_skill",
        "Skill frontmatter does not support anchors or aliases.",
      );
    },
  });
  const data = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  canonicalJson(data, 65536);
  requireCondition(
    data && typeof data === "object" && !Array.isArray(data),
    "invalid_skill",
    "Skill metadata must be a mapping.",
  );
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description =
    typeof data.description === "string" ? data.description.trim() : "";
  const normalized = name.normalize("NFC");
  requireCondition(
    normalized === directory.normalize("NFC") &&
      [...normalized].length <= 64 &&
      /^[\p{Ll}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Nd}]+)*$/u.test(normalized),
    "invalid_skill",
    "The lowercase Skill name must match its directory and contain single hyphen separators.",
  );
  requireCondition(
    description.length > 0 && [...description].length <= 1024,
    "invalid_skill",
    "A Skill needs a nonempty description of at most 1024 characters.",
  );
  requireCondition(
    data.compatibility === undefined ||
      (typeof data.compatibility === "string" &&
        [...data.compatibility].length <= 500),
    "invalid_skill",
    "Skill compatibility must be a string of at most 500 characters.",
  );
  return {
    name,
    description,
    ...(typeof data.compatibility === "string"
      ? { compatibility: data.compatibility }
      : {}),
  };
}

export async function discoverMaterials(
  options: DiscoveryOptions,
): Promise<DiscoveredMaterials> {
  check(options.signal);
  const work = await realpath(options.work);
  const home = options.home ? await realpath(options.home) : null;
  const project = options.projectRoot
    ? await realpath(options.projectRoot)
    : null;
  const disabled = new Set<string>();
  for (const selector of options.disabledItems ?? []) {
    requireCondition(
      project &&
        ["instruction", "skill"].includes(selector.kind) &&
        /^[0-9a-f]{64}$/.test(selector.key),
      "invalid_visibility",
      "Visibility selectors require a project and a valid kind/key.",
    );
    disabled.add(selector.kind + ":" + selector.key);
  }
  const result: DiscoveredMaterials = {
    instructions: [],
    nestedInstructions: [],
    skills: [],
    warnings: [],
    nestedComplete: true,
    skillsComplete: true,
  };
  const seenInstructions = new Set<string>();
  async function instructions(
    root: string,
    scope: MaterialScope,
    boundary?: string,
    matcher: Ignore | null = null,
    nested = false,
    custom?: ReturnType<typeof groups>,
  ): Promise<void> {
    let actualScope: MaterialScope | undefined;
    for (const group of custom ?? groups(root)) {
      check(options.signal);
      for (const candidate of group.paths) {
        if (ignored(candidate, false, matcher, boundary)) continue;
        const actual = await canonicalFile(candidate, boundary);
        if (!actual) continue;
        if (seenInstructions.has(actual)) break;
        if (nested && result.nestedInstructions.length >= 100) {
          result.nestedComplete = false;
          return;
        }
        if (nested && !actualScope) {
          const canonicalScope = await realpath(root);
          requireCondition(
            !boundary || contains(boundary, canonicalScope),
            "discovery_path_escape",
            "An instruction scope escaped the project root.",
          );
          actualScope = { type: "directory", root: canonicalScope };
        }
        const key = selectorKey("instruction", actual);
        const hidden = disabled.has("instruction:" + key);
        const info = await stat(actual);
        let revision =
          "stat:" +
          hash([info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":"));
        let content: string | undefined;
        if (!nested && !hidden) {
          const read = await boundedFile(actual, 65536, options.signal);
          revision = read.revision;
          content = utf8(read.bytes, actual);
        }
        const item: Instruction = {
          instructionId: "local:" + key,
          kind: group.kind,
          path: actual,
          scope: actualScope ?? scope,
          origin: origin(options.agentId, revision),
          ...(content === undefined ? {} : { content }),
          truncated: false,
          disabled: hidden,
        };
        (nested ? result.nestedInstructions : result.instructions).push(item);
        seenInstructions.add(actual);
        break;
      }
    }
  }
  if (home) {
    const personal = { type: "personal" as const, root: home };
    await instructions(home, personal, undefined, null, false, [
      { kind: "agents", paths: [path.join(home, ".agents", "AGENTS.md")] },
      {
        kind: "agents",
        paths: [
          path.join(home, ".codex", "AGENTS.override.md"),
          path.join(home, ".codex", "AGENTS.md"),
        ],
      },
      { kind: "claude", paths: [path.join(home, ".claude", "CLAUDE.md")] },
      { kind: "gemini", paths: [path.join(home, ".gemini", "GEMINI.md")] },
    ]);
  }
  await instructions(work, { type: "agent", root: work }, work);
  if (project) {
    await instructions(project, { type: "project", root: project }, project);
    let directories = 0;
    const maximum = options.maxDirectories ?? 50000;
    requireCondition(
      Number.isInteger(maximum) && maximum > 0 && maximum <= 50000,
      "invalid_discovery_limit",
      "The directory budget must be between 1 and 50000.",
    );
    async function walk(
      directory: string,
      inherited: Ignore,
      isRoot = false,
    ): Promise<void> {
      check(options.signal);
      if (result.nestedInstructions.length >= 100) {
        result.nestedComplete = false;
        return;
      }
      if (!isRoot)
        requireCondition(
          ++directories <= maximum,
          "discovery_limit",
          "Nested instruction discovery exceeded its effective directory budget.",
        );
      let matcher = inherited;
      const control = path.join(directory, ".gitignore");
      let entry;
      try {
        entry = await lstat(control);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (entry?.isFile() && !entry.isSymbolicLink()) {
        const actual = await realpath(control);
        requireCondition(
          contains(project!, actual),
          "discovery_path_escape",
          "A project ignore file escaped its root.",
        );
        const read = await boundedFile(actual, 65536, options.signal);
        const scope = path
          .relative(project!, directory)
          .split(path.sep)
          .join("/");
        matcher = ignore({ ignorecase: false })
          .add(inherited)
          .add(scopedPatterns(utf8(read.bytes, actual), scope));
      }
      if (!isRoot) {
        await instructions(
          directory,
          { type: "directory", root: directory },
          project!,
          matcher,
          true,
        );
        if (!result.nestedComplete) return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => compare(a.name, b.name));
      for (const child of entries) {
        check(options.signal);
        if (
          !child.isDirectory() ||
          child.isSymbolicLink() ||
          child.name.toLowerCase() === ".git"
        )
          continue;
        const filename = path.join(directory, child.name);
        if (!ignored(filename, true, matcher, project!))
          await walk(filename, matcher);
        if (!result.nestedComplete) break;
      }
    }
    await walk(project, ignore({ ignorecase: false }), true);
  }
  const collections: {
    root: string;
    scope: MaterialScope;
    boundary?: string;
  }[] = [];
  if (project)
    for (const name of [".agents", ".codex", ".claude"])
      collections.push({
        root: path.join(project, name, "skills"),
        scope: { type: "project", root: project },
        boundary: project,
      });
  collections.push({
    root: path.join(work, "skills"),
    scope: { type: "agent", root: work },
    boundary: work,
  });
  if (home)
    for (const parts of [
      [".agents", "skills"],
      [".codex", "skills"],
      [".codex", "skills", ".system"],
      [".claude", "skills"],
    ])
      collections.push({
        root: path.join(home, ...parts),
        scope: { type: "personal", root: home },
      });
  const seenSkills = new Set<string>(),
    seenNames = new Set<string>();
  for (const collection of collections) {
    check(options.signal);
    const root = await canonicalDirectory(collection.root, collection.boundary);
    if (!root) continue;
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      check(options.signal);
      if (entry.name.startsWith(".")) continue;
      if (result.skills.length >= 100) {
        result.skillsComplete = false;
        break;
      }
      const skillRoot = await canonicalDirectory(
        path.join(root, entry.name),
        root,
      );
      if (!skillRoot) continue;
      const file = await canonicalFile(
        path.join(skillRoot, "SKILL.md"),
        skillRoot,
      );
      if (!file || seenSkills.has(file)) continue;
      let metadata: ReturnType<typeof parseSkillFrontmatter>, revision: string;
      try {
        const read = await boundedFile(file, 1024 * 1024, options.signal);
        metadata = parseSkillFrontmatter(
          read.bytes,
          path.basename(skillRoot).normalize("NFC"),
        );
        revision = read.revision;
      } catch (error) {
        check(options.signal);
        result.warnings.push({
          code: error instanceof AgentError ? error.code : "skill_unavailable",
          path: file,
          message: "Skill metadata could not be loaded.",
        });
        continue;
      }
      if (seenNames.has(metadata.name.normalize("NFC"))) continue;
      const key = selectorKey("skill", file);
      result.skills.push({
        ...metadata,
        skillId: "local:" + key,
        path: skillRoot,
        skillFile: file,
        scope: collection.scope,
        origin: origin(options.agentId, revision),
        disabled: disabled.has("skill:" + key),
      });
      seenSkills.add(file);
      seenNames.add(metadata.name.normalize("NFC"));
    }
    if (!result.skillsComplete) break;
  }
  if (!result.skillsComplete)
    result.warnings.push({
      code: "skill_discovery_limit",
      path: null,
      message:
        "Local Skill discovery reached its 100-item bound; the directory may contain more Skills.",
    });
  if (!result.nestedComplete)
    result.warnings.push({
      code: "instruction_discovery_limit",
      path: project,
      message: "Nested instruction discovery reached its 100-item bound.",
    });
  result.nestedInstructions.sort(
    (a, b) => compare(a.scope.root, b.scope.root) || compare(a.path, b.path),
  );
  result.skills.sort((a, b) => compare(a.skillId, b.skillId));
  check(options.signal);
  return result;
}

export async function readProjectSummary(
  root: string,
  signal?: AbortSignal,
): Promise<{
  description: string | null;
  revision: string | null;
  status: string;
  reason?: string;
}> {
  try {
    check(signal);
    const entries = (await readdir(root, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^readme(?:\..*)?$/i.test(entry.name),
    );
    const priority = (name: string) =>
      name.toLowerCase() === "readme.md"
        ? 0
        : name.toLowerCase() === "readme"
          ? 1
          : 2;
    entries.sort(
      (a, b) => priority(a.name) - priority(b.name) || compare(a.name, b.name),
    );
    if (!entries.length)
      return { description: "", revision: null, status: "missing" };
    const file = await canonicalFile(path.join(root, entries[0]!.name), root);
    requireCondition(
      file,
      "material_path_escape",
      "The README is outside its project.",
    );
    const read = await boundedFile(file, 1024 * 1024, signal);
    const characters = [...utf8(read.bytes, file)];
    const excerpt = JSON.stringify(characters.slice(0, 300).join("")).slice(
      1,
      -1,
    );
    return {
      description:
        excerpt +
        (characters.length > 300
          ? `…（还有 ${characters.length - 300} 字）`
          : ""),
      revision: read.revision,
      status: "updated",
    };
  } catch (error) {
    check(signal);
    return {
      description: null,
      revision: null,
      status: "unavailable",
      reason: error instanceof AgentError ? error.code : "readme_unavailable",
    };
  }
}

export function enabledMaterials(
  discovered: DiscoveredMaterials,
): DiscoveredMaterials {
  return {
    ...discovered,
    instructions: discovered.instructions.filter((item) => !item.disabled),
    nestedInstructions: discovered.nestedInstructions.filter(
      (item) => !item.disabled,
    ),
    skills: discovered.skills.filter((item) => !item.disabled),
  };
}
