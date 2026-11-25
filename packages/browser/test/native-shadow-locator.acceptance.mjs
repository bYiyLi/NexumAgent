import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeFixture, select } from "./helpers/native.mjs";

// Use the real MV3 extension and an isolated Chromium, not a mocked DOM.
const html = `<!doctype html><title>Shadow locator fixture</title>
<style>body{margin:12px}#panel,#other,#frames,#disabled-host{display:block;margin:12px 0}iframe{display:block;width:350px;height:190px}</style>
<button id="plain-save">Save</button><span id="local-name">Wrong document label</span>
<div id="panel"><span slot="label" id="assigned-label">Slotted label</span><button id="unassigned">Unassigned secret action</button></div>
<div id="other"></div><div id="disabled-host" aria-disabled="true"></div><div id="frames"></div>
<script>
window.clicks=[];window.inputs=[];
document.addEventListener('click',e=>clicks.push({id:e.composedPath()[0].id,trusted:e.isTrusted}));
document.addEventListener('input',e=>inputs.push({id:e.composedPath()[0].id,composed:e.composed}));
const panel=document.querySelector('#panel').attachShadow({mode:'open'});
panel.innerHTML='<style>:host{display:block}button,input,select{margin:5px}#nested{display:block}</style><button id="shadow-save" data-testid="save">Save</button><span id="local-name">Shadow label</span><button id="named" aria-labelledby="local-name">Other text</button><label for="field">Shadow field</label><input id="field" placeholder="Type here"><input id="wrong" aria-label="Other field"><button id="slotted"><!-- component marker --><slot name="label"><span id="fallback">Fallback should not match</span></slot></button><div id="nested"></div><label><input id="check" type="checkbox">Accept shadow</label><select id="choice" aria-label="Shadow choice"><option value="a">A</option><option value="b">B</option></select><input id="upload" type="file" aria-label="Shadow upload"><img id="image" alt="Shadow image" width="32" height="32" src="/pixel.png"><div id="closed-host"></div><button id="replace">Replace me</button>';
const nested=panel.querySelector('#nested').attachShadow({mode:'open'});nested.innerHTML='<button id="deep" data-testid="deep">Deep action</button>';
const hidden=panel.querySelector('#closed-host').attachShadow({mode:'closed'});hidden.innerHTML='<button id="closed-secret">CLOSED_SECRET</button><div id="hidden-open"></div>';hidden.querySelector('#hidden-open').attachShadow({mode:'open'}).innerHTML='<button id="nested-secret">NESTED_SECRET</button>';
document.querySelector('#other').attachShadow({mode:'open'}).innerHTML='<button id="other-save">Save</button><span id="local-name">Wrong other label</span>';
document.querySelector('#disabled-host').attachShadow({mode:'open'}).innerHTML='<button id="disabled">Disabled component</button>';
const frames=document.querySelector('#frames').attachShadow({mode:'open'});frames.innerHTML='<iframe id="local-frame" src="/frame"></iframe><iframe id="cross-frame"></iframe>';
frames.querySelector('#cross-frame').src=location.origin.replace('127.0.0.1','localhost')+'/frame';
</script>`;
const child = `<!doctype html><title>Shadow frame</title><div id="child-host"></div><script>const r=document.querySelector('#child-host').attachShadow({mode:'open'});r.innerHTML='<button id="frame-action">Frame action</button><label for="inner-input">Frame field</label><input id="inner-input">';r.querySelector('button').onclick=e=>{e.currentTarget.dataset.clicked=String(e.isTrusted)};</script>`;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
const fixture = t => nativeFixture(t,{html,handleRequest(req,res){
  if(req.url==='/frame'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(child);return true;}
  if(req.url==='/pixel.png'){res.writeHead(200,{'Content-Type':'image/png'});res.end(pixel);return true;}
  return false;
}});

