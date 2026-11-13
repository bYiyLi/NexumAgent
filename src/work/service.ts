import { readFileSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, newId } from "../contracts/json.js";
import { validateContract } from "../contracts/validation.js";
import type {
  ContributionOrigin,
  JsonObject,
  JsonValue,
  WorkRecord,
} from "../contracts/types.js";
import { SqliteStore } from "../storage/sqlite.js";
import {
  authorizeCall,
  callerKey,
  fixedCaller,
  type Caller,
} from "../contracts/caller.js";
import { ScriptCatalog, type ScriptUsage } from "../runtime/scripts.js";
import { atomicText, contains, privateDirectory } from "../runtime/paths.js";
import { DocumentCatalog, type DocLink } from "./catalog.js";
import {
  boundedFile,
  discoverMaterials,
  enabledMaterials,
  readProjectSummary,
  type DiscoveredMaterials,
  type Instruction,
  type SkillMetadata,
  type VisibilitySelector,
} from "./discovery.js";

export interface ProjectIdentity {
  projectId: string;
  name: string;
  root: string;
  description?: string;
}
export interface ProjectResolution {
  project: ProjectIdentity;
  disabledItems: readonly VisibilitySelector[];
}
export type PublishedInstruction = Omit<Instruction, "disabled" | "path"> & {
  path: string | null;
  content: string;
};
export type PublishedSkill = Omit<SkillMetadata, "disabled">;
export interface PublishedMaterials {
  instructions: readonly PublishedInstruction[];
  skills: readonly PublishedSkill[];
  docs: readonly DocLink[];
}
export interface OpenInput {
  agentId: string;
  projectId?: string;
  path?: string;
  contextId?: string;
}
export interface WorkOptions {
  home: string | null;
  agent: {
    name: string;
    description?: string;
    version: string;
    build?: string;
    protocolVersion: string;
    extensionApiVersion?: string;
  };
  authorize(
    caller: Caller,
    target: {
      action: string;
      work?: WorkRecord;
      project?: ProjectIdentity | null;
      path?: string;
    },
  ): void;
  resolveProject(
    caller: Caller,
    target: { projectId?: string; path?: string },
    signal: AbortSignal,
  ): Promise<ProjectResolution>;
  materials?: () => PublishedMaterials;
  scriptUsage?: (caller: Caller) => readonly ScriptUsage[];
  canUseScript?: (caller: Caller, origin: ContributionOrigin) => boolean;
}
interface Bundle {
  agentId: string;
  bootId: string;
  callerKey: string;
  projectId: string | null;
  view: JsonObject;
  discovered: DiscoveredMaterials;
  published: PublishedMaterials;
}
const json = (value: unknown, max = 16 * 1024 * 1024): JsonObject =>
  JSON.parse(canonicalJson(value, max)) as JsonObject;
function withoutDisabled<T extends { disabled: boolean }>(
  value: T,
): Omit<T, "disabled"> {
  const { disabled: _disabled, ...rest } = value;
  return rest;
}
function modelBytes(value: JsonObject): number {
  // The actual JSON fallback is counted alongside structuredContent, including escaping.
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    }),
  );
}

