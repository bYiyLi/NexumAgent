import { realpathSync } from "node:fs";
import path from "node:path";
import { requireCondition } from "../contracts/errors.js";
import { canonicalJson, digest, isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import { ExtensionMaterials } from "../extensions/materials.js";
import { ExtensionPackageLoader } from "../extensions/package-loader.js";
import { ExtensionRegistry, type RegistryOptions } from "../extensions/registry.js";
import { ResourceManager, type ResourceStore } from "../extensions/resources.js";
import type { ManagedReserve } from "../runtime/current-materials.js";
import type { ModuleLoader, ModulePolicy } from "../runtime/modules.js";
import { ExtensionServices } from "../services/extensions.js";

/** Dependencies are owned by the trusted Registry Worker and its Go host. */
export interface ExtensionRuntimeOptions {
  root: string;
  packageName: string;
  modules: ModuleLoader;
  policy: ModulePolicy;
  store: ResourceStore;
  registry: RegistryOptions;
  allocateOwner: (origin: import("../contracts/types.js").ContributionOrigin) => string;
  releaseOwner: (id: string) => void;
  reserve: ManagedReserve;
  approval?: ExtensionApproval;
}

export interface ExtensionApproval {
  readonly objectId: string;
  readonly revision: string;
  readonly config: JsonObject;
}

export function parseExtensionApproval(value: unknown): ExtensionApproval {
  requireCondition(isPlainRecord(value) && typeof value.objectId === "string" &&
    value.objectId.length > 0 && value.objectId.length <= 256 && !value.objectId.includes("\0") &&
    typeof value.revision === "string" && value.revision.length > 0 && value.revision.length <= 256 &&
    !value.revision.includes("\0") && isPlainRecord(value.config),
  "extension_not_enabled", "The extension requires its Go-approved configuration revision.");
  return Object.freeze({ objectId: value.objectId, revision: value.revision,
    config: JSON.parse(canonicalJson(value.config)) as JsonObject });
}

/** Restores one already-approved npm instance and its actual contributions. */
export async function restoreExtension(options: ExtensionRuntimeOptions) {
  const root = realpathSync.native(options.root);
  const work = root;
  requireCondition(root === options.root && options.store.root === root &&
    options.modules.work === work && realpathSync.native(work) === work &&
    typeof options.reserve === "function",
  "extension_profile_mismatch", "Extension recovery requires one established Agent profile.");
  const saved = parseExtensionApproval(options.approval);
  const resources = new ResourceManager(options.store, {
    allocateOwner: options.allocateOwner,
    releaseOwner: options.releaseOwner,
  });
  const registry = new ExtensionRegistry(resources, options.registry);
  const materials = new ExtensionMaterials(work, {
    reserve: options.reserve,
  });
  const packages = new ExtensionPackageLoader(registry, options.modules, {
    policy: options.policy,
    permissions: options.registry.permissions,
    enabled: () => new Set([options.packageName]),
  });
  const extensions = new ExtensionServices(registry, packages, materials);
  const info = await extensions.enable(options.packageName, saved.config);
  const catalog = extensions.methodCatalog(options.packageName);
  requireCondition(typeof catalog.origin.namespace === "string", "invalid_namespace",
    "A published npm extension requires its namespace.");
  const methods = catalog.methods.map((method) => {
    requireCondition(typeof method.name === "string" && Array.isArray(method.path) &&
      method.path.every((part) => typeof part === "string") && Array.isArray(method.permissions),
    "invalid_method", "A published npm extension needs its actual method metadata.");
    const methodPath = [catalog.origin.namespace!, ...method.path];
    return {
      methodId: `extension_${digest([saved.objectId, catalog.origin.revision, methodPath])}`,
      source: { kind: "extension", objectId: saved.objectId, revision: catalog.origin.revision,
        approvalRevision: saved.revision },
      operation: method.name,
      path: methodPath,
      permissions: method.permissions,
      metadata: method,
    };
  });
  let closed = false;
  return {
    registry,
    resources,
    info,
    methods,
    withPackageChanges: <T>(action: () => Promise<T>) => extensions.withPackageChanges(action),
    published: () => materials.published(),
    scriptSources: () => materials.scriptSources(),
    activeDirectories: () => materials.activeDirectories(),
    async close(): Promise<JsonObject> {
      requireCondition(!closed, "extension_unavailable", "The extension instance has already closed.");
      const report = await extensions.disable(options.packageName);
      if (report.status === "disabled") closed = true;
      return report;
    },
  };
}
