import type {
  ContributionOrigin,
  JsonObject,
  ResourceRecord,
} from "../contracts/types.js";
import type { UploadFileReceipt } from "../transfer/io.js";

export type TransferStatus =
  | "preparing"
  | "pending"
  | "transferring"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "interrupted";
export type TransferTerminalStatus =
  "succeeded" | "failed" | "cancelled" | "expired";
export interface TransferOwner {
  /** Verified Core caller binding; never taken from an SDK argument. */
  readonly callerKey: string;
  readonly owner: Pick<ContributionOrigin, "type" | "owner" | "namespace">;
}
export interface TransferTarget {
  readonly path?: string;
  readonly resourceUri?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly expectedSize?: number;
  readonly expectedSha256?: string;
}
export interface TransferStop {
  readonly kind: "cancel" | "expired" | "timeout" | "permission" | "failure";
  readonly code: string;
}
export interface TransferOrigin {
  readonly contextId: string;
  readonly projectId: string | null;
}
export interface TransferMetadata {
  readonly target: TransferTarget;
  /** Captured from the actual creator run; null means an older record is unknown. */
  readonly origin?: TransferOrigin | null;
  /** Fixed accepted payload budget; null means an older record is unknown. */
  readonly maxBytes?: number | null;
  /** Actual first claim time, never reconstructed from a deadline. */
  readonly startedAt?: number | null;
  readonly fileCommitted?: boolean;
  readonly file?: UploadFileReceipt;
  readonly cleanupConfirmed?: boolean;
  readonly stop?: TransferStop;
  readonly error?: JsonObject;
  readonly outcome?: TransferTerminalStatus;
}
export interface TransferRecord {
  readonly transferId: string;
  readonly resourceId: string;
  readonly callerKey: string;
  readonly originRunId: string | null;
  readonly direction: "upload" | "download";
  readonly status: TransferStatus;
  readonly revision: number;
  readonly metadata: TransferMetadata;
  readonly bytesTransferred: number;
  readonly resultRef: string | null;
  readonly claimDeadlineAt: number | null;
  readonly transferDeadlineAt: number | null;
  readonly createdAt: number;
  readonly endedAt: number | null;
}
export interface TransferFilter {
  readonly direction?: TransferRecord["direction"];
  readonly status?: TransferStatus;
  readonly runId?: string;
}
export interface TransferScan {
  readonly items: readonly {
    readonly record: TransferRecord;
    readonly cursor: string;
  }[];
  readonly more: boolean;
}
export interface PublishedTransfer {
  readonly transfer: TransferRecord;
  readonly resource: ResourceRecord;
}
export interface TransferFinish {
  readonly revision: number;
  readonly status: TransferTerminalStatus;
  readonly cleanupConfirmed: boolean;
  readonly fileCommitted?: boolean;
  readonly file?: UploadFileReceipt;
  readonly resultRef?: string;
  readonly error?: JsonObject;
}
export interface TransferProgress {
  readonly revision: number;
  readonly bytesTransferred: number;
  readonly fileCommitted?: boolean;
  readonly file?: UploadFileReceipt;
  readonly resultRef?: string;
}
