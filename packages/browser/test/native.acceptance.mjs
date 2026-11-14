import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { nativeFixture, select } from "./helpers/native.mjs";
test("native MV3 uses the public SDK through actual Core for page interaction, MCP JPEG and completed download", async (t) => {
  const f = await nativeFixture(t);
  const result = await f.run(
    select +
      'const before=await tab.playwright.domSnapshot();await tab.playwright.getByRole("textbox",{name:"Name"}).fill("Nexum native");await tab.playwright.getByRole("button",{name:"Submit"}).click();await tab.playwright.getByText("Hello Nexum native",{exact:true}).waitFor({state:"visible"});return {title:await tab.title(),answer:await tab.playwright.getByTestId("answer").innerText(),before};',
    { base: f.base },
  );
  assert.equal(result.result.data.title, "Nexum native acceptance");
  assert.equal(result.result.data.answer, "Hello Nexum native");
  assert.match(result.result.data.before, /Nexum native page/);
  const screenshot = await f.run(
    select + 'return await tab.ax.write("both");',
    { base: f.base },
  );
  assert.equal(screenshot.result.content[0].type, "text");
  assert.equal(screenshot.result.content[1].type, "image");
  const rendered = await f.encoder.render(
    screenshot.result,
    f.resultScope(),
    screenshot.run,
  );
  const image = rendered.content.find((value) => value.type === "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.ok(Buffer.from(image.data, "base64").length > 1000);
  assert.equal(Object.hasOwn(screenshot.result.content[1], "data"), false);
  const download = await f.run(
    select +
      'const pending=tab.playwright.waitForEvent("download");await tab.playwright.getByRole("link",{name:"Download native"}).click();const completed=await pending;return {path:await completed.path()};',
    { base: f.base },
  );
  assert.deepEqual(readFileSync(download.result.data.path), f.downloadBytes);
});

function png() {
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    name.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 120, 80, 20, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("native multiple-MIME ClipboardItem and AX Markdown paste/secondary actions preserve actual browser data", async (t) => {
  const f = await nativeFixture(t, {
    html: '<!doctype html><html><head><title>Native clipboard and AX</title></head><body><label><input id="check" type="checkbox">Confirm native</label><div role="textbox" aria-label="Rich editor" data-testid="editor" contenteditable="true" style="width:600px;height:120px;border:1px solid"></div></body></html>',
  });
  const result = await f.run(
    select +
      `let stage="read-original",original=[];try{original=(await tab.clipboard.read()).filter(item=>item.entries.length);stage="write-mixed";await tab.clipboard.write([{entries:[{mimeType:"text/plain",text:"Nexum native clipboard"},{mimeType:"text/html",text:"<b>Nexum native clipboard</b>"},{mimeType:"image/png",data:new Uint8Array(context.input.png)}]}]);stage="read-mixed";const read=await tab.clipboard.read();const summary=read.flatMap(item=>item.entries.map(entry=>({mimeType:entry.mimeType,...(entry.text===undefined?{size:entry.data.byteLength,signature:Array.from(entry.data.subarray(0,8))}:{text:entry.text})})));stage="ax-snapshot";const observed=await tab.ax.snapshot();const checkbox=observed.nodes.find(node=>node.name==="Confirm native");if(!checkbox)throw new Error("Native AX checkbox was not observed");stage="ax-toggle";await tab.ax.performSecondaryAction(checkbox.index,"Toggle");const checked=await tab.evaluate("document.querySelector('#check').checked");const next=await tab.ax.snapshot();const editor=next.nodes.find(node=>node.name==="Rich editor");if(!editor)throw new Error("Native AX editor was not observed");stage="ax-markdown-paste";await tab.ax.paste(editor.index,"**native bold**",{format:"md"});return {summary,checked,html:await tab.evaluate("document.querySelector('[data-testid=editor]').innerHTML")};}catch(error){return {failed:{stage,code:error.code,message:error.message}};}finally{if(original.length)await tab.clipboard.write(original);else await tab.clipboard.writeText("");}`,
    { base: f.base, png: [...png()] },
  );
  const data = result.result.data;
  assert.equal(data.failed, undefined, JSON.stringify(data.failed));
  assert.equal(data.checked, true);
  assert.match(data.html, /<strong>native bold<\/strong>/);
  assert.ok(
    data.summary.some(
      (entry) =>
        entry.mimeType === "text/plain" &&
        entry.text === "Nexum native clipboard",
    ),
  );
  assert.ok(
    data.summary.some(
      (entry) =>
        entry.mimeType === "text/html" &&
        entry.text.includes("<b>Nexum native clipboard</b>"),
    ),
  );
  assert.deepEqual(
    data.summary.find((entry) => entry.mimeType === "image/png").signature,
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
});

test("native explicit input continuation issues a new tab epoch, rejects old handles and leaves another controlled tab intact", async (t) => {
  const f = await nativeFixture(t);
  const setup = await f.run(
    'const {createBrowserClient}=await import("nexum-browser");const client=createBrowserClient(browser);const selected=await client.browsers.getDefault();const other=await selected.tabs.new(context.input.base+"?other",{active:false});return {otherId:other.id};',
    { base: f.base },
  );
  const otherId = setup.result.data.otherId;
  let state = await f.start(
    select +
      `const other=await selected.tabs.get(context.input.otherId);await other.playwright.getByRole("textbox",{name:"Name"}).fill("Other preserved");const before=await tab.snapshot();const find=node=>node.role==="textbox"?node.ref:node.children?.map(find).find(Boolean);const ref=find(before.root);const oldLocator=tab.playwright.getByRole("textbox",{name:"Name"});await tab.requestUserTakeover("user_requested");const errors={};try{await tab.title();}catch(error){errors.oldTab=error.code;}try{await oldLocator.fill("must not happen");}catch(error){errors.oldLocator=error.code;}const fresh=await selected.tabs.get(tab.id);try{await fresh.fill(ref,"must not happen");}catch(error){errors.oldRef=error.code;}const freshSnapshot=await fresh.snapshot();await fresh.playwright.getByRole("textbox",{name:"Name"}).fill("Fresh epoch");return {errors,freshTitle:await fresh.title(),freshObserved:!!freshSnapshot.root,otherValue:await other.evaluate("document.querySelector('#name').value"),value:await fresh.evaluate("document.querySelector('#name').value")};`,
    { base: f.base, otherId },
  );
  const deadline = Date.now() + 15000;
  while (!state.wait) {
    assert.ok(Date.now() < deadline, JSON.stringify(state.run));
    state = await f.observe(state.run.runId);
  }
  const held = await f.run(
    'const {createBrowserClient}=await import("nexum-browser");const selected=await createBrowserClient(browser).browsers.getDefault();const other=await selected.tabs.get(context.input.otherId);try{await other.title();return {unexpected:true};}catch(error){return {code:error.code};}',
    { otherId },
  );
  assert.equal(held.result.data.code, "TAB_ALREADY_CLAIMED");
  const user = await f.run(
    select +
      'await tab.playwright.getByRole("textbox",{name:"Name"}).fill("User completed");return {value:await tab.evaluate("document.querySelector(\'#name\').value")};',
    { base: f.base },
  );
  assert.equal(user.result.data.value, "User completed");
  await f.input(state.run.runId, state.wait.waitId, { confirmed: true });
  while (state.run.endedAt === null) {
    assert.ok(Date.now() < deadline, "explicit continuation failed to settle");
    state = await f.observe(state.run.runId);
  }
  assert.equal(state.run.status, "succeeded", JSON.stringify(state.run.error));
  const data = state.result.data;
  assert.equal(data.errors.oldTab, "STALE_REF");
  assert.equal(data.errors.oldLocator, "STALE_REF");
  assert.equal(data.errors.oldRef, "STALE_REF");
  assert.equal(data.freshObserved, true);
  assert.equal(data.value, "Fresh epoch");
  assert.equal(data.otherValue, "Other preserved");
  await f.run(
    'const {createBrowserClient}=await import("nexum-browser");const selected=await createBrowserClient(browser).browsers.getDefault();await(await selected.tabs.get(context.input.otherId)).close();',
    { otherId },
  );
});

test("native declined, cancelled, expired and revoked continuations never renew browser control", async (t) => {
  let permitted = true;
  const f = await nativeFixture(t, {
    authorize(policy) {
      const target = policy.target;
      if (
        target?.type === "connection" &&
        target.access === "control" &&
        !permitted
      )
        throw Object.assign(new Error("Current browser control was revoked."), {
          code: "forbidden",
        });
    },
  });
  const wait = async (state) => {
    const limit = Date.now() + 5000;
    while (!state.wait && state.run.endedAt === null) {
      assert.ok(Date.now() < limit, "input wait did not become ready");
      state = await f.observe(state.run.runId);
    }
    assert.ok(state.wait, JSON.stringify(state.run));
    return state;
  };
  const finish = async (state) => {
    const limit = Date.now() + 5000;
    while (state.run.endedAt === null) {
      assert.ok(Date.now() < limit, "continuation did not close");
      state = await f.observe(state.run.runId);
    }
    return state;
  };
  let denied = await wait(
    await f.start(
      select +
        "let refusal;try{await tab.requestUserTakeover();}catch(error){refusal=error.code;}let after;try{await tab.title();}catch(error){after=error.code;}return {refusal,after};",
      { base: f.base },
    ),
  );
  await f.input(denied.run.runId, denied.wait.waitId, { confirmed: false });
  denied = await finish(denied);
  assert.equal(denied.run.status, "succeeded");
  assert.deepEqual(denied.result.data, {
    refusal: "USER_TAKEOVER",
    after: "USER_TAKEOVER",
  });
  let cancelled = await wait(
    await f.start(
      select + "await tab.requestUserTakeover();return {unexpected:true};",
      { base: f.base },
    ),
  );
  const cancelledWaitId = cancelled.wait.waitId;
  f.cancel(cancelled.run.runId);
  cancelled = await finish(cancelled);
  assert.equal(cancelled.run.status, "cancelled");
  await assert.rejects(
    f.input(cancelled.run.runId, cancelledWaitId, { confirmed: true }),
  );
  let expired = await wait(
    await f.start(
      select + "await tab.requestUserTakeover();return {unexpected:true};",
      { base: f.base },
      { timeoutMs: 500 },
    ),
  );
  expired = await finish(expired);
  assert.equal(expired.run.status, "failed");
  assert.equal(expired.run.stop.kind, "deadline");
  let revoked = await wait(
    await f.start(
      select +
        "try{await tab.requestUserTakeover();return {unexpected:true};}catch(error){return {code:error.code};}",
      { base: f.base },
    ),
  );
  permitted = false;
  await f.input(revoked.run.runId, revoked.wait.waitId, { confirmed: true });
  revoked = await finish(revoked);
  assert.equal(revoked.run.status, "succeeded");
  assert.equal(revoked.result.data.code, "forbidden");
  permitted = true;
  const ready = await f.run(select + "return {title:await tab.title()};", {
    base: f.base,
  });
  assert.equal(ready.result.data.title, "Nexum native acceptance");
});

test("native page inventories, embedded SVG, partial downloads, real PDF/HTML/Markdown and temporary batch pages produce fixed files", async (t) => {
  const image = png(),
    requests = new Map();
  const f = await nativeFixture(t, {
    html: '<!doctype html><html><head><title>Native document export</title><link rel="stylesheet" href="/style.css"></head><body><h1>Native export heading</h1><p><strong>Real document</strong> with <a href="/article">link</a>.</p><img alt="Native pixel" src="/pixel.png"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="blue"/></svg><script src="/app.js"></script></body></html>',
    handleRequest(req, res) {
      requests.set(req.url, (requests.get(req.url) ?? 0) + 1);
      if (req.url === "/pixel.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(image);
        return true;
      }
      if (req.url === "/style.css") {
        res.writeHead(200, { "Content-Type": "text/css" });
        res.end("body{font-family:sans-serif;color:#123456}");
        return true;
      }
      if (req.url === "/app.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end("globalThis.nativeAssetLoaded=true");
        return true;
      }
      if (req.url === "/missing") {
        res.writeHead(404);
        res.end("missing");
        return true;
      }
      if (req.url === "/long") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!doctype html><title>Long native page</title><p>" +
            "A".repeat(5000) +
            "</p>",
        );
        return true;
      }
      return false;
    },
  });
  const result = await f.run(
    select +
      `const inventory=await tab.assets.list();const bundle=await tab.assets.bundle({inventoryId:inventory.id,kinds:["image","stylesheet"]});const downloaded=await tab.assets.download([context.input.base+"pixel.png",context.input.base+"missing"]);const html=await tab.exportFile({format:"html"});const markdown=await tab.exportFile({format:"markdown"});const pdf=await tab.exportFile({format:"pdf"});const prior=(await selected.tabs.list()).length;const batch=await selected.tabs.content({urls:[context.input.base,context.input.base+"long"],contentType:"text",timeoutMs:10000});const after=(await selected.tabs.list()).length;return {inventory,bundle,downloaded,html,markdown,pdf,batch,prior,after};`,
    { base: f.base },
  );
  const data = result.result.data;
  assert.ok(data.inventory.assets.length >= 3);
  assert.equal(data.bundle.failures.length, 0);
  assert.ok(data.bundle.assets.length >= 2);
  assert.equal(data.bundle.summary.downloadedCount, data.bundle.assets.length);
  assert.ok(
    data.bundle.assets.some((asset) => asset.mimeType === "image/svg+xml"),
  );
  const manifest = JSON.parse(readFileSync(data.bundle.manifestPath, "utf8"));
  assert.equal(manifest.assets.length, data.bundle.assets.length);
  for (const artifact of data.bundle.assets) {
    assert.equal(readFileSync(artifact.path).length, artifact.size);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(data.downloaded.files.length, 1);
  assert.deepEqual(readFileSync(data.downloaded.files[0].path), image);
  assert.equal(data.downloaded.failures.length, 1);
  assert.match(
    readFileSync(data.html.path, "utf8"),
    /<h1>Native export heading<\/h1>/,
  );
  assert.match(
    readFileSync(data.markdown.path, "utf8"),
    /# Native export heading/,
  );
  assert.match(
    readFileSync(data.markdown.path, "utf8"),
    /\*\*Real document\*\*/,
  );
  assert.doesNotMatch(
    readFileSync(data.markdown.path, "utf8"),
    /nativeAssetLoaded/,
  );
  assert.equal(readFileSync(data.pdf.path).subarray(0, 5).toString(), "%PDF-");
  assert.ok(readFileSync(data.pdf.path).length > 1000);
  assert.equal(data.batch.length, 2);
  assert.match(data.batch[0].content, /Native export heading/);
  assert.equal(data.batch[1].content.length, 4096);
  assert.equal(data.batch[1].truncated, true);
  assert.equal(data.prior, data.after);
});

test("native tab creation retains only its exact target after the confirmed browser mutation and leaves a handed-off tab available", async (t) => {
  const f = await nativeFixture(t);
  let state = await f.start(
    select +
      'const created=await selected.tabs.new(context.input.base+"?created-in-run",{active:false});await created.playwright.waitForURL(context.input.base+"?created-in-run");await created.title();await tab.requestUserTakeover();return {other:await created.title()};',
    { base: f.base },
  );
  const limit = Date.now() + 10000;
  while (!state.wait) {
    assert.ok(Date.now() < limit, JSON.stringify(state.run));
    state = await f.observe(state.run.runId);
  }
  const user = await f.run(
    select +
      'await tab.playwright.getByRole("textbox",{name:"Name"}).fill("Handed off target available");const all=await selected.tabs.list();const owned=await selected.tabs.get(all.find(item=>item.id!==tab.id).id);let conflict;try{await owned.title();}catch(error){conflict=error.code;}return {value:await tab.evaluate("document.querySelector(\'#name\').value"),conflict,ownedId:owned.id};',
    { base: f.base },
  );
  assert.equal(user.result.data.value, "Handed off target available");
  assert.equal(user.result.data.conflict, "TAB_ALREADY_CLAIMED");
  await f.input(state.run.runId, state.wait.waitId, { confirmed: true });
  while (state.run.endedAt === null) {
    assert.ok(Date.now() < limit);
    state = await f.observe(state.run.runId);
  }
  assert.equal(state.run.status, "succeeded", JSON.stringify(state.run.error));
  assert.equal(state.result.data.other, "Nexum native acceptance");
  await f.run(
    'const {createBrowserClient}=await import("nexum-browser");const selected=await createBrowserClient(browser).browsers.getDefault();const tabs=await selected.tabs.list();await(await selected.tabs.get(context.input.ownedId)).close();',
    { base: f.base, ownedId: user.result.data.ownedId },
  );
});
