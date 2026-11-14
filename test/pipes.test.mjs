import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  setImmediate as immediate,
  setTimeout as delay,
} from "node:timers/promises";
const moduleURL =
  process.env.NEXUM_PIPES_TEST_MODULE ??
  new URL("../dist/process/pipes.js", import.meta.url).href;
const { PipeProcessBackend } = await import(moduleURL);

const windows = process.platform === "win32";
const posix = { skip: windows };
const live = () => new AbortController().signal;
const launch = (code, args = []) => ({
  file: process.execPath,
  args: ["-e", code, "--", ...args],
  cwd: process.cwd(),
  env: { ...process.env },
  tty: false,
  cols: 80,
  rows: 24,
});
function until(backend, predicate, ms = 5000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      backend.off("change", changed);
      if (error) reject(error);
      else resolve();
    };
    const changed = () => {
      if (predicate()) finish();
    };
    const timer = setTimeout(
      () => finish(new Error("controlled process observation timed out")),
      ms,
    );
    backend.on("change", changed);
    changed();
  });
}
function fixture(t, consume) {
  const blocks = [];
  const backend = new PipeProcessBackend({
    onOutput: async (stream, bytes) => {
      blocks.push({ stream, bytes });
      if (consume) await consume(stream, bytes);
    },
  });
  t.after(async () => {
    const stopped = await backend.stop({ graceMs: 0, forceMs: 3000 });
    assert.equal(
      stopped.confirmed,
      true,
      "fixture process must actually close",
    );
  });
  return {
    backend,
    blocks,
    text: (stream = "stdout") =>
      Buffer.concat(
        blocks
          .filter((block) => block.stream === stream)
          .map((block) => block.bytes),
      ).toString("utf8"),
  };
}

test("construction is cold and pre-start disposal is idempotent and prevents late I/O", async () => {
  let output = 0;
  const backend = new PipeProcessBackend({
    onOutput: async () => {
      output++;
    },
  });
  assert.equal(backend.facts().pid, null);
  assert.equal(backend.facts().startedAt, null);
  assert.equal(backend.facts().closed, false);
  const first = backend.dispose(),
    second = backend.dispose();
  assert.equal(first, second);
  await first;
  assert.equal(backend.facts().closed, true);
  assert.equal(backend.facts().rootExited, false);
  assert.equal(backend.facts().treeStopped, true);
  assert.equal(backend.facts().outputComplete, true);
  await assert.rejects(
    backend.start(launch('throw new Error("must-not-run")')),
    { code: windows ? "process_backend_unsupported" : "process_stopping" },
  );
  assert.equal(output, 0);
});

test("pipes explicitly reject PTY and Windows without substituting another launch mechanism", async () => {
  const backend = new PipeProcessBackend({ onOutput: async () => {} });
  await assert.rejects(backend.start({ ...launch(""), tty: true }), {
    code: windows ? "process_backend_unsupported" : "process_tty_unsupported",
  });
  await backend.dispose();
  assert.throws(() => backend.resize(120, 40), { code: "process_not_tty" });
});

test(
  "disposal during native startup retains actual start facts and stops that same child",
  posix,
  async (t) => {
    const f = fixture(t);
    const started = f.backend.start(launch("setInterval(()=>{},1000);"));
    const disposed = f.backend.dispose();
    await assert.rejects(started, { code: "process_stopping" });
    await disposed;
    assert.equal(f.backend.facts().pid > 0, true);
    assert.equal(f.backend.facts().startedAt > 0, true);
    assert.equal(f.backend.facts().rootExited, true);
    assert.equal(f.backend.facts().treeStopped, true);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().closed, true);
  },
);

test(
  "native argv stays separate, nonzero exit is a result fact, and closed follows real pipes",
  posix,
  async (t) => {
    const f = fixture(t),
      args = ["space value", "a&b", "$(literal)", 'a"quote', ""];
    const before = process.cwd();
    await f.backend.start(
      launch(
        "console.log(JSON.stringify(process.argv.slice(1)));process.exitCode=7;",
        args,
      ),
    );
    assert.equal(f.backend.facts().pid > 0, true);
    await until(f.backend, () => f.backend.facts().closed);
    assert.deepEqual(JSON.parse(f.text()), args);
    assert.equal(f.backend.facts().exitCode, 7);
    assert.equal(f.backend.facts().exitSignal, null);
    assert.equal(f.backend.facts().stopRequested, false);
    assert.equal(f.backend.failure, undefined);
    assert.equal(f.backend.facts().treeStopped, true);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(process.cwd(), before);
    assert.equal(f.backend.signal("SIGTERM").delivered, false);
  },
);

