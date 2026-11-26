import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { compileInputSchema } from "../../../dist/contracts/validation.js";
import { scriptHeader } from "../../../dist/runtime/scripts.js";
import { BrowserActionError } from "../browser-extension/errors.js";
import { decodeSemanticDocument, observeSemantic } from "../browser-extension/semantic-observation.js";
import { formatSemanticObservation } from "../dist/client/index.js";

function fixtureDocument(extra = []) {
  const strings = [], indexes = new Map();
  const s = value => {if(!indexes.has(value)){indexes.set(value,strings.length);strings.push(value);}return indexes.get(value);};
  const entries = [
    {parent:-1,type:9,tag:"#document"},
    {parent:0,tag:"HTML"}, {parent:1,tag:"BODY"},
    ...extra,
  ];
  const nodes = {parentIndex:[],nodeType:[],nodeName:[],nodeValue:[],backendNodeId:[],attributes:[],inputValue:{index:[],value:[]},inputChecked:{index:[]},optionSelected:{index:[]},shadowRootType:{index:[],value:[]}};
  const layout = {nodeIndex:[],styles:[]};
  const ax = [];
  for (const [i,e] of entries.entries()) {
    nodes.parentIndex.push(e.parent);nodes.nodeType.push(e.type??1);nodes.nodeName.push(s(e.tag));nodes.nodeValue.push(s(e.text??""));nodes.backendNodeId.push(i+100);nodes.attributes.push(Object.entries(e.attributes??{}).flatMap(([k,v])=>[s(k),s(v)]));
    if(e.visible!==false&&(e.type??1)!==9){layout.nodeIndex.push(i);layout.styles.push([s("visible"),s("block")]);}
    if(e.value!==undefined){nodes.inputValue.index.push(i);nodes.inputValue.value.push(s(e.value));}
    if(e.checked)nodes.inputChecked.index.push(i);
    if(e.selected)nodes.optionSelected.index.push(i);
    if(e.shadow){nodes.shadowRootType.index.push(i);nodes.shadowRootType.value.push(s(e.shadow));}
    if(e.role)ax.push({backendDOMNodeId:i+100,role:{value:e.role},name:{value:e.name??""},properties:e.properties??[]});
  }
  const capture={strings,documents:[{documentURL:s("https://example.test/users?token=hidden"),title:s("Fixture"),frameId:s("main-frame"),nodes,layout}]};
  return {capture,ax};
}
const target = {bootId:"boot",browserId:"browser",browserSessionId:"session",generation:1,tabId:"1",pageVersion:2,controlEpoch:"epoch"};
function context(data,{readyState="loading",dialog=null,onSend,onScreenshot}={}) {
  const calls=[];
  let current={...target},url="https://example.test/users?token=hidden";
  const fixture={calls,change(){current={...current,pageVersion:current.pageVersion+1};},navigate(){url="https://example.test/other";},ctx:{target,lease:{},signal:new AbortController().signal,chrome:{tabs:{get:async()=>({title:"Fixture",url})}},router:{
    target:()=>current,dialog:()=>dialog,
    async page(_ctx,args){calls.push(["page",args.command]);return readyState;},
    async send(_ctx,method,params){calls.push([method,params]);onSend?.(method,fixture);if(method==="DOMSnapshot.captureSnapshot")return data.capture;if(method==="Accessibility.getFullAXTree")return {nodes:data.ax};return {};},
    async screenshot(_ctx,options){calls.push(["screenshot",options]);onScreenshot?.(fixture);return Uint8Array.of(255,216,255,217);},
  }}};
  return fixture;
}

