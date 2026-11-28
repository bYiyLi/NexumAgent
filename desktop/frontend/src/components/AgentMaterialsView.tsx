import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ArrowLeft, BookOpen, ChevronRight, FileCode2, FileText, Plus } from "lucide-react";
import type { AgentMaterial, AgentMaterialsInventory, LiveMaterialDetail, MaterialRemoval, ReadMaterial } from "../agent-materials";
import type { Messages } from "../i18n";
import { Button } from "./ui/button";

const icons = { skill: BookOpen, script: FileCode2, instruction: FileText };
const labels = { skill: "Skill", script: "Script", instruction: "Instruction" } as const;
const detailLabels = { skill: "Skills", script: "Scripts", instruction: "Instructions" } as const;

type Props = {
  t: Messages;
  inventory: AgentMaterialsInventory;
  preview: boolean;
  onBack: () => void;
  onOpenMarketplace: () => void;
  readList?: () => Promise<AgentMaterialsInventory>;
  readDetail?: ReadMaterial;
  removeMaterial?: MaterialRemoval;
  onRefresh?: () => void;
};

function noticeLabel(t: Messages, item: AgentMaterial) {
  return item.notice === "danger" ? t.agentMaterialsDanger : item.notice === "advice" ? t.agentMaterialsAdvice : t.agentMaterialsUpdate;
}

function problemDescription(t: Messages, problem?: string) {
  if (problem === "missing_skill_entry") return t.agentMaterialsMissingSkill;
  if (problem === "invalid_skill") return t.agentMaterialsInvalidSkill;
  if (problem === "invalid_script_header" || problem === "script_header_mismatch") return t.agentMaterialsInvalidScriptHeader;
  if (problem === "invalid_input_schema" || problem === "invalid_output_schema") return t.agentMaterialsInvalidScriptSchema;
  if (problem === "script_name_conflict") return t.agentMaterialsScriptConflict;
  return t.agentMaterialsDangerDescription;
}

export function AgentMaterialDetail({ t, item, preview = false, readDetail }: { t: Messages; item: AgentMaterial; preview?: boolean; readDetail?: ReadMaterial }) {
  const [fileIndex, setFileIndex] = useState(0);
  const Icon = icons[item.kind];
  const detail = item.detail?.kind === item.kind ? item.detail : undefined;
  const file = detail?.kind === "skill" ? detail.files[fileIndex] : undefined;

  return (
    <div className="agent-material-detail">
      <div className="agent-material-identity">
        <span className="agent-capabilities-icon"><Icon size={19} strokeWidth={1.7} aria-hidden="true"/></span>
        <div className="agent-capabilities-copy">
          <h1 className="agent-material-name">{item.name}</h1>
          <span className="agent-material-meta">{detailLabels[item.kind]}{item.source && ` · ${item.source}`}</span>
        </div>
      </div>
      {item.notice && <section className="agent-material-notice" data-notice={item.notice}>
        <h2>{noticeLabel(t, item)}</h2>
        {item.notice === "danger" && <p>{problemDescription(t, item.problem)}</p>}
        {item.notice === "advice" && <p>{t.agentMaterialsAdviceDescription}</p>}
        {item.installedRevision && <p>{t.agentMaterialsInstalledRevision} · <code>{item.installedRevision.slice(0, 12)}</code></p>}
        {item.availableRevision && <p>{t.agentMaterialsAvailableRevision} · <code>{item.availableRevision.slice(0, 12)}</code></p>}
      </section>}
      {item.updateCheck === "unknown" && <p className="agent-material-source-note">{t.agentMaterialsUpdateUnknown}</p>}
      {preview && item.previewSourceNote && <p className="agent-material-source-note">{item.previewSourceNote}</p>}
      {readDetail ? <LiveMaterialContent t={t} item={item} readDetail={readDetail}/> : null}
      {!detail && !readDetail && <p className="agent-capabilities-state" role="status">{t.agentMaterialsDetailsUnavailable}</p>}
      {detail?.kind === "skill" && <>
        <section className="agent-material-block"><h2>{t.agentMaterialsWhen}</h2><p>{detail.when}</p></section>
        {detail.files.length > 1 && <details className="agent-material-disclosure">
          <summary>{t.agentMaterialsFiles}</summary>
          {detail.files.map((entry, index) => <button type="button" className="agent-material-file" key={entry.name}
            aria-pressed={index === fileIndex} onClick={() => setFileIndex(index)}>
            <FileText size={16} aria-hidden="true"/><code>{entry.name}</code>
          </button>)}
        </details>}
        {file && <article className="agent-material-reading">
          <p className="agent-material-reading-name"><FileText size={16} aria-hidden="true"/><code>{file.name}</code></p>
          <section className="agent-material-block"><h2>{file.heading}</h2>
            <ol>{file.lines.map((line, index) => <li key={index}>{line}</li>)}</ol>
          </section>
        </article>}
      </>}
      {detail?.kind === "script" && <>
        {item.description && <p>{item.description}</p>}
        <section className="agent-material-block"><h2>{t.agentMaterialsWhen}</h2><p>{detail.when}</p></section>
        <section className="agent-material-block"><h2>{t.agentMaterialsInputs}</h2>
          <dl className="agent-material-fields">{detail.inputs.map(input => <div key={input.name}>
            <dt><code>{input.name}</code><span>{input.required ? t.agentMaterialsRequired : t.agentMaterialsOptional}</span></dt>
            <dd>{input.description}</dd>
          </div>)}</dl>
        </section>
        <section className="agent-material-block"><h2>{t.agentMaterialsOutput}</h2><p>{detail.output}</p></section>
        <details className="agent-material-disclosure"><summary>{t.agentMaterialsSource}</summary><pre><code>{detail.code}</code></pre></details>
      </>}
      {detail?.kind === "instruction" && <>
        <section className="agent-material-block"><h2>{t.agentMaterialsScope}</h2><p>{detail.scope}</p></section>
        <article className="agent-material-reading">{detail.sections.map((section, index) => <section className="agent-material-block" key={index}>
          <h2>{section.heading}</h2>{section.lines.map((line, lineIndex) => <p key={lineIndex}>{line}</p>)}
        </section>)}</article>
      </>}
    </div>
  );
}

