import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { nativeFixture, select } from "./helpers/native.mjs";

const html = `<!doctype html><html><head><title>Nexum native client</title></head><body>
<h1>Native SDK client surface</h1>
<label for="keyboard">Keyboard field</label><input id="keyboard" placeholder="Type native input"><output data-testid="keyboard-value"></output>
<label><input id="check" type="checkbox">Native checkbox</label>
<label for="pick">Native selection</label><select id="pick" multiple><option value="a">Option Alpha</option><option value="b">Option Beta</option><option value="c">Option Gamma</option></select><output data-testid="options-value"></output>
<ul id="items"><li data-testid="item-alpha" data-kind="first">Item Alpha</li><li data-kind="middle">Item Beta</li><li data-kind="last">Item Gamma</li></ul><button onclick="for(const item of [...document.querySelectorAll('#items li')].reverse())document.querySelector('#items').append(item)">Reverse items</button><button onclick="document.querySelector('[data-testid=item-alpha]')?.remove()">Remove Alpha</button>
<button id="disabled" disabled>Disabled button</button><span id="hidden" hidden>Hidden native</span>
<button id="double" ondblclick="document.querySelector('#double-count').textContent=String(Number(document.querySelector('#double-count').textContent)+1)">Double native</button><output data-testid="double-count" id="double-count">0</output>
<input type="file" id="uploads" aria-label="Native attachments" multiple><output id="uploaded" data-testid="uploaded">No attachments</output>
<script>document.querySelector('#keyboard').addEventListener('input',event=>document.querySelector('[data-testid=keyboard-value]').textContent=event.target.value);document.querySelector('#pick').addEventListener('change',event=>document.querySelector('[data-testid=options-value]').textContent=JSON.stringify([...event.target.selectedOptions].map(option=>option.value)));document.querySelector('#uploads').addEventListener('change',async(event)=>{const files=await Promise.all([...event.target.files].map(async(file)=>({name:file.name,size:file.size,type:file.type,length:(await file.text()).length})));document.querySelector('#uploaded').textContent=JSON.stringify(files);});</script>
</body></html>`;