test("semantic projection keeps native ancestry, exact AX identity and dynamic control state, not raw HTML or secret values",()=>{
  const {capture,ax}=fixtureDocument([
    {parent:2,tag:"DIV",attributes:{class:"flex gap-2"}},
    {parent:3,tag:"MAIN",attributes:{id:"users"}},
    {parent:4,tag:"TABLE",attributes:{id:"table"}},
    {parent:5,tag:"TR",role:"row",attributes:{class:"user-row flex", "data-user-id":"101", "data-auth-token":"SECRET"}},
    {parent:6,tag:"TD",role:"cell",name:"Alice"},
    {parent:7,tag:"BUTTON",role:"button",name:"Edit",attributes:{id:"edit"}},
    {parent:4,tag:"INPUT",role:"textbox",name:"Username",attributes:{id:"username",value:"initial",name:"username"},value:"current"},
    {parent:4,tag:"INPUT",role:"textbox",name:"Secret",attributes:{type:"password",id:"password",value:"SECRET"},value:"SECRET"},
    {parent:4,tag:"INPUT",attributes:{type:"hidden",value:"SECRET"},value:"SECRET",visible:false},
    {parent:4,tag:"A",role:"link",name:"Users",attributes:{href:"/users?token=SECRET#hidden"}},
    {parent:4,tag:"DIV",attributes:{id:"shadow"}},
    {parent:13,tag:"BUTTON",role:"button",name:"Shadow A",shadow:"open"},
    {parent:13,tag:"BUTTON",role:"button",name:"Shadow B",shadow:"open"},
    {parent:4,tag:"DIV",attributes:{id:"closed"}},
    {parent:16,tag:"BUTTON",role:"button",name:"SECRET",shadow:"closed"},
    {parent:4,tag:"DETAILS"},
    {parent:18,tag:"SUMMARY",name:"Details",role:"button"},
    {parent:18,tag:"P",name:"CLOSED_DETAIL_SECRET",role:"paragraph"},
  ]);
  const result=decodeSemanticDocument(capture,0,ax.reverse());
  const byId=id=>result.rows.find(n=>n.attributes?.id===id);
  assert.equal(byId("username").states.value,"current");
  assert.equal(byId("username").name,"Username");
  assert.equal(byId("edit").role,"button");
  assert.equal(byId("edit").depth,byId("table").depth+3);
  assert.equal(byId("password").states.valueRedacted,true);
  assert.equal(result.rows.find(n=>n.tag==="a").states.hrefRedacted,true);
  assert.equal(result.rows.find(n=>n.tag==="tr").attributes.class,"user-row");
  assert.equal(result.rows.filter(n=>n.tag==="#shadow-root"&&n.attributes.mode==="open").length,1);
  assert.equal(result.rows.filter(n=>n.name?.startsWith("Shadow")).every(n=>n.locatorSupported!==false),true);
  assert.ok(result.rows.some(n=>n.tag==="#shadow-root"&&n.attributes.mode==="closed"));
  assert.doesNotMatch(JSON.stringify(result.rows),/SECRET|initial|gap-2|backendNodeId/);
  assert.equal(result.url,"https://example.test/users");
});

test("open shadow roots support frame discovery and nested closed fragments never leak",()=>{
  const {capture,ax}=fixtureDocument([
    {parent:2,tag:"DIV",attributes:{id:"outer"},role:"group",name:"ANCESTOR_CLOSED_SECRET"},
    {parent:3,type:11,tag:"#document-fragment",shadow:"open"},
    {parent:4,tag:"IFRAME",attributes:{id:"inner-frame"}},
    {parent:4,tag:"DIV",attributes:{id:"closed-host"},role:"button",name:"CLOSED_SECRET"},
    {parent:6,type:11,tag:"#document-fragment",shadow:"closed"},
    {parent:7,tag:"DIV",attributes:{id:"hidden-open"}},
    {parent:8,type:11,tag:"#document-fragment",shadow:"open"},
    {parent:9,tag:"BUTTON",attributes:{id:"secret-button"},role:"button",name:"NESTED_SECRET"},
    {parent:4,tag:"DIV",attributes:{id:"flat-closed-host"}},
    {parent:11,tag:"BUTTON",shadow:"closed",role:"button",name:"FLAT_SECRET"},
    {parent:4,tag:"BUTTON",attributes:{id:"real-button"},role:"button",name:"Open button"},
  ]);
  const result=decodeSemanticDocument(capture,0,ax);
  const frame=result.frames.find(f=>f.row.attributes?.id==="inner-frame");
  assert.match(frame.frameSelector,/inner-frame/);
  assert.equal(result.rows.find(n=>n.attributes?.id==="real-button").locatorSupported,undefined);
  assert.equal(result.rows.filter(n=>n.tag==="#shadow-root"&&n.attributes.mode==="closed").length,2);
  assert.ok(result.warnings.includes("shadow_content_unavailable"));
  assert.ok(!result.warnings.includes("shadow_locator_unsupported"));
  assert.doesNotMatch(JSON.stringify(result.rows),/CLOSED_SECRET|NESTED_SECRET|FLAT_SECRET|secret-button|hidden-open/);
});