function MaterialReadError({ text, retry, onRetry }: { text: string; retry: string; onRetry: () => void }) {
  return <div className="agent-capabilities-state agent-management-feedback">
    <p role="status">{text}</p>
    <Button type="button" variant="secondary" size="sm" data-material-retry onClick={onRetry}>{retry}</Button>
  </div>;
}

function LiveMaterialContent({ t, item, readDetail }: { t: Messages; item: AgentMaterial; readDetail: ReadMaterial }) {
  const [revision, setRevision] = useState(0);
  const [request, setRequest] = useState({ member: "", revision: 0 });
  const [root, setRoot] = useState<{ revision: number; result: LiveMaterialDetail | null }>();
  const [file, setFile] = useState<{ request: typeof request; result: LiveMaterialDetail | null }>();

  useEffect(() => {
    let active = true;
    void readDetail(item).then(
      result => { if (active) setRoot({ revision, result }); },
      () => { if (active) setRoot({ revision, result: null }); },
    );
    return () => { active = false; };
  }, [item, readDetail, revision]);

  useEffect(() => {
    if (request.member === "") return;
    let active = true;
    void readDetail(item, request.member).then(
      result => { if (active) setFile({ request, result }); },
      () => { if (active) setFile({ request, result: null }); },
    );
    return () => { active = false; };
  }, [item, readDetail, request]);

  if (root?.revision !== revision) return <p className="agent-capabilities-state" role="status">{t.agentMaterialsLoading}</p>;
  if (!root.result) return <MaterialReadError text={t.agentMaterialsDetailsUnavailable} retry={t.retry} onRetry={() => setRevision(value => value + 1)}/>;

  const detail = root.result;
  const selectedMember = request.member || detail.member;
  const selected = !request.member ? detail : file?.request === request ? file.result : undefined;
  const content = (value: LiveMaterialDetail) => <>
    {!value.complete && <p className="agent-capabilities-notice" role="status">{t.agentMaterialsContentPartial}</p>}
    <pre className="agent-material-live-text"><code>{value.content}</code></pre>
  </>;

  if (item.kind === "skill") return <>
    {item.description && <section className="agent-material-block"><h2>{t.agentMaterialsWhen}</h2><p>{item.description}</p></section>}
    {(detail.members?.length ?? 0) > 1 && <details className="agent-material-disclosure">
      <summary>{t.agentMaterialsFiles}</summary>
      {detail.members?.map(member => <button type="button" className="agent-material-file" key={member} aria-pressed={member === selectedMember}
        onClick={() => setRequest({ member: member === detail.member ? "" : member, revision: request.revision + 1 })}>
        <FileText size={16} aria-hidden="true"/><code>{member}</code>
      </button>)}
    </details>}
    {detail.treeIncomplete && <p className="agent-capabilities-notice" role="status">{t.agentMaterialsFilesPartial}</p>}
    <article className="agent-material-reading">
      <p className="agent-material-reading-name"><FileText size={16} aria-hidden="true"/><code>{selectedMember}</code></p>
      {selected === undefined ? <p className="agent-capabilities-state" role="status">{t.agentMaterialsLoading}</p>
        : selected === null ? <MaterialReadError text={t.agentMaterialsDetailsUnavailable} retry={t.retry}
          onRetry={() => setRequest(value => ({ ...value, revision: value.revision + 1 }))}/>
          : content(selected)}
    </article>
  </>;

  if (item.kind === "instruction") return <article className="agent-material-reading">{content(detail)}</article>;
  return <>
    {item.description && <p>{item.description}</p>}
    {detail.when && <section className="agent-material-block"><h2>{t.agentMaterialsWhen}</h2><p>{detail.when}</p></section>}
    {detail.inputSchema != null && <details className="agent-material-disclosure"><summary>{t.agentMaterialsInputs}</summary>
      <pre><code>{JSON.stringify(detail.inputSchema, null, 2)}</code></pre></details>}
    {detail.outputSchema != null && <details className="agent-material-disclosure"><summary>{t.agentMaterialsOutput}</summary>
      <pre><code>{JSON.stringify(detail.outputSchema, null, 2)}</code></pre></details>}
    <details className="agent-material-disclosure"><summary>{t.agentMaterialsLiveSource}</summary>{content(detail)}</details>
  </>;
}

