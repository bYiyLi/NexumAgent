import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { readWindowsUserEnvironment } from "../dist/process/environment-windows.js";

const windows = process.platform === "win32";
const require = createRequire(import.meta.url);
const options = (signal = new AbortController().signal) => ({
  signal,
  timeoutMs: 10000,
  maxBytes: 4 * 1024 * 1024,
});
const loadedKoffi = () =>
  Object.keys(require.cache).filter((file) => /[/\\]koffi[/\\]/.test(file));

function valueFor(map, name) {
  const key = Object.keys(map).find(
    (key) => key.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : map[key];
}

function ownHandleCount() {
  const koffi = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const currentProcess = kernel32.func("void * __stdcall GetCurrentProcess()");
  const countHandles = kernel32.func(
    "int32_t __stdcall GetProcessHandleCount(void *process, void *count)",
  );
  const handle = currentProcess(); // Read-only pseudo-handle; never closed.
  return () => {
    const bytes = Buffer.alloc(4);
    assert.notEqual(
      countHandles(handle, bytes),
      0,
      "Reading own handle accounting failed.",
    );
    return bytes.readUInt32LE();
  };
}

test(
  "Windows user environment is unsupported elsewhere without loading native bindings",
  {
    skip: windows,
  },
  async () => {
    const before = loadedKoffi();
    await assert.rejects(readWindowsUserEnvironment(options()), {
      code: "windows_environment_unsupported",
    });
    assert.deepEqual(loadedKoffi(), before);
  },
);

test("an already aborted Windows environment request preserves its reason without loading bindings", async () => {
  const before = loadedKoffi();
  const controller = new AbortController();
  const reason = new Error("synthetic-pre-aborted-environment-request");
  controller.abort(reason);
  await assert.rejects(
    readWindowsUserEnvironment(options(controller.signal)),
    (error) => error === reason,
  );
  assert.deepEqual(loadedKoffi(), before);
});

test(
  "Windows Userenv returns a frozen nonempty fresh map with unique case-insensitive names",
  {
    skip: !windows,
    timeout: 20000,
  },
  async () => {
    const map = await readWindowsUserEnvironment(options());
    assert.equal(typeof map, "object");
    assert.ok(map !== null);
    assert.ok(Object.isFrozen(map), "Raw Userenv data must be immutable.");
    const keys = Object.keys(map);
    assert.ok(
      keys.length > 0,
      "The current Windows user environment must not be empty.",
    );
    assert.equal(
      new Set(keys.map((key) => key.toUpperCase())).size,
      keys.length,
      "Environment names must be unique without regard to case.",
    );
    for (const key of keys) {
      // Use fixed diagnostics so an assertion never dumps credential values.
      assert.ok(
        key.length > 0 && !key.includes("\0"),
        "An environment name is malformed.",
      );
      assert.equal(
        typeof map[key],
        "string",
        "An environment value must be text.",
      );
      assert.ok(
        !map[key].includes("\0"),
        "An environment value contains a block terminator.",
      );
    }
  },
);

test(
  "Windows FALSE-inherit Userenv ignores daemon-only markers and Node startup overrides",
  {
    skip: !windows,
    timeout: 20000,
  },
  async () => {
    const token = randomUUID().replaceAll("-", "");
    const markerName = `NEXUM_DAEMON_TEST_${token}`;
    const secretName = `NEXUM_SECRET_TEST_${token}`;
    const ordinaryName = `DAEMON_ONLY_TEST_${token}`;
    const synthetic = `synthetic-daemon-value-${token}`;
    const changes = {
      [markerName]: synthetic,
      [secretName]: synthetic,
      [ordinaryName]: synthetic,
      NODE_OPTIONS: `--title=nexum-environment-test-${token}`,
      NODE_PATH: `C:\\nexum-environment-test-${token}`,
    };
    const previous = new Map(
      Object.keys(changes).map((key) => [key, process.env[key]]),
    );
    let map;
    try {
      for (const [key, value] of Object.entries(changes))
        process.env[key] = value;
      map = await readWindowsUserEnvironment(options());
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const key of [markerName, secretName, ordinaryName])
      assert.ok(
        valueFor(map, key) === undefined,
        "A random daemon-only name was inherited by the user environment.",
      );
    // A genuine user-registry NODE_OPTIONS/NODE_PATH is permitted. Only this
    // request's unique daemon values must be absent; do not print real values.
    assert.ok(
      valueFor(map, "NODE_OPTIONS") !== changes.NODE_OPTIONS,
      "Daemon NODE_OPTIONS was inherited.",
    );
    assert.ok(
      valueFor(map, "NODE_PATH") !== changes.NODE_PATH,
      "Daemon NODE_PATH was inherited.",
    );
  },
);

test(
  "Windows user environment Promise completion permits queued microtask scheduling",
  {
    skip: !windows,
    timeout: 20000,
  },
  async () => {
    let scheduled = false;
    const pending = readWindowsUserEnvironment(options());
    queueMicrotask(() => {
      scheduled = true;
    });
    await pending;
    assert.equal(scheduled, true);
  },
);

test(
  "Windows user environment rejects a one-byte output budget",
  {
    skip: !windows,
    timeout: 20000,
  },
  async () => {
    await assert.rejects(
      readWindowsUserEnvironment({ ...options(), maxBytes: 1 }),
      {
        code: "environment_too_large",
      },
    );
  },
);

test(
  "Windows native user-environment success, abort and deadline paths release their handles",
  {
    skip: !windows,
    timeout: 30000,
  },
  async () => {
    // Warm up Koffi/libuv's real worker pool before measuring request ownership.
    await readWindowsUserEnvironment(options());
    await readWindowsUserEnvironment(options());
    const count = ownHandleCount();
    const before = count();
    for (let i = 0; i < 8; i++) await readWindowsUserEnvironment(options());
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        readWindowsUserEnvironment({ ...options(), maxBytes: 1 }),
        {
          code: "environment_too_large",
        },
      );
    }
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      const reason = new Error("synthetic-inflight-environment-abort");
      const pending = readWindowsUserEnvironment(options(controller.signal));
      controller.abort(reason);
      // Await the real API promise. No race substitutes cancellation for native
      // completion or permits a still-running call to lose its token/block owner.
      await assert.rejects(pending, (error) => error === reason);
    }
    for (let i = 0; i < 4; i++) {
      const pending = readWindowsUserEnvironment({
        ...options(),
        timeoutMs: 1,
      });
      // Hold this JS turn beyond the deadline while the real native worker can
      // finish. The callback must enforce the elapsed deadline after completion.
      const until = performance.now() + 10;
      while (performance.now() < until) {
        /* Deliberately occupy this short turn. */
      }
      await assert.rejects(pending, { code: "environment_probe_timeout" });
    }
    assert.ok(
      count() <= before,
      "Native user-environment requests increased the open handle count.",
    );
  },
);
