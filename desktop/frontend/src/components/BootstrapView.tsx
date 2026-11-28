import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { ProgressBar, progressPercent } from "./ui/progress";
import { bootstrapPreviewStages, bootstrapPreviewStage, bootstrapRetryPreview, type BootstrapState, type BootstrapPreview } from "../desktop-page";
import type { MessageKey, Messages } from "../i18n";

const previewLabels = {
  startup: "previewStateInitializing",
  storage: "bootstrapStorageLabel",
  configuration: "bootstrapConfigurationLabel",
  services: "bootstrapServicesLabel",
  checking: "previewStateChecking",
  downloading: "previewStateDownloading",
  verifying: "previewStateVerifying",
  installing: "previewStateInstalling",
  restarting: "previewStateRestarting",
  backup: "bootstrapBackupLabel",
  migration: "bootstrapMigrationLabel",
  dataVerifying: "bootstrapDataVerifyingLabel",
  recovery: "bootstrapRecoveryLabel",
  initializationFailed: "bootstrapInitializationFailedLabel",
  failed: "previewStateFailed",
  verificationFailed: "bootstrapVerificationFailedLabel",
  migrationFailed: "bootstrapMigrationFailedLabel",
  incompatible: "bootstrapIncompatibleLabel",
  permissionFailed: "bootstrapPermissionLabel",
} satisfies Record<BootstrapPreview, MessageKey>;

type VisibleState = Exclude<BootstrapState, { phase: "ready" }>;

type Props = {
  t: Messages;
  state: VisibleState;
  preview: boolean;
  onRetry: () => void;
  onExit: () => void;
  onEndPreview: () => void;
  onPreviewPhase?: (phase: BootstrapPreview) => void;
  onViewLogs?: () => void;
  onManualInstall?: () => void;
  retryAvailable?: boolean;
  canQuit?: boolean;
};

function copyForState(state: VisibleState, t: Messages): {title: string; detail: string; failed?: boolean; retryLabel?: string} {
  if (state.phase === "update") {
    const update = state.update;
    switch (update.phase) {
      case "failed": return {title: t.updateFailed, detail: update.message, failed: true, retryLabel: t.retryUpdate};
      case "verificationFailed": return {title: t.bootstrapVerificationFailed, detail: update.message, failed: true, retryLabel: t.bootstrapRecheck};
      case "permissionFailed": return {title: t.bootstrapPermissionFailed, detail: update.message, failed: true};
      case "downloading": return {title: t.downloading, detail: t.updateRequired};
      case "verifying": return {title: t.verifying, detail: t.bootstrapVerifyingDetail};
      case "installing": return {title: t.installing, detail: t.bootstrapInstallingDetail};
      case "restarting": return {title: t.restarting, detail: t.bootstrapRestartingDetail};
    }
  }
  switch (state.phase) {
    case "initializing": return {title: t.initializing, detail: t.initializingDetail};
    case "storage": return {title: t.initializing, detail: t.bootstrapStorageDetail};
    case "configuration": return {title: t.initializing, detail: t.bootstrapConfigurationDetail};
    case "services": return {title: t.initializing, detail: t.bootstrapServicesDetail};
    case "checking": return {title: t.checking, detail: t.checkingDetail};
    case "backup": return {title: t.bootstrapBackup, detail: t.bootstrapBackupDetail};
    case "migration": return {title: t.bootstrapMigration, detail: t.bootstrapMigrationDetail};
    case "dataVerifying": return {title: t.bootstrapDataVerifying, detail: t.bootstrapDataVerifyingDetail};
    case "recovery": return {title: t.bootstrapRecovery, detail: t.bootstrapRecoveryDetail};
    case "initializationFailed": return {title: t.startupFailed, detail: t.startupFailedDetail, failed: true, retryLabel: t.retry};
    case "migrationFailed": return {title: t.bootstrapMigrationFailed, detail: t.bootstrapMigrationFailedDetail, failed: true,
      retryLabel: state.retryable ? t.bootstrapSafeRetry : undefined};
    case "incompatible": return {title: t.bootstrapIncompatible, detail: t.bootstrapIncompatibleDetail, failed: true, retryLabel: t.bootstrapCheckUpdates};
  }
}

function FailureActions({ t, state, preview, retryLabel, onRetry, onViewLogs, onManualInstall, onManualPreview }: {
  t: Messages; state: VisibleState; preview: boolean; retryLabel?: string;
  onRetry: () => void; onViewLogs?: () => void; onManualInstall?: () => void; onManualPreview: () => void;
}) {
  const permissionFailure = state.phase === "update" && state.update.phase === "permissionFailed";
  const manualAvailable = preview ? permissionFailure : onManualInstall !== undefined;
  // A preview must never install or launch a downloaded package.
  const manualAction = () => { if (preview) onManualPreview(); else onManualInstall?.(); };
  return (
    <div className="startup-actions">
      {retryLabel && (!preview || bootstrapRetryPreview(state) !== null) &&
        <Button type="button" className="startup-primary-action" onClick={onRetry}>{retryLabel}</Button>}
      {manualAvailable && <Button type="button" className="startup-primary-action" onClick={manualAction}>{t.bootstrapManualInstall}</Button>}
      {onViewLogs && <Button type="button" variant="link" size="sm" className="startup-log-action" onClick={onViewLogs}>{t.bootstrapViewLogs}</Button>}
    </div>
  );
}