test('native open Shadow DOM uses existing selectors, semantic names, strict scope and trusted input', {timeout:120000}, async t=>{
  const f=await fixture(t);
  const view=await f.run(select+`
const pw=tab.playwright,panel=pw.locator('#panel');
const ids=await pw.getByRole('button',{name:'Save',exact:true}).evaluateAll('nodes=>nodes.map(n=>n.id)');
const order=await pw.locator('#other-save').or(pw.locator('#plain-save')).or(pw.locator('#shadow-save')).evaluateAll('nodes=>nodes.map(n=>n.id)');
const counts={css:await pw.locator('#shadow-save').count(),nativeCssBoundary:await pw.locator('#panel #shadow-save').count(),role:await panel.getByRole('button',{name:'Save',exact:true}).count(),label:await pw.getByLabel('Shadow field',{exact:true}).count(),placeholder:await pw.getByPlaceholder('Type here',{exact:true}).count(),testId:await pw.getByTestId('deep').count(),text:await pw.getByText('Deep action',{exact:true}).count(),ariaLocal:await pw.getByRole('button',{name:'Shadow label',exact:true}).count(),ariaWrong:await panel.getByRole('button',{name:'Wrong document label',exact:true}).count(),slot:await pw.getByRole('button',{name:'Slotted label',exact:true}).count(),fallback:await pw.getByText('Fallback should not match',{exact:true}).count(),unassigned:await pw.getByRole('button',{name:'Unassigned secret action',exact:true}).count(),closed:await pw.locator('#closed-secret').count(),nestedClosed:await pw.locator('#nested-secret').count(),has:await pw.locator('#panel').filter({has:pw.getByTestId('deep')}).count(),hasText:await panel.filter({hasText:'Deep action'}).count(),and:await pw.getByTestId('save').and(pw.getByRole('button',{name:'Save',exact:true})).count(),frameLeak:await pw.getByRole('button',{name:'Frame action',exact:true}).count()};
let ambiguous;try{await pw.getByRole('button',{name:'Save',exact:true}).click({timeoutMs:800});}catch(e){ambiguous=e.code;}
await panel.getByRole('button',{name:'Save',exact:true}).click();
await panel.getByTestId('deep').dblclick();
await pw.getByRole('button',{name:'Slotted label',exact:true}).click();
const chosen=await pw.getByRole('button',{name:'Save',exact:true}).nth(2).getAttribute('id');
const first=await pw.getByRole('button',{name:'Save',exact:true}).first().getAttribute('id'),last=await pw.getByRole('button',{name:'Save',exact:true}).last().getAttribute('id');
const field=pw.getByLabel('Shadow field',{exact:true});await field.fill('hello');await field.press('End');await field.pressSequentially('12');await field.type('x');
const input=await field.evaluate('n=>({value:n.value,focused:n.getRootNode().activeElement===n})');
const check=pw.getByLabel('Accept shadow',{exact:true});await check.check();const checked=await check.evaluate('n=>n.checked');await check.uncheck();const unchecked=await check.evaluate('n=>n.checked');await check.setChecked(true);const finalChecked=await check.evaluate('n=>n.checked');
const choice=await pw.getByLabel('Shadow choice',{exact:true}).selectOption('b');
const disabled=await pw.locator('#disabled').isEnabled();let blockedDisabled;try{await pw.locator('#disabled').click({timeoutMs:450});}catch(e){blockedDisabled=e.code;}
const state=await tab.evaluate('({clicks:window.clicks,inputs:window.inputs})');
return {ids,order,counts,ambiguous,chosen,first,last,input,checked,unchecked,finalChecked,choice,disabled,blockedDisabled,state};`,{base:f.base},{timeoutMs:90000});
  const data=view.result.data;
  assert.deepEqual(data.ids,['plain-save','shadow-save','other-save']);
  assert.deepEqual(data.order,data.ids);
  assert.deepEqual(data.counts,{css:1,nativeCssBoundary:0,role:1,label:1,placeholder:1,testId:1,text:1,ariaLocal:1,ariaWrong:0,slot:1,fallback:0,unassigned:0,closed:0,nestedClosed:0,has:1,hasText:1,and:1,frameLeak:0});
  assert.equal(data.ambiguous,'AMBIGUOUS_TARGET');
  assert.equal(data.chosen,'other-save');assert.equal(data.first,'plain-save');assert.equal(data.last,'other-save');
  assert.deepEqual(data.input,{value:'hello12x',focused:true});
  assert.equal(data.checked,true);assert.equal(data.unchecked,false);assert.equal(data.finalChecked,true);assert.deepEqual(data.choice,['b']);
  assert.equal(data.disabled,false);assert.equal(data.blockedDisabled,'TIMEOUT');
  assert.ok(data.state.clicks.some(e=>e.id==='shadow-save'&&e.trusted));
  assert.equal(data.state.clicks.filter(e=>e.id==='deep'&&e.trusted).length,2);
  assert.ok(data.state.clicks.some(e=>['slotted','assigned-label'].includes(e.id)&&e.trusted));
  assert.ok(data.state.inputs.some(e=>e.id==='field'&&e.composed));
  assert.ok(!data.state.clicks.some(e=>['plain-save','other-save','disabled','unassigned'].includes(e.id)));
  const cleanup=await f.cleanupFacts();assert.deepEqual(cleanup.owned,[],JSON.stringify(cleanup));
});

