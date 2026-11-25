import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, select } from "./helpers/native.mjs";

const html = `<!doctype html><html><head><title>Semantic user management</title></head><body>
<nav><a href="/users?token=URL_SECRET#secret" aria-current="page">Users</a></nav>
<main id="user-management"><h1>Users</h1><form id="search-form">
<label for="username">Username</label><input id="username" name="username" placeholder="Enter username" value="initial" required>
<label for="status">Status</label><select id="status" name="status"><option value="all">All</option><option value="active">Active</option><option value="disabled">Disabled</option></select>
<input id="remember" type="checkbox"><input id="password" type="password" value="PASSWORD_SECRET"><input id="hidden" type="hidden" value="HIDDEN_SECRET"><input id="api-token" value="TOKEN_SECRET">
<button type="button" id="search-btn" disabled>Search</button></form>
<div class="flex items-center px-4"><button data-testid="add-user">Add user</button></div>
<table id="user-table"><thead><tr><th>Username</th><th>Action</th></tr></thead><tbody>
<tr data-user-id="101" class="user-row flex" data-auth-token="ATTR_SECRET"><td>Alice</td><td><button id="edit-a">Edit</button></td></tr>
<tr data-user-id="102" class="user-row"><td>Bob</td><td><button>Edit</button></td></tr></tbody></table>
<div hidden>HIDDEN_TEXT</div><details><summary>Details</summary><p>CLOSED_DETAIL</p></details>
<div id="editor" contenteditable="true">Editable text</div><div id="open-shadow"></div><div id="closed-shadow"></div>
<iframe id="cross-frame"></iframe><iframe id="inner" srcdoc="&lt;!doctype html&gt;&lt;title&gt;Inner&lt;/title&gt;&lt;button id='inner-action'&gt;Inner action&lt;/button&gt;"></iframe>
</main><script>
document.querySelector('#cross-frame').src=location.origin.replace('127.0.0.1','localhost')+'/cross';
document.querySelector('#username').value='live-value'; document.querySelector('#status').value='active'; document.querySelector('#remember').checked=true;
document.querySelector('#open-shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-action">Shadow action</button>';
document.querySelector('#closed-shadow').attachShadow({mode:'closed'}).innerHTML='<button id="closed-secret">CLOSED_SHADOW_SECRET</button>';
</script></body></html>`;

test("native semantic observation fuses DOM and AX, current state, frame/shadow boundaries and native image", {timeout:120000}, async t => {
  const f = await nativeFixture(t,{html,handleRequest(req,res){if(req.url!=="/cross")return false;res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end('<!doctype html><title>Cross frame</title><button id="cross-action">Cross action</button>');return true;}});
  const result = await f.run(select + `
    await tab.playwright.frameLocator('iframe#cross-frame').getByRole('button',{name:'Cross action',exact:true}).waitFor({state:'visible'});
    const snapshot=await tab.semanticSnapshot();
    const {formatSemanticObservation}=await import('@nexum-hub/browser');
    return {snapshot,text:formatSemanticObservation(snapshot)};
  `,{base:f.base});
  const {snapshot,text} = result.result.data;
  t.diagnostic(text.slice(0,5000));
  assert.equal(snapshot.title,"Semantic user management");
  assert.equal(snapshot.url,f.base);
  const byId = id=>snapshot.nodes.find(n=>n.attributes?.id===id);
  assert.equal(byId("username").states.value,"live-value");
  assert.equal(byId("username").name,"Username");
  assert.equal(byId("status").states.value,"active");
  assert.equal(byId("remember").states.checked,true);
  assert.equal(byId("search-btn").states.disabled,true);
  assert.equal(byId("password").states.valueRedacted,true);
  assert.equal(byId("api-token").states.valueRedacted,true);
  assert.equal(byId("editor").states.contenteditable,true);
  assert.equal(byId("edit-a").role,"button");
  assert.equal(byId("inner-action").role,"button");
  assert.equal(byId("cross-action").role,"button");
  assert.match(byId("cross-frame").frameSelector,/cross-frame/);
  assert.equal(snapshot.nodes.find(n=>n.tag==="a").states.hrefRedacted,true);
  assert.ok(snapshot.nodes.some(n=>n.tag==="#shadow-root"&&n.attributes?.mode==="closed"));
  assert.ok(snapshot.warnings.includes("shadow_content_unavailable"));
  assert.match(byId("inner").frameSelector,/inner/);
  assert.ok(snapshot.nodes.some(n=>n.tag==="#shadow-root"&&n.attributes?.mode==="open"));
  assert.notEqual(byId("shadow-action").locatorSupported,false);
  assert.ok(!snapshot.warnings.includes("shadow_locator_unsupported"));
  assert.doesNotMatch(JSON.stringify(snapshot),/PASSWORD_SECRET|HIDDEN_SECRET|TOKEN_SECRET|URL_SECRET|ATTR_SECRET|HIDDEN_TEXT|CLOSED_DETAIL|CLOSED_SHADOW_SECRET/);
  assert.match(text,/tr\.user-row.*data-user-id="101"/);
  assert.match(text,/button.*"Add user".*data-testid="add-user"/);
  assert.doesNotMatch(text,/px-4|items-center|backendNodeId|\bref=/);
  const action = await f.run(select+`const row=tab.playwright.getByRole('row').filter({hasText:'Alice'});const edit=row.getByRole('button',{name:'Edit',exact:true});return {count:await edit.count(),frameCount:await tab.playwright.frameLocator('iframe#inner').getByRole('button',{name:'Inner action',exact:true}).count()};`,{base:f.base});
  assert.deepEqual(action.result.data,{count:1,frameCount:1});
  const named = async (screenshot) => {
    let view = await f.start(undefined,{browserId:f.browserId,tabId:snapshot.target.tabId,screenshot},{scriptName:"browser/observe.js",waitMs:1000});
    const deadline=Date.now()+60000;
    while(view.run.endedAt===null){assert.ok(Date.now()<deadline);view=await f.observe(view.run.runId,100);}
    assert.equal(view.run.status,"succeeded",JSON.stringify(view.run.error));
    return view;
  };
  const textOnly=await named(false);
  assert.deepEqual(textOnly.result.content.map(x=>x.type),["text"]);
  assert.match(textOnly.result.content[0].text,/Semantic DOM/);
  const combined=await named(true);
  assert.deepEqual(combined.result.content.map(x=>x.type),["text","image"]);
  assert.match(combined.result.content[0].text,/live-value/);
  const rendered=await f.encoder.render(combined.result,f.resultScope(),combined.run);
  const image=rendered.content.find(x=>x.type==="image");
  assert.ok(image?.data);assert.equal(image.mimeType,"image/jpeg");
});
