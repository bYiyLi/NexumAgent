import { Check, ChevronDown, ChevronRight, Laptop, Minus, Monitor, Plus, Server, Settings, X } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import type { Ref } from "react";
import type { AgentTarget } from "../agent-targets";
import { hasWorkspaceControls, type DesktopPage } from "../desktop-page";
import type { Messages } from "../i18n";

type Props = {
  page: DesktopPage;
  isMac: boolean;
  t: Messages;
  current: AgentTarget;
  targets: AgentTarget[];
  onSelect: (id: string) => void;
  onAddRemote?: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  onSettings: () => void;
  locked?: boolean;
  onWindowAction: (action: "minimise" | "hide") => void;
};

export function DesktopTitleBar({ page, isMac, t, current, targets, onSelect, onAddRemote, triggerRef, onSettings, onWindowAction, locked = false }: Props) {
  const ready = hasWorkspaceControls(page);
  const mark = <img src="/nexum-mark.svg" className="desktop-brand-mark" alt="" aria-hidden="true"/>;
  const local = targets.filter(target => target.kind === "local");
  const remote = targets.filter(target => target.kind !== "local");

  function renderTarget(target: AgentTarget) {
    const isRemote = target.kind !== "local";
    const connectionLabel = target.connected ? t.sshConnected : t.sshDisconnected;
    const Icon = isRemote ? Server : isMac ? Laptop : Monitor;
    const detail = isRemote ? target.endpoint ?? target.description : `${target.description} · Local`;
    return (
      <Menu.RadioItem key={target.id} value={target.id} label={target.name} closeOnClick
        className={`shell-menu-item agent-menu-item${isRemote ? " agent-menu-remote" : ""}`} title={target.name}>
        <Icon size={20} strokeWidth={1.6} aria-hidden="true" className="menu-agent-icon"/>
        <span className="menu-item-text">
          <span className="menu-agent-name">{target.name}</span>
          <span className="menu-agent-description" title={detail}>{detail}</span>
        </span>
        {isRemote && (
          <span className="agent-menu-connection" aria-label={`SSH: ${connectionLabel}`}>
            <span className="agent-menu-connection-dot" data-connected={target.connected === true} aria-hidden="true"/>
            {connectionLabel}
          </span>
        )}
        <Menu.RadioItemIndicator className="agent-menu-check"><Check size={15} strokeWidth={1.8} aria-hidden="true"/></Menu.RadioItemIndicator>
      </Menu.RadioItem>
    );
  }

  return (
    <header className="desktop-titlebar">
      {ready && (
        <div className="titlebar-settings">
          <button type="button" className="settings-trigger" aria-label={t.settings} title={t.settings}
            aria-pressed={page === "settings"} disabled={locked} onClick={onSettings}>
            <Settings size={18} strokeWidth={1.75} aria-hidden="true"/>
          </button>
        </div>
      )}
      <div className="titlebar-center">
        {ready ? (
          <Menu.Root modal={false}>
            <Menu.Trigger ref={triggerRef} disabled={locked} className="agent-trigger" aria-label={`${t.switchAgent}: ${current.name}`}
              title={current.kind === "preview" ? `${current.name} · ${t.envSample}` : current.name}>
              {mark}
              <span className="agent-name">{current.name}</span>
              <ChevronDown className="agent-chevron" size={13} strokeWidth={1.8} aria-hidden="true"/>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className="shell-menu-positioner" side="bottom" align="center" sideOffset={8}>
                <Menu.Popup className="shell-menu agent-menu">
                  <Menu.RadioGroup value={current.id} onValueChange={value => {
                    if (typeof value === "string" && targets.some(target => target.id === value)) onSelect(value);
                  }}>
                    <Menu.Group>
                      <Menu.GroupLabel className="agent-menu-heading">{t.localEnvironment}</Menu.GroupLabel>
                      {local.map(renderTarget)}
                    </Menu.Group>
                    {remote.length > 0 && (
                      <Menu.Group>
                        <Menu.GroupLabel className="agent-menu-heading">{remote.some(target => target.kind === "ssh") ? t.remoteEnvironments : t.remoteEnvironmentsPreview}</Menu.GroupLabel>
                        {remote.map(renderTarget)}
                      </Menu.Group>
                    )}
                  </Menu.RadioGroup>
                  {onAddRemote && (
                    <>
                      <Menu.Separator className="agent-menu-separator"/>
                      <Menu.Item className="shell-menu-item agent-menu-add" onClick={onAddRemote}>
                        <Plus size={18} strokeWidth={1.8} aria-hidden="true"/>
                        <span>{t.addRemoteEnvironment}</span>
                        <ChevronRight size={14} strokeWidth={1.7} aria-hidden="true" className="agent-menu-add-chevron"/>
                      </Menu.Item>
                    </>
                  )}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : null}
      </div>
      {!isMac && <div className="titlebar-actions">
        <button type="button" className="window-action" aria-label={t.minimise} title={t.minimise} onClick={() => onWindowAction("minimise")}>
          <Minus size={15} strokeWidth={1.7} aria-hidden="true"/>
        </button>
        <button type="button" className="window-action window-hide" aria-label={t.hide} title={t.hide} onClick={() => onWindowAction("hide")}>
          <X size={15} strokeWidth={1.7} aria-hidden="true"/>
        </button>
      </div>}
    </header>
  );
}
