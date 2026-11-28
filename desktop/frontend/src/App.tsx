import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Browser, Events, System, Window } from "@wailsio/runtime";
import { parseBootstrapSnapshot, realBootstrapState, type BootstrapSnapshot, type Info } from "./bootstrap-runtime";
import { applyDesktopTheme, darkTheme, isTheme, type Theme } from "./theme";
import { isLanguage, messages, resolveLocale, type Language, type MessageKey } from "./i18n";
import { agentTargets, selectedTarget } from "./agent-targets";
import { activePreview, bootstrapState, bootstrapRetryPreview, desktopPage, isBootstrapPreview, isLifecyclePreview, lifecyclePreviewEntries, requestedPreview, type Preview } from "./desktop-page";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import { SettingsView, type ClientLink } from "./components/SettingsView";
import { parseNativeMenuNavigation, type NativeMenuNavigation } from "./native-menu";
import { parseClientSettings, settingsAfterCommand, type ClientSettings, type PreferenceKey, type DiagnosticKind, type SettingsNotice } from "./client-settings";
import { BootstrapView } from "./components/BootstrapView";
import { WorkspaceView } from "./components/WorkspaceView";
import { AgentWorkspaceView } from "./components/AgentWorkspaceView";
import { LiveAgentWorkspaceView } from "./components/LiveAgentWorkspaceView";
import { AgentLifecycleView, UnifiedAgentLifecyclePreview } from "./components/AgentLifecycleView";
import { useAgentLifecycle } from "./use-agent-lifecycle";
import { AddRemoteView } from "./components/AddRemoteView";
import { RemoteConnectionView } from "./components/RemoteConnectionView";
import { useEnvironmentConnection } from "./use-environment-connection";
import { FoundationService } from "../bindings/github.com/bYiyLi/NexumAgent/desktop";

