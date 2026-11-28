import { useEffect, useRef, useState } from "react";
import { AlertCircle, ExternalLink } from "lucide-react";
import type { AgentTarget } from "../agent-targets";
import type { Messages, MessageKey } from "../i18n";
import type { AgentLifecycle } from "../use-agent-lifecycle";
import { lifecycleStages, type LifecycleStage, type LifecycleSnapshot, type RuntimeStage } from "../agent-lifecycle";
import { environmentCheckPhases } from "../environment-check";
import { Button } from "./ui/button";
import { ProgressBar } from "./ui/progress";

type Display = {title:MessageKey;detail:MessageKey;active?:boolean;error?:boolean};
const progressDisplay: Partial<Record<import("../agent-lifecycle").LifecycleStage, Display>> = {
  install_manifest:{title:"lifecycleInstallManifest",detail:"lifecycleInstallManifestDetail",active:true},
  install_download:{title:"lifecycleInstallDownload",detail:"lifecycleInstallDownloadDetail",active:true},
  install_verify:{title:"lifecycleInstallVerify",detail:"lifecycleInstallVerifyDetail",active:true},
  install_space:{title:"lifecycleInstallSpaceStep",detail:"lifecycleInstallSpaceDetail",active:true},
  install_stage:{title:"lifecycleInstallStage",detail:"lifecycleInstallStageDetail",active:true},
  install_config:{title:"lifecycleInstallConfig",detail:"lifecycleInstallConfigDetail",active:true},
  install_service:{title:"lifecycleInstallService",detail:"lifecycleInstallServiceDetail",active:true},
  install_start:{title:"lifecycleInstallStart",detail:"lifecycleInstallStartDetail",active:true},
  install_readiness:{title:"lifecycleInstallReadiness",detail:"lifecycleInstallReadinessDetail",active:true},
  stopping:{title:"lifecycleRestoreStop",detail:"lifecycleRestoreStopDetail",active:true},
  restore_stop:{title:"lifecycleRestoreStop",detail:"lifecycleRestoreStopDetail",active:true},
  restore_config:{title:"lifecycleRestoreConfig",detail:"lifecycleRestoreConfigDetail",active:true},
  restore_start:{title:"lifecycleRestoreStart",detail:"lifecycleRestoreStartDetail",active:true},
  repair_download:{title:"lifecycleRepairDownload",detail:"lifecycleRepairDownloadDetail",active:true},
  repair_verify:{title:"lifecycleRepairVerify",detail:"lifecycleRepairVerifyDetail",active:true},
  repair_apply:{title:"lifecycleRepairApply",detail:"lifecycleRepairApplyDetail",active:true},
  reinstall_prepare:{title:"agentReinstallPreparing",detail:"agentReinstallPreparingDetail",active:true},
  reinstall_apply:{title:"agentReinstallApplying",detail:"agentReinstallApplyingDetail",active:true},
  uninstall_service:{title:"agentUninstallService",detail:"agentUninstallServiceDetail",active:true},
  uninstall_program:{title:"agentUninstallProgram",detail:"agentUninstallProgramDetail",active:true},
  repair_service:{title:"lifecycleRepairServiceStep",detail:"lifecycleRepairServiceDetail",active:true},
  start_service:{title:"lifecycleInstallStart",detail:"lifecycleInstallStartDetail",active:true},
  start_verify:{title:"lifecycleInstallReadiness",detail:"lifecycleInstallReadinessDetail",active:true},
  stop_service:{title:"lifecycleRestoreStop",detail:"lifecycleRestoreStopDetail",active:true},
  stop_verify:{title:"lifecycleRestoreStop",detail:"lifecycleRestoreStopDetail",active:true}
};
const startDisplay = {
  starting: {title:"startStarting",detail:"startWaiting",active:true},
  connecting: {title:"startConnecting",detail:"startVerify",active:true},
  unknown: {title:"startUnknown",detail:"startUnknownDetail",error:true},
  failed: {title:"checkFailed",detail:"startUnknownDetail",error:true}
} satisfies Record<string,Display>;
const runtimeLabels: Partial<Record<RuntimeStage,MessageKey>> = {
  node_check:"runtimeNodeCheck", node_download:"runtimeNodeDownload", node_install:"runtimeNodeInstall",
  pnpm_prepare:"runtimePnpmPrepare", host_check:"runtimeHostCheck", host_download:"runtimeHostDownload",
  host_install:"runtimeHostInstall", host_start:"runtimeHostStart", host_configure:"runtimeHostConfigure",
  host_retry:"runtimeHostRetry", host_failed:"runtimeHostFailed", agent_upgrade_download:"runtimeUpgradeDownload",
  agent_upgrade_verify:"runtimeUpgradeVerify", agent_upgrade_apply:"runtimeUpgradeApply"
};
const stageLabels: Partial<Record<LifecycleStage,MessageKey>> = {
  ...environmentCheckPhases, initialize:"checkInitialize", configure:"checkConfigure", start:"checkStart",
  starting:"startStarting", connecting:"startConnecting", upgrade:"agentUpgradeRunning", repair:"checkRepair",
  repairing:"lifecycleRepairing", authorizing:"lifecyclePreparingAuthorization", waiting:"installWaiting",
  exchanging:"lifecycleExchanging", installing:"installRunning", restoring:"restoreRunning", stopped:"checkStart"
};
function formatBytes(n:number) {
  return n >= 1048576 ? (n/1048576).toFixed(1)+" MiB" : n >= 1024 ? (n/1024).toFixed(1)+" KiB" : n+" B";
}

