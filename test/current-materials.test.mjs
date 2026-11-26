import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installMaterialDirectory } from "../dist/runtime/current-materials.js";

test("current materials replace complete trees, discard failed candidates and remove retired files", (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nexum-current-materials-")));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const current = path.join(root,"sh");
  const make = (name, text) => {
    const dir = path.join(root,name);
    mkdirSync(dir);
    writeFileSync(path.join(dir,"SKILL.md"),text);
    return dir;
  };
  make("sh","old");
  writeFileSync(path.join(current,"obsolete.md"),"old ref");
  installMaterialDirectory(current,make(".prepare-first","new")).rollback();
  assert.equal(readFileSync(path.join(current,"SKILL.md"),"utf8"),"old");
  assert.equal(existsSync(path.join(current,"obsolete.md")),true);
  const installed = installMaterialDirectory(current,make(".prepare-second","new"));
  installed.commit();
  assert.equal(readFileSync(path.join(current,"SKILL.md"),"utf8"),"new");
  assert.equal(existsSync(path.join(current,"obsolete.md")),false);
  assert.deepEqual(readdirSync(root),["sh"]);
  installed.remove();
  assert.deepEqual(readdirSync(root),[]);
});

test("a redirected current path cannot replace an outside directory", (t) => {
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"nexum-current-materials-")));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const outside=path.join(root,"outside"), current=path.join(root,"sh"), stage=path.join(root,".prepare-stage");
  mkdirSync(outside); mkdirSync(stage);
  writeFileSync(path.join(outside,"SKILL.md"),"private");
  try { symlinkSync(outside,current,"junction"); } catch(e) { t.skip(String(e)); return; }
  assert.throws(()=>installMaterialDirectory(current,stage), {code:"material_path_escape", message:"A generated material directory cannot redirect."});
  assert.equal(readFileSync(path.join(outside,"SKILL.md"),"utf8"),"private");
});
