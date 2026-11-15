import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { nativeFixture, select } from "./helpers/native.mjs";

const html = `<!doctype html><html><head><title>Nexum native capabilities</title></head><body>
<h1>Native capability acceptance</h1><button id="native-button" onclick="this.textContent='Native action applied'">Native action</button>
</body></html>`;

const dimensions = `() => ({width:innerWidth,height:innerHeight})`;
const axDiffHtml =
  '<!doctype html><title>Native AX diffs</title><label for="field">Delta field</label><input id="field" value="Before_value"><button id="change">Before native action</button><p id="remove">Removed native content</p>' +
  Array.from(
    { length: 12 },
    (_, index) =>
      `<p>Stable native paragraph ${index} with unchanged context.</p>`,
  ).join("");

test(
  "native AX text emits scoped bounded diffs and screenshots preserve its observation baseline",
  { timeout: 90000 },
  async (t) => {
    const f = await nativeFixture(t, { html: axDiffHtml });
    const result = await f.run(
      select +
        `
const first=await tab.ax.get(),unchanged=await tab.ax.get();
await tab.playwright.getByLabel('Delta field').fill('After_value');
await tab.playwright.evaluate('() => {document.querySelector("#change").textContent="After native action";document.querySelector("#remove").remove();const button=document.createElement("button");button.textContent="Added native action";document.body.append(button);return true;}');
const screenshot=await tab.ax.get('screenshot');await tab.ax.snapshot();
const delta=await tab.ax.get(),full=await tab.ax.get('state',{disableDiffing:true}),afterFull=await tab.ax.get();
const both=await tab.ax.get('both');
const other=await selected.tabs.new(context.input.base+'other',{active:false});await other.playwright.waitForURL(context.input.base+'other');await other.playwright.waitForLoadState({state:'load',timeoutMs:5000});
const otherState=await other.ax.get(),originalState=await tab.ax.get();await other.close();
await tab.navigate(context.input.base+'next',{waitUntil:'load'});const navigated=await tab.ax.get();
return {first,unchanged,delta,full,afterFull,bothState:both.state,screenshotLength:screenshot.length,bothImageLength:both.screenshot.length,otherState,originalState,navigated};`,
      { base: f.base },
    );
    const data = result.result.data;
    assert.match(data.first, /^AX full\n/);
    assert.ok(data.first.includes(`URL: ${JSON.stringify(f.base)}`));
    assert.match(data.first, /Title: "Native AX diffs"/);
    assert.match(data.first, /Before_value/);
    assert.match(data.unchanged, /No accessibility changes\./);
    assert.match(data.delta, /^AX diff\n/);
    assert.match(data.delta, /Removed:\n-/);
    assert.match(data.delta, /Added:\n\+/);
    assert.match(data.delta, /Changed:\n~/);
    assert.match(data.delta, /After native action/);
    assert.match(data.delta, /Added native action/);
    assert.match(data.delta, /Removed native content/);
    assert.match(data.delta, /After_value/);
    assert.ok(data.delta.length < data.full.length);
    assert.match(data.full, /^AX full\n/);
    assert.match(data.full, /Stable native paragraph 11/);
    assert.doesNotMatch(data.full, /Removed native content/);
    for (const state of [data.afterFull, data.bothState, data.originalState])
      assert.match(state, /No accessibility changes\./);
    for (const size of [data.screenshotLength, data.bothImageLength])
      assert.ok(size > 100);
    for (const state of [data.otherState, data.navigated]) {
      assert.match(state, /^AX full\n/);
      assert.match(state, /Before native action/);
      assert.match(state, /Before_value/);
    }
    assert.ok(data.navigated.includes(JSON.stringify(f.base + "next")));
    const nextRun = await f.run(select + "return await tab.ax.get();", {
      base: f.base + "next",
    });
    assert.match(nextRun.result.content[0].text, /^AX full\n/);
    assert.deepEqual(result.run.cleanup.unconfirmed, []);
    assert.deepEqual(nextRun.run.cleanup.unconfirmed, []);
    t.diagnostic(
      JSON.stringify({
        fullBytes: Buffer.byteLength(data.full),
        diffBytes: Buffer.byteLength(data.delta),
        screenshots: [data.screenshotLength, data.bothImageLength],
        freshRun: nextRun.run.status,
      }),
    );
  },
);

test(
  "native AX write delivers real state diffs and honors forced full and combined image modes",
  { timeout: 60000 },
  async (t) => {
    const f = await nativeFixture(t, { html: axDiffHtml });
    for (const mode of ["state", "both", "forced"]) {
      const view = await f.run(
        select +
          `
await tab.ax.get();await tab.playwright.getByLabel('Delta field').fill('Written_'+context.input.mode);
if(context.input.mode==='forced')return await tab.ax.write('state',{disableDiffing:true});
return await tab.ax.write(context.input.mode);`,
        { base: f.base, mode },
      );
      const text = view.result.content[0].text;
      assert.match(text, mode === "forced" ? /^AX full\n/ : /^AX diff\n/);
      assert.ok(text.includes("Written_" + mode));
      if (mode === "forced") assert.match(text, /Stable native paragraph 11/);
      else assert.doesNotMatch(text, /Stable native paragraph/);
      const rendered = await f.encoder.render(
        view.result,
        f.resultScope(),
        view.run,
      );
      assert.deepEqual(
        rendered.content.map((item) => item.type),
        mode === "both" ? ["text", "image", "text"] : ["text", "text"],
      );
      assert.equal(rendered.content[0].text, text);
      if (mode === "both") {
        const image = rendered.content[1];
        assert.equal(image.mimeType, "image/jpeg");
        assert.ok(Buffer.from(image.data, "base64").length > 100);
      }
      assert.deepEqual(view.run.cleanup.unconfirmed, []);
      t.diagnostic(
        JSON.stringify({ mode, textBytes: Buffer.byteLength(text) }),
      );
    }
  },
);