test("semantic observation returns mounted data while loading and does not duplicate text, require load, or impose the old AX text cap",async()=>{
  const entries=Array.from({length:2000},(_,i)=>({parent:2,tag:"P",role:"paragraph",name:`Row ${i} ${"business-text ".repeat(8)}`}));
  const f=context(fixtureDocument(entries));
  const result=await observeSemantic(f.ctx);
  assert.equal(result.readyState,"loading");assert.equal(result.nodes.length,2000);
  assert.ok(formatSemanticObservation(result).length>60000);
  assert.deepEqual(f.calls.map(x=>x[0]),["page","DOMSnapshot.captureSnapshot","Accessibility.enable","Accessibility.getFullAXTree"]);
  assert.equal(result.screenshot,undefined);
});

test("semantic observation never returns stale tree or claims a missing screenshot, and preserves the actual error",async()=>{
  const data=fixtureDocument([{parent:2,tag:"BUTTON",role:"button",name:"Save"}]);
  for(const mutate of [f=>f.change(),f=>f.navigate()]){
    const f=context(data,{onSend(method,current){if(method==="Accessibility.getFullAXTree")mutate(current);}});
    await assert.rejects(observeSemantic(f.ctx,true),{code:"STALE_REF"});
    assert.ok(!f.calls.some(x=>x[0]==="screenshot"));
  }
  const missing=context(data,{onScreenshot(){throw new BrowserActionError("OUTPUT_TOO_LARGE","Image unavailable");}});
  await assert.rejects(observeSemantic(missing.ctx,true),{code:"OUTPUT_TOO_LARGE"});
  const f=context(data,{onScreenshot(current){current.change();}});
  await assert.rejects(observeSemantic(f.ctx,true),{code:"STALE_REF"});
  const combined=context(data);
  const result=await observeSemantic(combined.ctx,true);
  assert.deepEqual(result.screenshot,Uint8Array.of(255,216,255,217));
  assert.deepEqual(combined.calls.filter(x=>x[0]==="screenshot"),[["screenshot",{}]]);
});

test("a known native dialog is a partial observation, never silently dismissed or represented as an observed DOM",async()=>{
  const f=context(fixtureDocument(),{dialog:{type:"confirm",message:"Save?"}});
  const result=await observeSemantic(f.ctx);
  assert.equal(result.coverage,"partial");assert.deepEqual(result.nodes,[]);assert.equal(result.dialog.message,"Save?");assert.deepEqual(f.calls,[]);
  await assert.rejects(observeSemantic(f.ctx,true),{code:"INVALID_TARGET"});
  assert.deepEqual(f.calls,[]);
});

const source=await readFile(new URL("../scripts/observe.js",import.meta.url),"utf8");
const metadata=scriptHeader(source);
assert.ok(metadata);
assert.deepEqual(scriptHeader(source.replace(/\r?\n/g,"\r\n")),metadata);
const validate=compileInputSchema(metadata.scriptInputSchema);
const execute=new (Object.getPrototypeOf(async function(){}).constructor)("context","browser",source);
function scriptFixture(error){
  const calls=[],output={type:"fixture-output"};
  const browser={browsers:{get:async input=>{calls.push(["browsers.get",input]);return {id:target.browserId,name:"Fixture",type:"extension",status:"online",bootId:target.bootId,generation:target.generation,browserSessionId:target.browserSessionId};}},tabs:{get:async input=>{calls.push(["tabs.get",input]);return {id:target.tabId,target};}},tab:{writeObservation:async input=>{calls.push(["tab.writeObservation",input]);if(error)throw error;return output;}}};
  return {calls,output,run:async input=>{validate(input);return execute({input},browser);}};
}
test("named observe input is minimal and returns the original native output without repeated calls",async()=>{
  for(const screenshot of [undefined,false,true]){
    const f=scriptFixture();const ids={browserId:target.browserId,tabId:target.tabId,...(screenshot===undefined?{}:{screenshot})};
    assert.equal(await f.run(ids),f.output);
    assert.deepEqual(f.calls.map(x=>x[0]),["browsers.get","tabs.get","tab.writeObservation"]);
    assert.equal(f.calls[2][1].screenshot,screenshot===true);
  }
  for(const input of [{},{browserId:"browser"},{browserId:"",tabId:"1"},{browserId:"browser",tabId:"1",screenshot:"true"},{browserId:"browser",tabId:"1",fullPage:true}]){
    const f=scriptFixture();await assert.rejects(f.run(input),{code:"invalid_arguments"});assert.deepEqual(f.calls,[]);
  }
  const error=new Error("offline");error.code="EXTENSION_OFFLINE";const f=scriptFixture(error);
  await assert.rejects(f.run({browserId:"browser",tabId:"1"}),{code:"EXTENSION_OFFLINE"});assert.equal(f.calls.length,3);
});
