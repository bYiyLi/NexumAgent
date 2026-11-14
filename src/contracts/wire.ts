import type {
  Caller,
  McpCaller,
  OwnerSessionCaller,
  HostFeatures,
} from "./caller.js";
export { MAX_HOST_FEATURE_BYTES_V2 } from "./caller.js";
import type {
  ContributionOrigin,
  JsonObject,
  JsonValue,
  Profile,
  RunStatus,
} from "./types.js";

export const WIRE_VERSION_V2 = "2";
export const MAX_CONTROL_BYTES_V2 = 1024 * 1024;
export const MAX_JSON_BODY_BYTES_V2 = 64 * 1024 * 1024;
export const MAX_RESOURCES_READ_BODY_BYTES_V2 = 128 * 1024 * 1024;
export const MAX_HOST_BODY_BYTES_V2 = 128 * 1024 * 1024;
export const MAX_STATE_VALUE_BYTES_V2 = 64 * 1024;
export const MAX_STATE_RECEIPT_BYTES_V2 = MAX_STATE_VALUE_BYTES_V2 + 1024;
export const POLICY_LEASE_MS_V2 = 30_000;
export const wireOperationsV2 = [
  "agent.project.resolve",
  "agent.project.inspect",
  "agent.open",
  "agent.close",
  "agent.run.start",
  "agent.run.get",
  "agent.run.inspect",
  "agent.run.input",
  "agent.run.cancel",
  "agent.run.list",
  "agent.tasks.create",
  "agent.tasks.get",
  "agent.tasks.update",
  "agent.tasks.cancel",
  "agent.resources.list",
  "agent.resources.read",
  "agent.context.read",
  "transfer.prepare",
  "transfer.revoke",
  "agent.transfer.reserveClaim",
  "agent.transfer.commitClaim",
  "agent.transfer.releaseReservation",
  "authorization.refresh",
  "state.user.get",
  "state.user.set",
  "state.user.delete",
  "host.request",
  "attachment.open",
  "stream.prepare",
  "stream.revoke",
  "maintenance.request.create",
  "maintenance.request.get",
  "maintenance.request.list",
  "maintenance.request.cancel",
  "maintenance.request.decision",
  "maintenance.request.beginExecution",
  "agent.maintenance.draft.read",
  "agent.maintenance.draft.prepare",
  "agent.maintenance.draft.verify",
  "agent.maintenance.draft.notify",
  "agent.maintenance.oauth.start",
  "agent.maintenance.oauth.complete",
  "agent.maintenance.execute",
  "agent.maintenance.get",
  "agent.maintenance.cancel",
] as const;
export type WireOperationV2 = (typeof wireOperationsV2)[number];
export interface WireHostCapabilitiesV2 {
  sampling: boolean;
  elicitation: boolean;
  roots: boolean;
}
export type WireHostFeaturesV2 = HostFeatures;
export type WireCallerV2 = Caller &
  (
    | OwnerSessionCaller
    | (McpCaller & {
        readonly grantId: string;
        /** Cloud-minted opaque association with the original actual MCP Host request/session. */
        readonly hostRef?: string;
        readonly hostCapabilities?: WireHostCapabilitiesV2;
        readonly hostFeatures?: WireHostFeaturesV2;
      })
  );
export interface WireConnectionV2 {
  readonly agentId: string;
  readonly profile: Profile;
  readonly bootId: string;
  readonly cloudEnvironment: string;
  readonly connectionId: string;
}
export type WireBudgetNameV2 =
  | "controlBytes"
  | "textBytes"
  | "imageBytes"
  | "audioBytes"
  | "inlineBytes"
  | "responseBytes"
  | "fileBytes"
  | "attachmentBytes"
  | "attachmentCount"
  | "resourcePageLimit";