test(
  "native element screenshots capture the actual scrolled target at multiple device scales",
  { timeout: 60000 },
  async (t) => {
    const f = await nativeFixture(t, {
      html: '<!doctype html><title>Native scrolled screenshot</title><style>html,body{margin:0}body{width:1800px;height:2600px;background:rgb(20,40,210)}#spot{position:absolute;left:1000px;top:1300px;width:160px;height:100px;background:rgb(230,20,30)}</style><div id="spot"></div>',
    });
    const result = await f.run(
      select +
        `
const facts=[];
for(const dpr of [1,2]){
  await tab.cdp.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:dpr,mobile:false});
  const rect=await tab.playwright.evaluate('() => {scrollTo(850,1100);const r=document.querySelector("#spot").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollX,scrollY};}');
  const point={x:rect.x+rect.width/2,y:rect.y+rect.height/2,includeNonInteractable:true};
  const info=await tab.playwright.elementInfo(point),bytes=await tab.playwright.elementScreenshot(point);
  const image=await tab.playwright.evaluate('async data=>{const image=await createImageBitmap(new Blob([new Uint8Array(data)],{type:"image/jpeg"}));const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);const pixel=Array.from(ctx.getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data);const value={width:image.width,height:image.height,pixel};image.close();return value;}',Array.from(bytes));
  facts.push({dpr,rect,box:info[0].boundingBox,image,byteLength:bytes.length});
}
let missing;try{await tab.playwright.elementScreenshot({x:-1,y:-1});}catch(error){missing=error.code;}
return {facts,missing};`,
      { base: f.base },
    );
    const { facts, missing } = result.result.data;
    t.diagnostic(JSON.stringify({ facts }));
    assert.equal(facts.length, 2);
    for (const fact of facts) {
      assert.equal(fact.rect.scrollX, 850);
      assert.equal(fact.rect.scrollY, 1100);
      assert.deepEqual(fact.box, { x: 150, y: 200, width: 160, height: 100 });
      assert.equal(fact.image.width, 160 * fact.dpr);
      assert.equal(fact.image.height, 100 * fact.dpr);
      assert.ok(
        fact.image.pixel[0] > 200 &&
          fact.image.pixel[1] < 50 &&
          fact.image.pixel[2] < 60,
        JSON.stringify(fact),
      );
    }
    assert.equal(missing, "INVALID_TARGET");
    assert.deepEqual(result.run.cleanup.unconfirmed, []);
  },
);

