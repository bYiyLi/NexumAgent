import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { nativeFixture, select } from "./helpers/native.mjs";

test(
  "native background cursor movement settles without a paint callback and leaves no control after run cleanup",
  { timeout: 90000 },
  async (t) => {
    const facts = [];
    const f = await nativeFixture(t, {
      html: `<!doctype html><title>Native background animation</title><style>body{margin:0;min-height:900px}</style><h1>Owned native animation</h1><script>window.nativeMoves=[];addEventListener('mousemove',event=>nativeMoves.push({x:event.clientX,y:event.clientY,trusted:event.isTrusted}));</script>`,
      handleRequest(request, response) {
        if (request.url !== "/visual-idle-state") return false;
        let body = "";
        request.on("data", (data) => {
          body += data;
        });
        request.on("end", () => {
          facts.push(JSON.parse(body));
          response.writeHead(204);
          response.end();
        });
        return true;
      },
    });
    let result;
    try {
      result = await f.run(
        select +
          `
const url=context.input.base+'?background-animation';
const other=await selected.tabs.new(url,{active:false});await other.playwright.waitForURL(url);
await selected.tabs.select(tab.id);await selected.visibility.set(false);
const observed=await other.playwright.evaluate('() => new Promise(resolve=>{let painted=false;const frame=requestAnimationFrame(()=>{painted=true;});setTimeout(()=>{cancelAnimationFrame(frame);resolve({visibility:document.visibilityState,painted});},150);})');
await other.playwright.evaluate('async value=>{await fetch("/visual-idle-state",{method:"POST",body:JSON.stringify(value)});return true;}',observed);
await other.cua.move({x:180,y:140});
const actual=await other.playwright.evaluate('() => {const layer=document.querySelector("[data-nexum-visual-layer]");return {visibility:document.visibilityState,transform:layer?.style.transform,state:layer?.getAttribute("data-nexum-visual-state"),moves:window.nativeMoves};}');
const selectedId=(await selected.tabs.selected())?.id;await selected.visibility.set(true);
return {observed,actual,selectedId,originalId:tab.id};`,
        { base: f.base },
      );
    } finally {
      t.diagnostic(JSON.stringify({ pageFacts: facts }));
    }
    const data = result.result.data;
    assert.equal(data.observed.visibility, "hidden");
    assert.equal(data.actual.visibility, "hidden");
    assert.equal(data.selectedId, data.originalId);
    assert.equal(data.actual.state, "thinking");
    assert.match(data.actual.transform, /180px/);
    assert.match(data.actual.transform, /140px/);
    assert.ok(
      data.actual.moves.some(
        (move) => move.trusted && move.x === 180 && move.y === 140,
      ),
    );
    const nativePath = data.actual.moves.filter((move) => move.trusted);
    assert.ok(nativePath.length >= 3, "the actual page must receive intermediate native mousemove events");
    assert.ok(
      nativePath.slice(0, -1).some((move) => move.x !== 180 || move.y !== 140),
      "the real pointer must travel to the destination rather than teleport",
    );
    assert.deepEqual(
      { x: nativePath.at(-1).x, y: nativePath.at(-1).y },
      { x: 180, y: 140 },
    );
    assert.deepEqual(result.run.cleanup.unconfirmed, []);
    const native = await f.cleanupFacts();
    assert.deepEqual(native.owned, [], JSON.stringify(native));
    const next = await f.run(select + "return {title:await tab.title()};", {
      base: f.base,
    });
    assert.equal(next.result.data.title, "Native background animation");
  },
);

test(
  "native finished visual identities do not accumulate on an unchanged page",
  { timeout: 150000 },
  async (t) => {
    const f = await nativeFixture(t, {
      html: "<!doctype html><title>Visual identity lifecycle</title><h1>Owned test page</h1>",
    });
    let tabId;
    for (let i = 0; i < 4; i++) {
      const result = await f.run(
        select +
          `await tab.cua.move({x:42,y:64});return {tabId:tab.id,pointer:await tab.evaluate("!!document.querySelector('[data-nexum-visual-layer]')")};`,
        { base: f.base },
      );
      assert.deepEqual(result.run.cleanup.unconfirmed, []);
      assert.equal(
        result.result.data.pointer,
        true,
        JSON.stringify(result.result.data),
      );
      if (tabId === undefined) tabId = result.result.data.tabId;
      assert.equal(result.result.data.tabId, tabId);
      if (i < 3) await delay(350);
    }
    const facts = await f.cleanupFacts({ visualTabId: tabId });
    assert.deepEqual(facts.owned, [], JSON.stringify(facts));
    assert.equal(facts.visual?.hasCurrent, false, JSON.stringify(facts));
    assert.equal(typeof facts.visual?.closed, "number", JSON.stringify(facts));
    assert.ok(facts.visual.closed <= 1, JSON.stringify(facts));
    t.diagnostic(
      JSON.stringify({ retainedVisualIdentities: facts.visual.closed }),
    );
  },
);

