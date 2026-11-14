/** Public extension contracts only; importing this entry creates no Core services. */
export type {
  AccessTarget,
  ExtensionFactory,
  ExtensionHost,
  ExtensionInstance,
  Invocation,
  LogEntry,
  MethodDefinition,
  StorageReservation,
  StorageService,
} from "./extensions/api.js";
export type {
  ManagedResource,
  ResourceRef,
  ResourceService,
  ResourceSnapshot,
  ResourceQuery,
  ResourcePage,
} from "./extensions/resources.js";
export type {
  TransferService,
  TransferSnapshot,
  UploadOffer,
  DownloadOffer,
  UploadOptions,
  DownloadOptions,
  TransferListOptions,
} from "./extensions/transfer.js";
export type { StateService } from "./extensions/state.js";
export type {
  HostRequestServices,
  HostRequestOptions,
} from "./extensions/host-requests.js";
export type {
  MaintenanceService,
  MaintenanceCreated,
  MaintenanceRequestView,
  MaintenanceListOptions,
} from "./maintenance/requests.js";
export type {
  OutputAPI,
  OutputIntent,
  OutputOptions,
  OutputSource,
  OutputResult,
} from "./sdk/output.js";
export type {
  McpResultOptions,
  McpResourceReader,
  McpReadScope,
  McpAccess,
} from "./results/mcp.js";
export type { InputRequest } from "./runtime/engine.js";
export type { SchemaDialect } from "./contracts/validation.js";
export type {
  ContributionOrigin,
  JsonObject,
  JsonValue,
} from "./contracts/types.js";
