import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, readdir, rm, writeFile, cp, mkdir, chmod, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preparePlugin } from "../dist/extension/assets.js";
import { inspectInstallation, formatInstallationInspection } from "../dist/client/installation.js";
import { buildExtensions } from "../browser-extension/build.mjs";
import { assetRevision, profileSource, revisionSource } from "../browser-extension/asset-revision.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scriptHeader } from "../../../dist/runtime/scripts.js";

const body = await readFile(new URL("../scripts/installation.js",import.meta.url),"utf8");
const run = new (Object.getPrototypeOf(async function(){}).constructor)("context",body);
async function expectFailure(context, reason) {
  const result = await inspectInstallation(context.paths?.work, context.profile);
  assert.deepEqual(result, { assetsReady: false, code: "browser_assets_unavailable", reason });
  const report = await run(context);
  assert.equal(report, formatInstallationInspection(result));
  assert.match(report, /^Installation assets: unavailable/);
  assert.match(report, /Browser extension installation: unknown/);
  assert.doesNotMatch(report, /Directory:|## Install or reload|Load unpacked/);
}
for (const profile of ["development","production"]) {
  test("installation script reports verified stable assets: "+profile, async t => {
    const work=await realpath(await mkdtemp(path.join(os.tmpdir(),"nexum-browser-install-")));
    t.after(()=>rm(work,{recursive:true,force:true}));
    const context={paths:{work},profile};
    await expectFailure(context, "assets_not_prepared");
    const built=await preparePlugin({context,authorize(){}},new AbortController().signal);
    const found=await inspectInstallation(work,profile);
    assert.equal(found.assetsReady,true);
    assert.equal(found.directory,built.directory);
    assert.equal(found.profile,profile);
    assert.equal(found.extensionVersion,built.extensionVersion);
    assert.equal(found.assetRevision,built.assetRevision);
    assert.equal(found.extensionId,built.extensionId);
    const report=await run(context);
    assert.match(report, /^Installation assets: ready/);
    assert.ok(report.includes("Directory: "+built.directory));
    assert.ok(report.includes("Profile: "+profile));
    assert.ok(report.includes("Extension version: "+built.extensionVersion));
    assert.ok(report.includes("Expected asset revision: "+built.assetRevision));
    assert.ok(report.includes("Extension ID: "+built.extensionId));
    assert.match(report,/Browser extension installation: unknown/);
    assert.match(report,/chrome:\/\/extensions/);
    assert.match(report,/edge:\/\/extensions/);
    assert.match(report,/If absent, enable Developer mode, choose Load unpacked/);
    assert.match(report,/If the matching extension is disabled, enable it/);
    assert.match(report,/If its build is confirmed incompatible or reload was explicitly requested/);
    assert.match(report,/A matching connected build needs no reload unless requested/);
    assert.match(report,/a past npm update alone does not establish mismatch/);
    assert.match(report,/If status is unknown, check it before choosing an action/);
    assert.match(report,/browser\/discover\.js/);
    await expectFailure({...context,profile:profile==="production"?"development":"production"},"profile_mismatch");
    const descriptor=JSON.parse(await readFile(path.join(built.directory,"nexum-installation.json"),"utf8"));
    assert.equal(Object.hasOwn(descriptor,"directory"),false);
    assert.match(descriptor.assetRevision,/^[0-9a-f]{64}$/);
    assert.equal(descriptor.assetRevision,built.assetRevision);
    const router=path.join(built.directory,"router.js");
    const original=await readFile(router);
    await writeFile(router,Buffer.concat([original,Buffer.from("\n// changed code")]));
    await expectFailure(context,"integrity_mismatch");
    await writeFile(router,original);
    assert.equal((await inspectInstallation(work,profile)).assetsReady,true);
    await writeFile(path.join(built.directory,"manifest.json"),"{}", "utf8");
    await expectFailure(context,"asset_invalid");
  });
}

async function prepared(t) {
  const work=await realpath(await mkdtemp(path.join(os.tmpdir(),"nexum-browser-inspect-")));
  t.after(()=>rm(work,{recursive:true,force:true}));
  const context={paths:{work},profile:"development"};
  const built=await preparePlugin({context,authorize(){}},new AbortController().signal);
  return {context,built};
}

test("installation distinguishes missing assets, invalid descriptors and unsafe paths without leaking them",async t=>{
  const {context,built}=await prepared(t);
  await expectFailure({},"invalid_context");
  await expectFailure({...context,profile:"unknown"},"invalid_context");
  const descriptorPath=path.join(built.directory,"nexum-installation.json");
  const descriptor=JSON.parse(await readFile(descriptorPath,"utf8"));
  const worker=path.join(built.directory,"worker.js");
  const bytes=await readFile(worker);
  await rm(worker);
  await expectFailure(context,"asset_missing");
  await writeFile(worker,bytes);
  await rm(descriptorPath);
  await expectFailure(context,"asset_missing");
  await writeFile(descriptorPath,JSON.stringify({...descriptor,files:descriptor.files.filter(name=>name!=="worker.js")}));
  await expectFailure(context,"asset_missing");
  await writeFile(descriptorPath,"not JSON");
  await expectFailure(context,"asset_invalid");
  await writeFile(descriptorPath,JSON.stringify({...descriptor,files:[...descriptor.files,"../private-token.txt"]}));
  await expectFailure(context,"unsafe_asset_path");
  assert.doesNotMatch(await run(context),/private-token/);
  await writeFile(descriptorPath,JSON.stringify(descriptor));
  const moved=built.directory+"-fixture";
  await rename(built.directory,moved);
  await symlink(moved,built.directory,"junction");
  await expectFailure(context,"unsafe_asset_path");
  await rm(built.directory);
  await rename(moved,built.directory);
  assert.equal((await inspectInstallation(context.paths.work,context.profile)).assetsReady,true);
});

test("a self-consistent stable asset generation from a different build is not accepted",async t=>{
  const {context,built}=await prepared(t);
  const descriptorPath=path.join(built.directory,"nexum-installation.json");
  const descriptor=JSON.parse(await readFile(descriptorPath,"utf8"));
  const assets=new Map(await Promise.all(descriptor.files.map(async name=>[name,await readFile(path.join(built.directory,name))])));
  const source=profileSource(descriptor.profile,descriptor.extensionVersion);
  assets.set("profile.js",source);
  const altered=Buffer.concat([assets.get("router.js"),Buffer.from("\n// another generation")]);
  assets.set("router.js",altered);
  const revision=assetRevision(assets);
  await writeFile(path.join(built.directory,"router.js"),altered);
  await writeFile(path.join(built.directory,"profile.js"),source+revisionSource(revision));
  await writeFile(descriptorPath,JSON.stringify({...descriptor,assetRevision:revision}));
  await expectFailure(context,"build_mismatch");
});

test("unreadable assets retain a read failure, not an incorrect integrity or installation diagnosis",
  {skip:process.platform==="win32"||process.getuid?.()===0},async t=>{
    const {context,built}=await prepared(t);
    const target=path.join(built.directory,"router.js");
    await chmod(target,0);
    try { await expectFailure(context,"asset_read_failed"); }
    finally { await chmod(target,0o600); }
  });

test("installation metadata and all diagnostic labels describe only observed evidence",()=>{
  const meta=scriptHeader(body);
  assert.ok(meta);
  assert.deepEqual(scriptHeader(body.replace(/\r?\n/g,"\r\n")),meta);
  assert.deepEqual(meta.scriptInputSchema,{type:"object",additionalProperties:false});
  assert.equal(meta.scriptOutputSchema.type,"string");
  assert.equal(meta.scriptOpenDefault,true);
  for(const phrase of ["输入 {}", "无需在线浏览器", "完整 Extension ID", "资产就绪不证明插件已安装", "browser/discover.js", "有证据的 Reason", "脚本未登记时", "不自动安装"]){
    assert.ok(meta.scriptDesc.includes(phrase),"missing invocation guidance: "+phrase);
  }
  for(const reason of ["invalid_context","assets_not_prepared","asset_missing","asset_invalid","unsafe_asset_path","profile_mismatch","integrity_mismatch","build_mismatch","assets_changed","asset_read_failed","inspection_failed"]){
    const report=formatInstallationInspection({assetsReady:false,code:"browser_assets_unavailable",reason});
    assert.ok(report.includes("Reason: "+reason));
    assert.doesNotMatch(report,/undefined|Directory:|Load unpacked/);
    if(reason==="build_mismatch"){
      assert.match(report,/If a restart is still required and authorized/);
      assert.match(report,/Do not reload stale assets/);
    }
  }
});

test("build revisions are deterministic, profile-specific and bound to actual asset bytes",async t=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"nexum-build-revision-")));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const first=path.join(root,"first"),second=path.join(root,"second");
  const release=await buildExtensions(first);
  await buildExtensions(second);
  const revisions=[];
  for(const profile of ["development","production"]){
    const files=await readdir(path.join(first,profile));
    const assets=new Map(await Promise.all(files.map(async name=>[name,await readFile(path.join(first,profile,name))])));
    const expected=await readFile(path.join(second,profile,"profile.js"),"utf8");
    assert.equal(assets.get("profile.js").toString("utf8"),expected);
    const source=profileSource(profile,release.extensionVersion);
    assets.set("profile.js",source);
    const revision=assetRevision(assets);
    assert.equal(expected,source+revisionSource(revision));
    assert.equal(assetRevision(new Map([...assets].reverse())),revision);
    assets.set("router.js",Buffer.concat([assets.get("router.js"),Buffer.from("\n// different build")]));
    assert.notEqual(assetRevision(assets),revision);
    revisions.push(revision);
  }
  assert.notEqual(...revisions);
});

