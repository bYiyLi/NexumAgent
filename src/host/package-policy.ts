import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { cloudManagedPackages } from "./cloud-packages.js";
import { requireCondition } from "../contracts/errors.js";
import { maintenanceText } from "./files.js";
import { defaultBuiltins, type ModuleLoader, type ModulePolicy } from "../runtime/modules.js";

interface PackageChange {
  readonly id: string;
  readonly release: () => void;
  readonly done: Promise<{ restartRequired: boolean }>;
}

/** Keeps the native loader's admission gate held across a Go-managed npm change. */
export class HostPackagePolicy {
  readonly root: string;
  readonly policy: ModulePolicy;
  #usable = true;
  #change?: PackageChange;
  #closed = false;

  private constructor(root: string) {
    this.root = root;
    this.policy = {
      builtins: () => defaultBuiltins,
      approvedPackages: () => {
        if (!this.#usable || this.#closed) return new Map();
        // Inventory for execution is fail-closed per dependency. A bad optional
        // package cannot prevent a Worker using only builtins from running.
        // Maintenance verification below remains strict.
        return cloudManagedPackages(this.root, true);
      },
    };
  }

  static async open(root: string): Promise<HostPackagePolicy> {
    return new HostPackagePolicy(root);
  }

  async #fingerprint(): Promise<string> {
    const work = this.root;
    const files = ["package.json", "package-lock.json", "pnpm-lock.yaml"];
    const hash = createHash("sha256");
    for (const name of files) {
      const text = await maintenanceText(path.join(work, name), 32 * 1024 * 1024, true);
      hash.update(JSON.stringify([name, text]));
    }
    return hash.digest("hex");
  }

  async begin(loader: ModuleLoader, transactionId?: string): Promise<{ transactionId: string }> {
    requireCondition(!this.#closed && !this.#change, "maintenance_busy",
      "A package change is already active or the host is closing.");
    requireCondition(loader.work === this.root, "runtime_profile_mismatch",
      "The package change belongs to another work environment.");
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    requireCondition(transactionId === undefined || /^package_[0-9a-f]{32}$/.test(transactionId),
      "maintenance_transaction_invalid", "The package change identity is invalid.");
    const id = transactionId ?? `package_${randomUUID()}`;
    const done = loader.withPackageChanges(async () => {
      const before = await this.#fingerprint();
      this.#usable = false;
      ready.resolve();
      await release.promise;
      try {
        const after = await this.#fingerprint();
        cloudManagedPackages(this.root);
        const restartRequired = before !== after && loader.loadedPackages().length > 0;
        if (restartRequired) loader.markPackageRestartRequired();
        this.#usable = true;
        return { restartRequired };
      } catch (cause) {
        if (loader.loadedPackages().length > 0) loader.markPackageRestartRequired();
        throw cause;
      }
    });
    void done.catch((cause: unknown) => ready.reject(cause));
    this.#change = { id, release: () => release.resolve(), done };
    try {
      await ready.promise;
      requireCondition(!this.#closed, "host_closing", "The host is closing.");
      return { transactionId: id };
    } catch (cause) {
      release.resolve();
      await done.catch(() => {});
      if (this.#change?.id === id) this.#change = undefined;
      throw cause;
    }
  }

  async finish(transactionId: string): Promise<{ restartRequired: boolean }> {
    const change = this.#change;
    requireCondition(change && change.id === transactionId, "maintenance_transaction_invalid",
      "The package change does not belong to this host instance.");
    change.release();
    try {
      return await change.done;
    } finally {
      if (this.#change === change) this.#change = undefined;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const change = this.#change;
    if (!change) return;
    change.release();
    await change.done.catch(() => {});
    if (this.#change === change) this.#change = undefined;
  }
}
