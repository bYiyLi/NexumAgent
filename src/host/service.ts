import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { Console } from "node:console";
import { finished } from "node:stream/promises";
import {
  AgentError,
  isAgentError,
  requireCondition,
} from "../contracts/errors.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import { inspectExtensionPackage } from "../extensions/packages.js";
import { ModuleLoader } from "../runtime/modules.js";
import { bindGoScope, HostRunner, type GoMethod } from "./runner.js";
import { HostRunLog } from "./run-log.js";
import { encodeHostResult, type HostResultServices } from "./result.js";
import type { HostBrandServices } from "./brands.js";
import { HostPackagePolicy } from "./package-policy.js";
import {
  inspectConsoleAgent,
  type ConsoleSourceSnapshot,
} from "./console-inspect.js";
import { inspectProfileInventory } from "./profile-inspection.js";
import type { ScriptSource } from "../runtime/scripts.js";
import { MaterialRPC } from "./material-rpc.js";
import { MaterialWorkers } from "./material-workers.js";
import { RunPreparation } from "./run-preparation.js";
import { createRunServices } from "./run-services.js";
import { prepareSourceMaterials } from "./source-materials.js";
import {
  ExtensionWorkers,
  type ExtensionInvocation,
} from "./extension-workers.js";
import { parseExtensionApproval } from "./extension-runtime.js";
import type { WorkOptions } from "../work/service.js";

