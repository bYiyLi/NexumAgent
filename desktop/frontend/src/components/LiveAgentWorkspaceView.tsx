import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { FoundationService } from "../../bindings/github.com/bYiyLi/NexumAgent/desktop";
import type { AgentTarget } from "../agent-targets";
import type { Messages } from "../i18n";
import type { LifecycleSnapshot, LiveSummary } from "../agent-lifecycle";
import type { AgentCapabilitiesInventory, AgentCapability, CapabilityObservation, CapabilityReconnectResult } from "../agent-capabilities";
import { mergeCapabilityInventory } from "../agent-capabilities";
import { parseAgentCapabilities, parseAgentCapabilityDetail, parseCapabilityObservation } from "../agent-capabilities-runtime";
import { parseActivity, type ActivityRequest } from "../agent-activity-runtime";
import type { AgentMaterial, AgentMaterialsInventory } from "../agent-materials";
import type { AgentSystemEvent, AgentSystemEvents, AgentTelemetry } from "../agent-workspace";
import { AgentWorkspaceView } from "./AgentWorkspaceView";
import type { AgentMaintenanceAction } from "./AgentMaintenanceActions";

type Props = {
  t: Messages;
  current: AgentTarget;
  isMac: boolean;
  snapshot: LifecycleSnapshot & { summary: LiveSummary };
  profile?: string;
  onEndPreview: () => void;
  onOpenMarketplace: () => void;
  onRecheck: () => void;
  onMaintenanceAction: (action: AgentMaintenanceAction) => void;
};

// StrictMode can mount and immediately unmount a workspace. Serializing its
// control calls ensures a late stop cannot cancel the next mounted session.
let capabilityMonitorActions: Promise<void> = Promise.resolve();
function queueCapabilityMonitor(action: () => Promise<void>) {
  const next = capabilityMonitorActions.then(action);
  capabilityMonitorActions = next.catch(() => {});
  return next;
}

let materialsMonitorActions: Promise<void> = Promise.resolve();
function queueMaterialsMonitor<T>(action: () => Promise<T>): Promise<T> {
  const next = materialsMonitorActions.then(action);
  materialsMonitorActions = next.then(() => {}, () => {});
  return next;
}