// Development-only adapter: the same renderer consumes fixtures and real snapshots.
// No preview action invokes a FoundationService binding.
const previewStages = lifecycleStages;
export function UnifiedAgentLifecyclePreview({t,current,initial,onEndPreview,onWorkspace}:{t:Messages;current:AgentTarget;initial:LifecycleStage;onEndPreview:()=>void;onWorkspace:()=>void}) {
  const [stage,setStage]=useState<LifecycleStage>(initial);
  const [runtime,setRuntime]=useState<RuntimeStage|null>(null);
  const move=(next:LifecycleStage):undefined=>{setStage(next);setRuntime(null);return undefined;};
  const snapshot:LifecycleSnapshot={revision:1,targetId:current.id,operationId:"00000000000000000000000000000001",stage,reason:stage==="repair"?"program_missing":"",version:"1.0.0",requiredVersion:stage==="upgrade"?"1.1.0":"",busy:false,summary:null,
    observedStages:stage==="install_download"?["install_manifest","install_download"]:undefined,
    progress:stage==="install_download"||stage==="repair_download"?{stage,downloadedBytes:6291456,totalBytes:10485760}:undefined,
    runtimeProgress:runtime?{stage:runtime,downloadedBytes:runtime==="node_download"||runtime==="host_download"?6291456:0,totalBytes:runtime==="node_download"||runtime==="host_download"?10485760:0}:undefined};
  const lifecycle:AgentLifecycle={snapshot,unavailable:false,busy:false,recheck:()=>move("system"),start:()=>move("starting"),authorize:()=>move("waiting"),repair:()=>move("repair_download"),cancel:()=>move("initialize"),reopen:()=>move("waiting"),maintenance:()=>{}};
  const controls=<div className="startup-preview">
    <p>{t.lifecyclePreviewOnly}</p>
    <div className="startup-preview-actions"><select aria-label={t.previewPhase} value={runtime??stage} onChange={e=>{
      const v=e.target.value;
      if(v==="ready"){onWorkspace();return;}
      if(Object.hasOwn(runtimeLabels,v)){setStage(v.startsWith("agent_upgrade_")?"upgrade":"install_readiness");setRuntime(v as RuntimeStage);return;}
      if((lifecycleStages as readonly string[]).includes(v))move(v as LifecycleStage);
    }}>
      {previewStages.map(v=><option key={v} value={v}>{v==="ready"?t.startPreviewReady:t[progressDisplay[v]?.title??stageLabels[v]??(v==="failed"?"checkFailed":v==="network"?"checkNetwork":v==="blocked"?"checkBlocked":"startUnknown")]}</option>)}
      {Object.entries(runtimeLabels).map(([v,label])=><option key={v} value={v}>{t[label]}</option>)}
    </select><Button variant="link" onClick={onEndPreview}>{t.endPreview}</Button></div>
  </div>;
  return <AgentLifecycleView t={t} current={current} lifecycle={lifecycle} previewControls={controls}/>;
}