type Call = (
  method: string,
  params: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
export interface HostRunServices {
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly brands: HostBrandServices;
  readonly result: HostResultServices;
}
interface PackageChange {
  id: string;
  begin: Promise<void>;
  mainAcquired: boolean;
  extensionAcquired: boolean;
  finish?: Promise<{ restartRequired: boolean }>;
}

/** Handles private requests after the transport has authenticated its parent process. */
export class HostService {
  readonly #instanceId: string;
  readonly #call: Call;
  readonly #lifetime: AbortSignal;
  readonly #runServices?: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<HostRunServices>;
  #materials: MaterialRPC | MaterialWorkers;
  #runner?: HostRunner;
  #loader?: ModuleLoader;
  #packages?: HostPackagePolicy;
  #extensions?: ExtensionWorkers;
  #preparation?: RunPreparation;
  #executionReady = false;
  #defaultRunServices?: (
    runId: string,
    signal: AbortSignal,
    context: unknown,
  ) => HostRunServices;
  #packageChange?: PackageChange;
  #configuring = false;
  #profileAgentId?: string;
  #profileRoot?: string;
  #profileHome: string | null = null;
  #previousCPU?: { total: number; time: bigint };
  #closed = false;
  #closeTask?: Promise<void>;

  constructor(
    instanceId: string,
    call: Call,
    lifetime: AbortSignal = new AbortController().signal,
    runServices?: (
      runId: string,
      signal: AbortSignal,
    ) => Promise<HostRunServices>,
  ) {
    this.#instanceId = instanceId;
    this.#call = call;
    this.#lifetime = lifetime;
    this.#runServices = runServices;
    this.#materials = new MaterialRPC(instanceId);
  }

  async configure(value: unknown): Promise<object> {
    requireCondition(
      !this.#closed &&
        !this.#runner &&
        !this.#configuring &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.profileRoot === "string" &&
        path.isAbsolute(value.profileRoot) &&
        (value.profile === "development" || value.profile === "production"),
      "invalid_host_configuration",
      "The host configuration is invalid or already active.",
    );
    this.#configuring = true;
    try {
      const root = realpathSync.native(value.profileRoot);
      requireCondition(
        root === value.profileRoot,
        "invalid_host_configuration",
        "The profile root cannot redirect.",
      );
      const work = path.join(root, "work");
      requireCondition(
        realpathSync.native(work) === work,
        "invalid_host_configuration",
        "The work directory cannot redirect.",
      );
      let extensionBinding:
        | {
            agentId: string;
            profile: "development" | "production";
            cloudEnvironment: string;
          }
        | undefined;
      let bootId: string | undefined;
      if (value.binding !== undefined || value.bootId !== undefined) {
        requireCondition(
          isPlainRecord(value.binding) &&
            typeof value.binding.agentId === "string" &&
            value.binding.agentId.length > 0 &&
            value.binding.agentId.length <= 256 &&
            value.binding.profile === value.profile &&
            value.binding.cloudEnvironment === value.profile &&
            typeof value.bootId === "string" &&
            /^[A-Za-z0-9_-]{1,128}$/.test(value.bootId),
          "runtime_binding_mismatch",
          "The host binding does not match its authenticated profile.",
        );
        extensionBinding = {
          agentId: value.binding.agentId,
          profile: value.profile,
          cloudEnvironment: value.profile,
        };
        bootId = value.bootId;
      }
      let agent: WorkOptions["agent"] | undefined;
      let home: string | null = null;
      if (value.agent !== undefined || value.home !== undefined) {
        requireCondition(
          extensionBinding &&
            bootId &&
            isPlainRecord(value.agent) &&
            typeof value.agent.name === "string" &&
            value.agent.name.length > 0 &&
            typeof value.agent.version === "string" &&
            value.agent.version.length > 0 &&
            typeof value.agent.protocolVersion === "string" &&
            value.agent.protocolVersion.length > 0 &&
            (value.home === null ||
              (typeof value.home === "string" && path.isAbsolute(value.home))),
          "invalid_host_configuration",
          "The Agent material metadata is invalid.",
        );
        agent = JSON.parse(
          canonicalJson(value.agent, 4096),
        ) as WorkOptions["agent"];
        home = value.home as string | null;
      }
      const packages = await HostPackagePolicy.open(root);
      try {
        const loader = await ModuleLoader.create(
          work,
          `host_${randomUUID()}`,
          packages.policy,
        );
        requireCondition(
          !this.#closed,
          "host_closing",
          "The Node host is closing.",
        );
        this.#packages = packages;
        this.#loader = loader;
        this.#runner = new HostRunner(loader);
        if (extensionBinding && bootId)
          this.#extensions = new ExtensionWorkers(
            root,
            extensionBinding,
            bootId,
            this.#instanceId,
            this.#call,
          );
        if (extensionBinding && bootId && agent) {
          this.#materials.close();
          this.#materials = new MaterialWorkers(
            root,
            extensionBinding,
            bootId,
            this.#instanceId,
            home,
            agent,
            this.#call,
          );
          this.#preparation = new RunPreparation(
            root,
            extensionBinding.agentId,
            this.#instanceId,
          );
          const agentId = extensionBinding.agentId;
          this.#profileAgentId = agentId;
          this.#profileRoot = root;
          this.#profileHome = home;
          this.#defaultRunServices = (runId, signal, context) =>
            createRunServices(
              root,
              agentId,
              this.#instanceId,
              this.#call,
              runId,
              signal,
              context,
            );
        }
      } catch (cause) {
        await packages.close();
        throw cause;
      }
      // Full execution readiness also needs resource, input, extension and result wiring.
      return {
        configured: true,
        executionReady: false,
        resultEncoding: "stored-v1",
      };
    } finally {
      this.#configuring = false;
    }
  }

  async inspectProfile(value: unknown, signal: AbortSignal): Promise<object> {
    requireCondition(
      !this.#closed &&
        this.#packages &&
        this.#profileRoot &&
        this.#profileAgentId &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        value.agentId === this.#profileAgentId &&
        Array.isArray(value.scriptSources) &&
        value.scriptSources.length <= 100,
      "profile_unavailable",
      "The authenticated Agent profile is unavailable.",
    );
    const sources: ScriptSource[] = [];
    for (const raw of value.scriptSources) {
      requireCondition(
        isPlainRecord(raw) &&
          (raw.type === "platform" || raw.type === "extension") &&
          typeof raw.owner === "string" &&
          typeof raw.namespace === "string" &&
          typeof raw.version === "string" &&
          typeof raw.directory === "string",
        "invalid_profile_sources",
        "The registered script source is invalid.",
      );
      sources.push(raw as unknown as ScriptSource);
    }
    signal.throwIfAborted();
    const inventory = await inspectProfileInventory({
      root: this.#profileRoot,
      agentId: this.#profileAgentId,
      home: this.#profileHome,
      packages: this.#packages.policy.approvedPackages(),
      scriptSources: sources,
      signal,
    });
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const total = cpu.user + cpu.system;
    const previous = this.#previousCPU;
    this.#previousCPU = { total, time: now };
    const elapsedMicros = previous ? Number(now - previous.time) / 1000 : 0;
    const cpuPercent =
      previous && elapsedMicros >= 100_000
        ? Math.max(
            0,
            Math.min(100, ((total - previous.total) / elapsedMicros) * 100),
          )
        : undefined;
    const observedAt = new Date().toISOString();
    return {
      observedAt,
      resources: inventory.resources,
      telemetry: {
        ...(cpuPercent === undefined
          ? {}
          : { cpuPercent: Math.round(cpuPercent * 10) / 10 }),
        memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        scope: "node_host",
        observedAt,
      },
      complete: inventory.complete,
      ...(inventory.warnings.length ? { warnings: inventory.warnings } : {}),
    };
  }

  async ready(value: unknown, signal: AbortSignal): Promise<object> {
    requireCondition(
      !this.#closed &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        process.version === "v24.22.1" &&
        this.#runner &&
        this.#loader &&
        this.#packages &&
        this.#materials instanceof MaterialWorkers &&
        this.#preparation &&
        this.#defaultRunServices &&
        this.#extensions?.platformsReady(),
      "host_services_unavailable",
      "The required Node services are not ready.",
    );
    const required = [
      "runs",
      "authorization",
      "input",
      "resources",
      "artifacts",
      "state",
      "transfer",
      "maintenance",
      "packages",
      "materials",
    ];
    const supplied = await this.#call(
      "host.services",
      { instanceId: this.#instanceId },
      signal,
    );
    requireCondition(
      isPlainRecord(supplied) &&
        supplied.instanceId === this.#instanceId &&
        Array.isArray(supplied.services) &&
        required.every((name) =>
          (supplied.services as unknown[]).includes(name),
        ),
      "host_services_unavailable",
      "The Go Agent did not supply its required services.",
    );
    const execute = await this.#loader.compileIsolated("return null;", {});
    try {
      await execute();
    } finally {
      await execute.close();
    }
    requireCondition(
      !this.#closed && !signal.aborted && this.#extensions?.platformsReady(),
      "host_services_unavailable",
      "The required Node services stopped during preparation.",
    );
    this.#executionReady = true;
    return { executionReady: true, resultEncoding: "stored-v1" };
  }

  async inspectConsole(value: unknown, signal: AbortSignal): Promise<object> {
    requireCondition(
      !this.#closed &&
        this.#executionReady &&
        this.#materials instanceof MaterialWorkers &&
        this.#packages &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        value.agentId === this.#materials.binding.agentId &&
        Array.isArray(value.sourceSnapshot) &&
        value.sourceSnapshot.length <= 200 &&
        (value.resourceId === undefined ||
          (typeof value.resourceId === "string" &&
            /^res_[0-9a-f]{64}$/.test(value.resourceId))) &&
        (value.filePath === undefined ||
          (typeof value.filePath === "string" &&
            value.resourceId !== undefined &&
            value.filePath.length > 0 &&
            value.filePath.length <= 1024)),
      "console_inspection_unavailable",
      "The read-only Agent snapshot is unavailable.",
    );
    return inspectConsoleAgent({
      agentId: this.#materials.binding.agentId,
      work: path.join(this.#materials.root, "work"),
      home: this.#materials.home,
      sources: value.sourceSnapshot as ConsoleSourceSnapshot[],
      approvedPackages: this.#packages.policy.approvedPackages(),
      ...(typeof value.resourceId === "string"
        ? { requestedResourceId: value.resourceId }
        : {}),
      ...(typeof value.filePath === "string"
        ? { requestedFilePath: value.filePath }
        : {}),
      signal,
    });
  }

  prepareRun(value: unknown, signal: AbortSignal): unknown {
    requireCondition(
      !this.#closed && this.#preparation,
      "run_preparation_unavailable",
      "Run preparation requires the authenticated profile services.",
    );
    return this.#preparation.prepare(value, signal);
  }

  validateInput(value: unknown): object {
    requireCondition(
      !this.#closed && this.#preparation,
      "run_preparation_unavailable",
      "Input validation requires the authenticated profile services.",
    );
    return this.#preparation.validate(value);
  }

  async execute(value: unknown, signal: AbortSignal): Promise<unknown> {
    requireCondition(
      this.#runner &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.runId === "string" &&
        value.runId.length > 0 &&
        value.runId.length <= 256 &&
        typeof value.code === "string" &&
        Buffer.byteLength(value.code) <= 1024 * 1024 &&
        Array.isArray(value.methods) &&
        isPlainRecord(value.context) &&
        value.context.runId === value.runId &&
        (value.filename === undefined || typeof value.filename === "string"),
      "invalid_run_scope",
      "The Go Run request is invalid.",
    );
    const runId = value.runId;
    const context = JSON.parse(canonicalJson(value.context)) as unknown;
    const services = this.#runServices
      ? await this.#runServices(runId, signal)
      : this.#executionReady
        ? this.#defaultRunServices!(runId, signal, context)
        : undefined;
    if (services)
      requireCondition(
        services.result.scope.runId === runId &&
          (!services.brands.offers ||
            services.brands.offers === services.result.offers) &&
          (!services.brands.transferScope ||
            (services.brands.transferScope.ownerKey ===
              services.result.scope.ownerKey &&
              services.brands.transferScope.grantId ===
                services.result.scope.grantId)),
        "result_scope_mismatch",
        "The Run result services do not share the same authority.",
      );
    const scope = bindGoScope(
      {
        instanceId: this.#instanceId,
        runId,
        methods: (value.methods as GoMethod[]).filter(
          (method) =>
            !services?.bindings ||
            !Object.hasOwn(services.bindings, method.path[0]!),
        ),
      },
      this.#call,
      signal,
      services?.brands,
    );
    let rootReturned: Promise<unknown> | undefined;
    let abandonedInput = false;
    const closeAdmission = () => {
      abandonedInput = scope.onRootReturned() || abandonedInput;
      if (this.#executionReady && !rootReturned) {
        rootReturned = this.#call(
          "run.rootReturned",
          { instanceId: this.#instanceId, runId },
          this.#lifetime,
        ).then((receipt) => {
          requireCondition(
            isPlainRecord(receipt) && receipt.closed === true,
            "run_cleanup_unconfirmed",
            "Go did not confirm root admission closure.",
          );
          abandonedInput = receipt.abandonedInput === true || abandonedInput;
        });
        void rootReturned.catch(() => {});
      }
    };
    const log = new HostRunLog((text) =>
      this.#call(
        "run.log",
        { instanceId: this.#instanceId, runId, text },
        this.#lifetime,
      ),
    );
    const logDone = finished(log);
    void logDone.catch(() => {});
    const runConsole = new Console({
      stdout: log,
      stderr: log,
      ignoreErrors: false,
    });
    let failed = false;
    try {
      const result = await this.#runner.start({
        runId,
        code: value.code,
        context,
        ...scope,
        bindings: { ...scope.bindings, ...services?.bindings },
        signal,
        onRootReturned: closeAdmission,
        settleOperations: async () => {
          await rootReturned;
          await scope.settleOperations();
          requireCondition(
            !abandonedInput,
            "input_not_awaited",
            "The root script returned without awaiting its input request.",
          );
        },
        onAccepted: async () => {
          await this.#call(
            "run.accepted",
            { instanceId: this.#instanceId, runId },
            signal,
          );
        },
        ...(typeof value.filename === "string"
          ? { filename: value.filename }
          : {}),
        console: runConsole,
      });
      return await encodeHostResult(result, runId, signal, services?.result);
    } catch (cause) {
      failed = true;
      if (
        abandonedInput &&
        isAgentError(cause) &&
        cause.code === "unhandled_async_error"
      )
        throw new AgentError(
          "input_not_awaited",
          "The root script returned without awaiting its input request.",
        );
      throw cause;
    } finally {
      log.end();
      try {
        await logDone;
        if (!failed && log.failure) throw log.failure;
      } catch (cause) {
        if (!failed) throw cause;
      }
    }
  }

  cancel(value: unknown): object {
    requireCondition(
      this.#runner &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.runId === "string",
      "invalid_run_scope",
      "The Go Run cancellation is invalid.",
    );
    return { accepted: this.#runner.cancel(value.runId) };
  }

  async beginPackages(value: unknown): Promise<object> {
    requireCondition(
      !this.#closed &&
        this.#loader &&
        this.#packages &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId,
      "invalid_host_configuration",
      "The host package request is invalid.",
    );
    requireCondition(
      value.transactionId === undefined ||
        typeof value.transactionId === "string",
      "invalid_host_configuration",
      "The package transaction identity is invalid.",
    );
    requireCondition(
      !this.#packageChange,
      "maintenance_busy",
      "A package change is already active.",
    );
    const id =
      value.transactionId ?? `package_${randomUUID().replaceAll("-", "")}`;
    requireCondition(
      /^package_[0-9a-f]{32}$/.test(id),
      "maintenance_transaction_invalid",
      "The package change identity is invalid.",
    );
    const extensions = this.#extensions;
    const loader = this.#loader;
    const packages = this.#packages;
    const change: PackageChange = {
      id,
      begin: Promise.resolve(),
      mainAcquired: false,
      extensionAcquired: false,
    };
    this.#packageChange = change;
    change.begin = Promise.resolve().then(async () => {
      if (extensions) {
        try {
          await extensions.beginPackages(id);
          change.extensionAcquired = true;
        } catch (cause) {
          if (
            isAgentError(cause) &&
            cause.code === "extension_cleanup_unconfirmed"
          )
            change.extensionAcquired = true;
          throw cause;
        }
      }
      requireCondition(!this.#closed, "host_closing", "The host is closing.");
      await packages.begin(loader, id);
      change.mainAcquired = true;
    });
    try {
      await change.begin;
      return { transactionId: id };
    } catch (cause) {
      try {
        await this.#finishPackageChange(change);
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "Package maintenance cleanup is unconfirmed.",
        );
      }
      throw cause;
    }
  }

  async finishPackages(value: unknown): Promise<object> {
    requireCondition(
      this.#packages &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.transactionId === "string",
      "invalid_host_configuration",
      "The host package request is invalid.",
    );
    const change = this.#packageChange;
    requireCondition(
      change && change.id === value.transactionId,
      "maintenance_transaction_invalid",
      "The package change does not belong to this host instance.",
    );
    return await this.#finishPackageChange(change);
  }

  async #finishPackageChange(
    change: PackageChange,
  ): Promise<{ restartRequired: boolean }> {
    if (change.finish) return await change.finish;
    const finish = (async (): Promise<{ restartRequired: boolean }> => {
      try {
        await change.begin.catch(() => {});
        let result = { restartRequired: false };
        let failure: unknown;
        if (change.mainAcquired) {
          try {
            result = await this.#packages!.finish(change.id);
            change.mainAcquired = false;
          } catch (cause) {
            failure = cause;
          }
        }
        if (change.extensionAcquired) {
          try {
            await this.#extensions!.finishPackages(change.id);
            change.extensionAcquired = false;
          } catch (cause) {
            failure ??= cause;
          }
        }
        if (failure !== undefined) throw failure;
        if (this.#packageChange === change) this.#packageChange = undefined;
        return result;
      } finally {
        change.finish = undefined;
      }
    })();
    change.finish = finish;
    return await finish;
  }

  async prepareMaterials(
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.#materials.prepare(value, signal);
  }

  prepareSource(value: unknown, signal: AbortSignal): unknown {
    requireCondition(
      !this.#closed && !this.#lifetime.aborted && this.#runner,
      "source_materials_unavailable",
      "Source preparation requires the configured authenticated host.",
    );
    signal.throwIfAborted();
    return prepareSourceMaterials(this.#instanceId, value);
  }

  async activateExtension(
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.packageName === "string" &&
        typeof value.preparationId === "string" &&
        Array.isArray(value.permissions) &&
        value.permissions.every(
          (permission: unknown) => typeof permission === "string",
        ),
      "extension_unavailable",
      "The host cannot activate this extension.",
    );
    return await this.#extensions.activate(
      {
        packageName: value.packageName,
        preparationId: value.preparationId,
        permissions: value.permissions as string[],
        approval: parseExtensionApproval(value.approval),
      },
      signal,
    );
  }

  async inspectExtension(
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    requireCondition(
      !this.#closed &&
        !this.#packageChange &&
        this.#loader &&
        this.#packages &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.packageName === "string" &&
        Array.isArray(value.permissions) &&
        value.permissions.length <= 256 &&
        value.permissions.every(
          (permission: unknown) =>
            typeof permission === "string" && permission.length <= 256,
        ),
      "extension_unavailable",
      "The configured host cannot inspect this extension.",
    );
    const loader = this.#loader;
    return await inspectExtensionPackage({
      work: loader.work,
      packageName: value.packageName,
      policy: this.#packages.policy,
      permissions: new Set(value.permissions as string[]),
      resolveImport: (specifier) => loader.resolveImport(specifier),
      signal,
    });
  }

  describeExtension(value: unknown): unknown {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.sourceInstanceId === "string",
      "extension_unavailable",
      "The prepared extension is unavailable.",
    );
    return this.#extensions.describe(value.sourceInstanceId);
  }

  async activatePlatform(
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.namespace === "string" &&
        [
          "runtime",
          "state",
          "output",
          "sh",
          "transfer",
          "maintenance",
        ].includes(value.namespace) &&
        typeof value.preparationId === "string" &&
        Array.isArray(value.permissions) &&
        value.permissions.every(
          (permission: unknown) => typeof permission === "string",
        ),
      "platform_unavailable",
      "The host cannot activate this platform source.",
    );
    return await this.#extensions.activatePlatform(
      {
        namespace: value.namespace,
        preparationId: value.preparationId,
        permissions: value.permissions as string[],
      },
      signal,
    );
  }

  extensionPrepared(value: unknown): object {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.sourceInstanceId === "string",
      "extension_unavailable",
      "The host extension is unavailable.",
    );
    return { prepared: this.#extensions.prepared(value.sourceInstanceId) };
  }

  async invokeExtension(value: unknown, signal: AbortSignal): Promise<unknown> {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId,
      "extension_unavailable",
      "The host extension is unavailable.",
    );
    return await this.#extensions.invoke(
      value as unknown as ExtensionInvocation,
      signal,
    );
  }

  async disableExtension(value: unknown): Promise<object> {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.packageName === "string",
      "extension_unavailable",
      "The host extension is unavailable.",
    );
    await this.#extensions.disable(value.packageName);
    return { disabled: true };
  }

  async stopExtensionRun(value: unknown): Promise<object> {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.runId === "string",
      "extension_unavailable",
      "The host extension Run is unavailable.",
    );
    await this.#extensions.stopRun(value.runId);
    return { stopped: true };
  }

  extensionRunStatus(value: unknown): object {
    requireCondition(
      !this.#closed &&
        this.#extensions &&
        isPlainRecord(value) &&
        value.instanceId === this.#instanceId &&
        typeof value.runId === "string",
      "extension_unavailable",
      "The host extension Run is unavailable.",
    );
    return { status: this.#extensions.runStatus(value.runId) };
  }

  async releaseMaterials(value: unknown): Promise<object> {
    await this.#materials.release(value);
    return {};
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#closeTask = (async () => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => this.#materials.close()),
        Promise.resolve().then(() => this.#runner?.close()),
        Promise.resolve().then(() => this.#packages?.close()),
        Promise.resolve().then(() => this.#extensions?.close()),
        this.#packageChange?.begin,
      ]);
      const failure = outcomes.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.#closeTask;
  }
}
