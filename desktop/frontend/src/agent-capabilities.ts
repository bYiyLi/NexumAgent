import type { Messages } from "./i18n";

export type AgentCapabilityKind = "mcp" | "api" | "npm";

export type CapabilityAlert = {
  id: string;
  level: "problem" | "advice";
  reason: "mcp_disconnected" | "source_activation_failed" | "mcp_managed_process_unavailable" | "extension_load_failed" | "package_missing" | "package_invalid" | "npm_update_available" | "configuration_pending_approval";
  observedAt: string;
  version?: string;
};

export type CapabilityObservation = {
  state: "loading" | "available" | "partial" | "unavailable";
  items: readonly AgentCapability[];
  alerts: readonly CapabilityAlert[];
  severity?: "problem" | "advice";
  operations?: readonly CapabilityMaintenanceProgress[];
};

export type CapabilityMaintenanceProgress = {
  id: string;
  name: string;
  action: "remove" | "update";
  revision?: string;
  version?: string;
  status: "executing" | "succeeded" | "failed" | "busy" | "changed" | "unavailable" | "unknown";
  errorCode?: string;
  restarted?: boolean;
};

export function capabilityAlertText(t: Messages, kind: AgentCapabilityKind, alert: CapabilityAlert): string {
  switch (alert.reason) {
    case "mcp_disconnected": return t.agentCapabilityDisconnected;
    case "mcp_managed_process_unavailable": return t.agentCapabilityProcessFailed;
    case "source_activation_failed": return kind === "api" ? t.agentCapabilityAPIFailed : t.agentCapabilityMCPFailed;
    case "extension_load_failed": return t.agentCapabilityExtensionFailed;
    case "package_missing": return t.agentCapabilityPackageMissing;
    case "package_invalid": return t.agentCapabilityPackageInvalid;
    case "npm_update_available": return alert.version ? `${t.agentCapabilityUpdateAvailable} · ${alert.version}` : t.agentCapabilityUpdateAvailable;
    case "configuration_pending_approval": return t.agentCapabilityConfigurationPending;
  }
}

export type AgentCapability = {
  id: string;
  name: string;
  kind: AgentCapabilityKind;
  description?: string;
  revision?: string;
};

export type CapabilityReconnectResult = "succeeded" | "busy" | "changed" | "unknown";

export type AgentCapabilitiesInventory = {
  state: "loading" | "available" | "partial" | "unavailable";
  items: readonly AgentCapability[];
};

// A complete observation can withdraw an item; a partial or unavailable
// observation cannot prove that an existing inventory item was removed.
export function mergeCapabilityInventory(inventory: AgentCapabilitiesInventory, observation: CapabilityObservation): AgentCapabilitiesInventory {
  if (inventory.state !== "available" && inventory.state !== "partial") {
    return inventory.state === "unavailable" && observation.items.length > 0 ? { state: "partial", items: observation.items } : inventory;
  }
  return {
    state: inventory.state === "partial" || observation.state === "partial" ? "partial" : "available",
    items: [
      ...inventory.items.flatMap(item => {
        const fact = observation.items.find(current => current.id === item.id);
        return fact ? [fact] : observation.state === "available" ? [] : [item];
      }),
      ...observation.items.filter(fact => !inventory.items.some(item => item.id === fact.id)),
    ],
  };
}

export type AgentCapabilityParameter = { name: string; type?: string; location?: string; required: boolean };
export type AgentCapabilityMethod = {
  name: string;
  description?: string;
  method?: string;
  path?: string;
  parameters: readonly AgentCapabilityParameter[];
};
export type AgentCapabilityDetail = {
  id: string;
  name: string;
  kind: AgentCapabilityKind;
  configuration: Record<string, unknown>;
  methods: readonly AgentCapabilityMethod[];
  methodsComplete: boolean;
};

export type AgentConsoleResource = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  description?: unknown;
  revision?: unknown;
};

// Only MCP, published OpenAPI and approved/installed npm packages belong in
// the capability center. Skills, Scripts and Instructions live elsewhere.
export function projectAgentCapabilities(resources: readonly AgentConsoleResource[]): AgentCapability[] {
  const items: AgentCapability[] = [];
  for (const resource of resources) {
    const kind = resource.type === "mcp" ? "mcp"
      : resource.type === "openapi" ? "api"
      : resource.type === "npm" ? "npm"
      : null;
    if (!kind || typeof resource.id !== "string" || !resource.id.trim()
      || typeof resource.name !== "string" || !resource.name.trim()) continue;
    const description = typeof resource.description === "string" ? resource.description.trim() : "";
    const revision = typeof resource.revision === "string" && /^[a-f0-9]{64}$/.test(resource.revision) ? resource.revision : undefined;
    items.push({ id: resource.id, name: resource.name.trim(), kind, ...(description ? { description } : {}), ...(revision ? { revision } : {}) });
  }
  return items;
}

// Explicit development-preview fixtures only; never observations of an Agent.
export function previewAgentCapabilities(t: Messages): AgentCapabilitiesInventory {
  return {
    state: "available",
    items: [
      { id: "preview-mcp-github", name: "GitHub", kind: "mcp", description: "MCP Server · Streamable HTTP" },
      { id: "preview-api-crm", name: "CRM API", kind: "api", description: t.agentCapabilityExampleAPI },
      { id: "preview-npm-browser", name: "@nexum-hub/browser", kind: "npm", description: t.agentCapabilityExampleSDK },
      { id: "preview-mcp-filesystem", name: "Filesystem", kind: "mcp", description: "MCP Server · stdio" },
      { id: "preview-npm-utils", name: "@acme/data-utils", kind: "npm", description: t.agentCapabilityExampleNpm },
    ],
  };
}

export const unavailableAgentCapabilities: AgentCapabilitiesInventory = {
  state: "unavailable",
  items: [],
};
