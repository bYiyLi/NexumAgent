import { isLanguage } from "./i18n";
import type { Messages } from "./i18n";
import { isTheme } from "./theme";
import type { BootstrapState } from "./desktop-page";

const phases = [
  "initializing", "storage", "configuration", "services", "checking",
  "downloading", "verifying", "installing", "restarting", "backup",
  "migration", "dataVerifying", "recovery", "initializationFailed",
  "failed", "verificationFailed", "migrationFailed", "incompatible", "permissionFailed", "ready",
] as const;
type Phase = (typeof phases)[number];
export type Info = { profile: string; name: string; version: string; theme: string; language: string; localHost: string; platform: string };
export type BootstrapSnapshot = {
  revision: number; phase: Phase; info: Info;
  currentVersion: string; targetVersion: string; downloadedBytes: number; totalBytes: number;
  errorCode: string; retryable: boolean; canViewLogs: boolean; canQuit: boolean;
  canManualInstall: boolean; updateCheck: string;
};
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function validInfo(v: unknown): v is Info {
  return record(v) && (v.profile === "development" || v.profile === "production") &&
    typeof v.name === "string" && typeof v.version === "string" &&
    typeof v.theme === "string" && isTheme(v.theme) &&
    typeof v.language === "string" && isLanguage(v.language) &&
    typeof v.localHost === "string" && typeof v.platform === "string";
}
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }

// A generated Wails binding is not runtime validation. In particular {}, the
// successful wire payload of a void binding, is not a Bootstrap snapshot.
export function parseBootstrapSnapshot(v: unknown): BootstrapSnapshot {
  if (!record(v) || !validInfo(v.info) || !integer(v.revision) || v.revision === 0 ||
      !phases.some(p => p === v.phase) || typeof v.currentVersion !== "string" ||
      typeof v.targetVersion !== "string" || !integer(v.downloadedBytes) || !integer(v.totalBytes) ||
      (v.totalBytes > 0 && v.downloadedBytes > v.totalBytes) || typeof v.errorCode !== "string" ||
      typeof v.retryable !== "boolean" || typeof v.canViewLogs !== "boolean" ||
      typeof v.canQuit !== "boolean" || typeof v.canManualInstall !== "boolean" ||
      !["notChecked","current","offline","localBuild","required"].some(k => k === v.updateCheck)) {
    throw new Error("Invalid Desktop Bootstrap response");
  }
  if (v.phase === "ready" && (v.errorCode !== "" || v.updateCheck === "required" || v.updateCheck === "notChecked")) {
    throw new Error("Inconsistent Desktop readiness");
  }
  return v as BootstrapSnapshot;
}

export function realBootstrapState(snapshot: BootstrapSnapshot | null, transportFailed: boolean, t: Messages): BootstrapState {
  if (transportFailed) return {phase:"initializationFailed"};
  if (!snapshot) return {phase:"initializing"};
  const versions = {currentVersion:snapshot.currentVersion, targetVersion:snapshot.targetVersion};
  switch (snapshot.phase) {
    case "downloading":
      return {phase:"update", update:{...versions,phase:"downloading",
        progress:snapshot.totalBytes > 0 ? 100*snapshot.downloadedBytes/snapshot.totalBytes : null}};
    case "verifying": case "installing": case "restarting":
      return {phase:"update",update:{...versions,phase:snapshot.phase}};
    case "failed": case "verificationFailed": case "permissionFailed": {
      const message = snapshot.errorCode === "permission" ? t.bootstrapPermissionDetail :
        snapshot.errorCode === "trustConfiguration" ? t.bootstrapTrustConfiguration :
        snapshot.errorCode === "updateState" || snapshot.errorCode === "recovery" ? t.bootstrapRecoveryError :
        snapshot.errorCode === "installation" ? t.bootstrapInstallationError :
        snapshot.phase === "verificationFailed" ? t.bootstrapVerificationFailedDetail : t.previewFailure;
      return {phase:"update",update:{...versions,phase:snapshot.phase,message}};
    }
    case "migrationFailed": return {phase:"migrationFailed",retryable:snapshot.retryable};
    default: return {phase:snapshot.phase};
  }
}
