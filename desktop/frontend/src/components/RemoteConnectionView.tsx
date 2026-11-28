import { useEffect, useRef } from "react";
import { AlertCircle, ChevronDown, Server, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "./ui/button";
import { ProgressBar } from "./ui/progress";
import { remoteConnectionStages, remoteEndpoint, type RemoteConnectionStage, type RemoteDraft } from "../remote-draft";
import type { MessageKey, Messages } from "../i18n";
import { connectionErrorKey, type EnvironmentAttempt } from "../environment-runtime";

const stageLabels = {
  connecting: "remoteConnecting",
  verify: "remoteVerifyHost",
  authenticating: "remoteAuthenticating",
  failed: "remoteConnectFailed",
  authFailed: "remoteAuthFailed",
  hostChanged: "remoteHostChanged",
} satisfies Record<RemoteConnectionStage, MessageKey>;

// Fixed presentation fixture, not a fingerprint obtained from any remote host.
const sampleFingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function RemoteConnectionView({ t, draft, stage, onStage, onBack, preview = true, attempt, onTrust }: {
  t: Messages;
  draft: RemoteDraft;
  stage: RemoteConnectionStage;
  onStage?: (stage: RemoteConnectionStage) => void;
  preview?: boolean;
  attempt?: EnvironmentAttempt;
  onTrust?: () => void;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const busy = stage === "connecting" || stage === "authenticating";
  const verify = stage === "verify";
  const changed = stage === "hostChanged";
  const error = !busy && !verify;
  const Icon = busy ? Server : verify ? ShieldCheck : changed ? ShieldAlert : AlertCircle;
  const title = t[stageLabels[stage]];
  const issue = changed ? [t.remoteHostChangedDetail, t.remoteHostChangedAdvice] :
    stage === "authFailed" ? [preview ? t.remoteAuthFailureDetail : t[connectionErrorKey(attempt?.errorCode ?? "auth_failed")], t.remoteAuthFailureAdvice] :
      [preview ? t.remoteTimeout : t[connectionErrorKey(attempt?.errorCode ?? "")], t.remoteTimeoutAdvice];
  return (
    <div className="ssh-status-page" data-ssh-stage={stage}>
      {preview && <div className="ssh-preview-toolbar">
        <span>{t.remoteUiPreview}</span>
        <label className="ssh-preview-stage">
          <select aria-label={t.remotePreviewStage} value={stage} onChange={event => {
            const next = remoteConnectionStages.find(item => item === event.target.value);
            if (next) onStage?.(next);
          }}>
            {remoteConnectionStages.map(item => <option key={item} value={item}>{t[stageLabels[item]]}</option>)}
          </select><ChevronDown size={12} aria-hidden="true"/>
        </label>
      </div>}
      <div className="ssh-status-identity">
        <div className={`ssh-status-icon${error ? " ssh-status-icon-error" : ""}`}><Icon size={29} strokeWidth={1.65} aria-hidden="true"/></div>
        <h1 ref={heading} tabIndex={-1}>{title}</h1>
        <p className="ssh-target-name">{draft.host}</p>
        <p className="ssh-target-endpoint">{remoteEndpoint(draft)}</p>
      </div>
      {busy ? (
        <div className="ssh-loading" role="status">
          <div className="ssh-progress"><ProgressBar value={null} label={title}/></div>
          <p>{stage === "authenticating" ? t.remoteAuthenticatingDetail : t.remoteConnectingDetail}</p>
        </div>
      ) : verify ? (
        <section className="ssh-verify" aria-label={t.remoteVerifyHost}>
          <p>{t.remoteFingerprintNotice}</p>
          <div className="ssh-fingerprint-card">
            <p>{preview ? t.remoteFingerprintType : attempt?.keyType + " · SHA-256"}</p>
            <code>{preview ? sampleFingerprint : attempt?.fingerprint}</code>
            {preview && <p>{t.remoteFingerprintSample}</p>}
          </div>
          <p className="ssh-fingerprint-advice">{t.remoteFingerprintAdvice}</p>
        </section>
      ) : (
        <section className="ssh-error-card" role="alert">
          <h2>{issue[0]}</h2>
          <p>{issue[1]}</p>
          {changed && !preview && attempt?.fingerprint && <code className="ssh-actual-fingerprint">{attempt.fingerprint}</code>}
        </section>
      )}
      <footer className="ssh-status-footer">
        {busy ? (
          <Button type="button" variant="ghost" className="remote-cancel-button" onClick={onBack}>{t.remoteCancelConnection}</Button>
        ) : verify ? (
          <>
            <Button type="button" className="remote-connect-button" onClick={() => preview ? onStage?.("authenticating") : onTrust?.()}>{t.remoteTrustConnect}</Button>
            <Button type="button" variant="ghost" className="remote-cancel-button" onClick={onBack}>{t.remoteCancel}</Button>
          </>
        ) : stage === "failed" && preview ? (
          <>
            <Button type="button" className="remote-connect-button" onClick={() => onStage?.("connecting")}>{t.remoteReconnect}</Button>
            <Button type="button" variant="ghost" className="remote-cancel-button" onClick={onBack}>{t.remoteEditConfig}</Button>
          </>
        ) : (
          <Button type="button" className="remote-connect-button" onClick={onBack}>{t.remoteEditConfig}</Button>
        )}
      </footer>
    </div>
  );
}
