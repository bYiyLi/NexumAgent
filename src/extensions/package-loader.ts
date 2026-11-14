import { realpathSync } from "node:fs";
import path from "node:path";
import { AgentError, requireCondition } from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import { canonicalJson } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import { ModuleLoader, type ModulePolicy } from "../runtime/modules.js";
import type { ExtensionFactory } from "./api.js";
import {
  inspectExtensionPackage,
  verifyExtensionPackage,
  type ExtensionPackageDescriptor,
  type ExtensionPackageOptions,
} from "./packages.js";
import { ExtensionRegistry, type ExtensionHandle } from "./registry.js";

export interface ExtensionPackageLoaderOptions {
  readonly policy: ModulePolicy;
  readonly permissions: ReadonlySet<string>;
  /** Current, explicit enable intent. Installing or importing a package does not enable it. */
  readonly enabled: () => ReadonlySet<string>;
  readonly limits?: ExtensionPackageOptions["limits"];
}
export interface PreparedExtensionPackage {
  readonly descriptor: ExtensionPackageDescriptor;
  readonly handle: ExtensionHandle;
}
interface FactoryRecord {
  readonly descriptor: ExtensionPackageDescriptor;
  readonly sourceKey: string;
  readonly factory: ExtensionFactory;
  cleanup?: ExtensionHandle;
}