test(
  "native AX read and write modes preserve typed MCP output, current authority and historical bytes",
  { timeout: 90000 },
  async (t) => {
    let permitted = true;
    const f = await nativeFixture(t, {
      html: '<!doctype html><title>Native AX modes</title><h1>Native AX output</h1><label for="name">AX field</label><input id="name"><button>AX action</button>',
      authorize(policy) {
        if (
          !permitted &&
          ["ax.get", "ax.write"].includes(policy.method) &&
          policy.target?.type === "connection" &&
          policy.target.access === "read"
        )
          throw Object.assign(
            new Error("Current AX observation permission was revoked."),
            { code: "forbidden" },
          );
      },
    });
    const read = await f.run(
      select +
        `
const state=await tab.ax.get(),full=await tab.ax.get('state',{disableDiffing:true});
const before=await tab.ax.snapshot(),index=before.nodes.find(node=>node.name==='AX action'&&node.role==='button').index;
const screenshot=await tab.ax.get('screenshot'),both=await tab.ax.get('both',{disableDiffing:true});
const after=await tab.ax.snapshot();
const image=async bytes=>tab.playwright.evaluate('async data=>{const image=await createImageBitmap(new Blob([new Uint8Array(data)],{type:"image/jpeg"}));const value={width:image.width,height:image.height};image.close();return value;}',Array.from(bytes));
const reject=async action=>{try{await action();return 'unexpected';}catch(error){return error.code;}};
return {state,full,bothState:both.state,screenshot:await image(screenshot),bothImage:await image(both.screenshot),index,afterIndex:after.nodes.find(node=>node.name==='AX action'&&node.role==='button').index,invalidGet:await reject(()=>tab.ax.get('state',{notSupported:true})),invalidWrite:await reject(()=>tab.ax.write('state',{notSupported:true}))};`,
      { base: f.base },
    );
    const data = read.result.data;
    for (const state of [data.state, data.full, data.bothState]) {
      assert.match(state, /Native AX output/);
      assert.match(state, /AX action/);
    }
    assert.equal(data.index, data.afterIndex);
    for (const image of [data.screenshot, data.bothImage])
      assert.ok(image.width > 0 && image.height > 0);
    assert.equal(data.invalidGet, "INVALID_ARGUMENT");
    assert.equal(data.invalidWrite, "INVALID_ARGUMENT");
    const history = [];
    for (const mode of ["default", "state", "screenshot", "both"]) {
      const view = await f.run(
        select +
          `
if(context.input.mode==='default')return await tab.ax.write();
if(context.input.mode==='screenshot')return await tab.ax.write('screenshot');
return await tab.ax.write(context.input.mode,{disableDiffing:true});`,
        { base: f.base, mode },
      );
      const rendered = await f.encoder.render(
        view.result,
        f.resultScope(),
        view.run,
      );
      const expected =
        mode === "screenshot"
          ? ["image", "text"]
          : mode === "both"
            ? ["text", "image", "text"]
            : ["text", "text"];
      assert.deepEqual(
        rendered.content.map((item) => item.type),
        expected,
      );
      assert.deepEqual(rendered.structuredContent.run, view.run);
      assert.equal(
        rendered.content.at(-1).text,
        `runId: ${view.run.runId}\nstatus: succeeded`,
      );
      for (const item of rendered.content.slice(0, -1)) {
        if (item.type === "text") assert.match(item.text, /Native AX output/);
        if (item.type === "image") {
          assert.equal(item.mimeType, "image/jpeg");
          const bytes = Buffer.from(item.data, "base64");
          assert.ok(bytes.length > 100);
          assert.equal(bytes[0], 255);
          assert.equal(bytes[1], 216);
          assert.equal(
            Object.hasOwn(
              view.result.content.find((value) => value.type === "image"),
              "data",
            ),
            false,
          );
          assert.ok(!JSON.stringify(view.result).includes(item.data));
        }
      }
      assert.deepEqual(view.run.cleanup.unconfirmed, []);
      t.diagnostic(
        JSON.stringify({
          mode,
          contentTypes: expected,
          status: view.run.status,
        }),
      );
      history.push({ view, content: rendered.content });
    }
    await f.run(
      select +
        `await tab.playwright.evaluate('() => {document.querySelector("h1").textContent="Changed source";document.body.style.background="black";return true;}');return {changed:true};`,
      { base: f.base },
    );
    for (const item of history) {
      const saved = await f.encoder.render(
        item.view.result,
        f.resultScope(),
        item.view.run,
      );
      assert.deepEqual(
        saved.content,
        item.content,
        "Historical AX output must retain its original content after the source page changes.",
      );
    }
    permitted = false;
    try {
      const denied = await f.run(
        select +
          `
const reject=async action=>{try{await action();return 'unexpected';}catch(error){return error.code;}};
return {get:await reject(()=>tab.ax.get('state')),write:await reject(()=>tab.ax.write('screenshot'))};`,
        { base: f.base },
      );
      assert.deepEqual(denied.result.data, {
        get: "forbidden",
        write: "forbidden",
      });
    } finally {
      permitted = true;
    }
    const native = await f.cleanupFacts();
    assert.deepEqual(native.owned, [], JSON.stringify(native));
  },
);

test(
  "native screenshot maxEdgePx bounds physical JPEG pixels at multiple device scales",
  { timeout: 60000 },
  async (t) => {
    const f = await nativeFixture(t, {
      html: "<!doctype html><title>Owned screenshot bounds</title><style>html,body{margin:0}body{height:2400px;background:linear-gradient(#acf,#fa9)}</style><h1>Owned native screenshots</h1>",
    });
    const result = await f.run(
      select +
        `
const facts=[];
for(const dpr of [1,2,1.25]){
  await tab.cdp.send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:dpr,mobile:false});
  // MAIN can spoof this property; the screenshot must use the native isolated world.
  await tab.playwright.evaluate('() => {Object.defineProperty(window,"devicePixelRatio",{value:99,configurable:true});return true;}');
  for(const options of [{maxEdgePx:120,quality:0},{fullPage:true,maxEdgePx:120},{clip:{x:0,y:0,width:80,height:60},maxEdgePx:120,quality:100}]){
    const bytes=await tab.screenshot(options);
    const dimensions=await tab.playwright.evaluate('async data => {const image=await createImageBitmap(new Blob([new Uint8Array(data)],{type:"image/jpeg"}));const value={width:image.width,height:image.height};image.close();return value;}',Array.from(bytes));
    facts.push({dpr,options,dimensions,byteLength:bytes.byteLength});
  }
}
return {facts};`,
      { base: f.base },
    );
    const facts = result.result.data.facts;
    t.diagnostic(JSON.stringify({ facts }));
    assert.equal(facts.length, 9);
    for (const fact of facts) {
      assert.ok(fact.byteLength > 0);
      assert.ok(fact.dimensions.width > 0 && fact.dimensions.height > 0);
      assert.ok(
        Math.max(fact.dimensions.width, fact.dimensions.height) <=
          fact.options.maxEdgePx,
        JSON.stringify(fact),
      );
      if (fact.options.clip)
        assert.equal(fact.dimensions.width, Math.min(120, 80 * fact.dpr));
    }
    assert.deepEqual(result.run.cleanup.unconfirmed, []);
  },
);

