import { describe, expect, it, vi } from "vitest";
import { parseClientSettings, settingsAfterCommand, type ClientSettings } from "./client-settings";

const snapshot: ClientSettings = {
  preferences: {
    hideOnClose: true, desktopNotifications: false, errorNotifications: true, resultNotifications: false,
  },
  login: {registered: false, state: "disabled"},
  notificationPermission: "notGranted",
};

describe("Desktop settings RPC contract", () => {
  it("reads only an actual complete settings snapshot", () => {
    expect(parseClientSettings(snapshot)).toEqual(snapshot);
    for (const malformed of [
      {}, null, undefined, "", [], {preferences: snapshot.preferences},
      {...snapshot, login: {}}, {...snapshot, login: {...snapshot.login, registered: "false"}},
      {...snapshot, login: {...snapshot.login, state: "constructor"}},
      {...snapshot, notificationPermission: "invalid"},
      {...snapshot, preferences: {...snapshot.preferences, hideOnClose: 1}},
    ]) {
      expect(() => parseClientSettings(malformed)).toThrow("Invalid Desktop settings response");
    }
  });

  it("discards the real Wails successful void payload and reads settings once", async () => {
    for (const response of [{}, null, undefined, "", snapshot]) {
      const command = vi.fn(async () => response);
      const read = vi.fn(async () => snapshot);
      await expect(settingsAfterCommand(command, read)).resolves.toEqual(snapshot);
      expect(command).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(command.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!);
    }
  });

  it("propagates a failed command without replaying it", async () => {
    const command = vi.fn(async () => { throw new Error("open failed"); });
    const read = vi.fn(async () => snapshot);
    await expect(settingsAfterCommand(command, read)).rejects.toThrow("open failed");
    expect(command).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a malformed readback instead of committing an empty snapshot", async () => {
    const command = vi.fn(async () => ({}));
    const read = vi.fn(async () => ({}));
    await expect(settingsAfterCommand(command, read)).rejects.toThrow("Invalid Desktop settings response");
    expect(command).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
