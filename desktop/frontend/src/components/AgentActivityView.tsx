import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, Braces, ChevronRight, CircleAlert, CircleCheck, CircleMinus, CirclePause, Code2, FileText, MessageCircle, Package, ScrollText } from "lucide-react";
import { activeRunStatuses, type ActivityDetail, type ActivityRun, type ActivityStatus, type ActivityText, type AgentActivityInventory } from "../agent-activity";
import type { ActivityObservation, ActivityPart, ActivityRequest, ReadActivity } from "../agent-activity-runtime";
import type { MessageKey, Messages } from "../i18n";
import { Button } from "./ui/button";

type Part = "code" | "input" | "logs" | "result" | "resources";
const parts: readonly { key: Part; label: MessageKey; icon: typeof Code2 }[] = [
  { key: "code", label: "agentActivityCode", icon: Code2 },
  { key: "input", label: "agentActivityInput", icon: Braces },
  { key: "logs", label: "agentActivityLogs", icon: ScrollText },
  { key: "result", label: "agentActivityResult", icon: FileText },
  { key: "resources", label: "agentActivityResources", icon: Package },
];
const statusLabels: Record<ActivityStatus, MessageKey> = {
  accepted: "agentActivityAccepted", preparing_inputs: "agentActivityPreparing", running: "agentActivityRunning",
  waiting_input: "agentActivityWaiting", cancelling: "agentActivityCancelling", succeeded: "agentActivitySucceeded",
  failed: "agentActivityFailed", cancelled: "agentActivityCancelled", interrupted: "agentActivityInterrupted",
};

function statusTone(status: ActivityStatus) {
  if (status === "waiting_input") return "waiting";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "stopped";
  return "running";
}

function StatusIcon({ status }: { status: ActivityStatus }) {
  const Icon = status === "waiting_input" ? MessageCircle : status === "succeeded" ? CircleCheck
    : status === "failed" ? CircleAlert : status === "cancelled" ? CircleMinus : status === "interrupted" ? CirclePause : Activity;
  return <span className="agent-activity-icon"><Icon size={17} strokeWidth={1.8} aria-hidden="true"/></span>;
}

