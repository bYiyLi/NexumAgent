export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ContributionOrigin extends JsonObject {
  type: "local" | "platform" | "extension";
  owner: string;
  namespace: string | null;
  version: string | null;
  revision: string;
}

export const runStatuses = [
  "accepted",
  "preparing_inputs",
  "running",
  "waiting_input",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type RunStatus = (typeof runStatuses)[number];
export const terminalStatuses: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type SourceKind = "inline" | "script" | "replay";
export type AdmissionClass = "ordinary" | "control";
export const DEFAULT_CONTROL_CAPACITY = 2;
export type Profile = "development" | "production";

export interface Binding {
  readonly agentId: string;
  readonly profile: Profile;
  readonly cloudEnvironment: string;
}

export interface WorkRecord {
  readonly contextId: string;
  readonly callerKey: string;
  readonly projectId: string | null;
  readonly bootId: string;
  readonly revision: number;
  readonly status: "open" | "closed" | "expired";
  readonly pwd: string;
  readonly snapshotRef: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly expiresAt: number;
  readonly closedAt: number | null;
}

export interface RunRecord {
  readonly runId: string;
  readonly callerKey: string;
  readonly contextId: string;
  readonly projectId: string | null;
  readonly bootId: string;
  readonly status: RunStatus;
  readonly revision: number;
  readonly sourceKind: SourceKind;
  readonly admissionClass: AdmissionClass;
  readonly scriptName: string | null;
  readonly source: JsonObject;
  readonly codeRef: string | null;
  readonly inputRef: string | null;
  readonly resultRef: string | null;
  readonly logsRef: string | null;
  readonly error: JsonObject | null;
  readonly stop: JsonObject | null;
  readonly cleanup: JsonObject;
  readonly acceptedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly deadlineAt: number;
  readonly updatedAt: number;
}

export interface WaitRecord {
  readonly waitId: string;
  readonly runId: string;
  readonly status: "waiting" | "consumed" | "expired" | "cancelled";
  readonly deliveryState: "none" | "preparing" | "failed" | "consumed";
  readonly revision: number;
  readonly request: JsonObject;
  readonly inputDigest: string | null;
  readonly inputRef: string | null;
  readonly receipt: JsonObject | null;
  readonly error: JsonObject | null;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly consumedAt: number | null;
}

export interface ResourceRecord {
  readonly resourceId: string;
  readonly originRunId: string | null;
  readonly ownerRunId: string | null;
  readonly callerKey: string;
  readonly bootId: string;
  readonly kind: string;
  readonly lifetime: "run" | "instance" | "background";
  readonly source: JsonObject;
  readonly status: string;
  readonly revision: number;
  readonly diagnostic: JsonObject;
  readonly createdAt: number;
  readonly handedOffAt: number | null;
  readonly closedAt: number | null;
}

export interface OperationRecord {
  readonly operationId: string;
  readonly originRunId: string | null;
  readonly callerKey: string;
  readonly bootId: string;
  readonly namespace: string;
  readonly method: string;
  readonly source: JsonObject;
  readonly maintenanceRequestId: string | null;
  readonly approvedRevision: string | null;
  readonly status: string;
  readonly revision: number;
  readonly detailRef: string | null;
  readonly error: JsonObject | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly endedAt: number | null;
}

export interface HistoryFilter {
  readonly status?: RunStatus;
  readonly scriptName?: string;
  readonly sourceKind?: SourceKind;
  readonly projectId?: string;
  readonly contextId?: string;
  readonly from?: number;
  readonly to?: number;
}
