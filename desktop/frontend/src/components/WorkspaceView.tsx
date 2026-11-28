import { useState } from "react";
import { Button } from "./ui/button";
import { MaintenanceConfirmation } from "./MaintenanceConfirmation";
import type { AgentTarget } from "../agent-targets";
import type { Messages } from "../i18n";

// Environment connectivity and Agent connectivity are distinct.
export function WorkspaceView({ current, t, onReconnect, onDisconnect, onRemove, disabled = false }: {
  current: AgentTarget; t: Messages; disabled?: boolean; onReconnect?: () => void; onDisconnect?: () => void; onRemove?: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  return (
    <div className="desktop-page">
      <h1 className="desktop-page-title">{t.overview}</h1>
      <p className="desktop-page-description">{t.workspaceDescription}</p>
      <section className="desktop-panel workspace-target" aria-label={t.target}>
        <div className="workspace-target-name">{current.name}</div>
        <p className="workspace-target-detail">{current.description}</p>
        {current.kind === "ssh" && <div className="workspace-target-status"><span className="workspace-status-dot" data-connected={current.connected === true}/>{current.connected ? t.sshConnected : t.sshDisconnected}</div>}
        <div className="workspace-target-status"><span className="workspace-status-dot"/>{t.targetUnconnected}</div>
        <p className="workspace-target-detail">{t.targetHint}</p>
        {current.kind === "ssh" && <div className="environment-actions">
          {current.connected ? <Button variant="outline" disabled={disabled} onClick={onDisconnect}>{t.remoteDisconnect}</Button> :
            <Button disabled={disabled} onClick={onReconnect}>{t.remoteReconnect}</Button>}
          <Button variant="ghost" disabled={disabled || !onRemove} onClick={() => setConfirmRemove(current.id)}>{t.remoteRemove}</Button>
        </div>}
        <MaintenanceConfirmation open={confirmRemove === current.id && current.kind === "ssh"} title={t.remoteConfirmRemove} target={current.name} description={t.remoteRemoveNotice} cancelLabel={t.remoteCancel} confirmLabel={t.remoteRemove} disabled={disabled || !onRemove} onClose={() => setConfirmRemove(null)} onConfirm={() => { if (!disabled && confirmRemove === current.id) { setConfirmRemove(null); onRemove?.(); } }}/>
      </section>
    </div>
  );
}
