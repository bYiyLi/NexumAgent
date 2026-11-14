import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PtyProcessBackend } from "../dist/process/pty.js";

const supported = process.platform === "darwin" || process.platform === "linux";
const posix = { skip: !supported, timeout: 12000 };
const launch = (code, extra = {}) => ({
  file: process.execPath,
  args: ["-e", code],
  cwd: realpathSync.native(process.cwd()),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([, value]) => typeof value === "string",
    ),
  ),
  tty: true,
  cols: 88,
  rows: 26,
  ...extra,
});
async function until(check, ms = 5000) {
  const signal = AbortSignal.timeout(ms);
  while (!check()) await delay(5, undefined, { signal });
}
function fixture(t, onOutput) {
  const chunks = [];
  let maximumChunk = 0;
  const backend = new PtyProcessBackend({
    async onOutput(kind, bytes) {
      assert.equal(kind, "terminal");
      assert(Buffer.isBuffer(bytes));
      maximumChunk = Math.max(maximumChunk, bytes.length);
      if (onOutput) await onOutput(bytes);
      chunks.push(Buffer.from(bytes));
    },
  });
  t.after(async () => {
    const stopped = await backend.stop({ graceMs: 0, forceMs: 2000 });
    assert.equal(
      stopped.confirmed,
      true,
      "fixture must close its actual owned PTY and process group",
    );
  });
  return {
    backend,
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString("utf8"),
    maximumChunk: () => maximumChunk,
  };
}

test(
  "a cold PTY creates no process or output and disposal prevents later start",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const backend = new PtyProcessBackend({
      async onOutput() {
        calls++;
      },
    });
    assert.deepEqual(backend.facts(), {
      pid: null,
      startedAt: null,
      rootExited: false,
      exitCode: null,
      exitSignal: null,
      outputComplete: false,
      treeStopped: false,
      closed: false,
      stopRequested: false,
      forceRequested: false,
    });
    assert.throws(() => backend.signal("SIGTERM"), {
      code: "process_not_started",
    });
    assert.throws(
      () => backend.write(Buffer.alloc(0), false, new AbortController().signal),
      { code: "process_input_closed" },
    );
    const first = backend.dispose(),
      second = backend.dispose();
    assert.equal(first, second);
    await first;
    await backend.closed;
    assert.equal(calls, 0);
    assert.equal(backend.facts().pid, null);
    assert.equal(backend.facts().closed, true);
    assert.equal(backend.facts().rootExited, false);
    await assert.rejects(() => backend.start(launch("")), {
      code: supported ? "process_stopping" : "process_backend_unsupported",
    });
  },
);

test(
  "native terminal launch preserves argv and raw bytes without pretending to be pipe streams",
  posix,
  async (t) => {
    const f = fixture(t),
      args = ["中文", "space value", '\";$()&|'];
    await f.backend.start(
      launch(
        'process.stdout.write(JSON.stringify({input:process.stdin.isTTY,output:process.stdout.isTTY,args:process.argv.slice(1)})+"\\n");process.stdout.write(Buffer.from([0,255,128,65]));',
        {
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({input:process.stdin.isTTY,output:process.stdout.isTTY,args:process.argv.slice(1)})+"\\n");process.stdout.write(Buffer.from([0,255,128,65]));',
            ...args,
          ],
        },
      ),
    );
    await until(() => f.backend.facts().closed);
    await f.backend.closed;
    assert.deepEqual(JSON.parse(f.text().split(/\r?\n/)[0]), {
      input: true,
      output: true,
      args,
    });
    assert(f.bytes().includes(Buffer.from([0, 255, 128, 65])));
    assert.equal(f.backend.facts().exitCode, 0);
    assert.equal(f.backend.facts().rootExited, true);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().treeStopped, true);
    assert.equal(f.backend.failure, undefined);
  },
);

