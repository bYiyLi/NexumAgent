import {describe,it,expect} from "vitest";
import {parseBootstrapSnapshot,realBootstrapState,type BootstrapSnapshot} from "./bootstrap-runtime";
import {messages} from "./i18n";
const state:BootstrapSnapshot={revision:1,phase:"checking",info:{profile:"development",name:"Nexum Desktop Dev",version:"0.1.0-dev",theme:"dark",language:"zh-CN",localHost:"Mac",platform:"darwin"},currentVersion:"0.1.0-dev",targetVersion:"",downloadedBytes:0,totalBytes:0,errorCode:"",retryable:false,canViewLogs:true,canQuit:true,canManualInstall:false,updateCheck:"notChecked"};
describe("real Bootstrap IPC",()=>{
 it("rejects empty and inconsistent snapshots",()=>{
  for(const v of [{},null,{...state,phase:"unknown"},{...state,info:{}},{...state,revision:0},{...state,totalBytes:2,downloadedBytes:3},{...state,phase:"ready"},{...state,phase:"ready",updateCheck:"required"}])expect(()=>parseBootstrapSnapshot(v)).toThrow();
  expect(parseBootstrapSnapshot({...state,phase:"ready",updateCheck:"offline"}).phase).toBe("ready");
 });
 it("uses actual progress and preserves a blocked failure",()=>{
  const t=messages("en-US");
  expect(realBootstrapState({...state,phase:"downloading",targetVersion:"0.2.0-next.1",downloadedBytes:7,totalBytes:10},false,t)).toMatchObject({phase:"update",update:{progress:70}});
  expect(realBootstrapState({...state,phase:"downloading"},false,t)).toMatchObject({phase:"update",update:{progress:null}});
  expect(realBootstrapState({...state,phase:"migrationFailed"},false,t)).toEqual({phase:"migrationFailed",retryable:false});
  expect(realBootstrapState(null,true,t)).toEqual({phase:"initializationFailed"});
 });
});
