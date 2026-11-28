import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ChevronDown, Eye, EyeOff, FileKey, KeyRound, LockKeyhole } from "lucide-react";
import { Button } from "./ui/button";
import { remotePreviewDraft, validateRemoteDraft, type RemoteDraft } from "../remote-draft";
import type { MessageKey, Messages } from "../i18n";
import type { RemoteSecrets, SSHKeySelection } from "../environment-runtime";

type Issue = { field: keyof RemoteDraft | "password" | "key"; message: MessageKey };

export function AddRemoteView({ t, initialDraft = remotePreviewDraft(), onConnect, onCancel, preview = true, fixedEndpoint = false, disabled = false, onChooseKey, onClearKey }: {
  t: Messages;
  initialDraft?: RemoteDraft;
  onConnect: (draft: RemoteDraft, secrets?: RemoteSecrets) => void;
  preview?: boolean;
  fixedEndpoint?: boolean;
  disabled?: boolean;
  onChooseKey?: () => Promise<SSHKeySelection>;
  onClearKey?: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  // Secrets stay in this mounted form and the one native binding call.
  // Never include them in the navigation state, preview, or persisted UI state.
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [keySelected, setKeySelected] = useState(false);
  const [keySelection, setKeySelection] = useState<SSHKeySelection | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const choiceEpoch = useRef({ generation: 0 });
  const [issue, setIssue] = useState<Issue | null>(null);
  const AuthIcon = draft.auth === "password" ? LockKeyhole : draft.auth === "key" ? FileKey : KeyRound;
  const heading = useRef<HTMLHeadingElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const keyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    const lifecycle = choiceEpoch.current;
    return () => { ++lifecycle.generation; };
  }, []);

  function change<K extends keyof RemoteDraft>(key: K, value: RemoteDraft[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setIssue(null);
    if (key === "auth") {
      setPassword("");
      setVisible(false);
      setKeySelected(false);
      setKeySelection(null);
      setPassphrase("");
      setRemember(false);
      ++choiceEpoch.current.generation;
      onClearKey?.();
    }
  }

  async function chooseKey() {
    if (preview) { setKeySelected(true); setIssue(null); return; }
    if (!onChooseKey || choosing || disabled) return;
    const generation = ++choiceEpoch.current.generation;
    setChoosing(true);
    try {
      const selected = await onChooseKey();
      if (generation !== choiceEpoch.current.generation) return;
      setKeySelection(selected.token ? selected : null);
      setKeySelected(Boolean(selected.token));
      setIssue(null);
    } catch {
      if (generation === choiceEpoch.current.generation) setIssue({ field: "key", message: "remoteRealKeyFailure" });
    } finally { setChoosing(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = validateRemoteDraft(draft);
    if (invalid) {
      setIssue(invalid);
      const field = event.currentTarget.elements.namedItem(invalid.field);
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    if (choosing || disabled) return;
    if (draft.auth === "key" && !keySelected) {
      setIssue({ field: "key", message: preview ? "remoteKeyRequired" : "remoteRealKeyRequired" });
      keyButton.current?.focus();
      return;
    }
    if (draft.auth === "password" && !password) {
      setIssue({ field: "password", message: preview ? "remotePasswordRequired" : "remoteRealPasswordRequired" });
      passwordField.current?.focus();
      return;
    }
    const secrets = preview ? undefined : { password, keyToken: keySelection?.token ?? "", passphrase, remember };
    setPassword("");
    setPassphrase("");
    setVisible(false);
    setKeySelected(false);
    setKeySelection(null);
    setRemember(false);
    onConnect({ ...draft }, secrets);
  }

  function inputAttributes(field: Issue["field"]) {
    return {
      "aria-invalid": issue?.field === field || undefined,
      "aria-describedby": issue?.field === field ? "remote-form-feedback" : undefined,
    };
  }

  return (
    <form className="remote-page" noValidate autoComplete="off" onSubmit={submit}>
      <div className="remote-heading">
        <h1 ref={heading} tabIndex={-1} className="remote-title">{t.addRemoteEnvironment}</h1>
        <div className="remote-heading-row">
          <p className="remote-description">{t.remoteDescription}</p>
          {preview && <span className="remote-preview-label">{t.remoteUiPreview}</span>}
        </div>
      </div>
      <div className="remote-fields">
        <div className="remote-field-row">
          <label className="remote-field">
            <span>{t.remoteHost}</span>
            <input className="remote-input" name="host" required disabled={fixedEndpoint} maxLength={253} spellCheck={false} autoCapitalize="none"
              value={draft.host} onChange={event => change("host", event.target.value)} {...inputAttributes("host")}/>
          </label>
          <label className="remote-field">
            <span>{t.remotePort}</span>
            <input className="remote-input remote-port" name="port" required disabled={fixedEndpoint} inputMode="numeric" maxLength={5}
              value={draft.port} onChange={event => change("port", event.target.value)} {...inputAttributes("port")}/>
          </label>
        </div>
        <label className="remote-field">
          <span>{t.remoteUsername}</span>
          <input className="remote-input" name="user" required disabled={fixedEndpoint} maxLength={128} spellCheck={false} autoCapitalize="none"
            value={draft.user} onChange={event => change("user", event.target.value)} {...inputAttributes("user")}/>
        </label>
        <div className="remote-auth-group">
          <label className="remote-field">
            <span>{t.remoteAuth}</span>
            <span className="remote-select-wrap remote-auth-select">
              <AuthIcon size={16} strokeWidth={1.6} className="remote-auth-icon" aria-hidden="true"/>
              <select className="remote-input remote-select" name="auth" required value={draft.auth}
                onChange={event => { const value = event.target.value; if (value === "agent" || value === "key" || value === "password") change("auth", value); }}
                {...inputAttributes("auth")}>
                <option value="password">{t.remoteAuthPassword}</option>
                <option value="agent">{t.remoteAuthAgent}</option>
                <option value="key">{t.remoteAuthKey}</option>
              </select>
              <ChevronDown size={15} strokeWidth={1.7} className="remote-select-chevron" aria-hidden="true"/>
            </span>
          </label>
          {draft.auth === "agent" && <p className="remote-auth-hint">{t.remoteAgentHint}</p>}
          {draft.auth === "key" && (
            <div className="remote-key-field">
              <div className="remote-key-name"><FileKey size={15} aria-hidden="true"/><span>{keySelected ? preview ? "example_ed25519" : keySelection?.name : preview ? t.remoteKeyEmpty : t.remoteRealKeyEmpty}</span></div>
              <Button ref={keyButton} type="button" variant="link" className="remote-key-button" disabled={choosing || disabled} onClick={() => { void chooseKey(); }}
                {...inputAttributes("key")}>{keySelected ? t.remoteChooseAgain : preview ? t.remoteChooseSampleKey : t.remoteRealChooseKey}</Button>
            </div>
          )}
          {!preview && draft.auth === "key" && keySelected && (
            <label className="remote-field">
              <span>{t.remoteKeyPassphrase}</span>
              <input className="remote-input" type="password" autoComplete="new-password" value={passphrase}
                maxLength={256} onChange={event => setPassphrase(event.target.value)}/>
            </label>
          )}
          {draft.auth === "password" && (
            <label className="remote-field remote-password-field">
              <span>{t.remotePassword}</span>
              <span className="remote-password-wrap">
                <input ref={passwordField} className="remote-input" type={visible ? "text" : "password"} name="password" required autoComplete="new-password"
                  spellCheck={false} placeholder={preview ? t.remotePasswordPlaceholder : t.remoteRealPasswordRequired} maxLength={256} value={password}
                  onChange={event => { setPassword(event.target.value); setIssue(null); }} {...inputAttributes("password")}/>
                <button type="button" className="remote-password-toggle" aria-label={visible ? t.remoteHidePassword : t.remoteShowPassword}
                  aria-pressed={visible} onClick={() => setVisible(value => !value)}>
                  {visible ? <EyeOff size={17} aria-hidden="true"/> : <Eye size={17} aria-hidden="true"/>}
                </button>
              </span>
            </label>
          )}
          {!preview && draft.auth !== "agent" && (
            <label className="remote-remember"><input type="checkbox" checked={remember}
              onChange={event => setRemember(event.target.checked)}/>{t.remoteRememberCredential}</label>
          )}
        </div>
      </div>
      <footer className="remote-footer">
        <div className="remote-notes">
          <LockKeyhole size={15} strokeWidth={1.65} aria-hidden="true"/>
          <p id="remote-form-feedback" role="status" className={issue ? "remote-validation-error" : undefined}>
            {issue ? t[issue.message] : t.remoteTrustNotice}
          </p>
        </div>
        <Button type="submit" disabled={choosing || disabled} className="remote-connect-button"><span>{t.remoteConnectAdd}</span><ArrowRight size={16} aria-hidden="true"/></Button>
        <Button type="button" variant="ghost" className="remote-cancel-button" onClick={onCancel}>{t.remoteCancel}</Button>
      </footer>
    </form>
  );
}