test(
  "native Locator queries, combinations, keyboard, checkbox and selection change actual DOM state",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
 const pw=tab.playwright;
 const input=pw.getByLabel("Keyboard field",{exact:true});
 await input.fill("start");await input.press("End");await input.pressSequentially(" words");await input.type(" plus");
 const typed=await input.evaluate("element => element.value");
 await input.press("ControlOrMeta+A");await input.press("Backspace");await input.pressSequentially("Native final");
 const final=await pw.getByPlaceholder("Type native input",{exact:true}).evaluate("element => element.value");
 const items=pw.locator("#items li"),all=await items.all();
 const observed={count:await items.count(),texts:await items.allTextContents(),first:await items.first().innerText(),last:await items.last().textContent(),middle:await items.nth(1).innerText(),snapshots:await Promise.all(all.map(item=>item.innerText())),filtered:await items.filter({hasText:/Item Beta/}).count(),and:await items.and(pw.getByText("Item Alpha",{exact:true})).count(),or:await pw.getByTestId("item-alpha").or(items.last()).count(),kinds:await items.evaluateAll("elements => elements.map(element => element.dataset.kind)")};
 await pw.getByRole("checkbox",{name:"Native checkbox",exact:true}).check();
 const checked=await pw.locator("#check").evaluate("element => element.checked");await pw.locator("#check").uncheck();await pw.locator("#check").setChecked(true);
 const rechecked=await pw.locator("#check").evaluate("element => element.checked");
 await pw.getByLabel("Native selection").selectOption([{label:"Option Beta"},{value:"c"}]);
 const options=await pw.locator("#pick").evaluate("element => Array.from(element.selectedOptions, option => option.value)");
 await pw.getByRole("button",{name:"Double native",exact:true}).dblclick();
 await pw.locator("#hidden").waitFor({state:"hidden"});
 return {typed,final,observed,checked,rechecked,options,disabled:await pw.getByRole("button",{name:"Disabled button"}).isEnabled(),hidden:await pw.locator("#hidden").isVisible(),double:await pw.getByTestId("double-count").innerText()};
 `,
      { base: f.base },
    );
    const value = result.result.data;
    assert.equal(value.typed, "start words plus");
    assert.equal(value.final, "Native final");
    assert.deepEqual(value.observed, {
      count: 3,
      texts: ["Item Alpha", "Item Beta", "Item Gamma"],
      first: "Item Alpha",
      last: "Item Gamma",
      middle: "Item Beta",
      snapshots: ["Item Alpha", "Item Beta", "Item Gamma"],
      filtered: 1,
      and: 1,
      or: 2,
      kinds: ["first", "middle", "last"],
    });
    assert.equal(value.checked, true);
    assert.equal(value.rechecked, true);
    assert.deepEqual(value.options, ["b", "c"]);
    assert.equal(value.disabled, false);
    assert.equal(value.hidden, false);
    assert.equal(value.double, "1");
  },
);

test(
  "native Frame and nested FrameLocator operate inside a cross-site OOPIF using high-level methods",
  { timeout: 120000 },
  async (t) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        request.url === "/nested"
          ? `<!doctype html><html><body><label for="nested-input">Nested Name</label><input id="nested-input"><button onclick="document.querySelector('#nested-answer').textContent=document.querySelector('#nested-input').value">Apply nested</button><p id="nested-answer" data-testid="nested-answer">Nested waiting</p></body></html>`
          : `<!doctype html><html><body><label for="frame-input">Frame Name</label><input id="frame-input"><button onclick="document.querySelector('#frame-answer').textContent=document.querySelector('#frame-input').value">Apply frame</button><p id="frame-answer" data-testid="frame-answer">Frame waiting</p><iframe id="nested" src="/nested"></iframe></body></html>`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const child = `http://localhost:${server.address().port}/outer`,
      f = await nativeFixture(t, {
        html: `<!doctype html><html><head><title>Native iframe acceptance</title></head><body><h1>Main origin</h1><iframe id="cross" src="${child}"></iframe></body></html>`,
      });
    const result = await f.run(
      select +
        `
 const outer=tab.playwright.frameLocator("#cross");
 await outer.getByRole("textbox",{name:"Frame Name",exact:true}).fill("FrameLocator native");
 await outer.getByRole("button",{name:"Apply frame",exact:true}).click();
 const first=await outer.getByTestId("frame-answer").innerText();
 const frame=await tab.frame("#cross"),snapshot=await frame.snapshot();
 const nodes=[];const visit=node=>{nodes.push(node);for(const child of node.children??[])visit(child);};visit(snapshot.root);
 const textbox=nodes.find(node=>node.role==="textbox"&&node.name==="Frame Name");if(!textbox)throw Error("Frame snapshot did not expose the native textbox ref");
 await frame.fill(textbox.ref,"Frame ref native");await frame.getByRole("button",{name:"Apply frame",exact:true}).click();
 const second=await frame.getByTestId("frame-answer").innerText();
 const nested=outer.frameLocator("#nested");await nested.getByLabel("Nested Name",{exact:true}).fill("Nested native");await nested.getByRole("button",{name:"Apply nested",exact:true}).click();await nested.getByText("Nested native",{exact:true}).waitFor({state:"visible",timeoutMs:1500});
 const third=await nested.getByTestId("nested-answer").innerText();
 // CDP is observation only here: all content actions above use Frame/FrameLocator/Locator SDK methods.
 const nativeTargets=await tab.cdp.readEvents({afterSequence:0,methods:["Target.attachedToTarget"],limit:20});
 return {first,second,third,frameUrl:snapshot.url,oopif:nativeTargets.events.some(event=>event.params?.targetInfo?.type==="iframe"&&event.params.targetInfo.url===context.input.child)};
 `,
      { base: f.base, child },
    );
    if (result.result.data.frameFailure)
      assert.fail(JSON.stringify(result.result.data.frameFailure));
    assert.deepEqual(result.result.data, {
      first: "FrameLocator native",
      second: "Frame ref native",
      third: "Nested native",
      frameUrl: child,
      oopif: true,
    });
  },
);

