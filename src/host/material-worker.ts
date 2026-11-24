import { MessagePort, parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { isAgentError, requireCondition } from "../contracts/errors.js";
import { isPlainRecord } from "../contracts/json.js";
import type { Binding, ContributionOrigin } from "../contracts/types.js";
import { MaterialRetention } from "../runtime/material-retention.js";
import { ScriptCatalog, type ScriptSource } from "../runtime/scripts.js";
import type { PublishedMaterials, WorkOptions } from "../work/service.js";
import { createMaterialFactory } from "./material-factory.js";
import { MaterialRPC } from "./material-rpc.js";
import { HostPackagePolicy } from "./package-policy.js";
import { callHostSync } from "./sync-rpc.js";

async function start(): Promise<void> {
  requireCondition(parentPort && isPlainRecord(workerData) && workerData.port instanceof MessagePort &&
    typeof workerData.root === "string" && path.isAbsolute(workerData.root) &&
    typeof workerData.instanceId === "string" && typeof workerData.bootId === "string" &&
    isPlainRecord(workerData.binding) && isPlainRecord(workerData.agent) &&
    (workerData.home === null || typeof workerData.home === "string") &&
    isPlainRecord(workerData.request) && typeof workerData.request.ticket === "string" &&
    Array.isArray(workerData.request.sourceSnapshot),
  "invalid_work_scope", "The material Worker configuration is invalid.");
  const parent = parentPort;
  const port = workerData.port;
  const request = workerData.request;
  const root = workerData.root;
  const instanceId = workerData.instanceId;
  const ticket = request.ticket;
  const binding = workerData.binding as unknown as Binding;
  const bootId = workerData.bootId;
  const scope = { instanceId, ticket };
  const snapshot = request.sourceSnapshot as unknown[];
  requireCondition(snapshot.every((entry) => isPlainRecord(entry) && isPlainRecord(entry.source) &&
    isPlainRecord(entry.materials) && Array.isArray(entry.materials.instructions) &&
    Array.isArray(entry.materials.skills) && Array.isArray(entry.materials.scriptSources)),
  "invalid_work_scope", "The source snapshot is incomplete.");
  const sources = snapshot.map((entry) => (entry as { materials: { scriptSources: ScriptSource[] } }).materials.scriptSources).flat();
  const published: PublishedMaterials = {
    instructions: snapshot.flatMap((entry) => (entry as { materials: PublishedMaterials }).materials.instructions),
    skills: snapshot.flatMap((entry) => (entry as { materials: PublishedMaterials }).materials.skills),
    // Only Go's approved method source may admit a generated local Skill.
    goSourceOrigins: snapshot.flatMap((entry) => {
      const source = (entry as { source: Record<string, unknown> }).source;
      if ((source.kind !== "api" && source.kind !== "mcp") || typeof source.objectId !== "string" ||
          typeof source.name !== "string" || typeof source.revision !== "string" ||
          typeof source.approvalRevision !== "string" || !source.approvalRevision) return [];
      return (entry as { materials: PublishedMaterials }).materials.skills.flatMap((skill) => {
        const origin = skill.origin;
        return origin.type === "local" && origin.owner === `${source.kind}:${source.objectId}` &&
          origin.namespace === source.name && origin.revision === source.revision ? [origin as ContributionOrigin] : [];
      });
    }),
  };
  const work = root;
  const packages = await HostPackagePolicy.open(root);
  const reserve = async (bytes: number) => {
    const value = callHostSync(port, "work.storage.reserve", { ...scope, bytes });
    requireCondition(isPlainRecord(value) && typeof value.reservation === "string",
      "storage_reservation_failed", "Go did not confirm the work reservation.");
    const reservation = value.reservation;
    let released = false;
    return { release() {
      if (released) return;
      const response = callHostSync(port, "work.storage.release", { ...scope, reservation });
      requireCondition(isPlainRecord(response) && response.released === true,
        "storage_reservation_failed", "Go did not release the work reservation.");
      released = true;
    } };
  };
  const retention = new MaterialRetention(root, {
    reserve,
    liveSnapshotRefs: () => {
      const result = callHostSync(port, "work.materials.liveRefs", scope);
      requireCondition(isPlainRecord(result) && Array.isArray(result.refs) &&
        result.refs.every((ref) => typeof ref === "string"),
      "material_retention_unavailable", "Go did not return live material references.");
      return new Set(result.refs as string[]);
    },
  });
  const materialRetention: NonNullable<WorkOptions["materialRetention"]> = {
    async hold(kind, directory) {
      const result = callHostSync(port, "work.materials.hold", { ...scope, kind, directory });
      requireCondition(isPlainRecord(result) && typeof result.hold === "string",
        "material_retention_unavailable", "Go did not hold the prepared material.");
      const hold = result.hold;
      let local: { release(): void };
      try { local = await retention.hold(kind, directory); }
      catch (cause) { callHostSync(port, "work.materials.release", { ...scope, hold }); throw cause; }
      let released = false;
      return { release() {
        if (released) return;
        const response = callHostSync(port, "work.materials.release", { ...scope, hold });
        requireCondition(isPlainRecord(response) && response.released === true,
          "material_retention_unavailable", "Go did not release the prepared material hold.");
        local.release();
        released = true;
      } };
    },
  };
  const scripts = new ScriptCatalog(work, binding.agentId, () => sources);
  const factory = createMaterialFactory({ root, binding, bootId, scripts, policy: packages.policy,
    home: workerData.home, agent: workerData.agent as unknown as WorkOptions["agent"],
    reserve, materialRetention,
    authorize: (_request, _caller, target) => {
      const value = callHostSync(port, "work.authorize", { ...scope, action: target.action,
        path: target.path ?? target.project?.root ?? target.work?.pwd ?? "",
        projectId: target.work?.projectId ?? null, contextId: target.work?.contextId ?? null });
      requireCondition(isPlainRecord(value) && value.authorized === true,
        "forbidden", "Go did not authorize material access.");
    },
    materials: () => published,
    canUseScript: (_request, origin) => {
      const value = callHostSync(port, "work.canUseScript", { ...scope, origin });
      requireCondition(isPlainRecord(value) && typeof value.allowed === "boolean",
        "forbidden", "Go did not return a source authorization.");
      return value.allowed;
    },
  });
  const rpc = new MaterialRPC(instanceId, factory);
  const controller = new AbortController();
  parent.on("message", (value: unknown) => {
    if (!isPlainRecord(value)) return;
    if (value.type === "release" && typeof value.committed === "boolean") {
      try { rpc.release({ instanceId, ticket, committed: value.committed });
        parent.postMessage({ type: "released" }); }
      catch (cause) { parent.postMessage({ type: "releaseFailed", code: isAgentError(cause) ? cause.code : "work_snapshot_unavailable" }); }
    }
    if (value.type === "cancel") controller.abort();
  });
  try {
    const result = await rpc.prepare(request, controller.signal);
    parent.postMessage({ type: "prepared", result });
  } catch (cause) {
    parent.postMessage({ type: "failed", code: isAgentError(cause) ? cause.code : "work_snapshot_unavailable" });
  }
}

void start().catch((cause: unknown) => {
  parentPort?.postMessage({ type: "failed", code: isAgentError(cause) ? cause.code : "work_snapshot_unavailable" });
});