test(
  "a failed native spawn retains its failure but only closes once the attempted pipes close",
  posix,
  async (t) => {
    const f = fixture(t);
    await assert.rejects(
      f.backend.start({
        ...launch(""),
        file: process.execPath + ".nexum-test-missing",
      }),
      { code: "process_spawn_failed" },
    );
    await until(f.backend, () => f.backend.facts().closed);
    assert.equal(f.backend.facts().pid, null);
    assert.equal(f.backend.facts().startedAt, null);
    assert.equal(f.backend.facts().rootExited, false);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().treeStopped, true);
    assert.equal(f.backend.failure.code, "process_spawn_failed");
  },
);

test(
  "root exit cannot discard a descendant's later pipe output",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setTimeout(()=>process.stdout.write("descendant-tail"),220);'],{stdio:['ignore',1,2]});child.unref();process.exit(0);`),
    );
    await until(f.backend, () => f.backend.facts().rootExited);
    assert.equal(f.backend.facts().closed, false);
    assert.equal(f.backend.facts().outputComplete, false);
    assert.equal(f.backend.facts().treeStopped, false);
    await until(f.backend, () => f.backend.facts().closed);
    assert.equal(f.text(), "descendant-tail");
    assert.equal(f.backend.facts().exitCode, 0);
  },
);

test(
  "root exit and pipe EOF do not close a still-live descendant with no inherited output",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000);'],{stdio:'ignore'});child.unref();console.log(child.pid);process.exit(0);`),
    );
    await until(
      f.backend,
      () => f.backend.facts().rootExited && f.backend.facts().outputComplete,
    );
    const child = Number(f.text().trim());
    assert.equal(Number.isSafeInteger(child) && child > 0, true);
    assert.equal(f.backend.facts().closed, false);
    assert.equal(f.backend.facts().treeStopped, false);
    const stopped = await f.backend.stop({ graceMs: 100, forceMs: 2000 });
    assert.equal(stopped.confirmed, true);
    assert.equal(stopped.facts.exitCode, 0);
    assert.equal(stopped.facts.treeStopped, true);
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  },
);

test(
  "each raw output callback is bounded, copied and backpressured while both streams keep their identity",
  posix,
  async (t) => {
    const gate = Promise.withResolvers(),
      first = Promise.withResolvers();
    const active = { stdout: 0, stderr: 0 },
      total = { stdout: 0, stderr: 0 };
    let firstOutput = true;
    const f = fixture(t, async (stream, bytes) => {
      assert.equal(stream === "stdout" || stream === "stderr", true);
      assert.equal(bytes.byteLength > 0 && bytes.byteLength <= 64 * 1024, true);
      active[stream]++;
      assert.equal(active[stream], 1);
      if (stream === "stdout" && firstOutput) {
        firstOutput = false;
        first.resolve();
        await gate.promise;
      }
      await delay(1);
      total[stream] += bytes.byteLength;
      active[stream]--;
    });
    try {
      await f.backend.start(
        launch(
          `process.stdout.write(Buffer.alloc(2*1024*1024,65));process.stderr.write(Buffer.alloc(2*1024*1024,66));`,
        ),
      );
      await first.promise;
      await delay(25);
      assert.equal(active.stdout, 1);
      assert.equal(f.backend.facts().closed, false);
      gate.resolve();
      await until(f.backend, () => f.backend.facts().closed);
      assert.equal(f.backend.failure, undefined);
      assert.deepEqual(total, {
        stdout: 2 * 1024 * 1024,
        stderr: 2 * 1024 * 1024,
      });
      assert.equal(f.text("stdout"), "A".repeat(total.stdout));
      assert.equal(f.text("stderr"), "B".repeat(total.stderr));
      assert.equal(f.backend.failure, undefined);
    } finally {
      gate.resolve();
    }
  },
);

test(
  "actual output consumption holds closure even after OS work stopped, while stop observation stays bounded",
  posix,
  async (t) => {
    const gate = Promise.withResolvers(),
      entered = Promise.withResolvers();
    const f = fixture(t, async () => {
      entered.resolve();
      await gate.promise;
    });
    try {
      await f.backend.start(launch('process.stdout.write("last");'));
      await entered.promise;
      await until(f.backend, () => f.backend.facts().rootExited);
      assert.equal(f.backend.facts().closed, false);
      const stop = await f.backend.stop({ graceMs: 10, forceMs: 10 });
      assert.equal(stop.confirmed, false);
      assert.equal(stop.facts.closed, false);
      assert.equal(stop.facts.outputComplete, false);
      gate.resolve();
      await until(f.backend, () => f.backend.facts().closed);
      assert.equal(f.text(), "last");
    } finally {
      gate.resolve();
    }
  },
);

