import type { ClientSettings } from "../bindings/github.com/bYiyLi/NexumAgent/desktop/models";
import type { MessageKey } from "./i18n";

export type { ClientSettings };
export type PreferenceKey = "hideOnClose" | "desktopNotifications" | "errorNotifications" | "resultNotifications";
export type DiagnosticKind = "data" | "logs";
export type SettingsNotice = { section: "general" | "notifications" | "diagnostics"; key: MessageKey; error: boolean };

export const loginMessages: Record<string, MessageKey> = {
  enabled: "loginEnabled", disabled: "loginDisabled", registered: "loginRegistered",
  blocked: "loginBlocked", stale: "loginStale", unknown: "loginUnknown",
};
export const permissionMessages: Record<string, MessageKey> = {
  granted: "permissionGranted", notGranted: "permissionNotGranted",
  unknown: "permissionUnknown", unavailable: "permissionUnavailable",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Wails binding types describe the Go contract, not runtime validation.
// A successful void call returns {}, which is NOT a settings snapshot.
export function parseClientSettings(value: unknown): ClientSettings {
  if (!isRecord(value) || !isRecord(value.preferences) || !isRecord(value.login)) {
    throw new Error("Invalid Desktop settings response");
  }
  const p = value.preferences;
  if (typeof p.hideOnClose !== "boolean" || typeof p.desktopNotifications !== "boolean" ||
      typeof p.errorNotifications !== "boolean" || typeof p.resultNotifications !== "boolean" ||
      typeof value.login.registered !== "boolean" || typeof value.login.state !== "string" ||
      !Object.hasOwn(loginMessages, value.login.state) ||
      typeof value.notificationPermission !== "string" ||
      !Object.hasOwn(permissionMessages, value.notificationPermission)) {
    throw new Error("Invalid Desktop settings response");
  }
  return {
    preferences: {
      hideOnClose: p.hideOnClose, desktopNotifications: p.desktopNotifications,
      errorNotifications: p.errorNotifications, resultNotifications: p.resultNotifications,
    },
    login: {registered: value.login.registered, state: value.login.state},
    notificationPermission: value.notificationPermission,
  };
}

// Discard the command's wire payload even when it happens to be non-null.
// Only Settings() is the authoritative snapshot after a void operation.
export async function settingsAfterCommand(
  command: () => Promise<unknown>,
  read: () => Promise<unknown>,
): Promise<ClientSettings> {
  await command();
  return parseClientSettings(await read());
}
