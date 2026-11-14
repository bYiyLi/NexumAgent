import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson, digest, newId } from "../contracts/json.js";
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
import type {
  ManagedReserve,
  MaterialRetention,
} from "../runtime/material-retention.js";
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
  readonly reserve?: ManagedReserve;
  readonly materialRetention?: MaterialRetention;
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
  description?: { itemId: string; path: string; revision: string };
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

  /** Owner Console inspection retains disabled discovery without injecting it into model context. */
  async inspect(
    caller: Caller,
    input: OpenInput,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    caller = fixedCaller(caller);
    requireCondition(
      caller.source === "owner_session",
      "material_forbidden",
      "Only a verified owner session may inspect management metadata.",
    );
    requireCondition(
      typeof input.projectId === "string" &&
        input.projectId.length > 0 &&
        input.path === undefined,
      "invalid_work_inspection",
      "Project inspection needs a fixed project identity and cannot switch to a path.",
    );
    const opened = await this.open(caller, input, signal);
    const work = this.#store.activeWork(
      opened.contextId as string,
      callerKey(caller),
    );
    requireCondition(
      work.revision === opened.revision,
      "context_revision_mismatch",
      "The work changed before management metadata could be projected.",
    );
    this.#authorize(caller, { action: "read", work });
    signal?.throwIfAborted();
    const bundle = this.#bundle(work);
    const instruction = (
      item: Instruction | PublishedInstruction,
    ): JsonObject => {
      const { content: _content, ...metadata } = item;
      return json({
        ...metadata,
        itemId: item.instructionId,
        disabled: "disabled" in item ? item.disabled : false,
      });
    };
    const skill = (item: SkillMetadata | PublishedSkill): JsonObject =>
      json({
        ...item,
        itemId: item.skillId,
        disabled: "disabled" in item ? item.disabled : false,
      });
    const view = json(opened);
    (view.agent as JsonObject).management = {
      instructions: [
        ...bundle.published.instructions,
        ...bundle.discovered.instructions.filter(
          (item) => item.scope.type !== "project",
        ),
      ].map(instruction),
      skills: [
        ...bundle.published.skills,
        ...bundle.discovered.skills.filter(
          (item) => item.scope.type !== "project",
        ),
      ].map(skill),
    };
    const project = view.project as JsonObject;
    project.descriptionItemId = bundle.description?.itemId ?? null;
    project.management = {
      instructions: bundle.discovered.instructions
        .filter((item) => item.scope.type === "project")
        .map(instruction),
      skills: bundle.discovered.skills
        .filter((item) => item.scope.type === "project")
        .map(skill),
      nestedInstructions: bundle.discovered.nestedInstructions.map(instruction),
    };
    return view;
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
            realpathSync.native(input.path) === previous.pwd,
          "context_binding_mismatch",
          "Refresh cannot switch the work directory or attach a Project.",
        );
    }
    let resolved: ProjectResolution | null = null;
    const projectId = previous?.projectId ?? input.projectId;
    if (projectId || (!previous && input.path)) {
      const target = projectId
        ? { projectId }
        : { path: realpathSync.native(input.path!) };
      resolved = await this.#options.resolveProject(caller, target, signal);
      requireCondition(
        resolved.project.projectId &&
          (!projectId || resolved.project.projectId === projectId),
        "project_binding_mismatch",
        "The catalog returned a different Project identity.",
      );
      const actual = realpathSync.native(resolved.project.root);
      requireCondition(
        statSync(actual).isDirectory() &&
          (!input.path || actual === realpathSync.native(input.path)),
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
    let description: Bundle["description"];
    if (project && summary?.status === "updated" && summary.revision) {
      try {
        description = await this.#description(
          project.root,
          summary.revision,
          signal,
        );
        requireCondition(
          description,
          "material_changed",
          "The README disappeared before its full-description evidence was captured.",
        );
      } catch {
        signal.throwIfAborted();
        discovered.warnings.push({
          code: "readme_unavailable",
          path: project.root,
          message:
            "The optional README changed or became unavailable; no full-description reference was published.",
        });
      }
    }
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
    const usage =
      this.#options.scriptUsage?.(caller) ?? this.#store.scriptUsage(key);
    const canUse = (origin: ContributionOrigin) =>
      this.#options.canUseScript?.(caller, origin) ?? true;
    const library = this.#scripts.discover(canUse);
    const scripts = this.#scripts.select(usage, canUse, 128 * 1024, library);
    // Capture all contribution discovery synchronously. Catalog I/O may yield
    // while another work enables/disables a source; its versioned manual must
    // still describe this same captured instruction/Skill/script generation.
    const docs = await this.#catalog.refresh(published.docs, signal, library);
    signal.throwIfAborted();
    const directory = privateDirectory(
      this.#scripts.work,
      "tmp",
      "contexts",
      newId("snapshot"),
    );
    let committed = false;
    let hold: { release(): void } | undefined;
    const write = async (filename: string, text: string): Promise<void> => {
      signal.throwIfAborted();
      const reservation = await this.#options.reserve?.(
        Buffer.byteLength(text),
      );
      try {
        signal.throwIfAborted();
        requireCondition(
          realpathSync.native(this.#store.root) === this.#store.root &&
            realpathSync.native(directory) === directory &&
            lstatSync(directory).isDirectory() &&
            !lstatSync(directory).isSymbolicLink(),
          "material_path_escape",
          "The work snapshot directory changed before its reserved write.",
        );
        atomicText(filename, text);
      } finally {
        reservation?.release();
      }
    };
    try {
      hold = await this.#options.materialRetention?.hold("work", directory);
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
      await write(agentIndex, canonicalJson(allAgent, 16 * 1024 * 1024));
      if (project)
        await write(projectIndex, canonicalJson(allProject, 16 * 1024 * 1024));
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
        ...(description ? { description } : {}),
      };
      const filename = path.join(directory, "bundle.json");
      await write(filename, canonicalJson(bundle, 16 * 1024 * 1024));
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
      try {
        if (!committed && lstatSync(directory, { throwIfNoEntry: false })) {
          requireCondition(
            realpathSync.native(directory) === directory &&
              lstatSync(directory).isDirectory() &&
              !lstatSync(directory).isSymbolicLink(),
            "material_path_escape",
            "A failed work snapshot cannot redirect its cleanup.",
          );
          rmSync(directory, { recursive: true, force: true });
        }
      } finally {
        hold?.release();
      }
    }
  }

  async #description(
    root: string,
    revision: string,
    signal: AbortSignal,
  ): Promise<Bundle["description"]> {
    signal.throwIfAborted();
    const priority = (name: string) =>
      name.toLowerCase() === "readme.md"
        ? 0
        : name.toLowerCase() === "readme"
          ? 1
          : 2;
    const entries = (await readdir(root, { withFileTypes: true })).filter(
      (item) => item.isFile() && /^readme(?:\..*)?$/i.test(item.name),
    );
    entries.sort(
      (a, b) =>
        priority(a.name) - priority(b.name) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    if (!entries.length) return undefined;
    const filename = path.join(root, entries[0]!.name),
      actual = realpathSync.native(filename);
    requireCondition(
      actual === filename && contains(root, actual),
      "material_path_escape",
      "The actual README must stay inside its canonical Project.",
    );
    const read = await boundedFile(actual, 1024 * 1024, signal);
    requireCondition(
      read.revision === revision,
      "material_changed",
      "The README changed during work discovery; refresh the work.",
    );
    return {
      itemId: "readme:" + digest({ path: actual, revision }),
      path: actual,
      revision,
    };
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
      const root = realpathSync.native(skill.path),
        file = realpathSync.native(skill.skillFile);
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
    const root = realpathSync.native(
      path.join(this.#scripts.work, "tmp", "contexts"),
    );
    const filename = realpathSync.native(
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
    caller = fixedCaller(caller);
    signal?.throwIfAborted();
    const work = this.#store.activeWork(contextId, callerKey(caller));
    this.#authorize(caller, { action: "read-material", work });
    const bundle = this.#bundle(work);
    const local =
      caller.source === "owner_session"
        ? bundle.discovered
        : enabledMaterials(bundle.discovered);
    if (bundle.description?.itemId === itemId) {
      requireCondition(
        !relativePath && work.projectId !== null,
        "material_path_escape",
        "A README identity grants only its exact Project file.",
      );
      const description = bundle.description,
        actual = realpathSync.native(description.path);
      requireCondition(
        actual === description.path && contains(work.pwd, actual),
        "material_path_escape",
        "The README no longer belongs to this Project.",
      );
      const read = await boundedFile(actual, 1024 * 1024, signal);
      requireCondition(
        read.revision === description.revision,
        "material_changed",
        "The README changed after inspection; refresh the work.",
      );
      this.#authorize(caller, { action: "read-material", work });
      return { path: actual, ...read };
    }
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
      const actual = realpathSync.native(instruction.path);
      requireCondition(
        actual === instruction.path &&
          (caller.source === "owner_session"
            ? instruction.scope.type === "personal" ||
              contains(instruction.scope.root, actual)
            : work.projectId !== null && contains(work.pwd, actual)),
        "material_path_escape",
        "The nested instruction no longer belongs to this project.",
      );
      const unchanged = () => {
        if (
          instruction.origin.type !== "local" ||
          !instruction.origin.revision.startsWith("stat:")
        )
          return;
        const info = statSync(actual);
        const revision =
          "stat:" +
          createHash("sha256")
            .update([info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":"))
            .digest("hex");
        requireCondition(
          revision === instruction.origin.revision,
          "material_changed",
          "The instruction changed after discovery; refresh the work before reading it.",
        );
      };
      unchanged();
      const read = await boundedFile(actual, 65536, signal);
      unchanged();
      this.#authorize(caller, { action: "read-material", work });
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
    const root = realpathSync.native(skill.path);
    const entry = realpathSync.native(skill.skillFile);
    const actual = realpathSync.native(
      path.resolve(root, relativePath ?? "SKILL.md"),
    );
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
    this.#authorize(caller, { action: "read-material", work });
    return { path: actual, ...result };
  }

  /** A bounded Skill subtree, identified by the same resolved snapshot winner as body reads. */
  async readMaterialEntries(
    caller: Caller,
    contextId: string,
    itemId: string,
    relativePath?: string,
    signal?: AbortSignal,
  ): Promise<{
    entries: { displayPath: string; kind: "file" | "directory" }[];
  }> {
    caller = fixedCaller(caller);
    signal?.throwIfAborted();
    const work = this.#store.activeWork(contextId, callerKey(caller));
    this.#authorize(caller, { action: "read-material", work });
    const bundle = this.#bundle(work),
      local =
        caller.source === "owner_session"
          ? bundle.discovered
          : enabledMaterials(bundle.discovered);
    const skill = [...local.skills, ...bundle.published.skills].find(
      (item) => item.skillId === itemId,
    );
    requireCondition(
      skill,
      "material_forbidden",
      "This Skill is not a resolved member available to this caller.",
    );
    const root = realpathSync.native(skill.path),
      entry = realpathSync.native(skill.skillFile);
    requireCondition(
      root === skill.path && entry === skill.skillFile && contains(root, entry),
      "material_path_escape",
      "The Skill root or entry has redirected.",
    );
    // Reuse the complete entry/revision check before exposing its resource names.
    await this.readMaterial(caller, contextId, itemId, undefined, signal);
    requireCondition(
      this.#store.activeWork(contextId, callerKey(caller)).revision ===
        work.revision,
      "context_revision_mismatch",
      "The work changed before its Skill subtree could be listed.",
    );
    const start = path.resolve(root, relativePath ?? ".");
    requireCondition(
      contains(root, start) &&
        realpathSync.native(start) === start &&
        lstatSync(start).isDirectory(),
      "material_path_escape",
      "A Skill tree must stay inside its canonical root without redirects.",
    );
    const entries: { displayPath: string; kind: "file" | "directory" }[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ entries }));
    const visit = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      this.#authorize(caller, { action: "read-material", work });
      requireCondition(
        realpathSync.native(directory) === directory &&
          contains(root, directory),
        "material_path_escape",
        "The Skill subtree escaped its canonical root.",
      );
      const before = lstatSync(directory);
      requireCondition(
        before.isDirectory(),
        "material_path_escape",
        "Skill subtree directories cannot redirect.",
      );
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const after = lstatSync(directory);
      requireCondition(
        after.isDirectory() &&
          before.dev === after.dev &&
          before.ino === after.ino &&
          realpathSync.native(directory) === directory,
        "material_changed",
        "The Skill subtree changed while being listed.",
      );
      for (const child of children) {
        signal?.throwIfAborted();
        const filename = path.join(directory, child.name),
          current = lstatSync(filename);
        requireCondition(
          !current.isSymbolicLink() &&
            realpathSync.native(filename) === filename &&
            contains(root, filename),
          "material_path_escape",
          "A Skill subtree entry cannot redirect outside the selected tree.",
        );
        requireCondition(
          current.isFile() || current.isDirectory(),
          "material_unavailable",
          "A Skill subtree supports only regular files and directories.",
        );
        const item = {
          displayPath: path.relative(root, filename).split(path.sep).join("/"),
          kind: current.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
        };
        bytes +=
          Buffer.byteLength(JSON.stringify(item)) + (entries.length ? 1 : 0);
        entries.push(item);
        requireCondition(
          entries.length <= 1000 && bytes <= 64 * 1024,
          "material_tree_too_large",
          "The Skill subtree exceeds its 1000-entry or 64-KiB discovery budget.",
        );
        if (current.isDirectory()) await visit(filename);
      }
    };
    await visit(start);
    await this.readMaterial(caller, contextId, itemId, undefined, signal);
    requireCondition(
      this.#store.activeWork(contextId, callerKey(caller)).revision ===
        work.revision,
      "context_revision_mismatch",
      "The work changed while its Skill subtree was being listed.",
    );
    this.#authorize(caller, { action: "read-material", work });
    return { entries };
  }
}
