import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import { SettingsView } from "./components/SettingsView";
import { BootstrapView } from "./components/BootstrapView";
import { WorkspaceView } from "./components/WorkspaceView";
import { AgentWorkspaceView } from "./components/AgentWorkspaceView";
import { agentWorkspaceSections, sampleAgentWorkspace, type AgentWorkspaceSection } from "./agent-workspace";
import { AddRemoteView } from "./components/AddRemoteView";
import { remotePreviewDraft, validateRemoteDraft, remoteEndpoint, remoteConnectionStages } from "./remote-draft";
import { RemoteConnectionView } from "./components/RemoteConnectionView";
import { activePreview, bootstrapPreviewStages, bootstrapState, desktopPage, hasWorkspaceControls, requestedPreview, type DesktopPage } from "./desktop-page";
import { isLanguage, messages, resolveLocale } from "./i18n";
import { agentTargets } from "./agent-targets";

describe("Desktop shell states", () => {
  it("routes every incomplete bootstrap phase to the same protected page", () => {
    const t = messages("zh-CN");
    expect(bootstrapState(false, false, "downloading", t)).toEqual({ phase: "initializing" });
    expect(bootstrapState(false, true, "checking", t)).toEqual({ phase: "initializationFailed" });
    expect(bootstrapState(true, false, "startup", t)).toEqual({ phase: "initializing" });
    expect(bootstrapState(true, false, "checking", t)).toEqual({ phase: "checking" });
    expect(bootstrapState(true, false, "downloading", t)).toMatchObject({ phase: "update", update: { phase: "downloading", progress: 68 } });
    for (const preview of bootstrapPreviewStages) {
      expect(desktopPage(bootstrapState(true, false, preview, t), true)).toBe("bootstrap");
    }
    expect(desktopPage(bootstrapState(true, false, null, t), true)).toBe("settings");
    expect(desktopPage(bootstrapState(true, false, activePreview("production", "checking"), t), false)).toBe("workspace");
    expect(hasWorkspaceControls("bootstrap")).toBe(false);
    expect(hasWorkspaceControls("settings")).toBe(true);
    expect(hasWorkspaceControls("workspace")).toBe(true);
    expect(hasWorkspaceControls("agent-lifecycle")).toBe(true);
    expect(hasWorkspaceControls("remote-setup")).toBe(true);
    expect(desktopPage({ phase: "ready" }, true, "environment", "setup")).toBe("remote-setup");
    for (const stage of remoteConnectionStages) expect(desktopPage({ phase: "ready" }, false, "environment", stage)).toBe("remote-connecting");
    expect(desktopPage({ phase: "initializing" }, true, "environment", "connecting")).toBe("bootstrap");
    const check = activePreview("development", "environment-check");
    expect(desktopPage(bootstrapState(true, false, check, t), false, check)).toBe("agent-lifecycle");
    expect(desktopPage(bootstrapState(true, false, check, t), true, check)).toBe("settings");
    expect(desktopPage(bootstrapState(false, false, check, t), false, check)).toBe("bootstrap");
    expect(desktopPage({ phase: "ready" }, false, check, "setup")).toBe("remote-setup");
    expect(activePreview("production", check)).toBeNull();
    const environment = activePreview("development", "environment");
    expect(desktopPage(bootstrapState(true, false, environment, t), false, environment)).toBe("agent-lifecycle");
    expect(desktopPage(bootstrapState(true, false, environment, t), true, environment)).toBe("settings");
    expect(desktopPage(bootstrapState(false, false, environment, t), false, environment)).toBe("bootstrap");
    const upgrade = activePreview("development", "agent-upgrade");
    expect(desktopPage(bootstrapState(true, false, upgrade, t), false, upgrade)).toBe("agent-lifecycle");
    expect(desktopPage(bootstrapState(true, false, upgrade, t), true, upgrade)).toBe("settings");
    expect(desktopPage(bootstrapState(false, false, upgrade, t), false, upgrade)).toBe("bootstrap");
    expect(desktopPage(bootstrapState(true, false, upgrade, t), false, upgrade, "setup")).toBe("remote-setup");
    expect(activePreview("production", upgrade)).toBeNull();
    expect(hasWorkspaceControls("agent-lifecycle")).toBe(true);
    const workspace = activePreview("development", "agent-workspace");
    expect(desktopPage(bootstrapState(true, false, workspace, t), false, workspace)).toBe("agent-workspace");
    expect(desktopPage(bootstrapState(true, false, workspace, t), true, workspace)).toBe("settings");
    expect(desktopPage(bootstrapState(false, false, workspace, t), false, workspace)).toBe("bootstrap");
    expect(desktopPage({ phase: "ready" }, false, workspace, "setup")).toBe("remote-setup");
    expect(activePreview("production", workspace)).toBeNull();
    expect(hasWorkspaceControls("agent-workspace")).toBe(true);
    const production = activePreview("production", "environment");
    expect(desktopPage(bootstrapState(true, false, production, t), false, production)).toBe("workspace");
  });
  it("only resolves explicit development previews", () => {
    expect(requestedPreview("?preview=client-update")).toBeNull();
    expect(requestedPreview("?preview=startup")).toBe("startup");
    expect(requestedPreview("?preview=environment")).toBe("environment");
    expect(requestedPreview("?preview=environment-check")).toBe("environment-check");
    expect(requestedPreview("?preview=agent-upgrade")).toBe("agent-upgrade");
    expect(requestedPreview("?preview=agent-workspace")).toBe("agent-workspace");
    expect(activePreview("production", "agent-workspace")).toBeNull();
    expect(activePreview(undefined, "agent-workspace")).toBeNull();
    expect(activePreview("production", "agent-upgrade")).toBeNull();
    expect(activePreview(undefined, "agent-upgrade")).toBeNull();
    expect(activePreview("production", "environment")).toBeNull();
    expect(activePreview("production", "startup")).toBeNull();
    expect(requestedPreview("?preview=unknown")).toBeNull();
    expect(activePreview("production", "downloading")).toBeNull();
    expect(activePreview(undefined, "startup")).toBeNull();
    expect(activePreview("development", "startup")).toBe("startup");
  });
  it("renders the approved controls in both locales and on both platforms", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const targets = agentTargets("development", "Test Mac", t);
      for (const isMac of [true, false]) for (const page of ["workspace", "bootstrap", "settings", "agent-lifecycle", "remote-setup", "remote-connecting", "agent-workspace"] as DesktopPage[]) {
        const markup = renderToStaticMarkup(<DesktopTitleBar page={page} isMac={isMac} t={t} current={targets[0]!}
          targets={targets} onSelect={() => {}} onSettings={() => {}} onWindowAction={() => {}}/>);
        expect(markup.includes("nexum-mark.svg")).toBe(page !== "bootstrap");
        expect(markup.includes("settings-trigger")).toBe(hasWorkspaceControls(page));
        expect(markup.includes("agent-trigger")).toBe(hasWorkspaceControls(page));
        expect(markup.includes("titlebar-actions")).toBe(!isMac);
        if (page === "settings") expect(markup).toContain('aria-pressed="true"');
        if (page === "bootstrap") {
          expect(markup).not.toContain("titlebar-status");
          expect(markup).not.toContain(t.startup);
        }
      }
    }
  });
  it("does not present a selected target as a running Agent", () => {
    const t = messages("en-US");
    const markup = renderToStaticMarkup(<WorkspaceView current={agentTargets("production", "Test Mac", t)[0]!} t={t}/>);
    expect(markup).toContain(t.targetUnconnected);
    expect(markup).toContain("Test Mac");
    expect(markup).not.toContain("Running");
  });
  it("uses genuine settings, does not expose development previews in production", () => {
    const t = messages("en-US");
    const markup = renderToStaticMarkup(<SettingsView t={t} name="Nexum Desktop" version="0.1.0" profile="production"
      theme="dark" language="en-US" saving={false} onTheme={() => {}} onLanguage={() => {}} onPreview={() => {}} onOpenLink={() => {}} settings={null} loadFailed={false} notice={null} onPreference={() => {}} onLogin={() => {}} onDiagnostic={() => {}} onRefresh={() => {}} onTestNotification={() => {}}/>);
    expect(markup).toContain(t.settings);
    expect(markup).toContain("English");
    expect(markup).not.toContain(t.devPreviews);
    expect(markup).toContain('type="radio"');
  });
  it("exposes exactly one entry into the development bootstrap preview in both locales", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const markup = renderToStaticMarkup(<SettingsView t={t} name="Nexum Desktop Dev" version="0.1.0-dev" profile="development"
        theme="dark" language="system" saving={false} onTheme={() => {}} onLanguage={() => {}} onPreview={() => {}} onOpenLink={() => {}} settings={null} loadFailed={false} notice={null} onPreference={() => {}} onLogin={() => {}} onDiagnostic={() => {}} onRefresh={() => {}} onTestNotification={() => {}}/>);
      expect(markup.match(new RegExp(t.previewBootstrap, "g"))).toHaveLength(1);
      expect(markup.match(new RegExp(t.previewAgentLifecycle, "g"))).toHaveLength(1);
      expect(markup).not.toContain(t.previewEnvironmentCheck);
      expect(markup).not.toContain(t.previewAgentStart);
      expect(markup).not.toContain(t.previewAgentUpgrade);
      expect(markup).not.toContain(t.previewAgentRepair);
      expect(markup).toContain(t.previewAgentWorkspace);
      expect(markup).not.toContain(locale === "zh-CN" ? "客户端更新预览" : "Client update preview");
      expect(markup).not.toContain(locale === "zh-CN" ? "启动加载预览" : "Startup preview");
    }
  });
  it("renders the approved control center only as an explicitly labeled preview", () => {
    expect(Object.keys(agentWorkspaceSections)).toEqual(["capabilities", "materials", "activity", "maintenance"]);
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      for (const current of agentTargets("development", "Actual host", t)) {
        for (const isMac of [true, false]) {
          const summary = sampleAgentWorkspace(current, isMac);
          expect(summary).toMatchObject({runtime: "healthy", management: "connected", cloud: "online"});
          expect(summary.name).toBe(current.kind === "local" ? current.description : current.name);
          const markup = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac={isMac} onEndPreview={() => {}} onOpenMarketplace={() => {}}/>);
          expect(markup).toContain(t.remoteUiPreview);
          expect(markup).toContain(t.endPreview);
          expect(markup).toContain(summary.name);
          expect(markup).toContain(summary.platform + " · " + summary.arch + " · v1.1.0");
          expect(markup).toContain(t.agentWorkspaceHealthy);
          expect(markup).toContain(t.agentWorkspaceManagementConnected);
          expect(markup).toContain(t.agentWorkspaceCloudOnline);
          expect(markup.match(/data-workspace-section=/g)).toHaveLength(4);
          expect(markup).not.toContain('data-workspace-section="projects"');
          expect(markup).toMatch(/class="agent-workspace-tile" data-workspace-section="capabilities"/);
          expect(markup).toMatch(/class="agent-workspace-tile" data-workspace-section="materials"/);
          expect(markup).toMatch(/class="agent-workspace-tile" data-workspace-section="activity"/);
          expect(markup).toMatch(/class="agent-workspace-tile" data-workspace-section="maintenance"/);
          expect(markup.indexOf('data-workspace-section="maintenance"')).toBeLessThan(markup.indexOf('data-workspace-section="activity"'));
          expect(markup.match(/data-agent-action=/g)).toHaveLength(5);
          expect(markup).not.toContain("aria-valuenow=");
          for (const [key, value] of Object.entries(agentWorkspaceSections)) {
            expect(markup).toContain(t[value.title].replaceAll("&", "&amp;"));
            const subpage = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac={isMac} initialSection={key as AgentWorkspaceSection} onEndPreview={() => {}} onOpenMarketplace={() => {}}/>);
            expect(subpage).toContain(t.remoteUiPreview);
            expect(subpage).toContain(t.agentWorkspaceBack);
            expect(subpage).not.toContain(t.agentWorkspaceHealthy);
            if (key === "capabilities") {
              expect(subpage).not.toContain(t[value.title]);
              expect(subpage).not.toContain(t[value.detail]);
              expect(subpage).not.toContain(t.agentWorkspaceSectionNote);
              expect(subpage).toContain("GitHub");
              expect(subpage).toContain("CRM API");
              expect(subpage).toContain("@nexum-hub/browser");
              expect(subpage.match(/data-capability-kind=/g)).toHaveLength(5);
              expect(subpage).not.toContain("<input");
              expect(subpage).not.toContain("<hr");
              expect(subpage).not.toContain('role="separator"');
              // Five entries plus back/add and seven currently unavailable maintenance actions.
              expect(subpage.match(/<button/g)).toHaveLength(14);
              expect(subpage).toContain(t.agentCapabilityRemoveUnavailable);
            } else if (key === "materials") {
              expect(subpage).not.toContain(`<h1`);
              expect(subpage).not.toContain(t.agentWorkspaceSectionNote);
              expect(subpage.match(/data-material-kind=/g)).toHaveLength(6);
              expect(subpage).toContain("script-authoring");
              expect(subpage).toContain("AGENTS.md");
              expect(subpage).not.toContain("<input");
              expect(subpage).not.toContain("<hr");
              expect(subpage.match(/<button/g)).toHaveLength(8);
            } else if (key === "activity") {
              expect(subpage).not.toMatch(/<h[12]\b/);
              expect(subpage.match(/<ul\b/g)).toHaveLength(1);
              expect(subpage).not.toContain(t.agentWorkspaceSectionNote);
              expect(subpage.match(/data-activity-run=/g)).toHaveLength(6);
            } else {
              expect(subpage).toContain(t[value.title].replaceAll("&", "&amp;"));
              expect(subpage).toContain(t.agentWorkspaceSectionNote);
              expect(subpage.match(/<button/g)).toHaveLength(1);
            }
          }
        }
      }
    }
  });
  it("keeps Agent management available when its Cloud connection is offline", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const current = agentTargets("development", "Test Mac", t)[0]!;
      const liveSummary = { ...sampleAgentWorkspace(current, true), cloud: "offline" as const };
      const markup = renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac liveSummary={liveSummary} onEndPreview={() => {}} onOpenMarketplace={() => {}}/>);
      expect(markup).toContain(t.agentWorkspaceCloudOffline);
      expect(markup).not.toContain(t.remoteUiPreview);
      for (const section of ["capabilities", "materials", "activity", "maintenance"]) {
        expect(markup).toContain(`data-workspace-section="${section}"`);
      }
      expect(markup).not.toContain('data-workspace-section="projects"');
    }
  });
  it("renders the three authentication branches with sample-only controls", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const markup = renderToStaticMarkup(<AddRemoteView t={t} onConnect={() => {}} onCancel={() => {}}/>);
      expect(markup).toContain(t.remoteUiPreview);
      expect(markup).toContain(t.remoteConnectAdd);
      expect(markup).toContain(t.remoteTrustNotice);
      expect(markup).toContain(t.remoteAuthPassword);
      expect(markup).not.toContain('name="name"');
      expect(markup).toContain('value="192.0.2.10"');
      expect(markup).toContain('name="port"');
      expect(markup).toContain('value="password" selected=""');
      expect(markup).toContain('type="password"');
      expect(markup).toContain(t.remotePasswordPlaceholder);
      expect(markup).not.toContain('type="file"');
      expect(markup.indexOf('value="password"')).toBeLessThan(markup.indexOf('value="agent"'));
      const agent = renderToStaticMarkup(<AddRemoteView t={t} initialDraft={{ ...remotePreviewDraft(), auth: "agent" }} onConnect={() => {}} onCancel={() => {}}/>);
      expect(agent).toContain('value="agent" selected=""');
      expect(agent).toContain(t.remoteAgentHint);
      expect(agent).not.toContain('type="password"');
      expect(agent).not.toContain('name="name"');
      const key = renderToStaticMarkup(<AddRemoteView t={t} initialDraft={{ ...remotePreviewDraft(), auth: "key" }} onConnect={() => {}} onCancel={() => {}}/>);
      expect(key).toContain('value="key" selected=""');
      expect(key).toContain(t.remoteChooseSampleKey);
      expect(key).not.toContain('type="password"');
      expect(key).not.toContain('type="file"');
      expect(key).not.toContain('name="name"');
    }
  });
  it("validates only non-secret remote form input shape", () => {
    const draft = remotePreviewDraft();
    expect(draft.auth).toBe("password");
    expect(validateRemoteDraft(draft)).toBeNull();
    expect(draft).not.toHaveProperty("name");
    expect(remoteEndpoint({ ...draft, host: "::1" })).toBe("dev@[::1]:22");
    expect(validateRemoteDraft({ ...draft, host: "ssh://host" })?.field).toBe("host");
    expect(validateRemoteDraft({ ...draft, user: "two words" })?.field).toBe("user");
    for (const port of ["", "0", "65536", "1.5", "NaN", "22e0"]) expect(validateRemoteDraft({ ...draft, port })?.field).toBe("port");
    for (const port of ["1", "65535"]) expect(validateRemoteDraft({ ...draft, port })).toBeNull();
    expect(validateRemoteDraft({ ...draft, host: "::1", auth: "key" })).toBeNull();
  });
  it("renders connection stages without claiming a successful connection", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      for (const stage of remoteConnectionStages) {
        const markup = renderToStaticMarkup(<RemoteConnectionView t={t} draft={remotePreviewDraft()} stage={stage} onStage={() => {}} onBack={() => {}}/>);
        expect(markup).toContain(t.remoteUiPreview);
        expect(markup).toContain('class="ssh-target-name">192.0.2.10<');
        expect(markup).toContain("dev@192.0.2.10:22");
        const custom = renderToStaticMarkup(<RemoteConnectionView t={t} draft={{ ...remotePreviewDraft(), host: "test.example", user: "operator", port: "2222" }} stage={stage} onStage={() => {}} onBack={() => {}}/>);
        expect(custom).toContain('class="ssh-target-name">test.example<');
        expect(custom).toContain("operator@test.example:2222");
        expect(markup.includes('role="progressbar"')).toBe(stage === "connecting" || stage === "authenticating");
        expect(markup).not.toContain("aria-valuenow=");
        if (stage === "verify") {
          expect(markup).toContain("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
          expect(markup).toContain(t.remoteFingerprintSample);
        }
        if (stage === "hostChanged") {
          expect(markup).not.toContain("ssh-loading");
          expect(markup).toContain(t.remoteHostChangedAdvice);
        }
      }
    }
  });
  it("renders the minimal splash with an indeterminate loading cue in both locales", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const t = messages(locale);
      const markup = renderToStaticMarkup(<BootstrapView t={t} state={{ phase: "initializing" }} preview={false} onRetry={() => {}} onExit={() => {}} onEndPreview={() => {}}/>);
      expect(markup).toContain("startup-wordmark");
      expect(markup).toContain("Nexum");
      expect(markup).toContain("DESKTOP");
      expect(markup).toContain(t.initializing);
      expect(markup).toContain(t.initializingDetail);
      expect(markup).toContain('role="progressbar"');
      expect(markup).not.toContain("aria-valuenow=");
      expect(markup).not.toContain("<button");
      const preview = renderToStaticMarkup(<BootstrapView t={t} state={{ phase: "initializing" }} preview onRetry={() => {}} onExit={() => {}} onEndPreview={() => {}}/>);
      expect(preview).toContain(t.previewStartupNote);
      expect(preview).toContain(t.endPreview);
      const flow = renderToStaticMarkup(<BootstrapView t={t} state={{ phase: "initializing" }} preview
        onRetry={() => {}} onExit={() => {}} onEndPreview={() => {}} onPreviewPhase={() => {}}/>);
      expect(flow).toContain(t.previewPhase);
      expect(flow).toContain(t.previewStateInitializing);
      expect(flow).toContain(t.endPreview);
      expect(flow).toContain(t.initializing);
    }
  });
  it("offers retry/quit when startup fails instead of exposing workspace controls", () => {
    const t = messages("en-US");
    const markup = renderToStaticMarkup(<BootstrapView t={t} state={{ phase: "initializationFailed" }} preview={false} onRetry={() => {}} onExit={() => {}} onEndPreview={() => {}}/>);
    expect(markup).toContain(t.startupFailed);
    expect(markup).toContain(t.retry);
    expect(markup).toContain(t.exit);
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain(t.endPreview);
  });
});

describe("Desktop language preferences", () => {
  it("follows a supported system language or falls back to English", () => {
    expect(resolveLocale("system", ["zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(resolveLocale("system", ["ja-JP", "zh-CN"])).toBe("zh-CN");
    expect(resolveLocale("system", ["ja-JP"])).toBe("en-US");
    expect(resolveLocale("en-US", ["zh-CN"])).toBe("en-US");
    expect(resolveLocale("zh-CN", [])).toBe("zh-CN");
    expect(isLanguage("ja-JP")).toBe(false);
    expect(Object.keys(messages("zh-CN")).sort()).toEqual(Object.keys(messages("en-US")).sort());
  });
});
