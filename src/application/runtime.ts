import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { authorizeCall, callerKey, type Caller } from "../contracts/caller.js";
import {
  canonicalJson,
  digest,
  newId,
  isPlainRecord,
} from "../contracts/json.js";
import { validateContract } from "../contracts/validation.js";
import { validateConnectionV2 } from "../contracts/wire-validation.js";
import type {
  ContributionOrigin,
  JsonObject,
  JsonValue,
  RunRecord,
  WorkRecord,
} from "../contracts/types.js";
import { terminalStatuses } from "../contracts/types.js";
import type {
  WireConnectionV2,
  WireInvokeV2,
  WireInvocationContextV2,
  WireOperationV2,
  WireInputsV2,
  WireOutputsV2,
  WireEventV2,
  WireFixedStreamRefV2,
  WireStreamPurposeV2,
  WireCallerV2,
  WireAuthorizationRefreshInputV2,
} from "../contracts/wire.js";
import { SqliteStore, type ResourceHistoryRecord } from "../storage/sqlite.js";
import {
  defaultBuiltins,
  ModuleLoader,
  type ModulePolicy,
} from "../runtime/modules.js";
import {
  RunEngine,
  type RunServices,
  type RunView,
  type RunDetails,
} from "../runtime/engine.js";
import { ScriptCatalog } from "../runtime/scripts.js";
import { RuntimeTasks, localTaskArtifactIds } from "../runtime/tasks.js";
import { ProfileRetention } from "../runtime/retention.js";
import { MaterialRetention } from "../runtime/material-retention.js";
import { taskHandlers } from "./tasks.js";
import { ApprovedPackageCatalog } from "./packages.js";
import type { VerifiedPackageSnapshot } from "../maintenance/npm.js";
import { atomicText, contains, privateDirectory } from "../runtime/paths.js";
import {
  CONTROL_OWNER,
  CONTROL_VERSION,
  materializeManagedControlScripts,
} from "../runtime/control-scripts.js";
import {
  ExtensionRegistry,
  type ExtensionHandle,
  type RegistryPolicy,
} from "../extensions/registry.js";
import { ResourceManager } from "../extensions/resources.js";
import { ExtensionMaterials } from "../extensions/materials.js";
import { ExtensionPackageLoader } from "../extensions/package-loader.js";
import type { AccessTarget, ExtensionFactory } from "../extensions/api.js";
import type {
  HostRequestBinding,
  HostRequestServices,
} from "../extensions/host-requests.js";
import { ArtifactStore } from "../results/artifacts.js";
import { ResultEncoder, type ResultScope } from "../results/encoder.js";
import { McpResultResources } from "../results/mcp.js";
import { TransferOfferDelivery } from "../transfer/offers.js";
import { TransferStreamSlots } from "../transfer/stream-slots.js";
import { TransferIoError } from "../transfer/io.js";
import { StateServices, type UserStateBackend } from "../services/state.js";
import {
  TransferServices,
  type TransferReservation,
  type TransferChannelBinding,
} from "../services/transfer.js";
import { ExtensionServices } from "../services/extensions.js";
import { ExtensionEnablement } from "../maintenance/npm.js";
import {
  maintenanceMethods,
  unavailableMaintenance,
  type MaintenanceRequests,
  type MaintenanceScope,
} from "../maintenance/requests.js";
import { runtimeExtension } from "../sdk/runtime.js";
import { stateExtension } from "../sdk/state.js";
import { outputExtension } from "../sdk/output-extension.js";
import { shExtension } from "../sdk/sh.js";
import { transferExtension } from "../sdk/transfer.js";
import { maintenanceExtension } from "../sdk/maintenance.js";
import { DocumentCatalog } from "../work/catalog.js";
import { WorkService, type PublishedMaterials } from "../work/service.js";
import { AgentAuthority } from "./authority.js";
import { ConfigurationSources } from "./activation.js";
import { CredentialVault } from "../maintenance/credentials.js";
import { ConfigurationMaintenanceBackend } from "../maintenance/configuration.js";
import { OAuthProvider, OAuthSessionService } from "../maintenance/oauth.js";
import { McpOAuthService } from "../adapters/mcp-oauth.js";
import type { MaintenanceBackend } from "../maintenance/requests.js";
import { AgentDataPlane } from "./data-plane.js";
import { CloudUserStateBackend } from "./user-state.js";
import type { ProfileConfiguration } from "./config.js";
import { AgentCatalog } from "./catalog.js";
import { ApplicationProcesses } from "./processes.js";
import { prepareRunAttachments, type AttachmentSource } from "./attachments.js";
import { dispatchApplication, type ApplicationHandler } from "./dispatcher.js";
import { projectRunView, projectRunRecord } from "./run-view.js";

