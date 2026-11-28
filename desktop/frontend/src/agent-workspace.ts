import type { AgentTarget } from "./agent-targets";
import type { MessageKey } from "./i18n";

// Navigation categories, not capability availability or management permissions.
export const agentWorkspaceSections = {
  capabilities: { title: "agentWorkspaceCapabilities", detail: "agentWorkspaceCapabilitiesDetail", items: [] },
  materials: { title: "agentWorkspaceMaterials", detail: "agentWorkspaceMaterialsDetail", items: ["Skills", "Scripts", "Instructions"] },
  activity: { title: "agentWorkspaceActivity", detail: "agentWorkspaceActivityDetail", items: ["agentWorkspaceTasks", "agentWorkspaceRuns", "agentWorkspaceRuntime"] },
  maintenance: { title: "agentWorkspaceMaintenance", detail: "agentWorkspaceMaintenanceDetail", items: ["agentWorkspaceConfiguration", "agentWorkspaceService", "agentWorkspaceResources", "agentWorkspaceDiagnostics"] },
} as const satisfies Record<string, { title: MessageKey; detail: MessageKey; items: readonly string[] }>;

export type AgentWorkspaceSection = keyof typeof agentWorkspaceSections;

// These are deliberately separate facts. A reachable SSH target, a running
// service and a Cloud connection cannot stand in for a management connection.
export type AgentWorkspaceSummary = {
  name: string;
  platform: string;
  arch: string;
  version: string;
  runtime: "healthy" | "degraded" | "stopped" | "unknown";
  management: "connected" | "disconnected" | "unknown";
  cloud: "online" | "offline" | "unknown";
};

export type AgentTelemetry = { profile: string; observedAt: string; cpu?: number; memory?: number };

export type AgentSystemEvent = {
  time: string;
  component: "agent" | "cloud" | "node_host" | "storage";
  kind: "component_failed" | "cloud_online" | "cloud_offline" | "host_ready" | "host_not_ready";
};

export type AgentSystemEvents = { items: AgentSystemEvent[]; partial: boolean };

export function sampleAgentWorkspace(target: AgentTarget, isMac: boolean): AgentWorkspaceSummary {
  // Only used in the explicit development preview; never read live Agent state.
  const platform = target.id === "preview-linux" ? "Linux" : target.id === "preview-windows" ? "Windows" : isMac ? "macOS" : "Windows";
  return {
    name: target.kind === "local" ? target.description : target.name,
    platform, arch: platform === "macOS" ? "ARM64" : "x64", version: "1.1.0",
    runtime: "healthy", management: "connected", cloud: "online",
  };
}
