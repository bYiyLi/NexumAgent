import { MessagePort, parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isAgentError, requireCondition } from "../contracts/errors.js";
import { safeErrorData } from "../contracts/error-data.js";
import { canonicalJson, isPlainRecord } from "../contracts/json.js";
import type { Binding, JsonObject } from "../contracts/types.js";
import { MaterialRetention } from "../runtime/material-retention.js";
import { ModuleLoader } from "../runtime/modules.js";
import type { InputReply, RunServices } from "../runtime/invocation.js";
import { parseExtensionApproval, restoreExtension } from "./extension-runtime.js";
import { restoreManagedShell } from "./sh-runtime.js";
import { decodeGoResult, encodeGoArguments } from "./blob.js";
import { HostPackagePolicy } from "./package-policy.js";
import { registryOwner, registryStore } from "./registry-store.js";
import { callHostSync, HostAsyncRPC } from "./sync-rpc.js";

/** A trusted Registry Worker receives its configuration from the Node host. */
async function start(): Promise<void> {
  requireCondition(parentPort && isPlainRecord(workerData) && workerData.port instanceof MessagePort &&
    typeof workerData.root === "string" && path.isAbsolute(workerData.root) &&
    typeof workerData.instanceId === "string" && typeof workerData.bootId === "string" &&
    typeof workerData.preparationId === "string" && workerData.preparationId.length > 0 &&
    typeof workerData.packageName === "string" && isPlainRecord(workerData.binding) &&
    Array.isArray(workerData.permissions) && workerData.permissions.every((value: unknown) => typeof value === "string"),
  "invalid_registry_configuration", "The Registry Worker configuration is invalid.");
  const parent = parentPort;
  const port = workerData.port;
  const asyncHost = new HostAsyncRPC(port);
  const root = workerData.root;
  const instanceId = workerData.instanceId;
  const binding = workerData.binding as unknown as Binding;
  const owner = registryOwner(port, instanceId, workerData.preparationId);
  const activeInput = new AsyncLocalStorage<{ runId: string; operationId: string; arguments: unknown[]; binaryInputs: unknown[] }>();
  const store = registryStore(port, root, binding, workerData.bootId, owner.scope);
  const packages = await HostPackagePolicy.open(root);
  const reserve = async (bytes: number) => {
    const scope = owner.current();
    const reservation = callHostSync(port, "storage.reserve", { ...scope, bytes });
    requireCondition(typeof reservation === "string" && reservation.length > 0,
      "storage_reservation_failed", "Go did not confirm a storage reservation.");
    let released = false;
    return Object.freeze({ release() {
      if (released) return;
      callHostSync(port, "storage.release", { ...scope, reservation });
      released = true;
    } });
  };
  let runtime: Awaited<ReturnType<typeof restoreExtension>> | Awaited<ReturnType<typeof restoreManagedShell>> | undefined;
  const retention = new MaterialRetention(root, {
    reserve,
    liveSnapshotRefs: () => {
      const refs = callHostSync(port, "materials.liveSnapshotRefs", { instanceId });
      requireCondition(Array.isArray(refs) && refs.every((ref) => typeof ref === "string"),
        "material_retention_unavailable", "Go did not return the live work references.");
      return new Set(refs);
    },
    publishedDirectories: () => runtime?.activeDirectories() ?? new Set(),
  });
  try {
    const modules = await ModuleLoader.create(root, `registry_${randomUUID()}`, packages.policy);
    const registryOptions = {
        permissions: new Set(workerData.permissions as string[]),
        authorize(policy: import("../extensions/registry.js").RegistryPolicy) {
          const input = activeInput.getStore();
          const projected = input ? {
            ...policy, runId: input.runId, operationId: input.operationId,
            input: { __nexumWorkerArgs: input.arguments, __nexumBinaryInputs: input.binaryInputs },
          } : policy;
          callHostSync(port, "extension.authorize", { ...owner.current(), policy: projected });
        },
        log(origin: import("../contracts/types.js").ContributionOrigin, entry: import("../extensions/api.js").LogEntry, runId?: string, operationId?: string) {
          callHostSync(port, "extension.log", { ...owner.current(), origin, entry,
            ...(runId ? { runId } : {}), ...(operationId ? { operationId } : {}) });
        },
        progress(origin: import("../contracts/types.js").ContributionOrigin, runId: string, operationId: string, value: JsonObject) {
          callHostSync(port, "extension.progress", { ...owner.current(), origin, runId, operationId, value });
        },
        storage: { reserve },
      };
    const common = { root, store, allocateOwner: owner.allocateOwner,
      releaseOwner: owner.releaseOwner, reserve, retention,
      registry: registryOptions };
    runtime = workerData.packageName.startsWith("platform:")
      ? await restoreManagedShell({ ...common, namespace: workerData.packageName.slice(9) as import("../sdk/platform.js").PlatformNamespace })
      : await restoreExtension({ ...common, packageName: workerData.packageName, modules, policy: packages.policy,
        approval: parseExtensionApproval(workerData.approval) });
    parent.postMessage({ type: "ready", info: runtime.info, scope: owner.current(), methods: runtime.methods,
      published: runtime.published(), scriptSources: runtime.scriptSources() });
    const active = new Map<string, { controller: AbortController; runId: string; done: Promise<void> }>();
    const runs = new Map<string, AbortController>();
    let packageChange: { transactionId: string; release: () => void; done: Promise<void> } | undefined;
    parent.on("message", (value: unknown) => {
      if (!isPlainRecord(value)) return;
      if (value.type === "platform.confirm" || value.type === "platform.withdrawn") {
        const id = value.id;
        if (typeof id !== "string" || !("confirmPublished" in runtime!)) {
          parent.postMessage({ type: "platform.settled", id, code: "invalid_platform_source" });
          return;
        }
        try {
          if (value.type === "platform.confirm") runtime!.confirmPublished();
          else runtime!.confirmWithdrawn();
          parent.postMessage({ type: "platform.settled", id });
        } catch (cause) {
          parent.postMessage({ type: "platform.settled", id, code: isAgentError(cause) ? cause.code : "platform_publication_failed" });
        }
        return;
      }
      if (value.type === "packages.begin") {
        const id = value.id;
        const transactionId = value.transactionId;
        if (typeof id !== "string" || typeof transactionId !== "string" || packageChange) {
          parent.postMessage({ type: "packages.begun", id, code: "extension_busy" });
          return;
        }
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const done = runtime!.withPackageChanges(async () => { ready.resolve(); await release.promise; });
        packageChange = { transactionId, release: release.resolve, done };
        void done.catch((cause: unknown) => ready.reject(cause));
        void ready.promise.then(() => parent.postMessage({ type: "packages.begun", id }), (cause: unknown) => {
          if (packageChange?.transactionId === transactionId) packageChange = undefined;
          parent.postMessage({ type: "packages.begun", id, code: isAgentError(cause) ? cause.code : "extension_busy" });
        });
        return;
      }
      if (value.type === "packages.finish") {
        const id = value.id;
        const change = packageChange;
        if (typeof id !== "string" || !change || value.transactionId !== change.transactionId) {
          parent.postMessage({ type: "packages.finished", id, code: "maintenance_transaction_invalid" });
          return;
        }
        change.release();
        void change.done.then(() => {
          if (packageChange === change) packageChange = undefined;
          parent.postMessage({ type: "packages.finished", id });
        }, (cause: unknown) => {
          if (packageChange === change) packageChange = undefined;
          parent.postMessage({ type: "packages.finished", id, code: isAgentError(cause) ? cause.code : "extension_busy" });
        });
        return;
      }
      if (value.type === "cancel" && typeof value.id === "string") {
        const entry = active.get(value.id);
        if (entry) owner.withRun(entry.runId, () => entry.controller.abort());
        return;
      }
      if (value.type === "run.stop") {
        const id = value.id;
        const runId = value.runId;
        if (typeof id !== "string" || typeof runId !== "string" || !/^run_[0-9a-f]{32}$/.test(runId)) {
          parent.postMessage({ type: "run.stopped", id, code: "invalid_run_scope" });
          return;
        }
        const scope = runs.get(runId);
        if (!scope) { parent.postMessage({ type: "run.stopped", id }); return; }
        void owner.withRun(runId, async () => {
          try {
            scope.abort();
            await Promise.all([...active.values()].filter((entry) => entry.runId === runId).map((entry) => entry.done));
            const report = await runtime!.resources.cleanupRun(runId);
            requireCondition(report.unconfirmed.length === 0, "resource_cleanup_unconfirmed",
              "Run resources did not confirm their actual cleanup.");
            await runtime!.resources.waitForRunClosure(runId);
            if (runs.get(runId) === scope) runs.delete(runId);
            parent.postMessage({ type: "run.stopped", id });
          } catch (cause) {
            parent.postMessage({ type: "run.stopped", id,
              code: isAgentError(cause) ? cause.code : "resource_cleanup_unconfirmed" });
          }
        });
        return;
      }
      if (value.type === "invoke") {
        const id = value.id;
        if (typeof id !== "string" || active.has(id) || active.size >= 128 ||
          typeof value.runId !== "string" || !/^run_[0-9a-f]{32}$/.test(value.runId) ||
          typeof value.methodId !== "string" || typeof value.operationId !== "string" ||
          !Number.isSafeInteger(value.deadlineAt) || !isPlainRecord(value.context) ||
          value.context.runId !== value.runId || !Array.isArray(value.arguments) ||
          (value.binaryInputs !== undefined && !Array.isArray(value.binaryInputs))) {
          parent.postMessage({ type: "invoked", id, code: "invalid_run_scope" });
          return;
        }
        const method = runtime!.methods.find((item) => item.methodId === value.methodId);
        if (!method) { parent.postMessage({ type: "invoked", id, code: "extension_unavailable" }); return; }
        const runId = value.runId;
        const operationId = value.operationId;
        const controller = new AbortController();
        let runController = runs.get(runId);
        if (!runController) { runController = new AbortController(); runs.set(runId, runController); }
        const runSignal = AbortSignal.any([runController.signal, controller.signal]);
        const completion = Promise.withResolvers<void>();
        const remaining = (value.deadlineAt as number) - Date.now();
        if (remaining <= 0) controller.abort();
        const timer = remaining > 0 && remaining <= 2_147_483_647
          ? setTimeout(() => owner.withRun(runId, () => controller.abort()), remaining) : undefined;
        active.set(id, { controller, runId, done: completion.promise });
        const context = JSON.parse(canonicalJson(value.context)) as JsonObject;
        const services: RunServices = {
          runId, signal: runSignal, context, deadlineAt: value.deadlineAt as number,
          assertActive() { runSignal.throwIfAborted(); },
          assertCurrent() { runSignal.throwIfAborted(); },
          operation(_origin, _name, action, hooks) {
            try {
              const result = action(operationId);
              return Promise.resolve(result).then((result) => {
                try { return hooks?.complete ? hooks.complete(result) : result; }
                catch (cause) { throw hooks?.failure ? hooks.failure(cause) : cause; }
              },
                (cause: unknown) => { throw hooks?.failure ? hooks.failure(cause) : cause; })
                .finally(() => hooks?.settled?.());
            } catch (cause) {
              const error = hooks?.failure ? hooks.failure(cause) : cause;
              hooks?.settled?.();
              throw error;
            }
          },
          async requestInput(request) {
            return await asyncHost.call("extension.requestInput", { ...owner.scope(), operationId, request },
              runSignal) as InputReply;
          },
        };
        void owner.withRun(runId, () => activeInput.run({ runId, operationId,
          arguments: value.arguments as unknown[], binaryInputs: (value.binaryInputs ?? []) as unknown[] }, async () => {
          try {
            const call = asyncHost.call.bind(asyncHost);
            const binaryScope = { instanceId, runId, methodId: method.methodId };
            const args = await decodeGoResult({ value: value.arguments,
              binaryOutputs: value.binaryInputs ?? [] }, binaryScope, call, runSignal);
            requireCondition(Array.isArray(args), "invalid_arguments", "The extension arguments are invalid.");
            const bindings = runtime!.registry.bindings(services);
            let target: unknown = bindings;
            for (const part of method.path) {
              requireCondition(target && typeof target === "object" && Object.hasOwn(target, part),
                "extension_unavailable", "The published extension method is unavailable.");
              target = (target as Record<string, unknown>)[part];
            }
            requireCondition(typeof target === "function", "extension_unavailable", "The extension method is unavailable.");
            const result = await Reflect.apply(target, undefined, args);
            const encoded = await encodeGoArguments([result ?? null], binaryScope, call, runSignal);
            requireCondition(Array.isArray(encoded.arguments) && encoded.arguments.length === 1,
              "invalid_sdk_result", "The extension result could not be encoded.");
            parent.postMessage({ type: "invoked", id, result: { value: encoded.arguments[0],
              binaryOutputs: encoded.binaryInputs.map((item) => ({ ...item, path: item.path.slice(1) })) } });
          } catch (cause) {
            parent.postMessage({ type: "invoked", id, error: safeErrorData(cause,
              { code: "extension_invocation_failed", message: "The extension operation failed." }) });
          } finally {
            if (timer) clearTimeout(timer);
            active.delete(id);
            completion.resolve();
          }
        }));
        return;
      }
      if (value.type !== "close") return;
      void (async () => {
        try {
          if (packageChange) {
            packageChange.release();
            await packageChange.done;
            packageChange = undefined;
          }
          const result = await runtime!.close();
          requireCondition(result.status === "disabled", "extension_cleanup_unconfirmed",
            "The extension instance did not confirm cleanup.");
          await retention.stop();
          await packages.close();
          parent.postMessage({ type: "closed", result });
          parent.close();
          port.close();
        } catch (cause) {
          parent.postMessage({ type: "close_failed", code: isAgentError(cause) ? cause.code : "extension_cleanup_failed" });
        }
      })();
    });
  } catch (cause) {
    await retention.stop().catch(() => {});
    await packages.close().catch(() => {});
    throw cause;
  }
}

void start().catch((cause: unknown) => {
  const nested = cause instanceof Error ? cause.cause : undefined;
  parentPort?.postMessage({ type: "failed", code: isAgentError(cause) ? cause.code : "extension_initialization_failed",
    ...(isAgentError(nested) ? { causeCode: nested.code } : {}) });
  parentPort?.close();
});