test(
  "native file chooser accepts multiple path/byte attachments and a failed preflight leaves selection unchanged",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html }),
      local = path.join(f.root, "native-attachment.txt");
    writeFileSync(local, "from native path");
    const result = await f.run(
      select +
        `
 const input=tab.playwright.getByLabel("Native attachments",{exact:true}),read=()=>tab.playwright.getByTestId("uploaded").innerText();
 const waiting=tab.playwright.waitForEvent("filechooser");await input.click();const chooser=await waiting;
 if(!chooser.isMultiple())throw Error("Native multiple file input lost its multiple fact");
 await chooser.setFiles([{path:context.input.local,name:"path-note.txt",mimeType:"text/plain"},{data:new Uint8Array(150000).fill(66),name:"native-note.txt",mimeType:"text/plain"}]);
 const expected=JSON.stringify([{name:"path-note.txt",size:16,type:"text/plain",length:16},{name:"native-note.txt",size:150000,type:"text/plain",length:150000}]);
 await tab.playwright.getByText(expected,{exact:true}).waitFor({state:"visible"});const first=await read();
 const again=tab.playwright.waitForEvent("filechooser");await input.click();const second=await again;let failure;
 try{await second.setFiles([{path:context.input.local,name:"first.txt"},{path:context.input.missing,name:"missing.txt"}]);}catch(error){failure=error.code;}
 const unchanged=await read();await second.setFiles([{data:new Uint8Array([82,69,84,82,89]),name:"retry.txt",mimeType:"text/plain"}]);
 await tab.playwright.getByText(JSON.stringify([{name:"retry.txt",size:5,type:"text/plain",length:5}]),{exact:true}).waitFor({state:"visible"});
 return {first,unchanged,failure,retry:await read()};
 `,
      {
        base: f.base,
        local,
        missing: path.join(f.root, "missing-attachment.txt"),
      },
    );
    const expected = [
      { name: "path-note.txt", size: 16, type: "text/plain", length: 16 },
      {
        name: "native-note.txt",
        size: 150000,
        type: "text/plain",
        length: 150000,
      },
    ];
    assert.deepEqual(JSON.parse(result.result.data.first), expected);
    assert.equal(result.result.data.unchanged, result.result.data.first);
    assert.equal(result.result.data.failure, "ENOENT");
    assert.deepEqual(JSON.parse(result.result.data.retry), [
      { name: "retry.txt", size: 5, type: "text/plain", length: 5 },
    ]);
  },
);