test("a tampered package build cannot replace the previously published stable assets",async t=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"nexum-tampered-build-")));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const work=path.join(root,"work"),pkg=path.join(root,"package");
  await mkdir(work);await mkdir(pkg);
  const context={paths:{work},profile:"development"};
  const host={context,authorize(){}};
  const built=await preparePlugin(host,new AbortController().signal);
  const original=await readFile(path.join(built.directory,"profile.js"),"utf8");
  const source=fileURLToPath(new URL("../",import.meta.url));
  await cp(path.join(source,"dist","extension"),path.join(pkg,"dist","extension"),{recursive:true});
  await cp(path.join(source,"browser-extension"),path.join(pkg,"browser-extension"),{recursive:true});
  await writeFile(path.join(pkg,"package.json"),'{"type":"module"}');
  const router=path.join(pkg,"browser-extension","dist","development","router.js");
  await writeFile(router,Buffer.concat([await readFile(router),Buffer.from("\n// mismatched asset")]));
  const altered=await import(pathToFileURL(path.join(pkg,"dist","extension","assets.js")).href);
  await assert.rejects(altered.preparePlugin(host,new AbortController().signal),{code:"PROTOCOL_MISMATCH"});
  assert.equal(await readFile(path.join(built.directory,"profile.js"),"utf8"),original);
  assert.equal((await inspectInstallation(work,context.profile)).assetsReady,true);
});
