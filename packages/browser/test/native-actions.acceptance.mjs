import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeFixture, select } from "./helpers/native.mjs";

const interactive = `<!doctype html><html><head><title>Native action families</title><style>body{margin:8px}#pad{width:240px;height:70px;background:lightblue}#scroll{width:240px;height:80px;overflow:auto}#inside{height:600px}#spacer{height:1500px}</style></head><body>
<label for="field">Action field</label><input id="field" value="initial"><button id="button" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)" ondblclick="this.dataset.doubles=String(Number(this.dataset.doubles||0)+1)">Action button</button>
<div id="pad">Native drag surface</div><div id="scroll" tabindex="0"><div id="inside">Scrollable native content</div></div><div id="spacer"></div>
<script>const pad=document.querySelector('#pad');pad.onpointerdown=event=>{pad.setPointerCapture(event.pointerId);pad.dataset.start=event.clientX;};pad.onpointerup=event=>{pad.dataset.end=event.clientX;pad.dataset.drags=String(Number(pad.dataset.drags||0)+1);};</script></body></html>`;

test("native AX, CUA and fixed DOM actions change real controls and preserve native input semantics", async (t) => {
  const f = await nativeFixture(t, { html: interactive });
  const result = await f.run(
    select +
      `
    const read=expression=>tab.evaluate(expression);
    const point=async selector=>read("(()=>{const r=document.querySelector("+JSON.stringify(selector)+").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    const snapshot=await tab.ax.snapshot(),field=snapshot.nodes.find(node=>node.role==='textbox'&&node.name==='Action field'),button=snapshot.nodes.find(node=>node.role==='button'&&node.name==='Action button');
    if(!field||!button)throw Error('The actual AX targets were not observed');
    await tab.ax.setValue(field.index,'Initial AX');
    await tab.ax.selectText(field.index,'Initial');
    const selection=await read("(()=>{const e=document.querySelector('#field');return e.value.slice(e.selectionStart,e.selectionEnd);})()");
    await tab.ax.pressKey(field.index,'End');await tab.ax.typeText(field.index,' tail');
    const axValue=await read("document.querySelector('#field').value");
    await tab.ax.click(button.index);await tab.ax.click(await point('#button'));
    const axImage=await tab.ax.get('both');
    await tab.cua.click(await point('#field'));await tab.cua.keypress({keys:['ControlOrMeta','A']});await tab.cua.type({text:'Native CUA'});
    await tab.cua.doubleClick(await point('#button'));
    const pad=await point('#pad');await tab.cua.drag({path:[{x:pad.x-50,y:pad.y},{x:pad.x,y:pad.y+5},{x:pad.x+50,y:pad.y}]});
    await tab.ax.drag({x:pad.x-40,y:pad.y},{x:pad.x+40,y:pad.y});
    const cuaValue=await read("document.querySelector('#field').value");
    const tree=await tab.dom.getVisibleTree(),domField=tree.nodes.find(node=>node.role==='textbox'&&node.name==='Action field'),domButton=tree.nodes.find(node=>node.role==='button'&&node.name==='Action button');
    if(!domField||!domButton)throw Error('The actual fixed DOM targets were not observed');
    await tab.dom.fill(domField.nodeId,'Native DOM');await tab.dom.click({node_id:domField.nodeId});await tab.dom.keypress({keys:['End']});await tab.dom.type({text:' tail'});await tab.dom.doubleClick({node_id:domButton.nodeId});await tab.dom.click({node_id:domButton.nodeId});
    const domValue=await read("document.querySelector('#field').value");
    await tab.dom.scroll({x:0,y:90});await tab.waitFor({kind:'selector',value:'#button',state:'visible'});await tab.scroll({x:0,y:-90});
    const center=await point('#scroll');await tab.cua.scroll({x:center.x,y:center.y,scrollX:0,scrollY:100});
    await tab.playwright.locator('#scroll').evaluate('element => new Promise(resolve=>{if(element.scrollTop>0)return resolve(true);const done=()=>{element.removeEventListener("scroll",done);resolve(true);};element.addEventListener("scroll",done,{once:true});})');
    const wheel=await read("document.querySelector('#scroll').scrollTop");
    await tab.ax.scroll(center,'down',0.25);
    return {selection,axValue,cuaValue,domValue,axState:axImage.state,axImageLength:axImage.screenshot.byteLength,drags:await read("Number(document.querySelector('#pad').dataset.drags)"),clicks:await read("Number(document.querySelector('#button').dataset.clicks)"),doubles:await read("Number(document.querySelector('#button').dataset.doubles)"),wheel};`,
    { base: f.base },
  );
  const data = result.result.data;
  assert.equal(data.selection, "Initial");
  assert.equal(data.axValue, "Initial AX tail");
  assert.equal(data.cuaValue, "Native CUA");
  assert.equal(data.domValue, "Native DOM tail");
  assert.match(data.axState, /Action field/);
  assert.ok(data.axImageLength > 1000);
  assert.equal(data.drags, 2);
  assert.ok(data.clicks >= 7);
  assert.equal(data.doubles, 2);
  assert.ok(data.wheel > 0);
});