// All bootstrap phases share the same canvas, wordmark and stable progress slot.
// Real callers supply real snapshots/actions; only the dev entry exposes samples.
export function BootstrapView({ t, state, preview, onRetry, onExit, onEndPreview, onPreviewPhase, onViewLogs, onManualInstall, retryAvailable = true, canQuit = true }: Props) {
  const [manualPreview, setManualPreview] = useState(false);
  const update = state.phase === "update" ? state.update : null;
  const { title, detail, failed = false, retryLabel } = copyForState(state, t);
  const percent = update?.phase === "downloading" ? progressPercent(update.progress) : null;
  const showExit = canQuit && (failed || update?.phase === "downloading" || update?.phase === "verifying");
  const previewStage = bootstrapPreviewStage(state);
  const dataFlow = ["backup", "migration", "dataVerifying", "recovery", "migrationFailed", "incompatible"].some(phase => phase === state.phase);

  return (
    <div className="startup-page" data-bootstrap-stage={previewStage}>
      <div className="startup-content">
        <div className="startup-wordmark">Nexum</div>
        <div className="startup-progress">
          {failed ? <CircleAlert className="startup-error-mark" size={22} strokeWidth={1.6} aria-hidden="true"/> :
            <ProgressBar value={percent} label={title}/>}
          {!failed && percent !== null && <span className="startup-progress-percent">{percent}%</span>}
        </div>
        <div className="startup-status" role={failed ? "alert" : "status"}>
          <h1>{title}</h1>
          <p>{detail}</p>
          {update?.targetVersion && (
            <p className="startup-update-version" aria-label={`${t.currentVersion} ${update.currentVersion}, ${t.targetVersion} ${update.targetVersion}`}>
              {update.currentVersion} → {update.targetVersion}
            </p>
          )}
        </div>
        {failed && <FailureActions key={previewStage} t={t} state={state} preview={preview} retryLabel={retryAvailable ? retryLabel : undefined}
          onRetry={onRetry} onViewLogs={onViewLogs} onManualInstall={onManualInstall} onManualPreview={() => setManualPreview(true)}/>}
      </div>
      <footer className={`startup-footer${preview && (update || showExit) ? " startup-footer-detailed" : ""}`}>
        {(update || showExit) && (
          <div className="startup-preview">
            {update && !failed && <p>{t.noAgentImpact}</p>}
            {showExit && <Button type="button" variant="link" size="sm" onClick={onExit}>{t.exit}</Button>}
          </div>
        )}
        {preview && (
          <div className="startup-preview">
            <p role={manualPreview && previewStage === "permissionFailed" ? "status" : undefined}>{manualPreview && previewStage === "permissionFailed" ? t.bootstrapManualPreview : dataFlow ? t.bootstrapDataPreview : update || state.phase === "checking" ? t.previewNote : t.previewStartupNote}</p>
            {onPreviewPhase ? (
              <div className="startup-preview-actions">
                <Menu.Root modal={false}>
                  <Menu.Trigger className="settings-language-trigger" aria-label={t.previewPhase}>
                    <span>{t[previewLabels[previewStage]]}</span><ChevronDown size={12} aria-hidden="true"/>
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Positioner className="shell-menu-positioner" side="top" align="center" sideOffset={6}>
                      <Menu.Popup className="shell-menu bootstrap-preview-menu">
                        <Menu.RadioGroup value={previewStage} onValueChange={value => {
                          const phase = bootstrapPreviewStages.find(item => item === value);
                          if (phase) { setManualPreview(false); onPreviewPhase(phase); }
                        }}>
                          {bootstrapPreviewStages.map(phase => <Menu.RadioItem key={phase} value={phase} closeOnClick className="shell-menu-item">
                            <span className="menu-item-text">{t[previewLabels[phase]]}</span>
                            <Menu.RadioItemIndicator><Check size={14} aria-hidden="true"/></Menu.RadioItemIndicator>
                          </Menu.RadioItem>)}
                        </Menu.RadioGroup>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
                <Button type="button" variant="link" size="sm" onClick={onEndPreview}>{t.endPreview}</Button>
              </div>
            ) : (
              <Button type="button" variant="link" size="sm" onClick={onEndPreview}>{t.endPreview}</Button>
            )}
          </div>
        )}
        <span className="startup-product-label">DESKTOP</span>
      </footer>
    </div>
  );
}