export class WorkService {
  #store: SqliteStore;
  #scripts: ScriptCatalog;
  #catalog: DocumentCatalog;
  #options: WorkOptions;
  #refreshes = new Map<string, Promise<void>>();
  #operations = new Set<Promise<void>>();
  constructor(
    store: SqliteStore,
    scripts: ScriptCatalog,
    catalog: DocumentCatalog,
    options: WorkOptions,
  ) {
    requireCondition(
      scripts.work === path.join(store.root, "work") &&
        catalog.work === scripts.work &&
        scripts.owner === `local:${store.binding.agentId}`,
      "runtime_profile_mismatch",
      "Work metadata must use this Agent's own profile/work environment.",
    );
    this.#store = store;
    this.#scripts = scripts;
    this.#catalog = catalog;
    this.#options = options;
  }
  async open(
    caller: Caller,
    input: OpenInput,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    validateContract("agent.open", input);
    caller = fixedCaller(caller);
    requireCondition(
      input.agentId === this.#store.binding.agentId,
      "agent_mismatch",
      "Open targets a different Agent.",
    );
    requireCondition(
      this.#operations.size < 64,
      "work_busy",
      "Too many work metadata operations are pending.",
    );
    const scope = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    scope.throwIfAborted();
    const key = callerKey(caller);
    const fixed = json(input) as unknown as OpenInput;
    this.#authorize(caller, { action: "open" });
    if (fixed.contextId) this.#store.activeWork(fixed.contextId, key);
    const previous = fixed.contextId
      ? this.#refreshes.get(fixed.contextId)
      : undefined;
    const operation = (previous ?? Promise.resolve()).then(() =>
      this.#build(caller, fixed, scope),
    );
    const tail = operation.then(
      () => {},
      () => {},
    );
    this.#operations.add(tail);
    if (fixed.contextId) this.#refreshes.set(fixed.contextId, tail);
    void tail.then(() => {
      this.#operations.delete(tail);
      if (fixed.contextId && this.#refreshes.get(fixed.contextId) === tail)
        this.#refreshes.delete(fixed.contextId);
    });
    // Cancelling this invocation stops its build/queue entry, not another refresh.
    const observation = new AbortController();
    const abort = once(scope, "abort", { signal: observation.signal }).then(
      () => {
        scope.throwIfAborted();
        throw new AgentError("work_aborted", "The work request was aborted.");
      },
    );
    void abort.catch(() => {});
    try {
      scope.throwIfAborted();
      return await Promise.race([operation, abort]);
    } finally {
      observation.abort();
    }
  }

  #authorize(
    caller: Caller,
    target: Parameters<WorkOptions["authorize"]>[1],
  ): void {
    authorizeCall(() => this.#options.authorize(caller, target));
  }
  async #build(
    caller: Caller,
    input: OpenInput,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted();
    const key = callerKey(caller);
    const previous = input.contextId
      ? this.#store.activeWork(input.contextId, key)
      : null;
    if (previous) {
      requireCondition(
        !input.projectId || previous.projectId === input.projectId,
        "context_binding_mismatch",
        "Refresh cannot switch the work's Project.",
      );
      requireCondition(
        previous.projectId !== null || (!input.projectId && !input.path),
        "context_binding_mismatch",
        "Refresh cannot attach a Project to an Agent-only work.",
      );
      if (input.path)
        requireCondition(
          previous.projectId !== null &&
            realpathSync(input.path) === previous.pwd,
          "context_binding_mismatch",
          "Refresh cannot switch the work directory or attach a Project.",
        );
    }
    let resolved: ProjectResolution | null = null;
    const projectId = previous?.projectId ?? input.projectId;
    if (projectId || (!previous && input.path)) {
      const target = projectId
        ? { projectId }
        : { path: realpathSync(input.path!) };
      resolved = await this.#options.resolveProject(caller, target, signal);
      requireCondition(
        resolved.project.projectId &&
          (!projectId || resolved.project.projectId === projectId),
        "project_binding_mismatch",
        "The catalog returned a different Project identity.",
      );
      const actual = realpathSync(resolved.project.root);
      requireCondition(
        statSync(actual).isDirectory() &&
          (!input.path || actual === realpathSync(input.path)),
        "project_binding_mismatch",
        "The catalog root does not match the requested local directory.",
      );
      resolved = {
        project: { ...resolved.project, root: actual },
        disabledItems: resolved.disabledItems.map((item) => ({ ...item })),
      };
      if (previous)
        requireCondition(
          actual === previous.pwd,
          "context_binding_mismatch",
          "A refresh cannot relocate an existing work.",
        );
    }
    const project = resolved?.project ?? null;
    const pwd = project?.root ?? this.#scripts.work;
    this.#authorize(caller, {
      action: previous ? "refresh" : "open",
      ...(previous ? { work: previous } : {}),
      project,
      path: pwd,
    });
    signal.throwIfAborted();
    const discovered = await discoverMaterials({
      agentId: this.#store.binding.agentId,
      work: this.#scripts.work,
      home: this.#options.home,
      ...(project
        ? { projectRoot: project.root, disabledItems: resolved!.disabledItems }
        : {}),
      signal,
    });
    const summary = project
      ? await readProjectSummary(project.root, signal)
      : null;
    if (project && summary?.description !== null)
      project.description = summary?.description ?? "";
    if (summary?.status === "unavailable")
      discovered.warnings.push({
        code: "readme_unavailable",
        path: project!.root,
        message:
          "The README summary could not be updated; the last known value is retained.",
      });
    const effective = enabledMaterials(discovered);
    const published = json(
      this.#options.materials?.() ?? {
        instructions: [],
        skills: [],
        docs: [],
      },
      4 * 1024 * 1024,
    ) as unknown as PublishedMaterials;
    this.#validatePublished(published);
    const docs = await this.#catalog.refresh(published.docs, signal);
    signal.throwIfAborted();
    const usage =
      this.#options.scriptUsage?.(caller) ?? this.#store.scriptUsage(key);
    const canUse = (origin: ContributionOrigin) =>
      this.#options.canUseScript?.(caller, origin) ?? true;
    const scripts = this.#scripts.select(usage, canUse, 128 * 1024);
    const library = this.#scripts.discover(canUse);
    const directory = privateDirectory(
      this.#scripts.work,
      "tmp",
      "contexts",
      newId("snapshot"),
    );
    let committed = false;
    try {
      const agentIndex = path.join(directory, "agent.json"),
        projectIndex = path.join(directory, "project.json");
      const agentInstructions = [
        ...published.instructions,
        ...effective.instructions
          .filter((item) => item.scope.type !== "project")
          .map(withoutDisabled),
      ];
      const agentSkills = [
        ...published.skills,
        ...effective.skills
          .filter((item) => item.scope.type !== "project")
          .map(withoutDisabled),
      ];
      const projectInstructions = effective.instructions
        .filter((item) => item.scope.type === "project")
        .map(withoutDisabled);
      const projectSkills = effective.skills
        .filter((item) => item.scope.type === "project")
        .map(withoutDisabled);
      const allAgent = json({
        instructions: agentInstructions,
        skills: agentSkills,
        scripts: library.entries,
        warnings: library.warnings,
      });
      const allProject = json({
        instructions: projectInstructions,
        skills: projectSkills,
        nestedInstructions: effective.nestedInstructions.map(withoutDisabled),
      });
      atomicText(agentIndex, canonicalJson(allAgent, 16 * 1024 * 1024));
      if (project)
        atomicText(projectIndex, canonicalJson(allProject, 16 * 1024 * 1024));
      const cpus = os.cpus();
      const view = json({
        observedAt: new Date().toISOString(),
        pwd,
        agent: {
          agentId: this.#store.binding.agentId,
          name: this.#options.agent.name,
          description: this.#options.agent.description ?? null,
          software: {
            version: this.#options.agent.version,
            build: this.#options.agent.build ?? null,
            protocolVersion: this.#options.agent.protocolVersion,
            extensionApiVersion:
              this.#options.agent.extensionApiVersion ?? null,
          },
          system: {
            platform: process.platform,
            type: os.type(),
            release: os.release(),
            version: os.version(),
            machine: os.machine(),
            source: "node:os",
            cpu: {
              models: [...new Set(cpus.map((cpu) => cpu.model))].slice(0, 4),
              logicalCount: cpus.length,
              availableParallelism: os.availableParallelism(),
            },
            memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            locale: Intl.DateTimeFormat().resolvedOptions().locale,
          },
          runtime: {
            nodeVersion: process.version,
            v8Version: process.versions.v8,
            modulesAbi: process.versions.modules,
            arch: process.arch,
            startedAt: new Date(performance.timeOrigin).toISOString(),
          },
          paths: {
            work: this.#scripts.work,
            docs: this.#scripts.docs,
            scripts: this.#scripts.local,
            resources: path.join(this.#scripts.work, "resources"),
          },
          modules: {
            builtinFamilies: docs.builtinFamilies,
            packagesIndex: docs.packagesIndex,
          },
          instructions: agentInstructions,
          skills: agentSkills,
          skillsComplete: discovered.skillsComplete,
          materialsIndex: agentIndex,
          docs: {
            entry: docs.entry,
            revision: docs.revision,
            content: docs.content,
            truncated: docs.truncated,
            nextLine: docs.nextLine,
          },
          scripts: {
            total: scripts.total,
            items: scripts.items,
            complete: scripts.complete,
            index: path.join(this.#scripts.docs, "scripts.md"),
          },
        },
        project: project
          ? {
              ...project,
              summary,
              instructions: projectInstructions,
              skills: projectSkills,
              nestedInstructions:
                effective.nestedInstructions.map(withoutDisabled),
              skillsComplete: discovered.skillsComplete,
              nestedInstructionsComplete: discovered.nestedComplete,
              materialsIndex: projectIndex,
            }
          : null,
        warnings: [...discovered.warnings, ...scripts.warnings],
      });
      this.#fit(view);
      const bundle: Bundle = {
        agentId: this.#store.binding.agentId,
        bootId: this.#store.bootId,
        callerKey: key,
        projectId: project?.projectId ?? null,
        view,
        discovered,
        published,
      };
      const filename = path.join(directory, "bundle.json");
      atomicText(filename, canonicalJson(bundle, 16 * 1024 * 1024));
      signal.throwIfAborted();
      this.#authorize(caller, {
        action: "commit",
        ...(previous ? { work: previous } : {}),
        project,
        path: pwd,
      });
      const relative = path
        .relative(this.#store.root, filename)
        .split(path.sep)
        .join("/");
      const work = previous
        ? this.#store.refreshWork(
            previous.contextId,
            key,
            previous.revision,
            relative,
          )
        : this.#store.openWork({
            callerKey: key,
            ...(project ? { projectId: project.projectId } : {}),
            pwd,
            snapshotRef: relative,
          });
      committed = true;
      return { contextId: work.contextId, revision: work.revision, ...view };
    } finally {
      if (!committed) await rm(directory, { recursive: true, force: true });
    }
  }

  #validatePublished(published: PublishedMaterials): void {
    canonicalJson(published, 4 * 1024 * 1024);
    for (const item of [...published.instructions, ...published.skills]) {
      requireCondition(
        ["platform", "extension"].includes(item.origin.type) &&
          item.origin.owner &&
          item.origin.version &&
          item.origin.revision &&
          item.scope.type === "agent",
        "invalid_material_source",
        "Published guidance must keep its actual platform/extension owner, version and Agent scope.",
      );
    }
    for (const item of published.instructions)
      requireCondition(
        typeof item.content === "string" &&
          Buffer.byteLength(item.content) <= 65536,
        "material_too_large",
        "An entry instruction must be delivered completely within its byte budget.",
      );
    for (const skill of published.skills) {
      const root = realpathSync(skill.path),
        file = realpathSync(skill.skillFile);
      requireCondition(
        contains(this.#scripts.docs, root) &&
          contains(root, file) &&
          statSync(file).isFile(),
        "material_path_escape",
        "An extension Skill must use its published reading copy.",
      );
    }
  }

  #fit(view: JsonObject): void {
    const agent = view.agent as JsonObject,
      project = view.project as JsonObject | null;
    const scripts = agent.scripts as JsonObject,
      docs = agent.docs as JsonObject;
    const scriptItems = scripts.items as JsonValue[];
    const warnings = view.warnings as JsonValue[];
    let omitted = false;
    const budgetWarning = {
      code: "work_display_budget",
      message:
        "Some complete optional definitions were omitted. Read the corresponding Agent/Project materialsIndex; displayed schemas and mandatory instructions remain complete.",
    };
    const over = () =>
      modelBytes({
        ...view,
        warnings: [...warnings, ...(omitted ? [budgetWarning] : [])],
        contextId: "ctx_" + "0".repeat(32),
        revision: 2147483647,
      }) >
      128 * 1024;
    while (over() && scriptItems.length) {
      scriptItems.pop();
      scripts.complete = false;
      omitted = true;
    }
    while (over() && (agent.skills as JsonValue[]).length) {
      (agent.skills as JsonValue[]).pop();
      agent.skillsComplete = false;
      omitted = true;
    }
    while (over() && project && (project.skills as JsonValue[]).length) {
      (project.skills as JsonValue[]).pop();
      project.skillsComplete = false;
      omitted = true;
    }
    while (
      over() &&
      project &&
      (project.nestedInstructions as JsonValue[]).length
    ) {
      (project.nestedInstructions as JsonValue[]).pop();
      project.nestedInstructionsComplete = false;
      omitted = true;
    }
    if (over() && typeof docs.content === "string") {
      docs.content = "";
      docs.truncated = true;
      docs.nextLine = 1;
      omitted = true;
    }
    requireCondition(
      !over(),
      "work_materials_too_large",
      "The complete mandatory entry instructions exceed the work result budget.",
    );
    if (omitted) warnings.push(budgetWarning);
  }

  #bundle(work: WorkRecord): Bundle {
    const root = realpathSync(path.join(this.#scripts.work, "tmp", "contexts"));
    const filename = realpathSync(
      path.resolve(this.#store.root, work.snapshotRef),
    );
    requireCondition(
      contains(this.#scripts.work, root) &&
        contains(root, filename) &&
        statSync(filename).isFile() &&
        statSync(filename).size <= 16 * 1024 * 1024,
      "work_snapshot_unavailable",
      "The retained work snapshot is unavailable or outside its profile.",
    );
    const bundle = JSON.parse(readFileSync(filename, "utf8")) as Bundle;
    requireCondition(
      bundle.agentId === this.#store.binding.agentId &&
        bundle.bootId === work.bootId &&
        bundle.callerKey === work.callerKey &&
        bundle.projectId === work.projectId,
      "work_snapshot_mismatch",
      "The work snapshot belongs to a different binding.",
    );
    return bundle;
  }
  load(work: WorkRecord): JsonObject {
    // Accepted runs pass their captured WorkRecord; refresh/close do not retarget it.
    const bundle = this.#bundle(work),
      project = bundle.view.project as JsonObject | null;
    return {
      project: project
        ? {
            projectId: project.projectId!,
            name: project.name!,
            root: project.root!,
          }
        : null,
    };
  }
  get(caller: Caller, contextId: string): JsonObject {
    const work = this.#store.activeWork(contextId, callerKey(caller));
    this.#authorize(caller, { action: "read", work });
    return {
      contextId: work.contextId,
      revision: work.revision,
      ...this.#bundle(work).view,
    };
  }
  close(caller: Caller, contextId: string): JsonObject {
    const work = this.#store.getWork(contextId);
    this.#authorize(caller, { action: "close", work });
    return this.#store.closeWork(contextId, callerKey(caller));
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#operations]);
  }
  async readMaterial(
    caller: Caller,
    contextId: string,
    itemId: string,
    relativePath?: string,
    signal?: AbortSignal,
  ): Promise<{ path: string | null; bytes: Buffer; revision: string }> {
    const work = this.#store.activeWork(contextId, callerKey(caller));
    this.#authorize(caller, { action: "read-material", work });
    const bundle = this.#bundle(work);
    const local = enabledMaterials(bundle.discovered);
    const instructions = [
      ...local.instructions,
      ...local.nestedInstructions,
      ...bundle.published.instructions,
    ];
    const instruction = instructions.find(
      (item) => item.instructionId === itemId,
    );
    if (instruction) {
      requireCondition(
        !relativePath,
        "material_path_escape",
        "An instruction grants only its exact file.",
      );
      if (instruction.content !== undefined)
        return {
          path: instruction.path,
          bytes: Buffer.from(instruction.content),
          revision: instruction.origin.revision,
        };
      requireCondition(
        instruction.path,
        "material_unavailable",
        "The instruction source is unavailable.",
      );
      const actual = realpathSync(instruction.path);
      requireCondition(
        actual === instruction.path &&
          work.projectId !== null &&
          contains(work.pwd, actual),
        "material_path_escape",
        "The nested instruction no longer belongs to this project.",
      );
      const read = await boundedFile(actual, 65536, signal);
      return { path: actual, ...read };
    }
    const skill = [...local.skills, ...bundle.published.skills].find(
      (item) => item.skillId === itemId,
    );
    requireCondition(
      skill,
      "material_forbidden",
      "This material is not an enabled, resolved member of the work snapshot.",
    );
    const root = realpathSync(skill.path);
    const entry = realpathSync(skill.skillFile);
    const actual = realpathSync(path.resolve(root, relativePath ?? "SKILL.md"));
    requireCondition(
      root === skill.path &&
        entry === skill.skillFile &&
        contains(root, entry) &&
        contains(root, actual),
      "material_path_escape",
      "A Skill resource must remain inside the resolved winner's root.",
    );
    const metadata = await boundedFile(entry, 1024 * 1024, signal);
    if (skill.origin.type === "local")
      requireCondition(
        metadata.revision === skill.origin.revision,
        "material_changed",
        "The Skill changed after discovery; refresh the work before reading it.",
      );
    const result =
      actual === entry
        ? metadata
        : await boundedFile(actual, 1024 * 1024, signal);
    if (actual !== entry && skill.origin.type === "local")
      requireCondition(
        (await boundedFile(entry, 1024 * 1024, signal)).revision ===
          metadata.revision,
        "material_changed",
        "The Skill changed while its resource was being read.",
      );
    return { path: actual, ...result };
  }
}