function time(value?: string, short = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, short ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    : { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function duration(t: Messages, run: ActivityRun) {
  const end = run.finishedAt ?? (activeRunStatuses.has(run.status) ? run.observedAt : undefined);
  if (!run.startedAt || !end) return "";
  const seconds = Math.floor((Date.parse(end) - Date.parse(run.startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return t.agentActivityDurationSeconds.replace("{seconds}", String(seconds));
  return t.agentActivityDurationMinutes.replace("{minutes}", String(Math.floor(seconds / 60))).replace("{seconds}", String(seconds % 60));
}

function RunList({ t, runs, open }: { t: Messages; runs: readonly ActivityRun[]; open: (run: ActivityRun) => void }) {
  return <ul className="agent-activity-list">
    {runs.map(run => <li key={run.id}><button type="button" className="agent-activity-row" data-tone={statusTone(run.status)} data-activity-run={run.id} onClick={() => open(run)}>
      <StatusIcon status={run.status}/><span className="agent-activity-copy"><span className="agent-activity-row-title">{run.title}</span>
        <span className="agent-activity-secondary">{[run.project, time(run.acceptedAt)].filter(Boolean).join(" · ")}</span></span>
      <span className="agent-activity-status">{t[statusLabels[run.status]]}</span><ChevronRight size={13} aria-hidden="true"/>
    </button></li>)}
  </ul>;
}

function unavailableText(t: Messages, value?: ActivityText) {
  if (value?.state === "pending") return t.agentActivityPending;
  if (value?.state === "loading") return t.agentActivityLoadingContent;
  return t.agentActivityUnavailableSnapshot;
}

function textSummary(t: Messages, detail: ActivityDetail | undefined, key: Part, run: ActivityRun, loading: boolean) {
  if (!detail) return loading ? t.agentActivityLoadingContent : t.agentActivityDetailsUnavailable;
  if (key === "resources") {
    if (detail.resources.state !== "available") return t.agentActivityUnavailableSnapshot;
    if (detail.resources.items.length) return detail.resources.items[0]?.name ?? "";
    return detail.resources.complete ? t.agentActivityNoResources : t.agentActivityIncomplete;
  }
  const value = detail[key];
  if (value.state === "loading") return key === "code" ? (run.scriptName ?? (run.source === "inline" ? t.agentActivityInlineCode : "")) : key === "input" ? "context.input" : "";
  if (value.state !== "available") return unavailableText(t, value);
  return key === "code" ? (run.scriptName ?? (run.source === "inline" ? t.agentActivityInlineCode : "")) : key === "input" ? "context.input" : "";
}

function Snapshot({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length > 5000) return <pre className="agent-activity-snapshot agent-activity-snapshot-large"><code>{text}</code></pre>;
  return <pre className="agent-activity-snapshot"><code>{lines.map((line, index) => <span className="agent-activity-line" key={index}>
    <span className="agent-activity-line-number" aria-hidden="true">{index + 1}</span><span className="agent-activity-line-text">{line}{index < lines.length - 1 ? "\n" : ""}</span>
  </span>)}</code></pre>;
}

function ActivityReader({ t, run, part, loading }: { t: Messages; run: ActivityRun; part: Part; loading: boolean }) {
  const definition = parts.find(entry => entry.key === part)!;
  const detail = run.detail;
  let content;
  if (!detail) content = <p className="agent-activity-secondary" role="status">{loading ? t.agentActivityLoadingContent : t.agentActivityDetailsUnavailable}</p>;
  else if (part === "resources") {
    const resources = detail.resources;
    content = resources.state !== "available" ? <p className="agent-activity-secondary" role="status">{t.agentActivityUnavailableSnapshot}</p>
      : <>{resources.items.length ? <ul className="agent-activity-resource-list">{resources.items.map(item => <li key={item.id}>
        <span className="agent-activity-row-title">{item.name}</span><span className="agent-activity-secondary">{[item.kind, item.status].filter(Boolean).join(" · ")}</span>
      </li>)}</ul> : resources.complete && <p className="agent-activity-secondary">{t.agentActivityNoResources}</p>}
      {!resources.complete && <p className="agent-activity-secondary" role="status">{t.agentActivityIncomplete}</p>}</>;
  } else {
    const value = detail[part];
    content = value.state === "available" ? <><Snapshot text={value.text}/>{!value.complete && <p className="agent-activity-secondary agent-activity-incomplete" role="status">{t.agentActivityIncomplete}</p>}</>
      : <p className="agent-activity-secondary" role="status">{unavailableText(t, value)}</p>;
  }
  return <><h1 className="agent-activity-heading">{t[definition.label]}</h1>
    <p className="agent-activity-secondary agent-activity-reader-meta">{part === "code" && run.scriptName ? <code>{run.scriptName}</code>
      : part === "input" ? <code>context.input</code> : run.title}</p><section className="agent-activity-reader">{content}</section></>;
}

function RunDetail({ t, run, openPart, loading }: { t: Messages; run: ActivityRun; openPart: (part: Part) => void; loading: boolean }) {
  const detail = run.detail;
  const notice = run.status === "waiting_input" ? detail?.waitMessage : detail?.errorMessage;
  const noticeTitle = run.status === "waiting_input" ? t.agentActivityWaitingOn : run.status === "interrupted" ? t.agentActivityInterruption : t.agentActivityFailure;
  return <><div className="agent-activity-detail-head"><h1 className="agent-activity-heading">{run.title}</h1>
    <div className="agent-activity-detail-status" data-tone={statusTone(run.status)}><span className="agent-activity-status">{t[statusLabels[run.status]]}</span>
      {duration(t, run) && <span className="agent-activity-secondary">{duration(t, run)}</span>}</div></div>
    <div className="agent-activity-detail-panel">
      {notice && <section className="agent-activity-section agent-activity-notice" data-tone={statusTone(run.status)}><h2>{noticeTitle}</h2><p>{notice}</p></section>}
      <section className="agent-activity-section"><h2>{t.agentActivityDetails}</h2><ul className="agent-activity-entries">
        {parts.map(({ key, label, icon: Icon }) => <li key={key}><button type="button" className="agent-activity-entry" data-activity-part={key} onClick={() => openPart(key)}>
          <span className="agent-activity-icon"><Icon size={17} strokeWidth={1.8} aria-hidden="true"/></span>
          <span className="agent-activity-copy"><span className="agent-activity-row-title">{t[label]}</span><span className="agent-activity-secondary">{textSummary(t, detail, key, run, loading)}</span></span>
          <ChevronRight size={13} aria-hidden="true"/></button></li>)}
      </ul></section>
      <section className="agent-activity-section"><h2>{t.agentActivityTimeline}</h2><ol className="agent-activity-timeline" data-tone={statusTone(run.status)}>
        <li><time dateTime={run.acceptedAt}>{time(run.acceptedAt, true)}</time><span>{t.agentActivityAccepted}</span></li>
        {run.startedAt && <li><time dateTime={run.startedAt}>{time(run.startedAt, true)}</time><span>{t.agentActivityStarted}</span></li>}
        {detail?.waitAt && run.status === "waiting_input" && <li><time dateTime={detail.waitAt}>{time(detail.waitAt, true)}</time><span>{t.agentActivityWaiting}</span></li>}
        {run.finishedAt && <li><time dateTime={run.finishedAt}>{time(run.finishedAt, true)}</time><span>{t[statusLabels[run.status]]}</span></li>}
      </ol></section>
      <section className="agent-activity-section"><h2>{t.agentActivityInformation}</h2><dl className="agent-activity-fields">
        {run.project && <><dt>{t.agentActivityProject}</dt><dd>{run.project}</dd></>}
        <dt>{t.agentActivitySource}</dt><dd>{run.scriptName ? <code>{run.scriptName}</code> : run.source === "inline" ? t.agentActivityInlineCode : t.agentActivitySourceUnknown}</dd>
        <dt>Run ID</dt><dd><code>{run.id}</code></dd>
      </dl></section>
    </div></>;
}

export function AgentActivityView({ t, inventory, preview, onBack, readActivity }: { t: Messages; inventory: AgentActivityInventory; preview: boolean; onBack: () => void; readActivity?: ReadActivity }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ActivityRun | null>(null);
  const [part, setPart] = useState<Part | null>(null);
  const [liveInventory, setLiveInventory] = useState<AgentActivityInventory>({ state: "loading", items: [] });
  const [pageLimit, setPageLimit] = useState(4);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [observation, setObservation] = useState<ActivityObservation | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [partCache, setPartCache] = useState<Partial<Record<"code" | "input" | "logs", ActivityText>>>({});
  const root = useRef<HTMLElement>(null);
  const previous = useRef<{ id: string | null; part: Part | null }>({ id: null, part: null });
  const listScroll = useRef(0);
  const detailScroll = useRef(0);
  const currentInventory = readActivity ? liveInventory : inventory;
  const run = selectedId && selectedRun ? (readActivity ? { ...(observation?.run ?? selectedRun), detail: observation ? { ...observation.detail, ...partCache } : undefined } : selectedRun) : undefined;
  const id = run?.id ?? null;

  useEffect(() => {
    if (!readActivity) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      const items: ActivityRun[] = [];
      const seen = new Set<string>();
      let cursor = "";
      let next: string | null = null;
      let partial = false;
      try {
        for (let pageIndex = 0; pageIndex < pageLimit; pageIndex++) {
          const page = await readActivity!({ action: "list", cursor });
          if (!("runs" in page)) throw new Error("invalid list");
          for (const entry of page.runs) {
            if (seen.has(entry.id)) { partial = true; continue; }
            seen.add(entry.id);
            items.push(entry);
          }
          partial ||= page.partial;
          next = page.nextCursor;
          if (!page.nextCursor) break;
          if (page.nextCursor === cursor) { partial = true; break; }
          cursor = page.nextCursor;
        }
        if (active) { setLiveInventory({ state: partial ? "partial" : "available", items }); setNextCursor(next); setLoadingMore(false); }
      } catch {
        if (active) { setLiveInventory(items.length ? { state: "partial", items } : { state: "unavailable", items: [] }); setNextCursor(null); setLoadingMore(false); }
      }
      if (active) timer = setTimeout(() => { void refresh(); }, Math.max(5000, pageLimit * 1000));
    }
    void refresh();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [readActivity, pageLimit]);

  useEffect(() => {
    if (!readActivity || !selectedId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const result = await readActivity!({ action: "detail", runId: selectedId! });
        if (!("detail" in result)) throw new Error("invalid detail");
        if (active) { setObservation(result); setDetailError(false); }
      } catch {
        if (active) { setObservation(null); setPartCache({}); setDetailError(true); }
      }
      if (active) timer = setTimeout(() => { void refresh(); }, 5000);
    }
    void refresh();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [readActivity, selectedId]);

  const observedPartState = part && part !== "result" && part !== "resources" ? observation?.detail[part].state : undefined;
  useEffect(() => {
    if (!readActivity || !selectedId || !part || part === "result" || part === "resources" || observedPartState !== "loading") return;
    const kind = part;
    let active = true;
    async function read() {
      let offset = 0;
      let text = "";
      let bytes = 0;
      let complete = false;
      let clipped = false;
      try {
        for (let index = 0; index < 16; index++) {
          const request: ActivityRequest = { action: "part", runId: selectedId!, kind, offset };
          const result = await readActivity!(request);
          if (!("nextOffset" in result)) throw new Error("invalid snapshot");
          const chunk: ActivityPart = result;
          clipped ||= chunk.offset > offset;
          const chunkBytes = new TextEncoder().encode(chunk.text).length;
          if (bytes + chunkBytes > 256 * 1024) break;
          text += chunk.text;
          bytes += chunkBytes;
          offset = chunk.nextOffset;
          if (chunk.complete) { complete = !clipped; break; }
          if (chunk.nextOffset <= chunk.offset) break;
        }
        if (active) setPartCache(previous => ({ ...previous, [kind]: { state: "available", text, complete } }));
      } catch {
        if (active) setPartCache(previous => ({ ...previous, [kind]: text ? { state: "available", text, complete: false } : { state: "unavailable" } }));
      }
    }
    void read();
    return () => { active = false; };
  }, [readActivity, selectedId, part, observedPartState]);

  useLayoutEffect(() => {
    const before = previous.current;
    const scroll = root.current?.closest<HTMLElement>(".desktop-content");
    if (before.id !== id || before.part !== part) {
      if (!id && before.id) {
        if (scroll) scroll.scrollTop = listScroll.current;
        const buttons = root.current?.querySelectorAll<HTMLElement>("[data-activity-run]");
        (Array.from(buttons ?? []).find(button => button.dataset.activityRun === before.id) ?? root.current?.querySelector<HTMLElement>("[data-agent-activity-back]"))?.focus({ preventScroll: true });
      } else if (id && !part && before.part) {
        if (scroll) scroll.scrollTop = detailScroll.current;
        root.current?.querySelector<HTMLElement>(`[data-activity-part="${before.part}"]`)?.focus({ preventScroll: true });
      } else {
        if (scroll) scroll.scrollTop = 0;
        root.current?.querySelector<HTMLElement>("[data-agent-activity-back]")?.focus({ preventScroll: true });
      }
    }
    previous.current = { id, part };
  }, [id, part]);

  function select(next: ActivityRun) {
    listScroll.current = root.current?.closest<HTMLElement>(".desktop-content")?.scrollTop ?? 0;
    setSelectedRun(next);
    setObservation(null);
    setDetailError(false);
    setPartCache({});
    setSelectedId(next.id);
  }
  function openPart(next: Part) {
    detailScroll.current = root.current?.closest<HTMLElement>(".desktop-content")?.scrollTop ?? 0;
    if (readActivity && next !== "result" && next !== "resources" && observation?.detail[next].state === "loading") {
      setPartCache(previous => ({ ...previous, [next]: { state: "loading" } }));
    }
    setPart(next);
  }
  function back() {
    if (part) setPart(null);
    else if (run) { setSelectedId(null); setSelectedRun(null); setObservation(null); setPartCache({}); }
    else onBack();
  }
  const active = currentInventory.items.filter(item => activeRunStatuses.has(item.status)).sort((a, b) => Number(b.status === "waiting_input") - Number(a.status === "waiting_input"));
  const ended = currentInventory.items.filter(item => !activeRunStatuses.has(item.status));
  const detailLoading = Boolean(readActivity && !observation && !detailError);

  return <section ref={root} className="desktop-page agent-activity-page" aria-label={t.agentWorkspaceActivity} data-agent-activity>
    <div className="agent-capabilities-toolbar"><Button type="button" variant="ghost" size="sm" className="agent-capabilities-back" data-agent-activity-back onClick={back}>
      <ArrowLeft size={17} aria-hidden="true"/>{part ? t.agentActivityBackDetail : run ? t.agentActivityBackList : t.agentWorkspaceBack}</Button>
      {preview && <span className="agent-capabilities-preview">{t.remoteUiPreview}</span>}</div>
    {run && part ? <ActivityReader t={t} run={run} part={part} loading={detailLoading}/> : run ? <RunDetail t={t} run={run} openPart={openPart} loading={detailLoading}/> : <>
      {currentInventory.state === "loading" ? <p className="agent-activity-empty" role="status">{t.agentActivityLoading}</p>
        : currentInventory.state === "unavailable" ? <p className="agent-activity-empty" role="status">{t.agentActivityUnavailable}</p>
        : currentInventory.items.length === 0 ? <p className="agent-activity-empty" role="status">{currentInventory.state === "partial" ? t.agentActivityIncomplete : t.agentActivityEmpty}</p>
        : <><RunList t={t} runs={[...active, ...ended]} open={select}/>
          {currentInventory.state === "partial" && <p className="agent-activity-empty" role="status">{t.agentActivityIncomplete}</p>}</>}
      {readActivity && nextCursor && <Button type="button" variant="ghost" size="sm" className="agent-activity-more" disabled={loadingMore}
        onClick={() => { setLoadingMore(true); setPageLimit(value => value + 4); }}>{loadingMore ? t.agentActivityLoading : t.agentActivityMore}</Button>}
    </>}
  </section>;
}
