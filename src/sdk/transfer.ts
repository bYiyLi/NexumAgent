import type { TransferService, UploadOptions, DownloadOptions } from "../extensions/transfer.js";

export interface TransferSDK extends Omit<TransferService, "createUpload" | "createDownload"> {
  createUpload(options: UploadOptions | string): ReturnType<TransferService["createUpload"]>;
  createDownload(options: DownloadOptions | string): ReturnType<TransferService["createDownload"]>;
}