test('native shadow hit tests reject both outer and inner overlays, fixed references and lost focus', {timeout:120000}, async t=>{
  const f=await fixture(t);
  const view=await f.run(select+`
const pw=tab.playwright,button=pw.getByTestId('save'),field=pw.getByLabel('Shadow field',{exact:true});
const failures=[];for(const inner of [false,true]){
await tab.evaluate('inner=>{const root=document.querySelector("#panel").shadowRoot,b=root.querySelector("#shadow-save"),r=b.getBoundingClientRect(),overlay=document.createElement("div");overlay.id="cover";overlay.style.cssText="position:fixed;z-index:2147483000;background:rgba(0,0,0,.2);left:"+r.x+"px;top:"+r.y+"px;width:"+r.width+"px;height:"+r.height+"px";(inner?root:document.body).append(overlay);return true}',inner);
try{await button.click({timeoutMs:450});failures.push(null);}catch(e){failures.push(e.code);}
await tab.evaluate('inner=>{(inner?document.querySelector("#panel").shadowRoot:document).querySelector("#cover").remove();return true}',inner);}
const before=await tab.evaluate('window.clicks.length');await button.click();
const observed=await button.evaluate('n=>{const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}');const info=await pw.elementInfo(observed);const screenshot=await pw.elementScreenshot(observed);
const old=(await pw.locator('#replace').all())[0];await tab.evaluate('()=>{const root=document.querySelector("#panel").shadowRoot,n=root.querySelector("#replace");const next=n.cloneNode(true);next.textContent="New element";n.replaceWith(next);setTimeout(()=>{const b=document.createElement("button");b.id="delayed";b.textContent="Delayed";root.append(b);},150);return true}');let stale;try{await old.click({timeoutMs:450});}catch(e){stale=e.code;}
await pw.locator('#delayed').waitFor({state:'visible'});await tab.waitFor({kind:'text',value:'Delayed'});const fresh=await pw.locator('#replace').textContent();
await field.fill('');await tab.evaluate('()=>{const r=document.querySelector("#panel").shadowRoot;r.querySelector("#field").addEventListener("keydown",()=>r.querySelector("#wrong").focus(),{once:true});return true}');let lost;try{await field.pressSequentially('xy');}catch(e){lost=e.code;}const wrong=await pw.locator('#wrong').evaluate('n=>n.value');
const semantic=await tab.semanticSnapshot();return {failures,before,info:info[0]?.preview,screenshotBytes:screenshot.byteLength,stale,fresh,lost,wrong,semantic};`,{base:f.base},{timeoutMs:90000});
  const data=view.result.data;
  // The existing Host deadline can expire before the inner pending-reason
  // projection. This matches the normal-DOM native timeout contract.
  assert.deepEqual(data.failures,['TIMEOUT','TIMEOUT']);assert.equal(data.before,0);
  assert.match(data.info,/shadow-save/);assert.ok(data.screenshotBytes>0);
  assert.equal(data.stale,'STALE_REF');assert.equal(data.fresh,'New element');assert.equal(data.lost,'STALE_REF');assert.ok(!data.wrong.includes('y'));
  assert.equal(data.semantic.nodes.find(n=>n.attributes?.id==='shadow-save').locatorSupported,undefined);
  assert.ok(data.semantic.warnings.includes('shadow_content_unavailable'));
  assert.doesNotMatch(JSON.stringify(data.semantic),/CLOSED_SECRET|NESTED_SECRET|closed-secret|nested-secret/);
  assert.deepEqual((await f.cleanupFacts()).owned,[]);
});

