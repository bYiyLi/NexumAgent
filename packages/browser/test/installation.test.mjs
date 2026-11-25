import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preparePlugin } from "../dist/extension/assets.js";

const body = await readFile(new URL("../scripts/installation.js",import.meta.url),"utf8");
const run = new (Object.getPrototypeOf(async function(){}).constructor)("context",body);
for (const profile of ["development","production"]) {
  test("installation script reports verified stable assets: "+profile, async t => {
    const work=await realpath(await mkdtemp(path.join(os.tmpdir(),"nexum-browser-install-")));
    t.after(()=>rm(work,{recursive:true,force:true}));
    const context={paths:{work},profile};
    assert.deepEqual(await run(context),{assetsReady:false,code:"browser_assets_unavailable"});
    const built=await preparePlugin({context,authorize(){}},new AbortController().signal);
    const found=await run(context);
    assert.equal(found.assetsReady,true);
    assert.equal(found.directory,built.directory);
    assert.equal(found.profile,profile);
    assert.equal(found.extensionVersion,built.extensionVersion);
    assert.equal(found.extensionId,built.extensionId);
    const descriptor=JSON.parse(await readFile(path.join(built.directory,"nexum-installation.json"),"utf8"));
    assert.equal(Object.hasOwn(descriptor,"directory"),false);
    await writeFile(path.join(built.directory,"manifest.json"),"{}", "utf8");
    assert.equal((await run(context)).assetsReady,false);
  });
}