export type WireBudgetsV2 = Partial<Record<WireBudgetNameV2, number>>;
export interface WireVisibilityV2 {
  readonly disabledItems: readonly {
    kind: "instruction" | "skill";
    key: string;
  }[];
}
export interface WireAuthorizationV2 {
  readonly agentId: string;
  readonly projectId?: string;
  readonly projectRoot?: string;
  readonly projectName?: string;
  readonly projectDescription?: string;
  readonly projectContextVisibility?: WireVisibilityV2;
  readonly allowedRoots: readonly string[];
  readonly budgets: WireBudgetsV2;
  /** Current Cloud policy revision and a short lease; neither comes from model input. */
  readonly revision: string;
  readonly expiresAt: string;
}
export interface WireInvocationContextV2 {
  readonly caller: WireCallerV2;
  readonly authorization: WireAuthorizationV2;
  readonly connection: WireConnectionV2;
}
export interface WireErrorV2 {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonObject;
}
export interface WireSubmissionV2 {
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface WireProjectResolveInputV2 {
  readonly path: string;
}
export interface WireProjectResolveOutputV2 {
  readonly root: string;
  readonly name: string;
}
export interface WireOpenInputV2 {
  readonly agentId: string;
  readonly projectId?: string;
  readonly path?: string;
  readonly contextId?: string;
}
/** Nested public materials retain their existing discovered/published schemas. */
export interface WireOpenOutputV2 {
  readonly contextId: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly pwd: string;
  readonly agent: JsonObject;
  readonly project: JsonObject | null;
  readonly warnings: readonly JsonObject[];
}
export interface WireCloseInputV2 {
  readonly contextId: string;
}
export interface WireCloseOutputV2 {
  readonly contextId: string;
  readonly projectId: string | null;
  readonly agentConfirmed: true;
  readonly affectedContextIds: readonly string[];
  readonly closedAt: string;
}
/** Stable normalized identity; temporary Host URLs/file IDs never cross this wire. */
export type WireAttachmentV2 =
  | { readonly transferId: string }
  | { readonly uri: string }
  | { readonly sourceId: string };
export interface WireRunStartInputV2 {
  readonly contextId: string;
  readonly script?: string;
  readonly scriptName?: string;
  readonly replayRunId?: string;
  readonly input?: JsonValue;
  readonly attachments?: readonly WireAttachmentV2[];
  readonly requestId?: string;
  readonly submission?: WireSubmissionV2;
  readonly pwd?: string;
  readonly waitMs?: number;
  readonly timeoutMs?: number;
}
export interface WireRunGetInputV2 {
  readonly agentId: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly waitMs?: number;
}
export interface WireRunInputInputV2 {
  readonly agentId: string;
  readonly runId: string;
  readonly waitId: string;
  readonly input: JsonValue;
  readonly attachments?: readonly WireAttachmentV2[];
  readonly waitMs?: number;
}
export interface WireRunCancelInputV2 {
  readonly agentId: string;
  readonly runId: string;
}
export interface WireRunListInputV2 {
  readonly agentId: string;
  readonly status?: RunStatus;
  readonly scriptName?: string;
  readonly source?: "inline" | "named" | "history";
  readonly projectId?: string;
  readonly contextId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface WireRunV2 {
  readonly runId: string;
  readonly contextId: string;
  readonly projectId: string | null;
  readonly revision: number;
  readonly status: RunStatus;
  readonly scriptName: string | null;
  readonly source: "inline" | "named" | "history";
  readonly origin: ContributionOrigin | null;
  readonly replayOfRunId: string | null;
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly deadlineAt: string;
  readonly updatedAt: string;
  readonly error: WireErrorV2 | null;
  readonly stop: JsonObject | null;
  readonly cleanup: JsonObject;
  readonly availability: {
    readonly code: boolean;
    readonly input: boolean;
    readonly result: boolean;
    readonly logs: boolean;
  };
  readonly scriptDesc?: string | null;
  readonly descriptionTruncated?: true;
}
export interface WireWaitV2 {
  readonly waitId: string;
  readonly revision: number;
  readonly status: "waiting" | "consumed" | "expired" | "cancelled";
  readonly deliveryState: "none" | "preparing" | "failed" | "consumed";
  readonly request: JsonObject;
  readonly createdAt: string;
  readonly deadlineAt: string;
  readonly consumedAt: string | null;
  readonly error: WireErrorV2 | null;
}
export interface WireArtifactV2 {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly expiresAt: string;
}
export interface WireIconV2 {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly theme?: "light" | "dark";
}
export type WireAnnotationsV2 = JsonObject & {
  readonly audience?: ("user" | "assistant")[];
  readonly priority?: number;
  readonly lastModified?: string;
};
export interface WireResourceEntryV2 {
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly description?: string;
  readonly size?: number;
  readonly title?: string;
  readonly icons?: readonly WireIconV2[];
  readonly annotations?: WireAnnotationsV2;
}
interface WireContentMetaV2 {
  readonly annotations?: WireAnnotationsV2;
  readonly description?: string;
}
export type WireContentV2 =
  | (WireContentMetaV2 & { readonly type: "text"; readonly text: string })
  | (WireContentMetaV2 & {
      readonly type: "image" | "audio";
      readonly resource: WireArtifactV2;
      readonly mimeType: string;
    })
  | (WireContentMetaV2 & {
      readonly type: "resource_link";
      readonly title?: string;
      readonly size?: number;
      readonly icons?: readonly WireIconV2[];
      readonly uri: string;
      readonly name: string;
      readonly mimeType?: string;
    })
  | (WireContentMetaV2 & {
      readonly type: "resource";
      readonly resource: WireArtifactV2;
      readonly uri: string;
      readonly encoding: "text" | "blob";
    });
/** Safe result description only. No image data, audio data, resource blob, or live request URL. */
export interface WireResultV2 {
  readonly content: readonly WireContentV2[];
  readonly data?: JsonValue;
  readonly isError?: boolean;
  readonly conversions?: readonly JsonObject[];
  readonly delivery?: {
    readonly complete: false;
    readonly reason: "context_budget";
    readonly dataResource?: WireArtifactV2;
    readonly textResource?: WireArtifactV2;
  };
  readonly resultType?: "complete";
  readonly mcpResults?: readonly JsonObject[];
  readonly protocolMeta?:
    { readonly value: JsonObject } | { readonly stream: WireFixedStreamRefV2 };
}
export interface WireResultBodyV2 {
  readonly body: WireFixedStreamRefV2;
  readonly protocolMeta?: WireResultV2["protocolMeta"];
}
/** A fully normalized model descriptor moved onto its independent fixed JSON channel. */
export type WireResultDescriptorBodyV2 = Omit<WireResultV2, "protocolMeta">;
export interface WireTransferRequestV2 {
  readonly method: "GET" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}
export type WireTransferDeliveryV2 =
  | {
      readonly transferId: string;
      readonly available: true;
      readonly request: WireTransferRequestV2;
    }
  | {
      readonly transferId: string;
      readonly available: false;
      readonly reason: string;
    };
export interface WireRunViewV2 {
  readonly run: WireRunV2;
  readonly wait: WireWaitV2 | null;
  readonly result: WireResultV2 | WireResultBodyV2 | null;
  readonly observedAt: string;
  readonly operations: {
    readonly items: readonly JsonObject[];
    readonly complete: boolean;
  };
  readonly resources: {
    readonly items: readonly JsonObject[];
    readonly complete: boolean;
  };
  readonly unavailable?: WireErrorV2;
  readonly code?: {
    readonly text: string;
    readonly complete: boolean;
    readonly nextCursor: string | null;
  };
  readonly input?: JsonValue;
  readonly logs?: {
    readonly text: string;
    readonly complete: boolean;
    readonly nextCursor: string | null;
  };
  /** Transient delivery is separate from the durable normalized result/history. */
  readonly transient?: {
    readonly transfers: readonly WireTransferDeliveryV2[];
  };
}
export interface WireRunCancelOutputV2 {
  readonly accepted: boolean;
  readonly view: WireRunViewV2;
}
export interface WireTaskErrorV2 {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}
export type WireTaskBindingV2 = {
  readonly taskId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
} & (
  | { readonly status: "failed"; readonly error: WireTaskErrorV2 }
  | {
      readonly status: "working" | "input_required" | "completed" | "cancelled";
      readonly error?: never;
    }
);
export interface WireTaskCreateInputV2 {
  readonly runId: string;
  readonly ttlMs?: number;
}
export interface WireTaskGetInputV2 {
  readonly taskId: string;
}
export interface WireTaskUpdateInputV2 {
  readonly taskId: string;
  readonly waitId: string;
  readonly input: JsonValue;
  readonly attachments?: readonly WireAttachmentV2[];
}
export interface WireTaskCancelInputV2 {
  readonly taskId: string;
}
export type WireTaskCreateOutputV2 = WireTaskBindingV2;
export interface WireTaskViewV2 {
  readonly task: WireTaskBindingV2;
  readonly view: WireRunViewV2;
}
export interface WireTaskCancelOutputV2 extends WireTaskViewV2 {
  readonly accepted: boolean;
}
export interface WireRunListOutputV2 {
  readonly runs: readonly WireRunV2[];
  readonly nextCursor: string | null;
  readonly observedAt: string;
}
export interface WireResourcesListInputV2 {
  readonly cursor?: string;
  readonly limit?: number;
}
export interface WireResourcesListPageV2 {
  readonly resources: readonly WireResourceEntryV2[];
  readonly nextCursor: string | null;
}
export type WireResourcesListOutputV2 =
  WireResourcesListPageV2 | { readonly body: WireFixedStreamRefV2 };
export interface WireResourcesReadInputV2 {
  readonly uri: string;
  readonly maxBytes: number;
}
export type WireResourceBodyV2 = {
  readonly uri: string;
  readonly mimeType: string;
} & ({ readonly text: string } | { readonly stream: WireFixedStreamRefV2 });
export type WireResourcesReadOutputV2 =
  | { readonly contents: readonly WireResourceBodyV2[]; readonly body?: never }
  | { readonly body: WireFixedStreamRefV2; readonly contents?: never };
/** Complete standard MCP result; bytes and protocol metadata never enter WSS JSON. */
export type WireMCPResourceContentsV2 = {
  readonly uri: string;
  readonly mimeType?: string;
  readonly _meta?: JsonObject;
  readonly icons?: readonly WireIconV2[];
  readonly metadata?: JsonValue;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly size?: number;
  readonly annotations?: WireAnnotationsV2;
} & (
  | { readonly text: string; readonly blob?: never }
  | { readonly blob: string; readonly text?: never }
);
export interface WireResourcesReadBodyV2 {
  readonly contents: readonly WireMCPResourceContentsV2[];
  readonly _meta?: JsonObject;
  readonly icons?: readonly WireIconV2[];
  readonly metadata?: JsonValue;
  readonly resultType?: "complete";
  readonly ttlMs?: number;
  readonly cacheScope?: "public" | "private";
}
export interface WireContextReadInputV2 {
  readonly contextId: string;
  readonly revision: number;
  readonly itemId: string;
  readonly cursor?: string;
  readonly maxBytes: number;
  readonly relativePath?: string;
  readonly includeEntries?: boolean;
  readonly startLine?: number;
  readonly maxLines?: number;
}
export interface WireContextReadOutputV2 {
  readonly contextId: string;
  readonly revision: number;
  readonly itemId: string;
  readonly contentRevision: string;
  readonly text: string;
  readonly complete: boolean;
  readonly nextCursor: string | null;
  readonly entries?: readonly {
    readonly displayPath: string;
    readonly kind: "file" | "directory";
  }[];
  readonly startLine?: number;
  readonly endLine?: number;
  readonly startsMidLine?: boolean;
  readonly endsMidLine?: boolean;
  readonly treeTruncated?: boolean;
}
export type WireStreamPurposeV2 =
  | "resource"
  | "attachment"
  | "transfer"
  | "host-request"
  | "host-response"
  | "result-meta"
  | "maintenance";
export type WireStreamDirectionV2 = "agent-to-cloud" | "cloud-to-agent";
export interface WireStreamRefV2 {
  readonly streamId: string;
  readonly purpose: WireStreamPurposeV2;
  readonly direction: WireStreamDirectionV2;
  readonly expiresAt: string;
  readonly maxBytes: number;
  readonly mimeType?: string;
  readonly size?: number;
  readonly sha256?: string;
}
export interface WireFixedStreamRefV2 extends WireStreamRefV2 {
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
}
/** Independent HTTP stream handshake. Agent credential stays in Authorization, never JSON. */
export interface WireStreamHandshakeV2 extends WireConnectionV2 {
  readonly streamId: string;
  readonly purpose: WireStreamPurposeV2;
  readonly direction: WireStreamDirectionV2;
  readonly transferId?: string;
  readonly reservationId?: string;
}
export interface WireAttachmentOpenInputV2 {
  readonly sourceId: string;
  readonly originInvocationId: string;
  readonly runId?: string;
}
export interface WireAttachmentOpenOutputV2 {
  readonly stream: WireStreamRefV2;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly sha256?: string;
}
export interface WireStreamPrepareInputV2 {
  readonly originInvocationId: string;
  readonly runId?: string;
  readonly resourceUri?: string;
  readonly purpose: WireStreamPurposeV2;
  readonly direction: "agent-to-cloud";
  readonly expiresAt: string;
  readonly maxBytes: number;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
}
export interface WireStreamPrepareOutputV2 {
  readonly stream: WireFixedStreamRefV2;
}
export interface WireStreamRevokeInputV2 {
  readonly streamId: string;
  readonly reason: WireErrorV2;
}
export interface WireStreamRevokeOutputV2 {
  readonly streamId: string;
  readonly closed: true;
}
export interface WireTransferTargetV2 {
  readonly path?: string;
  readonly resourceUri?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly expectedSize?: number;
  readonly expectedSha256?: string;
}
export interface WireTransferPrepareInputV2 {
  readonly transferId: string;
  readonly resourceId: string;
  readonly runId: string;
  readonly contextId: string;
  readonly projectId: string | null;
  readonly direction: "upload" | "download";
  readonly claimDeadlineAt: string;
  readonly maxBytes: number;
  readonly target: WireTransferTargetV2;
}
export interface WireTransferPrepareOutputV2 {
  readonly transferId: string;
  readonly request: WireTransferRequestV2;
}
export interface WireTransferStopV2 {
  readonly kind: "cancel" | "expired" | "timeout" | "permission" | "failure";
  readonly code: string;
}
export interface WireTransferRevokeInputV2 {
  readonly transferId: string;
  readonly reason: WireTransferStopV2;
}
export interface WireTransferRevokeOutputV2 {
  readonly transferId: string;
  readonly closed: true;
}
export interface WireTransferReserveInputV2 {
  readonly transferId: string;
}
export interface WireTransferReserveOutputV2 {
  readonly transferId: string;
  readonly reservationId: string;
  readonly expiresAt: string;
  readonly direction: "upload" | "download";
  readonly maxBytes: number;
}
export interface WireTransferCommitInputV2 {
  readonly transferId: string;
  readonly reservationId: string;
  readonly stream: WireStreamRefV2;
  readonly contentLength?: number;
}
export interface WireTransferReleaseInputV2 {
  readonly transferId: string;
  readonly reservationId: string;
}
export interface WireTransferReleaseOutputV2 {
  readonly transferId: string;
  readonly released: true;
}
export interface WireTransferFileV2 {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly revision: string;
}
export interface WireTransferSnapshotV2 {
  readonly transferId: string;
  readonly direction: "upload" | "download";
  readonly status:
    | "preparing"
    | "pending"
    | "transferring"
    | "cancelling"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired"
    | "interrupted";
  readonly runId: string | null;
  readonly contextId: string | null;
  readonly projectId: string | null;
  readonly path?: string;
  readonly resource?: WireResourceEntryV2;
  readonly maxBytes?: number | null;
  readonly progress: {
    readonly bytesTransferred: number;
    readonly totalBytes: number | null;
  };
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly startedAt: string | null;
  readonly deadlineAt: string | null;
  readonly finishedAt: string | null;
  readonly file?: WireTransferFileV2;
  readonly error: WireErrorV2 | null;
}
export type WireAuthorizationRefreshInputV2 = {
  readonly originInvocationId: string;
} & (
  | {
      readonly runId: string;
      readonly maintenanceRequestId?: never;
      readonly transferId?: never;
      readonly streamId?: never;
    }
  | {
      readonly maintenanceRequestId: string;
      readonly runId?: never;
      readonly transferId?: never;
      readonly streamId?: never;
    }
  | {
      readonly transferId: string;
      readonly runId?: never;
      readonly maintenanceRequestId?: never;
      readonly streamId?: never;
    }
  | {
      readonly streamId: string;
      readonly runId?: never;
      readonly maintenanceRequestId?: never;
      readonly transferId?: never;
    }
);
export interface WireAuthorizationRefreshOutputV2 {
  readonly authorization: WireAuthorizationV2;
}
export interface WireUserStateGetInputV2 {
  readonly namespace: "default";
  readonly key: string;
}
export interface WireUserStateSetInputV2 extends WireUserStateGetInputV2 {
  readonly value: JsonValue;
  readonly expectedVersion: number | null;
}
export interface WireUserStateDeleteInputV2 extends WireUserStateGetInputV2 {
  readonly expectedVersion: number;
}
export interface WireStateValueV2 {
  readonly value: JsonValue;
  readonly version: number;
  readonly updatedAt: number;
}
export interface WireUserStateGetOutputV2 {
  readonly state: WireStateValueV2 | null;
}
export type WireUserStateSetOutputV2 = WireStateValueV2;
export interface WireUserStateDeleteOutputV2 {
  readonly deleted: true;
  readonly version: number;
  readonly updatedAt: number;
}
export interface WireHostRequestInputV2 {
  readonly runId: string;
  readonly originInvocationId: string;
  readonly hostRef: string;
  readonly action: "sampling" | "elicitation" | "roots";
  readonly body: WireFixedStreamRefV2;
}
export interface WireHostRequestOutputV2 {
  readonly action: "sampling" | "elicitation" | "roots";
  readonly body: WireFixedStreamRefV2;
}
export type WireMaintenanceTargetV2 = "package" | "extension" | "mcp" | "api";
export interface WireMaintenanceSummaryV2 {
  readonly title: string;
  readonly changeKinds: readonly string[];
  readonly permissions: readonly string[];
  readonly version: string | null;
  readonly namespace: string | null;
  readonly restartMayBeRequired: boolean;
}
export interface WireMaintenanceCandidateV2 {
  readonly target: WireMaintenanceTargetV2;
  readonly action: string;
  readonly name: string;
  readonly objectId: string | null;
  readonly baseRevision: string | null;
  readonly candidateRevision: string;
  readonly summary: WireMaintenanceSummaryV2;
  readonly authStatus: "not_required" | "required" | "ready" | "failed";
}
export interface WireMaintenanceCreateV2 extends WireMaintenanceCandidateV2 {
  readonly requestKey: string;
  readonly originRunId: string;
}
export interface WireMaintenanceDecisionV2 {
  readonly status: "approved" | "denied";
  readonly revision: number;
  readonly candidateRevision: string;
  readonly decidedAt: string;
  readonly decisionId: string;
}
export interface WireMaintenanceResultV2 {
  readonly changed: boolean;
  readonly restartRequired: boolean;
  readonly package?: {
    readonly name: string;
    readonly declared: boolean;
    readonly installedVersion: string | null;
  };
  readonly extension?: {
    readonly namespace: string;
    readonly desiredEnabled: boolean;
    readonly state: string;
    readonly activeVersion: string | null;
  } | null;
  readonly connection?: {
    readonly name: string;
    readonly state: string;
    readonly revision: string | null;
  } | null;
  readonly api?: {
    readonly name: string;
    readonly state: string;
    readonly revision: string | null;
  } | null;
}
export interface WireMaintenanceExecutionV2 {
  readonly operationId: string;
  readonly startedAt: string;
  readonly status?: string;
  readonly result?: WireMaintenanceResultV2;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface WireMaintenanceViewV2 extends WireMaintenanceCandidateV2 {
  readonly agentName?: string;
  readonly source?: { readonly name?: string };
  readonly requestId: string;
  readonly agentId: string;
  readonly profile: Profile;
  readonly status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  readonly revision: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvalUrl?: string;
  readonly decidedAt?: string;
  readonly decision?: WireMaintenanceDecisionV2;
  readonly execution?: WireMaintenanceExecutionV2;
}
export interface WireMaintenanceListOptionsV2 {
  readonly target?: WireMaintenanceTargetV2;
  readonly name?: string;
  readonly status?: WireMaintenanceViewV2["status"];
  readonly limit?: number;
  readonly cursor?: string;
}
export interface WireMaintenancePageV2 {
  readonly requests: readonly WireMaintenanceViewV2[];
  readonly nextCursor?: string | null;
}
export interface WireMaintenanceBeginExecutionV2 {
  readonly requestId: string;
  readonly approvedRevision: string;
  readonly decisionRevision: number;
  readonly operationId: string;
}
export interface WireMaintenanceLookupV2 {
  readonly requestId: string;
  readonly revision?: number;
}
export interface WireMaintenanceBodyInputV2 {
  readonly requestId: string;
  readonly revision: number;
  readonly body: WireFixedStreamRefV2;
}
export interface WireMaintenanceBodyOutputV2 {
  readonly body: WireFixedStreamRefV2;
}
/** Payload DTOs below are serialized only onto independent authenticated streams. */
export interface WireMaintenanceDraftV2 {
  readonly currentConfig?: JsonObject;
  readonly config: JsonObject;
  readonly authentication: readonly {
    readonly id: string;
    readonly type: string;
    readonly location?: string;
    readonly name?: string;
    readonly flow?: string;
    readonly oauth: boolean;
    readonly fields: readonly {
      readonly key: string;
      readonly label: string;
      readonly configured: boolean;
      readonly required: boolean;
    }[];
  }[];
  readonly security: readonly (readonly string[])[];
  readonly diagnostics: readonly string[];
}
export interface WireMaintenanceDraftInputV2 {
  readonly revision: number;
  readonly config?: JsonObject;
  readonly version?: string;
  readonly credentials?: readonly {
    readonly key: string;
    readonly operation: "keep" | "replace" | "clear";
    readonly value?: string;
  }[];
}
export interface WireMaintenanceDraftReadV2 {
  readonly draft: WireMaintenanceDraftV2;
  readonly execution?: WireMaintenanceExecutionV2;
}
export interface WireMaintenancePreparedV2 {
  readonly candidate: WireMaintenanceCandidateV2;
  readonly draft: WireMaintenanceDraftV2;
}
export interface WireMaintenanceOAuthBindingV2 {
  readonly state: string;
  readonly callbackUrl: string;
  readonly schemeId: string;
  readonly candidateRevision: string;
}
export interface WireMaintenanceOAuthLaunchV2 {
  readonly authorizationUrl?: string;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly issuer: string;
  readonly requireIssuer: boolean;
}
export interface WireMaintenanceOAuthCompleteV2 {
  readonly schemeId: string;
  readonly candidateRevision: string;
  readonly callback: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly issuer?: string;
  };
}
export interface WireInputsV2 {
  "agent.project.resolve": WireProjectResolveInputV2;
  "agent.project.inspect": {
    readonly projectId: string;
    readonly contextId?: string;
  };
  "agent.open": WireOpenInputV2;
  "agent.close": WireCloseInputV2;
  "agent.run.start": WireRunStartInputV2;
  "agent.run.get": WireRunGetInputV2;
  "agent.run.inspect": { readonly runId: string };
  "agent.run.input": WireRunInputInputV2;
  "agent.run.cancel": WireRunCancelInputV2;
  "agent.run.list": WireRunListInputV2;
  "agent.tasks.create": WireTaskCreateInputV2;
  "agent.tasks.get": WireTaskGetInputV2;
  "agent.tasks.update": WireTaskUpdateInputV2;
  "agent.tasks.cancel": WireTaskCancelInputV2;
  "agent.resources.list": WireResourcesListInputV2;
  "agent.resources.read": WireResourcesReadInputV2;
  "agent.context.read": WireContextReadInputV2;
  "transfer.prepare": WireTransferPrepareInputV2;
  "transfer.revoke": WireTransferRevokeInputV2;
  "agent.transfer.reserveClaim": WireTransferReserveInputV2;
  "agent.transfer.commitClaim": WireTransferCommitInputV2;
  "agent.transfer.releaseReservation": WireTransferReleaseInputV2;
  "authorization.refresh": WireAuthorizationRefreshInputV2;
  "state.user.get": WireUserStateGetInputV2;
  "state.user.set": WireUserStateSetInputV2;
  "state.user.delete": WireUserStateDeleteInputV2;
  "host.request": WireHostRequestInputV2;
  "attachment.open": WireAttachmentOpenInputV2;
  "stream.prepare": WireStreamPrepareInputV2;
  "stream.revoke": WireStreamRevokeInputV2;
  "maintenance.request.create": WireMaintenanceCreateV2;
  "maintenance.request.get": { readonly requestId: string };
  "maintenance.request.list": WireMaintenanceListOptionsV2;
  "maintenance.request.cancel": { readonly requestId: string };
  "maintenance.request.decision": { readonly requestId: string };
  "maintenance.request.beginExecution": WireMaintenanceBeginExecutionV2;
  "agent.maintenance.execute": { readonly requestId: string };
  "agent.maintenance.get": { readonly requestId: string };
  "agent.maintenance.cancel": { readonly requestId: string };
  "agent.maintenance.draft.read": WireMaintenanceLookupV2;
  "agent.maintenance.draft.prepare": WireMaintenanceBodyInputV2;
  "agent.maintenance.draft.verify": WireMaintenanceLookupV2;
  "agent.maintenance.draft.notify": WireMaintenanceLookupV2;
  "agent.maintenance.oauth.start": WireMaintenanceBodyInputV2;
  "agent.maintenance.oauth.complete": WireMaintenanceBodyInputV2;
}
export interface WireOutputsV2 {
  "agent.project.resolve": WireProjectResolveOutputV2;
  "agent.project.inspect": WireOpenOutputV2;
  "agent.open": WireOpenOutputV2;
  "agent.close": WireCloseOutputV2;
  "agent.run.start": WireRunViewV2;
  "agent.run.get": WireRunViewV2;
  "agent.run.inspect": WireRunViewV2;
  "agent.run.input": WireRunViewV2;
  "agent.run.cancel": WireRunCancelOutputV2;
  "agent.run.list": WireRunListOutputV2;
  "agent.tasks.create": WireTaskCreateOutputV2;
  "agent.tasks.get": WireTaskViewV2;
  "agent.tasks.update": WireTaskViewV2;
  "agent.tasks.cancel": WireTaskCancelOutputV2;
  "agent.resources.list": WireResourcesListOutputV2;
  "agent.resources.read": WireResourcesReadOutputV2;
  "agent.context.read": WireContextReadOutputV2;
  "transfer.prepare": WireTransferPrepareOutputV2;
  "transfer.revoke": WireTransferRevokeOutputV2;
  "agent.transfer.reserveClaim": WireTransferReserveOutputV2;
  "agent.transfer.commitClaim": WireTransferSnapshotV2;
  "agent.transfer.releaseReservation": WireTransferReleaseOutputV2;
  "authorization.refresh": WireAuthorizationRefreshOutputV2;
  "state.user.get": WireUserStateGetOutputV2;
  "state.user.set": WireUserStateSetOutputV2;
  "state.user.delete": WireUserStateDeleteOutputV2;
  "host.request": WireHostRequestOutputV2;
  "attachment.open": WireAttachmentOpenOutputV2;
  "stream.prepare": WireStreamPrepareOutputV2;
  "stream.revoke": WireStreamRevokeOutputV2;
  "maintenance.request.create": WireMaintenanceViewV2;
  "maintenance.request.get": WireMaintenanceViewV2;
  "maintenance.request.list": WireMaintenancePageV2;
  "maintenance.request.cancel": WireMaintenanceViewV2;
  "maintenance.request.decision": WireMaintenanceViewV2;
  "maintenance.request.beginExecution": WireMaintenanceViewV2;
  "agent.maintenance.execute": WireMaintenanceViewV2;
  "agent.maintenance.get": WireMaintenanceViewV2;
  "agent.maintenance.cancel": WireMaintenanceViewV2;
  "agent.maintenance.draft.read": WireMaintenanceBodyOutputV2;
  "agent.maintenance.draft.prepare": WireMaintenanceBodyOutputV2;
  "agent.maintenance.draft.verify": WireMaintenanceCandidateV2;
  "agent.maintenance.draft.notify": {
    readonly requestId: string;
    readonly notified: true;
  };
  "agent.maintenance.oauth.start": WireMaintenanceBodyOutputV2;
  "agent.maintenance.oauth.complete": WireMaintenanceBodyOutputV2;
}
export type WireInvokeV2<O extends WireOperationV2 = WireOperationV2> =
  O extends WireOperationV2
    ? {
        readonly type: "invoke";
        readonly id: string;
        readonly operation: O;
        readonly context: WireInvocationContextV2;
        readonly input: WireInputsV2[O];
      }
    : never;
export type WireReplyV2<O extends WireOperationV2 = WireOperationV2> =
  O extends WireOperationV2
    ? {
        readonly type: "result";
        readonly id: string;
        readonly operation: O;
        readonly output: WireOutputsV2[O];
      }
    : never;
export interface WireFailureV2 {
  readonly type: "error";
  readonly id: string;
  readonly error: WireErrorV2;
}
export interface WireCancelV2 {
  readonly type: "cancel";
  readonly id: string;
}
export interface WireCatalogProjectV2 {
  readonly projectId: string;
  readonly name: string;
  readonly root: string;
  readonly description?: string;
  readonly projectContextVisibility: WireVisibilityV2;
}
export type WireCatalogSummaryV2 = {
  readonly projectId: string;
  readonly root: string;
} & (
  | {
      readonly status: "ok";
      readonly description: string;
      readonly revision: string;
    }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly error: WireErrorV2 }
);
export interface WireEventDataV2 {
  "agent.run.changed": {
    readonly originInvocationId?: string;
    readonly runId: string;
    readonly revision: number;
    readonly status: RunStatus;
    readonly observedAt: string;
  };
  "agent.catalog.sync": {
    readonly generation: string;
    readonly page: number;
    readonly complete: boolean;
    readonly projects: readonly WireCatalogProjectV2[];
    readonly allowedRoots: readonly string[];
  };
  "agent.catalog.changed": {
    readonly sequence: number;
    readonly observedAt: string;
    readonly projects: readonly WireCatalogSummaryV2[];
  };
  /** null is authoritative revocation; it never commands a run transition. */
  "agent.authorization.changed": {
    readonly caller: WireCallerV2;
    readonly authorization: WireAuthorizationV2 | null;
  };
}
export type WireEventNameV2 = keyof WireEventDataV2;
export type WireEventV2<N extends WireEventNameV2 = WireEventNameV2> =
  N extends WireEventNameV2
    ? {
        readonly type: "event";
        readonly name: N;
        readonly connection: WireConnectionV2;
        readonly data: WireEventDataV2[N];
      }
    : never;
export type WireEnvelopeV2 =
  WireInvokeV2 | WireReplyV2 | WireFailureV2 | WireCancelV2 | WireEventV2;
