import { useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, BookOpen, Check, ChevronRight, Cloud, LayoutGrid, Lightbulb, ShieldAlert, SlidersHorizontal } from "lucide-react";
import type { AgentTarget } from "../agent-targets";
import type { Messages } from "../i18n";
import { previewAgentCapabilities, unavailableAgentCapabilities, type AgentCapabilitiesInventory, type AgentCapability, type AgentCapabilityDetail, type CapabilityObservation, type CapabilityReconnectResult } from "../agent-capabilities";
import { AgentCapabilitiesView } from "./AgentCapabilitiesView";
import { previewAgentMaterials, unavailableAgentMaterials, type AgentMaterialsInventory, type MaterialRemoval, type ReadMaterial } from "../agent-materials";
import { AgentMaterialsView } from "./AgentMaterialsView";
import { previewAgentActivity, unavailableAgentActivity, type AgentActivityInventory } from "../agent-activity";
import { AgentActivityView } from "./AgentActivityView";
import type { ReadActivity } from "../agent-activity-runtime";
import { agentWorkspaceSections, sampleAgentWorkspace, type AgentSystemEvents, type AgentTelemetry, type AgentWorkspaceSection, type AgentWorkspaceSummary } from "../agent-workspace";
import { AgentAdministrationView } from "./AgentAdministrationView";
import { AgentMaintenanceActions, type AgentMaintenanceAction } from "./AgentMaintenanceActions";
import { Button } from "./ui/button";

const icons = { capabilities: LayoutGrid, materials: BookOpen, activity: Activity, maintenance: SlidersHorizontal };
const primarySections = ["capabilities", "materials", "maintenance", "activity"] as const;

type Props = {
  t: Messages;
  current: AgentTarget;
  isMac: boolean;
  onEndPreview: () => void;
  onOpenMarketplace: () => void;
  initialSection?: AgentWorkspaceSection;
  resumeCapabilities?: boolean;
  liveSummary?: AgentWorkspaceSummary;
  profile?: string;
  onMaintenanceAction?: (action: AgentMaintenanceAction) => void;
  maintenanceNotice?: string;
  onRecheck?: () => void;
  capabilities?: AgentCapabilitiesInventory;
  capabilityObservation?: CapabilityObservation;
  onOpenCapabilities?: () => void;
  reconnectCapability?: (item: AgentCapability) => Promise<CapabilityReconnectResult>;
  maintainCapability?: (item: AgentCapability, action: "remove" | "update", version?: string) => Promise<void>;
  readCapabilityDetail?: (item: AgentCapability) => Promise<AgentCapabilityDetail>;
  onCapabilityDetailViewingChange?: (viewing: boolean) => Promise<void>;
  materials?: AgentMaterialsInventory;
  readMaterials?: () => Promise<AgentMaterialsInventory>;
  readMaterial?: ReadMaterial;
  removeMaterial?: MaterialRemoval;
  refreshMaterials?: () => void;
  readTelemetry?: () => Promise<AgentTelemetry>;
  readSystemEvents?: () => Promise<AgentSystemEvents>;
  openCloudAgent?: () => Promise<void>;
  activity?: AgentActivityInventory;
  readActivity?: ReadActivity;
};

function WorkspaceIdentity({ t, summary }: { t: Messages; summary: AgentWorkspaceSummary }) {
  const health = {
    healthy: t.agentWorkspaceHealthy, degraded: t.agentWorkspaceDegraded,
    stopped: t.agentWorkspaceStopped, unknown: t.agentWorkspaceUnknown,
  }[summary.runtime];
  return (
    <div className="agent-workspace-identity">
      <div className="agent-workspace-mark">
        <img src="/nexum-mark.svg" alt="" aria-hidden="true"/>
        <span className="agent-workspace-mark-dot" data-healthy={summary.runtime === "healthy"} aria-hidden="true"/>
      </div>
      <h1 className="agent-workspace-name" tabIndex={-1}>{summary.name}</h1>
      <p className="agent-workspace-meta">{summary.platform} · {summary.arch} · v{summary.version}</p>
      <p className="agent-workspace-health" data-healthy={summary.runtime === "healthy"}><span aria-hidden="true"/>{health}</p>
      <div className="agent-workspace-connections" aria-label={t.agentWorkspaceConnectionStatus}>
        <span className="agent-workspace-connection" data-healthy={summary.management === "connected"}>
          <Check size={14} strokeWidth={2} aria-hidden="true"/>
          {summary.management === "connected" ? t.agentWorkspaceManagementConnected : summary.management === "disconnected" ? t.agentWorkspaceManagementDisconnected : t.agentWorkspaceManagementUnknown}
        </span>
        <span className="agent-workspace-connection" data-healthy={summary.cloud === "online"}>
          <Cloud size={15} strokeWidth={1.7} aria-hidden="true"/>
          {summary.cloud === "online" ? t.agentWorkspaceCloudOnline : summary.cloud === "offline" ? t.agentWorkspaceCloudOffline : t.agentWorkspaceCloudUnknown}
        </span>
      </div>
    </div>
  );
}

