import { AgentError, requireCondition } from "../contracts/errors.js";
import { canonicalJson } from "../contracts/json.js";
import type { JsonObject } from "../contracts/types.js";
import {
  ExtensionPackageLoader,
  type PreparedExtensionPackage,
} from "../extensions/package-loader.js";
import {
  ExtensionMaterials,
  type PreparedExtensionMaterials,
} from "../extensions/materials.js";
import { ExtensionRegistry } from "../extensions/registry.js";

interface Entry {
  readonly name: string;
  readonly config: string;
  readonly prepared: PreparedExtensionPackage;
  materials?: PreparedExtensionMaterials;
  status: "ready" | "enabled" | "stopping";
}
interface Pending {
  readonly action: "enable" | "disable";
  readonly intent: string;
  readonly promise: Promise<JsonObject>;
}

/** Applies already-approved enable intent; confirmation and config persistence belong to maintenance. */
export class ExtensionServices {
  #entries = new Map<string, Entry>();
  #pending = new Map<string, Pending>();
  constructor(
    readonly registry: ExtensionRegistry,
    readonly packages: ExtensionPackageLoader,
    readonly materials: ExtensionMaterials,
  ) {
    requireCondition(
      packages.registry === registry &&
        packages.modules.work === materials.work,
      "extension_profile_mismatch",
      "Extension loading, discovery and runtime must share one Agent profile.",
    );
  }
  #name(value: string): void {
    requireCondition(
      typeof value === "string" &&
        value.length <= 214 &&
        /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value),
      "invalid_extension_package",
      "Use the actual installed npm package name.",
    );
  }
  #view(entry: Entry, status: string = entry.status): JsonObject {
    return JSON.parse(
      canonicalJson({
        name: entry.name,
        extensionId: entry.prepared.handle.id,
        origin: entry.prepared.handle.origin,
        status,
        methodCount: entry.prepared.handle.methods.length,
        docs: entry.materials?.entry ?? null,
      }),
    ) as JsonObject;
  }
  #operation(
    name: string,
    action: Pending["action"],
    intent: string,
    execute: () => Promise<JsonObject>,
  ): Promise<JsonObject> {
    this.#name(name);
    const existing = this.#pending.get(name);
    if (existing) {
      requireCondition(
        existing.action === action && existing.intent === intent,
        "extension_busy",
        "A different enable or disable operation is already using this package.",
      );
      return existing.promise;
    }
    // Reserve before invoking initialization or authorization callbacks. There
    // is one in-flight action per package, without an implicit maintenance queue.
    const task = Promise.resolve().then(execute);
    this.#pending.set(name, { action, intent, promise: task });
    void task
      .finally(() => {
        if (this.#pending.get(name)?.promise === task)
          this.#pending.delete(name);
      })
      .catch(() => {});
    return task;
  }
  async #stop(entry: Entry): Promise<JsonObject> {
    try {
      const task = this.registry.disable(entry.prepared.handle, () => {
        // Withdrawal has no I/O and finishes before the instance stop signal
        // can run an extension's own listeners or disposal callbacks.
        this.materials.withdraw(entry.prepared.handle.id);
        entry.status = "stopping";
        this.#entries.set(entry.name, entry);
      });
      const report = await task;
      if (
        report.status === "disabled" &&
        this.#entries.get(entry.name) === entry
      )
        this.#entries.delete(entry.name);
      return report;
    } catch (cause) {
      // A rejected stop request or failed persistence does not erase the actual
      // prepared/active instance. A later explicit action can retry cleanup.
      this.#entries.set(entry.name, entry);
      throw cause;
    }
  }
  enable(name: string, config: JsonObject = {}): Promise<JsonObject> {
    const fixedConfig = JSON.parse(canonicalJson(config, 65536)) as JsonObject;
    const intent = canonicalJson(fixedConfig, 65536);
    return this.#operation(name, "enable", intent, async () => {
      const existing = this.#entries.get(name);
      if (existing?.status === "enabled") {
        requireCondition(
          existing.config === intent,
          "extension_configuration_changed",
          "Disable the idle instance before applying a different approved configuration.",
          { extensionId: existing.prepared.handle.id },
        );
        await this.packages.verify(existing.prepared);
        return this.#view(existing);
      }
      if (existing) {
        const report = await this.#stop(existing);
        requireCondition(
          report.status === "disabled",
          "extension_cleanup_unconfirmed",
          "The old instance must actually close before another initialization.",
          { extensionId: existing.prepared.handle.id, cleanup: report },
        );
      }
      let prepared: PreparedExtensionPackage;
      try {
        prepared = await this.packages.prepare(name, fixedConfig);
      } catch (cause) {
        const failed = this.packages.preparationFailure(cause);
        if (failed)
          this.#entries.set(name, {
            name,
            config: intent,
            prepared: failed,
            status: "stopping",
          });
        // The trusted failure identity remains stoppable even after enable
        // intent is revoked. Namespace-conflict errors cannot name an owner.
        throw cause;
      }
      const entry: Entry = { name, config: intent, prepared, status: "ready" };
      try {
        entry.materials = await this.materials.prepare(
          prepared.descriptor,
          prepared.handle,
        );
        await this.packages.verify(prepared);
        this.registry.publish(prepared.handle, () => {
          this.materials.publish(entry.materials!);
          entry.status = "enabled";
          this.#entries.set(name, entry);
        });
      } catch (cause) {
        let cleanup: JsonObject;
        try {
          cleanup = await this.#stop(entry);
        } catch (stopError) {
          cleanup = {
            status: "unconfirmed",
            code:
              stopError instanceof AgentError
                ? stopError.code
                : "extension_cleanup_failed",
          };
        }
        throw new AgentError(
          "extension_publication_failed",
          "The extension's complete contributions were not published.",
          { name, extensionId: prepared.handle.id, cleanup },
          { cause },
        );
      }
      // Publication is committed. A later delivery failure must not undo a
      // valid shared instance or silently initialize it for a second time.
      return this.#view(entry);
    });
  }
  disable(name: string): Promise<JsonObject> {
    return this.#operation(name, "disable", "", async () => {
      const entry = this.#entries.get(name);
      requireCondition(
        entry,
        "extension_unavailable",
        "This package has no instance managed by this Agent profile.",
      );
      const cleanup = await this.#stop(entry);
      return {
        ...this.#view(entry, cleanup.status as string),
        cleanup,
      };
    });
  }
  get(name: string): JsonObject | null {
    this.#name(name);
    const entry = this.#entries.get(name);
    return entry ? this.#view(entry) : null;
  }
  list(): readonly JsonObject[] {
    return [...this.#entries.values()]
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      )
      .map((entry) => this.#view(entry));
  }
}