test(
  "native run cancellation and expiry close a held browser network request before releasing its lease",
  { timeout: 60000 },
  async (t) => {
    for (const mode of ["cancel", "deadline"])
      await t.test(mode, async (t) => {
        const ready = Promise.withResolvers();
        const closed = Promise.withResolvers();
        let response,
          clientClosed = false,
          closedAt;
        const f = await nativeFixture(t, {
          html: '<!doctype html><title>Held native request</title><script>window.released=[];addEventListener("keyup",event=>released.push(event.key));</script>',
          handleRequest(req, res) {
            if (req.url !== "/held-native") return false;
            response = res;
            res.on("close", () => {
              clientClosed = true;
              closedAt = performance.now();
              closed.resolve();
            });
            ready.resolve();
            return true;
          },
        });
        let state;
        try {
          state = await f.start(
            select +
              `await tab.cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16});const tree=await tab.cdp.send('Page.getFrameTree');try{return await tab.cdp.send('Network.loadNetworkResource',{frameId:tree.frameTree.frame.id,url:context.input.base+'held-native',options:{disableCache:true,includeCredentials:true}});}catch(error){if(context.input.mode!=='deadline'||error.code!=='TIMEOUT')throw error;await new Promise(resolve=>setTimeout(resolve,250));}`,
            { base: f.base, mode },
            { timeoutMs: mode === "deadline" ? 4000 : 15000 },
          );
          await Promise.race([
            ready.promise,
            delay(3000).then(() => {
              throw Error(
                "The owned native request never reached its actual server.",
              );
            }),
          ]);
          if (mode === "cancel") f.cancel(state.run.runId);
          const until = performance.now() + (mode === "deadline" ? 7000 : 4000);
          do {
            state = await f.observe(state.run.runId, 50);
            if (state.run.endedAt !== null) break;
            await delay(20);
          } while (performance.now() < until);
          assert.notEqual(
            state.run.endedAt,
            null,
            JSON.stringify({ run: state.run, operations: state.operations }),
          );
          // Native detach and the server's socket-close event run on different
          // event loops. Observe the actual peer close while withholding this
          // server's response; a finished Run alone is not evidence of closure.
          const runObservedAt = performance.now();
          if (!clientClosed) await Promise.race([closed.promise, delay(2000)]);
          t.diagnostic(
            JSON.stringify({
              mode,
              peerClosed: clientClosed,
              peerCloseAfterRunObservationMs:
                closedAt === undefined ? null : closedAt - runObservedAt,
            }),
          );
          assert.equal(
            clientClosed,
            true,
            "Native cleanup must close the held client before the server supplies its response.",
          );
          assert.equal(
            state.run.status,
            mode === "deadline" ? "failed" : "cancelled",
          );
          // The browser action budget can finish just before Core's Run timer.
          // Keep the script live briefly for that known TIMEOUT only; the actual
          // Run deadline and native connection/input cleanup must still be proved.
          assert.equal(
            state.run.stop?.kind,
            mode,
            JSON.stringify({ run: state.run, operations: state.operations }),
          );
          assert.deepEqual(state.run.cleanup.unconfirmed, []);
          const next = await f.run(
            select +
              `return {title:await tab.title(),released:await tab.playwright.evaluate('() => window.released')};`,
            { base: f.base },
          );
          assert.equal(next.result.data.title, "Held native request");
          assert.deepEqual(next.result.data.released, ["Shift"]);
        } finally {
          if (response && !response.destroyed) {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("owned server completion");
          }
          if (state) {
            f.cancel(state.run.runId);
            const until = performance.now() + 5000;
            do {
              state = await f.observe(state.run.runId, 50);
              if (state.run.endedAt !== null) break;
              await delay(20);
            } while (performance.now() < until);
          }
        }
      });
  },
);

