import { realpathSync } from "node:fs";
import path from "node:path";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { digest } from "../contracts/json.js";
import type { ContributionOrigin, JsonObject } from "../contracts/types.js";
import { ExtensionRegistry, type RegistryOptions } from "../extensions/registry.js";
import { ResourceManager, type ResourceStore } from "../extensions/resources.js";
import { CONTROL_OWNER, CONTROL_VERSION } from "../runtime/control-scripts.js";
import type { ManagedReserve, MaterialRetention } from "../runtime/material-retention.js";
import { platformFactories, type PlatformNamespace } from "../sdk/platform.js";
import { maintenanceMethods } from "../extensions/maintenance.js";
import { preparePlatformMaterials } from "./platform-materials.js";

export interface ManagedShellOptions {
  namespace?: PlatformNamespace;
  root: string;
  store: ResourceStore;
  registry: RegistryOptions;
  allocateOwner(origin: ContributionOrigin): string;
  releaseOwner(id: string): void;
  reserve: ManagedReserve;
  retention: MaterialRetention;
}

/** Prepares the existing shell SDK on a Go-backed resource store. */
export async function restoreManagedShell(options: ManagedShellOptions) {
  const root = realpathSync.native(options.root);
  const work = path.join(root, "work");
  requireCondition(root === options.root && options.store.root === root &&
    options.retention.root === root && realpathSync.native(work) === work,
  "invalid_process_context", "The shell SDK needs the established Agent profile.");

  const namespace = options.namespace ?? "sh";
  const origin: ContributionOrigin = {
    type: "platform", owner: CONTROL_OWNER, namespace,
    version: CONTROL_VERSION, revision: CONTROL_VERSION,
  };
  const permissions = {
    sh: ["path", "resource", "sh.execute", "sh.read", "sh.control", "storage.reserve"],
    runtime: ["runtime.input", "maintenance.execute"],
    state: ["state.agent.read", "state.agent.write", "state.user.read", "state.user.write"],
    output: ["output"], transfer: ["createUpload", "createDownload", "get", "list", "cancel"].map((name) => `transfer.${name}`),
    maintenance: [...maintenanceMethods, "get", "list", "cancel"].map((name) => `maintenance.${name}`),
  }[namespace];
  const resources = new ResourceManager(options.store, {
    allocateOwner: options.allocateOwner, releaseOwner: options.releaseOwner,
  });
  const registry = new ExtensionRegistry(resources, options.registry);
  const handle = await registry.prepare({ apiVersion: 1, origin, permissions }, platformFactories(() => {
    throw new AgentError("restart_unavailable", "Restart is owned by the Go Agent.");
  })[namespace]);
  let prepared: Awaited<ReturnType<typeof preparePlatformMaterials>> | undefined;
  try {
    prepared = await preparePlatformMaterials(work, namespace, handle, options.retention, options.reserve);
    registry.publish(handle);
    const methods = handle.methods.map((method) => {
      requireCondition(typeof method.name === "string" && Array.isArray(method.path) &&
        method.path.every((part) => typeof part === "string") && Array.isArray(method.permissions),
      "invalid_method", "The shell method must use the registered metadata.");
      const methodPath = [namespace, ...method.path];
      return {
        methodId: `platform_${digest([`platform:${namespace}`, CONTROL_VERSION, methodPath])}`,
        source: { kind: "platform", objectId: `platform:${namespace}`, revision: CONTROL_VERSION,
          approvalRevision: CONTROL_VERSION },
        operation: method.name, path: methodPath, permissions: method.permissions, metadata: method,
      };
    });
    const material = prepared;
    let publication: "pending" | "published" | "discarded" = "pending";
    let closed = false;
    return {
      registry,
      resources,
      info: { name: namespace, extensionId: handle.id, origin, status: "enabled",
        methodCount: methods.length, skills: [material.material.name] },
      methods,
      published: () => ({ instructions: [], skills: closed ? [] : [material.material] }),
      scriptSources: () => [],
      activeDirectories: () => new Set(closed ? [] : [material.material.path]),
      withPackageChanges: async <T>(action: () => Promise<T>) => action(),
      confirmPublished() {
        if (publication === "published") return;
        requireCondition(publication === "pending", "invalid_platform_source", "The publication is already settled.");
        material.confirmPublished();
        publication = "published";
      },
      confirmWithdrawn() {
        if (publication === "pending") {
          material.discard();
          publication = "discarded";
        }
      },
      async close(): Promise<JsonObject> {
        requireCondition(!closed, "extension_unavailable", "The shell SDK has already closed.");
        requireCondition(publication !== "pending", "publication_unconfirmed", "The shell publication has not been confirmed.");
        const report = await registry.disable(handle);
        if (report.status === "disabled") {
          if (publication === "published") options.retention.setPublished(`platform:${namespace}`, null);
          closed = true;
        }
        return report;
      },
    };
  } catch (cause) {
    prepared?.discard();
    try {
      const report = await registry.disable(handle);
      requireCondition(report.status === "disabled", "extension_cleanup_unconfirmed",
        "The shell SDK did not confirm its actual cleanup.");
    } catch (cleanup) {
      throw new AgentError("extension_cleanup_unconfirmed",
        "The shell SDK could not confirm cleanup after initialization failed.",
        undefined, { cause: cleanup });
    }
    throw cause;
  }
}
