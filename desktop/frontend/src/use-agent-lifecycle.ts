import { useEffect, useRef, useState } from "react";
import { FoundationService } from "../bindings/github.com/bYiyLi/NexumAgent/desktop";
import { parseLifecycleSnapshot, type LifecycleSnapshot } from "./agent-lifecycle";
import type { AgentMaintenanceAction } from "./components/AgentMaintenanceActions";

export function useAgentLifecycle(enabled: boolean, targetId: string) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<LifecycleSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const live = useRef<{targetId:string; attempt:number; operationId:string; revision:number; active:boolean} | null>(null);
  const actionLock = useRef(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let operationId = "";
    let revision = 0;
    const scope = {targetId,attempt,operationId:"",revision:0,active:true};
    live.current = scope;
    function accept(raw: unknown) {
      const next = parseLifecycleSnapshot(raw, targetId);
      if (!active) {
        if (!operationId) void FoundationService.LeaveAgentTarget(targetId,next.operationId).catch(() => {});
        return;
      }
      if ((operationId && next.operationId !== operationId) || next.revision < Math.max(revision,scope.revision)) return;
      operationId = next.operationId; revision = next.revision;
      scope.operationId = operationId; scope.revision = revision;
      setSnapshot(next);setUnavailable(false);
    }
    const poll = async () => {
      if (!active) return;
      try { accept(await FoundationService.GetAgentLifecycleState(targetId)); }
      catch { if (active) setUnavailable(true); }
      if (active) timer = setTimeout(() => { void poll(); }, 800);
    };
    // A fresh target must not display the old target or operation's ready state.
    if (enabled) void FoundationService.CheckAgentEnvironment(targetId).then(raw => {
      accept(raw);
      if (active) void poll();
    }).catch(() => { if (active) setUnavailable(true); });
    return () => {
      active = false;scope.active=false;
      if (timer !== undefined) clearTimeout(timer);
      if (operationId) void FoundationService.LeaveAgentTarget(targetId,operationId).catch(() => {});
    };
  }, [enabled, targetId, attempt]);
  const scope = live.current;
  const current = enabled && scope?.active && scope.targetId === targetId && scope.attempt === attempt && scope.operationId && snapshot?.targetId === targetId && snapshot.operationId === scope.operationId ? snapshot : null;
  async function execute(kind: "start" | "authorize" | "repair" | "cancel" | "reopen" | "restart" | "stop" | "reset" | "reinstall" | "uninstall") {
    const s = live.current;
    const v = current;
    if (!s?.active || !v || unavailable || actionLock.current) return;
    if (kind === "start" && v.stage !== "start" || kind === "repair" && v.stage !== "repair" ||
        kind === "authorize" && !["initialize","configure"].includes(v.stage) ||
        kind === "cancel" && !["authorizing","waiting"].includes(v.stage) ||
        kind === "reopen" && v.stage !== "waiting" ||
        (kind === "restart" || kind === "stop" || kind === "reset" || kind === "reinstall" || kind === "uninstall") && (v.stage !== "ready" || !v.summary)) return;
    if (v.busy && kind !== "cancel" && kind !== "reopen") return;
    actionLock.current = true; setSubmitting(true);
    try {
      let confirmed = v;
      if (kind === "restart" || kind === "stop" || kind === "reset" || kind === "reinstall" || kind === "uninstall") {
        confirmed = parseLifecycleSnapshot(await FoundationService.GetAgentLifecycleState(targetId), targetId);
        if (!s.active || live.current !== s || confirmed.operationId !== v.operationId || confirmed.stage !== "ready" ||
            confirmed.busy || !confirmed.summary || !v.summary || confirmed.summary.agentId !== v.summary.agentId ||
            confirmed.summary.bootId !== v.summary.bootId || confirmed.summary.name !== v.summary.name ||
            confirmed.summary.version !== v.summary.version) throw new Error("maintenance target changed");
      }
      const raw = kind === "start" ? await FoundationService.StartAgent(targetId,v.operationId,v.revision) :
        kind === "authorize" ? await FoundationService.AuthorizeAgent(targetId,v.operationId,v.revision) :
        kind === "repair" ? await FoundationService.RepairAgent(targetId,v.operationId,v.revision) :
        kind === "cancel" ? await FoundationService.CancelAgentAuthorization(targetId,v.operationId) :
        (kind === "restart" || kind === "stop" || kind === "reset" || kind === "reinstall" || kind === "uninstall") && confirmed.summary ? await FoundationService.BeginAgentMaintenance(targetId,confirmed.operationId,confirmed.revision,confirmed.summary.agentId,confirmed.summary.bootId,kind) :
        await FoundationService.ReopenAgentAuthorization(targetId,v.operationId);
      if (kind !== "reopen") {
        const next = parseLifecycleSnapshot(raw,targetId);
        if (s.active && live.current === s && next.operationId === s.operationId && next.revision >= s.revision) {
          s.revision=next.revision;setSnapshot(next);setUnavailable(false);
        }
      }
    } catch { if (s.active && live.current === s) setUnavailable(true); }
    finally { actionLock.current=false;setSubmitting(false); }
  }
  return { snapshot: current, unavailable: enabled && unavailable, busy: submitting || !!current?.busy,
    recheck: () => { if (!actionLock.current && !current?.busy) {setSnapshot(null);setUnavailable(false);setAttempt(a=>a+1);} },
    start: () => void execute("start"), authorize: () => void execute("authorize"), repair: () => void execute("repair"),
    maintenance: (action: AgentMaintenanceAction) => void execute(action),
    cancel: () => void execute("cancel"), reopen: () => void execute("reopen") };
}
export type AgentLifecycle = ReturnType<typeof useAgentLifecycle>;
