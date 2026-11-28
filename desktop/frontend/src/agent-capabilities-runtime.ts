import { projectAgentCapabilities, type AgentCapabilitiesInventory, type AgentCapability, type AgentCapabilityDetail, type CapabilityAlert, type CapabilityMaintenanceProgress, type CapabilityObservation } from "./agent-capabilities";

export type CapabilityScope = { targetId: string; operationId: string; agentId: string; bootId: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid capability inventory");
  return value as Record<string, unknown>;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 &&
    !value.includes(String.fromCharCode(0)) && !value.includes("\r") && !value.includes("\n");
}

export function parseAgentCapabilityDetail(value: unknown, scope: CapabilityScope, item: AgentCapability): AgentCapabilityDetail {
  const v = record(value);
  if (v.protocol !== 1 || (v.profile !== "development" && v.profile !== "production") ||
      Object.entries(scope).some(([key, expected]) => !text(expected) || v[key] !== expected)) {
    throw new Error("unverified capability detail");
  }
  const detail = record(v.detail);
  const kind = detail.type === "mcp" ? "mcp" : detail.type === "openapi" ? "api" : detail.type === "npm" ? "npm" : null;
  if (detail.id !== item.id || detail.name !== item.name || kind !== item.kind || !Array.isArray(detail.methods) ||
      detail.methods.length > 64 || typeof detail.methodsComplete !== "boolean") throw new Error("invalid capability detail");
  const configuration = record(detail.configuration);
  const methods = detail.methods.map(value => {
    const method = record(value);
    if (!text(method.name) || !Array.isArray(method.parameters) || method.parameters.length > 32 ||
        (method.description !== undefined && (typeof method.description !== "string" || method.description.length > 2048)) ||
        (method.method !== undefined && typeof method.method !== "string") || (method.path !== undefined && typeof method.path !== "string")) {
      throw new Error("invalid capability method");
    }
    const parameters = method.parameters.map(value => {
      const parameter = record(value);
      if (!text(parameter.name) || typeof parameter.required !== "boolean" ||
          (parameter.type !== undefined && typeof parameter.type !== "string") ||
          (parameter.location !== undefined && !["path", "query", "header", "cookie", "body"].includes(String(parameter.location)))) throw new Error("invalid capability parameter");
      return { name: parameter.name, type: parameter.type as string | undefined, location: parameter.location as string | undefined, required: parameter.required };
    });
    return { name: method.name, description: method.description as string | undefined, method: method.method as string | undefined,
      path: method.path as string | undefined, parameters };
  });
  return { id: item.id, name: item.name, kind: item.kind, configuration, methods, methodsComplete: detail.methodsComplete };
}

export function parseAgentCapabilities(value: unknown, scope: CapabilityScope): AgentCapabilitiesInventory {
  const v = record(value);
  if (v.protocol !== 1 || (v.profile !== "development" && v.profile !== "production") ||
      Object.entries(scope).some(([key, expected]) => !text(expected) || v[key] !== expected) ||
      (v.state !== "available" && v.state !== "partial") || !Array.isArray(v.items) || v.items.length > 200) {
    throw new Error("unverified capability inventory");
  }
  const seen = new Set<string>();
  const resources = v.items.map(value => {
    const item = record(value);
    if (!text(item.id) || !text(item.name) || !["mcp", "openapi", "npm"].includes(String(item.type)) || seen.has(item.id)) {
      throw new Error("invalid capability item");
    }
    seen.add(item.id);
    return { id: item.id, name: item.name, type: item.type };
  });
  return { state: v.state, items: projectAgentCapabilities(resources) };
}

export function parseCapabilityObservation(value: unknown, scope: CapabilityScope): CapabilityObservation {
  const v = record(value);
  const actual = record(v.scope);
  if (Object.entries(scope).some(([key, expected]) => !text(expected) || actual[key] !== expected) ||
      !["loading", "available", "partial", "unavailable"].includes(String(v.state)) ||
      !Array.isArray(v.facts) || v.facts.length > 200 || !Array.isArray(v.alerts) || v.alerts.length > 400) {
    throw new Error("unverified capability observation");
  }
  const seen = new Set<string>();
  const facts = v.facts.map(value => {
    const fact = record(value);
    if (!text(fact.id) || !text(fact.name) || !["mcp", "openapi", "npm"].includes(String(fact.type)) || seen.has(fact.id)) throw new Error("invalid capability fact");
    seen.add(fact.id);
    if (fact.revision !== undefined && (typeof fact.revision !== "string" || !/^[a-f0-9]{64}$/.test(fact.revision))) throw new Error("invalid capability revision");
    return { id: fact.id, name: fact.name, type: fact.type, revision: fact.revision };
  });
  const alerts = v.alerts.map(value => {
    const alert = record(value);
    if (!text(alert.id) || !seen.has(alert.id) || !["problem", "advice"].includes(String(alert.level)) ||
        !["mcp_disconnected", "source_activation_failed", "mcp_managed_process_unavailable", "extension_load_failed", "package_missing", "package_invalid", "npm_update_available", "configuration_pending_approval"].includes(String(alert.reason)) ||
        typeof alert.observedAt !== "string" || Number.isNaN(Date.parse(alert.observedAt)) ||
        (alert.version !== undefined && !text(alert.version))) throw new Error("invalid capability alert");
    return { id: alert.id, level: alert.level, reason: alert.reason, observedAt: alert.observedAt, ...(alert.version ? { version: alert.version } : {}) } as CapabilityAlert;
  });
  const severity = alerts.some(item => item.level === "problem") ? "problem" : alerts.some(item => item.level === "advice") ? "advice" : undefined;
  if ((v.severity || undefined) !== severity) throw new Error("invalid capability severity");
  const rawOperations = v.operations ?? [];
  if (!Array.isArray(rawOperations) || rawOperations.length > 200) throw new Error("invalid maintenance progress");
  const operationIds = new Set<string>();
  const operations = rawOperations.map(value => {
    const op = record(value);
    if (!text(op.id) || operationIds.has(op.id) || !text(op.name) || !["remove", "update"].includes(String(op.action)) ||
      !["executing", "succeeded", "failed", "busy", "changed", "unavailable", "unknown"].includes(String(op.status)) ||
      (op.revision !== undefined && (typeof op.revision !== "string" || !/^[a-f0-9]{64}$/.test(op.revision))) ||
      (op.version !== undefined && !text(op.version)) || (op.restarted !== undefined && typeof op.restarted !== "boolean") || (op.errorCode !== undefined && (typeof op.errorCode !== "string" || !/^[a-z0-9_]{1,128}$/.test(op.errorCode)))) throw new Error("invalid maintenance progress");
    operationIds.add(op.id);
    return { id: op.id, name: op.name, action: op.action, status: op.status, ...(op.revision ? { revision: op.revision } : {}), ...(op.version ? { version: op.version } : {}), ...(op.errorCode ? { errorCode: op.errorCode } : {}), ...(op.restarted === true ? { restarted: true } : {}) } as CapabilityMaintenanceProgress;
  });
  return { state: v.state as CapabilityObservation["state"], items: projectAgentCapabilities(facts), alerts, severity, operations };
}
