import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { authorizeCall, callerKey, type Caller } from "../contracts/caller.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { privateDirectory } from "../runtime/paths.js";
import { maintenanceText } from "./files.js";
import type {
  Binding,
  ContributionOrigin,
  JsonObject,
  JsonValue,
} from "../contracts/types.js";
import type { AccessTarget } from "../extensions/api.js";
import type { SqliteStore } from "../storage/sqlite.js";

export const maintenanceOrigin: ContributionOrigin = Object.freeze({
  type: "platform",
  owner: "nexum",
  namespace: "maintenance",
  version: "1",
  revision: "1",
});
export type MaintenanceTarget = "package" | "extension" | "mcp" | "api";
export const maintenanceMethods = [
  "packages.install",
  "packages.update",
  "packages.remove",
  "extensions.enable",
  "extensions.disable",
  "mcp.add",
  "mcp.update",
  "mcp.remove",
  "api.import",
  "api.update",
  "api.remove",
] as const;
export type MaintenanceMethod = (typeof maintenanceMethods)[number];
export type MaintenanceStatus =
  "pending" | "approved" | "denied" | "cancelled" | "expired";
export type MaintenanceAuthStatus =
  "not_required" | "required" | "ready" | "failed";
export interface MaintenanceIdentity extends Binding {
  readonly callerKey: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly grantId: string;
}
export interface MaintenanceSummary {
  readonly title: string;
  readonly changeKinds: readonly string[];
  readonly permissions: readonly string[];
  readonly version: string | null;
  readonly namespace: string | null;
  readonly restartMayBeRequired: boolean;
}
export interface MaintenanceDecision {
  readonly status: "approved" | "denied";
  readonly revision: number;
  readonly candidateRevision: string;
  readonly decidedAt: string;
  readonly decisionId: string;
}
export interface MaintenanceExecution {
  readonly operationId: string;
  readonly startedAt: string;
  readonly status?: string;
  readonly result?: JsonObject;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface MaintenanceRequestView {
  readonly requestId: string;
  readonly agentId: string;
  readonly profile: Binding["profile"];
  readonly target: MaintenanceTarget;
  readonly action: string;
  readonly name: string;
  readonly status: MaintenanceStatus;
  readonly revision: number;
  readonly candidateRevision: string;
  readonly objectId: string | null;
  readonly baseRevision: string | null;
  readonly summary: MaintenanceSummary;
  readonly authStatus: MaintenanceAuthStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvalUrl?: string;
  readonly agentName?: string;
  readonly source?: { readonly name?: string };
  readonly decidedAt?: string;
  readonly decision?: MaintenanceDecision;
  readonly execution?: MaintenanceExecution;
}
export interface MaintenanceCreate {
  readonly requestKey: string;
  readonly originRunId: string;
  readonly target: MaintenanceTarget;
  readonly action: string;
  readonly name: string;
  readonly objectId: string | null;
  readonly baseRevision: string | null;
  readonly candidateRevision: string;
  readonly summary: MaintenanceSummary;
  readonly authStatus: MaintenanceAuthStatus;
}
export interface MaintenanceListOptions {
  readonly target?: MaintenanceTarget;
  readonly name?: string;
  readonly status?: MaintenanceStatus;
  readonly limit?: number;
  readonly cursor?: string;
}
/** Trusted Cloud authority; only its Browser endpoints can record a user decision. */
export interface MaintenanceAuthority {
  create(
    identity: MaintenanceIdentity,
    input: MaintenanceCreate,
    signal: AbortSignal,
  ): Promise<MaintenanceRequestView>;
  get(
    identity: MaintenanceIdentity,
    requestId: string,
    signal: AbortSignal,
  ): Promise<MaintenanceRequestView>;
  list(
    identity: MaintenanceIdentity,
    options: MaintenanceListOptions,
    signal: AbortSignal,
  ): Promise<{
    requests: readonly MaintenanceRequestView[];
    nextCursor?: string | null;
  }>;
  cancel(
    identity: MaintenanceIdentity,
    requestId: string,
    signal: AbortSignal,
  ): Promise<MaintenanceRequestView>;
  decision(
    identity: MaintenanceIdentity,
    requestId: string,
    signal: AbortSignal,
  ): Promise<MaintenanceRequestView>;
  beginExecution(
    identity: MaintenanceIdentity,
    input: {
      requestId: string;
      approvedRevision: string;
      decisionRevision: number;
      operationId: string;
    },
    signal: AbortSignal,
  ): Promise<MaintenanceRequestView>;
}
export interface MaintenanceScope {
  readonly caller: Caller;
  readonly operationId: string;
  readonly runId?: string;
  readonly pwd?: string;
  readonly signal: AbortSignal;
  /** Trusted Core observer, after the real SQLite execution identity is durable. */
  readonly onAccepted?: (operationId: string) => void;
  assertCurrent(): void;
  authorize(target: AccessTarget): void;
}
export interface MaintenanceOAuthScope extends MaintenanceScope {
  readonly requestId: string;
  readonly revision: number;
}
export interface MaintenanceIntent {
  readonly method: MaintenanceMethod;
  readonly target: MaintenanceTarget;
  readonly action: string;
  readonly name: string;
  readonly version?: string;
  readonly url?: string;
  readonly path?: string;
  readonly config?: JsonObject;
}
/** Private data never enters Cloud summary, SDK results, logs or model history. */
export interface PreparedMaintenance {
  readonly objectId: string | null;
  readonly baseRevision: string | null;
  readonly payload: JsonObject;
  readonly authStatus: MaintenanceAuthStatus;
  readonly summary: Omit<MaintenanceSummary, "title">;
}
export interface MaintenanceBackend {
  prepare(
    intent: MaintenanceIntent,
    scope: MaintenanceScope,
  ): Promise<PreparedMaintenance>;
  verify(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<void>;
  apply(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceResult>;
  readDraft?(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    scope: MaintenanceScope,
  ): Promise<MaintenanceDraft>;
  prepareDraft?(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    input: MaintenanceDraftInput,
    scope: MaintenanceScope,
  ): Promise<PreparedMaintenance>;
  startOAuth?(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    binding: MaintenanceOAuthBinding,
    scope: MaintenanceOAuthScope,
  ): Promise<MaintenanceOAuthLaunch>;
  completeOAuth?(
    intent: MaintenanceIntent,
    candidate: PreparedMaintenance,
    input: MaintenanceOAuthComplete,
    scope: MaintenanceOAuthScope,
  ): Promise<PreparedMaintenance>;
}
export interface MaintenanceAuthScheme {
  readonly id: string;
  readonly type: string;
  readonly location?: string;
  readonly name?: string;
  readonly flow?: string;
  readonly oauth: boolean;
  readonly fields: readonly {
    key: string;
    label: string;
    configured: boolean;
    required: boolean;
  }[];
}
export interface MaintenanceDraft {
  readonly config: JsonObject;
  readonly currentConfig?: JsonObject;
  readonly authentication: readonly MaintenanceAuthScheme[];
  readonly security: readonly (readonly string[])[];
  readonly diagnostics: readonly string[];
}
export interface MaintenanceDraftInput {
  readonly revision: number;
  readonly config?: JsonObject;
  readonly version?: string;
  readonly credentials?: readonly {
    key: string;
    operation: "keep" | "replace" | "clear";
    value?: string;
  }[];
}
export type MaintenanceCandidateView = Omit<
  MaintenanceCreate,
  "requestKey" | "originRunId"
>;
export interface MaintenanceOAuthBinding {
  readonly state: string;
  readonly callbackUrl: string;
  readonly schemeId: string;
  readonly candidateRevision: string;
}
export interface MaintenanceOAuthLaunch {
  readonly authorizationUrl?: string;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly issuer: string;
  readonly requireIssuer: boolean;
}
export interface MaintenanceOAuthComplete {
  readonly schemeId: string;
  readonly candidateRevision: string;
  readonly callback: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly issuer?: string;
  };
}
export interface MaintenanceResult {
  changed: boolean;
  restartRequired: boolean;
  package?: {
    name: string;
    declared: boolean;
    installedVersion: string | null;
  };
  extension?: {
    namespace: string;
    desiredEnabled: boolean;
    state: string;
    activeVersion: string | null;
  } | null;
  connection?: { name: string; state: string; revision: string | null } | null;
  api?: { name: string; state: string; revision: string | null } | null;
  affectedExtensions?: readonly {
    name: string;
    namespace: string;
    desiredEnabled: boolean;
    state: string;
    activeVersion: string | null;
  }[];
}
export interface MaintenanceService {
  readonly packages: {
    install(input: {
      name: string;
      version?: string;
    }): Promise<MaintenanceCreated>;
    update(input: {
      name: string;
      version?: string;
    }): Promise<MaintenanceCreated>;
    remove(input: { name: string }): Promise<MaintenanceCreated>;
  };
  readonly extensions: {
    enable(input: { name: string }): Promise<MaintenanceCreated>;
    disable(input: { name: string }): Promise<MaintenanceCreated>;
  };
  readonly mcp: {
    add(input: {
      name: string;
      config: JsonObject;
    }): Promise<MaintenanceCreated>;
    update(input: {
      name: string;
      config: JsonObject;
    }): Promise<MaintenanceCreated>;
    remove(input: { name: string }): Promise<MaintenanceCreated>;
  };
  readonly api: {
    import(input: {
      name: string;
      url?: string;
      path?: string;
      config?: JsonObject;
    }): Promise<MaintenanceCreated>;
    update(input: {
      name: string;
      url?: string;
      path?: string;
      config?: JsonObject;
    }): Promise<MaintenanceCreated>;
    remove(input: { name: string }): Promise<MaintenanceCreated>;
  };
  get(requestId: string): Promise<MaintenanceRequestView>;
  list(options?: MaintenanceListOptions): Promise<{
    requests: readonly MaintenanceRequestView[];
    nextCursor: string | null;
  }>;
  cancel(requestId: string): Promise<MaintenanceRequestView>;
}
export interface MaintenanceCreated {
  readonly requestId: string;
  readonly status: MaintenanceStatus;
  readonly approvalUrl?: string;
  readonly expiresAt: string;
}
export function unavailableMaintenance(
  current: () => void,
): MaintenanceService {
  const unavailable = (): never => {
    current();
    throw new AgentError(
      "maintenance_unavailable",
      "The trusted maintenance authority is not configured.",
    );
  };
  return Object.freeze({
    packages: Object.freeze({
      install: unavailable,
      update: unavailable,
      remove: unavailable,
    }),
    extensions: Object.freeze({ enable: unavailable, disable: unavailable }),
    mcp: Object.freeze({
      add: unavailable,
      update: unavailable,
      remove: unavailable,
    }),
    api: Object.freeze({
      import: unavailable,
      update: unavailable,
      remove: unavailable,
    }),
    get: unavailable,
    list: unavailable,
    cancel: unavailable,
  });
}
interface CandidateFile {
  identity: MaintenanceIdentity;
  originRunId: string | null;
  intent: MaintenanceIntent;
  prepared: PreparedMaintenance;
}

const requestPattern = /^maint_req_[A-Za-z0-9_-]{1,128}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const names = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
function bounded(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= max &&
    !/[\0\r\n]/.test(value)
  );
}
function json<T>(value: T, cap = 65536): T {
  return JSON.parse(canonicalJson(value, cap)) as T;
}
const changeKinds = new Set([
  "package",
  "dependency",
  "lockfile",
  "extension",
  "capability",
  "script",
  "instruction",
  "docs",
  "skill",
  "connection",
  "authentication",
  "api",
  "permissions",
  "configuration",
  "remove",
]);
function summary(
  value: Omit<MaintenanceSummary, "title">,
  title: string,
): MaintenanceSummary {
  requireCondition(
    value &&
      Array.isArray(value.changeKinds) &&
      value.changeKinds.length <= 32 &&
      value.changeKinds.every((item) => changeKinds.has(item)) &&
      Array.isArray(value.permissions) &&
      value.permissions.length <= 256 &&
      value.permissions.every((item) => bounded(item, 256)) &&
      (value.version === null || bounded(value.version, 256)) &&
      (value.namespace === null ||
        (typeof value.namespace === "string" &&
          /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value.namespace))) &&
      typeof value.restartMayBeRequired === "boolean",
    "invalid_maintenance_summary",
    "The maintenance summary must contain only bounded declared metadata.",
  );
  return {
    title,
    changeKinds: [...new Set(value.changeKinds)],
    permissions: [...new Set(value.permissions)],
    version: value.version,
    namespace: value.namespace,
    restartMayBeRequired: value.restartMayBeRequired,
  };
}
function publicResult(value: MaintenanceResult): MaintenanceResult {
  const result = json(value);
  requireCondition(
    typeof result.changed === "boolean" &&
      typeof result.restartRequired === "boolean" &&
      Object.keys(result).every((key) =>
        [
          "changed",
          "restartRequired",
          "package",
          "extension",
          "connection",
          "api",
          "affectedExtensions",
        ].includes(key),
      ),
    "invalid_maintenance_result",
    "Maintenance results contain only actual package and capability facts.",
  );
  for (const key of ["package", "extension", "connection", "api"] as const) {
    const item = result[key];
    if (item === undefined || item === null) continue;
    const fields =
      key === "package"
        ? ["name", "declared", "installedVersion"]
        : key === "extension"
          ? ["namespace", "desiredEnabled", "state", "activeVersion"]
          : ["name", "state", "revision"];
    requireCondition(
      isPlainRecord(item) &&
        Object.keys(item).every((field) => fields.includes(field)) &&
        Object.values(item).every(
          (field) =>
            field === null || typeof field === "boolean" || bounded(field, 256),
        ),
      "invalid_maintenance_result",
      "Maintenance detail fields must be bounded facts, not configuration or credentials.",
    );
    const facts = item as unknown as Record<string, unknown>;
    const valid =
      key === "package"
        ? bounded(facts.name) &&
          typeof facts.declared === "boolean" &&
          (facts.installedVersion === null ||
            bounded(facts.installedVersion, 256))
        : key === "extension"
          ? bounded(facts.namespace) &&
            typeof facts.desiredEnabled === "boolean" &&
            bounded(facts.state, 64) &&
            (facts.activeVersion === null || bounded(facts.activeVersion, 256))
          : bounded(facts.name) &&
            bounded(facts.state, 64) &&
            (facts.revision === null || bounded(facts.revision, 256));
    requireCondition(
      valid,
      "invalid_maintenance_result",
      "The observed maintenance facts must use their declared field types.",
    );
  }
  if (result.affectedExtensions !== undefined)
    requireCondition(
      Array.isArray(result.affectedExtensions) &&
        result.affectedExtensions.length <= 1000 &&
        result.affectedExtensions.every(
          (item) =>
            isPlainRecord(item) &&
            Object.keys(item).every((key) =>
              [
                "name",
                "namespace",
                "desiredEnabled",
                "state",
                "activeVersion",
              ].includes(key),
            ) &&
            bounded(item.name) &&
            bounded(item.namespace) &&
            typeof item.desiredEnabled === "boolean" &&
            bounded(item.state, 64) &&
            (item.activeVersion === null || bounded(item.activeVersion, 256)),
        ),
      "invalid_maintenance_result",
      "Affected extensions must contain bounded actual lifecycle facts.",
    );
  return result;
}
function draftView(value: MaintenanceDraft): MaintenanceDraft {
  const draft = json(value, 512 * 1024);
  requireCondition(
    Object.keys(draft).every((key) =>
      [
        "config",
        "currentConfig",
        "authentication",
        "security",
        "diagnostics",
      ].includes(key),
    ) &&
      isPlainRecord(draft.config) &&
      Array.isArray(draft.authentication) &&
      draft.authentication.length <= 100 &&
      Array.isArray(draft.security) &&
      Array.isArray(draft.diagnostics) &&
      draft.diagnostics.length <= 100 &&
      draft.diagnostics.every(
        (item) =>
          typeof item === "string" &&
          Buffer.byteLength(item) <= 2048 &&
          !item.includes("\0"),
      ),
    "invalid_maintenance_draft",
    "A safe draft needs bounded configuration and authentication metadata.",
  );
  canonicalJson(draft.config, 256 * 1024);
  if (draft.currentConfig !== undefined) {
    requireCondition(
      isPlainRecord(draft.currentConfig),
      "invalid_maintenance_draft",
      "The current configuration must be an object.",
    );
    canonicalJson(draft.currentConfig, 256 * 1024);
  }
  for (const scheme of draft.authentication) {
    requireCondition(
      isPlainRecord(scheme) &&
        Object.keys(scheme).every((key) =>
          [
            "id",
            "type",
            "location",
            "name",
            "flow",
            "oauth",
            "fields",
          ].includes(key),
        ) &&
        bounded(scheme.id) &&
        bounded(scheme.type) &&
        typeof scheme.oauth === "boolean" &&
        Array.isArray(scheme.fields) &&
        scheme.fields.length <= 100,
      "invalid_maintenance_draft",
      "Authentication schemes expose field metadata, never credential values.",
    );
    requireCondition(
      [scheme.location, scheme.name, scheme.flow].every(
        (field) => field === undefined || bounded(field, 256),
      ),
      "invalid_maintenance_draft",
      "Authentication metadata fields must be bounded strings.",
    );
    for (const field of scheme.fields)
      requireCondition(
        isPlainRecord(field) &&
          Object.keys(field).every((key) =>
            ["key", "label", "configured", "required"].includes(key),
          ) &&
          bounded(field.key) &&
          bounded(field.label, 256) &&
          typeof field.configured === "boolean" &&
          typeof field.required === "boolean",
        "invalid_maintenance_draft",
        "Credential fields must expose only their configured state.",
      );
  }
  requireCondition(
    draft.security.length <= 100 &&
      draft.security.every(
        (group) =>
          Array.isArray(group) &&
          group.length <= 100 &&
          group.every((item) => bounded(item, 256)),
      ),
    "invalid_maintenance_draft",
    "Authentication alternatives require bounded scheme names.",
  );
  return draft;
}
function requestId(value: unknown): asserts value is string {
  requireCondition(
    typeof value === "string" && requestPattern.test(value),
    "invalid_maintenance_request",
    "Use the existing maintenance request identity.",
  );
}
function target(method: MaintenanceMethod): MaintenanceTarget {
  return method.startsWith("packages.")
    ? "package"
    : method.startsWith("extensions.")
      ? "extension"
      : method.startsWith("mcp.")
        ? "mcp"
        : "api";
}
export function maintenanceIntent(
  method: MaintenanceMethod,
  value: unknown,
  pwd: string,
): MaintenanceIntent {
  requireCondition(
    maintenanceMethods.includes(method) && isPlainRecord(value),
    "invalid_maintenance_input",
    "Use a declared maintenance method and its object arguments.",
  );
  const data = json(value) as Record<string, unknown>,
    kind = target(method),
    action = method.split(".")[1]!;
  const allowed =
    kind === "package" && action !== "remove"
      ? ["name", "version"]
      : kind === "mcp" && action !== "remove"
        ? ["name", "config"]
        : kind === "api" && action !== "remove"
          ? ["name", "url", "path", "config"]
          : ["name"];
  requireCondition(
    Object.keys(data).every((key) => allowed.includes(key)) &&
      bounded(data.name, 214),
    "invalid_maintenance_input",
    "Maintenance arguments contain unsupported fields or an invalid name.",
  );
  const name = data.name;
  requireCondition(
    kind === "package" || kind === "extension"
      ? names.test(name) &&
          !name.split("/").some((part) => part === "." || part === "..")
      : /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/.test(name),
    "invalid_maintenance_name",
    "Use the actual npm package name or one connection/API name.",
  );
  if (data.version !== undefined)
    requireCondition(
      bounded(data.version, 256) &&
        /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(data.version),
      "invalid_maintenance_version",
      "Use one npm version or registry tag, not a command or arbitrary source.",
    );
  if (data.config !== undefined)
    requireCondition(
      isPlainRecord(data.config),
      "invalid_maintenance_config",
      "A maintenance configuration must be an object.",
    );
  if (kind === "mcp" && action !== "remove")
    requireCondition(
      data.config !== undefined,
      "invalid_maintenance_config",
      "The connection change needs its full proposed configuration.",
    );
  if (kind === "api" && action !== "remove") {
    requireCondition(
      Number(data.url !== undefined) + Number(data.path !== undefined) <=
        (action === "import" ? 1 : 1) &&
        (action !== "import" ||
          data.url !== undefined ||
          data.path !== undefined),
      "invalid_maintenance_source",
      "API import requires exactly one URL or local specification path; update accepts at most one.",
    );
    if (data.url !== undefined) {
      requireCondition(
        bounded(data.url, 8192),
        "invalid_maintenance_source",
        "The specification URL is invalid.",
      );
      let url: URL;
      try {
        url = new URL(data.url);
      } catch {
        throw new AgentError(
          "invalid_maintenance_source",
          "The specification URL is invalid.",
        );
      }
      requireCondition(
        ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.hash,
        "invalid_maintenance_source",
        "Use an HTTP(S) specification endpoint without embedded credentials.",
      );
    }
    if (data.path !== undefined) {
      requireCondition(
        bounded(data.path, 8192),
        "invalid_maintenance_source",
        "The local specification path is invalid.",
      );
      data.path = path.resolve(pwd, data.path);
    }
  }
  return Object.freeze({
    ...data,
    method,
    target: kind,
    action,
  }) as unknown as MaintenanceIntent;
}