test(
  "native capability revisions, browser identity, tab metadata and packaged documentation describe the actual peer",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
      const peers=await client.browsers.list();
      const byId=await client.browsers.get(selected.browserId),byUrl=await client.browsers.getForUrl(context.input.base+'?metadata');
      const actual=await selected.management.tabs.get(tab.id);
      const selectedTab=await selected.tabs.selected();
      const userTabs=await selected.user.openTabs(),userTab=userTabs.find(item=>item.id===tab.id);
      if(!userTab)throw new Error('Actual native user tab was not discovered');
      const claimed=await selected.user.claimTab(userTab),userContext=await selected.user.getTabContext(userTab),selectedUserContext=await selected.user.getTabContext();
      const claimedState={id:claimed.id,title:await claimed.title(),url:await claimed.url()};
      const browserCaps=await selected.capabilities.list(),tabCaps=await tab.capabilities.list();
      const stable=await tab.capabilities.list();
      const reject=async(action)=>{try{await action();return null;}catch(error){return {code:error.code,message:error.message};}};
      const unknownBrowser=await reject(()=>selected.capabilities.get('nexum_missing_capability'));
      const unknownTab=await reject(()=>tab.capabilities.get('nexum_missing_capability'));
      const docs=await selected.documentation(),usage=await client.documentation.get('usage');
      const visited=context.input.base+'?native-history=one';
      await tab.navigate(visited);await tab.playwright.waitForURL(visited);
      const changed=await tab.capabilities.list();
      const history=await selected.history({from:new Date(Date.now()-60000),to:new Date(Date.now()+1000),queries:['127.0.0.1'],limit:20});
      return {peers,identity:{browserId:selected.browserId,name:selected.name,type:selected.type,profileName:selected.profileName??null},byId:byId.browserId,byUrl:byUrl.browserId,tabId:tab.id,selectedId:selectedTab?.id,actual,userTabs,userTab,claimedState,userContext,selectedUserContext,browserCaps,tabCaps,stable,changed,unknownBrowser,unknownTab,docs,usage,history,visited,title:await tab.title(),url:await tab.url()};
      `,
      { base: f.base },
    );
    const data = result.result.data;
    const peer = data.peers.find((item) => item.id === data.identity.browserId);
    assert.ok(peer, "The public browser identity must match actual discovery.");
    assert.equal(peer.status, "online");
    assert.equal(peer.type, "extension");
    assert.equal(peer.name, data.identity.name);
    assert.equal(peer.profileName ?? null, data.identity.profileName);
    assert.equal(data.identity.type, "extension");
    assert.ok(peer.name.length > 0);
    assert.ok(peer.bootId.length > 0);
    assert.ok(peer.browserSessionId.length > 0);
    assert.ok(Number.isSafeInteger(peer.generation));
    assert.ok(peer.metadata.extensionVersion.length > 0);
    assert.ok(
      ["clientHints", "userAgent", "unknown"].includes(
        peer.metadata.versionSource,
      ),
    );
    assert.equal(data.byId, peer.id);
    assert.equal(data.byUrl, peer.id);
    assert.equal(data.selectedId, data.tabId);
    assert.equal(data.actual.tabId, data.tabId);
    assert.equal(data.actual.browserId, peer.id);
    assert.equal(data.actual.bootId, peer.bootId);
    assert.equal(data.actual.browserSessionId, peer.browserSessionId);
    assert.equal(data.actual.generation, peer.generation);
    assert.equal(data.actual.active, true);
    assert.equal(data.actual.title, "Nexum native capabilities");
    assert.equal(data.actual.url, f.base);
    assert.equal(data.userTab.id, data.tabId);
    assert.equal(data.userTab.title, "Nexum native capabilities");
    assert.equal(data.userTab.url, f.base);
    assert.deepEqual(data.claimedState, {
      id: data.tabId,
      title: "Nexum native capabilities",
      url: f.base,
    });
    assert.equal(data.userContext.kind, "text");
    assert.deepEqual(data.selectedUserContext, data.userContext);
    assert.equal(data.userContext.title, "Nexum native capabilities");
    assert.equal(data.userContext.url, f.base);
    assert.equal(data.userContext.truncated, false);
    assert.match(data.userContext.text, /Native capability acceptance/);
    assert.match(data.userContext.text, /Native action/);
    assert.equal(data.title, "Nexum native capabilities");
    assert.equal(data.url, data.visited);
    assert.deepEqual(data.browserCaps.map((item) => item.id).sort(), [
      "management",
      "viewport",
      "visibility",
    ]);
    assert.deepEqual(data.tabCaps.map((item) => item.id).sort(), [
      "cdp",
      "pageAssets",
      "webmcp",
    ]);
    for (const item of [...data.browserCaps, ...data.tabCaps]) {
      assert.equal(item.name, item.id);
      assert.equal(typeof item.supported, "boolean");
      assert.ok(item.title.length > 0 && item.description.length > 0);
      assert.ok(item.revision.includes(peer.browserSessionId));
      if (!item.supported) assert.ok(item.reason?.length > 0);
    }
    assert.equal(
      data.tabCaps.find((item) => item.id === "cdp").supported,
      true,
    );
    assert.equal(
      data.tabCaps.find((item) => item.id === "pageAssets").supported,
      true,
    );
    for (const before of data.tabCaps) {
      assert.equal(
        data.stable.find((item) => item.id === before.id).revision,
        before.revision,
      );
      assert.notEqual(
        data.changed.find((item) => item.id === before.id).revision,
        before.revision,
      );
    }
    assert.equal(data.unknownBrowser.code, "CAPABILITY_NOT_ALLOWED");
    assert.equal(data.unknownTab.code, "CAPABILITY_NOT_ALLOWED");
    assert.ok(data.unknownBrowser.message.length > 0);
    assert.ok(data.unknownTab.message.length > 0);
    assert.match(data.docs, /Nexum|browser/i);
    assert.match(data.usage, /createBrowserClient/);
    assert.ok(data.history.some((item) => item.url === data.visited));
    assert.ok(
      data.history.every((item) =>
        Number.isFinite(Date.parse(item.dateVisited)),
      ),
    );
    assert.equal(
      new Set(data.history.map((item) => item.url)).size,
      data.history.length,
    );
    // Cross a real native 20-second heartbeat interval. Reconnecting is not a
    // substitute for preserving the original connection and its later actions.
    await delay(21000);
    const after = await f.run(
      select +
        `await tab.playwright.locator('#native-button').click();return {peers:await client.browsers.list(),text:await tab.playwright.locator('#native-button').innerText()};`,
      { base: f.base },
    );
    const current = after.result.data.peers.find((item) => item.id === peer.id);
    assert.ok(
      current,
      "The same native browser must remain discoverable after its heartbeat.",
    );
    for (const key of ["bootId", "browserSessionId", "generation"])
      assert.equal(current[key], peer[key]);
    assert.equal(after.result.data.text, "Native action applied");
    const cleanup = await f.cleanupFacts();
    assert.deepEqual(cleanup.owned, [], JSON.stringify(cleanup));
  },
);

test(
  "native visibility follows the selected target and viewport aliases change and reset actual page dimensions",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
      const visibility=await selected.capabilities.get('visibility'),viewport=await selected.capabilities.get('viewport');
      const originalVisibility=await visibility.get(),baseline=await tab.playwright.evaluate(${JSON.stringify(dimensions)});
      const measured=async expected=>{const until=Date.now()+5000;while(true){const actual=await tab.playwright.evaluate(${JSON.stringify(dimensions)});if(actual.width===expected.width&&actual.height===expected.height)return actual;if(Date.now()>=until)throw new Error('Native viewport did not reach '+JSON.stringify(expected)+': '+JSON.stringify(actual));await tab.playwright.waitForTimeout(10);}};
      const explicit=await viewport.set({tabId:tab.id,width:611,height:433});
      const first=await measured({width:611,height:433});
      const alias=await tab.setViewport({width:723,height:487});
      const second=await measured({width:723,height:487});
      const aliasReset=await tab.resetViewport(),third=await measured(baseline);
      await selected.viewport.set({tabId:tab.id,width:805,height:519});
      const fourth=await measured({width:805,height:519});
      const reset=await selected.viewport.reset(tab.id),restored=await measured(baseline);
      await visibility.set(false);
      const hiddenFollow=await visibility.get();
      const other=await selected.tabs.new(context.input.base+'?follow-target',{active:false});
      await other.playwright.waitForURL(context.input.base+'?follow-target');
      await selected.tabs.select(tab.id);
      await other.playwright.getByRole('button',{name:'Native action',exact:true}).click();
      const stationary=(await selected.tabs.selected())?.id;
      const changedText=await other.playwright.getByRole('button',{name:'Native action applied',exact:true}).innerText();
      await selected.visibility.set(true);
      const visibleFollow=await selected.visibility.get();
      await other.playwright.getByRole('button',{name:'Native action applied',exact:true}).click();
      const followed=(await selected.tabs.selected())?.id;
      await selected.visibility.set(originalVisibility);
      return {tabId:tab.id,otherId:other.id,baseline,explicit,first,alias,second,aliasReset,third,fourth,reset,restored,hiddenFollow,visibleFollow,stationary,followed,changedText};
      `,
      { base: f.base },
    );
    const data = result.result.data;
    assert.deepEqual(data.first, { width: 611, height: 433 });
    assert.deepEqual(data.second, { width: 723, height: 487 });
    assert.deepEqual(data.third, data.baseline);
    assert.deepEqual(data.fourth, { width: 805, height: 519 });
    assert.deepEqual(data.restored, data.baseline);
    for (const action of [
      data.explicit,
      data.alias,
      data.aliasReset,
      data.reset,
    ]) {
      assert.equal(action.ok, true);
      assert.equal(action.target.tabId, data.tabId);
      assert.ok(action.operationId.length > 0);
    }
    assert.equal(data.hiddenFollow, false);
    assert.equal(data.visibleFollow, true);
    assert.equal(data.stationary, data.tabId);
    assert.equal(data.followed, data.otherId);
    assert.equal(data.changedText, "Native action applied");
  },
);