test('native same-origin and cross-origin frame owners inside open Shadow DOM preserve true frame identity', {timeout:120000}, async t=>{
  const f=await fixture(t);
  const view=await f.run(select+`
const pw=tab.playwright,results=[];
for(const id of ['local-frame','cross-frame']){const frame=pw.frameLocator('#'+id),button=frame.getByRole('button',{name:'Frame action',exact:true});await button.waitFor({state:'visible'});await button.click();const field=frame.getByLabel('Frame field',{exact:true});await field.fill('frame');await field.press('End');await field.pressSequentially('!');results.push({id,clicked:await button.getAttribute('data-clicked'),value:await field.evaluate('n=>n.value'),count:await frame.locator('#frame-action').count()});}
const semantic=await tab.semanticSnapshot();
await tab.evaluate('()=>{const other=document.querySelector("#other").shadowRoot,f=document.createElement("iframe");f.id="local-frame";other.append(f);return true}');let ambiguousFrame;try{await pw.frameLocator('#local-frame').locator('#frame-action').count();}catch(e){ambiguousFrame=e.code;}
return {results,frames:semantic.nodes.filter(n=>n.frameSelector).map(n=>({id:n.attributes?.id,selector:n.frameSelector})),nested:semantic.nodes.filter(n=>n.attributes?.id==='frame-action').length,ambiguousFrame};`,{base:f.base},{timeoutMs:90000});
  assert.deepEqual(view.result.data.results,[{id:'local-frame',clicked:'true',value:'frame!',count:1},{id:'cross-frame',clicked:'true',value:'frame!',count:1}]);
  assert.deepEqual(view.result.data.frames.map(n=>n.id).sort(),['cross-frame','local-frame']);
  assert.equal(view.result.data.nested,2);assert.equal(view.result.data.ambiguousFrame,'AMBIGUOUS_TARGET');assert.deepEqual((await f.cleanupFacts()).owned,[]);
});

test('native shadow upload and media resolution reuse exact registered element and original bytes', {timeout:120000}, async t=>{
  const f=await fixture(t);
  const view=await f.run(select+`
const pw=tab.playwright;
const snapshot=await tab.snapshot();const pending=[snapshot.root];let input;while(pending.length){const node=pending.pop();if(node.role==='textbox'&&node.name==='Shadow upload')input=node;for(const child of node.children??[])pending.push(child);}if(!input?.ref)throw Error('No actual shadow file input ref');
await tab.setFiles(input.ref,[{name:'direct.txt',mimeType:'text/plain',data:new Uint8Array([68,69,70])}]);const direct=await pw.locator('#upload').evaluate('async n=>({name:n.files[0].name,text:await n.files[0].text()})');
const chooserWait=pw.waitForEvent('filechooser');await pw.locator('#upload').click();const chooser=await chooserWait;await chooser.setFiles([{name:'shadow.txt',mimeType:'text/plain',data:new Uint8Array([65,66,67])}]);
const attached=await pw.locator('#upload').evaluate('async n=>({name:n.files[0].name,text:await n.files[0].text()})');
const artifact=await pw.getByRole('img',{name:'Shadow image',exact:true}).downloadMedia();return {direct,attached,artifact};`,{base:f.base},{timeoutMs:90000});
  assert.deepEqual(view.result.data.direct,{name:'direct.txt',text:'DEF'});
  assert.deepEqual(view.result.data.attached,{name:'shadow.txt',text:'ABC'});
  assert.deepEqual(readFileSync(view.result.data.artifact.path),pixel);assert.deepEqual((await f.cleanupFacts()).owned,[]);
});

