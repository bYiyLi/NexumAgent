import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { lifecycleStages, runtimeStages, parseLifecycleSnapshot } from "./agent-lifecycle";
import { AgentLifecycleView, UnifiedAgentLifecyclePreview } from "./components/AgentLifecycleView";
import { AgentWorkspaceView } from "./components/AgentWorkspaceView";
import { messages } from "./i18n";
import type { AgentTarget } from "./agent-targets";
import type { AgentLifecycle } from "./use-agent-lifecycle";
import { requestedPreview, activePreview, desktopPage } from "./desktop-page";
const current:AgentTarget={id:"local",kind:"local",name:"Local",description:"Fixture Mac"};
const noop=()=>undefined;
const base={revision:2,targetId:"local",operationId:"0123456789abcdef0123456789abcdef",stage:"ready",reason:"management_verified",version:"1.2.3",requiredVersion:"1.2.3",busy:false,summary:{agentId:"fixture-id",bootId:"boot",name:"Actual Agent",platform:"darwin",arch:"arm64",version:"1.2.3",runtime:"healthy",management:"connected",cloud:"offline"}};
describe("real lifecycle state and startup preview",()=>{
 it("admits only validated management identity",()=>{
  const s=parseLifecycleSnapshot(base,"local");expect(s.summary?.name).toBe("Actual Agent");expect(s.summary?.platform).toBe("macOS");expect(s.summary?.cloud).toBe("offline");
  expect(parseLifecycleSnapshot({...base,summary:{...base.summary,cloud:"unknown"}},"local").summary?.cloud).toBe("unknown");
  for(const v of [{...base,targetId:"other"},{...base,summary:null},{...base,summary:{...base.summary,management:"disconnected"}},{...base,stage:"starting"},{...base,operationId:""}])expect(()=>parseLifecycleSnapshot(v,"local")).toThrow();
 });
 it("keeps the startup preview development-only",()=>{
  expect(requestedPreview("?preview=agent-start")).toBe("agent-start");
  expect(activePreview("production","agent-start")).toBeNull();
  expect(desktopPage({phase:"ready"},false,"agent-start")).toBe("agent-lifecycle");
  expect(desktopPage({phase:"initializing"},false,"agent-start")).toBe("bootstrap");
  for(const locale of ["zh-CN","en-US"] as const){const t=messages(locale);const markup=renderToStaticMarkup(<UnifiedAgentLifecyclePreview t={t} current={current} initial="starting" onEndPreview={noop} onWorkspace={noop}/>);expect(markup).toContain(t.lifecyclePreviewOnly);expect(markup).toContain('role="progressbar"');expect(markup).not.toContain("aria-valuenow=");}
 });
 it("all old launch aliases resolve to one protected preview",()=>{
  for (const name of ["agent-lifecycle","environment","environment-check","agent-start","agent-upgrade","agent-repair"] as const) {
    expect(requestedPreview("?preview="+name)).toBe(name);
    expect(activePreview("production",name)).toBeNull();
    expect(desktopPage({phase:"ready"},false,activePreview("development",name))).toBe("agent-lifecycle");
    expect(desktopPage({phase:"ready"},false,activePreview("production",name))).toBe("workspace");
    expect(desktopPage({phase:"ready"},true,name)).toBe("settings");
    expect(desktopPage({phase:"ready"},false,name,"setup")).toBe("remote-setup");
  }
 });
 it("all reachable lifecycle stages use the same renderer without credential inputs",()=>{
  for (const locale of ["zh-CN","en-US"] as const) {
   const t=messages(locale);
   for (const stage of lifecycleStages.filter(x=>x!=="ready")) {
    const markup=renderToStaticMarkup(<UnifiedAgentLifecyclePreview t={t} current={current} initial={stage} onEndPreview={noop} onWorkspace={noop}/>);
    expect(markup).toContain(t.lifecyclePreviewOnly);expect(markup).toContain("startup-wordmark");
    expect(markup).toContain('data-lifecycle-stage="'+stage+'"');expect(markup).not.toContain("<input");expect(markup).toContain(current.description);
   }
   for (const runtime of runtimeStages) {
    const snapshot=parseLifecycleSnapshot({...base,stage:"install_readiness",summary:null,runtimeProgress:{stage:runtime,downloadedBytes:0,totalBytes:0}},"local");
    const lifecycle:AgentLifecycle={snapshot,busy:true,unavailable:false,recheck:noop,start:noop,repair:noop,authorize:noop,cancel:noop,reopen:noop,maintenance:noop};
    const markup=renderToStaticMarkup(<AgentLifecycleView t={t} current={current} lifecycle={lifecycle}/>);
    expect(markup).toContain("startup-wordmark");expect(markup).not.toContain("aria-valuenow=");
   }
  }
 });
 it("only confirmed initialize or restore results offer authorization; repair is targeted",()=>{
  for (const locale of ["zh-CN","en-US"] as const) {
   const t=messages(locale);
   for (const stage of ["initialize","configure","network","blocked","repair","upgrade","start","failed"] as const) {
    const snapshot=parseLifecycleSnapshot({...base,stage,reason:stage==="repair"?"program_missing":"",summary:null},"local");
    const lifecycle:AgentLifecycle={snapshot,busy:false,unavailable:false,recheck:noop,start:noop,repair:noop,authorize:noop,cancel:noop,reopen:noop,maintenance:noop};
    const markup=renderToStaticMarkup(<AgentLifecycleView t={t} current={current} lifecycle={lifecycle}/>);
    expect(markup.includes(t.installOpenBrowser)).toBe(stage==="initialize"||stage==="configure");
    expect(markup.includes(t.lifecycleRepairAction)).toBe(stage==="repair");
    if(stage==="repair")expect(markup).toContain(t.lifecycleRepairProgram);
    if(stage==="network"||stage==="blocked"||stage==="failed")expect(markup).toContain('role="alert"');
    if(stage==="upgrade")expect(markup).not.toContain("remote-connect-button");
    expect(markup).not.toContain("<input");
   }
  }
 });
 it("renders actual ready identity without preview data",()=>{
  const summary=parseLifecycleSnapshot(base,"local").summary!;
  const t=messages("zh-CN");const html=renderToStaticMarkup(<AgentWorkspaceView t={t} current={current} isMac liveSummary={summary} onEndPreview={noop} onOpenMarketplace={noop} onRecheck={noop}/>);expect(html).toContain("Actual Agent");expect(html).toContain("1.2.3");expect(html).not.toContain(t.remoteUiPreview);expect(html).not.toContain("1.1.0");
 });
 it("renders real installer, restore and repair progress stages in both locales",()=>{
  for(const locale of ["zh-CN","en-US"] as const){
   const t=messages(locale);
   const cases=[
    ["install_download","lifecycleInstallDownload"],
    ["restore_stop","lifecycleRestoreStop"],
    ["repair_apply","lifecycleRepairApply"]
   ] as const;
   for(const [stage,key] of cases){
    const s=parseLifecycleSnapshot({...base,stage,reason:"",summary:null},"local");
    const lifecycle:AgentLifecycle={snapshot:s,busy:true,unavailable:false,recheck:noop,start:noop,repair:noop,authorize:noop,cancel:noop,reopen:noop,maintenance:noop};
    const html=renderToStaticMarkup(<AgentLifecycleView t={t} current={current} lifecycle={lifecycle}/>);
    expect(html).toContain(t[key]);expect(html).toContain('role="status"');expect(html).toContain('role="progressbar"');expect(html).not.toContain(t.remoteUiPreview);
   }
  }
 });
 it("renders runtime preparation before stopping the Agent and its specific failures",()=>{
  for(const locale of ["zh-CN","en-US"] as const){
   const t=messages(locale);
   const view=(stage:string,reason:string,runtimeProgress?:unknown)=>{
    const snapshot=parseLifecycleSnapshot({...base,stage,reason,summary:null,runtimeProgress,observedStages:["reinstall_prepare","runtime:node_download"]},"local");
    const lifecycle:AgentLifecycle={snapshot,busy:false,unavailable:false,recheck:noop,start:noop,repair:noop,authorize:noop,cancel:noop,reopen:noop,maintenance:noop};
    return renderToStaticMarkup(<AgentLifecycleView t={t} current={current} lifecycle={lifecycle}/>);
   };
   expect(view("reinstall_prepare","")).toContain(t.agentReinstallPreparingDetail);
   const progress=view("reinstall_prepare","",{stage:"node_download",downloadedBytes:5,totalBytes:10});
   expect(progress).toContain(t.runtimeNodeDownload);expect(progress).toContain("50%");
   expect(view("blocked","runtime_prepare_failed")).toContain(t.agentReinstallPrepareFailed);
   expect(view("blocked","runtime_recovery_required")).toContain(t.agentReinstallRecoveryRequired);
  }
 });
 it("shows actual bytes, validated runtime progress and a shared preview canvas",()=>{
  const t=messages("zh-CN");
  const snapshot=parseLifecycleSnapshot({...base,stage:"install_readiness",summary:null,runtimeProgress:{stage:"node_download",downloadedBytes:524288,totalBytes:1048576},observedStages:["install_download","install_readiness"]},"local");
  const lifecycle:AgentLifecycle={snapshot,busy:true,unavailable:false,recheck:noop,start:noop,repair:noop,authorize:noop,cancel:noop,reopen:noop,maintenance:noop};
  const html=renderToStaticMarkup(<AgentLifecycleView t={t} current={current} lifecycle={lifecycle}/>);
  expect(html).toContain(t.runtimeNodeDownload);expect(html).toContain("50%");expect(html).toContain("512.0 KiB / 1.0 MiB");expect(html).toContain("startup-wordmark");expect(html).toContain(t.lifecycleObservedStages);
  expect(parseLifecycleSnapshot({...base,stage:"install_download",summary:null,progress:{stage:"install_download",downloadedBytes:10,totalBytes:2}},"local").progress).toBeUndefined();
  const preview=renderToStaticMarkup(<UnifiedAgentLifecyclePreview t={t} current={current} initial="install_download" onEndPreview={noop} onWorkspace={noop}/>);
  expect(preview).toContain(t.lifecyclePreviewOnly);expect(preview).toContain("startup-wordmark");expect(preview).toContain("60%");
 });
 it("admits an old or failed runtime only as degraded",()=>{
  const degraded={...base,summary:{...base.summary,runtime:"degraded"},waitingForRuntime:true};
  expect(parseLifecycleSnapshot(degraded,"local").waitingForRuntime).toBe(false);
  expect(parseLifecycleSnapshot({...degraded,runtimeProgress:{stage:"host_start",downloadedBytes:0,totalBytes:0}},"local").waitingForRuntime).toBe(true);
  expect(parseLifecycleSnapshot({...degraded,runtimeProgress:{stage:"host_failed",downloadedBytes:0,totalBytes:0}},"local").waitingForRuntime).toBe(false);
 });
 it("renders real start admission without preview actions",()=>{
  const t=messages("zh-CN");const s=parseLifecycleSnapshot({...base,stage:"start",reason:"service_stopped",summary:null},"local");
  const lifecycle:AgentLifecycle={snapshot:s,busy:false,unavailable:false,recheck:noop,start:noop,repair:noop,authorize:noop,cancel:noop,reopen:noop,maintenance:noop};
  const html=renderToStaticMarkup(<AgentLifecycleView t={t} current={current} lifecycle={lifecycle}/>);expect(html).toContain(t.checkStartAction);expect(html).toContain(t.lifecycleStart);expect(html).not.toContain(t.remoteUiPreview);expect(html).not.toContain(t.checkStartDetail);
 });
 it("distinguishes actual authorization cancellation, denial, expiry and browser failure",()=>{
  for(const locale of ["zh-CN","en-US"] as const){
   const t=messages(locale);
   const cases=[
    ["authorization_cancelled","lifecycleAuthorizationCancelled","lifecycleAuthorizationCancelledDetail"],
    ["authorization_denied","lifecycleAuthorizationDenied","lifecycleAuthorizationDeniedDetail"],
    ["authorization_expired","installExpired","installExpiredDetail"],
    ["authorization_browser_failed","installAuthorizationFailed","installAuthorizationFailedDetail"],
   ] as const;
   for(const [reason,title,detail] of cases){
    const snapshot=parseLifecycleSnapshot({...base,stage:"failed",reason,summary:null},"local");
    const lifecycle:AgentLifecycle={snapshot,busy:false,unavailable:false,recheck:noop,start:noop,repair:noop,authorize:noop,cancel:noop,reopen:noop,maintenance:noop};
    const html=renderToStaticMarkup(<AgentLifecycleView t={t} current={current} lifecycle={lifecycle}/>);
    expect(html).toContain(t[title]);expect(html).toContain(t[detail]);expect(html).toContain(t.checkRetry);
   }
  }
 });
});
