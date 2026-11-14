import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { WindowsProcessBackend } from "../dist/process/windows-pipes.js";
import { createRawConoutConnection } from "../dist/process/windows-conout.js";

const windows = process.platform === "win32";
const liveSignal = () => new AbortController().signal;

function environment(overrides = {}) {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !/^_?NEXUM(?:_|$)/i.test(key) &&
      !/^NODE_(?:OPTIONS|PATH|CHANNEL_FD|CHANNEL_SERIALIZATION_MODE|UNIQUE_ID)$/i.test(
        key,
      )
    )
      result[key] = value;
  }
  return { ...result, ...overrides };
}

async function within(promise, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("The Windows process fixture did not settle.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(predicate, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(15);
  }
  assert.fail("The Windows process fixture did not reach the expected state.");
}

function setup(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nexum windows process "));
  const chunks = [];
  const backend = new WindowsProcessBackend({
    onOutput: async (stream, bytes) => {
      assert.equal(Buffer.isBuffer(bytes), true);
      chunks.push({ stream, bytes: Buffer.from(bytes) });
      await options.onOutput?.(stream, bytes);
    },
  });
  t.after(async () => {
    await within(backend.stop({ graceMs: 10, forceMs: 3000 }), 5000);
    await within(backend.closed, 5000);
    rmSync(root, { recursive: true, force: true });
  });
  const text = (stream) =>
    Buffer.concat(
      chunks
        .filter((chunk) => chunk.stream === stream)
        .map((chunk) => chunk.bytes),
    ).toString("utf8");
  const node = (code, extra = {}) => ({
    file: process.execPath,
    args: ["-e", code],
    cwd: root,
    env: environment(),
    tty: false,
    cols: 120,
    rows: 30,
    ...extra,
  });
  return { root, chunks, backend, text, node };
}

test(
  "Windows backend is cold and non-Windows start does not load native modules",
  {
    skip: windows,
  },
  async () => {
    const require = createRequire(import.meta.url);
    const loaded = () =>
      Object.keys(require.cache).filter((file) =>
        /[/\\](?:koffi|node-pty)[/\\]/.test(file),
      );
    const before = loaded();
    let output = 0;
    const backend = new WindowsProcessBackend({
      onOutput: async () => {
        output++;
      },
    });
    assert.ok(backend instanceof EventEmitter);
    assert.equal(backend.facts().pid, null);
    assert.equal(backend.facts().startedAt, null);
    assert.equal(backend.facts().closed, false);
    await assert.rejects(
      backend.start({
        file: process.execPath,
        args: ["-e", "throw new Error('must not execute')"],
        cwd: process.cwd(),
        env: {},
        tty: false,
        cols: 80,
        rows: 24,
      }),
      { code: "windows_process_unsupported" },
    );
    await backend.dispose();
    await within(backend.closed);
    assert.throws(() => createRawConoutConnection("unused", false), {
      code: "windows_conout_unsupported",
    });
    assert.equal(backend.facts().closed, true);
    assert.equal(output, 0);
    assert.deepEqual(loaded(), before);
  },
);

test(
  "Windows direct argv, separate raw streams and business Node environment survive helper isolation",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    const marker = path.join(f.root, "parent-preload-ran");
    const preload = path.join(f.root, "parent-preload.cjs");
    writeFileSync(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
    );
    const previous = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      NODE_PATH: process.env.NODE_PATH,
      NEXUM_AGENT_TEST_SECRET: process.env.NEXUM_AGENT_TEST_SECRET,
    };
    const values = [
      "two words",
      'a"b',
      "back\\slash\\",
      "中文-🙂",
      "",
      "& echo never",
    ];
    const launch = f.node(
      `
process.stdout.write(JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(1),
  options: process.env.NODE_OPTIONS,
  nodePath: process.env.NODE_PATH,
  privateValue: process.env.NEXUM_AGENT_TEST_SECRET ?? null,
  hasIpc: typeof process.send === 'function'
}) + '\\n');
process.stderr.write('stderr-中文-🙂\\n');`,
      {
        env: environment({
          NODE_OPTIONS: "--max-old-space-size=128",
          NODE_PATH: path.join(f.root, "business libraries"),
        }),
      },
    );
    launch.args.push(...values);
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
    process.env.NODE_PATH = path.join(f.root, "parent-private-libraries");
    process.env.NEXUM_AGENT_TEST_SECRET = "synthetic-parent-only-secret";
    try {
      await f.backend.start(launch);
      await within(f.backend.closed);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.equal(existsSync(marker), false);
    const { pid, ...payload } = JSON.parse(f.text("stdout"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(f.backend.facts().pid, pid);
    assert.ok(Number.isInteger(f.backend.facts().startedAt));
    assert.deepEqual(payload, {
      argv: values,
      options: "--max-old-space-size=128",
      nodePath: path.join(f.root, "business libraries"),
      privateValue: null,
      hasIpc: false,
    });
    assert.equal(f.text("stderr"), "stderr-中文-🙂\n");
    assert.equal(f.text("terminal"), "");
    assert.equal(f.backend.facts().exitCode, 0);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().treeStopped, true);
  },
);

