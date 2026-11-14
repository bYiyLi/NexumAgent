import path from "node:path";
import { constants, realpathSync, lstatSync, mkdirSync } from "node:fs";
import { open, rename, rm, writeFile, lstat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { authorizeCall } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord, newId } from "../contracts/json.js";
import type { Binding, JsonObject } from "../contracts/types.js";
import {
  validateMcpConnectionConfig,
  type McpConnectionConfig,
} from "../adapters/mcp.js";
import {
  validateMcpOAuthConfig,
  type McpOAuthProviderFactory,
} from "../adapters/mcp-oauth.js";
import {
  prepareOpenApi,
  type ApprovedOpenApi,
  type OpenApiDocument,
  type OpenApiCredentialProvider,
  type OpenApiCredentialRequest,
  type PreparedOpenApi,
} from "../adapters/openapi.js";
import { parseOpenApi, openApiLimits } from "../adapters/openapi-schema.js";
import {
  CredentialVault,
  privateMaintenanceRead,
  privateMaintenanceWrite,
  type CredentialBinding,
} from "./credentials.js";
import type {
  MaintenanceBackend,
  MaintenanceIntent,
  PreparedMaintenance,
  MaintenanceScope,
  MaintenanceResult,
  MaintenanceDraft,
  MaintenanceDraftInput,
  MaintenanceAuthScheme,
  MaintenanceOAuthScope,
  MaintenanceOAuthBinding,
  MaintenanceOAuthComplete,
  MaintenanceOAuthLaunch,
} from "./requests.js";
import {
  validateOAuthConfig,
  type OAuthConfig,
  type OAuthProvider,
  type OAuthSessionService,
} from "./oauth.js";

type Kind = "mcp" | "api";
type RecordValue = Record<string, any>;
type StoredDocument = { location: string; base64: string; file: string };
interface SecretBinding {
  ref: string;
  binding: CredentialBinding;
}
interface ConfigurationSnapshot {
  agentId: string;
  profile: Binding["profile"];
  kind: Kind;
  name: string;
  owner: string;
  objectId: string;
  baseRevision: string | null;
  config: JsonObject;
  secrets: Record<string, SecretBinding>;
  documents: StoredDocument[];
  source: string | null;
  workRevision: string;
  authStatus: PreparedMaintenance["authStatus"];
  diagnostics: string[];
}
interface ApprovedRecord {
  objectId: string;
  revision: string;
  snapshot: string;
  enabled: boolean;
}
interface PublicFileWrite {
  file: string;
  before: string | null;
  after: string | null;
}
interface PublicWrite extends PublicFileWrite {
  documents: PublicFileWrite[];
}
interface ApprovedState {
  binding: { agentId: string; profile: Binding["profile"] };
  mcp: Record<string, ApprovedRecord>;
  api: Record<string, ApprovedRecord>;
}
export interface ConfigurationActivation {
  /** All asynchronous discovery and validation occurs here, after approval. */
  prepare(
    input: {
      kind: Kind;
      name: string;
      objectId: string;
      revision: string;
      config: JsonObject;
      api?: PreparedOpenApi;
      mcp?: McpConnectionConfig;
      mcpOAuth?: McpOAuthProviderFactory;
    },
    scope: MaintenanceScope,
  ): Promise<{ publish(): void; dispose(): Promise<void> }>;
  /** Remove only this exact published source and join its real resource cleanup. */
  remove(
    input: { kind: Kind; name: string; objectId: string; revision: string },
    scope: MaintenanceScope,
  ): Promise<void>;
}
export interface McpOAuthConfigurationPort {
  start(
    config: JsonObject,
    ref: string,
    binding: CredentialBinding,
    authorization: MaintenanceOAuthBinding,
    scope: MaintenanceOAuthScope,
  ): Promise<MaintenanceOAuthLaunch>;
  complete(
    config: JsonObject,
    ref: string,
    binding: CredentialBinding,
    input: MaintenanceOAuthComplete,
    scope: MaintenanceOAuthScope,
  ): Promise<string>;
  /** Returns only the official SDK's trusted OAuthClientProvider, never public config. */
  provider(
    config: JsonObject,
    ref: string,
    binding: CredentialBinding,
    scope: MaintenanceScope,
  ): Promise<McpOAuthProviderFactory>;
  ready(
    config: JsonObject,
    ref: string,
    binding: CredentialBinding,
    scope: MaintenanceScope,
  ): Promise<boolean>;
}
export interface ConfigurationMaintenanceOptions extends Pick<
  Binding,
  "agentId" | "profile"
> {
  root: string;
  activation: ConfigurationActivation;
  credentials: CredentialVault;
  /** Derive current Run authority from the adapter's trusted invocation, never the old approval request. */
  runtimeScope(request: OpenApiCredentialRequest): MaintenanceScope;
  oauth?: OAuthProvider;
  oauthSessions?: OAuthSessionService;
  mcpOAuth?: McpOAuthConfigurationPort;
  maxSourceBytes?: number;
  maxTotalSourceBytes?: number;
  maxReferences?: number;
  sourceTimeoutMs?: number;
  /** Trusted Core storage admission for private plans and approved fixed configuration. */
  reserve?: (bytes: number) => Promise<{ release(): void }>;
}
const json = <T>(value: T, cap = 64 * 1024 * 1024): T =>
  JSON.parse(canonicalJson(value, cap)) as T;
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalJson(value, 64 * 1024 * 1024))
    .digest("hex");