test(
  "an extra native resume cannot run a second output consumer before the first settles",
  posix,
  () => {
    const code = `
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {setTimeout} from 'node:timers/promises';
const require=createRequire(import.meta.url),cp=require('node:child_process'),original=cp.spawn;
let child;cp.spawn=(...args)=>(child=original(...args));syncBuiltinESMExports();
const {PipeProcessBackend}=await import(${JSON.stringify(moduleURL)});
const gate=Promise.withResolvers(),entered=Promise.withResolvers();let calls=0,total=0,active=0,maxActive=0;
const backend=new PipeProcessBackend({onOutput:async(_stream,bytes)=>{calls++;active++;maxActive=Math.max(maxActive,active);if(calls===1){entered.resolve();await gate.promise;}total+=bytes.length;active--;}});
try {
 await backend.start(${JSON.stringify(launch("process.stdout.write(Buffer.alloc(256*1024,65));"))});
 await entered.promise;child.stdout.resume();await setTimeout(25);
 assert.equal(calls,1);assert.equal(backend.facts().closed,false);
 gate.resolve();await backend.closed;assert.equal(maxActive,1);assert.equal(total,256*1024);assert.equal(backend.failure,undefined);
 console.log(JSON.stringify({maxActive,total}));
} finally {gate.resolve();assert.equal((await backend.stop({graceMs:0,forceMs:3000})).confirmed,true);}
`;
    const child = spawnSync(process.execPath, ["--input-type=module"], {
      input: code,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      maxActive: 1,
      total: 256 * 1024,
    });
  },
);

test(
  "output consumer failures remain observable and stop the actual resource",
  posix,
  async (t) => {
    const failure = new Error("controlled-output-store-failure");
    const f = fixture(t, async () => {
      throw failure;
    });
    await f.backend.start(
      launch('setInterval(()=>process.stdout.write("chunk"),10);'),
    );
    await until(f.backend, () => f.backend.facts().closed);
    assert.equal(f.backend.failure.code, "process_output_failed");
    assert.equal(f.backend.failure.cause, failure);
    assert.equal(f.backend.facts().stopRequested, true);
    assert.equal(f.backend.facts().treeStopped, true);
  },
);

test(
  "stdin writes are FIFO snapshots of visible bytes and EOF is flushed once",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(
        'const chunks=[];process.stdin.on("data",b=>chunks.push(b));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(chunks)));',
      ),
    );
    const backing = Uint8Array.from([0x78, 0x41, 0x42, 0x79]);
    const writes = [
      f.backend.write(Buffer.from("before:"), false, live()),
      f.backend.write(backing.subarray(1, 3), false, live()),
      f.backend.write(Buffer.from(":after"), true, live()),
    ];
    backing.fill(0x7a);
    await assert.rejects(
      f.backend.write(Buffer.from("too-late"), false, live()),
      { code: "process_stdin_closed" },
    );
    await Promise.all(writes);
    await until(f.backend, () => f.backend.facts().closed);
    assert.equal(f.text(), "before:AB:after");
    assert.equal(f.backend.failure, undefined);
  },
);

test(
  "native Writable final-flush errors reject EOF before later error/close events",
  posix,
  () => {
    const code = `
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {setImmediate} from 'node:timers/promises';
const require=createRequire(import.meta.url),cp=require('node:child_process'),original=cp.spawn;
const failure=new Error('controlled-final-flush-failure');
cp.spawn=(...args)=>{const child=original(...args);child.stdin._final=callback=>callback(failure);return child;};syncBuiltinESMExports();
const {PipeProcessBackend}=await import(${JSON.stringify(moduleURL)});
const backend=new PipeProcessBackend({onOutput:async()=>{}});
try {
 await backend.start(${JSON.stringify(launch("process.stdin.resume();setInterval(()=>{},1000);"))});
 await assert.rejects(backend.write(new Uint8Array(),true,new AbortController().signal),error=>error.code==='process_input_failed'&&error.cause===failure);
 await setImmediate();assert.equal(backend.failure.code,'process_input_failed');
 console.log(JSON.stringify({writeRejected:true,failure:backend.failure.code}));
} finally {assert.equal((await backend.stop({graceMs:0,forceMs:3000})).confirmed,true);}
`;
    const child = spawnSync(process.execPath, ["--input-type=module"], {
      input: code,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      writeRejected: true,
      failure: "process_input_failed",
    });
  },
);

