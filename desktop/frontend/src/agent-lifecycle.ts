import type { AgentWorkspaceSummary } from "./agent-workspace";

export const lifecycleStages = ["system", "conditions", "directory", "program", "config", "service", "version", "initialize", "configure", "start", "starting", "connecting", "upgrade", "repair", "repairing", "authorizing", "waiting", "exchanging", "installing", "restoring", "stopping", "stopped", "install_manifest", "install_download", "install_verify", "install_space", "install_stage", "install_config", "install_service", "install_start", "install_readiness", "restore_stop", "restore_config", "restore_start", "repair_download", "repair_verify", "repair_apply", "repair_service", "start_service", "start_verify", "stop_service", "stop_verify", "reinstall_prepare", "reinstall_apply", "uninstall_service", "uninstall_program", "blocked", "network", "failed", "unknown", "ready"] as const;
export type LifecycleStage = typeof lifecycleStages[number];
export const runtimeStages = ["node_check", "node_download", "node_install", "pnpm_prepare", "host_check", "host_download", "host_install", "host_start", "host_configure", "host_retry", "host_failed", "ready", "unknown", "agent_upgrade_download", "agent_upgrade_verify", "agent_upgrade_apply"] as const;
export type RuntimeStage = typeof runtimeStages[number];
export type ObservedStage = LifecycleStage | `runtime:${RuntimeStage}`;
export type TransferProgress = {stage: string; downloadedBytes: number; totalBytes: number};
export type LiveSummary = AgentWorkspaceSummary & { agentId: string; bootId: string };
export type LifecycleSnapshot = {
  revision: number; targetId: string; operationId: string; stage: LifecycleStage;
  reason: string; version: string; requiredVersion: string; busy: boolean; summary: LiveSummary | null;
  progress?: TransferProgress; runtimeProgress?: TransferProgress; observedStages?: ObservedStage[]; waitingForRuntime?: boolean;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid lifecycle state");
  return value as Record<string, unknown>;
}
function str(v: unknown, limit = 512, empty = false): v is string {
  return typeof v === "string" && v.length <= limit && (empty || v.length > 0) && !v.includes(String.fromCharCode(0)) && !v.includes("\r") && !v.includes("\n");
}
function progressValue(value: unknown, stages: readonly string[], downloadStages: readonly string[]): TransferProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.stage !== "string" || !stages.includes(p.stage) ||
      !Number.isSafeInteger(p.downloadedBytes) || !Number.isSafeInteger(p.totalBytes)) return undefined;
  const downloadedBytes = Number(p.downloadedBytes), totalBytes = Number(p.totalBytes);
  if (downloadedBytes < 0 || totalBytes < downloadedBytes || totalBytes > 1073741824 ||
      (totalBytes > 0 && !downloadStages.includes(p.stage))) return undefined;
  return {stage:p.stage,downloadedBytes,totalBytes};
}
export function parseLifecycleSnapshot(value: unknown, targetId: string): LifecycleSnapshot {
  const v = record(value);
  if (v.targetId !== targetId || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 ||
      !str(v.operationId, 32) || !/^[0-9a-f]{32}$/.test(v.operationId) ||
      typeof v.stage !== "string" || !(lifecycleStages as readonly string[]).includes(v.stage) ||
      !str(v.reason, 128, true) || !str(v.version, 128, true) || !str(v.requiredVersion, 128, true) ||
      typeof v.busy !== "boolean") throw new Error("invalid lifecycle state");
  let summary: LiveSummary | null = null;
  if (v.stage === "ready") {
    const s = record(v.summary);
    if (!str(s.name) || !str(s.agentId, 256) || !str(s.bootId, 256) || !str(s.version, 128) ||
        !["darwin", "linux", "windows"].includes(String(s.platform)) || !["amd64", "arm64"].includes(String(s.arch)) ||
        !["healthy", "degraded"].includes(String(s.runtime)) || s.management !== "connected" ||
        !["online", "offline", "unknown"].includes(String(s.cloud))) throw new Error("unverified Agent");
    summary = { name: s.name, agentId: s.agentId, bootId: s.bootId, version: s.version,
      platform: ({darwin:"macOS",linux:"Linux",windows:"Windows"} as Record<string,string>)[String(s.platform)]!,
      arch: s.arch === "arm64" ? "ARM64" : "x64", runtime: s.runtime as LiveSummary["runtime"],
      management: "connected", cloud: s.cloud as LiveSummary["cloud"] };
  } else if (v.summary != null) throw new Error("unexpected Agent summary");
  const progress = progressValue(v.progress,[String(v.stage)],["install_download","repair_download"]);
  const runtimeProgress = progressValue(v.runtimeProgress,runtimeStages,["node_download","host_download","agent_upgrade_download"]);
  const observedStages = Array.isArray(v.observedStages) && v.observedStages.length <= 32 &&
    v.observedStages.every(x => typeof x === "string" && ((lifecycleStages as readonly string[]).includes(x) || x.startsWith("runtime:") && (runtimeStages as readonly string[]).includes(x.slice(8)))) ? v.observedStages as ObservedStage[] : undefined;
  const preparing = runtimeProgress && ["node_check","node_download","node_install","pnpm_prepare","host_check","host_download","host_install","host_start","host_configure"].includes(runtimeProgress.stage);
  return {revision:Number(v.revision),targetId,operationId:v.operationId,stage:v.stage as LifecycleStage,reason:v.reason,version:v.version,requiredVersion:v.requiredVersion,busy:v.busy,summary,
    progress,runtimeProgress,observedStages,waitingForRuntime:v.waitingForRuntime === true && summary?.runtime === "degraded" && !!preparing};
}
