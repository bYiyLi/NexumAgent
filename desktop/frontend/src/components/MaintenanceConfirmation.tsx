import { useRef } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "./ui/button";

export function MaintenanceConfirmation({ open, title, target, description, cancelLabel, confirmLabel, destructive = true, disabled = false, onClose, onConfirm }: {
  open: boolean; title: string; target: string; description: string; cancelLabel: string; confirmLabel: string;
  destructive?: boolean; disabled?: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <AlertDialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="agent-material-confirm-backdrop"/>
      <AlertDialog.Popup className="agent-material-confirm" initialFocus={cancel}>
        <AlertDialog.Title className="agent-material-confirm-title">{title}</AlertDialog.Title>
        <p className="agent-material-confirm-location">{target}</p>
        <AlertDialog.Description className="agent-material-confirm-description">{description}</AlertDialog.Description>
        <div className="agent-material-confirm-actions">
          <AlertDialog.Close render={<Button ref={cancel} type="button" variant="secondary" size="sm"/>}>{cancelLabel}</AlertDialog.Close>
          <Button type="button" size="sm" disabled={disabled} className={destructive ? "agent-material-confirm-delete" : undefined} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
