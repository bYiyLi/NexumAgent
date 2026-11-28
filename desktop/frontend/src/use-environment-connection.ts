import { useCallback, useEffect, useRef, useState } from "react";
import { FoundationService } from "../bindings/github.com/bYiyLi/NexumAgent/desktop";
import {
  emptyRemoteDraft, parseEnvironmentSnapshot, parseEnvironmentAttempt, parseKeySelection,
  connectionErrorKey, savedRemoteDraft,
  type EnvironmentFlow, type EnvironmentSnapshot, type EnvironmentView, type RemoteSecrets,
} from "./environment-runtime";
import type { RemoteDraft } from "./remote-draft";
import type { MessageKey } from "./i18n";

type ConnectionCallbacks = {
  connected: (id: string, warning: MessageKey | null) => void;
  removed: (id: string) => void;
  notice: (message: MessageKey | null) => void;
};

export function useEnvironmentConnection(ready: boolean, callbacks: ConnectionCallbacks) {
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [flow, setFlow] = useState<EnvironmentFlow | null>(null);
  const [working, setWorking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const revision = useRef(0);
  const attemptId = useRef<string | null>(null);
  const cancelled = useRef<string | null>(null);
  const actionLock = useRef(false);
  const epoch = useRef(0);
  const current = useRef(callbacks);
  useEffect(() => { current.current = callbacks; }, [callbacks]);

  const accept = useCallback((value: unknown) => {
    const next = parseEnvironmentSnapshot(value);
    if (next.revision < revision.current) return;
    revision.current = next.revision;
    setSnapshot(next);
    setReadFailed(false);
    const attempt = next.attempt;
    if (cancelled.current && attempt?.id === cancelled.current &&
      !["connecting", "verify", "authenticating"].includes(attempt.phase)) {
      cancelled.current = null;
      setBlocked(false);
    }
    if (!attempt || attempt.id !== attemptId.current) return;
    if (attempt.phase === "connected") {
      const target = next.environments.find(item => item.id === attempt.environmentId && item.connected);
      attemptId.current = null;
      if (!target) {
        setFlow(old => old ? { ...old, stage: "failed",
          attempt: { ...attempt, phase: "failed", errorCode: "connection_lost" } } : null);
        return;
      }
      setFlow(null);
      current.current.connected(target.id, attempt.warning ? connectionErrorKey(attempt.warning) : null);
      return;
    }
    const stage = attempt.phase;
    setFlow(old => old ? { ...old, stage, attempt } : null);
  }, []);

  // Poll the authoritative native snapshot. Never fabricate a connected state.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await FoundationService.GetEnvironmentState();
        if (alive) accept(value);
      } catch {
        if (alive) setReadFailed(true);
      } finally {
        if (alive) timer = setTimeout(() => { void poll(); }, attemptId.current ? 300 : 1200);
      }
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [ready, accept]);

  const refresh = useCallback(async () => {
    try { accept(await FoundationService.GetEnvironmentState()); }
    catch { setReadFailed(true); }
  }, [accept]);

  function canAct() {
    return ready && snapshot !== null && !readFailed && !actionLock.current && !cancelled.current;
  }

  // Serialize cancellation and admission. An explicit request id exists before
  // the IPC call, so a late admission cannot escape its cancellation.
  const cancel = useCallback(async (back?: RemoteDraft, existingId?: string) => {
    const id = attemptId.current ?? cancelled.current;
    ++epoch.current;
    attemptId.current = null;
    cancelled.current = id;
    setFlow(back ? { draft: back, existingId, stage: "setup" } : null);
    if (!ready || actionLock.current) return;
    actionLock.current = true;
    setWorking(true);
    try {
      if (id) await FoundationService.CancelEnvironmentConnection(id);
      cancelled.current = null;
      setBlocked(false);
      await FoundationService.ClearEnvironmentPrivateKey();
    } catch {
      setBlocked(cancelled.current !== null);
      current.current.notice("remoteActionFailed");
    } finally {
      await refresh();
      actionLock.current = false;
      setWorking(false);
    }
  }, [ready, refresh]);

  function open() {
    if (!canAct()) return;
    current.current.notice(null);
    setFlow({ draft: emptyRemoteDraft(), stage: "setup" });
  }

  async function start(draft: RemoteDraft, form?: RemoteSecrets, existingId?: string, useSaved = false) {
    if (!canAct() || attemptId.current) return;
    const generation = ++epoch.current;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(20)), value => value.toString(16).padStart(2, "0")).join("");
    attemptId.current = id;
    current.current.notice(null);
    setFlow({ draft, existingId, stage: "connecting" });
    try {
      const receipt = parseEnvironmentAttempt(await FoundationService.StartEnvironmentConnection({
        attemptId: id, id: existingId ?? "", host: draft.host, port: Number(draft.port),
        username: draft.user, authType: draft.auth, useSaved,
        ...({ password: "", keyToken: "", passphrase: "", remember: false, ...form }),
      }));
      if (generation !== epoch.current) return;
      if (receipt.id !== id) throw new Error("Mismatched connection receipt");
      await refresh();
    } catch {
      if (generation !== epoch.current) return;
      // The admission reply can be lost. Inspect the same request, not a
      // duplicate. If not confirmed, retire it before allowing another.
      try {
        const observed = parseEnvironmentSnapshot(await FoundationService.GetEnvironmentState());
        if (generation !== epoch.current) return;
        if (observed.attempt?.id === id) { accept(observed); return; }
      } catch { /* Cancellation below is bound to the original request. */ }
      if (generation !== epoch.current) return;
      await cancel(draft, existingId);
      if (epoch.current === generation + 1) current.current.notice("remoteAdmissionUnknown");
    }
  }

  function reconnect(target: EnvironmentView) {
    if (!canAct() || target.kind !== "ssh" || target.connected) return;
    const draft = savedRemoteDraft(target);
    if (target.authType === "agent" || target.hasSavedCredential) {
      void start(draft, undefined, target.id, true);
    } else {
      setFlow({ draft, existingId: target.id, stage: "setup" });
    }
  }

  async function trust() {
    const attempt = flow?.attempt;
    if (!attempt || attempt.phase !== "verify" || attempt.id !== attemptId.current || readFailed || actionLock.current) return;
    try { await FoundationService.TrustEnvironmentHost(attempt.id, attempt.fingerprint); }
    catch { current.current.notice("remoteActionFailed"); }
    await refresh();
  }

  async function change(id: string, action: "disconnect" | "remove") {
    if (!canAct()) return;
    actionLock.current = true;
    setWorking(true);
    current.current.notice(null);
    try {
      if (action === "disconnect") await FoundationService.DisconnectEnvironment(id);
      else {
        await FoundationService.RemoveEnvironment(id);
        current.current.removed(id);
      }
    } catch { current.current.notice("remoteActionFailed"); }
    finally {
      await refresh();
      actionLock.current = false;
      setWorking(false);
    }
  }

  return {
    snapshot, readFailed, flow, working, blocked,
    available: ready && snapshot !== null && !readFailed && !working && !blocked,
    open, start, reconnect, trust, change, cancel,
    chooseKey: () => FoundationService.ChooseEnvironmentPrivateKey().then(parseKeySelection),
    clearKey: () => { void FoundationService.ClearEnvironmentPrivateKey().catch(() => current.current.notice("remoteActionFailed")); },
  };
}
