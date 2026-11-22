import { realpathSync } from "node:fs";
import { types } from "node:util";
import { callerKey } from "../contracts/caller.js";
import { requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import type { Binding, ContributionOrigin } from "../contracts/types.js";
import type { ModulePolicy } from "../runtime/modules.js";
import type { ScriptCatalog, ScriptUsage } from "../runtime/scripts.js";
import type { WorkOptions, PublishedMaterials, ProjectResolution } from "../work/service.js";
import { MaterialSession } from "./materials.js";
import type { MaterialFactory, MaterialRequest } from "./material-rpc.js";

/** Live services are supplied by the host after extension and policy recovery. */
export interface MaterialFactoryServices {
  root: string;
  binding: Binding;
  bootId: string;
  scripts: ScriptCatalog;
  policy: ModulePolicy;
  home: string | null;
  agent: WorkOptions["agent"];
  reserve: NonNullable<WorkOptions["reserve"]>;
  materialRetention: NonNullable<WorkOptions["materialRetention"]>;
  authorize(request: MaterialRequest, caller: Parameters<WorkOptions["authorize"]>[0],
    target: Parameters<WorkOptions["authorize"]>[1]): void;
  materials(request: MaterialRequest): PublishedMaterials;
  canUseScript(request: MaterialRequest, origin: ContributionOrigin): boolean;
}

/** Bind the received Go work scope to the existing discovery implementation. */
export function createMaterialFactory(services: MaterialFactoryServices): MaterialFactory {
  return async (request, signal) => {
    signal.throwIfAborted();
    requireCondition(request.context.connection && isPlainRecord(request.context.connection),
      "invalid_work_scope", "The material request requires its current connection.");
    const connection = request.context.connection;
    requireCondition(connection.agentId === services.binding.agentId &&
      connection.profile === services.binding.profile &&
      connection.cloudEnvironment === services.binding.cloudEnvironment &&
      connection.bootId === services.bootId,
    "runtime_binding_mismatch", "The material request belongs to another Agent boot.");
    requireCondition(request.scriptUsage.every((entry) => isPlainRecord(entry) &&
      typeof entry.owner === "string" && typeof entry.scriptName === "string" &&
      Number.isSafeInteger(entry.count) && (entry.count as number) >= 0 &&
      Number.isSafeInteger(entry.lastStartedAt) && (entry.lastStartedAt as number) >= 0),
    "invalid_work_scope", "The supplied script usage is invalid.");
    const usage = request.scriptUsage.map((entry) => ({ ...(entry as ScriptUsage) }));
    const session = new MaterialSession({ root: services.root, binding: services.binding,
      bootId: services.bootId, scripts: services.scripts, policy: services.policy });
    const options: WorkOptions & Required<Pick<WorkOptions, "scriptUsage" | "canUseScript">> = {
      home: services.home,
      agent: services.agent,
      reserve: services.reserve,
      materialRetention: services.materialRetention,
      authorize: (caller, target) => {
        signal.throwIfAborted();
        requireCondition(callerKey(caller) === callerKey(request.caller),
          "forbidden", "The work request belongs to another caller.");
        return services.authorize(request, caller, target);
      },
      resolveProject: async (_caller, target): Promise<ProjectResolution> => {
        signal.throwIfAborted();
        const project = request.project;
        requireCondition(isPlainRecord(project) && typeof project.projectId === "string" &&
          typeof project.name === "string" && typeof project.root === "string" &&
          Array.isArray(project.disabledItems) &&
          project.disabledItems.every((item) => isPlainRecord(item) &&
            (item.kind === "instruction" || item.kind === "skill") && typeof item.key === "string") &&
          (!target.projectId || target.projectId === project.projectId) &&
          (!target.path || realpathSync.native(target.path) === project.root),
        "project_binding_mismatch", "The resolved Project does not match the work request.");
        return { project: { projectId: project.projectId, name: project.name, root: project.root,
          ...(typeof project.description === "string" ? { description: project.description } : {}) },
        disabledItems: project.disabledItems as ProjectResolution["disabledItems"] };
      },
      materials: () => services.materials(request),
      scriptUsage: () => usage,
      canUseScript: (_caller, origin) => {
        const allowed = services.canUseScript(request, origin);
        if (types.isPromise(allowed)) void Promise.prototype.then.call(allowed, undefined, () => {});
        requireCondition(typeof allowed === "boolean", "authorization_configuration",
          "The source policy must return a synchronous boolean.");
        return allowed;
      },
    };
    return { session, options };
  };
}