test(
  "Windows pipe writes preserve order and bytes, drain, and close stdin exactly after EOF",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    await f.backend.start(
      f.node(`
const data = [];
process.stdin.on('data', chunk => data.push(chunk));
process.stdin.on('end', () => process.stdout.write(Buffer.concat(data).toString('hex')));
setTimeout(() => process.exit(90), 12000).unref();`),
    );
    const first = Buffer.from("先 ");
    const second = Buffer.from([0, 1, 255]);
    const third = Buffer.alloc(256 * 1024, 0x63);
    await Promise.all([
      f.backend.write(first, false, liveSignal()),
      f.backend.write(second, false, liveSignal()),
      f.backend.write(third, true, liveSignal()),
    ]);
    await within(f.backend.closed);
    assert.equal(
      f.text("stdout"),
      Buffer.concat([first, second, third]).toString("hex"),
    );
    await assert.rejects(
      f.backend.write(Buffer.from("late"), false, liveSignal()),
    );
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().exitCode, 0);
  },
);

test(
  "Windows output waits for the async consumer and does not accumulate callback promises",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let callbacks = 0;
    const f = setup(t, {
      onOutput: async () => {
        callbacks++;
        entered.resolve();
        await gate.promise;
      },
    });
    try {
      await f.backend.start(
        f.node("process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 0x61));"),
      );
      await within(entered.promise);
      await delay(75);
      assert.equal(callbacks, 1);
      assert.equal(f.backend.facts().outputComplete, false);
      assert.equal(f.backend.facts().closed, false);
    } finally {
      gate.resolve();
    }
    await within(f.backend.closed);
    assert.equal(
      Buffer.concat(f.chunks.map((chunk) => chunk.bytes)).length,
      4 * 1024 * 1024,
    );
    assert.equal(f.backend.facts().outputComplete, true);
  },
);

test(
  "Windows root exit is distinct from descendant output EOF and actual Job shutdown",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    const descendant = `
setTimeout(() => process.stdout.write('descendant-tail\\n'), 1500);
setTimeout(() => process.exit(0), 1700);`;
    await f.backend.start(
      f.node(`
const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
  stdio: ['ignore', 'inherit', 'inherit'], env: process.env, windowsHide: true
});
child.once('spawn', () => process.exit(23));
child.once('error', () => process.exit(91));`),
    );
    await eventually(() => f.backend.facts().rootExited);
    assert.equal(f.backend.facts().exitCode, 23);
    assert.equal(f.backend.facts().outputComplete, false);
    assert.equal(f.backend.facts().treeStopped, false);
    assert.equal(f.backend.facts().closed, false);
    await within(f.backend.closed);
    assert.match(f.text("stdout"), /descendant-tail/);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().treeStopped, true);
    assert.equal(f.backend.facts().closed, true);
  },
);

test(
  "Windows stop force-closes its own helper, business process and inherited-output descendants",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    const descendant =
      "process.stdout.write('descendant-ready\\n'); setTimeout(() => process.exit(90), 12000);";
    await f.backend.start(
      f.node(`
const {spawn} = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
  stdio: ['ignore', 'inherit', 'inherit'], env: process.env, windowsHide: true
});
process.stdin.resume();
process.stdout.write('root-ready\\n');
setTimeout(() => process.exit(91), 12000);`),
    );
    await eventually(() => f.text("stdout").includes("descendant-ready"));
    assert.equal(f.backend.facts().rootExited, false);
    const receipt = await within(
      f.backend.stop({ graceMs: 20, forceMs: 4000 }),
    );
    assert.equal(receipt.confirmed, true);
    assert.equal(receipt.facts.stopRequested, true);
    assert.equal(receipt.facts.forceRequested, true);
    assert.equal(receipt.facts.treeStopped, true);
    await within(f.backend.closed);
    assert.equal(f.backend.facts().rootExited, true);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().closed, true);
  },
);

