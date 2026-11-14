import * as client from "openid-client";
import { createHash } from "node:crypto";
import { authorizeCall } from "../contracts/caller.js";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import {
  privateMaintenanceRead,
  privateMaintenanceWrite,
} from "./credentials.js";
import type {
  MaintenanceScope,
  MaintenanceOAuthScope,
  MaintenanceOAuthBinding,
  MaintenanceOAuthComplete,
  MaintenanceOAuthLaunch,
} from "./requests.js";

export interface OAuthConfig {
  readonly flow: "authorizationCode" | "clientCredentials" | "device";
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly tokenEndpoint?: string;
  readonly authorizationEndpoint?: string;
  readonly deviceAuthorizationEndpoint?: string;
  readonly jwksUri?: string;
  readonly clientAuthentication?:
    "none" | "client_secret_basic" | "client_secret_post";
  readonly oidc?: boolean;
  readonly allowHttp?: boolean;
}
export type OAuthScope = Pick<
  MaintenanceScope,
  "signal" | "assertCurrent" | "authorize"
>;
export interface OAuthVault {
  read(ref: string, binding: JsonObject): Promise<JsonObject>;
  create(binding: JsonObject, value: JsonObject): Promise<string>;
  update(ref: string, binding: JsonObject, value: JsonObject): Promise<void>;
}
export interface OAuthProviderOptions {
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}
interface ProviderState {
  vault: OAuthVault;
  limits: Required<OAuthProviderOptions>;
  refreshing: Map<string, Promise<string>>;
}
interface Operation {
  readonly scope: OAuthScope;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
interface Prepared {
  readonly configuration: client.Configuration;
  readonly record: JsonObject;
  readonly hash: string;
}
type Attempt = JsonObject & {
  state: string;
  requestId: string;
  revision: number;
  candidateRevision: string;
  schemeId: string;
  callbackUrl: string;
  credentialRef: string;
  binding: JsonObject;
  configHash: string;
  issuer: string;
  requireIssuer: boolean;
  expiresAt: number;
  phase: "pending" | "exchanging" | "completed";
  launch: JsonObject;
  verifier?: string;
  nonce?: string;
  device?: JsonObject;
};
const providers = new WeakMap<OAuthProvider, ProviderState>();
const sessionsBusy = new Set<string>();
const ownErrors = new WeakSet<object>();
const denied = new Set([
  "forbidden",
  "permission_denied",
  "access_denied",
  "unauthorized",
  "authorization_configuration",
]);
const copy = <T>(value: T): T =>
  JSON.parse(canonicalJson(value, 1024 * 1024)) as T;
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalJson(value, 1024 * 1024))
    .digest("hex");
