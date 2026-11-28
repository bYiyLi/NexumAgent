import { clientUpdatePreview, type ClientUpdateState } from "./client-update";
import type { Messages } from "./i18n";
import type { RemotePreviewFlow } from "./remote-draft";

export type DesktopPage = "bootstrap" | "workspace" | "settings" | "agent-lifecycle" | "remote-setup" | "remote-connecting" | "agent-workspace";
// One development-only preview entry exercises every Bootstrap presentation.
// None of these sample stages authorizes a real update or data migration.
export const bootstrapPreviewStages = [
  "startup", "storage", "configuration", "services", "checking",
  "downloading", "verifying", "installing", "restarting",
  "backup", "migration", "dataVerifying", "recovery",
  "initializationFailed", "failed", "verificationFailed", "migrationFailed",
  "incompatible", "permissionFailed",
] as const;

export type BootstrapPreview = (typeof bootstrapPreviewStages)[number];
// Keep the old development-only launch URLs as aliases into one preview.
export const lifecyclePreviewEntries = {
  "agent-lifecycle": "system", "environment": "initialize", "environment-check": "system",
  "agent-upgrade": "upgrade", "agent-repair": "repair", "agent-start": "starting"
} as const;
export type LifecyclePreview = keyof typeof lifecyclePreviewEntries;
export type Preview = BootstrapPreview | LifecyclePreview | "agent-workspace";
export function isLifecyclePreview(value: Preview | string | null): value is LifecyclePreview {
  return value !== null && Object.hasOwn(lifecyclePreviewEntries,value);
}
export type BootstrapState =
  | { phase: "initializing" }
  | { phase: "storage" | "configuration" | "services" | "checking" }
  | { phase: "backup" | "migration" | "dataVerifying" | "recovery" }
  | { phase: "initializationFailed" }
  | { phase: "migrationFailed"; retryable: boolean }
  | { phase: "incompatible" }
  | { phase: "update"; update: ClientUpdateState }
  | { phase: "ready" };

export function isBootstrapPreview(value: Preview | null): value is BootstrapPreview {
  return bootstrapPreviewStages.some(stage => stage === value);
}

export function bootstrapPreviewStage(state: Exclude<BootstrapState, {phase: "ready"}>): BootstrapPreview {
  if (state.phase === "initializing") return "startup";
  if (state.phase === "update") return state.update.phase;
  return state.phase;
}

// Preview retries move to the associated stage without performing an operation.
export function bootstrapRetryPreview(state: Exclude<BootstrapState, {phase: "ready"}>): BootstrapPreview | null {
  if (state.phase === "initializationFailed") return "startup";
  if (state.phase === "migrationFailed") return state.retryable ? "backup" : null;
  if (state.phase === "incompatible") return "checking";
  if (state.phase === "update") {
    if (state.update.phase === "failed") return "downloading";
    if (state.update.phase === "verificationFailed") return "checking";
  }
  return null;
}

export function requestedPreview(search: string): Preview | null {
  const preview = new URLSearchParams(search).get("preview");
  return preview === "startup" || preview === "agent-workspace" || isLifecyclePreview(preview) ? preview : null;
}

export function activePreview(profile: string | undefined, preview: Preview | null): Preview | null {
  return profile === "development" ? preview : null;
}

// The actual Bootstrap gate has already completed before a development fixture is selected.
export function bootstrapState(localReady: boolean, initFailed: boolean, preview: Preview | null, t: Messages): BootstrapState {
  if (!localReady) return { phase: initFailed ? "initializationFailed" : "initializing" };
  switch (preview) {
    case "startup": return { phase: "initializing" };
    case "storage": case "configuration": case "services": case "checking":
    case "backup": case "migration": case "dataVerifying": case "recovery":
    case "initializationFailed": case "incompatible":
      return { phase: preview };
    case "migrationFailed": return { phase: "migrationFailed", retryable: true };
    case "downloading": case "verifying": case "installing": case "restarting":
    case "failed": case "verificationFailed": case "permissionFailed":
      return { phase: "update", update: clientUpdatePreview(preview, t) };
    default: return { phase: "ready" };
  }
}

export function desktopPage(state: BootstrapState, settings: boolean, preview: Preview | null = null, remoteStage: RemotePreviewFlow["stage"] | null = null): DesktopPage {
  if (state.phase !== "ready") return "bootstrap";
  if (remoteStage) return remoteStage === "setup" ? "remote-setup" : "remote-connecting";
  if (settings) return "settings";
  if (isLifecyclePreview(preview)) return "agent-lifecycle";
  if (preview === "agent-workspace") return "agent-workspace";
  return "workspace";
}

export function hasWorkspaceControls(page: DesktopPage): boolean {
  return page !== "bootstrap";
}
