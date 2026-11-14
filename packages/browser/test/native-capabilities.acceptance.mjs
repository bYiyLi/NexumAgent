import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, select } from "./helpers/native.mjs";

const html = `<!doctype html><html><head><title>Nexum native capabilities</title></head><body>
<h1>Native capability acceptance</h1><button id="native-button" onclick="this.textContent='Native action applied'">Native action</button>
</body></html>`;

const dimensions = `() => ({width:innerWidth,height:innerHeight})`;

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
      const explicit=await viewport.set({tabId:tab.id,width:611,height:433});
      const first=await tab.playwright.evaluate(${JSON.stringify(dimensions)});
      const alias=await tab.setViewport({width:723,height:487});
      const second=await tab.playwright.evaluate(${JSON.stringify(dimensions)});
      const aliasReset=await tab.resetViewport(),third=await tab.playwright.evaluate(${JSON.stringify(dimensions)});
      await selected.viewport.set({tabId:tab.id,width:805,height:519});
      const fourth=await tab.playwright.evaluate(${JSON.stringify(dimensions)});
      const reset=await selected.viewport.reset(tab.id),restored=await tab.playwright.evaluate(${JSON.stringify(dimensions)});
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
      await tab.playwright.evaluate("async() => {window.nativeWebMcpController.abort();window.nativeWebMcpController=new AbortController();await document.modelContext.registerTool({name:'nexum_native_echo',description:'A new native registration of the same name',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},execute:async({value})=>{window.nativeWebMcp.calls.push('replacement:'+value);return 'native-replacement:'+value;}},{signal:window.nativeWebMcpController.signal});return true;}");
      let replaced;const replacementDeadline=Date.now()+5000;
      do{replaced=await webmcp.listTools();if(replaced[0]?.registrationRevision!==bound.registrationRevision)break;await tab.playwright.waitForTimeout(15);}while(Date.now()<replacementDeadline);
      const stale=await reject(()=>bound.invokeTool('nexum_native_echo',{value:'must-not-run'}));
      const replacement=await webmcp.invokeTool('nexum_native_echo',{value:'current'});
      return {mode:'native-registered',registration,info,listed,bound:{documentRevision:bound.documentRevision,registrationRevision:bound.registrationRevision,tools:bound.tools},direct,fetched,replaced,stale,replacement,calls:await tab.playwright.evaluate('() => window.nativeWebMcp.calls')};
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
    assert.notEqual(
      data.replaced[0].registrationRevision,
      data.bound.registrationRevision,
    );
    assert.equal(data.stale.code, "STALE_REGISTRATION");
    assert.equal(data.replacement, "native-replacement:current");
    assert.deepEqual(data.calls, ["direct", "bound", "replacement:current"]);
  },
);