test(
  "interactive writes and real terminal resize use the original owned PTY",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(
        'process.stdin.setRawMode(true);process.stdout.on("resize",()=>process.stdout.write("SIZE:"+process.stdout.columns+"x"+process.stdout.rows+"\\n"));process.stdin.on("data",bytes=>{process.stdout.write("READ:"+bytes.toString("hex")+"\\n");if(bytes.includes(4))process.exit(0);});process.stdout.write("READY:"+process.stdout.columns+"x"+process.stdout.rows+"\\n");',
      ),
    );
    await until(() => f.text().includes("READY:88x26"));
    f.backend.resize(120, 40);
    await until(() => f.text().includes("SIZE:120x40"));
    assert.throws(() => f.backend.resize(0, 24), {
      code: "invalid_process_geometry",
    });
    const signal = new AbortController().signal;
    await f.backend.write(Buffer.from("你好"), false, signal);
    await Promise.all([
      f.backend.write(Buffer.from("A"), false, signal),
      f.backend.write(Buffer.from("B"), false, signal),
    ]);
    const read = () =>
      [...f.text().matchAll(/READ:([0-9a-f]+)/g)]
        .map((value) => value[1])
        .join("");
    await until(() => read().endsWith(Buffer.from("你好AB").toString("hex")));
    assert.throws(
      () => f.backend.write(Buffer.from("not-sent"), true, signal),
      { code: "process_tty_eof_unsupported" },
    );
    await f.backend.write(Buffer.from([4]), false, signal);
    await until(() => f.backend.facts().closed);
    assert.equal(f.backend.facts().exitCode, 0);
  },
);

test(
  "signals report delivery separately from real exit and stop escalates an uncooperative terminal",
  posix,
  async (t) => {
    const graceful = fixture(t);
    await graceful.backend.start(
      launch(
        'process.on("SIGTERM",()=>process.exit(7));process.stdout.write("READY\\n");setInterval(()=>{},1000);',
      ),
    );
    await until(() => graceful.text().includes("READY"));
    assert.throws(() => graceful.backend.signal("SIGMADEUP"), {
      code: "unsupported_process_signal",
    });
    const sent = graceful.backend.signal("SIGTERM");
    assert.deepEqual(sent, {
      requested: "SIGTERM",
      delivered: true,
      mechanism: "process-group",
    });
    await until(() => graceful.backend.facts().closed);
    assert.equal(graceful.backend.facts().exitCode, 7);
    assert.equal(graceful.backend.facts().stopRequested, false);
    const forced = fixture(t);
    await forced.backend.start(
      launch(
        'process.on("SIGTERM",()=>{});process.stdout.write("READY\\n");setInterval(()=>{},1000);',
      ),
    );
    await until(() => forced.text().includes("READY"));
    const first = forced.backend.stop({ graceMs: 30, forceMs: 2000 }),
      second = forced.backend.stop();
    assert.equal(first, second);
    const result = await first;
    assert.equal(result.confirmed, true);
    assert.equal(result.facts.forceRequested, true);
    assert.equal(result.facts.exitSignal, "SIGKILL");
    assert.equal(forced.backend.signal("SIGTERM").delivered, false);
  },
);

test(
  "large output is consumed serially with bounded chunks and the final tail precedes closure",
  posix,
  async (t) => {
    const gate = Promise.withResolvers();
    let calls = 0,
      active = 0,
      maximumActive = 0;
    const f = fixture(t, async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (++calls === 1) await gate.promise;
      active--;
    });
    t.after(() => gate.resolve());
    await f.backend.start(
      launch(
        'process.stdout.write(Buffer.alloc(2*1024*1024,120),()=>process.stdout.write("TAIL",()=>process.exit(0)));',
      ),
    );
    await until(() => calls === 1);
    await delay(40);
    assert.equal(calls, 1);
    assert.equal(f.backend.facts().closed, false);
    gate.resolve();
    await until(() => f.backend.facts().closed);
    assert.equal(maximumActive, 1);
    assert(f.maximumChunk() <= 64 * 1024);
    assert.equal(f.bytes().length, 2 * 1024 * 1024 + 4);
    assert.equal(f.bytes().subarray(-4).toString(), "TAIL");
  },
);

