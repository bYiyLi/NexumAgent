import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileInputSchema } from "../../../dist/contracts/validation.js";
import { scriptHeader } from "../../../dist/runtime/scripts.js";

const source = await readFile(new URL("../scripts/screenshot.js", import.meta.url), "utf8");
const metadata = scriptHeader(source);
assert.ok(metadata);
assert.deepEqual(scriptHeader(source.replace(/\r?\n/g,"\r\n")),metadata);
const validate = compileInputSchema(metadata.scriptInputSchema);
const execute = new (Object.getPrototypeOf(async function () {}).constructor)("context", "browser", source);
const ids = { browserId: "browser-a", tabId: "9" };
const target = { ...ids, bootId: "boot-a", browserSessionId: "session-a", generation: 2 };
const info = { id: ids.browserId, name: "Fixture", type: "extension", status: "online",
  bootId: target.bootId, browserSessionId: target.browserSessionId, generation: target.generation };
function fixture(errors = {}) {
  const calls = [], image = Uint8Array.of(255,216,255,217);
  const browser = {
    browsers: { get: async input => {
      calls.push(["browsers.get", input]);
      if (errors.browser) throw errors.browser;
      return info;
    }},
    tabs: { get: async input => {
      calls.push(["tabs.get", input]);
      if (errors.tab) throw errors.tab;
      return { id: ids.tabId, target };
    }},
    tab: { screenshot: async input => {
      calls.push(["tab.screenshot", input]);
      if (errors.screenshot) throw errors.screenshot;
      return image;
    }},
  };
  return { calls, image, async run(input) {
    validate(input);
    return execute({input}, browser);
  }};
}

test("screenshot keeps the existing viewport input and returns the exact native byte view", async () => {
  const f = fixture();
  assert.equal(await f.run(ids), f.image);
  assert.deepEqual(f.calls.map(([method])=>method), ["browsers.get","tabs.get","tab.screenshot"]);
  assert.deepEqual(f.calls[0][1], {id:ids.browserId});
  assert.equal(f.calls[1][1].id, ids.tabId);
  assert.deepEqual(f.calls[2][1].target, target);
  assert.deepEqual(f.calls[2][1].options, {});
});

test("screenshot forwards the full-page and document clip options without changing limits or targets", async () => {
  for (const options of [
    {fullPage:true, quality:100, maxEdgePx:24000},
    {clip:{x:1.5,y:200,width:320.5,height:90},quality:0,maxEdgePx:1},
    {fullPage:false,clip:{x:0,y:0,width:100,height:100},maxEdgePx:1200},
  ]) {
    const f=fixture();
    assert.equal(await f.run({...ids,...options}),f.image);
    assert.equal(f.calls.length,3);
    assert.deepEqual(f.calls[2][1],{target,options});
  }
});

test("screenshot rejects invalid input before selecting a browser or requesting capture", async () => {
  const clip={x:0,y:0,width:100,height:100};
  for (const input of [
    {}, {browserId:ids.browserId}, {...ids,browserId:""}, {...ids,tabId:9},
    {...ids,fullPage:"true"}, {...ids,clip:null}, {...ids,clip:{...clip,x:-1}},
    {...ids,clip:{...clip,y:-1}}, {...ids,clip:{...clip,width:0}},
    {...ids,clip:{...clip,height:-1}}, {...ids,clip:{x:0,y:0,width:100}},
    {...ids,clip:{...clip,scale:2}}, {...ids,fullPage:true,clip},
    {...ids,quality:-1}, {...ids,quality:101}, {...ids,quality:80.1},
    {...ids,maxEdgePx:0}, {...ids,maxEdgePx:1.1},
    {...ids,path:"unrequested"}, {...ids,format:"png"},
  ]) {
    const f=fixture();
    await assert.rejects(f.run(input), {code:"invalid_arguments"});
    assert.deepEqual(f.calls,[]);
  }
});

test("screenshot preserves original SDK errors and never retries or switches targets", async () => {
  for (const [stage,code,calls] of [
    ["browser","EXTENSION_OFFLINE",1], ["tab","TARGET_GONE",2],
    ["screenshot","INVALID_ARGUMENT",3], ["screenshot","OUTPUT_TOO_LARGE",3],
    ["screenshot","POLICY_DENIED",3], ["screenshot","run_cancelled",3],
    ["screenshot","TIMEOUT",3],
  ]) {
    const error=Object.assign(Error("actual failure"),{code});
    const f=fixture({[stage]:error});
    await assert.rejects(f.run(ids), cause=>cause===error);
    assert.equal(f.calls.length,calls);
  }
});

test("screenshot publishes the actual options and native media delivery contract", () => {
  assert.equal(metadata.scriptOpenDefault,false);
  assert.equal(metadata.scriptOutputSchema,undefined);
  for (const phrase of ["{browserId,tabId,fullPage?,clip?,quality?,maxEdgePx?}","browser/discover.js",
    "quality=75","原始像素密度，不自动缩放","文档 CSS 坐标","不得同时使用 fullPage:true 和 clip",
    "0–100","显式传正整数 maxEdgePx","不设额外最长边、总像素或 JPEG 字节预算","权限拒绝不绕过","不包装 JSON、Base64 或本机路径","失败不使用旧图替代"]) {
    assert.ok(metadata.scriptDesc.includes(phrase),"missing invocation guidance: "+phrase);
  }
});
