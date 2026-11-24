import { Peer, protocolVersion } from "./peer.js";
import { HostService } from "./service.js";
import { defaultBuiltins } from "../runtime/modules.js";
import { performance } from "node:perf_hooks";

let initialized = false;
let service: HostService | undefined;
const peer = new Peer(process.stdin, process.stdout, async (method, params, signal) => {
  if (method === "host.initialize") {
    if (initialized || !params || typeof params !== "object")
      throw new Error("unknown or invalid host request");
    const input = params as { protocolVersion?: unknown; instanceId?: unknown };
    if (process.version !== "v24.22.1" || input.protocolVersion !== protocolVersion || typeof input.instanceId !== "string" || input.instanceId.length === 0)
      throw new Error("incompatible host handshake");
    initialized = true;
    service = new HostService(input.instanceId, (name, value, callSignal) => peer.call(name, value, callSignal), peer.signal);
    if (peer.signal.aborted) void service.close().catch(() => {});
    else peer.signal.addEventListener("abort", () => { void service?.close().catch(() => {}); }, { once: true });
    return { protocolVersion, instanceId: input.instanceId, transportReady: true, executionReady: false,
      resultEncoding: "stored-v1", nodeVersion: process.version,
      nodeRuntime: { name: "node", version: process.version, nodeVersion: process.version,
        v8Version: process.versions.v8, modulesAbi: process.versions.modules,
        arch: process.arch, startedAt: new Date(performance.timeOrigin).toISOString(),
        workerHeapLimitEnforced: true },
      builtinFamilies: [...defaultBuiltins] };
  }
  if (!service) throw new Error("host is not initialized");
  if (method === "host.configure") return await service.configure(params);
  if (method === "host.ready") return await service.ready(params, signal);
  if (method === "run.execute") return await service.execute(params, signal);
  if (method === "run.prepare") return service.prepareRun(params, signal);
  if (method === "input.validate") return service.validateInput(params);
  if (method === "run.cancel") return service.cancel(params);
  if (method === "packages.begin") return await service.beginPackages(params);
  if (method === "packages.finish") return await service.finishPackages(params);
  if (method === "extension.activate") return await service.activateExtension(params, signal);
  if (method === "extension.inspect") return await service.inspectExtension(params, signal);
  if (method === "extension.describe") return service.describeExtension(params);
  if (method === "platform.activate") return await service.activatePlatform(params, signal);
  if (method === "extension.prepared") return service.extensionPrepared(params);
  if (method === "process.stop") return await service.stopProcess(params);
  if (method === "extension.invoke") return await service.invokeExtension(params, signal);
  if (method === "extension.disable") return await service.disableExtension(params);
  if (method === "extension.run.stop") return await service.stopExtensionRun(params);
  if (method === "extension.run.status") return service.extensionRunStatus(params);
  throw new Error("unknown host request");
});
peer.start();