test(
  "a real terminal EOF after session-root exit does not assert its surviving process group stopped",
  posix,
  async (t) => {
    const f = fixture(t);
    const descendant =
      'process.on("SIGHUP",()=>{});process.stdout.on("error",()=>{});process.stdout.write("DESCENDANT_READY\\n");process.send("ready");setTimeout(()=>process.stdout.write("LATE_TAIL\\n"),500);setTimeout(()=>process.exit(0),1000);';
    const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:[0,1,2,'ipc']});child.on('message',()=>{child.disconnect();process.exit(0);});`;
    await f.backend.start(launch(code));
    await until(() => f.backend.facts().rootExited);
    const intermediate = f.backend.facts();
    assert.equal(intermediate.closed, false);
    assert.equal(intermediate.treeStopped, false);
    // A session-leader exit can hang up the terminal on macOS/Linux. If the OS
    // still supplies bytes, consume them; no synthetic EOF or late-tail claim.
    await until(() => f.backend.facts().closed);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().treeStopped, true);
    assert(f.text().includes("DESCENDANT_READY"));
  },
);

test(
  "queued input cancellation is independent, job count is bounded and empty writes do not queue",
  posix,
  async (t) => {
    const f = fixture(t);
    await f.backend.start(
      launch(
        'process.stdin.setRawMode(true);process.stdin.pause();process.stdout.write("READY\\n");setInterval(()=>{},1000);',
      ),
    );
    await until(() => f.text().includes("READY"));
    const blocking = new AbortController(),
      first = f.backend.write(
        Buffer.alloc(2 * 1024 * 1024, 97),
        false,
        blocking.signal,
      );
    let firstDone = false;
    const handled = first.then(
      () => {
        firstDone = true;
        return null;
      },
      (error) => {
        firstDone = true;
        return error;
      },
    );
    t.after(() => blocking.abort());
    await delay(40);
    assert.equal(firstDone, false);
    const queued = new AbortController(),
      reason = new Error("cancel queued input"),
      small = f.backend.write(Buffer.from("b"), false, queued.signal);
    const smallResult = small.then(
      () => ({ success: true }),
      (error) => ({ error }),
    );
    queued.abort(reason);
    const observed = await Promise.race([
      smallResult,
      delay(500).then(() => ({ timeout: true })),
    ]);
    assert.equal(observed.error, reason);
    assert.equal(firstDone, false);
    await Promise.all(
      Array.from({ length: 64 }, () =>
        f.backend.write(Buffer.alloc(0), false, new AbortController().signal),
      ),
    );
    const pending = new AbortController(),
      jobs = [];
    for (let index = 0; index < 255; index++)
      jobs.push(
        f.backend.write(Buffer.from("x"), false, pending.signal).then(
          () => null,
          (error) => error,
        ),
      );
    assert.throws(
      () => f.backend.write(Buffer.from("y"), false, pending.signal),
      { code: "process_input_busy" },
    );
    pending.abort(reason);
    assert((await Promise.all(jobs)).every((error) => error === reason));
    blocking.abort(reason);
    assert(await handled);
    const stopped = await f.backend.stop({ graceMs: 0, forceMs: 2000 });
    assert.equal(stopped.confirmed, true);
  },
);

test(
  "output consumer failure still stops and physically closes the owned terminal",
  posix,
  async (t) => {
    const f = fixture(t, async () => {
      throw new Error("synthetic output failure");
    });
    await f.backend.start(
      launch(
        'process.stdout.write("READY\\n");setInterval(()=>process.stdout.write("tick\\n"),10);',
      ),
    );
    await until(() => f.backend.facts().closed);
    assert.equal(f.backend.failure.code, "process_output_failed");
    assert.equal(f.backend.facts().treeStopped, true);
  },
);

test(
  "Windows cannot accidentally launch this POSIX backend as a ConPTY fallback",
  { skip: process.platform !== "win32", timeout: 5000 },
  async () => {
    const backend = new PtyProcessBackend({
      async onOutput() {
        throw Error("must not produce output");
      },
    });
    await assert.rejects(() => backend.start(launch("")), {
      code: "process_backend_unsupported",
    });
    await backend.dispose();
    assert.equal(backend.facts().pid, null);
  },
);
