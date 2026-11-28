import { useEffect, useId, useRef } from "react";
import type { NativeMenuNavigation } from "../native-menu";
import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import { Check, ChevronDown, ExternalLink, FileText, FolderOpen, ChevronRight } from "lucide-react";
import { isLanguage, type Language, type Messages } from "../i18n";
import type { Theme } from "../theme";
import type { Preview } from "../desktop-page";
import { loginMessages, permissionMessages, type ClientSettings, type PreferenceKey, type DiagnosticKind, type SettingsNotice } from "../client-settings";
import "./settings.css";

export type ClientLink = "website" | "github";

function SettingsToggle({ label, checked, disabled, description, onChange }: {
  label: string;
  checked: boolean;
  disabled: boolean;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="settings-row settings-option-row">
      <span className="settings-field-title">{label}</span>
      <Switch.Root className="settings-switch" aria-label={label} aria-describedby={description}
        checked={checked} disabled={disabled} onCheckedChange={onChange}>
        <Switch.Thumb className="settings-switch-thumb"/>
      </Switch.Root>
    </div>
  );
}

type Props = {
  t: Messages;
  name: string;
  version: string;
  profile: string;
  theme: Theme;
  language: Language;
  saving: boolean;
  navigation?: NativeMenuNavigation | null;
  onTheme: (theme: Theme) => void;
  onLanguage: (language: Language) => void;
  onPreview: (preview: Preview) => void;
  onOpenLink: (link: ClientLink) => void;
  settings: ClientSettings | null;
  loadFailed: boolean;
  notice: SettingsNotice | null;
  onPreference: (key: PreferenceKey, checked: boolean) => void;
  onLogin: (checked: boolean) => void;
  onDiagnostic: (kind: DiagnosticKind) => void;
  onRefresh: () => void;
  onTestNotification: () => void;
};

const themes = ["system", "light", "dark"] as const;
const languages = ["system", "zh-CN", "en-US"] as const;

