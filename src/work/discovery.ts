import { open, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
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
  // Consume the complete CRLF delimiter: leaving its leading CR in the YAML
  // body makes otherwise-valid quoted metadata fail on Windows.
  const closing = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(raw.slice(opening[0].length));
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
