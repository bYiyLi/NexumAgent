import { AgentError } from "../contracts/errors.js";
import type { JsonObject } from "../contracts/types.js";
import type { ArtifactRecord } from "../results/artifacts.js";
import type { TransferStatus } from "../storage/transfers.js";
import type { UploadFileReceipt } from "../transfer/io.js";
import type { TransferOffer } from "../transfer/offers.js";

export interface UploadOptions {
  readonly path: string;
  readonly expectedSize?: number;
  readonly expectedSha256?: string;
  readonly mimeType?: string;
}
export type DownloadOptions = (
  | { readonly path: string; readonly uri?: never }
  | { readonly uri: string; readonly path?: never }
) & {
  readonly name?: string;
  readonly mimeType?: string;
};
export type TransferResource = Pick<
  ArtifactRecord,
  "uri" | "name" | "mimeType" | "size"
>;
/** A retained point-in-time view. No request URL or live controller is included. */
export interface TransferSnapshot {
  readonly transferId: string;
  readonly direction: "upload" | "download";
  readonly status: TransferStatus;
  readonly runId: string | null;
  readonly contextId: string | null;
  readonly projectId: string | null;
  readonly path?: string;
  readonly resource?: TransferResource;
  readonly progress: {
    readonly bytesTransferred: number;
    readonly totalBytes: number | null;
  };
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly startedAt: string | null;
  readonly deadlineAt: string | null;
  readonly finishedAt: string | null;
  readonly file?: UploadFileReceipt;
  readonly error: JsonObject | null;
}
export type UploadOffer = TransferSnapshot &
  TransferOffer & {
    readonly direction: "upload";
    readonly status: "pending";
    readonly path: string;
    readonly expiresAt: string;
    readonly maxBytes: number;
  };
export type DownloadOffer = TransferSnapshot &
  TransferOffer & {
    readonly direction: "download";
    readonly status: "pending";
    readonly resource: TransferResource;
    readonly expiresAt: string;
  };
export interface TransferListOptions {
  readonly direction?: "upload" | "download";
  readonly status?: TransferStatus;
  readonly runId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface TransferService {
  createUpload(options: UploadOptions): Promise<UploadOffer>;
  createDownload(options: DownloadOptions): Promise<DownloadOffer>;
  get(
    transferId: string,
    options?: { readonly waitMs?: number },
  ): Promise<TransferSnapshot>;
  list(options?: TransferListOptions): Promise<{
    readonly transfers: readonly TransferSnapshot[];
    readonly nextCursor: string | null;
  }>;
  cancel(transferId: string): Promise<{
    readonly accepted: boolean;
    readonly transfer: TransferSnapshot;
  }>;
}

/** The same fail-closed service is available to built-in and external factories. */
export function unavailableTransfer(
  assertCurrent: () => void,
): TransferService {
  const unavailable = (): never => {
    assertCurrent();
    throw new AgentError(
      "transfer_unavailable",
      "The Agent transfer service is not configured.",
    );
  };
  return Object.freeze({
    createUpload: unavailable,
    createDownload: unavailable,
    get: unavailable,
    list: unavailable,
    cancel: unavailable,
  });
}