/** Owns requests and approved independent execution, never a second task scheduler. */
export class MaintenanceRequests {
  #busy = false;
  constructor(
    readonly store: SqliteStore,
    readonly authority: MaintenanceAuthority,
    readonly backend: MaintenanceBackend,
    readonly options: {
      approvalOrigin: string;
      maxCandidateBytes?: number;
      now?: () => number;
      /** Core-only managed storage admission; never part of a maintenance input. */
      reserve?: (bytes: number) => Promise<{ release(): void }>;
    },
  ) {
    const origin = new URL(options.approvalOrigin);
    requireCondition(
      ["https:", "http:"].includes(origin.protocol) &&
        !origin.username &&
        !origin.password,
      "invalid_maintenance_options",
      "Use the configured Cloud origin for approval links.",
    );
    requireCondition(
      options.maxCandidateBytes === undefined ||
        (Number.isSafeInteger(options.maxCandidateBytes) &&
          options.maxCandidateBytes >= 1024 &&
          options.maxCandidateBytes <= 64 * 1024 * 1024),
      "invalid_maintenance_options",
      "Private maintenance candidates need a positive bounded storage limit.",
    );
  }
  #now(): number {
    return this.options.now?.() ?? Date.now();
  }
  #pwd(scope: MaintenanceScope): string {
    if (scope.pwd !== undefined) {
      requireCondition(
        path.isAbsolute(scope.pwd),
        "invalid_maintenance_context",
        "Maintenance paths need the actual working context directory.",
      );
      return scope.pwd;
    }
    if (scope.runId) {
      const run = this.store.getRun(scope.runId);
      requireCondition(
        run.callerKey === callerKey(scope.caller),
        "invalid_maintenance_context",
        "The maintenance working directory belongs to another caller.",
      );
      return this.store.getWork(run.contextId).pwd;
    }
    return path.join(this.store.root, "work");
  }
  #identity(scope: MaintenanceScope): MaintenanceIdentity {
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    requireCondition(
      bounded(scope.caller.principalId) &&
        bounded(scope.caller.clientId) &&
        bounded(scope.caller.grantId),
      "maintenance_authority_unavailable",
      "Maintenance needs the current verified caller and Cloud Grant.",
    );
    return Object.freeze({
      ...this.store.binding,
      callerKey: callerKey(scope.caller),
      principalId: scope.caller.principalId,
      clientId: scope.caller.clientId,
      grantId: scope.caller.grantId,
    });
  }
  #current(scope: MaintenanceScope, access: string, value = "requests"): void {
    scope.signal.throwIfAborted();
    authorizeCall(() => scope.assertCurrent());
    authorizeCall(() =>
      scope.authorize({ type: "maintenance", value, access }),
    );
  }
  #view(view: MaintenanceRequestView): MaintenanceRequestView {
    const value = json(view, 262144);
    requestId(value.requestId);
    requireCondition(
      Object.keys(value).every((key) =>
        [
          "requestId",
          "agentId",
          "profile",
          "target",
          "action",
          "name",
          "status",
          "revision",
          "candidateRevision",
          "objectId",
          "baseRevision",
          "summary",
          "authStatus",
          "createdAt",
          "expiresAt",
          "approvalUrl",
          "agentName",
          "source",
          "decidedAt",
          "decision",
          "execution",
        ].includes(key),
      ) &&
        value.agentId === this.store.binding.agentId &&
        value.profile === this.store.binding.profile &&
        ["pending", "approved", "denied", "cancelled", "expired"].includes(
          value.status,
        ) &&
        Number.isSafeInteger(value.revision) &&
        value.revision > 0 &&
        hashPattern.test(value.candidateRevision) &&
        Number.isFinite(Date.parse(value.expiresAt)),
      "invalid_maintenance_authority",
      "The Cloud response does not match this Agent/profile request.",
    );
    const method = `${value.target === "package" ? "packages" : value.target === "extension" ? "extensions" : value.target}.${value.action}`;
    requireCondition(
      maintenanceMethods.includes(method as MaintenanceMethod) &&
        bounded(value.name, 214) &&
        (value.objectId === null || bounded(value.objectId, 256)) &&
        (value.baseRevision === null || bounded(value.baseRevision, 256)) &&
        ["not_required", "required", "ready", "failed"].includes(
          value.authStatus,
        ) &&
        Number.isFinite(Date.parse(value.createdAt)),
      "invalid_maintenance_authority",
      "The authority returned an invalid maintenance target or preparation state.",
    );
    if (value.decision)
      requireCondition(
        Object.keys(value.decision).every((key) =>
          [
            "status",
            "revision",
            "candidateRevision",
            "decidedAt",
            "decisionId",
          ].includes(key),
        ) &&
          ["approved", "denied"].includes(value.decision.status) &&
          Number.isSafeInteger(value.decision.revision) &&
          value.decision.revision > 0 &&
          hashPattern.test(value.decision.candidateRevision) &&
          bounded(value.decision.decisionId) &&
          Number.isFinite(Date.parse(value.decision.decidedAt)),
        "invalid_maintenance_authority",
        "The user decision has an invalid fixed revision.",
      );
    if (value.execution) {
      requireCondition(
        Object.keys(value.execution).every((key) =>
          ["operationId", "startedAt", "status", "result", "error"].includes(
            key,
          ),
        ) &&
          /^op_[0-9a-f]{32}$/.test(value.execution.operationId) &&
          Number.isFinite(Date.parse(value.execution.startedAt)) &&
          (value.execution.status === undefined ||
            bounded(value.execution.status, 64)),
        "invalid_maintenance_authority",
        "The authority returned an invalid execution identity.",
      );
      if (value.execution.result)
        publicResult(value.execution.result as unknown as MaintenanceResult);
      if (value.execution.error)
        requireCondition(
          isPlainRecord(value.execution.error) &&
            Object.keys(value.execution.error).every(
              (key) => key === "code" || key === "message",
            ) &&
            typeof value.execution.error.code === "string" &&
            /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(
              value.execution.error.code,
            ) &&
            typeof value.execution.error.message === "string" &&
            Buffer.byteLength(value.execution.error.message) <= 4096 &&
            !value.execution.error.message.includes("\0"),
          "invalid_maintenance_authority",
          "The execution error must contain only its safe code and message.",
        );
    }
    const safeSummary = summary(
      value.summary,
      `${value.target === "package" ? "packages" : value.target === "extension" ? "extensions" : value.target}.${value.action}: ${value.name}`,
    );
    requireCondition(
      (value.agentName === undefined || bounded(value.agentName, 1024)) &&
        (value.source === undefined ||
          (isPlainRecord(value.source) &&
            Object.keys(value.source).every((key) => key === "name") &&
            (value.source.name === undefined ||
              bounded(value.source.name, 1024)))),
      "invalid_maintenance_authority",
      "The authority source labels must contain only their verified display name.",
    );
    if (value.approvalUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(value.approvalUrl);
      } catch {
        throw new AgentError(
          "invalid_maintenance_authority",
          "The authority returned an invalid approval location.",
        );
      }
      const origin = new URL(this.options.approvalOrigin);
      requireCondition(
        url.origin === origin.origin &&
          url.pathname === `/authorize/maintenance/${value.requestId}` &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password,
        "invalid_maintenance_authority",
        "The authority returned an invalid approval location.",
      );
    }
    return { ...value, summary: safeSummary };
  }
  #filename(revision: string): string {
    requireCondition(
      hashPattern.test(revision),
      "invalid_maintenance_revision",
      "Use an existing fixed candidate revision.",
    );
    return path.join(
      this.store.root,
      "state",
      "maintenance",
      "candidates",
      `${revision}.json`,
    );
  }
  #candidateDirectoryExists(): boolean {
    let directory = this.store.root;
    requireCondition(
      realpathSync.native(directory) === directory,
      "storage_path_escape",
      "The candidate profile root cannot redirect.",
    );
    for (const part of ["state", "maintenance", "candidates"]) {
      directory = path.join(directory, part);
      const info = lstatSync(directory, { throwIfNoEntry: false });
      if (!info) return false;
      requireCondition(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          realpathSync.native(directory) === directory,
        "storage_path_escape",
        "Private candidate directories cannot redirect outside this profile.",
      );
    }
    return true;
  }
  async #save(candidate: CandidateFile): Promise<string> {
    const body = canonicalJson(
        candidate,
        this.options.maxCandidateBytes ?? 64 * 1024 * 1024,
      ),
      revision = createHash("sha256").update(body).digest("hex"),
      file = this.#filename(revision);
    const existing = this.#candidateDirectoryExists()
      ? await maintenanceText(
          file,
          this.options.maxCandidateBytes ?? 64 * 1024 * 1024,
          true,
        )
      : null;
    if (existing !== null) {
      requireCondition(
        this.#candidateDirectoryExists() && existing === body,
        "maintenance_candidate_conflict",
        "A fixed maintenance candidate no longer matches its revision.",
      );
      return revision;
    }
    const reservation = await this.options.reserve?.(
      Buffer.byteLength(body) + 1024,
    );
    try {
      privateDirectory(this.store.root, "state", "maintenance", "candidates");
      await writeFile(file, body, { flag: "wx", mode: 0o600 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      requireCondition(
        (await maintenanceText(
          file,
          this.options.maxCandidateBytes ?? 64 * 1024 * 1024,
        )) === body,
        "maintenance_candidate_conflict",
        "A fixed maintenance candidate no longer matches its revision.",
      );
    } finally {
      reservation?.release();
    }
    return revision;
  }
  async #load(
    view: MaintenanceRequestView,
    identity: MaintenanceIdentity,
  ): Promise<CandidateFile> {
    privateDirectory(this.store.root, "state", "maintenance", "candidates");
    const body = (await maintenanceText(
      this.#filename(view.candidateRevision),
      this.options.maxCandidateBytes ?? 64 * 1024 * 1024,
    ))!;
    requireCondition(
      createHash("sha256").update(body).digest("hex") ===
        view.candidateRevision,
      "maintenance_candidate_conflict",
      "The approved candidate bytes changed.",
    );
    const candidate = JSON.parse(body) as CandidateFile;
    requireCondition(
      canonicalJson(candidate.identity) === canonicalJson(identity) &&
        candidate.intent.target === view.target &&
        candidate.intent.action === view.action &&
        candidate.intent.name === view.name &&
        candidate.prepared.objectId === view.objectId &&
        candidate.prepared.baseRevision === view.baseRevision,
      "maintenance_candidate_conflict",
      "The approved target or caller binding differs from this candidate.",
    );
    return candidate;
  }
  async #create(
    method: MaintenanceMethod,
    input: unknown,
    scope: MaintenanceScope,
  ): Promise<MaintenanceCreated> {
    const identity = this.#identity(scope);
    requireCondition(
      bounded(scope.operationId, 256),
      "invalid_maintenance_context",
      "Request creation needs its actual SDK operation identity.",
    );
    requireCondition(
      bounded(scope.runId, 256),
      "invalid_maintenance_context",
      "Request creation needs its actual originating run identity.",
    );
    const intent = maintenanceIntent(method, input, this.#pwd(scope));
    this.#current(scope, method, intent.name);
    const prepared = json(
      await this.backend.prepare(intent, scope),
      this.options.maxCandidateBytes ?? 64 * 1024 * 1024,
    );
    requireCondition(
      isPlainRecord(prepared.payload) &&
        ["not_required", "required", "ready", "failed"].includes(
          prepared.authStatus,
        ) &&
        (prepared.objectId === null || bounded(prepared.objectId, 256)) &&
        (prepared.baseRevision === null || bounded(prepared.baseRevision, 256)),
      "invalid_maintenance_candidate",
      "The prepared maintenance candidate needs exact bounded identity and authentication state.",
    );
    this.#current(scope, method, intent.name);
    const candidate: CandidateFile = {
        identity,
        originRunId: scope.runId,
        intent,
        prepared,
      },
      candidateRevision = await this.#save(candidate);
    const safeSummary = summary(prepared.summary, `${method}: ${intent.name}`);
    const view = this.#view(
      await this.authority.create(
        identity,
        {
          requestKey: scope.operationId,
          originRunId: scope.runId,
          target: intent.target,
          action: intent.action,
          name: intent.name,
          objectId: prepared.objectId,
          baseRevision: prepared.baseRevision,
          candidateRevision,
          summary: safeSummary,
          authStatus: prepared.authStatus,
        },
        scope.signal,
      ),
    );
    this.#current(scope, method, intent.name);
    requireCondition(
      view.candidateRevision === candidateRevision,
      "maintenance_candidate_conflict",
      "Request creation did not retain this exact prepared candidate.",
    );
    requireCondition(
      view.status !== "pending" || typeof view.approvalUrl === "string",
      "invalid_maintenance_authority",
      "A pending request needs its real user confirmation link.",
    );
    return {
      requestId: view.requestId,
      status: view.status,
      ...(view.approvalUrl ? { approvalUrl: view.approvalUrl } : {}),
      expiresAt: view.expiresAt,
    };
  }
  bind(scope: MaintenanceScope): MaintenanceService {
    const create = (method: MaintenanceMethod) => (input: unknown) =>
      this.#create(method, input, scope);
    return Object.freeze({
      packages: Object.freeze({
        install: create("packages.install"),
        update: create("packages.update"),
        remove: create("packages.remove"),
      }),
      extensions: Object.freeze({
        enable: create("extensions.enable"),
        disable: create("extensions.disable"),
      }),
      mcp: Object.freeze({
        add: create("mcp.add"),
        update: create("mcp.update"),
        remove: create("mcp.remove"),
      }),
      api: Object.freeze({
        import: create("api.import"),
        update: create("api.update"),
        remove: create("api.remove"),
      }),
      get: (id: string) => this.get(id, scope),
      list: (input: MaintenanceListOptions = {}) => this.list(input, scope),
      cancel: (id: string) => this.cancel(id, scope),
    });
  }
  async get(
    id: string,
    scope: MaintenanceScope,
  ): Promise<MaintenanceRequestView> {
    requestId(id);
    const identity = this.#identity(scope);
    this.#current(scope, "get", id);
    const view = this.#view(
      await this.authority.get(identity, id, scope.signal),
    );
    this.#current(scope, "get", id);
    const delivered = await this.#withExecution(view, identity);
    this.#current(scope, "get", id);
    return delivered;
  }
  async list(
    input: MaintenanceListOptions,
    scope: MaintenanceScope,
  ): Promise<{
    requests: readonly MaintenanceRequestView[];
    nextCursor: string | null;
  }> {
    const identity = this.#identity(scope),
      options = json(input);
    this.#current(scope, "list");
    requireCondition(
      Boolean(isPlainRecord(options)) &&
        Object.keys(options).every((key) =>
          ["target", "name", "status", "limit", "cursor"].includes(key),
        ) &&
        (options.name === undefined || bounded(options.name, 214)) &&
        (options.cursor === undefined || bounded(options.cursor, 4096)) &&
        (options.limit === undefined ||
          (Number.isSafeInteger(options.limit) &&
            options.limit >= 1 &&
            options.limit <= 100)) &&
        (options.target === undefined ||
          ["package", "extension", "mcp", "api"].includes(options.target)) &&
        (options.status === undefined ||
          ["pending", "approved", "denied", "cancelled", "expired"].includes(
            options.status,
          )),
      "invalid_maintenance_filter",
      "Use bounded maintenance filters.",
    );
    const page = await this.authority.list(identity, options, scope.signal);
    this.#current(scope, "list");
    requireCondition(
      Array.isArray(page.requests) &&
        page.requests.length <= (options.limit ?? 100) &&
        (page.nextCursor === undefined ||
          page.nextCursor === null ||
          bounded(page.nextCursor, 4096)),
      "invalid_maintenance_authority",
      "The request page exceeds its requested bound.",
    );
    const delivered = {
      requests: await Promise.all(
        page.requests.map((view) =>
          this.#withExecution(this.#view(view), identity),
        ),
      ),
      nextCursor: page.nextCursor ?? null,
    };
    this.#current(scope, "list");
    return delivered;
  }
  async cancel(
    id: string,
    scope: MaintenanceScope,
  ): Promise<MaintenanceRequestView> {
    requestId(id);
    const identity = this.#identity(scope);
    this.#current(scope, "cancel", id);
    const view = this.#view(
      await this.authority.cancel(identity, id, scope.signal),
    );
    this.#current(scope, "cancel", id);
    const delivered = await this.#withExecution(view, identity);
    this.#current(scope, "cancel", id);
    return delivered;
  }
  #candidateView(
    candidate: CandidateFile,
    revision: string,
  ): MaintenanceCandidateView {
    return {
      target: candidate.intent.target,
      action: candidate.intent.action,
      name: candidate.intent.name,
      objectId: candidate.prepared.objectId,
      baseRevision: candidate.prepared.baseRevision,
      candidateRevision: revision,
      summary: summary(
        candidate.prepared.summary,
        `${candidate.intent.method}: ${candidate.intent.name}`,
      ),
      authStatus: candidate.prepared.authStatus,
    };
  }
  /** Browser/Core-only controlled projection. Full candidate and secret values stay private. */
  async readDraft(
    id: string,
    scope: MaintenanceScope,
  ): Promise<{ draft: MaintenanceDraft; execution?: MaintenanceExecution }> {
    const identity = this.#identity(scope),
      view = this.#view(await this.authority.get(identity, id, scope.signal)),
      candidate = await this.#load(view, identity);
    this.#current(scope, "get", id);
    const draft = this.backend.readDraft
      ? await this.backend.readDraft(
          candidate.intent,
          candidate.prepared,
          scope,
        )
      : candidate.intent.target === "package" ||
          candidate.intent.target === "extension"
        ? { config: {}, authentication: [], security: [], diagnostics: [] }
        : undefined;
    requireCondition(
      draft,
      "maintenance_draft_unavailable",
      "The configuration backend cannot provide a safe editable draft.",
    );
    this.#current(scope, "get", id);
    const actual = await this.#withExecution(view, identity);
    return {
      draft: draftView(draft),
      ...(actual.execution ? { execution: actual.execution } : {}),
    };
  }
  async prepareDraft(
    id: string,
    input: MaintenanceDraftInput,
    scope: MaintenanceScope,
  ): Promise<{ candidate: MaintenanceCandidateView; draft: MaintenanceDraft }> {
    requestId(id);
    const identity = this.#identity(scope),
      view = this.#view(await this.authority.get(identity, id, scope.signal));
    requireCondition(
      view.status === "pending" &&
        view.revision === input.revision &&
        Date.parse(view.expiresAt) > this.#now(),
      "maintenance_revision_conflict",
      "Only the current pending revision can be edited.",
    );
    const original = await this.#load(view, identity);
    this.#current(scope, original.intent.method, original.intent.name);
    const edit = json(input, 512 * 1024);
    requireCondition(
      Object.keys(edit).every((key) =>
        ["revision", "version", "config", "credentials"].includes(key),
      ),
      "invalid_maintenance_draft",
      "The draft cannot change operation or target identity.",
    );
    if (edit.credentials !== undefined)
      requireCondition(
        Array.isArray(edit.credentials) &&
          edit.credentials.length <= 100 &&
          new Set(edit.credentials.map((field) => field.key)).size ===
            edit.credentials.length &&
          edit.credentials.every(
            (field) =>
              isPlainRecord(field) &&
              Object.keys(field).every((key) =>
                ["key", "operation", "value"].includes(key),
              ) &&
              bounded(field.key) &&
              typeof field.operation === "string" &&
              ["keep", "replace", "clear"].includes(field.operation) &&
              (field.operation === "replace"
                ? typeof field.value === "string" &&
                  field.value.length > 0 &&
                  Buffer.byteLength(field.value) <= 32768 &&
                  !field.value.includes("\0") &&
                  !/^[*• ]+$/.test(field.value)
                : field.value === undefined),
          ),
        "invalid_maintenance_credentials",
        "Use explicit bounded credential keep, replace or clear operations.",
      );
    const base: Record<string, unknown> = { name: original.intent.name };
    for (const key of ["version", "url", "path", "config"] as const)
      if (original.intent[key] !== undefined) base[key] = original.intent[key];
    if (edit.version !== undefined) base.version = edit.version;
    if (edit.config !== undefined) base.config = edit.config;
    const intent = maintenanceIntent(
      original.intent.method,
      base,
      path.join(this.store.root, "work"),
    );
    const prepared = this.backend.prepareDraft
      ? await this.backend.prepareDraft(intent, original.prepared, edit, scope)
      : (edit.credentials?.length ?? 0) > 0
        ? undefined
        : await this.backend.prepare(intent, scope);
    requireCondition(
      prepared,
      "maintenance_credentials_unavailable",
      "This backend cannot accept protected credential changes.",
    );
    requireCondition(
      prepared.objectId === original.prepared.objectId &&
        prepared.baseRevision === original.prepared.baseRevision,
      "maintenance_precondition_changed",
      "The target changed while the user edited this request.",
    );
    const candidate: CandidateFile = {
        ...original,
        intent,
        prepared: json(
          prepared,
          this.options.maxCandidateBytes ?? 64 * 1024 * 1024,
        ),
      },
      revision = await this.#save(candidate);
    const draft = this.backend.readDraft
      ? await this.backend.readDraft(intent, prepared, scope)
      : { config: {}, authentication: [], security: [], diagnostics: [] };
    this.#current(scope, intent.method, intent.name);
    return {
      candidate: this.#candidateView(candidate, revision),
      draft: draftView(draft),
    };
  }
  async verify(
    id: string,
    scope: MaintenanceScope,
  ): Promise<MaintenanceCandidateView> {
    requestId(id);
    const identity = this.#identity(scope),
      view = this.#view(await this.authority.get(identity, id, scope.signal)),
      candidate = await this.#load(view, identity);
    this.#current(scope, candidate.intent.method, candidate.intent.name);
    await this.backend.verify(candidate.intent, candidate.prepared, scope);
    this.#current(scope, candidate.intent.method, candidate.intent.name);
    return this.#candidateView(candidate, view.candidateRevision);
  }
  async startOAuth(
    id: string,
    revision: number,
    binding: MaintenanceOAuthBinding,
    scope: MaintenanceScope,
  ): Promise<MaintenanceOAuthLaunch> {
    requestId(id);
    const identity = this.#identity(scope),
      view = this.#view(await this.authority.get(identity, id, scope.signal));
    requireCondition(
      view.status === "pending" &&
        view.revision === revision &&
        view.candidateRevision === binding.candidateRevision &&
        Date.parse(view.expiresAt) > this.#now(),
      "maintenance_revision_conflict",
      "OAuth must use the current pending candidate revision.",
    );
    requireCondition(
      this.backend.startOAuth,
      "maintenance_oauth_unavailable",
      "No trusted OAuth provider is configured for this maintenance backend.",
    );
    requireCondition(
      bounded(binding.state, 4096) &&
        bounded(binding.schemeId) &&
        hashPattern.test(binding.candidateRevision),
      "invalid_maintenance_oauth",
      "OAuth requires the fixed scheme, candidate and one authorization state.",
    );
    let callback: URL;
    try {
      callback = new URL(binding.callbackUrl);
    } catch {
      throw new AgentError(
        "invalid_maintenance_oauth",
        "The trusted platform OAuth callback is invalid.",
      );
    }
    requireCondition(
      callback.origin === new URL(this.options.approvalOrigin).origin &&
        callback.pathname === "/api/console/maintenance/oauth/callback" &&
        !callback.username &&
        !callback.password &&
        !callback.hash &&
        !callback.search,
      "invalid_maintenance_oauth",
      "OAuth must return to the configured platform callback.",
    );
    const candidate = await this.#load(view, identity);
    this.#current(scope, candidate.intent.method, candidate.intent.name);
    const launch = await this.backend.startOAuth(
      candidate.intent,
      candidate.prepared,
      json(binding),
      {
        ...scope,
        requestId: id,
        revision,
        assertCurrent: () => scope.assertCurrent(),
        authorize: (target) => scope.authorize(target),
      },
    );
    this.#current(scope, candidate.intent.method, candidate.intent.name);
    const delivered = json(launch, 65536);
    requireCondition(
      Object.keys(delivered).every((key) =>
        [
          "authorizationUrl",
          "verificationUri",
          "userCode",
          "issuer",
          "requireIssuer",
        ].includes(key),
      ) &&
        bounded(delivered.issuer, 8192) &&
        typeof delivered.requireIssuer === "boolean" &&
        (bounded(delivered.authorizationUrl, 32768) ||
          (bounded(delivered.verificationUri, 32768) &&
            bounded(delivered.userCode, 1024))),
      "invalid_maintenance_oauth",
      "An interactive OAuth launch needs its real authorization URL or device instructions.",
    );
    for (const value of [
      delivered.issuer,
      delivered.authorizationUrl,
      delivered.verificationUri,
    ])
      if (value !== undefined) {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new AgentError(
            "invalid_maintenance_oauth",
            "The OAuth provider returned an invalid URL.",
          );
        }
        requireCondition(
          ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password,
          "invalid_maintenance_oauth",
          "OAuth provider URLs must use configured HTTP(S) endpoints.",
        );
      }
    return delivered;
  }
  async completeOAuth(
    id: string,
    revision: number,
    input: MaintenanceOAuthComplete,
    scope: MaintenanceScope,
  ): Promise<{ candidate: MaintenanceCandidateView; draft: MaintenanceDraft }> {
    requestId(id);
    const identity = this.#identity(scope),
      view = this.#view(await this.authority.get(identity, id, scope.signal));
    requireCondition(
      view.status === "pending" &&
        view.revision === revision &&
        view.candidateRevision === input.candidateRevision &&
        Date.parse(view.expiresAt) > this.#now(),
      "maintenance_revision_conflict",
      "OAuth completion must use the original current pending candidate.",
    );
    requireCondition(
      this.backend.completeOAuth && this.backend.readDraft,
      "maintenance_oauth_unavailable",
      "No trusted OAuth completion provider is configured.",
    );
    requireCondition(
      bounded(input.schemeId) &&
        hashPattern.test(input.candidateRevision) &&
        isPlainRecord(input.callback) &&
        Object.keys(input.callback).every((key) =>
          ["state", "code", "error", "issuer"].includes(key),
        ) &&
        bounded(input.callback.state, 4096) &&
        (input.callback.code === undefined ||
          bounded(input.callback.code, 65536)) &&
        (input.callback.error === undefined ||
          bounded(input.callback.error, 256)) &&
        (input.callback.issuer === undefined ||
          bounded(input.callback.issuer, 8192)),
      "invalid_maintenance_oauth",
      "OAuth completion requires the original bounded callback fields.",
    );
    const original = await this.#load(view, identity);
    this.#current(scope, original.intent.method, original.intent.name);
    const prepared = await this.backend.completeOAuth(
      original.intent,
      original.prepared,
      json(input, 262144),
      {
        ...scope,
        requestId: id,
        revision,
        assertCurrent: () => scope.assertCurrent(),
        authorize: (target) => scope.authorize(target),
      },
    );
    requireCondition(
      prepared.objectId === original.prepared.objectId &&
        prepared.baseRevision === original.prepared.baseRevision,
      "maintenance_precondition_changed",
      "OAuth cannot change this maintenance target identity.",
    );
    const candidate = {
        ...original,
        prepared: json(
          prepared,
          this.options.maxCandidateBytes ?? 64 * 1024 * 1024,
        ),
      },
      candidateRevision = await this.#save(candidate),
      draft = await this.backend.readDraft(original.intent, prepared, scope);
    this.#current(scope, original.intent.method, original.intent.name);
    return {
      candidate: this.#candidateView(candidate, candidateRevision),
      draft: draftView(draft),
    };
  }
  async #withExecution(
    view: MaintenanceRequestView,
    identity: MaintenanceIdentity,
  ): Promise<MaintenanceRequestView> {
    const operation = this.store.getMaintenanceOperation(view.requestId);
    if (!operation) return view;
    requireCondition(
      operation.callerKey === identity.callerKey &&
        operation.approvedRevision === view.candidateRevision,
      "maintenance_execution_conflict",
      "The existing execution belongs to another approved binding.",
    );
    let result: JsonObject | undefined;
    if (operation.endedAt !== null && operation.detailRef) {
      try {
        privateDirectory(
          this.store.root,
          "state",
          "maintenance",
          view.requestId,
        );
        const body = JSON.parse(
          (await maintenanceText(
            path.join(this.store.root, operation.detailRef),
            65536,
          ))!,
        ) as JsonObject;
        if (
          body.operationId === operation.operationId &&
          isPlainRecord(body.result)
        )
          result = publicResult(
            body.result as unknown as MaintenanceResult,
          ) as unknown as JsonObject;
      } catch {}
    }
    const error =
      operation.error &&
      typeof operation.error.code === "string" &&
      bounded(operation.error.code, 256) &&
      typeof operation.error.message === "string" &&
      Buffer.byteLength(operation.error.message) <= 4096 &&
      !operation.error.message.includes("\0")
        ? { code: operation.error.code, message: operation.error.message }
        : undefined;
    return {
      ...view,
      execution: {
        operationId: operation.operationId,
        status: operation.status,
        startedAt: new Date(operation.createdAt).toISOString(),
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
      },
    };
  }
  /** Called by the independent Core lifecycle after a real Browser decision. */
  async execute(
    id: string,
    scope: MaintenanceScope,
  ): Promise<MaintenanceRequestView> {
    requestId(id);
    const identity = this.#identity(scope);
    const view = this.#view(
      await this.authority.decision(identity, id, scope.signal),
    );
    const method = `${view.target === "package" ? "packages" : view.target === "extension" ? "extensions" : view.target}.${view.action}`;
    this.#current(scope, method, view.name);
    const existing = this.store.getMaintenanceOperation(id);
    if (existing) {
      const delivered = await this.#withExecution(view, identity);
      this.#current(scope, method, view.name);
      return delivered;
    }
    requireCondition(
      !this.#busy,
      "maintenance_busy",
      "Another maintenance change is using this Agent work environment.",
    );
    requireCondition(
      view.status === "approved" &&
        view.decision?.status === "approved" &&
        view.decision.revision === view.revision &&
        view.decision.candidateRevision === view.candidateRevision &&
        Date.parse(view.expiresAt) > this.#now(),
      "maintenance_not_approved",
      "Only the current, unexpired user-confirmed revision can begin execution.",
    );
    this.#busy = true;
    let executionReservation: { release(): void } | undefined;
    try {
      const candidate = await this.#load(view, identity);
      await this.backend.verify(candidate.intent, candidate.prepared, scope);
      this.#current(scope, candidate.intent.method, candidate.intent.name);
      // Keep bounded result/diagnostic space until actual native work and its
      // final SQLite settlement finish; quota pressure cannot strand an accepted change.
      executionReservation = await this.options.reserve?.(80 * 1024 + 1024);
      this.#current(scope, candidate.intent.method, candidate.intent.name);
      const detailRef = `state/maintenance/${id}/execution.json`;
      const started = this.store.startMaintenanceOperation(
        {
          requestId: id,
          approvedRevision: view.candidateRevision,
          callerKey: identity.callerKey,
          originRunId: candidate.originRunId,
          source: {
            origin: maintenanceOrigin,
            target: view.target,
            name: view.name,
            objectId: view.objectId,
            baseRevision: view.baseRevision,
            candidateRevision: view.candidateRevision,
          },
          method: candidate.intent.method,
          detailRef,
        },
        this.#now(),
      );
      scope.onAccepted?.(started.operation.operationId);
      if (started.duplicate) {
        const delivered = await this.#withExecution(view, identity);
        this.#current(scope, method, view.name);
        return delivered;
      }
      let result: MaintenanceResult | undefined, error: JsonObject | undefined;
      try {
        const receipt = this.#view(
          await this.authority.beginExecution(
            identity,
            {
              requestId: id,
              approvedRevision: view.candidateRevision,
              decisionRevision: view.revision,
              operationId: started.operation.operationId,
            },
            scope.signal,
          ),
        );
        requireCondition(
          receipt.status === "approved" &&
            receipt.candidateRevision === view.candidateRevision &&
            receipt.execution?.operationId === started.operation.operationId,
          "maintenance_execution_conflict",
          "The authority did not accept this exact execution.",
        );
        requireCondition(
          candidate.prepared.authStatus === "ready" ||
            candidate.prepared.authStatus === "not_required",
          "maintenance_auth_required",
          "Authentication must be ready before the confirmed change can execute.",
        );
        this.#current(scope, candidate.intent.method, candidate.intent.name);
        await this.backend.verify(candidate.intent, candidate.prepared, scope);
        const executionScope: MaintenanceScope = {
          ...scope,
          operationId: started.operation.operationId,
          assertCurrent: () => scope.assertCurrent(),
          authorize: (target) => scope.authorize(target),
        };
        result = publicResult(
          await this.backend.apply(
            candidate.intent,
            candidate.prepared,
            executionScope,
          ),
        );
        this.#current(scope, candidate.intent.method, candidate.intent.name);
      } catch (cause) {
        if (isAgentError(cause) && isPlainRecord(cause.details?.partial))
          try {
            result = publicResult(
              cause.details!.partial as unknown as MaintenanceResult,
            );
          } catch {}
        error = {
          code: isAgentError(cause)
            ? cause.code
            : "maintenance_execution_failed",
          message:
            "The approved maintenance did not complete; inspect its actual execution state.",
        };
      }
      const directory = privateDirectory(
          this.store.root,
          "state",
          "maintenance",
          id,
        ),
        file = path.join(directory, "execution.json");
      await writeFile(
        file,
        canonicalJson(
          {
            operationId: started.operation.operationId,
            requestId: id,
            ...(result ? { result } : {}),
            ...(error ? { error } : {}),
          },
          80 * 1024,
        ),
        { mode: 0o600, flag: "wx" },
      );
      this.store.finishOperation(
        started.operation.operationId,
        error ? "failed" : "succeeded",
        error,
        this.#now(),
      );
      const latest = this.#view(
        await this.authority.get(identity, id, scope.signal),
      );
      const delivered = await this.#withExecution(latest, identity);
      this.#current(scope, method, view.name);
      return delivered;
    } finally {
      executionReservation?.release();
      this.#busy = false;
    }
  }
}