export function AgentLifecycleView({t,current,lifecycle:l,previewControls}:{t:Messages;current:AgentTarget;lifecycle:AgentLifecycle;previewControls?:React.ReactNode}) {
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
  const s=l.snapshot;
  const stage=l.unavailable?"unknown":s?.stage??"system";
  const reason=s?.reason??"";
  const phase=Object.hasOwn(environmentCheckPhases,stage)?environmentCheckPhases[stage as keyof typeof environmentCheckPhases]:null;
  let display:Display;
  let primary:(()=>void)|null=null;
  let action:MessageKey="checkRetry";
  let secondary:(()=>void)|null=null;
  let secondaryLabel:MessageKey="checkRetry";
  const errorDetail:MessageKey=l.unavailable?"lifecycleCheckUnavailable":reason==="management_protocol_unavailable"?"lifecycleProtocolUnavailable":
    reason==="target_download_failed"?"lifecycleTargetDownloadFailed":
    reason==="runtime_prepare_failed"?"agentReinstallPrepareFailed":reason==="runtime_recovery_required"?"agentReinstallRecoveryRequired":
    reason==="restore_requires_stopped_service"?"lifecycleRestoreStopped":reason==="secure_installer_unavailable"?"lifecycleSecureInstaller":
    (reason==="install_space_unconfirmed"||reason==="install_space_insufficient")?"lifecycleInstallSpace":
    reason==="management_identity_mismatch"?"lifecycleIdentityMismatch":reason==="configuration"?"lifecycleConfigBlocked":"lifecycleBlocked";
  if(phase)display={title:"checkChecking",detail:phase,active:true};
  else if(progressDisplay[stage as keyof typeof progressDisplay]) display=progressDisplay[stage as keyof typeof progressDisplay]!;
  else switch(stage){
    case "initialize": case "configure":
      display={title:stage==="initialize"?"checkInitialize":"checkConfigure",detail:stage==="initialize"?"lifecycleInitialize":reason==="credential_missing_or_invalid_running"?"lifecycleConfigureRunning":"lifecycleConfigure"};
      primary=l.authorize;action="installOpenBrowser";secondary=l.recheck;break;
    case "stopped": case "start": display={title:"checkStart",detail:"lifecycleStart"};primary=l.start;action="checkStartAction";secondary=l.recheck;break;
    case "starting":case "connecting":display=startDisplay[stage];break;
    case "upgrade":display=reason==="version_incompatible"?{title:"agentUpgradeWaiting",detail:"agentUpgradeWaitingDetail",active:true}:{title:"agentUpgradeRunning",detail:"lifecycleUpgrade",active:true};break;
    case "repair":display=reason==="uninstalled"?{title:"agentUninstalled",detail:"agentUninstalledDetail"}:{title:"checkRepair",detail:reason==="program_missing"?"lifecycleRepairProgram":"lifecycleRepairService"};primary=l.repair;action=reason==="uninstalled"?"agentRestoreInstallation":"lifecycleRepairAction";secondary=l.recheck;break;
    case "repairing":display={title:"lifecycleRepairing",detail:"lifecycleRepairingDetail",active:true};break;
    case "authorizing":display={title:"lifecyclePreparingAuthorization",detail:"lifecycleBusy",active:true};secondary=l.cancel;secondaryLabel="lifecycleCancelAuthorization";break;
    case "waiting":display={title:"installWaiting",detail:"installWaitingDetail",active:true};primary=l.reopen;action="installReopenBrowser";secondary=l.cancel;secondaryLabel="lifecycleCancelAuthorization";break;
    case "exchanging":display={title:"lifecycleExchanging",detail:"lifecycleBusy",active:true};break;
    case "installing":case "restoring":display={title:stage==="installing"?"installRunning":"restoreRunning",detail:stage==="installing"?"lifecycleInstalling":"lifecycleRestoring",active:true};break;
    case "network":display={title:"checkNetwork",detail:"lifecycleNetwork",error:true};primary=l.recheck;break;
    case "blocked":display={title:"checkBlocked",detail:errorDetail,error:true};primary=l.recheck;break;
    case "failed": {
      if(reason==="authorization_cancelled") display={title:"lifecycleAuthorizationCancelled",detail:"lifecycleAuthorizationCancelledDetail",error:true};
      else if(reason==="authorization_denied") display={title:"lifecycleAuthorizationDenied",detail:"lifecycleAuthorizationDeniedDetail",error:true};
      else if(reason==="authorization_expired") display={title:"installExpired",detail:"installExpiredDetail",error:true};
      else if(reason==="authorization_failed"||reason==="authorization_browser_failed") display={title:"installAuthorizationFailed",detail:"installAuthorizationFailedDetail",error:true};
      else display={title:"checkFailed",detail:"startUnknownDetail",error:true};
      primary=l.recheck;break;
    }
    default:display={title:"startUnknown",detail:reason==="management_protocol_unavailable"||l.unavailable?errorDetail:"startUnknownDetail",error:true};primary=l.recheck;break;
  }
  const runtime = !l.unavailable && (stage === "install_readiness" || stage === "reinstall_prepare" || stage === "upgrade" || stage === "ready" && s?.waitingForRuntime || stage === "connecting") ? s?.runtimeProgress : undefined;
  const runtimeLabel=runtime && (runtime.stage.startsWith("agent_upgrade_") ? stage==="upgrade" : stage!=="upgrade") ? runtimeLabels[runtime.stage as RuntimeStage] : undefined;
  if (runtimeLabel) display={title:runtimeLabel,detail:"runtimeProgressDetail",active:runtime?.stage!=="host_failed",error:runtime?.stage==="host_failed"};
  else if (stage==="ready" && s?.waitingForRuntime) display={title:"runtimeHostConfigure",detail:"runtimeProgressDetail",active:true};
  const transfer = runtimeLabel ? runtime : !l.unavailable && s?.progress?.stage===stage ? s.progress : undefined;
  const percent=transfer && transfer.totalBytes>0 ? Math.floor(transfer.downloadedBytes/transfer.totalBytes*100) : null;
  const currentStep=runtimeLabel && runtime ? "runtime:"+runtime.stage : stage;
  const history=(s?.observedStages??[]).map((item,index)=>({stage:item,key:item+":"+index,label:item.startsWith("runtime:")?runtimeLabels[item.slice(8) as RuntimeStage]:progressDisplay[item as LifecycleStage]?.title??stageLabels[item as LifecycleStage]})).filter(item=>item.label);
  if (runtimeLabel && history.at(-1)?.stage!==currentStep) history.push({stage:currentStep as typeof history[number]["stage"],key:"current-runtime",label:runtimeLabel});
  return <div className="startup-page lifecycle-page" data-lifecycle-stage={stage}>
    <div className="startup-content">
      <div className="startup-wordmark">Nexum</div>
      <div className={`startup-progress${percent!==null?" lifecycle-progress-known":""}`}>
        {display.active ? <><ProgressBar value={percent} label={t[display.title]}/>{percent!==null && <span className="lifecycle-percent">{percent}%</span>}</> : display.error ? <AlertCircle className="startup-error-mark" size={20} aria-hidden="true"/> : null}
      </div>
      <section className="startup-status" role={display.error?"alert":"status"}>
        <h1 ref={heading} tabIndex={-1}>{t[display.title]}</h1>
        <p>{t[display.detail]}</p>
        {percent!==null && transfer && <p className="startup-update-version">{formatBytes(transfer.downloadedBytes)} / {formatBytes(transfer.totalBytes)}</p>}
        {stage==="upgrade" && s?.requiredVersion && s.version && s.requiredVersion!==s.version && <p className="startup-update-version">{s.version} → {s.requiredVersion}</p>}
        <p className="lifecycle-target">{current.kind==="local"?current.description:current.name} · {current.kind==="local"?t.envLocal:t.envRemote}{s?.version && stage!=="upgrade" ? " · "+s.version : ""}</p>
      </section>
      {(history.length>0 || runtimeLabel) && <details className="lifecycle-details">
        <summary>{t.lifecycleProgressDetails}</summary>
        <p>{t.lifecycleObservedStages}</p>
        <ol>{history.map((item,index)=><li key={item.key} aria-current={index===history.length-1 && item.stage===currentStep?"step":undefined}>{t[item.label!]}</li>)}</ol>
      </details>}
    </div>
    <footer className="startup-footer lifecycle-footer">
      {primary && <Button type="button" className="remote-connect-button" disabled={l.busy&&stage!=="waiting"} onClick={primary}>{t[action]}{action==="installOpenBrowser"||action==="installReopenBrowser"?<ExternalLink size={16} aria-hidden="true"/>:null}</Button>}
      {secondary && <Button type="button" variant="ghost" className="remote-cancel-button" disabled={l.busy&&secondaryLabel!=="lifecycleCancelAuthorization"} onClick={secondary}>{t[secondaryLabel]}</Button>}
      {l.busy&&stage!=="waiting"&&stage!=="authorizing"&&!display.active&&<p role="status">{t.lifecycleBusy}</p>}
      {previewControls}
      <span className="startup-product-label">DESKTOP</span>
    </footer>
  </div>;
}