test("native visual feedback preserves user groups and keeps AI markers after run cleanup and tab activation", async (t) => {
  const events = [];
  const f = await nativeFixture(t, {
    html: `<!doctype html><html><head><title>Native visual page</title><link id="original-icon" rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='green'/%3E%3C/svg%3E"></head><body><h1>Visual native page</h1><button id="click" onclick="this.textContent='Native pointer clicked'">Native pointer target</button><script>
      const report = () => {
        const layer=document.querySelector('[data-nexum-visual-layer]');
        const icon=document.querySelector('[data-nexum-visual-icon]');
        fetch('/visual-state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({at:Date.now(),url:location.href,layer:!!layer,icon:!!icon,href:icon?.href,original:document.querySelector('#original-icon').getAttribute('href')})}).catch(()=>{});
      };
      new MutationObserver(report).observe(document.documentElement,{attributes:true,childList:true,subtree:true});report();
    </script></body></html>`,
    handleRequest(request, response) {
      if (request.url !== "/visual-state") return false;
      let body = "";
      request.on("data", (data) => {
        body += data;
      });
      request.on("end", () => {
        events.push(JSON.parse(body));
        response.writeHead(204);
        response.end();
      });
      return true;
    },
  });
  const setup = await f.run(
    select +
      `await selected.nameSession('Native visual task');const other=await selected.tabs.new(context.input.base+'?visual-other',{active:false});await other.playwright.waitForURL(context.input.base+'?visual-other');const group=await selected.management.tabs.group({tabIds:[tab.id]});await selected.management.tabGroups.update(group.groupId,{title:'Existing user group',color:'green'});const observed=await selected.management.tabs.get(other.id);const otherGroup=observed.groupId>=0?await selected.management.tabGroups.get(observed.groupId):null;return {otherId:other.id,originalId:tab.id,userGroupId:group.groupId,priorOtherGroup:otherGroup};`,
    { base: f.base },
  );
  const ids = setup.result.data;
  const result = await f.run(
    select +
      `
      const other=await selected.tabs.get(context.input.otherId);
      await selected.nameSession('Another run must not rename a prior task');
      await selected.visibility.set(false);
      await selected.tabs.select(tab.id);
      const moveStarted=Date.now();await other.cua.move({x:42,y:64});const moveCompleted=Date.now();
      const stationary=await selected.tabs.selected();
      const pointer=await other.evaluate("(()=>{const e=document.querySelector('[data-nexum-visual-layer]');const css=e&&getComputedStyle(e);return {exists:!!e,width:css?.width,height:css?.height,pointerEvents:css?.pointerEvents,hidden:e?.getAttribute('aria-hidden'),role:e?.getAttribute('role'),transform:e?.style.transform,state:e?.getAttribute('data-nexum-visual-state'),icon:document.querySelector('[data-nexum-visual-icon]')?.href};})()");
      const nativeOther=await selected.management.tabs.get(other.id);
      const ownGroup=await selected.management.tabGroups.get(nativeOther.groupId);
      const preserved=await selected.management.tabGroups.get(context.input.userGroupId);
      const inventory=await other.assets.list();
      await selected.visibility.set(true);
      await other.cua.move({x:42,y:64});
      const followed=await selected.tabs.selected();
      await other.markDeliverable();
      return {pointer,moveStarted,moveCompleted,stationary:stationary.id,followed:followed.id,ownGroup,preserved,inventory};`,
    { base: f.base, ...ids },
  );
  const data = result.result.data;
  if (!data.pointer.exists) {
    await delay(250);
    t.diagnostic(
      JSON.stringify({
        moveStarted: data.moveStarted,
        moveCompleted: data.moveCompleted,
        visualDiagnostics: f.visualDiagnostics(),
        pageStates: events
          .slice(-10)
          .map(({ at, layer, icon }) => ({ at, layer, icon })),
      }),
    );
  }
  assert.equal(data.stationary, ids.originalId);
  assert.equal(data.followed, ids.otherId);
  assert.deepEqual(
    { ...data.pointer, icon: undefined },
    {
      exists: true,
      width: "24px",
      height: "24px",
      pointerEvents: "none",
      hidden: "true",
      role: "presentation",
      transform: "translate3d(42px, 64px, 0px)",
      state: "thinking",
      icon: undefined,
    },
  );
  assert.match(data.pointer.icon, /^data:image\/png;base64,/);
  // This group was already created by the previous Run. The new Run must
  // never rename another Run's preserved group, even after nameSession().
  assert.equal(ids.priorOtherGroup.title, "Native visual task");
  assert.equal(data.ownGroup.id, ids.priorOtherGroup.id);
  assert.equal(data.ownGroup.title, ids.priorOtherGroup.title);
  assert.equal(data.ownGroup.color, "blue");
  assert.equal(data.preserved.title, "Existing user group");
  assert.equal(data.preserved.color, "green");
  assert.equal(
    data.inventory.assets.some((asset) =>
      /nexum-visual/.test(JSON.stringify(asset)),
    ),
    false,
  );
  // Actual page-side DOM observation remains passive after Core has closed its run.
  const latest = () =>
    events.filter((event) => event.url === f.base + "?visual-other").at(-1);
  const until = Date.now() + 5000;
  while (!latest()?.icon || !latest()?.layer) {
    assert.ok(
      Date.now() < until,
      "The actual page did not retain its cursor and favicon after control release.",
    );
    await delay(10);
  }
  assert.notEqual(latest().href, data.pointer.icon);
  assert.match(latest().original, /^data:image\/svg\+xml,/);
  await f.run(
    `const {createBrowserClient}=await import('@nexum-hub/browser');const selected=await createBrowserClient(browser).browsers.get(context.input.fixtureBrowserId);await selected.tabs.select(context.input.originalId);await selected.tabs.select(context.input.otherId);`,
    ids,
  );
  assert.equal(latest().icon, true);
  assert.equal(latest().layer, true);
  assert.match(latest().original, /^data:image\/svg\+xml,/);
});