export function LiveAgentWorkspaceView({ snapshot, ...props }: Props) {
  const { targetId, operationId, summary: { agentId, bootId } } = snapshot;
  const key = JSON.stringify([targetId, operationId, agentId, bootId]);
  const [observation, setObservation] = useState<{ key: string; inventory: AgentCapabilitiesInventory } | null>(null);
  const [health, setHealth] = useState<{ key: string; value: CapabilityObservation } | null>(null);
  const inventoryGeneration = useRef(0);
  const [materialsObservation, setMaterialsObservation] = useState<{ key: string; inventory: AgentMaterialsInventory } | null>(null);
  const [localMaintenance, setLocalMaintenance] = useState<{key: string; available: boolean} | null>(null);
  useEffect(() => {
    let active = true;
    if (snapshot.summary.cloud === "online" && !snapshot.busy) void FoundationService.GetCapabilityMaintenanceAvailability(targetId, operationId, agentId, bootId).then(available => { if (active) setLocalMaintenance({key, available: available === true}); }, () => { if (active) setLocalMaintenance({key, available: false}); });
    return () => { active = false; };
  }, [targetId, operationId, agentId, bootId, key, snapshot.summary.cloud, snapshot.busy]);
  const [maintenanceAvailability, setMaintenanceAvailability] = useState<{ key: string; available: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void FoundationService.GetAgentMaintenanceAvailability(targetId, operationId, agentId, bootId).then(
      available => { if (active) setMaintenanceAvailability({ key, available: available === true }); },
      () => { if (active) setMaintenanceAvailability({ key, available: false }); },
    );
    return () => { active = false; };
  }, [targetId, operationId, agentId, bootId, key]);
  useEffect(() => {
    let active = true;
    let reading = false;
    let pending = false;
    const generation = inventoryGeneration;
    const refresh = async () => {
      if (!active) return;
      if (reading) { pending = true; return; }
      reading = true;
      try {
        const value = parseCapabilityObservation(await FoundationService.GetCapabilityObservation(targetId, operationId, agentId, bootId), { targetId, operationId, agentId, bootId });
        if (active) setHealth({ key, value });
      } catch {
        if (active) setHealth({ key, value: { state: "unavailable", items: [], alerts: [] } });
      } finally {
        reading = false;
        if (active && pending) { pending = false; void refresh(); }
      }
    };
    const off = Events.On("capability:changed", () => { void refresh(); });
    void queueCapabilityMonitor(async () => {
      if (!active) return;
      await FoundationService.StartCapabilityMonitor(targetId, operationId, agentId, bootId);
      if (active) await refresh();
    }).catch(() => { if (active) setHealth({ key, value: { state: "unavailable", items: [], alerts: [] } }); });
    return () => {
      active = false;
      off();
      generation.current++;
      void queueCapabilityMonitor(async () => { await FoundationService.StopCapabilityMonitor(targetId, operationId, agentId, bootId); });
    };
  }, [targetId, operationId, agentId, bootId, key]);
  const loadCapabilities = useCallback(() => {
    const generation = ++inventoryGeneration.current;
    setObservation({ key, inventory: { state: "loading", items: [] } });
    void capabilityMonitorActions.then(() => FoundationService.GetAgentCapabilities(targetId, operationId, agentId, bootId)).then(value => {
      const inventory = parseAgentCapabilities(value, { targetId, operationId, agentId, bootId });
      if (inventoryGeneration.current === generation) setObservation({ key, inventory });
    }).catch(() => {
      if (inventoryGeneration.current === generation) setObservation({ key, inventory: { state: "unavailable", items: [] } });
    });
  }, [targetId, operationId, agentId, bootId, key]);
  const readDetail = useCallback(async (item: AgentCapability) => {
    await capabilityMonitorActions;
    return parseAgentCapabilityDetail(await FoundationService.GetAgentCapabilityDetail(targetId, operationId, agentId, bootId, item.id),
      { targetId, operationId, agentId, bootId }, item);
  }, [targetId, operationId, agentId, bootId]);
  const setCapabilityDetailViewing = useCallback((viewing: boolean) => {
    return queueCapabilityMonitor(async () => { await FoundationService.SetCapabilityDetailViewing(targetId, operationId, agentId, bootId, viewing); });
  }, [targetId, operationId, agentId, bootId]);
  const reconnectCapability = useCallback(async (item: AgentCapability): Promise<CapabilityReconnectResult> => {
    if (item.kind !== "mcp" || !item.revision) return "changed";
    try {
      const result = await FoundationService.ReconnectCapability(targetId, operationId, agentId, bootId, item.id, item.revision);
      return result === "succeeded" || result === "busy" || result === "changed" ? result : "unknown";
    } catch { return "unknown"; }
  }, [targetId, operationId, agentId, bootId]);
  const maintainCapability = useCallback(async (item: AgentCapability, action: "remove" | "update", version?: string) => {
    if (!item.revision) throw new Error("capability revision unavailable");
    await FoundationService.StartCapabilityMaintenance(targetId, operationId, agentId, bootId, item.id, item.revision, action, version ?? "");
  }, [targetId, operationId, agentId, bootId]);
  const readActivity = useCallback(async (request: ActivityRequest) => parseActivity(await FoundationService.GetAgentActivity(
    targetId, operationId, agentId, bootId, request.action, request.action === "list" ? "" : request.runId,
    request.action === "list" ? request.cursor : "", request.action === "part" ? request.kind : "", request.action === "part" ? request.offset : 0),
  { targetId, operationId, agentId, bootId }, request), [targetId, operationId, agentId, bootId]);
  const verifyWorkspace = useCallback((value: Awaited<ReturnType<typeof FoundationService.GetAgentMaterials>>) => {
    if (value.protocol !== 1 || (value.profile !== "development" && value.profile !== "production") ||
        value.targetId !== targetId || value.operationId !== operationId || value.agentId !== agentId || value.bootId !== bootId) {
      throw new Error("environment changed");
    }
    return value;
  }, [targetId, operationId, agentId, bootId]);
  useEffect(() => {
    if (snapshot.summary.cloud !== "online") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const view = await queueMaterialsMonitor(() => FoundationService.GetAgentMaterialsOverview(targetId, operationId, agentId, bootId));
        if (view.targetId !== targetId || view.operationId !== operationId || view.agentId !== agentId || view.bootId !== bootId ||
            !["loading", "available", "partial", "unavailable"].includes(view.state) || !Array.isArray(view.items)) throw new Error("materials unavailable");
        const items = view.items.map((item): AgentMaterial => {
          if (item.kind !== "skill" && item.kind !== "script" && item.kind !== "instruction") throw new Error("invalid material kind");
          const notice = item.notice === "danger" || item.notice === "advice" || item.notice === "update" ? item.notice : undefined;
          if (item.notice && !notice) throw new Error("invalid material notice");
          const source = item.source === "personal" ? props.t.agentMaterialsPersonal : item.source === "local" ? props.t.agentMaterialsLocal :
            item.source === "platform" ? props.t.agentMaterialsBuiltin : item.source === "extension" ? props.t.agentMaterialsExtension : undefined;
          return { id: item.id, name: item.name, kind: item.kind, description: item.description, source, revision: item.revision,
            notice, problem: item.problem, canRemove: item.canRemove,
            installedRevision: item.installedRevision, availableRevision: item.availableRevision,
            updateCheck: item.updateCheck === "checked" || item.updateCheck === "unknown" ? item.updateCheck : undefined };
        });
        if (active) setMaterialsObservation({ key, inventory: { state: view.state as AgentMaterialsInventory["state"], items } });
      } catch {
        if (active) setMaterialsObservation({ key, inventory: { state: "unavailable", items: [] } });
      }
      if (active) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [targetId, operationId, agentId, bootId, key, snapshot.summary.cloud, props.t]);
  const readMaterial = useCallback(async (item: AgentMaterial, member = "") => {
    const { materials } = verifyWorkspace(await FoundationService.GetAgentMaterials(targetId, operationId, agentId, bootId, item.kind, item.id, member));
    const detail = materials?.detail;
    if (!detail || detail.id !== item.id || detail.kind !== item.kind || (member && member !== detail.member)) throw new Error("material unavailable");
    return { ...detail, members: detail.members ?? undefined };
  }, [targetId, operationId, agentId, bootId, verifyWorkspace]);
  const readTelemetry = useCallback(async (): Promise<AgentTelemetry> => {
    const { profile, telemetry } = verifyWorkspace(await FoundationService.GetAgentTelemetry(targetId, operationId, agentId, bootId));
    if (!telemetry) throw new Error("telemetry unavailable");
    return { profile, observedAt: telemetry.observedAt, cpu: telemetry.cpuPercent ?? undefined, memory: telemetry.memoryRssMb ?? undefined };
  }, [targetId, operationId, agentId, bootId, verifyWorkspace]);
  const readSystemEvents = useCallback(async (): Promise<AgentSystemEvents> => {
    const { systemEvents } = verifyWorkspace(await FoundationService.GetAgentSystemEvents(targetId, operationId, agentId, bootId));
    if (!systemEvents || !Array.isArray(systemEvents.items) || systemEvents.items.length > 20 || typeof systemEvents.partial !== "boolean") {
      throw new Error("system events unavailable");
    }
    const items = systemEvents.items.map((event): AgentSystemEvent => {
      if (!Number.isFinite(Date.parse(event.time)) ||
          !["agent", "cloud", "node_host", "storage"].includes(event.component) ||
          !["component_failed", "cloud_online", "cloud_offline", "host_ready", "host_not_ready"].includes(event.kind)) {
        throw new Error("invalid system event");
      }
      return { time: event.time, component: event.component as AgentSystemEvent["component"], kind: event.kind as AgentSystemEvent["kind"] };
    });
    return { items, partial: systemEvents.partial };
  }, [targetId, operationId, agentId, bootId, verifyWorkspace]);
  const openCloudAgent = useCallback(async () => {
    await FoundationService.OpenCloudAgent(targetId, operationId, agentId, bootId);
  }, [targetId, operationId, agentId, bootId]);
  const capabilityHealth: CapabilityObservation = health?.key === key ? health.value : { state: "loading", items: [], alerts: [] };
  const completed = useRef("");
  useEffect(() => {
    const signature = JSON.stringify(capabilityHealth.operations?.filter(op => op.status === "succeeded" || op.status === "unknown") ?? []);
    if (signature !== "[]" && signature !== completed.current) { completed.current = signature; loadCapabilities(); }
  }, [capabilityHealth.operations, loadCapabilities]);
  const inventoryBase: AgentCapabilitiesInventory = observation?.key === key ? observation.inventory : { state: "loading", items: [] };
  const inventory = mergeCapabilityInventory(inventoryBase, capabilityHealth);
  const materials: AgentMaterialsInventory = materialsObservation?.key === key ? materialsObservation.inventory : { state: "loading", items: [] };
  const refreshMaterials = useCallback(() => {
    void FoundationService.RefreshAgentMaterials(targetId, operationId, agentId, bootId).catch(() => {});
  }, [targetId, operationId, agentId, bootId]);
  const removeMaterial = {
    prepare: async (item: AgentMaterial) => {
      const prepared = await FoundationService.PrepareMaterialRemoval(targetId, operationId, agentId, bootId, item.kind, item.id);
      if (prepared.resourceId !== item.id || prepared.kind !== item.kind || !prepared.name || !prepared.location || !prepared.token) throw new Error("invalid removal");
      return { name: prepared.name, location: prepared.location, token: prepared.token };
    },
    confirm: async (item: AgentMaterial, token: string) => {
      await FoundationService.ConfirmMaterialRemoval(targetId, operationId, agentId, bootId, item.kind, item.id, token);
    },
  };
  const availability = maintenanceAvailability?.key === key ? maintenanceAvailability.available : undefined;
  const maintenanceNotice = snapshot.reason === "maintenance_busy" ? props.t.agentActionBusy :
    availability === false ? props.t.agentActionUnavailable :
    availability && snapshot.summary.cloud !== "online" ? props.t.agentActionCloudRequired : undefined;
  return <AgentWorkspaceView key={key} {...props} onMaintenanceAction={availability ? props.onMaintenanceAction : undefined} maintenanceNotice={maintenanceNotice} liveSummary={snapshot.summary} capabilities={inventory} capabilityObservation={capabilityHealth} onOpenCapabilities={loadCapabilities} reconnectCapability={reconnectCapability} resumeCapabilities={capabilityHealth.operations?.some(op => op.restarted === true)} maintainCapability={!snapshot.busy && snapshot.summary.cloud === "online" && localMaintenance?.key === key && localMaintenance.available ? maintainCapability : undefined} readCapabilityDetail={readDetail} onCapabilityDetailViewingChange={setCapabilityDetailViewing} readActivity={readActivity}
    materials={materials} readMaterial={readMaterial} removeMaterial={snapshot.summary.cloud === "online" ? removeMaterial : undefined} refreshMaterials={refreshMaterials} readTelemetry={readTelemetry} readSystemEvents={readSystemEvents} openCloudAgent={openCloudAgent}/>;
}