// Live admission requires an authoritative summary supplied by the lifecycle controller.
// Explicit development previews alone use sample facts.
export function AgentWorkspaceView({ t, current, isMac, onEndPreview, onOpenMarketplace, initialSection, resumeCapabilities, liveSummary, profile, onMaintenanceAction, maintenanceNotice, onRecheck, capabilities, capabilityObservation, onOpenCapabilities, reconnectCapability, maintainCapability, readCapabilityDetail, onCapabilityDetailViewingChange, materials, readMaterials, readMaterial, removeMaterial, refreshMaterials, readTelemetry, readSystemEvents, openCloudAgent, activity, readActivity }: Props) {
  const [section, setSection] = useState<AgentWorkspaceSection | null>(initialSection ?? null);
  const root = useRef<HTMLDivElement>(null);
  const lastSection = useRef<AgentWorkspaceSection | null>(null);
  const resumed = useRef(false);
  useEffect(() => { if (resumeCapabilities && !resumed.current) { resumed.current = true; setSection("capabilities"); onOpenCapabilities?.(); } }, [resumeCapabilities, onOpenCapabilities]);
  const summary = liveSummary ?? sampleAgentWorkspace(current, isMac);
  const preview = !liveSummary;
  const capabilityInventory = capabilities ?? (preview ? previewAgentCapabilities(t) : unavailableAgentCapabilities);
  const materialInventory = liveSummary && liveSummary.cloud !== "online" ? unavailableAgentMaterials
    : materials ?? (preview ? previewAgentMaterials(t) : unavailableAgentMaterials);
  const activityInventory = activity ?? (preview ? previewAgentActivity(t) : unavailableAgentActivity);
  const danger = materialInventory.items.some(item => item.notice === "danger");
  const advice = materialInventory.items.some(item => item.notice === "advice");
  const updates = materialInventory.items.filter(item => item.notice === "update").length;

  useEffect(() => {
    const previous = lastSection.current;
    const target = section ? root.current?.querySelector<HTMLElement>(section === "capabilities" ? "[data-agent-capabilities-back]" : section === "materials" ? "[data-agent-materials-back]" : section === "activity" ? "[data-agent-activity-back]" : "h1")
      : previous ? root.current?.querySelector<HTMLElement>(`[data-workspace-section="${previous}"]`)
      : root.current?.querySelector<HTMLElement>("h1");
    target?.focus({ preventScroll: true });
  }, [section]);

  function openSection(next: AgentWorkspaceSection) {
    lastSection.current = next;
    if (next === "capabilities") onOpenCapabilities?.();
    setSection(next);
  }

  function entry(key: AgentWorkspaceSection) {
    const value = agentWorkspaceSections[key];
    const Icon = icons[key];
    const notice = key === "materials" ? (danger ? "danger" : advice ? "advice" : updates ? "update" : undefined)
      : key === "capabilities" ? (capabilityObservation?.severity === "problem" ? "danger" : capabilityObservation?.severity) : undefined;
    const noticeText = key === "capabilities" ? (notice === "danger" ? t.agentCapabilitiesProblem : notice === "advice" ? t.agentCapabilitiesAdvice : "")
      : notice === "danger" ? t.agentMaterialsDanger : notice === "advice" ? t.agentMaterialsAdvice
      : notice === "update" ? t.agentMaterialsUpdateCount.replace("{count}", String(updates)) : "";
    return (
      <button key={key} type="button" className="agent-workspace-tile"
        data-workspace-section={key} onClick={() => openSection(key)} aria-label={notice ? `${t[value.title]} · ${noticeText}` : undefined}>
        <Icon size={key === "maintenance" ? 22 : 24} strokeWidth={1.7} className="agent-workspace-entry-icon" aria-hidden="true"/>
        <span className="agent-workspace-entry-copy">
          <span className="agent-workspace-entry-title">{t[value.title]}</span>
          <span className="agent-workspace-entry-detail">{t[value.detail]}</span>
        </span>
        <ChevronRight size={15} strokeWidth={1.7} className="agent-workspace-entry-chevron" aria-hidden="true"/>
        {notice && <span className="agent-material-badge" data-notice={notice} aria-hidden="true">
          {notice === "danger" ? <><ShieldAlert size={12}/>{noticeText}</> :
            notice === "advice" ? <><Lightbulb size={12}/>{noticeText}</> : updates}
        </span>}
      </button>
    );
  }

  if (section === "capabilities") {
    return (
      <div ref={root} className="agent-workspace-capabilities-shell" data-workspace-view="capabilities">
        <AgentCapabilitiesView t={t} target={[summary.name, profile].filter(Boolean).join(" · ")} inventory={capabilityInventory} alerts={capabilityObservation?.alerts} operations={capabilityObservation?.operations} preview={preview} onBack={() => setSection(null)} onOpenMarketplace={onOpenMarketplace} readDetail={readCapabilityDetail} reconnect={reconnectCapability} maintenance={maintainCapability} onDetailViewingChange={onCapabilityDetailViewingChange}/>
      </div>
    );
  }

  if (section === "materials") {
    return (
      <div ref={root} className="agent-workspace-capabilities-shell" data-workspace-view="materials">
        <AgentMaterialsView t={t} inventory={materialInventory} preview={preview} onBack={() => setSection(null)} onOpenMarketplace={onOpenMarketplace}
          readList={readMaterials} readDetail={readMaterial} removeMaterial={removeMaterial} onRefresh={refreshMaterials}/>
      </div>
    );
  }

  if (section === "activity") {
    return <div ref={root} className="agent-workspace-capabilities-shell" data-workspace-view="activity">
      <AgentActivityView t={t} inventory={activityInventory} preview={preview} onBack={() => setSection(null)} readActivity={readActivity}/>
    </div>;
  }

  if (section && liveSummary) {
    return <div ref={root} className="agent-workspace-capabilities-shell" data-workspace-view={section}>
      <AgentAdministrationView key={section} t={t} agent={liveSummary} onBack={() => setSection(null)}
        profile={profile} onRecheck={onRecheck} readTelemetry={readTelemetry} readSystemEvents={readSystemEvents} openCloudAgent={openCloudAgent}/>
    </div>;
  }

  if (section) {
    const value = agentWorkspaceSections[section];
    const Icon = icons[section];
    return (
      <div ref={root} className="desktop-page agent-workspace-subpage" data-workspace-view={section}>
        <div className="agent-workspace-subpage-toolbar">
          <Button type="button" variant="ghost" className="agent-workspace-back" onClick={() => setSection(null)}>
            <ArrowLeft size={17} aria-hidden="true"/>{t.agentWorkspaceBack}
          </Button>
          {preview && <span>{t.remoteUiPreview}</span>}
        </div>
        <div className="agent-workspace-subpage-icon"><Icon size={26} strokeWidth={1.7} aria-hidden="true"/></div>
        <h1 className="desktop-page-title" tabIndex={-1}>{t[value.title]}</h1>
        <p className="desktop-page-description">{preview ? t.agentWorkspaceSectionNote : t.lifecycleWorkspaceNote}</p>
        <section className="agent-workspace-section-scope" aria-label={t.agentWorkspaceSectionScope}>
          {value.items.map(item => <div key={item}>{Object.hasOwn(t, item) ? t[item as keyof Messages] : item}</div>)}
        </section>
      </div>
    );
  }

  return (
    <div ref={root} className="agent-workspace-page" data-workspace-view="overview">
      {preview && <span className="agent-workspace-preview-label">{t.remoteUiPreview}</span>}
      <WorkspaceIdentity t={t} summary={summary}/>
      <nav className="agent-workspace-grid" aria-label={t.agentWorkspaceNavigation}>
        {primarySections.map(entry)}
      </nav>
      <footer className="agent-workspace-footer">
        {preview && <button type="button" onClick={onEndPreview}>{t.endPreview}</button>}
        <AgentMaintenanceActions t={t} name={summary.name} profile={profile} cloud={summary.cloud} onAction={onMaintenanceAction} notice={maintenanceNotice}/>
      </footer>
    </div>
  );
}
