import type { RemoteAuth, RemoteConnectionStage, RemoteDraft } from "./remote-draft";
import type { MessageKey } from "./i18n";

export type EnvironmentView = {
  id: string; kind: "local" | "ssh"; hostname: string; host: string; port: number;
  username: string; authType: RemoteAuth | ""; platform: string; arch: string;
  connected: boolean; hasSavedCredential: boolean;
};
export type EnvironmentAttempt = {
  id: string; phase: RemoteConnectionStage | "connected"; errorCode: string;
  fingerprint: string; keyType: string; environmentId: string; warning: string;
};
export type EnvironmentSnapshot = { revision: number; environments: EnvironmentView[]; attempt: EnvironmentAttempt | null };
export type SSHKeySelection = { token: string; name: string };
export type RemoteSecrets = { password: string; keyToken: string; passphrase: string; remember: boolean };
export type EnvironmentFlow = {
  draft: RemoteDraft; stage: "setup" | RemoteConnectionStage;
  existingId?: string; attempt?: EnvironmentAttempt;
};

const stages = ["connecting", "verify", "authenticating", "failed", "authFailed", "hostChanged", "connected"];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringFields(value: Record<string, unknown>, keys: string[]) {
  return keys.every(k => typeof value[k] === "string");
}
export function parseEnvironmentAttempt(value: unknown): EnvironmentAttempt {
  if (!record(value) || !stringFields(value, ["id", "phase", "errorCode", "fingerprint", "keyType", "environmentId", "warning"]) ||
      !value.id || !stages.includes(String(value.phase)) ||
      value.phase === "verify" && (!value.fingerprint || !value.keyType) ||
      value.phase === "connected" && !value.environmentId) throw new Error("Invalid environment attempt");
  return value as EnvironmentAttempt;
}
export function parseEnvironmentSnapshot(value: unknown): EnvironmentSnapshot {
  if (!record(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      !Array.isArray(value.environments)) throw new Error("Invalid environment state");
  const ids = new Set<string>();
  const environments = value.environments.map((item: unknown): EnvironmentView => {
    if (!record(item) || !stringFields(item, ["id", "kind", "hostname", "host", "username", "authType", "platform", "arch"]) ||
        !item.id || ids.has(String(item.id)) || typeof item.connected !== "boolean" || typeof item.hasSavedCredential !== "boolean" ||
        !["darwin", "windows", "linux"].includes(String(item.platform)) || !["amd64", "arm64"].includes(String(item.arch)) ||
        !Number.isInteger(item.port) || item.kind !== "local" && item.kind !== "ssh" ||
        item.kind === "local" && (item.id !== "local" || !item.connected) ||
        item.kind === "ssh" && (item.id === "local" || !item.host || !item.username || Number(item.port) < 1 || Number(item.port) > 65535 ||
          !["password", "key", "agent"].includes(String(item.authType)))) throw new Error("Invalid environment entry");
    ids.add(String(item.id));
    return item as EnvironmentView;
  });
  if (!ids.has("local")) throw new Error("Missing local environment");
  return { revision: Number(value.revision), environments, attempt: value.attempt === null ? null : parseEnvironmentAttempt(value.attempt) };
}
export function parseKeySelection(value: unknown): SSHKeySelection {
  if (!record(value) || typeof value.token !== "string" || typeof value.name !== "string") throw new Error("Invalid key selection");
  return { token: value.token, name: value.name };
}
export function emptyRemoteDraft(): RemoteDraft { return { host: "", port: "22", user: "", auth: "password" }; }
export function savedRemoteDraft(view: EnvironmentView): RemoteDraft {
  return { host: view.host, port: String(view.port), user: view.username, auth: view.authType || "password" };
}
export function connectionErrorKey(code: string): MessageKey {
  switch (code) {
    case "network": return "remoteNetworkError";
    case "timeout": return "remoteTimeout";
    case "auth_failed": case "credentials_required": return "remoteAuthFailureDetail";
    case "key_unavailable": case "key_invalid": case "key_passphrase_required": return "remoteRealKeyFailure";
    case "ssh_agent_unavailable": return "remoteSSHAgentUnavailable";
    case "sftp_unavailable": return "remoteSFTPUnavailable";
    case "unsupported_environment": return "remoteUnsupportedEnvironment";
    case "credential_store": case "credential_cleanup_failed": return "remoteCredentialStoreError";
    case "environment_store": return "environmentReadFailed";
    case "already_connected": return "remoteAlreadyConnected";
    default: return "remoteConnectFailed";
  }
}