export default function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [theme, setTheme] = useState<Theme>("system");
  const [language, setLanguage] = useState<Language>("system");
  const [preferredLanguages, setPreferredLanguages] = useState(() => [...navigator.languages]);
  const [targetId, setTargetId] = useState("local");
  const [error, setError] = useState<MessageKey | null>(null);
  const [initFailed, setInitFailed] = useState(false);
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(null);
  const acceptedRevision = useRef(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [clientSettings, setClientSettings] = useState<ClientSettings | null>(null);
  const [settingsReadFailed, setSettingsReadFailed] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<SettingsNotice | null>(null);
  const settingsRead = useRef(0);
  const saveLock = useRef(false);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsNavigation, setSettingsNavigation] = useState<NativeMenuNavigation | null>(null);
  const handledMenuNavigation = useRef(0);
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const [requested, setRequested] = useState<Preview | null>(() => requestedPreview(window.location.search));
  const backendReady = snapshot?.phase === "ready" && !initFailed;
  const preview = backendReady ? activePreview(info?.profile, requested) : null;
  const resolvedDark = darkTheme(theme, systemDark);
  const locale = resolveLocale(language, preferredLanguages);
  const t = messages(locale);
  const bootstrap = backendReady ? bootstrapState(true, false, preview, t) : realBootstrapState(snapshot, initFailed, t);
  const isStartupPreview = backendReady && isBootstrapPreview(preview);
  const canPreview = backendReady && info?.profile === "development";
  const environment = useEnvironmentConnection(backendReady, {
    connected: (id, warning) => {
      setTargetId(id); setRequested(null); setSettingsOpen(false); setError(warning);

    },
    removed: id => setTargetId(old => old === id ? "local" : old),
    notice: setError,
  });
  const remoteFlow = environment.flow;
  const cancelRemote = environment.cancel;
  const canAddRemote = environment.available;
  const page = desktopPage(bootstrap, settingsOpen, preview, remoteFlow?.stage ?? null);
  const sampleProfile = isLifecyclePreview(preview) || preview === "agent-workspace" ? info?.profile : undefined;
  const targets = agentTargets(sampleProfile, info?.localHost, t, environment.snapshot?.environments);
  const current = selectedTarget(targets, targetId);
  const isMac = info ? info.platform === "darwin" : System.IsMac();
  const realLifecycle = backendReady && !preview && !remoteFlow && environment.available && (current.kind === "local" || current.kind === "ssh" && current.connected === true);
  const lifecycle = useAgentLifecycle(realLifecycle, current.id);
  const lifecycleLocked = lifecycle.busy;

  // Events invalidate snapshots; polling is a bounded fallback while the
  // startup gate is closed. Neither a timer nor a preview can mark ready.
  useEffect(() => {
    let active = true;
    let reading = false;
    let complete = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!active || reading || complete) return;
      if (timer !== undefined) clearTimeout(timer);
      reading = true;
      try {
        const value = parseBootstrapSnapshot(await FoundationService.GetBootstrapState());
        if (!active) return;
        if (value.revision >= acceptedRevision.current) {
          acceptedRevision.current = value.revision;
          setSnapshot(value);
          setInfo(value.info);
          if (isTheme(value.info.theme)) setTheme(value.info.theme);
          if (isLanguage(value.info.language)) setLanguage(value.info.language);
          setInitFailed(false);
          complete = value.phase === "ready";
        }
      } catch {
        if (active) setInitFailed(true);
      } finally {
        reading = false;
        if (active && !complete) timer = setTimeout(() => { void refresh(); }, 500);
      }
    };
    const off = Events.On("bootstrap:changed", () => { void refresh(); });
    void refresh();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); off(); };
  }, [loadAttempt]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    const updateLanguage = () => setPreferredLanguages([...navigator.languages]);
    update();
    media.addEventListener("change", update);
    window.addEventListener("languagechange", updateLanguage);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("languagechange", updateLanguage);
    };
  }, []);

  useLayoutEffect(() => {
    const rgb = applyDesktopTheme(resolvedDark);
    if (System.IsMac() || System.IsWindows()) {
      void Window.SetBackgroundColour(...rgb, 255).catch(() => {});
    }
  }, [resolvedDark]);

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const nativeSystemLocale = resolveLocale("system", preferredLanguages);
  useEffect(() => {
    if (System.IsMac() || System.IsWindows()) {
      void FoundationService.SetNativeMenuSystemLocale(nativeSystemLocale).catch(() => {});
    }
  }, [nativeSystemLocale]);

  // Subscribe only after the real Go startup gate. Read once on subscription
  // as well, so a menu request made before this effect is not lost.
  useEffect(() => {
    if (!backendReady) return;
    let active = true;
    let reading = false;
    let pending = false;
    const refresh = async () => {
      if (!active) return;
      if (reading) { pending = true; return; }
      reading = true;
      try {
        const request = parseNativeMenuNavigation(await FoundationService.GetNativeMenuNavigation());
        if (!active || !request || request.revision <= handledMenuNavigation.current) return;
        handledMenuNavigation.current = request.revision;
        setRequested(value => isBootstrapPreview(value) ? null : value);
        void cancelRemote();

        setSettingsOpen(true);
        setSettingsNavigation(request);
        setError(null);
      } catch { /* A failed read does not navigate or bypass startup. */ }
      finally {
        reading = false;
        if (pending && active) { pending = false; void refresh(); }
      }
    };
    const off = Events.On("desktop:menu-navigation", () => { void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    void refresh();
    return () => { active = false; off(); window.removeEventListener("focus", onFocus); };
  }, [backendReady, cancelRemote]);

  useEffect(() => {
    if (page !== "settings") return;
    let active = true;
    const refresh = () => {
      if (saveLock.current) return;
      const generation = ++settingsRead.current;
      FoundationService.Settings().then(parseClientSettings).then(value => {
        if (active && generation === settingsRead.current) {
          setClientSettings(value);
          setSettingsReadFailed(false);
        }
      }).catch(() => {
        if (active && generation === settingsRead.current) {
          setClientSettings(null);
          setSettingsReadFailed(true);
        }
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [page]);

  async function settingsAction(section: SettingsNotice["section"], action: () => Promise<ClientSettings>,
    errorKey: MessageKey, successKey?: MessageKey) {
    if (!info || saveLock.current) return;
    saveLock.current = true;
    ++settingsRead.current;
    setSaving(true);
    setSettingsNotice(null);
    try {
      setClientSettings(parseClientSettings(await action()));
      setSettingsReadFailed(false);
      if (successKey) setSettingsNotice({section, key: successKey, error: false});
    } catch {
      // A system action may have happened before an error or lost reply.
      // Read the authoritative state rather than guessing or retrying it.
      try {
        setClientSettings(parseClientSettings(await FoundationService.Settings()));
        setSettingsReadFailed(false);
      } catch {
        setClientSettings(null);
        setSettingsReadFailed(true);
      }
      setSettingsNotice({section, key: errorKey, error: true});
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  function changePreference(key: PreferenceKey, checked: boolean) {
    if (!clientSettings) return;
    const section = key === "hideOnClose" ? "general" : "notifications";
    void settingsAction(section, () => FoundationService.SetPreference(key, checked), "errorSavePreference");
  }

  function changeLogin(checked: boolean) {
    if (!clientSettings) return;
    void settingsAction("general", () => FoundationService.SetLaunchAtLogin(checked, locale), "errorLogin");
  }

  function openDiagnostic(kind: DiagnosticKind) {
    void settingsAction("diagnostics", () => settingsAfterCommand(
      () => FoundationService.OpenDiagnosticDirectory(kind, locale), FoundationService.Settings), "errorDiagnostic");
  }

  function testNotification() {
    void settingsAction("notifications", () => settingsAfterCommand(
      () => FoundationService.SendTestNotification(locale), FoundationService.Settings), "errorTestNotification", "testNotificationAccepted");
  }

  function refreshClientSettings() {
    void settingsAction("general", () => FoundationService.Settings(), "settingsReadFailed");
  }

  async function changeTheme(next: Theme) {
    if (!info || saveLock.current || next === theme) return;
    saveLock.current = true;
    setSaving(true);
    setError(null);
    try {
      await FoundationService.SetTheme(next);
      setTheme(next);
    } catch { setError("errorTheme"); }
    finally { saveLock.current = false; setSaving(false); }
  }

  async function changeLanguage(next: Language) {
    if (!info || saveLock.current || next === language) return;
    saveLock.current = true;
    setSaving(true);
    setError(null);
    try {
      await FoundationService.SetLanguage(next);
      setLanguage(next);
    } catch { setError("errorLanguage"); }
    finally { saveLock.current = false; setSaving(false); }
  }

  function windowAction(action: "minimise" | "hide") {
    // Both native and custom close controls use the Go window-closing hook.
    const result = action === "minimise" ? Window.Minimise() : Window.Close();
    void result.catch(() => setError("errorWindow"));
  }

  function openClientLink(link: ClientLink) {
    setError(null);
    const url = link === "website" ? "https://nexum.y2l.top/" : "https://github.com/bYiyLi/NexumAgent";
    void Browser.OpenURL(url).catch(() => setError("errorOpenLink"));
  }

  function openMarketplace() {
    setError(null);
    void FoundationService.OpenMarketplace().catch(() => setError("errorOpenLink"));
  }

  function exitClient() {
    void FoundationService.QuitDesktop().catch(() => setError("errorExit"));
  }

  function openPreview(next: Preview) {
    if (lifecycleLocked || !backendReady || info?.profile !== "development") return;

    setSettingsNavigation(null);
    setError(null);
    setRequested(next);
    if (remoteFlow) void cancelRemote();

    if (isLifecyclePreview(next) || next === "agent-workspace") {
      setTargetId("local");
      setSettingsOpen(false);
    }
  }

  function endPreview() {
    if (info?.profile !== "development") return;

    setSettingsNavigation(null);
    setClientSettings(null);
    setSettingsReadFailed(false);
    setSettingsNotice(null);
    setRequested(null);

    if (remoteFlow) void cancelRemote();
    setSettingsOpen(true);
  }

  function selectTarget(id: string) {
    if (lifecycleLocked || bootstrap.phase !== "ready") return;
    const target = targets.find(item => item.id === id);
    if (!target) return;

    setError(null);

    if (remoteFlow) void cancelRemote();
    if (target.kind === "ssh") {
      setRequested(null);
      if (!target.connected && target.environment) {
        setSettingsOpen(false);
        if (!remoteFlow) environment.reconnect(target.environment);
        return;
      }
    }
    setTargetId(id);
    if (canPreview && target.kind !== "ssh" && (isLifecyclePreview(preview) || preview === "agent-workspace" || target.kind === "preview")) {
      setRequested("agent-lifecycle");
      setSettingsOpen(false);
    }
  }

  function openWorkspacePreview() {
    if (!canPreview || current.kind === "ssh") return;
    setRequested("agent-workspace");
    setSettingsOpen(false);
  }

  function openRemote() {
    if (lifecycleLocked || !canAddRemote || bootstrap.phase !== "ready") return;
    setRequested(null);
    setSettingsOpen(false);
    environment.open();
  }

  function returnRemoteConfig() {
    if (remoteFlow) void cancelRemote(remoteFlow.draft, remoteFlow.existingId);
  }

  function closeRemote() {
    void cancelRemote();
    environmentTriggerRef.current?.focus();
  }

  function toggleSettings() {
    if (lifecycleLocked || page === "bootstrap") return;
    setSettingsNavigation(null);
    if (page !== "settings") {
      setClientSettings(null);
      setSettingsReadFailed(false);
      setSettingsNotice(null);
    }
    if (page === "remote-setup" || page === "remote-connecting") {
      void cancelRemote();
      setSettingsOpen(true);
    } else setSettingsOpen(value => !value);
    setError(null);
  }

  async function retryStartup() {
    setError(null);
    if (!initFailed && snapshot?.retryable) {
      try {
        // The actual next phase is read from Go, not manufactured by React.
        await FoundationService.RetryBootstrap();
      } catch { setError("bootstrapRetryError"); }
    }
    setLoadAttempt(value => value + 1);
  }

  return (
    <div className={`desktop-shell ${isMac ? "shell-mac" : "shell-windows"}`} data-page={page}>
      <DesktopTitleBar page={page} isMac={isMac} t={t} targets={targets} current={current}
        onSelect={selectTarget} onAddRemote={canAddRemote && !remoteFlow ? openRemote : undefined} triggerRef={environmentTriggerRef}
        onSettings={toggleSettings} onWindowAction={windowAction} locked={lifecycleLocked}/>
      <main className="desktop-content" aria-label={page === "bootstrap" ? t.startup : page === "settings" ? t.settings : page === "agent-lifecycle" ? t.previewAgentLifecycle : page === "agent-workspace" ? t.previewAgentWorkspace : page === "remote-setup" ? t.addRemoteEnvironment : page === "remote-connecting" ? t.remoteConnecting : t.workspace}
        data-agent-target={page === "workspace" || page === "agent-lifecycle" || page === "agent-workspace" ? current.id : undefined}>
        {bootstrap.phase !== "ready" ? (
          <BootstrapView t={t} state={bootstrap} preview={isStartupPreview}
            onRetry={() => {
              if (isStartupPreview) {
                const next = bootstrapRetryPreview(bootstrap);
                if (next) openPreview(next);
              } else void retryStartup();
            }}
            retryAvailable={isStartupPreview || initFailed || snapshot?.retryable === true}
            canQuit={isStartupPreview || snapshot?.canQuit !== false}
            onExit={exitClient} onEndPreview={endPreview}
            onViewLogs={isStartupPreview || snapshot?.canViewLogs ? () => {
              setError(null);
              void FoundationService.OpenDiagnosticDirectory("logs", locale).catch(() => setError("errorDiagnostic"));
            } : undefined}
            onManualInstall={!isStartupPreview && snapshot?.canManualInstall ? () => {
              setError(null);
              void FoundationService.OpenManualUpdate().catch(() => setError("bootstrapManualError"));
            } : undefined}
            onPreviewPhase={isStartupPreview ? openPreview : undefined}/>
        ) : page === "settings" && info ? (
          <SettingsView t={t} name={info.name} version={info.version} profile={info.profile} theme={theme} language={language}
            saving={saving} onTheme={changeTheme} onLanguage={changeLanguage} onPreview={openPreview} onOpenLink={openClientLink}
            navigation={settingsNavigation}
            settings={clientSettings} loadFailed={settingsReadFailed} notice={settingsNotice}
            onPreference={changePreference} onLogin={changeLogin} onDiagnostic={openDiagnostic}
            onRefresh={refreshClientSettings} onTestNotification={testNotification}/>
        ) : page === "remote-setup" && remoteFlow ? (
          <AddRemoteView t={t} initialDraft={remoteFlow.draft} preview={false} fixedEndpoint={Boolean(remoteFlow.existingId)}
            onChooseKey={environment.chooseKey} onClearKey={environment.clearKey} disabled={!environment.available}
            onConnect={(draft, form) => { void environment.start(draft, form, remoteFlow.existingId); }} onCancel={closeRemote}/>
        ) : page === "remote-connecting" && remoteFlow && remoteFlow.stage !== "setup" ? (
          <RemoteConnectionView t={t} draft={remoteFlow.draft} stage={remoteFlow.stage} preview={false}
            attempt={remoteFlow.attempt} onTrust={() => { void environment.trust(); }} onBack={returnRemoteConfig}/>
        ) : canPreview && page === "agent-lifecycle" && isLifecyclePreview(preview) ? (
          <UnifiedAgentLifecyclePreview key={current.id+":"+preview} t={t} current={current} initial={lifecyclePreviewEntries[preview]} onEndPreview={endPreview} onWorkspace={openWorkspacePreview}/>
        ) : page === "agent-workspace" && canPreview && current.kind !== "ssh" ? (
          <AgentWorkspaceView key={current.id} t={t} current={current} isMac={isMac} profile={info?.profile} onEndPreview={endPreview} onOpenMarketplace={openMarketplace}/>
        ) : page === "workspace" && realLifecycle ? (
          lifecycle.snapshot?.stage === "ready" && lifecycle.snapshot.summary && !lifecycle.snapshot.waitingForRuntime && !lifecycle.unavailable ? (
            <LiveAgentWorkspaceView key={current.id + ":" + lifecycle.snapshot.summary.bootId} t={t} current={current} isMac={isMac} profile={info?.profile} snapshot={{ ...lifecycle.snapshot, summary: lifecycle.snapshot.summary }} onEndPreview={endPreview} onOpenMarketplace={openMarketplace} onRecheck={lifecycle.recheck} onMaintenanceAction={lifecycle.maintenance}/>
          ) : <AgentLifecycleView key={current.id} t={t} current={current} lifecycle={lifecycle}/>
        ) : (
          <WorkspaceView key={current.id} current={current} t={t} disabled={!environment.available}
            onReconnect={() => { if (current.environment) environment.reconnect(current.environment); }}
            onDisconnect={() => { void environment.change(current.id, "disconnect"); }}
            onRemove={() => { void environment.change(current.id, "remove"); }}/>
        )}
        {(error || environment.readFailed && !preview && !remoteFlow) && <p role="alert" className="shell-error">{t[error ?? "environmentReadFailed"]}</p>}
        {environment.blocked && <button className="environment-recover" type="button" disabled={environment.working}
          onClick={() => { void cancelRemote(); }}>{t.remoteCancelConnection}</button>}
      </main>
    </div>
  );
}