test("native fixed refs, element geometry and three media entry points use actual image bytes and reject replaced observations", async (t) => {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=",
    "base64",
  );
  const f = await nativeFixture(t, {
    html: `<!doctype html><title>Native media actions</title><label for="text">Ref field</label><input id="text"><label for="choice">Ref choice</label><select id="choice"><option value="a">Option A</option><option value="b">Option B</option></select><button id="apply" onclick="document.querySelector('#answer').textContent=document.querySelector('#text').value">Apply ref</button><output id="answer">Waiting</output><img src="/media.png" alt="Native media image" style="display:block;width:80px;height:80px"><a href="/next" id="next">Next document</a>`,
    handleRequest(req, res) {
      if (req.url !== "/media.png") return false;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(image);
      return true;
    },
  });
  const result = await f.run(
    select +
      `
    const snapshot=await tab.snapshot(),nodes=[];const visit=node=>{nodes.push(node);for(const child of node.children??[])visit(child);};visit(snapshot.root);
    const roles={'Ref field':'textbox','Ref choice':'combobox','Apply ref':'button'};const ref=name=>{const node=nodes.find(node=>node.name===name&&node.role===roles[name]);if(!node)throw Error('Native ref unavailable: '+name);return node.ref;};
    await tab.focus(ref('Ref field'));await tab.fill(ref('Ref field'),'Native fixed');await tab.press('End');await tab.keyboardDown('Shift');await tab.keyboardUp('Shift');await tab.hover(ref('Apply ref'));await tab.click(ref('Apply ref'));await tab.selectOption(ref('Ref choice'),'b');
    const answer=await tab.locator('#answer').innerText(),choice=await tab.evaluate("document.querySelector('#choice').value");const exported=await tab.content.export(),textContent=await tab.contentExport({format:'text'});
    const point=await tab.evaluate("(()=>{const r=document.querySelector('img').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    const info=await tab.playwright.elementInfo({...point,includeNonInteractable:true}),shot=await tab.playwright.elementScreenshot({...point,includeNonInteractable:true});
    const tree=await tab.dom.getVisibleTree(),nativeImage=tree.nodes.find(node=>node.role==='img'&&node.name==='Native media image');if(!nativeImage)throw Error('The actual image NodeId was not observed');
    const cua=await tab.cua.downloadMedia(point),dom=await tab.dom.downloadMedia({node_id:nativeImage.nodeId}),locator=await tab.playwright.getByRole('img',{name:'Native media image'}).downloadMedia();
    await tab.playwright.expectNavigation(()=>tab.playwright.locator('#next').click(),{url:context.input.base+'next',timeoutMs:5000});await tab.playwright.waitForLoadState({state:'load'});const next=await tab.url();let stale;try{await tab.fill(ref('Ref field'),'must not write');}catch(error){stale=error.code;}
    await tab.goBack({waitUntil:'load'});const back=await tab.url();await tab.forward({waitUntil:'load'});const forward=await tab.url();await tab.navigate(context.input.base,{waitUntil:'domcontentloaded'});await tab.reload({waitUntil:'load'});await tab.waitFor({kind:'text',value:'Ref field'});
    return {answer,choice,exported,textContent,info,shotLength:shot.byteLength,cua,dom,locator,next,back,forward,stale};`,
    { base: f.base },
  );
  const data = result.result.data;
  assert.equal(data.answer, "Native fixed");
  assert.equal(data.choice, "b");
  assert.match(readFileSync(data.exported.path, "utf8"), /Native fixed/);
  assert.match(data.textContent.data, /Native fixed/);
  assert.equal(data.textContent.truncated, false);
  assert.equal(data.info.length, 1);
  assert.equal(data.info[0].tagName.toLowerCase(), "img");
  assert.ok(data.shotLength > 100);
  for (const key of ["cua", "dom", "locator"]) {
    assert.deepEqual(readFileSync(data[key].path), image);
    assert.equal(data[key].mimeType, "image/png");
  }
  assert.equal(data.next, f.base + "next");
  assert.equal(data.back, f.base);
  assert.equal(data.forward, f.base + "next");
  assert.equal(data.stale, "STALE_REF");
});

