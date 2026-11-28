import { useState } from "react";
import { ArrowUpCircle, Globe, Package, Plug, RotateCw, Trash2, ChevronRight } from "lucide-react";
import type { Messages } from "../i18n";
import { capabilityAlertText, type AgentCapability, type AgentCapabilityDetail, type CapabilityAlert } from "../agent-capabilities";
import { Button } from "./ui/button";

export const capabilityIcons = { mcp: Plug, api: Globe, npm: Package };
export const capabilityLabels = { mcp: "MCP", api: "API", npm: "npm" } as const;

export function CapabilityActions({ t, item, compact = false, transport, onReconnect, onRemove, onUpdate, maintenanceBlocked = false, reconnectBlocked = false, reconnecting = false }: {
  t: Messages; item: AgentCapability; compact?: boolean; transport?: unknown; onReconnect?: () => void; reconnectBlocked?: boolean; reconnecting?: boolean;
  onRemove?: () => void; onUpdate?: () => void; maintenanceBlocked?: boolean;
}) {
  const remove = item.kind === "npm" ? t.agentCapabilityUninstall : t.agentCapabilityRemove;
  const reconnect = transport === "stdio" ? t.agentCapabilityRestart : t.agentCapabilityReconnect;
  const enabled = !!onReconnect && !!item.revision && !reconnectBlocked;
  return <div className={compact ? "cap-maintenance-actions cap-list-actions" : "cap-maintenance-actions"}>
    {item.kind === "mcp" && <span title={enabled ? reconnect : t.agentCapabilityReconnectUnavailable}>
      <Button type="button" variant="ghost" size={compact ? "icon-sm" : "sm"} className="cap-action-button" disabled={!enabled} onClick={onReconnect}
        aria-label={`${reconnecting ? t.agentCapabilityReconnecting : reconnect} ${item.name}${enabled ? "" : ` · ${t.agentCapabilityReconnectUnavailable}`}`}>
        <RotateCw size={16} aria-hidden="true"/>{!compact && (reconnecting ? t.agentCapabilityReconnecting : reconnect)}
      </Button>
    </span>}
    {onUpdate && <span title={t.agentCapabilityUpdate}>
      <Button type="button" variant="ghost" size={compact ? "icon-sm" : "sm"} className="cap-action-button" disabled={maintenanceBlocked} onClick={onUpdate}
        aria-label={`${t.agentCapabilityUpdate} ${item.name}`}>
        <ArrowUpCircle size={16} aria-hidden="true"/>{!compact && t.agentCapabilityUpdate}
      </Button>
    </span>}
    <span title={onRemove && item.revision ? remove : t.agentCapabilityRemoveUnavailable}>
      <Button type="button" variant="ghost" size={compact ? "icon-sm" : "sm"} className="cap-action-button cap-action-remove" disabled={!onRemove || !item.revision || maintenanceBlocked} onClick={onRemove}
        aria-label={`${remove} ${item.name}${onRemove && item.revision ? "" : ` · ${t.agentCapabilityRemoveUnavailable}`}`}>
        <Trash2 size={16} aria-hidden="true"/>{!compact && remove}
      </Button>
    </span>
  </div>;
}

