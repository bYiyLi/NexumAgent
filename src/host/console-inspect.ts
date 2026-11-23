import { createHash } from "node:crypto";
import { readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { requireCondition } from "../contracts/errors.js";
import { ScriptCatalog, type ScriptSource } from "../runtime/scripts.js";
import { boundedFile, discoverMaterials, enabledMaterials } from "../work/discovery.js";

export interface ConsoleSourceSnapshot {
  source: { kind: string; objectId: string; name: string; methods?: { operation: string; metadata: unknown }[] };
  materials: {
    instructions: Record<string, unknown>[];
    skills: Record<string, unknown>[];
    scriptSources: ScriptSource[];
  };
}
export interface ConsoleResource {
  id: string;
  name: string;
  type: "instruction" | "skill" | "script" | "npm" | "mcp" | "openapi";
  description?: string;
  parentId?: string;
  path?: string;
}
export interface ConsoleInspectOutput {
  observedAt: string;
  complete: boolean;
  resources: ConsoleResource[];
  instruction?: { id: string; content: string; path?: string };
  skill?: {
    id: string;
    name: string;
    entries: { displayPath: string; kind: "directory" | "file" }[];
    selected: { displayPath: string; content: string; revision: string; truncated: boolean };
    treeTruncated: boolean;
  };
  mcp?: { id: string; name: string; state: "published"; complete: boolean; tools: { name: string; description: string; inputSchema: unknown; outputSchema?: unknown }[] };
  script?: {
    id: string;
    scriptName: string;
    scriptDesc: string;
    scriptWhenUse: string;
    scriptInputSchema: unknown;
    scriptOpenDefault: boolean;
    origin: {
      type: string;
      owner: string;
      namespace: string | null;
      version: string | null;
    };
    code: string;
    codeComplete: boolean;
  };
  telemetry: {
    scope: "node_host";
    observedAt: string;
    cpuPercent?: number;
    memoryRssMb?: number;
  };
  warnings: string[];
}
const bounded = (v: unknown, limit: number): string =>
  typeof v === "string" ? v.slice(0, limit) : "";
const stableId = (kind: string, identity: string) =>
  "res_" +
  createHash("sha256")
    .update(kind + "\0" + identity)
    .digest("hex");

const skillFileExtensions = new Set([
  ".md", ".mdx", ".txt", ".json", ".jsonc", ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".sh", ".py", ".yaml", ".yml", ".toml", ".xml", ".css",
  ".html", ".sql", ".go", ".rs", ".rb", ".ps1",
]);

function previewable(name: string): boolean {
  return name === "SKILL.md" || (!name.startsWith(".") && skillFileExtensions.has(path.extname(name).toLowerCase()));
}

async function readSkillBrowser(
  selected: Record<string, unknown>,
  resourceID: string,
  filePath: string | undefined,
  signal: AbortSignal,
): Promise<NonNullable<ConsoleInspectOutput["skill"]>> {
  const skillFile = selected.skillFile;
  requireCondition(
    typeof skillFile === "string" && path.isAbsolute(skillFile),
    "skill_unavailable",
    "The current skill has no valid entry file.",
  );
  const root = await realpath(path.dirname(skillFile));
  requireCondition(
    path.join(root, "SKILL.md") === (await realpath(skillFile)),
    "skill_unavailable",
    "The selected skill entry is outside its root.",
  );
  // The entry document must remain selectable even if auxiliary folders fill the tree budget.
  const entries: NonNullable<ConsoleInspectOutput["skill"]>["entries"] = [
    { displayPath: "SKILL.md", kind: "file" },
  ];
  let treeTruncated = false;
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 6) { treeTruncated = true; return; }
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      signal.throwIfAborted();
      if (entries.length >= 200) { treeTruncated = true; break; }
      if (child.name.startsWith(".") || child.isSymbolicLink() || child.name === "node_modules") continue;
      const displayPath = relative ? relative + "/" + child.name : child.name;
      if (displayPath === "SKILL.md") continue;
      if (displayPath.length > 1024) { treeTruncated = true; continue; }
      const filename = path.join(directory, child.name);
      const info = await lstat(filename);
      if (info.isDirectory()) {
        entries.push({ displayPath, kind: "directory" });
        if (depth < 6) await walk(filename, displayPath, depth + 1);
        else treeTruncated = true;
      } else if (info.isFile() && previewable(child.name)) {
        entries.push({ displayPath, kind: "file" });
      }
    }
  };
  await walk(root, "", 0);
  const target = filePath ?? "SKILL.md";
  requireCondition(
    entries.some((entry) => entry.kind === "file" && entry.displayPath === target),
    "skill_file_unavailable",
    "The selected file is not a readable member of this skill.",
  );
  const actual = await realpath(path.join(root, ...target.split("/")));
  requireCondition(
    actual.startsWith(root + path.sep) && target.split("/").every((part) => part !== "." && part !== ".."),
    "skill_file_unavailable",
    "The selected file is outside its skill root.",
  );
  // boundedFile checks size, regular-file identity and changes during the read.
  const file = await boundedFile(actual, 1024 * 1024, signal);
  // Validate the complete source as text; deliver only a bounded UTF-8 preview.
  requireCondition(
    !file.bytes.includes(0),
    "skill_file_unavailable",
    "The selected Skill member is not a text file.",
  );
  new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  const truncated = file.bytes.length > 65536;
  const content = new TextDecoder("utf-8").decode(
    truncated ? file.bytes.subarray(0, 65536) : file.bytes,
  );
  return {
    id: resourceID,
    name: bounded(selected.name, 256) || path.basename(root),
    entries,
    selected: { displayPath: target, content, revision: file.revision, truncated },
    treeTruncated,
  };
}

