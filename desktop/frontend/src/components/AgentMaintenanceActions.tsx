import { useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { CircleStop, KeyRound, Package, RotateCw, Trash2 } from "lucide-react";
import type { MessageKey, Messages } from "../i18n";
import { Button } from "./ui/button";

export type AgentMaintenanceAction = "restart" | "stop" | "reinstall" | "reset" | "uninstall";

const actions: readonly {
  key: AgentMaintenanceAction;
  label: MessageKey;
  title: MessageKey;
  detail: MessageKey;
  icon: typeof RotateCw;
}[] = [
  { key: "restart", label: "agentActionRestart", title: "agentActionRestartTitle", detail: "agentActionRestartDetail", icon: RotateCw },
  { key: "stop", label: "agentActionStop", title: "agentActionStopTitle", detail: "agentActionStopDetail", icon: CircleStop },
  { key: "reinstall", label: "agentActionReinstall", title: "agentActionReinstallTitle", detail: "agentActionReinstallDetail", icon: Package },
  { key: "reset", label: "agentActionReset", title: "agentActionResetTitle", detail: "agentActionResetDetail", icon: KeyRound },
  { key: "uninstall", label: "agentActionUninstall", title: "agentActionUninstallTitle", detail: "agentActionUninstallDetail", icon: Trash2 },
];

export function AgentMaintenanceActions({ t, name, profile, cloud, onAction, notice }: {
  t: Messages;
  name: string;
  profile?: string;
  cloud: "online" | "offline" | "unknown";
  onAction?: (action: AgentMaintenanceAction) => void;
  notice?: string;
}) {
  const [selected, setSelected] = useState<AgentMaintenanceAction | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = actions.find(action => action.key === selected);
  return <>
    {notice && <p className="agent-maintenance-notice" role="status">{notice}</p>}
    <div className="agent-maintenance-actions" role="group" aria-label={t.agentWorkspaceNavigation}>
      {actions.map(({ key, title, label, icon: Icon }) =>
        <button type="button" key={key} data-agent-action={key} aria-label={t[title]}
          title={!onAction ? t.agentActionUnavailable : key === "restart" && cloud !== "online" ? t.agentActionCloudRequired : undefined}
          disabled={!onAction || key === "restart" && cloud !== "online"} onClick={event => { trigger.current = event.currentTarget; setSelected(key); }}>
          <Icon size={16} aria-hidden="true"/><span>{t[label]}</span>
        </button>)}
    </div>
    <AlertDialog.Root open={Boolean(item)} onOpenChange={open => { if (!open) setSelected(null); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="agent-material-confirm-backdrop"/>
        <AlertDialog.Popup className="agent-material-confirm" initialFocus={cancel} finalFocus={trigger}>
          {item && <>
            <AlertDialog.Title className="agent-material-confirm-title">{t[item.title]}</AlertDialog.Title>
            <p className="agent-material-confirm-location">{name} · {profile ?? t.agentAdminProfileUnknown}</p>
            <AlertDialog.Description className="agent-material-confirm-description">{t[item.detail]}</AlertDialog.Description>
            <div className="agent-material-confirm-actions">
              <AlertDialog.Close render={<Button ref={cancel} type="button" variant="secondary" size="sm"/>}>{t.remoteCancel}</AlertDialog.Close>
              <Button type="button" size="sm" className={item.key === "uninstall" ? "agent-material-confirm-delete" : undefined}
                onClick={() => { setSelected(null); onAction?.(item.key); }}>{t[item.title]}</Button>
            </div>
          </>}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </>;
}
