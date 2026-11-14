import { createHash } from "node:crypto";
import {
  discoverOAuthServerInfo,
  selectResourceURL,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  validateAuthorizationResponseIssuer,
  assertSecureTokenEndpoint,
  checkResourceAllowed,
  resourceUrlFromServerUrl,
  validateClientMetadataUrl,
  type OAuthClientProvider,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import type { ExtensionHost } from "../extensions/api.js";
import type { CredentialVault } from "../maintenance/credentials.js";
import type {
  MaintenanceScope,
  MaintenanceOAuthScope,
  MaintenanceOAuthBinding,
  MaintenanceOAuthComplete,
  MaintenanceOAuthLaunch,
} from "../maintenance/requests.js";

export interface McpOAuthConfig {
  clientMetadata?: JsonObject;
  clientInformation?: JsonObject;
  clientMetadataUrl?: string;
  scope?: string;
  issuer?: string;
}
/** Created only after approval, then bound to the actual registered instance. */
export type McpOAuthProviderFactory = (
  host: ExtensionHost,
) => OAuthClientProvider;
type Scope = Pick<MaintenanceScope, "signal" | "assertCurrent" | "authorize">;
type Vault = Pick<CredentialVault, "read" | "update">;
interface Attempt extends JsonObject {
  state: string;
  requestId: string;
  revision: number;
  candidateRevision: string;
  schemeId: string;
  expiresAt: number;
  phase: "preparing" | "pending" | "exchanging" | "completed" | "failed";
}
type AttemptIdentity = Pick<
  Attempt,
  "state" | "requestId" | "revision" | "candidateRevision" | "schemeId"
>;
function checkAttempt(session: Session, expected?: AttemptIdentity): void {
  requireCondition(
    !expected ||
      Object.entries(expected).every(
        ([key, value]) => session.attempt[key] === value,
      ),
    "mcp_oauth_state_invalid",
    "The OAuth attempt was replaced while its native operation was in progress.",
  );
}
interface Session {
  format: 1;
  configHash: string;
  serverUrl: string;
  callbackUrl: string;
  attempt: Attempt;
  discovery?: JsonObject;
  clientInfo?: JsonObject;
  tokens?: JsonObject;
  verifier?: string;
  authorizationUrl?: string;
}
interface Binding {
  readonly config: McpOAuthConfig;
  readonly ref: string;
  readonly identity: JsonObject;
  readonly serverUrl: string;
  readonly configHash: string;
}
const maxBytes = 1024 * 1024;
const copy = <T>(value: T): T =>
  JSON.parse(canonicalJson(value, maxBytes)) as T;
// The official SDK constructs optional own properties with undefined values.
// Only its trusted typed protocol values take this finite JSON projection.
const protocolCopy = <T>(value: T): T =>
  copy(JSON.parse(JSON.stringify(value))) as T;
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value, maxBytes)).digest("hex");
const bounded = (value: unknown, maximum = 8192): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= maximum &&
  !/[\0\r\n]/.test(value);
function endpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentError(
      "mcp_oauth_invalid_configuration",
      "OAuth needs an absolute HTTP(S) endpoint.",
    );
  }
  requireCondition(
    bounded(value) &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "mcp_oauth_invalid_configuration",
    "OAuth endpoints cannot contain embedded credentials or fragments.",
  );
  return url;
}
function secureEndpoint(value: string): URL {
  const url = endpoint(value);
  try {
    return assertSecureTokenEndpoint(url);
  } catch {
    throw new AgentError(
      "mcp_oauth_insecure_endpoint",
      "OAuth authorization-server endpoints require HTTPS; loopback fixtures are allowed.",
    );
  }
}
/** Pure validation: never discovers, registers a client or launches a process. */
export function validateMcpOAuthConfig(value: unknown): McpOAuthConfig {
  const config = copy(value);
  requireCondition(
    isPlainRecord(config) &&
      Object.keys(config).every((key) =>
        [
          "clientMetadata",
          "clientInformation",
          "clientMetadataUrl",
          "scope",
          "issuer",
        ].includes(key),
      ),
    "mcp_oauth_invalid_configuration",
    "Only supported non-secret MCP OAuth configuration is accepted.",
  );
  if (config.clientMetadata !== undefined) {
    requireCondition(
      isPlainRecord(config.clientMetadata) &&
        Object.keys(config.clientMetadata).every((key) =>
          [
            "client_name",
            "client_uri",
            "logo_uri",
            "redirect_uris",
            "token_endpoint_auth_method",
            "grant_types",
            "response_types",
            "scope",
            "contacts",
            "tos_uri",
            "policy_uri",
            "application_type",
          ].includes(key),
        ),
      "mcp_oauth_invalid_configuration",
      "MCP client metadata must contain supported public registration fields.",
    );
    const metadata = config.clientMetadata;
    for (const key of [
      "client_name",
      "client_uri",
      "logo_uri",
      "scope",
      "tos_uri",
      "policy_uri",
    ])
      if (metadata[key] !== undefined)
        requireCondition(
          bounded(metadata[key]),
          "mcp_oauth_invalid_configuration",
          "MCP client metadata fields must be bounded text.",
        );
    for (const key of [
      "redirect_uris",
      "grant_types",
      "response_types",
      "contacts",
    ])
      if (metadata[key] !== undefined)
        requireCondition(
          Array.isArray(metadata[key]) &&
            metadata[key].length <= 128 &&
            metadata[key].every((item) => bounded(item)),
          "mcp_oauth_invalid_configuration",
          "MCP registration lists must contain bounded text entries.",
        );
    if (metadata.token_endpoint_auth_method !== undefined)
      requireCondition(
        ["none", "client_secret_basic", "client_secret_post"].includes(
          String(metadata.token_endpoint_auth_method),
        ),
        "mcp_oauth_invalid_configuration",
        "This OAuth provider supports standard public/secret client authentication.",
      );
    if (metadata.application_type !== undefined)
      requireCondition(
        ["web", "native"].includes(String(metadata.application_type)),
        "mcp_oauth_invalid_configuration",
        "Use a supported OAuth application type.",
      );
    if (Array.isArray(metadata.grant_types))
      requireCondition(
        metadata.grant_types.every((item) =>
          ["authorization_code", "refresh_token"].includes(String(item)),
        ),
        "mcp_oauth_invalid_configuration",
        "MCP consent uses authorization code with PKCE and refresh.",
      );
    if (Array.isArray(metadata.response_types))
      requireCondition(
        metadata.response_types.every((item) => item === "code"),
        "mcp_oauth_invalid_configuration",
        "MCP consent requires an authorization code response.",
      );
  }
  if (config.clientInformation !== undefined) {
    requireCondition(
      isPlainRecord(config.clientInformation) &&
        Object.keys(config.clientInformation).every((key) =>
          [
            "client_id",
            "client_id_issued_at",
            "client_secret_expires_at",
          ].includes(key),
        ) &&
        bounded(config.clientInformation.client_id),
      "mcp_oauth_invalid_configuration",
      "Pre-registered client information must not include secrets or tokens.",
    );
    for (const key of ["client_id_issued_at", "client_secret_expires_at"])
      if (config.clientInformation[key] !== undefined)
        requireCondition(
          Number.isSafeInteger(config.clientInformation[key]) &&
            Number(config.clientInformation[key]) >= 0,
          "mcp_oauth_invalid_configuration",
          "OAuth registration timestamps must be nonnegative integers.",
        );
  }
  if (config.clientMetadataUrl !== undefined) {
    requireCondition(
      bounded(config.clientMetadataUrl),
      "mcp_oauth_invalid_configuration",
      "Use a bounded client metadata URL.",
    );
    endpoint(config.clientMetadataUrl);
    try {
      validateClientMetadataUrl(config.clientMetadataUrl);
    } catch {
      throw new AgentError(
        "mcp_oauth_invalid_configuration",
        "A client metadata document requires its public HTTPS URL with a non-root path.",
      );
    }
  }
  if (config.scope !== undefined)
    requireCondition(
      bounded(config.scope) &&
        config.scope
          .split(" ")
          .every((item) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(item)),
      "mcp_oauth_invalid_configuration",
      "Use space-separated OAuth scope tokens.",
    );
  if (config.issuer !== undefined) {
    requireCondition(
      bounded(config.issuer),
      "mcp_oauth_invalid_configuration",
      "Use a bounded issuer.",
    );
    requireCondition(
      !endpoint(config.issuer).search,
      "mcp_oauth_invalid_configuration",
      "An OAuth issuer cannot contain query parameters.",
    );
  }
  return config as McpOAuthConfig;
}
function current(scope: Scope): void {
  scope.signal.throwIfAborted();
  authorizeCall(() => scope.assertCurrent());
}
function access(scope: Scope, url: string): void {
  current(scope);
  authorizeCall(() =>
    scope.authorize({
      type: "url",
      value: endpoint(url).href,
      access: "oauth",
    }),
  );
}
function safeFailure(error: unknown, signal: AbortSignal): AgentError {
  if (signal.aborted)
    return new AgentError(
      "mcp_oauth_cancelled",
      "The OAuth operation was cancelled after its native work settled.",
    );
  if (isAgentError(error))
    return new AgentError(
      error.code,
      error.code.startsWith("mcp_oauth_") ||
        error.code === "maintenance_auth_required"
        ? error.message
        : "The OAuth operation is not currently authorized.",
    );
  return new AgentError(
    "mcp_oauth_failed",
    "The MCP OAuth operation failed; provider payloads and credentials are private.",
  );
}

