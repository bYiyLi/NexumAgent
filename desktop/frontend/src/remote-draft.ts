import type { MessageKey } from "./i18n";

export type RemoteAuth = "agent" | "key" | "password";
export type RemoteDraft = { host: string; user: string; port: string; auth: RemoteAuth };
export const remoteConnectionStages = ["connecting", "verify", "authenticating", "failed", "authFailed", "hostChanged"] as const;
export type RemoteConnectionStage = (typeof remoteConnectionStages)[number];
export type RemotePreviewFlow = { draft: RemoteDraft; stage: "setup" | RemoteConnectionStage };
type DraftIssue = { field: keyof RemoteDraft; message: MessageKey };

// Presentation fixtures only. Never store credentials in this type.
export function remotePreviewDraft(): RemoteDraft {
  return { host: "192.0.2.10", user: "dev", port: "22", auth: "password" };
}

export function remoteEndpoint(draft: RemoteDraft): string {
  const host = draft.host.includes(":") && !draft.host.startsWith("[") ? "[" + draft.host + "]" : draft.host;
  return draft.user + "@" + host + ":" + draft.port;
}

// UI field shape only; this does not authorize or attempt any connection.
export function validateRemoteDraft(draft: RemoteDraft): DraftIssue | null {
  if (!draft.host || /[\s/@\\]/u.test(draft.host)) return { field: "host", message: "remoteHostInvalid" };
  if (!/^\d+$/u.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535) {
    return { field: "port", message: "remotePortInvalid" };
  }
  if (!draft.user || /[\s/@\\]/u.test(draft.user)) return { field: "user", message: "remoteUserInvalid" };
  if (!["agent", "key", "password"].includes(draft.auth)) return { field: "auth", message: "remoteAuthInvalid" };
  return null;
}
