import { messages, type Messages } from "./i18n";

type UpdateVersion = { currentVersion: string; targetVersion: string };

export type ClientUpdateState = UpdateVersion & (
  | { phase: "downloading"; progress: number | null }
  | { phase: "verifying" | "installing" | "restarting" }
  | { phase: "failed" | "verificationFailed" | "permissionFailed"; message: string }
);

export function clientUpdatePreview(phase: ClientUpdateState["phase"] = "downloading", t: Messages = messages("zh-CN")): ClientUpdateState {
  const versions = { currentVersion: "0.1.0", targetVersion: "0.2.0" };
  if (phase === "downloading") return { ...versions, phase, progress: 68 };
  if (phase === "failed") return { ...versions, phase, message: t.previewFailure };
  if (phase === "verificationFailed") return { ...versions, phase, message: t.bootstrapVerificationFailedDetail };
  if (phase === "permissionFailed") return { ...versions, phase, message: t.bootstrapPermissionDetail };
  return { ...versions, phase };
}
