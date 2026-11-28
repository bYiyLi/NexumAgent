import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
import type { Messages } from "../i18n";
import { capabilityAlertText, type AgentCapabilitiesInventory, type AgentCapability, type AgentCapabilityDetail, type CapabilityAlert, type CapabilityMaintenanceProgress, type CapabilityReconnectResult } from "../agent-capabilities";
import { previewCapabilityDetails } from "../agent-capability-preview";
import { AgentCapabilityDetail as CapabilityDetailView, CapabilityActions, capabilityIcons, capabilityLabels } from "./AgentCapabilityDetail";
import { Button } from "./ui/button";
import { MaintenanceConfirmation } from "./MaintenanceConfirmation";

type Props = {
  t: Messages;
  inventory: AgentCapabilitiesInventory;
  alerts?: readonly CapabilityAlert[];
  preview: boolean;
  target?: string;
  onBack: () => void;
  onOpenMarketplace: () => void;
  readDetail?: (item: AgentCapability) => Promise<AgentCapabilityDetail>;
  reconnect?: (item: AgentCapability) => Promise<CapabilityReconnectResult>;
  maintenance?: (item: AgentCapability, action: "remove" | "update", version?: string) => Promise<void>;
  operations?: readonly CapabilityMaintenanceProgress[];
  onDetailViewingChange?: (viewing: boolean) => Promise<void>;
};