/** Native package preparation only. The contribution coordinator owns publication and normal disable. */
export class ExtensionPackageLoader {
  readonly #factories = new Map<string, FactoryRecord>();
  readonly #pending = new Map<string, Promise<PreparedExtensionPackage>>();
  readonly #prepared = new WeakSet<object>();
  readonly #failures = new WeakMap<object, PreparedExtensionPackage>();
  constructor(
    readonly registry: ExtensionRegistry,
    readonly modules: ModuleLoader,
    readonly options: ExtensionPackageLoaderOptions,
  ) {
    requireCondition(
      modules.work ===
        realpathSync.native(path.join(registry.resources.store.root, "work")),
      "extension_profile_mismatch",
      "The extension registry and module loader must use the same Agent profile work directory.",
    );
  }
  #enabled(packageName: string): void {
    requireCondition(
      this.options.enabled().has(packageName),
      "extension_not_enabled",
      "The package is not explicitly enabled for this Agent profile.",
      { packageName },
    );
  }
  #options(packageName: string, signal?: AbortSignal): ExtensionPackageOptions {
    return {
      work: this.modules.work,
      packageName,
      policy: this.options.policy,
      permissions: this.options.permissions,
      resolveImport: (specifier) => this.modules.resolveImport(specifier),
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(signal ? { signal } : {}),
    };
  }
  #entry(descriptor: ExtensionPackageDescriptor) {
    return {
      packageName: descriptor.packageName,
      entry: descriptor.entry.url,
      revision: descriptor.revision,
    };
  }
  async #verify(
    descriptor: ExtensionPackageDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.#enabled(descriptor.packageName);
    this.modules.assertExtension(this.#entry(descriptor));
    await verifyExtensionPackage(
      descriptor,
      this.#options(descriptor.packageName, signal),
    );
    signal?.throwIfAborted();
    this.#enabled(descriptor.packageName);
    this.modules.assertExtension(this.#entry(descriptor));
  }
  #retainFailure(
    cause: unknown,
    record: FactoryRecord,
    handle: ExtensionHandle,
    sourceKey: string = record.sourceKey,
  ): void {
    // Only a handle returned by this attempt's Registry identity proof (or an
    // already-retained exact record) can enter this private failure map.
    requireCondition(
      sourceKey === record.sourceKey &&
        canonicalJson(handle.origin) ===
          canonicalJson(record.descriptor.source.origin),
      "extension_material_source_mismatch",
      "A failed package cleanup must retain its exact prepared source and configuration.",
    );
    record.cleanup = handle;
    if (typeof cause === "object" && cause !== null)
      this.#failures.set(
        cause,
        Object.freeze({ descriptor: record.descriptor, handle }),
      );
  }
  /** Core-only identity proof; Error details and namespace strings grant no cleanup authority. */
  preparationFailure(cause: unknown): PreparedExtensionPackage | null {
    if (typeof cause !== "object" || cause === null) return null;
    const prepared = this.#failures.get(cause);
    return prepared && this.registry.preparationRetained(prepared.handle)
      ? prepared
      : null;
  }
  /** The coordinator must call this immediately before publishing all five contributions. */
  async verify(prepared: PreparedExtensionPackage): Promise<void> {
    requireCondition(
      this.#prepared.has(prepared),
      "extension_unavailable",
      "This prepared package belongs to a different loader or profile.",
    );
    await this.#verify(prepared.descriptor);
  }
  prepare(
    packageName: string,
    config: JsonObject = {},
  ): Promise<PreparedExtensionPackage> {
    this.#enabled(packageName);
    const fixedConfig = JSON.parse(canonicalJson(config, 65536)) as JsonObject;
    const request = canonicalJson([packageName, fixedConfig], 131072);
    const pending = this.#pending.get(request);
    if (pending) return pending;
    const task = this.#prepare(packageName, fixedConfig);
    this.#pending.set(request, task);
    void task
      .finally(() => {
        if (this.#pending.get(request) === task) this.#pending.delete(request);
      })
      .catch(() => {});
    return task;
  }
  async #prepare(
    packageName: string,
    config: JsonObject,
  ): Promise<PreparedExtensionPackage> {
    // Explicit preparation also retries retained failed cleanup before a changed source
    // can require restart. Never lose the only handle by moving to another revision.
    for (const record of this.#factories.values()) {
      if (record.descriptor.packageName !== packageName || !record.cleanup)
        continue;
      const handle = record.cleanup;
      let report: JsonObject;
      try {
        report = await this.registry.disable(handle);
      } catch (cause) {
        const failure = new AgentError(
          "extension_cleanup_pending",
          "The prior prepared instance cleanup could not be confirmed.",
          { extensionId: handle.id },
          { cause },
        );
        this.#retainFailure(failure, record, handle);
        throw failure;
      }
      if (report.status !== "disabled") {
        const failure = new AgentError(
          "extension_cleanup_pending",
          "The prior prepared instance must finish cleanup before another initialization.",
          { extensionId: handle.id, cleanup: report },
        );
        this.#retainFailure(failure, record, handle);
        throw failure;
      }
      record.cleanup = undefined;
    }
    const descriptor = await inspectExtensionPackage(
      this.#options(packageName),
    );
    await this.#verify(descriptor);
    const source = { ...descriptor.source, config };
    const key = canonicalJson(source, 131072);
    let record = this.#factories.get(key);
    if (!record) {
      const factory: ExtensionFactory = async (host) => {
        await this.#verify(descriptor, host.signal);
        const namespace = await this.modules.importExtension(
          this.#entry(descriptor),
        );
        await this.#verify(descriptor, host.signal);
        const exported = Object.getOwnPropertyDescriptor(namespace, "default");
        requireCondition(
          exported &&
            "value" in exported &&
            typeof exported.value === "function",
          "invalid_extension_export",
          "The native ./nexum entry must default-export createExtension(host).",
        );
        // Registry must receive the candidate before any later asynchronous validation can fail.
        return Reflect.apply(exported.value, undefined, [host]);
      };
      record = { descriptor, sourceKey: key, factory };
      this.#factories.set(key, record);
    }
    let handle: ExtensionHandle;
    try {
      handle = await this.registry.prepare(source, record.factory);
    } catch (cause) {
      const failed = this.registry.preparationFailure(cause, source);
      if (failed) this.#retainFailure(cause, record, failed, key);
      throw cause;
    }
    const prepared = Object.freeze({ descriptor, handle });
    try {
      await this.#verify(descriptor);
    } catch (cause) {
      record.cleanup = handle;
      let cleanup: JsonObject;
      try {
        cleanup = await this.registry.disable(handle);
        if (cleanup.status === "disabled") record.cleanup = undefined;
      } catch (cleanupCause) {
        cleanup = {
          status: "unconfirmed",
          error: safeErrorData(cleanupCause, {
            code: "extension_cleanup_failed",
            message: "The prepared extension cleanup could not be confirmed.",
          }),
        };
      }
      const failure = new AgentError(
        "extension_package_changed",
        "The extension's enable intent or source changed during initialization; it was not published.",
        { extensionId: handle.id, cleanup },
        { cause },
      );
      if (cleanup.status !== "disabled")
        this.#retainFailure(failure, record, handle, key);
      throw failure;
    }
    this.#prepared.add(prepared);
    return prepared;
  }
}
