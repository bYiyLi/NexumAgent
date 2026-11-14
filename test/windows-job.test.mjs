import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  WindowsJob,
  captureChildProcessBirthIdentity,
  getCurrentProcessBirthIdentity,
} from "../dist/process/windows-job.js";

const windows = process.platform === "win32";
const moduleUrl = new URL("../dist/process/windows-job.js", import.meta.url)
  .href;
const fixtureSource = `
import { spawn } from 'node:child_process';
import { getCurrentProcessBirthIdentity } from ${JSON.stringify(moduleUrl)};
setTimeout(() => process.exit(91), 15000).unref();
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (message === 'descendant') {
    const descendant = spawn(process.execPath, ['-e',
      'process.stdout.write("descendant-ready\\n"); setTimeout(() => process.exit(0), 14000);'
    ], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    descendant.on('error', () => process.exit(92));
    descendant.on('spawn', () => process.send({ type: 'descendant-started' }));
  }
});
process.send({ type: 'ready', birth: getCurrentProcessBirthIdentity() });
`;

function message(child, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error(`Timed out: ${type}`)),
      8000,
    );
    const onMessage = (value) => {
      if (value?.type === type) finish(undefined, value);
    };
    const onExit = () => finish(new Error(`Fixture exited before ${type}`));
    const onError = (error) => finish(error);
    function finish(error, value) {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function fixture(t, source = fixtureSource) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    env,
  });
  const closed = once(child, "close");
  // Keep an early rejection observed, including spawn errors in failing tests.
  void closed.catch(() => {});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([closed, delay(8000)]);
  });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

async function eventually(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(
    "The Windows Job Object did not reach the expected actual state.",
  );
}

test(
  "non-Windows entry points are explicitly unsupported without loading Koffi",
  {
    skip: windows,
  },
  () => {
    const require = createRequire(import.meta.url);
    const loaded = () =>
      Object.keys(require.cache).filter((file) => /[/\\]koffi[/\\]/.test(file));
    const before = loaded();
    const unsupported = (error) => error.code === "windows_job_unsupported";
    assert.throws(() => WindowsJob.create(), unsupported);
    assert.throws(() => getCurrentProcessBirthIdentity(), unsupported);
    assert.throws(
      () => captureChildProcessBirthIdentity(new ChildProcess()),
      unsupported,
    );
    assert.deepEqual(loaded(), before);
  },
);

test(
  "Windows Job identity is precise and birth mismatch never assigns a child",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const own = getCurrentProcessBirthIdentity();
    assert.match(own, /^[1-9][0-9]{0,19}$/);
    assert.ok(BigInt(own) > BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(getCurrentProcessBirthIdentity(), own);
    const job = WindowsJob.create();
    t.after(() => job.close());
    const process = fixture(t);
    const ready = await message(process.child, "ready");
    assert.deepEqual(Object.keys(job), []);
    assert.equal(job.closed, false);
    assert.equal(job.queryAccounting().activeProcesses, 0);
    assert.equal(captureChildProcessBirthIdentity(process.child), ready.birth);
    assert.throws(() => job.assignChild(process.child, Number(ready.birth)), {
      code: "windows_job_invalid_birth_identity",
    });
    assert.throws(
      () =>
        job.assignChild(process.child, (BigInt(ready.birth) + 1n).toString()),
      {
        code: "windows_job_birth_mismatch",
      },
    );
    assert.equal(job.queryAccounting().activeProcesses, 0);
    job.assignChild(process.child, ready.birth);
    assert.equal(job.queryAccounting().activeProcesses, 1);
    assert.throws(() => job.terminate(-1), {
      code: "windows_job_invalid_exit_code",
    });
    job.terminate(37);
    const [exitCode] = await process.closed;
    assert.equal(exitCode, 37, process.stderr());
    await eventually(() => job.queryAccounting().activeProcesses === 0);
    const accounting = job.queryAccounting();
    assert.equal(accounting.totalProcesses, 1);
    assert.equal(typeof accounting.totalUserTime100ns, "string");
    assert.ok(Object.isFrozen(accounting));
    assert.equal(job.close(), true);
    assert.equal(job.close(), false);
    assert.equal(job.closed, true);
    assert.throws(() => job.queryAccounting(), { code: "windows_job_closed" });
    assert.throws(() => job.terminate(), { code: "windows_job_closed" });
    assert.throws(() => job.assignChild(process.child, ready.birth), {
      code: "windows_job_closed",
    });
  },
);