test(
  "cancelling input wait distinguishes submitted bytes from a skipped queued write without undoing native I/O",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(
        `let bytes=0;const hold=setInterval(()=>{},1000);process.on('SIGUSR2',()=>{process.stdin.on('data',b=>bytes+=b.length);process.stdin.on('end',()=>{console.log('count:'+bytes);clearInterval(hold);});process.stdin.resume();});console.log('ready');`,
      ),
    );
    await until(f.backend, () => f.text().includes("ready"));
    const active = new AbortController(),
      queued = new AbortController();
    const sent = f.backend.write(
      Buffer.alloc(4 * 1024 * 1024, 0x61),
      false,
      active.signal,
    );
    await immediate();
    const skipped = f.backend.write(
      Buffer.from("must-not-arrive"),
      true,
      queued.signal,
    );
    queued.abort(new Error("queued cancellation"));
    await assert.rejects(
      skipped,
      (error) =>
        error.code === "process_write_wait_cancelled" &&
        error.details.submitted === false,
    );
    active.abort(new Error("active cancellation"));
    await assert.rejects(
      sent,
      (error) =>
        error.code === "process_write_wait_cancelled" &&
        error.details.submitted === true &&
        error.details.bytesSubmitted === 4 * 1024 * 1024,
    );
    assert.equal(f.backend.facts().stopRequested, false);
    assert.equal(f.backend.facts().closed, false);
    const eof = f.backend.write(new Uint8Array(), true, live());
    assert.deepEqual(f.backend.signal("SIGUSR2"), {
      requested: "SIGUSR2",
      delivered: true,
      mechanism: "process-group",
    });
    await eof;
    await until(f.backend, () => f.backend.facts().closed);
    assert.equal(f.text().includes("count:4194304"), true);
    assert.equal(f.backend.failure, undefined);
  },
);

test(
  "TERM-resistant roots and descendants share one bounded stop and confirm actual forceful closure",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(`const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000);'],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>console.log('ready:'+child.pid));setInterval(()=>{},1000);`),
    );
    await until(f.backend, () => f.text().includes("ready:"));
    const child = Number(f.text().trim().split(":")[1]);
    const first = f.backend.stop({ graceMs: 30, forceMs: 2000 });
    const second = f.backend.stop({ graceMs: 1, forceMs: 1 });
    assert.equal(first, second);
    const receipt = await first;
    assert.equal(receipt.confirmed, true);
    assert.equal(receipt.facts.rootExited, true);
    assert.equal(receipt.facts.exitSignal, "SIGKILL");
    assert.equal(receipt.facts.forceRequested, true);
    assert.equal(receipt.facts.outputComplete, true);
    assert.equal(receipt.facts.treeStopped, true);
    assert.equal(receipt.facts.closed, true);
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  },
);

test(
  "pending input charges empty jobs and bytes, while queued cancellation releases both before the active write drains",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(
        `let bytes=0;const hold=setInterval(()=>{},1000);process.on('SIGUSR2',()=>{process.stdin.on('data',b=>bytes+=b.length);process.stdin.on('end',()=>{console.log('count:'+bytes);clearInterval(hold);});process.stdin.resume();});console.log('ready');`,
      ),
    );
    await until(f.backend, () => f.text().includes("ready"));
    const active = f.backend.write(
      Buffer.alloc(4 * 1024 * 1024, 0x61),
      false,
      live(),
    );
    const queued = new AbortController();
    const pending = Array.from({ length: 255 }, () =>
      f.backend.write(new Uint8Array(), false, queued.signal).then(
        () => null,
        (error) => error,
      ),
    );
    await assert.rejects(f.backend.write(new Uint8Array(), false, live()), {
      code: "process_input_busy",
    });
    queued.abort(new Error("cancel pending empty jobs"));
    const rejected = await Promise.all(pending);
    assert.equal(
      rejected.every(
        (error) =>
          error?.code === "process_write_wait_cancelled" &&
          error.details.submitted === false,
      ),
      true,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const large = new AbortController();
      const write = f.backend.write(
        Buffer.alloc(12 * 1024 * 1024),
        false,
        large.signal,
      );
      await assert.rejects(f.backend.write(Buffer.from([1]), false, live()), {
        code: "process_input_busy",
      });
      large.abort(new Error("cancel pending large input"));
      await assert.rejects(
        write,
        (error) =>
          error.code === "process_write_wait_cancelled" &&
          error.details.submitted === false,
      );
    }
    const tail = f.backend.write(Buffer.from("z"), false, live());
    const eof = f.backend.write(new Uint8Array(), true, live());
    assert.equal(f.backend.facts().closed, false);
    f.backend.signal("SIGUSR2");
    await Promise.all([active, tail, eof]);
    await until(f.backend, () => f.backend.facts().closed);
    assert.equal(f.text().includes("count:4194305"), true);
    assert.equal(f.backend.failure, undefined);
  },
);