export function PreviewMaterialRemoval({ t, item, preview, onRemove }: { t: Messages; item: AgentMaterial; preview: boolean; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  if (!preview || !item.previewRemoval?.location || (item.kind !== "skill" && item.kind !== "script")) return null;
  const skill = item.kind === "skill";
  const action = skill ? t.agentMaterialsDeleteSkill : t.agentMaterialsDeleteScript;
  const title = (skill ? t.agentMaterialsDeleteSkillTitle : t.agentMaterialsDeleteScriptTitle).replace("{name}", item.name);

  return <AlertDialog.Root open={open} onOpenChange={setOpen}>
    <AlertDialog.Trigger render={<Button type="button" variant="ghost" size="sm" className="agent-material-delete"/>}
      aria-label={action}>{t.agentMaterialsDelete}</AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="agent-material-confirm-backdrop"/>
      <AlertDialog.Popup className="agent-material-confirm" initialFocus={cancel}>
        <AlertDialog.Title className="agent-material-confirm-title">{title}</AlertDialog.Title>
        <AlertDialog.Description className="agent-material-confirm-description">
          <span>{skill ? t.agentMaterialsDeleteSkillDescription : t.agentMaterialsDeleteScriptDescription}</span>
          <span className="agent-material-confirm-preview">{t.agentMaterialsDeletePreview}</span>
        </AlertDialog.Description>
        <p className="agent-material-confirm-location">{t.agentMaterialsDeleteLocation}：{item.previewRemoval?.location}</p>
        <div className="agent-material-confirm-actions">
          <AlertDialog.Close render={<Button ref={cancel} type="button" variant="secondary" size="sm"/>}>{t.remoteCancel}</AlertDialog.Close>
          <Button type="button" size="sm" className="agent-material-confirm-delete" onClick={() => { setOpen(false); onRemove(); }}>{action}</Button>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

function LiveMaterialRemoval({ t, item, removal, onRemoved }: { t: Messages; item: AgentMaterial; removal: MaterialRemoval; onRemoved: (success: boolean) => void }) {
  const [prepared, setPrepared] = useState<{ name: string; location: string; token: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  if (!item.canRemove || (item.kind !== "skill" && item.kind !== "script")) return null;
  const skill = item.kind === "skill";
  const action = skill ? t.agentMaterialsDeleteSkill : t.agentMaterialsDeleteScript;
  const title = (skill ? t.agentMaterialsDeleteSkillTitle : t.agentMaterialsDeleteScriptTitle).replace("{name}", prepared?.name ?? item.name);
  async function prepare() {
    setError(false);
    setBusy(true);
    try {
      setPrepared(await removal.prepare(item));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!prepared || busy) return;
    const token = prepared.token;
    setBusy(true);
    try {
      await removal.confirm(item, token);
      setPrepared(undefined);
      onRemoved(true);
    } catch {
      setPrepared(undefined);
      onRemoved(false);
    } finally {
      setBusy(false);
    }
  }
  return <>
    <Button type="button" variant="ghost" size="sm" className="agent-material-delete" disabled={busy}
      aria-label={action} onClick={() => { void prepare(); }}>{t.agentMaterialsDelete}</Button>
    {error && <span role="alert" className="agent-material-removal-error">{t.agentMaterialsUnavailable}</span>}
    <AlertDialog.Root open={!!prepared} onOpenChange={open => { if (!open && !busy) setPrepared(undefined); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="agent-material-confirm-backdrop"/>
        <AlertDialog.Popup className="agent-material-confirm" initialFocus={cancel}>
          <AlertDialog.Title className="agent-material-confirm-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="agent-material-confirm-description">
            {skill ? t.agentMaterialsDeleteSkillDescription : t.agentMaterialsDeleteScriptDescription}
          </AlertDialog.Description>
          <p className="agent-material-confirm-location">{t.agentMaterialsDeleteLocation}：{prepared?.location}</p>
          <div className="agent-material-confirm-actions">
            <AlertDialog.Close render={<Button ref={cancel} type="button" variant="secondary" size="sm" disabled={busy}/>}>{t.remoteCancel}</AlertDialog.Close>
            <Button type="button" size="sm" className="agent-material-confirm-delete" disabled={busy} onClick={() => { void confirm(); }}>{action}</Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </>;
}

export function AgentMaterialsView({ t, inventory, preview, onBack, onOpenMarketplace, readList, readDetail, removeMaterial, onRefresh }: Props) {
  const [listRevision, setListRevision] = useState(0);
  const [liveInventory, setLiveInventory] = useState<{ revision: number; inventory: AgentMaterialsInventory }>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<readonly string[]>([]);
  const [removedNotice, setRemovedNotice] = useState(false);
  const [removalResult, setRemovalResult] = useState<"success" | "unknown">();
  const root = useRef<HTMLElement>(null);
  const previousSelection = useRef<string | null>(null);
  const savedScroll = useRef(0);
  const focusAfterRetry = useRef(false);
  const current = readList ? liveInventory?.revision === listRevision ? liveInventory.inventory : { state: "loading", items: [] } as const : inventory;
  const items = current.items.filter(item => !removedIds.includes(item.id))
    .sort((a, b) => ({ danger: 3, advice: 2, update: 1 }[b.notice ?? "update"] * Number(!!b.notice))
      - ({ danger: 3, advice: 2, update: 1 }[a.notice ?? "update"] * Number(!!a.notice)));
  const selected = current.state === "available" || current.state === "partial"
    ? items.find(item => item.id === selectedId) : undefined;
  const activeId = selected?.id;

  useEffect(() => {
    if (preview) return;
    setRemovedIds(ids => {
      const stillPresent = ids.filter(id => current.items.some(item => item.id === id));
      return stillPresent.length === ids.length ? ids : stillPresent;
    });
  }, [current.items, preview]);

  useLayoutEffect(() => {
    if (!focusAfterRetry.current || current.state === "loading") return;
    focusAfterRetry.current = false;
    const next = root.current?.querySelector<HTMLElement>(current.state === "unavailable" ? "[data-material-retry]" : "[data-material-id]");
    (next ?? root.current?.querySelector<HTMLElement>("[data-agent-materials-back]"))?.focus({ preventScroll: true });
  }, [current.state]);

  useEffect(() => {
    if (!readList) return;
    let active = true;
    void readList().then(
      next => { if (active) setLiveInventory({ revision: listRevision, inventory: next }); },
      () => { if (active) setLiveInventory({ revision: listRevision, inventory: { state: "unavailable", items: [] } }); },
    );
    return () => { active = false; };
  }, [readList, listRevision]);

  useLayoutEffect(() => {
    const scroll = root.current?.closest<HTMLElement>(".desktop-content");
    if (activeId) {
      if (scroll) scroll.scrollTop = 0;
      root.current?.querySelector<HTMLElement>("[data-agent-materials-back]")?.focus({ preventScroll: true });
      previousSelection.current = activeId;
    } else if (previousSelection.current) {
      if (scroll) scroll.scrollTop = savedScroll.current;
      const buttons = root.current?.querySelectorAll<HTMLElement>("[data-material-id]");
      const previous = Array.from(buttons ?? []).find(button => button.dataset.materialId === previousSelection.current);
      (previous ?? root.current?.querySelector<HTMLElement>("[data-agent-materials-back]"))?.focus({ preventScroll: true });
      previousSelection.current = null;
    }
  }, [activeId]);

  function open(item: AgentMaterial) {
    savedScroll.current = root.current?.closest<HTMLElement>(".desktop-content")?.scrollTop ?? 0;
    setRemovedNotice(false);
    setRemovalResult(undefined);
    setSelectedId(item.id);
  }

  return (
    <section ref={root} className="desktop-page agent-capabilities-page" aria-label={t.agentMaterialsPage} data-agent-materials>
      <div className="agent-capabilities-toolbar">
        <Button type="button" variant="ghost" size="sm" className="agent-capabilities-back" data-agent-materials-back
          onClick={() => selected ? setSelectedId(null) : onBack()}>
          <ArrowLeft size={17} aria-hidden="true"/>{selected ? t.agentMaterialsBack : t.agentWorkspaceBack}
        </Button>
        <div className="agent-capabilities-actions">
          {preview && <span className="agent-capabilities-preview">{t.remoteUiPreview}</span>}
          {selected && <PreviewMaterialRemoval t={t} item={selected} preview={preview} onRemove={() => {
              setRemovedIds(ids => [...ids, selected.id]);
              setSelectedId(null);
              setRemovedNotice(true);
            }}/>}
          {!preview && selected && removeMaterial && <LiveMaterialRemoval key={selected.id} t={t} item={selected} removal={removeMaterial} onRemoved={success => {
            if (success) setRemovedIds(ids => [...ids, selected.id]);
            setSelectedId(null);
            setRemovalResult(success ? "success" : "unknown");
            onRefresh?.();
          }}/>}
          {!selected && <Button type="button" variant="ghost" size="icon" className="agent-capabilities-add"
            aria-label={t.agentCapabilitiesAdd} title={t.agentCapabilitiesAdd} onClick={onOpenMarketplace}>
            <Plus size={19} aria-hidden="true"/>
          </Button>}
        </div>
      </div>

      {selected ? <AgentMaterialDetail key={selected.id} t={t} item={selected} preview={preview} readDetail={readDetail}/> : <>
        {removalResult && <p className="agent-capabilities-state" role="status">{removalResult === "success" ? t.agentMaterialsDeleteSuccess : t.agentMaterialsDeleteUnknown}</p>}
        {current.state === "loading" ? <p className="agent-capabilities-state" role="status">{t.agentMaterialsLoading}</p>
          : current.state === "unavailable" ? readList ? <MaterialReadError text={t.agentMaterialsUnavailable} retry={t.retry} onRetry={() => {
              focusAfterRetry.current = true;
              setListRevision(value => value + 1);
            }}/>
            : onRefresh ? <MaterialReadError text={t.agentMaterialsUnavailable} retry={t.retry} onRetry={onRefresh}/>
              : <p className="agent-capabilities-state" role="status">{t.agentMaterialsUnavailable}</p>
          : current.state === "partial" && items.length === 0 ? <p className="agent-capabilities-state" role="status">{t.agentMaterialsPartial}</p>
          : items.length === 0 ? <p className="agent-capabilities-state" role="status">{t.agentMaterialsEmpty}</p>
          : <ul className="agent-capabilities-list" aria-label={t.agentMaterialsPage}>
            {items.map(item => {
              const Icon = icons[item.kind];
              return <li key={item.id}>
                <button type="button" className="agent-capabilities-item" data-material-id={item.id} data-material-kind={item.kind}
                  aria-label={`${item.name}, ${labels[item.kind]}${item.notice ? `, ${noticeLabel(t, item)}` : ""}`} onClick={() => open(item)}>
                  <span className="agent-capabilities-icon"><Icon size={19} strokeWidth={1.7} aria-hidden="true"/></span>
                  <span className="agent-capabilities-copy"><span className="agent-capabilities-name">{item.name}{item.notice && <span className="agent-material-tag" data-notice={item.notice}>{noticeLabel(t, item)}</span>}</span>
                    {(item.description || item.source) && <span className="agent-capabilities-description">{item.description || item.source}</span>}
                  </span>
                  <span className="agent-capabilities-type">{labels[item.kind]}</span>
                  <ChevronRight className="agent-capabilities-chevron" size={15} strokeWidth={1.7} aria-hidden="true"/>
                </button>
              </li>;
            })}
          </ul>}
        {current.state === "partial" && items.length > 0 && <p className="agent-capabilities-state" role="status">{t.agentMaterialsPartial}</p>}
      </>}
      <p className="sr-only" role="status">{removedNotice ? t.agentMaterialsDeletePreviewSuccess : ""}</p>
    </section>
  );
}