test("native beforeunload dialogs can be dismissed and CDP cursors read actual bounded ordered events", async (t) => {
  const f = await nativeFixture(t, {
    html: '<!doctype html><title>Native beforeunload</title><button onclick="window.nativeUserActivated=true">Activate unload protection</button><script>addEventListener("beforeunload",event=>{event.preventDefault();event.returnValue="Native unload protection";});</script>',
  });
  const result = await f.run(
    select +
      `
    await tab.navigate(context.input.base+'?unload-observed');
    await tab.playwright.getByRole('button',{name:'Activate unload protection'}).click();
    await tab.playwright.evaluate("() => {setTimeout(()=>{location.href='/leaving'},20);return true;}");
    let observed;const until=Date.now()+5000;while(Date.now()<until){observed=await tab.getJsDialog();if(observed)break;await tab.playwright.waitForTimeout(10);}if(!observed)throw Error('No actual beforeunload dialog was observed');
    const dialog={type:observed.type,message:observed.message};const opened=await tab.cdp.readEvents({afterSequence:0,methods:['Page.javascriptDialogOpening'],limit:20});const nativeMessage=opened.events.at(-1)?.params?.message;await observed.dismiss();const current=await tab.url(),remaining=(await tab.getJsDialog())!==undefined;
    await tab.cdp.send('Runtime.enable');const cursor=await tab.cdp.cursor();
    const evaluated=await tab.cdp.send('Runtime.evaluate',{expression:"console.log('Native ordered event'); 7",returnByValue:true});
    const events=await tab.cdp.events(cursor),again=await tab.cdp.events(cursor),read=await tab.cdp.readEvents({afterSequence:0,limit:100,methods:['Runtime.consoleAPICalled']});
    return {dialog,nativeMessage,current,remaining,evaluated,events,again,read,browserId:selected.browserId,tabId:tab.id};`,
    { base: f.base },
  );
  const data = result.result.data;
  assert.equal(data.dialog.type, "beforeunload");
  assert.equal(typeof data.dialog.message, "string");
  // Chromium may supply an empty beforeunload message; preserve the actual native field.
  assert.equal(data.dialog.message, data.nativeMessage);
  assert.equal(data.current, f.base + "?unload-observed");
  assert.equal(data.remaining, false);
  assert.equal(data.evaluated.result.value, 7);
  const observed = data.events.events.filter(
    (event) =>
      event.method === "Runtime.consoleAPICalled" &&
      event.params.args.some((arg) => arg.value === "Native ordered event"),
  );
  assert.equal(observed.length, 1);
  assert.equal(observed[0].source.browserId, data.browserId);
  assert.equal(observed[0].source.tabId, data.tabId);
  assert.equal(
    data.again.events.some((event) => event.sequence === observed[0].sequence),
    true,
  );
  assert.equal(
    data.read.events.some((event) => event.sequence === observed[0].sequence),
    true,
  );
  assert.ok(
    data.events.events.every(
      (event, index, events) =>
        index === 0 || event.sequence > events[index - 1].sequence,
    ),
  );
  assert.equal(typeof data.events.nextCursor, "string");
  assert.equal(data.events.truncated, false);
});