const object = (value: unknown): value is RecordValue => isPlainRecord(value);
const entry = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;
const put = <T>(map: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(map, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};
const nonempty = (value: unknown, max = 8192): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= max &&
  !/[\0\r\n]/.test(value);
const credentialRef = (value: unknown): value is string =>
  typeof value === "string" && /^cred_[a-f0-9]{48}$/.test(value);
function name(value: string): void {
  requireCondition(
    /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/.test(value),
    "invalid_maintenance_name",
    "Use one configuration namespace.",
  );
}
/** Portable on case-insensitive filesystems; public config retains the exact logical name. */
export function configurationDirectoryName(namespace: string): string {
  name(namespace);
  return /[A-Z]/.test(namespace) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(namespace)
    ? "~" + createHash("sha256").update(namespace, "utf8").digest("hex")
    : namespace;
}
function current(scope: MaintenanceScope): void {
  scope.signal.throwIfAborted();
  authorizeCall(() => scope.assertCurrent());
}
function access(
  scope: MaintenanceScope,
  type: "url" | "path",
  value: string,
): void {
  current(scope);
  authorizeCall(() => scope.authorize({ type, value, access: "read" }));
}
function publicFile(root: string, parts: readonly string[]): string {
  requireCondition(
    parts.every(
      (part) =>
        /^[A-Za-z0-9_$~.-]+$/.test(part) && part !== "." && part !== "..",
    ),
    "configuration_path_invalid",
    "Use fixed configuration path segments.",
  );
  let directory = path.join(root, "work");
  requireCondition(
    realpathSync.native(directory) === directory &&
      !lstatSync(directory).isSymbolicLink(),
    "configuration_path_invalid",
    "The Agent work directory cannot redirect.",
  );
  for (const part of parts.slice(0, -1)) {
    const next = path.join(directory, part),
      existing = lstatSync(next, { throwIfNoEntry: false });
    requireCondition(
      !existing || existing.isDirectory(),
      "configuration_path_invalid",
      "Configuration directories cannot be linked or special files.",
    );
    if (!existing) mkdirSync(next, { mode: 0o700 });
    requireCondition(
      realpathSync.native(next) === next,
      "configuration_path_invalid",
      "Configuration directories cannot redirect.",
    );
    directory = next;
  }
  return path.join(directory, parts.at(-1)!);
}
async function readPublic(
  filename: string,
  max = 4 * 1024 * 1024,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AgentError(
      "configuration_path_invalid",
      "The configuration file could not be opened safely.",
    );
  }
  try {
    const before = await handle.stat();
    requireCondition(
      before.isFile() && before.nlink === 1 && before.size <= max,
      "configuration_path_invalid",
      "Configuration files must be bounded regular files without hard links.",
    );
    const chunks: Buffer[] = [];
    let count = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, max - count + 1)),
        read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
      requireCondition(
        count <= max,
        "configuration_too_large",
        "Configuration data exceeds its budget.",
      );
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(),
      linked = await lstat(filename);
    requireCondition(
      linked.isFile() &&
        linked.nlink === 1 &&
        linked.ino === after.ino &&
        linked.dev === after.dev &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      "configuration_file_changed",
      "The configuration file changed while being read.",
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, count),
    );
  } finally {
    await handle.close();
  }
}
async function replacePublic(filename: string, text: string): Promise<void> {
  await readPublic(filename, 64 * 1024 * 1024);
  const parent = path.dirname(filename);
  requireCondition(
    realpathSync.native(parent) === parent,
    "configuration_path_invalid",
    "Configuration parent cannot redirect.",
  );
  const temporary = path.join(
    parent,
    `.configuration-${randomBytes(24).toString("hex")}`,
  );
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    requireCondition(
      realpathSync.native(parent) === parent,
      "configuration_path_invalid",
      "Configuration parent changed while saving.",
    );
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Fixed approved snapshots own activation. work files are editable proposals, never approval records. */
export class ConfigurationMaintenanceBackend implements MaintenanceBackend {
  #state: ApprovedState;
  private constructor(readonly options: ConfigurationMaintenanceOptions) {
    this.#state = {
      binding: { agentId: options.agentId, profile: options.profile },
      mcp: {},
      api: {},
    };
  }
  static async open(
    options: ConfigurationMaintenanceOptions,
  ): Promise<ConfigurationMaintenanceBackend> {
    const root = realpathSync.native(options.root);
    requireCondition(
      root === options.root && options.credentials.root === root,
      "configuration_profile_mismatch",
      "Configuration and credential stores require the same established profile root.",
    );
    const value = new ConfigurationMaintenanceBackend({ ...options, root }),
      saved = await privateMaintenanceRead(root, [
        "configurations",
        "approved.json",
      ]);
    if (saved) {
      requireCondition(
        object(saved.mcp) &&
          object(saved.api) &&
          object(saved.binding) &&
          hash(saved.binding) === hash(value.#state.binding),
        "configuration_state_invalid",
        "The approved configuration state is invalid.",
      );
      value.#state = json(saved) as unknown as ApprovedState;
    }
    return value;
  }
  #kind(intent: MaintenanceIntent): Kind {
    requireCondition(
      intent.target === "api" || intent.target === "mcp",
      "maintenance_target_invalid",
      "This backend only owns MCP/API configurations.",
    );
    name(intent.name);
    return intent.target;
  }
  #binding(
    snapshot: Pick<
      ConfigurationSnapshot,
      "kind" | "name" | "owner" | "config" | "source"
    >,
    scheme: string,
    definition: unknown,
  ): CredentialBinding {
    const config = snapshot.config as RecordValue;
    return {
      owner: snapshot.owner,
      agentId: this.options.agentId,
      profile: this.options.profile,
      target: snapshot.kind,
      name: snapshot.name,
      scheme,
      service:
        snapshot.kind === "api"
          ? scheme === "source"
            ? snapshot.source
            : (config.serviceUrl ?? null)
          : (config.url ?? config.command ?? null),
      authRevision: hash(definition),
    };
  }
  #publicLocation(kind: Kind, namespace: string): string {
    return kind === "mcp"
      ? publicFile(this.options.root, ["mcp.json"])
      : publicFile(this.options.root, [
          "api",
          configurationDirectoryName(namespace),
          "config.json",
        ]);
  }
  async #workRevision(kind: Kind, namespace: string): Promise<string> {
    const file = this.#publicLocation(kind, namespace),
      text = await readPublic(file);
    if (kind === "api") return hash(text);
    const root = text === null ? { mcpServers: {} } : JSON.parse(text);
    requireCondition(
      object(root) &&
        Object.keys(root).every((key) => key === "mcpServers") &&
        object(root.mcpServers),
      "invalid_mcp_config",
      "work/mcp.json must contain one mcpServers dictionary.",
    );
    return hash(entry(root.mcpServers, namespace) ?? null);
  }
  async #save(snapshot: ConfigurationSnapshot): Promise<PreparedMaintenance> {
    const fixed = json(snapshot),
      id = hash(fixed),
      file = ["configurations", "candidates", `${id}.json`];
    const existing = await privateMaintenanceRead(this.options.root, file);
    if (existing)
      requireCondition(
        hash(existing) === id,
        "configuration_candidate_invalid",
        "A configuration candidate identity has conflicting data.",
      );
    else
      await privateMaintenanceWrite(
        this.options.root,
        file,
        fixed as unknown as JsonObject,
        true,
        this.options.reserve,
      );
    return {
      objectId: fixed.baseRevision === null ? null : fixed.objectId,
      baseRevision: fixed.baseRevision,
      payload: { configurationId: id },
      authStatus: fixed.authStatus,
      summary: {
        changeKinds: [
          fixed.kind === "mcp" ? "connection" : "api",
          "configuration",
          "authentication",
          "docs",
          "capability",
        ],
        permissions: [fixed.kind === "mcp" ? "mcp.use" : "api.use"],
        version: null,
        namespace: fixed.name,
        restartMayBeRequired: false,
      },
    };
  }
  async #load(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<ConfigurationSnapshot> {
    current(scope);
    const id = candidate.payload.configurationId;
    requireCondition(
      typeof id === "string" && /^[a-f0-9]{64}$/.test(id),
      "configuration_candidate_invalid",
      "Use the fixed private configuration candidate.",
    );
    const value = await privateMaintenanceRead(this.options.root, [
      "configurations",
      "candidates",
      `${id}.json`,
    ]);
    requireCondition(
      value &&
        hash(value) === id &&
        value.kind === this.#kind(intent) &&
        value.agentId === this.options.agentId &&
        value.profile === this.options.profile &&
        value.name === intent.name &&
        value.owner === scope.caller.principalId &&
        value.baseRevision === candidate.baseRevision,
      "configuration_candidate_invalid",
      "The configuration candidate is missing or belongs to another target.",
    );
    return json(value) as unknown as ConfigurationSnapshot;
  }
  async #approved(): Promise<ApprovedState> {
    const state = await privateMaintenanceRead(this.options.root, [
      "configurations",
      "approved.json",
    ]);
    if (state) {
      requireCondition(
        object(state.mcp) &&
          object(state.api) &&
          object(state.binding) &&
          hash(state.binding) === hash(this.#state.binding),
        "configuration_state_invalid",
        "Approved configuration state is invalid.",
      );
      this.#state = json(state) as unknown as ApprovedState;
    }
    return json(this.#state);
  }
  async #previous(
    record: ApprovedRecord | undefined,
  ): Promise<ConfigurationSnapshot | null> {
    if (!record) return null;
    const value = await privateMaintenanceRead(this.options.root, [
      "configurations",
      "candidates",
      `${record.snapshot}.json`,
    ]);
    requireCondition(
      value &&
        hash(value) === record.snapshot &&
        value.agentId === this.options.agentId &&
        value.profile === this.options.profile &&
        value.objectId === record.objectId &&
        record.revision ===
          hash({ snapshot: record.snapshot, objectId: record.objectId }),
      "configuration_candidate_unavailable",
      "The approved configuration snapshot is unavailable.",
    );
    return value as unknown as ConfigurationSnapshot;
  }

  async prepare(
    intent: MaintenanceIntent,
    scope: MaintenanceScope,
  ): Promise<PreparedMaintenance> {
    const kind = this.#kind(intent);
    current(scope);
    const state = await this.#approved(),
      old = entry(state[kind], intent.name),
      previous = await this.#previous(old);
    requireCondition(
      !previous || previous.owner === scope.caller.principalId,
      "configuration_owner_mismatch",
      "The approved configuration is not available to this owner.",
    );
    requireCondition(
      intent.action === "add" || intent.action === "import" ? !old : !!old,
      "maintenance_precondition_changed",
      old
        ? "The configuration already exists; use update."
        : "The configuration does not exist.",
    );
    const snapshot: ConfigurationSnapshot = {
      agentId: this.options.agentId,
      profile: this.options.profile,
      kind,
      name: intent.name,
      owner: scope.caller.principalId,
      objectId: old?.objectId ?? newId(kind),
      baseRevision: old?.revision ?? null,
      config: json(intent.config ?? previous?.config ?? {}),
      secrets: previous ? json(previous.secrets) : {},
      documents: previous ? json(previous.documents) : [],
      source:
        intent.url ??
        (intent.path
          ? pathToFileURL(intent.path).href
          : (previous?.source ?? null)),
      workRevision: await this.#workRevision(kind, intent.name),
      authStatus: "not_required",
      diagnostics: [],
    };
    if (intent.action === "remove") return this.#save(snapshot);
    await this.#normalize(snapshot, scope, previous);
    await this.#isolate(snapshot);
    if (
      kind === "api" &&
      (intent.url || intent.path || !snapshot.documents.length)
    )
      await this.#readSources(snapshot, scope);
    await this.#validate(snapshot, scope);
    return this.#save(snapshot);
  }
  async #isolate(snapshot: ConfigurationSnapshot): Promise<void> {
    const config = snapshot.config as RecordValue;
    for (const [key, secret] of Object.entries(snapshot.secrets)) {
      const value = await this.options.credentials.read(
        secret.ref,
        secret.binding,
      );
      secret.ref = await this.options.credentials.create(secret.binding, value);
      if (snapshot.kind === "api" && key !== "source")
        put(config.authentication.credentialBindings, key, secret.ref);
      if (snapshot.kind === "mcp" && key !== "oauth")
        put(config.credentialBindings, key, secret.ref);
      if (key === "source" && object(config.sourceAuthentication?.headers))
        for (const header of Object.keys(config.sourceAuthentication.headers))
          config.sourceAuthentication.headers[header] = secret.ref;
    }
  }
  async #normalize(
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
    previous: ConfigurationSnapshot | null,
  ): Promise<void> {
    const config = snapshot.config as RecordValue;
    requireCondition(
      object(config),
      "invalid_maintenance_config",
      "Use one configuration object.",
    );
    if (snapshot.kind === "mcp") {
      requireCondition(
        Object.keys(config).every((key) =>
          [
            "transport",
            "command",
            "args",
            "cwd",
            "env",
            "url",
            "headers",
            "credentialBindings",
            "oauth",
          ].includes(key),
        ),
        "invalid_mcp_config",
        "Unsupported MCP configuration option.",
      );
      const secrets: Record<string, SecretBinding> = Object.create(null),
        bindings = object(config.credentialBindings)
          ? config.credentialBindings
          : {};
      for (const group of ["env", "headers"] as const) {
        if (config[group] !== undefined)
          requireCondition(
            object(config[group]),
            "invalid_mcp_config",
            "MCP environment and headers must be dictionaries.",
          );
        for (const [key, value] of Object.entries(config[group] ?? {})) {
          requireCondition(
            nonempty(key, 256) &&
              typeof value === "string" &&
              Buffer.byteLength(value) <= 65536,
            "invalid_mcp_config",
            "MCP environment/header values must be bounded strings.",
          );
          const id = `${group}.${key}`,
            binding = this.#binding(snapshot, id, { group, key });
          secrets[id] = {
            ref: await this.options.credentials.create(binding, { value }),
            binding,
          };
        }
        delete config[group];
      }
      for (const [key, value] of Object.entries(bindings)) {
        requireCondition(
          /^(?:env|headers)\.[^\0\r\n]{1,256}$/.test(key) &&
            credentialRef(value),
          "invalid_mcp_config",
          "MCP credentialBindings need declared env/header references.",
        );
        if (secrets[key]) continue;
        const old = previous?.secrets[key],
          binding = this.#binding(snapshot, key, {
            group: key.split(".")[0],
            key: key.slice(key.indexOf(".") + 1),
          });
        const secret = await this.options.credentials.read(
          value,
          old?.ref === value ? old.binding : binding,
        );
        secrets[key] = {
          ref:
            old && hash(old.binding) === hash(binding)
              ? value
              : await this.options.credentials.create(binding, secret),
          binding,
        };
      }
      if (config.oauth !== undefined) {
        requireCondition(
          object(config.oauth) && config.transport === "streamable-http",
          "invalid_mcp_config",
          "MCP OAuth requires a remote HTTP connection configuration.",
        );
        config.oauth = validateMcpOAuthConfig(config.oauth);
        const binding = this.#binding(snapshot, "oauth", config.oauth),
          old = previous?.secrets.oauth;
        let values: JsonObject = old
          ? await this.options.credentials.read(old.ref, old.binding)
          : {};
        secrets.oauth = {
          ref:
            old && hash(old.binding) === hash(binding)
              ? old.ref
              : await this.options.credentials.create(binding, values),
          binding,
        };
      }
      snapshot.secrets = secrets;
      config.credentialBindings = Object.fromEntries(
        Object.entries(secrets)
          .filter(([key]) => key !== "oauth")
          .map(([key, value]) => [key, value.ref]),
      );
      const resolved = await this.#mcp(snapshot, scope);
      validateMcpConnectionConfig(resolved);
    } else {
      requireCondition(
        Object.keys(config).every((key) =>
          [
            "serviceUrl",
            "authentication",
            "oauth",
            "sourceAuthentication",
            "identity",
            "specification",
          ].includes(key),
        ),
        "invalid_api_config",
        "Unsupported API configuration option.",
      );
      if (config.identity !== undefined) {
        requireCondition(
          object(config.identity) &&
            hash(config.identity) ===
              hash({
                name: snapshot.name,
                directory: configurationDirectoryName(snapshot.name),
              }),
          "configuration_target_fixed",
          "Public configuration identity cannot change its logical namespace or directory.",
        );
        delete config.identity;
      }
      if (config.specification !== undefined) {
        requireCondition(
          snapshot.documents.length > 0 &&
            hash(config.specification) === hash(this.#sourceIndex(snapshot)),
          "configuration_source_conflict",
          "Change specification sources through an explicit URL/path maintenance update.",
        );
        delete config.specification;
      }
      requireCondition(
        config.serviceUrl === undefined || nonempty(config.serviceUrl),
        "invalid_api_config",
        "Use one API service base URL.",
      );
      for (const key of ["authentication", "oauth", "sourceAuthentication"])
        if (config[key] !== undefined)
          requireCondition(
            object(config[key]),
            "invalid_api_config",
            "API authentication settings must be objects.",
          );
      config.authentication ??= {};
      config.oauth ??= {};
      requireCondition(
        Object.keys(config.authentication).every((key) =>
          [
            "credentialBindings",
            "operationSelections",
            "supplementalSchemes",
            "supplementalSecurity",
          ].includes(key),
        ),
        "invalid_api_config",
        "Authentication stores only supported non-secret bindings and scheme selections.",
      );
      for (const [key, value] of Object.entries(config.oauth))
        config.oauth[key] = validateOAuthConfig(value as OAuthConfig);
      if (config.sourceAuthentication !== undefined)
        requireCondition(
          Object.keys(config.sourceAuthentication).every(
            (key) => key === "headers",
          ) &&
            object(config.sourceAuthentication.headers) &&
            Object.values(config.sourceAuthentication.headers).every(
              credentialRef,
            ),
          "invalid_api_config",
          "Source authentication only stores protected header references.",
        );
      const bindings = config.authentication.credentialBindings ?? {};
      requireCondition(
        object(bindings),
        "invalid_api_config",
        "API credential bindings must be an object.",
      );
      const retained: Record<string, SecretBinding> = Object.create(null);
      for (const [scheme, ref] of Object.entries(bindings)) {
        requireCondition(
          credentialRef(ref),
          "credential_reference_invalid",
          "API authentication only stores protected credential references.",
        );
        const old = previous?.secrets[scheme];
        requireCondition(
          old && old.ref === ref,
          "credential_binding_mismatch",
          "An API reference must belong to this approved target; configure new secrets in its authorization page.",
        );
        retained[scheme] = old;
      }
      if (previous?.secrets.source) {
        const previousService = previous.secrets.source.binding.service;
        const previousOrigin =
          typeof previousService === "string" &&
          /^https?:/.test(previousService)
            ? new URL(previousService).origin
            : null;
        const nextOrigin =
          snapshot.source && /^https?:/.test(snapshot.source)
            ? new URL(snapshot.source).origin
            : null;
        if (previousOrigin !== null && previousOrigin === nextOrigin)
          retained.source = previous.secrets.source;
        else delete config.sourceAuthentication;
      }
      snapshot.secrets = retained;
    }
    current(scope);
  }
  async #mcp(
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
  ): Promise<McpConnectionConfig> {
    const value = json(snapshot.config) as RecordValue;
    delete value.credentialBindings;
    delete value.oauth;
    value.name = snapshot.name;
    for (const [key, reference] of Object.entries(snapshot.secrets)) {
      if (key === "oauth") continue;
      const at = key.indexOf("."),
        group = key.slice(0, at),
        field = key.slice(at + 1);
      requireCondition(
        group === "env" || group === "headers",
        "invalid_mcp_config",
        "Unknown MCP credential destination.",
      );
      const saved = await this.options.credentials.read(
        reference.ref,
        reference.binding,
      );
      requireCondition(
        typeof saved.value === "string",
        "maintenance_auth_required",
        "The MCP credential is not configured.",
      );
      value[group] ??= Object.create(null);
      put(value[group], field, saved.value);
    }
    current(scope);
    return validateMcpConnectionConfig(value);
  }
  #documents(snapshot: ConfigurationSnapshot): {
    document: OpenApiDocument;
    references: OpenApiDocument[];
  } {
    requireCondition(
      snapshot.documents.length > 0,
      "configuration_source_unavailable",
      "The fixed API specification is unavailable.",
    );
    const docs = snapshot.documents.map((item) => ({
      location: item.location,
      bytes: Buffer.from(item.base64, "base64"),
    }));
    return { document: docs[0]!, references: docs.slice(1) };
  }
  async #parse(
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
  ): Promise<Awaited<ReturnType<typeof parseOpenApi>>> {
    current(scope);
    const docs = this.#documents(snapshot);
    return parseOpenApi(
      {
        ...docs,
        name: snapshot.name,
        revision: hash(snapshot.documents),
        serviceUrl:
          (snapshot.config as RecordValue).serviceUrl ?? snapshot.source!,
      },
      openApiLimits({
        documentBytes: this.options.maxSourceBytes ?? 8 * 1024 * 1024,
        totalDocumentBytes:
          this.options.maxTotalSourceBytes ?? 32 * 1024 * 1024,
        referenceCount: this.options.maxReferences ?? 128,
      }),
      scope.signal,
    );
  }
  async #sourceBytes(
    location: string,
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
  ): Promise<{ bytes: Buffer; location: string }> {
    const maximum = this.options.maxSourceBytes ?? 8 * 1024 * 1024;
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      throw new AgentError(
        "configuration_source_invalid",
        "Use an absolute fixed source URL or path.",
      );
    }
    if (url.protocol === "file:") {
      const requested = fileURLToPath(url);
      access(scope, "path", requested);
      const resolved = realpathSync.native(requested);
      access(scope, "path", resolved);
      const body = await readPublic(resolved, maximum);
      requireCondition(
        body !== null,
        "configuration_source_unavailable",
        "The API source file is missing.",
      );
      current(scope);
      return {
        bytes: Buffer.from(body, "utf8"),
        location: pathToFileURL(resolved).href,
      };
    }
    requireCondition(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash,
      "configuration_source_invalid",
      "Use a credential-free HTTP(S) source endpoint.",
    );
    const credentialService = snapshot.secrets.source?.binding.service;
    const credentialOrigin =
        typeof credentialService === "string" &&
        /^https?:/.test(credentialService)
          ? new URL(credentialService).origin
          : null,
      timeout = AbortSignal.timeout(this.options.sourceTimeoutMs ?? 30000),
      signal = AbortSignal.any([scope.signal, timeout]);
    const publicAccept = "application/json, application/yaml, text/yaml, */*";
    const headers = new Headers({ accept: publicAccept });
    const source = snapshot.secrets.source;
    if (source) {
      const values = await this.options.credentials.read(
        source.ref,
        source.binding,
      );
      for (const [key, value] of Object.entries(values))
        if (typeof value === "string") {
          requireCondition(
            /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) &&
              ![
                "host",
                "content-length",
                "connection",
                "transfer-encoding",
                "keep-alive",
                "te",
                "trailer",
                "upgrade",
                "proxy-authorization",
              ].includes(key.toLowerCase()) &&
              !/[\0\r\n]/.test(value),
            "configuration_source_auth_invalid",
            "Source authentication needs safe explicit headers.",
          );
          headers.set(key, value);
        }
    }
    for (let redirect = 0; redirect < 4; redirect++) {
      access(scope, "url", url.href);
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(url, {
          headers:
            url.origin === credentialOrigin
              ? headers
              : new Headers({ accept: publicAccept }),
          redirect: "manual",
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new AgentError(
          "configuration_source_unavailable",
          "The API source endpoint could not be read.",
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get("location");
        await response.body?.cancel();
        requireCondition(
          target !== null && redirect < 3,
          "configuration_source_redirect",
          "The API source returned an unsupported redirect.",
        );
        const next = new URL(target, url);
        requireCondition(
          ["http:", "https:"].includes(next.protocol) &&
            !next.username &&
            !next.password &&
            !next.hash,
          "configuration_source_redirect",
          "The source redirect target is invalid.",
        );
        access(scope, "url", next.href);
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new AgentError(
          "configuration_source_auth_required",
          "The specification endpoint needs source authentication.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AgentError(
          "configuration_source_unavailable",
          "The API source returned an unsuccessful response.",
        );
      }
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        /^\d+$/.test(declared) &&
        Number(declared) > maximum
      ) {
        await response.body?.cancel();
        throw new AgentError(
          "configuration_source_too_large",
          "The API source exceeds its byte budget.",
        );
      }
      const chunks: Uint8Array[] = [];
      let count = 0;
      const reader = response.body?.getReader();
      try {
        if (reader)
          while (true) {
            current(scope);
            const step = await reader.read();
            current(scope);
            if (step.done) break;
            count += step.value.byteLength;
            requireCondition(
              count <= maximum,
              "configuration_source_too_large",
              "The API source exceeds its byte budget.",
            );
            chunks.push(step.value);
          }
      } catch (cause) {
        await reader?.cancel().catch(() => {});
        signal.throwIfAborted();
        if (isAgentError(cause)) throw cause;
        throw new AgentError(
          "configuration_source_unavailable",
          "The API source stream did not complete.",
        );
      } finally {
        reader?.releaseLock();
      }
      current(scope);
      return { bytes: Buffer.concat(chunks, count), location: url.href };
    }
    throw new AgentError(
      "configuration_source_redirect",
      "The API source exceeded its redirect limit.",
    );
  }
  async #readSources(
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
  ): Promise<void> {
    requireCondition(
      snapshot.source !== null,
      "configuration_source_unavailable",
      "API import requires a specification source.",
    );
    const sources: StoredDocument[] = [],
      queued = [snapshot.source],
      seen = new Set<string>();
    let total = 0;
    while (queued.length) {
      const location = queued.shift()!;
      if (seen.has(location)) continue;
      requireCondition(
        seen.size < (this.options.maxReferences ?? 128) + 1,
        "configuration_source_too_large",
        "The API has too many referenced source documents.",
      );
      seen.add(location);
      let source: { bytes: Buffer; location: string };
      try {
        source = await this.#sourceBytes(location, snapshot, scope);
      } catch (cause) {
        if (
          isAgentError(cause) &&
          cause.code === "configuration_source_auth_required" &&
          !sources.length
        ) {
          snapshot.documents = [];
          snapshot.diagnostics = [
            "The specification endpoint needs source authentication.",
          ];
          snapshot.authStatus = "required";
          return;
        }
        throw cause;
      }
      total += source.bytes.byteLength;
      requireCondition(
        total <= (this.options.maxTotalSourceBytes ?? 32 * 1024 * 1024),
        "configuration_source_too_large",
        "API source documents exceed their total byte budget.",
      );
      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
            source.bytes,
          ),
          doc = parseDocument(text, { uniqueKeys: true });
        requireCondition(
          doc.errors.length === 0,
          "configuration_source_invalid",
          "The API source is not valid JSON/YAML.",
        );
        value = doc.toJS({ maxAliasCount: 100 });
        canonicalJson(value, Math.max(source.bytes.byteLength * 4, 65536));
      } catch (cause) {
        if (isAgentError(cause)) throw cause;
        throw new AgentError(
          "configuration_source_invalid",
          "The API source is not valid bounded UTF-8 JSON/YAML.",
        );
      }
      const file =
        sources.length === 0
          ? source.bytes.toString("utf8").trimStart().startsWith("{")
            ? "openapi.json"
            : "openapi.yaml"
          : `refs/ref-${hash(source.location)}.json`;
      sources.push({
        location: source.location,
        base64: source.bytes.toString("base64"),
        file,
      });
      if (source.location !== location) seen.add(source.location);
      const stack = [value];
      let nodes = 0;
      const visited = new Set<object>();
      while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== "object" || visited.has(item)) continue;
        visited.add(item);
        requireCondition(
          ++nodes <= 100000,
          "configuration_source_too_large",
          "The API source has too many nested objects.",
        );
        for (const [key, child] of Object.entries(item)) {
          if (
            key === "$ref" &&
            typeof child === "string" &&
            !child.startsWith("#")
          ) {
            let target: URL;
            try {
              target = new URL(child, source.location);
            } catch {
              throw new AgentError(
                "configuration_source_invalid",
                "An API reference URL is invalid.",
              );
            }
            target.hash = "";
            if (!seen.has(target.href)) queued.push(target.href);
          } else if (child && typeof child === "object") stack.push(child);
        }
      }
    }
    snapshot.documents = sources;
    snapshot.diagnostics = [];
  }
  async #definitions(
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
  ): Promise<{
    definitions: RecordValue;
    parsed: Awaited<ReturnType<typeof parseOpenApi>>;
  }> {
    const parsed = await this.#parse(snapshot, scope),
      document = parsed.document as RecordValue,
      config = snapshot.config as RecordValue;
    const raw =
        parsed.sourceVersion === "2.0"
          ? document.securityDefinitions
          : document.components?.securitySchemes,
      definitions: RecordValue = Object.create(null);
    for (const [key, value] of Object.entries(raw ?? {}))
      definitions[key] = parsed.resolve(value);
    Object.assign(
      definitions,
      config.authentication?.supplementalSchemes ?? {},
    );
    return { definitions, parsed };
  }
  #fields(definition: RecordValue): string[] {
    if (definition.type === "apiKey") return ["value"];
    if (
      definition.type === "basic" ||
      (definition.type === "http" &&
        definition.scheme?.toLowerCase() === "basic")
    )
      return ["username", "password"];
    if (
      definition.type === "http" &&
      definition.scheme?.toLowerCase() === "bearer"
    )
      return ["token"];
    if (definition.type === "mutualTLS") return ["cert", "key", "ca"];
    if (definition.type === "oauth2" || definition.type === "openIdConnect")
      return ["clientSecret"];
    throw new AgentError(
      "api_unsupported_authentication",
      "The authentication scheme needs an implemented credential provider.",
    );
  }
  async #apiInput(
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
    placeholder: boolean,
  ): Promise<ApprovedOpenApi> {
    const { definitions, parsed } = await this.#definitions(snapshot, scope),
      config = snapshot.config as RecordValue,
      docs = this.#documents(snapshot),
      authentication = json(config.authentication ?? {}) as RecordValue;
    authentication.credentialBindings = {};
    for (const [key] of Object.entries(definitions)) {
      const secret = snapshot.secrets[key];
      if (secret) put(authentication.credentialBindings, key, secret.ref);
      else if (placeholder)
        put(authentication.credentialBindings, key, `unconfigured_${key}`);
    }
    if (!config.serviceUrl) {
      const document = parsed.document as RecordValue;
      let service =
        parsed.sourceVersion === "2.0" && document.host
          ? `${document.schemes?.[0] ?? "https"}://${document.host}${document.basePath ?? ""}`
          : document.servers?.[0]?.url;
      if (service && snapshot.source)
        service = new URL(service, snapshot.source).href;
      requireCondition(
        nonempty(service),
        "api_service_required",
        "Set the API serviceUrl before confirmation.",
      );
      config.serviceUrl = service;
    }
    return {
      name: snapshot.name,
      revision: hash(snapshot),
      ...docs,
      serviceUrl: config.serviceUrl,
      authentication,
    };
  }
  async #validate(
    snapshot: ConfigurationSnapshot,
    scope: MaintenanceScope,
  ): Promise<void> {
    if (snapshot.kind === "mcp") {
      await this.#mcp(snapshot, scope);
      const config = snapshot.config as RecordValue,
        secret = snapshot.secrets.oauth;
      snapshot.authStatus = config.oauth
        ? secret &&
          this.options.mcpOAuth &&
          (await this.options.mcpOAuth.ready(
            config.oauth,
            secret.ref,
            secret.binding,
            scope,
          ))
          ? "ready"
          : "required"
        : Object.keys(snapshot.secrets).length
          ? "ready"
          : "not_required";
      return;
    }
    if (!snapshot.documents.length) {
      snapshot.authStatus = "required";
      return;
    }
    const { definitions, parsed } = await this.#definitions(snapshot, scope),
      config = snapshot.config as RecordValue;
    for (const [key, definition] of Object.entries(definitions)) {
      const prior = snapshot.secrets[key],
        binding = this.#binding(snapshot, key, {
          definition,
          oauth: config.oauth?.[key] ?? null,
        });
      if (prior && hash(prior.binding) !== hash(binding)) {
        const value = await this.options.credentials.read(
          prior.ref,
          prior.binding,
        );
        snapshot.secrets[key] = {
          ref: await this.options.credentials.create(binding, value),
          binding,
        };
      }
      if (
        !prior &&
        object(config.oauth?.[key]) &&
        ["oauth2", "openIdConnect"].includes(definition.type)
      )
        snapshot.secrets[key] = {
          ref: await this.options.credentials.create(binding, {}),
          binding,
        };
      config.authentication ??= {};
      config.authentication.credentialBindings ??= {};
      if (snapshot.secrets[key])
        put(
          config.authentication.credentialBindings,
          key,
          snapshot.secrets[key]!.ref,
        );
    }
    requireCondition(
      Object.keys(config.oauth ?? {}).every(
        (key) =>
          Object.hasOwn(definitions, key) &&
          ["oauth2", "openIdConnect"].includes(definitions[key].type),
      ),
      "invalid_api_config",
      "OAuth settings must name declared OAuth/OIDC security schemes.",
    );
    await prepareOpenApi(await this.#apiInput(snapshot, scope, true), {
      signal: scope.signal,
      credentials: this.#runtimeCredentials(snapshot).provider,
    });
    const ready = new Set<string>();
    for (const [key, definition] of Object.entries(definitions)) {
      const secret = snapshot.secrets[key];
      if (!secret) continue;
      const value = await this.options.credentials.read(
          secret.ref,
          secret.binding,
        ),
        fields = this.#fields(definition);
      if (definition.type === "oauth2" || definition.type === "openIdConnect") {
        if (
          object(value.tokens) &&
          typeof (value.tokens as RecordValue).access_token === "string" &&
          (value.tokens as RecordValue).token_type === "Bearer" &&
          value.oauthConfigHash === hash(config.oauth?.[key] ?? null) &&
          ((value.tokens as RecordValue).expiresAt === null ||
            (value.tokens as RecordValue).expiresAt > Date.now() + 5000 ||
            typeof (value.tokens as RecordValue).refresh_token === "string" ||
            config.oauth?.[key]?.flow === "clientCredentials")
        )
          ready.add(key);
      } else if (
        fields
          .filter((field) => field !== "ca")
          .every(
            (field) =>
              typeof value[field] === "string" &&
              (value[field] as string).length > 0,
          )
      )
        ready.add(key);
    }
    let required = false,
      used = false;
    const document = parsed.document as RecordValue;
    for (const [pathname, item] of Object.entries(document.paths ?? {}))
      for (const [method, operation] of Object.entries(item as RecordValue))
        if (
          [
            "get",
            "post",
            "put",
            "patch",
            "delete",
            "options",
            "head",
            "trace",
          ].includes(method) &&
          object(operation)
        ) {
          const alternatives =
              operation.security ??
              config.authentication.supplementalSecurity ??
              document.security ??
              [],
            operationName =
              operation.operationId ?? `${method.toUpperCase()} ${pathname}`,
            selection =
              config.authentication.operationSelections?.[operationName],
            options =
              selection === undefined
                ? alternatives
                : [alternatives[selection]];
          used ||= alternatives.some(
            (alternative: RecordValue) => Object.keys(alternative).length > 0,
          );
          if (
            alternatives.length &&
            !options.some(
              (alternative: RecordValue) =>
                object(alternative) &&
                Object.entries(alternative).every(
                  ([key, scopes]) =>
                    ready.has(key) &&
                    (!object(config.oauth?.[key]) ||
                      (Array.isArray(scopes) &&
                        scopes.every((scope: string) =>
                          config.oauth[key].scopes.includes(scope),
                        ))),
                ),
            )
          )
            required = true;
        }
    snapshot.authStatus = required
      ? "required"
      : used
        ? "ready"
        : "not_required";
  }
  async readDraft(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceDraft> {
    const snapshot = await this.#load(intent, candidate, scope),
      state = await this.#approved(),
      previous = await this.#previous(
        entry(state[snapshot.kind], snapshot.name),
      );
    const authentication: MaintenanceAuthScheme[] = [],
      security: string[][] = [];
    if (snapshot.kind === "mcp") {
      for (const [key, reference] of Object.entries(snapshot.secrets))
        if (key !== "oauth")
          authentication.push({
            id: key,
            type: key.startsWith("env.") ? "environment" : "header",
            oauth: false,
            fields: [
              { key, label: key, configured: !!reference, required: true },
            ],
          });
      if ((snapshot.config as RecordValue).oauth) {
        const values = snapshot.secrets.oauth
          ? await this.options.credentials.read(
              snapshot.secrets.oauth.ref,
              snapshot.secrets.oauth.binding,
            )
          : {};
        authentication.push({
          id: "oauth",
          type: "oauth2",
          oauth: true,
          flow:
            ((snapshot.config as RecordValue).oauth as RecordValue).flow ??
            "authorizationCode",
          fields: [
            {
              key: "oauth.clientSecret",
              label: "Client secret",
              configured: typeof values.clientSecret === "string",
              required: false,
            },
          ],
        });
      }
    } else {
      if (snapshot.documents.length) {
        const { definitions, parsed } = await this.#definitions(
          snapshot,
          scope,
        );
        for (const [id, definition] of Object.entries(definitions)) {
          const secret = snapshot.secrets[id],
            values = secret
              ? await this.options.credentials.read(secret.ref, secret.binding)
              : {};
          authentication.push({
            id,
            type:
              definition.type === "http" ? definition.scheme : definition.type,
            ...(typeof definition.in === "string"
              ? { location: definition.in }
              : {}),
            ...(typeof definition.name === "string"
              ? { name: definition.name }
              : {}),
            oauth: ["oauth2", "openIdConnect"].includes(definition.type),
            ...((snapshot.config as RecordValue).oauth?.[id]?.flow
              ? { flow: (snapshot.config as RecordValue).oauth[id].flow }
              : {}),
            fields: this.#fields(definition).map((field) => ({
              key: `${id}.${field}`,
              label: field,
              configured: typeof values[field] === "string" && !!values[field],
              required: !["ca", "clientSecret"].includes(field),
            })),
          });
        }
        for (const requirement of (parsed.document as RecordValue).security ??
          [])
          security.push(Object.keys(requirement));
      }
      if (
        !snapshot.documents.length ||
        snapshot.secrets.source ||
        (snapshot.config as RecordValue).sourceAuthentication
      ) {
        const values = snapshot.secrets.source
            ? await this.options.credentials.read(
                snapshot.secrets.source.ref,
                snapshot.secrets.source.binding,
              )
            : {},
          fields = new Set([
            "Authorization",
            ...Object.keys(values),
            ...Object.keys(
              (snapshot.config as RecordValue).sourceAuthentication?.headers ??
                {},
            ),
          ]);
        authentication.push({
          id: "source",
          type: "sourceHeaders",
          oauth: false,
          fields: [...fields].map((field) => ({
            key: `source.${field}`,
            label: `Source ${field}`,
            configured: typeof values[field] === "string" && !!values[field],
            required: !snapshot.documents.length,
          })),
        });
      }
    }
    current(scope);
    return {
      config: json(snapshot.config),
      ...(previous ? { currentConfig: json(previous.config) } : {}),
      authentication,
      security,
      diagnostics: [...snapshot.diagnostics],
    };
  }
  async prepareDraft(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    input: MaintenanceDraftInput,
    scope: MaintenanceScope,
  ): Promise<PreparedMaintenance> {
    const original = await this.#load(intent, candidate, scope),
      snapshot = json(original);
    snapshot.config = json(input.config ?? snapshot.config);
    snapshot.diagnostics = [];
    if (intent.action === "remove") {
      requireCondition(
        input.config === undefined && !input.credentials?.length,
        "maintenance_target_fixed",
        "Deletion only confirms the fixed target; it cannot edit configuration.",
      );
      return candidate;
    }
    await this.#normalize(snapshot, scope, original);
    await this.#isolate(snapshot);
    const definitions =
      snapshot.kind === "api" && snapshot.documents.length
        ? (await this.#definitions(snapshot, scope)).definitions
        : {};
    const edits = new Map<string, RecordValue>();
    for (const change of input.credentials ?? []) {
      requireCondition(
        nonempty(change.key, 1024) &&
          ["keep", "replace", "clear"].includes(change.operation),
        "credential_change_invalid",
        "Use a declared credential field operation.",
      );
      let scheme: string, field: string;
      if (snapshot.kind === "mcp" && /^(?:env|headers)\./.test(change.key)) {
        scheme = change.key;
        field = "value";
      } else {
        const at = change.key.lastIndexOf(".");
        requireCondition(
          at > 0,
          "credential_change_invalid",
          "Credential changes need a scheme and field.",
        );
        scheme = change.key.slice(0, at);
        field = change.key.slice(at + 1);
      }
      const definition = definitions[scheme];
      requireCondition(
        snapshot.kind === "mcp"
          ? scheme === "oauth"
            ? field === "clientSecret"
            : /^(?:env|headers)\.[^\0\r\n]{1,256}$/.test(scheme)
          : scheme === "source"
            ? /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(field)
            : object(definition) && this.#fields(definition).includes(field),
        "credential_change_invalid",
        "The credential field is not part of this target's authentication.",
      );
      requireCondition(
        change.operation === "replace"
          ? typeof change.value === "string" &&
              change.value.length > 0 &&
              Buffer.byteLength(change.value) <= 1024 * 1024
          : change.value === undefined,
        "credential_change_invalid",
        "A replacement needs one bounded secret; keep/clear do not accept values.",
      );
      let value = edits.get(scheme);
      if (!value) {
        const old = snapshot.secrets[scheme];
        value = old
          ? await this.options.credentials.read(old.ref, old.binding)
          : {};
        edits.set(scheme, value);
      }
      if (change.operation === "keep")
        requireCondition(
          typeof value[field] === "string",
          "credential_change_invalid",
          "There is no configured value to keep.",
        );
      if (change.operation === "replace") put(value, field, change.value);
      if (change.operation === "clear") {
        delete value[field];
      }
    }
    for (const [scheme, value] of edits) {
      const config = snapshot.config as RecordValue,
        definition =
          scheme === "source"
            ? { headers: Object.keys(value) }
            : snapshot.kind === "mcp"
              ? scheme === "oauth"
                ? config.oauth
                : {
                    group: scheme.split(".")[0],
                    key: scheme.slice(scheme.indexOf(".") + 1),
                  }
              : {
                  definition: definitions[scheme],
                  oauth: config.oauth?.[scheme] ?? null,
                },
        binding = this.#binding(snapshot, scheme, definition);
      if (!Object.keys(value).length) delete snapshot.secrets[scheme];
      else
        snapshot.secrets[scheme] = {
          ref: await this.options.credentials.create(binding, value),
          binding,
        };
      if (snapshot.kind === "api" && scheme !== "source") {
        config.authentication ??= {};
        config.authentication.credentialBindings ??= {};
        if (snapshot.secrets[scheme])
          put(
            config.authentication.credentialBindings,
            scheme,
            snapshot.secrets[scheme]!.ref,
          );
        else delete config.authentication.credentialBindings[scheme];
      }
      if (snapshot.kind === "mcp" && scheme !== "oauth") {
        config.credentialBindings ??= {};
        if (snapshot.secrets[scheme])
          put(config.credentialBindings, scheme, snapshot.secrets[scheme]!.ref);
        else delete config.credentialBindings[scheme];
      }
      if (scheme === "source")
        config.sourceAuthentication = {
          headers: Object.fromEntries(
            Object.keys(value).map((key) => [
              key,
              snapshot.secrets.source!.ref,
            ]),
          ),
        };
    }
    if (snapshot.kind === "api" && !snapshot.documents.length)
      await this.#readSources(snapshot, scope);
    await this.#validate(snapshot, scope);
    if (snapshot.kind === "api" && this.options.oauth)
      for (const [scheme, raw] of Object.entries(
        (snapshot.config as RecordValue).oauth ?? {},
      )) {
        const config = raw as OAuthConfig,
          secret = snapshot.secrets[scheme];
        if (config.flow === "clientCredentials" && secret) {
          await this.options.oauth.prepareAuth(
            config,
            secret.ref,
            secret.binding,
            scope,
          );
        }
      }
    await this.#validate(snapshot, scope);
    return this.#save(snapshot);
  }
  async startOAuth(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    binding: MaintenanceOAuthBinding,
    scope: MaintenanceOAuthScope,
  ): Promise<MaintenanceOAuthLaunch> {
    const snapshot = await this.#load(intent, candidate, scope),
      config = snapshot.config as RecordValue,
      scheme = binding.schemeId,
      secret = snapshot.secrets[scheme];
    requireCondition(
      secret,
      "maintenance_auth_required",
      "Save this authentication configuration before beginning OAuth.",
    );
    if (snapshot.kind === "mcp") {
      requireCondition(
        scheme === "oauth" && this.options.mcpOAuth && object(config.oauth),
        "maintenance_oauth_unavailable",
        "The official MCP OAuth provider is unavailable.",
      );
      return this.options.mcpOAuth.start(
        config.oauth,
        secret.ref,
        secret.binding,
        binding,
        scope,
      );
    }
    requireCondition(
      this.options.oauthSessions && object(config.oauth?.[scheme]),
      "maintenance_oauth_unavailable",
      "Configure a supported OAuth flow before beginning authorization.",
    );
    return this.options.oauthSessions.start(
      config.oauth[scheme] as OAuthConfig,
      secret.ref,
      secret.binding,
      binding,
      scope,
    );
  }
  async completeOAuth(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    input: MaintenanceOAuthComplete,
    scope: MaintenanceOAuthScope,
  ): Promise<PreparedMaintenance> {
    const snapshot = await this.#load(intent, candidate, scope),
      scheme = input.schemeId,
      secret = snapshot.secrets[scheme],
      config = snapshot.config as RecordValue;
    requireCondition(
      secret,
      "maintenance_auth_required",
      "The original protected OAuth reference is unavailable.",
    );
    let ref: string;
    if (snapshot.kind === "mcp") {
      requireCondition(
        scheme === "oauth" && this.options.mcpOAuth && object(config.oauth),
        "maintenance_oauth_unavailable",
        "The official MCP OAuth provider is unavailable.",
      );
      ref = await this.options.mcpOAuth.complete(
        config.oauth,
        secret.ref,
        secret.binding,
        input,
        scope,
      );
    } else {
      requireCondition(
        this.options.oauthSessions && object(config.oauth?.[scheme]),
        "maintenance_oauth_unavailable",
        "The OAuth session provider is unavailable.",
      );
      ref = await this.options.oauthSessions.complete(
        config.oauth[scheme] as OAuthConfig,
        secret.ref,
        secret.binding,
        input,
        scope,
      );
    }
    snapshot.secrets[scheme] = { ref, binding: secret.binding };
    await this.#validate(snapshot, scope);
    return this.#save(snapshot);
  }
  async verify(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<void> {
    const snapshot = await this.#load(intent, candidate, scope),
      state = await this.#approved(),
      old = entry(state[snapshot.kind], snapshot.name);
    requireCondition(
      (old?.revision ?? null) === snapshot.baseRevision &&
        (old?.objectId ?? snapshot.objectId) === snapshot.objectId,
      "maintenance_precondition_changed",
      "The approved target changed after this candidate was prepared.",
    );
    requireCondition(
      (await this.#workRevision(snapshot.kind, snapshot.name)) ===
        snapshot.workRevision,
      "maintenance_precondition_changed",
      "The public configuration changed after this candidate was prepared.",
    );
    if (intent.action !== "remove") {
      for (const reference of Object.values(snapshot.secrets))
        await this.options.credentials.read(reference.ref, reference.binding);
      await this.#validate(snapshot, scope);
      requireCondition(
        snapshot.authStatus === candidate.authStatus,
        "maintenance_precondition_changed",
        "The candidate authentication state changed; refresh its exact draft before approval.",
      );
    }
    current(scope);
  }
  async #publicWritePlan(
    snapshot: ConfigurationSnapshot,
    remove = false,
  ): Promise<PublicWrite> {
    const file = this.#publicLocation(snapshot.kind, snapshot.name),
      before = await readPublic(file);
    const plan: PublicWrite = {
      file,
      before,
      after: this.#publicText(snapshot, before, remove),
      documents: [],
    };
    if (snapshot.kind === "mcp" || remove) return plan;
    let previousBytes = 0;
    for (const document of snapshot.documents) {
      const parts = document.file.split("/"),
        target = publicFile(this.options.root, [
          "api",
          configurationDirectoryName(snapshot.name),
          ...parts,
        ]);
      const previous = await readPublic(
        target,
        this.options.maxSourceBytes ?? 8 * 1024 * 1024,
      );
      previousBytes += Buffer.byteLength(previous ?? "");
      requireCondition(
        previousBytes <= (this.options.maxTotalSourceBytes ?? 32 * 1024 * 1024),
        "configuration_source_too_large",
        "Existing public source rollback data exceeds the configured fixed-source budget.",
      );
      plan.documents.push({
        file: target,
        before: previous,
        after: Buffer.from(document.base64, "base64").toString("utf8"),
      });
    }
    return plan;
  }
  async #writePublic(plan: PublicWrite): Promise<PublicWrite> {
    requireCondition(
      (await readPublic(plan.file)) === plan.before,
      "maintenance_precondition_changed",
      "The public configuration changed while managed storage was being reserved.",
    );
    const written: PublicFileWrite[] = [];
    try {
      for (const document of plan.documents) {
        requireCondition(
          (await readPublic(
            document.file,
            this.options.maxSourceBytes ?? 8 * 1024 * 1024,
          )) === document.before,
          "maintenance_precondition_changed",
          "A fixed public source changed while managed storage was being reserved.",
        );
        await replacePublic(document.file, document.after!);
        written.push(document);
      }
      requireCondition(
        (await readPublic(plan.file)) === plan.before,
        "maintenance_precondition_changed",
        "The public configuration changed before its fixed sources were published.",
      );
      if (plan.after === null) {
        if (plan.before !== null) await rm(plan.file);
      } else await replacePublic(plan.file, plan.after);
      return plan;
    } catch (cause) {
      let rollbackFailure: unknown;
      for (const document of written.reverse()) {
        try {
          await this.#restorePublicFile(document);
        } catch (failure) {
          rollbackFailure ??= failure;
        }
      }
      if (rollbackFailure) throw rollbackFailure;
      throw cause;
    }
  }
  /** The exact text used both for capacity admission and public persistence. */
  #publicText(
    snapshot: ConfigurationSnapshot,
    before: string | null,
    remove: boolean,
  ): string | null {
    if (snapshot.kind === "mcp") {
      const root = before === null ? { mcpServers: {} } : JSON.parse(before);
      requireCondition(
        object(root) &&
          object(root.mcpServers) &&
          Object.keys(root).every((key) => key === "mcpServers"),
        "invalid_mcp_config",
        "work/mcp.json needs one mcpServers dictionary.",
      );
      if (remove) delete root.mcpServers[snapshot.name];
      else put(root.mcpServers, snapshot.name, snapshot.config);
      return canonicalJson(root, 4 * 1024 * 1024);
    }
    if (remove) return null;
    return canonicalJson(
      {
        ...snapshot.config,
        identity: {
          name: snapshot.name,
          directory: configurationDirectoryName(snapshot.name),
        },
        specification: this.#sourceIndex(snapshot),
      },
      4 * 1024 * 1024,
    );
  }
  #sourceIndex(snapshot: ConfigurationSnapshot): JsonObject {
    return {
      file: snapshot.documents[0]!.file,
      location: snapshot.documents[0]!.location,
      references: snapshot.documents.slice(1).map((document) => ({
        file: document.file,
        location: document.location,
      })),
    };
  }
  async #restorePublicFile(write: PublicFileWrite): Promise<void> {
    const current = await readPublic(write.file);
    // Preserve concurrent manual edits; their bytes remain an unapproved proposal.
    if (current !== write.after) return;
    if (write.before === null) {
      if (current !== null) await rm(write.file);
    } else await replacePublic(write.file, write.before);
  }
  async #restorePublic(write: PublicWrite): Promise<void> {
    let failure: unknown;
    for (const file of [write, ...[...write.documents].reverse()]) {
      try {
        await this.#restorePublicFile(file);
      } catch (cause) {
        failure ??= cause;
      }
    }
    if (failure) throw failure;
  }
  #runtimeCredentials(snapshot: ConfigurationSnapshot): {
    provider: OpenApiCredentialProvider;
    dispose(): Promise<void>;
  } {
    const config = snapshot.config as RecordValue;
    const dispatchers = new Map<string, import("undici").Agent>();
    const provider: OpenApiCredentialProvider = {
      get: async (request) => {
        request.signal.throwIfAborted();
        const caller = request.context.caller as RecordValue;
        requireCondition(
          object(caller) && caller.principalId === snapshot.owner,
          "credential_binding_mismatch",
          "The API credential is unavailable to this caller.",
        );
        const liveScope = this.options.runtimeScope(request);
        requireCondition(
          liveScope.signal === request.signal &&
            liveScope.caller.principalId === caller.principalId &&
            liveScope.caller.clientId === caller.clientId &&
            liveScope.caller.grantId === caller.grantId,
          "credential_binding_mismatch",
          "Runtime authentication needs the current actual invocation identity.",
        );
        current(liveScope);
        const reference = snapshot.secrets[request.scheme];
        requireCondition(
          reference && reference.ref === request.credentialRef,
          "credential_binding_mismatch",
          "The API credential does not belong to the approved scheme.",
        );
        const value = await this.options.credentials.read(
            reference.ref,
            reference.binding,
          ),
          definition = request.definition as RecordValue;
        current(liveScope);
        if (definition.type === "apiKey") {
          requireCondition(
            typeof value.value === "string" && value.value.length > 0,
            "maintenance_auth_required",
            "The API key is not configured.",
          );
          return { type: "apiKey", value: value.value };
        }
        if (
          definition.type === "basic" ||
          (definition.type === "http" &&
            definition.scheme?.toLowerCase() === "basic")
        ) {
          requireCondition(
            typeof value.username === "string" &&
              typeof value.password === "string" &&
              value.password.length > 0,
            "maintenance_auth_required",
            "Basic authentication is not configured.",
          );
          return {
            type: "basic",
            username: value.username,
            password: value.password,
          };
        }
        if (
          definition.type === "http" &&
          definition.scheme?.toLowerCase() === "bearer"
        ) {
          requireCondition(
            typeof value.token === "string" && value.token.length > 0,
            "maintenance_auth_required",
            "Bearer authentication is not configured.",
          );
          return { type: "bearer", token: value.token };
        }
        if (definition.type === "mutualTLS") {
          requireCondition(
            typeof value.cert === "string" && typeof value.key === "string",
            "maintenance_auth_required",
            "mTLS credentials are not configured.",
          );
          let dispatcher = dispatchers.get(reference.ref);
          if (!dispatcher) {
            const { Agent } = await import("undici");
            current(liveScope);
            dispatcher = dispatchers.get(reference.ref);
            if (!dispatcher) {
              dispatcher = new Agent({
                connect: {
                  cert: value.cert,
                  key: value.key,
                  ...(typeof value.ca === "string" ? { ca: value.ca } : {}),
                },
              });
              dispatchers.set(reference.ref, dispatcher);
            }
          }
          return { type: "mutualTLS", dispatcher };
        }
        requireCondition(
          this.options.oauth && object(config.oauth?.[request.scheme]),
          "maintenance_auth_required",
          "Configure a supported OAuth provider for this scheme.",
        );
        requireCondition(
          request.scopes.every((scope) =>
            config.oauth[request.scheme].scopes.includes(scope),
          ),
          "oauth_insufficient_scope",
          "The approved OAuth configuration does not include this operation's scopes.",
        );
        return {
          type: "bearer",
          token: await this.options.oauth.getAccessToken(
            config.oauth[request.scheme] as OAuthConfig,
            reference.ref,
            reference.binding,
            liveScope,
          ),
        };
      },
    };
    return {
      provider,
      async dispose() {
        await Promise.all(
          [...dispatchers.values()].map((agent) => agent.close()),
        );
        dispatchers.clear();
      },
    };
  }
  async #activate(
    snapshot: ConfigurationSnapshot,
    revision: string,
    scope: MaintenanceScope,
  ): Promise<Awaited<ReturnType<ConfigurationActivation["prepare"]>>> {
    current(scope);
    if (snapshot.kind === "api") {
      const credentials = this.#runtimeCredentials(snapshot);
      const prepared = await prepareOpenApi(
        await this.#apiInput(snapshot, scope, false),
        { credentials: credentials.provider, signal: scope.signal },
      );
      const factory: PreparedOpenApi["factory"] = async (host) => {
        const instance = await prepared.factory(host);
        return {
          ...instance,
          async dispose() {
            try {
              await instance.dispose?.();
            } finally {
              await credentials.dispose();
            }
          },
        };
      };
      const api: PreparedOpenApi = {
        ...prepared,
        factory,
        documentation: {
          ...prepared.documentation,
          markdown:
            prepared.documentation.markdown +
            `\n\n配置目录：\`work/api/${configurationDirectoryName(snapshot.name)}/\`；逻辑命名空间保持 \`${snapshot.name}\`。实际目录映射同时记录在 config.json 的 identity 中。\n`,
        },
      };
      try {
        return await this.options.activation.prepare(
          {
            kind: "api",
            name: snapshot.name,
            objectId: snapshot.objectId,
            revision,
            config: json(snapshot.config),
            api,
          },
          scope,
        );
      } catch (cause) {
        await credentials.dispose();
        throw cause;
      }
    }
    const mcp = await this.#mcp(snapshot, scope),
      oauth = (snapshot.config as RecordValue).oauth,
      reference = snapshot.secrets.oauth;
    const mcpOAuth =
      oauth && reference && this.options.mcpOAuth
        ? await this.options.mcpOAuth.provider(
            oauth,
            reference.ref,
            reference.binding,
            scope,
          )
        : undefined;
    return this.options.activation.prepare(
      {
        kind: "mcp",
        name: snapshot.name,
        objectId: snapshot.objectId,
        revision,
        config: json(snapshot.config),
        mcp,
        ...(mcpOAuth ? { mcpOAuth } : {}),
      },
      scope,
    );
  }
  async apply(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceResult> {
    await this.verify(intent, candidate, scope);
    const snapshot = await this.#load(intent, candidate, scope),
      state = await this.#approved(),
      id = candidate.payload.configurationId as string,
      old = entry(state[snapshot.kind], snapshot.name),
      revision = hash({ snapshot: id, objectId: snapshot.objectId }),
      remove = intent.action === "remove";
    const publicPlan = await this.#publicWritePlan(snapshot, remove),
      currentPublic = publicPlan.before,
      nextState = json(state);
    if (remove) delete nextState[snapshot.kind][snapshot.name];
    else
      put(nextState[snapshot.kind], snapshot.name, {
        objectId: snapshot.objectId,
        revision,
        snapshot: id,
        enabled: true,
      });
    const approvedBefore = canonicalJson(state, 64 * 1024 * 1024),
      approvedAfter = canonicalJson(nextState, 64 * 1024 * 1024);
    const publicBodies = [publicPlan, ...publicPlan.documents];
    const publicBytes = publicBodies.reduce(
      (total, file) =>
        total +
        Buffer.byteLength(file.before ?? "") +
        Buffer.byteLength(file.after ?? ""),
      0,
    );
    // Admit all fixed public bytes, including identity/source-index locations,
    // plus both approved/public rollback bodies and bounded filesystem metadata.
    // Existing files remain counted by Core until their actual replacement.
    const reservation = await this.options.reserve?.(
      publicBytes +
        Buffer.byteLength(approvedAfter) +
        Buffer.byteLength(approvedBefore) +
        (publicBodies.length + 3) * 1024,
    );
    try {
      current(scope);
      await this.verify(intent, candidate, scope);
      current(scope);
      requireCondition(
        canonicalJson(await this.#approved(), 64 * 1024 * 1024) ===
          approvedBefore &&
          (await readPublic(
            this.#publicLocation(snapshot.kind, snapshot.name),
          )) === currentPublic,
        "maintenance_precondition_changed",
        "The approved or public configuration changed while its fixed write was being admitted.",
      );
      if (remove) {
        requireCondition(
          old,
          "maintenance_precondition_changed",
          "The configuration is already absent.",
        );
        await this.options.activation.remove(
          {
            kind: snapshot.kind,
            name: snapshot.name,
            objectId: old.objectId,
            revision: old.revision,
          },
          scope,
        );
        current(scope);
        await this.#writePublic(publicPlan);
        await privateMaintenanceWrite(
          this.options.root,
          ["configurations", "approved.json"],
          nextState as unknown as JsonObject,
        );
        this.#state = nextState;
        return {
          changed: true,
          restartRequired: false,
          [snapshot.kind === "api" ? "api" : "connection"]: {
            name: snapshot.name,
            state: "removed",
            revision: null,
          },
        };
      }
      requireCondition(
        candidate.authStatus === "ready" ||
          candidate.authStatus === "not_required",
        "maintenance_auth_required",
        "Complete authentication before applying this confirmed configuration.",
      );
      const prepared = await this.#activate(snapshot, revision, scope),
        previousState = json(state);
      let publicWrite: PublicWrite | undefined;
      let saved = false;
      try {
        current(scope);
        await this.verify(intent, candidate, scope);
        requireCondition(
          canonicalJson(await this.#approved(), 64 * 1024 * 1024) ===
            approvedBefore,
          "maintenance_precondition_changed",
          "The approved configuration changed before this fixed publication.",
        );
        publicWrite = await this.#writePublic(publicPlan);
        current(scope);
        await privateMaintenanceWrite(
          this.options.root,
          ["configurations", "approved.json"],
          nextState as unknown as JsonObject,
        );
        saved = true;
        current(scope);
        prepared.publish();
        this.#state = nextState;
      } catch (cause) {
        try {
          if (saved)
            await privateMaintenanceWrite(
              this.options.root,
              ["configurations", "approved.json"],
              previousState as unknown as JsonObject,
            );
          if (publicWrite) await this.#restorePublic(publicWrite);
        } finally {
          await prepared.dispose();
        }
        throw cause;
      }
      return {
        changed: true,
        restartRequired: false,
        [snapshot.kind === "api" ? "api" : "connection"]: {
          name: snapshot.name,
          state: "ready",
          revision,
        },
      };
    } finally {
      reservation?.release();
    }
  }
  /** Startup reuses only immutable privately approved snapshots; work edits are never auto-approved. */
  async restore(
    scope: MaintenanceScope,
  ): Promise<
    readonly { kind: Kind; name: string; state: "ready" | "unavailable" }[]
  > {
    const state = await this.#approved(),
      result: { kind: Kind; name: string; state: "ready" | "unavailable" }[] =
        [];
    for (const kind of ["mcp", "api"] as const)
      for (const [namespace, record] of Object.entries(state[kind]))
        if (record.enabled) {
          let prepared:
            Awaited<ReturnType<ConfigurationActivation["prepare"]>> | undefined;
          try {
            const snapshot = await this.#previous(record);
            requireCondition(
              snapshot && snapshot.owner === scope.caller.principalId,
              "configuration_owner_mismatch",
              "The approved configuration has another owner.",
            );
            prepared = await this.#activate(snapshot, record.revision, scope);
            current(scope);
            prepared.publish();
            result.push({ kind, name: namespace, state: "ready" });
          } catch {
            await prepared?.dispose();
            result.push({ kind, name: namespace, state: "unavailable" });
          }
        }
    return result;
  }
}
