import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { nativeFixture, select } from "./helpers/native.mjs";

test("native visual feedback preserves user groups, follows only when enabled and releases the real result marker on tab activation", async (t) => {
  const events = [];
  const f = await nativeFixture(t, {
    html: `<!doctype html><html><head><title>Native visual page</title><link id="original-icon" rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='green'/%3E%3C/svg%3E"></head><body><h1>Visual native page</h1><button id="click" onclick="this.textContent='Native pointer clicked'">Native pointer target</button><script>
      const report = () => {
        const layer=document.querySelector('[data-nexum-visual-layer]');
        const icon=document.querySelector('[data-nexum-visual-icon]');
        fetch('/visual-state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:location.href,layer:!!layer,icon:!!icon,href:icon?.href,original:document.querySelector('#original-icon').getAttribute('href')})}).catch(()=>{});
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
      `const other=await selected.tabs.new(context.input.base+'?visual-other',{active:false});await other.playwright.waitForURL(context.input.base+'?visual-other');const group=await selected.management.tabs.group({tabIds:[tab.id]});await selected.management.tabGroups.update(group.groupId,{title:'Existing user group',color:'green'});return {otherId:other.id,originalId:tab.id,userGroupId:group.groupId};`,
    { base: f.base },
  );
  const ids = setup.result.data;
  const result = await f.run(
    select +
      `
      const other=await selected.tabs.get(context.input.otherId);
      await selected.nameSession('Native visual task');
      await selected.visibility.set(false);
      await selected.tabs.select(tab.id);
      await other.cua.move({x:42,y:64});
      const stationary=await selected.tabs.selected();
      const pointer=await other.evaluate("(()=>{const e=document.querySelector('[data-nexum-visual-layer]');const css=e&&getComputedStyle(e);return {exists:!!e,width:css?.width,height:css?.height,pointerEvents:css?.pointerEvents,hidden:e?.getAttribute('aria-hidden'),role:e?.getAttribute('role'),transform:e?.style.transform,state:e?.getAttribute('data-nexum-visual-state'),icon:document.querySelector('[data-nexum-visual-icon]')?.href};})()");
      const nativeOther=await selected.management.tabs.get(other.id);
      const ownGroup=await selected.management.tabGroups.get(nativeOther.groupId);
      const preserved=await selected.management.tabGroups.get(context.input.userGroupId);
      const inventory=await other.assets.list();
      await selected.visibility.set(true);
      await other.title();
      const followed=await selected.tabs.selected();
      await other.markDeliverable();
      return {pointer,stationary:stationary.id,followed:followed.id,ownGroup,preserved,inventory};`,
    { base: f.base, ...ids },
  );
  const data = result.result.data;
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
  assert.equal(data.ownGroup.title, "Native visual task");
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
  while (!latest()?.icon || latest()?.layer) {
    assert.ok(
      Date.now() < until,
      "The actual page did not retain its result favicon after control release.",
    );
    await delay(10);
  }
  assert.notEqual(latest().href, data.pointer.icon);
  assert.match(latest().original, /^data:image\/svg\+xml,/);
  await f.run(
    `const {createBrowserClient}=await import('nexum-browser');const selected=await createBrowserClient(browser).browsers.getDefault();await selected.tabs.select(context.input.originalId);await selected.tabs.select(context.input.otherId);`,
    ids,
  );
  while (latest()?.icon || latest()?.layer) {
    assert.ok(
      Date.now() < until,
      "The native tab activation did not clear its result marker.",
    );
    await delay(10);
  }
  assert.match(latest().original, /^data:image\/svg\+xml,/);
});