function fail(code: string, message: string): AgentError {
  const error = new AgentError(code, message);
  ownErrors.add(error);
  return error;
}
function check(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw fail(code, message);
}
function state(provider: OAuthProvider): ProviderState {
  return providers.get(provider)!;
}
function current(scope: OAuthScope): void {
  scope.signal.throwIfAborted();
  authorizeCall(() => scope.assertCurrent());
}
function interactiveIdentity(
  binding: JsonObject,
  scheme: string,
  scope: MaintenanceOAuthScope,
): void {
  current(scope);
  check(
    typeof binding.owner === "string" &&
      binding.owner.length > 0 &&
      binding.owner === scope.caller.principalId &&
      binding.scheme === scheme &&
      ["agentId", "profile", "target", "name", "authRevision"].every(
        (key) => typeof binding[key] === "string" && binding[key].length > 0,
      ) &&
      typeof scope.requestId === "string" &&
      scope.requestId.length > 0 &&
      Number.isSafeInteger(scope.revision) &&
      scope.revision > 0,
    "oauth_owner_mismatch",
    "The OAuth attempt must belong to the current owner and fixed Agent/profile/target/scheme request.",
  );
}
function endpoint(value: string, config: OAuthConfig): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail(
      "oauth_invalid_configuration",
      "OAuth endpoints must be absolute HTTP(S) URLs.",
    );
  }
  check(
    url.protocol === "https:" ||
      (url.protocol === "http:" && config.allowHttp === true),
    "oauth_insecure_endpoint",
    "HTTP OAuth endpoints require explicit configuration and current endpoint authorization.",
  );
  check(
    !url.username && !url.password && !url.hash && url.href.length <= 8192,
    "oauth_invalid_configuration",
    "OAuth endpoint URLs cannot embed credentials or fragments.",
  );
  return url;
}
function fixedConfig(value: OAuthConfig): OAuthConfig {
  const config = copy(value);
  check(
    isPlainRecord(config) &&
      Object.keys(config).every((key) =>
        [
          "flow",
          "issuer",
          "clientId",
          "scopes",
          "tokenEndpoint",
          "authorizationEndpoint",
          "deviceAuthorizationEndpoint",
          "jwksUri",
          "clientAuthentication",
          "oidc",
          "allowHttp",
        ].includes(key),
      ),
    "oauth_invalid_configuration",
    "Only supported non-secret OAuth configuration fields are accepted.",
  );
  check(
    ["authorizationCode", "clientCredentials", "device"].includes(
      config.flow,
    ) &&
      typeof config.clientId === "string" &&
      config.clientId.length > 0 &&
      Buffer.byteLength(config.clientId) <= 4096 &&
      !/[\0\r\n]/.test(config.clientId),
    "oauth_invalid_configuration",
    "OAuth requires its supported flow and bounded client identity.",
  );
  check(
    Array.isArray(config.scopes) &&
      config.scopes.length <= 128 &&
      config.scopes.every(
        (scope) =>
          typeof scope === "string" &&
          /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope) &&
          scope.length <= 1024,
      ) &&
      new Set(config.scopes).size === config.scopes.length,
    "oauth_invalid_configuration",
    "OAuth scopes must be distinct bounded scope tokens.",
  );
  check(
    config.clientAuthentication === undefined ||
      ["none", "client_secret_basic", "client_secret_post"].includes(
        config.clientAuthentication,
      ),
    "oauth_invalid_configuration",
    "The OAuth client authentication method is unsupported.",
  );
  check(
    (config.oidc === undefined || typeof config.oidc === "boolean") &&
      (config.allowHttp === undefined || typeof config.allowHttp === "boolean"),
    "oauth_invalid_configuration",
    "OAuth feature flags must be booleans.",
  );
  const issuer = endpoint(config.issuer, config);
  check(
    !issuer.search,
    "oauth_invalid_configuration",
    "OAuth issuers cannot contain query parameters.",
  );
  if (config.oidc)
    check(
      config.scopes.includes("openid"),
      "oauth_invalid_configuration",
      "OIDC authorization must explicitly request the openid scope.",
    );
  for (const key of [
    "tokenEndpoint",
    "authorizationEndpoint",
    "deviceAuthorizationEndpoint",
    "jwksUri",
  ] as const)
    if (config[key] !== undefined) endpoint(config[key]!, config);
  return config;
}
export { fixedConfig as validateOAuthConfig };
function authorize(operation: Operation, url: string): void {
  operation.assertCurrent();
  authorizeCall(() =>
    operation.scope.authorize({ type: "url", value: url, access: "oauth" }),
  );
}
function safeError(
  error: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
): AgentError {
  if (error && typeof error === "object" && ownErrors.has(error))
    return new AgentError(
      (error as AgentError).code,
      (error as AgentError).message,
    );
  if (signal.aborted)
    return new AgentError(
      signal.reason === timeout.reason ? "oauth_timeout" : "oauth_cancelled",
      signal.reason === timeout.reason
        ? "The OAuth operation timed out after its native work settled."
        : "The OAuth operation was cancelled after its native work settled.",
    );
  if (isAgentError(error) && error.code === "storage_quota_exceeded")
    return new AgentError(
      error.code,
      "Managed storage is full; the OAuth update could not be persisted.",
    );
  if (isAgentError(error) && denied.has(error.code))
    return new AgentError(
      error.code,
      "The OAuth operation is not currently authorized.",
    );
  if (
    error instanceof client.AuthorizationResponseError ||
    error instanceof client.ResponseBodyError
  )
    return new AgentError(
      error.error === "access_denied"
        ? "oauth_access_denied"
        : error.error === "invalid_grant"
          ? "oauth_reauthentication_required"
          : "oauth_provider_rejected",
      "The OAuth provider rejected the operation; protected response details were not exposed.",
    );
  return new AgentError(
    "oauth_operation_failed",
    "The OAuth operation failed; provider responses and credentials were not exposed.",
  );
}
async function run<T>(
  provider: OAuthProvider,
  scope: OAuthScope,
  action: (operation: Operation) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(state(provider).limits.timeoutMs),
    signal = AbortSignal.any([scope.signal, timeout]);
  const operation: Operation = {
    scope,
    signal,
    assertCurrent() {
      signal.throwIfAborted();
      current(scope);
    },
  };
  try {
    operation.assertCurrent();
    const result = await action(operation);
    operation.assertCurrent();
    return result;
  } catch (error) {
    throw safeError(error, signal, timeout);
  }
}

