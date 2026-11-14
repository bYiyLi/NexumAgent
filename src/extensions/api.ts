import type { JsonObject } from "../contracts/types.js";
import type { SchemaDialect } from "../contracts/validation.js";
import type { InputRequest } from "../runtime/engine.js";
import type { OutputAPI } from "../sdk/output.js";
import type { ResourceService } from "./resources.js";
import type { StateService } from "./state.js";
import type { TransferService } from "./transfer.js";
import type { HostRequestServices } from "./host-requests.js";
import type { MaintenanceService } from "../maintenance/requests.js";

export interface AccessTarget {
  type:
    | "path"
    | "url"
    | "resource"
    | "connection"
    | "agent-state"
    | "user-state"
    | "transfer"
    | "maintenance";
  value: string;
  access: string;
}
export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: JsonObject;
}
/** Budget ownership only; neither a filesystem handle nor a native-close proof. */
export interface StorageReservation {
  release(): void;
}
export interface StorageService {
  reserve(bytes: number): Promise<StorageReservation>;
}
export interface ExtensionHost {
  readonly context: Readonly<JsonObject>;
  readonly config: Readonly<JsonObject>;
  readonly signal: AbortSignal;
  readonly resources: ResourceService;
  readonly storage: StorageService;
  /** Current instance authority, independent of any particular run/caller. */
  authorize(target: AccessTarget): void;
  log(entry: LogEntry): void;
}
export interface Invocation {
  readonly context: Readonly<JsonObject>;
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly resources: ResourceService;
  readonly storage: StorageService;
  readonly output: OutputAPI;
  readonly state: StateService;
  readonly transfer: TransferService;
  readonly maintenance: MaintenanceService;
  /** Available only when the original, currently authorized Host session supports it. */
  readonly hostRequests?: HostRequestServices;
  log(entry: LogEntry): void;
  progress(value: JsonObject): void;
  authorize(target: AccessTarget): void;
  requestInput(request: InputRequest): Promise<JsonObject>;
}
export interface MethodDefinition {
  description: string;
  permissions: readonly string[];
  inputSchema: unknown;
  schemaDialect?: SchemaDialect;
  schemas?: readonly unknown[];
  outputSchema?: unknown;
  outputSchemaDialect?: SchemaDialect;
  /** Internal adapter mapping; the source method name is retained separately. */
  path?: readonly string[];
  normalize?(args: readonly unknown[]): unknown;
  handle(input: any, call: Invocation): unknown;
}
export interface ExtensionInstance {
  methods: Readonly<Record<string, MethodDefinition>>;
  dispose?(): void | Promise<void>;
}
export type ExtensionFactory = (
  host: ExtensionHost,
) => ExtensionInstance | Promise<ExtensionInstance>;
