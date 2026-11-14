import type { ExtensionFactory } from "../extensions/api.js";
import type { JsonObject } from "../contracts/types.js";

/** Already approved immutable source bytes. Location only supplies the $ref base. */
export interface OpenApiDocument {
  readonly location: string;
  readonly bytes: Uint8Array | string;
}
export interface OpenApiAuthentication {
  /** Scheme identity -> protected credential reference, never a credential value. */
  readonly credentialBindings?: Readonly<Record<string, string>>;
  /** Explicit OR-branch selection, keyed by the original operation name. */
  readonly operationSelections?: Readonly<Record<string, number>>;
  /** Approved authentication omitted by the source service's specification. */
  readonly supplementalSchemes?: Readonly<Record<string, JsonObject>>;
  readonly supplementalSecurity?: readonly Readonly<
    Record<string, readonly string[]>
  >[];
}
export interface ApprovedOpenApi {
  readonly name: string;
  readonly revision: string;
  readonly document: OpenApiDocument;
  readonly references?: readonly OpenApiDocument[];
  readonly serviceUrl: string;
  readonly authentication?: OpenApiAuthentication;
  readonly limits?: {
    readonly documentBytes?: number;
    readonly totalDocumentBytes?: number;
    readonly referenceCount?: number;
    readonly operationCount?: number;
    readonly requestBytes?: number;
    readonly responseBytes?: number;
    readonly requestTimeoutMs?: number;
  };
}
export type OpenApiCredential =
  | { readonly type: "apiKey"; readonly value: string }
  | {
      readonly type: "basic";
      readonly username: string;
      readonly password: string;
    }
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "mutualTLS"; readonly dispatcher: unknown };
export interface OpenApiCredentialRequest {
  readonly api: string;
  readonly revision: string;
  readonly scheme: string;
  readonly definition: Readonly<JsonObject>;
  readonly credentialRef: string;
  readonly scopes: readonly string[];
  /** Business target before credential injection; account/token binding checks belong to this trusted port. */
  readonly target: string;
  readonly signal: AbortSignal;
  readonly operationId: string;
  readonly context: Readonly<JsonObject>;
  readonly hostContext: Readonly<JsonObject>;
}
export interface OpenApiCredentialProvider {
  get(request: OpenApiCredentialRequest): Promise<OpenApiCredential>;
}
export interface OpenApiResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: unknown;
  readonly redacted?: boolean;
}
export interface OpenApiOperation {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly description: string;
  readonly parameters: readonly JsonObject[];
  readonly requestBody?: JsonObject;
  readonly responses: JsonObject;
  readonly security: readonly JsonObject[];
}
export interface PreparedOpenApi {
  readonly factory: ExtensionFactory;
  readonly bindingPath: readonly ["api", string];
  readonly permissions: readonly ["api.use"];
  readonly revision: string;
  /** Generated from the same fixed operation model; contains no configuration secrets or credential references. */
  readonly documentation: { readonly markdown: string; readonly types: string };
  catalog(): {
    readonly name: string;
    readonly sourceVersion: string;
    readonly revision: string;
    readonly ready: boolean;
    readonly operations: readonly OpenApiOperation[];
  };
}