/** The library consumes only a bounded, fully settled native response snapshot. */
function transport(
  provider: OAuthProvider,
  config: OAuthConfig,
  operation: Operation,
): client.CustomFetch {
  const limits = state(provider).limits;
  return async (target, options) => {
    const url = endpoint(target, config).href;
    authorize(operation, url);
    const controller = new AbortController(),
      signal = AbortSignal.any([
        operation.signal,
        controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    const headers = new Headers(options.headers);
    let size = Buffer.byteLength(url);
    for (const [name, value] of headers) {
      check(
        ![
          "host",
          "content-length",
          "transfer-encoding",
          "connection",
          "proxy-authorization",
        ].includes(name),
        "oauth_invalid_transport",
        "OAuth cannot replace HTTP routing or framing headers.",
      );
      size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    }
    if (typeof options.body === "string")
      size += Buffer.byteLength(options.body);
    else if (options.body instanceof URLSearchParams)
      size += Buffer.byteLength(options.body.toString());
    else if (options.body !== undefined && options.body !== null)
      throw fail(
        "oauth_invalid_transport",
        "OAuth request bodies must use the library's bounded form encoding.",
      );
    check(
      size <= limits.maxRequestBytes,
      "oauth_request_too_large",
      "The OAuth request exceeds its byte budget.",
    );
    try {
      const response = await fetch(url, {
        ...options,
        headers,
        redirect: "manual",
        signal,
        body: options.body as string | URLSearchParams | null | undefined,
      });
      reader = response.body?.getReader();
      authorize(operation, url);
      check(
        response.status < 300 || response.status >= 400,
        "oauth_redirect_not_allowed",
        "OAuth endpoint redirects are not followed.",
      );
      const declared = response.headers.get("content-length");
      check(
        declared === null ||
          !/^\d+$/.test(declared) ||
          Number(declared) <= limits.maxResponseBytes,
        "oauth_response_too_large",
        "The OAuth endpoint declares a response beyond its byte budget.",
      );
      const chunks: Uint8Array[] = [];
      let length = 0,
        headerBytes = 0;
      for (const [name, value] of response.headers) {
        headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
        check(
          headerBytes <= limits.maxResponseBytes,
          "oauth_response_too_large",
          "OAuth response headers exceed their byte budget.",
        );
      }
      if (reader)
        while (true) {
          authorize(operation, url);
          pending = reader.read();
          const chunk = await pending;
          pending = undefined;
          authorize(operation, url);
          if (chunk.done) break;
          check(
            chunk.value.byteLength <= limits.maxResponseBytes - length,
            "oauth_response_too_large",
            "The OAuth response exceeds its actual byte budget.",
          );
          length += chunk.value.byteLength;
          chunks.push(chunk.value);
        }
      const fixed = new Response(
        length ? Buffer.concat(chunks, length) : null,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
      Object.defineProperty(fixed, "url", { value: response.url });
      return fixed;
    } finally {
      controller.abort();
      if (reader) {
        await Promise.allSettled([
          reader.cancel(),
          reader.closed,
          ...(pending ? [pending] : []),
        ]);
        reader.releaseLock();
      }
    }
  };
}

async function prepare(
  provider: OAuthProvider,
  config: OAuthConfig,
  ref: string,
  binding: JsonObject,
  operation: Operation,
): Promise<Prepared> {
  operation.assertCurrent();
  const record = await state(provider).vault.read(ref, binding);
  operation.assertCurrent();
  const authentication =
    config.clientAuthentication ??
    (record.clientSecret === undefined ? "none" : "client_secret_basic");
  let secret: string | undefined;
  if (authentication !== "none") {
    check(
      typeof record.clientSecret === "string" &&
        record.clientSecret.length > 0 &&
        Buffer.byteLength(record.clientSecret) <= 65536 &&
        !/[\0\r\n]/.test(record.clientSecret),
      "oauth_credential_unavailable",
      "The configured OAuth client secret is unavailable.",
    );
    secret = record.clientSecret;
  }
  const clientAuth =
    authentication === "none"
      ? client.None()
      : authentication === "client_secret_post"
        ? client.ClientSecretPost(secret)
        : client.ClientSecretBasic(secret);
  const metadata = { token_endpoint_auth_method: authentication };
  const fetch = transport(provider, config, operation);
  const enough = !!(
    config.tokenEndpoint &&
    (config.flow !== "authorizationCode" || config.authorizationEndpoint) &&
    (config.flow !== "device" || config.deviceAuthorizationEndpoint) &&
    (!config.oidc || config.jwksUri)
  );
  let configuration: client.Configuration;
  if (enough)
    configuration = new client.Configuration(
      {
        issuer: config.issuer,
        token_endpoint: config.tokenEndpoint,
        authorization_endpoint: config.authorizationEndpoint,
        device_authorization_endpoint: config.deviceAuthorizationEndpoint,
        jwks_uri: config.jwksUri,
      },
      config.clientId,
      metadata,
      clientAuth,
    );
  else
    configuration = await client.discovery(
      new URL(config.issuer),
      config.clientId,
      metadata,
      clientAuth,
      {
        algorithm: config.oidc ? "oidc" : "oauth2",
        [client.customFetch]: fetch,
        timeout: state(provider).limits.timeoutMs / 1000,
        ...(config.allowHttp
          ? { execute: [client.allowInsecureRequests] }
          : {}),
      },
    );
  operation.assertCurrent();
  const discovered = JSON.parse(
    JSON.stringify(configuration.serverMetadata()),
  ) as client.ServerMetadata;
  check(
    discovered.issuer === config.issuer,
    "oauth_issuer_mismatch",
    "OAuth discovery returned a different issuer.",
  );
  const server = {
    ...discovered,
    ...(config.tokenEndpoint ? { token_endpoint: config.tokenEndpoint } : {}),
    ...(config.authorizationEndpoint
      ? { authorization_endpoint: config.authorizationEndpoint }
      : {}),
    ...(config.deviceAuthorizationEndpoint
      ? { device_authorization_endpoint: config.deviceAuthorizationEndpoint }
      : {}),
    ...(config.jwksUri ? { jwks_uri: config.jwksUri } : {}),
  };
  for (const key of [
    "token_endpoint",
    "authorization_endpoint",
    "device_authorization_endpoint",
    "jwks_uri",
  ] as const)
    if (server[key]) endpoint(server[key]!, config);
  check(
    typeof server.token_endpoint === "string",
    "oauth_endpoint_unavailable",
    "The OAuth issuer has no configured token endpoint.",
  );
  configuration = new client.Configuration(
    server,
    config.clientId,
    metadata,
    clientAuth,
  );
  configuration[client.customFetch] = fetch;
  configuration.timeout = state(provider).limits.timeoutMs / 1000;
  if (config.allowHttp) client.allowInsecureRequests(configuration);
  if (config.oidc) {
    check(
      typeof server.jwks_uri === "string",
      "oauth_endpoint_unavailable",
      "OIDC requires its issuer JWKS endpoint.",
    );
    client.enableNonRepudiationChecks(configuration);
  }
  return { configuration, record, hash: hash(config) };
}
function tokenRecord(
  config: OAuthConfig,
  response: client.TokenEndpointResponse,
  old: JsonObject,
  refreshing = false,
): JsonObject {
  check(
    typeof response.access_token === "string" &&
      response.access_token.length > 0 &&
      Buffer.byteLength(response.access_token) <= 65536 &&
      !/[\0\r\n]/.test(response.access_token) &&
      typeof response.token_type === "string" &&
      response.token_type.toLowerCase() === "bearer",
    "oauth_unsupported_token_type",
    "Only a valid provider-issued Bearer access token is supported.",
  );
  check(
    response.expires_in === undefined ||
      (Number.isFinite(response.expires_in) &&
        response.expires_in >= 0 &&
        response.expires_in <= 315360000),
    "oauth_invalid_token_response",
    "The provider returned invalid token lifetime metadata.",
  );
  check(
    response.refresh_token === undefined ||
      (typeof response.refresh_token === "string" &&
        response.refresh_token.length > 0 &&
        Buffer.byteLength(response.refresh_token) <= 65536),
    "oauth_invalid_token_response",
    "The provider returned an invalid refresh token.",
  );
  if (response.scope !== undefined)
    check(
      typeof response.scope === "string" &&
        config.scopes.every((scope) =>
          response.scope!.split(" ").includes(scope),
        ),
      "oauth_insufficient_scope",
      "The provider did not grant the configured OAuth scopes.",
    );
  const previous = isPlainRecord(old.tokens) ? old.tokens : {};
  let identity: JsonObject | undefined;
  if (config.oidc) {
    const helpers = response as client.TokenEndpointResponse &
      Partial<client.TokenEndpointResponseHelpers>;
    const claims = helpers.claims?.();
    if (claims) {
      check(
        typeof claims.iss === "string" &&
          typeof claims.sub === "string" &&
          claims.sub.length > 0,
        "oauth_invalid_identity",
        "The OIDC response has no validated issuer and subject identity.",
      );
      identity = {
        issuer: claims.iss,
        subject: claims.sub,
        audience: (Array.isArray(claims.aud)
          ? [...claims.aud]
          : [claims.aud]
        ).sort(),
        ...(typeof claims.nonce === "string" ? { nonce: claims.nonce } : {}),
      };
      if (refreshing && config.flow !== "clientCredentials") {
        check(
          isPlainRecord(previous.identity),
          "oauth_reauthentication_required",
          "The original OIDC account binding is unavailable; authorize again.",
        );
        const original = previous.identity;
        check(
          identity.issuer === original.issuer &&
            identity.subject === original.subject &&
            canonicalJson(identity.audience) ===
              canonicalJson(original.audience) &&
            (identity.nonce === undefined || identity.nonce === original.nonce),
          "oauth_identity_mismatch",
          "Token refresh cannot replace the originally authorized OIDC account or nonce binding.",
        );
        if (identity.nonce === undefined && typeof original.nonce === "string")
          identity.nonce = original.nonce;
      }
    } else {
      check(
        refreshing || config.flow === "clientCredentials",
        "oauth_invalid_identity",
        "OIDC authorization requires a validated identity token.",
      );
      if (isPlainRecord(previous.identity))
        identity = previous.identity as JsonObject;
    }
  }
  return {
    access_token: response.access_token,
    token_type: "Bearer",
    expiresAt:
      response.expires_in === undefined
        ? null
        : Date.now() + response.expires_in * 1000,
    ...(response.refresh_token
      ? { refresh_token: response.refresh_token }
      : typeof previous.refresh_token === "string"
        ? { refresh_token: previous.refresh_token }
        : {}),
    ...(response.scope === undefined ? {} : { scope: response.scope }),
    ...(identity ? { identity } : {}),
  };
}
async function saveTokens(
  provider: OAuthProvider,
  config: OAuthConfig,
  ref: string,
  binding: JsonObject,
  old: JsonObject,
  response: client.TokenEndpointResponse,
  operation: Operation,
  refreshing = false,
): Promise<string> {
  operation.assertCurrent();
  const tokens = tokenRecord(config, response, old, refreshing);
  await state(provider).vault.update(ref, binding, {
    ...old,
    tokens,
    oauthConfigHash: hash(config),
  });
  operation.assertCurrent();
  return ref;
}
function usable(record: JsonObject, config: OAuthConfig): string | null {
  const tokens = isPlainRecord(record.tokens) ? record.tokens : null;
  if (
    !tokens ||
    record.oauthConfigHash !== hash(config) ||
    tokens.token_type !== "Bearer" ||
    typeof tokens.access_token !== "string"
  )
    return null;
  return tokens.expiresAt === null ||
    (typeof tokens.expiresAt === "number" &&
      tokens.expiresAt > Date.now() + 5000)
    ? tokens.access_token
    : null;
}

/** Trusted credential backend only. No token-bearing result is a maintenance/public DTO. */
export class OAuthProvider {
  constructor(vault: OAuthVault, options: OAuthProviderOptions = {}) {
    const limits = {
      timeoutMs: options.timeoutMs ?? 30000,
      maxRequestBytes: options.maxRequestBytes ?? 256 * 1024,
      maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024,
    };
    check(
      Object.values(limits).every(
        (value) =>
          Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
      ),
      "oauth_invalid_limits",
      "OAuth operation budgets must be positive bounded integers.",
    );
    providers.set(this, { vault, limits, refreshing: new Map() });
  }
  async prepareAuth(
    value: OAuthConfig,
    ref: string,
    binding: JsonObject,
    scope: OAuthScope,
  ): Promise<string> {
    const config = fixedConfig(value),
      fixedBinding = copy(binding);
    return run(this, scope, async (operation) => {
      const record = await state(this).vault.read(ref, fixedBinding);
      operation.assertCurrent();
      if (usable(record, config)) return ref;
      if (config.flow !== "clientCredentials") {
        await this.getAccessToken(config, ref, fixedBinding, scope);
        return ref;
      }
      const prepared = await prepare(
        this,
        config,
        ref,
        fixedBinding,
        operation,
      );
      const tokens = await client.clientCredentialsGrant(
        prepared.configuration,
        { scope: config.scopes.join(" ") },
      );
      return saveTokens(
        this,
        config,
        ref,
        fixedBinding,
        prepared.record,
        tokens,
        operation,
      );
    });
  }
  async getAccessToken(
    value: OAuthConfig,
    ref: string,
    binding: JsonObject,
    scope: OAuthScope,
  ): Promise<string> {
    const config = fixedConfig(value),
      fixedBinding = copy(binding);
    return run(this, scope, async (operation) => {
      const record = await state(this).vault.read(ref, fixedBinding);
      operation.assertCurrent();
      const ready = usable(record, config);
      if (ready) return ready;
      check(
        isPlainRecord(record.tokens) && record.oauthConfigHash === hash(config),
        "oauth_authentication_required",
        "Complete the configured OAuth authorization before using this credential.",
      );
      const key = hash({ ref, binding: fixedBinding, config });
      let refreshing = state(this).refreshing.get(key);
      if (!refreshing) {
        refreshing = (async () => {
          const prepared = await prepare(
              this,
              config,
              ref,
              fixedBinding,
              operation,
            ),
            latest = usable(prepared.record, config);
          if (latest) return latest;
          const old = isPlainRecord(prepared.record.tokens)
            ? prepared.record.tokens
            : {};
          let tokens: client.TokenEndpointResponse;
          if (typeof old.refresh_token === "string")
            tokens = await client.refreshTokenGrant(
              prepared.configuration,
              old.refresh_token,
            );
          else {
            check(
              config.flow === "clientCredentials",
              "oauth_reauthentication_required",
              "This OAuth credential requires the user to authorize again.",
            );
            tokens = await client.clientCredentialsGrant(
              prepared.configuration,
              { scope: config.scopes.join(" ") },
            );
          }
          await saveTokens(
            this,
            config,
            ref,
            fixedBinding,
            prepared.record,
            tokens,
            operation,
            true,
          );
          return tokens.access_token;
        })();
        state(this).refreshing.set(key, refreshing);
        void refreshing.then(
          () => {
            if (state(this).refreshing.get(key) === refreshing)
              state(this).refreshing.delete(key);
          },
          () => {
            if (state(this).refreshing.get(key) === refreshing)
              state(this).refreshing.delete(key);
          },
        );
      }
      const token = await refreshing;
      operation.assertCurrent();
      return token;
    });
  }
}

export class OAuthSessionService {
  #provider: OAuthProvider;
  #root: string;
  #reserve?: (bytes: number) => Promise<{ release(): void }>;
  constructor(
    provider: OAuthProvider,
    options: {
      readonly root: string;
      readonly reserve?: (bytes: number) => Promise<{ release(): void }>;
    },
  ) {
    this.#provider = provider;
    this.#root = options.root;
    this.#reserve = options.reserve;
  }
  #parts(state: string): readonly string[] {
    return ["oauth", `${hash(state)}.json`];
  }
  async #exclusive<T>(state: string, action: () => Promise<T>): Promise<T> {
    const key = this.#root + ":" + hash(state);
    check(
      !sessionsBusy.has(key),
      "oauth_session_busy",
      "This OAuth attempt is already being processed.",
    );
    sessionsBusy.add(key);
    try {
      return await action();
    } finally {
      sessionsBusy.delete(key);
    }
  }
  #matches(
    attempt: Attempt,
    config: OAuthConfig,
    ref: string,
    binding: JsonObject,
    scope: MaintenanceOAuthScope,
    scheme: string,
    revision: string,
  ): void {
    check(
      attempt.requestId === scope.requestId &&
        attempt.revision === scope.revision &&
        attempt.candidateRevision === revision &&
        attempt.schemeId === scheme &&
        attempt.credentialRef === ref &&
        attempt.configHash === hash(config) &&
        canonicalJson(attempt.binding) === canonicalJson(binding),
      "oauth_session_mismatch",
      "The OAuth attempt does not belong to this exact pending candidate and credential binding.",
    );
    check(
      attempt.expiresAt > Date.now(),
      "oauth_session_expired",
      "The OAuth authorization attempt expired.",
    );
  }
  async start(
    value: OAuthConfig,
    ref: string,
    binding: JsonObject,
    input: MaintenanceOAuthBinding,
    scope: MaintenanceOAuthScope,
  ): Promise<MaintenanceOAuthLaunch> {
    interactiveIdentity(binding, input.schemeId, scope);
    const config = fixedConfig(value),
      fixedBinding = copy(binding),
      launchBinding = copy(input);
    check(
      config.flow !== "clientCredentials",
      "oauth_interactive_flow_required",
      "Client Credentials must use explicit prepareAuth instead of an interactive authorization launch.",
    );
    check(
      typeof launchBinding.state === "string" &&
        launchBinding.state.length > 0 &&
        launchBinding.state.length <= 4096 &&
        typeof launchBinding.schemeId === "string" &&
        launchBinding.schemeId.length > 0,
      "oauth_invalid_binding",
      "An OAuth attempt needs its trusted state and source scheme.",
    );
    let callback: URL;
    try {
      callback = new URL(launchBinding.callbackUrl);
    } catch {
      throw fail(
        "oauth_invalid_binding",
        "The trusted OAuth callback must be an absolute URL.",
      );
    }
    check(
      callback.protocol === "https:" ||
        (callback.protocol === "http:" && config.allowHttp === true),
      "oauth_invalid_binding",
      "The OAuth callback must use its explicitly configured HTTP(S) transport.",
    );
    check(
      !callback.search &&
        !callback.hash &&
        !callback.username &&
        !callback.password,
      "oauth_invalid_binding",
      "The trusted OAuth callback cannot contain query, fragments or credentials.",
    );
    return this.#exclusive(launchBinding.state, () =>
      run(this.#provider, scope, async (operation) => {
        const existing = (await privateMaintenanceRead(
          this.#root,
          this.#parts(launchBinding.state),
          1024 * 1024,
        )) as Attempt | null;
        operation.assertCurrent();
        if (existing) {
          this.#matches(
            existing,
            config,
            ref,
            fixedBinding,
            scope,
            launchBinding.schemeId,
            launchBinding.candidateRevision,
          );
          check(
            existing.callbackUrl === callback.href &&
              existing.phase === "pending",
            "oauth_session_consumed",
            "This OAuth authorization attempt has already been consumed.",
          );
          return copy(existing.launch) as unknown as MaintenanceOAuthLaunch;
        }
        const prepared = await prepare(
            this.#provider,
            config,
            ref,
            fixedBinding,
            operation,
          ),
          metadata = prepared.configuration.serverMetadata();
        const requireIssuer =
          config.flow === "authorizationCode" &&
          metadata.authorization_response_iss_parameter_supported === true;
        let launch: MaintenanceOAuthLaunch,
          verifier: string | undefined,
          nonce: string | undefined,
          device: JsonObject | undefined;
        if (config.flow === "authorizationCode") {
          check(
            typeof metadata.authorization_endpoint === "string",
            "oauth_endpoint_unavailable",
            "The issuer has no authorization endpoint.",
          );
          authorize(operation, metadata.authorization_endpoint);
          verifier = client.randomPKCECodeVerifier();
          const challenge = await client.calculatePKCECodeChallenge(verifier);
          operation.assertCurrent();
          if (config.oidc) nonce = client.randomNonce();
          const url = client.buildAuthorizationUrl(prepared.configuration, {
            redirect_uri: callback.href,
            scope: config.scopes.join(" "),
            state: launchBinding.state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            ...(nonce ? { nonce } : {}),
          });
          launch = {
            authorizationUrl: url.href,
            issuer: metadata.issuer!,
            requireIssuer,
          };
        } else {
          const response = await client.initiateDeviceAuthorization(
            prepared.configuration,
            { scope: config.scopes.join(" ") },
          );
          operation.assertCurrent();
          endpoint(response.verification_uri, config);
          if (response.verification_uri_complete)
            endpoint(response.verification_uri_complete, config);
          authorize(operation, response.verification_uri);
          if (response.verification_uri_complete)
            authorize(operation, response.verification_uri_complete);
          device = copy(response) as unknown as JsonObject;
          launch = {
            verificationUri:
              response.verification_uri_complete ?? response.verification_uri,
            userCode: response.user_code,
            issuer: metadata.issuer!,
            requireIssuer: false,
          };
        }
        const expiresAt =
          Date.now() +
          Math.min(
            600000,
            device && typeof device.expires_in === "number"
              ? device.expires_in * 1000
              : 600000,
          );
        const attempt: Attempt = {
          state: launchBinding.state,
          requestId: scope.requestId,
          revision: scope.revision,
          candidateRevision: launchBinding.candidateRevision,
          schemeId: launchBinding.schemeId,
          callbackUrl: callback.href,
          credentialRef: ref,
          binding: fixedBinding,
          configHash: prepared.hash,
          issuer: metadata.issuer!,
          requireIssuer,
          expiresAt,
          phase: "pending",
          launch: copy(launch) as unknown as JsonObject,
          ...(verifier ? { verifier } : {}),
          ...(nonce ? { nonce } : {}),
          ...(device ? { device } : {}),
        };
        operation.assertCurrent();
        await privateMaintenanceWrite(
          this.#root,
          this.#parts(launchBinding.state),
          attempt,
          true,
          this.#reserve,
        );
        operation.assertCurrent();
        return launch;
      }),
    );
  }
  async complete(
    value: OAuthConfig,
    ref: string,
    binding: JsonObject,
    input: MaintenanceOAuthComplete,
    scope: MaintenanceOAuthScope,
  ): Promise<string> {
    interactiveIdentity(binding, input.schemeId, scope);
    const config = fixedConfig(value),
      fixedBinding = copy(binding),
      completion = copy(input);
    check(
      typeof completion.callback?.state === "string" &&
        completion.callback.state.length > 0 &&
        completion.callback.state.length <= 4096,
      "oauth_invalid_binding",
      "OAuth completion needs its original state.",
    );
    return this.#exclusive(completion.callback.state, () =>
      run(this.#provider, scope, async (operation) => {
        const attempt = (await privateMaintenanceRead(
          this.#root,
          this.#parts(completion.callback.state),
          1024 * 1024,
        )) as Attempt | null;
        operation.assertCurrent();
        check(
          attempt,
          "oauth_session_unavailable",
          "The OAuth attempt is unavailable; begin a new authorization.",
        );
        this.#matches(
          attempt,
          config,
          ref,
          fixedBinding,
          scope,
          completion.schemeId,
          completion.candidateRevision,
        );
        check(
          attempt.phase === "pending",
          "oauth_session_consumed",
          "The authorization code has already entered an exchange and cannot be replayed.",
        );
        check(
          !completion.callback.error,
          "oauth_access_denied",
          "The OAuth authorization was denied by the provider.",
        );
        check(
          (!attempt.requireIssuer ||
            completion.callback.issuer !== undefined) &&
            (completion.callback.issuer === undefined ||
              completion.callback.issuer === attempt.issuer),
          "oauth_issuer_mismatch",
          "The authorization response issuer does not match the original attempt.",
        );
        const prepared = await prepare(
          this.#provider,
          config,
          ref,
          fixedBinding,
          operation,
        );
        check(
          prepared.configuration.serverMetadata().issuer === attempt.issuer,
          "oauth_issuer_mismatch",
          "The configured OAuth issuer changed during authorization.",
        );
        attempt.phase = "exchanging";
        await privateMaintenanceWrite(
          this.#root,
          this.#parts(attempt.state),
          attempt,
          false,
          this.#reserve,
        );
        operation.assertCurrent();
        let received = false;
        try {
          let response: client.TokenEndpointResponse;
          if (config.flow === "authorizationCode") {
            check(
              typeof completion.callback.code === "string" &&
                completion.callback.code.length > 0 &&
                completion.callback.code.length <= 65536 &&
                typeof attempt.verifier === "string",
              "oauth_invalid_callback",
              "The authorization response has no valid code or PKCE binding.",
            );
            check(
              !config.oidc ||
                (typeof attempt.nonce === "string" && attempt.nonce.length > 0),
              "oauth_invalid_callback",
              "The OIDC attempt has no original nonce binding.",
            );
            const callback = new URL(attempt.callbackUrl);
            callback.searchParams.set("state", attempt.state);
            callback.searchParams.set("code", completion.callback.code);
            if (completion.callback.issuer)
              callback.searchParams.set("iss", completion.callback.issuer);
            response = await client.authorizationCodeGrant(
              prepared.configuration,
              callback,
              {
                expectedState: attempt.state,
                pkceCodeVerifier: attempt.verifier,
                ...(config.oidc
                  ? { expectedNonce: attempt.nonce, idTokenExpected: true }
                  : {}),
              },
            );
          } else {
            check(
              config.flow === "device" && isPlainRecord(attempt.device),
              "oauth_invalid_callback",
              "This OAuth attempt has no device authorization state.",
            );
            response = await client.pollDeviceAuthorizationGrant(
              prepared.configuration,
              attempt.device as unknown as client.DeviceAuthorizationResponse,
              {},
              { signal: operation.signal },
            );
          }
          received = true;
          await saveTokens(
            this.#provider,
            config,
            ref,
            fixedBinding,
            prepared.record,
            response,
            operation,
          );
          attempt.phase = "completed";
          delete attempt.verifier;
          delete attempt.nonce;
          delete attempt.device;
          await privateMaintenanceWrite(
            this.#root,
            this.#parts(attempt.state),
            attempt,
            false,
            this.#reserve,
          );
          operation.assertCurrent();
          return ref;
        } catch (error) {
          if (
            config.flow === "device" &&
            !received &&
            operation.signal.aborted
          ) {
            attempt.phase = "pending";
            await privateMaintenanceWrite(
              this.#root,
              this.#parts(attempt.state),
              attempt,
              false,
              this.#reserve,
            );
          }
          throw error;
        }
      }),
    );
  }
}