test(
  "native window/tab/group/bookmark management exposes and changes actual isolated browser state",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
 const management=selected.management,created=await management.windows.create({focused:false,width:800,height:600});
 const windows=await selected.windows.getAll({populate:true});const initialTabs=await management.tabs.query({windowId:created.id});if(initialTabs.length!==1)throw Error("Native created window did not contain one tab");
 const extra=await selected.tabs.new(context.input.base+"#managed",{active:false});await management.tabs.move(extra.id,{windowId:created.id,index:-1});
 const group=await management.tabs.group({tabIds:[initialTabs[0].tabId,extra.id],createProperties:{windowId:created.id}});await management.tabGroups.update(group.groupId,{title:"Native group",color:"blue",collapsed:false});
 const observedGroup=await management.tabGroups.get(group.groupId),groups=await selected.tabGroups.query({title:"Native group"});await management.tabGroups.move(group.groupId,{index:0});await management.tabs.ungroup([extra.id]);
 await management.tabs.update(extra.id,{pinned:true});const pinned=await management.tabs.query({windowId:created.id,pinned:true});const moved=await management.tabs.get(extra.id);
 const folder=await management.bookmarks.create({title:"Nexum native folder"}),destination=await management.bookmarks.create({title:"Nexum native destination"});
 const bookmark=await management.bookmarks.create({parentId:folder.id,title:"Native bookmark",url:context.input.base});await management.bookmarks.update(bookmark.id,{title:"Native updated bookmark"});await management.bookmarks.move(bookmark.id,{parentId:destination.id,index:0});
 const found=await management.bookmarks.search("Native updated bookmark"),tree=await management.bookmarks.getTree();const flattened=[];const visit=node=>{flattened.push(node);for(const child of node.children??[])visit(child);};for(const node of tree)visit(node);
 await management.bookmarks.remove(bookmark.id);await management.bookmarks.remove(folder.id);await management.bookmarks.remove(destination.id);const removed=await management.bookmarks.search("Native updated bookmark");
 const audit=await management.getAuditTrail({limit:100});await extra.close();await management.tabs.close(initialTabs[0].tabId);const after=await management.windows.list();
 return {createdObserved:windows.some(value=>value.id===created.id),group:{title:observedGroup.title,color:observedGroup.color,found:groups.some(value=>value.id===group.groupId)},pinned:pinned.some(value=>value.tabId===extra.id),moved:moved.windowId===created.id,bookmark:found.some(value=>value.id===bookmark.id&&value.parentId===destination.id),tree:flattened.some(value=>value.id===bookmark.id),removed:removed.length,windowClosed:!after.some(value=>value.id===created.id),auditNamespaces:[...new Set(audit.changes.map(value=>value.namespace))].sort()};
 `,
      { base: f.base },
    );
    assert.deepEqual(result.result.data, {
      createdObserved: true,
      group: { title: "Native group", color: "blue", found: true },
      pinned: true,
      moved: true,
      bookmark: true,
      tree: true,
      removed: 0,
      windowClosed: true,
      auditNamespaces: ["bookmarks", "tabGroups", "tabs", "windows"],
    });
  },
);

test(
  "native Dialog descriptors accept prompts, dismiss confirmations and reject consumed identities",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
 // Normal high-level navigation establishes native page observation; no raw CDP action is used.
 await tab.navigate(context.input.base+"?dialogs=1");
 const dialog=async()=>{const end=Date.now()+5000;while(Date.now()<end){const value=await tab.getJsDialog();if(value)return value;await tab.playwright.waitForTimeout(10);}throw Error("Native dialog was not observed");};
 await tab.playwright.evaluate("() => {setTimeout(()=>{window.nativePrompt=prompt('Native prompt','seed');},20);return true;}");
 const prompt=await dialog();if(prompt.type!=="prompt")throw Error("Expected native prompt");await prompt.accept("Accepted native");
 const prompted=await tab.playwright.evaluate("() => window.nativePrompt");let consumed;
 try{await prompt.accept("Must not reopen");}catch(error){consumed=error.code;}
 await tab.playwright.evaluate("() => {setTimeout(()=>{window.nativeConfirm=confirm('Native confirm');},20);return true;}");
 const confirm=await dialog();if(confirm.type!=="confirm")throw Error("Expected native confirm");await confirm.dismiss();
 const confirmed=await tab.playwright.evaluate("() => window.nativeConfirm");
 await tab.playwright.evaluate("() => {setTimeout(()=>{alert('Native alert');window.nativeAlertClosed=true;},20);return true;}");
 const alert=await dialog();if(alert.type!=="alert")throw Error("Expected native alert");await alert.dismiss();
 const alerted=await tab.playwright.evaluate("() => window.nativeAlertClosed");
 return {prompted,confirmed,alerted,consumed,messages:[prompt.message,confirm.message,alert.message],remaining:(await tab.getJsDialog())!==undefined};
 `,
      { base: f.base },
    );
    assert.deepEqual(result.result.data, {
      prompted: "Accepted native",
      confirmed: false,
      alerted: true,
      consumed: "STALE_REF",
      messages: ["Native prompt", "Native confirm", "Native alert"],
      remaining: false,
    });
  },
);