test(
  "native capability availability cannot bypass a newly revoked current control permission",
  { timeout: 120000 },
  async (t) => {
    let permitted = true;
    const f = await nativeFixture(t, {
      html,
      authorize(policy) {
        if (
          policy.target?.type === "connection" &&
          policy.target.access === "control" &&
          !permitted
        )
          throw Object.assign(
            new Error("Current native browser control was revoked."),
            { code: "forbidden" },
          );
      },
    });
    const before = await f.run(
      select +
        `return {capabilities:await selected.capabilities.list(),size:await tab.playwright.evaluate(${JSON.stringify(dimensions)})};`,
      { base: f.base },
    );
    assert.equal(
      before.result.data.capabilities.find((item) => item.id === "viewport")
        .supported,
      true,
    );
    permitted = false;
    const denied = await f.run(
      select +
        `try {await tab.setViewport({width:503,height:307});return {unexpected:true};} catch(error){return {code:error.code,message:error.message};}`,
      { base: f.base },
    );
    assert.equal(denied.result.data.code, "forbidden");
    assert.match(denied.result.data.message, /revoked/i);
    permitted = true;
    const after = await f.run(
      select +
        `return await tab.playwright.evaluate(${JSON.stringify(dimensions)});`,
      { base: f.base },
    );
    assert.deepEqual(after.result.data, before.result.data.size);
  },
);