export interface AgentControlPort {
  readonly binding: Readonly<WireConnectionV2>;
  readonly signal: AbortSignal;
  send(message: WireEventV2): Promise<void>;
  request<O extends WireOperationV2>(
    operation: O,
    context: WireInvocationContextV2,
    input: WireInputsV2[O],
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<WireOutputsV2[O]>;
}
/** Only the trusted application composition callback receives these Core objects. */
export interface ApplicationComponents {
  readonly store: SqliteStore;
  readonly engine: RunEngine;
  readonly artifacts: ArtifactStore;
  readonly encoder: ResultEncoder;
  readonly resources: ResourceManager;
  readonly modules: ModuleLoader;
  readonly extensions: ExtensionServices;
  readonly enablement: ExtensionEnablement;
  readonly registry: ExtensionRegistry;
  readonly streams: TransferStreamSlots;
  reserve(
    bytes: number,
    options?: { control?: boolean },
  ): Promise<{ release(): void }>;
  readonly signal: AbortSignal;
  control(): AgentControlPort;
  data(): AgentDataPlane;
  context(caller: Caller, projectId?: string | null): WireInvocationContextV2;
  scope(caller: Caller, signal: AbortSignal, runId?: string): MaintenanceScope;
  startLease(
    caller: Caller,
    source: WireAuthorizationRefreshInputV2,
    signal: AbortSignal,
  ): ApplicationAuthorityLease;
  onShutdown(join: () => Promise<void>): () => void;
  shipJson(
    value: JsonObject,
    purpose: "maintenance" | "host-request" | "result-meta",
    signal: AbortSignal,
    context?: WireInvocationContextV2,
    originInvocationId?: string,
    runId?: string,
  ): Promise<WireFixedStreamRefV2>;
  configurationBackend(): Promise<MaintenanceBackend>;
  refreshPackages(snapshot?: VerifiedPackageSnapshot): Promise<void>;
}
export interface AgentRuntimeOptions {
  readonly version?: string;
  readonly home?: string | null;
  readonly modulePolicy?: ModulePolicy;
  readonly extensionPermissions?: ReadonlySet<string>;
  readonly userState?: UserStateBackend;
  readonly shutdownWaitMs?: number;
  configureMaintenance?(
    components: ApplicationComponents,
  ): MaintenanceRequests | Promise<MaintenanceRequests>;
  dispatchMaintenance?(
    message: WireInvokeV2,
    scope: MaintenanceScope,
    components: ApplicationComponents,
    service: MaintenanceRequests,
    observerSignal: AbortSignal,
  ): Promise<unknown>;
}
export interface ApplicationAuthorityLease {
  readonly scope: MaintenanceScope;
  refresh(): Promise<void>;
  close(): void;
}
interface LeaseEntry {
  readonly caller: WireCallerV2;
  readonly projectId: string | null;
  readonly source: WireAuthorizationRefreshInputV2;
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  timer?: NodeJS.Timeout;
  active: boolean;
  refreshing?: Promise<void>;
  close(): void;
}
interface AcceptedRun {
  readonly originInvocationId: string;
  readonly context: WireInvocationContextV2;
  readonly services: RunServices;
  readonly announced: Promise<void>;
  readonly lease: ApplicationAuthorityLease;
  refreshing?: Promise<void>;
  notify: () => void;
}
interface Reservation {
  readonly core: TransferReservation;
  readonly transferId: string;
  readonly context: WireInvocationContextV2;
  consumed: boolean;
  readonly expiresAt: number;
}
const copy = <T>(value: T, max = 1024 * 1024): T =>
  JSON.parse(canonicalJson(value, max)) as T;
const iso = (value: number) => new Date(value).toISOString();
const platformOrigin = (namespace: string): ContributionOrigin => ({
  type: "platform",
  owner: CONTROL_OWNER,
  namespace,
  version: CONTROL_VERSION,
  revision: CONTROL_VERSION,
});

/** One process boot's actual Core composition. A control reconnect never creates another engine. */
export class AgentRuntime {
  #connection: AgentControlPort;
  #config: ProfileConfiguration;
  #options: AgentRuntimeOptions;
  #authority: AgentAuthority;
  #store: SqliteStore;
  #modules!: ModuleLoader;
  #scripts!: ScriptCatalog;
  #documents!: DocumentCatalog;
  #work!: WorkService;
  #engine!: RunEngine;
  #tasks!: RuntimeTasks;
  #approvedPackages!: ApprovedPackageCatalog;
  #resources: ResourceManager;
  #processes: ApplicationProcesses;
  #artifacts: ArtifactStore;
  #retention: ProfileRetention;
  #materialRetention: MaterialRetention;
  #registry!: ExtensionRegistry;
  #materials: ExtensionMaterials;
  #extensions!: ExtensionServices;
  #enablement!: ExtensionEnablement;
  #state: StateServices;
  #offers!: TransferOfferDelivery;
  #transfers!: TransferServices;
  #encoder!: ResultEncoder;
  #maintenance?: MaintenanceRequests;
  #configuration?: ConfigurationMaintenanceBackend;
  #configurationOpening?: Promise<ConfigurationMaintenanceBackend>;
  #configurationSources!: ConfigurationSources;
  #restoredOwners = new Set<string>();
  #restoringOwners = new Map<string, Promise<void>>();
  #platform: ExtensionHandle[] = [];
  #platformMaterials: PublishedMaterials = {
    instructions: [],
    skills: [],
    docs: [],
  };
  #slots = new TransferStreamSlots();
  #lifetime = new AbortController();
  #stopping = new AbortController();
  #leases = new Set<LeaseEntry>();
  #shutdownJoins = new Set<() => Promise<void>>();
  #invocation = new AsyncLocalStorage<WireInvokeV2>();
  #runs = new Map<string, AcceptedRun>();
  #reservations = new Map<string, Reservation>();
  #channels = new Map<
    string,
    { context: WireInvocationContextV2; originInvocationId: string }
  >();
  #announcements = new WeakMap<WireInvokeV2, Promise<void>>();
  #streams = new Set<Promise<void>>();
  #logTail: Promise<void> = Promise.resolve();
  #pendingLogBytes = 0;
  #pendingLogEntries = 0;
  #logErrorCode: string | null = null;
  #logWriterClosed = false;
  #catalog: AgentCatalog;
  #refreshTimer?: NodeJS.Timeout;
  #closing = false;
  #closed = false;
  #closeTask?: Promise<void>;
  private constructor(
    config: ProfileConfiguration,
    connection: AgentControlPort,
    bootId: string,
    options: AgentRuntimeOptions,
  ) {
    requireCondition(
      config.profile === connection.binding.profile &&
        bootId === connection.binding.bootId,
      "runtime_binding_mismatch",
      "The authenticated connection does not match this process profile and boot.",
    );
    this.#config = config;
    this.#connection = connection;
    this.#options = options;
    requireCondition(
      options.shutdownWaitMs === undefined ||
        (Number.isSafeInteger(options.shutdownWaitMs) &&
          options.shutdownWaitMs >= 1 &&
          options.shutdownWaitMs <= 30000),
      "invalid_configuration",
      "The shutdown observation must be bounded by thirty seconds.",
    );
    const root = realpathSync.native(config.root),
      work = privateDirectory(root, "work");
    for (const directory of ["modules", "tmp"])
      privateDirectory(work, directory);
    privateDirectory(root, "logs");
    if (!existsSync(path.join(work, "package.json")))
      atomicText(
        path.join(work, "package.json"),
        '{"private":true,"type":"module"}\n',
      );
    this.#store = new SqliteStore(
      root,
      connection.binding,
      Date.now(),
      bootId,
      {
        workIdleMs: config.retention?.work_idle_ms,
        runHistoryMs: config.retention?.run_history_ms,
        runLogsMs: config.retention?.run_logs_ms,
        inputAttachmentsMs: config.retention?.input_attachments_ms,
      },
    );
    this.#resources = new ResourceManager(this.#store);
    this.#processes = new ApplicationProcesses(this.#resources, {
      authorize: (caller, record, action) =>
        this.#processAuthority(caller, record, action),
    });
    this.#authority = new AgentAuthority(
      { ...this.#store.binding, bootId },
      work,
    );
    this.#authority.connect(connection.binding);
    this.#materialRetention = new MaterialRetention(root, {
      reserve: (bytes) => this.#retention.reserve(bytes),
      retentionMs: config.retention?.material_copies_ms,
      liveSnapshotRefs: () =>
        new Set([
          ...this.#store.workSnapshotRefs(Date.now()),
          ...(this.#engine?.activeSnapshotRefs() ?? []),
        ]),
      publishedDirectories: () =>
        new Set([
          ...(this.#materials?.activeDirectories() ?? []),
          ...(this.#documents?.activeDirectories() ?? []),
        ]),
    });
    this.#materials = new ExtensionMaterials(work, {
      reserve: (bytes) => this.#retention.reserve(bytes),
      materialRetention: this.#materialRetention,
    });
    this.#artifacts = new ArtifactStore(root, connection.binding.agentId, {
      maxFileBytes: 256 * 1024 * 1024,
      maxReadBytes: 64 * 1024 * 1024,
      retentionMs: config.retention?.artifact_ms,
      reserve: (bytes, options) => this.#retention.reserve(bytes, options),
      retentionUntil: (id, runId, originalExpiresAt) =>
        this.#store.taskArtifactRetentionUntil(
          id,
          runId,
          Date.now(),
          originalExpiresAt,
        ),
    });
    this.#retention = new ProfileRetention(this.#store, this.#artifacts, {
      maxManagedBytes: config.storage?.max_managed_bytes,
      materialRetention: this.#materialRetention,
    });
    this.#state = new StateServices(
      this.#store,
      options.userState ??
        new CloudUserStateBackend({
          control: () => this.#control(),
          context: (identity) => this.#context(identity),
        }),
      { reserve: (bytes) => this.#retention.reserve(bytes) },
    );
    this.#catalog = new AgentCatalog((data) =>
      this.#connection.send({
        type: "event",
        name: "agent.catalog.changed",
        connection: this.#connection.binding,
        data,
      }),
    );
  }
  static async create(
    config: ProfileConfiguration,
    connection: AgentControlPort,
    bootId: string,
    options: AgentRuntimeOptions = {},
  ): Promise<AgentRuntime> {
    const runtime = new AgentRuntime(config, connection, bootId, options);
    try {
      await runtime.#initialize();
      return runtime;
    } catch (cause) {
      await runtime.close().catch(() => {});
      throw cause;
    }
  }
  #components(): ApplicationComponents {
    return {
      store: this.#store,
      engine: this.#engine,
      artifacts: this.#artifacts,
      encoder: this.#encoder,
      resources: this.#resources,
      modules: this.#modules,
      extensions: this.#extensions,
      enablement: this.#enablement,
      registry: this.#registry,
      streams: this.#slots,
      reserve: (bytes, options) => this.#retention.reserve(bytes, options),
      signal: this.#stopping.signal,
      control: () => this.#control(),
      data: () => this.#data(),
      context: (caller, projectId) => this.#context(caller, projectId),
      scope: (caller, signal, runId) => this.#scope(caller, signal, runId),
      startLease: (caller, source, signal) =>
        this.#startLease(caller, source, signal),
      onShutdown: (join) => {
        this.#shutdownJoins.add(join);
        return () => {
          this.#shutdownJoins.delete(join);
        };
      },
      shipJson: (value, purpose, signal, context, origin, runId) =>
        this.#shipJson(value, purpose, signal, context, origin, runId),
      configurationBackend: () => this.#configurationBackend(),
      refreshPackages: async (snapshot) => {
        if (snapshot) await this.#approvedPackages.accept(snapshot);
        await this.#documents.refresh(this.#published().docs);
      },
    };
  }
  async #initialize(): Promise<void> {
    const work = path.join(this.#store.root, "work");
    await this.#retention.start();
    this.#approvedPackages = await ApprovedPackageCatalog.open(
      this.#store.root,
      this.#store.binding,
      { reserve: (bytes) => this.#retention.reserve(bytes) },
    );
    const policy = this.#options.modulePolicy ?? {
      builtins: () => defaultBuiltins,
      approvedPackages: () => this.#approvedPackages.approvedPackages(),
    };
    const importer = await this.#retention.reserve(65536, { control: true });
    try {
      this.#modules = await ModuleLoader.create(
        work,
        this.#store.bootId,
        policy,
      );
    } finally {
      importer.release();
    }
    this.#enablement = await ExtensionEnablement.open(this.#store.root, {
      reserve: (bytes) => this.#retention.reserve(bytes),
    });
    const controls = await materializeManagedControlScripts(
      work,
      (bytes, options) => this.#retention.reserve(bytes, options),
    );
    this.#scripts = new ScriptCatalog(work, this.#store.binding.agentId, () => [
      ...controls,
      ...this.#materials.scriptSources(),
    ]);
    this.#documents = new DocumentCatalog(work, this.#scripts, policy, {
      reserve: (bytes) => this.#retention.reserve(bytes),
      materialRetention: this.#materialRetention,
    });
    const permissions = new Set([
      "runtime.input",
      "storage.reserve",
      "output",
      "sh.execute",
      "sh.read",
      "sh.control",
      "mcp.use",
      "api.use",
      ...["agent", "user"].flatMap((scope) =>
        ["read", "write"].map((action) => `state.${scope}.${action}`),
      ),
      ...["createUpload", "createDownload", "get", "list", "cancel"].map(
        (action) => `transfer.${action}`,
      ),
      ...[...maintenanceMethods, "get", "list", "cancel"].map(
        (action) => `maintenance.${action}`,
      ),
      ...(this.#options.extensionPermissions ?? []),
    ]);
    this.#registry = new ExtensionRegistry(this.#resources, {
      permissions,
      authorize: (policy) => this.#registryAuthority(policy),
      log: (origin, entry, runId, operationId) => {
        requireCondition(
          !this.#logWriterClosed,
          "log_closed",
          "The extension log writer has finished its actual lifecycle.",
        );
        const bytes = Buffer.from(
          canonicalJson(
            {
              origin,
              ...entry,
              runId: runId ?? null,
              operationId: operationId ?? null,
            },
            65536,
          ) + "\n",
        );
        requireCondition(
          this.#pendingLogEntries < 128 &&
            this.#pendingLogBytes + bytes.length <= 4 * 1024 * 1024,
          "log_busy",
          "The bounded extension log writer is busy.",
        );
        this.#pendingLogBytes += bytes.length;
        this.#pendingLogEntries++;
        const task = this.#logTail
          .then(async () => {
            const ticket = await this.#retention.reserve(bytes.length);
            try {
              await appendFile(
                path.join(this.#store.root, "logs", "extensions.log"),
                bytes,
                { mode: 0o600 },
              );
            } finally {
              ticket.release();
            }
          })
          .finally(() => {
            this.#pendingLogBytes -= bytes.length;
            this.#pendingLogEntries--;
          });
        this.#logTail = task.catch((cause) => {
          this.#logErrorCode = isAgentError(cause)
            ? cause.code
            : "extension_log_failed";
        });
        this.#track(task);
      },
      progress: (_origin, runId) => this.#runs.get(runId)?.notify(),
      storage: { reserve: (bytes) => this.#retention.reserve(bytes) },
      state: (scope) => this.#state.bind(scope),
      transfer: (scope) => this.#transfers.bind(scope),
      maintenance: (scope) =>
        this.#maintenance?.bind(scope) ??
        unavailableMaintenance(scope.assertCurrent),
      hostRequests: (scope) => this.#hostRequests(scope),
    });
    this.#configurationSources = new ConfigurationSources(
      work,
      this.#registry,
      (bytes) => this.#retention.reserve(bytes),
      this.#materialRetention,
    );
    const packages = new ExtensionPackageLoader(this.#registry, this.#modules, {
      policy,
      permissions,
      enabled: () => this.#enablement.enabled(),
    });
    this.#extensions = new ExtensionServices(
      this.#registry,
      packages,
      this.#materials,
    );
    this.#offers = new TransferOfferDelivery({
      agentId: this.#store.binding.agentId,
      profileRoot: this.#store.root,
      authorize: (scope, snapshot) =>
        this.#transfers.authorizeDelivery(scope, snapshot),
    });
    this.#transfers = new TransferServices(
      this.#store,
      this.#resources,
      this.#artifacts,
      this.#offers,
      {
        prepare: (binding, signal) => this.#prepareTransfer(binding, signal),
        revoke: (binding, reason) => this.#revokeTransfer(binding, reason),
      },
      { origin: platformOrigin("transfer"), streams: this.#slots },
    );
    const mcp = new McpResultResources({
      agentId: this.#store.binding.agentId,
      profileRoot: this.#store.root,
      resolveResource: (source, scope) =>
        this.#registry.resolveMcpResource(source, scope),
    });
    this.#encoder = new ResultEncoder(this.#artifacts, {}, this.#offers, mcp);
    this.#work = new WorkService(this.#store, this.#scripts, this.#documents, {
      reserve: (bytes) => this.#retention.reserve(bytes),
      materialRetention: this.#materialRetention,
      home: this.#options.home === undefined ? homedir() : this.#options.home,
      agent: {
        name: "Nexum Agent",
        version: this.#options.version ?? CONTROL_VERSION,
        protocolVersion: "2",
        extensionApiVersion: "1",
      },
      authorize: (caller, target) => this.#authorize(caller, target),
      resolveProject: async (caller, target) => {
        const policy = this.#authority.current(
          caller,
          this.#projectFor(caller),
        );
        requireCondition(
          policy.projectId &&
            policy.projectRoot &&
            (!target.projectId || target.projectId === policy.projectId) &&
            (!target.path ||
              realpathSync.native(target.path) === policy.projectRoot),
          "project_not_found",
          "The project requires its current Cloud identity and canonical root.",
        );
        return {
          project: {
            projectId: policy.projectId,
            root: policy.projectRoot,
            name: policy.projectName ?? path.basename(policy.projectRoot),
            ...(policy.projectDescription === undefined
              ? {}
              : { description: policy.projectDescription }),
          },
          disabledItems: policy.projectContextVisibility?.disabledItems ?? [],
        };
      },
      materials: () => this.#published(),
      scriptUsage: (caller) => this.#store.scriptUsage(callerKey(caller)),
      canUseScript: (caller) => {
        try {
          this.#authorizeCaller(caller);
          return true;
        } catch {
          return false;
        }
      },
    });
    this.#engine = new RunEngine(this.#store, this.#modules, this.#scripts, {
      reserve: (bytes, options) => this.#retention.reserve(bytes, options),
      authorize: (caller, target) => this.#authorize(caller, target),
      loadWork: (work) => this.#work.load(work),
      resources: this.#resources,
      leaseScript: (origin) =>
        origin.type === "extension" ? this.#registry.lease(origin) : () => {},
      bindings: (services) => {
        this.#accepted(services);
        return this.#registry.bindings(services);
      },
      prepareAttachments: (references, directory, services) => {
        this.#accepted(services);
        return prepareRunAttachments(
          {
            work,
            slots: this.#slots,
            reserve: (bytes) => this.#retention.reserve(bytes),
            resolve: (ref, scope) => this.#attachment(ref, scope),
          },
          references,
          directory,
          services,
        );
      },
      encodeResult: async (value, services) => {
        const run = this.#accepted(services);
        const stored = await this.#encoder.encode(value, {
          ...this.#resultScope(
            run.context.caller,
            this.#store.getRun(services.runId),
            services.signal,
          ),
          controlStorage: services.controlStorage,
        });
        this.#store.pinTaskRunArtifacts(
          services.runId,
          localTaskArtifactIds(stored, this.#store.binding.agentId),
        );
        return stored;
      },
    });
    this.#tasks = new RuntimeTasks(this.#store, this.#engine, {
      reserve: (bytes, options) => this.#retention.reserve(bytes, options),
    });
    for (const [namespace, factory] of Object.entries({
      runtime: runtimeExtension,
      state: stateExtension,
      output: outputExtension,
      sh: shExtension,
      transfer: transferExtension,
      maintenance: maintenanceExtension,
    })) {
      const handle = await this.#registry.prepare(
        {
          apiVersion: 1,
          origin: platformOrigin(namespace),
          permissions: [...permissions],
        },
        factory,
      );
      this.#registry.publish(handle);
      this.#platform.push(handle);
      const directory = privateDirectory(work, "docs", "platform");
      const filename = path.join(directory, namespace + ".md");
      const text =
        `# ${namespace} SDK\n\n` +
        handle.methods
          .map(
            (method) => "```json\n" + canonicalJson(method, 65536) + "\n```\n",
          )
          .join("\n");
      const ticket = await this.#retention.reserve(
        Buffer.byteLength(text) + 1024,
        { control: true },
      );
      try {
        atomicText(filename, text);
      } finally {
        ticket.release();
      }
      this.#platformMaterials.docs = [
        ...this.#platformMaterials.docs,
        {
          name: namespace,
          description: `${namespace} SDK 参数和返回约定`,
          path: filename,
          owner: CONTROL_OWNER,
          version: CONTROL_VERSION,
        },
      ];
    }
    const instruction =
      "本地文件和操作系统基础能力使用当前允许的 Node/npm。SDK 原子能力由 runtime、state、output、sh、transfer、maintenance 提供，参数以 work/docs/platform 文档为准。脚本返回真实值或 output 包装，由平台适配 MCP；本地路径字符串不会自动变成图片。长任务用现有运行和资源身份继续控制，观察等待结束不代表任务已停止。";
    this.#platformMaterials.instructions = [
      {
        instructionId: "platform-runtime",
        kind: "platform",
        path: null,
        scope: { type: "agent", root: work },
        origin: { ...platformOrigin("nexum"), revision: digest(instruction) },
        content: instruction,
        truncated: false,
      },
    ];
    if (this.#options.configureMaintenance)
      this.#maintenance = await this.#options.configureMaintenance(
        this.#components(),
      );
    for (const name of this.#enablement.enabled())
      await this.#extensions.enable(
        name,
        this.#enablement.get(name)?.config ?? {},
      );
    await this.#documents.refresh(this.#published().docs);
    this.#refreshTimer = setInterval(() => {
      for (const entry of this.#runs.values())
        if (
          !terminalStatuses.has(this.#store.getRun(entry.services.runId).status)
        )
          void this.#refresh(entry).catch(() => {});
      for (const entry of this.#leases)
        void this.#refreshLease(entry).catch(() => {});
    }, 10000);
    this.#refreshTimer.unref();
  }
  #published(): PublishedMaterials {
    const extra = this.#materials.published();
    const adapters = this.#configurationSources?.published() ?? {
      instructions: [],
      docs: [],
      skills: [],
    };
    return {
      instructions: [
        ...this.#platformMaterials.instructions,
        ...extra.instructions,
        ...adapters.instructions,
      ],
      skills: [...this.#platformMaterials.skills, ...extra.skills],
      docs: [...this.#platformMaterials.docs, ...extra.docs, ...adapters.docs],
    };
  }
  #configurationBackend(): Promise<ConfigurationMaintenanceBackend> {
    return (this.#configurationOpening ??= (async () => {
      const credentials = await CredentialVault.open(this.#store.root, {
        reserve: (bytes) => this.#retention.reserve(bytes),
      });
      const oauth = new OAuthProvider(credentials);
      const backend = await ConfigurationMaintenanceBackend.open({
        root: this.#store.root,
        agentId: this.#store.binding.agentId,
        profile: this.#store.binding.profile,
        credentials,
        reserve: (bytes) => this.#retention.reserve(bytes),
        oauth,
        oauthSessions: new OAuthSessionService(oauth, {
          root: this.#store.root,
          reserve: (bytes) => this.#retention.reserve(bytes),
        }),
        mcpOAuth: new McpOAuthService(credentials),
        activation: this.#configurationSources,
        runtimeScope: (request) => ({
          ...this.#scope(
            request.context.caller as unknown as Caller,
            request.signal,
            typeof request.context.runId === "string"
              ? request.context.runId
              : undefined,
          ),
          signal: request.signal,
          operationId: request.operationId,
        }),
      });
      this.#configuration = backend;
      return backend;
    })().catch((cause) => {
      this.#configurationOpening = undefined;
      throw cause;
    }));
  }
  async #restoreConfigurations(caller: Caller): Promise<void> {
    if (!this.#configuration || this.#restoredOwners.has(caller.principalId))
      return;
    const pending = this.#restoringOwners.get(caller.principalId);
    if (pending) return pending;
    const task = (async () => {
      const result = await this.#configuration!.restore(
        this.#scope(caller, this.#stopping.signal),
      );
      if (result.every((value) => value.state === "ready"))
        this.#restoredOwners.add(caller.principalId);
      await this.#documents.refresh(this.#published().docs);
    })();
    this.#restoringOwners.set(caller.principalId, task);
    try {
      await task;
    } finally {
      this.#restoringOwners.delete(caller.principalId);
    }
  }
  #control(): AgentControlPort {
    requireCondition(
      !this.#closed && !this.#connection.signal.aborted,
      "connection_closed",
      "The authenticated control observation is unavailable.",
    );
    return this.#connection;
  }
  #data(connection = this.#connection): AgentDataPlane {
    return new AgentDataPlane({
      serverUrl: this.#config.serverUrl,
      token: this.#config.token,
      binding: connection.binding,
      maxJsonBytes: 128 * 1024 * 1024,
      assertCurrent: () => {
        requireCondition(
          !this.#closed && connection.binding.bootId === this.#store.bootId,
          "runtime_closed",
          "The original Agent boot has closed.",
        );
      },
    });
  }
  #processAuthority(
    caller: Caller,
    record: ResourceHistoryRecord | null,
    action: "read" | "stop",
  ): void {
    requireCondition(
      caller.source === "owner_session",
      "forbidden",
      "Managed process control requires the current owner session.",
    );
    this.#authorizeCaller(caller);
    if (!record) return;
    requireCondition(
      record.originRunId,
      "process_unavailable",
      "The process lacks its actual accepted Run identity.",
    );
    const run = this.#store.getRun(record.originRunId);
    let scope: string | null;
    try {
      scope = this.#boundProject(caller, run.projectId);
    } catch (cause) {
      if (
        String(this.#invocation.getStore()?.operation) ===
          "agent.process.list" &&
        isAgentError(cause) &&
        cause.code === "authorization_scope_mismatch"
      )
        throw new AgentError(
          "forbidden",
          "This process is outside the current Project inspection scope.",
        );
      throw cause;
    }
    const work = this.#store.getWork(run.contextId);
    this.#authority.authorize(
      caller,
      { type: "path", value: work.pwd, access: "read" },
      scope,
    );
    const details = record.diagnostic.details ?? {};
    requireCondition(
      isPlainRecord(details),
      "process_unavailable",
      "The registered process facts must remain an ordinary data object.",
    );
    const cwd = details.cwd;
    if (cwd !== undefined) {
      requireCondition(
        typeof cwd === "string" && path.isAbsolute(cwd),
        "process_unavailable",
        "The registered process has invalid working-directory facts.",
      );
      this.#authority.authorize(
        caller,
        { type: "path", value: cwd, access: "read" },
        scope,
      );
    }
    this.#authority.authorize(
      caller,
      { type: "resource", value: record.resourceId, access: action },
      scope,
    );
  }
  #ownerRunInspection(caller: Caller, runId: string): boolean {
    const invoke = this.#invocation.getStore();
    return (
      caller.source === "owner_session" &&
      invoke?.context.caller.source === "owner_session" &&
      String(invoke.operation) === "agent.run.inspect" &&
      (invoke.input as { runId?: string }).runId === runId &&
      invoke.context.caller.sessionRef === caller.sessionRef &&
      callerKey(invoke.context.caller) === callerKey(caller)
    );
  }
  #boundProject(caller: Caller, projectId: string | null): string | null {
    const invoke = this.#invocation.getStore();
    if (
      invoke &&
      callerKey(invoke.context.caller) === callerKey(caller) &&
      invoke.context.caller.grantId === caller.grantId &&
      invoke.context.caller.source === caller.source
    ) {
      const current = invoke.context.authorization.projectId ?? null;
      requireCondition(
        current === null || current === projectId,
        "authorization_scope_mismatch",
        "An explicit Project scope cannot control a different retained Project.",
      );
      return current;
    }
    return projectId;
  }
  #projectFor(caller: Caller, runId?: string): string | null {
    if (runId) {
      const run = this.#store.getRun(runId);
      requireCondition(
        run.callerKey === callerKey(caller) ||
          this.#ownerRunInspection(caller, runId),
        "forbidden",
        "The runtime scope belongs to another caller.",
      );
      return this.#boundProject(caller, run.projectId);
    }
    const invoke = this.#invocation.getStore();
    return invoke &&
      callerKey(invoke.context.caller) === callerKey(caller) &&
      invoke.context.caller.grantId === caller.grantId
      ? (invoke.context.authorization.projectId ?? null)
      : null;
  }
  #authorizeCaller(
    caller: Caller,
    target?: AccessTarget,
    projectId = this.#projectFor(caller),
  ): void {
    this.#authority.authorize(caller, target, projectId);
  }
  #context(
    caller: Caller,
    projectId = this.#projectFor(caller),
  ): WireInvocationContextV2 {
    return this.#authority.context(caller as WireCallerV2, projectId);
  }
  #scope(
    caller: Caller,
    signal: AbortSignal,
    runId?: string,
    projectId = this.#projectFor(caller, runId),
  ): MaintenanceScope {
    const bound = copy(caller),
      scoped = AbortSignal.any([signal, this.#stopping.signal]);
    const run = runId ? this.#store.getRun(runId) : undefined;
    const pwd = run
      ? this.#store.getWork(run.contextId).pwd
      : path.join(this.#store.root, "work");
    const check = () => {
      scoped.throwIfAborted();
      this.#authorizeCaller(bound, undefined, projectId);
      if (run)
        this.#authorizeCaller(
          bound,
          { type: "path", value: pwd, access: "read" },
          projectId,
        );
    };
    check();
    return {
      caller: bound,
      operationId: this.#invocation.getStore()?.id ?? newId("scope"),
      ...(runId ? { runId } : {}),
      pwd,
      signal: scoped,
      assertCurrent: check,
      authorize: (target) => {
        check();
        this.#authorizeCaller(bound, target, projectId);
      },
    };
  }
  #startLease(
    caller: Caller,
    source: WireAuthorizationRefreshInputV2,
    signal: AbortSignal,
    projectId = this.#projectFor(caller),
  ): ApplicationAuthorityLease {
    validateContract("wire.input:authorization.refresh", source);
    const controller = new AbortController();
    const scope = this.#scope(
      caller,
      AbortSignal.any([signal, controller.signal]),
      source.runId,
      projectId,
    );
    const entry: LeaseEntry = {
      caller: copy(caller) as WireCallerV2,
      projectId,
      source: copy(source),
      signal: scope.signal,
      controller,
      active: true,
      close: () => {
        if (!entry.active) return;
        entry.active = false;
        clearTimeout(entry.timer);
        entry.signal.removeEventListener("abort", entry.close);
        this.#leases.delete(entry);
      },
    };
    entry.signal.addEventListener("abort", entry.close, { once: true });
    this.#leases.add(entry);
    if (entry.signal.aborted) entry.close();
    else this.#scheduleLease(entry);
    return {
      scope,
      refresh: () => this.#refreshLease(entry),
      close: entry.close,
    };
  }
  #scheduleLease(entry: LeaseEntry): void {
    clearTimeout(entry.timer);
    if (!entry.active) return;
    try {
      const policy = this.#authority.current(entry.caller, entry.projectId);
      if (entry.source.runId)
        this.#authority.authorize(
          entry.caller,
          {
            type: "path",
            value: this.#store.getWork(
              this.#store.getRun(entry.source.runId).contextId,
            ).pwd,
            access: "read",
          },
          entry.projectId,
        );
      const remaining = Date.parse(policy.expiresAt) - Date.now();
      if (remaining <= 0)
        throw new AgentError(
          "authorization_expired",
          "The current authorization lease has expired.",
        );
      entry.timer = setTimeout(
        () => this.#scheduleLease(entry),
        Math.min(remaining + 1, 2_147_483_647),
      );
      entry.timer.unref();
    } catch (cause) {
      entry.controller.abort(cause);
    }
  }
  #revokeLeases(caller: Caller): void {
    const cause = new AgentError(
      "authorization_revoked",
      "The authenticated Cloud revoked this caller's authorization.",
    );
    for (const entry of this.#leases)
      if (
        callerKey(entry.caller) === callerKey(caller) &&
        entry.caller.grantId === caller.grantId
      )
        entry.controller.abort(cause);
  }
  async #refreshLease(entry: LeaseEntry): Promise<void> {
    if (!entry.active) return;
    if (entry.refreshing) return entry.refreshing;
    entry.refreshing = (async () => {
      const observed = this.#authority.capture(entry.caller, entry.projectId);
      if (
        Date.parse(observed.context.authorization.expiresAt) - Date.now() >
        15000
      )
        return;
      const fresh = await this.#control().request(
        "authorization.refresh",
        observed.context,
        entry.source,
        entry.signal,
        10000,
      );
      if (entry.active) {
        this.#authority.refresh(observed, fresh.authorization);
        this.#scheduleLease(entry);
      }
    })();
    try {
      await entry.refreshing;
    } catch (cause) {
      if (
        isAgentError(cause) &&
        [
          "forbidden",
          "unauthorized",
          "grant_revoked",
          "grant_expired",
          "authorization_denied",
          "authorization_revoked",
          "authorization_expired",
        ].includes(cause.code)
      )
        entry.controller.abort(cause);
      throw cause;
    } finally {
      entry.refreshing = undefined;
    }
  }
  #authorize(
    caller: Caller,
    target: {
      action: string;
      run?: RunRecord;
      work?: WorkRecord;
      path?: string;
      project?: { root: string } | null;
    },
  ): void {
    if (
      target.run &&
      target.action === "get" &&
      this.#ownerRunInspection(caller, target.run.runId)
    ) {
      const scope = this.#boundProject(caller, target.run.projectId);
      this.#authority.authorize(
        caller,
        {
          type: "path",
          value: this.#store.getWork(target.run.contextId).pwd,
          access: "read",
        },
        scope,
      );
      return;
    }
    if (this.#closing) {
      requireCondition(
        target.run &&
          target.run.callerKey === callerKey(caller) &&
          ["cancel", "get"].includes(target.action),
        "runtime_closed",
        "The Agent is no longer admitting business work.",
      );
      return;
    }
    const projectId = target.run
      ? this.#boundProject(caller, target.run.projectId)
      : target.work
        ? this.#boundProject(caller, target.work.projectId)
        : this.#projectFor(caller);
    this.#authorizeCaller(caller, undefined, projectId);
    const work =
      target.work ??
      (target.run ? this.#store.getWork(target.run.contextId) : undefined);
    if (work) {
      requireCondition(
        work.callerKey === callerKey(caller),
        "forbidden",
        "This work or run belongs to another caller.",
      );
      this.#authorizeCaller(
        caller,
        {
          type: "path",
          value: work.pwd,
          access: "read",
        },
        projectId,
      );
    }
    if (target.path || target.project)
      this.#authorizeCaller(
        caller,
        {
          type: "path",
          value: target.path ?? target.project!.root,
          access: "read",
        },
        projectId,
      );
  }
  #registryAuthority(policy: RegistryPolicy): void {
    if (policy.context) {
      const caller = policy.context.caller as unknown as Caller;
      this.#authorizeCaller(
        caller,
        policy.target,
        this.#projectFor(caller, policy.runId),
      );
      return;
    }
    requireCondition(
      !this.#closing || policy.action === "disable",
      "runtime_closed",
      "The Agent extension environment is stopping.",
    );
    if (policy.target?.type === "path")
      requireCondition(
        this.#configurationSources?.authorizeInstance(
          policy.origin,
          policy.target,
        ) ||
          (path.isAbsolute(policy.target.value) &&
            (contains(
              path.join(this.#store.root, "work"),
              path.resolve(policy.target.value),
            ) ||
              contains(
                path.join(this.#store.root, "logs"),
                path.resolve(policy.target.value),
              ))),
        "path_not_allowed",
        "Instance filesystem access stays in its own public work and logs.",
      );
  }
  #resultScope(
    caller: Caller,
    run?: RunRecord,
    signal = this.#lifetime.signal,
  ): ResultScope {
    const projectId = this.#projectFor(caller, run?.runId);
    const pwd = run
      ? this.#store.getWork(run.contextId).pwd
      : path.join(this.#store.root, "work");
    return {
      pwd,
      ownerKey: callerKey(caller),
      grantId: caller.grantId,
      signal,
      ...(run ? { runId: run.runId } : {}),
      assertCurrent: () => this.#authorizeCaller(caller, undefined, projectId),
      authorizeTarget: (target) =>
        this.#authorizeCaller(caller, target, projectId),
      authorize: (target) => {
        this.#authorizeCaller(caller, undefined, projectId);
        if (target.path)
          this.#authorizeCaller(
            caller,
            {
              type: "path",
              value: target.path,
              access: target.action === "register" ? "read" : target.action,
            },
            projectId,
          );
        if (target.resource?.originRunId)
          this.#authorize(caller, {
            action: "get",
            run: this.#store.getRun(target.resource.originRunId),
          });
      },
    };
  }
  #accepted(services: RunServices): AcceptedRun {
    const previous = this.#runs.get(services.runId);
    if (previous) return previous;
    const origin = this.#invocation.getStore();
    requireCondition(
      origin,
      "run_origin_unavailable",
      "The accepted run needs its actual original authenticated invocation.",
    );
    const context = copy(origin.context);
    requireCondition(
      (context.authorization.projectId ?? null) ===
        this.#store.getRun(services.runId).projectId,
      "authorization_scope_mismatch",
      "The accepted run origin must retain its actual work Project scope.",
    );
    const lease = this.#startLease(
      context.caller,
      { runId: services.runId, originInvocationId: origin.id },
      services.signal,
      context.authorization.projectId ?? null,
    );
    const stop = () => {
      if (!this.#closing && !services.signal.aborted) {
        const cause = lease.scope.signal.reason;
        this.#engine.stopAcceptedRun(services.runId, {
          code: isAgentError(cause) ? cause.code : "authorization_revoked",
        });
      }
    };
    if (lease.scope.signal.aborted) stop();
    else lease.scope.signal.addEventListener("abort", stop, { once: true });
    const announce = this.#connection.send({
      type: "event",
      name: "agent.run.changed",
      connection: this.#connection.binding,
      data: {
        originInvocationId: origin.id,
        runId: services.runId,
        revision: this.#store.getRun(services.runId).revision,
        status: this.#store.getRun(services.runId).status,
        observedAt: new Date().toISOString(),
      },
    });
    void announce.catch(() => {});
    this.#announcements.set(origin, announce);
    const entry: AcceptedRun = {
      originInvocationId: origin.id,
      context,
      services,
      announced: announce,
      lease,
      notify: () => {
        if (this.#closed) return;
        const row = this.#store.getRun(services.runId);
        if (!this.#connection.signal.aborted)
          void this.#connection
            .send({
              type: "event",
              name: "agent.run.changed",
              connection: this.#connection.binding,
              data: {
                runId: row.runId,
                revision: row.revision,
                status: row.status,
                observedAt: new Date().toISOString(),
              },
            })
            .catch(() => {});
        if (terminalStatuses.has(row.status)) {
          lease.close();
          this.#engine.off(services.runId, entry.notify);
          this.#runs.delete(services.runId);
        }
      },
    };
    this.#runs.set(services.runId, entry);
    this.#engine.on(services.runId, entry.notify);
    return entry;
  }
  async #refresh(entry: AcceptedRun): Promise<void> {
    await entry.announced;
    await entry.lease.refresh();
  }
  #track(task: Promise<void>): void {
    this.#streams.add(task);
    void task.finally(() => this.#streams.delete(task)).catch(() => {});
  }
  async #failedStream(
    control: AgentControlPort,
    context: WireInvocationContextV2,
    stream: WireFixedStreamRefV2,
    cause: unknown,
  ): Promise<never> {
    try {
      await control.request(
        "stream.revoke",
        this.#authority.cleanupContext(context.caller, context),
        {
          streamId: stream.streamId,
          reason: {
            code: isAgentError(cause) ? cause.code : "stream_failed",
            message: "The fixed stream producer could not complete.",
          },
        },
        this.#lifetime.signal,
      );
    } catch {
      /* The original failure remains; a disconnected Cloud owns its expiry. */
    }
    throw cause;
  }
  async #shipJson(
    value: JsonObject,
    purpose: "maintenance" | "host-request" | "result-meta",
    signal: AbortSignal,
    supplied?: WireInvocationContextV2,
    originId?: string,
    runId?: string,
  ): Promise<WireFixedStreamRefV2> {
    const invoke = this.#invocation.getStore();
    const context = supplied ?? invoke?.context;
    requireCondition(
      context && (originId ?? invoke?.id),
      "invocation_origin_unavailable",
      "A fixed stream needs its original authenticated invocation.",
    );
    const announced = invoke ? this.#announcements.get(invoke) : undefined;
    if (announced) await announced;
    const permit = this.#slots.tryAcquire();
    requireCondition(
      permit,
      "transfer_busy",
      "All actual file stream slots are occupied.",
    );
    let prepared:
      { control: AgentControlPort; stream: WireFixedStreamRefV2 } | undefined;
    try {
      const bytes = Buffer.from(canonicalJson(value, 128 * 1024 * 1024));
      const control = this.#control();
      const output = await control.request(
        "stream.prepare",
        this.#context(context.caller, context.authorization.projectId ?? null),
        {
          originInvocationId: originId ?? invoke!.id,
          ...(runId ? { runId } : {}),
          purpose,
          direction: "agent-to-cloud",
          expiresAt: iso(Date.now() + 5 * 60_000),
          maxBytes: bytes.length || 1,
          mimeType: "application/json",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        signal,
      );
      prepared = { control, stream: output.stream };
      const lease = this.#startLease(
        context.caller,
        {
          streamId: output.stream.streamId,
          originInvocationId: originId ?? invoke!.id,
        },
        signal,
        context.authorization.projectId ?? null,
      );
      const task = this.#data(control)
        .sendFixedBody(output.stream, bytes, lease.scope.signal)
        .catch((cause) =>
          this.#failedStream(control, context, output.stream, cause),
        )
        .finally(() => {
          lease.close();
          permit.release();
        });
      this.#track(task);
      return output.stream;
    } catch (cause) {
      permit.release();
      if (prepared)
        await this.#failedStream(
          prepared.control,
          context,
          prepared.stream,
          cause,
        );
      throw cause;
    }
  }
  #hostRequests(binding: HostRequestBinding): HostRequestServices | undefined {
    const accepted = this.#runs.get(binding.runId);
    if (!accepted?.context.caller.hostRef) return undefined;
    const caller = accepted.context.caller,
      capabilities = caller.hostCapabilities;
    if (!capabilities) return undefined;
    const request = async (
      action: "sampling" | "elicitation" | "roots",
      params: JsonObject = {},
      options?: { signal?: AbortSignal },
    ): Promise<JsonObject> => {
      requireCondition(
        capabilities[action],
        "host_capability_unavailable",
        "The original Host session did not provide this capability.",
      );
      await accepted.announced;
      await this.#refresh(accepted);
      binding.assertCurrent();
      const signal = options?.signal
        ? AbortSignal.any([binding.signal, options.signal])
        : binding.signal;
      const body = await this.#shipJson(
        params,
        "host-request",
        signal,
        accepted.context,
        accepted.originInvocationId,
        accepted.services.runId,
      );
      const response = await this.#control().request(
        "host.request",
        this.#context(caller, accepted.context.authorization.projectId ?? null),
        {
          runId: binding.runId,
          originInvocationId: accepted.originInvocationId,
          hostRef: caller.hostRef!,
          action,
          body,
        },
        signal,
      );
      const permit = this.#slots.tryAcquire();
      requireCondition(
        permit,
        "transfer_busy",
        "All actual file stream slots are occupied.",
      );
      let result: JsonValue;
      try {
        result = await this.#data().readJson(response.body, signal);
      } finally {
        permit.release();
      }
      requireCondition(
        result && typeof result === "object" && !Array.isArray(result),
        "invalid_host_response",
        "A Host response must be an ordinary protocol object.",
      );
      return result as JsonObject;
    };
    return {
      capabilities: Object.fromEntries(
        (["sampling", "elicitation", "roots"] as const).flatMap((action) =>
          capabilities[action] &&
          (caller.hostFeatures === undefined ||
            caller.hostFeatures[action] !== undefined)
            ? [
                [
                  action,
                  caller.hostFeatures?.[action] ??
                    (action === "elicitation" ? { form: {} } : {}),
                ],
              ]
            : [],
        ),
      ),
      assertCurrent: () => {
        binding.assertCurrent();
        this.#authorizeCaller(
          caller,
          undefined,
          accepted.context.authorization.projectId ?? null,
        );
      },
      sampling: (params, options) => request("sampling", params, options),
      elicitation: (params, options) => request("elicitation", params, options),
      roots: (options) => request("roots", {}, options),
    };
  }
  async #attachment(
    reference: JsonObject,
    services: RunServices,
  ): Promise<AttachmentSource> {
    const accepted = this.#accepted(services);
    await accepted.announced;
    await this.#refresh(accepted);
    if (typeof reference.sourceId === "string") {
      const control = this.#control();
      const controllerCaller =
        this.#invocation.getStore()?.context.caller ?? accepted.context.caller;
      const response = await control.request(
        "attachment.open",
        this.#context(controllerCaller),
        {
          sourceId: reference.sourceId,
          originInvocationId:
            this.#invocation.getStore()?.id ?? accepted.originInvocationId,
          runId: services.runId,
        },
        services.signal,
      );
      return {
        name: response.name,
        mimeType: response.mimeType,
        size: response.size ?? response.stream.size,
        sha256: response.sha256 ?? response.stream.sha256,
        open: async () =>
          this.#data(control).openRead(response.stream, services.signal),
      };
    }
    const scope = this.#resultScope(
      accepted.context.caller,
      this.#store.getRun(services.runId),
      services.signal,
    );
    let uri: string;
    if (typeof reference.uri === "string") uri = reference.uri;
    else {
      requireCondition(
        typeof reference.transferId === "string",
        "invalid_attachment",
        "An attachment requires a normalized source or an owned committed resource.",
      );
      const transfer = await this.#transfers
        .bind({
          context: services.context,
          runId: services.runId,
          signal: services.signal,
          deadline: services.deadlineAt,
          assertCurrent: services.assertCurrent,
          authorize: (target) =>
            this.#authorizeCaller(
              accepted.context.caller,
              target,
              this.#store.getRun(services.runId).projectId,
            ),
        })
        .get(reference.transferId);
      requireCondition(
        transfer.status === "succeeded" &&
          transfer.direction === "upload" &&
          transfer.file,
        "attachment_unavailable",
        "The upload has not committed its actual input file.",
      );
      const fixed = await this.#artifacts.register(
        {
          path: transfer.file.path,
          name: transfer.file.name,
          mimeType: transfer.file.mimeType,
        },
        scope,
      );
      requireCondition(
        fixed.size === transfer.file.size &&
          fixed.sha256 === transfer.file.sha256,
        "file_changed",
        "The committed upload changed before this input preparation.",
      );
      uri = fixed.uri;
    }
    const metadata = await this.#artifacts.metadata(uri, scope);
    return {
      name: metadata.name,
      mimeType: metadata.mimeType,
      size: metadata.size,
      sha256: metadata.sha256,
      open: async () => {
        const input = await this.#artifacts.open(uri, scope);
        return { readable: input.stream, closed: input.closed };
      },
    };
  }
  async #prepareTransfer(binding: TransferChannelBinding, signal: AbortSignal) {
    const runId = this.#store.getResource(binding.resourceId).originRunId;
    requireCondition(
      runId,
      "run_origin_unavailable",
      "The transfer resource has no accepted creator run.",
    );
    const accepted = this.#runs.get(runId);
    requireCondition(
      accepted,
      "run_origin_unavailable",
      "The transfer needs its accepted run origin.",
    );
    await accepted.announced;
    await this.#refresh(accepted);
    const context = this.#context(
      binding.caller,
      accepted.context.authorization.projectId ?? null,
    );
    this.#channels.set(binding.transferId, {
      context,
      originInvocationId: accepted.originInvocationId,
    });
    const result = await this.#control().request(
      "transfer.prepare",
      context,
      {
        transferId: binding.transferId,
        resourceId: binding.resourceId,
        runId,
        contextId: this.#store.getRun(runId).contextId,
        projectId: this.#store.getRun(runId).projectId,
        direction: binding.direction,
        claimDeadlineAt: iso(binding.claimDeadlineAt),
        maxBytes: binding.maxBytes,
        target: binding.target,
      },
      signal,
    );
    return result.request;
  }
  async #revokeTransfer(
    binding: TransferChannelBinding,
    reason: { kind: any; code: string },
  ): Promise<void> {
    const previous = this.#channels.get(binding.transferId);
    if (!previous) return;
    const control = this.#control();
    const context = this.#authority.cleanupContext(
      binding.caller as WireCallerV2,
      previous.context,
    );
    await control.request(
      "transfer.revoke",
      context,
      { transferId: binding.transferId, reason },
      this.#lifetime.signal,
    );
    this.#channels.delete(binding.transferId);
  }
  async attachConnection(connection: AgentControlPort): Promise<void> {
    requireCondition(
      !this.#closing,
      "runtime_closed",
      "The Agent runtime is stopping.",
    );
    this.#authority.connect(connection.binding);
    this.#connection = connection;
  }
  async event(message: WireEventV2, signal: AbortSignal): Promise<void> {
    validateContract("wire", message);
    validateConnectionV2(message.connection, this.#connection.binding);
    if (message.name === "agent.catalog.sync")
      await this.#catalog.sync(message.data, signal);
    else if (message.name === "agent.authorization.changed") {
      if (message.data.authorization === null) {
        this.#authority.revoke(message.data.caller);
        this.#revokeLeases(message.data.caller);
      } else {
        this.#authority.observe({
          caller: message.data.caller,
          authorization: message.data.authorization,
          connection: message.connection,
        });
        for (const lease of this.#leases)
          if (callerKey(lease.caller) === callerKey(message.data.caller))
            this.#scheduleLease(lease);
      }
    } else
      throw new AgentError(
        "invalid_control_direction",
        "This event is not an Agent application entry.",
      );
  }
  async dispatch(message: WireInvokeV2, signal: AbortSignal): Promise<unknown> {
    requireCondition(
      !this.#closing,
      "runtime_closed",
      "The Agent runtime is stopping.",
    );
    validateContract("wire", message);
    validateConnectionV2(message.context.connection, this.#connection.binding);
    if (message.context.caller.source === "owner_session")
      requireCondition(
        [
          "agent.project.resolve",
          "agent.project.inspect",
          "agent.project.close",
          "agent.run.inspect",
          "agent.context.read",
          "agent.process.list",
          "agent.process.get",
          "agent.process.stop",
        ].includes(message.operation),
        "invalid_control_direction",
        "An owner Console session has only its declared Project and managed-process operations.",
      );
    this.#authority.observe(message.context);
    for (const lease of this.#leases)
      if (callerKey(lease.caller) === callerKey(message.context.caller))
        this.#scheduleLease(lease);
    return this.#invocation.run(copy(message), async () => {
      if (message.context.caller.source !== "owner_session")
        await this.#restoreConfigurations(message.context.caller);
      return dispatchApplication(
        message,
        this.#connection.binding,
        this.#handlers(message, signal),
      );
    });
  }
  #handlers(
    message: WireInvokeV2,
    signal: AbortSignal,
  ): Record<string, ApplicationHandler> {
    const caller = message.context.caller;
    const view = (value: RunView | RunDetails) =>
      projectRunView(value, {
        encoder: this.#encoder,
        scope: this.#resultScope(caller, value.run, signal),
        budgets: this.#authority.current(caller, this.#projectFor(caller))
          .budgets,
        shipJson: (value: JsonObject, purpose: "result-meta") =>
          this.#shipJson(value, purpose, this.#lifetime.signal),
      });
    const handlers: Record<string, ApplicationHandler> = {
      ...taskHandlers(this.#tasks, {
        caller,
        signal,
        project: view,
        beforeInput: async (runId) => {
          const run = this.#store.getRun(runId);
          this.#authorize(caller, { action: "input", run });
          await this.#control().send({
            type: "event",
            name: "agent.run.changed",
            connection: this.#connection.binding,
            data: {
              originInvocationId: message.id,
              runId,
              revision: run.revision,
              status: run.status,
              observedAt: new Date().toISOString(),
            },
          });
        },
      }),
      "agent.project.resolve": (input) => {
        const root = realpathSync.native(input.path);
        requireCondition(
          statSync(root).isDirectory(),
          "project_not_found",
          "A project root must be a real directory.",
        );
        try {
          this.#authorizeCaller(caller, {
            type: "path",
            value: root,
            access: "read",
          });
        } catch (cause) {
          if (isAgentError(cause) && cause.code === "path_not_allowed")
            throw new AgentError(
              "project_not_allowed",
              "The canonical project directory requires current owner approval.",
              { canonicalPath: root },
            );
          throw cause;
        }
        return { root, name: path.basename(root) };
      },
      "agent.open": (input) => this.#work.open(caller, input, signal),
      "agent.project.close": async (input) => {
        const result = await this.#work.closeProject(
          caller,
          input.projectId,
          signal,
        );
        return { ...result, closedAt: iso(result.closedAt as number) };
      },
      "agent.project.inspect": (input) =>
        this.#work.inspect(
          caller,
          {
            agentId: this.#store.binding.agentId,
            projectId: input.projectId,
            ...(input.contextId ? { contextId: input.contextId } : {}),
          },
          signal,
        ),
      "agent.close": (input) => {
        const result = this.#work.close(caller, input.contextId);
        return { ...result, closedAt: iso(result.closedAt as number) };
      },
      "agent.run.start": async (input) => {
        const work = this.#store.activeWork(input.contextId, callerKey(caller));
        requireCondition(
          (message.context.authorization.projectId ?? null) === work.projectId,
          "authorization_scope_mismatch",
          "A new Run must use its actual work Project authorization.",
        );
        const { submission: _submission, ...normalized } = input;
        return view(await this.#engine.start(caller, normalized, signal));
      },
      "agent.run.get": async (input) =>
        view(await this.#engine.get(caller, input, signal)),
      "agent.run.inspect": async (input) => {
        requireCondition(
          caller.source === "owner_session",
          "forbidden",
          "Only a current owner Console session may inspect retained Run facts.",
        );
        const retained = await this.#engine.get(
          caller,
          {
            agentId: this.#store.binding.agentId,
            runId: input.runId,
            waitMs: 0,
          },
          signal,
        );
        return projectRunView(retained, {
          encoder: this.#encoder,
          scope: this.#resultScope(caller, retained.run, signal),
          budgets: this.#authority.current(
            caller,
            this.#projectFor(caller, retained.run.runId),
          ).budgets,
          readOnly: true,
          shipJson: async () => {
            throw new AgentError(
              "read_only_view",
              "A retained Console inspection cannot allocate a new data stream.",
            );
          },
        });
      },
      "agent.run.input": async (input) => {
        const run = this.#store.getRun(input.runId);
        this.#authorize(caller, { action: "input", run });
        await this.#control().send({
          type: "event",
          name: "agent.run.changed",
          connection: this.#connection.binding,
          data: {
            originInvocationId: message.id,
            runId: run.runId,
            revision: run.revision,
            status: run.status,
            observedAt: new Date().toISOString(),
          },
        });
        return view(await this.#engine.input(caller, input, signal));
      },
      "agent.run.cancel": async (input) => {
        const result = this.#engine.cancel(caller, input.runId);
        return { accepted: result.accepted, view: await view(result) };
      },
      "agent.run.list": (input) => {
        const page = this.#engine.list(caller, input);
        return {
          runs: page.runs.map((row) =>
            projectRunRecord(this.#store.getRun(row.runId), {
              root: this.#store.root,
              availability: Object.fromEntries(
                ["code", "input", "result", "logs"].map((key) => [
                  key,
                  ["available", "too_large"].includes(
                    String(row.availability[key]),
                  ),
                ]),
              ) as {
                code: boolean;
                input: boolean;
                result: boolean;
                logs: boolean;
              },
            }),
          ),
          nextCursor: page.nextCursor,
          observedAt: new Date().toISOString(),
        };
      },
      "agent.context.read": (input) => this.#readContext(caller, input, signal),
      "agent.process.list": (input) => {
        if (input.projectId !== undefined)
          this.#boundProject(caller, input.projectId);
        return this.#processes.list(caller, input);
      },
      "agent.process.get": (input) => this.#processes.get(caller, input),
      "agent.process.stop": (input) => this.#processes.stop(caller, input),
      "agent.resources.list": (input) =>
        this.#listResources(caller, input, signal),
      "agent.resources.read": (input) =>
        this.#readResource(caller, input, signal),
      "agent.transfer.reserveClaim": (input) =>
        this.#reserve(caller, input.transferId),
      "agent.transfer.releaseReservation": (input) => {
        const reservation = this.#reservation(caller, input);
        this.#transfers.releaseReservation(reservation.core);
        this.#reservations.delete(input.reservationId);
        return { transferId: input.transferId, released: true };
      },
      "agent.transfer.commitClaim": (input) => this.#commit(caller, input),
    };
    for (const operation of [
      "agent.maintenance.draft.read",
      "agent.maintenance.draft.prepare",
      "agent.maintenance.draft.verify",
      "agent.maintenance.draft.notify",
      "agent.maintenance.oauth.start",
      "agent.maintenance.oauth.complete",
      "agent.maintenance.execute",
      "agent.maintenance.get",
      "agent.maintenance.cancel",
    ])
      handlers[operation] = async (input) => {
        requireCondition(
          this.#maintenance,
          "maintenance_unavailable",
          "This process has no configured maintenance backend.",
        );
        const scope = this.#scope(caller, this.#stopping.signal);
        if (this.#options.dispatchMaintenance)
          return this.#options.dispatchMaintenance(
            message,
            scope,
            this.#components(),
            this.#maintenance,
            signal,
          );
        if (operation === "agent.maintenance.get")
          return this.#maintenance.get(input.requestId, scope);
        if (operation === "agent.maintenance.cancel")
          return this.#maintenance.cancel(input.requestId, scope);
        if (operation === "agent.maintenance.execute")
          return this.#maintenance.execute(input.requestId, scope);
        throw new AgentError(
          "maintenance_unavailable",
          "This process has no configured maintenance body adapter.",
        );
      };
    return handlers;
  }
  async #readContext(
    caller: Caller,
    input: {
      contextId: string;
      revision: number;
      itemId: string;
      cursor?: string;
      maxBytes: number;
      relativePath?: string;
      includeEntries?: boolean;
      startLine?: number;
      maxLines?: number;
    },
    signal: AbortSignal,
  ) {
    const work = this.#store.activeWork(input.contextId, callerKey(caller));
    requireCondition(
      work.revision === input.revision,
      "context_revision_mismatch",
      "The work materials changed; refresh the work first.",
    );
    if (input.includeEntries) {
      requireCondition(
        !input.cursor,
        "invalid_cursor",
        "A complete bounded Skill tree has no byte cursor.",
      );
      const { entries } = await this.#work.readMaterialEntries(
        caller,
        input.contextId,
        input.itemId,
        input.relativePath,
        signal,
      );
      const bytes = canonicalJson(entries, 65536);
      requireCondition(
        Buffer.byteLength(bytes) <=
          Math.min(
            input.maxBytes,
            this.#authority.current(caller, this.#projectFor(caller)).budgets
              .textBytes ?? 65536,
          ),
        "context_budget_exceeded",
        "The complete Skill tree exceeds the current metadata budget.",
      );
      return {
        contextId: input.contextId,
        revision: input.revision,
        itemId: input.itemId,
        contentRevision: digest(bytes),
        text: "",
        complete: true,
        nextCursor: null,
        entries,
        treeTruncated: false,
      };
    }
    const material = await this.#work.readMaterial(
      caller,
      input.contextId,
      input.itemId,
      input.relativePath,
      signal,
    );
    let offset = 0;
    requireCondition(
      !input.cursor || input.startLine === undefined,
      "invalid_cursor",
      "A continuation cannot switch its original line position.",
    );
    if (input.startLine !== undefined && input.startLine > 1) {
      let line = 1;
      while (offset < material.bytes.length && line < input.startLine)
        if (material.bytes[offset++] === 10) line++;
      requireCondition(
        line === input.startLine,
        "context_line_out_of_range",
        "The requested line is beyond this actual material.",
      );
    }
    if (input.cursor) {
      const cursor = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString("utf8"),
      );
      requireCondition(
        cursor.contextId === input.contextId &&
          cursor.itemId === input.itemId &&
          (cursor.relativePath ?? null) === (input.relativePath ?? null) &&
          cursor.revision === material.revision &&
          Number.isSafeInteger(cursor.offset) &&
          cursor.offset >= 0 &&
          cursor.offset <= material.bytes.length,
        "invalid_cursor",
        "The material cursor is stale or invalid.",
      );
      offset = cursor.offset;
    }
    const maximum = Math.min(
      input.maxBytes,
      this.#authority.current(caller, this.#projectFor(caller)).budgets
        .textBytes ?? 65536,
      65536,
    );
    let end = Math.min(material.bytes.length, offset + maximum);
    const maximumLines = input.maxLines ?? 1000;
    let selectedLines = 0;
    for (let position = offset; position < end; position++)
      if (material.bytes[position] === 10 && ++selectedLines >= maximumLines) {
        end = position + 1;
        break;
      }
    while (
      end > offset &&
      end < material.bytes.length &&
      (material.bytes[end]! & 0xc0) === 0x80
    )
      end--;
    requireCondition(
      end > offset || end === material.bytes.length,
      "context_budget_exceeded",
      "The current material budget cannot contain its next UTF-8 character.",
    );
    const complete = end === material.bytes.length;
    let startLine = 1,
      lineBreaks = 0;
    for (let position = 0; position < offset; position++)
      if (material.bytes[position] === 10) startLine++;
    for (let position = offset; position < end; position++)
      if (material.bytes[position] === 10) lineBreaks++;
    return {
      contextId: input.contextId,
      revision: input.revision,
      itemId: input.itemId,
      contentRevision: material.revision,
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        material.bytes.subarray(offset, end),
      ),
      startLine,
      endLine:
        startLine +
        lineBreaks -
        (end > offset && material.bytes[end - 1] === 10 ? 1 : 0),
      startsMidLine: offset > 0 && material.bytes[offset - 1] !== 10,
      endsMidLine:
        end < material.bytes.length &&
        (end === offset || material.bytes[end - 1] !== 10),
      complete,
      nextCursor: complete
        ? null
        : Buffer.from(
            canonicalJson({
              contextId: input.contextId,
              itemId: input.itemId,
              ...(input.relativePath !== undefined
                ? { relativePath: input.relativePath }
                : {}),
              revision: material.revision,
              offset: end,
            }),
          ).toString("base64url"),
    };
  }
  async #listResources(
    caller: Caller,
    input: { limit?: number; cursor?: string },
    signal: AbortSignal,
  ) {
    const page = await this.#artifacts.list(
      this.#resultScope(caller, undefined, signal),
      {
        ...input,
        maxBytes: Math.max(
          1,
          (this.#authority.current(caller, this.#projectFor(caller)).budgets
            .textBytes ?? 65536) - 1024,
        ),
      },
    );
    return {
      resources: page.resources.map(({ uri, name, mimeType, size }) => ({
        uri,
        name,
        mimeType,
        size,
      })),
      nextCursor: page.nextCursor,
    };
  }
  async #readResource(
    caller: Caller,
    input: { uri: string; maxBytes: number },
    signal: AbortSignal,
  ) {
    const scope = this.#resultScope(caller, undefined, signal);
    if (/^nexum:\/\/agents\/[^/]+\/mcp\//.test(input.uri)) {
      requireCondition(
        this.#encoder.mcp,
        "mcp_source_unavailable",
        "The registered MCP resource source is unavailable.",
      );
      const budgets = this.#authority.current(
        caller,
        this.#projectFor(caller),
      ).budgets;
      const limits = { ...this.#encoder.limits };
      for (const key of [
        "textBytes",
        "imageBytes",
        "audioBytes",
        "inlineBytes",
        "responseBytes",
      ] as const)
        if (budgets[key] !== undefined)
          limits[key] = Math.min(limits[key], budgets[key]);
      limits.inlineBytes = Math.min(limits.inlineBytes, input.maxBytes);
      const result = await this.#encoder.mcp.readResource(
        input.uri,
        scope,
        limits,
      );
      validateContract("wire.body:ResourcesRead", result);
      return {
        body: await this.#shipJson(
          result,
          "result-meta",
          this.#lifetime.signal,
        ),
      };
    }
    const metadata = await this.#artifacts.metadata(input.uri, scope);
    requireCondition(
      metadata.size <=
        Math.min(
          input.maxBytes,
          this.#authority.current(caller, this.#projectFor(caller)).budgets
            .fileBytes ?? 256 * 1024 * 1024,
        ),
      "resource_too_large",
      "The resource exceeds its current read budget.",
    );
    const text = /^(text\/|application\/(json|javascript|xml|yaml)(;|$))/.test(
      metadata.mimeType,
    );
    if (
      text &&
      metadata.size <=
        Math.min(
          65536,
          this.#authority.current(caller, this.#projectFor(caller)).budgets
            .textBytes ?? 65536,
        )
    ) {
      const resource = await this.#artifacts.open(input.uri, scope);
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of resource.stream) chunks.push(chunk as Buffer);
        await resource.closed;
        return {
          contents: [
            {
              uri: input.uri,
              mimeType: metadata.mimeType,
              text: new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            },
          ],
        };
      } finally {
        resource.stream.destroy();
        await resource.closed.catch(() => {});
      }
    }
    const invoke = this.#invocation.getStore()!,
      control = this.#control();
    const permit = this.#slots.tryAcquire();
    requireCondition(
      permit,
      "transfer_busy",
      "All actual file stream slots are occupied.",
    );
    let prepared:
      | { context: WireInvocationContextV2; stream: WireFixedStreamRefV2 }
      | undefined;
    try {
      const context = this.#context(caller);
      const { stream } = await control.request(
        "stream.prepare",
        context,
        {
          originInvocationId: invoke.id,
          resourceUri: input.uri,
          purpose: "resource",
          direction: "agent-to-cloud",
          expiresAt: iso(
            Math.min(Date.parse(metadata.expiresAt), Date.now() + 5 * 60_000),
          ),
          maxBytes: metadata.size || 1,
          mimeType: metadata.mimeType,
          size: metadata.size,
          sha256: metadata.sha256,
        },
        signal,
      );
      prepared = { context, stream };
      const lease = this.#startLease(
        caller,
        { streamId: stream.streamId, originInvocationId: invoke.id },
        this.#lifetime.signal,
      );
      const task = (async () => {
        let source: Awaited<ReturnType<ArtifactStore["open"]>> | undefined;
        try {
          source = await this.#artifacts.open(input.uri, {
            ...scope,
            signal: lease.scope.signal,
          });
          await this.#data(control).sendFixedBody(
            stream,
            source.stream,
            lease.scope.signal,
          );
          await source.closed;
        } finally {
          source?.stream.destroy();
          await source?.closed.catch(() => {});
        }
      })()
        .catch((cause) => this.#failedStream(control, context, stream, cause))
        .finally(() => {
          lease.close();
          permit.release();
        });
      this.#track(task);
      return {
        contents: [{ uri: input.uri, mimeType: metadata.mimeType, stream }],
      };
    } catch (cause) {
      permit.release();
      if (prepared)
        await this.#failedStream(
          control,
          prepared.context,
          prepared.stream,
          cause,
        );
      throw cause;
    }
  }
  #reserve(caller: WireCallerV2, transferId: string) {
    for (const [id, value] of this.#reservations)
      if (!value.consumed && value.expiresAt <= Date.now())
        this.#reservations.delete(id);
    requireCondition(
      this.#reservations.size < 512,
      "transfer_busy",
      "Too many transfer observations are pending.",
    );
    const context = this.#context(caller);
    const projectId = context.authorization.projectId ?? null;
    const core = this.#transfers.reserveClaim(transferId, {
      binding: { ...this.#store.binding, bootId: this.#store.bootId },
      caller,
      signal: this.#lifetime.signal,
      assertCurrent: () => this.#authorizeCaller(caller, undefined, projectId),
      authorize: (target) => this.#authorizeCaller(caller, target, projectId),
    });
    const reservationId = newId("reservation");
    this.#reservations.set(reservationId, {
      core,
      transferId,
      context,
      consumed: false,
      expiresAt: Date.now() + 5000,
    });
    const record = this.#store.getTransfer(transferId, {
      callerKey: callerKey(caller),
      owner: platformOrigin("transfer"),
    });
    return {
      transferId,
      reservationId,
      expiresAt: iso(
        Math.min(
          record.claimDeadlineAt ?? Date.now() + 5000,
          Date.now() + 5000,
        ),
      ),
      direction: record.direction,
      maxBytes: record.metadata.maxBytes!,
    };
  }
  #reservation(
    caller: WireCallerV2,
    input: { transferId: string; reservationId: string },
  ): Reservation {
    const reservation = this.#reservations.get(input.reservationId);
    requireCondition(
      reservation &&
        !reservation.consumed &&
        reservation.transferId === input.transferId &&
        callerKey(reservation.context.caller) === callerKey(caller) &&
        reservation.context.caller.grantId === caller.grantId,
      "invalid_transfer_reservation",
      "The claim must use its actual original Core reservation.",
    );
    return reservation;
  }
  async #commit(caller: WireCallerV2, input: any) {
    const reservation = this.#reservation(caller, input);
    reservation.consumed = true;
    const claim = {
      transferId: input.transferId,
      reservationId: input.reservationId,
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#lifetime.signal, controller.signal]);
    let lease: ApplicationAuthorityLease | undefined;
    let transportClosed: Promise<void> | undefined;
    let enteredCore = false;
    const knownClosure = (closed: Promise<void>) => {
      transportClosed = closed;
      const observed = closed.catch((cause) => {
        throw new TransferIoError(
          isAgentError(cause) ? cause.code : "transfer_failed",
          "The authenticated data stream failed after physical closure.",
          false,
          true,
          undefined,
          cause,
        );
      });
      void observed.catch(() => {});
      return observed;
    };
    try {
      const control = this.#control(),
        data = this.#data(control);
      const source = this.#channels.get(input.transferId);
      requireCondition(
        source,
        "transfer_origin_unavailable",
        "The transfer has no original approved channel source.",
      );
      lease = this.#startLease(
        caller,
        {
          transferId: input.transferId,
          originInvocationId: source.originInvocationId,
        },
        signal,
        reservation.context.authorization.projectId ?? null,
      );
      if (input.stream.direction === "agent-to-cloud") {
        const stream = data.openWrite(input.stream, lease.scope.signal, claim);
        enteredCore = true;
        return await this.#transfers.commitClaim(reservation.core, {
          download: stream.writable,
          closed: knownClosure(stream.closed),
        });
      }
      // The existing reservation is consumed before waiting for response headers
      // or the Host's first upload byte. A native Readable supplies the deferred I/O.
      const opening = data.openRead(input.stream, lease.scope.signal, claim);
      void opening.catch(() => {});
      let actual: Awaited<typeof opening> | undefined;
      const readable = Readable.from(
        (async function* () {
          actual = await opening;
          yield* actual.readable;
        })(),
      );
      const closed = opening.then((stream) => stream.closed);
      void closed.catch(() => {});
      readable.once("close", () => {
        if (!readable.readableEnded) controller.abort();
        actual?.readable.destroy();
        void opening.then(
          (stream) => stream.readable.destroy(),
          () => {},
        );
      });
      enteredCore = true;
      return await this.#transfers.commitClaim(reservation.core, {
        upload: readable,
        closed: knownClosure(closed),
        ...(input.contentLength === undefined
          ? {}
          : { contentLength: input.contentLength }),
      });
    } catch (cause) {
      controller.abort(cause);
      await transportClosed?.catch(() => {});
      if (!enteredCore) {
        try {
          this.#transfers.releaseReservation(reservation.core);
        } catch {
          /* Core's own expiration may already have released it. */
        }
      }
      throw cause;
    } finally {
      lease?.close();
      this.#reservations.delete(input.reservationId);
    }
  }
  close(): Promise<void> {
    return (this.#closeTask ??= (async () => {
      if (this.#closed) return;
      this.#closing = true;
      this.#stopping.abort(
        new AgentError("runtime_closed", "The Agent process is stopping."),
      );
      await Promise.all([...this.#shutdownJoins].map((join) => join()));
      clearInterval(this.#refreshTimer);
      await this.#catalog.close();
      if (this.#engine)
        for (const entry of this.#runs.values())
          if (
            !terminalStatuses.has(
              this.#store.getRun(entry.services.runId).status,
            )
          )
            this.#engine.cancel(entry.context.caller, entry.services.runId);
      const cleanup = await this.#resources.shutdown({
        code: "agent_shutdown",
      });
      requireCondition(
        cleanup.unconfirmed.length === 0,
        "shutdown_unconfirmed",
        "Some actual native resources have not confirmed closure.",
      );
      this.#lifetime.abort(
        new AgentError("runtime_closed", "The Agent process is stopping."),
      );
      await Promise.allSettled([...this.#streams]);
      if (this.#engine)
        for (const entry of this.#runs.values()) {
          const observed = await this.#engine.observe(
            entry.context.caller,
            entry.services.runId,
            this.#options.shutdownWaitMs ?? 30000,
          );
          requireCondition(
            terminalStatuses.has(observed.run.status),
            "shutdown_unconfirmed",
            "An accepted JavaScript execution has not actually settled.",
          );
          this.#engine.off(entry.services.runId, entry.notify);
        }
      await this.#configurationSources?.close();
      if (this.#extensions)
        for (const item of this.#extensions.list())
          requireCondition(
            (await this.#extensions.disable(item.name as string)).status ===
              "disabled",
            "shutdown_unconfirmed",
            "An enabled extension has not confirmed closure.",
          );
      if (this.#registry)
        for (const handle of [...this.#platform].reverse())
          requireCondition(
            (await this.#registry.disable(handle)).status === "disabled",
            "shutdown_unconfirmed",
            "A platform extension has not confirmed closure.",
          );
      this.#logWriterClosed = true;
      await this.#logTail;
      await Promise.allSettled([...this.#streams]);
      await this.#work?.drain();
      await this.#retention.stop();
      this.#closed = true;
      this.#store.close();
    })().catch((cause) => {
      this.#closeTask = undefined;
      throw cause;
    }));
  }
}
