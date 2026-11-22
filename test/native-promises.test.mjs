import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the real host Worker audits caught, ignored, propagated and detached native rejections", () => {
  const base = new URL("../dist/", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module"], {
    input: `
      import assert from 'node:assert/strict';
      import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
      import {tmpdir} from 'node:os'; import path from 'node:path';
      import {ModuleLoader} from '${base}runtime/modules.js';
      import {HostRunner} from '${base}host/runner.js';
      const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'nexum-native-promises-')));
      const work=path.join(root,'work');mkdirSync(work);writeFileSync(path.join(work,'package.json'),'{}');
      const loader=await ModuleLoader.create(work,'audit',{builtins:()=>[],approvedPackages:()=>new Map()});
      const runner=new HostRunner(loader);const results=[];
      try {
        for(const [name,code] of [
          ['caught','try{await sdk.fail()}catch{}return 7;'],
          ['ignored','sdk.fail();return 7;'],
          ['propagated','sdk.fail().then(()=>{});return 7;'],
          ['detached','(async()=>{await sdk.fail()})();return 7;'],
          ['late-caught','const p=sdk.fail();await new Promise(r=>setTimeout(r,5));p.catch(()=>{});return 7;']]) {
          try { await runner.start({runId:name,code,context:{},bindings:{sdk:{fail:()=>Promise.reject(new Error('synthetic-sensitive-error'))}},
            onRootReturned(){},async settleOperations(){}});results.push([name,'succeeded']); }
          catch(error){results.push([name,error.code]);}
        }
        console.log(JSON.stringify(results));
      } finally {await runner.close();rmSync(root,{recursive:true,force:true});}
    `,
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), [
    ["caught", "succeeded"], ["ignored", "unhandled_async_error"],
    ["propagated", "unhandled_async_error"], ["detached", "unhandled_async_error"],
    ["late-caught", "succeeded"],
  ]);
  assert.doesNotMatch(child.stdout, /synthetic-sensitive-error/);
});

test("monitoring guest promises does not swallow an unrelated host rejection", () => {
  const entry = new URL("../dist/runtime/promises.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module"], {
    input: `import {NativePromiseAudit} from ${JSON.stringify(entry)};new NativePromiseAudit();Promise.reject(new Error('unowned-host-fault'));await new Promise(r=>setTimeout(r,20));`,
    encoding: "utf8", timeout: 10000,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /unowned-host-fault/);
});
