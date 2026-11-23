import { AgentError } from "../contracts/errors.js";
import type { ContributionOrigin, JsonObject } from "../contracts/types.js";
import type { Caller } from "../contracts/caller.js";
import type { AccessTarget } from "./api.js";

export const maintenanceOrigin: ContributionOrigin = Object.freeze({
  type: "platform", owner: "nexum", namespace: "maintenance", version: "1", revision: "1",
});
export const maintenanceMethods = [
  "packages.install", "packages.update", "packages.remove",
  "extensions.enable", "extensions.disable",
  "mcp.add", "mcp.update", "mcp.remove",
  "api.import", "api.update", "api.remove",
] as const;
export type MaintenanceMethod = (typeof maintenanceMethods)[number];
export type MaintenanceTarget = "package" | "extension" | "mcp" | "api";
export type MaintenanceStatus = "pending" | "approved" | "denied" | "cancelled" | "expired";
export type MaintenanceAuthStatus = "not_required" | "required" | "ready" | "failed";
export interface MaintenanceSummary {
  readonly title: string;
  readonly changeKinds: readonly string[];
  readonly permissions: readonly string[];
  readonly version: string | null;
  readonly namespace: string | null;
  readonly restartMayBeRequired: boolean;
}
export interface MaintenanceDecision {
  readonly status: "approved" | "denied";
  readonly revision: number;
  readonly candidateRevision: string;
  readonly decidedAt: string;
  readonly decisionId: string;
}
export interface MaintenanceExecution {
  readonly operationId: string;
  readonly startedAt: string;
  readonly status?: string;
  readonly result?: JsonObject;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface MaintenanceRequestView {
  readonly requestId: string;
  readonly agentId: string;
  readonly profile: "development" | "production";
  readonly target: MaintenanceTarget;
  readonly action: string;
  readonly name: string;
  readonly status: MaintenanceStatus;
  readonly revision: number;
  readonly candidateRevision: string;
  readonly objectId: string | null;
  readonly baseRevision: string | null;
  readonly summary: MaintenanceSummary;
  readonly authStatus: MaintenanceAuthStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvalUrl?: string;
  readonly agentName?: string;
  readonly source?: { readonly name?: string };
  readonly decidedAt?: string;
  readonly decision?: MaintenanceDecision;
  readonly execution?: MaintenanceExecution;
}
export interface MaintenanceListOptions {
  readonly target?: MaintenanceTarget;
  readonly name?: string;
  readonly status?: MaintenanceStatus;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface MaintenanceCreated {
  readonly requestId: string;
  readonly status: MaintenanceStatus;
  readonly approvalUrl?: string;
  readonly expiresAt: string;
}

export interface MaintenanceScope {
  readonly caller: Caller;
  readonly operationId: string;
  readonly runId?: string;
  readonly pwd?: string;
  readonly signal: AbortSignal;
  readonly onAccepted?: (operationId: string) => void;
  assertCurrent(): void;
  authorize(target: AccessTarget): void;
}
export interface MaintenanceService {
  readonly packages: {
    install(input: { name: string; version?: string }): Promise<MaintenanceCreated>;
    update(input: { name: string; version?: string }): Promise<MaintenanceCreated>;
    remove(input: { name: string }): Promise<MaintenanceCreated>;
  };
  readonly extensions: {
    enable(input: { name: string }): Promise<MaintenanceCreated>;
    disable(input: { name: string }): Promise<MaintenanceCreated>;
  };
  readonly mcp: {
    add(input: Record<string, JsonObject>): Promise<MaintenanceCreated>;
    update(input: Record<string, JsonObject>): Promise<MaintenanceCreated>;
    remove(input: { name: string }): Promise<MaintenanceCreated>;
  };
  readonly api: {
    import(input: { name: string; url?: string; path?: string; config?: JsonObject }): Promise<MaintenanceCreated>;
    update(input: { name: string; url?: string; path?: string; config?: JsonObject }): Promise<MaintenanceCreated>;
    remove(input: { name: string }): Promise<MaintenanceCreated>;
  };
  get(requestId: string): Promise<MaintenanceRequestView>;
  list(options?: MaintenanceListOptions): Promise<{
    requests: readonly MaintenanceRequestView[];
    nextCursor: string | null;
  }>;
  cancel(requestId: string): Promise<MaintenanceRequestView>;
}

export function unavailableMaintenance(current: () => void): MaintenanceService {
  const unavailable = (): never => {
    current();
    throw new AgentError("maintenance_unavailable", "The trusted maintenance authority is not configured.");
  };
  return Object.freeze({
    packages: Object.freeze({ install: unavailable, update: unavailable, remove: unavailable }),
    extensions: Object.freeze({ enable: unavailable, disable: unavailable }),
    mcp: Object.freeze({ add: unavailable, update: unavailable, remove: unavailable }),
    api: Object.freeze({ import: unavailable, update: unavailable, remove: unavailable }),
    get: unavailable, list: unavailable, cancel: unavailable,
  });
}