test(
  "native dev logs normalize real console warnings and apply filter, limit and since without replaying older entries",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
      await tab.capabilities.get('cdp');
      const waitLogs=async(count)=>{const until=Date.now()+5000;let logs;do{logs=await tab.devLogs({filter:'nexum-native-log'});if(logs.length>=count)return logs;await tab.playwright.waitForTimeout(15);}while(Date.now()<until);throw new Error('Native console events were not observed');};
      await tab.playwright.evaluate("() => {console.warn('nexum-native-log old warning');return true;}");
      await waitLogs(1);await tab.playwright.waitForTimeout(15);const since=Date.now();
      await tab.playwright.evaluate("() => {console.info('nexum-native-log new info');console.warn('nexum-native-log new warning');console.error('nexum-native-log new error');return true;}");
      await waitLogs(4);
      return {since,all:await tab.devLogs({filter:'nexum-native-log'}),recent:await tab.devLogs({filter:'nexum-native-log',since}),warnings:await tab.devLogs({filter:'nexum-native-log',levels:['warning'],since}),directWarnings:await tab.dev.logs({filter:'nexum-native-log',levels:['warning']}),limited:await tab.devLogs({filter:'nexum-native-log',limit:2}),future:await tab.devLogs({filter:'nexum-native-log',since:Date.now()+60000}),absent:await tab.devLogs({filter:'nexum-absent-native-log'})};
      `,
      { base: f.base },
    );
    const data = result.result.data;
    assert.deepEqual(
      data.all.map((item) => [item.level, item.message]),
      [
        ["warn", "nexum-native-log old warning"],
        ["info", "nexum-native-log new info"],
        ["warn", "nexum-native-log new warning"],
        ["error", "nexum-native-log new error"],
      ],
    );
    assert.deepEqual(
      data.recent.map((item) => item.message),
      data.all.slice(1).map((item) => item.message),
    );
    assert.deepEqual(
      data.warnings.map((item) => item.message),
      ["nexum-native-log new warning"],
    );
    assert.deepEqual(
      data.directWarnings.map((item) => item.message),
      ["nexum-native-log old warning", "nexum-native-log new warning"],
    );
    assert.ok(
      data.warnings.every(
        (item) =>
          item.level === "warn" && Date.parse(item.timestamp) >= data.since,
      ),
    );
    assert.deepEqual(data.limited, data.all.slice(-2));
    assert.deepEqual(data.future, []);
    assert.deepEqual(data.absent, []);
  },
);

test(
  "native dialogAccept and dialogDismiss aliases consume the actual prompt, confirm and alert identities",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, { html });
    const result = await f.run(
      select +
        `
      await tab.navigate(context.input.base+'?dialog-aliases');
      const dialog=async()=>{const until=Date.now()+5000;do{const current=await tab.getJsDialog();if(current)return current;await tab.playwright.waitForTimeout(15);}while(Date.now()<until);throw new Error('The actual native dialog did not open');};
      await tab.playwright.evaluate("() => {setTimeout(()=>{window.nativeAliasPrompt=prompt('Native alias prompt','seed')},20);return true;}");
      const prompt=await dialog(),promptInfo={type:prompt.type,message:prompt.message};
      const accepted=await tab.dialogAccept('Native alias response');
      const promptValue=await tab.playwright.evaluate('() => window.nativeAliasPrompt');
      await tab.playwright.evaluate("() => {setTimeout(()=>{window.nativeAliasConfirm=confirm('Native alias confirm')},20);return true;}");
      const confirm=await dialog(),confirmInfo={type:confirm.type,message:confirm.message};
      const dismissed=await tab.dialogDismiss();
      const confirmValue=await tab.playwright.evaluate('() => window.nativeAliasConfirm');
      await tab.playwright.evaluate("() => {setTimeout(()=>{alert('Native alias alert');window.nativeAliasAlert=true},20);return true;}");
      const alert=await dialog(),alertInfo={type:alert.type,message:alert.message};
      const alertDismissed=await tab.dialogDismiss();
      const resumed=await tab.playwright.evaluate('() => window.nativeAliasAlert');
      const reject=async(action)=>{try{await action();return null;}catch(error){return error.code;}};
      return {tabId:tab.id,promptInfo,accepted,promptValue,confirmInfo,dismissed,confirmValue,alertInfo,alertDismissed,resumed,absent:await tab.getJsDialog()??null,acceptAbsent:await reject(()=>tab.dialogAccept('unused')),dismissAbsent:await reject(()=>tab.dialogDismiss())};
      `,
      { base: f.base },
    );
    const data = result.result.data;
    assert.deepEqual(data.promptInfo, {
      type: "prompt",
      message: "Native alias prompt",
    });
    assert.equal(data.promptValue, "Native alias response");
    assert.deepEqual(data.confirmInfo, {
      type: "confirm",
      message: "Native alias confirm",
    });
    assert.equal(data.confirmValue, false);
    assert.deepEqual(data.alertInfo, {
      type: "alert",
      message: "Native alias alert",
    });
    assert.equal(data.resumed, true);
    assert.equal(data.absent, null);
    assert.equal(data.acceptAbsent, "STALE_REF");
    assert.equal(data.dismissAbsent, "STALE_REF");
    for (const action of [data.accepted, data.dismissed, data.alertDismissed]) {
      assert.equal(action.ok, true);
      assert.equal(action.target.tabId, data.tabId);
      assert.ok(action.operationId.length > 0);
    }
  },
);

test(
  "native WebMCP either invokes real document registrations with exact revisions or reports its actual unsupported reason",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture(t, {
      html: `<!doctype html><html><head><title>Native WebMCP acceptance</title></head><body><h1>Native WebMCP</h1><script>
      window.nativeWebMcp={available:typeof document.modelContext?.registerTool==='function',ready:false,calls:[]};
      if(window.nativeWebMcp.available){window.nativeWebMcpController=new AbortController();Promise.resolve(document.modelContext.registerTool({name:'nexum_native_echo',description:'Echo a test value through the actual native page API',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},execute:async({value})=>{window.nativeWebMcp.calls.push(value);return 'native-echo:'+value;}},{signal:window.nativeWebMcpController.signal})).then(()=>{window.nativeWebMcp.ready=true},error=>{window.nativeWebMcp.error=String(error.message)});}
      </script></body></html>`,
    });
    const result = await f.run(
      select +
        `
      const until=Date.now()+5000;let registration;
      do{registration=await tab.playwright.evaluate('() => window.nativeWebMcp');if(!registration.available||registration.ready||registration.error)break;await tab.playwright.waitForTimeout(15);}while(Date.now()<until);
      const info=(await tab.capabilities.list()).find(item=>item.id==='webmcp');
      const reject=async(action)=>{try{await action();return null;}catch(error){return {code:error.code,message:error.message};}};
      if(!info.supported)return {mode:'native-unsupported',registration,info,capabilityError:await reject(()=>tab.capabilities.get('webmcp')),listError:await reject(()=>tab.webmcp.listTools()),fetchError:await reject(()=>tab.webmcp.fetchTools())};
      const webmcp=await tab.capabilities.get('webmcp'),listed=await webmcp.listTools(),bound=await webmcp.fetchTools();
      if(!registration.available)return {mode:'native-domain-only',registration,info,listed,bound:{documentRevision:bound.documentRevision,registrationRevision:bound.registrationRevision,tools:bound.tools}};
      const direct=await webmcp.invokeTool('nexum_native_echo',{value:'direct'}),fetched=await bound.invokeTool('nexum_native_echo',{value:'bound'});
      const facadeList=await tab.webmcp.listTools(),facadeBound=await tab.webmcp.fetchTools();
      const facadeDirect=await tab.webmcp.invokeTool('nexum_native_echo',{value:'facade-direct'}),facadeFetched=await facadeBound.invokeTool('nexum_native_echo',{value:'facade-bound'});
      await tab.playwright.evaluate("async() => {window.nativeWebMcpController.abort();window.nativeWebMcpController=new AbortController();await document.modelContext.registerTool({name:'nexum_native_echo',description:'A new native registration of the same name',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},execute:async({value})=>{window.nativeWebMcp.calls.push('replacement:'+value);return 'native-replacement:'+value;}},{signal:window.nativeWebMcpController.signal});return true;}");
      let replaced;const replacementDeadline=Date.now()+5000;
      do{replaced=await webmcp.listTools();if(replaced[0]?.registrationRevision!==bound.registrationRevision)break;await tab.playwright.waitForTimeout(15);}while(Date.now()<replacementDeadline);
      const stale=await reject(()=>bound.invokeTool('nexum_native_echo',{value:'must-not-run'})),facadeStale=await reject(()=>facadeBound.invokeTool('nexum_native_echo',{value:'facade-must-not-run'}));
      const replacement=await webmcp.invokeTool('nexum_native_echo',{value:'current'});
      return {mode:'native-registered',registration,info,listed,bound:{documentRevision:bound.documentRevision,registrationRevision:bound.registrationRevision,tools:bound.tools},direct,fetched,facadeList,facadeDirect,facadeFetched,replaced,stale,facadeStale,replacement,calls:await tab.playwright.evaluate('() => window.nativeWebMcp.calls')};
      `,
      { base: f.base },
    );
    const data = result.result.data;
    assert.equal(data.info.id, "webmcp");
    assert.ok(data.info.revision.length > 0);
    if (process.env.NEXUM_BROWSER_WEBMCP_TESTING === "1")
      assert.equal(
        data.mode,
        "native-registered",
        "The explicit experimental conformance profile must execute real registrations.",
      );
    if (data.mode === "native-unsupported") {
      assert.equal(data.info.supported, false);
      assert.ok(data.info.reason.length > 0);
      for (const error of [
        data.capabilityError,
        data.listError,
        data.fetchError,
      ]) {
        assert.equal(error.code, "CAPABILITY_NOT_ALLOWED");
        assert.ok(error.message.length > 0);
      }
      t.diagnostic(
        `Actual native WebMCP rejection: ${data.info.reason}; document.modelContext=${data.registration.available}`,
      );
      return;
    }
    assert.equal(data.info.supported, true);
    assert.equal(data.registration.error, undefined);
    if (data.mode === "native-domain-only") {
      assert.equal(data.registration.available, false);
      assert.deepEqual(data.listed, []);
      assert.deepEqual(data.bound.tools, []);
      t.diagnostic(
        "The native WebMCP protocol is reachable but document.modelContext is unavailable; no positive registration/invocation acceptance is inferred.",
      );
      return;
    }
    assert.equal(data.mode, "native-registered");
    assert.equal(data.registration.ready, true);
    assert.deepEqual(
      data.listed.map((tool) => tool.name),
      ["nexum_native_echo"],
    );
    assert.deepEqual(data.bound.tools, data.listed);
    assert.equal(data.listed[0].documentRevision, data.bound.documentRevision);
    assert.equal(
      data.listed[0].registrationRevision,
      data.bound.registrationRevision,
    );
    assert.deepEqual(data.listed[0].inputSchema.required, ["value"]);
    assert.equal(data.direct, "native-echo:direct");
    assert.equal(data.fetched, "native-echo:bound");
    assert.deepEqual(data.facadeList, data.listed);
    assert.equal(data.facadeDirect, "native-echo:facade-direct");
    assert.equal(data.facadeFetched, "native-echo:facade-bound");
    assert.notEqual(
      data.replaced[0].registrationRevision,
      data.bound.registrationRevision,
    );
    assert.equal(data.stale.code, "STALE_REGISTRATION");
    assert.equal(data.facadeStale.code, "STALE_REGISTRATION");
    assert.equal(data.replacement, "native-replacement:current");
    assert.deepEqual(data.calls, [
      "direct",
      "bound",
      "facade-direct",
      "facade-bound",
      "replacement:current",
    ]);
  },
);