export function SettingsView({ t, name, version, profile, theme, language, saving, navigation, onTheme, onLanguage, onPreview, onOpenLink, settings, loadFailed, notice, onPreference, onLogin, onDiagnostic, onRefresh, onTestNotification }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const aboutRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!navigation) return;
    const heading = navigation.destination === "about" ? aboutRef.current : titleRef.current;
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }, [navigation]);
  const themeGroup = useId();
  const generalHint = useId();
  const notificationsHint = useId();
  const diagnosisHint = useId();
  const development = profile === "development";
  const prefs = settings?.preferences;
  const locked = saving || !prefs;
  const loginNote = settings ? t[loginMessages[settings.login.state] ?? "loginUnknown"] : loadFailed ? t.settingsReadFailed : t.settingsLoading;
  const permissionNote = settings ? t[permissionMessages[settings.notificationPermission] ?? "permissionUnknown"] : loadFailed ? t.settingsReadFailed : t.settingsLoading;
  const sectionNotice = (section: SettingsNotice["section"]) => notice?.section === section ? (
    <p className={`settings-note${notice.error ? " settings-notice-error" : ""}`} role={notice.error ? "alert" : "status"}>{t[notice.key]}</p>
  ) : null;
  const languageLabel = (value: Language) => value === "system" ? t.system : value === "zh-CN" ? "简体中文" : "English";
  return (
    <div className="desktop-page settings-page">
      <h1 ref={titleRef} tabIndex={-1} className="desktop-page-title">{t.settings}</h1>
      {!settings && <div className="settings-status-row" role={loadFailed ? "alert" : "status"}>
        <p className="settings-note">{loadFailed ? t.settingsReadFailed : t.settingsLoading}</p>
        {loadFailed && <button type="button" className="settings-link" disabled={saving} onClick={onRefresh}>{t.retry}</button>}
      </div>}
      <section className="settings-section" aria-label={t.appearanceLanguage}>
        <h2 className="desktop-section-title">{t.appearanceLanguage}</h2>
        <div className="settings-group">
          <fieldset className="settings-theme-field" disabled={saving}>
            <legend className="settings-field-title">{t.theme}</legend>
            <div className="desktop-segmented">
              {themes.map(value => (
                <label key={value} className="desktop-segment">
                  <input type="radio" name={themeGroup} value={value} checked={theme === value} onChange={() => onTheme(value)}/>
                  <span>{t[value]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="settings-row settings-option-row settings-language-row">
            <span className="settings-field-title">{t.language}</span>
            <Menu.Root modal={false}>
              <Menu.Trigger disabled={saving} className="settings-language-trigger" aria-label={`${t.language}: ${languageLabel(language)}`}>
                <span>{languageLabel(language)}</span><ChevronDown size={14} aria-hidden="true"/>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner className="shell-menu-positioner" side="bottom" align="end" sideOffset={6}>
                  <Menu.Popup className="shell-menu settings-language-menu">
                    <Menu.RadioGroup value={language} onValueChange={value => { if (isLanguage(value)) onLanguage(value); }}>
                      {languages.map(value => (
                        <Menu.RadioItem key={value} value={value} closeOnClick className="shell-menu-item">
                          <span className="menu-item-text">{languageLabel(value)}</span>
                          <Menu.RadioItemIndicator><Check size={14} aria-hidden="true"/></Menu.RadioItemIndicator>
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </div>
      </section>
      <section className="settings-section" aria-label={t.general}>
        <h2 className="desktop-section-title">{t.general}</h2>
        <div className="settings-group">
          <SettingsToggle label={t.launchAtLogin} checked={settings?.login.registered ?? false}
            disabled={locked || settings?.login.state === "unknown"} description={generalHint} onChange={onLogin}/>
          <SettingsToggle label={t.hideOnClose} checked={prefs?.hideOnClose ?? false} disabled={locked}
            description={generalHint} onChange={checked => onPreference("hideOnClose", checked)}/>
        </div>
        <div className="settings-status-row">
          <p className="settings-note" id={generalHint}>{loginNote}</p>
          <button type="button" className="settings-link" disabled={saving} onClick={onRefresh}>{t.refreshSettings}</button>
        </div>
        {sectionNotice("general")}
      </section>
      <section className="settings-section" aria-label={t.notifications}>
        <h2 className="desktop-section-title">{t.notifications}</h2>
        <div className="settings-group">
          <SettingsToggle label={t.desktopNotifications} checked={prefs?.desktopNotifications ?? false} disabled={locked}
            description={notificationsHint} onChange={checked => onPreference("desktopNotifications", checked)}/>
          <SettingsToggle label={t.errorNotifications} checked={prefs?.errorNotifications ?? false}
            disabled={locked || !prefs?.desktopNotifications} description={notificationsHint}
            onChange={checked => onPreference("errorNotifications", checked)}/>
          <SettingsToggle label={t.resultNotifications} checked={prefs?.resultNotifications ?? false}
            disabled={locked || !prefs?.desktopNotifications} description={notificationsHint}
            onChange={checked => onPreference("resultNotifications", checked)}/>
        </div>
        <p className="settings-note" id={notificationsHint}>{permissionNote}</p>
        <button type="button" className="settings-link" disabled={locked || !prefs?.desktopNotifications || settings?.notificationPermission === "unavailable"}
          onClick={onTestNotification}>{t.testNotification}</button>
        {sectionNotice("notifications")}
      </section>
      <section className="settings-section" aria-label={t.diagnostics}>
        <h2 className="desktop-section-title">{t.diagnostics}</h2>
        <div className="settings-group">
          <button type="button" className="settings-action-row" disabled={saving} aria-describedby={diagnosisHint} onClick={() => onDiagnostic("data")}>
            <span>{t.clientDataDirectory}</span>
            <span className="settings-action-end"><FolderOpen size={15} strokeWidth={1.7} aria-hidden="true"/></span>
          </button>
          <button type="button" className="settings-action-row" disabled={saving} aria-describedby={diagnosisHint} onClick={() => onDiagnostic("logs")}>
            <span>{t.clientLogs}</span>
            <span className="settings-action-end"><FileText size={15} strokeWidth={1.7} aria-hidden="true"/></span>
          </button>
        </div>
        <p className="settings-note" id={diagnosisHint}>{t.diagnosticsNote}</p>
        {sectionNotice("diagnostics")}
      </section>
      <section className="settings-section" aria-label={t.about}>
        <h2 ref={aboutRef} tabIndex={-1} className="desktop-section-title">{t.about}</h2>
        <div className="settings-group">
          <div className="settings-about-name">{name}</div>
          <div className="settings-meta"><span>{t.version}</span><span className="settings-meta-value">{version}</span></div>
          <div className="settings-meta"><span>{t.channel}</span><span className="settings-meta-value">{development ? t.development : t.production}</span></div>
          <div className="settings-links">
            <button type="button" className="settings-link" onClick={() => onOpenLink("website")}>{t.website}<ExternalLink size={12} aria-hidden="true"/></button>
            <button type="button" className="settings-link" onClick={() => onOpenLink("github")}>GitHub<ExternalLink size={12} aria-hidden="true"/></button>
          </div>
        </div>
      </section>
      {development && (
        <section className="settings-section development-preview" aria-label={t.devPreviews}>
          <h2 className="desktop-section-title">{t.devPreviews}</h2>
          <div className="settings-group">
            <button type="button" className="settings-action-row" onClick={() => onPreview("startup")}>
              <span>{t.previewBootstrap}</span><ChevronRight size={15} strokeWidth={1.7} aria-hidden="true"/>
            </button>
            <button type="button" className="settings-action-row" onClick={() => onPreview("agent-lifecycle")}>
              <span>{t.previewAgentLifecycle}</span><ChevronRight size={15} strokeWidth={1.7} aria-hidden="true"/>
            </button>
            <button type="button" className="settings-action-row" onClick={() => onPreview("agent-workspace")}>
              <span>{t.previewAgentWorkspace}</span><ChevronRight size={15} strokeWidth={1.7} aria-hidden="true"/>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