test('native shadow query review covers scoped slot assignments, nested distribution and native names', {timeout:120000}, async t=>{
  const f=await nativeFixture(t,{html:`<!doctype html><title>Distributed query fixture</title>
<div id="host"><button id="assigned" slot="action" data-testid="assigned">Distributed action</button><span id="second" slot="label">Actual label</span><input id="not-distributed" aria-label="Unassigned field" placeholder="Unassigned field"><button id="outside-slot" slot="elsewhere">Outside scope</button></div><div id="outside">Outside scope</div>
<script>
const host=document.getElementById('host'),r=host.attachShadow({mode:'open'});
r.innerHTML='<section id="region"><slot name="action"><button id="inactive-fallback" aria-label="Fallback action">Fallback action</button></slot><div id="nested-host"><slot name="label" slot="forwarded"></slot></div><button id="block-name"><span style="display:block">Save</span><span style="display:block">settings</span></button><button id="labelled" aria-labelledby="explicit-name">Other</button><span id="explicit-name" hidden>Hidden explicit name</span></section><slot name="elsewhere"></slot>';
r.querySelector('#nested-host').attachShadow({mode:'open'}).innerHTML='<label id="nested-label"><slot name="forwarded"></slot><input id="forwarded-input" placeholder="Forwarded input"></label>';
</script>`});
  const view=await f.run(select+`
const pw=tab.playwright,region=pw.locator('#region'),slot=region.locator('slot[name=action]');
const byRole=region.getByRole('button',{name:'Distributed action',exact:true});
const byText=region.getByText('Distributed action',{exact:true});
const before={role:await byRole.count(),text:await byText.count(),testId:await region.getByTestId('assigned').count(),css:await region.locator('#assigned').count(),slotRole:await slot.getByRole('button',{name:'Distributed action',exact:true}).count(),outside:await region.getByRole('button',{name:'Outside scope',exact:true}).count(),has:await region.filter({has:pw.getByTestId('assigned')}).count(),notHas:await region.filter({hasNot:pw.getByTestId('assigned')}).count(),label:await pw.getByLabel('Actual label',{exact:true}).count(),blockName:await pw.getByRole('button',{name:'Save settings',exact:true}).count(),explicitName:await pw.getByRole('button',{name:'Hidden explicit name',exact:true}).count(),fallbackRole:await pw.getByRole('button',{name:'Fallback action',exact:true}).count(),fallbackLabel:await pw.getByLabel('Fallback action',{exact:true}).count(),unassignedLabel:await pw.getByLabel('Unassigned field',{exact:true}).count(),unassignedPlaceholder:await pw.getByPlaceholder('Unassigned field',{exact:true}).count(),unassignedCss:await pw.locator('#not-distributed').count()};
const block=await pw.locator('#block-name').evaluate('n=>({innerText:n.innerText,textContent:n.textContent})');
const semantic=await tab.semanticSnapshot(),names=semantic.nodes.filter(n=>['block-name','labelled','forwarded-input'].includes(n.attributes?.id)).map(n=>[n.attributes.id,n.name]);
const existing=await pw.locator('#assigned').all();const fromRef=await region.filter({has:existing[0]}).count();
await tab.evaluate('()=>{document.querySelector("#assigned").slot="elsewhere";return true}');
const after={role:await byRole.count(),text:await byText.count(),css:await region.locator('#assigned').count(),ref:await region.filter({has:existing[0]}).count(),global:await pw.getByTestId('assigned').count(),fallback:await region.getByRole('button',{name:'Fallback action',exact:true}).count()};
return {before,after,fromRef,block,names};`,{base:f.base});
  t.diagnostic(JSON.stringify(view.result.data));
  assert.deepEqual(view.result.data.before,{role:1,text:1,testId:1,css:1,slotRole:1,outside:0,has:1,notHas:0,label:1,blockName:1,explicitName:1,fallbackRole:0,fallbackLabel:0,unassignedLabel:0,unassignedPlaceholder:0,unassignedCss:1});
  assert.equal(view.result.data.fromRef,1);
  assert.deepEqual(view.result.data.after,{role:0,text:0,css:0,ref:0,global:1,fallback:1});
});