export function AgentCapabilityDetail({ t, detail, alerts = [], reconnectAvailable = false, maintenanceAvailable = false }: { t: Messages; detail: AgentCapabilityDetail; alerts?: readonly CapabilityAlert[]; reconnectAvailable?: boolean; maintenanceAvailable?: boolean }) {
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const Icon = capabilityIcons[detail.kind];
  const labels: Record<string, string> = {
    type: t.agentCapabilityConfigType, url: t.agentCapabilityConfigURL, serviceUrl: t.agentCapabilityConfigURL,
    command: t.agentCapabilityConfigCommand, args: t.agentCapabilityConfigArgs, env: t.agentCapabilityConfigEnv,
    headers: t.agentCapabilityConfigHeaders, limits: t.agentCapabilityConfigLimits, name: t.agentCapabilityConfigPackage,
    installedVersion: t.agentCapabilityConfigInstalled, declaredVersion: t.agentCapabilityConfigDeclared, namespace: t.agentCapabilityConfigNamespace,
    installationState: t.agentCapabilityConfigInstallState,
  };
  const valueText = (value: unknown) => value === "[hidden]" ? t.agentCapabilityHidden : value === "missing" ? t.agentCapabilityPackageMissing : value === "invalid" ? t.agentCapabilityPackageInvalid :
    typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value, null, 2);
  const methodsTitle = detail.kind === "mcp" ? t.agentCapabilityTools : detail.kind === "api" ? t.agentCapabilityOperations : t.agentCapabilitySDKMethods;
  return <div className="cap-detail">
    <div className="agent-material-identity">
      <span className="agent-capabilities-icon"><Icon size={19} strokeWidth={1.7} aria-hidden="true"/></span>
      <div className="agent-capabilities-copy"><h1 className="agent-material-name">{detail.name}</h1>
        <span className="agent-material-meta">{capabilityLabels[detail.kind]}</span></div>
    </div>
    {alerts.map(alert => <div className="capability-alert-detail" data-level={alert.level} key={`${alert.reason}:${alert.version ?? ""}`} role="status">
      <span>{capabilityAlertText(t, detail.kind, alert)}</span>
      <small>{t.agentCapabilityObservedAt} · {new Date(alert.observedAt).toLocaleString()}</small>
    </div>)}
    {detail.kind === "api" && <p className="cap-detail-note">{t.agentCapabilityConnectivityUnknown}</p>}
    {(detail.kind === "mcp" && !reconnectAvailable || !maintenanceAvailable) && <p className="cap-action-unavailable" role="status">
      {detail.kind === "mcp" && !reconnectAvailable && <>{t.agentCapabilityReconnectUnavailable}{!maintenanceAvailable ? " · " : ""}</>}
      {!maintenanceAvailable && t.agentCapabilityRemoveUnavailable}
    </p>}
    <section className="cap-detail-section" aria-labelledby="cap-config-heading">
      <div className="cap-detail-section-head"><h2 id="cap-config-heading">{detail.kind === "npm" ? t.agentCapabilityPackageInformation : t.agentCapabilityConfiguration}</h2>
        <fieldset className="desktop-segmented cap-detail-config-modes" aria-label={t.agentCapabilityConfiguration}>
          {(["visual", "json"] as const).map(option => <label className="desktop-segment" key={option}>
            <input type="radio" name="capability-config-mode" checked={mode === option} onChange={() => setMode(option)}/>
            <span>{option === "visual" ? t.agentCapabilityVisual : t.agentCapabilityJSON}</span>
          </label>)}
        </fieldset>
      </div>
      {mode === "visual" ? <dl className="cap-detail-facts">{Object.entries(detail.configuration).map(([key, value]) =>
        <div className="cap-detail-fact" key={key}><dt>{labels[key] ?? key}</dt><dd>{valueText(value)}</dd></div>)}</dl>
        : <div className="cap-detail-raw"><pre aria-label={t.agentCapabilityJSONLabel}><code>{JSON.stringify(detail.configuration, null, 2)}</code></pre></div>}
      <p className="cap-detail-note">{detail.kind === "npm" ? t.agentCapabilityPackageExcerpt : t.agentCapabilityRedacted}</p>
    </section>
    <section className="cap-detail-section" aria-labelledby="cap-methods-heading">
      <div className="cap-detail-section-head"><h2 id="cap-methods-heading">{methodsTitle}</h2><span className="cap-detail-count">{detail.methods.length}</span></div>
      {detail.methods.map(method => <details className="cap-detail-method" key={`${method.method ?? ""}:${method.name}`}>
        <summary><span className="cap-detail-method-main"><span className="cap-detail-method-name">{method.method && <b>{method.method}</b>}{method.path || method.name}</span>
          {method.description && <span className="cap-detail-method-description">{method.description}</span>}</span><ChevronRight size={15} aria-hidden="true"/></summary>
        {method.parameters.length === 0 ? <p className="cap-detail-param-heading">{t.agentCapabilityNoParameters}</p> : <>
          <p className="cap-detail-param-heading">{t.agentCapabilityParameters}</p>
          <dl className="cap-detail-params">{method.parameters.map((parameter, index) => <div className="cap-detail-param" key={`${parameter.location ?? ""}:${parameter.name}:${index}`}>
            <dt><code>{parameter.name}</code></dt><dd>{[parameter.location, parameter.type].filter(Boolean).join(" · ")}</dd><dd>{parameter.required ? t.agentCapabilityRequired : t.agentCapabilityOptional}</dd>
          </div>)}</dl>
        </>}
      </details>)}
      {!detail.methodsComplete && <p className="cap-detail-note" role="status">{t.agentCapabilityMethodsUnavailable}</p>}
      {detail.methodsComplete && detail.methods.length === 0 && <p className="cap-detail-note">{t.agentCapabilityMethodsEmpty}</p>}
    </section>
  </div>;
}