/** Agent-private storage and official SDK orchestration; never enters script SDK. */
export class McpOAuthService {
  #writes = new Map<string, Promise<void>>();
  constructor(
    readonly vault: Vault,
    readonly timeoutMs = 30000,
  ) {
    requireCondition(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000,
      "mcp_oauth_invalid_configuration",
      "OAuth requires a bounded native request deadline.",
    );
  }
  #binding(config: JsonObject, ref: string, identity: JsonObject): Binding {
    const fixed = validateMcpOAuthConfig(config),
      bound = copy(identity);
    requireCondition(
      bound.target === "mcp" &&
        bound.scheme === "oauth" &&
        [
          "owner",
          "agentId",
          "profile",
          "name",
          "service",
          "authRevision",
        ].every((key) => bounded(bound[key])) &&
        /^[a-f0-9]{64}$/.test(String(bound.authRevision)) &&
        /^[a-f0-9]{64}$/.test(hash(fixed)) &&
        /^cred_[a-f0-9]{48}$/.test(ref),
      "mcp_oauth_binding_invalid",
      "OAuth requires the fixed owner, Agent/profile, connection and configuration binding.",
    );
    requireCondition(
      bound.authRevision === hash(fixed),
      "mcp_oauth_binding_invalid",
      "The OAuth configuration changed outside its credential binding.",
    );
    return {
      config: fixed,
      identity: bound,
      ref,
      serverUrl: endpoint(String(bound.service)).href,
      configHash: hash(fixed),
    };
  }
  async #read(
    binding: Binding,
    scope: Scope,
    expected?: AttemptIdentity,
  ): Promise<{ record: JsonObject; session: Session }> {
    current(scope);
    const record = await this.vault.read(binding.ref, binding.identity),
      session = record.mcpOAuth;
    current(scope);
    requireCondition(
      isPlainRecord(session) &&
        session.format === 1 &&
        session.serverUrl === binding.serverUrl &&
        session.configHash === binding.configHash &&
        isPlainRecord(session.attempt),
      "maintenance_auth_required",
      "Complete MCP authorization for this exact connection configuration.",
    );
    checkAttempt(session as unknown as Session, expected);
    return { record, session: session as unknown as Session };
  }
  async #mutate(
    binding: Binding,
    scope: Scope,
    mutate: (record: JsonObject) => void,
  ): Promise<void> {
    const previous = this.#writes.get(binding.ref) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        current(scope);
        const record = await this.vault.read(binding.ref, binding.identity);
        current(scope);
        mutate(record);
        current(scope);
        await this.vault.update(binding.ref, binding.identity, record);
        current(scope);
      });
    this.#writes.set(binding.ref, next);
    try {
      await next;
    } finally {
      if (this.#writes.get(binding.ref) === next)
        this.#writes.delete(binding.ref);
    }
  }
  async #set(
    binding: Binding,
    scope: Scope,
    mutate: (session: Session, record: JsonObject) => void,
    expected?: AttemptIdentity,
  ): Promise<void> {
    await this.#mutate(binding, scope, (record) => {
      const session = record.mcpOAuth;
      requireCondition(
        isPlainRecord(session) &&
          session.configHash === binding.configHash &&
          session.serverUrl === binding.serverUrl,
        "mcp_oauth_binding_invalid",
        "The OAuth session no longer belongs to this configuration.",
      );
      checkAttempt(session as unknown as Session, expected);
      mutate(session as unknown as Session, record);
    });
  }
  #provider(
    binding: Binding,
    scope: Scope,
    callbackUrl: string,
    interactive: boolean,
    expected?: AttemptIdentity,
  ): OAuthClientProvider {
    const metadata = {
      client_name: "Nexum",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...binding.config.clientMetadata,
      redirect_uris: [callbackUrl],
    } as OAuthClientMetadata;
    const configuredRedirects = binding.config.clientMetadata?.redirect_uris;
    requireCondition(
      !Array.isArray(configuredRedirects) ||
        configuredRedirects.includes(callbackUrl),
      "mcp_oauth_invalid_configuration",
      "The registered redirect URI must include the platform callback.",
    );
    const checkIssuer = (discovery: OAuthDiscoveryState) => {
      const issuer =
        discovery.authorizationServerMetadata?.issuer ??
        discovery.authorizationServerUrl;
      requireCondition(
        !binding.config.issuer || binding.config.issuer === issuer,
        "mcp_oauth_issuer_mismatch",
        "Discovery did not match the configured issuer.",
      );
      secureEndpoint(issuer);
      for (const key of [
        "authorization_endpoint",
        "token_endpoint",
        "registration_endpoint",
      ] as const) {
        const value = discovery.authorizationServerMetadata?.[key];
        if (value) secureEndpoint(value);
      }
      return issuer;
    };
    const service = this;
    const read = () => service.#read(binding, scope, expected);
    const set = (mutate: (session: Session, record: JsonObject) => void) =>
      service.#set(binding, scope, mutate, expected);
    return {
      redirectUrl: callbackUrl,
      clientMetadata: copy(metadata),
      ...(binding.config.clientMetadataUrl
        ? { clientMetadataUrl: binding.config.clientMetadataUrl }
        : {}),
      async state() {
        requireCondition(
          interactive,
          "maintenance_auth_required",
          "Renew MCP consent through the user authorization page.",
        );
        return (await read()).session.attempt.state;
      },
      async clientInformation(ctx) {
        const { record, session } = await read();
        const info = session.clientInfo ?? binding.config.clientInformation;
        if (!info || (ctx && info.issuer && info.issuer !== ctx.issuer))
          return undefined;
        const issuer =
          (session.discovery as unknown as OAuthDiscoveryState | undefined)
            ?.authorizationServerMetadata?.issuer ??
          (session.discovery as unknown as OAuthDiscoveryState | undefined)
            ?.authorizationServerUrl;
        if (ctx && issuer && ctx.issuer !== issuer) return undefined;
        return copy({
          ...info,
          ...(info.token_endpoint_auth_method === undefined &&
          binding.config.clientMetadata?.token_endpoint_auth_method
            ? {
                token_endpoint_auth_method:
                  binding.config.clientMetadata.token_endpoint_auth_method,
              }
            : {}),
          ...(binding.config.clientInformation &&
          typeof record.clientSecret === "string"
            ? { client_secret: record.clientSecret }
            : {}),
        }) as StoredOAuthClientInformation;
      },
      async saveClientInformation(info, ctx) {
        requireCondition(
          interactive || (await read()).session.clientInfo !== undefined,
          "maintenance_auth_required",
          "Client registration changes require the authorization page.",
        );
        requireCondition(
          !ctx || info.issuer === ctx.issuer,
          "mcp_oauth_issuer_mismatch",
          "Client registration must retain its issuer.",
        );
        await set((session) => {
          session.clientInfo = copy(info) as unknown as JsonObject;
        });
      },
      async tokens(ctx) {
        const { session } = await read();
        if (session.attempt.phase !== "completed") return undefined;
        const tokens = session.tokens;
        return tokens && (!ctx || tokens.issuer === ctx.issuer)
          ? (copy(tokens) as unknown as StoredOAuthTokens)
          : undefined;
      },
      async saveTokens(tokens, ctx) {
        requireCondition(
          bounded(tokens.access_token, 65536) &&
            (!ctx || tokens.issuer === ctx.issuer),
          "mcp_oauth_invalid_tokens",
          "OAuth tokens must retain their authorized issuer.",
        );
        await set((session) => {
          const discovery = session.discovery as unknown as OAuthDiscoveryState;
          requireCondition(
            tokens.issuer === checkIssuer(discovery),
            "mcp_oauth_issuer_mismatch",
            "Tokens cannot change their authorized issuer.",
          );
          const old = session.tokens;
          session.tokens = copy({
            ...tokens,
            ...(tokens.refresh_token === undefined && old?.refresh_token
              ? { refresh_token: old.refresh_token }
              : {}),
          }) as unknown as JsonObject;
        });
      },
      async redirectToAuthorization(url) {
        requireCondition(
          interactive,
          "maintenance_auth_required",
          "Renew MCP consent through the user authorization page.",
        );
        secureEndpoint(url.href);
        access(scope, url.href);
        await set((session) => {
          session.authorizationUrl = url.href;
          session.attempt.phase = "pending";
        });
      },
      async saveCodeVerifier(value) {
        requireCondition(
          interactive && /^[A-Za-z0-9._~-]{43,128}$/.test(value),
          "maintenance_auth_required",
          "PKCE preparation requires an interactive authorization request.",
        );
        await set((session) => {
          session.verifier = value;
        });
      },
      async codeVerifier() {
        const { session } = await read();
        requireCondition(
          bounded(session.verifier, 128),
          "mcp_oauth_state_invalid",
          "The authorization attempt has no matching PKCE verifier.",
        );
        return session.verifier;
      },
      async saveDiscoveryState(value) {
        const issuer = checkIssuer(value);
        await set((session) => {
          if (!interactive && session.discovery)
            requireCondition(
              checkIssuer(
                session.discovery as unknown as OAuthDiscoveryState,
              ) === issuer,
              "maintenance_auth_required",
              "Changing authorization server requires user confirmation.",
            );
          session.discovery = protocolCopy(value) as unknown as JsonObject;
        });
      },
      async discoveryState() {
        const { session } = await read();
        return session.discovery
          ? (copy(session.discovery) as unknown as OAuthDiscoveryState)
          : undefined;
      },
      async invalidateCredentials(kind) {
        await set((session) => {
          if (kind === "all" || kind === "tokens") delete session.tokens;
          if (kind === "all" || kind === "client") delete session.clientInfo;
          if (kind === "all" || kind === "verifier") delete session.verifier;
          if (kind === "all" || kind === "discovery") delete session.discovery;
        });
      },
      async validateResourceURL(serverUrl, resource) {
        current(scope);
        const expected = resourceUrlFromServerUrl(binding.serverUrl);
        requireCondition(
          resourceUrlFromServerUrl(serverUrl).href === expected.href &&
            (!resource ||
              checkResourceAllowed({
                requestedResource: expected,
                configuredResource: resource,
              })),
          "mcp_oauth_resource_mismatch",
          "OAuth resource must match this exact MCP connection.",
        );
        return resource ? new URL(resource) : expected;
      },
    };
  }
  async #run<T>(
    scope: Scope,
    action: (scope: Scope) => Promise<T>,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs),
      signal = AbortSignal.any([scope.signal, timeout]);
    const operation: Scope = {
      signal,
      assertCurrent: () => current(scope),
      authorize: (target) => scope.authorize(target),
    };
    try {
      current(operation);
      const value = await action(operation);
      current(operation);
      return value;
    } catch (error) {
      if (timeout.aborted && signal.reason === timeout.reason)
        throw new AgentError(
          "mcp_oauth_timeout",
          "The OAuth deadline expired after its native work settled.",
        );
      throw safeFailure(error, signal);
    }
  }
  #fetch(scope: Scope): typeof fetch {
    return async (target, init = {}) => {
      const url = secureEndpoint(
        target instanceof Request ? target.url : String(target),
      ).href;
      access(scope, url);
      const signal = AbortSignal.any([
        scope.signal,
        ...(init.signal ? [init.signal] : []),
      ]);
      const headers = new Headers(init.headers);
      requireCondition(
        !headers.has("cookie") && !headers.has("proxy-authorization"),
        "mcp_oauth_invalid_transport",
        "OAuth does not inherit platform cookies or proxy credentials.",
      );
      const response = await fetch(url, {
        ...init,
        headers,
        signal,
        redirect: "error",
        credentials: "omit",
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            current(scope);
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            requireCondition(
              size <= maxBytes,
              "mcp_oauth_response_too_large",
              "OAuth metadata and token responses exceed their byte budget.",
            );
            chunks.push(item.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          await reader.closed.catch(() => {});
        }
      }
      current(scope);
      return new Response(size ? Buffer.concat(chunks, size) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }
  async start(
    config: JsonObject,
    ref: string,
    identity: JsonObject,
    authorization: MaintenanceOAuthBinding,
    scope: MaintenanceOAuthScope,
  ): Promise<MaintenanceOAuthLaunch> {
    const binding = this.#binding(config, ref, identity),
      fixed = copy(authorization);
    requireCondition(
      scope.caller.principalId === identity.owner &&
        bounded(fixed.state, 4096) &&
        bounded(fixed.schemeId) &&
        /^[a-f0-9]{64}$/.test(fixed.candidateRevision),
      "mcp_oauth_binding_invalid",
      "Consent must use the current owner and candidate identity.",
    );
    endpoint(fixed.callbackUrl);
    const expected: AttemptIdentity = {
      state: fixed.state,
      requestId: scope.requestId,
      revision: scope.revision,
      schemeId: fixed.schemeId,
      candidateRevision: fixed.candidateRevision,
    };
    return this.#run(scope, async (operation) => {
      await this.#mutate(binding, operation, (record) => {
        const old = record.mcpOAuth as Session | undefined;
        record.mcpOAuth = {
          format: 1,
          serverUrl: binding.serverUrl,
          configHash: binding.configHash,
          callbackUrl: fixed.callbackUrl,
          ...(old?.configHash === binding.configHash && old.clientInfo
            ? { clientInfo: old.clientInfo }
            : {}),
          attempt: {
            state: fixed.state,
            requestId: scope.requestId,
            revision: scope.revision,
            schemeId: fixed.schemeId,
            candidateRevision: fixed.candidateRevision,
            expiresAt: Date.now() + 15 * 60 * 1000,
            phase: "preparing",
          },
        };
      });
      const provider = this.#provider(
        binding,
        operation,
        fixed.callbackUrl,
        true,
        expected,
      );
      const fetchFn = this.#fetch(operation);
      const discovery = await discoverOAuthServerInfo(binding.serverUrl, {
        fetchFn,
      });
      await provider.saveDiscoveryState!(discovery);
      const issuer =
        discovery.authorizationServerMetadata?.issuer ??
        discovery.authorizationServerUrl;
      const context = { issuer },
        metadata = discovery.authorizationServerMetadata;
      let info = await provider.clientInformation(context);
      if (!info)
        info =
          metadata?.client_id_metadata_document_supported &&
          binding.config.clientMetadataUrl
            ? { client_id: binding.config.clientMetadataUrl, issuer }
            : {
                ...(await registerClient(discovery.authorizationServerUrl, {
                  metadata,
                  clientMetadata: provider.clientMetadata,
                  fetchFn,
                })),
                issuer,
              };
      info = { ...info, issuer };
      await provider.saveClientInformation!(info, context);
      const selectedResource = await selectResourceURL(
        binding.serverUrl,
        provider,
        discovery.resourceMetadata,
      );
      const resource = discovery.resourceMetadata?.resource ?? selectedResource;
      const scopeText =
        binding.config.scope ??
        (String(binding.config.clientMetadata?.scope ?? "") || undefined);
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        discovery.authorizationServerUrl,
        {
          metadata,
          clientInformation: info,
          redirectUrl: fixed.callbackUrl,
          state: fixed.state,
          scope: scopeText,
          resource,
        },
      );
      await provider.saveCodeVerifier(codeVerifier);
      await provider.redirectToAuthorization(authorizationUrl);
      const { session } = await this.#read(binding, operation, expected);
      requireCondition(
        bounded(session.authorizationUrl, 32768),
        "mcp_oauth_failed",
        "The official provider did not prepare a consent redirect.",
      );
      return {
        authorizationUrl: session.authorizationUrl,
        issuer:
          discovery.authorizationServerMetadata?.issuer ??
          discovery.authorizationServerUrl,
        requireIssuer:
          discovery.authorizationServerMetadata
            ?.authorization_response_iss_parameter_supported === true,
      };
    });
  }
  async complete(
    config: JsonObject,
    ref: string,
    identity: JsonObject,
    input: MaintenanceOAuthComplete,
    scope: MaintenanceOAuthScope,
  ): Promise<string> {
    const binding = this.#binding(config, ref, identity),
      fixed = copy(input);
    const expected: AttemptIdentity = {
      state: fixed.callback.state,
      requestId: scope.requestId,
      revision: scope.revision,
      schemeId: fixed.schemeId,
      candidateRevision: fixed.candidateRevision,
    };
    return this.#run(scope, async (operation) => {
      await this.#set(
        binding,
        operation,
        (session) => {
          const attempt = session.attempt;
          requireCondition(
            scope.caller.principalId === identity.owner &&
              attempt.phase === "pending" &&
              attempt.expiresAt > Date.now() &&
              attempt.requestId === scope.requestId &&
              attempt.revision === scope.revision &&
              attempt.state === fixed.callback.state &&
              attempt.schemeId === fixed.schemeId &&
              attempt.candidateRevision === fixed.candidateRevision,
            "mcp_oauth_state_invalid",
            "The authorization callback does not match the original pending attempt.",
          );
          attempt.phase = "exchanging";
        },
        expected,
      );
      try {
        requireCondition(
          !fixed.callback.error && bounded(fixed.callback.code, 65536),
          "mcp_oauth_denied",
          "The user or provider declined this authorization attempt.",
        );
        const { session } = await this.#read(binding, operation, expected);
        const provider = this.#provider(
          binding,
          operation,
          session.callbackUrl,
          true,
          expected,
        );
        const discovery = session.discovery as unknown as OAuthDiscoveryState;
        requireCondition(
          discovery?.authorizationServerUrl,
          "mcp_oauth_state_invalid",
          "Authorization requires the server discovery recorded before redirect.",
        );
        const issuer =
          discovery.authorizationServerMetadata?.issuer ??
          discovery.authorizationServerUrl;
        validateAuthorizationResponseIssuer({
          iss: fixed.callback.issuer,
          expectedIssuer: issuer,
          issParameterSupported:
            discovery.authorizationServerMetadata
              ?.authorization_response_iss_parameter_supported === true,
        });
        const info = await provider.clientInformation({ issuer });
        requireCondition(
          info && info.issuer === issuer,
          "mcp_oauth_issuer_mismatch",
          "The client registration no longer matches the original issuer.",
        );
        const selectedResource = await selectResourceURL(
          binding.serverUrl,
          provider,
          discovery.resourceMetadata,
        );
        const resource =
          discovery.resourceMetadata?.resource ?? selectedResource;
        const tokens = await exchangeAuthorization(
          discovery.authorizationServerUrl,
          {
            metadata: discovery.authorizationServerMetadata,
            clientInformation: info,
            authorizationCode: fixed.callback.code,
            ...(fixed.callback.issuer ? { iss: fixed.callback.issuer } : {}),
            codeVerifier: await provider.codeVerifier(),
            redirectUri: session.callbackUrl,
            resource,
            fetchFn: this.#fetch(operation),
          },
        );
        await provider.saveTokens({ ...tokens, issuer }, { issuer });
        await this.#set(
          binding,
          operation,
          (session) => {
            requireCondition(
              session.attempt.phase === "exchanging",
              "mcp_oauth_state_invalid",
              "Only the matching admitted exchange may complete.",
            );
            session.attempt.phase = "completed";
            delete session.verifier;
            delete session.authorizationUrl;
          },
          expected,
        );
        return ref;
      } catch (error) {
        // An admitted code exchange is never replayed after unknown I/O outcome.
        // A cancelled/revoked scope cannot write; phase remains exchanging.
        if (!operation.signal.aborted) {
          try {
            await this.#set(
              binding,
              operation,
              (session) => {
                session.attempt.phase = "failed";
                delete session.verifier;
              },
              expected,
            );
          } catch {}
        }
        throw error;
      }
    });
  }
  async ready(
    config: JsonObject,
    ref: string,
    identity: JsonObject,
    scope: MaintenanceScope,
  ): Promise<boolean> {
    const binding = this.#binding(config, ref, identity);
    requireCondition(
      scope.caller.principalId === binding.identity.owner,
      "mcp_oauth_binding_invalid",
      "OAuth credentials belong to their original owner.",
    );
    current(scope);
    const record = await this.vault.read(ref, binding.identity);
    current(scope);
    const session = record.mcpOAuth;
    return (
      isPlainRecord(session) &&
      session.configHash === binding.configHash &&
      session.serverUrl === binding.serverUrl &&
      isPlainRecord(session.attempt) &&
      session.attempt.phase === "completed" &&
      isPlainRecord(session.tokens) &&
      bounded(session.tokens.access_token, 65536)
    );
  }
  async provider(
    config: JsonObject,
    ref: string,
    identity: JsonObject,
    scope: MaintenanceScope,
  ): Promise<McpOAuthProviderFactory> {
    const binding = this.#binding(config, ref, identity);
    requireCondition(
      await this.ready(config, ref, identity, scope),
      "maintenance_auth_required",
      "Complete the connection's OAuth consent before approving activation.",
    );
    const callbackUrl = (await this.#read(binding, scope)).session.callbackUrl;
    // No apply/request/run scope is retained by the returned factory.
    return (host) => {
      requireCondition(
        host.context.agentId === binding.identity.agentId &&
          host.context.profile === binding.identity.profile,
        "mcp_oauth_binding_invalid",
        "OAuth credentials cannot bind to another Agent or profile.",
      );
      const runtime: Scope = {
        signal: host.signal,
        assertCurrent: () =>
          host.authorize({
            type: "connection",
            value: String(binding.identity.name),
            access: "oauth",
          }),
        authorize: (target) => host.authorize(target),
      };
      current(runtime);
      return this.#provider(binding, runtime, callbackUrl, false);
    };
  }
}
