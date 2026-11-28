import { useEffect, useState } from "react";
import { Clipboard } from "@wailsio/runtime";
import { ArrowLeft, ChevronRight, FileText, RefreshCw } from "lucide-react";
import type { AgentSystemEvent, AgentSystemEvents, AgentTelemetry, AgentWorkspaceSummary } from "../agent-workspace";
import type { Messages } from "../i18n";
import { Button } from "./ui/button";

type Props = {
  t: Messages;
  agent: AgentWorkspaceSummary;
  profile?: string;
  onBack: () => void;
  onRecheck?: () => void;
  readTelemetry?: () => Promise<AgentTelemetry>;
  readSystemEvents?: () => Promise<AgentSystemEvents>;
  openCloudAgent?: () => Promise<void>;
};

function eventLabel(t: Messages, event: AgentSystemEvent): string {
  return {
    component_failed: t.agentAdminEventFailure,
    cloud_online: t.agentAdminEventCloudOnline,
    cloud_offline: t.agentAdminEventCloudOffline,
    host_ready: t.agentAdminEventHostReady,
    host_not_ready: t.agentAdminEventHostNotReady,
  }[event.kind];
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AgentAdministrationView({ t, agent, profile, onBack, onRecheck, readTelemetry, readSystemEvents }: Props) {
  const [refresh, setRefresh] = useState(0);
  const [sample, setSample] = useState<{ refresh: number; value: AgentTelemetry | null }>();
  const [showLogs, setShowLogs] = useState(false);
  const [events, setEvents] = useState<AgentSystemEvents | null>();
  const [copyResult, setCopyResult] = useState<"success" | "error">();
  const current = sample?.refresh === refresh ? sample.value : undefined;

  useEffect(() => {
    if (!readTelemetry) return;
    let active = true;
    void readTelemetry().then(
      value => { if (active) setSample({ refresh, value }); },
      () => { if (active) setSample({ refresh, value: null }); },
    );
    return () => { active = false; };
  }, [readTelemetry, refresh]);

  useEffect(() => {
    if (!showLogs || !readSystemEvents) return;
    let active = true;
    void readSystemEvents().then(
      value => { if (active) setEvents(value); },
      () => { if (active) setEvents(null); },
    );
    return () => { active = false; };
  }, [showLogs, readSystemEvents]);

  const cloud = { online: t.agentWorkspaceCloudOnline, offline: t.agentWorkspaceCloudOffline, unknown: t.agentWorkspaceCloudUnknown }[agent.cloud];
  const management = { connected: t.agentWorkspaceManagementConnected, disconnected: t.agentWorkspaceManagementDisconnected, unknown: t.agentWorkspaceManagementUnknown }[agent.management];
  const runtime = { healthy: t.agentWorkspaceHealthy, degraded: t.agentWorkspaceDegraded, stopped: t.agentWorkspaceStopped, unknown: t.agentWorkspaceUnknown }[agent.runtime];
  const loading = Boolean(readTelemetry) && current === undefined;
  const used = current?.cpu != null || current?.memory != null;

  async function copySummary() {
    const lines = [
      `Nexum Agent · ${agent.name}`,
      `${agent.platform} · ${agent.arch} · v${agent.version}`,
      `Profile · ${profile ?? sample?.value?.profile ?? t.agentAdminProfileUnknown}`,
      `${t.agentAdminService} · ${t.agentAdminServiceRunning}`,
      `${t.agentAdminEngine} · ${runtime}`,
      `${t.agentAdminManagement} · ${management}`,
      `Cloud · ${cloud}`,
      ...(events?.items.map(event => `${displayTime(event.time)} · ${eventLabel(t, event)}`) ?? []),
    ];
    try {
      await Clipboard.SetText(lines.join("\n"));
      setCopyResult("success");
    } catch {
      setCopyResult("error");
    }
  }

  if (showLogs) {
    return <section className="desktop-page agent-administration-page">
      <div className="agent-capabilities-toolbar">
        <Button type="button" className="agent-capabilities-back" variant="ghost" size="sm" onClick={() => setShowLogs(false)}>
          <ArrowLeft size={17} aria-hidden="true"/>{t.agentAdminBackMaintenance}
        </Button>
      </div>
      <h1 className="desktop-page-title" tabIndex={-1}>{t.agentAdminSystemLogs}</h1>
      <p className="desktop-page-description">{agent.name} · {profile ?? sample?.value?.profile ?? t.agentAdminProfileUnknown}</p>
      {!readSystemEvents || events === null ? <p role="status" className="agent-admin-description">{t.agentAdminSystemLogsUnavailable}</p> :
        events === undefined ? <p role="status" className="agent-admin-description">{t.agentAdminSystemLogsLoading}</p> :
          <div className="agent-admin-events">
            {events.items.length === 0 && !events.partial && <p>{t.agentAdminSystemLogsEmpty}</p>}
            {events.partial && <p>{t.agentAdminSystemLogsPartial}</p>}
            {events.items.length > 0 && <ul>{events.items.map((event, index) =>
              <li key={`${event.time}-${event.kind}-${index}`}>
                <strong>{eventLabel(t, event)}</strong>
                <small>{displayTime(event.time)} · {event.component === "node_host" ? "Node Host" : event.component === "cloud" ? "Cloud" : event.component}</small>
              </li>)}</ul>}
          </div>}
      <div className="agent-admin-actions">
        <Button type="button" variant="secondary" onClick={() => { void copySummary(); }}>{t.agentAdminCopySummary}</Button>
      </div>
      {copyResult && <p role="status" className="agent-admin-description">{copyResult === "success" ? t.agentAdminCopied : t.agentAdminCopyFailed}</p>}
    </section>;
  }

  return <section className="desktop-page agent-administration-page">
    <div className="agent-capabilities-toolbar">
      <Button type="button" className="agent-capabilities-back" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft size={17} aria-hidden="true"/>{t.agentWorkspaceBack}
      </Button>
    </div>
    <h1 className="desktop-page-title" tabIndex={-1}>{t.agentWorkspaceMaintenance}</h1>
    <p className="desktop-page-description">{agent.name} · {agent.platform} · {agent.arch}</p>

    <dl className="agent-admin-facts">
      <div><dt>{t.agentAdminVersion}</dt><dd>v{agent.version}</dd></div>
      <div><dt>Profile</dt><dd>{profile ?? sample?.value?.profile ?? t.agentAdminProfileUnknown}</dd></div>
      <div><dt>{t.agentAdminService}</dt><dd>{t.agentAdminServiceRunning}</dd></div>
      <div><dt>{t.agentAdminEngine}</dt><dd>{runtime}</dd></div>
      <div><dt>{t.agentAdminManagement}</dt><dd>{management}</dd></div>
      <div><dt>Cloud</dt><dd>{cloud}</dd></div>
    </dl>
    <section className="agent-admin-resources" aria-label={t.agentWorkspaceResources}>
      <div>
        <h2>Node Host · {t.agentWorkspaceResources}</h2>
        <Button type="button" variant="ghost" size="icon" className="agent-capabilities-add" disabled={!readTelemetry || loading}
          aria-label={t.agentAdminRefresh} title={t.agentAdminRefresh} onClick={() => setRefresh(value => value + 1)}>
          <RefreshCw size={16} aria-hidden="true"/>
        </Button>
      </div>
      {loading ? <p role="status">{t.agentAdminTelemetryLoading}</p> : used ? <>
        <dl className="agent-admin-facts agent-admin-telemetry" aria-label="Node Host">
          <div><dt>CPU</dt><dd>{current?.cpu == null ? t.agentWorkspaceUnknown : `${current.cpu}%`}</dd></div>
          <div><dt>RSS</dt><dd>{current?.memory == null ? t.agentWorkspaceUnknown : `${current.memory} MiB`}</dd></div>
        </dl>
        {current?.observedAt && <p>{t.agentAdminObservedAt} · {displayTime(current.observedAt)}</p>}
      </> : <p role="status">{t.agentAdminTelemetryUnavailable}</p>}
    </section>
    <button type="button" className="agent-admin-logs" onClick={() => { setEvents(undefined); setCopyResult(undefined); setShowLogs(true); }}>
      <FileText size={19} aria-hidden="true"/>
      <span><strong>{t.agentAdminSystemLogs}</strong><small>{t.agentAdminSystemLogsDetail}</small></span>
      <ChevronRight size={16} aria-hidden="true"/>
    </button>
    {onRecheck && <div className="agent-admin-actions">
      <Button type="button" variant="secondary" onClick={onRecheck}>{t.lifecycleRecheck}</Button>
    </div>}
  </section>;
}