export function AgentCapabilitiesView({ t, inventory, alerts = [], operations = [], preview, target = "", onBack, onOpenMarketplace, readDetail, reconnect, maintenance, onDetailViewingChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<{ identity: string; state: "loading" | "unavailable" | "available"; value?: AgentCapabilityDetail } | null>(null);
  const [detailEpoch, setDetailEpoch] = useState(0);
  const [operation, setOperation] = useState<{ id: string; revision?: string; state: "running" | CapabilityReconnectResult } | null>(null);
  const [confirmation, setConfirmation] = useState<{item: AgentCapability; action: "remove" | "update"; version?: string} | null>(null);
  const [requestError, setRequestError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const root = useRef<HTMLElement>(null);
  const previousSelection = useRef<string | null>(null);
  const savedScroll = useRef(0);
  const viewingDetail = useRef(false);
  const selected = inventory.items.find(item => item.id === selectedId);
  const id = selected?.id, name = selected?.name, kind = selected?.kind, revision = selected?.revision;
  const identity = id && name && kind ? JSON.stringify([id, name, kind]) : null;

  useEffect(() => () => {
    if (viewingDetail.current) void onDetailViewingChange?.(false).catch(() => {});
  }, [onDetailViewingChange]);

  useEffect(() => {
    if (!selected && viewingDetail.current) {
      viewingDetail.current = false;
      void onDetailViewingChange?.(false).catch(() => {});
    }
  }, [selected, onDetailViewingChange]);

  useLayoutEffect(() => {
    const scroll = root.current?.closest<HTMLElement>(".desktop-content");
    if (id) {
      if (scroll) scroll.scrollTop = 0;
      root.current?.querySelector<HTMLElement>("[data-agent-capabilities-back]")?.focus({ preventScroll: true });
      previousSelection.current = id;
    } else if (previousSelection.current) {
      if (scroll) scroll.scrollTop = savedScroll.current;
      const buttons = root.current?.querySelectorAll<HTMLElement>("[data-capability-id]");
      const previous = Array.from(buttons ?? []).find(button => button.dataset.capabilityId === previousSelection.current);
      (previous ?? root.current?.querySelector<HTMLElement>("[data-agent-capabilities-back]"))?.focus({ preventScroll: true });
      previousSelection.current = null;
    }
  }, [id]);

  useEffect(() => {
    if (!id || !name || !kind || !identity) return;
    let active = true;
    const item: AgentCapability = { id, name, kind };
    const load = async () => {
      try {
        const result = preview ? previewCapabilityDetails[id] : await readDetail?.(item);
        if (!result || result.id !== id || result.name !== name || result.kind !== kind) throw new Error("detail unavailable");
        if (active) setDetailState({ identity, state: "available", value: result });
      } catch {
        if (active) setDetailState({ identity, state: "unavailable" });
      }
    };
    setDetailState({ identity, state: "loading" });
    void load();
    return () => { active = false; };
  }, [id, name, kind, revision, identity, preview, readDetail, detailEpoch]);

  async function reconnectItem(item: AgentCapability) {
    if (!reconnect || !item.revision || operation?.state === "running" || (operation?.id === item.id && operation.state === "unknown")) return;
    setOperation({ id: item.id, revision: item.revision, state: "running" });
    let result: CapabilityReconnectResult;
    try { result = await reconnect(item); } catch { result = "unknown"; }
    setOperation({ id: item.id, revision: item.revision, state: result });
    if (result === "succeeded") setDetailEpoch(value => value + 1);
  }

  function operationText(item: AgentCapability) {
    const progress = operations.find(value => value.id === item.id);
    if (progress) return maintenanceText(progress);
    if (!operation || operation.id !== item.id || (operation.state !== "unknown" && operation.revision !== item.revision)) return "";
    return { running: t.agentCapabilityReconnecting, succeeded: t.agentCapabilityReconnectSucceeded, busy: t.agentCapabilityBusy,
      changed: t.agentCapabilityChanged, unknown: t.agentCapabilityOutcomeUnknown }[operation.state];
  }

  function maintenanceText(progress: CapabilityMaintenanceProgress) {
    if (progress.errorCode?.startsWith("package_changed_restart_")) return t.agentCapabilityRestartUnconfirmed;
    const message = { executing: t.agentCapabilityExecuting, succeeded: t.agentCapabilityMaintenanceSucceeded, failed: t.agentCapabilityMaintenanceFailed,
      busy: t.agentCapabilityBusy, changed: t.agentCapabilityChanged, unavailable: t.agentCapabilityMaintenanceUnavailable, unknown: t.agentCapabilityOutcomeUnknown }[progress.status];
    return message;
  }

  function actions(item: AgentCapability, compact = false, transport?: unknown) {
    const current = operation?.id === item.id ? operation.state : undefined;
    const progress = operations.find(value => value.id === item.id);
    const maintenanceBlocked = !!progress && (!["succeeded", "failed", "busy", "changed", "unavailable"].includes(progress.status) ||
      progress.status === "succeeded" && (!progress.revision || progress.revision === item.revision));
    const update = alerts.find(alert => alert.id === item.id && alert.reason === "npm_update_available")?.version;
    return <CapabilityActions t={t} item={item} compact={compact} transport={transport} onReconnect={reconnect ? () => { void reconnectItem(item); } : undefined}
      onRemove={maintenance ? () => { setRequestError(false); setConfirmation({item, action: "remove"}); } : undefined}
      onUpdate={maintenance && item.kind === "npm" && update ? () => { setRequestError(false); setConfirmation({item, action: "update", version: update}); } : undefined}
      maintenanceBlocked={maintenanceBlocked || submitting || operations.some(op => op.status === "executing") || operation?.state === "running"}
      reconnecting={current === "running"} reconnectBlocked={maintenanceBlocked || operation?.state === "running" || current === "unknown" || current === "changed" && operation?.revision === item.revision}/>;
  }

  async function select(item: AgentCapability) {
    savedScroll.current = root.current?.closest<HTMLElement>(".desktop-content")?.scrollTop ?? 0;
    viewingDetail.current = true;
    try { await onDetailViewingChange?.(true); } catch { viewingDetail.current = false; return; }
    setSelectedId(item.id);
  }

  function back() {
    if (!selected) { onBack(); return; }
    viewingDetail.current = false;
    void onDetailViewingChange?.(false).catch(() => {});
    setSelectedId(null);
  }

  const currentDetail = detailState?.identity === identity ? detailState : null;
  const confirmedItem = confirmation && inventory.items.find(item => item.id === confirmation.item.id && item.revision === confirmation.item.revision);
  const validConfirmation = !!maintenance && !!confirmedItem && (confirmation?.action !== "update" || alerts.some(alert => alert.id === confirmedItem.id && alert.reason === "npm_update_available" && alert.version === confirmation.version));
  async function confirmMaintenance() {
    if (!confirmation || !validConfirmation || !maintenance || submitLock.current) return;
    submitLock.current = true; setSubmitting(true); setConfirmation(null);
    try { await maintenance(confirmation.item, confirmation.action, confirmation.version); }
    catch { setRequestError(true); }
    finally { submitLock.current = false; setSubmitting(false); }
  }

  return (
    <section ref={root} className="desktop-page agent-capabilities-page" aria-label={t.agentCapabilitiesPage} data-agent-capabilities>
      <MaintenanceConfirmation open={!!confirmation} title={confirmation?.action === "update" ? t.agentCapabilityConfirmUpdate : t.agentCapabilityConfirmRemove}
        target={[target, confirmation?.item.name, confirmation?.version].filter(Boolean).join(" · ")}
        description={confirmation?.item.kind === "npm" ? t.agentCapabilityPackageRestartWarning : t.agentCapabilityRemoveWarning}
        cancelLabel={t.remoteCancel} confirmLabel={confirmation?.action === "update" ? t.agentCapabilityUpdate : confirmation?.item.kind === "npm" ? t.agentCapabilityUninstall : t.agentCapabilityRemove}
        destructive={confirmation?.action !== "update"} disabled={!validConfirmation || submitting} onClose={() => setConfirmation(null)} onConfirm={() => { void confirmMaintenance(); }}/>
      {requestError && <p role="alert" className="capability-operation-status">{t.agentCapabilityRequestFailed}</p>}
      <div className="agent-capabilities-toolbar">
        <Button type="button" variant="ghost" size="sm" className="agent-capabilities-back"
          data-agent-capabilities-back onClick={back}>
          <ArrowLeft size={17} aria-hidden="true"/>{selected ? t.agentCapabilityBack : t.agentWorkspaceBack}
        </Button>
        <div className="agent-capabilities-actions">
          {preview && <span className="agent-capabilities-preview">{t.remoteUiPreview}</span>}
          {selected ? actions(selected, false, currentDetail?.value?.configuration.type) : <div className="agent-capabilities-add-wrap">
            <Button type="button" variant="ghost" size="icon" className="agent-capabilities-add"
              aria-label={t.agentCapabilitiesAdd} title={t.agentCapabilitiesAdd}
              onClick={onOpenMarketplace}>
              <Plus size={19} aria-hidden="true"/>
            </Button>
          </div>}
        </div>
      </div>
      {!selected && operations.filter(value => !inventory.items.some(item => item.id === value.id)).map(value =>
        <p className="capability-operation-status" role="status" key={value.id}>{value.name} · {maintenanceText(value)}</p>)}
      {selected && operationText(selected) && <p className="capability-operation-status" role="status">{operationText(selected)}</p>}

      {selected ? currentDetail?.state === "available" && currentDetail.value ? <CapabilityDetailView key={selected.id} t={t} detail={currentDetail.value} alerts={alerts.filter(alert => alert.id === selected.id)} reconnectAvailable={!!reconnect && !!selected.revision} maintenanceAvailable={!!maintenance && !!selected.revision}/>
        : <p className="agent-capabilities-state" role="status">{currentDetail?.state === "unavailable" ? t.agentCapabilityDetailsUnavailable : t.agentCapabilityDetailsLoading}</p>
        : <>{inventory.state === "loading" ? (
        <p className="agent-capabilities-state" role="status">{t.agentCapabilitiesLoading}</p>
      ) : inventory.state === "unavailable" ? (
        <p className="agent-capabilities-state" role="status">{t.agentCapabilitiesUnavailable}</p>
      ) : inventory.state === "partial" && inventory.items.length === 0 ? (
        <p className="agent-capabilities-state" role="status">{t.agentCapabilitiesPartial}</p>
      ) : inventory.items.length === 0 ? (
        <p className="agent-capabilities-state" role="status">{t.agentCapabilitiesEmpty}</p>
      ) : (
        <ul className="agent-capabilities-list" aria-label={t.agentCapabilitiesPage}>
          {inventory.items.map(item => {
            const Icon = capabilityIcons[item.kind];
            const itemAlerts = alerts.filter(alert => alert.id === item.id);
            return (
              <li key={item.id} className="cap-list-row" data-kind={item.kind}
                data-has-update={!!maintenance && item.kind === "npm" && !!itemAlerts.find(alert => alert.reason === "npm_update_available")?.version}>
                <button type="button" className="agent-capabilities-item" data-capability-kind={item.kind}
                  data-capability-id={item.id} aria-label={[item.name, capabilityLabels[item.kind], ...itemAlerts.map(alert => capabilityAlertText(t, item.kind, alert))].join(", ")} onClick={() => { void select(item); }}>
                  <span className="agent-capabilities-icon"><Icon size={19} strokeWidth={1.7} aria-hidden="true"/></span>
                  <span className="agent-capabilities-copy">
                    <span className="agent-capabilities-name">{item.name}</span>
                    {item.description && <span className="agent-capabilities-description">{item.description}</span>}
                    {itemAlerts.map(alert => <span className="capability-alert-inline" data-level={alert.level} key={`${alert.reason}:${alert.version ?? ""}`}>{capabilityAlertText(t, item.kind, alert)}</span>)}
                    {operationText(item) && <span className="capability-operation-status" role="status">{operationText(item)}</span>}
                  </span>
                  <span className="agent-capabilities-type">{capabilityLabels[item.kind]}</span>
                  <ChevronRight className="agent-capabilities-chevron" size={15} strokeWidth={1.7} aria-hidden="true"/>
                </button>
                {actions(item, true)}
              </li>
            );
          })}
        </ul>
      )}
      {inventory.state === "partial" && inventory.items.length > 0 && <p className="agent-capabilities-state" role="status">{t.agentCapabilitiesPartial}</p>}</>}
    </section>
  );
}