test("native descendant Locator and Frame query families retain their actual scope across nested documents", async (t) => {
  const nested =
    '<label for="n">Nested scoped label</label><input id="n" placeholder="Nested scoped placeholder" data-testid="nested-input"><button onclick="document.querySelector(\'#value\').textContent=document.querySelector(\'#n\').value">Nested scoped button</button><output id="value" data-testid="nested-value">Nested waiting</output>';
  const frame =
    '<label for="f">Frame scoped label</label><input id="f" placeholder="Frame scoped placeholder" data-testid="frame-input"><button onclick="document.querySelector(\'#value\').textContent=document.querySelector(\'#f\').value">Frame scoped button</button><output id="value" data-testid="frame-value">Frame waiting</output><iframe id="nested" srcdoc="' +
    nested.replaceAll("&", "&amp;").replaceAll('"', "&quot;") +
    '"></iframe>';
  const section = (id) =>
    `<section id="scope-${id}"><label for="input-${id}">Scoped label</label><input id="input-${id}" placeholder="Scoped placeholder" data-testid="scoped-input"><button>Scoped button</button><span data-testid="scoped-text">Scoped text</span></section>`;
  const f = await nativeFixture(t, {
    html:
      "<!doctype html><title>Native scoped query families</title>" +
      section("a") +
      section("b") +
      '<iframe id="outer" srcdoc="' +
      frame.replaceAll("&", "&amp;").replaceAll('"', "&quot;") +
      '"></iframe>',
  });
  const result = await f.run(
    select +
      `
    const scope=tab.playwright.locator('#scope-a');await scope.getByLabel('Scoped label',{exact:true}).fill('Only section A');
    const facts={label:await scope.getByLabel('Scoped label').evaluate('element=>element.value'),placeholder:await scope.getByPlaceholder('Scoped placeholder').evaluate('element=>element.value'),role:await scope.getByRole('button',{name:'Scoped button'}).count(),testId:await scope.getByTestId('scoped-input').getAttribute('id'),text:await scope.getByText('Scoped text',{exact:true}).innerText(),descendant:await scope.locator('input').count(),other:await tab.playwright.locator('#scope-b input').evaluate('element=>element.value')};
    const frame=await tab.frame('#outer');await frame.getByPlaceholder('Frame scoped placeholder').fill('Scoped Frame');const frameLabel=await frame.getByLabel('Frame scoped label').evaluate('element=>element.value');
    const snapshot=await frame.snapshot(),nodes=[];const visit=node=>{nodes.push(node);for(const child of node.children??[])visit(child);};visit(snapshot.root);const button=nodes.find(node=>node.role==='button'&&node.name==='Frame scoped button');await frame.click(button.ref);await frame.waitFor({kind:'text',value:'Scoped Frame'});
    const frameFacts={label:frameLabel,value:await frame.getByTestId('frame-value').innerText(),role:await frame.getByRole('button',{name:'Frame scoped button'}).count(),text:await frame.getByText('Scoped Frame',{exact:true}).innerText(),locator:await frame.locator('input').count()};
    const nested=frame.frameLocator('#nested');await nested.getByPlaceholder('Nested scoped placeholder').fill('Scoped nested Frame');await nested.getByRole('button',{name:'Nested scoped button'}).click();
    const nestedFacts={label:await nested.getByLabel('Nested scoped label').evaluate('element=>element.value'),value:await nested.getByTestId('nested-value').innerText(),text:await nested.getByText('Scoped nested Frame',{exact:true}).innerText(),locator:await nested.locator('input').count()};
    return {facts,frameFacts,nestedFacts};`,
    { base: f.base },
  );
  assert.deepEqual(result.result.data, {
    facts: {
      label: "Only section A",
      placeholder: "Only section A",
      role: 1,
      testId: "input-a",
      text: "Scoped text",
      descendant: 1,
      other: "",
    },
    frameFacts: {
      label: "Scoped Frame",
      value: "Scoped Frame",
      role: 1,
      text: "Scoped Frame",
      locator: 1,
    },
    nestedFacts: {
      label: "Scoped nested Frame",
      value: "Scoped nested Frame",
      text: "Scoped nested Frame",
      locator: 1,
    },
  });
});

test("native direct file refs, download aliases and public waiter cancellation use original real identities", async (t) => {
  const f = await nativeFixture(t);
  const result = await f.run(
    select +
      `
    const snapshot=await tab.snapshot(),nodes=[];const visit=node=>{nodes.push(node);for(const child of node.children??[])visit(child);};visit(snapshot.root);const input=nodes.find(node=>node.role==='textbox'&&node.name==='Upload files');if(!input)throw Error('The native file ref was not observed');
    await tab.setFiles(input.ref,[{name:'direct.txt',mimeType:'text/plain',data:new Uint8Array([78,65,84,73,86,69])}]);const attached=await tab.playwright.evaluate("async()=>{const file=document.querySelector('#upload').files[0];return {name:file.name,size:file.size,text:await file.text()};}");
    const pending=tab.playwright.waitForDownload();await tab.playwright.getByRole('link',{name:'Download native'}).click();const downloaded=await pending;const path=await downloaded.path();const records=await tab.downloads();const record=records.find(item=>item.url===context.input.base+'download');if(!record)throw Error('The actual download ID was not retained');const saved=await tab.saveDownload(record.id);
    const peer=(await client.browsers.list()).find(peer=>peer.id===selected.browserId),target={browserId:peer.id,bootId:peer.bootId,browserSessionId:peer.browserSessionId,generation:peer.generation,tabId:tab.id};
    const choosing=tab.playwright.waitForFileChooser();await tab.playwright.locator('#upload').click();const chooser=await choosing;await chooser.setFiles([{data:new Uint8Array([65]),name:'alias.txt'}]);const multiple=chooser.isMultiple();const wait=await browser.waiters.arm({target,event:'navigation',timeoutMs:5000});const cancelled=await browser.waiters.cancel({target,id:wait.id});let error;try{await browser.waiters.get({target,id:wait.id});}catch(cause){error=cause.code;}
    return {attached,path,saved,record,multiple,cancelled,error};`,
    { base: f.base },
  );
  const data = result.result.data;
  assert.deepEqual(data.attached, {
    name: "direct.txt",
    size: 6,
    text: "NATIVE",
  });
  assert.deepEqual(readFileSync(data.path), f.downloadBytes);
  assert.deepEqual(readFileSync(data.saved.path), f.downloadBytes);
  assert.equal(data.record.state, "complete");
  assert.equal(data.multiple, true);
  assert.equal(data.cancelled.cancelled, true);
  assert.equal(data.error, "WAITER_GONE");
});