test(
  "native registered Locator state/metadata and held all() refs remain accurate through actual keyboard and DOM mutations",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
 const pw=tab.playwright,input=pw.getByLabel("Keyboard field",{exact:true});await input.fill("start");await input.press("End");await input.pressSequentially(" words");await input.type(" plus");
 const typed=await pw.getByTestId("keyboard-value").innerText();await input.press("ControlOrMeta+A");await input.press("Backspace");await input.pressSequentially("Native final");const final=await pw.getByTestId("keyboard-value").innerText();
 const items=pw.locator("#items li"),held=await items.all(),initial=await items.allTextContents();
 const facts={count:await items.count(),first:await items.first().innerText(),last:await items.last().textContent(),middle:await items.nth(1).innerText(),filtered:await items.filter({hasText:/Item Beta/}).count(),and:await items.and(pw.getByText("Item Alpha",{exact:true})).count(),or:await pw.getByTestId("item-alpha").or(items.last()).count(),attribute:await items.first().getAttribute("data-kind"),missing:await items.first().getAttribute("data-absent"),placeholder:await pw.getByPlaceholder("Type native input").getAttribute("placeholder")};
 const checked=async()=>{const snapshot=await tab.snapshot(),nodes=[];const visit=node=>{nodes.push(node);for(const child of node.children??[])visit(child);};visit(snapshot.root);return nodes.find(node=>node.role==="checkbox"&&node.name==="Native checkbox")?.checked;};
 await pw.getByRole("checkbox",{name:"Native checkbox"}).check();const on=await checked();await pw.locator("#check").uncheck();const off=await checked();await pw.locator("#check").setChecked(true);const again=await checked();
 await pw.getByLabel("Native selection").selectOption([{label:"Option Beta"},{value:"c"}]);const options=await pw.getByTestId("options-value").innerText();
 await pw.getByRole("button",{name:"Double native",exact:true}).dblclick();await pw.getByText("1",{exact:true}).waitFor({state:"visible"});
 await pw.getByRole("button",{name:"Reverse items",exact:true}).click();const reordered=await items.allTextContents(),fixed=await Promise.all(held.map(item=>item.innerText()));
 await pw.getByRole("button",{name:"Remove Alpha",exact:true}).click();await pw.getByTestId("item-alpha").waitFor({state:"detached"});let stale;try{await held[0].innerText();}catch(error){stale=error.code;}
 await pw.locator("#hidden").waitFor({state:"hidden"});
 return {typed,final,initial,facts,on,off,again,options,reordered,fixed,stale,disabled:await pw.getByRole("button",{name:"Disabled button"}).isEnabled(),hidden:await pw.locator("#hidden").isVisible(),double:await pw.getByTestId("double-count").innerText()};
 `,
      { base: f.base },
    );
    assert.deepEqual(result.result.data, {
      typed: "start words plus",
      final: "Native final",
      initial: ["Item Alpha", "Item Beta", "Item Gamma"],
      facts: {
        count: 3,
        first: "Item Alpha",
        last: "Item Gamma",
        middle: "Item Beta",
        filtered: 1,
        and: 1,
        or: 2,
        attribute: "first",
        missing: null,
        placeholder: "Type native input",
      },
      on: true,
      off: false,
      again: true,
      options: '["b","c"]',
      reordered: ["Item Gamma", "Item Beta", "Item Alpha"],
      fixed: ["Item Alpha", "Item Beta", "Item Gamma"],
      stale: "STALE_REF",
      disabled: false,
      hidden: false,
      double: "1",
    });
  },
);
