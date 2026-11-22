import { MessagePort } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { requireCondition } from "../contracts/errors.js";
import type { Binding, ContributionOrigin } from "../contracts/types.js";
import type { ResourceStore } from "../extensions/resources.js";
import { callHostSync } from "./sync-rpc.js";

type StoreMethod = Exclude<keyof ResourceStore, "root" | "binding" | "bootId">;

/** Populated by trusted Registry lifecycle code from Go-issued identities. */
export interface RegistryStoreScope {
  readonly instanceId: string;
  readonly sourceInstanceId: string;
  readonly runId?: string;
}

/** One trusted Worker owns one Go-registered extension instance. */
export function registryOwner(port: MessagePort, instanceId: string, preparationId?: string) {
  requireCondition(typeof instanceId === "string" && instanceId.length > 0 &&
    (preparationId === undefined || (typeof preparationId === "string" && preparationId.length > 0 && preparationId.length <= 256)),
    "invalid_registry_scope", "The Registry Worker needs its actual host identity.");
  const run = new AsyncLocalStorage<string>();
  let sourceInstanceId: string | undefined;
  return Object.freeze({
    allocateOwner(origin: ContributionOrigin): string {
      requireCondition(!sourceInstanceId, "registry_instance_conflict", "This Registry Worker already owns an instance.");
      const id = callHostSync(port, "resource.registerInstance", { instanceId, origin,
        ...(preparationId ? { preparationId } : {}) });
      requireCondition(typeof id === "string" && /^instance_[0-9a-f]{32}$/.test(id),
        "invalid_registry_scope", "Go did not return a valid source instance identity.");
      sourceInstanceId = id;
      return id;
    },
    releaseOwner(id: string): void {
      requireCondition(sourceInstanceId === id, "invalid_registry_scope", "The source instance does not belong to this Worker.");
      callHostSync(port, "resource.unregisterInstance", { instanceId, sourceInstanceId: id });
      sourceInstanceId = undefined;
    },
    scope(): RegistryStoreScope {
      requireCondition(sourceInstanceId, "invalid_registry_scope", "The source instance has not been registered by Go.");
      const runId = run.getStore();
      return { instanceId, sourceInstanceId, ...(runId ? { runId } : {}) };
    },
    current(): { instanceId: string; sourceInstanceId?: string; preparationId?: string; runId?: string } {
      const runId = run.getStore();
      return { instanceId, ...(sourceInstanceId ? { sourceInstanceId } : preparationId ? { preparationId } : {}),
        ...(runId ? { runId } : {}) };
    },
    withRun<T>(runId: string, task: () => T): T {
      requireCondition(typeof runId === "string" && /^run_[0-9a-f]{32}$/.test(runId),
        "invalid_run_scope", "The source invocation needs an actual Run identity.");
      return run.run(runId, task);
    },
  });
}

/**
 * Registry Worker view of the Go-owned store. Go must bind the port to the
 * actual host instance and authorize every operation before accessing state.
 */
export function registryStore(port: MessagePort, root: string, binding: Binding, bootId: string,
  scope: () => RegistryStoreScope): ResourceStore {
  requireCondition(path.isAbsolute(root) && typeof bootId === "string" &&
    /^boot_[0-9a-f]{32}$/.test(bootId) && typeof binding.agentId === "string" &&
    binding.agentId.length > 0 && (binding.profile === "development" || binding.profile === "production") &&
    typeof binding.cloudEnvironment === "string" && binding.cloudEnvironment.length > 0 && typeof scope === "function",
  "invalid_registry_binding", "The Registry Worker needs the actual profile and Agent binding.");
  const fixedBinding = Object.freeze({ ...binding });
  const request = <K extends StoreMethod>(method: K, args: Parameters<ResourceStore[K]>): ReturnType<ResourceStore[K]> => {
    const fixed = [...args];
    while (fixed.length && fixed.at(-1) === undefined) fixed.pop();
    const current = scope();
    requireCondition(current && typeof current.instanceId === "string" && current.instanceId.length > 0 &&
      typeof current.sourceInstanceId === "string" && current.sourceInstanceId.length > 0 &&
      (current.runId === undefined || (typeof current.runId === "string" && current.runId.length > 0)),
    "invalid_registry_scope", "The Registry operation lacks its Go-issued source identity.");
    return callHostSync(port, `resource.${method}`, {
      instanceId: current.instanceId, sourceInstanceId: current.sourceInstanceId,
      ...(current.runId ? { runId: current.runId } : {}), args: fixed,
    }) as ReturnType<ResourceStore[K]>;
  };
  return Object.freeze<ResourceStore>({
    root,
    binding: fixedBinding,
    bootId,
    getRun: (...args) => request("getRun", args),
    getResource: (...args) => request("getResource", args),
    resourceHistory: (...args) => request("resourceHistory", args),
    scanResourceHistory: (...args) => request("scanResourceHistory", args),
    registerResource: (...args) => request("registerResource", args),
    handoff: (...args) => request("handoff", args),
    resourceDiagnostic: (...args) => request("resourceDiagnostic", args),
    closeResource: (...args) => request("closeResource", args),
    resourcesForRun: (...args) => request("resourcesForRun", args),
  });
}