test(
  "Windows signals distinguish supported Job termination from unsupported POSIX signals",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    await f.backend.start(f.node("setTimeout(() => process.exit(90), 12000);"));
    await assert.rejects(async () => f.backend.signal("SIGTERM"));
    await assert.rejects(async () => f.backend.resize(80, 24));
    const receipt = await f.backend.signal("SIGKILL");
    assert.equal(receipt.requested, "SIGKILL");
    assert.equal(receipt.delivered, true);
    assert.equal(receipt.mechanism, "job-object");
    await within(f.backend.closed);
    assert.equal(f.backend.facts().treeStopped, true);
  },
);

test(
  "Windows spawn failure closes native ownership and direct batch files are never rewritten as shell",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    await t.test("missing executable", async (t) => {
      const f = setup(t);
      await assert.rejects(
        f.backend.start(
          f.node("", { file: path.join(f.root, "missing.exe"), args: [] }),
        ),
      );
      await within(f.backend.closed);
      assert.ok(f.backend.failure);
      assert.equal(f.backend.facts().treeStopped, true);
      assert.equal(f.backend.facts().closed, true);
    });
    await t.test("batch direct command", async (t) => {
      const f = setup(t);
      const marker = path.join(f.root, "batch-ran");
      const command = path.join(f.root, "do not run.cmd");
      writeFileSync(command, `@echo off\r\necho executed > "${marker}"\r\n`);
      await assert.rejects(
        f.backend.start(f.node("", { file: command, args: ["& echo never"] })),
      );
      await within(f.backend.closed);
      assert.equal(existsSync(marker), false);
      assert.equal(f.backend.facts().treeStopped, true);
    });
  },
);

test(
  "Windows real PTY exposes terminal streams, accepts input and resizes the terminal",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    await f.backend.start(
      f.node(
        `
process.stdout.write('TTY:' + JSON.stringify({ input: !!process.stdin.isTTY, output: !!process.stdout.isTTY }) + '\\n');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => {
  const input = chunk.toString();
  if (input.includes('s')) process.stdout.write('SIZE:' + JSON.stringify(process.stdout.getWindowSize()) + '\\n');
  if (input.includes('q')) process.exit(0);
});
setTimeout(() => process.exit(90), 12000).unref();`,
        { tty: true },
      ),
    );
    await eventually(() => f.text("terminal").includes('"output":true'));
    assert.match(f.text("terminal"), /"input":true/);
    assert.equal(f.text("stdout"), "");
    assert.equal(f.text("stderr"), "");
    await f.backend.resize(97, 31);
    await delay(100);
    await f.backend.write(Buffer.from("s"), false, liveSignal());
    await eventually(() => f.text("terminal").includes("SIZE:[97,31]"));
    await assert.rejects(f.backend.write(Buffer.alloc(0), true, liveSignal()));
    await f.backend.write(Buffer.from("q"), false, liveSignal());
    await within(f.backend.closed);
    assert.equal(f.backend.facts().exitCode, 0);
    assert.equal(f.backend.facts().outputComplete, true);
    assert.equal(f.backend.facts().treeStopped, true);
  },
);

test(
  "Windows raw conout bridge preserves every byte and waits beyond idle for actual native EOF",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const pipe = String.raw`\\.\pipe\nexum-test-${randomUUID()}`;
    const accepted = Promise.withResolvers();
    const failures = [];
    const server = createServer((socket) => {
      socket.on("error", (error) => failures.push(error));
      accepted.resolve(socket);
    });
    server.on("error", (error) => failures.push(error));
    let upstream;
    let connection;
    const socket = new Socket();
    socket.setEncoding("utf8"); // Match the initial pinned WindowsPtyAgent choice.
    socket.on("error", (error) => failures.push(error));
    t.after(async () => {
      connection?.dispose();
      if (connection) await within(connection.closed, 5000);
      socket.destroy();
      upstream?.destroy();
      if (server.listening)
        await within(new Promise((resolve) => server.close(resolve)), 5000);
    });
    const listening = once(server, "listening");
    server.listen(pipe);
    await within(listening);
    connection = createRawConoutConnection(pipe, true);
    connection.onError((error) => failures.push(error));
    const ready = Promise.withResolvers();
    connection.onReady(() => ready.resolve());
    await within(ready.promise);
    upstream = await within(accepted.promise);
    const received = [];
    socket.on("data", (chunk) => {
      assert.equal(typeof chunk, "string");
      received.push(Buffer.from(chunk, "latin1"));
    });
    const outputEnd = once(socket, "end");
    const outputClose = once(socket, "close");
    const connected = once(socket, "connect");
    connection.connectSocket(socket);
    await within(connected);
    const parts = [
      Buffer.from([0xff, 0x00, 0x41, 0xe4]),
      Buffer.from([0xb8]),
      Buffer.from([0xad, 0xf0, 0x9f]),
      Buffer.from([0x99, 0x82]),
    ];
    for (const part of parts) {
      await within(
        new Promise((resolve, reject) =>
          upstream.write(part, (error) => (error ? reject(error) : resolve())),
        ),
      );
      await delay(10);
    }
    const prefix = Buffer.concat(parts);
    await eventually(() => Buffer.concat(received).length === prefix.length);
    let closed = false;
    void connection.closed.then(() => {
      closed = true;
    });
    await delay(1250);
    assert.equal(closed, false);
    assert.equal(socket.readableEnded, false);
    assert.deepEqual(Buffer.concat(received), prefix);
    const tail = Buffer.from([0x00, 0xfe, 0x42]);
    upstream.end(tail);
    await within(outputEnd);
    await within(outputClose);
    const exit = await within(connection.closed);
    assert.deepEqual(Buffer.concat(received), Buffer.concat([prefix, tail]));
    assert.deepEqual(exit, { exitCode: 0, disposed: false, ended: true });
    assert.deepEqual(failures, []);
  },
);

