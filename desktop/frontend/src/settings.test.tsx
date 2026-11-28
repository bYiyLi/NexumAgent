import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsView } from "./components/SettingsView";
import type { ClientSettings } from "./client-settings";
import { messages } from "./i18n";

const noop = () => {};
const settings: ClientSettings = {
  preferences: {hideOnClose: true, desktopNotifications: true, errorNotifications: false, resultNotifications: true},
  login: {registered: true, state: "enabled"}, notificationPermission: "granted",
};

function renderSettings(profile: string, locale: "zh-CN" | "en-US", state: ClientSettings | null = settings) {
  return renderToStaticMarkup(<SettingsView t={messages(locale)} name="Nexum Desktop" version="0.1.0" profile={profile}
    theme="system" language="system" saving={false} onTheme={noop} onLanguage={noop} onPreview={noop} onOpenLink={noop}
    settings={state} loadFailed={false} notice={null} onPreference={noop} onLogin={noop} onDiagnostic={noop}
    onRefresh={noop} onTestNotification={noop}/>);
}

const switches = (html: string) => [...html.matchAll(/<[^>]*role="switch"[^>]*>/g)].map(m => m[0]);

describe("flat application settings", () => {
  it("renders five sections without decorative panels, with real controls in both profiles", () => {
    for (const locale of ["zh-CN","en-US"] as const) {
      const t=messages(locale);
      for (const profile of ["production","development"]) {
        const html=renderSettings(profile,locale);
        for (const key of ["appearanceLanguage","general","notifications","diagnostics","about"] as const) expect(html).toContain(t[key].replaceAll("&","&amp;"));
        expect(html).not.toContain('class="desktop-panel');
        expect(html).toContain(t.permissionGranted);
        expect(html).toContain(t.loginEnabled);
        expect(html).toContain(t.testNotification);
        expect(switches(html)).toHaveLength(5);
        expect(switches(html).every(tag=>!tag.includes('aria-disabled="true"'))).toBe(true);
        expect(html.includes(t.devPreviews)).toBe(profile==="development");
      }
    }
  });
  it("shows observed permission separately from preferences and disables child switches when the master is off", () => {
    const t=messages("en-US");
    const html=renderSettings("production","en-US",{...settings,preferences:{...settings.preferences,desktopNotifications:false},notificationPermission:"notGranted"});
    expect(html).toContain(t.permissionNotGranted);
    const rows=switches(html);
    expect(rows[2]).toContain('aria-checked="false"');
    expect(rows[3]).toContain('aria-disabled="true"');
    expect(rows[4]).toContain('aria-disabled="true"');
    expect(rows[4]).toContain('aria-checked="true"');
    expect(rows[0]).not.toContain('aria-disabled="true"');
  });
  it("does not enable settings controls before actual state is read", () => {
    const html=renderSettings("development","zh-CN",null);
    expect(html).toContain(messages("zh-CN").settingsLoading);
    expect(switches(html).every(tag=>tag.includes('aria-disabled="true"'))).toBe(true);
  });
});