test('native shadow query review preserves scoped CSS relationships, root-local name references and document identity', {timeout:120000}, async t=>{
  const f=await nativeFixture(t,{html:`<!doctype html><title>Root-local query identities</title>
<div id="label-ref">Wrong document label</div><div id="host"><button id="assigned" slot="shown">Assigned</button><button id="inactive-assigned" slot="inactive">Inactive assignment</button></div><iframe id="child" srcdoc="&lt;title&gt;Child&lt;/title&gt;"></iframe>
<script>
const r=document.getElementById('host').attachShadow({mode:'open'});
r.innerHTML='<section id="region"><slot name="shown"><slot name="inactive"></slot></slot><button id="named" aria-labelledby="label-ref">Wrong content</button><span id="label-ref" aria-label="Actual reference name">Reference content</span><button id="multi" aria-labelledby="multi suffix" aria-label="Own name">Other text</button><span id="suffix">suffix</span><button id="alt-button"><img alt="Open icon"></button><input id="moving" aria-label="Original field"><button id="restored-name"><span style="visibility:hidden">Hide<span style="visibility:visible">Shown</span></span></button></section>';
</script>`});
  const view=await f.run(select+`
const pw=tab.playwright,region=pw.locator('#region');
const names=await tab.semanticSnapshot();
const expectedNames=names.nodes.filter(n=>['named','multi','alt-button','restored-name'].includes(n.attributes?.id)).map(n=>[n.attributes.id,n.name]);
const observed={nativeRelation:await region.locator('#host > #assigned').count(),fakeRelation:await region.locator('#region #assigned').count(),scopeDirect:await region.locator(':scope > #assigned').count(),inactiveAssigned:await region.locator('#inactive-assigned').count(),inactiveSemantic:await region.getByRole('button',{name:'Inactive assignment',exact:true}).count(),refName:await pw.getByRole('button',{name:'Actual reference name',exact:true}).count(),selfName:await pw.getByRole('button',{name:'Own name suffix',exact:true}).count(),imageName:await pw.getByRole('button',{name:'Open icon',exact:true}).count(),restoredName:await pw.getByRole('button',{name:'Shown',exact:true}).count()};
const old=(await pw.locator('#moving').all())[0];const snapshot=await tab.snapshot(),field=snapshot.root.children.find(n=>n.role==='textbox'&&n.name==='Original field');
if(!field)throw Error('missing actual field identity');
await tab.evaluate('()=>{const moving=document.querySelector("#host").shadowRoot.querySelector("#moving"),child=document.querySelector("#child").contentDocument;child.body.append(child.adoptNode(moving));return true}');
let staleQuery,staleAction;try{await old.count();staleQuery='accepted';}catch(e){staleQuery=e.code;}
try{await tab.fill(field.ref,'must not write');staleAction='accepted';}catch(e){staleAction=e.code;}
const child=await pw.frameLocator('#child').locator('#moving').evaluate('n=>n.value');
return {observed,expectedNames,staleQuery,staleAction,child};`,{base:f.base});
  t.diagnostic(JSON.stringify(view.result.data));
  assert.deepEqual(view.result.data.observed,{nativeRelation:1,fakeRelation:0,scopeDirect:0,inactiveAssigned:0,inactiveSemantic:0,refName:1,selfName:1,imageName:1,restoredName:1});
  assert.equal(view.result.data.staleQuery,'STALE_REF');assert.equal(view.result.data.staleAction,'STALE_REF');assert.equal(view.result.data.child,'');
});

test('native shadow query review handles large mounted pages and deep open roots without stale query caches', {timeout:120000}, async t=>{
  const f=await nativeFixture(t,{html:`<!doctype html><title>Large open-root fixture</title><div id="bulk"></div><div id="deep-host"></div><script>
const bulk=document.getElementById('bulk'),fragment=document.createDocumentFragment();
for(let i=0;i<12000;i++){const row=document.createElement('div');row.className='row';row.textContent='Mounted row '+i;fragment.append(row);}bulk.append(fragment);
let host=document.getElementById('deep-host');for(let i=0;i<48;i++){const r=host.attachShadow({mode:'open'});const next=document.createElement('div');next.id='level-'+i;r.append(next);host=next;}
const root=host.attachShadow({mode:'open'});root.innerHTML='<label for="needle">Deep unique field</label><input id="needle" data-testid="needle" placeholder="Deep input"><button id="deep-action">Unique deep action</button>';
</script>`});
  const view=await f.run(select+`
const pw=tab.playwright,begin=Date.now();
const facts={rows:await pw.locator('#bulk').locator('.row').count(),deepCSS:await pw.locator('#needle').count(),deepLabel:await pw.getByLabel('Deep unique field',{exact:true}).count(),deepText:await pw.getByText('Unique deep action',{exact:true}).count(),testId:await pw.getByTestId('needle').count(),scoped:await pw.locator('#deep-host').filter({has:pw.getByTestId('needle')}).count()};
const elapsedMs=Date.now()-begin;
await tab.evaluate('()=>{let host=document.querySelector("#deep-host");for(let i=0;i<48;i++)host=host.shadowRoot.querySelector("#level-"+i);host.shadowRoot.querySelector("#needle").remove();const n=document.createElement("input");n.id="replacement";n.dataset.testid="needle";host.shadowRoot.append(n);return true}');
const after={old:await pw.locator('#needle').count(),replacement:await pw.getByTestId('needle').getAttribute('id')};return {facts,elapsedMs,after};`,{base:f.base},{timeoutMs:90000});
  t.diagnostic(JSON.stringify(view.result.data));
  assert.deepEqual(view.result.data.facts,{rows:12000,deepCSS:1,deepLabel:1,deepText:1,testId:1,scoped:1});
  assert.deepEqual(view.result.data.after,{old:0,replacement:'replacement'});
  assert.deepEqual((await f.cleanupFacts()).owned,[]);
});