test(
  "Windows PTY preserves split UTF-8 terminal text and exposes actual VT bytes",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    await f.backend.start(
      f.node(
        `
if (!process.stdout.isTTY) throw new Error('A real terminal is required');
const {setTimeout: delay} = require('node:timers/promises');
const bytes = Buffer.from('\\x1b[31mUTF8:汉字🙂é:END\\x1b[0m\\n', 'utf8');
(async () => {
  // Node/libuv retains incomplete UTF-8 code points across TTY writes. Exercise
  // those boundaries before ConPTY emits its UTF-8 terminal stream.
  for (let offset = 0; offset < bytes.length; offset++) {
    await new Promise((resolve, reject) => process.stdout.write(bytes.subarray(offset, offset + 1), error => error ? reject(error) : resolve()));
    await delay(2);
  }
})().catch(() => process.exit(91));
setTimeout(() => process.exit(90), 12000).unref();`,
        { tty: true },
      ),
    );
    await within(f.backend.closed);
    const raw = Buffer.concat(f.chunks.map((chunk) => chunk.bytes));
    const text = stripVTControlCharacters(raw.toString("utf8"));
    assert.match(text, /UTF8:汉字🙂é:END/);
    assert.equal(text.includes("\ufffd"), false);
    assert.ok(raw.includes(0x1b));
    assert.equal(f.text("stdout"), "");
    assert.equal(f.text("stderr"), "");
    assert.equal(f.backend.facts().exitCode, 0);
    assert.equal(f.backend.facts().outputComplete, true);
  },
);

test(
  "Windows output consumer failure is retained and closes the real native tree",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t, {
      onOutput: async () => {
        throw new Error("synthetic-output-consumer-failure");
      },
    });
    await f.backend
      .start(
        f.node(
          "process.stdout.write('output'); setTimeout(() => process.exit(90), 12000);",
        ),
      )
      .catch(() => {});
    await within(f.backend.closed);
    assert.ok(f.backend.failure);
    assert.equal(f.backend.facts().treeStopped, true);
    assert.equal(f.backend.facts().closed, true);
  },
);

test(
  "Windows closed business stdin rejects large and subsequent writes while the root remains alive",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const f = setup(t);
    await f.backend.start(
      f.node(`
require('node:fs').closeSync(0);
process.stdout.write('input-closed-ready');
setTimeout(() => process.exit(90), 12000);`),
    );
    await eventually(() => f.text("stdout").includes("input-closed-ready"));
    await assert.rejects(
      within(
        f.backend.write(Buffer.alloc(128 * 1024, 0x61), false, liveSignal()),
        3000,
      ),
      { code: "process_input_closed" },
    );
    assert.equal(f.backend.facts().rootExited, false);
    assert.equal(f.backend.facts().closed, false);
    await assert.rejects(
      within(f.backend.write(Buffer.from("later"), false, liveSignal()), 2000),
      { code: "process_input_closed" },
    );
    assert.equal(f.backend.facts().rootExited, false);
    const receipt = await within(
      f.backend.stop({ graceMs: 10, forceMs: 4000 }),
      5000,
    );
    assert.equal(receipt.confirmed, true);
    await within(f.backend.closed);
    assert.equal(f.backend.facts().treeStopped, true);
    assert.equal(f.backend.facts().closed, true);
  },
);