test(
  "Windows Job never accepts a PID or current test process as a child",
  {
    skip: !windows,
  },
  (t) => {
    const job = WindowsJob.create();
    t.after(() => job.close());
    const ownBirth = getCurrentProcessBirthIdentity();
    assert.throws(() => job.assignChild(process.pid, ownBirth), {
      code: "windows_job_invalid_child",
    });
    const unspawned = new ChildProcess();
    unspawned.pid = process.pid;
    assert.throws(() => job.assignChild(unspawned, ownBirth), {
      code: "windows_job_invalid_child",
    });
    assert.equal(job.queryAccounting().totalProcesses, 0);
  },
);

test(
  "Windows Job and temporary child handles are actually released",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const job = WindowsJob.create();
    t.after(() => job.close());
    const process = fixture(t);
    const ready = await message(process.child, "ready");
    job.assignChild(process.child, ready.birth);
    const require = createRequire(import.meta.url);
    const koffi = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const currentProcess = kernel32.func(
      "void * __stdcall GetCurrentProcess()",
    );
    const countHandles = kernel32.func(
      "int32_t __stdcall GetProcessHandleCount(void *process, void *count)",
    );
    const ownHandle = currentProcess();
    const count = () => {
      const data = Buffer.alloc(4);
      assert.notEqual(countHandles(ownHandle, data), 0);
      return data.readUInt32LE();
    };
    const before = count();
    for (let i = 0; i < 64; i++) {
      const temporary = WindowsJob.create();
      assert.equal(
        captureChildProcessBirthIdentity(process.child),
        ready.birth,
      );
      assert.equal(temporary.close(), true);
      assert.equal(temporary.close(), false);
    }
    assert.equal(count(), before);
    job.terminate();
    await process.closed;
    await eventually(() => job.queryAccounting().activeProcesses === 0);
  },
);

test(
  "Windows Job terminates its newly spawned helper and managed descendants",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const job = WindowsJob.create();
    t.after(() => job.close());
    const process = fixture(t);
    const ready = await message(process.child, "ready");
    job.assignChild(process.child, ready.birth);
    // No business child is allowed to start until assignment has succeeded.
    const started = message(process.child, "descendant-started");
    process.child.send("descendant");
    await started;
    await eventually(() => job.queryAccounting().activeProcesses >= 2);
    await eventually(() => process.stdout().includes("descendant-ready"));
    job.terminate(43);
    const [exitCode] = await process.closed;
    assert.equal(exitCode, 43, process.stderr());
    // 'close' includes inherited stdout/stderr closure, not only helper exit.
    assert.equal(process.child.stdout.readableEnded, true);
    assert.equal(process.child.stderr.readableEnded, true);
    await eventually(() => job.queryAccounting().activeProcesses === 0);
    assert.ok(job.queryAccounting().totalProcesses >= 2);
  },
);

test(
  "closing the last noninheritable Windows Job handle kills the owned tree",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const job = WindowsJob.create();
    t.after(() => job.close());
    const process = fixture(t);
    const ready = await message(process.child, "ready");
    job.assignChild(process.child, ready.birth);
    const started = message(process.child, "descendant-started");
    process.child.send("descendant");
    await started;
    await eventually(() => job.queryAccounting().activeProcesses >= 2);
    assert.equal(job.close(), true);
    await process.closed;
    assert.equal(process.child.stdout.readableEnded, true);
    assert.equal(process.child.stderr.readableEnded, true);
    assert.equal(job.close(), false);
  },
);

test(
  "owner exit closes its Windows Job handle without inherited handle escape",
  {
    skip: !windows,
    timeout: 15000,
  },
  async (t) => {
    const ownerSource = `
import { spawn } from 'node:child_process';
import { WindowsJob } from ${JSON.stringify(moduleUrl)};
setTimeout(() => process.exit(93), 12000).unref();
const job = WindowsJob.create();
const helper = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(fixtureSource)}], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true
});
helper.on('error', () => process.exit(94));
helper.on('message', message => {
  if (message.type === 'ready') {
    job.assignChild(helper, message.birth);
    helper.send('descendant');
  } else if (message.type === 'descendant-started') {
    process.send({ type: 'owner-ready' });
  }
});
process.on('message', message => {
  if (message === 'owner-exit') process.exit(0);
});
process.on('disconnect', () => process.exit(0));
`;
    const owner = fixture(t, ownerSource);
    await message(owner.child, "owner-ready");
    await eventually(() => owner.stdout().includes("descendant-ready"));
    owner.child.send("owner-exit");
    const [exitCode] = await owner.closed;
    assert.equal(exitCode, 0, owner.stderr());
    assert.equal(owner.child.stdout.readableEnded, true);
    assert.equal(owner.child.stderr.readableEnded, true);
  },
);
