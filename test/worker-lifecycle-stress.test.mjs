import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { HostRunner } from "../dist/host/runner.js";
import { ModuleLoader } from "../dist/runtime/modules.js";

// This is a reproducible isolated Host/Worker load test, not production
// admission tuning. The normal CI smoke gate stays small. Larger workloads
// are explicitly selected on a machine with independently verified headroom.
const stress = process.env.NEXUM_TEST_WORKER_STRESS === "1";
function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, name);
  return value;
}
const sequential = stress ? integer("NEXUM_TEST_WORKER_SEQUENTIAL",1000,1,100000) : 8;
const batches = stress ? integer("NEXUM_TEST_WORKER_BATCHES",50,1,10000) : 2;
const width = stress ? integer("NEXUM_TEST_WORKER_WIDTH",20,1,256) : 4;
const heldLevels = stress
  ? (process.env.NEXUM_TEST_WORKER_HELD_LEVELS ?? "1,8,20").split(",").map(Number)
  : [4];
assert.ok(heldLevels.every(n => Number.isSafeInteger(n) && n > 0 && n <= 256));
const deadline = stress ? 20 * 60_000 : 60_000;

function sample(stage, extra = {}) {
  const m = process.memoryUsage();
  const resources = process.getActiveResourcesInfo();
  const counts = Object.fromEntries([...new Set(resources)].sort().map(name => [
    name, resources.filter(value => value === name).length,
  ]));
  return {stage, rssMiB: Math.round(m.rss / 1048576 * 10) / 10,
    heapUsedMiB: Math.round(m.heapUsed / 1048576 * 10) / 10,
    externalMiB: Math.round(m.external / 1048576 * 10) / 10,
    arrayBuffersMiB: Math.round(m.arrayBuffers / 1048576 * 10) / 10,
    activeResources: counts, ...extra};
}

test("isolated HostRunner releases original Worker identities across repeated runs and held batches",
  {timeout: deadline}, async t => {
    const work = await realpath(await mkdtemp(path.join(tmpdir(),"nexum-worker-lifecycle-")));
    await writeFile(path.join(work,"package.json"),'{"private":true,"type":"module"}');
    const loader = await ModuleLoader.create(work,"boot_"+randomUUID().replaceAll(/-/g,""),{
      builtins:()=>[],approvedPackages:()=>new Map(),
    });
    const runner = new HostRunner(loader);
    // The loader itself owns a persistent runtime directory. Only additional
    // per-Worker directories must disappear when their execution ends.
    const runtimeRoot = path.join(work,"tmp","runtime");
    const sharedRoots = (await readdir(runtimeRoot)).sort();
    const active = new Set();
    let created=0, terminated=0, peak=0, sequence=0;
    const cancelled = new AbortController();
    let diagnosticError;
    let sampleTimer;
    let rssPeak = process.memoryUsage.rss();
    function onDiagnostic(event) {
      // Diagnostic callbacks are deliberately caught by the production code;
      // record any invariant violation and assert it from the test owner.
      try {
        if (event.stage === "spawn") {
          assert.ok(!active.has(event.workerId));
          active.add(event.workerId);created++;peak=Math.max(peak,active.size);
        } else if (event.stage === "shutdown") {
          assert.ok(active.delete(event.workerId),"unknown or duplicate Worker termination");
          terminated++;
        }
      } catch (error) { diagnosticError ??= error; }
    }
    const start = (code,bindings={},signal=cancelled.signal) => {
      const index=++sequence, id="run_stress_"+index;
      return runner.start({runId:id,code,context:{index,id},bindings,signal,
        onRootReturned(){},async settleOperations(){},onDiagnostic});
    };
    function observe(stage, details={}) {
      const value=sample(stage,{created,terminated,activeWorkers:active.size,peakWorkers:peak,...details});
      t.diagnostic(JSON.stringify(value));
    }
    const idle = async (stage, details={}) => {
      await delay(20);
      if(diagnosticError)throw diagnosticError;
      assert.equal(active.size,0,"live Workers after completion");
      assert.equal(created,terminated);
      assert.equal(await loader.withPackageChanges(async()=>"idle"),"idle");
      const remaining = await readdir(runtimeRoot).catch(error=>{
        if(error.code==="ENOENT")return [];
        throw error;
      });
      assert.deepEqual(remaining.sort(),sharedRoots,"Worker temporary roots remain");
      observe(stage,details);
    };
    const code = `const bytes=new Uint8Array(65536);bytes.fill(context.index%251);
      await sdk.hold(context.index);return {id:context.id,index:context.index,bytes:bytes.length,first:bytes[0]};`;
    const check = (value,index) => {
      assert.equal(value.index,index);
      assert.equal(value.id,"run_stress_"+index);
      assert.equal(value.bytes,65536);
      assert.equal(value.first,index%251);
    };
    const one = () => {
      const index=sequence+1;
      return start(code,{sdk:{hold:async()=>{}}}).then(value=>check(value,index));
    };
    const held = async n => {
      const gate=Promise.withResolvers(), allEntered=Promise.withResolvers();
      const entered=new Set();
      const offset=sequence;
      const tasks=Array.from({length:n},()=>start(code,{sdk:{hold:async index=>{
        entered.add(index);
        if(entered.size===n)allEntered.resolve();
        await gate.promise;
      }}}));
      // Keep rejections observed while the barrier is held.
      const outcomes=Promise.all(tasks);
      void outcomes.catch(()=>{});
      let timer;
      try {
        await Promise.race([allEntered.promise,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error("all original Workers must coexist")),60_000);
        }),outcomes.then(()=>{throw Error("held Workers returned early");})]);
        assert.equal(active.size,n);
        await assert.rejects(loader.withPackageChanges(async()=>{}),{code:"module_busy"});
        observe("held-"+n,{simultaneous:entered.size});
      } finally {clearTimeout(timer);gate.resolve();}
      (await outcomes).forEach((v,i)=>check(v,offset+i+1));
      await idle("released-"+n);
    };
    try {
      observe("baseline");
      sampleTimer=setInterval(()=>{rssPeak=Math.max(rssPeak,process.memoryUsage.rss());},100);
      sampleTimer.unref();
      for(const n of heldLevels)await held(n);
      const began=performance.now();
      for(let i=0;i<sequential;i++){
        await one();
        if((i+1)%Math.max(1,Math.ceil(sequential/10))===0)
          await idle("sequential-"+(i+1),{elapsedMs:Math.round(performance.now()-began)});
      }
      const batchStart=performance.now();
      for(let i=0;i<batches;i++){
        await Promise.all(Array.from({length:width},()=>one()));
        if((i+1)%Math.max(1,Math.ceil(batches/10))===0)
          await idle("batch-"+(i+1),{elapsedMs:Math.round(performance.now()-batchStart)});
      }
      // The actual Worker exit, not a promise timeout, releases its slot.
      const entered=Promise.withResolvers(), abort=new AbortController();
      const looping=start("await sdk.ready(); while(true) {}",{sdk:{ready:()=>entered.resolve()}},AbortSignal.any([abort.signal,cancelled.signal]));
      const outcome=assert.rejects(looping,{code:"run_cancelled"});
      await entered.promise;
      assert.equal(await start("return 7;"),7);
      abort.abort();
      await outcome;
      await assert.rejects(start("throw new Error('fixture failure');"),{code:"script_execution_failed"});
      await idle("final",{sequential,batches,width,rssPeakMiB:Math.round(rssPeak/1048576*10)/10});
    } finally {
      clearInterval(sampleTimer);
      cancelled.abort();
      await runner.close();
      await rm(work,{recursive:true,force:true});
    }
  });