export async function inspectConsoleAgent({
  agentId,
  work,
  home,
  sources,
  approvedPackages,
  signal,
  requestedResourceId,
  requestedFilePath,
}: {
  agentId: string;
  work: string;
  home: string | null;
  sources: readonly ConsoleSourceSnapshot[];
  approvedPackages: ReadonlyMap<string, unknown>;
  signal: AbortSignal;
  requestedResourceId?: string;
  requestedFilePath?: string;
}): Promise<ConsoleInspectOutput> {
  signal.throwIfAborted();
  const warnings: string[] = [];
  const found = enabledMaterials(
    await discoverMaterials({ agentId, work, home, signal }),
  );
  const resources: ConsoleResource[] = [];
  const seen = new Set<string>();
  const sourceIDs = new Map<string, string>();
  let selectedInstruction: ConsoleInspectOutput["instruction"];
  let selectedSkill: Record<string, unknown> | undefined;
  let selectedScript: ConsoleInspectOutput["script"];
  let selectedMCP: ConsoleInspectOutput["mcp"];
  const add = (
    type: ConsoleResource["type"],
    name: string,
    identity: string,
    description?: string,
    parentId?: string,
    localPath?: string,
  ) => {
    const display = name.trim().slice(0, 256);
    if (!display) return;
    const id = stableId(type, identity);
    if (seen.has(id)) return;
    seen.add(id);
    resources.push({
      id,
      name: display,
      type,
      ...(description ? { description: description.slice(0, 1024) } : {}),
      ...(parentId ? { parentId } : {}),
      ...(localPath ? { path: localPath } : {}),
    });
  };
  for (const item of sources) {
    if (item.source.kind !== "mcp" && item.source.kind !== "api") continue;
    const type = item.source.kind === "api" ? "openapi" : "mcp";
    const key = item.source.kind + ":" + item.source.objectId;
    sourceIDs.set(key, stableId(type, key));
    add(type, item.source.name, key);
    if (type === "mcp" && requestedResourceId === stableId(type, key)) {
      const tools: NonNullable<ConsoleInspectOutput["mcp"]>["tools"] = [];
      let bytes = 0;
      let complete = true;
      for (const method of item.source.methods ?? []) {
        if (!method.operation.startsWith("tools/")) continue;
        const metadata = method.metadata;
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
        const detail = metadata as Record<string, unknown>;
        if (typeof detail.description !== "string" || !detail.inputSchema ||
            typeof detail.inputSchema !== "object" || Array.isArray(detail.inputSchema)) continue;
        const name = method.operation.slice(6);
        if (!name || name.length > 256) continue;
        const tool = {
          name,
          description: detail.description.slice(0, 1024),
          inputSchema: detail.inputSchema,
          ...(detail.outputSchema && typeof detail.outputSchema === "object" &&
              !Array.isArray(detail.outputSchema) ? { outputSchema: detail.outputSchema } : {}),
        };
        const length = Buffer.byteLength(JSON.stringify(tool));
        if (tools.length >= 64 || bytes + length > 192 * 1024) { complete = false; break; }
        bytes += length;
        tools.push(tool);
      }
      selectedMCP = { id: requestedResourceId, name: item.source.name, state: "published", complete, tools };
    }
  }
  for (const [name] of approvedPackages) add("npm", name, name);
  const material = (
    type: "instruction" | "skill",
    item: Record<string, unknown>,
  ) => {
    const origin =
      item.origin && typeof item.origin === "object"
        ? (item.origin as Record<string, unknown>)
        : {};
    const source =
      typeof origin.owner === "string"
        ? sourceIDs.get(origin.owner)
        : undefined;
    const candidate =
      type === "skill"
        ? bounded(item.name, 256)
        : path.basename(
            bounded(item.path, 1024) || bounded(item.kind, 128) || "AGENTS.md",
          );
    const identity =
      bounded(item.instructionId ?? item.skillId, 2048) || candidate;
    const localPath = type === "instruction" ? bounded(item.path, 8192) : "";
    const first = !seen.has(stableId(type, identity));
    add(
      type,
      candidate,
      identity,
      bounded(item.description, 1024),
      source,
      localPath,
    );
    if (
      first &&
      type === "instruction" &&
      requestedResourceId === stableId(type, identity)
    ) {
      requireCondition(
        typeof item.content === "string",
        "instruction_unavailable",
        "The selected instruction has no readable content.",
      );
      requireCondition(
        Buffer.byteLength(item.content, "utf8") <= 65536,
        "instruction_too_large",
        "The selected instruction exceeds the preview limit.",
      );
      selectedInstruction = {
        id: requestedResourceId,
        content: item.content,
        ...(localPath ? { path: localPath } : {}),
      };
    }
    if (first && type === "skill" && requestedResourceId === stableId(type, identity)) {
      selectedSkill = item;
    }
  };
  for (const item of sources) {
    for (const instruction of item.materials.instructions ?? [])
      material("instruction", instruction);
    for (const skill of item.materials.skills ?? []) material("skill", skill);
  }
  for (const i of found.instructions)
    material("instruction", i as unknown as Record<string, unknown>);
  for (const s of found.skills)
    material("skill", s as unknown as Record<string, unknown>);
  const skillDetail = selectedSkill && requestedResourceId
    ? await readSkillBrowser(selectedSkill, requestedResourceId, requestedFilePath, signal)
    : undefined;
  const registry = sources.flatMap((s) => s.materials.scriptSources ?? []);
  const catalog = new ScriptCatalog(work, agentId, () => registry);
  const library = catalog.discover();
  for (const item of library.entries) {
    // ScriptCatalog already returns namespaced names (e.g. browser/inspect.js).
    const name = bounded(item.scriptName, 256);
    const identity = item.origin.type + ":" + item.origin.owner + ":" + name;
    const parentId = sourceIDs.get(item.origin.owner);
    if (name) {
      add("script", name, identity, bounded(item.scriptDesc, 1024), parentId);
      if (requestedResourceId === stableId("script", identity)) {
        // Resolve through the registered catalog: canonical path and header checks stay authoritative.
        const snapshot = catalog.resolve(name);
        requireCondition(
          snapshot.metadata,
          "script_unavailable",
          "The registered script has no readable metadata.",
        );
        const code = snapshot.code.slice(0, 131072);
        selectedScript = {
          id: requestedResourceId,
          scriptName: name,
          scriptDesc: snapshot.metadata.scriptDesc,
          scriptWhenUse: snapshot.metadata.scriptWhenUse,
          scriptInputSchema: snapshot.metadata.scriptInputSchema,
          scriptOpenDefault: snapshot.metadata.scriptOpenDefault,
          origin: {
            type: snapshot.origin.type,
            owner: snapshot.origin.owner,
            namespace: snapshot.origin.namespace,
            version: snapshot.origin.version,
          },
          code,
          codeComplete: code.length === snapshot.code.length,
        };
      }
    }
  }
  for (const w of found.warnings)
    if (warnings.length < 30) warnings.push(w.code.slice(0, 256));
  for (const w of library.warnings)
    if (warnings.length < 30)
      warnings.push(bounded(w.code, 256) || "script_unavailable");
  requireCondition(
    !requestedFilePath || skillDetail,
    "resource_not_found",
    "The selected file does not belong to a current effective Skill.",
  );
  requireCondition(
    !requestedResourceId || selectedInstruction || selectedScript || selectedMCP || skillDetail,
    "resource_not_found",
    "The selected resource is not in the current effective Agent inventory.",
  );
  const complete =
    found.skillsComplete && warnings.length === 0 && resources.length <= 200;
  if (resources.length > 200) warnings.push("resources_truncated");
  const cpuStart = process.cpuUsage();
  const clockStart = performance.now();
  await new Promise<void>((resolve) => setTimeout(resolve, 120));
  signal.throwIfAborted();
  const elapsed = performance.now() - clockStart;
  const delta = process.cpuUsage(cpuStart);
  const rss = process.memoryUsage().rss / (1024 * 1024);
  const telemetry = {
    scope: "node_host" as const,
    observedAt: new Date().toISOString(),
    ...(elapsed > 0
      ? {
          cpuPercent:
            Math.round(
              Math.min(
                100,
                Math.max(
                  0,
                  ((delta.user + delta.system) / (elapsed * 1000)) * 100,
                ),
              ) * 10,
            ) / 10,
        }
      : {}),
    ...(Number.isFinite(rss) ? { memoryRssMb: Math.round(rss * 10) / 10 } : {}),
  };
  requireCondition(
    resources.every((item) => item.name),
    "invalid_console_snapshot",
    "The effective resource inventory is invalid.",
  );
  return {
    observedAt: telemetry.observedAt,
    complete,
    resources: resources.slice(0, 200),
    ...(selectedInstruction ? { instruction: selectedInstruction } : {}),
    ...(skillDetail ? { skill: skillDetail } : {}),
    ...(selectedScript ? { script: selectedScript } : {}),
    ...(selectedMCP ? { mcp: selectedMCP } : {}),
    telemetry,
    warnings: warnings.slice(0, 30),
  };
}
